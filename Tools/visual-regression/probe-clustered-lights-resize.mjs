#!/usr/bin/env node
// probe-clustered-lights-resize — Q10 CLUSTERED-ASSIGN-BOUNDS-DIRTY (A7.2).
// @purpose Regression for stale cluster bins on stationary-camera resize/FOV change: a bounds-only change must re-run assign, and a repeated dispatch must leave the bins unchanged.
// @status ACTIVE
//
// Regression probe for the "stale cluster bins on stationary-camera
// resize / FOV change" bug.
//
// The Forward+ clustered-lighting pipeline runs two compute passes:
//   - ClusterBounds  → eye-space AABBs for the 16x9x24 cluster grid.
//                      Re-dispatches when (viewport, near, far,
//                      projection) change.
//   - ClusterAssign  → per-cluster light lists, read against those
//                      AABBs. Dirty-tracked on (lightCount, light
//                      positions/types, view).
//
// Bug (pre-fix): when only the projection / viewport / near-far change
// and the CAMERA DOES NOT MOVE, the eye-space light positions are
// unchanged, so the assign light-checksum matches and the assign pass
// SKIPS — leaving the per-cluster assignment bound to the STALE bounds.
//
// This probe uses a SINGLE dispatcher instance and dispatches twice with
// IDENTICAL lights + IDENTICAL (identity) view matrix, changing ONLY the
// viewport + projection + near/far between the two calls. It reads back
// the per-cluster light-count buffer after each and asserts the two
// distributions DIFFER (bins recomputed on bounds change). It then
// re-dispatches config B with identical inputs and asserts the counts
// are UNCHANGED (the legitimate light/view dirty-cache still works — the
// fix did not defeat caching).
//
// Buffer-readback (not pixel) verification is the discriminating signal
// for this compute-state bug — it mirrors probe-clustered-dispatcher.mjs.
// A frame of the viewer page is also captured for the record. (This line used
// to call it "a clustered-lit scene"; the dispatcher here is standalone and
// draws into nothing, so the frame is the page's default view.)
//
// WHAT THE CACHE CLAUSE CAN AND CANNOT SEE. B-vs-B-again equality is also what
// a second assign pass over identical inputs would produce, so that clause
// cannot tell a cache hit from a re-run; it does catch a re-dispatch that
// changes the counts. Recorded, not changed: a new bar is not this file's to
// invent in a harvest.
//
// ON THE SHARED RUNTIME (probe-kit harvest, clustered family). The synthetic
// inputs are the rig `clustered-bounds-resize-synthetic`, read from `rigs/`;
// the browser, the origin (`--port`, a governed port, never 8080), the
// served-build preflight, the Edge slot and the receipt belong to
// `lib/probe-runtime.mjs`, which launches Edge with this probe's own Vulkan
// flags (recorded in the runtime receipt). The three count readbacks are
// returned whole and compared in Node by `lib/metrics/cluster-light-counts.mjs`
// (`metrics-clustered.spec.mjs` holds it equal to the in-page loops it
// replaced). Device errors are the shared WebGPU error gate's
// (`Tools/lib/webgpu-error-gate.mjs`), which owns the same
// `onuncapturederror` slot the private hook used and also reports a lost
// device. The record frame is an element capture of the scene canvas through
// `captureElement`, after the viewer's widgets are stripped. The strip runs
// immediately before that capture, so its report describes the frame it sits
// beside. No verdict reads the frame, so what is left over the canvas is
// recorded in the cell (`chrome`, `chromeRemoved`), not refused: the probes
// that score a frame refuse instead (`viewer-chrome-over-canvas`).
//
// Usage: node Tools/visual-regression/probe-clustered-lights-resize.mjs [--port 8094]
// @runtime lib/probe-runtime.mjs

import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { captureUrlFor } from "./lib/capture.mjs";
import {
  CLUSTER_GRID,
  clusterCellsThatDiffer,
  summariseClusterLightCounts,
} from "./lib/metrics/cluster-light-counts.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import rig from "./rigs/clustered-bounds-resize-synthetic.mjs";

const SCENE_CANVAS = ".cesium-widget canvas";
/** The original's expected active-light count per dispatch. */
export const EXPECTED_ACTIVE = 1;

/**
 * Page side: one standalone dispatcher, dispatched with projection A, then B,
 * then B again, reading the per-cluster count buffer back after each.
 * Unchanged from the in-page original apart from reading the rig's dials and
 * returning the readbacks whole for Node to compare.
 *
 * @param {{dials: object, cells: number}} input The rig's dials and the grid size.
 * @returns {Promise<object>} The three readbacks, or `{earlyExitErr}`.
 */
async function pageResize({ dials, cells }) {
  const mod = await import("/Build/CesiumUnminified/index.js");
  const device = window.viewer.scene.context._device;
  const DispatcherCtor = mod.WebGPUClusteredLightingDispatcher;
  if (typeof DispatcherCtor !== "function") {
    return {
      earlyExitErr: `dispatcher missing (typeof=${typeof DispatcherCtor})`,
    };
  }
  const C = mod;
  // 16 * 9 * 24 cells (CLUSTER_GRID).
  const TOTAL = cells;
  const COUNT_BYTES = TOTAL * 4;

  // A single OFF-CENTER point light so its screen/depth footprint is
  // sensitive to both aspect (X/Y tiles) and near/far (Z slices).
  // Directional lights are excluded on purpose — they hit every
  // cluster uniformly and would mask a bounds change.
  const lights = [dials.light];
  // IDENTITY view for BOTH configs — world == eye, camera never moves.
  const viewArr = Array.from(C.Matrix4.IDENTITY);

  function makeCfg(w, h, fovY, near, far) {
    const proj = C.Matrix4.computePerspectiveFieldOfView(
      fovY,
      w / h,
      near,
      far,
      new C.Matrix4(),
    );
    const invProj = Array.from(C.Matrix4.inverse(proj, new C.Matrix4()));
    return {
      enabled: true,
      lights,
      viewportWidth: w,
      viewportHeight: h,
      near,
      far,
      inverseProjection: invProj,
      viewMatrix: viewArr,
    };
  }

  // Config A vs Config B: identical lights + view; different
  // viewport aspect, FOV, and near/far → cluster bounds must differ.
  const fromDials = (p) =>
    makeCfg(p.viewportWidth, p.viewportHeight, p.fovYRadians, p.near, p.far);
  const cfgA = fromDials(dials.projectionA);
  const cfgB = fromDials(dials.projectionB);

  const dispatcher = new DispatcherCtor(device);

  async function dispatchAndReadCounts(cfg, label) {
    const enc = device.createCommandEncoder({ label });
    const active = dispatcher.dispatch(enc, cfg);
    device.queue.submit([enc.finish()]);
    const staging = device.createBuffer({
      size: COUNT_BYTES,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const rb = device.createCommandEncoder({ label: `${label}-rb` });
    rb.copyBufferToBuffer(
      dispatcher.perClusterLightCountBuffer,
      0,
      staging,
      0,
      COUNT_BYTES,
    );
    device.queue.submit([rb.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const counts = new Uint32Array(staging.getMappedRange().slice());
    staging.unmap();
    // The total / occupied reduction moved to Node
    // (`lib/metrics/cluster-light-counts.mjs`).
    return { active, counts: Array.from(counts) };
  }

  const A = await dispatchAndReadCounts(cfgA, "cfgA");
  const B = await dispatchAndReadCounts(cfgB, "cfgB");
  // Control: re-dispatch B with identical inputs → dirty-cache must
  // hold (bounds unchanged + light checksum unchanged → assign skips),
  // so counts are byte-identical to B.
  const B2 = await dispatchAndReadCounts(cfgB, "cfgB-again");

  // The A-vs-B and B-vs-B-again comparisons moved to Node
  // (`clusterCellsThatDiffer`); the three readbacks go back whole.
  return {
    TOTAL,
    aActive: A.active,
    bActive: B.active,
    aCounts: A.counts,
    bCounts: B.counts,
    b2Counts: B2.counts,
  };
}

/**
 * The original's clauses, per run, with its bars: the dispatcher class is in
 * the bundle (its EARLY-EXIT exited 1); both dispatches report exactly one
 * active light; the point light occupies at least one cluster under each
 * projection; the A and B readbacks differ in at least one cluster (bins
 * recomputed on a bounds-only change); the B and B-again readbacks differ in
 * none; no uncaptured device error. A lost device is the shared error gate's
 * addition. (See the header for what the B-again clause can and cannot see.)
 *
 * Pure and exported so `clustered-probe-verdicts.spec.mjs` can put a cell on
 * either side of every bar without a browser.
 *
 * @param {Array<object>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateLightsResize(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    const measured = cell.earlyExit === null;
    const not = `not measured: ${cell.earlyExit}`;
    verdicts.push(
      {
        id: `dispatcher-exported/${suffix}`,
        claim: `WebGPUClusteredLightingDispatcher is in the bundle${measured ? "" : ` (${cell.earlyExit})`}`,
        pass: measured,
      },
      {
        id: `one-active-light/${suffix}`,
        claim: measured
          ? `active lights per dispatch: A ${cell.aActive}, B ${cell.bActive} (${EXPECTED_ACTIVE} each)`
          : `active lights per dispatch: ${not}`,
        pass:
          measured &&
          cell.aActive === EXPECTED_ACTIVE &&
          cell.bActive === EXPECTED_ACTIVE,
      },
      {
        id: `light-occupies-clusters/${suffix}`,
        claim: measured
          ? `occupied clusters: A ${cell.a?.occupied}, B ${cell.b?.occupied} (> 0 each)`
          : `occupied clusters: ${not}`,
        pass: measured && cell.a?.occupied > 0 && cell.b?.occupied > 0,
        detail: { a: cell.a ?? null, b: cell.b ?? null },
      },
      {
        id: `bins-recompute-on-bounds-change/${suffix}`,
        claim: measured
          ? `A-vs-B differing clusters: ${cell.diffCells}/${CLUSTER_GRID.cells} (> 0: assign re-ran on a bounds-only change)`
          : `A-vs-B differing clusters: ${not}`,
        pass: measured && cell.diffCells > 0,
      },
      {
        id: `repeat-leaves-bins-unchanged/${suffix}`,
        claim: measured
          ? `B-vs-B-again differing clusters: ${cell.b2DiffCells} (0)`
          : `B-vs-B-again differing clusters: ${not}`,
        pass: measured && cell.b2DiffCells === 0,
      },
      {
        id: `device-errors/${suffix}`,
        claim: `uncaptured device errors: ${cell.deviceErrors.length}`,
        pass: cell.deviceErrors.length === 0,
        detail: { errors: cell.deviceErrors.slice(0, 10) },
      },
      {
        id: `device-not-lost/${suffix}`,
        claim: `device lost: ${cell.deviceLost ?? "no"}`,
        pass: cell.deviceLost === null,
      },
    );
  }
  return verdicts;
}

/** The rig's page on the run's origin, on the WebGPU backend. */
function hostUrl(origin) {
  const url = new URL(captureUrlFor({ rig, origin }));
  url.searchParams.set("renderer", "webgpu");
  return url.href;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "clustered-lights-resize",
  title:
    "Clustered-lighting bins after a bounds-only change — recomputed on resize/FOV, unchanged on a repeat",
  outputSubdirectory: "clustered-lights-resize",
  // Nothing banked a JSON receipt before the migration, so no reader keys off
  // a probe-owned field set; one runtime document is the honest shape.
  receiptEnvelope: "runtime",
  args: { defaults: { renderers: ["webgpu"] } },
  // The CesiumViewer page and the in-page import both read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  // The original's own launch flags, kept as a recorded measurement condition.
  launchArgs: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--use-vulkan",
  ],
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the clustered-lighting dispatcher is WebGPU-only, so this probe has " +
          `nothing to measure on ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const context = await browser.newContext({ viewport: { ...rig.viewport } });
    try {
      const page = await context.newPage();
      await page.addInitScript(errorGateInit);
      await page.goto(hostUrl(origin), { waitUntil: "networkidle" });
      await page.waitForFunction(() => !!window.viewer);
      await armWebGPUDevices(page);
      const result = await page.evaluate(pageResize, {
        dials: rig.dials,
        cells: CLUSTER_GRID.cells,
      });
      const gate = await collectGateErrors(page);
      // For the record only: the viewer page as loaded. No bar reads it, so
      // what the strip leaves over the canvas is recorded here, not refused.
      const chrome = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
      await captureElement({
        page,
        selector: SCENE_CANVAS,
        name: `record-run${run}`,
        outputDirectory,
        captures,
      });
      const cell = {
        run,
        chrome,
        chromeRemoved: chrome?.removed ?? null,
        earlyExit: result.earlyExitErr ?? null,
        deviceErrors: gate.errors,
        deviceLost: gate.deviceLost,
      };
      if (cell.earlyExit === null) {
        Object.assign(cell, {
          aActive: result.aActive,
          bActive: result.bActive,
          a: summariseClusterLightCounts(result.aCounts),
          b: summariseClusterLightCounts(result.bCounts),
          bAgain: summariseClusterLightCounts(result.b2Counts),
          diffCells: clusterCellsThatDiffer(result.aCounts, result.bCounts),
          b2DiffCells: clusterCellsThatDiffer(result.bCounts, result.b2Counts),
        });
      }
      return [cell];
    } finally {
      await context.close();
    }
  },
  verdicts(cells) {
    return evaluateLightsResize(cells);
  },
  receipt(cells, context) {
    for (const verdict of context.verdicts) {
      console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
    }
    return { rig: rig.id, cells, verdicts: context.verdicts };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
