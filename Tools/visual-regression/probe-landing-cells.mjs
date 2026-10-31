#!/usr/bin/env node
// Probe: the landing program's Edge cells on the shared runtime - one command
// per cell for the seat's executor, base arm and tip arm.
// @purpose Runs the cloud and water landing program's Edge cells (E-D, E-D-HDR, E-O, E-F, E-G day and night, E-H, R-14, the opt-in E-M-water globe-material capture, the opt-in 2D and Columbus-view identity cells E-ID-2d / E-ID-cv, the Chukotka cross-renderer cell E-C-chukotka, the FFT-ocean kernel-identity cell E-FFT-ifft and the E-T teardown/device-loss cells) from rigs alone on the shared runtime, staging each through lib/landing-cell-stage.mjs with a per-cell pending-pipeline wait, recording the startup timeline, an element capture, the WebGPU error gate and the GPU device census, the window.onmessage sentinel on identity cells (with an opt-in in-run positive control), the ocean displacement readback per kernel at wave time 0 and at an evolved clock, the ocean compute pass a PF-2 window must list, optionally the PF-1..PF-4 performance windows, a capture-seam manifest for contact-sheet.mjs, and, given a base arm's report and pre-registered bands, the base-vs-tip pixel diff and PF verdicts.
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
//   E-ID-2d    default-2d-pinned (off by default)         both renderers
//   E-ID-cv    default-columbus-pinned (off by default)   both renderers
//   E-C-chukotka water-antimeridian-chukotka (off by default) both renderers
//   E-FFT-ifft ocean-fft-patch-rebase, one page per kernel  WebGPU
// A cell runs on each renderer its rig declares that `--renderer` keeps. The
// table and its planning live in `lib/landing-cell-table.mjs`.
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
//
// LANE LINDISSE (the salvage-night NOT RUN cells).
// - PER-CELL PIPELINE WAIT. The identity cells (E-D, E-D-HDR, E-ID-2d,
//   E-ID-cv), E-M-water, E-C-chukotka and E-FFT-ifft wait for pending
//   pipelines by default; `--wait-pipelines` forces the wait on every cell and
//   `--no-wait-pipelines` is the recorded waiver. The receipt carries
//   `pipelineWait` {mode, byCell}; base and merged reports must match per cell.
// - THE ONMESSAGE SENTINEL. Every identity cell installs
//   `lib/onmessage-sentinel.mjs` before the page loads and reads
//   `window.onmessage` once the viewer exists and again after the captures
//   (a lazily loaded module can assign it mid-page): one verdict
//   `onmessage-unchanged` over both reads (regression X1, a worker module that
//   self-registers on the main thread).
// - E-FFT-ifft stages its rig once per kernel (`waterOceanIfftKernel`), reads
//   the displacement field back after each capture
//   (`lib/ocean-displacement-readback.mjs`), runs the PF-1 / PF-2 window
//   without `--perf`, and judges the two kernels' fields identical per run.
// - E-C-chukotka diffs its WebGPU capture against the same run's WebGL capture
//   (`lib/metrics/landing-cross-page.mjs`); the band is registered by the first
//   capture, so the verdict says only that the diff was measured.
//
// LANE TAR-ALDARION (probe-kit round 2: what Batch 1628's own Edge legs left owed).
// - EVOLVED EPOCH. E-FFT-ifft reads each kernel's field again with the frozen
//   clock `evolvedReadbackSeconds` past the rig's (`lib/clock-steps.mjs`),
//   then restores it: verdict `ifft-kernel-identity-evolved` beside the t = 0
//   one, NOT RUN when the sea did not move.
// - POSITIVE CONTROL. `--sentinel-positive-control` assigns window.onmessage
//   at the end of the first identity page of each run and reads the sentinel
//   again (`onmessage-positive-control`); a run whose control page never got
//   there reads NOT RUN. Refused without an identity cell.
// - PF-2 PASS. A cell's `perfPass` (E-FFT-ifft: the ocean compute chain's
//   label) must be listed by its PF-2 window (`perf-pass-timed`); with no
//   profiler result it is reported, not judged (`perfPassTimings`).
// - CAPTURE MANIFEST. The receipt writes `capture-manifest.json` beside the
//   report (`lib/landing-capture-manifest.mjs`), BEFORE from `--base-report`;
//   a manifest that would not validate is refused and the receipt says why.
// - The comparison and verdicts moved to `lib/landing-verdicts.mjs`.

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
import { runDeviceLossSteps } from "./lib/device-loss-steps.mjs";
import {
  measureLandingPerformance,
  pageMeasureStartup,
  pageReadRendererStatistics,
} from "./lib/frame-timing-steps.mjs";
import {
  GPU_DEVICE_CENSUS_INIT_SOURCE,
  parseOwnerLabel,
  readGpuDeviceCensus,
} from "./lib/gpu-device-census.mjs";
import {
  LANDING_WATER_DIALS,
  capturesWhilePipelinesPending,
  readPendingPipelines,
  stageLandingCell,
} from "./lib/landing-cell-stage.mjs";
import {
  DEFAULT_CELLS,
  LANDING_CELLS,
  pipelineWaitPlan,
  planLandingCells,
  rigForPage,
  pipelineWaitMismatches,
  splitList,
  waitedForCell,
} from "./lib/landing-cell-table.mjs";
import {
  crossPageVerdicts,
  crossRendererComparisons,
  kernelIdentityComparisons,
} from "./lib/metrics/landing-cross-page.mjs";
import {
  runtimeReportFileName,
  writeLandingCaptureManifest,
} from "./lib/landing-capture-manifest.mjs";
import {
  compareArms,
  landingVerdicts,
  perfPassTimings,
  positiveControlCoverage,
} from "./lib/landing-verdicts.mjs";
import {
  keepValuesOutOfReport,
  readOceanDisplacement,
  readOceanDisplacementEvolved,
} from "./lib/ocean-displacement-readback.mjs";
import {
  combineOnmessageReads,
  installOnmessageSentinel,
  readOnmessageSentinel,
  runOnmessagePositiveControl,
} from "./lib/onmessage-sentinel.mjs";
import {
  groupArms,
  pagesWithMergedRuns as mergedPagesFor,
  readMergeReports as readMergeReportsFor,
} from "./lib/metrics/merge-landing-reports.mjs";
import { resolveBands } from "./lib/metrics/perf-band.mjs";
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

// The cell table and its planning (lane LINDISSE moved them to a piece).
export {
  DEFAULT_CELLS,
  DEVICE_LOSS_PAGES,
  LANDING_CELLS,
  planLandingCells,
  splitList,
} from "./lib/landing-cell-table.mjs";

// The comparison and the verdicts (lane TAR-ALDARION moved them to a piece).
export {
  NOT_APPLICABLE,
  compareArms,
  landingVerdicts,
} from "./lib/landing-verdicts.mjs";

const CANVAS_SELECTOR = ".cesium-widget canvas";
const NAVIGATION_BUDGET_MS = 120_000;
const STARTUP_BUDGET_MS = 120_000;
const STARTUP_MAX_FRAMES = 1200;
const STEPS_BUDGET_MS = 180_000;
const PERF_BUDGET_MS = 180_000;
// Frames the displacement readback renders first, at the frozen clock, so the
// ocean's compute chain has run since the capture.
const OCEAN_READBACK_FRAMES = 8;
// The evolved read (lane TAR-ALDARION) reads the same way, values kept for a
// mismatch and out of the report.
const EVOLVED_READ = Object.freeze({
  frames: OCEAN_READBACK_FRAMES,
  includeValues: true,
});

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
  positiveControl = false,
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
      const cell = LANDING_CELLS[entry.cell];
      if (cell.identity === true) {
        // Before any page script: the sentinel holds window.onmessage as the
        // page had it before Cesium loaded.
        await page.addInitScript(installOnmessageSentinel);
      }
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
      // The first read is joined with a null second one until the page takes
      // it, so a page that dies in between never passes on this read alone.
      if (cell.identity === true) {
        record.onmessage = combineOnmessageReads(
          await readOnmessageSentinel(page),
          null,
        );
      }
      // The second read: a module loaded lazily after the first one can still
      // replace window.onmessage. Taken after the captures and before the
      // positive control, so the control's own assignment is never seen here.
      const rereadOnmessage = async () => {
        if (cell.identity === true && record.onmessage?.reads) {
          record.onmessage = combineOnmessageReads(
            record.onmessage.reads.first,
            await readOnmessageSentinel(page),
          );
        }
      };
      // --sentinel-positive-control: assign window.onmessage LAST, after
      // everything measured, and read the sentinel again; it must see it.
      const runControl = async () => {
        if (positiveControl) {
          record.onmessageControl = await runOnmessagePositiveControl(page);
        }
      };
      record.armed = await armWebGPUDevices(page);

      const { staged, pipelines } = await stageLandingCell({
        page,
        rig,
        waitForPendingPipelines:
          pipelineWaitPlan(options).byCell[entry.cell] === true,
      });
      record.stage = staged;
      record.pipelines = pipelines;
      const blocking = blockingDials(staged);
      if (blocking.length > 0) {
        record.notRun = `the stage did not apply ${blocking.join(", ")}`;
        // Staging runs between the two reads, so a late load there is caught.
        await rereadOnmessage();
        await runControl();
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
          // The capture-seam manifest records what was fetched and when.
          url: url.href,
          capturedAt: new Date().toISOString(),
          sha256: shot.sha256,
          width: image.width,
          height: image.height,
          liveness: shot.liveness,
          pipelinesPending: pending,
        };
      };

      if (entry.kind === "capture") {
        record.capture = await capture(
          entry.page === "scene" ? base : `${base}-${entry.page}`,
        );
        if (cell.readback === "ocean-displacement") {
          // With values, so a mismatch reports maxAbsDelta and how many
          // values differ; the values never reach the written report.
          record.displacement = keepValuesOutOfReport(
            await readOceanDisplacement(page, {
              frames: OCEAN_READBACK_FRAMES,
              includeValues: true,
            }),
          );
          if (cell.evolvedReadbackSeconds > 0) {
            // The same field at a later wave time, the clock restored after.
            record.displacementEvolved = keepValuesOutOfReport(
              await readOceanDisplacementEvolved(page, {
                ...EVOLVED_READ,
                clockIso: rig.clock,
                advanceSeconds: cell.evolvedReadbackSeconds,
              }),
            );
          }
        }
      } else if (entry.kind === "clock-steps") {
        record.captureStart = await capture(`${base}-start`);
        record.steps = await runClockSteps({ page, rig, settle });
        record.capture = await capture(`${base}-end`);
      }

      if (
        (options.perf === true ||
          (cell.perf === true && options.noCellPerf !== true)) &&
        entry.kind !== "device-loss"
      ) {
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
      await rereadOnmessage();
      await runControl();
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
  // Refuses --wait-pipelines with --no-wait-pipelines before anything else.
  const wait = pipelineWaitPlan(options);
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
    // Per cell (lane LINDISSE): a cell that waited for pending pipelines on
    // one arm and not on the other has incomparable startup timelines.
    const mismatched = pipelineWaitMismatches(base, {
      pipelineWaitByCell: wait.byCell,
    });
    if (mismatched.length > 0) {
      const cell = mismatched[0];
      throw new ProbeRefusal(
        "base-report-invalid",
        `${options.baseReport} has waitForPendingPipelines ${waitedForCell(base, cell)} on ${mismatched.join(", ")}, this run ${wait.byCell[cell]} (${wait.mode}): the startup timelines are not comparable; pass --no-wait-pipelines (or --wait-pipelines) to match the base, or re-capture the base with this run's wait`,
        { baseReport: options.baseReport, cells: mismatched },
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

/**
 * True when the per-cell wait record names at least one cell and every one
 * waited. Pure.
 *
 * @param {Record<string, boolean>} byCell
 * @returns {boolean}
 */
export function allWaited(byCell) {
  const values = Object.values(byCell ?? {});
  return values.length > 0 && values.every((waited) => waited === true);
}

/** The whole invocation's machine-CPU sampler (F3); stopped by the receipt. */
let invocationCpu = null;
/** The rig registry the pages ran from, for the receipt's capture manifest. */
let invocationRigs = null;

/** The manifest writer, its throw (a page whose rig is gone) reported. */
function landingManifestOrError(inputs) {
  try {
    return writeLandingCaptureManifest(inputs);
  } catch (error) {
    return {
      path: null,
      written: false,
      violations: [String(error?.message ?? error)],
      files: [],
    };
  }
}

/**
 * The page of a plan that runs the sentinel's positive control: the first
 * identity page, or -1 without the switch. Refuses the switch when no
 * requested cell is an identity cell, before the first page. Pure.
 *
 * @param {object[]} plan {@link planLandingCells}' answer.
 * @param {{sentinelPositiveControl?: boolean}} options
 * @returns {number}
 * @throws {ProbeRefusal} `sentinel-control-no-identity-cell`.
 */
export function positiveControlPageIndex(plan, options) {
  if (options?.sentinelPositiveControl !== true) {
    return -1;
  }
  const index = plan.findIndex(
    (entry) => LANDING_CELLS[entry.cell]?.identity === true,
  );
  if (index < 0) {
    throw new ProbeRefusal(
      "sentinel-control-no-identity-cell",
      "--sentinel-positive-control needs an identity cell in --cells (E-D, E-D-HDR, E-ID-2d, E-ID-cv): only their pages carry the sentinel",
      { cells: splitList(options.cells) },
    );
  }
  return index;
}

const PAGE_BUDGET_MS =
  NAVIGATION_BUDGET_MS + STARTUP_BUDGET_MS + STEPS_BUDGET_MS + PERF_BUDGET_MS;

export const descriptor = {
  name: "landing-cells",
  title:
    "Landing cells - the cloud and water landing program's Edge cells (E-D, E-D-HDR, E-O, E-F, E-G, E-H, R-14, E-T, E-M-water, E-ID-2d, E-ID-cv, E-C-chukotka, E-FFT-ifft) with the PF-1..PF-4 performance leg",
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
      { flag: "--no-wait-pipelines", key: "noWaitPipelines", kind: "boolean" },
      // Skips the PF window a cell forces (E-FFT-ifft), so its readback
      // identity can be captured on a machine too busy for a PF leg.
      { flag: "--no-cell-perf", key: "noCellPerf", kind: "boolean" },
      // Assigns window.onmessage at the end of one identity page per run and
      // expects the sentinel to see it: proves the sentinel live in the run.
      {
        flag: "--sentinel-positive-control",
        key: "sentinelPositiveControl",
        kind: "boolean",
      },
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
    const rigsForPlan = await loadRigs();
    positiveControlPageIndex(
      planLandingCells(options, new Map(rigsForPlan.map((r) => [r.id, r]))),
      options,
    );
    if (run === 0) {
      invocationCpu?.stop();
      invocationCpu = startCpuSampler();
    }
    const rigsById = new Map(rigsForPlan.map((rig) => [rig.id, rig]));
    invocationRigs = rigsById;
    const plan = planLandingCells(options, rigsById);
    const controlIndex = positiveControlPageIndex(plan, options);
    fs.mkdirSync(outputDirectory, { recursive: true });
    const records = [];
    for (const [index, entry] of plan.entries()) {
      console.log(
        `[probe-landing-cells] ${entry.cell} ${entry.page} on ${entry.renderer} (run ${run})`,
      );
      records.push(
        await runLandingPage({
          browser,
          origin,
          entry,
          rig: rigForPage(rigsById.get(entry.rigId), entry),
          run,
          options,
          outputDirectory,
          captures,
          positiveControl: index === controlIndex,
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
    const pipelineWait = pipelineWaitPlan(options);
    for (const [key, arm] of Object.entries(arms)) {
      console.log(
        `  ${key}: runs=${arm.runs} notRun=${arm.notRun.length} captures=${arm.captures.length}`,
      );
    }
    // The capture-seam manifest contact-sheet.mjs reads (refused, not
    // written, when it would not validate; the receipt says which).
    const captureManifest = context.outputDirectory
      ? landingManifestOrError({
          pages,
          baseReport: base,
          rigsById: invocationRigs ?? new Map(),
          origins: { AFTER: context.origin },
          generatedAt: context.generatedAt,
          servedBuildAssertion:
            options.servedBuild === false ? "waived" : "enforced",
          receipt: runtimeReportFileName(descriptor.name),
          outputDirectory: context.outputDirectory,
        })
      : null;
    if (captureManifest && !captureManifest.written) {
      console.warn(
        `[probe-landing-cells] capture manifest refused: ${captureManifest.violations.slice(0, 3).join("; ")}`,
      );
    }
    return {
      cellsRequested: splitList(options.cells),
      perf: options.perf === true,
      // True only when every requested cell waited (the run-wide reading a
      // report written before the per-cell record carried).
      waitForPendingPipelines: allWaited(pipelineWait.byCell),
      pipelineWait,
      pipelineWaitByCell: pipelineWait.byCell,
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
      crossRenderer: crossRendererComparisons(pages),
      kernelIdentity: kernelIdentityComparisons(pages),
      perfPassTimings: perfPassTimings(pages),
      captureManifest,
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
    return [
      ...landingVerdicts(pages, comparison),
      // This invocation's pages only: a merged report ran no control.
      ...positiveControlCoverage(
        cells,
        context.options.sentinelPositiveControl === true,
      ),
      ...crossPageVerdicts({
        crossRenderer: crossRendererComparisons(pages),
        kernelIdentity: kernelIdentityComparisons(pages),
      }),
    ];
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
