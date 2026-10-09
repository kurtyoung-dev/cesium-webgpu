#!/usr/bin/env node
/**
 * Probe: polyline `Primitive` + `PolylineColorAppearance` parity on WebGPU vs
 * WebGL (NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU, COLOR slice).
 * @purpose Gate: Primitive+PolylineColorAppearance renders a screen-space ribbon on WebGPU (dedicated packer/shader; was 0px from collapsed quads)
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * ROOT CAUSE this verifies: WebGPUPrimitiveShaders.selectWebGPUShader only
 * inspected normal/st -> picked the "basic" shader; the basic vertex packer
 * dropped the polyline attributes (prev/next position + expandAndWidth), so
 * the 4 coincident quad vertices collapsed to one clip point -> degenerate
 * triangles -> 0px. The fix routes PolylineGeometry+PolylineColorAppearance
 * through a dedicated packer + polyline appearance shader that expands the
 * quads into a screen-space ribbon.
 *
 * The probe adds a high-contrast CYAN polyline (width 8) over a
 * PolylineGeometry with PolylineColorAppearance, on the WebGPU viewer
 * (renderer=webgpu) AND the WebGL viewer (renderer=webgl), at a fixed
 * camera/clock that frames the line. Two passes: arcType GEODESIC then NONE.
 * Counts cyan pixels (b>200 && g>200 && r<80) on each.
 *
 * GATE:
 *   - BEFORE fix:  webgpu cyan ~= 0   (reproduces the 0px symptom)
 *                  webgl  cyan  > N   (reference)
 *   - AFTER fix:   webgpuCyan / webglCyan within ~15%
 *
 * C11-09 (`CAMPAIGN11_EXECUTION_GUIDE` cluster G1, A10) names this probe as
 * one of the two colour/material baselines the polyline appearance pick fix
 * must leave unchanged.
 *
 * ON THE SHARED RUNTIME (probe-kit harvest, polyline family, DX-108). The
 * browser, the origin (`--port`, a governed Edge port, never 8080), the
 * served-build preflight, the Edge slot, the lifecycle deadline and the
 * receipt belong to `lib/probe-runtime.mjs`. The two passes are the rigs
 * `polyline-appearance-color-geodesic` and `polyline-appearance-color-none`,
 * and the page builds each scene from its rig. Each capture still gets a fresh
 * browser context (the original launched a fresh browser) and the WebGPU error
 * gate. Each frame is an element capture of the scene canvas through
 * `captureElement`, taken after `lib/strip-viewer-widgets.mjs` has removed the
 * viewer chrome that otherwise sits inside the canvas's rectangle (a run with
 * chrome left over the canvas refuses); the cyan and non-black counts are
 * `maskCount` (`lib/metrics/colour-mask.mjs`) over the decoded PNG with the
 * original thresholds, where the original read the live canvas through
 * `drawImage` inside the page. No clock is pinned, as before: the scene hides
 * every time-dependent body.
 *
 * Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
 *        node Tools/visual-regression/probe-polyline-appearance-primitive.mjs
 * Out:   Tools/visual-regression/output/polyline-appearance-primitive/
 */
import { decodePng } from "../lib/png-decode.mjs";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";
import {
  anyChannelAbove,
  channelThresholds,
  maskCount,
} from "./lib/metrics/colour-mask.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import geodesicRig from "./rigs/polyline-appearance-color-geodesic.mjs";
import noneRig from "./rigs/polyline-appearance-color-none.mjs";

/** The two passes, in the order the probe has always measured them. */
export const RIGS = Object.freeze([geodesicRig, noneRig]);

/** The line's colour class: high-contrast cyan, `b > 200 && g > 200 && r < 80`. */
export const CYAN = channelThresholds({ bAbove: 200, gAbove: 200, rBelow: 80 });

/** Reported, never verdicted: any channel above 10. */
export const NON_BLACK = anyChannelAbove(10);

/** The canvas the scene draws into; the CesiumViewer page has exactly one. */
const SCENE_CANVAS = ".cesium-widget canvas";

/**
 * A bound on one capture's work, from the probe's own step timeouts: page
 * load (90 s), the wait for `window.viewer` (90 s), the settle loop (at most
 * half a second per settle frame) and the capture (30 s). Not a measurement —
 * a ceiling past which the lifecycle stops the run instead of letting a hung
 * device wedge the machine (the original had no watchdog at all).
 *
 * @param {object} rig The capture's rig.
 * @returns {number} Milliseconds.
 */
function captureBudgetMs(rig) {
  return 90_000 + 90_000 + rig.readiness.frames * 500 + 30_000;
}

/**
 * Builds one rig's scene in the page and renders it for the rig's settle
 * frames. `page.evaluate` ships this function's SOURCE, so everything it reads
 * arrives in `scene`; it measures nothing — the pixels are read in Node from
 * the capture.
 *
 * @param {object} page Playwright page.
 * @param {object} rig The pass's rig.
 * @returns {Promise<{renderer: string, primitiveReady: boolean, arcType: string}>} Page-side facts.
 */
async function buildScene(page, rig) {
  return page.evaluate(
    async (scene) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      for (const name of scene.hide) {
        v.scene[name].show = false;
      }
      v.scene.backgroundColor = C.Color.BLACK;

      // Remove any prior primitives (Primitive instances we added).
      const prims = v.scene.primitives;
      for (let i = prims.length - 1; i >= 0; i--) {
        const p = prims.get(i);
        if (p && p.constructor && p.constructor.name === "Primitive") {
          prims.remove(p);
        }
      }

      // A zig-zag line so miters are exercised, in a small lat/lon box.
      const positions = C.Cartesian3.fromDegreesArray(scene.positionsDegrees);
      const primitive = prims.add(
        new C.Primitive({
          geometryInstances: new C.GeometryInstance({
            geometry: new C.PolylineGeometry({
              positions: positions,
              width: scene.width,
              arcType: C.ArcType[scene.arcType],
              vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              // High-contrast CYAN (r=0, g=1, b=1).
              color: C.ColorGeometryInstanceAttribute.fromColor(
                new C.Color(...scene.color),
              ),
            },
          }),
          appearance: new C.PolylineColorAppearance({
            translucent: false,
          }),
          asynchronous: false,
        }),
      );

      // Frame the line from straight above.
      const look = scene.lookAt;
      v.camera.lookAt(
        C.Cartesian3.fromDegrees(look.lon, look.lat, look.height),
        new C.HeadingPitchRange(
          C.Math.toRadians(look.headingDegrees),
          C.Math.toRadians(look.pitchDegrees),
          look.rangeMetres,
        ),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);

      let ready = false;
      for (let i = 0; i < scene.frames; i++) {
        v.scene.render();
        // Primitive.ready flips true after the first few async-off renders.
        if (primitive.ready) ready = true;
        await new Promise((res) => requestAnimationFrame(res));
      }
      return {
        renderer: v.scene.context?.rendererType,
        primitiveReady: ready,
        arcType: scene.arcType,
      };
    },
    { ...rig.dials, frames: rig.readiness.frames },
  );
}

/**
 * One pass on one backend: a fresh browser context, the scene built and
 * settled, the viewer chrome removed, one element capture of the scene canvas,
 * and the gate read before the context closes.
 *
 * @param {object} options Inputs.
 * @returns {Promise<{render: object, gate: object, consoleErrors: string[]}>} The capture.
 */
async function capturePass({
  browser,
  origin,
  rig,
  renderer,
  run,
  outputDirectory,
  captures,
}) {
  const context = await browser.newContext({ viewport: { ...rig.viewport } });
  try {
    const page = await context.newPage();
    const consoleErrors = attachConsoleErrorGate(page);
    await page.addInitScript(errorGateInit);
    await page.goto(
      `${origin}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      { waitUntil: "networkidle", timeout: 90_000 },
    );
    await page.waitForFunction(() => !!window.viewer, null, {
      timeout: 90_000,
    });
    await armWebGPUDevices(page);
    const strip = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
    if (strip.leftovers.length > 0) {
      throw new ProbeRefusal(
        "viewer-chrome-over-canvas",
        `${rig.id}/${renderer}: elements still overlap the scene canvas after the widget strip (${strip.leftovers.join(", ")}), so an element capture would score them`,
        { rig: rig.id, renderer, ...strip },
      );
    }

    const facts = await buildScene(page, rig);
    const shot = await captureElement({
      page,
      selector: SCENE_CANVAS,
      name: `polyline-appearance-${renderer}-${rig.dials.arcType}-run${run}`,
      outputDirectory,
      captures,
    });
    const image = decodePng(shot.buffer);
    const render = {
      ...facts,
      width: image.width,
      height: image.height,
      cyan: maskCount(image, CYAN),
      nonBlack: maskCount(image, NON_BLACK),
    };
    const gate = await collectGateErrors(page);
    console.log(
      `  [${renderer}/${rig.dials.arcType}] ${JSON.stringify(render)} gate: armed=${gate.armedDevices} uncaptured=${gate.errors.length} deviceLost=${gate.deviceLost || "no"}`,
    );
    return {
      render,
      gate: {
        errors: gate.errors.slice(0, 6),
        errorCount: gate.errors.length,
        deviceLost: gate.deviceLost ?? null,
        armedDevices: gate.armedDevices,
      },
      consoleErrors: consoleErrors.slice(0, 6),
      widgetsRemoved: strip.removed,
    };
  } finally {
    await context.close();
  }
}

/**
 * The probe's four checks per pass, over one run's results — pure and
 * exported so `polyline-probe-verdicts.spec.mjs` can drive it.
 *
 * @param {Record<string, {webgl: {render: object}, webgpu: {render: object, gate: object}}>} results By arc type.
 * @returns {Array<{id: string, claim: string, pass: boolean, detail: object}>} Verdicts.
 */
export function evaluateAppearancePrimitive(results) {
  const verdicts = [];
  for (const rig of RIGS) {
    const arcType = rig.dials.arcType;
    const wgl = results[arcType].webgl.render;
    const wgpu = results[arcType].webgpu.render;
    const gate = results[arcType].webgpu.gate;
    const ratio = wgl.cyan > 0 ? wgpu.cyan / wgl.cyan : 0;
    verdicts.push(
      {
        id: `${arcType}/webgl-draws`,
        claim: `[${arcType}] webgl draws the cyan line (reference)`,
        pass: wgl.cyan > 200,
        detail: { webglCyan: wgl.cyan },
      },
      {
        id: `${arcType}/webgpu-draws`,
        claim: `[${arcType}] webgpu draws the cyan line (fix landed, not 0px)`,
        pass: wgpu.cyan > 200,
        detail: { webgpuCyan: wgpu.cyan },
      },
      {
        id: `${arcType}/parity`,
        claim: `[${arcType}] webgpu cyan within 15% of webgl (ratio=${ratio.toFixed(3)})`,
        pass: ratio >= 0.85 && ratio <= 1.15,
        detail: { ratio, webglCyan: wgl.cyan, webgpuCyan: wgpu.cyan },
      },
      {
        id: `${arcType}/webgpu-error-free`,
        claim: `[${arcType}] no uncaptured WebGPU errors`,
        pass: (gate.errorCount ?? 0) === 0 && !gate.deviceLost,
        detail: { errorCount: gate.errorCount, deviceLost: gate.deviceLost },
      },
    );
  }
  return verdicts;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "polyline-appearance-primitive",
  title:
    "NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU colour slice — Primitive + PolylineColorAppearance parity",
  outputSubdirectory: "polyline-appearance-primitive",
  // No JSON receipt was banked before the migration.
  receiptEnvelope: "runtime",
  // The CesiumViewer page and the in-page import both read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  workBudgetMs: () =>
    RIGS.reduce((sum, rig) => sum + 2 * captureBudgetMs(rig), 0),
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (
      !options.renderers.includes("webgl") ||
      !options.renderers.includes("webgpu")
    ) {
      throw new ProbeRefusal(
        "renderer-pair-required",
        `the colour-slice gate is a WebGPU/WebGL cyan ratio, so both renderers are required (got ${options.renderers.join(",")})`,
        { renderers: options.renderers },
      );
    }
    const results = {};
    for (const rig of RIGS) {
      results[rig.dials.arcType] = {};
      for (const renderer of ["webgl", "webgpu"]) {
        results[rig.dials.arcType][renderer] = await capturePass({
          browser,
          origin,
          rig,
          renderer,
          run,
          outputDirectory,
          captures,
        });
      }
    }
    return [{ run, results }];
  },
  verdicts(cells) {
    return cells.flatMap((cell) =>
      evaluateAppearancePrimitive(cell.results).map((verdict) => ({
        ...verdict,
        id: `${verdict.id}/run${cell.run}`,
      })),
    );
  },
  receipt(cells, context) {
    for (const verdict of context.verdicts) {
      console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
    }
    return {
      rigs: RIGS.map((rig) => rig.id),
      cells,
      verdicts: context.verdicts,
    };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
