#!/usr/bin/env node
/**
 * Probe: PolylineColorAppearance + PolylineMaterialAppearance Primitive in
 * 3D / Columbus View / 2D / mid-morph on WebGPU vs WebGL (C2-12 / 376b).
 * @purpose Gate: polyline appearance primitives render in 3D/Columbus/2D/mid-morph on WebGPU via projected-2D plumbing + csm_computePolylinePosition
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * The WebGPU polyline appearance VS was 3D-only — it read position3DHigh/Low and
 * fed them through the (2D/CV) modelView, so in 2D/CV mode it transformed 3D ECEF
 * through the 2D camera → 0px. 376b plumbs the projected 2D positions (loc8-13)
 * + morphTime (camera UB) into all 6 polyline shaders and blends 3D↔2D via
 * csm_computePolylinePosition (the WGSL port of czm_computePosition, with the
 * .zxy swizzle), so the line renders correctly in every scene mode.
 *
 * GATE:
 *   - 3D: webgpu cyan within 5% of webgl (no regression)
 *   - CV + 2D: webgpu cyan within 5% of webgl (was 0px → fixed)
 *   - MORPH (intermediate morphTime): webgpu renders (cyan > 0) within 15% of webgl
 *   - MATERIAL (PolylineGlow) in 2D: webgpu renders within 10% of webgl
 *   - PNGs saved for visual read
 *
 * WHAT THE PROBE HAS ALWAYS MEASURED. Four cells — 3D, CV, 2D and GLOW2D —
 * in that order, in ONE page per backend. The MORPH clause above has never
 * been a measured cell: the original's cell list never included it, so no run
 * of this probe has ever scored an intermediate morph. The migration keeps
 * the four cells it measured, keeps the page's MORPH branch as the scaffolding
 * it was, and does not invent the fifth cell (a MORPH cell needs the probe to
 * own the render loop, since the capture now follows the page call). Every
 * cell's gate also requires the backend's cyan count to exceed 200 on both
 * sides.
 *
 * The 2D wrap paths duplicate segment logic, which is why the G7 cluster of
 * `CAMPAIGN11_EXECUTION_GUIDE` names this probe for the entity-scale rows'
 * polyline verification.
 *
 * ON THE SHARED RUNTIME (probe-kit harvest, polyline family, DX-108). The
 * browser, the origin (`--port`, a governed Edge port, never 8080), the
 * served-build preflight, the Edge slot, the lifecycle deadline and the
 * receipt belong to `lib/probe-runtime.mjs`. The four cells are the rigs
 * `polyline-appearance-modes-{3d,columbus,2d,glow-2d}`, built in the page from
 * their data, still in that order in one page per backend. Every cell is now
 * an element capture of the scene canvas through `captureElement` (the
 * original banked page screenshots of 2D and GLOW2D only), taken after
 * `lib/strip-viewer-widgets.mjs` has removed the viewer chrome that otherwise
 * sits inside the canvas's rectangle (a run with chrome left over the canvas
 * refuses). The cyan count and centroid are `maskCentroid`
 * (`lib/metrics/colour-mask.mjs`) over the decoded PNG with the original
 * `b > 150 && g > 150 && r < 110` class, where the original read the live
 * canvas through `drawImage` inside the page.
 *
 * Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
 *        node Tools/visual-regression/probe-polyline-appearance-2d.mjs
 * Out:   Tools/visual-regression/output/polyline-appearance-2d/
 */
import { decodePng } from "../lib/png-decode.mjs";
import { channelThresholds, maskCentroid } from "./lib/metrics/colour-mask.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import scene2dRig from "./rigs/polyline-appearance-modes-2d.mjs";
import scene3dRig from "./rigs/polyline-appearance-modes-3d.mjs";
import columbusRig from "./rigs/polyline-appearance-modes-columbus.mjs";
import glow2dRig from "./rigs/polyline-appearance-modes-glow-2d.mjs";

/** The four cells, in the order one page measures them. */
export const RIGS = Object.freeze(
  [scene3dRig, columbusRig, scene2dRig, glow2dRig].sort(
    (a, b) => a.dials.cellOrder - b.dials.cellOrder,
  ),
);

/** The per-cell parity band, keyed by cell. */
export const TOLERANCE = Object.freeze({
  "3D": 0.05,
  CV: 0.05,
  "2D": 0.05,
  GLOW2D: 0.1,
});

/** The line's colour class: `b > 150 && g > 150 && r < 110`. */
export const CYAN = channelThresholds({
  bAbove: 150,
  gAbove: 150,
  rBelow: 110,
});

/** The canvas the scene draws into; the CesiumViewer page has exactly one. */
const SCENE_CANVAS = ".cesium-widget canvas";

/**
 * A bound on one backend's work, from the probe's own step timeouts: page load
 * (90 s), the wait for `window.viewer` (90 s), and per cell its settle and
 * render loops (at most half a second a frame) plus a capture (30 s). Not a
 * measurement — a ceiling past which the lifecycle stops the run (the original
 * had no watchdog at all).
 */
const BACKEND_BUDGET_MS = RIGS.reduce(
  (sum, rig) => sum + rig.readiness.frames * 500 + 30_000,
  90_000 + 90_000,
);

/**
 * Builds one cell's scene in the page (after removing the previous cell's
 * primitive), morphs to the cell's mode with no animation, settles, frames the
 * line and renders. `page.evaluate` ships this function's SOURCE, so everything
 * it reads arrives in `scene`; it measures nothing — the pixels are read in
 * Node from the capture.
 *
 * @param {object} page Playwright page.
 * @param {object} rig The cell's rig.
 * @returns {Promise<object>} Page-side facts.
 */
async function buildCell(page, rig) {
  return page.evaluate(async (scene) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      s = v.scene;
    for (const name of scene.hide) {
      if (s[name]) s[name].show = false;
    }
    s.backgroundColor = C.Color.BLACK;

    const prims = s.primitives;
    for (let i = prims.length - 1; i >= 0; i--) {
      const p = prims.get(i);
      if (p && p.constructor && p.constructor.name === "Primitive")
        prims.remove(p);
    }

    const positions = C.Cartesian3.fromDegreesArray(scene.positionsDegrees);

    const glow = scene.appearance === "PolylineMaterialAppearance";
    let primitive;
    if (glow) {
      primitive = prims.add(
        new C.Primitive({
          geometryInstances: new C.GeometryInstance({
            geometry: new C.PolylineGeometry({
              positions,
              width: scene.width,
              arcType: C.ArcType[scene.arcType],
              vertexFormat: C.PolylineMaterialAppearance.VERTEX_FORMAT,
            }),
          }),
          appearance: new C.PolylineMaterialAppearance({
            material: C.Material.fromType("PolylineGlow", {
              color: new C.Color(...scene.material.color),
              glowPower: scene.material.glowPower,
              taperPower: scene.material.taperPower,
            }),
            translucent: false,
          }),
          asynchronous: false,
        }),
      );
    } else {
      primitive = prims.add(
        new C.Primitive({
          geometryInstances: new C.GeometryInstance({
            geometry: new C.PolylineGeometry({
              positions,
              width: scene.width,
              arcType: C.ArcType[scene.arcType],
              vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: C.ColorGeometryInstanceAttribute.fromColor(
                new C.Color(...scene.color),
              ),
            },
          }),
          appearance: new C.PolylineColorAppearance({ translucent: false }),
          asynchronous: false,
        }),
      );
    }

    if (scene.sceneMode === "SCENE2D") s.morphTo2D(0.0);
    else if (scene.sceneMode === "COLUMBUS_VIEW") s.morphToColumbusView(0.0);
    else if (scene.sceneMode === "MORPH")
      // Scaffolding kept from the original for the MORPH clause no cell has
      // ever declared (see the header): animate, and let the rig's short
      // settle/render counts catch an intermediate morphTime.
      s.morphToColumbusView(2.0);
    else s.morphTo3D(0.0);

    for (let i = 0; i < scene.settleFrames; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
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
    for (let i = 0; i < scene.renderFrames; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return {
      mode: scene.cell,
      material: glow,
      sceneMode: s.mode,
      morphTime: s.morphTime,
      renderer: s.context?.rendererType,
      ready: primitive.ready,
    };
  }, rig.dials);
}

/**
 * One backend: one page, the viewer chrome removed once, then the four cells
 * in order, each element-captured and scored in Node.
 *
 * @param {object} options Inputs.
 * @returns {Promise<Record<string, object>>} Per cell, the original's fields.
 */
async function runBackend({
  browser,
  origin,
  renderer,
  run,
  outputDirectory,
  captures,
}) {
  const context = await browser.newContext({
    viewport: { ...RIGS[0].viewport },
  });
  try {
    const page = await context.newPage();
    await page.goto(
      `${origin}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      { waitUntil: "networkidle", timeout: 90_000 },
    );
    await page.waitForFunction(() => !!window.viewer, null, {
      timeout: 90_000,
    });
    const strip = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
    if (strip.leftovers.length > 0) {
      throw new ProbeRefusal(
        "viewer-chrome-over-canvas",
        `polyline-appearance-2d/${renderer}: elements still overlap the scene canvas after the widget strip (${strip.leftovers.join(", ")}), so an element capture would score them`,
        { renderer, ...strip },
      );
    }
    const out = {};
    for (const rig of RIGS) {
      const key = rig.dials.cell;
      const facts = await buildCell(page, rig);
      const shot = await captureElement({
        page,
        selector: SCENE_CANVAS,
        name: `polyline-2d-${key}-${renderer}-run${run}`,
        outputDirectory,
        captures,
      });
      const image = decodePng(shot.buffer);
      const centroid = maskCentroid(image, CYAN);
      out[key] = {
        ...facts,
        cyan: centroid.count,
        cx: centroid.count ? Math.round(centroid.meanX) : -1,
        cy: centroid.count ? Math.round(centroid.meanY) : -1,
        width: image.width,
        height: image.height,
      };
    }
    return out;
  } finally {
    await context.close();
  }
}

/**
 * The probe's two checks per cell over one run — pure and exported so
 * `polyline-probe-verdicts.spec.mjs` can drive it.
 *
 * @param {{webgl: Record<string, {cyan: number}>, webgpu: Record<string, {cyan: number}>}} run One run's results.
 * @returns {Array<{id: string, claim: string, pass: boolean, detail: object}>} Verdicts.
 */
export function evaluateAppearanceModes({ webgl: wgl, webgpu: wgpu }) {
  const verdicts = [];
  for (const rig of RIGS) {
    const k = rig.dials.cell;
    const tol = TOLERANCE[k];
    const a = wgl[k].cyan,
      b = wgpu[k].cyan;
    const ratio = a > 0 ? b / a : 0;
    verdicts.push(
      {
        id: `${k}/webgl-renders`,
        claim: `[${k}] webgl renders (ref, cyan=${a})`,
        pass: a > 200,
        detail: { webglCyan: a },
      },
      {
        id: `${k}/webgpu-parity`,
        claim: `[${k}] webgpu renders + within ${(tol * 100).toFixed(0)}% (cyan=${b}, ratio=${ratio.toFixed(3)})`,
        pass: b > 200 && ratio >= 1 - tol && ratio <= 1 + tol,
        detail: { webgpuCyan: b, ratio, tolerance: tol },
      },
    );
  }
  return verdicts;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "polyline-appearance-2d",
  title:
    "C2-12 / 376b — polyline appearance primitives in 3D, Columbus View and 2D",
  outputSubdirectory: "polyline-appearance-2d",
  // No JSON receipt was banked before the migration.
  receiptEnvelope: "runtime",
  // The CesiumViewer page and the in-page import both read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  workBudgetMs: () => 2 * BACKEND_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (
      !options.renderers.includes("webgl") ||
      !options.renderers.includes("webgpu")
    ) {
      throw new ProbeRefusal(
        "renderer-pair-required",
        `every cell is a WebGPU/WebGL cyan ratio, so both renderers are required (got ${options.renderers.join(",")})`,
        { renderers: options.renderers },
      );
    }
    const shared = { browser, origin, run, outputDirectory, captures };
    const webgl = await runBackend({ ...shared, renderer: "webgl" });
    const webgpu = await runBackend({ ...shared, renderer: "webgpu" });
    console.log("=== RAW ===");
    for (const rig of RIGS) {
      const k = rig.dials.cell;
      console.log(`[${k}] WEBGL :`, JSON.stringify(webgl[k]));
      console.log(`[${k}] WEBGPU:`, JSON.stringify(webgpu[k]));
    }
    return [{ run, webgl, webgpu }];
  },
  verdicts(cells) {
    return cells.flatMap((cell) =>
      evaluateAppearanceModes(cell).map((verdict) => ({
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
