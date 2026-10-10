#!/usr/bin/env node
// Probe: post-process pipelines across runtime HDR toggles on WebGPU.
// @purpose Takes the default WebGPU globe (rig globe-postprocess-hdr-toggle) through the HDR canvas-output and highDynamicRange toggle steps on one live viewer and, after each step, captures the scene canvas and records uncaptured WebGPU errors, the canvas format and whether the colour-grading stage is live.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// WHAT IT MEASURES. A runtime `scene.useHDRCanvasOutput` toggle reconfigures
// the canvas between the preferred format and rgba16float without recreating
// the post-process pipeline, so every pipeline that writes the canvas must
// follow the new format or each frame fails validation ("Attachment state of
// [RenderPipeline] is not compatible with [RenderPassEncoder]") and the canvas
// stops updating. A runtime `scene.highDynamicRange` toggle changes the
// intermediate format the single-pass stages write, and the resource
// allocator replaces the whole pipeline for it, so a stage that the configure
// pass adds only once does not come back. The rig turns colour grading on at
// saturation 0: while the stage runs the frame is grey, and a dropped stage
// shows as colour returning.
//
// ONE VIEWER, FIVE CAPTURES. The steps (`lib/postprocess-hdr-toggle-steps.mjs`)
// are runtime changes, so they run in order on one page: the pinned start,
// HDR canvas output on, then off, highDynamicRange on, then off. Each step
// renders the rig's settle frame count, then the post-process state is read
// through `CesiumDebug.postProcess()`, the chrome strip is checked, and the
// scene canvas is captured with `captureElement`. Frame figures are computed in
// Node from the banked PNG: `colourDiversity` for a dead frame and `meanChroma`
// for the grade.
//
// VERDICTS, ONE PER STEP. See `judgeHdrStep`. A step whose HDR canvas request
// was demoted to SDR by the device is recorded as `deviceBlocked` and still
// judged on errors and the stage; it cannot show a format defect.
//
// Usage: node Tools/visual-regression/probe-postprocess-hdr-toggle.mjs
//   --port <served port> [--repository-root <tree the server serves>]
// Outputs: Tools/visual-regression/output/postprocess-hdr-toggle/

import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";
import { decodePng } from "../lib/png-decode.mjs";
import { armWebGPUDevices, errorGateInit } from "../lib/webgpu-error-gate.mjs";
import { captureUrlFor } from "./lib/capture.mjs";
import { DET_BROWSER_SETUP } from "./lib/determinism-kit.mjs";
import { colourDiversity } from "./lib/metrics/colour-diversity.mjs";
import { meanChroma } from "./lib/metrics/mean-chroma.mjs";
import {
  HDR_TOGGLE_STEPS,
  judgeHdrStep,
  pageApplyHdrStep,
  pageApplyHdrToggleDials,
} from "./lib/postprocess-hdr-toggle-steps.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import RIG from "./rigs/globe-postprocess-hdr-toggle.mjs";

/** The engine module the CesiumViewer page loads and the dials import. */
const CESIUM_MODULE_URL = "/Build/CesiumUnminified/index.js";

/** The scene canvas; the page has exactly one once the widgets are gone. */
const CANVAS_SELECTOR = ".cesium-widget canvas";

/** Consecutive tiles-loaded frames the initial settle requires. */
const STABLE_FRAMES = 30;

/** The initial settle's ceiling. */
const SETTLE_CAP_FRAMES = 1200;

/**
 * Pre-registered limits. A dead canvas (every frame failing validation) reads
 * near 0 non-black; the home-view globe and star field read far above the
 * floor. A saturation-0 grade leaves only rounding chroma; the imagery's ocean
 * and land carry tens of levels.
 */
export const HDR_TOGGLE_LIMITS = Object.freeze({
  nonBlackFloor: 0.05,
  chromaCeiling: 6,
});

const NAVIGATION_BUDGET_MS = 120_000;
const SETTLE_BUDGET_MS = 180_000;
const STEP_BUDGET_MS = 60_000;

/** Accept the chrome strip's report or refuse, as `probe-wgs84.mjs` does. */
function acceptChromeStrip(report, step) {
  if (!Array.isArray(report?.leftovers) || report.leftovers.length > 0) {
    throw new ProbeRefusal(
      "capture-chrome-over-canvas",
      `step ${step}: after the viewer chrome was stripped, ${
        Array.isArray(report?.leftovers)
          ? `elements were still stacked over the scene canvas (${report.leftovers.join(", ")})`
          : "the strip returned no list of what was still stacked over the scene canvas"
      }`,
      { step, widgets: report ?? null },
    );
  }
}

/** Error-level console lines and page errors recorded after `from`. */
function consoleErrorsSince(diagnostics, from) {
  return [
    ...diagnostics.console.filter(
      (message) => message.type === "error" && message.seq >= from,
    ),
    ...diagnostics.errors.filter((message) => message.seq >= from),
  ]
    .sort((a, b) => a.seq - b.seq)
    .map(({ text }) => text);
}

/** The next diagnostics sequence number. */
function nextSeq(diagnostics) {
  const all = [...diagnostics.console, ...diagnostics.errors];
  return all.reduce((max, message) => Math.max(max, message.seq + 1), 0);
}

/**
 * One run: the rig applied and settled, then each step applied, read,
 * captured and judged on the same viewer.
 */
async function captureSequence({
  browser,
  origin,
  run,
  outputDirectory,
  captures,
}) {
  const context = await browser.newContext({ viewport: { ...RIG.viewport } });
  try {
    const page = await context.newPage();
    const diagnostics = attachPageDiagnostics(page);
    try {
      await page.addInitScript(errorGateInit);
      const url = new URL(captureUrlFor({ rig: RIG, origin }));
      url.searchParams.set("renderer", "webgpu");
      await page.goto(url.href, {
        waitUntil: "networkidle",
        timeout: NAVIGATION_BUDGET_MS,
      });
      await page.waitForFunction(() => !!globalThis.viewer, null, {
        timeout: NAVIGATION_BUDGET_MS,
      });
      const armed = await armWebGPUDevices(page);
      if (!(armed.total > 0)) {
        throw new ProbeRefusal(
          "error-gate-unarmed",
          "the page has no WebGPU device to arm the error gate on",
          armed,
        );
      }
      const settle = await page.evaluate(pageApplyHdrToggleDials, {
        moduleUrl: CESIUM_MODULE_URL,
        dials: RIG.dials,
        clock: RIG.clock,
        det: DET_BROWSER_SETUP,
        minFrames: RIG.readiness.frames,
        maxFrames: Math.max(RIG.readiness.frames, SETTLE_CAP_FRAMES),
        stableFrames: STABLE_FRAMES,
      });

      const steps = [];
      let gateFrom = 0;
      for (const step of HDR_TOGGLE_STEPS) {
        const consoleFrom = nextSeq(diagnostics);
        const state = await page.evaluate(pageApplyHdrStep, {
          set: step.set,
          frames: RIG.readiness.frames,
          gateFrom,
        });
        gateFrom = state.gate?.total ?? gateFrom;
        acceptChromeStrip(
          await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`),
          step.id,
        );
        const shot = await captureElement({
          page,
          selector: CANVAS_SELECTOR,
          name: `${String(steps.length).padStart(2, "0")}-${step.id}-run${run}`,
          outputDirectory,
          captures,
        });
        const image = decodePng(shot.buffer);
        const diversity = colourDiversity(image);
        const chroma = meanChroma(image);
        const record = {
          step: step.id,
          set: step.set,
          ...state,
          consoleErrors: consoleErrorsSince(diagnostics, consoleFrom),
          frame: {
            nonBlackFraction: diversity.nonBlackFraction,
            colourBuckets: diversity.colourBuckets,
            meanChroma: chroma.meanChroma,
            chromaticFraction: chroma.chromaticFraction,
          },
          capture: { name: shot.name, sha256: shot.sha256 },
        };
        record.judgement = judgeHdrStep(record, HDR_TOGGLE_LIMITS);
        console.log(
          `[probe-postprocess-hdr-toggle] run${run} ${step.id}: ${record.judgement.pass ? "PASS" : "FAIL"}${record.judgement.deviceBlocked ? " (device-blocked)" : ""} format=${state.canvas.presentationFormat} gpuErrors=${state.gate?.errors.length ?? "n/a"} grading=${String(state.postProcess?.colorGradingEnabled)} chroma=${chroma.meanChroma.toFixed(2)}${record.judgement.reasons.length ? ` - ${record.judgement.reasons.join("; ")}` : ""}`,
        );
        steps.push(record);
      }
      return { run, rig: RIG.id, settle, steps };
    } finally {
      diagnostics.detach();
    }
  } finally {
    await context.close();
  }
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "postprocess-hdr-toggle",
  title:
    "Post-process pipelines across runtime HDR canvas-output and highDynamicRange toggles on WebGPU",
  outputSubdirectory: "postprocess-hdr-toggle",
  receiptEnvelope: "runtime",
  servedArtifacts: [
    "Build/CesiumUnminified/Cesium.js",
    "Build/CesiumUnminified/index.js",
    "packages/engine/Build/Unminified/index.js",
  ],
  workBudgetMs: () =>
    NAVIGATION_BUDGET_MS +
    SETTLE_BUDGET_MS +
    HDR_TOGGLE_STEPS.length * STEP_BUDGET_MS,
  async cells({ browser, run, origin, outputDirectory, captures }) {
    return [
      await captureSequence({
        browser,
        origin,
        run,
        outputDirectory,
        captures,
      }),
    ];
  },
  verdicts(cells) {
    return cells.flatMap((cell) =>
      cell.steps.map((record) => ({
        id: `run${cell.run}-${record.step}`,
        pass: record.judgement.pass,
        deviceBlocked: record.judgement.deviceBlocked,
        reasons: record.judgement.reasons,
      })),
    );
  },
  receipt(cells) {
    return { rig: RIG.id, limits: HDR_TOGGLE_LIMITS, cells };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
