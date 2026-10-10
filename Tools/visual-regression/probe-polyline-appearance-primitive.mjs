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
 * STAGE SCENES (`--rigs`). A run with `--rigs id,...` captures the named
 * entries of `STAGE_SCENES` INSTEAD of the two passes, through the same pass
 * (fresh context, error gate, widget strip, element capture). Their polylines
 * are built from the rig's dials by `lib/polyline-rig-scene.mjs`, the rig's
 * camera is applied here, and each entry scores its own colour masks: a mask
 * marked `verdicted` must draw on both renderers with the WebGPU count
 * within the same 15 % band as the passes and its centroid within
 * `CENTROID_TOLERANCE_PX`; any other mask is reported, never verdicted. A
 * run without `--rigs` is the two passes exactly as before.
 *
 * Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
 *        node Tools/visual-regression/probe-polyline-appearance-primitive.mjs [--rigs polyline-nearclip]
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
  maskCentroid,
  maskCount,
} from "./lib/metrics/colour-mask.mjs";
import { POLYLINE_RIG_SCENE_SOURCE } from "./lib/polyline-rig-scene.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import geodesicRig from "./rigs/polyline-appearance-color-geodesic.mjs";
import noneRig from "./rigs/polyline-appearance-color-none.mjs";
import nearclipRig from "./rigs/polyline-nearclip.mjs";

/** The two passes, in the order the probe has always measured them. */
export const RIGS = Object.freeze([geodesicRig, noneRig]);

/** How far a verdicted mask's WebGPU centroid may sit from WebGL's, in pixels. */
export const CENTROID_TOLERANCE_PX = 4;

/**
 * The scenes `--rigs` can name, keyed by rig id: each is built from its rig's
 * dials by `lib/polyline-rig-scene.mjs` and scored by the masks it lists.
 * `polyline-nearclip`: every mask is verdicted: the green ribbon that turns
 * back on itself, the red (PolylineCollection) and blue
 * (BufferPolylineCollection) ribbons through the near plane, and the yellow
 * (three points) and magenta (five points) straight BufferPolylines.
 */
export const STAGE_SCENES = Object.freeze({
  [nearclipRig.id]: Object.freeze({
    rig: nearclipRig,
    masks: Object.freeze([
      Object.freeze({
        name: "hairpin",
        predicate: channelThresholds({ gAbove: 150, rBelow: 90, bBelow: 90 }),
        verdicted: true,
      }),
      Object.freeze({
        name: "near-plane",
        predicate: channelThresholds({ rAbove: 150, gBelow: 90, bBelow: 90 }),
        verdicted: true,
      }),
      Object.freeze({
        name: "near-plane-buffer",
        predicate: channelThresholds({ bAbove: 150, rBelow: 90, gBelow: 90 }),
        verdicted: true,
      }),
      Object.freeze({
        name: "straight-3",
        predicate: channelThresholds({ rAbove: 150, gAbove: 150, bBelow: 90 }),
        verdicted: true,
      }),
      Object.freeze({
        name: "straight-5",
        predicate: channelThresholds({ rAbove: 150, bAbove: 150, gBelow: 90 }),
        verdicted: true,
      }),
    ]),
  }),
});

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
 * The page half of a stage scene: hides what the rig hides, builds the rig's
 * polylines through the stage it is handed, applies the rig's camera and
 * renders the settle frames. Shipped as source, with the stage, by
 * {@link buildStageScene}; everything it reads arrives in its arguments.
 *
 * @param {Function} buildPolylineRigScene `lib/polyline-rig-scene.mjs`'s stage.
 * @param {{dials: object, camera: object, frames: number}} input The rig's numbers.
 * @returns {Promise<{renderer: string, collections: Array<{kind: string, names: string[]}>}>} Page-side facts.
 */
async function stageScenePage(buildPolylineRigScene, input) {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  for (const name of input.dials.hide) {
    v.scene[name].show = false;
  }
  v.scene.backgroundColor = C.Color.BLACK;
  const stage = buildPolylineRigScene(C, v, input.dials);
  const cam = input.camera;
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.height),
    orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll },
  });
  for (let i = 0; i < input.frames; i++) {
    v.scene.render();
    await new Promise((res) => requestAnimationFrame(res));
  }
  return {
    renderer: v.scene.context?.rendererType,
    collections: stage.collections.map(({ kind, names }) => ({ kind, names })),
  };
}

/**
 * Builds a stage scene's rig in the page: {@link stageScenePage} called with
 * the stage's source and the rig's dials, camera and settle frames.
 *
 * @param {object} page Playwright page.
 * @param {object} rig The stage scene's rig.
 * @returns {Promise<object>} Page-side facts.
 */
async function buildStageScene(page, rig) {
  const input = {
    dials: rig.dials,
    camera: rig.camera,
    frames: rig.readiness.frames,
  };
  return page.evaluate(
    `(${stageScenePage})(${POLYLINE_RIG_SCENE_SOURCE}, ${JSON.stringify(input)})`,
  );
}

/**
 * A stage scene's masks over one capture: per mask, its count and centroid.
 *
 * @param {object} image Decoded frame.
 * @param {object} scene The `STAGE_SCENES` entry.
 * @returns {Record<string, {count: number, meanX: number|null, meanY: number|null}>} By mask name.
 */
function measureStageMasks(image, scene) {
  const out = {};
  for (const mask of scene.masks) {
    const { count, meanX, meanY } = maskCentroid(image, mask.predicate);
    out[mask.name] = { count, meanX, meanY };
  }
  return out;
}

/**
 * One pass on one backend: a fresh browser context, the scene built and
 * settled, the viewer chrome removed, one element capture of the scene canvas,
 * and the gate read before the context closes. With `scene` (a
 * `STAGE_SCENES` entry) the scene is the stage's and the frame is scored by
 * the entry's masks; without it, by the cyan and non-black classes.
 *
 * @param {object} options Inputs.
 * @returns {Promise<{render: object, gate: object, consoleErrors: string[]}>} The capture.
 */
async function capturePass({
  browser,
  origin,
  rig,
  scene,
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

    const label = scene ? rig.id : rig.dials.arcType;
    const facts = scene
      ? await buildStageScene(page, rig)
      : await buildScene(page, rig);
    const shot = await captureElement({
      page,
      selector: SCENE_CANVAS,
      name: `polyline-appearance-${renderer}-${label}-run${run}`,
      outputDirectory,
      captures,
    });
    const image = decodePng(shot.buffer);
    const scores = scene
      ? { masks: measureStageMasks(image, scene) }
      : {
          cyan: maskCount(image, CYAN),
          nonBlack: maskCount(image, NON_BLACK),
        };
    const render = {
      ...facts,
      width: image.width,
      height: image.height,
      ...scores,
    };
    const gate = await collectGateErrors(page);
    console.log(
      `  [${renderer}/${label}] ${JSON.stringify(render)} gate: armed=${gate.armedDevices} uncaptured=${gate.errors.length} deviceLost=${gate.deviceLost || "no"}`,
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

/**
 * The stage scenes a run captures: the `STAGE_SCENES` ids `--rigs` names
 * (comma-separated), in the order named, or `null` when `--rigs` is absent
 * and the run is the two passes.
 *
 * @param {string|undefined} rigsOption The `--rigs` value, if any.
 * @returns {object[]|null} The selected entries.
 * @throws {TypeError} An empty list or an id with no entry — a caller error.
 */
export function selectStageScenes(rigsOption) {
  if (rigsOption === undefined || rigsOption === null) {
    return null;
  }
  const ids = String(rigsOption)
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) {
    throw new TypeError("--rigs named no rig");
  }
  return ids.map((id) => {
    if (!Object.hasOwn(STAGE_SCENES, id)) {
      throw new TypeError(
        `--rigs: no stage scene "${id}" (this probe has: ${Object.keys(STAGE_SCENES).join(", ")})`,
      );
    }
    return STAGE_SCENES[id];
  });
}

/**
 * One mask of one stage scene, WebGPU against WebGL: both counts, the count
 * ratio and the centroid distance (`null` when either side drew nothing).
 *
 * @param {string} name The mask's name.
 * @param {{webgl: {render: object}, webgpu: {render: object}}} legs The scene's two captures.
 * @returns {{webglCount: number, webgpuCount: number, ratio: number, centroidDistancePx: number|null}} The comparison.
 */
export function compareStageMask(name, legs) {
  const wgl = legs.webgl.render.masks[name];
  const wgpu = legs.webgpu.render.masks[name];
  const ratio = wgl.count > 0 ? wgpu.count / wgl.count : 0;
  const centroidDistancePx =
    wgl.meanX === null || wgpu.meanX === null
      ? null
      : Math.hypot(wgpu.meanX - wgl.meanX, wgpu.meanY - wgl.meanY);
  return {
    webglCount: wgl.count,
    webgpuCount: wgpu.count,
    ratio,
    centroidDistancePx,
  };
}

/**
 * The checks over the stage scenes of one run — pure and exported so a spec
 * can drive it. Per scene, the WebGPU error gate; per verdicted mask, that
 * both renderers draw it, that the WebGPU count is within 15 % of WebGL's and
 * that its centroid is within `CENTROID_TOLERANCE_PX`. Masks not marked
 * `verdicted` add no verdict.
 *
 * @param {Record<string, {webgl: {render: object}, webgpu: {render: object, gate: object}}>} stages By rig id.
 * @returns {Array<{id: string, claim: string, pass: boolean, detail: object}>} Verdicts.
 */
export function evaluateStageScenes(stages) {
  const verdicts = [];
  for (const [id, legs] of Object.entries(stages)) {
    const scene = STAGE_SCENES[id];
    const gate = legs.webgpu.gate;
    verdicts.push({
      id: `${id}/webgpu-error-free`,
      claim: `[${id}] no uncaptured WebGPU errors`,
      pass: (gate.errorCount ?? 0) === 0 && !gate.deviceLost,
      detail: { errorCount: gate.errorCount, deviceLost: gate.deviceLost },
    });
    for (const mask of scene.masks) {
      if (!mask.verdicted) {
        continue;
      }
      const c = compareStageMask(mask.name, legs);
      const distance =
        c.centroidDistancePx === null
          ? "no centroid"
          : `${c.centroidDistancePx.toFixed(2)} px`;
      verdicts.push(
        {
          id: `${id}/${mask.name}/webgl-draws`,
          claim: `[${id}] webgl draws the ${mask.name} mask (reference, ${c.webglCount} px > 200)`,
          pass: c.webglCount > 200,
          detail: { webglCount: c.webglCount },
        },
        {
          id: `${id}/${mask.name}/webgpu-draws`,
          claim: `[${id}] webgpu draws the ${mask.name} mask (${c.webgpuCount} px > 200)`,
          pass: c.webgpuCount > 200,
          detail: { webgpuCount: c.webgpuCount },
        },
        {
          id: `${id}/${mask.name}/parity`,
          claim: `[${id}] webgpu ${mask.name} count within 15% of webgl (ratio=${c.ratio.toFixed(3)})`,
          pass: c.ratio >= 0.85 && c.ratio <= 1.15,
          detail: c,
        },
        {
          id: `${id}/${mask.name}/centroid`,
          claim: `[${id}] webgpu ${mask.name} centroid within ${CENTROID_TOLERANCE_PX} px of webgl (${distance})`,
          pass:
            c.centroidDistancePx !== null &&
            c.centroidDistancePx <= CENTROID_TOLERANCE_PX,
          detail: c,
        },
      );
    }
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
  args: {
    extraOptions: [{ flag: "--rigs", key: "rigs", kind: "string" }],
  },
  workBudgetMs: (options) => {
    let rigs = RIGS;
    try {
      rigs =
        selectStageScenes(options?.rigs)?.map((scene) => scene.rig) ?? RIGS;
    } catch {
      // An unusable --rigs is reported by cells(); budget the two passes.
    }
    return rigs.reduce((sum, rig) => sum + 2 * captureBudgetMs(rig), 0);
  },
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
    const stageScenes = selectStageScenes(options.rigs);
    if (stageScenes !== null) {
      const stages = {};
      for (const scene of stageScenes) {
        stages[scene.rig.id] = {};
        for (const renderer of ["webgl", "webgpu"]) {
          stages[scene.rig.id][renderer] = await capturePass({
            browser,
            origin,
            rig: scene.rig,
            scene,
            renderer,
            run,
            outputDirectory,
            captures,
          });
        }
      }
      return [{ run, stages }];
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
      (cell.stages
        ? evaluateStageScenes(cell.stages)
        : evaluateAppearancePrimitive(cell.results)
      ).map((verdict) => ({
        ...verdict,
        id: `${verdict.id}/run${cell.run}`,
      })),
    );
  },
  receipt(cells, context) {
    for (const verdict of context.verdicts) {
      console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
    }
    // The masks a stage scene reports without a verdict, WebGPU against WebGL.
    const reported = [];
    for (const cell of cells) {
      for (const [id, legs] of Object.entries(cell.stages ?? {})) {
        for (const mask of STAGE_SCENES[id].masks) {
          if (mask.verdicted) {
            continue;
          }
          const comparison = compareStageMask(mask.name, legs);
          console.log(
            `  [REPORTED] [${id}] ${mask.name}: ${JSON.stringify(comparison)}`,
          );
          reported.push({
            run: cell.run,
            rig: id,
            mask: mask.name,
            comparison,
          });
        }
      }
    }
    const stageRun = cells.some((cell) => cell.stages);
    return {
      rigs: stageRun
        ? [...new Set(cells.flatMap((cell) => Object.keys(cell.stages ?? {})))]
        : RIGS.map((rig) => rig.id),
      cells,
      ...(stageRun ? { reported } : {}),
      verdicts: context.verdicts,
    };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
