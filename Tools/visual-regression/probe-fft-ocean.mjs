#!/usr/bin/env node
// ACCEPTANCE / REGRESSION probe for C6-FFT-OCEAN (opt-in FFT spectral ocean).
// @purpose Opt-in FFT spectral ocean from rigs on the shared runtime: OFF byte-identity across sessions (never enabled vs enabled-then-disabled), a globe-hidden ON capture paints a non-empty patch, and the waves move across a 2 s clock step.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// WebGPU-only feature. The scenes are the four `fft-ocean-nadir*` rigs, each
// staged through `lib/landing-cell-stage.mjs`, whose `waterOceanEnabled` dial
// is the product's own switch (`scene.globe.water.ocean.enabled`) read back by
// the ocean primitive it creates, and whose `globeShow` dial hides the globe
// so a capture shows ONLY what the FFT ocean draws. Every session is a fresh
// page rendering the same number of frames at the same frozen clock.
//
// Asserts:
//   (a) OFF-gate: two OFF sessions (never enabled vs enabled-then-disabled) at
//       the same frame count match to within the OFF-vs-OFF noise floor -> the
//       feature leaves nothing behind when off.
//   (b) ISOLATED render: with the globe hidden, enabling paints a non-empty
//       ocean patch (coverage well above the empty-scene baseline).
//   (c) ANIMATION: two isolated ON frames 2 s of scene time apart differ over
//       the patch. The surface's phase is scene time since its simulation
//       epoch (`OceanSurfacePrimitive.js` resolveOceanSimulationSeconds), so
//       the step moves the frozen clock (`lib/clock-steps.mjs`, the rig's
//       `clockSteps`); more frames at one pinned instant show the same sea.
// The OFF gate compares "ocean sub-facade created, never enabled" with
// "enabled then disabled": the rigs pin the wave epoch through
// `globe.water.ocean`, which creates the facade on access, where main's
// never-enabled session did not touch it. Kept from main: the crop, the luma
// coefficients, the coverage luma floor 20 and the temporal floor 0.5. NEW
// (from the w5 rework): the verdict ids and the OFF-gate +0.5 and coverage
// +0.1 bands, registered by the first Edge capture.
// A build where the stage cannot apply a rig's dials (no `water.ocean`) is a
// REFUSAL, not a measured red. READ the emitted PNGs - numbers alone don't
// prove waves look right.

import fs from "node:fs";

import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";
import { decodePng, readPng } from "../lib/png-decode.mjs";
import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { captureUrlFor } from "./lib/capture.mjs";
import { runClockSteps } from "./lib/clock-steps.mjs";
import { diffImages } from "./lib/image-diff.mjs";
import { stageLandingCell } from "./lib/landing-cell-stage.mjs";
import { buildPerformanceViewerUrl } from "./lib/performance-viewer-url.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { loadRigs, rigById } from "./lib/rig-registry.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";

/** The rigs the sessions stage, by role. */
export const FFT_OCEAN_RIGS = Object.freeze({
  off: "fft-ocean-nadir-off",
  on: "fft-ocean-nadir-on",
  isolatedOff: "fft-ocean-nadir-isolated-off",
  isolatedOn: "fft-ocean-nadir-isolated-on",
});

export const FFT_OCEAN_CROP = Object.freeze({
  x0: 200,
  y0: 200,
  x1: 980,
  y1: 600,
});
export const FFT_OCEAN_BANDS = Object.freeze({
  offGateExcessLumaMax: 0.5,
  minCoverageDelta: 0.1,
  minTemporalLumaDelta: 0.5,
  coverageLumaFloor: 20,
});

/**
 * The scene table: each session stages its rigs in order on one fresh page,
 * then settles the last rig's readiness frames. `off2` stages the ON rig and
 * then the OFF rig, so the ocean is created and destroyed before any frame.
 * `temporal` walks the last rig's clock steps and captures again.
 */
export const FFT_OCEAN_SESSIONS = Object.freeze([
  Object.freeze({ id: "off1", rigs: Object.freeze([FFT_OCEAN_RIGS.off]) }),
  Object.freeze({ id: "off1b", rigs: Object.freeze([FFT_OCEAN_RIGS.off]) }),
  Object.freeze({
    id: "off2",
    rigs: Object.freeze([FFT_OCEAN_RIGS.on, FFT_OCEAN_RIGS.off]),
  }),
  Object.freeze({
    id: "iso-off",
    rigs: Object.freeze([FFT_OCEAN_RIGS.isolatedOff]),
  }),
  Object.freeze({
    id: "iso-on",
    rigs: Object.freeze([FFT_OCEAN_RIGS.isolatedOn]),
    temporal: true,
  }),
  Object.freeze({ id: "ctx-on", rigs: Object.freeze([FFT_OCEAN_RIGS.on]) }),
]);

const CANVAS_SELECTOR = "#cesiumContainer canvas";
const NAVIGATION_BUDGET_MS = 60_000;
const SESSION_BUDGET_MS = 90_000;

function pixelLuma(data, index) {
  return (
    0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]
  );
}

function clampCrop(image, crop) {
  const x0 = Math.max(0, Math.min(image.width, Math.trunc(crop.x0)));
  const y0 = Math.max(0, Math.min(image.height, Math.trunc(crop.y0)));
  const x1 = Math.max(x0, Math.min(image.width, Math.trunc(crop.x1)));
  const y1 = Math.max(y0, Math.min(image.height, Math.trunc(crop.y1)));
  if (x1 <= x0 || y1 <= y0) {
    throw new Error(
      `crop (${crop.x0},${crop.y0})-(${crop.x1},${crop.y1}) has zero area on ${image.width}x${image.height}`,
    );
  }
  return { x0, y0, x1, y1 };
}

function cropLumaMeanAbsDiff(imageA, imageB, crop) {
  if (imageA.width !== imageB.width || imageA.height !== imageB.height) {
    throw new Error(
      `image size mismatch: ${imageA.width}x${imageA.height} vs ${imageB.width}x${imageB.height}`,
    );
  }
  const box = clampCrop(imageA, crop);
  let sum = 0;
  let count = 0;
  for (let y = box.y0; y < box.y1; y += 1) {
    for (let x = box.x0; x < box.x1; x += 1) {
      const i = (y * imageA.width + x) * 4;
      sum += Math.abs(pixelLuma(imageA.data, i) - pixelLuma(imageB.data, i));
      count += 1;
    }
  }
  return sum / count;
}

function cropBrightCoverage(
  image,
  crop,
  lumaFloor = FFT_OCEAN_BANDS.coverageLumaFloor,
) {
  const box = clampCrop(image, crop);
  let bright = 0;
  let total = 0;
  for (let y = box.y0; y < box.y1; y += 1) {
    for (let x = box.x0; x < box.x1; x += 1) {
      const i = (y * image.width + x) * 4;
      if (pixelLuma(image.data, i) > lumaFloor) {
        bright += 1;
      }
      total += 1;
    }
  }
  return Number((bright / total).toFixed(4));
}

/** The metrics, from decoded captures (Node; no page). */
export function analyzeFftOceanCaptures(images, crop = FFT_OCEAN_CROP) {
  const required = ["off1", "off1b", "off2", "isoOff", "isoOn", "isoOnT2"];
  for (const key of required) {
    if (!images?.[key]?.data) {
      throw new Error(`missing decoded capture ${key}`);
    }
  }
  const offGateFull = diffImages(images.off1, images.off2);
  const noiseFloorFull = diffImages(images.off1, images.off1b);
  const isoTemporalFull = diffImages(images.isoOn, images.isoOnT2);
  return {
    offGate: Number(
      cropLumaMeanAbsDiff(images.off1, images.off2, crop).toFixed(4),
    ),
    noiseFloor: Number(
      cropLumaMeanAbsDiff(images.off1, images.off1b, crop).toFixed(4),
    ),
    offGateDiffPct: Number((offGateFull.mismatchPct ?? 0).toFixed(4)),
    noiseFloorDiffPct: Number((noiseFloorFull.mismatchPct ?? 0).toFixed(4)),
    isoCoverageOff: cropBrightCoverage(images.isoOff, crop),
    isoCoverageOn: cropBrightCoverage(images.isoOn, crop),
    isoTemporal: Number(
      cropLumaMeanAbsDiff(images.isoOn, images.isoOnT2, crop).toFixed(3),
    ),
    isoTemporalDiffPct: Number((isoTemporalFull.mismatchPct ?? 0).toFixed(4)),
  };
}

/**
 * Load the captures the metrics need and measure them. A session that ran
 * but produced no capture is a run that did not measure: a refusal naming the
 * missing captures.
 */
export function summarizeFftOceanCells(
  cells,
  loadImage = readPng,
  crop = FFT_OCEAN_CROP,
) {
  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  const wanted = {
    off1: byId.get("off1")?.capture?.path,
    off1b: byId.get("off1b")?.capture?.path,
    off2: byId.get("off2")?.capture?.path,
    isoOff: byId.get("iso-off")?.capture?.path,
    isoOn: byId.get("iso-on")?.capture?.path,
    isoOnT2: byId.get("iso-on")?.temporalCapture?.path,
  };
  const missing = Object.keys(wanted).filter((key) => !wanted[key]);
  if (missing.length > 0) {
    throw new ProbeRefusal(
      "fft-ocean-captures-missing",
      `the FFT ocean sessions did not produce ${missing.join(", ")}`,
      { missing },
    );
  }
  const images = {};
  for (const [key, file] of Object.entries(wanted)) {
    images[key] = loadImage(file);
  }
  return { metrics: analyzeFftOceanCaptures(images, crop) };
}

/**
 * Refuse a session whose stage did not apply every dial its rig declares: the
 * scene the verdicts assume was not built (on a tree without the FFT ocean the
 * `waterOceanEnabled` dial reads applied: false).
 */
export function refuseUnappliedDials(sessionId, rigId, staged) {
  const notApplied = staged?.notApplied ?? ["(no stage record)"];
  if (notApplied.length > 0) {
    throw new ProbeRefusal(
      "rig-dial-not-applied",
      `${sessionId}: the stage did not apply ${notApplied.join(", ")} of rig ${rigId}`,
      {
        sessionId,
        rigId,
        notApplied,
        reasons: Object.fromEntries(
          notApplied.map((key) => [key, staged?.dials?.[key]?.reason ?? null]),
        ),
      },
    );
  }
}

/**
 * The verdicts. A session whose WebGPU error gate armed no device could not
 * have seen a device error, so the run refuses rather than reporting the gate
 * green.
 */
export function fftOceanVerdicts(cells, summary, bands = FFT_OCEAN_BANDS) {
  const unarmedCell = cells.find(
    (cell) => (cell.gate?.armedDevices ?? 0) === 0,
  );
  if (unarmedCell) {
    throw new ProbeRefusal(
      "error-gate-unarmed",
      `${unarmedCell.id}: the WebGPU error gate armed 0 devices`,
      { sessionId: unarmedCell.id },
    );
  }
  const verdicts = [];
  const faultCells = cells.filter(
    (cell) =>
      cell.gate?.deviceLost ||
      (cell.gate?.errorCount ?? 0) > 0 ||
      (cell.gate?.pageErrorCount ?? 0) > 0,
  );
  verdicts.push(
    faultCells.length > 0
      ? {
          id: "device-and-page-errors",
          pass: false,
          detail: faultCells
            .map(
              (cell) =>
                `${cell.id}: gpuErrors=${cell.gate.errorCount} pageErrors=${cell.gate.pageErrorCount} deviceLost=${Boolean(cell.gate.deviceLost)}`,
            )
            .join("; "),
        }
      : {
          id: "device-and-page-errors",
          pass: true,
          detail: `${cells.length} WebGPU sessions completed with 0 device/page errors`,
        },
  );

  const { metrics } = summary;
  const offCeiling = Number(
    (metrics.noiseFloor + bands.offGateExcessLumaMax).toFixed(4),
  );
  verdicts.push({
    id: "off-gate-parity",
    pass: metrics.offGate <= offCeiling,
    measured: metrics.offGate,
    bound: offCeiling,
    detail: `offGate=${metrics.offGate} <= noiseFloor(${metrics.noiseFloor}) + ${bands.offGateExcessLumaMax} = ${offCeiling}`,
  });

  const coverageFloor = Number(
    (metrics.isoCoverageOff + bands.minCoverageDelta).toFixed(4),
  );
  verdicts.push({
    id: "isolated-coverage",
    pass: metrics.isoCoverageOn >= coverageFloor,
    measured: metrics.isoCoverageOn,
    bound: coverageFloor,
    detail: `isoCoverageOn=${metrics.isoCoverageOn} >= isoCoverageOff(${metrics.isoCoverageOff}) + ${bands.minCoverageDelta} = ${coverageFloor}`,
  });

  verdicts.push({
    id: "temporal-animation",
    pass: metrics.isoTemporal > bands.minTemporalLumaDelta,
    measured: metrics.isoTemporal,
    bound: bands.minTemporalLumaDelta,
    detail: `isoTemporal=${metrics.isoTemporal} > ${bands.minTemporalLumaDelta} across the rig's clock step`,
  });

  return verdicts;
}

/** Render `frames` frames at the frozen clock. Runs in the page. */
async function pageRenderFrames({ frames }) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  for (let i = 0; i < frames; i += 1) {
    viewer.scene.render(viewer.clock.currentTime);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return frames;
}

function buildGateSummary(gate, diagnostics) {
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
  };
}

async function runFftOceanSession({
  browser,
  origin,
  session,
  rigs,
  run,
  outputDirectory,
  captures,
}) {
  const sessionRigs = session.rigs.map((id) => rigById(rigs, id));
  const last = sessionRigs[sessionRigs.length - 1];
  const record = {
    run,
    id: session.id,
    rigs: [...session.rigs],
    stages: [],
    capture: null,
    temporalCapture: null,
  };
  const context = await browser.newContext({
    viewport: { ...last.viewport },
    deviceScaleFactor: 1,
  });
  try {
    await context.addInitScript(errorGateInit);
    const page = await context.newPage();
    const diagnostics = attachPageDiagnostics(page);
    let gate = null;
    try {
      const url = buildPerformanceViewerUrl(
        captureUrlFor({ rig: sessionRigs[0], origin }),
        "webgpu",
      );
      await page.goto(url.href, {
        waitUntil: "load",
        timeout: NAVIGATION_BUDGET_MS,
      });
      await page.waitForFunction(() => !!globalThis.viewer, null, {
        timeout: NAVIGATION_BUDGET_MS,
      });
      record.armed = await armWebGPUDevices(page);
      for (const rig of sessionRigs) {
        const { staged } = await stageLandingCell({ page, rig });
        record.stages.push(staged);
        refuseUnappliedDials(session.id, rig.id, staged);
      }
      const settle = (frames) => page.evaluate(pageRenderFrames, { frames });
      await settle(last.readiness.frames);
      const capture = async (name) => {
        const widgets = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
        if (
          !Array.isArray(widgets?.leftovers) ||
          widgets.leftovers.length > 0
        ) {
          throw new ProbeRefusal(
            "capture-chrome-over-canvas",
            `${name}: viewer chrome left ${JSON.stringify(widgets?.leftovers ?? null)} over the canvas`,
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
        const decoded = decodePng(shot.buffer);
        return {
          name: shot.name,
          path: shot.path,
          sha256: shot.sha256,
          width: decoded.width,
          height: decoded.height,
        };
      };
      record.capture = await capture(`fft-ocean-${session.id}-run${run}`);
      if (session.temporal === true) {
        record.steps = await runClockSteps({ page, rig: last, settle });
        if (!record.steps.steps.every((step) => step.ok === true)) {
          throw new ProbeRefusal(
            "clock-step-failed",
            `${session.id}: a clock step of rig ${last.id} did not set the clock`,
            { steps: record.steps.steps },
          );
        }
        record.temporalCapture = await capture(
          `fft-ocean-${session.id}-t2-run${run}`,
        );
      }
      gate = await collectGateErrors(page);
    } finally {
      record.gate = buildGateSummary(gate, diagnostics);
    }
  } finally {
    await context.close();
  }
  return record;
}

export const descriptor = {
  name: "fft-ocean",
  title:
    "Opt-in FFT spectral ocean from rigs: OFF byte-identity across sessions, isolated patch coverage, and wave motion across a clock step",
  outputSubdirectory: "fft-ocean",
  receiptEnvelope: "runtime",
  servedArtifacts: [
    "Build/CesiumUnminified/Cesium.js",
    "Build/CesiumUnminified/index.js",
    "packages/engine/Build/Unminified/index.js",
    "Apps/CesiumViewer/index.html",
  ],
  workBudgetMs: () => FFT_OCEAN_SESSIONS.length * SESSION_BUDGET_MS,
  async cells({ browser, run, origin, outputDirectory, captures }) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    const rigs = await loadRigs();
    const records = [];
    for (const session of FFT_OCEAN_SESSIONS) {
      records.push(
        await runFftOceanSession({
          browser,
          origin,
          session,
          rigs,
          run,
          outputDirectory,
          captures,
        }),
      );
    }
    return records;
  },
  receipt(cells) {
    return {
      rigs: FFT_OCEAN_RIGS,
      crop: FFT_OCEAN_CROP,
      bands: FFT_OCEAN_BANDS,
      sessions: cells,
      summary: summarizeFftOceanCells(cells),
    };
  },
  verdicts(cells) {
    return fftOceanVerdicts(cells, summarizeFftOceanCells(cells));
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
