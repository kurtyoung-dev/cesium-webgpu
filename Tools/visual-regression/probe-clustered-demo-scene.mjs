#!/usr/bin/env node
// Probe-clustered-demo-scene — replicates the exact scene built by the
// "WebGPU Clustered Lighting" Sandcastle demo (ground Primitive + 3 entity
// models + 6 colored PointLights + clustered on, at night) and verifies it
// renders with a clustered-lighting contribution and 0 device errors. This
// validates the demo's Cesium API usage end-to-end (the Sandcastle HTML
// wrapper itself is verbatim from the shipped point-light-shadows demo).
// @purpose Replicates the Clustered Lighting Sandcastle demo scene and asserts a visible clustered contribution with 0 device errors.
// @status ACTIVE
//
// ON THE SHARED RUNTIME (probe-kit harvest, clustered family). The scene is
// the rig `clustered-demo-scene`, read from `rigs/`; the browser, the origin
// (`--port`, a governed port, never 8080), the served-build preflight, the
// Edge slot and the receipt belong to `lib/probe-runtime.mjs`. The two frames
// are element captures of the scene canvas through `captureElement`, taken
// after the viewer's widgets are stripped (`lib/strip-viewer-widgets.mjs`),
// where the original took two page screenshots that included the widgets —
// and this probe measures the WHOLE frame, so the widgets were inside its
// measuring box. The brightness change is
// `lib/metrics/channel-sum-brightness.mjs`, the original in-page loop moved
// to Node (`metrics-clustered.spec.mjs` holds the two equal). Device errors
// are the shared WebGPU error gate's (`Tools/lib/webgpu-error-gate.mjs`),
// which owns the same `onuncapturederror` slot the private hook used and also
// reports a lost device.
//
// THE CHROME IS REFUSED, NOT RECORDED. The widget strip runs after each
// scene step has settled, immediately before each of the two captures, and
// the run refuses (`viewer-chrome-over-canvas`, exit 3) if anything is still
// stacked over the canvas: an element capture composites it into the frame
// this probe measures, and its measuring box is the whole frame. What the
// strips removed is recorded in the cell (`chromeRemoved`, with both strip
// reports under `chrome`).
//
// Usage: node Tools/visual-regression/probe-clustered-demo-scene.mjs [--port 8094]
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
import rig from "./rigs/clustered-demo-scene.mjs";

const SCENE_CANVAS = ".cesium-widget canvas";
/** The original measured the whole frame. */
export const MEASURE_BOX = Object.freeze({
  left: 0,
  right: 1,
  top: 0,
  bottom: 1,
});
/**
 * The original's bars: `lastActiveLightCount >= 6` (its message said
 * "expected 6"; the test was `< 6`), `changedPx >= 200`.
 */
export const MIN_ACTIVE_LIGHTS = 6;
export const MIN_CHANGED_PX = 200;

/**
 * Page side: build the demo's scene, render the OFF frames while the models
 * load. Unchanged from the in-page original apart from reading the rig and
 * being its own step.
 *
 * @param {{clock: string, dials: object}} scene The rig's clock and dials.
 * @returns {Promise<{sceneLightCount: number}>}
 */
async function pageSetup({ clock, dials }) {
  const C = await import("/Build/CesiumUnminified/index.js");
  window.__C = C;
  const v = window.viewer;
  const scene = v.scene;
  scene.globe.show = false;
  scene.skyBox.show = false;
  scene.skyAtmosphere.show = false;
  scene.backgroundColor = C.Color.fromCssColorString(dials.backgroundCss);

  const center = C.Cartesian3.fromDegrees(
    dials.centre.lon,
    dials.centre.lat,
    dials.centre.height,
  );
  const enu = C.Transforms.eastNorthUpToFixedFrame(center);
  window.__center = center;
  window.__enu = enu;
  const localToWC = (x, y, z) =>
    C.Matrix4.multiplyByPoint(
      enu,
      new C.Cartesian3(x, y, z),
      new C.Cartesian3(),
    );
  window.__localToWC = localToWC;

  scene.primitives.add(
    new C.Primitive({
      geometryInstances: new C.GeometryInstance({
        geometry: C.BoxGeometry.fromDimensions({
          vertexFormat: C.MaterialAppearance.MaterialSupport.ALL.vertexFormat,
          dimensions: new C.Cartesian3(...dials.ground.dimensionsMetres),
        }),
        modelMatrix: C.Matrix4.multiplyByTranslation(
          enu,
          new C.Cartesian3(...dials.ground.offsetMetres),
          new C.Matrix4(),
        ),
      }),
      appearance: new C.MaterialAppearance({
        material: C.Material.fromType("Color", {
          color: C.Color.fromBytes(...dials.ground.colorBytes),
        }),
        flat: false,
        translucent: false,
      }),
      asynchronous: false,
    }),
  );

  const uris = dials.models.map((model) => model.uri);
  const xs = dials.models.map((model) => model.eastMetres);
  const ents = [];
  for (let i = 0; i < uris.length; i++) {
    const pos = localToWC(xs[i], 0, 0);
    ents.push(
      v.entities.add({
        position: pos,
        orientation: C.Transforms.headingPitchRollQuaternion(
          pos,
          new C.HeadingPitchRoll(
            C.Math.toRadians(dials.models[i].headingDegrees),
            0,
            0,
          ),
        ),
        model: { uri: uris[i], scale: dials.modelScale },
      }),
    );
  }

  const cols = dials.lights.colorsCss;
  const ring = dials.lights.ringRadiusMetres;
  for (let i = 0; i < cols.length; i++) {
    const a = (i / cols.length) * C.Math.TWO_PI;
    scene.lights.add(
      new C.PointLight({
        position: localToWC(
          Math.cos(a) * ring,
          Math.sin(a) * ring,
          dials.lights.heightMetres,
        ),
        color: C.Color.fromCssColorString(cols[i]),
        intensity: dials.lights.intensity,
        range: dials.lights.range,
      }),
    );
  }

  v.clock.currentTime = C.JulianDate.fromIso8601(clock);
  v.camera.lookAt(
    center,
    new C.HeadingPitchRange(
      C.Math.toRadians(dials.lookAt.headingDegrees),
      C.Math.toRadians(dials.lookAt.pitchDegrees),
      dials.lookAt.rangeMetres,
    ),
  );
  v.camera.lookAtTransform(C.Matrix4.IDENTITY);

  // Wait for models to load.
  scene.clusteredLightingEnabled = false;
  for (let i = 0; i < dials.offFrames; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    if (ents.every((e) => e.model && true)) {
      // crude: just render plenty of frames for async model load
    }
  }
  return { sceneLightCount: scene.lights.length };
}

/**
 * Page side: enable clustered lighting and render the ON frames. Unchanged
 * from the in-page original apart from reading the rig's dials.
 *
 * @param {object} dials `rig.dials`.
 * @returns {Promise<{lastActive: number, clusteredActive: boolean}>}
 */
async function pageClusteredOn(dials) {
  const v = window.viewer;
  const scene = v.scene;
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
 * The original's clauses, per run, with its bars: (A) the dispatcher reports
 * at least six active lights with clustered lighting on; (B) at least 200
 * pixels of the whole frame changed their channel sum by more than 5 between
 * the OFF and ON frames; (C) no uncaptured device error. (D), a lost device,
 * is the shared error gate's addition. `scene.lights.length` is recorded, as
 * the original computed it; it was never a bar (the original's print of it
 * printed an empty value).
 *
 * Pure and exported so `clustered-probe-verdicts.spec.mjs` can put a cell on
 * either side of every bar without a browser.
 *
 * @param {Array<object>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateDemoScene(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    verdicts.push(
      {
        id: `clustered-lights-active/${suffix}`,
        claim: `(A) dispatcher.lastActiveLightCount with clustered on = ${cell.lastActive} of scene.lights.length ${cell.sceneLightCount} (>= ${MIN_ACTIVE_LIGHTS})`,
        pass: cell.lastActive >= MIN_ACTIVE_LIGHTS,
        detail: { lastActive: cell.lastActive, floor: MIN_ACTIVE_LIGHTS },
      },
      {
        id: `visible-contribution/${suffix}`,
        claim: `(B) ${cell.changedPx}/${cell.n} px of the frame changed channel sum by > 5 (max ${cell.maxDelta}, mean ${cell.meanOff?.toFixed(2)} -> ${cell.meanOn?.toFixed(2)}) (>= ${MIN_CHANGED_PX})`,
        pass: cell.changedPx >= MIN_CHANGED_PX,
        detail: { changedPx: cell.changedPx, floor: MIN_CHANGED_PX },
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
  name: "clustered-demo-scene",
  title:
    "The clustered-lighting gallery demo's scene — six active lights and a visible contribution",
  outputSubdirectory: "clustered-demo-scene",
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
        clock: rig.clock,
        dials: rig.dials,
      });
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
      const phase2 = await page.evaluate(pageClusteredOn, rig.dials);
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
      const gate = await collectGateErrors(page);
      return [
        {
          run,
          chrome: { off: chromeOff, on: chromeOn },
          chromeRemoved: chromeOff.removed + chromeOn.removed,
          sceneLightCount: setup?.sceneLightCount ?? null,
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
          deviceErrors: gate.errors,
          deviceLost: gate.deviceLost,
          pageErrors: diagnostics.errors.map((record) => record.text),
        },
      ];
    } finally {
      await context.close();
    }
  },
  verdicts(cells) {
    return evaluateDemoScene(cells);
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
