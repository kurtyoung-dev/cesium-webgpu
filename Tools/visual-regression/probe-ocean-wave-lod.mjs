#!/usr/bin/env node
// probe-ocean-wave-lod.mjs — C11-172 OCEAN-WAVE PHYSICAL-WAVELENGTH LOD acceptance.
//
// DEFECT (maintainer screenshot 2026-07-24): a LOW camera over open ocean on
// WebGPU renders the waves as uniform per-pixel NOISE to the horizon ("very
// noisy, not natural"). ROOT CAUSE (orchestrator review): the WGSL octaves were
// sampled in TILE UV at a fixed mip, which is scale-invariant under terrain SSE
// — the "waves" were animated mip-0 aliasing at every altitude. THE FIX: anchor
// the octaves to PHYSICAL wavelengths via a global ellipsoid (lon/lat) UV, sample
// mip/aniso-aware (textureSampleGrad + maxAnisotropy 8), amplitude-fade by pixel
// footprint, hard-cut far away. Real structure replaces shimmer (an intentional
// appearance change), so this probe does NOT demand pixel parity with WebGL.
//
// METRIC = high-frequency luminance variance (variance of a 4-neighbour
// Laplacian) in DISTANCE BANDS (rows). Noise reads as very high HF variance; the
// fix keeps moderate, resolvable HF variance NEAR and lower HF variance FAR.
//
// GATES (WebGPU is the subject; WebGL is a sanity reference, NOT a pixel oracle):
//   LOW lane (~50 m, horizon in frame):
//     (a) far-band HF-variance below FAR_ABS_MAX  AND  below the near band by
//         >= FAR_OVER_NEAR_MAX (calms with distance — not noise to the horizon);
//     (b) near-band HF-variance in [NEAR_VAR_MIN, NEAR_VAR_MAX] (real waves, not
//         flat-dead AND not per-pixel noise);
//     (c) near-band TEMPORAL delta >= NEAR_ANIM_MIN, per backend (waves animate).
//   MID lane (~20 km):
//     (d) ocean actually rendered — meanLum in [LIT_MIN, LIT_MAX] and total HF
//         variance > MID_RENDER_FLOOR (NOT an all-black or all-flat canvas), and
//         near-band HF variance not pathologically high (<= NEAR_VAR_MAX).
//   ALL lanes/backends:
//     (e) scene.context.rendererType MUST equal the requested backend (a silent
//         WebGPU->WebGL fallback fails hard, not silently passes).
//
// Thresholds are ADVISORY first-calibration and reported with the full band
// profile so the orchestrator's Edge run can confirm the visual result (READ the
// emitted canvas PNGs) and retune. Also tune the octave WAVELENGTHS in the
// shaders after the visual check — this probe measures noise-vs-structure, not
// the exact wave scale.
//
// Usage: node Tools/visual-regression/probe-ocean-wave-lod.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// ── house rule: hard watchdog + unref, forces exit 2 on hang ──
const HARD_LIMIT_MS = 300000;
const watchdog = setTimeout(() => {
  console.error("[probe-ocean-wave-lod] WATCHDOG FIRED (300s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

// Open North-Pacific ocean, far from any coast so the water mask is all-water.
// KNOWN RESIDUAL (Batch 757 orchestrator high-lat sweep): at ~53N/178E
// (Bering basin) a corduroy band remains just under the horizon (far-band
// lapVar ~25 vs ~1.8 here) - the ripple octave's cos(lat)-compressed zonal
// wavelength sits near-Nyquist on the min footprint axis. Near-field waves
// there are natural (lapVar 4.4, animating). Filed as
// OCEAN-WAVE-HIGHLAT-HORIZON-BAND in DEFERRED_WORK.md; do not treat a
// high-lat far-band excursion as a regression of THIS gate's site.
const OCEAN_LON = -150.0;
const OCEAN_LAT = 25.0;
const DAY_ISO = "2026-07-03T22:00:00Z"; // ~local noon at lon -150 (sun high)

// Lanes. `oceanTopFrac`: frame is ocean BELOW this row fraction (above = sky).
// `bands`: split [top, 0.98] into equal rows; band 0 = FAR (under horizon),
// last = NEAR (foreground). MID is all-ocean (horizon off the top).
const LANES = {
  low: { alt: 50.0, pitch: -12.0, oceanTopFrac: 0.45, bands: 4 },
  mid: { alt: 20000.0, pitch: -30.0, oceanTopFrac: 0.06, bands: 4 },
};

// ── advisory gate thresholds (retunable after the Edge visual check) ──
const FAR_ABS_MAX = 8.0; // low-lane far-band Laplacian variance ceiling
// Orchestrator calibration (Batch 756 Edge evidence): ORIGINAL shaders measure
// near 45.65 / far 12.75 (farOverNear 0.279 but farAbs FAILS at 2x the ceiling
// - the noise was everywhere); v2 measures near 2.04 / far 1.81. Post-fix both
// bands are low-variance, so the far/near ratio is secondary; the primary
// noise gate is FAR_ABS_MAX + nearStructureOk. Far must simply not EXCEED near.
const FAR_OVER_NEAR_MAX = 1.0;
const NEAR_VAR_MIN = 0.4; // near band must show SOME wave structure (not dead-flat)
const NEAR_VAR_MAX = 60.0; // ...but not per-pixel noise (the pre-fix failure)
const NEAR_ANIM_MIN = 0.08; // per-backend near-band temporal delta floor (waves move)
const LIT_MIN = 6.0; // ocean is lit (mean luminance floor — not black)
const LIT_MAX = 240.0; // ...and not blown out
const MID_RENDER_FLOOR = 0.05; // mid lane: SOMETHING rendered (not flat black)

// Runs in-page. Positions the camera for the lane, settles tiles at the pinned
// clock, captures frame0, advances the wave phase by RENDERING frames (the wave
// phase is FRAME-driven: tile.time = frameNumber*0.15, so rendering — not clock
// seconds — advances it on BOTH backends), captures frame1, and returns per-band
// HF variance (frame0) + per-band temporal delta + a canvas PNG data URL. EVERY
// render passes the pinned time; getImageData/toDataURL run in the SAME task as
// their render (WebGPU clears the drawing buffer once the compositor presents).
const MEASURE = async ({ lane, lon, lat, dayIso }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;

  viewer.useDefaultRenderLoop = false; // house rule: no default loop
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = C.JulianDate.fromIso8601(dayIso);
  const T = () => viewer.clock.currentTime;

  scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(lon, lat, lane.alt),
    orientation: {
      heading: 0.0,
      pitch: C.Math.toRadians(lane.pitch),
      roll: 0.0,
    },
  });

  // Settle tiles at the pinned clock (bounded).
  for (let i = 0; i < 260; i++) {
    viewer.clock.currentTime = C.JulianDate.fromIso8601(dayIso);
    scene.render(T());
    await new Promise((r) => requestAnimationFrame(r));
  }

  const canvas = scene.canvas;
  const w = canvas.width,
    h = canvas.height;

  // Same-task capture: render at pinned time, read pixels with NO await between.
  // dataUrl comes from the 2d copy canvas (always preserved) — clean canvas-only
  // evidence with no app chrome.
  const grab = (wantUrl) => {
    scene.render(T());
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    return {
      data: ctx.getImageData(0, 0, w, h).data,
      dataUrl: wantUrl ? tmp.toDataURL("image/png") : null,
    };
  };

  const f0 = grab(false).data;

  // Advance the wave phase by RENDERING frames (frame-driven). 180 frames ->
  // tile.time += ~27 -> a clearly visible phase shift on both backends.
  for (let i = 1; i <= 180; i++) {
    viewer.clock.currentTime = C.JulianDate.fromIso8601(dayIso); // keep sun fixed
    scene.render(T());
    await new Promise((r) => requestAnimationFrame(r));
  }
  const g1 = grab(true);
  const f1 = g1.data;

  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const idx = (x, y) => (y * w + x) * 4;
  const y0 = Math.floor(lane.oceanTopFrac * h);
  const y1 = Math.floor(0.98 * h);
  const bandH = (y1 - y0) / lane.bands;

  const bands = [];
  let allN = 0,
    allSumL2 = 0,
    allSumLum = 0;
  for (let b = 0; b < lane.bands; b++) {
    const by0 = Math.max(Math.floor(y0 + b * bandH) + 1, 1);
    const by1 = Math.min(Math.floor(y0 + (b + 1) * bandH) - 1, h - 1);
    let n = 0,
      sumL = 0,
      sumL2 = 0,
      sumLum = 0,
      td = 0,
      tn = 0;
    for (let y = by0; y < by1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = idx(x, y);
        const c = lum(f0, i);
        const L =
          4 * c -
          lum(f0, idx(x - 1, y)) -
          lum(f0, idx(x + 1, y)) -
          lum(f0, idx(x, y - 1)) -
          lum(f0, idx(x, y + 1));
        sumL += L;
        sumL2 += L * L;
        sumLum += c;
        n++;
        td += Math.abs(c - lum(f1, i));
        tn++;
      }
    }
    const meanL = n ? sumL / n : 0;
    const lapVar = n ? sumL2 / n - meanL * meanL : 0;
    allN += n;
    allSumL2 += sumL2;
    allSumLum += sumLum;
    bands.push({
      band: b,
      y0: by0,
      y1: by1,
      meanLum: n ? +(sumLum / n).toFixed(2) : null,
      lapVar: +lapVar.toFixed(3),
      temporal: tn ? +(td / tn).toFixed(3) : null,
    });
  }

  return {
    rendererType: scene.context.rendererType,
    width: w,
    height: h,
    lane: { alt: lane.alt, pitch: lane.pitch, oceanTopFrac: lane.oceanTopFrac },
    bands,
    farBand: bands[0],
    nearBand: bands[bands.length - 1],
    overallMeanLum: allN ? +(allSumLum / allN).toFixed(2) : null,
    overallLapVar: allN ? +(allSumL2 / allN).toFixed(3) : null,
    dataUrl: g1.dataUrl,
  };
};

async function runBackend(browser, renderer, laneName) {
  const lane = LANES[laneName];
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 200)));
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      },
    );
    await page.waitForFunction(
      () =>
        !!(window.viewer && window.viewer.scene && window.viewer.scene.context),
      null,
      { timeout: 90000 },
    );
    await page.waitForTimeout(4000);
    const stats = await page.evaluate(MEASURE, {
      lane,
      lon: OCEAN_LON,
      lat: OCEAN_LAT,
      dayIso: DAY_ISO,
    });
    // Canvas-only PNG evidence (from the same-task 2d copy — no app chrome).
    if (stats.dataUrl) {
      const b64 = stats.dataUrl.replace(/^data:image\/png;base64,/, "");
      fs.writeFileSync(
        path.join(OUT_DIR, `ocean-wave-lod-${laneName}-${renderer}.png`),
        Buffer.from(b64, "base64"),
      );
    }
    delete stats.dataUrl;
    return {
      ok: true,
      renderer,
      laneName,
      stats,
      consoleErrors: errs.slice(0, 4),
    };
  } catch (e) {
    return {
      ok: false,
      renderer,
      laneName,
      error: String((e && e.message) || e).slice(0, 300),
      consoleErrors: errs.slice(0, 4),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

// (e) backend identity — a silent fallback must fail, not pass.
function rendererMatches(res, requested) {
  return !!(res && res.ok && res.stats && res.stats.rendererType === requested);
}

function evaluateLow(gpu) {
  const g = gpu && gpu.ok ? gpu.stats : null;
  if (!g) return { verdict: "INCOMPLETE", reason: "missing capture" };
  const far = g.farBand,
    near = g.nearBand;
  const farAbsOk = far.lapVar <= FAR_ABS_MAX;
  const farOverNear =
    near.lapVar > 0 ? far.lapVar / near.lapVar : far.lapVar > 0 ? 999 : 0;
  const farRatioOk = farOverNear <= FAR_OVER_NEAR_MAX;
  const nearStructureOk =
    near.lapVar >= NEAR_VAR_MIN && near.lapVar <= NEAR_VAR_MAX;
  const animOk = near.temporal != null && near.temporal >= NEAR_ANIM_MIN;
  const litOk =
    near.meanLum != null && near.meanLum >= LIT_MIN && near.meanLum <= LIT_MAX;
  const pass = farAbsOk && farRatioOk && nearStructureOk && animOk && litOk;
  return {
    verdict: pass ? "PASS" : "FAIL",
    farLapVar: far.lapVar,
    nearLapVar: near.lapVar,
    farOverNear: +farOverNear.toFixed(3),
    nearTemporal: near.temporal,
    nearMeanLum: near.meanLum,
    checks: { farAbsOk, farRatioOk, nearStructureOk, animOk, litOk },
  };
}

function evaluateMid(gpu) {
  const g = gpu && gpu.ok ? gpu.stats : null;
  if (!g) return { verdict: "INCOMPLETE", reason: "missing capture" };
  const litOk =
    g.overallMeanLum != null &&
    g.overallMeanLum >= LIT_MIN &&
    g.overallMeanLum <= LIT_MAX;
  const renderedOk =
    g.overallLapVar != null && g.overallLapVar > MID_RENDER_FLOOR;
  const notNoiseOk = g.nearBand.lapVar <= NEAR_VAR_MAX;
  const pass = litOk && renderedOk && notNoiseOk;
  return {
    verdict: pass ? "PASS" : "FAIL",
    overallMeanLum: g.overallMeanLum,
    overallLapVar: g.overallLapVar,
    nearLapVar: g.nearBand.lapVar,
    checks: { litOk, renderedOk, notNoiseOk },
  };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let lowGl, lowGpu, midGl, midGpu;
  try {
    lowGl = await runBackend(browser, "webgl", "low");
    lowGpu = await runBackend(browser, "webgpu", "low");
    midGl = await runBackend(browser, "webgl", "mid");
    midGpu = await runBackend(browser, "webgpu", "mid");
  } finally {
    await browser.close().catch(() => {});
  }

  // (e) backend identity for every lane.
  const identity = {
    lowGl: rendererMatches(lowGl, "webgl"),
    lowGpu: rendererMatches(lowGpu, "webgpu"),
    midGl: rendererMatches(midGl, "webgl"),
    midGpu: rendererMatches(midGpu, "webgpu"),
  };
  const identityOk = Object.values(identity).every(Boolean);

  const low = evaluateLow(lowGpu);
  const mid = evaluateMid(midGpu);
  // WebGL sanity lanes: must still render lit ocean AND — since v2/v3 also touch
  // the WebGL path (footprint fade + cutoff) — must still show ANIMATING wave
  // STRUCTURE (P2: a WebGL wave-freeze or flatten would otherwise slip through a
  // meanLum-only check). Not a pixel oracle for WebGPU.
  // Orchestrator calibration (Batch 757 Edge evidence): WebGL's smooth
  // long-streak waves NATURALLY measure near-band lapVar ~0.19-0.20 (0.201
  // on the ORIGINAL shaders in the v1 run, 0.189 with v3 - unchanged, the
  // D2 recalibration is a near-field no-op as designed), far below the
  // WebGPU floor of 0.4 (WebGPU natural: 6.6). The flatten-regression class
  // this floor guards against measured 0.052 (WebGPU v1 over-fade). Floor
  // sits between: catches a flatten, accepts WebGL's smooth look.
  const NEAR_VAR_MIN_GL = 0.08;
  const lowGlSane =
    lowGl &&
    lowGl.ok &&
    lowGl.stats.nearBand.meanLum >= LIT_MIN &&
    lowGl.stats.nearBand.lapVar >= NEAR_VAR_MIN_GL &&
    lowGl.stats.nearBand.temporal != null &&
    lowGl.stats.nearBand.temporal >= NEAR_ANIM_MIN;
  const midGlSane = midGl && midGl.ok && midGl.stats.overallMeanLum >= LIT_MIN;

  const anyLaneFailed = [lowGl, lowGpu, midGl, midGpu].some((l) => l && !l.ok);
  const incomplete =
    low.verdict === "INCOMPLETE" || mid.verdict === "INCOMPLETE";
  const structural = anyLaneFailed || incomplete || !identityOk;
  const gatePass =
    low.verdict === "PASS" && mid.verdict === "PASS" && lowGlSane && midGlSane;

  const verdict = {
    backendIdentity: identity,
    lowLane: low,
    midLane: mid,
    webglSanity: { lowGlSane, midGlSane },
    thresholds: {
      FAR_ABS_MAX,
      FAR_OVER_NEAR_MAX,
      NEAR_VAR_MIN,
      NEAR_VAR_MAX,
      NEAR_ANIM_MIN,
      LIT_MIN,
      LIT_MAX,
      MID_RENDER_FLOOR,
    },
    GATE: !identityOk
      ? "INCOMPLETE — a backend fell back (rendererType != requested)"
      : structural
        ? "INCOMPLETE — a lane failed to run or a capture is missing"
        : gatePass
          ? "PASS — far calms, near shows animating waves (not noise), mid renders lit ocean"
          : `FAIL — low:${low.verdict} mid:${mid.verdict} lowGlSane:${lowGlSane} midGlSane:${midGlSane}`,
  };

  const outPath = path.join(OUT_DIR, "ocean-wave-lod.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify({ verdict, lowGl, lowGpu, midGl, midGpu }, null, 2),
  );
  console.log(JSON.stringify(verdict, null, 2));
  for (const laneRes of [lowGl, lowGpu, midGl, midGpu]) {
    if (laneRes && !laneRes.ok)
      console.log(
        `${laneRes.renderer}/${laneRes.laneName} FAILED: ${laneRes.error}`,
      );
    if (laneRes && laneRes.consoleErrors && laneRes.consoleErrors.length)
      laneRes.consoleErrors.forEach((e) =>
        console.log(
          `  [${laneRes.renderer}/${laneRes.laneName}] console: ${e}`,
        ),
      );
  }
  console.log(`\n[full report: ${outPath}]`);

  const exitCode = structural ? 2 : gatePass ? 0 : 1;
  console.log(`\nGATE: ${verdict.GATE}\nEXIT: ${exitCode}`);
  clearTimeout(watchdog);
  process.exit(exitCode);
})().catch((e) => {
  console.error("[probe-ocean-wave-lod] FATAL", e);
  process.exit(2);
});
