#!/usr/bin/env node
// Probe: the water landing's leg-2 cells and its material cell 1f on the
// shared runtime - one command per arm for the seat's executor.
// @purpose Runs the water landing's Edge cells from rigs alone on the shared runtime: leg 2's three cameras (great-lakes, coast-50km, orbit-disc) and the lake-only Great Lakes scene, each as a flags-ON rig against its flags-OFF twin on both renderers, staged through lib/landing-cell-stage.mjs with every water dial and the pinned wave epoch read back, tiles settled at the pinned clock and the scene canvas element-captured; and cell 1f, the Sandcastle 2 demo globe-materials-water-mask-elevation-map, through lib/sandcastle2-demo-capture.mjs; then the sheet's pre-registered bands (2a parity, 2b, 2c and 2f mask effect, 2e device faults, 2g pinned-epoch repeat, 1f BEFORE-vs-AFTER) from the kit's pixel diff, judged on the AFTER arm against the BEFORE arm's report, with a cell it cannot measure (a dial not applied, canvases of different sizes, a gate never read) NOT RUN with its reason.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// CELLS (`--cells`, comma-separated; default all five), from the round-3
// `EDGE_LEG_WATER.md`:
//   great-lakes           water-great-lakes          / water-great-lakes-off
//   coast-50km            water-coast-50km           / water-coast-50km-off
//   orbit-disc            water-orbit-disc           / water-orbit-disc-off
//   great-lakes-lakeonly  water-great-lakes-lakeonly / water-great-lakes-off
//   1f                    sandcastle2-globe-materials-water-mask
// every one on both renderers. `water-great-lakes-off` is the OFF twin of both
// Great Lakes rigs (the two twins would be the same record); each cell
// captures it under its own name. For 1f the round-3 sheet names the sweep
// driver (`sandcastle-smoke.mjs --sandcastle2`, which settles on its own
// threshold); this probe's 1f is the kit route (a counted settle, the scene
// canvas element-captured inside the run frame) under the same bands. Which
// of the two is the record is a seat ruling.
// A cell runs on each renderer its rig declares that `--renderer` keeps.
//
// ONE ARM PER INVOCATION, NAMED. `--arm before` measures the tree without the
// water batch, where the water dials read back `applied: false` (the sheet's
// way for BEFORE to answer); `--arm after` measures the water tree, where a
// water dial that does not apply makes the page NOT RUN. The AFTER run is
// handed the BEFORE run's report (`--base-report`) and judges the bands; a run
// without one records its metrics and judges only what needs no base (2b, 2c,
// 2e on AFTER). Same-build repeats are `--runs N`; the sheet's repeat controls
// need N >= 2 (with one run every repeat spread reads 0).
//
// THE PAGES. Leg 2 opens the offline CesiumViewer (`lib/performance-viewer-url.mjs`:
// no ion base layer, no world terrain), so the rig's `terrain` and `imagery`
// dials are the only terrain and imagery the scene has. The settle renders at
// the pinned clock (never `scene.render()` with no time, which reads the wall
// clock) until `globe.tilesLoaded` has held for 30 frames, at least 1.5 s
// have passed and no water dataset fetch is pending (a fetch that resolves
// invalidates every tile), then the rig's `readiness.frames`. Cell 1f opens
// the demo through `lib/sandcastle2-demo-capture.mjs` on the run-frame port
// (`--sandcastle-port`, default the origin's port + 1); the demo streams
// Cesium World Terrain, so without ion it is NOT RUN (`--no-ion` declares
// that up front), never a pass.
//
// THE BANDS (`WATER_BANDS`, pre-registered by the sheet; a change is a seat
// ruling recorded before the run). Pixel mismatch is the kit's `diffImages`
// at the kit's default tolerance (16 of 255 per channel); the mask effect is
// the share of pixels any channel of which moves by more than 8 of 255
// between the OFF and ON capture on the same renderer.
//   2a  AFTER ON WebGL-vs-WebGPU (median over runs) <= BEFORE's at the same
//       rig + 1.0 pp + 3 x the AFTER repeat spread (max - min over runs).
//       The sheet reads "<= BEFORE + 1.0 pp, and <= that + 3 x the AFTER
//       same-build repeat spread"; this probe takes "that" as BEFORE + 1.0 pp,
//       and records every term so the seat can re-judge another reading.
//   2b  WebGL and WebGPU effect areas agree: |gl - gpu| <= max(10 % of the
//       larger, 0.3 pp).
//   2c  effect area >= 0.5 % (great-lakes), 5 % (coast-50km), 2 %
//       (orbit-disc, seat ruling S6: Edge round 2 measured 3.325 / 3.269 %),
//       on each renderer.
//   2e  per page: no device loss, no uncaptured WebGPU error, no page error;
//       a fault-free WebGPU page whose error gate armed no device is NOT RUN
//       ("error gate not armed"), and a fault-free page whose gate was never
//       read is NOT RUN ("gate not read (page refused)", the refusal carried).
//       The demo piece reads the gate before it refuses a page that did not
//       settle or whose clock it could not pin, so those pages are judged on
//       the gate it read.
//   2g  great-lakes, coast-50km, orbit-disc on AFTER: the ON rig's run 0
//       against its run 1 on one renderer (tolerance 16) <= 0.05 pp, both runs
//       at the rig's pinned wave epoch (`waterSimulationEpoch`). A page whose
//       epoch reads back `applied: false` (a stage with no handler for the
//       dial, or a tree without `globe.water.ocean`) makes 2g NOT RUN with
//       the reason. An ON page NOT RUN for another reason (it did not
//       settle, chrome over the canvas) makes 2g NOT RUN with that page's
//       own reason, and a page refused before staging with "page refused
//       before staging". Only when no page names a cause is the run count
//       given: "2g needs two captured ON runs" where --runs >= 2 was given,
//       "2g needs --runs 2 or more" where it was not.
// A page that cannot be measured (it did not settle, its chrome could not be
// stripped, the demo piece refused it) is NOT RUN with its reason; it never
// voids the arm's other pages.
//   2f  great-lakes-lakeonly: effect area <= the OFF rig's own repeat spread
//       (the effect measure between its first two runs) + 0.05 pp on each
//       renderer; lakes alone over a maskless terrain draw nothing.
//   1f  per renderer, AFTER vs BEFORE (first runs) <= max(0.05 pp, 2 x the
//       larger repeat spread of the two trees, a tree's spread being the
//       mismatch between its first two runs); and the WebGL-vs-WebGPU
//       mismatch AFTER within that band of BEFORE's. The demo's canvas can
//       differ in size per renderer (Edge round 2: 1280x687 on WebGL, 1280x520
//       on WebGPU, on both trees), and two sizes have no pixel diff: the
//       parity term is then NOT RUN, "canvas size differs", with both sizes.
// 2d (reading the PNGs) is the executor's; the receipt lists every PNG.
//
// THE WAVE EPOCH DIAL. `lib/landing-cell-stage.mjs` applies a dial it knows
// and refuses one it does not (`rig-dial-unsupported`, in Node). Until its
// handler for `waterSimulationEpoch` lands (KT round 5), this probe asks the
// stage whether it takes the dial; where it does not, the page is staged
// without it and the epoch is recorded `applied: false` with that reason, so
// leg 2 still runs and only 2g reads NOT RUN.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";
import { decodePng, readPng } from "../lib/png-decode.mjs";
import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { captureUrlFor } from "./lib/capture.mjs";
import { diffImages } from "./lib/image-diff.mjs";
import {
  LANDING_WATER_DIALS,
  landingStagePayload,
  stageLandingCell,
} from "./lib/landing-cell-stage.mjs";
import { buildPerformanceViewerUrl } from "./lib/performance-viewer-url.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { loadRigs } from "./lib/rig-registry.mjs";
import {
  DEMO_CAPTURE_STATUS,
  captureSandcastle2Demo,
  prepareDemoCaptureContext,
} from "./lib/sandcastle2-demo-capture.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";

/** The scene table: cell name -> its rigs and what the cell measures. */
export const WATER_CELLS = Object.freeze({
  "great-lakes": Object.freeze({
    kind: "mask-pair",
    on: "water-great-lakes",
    off: "water-great-lakes-off",
    effectFloorPct: 0.5,
    waveEpochRepeat: true,
  }),
  "coast-50km": Object.freeze({
    kind: "mask-pair",
    on: "water-coast-50km",
    off: "water-coast-50km-off",
    effectFloorPct: 5,
    waveEpochRepeat: true,
  }),
  "orbit-disc": Object.freeze({
    kind: "mask-pair",
    on: "water-orbit-disc",
    off: "water-orbit-disc-off",
    // Seat ruling S6 (pre-registered before the next Edge run): the Edge
    // round-2 orbital disc measured 3.325 % (WebGL) and 3.269 % (WebGPU),
    // agreeing within 0.06 pp, so the floor is 2 % rather than 5 %.
    effectFloorPct: 2,
    waveEpochRepeat: true,
  }),
  "great-lakes-lakeonly": Object.freeze({
    kind: "mask-pair",
    on: "water-great-lakes-lakeonly",
    off: "water-great-lakes-off",
    effectCeilingOverOffRepeatPp: 0.05,
  }),
  "1f": Object.freeze({
    kind: "sandcastle2-demo",
    rig: "sandcastle2-globe-materials-water-mask",
  }),
});

/** The sheet's pre-registered bands (EDGE_LEG_WATER.md leg 1 cell 1f, leg 2). */
export const WATER_BANDS = Object.freeze({
  mismatchTolerance: 16,
  effectTolerance: 8,
  parityAllowancePp: 1.0,
  parityRepeatMultiplier: 3,
  effectAgreementRelative: 0.1,
  effectAgreementAbsolutePp: 0.3,
  demoFloorPp: 0.05,
  demoRepeatMultiplier: 2,
  waveEpochRepeatPp: 0.05,
});

/** The arms a run declares. */
export const WATER_ARMS = Object.freeze(["before", "after"]);

/** The gallery id cell 1f's rig opens (its served files are asserted). */
export const WATER_DEMO_ID = "globe-materials-water-mask-elevation-map";

/** The rig dial that pins the water's wave clock (W-A3, cell 2g). */
export const WAVE_EPOCH_DIAL = "waterSimulationEpoch";

const CANVAS_SELECTOR = ".cesium-widget canvas";
const NAVIGATION_BUDGET_MS = 120_000;
const SETTLE_BUDGET_MS = 180_000;
const STABLE_TILE_FRAMES = 30;
const MIN_SETTLE_MS = 1500;
const MAX_TILE_FRAMES = 6000;
const PAGE_BUDGET_MS = 2 * NAVIGATION_BUDGET_MS + SETTLE_BUDGET_MS + 60_000;
const DEMO_PAGE_BUDGET_MS = 600_000;

/**
 * The comma list of a string option, trimmed, empties dropped.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * The pages a run takes, cell-major in `--cells` order, WebGL before WebGPU,
 * and for a mask pair the ON rig before its OFF twin. Pure.
 *
 * @param {{cells?: string, renderers?: string[]}} options
 * @param {Map<string, object>} rigsById
 * @returns {Array<{cell: string, kind: string, rigId: string,
 *   variant: string, renderer: string}>}
 * @throws {ProbeRefusal} `cell-unknown` or `cell-rig-absent`.
 */
export function planWaterCells(options, rigsById) {
  const names = splitList(options?.cells ?? Object.keys(WATER_CELLS).join(","));
  const plan = [];
  for (const cell of names) {
    if (!Object.hasOwn(WATER_CELLS, cell)) {
      throw new ProbeRefusal(
        "cell-unknown",
        `--cells ${cell} is not one of ${Object.keys(WATER_CELLS).join(", ")}`,
        { cell },
      );
    }
    const spec = WATER_CELLS[cell];
    const variants =
      spec.kind === "mask-pair"
        ? [
            ["on", spec.on],
            ["off", spec.off],
          ]
        : [["demo", spec.rig]];
    for (const [, rigId] of variants) {
      if (!rigsById.has(rigId)) {
        throw new ProbeRefusal(
          "cell-rig-absent",
          `${cell}: rig ${rigId} is not in the registry`,
          { cell, rigId },
        );
      }
    }
    for (const renderer of ["webgl", "webgpu"]) {
      if (
        Array.isArray(options?.renderers) &&
        !options.renderers.includes(renderer)
      ) {
        continue;
      }
      for (const [variant, rigId] of variants) {
        if (!rigsById.get(rigId).renderers.includes(renderer)) {
          continue;
        }
        plan.push({ cell, kind: spec.kind, rigId, variant, renderer });
      }
    }
  }
  return plan;
}

/**
 * The water dials a rig sets to `true` that the tree did not take, and every
 * other dial that did not apply. The wave epoch is neither: only cell 2g
 * reads it, so a page whose epoch did not apply still runs. Pure.
 *
 * @param {object} rig
 * @param {object} staged `stageLandingCellInPage`'s answer.
 * @returns {{blocking: string[], waterAbsent: string[]}}
 */
export function stageGaps(rig, staged) {
  const blocking = [];
  const waterAbsent = [];
  for (const key of staged?.notApplied ?? []) {
    if (key === WAVE_EPOCH_DIAL) {
      continue;
    }
    if (!LANDING_WATER_DIALS.includes(key)) {
      blocking.push(key);
    } else if (rig?.dials?.[key] === true) {
      waterAbsent.push(key);
    }
  }
  return { blocking, waterAbsent };
}

/**
 * Whether the stage's Node half accepts a dial: it refuses one it does not
 * know with `rig-dial-unsupported`, before any page is involved. Pure.
 *
 * @param {string} key
 * @param {unknown} value
 * @param {Function} [payloadOf] The stage's payload builder.
 * @returns {boolean}
 */
export function stageHandlesDial(key, value, payloadOf = landingStagePayload) {
  try {
    payloadOf({
      id: `probe-water-cells:${key}`,
      camera: null,
      dials: { [key]: value },
    });
    return true;
  } catch (error) {
    if (error?.reason === "rig-dial-unsupported") {
      return false;
    }
    throw error;
  }
}

/**
 * The rig the stage is handed, and what the probe knows about the rig's wave
 * epoch before the page opens. A rig without the epoch dial is staged as it
 * is; with it, on a stage that takes the dial, as it is too; on a stage that
 * does not, without the dial (the stage would refuse the whole rig), the epoch
 * then reading `applied: false`. Pure.
 *
 * @param {object} rig
 * @param {{handles?: (key: string, value: unknown) => boolean}} [io]
 * @returns {{rig: object, epoch: {requested: unknown,
 *   stageHandles: boolean}|null}}
 */
export function waterStagePlan(rig, io = {}) {
  const handles = io.handles ?? stageHandlesDial;
  if (!Object.hasOwn(rig?.dials ?? {}, WAVE_EPOCH_DIAL)) {
    return { rig, epoch: null };
  }
  const requested = rig.dials[WAVE_EPOCH_DIAL];
  if (handles(WAVE_EPOCH_DIAL, requested)) {
    return { rig, epoch: { requested, stageHandles: true } };
  }
  const dials = { ...rig.dials };
  delete dials[WAVE_EPOCH_DIAL];
  return { rig: { ...rig, dials }, epoch: { requested, stageHandles: false } };
}

/**
 * The page's wave-epoch readback: the stage's own answer where it staged the
 * dial, else `applied: false` with the reason. Null for a rig without the
 * dial. Pure.
 *
 * @param {{requested: unknown, stageHandles: boolean}|null} epoch
 *   {@link waterStagePlan}'s `epoch`.
 * @param {object} staged `stageLandingCellInPage`'s answer.
 * @returns {{requested: unknown, observed: unknown, applied: boolean,
 *   reason?: string}|null}
 */
export function waveEpochReadback(epoch, staged) {
  if (epoch === null || epoch === undefined) {
    return null;
  }
  if (epoch.stageHandles !== true) {
    return {
      requested: epoch.requested,
      observed: null,
      applied: false,
      reason: `the stage at this tree has no ${WAVE_EPOCH_DIAL} handler (rig-dial-unsupported); the dial was not staged`,
    };
  }
  const dial = staged?.dials?.[WAVE_EPOCH_DIAL];
  if (!dial || typeof dial !== "object") {
    return {
      requested: epoch.requested,
      observed: null,
      applied: false,
      reason: `the stage returned no ${WAVE_EPOCH_DIAL} readback`,
    };
  }
  return {
    requested: dial.requested ?? epoch.requested,
    observed: dial.observed ?? null,
    applied: dial.applied === true,
    ...(typeof dial.reason === "string" && { reason: dial.reason }),
  };
}

/** Render at the pinned clock until the tiles hold, then `frames`. In page. */
async function pageSettleWaterScene({
  frames,
  stableFrames,
  minMs,
  maxTileFrames,
  deadlineMs,
}) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const scene = viewer.scene;
  const globe = scene.globe;
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const draw = async () => {
    scene.render(viewer.clock.currentTime);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  };
  // A water dataset fetch that resolves invalidates every tile; a settle that
  // ends before it measured the scene without the mask.
  const pending = () =>
    globe._globalWaterMaskLoadPending === true ||
    globe._lakeWaterMaskLoadPending === true ||
    globe._riverWaterMaskLoadPending === true ||
    globe._globalBathymetryTensorLoadPending === true;
  let stable = 0;
  let tileFrames = 0;
  while (tileFrames < maxTileFrames && elapsed() < deadlineMs) {
    await draw();
    tileFrames += 1;
    stable = globe.tilesLoaded === true && !pending() ? stable + 1 : 0;
    if (stable >= stableFrames && elapsed() >= minMs) {
      break;
    }
  }
  const tilesSettled = stable >= stableFrames;
  let rendered = 0;
  while (rendered < frames && elapsed() < deadlineMs) {
    await draw();
    rendered += 1;
  }
  return {
    tilesSettled,
    tileFrames,
    frames: rendered,
    tilesLoaded: globe.tilesLoaded === true,
    datasetPending: pending(),
    elapsedMs: Math.round(elapsed()),
  };
}

/** The `notRun` text of a cell-level refusal. */
function refusalNotRun(refusal) {
  return `${refusal.reason}: ${refusal.message}`;
}

/** The receipt's copy of a cell-level refusal. */
function refusalRecord(refusal) {
  return {
    reason: refusal.reason,
    message: refusal.message,
    details: refusal.details ?? null,
  };
}

/**
 * The page's 2e record. `notRead` names why the error gate was never read (a
 * refused page, a page NOT RUN before its capture); the page errors are the
 * top page's own and are always measured.
 */
function gateRecord(gate, diagnostics, notRead = null) {
  const pageErrors = diagnostics.errors.map(({ text }) =>
    String(text).slice(0, 300),
  );
  return {
    deviceLost: gate?.deviceLost ?? null,
    errorCount: gate?.errors?.length ?? 0,
    errors: (gate?.errors ?? []).slice(0, 10),
    armedDevices: gate?.armedDevices ?? 0,
    pageErrors: pageErrors.slice(0, 10),
    pageErrorCount: pageErrors.length,
    ...(gate ? {} : { notRead: notRead ?? "no gate answer" }),
  };
}

/** One leg-2 page: a rig staged, settled and captured, on a fresh context. */
async function runMaskPage({
  browser,
  origin,
  entry,
  rig,
  run,
  options,
  outputDirectory,
  captures,
}) {
  const record = {
    run,
    cell: entry.cell,
    kind: entry.kind,
    variant: entry.variant,
    rig: rig.id,
    renderer: entry.renderer,
    notRun: null,
  };
  const context = await browser.newContext({
    viewport: { ...rig.viewport },
    deviceScaleFactor: 1,
  });
  try {
    await context.addInitScript(errorGateInit);
    const page = await context.newPage();
    const diagnostics = attachPageDiagnostics(page);
    try {
      const url = buildPerformanceViewerUrl(
        captureUrlFor({ rig, origin }),
        entry.renderer,
      );
      await page.goto(url.href, {
        waitUntil: "load",
        timeout: NAVIGATION_BUDGET_MS,
      });
      await page.waitForFunction(() => !!globalThis.viewer, null, {
        timeout: NAVIGATION_BUDGET_MS,
      });
      record.armed = await armWebGPUDevices(page);
      const plan = waterStagePlan(rig);
      const { staged } = await stageLandingCell({ page, rig: plan.rig });
      record.stage = staged;
      record.waveEpoch = waveEpochReadback(plan.epoch, staged);
      const gaps = stageGaps(rig, staged);
      record.waterDialsAbsent = gaps.waterAbsent;
      if (gaps.blocking.length > 0) {
        record.notRun = `the stage did not apply ${gaps.blocking.join(", ")}`;
      } else if (options.arm === "after" && gaps.waterAbsent.length > 0) {
        record.notRun = `the AFTER tree did not take ${gaps.waterAbsent.join(", ")}`;
      }
      if (record.notRun === null) {
        record.settle = await page.evaluate(pageSettleWaterScene, {
          frames: rig.readiness.frames,
          stableFrames: STABLE_TILE_FRAMES,
          minMs: MIN_SETTLE_MS,
          maxTileFrames: MAX_TILE_FRAMES,
          deadlineMs: SETTLE_BUDGET_MS,
        });
        if (
          !record.settle.tilesSettled ||
          record.settle.frames < rig.readiness.frames
        ) {
          record.notRun = `the scene did not settle (${JSON.stringify(record.settle)})`;
        }
      }
      let widgets = null;
      if (record.notRun === null) {
        widgets = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
        if (
          !Array.isArray(widgets?.leftovers) ||
          widgets.leftovers.length > 0
        ) {
          // A page whose chrome cannot be stripped cannot be measured: the
          // cell is NOT RUN, and the arm's other pages keep their receipt.
          const refusal = new ProbeRefusal(
            "capture-chrome-over-canvas",
            `${rig.id}: the viewer chrome strip left ${JSON.stringify(widgets?.leftovers ?? null)} over the scene canvas`,
            { widgets: widgets ?? null },
          );
          record.notRun = refusalNotRun(refusal);
          record.refusal = refusalRecord(refusal);
        }
      }
      if (record.notRun === null) {
        const shot = await captureElement({
          page,
          selector: CANVAS_SELECTOR,
          name: `${entry.cell}-${entry.variant}-${entry.renderer}-run${run}`,
          outputDirectory,
          captures,
        });
        const image = decodePng(shot.buffer);
        record.capture = {
          name: shot.name,
          path: shot.path,
          sha256: shot.sha256,
          width: image.width,
          height: image.height,
          liveness: shot.liveness,
        };
      }
      record.gate = gateRecord(await collectGateErrors(page), diagnostics);
      return record;
    } finally {
      diagnostics.detach();
    }
  } finally {
    await context.close();
  }
}

/**
 * Cell 1f on one renderer, through the demo-capture piece. A refusal the piece
 * raises for this demo (no viewer, an unreadable frame, the wrong renderer, a
 * clock it could not pin, a settle short of its frames) makes this page NOT
 * RUN with the refusal recorded; it does not void the arm's other pages. An
 * origin breach is not a ProbeRefusal and still ends the arm: it means the
 * run reached another tree.
 */
async function runDemoPage({
  browser,
  origin,
  entry,
  rig,
  run,
  options,
  outputDirectory,
  captures,
  demoCaptureDependencies,
}) {
  const record = {
    run,
    cell: entry.cell,
    kind: entry.kind,
    variant: entry.variant,
    rig: rig.id,
    renderer: entry.renderer,
    notRun: null,
  };
  const context = await browser.newContext({
    viewport: { ...rig.viewport },
    deviceScaleFactor: 1,
  });
  try {
    await prepareDemoCaptureContext(context);
    const page = await context.newPage();
    const diagnostics = attachPageDiagnostics(page);
    try {
      const base = new URL(origin);
      let result;
      try {
        result = await captureSandcastle2Demo({
          page,
          request: {
            origin,
            bucketOrigin: `${base.protocol}//${base.hostname}:${options.sandcastlePort ?? Number(base.port) + 1}`,
            demoId: rig.dials.galleryId,
            renderer: entry.renderer,
            frames: rig.readiness.frames,
            requiresIon: rig.dials.requiresIon === true,
            ionAvailable: options.noIon === true ? false : null,
            clock: rig.clock,
            name: `${entry.cell}-${entry.renderer}-run${run}`,
          },
          outputDirectory,
          captures,
          ...(demoCaptureDependencies && {
            dependencies: demoCaptureDependencies,
          }),
        });
      } catch (error) {
        if (!(error instanceof ProbeRefusal)) {
          throw error;
        }
        record.notRun = refusalNotRun(error);
        record.refusal = refusalRecord(error);
        // A refusal that read the gate first (a settle short of its frames, a
        // clock it could not pin) carries it: 2e is judged on it, so a device
        // lost mid-settle FAILS. Otherwise the gate was never read, and 2e is
        // NOT RUN, "gate not read (page refused)", whatever the renderer.
        const carried = error.details?.gate ?? null;
        record.gate = gateRecord(carried, diagnostics, "page refused");
        return record;
      }
      record.demo = {
        status: result.status,
        record: result.record,
        rendererGate: result.rendererGate,
        frameGate: result.frameGate,
        settle: result.settle,
        clock: result.clock,
        urls: result.urls,
      };
      if (result.status !== DEMO_CAPTURE_STATUS.CAPTURED) {
        record.notRun = result.notRun;
      } else {
        record.capture = result.capture;
      }
      record.gate = gateRecord(
        result.gate,
        diagnostics,
        `page ${result.notRun ?? "not captured"}`,
      );
      return record;
    } finally {
      diagnostics.detach();
    }
  } finally {
    await context.close();
  }
}

/**
 * Mismatch percent between two decoded images at a tolerance, or null when
 * they are not the same size. Pure.
 */
export function mismatchPct(a, b, tolerance) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) {
    return null;
  }
  return diffImages(a, b, { tolerance }).mismatchPct;
}

/**
 * Why a demo parity term has no value: the canvases differ in size per
 * renderer (with both sizes), or a capture is missing. Pure.
 *
 * @param {Array<{webgl: string|null, webgpu: string|null}|null>|null} afterSizes
 *   The AFTER summary's `paritySizes`, when AFTER's parity is missing.
 * @param {Array<object|null>|null} beforeSizes The same for BEFORE.
 * @param {boolean} afterMissing
 * @param {boolean} beforeMissing
 * @returns {string}
 */
export function parityNotMeasured(
  afterSizes,
  beforeSizes,
  afterMissing,
  beforeMissing,
) {
  const differing = (sizes) =>
    (sizes ?? []).find(
      (pair) => pair && pair.webgl && pair.webgpu && pair.webgl !== pair.webgpu,
    ) ?? null;
  const parts = [];
  const missing = [];
  for (const [arm, sizes, isMissing] of [
    ["AFTER", afterSizes, afterMissing],
    ["BEFORE", beforeSizes, beforeMissing],
  ]) {
    if (!isMissing) {
      continue;
    }
    const pair = differing(sizes);
    if (pair) {
      parts.push(`${arm} webgl ${pair.webgl} vs webgpu ${pair.webgpu}`);
    } else {
      missing.push(arm);
    }
  }
  const reasons = [];
  if (parts.length > 0) {
    reasons.push(`canvas size differs: ${parts.join("; ")}`);
  }
  if (missing.length > 0) {
    reasons.push(
      `no WebGL and WebGPU capture pair of one size on ${missing.join(" and ")}`,
    );
  }
  return reasons.join("; ");
}

/**
 * Per run, the WebGL and WebGPU canvas sizes of a demo cell's captures (a
 * summary's `captures`), read from the PNGs; null for a run without both, or
 * whose PNG cannot be read. Pure but for `loadImage`.
 */
function demoCaptureSizes(captures, loadImage) {
  const list = (captures ?? []).filter((c) => c.variant === "demo");
  const runs = [...new Set(list.map((c) => c.run))].sort((a, b) => a - b);
  const sizeOf = (capture) => {
    try {
      const decoded = loadImage(capture.path);
      return decoded ? `${decoded.width}x${decoded.height}` : null;
    } catch {
      return null;
    }
  };
  return runs.map((run) => {
    const gl = list.find((c) => c.run === run && c.renderer === "webgl");
    const gpu = list.find((c) => c.run === run && c.renderer === "webgpu");
    return gl && gpu ? { webgl: sizeOf(gl), webgpu: sizeOf(gpu) } : null;
  });
}

const median = (values) => {
  const sorted = values
    .filter((v) => typeof v === "number")
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const range = (values) => {
  const numbers = values.filter((v) => typeof v === "number");
  return numbers.length === 0
    ? null
    : Math.max(...numbers) - Math.min(...numbers);
};

/**
 * The measured metrics of a run set, per cell: for a mask pair the effect
 * area per renderer and run and the ON and OFF WebGL-vs-WebGPU mismatch per
 * run; for the demo cell its captures, the repeat mismatch per renderer and
 * the WebGL-vs-WebGPU mismatch per run. Pure but for `loadImage`.
 *
 * @param {object[]} records Every page record of every run.
 * @param {{loadImage?: (file: string) => object}} [io]
 * @returns {Record<string, object>}
 */
export function summarizeWaterRecords(records, io = {}) {
  const loadImage = io.loadImage ?? readPng;
  const cache = new Map();
  const image = (capture) => {
    if (!capture?.path) {
      return null;
    }
    if (!cache.has(capture.path)) {
      cache.set(capture.path, loadImage(capture.path));
    }
    return cache.get(capture.path);
  };
  const find = (cell, variant, renderer, run) =>
    records.find(
      (r) =>
        r.cell === cell &&
        r.variant === variant &&
        r.renderer === renderer &&
        r.run === run &&
        r.notRun === null &&
        r.capture,
    );
  const runs = [...new Set(records.map((r) => r.run))].sort((a, b) => a - b);
  const summary = {};
  for (const cell of [...new Set(records.map((r) => r.cell))]) {
    const spec = WATER_CELLS[cell];
    const mine = records.filter((r) => r.cell === cell);
    const entry = {
      kind: spec.kind,
      notRun: mine
        .filter((r) => r.notRun !== null)
        .map((r) => `${r.variant}:${r.renderer}:run${r.run}: ${r.notRun}`),
      captures: mine
        .filter((r) => r.capture)
        .map((r) => ({
          variant: r.variant,
          renderer: r.renderer,
          run: r.run,
          path: r.capture.path,
          sha256: r.capture.sha256,
        })),
    };
    if (spec.kind === "mask-pair") {
      entry.waterDialsAbsent = [
        ...new Set(
          mine
            .filter((r) => r.variant === "on")
            .flatMap((r) => r.waterDialsAbsent ?? []),
        ),
      ];
      entry.effectPct = {};
      for (const renderer of ["webgl", "webgpu"]) {
        entry.effectPct[renderer] = runs.map((run) => {
          const on = find(cell, "on", renderer, run);
          const off = find(cell, "off", renderer, run);
          return on && off
            ? mismatchPct(
                image(off.capture),
                image(on.capture),
                WATER_BANDS.effectTolerance,
              )
            : null;
        });
      }
      // The effect measure's own noise: the OFF rig against itself, run 0 vs
      // run 1 on one renderer (null with a single run).
      entry.offRepeatPct = {};
      for (const renderer of ["webgl", "webgpu"]) {
        const first = find(cell, "off", renderer, runs[0]);
        const second =
          runs.length > 1 ? find(cell, "off", renderer, runs[1]) : null;
        entry.offRepeatPct[renderer] =
          first && second
            ? mismatchPct(
                image(first.capture),
                image(second.capture),
                WATER_BANDS.effectTolerance,
              )
            : null;
      }
      if (spec.waveEpochRepeat === true) {
        // 2g: the ON rig against itself, run 0 vs run 1 on one renderer, and
        // whether every ON page of those runs pinned the wave epoch.
        entry.waveEpochRepeat = {};
        const pair = runs.slice(0, 2);
        for (const renderer of ["webgl", "webgpu"]) {
          const pages = mine.filter(
            (r) =>
              r.variant === "on" &&
              r.renderer === renderer &&
              pair.includes(r.run),
          );
          if (pages.length === 0) {
            continue;
          }
          const first = find(cell, "on", renderer, pair[0]);
          const second =
            pair.length > 1 ? find(cell, "on", renderer, pair[1]) : null;
          // Each ON page that keeps 2g from being measured is named for its
          // own cause (A3-2): a page refused before it was staged has no
          // epoch readback at all; a staged page whose epoch did not apply
          // carries the readback's reason; a page whose epoch applied but
          // which was NOT RUN for another reason carries that page's reason.
          const refusedEarly = (r) =>
            r.waveEpoch === undefined && r.notRun !== null;
          const refusedBeforeStaging = pages
            .filter(refusedEarly)
            .map((r) => `run${r.run}: ${r.notRun}`);
          const notApplied = pages
            .filter((r) => !refusedEarly(r) && r.waveEpoch?.applied !== true)
            .map(
              (r) =>
                `run${r.run}: ${r.waveEpoch?.reason ?? (r.waveEpoch ? "applied: false" : "no wave-epoch readback")}`,
            );
          const pageNotRun = pages
            .filter((r) => r.waveEpoch?.applied === true && r.notRun !== null)
            .map((r) => `run${r.run}: ${r.notRun}`);
          entry.waveEpochRepeat[renderer] = {
            rig: spec.on,
            epoch: pages[0].waveEpoch?.requested ?? null,
            applied: notApplied.length === 0,
            notApplied,
            refusedBeforeStaging,
            pageNotRun,
            runsSeen: runs.length,
            capturedRuns: pages.filter((r) => r.notRun === null && r.capture)
              .length,
            repeatPct:
              first && second
                ? mismatchPct(
                    image(first.capture),
                    image(second.capture),
                    WATER_BANDS.mismatchTolerance,
                  )
                : null,
          };
        }
      }
      for (const variant of ["on", "off"]) {
        entry[`parity${variant === "on" ? "On" : "Off"}Pct`] = runs.map(
          (run) => {
            const gl = find(cell, variant, "webgl", run);
            const gpu = find(cell, variant, "webgpu", run);
            return gl && gpu
              ? mismatchPct(
                  image(gl.capture),
                  image(gpu.capture),
                  WATER_BANDS.mismatchTolerance,
                )
              : null;
          },
        );
      }
    } else {
      entry.repeatPct = {};
      for (const renderer of ["webgl", "webgpu"]) {
        const first = find(cell, "demo", renderer, runs[0]);
        const second =
          runs.length > 1 ? find(cell, "demo", renderer, runs[1]) : null;
        entry.repeatPct[renderer] =
          first && second
            ? mismatchPct(
                image(first.capture),
                image(second.capture),
                WATER_BANDS.mismatchTolerance,
              )
            : null;
      }
      entry.parityPct = runs.map((run) => {
        const gl = find(cell, "demo", "webgl", run);
        const gpu = find(cell, "demo", "webgpu", run);
        return gl && gpu
          ? mismatchPct(
              image(gl.capture),
              image(gpu.capture),
              WATER_BANDS.mismatchTolerance,
            )
          : null;
      });
      // The canvas sizes behind each parity term: two sizes have no pixel
      // diff, and the verdict names them instead of a null.
      const sizeOf = (capture) => {
        const decoded = image(capture);
        return decoded ? `${decoded.width}x${decoded.height}` : null;
      };
      entry.paritySizes = runs.map((run) => {
        const gl = find(cell, "demo", "webgl", run);
        const gpu = find(cell, "demo", "webgpu", run);
        return gl && gpu
          ? { webgl: sizeOf(gl.capture), webgpu: sizeOf(gpu.capture) }
          : null;
      });
    }
    summary[cell] = entry;
  }
  return summary;
}

/**
 * The run's verdicts. Pure but for `loadImage` (1f reads the base PNGs).
 *
 * @param {object[]} records This run set's page records.
 * @param {Record<string, object>} summary {@link summarizeWaterRecords} of them.
 * @param {Record<string, object>|null} baseSummary The BEFORE report's summary.
 * @param {{arm: string, runs?: number, loadImage?: Function}} context `runs`
 *   is the run count the arm asked for (`--runs`); without it 2g reads the
 *   number of runs in `records`.
 * @returns {Array<{id: string, pass: boolean}>}
 */
export function waterVerdicts(records, summary, baseSummary, context) {
  const loadImage = context.loadImage ?? readPng;
  const bands = WATER_BANDS;
  const verdicts = [];
  for (const record of records) {
    const id = `${record.cell}:${record.variant}:${record.renderer}:run${record.run}`;
    verdicts.push({
      id: `${id}:stage`,
      pass: record.notRun === null,
      notRun: record.notRun !== null,
      reason: record.notRun ?? undefined,
    });
    if (record.gate) {
      const faultFree =
        !record.gate.deviceLost &&
        record.gate.errorCount === 0 &&
        record.gate.pageErrorCount === 0;
      // Zero faults from a gate nobody read, or from a WebGPU page whose
      // error gate armed no device, is no measurement: the gate could not
      // have reported one. A fault that WAS measured (a page error) fails.
      const notRead = typeof record.gate.notRead === "string";
      const unarmed =
        !notRead &&
        record.renderer === "webgpu" &&
        !(record.gate.armedDevices >= 1);
      verdicts.push({
        id: `${id}:2e-no-device-fault`,
        pass: faultFree && !unarmed && !notRead,
        ...(faultFree &&
          notRead && {
            notRun: true,
            reason: `gate not read (${record.gate.notRead})`,
            ...(record.refusal && { refusal: record.refusal }),
          }),
        ...(faultFree &&
          unarmed && { notRun: true, reason: "error gate not armed" }),
        gate: record.gate,
      });
    }
  }
  for (const [cell, entry] of Object.entries(summary)) {
    const spec = WATER_CELLS[cell];
    if (context.arm === "after" && baseSummary && !baseSummary[cell]) {
      // A base report that never measured this cell cannot judge it.
      verdicts.push({
        id: `${cell}:base-absent`,
        pass: false,
        notRun: true,
      });
    }
    if (spec.kind === "mask-pair") {
      const judged =
        context.arm === "after" && entry.waterDialsAbsent.length === 0;
      if (judged && typeof spec.effectCeilingOverOffRepeatPp === "number") {
        // 2f: the effect must stay inside the OFF rig's own repeat noise.
        for (const renderer of ["webgl", "webgpu"]) {
          const value = median(entry.effectPct[renderer]);
          const ceiling =
            (entry.offRepeatPct?.[renderer] ?? 0) +
            spec.effectCeilingOverOffRepeatPp;
          verdicts.push({
            id: `${cell}:2f-effect-ceiling:${renderer}`,
            pass: value !== null && value <= ceiling,
            effectPct: value,
            offRepeatPct: entry.offRepeatPct?.[renderer] ?? null,
            ceilingPct: ceiling,
          });
        }
      }
      if (judged && typeof spec.effectFloorPct === "number") {
        const gl = median(entry.effectPct.webgl);
        const gpu = median(entry.effectPct.webgpu);
        const allowed =
          gl === null || gpu === null
            ? null
            : Math.max(
                bands.effectAgreementRelative * Math.max(gl, gpu),
                bands.effectAgreementAbsolutePp,
              );
        verdicts.push({
          id: `${cell}:2b-effect-agreement`,
          pass: allowed !== null && Math.abs(gl - gpu) <= allowed,
          webglPct: gl,
          webgpuPct: gpu,
          allowedPp: allowed,
        });
        for (const [renderer, value] of [
          ["webgl", gl],
          ["webgpu", gpu],
        ]) {
          verdicts.push({
            id: `${cell}:2c-effect-floor:${renderer}`,
            pass: value !== null && value >= spec.effectFloorPct,
            effectPct: value,
            floorPct: spec.effectFloorPct,
          });
        }
      }
      const base = baseSummary?.[cell];
      if (context.arm === "after" && base) {
        const after = median(entry.parityOnPct);
        const before = median(base.parityOnPct ?? []);
        const spread = range(entry.parityOnPct) ?? 0;
        const bound =
          before === null
            ? null
            : before +
              bands.parityAllowancePp +
              bands.parityRepeatMultiplier * spread;
        verdicts.push({
          id: `${cell}:2a-parity`,
          pass: after !== null && bound !== null && after <= bound,
          afterPct: after,
          beforePct: before,
          allowancePp: bands.parityAllowancePp,
          afterRepeatSpreadPp: spread,
          boundPct: bound,
        });
      }
    } else if (context.arm === "after" && baseSummary?.[cell]) {
      const base = baseSummary[cell];
      const firstOf = (captures, renderer) =>
        captures
          .filter((c) => c.renderer === renderer)
          .sort((a, b) => a.run - b.run)[0] ?? null;
      for (const renderer of ["webgl", "webgpu"]) {
        const tip = firstOf(entry.captures, renderer);
        const was = firstOf(base.captures ?? [], renderer);
        const spread = Math.max(
          entry.repeatPct?.[renderer] ?? 0,
          base.repeatPct?.[renderer] ?? 0,
        );
        const band = Math.max(
          bands.demoFloorPp,
          bands.demoRepeatMultiplier * spread,
        );
        const moved =
          tip && was
            ? mismatchPct(
                loadImage(was.path),
                loadImage(tip.path),
                bands.mismatchTolerance,
              )
            : null;
        verdicts.push({
          id: `${cell}:after-vs-before:${renderer}`,
          pass: moved !== null && moved <= band,
          notRun: moved === null,
          mismatchPct: moved,
          bandPp: band,
        });
      }
      const afterParity = median(entry.parityPct ?? []);
      const beforeParity = median(base.parityPct ?? []);
      const spread = Math.max(
        entry.repeatPct?.webgl ?? 0,
        entry.repeatPct?.webgpu ?? 0,
        base.repeatPct?.webgl ?? 0,
        base.repeatPct?.webgpu ?? 0,
      );
      const band = Math.max(
        bands.demoFloorPp,
        bands.demoRepeatMultiplier * spread,
      );
      if (afterParity === null || beforeParity === null) {
        // No parity on a side is no measurement: NOT RUN, with why. A base
        // report written before `paritySizes` existed gives its sizes from
        // its captures.
        const beforeSizes =
          base.paritySizes ?? demoCaptureSizes(base.captures, loadImage);
        verdicts.push({
          id: `${cell}:parity-as-before`,
          pass: false,
          notRun: true,
          reason: parityNotMeasured(
            afterParity === null ? entry.paritySizes : null,
            beforeParity === null ? beforeSizes : null,
            afterParity === null,
            beforeParity === null,
          ),
          afterPct: afterParity,
          beforePct: beforeParity,
          bandPp: band,
          sizes: {
            after: entry.paritySizes ?? null,
            before: beforeSizes ?? null,
          },
        });
      } else {
        verdicts.push({
          id: `${cell}:parity-as-before`,
          pass: Math.abs(afterParity - beforeParity) <= band,
          afterPct: afterParity,
          beforePct: beforeParity,
          bandPp: band,
        });
      }
    }
    if (context.arm === "after" && spec.waveEpochRepeat === true) {
      for (const [renderer, repeat] of Object.entries(
        entry.waveEpochRepeat ?? {},
      )) {
        const common = {
          id: `${cell}:2g-wave-epoch-repeat:${renderer}`,
          rig: repeat.rig,
          renderer,
          epoch: repeat.epoch,
          repeatPct: repeat.repeatPct,
          bandPp: bands.waveEpochRepeatPp,
        };
        // Every page-level cause is named (A3-2); the run count is the
        // reason only when no page names one.
        const causes = [];
        if (!repeat.applied) {
          causes.push(
            `${WAVE_EPOCH_DIAL} applied: false (${repeat.notApplied.join("; ")})`,
          );
        }
        if ((repeat.refusedBeforeStaging ?? []).length > 0) {
          causes.push(
            `page refused before staging (${repeat.refusedBeforeStaging.join("; ")})`,
          );
        }
        if ((repeat.pageNotRun ?? []).length > 0) {
          causes.push(`ON page NOT RUN (${repeat.pageNotRun.join("; ")})`);
        }
        const requestedRuns = Number.isInteger(context.runs)
          ? context.runs
          : (repeat.runsSeen ?? 0);
        if (causes.length > 0) {
          verdicts.push({
            ...common,
            pass: false,
            notRun: true,
            reason: causes.join("; "),
          });
        } else if (repeat.repeatPct === null) {
          verdicts.push({
            ...common,
            pass: false,
            notRun: true,
            reason:
              requestedRuns >= 2
                ? `2g needs two captured ON runs at the pinned epoch (--runs ${requestedRuns}, ${repeat.capturedRuns ?? 0} captured)`
                : `2g needs --runs 2 or more (this arm ran ${requestedRuns})`,
          });
        } else {
          verdicts.push({
            ...common,
            pass: repeat.repeatPct <= bands.waveEpochRepeatPp,
          });
        }
      }
    }
  }
  return verdicts;
}

function readBaseSummary(options, outputDirectory = null) {
  if (!options.baseReport) {
    return null;
  }
  // Both arms name their captures alike, so an AFTER run writing into the
  // directory that holds the BEFORE report would overwrite the PNGs it is
  // about to compare against.
  if (
    outputDirectory !== null &&
    path.resolve(path.dirname(options.baseReport)) ===
      path.resolve(outputDirectory)
  ) {
    throw new ProbeRefusal(
      "base-report-same-output",
      `${options.baseReport} sits in this run's output directory; give the AFTER arm its own --output`,
      { baseReport: options.baseReport, outputDirectory },
    );
  }
  let base;
  try {
    base = JSON.parse(fs.readFileSync(options.baseReport, "utf8"));
  } catch (error) {
    throw new ProbeRefusal(
      "base-report-unreadable",
      `${options.baseReport}: ${String(error?.message ?? error)}`,
      { baseReport: options.baseReport },
    );
  }
  if (!base || typeof base.summary !== "object" || base.arm !== "before") {
    throw new ProbeRefusal(
      "base-report-invalid",
      `${options.baseReport} is not a water-cells report of a BEFORE arm`,
      { baseReport: options.baseReport },
    );
  }
  return base.summary;
}

function requireArm(options) {
  if (!WATER_ARMS.includes(options.arm)) {
    throw new ProbeRefusal(
      "arm-undeclared",
      `--arm must be one of ${WATER_ARMS.join(", ")}, got ${JSON.stringify(options.arm)}`,
      { arm: options.arm },
    );
  }
  if (options.arm === "before" && options.baseReport) {
    throw new ProbeRefusal(
      "base-report-on-before-arm",
      "--base-report is the AFTER arm's input; a BEFORE arm has no base",
      { baseReport: options.baseReport },
    );
  }
}

function plannedWorkBudgetMs(options) {
  const names = splitList(options.cells ?? Object.keys(WATER_CELLS).join(","));
  let budget = 0;
  for (const name of names) {
    budget +=
      WATER_CELLS[name]?.kind === "sandcastle2-demo"
        ? 2 * DEMO_PAGE_BUDGET_MS
        : 4 * PAGE_BUDGET_MS;
  }
  return Math.max(PAGE_BUDGET_MS, budget);
}

export const descriptor = {
  name: "water-cells",
  title:
    "Water cells - the water landing's leg 2 (great-lakes, coast-50km, orbit-disc, ON and OFF on both renderers) and cell 1f (the globe-materials water-mask demo), with the sheet's bands",
  outputSubdirectory: "water-cells",
  receiptEnvelope: "runtime",
  // The Sandcastle 2 entries are the files cell 1f's run frame loads by name;
  // the app shell's hashed bundle under Apps/Sandcastle2/assets/ has no fixed
  // name, so 1f's served-build assertion covers the demo, not the shell.
  servedArtifacts: [
    "Build/CesiumUnminified/Cesium.js",
    "Build/CesiumUnminified/index.js",
    "packages/engine/Build/Unminified/index.js",
    "Apps/Sandcastle2/standalone.html",
    "Apps/Sandcastle2/templates/bucket.html",
    "Apps/Sandcastle2/templates/Sandcastle.js",
    `Apps/Sandcastle2/gallery/${WATER_DEMO_ID}/index.html`,
    `Apps/Sandcastle2/gallery/${WATER_DEMO_ID}/main.js`,
  ],
  args: {
    extraOptions: [
      {
        flag: "--cells",
        key: "cells",
        kind: "string",
        default: Object.keys(WATER_CELLS).join(","),
      },
      { flag: "--arm", key: "arm", kind: "string", default: "" },
      { flag: "--base-report", key: "baseReport", kind: "string", default: "" },
      {
        flag: "--sandcastle-port",
        key: "sandcastlePort",
        kind: "positive-integer",
      },
      { flag: "--no-ion", key: "noIon", kind: "boolean" },
    ],
  },
  workBudgetMs: (options) => plannedWorkBudgetMs(options),
  // `demoCaptureDependencies` is a spec seam handed to the demo-capture piece
  // (its `dependencies`); the runtime never passes it.
  async cells({
    browser,
    run,
    options,
    origin,
    outputDirectory,
    captures,
    demoCaptureDependencies,
  }) {
    requireArm(options);
    readBaseSummary(options, outputDirectory);
    const rigs = await loadRigs();
    const rigsById = new Map(rigs.map((rig) => [rig.id, rig]));
    const plan = planWaterCells(options, rigsById);
    fs.mkdirSync(outputDirectory, { recursive: true });
    const records = [];
    for (const entry of plan) {
      console.log(
        `[probe-water-cells] ${entry.cell} ${entry.variant} on ${entry.renderer} (run ${run}, arm ${options.arm})`,
      );
      const work = entry.kind === "mask-pair" ? runMaskPage : runDemoPage;
      records.push(
        await work({
          browser,
          origin,
          entry,
          rig: rigsById.get(entry.rigId),
          run,
          options,
          outputDirectory,
          captures,
          demoCaptureDependencies,
        }),
      );
    }
    return records;
  },
  receipt(cells, context) {
    const options = context.options;
    const summary = summarizeWaterRecords(cells);
    for (const [cell, entry] of Object.entries(summary)) {
      console.log(
        `  ${cell}: captures=${entry.captures.length} notRun=${entry.notRun.length}`,
      );
    }
    return {
      arm: options.arm,
      cellsRequested: splitList(options.cells),
      bands: WATER_BANDS,
      baseReport: options.baseReport ? path.resolve(options.baseReport) : null,
      ionDeclaredUnavailable: options.noIon === true,
      pages: cells,
      summary,
    };
  },
  verdicts(cells, context) {
    const options = context.options;
    return waterVerdicts(
      cells,
      summarizeWaterRecords(cells),
      readBaseSummary(options),
      { arm: options.arm, runs: options.runs },
    );
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
