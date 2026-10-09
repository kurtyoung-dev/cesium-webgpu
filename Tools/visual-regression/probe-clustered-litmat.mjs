#!/usr/bin/env node
// Probe-clustered-litmat — Slice 5d Batch 154 verification.
// @purpose Clustered consumer on the primitive Mat*Lit path: a lit MaterialAppearance primitive changes under a PointLight when ON (sign recorded, not barred).
// @status ACTIVE
//
// Confirms the Forward+ clustered-lighting consumer works on the primitive
// "Mat*Lit" path (material appearance with lighting), the same way
// probe-clustered-visible.mjs verifies the glTF Model PBR path.
//
// Method:
//   1. Add a lit MaterialAppearance primitive (Color material, flat:false →
//      the `matColorLit` shader, effects BGL at @group(2)).
//   2. Frame the camera, disable the globe, capture baseline (clustered off).
//   3. Add a bright PointLight close in front, enable clustered, re-capture.
//   4. Decode both screenshots, assert a brightness delta over the primitive.
//
// PASS: 0 device errors + ON differs from OFF (channel sum, either
// direction; the sign is recorded in `delta`, not barred) by more than a
// threshold over a meaningful pixel count (a no-op consumer / wrong group
// would give 0).
//
// ON THE SHARED RUNTIME (probe-kit harvest, clustered family). The scene is
// the rig `clustered-litmat-box`, read from `rigs/`; the browser, the origin
// (`--port`, a governed port, never 8080), the served-build preflight, the
// Edge slot and the receipt belong to `lib/probe-runtime.mjs`. The two frames
// are element captures of the scene canvas through `captureElement`, taken
// after the viewer's widgets are stripped (`lib/strip-viewer-widgets.mjs`),
// where the original took two page screenshots that included the widgets.
// The brightness change is `lib/metrics/channel-sum-brightness.mjs`, the
// original in-page loop moved to Node (`metrics-clustered.spec.mjs` holds the
// two equal). Device errors are the shared WebGPU error gate's
// (`Tools/lib/webgpu-error-gate.mjs`), which owns the same
// `onuncapturederror` slot the private hook used and also reports a lost
// device.
//
// THE CHROME IS REFUSED, NOT RECORDED. The widget strip runs after each
// scene step has settled, immediately before each of the two captures, and
// the run refuses (`viewer-chrome-over-canvas`, exit 3) if anything is still
// stacked over the canvas: an element capture composites it into the frame
// the measuring box reads. What the strips removed is recorded in the cell
// (`chromeRemoved`, with both strip reports under `chrome`).
//
// Usage: node Tools/visual-regression/probe-clustered-litmat.mjs [--port 8094]
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
import rig from "./rigs/clustered-litmat-box.mjs";

const SCENE_CANVAS = ".cesium-widget canvas";
/** The original's measuring box: `[0.3, 0.7)` of the frame on both axes. */
export const MEASURE_BOX = Object.freeze({
  left: 0.3,
  right: 0.7,
  top: 0.3,
  bottom: 0.7,
});
/** The original's bars: `lastActiveLightCount >= 1`, `changedPx >= 50`. */
export const MIN_ACTIVE_LIGHTS = 1;
export const MIN_CHANGED_PX = 50;

/**
 * Page side: build the lit box, frame it, hide the globe and render the OFF
 * frames. Unchanged from the in-page original apart from reading the rig's
 * dials and being its own step.
 *
 * @param {object} dials `rig.dials`.
 * @returns {Promise<{primReady: true} | {earlyExitErr: string}>}
 */
async function pageSetup(dials) {
  const mod = await import("/Build/CesiumUnminified/index.js");
  const C = mod;
  window.__C = C;
  const v = window.viewer;
  const scene = v.scene;

  const lon = dials.centre.lon;
  const lat = dials.centre.lat;
  const height = dials.centre.height;
  const center = C.Cartesian3.fromDegrees(lon, lat, height);
  window.__center = center;

  // Lit material primitive: a box with a Color MaterialAppearance,
  // flat:false → the `matColorLit` shader (effects BGL at @group(2)).
  // Keep the box small so the light (placed at ~1.5×radius) stays in
  // the same close/bright distance regime the Model PBR probe uses —
  // a large box pushes the light far enough that 1/dist² falloff drops
  // the contribution below the Δ>5 detection threshold.
  const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(center);
  const dimensions = new C.Cartesian3(...dials.box.dimensionsMetres);
  // Use a vertex format WITH normals — the matColorLit shader is only
  // selected when `hasNormals && !flat` (selectMaterialShader's
  // `useLighting`). MaterialSupport.BASIC lacks normals and would fall
  // back to matColorFlat (unlit), where clustered lighting never applies.
  const boxGeom = C.BoxGeometry.fromDimensions({
    vertexFormat: C.MaterialAppearance.MaterialSupport.ALL.vertexFormat,
    dimensions,
  });
  const prim = scene.primitives.add(
    new C.Primitive({
      geometryInstances: new C.GeometryInstance({
        geometry: boxGeom,
        modelMatrix,
      }),
      appearance: new C.MaterialAppearance({
        material: C.Material.fromType(dials.box.material, {
          color: C.Color.fromBytes(...dials.box.colorBytes),
        }),
        flat: false,
        translucent: false,
      }),
      asynchronous: false,
    }),
  );
  window.__prim = prim;

  for (let i = 0; i < dials.readyFrames; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    if (prim.ready) break;
  }
  if (!prim.ready) return { earlyExitErr: "primitive not ready" };

  const bs = new C.BoundingSphere(center, dials.boundingSphereRadiusMetres);
  window.__bs = bs;
  v.camera.viewBoundingSphere(
    bs,
    new C.HeadingPitchRange(
      C.Math.toRadians(dials.view.headingDegrees),
      C.Math.toRadians(dials.view.pitchDegrees),
      bs.radius * dials.view.rangeInRadii,
    ),
  );
  scene.globe.show = false;

  scene.clusteredLightingEnabled = false;
  for (let i = 0; i < dials.offFrames; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  return { primReady: true };
}

/**
 * Page side: put one point light on the camera side of the box, enable
 * clustered lighting and render the ON frames. Unchanged from the in-page
 * original apart from reading the rig's dials.
 *
 * @param {object} dials `rig.dials`.
 * @returns {Promise<{lastActive: number, clusteredActive: boolean}>}
 */
async function pageLightOn(dials) {
  const C = window.__C;
  const v = window.viewer;
  const scene = v.scene;
  const bs = window.__bs;

  // Light close in front of the box, on the camera side.
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
  // High intensity: the matte box (F0=0.04, roughness=0.5, no specular
  // punch) is a harder target than the glTF model probe — a point light
  // a couple box-radii away delivers a weak diffuse term after 1/dist²
  // falloff. The contribution scales linearly with intensity (verified:
  // ~40× intensity → ~40× pixel delta), so a large value cleanly clears
  // the Δ>5 detection threshold. probe-clustered-visible.mjs covers the
  // realistic-intensity behavior on the Model PBR path.
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
    clusteredActive: scene.context._clusteredLightingActive === true,
  };
}

/**
 * The original's clauses, per run, with its bars: the box became ready (its
 * EARLY-EXIT exited 1); (A) the dispatcher reports at least one active light
 * with clustered lighting on; (B) at least 50 pixels of the measuring box
 * changed their channel sum by more than 5 between the OFF and ON frames;
 * (C) no uncaptured device error. (D), a lost device, is the shared error
 * gate's addition.
 *
 * Pure and exported so `clustered-probe-verdicts.spec.mjs` can put a cell on
 * either side of every bar without a browser.
 *
 * @param {Array<object>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateLitmat(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    const measured = cell.primReady === true;
    const unmeasured = `not measured: ${cell.earlyExit ?? "the box was not ready"}`;
    verdicts.push(
      {
        id: `primitive-ready/${suffix}`,
        claim: `the lit box became ready${measured ? "" : ` (${cell.earlyExit})`}`,
        pass: measured,
      },
      {
        id: `clustered-light-active/${suffix}`,
        claim: measured
          ? `(A) dispatcher.lastActiveLightCount with clustered on = ${cell.lastActive} (>= ${MIN_ACTIVE_LIGHTS})`
          : `(A) ${unmeasured}`,
        pass: measured && cell.lastActive >= MIN_ACTIVE_LIGHTS,
        detail: { lastActive: cell.lastActive ?? null },
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
  name: "clustered-litmat",
  title:
    "Clustered lighting on the primitive Mat*Lit path — a lit box changes under one point light",
  outputSubdirectory: "clustered-litmat",
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
      const setup = await page.evaluate(pageSetup, rig.dials);
      const cell = {
        run,
        primReady: setup?.primReady === true,
        earlyExit: setup?.earlyExitErr ?? null,
        chrome: null,
        chromeRemoved: null,
      };
      if (cell.primReady) {
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
          clusteredActive: phase2.clusteredActive,
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
    return evaluateLitmat(cells);
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
