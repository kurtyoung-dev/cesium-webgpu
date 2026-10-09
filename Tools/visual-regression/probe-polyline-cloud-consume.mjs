#!/usr/bin/env node
// Probe (NEW-DIRTY-CONSUME-POLYLINE + NEW-DIRTY-CONSUME-CLOUD verify): after the
// Phase-0 dirty-consume fix, a STATIC PolylineCollection and a STATIC
// CloudCollection must stop re-touching their primitives every frame on the
// WebGPU path, with queues drained — while polylines still render.
// @purpose Gate: static Polyline/CloudCollections stop re-touching primitives per frame (dirty-consume); tripwire for the cloud scene-FB MSAA mismatch
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// Render assertions:
//  - Polyline: asserted at the known-good view (1.5 Mm camera, surface
//    polylines — the configuration verified rendering in
//    probe-collections-2dcv-morph.mjs).
//  - Cloud: render reported informationally (not asserted — the white-ish
//    pixel heuristic can include imagery). Cloud consume is verified via the
//    dirty-call counter + queue drain. NOTE: this probe originally found
//    NEW-CLOUD-SCENEFB-PIPELINE-MISMATCH — the cloud pipeline missed the
//    scene-FB MSAA sample count, and the resulting validation error killed
//    the WHOLE pass (adding one cloud blanked every primitive in the scene,
//    confirmed pre-existing at HEAD). Fixed in the same batch (multisample
//    baked into the cloud pipeline descriptor); the error filter below is
//    kept as a regression tripwire.
//
// WHAT THE FILTER DOES, MEASURED FROM THE CODE. The filter EXCLUDES console
// errors matching /CloudCollection pipeline/ from the error clause, so a
// recurrence that prints that message is admitted rather than tripped; what
// still trips a recurrence that blanks the pass is the polyline render clause
// (cyan > 100). The harvest keeps the filter exactly as it was.
//
// It is a standing guard for the Batch 228 dirty-consume
// (`DEBUGGING_GUIDE.md`), WebGPU only, and the G7 cluster of
// `CAMPAIGN11_EXECUTION_GUIDE` lists it in C11-73's verification recipe. Its
// globe loads imagery from the network, which puts it in `DEFERRED_WORK.md`'s
// network-globe shape-sweep inventory (`C13-WEATHER-PROBE-FLEET-SHAPE-SWEEP`
// §5).
//
// ON THE SHARED RUNTIME (probe-kit harvest, polyline family, DX-108). The
// browser, the origin (`--port`, a governed Edge port — the original defaulted
// to 8134), the served-build preflight, the Edge slot, the lifecycle deadline
// and the receipt belong to `lib/probe-runtime.mjs`. The scene is the rig
// `polyline-cloud-consume`, built in the page from its data; the dirty-call
// counters and the queue reads stay in the page, unchanged. The render check
// is an element capture of the scene canvas through `captureElement`, taken
// after `lib/strip-viewer-widgets.mjs` has removed the viewer chrome that
// otherwise sits inside the canvas's rectangle (a run with chrome left over
// the canvas refuses), with the cyan and cloud-white counts made by
// `maskCount` (`lib/metrics/colour-mask.mjs`) over the decoded PNG, where the
// original read the live canvas through `drawImage` inside the page. Console
// errors are collected with `Tools/lib/attach-page-diagnostics.mjs`.
//
// Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
//        node Tools/visual-regression/probe-polyline-cloud-consume.mjs
// Out:   Tools/visual-regression/output/polyline-cloud-consume/

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
import rig from "./rigs/polyline-cloud-consume.mjs";

/** The scene this probe builds. */
export const RIG = rig;

/** The polylines' colour class: `g > 150 && b > 150 && r < 120`. */
export const CYAN = channelThresholds({
  gAbove: 150,
  bAbove: 150,
  rBelow: 120,
});

/**
 * The informational cloud class: near-grey white, `r, g, b > 140 && |r - b| <
 * 30`. It cannot overlap the cyan class (cyan needs `r < 120`), so counting
 * the two independently is the original's `if … else if`.
 */
export const CLOUDISH = (r, g, b) =>
  r > 140 && g > 140 && b > 140 && Math.abs(r - b) < 30;

/** The console noise the probe has always admitted. */
export const KNOWN_NOISE = /CloudCollection pipeline/;

/** The canvas the scene draws into; the CesiumViewer page has exactly one. */
const SCENE_CANVAS = ".cesium-widget canvas";

/**
 * A bound on the run's work: page load and the wait for `window.viewer` (30 s
 * each, Playwright's defaults, which the original relied on), the settle,
 * count and moved frames (at most half a second a frame) and the capture
 * (30 s). Not a measurement — a ceiling past which the lifecycle stops the run
 * (the original had no watchdog at all).
 */
const RUN_BUDGET_MS =
  30_000 +
  30_000 +
  (rig.dials.settleFrames + rig.dials.countFrames + 1) * 500 +
  30_000;

/**
 * Builds the rig's scene, settles it, counts per-primitive dirty calls over
 * the counting frames, reads the queues, then moves one polyline and counts
 * its re-enqueue — the original's page-side instrument, unchanged but for the
 * constants arriving in `scene`. It measures no pixels; the render check is
 * read in Node from the capture.
 *
 * @param {object} page Playwright page.
 * @returns {Promise<object>} The counters.
 */
async function measureConsume(page) {
  return page.evaluate(async (scene) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      s = v.scene;

    // Known-good polyline configuration (matches probe-collections-2dcv-morph):
    // surface polylines spanning degrees, camera at 1.5 Mm looking down.
    const LON = scene.anchor.lon,
      LAT = scene.anchor.lat;
    const pl = scene.polylines;
    const pls = s.primitives.add(new C.PolylineCollection());
    for (let i = 0; i < pl.count; i++) {
      const lat = LAT + pl.firstLatOffsetDegrees + i * pl.latStepDegrees;
      pls.add({
        positions: [
          C.Cartesian3.fromDegrees(LON - pl.halfSpanDegrees, lat, 0.0),
          C.Cartesian3.fromDegrees(LON + pl.halfSpanDegrees, lat, 0.0),
        ],
        width: pl.width,
        material: C.Material.fromType("Color", { color: C.Color[pl.color] }),
      });
    }
    const cl = scene.clouds;
    const clouds = s.primitives.add(new C.CloudCollection());
    for (let i = 0; i < cl.count; i++) {
      clouds.add({
        position: C.Cartesian3.fromDegrees(
          LON + i * cl.lonStepDegrees,
          LAT + cl.latOffsetDegrees,
          cl.heightMetres,
        ),
        scale: new C.Cartesian2(...cl.scaleMetres),
      });
    }
    s.morphTo3D(0);
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        LON,
        LAT,
        scene.setViewHeightMetres,
      ),
    });
    for (let i = 0; i < scene.settleFrames; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Count per-primitive dirty calls over the settled counting frames.
    let plCalls = 0;
    let cloudCalls = 0;
    const origPl = pls._updatePolyline.bind(pls);
    const origCloud = clouds._updateCloud.bind(clouds);
    pls._updatePolyline = function (p, prop) {
      plCalls++;
      return origPl(p, prop);
    };
    clouds._updateCloud = function (c, prop) {
      cloudCalls++;
      return origCloud(c, prop);
    };
    for (let i = 0; i < scene.countFrames; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    pls._updatePolyline = origPl;
    clouds._updateCloud = origCloud;

    // Queue-leak check: the toUpdate queues must be drained, not growing.
    const plQueue = pls._polylinesToUpdate.length;
    const cloudQueue = clouds._cloudsToUpdateIndex;

    // Moving-polyline correctness: change one polyline; it must re-enqueue
    // (the consume must re-ARM dirty tracking, not freeze it).
    let movingCalls = 0;
    pls._updatePolyline = function (p, prop) {
      movingCalls++;
      return origPl(p, prop);
    };
    const pl0 = pls.get(0);
    pl0.width = scene.movedWidth;
    s.render();
    await new Promise((r) => requestAnimationFrame(r));
    pls._updatePolyline = origPl;

    return {
      plCallsPerFrame: plCalls / scene.countFrames,
      cloudCallsPerFrame: cloudCalls / scene.countFrames,
      plQueue,
      cloudQueue,
      movingCalls,
    };
  }, rig.dials);
}

/**
 * The probe's six clauses over one run — pure and exported so
 * `polyline-probe-verdicts.spec.mjs` can drive it. The cloud-white count is
 * reported in the detail and never verdicted, as before.
 *
 * @param {{out: object, errors: string[]}} run One run's counters, counts and console errors.
 * @returns {Array<{id: string, claim: string, pass: boolean, detail: object}>} Verdicts.
 */
export function evaluateCloudConsume({ out, errors }) {
  // Pre-existing cloud scene-FB pipeline mismatch is allowed in console errors;
  // everything else fails the probe.
  const realErrors = errors.filter((e) => !KNOWN_NOISE.test(e));
  return [
    {
      id: "polyline-settled",
      claim: `polyline _updatePolyline/frame: ${out.plCallsPerFrame} < 1`,
      pass: out.plCallsPerFrame < 1,
      detail: { plCallsPerFrame: out.plCallsPerFrame },
    },
    {
      id: "cloud-settled",
      claim: `cloud _updateCloud/frame: ${out.cloudCallsPerFrame} < 1`,
      pass: out.cloudCallsPerFrame < 1,
      detail: { cloudCallsPerFrame: out.cloudCallsPerFrame },
    },
    {
      id: "queues-drained",
      claim: `queues drained: pl=${out.plQueue} cloud=${out.cloudQueue}`,
      pass: out.plQueue === 0 && out.cloudQueue === 0,
      detail: { plQueue: out.plQueue, cloudQueue: out.cloudQueue },
    },
    {
      id: "moved-polyline-reenqueues",
      claim: `modified polyline re-enqueues: ${out.movingCalls} >= 1`,
      pass: out.movingCalls >= 1,
      detail: { movingCalls: out.movingCalls },
    },
    {
      id: "polyline-renders",
      claim: `renders: polyline(cyan)=${out.cyan} > 100 | clouds(white)=${out.cloudish} (informational)`,
      pass: out.cyan > 100,
      detail: { cyan: out.cyan, cloudish: out.cloudish },
    },
    {
      id: "no-non-cloud-errors",
      claim: `console errors: ${errors.length} total, ${realErrors.length} non-cloud`,
      pass: realErrors.length === 0,
      detail: { errors: realErrors.slice(0, 5).map((e) => e.slice(0, 160)) },
    },
  ];
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "polyline-cloud-consume",
  title:
    "NEW-DIRTY-CONSUME-POLYLINE + NEW-DIRTY-CONSUME-CLOUD — static collections stop re-touching",
  outputSubdirectory: "polyline-cloud-consume",
  // No JSON receipt was banked before the migration.
  receiptEnvelope: "runtime",
  // The CesiumViewer page and the in-page import both read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  workBudgetMs: () => RUN_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        `the dirty-consume counters are read on the WebGPU path only (got ${options.renderers.join(",")})`,
        { renderers: options.renderers },
      );
    }
    const context = await browser.newContext({
      viewport: { ...rig.viewport },
    });
    try {
      const page = await context.newPage();
      const diagnostics = attachPageDiagnostics(page, {
        filter: (record) => record.type === "error",
      });
      await page.goto(
        `${origin}/Apps/CesiumViewer/index.html?renderer=webgpu`,
        {
          waitUntil: "networkidle",
        },
      );
      await page.waitForFunction(() => !!window.viewer);
      const strip = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
      if (strip.leftovers.length > 0) {
        throw new ProbeRefusal(
          "viewer-chrome-over-canvas",
          `${rig.id}: elements still overlap the scene canvas after the widget strip (${strip.leftovers.join(", ")}), so an element capture would score them`,
          { rig: rig.id, ...strip },
        );
      }

      const counters = await measureConsume(page);
      // Render check, read from the frame after the moved polyline rendered.
      const shot = await captureElement({
        page,
        selector: SCENE_CANVAS,
        name: `polyline-cloud-consume-webgpu-run${run}`,
        outputDirectory,
        captures,
      });
      const image = decodePng(shot.buffer);
      const out = {
        ...counters,
        cyan: maskCount(image, CYAN),
        cloudish: maskCount(image, CLOUDISH),
      };
      const errors = diagnostics.console.map((record) => record.text);
      return [{ run, out, errors, widgetsRemoved: strip.removed }];
    } finally {
      await context.close();
    }
  },
  verdicts(cells) {
    return cells.flatMap((cell) =>
      evaluateCloudConsume(cell).map((verdict) => ({
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
