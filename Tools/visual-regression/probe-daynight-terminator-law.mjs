#!/usr/bin/env node
// CLT-B1 — day/night terminator LAW probe (premise verification, no fix).
//
// SPEC: migration_doc/CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md §2 (bugs
// 1-2) and §4 (row CLT-B1, a BLOCKING prereq for the CLT-B7 blend). The
// deliverable is a NUMBERS TABLE, not a change: pixel-confirm or refute the
// four recorded static findings, on both backends, with the mechanism named.
//
//   (a) the backends disagree by ~0.5 night-alpha AT the geometric terminator
//       — GLSL `1 - clamp(N.L*5, 0, 1)` (GlobeFS.glsl:601) vs WGSL
//       `computeDayNightFade`'s `+0.5` (GlobeTerrain.wgsl:2230-2233)
//   (b) `globe.enableNightLights = false` leaves the WebGPU emission at the
//       default-2.5 sentinel (Globe.js:1272 wrote 0.0; GlobeTerrain.wgsl's
//       `getNightIntensity` read 0.0 as "use 2.5")
//   (c) WebGL gates the day/night imagery alpha off entirely on vertex-normal
//       terrain (GlobeSurfaceShaderSet.js:435-442) while WebGPU keeps it
//       (GlobeTerrain.wgsl gates only on `camera.enableLighting`)
//   (d) WebGL flattens the night side at low altitude via its camera-distance
//       lighting fade (GlobeFS.glsl:620-642, :828-831); the WGSL Lambert path
//       has no such term
//
// ─────────────────────────────────────────────────────────────────────────────
// THE NIGHT-IMAGERY DEPENDENCY, AND WHY THIS PROBE DOES NOT HAVE ONE
// ─────────────────────────────────────────────────────────────────────────────
// Findings (a) and (b) concern an imagery ALPHA, which needs a layer whose
// `dayAlpha` and `nightAlpha` differ — normally Ion's Earth-at-Night raster,
// which a headless offline probe cannot have. It does not need to be THAT
// raster. `ImageryLayer.dayAlpha` / `.nightAlpha` are per-layer numbers, so a
// two-texel `SingleTileImageryProvider` built in-page from a data URL carries
// the same alphas through the identical shader path, with none of the content
// variation that would otherwise have to be divided out. Both layers are
// synthesised here; nothing streams. The only leg that remains genuinely
// unavailable offline is (c)'s RENDER half — see lane C.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A CALIBRATION LADDER (the instrument, stated before the numbers)
// ─────────────────────────────────────────────────────────────────────────────
// The quantity under test is an alpha; what a probe can read is an 8-bit
// display value downstream of the day/night LIGHTING multiply, the imagery
// composite, and whatever transfer the backend's output chain applies. Both
// confounds are removed by measurement rather than by assumption:
//
//   `dayAlpha == nightAlpha == c` makes the shader's blend `mix(c, c, x) == c`
//   on BOTH backends — GLSL `mix(dayAlpha, nightAlpha, nightBlend)`, WGSL
//   `mix(nightAlpha, dayAlpha, dayFade)` — so sweeping `c` traces the per-pixel
//   transfer from alpha to pixel value WITHOUT touching the ramp. Inverting
//   that measured curve turns the measurement leg's pixel value back into an
//   alpha whatever the transfer is, provided it is monotone — and
//   `calibrationHealth` CHECKS monotonicity and span instead of assuming them.
//
// A three-leg ratio would have been shorter and would have silently assumed a
// linear display transform — the same assumption `celestial-g2-gate.mjs` had to
// retract mid-campaign.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TRAP THIS PROBE IS SHAPED AROUND
// ─────────────────────────────────────────────────────────────────────────────
// Finding (a) predicts "WebGPU reads ~0.5 at the terminator". A probe that
// sampled only the terminator would report 0.5 and bank the recorded
// mechanism. But 0.5 is ALSO what a second, independent defect produces at the
// vernal equinox: `GlobeTerrain.wgsl` takes its day/night N from
// `input.v_normalEC`, the interpolated MESH vertex normal, where `GlobeFS.glsl`
// recomputes the analytic geocentric normal per fragment
// (`czm_geodeticSurfaceNormal(v_positionMC, vec3(0), vec3(1))`). On terrain
// with no vertex normals — which is every offline provider in this fork — the
// WGSL vertex stage feeds `octDecode(0.0)`, a CONSTANT model-space (0,0,-1), so
// N.L is one number for the whole globe; at an equinox the Sun lies in the
// equatorial plane and that number is ~0, i.e. dayFade ~0.5 EVERYWHERE.
//
// Same reading, different defect, opposite fix. So the probe measures the ramp
// SHAPE across N.L, not just its value at one point, and runs a second leg at a
// SOLSTICE where the two hypotheses separate hard: `dot(spinAxis, sunDir)`
// reaches sin(23.44 deg) = 0.397 there, which saturates a constant-normal
// backend to full day (no terminator at all) while leaving a real per-fragment
// ramp untouched.
//
// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISM PINS (each one READ BACK; a pin that did not take is STRUCTURAL)
// ─────────────────────────────────────────────────────────────────────────────
//   P1 OFFLINE GLOBE  `&offline=true` plus `imageryLayers.removeAll()` and a
//                     forced `EllipsoidTerrainProvider`. Both synthetic layers
//                     are data URLs; nothing is fetched.
//   P2 ONE DRIVER     `useDefaultRenderLoop=false`, `requestRenderMode=false`,
//                     `clock.shouldAnimate=false`, and every render goes
//                     through `scene.render(pinnedDate)`. `Scene.render()` with
//                     no argument substitutes `JulianDate.now()`.
//   P3 NO OTHER LIGHT sun/moon/skyBox/skyAtmosphere/fog/clouds off, ground
//                     atmosphere off, water off, HDR/TAA/FXAA/bloom off. Every
//                     one of those adds a term the alpha inversion would have
//                     to divide out.
//   P4 FADE REGIME    the two camera heights are chosen so WebGL's
//                     `lightingFade` is EXACTLY 0 and EXACTLY 1; the fade
//                     distances are read back and the regime asserted, so lane
//                     D is not scoring a partial fade it cannot model.
//   P5 SAME-TASK      render -> `toDataURL` in ONE task, decode afterwards. A
//                     GPU-canvas read across a yield is invalid on BOTH
//                     backends. The canonical block below is byte-compared by
//                     `daynight-terminator-law.spec.mjs`.
//   P6 SETTLE         a WALL-CLOCK budget with a tile-loaded predicate, never a
//                     frame count (a cold pipeline variant has measured ~2674
//                     ms to compile on this fork).
//   P7 HEADROOM       every scored difference is preceded by a control that
//                     shows the metric CAN move: the ladder's measured span per
//                     pixel, and the `nightIntensity 2.5 -> 5.0` leg.
//
// EXIT CODES
//   0 PASS        every scored predicate decided and in band
//   1 FAIL        a scored predicate decided and out of band (a recorded
//                 finding is REFUTED at this build)
//   2 ERROR       a lane did not run
//   3 STRUCTURAL  a lane ran but could not see its subject. Lane C is
//                 unconditionally structural offline (it needs a terrain
//                 provider with vertex normals, and every offline provider in
//                 this fork returns `hasVertexNormals === false`), so an
//                 offline run's BEST possible exit is 3 BY CONSTRUCTION. That
//                 is the point: the leg is reported, not skipped.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHICH BUILD YOU POINT THIS AT CHANGES WHAT LANE B MEANS
// ─────────────────────────────────────────────────────────────────────────────
// Lane B scores finding (b) — the `nightIntensity` sentinel collision — and
// CLT-B2 FIXES that collision in the same batch group. So:
//
//   built at HEAD (pre-CLT-B2)  lane B is expected to read off == on and report
//                               CONFIRMED. That is the premise verification.
//   built with CLT-B2 landed    lane B is expected to read off << on and report
//                               REFUTED, which folds to exit 1. That is NOT a
//                               regression — it is CLT-B2's acceptance, and the
//                               lane's own failure text says "the sentinel
//                               collision is not present at this build".
//
// Record which build produced the numbers alongside them. A lane-B verdict with
// no build provenance is uninterpretable in either direction.
//
// Usage:
//   node Tools/visual-regression/probe-daynight-terminator-law.mjs
// Env:
//   PROBE_BASE=http://localhost:8080
//   PROBE_HEADED=1
// Output (gitignored):
//   Tools/visual-regression/output/daynight-law-*.png
//   Tools/visual-regression/output/daynight-terminator-law-report.json

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import {
  EXIT_CODE,
  LANE,
  DIVERGENCE_BAND,
  FIT_WINDOW,
  dayFadeGlsl,
  dayFadeWgsl,
  calibrationHealth,
  invertCalibration,
  binByNdotL,
  rmseAgainst,
  centralSlope,
  alphaAtTerminator,
  classifyRamp,
  evaluateRampLane,
  evaluateSentinelLane,
  evaluateCameraFadeLane,
  evaluateSolsticeLane,
  foldVerdict,
} from "./lib/daynight-terminator-law.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const HEADED = process.env.PROBE_HEADED === "1";
const OUT_DIR = path.join(HERE, "output");

// Vernal equinox and June solstice, both at 12:00 UTC. The equinox instant is
// the one `probe-dusk-terminator.mjs` already pins; the solstice is this
// probe's addition and exists only to separate lane A's two hypotheses.
const EQUINOX_ISO = "2026-03-20T12:00:00Z";
const SOLSTICE_ISO = "2026-06-21T12:00:00Z";

// 3:2 so `PerspectiveFrustum.fov` (which applies to the WIDER axis) is the
// HORIZONTAL field of view. The scanline is horizontal and the terminator runs
// vertically, so this puts the whole N.L sweep along the sampled axis and
// leaves each row an independent replicate at the same N.L.
const VIEWPORT = { width: 1200, height: 800 };

// LOW: |eye| = 6378137 + 3e6 = 9.378e6 < lightingFadeOutDistance (pi/2 x
//      minimumRadius = 9.984e6) => WebGL `fade` is exactly 0 (flat-lit).
// HIGH: |eye| = 31.378e6 > lightingFadeInDistance (pi x minimumRadius =
//      19.968e6) => `fade` is exactly 1 (full day/night).
// Both are asserted against the live fade distances, not assumed.
const LOW_ALTITUDE_M = 3_000_000;
const HIGH_ALTITUDE_M = 25_000_000;

// The ladder rungs. 0.999 rather than 1.0 so `applyDayNightAlpha` (WebGL's
// define, set when any layer's day/night alpha differs from 1.0) stays ON for
// every leg — otherwise the top rung would compile a DIFFERENT shader variant
// than the rungs it is calibrating against.
const LADDER_ALPHAS = Object.freeze([0.0, 0.25, 0.5, 0.75, 0.999]);

// Sampling grid. Columns every 2 px across the full width; rows spread over the
// middle band so the widget chrome and the timeline are never sampled.
const COLUMN_STEP_PX = 2;
const ROW_COUNT = 21;

// A pixel whose calibration ladder spans fewer than this many 8-bit counts
// cannot resolve alpha and is dropped. 8 is low on purpose: the scored
// statistic is a BIN mean over several hundred samples, so the per-sample
// quantisation floor (~0.29 counts RMS) averages far below the 0.12 alpha
// tolerance. The per-bin median span is reported so the conditioning is
// visible rather than assumed.
const MIN_CALIBRATION_SPAN = 8;

// Wall-clock settle budget. Matches the fleet standard (>= the measured cold
// pipeline-compile cost on this fork) with a frame floor for fast machines.
const SETTLE_BUDGET_MS = 3200;
const SETTLE_MIN_FRAMES = 24;
// Subsequent legs inside one config reuse warm pipelines and only change
// uniforms, so they carry a shorter budget.
const RELEG_BUDGET_MS = 500;

const WATCHDOG_MS = 900_000;

fs.mkdirSync(OUT_DIR, { recursive: true });

const watchdog = setTimeout(() => {
  console.error(
    `[probe-daynight-terminator-law] WATCHDOG FIRED (${WATCHDOG_MS / 1000}s) — forcing exit`,
  );
  process.exit(EXIT_CODE.ERROR);
}, WATCHDOG_MS);
watchdog.unref?.();

const r3 = (x) =>
  x === null || x === undefined || !Number.isFinite(x)
    ? null
    : Math.round(x * 1000) / 1000;

// ─── synthetic imagery, built in Node ────────────────────────────────────────
//
// The two layers are solid-colour PNGs encoded HERE rather than drawn in-page
// with `canvas.toDataURL`. Two reasons, and the first is not stylistic:
// `lib/same-task-capture.mjs::checkFusedCaptureUsage` rejects ANY `toDataURL`
// outside the canonical capture block, because a probe-local canvas reader is
// exactly the shape that produced the false-black readings the fused primitive
// exists to prevent — and that rule does not stop applying because this
// particular reader is only making a texture. Second, a byte-fixed PNG is
// deterministic across browsers and DPI in a way a 2D-context fill is not.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** A `size` x `size` solid RGB PNG as a data URL. */
function solidPngDataUrl(r, g, b, size = 2) {
  const stride = 1 + size * 3;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0; // filter type 0 (None)
    for (let x = 0; x < size; x++) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

// The base is a uniform mid-dark slate: dark enough to leave the white overlay
// a large calibration span, light enough that "globe" and "black clear" can
// never be the same pixel value.
const BASE_RGB = Object.freeze([48, 52, 64]);
const OVERLAY_RGB = Object.freeze([255, 255, 255]);

// ─── in-page measurement ─────────────────────────────────────────────────────

/**
 * Everything that runs inside the browser, as ONE function so the helpers stay
 * in the page's closure. `page.evaluate` drops a closure captured on the Node
 * side, so shared code must either be embedded as text (the canonical
 * same-task block below) or live here.
 */
const MEASURE = async (options) => {
  const {
    equinoxIso,
    solsticeIso,
    lowAltitude,
    highAltitude,
    ladderAlphas,
    columnStep,
    rowCount,
    settleBudgetMs,
    settleMinFrames,
    relegBudgetMs,
    baseDataUrl,
    overlayDataUrl,
  } = options;

  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const out = {
    rendererType: scene.context?.rendererType ?? "unknown",
    structuralError: null,
    pins: {},
    configs: {},
  };

  // ── P2 ONE DRIVER ──────────────────────────────────────────────────────────
  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  viewer.clock.multiplier = 0;
  scene.requestRenderMode = false;

  // ── P3 NO OTHER LIGHT ──────────────────────────────────────────────────────
  scene.highDynamicRange = false;
  scene.sunBloom = false;
  scene.taaEnabled = false;
  scene.backgroundColor = C.Color.BLACK;
  scene.globe.showGroundAtmosphere = false;
  scene.globe.showWaterEffect = false;
  scene.globe.show = true;
  scene.globe.enableLighting = true;
  if (scene.postProcessStages?.fxaa) {
    scene.postProcessStages.fxaa.enabled = false;
  }
  if (scene.postProcessStages?.bloom) {
    scene.postProcessStages.bloom.enabled = false;
  }
  if (scene.fog) {
    scene.fog.enabled = false;
  }
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = false;
  }
  if (scene.skyBox) {
    scene.skyBox.show = false;
  }
  if (scene.sun) {
    scene.sun.show = false;
  }
  if (scene.moon) {
    scene.moon.show = false;
  }
  if (scene.volumetricClouds) {
    scene.volumetricClouds.show = false;
  }

  // ── P1 OFFLINE GLOBE + the two synthetic layers ────────────────────────────
  scene.terrainProvider = new C.EllipsoidTerrainProvider();

  let baseLayer;
  let overlayLayer;
  try {
    viewer.imageryLayers.removeAll();
    const basePr = await C.SingleTileImageryProvider.fromUrl(baseDataUrl, {
      rectangle: C.Rectangle.MAX_VALUE,
    });
    baseLayer = viewer.imageryLayers.addImageryProvider(basePr);
    const overlayPr = await C.SingleTileImageryProvider.fromUrl(
      overlayDataUrl,
      { rectangle: C.Rectangle.MAX_VALUE },
    );
    overlayLayer = viewer.imageryLayers.addImageryProvider(overlayPr);
  } catch (error) {
    return {
      ...out,
      structuralError: `synthetic imagery failed: ${String(error?.message ?? error)}`,
    };
  }

  // ── pin readback. A requested setting is not an established one. ───────────
  out.pins = {
    useDefaultRenderLoop: viewer.useDefaultRenderLoop,
    requestRenderMode: scene.requestRenderMode,
    shouldAnimate: viewer.clock.shouldAnimate,
    highDynamicRange: scene.highDynamicRange,
    enableLighting: scene.globe.enableLighting,
    showGroundAtmosphere: scene.globe.showGroundAtmosphere,
    showWaterEffect: scene.globe.showWaterEffect,
    skyAtmosphereShow: scene.skyAtmosphere?.show ?? null,
    sunShow: scene.sun?.show ?? null,
    imageryLayerCount: viewer.imageryLayers.length,
    terrainHasVertexNormals: scene.terrainProvider?.hasVertexNormals ?? null,
    lightingFadeOutDistance: scene.globe.lightingFadeOutDistance,
    lightingFadeInDistance: scene.globe.lightingFadeInDistance,
  };
  const pinFailures = [];
  if (out.pins.useDefaultRenderLoop !== false) {
    pinFailures.push("useDefaultRenderLoop did not take");
  }
  if (out.pins.requestRenderMode !== false) {
    pinFailures.push("requestRenderMode did not take");
  }
  if (out.pins.enableLighting !== true) {
    pinFailures.push("globe.enableLighting did not take");
  }
  if (out.pins.imageryLayerCount !== 2) {
    pinFailures.push(
      `expected exactly 2 synthetic imagery layers, have ${out.pins.imageryLayerCount}`,
    );
  }
  if (out.pins.terrainHasVertexNormals !== false) {
    pinFailures.push(
      "the terrain provider reports vertex normals; the (c) premise assumes it does not",
    );
  }
  if (pinFailures.length > 0) {
    return { ...out, structuralError: pinFailures.join("; ") };
  }

  let pinnedTime = C.JulianDate.fromIso8601(equinoxIso);
  const T = () => pinnedTime;

  // SAME-TASK CAPTURE. The canonical source is checked byte-for-byte by
  // daynight-terminator-law.spec.mjs. Never place a GPU-canvas read after a
  // browser-task yield: WebGL can clear it and WebGPU can invalidate it.
  // ==BEGIN same-task-capture==
  const makeSameTaskCapture = (scene, canvas, timeFn) => {
    const renderNow = () => scene.render(timeFn());
    const tmp = document.createElement("canvas");
    const ctx = tmp.getContext("2d", { willReadFrequently: true });
    const decodeSnapshot = async (snapshot) => {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        const decodeFailed = "same-task PNG decode failed";
        image.onload = resolve;
        image.onerror = () => reject(new Error(decodeFailed));
      });
      image.src = snapshot;
      await loaded;
      tmp.width = image.naturalWidth;
      tmp.height = image.naturalHeight;
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, tmp.width, tmp.height);
    };
    const snapshotNow = () => {
      renderNow();
      return canvas.toDataURL("image/png");
    };
    const captureNow = () => {
      const snapshot = snapshotNow();
      return decodeSnapshot(snapshot);
    };
    const grabNow = snapshotNow;
    const settleThen = async (maxFrames, done, capture) => {
      let settled = false;
      for (let k = 0; k < maxFrames; k++) {
        if (typeof done === "function" && done() === true) {
          settled = true;
          break;
        }
        renderNow();
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (!settled && typeof done === "function") {
        settled = done() === true;
      }
      const hasCapture = typeof capture === "function";
      const result = hasCapture ? await capture() : undefined;
      return { settled, result };
    };
    return { renderNow, captureNow, grabNow, settleThen };
  };
  // ==END same-task-capture==

  const { renderNow, captureNow, grabNow } = makeSameTaskCapture(
    scene,
    canvas,
    T,
  );

  // P6 SETTLE — a wall-clock budget with a readiness predicate. The yield is
  // `setTimeout`, not rAF: with the widget render loop off, rAF delivery is at
  // the compositor's discretion and a starved rAF would silently shorten the
  // budget into the under-settle it exists to prevent.
  const settle = async (budgetMs, minFrames) => {
    const start = performance.now();
    let frames = 0;
    let ready = false;
    while (performance.now() - start < budgetMs || frames < minFrames) {
      renderNow();
      frames += 1;
      ready = scene.globe.tilesLoaded === true;
      await new Promise((r) => setTimeout(r, 8));
    }
    return { frames, ready, elapsedMs: performance.now() - start };
  };

  const luminance = (data, i) =>
    0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

  /**
   * Build the sample geometry for the CURRENT camera + instant.
   *
   * N.L is computed on the CPU from the same quantities the shaders use:
   * the ellipsoid intersection of the pixel's ray, the GEOCENTRIC normal
   * `normalize(positionWC)` (which is what `czm_geodeticSurfaceNormal(p,
   * vec3(0), vec3(1))` reduces to — NOT the true geodetic normal), and
   * `uniformState.lightDirectionWC` (the scene light, which is what
   * `czm_lightDirectionEC` carries; the view rotation is orthonormal so the
   * eye-space dot equals the world-space dot).
   */
  const buildGeometry = () => {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const ellipsoid = scene.globe.ellipsoid ?? C.Ellipsoid.WGS84;
    const light = scene.context.uniformState.lightDirectionWC;
    const sun = scene.context.uniformState.sunDirectionWC;
    const samples = [];
    const y0 = Math.round(height * 0.2);
    const y1 = Math.round(height * 0.8);
    const scratch = new C.Cartesian2();
    for (let r = 0; r < rowCount; r++) {
      const y = Math.round(y0 + ((y1 - y0) * r) / Math.max(1, rowCount - 1));
      for (let x = 0; x < width; x += columnStep) {
        scratch.x = x;
        scratch.y = y;
        const p = scene.camera.pickEllipsoid(scratch, ellipsoid);
        if (!p) {
          continue;
        }
        const len = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
        if (!(len > 0)) {
          continue;
        }
        const ndotl = (p.x * light.x + p.y * light.y + p.z * light.z) / len;
        samples.push({ x, y, ndotl });
      }
    }
    return {
      width,
      height,
      lightDirectionWC: { x: light.x, y: light.y, z: light.z },
      sunDirectionWC: { x: sun.x, y: sun.y, z: sun.z },
      samples,
    };
  };

  const readSamples = (image, geometry) => {
    const values = new Array(geometry.samples.length);
    // Device pixel ratio: the decoded PNG is the BACKING store, the geometry is
    // in CSS pixels. Scale rather than assume 1:1 — a HiDPI harness would
    // otherwise sample a shifted column and quietly mis-attribute the ramp.
    const sx = image.width / geometry.width;
    const sy = image.height / geometry.height;
    for (let k = 0; k < geometry.samples.length; k++) {
      const s = geometry.samples[k];
      const px = Math.min(image.width - 1, Math.round(s.x * sx));
      const py = Math.min(image.height - 1, Math.round(s.y * sy));
      values[k] = luminance(image.data, (py * image.width + px) * 4);
    }
    return values;
  };

  const setLayerAlphas = (dayAlpha, nightAlpha) => {
    overlayLayer.dayAlpha = dayAlpha;
    overlayLayer.nightAlpha = nightAlpha;
    // The base must never carry a ramp of its own.
    baseLayer.dayAlpha = 1.0;
    baseLayer.nightAlpha = 1.0;
  };

  /** Place the nadir on the geometric terminator for the pinned instant. */
  const aimAtTerminator = (altitude) => {
    const light = scene.context.uniformState.lightDirectionWC;
    const subsolarLon = Math.atan2(light.y, light.x);
    const lon = C.Math.convertLongitudeRange(subsolarLon + Math.PI / 2);
    scene.camera.setView({
      destination: C.Cartesian3.fromRadians(lon, 0.0, altitude),
      orientation: {
        heading: 0.0,
        pitch: -C.Math.PI_OVER_TWO,
        roll: 0.0,
      },
    });
    return { subsolarLonDeg: C.Math.toDegrees(subsolarLon) };
  };

  const runConfig = async (name, { iso, altitude, legs }) => {
    pinnedTime = C.JulianDate.fromIso8601(iso);
    // One priming render so `uniformState` carries THIS instant's light before
    // the camera is aimed from it.
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(0.0, 0.0, altitude),
      orientation: { heading: 0.0, pitch: -C.Math.PI_OVER_TWO, roll: 0.0 },
    });
    renderNow();
    const aim = aimAtTerminator(altitude);
    const settled = await settle(settleBudgetMs, settleMinFrames);
    const geometry = buildGeometry();
    const config = {
      iso,
      altitude,
      cameraDistance: altitude + 6378137.0,
      subsolarLonDeg: aim.subsolarLonDeg,
      settled,
      lightDirectionWC: geometry.lightDirectionWC,
      sunDirectionWC: geometry.sunDirectionWC,
      sampleCount: geometry.samples.length,
      ndotl: geometry.samples.map((s) => s.ndotl),
      legs: {},
      png: null,
    };
    if (geometry.samples.length < 500) {
      config.structuralError = `only ${geometry.samples.length} pixels hit the ellipsoid`;
      out.configs[name] = config;
      return;
    }
    let first = true;
    for (const leg of legs) {
      leg.apply();
      await settle(first ? settleBudgetMs : relegBudgetMs, first ? 8 : 4);
      first = false;
      const image = await captureNow();
      config.legs[leg.name] = readSamples(image, geometry);
      if (leg.png) {
        config.png = grabNow();
      }
    }
    out.configs[name] = config;
  };

  const ladderLegs = (withPng) =>
    ladderAlphas.map((alpha, index) => ({
      name: `ladder:${alpha}`,
      png: withPng && index === ladderAlphas.length - 1,
      apply: () => {
        scene.globe.enableNightLights = true;
        scene.globe.nightIntensity = 2.5;
        setLayerAlphas(alpha, alpha);
      },
    }));

  const measureLeg = {
    name: "measure",
    png: true,
    apply: () => {
      scene.globe.enableNightLights = true;
      scene.globe.nightIntensity = 2.5;
      // dayAlpha 1 / nightAlpha 0 makes the composited alpha EXACTLY the day
      // fade on both backends, and keeps `isNightLayer = step(dayAlpha + 0.01,
      // nightAlpha)` closed so the night-lights emission cannot contaminate
      // the ramp measurement.
      setLayerAlphas(1.0, 0.0);
    },
  };

  await runConfig("equinox-low", {
    iso: equinoxIso,
    altitude: lowAltitude,
    legs: [...ladderLegs(false), measureLeg],
  });
  await runConfig("equinox-high", {
    iso: equinoxIso,
    altitude: highAltitude,
    legs: [
      {
        name: "ladder:0",
        png: true,
        apply: () => {
          scene.globe.enableNightLights = true;
          scene.globe.nightIntensity = 2.5;
          setLayerAlphas(0.0, 0.0);
        },
      },
    ],
  });
  await runConfig("solstice-low", {
    iso: solsticeIso,
    altitude: lowAltitude,
    legs: [...ladderLegs(false), measureLeg],
  });
  await runConfig("nightlights", {
    iso: equinoxIso,
    altitude: lowAltitude,
    legs: [
      {
        name: "on",
        png: true,
        apply: () => {
          scene.globe.enableNightLights = true;
          scene.globe.nightIntensity = 2.5;
          setLayerAlphas(0.0, 1.0);
        },
      },
      {
        name: "off",
        png: false,
        apply: () => {
          scene.globe.enableNightLights = false;
          scene.globe.nightIntensity = 2.5;
          setLayerAlphas(0.0, 1.0);
        },
      },
      {
        name: "boosted",
        png: false,
        apply: () => {
          scene.globe.enableNightLights = true;
          scene.globe.nightIntensity = 5.0;
          setLayerAlphas(0.0, 1.0);
        },
      },
    ],
  });

  return out;
};

// ─── Node-side reduction ─────────────────────────────────────────────────────

/**
 * Turn one config's ladder + measurement legs into binned (N.L, dayFade) data.
 *
 * Per pixel: build its ladder, health-check it, invert the measurement value
 * through it. Pixels whose ladder cannot resolve alpha are dropped and counted
 * — a dropped-pixel census is what makes "the bin is thin" visible instead of
 * silently widening the error bars.
 */
function reduceRamp(config, ladderAlphas) {
  const n = config.sampleCount;
  const ladders = ladderAlphas.map((a) => config.legs[`ladder:${a}`]);
  const measured = config.legs.measure;
  if (!measured || ladders.some((l) => !l)) {
    return { error: "a ladder or measurement leg is missing" };
  }
  const samples = [];
  const spans = [];
  let dropped = 0;
  const dropReasons = new Map();
  for (let k = 0; k < n; k++) {
    const ladder = ladderAlphas.map((alpha, i) => ({
      alpha,
      value: ladders[i][k],
    }));
    const health = calibrationHealth(ladder, {
      minSpan: MIN_CALIBRATION_SPAN,
      noise: 1,
    });
    if (!health.ok) {
      dropped += 1;
      dropReasons.set(health.reason, (dropReasons.get(health.reason) ?? 0) + 1);
      continue;
    }
    spans.push(health.span);
    const alpha = invertCalibration(ladder, measured[k]);
    if (alpha === null) {
      dropped += 1;
      dropReasons.set(
        "flat bracket",
        (dropReasons.get("flat bracket") ?? 0) + 1,
      );
      continue;
    }
    samples.push({ ndotl: config.ndotl[k], alpha });
  }
  spans.sort((a, b) => a - b);
  const bins = binByNdotL(samples, {
    min: FIT_WINDOW.min,
    max: FIT_WINDOW.max,
    binWidth: 0.02,
    minCount: 8,
  });
  const scored = bins.filter(
    (b) => b.ndotl >= DIVERGENCE_BAND.min && b.ndotl <= DIVERGENCE_BAND.max,
  );
  const alphas = bins.map((b) => b.alpha);
  const range =
    alphas.length > 0 ? Math.max(...alphas) - Math.min(...alphas) : null;
  const rmseGlsl = rmseAgainst(scored, dayFadeGlsl);
  const rmseWgsl = rmseAgainst(scored, dayFadeWgsl);
  const slope = centralSlope(bins);
  const classification = classifyRamp({
    bins: scored,
    rmseGlsl,
    rmseWgsl,
    slope,
    range,
  });
  return {
    usable: samples.length,
    dropped,
    dropReasons: [...dropReasons.entries()].map(([reason, count]) => ({
      reason,
      count,
    })),
    medianCalibrationSpan:
      spans.length > 0 ? spans[Math.floor(spans.length / 2)] : null,
    bins,
    scoredBinCount: scored.length,
    range,
    slope,
    rmseGlsl,
    rmseWgsl,
    atTerminator: alphaAtTerminator(bins),
    classification,
  };
}

/** Night-side / day-side mean of one leg, used for lane D. */
function nightDayRatio(config, legName) {
  const values = config.legs[legName];
  if (!values) {
    return { ratio: NaN, nightCount: 0, dayCount: 0 };
  }
  let nightSum = 0;
  let nightCount = 0;
  let daySum = 0;
  let dayCount = 0;
  for (let k = 0; k < values.length; k++) {
    const ndotl = config.ndotl[k];
    // Both bands sit OUTSIDE both laws' ramps (GLSL saturates at 0.2, WGSL at
    // 0.1 / -0.1), so the imagery alpha is pinned and only the LIGHTING term
    // can move the reading.
    if (ndotl <= -0.12) {
      nightSum += values[k];
      nightCount += 1;
    } else if (ndotl >= 0.21) {
      daySum += values[k];
      dayCount += 1;
    }
  }
  if (nightCount < 50 || dayCount < 50) {
    return { ratio: NaN, nightCount, dayCount };
  }
  return {
    ratio: nightSum / nightCount / (daySum / dayCount),
    nightMean: nightSum / nightCount,
    dayMean: daySum / dayCount,
    nightCount,
    dayCount,
  };
}

/** Night-side mean of a night-lights leg, used for lane B. */
function nightMean(config, legName) {
  const values = config.legs[legName];
  if (!values) {
    return NaN;
  }
  let sum = 0;
  let count = 0;
  for (let k = 0; k < values.length; k++) {
    if (config.ndotl[k] <= -0.12) {
      sum += values[k];
      count += 1;
    }
  }
  return count < 50 ? NaN : sum / count;
}

/**
 * Lane C — the vertex-normal gating split, decided from source.
 *
 * The RENDER half needs a terrain provider that reports
 * `hasVertexNormals === true`, and every provider this fork can stand up
 * offline (`EllipsoidTerrainProvider`, `CustomHeightmapTerrainProvider`,
 * `ArcGISTiledElevationTerrainProvider`) returns `false` — only
 * `CesiumTerrainProvider` with `requestVertexNormals: true` can, and that is an
 * Ion/network dependency. So this lane is reported STRUCTURAL with the missing
 * dependency named, never silently skipped, and the STATIC half is decided here
 * so the finding is not left entirely unverified.
 */
function evaluateVertexNormalLane() {
  const read = (rel) =>
    fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
  const shaderSet = read(
    "packages/engine/Source/Scene/GlobeSurfaceShaderSet.js",
  );
  const glsl = read("packages/engine/Source/Shaders/GlobeFS.glsl");
  const wgsl = read(
    "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
  );
  const failures = [];
  const metrics = {};

  // WebGL: ENABLE_DAYNIGHT_SHADING is emitted only when lighting is on AND the
  // terrain has NO vertex normals; vertex-normal terrain gets
  // ENABLE_VERTEX_LIGHTING instead.
  const emission =
    /if\s*\(\s*enableLighting\s*\)\s*\{\s*if\s*\(\s*hasVertexNormals\s*\)\s*\{[\s\S]{0,240}?ENABLE_VERTEX_LIGHTING[\s\S]{0,240}?\}\s*else\s*\{[\s\S]{0,240}?ENABLE_DAYNIGHT_SHADING/;
  metrics.webgl_definesAreMutuallyExclusive = emission.test(shaderSet);
  if (!metrics.webgl_definesAreMutuallyExclusive) {
    failures.push(
      "GlobeSurfaceShaderSet no longer emits ENABLE_VERTEX_LIGHTING and " +
        "ENABLE_DAYNIGHT_SHADING as mutually exclusive arms — the (c) premise " +
        "is stated against that rule",
    );
  }
  // WebGL: the day/night imagery alpha multiply is guarded by BOTH defines.
  const guard =
    /#if\s+defined\(APPLY_DAY_NIGHT_ALPHA\)\s*&&\s*defined\(ENABLE_DAYNIGHT_SHADING\)/g;
  metrics.webgl_alphaGuardSites = (glsl.match(guard) ?? []).length;
  if (metrics.webgl_alphaGuardSites < 2) {
    failures.push(
      `expected the GLSL day/night alpha to be double-guarded at both the ` +
        `nightBlend definition and the sampleAndBlend multiply, found ` +
        `${metrics.webgl_alphaGuardSites} guard sites`,
    );
  }
  // WebGPU: the alpha ramp is applied unconditionally in `applyImageryLayer`
  // and the only gate upstream is `camera.enableLighting`.
  metrics.webgpu_alphaIsUnconditional =
    /let dayNightAlphaValue = mix\(dayNightAlpha\.y, dayNightAlpha\.x, dayFade\);/.test(
      wgsl,
    );
  metrics.webgpu_dayFadeGate =
    /if \(camera\.enableLighting > 0\.5\) \{\s*\n\s*dayFade = computeDayNightFade/.test(
      wgsl,
    );
  if (!metrics.webgpu_alphaIsUnconditional || !metrics.webgpu_dayFadeGate) {
    failures.push(
      "the WGSL day/night alpha path no longer has the shape the (c) premise " +
        "describes (unconditional mix, gated only on camera.enableLighting)",
    );
  }
  metrics.webgpu_hasVertexNormalGateOnAlpha =
    /dayNightAlphaValue[\s\S]{0,200}camera\.lighting\.z/.test(wgsl);
  if (metrics.webgpu_hasVertexNormalGateOnAlpha) {
    failures.push(
      "WGSL now gates the day/night alpha on the vertex-normal flag — finding " +
        "(c) would be resolved, which this probe must not report as confirmed " +
        "without saying so",
    );
  }

  return {
    status: LANE.STRUCTURAL,
    failures: failures.concat([
      "RENDER half UNAVAILABLE OFFLINE: confirming the split at pixels needs a " +
        "terrain provider with hasVertexNormals === true. Every provider this " +
        "fork can stand up without Ion returns false (EllipsoidTerrainProvider" +
        ":154, CustomHeightmapTerrainProvider:216, " +
        "ArcGISTiledElevationTerrainProvider:425); only CesiumTerrainProvider " +
        "with requestVertexNormals: true can, and that is a network/Ion " +
        "dependency. Lane C is therefore exit-3 by construction on an offline " +
        "run — it is reported, not skipped.",
    ]),
    metrics,
  };
}

// ─── driver ──────────────────────────────────────────────────────────────────

async function runBackend(browser, renderer) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e)));
  page.on("console", (m) => {
    if (m.type() === "error") {
      consoleErrors.push(m.text());
    }
  });
  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60_000 });
  await page.evaluate(() => {
    window.__probeDeviceErrors = [];
    const device = window.viewer?.scene?.context?._device;
    if (device) {
      device.onuncapturederror = (ev) =>
        window.__probeDeviceErrors.push(String(ev?.error?.message ?? ""));
    }
  });

  const result = await page.evaluate(MEASURE, {
    equinoxIso: EQUINOX_ISO,
    solsticeIso: SOLSTICE_ISO,
    lowAltitude: LOW_ALTITUDE_M,
    highAltitude: HIGH_ALTITUDE_M,
    ladderAlphas: LADDER_ALPHAS,
    columnStep: COLUMN_STEP_PX,
    rowCount: ROW_COUNT,
    settleBudgetMs: SETTLE_BUDGET_MS,
    settleMinFrames: SETTLE_MIN_FRAMES,
    relegBudgetMs: RELEG_BUDGET_MS,
    baseDataUrl: solidPngDataUrl(...BASE_RGB),
    overlayDataUrl: solidPngDataUrl(...OVERLAY_RGB),
  });

  result.deviceErrors = await page.evaluate(
    () => window.__probeDeviceErrors ?? [],
  );
  result.pageErrors = pageErrors;
  result.consoleErrors = consoleErrors;

  for (const [name, config] of Object.entries(result.configs ?? {})) {
    if (config?.png) {
      const base64 = String(config.png).split(",")[1] ?? "";
      fs.writeFileSync(
        path.join(OUT_DIR, `daynight-law-${renderer}-${name}.png`),
        Buffer.from(base64, "base64"),
      );
      config.png = null;
    }
  }
  await context.close();
  return result;
}

function printBins(title, ramp) {
  console.log(`\n  ${title}`);
  if (!ramp || ramp.error) {
    console.log(`    (no data: ${ramp?.error ?? "missing"})`);
    return;
  }
  console.log(
    `    usable ${ramp.usable} / dropped ${ramp.dropped}` +
      ` / median calibration span ${r3(ramp.medianCalibrationSpan)} counts`,
  );
  for (const reason of ramp.dropReasons) {
    console.log(`      dropped: ${reason.count} x ${reason.reason}`);
  }
  console.log(
    "      N.L      n   measured   glslLaw   wgslLaw   dGLSL    dWGSL",
  );
  for (const b of ramp.bins) {
    const g = dayFadeGlsl(b.ndotl);
    const w = dayFadeWgsl(b.ndotl);
    const inBand =
      b.ndotl >= DIVERGENCE_BAND.min && b.ndotl <= DIVERGENCE_BAND.max;
    console.log(
      `    ${inBand ? "*" : " "} ${b.ndotl.toFixed(3).padStart(6)} ${String(b.count).padStart(5)}` +
        `   ${b.alpha.toFixed(4).padStart(7)}   ${g.toFixed(4)}   ${w.toFixed(4)}` +
        `  ${(b.alpha - g).toFixed(4).padStart(7)}  ${(b.alpha - w).toFixed(4).padStart(7)}`,
    );
  }
  console.log(
    `    range ${r3(ramp.range)}  centralSlope ${r3(ramp.slope)}` +
      `  rmse(glsl) ${r3(ramp.rmseGlsl)}  rmse(wgsl) ${r3(ramp.rmseWgsl)}`,
  );
  console.log(
    `    at terminator: ${r3(ramp.atTerminator)}   shape: ${ramp.classification.verdict}`,
  );
  console.log(`    why: ${ramp.classification.why}`);
}

async function main() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: !HEADED,
    args: ["--enable-unsafe-webgpu"],
  });
  let webgl;
  let webgpu;
  try {
    webgl = await runBackend(browser, "webgl");
    webgpu = await runBackend(browser, "webgpu");
  } finally {
    await browser.close();
  }

  const backends = { webgl, webgpu };
  const report = { base: BASE, viewport: VIEWPORT, backends: {}, lanes: {} };

  for (const [name, result] of Object.entries(backends)) {
    if (!result || result.structuralError) {
      console.error(
        `[${name}] STRUCTURAL: ${result?.structuralError ?? "no result"}`,
      );
    }
    report.backends[name] = {
      rendererType: result?.rendererType ?? null,
      structuralError: result?.structuralError ?? null,
      pins: result?.pins ?? null,
      deviceErrors: result?.deviceErrors ?? [],
      pageErrors: result?.pageErrors ?? [],
    };
  }

  console.log("=== CLT-B1 — day/night terminator LAW ===");
  console.log(`  base: ${BASE}`);
  for (const [name, result] of Object.entries(backends)) {
    console.log(
      `  ${name}: rendererType=${result?.rendererType ?? "?"} ` +
        `pageErrors=${result?.pageErrors?.length ?? "?"} ` +
        `deviceErrors=${result?.deviceErrors?.length ?? "?"}`,
    );
    const pins = result?.pins;
    if (pins) {
      console.log(
        `    pins: lighting=${pins.enableLighting} layers=${pins.imageryLayerCount} ` +
          `vertexNormals=${pins.terrainHasVertexNormals} ` +
          `fadeOut=${r3(pins.lightingFadeOutDistance)} fadeIn=${r3(pins.lightingFadeInDistance)}`,
      );
    }
  }

  const missing = Object.entries(backends).filter(
    ([, r]) => !r || r.structuralError,
  );
  if (missing.length > 0) {
    report.lanes = { setup: { status: LANE.STRUCTURAL } };
    fs.writeFileSync(
      path.join(OUT_DIR, "daynight-terminator-law-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.error("\n  A backend lane did not produce a scene — exit 2.");
    process.exit(EXIT_CODE.ERROR);
  }

  // P4 FADE REGIME — assert, do not assume.
  const fadeRegime = [];
  for (const [name, result] of Object.entries(backends)) {
    const out = result.pins.lightingFadeOutDistance;
    const inn = result.pins.lightingFadeInDistance;
    const low = result.configs["equinox-low"]?.cameraDistance;
    const high = result.configs["equinox-high"]?.cameraDistance;
    if (!(low < out)) {
      fadeRegime.push(
        `${name}: low camera distance ${r3(low)} is not inside the fade=0 ` +
          `regime (fadeOut ${r3(out)})`,
      );
    }
    if (!(high > inn)) {
      fadeRegime.push(
        `${name}: high camera distance ${r3(high)} is not inside the fade=1 ` +
          `regime (fadeIn ${r3(inn)})`,
      );
    }
  }

  const ramps = {};
  for (const [name, result] of Object.entries(backends)) {
    ramps[name] = {
      equinox: reduceRamp(result.configs["equinox-low"], LADDER_ALPHAS),
      solstice: reduceRamp(result.configs["solstice-low"], LADDER_ALPHAS),
    };
    printBins(
      `LANE A — ${name} @ equinox, ${LOW_ALTITUDE_M / 1000} km`,
      ramps[name].equinox,
    );
    printBins(
      `LANE E — ${name} @ solstice, ${LOW_ALTITUDE_M / 1000} km`,
      ramps[name].solstice,
    );
  }

  const laneA = evaluateRampLane({
    webgl: ramps.webgl.equinox,
    webgpu: ramps.webgpu.equinox,
  });
  const laneE = evaluateSolsticeLane({
    webglRange: ramps.webgl.solstice?.range ?? NaN,
    webgpuRange: ramps.webgpu.solstice?.range ?? NaN,
  });

  const sentinel = {};
  for (const [name, result] of Object.entries(backends)) {
    const cfg = result.configs.nightlights;
    sentinel[name] = {
      on: nightMean(cfg, "on"),
      off: nightMean(cfg, "off"),
      boosted: nightMean(cfg, "boosted"),
    };
  }
  const laneB = evaluateSentinelLane(sentinel.webgpu);
  console.log(
    "\n  LANE B — nightIntensity sentinel (night-side mean, 8-bit counts)",
  );
  console.log(
    "    backend   on(2.5)    off      boosted(5.0)   off-on   boost-on",
  );
  for (const [name, s] of Object.entries(sentinel)) {
    console.log(
      `    ${name.padEnd(8)} ${r3(s.on)}\t${r3(s.off)}\t${r3(s.boosted)}\t` +
        `${r3(s.off - s.on)}\t${r3(s.boosted - s.on)}`,
    );
  }
  console.log(
    "    (WebGL is the reference leg: it has no night-lights emission path at " +
      "all, so all three of its numbers are expected to be equal — that " +
      "equality is the WebGPU-only scope of the toggle, not a second bug.)",
  );

  const fade = {};
  for (const [name, result] of Object.entries(backends)) {
    fade[name] = {
      low: nightDayRatio(result.configs["equinox-low"], `ladder:0`),
      high: nightDayRatio(result.configs["equinox-high"], `ladder:0`),
    };
  }
  const laneD = evaluateCameraFadeLane({
    webglLow: fade.webgl.low.ratio,
    webglHigh: fade.webgl.high.ratio,
    webgpuLow: fade.webgpu.low.ratio,
    webgpuHigh: fade.webgpu.high.ratio,
    rampVerdictWebgpu: ramps.webgpu.equinox?.classification?.verdict,
  });
  console.log(
    "\n  LANE D — camera-distance lighting fade (night/day luminance ratio)",
  );
  console.log("    backend   low(fade=0)   high(fade=1)   nNight/nDay(low)");
  for (const [name, f] of Object.entries(fade)) {
    console.log(
      `    ${name.padEnd(8)} ${r3(f.low.ratio)}\t${r3(f.high.ratio)}\t` +
        `${f.low.nightCount}/${f.low.dayCount}`,
    );
  }

  const laneC = evaluateVertexNormalLane();
  console.log("\n  LANE C — vertex-normal gating split (static half)");
  for (const [key, value] of Object.entries(laneC.metrics)) {
    console.log(`    ${key}: ${value}`);
  }

  const lanes = { laneA, laneB, laneC, laneD, laneE };
  if (fadeRegime.length > 0) {
    lanes.fadeRegime = { status: LANE.STRUCTURAL, failures: fadeRegime };
  }
  report.lanes = lanes;
  report.ramps = ramps;
  report.sentinel = sentinel;
  report.fade = fade;

  console.log("\n  === VERDICTS (each predicate named) ===");
  for (const [name, lane] of Object.entries(lanes)) {
    console.log(`    ${name}: ${lane.status}`);
    for (const failure of lane.failures ?? []) {
      console.log(`      - ${failure}`);
    }
  }

  const exitCode = foldVerdict(lanes);
  fs.writeFileSync(
    path.join(OUT_DIR, "daynight-terminator-law-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `\n  Report: Tools/visual-regression/output/daynight-terminator-law-report.json`,
  );
  console.log(
    `  Exit ${exitCode} (${
      {
        [EXIT_CODE.PASS]: "PASS — every recorded finding confirmed at pixels",
        [EXIT_CODE.FAIL]: "FAIL — a recorded finding is REFUTED at this build",
        [EXIT_CODE.ERROR]: "ERROR — a lane did not run",
        [EXIT_CODE.STRUCTURAL]:
          "STRUCTURAL — a lane could not see its subject. Offline runs cannot " +
          "exceed this because lane C needs vertex-normal terrain.",
      }[exitCode]
    })`,
  );
  process.exit(exitCode);
}

main().catch((error) => {
  console.error("[probe-daynight-terminator-law] unhandled:", error);
  process.exit(EXIT_CODE.ERROR);
});
