#!/usr/bin/env node
/**
 * W5 — Adaptive coarse→fine raymarch (empty-space skipping). WebGPU-only.
 *
 * Verifies the adaptive march (a) preserves the image vs the old fixed-step
 * march and (b) is cheaper (skips empty space). Because the lighting/composite
 * math is byte-identical and only the stepping cadence changed, the rigorous
 * test is a TRUE A/B against the pre-W5 build:
 *
 *   Run 1 (W5 build present):        TAG=adaptive node probe-cloud-perf.mjs
 *   Run 2 (fixed-march build, via
 *          `git stash` of the WGSL): TAG=fixed    node probe-cloud-perf.mjs
 *
 * Each run captures the cloud image + a GPU-synced frame time under its tag.
 * When BOTH tags exist, the second run computes:
 *   • image mismatch (mean-abs luminance) — must be ≤ ~2% (equal quality), and
 *     cloud-cell (lum>150) count within ±6% (no thinned tops / lost silhouette).
 *   • frame-time delta — adaptive should be FASTER (empty-space skip pays off).
 *
 * Scene mirrors the lighting probes: clouds on, moderate coverage with lots of
 * empty space along rays, high step budget (so the march dominates frame cost),
 * black sky, sun/atmosphere off, fixed sun via manual render(jd).
 *
 * Usage:
 *   TAG=adaptive PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-perf.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.env.TAG || "adaptive";
const W = 1024,
  H = 768;
const LON = -95.0,
  LAT = 39.0,
  ALT = 800.0; // below the layer, looking up through sparse clouds (real empty
//             space along rays for the skip to exploit — not the cloud-saturated
//             inside-layer grazing view, which has nothing to skip)
const NOON = "2026-06-21T18:20:00Z";
const OUT = "Tools/visual-regression/output";

const SETUP = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const g = s.globe;
  v.useDefaultRenderLoop = false;
  s.requestRenderMode = false;
  g.showProceduralClouds = true;
  if ("cloudCoverage" in g) g.cloudCoverage = 0.35; // sparse → ~65% empty along rays
  if ("cloudWeatherMap" in g) g.cloudWeatherMap = false;
  if ("cloudDensity" in g) g.cloudDensity = 0.7;
  if ("cloudQuality" in g) g.cloudQuality = 128; // non-default → used verbatim (high budget)
  s.skyBox.show = false;
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  s.backgroundColor = C.Color.BLACK;
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT),
    orientation: {
      heading: C.Math.toRadians(90.0),
      pitch: C.Math.toRadians(25.0), // look up through the layer (crosses puffs + gaps)
      roll: 0.0,
    },
  });
  return { ok: true };
};

const RENDER_AND_TIME = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const jd = C.JulianDate.fromIso8601(cfg.iso);
  v.clock.currentTime = jd;
  const device = s.context.device;
  // Warm up (compile pipelines, settle clouds).
  for (let i = 0; i < 40; i++) {
    s.render(jd);
    await new Promise((r) => requestAnimationFrame(r));
  }
  if (device) await device.queue.onSubmittedWorkDone();

  // Time M frames back-to-back, then sync on GPU completion.
  const M = 150;
  const t0 = performance.now();
  for (let i = 0; i < M; i++) {
    s.render(jd);
  }
  if (device) await device.queue.onSubmittedWorkDone();
  const t1 = performance.now();

  return {
    msPerFrame: +((t1 - t0) / M).toFixed(4),
    hasDevice: !!device,
    dataUrl: s.canvas.toDataURL("image/png"),
  };
};

async function lumStats(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0,
      cells = 0,
      n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      sum += lum;
      if (lum > 150) cells++;
    }
    return { meanLum: +(sum / n).toFixed(3), cloudCells: cells };
  }, dataUrl);
}

// Mean-abs luminance mismatch between two same-size PNGs.
async function imageMismatch(page, duA, duB) {
  return page.evaluate(
    async ([a, b]) => {
      const load = async (u) => {
        const img = new Image();
        img.src = u;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        return cx.getImageData(0, 0, c.width, c.height).data;
      };
      const da = await load(a);
      const db = await load(b);
      let acc = 0;
      const n = da.length / 4;
      for (let i = 0; i < da.length; i += 4) {
        const la = 0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2];
        const lb = 0.299 * db[i] + 0.587 * db[i + 1] + 0.114 * db[i + 2];
        acc += Math.abs(la - lb);
      }
      return +(acc / n).toFixed(3); // 0..255
    },
    [duA, duB],
  );
}

async function run() {
  const fs = await import("fs");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  await armWebGPUDevices(page);
  await page.evaluate(SETUP, { LON, LAT, ALT });

  const r = await page.evaluate(RENDER_AND_TIME, { iso: NOON });
  const png = `${OUT}/cloud-perf-${TAG}.png`;
  fs.writeFileSync(png, Buffer.from(r.dataUrl.split(",")[1], "base64"));
  const stats = await lumStats(page, r.dataUrl);

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || []).filter(
    (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e),
  );

  const rec = { tag: TAG, msPerFrame: r.msPerFrame, hasDevice: r.hasDevice, ...stats };
  fs.writeFileSync(`${OUT}/cloud-perf-${TAG}.json`, JSON.stringify(rec, null, 2));
  console.log(`[${TAG}]`, JSON.stringify(rec));
  if (newErrs.length) console.log("NEW errs:", newErrs.slice(0, 2));

  // If the OTHER tag exists, compare.
  const other = TAG === "adaptive" ? "fixed" : "adaptive";
  const otherJson = `${OUT}/cloud-perf-${other}.json`;
  let pass = newErrs.length === 0 && stats.cloudCells > 3000;
  if (fs.existsSync(otherJson)) {
    const o = JSON.parse(fs.readFileSync(otherJson, "utf8"));
    const otherDu =
      "data:image/png;base64," +
      fs.readFileSync(`${OUT}/cloud-perf-${other}.png`).toString("base64");
    const mismatch = await imageMismatch(page, r.dataUrl, otherDu);
    const cellRatio = stats.cloudCells / Math.max(1, o.cloudCells);
    const adaptive = TAG === "adaptive" ? rec : o;
    const fixed = TAG === "fixed" ? rec : o;
    const speedup = +(fixed.msPerFrame / Math.max(0.0001, adaptive.msPerFrame)).toFixed(3);

    console.log("\n=== A/B (adaptive vs fixed) ===");
    console.log(`  image mean-abs luma mismatch: ${mismatch}/255 (${(mismatch / 255 * 100).toFixed(2)}%)`);
    console.log(`  cloud-cell ratio ${TAG}/${other}: ${cellRatio.toFixed(3)}`);
    console.log(`  frame time  adaptive ${adaptive.msPerFrame}ms  fixed ${fixed.msPerFrame}ms  speedup ×${speedup}`);

    const checks = [
      [`image preserved (mismatch ${mismatch} ≤ 5.1/255 ≈2%)`, mismatch <= 5.1],
      [`cloud silhouette preserved (cell ratio ${cellRatio.toFixed(3)} in 0.94-1.06)`, cellRatio >= 0.94 && cellRatio <= 1.06],
      [`adaptive faster than fixed (speedup ×${speedup} > 1.05)`, speedup > 1.05],
      ["no NEW device errors (this run)", newErrs.length === 0],
    ];
    console.log("\n=== ANALYSIS ===");
    pass = true;
    for (const [n, ok] of checks) {
      console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
      if (!ok) pass = false;
    }
    console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  } else {
    console.log(`(no ${other} capture yet — run the other build to compare)`);
  }

  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
run();
