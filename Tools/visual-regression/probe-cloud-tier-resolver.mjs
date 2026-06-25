#!/usr/bin/env node
/**
 * V1 — tier-preset scaffold byte-identity guard. WebGPU-only.
 *
 * V1 adds the `CloudTierPreset` module + the `qualityFlags`@74 uniform lane, but
 * NO shader reads `qualityFlags` yet and `maxSteps`/`lightSteps` stay on the
 * legacy resolver — so every cloud frame must render BYTE-IDENTICALLY to pre-V1.
 * This A/B also catches a packer lane-shift (if `qualityFlags` displaced a later
 * lane, the diff would be large, not zero).
 *
 *   Run 1 (V1 build):   TAG=after  node probe-cloud-tier-resolver.mjs
 *   Run 2 (pre-V1):     git stash the renderer.ts + .wgsl, rebuild,
 *                       TAG=before node probe-cloud-tier-resolver.mjs   (computes the diff)
 *
 * PASS: mean-abs luma mismatch over cloud pixels ≤ 0.5/255 (byte-identical);
 * 0 device errors. READ cloud-tier-after.png — clouds render normally.
 *
 * Usage: TAG=after PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-tier-resolver.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.env.TAG || "after";
const W = 1024,
  H = 768;
const LON = -95.0,
  LAT = 39.0,
  ALT = 800.0;
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
  if ("cloudCoverage" in g) g.cloudCoverage = 0.55;
  if ("cloudWeatherMap" in g) g.cloudWeatherMap = false;
  if ("cloudDensity" in g) g.cloudDensity = 0.8;
  s.skyBox.show = false;
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  s.backgroundColor = C.Color.BLACK;
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT),
    orientation: {
      heading: C.Math.toRadians(90.0),
      pitch: C.Math.toRadians(16.0),
      roll: 0.0,
    },
  });
  return { ok: true };
};

const RENDER = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const jd = C.JulianDate.fromIso8601(cfg.iso);
  v.clock.currentTime = jd;
  for (let i = 0; i < 90; i++) {
    s.render(jd);
    await new Promise((r) => requestAnimationFrame(r));
  }
  return s.canvas.toDataURL("image/png");
};

async function imageMismatchCloud(page, duA, duB) {
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
      let acc = 0,
        n = 0,
        maxd = 0;
      for (let i = 0; i < da.length; i += 4) {
        const la = 0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2];
        const lb = 0.299 * db[i] + 0.587 * db[i + 1] + 0.114 * db[i + 2];
        // cloud pixels = bright in either frame (black sky excluded)
        if (Math.max(la, lb) < 30) continue;
        const d = Math.abs(la - lb);
        acc += d;
        if (d > maxd) maxd = d;
        n++;
      }
      return {
        meanAbs: n ? +(acc / n).toFixed(4) : 0,
        maxAbs: +maxd.toFixed(2),
        cloudPx: n,
      };
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
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  await armWebGPUDevices(page);
  await page.evaluate(SETUP, { LON, LAT, ALT });

  const dataUrl = await page.evaluate(RENDER, { iso: NOON });
  const png = `${OUT}/cloud-tier-${TAG}.png`;
  fs.writeFileSync(png, Buffer.from(dataUrl.split(",")[1], "base64"));

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter((e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e));

  const other = TAG === "after" ? "before" : "after";
  const otherPng = `${OUT}/cloud-tier-${other}.png`;
  let pass = newErrs.length === 0;
  console.log(`[${TAG}] captured. device errors: ${newErrs.length}`);

  if (fs.existsSync(otherPng)) {
    const otherDu =
      "data:image/png;base64," + fs.readFileSync(otherPng).toString("base64");
    const m = await imageMismatchCloud(page, dataUrl, otherDu);
    console.log("A/B (after vs before):", JSON.stringify(m));
    const checks = [
      [`byte-identical: mean-abs luma ${m.meanAbs} ≤ 0.5/255`, m.meanAbs <= 0.5],
      [`max-abs luma ${m.maxAbs} ≤ 2/255`, m.maxAbs <= 2],
      [`cloud pixels present (${m.cloudPx})`, m.cloudPx > 5000],
      ["no NEW device errors", newErrs.length === 0],
    ];
    pass = true;
    console.log("\n=== ANALYSIS ===");
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
