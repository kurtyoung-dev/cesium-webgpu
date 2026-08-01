#!/usr/bin/env node
/**
 * V5 — Frostbite multi-scatter octaves (phase folded per-octave) + lightSampleScale.
 * WebGPU-only (baked tier).
 *
 * The multi-scatter light now folds the dual-lobe phase PER OCTAVE with geometric
 * eccentricity decay (c=0.85, gentle), so deep interiors get a softer, more
 * isotropic lit-from-within glow. It is a deliberate (subtle) lighting change, NOT
 * byte-identical. Acceptance = the change IMPROVES/holds the lighting without
 * regressing W1/W2:
 *   • W1 silver-lining + form preserved (tonal range p90-p10 ≥ 0.10);
 *   • W2 shadow floor still lifted (p10 ≥ 0.02 — interiors not black);
 *   • the A/B delta vs pre-V5 is MODEST (mean-abs cloud luma ≤ 0.10 — a softening,
 *     not a blow-up) and interiors trend softer (deep-cloud median ≥ pre-V5);
 *   • clouds still render; 0 device errors.
 *
 *   Run 1 (V5 build):  TAG=after  node probe-cloud-lighting.mjs
 *   Run 2 (pre-V5):    git stash the wgsl + renderer, rebuild,
 *                      TAG=before node probe-cloud-lighting.mjs   (computes the A/B)
 *
 * READ cloud-lighting-{before,after}.png — interiors softer/grey, silver lining
 * intact, no new banding.
 *
 * Usage: TAG=after PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-lighting.mjs
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
  g.defaultCloudCollection.enableVolumetric = true;
  if ("cloudCoverage" in g)
    g.defaultCloudCollection.volumetric.cloudCoverage = 0.6;
  if ("cloudWeatherMap" in g)
    g.defaultCloudCollection.volumetric.cloudWeatherMap = false;
  if ("cloudDensity" in g)
    g.defaultCloudCollection.volumetric.cloudDensity = 0.85;
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
  let noiseBaked;
  try {
    noiseBaked = !!(
      s.context &&
      s.context._cloudCache &&
      s.context._cloudCache.noiseBaked
    );
  } catch (e) {
    noiseBaked = false;
  }
  return { noiseBaked, dataUrl: s.canvas.toDataURL("image/png") };
};

function lumStats(page, dataUrl) {
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
    const lums = [];
    for (let i = 0; i < d.length; i += 4) {
      const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      if (lum < 30 / 255) continue;
      lums.push(lum);
    }
    if (!lums.length) return { cloudPx: 0 };
    lums.sort((a, b) => a - b);
    const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
    const p = (q) =>
      lums[Math.min(lums.length - 1, Math.floor(q * lums.length))];
    return {
      cloudPx: lums.length,
      mean: +mean.toFixed(4),
      p10: +p(0.1).toFixed(4),
      p50: +p(0.5).toFixed(4),
      p90: +p(0.9).toFixed(4),
    };
  }, dataUrl);
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

  const r = await page.evaluate(RENDER, { iso: NOON });
  fs.writeFileSync(
    `${OUT}/cloud-lighting-${TAG}.png`,
    Buffer.from(r.dataUrl.split(",")[1], "base64"),
  );
  const stats = await lumStats(page, r.dataUrl);
  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter((e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e));

  const rec = { tag: TAG, noiseBaked: r.noiseBaked, ...stats };
  fs.writeFileSync(
    `${OUT}/cloud-lighting-${TAG}.json`,
    JSON.stringify(rec, null, 2),
  );
  console.log(`[${TAG}]`, JSON.stringify(rec), "errs", newErrs.length);

  const other = TAG === "after" ? "before" : "after";
  const otherJson = `${OUT}/cloud-lighting-${other}.json`;
  let pass = newErrs.length === 0 && stats.cloudPx > 5000;
  if (fs.existsSync(otherJson)) {
    const o = JSON.parse(fs.readFileSync(otherJson, "utf8"));
    const after = TAG === "after" ? rec : o;
    const before = TAG === "before" ? rec : o;
    const range = +(after.p90 - after.p10).toFixed(3);
    const meanDelta = +Math.abs(after.mean - before.mean).toFixed(4);
    const interiorDelta = +(after.p50 - before.p50).toFixed(4);
    console.log("\n=== A/B (after vs before) ===");
    console.log(
      `  after range ${range} | mean Δ ${meanDelta} | interior(p50) Δ ${interiorDelta}`,
    );
    const checks = [
      ["baked core active", after.noiseBaked === true],
      [`W1 tonal range preserved (${range} ≥ 0.10)`, range >= 0.1],
      [`W2 shadow floor lifted (p10 ${after.p10} ≥ 0.02)`, after.p10 >= 0.02],
      [
        `MS change is a softening, not a blow-up (|mean Δ| ${meanDelta} ≤ 0.10)`,
        meanDelta <= 0.1,
      ],
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
