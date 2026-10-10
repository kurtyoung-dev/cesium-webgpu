// framebuffer-census-steps.mjs - the steps of the framebuffer census scene: a
// default-path WebGPU frame whose every Framebuffer.js consumer is counted by
// the receipts, captured so that two trees can be compared pixel for pixel.
//
// @purpose The framebuffer census cell table (a named rig plus the census dials applied over it: MSAA, pickPosition, an OIT translucent rectangle, a glTF model with shadows and image-based lighting), the page function that pins a cell's clock through the determinism kit, applies its camera and dials, settles its tiles through the kit and drives its settle frames from the frame its model is ready, the decisions that refuse a cell with no pinned clock and a run that did not finish or whose model never became ready, and the per-cell comparison of two runs' captures with its pre-registered threshold.
// @status ACTIVE
//
// WHAT A CENSUS IS FOR. Once the WebGL compatibility stub records framebuffer
// attachments, every `Framebuffer.js` on a WebGPU context starts to drive the
// stub's attachment-reading paths (a framebuffer-to-texture copy, a blit, the
// teardown). A census cell renders a default-path scene and the receipts
// count, per consumer, what those paths did. Comparing the same cell's
// captures across two trees says whether the scene's pixels moved beyond the
// run-to-run noise of the same tree.
//
// THE CELLS. Each is a rig the registry has, by id, plus dials this module
// applies over it. A dial is not a rig: the globe cells are one globe rig with
// MSAA, a pickPosition read or one translucent rectangle (which routes through
// order-independent translucency) added. The model cell is its own minimal
// rig, because no model rig exists at the base this scene was written on.
//
// THE CLOCK IS PINNED IN EVERY CELL. A census compares captures taken up to an
// hour apart, so a cell that renders at wall-clock time measures the sun, not
// the tree: on `default-3d` (clock null) the ocean glint moved enough between
// two runs of one tree, 52 minutes apart, to fire the stop (changed fraction
// 0.019-0.021 against a threshold near 0.002). Every census rig therefore
// declares a clock, `requireCensusClock` refuses a cell whose rig does not,
// and the page pins it through `lib/determinism-kit.mjs`'s `pinClock`. The
// globe cells use `framebuffer-census-globe`, which is `default-3d` with
// its clock declared.
//
// THE SETTLE. After the clock, camera and dials, the kit's `settleTiles`
// renders until the globe has reported its tiles loaded for a run of frames;
// then the frame driver renders the rig's settle frames, counted from the
// frame the cell's model (if any) is ready. A model cell whose model never
// became ready is refused, not captured.
//
// THE COMPARISON. `cellChangedFraction` is the kit's `boxSpreadAndChange`
// over the whole frame at its default tolerance. `censusThreshold` is the
// pre-registered rule: twice the same tree's run-to-run changed fraction plus
// 0.002, and a cell whose own noise floor is above 0.05 is unmeasurable.

import fs from "node:fs";
import path from "node:path";

import { decodePng } from "../../lib/png-decode.mjs";
import { ProbeRefusal } from "./probe-refusal.mjs";

/** The census globe cells' rig: `default-3d` with its clock declared. */
export const CENSUS_GLOBE_RIG = "framebuffer-census-globe";

/** The census cells, in capture order. */
export const FRAMEBUFFER_CENSUS_CELLS = Object.freeze([
  Object.freeze({
    name: "globe",
    rig: CENSUS_GLOBE_RIG,
    dials: Object.freeze({}),
  }),
  Object.freeze({
    name: "globe-msaa4",
    rig: CENSUS_GLOBE_RIG,
    dials: Object.freeze({ msaaSamples: 4 }),
  }),
  Object.freeze({
    name: "globe-pick-position",
    rig: CENSUS_GLOBE_RIG,
    dials: Object.freeze({ pickPositionFrames: 30 }),
  }),
  Object.freeze({
    name: "globe-oit-translucent",
    rig: CENSUS_GLOBE_RIG,
    dials: Object.freeze({
      translucentRectangle: Object.freeze({
        west: -110,
        south: 25,
        east: -70,
        north: 50,
        alpha: 0.5,
      }),
    }),
  }),
  Object.freeze({
    name: "model-shadows-ibl",
    rig: "framebuffer-census-model-shadows-ibl",
    dials: Object.freeze({}),
  }),
]);

/** The frame count past which a census cell's settle gives up. */
export const CENSUS_MAX_FRAMES = 1200;

/** The changed fraction above which a cell's own noise floor is too high. */
export const CENSUS_UNMEASURABLE_FLOOR = 0.05;

/** The kit's tile settle, as a census cell runs it before its settle frames. */
export const CENSUS_TILE_SETTLE = Object.freeze({
  stableFrames: 30,
  minFrames: 60,
  maxFrames: 1500,
});

/**
 * Refuse a census cell whose rig declares no clock: its captures would differ
 * by the time between runs.
 *
 * @param {{id: string, clock: string|null}} rig The cell's rig.
 * @param {{name: string}} cell The census cell.
 * @returns {string} The rig's clock.
 * @throws {ProbeRefusal} `census-clock-unpinned`.
 */
export function requireCensusClock(rig, cell) {
  if (typeof rig?.clock !== "string" || rig.clock.length === 0) {
    throw new ProbeRefusal(
      "census-clock-unpinned",
      `framebuffer census ${cell.name}: rig ${String(rig?.id)} declares no clock, so its captures would move with wall-clock time`,
      { cell: cell.name, rig: rig?.id ?? null },
    );
  }
  return rig.clock;
}

/**
 * Pin a census cell's clock through the determinism kit, apply its camera
 * and dials, settle its tiles through the kit, then render its settle frames
 * through the runtime's frame driver, counted from the frame its model (if
 * any) is ready. Runs in the page; it reads nothing outside its arguments and
 * the page's own globals.
 *
 * @param {object} args Arguments.
 * @param {string} args.moduleUrl The engine module the page runs.
 * @param {object|null} args.camera The rig's camera, or null for the page's.
 * @param {string|null} args.clock The rig's ISO-8601 instant; a cell without
 *   one ends with outcome `no-clock`.
 * @param {string} args.det The kit's browser setup (`DET_BROWSER_SETUP`).
 * @param {{stableFrames: number, minFrames: number, maxFrames: number}}
 *   args.tileSettle The kit's tile settle options.
 * @param {object} args.rigDials The rig's own dials.
 * @param {object} args.cellDials The census cell's dials.
 * @param {number} args.settleFrames Frames to render before the capture,
 *   from the frame the model is ready.
 * @param {number} args.maxFrames The frame cap.
 * @param {number} args.deadlineMs The wall-clock deadline.
 * @param {string} args.driverGlobal Where the frame driver is installed.
 * @returns {Promise<object>} How the run ended and what was applied.
 */
export async function pageRunFramebufferCensus({
  moduleUrl,
  camera,
  clock,
  det,
  tileSettle,
  rigDials,
  cellDials,
  settleFrames,
  maxFrames,
  deadlineMs,
  driverGlobal,
}) {
  // __runFramebufferCensus
  const drive = globalThis[driverGlobal];
  if (typeof drive !== "function") {
    return { outcome: "no-driver", frames: 0, applied: {} };
  }
  const C = await import(moduleUrl);
  const viewer = globalThis.viewer;
  const scene = viewer.scene;
  const applied = {};
  if (!clock) {
    return { outcome: "no-clock", frames: 0, applied };
  }
  // eslint-disable-next-line no-new-func
  new Function(det)();
  globalThis.__det.pinClock(C, viewer, scene, clock);
  applied.clock = C.JulianDate.toIso8601(viewer.clock.currentTime);
  const dials = { ...(rigDials ?? {}), ...(cellDials ?? {}) };
  if (dials.baseLayerPickerTerrain) {
    // The wgs84 family's terrain dial: a case-insensitive substring of the
    // base-layer picker's terrain view-model names.
    const viewModel = viewer.baseLayerPicker?.viewModel;
    const wanted = String(dials.baseLayerPickerTerrain).toLowerCase();
    const found = (viewModel?.terrainProviderViewModels ?? []).find((model) =>
      String(model.name || "")
        .toLowerCase()
        .includes(wanted),
    );
    if (!found) {
      return { outcome: "no-terrain", frames: 0, applied };
    }
    viewModel.selectedTerrain = found;
    applied.terrain = String(found.name || "");
  }
  if (camera) {
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        camera.lon,
        camera.lat,
        camera.height,
      ),
      orientation: {
        heading: camera.heading ?? 0,
        pitch: camera.pitch ?? -Math.PI / 2,
        roll: camera.roll ?? 0,
      },
    });
    applied.camera = true;
  }
  if (Number.isFinite(dials.msaaSamples)) {
    scene.msaaSamples = dials.msaaSamples;
    applied.msaaSamples = scene.msaaSamples;
  }
  if (dials.shadows === true) {
    viewer.shadows = true;
    applied.shadows = true;
  }
  if (dials.translucentRectangle) {
    const r = dials.translucentRectangle;
    viewer.entities.add({
      rectangle: {
        coordinates: C.Rectangle.fromDegrees(r.west, r.south, r.east, r.north),
        material: C.Color.WHITE.withAlpha(r.alpha),
      },
    });
    applied.translucentRectangle = true;
  }
  let model = null;
  if (dials.model) {
    const m = dials.model;
    const position = C.Cartesian3.fromDegrees(m.lon, m.lat, m.height ?? 0);
    // Placed at its declared height, not clamped: a clamp waits on terrain
    // tiles, and the camera below aims at this point.
    model = await C.Model.fromGltfAsync({
      url: m.url,
      modelMatrix: C.Transforms.eastNorthUpToFixedFrame(position),
      scene,
      shadows: C.ShadowMode.ENABLED,
    });
    scene.primitives.add(model);
    applied.model = m.url;
    if (dials.lookAt) {
      const l = dials.lookAt;
      scene.camera.lookAt(
        position,
        new C.HeadingPitchRange(
          C.Math.toRadians(l.headingDeg),
          C.Math.toRadians(l.pitchDeg),
          l.range,
        ),
      );
      scene.camera.lookAtTransform(C.Matrix4.IDENTITY);
      applied.lookAt = true;
    }
  }
  const pickFrames = Number.isFinite(dials.pickPositionFrames)
    ? dials.pickPositionFrames
    : 0;
  let picks = 0;
  let picked = 0;
  let pickErrors = 0;
  const tileSettleFrames = await globalThis.__det.settleTiles(
    scene,
    tileSettle,
  );
  applied.tileSettle = {
    frames: tileSettleFrames,
    tilesLoaded: scene.globe.tilesLoaded === true,
  };
  // Settle frames count from the frame the model is ready.
  let readyFrame = model ? null : 0;
  const run = await drive(scene, {
    onFrame: (frame) => {
      if (readyFrame === null) {
        if (model.ready !== true) {
          return false;
        }
        readyFrame = frame;
      }
      const since = frame - readyFrame;
      if (pickFrames > 0 && since > settleFrames - pickFrames) {
        const canvas = scene.canvas;
        const at = new C.Cartesian2(
          canvas.clientWidth / 2,
          canvas.clientHeight / 2,
        );
        try {
          picks += 1;
          if (scene.pickPosition(at)) {
            picked += 1;
          }
        } catch {
          pickErrors += 1;
        }
      }
      return since >= settleFrames;
    },
    maxFrames,
    deadlineMs,
  });
  if (pickFrames > 0) {
    applied.pickPosition = { picks, picked, pickErrors };
  }
  return {
    ...run,
    applied,
    modelReady: model ? model.ready === true : null,
    modelReadyFrame: model ? readyFrame : null,
    msaaSamples: scene.msaaSamples,
  };
}

/**
 * Accept a census run or refuse the cell by name.
 *
 * @param {object} run What `pageRunFramebufferCensus` returned.
 * @param {{name: string}} cell The census cell.
 * @returns {object} The run.
 * @throws {ProbeRefusal} `census-steps-did-not-finish`, or
 *   `census-model-not-ready` when the cell placed a model that never
 *   became ready.
 */
export function decideCensusRun(run, cell) {
  if (run?.outcome !== "done") {
    throw new ProbeRefusal(
      "census-steps-did-not-finish",
      `framebuffer census ${cell.name}: the settle ended with ${String(run?.outcome)} after ${run?.frames ?? 0} frames`,
      { cell: cell.name, run: run ?? null },
    );
  }
  if (run.applied?.model && run.modelReady !== true) {
    throw new ProbeRefusal(
      "census-model-not-ready",
      `framebuffer census ${cell.name}: the model ${run.applied.model} was never ready`,
      { cell: cell.name, run },
    );
  }
  return run;
}

/**
 * The pre-registered threshold for one census cell, from the changed
 * fraction between two runs of the same tree.
 *
 * @param {number} sameTreeChangedFraction `cf(B1, B2)`.
 * @returns {{threshold: number|null, unmeasurable: boolean}} The threshold,
 *   or unmeasurable when the cell's noise floor is above 0.05.
 */
export function censusThreshold(sameTreeChangedFraction) {
  if (
    !Number.isFinite(sameTreeChangedFraction) ||
    sameTreeChangedFraction > CENSUS_UNMEASURABLE_FLOOR
  ) {
    return { threshold: null, unmeasurable: true };
  }
  return {
    threshold: 2 * sameTreeChangedFraction + 0.002,
    unmeasurable: false,
  };
}

/**
 * Judge one census cell from its three captures' changed fractions.
 *
 * @param {object} args Arguments.
 * @param {number} args.beforeBefore `cf(B1, B2)`.
 * @param {number} args.beforeAfter `cf(B1, A)`.
 * @returns {{threshold: number|null, verdict: string}} `unmeasurable`,
 *   `within-noise`, or `changed` (the conditional stop).
 */
export function judgeCensusCell({ beforeBefore, beforeAfter }) {
  const { threshold, unmeasurable } = censusThreshold(beforeBefore);
  if (unmeasurable) {
    return { threshold, verdict: "unmeasurable" };
  }
  return {
    threshold,
    verdict: beforeAfter > threshold ? "changed" : "within-noise",
  };
}

/** The engine receipt prefixes a census compares, per cell. */
export const CENSUS_ENGINE_PREFIXES = Object.freeze([
  "framebufferTexture2D.",
  "framebufferRenderbuffer.",
  "bindFramebuffer.",
  "deleteFramebuffer.",
  "copyTexImage2D.",
  "copyTexSubImage2D.",
  "blitFramebuffer.",
  "readPixelsAsync.",
]);

/** The WebGPU call counter prefixes a census compares, per cell. */
export const CENSUS_GPU_PREFIXES = Object.freeze([
  "createTexture.",
  "destroy.",
  "copyTextureToTexture.",
]);

/** The capture file one census cell writes in one run. */
export function censusCaptureName(cellName, run) {
  return `census-${cellName}-webgpu-run${run}`;
}

/** The counts under any of `prefixes`, sorted by name. */
function pickCounts(counts, prefixes) {
  const out = {};
  for (const name of Object.keys(counts ?? {}).sort()) {
    if (prefixes.some((prefix) => name.startsWith(prefix))) {
      out[name] = counts[name];
    }
  }
  return out;
}

/**
 * The compared counts of one census cell record, as the probe wrote it.
 *
 * @param {object|null} record The cell record.
 * @returns {object|null} Engine, GPU and scene counts and the gate.
 */
export function censusCounts(record) {
  if (!record) {
    return null;
  }
  return {
    engine: pickCounts(record.trace?.engine?.counts, CENSUS_ENGINE_PREFIXES),
    gpu: pickCounts(record.trace?.gpu?.counts, CENSUS_GPU_PREFIXES),
    framebuffers: record.trace?.framebuffers?.counts ?? null,
    gate: record.gate ?? null,
  };
}

/**
 * The changed fraction between two captures of the same size over the whole
 * frame, by the kit's metric, or null when the sizes differ.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} first
 * @param {{width: number, height: number, data: ArrayLike<number>}} second
 * @param {Function} boxSpreadAndChange The kit's metric.
 * @returns {number|null} The changed fraction.
 */
export function cellChangedFraction(first, second, boxSpreadAndChange) {
  if (first.width !== second.width || first.height !== second.height) {
    return null;
  }
  return boxSpreadAndChange(first, second, {
    x0: 0,
    y0: 0,
    x1: first.width,
    y1: first.height,
  }).changedFraction;
}

/**
 * Compare a census over three output directories: two BEFORE runs and one
 * AFTER run, each written by `--scene framebuffer-census`.
 *
 * @param {object} args Arguments.
 * @param {string} args.before1 B1's output directory.
 * @param {string} args.before2 B2's output directory.
 * @param {string} args.after A's output directory.
 * @param {Function} args.boxSpreadAndChange The kit's metric.
 * @param {string} [args.report] The report file name in each directory.
 * @param {number} [args.run] The run index the captures carry.
 * @returns {Array<object>} One row per census cell.
 */
export function compareFramebufferCensusRuns({
  before1,
  before2,
  after,
  boxSpreadAndChange,
  report = "stub-texture-uploads-report.json",
  run = 0,
}) {
  const readReport = (directory) => {
    const file = path.join(directory, report);
    return fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : null;
  };
  const recordFor = (document, cellName) =>
    (document?.cells ?? [])
      .flatMap((entry) => entry.cells ?? [])
      .find((record) => record.census === cellName) ?? null;
  const readCapture = (directory, cellName) => {
    const file = path.join(
      directory,
      `${censusCaptureName(cellName, run)}.png`,
    );
    return fs.existsSync(file) ? decodePng(fs.readFileSync(file)) : null;
  };
  const reports = {
    before1: readReport(before1),
    before2: readReport(before2),
    after: readReport(after),
  };
  return FRAMEBUFFER_CENSUS_CELLS.map((cell) => {
    const b1 = readCapture(before1, cell.name);
    const b2 = readCapture(before2, cell.name);
    const a = readCapture(after, cell.name);
    const row = {
      cell: cell.name,
      rig: cell.rig,
      counts: {
        before1: censusCounts(recordFor(reports.before1, cell.name)),
        after: censusCounts(recordFor(reports.after, cell.name)),
      },
    };
    if (!b1 || !b2 || !a) {
      return { ...row, verdict: "missing-capture" };
    }
    const beforeBefore = cellChangedFraction(b1, b2, boxSpreadAndChange);
    const beforeAfter = cellChangedFraction(b1, a, boxSpreadAndChange);
    if (beforeBefore === null || beforeAfter === null) {
      return {
        ...row,
        verdict: "capture-size-mismatch",
        sizes: [b1, b2, a].map((image) => [image.width, image.height]),
      };
    }
    return {
      ...row,
      beforeBefore,
      beforeAfter,
      ...judgeCensusCell({ beforeBefore, beforeAfter }),
    };
  });
}
