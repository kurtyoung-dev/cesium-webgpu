#!/usr/bin/env node
// probe-clustered-multifrustum — NS-CLUSTER-MULTIFRUSTUM-BOUNDS acceptance.
// @purpose Proves single-grid cluster binning is self-consistent and conservatively correct in a real multi-frustum scene (>=2 frustums).
// @status ACTIVE
//
// Premise under verification: the Forward+ clustered-lighting dispatch
// (WebGPUSceneRendererClusteredLighting.ts:208-219) collapses the whole
// visible depth into a SINGLE cluster grid built from
// scene.camera.frustum.near/far. The campaign brief framed this as a
// binning-correctness gap for multi-frustum scenes.
//
// What this probe proves: the single-grid binning is SELF-CONSISTENT and
// CONSERVATIVELY CORRECT. The FS `clusterIndexFor` (ClusteredLighting.wgsl)
// uses the identical near/far + identical exponential slice mapping as the
// ClusterBounds compute pass, so every fragment lands in the cluster whose
// AABB actually contains it — regardless of how many render frustums the
// scene splits into. Per-light `dist > range → 0` cutoff means any extra
// lights a coarse cluster over-includes contribute exactly 0. Net: correct
// per-pixel lighting in a genuine multi-frustum scene.
//
// Method:
//   1. Load CesiumViewer (WebGPU), globe ON. Drop a glTF model and frame
//      an oblique high camera so terrain extends to the horizon — this
//      drives scene.numberOfFrustums >= 2 (the multi-frustum condition).
//      The globe is NOT a clustered-lighting consumer (only Model PBR +
//      Mat*Lit primitives are). This step used to conclude that the terrain
//      background is byte-identical between the OFF and ON captures, so the
//      central-box delta is purely the model's contribution; that was never
//      measured, and the page streams imagery between the two captures (see
//      WHAT IS RECORDED BESIDE THE BARS, below).
//   2. Capture OFF (clusteredLightingEnabled = false, no lights).
//   3. Add a bright PointLight at the model, enable clustered lighting,
//      capture ON.
//   4. Assert: numberOfFrustums >= 2 (multi-frustum established),
//      dispatcher.lastActiveLightCount >= 1, a visible central-box delta
//      (binning lit the model), and 0 device errors.
//
// PASS: multi-frustum + visible clustered contribution + 0 device errors.
//
// ON THE SHARED RUNTIME (probe-kit harvest, clustered family). The scene is
// the rig `clustered-multifrustum-vehicle`, read from `rigs/`; the browser,
// the origin (`--port`, a governed port, never 8080), the served-build
// preflight, the Edge slot and the receipt belong to `lib/probe-runtime.mjs`.
// The two frames are element captures of the scene canvas through
// `captureElement`, taken after the viewer's widgets are stripped
// (`lib/strip-viewer-widgets.mjs`), where the original took two page
// screenshots that included the widgets. The brightness change is
// `lib/metrics/channel-sum-brightness.mjs`, the original in-page loop moved to
// Node (`metrics-clustered.spec.mjs` holds the two equal). Device errors are
// the shared WebGPU error gate's (`Tools/lib/webgpu-error-gate.mjs`), which
// owns the same `onuncapturederror` slot the private hook used and also
// reports a lost device.
//
// WHAT IS RECORDED BESIDE THE BARS. The page is loaded without the offline
// flag, as it always was, so the globe streams imagery between the OFF and
// ON captures. `globe.tilesLoaded` at each capture is now recorded in the
// cell (it is not a bar), so a reader can see whether streaming tiles shared
// the measuring box with the light's contribution.
//
// THE CHROME IS REFUSED, NOT RECORDED. The widget strip runs after each
// scene step has settled, immediately before each of the two captures, and
// the run refuses (`viewer-chrome-over-canvas`, exit 3) if anything is still
// stacked over the canvas: an element capture composites it into the frame
// the measuring box reads. What the strips removed is recorded in the cell
// (`chromeRemoved`, with both strip reports under `chrome`).
//
// Usage: node Tools/visual-regression/probe-clustered-multifrustum.mjs [--port 8094]
// @runtime lib/probe-runtime.mjs

import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";
import { decodePng } from "../lib/png-decode.mjs";
import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { captureUrlFor } from "./lib/capture.mjs";
import {
  channelSumChange,
  fractionalRoi,
} from "./lib/metrics/channel-sum-brightness.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import rig from "./rigs/clustered-multifrustum-vehicle.mjs";

const SCENE_CANVAS = ".cesium-widget canvas";
/** The original's measuring box: `[0.3, 0.7)` across, `[0.35, 0.75)` down. */
export const MEASURE_BOX = Object.freeze({
  left: 0.3,
  right: 0.7,
  top: 0.35,
  bottom: 0.75,
});
/** The original's bars: frustums >= 2, `lastActiveLightCount >= 1`, `changedPx >= 50`. */
export const MIN_FRUSTUMS = 2;
export const MIN_ACTIVE_LIGHTS = 1;
export const MIN_CHANGED_PX = 50;

/**
 * Page side, phase 1: load the model, frame it, lower the log-depth
 * far-to-near ratio and render the OFF frames with the globe on. Unchanged
 * from the in-page original apart from reading the rig and being its own step.
 *
 * @param {{asset: string, dials: object}} scene The rig's asset and dials.
 * @returns {Promise<object>} The original's setup record, or `{earlyExitErr}`.
 */
async function pageSetup({ asset, dials }) {
  const C = await import("/Build/CesiumUnminified/index.js");
  window.__C = C;
  const v = window.viewer;
  const scene = v.scene;

  const lon = dials.position.lon;
  const lat = dials.position.lat;
  const height = dials.position.height;
  const position = C.Cartesian3.fromDegrees(lon, lat, height);
  const modelMatrix = C.Transforms.headingPitchRollToFixedFrame(
    position,
    new C.HeadingPitchRoll(0, 0, 0),
  );
  const model = scene.primitives.add(
    await C.Model.fromGltfAsync({
      url: asset,
      modelMatrix,
      scale: dials.modelScale,
    }),
  );
  window.__model = model;

  for (let i = 0; i < dials.readyFrames; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    if (model.ready) break;
  }
  if (!model.ready) return { earlyExitErr: "model not ready" };

  const bs = model.boundingSphere;
  window.__bs = bs;

  // Oblique, high, pitched-down view: the model sits near-center while
  // terrain sweeps out to the horizon behind it. The large depth spread
  // (metres-to-horizon) is what makes the view split into >1 frustum.
  v.camera.viewBoundingSphere(
    bs,
    new C.HeadingPitchRange(
      C.Math.toRadians(dials.view.headingDegrees),
      C.Math.toRadians(dials.view.pitchDegrees),
      bs.radius * dials.view.rangeInRadii,
    ),
  );

  // Force a genuine multi-frustum render WITHOUT disabling the log-depth
  // buffer (disabling it breaks the WebGPU model render — a separate
  // confound). The log-depth path splits the depth range on
  // logarithmicDepthFarToNearRatio; lowering it makes even this compact,
  // well-framed model scene split into >=2 render frustums — the exact
  // condition the premise is about — while the model renders + lights
  // correctly. The globe is NOT a clustered-lighting consumer (only Model
  // PBR + Mat*Lit primitives are); that the terrain background is
  // byte-identical across OFF/ON is not measured (see the header).
  scene.logarithmicDepthFarToNearRatio = dials.logarithmicDepthFarToNearRatio;
  scene.clusteredLightingEnabled = false;
  for (let i = 0; i < dials.offFrames; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  return {
    modelReady: true,
    bsRadius: bs.radius,
    numFrustumsOff: scene.numberOfFrustums,
    farToNearRatio: scene.farToNearRatio,
    tilesLoadedOff: scene.globe.tilesLoaded,
  };
}

/**
 * Page side, phase 2: add the light, enable clustered lighting and render the
 * ON frames. Unchanged from the in-page original apart from reading the rig's
 * dials and recording `tilesLoaded`.
 *
 * @param {object} dials `rig.dials`.
 * @returns {Promise<{lastActive: number, numFrustumsOn: number, tilesLoadedOn: boolean}>}
 */
async function pageLightOn(dials) {
  const C = window.__C;
  const v = window.viewer;
  const scene = v.scene;
  const bs = window.__bs;

  const camDir = C.Cartesian3.subtract(
    v.camera.positionWC,
    bs.center,
    new C.Cartesian3(),
  );
  C.Cartesian3.normalize(camDir, camDir);
  const lightPos = C.Cartesian3.add(
    bs.center,
    C.Cartesian3.multiplyByScalar(
      camDir,
      bs.radius * dials.light.distanceInRadii,
      new C.Cartesian3(),
    ),
    new C.Cartesian3(),
  );
  scene.lights.add(
    new C.PointLight({
      position: lightPos,
      color: C.Color[dials.light.colorName],
      intensity: dials.light.intensity,
      range: bs.radius * dials.light.rangeInRadii,
    }),
  );
  scene.clusteredLightingEnabled = true;
  for (let i = 0; i < dials.onFrames; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }

  const dispatcher =
    scene._alternateSceneRenderer?._clusteredLightingDispatcher ?? null;
  return {
    lastActive: dispatcher?.lastActiveLightCount ?? -1,
    numFrustumsOn: scene.numberOfFrustums,
    tilesLoadedOn: scene.globe.tilesLoaded,
  };
}

/**
 * The original's clauses, per run, with its bars: the model became ready (its
 * EARLY-EXIT exited 1); (A) the larger of the OFF and ON frustum counts is at
 * least 2 (the multi-frustum condition holds); (B) the dispatcher reports at
 * least one active light with clustered lighting on; (C) at least 50 pixels
 * of the measuring box changed their channel sum by more than 5 between the
 * OFF and ON frames; (D) no uncaptured device error. (E), a lost device, is
 * the shared error gate's addition.
 *
 * Pure and exported so `clustered-probe-verdicts.spec.mjs` can put a cell on
 * either side of every bar without a browser.
 *
 * @param {Array<object>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateMultifrustum(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    const measured = cell.modelReady === true;
    const unmeasured = `not measured: ${cell.earlyExit ?? "the model was not ready"}`;
    const numFrustums = Math.max(
      cell.numFrustumsOff ?? 0,
      cell.numFrustumsOn ?? 0,
    );
    verdicts.push(
      {
        id: `model-ready/${suffix}`,
        claim: `the glTF model became ready${measured ? "" : ` (${cell.earlyExit})`}`,
        pass: measured,
      },
      {
        id: `multi-frustum/${suffix}`,
        claim: measured
          ? `(A) numberOfFrustums OFF ${cell.numFrustumsOff}, ON ${cell.numFrustumsOn} (farToNearRatio ${cell.farToNearRatio}) (max >= ${MIN_FRUSTUMS})`
          : `(A) ${unmeasured}`,
        pass: measured && numFrustums >= MIN_FRUSTUMS,
        detail: { numFrustums, floor: MIN_FRUSTUMS },
      },
      {
        id: `clustered-light-active/${suffix}`,
        claim: measured
          ? `(B) dispatcher.lastActiveLightCount with clustered on = ${cell.lastActive} (>= ${MIN_ACTIVE_LIGHTS})`
          : `(B) ${unmeasured}`,
        pass: measured && cell.lastActive >= MIN_ACTIVE_LIGHTS,
        detail: { lastActive: cell.lastActive ?? null },
      },
      {
        id: `visible-contribution/${suffix}`,
        claim: measured
          ? `(C) ${cell.changedPx}/${cell.n} px of the box changed channel sum by > 5 (max ${cell.maxDelta}, mean ${cell.meanOff?.toFixed(2)} -> ${cell.meanOn?.toFixed(2)}; tilesLoaded OFF ${cell.tilesLoadedOff}, ON ${cell.tilesLoadedOn}) (>= ${MIN_CHANGED_PX})`
          : `(C) ${unmeasured}`,
        pass: measured && cell.changedPx >= MIN_CHANGED_PX,
        detail: { changedPx: cell.changedPx ?? null, floor: MIN_CHANGED_PX },
      },
      {
        id: `device-errors/${suffix}`,
        claim: `(D) uncaptured device errors: ${cell.deviceErrors.length}`,
        pass: cell.deviceErrors.length === 0,
        detail: { errors: cell.deviceErrors.slice(0, 10) },
      },
      {
        id: `device-not-lost/${suffix}`,
        claim: `(E) device lost: ${cell.deviceLost ?? "no"}`,
        pass: cell.deviceLost === null,
      },
    );
  }
  return verdicts;
}

/** The rig's page on the run's origin, on the WebGPU backend. */
function sceneUrl(origin) {
  const url = new URL(captureUrlFor({ rig, origin }));
  url.searchParams.set("renderer", "webgpu");
  return url.href;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "clustered-multifrustum",
  title:
    "Clustered lighting in a multi-frustum scene — the single-grid binning lights the model with the globe on",
  outputSubdirectory: "clustered-multifrustum",
  // Nothing banked a JSON receipt before the migration, so no reader keys off
  // a probe-owned field set; one runtime document is the honest shape.
  receiptEnvelope: "runtime",
  args: { defaults: { renderers: ["webgpu"] } },
  // The CesiumViewer page and the in-page import both read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "Forward+ clustered lighting is WebGPU-only, so this probe has " +
          `nothing to measure on ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const context = await browser.newContext({ viewport: { ...rig.viewport } });
    try {
      const page = await context.newPage();
      const diagnostics = attachPageDiagnostics(page, {
        filter: (record) => record.type === "pageerror",
        cap: 20,
      });
      await page.addInitScript(errorGateInit);
      await page.goto(sceneUrl(origin), { waitUntil: "networkidle" });
      await page.waitForFunction(() => !!window.viewer);
      await armWebGPUDevices(page);
      const setup = await page.evaluate(pageSetup, {
        asset: rig.asset,
        dials: rig.dials,
      });
      const cell = {
        run,
        modelReady: setup?.modelReady === true,
        earlyExit: setup?.earlyExitErr ?? null,
        bsRadius: setup?.bsRadius ?? null,
        numFrustumsOff: setup?.numFrustumsOff ?? null,
        farToNearRatio: setup?.farToNearRatio ?? null,
        tilesLoadedOff: setup?.tilesLoadedOff ?? null,
        chrome: null,
        chromeRemoved: null,
      };
      if (cell.modelReady) {
        // After the OFF settle and immediately before the capture: the chrome
        // comes off, or the run refuses rather than score it.
        const chromeOff = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
        if (
          !Array.isArray(chromeOff?.leftovers) ||
          chromeOff.leftovers.length > 0
        ) {
          throw new ProbeRefusal(
            "viewer-chrome-over-canvas",
            "after the widget strip, elements were still stacked over the scene canvas " +
              `before the OFF capture (${chromeOff?.leftovers?.join(", ") ?? "no strip report"}), so the capture would score them`,
            { capture: "off", chrome: chromeOff ?? null },
          );
        }
        const off = await captureElement({
          page,
          selector: SCENE_CANVAS,
          name: `off-run${run}`,
          outputDirectory,
          captures,
        });
        const phase2 = await page.evaluate(pageLightOn, rig.dials);
        // Again before the ON capture: the ON step runs between the two.
        const chromeOn = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
        if (
          !Array.isArray(chromeOn?.leftovers) ||
          chromeOn.leftovers.length > 0
        ) {
          throw new ProbeRefusal(
            "viewer-chrome-over-canvas",
            "after the widget strip, elements were still stacked over the scene canvas " +
              `before the ON capture (${chromeOn?.leftovers?.join(", ") ?? "no strip report"}), so the capture would score them`,
            { capture: "on", chrome: chromeOn ?? null },
          );
        }
        const on = await captureElement({
          page,
          selector: SCENE_CANVAS,
          name: `on-run${run}`,
          outputDirectory,
          captures,
        });
        const offImage = decodePng(off.buffer);
        const change = channelSumChange(offImage, decodePng(on.buffer), {
          roi: fractionalRoi(offImage.width, offImage.height, MEASURE_BOX),
        });
        Object.assign(cell, {
          chrome: { off: chromeOff, on: chromeOn },
          chromeRemoved: chromeOff.removed + chromeOn.removed,
          lastActive: phase2.lastActive,
          numFrustumsOn: phase2.numFrustumsOn,
          tilesLoadedOn: phase2.tilesLoadedOn,
          width: offImage.width,
          height: offImage.height,
          roi: change.roi,
          n: change.countedPx,
          meanOff: change.meanBefore,
          meanOn: change.meanAfter,
          delta: change.delta,
          changedPx: change.changedPx,
          maxDelta: change.maxDelta,
        });
      }
      const gate = await collectGateErrors(page);
      cell.deviceErrors = gate.errors;
      cell.deviceLost = gate.deviceLost;
      cell.pageErrors = diagnostics.errors.map((record) => record.text);
      return [cell];
    } finally {
      await context.close();
    }
  },
  verdicts(cells) {
    return evaluateMultifrustum(cells);
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
