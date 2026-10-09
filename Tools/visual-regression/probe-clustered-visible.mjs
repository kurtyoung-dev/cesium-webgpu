#!/usr/bin/env node
// Probe-clustered-visible — Slice 5d Batch 153 verification.
// @purpose Clustered consumer on the glTF Model PBR path: PointLight + clustered ON changes the model center vs OFF by a measured margin (sign recorded, not barred).
// @status ACTIVE
//
// Confirms the Forward+ clustered lighting consumer (ModelPBRComplete +
// the ClusteredLighting FS chunk reading @group(3) bindings 18..22 via
// the effects bind group) actually contributes per-pixel light to a
// glTF model.
//
// Method:
//   1. Load CesiumViewer, drop a glTF model at a known position and
//      zoom the camera to its bounding sphere.
//   2. Capture a baseline page.screenshot with
//      `scene.clusteredLightingEnabled = false` (no lights).
//   3. Add a bright PointLight at the model's bounding sphere, enable
//      clustered lighting, capture a second screenshot.
//   4. Decode both PNGs and compute the mean brightness over the
//      central canvas region; the ON sample should differ from OFF
//      by a measurable margin (the sign is recorded in `delta`, not
//      barred).
//
// PASS criteria (the bars the original applied; see `evaluateVisible`):
//   - 0 device errors across both phases.
//   - At least 50 pixels of the central box change their channel sum by
//     more than 5 between OFF and ON, in either direction (a no-op consumer
//     would change none). This line used to read "brightness delta on > off
//     by ≥ ~5 LSBs"; that was prose and never a bar, and the box means are
//     recorded, not barred (corrected in the probe-kit harvest).
//
// ON THE SHARED RUNTIME (probe-kit harvest, clustered family). The scene is
// the rig `clustered-visible-vehicle`, read from `rigs/`; the browser, the
// origin (`--port`, a governed port, never 8080), the served-build preflight,
// the Edge slot and the receipt belong to `lib/probe-runtime.mjs`. The two
// frames are element captures of the scene canvas through `captureElement`,
// taken after the viewer's widgets are stripped
// (`lib/strip-viewer-widgets.mjs`), where the original took two page
// screenshots that included the widgets. The brightness change is
// `lib/metrics/channel-sum-brightness.mjs`, the original in-page loop moved to
// Node (`metrics-clustered.spec.mjs` holds the two equal). Device errors are
// the shared WebGPU error gate's (`Tools/lib/webgpu-error-gate.mjs`), which
// owns the same `onuncapturederror` slot the private hook used and also
// reports a lost device. The params-buffer readback and the buffers-stash keys
// are recorded in the cell, as the original printed them; neither was ever a
// bar.
//
// THE CHROME IS REFUSED, NOT RECORDED. The widget strip runs after each
// scene step has settled, immediately before each of the two captures, and
// the run refuses (`viewer-chrome-over-canvas`, exit 3) if anything is still
// stacked over the canvas: an element capture composites it into the frame
// the measuring box reads. What the strips removed is recorded in the cell
// (`chromeRemoved`, with both strip reports under `chrome`).
//
// Usage: node Tools/visual-regression/probe-clustered-visible.mjs [--port 8094]
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
import rig from "./rigs/clustered-visible-vehicle.mjs";

const SCENE_CANVAS = ".cesium-widget canvas";
/** The original's measuring box: the central 50 %, `[0.25, 0.75)` on both axes. */
export const MEASURE_BOX = Object.freeze({
  left: 0.25,
  right: 0.75,
  top: 0.25,
  bottom: 0.75,
});
/** The original's bars: `lastActiveLightCount >= 1`, `changedPx >= 50`. */
export const MIN_ACTIVE_LIGHTS = 1;
export const MIN_CHANGED_PX = 50;

/**
 * Page side, phase 1: load the model, frame the camera, hide the globe and
 * render the OFF frames. Unchanged from the in-page original apart from
 * reading the rig and being its own step.
 *
 * @param {{asset: string, dials: object}} scene The rig's asset and dials.
 * @returns {Promise<{modelReady: true, bsRadius: number} | {earlyExitErr: string}>}
 */
async function pageSetup({ asset, dials }) {
  const mod = await import("/Build/CesiumUnminified/index.js");
  const C = mod;
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
  v.camera.viewBoundingSphere(
    bs,
    new C.HeadingPitchRange(
      C.Math.toRadians(dials.view.headingDegrees),
      C.Math.toRadians(dials.view.pitchDegrees),
      bs.radius * dials.view.rangeInRadii,
    ),
  );

  // Disable globe so the background is uniform (sky) and any change
  // we observe must come from the model lighting, not terrain
  // shading drift.
  scene.globe.show = false;

  scene.clusteredLightingEnabled = false;
  for (let i = 0; i < dials.offFrames; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  return { modelReady: true, bsRadius: bs.radius };
}

/**
 * Page side, phase 2: add the light, enable clustered lighting, render the
 * ON frames and read the params buffer back. Unchanged from the in-page
 * original apart from reading the rig's dials.
 *
 * @param {object} dials `rig.dials`.
 * @returns {Promise<{lastActive: number, stashKeys: string, paramsActiveCount: number}>}
 */
async function pageLightOn(dials) {
  const C = window.__C;
  const v = window.viewer;
  const scene = v.scene;
  const bs = window.__bs;

  // Place the light just in front of the model on the camera side,
  // close to the surface. Pointing from the camera direction
  // guarantees camera-visible front faces have NdotL > 0 (avoids the
  // failure mode where an arbitrary ECEF offset lights hidden faces —
  // local "up" near Pittsburgh is a diagonal ECEF vector, not +Z).
  // Close distance keeps the 1/dist² falloff from dimming the
  // contribution below the noise floor; high intensity + large range
  // make the per-pixel diffuse+specular unambiguous.
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
    v.scene._alternateSceneRenderer?._clusteredLightingDispatcher ?? null;
  const lastActive = dispatcher?.lastActiveLightCount ?? -1;
  const ctx = scene.context;
  const stashKeys = ctx._clusteredLightingBuffers
    ? Object.keys(ctx._clusteredLightingBuffers).sort().join(",")
    : "<absent>";

  let paramsActiveCount = -1;
  if (dispatcher && ctx._clusteredLightingBuffers) {
    const device = ctx._device;
    const staging = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(
      ctx._clusteredLightingBuffers.params,
      0,
      staging,
      0,
      32,
    );
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const floats = new Float32Array(staging.getMappedRange().slice());
    staging.unmap();
    paramsActiveCount = floats[4];
  }

  return { lastActive, stashKeys, paramsActiveCount };
}

/**
 * The original's clauses, per run, with its bars: the model became ready (its
 * EARLY-EXIT exited 1); (A) the dispatcher reports at least one active light
 * with clustered lighting on; (B) at least 50 pixels of the measuring box
 * changed their channel sum by more than 5 between the OFF and ON frames;
 * (C) no uncaptured device error. (D), a lost device, is the shared error
 * gate's addition. The header's "delta >= ~5 LSBs" prose was never a bar:
 * the only brightness bar the original applied is (B).
 *
 * Pure and exported so `clustered-probe-verdicts.spec.mjs` can put a cell on
 * either side of every bar without a browser.
 *
 * @param {Array<object>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateVisible(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    const measured = cell.modelReady === true;
    const unmeasured = `not measured: ${cell.earlyExit ?? "the model was not ready"}`;
    verdicts.push(
      {
        id: `model-ready/${suffix}`,
        claim: `the glTF model became ready${measured ? "" : ` (${cell.earlyExit})`}`,
        pass: measured,
      },
      {
        id: `clustered-light-active/${suffix}`,
        claim: measured
          ? `(A) dispatcher.lastActiveLightCount with clustered on = ${cell.lastActive} (>= ${MIN_ACTIVE_LIGHTS})`
          : `(A) ${unmeasured}`,
        pass: measured && cell.lastActive >= MIN_ACTIVE_LIGHTS,
        detail: {
          lastActive: cell.lastActive ?? null,
          paramsActiveCount: cell.paramsActiveCount ?? null,
          stashKeys: cell.stashKeys ?? null,
        },
      },
      {
        id: `visible-contribution/${suffix}`,
        claim: measured
          ? `(B) ${cell.changedPx}/${cell.n} px of the box changed channel sum by > 5 (max ${cell.maxDelta}, mean ${cell.meanOff?.toFixed(2)} -> ${cell.meanOn?.toFixed(2)}) (>= ${MIN_CHANGED_PX})`
          : `(B) ${unmeasured}`,
        pass: measured && cell.changedPx >= MIN_CHANGED_PX,
        detail: { changedPx: cell.changedPx ?? null, floor: MIN_CHANGED_PX },
      },
      {
        id: `device-errors/${suffix}`,
        claim: `(C) uncaptured device errors: ${cell.deviceErrors.length}`,
        pass: cell.deviceErrors.length === 0,
        detail: { errors: cell.deviceErrors.slice(0, 10) },
      },
      {
        id: `device-not-lost/${suffix}`,
        claim: `(D) device lost: ${cell.deviceLost ?? "no"}`,
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
  name: "clustered-visible",
  title:
    "Clustered lighting on the glTF Model PBR path — a vehicle changes under one point light",
  outputSubdirectory: "clustered-visible",
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
          stashKeys: phase2.stashKeys,
          paramsActiveCount: phase2.paramsActiveCount,
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
    return evaluateVisible(cells);
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
