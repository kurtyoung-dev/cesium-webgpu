#!/usr/bin/env node
// probe-globe-polar-stretch.mjs — GLOBE-POLAR-STRETCH acceptance probe.
// @purpose Acceptance for the Mercator-reprojection double-flip fix: ice-centroid/area/shift metrics + mismatch at mid/far/extreme zooms, WebGL vs WebGPU
// @status ACTIVE
//
// USER-REPORTED (2026-07-02): the zoomed-out WebGPU globe stretched high
// latitudes toward the equator — worse the further out. Root cause: the
// WGSL Mercator→geographic reprojection (`ReprojectWebMercator.wgsl`)
// carried a spurious double vertical flip (`v_geo = 1-y` + `srcV =
// 1-mercatorFraction`) that cancels only for imagery tiles symmetric
// about the equator. Far-zoom terrain tiles (level 0-2, spanning past
// ±85°) all sample the REPROJECTED texture (`useWebMercatorT=false`), so
// the whole disc showed latitude-mirror-warped imagery. Mid zoom binds
// the raw Mercator texture (`useWebMercatorT=true` path) and was always
// clean — which is why the bug was zoom-gated.
//
// THREE views, WebGL vs WebGPU (default CesiumViewer = Bing Mercator
// imagery over CesiumTerrainProvider):
//   mid     (-95, 40, 2e6 m)    — regression guard; was already at parity
//   far     (-95, 40, 25e6 m)   — first user screenshot (Greenland squashed)
//   extreme (-95, 40, 55e6 m)   — second user screenshot (max zoom-out)
//
// Measures, inside the consensus globe disc:
//   - plain pixel mismatch % (informational + generous ceiling)
//   - ice/white-pixel centroid Y (Greenland/arctic pack ice) in
//     disc-radius units — the latitude-band alignment metric
//   - ice pixel area ratio
//   - best vertical shift aligning the top-half land-fraction profiles
//
// PASS criteria per view (disc-relative units so all zooms compare):
//   |iceCentroidY_gl − iceCentroidY_gpu| ≤ 0.025 · discRadius
//   ice area ratio within [0.85, 1.18]
//   |bestTopHalfShift| ≤ 0.02 · discRadius
//   mismatch ≤ {mid: 0.27%, far: 1.5%, extreme: 1.5%}
//     (limits tightened by GLOBE-POLAR-STRETCH-POLISH: the tile-seam grid
//     lines — 62% of the mid residual — were fixed by the fragment-entry UV
//     clamp, and the missing zoomed-out ocean sun glint — 63% of the far
//     residual — by the czm_getSpecular Phong port. Pre-polish baseline was
//     mid 0.27% / far 5.46%.)
//     THEN by Q9-STARFIELD-SPACE-BUCKET: the clock is now PINNED (shared Q7
//     determinism kit) so both backend launches render the identical sky.
//     Before pinning, the two separate browser launches happened seconds
//     apart at wall-clock "now", so the star-field TEME rotation + skybox
//     cubemap orientation differed a fraction of a degree between captures —
//     speckling the whole background with >30 mismatch pixels (the "space"
//     bucket, ~42% of the far mismatch, meanΔ≈0 = purely positional). A
//     dedicated diagnostic proved the fix: cross-backend space mismatch
//     6600px→102px and within-backend WebGPU→0px once pinned. That collapsed
//     far 3.63%→0.72% / extreme 4.59%→0.58%, so the ceilings drop to 1.5%.
//     The star renderers themselves are at parity (identical WGSL/GLSL, shared
//     StarFieldMath); the 102 residual px are the low-value STARFIELD-TUNE
//     sprite-brightness item, not a divergence this probe should tolerate 3%
//     of noise to hide.
//
// GLOBE-POLAR-STRETCH-POLISH adds a BUCKET DECOMPOSITION of the residual
// mismatch per view (printed + written to report.json):
//   space     — outside the globe disc (r > 1.02): stars/background
//   limb      — 0.90 < r ≤ 1.02: atmosphere ring brightness/falloff
//   seamThin  — interior thin structures (survive no 3x3 erosion): tile-seam
//               lines + AA/subpixel edge noise
//   interiorBlobGlBrighter / interiorBlobGpuBrighter — interior ≥3x3 blobs,
//               split by which backend is brighter (imagery/lighting/ocean)
// The seam gate additionally counts seamBlue: seamThin pixels with the
// dark-blue initialColor signature (gpu darker AND bluer) — the
// BUG-GLOBE-TILE-SEAM-LINES fingerprint, required ≈ 0 after the UV clamp.
//
// The three views are the rigs `globe-polar-mid`, `globe-polar-far` and
// `globe-polar-extreme`.
//
// ON THE SHARED RUNTIME (probe-kit harvest, globe family). The browser, the
// origin (`--port`, a governed Edge port, never 8080), the served-build
// preflight, the Edge slot and the receipt belong to `lib/probe-runtime.mjs`.
// Each frame is an element capture of the scene canvas through
// `captureElement`; the CesiumViewer container is absolutely positioned at the
// page origin at 100 % x 100 % (`Apps/CesiumViewer/CesiumViewer.css`
// `.fullWindow`), so the crop below is in the same coordinates it was on the
// page screenshot. Every number is computed in Node over the decoded PNGs by
// the shared metrics — `rgbSumDiff` (`lib/metrics/rgb-sum.mjs`), the disc and
// latitude profile (`lib/metrics/globe-disc.mjs`) and the bucket decomposition
// with the seam fingerprint (`lib/metrics/mismatch-buckets.mjs`) — instead of
// in a second browser, and `metrics-globe-extraction.spec.mjs` holds them,
// bucket mask included, to the in-page original. The per-view report is in
// the runtime receipt (`globe-polar-stretch-report.json`), where `report.json`
// used to be written by hand.
//
// THE CHROME IS STRIPPED BEFORE EVERY FRAME. The pixel mismatch and the bucket
// decomposition count only inside `CROP`, but the latitude profile reads 93 %
// of a circle about the consensus disc whose radius is the box's mean
// half-extent, and that circle is not clipped to `CROP` (the pass-4 review
// measured rows 28..656 on the banked 1280x720 mid frames, 34 of them outside
// `CROP`). So the frame itself must carry no chrome: right before each capture
// the kit's `lib/strip-viewer-widgets.mjs` removes the Viewer chrome, and the
// view refuses (`capture-chrome-over-canvas`) when anything is still stacked
// over the canvas, or when the strip reports nothing. `chromeRemoved` in the
// cell records how many elements went, per view and renderer. `CROP` and the
// profile are unchanged.
//
// Usage: node Tools/visual-regression/probe-globe-polar-stretch.mjs [--port 8094]
// @runtime lib/probe-runtime.mjs

import fs from "node:fs";
import path from "node:path";

import { decodePng } from "../lib/png-decode.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { armWebGPUDevices, errorGateInit } from "../lib/webgpu-error-gate.mjs";
import {
  DET_BROWSER_SETUP,
  DETERMINISTIC_CLOCK_ISO,
} from "./lib/determinism-kit.mjs";
import {
  bestProfileShift,
  consensusDisc,
  discCentreRadius,
  latitudeProfile,
} from "./lib/metrics/globe-disc.mjs";
import {
  mismatchBuckets,
  summariseBuckets,
} from "./lib/metrics/mismatch-buckets.mjs";
import { rgbSumDiff } from "./lib/metrics/rgb-sum.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";

/**
 * The launch flags this probe always ran under — a measurement condition, so
 * they are declared to the runtime rather than dropped.
 */
const LAUNCH_ARGS = Object.freeze([
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-vulkan",
  "--disable-cache",
]);
/**
 * Crop out CesiumViewer UI chrome (toolbar, help panel, timeline). The mismatch
 * and the buckets count inside it; the latitude profile does not (header).
 */
const CROP = Object.freeze({ x0: 250, x1: 1010, y0: 45, y1: 640 });

const VIEWS = [
  // Ceilings tightened by Q9-STARFIELD-SPACE-BUCKET: the far/extreme limits
  // used to be 3.5 / 4.5 only to tolerate the unpinned-clock star jitter
  // (~1.5% of the crop, ~42% of the far mismatch). With the clock now pinned
  // both backends render the identical sky, so the deterministic residual is
  // far 0.72% / extreme 0.58% (dominated by thin disc-edge AA + the high-lat
  // ground-atmosphere blob). 1.5% leaves ~2x headroom for tile-LOD wobble
  // while still catching a regression that re-introduces the star drift.
  { name: "mid", lon: -95, lat: 40, height: 2e6, maxMismatch: 0.27 },
  { name: "far", lon: -95, lat: 40, height: 25e6, maxMismatch: 1.5 },
  { name: "extreme", lon: -95, lat: 40, height: 55e6, maxMismatch: 1.5 },
];
const MAX_CENTROID_SHIFT = 0.025; // disc-radius units
const MAX_PROFILE_SHIFT = 0.02; // disc-radius units
const ICE_RATIO_RANGE = [0.85, 1.18];

/**
 * One view on one backend: a fresh browser context (the original launched a
 * fresh browser per capture), the pinned-clock settle, and one element capture.
 */
async function capture({
  browser,
  origin,
  renderer,
  view,
  run,
  outputDirectory,
  captures,
}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  try {
    return await captureInContext(context, {
      origin,
      renderer,
      view,
      run,
      outputDirectory,
      captures,
    });
  } finally {
    await context.close();
  }
}

async function captureInContext(
  context,
  { origin, renderer, view, run, outputDirectory, captures },
) {
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript(errorGateInit);
  await page.goto(
    `${origin}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
    {
      waitUntil: "networkidle",
    },
  );
  await page.waitForFunction(() => !!window.viewer);
  await armWebGPUDevices(page);
  await page.evaluate(
    async ({ lon, lat, height, det, iso }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      // DETERMINISM (Q9-STARFIELD-SPACE-BUCKET / NEW-STARFIELD-SPACE-BUCKET-
      // RESIDUAL): the CesiumViewer clock starts at wall-clock "now", so the
      // star-field TEME rotation + skybox cubemap orientation differ between
      // the two SEPARATE browser launches (webgl vs webgpu) that this probe
      // fires seconds apart. That rotated the whole celestial sphere a
      // fraction of a degree between captures, speckling the entire background
      // with >30 mismatch pixels — the "space" bucket residual (was ~42% of
      // the far-view mismatch, meanΔ≈0 = positional, NOT a brightness bias).
      // Pinning the clock to a fixed epoch renders the identical sky on both
      // backends; the diagnostic measured the cross-backend space bucket
      // collapse from 6600px to 102px (and within-backend WebGPU to 0px),
      // proving the star renderers are at parity and the residual was probe
      // nondeterminism. Uses the shared Q7 determinism kit.
      // eslint-disable-next-line no-new-func
      new Function(det)();
      window.__det.pinClock(C, v, v.scene, iso);
      v.scene.screenSpaceCameraController.enableInputs = false;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, height),
        orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
      });
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 240) break;
      }
    },
    { ...view, det: DET_BROWSER_SETUP, iso: DETERMINISTIC_CLOCK_ISO },
  );
  await page.waitForTimeout(2000);
  // Header: the chrome comes off right before the frame, or the view refuses.
  // A strip that reports nothing is not a clean canvas either.
  const chrome = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
  if (!Array.isArray(chrome?.leftovers) || chrome.leftovers.length > 0) {
    throw new ProbeRefusal(
      "capture-chrome-over-canvas",
      `${view.name} (${renderer}): after the CesiumViewer chrome was ` +
        "stripped, elements were still stacked over the scene canvas " +
        `(${chrome?.leftovers?.join(", ") ?? "no strip report"}), ` +
        "so an element capture would measure them with the scene",
      { chrome: chrome ?? null, view: view.name, renderer },
    );
  }
  const shot = await captureElement({
    page,
    selector: ".cesium-widget canvas",
    name: `${view.name}-${renderer}-run${run}`,
    outputDirectory,
    captures,
  });
  if (errs.length) {
    console.log(`  [${renderer}/${view.name}] page errors: ${errs[0]}`);
  }
  return { image: decodePng(shot.buffer), chromeRemoved: chrome.removed };
}

/**
 * The disc / latitude-band analysis + plain mismatch diff inside the crop,
 * over the decoded WebGL (`gl`) and WebGPU (`gpu`) frames, in the fields and
 * rounding the probe banked. A size mismatch returns `{error}` and the checks
 * below read its missing fields exactly as they read the in-page `{error}`.
 *
 * @returns {object} The per-view report, plus `maskRgba` / `maskWidth` /
 *   `maskHeight` for the bucket-mask PNG (removed before the report is kept).
 */
export function analyzePolar(gl, gpu) {
  if (gl.width !== gpu.width || gl.height !== gpu.height) {
    return { error: "size mismatch" };
  }
  const diff = rgbSumDiff(gl, gpu, { roi: CROP, returnMask: true });
  const disc = consensusDisc(gl, gpu, CROP);
  const pa = latitudeProfile(gl, disc);
  const pb = latitudeProfile(gpu, disc);
  const shift = bestProfileShift(pa, pb);
  const buckets = mismatchBuckets(gl, gpu, {
    crop: CROP,
    mask: diff.mask,
    disc: discCentreRadius(disc),
  });
  return {
    mismatchPct: +diff.mismatchPct.toFixed(3),
    discRadius: +pa.r.toFixed(1),
    icePxA: pa.icePx,
    icePxB: pb.icePx,
    iceCentroidYA:
      pa.iceCentroidY === null ? null : +pa.iceCentroidY.toFixed(1),
    iceCentroidYB:
      pb.iceCentroidY === null ? null : +pb.iceCentroidY.toFixed(1),
    bestShift_discUnits: +shift.shift.toFixed(3),
    buckets: summariseBuckets(buckets, {
      cropPx: diff.countedPx,
      mismatchPx: diff.mismatchPx,
    }),
    seamBluePx: buckets.seamFingerprintPx,
    maskRgba: buckets.maskRgba,
    maskWidth: buckets.maskWidth,
    maskHeight: buckets.maskHeight,
  };
}

/**
 * The five per-view checks, with the original expressions and limits:
 *   |iceCentroidY_gl − iceCentroidY_gpu| ≤ 0.025 · discRadius
 *   ice area ratio within [0.85, 1.18] (skipped when little ice is visible)
 *   |bestTopHalfShift| ≤ 0.02 · discRadius
 *   mismatch ≤ the view's ceiling
 *   seam-blue px ≤ 45 — BUG-GLOBE-TILE-SEAM-LINES: dark-blue seam-fingerprint
 *   pixels must be ~eliminated by the fragment-entry UV clamp (< 0.01% of the
 *   crop).
 *
 * Pure and exported so `globe-probe-verdicts.spec.mjs` can drive it.
 *
 * @param {Array<{run: number, report: Record<string, object>}>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluatePolar(cells) {
  const verdicts = [];
  for (const { run, report } of cells) {
    for (const view of VIEWS) {
      const res = report[view.name];
      const centroidShift =
        res.iceCentroidYA !== null && res.iceCentroidYB !== null
          ? Math.abs(res.iceCentroidYA - res.iceCentroidYB) / res.discRadius
          : 0;
      const iceRatio = res.icePxA > 200 ? res.icePxB / res.icePxA : 1; // skip when little ice visible
      const checks = [
        {
          name: "ice centroid Y shift",
          val: +centroidShift.toFixed(4),
          ok: centroidShift <= MAX_CENTROID_SHIFT,
          limit: MAX_CENTROID_SHIFT,
        },
        {
          name: "ice area ratio (gpu/gl)",
          val: +iceRatio.toFixed(3),
          ok: iceRatio >= ICE_RATIO_RANGE[0] && iceRatio <= ICE_RATIO_RANGE[1],
          limit: ICE_RATIO_RANGE.join(".."),
        },
        {
          name: "top-half profile shift",
          val: Math.abs(res.bestShift_discUnits),
          ok: Math.abs(res.bestShift_discUnits) <= MAX_PROFILE_SHIFT,
          limit: MAX_PROFILE_SHIFT,
        },
        {
          name: "pixel mismatch %",
          val: res.mismatchPct,
          ok: res.mismatchPct <= view.maxMismatch,
          limit: view.maxMismatch,
        },
        {
          name: "seam-blue px (tile-seam fingerprint)",
          val: res.seamBluePx,
          ok: res.seamBluePx <= 45,
          limit: 45,
        },
      ];
      for (const check of checks) {
        verdicts.push({
          id: `${view.name}/${check.name}/run${run}`,
          claim: `${view.name}: ${check.name}: ${check.val} (limit ${check.limit})`,
          pass: check.ok,
          detail: { value: check.val, limit: check.limit },
        });
      }
    }
  }
  return verdicts;
}

/** Print one view's bucket decomposition, as the probe always did. */
function printBuckets(viewName, res) {
  if (!res.buckets) {
    console.log(`  ${viewName}: ${res.error ?? "no analysis"}`);
    return;
  }
  console.log(
    `  ${viewName} bucket decomposition (% of mismatch | % of crop):`,
  );
  for (const [k, b] of Object.entries(res.buckets)) {
    console.log(
      `      ${k.padEnd(24)} ${String(b.pctOfMismatch).padStart(5)}% | ${b.pctOfCrop}%  meanΔ(gpu−gl)=${b.meanDelta_gpuMinusGl ? JSON.stringify(b.meanDelta_gpuMinusGl) : "-"}`,
    );
  }
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "globe-polar-stretch",
  title:
    "GLOBE-POLAR-STRETCH — Mercator-reprojection latitude alignment at mid/far/extreme zoom, WebGL vs WebGPU",
  outputSubdirectory: "globe-polar-stretch",
  // The per-view report the probe wrote as report.json is this receipt's
  // `cells[].report`; nothing outside this probe read the old file.
  receiptEnvelope: "runtime",
  launchArgs: LAUNCH_ARGS,
  // The CesiumViewer page and every in-page import here read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (
      !options.renderers.includes("webgl") ||
      !options.renderers.includes("webgpu")
    ) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "polar-stretch alignment is measured WebGL against WebGPU, so both " +
          `renderers are required (got ${options.renderers.join(",")})`,
        { renderers: options.renderers },
      );
    }
    const report = {};
    const chromeRemoved = {};
    for (const view of VIEWS) {
      console.log(
        `[polar-stretch] capturing ${view.name} (h=${view.height} m)`,
      );
      const shared = { browser, origin, view, run, outputDirectory, captures };
      const gl = await capture({ ...shared, renderer: "webgl" });
      const gpu = await capture({ ...shared, renderer: "webgpu" });
      const res = analyzePolar(gl.image, gpu.image);
      chromeRemoved[view.name] = {
        webgl: gl.chromeRemoved,
        webgpu: gpu.chromeRemoved,
      };
      if (res.maskRgba) {
        fs.mkdirSync(outputDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(outputDirectory, `${view.name}-bucket-mask-run${run}.png`),
          encodeRgbaPng(res.maskRgba, res.maskWidth, res.maskHeight),
        );
        delete res.maskRgba;
        delete res.maskWidth;
        delete res.maskHeight;
      }
      printBuckets(view.name, res);
      report[view.name] = res;
    }
    return [{ run, report, chromeRemoved }];
  },
  verdicts(cells) {
    return evaluatePolar(cells);
  },
  receipt(cells, context) {
    for (const verdict of context.verdicts) {
      console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
    }
    return { cells, verdicts: context.verdicts };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
