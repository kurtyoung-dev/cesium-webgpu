#!/usr/bin/env node
// probe-skybox-star-modulation.mjs — C11-176 SKYBOX STAR-MAP FADE (WebGPU vs WebGL)
//
// ROOT CAUSE UNDER TEST (2026-07-19 celestial research):
//   AtmosphericConditions.js:368 ships `enableStarBrightnessModulation: true`,
//   while WebGPUCubeMapPanoramaRenderer.js:539-548 documents the flag as
//   "Default OFF for WebGL parity" and gates on `=== true` as a fail-safe
//   against an ABSENT property. Shipping it present-and-true defeats that.
//   The shader then multiplies star colour by
//       factor = 1 - smoothstep(0, 1, clamp((skyBrightness - inflection) * steepness, 0, 1))
//   with inflection=0.5, steepness=1.0 -> at skyBrightness=1.0, factor = 0.5
//   (a 50% dim). WebGL's SkyBoxFS.glsl is 9 lines and has NO such term.
//
// WHY THE EXISTING PROBE MISSES IT: probe-env-skybox-stars parks the camera at
// fromDegrees(0,0,5e7) pitch +90. `computeSkyBrightness` derives its up-vector
// from camera.positionWC (Scene.js:5767-5772), so skyBrightness there is
// whatever the ephemeris happens to give — the failing state is not guaranteed.
// A gate that cannot reach the failing state is not a gate.
//
// THIS PROBE forces the worst case: camera placed ALONG the sun direction, so
// normalize(positionWC) == sunDirWC -> sunAlt = 1.0 -> skyBrightness = 1.0 ->
// maximum dim. It aims perpendicular to the sun so neither the sun disc nor
// Earth is in frame — a pure star field.
//
// It measures CONTRAST, not just mean luminance. A washed-out star field can
// share the same mean as a good one while having far lower variance, so a
// mean-only diff would miss this bug entirely.
//
// It also A/B toggles the flag at RUNTIME on WebGPU, which proves causation
// without needing a source change.
//
// Usage: node Tools/visual-regression/probe-skybox-star-modulation.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const HARD_LIMIT_MS = 260000;
const watchdog = setTimeout(() => {
  console.error("[probe-skybox-star-mod] WATCHDOG FIRED (260s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

// Runs in-page. Positions the camera for maximum star modulation, renders,
// and returns both the driving scalar and star-field image statistics.
const MEASURE = async ({ toggleFlag }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;

  // Fixed clock so the ephemeris (and therefore the sun direction) is
  // deterministic across backends and runs.
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = C.JulianDate.fromIso8601("2026-05-19T18:00:00Z");
  scene.backgroundColor = C.Color.BLACK;
  if (scene.globe) scene.globe.show = false; // pure sky, no Earth
  scene.requestRenderMode = false;

  // Prime one frame so uniformState.sunDirectionWC is populated.
  scene.render();
  const sunDir = C.Cartesian3.clone(scene.context.uniformState.sunDirectionWC);

  // Camera ALONG the sun direction => normalize(positionWC) == sunDir
  // => sunAlt = dot(sunDir, up) = 1.0 => skyBrightness = 1.0 (max dim).
  const dist = 5.0e7;
  const position = C.Cartesian3.multiplyByScalar(sunDir, dist, new C.Cartesian3());

  // Aim perpendicular to the sun so neither the sun disc nor Earth is in frame.
  const seed =
    Math.abs(sunDir.z) < 0.9
      ? new C.Cartesian3(0, 0, 1)
      : new C.Cartesian3(1, 0, 0);
  const perp = C.Cartesian3.normalize(
    C.Cartesian3.cross(sunDir, seed, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const up = C.Cartesian3.normalize(
    C.Cartesian3.cross(perp, sunDir, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  scene.camera.setView({ destination: position, orientation: { direction: perp, up } });

  const readFlag = () => {
    const ac = scene.globe && scene.globe.atmosphericConditions;
    const sky = ac && ac.skyAtmosphere;
    return sky ? sky.enableStarBrightnessModulation : undefined;
  };
  if (toggleFlag !== undefined) {
    const ac = scene.globe && scene.globe.atmosphericConditions;
    if (ac && ac.skyAtmosphere) ac.skyAtmosphere.enableStarBrightnessModulation = toggleFlag;
  }

  for (let i = 0; i < 12; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }

  // ---- image statistics over the star field ----
  const canvas = scene.canvas;
  const w = canvas.width, h = canvas.height;
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  const ctx = tmp.getContext("2d");
  ctx.drawImage(canvas, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;

  const lums = new Float64Array(w * h);
  let sum = 0, starPx = 0, satSum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lums[p] = l;
    sum += l;
    if (l > 8) starPx++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 8) satSum += (mx - mn) / mx; // colour saturation of lit pixels
  }
  const n = w * h;
  const mean = sum / n;
  let varSum = 0;
  for (let p = 0; p < n; p++) { const d = lums[p] - mean; varSum += d * d; }
  const stddev = Math.sqrt(varSum / n);

  // Brightest-percentile energy: the part a fade crushes hardest.
  const sorted = Array.from(lums).sort((a, b) => b - a);
  const topN = Math.max(1, Math.floor(n * 0.001)); // top 0.1%
  let topSum = 0;
  for (let i = 0; i < topN; i++) topSum += sorted[i];
  const topMean = topSum / topN;
  const median = sorted[Math.floor(n / 2)];

  return {
    skyBrightness: scene.frameState ? scene.frameState.skyBrightness : null,
    flagValue: readFlag(),
    rendererType: scene.context.rendererType,
    width: w, height: h,
    meanLum: mean,
    stddev,                       // CONTRAST — the metric a mean-only diff misses
    starPct: (100 * starPx) / n,  // density of distinguishable points
    topMean,                      // brightest 0.1% energy
    median,
    contrastRatio: median > 0.01 ? topMean / median : topMean,
    meanSaturation: starPx > 0 ? satSum / starPx : 0,
  };
};

async function runBackend(browser, renderer, toggleFlag) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
  try {
    await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
      waitUntil: "domcontentloaded", timeout: 90000,
    });
    await page.waitForFunction(() => !!(window.viewer && window.viewer.scene && window.viewer.scene.context), null, { timeout: 90000 });
    await page.waitForTimeout(5000);
    const stats = await page.evaluate(MEASURE, { toggleFlag });
    await page.screenshot({ path: path.join(OUT_DIR, `skybox-stars-${renderer}${toggleFlag === undefined ? "" : `-mod${toggleFlag ? "ON" : "OFF"}`}.png`) });
    return { ok: true, renderer, toggleFlag, stats, consoleErrors: errs.slice(0, 4) };
  } catch (e) {
    return { ok: false, renderer, toggleFlag, error: String((e && e.message) || e).slice(0, 300), consoleErrors: errs.slice(0, 4) };
  } finally {
    await context.close().catch(() => {});
  }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let gl, gpu, gpuOff, gpuOn;
  try {
    gl = await runBackend(browser, "webgl", undefined);
    gpu = await runBackend(browser, "webgpu", undefined);          // as shipped
    gpuOff = await runBackend(browser, "webgpu", false);           // flag forced OFF
    gpuOn = await runBackend(browser, "webgpu", true);             // opt-in still works?
  } finally {
    await browser.close().catch(() => {});
  }

  const S = (x) => (x && x.ok ? x.stats : null);
  const a = S(gl), b = S(gpu), c = S(gpuOff), d = S(gpuOn);

  const ratio = (x, y) => (x != null && y != null && y !== 0 ? r3(x / y) : null);

  const verdict = {
    skyBrightness_webgpu: b ? r3(b.skyBrightness) : null,
    reachedFailingState: b && b.skyBrightness != null ? b.skyBrightness > 0.5 : null,
    predictedDimFactor:
      b && b.skyBrightness != null
        ? r3(1 - (() => { const t = Math.min(1, Math.max(0, (b.skyBrightness - 0.5) * 1.0)); return t * t * (3 - 2 * t); })())
        : null,
    flagAsShipped: b ? b.flagValue : null,
    asShipped: {
      webgl: a ? { mean: r3(a.meanLum), stddev: r3(a.stddev), starPct: r3(a.starPct), topMean: r3(a.topMean) } : null,
      webgpu: b ? { mean: r3(b.meanLum), stddev: r3(b.stddev), starPct: r3(b.starPct), topMean: r3(b.topMean) } : null,
      gpuOverGl_mean: ratio(b && b.meanLum, a && a.meanLum),
      gpuOverGl_stddev: ratio(b && b.stddev, a && a.stddev),
      gpuOverGl_topMean: ratio(b && b.topMean, a && a.topMean),
    },
    flagForcedOff: {
      webgpu: c ? { mean: r3(c.meanLum), stddev: r3(c.stddev), starPct: r3(c.starPct), topMean: r3(c.topMean) } : null,
      gpuOverGl_mean: ratio(c && c.meanLum, a && a.meanLum),
      gpuOverGl_stddev: ratio(c && c.stddev, a && a.stddev),
      gpuOverGl_topMean: ratio(c && c.topMean, a && a.topMean),
    },
    causationProven:
      b && c && b.topMean != null && c.topMean != null && b.topMean > 0
        ? c.topMean / b.topMean > 1.15
        : null,
    // GOVERNING PRINCIPLE CHECK: the default is parity, but the additive
    // capability must remain reachable. Forcing the flag true must still dim.
    optInStillDims: {
      webgpu_modON: d ? { mean: r3(d.meanLum), stddev: r3(d.stddev), starPct: r3(d.starPct), topMean: r3(d.topMean) } : null,
      modON_over_default_mean: ratio(d && d.meanLum, b && b.meanLum),
      capabilityPreserved:
        d && b && d.meanLum != null && b.meanLum > 0 ? d.meanLum / b.meanLum < 0.85 : null,
    },
    // The gate: default must be at parity AND the opt-in must still function.
    GATE:
      (() => {
        if (!a || !b || !d) return "INCOMPLETE";
        const meanOk = Math.abs(b.meanLum / a.meanLum - 1) < 0.1;
        const contrastOk = Math.abs(b.stddev / a.stddev - 1) < 0.1;
        const densityOk = Math.abs(b.starPct / a.starPct - 1) < 0.1;
        const optInOk = d.meanLum / b.meanLum < 0.85;
        return meanOk && contrastOk && densityOk && optInOk
          ? "PASS — default at WebGL parity AND opt-in capability preserved"
          : `FAIL — mean:${meanOk} contrast:${contrastOk} density:${densityOk} optIn:${optInOk}`;
      })(),
  };

  const outPath = path.join(OUT_DIR, "skybox-star-modulation.json");
  fs.writeFileSync(outPath, JSON.stringify({ verdict, gl, gpu, gpuOff, gpuOn }, null, 2));
  console.log(JSON.stringify(verdict, null, 2));
  for (const l of [gl, gpu, gpuOff]) if (l && !l.ok) console.log(`${l.renderer}(mod=${l.toggleFlag}) FAILED: ${l.error}`);
  console.log(`\n[full report: ${outPath}]`);
  clearTimeout(watchdog);
  process.exit(0);
})().catch((e) => {
  console.error("[probe-skybox-star-mod] FATAL", e);
  process.exit(1);
});
