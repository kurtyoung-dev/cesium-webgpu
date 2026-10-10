#!/usr/bin/env node
// Probe: GLOBE-UNDERGROUND-COLOR — globe.undergroundColor +
// undergroundColorAlphaByDistance tint parity (WebGL vs WebGPU).
// @purpose globe.undergroundColor + alphaByDistance tint parity: above-ground off-gate plus red-tint and default underground camera scenarios
// @status ACTIVE
//
// Scenarios:
//   above-default    — default load, camera above ground, default underground
//                      settings. OFF-GATE: the underground blend must not
//                      engage; WebGL/WebGPU diff must match the standing
//                      globe-default parity (no new artifact).
//   underground-red  — camera 30 km below the surface with a red
//                      undergroundColor + a custom alpha-by-distance ramp.
//                      ACCEPTANCE: WebGPU tint must match WebGL.
//   underground-def  — camera underground with the DEFAULT (black)
//                      undergroundColor + default NearFarScalar ramp.
//                      Parity check for the upstream-default underground look.
//
// The three scenes are the rigs `globe-underground-above`,
// `globe-underground-red` and `globe-underground-default`.
//
// ON THE SHARED RUNTIME (probe-kit harvest, globe family). The browser, the
// origin (`--port`, a governed Edge port, never 8080), the served-build
// preflight, the Edge slot and the receipt belong to `lib/probe-runtime.mjs`.
// Each frame is an element capture of the scene canvas through
// `captureElement` (the canvas fills the page, so the frame is the region the
// page screenshot covered). The cross-backend mismatch is `rgbSumDiff`
// (`lib/metrics/rgb-sum.mjs`, channel-sum delta > 30), computed in Node over
// the decoded PNGs instead of in a second browser; its numbers are held to the
// in-page original by `metrics-globe-extraction.spec.mjs`. `--runs N` replaces
// the `PROBE_RUNS` environment variable and the verdict takes the per-scene
// median across runs, as `nRunMedian` did.
//
// THE CHROME IS STRIPPED BEFORE EVERY FRAME. An element capture is a
// screenshot of the canvas's rectangle, so it composites whatever the page
// stacks over it. The in-page hide below is kept from before the harvest, but
// its six selectors leave out the Viewer's fullscreen button, which the Viewer
// builds by default at the bottom-right of the canvas rectangle (in every
// banked pre-harvest frame of this probe, on both renderers, the bottom-right
// 32x32 corner holds its icon: 74 pixels above 200 on all three channels). So
// right before each capture the kit's `lib/strip-viewer-widgets.mjs` removes
// the Viewer chrome, and the scene refuses (`capture-chrome-over-canvas`) when
// anything is still stacked over the canvas, or when the strip reports
// nothing, rather than score it. `chromeRemoved` in the cell records how many
// elements went, per scene and renderer.
//
// Usage: node Tools/visual-regression/probe-globe-underground.mjs [--port 8094] [--runs N]
// Outputs: Tools/visual-regression/output/globe-underground/
// @runtime lib/probe-runtime.mjs

import { decodePng } from "../lib/png-decode.mjs";
import { armWebGPUDevices, errorGateInit } from "../lib/webgpu-error-gate.mjs";
import {
  DET_BROWSER_SETUP,
  DETERMINISTIC_CLOCK_ISO,
  median,
  spread,
} from "./lib/determinism-kit.mjs";
import { rgbSumDiff } from "./lib/metrics/rgb-sum.mjs";
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
// Q7-PROBE-DETERMINISM: pin the clock + damp the sky + settle-to-steady-state
// so the run-to-run star-twinkle / tile-LOD drift (audit: underground 12.28 vs
// 6.75 on unchanged builds) collapses. `--runs N` additionally medians the
// metric over N runs.

// Camera 30 km below the surface near Philadelphia, looking gently upward
// so the frame contains both the nearby underside of the terrain shell
// (short v_distance → partial tint) and the far interior of the globe
// (megameter distances → full tint).
const UNDERGROUND_CAMERA = `
  const carto = { longitude: -1.3194745, latitude: 0.6988017, height: -30000.0 };
  const dest = scene.globe.ellipsoid.cartographicToCartesian(carto);
  scene.screenSpaceCameraController.enableCollisionDetection = false;
  v.camera.setView({
    destination: dest,
    orientation: { heading: 0.4, pitch: 0.25, roll: 0.0 },
  });
`;

const SCENARIOS = [
  {
    name: "above-default",
    dampSky: true,
    setup: `
      // Default everything — camera stays at the app's default view.
      // The underground gate must stay closed.
    `,
  },
  {
    name: "underground-red",
    dampSky: true,
    setup: `
      const g = scene.globe;
      // Mutate the live Color / NearFarScalar instances (the CesiumViewer
      // page doesn't expose the Cesium namespace; getters return the
      // internal instances so field mutation is equivalent to the setter).
      g.undergroundColor.red = 0.9;
      g.undergroundColor.green = 0.05;
      g.undergroundColor.blue = 0.05;
      g.undergroundColor.alpha = 1.0;
      const nfs = g.undergroundColorAlphaByDistance;
      nfs.near = 1000.0;
      nfs.nearValue = 0.4;
      nfs.far = 400000.0;
      nfs.farValue = 1.0;
      ${UNDERGROUND_CAMERA}
    `,
  },
  {
    name: "underground-def",
    dampSky: true,
    setup: `
      // Upstream defaults: black undergroundColor, NearFarScalar
      // (maxRadius/1000, 0, maxRadius/5, 1). Only the camera moves.
      ${UNDERGROUND_CAMERA}
    `,
  },
];

/**
 * One scene on one backend: a fresh browser context (the original launched a
 * fresh browser per capture), the scenario applied and settled, and one
 * element capture of the scene canvas.
 */
async function capture({
  browser,
  origin,
  rendererArg,
  scenario,
  run,
  outputDirectory,
  captures,
}) {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 640 },
  });
  try {
    return await captureInContext(context, {
      origin,
      rendererArg,
      scenario,
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
  { origin, rendererArg, scenario, run, outputDirectory, captures },
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

  // Apply the scenario, then settle to a deterministic steady state.
  await page.evaluate(
    async ({ setup, det, iso, dampSky }) => {
      const v = window.viewer;
      const scene = v.scene;
      // Hide viewer chrome (toolbar, timeline, animation widget, credits,
      // ion default-token banner) so the pixel diff measures ONLY the
      // canvas. The ion banner in particular appears with backend-dependent
      // timing and would otherwise dominate the mismatch percentage. Kept
      // from before the harvest; what clears the frame is the kit strip right
      // before the capture (header).
      for (const el of document.querySelectorAll(
        ".cesium-viewer-toolbar, .cesium-viewer-animationContainer, " +
          ".cesium-viewer-timelineContainer, .cesium-viewer-bottom, " +
          ".cesium-widget-credits, #toolbar",
      )) {
        el.style.display = "none";
      }
      // Q7 determinism kit: freeze the clock (stops star/sun drift), damp the
      // sky (removes the celestial cross-backend residual unrelated to the
      // underground tint), then settle on tilesLoaded steady state.
      // eslint-disable-next-line no-new-func
      new Function(det)();
      const C = await import("/Build/CesiumUnminified/index.js");
      window.__det.pinClock(C, v, scene, iso);
      if (dampSky) window.__det.dampSky(scene);
      // eslint-disable-next-line no-new-func
      new Function("v", "scene", setup)(v, scene);
      await window.__det.settleTiles(scene, {
        stableFrames: 30,
        maxFrames: 1500,
      });
    },
    {
      setup: scenario.setup,
      det: DET_BROWSER_SETUP,
      iso: DETERMINISTIC_CLOCK_ISO,
      dampSky: scenario.dampSky !== false,
    },
  );

  // Header: the chrome comes off right before the frame, or the scene refuses.
  // A strip that reports nothing is not a clean canvas either.
  const chrome = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
  if (!Array.isArray(chrome?.leftovers) || chrome.leftovers.length > 0) {
    throw new ProbeRefusal(
      "capture-chrome-over-canvas",
      `${scenario.name} (${rendererArg}): after the CesiumViewer chrome was ` +
        "stripped, elements were still stacked over the scene canvas " +
        `(${chrome?.leftovers?.join(", ") ?? "no strip report"}), ` +
        "so an element capture would measure them with the scene",
      { chrome: chrome ?? null, scene: scenario.name, renderer: rendererArg },
    );
  }
  const shot = await captureElement({
    page,
    selector: ".cesium-widget canvas",
    name: `${scenario.name}-${rendererArg}-run${run}`,
    outputDirectory,
    captures,
  });

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) {
    console.log(`  ${errs.length} console errors (${rendererArg}):`);
    errs.slice(0, 3).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }
  return {
    image: decodePng(shot.buffer),
    consoleErrors: errs.length,
    chromeRemoved: chrome.removed,
  };
}

/**
 * The cross-backend mismatch percent of one scene, `rgbSumDiff(webgpu, webgl)`
 * as the in-page `diffPngs(gpu, gl)` read it. A size mismatch scored 100, and
 * still does. Exported so `globe-probe-verdicts.spec.mjs` can pin that.
 */
export function scenarioMismatchPct(gpu, gl) {
  if (gpu.width !== gl.width || gpu.height !== gl.height) {
    return 100;
  }
  return rgbSumDiff(gpu, gl).mismatchPct;
}

/**
 * Per scene, the median mismatch over the run's cells against the original
 * limits. The above-default scene measures the STANDING above-ground
 * WebGL-vs-WebGPU residual (imagery LOD sharpness + atmosphere brightness +
 * star field noise — ~22-24% at threshold-30 when this probe was written; the
 * same residual was measured BEFORE the underground work landed, so it is not
 * attributable to this feature), with a gross guard of 30 %. The underground
 * scenes are judged RELATIVE to that baseline: before the fix they sat at
 * 87-95% (underside not rendered at all + no tint); at parity they stay within
 * the standing residual + 2 % (tile-LOD refinement), and never under 8 %.
 *
 * Pure and exported so `globe-probe-verdicts.spec.mjs` can drive it.
 *
 * @param {Array<{run: number, scenes: Record<string, number>}>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateUnderground(cells) {
  const verdicts = [];
  let baselinePct = null;
  for (const scenario of SCENARIOS) {
    const values = cells.map((cell) => cell.scenes[scenario.name]);
    const pct = median(values);
    let limit;
    if (scenario.name === "above-default") {
      baselinePct = pct;
      limit = 30.0;
    } else {
      limit = Math.max(8.0, (baselinePct ?? 22.0) + 2.0);
    }
    verdicts.push({
      id: `mismatch/${scenario.name}`,
      claim: `${scenario.name}: mismatch median=${pct.toFixed(2)}% <= ${limit.toFixed(1)}% (runs=[${values.map((x) => x.toFixed(2)).join(", ")}], spread=${spread(values).toFixed(2)}pp)`,
      pass: pct <= limit,
      detail: { median: pct, limit, values },
    });
  }
  return verdicts;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "globe-underground",
  title:
    "GLOBE-UNDERGROUND-COLOR — globe.undergroundColor + alphaByDistance tint parity, WebGL vs WebGPU",
  outputSubdirectory: "globe-underground",
  // No JSON receipt was banked before the migration.
  receiptEnvelope: "runtime",
  launchArgs: LAUNCH_ARGS,
  // The CesiumViewer page and every in-page import here read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (
      !options.renderers.includes("webgl") ||
      !options.renderers.includes("webgpu")
    ) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "underground tint parity is a WebGL-vs-WebGPU mismatch, so both " +
          `renderers are required (got ${options.renderers.join(",")})`,
        { renderers: options.renderers },
      );
    }
    const scenes = {};
    const chromeRemoved = {};
    for (const scenario of SCENARIOS) {
      console.log(`[probe-globe-underground] ${scenario.name} (run ${run})`);
      const shared = {
        browser,
        origin,
        scenario,
        run,
        outputDirectory,
        captures,
      };
      const gpu = await capture({ ...shared, rendererArg: "webgpu" });
      const gl = await capture({ ...shared, rendererArg: "webgl" });
      scenes[scenario.name] = scenarioMismatchPct(gpu.image, gl.image);
      chromeRemoved[scenario.name] = {
        webgpu: gpu.chromeRemoved,
        webgl: gl.chromeRemoved,
      };
    }
    return [{ run, scenes, chromeRemoved }];
  },
  verdicts(cells) {
    return evaluateUnderground(cells);
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
