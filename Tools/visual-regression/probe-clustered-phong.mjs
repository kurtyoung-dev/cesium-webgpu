#!/usr/bin/env node
// Probe-clustered-phong — Slice 5d Batch 157 verification.
// @purpose Checks flat:false PerInstanceColorAppearance routes to the lit phong shader and the clustered consumer contributes visibly.
// @status ACTIVE
//
// Two-in-one check, both enabled by the Batch 156 MSAA fix + the Batch 157
// "decode before shader-select" fix:
//   1. A flat:false PerInstanceColorAppearance box now routes to the LIT
//      `phong` shader (was the unlit `basic` before Batch 157).
//   2. The Forward+ clustered-lighting consumer wired into the Phong
//      shaders (Batch 156) produces a visible per-pixel contribution.
//
// Captures baseline (clustered off) vs a scene-PointLight frame (clustered
// on); a brightness delta proves BOTH the phong routing + clustered eval
// (basic is unlit → would give exactly 0). PASS = delta + 0 device errors.
//
// ON THE SHARED RUNTIME (probe-kit harvest, clustered family). The scene is
// the rig `clustered-phong-box`, read from `rigs/`; the browser, the origin
// (`--port`, a governed port, never 8080), the served-build preflight, the
// Edge slot and the receipt belong to `lib/probe-runtime.mjs`. The two frames
// are element captures of the scene canvas through `captureElement`, taken
// after the viewer's widgets are stripped (`lib/strip-viewer-widgets.mjs`),
// where the original took two page screenshots that included the widgets.
// The brightness change is `lib/metrics/channel-sum-brightness.mjs`, the
// original in-page loop moved to Node (`metrics-clustered.spec.mjs` holds the
// two equal, including this probe's `| 0` box arithmetic). Device errors are
// the shared WebGPU error gate's (`Tools/lib/webgpu-error-gate.mjs`), which
// owns the same `onuncapturederror` slot the private hook used and also
// reports a lost device.
//
// THE CHROME IS REFUSED, NOT RECORDED. The widget strip runs after each
// scene step has settled, immediately before each of the two captures, and
// the run refuses (`viewer-chrome-over-canvas`, exit 3) if anything is still
// stacked over the canvas: an element capture composites it into the frame
// the measuring box reads. What the strips removed is recorded in the cell
// (`chromeRemoved`, with both strip reports under `chrome`).
//
// Usage: node Tools/visual-regression/probe-clustered-phong.mjs [--port 8094]
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
import rig from "./rigs/clustered-phong-box.mjs";

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
 * Page side: hide the globe, build the per-instance-colour box, frame it and
 * render the OFF frames. Unchanged from the in-page original apart from
 * reading the rig's dials and being its own step.
 *
 * @param {object} dials `rig.dials`.
 * @returns {Promise<{primReady: true} | {earlyExitErr: string}>}
 */
async function pageSetup(dials) {
  const C = await import("/Build/CesiumUnminified/index.js");
  window.__C = C;
  const v = window.viewer;
  const scene = v.scene;
  scene.globe.show = false;
  const center = C.Cartesian3.fromDegrees(
    dials.centre.lon,
    dials.centre.lat,
    dials.centre.height,
  );
  window.__center = center;
  const prim = scene.primitives.add(
    new C.Primitive({
      geometryInstances: new C.GeometryInstance({
        geometry: C.BoxGeometry.fromDimensions({
          vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
          dimensions: new C.Cartesian3(...dials.box.dimensionsMetres),
        }),
        modelMatrix: C.Transforms.eastNorthUpToFixedFrame(center),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(
            C.Color.fromBytes(...dials.box.colorBytes),
          ),
        },
      }),
      appearance: new C.PerInstanceColorAppearance({
        flat: false,
        translucent: false,
        closed: true,
      }),
      asynchronous: false,
    }),
  );
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
  const camDir = C.Cartesian3.subtract(
    v.camera.positionWC,
    bs.center,
    new C.Cartesian3(),
  );
  C.Cartesian3.normalize(camDir, camDir);
  scene.lights.add(
    new C.PointLight({
      position: C.Cartesian3.add(
        bs.center,
        C.Cartesian3.multiplyByScalar(
          camDir,
          bs.radius * dials.light.distanceInRadii,
          new C.Cartesian3(),
        ),
        new C.Cartesian3(),
      ),
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
  const d = scene._alternateSceneRenderer?._clusteredLightingDispatcher ?? null;
  return {
    lastActive: d?.lastActiveLightCount ?? -1,
    clusteredActive: scene.context._clusteredLightingActive === true,
  };
}

/**
 * The original's clauses, per run, with its bars: the box became ready (its
 * EARLY-EXIT exited 1); (A) the dispatcher reports at least one active light
 * with clustered lighting on; (B) at least 50 pixels of the measuring box
 * changed their channel sum by more than 5 between the OFF and ON frames
 * (unlit `basic` routing would give 0); (C) no uncaptured device error. (D),
 * a lost device, is the shared error gate's addition.
 *
 * Pure and exported so `clustered-probe-verdicts.spec.mjs` can put a cell on
 * either side of every bar without a browser.
 *
 * @param {Array<object>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluatePhong(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    const measured = cell.primReady === true;
    const unmeasured = `not measured: ${cell.earlyExit ?? "the box was not ready"}`;
    verdicts.push(
      {
        id: `primitive-ready/${suffix}`,
        claim: `the per-instance-colour box became ready${measured ? "" : ` (${cell.earlyExit})`}`,
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
          ? `(B) ${cell.changedPx}/${cell.n} px of the box changed channel sum by > 5 (max ${cell.maxDelta}, mean ${cell.meanOff?.toFixed(2)} -> ${cell.meanOn?.toFixed(2)}) (>= ${MIN_CHANGED_PX}; 0 means phong is still routed to unlit basic)`
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
  name: "clustered-phong",
  title:
    "Clustered lighting on the lit phong path — a flat:false per-instance-colour box changes under one point light",
  outputSubdirectory: "clustered-phong",
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
    return evaluatePhong(cells);
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
