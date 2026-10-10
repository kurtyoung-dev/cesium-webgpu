#!/usr/bin/env node
// Probe: GLOBE-CLIPPOLY-GEODETIC — globe clipping polygons, WebGL vs WebGPU.
// @purpose Globe clipping-polygon parity: the polygon hole must exist on both backends and the clip boundary must align (geodetic SDF convention fix)
// @status ACTIVE
//
// A clipping polygon at mid-latitude (~45°N) cuts a hole in the globe
// (solid baseColor, no imagery, black background). Verifies:
//   (1) The hole exists on BOTH backends (center of the polygon is
//       background-black).
//   (2) The clip boundary aligns between backends (pixel diff within
//       tolerance). Before the fix the WebGPU globe never activated the
//       polygon path at all (no hole), and its SDF lookup used exact
//       geocentric atan2 against a whole-globe equirect mapping instead of
//       the fastApproximateAtan2 + merged-extent atlas convention the SDF
//       is authored in (≤ ~0.19° boundary offset had it activated).
//
// The scene is the rig `globe-clippoly-hexagon`.
//
// ON THE SHARED RUNTIME (probe-kit harvest, globe family). The browser, the
// origin (`--port`, a governed Edge port, never the 8080 this probe used to
// hard-code), the served-build preflight, the Edge slot and the receipt belong
// to `lib/probe-runtime.mjs`. Each frame is an element capture of the scene
// canvas through `captureElement` (the canvas fills the page). The in-page
// hide in SETUP is kept from before the harvest; what the frame relies on is
// the kit's `lib/strip-viewer-widgets.mjs`, run right before each capture, as
// in every globe probe that captures on the CesiumViewer page: the backend
// refuses (`capture-chrome-over-canvas`) when anything is still stacked over
// the canvas, or when the strip reports nothing, and `chromeRemoved` in the
// cell records how many elements went, per renderer. The analysis runs in Node
// over the decoded PNGs:
// the whole-frame mismatch is `rgbSumDiff` and the hole test is
// `rgbSumBelowFraction` over the 120x120 centre box (`lib/metrics/rgb-sum.mjs`),
// both held to the in-page original by `metrics-globe-extraction.spec.mjs`.
//
// Usage: node Tools/visual-regression/probe-globe-clippoly-geodetic.mjs [--port 8094]
// @runtime lib/probe-runtime.mjs

import { decodePng } from "../lib/png-decode.mjs";
import { armWebGPUDevices, errorGateInit } from "../lib/webgpu-error-gate.mjs";
import {
  centredSquare,
  rgbSumBelowFraction,
  rgbSumDiff,
} from "./lib/metrics/rgb-sum.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";

/**
 * The launch flags this probe always ran under — a measurement condition, so
 * they are declared to the runtime rather than dropped.
 */
const LAUNCH_ARGS = Object.freeze([
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-vulkan",
  "--disable-cache",
]);

const SETUP = `
  const Cesium = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  scene.skyBox.show = false;
  scene.skyAtmosphere.show = false;
  scene.sun.show = false;
  scene.moon.show = false;
  scene.backgroundColor = Cesium.Color.BLACK.clone();
  scene.globe.showGroundAtmosphere = false;
  scene.globe.enableLighting = false;

  // Solid-color globe — geometry-only comparison, no imagery network noise.
  viewer.imageryLayers.removeAll();
  scene.globe.baseColor = Cesium.Color.SANDYBROWN.clone();

  // Hexagonal clipping polygon centered at (-105, 45), ~2° radius —
  // mid-latitude, where a geocentric-vs-spherical latitude convention
  // mismatch is at its worst (~0.19° on WGS84).
  const centerLon = -105.0;
  const centerLat = 45.0;
  const degs = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * 2.0 * Math.PI;
    degs.push(centerLon + 2.4 * Math.cos(a), centerLat + 1.7 * Math.sin(a));
  }
  scene.globe.clippingPolygons = new Cesium.ClippingPolygonCollection({
    polygons: [
      new Cesium.ClippingPolygon({
        positions: Cesium.Cartesian3.fromDegreesArray(degs),
      }),
    ],
  });

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, 1000000.0),
    orientation: {
      heading: 0.0,
      pitch: Cesium.Math.toRadians(-90.0),
      roll: 0.0,
    },
  });

  // Hide ALL UI chrome (renderer toggle, nav help, timeline, credits, ion
  // token banner) — the diff must only see the scene canvas.
  const container = viewer.container;
  for (const el of document.body.children) {
    if (el !== container && !container.contains(el)) {
      el.style.display = "none";
    }
  }
  const canvas = scene.canvas;
  const hideNonCanvas = (root) => {
    for (const el of root.children) {
      if (el === canvas || el.contains(canvas)) {
        hideNonCanvas(el);
      } else {
        el.style.display = "none";
      }
    }
  };
  hideNonCanvas(container);
`;

/**
 * One backend: a fresh browser context (the original launched a fresh browser
 * per backend), the scene set up and settled, and one element capture.
 */
async function capture({
  browser,
  origin,
  rendererArg,
  run,
  outputDirectory,
  captures,
}) {
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
  });
  try {
    return await captureInContext(context, {
      origin,
      rendererArg,
      run,
      outputDirectory,
      captures,
    });
  } finally {
    await context.close();
  }
}

async function captureInContext(
  context,
  { origin, rendererArg, run, outputDirectory, captures },
) {
  const page = await context.newPage();
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );
  await page.addInitScript(errorGateInit);

  const url = `${origin}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);
  await armWebGPUDevices(page);

  await page.evaluate(async (setup) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function("return (async () => {" + setup + "})();");
    await fn();
  }, SETUP);

  // Settle — let terrain tiles refine to the target LOD.
  await page.evaluate(async () => {
    const v = window.viewer;
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(500);

  // Header: the chrome comes off right before the frame, or the backend
  // refuses. A strip that reports nothing is not a clean canvas either.
  const chrome = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
  if (!Array.isArray(chrome?.leftovers) || chrome.leftovers.length > 0) {
    throw new ProbeRefusal(
      "capture-chrome-over-canvas",
      `clippoly (${rendererArg}): after the CesiumViewer chrome was ` +
        "stripped, elements were still stacked over the scene canvas " +
        `(${chrome?.leftovers?.join(", ") ?? "no strip report"}), ` +
        "so an element capture would measure them with the scene",
      { chrome: chrome ?? null, renderer: rendererArg },
    );
  }
  const shot = await captureElement({
    page,
    selector: ".cesium-widget canvas",
    name: `clippoly-${rendererArg}-run${run}`,
    outputDirectory,
    captures,
  });

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  return {
    image: decodePng(shot.buffer),
    errs,
    chromeRemoved: chrome.removed,
  };
}

/**
 * (a) the whole-frame mismatch percent and (b) each frame's "hole present"
 * fraction — near-black pixels (channel sum < 60) in the 120x120 box at the
 * canvas centre, inside the polygon where the background shows — in the
 * printed precision the original compared (2 and 3 decimals). A size mismatch
 * leaves every field null, which the verdict reads as no hole and 100 %.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} gpu
 * @param {{width: number, height: number, data: ArrayLike<number>}} gl
 * @returns {{mismatchPct: string|null, holeFracA: string|null, holeFracB: string|null}}
 */
export function analyzeClippoly(gpu, gl) {
  if (gpu.width !== gl.width || gpu.height !== gl.height) {
    return { mismatchPct: null, holeFracA: null, holeFracB: null };
  }
  const centre = (img) =>
    centredSquare(Math.floor(img.width / 2), Math.floor(img.height / 2), 60);
  return {
    mismatchPct: rgbSumDiff(gpu, gl).mismatchPct.toFixed(2),
    holeFracA: rgbSumBelowFraction(gpu, centre(gpu)).fraction.toFixed(3),
    holeFracB: rgbSumBelowFraction(gl, centre(gl)).fraction.toFixed(3),
  };
}

/**
 * The original parity criteria over one run: the hole is present on both
 * backends (centre >= 95 % background-black) and the whole-frame mismatch is
 * <= 2 % (boundary alignment), read from the printed values exactly as before.
 *
 * Pure and exported so `globe-probe-verdicts.spec.mjs` can drive it.
 *
 * @param {Array<{run: number, analysis: object}>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateClippoly(cells) {
  const verdicts = [];
  for (const { run, analysis } of cells) {
    const suffix = `run${run}`;
    const holeGpu = parseFloat(analysis.holeFracA ?? "0");
    const holeGl = parseFloat(analysis.holeFracB ?? "0");
    const mismatch = parseFloat(analysis.mismatchPct ?? "100");
    verdicts.push(
      {
        id: `hole-webgpu/${suffix}`,
        claim: `WebGPU clip hole present: centre dark fraction ${holeGpu} >= 0.95`,
        pass: holeGpu >= 0.95,
        detail: { holeFraction: holeGpu },
      },
      {
        id: `hole-webgl/${suffix}`,
        claim: `WebGL clip hole present: centre dark fraction ${holeGl} >= 0.95`,
        pass: holeGl >= 0.95,
        detail: { holeFraction: holeGl },
      },
      {
        id: `boundary-aligned/${suffix}`,
        claim: `clip boundary aligned: whole-frame mismatch ${mismatch}% <= 2%`,
        pass: mismatch <= 2.0,
        detail: { mismatchPct: mismatch },
      },
    );
  }
  return verdicts;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "globe-clippoly-geodetic",
  title:
    "GLOBE-CLIPPOLY-GEODETIC — globe clipping polygon hole and boundary, WebGL vs WebGPU",
  outputSubdirectory: "globe-clippoly-geodetic",
  // No JSON receipt was banked before the migration.
  receiptEnvelope: "runtime",
  launchArgs: LAUNCH_ARGS,
  // The CesiumViewer page and the SETUP import read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (
      !options.renderers.includes("webgl") ||
      !options.renderers.includes("webgpu")
    ) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "clip-polygon parity compares the two backends, so both renderers " +
          `are required (got ${options.renderers.join(",")})`,
        { renderers: options.renderers },
      );
    }
    const shared = { browser, origin, run, outputDirectory, captures };
    console.log("[probe-clippoly] running webgpu...");
    const gpu = await capture({ ...shared, rendererArg: "webgpu" });
    console.log("[probe-clippoly] running webgl...");
    const gl = await capture({ ...shared, rendererArg: "webgl" });
    if (gpu.errs.length)
      console.log(
        `  webgpu errors:`,
        gpu.errs.slice(0, 5).map((e) => e.text),
      );
    if (gl.errs.length)
      console.log(
        `  webgl errors:`,
        gl.errs.slice(0, 5).map((e) => e.text),
      );
    const analysis = analyzeClippoly(gpu.image, gl.image);
    console.log(`  analysis:`, JSON.stringify(analysis));
    return [
      {
        run,
        analysis,
        chromeRemoved: { webgpu: gpu.chromeRemoved, webgl: gl.chromeRemoved },
      },
    ];
  },
  verdicts(cells) {
    return evaluateClippoly(cells);
  },
  receipt(cells, context) {
    for (const verdict of context.verdicts) {
      console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
    }
    return { cells, verdicts: context.verdicts };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
