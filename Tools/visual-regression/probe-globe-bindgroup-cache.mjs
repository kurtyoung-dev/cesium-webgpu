#!/usr/bin/env node
// Probe (Batch 241 — NEW-GLOBE-BINDGROUP-CACHE verify + regression gate):
// @purpose Gates the globe per-tile bind-group cache: creations settle to ~0, spike+resettle on pan, globe visibly renders, zero validation errors
// @status ACTIVE
//
// the globe surface renderer's per-tile bind-group cache must
//   (A) SETTLE — after tiles load at a fixed camera, bind-group
//       creations/frame must drop to ~0 over a 30-frame steady window
//       (HEAD-equivalent "before" number = requests/frame, since before
//       the cache every request was a device.createBindGroup call),
//   (B) PAN — moving the camera to a new tile set spikes creations
//       (new imagery views + new ring-allocator offsets), then settles
//       back to ~0 once tiles load,
//   (C) RENDER — the globe is visually present (non-black coverage with
//       imagery color diversity, not a flat clear color),
//   (D) produce ZERO console errors (incl. WebGPU validation errors —
//       a bad cached bind group would invalidate the whole pass).
//
// Stats source: `globalThis.__webgpuGlobeBindGroupCache` (published by
// WebGPUGlobeSurfaceRenderer.initialize; counters are debug-pragma'd so
// this probe must run against the unminified dev build, which keeps
// pragmas).
//
// The captured scene is the rig `globe-bindgroup-cache-pan`.
//
// ON THE SHARED RUNTIME (probe-kit harvest, globe family). The browser, the
// origin (`--port`, a governed Edge port), the served-build preflight, the
// Edge slot and the receipt belong to `lib/probe-runtime.mjs`. The phases run
// as separate page steps so the (C) frame can be taken between them through
// `captureElement` (the seam asks the device-loss gate before banking) instead
// of the in-page `drawImage` readback it used; (C)'s coverage and colour-bucket
// numbers are `colourDiversity` (`lib/metrics/colour-diversity.mjs`) in Node,
// held to the in-page loop by `metrics-globe-extraction.spec.mjs`. A second
// capture after (E) replaces the page screenshot this probe banked.
//
// THE CHROME IS STRIPPED BEFORE THE FIRST FRAME. An element capture is a
// screenshot of the canvas's rectangle, so it composites whatever the page
// stacks over it: the CesiumViewer toolbar, the navigation-help panel (open
// in every fresh context), the animation widget, the credits and the
// timeline. The `drawImage` readback this replaced saw the canvas alone. The
// kit's `lib/strip-viewer-widgets.mjs` removes them right before the first
// capture, after A and B have rendered (the page hides its loading indicator
// on the first rendered frame), and the cell refuses
// (`capture-chrome-over-canvas`) when anything is still stacked over the
// canvas, rather than measure (C) through it. `chromeRemoved` in the cell
// records how many elements went.
//
// Usage: node Tools/visual-regression/probe-globe-bindgroup-cache.mjs [--port 8094]
// @runtime lib/probe-runtime.mjs

import { decodePng } from "../lib/png-decode.mjs";
import { armWebGPUDevices, errorGateInit } from "../lib/webgpu-error-gate.mjs";
import { colourDiversity } from "./lib/metrics/colour-diversity.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";

const SCENE_CANVAS = ".cesium-widget canvas";

/**
 * Page side, phases A and B. The helpers are left on `window.__bindGroupProbe`
 * so phase E (a separate page step) reuses them rather than restating them.
 *
 * @returns {Promise<object>} Phase A and B measurements.
 */
async function pagePhasesAB() {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;

  // CesiumViewer runs requestRenderMode=true — at a settled camera the
  // loop stops rendering and per-frame stats freeze. Force continuous
  // renders so creations/frame is measurable.
  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;

  const oncePostRender = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
    });

  const stats = () => {
    const cache = globalThis.__webgpuGlobeBindGroupCache;
    return cache ? cache.getStats() : null;
  };

  // Render frames until the globe reports tiles loaded AND the tile
  // path is actively requesting bind groups every frame. The second
  // condition is critical: `tilesLoaded` is vacuously true while the
  // imagery provider is still async-initializing, AND while the
  // central pipeline cache is asynchronously materializing the globe
  // pipeline variants `createTileCommands` early-`continue`s before
  // any bind-group request — both windows would let a hollow steady
  // measurement pass. Requiring a per-frame request delta > 0 across
  // the whole streak proves real tile commands are being emitted.
  // Hard cap so a stuck tile pipeline fails loudly instead of hanging.
  const renderUntilSettled = async (maxFrames, extraAfterLoaded) => {
    let loadedStreak = 0;
    let prevRequests = -1;
    for (let i = 0; i < maxFrames; i++) {
      await oncePostRender();
      const s = stats();
      const requests = s ? s.creates + s.hits : 0;
      const requestsTicking = prevRequests >= 0 && requests > prevRequests;
      prevRequests = requests;
      const rendering =
        (scene.globe._surface?._tilesToRender?.length ?? 0) > 0 &&
        requestsTicking;
      if (scene.globe.tilesLoaded && rendering) {
        loadedStreak++;
        if (loadedStreak >= extraAfterLoaded) return { settled: true, i };
      } else {
        loadedStreak = 0;
      }
    }
    return { settled: false, i: maxFrames };
  };

  // Measure creates + requests over a window of frames.
  const measure = async (frames) => {
    const s0 = stats();
    for (let i = 0; i < frames; i++) {
      await oncePostRender();
    }
    const s1 = stats();
    return {
      frames,
      creates: s1.creates - s0.creates,
      hits: s1.hits - s0.hits,
      createsPerFrame: (s1.creates - s0.creates) / frames,
      requestsPerFrame: (s1.creates - s0.creates + s1.hits - s0.hits) / frames,
      entries: s1.entries,
    };
  };

  // ── Phase A: fixed camera, settle, steady-state window ──
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(0.0, 20.0, 1.5e7),
  });
  const settleA = await renderUntilSettled(600, 30);
  const steadyA = await measure(30);

  // ── Phase B: pan to a new tile set, expect spike, then settle ──
  const statsBeforePan = stats();
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(80.0, -10.0, 1.5e7),
  });
  const settleB = await renderUntilSettled(600, 30);
  const statsAfterPan = stats();
  const panCreates = statsAfterPan.creates - statsBeforePan.creates;
  const steadyB = await measure(30);

  window.__bindGroupProbe = { oncePostRender, stats, renderUntilSettled };
  return {
    settledA: settleA.settled,
    settledB: settleB.settled,
    steadyA,
    steadyB,
    panCreates,
  };
}

// ── Phase C: visual — globe present with imagery diversity ──
// Captured by the Node side between the two page steps, so the frame lands
// on the settled Phase-B view rather than a mid-flight low view.

/**
 * Page side, phase E, reusing phase A/B's helpers.
 *
 * @returns {Promise<object>} Phase E measurements and the cache's lifetime stats.
 */
async function pagePhaseE() {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const { oncePostRender, stats, renderUntilSettled } = window.__bindGroupProbe;

  // ── Phase E: SUSTAINED PANNING (NEW-GLOBE-DYNAMIC-OFFSET-UBO,
  //    Batch 292) — fly low and translate over the surface every frame
  //    so tiles stream in/out and the ring allocator hands out new byte
  //    offsets each frame. BEFORE the dynamic-offset conversion, group-0
  //    (camera+tile UB) bind groups were keyed on (buffer, OFFSET) and
  //    churned under this motion (~0.1-0.5/frame, spiking to 3+/frame).
  //    AFTER, group 0 is built once over the ring page and keyed on the
  //    page identity only, so group-0 creations during sustained motion
  //    stay ~0. Tracked via the per-group stats breakdown so legitimate
  //    group-1 (imagery view) churn from new tiles can't mask a group-0
  //    regression. Runs LAST so it doesn't disturb the Phase C visual.
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-122.4, 37.6, 250000.0),
  });
  await renderUntilSettled(600, 20);
  const panG0Before = stats();
  const PAN_FRAMES = 120;
  let maxGroup0PerFrame = 0;
  let panFramesWithGroup0 = 0;
  for (let i = 0; i < PAN_FRAMES; i++) {
    // Bounded back-and-forth so the camera stays over loaded terrain and
    // keeps streaming tiles (the offset-churn driver) rather than flying
    // off into space.
    const dir = i % 2 === 0 ? 1 : -1;
    v.camera.moveRight(6000.0 * dir);
    v.camera.twistRight(0.01);
    await oncePostRender();
    const s = stats();
    const g0f = s.lastFrameByGroup ? (s.lastFrameByGroup["0"] ?? 0) : 0;
    if (g0f > maxGroup0PerFrame) maxGroup0PerFrame = g0f;
    if (g0f > 0) panFramesWithGroup0++;
  }
  const panG0After = stats();
  const sustainedPanGroup0Creates =
    (panG0After.byGroup?.["0"] ?? 0) - (panG0Before.byGroup?.["0"] ?? 0);
  const sustainedPanGroup0PerFrame = sustainedPanGroup0Creates / PAN_FRAMES;
  // Group-1 (imagery) churn during the same window proves the motion
  // actually streamed tiles — otherwise the group-0 == 0 result would be
  // vacuous (a static scene trivially creates nothing).
  const sustainedPanGroup1Creates =
    (panG0After.byGroup?.["1"] ?? 0) - (panG0Before.byGroup?.["1"] ?? 0);

  return {
    sustainedPanGroup0Creates,
    sustainedPanGroup0PerFrame,
    sustainedPanGroup1Creates,
    maxGroup0PerFrame,
    panFramesWithGroup0,
    panFrames: PAN_FRAMES,
    cacheEntries: stats().entries,
    lifetime: stats(),
  };
}

/**
 * The five clauses over one run's cell, with the original bars.
 *
 * (A) steady-state creations ~0. Allow a hair of slack for a stray
 *     late-loading imagery tile, but the expected value is exactly 0.
 *     `requestsPerFrame > 10` guards against a vacuous pass — it proves the
 *     tile path was actively requesting bind groups during the window
 *     (pre-cache, every one of those requests was a create).
 * (B) pan spikes (new tiles MUST allocate new bind groups), then settles back
 *     to ~0.
 * (C) globe visually present: >8% non-black coverage + imagery color
 *     diversity (flat clear ≈ 1 bucket; imagery ≫ 100).
 * (D) zero console errors (incl. WebGPU validation errors).
 * (E) NEW-GLOBE-DYNAMIC-OFFSET-UBO — group-0 (camera+tile UB) bind-group
 *     creations during SUSTAINED panning must stay ~0. Pre-conversion this
 *     churned (~0.1-0.5/frame, spiking to 3+ in frames where tiles stream and
 *     the ring offsets shift). Post-conversion the group-0 bind group is built
 *     once per ring page and survives motion, so the creation total over 120
 *     panning frames is capped at ~pageCount (3). Threshold 8 leaves slack for
 *     the one-time per-page warmup if it lands inside the measured window, but
 *     the real value is ≤3. `sustainedPanGroup1Creates > 0` guards against a
 *     vacuous pass — it proves the motion actually streamed new tiles (the
 *     offset-churn driver). A static scene would trivially report 0 group-0
 *     creates.
 *
 * Pure and exported so `globe-probe-verdicts.spec.mjs` can drive it.
 *
 * @param {Array<object>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateBindGroupCache(cells) {
  const verdicts = [];
  for (const out of cells) {
    const suffix = `run${out.run}`;
    verdicts.push(
      {
        id: `steady-state-settles/${suffix}`,
        claim: `(A) steady-state @fixed camera: creates/frame=${out.steadyA.createsPerFrame.toFixed(3)} (requests/frame=${out.steadyA.requestsPerFrame.toFixed(1)}), window=${out.steadyA.frames}f, settled=${out.settledA} (<=0.5 creates, >10 requests)`,
        pass:
          out.settledA &&
          out.steadyA.createsPerFrame <= 0.5 &&
          out.steadyA.requestsPerFrame > 10,
        detail: { settled: out.settledA, steady: out.steadyA },
      },
      {
        id: `pan-spikes-then-resettles/${suffix}`,
        claim: `(B) pan: ${out.panCreates} creates during pan+load (>=10), re-settled creates/frame=${out.steadyB.createsPerFrame.toFixed(3)} (requests/frame=${out.steadyB.requestsPerFrame.toFixed(1)}), settled=${out.settledB}`,
        pass:
          out.settledB &&
          out.panCreates >= 10 &&
          out.steadyB.createsPerFrame <= 0.5 &&
          out.steadyB.requestsPerFrame > 10,
        detail: {
          settled: out.settledB,
          panCreates: out.panCreates,
          steady: out.steadyB,
        },
      },
      {
        id: `globe-visibly-rendered/${suffix}`,
        claim: `(C) visual: nonBlack=${(out.nonBlackPct * 100).toFixed(1)}% (>8%), colorBuckets=${out.colorBuckets} (>100)`,
        pass: out.nonBlackPct > 0.08 && out.colorBuckets > 100,
        detail: {
          nonBlackPct: out.nonBlackPct,
          colorBuckets: out.colorBuckets,
        },
      },
      {
        id: `console-errors/${suffix}`,
        claim: `(D) console errors: ${out.errors.length}`,
        pass: out.errors.length === 0,
        detail: { errors: out.errors.slice(0, 8) },
      },
      {
        id: `sustained-pan-group0-stays-cached/${suffix}`,
        claim: `(E) sustained-pan group-0 creates: ${out.sustainedPanGroup0Creates} over ${out.panFrames}f (<=8), group-1 churn=${out.sustainedPanGroup1Creates} (>0 proves tiles streamed)`,
        pass:
          out.sustainedPanGroup0Creates <= 8 &&
          out.sustainedPanGroup1Creates > 0,
        detail: {
          group0Creates: out.sustainedPanGroup0Creates,
          group0PerFrame: out.sustainedPanGroup0PerFrame,
          maxGroup0PerFrame: out.maxGroup0PerFrame,
          framesWithGroup0: out.panFramesWithGroup0,
          group1Creates: out.sustainedPanGroup1Creates,
        },
      },
    );
  }
  return verdicts;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "globe-bindgroup-cache",
  title:
    "NEW-GLOBE-BINDGROUP-CACHE — per-tile bind-group creations settle, spike on pan and re-settle",
  outputSubdirectory: "globe-bindgroup-cache",
  // No JSON receipt was banked before the migration.
  receiptEnvelope: "runtime",
  args: { defaults: { renderers: ["webgpu"] } },
  // The CesiumViewer page and every in-page import here read this module; the
  // cache counters are debug-pragma'd, which is why it is the unminified one.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the globe bind-group cache is a WebGPU renderer structure, so this " +
          `gate has nothing to measure on ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const context = await browser.newContext({
      viewport: { width: 1024, height: 768 },
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      await page.addInitScript(errorGateInit);
      await page.goto(
        `${origin}/Apps/CesiumViewer/index.html?renderer=webgpu`,
        {
          waitUntil: "networkidle",
        },
      );
      await page.waitForFunction(() => !!window.viewer);
      await armWebGPUDevices(page);

      const phasesAB = await page.evaluate(pagePhasesAB);
      // Header: the chrome comes off before the first frame, or the cell
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
      const settledPan = await captureElement({
        page,
        selector: SCENE_CANVAS,
        name: `bindgroup-cache-pan-view-run${run}`,
        outputDirectory,
        captures,
      });
      const visual = colourDiversity(decodePng(settledPan.buffer));
      const phaseE = await page.evaluate(pagePhaseE);
      await captureElement({
        page,
        selector: SCENE_CANVAS,
        name: `bindgroup-cache-after-sustained-pan-run${run}`,
        outputDirectory,
        captures,
      });
      const cell = {
        run,
        ...phasesAB,
        ...phaseE,
        nonBlackPct: visual.nonBlackFraction,
        colorBuckets: visual.colourBuckets,
        chromeRemoved: chrome.removed,
        errors: [...errors],
      };
      console.log(
        `    cache: entries=${cell.cacheEntries}, lifetime creates=${cell.lifetime.creates}, ` +
          `hits=${cell.lifetime.hits}, hitRate=${(cell.lifetime.hitRate * 100).toFixed(1)}%, ` +
          `group0 lifetime=${cell.lifetime.byGroup?.["0"] ?? "?"}`,
      );
      return [cell];
    } finally {
      await context.close();
    }
  },
  verdicts(cells) {
    return evaluateBindGroupCache(cells);
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
