#!/usr/bin/env node
// Probe-ssr-water - Slice 5c-B Batch 132 SSR verification scene, from rigs.
// @purpose SSR verification scene from four rigs on the shared runtime: a lit lake polygon with a bright extruded wall behind it, enableSSR x deferredLighting; the reflection must appear when SSR is on, and the deferredLighting toggle must be a no-op for SSR.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// The four cells are the `ssr-water-lake-wall-*` rigs, identical except for
// `enableSSR` and `deferredLighting`. Each is staged through
// `lib/landing-cell-stage.mjs` (clock, camera, offline ellipsoid + Natural
// Earth II, globe lighting, the SSR scene dials, each read back) and
// `lib/polygon-primitive-scene.mjs` (the rig's `polygons`: the low-roughness
// lit "lake" and the tall "wall"). At the rig's low-angle camera, SSR should
// show the wall reflected in the lake.
//
// The diff is main's: per pixel |dR| + |dG| + |dB|, mismatched above 30. The
// pass bands are NEW (main printed its diffs and judged nothing) and the scene
// moved (polygons 240 m over a flat ellipsoid instead of on streamed terrain,
// canvas element capture instead of a page screenshot), so the first Edge
// capture registers them.
//
// Expected if SSR is firing:
//   - A (SSR off) vs B (SSR on): a visible reflection on the lake, measurable
//     mismatch (>= 1 %).
//   - B (SSR on, deferred off) vs C (SSR on, deferred on): since Batch 122 both
//     read the same G-buffer view, so the difference stays within noise.
//
// The frames are read only through the runtime's element capture; nothing in
// the page reads the live canvas.
//
// The receipt also writes `capture-manifest.json` and its images beside the
// report (`lib/water-capture-manifest.mjs`) so `contact-sheet.mjs --manifest`
// can sheet the run: one entry per matrix cell on its own rig. The probe has no
// base report (its A/B/C/D cells are compared with each other inside the run,
// in the verdicts), so every BEFORE cell reads UNMEASURED.

import fs from "node:fs";

import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";
import { decodePng, readPng } from "../lib/png-decode.mjs";
import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { captureUrlFor } from "./lib/capture.mjs";
import { stageLandingCell } from "./lib/landing-cell-stage.mjs";
import { buildPerformanceViewerUrl } from "./lib/performance-viewer-url.mjs";
import { stagePolygonScene } from "./lib/polygon-primitive-scene.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { loadRigs, rigById } from "./lib/rig-registry.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import {
  ssrWaterManifestPages,
  writeWaterProbeManifest,
} from "./lib/water-capture-manifest.mjs";

/**
 * The pass bands. NEW with the move onto the runtime (main's probe printed its
 * diffs and judged nothing); unmeasured on this scene, so the first Edge
 * capture registers them. `mismatchChannelSum` is main's per-pixel rule, kept
 * exactly: a pixel is mismatched when |dR| + |dG| + |dB| > 30.
 */
export const SSR_WATER_BANDS = Object.freeze({
  minEngagementDiffPct: 1.0,
  maxDeferredGateDiffPct: 0.5,
  mismatchChannelSum: 30,
});

/** The settle: at least the rig's readiness frames, until the globe's tiles
 * are loaded (at most `maxFrames`), then `tailFrames` more. */
export const SSR_WATER_SETTLE = Object.freeze({
  maxFrames: 1500,
  tailFrames: 60,
});

/** The 2x2 matrix, one rig per cell. */
export const SSR_WATER_CELLS = Object.freeze([
  Object.freeze({
    label: "a-ssr-off-def-off",
    rig: "ssr-water-lake-wall-ssr-off-deferred-off",
  }),
  Object.freeze({
    label: "b-ssr-on-def-off",
    rig: "ssr-water-lake-wall-ssr-on-deferred-off",
  }),
  Object.freeze({
    label: "c-ssr-on-def-on",
    rig: "ssr-water-lake-wall-ssr-on-deferred-on",
  }),
  Object.freeze({
    label: "d-ssr-off-def-on",
    rig: "ssr-water-lake-wall-ssr-off-deferred-on",
  }),
]);

const CANVAS_SELECTOR = "#cesiumContainer canvas";
const NAVIGATION_BUDGET_MS = 60_000;
const CELL_BUDGET_MS = 90_000;

export function readCenterPixel(image) {
  const cx = Math.floor(image.width / 2);
  const cy = Math.floor(image.height / 2);
  const idx = (cy * image.width + cx) * 4;
  return {
    r: image.data[idx],
    g: image.data[idx + 1],
    b: image.data[idx + 2],
    a: image.data[idx + 3],
  };
}

/**
 * Main's SSR diff, kept exactly: per pixel d = |dR| + |dG| + |dB|; a pixel is
 * mismatched when d > `channelSum`; meanDelta is the mean d over all pixels.
 */
export function compareSsrImages(
  imageA,
  imageB,
  channelSum = SSR_WATER_BANDS.mismatchChannelSum,
) {
  if (imageA.width !== imageB.width || imageA.height !== imageB.height) {
    throw new Error(
      `image size mismatch: ${imageA.width}x${imageA.height} vs ${imageB.width}x${imageB.height}`,
    );
  }
  const totalPixels = imageA.width * imageA.height;
  let mismatched = 0;
  let deltaSum = 0;
  for (let i = 0; i < imageA.data.length; i += 4) {
    const d =
      Math.abs(imageA.data[i] - imageB.data[i]) +
      Math.abs(imageA.data[i + 1] - imageB.data[i + 1]) +
      Math.abs(imageA.data[i + 2] - imageB.data[i + 2]);
    deltaSum += d;
    if (d > channelSum) {
      mismatched += 1;
    }
  }
  return {
    mismatchPct: Number(((100 * mismatched) / totalPixels).toFixed(4)),
    meanDelta: Number((deltaSum / totalPixels).toFixed(4)),
    changedPx: mismatched,
    totalPixels,
  };
}

/**
 * Load the four captures and diff them. A cell that produced no capture is a
 * run that did not measure: a refusal naming it.
 */
export function summarizeSsrWaterCells(
  cells,
  loadImage = readPng,
  channelSum = SSR_WATER_BANDS.mismatchChannelSum,
) {
  const byLabel = new Map(cells.map((cell) => [cell.label, cell]));
  const missing = SSR_WATER_CELLS.map(({ label }) => label).filter(
    (label) => !byLabel.get(label)?.capture?.path,
  );
  if (missing.length > 0) {
    throw new ProbeRefusal(
      "ssr-water-captures-missing",
      `the SSR water cells did not produce ${missing.join(", ")}`,
      { missing },
    );
  }
  const image = (label) => loadImage(byLabel.get(label).capture.path);
  const imgA = image("a-ssr-off-def-off");
  const imgB = image("b-ssr-on-def-off");
  const imgC = image("c-ssr-on-def-on");
  const imgD = image("d-ssr-off-def-on");
  return {
    diffs: {
      ssrEngagement: compareSsrImages(imgA, imgB, channelSum),
      deferredGate: compareSsrImages(imgB, imgC, channelSum),
      offDeferredParity: compareSsrImages(imgA, imgD, channelSum),
    },
  };
}

/**
 * Refuse a cell whose stage did not apply every dial its rig declares, or
 * did not add every polygon: the scene the verdicts assume was not built.
 */
export function refuseUnbuiltScene(label, rig, staged, polygons) {
  const notApplied = staged?.notApplied ?? ["(no stage record)"];
  const wanted = (rig.polygons ?? []).map((polygon) => polygon.id);
  const added = polygons?.added ?? [];
  const absent = wanted.filter((id) => !added.includes(id));
  if (notApplied.length > 0 || absent.length > 0) {
    throw new ProbeRefusal(
      "rig-scene-not-built",
      `${label}: rig ${rig.id} not built (dials not applied: ${notApplied.join(", ") || "none"}; polygons absent: ${absent.join(", ") || "none"})`,
      {
        label,
        rigId: rig.id,
        notApplied,
        absent,
        reasons: Object.fromEntries(
          notApplied.map((key) => [key, staged?.dials?.[key]?.reason ?? null]),
        ),
      },
    );
  }
}

/**
 * The verdicts. A cell whose WebGPU error gate armed no device could not have
 * seen a device error, so the run refuses rather than reporting it green.
 */
export function ssrWaterVerdicts(cells, summary, bands = SSR_WATER_BANDS) {
  const unarmedCell = cells.find(
    (cell) => (cell.gate?.armedDevices ?? 0) === 0,
  );
  if (unarmedCell) {
    throw new ProbeRefusal(
      "error-gate-unarmed",
      `${unarmedCell.label}: the WebGPU error gate armed 0 devices`,
      { label: unarmedCell.label },
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
                `${cell.label}: gpuErrors=${cell.gate.errorCount} pageErrors=${cell.gate.pageErrorCount} deviceLost=${Boolean(cell.gate.deviceLost)}`,
            )
            .join("; "),
        }
      : {
          id: "device-and-page-errors",
          pass: true,
          detail: `${cells.length} WebGPU SSR cells completed with 0 device/page errors`,
        },
  );

  const { ssrEngagement, deferredGate } = summary.diffs;
  verdicts.push({
    id: "ssr-engagement",
    pass: ssrEngagement.mismatchPct >= bands.minEngagementDiffPct,
    measured: ssrEngagement.mismatchPct,
    bound: bands.minEngagementDiffPct,
    detail: `A vs B mismatch=${ssrEngagement.mismatchPct}% >= ${bands.minEngagementDiffPct}% (meanDelta=${ssrEngagement.meanDelta})`,
  });

  verdicts.push({
    id: "deferred-lighting-gate-noop",
    pass: deferredGate.mismatchPct <= bands.maxDeferredGateDiffPct,
    measured: deferredGate.mismatchPct,
    bound: bands.maxDeferredGateDiffPct,
    detail: `B vs C mismatch=${deferredGate.mismatchPct}% <= ${bands.maxDeferredGateDiffPct}% (meanDelta=${deferredGate.meanDelta})`,
  });

  return verdicts;
}

/**
 * Render at the frozen clock until the globe's tiles are loaded and at least
 * `minFrames` frames have rendered (or `maxFrames`), then `tailFrames` more.
 * Runs in the page.
 */
async function pageSettleUntilTilesLoaded({
  minFrames,
  maxFrames,
  tailFrames,
}) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const scene = viewer.scene;
  let frames = 0;
  while (frames < maxFrames) {
    scene.render(viewer.clock.currentTime);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    frames += 1;
    if (frames >= minFrames && scene.globe.tilesLoaded) {
      break;
    }
  }
  const tilesLoaded = Boolean(scene.globe.tilesLoaded);
  for (let i = 0; i < tailFrames; i += 1) {
    scene.render(viewer.clock.currentTime);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return {
    frames: frames + tailFrames,
    tilesLoaded,
    primitivesCount: scene.primitives.length,
  };
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

async function runSsrWaterCell({
  browser,
  origin,
  cellSpec,
  rig,
  run,
  outputDirectory,
  captures,
}) {
  const record = {
    run,
    label: cellSpec.label,
    rig: rig.id,
    capture: null,
  };
  const context = await browser.newContext({
    viewport: { ...rig.viewport },
    deviceScaleFactor: 1,
  });
  try {
    await context.addInitScript(errorGateInit);
    const page = await context.newPage();
    const diagnostics = attachPageDiagnostics(page);
    let gate = null;
    try {
      const url = buildPerformanceViewerUrl(
        captureUrlFor({ rig, origin }),
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
      const { staged } = await stageLandingCell({ page, rig });
      record.stage = staged;
      record.polygons = await stagePolygonScene({ page, rig });
      refuseUnbuiltScene(cellSpec.label, rig, staged, record.polygons);
      record.settle = await page.evaluate(pageSettleUntilTilesLoaded, {
        minFrames: rig.readiness.frames,
        ...SSR_WATER_SETTLE,
      });
      if (!record.settle.tilesLoaded) {
        throw new ProbeRefusal(
          "tiles-not-settled",
          `${cellSpec.label}: the globe's tiles did not load within ${SSR_WATER_SETTLE.maxFrames} frames`,
          { settle: record.settle },
        );
      }
      const widgets = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
      if (!Array.isArray(widgets?.leftovers) || widgets.leftovers.length > 0) {
        throw new ProbeRefusal(
          "capture-chrome-over-canvas",
          `${cellSpec.label}: viewer chrome left ${JSON.stringify(widgets?.leftovers ?? null)} over the canvas`,
          { widgets: widgets ?? null },
        );
      }
      const shot = await captureElement({
        page,
        selector: CANVAS_SELECTOR,
        name: `ssr-water-${cellSpec.label}-run${run}`,
        outputDirectory,
        captures,
      });
      const decoded = decodePng(shot.buffer);
      record.centerPixel = readCenterPixel(decoded);
      record.capture = {
        name: shot.name,
        path: shot.path,
        // The capture-seam manifest records what was fetched and when.
        url: url.href,
        capturedAt: new Date().toISOString(),
        sha256: shot.sha256,
        width: decoded.width,
        height: decoded.height,
      };
      gate = await collectGateErrors(page);
    } finally {
      record.gate = buildGateSummary(gate, diagnostics);
    }
  } finally {
    await context.close();
  }
  return record;
}

/** The rig registry the cells ran from, for the receipt's capture manifest. */
let invocationRigs = null;

export const descriptor = {
  name: "ssr-water",
  title:
    "SSR verification scene from rigs: lake + wall reflector 4-cell matrix proving reflection engagement and deferredLighting gate redundancy",
  outputSubdirectory: "ssr-water",
  receiptEnvelope: "runtime",
  servedArtifacts: [
    "Build/CesiumUnminified/Cesium.js",
    "Build/CesiumUnminified/index.js",
    "packages/engine/Build/Unminified/index.js",
    "Apps/CesiumViewer/index.html",
  ],
  workBudgetMs: () => SSR_WATER_CELLS.length * CELL_BUDGET_MS,
  async cells({ browser, run, origin, outputDirectory, captures }) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    const rigs = await loadRigs();
    invocationRigs = new Map(rigs.map((rig) => [rig.id, rig]));
    const records = [];
    for (const cellSpec of SSR_WATER_CELLS) {
      records.push(
        await runSsrWaterCell({
          browser,
          origin,
          cellSpec,
          rig: rigById(rigs, cellSpec.rig),
          run,
          outputDirectory,
          captures,
        }),
      );
    }
    return records;
  },
  receipt(cells, context) {
    const summary = summarizeSsrWaterCells(cells);
    // The capture-seam manifest contact-sheet.mjs reads (refused, not written,
    // when it would not validate; the receipt says which).
    let captureManifest = null;
    if (context?.outputDirectory) {
      captureManifest = writeWaterProbeManifest({
        probe: descriptor.name,
        pages: ssrWaterManifestPages(cells),
        rigsById: invocationRigs,
        context,
      });
    }
    return {
      cells,
      bands: SSR_WATER_BANDS,
      settle: SSR_WATER_SETTLE,
      summary,
      captureManifest,
    };
  },
  verdicts(cells) {
    return ssrWaterVerdicts(cells, summarizeSsrWaterCells(cells));
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
