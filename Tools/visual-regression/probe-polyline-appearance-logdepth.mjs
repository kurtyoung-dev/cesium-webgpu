#!/usr/bin/env node
/**
 * Probe: polyline appearance/material LOG-DEPTH correctness vs the globe
 * (C2-13 / 376c, NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU).
 * @purpose Gate: appearance/material polylines write log frag_depth matching the globe so surface polylines rest on it at far cameras (no z-fight)
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * WHAT 376c FIXES: the WebGPU polyline appearance + material pipelines wrote
 * HYPERBOLIC @builtin(frag_depth) while the WebGPU globe writes LOGARITHMIC
 * depth (scene.logarithmicDepthBuffer defaults TRUE). At a far camera the two
 * encodings diverge sharply for the same world point, so a surface-height
 * appearance polyline z-fought / sank into the globe instead of resting on it.
 * 376c adds the csm log-depth recipe to all 6 polyline shaders + a logDepth
 * lane in the 512B camera UB + a LOG_DEPTH pipeline define-flip, so the
 * polyline now writes log depth that matches the globe.
 *
 * VERIFICATION: globe ON (log-depth ON), a surface-height (h=0) CYAN
 * PolylineColorAppearance + a MAGENTA PolylineMaterialAppearance(Glow) draped
 * over the ellipsoid, viewed from a FAR oblique camera. WebGL renders
 * appearance polylines with correct log depth → it is the gold reference. If
 * WebGPU now matches WebGL's colored-pixel count (line rests on the globe, not
 * occluded), the depth encodings align. Also asserts the polyline caches
 * actually built with LOG_DEPTH active.
 *
 * GATE:
 *   - webgl draws the lines (reference)
 *   - webgpu draws the lines, within 15% of webgl (depths aligned)
 *   - both polyline caches report logDepthEnabled === true (define activated)
 *   - no NEW webgpu device errors (the known AtmosphereLUT BGL incompat is filtered)
 *
 * The magenta glow line's band has always been 20 % (0.8-1.2), not the 15 %
 * of the cyan line; the code's bands are kept.
 *
 * The AtmosphereLUT filter is vestigial: the incompat it hides was fixed at
 * Batch 396 (`NEW-WEBGPU-ATMOSPHERE-LUT-BGL-INCOMPAT`), whose packed spec
 * (`QUEUE_2026-06-24_CAMPAIGN3_WEATHER_PACKED.md` P1) also asked for this
 * filter to be dropped and never was. Dropping it would change what the gate
 * admits (it also masks an unrelated "default layout" class), so the harvest
 * keeps it and files the drop as its own row.
 *
 * The globe here still loads its imagery from the network, which puts this
 * probe in `DEFERRED_WORK.md`'s network-globe shape-sweep inventory
 * (`C13-WEATHER-PROBE-FLEET-SHAPE-SWEEP` §5): its counts are not
 * determinism-grade evidence until that triage is done.
 *
 * ON THE SHARED RUNTIME (probe-kit harvest, polyline family, DX-108). The
 * browser, the origin (`--port`, a governed Edge port, never 8080), the
 * served-build preflight, the Edge slot, the lifecycle deadline and the
 * receipt belong to `lib/probe-runtime.mjs`. The scene is the rig
 * `polyline-appearance-logdepth`, built in the page from its data; the cache
 * flags are still read in the page. Each frame is an element capture of the
 * scene canvas through `captureElement`, taken after
 * `lib/strip-viewer-widgets.mjs` has removed the viewer chrome that otherwise
 * sits inside the canvas's rectangle (a run with chrome left over the canvas
 * refuses); the cyan and magenta counts are `maskCount`
 * (`lib/metrics/colour-mask.mjs`) over the decoded PNG with the original
 * classes, where the original read the live canvas through `drawImage` inside
 * the page. Console errors are collected with
 * `Tools/lib/attach-page-diagnostics.mjs`, in arrival order, as before.
 *
 * Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
 *        node Tools/visual-regression/probe-polyline-appearance-logdepth.mjs
 * Out:   Tools/visual-regression/output/polyline-appearance-logdepth/
 */
import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";
import { decodePng } from "../lib/png-decode.mjs";
import { channelThresholds, maskCount } from "./lib/metrics/colour-mask.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import rig from "./rigs/polyline-appearance-logdepth.mjs";

/** The scene this probe builds. */
export const RIG = rig;

/** The console noise the probe has always filtered (vestigial; see the header). */
export const ATMO_LUT_RE =
  /AtmosphereLUT|default layout|atmosphereLUT|SkyAtmosphere LUT/;

/** The appearance line's colour class: `b > 180 && g > 180 && r < 90`. */
export const CYAN = channelThresholds({ bAbove: 180, gAbove: 180, rBelow: 90 });

/** The glow line's colour class: `r > 150 && b > 150 && g < 110`. */
export const MAGENTA = channelThresholds({
  rAbove: 150,
  bAbove: 150,
  gBelow: 110,
});

/** The canvas the scene draws into; the CesiumViewer page has exactly one. */
const SCENE_CANVAS = ".cesium-widget canvas";

/**
 * A bound on one backend's work, from the probe's own step timeouts: page load
 * (90 s), the wait for `window.viewer` (90 s), the settle loop (at most half a
 * second per settle frame) and the capture (30 s). Not a measurement — a
 * ceiling past which the lifecycle stops the run (the original had no watchdog
 * at all).
 */
const BACKEND_BUDGET_MS = 90_000 + 90_000 + rig.readiness.frames * 500 + 30_000;

/**
 * Builds the rig's scene in the page and renders its settle frames, then reads
 * the scene's and the two caches' log-depth flags. `page.evaluate` ships this
 * function's SOURCE, so everything it reads arrives in `scene`; the pixels are
 * read in Node from the capture.
 *
 * @param {object} page Playwright page.
 * @returns {Promise<object>} Page-side facts.
 */
async function buildScene(page) {
  return page.evaluate(
    async (scene) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer,
        s = v.scene;
      // Globe ON — this is the whole point (its log depth is what the polyline
      // must match). Kill sky/atmosphere noise so colored-pixel counting is clean.
      s.globe.show = scene.globe.show;
      for (const name of scene.hide) {
        if (s[name]) s[name].show = false;
      }
      s.globe.showGroundAtmosphere = scene.globe.showGroundAtmosphere;
      s.backgroundColor = C.Color.BLACK;
      s.globe.baseColor = C.Color.fromBytes(...scene.globe.baseColorBytes); // dark grey globe

      const logDepthOn = s.logarithmicDepthBuffer;

      // Surface-height (h=0) lines draped on the ellipsoid — the depth-mismatch
      // sharp case. A long path so it spans a wide depth range under the oblique
      // far camera.
      const line = scene.colorLine;
      const colorPrim = s.primitives.add(
        new C.Primitive({
          geometryInstances: new C.GeometryInstance({
            geometry: new C.PolylineGeometry({
              positions: C.Cartesian3.fromDegreesArrayHeights(
                line.positionsDegreesHeights,
              ),
              width: line.width,
              arcType: C.ArcType[line.arcType],
              vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: C.ColorGeometryInstanceAttribute.fromColor(
                new C.Color(...line.color),
              ),
            },
          }),
          appearance: new C.PolylineColorAppearance({ translucent: false }),
          asynchronous: false,
        }),
      );

      const glow = scene.glowLine;
      const glowPrim = s.primitives.add(
        new C.Primitive({
          geometryInstances: new C.GeometryInstance({
            geometry: new C.PolylineGeometry({
              positions: C.Cartesian3.fromDegreesArrayHeights(
                glow.positionsDegreesHeights,
              ),
              width: glow.width,
              arcType: C.ArcType[glow.arcType],
              vertexFormat: C.PolylineMaterialAppearance.VERTEX_FORMAT,
            }),
          }),
          appearance: new C.PolylineMaterialAppearance({
            material: C.Material.fromType("PolylineGlow", {
              color: new C.Color(...glow.material.color), // magenta
              glowPower: glow.material.glowPower,
              taperPower: glow.material.taperPower,
            }),
            translucent: false,
          }),
          asynchronous: false,
        }),
      );

      // FAR oblique camera framing the line centroid — log depth's precision
      // regime (6000km range) while guaranteeing the front-facing surface lines
      // are on screen. lookAt the centroid so we can't miss the geometry.
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

      for (let i = 0; i < scene.frames; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      return {
        renderer: s.context?.rendererType,
        logDepthOn,
        colorReady: colorPrim.ready,
        glowReady: glowPrim.ready,
        // Did the caches build with LOG_DEPTH active?
        colorLogDepth: colorPrim._webgpuPolylineCache?.logDepthEnabled ?? null,
        glowLogDepth: glowPrim._webgpuPolylineMatCache?.logDepthEnabled ?? null,
      };
    },
    { ...rig.dials, frames: rig.readiness.frames },
  );
}

/**
 * One backend: a fresh browser context, the scene built and settled, the
 * viewer chrome removed, one element capture scored in Node.
 *
 * @param {object} options Inputs.
 * @returns {Promise<{render: object, newErrs: string[]}>} The original's shape.
 */
async function captureRenderer({
  browser,
  origin,
  renderer,
  run,
  outputDirectory,
  captures,
}) {
  const context = await browser.newContext({ viewport: { ...rig.viewport } });
  try {
    const page = await context.newPage();
    const diagnostics = attachPageDiagnostics(page, {
      filter: (record) =>
        record.type === "error" || record.type === "pageerror",
    });
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
        `${rig.id}/${renderer}: elements still overlap the scene canvas after the widget strip (${strip.leftovers.join(", ")}), so an element capture would score them`,
        { rig: rig.id, renderer, ...strip },
      );
    }

    const facts = await buildScene(page);
    const shot = await captureElement({
      page,
      selector: SCENE_CANVAS,
      name: `polyline-logdepth-${renderer}-run${run}`,
      outputDirectory,
      captures,
    });
    const image = decodePng(shot.buffer);
    const render = {
      ...facts,
      cyan: maskCount(image, CYAN),
      magenta: maskCount(image, MAGENTA),
      width: image.width,
      height: image.height,
    };
    const errs = [...diagnostics.console, ...diagnostics.errors]
      .sort((a, b) => a.seq - b.seq)
      .map((record) =>
        record.type === "pageerror" ? `PAGEERR:${record.text}` : record.text,
      );
    const newErrs = errs.filter((e) => !ATMO_LUT_RE.test(e));
    return { render, out: shot.path, newErrs, widgetsRemoved: strip.removed };
  } finally {
    await context.close();
  }
}

/**
 * The probe's ten checks over one run — pure and exported so
 * `polyline-probe-verdicts.spec.mjs` can drive it.
 *
 * @param {{webgl: {render: object}, webgpu: {render: object, newErrs: string[]}}} run One run's results.
 * @returns {Array<{id: string, claim: string, pass: boolean, detail: object}>} Verdicts.
 */
export function evaluateLogDepth({ webgl: wgl, webgpu: wgpu }) {
  const cyanRatio =
    wgl.render.cyan > 0 ? wgpu.render.cyan / wgl.render.cyan : 0;
  const magRatio =
    wgl.render.magenta > 0 ? wgpu.render.magenta / wgl.render.magenta : 0;
  const counts = {
    webglCyan: wgl.render.cyan,
    webglMagenta: wgl.render.magenta,
    webgpuCyan: wgpu.render.cyan,
    webgpuMagenta: wgpu.render.magenta,
  };
  return [
    {
      id: "webgl-cyan",
      claim: "webgl draws the cyan appearance line (reference)",
      pass: wgl.render.cyan > 200,
      detail: counts,
    },
    {
      id: "webgl-magenta",
      claim: "webgl draws the magenta glow line (reference)",
      pass: wgl.render.magenta > 200,
      detail: counts,
    },
    {
      id: "webgpu-cyan",
      claim:
        "webgpu draws the cyan line over the globe (depth aligned, not occluded)",
      pass: wgpu.render.cyan > 200,
      detail: counts,
    },
    {
      id: "webgpu-magenta",
      claim: "webgpu draws the magenta glow line over the globe",
      pass: wgpu.render.magenta > 200,
      detail: counts,
    },
    {
      id: "cyan-parity",
      claim: `webgpu cyan within 15% of webgl (ratio=${cyanRatio.toFixed(3)})`,
      pass: cyanRatio >= 0.85 && cyanRatio <= 1.15,
      detail: { cyanRatio },
    },
    {
      id: "magenta-parity",
      claim: `webgpu magenta within 20% of webgl (ratio=${magRatio.toFixed(3)})`,
      pass: magRatio >= 0.8 && magRatio <= 1.2,
      detail: { magRatio },
    },
    {
      id: "log-depth-on",
      claim: "scene log-depth is ON (the regime under test)",
      pass: wgpu.render.logDepthOn === true,
      detail: { logDepthOn: wgpu.render.logDepthOn },
    },
    {
      id: "color-cache-log-depth",
      claim: "webgpu color cache built with LOG_DEPTH active",
      pass: wgpu.render.colorLogDepth === true,
      detail: { colorLogDepth: wgpu.render.colorLogDepth },
    },
    {
      id: "glow-cache-log-depth",
      claim: "webgpu glow cache built with LOG_DEPTH active",
      pass: wgpu.render.glowLogDepth === true,
      detail: { glowLogDepth: wgpu.render.glowLogDepth },
    },
    {
      id: "webgpu-no-new-errors",
      claim: "no NEW webgpu device errors (AtmosphereLUT filtered)",
      pass: wgpu.newErrs.length === 0,
      detail: { errors: wgpu.newErrs.slice(0, 4) },
    },
  ];
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "polyline-appearance-logdepth",
  title:
    "C2-13 / 376c — appearance and material polylines rest on the log-depth globe",
  outputSubdirectory: "polyline-appearance-logdepth",
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
        `the log-depth gate reads WebGL as its reference, so both renderers are required (got ${options.renderers.join(",")})`,
        { renderers: options.renderers },
      );
    }
    const shared = { browser, origin, run, outputDirectory, captures };
    const webgl = await captureRenderer({ ...shared, renderer: "webgl" });
    const webgpu = await captureRenderer({ ...shared, renderer: "webgpu" });
    console.log("WEBGL :", JSON.stringify(webgl.render));
    console.log("  PNG:", webgl.out);
    console.log("WEBGPU:", JSON.stringify(webgpu.render));
    console.log("  PNG:", webgpu.out);
    if (webgpu.newErrs.length)
      console.log("  webgpu NEW errs:", webgpu.newErrs.slice(0, 4));
    return [{ run, webgl, webgpu }];
  },
  verdicts(cells) {
    return cells.flatMap((cell) =>
      evaluateLogDepth(cell).map((verdict) => ({
        ...verdict,
        id: `${verdict.id}/run${cell.run}`,
      })),
    );
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
