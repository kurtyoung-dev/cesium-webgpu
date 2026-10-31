#!/usr/bin/env node
// Probe: the landing program's Edge cells on the shared runtime - one command
// per cell for the seat's executor, base arm and tip arm.
// @purpose Runs the cloud and water landing program's Edge cells (E-D, E-D-HDR, E-O, E-F, E-G day and night, E-H, R-14, the opt-in E-M-water globe-material capture and the E-T teardown/device-loss cells) from rigs alone on the shared runtime, staging each through lib/landing-cell-stage.mjs, recording the startup timeline, an element capture, the WebGPU error gate and the GPU device census, optionally the PF-1..PF-4 performance windows, and, given a base arm's report and pre-registered bands, the base-vs-tip pixel diff and PF verdicts.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// CELLS (`--cells`, comma-separated; default the standard set without E-T):
//   E-D        default-3d-pinned                          both renderers
//   E-D-HDR    default-3d-hdr                             both renderers
//   E-O        orbital-fulldisc-6608km-msaa4-single-deck  WebGPU
//   E-F        cloud-flight-multideck-hdr-1080p           WebGPU
//   E-G        cloud-underside-noon-cov055                WebGPU
//   E-G-night  cloud-underside-night-cov055               WebGPU
//   E-H        globe-horizon-viewer                       both renderers
//   R-14       sky-only-sun-change (clock steps)          WebGPU
//   E-T-water  water-coast-50km-enhanced-ocean            both renderers
//   E-T-flight cloud-flight-multideck-hdr-1080p           WebGPU
//   E-T-resize globe-msaa4-resize-ladder                  both renderers
//   E-T-skybox skybox-source-swap                         both renderers
//   E-M-water  globe-material-water-mask (off by default) both renderers
// A cell runs on each renderer its rig declares that `--renderer` keeps.
//
// ONE ARM PER INVOCATION. The probe measures the tree its origin serves. The
// base-vs-tip reading is made on the tip run by handing it the base run's
// report (`--base-report`) and the wave's pre-registered bands (`--bands`, a
// JSON file of `lib/metrics/perf-band.mjs` overrides; its sha256 is recorded).
// Same-build repeats are `--runs N` (N >= 2 gives the repeat spread a band
// is sized by).
//
// WHAT A CELL RECORDS. The stage's per-dial read-back (a dial the tree does not
// have reads `applied: false`; a water dial that does so is the BEFORE arm's
// answer, any other one makes the cell NOT RUN), the startup timeline (PF-3),
// the capture, the gate's errors and unexpected losses, the GPU device census
// at the end, and with `--perf` the frame-time window (PF-1), the census
// snapshots around it (PF-4) and the per-pass window (PF-2). E-T cells run two
// pages: the scene staged, provoked and torn down (`viewer.destroy`), then the
// scene staged, provoked and its device forced lost
// (`lib/device-loss-steps.mjs`); `--owner-labels` names the GPU owners whose
// census rows must reach zero live on teardown (released by an explicit
// `destroy()` or with their device; each row says which).
//
// EVERY PAGE IS OFFLINE. The page URL is the rig's page with `renderer` and
// `offline=true` (`lib/performance-viewer-url.mjs`, the kit's URL for
// performance runs): no Cesium World Terrain and no ion base layer, so no PF
// window or pixel diff reads network-streamed tiles, and the stage's
// `terrain` / `imagery` dials are the only terrain and imagery a cell has.
//
// Verdicts carry no measured claim the probe cannot make: a stage that did not
// apply is a failed `stage` verdict (the cell was NOT RUN), and the PF and pixel
// verdicts exist only when a base report is given.
//
// ROUND 4 (seat items F1-F6).
// - MACHINE CPU (F3). Every page record carries `cpu`, the machine CPU sampled
//   at 1 Hz while the page ran (`lib/cpu-sampler.mjs`), and the receipt carries
//   `cpuSeries` over the whole invocation. PF-1..PF-3 read through the
//   pre-registered contention guard (`lib/metrics/perf-band.mjs`): a run whose
//   mean CPU is above `contendedCpuPct` (60 %), or arms whose mean CPU differ
//   by more than `cpuArmDeltaPct` (20 points), read `unmeasured-contended`.
// - INTERLEAVED ARMS (F4). `--merge-reports <a,b,...>` folds earlier
//   single-arm reports of the SAME tree into this invocation's pages before
//   they are grouped (`lib/metrics/merge-landing-reports.mjs`), so B0 A0 B1 A1
//   (each `--runs 1`) gives B1 a two-run base report and A1, with
//   `--merge-reports <A0> --base-report <B1>`, a two-run comparison.
// - PIXEL BAND (F5). `comparison[arm].pixels.verdict`: a WebGPU arm is within
//   only at 0 changed pixels; a WebGL arm at changedPx <= 2 x the same-build
//   repeat floor, the larger of the two arms' run-0-against-run-k changed
//   pixels (the L-08 convention). Reported, not a runtime verdict: which cells
//   claim pixel identity is the wave's pre-registration.
// - TERMINAL (F1). The teardown comparison reads the terminal record through
//   `lib/device-loss-steps.mjs`'s `terminalShape`, so a `viewer.destroy`
//   that throws reads `threw: true` with its message.
// - OWNER LABELS (F6). `--owner-labels` takes exact labels, `prefix:<text>`
//   and `re:<regex>` (`lib/gpu-device-census.mjs`); a malformed one is the
//   refusal `owner-label-invalid` before the first page.
//
// ROUND 5 (seat items K5-1..K5-6). Every capture records the WebGPU pipeline
// cache's pending count (`pipelinesPending`) and the receipt lists each
// capture taken with pipelines pending; `--wait-pipelines` makes the stage
// drive frames until none is pending first (`lib/landing-cell-stage.mjs`,
// `record.pipelines`), and a run that waited is never compared or merged with
// one that did not. Pipeline rows (`lib/gpu-device-census.mjs`) are reported
// in a teardown's owners but never fail `owners-destroyed`: a pipeline has no
// destroy(). The contention guard also reads each run's CPU samples.

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
import { runClockSteps } from "./lib/clock-steps.mjs";
import { installCloudProbeHarness } from "./lib/cloud-probe-harness.mjs";
import { startCpuSampler } from "./lib/cpu-sampler.mjs";
import {
  runDeviceLossSteps,
  sameTerminal,
  terminalShape,
} from "./lib/device-loss-steps.mjs";
import {
  measureLandingPerformance,
  pageMeasureStartup,
  pageReadRendererStatistics,
} from "./lib/frame-timing-steps.mjs";
import {
  GPU_DEVICE_CENSUS_INIT_SOURCE,
  PIPELINE_ROW_KINDS,
  parseOwnerLabel,
  readGpuDeviceCensus,
} from "./lib/gpu-device-census.mjs";
import {
  LANDING_WATER_DIALS,
  capturesWhilePipelinesPending,
  readPendingPipelines,
  stageLandingCell,
} from "./lib/landing-cell-stage.mjs";
import { frameTimeVerdict } from "./lib/metrics/frame-time-distribution.mjs";
import { residencyVerdict } from "./lib/metrics/gpu-memory-residency.mjs";
import {
  PIXEL_PAIR_TOLERANCE,
  pixelBand,
  pixelDiff,
} from "./lib/metrics/landing-pixel-band.mjs";
import {
  groupArms,
  pagesWithMergedRuns as mergedPagesFor,
  readMergeReports as readMergeReportsFor,
} from "./lib/metrics/merge-landing-reports.mjs";
import { passCostVerdict } from "./lib/metrics/gpu-pass-cost.mjs";
import {
  PERF_VERDICTS,
  contentionGuard,
  resolveBands,
} from "./lib/metrics/perf-band.mjs";
import { startupVerdict } from "./lib/metrics/startup-compile.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
  sha256,
} from "./lib/probe-runtime.mjs";
import { buildPerformanceViewerUrl } from "./lib/performance-viewer-url.mjs";
import { loadRigs } from "./lib/rig-registry.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";

// The arm grouping moved to the merge piece (round 4, F4), which reads it too.
export { armKey, groupArms } from "./lib/metrics/merge-landing-reports.mjs";
// The pixel band is its own metric piece (round 4, F5).
export {
  WEBGL_PIXEL_FLOOR_FACTOR,
  pixelBand,
} from "./lib/metrics/landing-pixel-band.mjs";

/** The cell table: cell name -> rig id and what the cell does on it. */
export const LANDING_CELLS = Object.freeze({
  "E-D": Object.freeze({ rig: "default-3d-pinned", kind: "capture" }),
  "E-D-HDR": Object.freeze({ rig: "default-3d-hdr", kind: "capture" }),
  "E-O": Object.freeze({
    rig: "orbital-fulldisc-6608km-msaa4-single-deck",
    kind: "capture",
  }),
  "E-F": Object.freeze({
    rig: "cloud-flight-multideck-hdr-1080p",
    kind: "capture",
  }),
  "E-G": Object.freeze({ rig: "cloud-underside-noon-cov055", kind: "capture" }),
  "E-G-night": Object.freeze({
    rig: "cloud-underside-night-cov055",
    kind: "capture",
  }),
  "E-H": Object.freeze({ rig: "globe-horizon-viewer", kind: "capture" }),
  "R-14": Object.freeze({ rig: "sky-only-sun-change", kind: "clock-steps" }),
  "E-T-water": Object.freeze({
    rig: "water-coast-50km-enhanced-ocean",
    kind: "device-loss",
  }),
  "E-T-flight": Object.freeze({
    rig: "cloud-flight-multideck-hdr-1080p",
    kind: "device-loss",
  }),
  "E-T-resize": Object.freeze({
    rig: "globe-msaa4-resize-ladder",
    kind: "device-loss",
  }),
  "E-T-skybox": Object.freeze({
    rig: "skybox-source-swap",
    kind: "device-loss",
  }),
  // Not in DEFAULT_CELLS: a material-reading-the-tile-water-mask capture the
  // water landing asks for by name (`--cells E-M-water`).
  "E-M-water": Object.freeze({
    rig: "globe-material-water-mask",
    kind: "capture",
  }),
});

/** The default `--cells`: the standard set's capture cells. */
export const DEFAULT_CELLS = Object.freeze([
  "E-D",
  "E-D-HDR",
  "E-O",
  "E-F",
  "E-G",
  "E-G-night",
]);

/** The pages an E-T cell runs, in order. */
export const DEVICE_LOSS_PAGES = Object.freeze(["teardown", "forced-loss"]);

const CANVAS_SELECTOR = ".cesium-widget canvas";
const NAVIGATION_BUDGET_MS = 120_000;
const STARTUP_BUDGET_MS = 120_000;
const STARTUP_MAX_FRAMES = 1200;
const STEPS_BUDGET_MS = 180_000;
const PERF_BUDGET_MS = 180_000;

/**
 * A PF reading that does not exist on this renderer on either arm (the per-pass
 * profiler on WebGL, or on an adapter without `timestamp-query`). It is
 * reported and carries no verdict; an arm where only ONE side lacks it is
 * `unmeasured`, which fails.
 */
export const NOT_APPLICABLE = "not-applicable";

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
 * The (cell, renderer, page) triples a run takes, cell-major, WebGL before
 * WebGPU, and for an E-T cell its two pages in {@link DEVICE_LOSS_PAGES}
 * order.
 *
 * @param {{cells?: string, renderers?: string[]}} options
 * @param {Map<string, object>|Record<string, object>} rigsById
 * @returns {Array<{cell: string, rigId: string, kind: string,
 *   renderer: string, page: string}>}
 * @throws {ProbeRefusal} `cell-unknown` or `cell-rig-absent`.
 */
export function planLandingCells(options, rigsById) {
  const lookup = (id) =>
    rigsById instanceof Map ? rigsById.get(id) : rigsById?.[id];
  const names = splitList(options?.cells ?? DEFAULT_CELLS.join(","));
  const plan = [];
  for (const cell of names) {
    if (!Object.hasOwn(LANDING_CELLS, cell)) {
      throw new ProbeRefusal(
        "cell-unknown",
        `--cells ${cell} is not one of ${Object.keys(LANDING_CELLS).join(", ")}`,
        { cell },
      );
    }
    const { rig: rigId, kind } = LANDING_CELLS[cell];
    const rig = lookup(rigId);
    if (!rig) {
      throw new ProbeRefusal(
        "cell-rig-absent",
        `${cell}: rig ${rigId} is not in the registry`,
        { cell, rigId },
      );
    }
    for (const renderer of ["webgl", "webgpu"]) {
      if (!rig.renderers.includes(renderer)) {
        continue;
      }
      if (
        Array.isArray(options?.renderers) &&
        !options.renderers.includes(renderer)
      ) {
        continue;
      }
      const pages = kind === "device-loss" ? DEVICE_LOSS_PAGES : ["scene"];
      for (const page of pages) {
        plan.push({ cell, rigId, kind, renderer, page });
      }
    }
  }
  return plan;
}

/**
 * The dials whose read-back failed and that make a cell NOT RUN: every dial
 * that did not apply except the water dials, whose `applied: false` is how a
 * tree without the water batch answers. Pure.
 *
 * @param {object} staged `stageLandingCellInPage`'s answer.
 * @returns {string[]}
 */
export function blockingDials(staged) {
  return (staged?.notApplied ?? []).filter(
    (key) => !LANDING_WATER_DIALS.includes(key),
  );
}

/** Render `frames` frames at the frozen clock. Runs in the page. */
async function pageRenderFrames({ frames }) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  for (let i = 0; i < frames; i++) {
    viewer.scene.render(viewer.clock.currentTime);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return frames;
}

/** Page time now (milliseconds since navigation start). Runs in the page. */
function pageNow() {
  return performance.now();
}

function pageLinesFrom(diagnostics) {
  return [
    ...diagnostics.console.map((m) => ({
      seq: m.seq,
      type: m.type,
      text: m.text,
    })),
    ...diagnostics.errors.map((m) => ({
      seq: m.seq,
      type: "pageerror",
      text: m.text,
    })),
  ].sort((a, b) => a.seq - b.seq);
}

function settleFramesOf(rig) {
  if (rig.readiness?.kind === "settleFrames") {
    return rig.readiness.frames;
  }
  // A settleMs rig renders at about 60 frames a second for its time.
  return Math.max(1, Math.round(((rig.readiness?.ms ?? 1000) / 1000) * 60));
}

/** One planned (cell, renderer, page) on one fresh browser context. */
async function runLandingPage({
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
    rig: rig.id,
    kind: entry.kind,
    renderer: entry.renderer,
    page: entry.page,
    notRun: null,
  };
  // The machine CPU over this page, whatever way it ends (F3).
  const cpuSampler = startCpuSampler();
  const context = await browser.newContext({
    viewport: { ...rig.viewport },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    const diagnostics = attachPageDiagnostics(page);
    try {
      await page.addInitScript(errorGateInit);
      await page.addInitScript({ content: GPU_DEVICE_CENSUS_INIT_SOURCE });
      await page.addInitScript(installCloudProbeHarness);
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
      const viewerReadyAtMs = await page.evaluate(pageNow);
      record.armed = await armWebGPUDevices(page);

      const { staged, pipelines } = await stageLandingCell({
        page,
        rig,
        waitForPendingPipelines: options.waitPipelines === true,
      });
      record.stage = staged;
      record.pipelines = pipelines;
      const blocking = blockingDials(staged);
      if (blocking.length > 0) {
        record.notRun = `the stage did not apply ${blocking.join(", ")}`;
        return record;
      }
      const stagedAtMs = await page.evaluate(pageNow);
      const expectClouds =
        entry.renderer === "webgpu" &&
        staged.dials.cloudsEnabled?.observed === true;
      record.startup = await page.evaluate(pageMeasureStartup, {
        maxFrames: STARTUP_MAX_FRAMES,
        deadlineMs: STARTUP_BUDGET_MS,
        expectClouds,
        stagedAtMs,
        viewerReadyAtMs,
      });
      record.compileAtStartup = (await readGpuDeviceCensus(page)).compile;
      record.rendererStatistics = await page.evaluate(
        pageReadRendererStatistics,
      );
      const settle = (frames) => page.evaluate(pageRenderFrames, { frames });
      await settle(settleFramesOf(rig));

      const base = `${entry.cell}-${entry.renderer}-run${run}`;
      const capture = async (name) => {
        const widgets = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
        if (
          !Array.isArray(widgets?.leftovers) ||
          widgets.leftovers.length > 0
        ) {
          throw new ProbeRefusal(
            "capture-chrome-over-canvas",
            `${name}: the viewer chrome strip left ${JSON.stringify(widgets?.leftovers ?? null)} over the scene canvas`,
            { widgets: widgets ?? null },
          );
        }
        const shot = await captureElement({
          page,
          selector: CANVAS_SELECTOR,
          name,
          outputDirectory,
          captures,
        });
        const image = decodePng(shot.buffer);
        // K5-2: a frame captured while pipelines compile shows the compile.
        const { pending } = await readPendingPipelines(page);
        if (record.pipelines) {
          record.pipelines.pendingAtCapture = pending;
        }
        return {
          name: shot.name,
          path: path.resolve(shot.path),
          sha256: shot.sha256,
          width: image.width,
          height: image.height,
          liveness: shot.liveness,
          pipelinesPending: pending,
        };
      };

      if (entry.kind === "capture") {
        record.capture = await capture(base);
      } else if (entry.kind === "clock-steps") {
        record.captureStart = await capture(`${base}-start`);
        record.steps = await runClockSteps({ page, rig, settle });
        record.capture = await capture(`${base}-end`);
      }

      if (options.perf === true && entry.kind !== "device-loss") {
        record.perf = await measureLandingPerformance({
          page,
          readCensus: readGpuDeviceCensus,
          frames: options.frames,
          warmupFrames: options.warmup,
          passFrames: options.passFrames,
        });
      }

      if (entry.kind === "device-loss") {
        if (entry.page === "teardown") {
          record.capture = await capture(base);
        }
        record.deviceLoss = await runDeviceLossSteps({
          page,
          rig,
          settle,
          mode: entry.page,
          readCensus: readGpuDeviceCensus,
          ownerLabels: readOwnerLabels(options),
          readPageLines: () => pageLinesFrom(diagnostics),
        });
      } else {
        record.census = await readGpuDeviceCensus(page);
      }
      const gate = await collectGateErrors(page);
      record.gate = {
        deviceLost: gate.deviceLost,
        errorCount: gate.errors.length,
        errors: gate.errors.slice(0, 10),
        armedDevices: gate.armedDevices,
      };
      const lines = pageLinesFrom(diagnostics);
      record.console = {
        errors: lines.filter((l) => l.type === "error").length,
        pageErrors: lines.filter((l) => l.type === "pageerror").length,
        first: lines
          .filter((l) => l.type === "error" || l.type === "pageerror")
          .slice(0, 10)
          .map((l) => `${l.type}: ${String(l.text).slice(0, 300)}`),
      };
      return record;
    } finally {
      diagnostics.detach();
    }
  } finally {
    await context.close();
    record.cpu = cpuSampler.stop();
  }
}

/**
 * The PF verdicts and the first-capture pixel diff of every arm the base
 * report also has. Reads the base PNGs from the paths the base report records.
 *
 * @param {Record<string, object>} tipArms {@link groupArms} of this run set.
 * @param {Record<string, object>} baseArms The base report's `arms`.
 * @param {object} bands Resolved bands.
 * @param {{startupField?: string}} [options]
 * @returns {Record<string, object>} Per arm key.
 */
export function compareArms(tipArms, baseArms, bands, options = {}) {
  const out = {};
  for (const [key, tip] of Object.entries(tipArms)) {
    const base = baseArms?.[key];
    if (!base) {
      out[key] = { base: "absent" };
      continue;
    }
    const comparison = {};
    // The pre-registered contention guard over this arm pair's runs (F3).
    const contention = contentionGuard({
      baseCpu: base.inputs.cpu,
      tipCpu: tip.inputs.cpu,
      baseSamples: base.inputs.cpuSamples ?? [],
      tipSamples: tip.inputs.cpuSamples ?? [],
      bands,
    });
    if (tip.inputs.pf3.length > 0 || base.inputs.pf3.length > 0) {
      comparison.contention = contention;
      comparison.pf3 = startupVerdict({
        baseRuns: base.inputs.pf3,
        tipRuns: tip.inputs.pf3,
        bands,
        field: options.startupField || undefined,
        contention,
      });
    }
    if (tip.inputs.pf1.length > 0 || base.inputs.pf1.length > 0) {
      comparison.contention = contention;
      comparison.pf1 = frameTimeVerdict({
        baseRuns: base.inputs.pf1,
        tipRuns: tip.inputs.pf1,
        bands,
        contention,
      });
      const unavailable = (runs) =>
        runs.length > 0 && runs.every((run) => run?.available === false);
      comparison.pf2 =
        unavailable(base.inputs.pf2) && unavailable(tip.inputs.pf2)
          ? {
              metric: "PF-2",
              verdict: NOT_APPLICABLE,
              reason: `the per-pass profiler is unavailable on both arms (${tip.inputs.pf2[0].reason})`,
            }
          : passCostVerdict({
              baseRuns: base.inputs.pf2,
              tipRuns: tip.inputs.pf2,
              bands,
              contention,
            });
      comparison.pf4 = residencyVerdict({
        baseRuns: base.inputs.pf4,
        tipRuns: tip.inputs.pf4,
        bands,
      });
    }
    const baseShot = base.captures?.[0];
    const tipShot = tip.captures?.[0];
    if (baseShot && tipShot) {
      const diff = pixelDiff(baseShot, tipShot);
      if (!diff.measured) {
        comparison.pixels = diff;
      } else {
        const renderer = tip.renderer ?? key.split("|")[1];
        const band = pixelBand({
          renderer,
          changedPx: diff.changedPx,
          baseArm: base,
          tipArm: tip,
        });
        comparison.pixels = {
          measured: true,
          base: baseShot.name,
          tip: tipShot.name,
          tolerance: PIXEL_PAIR_TOLERANCE,
          changedPx: diff.changedPx,
          mismatchPct: diff.mismatchPct,
          bbox: diff.bbox,
          verdict: band.verdict,
          band,
        };
      }
    }
    if (tip.deviceLoss.length > 0 && base.deviceLoss.length > 0) {
      // One reader of the terminal record, any mode (F1).
      const shape = (entry) => terminalShape(entry.terminal);
      comparison.terminal = {
        base: base.deviceLoss.map(shape),
        tip: tip.deviceLoss.map(shape),
        same: sameTerminal(shape(base.deviceLoss[0]), shape(tip.deviceLoss[0])),
        baseOtherConsoleErrors: Math.max(
          ...base.deviceLoss.map((e) => e.consoleErrors?.other?.length ?? 0),
        ),
        tipOtherConsoleErrors: Math.max(
          ...tip.deviceLoss.map((e) => e.consoleErrors?.other?.length ?? 0),
        ),
      };
    }
    out[key] = comparison;
  }
  return out;
}

/**
 * The run's verdicts. Pure over the page records and the comparison.
 *
 * @param {object[]} records
 * @param {Record<string, object>|null} comparison
 * @returns {Array<{id: string, pass: boolean}>}
 */
export function landingVerdicts(records, comparison) {
  const verdicts = [];
  for (const record of records) {
    const id = `${record.cell}:${record.renderer}:${record.page}:run${record.run}`;
    verdicts.push({
      id: `${id}:stage`,
      pass: record.notRun === null,
      notRun: record.notRun !== null,
      reason: record.notRun ?? undefined,
    });
    if (record.notRun !== null) {
      continue;
    }
    const lost = record.deviceLoss
      ? record.deviceLoss.deviceLost
      : record.gate?.deviceLost;
    verdicts.push({
      id: `${id}:no-unexpected-device-loss`,
      pass: !lost,
      deviceLost: lost ?? null,
    });
    if (record.deviceLoss) {
      const owners = record.deviceLoss.owners?.after ?? [];
      const pageErrors = record.deviceLoss.consoleErrors?.pageErrors ?? [];
      verdicts.push({
        id: `${id}:no-uncaught-error`,
        pass: pageErrors.length === 0,
        pageErrors,
      });
      if (record.page === "teardown") {
        // Released means live 0, by an explicit destroy() or with the device;
        // each seen row says which, so the sheet can tell them apart.
        const seen = owners.filter((row) => row.seen);
        // A pipeline has no destroy(): reported, never a failure (K5-3).
        const live = seen.filter(
          (row) => row.live > 0 && !PIPELINE_ROW_KINDS.includes(row.kind),
        );
        verdicts.push({
          id: `${id}:owners-destroyed`,
          pass: live.length === 0,
          live,
          owners: seen.map((row) => ({
            label: row.label,
            kind: row.kind,
            created: row.created,
            destroyed: row.destroyed,
            freedByDevice: row.freedByDevice ?? 0,
            live: row.live,
          })),
        });
      }
    }
  }
  for (const [key, arm] of Object.entries(comparison ?? {})) {
    for (const pf of ["pf1", "pf2", "pf3", "pf4"]) {
      if (arm[pf] && arm[pf].verdict !== NOT_APPLICABLE) {
        const unmeasured =
          arm[pf].verdict === PERF_VERDICTS.UNMEASURED ||
          arm[pf].verdict === PERF_VERDICTS.UNMEASURED_CONTENDED;
        verdicts.push({
          id: `${key}:${arm[pf].metric}`,
          pass: arm[pf].verdict === PERF_VERDICTS.WITHIN,
          verdict: arm[pf].verdict,
          // An unmeasured statistic is NOT RUN, never a pass (D4).
          ...(unmeasured ? { notRun: true } : {}),
        });
      }
    }
    if (arm.terminal) {
      verdicts.push({
        id: `${key}:terminal-as-base`,
        pass:
          arm.terminal.same &&
          arm.terminal.tipOtherConsoleErrors <=
            arm.terminal.baseOtherConsoleErrors,
        terminal: arm.terminal,
      });
    }
  }
  return verdicts;
}

/**
 * The owner specs `--owner-labels` names, each checked. Pure. Unlike
 * {@link splitList} a spec keeps its trailing characters, so a prefix may end
 * in a space (`prefix:Globe `); only the space after a comma is dropped. A
 * comma always separates specs, so a `re:` pattern cannot contain one.
 *
 * @param {{ownerLabels?: string}} options
 * @returns {string[]}
 * @throws {ProbeRefusal} `owner-label-invalid`.
 */
export function readOwnerLabels(options) {
  const specs = String(options?.ownerLabels ?? "")
    .split(",")
    .map((item) => item.trimStart())
    .filter((item) => item.trim().length > 0);
  for (const spec of specs) {
    try {
      parseOwnerLabel(spec);
    } catch (error) {
      throw new ProbeRefusal("owner-label-invalid", String(error.message), {
        spec,
      });
    }
  }
  return specs;
}

/**
 * The earlier single-arm reports `--merge-reports` names, checked against this
 * tree (F4; `lib/metrics/merge-landing-reports.mjs`). Node only.
 *
 * @param {object} options
 * @returns {Array<{path: string, sha256: string, report: object}>}
 */
export function readMergeReports(options) {
  return readMergeReportsFor(options, descriptor.servedArtifacts);
}

/**
 * This invocation's pages with the `--merge-reports` runs before them (F4).
 *
 * @param {object[]} cells
 * @param {object} options
 * @param {Array<{path: string, report: object}>} priors
 * @returns {object[]}
 */
export function pagesWithMergedRuns(cells, options, priors) {
  return mergedPagesFor(cells, options, priors, descriptor.servedArtifacts);
}

/**
 * Read the base report and the bands file named by the options. Node only.
 *
 * @param {{baseReport?: string, bands?: string}} options
 * @returns {{base: object|null, bands: object, bandsFile: object|null}}
 */
export function readComparisonInputs(options) {
  let bandsFile = null;
  let overrides = {};
  if (options.bands) {
    const bytes = fs.readFileSync(options.bands);
    overrides = JSON.parse(bytes.toString("utf8"));
    bandsFile = { path: path.resolve(options.bands), sha256: sha256(bytes) };
  }
  const bands = resolveBands(overrides);
  let base = null;
  if (options.baseReport) {
    base = JSON.parse(fs.readFileSync(options.baseReport, "utf8"));
    if (!base || typeof base.arms !== "object") {
      throw new ProbeRefusal(
        "base-report-invalid",
        `${options.baseReport} carries no arms; it is not a landing-cells report`,
        { baseReport: options.baseReport },
      );
    }
    if (
      (base.waitForPendingPipelines === true) !==
      (options.waitPipelines === true)
    ) {
      throw new ProbeRefusal(
        "base-report-invalid",
        `${options.baseReport} has waitForPendingPipelines ${base.waitForPendingPipelines === true}, this run ${options.waitPipelines === true}: the startup timelines are not comparable`,
        { baseReport: options.baseReport },
      );
    }
    // Regrouped with this tree's grouping, so the arms carry every input the
    // comparison reads (the CPU samples, K5-6) from the pages the report holds.
    if (Array.isArray(base.pages)) {
      base.arms = groupArms(base.pages);
    }
  }
  return { base, bands, bandsFile };
}

function plannedPageCount(options) {
  try {
    const ids = new Set(splitList(options.cells ?? DEFAULT_CELLS.join(",")));
    return Math.max(1, ids.size * 4);
  } catch {
    return DEFAULT_CELLS.length * 2;
  }
}

/** The whole invocation's machine-CPU sampler (F3); stopped by the receipt. */
let invocationCpu = null;

const PAGE_BUDGET_MS =
  NAVIGATION_BUDGET_MS + STARTUP_BUDGET_MS + STEPS_BUDGET_MS + PERF_BUDGET_MS;

export const descriptor = {
  name: "landing-cells",
  title:
    "Landing cells - the cloud and water landing program's Edge cells (E-D, E-D-HDR, E-O, E-F, E-G, E-H, R-14, E-T) with the PF-1..PF-4 performance leg",
  outputSubdirectory: "landing-cells",
  receiptEnvelope: "runtime",
  servedArtifacts: [
    "Build/CesiumUnminified/Cesium.js",
    "Build/CesiumUnminified/index.js",
    "packages/engine/Build/Unminified/index.js",
  ],
  args: {
    extraOptions: [
      {
        flag: "--cells",
        key: "cells",
        kind: "string",
        default: DEFAULT_CELLS.join(","),
      },
      { flag: "--perf", key: "perf", kind: "boolean" },
      { flag: "--wait-pipelines", key: "waitPipelines", kind: "boolean" },
      {
        flag: "--frames",
        key: "frames",
        kind: "positive-integer",
        default: 120,
      },
      {
        flag: "--warmup",
        key: "warmup",
        kind: "positive-integer",
        default: 30,
      },
      {
        flag: "--pass-frames",
        key: "passFrames",
        kind: "positive-integer",
        default: 60,
      },
      {
        flag: "--owner-labels",
        key: "ownerLabels",
        kind: "string",
        default: "",
      },
      { flag: "--base-report", key: "baseReport", kind: "string", default: "" },
      {
        flag: "--merge-reports",
        key: "mergeReports",
        kind: "string",
        default: "",
      },
      { flag: "--bands", key: "bands", kind: "string", default: "" },
      {
        flag: "--startup-field",
        key: "startupField",
        kind: "string",
        default: "",
      },
    ],
  },
  workBudgetMs: (options) => plannedPageCount(options) * PAGE_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    // Fail before the first page on inputs that cannot be read.
    readComparisonInputs(options);
    readOwnerLabels(options);
    readMergeReports(options);
    if (run === 0) {
      invocationCpu?.stop();
      invocationCpu = startCpuSampler();
    }
    const rigs = await loadRigs();
    const rigsById = new Map(rigs.map((rig) => [rig.id, rig]));
    const plan = planLandingCells(options, rigsById);
    fs.mkdirSync(outputDirectory, { recursive: true });
    const records = [];
    for (const entry of plan) {
      console.log(
        `[probe-landing-cells] ${entry.cell} ${entry.page} on ${entry.renderer} (run ${run})`,
      );
      records.push(
        await runLandingPage({
          browser,
          origin,
          entry,
          rig: rigsById.get(entry.rigId),
          run,
          options,
          outputDirectory,
          captures,
        }),
      );
    }
    return records;
  },
  receipt(cells, context) {
    const options = context.options;
    const { base, bands, bandsFile } = readComparisonInputs(options);
    const priors = readMergeReports(options);
    const pages = pagesWithMergedRuns(cells, options, priors);
    const arms = groupArms(pages);
    const cpuSeries = invocationCpu ? invocationCpu.stop() : null;
    invocationCpu = null;
    const comparison = base
      ? compareArms(arms, base.arms, bands, {
          startupField: options.startupField,
        })
      : null;
    for (const [key, arm] of Object.entries(arms)) {
      console.log(
        `  ${key}: runs=${arm.runs} notRun=${arm.notRun.length} captures=${arm.captures.length}`,
      );
    }
    return {
      cellsRequested: splitList(options.cells),
      perf: options.perf === true,
      waitForPendingPipelines: options.waitPipelines === true,
      capturesWhilePipelinesPending: capturesWhilePipelinesPending(pages),
      windows: {
        frames: options.frames,
        warmup: options.warmup,
        passFrames: options.passFrames,
      },
      ownerLabels: readOwnerLabels(options),
      bands,
      bandsFile,
      baseReport: options.baseReport ? path.resolve(options.baseReport) : null,
      mergedReports: priors.map((prior) => ({
        path: prior.path,
        sha256: prior.sha256,
        generatedAt: prior.report.generatedAt ?? null,
        runs: prior.report.options?.runs ?? null,
      })),
      cpuSeries,
      pages,
      arms,
      comparison,
    };
  },
  verdicts(cells, context) {
    const { base, bands } = readComparisonInputs(context.options);
    const pages = pagesWithMergedRuns(
      cells,
      context.options,
      readMergeReports(context.options),
    );
    const comparison = base
      ? compareArms(groupArms(pages), base.arms, bands, {
          startupField: context.options.startupField,
        })
      : null;
    return landingVerdicts(pages, comparison);
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
