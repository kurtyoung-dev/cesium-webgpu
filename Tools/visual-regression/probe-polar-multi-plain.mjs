#!/usr/bin/env node
// Like probe-polar-multi-angle but WITHOUT the DebugTileImageryProvider
// overlay. Gives a clean measure of imagery-only diffs at each polar
// view. The debug overlay adds tile-grid lines that don't align perfectly
// between backends and inflate the pixel-diff number.
// @purpose Standing polar imagery parity on the shared runtime: the six polar-plain rigs (or any polar rig named with --rigs) captured on both renderers and scored in Node under both banked channel-sum rules
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// CLOCK PINNING (Batch 70+) — Both backends are captured with the
// Cesium clock frozen at the rig's `clock`, 2026-05-19T18:00:00Z for the
// six standing views. Without this, the clock auto-advances between
// launches and the terminator falls in different screen positions per
// capture, producing run-to-run non-determinism in the cross-backend
// diff. See WEBGPU_DEBUGGING_LOG.md Batch 69 for the bisection that
// surfaced this. Keep the six rigs' clock stable across batches so
// historical baselines remain comparable. Choice rationale for that
// instant:
//   - 18:00 UTC = noon CST → midlat-mid (lon=-100, lat=40) is at solar
//     noon, well-lit and on the day side, no terminator in view.
//   - May 19, late spring in the northern hemisphere → north pole is in
//     continuous daylight (always on the day side regardless of UTC),
//     south pole is in continuous darkness. Both poles render their
//     "stable" lighting state, no terminator sweep across either.
//   - 2026 keeps this in alignment with the migration-doc timeline.
//
// ON THE SHARED RUNTIME (probe-kit harvest, polar family). The browser, the
// origin (`--port`, a governed Edge port, never 8080), the served-build
// preflight, the Edge slot and the receipt belong to `lib/probe-runtime.mjs`.
// The six views are the rigs `polar-plain-*` (`rigs/`, tag `polar`), and
// `--rigs id,id,...` captures any other polar rig instead, so the scenes of
// the retired polar probes (the overlay views, the effects-off views, the
// wireframe, the fragment-debug modes, the cold-cache settle budgets) are
// re-captured through this file rather than a private copy of it. The page
// is set up from the rig's data: WGS84 terrain, the determinism kit's clock
// pin and tile settle, the dials, the camera. Each frame is an element
// capture of the scene canvas taken after the viewer widgets are removed
// (`lib/strip-viewer-widgets.mjs`); anything still stacked over the canvas
// refuses the capture, because the metrics are canvas-only. Parity is
// `lib/metrics/polar-parity.mjs` under both banked rules, `centre80-sum24`
// (the retired probe-polar-diff-all.mjs) and `frame-sum30` (the 2026-07-02
// figures IMAGERY_PROJECTION.md records), computed in Node from the decoded
// PNGs. There is deliberately no limit and no verdict: SHADER_PAIRS_LOCKSTEP.md
// §Validation uses no fixed percentage, so a reader compares the receipt with
// the figures on record UNDER THE SAME RULE. Two legs of different sizes
// throw, so the run fails instead of reporting a parity it never measured.
//
// What changed in the instrument, so a reader does not compare across it: the
// pre-harvest probe took a PAGE screenshot (chrome included) in a fresh
// browser per capture and pinned the clock by hand; this one captures the
// canvas element with the widgets removed, opens one browser per run with a
// fresh context per capture, and pins and settles through
// `lib/determinism-kit.mjs` (its settle renders eight more frames after the
// tiles report loaded). The banked figures were taken through the old
// instrument.
//
// Usage: node Tools/visual-regression/probe-polar-multi-plain.mjs [--port 8094] [--rigs id,id,...] [--renderer both]
// Outputs: Tools/visual-regression/output/polar-multi-plain/

import { decodePng } from "../lib/png-decode.mjs";
import { DET_BROWSER_SETUP } from "./lib/determinism-kit.mjs";
import {
  POLAR_PARITY_RULES,
  polarParity,
} from "./lib/metrics/polar-parity.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { loadRigs } from "./lib/rig-registry.mjs";
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

/** The canvas the frames are taken from: the scene canvas, never the page. */
const SCENE_CANVAS = ".cesium-widget canvas";

/** The six standing views, in the order the pre-harvest probe captured them. */
export const DEFAULT_RIG_IDS = Object.freeze([
  "polar-plain-northpole-close",
  "polar-plain-northpole-orbit",
  "polar-plain-southpole-close",
  "polar-plain-southpole-orbit",
  "polar-plain-equator-mid",
  "polar-plain-midlat-mid",
]);

/**
 * Every dial the page-side setup applies. A rig declaring any other dial is
 * refused rather than captured without it: a frame that silently ignored a
 * dial is a picture of a different scene under the rig's name.
 */
export const POLAR_DIALS = Object.freeze([
  "terrain",
  "debugTileOverlay",
  "skyAtmosphereShow",
  "globeShowGroundAtmosphere",
  "globeEnableLighting",
  "sunShow",
  "moonShow",
  "skyBoxShow",
  "fogEnabled",
  "globeShowWireframe",
  "globeBackFaceCulling",
  "globeTileCacheSize",
  "globeFragmentDebug",
]);

/**
 * The frames `settleTiles` renders after its loop (`lib/determinism-kit.mjs`,
 * `for (let k = 0; k < 8; k++)`); `polar-probe-family.spec.mjs` runs the kit's
 * own settle to hold this number to it.
 */
export const SETTLE_TRAILING_FRAMES = 8;

/**
 * The frames a settle actually rendered. `settleTiles` returns its loop
 * index: frames - 1 when it leaves settled, `maxFrames` when it runs out, and
 * neither counts the trailing frames.
 *
 * @param {number} loopIndex What `settleTiles` returned.
 * @param {number} maxFrames The `maxFrames` it was given.
 * @returns {number} The loop's frames plus the trailing frames.
 */
export function settledFrameCount(loopIndex, maxFrames) {
  return Math.min(loopIndex + 1, maxFrames) + SETTLE_TRAILING_FRAMES;
}

/**
 * Refuses a capture when the widget strip left anything stacked over the
 * scene canvas: the metrics are canvas-only, so a frame of page elements is
 * not a frame of the scene. Pure and exported so the family spec can drive it.
 *
 * @param {string} rigId The rig.
 * @param {string} renderer The renderer.
 * @param {{removed: number, leftovers: string[]}} stripped What `STRIP_WIDGETS_SOURCE` returned.
 * @returns {{removed: number, leftovers: string[]}} `stripped`, when nothing is left over.
 * @throws {ProbeRefusal} `capture-canvas-covered`.
 */
export function refuseCoveredCanvas(rigId, renderer, stripped) {
  if (stripped.leftovers.length > 0) {
    throw new ProbeRefusal(
      "capture-canvas-covered",
      `${rigId} ${renderer}: page elements still cover the scene canvas after the widgets were removed (${stripped.leftovers.join(", ")}); a frame of them is not a frame of the scene`,
      { rig: rigId, renderer, leftovers: stripped.leftovers },
    );
  }
  return stripped;
}

/**
 * Refuses a rig captured on a renderer the run's `--renderer` excludes. Pure
 * and exported so the family spec can drive it.
 *
 * @param {object} rig The rig.
 * @param {string[]} renderers The renderers the run captures.
 * @throws {ProbeRefusal} `renderer-unavailable`.
 */
export function requireRigRenderers(rig, renderers) {
  const missing = rig.renderers.filter(
    (renderer) => !renderers.includes(renderer),
  );
  if (missing.length > 0) {
    throw new ProbeRefusal(
      "renderer-unavailable",
      `rig ${rig.id} is captured on ${rig.renderers.join(" and ")}, but --renderer excludes ${missing.join(" and ")}`,
      { rig: rig.id, renderers },
    );
  }
}

/**
 * The rigs a run captures: the ids `--rigs` names (comma-separated), or the
 * six standing views. Pure and exported so `polar-probe-family.spec.mjs` can
 * drive it.
 *
 * @param {object[]} rigs The registry (`loadRigs()`).
 * @param {string|undefined} rigsOption The `--rigs` value, if any.
 * @returns {object[]} The selected rigs, in the order named.
 * @throws {TypeError} An empty list, an unknown id, or a rig outside the
 *   `polar` tag — a caller error (exit 2).
 * @throws {ProbeRefusal} `rig-dial-unsupported` for a dial this probe cannot apply.
 */
export function selectPolarRigs(rigs, rigsOption) {
  const ids =
    rigsOption === undefined || rigsOption === null
      ? [...DEFAULT_RIG_IDS]
      : String(rigsOption)
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
  if (ids.length === 0) {
    throw new TypeError("--rigs named no rig");
  }
  return ids.map((id) => {
    const rig = rigs.find((candidate) => candidate.id === id);
    if (rig === undefined) {
      throw new TypeError(`--rigs: no rig "${id}" in the registry`);
    }
    if (!rig.tags.includes("polar")) {
      throw new TypeError(`--rigs: "${id}" is not a polar rig`);
    }
    const unsupported = Object.keys(rig.dials ?? {}).filter(
      (dial) => !POLAR_DIALS.includes(dial),
    );
    if (unsupported.length > 0) {
      throw new ProbeRefusal(
        "rig-dial-unsupported",
        `rig ${id} declares dial(s) this probe cannot apply: ${unsupported.join(", ")}`,
        { rig: id, unsupported },
      );
    }
    return rig;
  });
}

/**
 * Page-side setup for one rig, serialized into `page.evaluate`, so it closes
 * over nothing. Order follows the source probes: terrain, clock, overlay and
 * dials, camera, then the settle.
 *
 * @param {{rig: object, det: string}} input The rig and the determinism kit's source.
 * @returns {Promise<{settleLoopIndex: number, settleMaxFrames: number, tilesLoaded: boolean}>}
 */
async function applyPolarRigInPage({ rig, det }) {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  const dials = rig.dials ?? {};
  // eslint-disable-next-line no-new-func
  new Function(det)();

  if (dials.terrain !== undefined) {
    if (dials.terrain !== "wgs84") {
      throw new Error(`terrain dial "${dials.terrain}" is not supported`);
    }
    const picker = viewer.baseLayerPicker.viewModel;
    const wgs84 = picker.terrainProviderViewModels.find((model) =>
      String(model.name || "")
        .toLowerCase()
        .includes("wgs84"),
    );
    if (!wgs84) {
      throw new Error("the base layer picker offers no WGS84 terrain");
    }
    picker.selectedTerrain = wgs84;
  }
  if (rig.clock !== null) {
    window.__det.pinClock(C, viewer, scene, rig.clock);
  }
  if (dials.debugTileOverlay !== undefined) {
    if (!C.DebugTileImageryProvider) {
      throw new Error("this build exports no DebugTileImageryProvider");
    }
    viewer.imageryLayers.addImageryProvider(
      new C.DebugTileImageryProvider({ ...dials.debugTileOverlay }),
    );
  }
  const assignments = {
    skyAtmosphereShow: (value) => (scene.skyAtmosphere.show = value),
    globeShowGroundAtmosphere: (value) =>
      (scene.globe.showGroundAtmosphere = value),
    globeEnableLighting: (value) => (scene.globe.enableLighting = value),
    sunShow: (value) => (scene.sun.show = value),
    moonShow: (value) => (scene.moon.show = value),
    skyBoxShow: (value) => (scene.skyBox.show = value),
    fogEnabled: (value) => (scene.fog.enabled = value),
    globeShowWireframe: (value) => (scene.globe.showWireframe = value),
    globeBackFaceCulling: (value) => (scene.globe.backFaceCulling = value),
    globeTileCacheSize: (value) => (scene.globe.tileCacheSize = value),
  };
  for (const [dial, assign] of Object.entries(assignments)) {
    if (dials[dial] !== undefined) {
      assign(dials[dial]);
    }
  }
  if (dials.globeFragmentDebug !== undefined) {
    window.CesiumDebug.globeFragmentDebug(dials.globeFragmentDebug);
  }
  const camera = rig.camera;
  viewer.camera.setView({
    destination: C.Cartesian3.fromDegrees(
      camera.lon,
      camera.lat,
      camera.height,
    ),
    orientation: {
      heading: camera.heading,
      pitch: camera.pitch,
      roll: camera.roll,
    },
  });
  // The source probes' loop: at least `frames`, at most `maxFrames`, leaving
  // as soon as the tiles report loaded past the floor. `settleTiles` returns
  // its loop index, not a frame count; `settledFrameCount` turns it into one.
  const settleMaxFrames = rig.readiness.maxFrames ?? rig.readiness.frames;
  const settleLoopIndex = await window.__det.settleTiles(scene, {
    stableFrames: 1,
    minFrames: rig.readiness.frames,
    maxFrames: settleMaxFrames,
    minMillis: 1,
  });
  return {
    settleLoopIndex,
    settleMaxFrames,
    tilesLoaded: scene.globe.tilesLoaded === true,
  };
}

/**
 * One rig on one renderer: a fresh browser context, the rig applied and
 * settled, the widgets removed, and one element capture of the scene canvas.
 */
async function captureRig({
  browser,
  origin,
  rig,
  renderer,
  run,
  outputDirectory,
  captures,
}) {
  const context = await browser.newContext({
    viewport: { ...rig.viewport },
  });
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/${rig.page}?renderer=${renderer}`, {
      waitUntil: "networkidle",
    });
    await page.waitForFunction(() => !!window.viewer);
    if (rig.dials?.globeFragmentDebug !== undefined) {
      await page.waitForFunction(
        () => typeof window.CesiumDebug?.globeFragmentDebug === "function",
        null,
        { timeout: 5000 },
      );
    }
    const setup = await page.evaluate(applyPolarRigInPage, {
      rig,
      det: DET_BROWSER_SETUP,
    });
    if (rig.readiness.dwellMs > 0) {
      await page.waitForTimeout(rig.readiness.dwellMs);
    }
    const stripped = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
    refuseCoveredCanvas(rig.id, renderer, stripped);
    const shot = await captureElement({
      page,
      selector: SCENE_CANVAS,
      name: `${rig.id}-${renderer}-run${run}`,
      outputDirectory,
      captures,
    });
    return {
      image: decodePng(shot.buffer),
      record: {
        sha256: shot.sha256,
        framesRendered: settledFrameCount(
          setup.settleLoopIndex,
          setup.settleMaxFrames,
        ),
        tilesLoaded: setup.tilesLoaded,
        widgetsRemoved: stripped.removed,
      },
    };
  } finally {
    await context.close();
  }
}

/**
 * One rig's cell from its captured legs: both banked rules when the rig is
 * captured on both renderers, none when it declares one. Pure and exported so
 * the family spec can drive it; a size mismatch between the legs throws (see
 * `lib/metrics/polar-parity.mjs`).
 *
 * @param {object} rig The rig.
 * @param {number} run The run index.
 * @param {Record<string, object>} legs Per-renderer capture records.
 * @param {Record<string, {width: number, height: number, data: ArrayLike<number>}>} frames Per-renderer decoded frames.
 * @returns {object} The cell.
 */
export function polarParityCell(rig, run, legs, frames) {
  const both = frames.webgl !== undefined && frames.webgpu !== undefined;
  return {
    run,
    rigId: rig.id,
    renderers: Object.keys(legs),
    legs,
    parity: both ? polarParity(frames.webgl, frames.webgpu) : null,
    parityNote: both
      ? "WebGL leg first, WebGPU leg second; brightnessRatio is WebGL over WebGPU"
      : `the rig declares ${rig.renderers.join(" and ")} only, so there is no pair`,
  };
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "polar-multi-plain",
  title:
    "Polar imagery parity, WebGL vs WebGPU, at the polar rigs (centre80-sum24 and frame-sum30)",
  outputSubdirectory: "polar-multi-plain",
  // The pre-harvest probe banked no receipt, only frames.
  receiptEnvelope: "runtime",
  launchArgs: LAUNCH_ARGS,
  // The CesiumViewer page and the in-page import both read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  args: {
    extraOptions: [{ flag: "--rigs", key: "rigs", kind: "string" }],
  },
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    const rigs = selectPolarRigs(await loadRigs(), options.rigs);
    const cells = [];
    for (const rig of rigs) {
      requireRigRenderers(rig, options.renderers);
      const legs = {};
      const frames = {};
      for (const renderer of rig.renderers) {
        console.log(`[polar-multi-plain] ${rig.id} ${renderer} (run ${run})`);
        const leg = await captureRig({
          browser,
          origin,
          rig,
          renderer,
          run,
          outputDirectory,
          captures,
        });
        legs[renderer] = leg.record;
        frames[renderer] = leg.image;
      }
      cells.push(polarParityCell(rig, run, legs, frames));
    }
    return cells;
  },
  receipt(cells) {
    for (const cell of cells) {
      if (cell.parity === null) {
        console.log(`  ${cell.rigId}: ${cell.parityNote}`);
        continue;
      }
      const centre = cell.parity["centre80-sum24"];
      const frame = cell.parity["frame-sum30"];
      console.log(
        `  ${cell.rigId}: centre80-sum24 ${centre.mismatchPct.toFixed(2)}% (mean delta ${centre.meanAbsSum.toFixed(2)}, brightness ${centre.brightnessRatio.toFixed(3)}); frame-sum30 ${frame.mismatchPct.toFixed(2)}%`,
      );
    }
    return { rules: POLAR_PARITY_RULES, cells };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
