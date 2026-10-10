#!/usr/bin/env node
// Probe: GLOBE-TRANSLUCENCY-ALPHA — globe.translucency per-fragment alpha
// parity (WebGL vs WebGPU). The 9 derived blend/cull/depth pipeline variants
// were already wired (Batches 177/182); this probe verifies the alpha values
// (frontFaceAlpha × frontFaceAlphaByDistance) actually reach the globe FS so
// an enabled translucent globe composites see-through, not opaque.
// @purpose globe.translucency per-fragment alpha parity: off-gate at defaults, see-through planet from space, half-alpha terrain oblique — WebGL vs WebGPU
// @status ACTIVE
//
// Scenarios:
//   off-default        — default load, translucency disabled (the default).
//                        OFF-GATE: the translucency alpha gate must stay
//                        closed; WebGL/WebGPU diff must match the standing
//                        globe-default parity residual (no new artifact).
//                        Sets the baseline for the enabled scenarios.
//   translucent-space  — default space camera + translucency.enabled +
//                        frontFaceAlpha = 0.5. ACCEPTANCE: the whole planet
//                        disk becomes see-through (back side + stars blend
//                        through) on BOTH backends comparably.
//   translucent-terrain— camera 60 km above terrain looking down at an
//                        oblique pitch + frontFaceAlpha = 0.5. ACCEPTANCE:
//                        near terrain composites at half alpha over the far
//                        side of the globe, matching WebGL.
//
// The three scenes are the rigs `globe-translucency-default`,
// `globe-translucency-space` and `globe-translucency-terrain`.
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
// Usage: node Tools/visual-regression/probe-globe-translucency.mjs [--port 8094] [--runs N]
// Outputs: Tools/visual-regression/output/globe-translucency/
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
// Q7-PROBE-DETERMINISM: pin the clock + settle-to-steady-state (and damp the
// sky where stars are not the signal) so the run-to-run drift (audit:
// translucency 25.49 vs 23.14 on unchanged builds) collapses. The
// translucent-space scenario keeps the sky ON — the stars blending THROUGH the
// see-through globe are its acceptance signal — but the pinned clock still
// freezes them deterministically. `--runs N` medians the metric over N runs.

const ENABLE_TRANSLUCENCY = `
  scene.globe.translucency.enabled = true;
  scene.globe.translucency.frontFaceAlpha = 0.5;
`;

// 60 km above the surface near Philadelphia, pitched down obliquely so the
// frame contains near terrain (short v_distance) AND the horizon/far side
// that the translucent blend reveals.
const TERRAIN_CAMERA = `
  const carto = { longitude: -1.3194745, latitude: 0.6988017, height: 60000.0 };
  const dest = scene.globe.ellipsoid.cartographicToCartesian(carto);
  v.camera.setView({
    destination: dest,
    orientation: { heading: 0.4, pitch: -0.9, roll: 0.0 },
  });
`;

const SCENARIOS = [
  {
    name: "off-default",
    dampSky: true,
    setup: `
      // Default everything — globe.translucency.enabled is false by default.
      // The translucency alpha gate must stay closed.
    `,
  },
  {
    name: "translucent-space",
    // Stars blending THROUGH the see-through globe are this scenario's
    // acceptance signal, so keep the sky ON — the pinned clock still makes
    // it deterministic.
    dampSky: false,
    setup: `
      ${ENABLE_TRANSLUCENCY}
    `,
  },
  {
    name: "translucent-terrain",
    dampSky: true,
    setup: `
      ${ENABLE_TRANSLUCENCY}
      ${TERRAIN_CAMERA}
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
      // Hide viewer chrome so the pixel diff measures ONLY the canvas. Kept
      // from before the harvest; what clears the frame is the kit strip right
      // before the capture (header).
      for (const el of document.querySelectorAll(
        ".cesium-viewer-toolbar, .cesium-viewer-animationContainer, " +
          ".cesium-viewer-timelineContainer, .cesium-viewer-bottom, " +
          ".cesium-widget-credits, #toolbar",
      )) {
        el.style.display = "none";
      }
      // Q7 determinism kit: freeze the clock, optionally damp the sky, settle.
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
 * limits. The off-default scene measures the STANDING WebGL-vs-WebGPU residual
 * at the default view (imagery LOD sharpness + atmosphere brightness +
 * star-field noise), with a gross guard of 30 %. The translucent scenes are
 * judged RELATIVE to that baseline: before the alpha threading landed they sat
 * far above it (WebGPU composited fully opaque where WebGL was see-through); at
 * parity they stay within the standing residual + 8 % (the see-through
 * composite doubles the imagery surface area whose LOD refinement can disagree
 * between backends), and never under 10 %.
 *
 * Pure and exported so `globe-probe-verdicts.spec.mjs` can drive it.
 *
 * @param {Array<{run: number, scenes: Record<string, number>}>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateTranslucency(cells) {
  const verdicts = [];
  let baselinePct = null;
  for (const scenario of SCENARIOS) {
    const values = cells.map((cell) => cell.scenes[scenario.name]);
    const pct = median(values);
    let limit;
    if (scenario.name === "off-default") {
      baselinePct = pct;
      limit = 30.0;
    } else {
      limit = Math.max(10.0, (baselinePct ?? 22.0) + 8.0);
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
  name: "globe-translucency",
  title:
    "GLOBE-TRANSLUCENCY-ALPHA — globe.translucency per-fragment alpha parity, WebGL vs WebGPU",
  outputSubdirectory: "globe-translucency",
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
        "translucency parity is a WebGL-vs-WebGPU mismatch, so both renderers " +
          `are required (got ${options.renderers.join(",")})`,
        { renderers: options.renderers },
      );
    }
    const scenes = {};
    const chromeRemoved = {};
    for (const scenario of SCENARIOS) {
      console.log(`[probe-globe-translucency] ${scenario.name} (run ${run})`);
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
    return evaluateTranslucency(cells);
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
