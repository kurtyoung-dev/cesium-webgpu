#!/usr/bin/env node
// Probe (Batch 246 — NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT verify +
// regression gate): the globe must render on a device with WebGPU's
// DEFAULT limits — specifically `maxSampledTexturesPerShaderStage = 16`
// (the spec floor; what SwiftShader CI, compat-mode adapters, and
// low-end mobile report). The full globe terrain pipeline layout needs
// 28 fragment-stage sampled textures (16 imagery + 5 group-2 + 7
// globe effects); without the reduced-layout fallback, pipeline-layout
// creation fails validation and the globe never draws.
// @purpose Gates globe rendering on a device pinned to WebGPU default limits (16 sampled textures): reduced 4-slot imagery layout + multi-pass blend path
// @status ACTIVE
//
// The probe constructs its OWN CesiumWidget on a bare page (root
// index.html — no auto-created viewer, so the device pool's primary
// device is OURS) with `contextOptions.requiredLimits` pinning
// maxSampledTexturesPerShaderStage to the requested test tier (16 by default).
// Pinned limits are honored
// verbatim by the pool's negotiator (user-supplied values are never
// raised), so `device.limits.maxSampledTexturesPerShaderStage` reads
// exactly as requested — limit 16 is a true default-limit device on real hardware.
//
//   (A) LIMIT — the created device actually reports the forced limit of
//       16 (guards against the pool/negotiator silently raising it,
//       which would make every other check vacuous).
//   (B) FALLBACK — the globe surface renderer selected the reduced
//       4-slot imagery layout (`globalThis.__webgpuGlobeImagerySlotCount
//       === 4`, published by WebGPUGlobeSurfaceRenderer.initialize).
//   (C) RENDER — the globe is visually present: >8% non-black coverage
//       with imagery color diversity (offline NaturalEarthII base layer
//       — no network/Ion dependency; flat clear ≈ 1 color bucket,
//       imagery ≫ 100).
//   (D) MULTI-PASS — adding enough local GridImageryProvider layers to
//       exceed the selected tier by one exercises a two-pass blend path
//       (5 layers on the 4-slot tier, 17 on the 16-slot tier). The grid
//       lattice must change a visible fraction of
//       pixels vs the single-layer snap, and the scene must stay
//       non-black (a broken blend pass would either no-op or kill the
//       command buffer → black).
//   (E) zero console errors (incl. WebGPU validation errors — a bad
//       pipeline layout invalidates the whole pass).
//
// Standard-limit path (full 16-slot layout) is covered by
// probe-globe-bindgroup-cache.mjs + sandcastle-smoke.mjs — run those
// alongside this probe for any change near the globe layout.
//
// The two scenes are the rigs `globe-default-limits-16` and
// `globe-default-limits-16-overflow`.
//
// ON THE SHARED RUNTIME (probe-kit harvest, globe family). The browser, the
// origin (`--port`, a governed Edge port), the served-build preflight, the
// Edge slot and the receipt belong to `lib/probe-runtime.mjs`, and the tier is
// the `--texture-limit` flag (the `PROBE_TEXTURE_LIMIT` variable it replaces).
// Every pixel this probe reads — the two snaps and the centre-pixel "disk is
// visible" wait — is an element capture through `captureElement`, which asks
// the device-loss gate first; the in-page `drawImage` readbacks are gone. The
// widget is published as `window.__viewer` so the shared error gate can arm
// its device and the seam can read its frame number. (C)/(D)'s coverage and
// colour buckets are `colourDiversity`, the green shift is
// `channelExcessShift` and the changed fraction is `diffImages` at tolerance
// 24, all in Node and all held to the in-page loops by
// `metrics-globe-extraction.spec.mjs`.
//
// Usage: node Tools/visual-regression/probe-globe-default-limits.mjs [--port 8094] [--texture-limit 16]
//        (--texture-limit 64 exercises the full tier)
// Out:   Tools/visual-regression/output/globe-default-limits/
// @runtime lib/probe-runtime.mjs

import { decodePng } from "../lib/png-decode.mjs";
import { armWebGPUDevices, errorGateInit } from "../lib/webgpu-error-gate.mjs";
import { diffImages } from "./lib/image-diff.mjs";
import { channelExcessShift } from "./lib/metrics/channel-excess-shift.mjs";
import { colourDiversity } from "./lib/metrics/colour-diversity.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";

const SCENE_CANVAS = ".cesium-widget canvas";
/**
 * Bucket threshold note: the offline NaturalEarthII palette is softer than
 * the Ion world imagery used by probe-globe-bindgroup-cache (which asserts
 * >100). A composited NaturalEarthII globe measures ~300+ buckets at
 * 1024x768; the pre-imagery failure mode (atmosphere ring over a dark disk)
 * measures ~80. 150 splits the two cleanly.
 */
const BUCKETS_MIN = 150;
/** Frames between two disk-visibility polls, as the original stepped (5). */
const DISK_POLL_STEP = 5;
/** Frames the disk-visibility wait may spend, as the original capped (300). */
const DISK_POLL_FRAMES = 300;

/**
 * Page side: build the widget on the bare page with the pinned texture limit
 * and aim the camera. Unchanged from the in-page original apart from
 * publishing the widget for the gate and the seam.
 *
 * @param {number} textureLimit
 * @returns {Promise<{deviceLimit: number}>}
 */
async function pageSetupWidget(textureLimit) {
  const C = await import("/Build/CesiumUnminified/index.js");

  // The bare page has no widgets CSS — without the 100% rules the
  // cesium-widget canvas collapses to a ~150px strip and the readback
  // sees mostly background. Minimal inline replacement for
  // CesiumWidget.css's sizing rules.
  const style = document.createElement("style");
  style.textContent =
    ".cesium-widget, .cesium-widget canvas { width: 100%; height: 100%; display: block; }";
  document.head.appendChild(style);

  const div = document.createElement("div");
  div.style.cssText =
    "position:absolute;top:0;left:0;width:1024px;height:768px;";
  document.body.appendChild(div);

  // Offline imagery — ships in Build/CesiumUnminified/Assets; no network
  // or Ion token, so the probe is deterministic on CI.
  const baseLayer = C.ImageryLayer.fromProviderAsync(
    C.TileMapServiceImageryProvider.fromUrl(
      C.buildModuleUrl("Assets/Textures/NaturalEarthII"),
    ),
  );

  const widget = await C.CesiumWidget.createAsync(div, {
    contextOptions: {
      renderer: "webgpu",
      // Force the requested sampled-texture tier. User-pinned limits are
      // honored verbatim by WebGPUDevicePool._negotiate (never auto-raised).
      requiredLimits: {
        maxSampledTexturesPerShaderStage: textureLimit,
      },
    },
    baseLayer,
  });
  const scene = widget.scene;
  widget.clock.shouldAnimate = false;

  // (A) the device actually got the forced test limit.
  const device = scene.context._device ?? scene.context.device;
  const deviceLimit = device?.limits?.maxSampledTexturesPerShaderStage ?? -1;

  scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(0.0, 20.0, 1.8e7),
  });

  const frame = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  // Render until the globe settles (tilesLoaded streak) — capped so a
  // stuck tile pipeline fails loudly instead of hanging the probe.
  const renderUntilLoaded = async (maxFrames, streakNeeded) => {
    let streak = 0;
    for (let i = 0; i < maxFrames; i++) {
      await frame(1);
      const rendering = (scene.globe._surface?._tilesToRender?.length ?? 0) > 0;
      if (scene.globe.tilesLoaded && rendering) {
        streak++;
        if (streak >= streakNeeded) return true;
      } else {
        streak = 0;
      }
    }
    return false;
  };
  // Published for the shared error gate and the capture seam (both read
  // `window.__viewer`), and for the Node side's later page steps.
  window.__viewer = widget;
  window.__limitsProbe = { C, scene, frame, renderUntilLoaded };
  return { deviceLimit };
}

/**
 * Page side: add `count` local grid layers. With NaturalEarthII that forces
 * exactly one overflow layer on both the four-slot compatibility tier and the
 * sixteen-slot full tier, so a second blend pass must run.
 *
 * @param {number} count
 */
async function pageAddGridLayers(count) {
  const { C, scene } = window.__limitsProbe;
  for (let i = 0; i < count; i++) {
    scene.imageryLayers.addImageryProvider(
      new C.GridImageryProvider({ cells: 4 }),
    );
  }
}

/** The channel sum of a decoded frame's centre pixel (`floor(w/2), floor(h/2)`). */
function centrePixelSum(image) {
  const i =
    4 *
    (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2));
  return image.data[i] + image.data[i + 1] + image.data[i + 2];
}

/**
 * `tilesLoaded` reports the CPU-side imagery state machine; the WebGPU-side
 * texture upload + first composited frame can land a few frames later. Gate on
 * the actual canvas content: the globe disk is centered (camera looks at lon 0
 * / lat 20 from 18 Mm), so wait until the CENTER pixel carries imagery
 * brightness (channel sum > 90). Without this the snap races the upload and
 * captures the dark pre-imagery base color. Each poll renders one frame, reads
 * the frame through the seam, then renders four more, as the in-page original
 * stepped. The poll frame overwrites one file and stays out of the receipt's
 * capture list; the poll count is recorded instead.
 *
 * @returns {Promise<{visible: boolean, polls: number}>}
 */
async function renderUntilDiskVisible(page, pollName, outputDirectory) {
  let polls = 0;
  for (let i = 0; i < DISK_POLL_FRAMES; i += DISK_POLL_STEP) {
    await page.evaluate(() => window.__limitsProbe.frame(1));
    const shot = await captureElement({
      page,
      selector: SCENE_CANVAS,
      name: pollName,
      outputDirectory,
    });
    polls++;
    if (centrePixelSum(decodePng(shot.buffer)) > 90) {
      return { visible: true, polls };
    }
    await page.evaluate(() => window.__limitsProbe.frame(4));
  }
  return { visible: false, polls };
}

/**
 * The five clauses over one run's cell, with the original bars. (A) the
 * device got the forced limit; (B) the imagery layout matches the tier (4
 * slots below 28 sampled textures, 16 at or above); (C) the one-layer globe is
 * loaded, more than 8 % non-black and more than 150 colour buckets; (D) the
 * overflow globe is the same and its green excess rose by more than 2 — measured
 * ~3.8 on a compositing pass-2, while a silently-skipped blend pass measures ~0
 * (refinement noise is hue-neutral), so 2.0 splits; (E) no console error.
 *
 * Pure and exported so `globe-probe-verdicts.spec.mjs` can drive it.
 *
 * @param {Array<object>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateDefaultLimits(cells) {
  const verdicts = [];
  for (const out of cells) {
    const suffix = `run${out.run}`;
    const expectedSlots = out.textureLimit >= 28 ? 16 : 4;
    verdicts.push(
      {
        id: `forced-texture-limit/${suffix}`,
        claim: `(A) forced texture limit: maxSampledTexturesPerShaderStage=${out.deviceLimit} (expect ${out.textureLimit})`,
        pass: out.deviceLimit === out.textureLimit,
        detail: { deviceLimit: out.deviceLimit, expected: out.textureLimit },
      },
      {
        id: `imagery-layout-selected/${suffix}`,
        claim: `(B) imagery layout selected: imagerySlotCount=${out.slotCount} (expect ${expectedSlots})`,
        pass: out.slotCount === expectedSlots,
        detail: { slotCount: out.slotCount, expected: expectedSlots },
      },
      {
        id: `single-layer-renders/${suffix}`,
        claim: `(C) 1-layer render: loaded=${out.loaded1}, nonBlack=${(out.phase1.nonBlackPct * 100).toFixed(1)}% (>8%), colorBuckets=${out.phase1.colorBuckets} (>${BUCKETS_MIN})`,
        pass:
          out.loaded1 &&
          out.phase1.nonBlackPct > 0.08 &&
          out.phase1.colorBuckets > BUCKETS_MIN,
        detail: { loaded: out.loaded1, ...out.phase1 },
      },
      {
        id: `overflow-blend-pass-composites/${suffix}`,
        claim: `(D) ${out.slotCount + 1}-layer multi-pass: loaded=${out.loaded2}, nonBlack=${(out.phase2.nonBlackPct * 100).toFixed(1)}% (>8%), colorBuckets=${out.phase2.colorBuckets} (>${BUCKETS_MIN}), greenShift=${out.greenShift.toFixed(1)} (>2), changedPct=${(out.changedPct * 100).toFixed(2)}%`,
        pass:
          out.loaded2 &&
          out.phase2.nonBlackPct > 0.08 &&
          out.phase2.colorBuckets > BUCKETS_MIN &&
          out.greenShift > 2,
        detail: {
          loaded: out.loaded2,
          ...out.phase2,
          greenShift: out.greenShift,
          changedPct: out.changedPct,
        },
      },
      {
        id: `console-errors/${suffix}`,
        claim: `(E) console errors: ${out.errors.length}`,
        pass: out.errors.length === 0,
        detail: { errors: out.errors.slice(0, 8) },
      },
    );
  }
  return verdicts;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "globe-default-limits",
  title:
    "NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT — the globe on a device pinned to the default sampled-texture limit",
  outputSubdirectory: "globe-default-limits",
  // No JSON receipt was banked before the migration.
  receiptEnvelope: "runtime",
  args: {
    defaults: { renderers: ["webgpu"] },
    extraOptions: [
      {
        flag: "--texture-limit",
        key: "textureLimit",
        kind: "positive-integer",
        default: 16,
      },
    ],
  },
  // The bare page imports this module to build its own widget.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the reduced imagery layout is the WebGPU globe's default-limit path, " +
          `so this gate has nothing to measure on ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const limit = options.textureLimit;
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
      // Bare page — MUST NOT auto-create a viewer. The device pool shares its
      // primary device with any compatible later acquire; if a default-options
      // viewer ran first, its 64-texture negotiated device would satisfy our
      // "≥16" requirement and the forced-default-limit device would never be
      // created.
      await page.goto(`${origin}/index.html`, {
        waitUntil: "domcontentloaded",
      });
      const { deviceLimit } = await page.evaluate(pageSetupWidget, limit);
      await armWebGPUDevices(page);

      const loadPhase = async (label) => {
        const loaded = await page.evaluate(() =>
          window.__limitsProbe.renderUntilLoaded(900, 20),
        );
        // The original short-circuited: no disk poll when tiles never loaded.
        const disk = loaded
          ? await renderUntilDiskVisible(
              page,
              `globe-limit-${limit}-${label}-readiness-poll-run${run}`,
              outputDirectory,
            )
          : { visible: false, polls: 0 };
        return { loaded: loaded && disk.visible, polls: disk.polls };
      };

      // ── Phase 1: single imagery layer on the reduced layout ──
      const phase1Load = await loadPhase("1layer");
      const snap1 = await captureElement({
        page,
        selector: SCENE_CANVAS,
        name: `globe-limit-${limit}-1layer-run${run}`,
        outputDirectory,
        captures,
      });
      const slotCount = await page.evaluate(
        () => globalThis.__webgpuGlobeImagerySlotCount ?? -1,
      );

      // ── Phase 2: slotCount+1 total layers → a two-pass blend path ──
      await page.evaluate(pageAddGridLayers, slotCount);
      const phase2Load = await loadPhase(`${slotCount + 1}layer`);
      const snap2 = await captureElement({
        page,
        selector: SCENE_CANVAS,
        name: `globe-limit-${limit}-${slotCount + 1}layer-run${run}`,
        outputDirectory,
        captures,
      });

      // Pixel diff between the two phases — the grid layers, including the
      // second (blend) pass, must actually land on screen. changedPct is the
      // raw fraction of pixels that moved (informational — it also picks up
      // tile-refinement noise between snaps); greenShift is the mean
      // green-excess change over pixels lit in both phases, which rises if
      // (and only if) the grid's rgba(0, 0.5, 0, 0.2) background wash was
      // composited by the second pass.
      const img1 = decodePng(snap1.buffer);
      const img2 = decodePng(snap2.buffer);
      const toPhase = (image) => {
        const m = colourDiversity(image);
        return {
          nonBlackPct: m.nonBlackFraction,
          colorBuckets: m.colourBuckets,
        };
      };
      return [
        {
          run,
          textureLimit: limit,
          deviceLimit,
          slotCount,
          loaded1: phase1Load.loaded,
          loaded2: phase2Load.loaded,
          diskPolls: [phase1Load.polls, phase2Load.polls],
          phase1: toPhase(img1),
          phase2: toPhase(img2),
          changedPct:
            diffImages(img1, img2, { tolerance: 24 }).changedPx /
            (img1.width * img1.height),
          greenShift: channelExcessShift(img1, img2).shift,
          errors: [...errors],
        },
      ];
    } finally {
      await context.close();
    }
  },
  verdicts(cells) {
    return evaluateDefaultLimits(cells);
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
