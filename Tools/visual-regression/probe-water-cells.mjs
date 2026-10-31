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
// CAPTURE CELLS (opt-in by `--cells`, never in the default run; `WATER_CAPTURE_CELLS`).
// The water bookmark rigs and the offline Kauai shelf pair are staged,
// settled and element-captured exactly as a leg-2 page is, and sheeted through
// the capture manifest, but carry NO band: the receipt lists their captures and
// NOT RUN pages under `captureCells`, and the verdicts judge only each page's
// stage and its 2e device-fault gate.
//   bookmark-bahamas-photic-dive  water-bookmark-bahamas-photic-dive (WebGPU only)
//   bookmark-cairo-nile           water-bookmark-cairo-nile
//   bookmark-ilulissat-ice        water-bookmark-ilulissat-ice
//   bookmark-kauai-reef           water-bookmark-kauai-reef
//   bookmark-mariana-trench       water-bookmark-mariana-trench
//   bookmark-sunset-glint         water-bookmark-sunset-glint (a later sun-glint check reads it)
//   bathymetry-offline            water-bathymetry-offline / water-bathymetry-offline-off
//   bookmark-global-water-weather water-bookmark-global-water-weather (the Sandcastle 2
//                                 demo webgpu-global-water-weather; NOT RUN under --no-ion)
// The mask-page rigs set terrain "ellipsoid" and local imagery, so they need no
// ion; the one demo rig needs it, and the demo piece makes it NOT RUN.
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
// THE CAPTURE MANIFEST. The receipt writes `capture-manifest.json` and its
// images beside the report (`lib/water-capture-manifest.mjs`, over the
// builder in `lib/landing-capture-manifest.mjs`) so `contact-sheet.mjs
// --manifest` can sheet the run: one entry per (cell, ON/OFF/demo page), BEFORE
// from `--base-report` (UNMEASURED, "no --base-report", without one). The
// manifest is refused, not partly written, when it fails validation; the
// receipt's `captureManifest` says which.
//
// THE WAVE EPOCH DIAL. `lib/landing-cell-stage.mjs` applies a dial it knows
// and refuses one it does not (`rig-dial-unsupported`, in Node). Until its
// handler for `waterSimulationEpoch` lands (KT round 5), this probe asks the
// stage whether it takes the dial; where it does not, the page is staged
// without it and the epoch is recorded `applied: false` with that reason, so
// leg 2 still runs and only 2g reads NOT RUN.
//
// TWO PIECES (DX-KIT-DECOMPOSE-RUNTIME-WATER). The cell table, the bands and
// the pure planning (`WATER_CELLS`, `WATER_BANDS`, `planWaterCells`,
// `stageGaps`, `waterStagePlan`, `waveEpochReadback`, ...) live in
// `lib/water-cell-table.mjs`; the metrics reducer and the band verdicts
// (`summarizeWaterRecords`, `waterVerdicts`, `mismatchPct`,
// `parityNotMeasured`) in `lib/water-cell-verdicts.mjs`. This probe keeps the
// browser: the page runners, the base-report reader, the served-build list and
// the descriptor, and re-exports every name it exported before.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";
import { decodePng } from "../lib/png-decode.mjs";
import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { captureUrlFor } from "./lib/capture.mjs";
import { stageLandingCell } from "./lib/landing-cell-stage.mjs";
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
import {
  WATER_ARMS,
  WATER_BANDS,
  WATER_CELLS,
  WATER_DEFAULT_CELLS,
  WATER_DEMO_ID,
  WAVE_EPOCH_DIAL,
  isWaterCaptureCell,
  planWaterCells,
  splitList,
  stageGaps,
  stageHandlesDial,
  summarizeCaptureCells,
  usesDemoPage,
  waterCellGalleryId,
  waterCellSpec,
  waterStagePlan,
  waveEpochReadback,
} from "./lib/water-cell-table.mjs";
import {
  mismatchPct,
  parityNotMeasured,
  summarizeWaterRecords,
  waterVerdicts,
} from "./lib/water-cell-verdicts.mjs";
import {
  waterCellsBaseReport,
  waterCellsManifestPages,
  writeWaterProbeManifest,
} from "./lib/water-capture-manifest.mjs";

// The cell table and its pure planning moved to a piece, and the metrics
// reducer and band verdicts to another (DX-KIT-DECOMPOSE-RUNTIME-WATER); every
// name this probe exported before is still exported from here.
export {
  WATER_ARMS,
  WATER_BANDS,
  WATER_CELLS,
  WATER_DEMO_ID,
  WAVE_EPOCH_DIAL,
  mismatchPct,
  parityNotMeasured,
  planWaterCells,
  splitList,
  stageGaps,
  stageHandlesDial,
  summarizeWaterRecords,
  waterStagePlan,
  waterVerdicts,
  waveEpochReadback,
};

const CANVAS_SELECTOR = ".cesium-widget canvas";
const NAVIGATION_BUDGET_MS = 120_000;
const SETTLE_BUDGET_MS = 180_000;
const STABLE_TILE_FRAMES = 30;
const MIN_SETTLE_MS = 1500;
const MAX_TILE_FRAMES = 6000;
const PAGE_BUDGET_MS = 2 * NAVIGATION_BUDGET_MS + SETTLE_BUDGET_MS + 60_000;
const DEMO_PAGE_BUDGET_MS = 600_000;

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
          // The capture-seam manifest records what was fetched and when.
          url: url.href,
          capturedAt: new Date().toISOString(),
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
        record.capture = {
          ...result.capture,
          url: result.urls?.page ?? null,
          capturedAt: new Date().toISOString(),
        };
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

/** The parsed BEFORE report `--base-report` names, or null without one. */
function readBaseDocument(options, outputDirectory = null) {
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
  return base;
}

function readBaseSummary(options, outputDirectory = null) {
  return readBaseDocument(options, outputDirectory)?.summary ?? null;
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
  const names = splitList(options.cells ?? WATER_DEFAULT_CELLS.join(","));
  let budget = 0;
  for (const name of names) {
    const kind = waterCellSpec(name)?.kind;
    // A single bookmark rig is at most two pages (one per renderer).
    budget += usesDemoPage(kind)
      ? 2 * DEMO_PAGE_BUDGET_MS
      : (kind === "capture-single" ? 2 : 4) * PAGE_BUDGET_MS;
  }
  return Math.max(PAGE_BUDGET_MS, budget);
}

const ENGINE_SERVED_ARTIFACTS = Object.freeze([
  "Build/CesiumUnminified/Cesium.js",
  "Build/CesiumUnminified/index.js",
  "packages/engine/Build/Unminified/index.js",
]);

const SANDCASTLE2_SHELL_ARTIFACTS = Object.freeze([
  "Apps/Sandcastle2/standalone.html",
  "Apps/Sandcastle2/templates/bucket.html",
  "Apps/Sandcastle2/templates/Sandcastle.js",
]);

const galleryArtifacts = (galleryId) => [
  `Apps/Sandcastle2/gallery/${galleryId}/index.html`,
  `Apps/Sandcastle2/gallery/${galleryId}/main.js`,
];

const SANDCASTLE2_SERVED_ARTIFACTS = Object.freeze([
  ...SANDCASTLE2_SHELL_ARTIFACTS,
  ...galleryArtifacts(WATER_DEMO_ID),
]);

/**
 * The served-build artifacts a run must match: the engine bundles always, the
 * Sandcastle 2 shell and each requested demo's gallery files only when the
 * cell list (default: every banded cell) has a demo cell (1f, or a
 * capture-demo).
 *
 * @param {{cells?: string}} options
 * @returns {string[]}
 */
export function servedArtifactsForCells(options) {
  const names = splitList(options?.cells ?? WATER_DEFAULT_CELLS.join(","));
  const banded = servedArtifactsForBandedCells(names);
  const galleries = [
    ...new Set(
      names
        .filter(isWaterCaptureCell)
        .map(waterCellGalleryId)
        .filter((id) => id !== null),
    ),
  ];
  if (galleries.length === 0) {
    return banded;
  }
  return [
    ...banded,
    ...(banded.includes(SANDCASTLE2_SHELL_ARTIFACTS[0])
      ? []
      : SANDCASTLE2_SHELL_ARTIFACTS),
    ...galleries.flatMap(galleryArtifacts),
  ];
}

/** The engine bundles, and cell 1f's Sandcastle 2 files when 1f is requested. */
function servedArtifactsForBandedCells(names) {
  return names.includes("1f")
    ? [...ENGINE_SERVED_ARTIFACTS, ...SANDCASTLE2_SERVED_ARTIFACTS]
    : [...ENGINE_SERVED_ARTIFACTS];
}

/** The records the sheet's bands judge: every page except a capture cell's. */
const bandedRecords = (cells) =>
  cells.filter((record) => !isWaterCaptureCell(record.cell));

/** The rig registry the pages ran from, for the receipt's capture manifest. */
let invocationRigs = null;

export const descriptor = {
  name: "water-cells",
  title:
    "Water cells - the water landing's leg 2 (great-lakes, coast-50km, orbit-disc, ON and OFF on both renderers) and cell 1f (the globe-materials water-mask demo), with the sheet's bands",
  outputSubdirectory: "water-cells",
  receiptEnvelope: "runtime",
  // The Sandcastle 2 entries are the files cell 1f's run frame loads by name;
  // the app shell's hashed bundle under Apps/Sandcastle2/assets/ has no fixed
  // name, so 1f's served-build assertion covers the demo, not the shell. They
  // are demanded ONLY when the run includes 1f (the default --cells does, as it
  // is every WATER_CELLS key): a run of the globe cells alone must not refuse
  // on a tree whose Sandcastle 2 was never built.
  servedArtifacts: (options) => servedArtifactsForCells(options),
  args: {
    extraOptions: [
      {
        flag: "--cells",
        key: "cells",
        kind: "string",
        default: WATER_DEFAULT_CELLS.join(","),
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
    invocationRigs = rigsById;
    const plan = planWaterCells(options, rigsById);
    fs.mkdirSync(outputDirectory, { recursive: true });
    const records = [];
    for (const entry of plan) {
      console.log(
        `[probe-water-cells] ${entry.cell} ${entry.variant} on ${entry.renderer} (run ${run}, arm ${options.arm})`,
      );
      const work = usesDemoPage(entry.kind) ? runDemoPage : runMaskPage;
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
    const summary = summarizeWaterRecords(bandedRecords(cells));
    const captureCells = summarizeCaptureCells(cells);
    for (const [cell, entry] of Object.entries(summary)) {
      console.log(
        `  ${cell}: captures=${entry.captures.length} notRun=${entry.notRun.length}`,
      );
    }
    // The capture-seam manifest contact-sheet.mjs reads (refused, not written,
    // when it would not validate; the receipt says which). A base report that
    // cannot be read now costs the manifest its BEFORE, never the run.
    let captureManifest = null;
    if (context.outputDirectory) {
      let baseDocument = null;
      let baseReportError = null;
      try {
        baseDocument = readBaseDocument(options);
      } catch (error) {
        baseReportError = String(error?.message ?? error);
      }
      captureManifest = {
        ...writeWaterProbeManifest({
          probe: descriptor.name,
          pages: waterCellsManifestPages(cells),
          baseReport: waterCellsBaseReport(baseDocument),
          rigsById: invocationRigs,
          context,
        }),
        ...(baseReportError && { baseReportError }),
      };
    }
    return {
      arm: options.arm,
      cellsRequested: splitList(options.cells),
      bands: WATER_BANDS,
      baseReport: options.baseReport ? path.resolve(options.baseReport) : null,
      ionDeclaredUnavailable: options.noIon === true,
      pages: cells,
      summary,
      ...(Object.keys(captureCells).length > 0 && { captureCells }),
      captureManifest,
    };
  },
  verdicts(cells, context) {
    const options = context.options;
    // Every page keeps its stage and 2e verdicts; the bands read the banded
    // cells' summary alone, so a capture cell is never judged against one.
    return waterVerdicts(
      cells,
      summarizeWaterRecords(bandedRecords(cells)),
      readBaseSummary(options),
      { arm: options.arm, runs: options.runs },
    );
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
