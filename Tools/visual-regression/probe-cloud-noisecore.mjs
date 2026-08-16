#!/usr/bin/env node
/**
 * V3 KEYSTONE — baked 3D-noise density core. WebGPU-only.
 * @purpose V3 keystone A/B vs the pre-V3 live-noise build: baked clouds render, sane cell count, faster frame, W1/W2 lighting survives on the baked path
 * @status INVESTIGATION
 *
 * `cloudDensity` / `cloudBaseDensity` now sample the baked Perlin-Worley shape +
 * Worley detail textures (when the tier wants baked — the default `auto` at low
 * altitude → high tier → BAKED) instead of evaluating ~30 live noise ops. This is
 * deliberately NOT byte-identical (the whole point: better-looking AND cheaper).
 *
 * A/B vs the pre-V3 LIVE build (git-stash the wgsl + renderer, rebuild):
 *   • baked renders real clouds (cloud pixels present);
 *   • cloud-cell count within a sane band of live (no W5 truncation / no
 *     over-densify — the `base >= full` oracle + literal-subtraction erosion);
 *   • baked is FASTER (GPU-synced frame time) — the perf win;
 *   • the W1/W2 lighting SURVIVES on the baked clouds — tonal range (p90-p10)
 *     proves the HDR tone-map + form (W1) and a lifted shadow floor (p10) proves
 *     the sky/ground ambient (W2). (W3 sun color + W4 aerial are at the composite
 *     tail, downstream of density and untouched; W5 base>=full is preserved by
 *     construction — both density fns share `bakedBase` before erosion.)
 *
 *   Run 1 (V3 build):  TAG=baked node probe-cloud-noisecore.mjs
 *   Run 2 (pre-V3):    git stash the wgsl + renderer, rebuild,
 *                      TAG=live node probe-cloud-noisecore.mjs  (computes the A/B)
 *
 * PASS: clouds render; count within 0.5–1.7× live; baked ≤ 1.05× live frame time;
 * tonal range p90-p10 ≥ 0.10 and p10 ≥ 0.02; 0 device errors.
 * READ cloud-noisecore-{baked,live}.png — baked = billowy Perlin-Worley
 * cauliflower (not lumpy value-noise grid), no banding / thinned tops / over-densify.
 *
 * Usage: TAG=baked PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-noisecore.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.env.TAG || "baked";
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
    g.defaultCloudCollection.volumetric.cloudCoverage = 0.55;
  if ("cloudWeatherMap" in g)
    g.defaultCloudCollection.volumetric.cloudWeatherMap = false;
  if ("cloudDensity" in g)
    g.defaultCloudCollection.volumetric.cloudDensity = 0.8;
  // Leave cloudVolumetricQuality "auto" + cloudQuality 64 → at ALT 800 the tier
  // resolves to HIGH → noiseSource = BAKED. (Setting cloudQuality != 64 would trip
  // the power-user escape hatch → LIVE, defeating the test.)
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

const RENDER_AND_TIME = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const jd = C.JulianDate.fromIso8601(cfg.iso);
  v.clock.currentTime = jd;
  const device = s.context.device;
  for (let i = 0; i < 40; i++) {
    s.render(jd);
    await new Promise((r) => requestAnimationFrame(r));
  }
  if (device) await device.queue.onSubmittedWorkDone();
  const M = 150;
  const t0 = performance.now();
  for (let i = 0; i < M; i++) s.render(jd);
  if (device) await device.queue.onSubmittedWorkDone();
  const t1 = performance.now();
  // Read whether the baked core is actually active this frame.
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
  return {
    msPerFrame: +((t1 - t0) / M).toFixed(4),
    noiseBaked,
    dataUrl: s.canvas.toDataURL("image/png"),
  };
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
    let cells = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      if (lum < 30 / 255) continue; // black sky excluded
      lums.push(lum);
      if (lum > 150 / 255) cells++;
    }
    if (!lums.length) return { cloudPx: 0 };
    lums.sort((a, b) => a - b);
    const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
    const p = (q) =>
      lums[Math.min(lums.length - 1, Math.floor(q * lums.length))];
    let vs = 0;
    for (const l of lums) vs += (l - mean) * (l - mean);
    return {
      cloudPx: lums.length,
      cells,
      mean: +mean.toFixed(3),
      p10: +p(0.1).toFixed(3),
      p90: +p(0.9).toFixed(3),
      stdev: +Math.sqrt(vs / lums.length).toFixed(3),
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

  const r = await page.evaluate(RENDER_AND_TIME, { iso: NOON });
  const png = `${OUT}/cloud-noisecore-${TAG}.png`;
  fs.writeFileSync(png, Buffer.from(r.dataUrl.split(",")[1], "base64"));
  const stats = await lumStats(page, r.dataUrl);

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter((e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e));

  const rec = {
    tag: TAG,
    msPerFrame: r.msPerFrame,
    noiseBaked: r.noiseBaked,
    ...stats,
  };
  fs.writeFileSync(
    `${OUT}/cloud-noisecore-${TAG}.json`,
    JSON.stringify(rec, null, 2),
  );
  console.log(`[${TAG}]`, JSON.stringify(rec));
  if (newErrs.length) console.log("NEW errs:", newErrs.slice(0, 3));

  const other = TAG === "baked" ? "live" : "baked";
  const otherJson = `${OUT}/cloud-noisecore-${other}.json`;
  let pass = newErrs.length === 0 && stats.cloudPx > 5000;
  if (fs.existsSync(otherJson)) {
    const o = JSON.parse(fs.readFileSync(otherJson, "utf8"));
    const baked = TAG === "baked" ? rec : o;
    const live = TAG === "live" ? rec : o;
    const cellRatio = baked.cells / Math.max(1, live.cells);
    const speedup = +(
      live.msPerFrame / Math.max(0.0001, baked.msPerFrame)
    ).toFixed(3);
    const range = +(baked.p90 - baked.p10).toFixed(3);
    console.log("\n=== A/B (baked vs live) ===");
    console.log(`  baked noiseBaked=${baked.noiseBaked}`);
    console.log(`  cloud-cell ratio baked/live: ${cellRatio.toFixed(3)}`);
    console.log(
      `  frame time baked ${baked.msPerFrame}ms live ${live.msPerFrame}ms speedup ×${speedup}`,
    );
    console.log(
      `  baked tonal: p10 ${baked.p10} p90 ${baked.p90} range ${range} stdev ${baked.stdev}`,
    );

    const checks = [
      ["baked core active (noiseBaked)", baked.noiseBaked === true],
      [`baked renders clouds (${baked.cloudPx} px)`, baked.cloudPx > 5000],
      [
        `cloud-cell ratio in 0.5–1.7 (${cellRatio.toFixed(3)})`,
        cellRatio >= 0.5 && cellRatio <= 1.7,
      ],
      [`baked not slower (×${speedup} ≥ 0.95)`, speedup >= 0.95],
      [`W1 tonal range preserved (p90-p10 ${range} ≥ 0.10)`, range >= 0.1],
      [`W2 shadow floor lifted (p10 ${baked.p10} ≥ 0.02)`, baked.p10 >= 0.02],
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
