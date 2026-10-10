#!/usr/bin/env node
// Probe (C9-13 NEW-GLOBE-EFFECTS-PER-VIEW-PREPARED-HANDLE — off-gate oracle):
// @purpose Oracle for the per-frame globe-effects bind-group memo: clipping ON-OFF-ON must carve, restore, and re-carve terrain with zero stale-handle errors
// @status ACTIVE
//
// the per-(context,frame) prepared globe effects bind group memo
// (`_getOrCreateFrameEffectsBindGroup` in WebGPUGlobeSurfaceRenderer.ts) must
// preserve the active/placeholder toggle semantics. A stale memo would leave
// last frame's active effects bytes bound after the feature turns off, or fail
// to re-arm on restore.
//
// This exercises the memo's ACTIVE -> PLACEHOLDER -> ACTIVE transition by
// toggling `globe.clippingPlanes.enabled` on -> off -> on (clipping is the
// term unique to the globe effects gate; enabled clipping carves a hole in the
// terrain, disabled restores it):
//
//   (A) ON     — an enabled clipping plane removes terrain pixels (a visible
//                clipped region appears vs the un-clipped baseline).
//   (B) OFF    — disabling restores the terrain: the OFF frame matches the
//                pre-clip baseline within tolerance (no stale clipped hole,
//                proving the memo swapped back to the placeholder).
//   (C) RESTORE— re-enabling reproduces the ON frame within tolerance (the
//                memo re-armed the active handle; not a frozen placeholder).
//   (D) ZERO console/validation errors across all transitions.
//
// Determinism: requestRenderMode off, clock pinned, fixed camera, per-toggle
// settle. The scene is the rig `globe-effects-clip-toggle`.
//
// ON THE SHARED RUNTIME (probe-kit harvest, globe family). The browser, the
// origin (`--port`, a governed Edge port, never 8080), the served-build
// preflight, the Edge slot and the receipt belong to `lib/probe-runtime.mjs`.
// The four frames are element captures through `captureElement`, which asks
// the device-loss gate before banking a frame; the in-page `drawImage`
// readback this probe used to diff is gone. The changed-pixel counts are
// `diffImages` (`lib/image-diff.mjs`) at the original per-channel tolerance of
// 12, run in Node over the decoded PNGs — the same rule the in-page loop
// applied (`metrics-globe-extraction.spec.mjs` holds the two equal).
//
// THE CHROME IS STRIPPED BEFORE THE FIRST FRAME. An element capture is a
// screenshot of the canvas's rectangle, so it composites whatever the page
// stacks over it: the CesiumViewer toolbar, the navigation-help panel (open
// in every fresh context), the animation widget, the credits and the
// timeline. The in-page readback this replaced saw the canvas alone, and the
// 5000-px floor and the 15 % ratios were set on that population. The kit's
// `lib/strip-viewer-widgets.mjs` removes the chrome after the warmup (the
// page hides its loading indicator on the first rendered frame) and before
// the baseline frame, so all four frames are of the canvas; the cell refuses
// (`capture-chrome-over-canvas`) when anything is still stacked over the
// canvas, and `chromeRemoved` records how many elements went.
//
// Usage: node Tools/visual-regression/probe-globe-effects-handle-toggle.mjs [--port 8094]
// @runtime lib/probe-runtime.mjs

import { decodePng } from "../lib/png-decode.mjs";
import { armWebGPUDevices, errorGateInit } from "../lib/webgpu-error-gate.mjs";
import { diffImages } from "./lib/image-diff.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";

const VIEWPORT = Object.freeze({ width: 1024, height: 768 });
const SCENE_CANVAS = ".cesium-widget canvas";
/** Per-channel tolerance of the original in-page diff (`> 12`). */
const CHANNEL_TOLERANCE = 12;
/** The four frames, in capture order. */
const FRAMES = Object.freeze(["baseline", "on", "off", "restore"]);

/**
 * Page side: pin the scene and warm up until imagery settles. Unchanged from
 * the in-page original apart from being its own step.
 *
 * @returns {Promise<{warmupFrames: number, tilesLoaded: boolean}>}
 */
async function pageWarmup() {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;

  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;
  v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-15T18:00:00Z");

  const center = C.Cartesian3.fromDegrees(-100, 40, 2_000_000);
  v.camera.setView({ destination: center });

  const oncePostRender = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
    });

  // Warmup until imagery settles.
  let frames = 0;
  let consecutive = 0;
  for (; frames < 900; frames++) {
    await oncePostRender();
    consecutive = scene.globe.tilesLoaded ? consecutive + 1 : 0;
    if (frames > 300 && consecutive > 60) break;
  }
  return { warmupFrames: frames, tilesLoaded: scene.globe.tilesLoaded };
}

/**
 * Page side: one clipping-state step, then the original 40-frame settle.
 *
 * A large clipping plane through the view carves out terrain. The globe
 * effects gate keys on `clippingPlanes.length > 0` (matching WebGPU's existing
 * semantics — `.enabled` is honored upstream in the collection's texture
 * update, not by the bind-group gate), so the memo's active -> placeholder ->
 * active transition is driven by ASSIGNING vs REMOVING the collection
 * (length 1 -> 0 -> 1).
 *
 * @param {"on"|"off"|"restore"} step
 * @returns {Promise<{tilesLoaded: boolean}>}
 */
async function pageClipStep(step) {
  const C = await import("/Build/CesiumUnminified/index.js");
  const scene = window.viewer.scene;
  const oncePostRender = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
    });
  const makePlane = () =>
    new C.ClippingPlane(new C.Cartesian3(1.0, 0.0, 0.0), 0.0);
  if (step === "on") {
    scene.globe.clippingPlanes = new C.ClippingPlaneCollection({
      planes: [makePlane()],
      edgeWidth: 0.0,
      enabled: true,
      unionClippingRegions: true,
    });
  } else if (step === "off") {
    // OFF — empty the collection (length -> 0): gate falls to the placeholder.
    scene.globe.clippingPlanes.removeAll();
  } else {
    // RESTORE — re-add a plane (length -> 1): the memo must re-arm the
    // active handle rather than serving the frozen placeholder.
    scene.globe.clippingPlanes.add(makePlane());
  }
  for (let i = 0; i < 40; i++) await oncePostRender();
  return { tilesLoaded: scene.globe.tilesLoaded };
}

/**
 * The four clauses, per run, with the original bars: (A) ON changes more than
 * 5000 px vs the baseline; (B) OFF and (C) RESTORE each differ from their
 * reference by less than 15 % of the ON carve; (D) no console error.
 *
 * Pure and exported so `globe-probe-verdicts.spec.mjs` can put a cell on
 * either side of every bar without a browser.
 *
 * @param {Array<object>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateEffectsToggle(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    const carve = cell.onVsBaseline * 0.15;
    verdicts.push(
      {
        id: `clip-on-carves/${suffix}`,
        claim: `(A) clipping ON changes ${cell.onVsBaseline}/${cell.totalPx} px vs baseline (warmup ${cell.warmupFrames}, tilesLoaded=${cell.tilesLoaded}) (>5000)`,
        pass: cell.onVsBaseline > 5000,
        detail: { changedPx: cell.onVsBaseline, floor: 5000 },
      },
      {
        id: `clip-off-restores-baseline/${suffix}`,
        claim: `(B) clipping OFF restores baseline: ${cell.offVsBaseline} px vs baseline (< ${Math.round(carve)} = 15% of ON carve)`,
        pass: cell.offVsBaseline < carve,
        detail: { changedPx: cell.offVsBaseline, ceiling: carve },
      },
      {
        id: `clip-restore-reproduces-on/${suffix}`,
        claim: `(C) clipping RESTORE reproduces ON: ${cell.restoreVsOn} px vs ON (< ${Math.round(carve)})`,
        pass: cell.restoreVsOn < carve,
        detail: { changedPx: cell.restoreVsOn, ceiling: carve },
      },
      {
        id: `console-errors/${suffix}`,
        claim: `(D) console errors: ${cell.errors.length}`,
        pass: cell.errors.length === 0,
        detail: { errors: cell.errors.slice(0, 8) },
      },
    );
  }
  return verdicts;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "globe-effects-handle-toggle",
  title:
    "Globe effects handle toggle — clipping ON/OFF/RESTORE carves, restores and re-carves",
  outputSubdirectory: "globe-effects-handle-toggle",
  // No JSON receipt was banked before the migration, so no reader keys off a
  // probe-owned field set; one runtime document is the honest shape.
  receiptEnvelope: "runtime",
  args: { defaults: { renderers: ["webgpu"] } },
  // The CesiumViewer page (`Apps/CesiumViewer/CesiumViewer.js`) and every
  // in-page import here read this module; the default list's IIFE bundle is a
  // file this page never loads.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the per-frame globe effects bind-group memo is WebGPU-only, so this " +
          `oracle has nothing to measure on ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const context = await browser.newContext({ viewport: { ...VIEWPORT } });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      await page.addInitScript(errorGateInit);
      await page.goto(
        `${origin}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
        { waitUntil: "networkidle" },
      );
      await page.waitForFunction(() => !!window.viewer);
      await armWebGPUDevices(page);

      const warm = await page.evaluate(pageWarmup);
      // Header: the chrome comes off before the baseline frame, or the cell
      // refuses. A strip that reports nothing is not a clean canvas either.
      const chrome = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
      if (!Array.isArray(chrome?.leftovers) || chrome.leftovers.length > 0) {
        throw new ProbeRefusal(
          "capture-chrome-over-canvas",
          "after the CesiumViewer chrome was stripped, elements were still " +
            `stacked over the scene canvas (${chrome?.leftovers?.join(", ") ?? "no strip report"}), ` +
            "so an element capture would measure them with the scene",
          { chrome: chrome ?? null },
        );
      }
      let tilesLoaded = warm.tilesLoaded;
      const images = {};
      for (const frame of FRAMES) {
        if (frame !== "baseline") {
          ({ tilesLoaded } = await page.evaluate(pageClipStep, frame));
        }
        const shot = await captureElement({
          page,
          selector: SCENE_CANVAS,
          name: `effects-toggle-${frame}-run${run}`,
          outputDirectory,
          captures,
        });
        images[frame] = decodePng(shot.buffer);
      }
      const count = (a, b) =>
        diffImages(a, b, { tolerance: CHANNEL_TOLERANCE }).changedPx;
      return [
        {
          run,
          warmupFrames: warm.warmupFrames,
          tilesLoaded,
          totalPx: images.baseline.width * images.baseline.height,
          onVsBaseline: count(images.on, images.baseline),
          offVsBaseline: count(images.off, images.baseline),
          restoreVsOn: count(images.restore, images.on),
          chromeRemoved: chrome.removed,
          errors: [...errors],
        },
      ];
    } finally {
      await context.close();
    }
  },
  verdicts(cells) {
    return evaluateEffectsToggle(cells);
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
