#!/usr/bin/env node
/**
 * C2-11 / 376a — polyline APPEARANCE PRIMITIVE pick on WebGPU.
 * @purpose Gate: scene.pick over a PolylineColorAppearance Primitive returns the primitive on WebGPU (pick pipeline + per-primitive pick command)
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * Before: createPolylineAppearanceCommands cleared pickCommands → scene.pick over
 * an appearance polyline returned undefined. After: a pick pipeline + per-primitive
 * pick command make it pickable.
 *
 * Builds the same CYAN PolylineColorAppearance Primitive as
 * probe-polyline-appearance-primitive.mjs, finds the on-line window pixel (cyan
 * centroid), warms the pick (WebGPU's first pick can be cold), and asserts
 * scene.pick returns the polyline Primitive. Runs WebGPU (the feature under test)
 * + WebGL (sanity reference).
 *
 * The "on-line window pixel" is not the cyan centroid: the zig-zag's centroid
 * lands in an empty gap between segments, so the probe picks at every 200th
 * cyan pixel and succeeds if ANY of them returns the polyline.
 *
 * C11-09 (`CAMPAIGN11_EXECUTION_GUIDE` cluster G1, A10) is this probe's open
 * row: the polyline appearance pick remainder, attempted and reverted at
 * Batch 380 with its root cause pinned. This is its committed RED gate — it
 * fails on WebGPU by construction until that fix lands.
 *
 * ON THE SHARED RUNTIME (probe-kit harvest, polyline family, DX-108). The
 * browser, the origin (`--port`, a governed Edge port, never 8080), the
 * served-build preflight, the Edge slot, the lifecycle deadline and the
 * receipt belong to `lib/probe-runtime.mjs`. The scene is the rig
 * `polyline-appearance-pick`, built in the page from its data. The on-line
 * pixels are found in Node: an element capture of the scene canvas through
 * `captureElement`, taken after `lib/strip-viewer-widgets.mjs` has removed the
 * viewer chrome that otherwise sits inside the canvas's rectangle (a run with
 * chrome left over the canvas refuses), decoded, and sampled with
 * `maskSamples` (`lib/metrics/colour-mask.mjs`, every 200th pixel of the
 * original `b > 200 && g > 200 && r < 80` class) — where the original read the
 * live canvas through `drawImage` inside the page. The samples are then picked
 * in the page exactly as before (three passes, a render after each pick).
 * Console errors are collected with `Tools/lib/attach-page-diagnostics.mjs`
 * and filtered by the probe's own AtmosphereLUT pattern, as before.
 *
 * Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
 *        node Tools/visual-regression/probe-polyline-appearance-pick.mjs
 * Out:   Tools/visual-regression/output/polyline-appearance-pick/
 */
import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";
import { decodePng } from "../lib/png-decode.mjs";
import { channelThresholds, maskSamples } from "./lib/metrics/colour-mask.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import rig from "./rigs/polyline-appearance-pick.mjs";

/** The scene this probe builds and picks. */
export const RIG = rig;

/** The line's colour class: `b > 200 && g > 200 && r < 80`. */
export const CYAN = channelThresholds({ bAbove: 200, gAbove: 200, rBelow: 80 });

/** The console noise the probe has always filtered (the AtmosphereLUT class). */
export const KNOWN_NOISE = /AtmosphereLUT|default layout|atmosphereLUT/;

/** The canvas the scene draws into; the CesiumViewer page has exactly one. */
const SCENE_CANVAS = ".cesium-widget canvas";

/**
 * A bound on one backend's work, from the probe's own step timeouts: page load
 * (90 s), the wait for `window.viewer` (90 s), the settle loop (at most half a
 * second per settle frame), the capture (30 s) and the pick loop (at most a
 * second per pick, over every pass). Not a measurement — a ceiling past which
 * the lifecycle stops the run (the original had no watchdog at all).
 */
const BACKEND_BUDGET_MS =
  90_000 + 90_000 + rig.readiness.frames * 500 + 30_000 + 120_000;

/**
 * Builds the rig's scene in the page, renders the settle frames, and parks
 * the primitive on `window` for the pick step. Self-contained: `page.evaluate`
 * ships this function's SOURCE, so everything it reads arrives in `scene`.
 *
 * @param {object} page Playwright page.
 * @returns {Promise<{ready: boolean, pickIds: number}>} Page-side facts.
 */
async function buildScene(page) {
  return page.evaluate(
    async (scene) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer,
        s = v.scene;
      for (const name of scene.hide) {
        if (s[name]) s[name].show = false;
      }
      s.backgroundColor = C.Color.BLACK;

      const positions = C.Cartesian3.fromDegreesArray(scene.positionsDegrees);
      const primitive = s.primitives.add(
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
            id: scene.instanceId,
          }),
          appearance: new C.PolylineColorAppearance({ translucent: false }),
          asynchronous: false,
          allowPicking: scene.allowPicking,
        }),
      );
      window.__probePickPrimitive = primitive;

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
        ready: !!primitive.ready,
        pickIds: (primitive._pickIds || []).length,
      };
    },
    { ...rig.dials, frames: rig.readiness.frames },
  );
}

/**
 * Picks at every sampled on-line pixel, `passes` times, rendering after each
 * pick — the original's warm-then-try-each loop, unchanged. The samples are
 * capture pixels; they are scaled to CSS pixels by the canvas's client size
 * over the capture size, as the original scaled device pixels.
 *
 * @param {object} page Playwright page.
 * @param {object} input `{samples, imageWidth, imageHeight}`.
 * @returns {Promise<object>} The pick facts.
 */
async function pickAtSamples(page, { samples, imageWidth, imageHeight }) {
  return page.evaluate(
    async (input) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const s = window.viewer.scene;
      const primitive = window.__probePickPrimitive;
      const canvas = s.canvas;
      const sx2css = canvas.clientWidth / input.imageWidth,
        sy2css = canvas.clientHeight / input.imageHeight;
      const cssSamples = input.samples.map(([dx, dy]) => [
        dx * sx2css,
        dy * sy2css,
      ]);

      // Warm the pick (WebGPU first pick can be cold), then try EACH on-line
      // sample — succeed if ANY returns the polyline.
      let pickedPrimitive = false,
        pickedId = false,
        lastType = "undefined",
        hits = 0;
      for (let pass = 0; pass < input.passes; pass++) {
        for (const [pxc, pyc] of cssSamples) {
          const picked = s.pick(new C.Cartesian2(pxc, pyc));
          if (picked) {
            lastType = typeof picked.primitive;
            if (picked.primitive === primitive) {
              pickedPrimitive = true;
              hits++;
            }
            if (picked.id === input.instanceId) pickedId = true;
          }
          s.render();
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      return {
        ready: !!primitive.ready,
        pickIds: (primitive._pickIds || []).length,
        allowPicking: primitive.allowPicking,
        nSamples: cssSamples.length,
        hits,
        pickCmds: (primitive._pickCommands || []).length,
        hasPickPipeline: !!primitive._webgpuPolylineCache?.pickPipeline,
        pickIdColor: primitive._pickIds?.[0]?.color
          ? [
              primitive._pickIds[0].color.red,
              primitive._pickIds[0].color.green,
              primitive._pickIds[0].color.blue,
            ]
          : null,
        pickedPrimitive,
        pickedId,
        lastType,
      };
    },
    {
      samples,
      imageWidth,
      imageHeight,
      passes: rig.dials.pick.passes,
      instanceId: rig.dials.instanceId,
    },
  );
}

/**
 * One backend: a fresh browser context, the scene built and settled, the
 * viewer chrome removed, one element capture, the on-line pixels sampled in
 * Node, then the picks.
 *
 * @param {object} options Inputs.
 * @returns {Promise<{res: object, errs: string[]}>} The original's shape.
 */
async function runBackend({
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
      { waitUntil: "networkidle", timeout: 90000 },
    );
    await page.waitForFunction(() => !!window.viewer, null, {
      timeout: 90000,
    });
    const strip = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
    if (strip.leftovers.length > 0) {
      throw new ProbeRefusal(
        "viewer-chrome-over-canvas",
        `${rig.id}/${renderer}: elements still overlap the scene canvas after the widget strip (${strip.leftovers.join(", ")}), so an element capture would score them`,
        { rig: rig.id, renderer, ...strip },
      );
    }

    const built = await buildScene(page);
    const shot = await captureElement({
      page,
      selector: SCENE_CANVAS,
      name: `polyline-appearance-pick-${renderer}-run${run}`,
      outputDirectory,
      captures,
    });
    const image = decodePng(shot.buffer);
    // Collect ACTUAL cyan pixel coords (NOT the centroid — the zig-zag's
    // centroid lands in an empty gap between segments).
    const { count, samples } = maskSamples(
      image,
      CYAN,
      rig.dials.pick.sampleEvery,
    );
    const res =
      count === 0
        ? { ready: built.ready, cyan: 0, pickIds: built.pickIds }
        : {
            cyan: count,
            ...(await pickAtSamples(page, {
              samples,
              imageWidth: image.width,
              imageHeight: image.height,
            })),
          };

    const errs = [...diagnostics.console, ...diagnostics.errors]
      .sort((a, b) => a.seq - b.seq)
      .map((record) =>
        record.type === "pageerror" ? `PAGEERR:${record.text}` : record.text,
      );
    return {
      res,
      errs: errs.filter((e) => !KNOWN_NOISE.test(e)),
      widgetsRemoved: strip.removed,
    };
  } finally {
    await context.close();
  }
}

/**
 * The probe's four checks over one run — pure and exported so
 * `polyline-probe-verdicts.spec.mjs` can drive it.
 *
 * @param {{webgpu: {res: object, errs: string[]}, webgl: {res: object, errs: string[]}}} run One run's results.
 * @returns {Array<{id: string, claim: string, pass: boolean, detail: object}>} Verdicts.
 */
export function evaluateAppearancePick({ webgpu: wgpu, webgl: wgl }) {
  return [
    {
      id: "webgl-picks",
      claim: "webgl pick returns the polyline (reference)",
      pass: Boolean(wgl.res.pickedPrimitive || wgl.res.pickedId),
      detail: { hits: wgl.res.hits ?? 0, nSamples: wgl.res.nSamples ?? 0 },
    },
    {
      id: "webgpu-renders-with-pick-ids",
      claim: "webgpu line renders (cyan>200) + has pickIds",
      pass: wgpu.res.cyan > 200 && wgpu.res.pickIds > 0,
      detail: { cyan: wgpu.res.cyan, pickIds: wgpu.res.pickIds },
    },
    {
      id: "webgpu-picks",
      claim: "webgpu pick returns the polyline primitive/id",
      pass: Boolean(wgpu.res.pickedPrimitive || wgpu.res.pickedId),
      detail: {
        hits: wgpu.res.hits ?? 0,
        nSamples: wgpu.res.nSamples ?? 0,
        pickCmds: wgpu.res.pickCmds ?? null,
        hasPickPipeline: wgpu.res.hasPickPipeline ?? null,
      },
    },
    {
      id: "webgpu-no-new-errors",
      claim: "no NEW webgpu errors (AtmosphereLUT filtered)",
      pass: wgpu.errs.length === 0,
      detail: { errors: wgpu.errs.slice(0, 4) },
    },
  ];
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "polyline-appearance-pick",
  title:
    "C11-09 — scene.pick over a PolylineColorAppearance Primitive (polyline appearance pick remainder)",
  outputSubdirectory: "polyline-appearance-pick",
  // No JSON receipt was banked before the migration.
  receiptEnvelope: "runtime",
  // The CesiumViewer page and the in-page imports both read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  workBudgetMs: () => 2 * BACKEND_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (
      !options.renderers.includes("webgl") ||
      !options.renderers.includes("webgpu")
    ) {
      throw new ProbeRefusal(
        "renderer-pair-required",
        `the pick gate reads WebGL as its sanity reference, so both renderers are required (got ${options.renderers.join(",")})`,
        { renderers: options.renderers },
      );
    }
    const shared = { browser, origin, run, outputDirectory, captures };
    // WebGPU first, the feature under test; WebGL second, the reference.
    const webgpu = await runBackend({ ...shared, renderer: "webgpu" });
    const webgl = await runBackend({ ...shared, renderer: "webgl" });
    console.log("WEBGPU:", JSON.stringify(webgpu.res));
    console.log("  errs:", webgpu.errs.slice(0, 4));
    console.log("WEBGL :", JSON.stringify(webgl.res));
    return [{ run, webgpu, webgl }];
  },
  verdicts(cells) {
    return cells.flatMap((cell) =>
      evaluateAppearancePick(cell).map((verdict) => ({
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
