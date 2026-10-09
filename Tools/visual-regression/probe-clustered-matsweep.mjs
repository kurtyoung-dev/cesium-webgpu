#!/usr/bin/env node
// Probe-clustered-matsweep — Slice 5d Batch 155 device-error sweep.
// @purpose Device-error sweep across the seven non-textured Mat*Lit shaders with clustered lighting on: at least one active light and zero device errors; the ON frame is captured as evidence, and no OFF comparison is taken.
// @status ACTIVE
//
// Validates that EACH non-textured lit material shader's pipeline compiles
// and runs cleanly with Forward+ clustered lighting enabled. The Color
// (matColorLit) + NormalMap (matNormalMapLit) visible-contribution probes
// already prove the eval math + both group layouts; this sweep is a broad
// "no WGSL-compile / binding-mismatch device error" check across the
// remaining Mat*Lit shaders wired in Batch 155.
//
// PASS: every material renders with 0 device errors and the dispatcher
// reports at least one active light. (This header used to add "AND the scene
// differs vs clustered-off"; the probe never captured an OFF frame, so that
// clause was never measured. Corrected in the probe-kit harvest rather than
// added, because a new bar is not this file's to invent.)
//
// ON THE SHARED RUNTIME (probe-kit harvest, clustered family). The scene is
// the rig `clustered-matsweep-row`, read from `rigs/`; the browser, the origin
// (`--port`, a governed port, never 8080), the served-build preflight, the
// Edge slot and the receipt belong to `lib/probe-runtime.mjs`. Device errors
// are the shared WebGPU error gate's (`Tools/lib/webgpu-error-gate.mjs`),
// which owns the same `onuncapturederror` slot the private hook used and also
// reports a lost device. The ON frame is an element capture of the scene
// canvas through `captureElement`, after the viewer's widgets are stripped:
// evidence only, never a bar. Its sha256 is in the runtime receipt, which is
// what a byte-identity comparison of the enabled-path frame across two builds
// reads (the evidence plan of `C11-61`). Because that comparison would read
// anything stacked over the canvas as part of the frame, the strip runs after
// the sweep has settled, immediately before the capture, and the run refuses
// (`viewer-chrome-over-canvas`, exit 3) if anything is left over the canvas;
// what it removed is recorded in the cell (`chromeRemoved`, `chrome`).
//
// Usage: node Tools/visual-regression/probe-clustered-matsweep.mjs [--port 8094]
// @runtime lib/probe-runtime.mjs

import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";
import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { captureUrlFor } from "./lib/capture.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import rig from "./rigs/clustered-matsweep-row.mjs";

const SCENE_CANVAS = ".cesium-widget canvas";
/** The original's bar: `lastActiveLightCount >= 1`. */
export const MIN_ACTIVE_LIGHTS = 1;

/**
 * Page side: build the row of material boxes, frame them, add the light,
 * enable clustered lighting and render. Unchanged from the in-page original
 * apart from reading the rig's dials.
 *
 * @param {object} dials `rig.dials`.
 * @returns {Promise<{lastActive: number, clusteredActive: boolean, perType: object}>}
 */
async function pageSweep(dials) {
  const MATERIALS = dials.materials;
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  scene.globe.show = false;

  const lon = dials.centre.lon;
  const lat = dials.centre.lat;
  const height = dials.centre.height;
  const center = C.Cartesian3.fromDegrees(lon, lat, height);

  // Lay the material boxes out in a row so they're all on-screen.
  const perType = {};
  for (let i = 0; i < MATERIALS.length; i++) {
    const type = MATERIALS[i];
    const offset = (i - (MATERIALS.length - 1) / 2) * dials.spacingMetres;
    const pos = C.Cartesian3.fromDegrees(
      lon + offset / dials.lonDivisor,
      lat,
      height,
    );
    const mm = C.Transforms.eastNorthUpToFixedFrame(pos);
    let material;
    try {
      material = C.Material.fromType(type);
    } catch (e) {
      perType[type] = `material-construct-failed: ${e}`;
      continue;
    }
    scene.primitives.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: C.BoxGeometry.fromDimensions({
            vertexFormat: C.MaterialAppearance.MaterialSupport.ALL.vertexFormat,
            dimensions: new C.Cartesian3(...dials.boxDimensionsMetres),
          }),
          modelMatrix: mm,
        }),
        appearance: new C.MaterialAppearance({
          material,
          flat: false,
          translucent: false,
        }),
        asynchronous: false,
      }),
    );
  }

  const bs = new C.BoundingSphere(center, dials.boundingSphereRadiusMetres);
  v.camera.viewBoundingSphere(
    bs,
    new C.HeadingPitchRange(
      C.Math.toRadians(dials.view.headingDegrees),
      C.Math.toRadians(dials.view.pitchDegrees),
      bs.radius * dials.view.rangeInRadii,
    ),
  );

  // Bright light in front so every box's clustered path is exercised.
  const camDir = C.Cartesian3.subtract(
    v.camera.positionWC,
    center,
    new C.Cartesian3(),
  );
  C.Cartesian3.normalize(camDir, camDir);
  scene.lights.add(
    new C.PointLight({
      position: C.Cartesian3.add(
        center,
        C.Cartesian3.multiplyByScalar(
          camDir,
          dials.light.lightDistanceMetres,
          new C.Cartesian3(),
        ),
        new C.Cartesian3(),
      ),
      color: C.Color[dials.light.colorName],
      intensity: dials.light.intensity,
      range: dials.light.range,
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
    perType,
  };
}

/**
 * The original's clauses, per run, with its bars: (A) the dispatcher reports
 * at least one active light with clustered lighting on; (B) no uncaptured
 * device error across the sweep. (C), a lost device, is the shared error
 * gate's addition. A material that could not be constructed is recorded in
 * `perType`, as the original printed it; it was never a bar.
 *
 * Pure and exported so `clustered-probe-verdicts.spec.mjs` can put a cell on
 * either side of every bar without a browser.
 *
 * @param {Array<object>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateMatsweep(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    verdicts.push(
      {
        id: `clustered-light-active/${suffix}`,
        claim: `(A) dispatcher.lastActiveLightCount with clustered on = ${cell.lastActive} across ${cell.materials.join(", ")} (>= ${MIN_ACTIVE_LIGHTS})`,
        pass: cell.lastActive >= MIN_ACTIVE_LIGHTS,
        detail: { lastActive: cell.lastActive, perType: cell.perType },
      },
      {
        id: `device-errors/${suffix}`,
        claim: `(B) uncaptured device errors across the material sweep: ${cell.deviceErrors.length}`,
        pass: cell.deviceErrors.length === 0,
        detail: { errors: cell.deviceErrors.slice(0, 15) },
      },
      {
        id: `device-not-lost/${suffix}`,
        claim: `(C) device lost: ${cell.deviceLost ?? "no"}`,
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
  name: "clustered-matsweep",
  title:
    "Clustered lighting across the seven non-textured Mat*Lit shaders — no device error",
  outputSubdirectory: "clustered-matsweep",
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
      const result = await page.evaluate(pageSweep, rig.dials);
      // After the sweep has settled and immediately before the capture: the
      // chrome comes off, or the run refuses rather than bank it as evidence.
      const chrome = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
      if (!Array.isArray(chrome?.leftovers) || chrome.leftovers.length > 0) {
        throw new ProbeRefusal(
          "viewer-chrome-over-canvas",
          "after the widget strip, elements were still stacked over the scene canvas " +
            `before the evidence capture (${chrome?.leftovers?.join(", ") ?? "no strip report"}), so the evidence frame would carry them`,
          { capture: "on", chrome: chrome ?? null },
        );
      }
      // Evidence only: the enabled-path frame, so a byte-identity comparison
      // across two builds has something to read. No bar reads it.
      const frame = await captureElement({
        page,
        selector: SCENE_CANVAS,
        name: `on-run${run}`,
        outputDirectory,
        captures,
      });
      const gate = await collectGateErrors(page);
      return [
        {
          run,
          chrome,
          chromeRemoved: chrome.removed,
          materials: [...rig.dials.materials],
          lastActive: result.lastActive,
          clusteredActive: result.clusteredActive,
          perType: result.perType,
          frameSha256: frame.sha256,
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
    return evaluateMatsweep(cells);
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
