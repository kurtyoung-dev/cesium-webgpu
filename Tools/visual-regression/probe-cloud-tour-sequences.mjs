#!/usr/bin/env node
/**
 * C13-01 — the fixture/sequence tour with complete per-sequence metrics.
 * @purpose C13-01 evidence tail: fixture camera tours (OFF/ON cloud deltas per station) plus temporal-reset sequences with CPU/GPU metrics.
 * @status ACTIVE
 *
 * This is the executable half of the C13-01 evidence tail. The DEFINITIONS live
 * in `lib/cloud-tour-fixtures.mjs` and the METRICS in `lib/cloud-tour-metrics.mjs`,
 * both pure and both exercised by `cloud-tour-sequences.spec.mjs` under
 * `node --test`. This file only drives Edge and records what happened.
 *
 * It does NOT replace `probe-cloud-tour.mjs` (the static scene tour) or
 * `probe-cloud-planetary.mjs` (the moving OFF/ON planetary oracle, C13-03 green
 * at 21/21). It adds the three things the C13-01 ledger row still lists as
 * outstanding: climate/region/type/same-type fixtures, wind/time and
 * temporal-reset sequences, and complete per-sequence metrics including GPU
 * timing.
 *
 * TWO LANES
 * ---------
 *   fixtures   Each fixture's camera stations are visited IN ORDER with
 *              interpolated transitions, so altitude transitions, dateline
 *              crossings and pole approaches happen as motion rather than as
 *              disconnected teleports. At each station the same camera and the
 *              same pinned instant are rendered with volumetric clouds OFF and
 *              then ON; the delta is the cloud contribution. A bright-pixel
 *              count is NOT used as the visibility oracle — physically lit polar
 *              or low-sun cloud is strongly coloured and a neutral-pixel rule
 *              rejects it.
 *   sequences  Wind/time advancement (three lanes one variable apart), camera
 *              teleport, the history-reset taxonomy, and the pan-and-return
 *              ghost oracle. Each sequence gets its OWN PAGE: these assert
 *              temporal history reset semantics, and a reused page would carry
 *              an already-initialized history into a sequence whose first
 *              assertion is about initialization.
 *
 * DETERMINISM
 * -----------
 *   - Every render goes through `renderNow()` from the canonical same-task
 *     capture block, which renders the instant returned by the probe's own time
 *     function. That instant is either the fixture's pinned ISO or that ISO plus
 *     a FIXED number of seconds per frame from a FIXED frame schedule. Wall time
 *     never reaches the renderer.
 *   - `viewer.useDefaultRenderLoop` is false and `scene.requestRenderMode` is
 *     false, so the only frames that exist are the ones this probe asked for.
 *   - Camera poses are absolute. A phase that returns to a station sets that
 *     station's absolute pose rather than undoing a relative motion.
 *   - Every loop has a constant bound. The watchdog is sized from
 *     `sequenceFrameBudget`, so it can only fire on a driver hang.
 *
 * WHY CAPTURED FRAMES ARE EXCLUDED FROM THE CPU DISTRIBUTION
 * ----------------------------------------------------------
 * A same-task capture freezes a PNG inside the render task, which costs real
 * milliseconds. Including those frames would inflate the CPU distribution by an
 * artifact of measurement. The record reports `cpuFrames.count` alongside
 * `cpuFrames.excludedCaptureFrames` so the exclusion is visible rather than
 * silent.
 *
 * GPU TIMING
 * ----------
 * C13-39 landed byte-inert `timestampWrites` on all seven cloud passes plus the
 * environment Sky Fill. This probe arms `CesiumDebug.gpuPassCost(true)` around
 * each sequence's measured window and records the per-pass result, INCLUDING the
 * profiler's own health counters and a `present: false` marker for any declared
 * pass the profiler never saw.
 *
 * A single run is CHARACTERIZATION. Turning it into an A/B requires the
 * interleaved protocol, which `assessInterleavedAb` enforces:
 *   1. Build BOTH bundles once, keep them side by side, never rebuild mid-session.
 *   2. Alternate within ONE session: pre, post, pre, post — minutes apart.
 *   3. At least TWO rounds, at least one of them in REVERSE order.
 *   4. Discard — do not interpret — a round whose control passes moved.
 * Set `TOUR_PAIR_ID`, `TOUR_TAG`, `TOUR_ROUND` and `TOUR_ORDER` so the assessment
 * can see the interleave; with a pair id the probe reads every manifest for that
 * pair and prints the protocol status.
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-tour-sequences.mjs
 *   TOUR_LANES=fixtures node Tools/visual-regression/probe-cloud-tour-sequences.mjs
 *   TOUR_FIXTURES=plains-fairweather-cumulus,sahara-clear-sky node ...
 *   TOUR_SEQUENCE_IDS=wind-time-advection node ...
 *   TOUR_PAIR_ID=2026-08-01-c13-01 TOUR_TAG=pre TOUR_ROUND=0 TOUR_ORDER=pre-first node ...
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";

import { chromium } from "playwright";
import sharp from "sharp";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";
import {
  CLOUD_TOUR_FIXTURES,
  CLOUD_TOUR_SCHEMA_VERSION,
  CLOUD_TOUR_SEQUENCES,
  fixtureById,
  fixtureClockIso,
  fixtureReplaySubset,
  replayKeyFor,
  sequenceFrameBudget,
  sequenceReplaySubset,
  summarizeFixtureCoverage,
  validateFixtureSet,
  validateSequenceSet,
} from "./lib/cloud-tour-fixtures.mjs";
import {
  SEQUENCE_MANIFEST_VERSION,
  assessInterleavedAb,
  assessPhaseReset,
  deriveCloudTier,
  frameDistribution,
  framewiseDeltaSeries,
  ghostMetrics,
  imageDeltaMetrics,
  parseControlPasses,
  summarizeGpuPasses,
  validateSequenceMetricRecord,
} from "./lib/cloud-tour-metrics.mjs";

// ── Definition sanity BEFORE a browser is launched ────────────────────────
// The tables are validated by `cloud-tour-sequences.spec.mjs`, but a probe that
// trusts its own inputs is one edit away from spending an Edge cycle to
// discover a typo. This costs microseconds.
{
  const failures = [...validateFixtureSet(), ...validateSequenceSet()];
  if (failures.length > 0) {
    console.error("[cloud-tour-seq] DEFINITION FAILURES:");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(2);
  }
}

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output/cloud-tour-sequences";
const TAG = process.env.TOUR_TAG || "pre";
const PAIR_ID = process.env.TOUR_PAIR_ID || null;
const ROUND = Number.parseInt(process.env.TOUR_ROUND ?? "0", 10);
const ORDER = process.env.TOUR_ORDER || "pre-first";
const W = Number.parseInt(process.env.TOUR_WIDTH ?? "1024", 10);
const H = Number.parseInt(process.env.TOUR_HEIGHT ?? "768", 10);
const LANES = (process.env.TOUR_LANES || "fixtures,sequences")
  .split(",")
  .map((lane) => lane.trim())
  .filter(Boolean);
const ONLY_FIXTURES = (process.env.TOUR_FIXTURES || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const ONLY_SEQUENCES = (process.env.TOUR_SEQUENCE_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

/** Frames rendered between two persisted/decoded captures inside a phase. */
const CAPTURE_STRIDE = Math.max(
  1,
  Number.parseInt(process.env.TOUR_CAPTURE_STRIDE ?? "8", 10),
);
/** Interpolated frames between two fixture stations. */
const TRANSITION_FRAMES = 12;
/** Frames held at a station before its OFF/ON pair. */
const STATION_SETTLE_FRAMES = 8;
/** Frames rendered after toggling volumetric off/on inside a station pair. */
const TOGGLE_SETTLE_FRAMES = 3;
/** Bounded readiness: the render-measure-check loop's deadline. */
const OCCUPANCY_MAX_FRAMES = 300;

// DRIFT CONTROLS for the interleaved A/B live in `lib/cloud-tour-metrics.mjs`
// (`defaultControlPasses` / `parseControlPasses`) so the spec can exercise the
// default and the override parser directly. Override with, for example:
//   TOUR_CONTROL_PASSES="wind-time-advection:CloudUpscale composite pass"

if (!["pre", "post"].includes(TAG)) {
  throw new Error("TOUR_TAG must be pre or post");
}
if (!["pre-first", "post-first"].includes(ORDER)) {
  throw new Error("TOUR_ORDER must be pre-first or post-first");
}
if (!Number.isInteger(ROUND) || ROUND < 0) {
  throw new Error("TOUR_ROUND must be a non-negative integer");
}
for (const lane of LANES) {
  if (!["fixtures", "sequences"].includes(lane)) {
    throw new Error(`Unknown TOUR_LANES entry ${lane}`);
  }
}

const selectedFixtures = ONLY_FIXTURES.length
  ? CLOUD_TOUR_FIXTURES.filter((fixture) => ONLY_FIXTURES.includes(fixture.id))
  : CLOUD_TOUR_FIXTURES;
const selectedSequences = ONLY_SEQUENCES.length
  ? CLOUD_TOUR_SEQUENCES.filter((sequence) =>
      ONLY_SEQUENCES.includes(sequence.id),
    )
  : CLOUD_TOUR_SEQUENCES;
{
  const unknownFixtures = ONLY_FIXTURES.filter(
    (id) => !CLOUD_TOUR_FIXTURES.some((fixture) => fixture.id === id),
  );
  const unknownSequences = ONLY_SEQUENCES.filter(
    (id) => !CLOUD_TOUR_SEQUENCES.some((sequence) => sequence.id === id),
  );
  if (unknownFixtures.length || unknownSequences.length) {
    throw new Error(
      `Unknown selection: ${[...unknownFixtures, ...unknownSequences].join(", ")}`,
    );
  }
}

// ── HARD watchdog: force-exit if anything hangs (machine safety) ──
// Sized from the DECLARED frame budgets plus page boot and readiness, so it is
// a constant derived from the tables rather than a guess. Every loop in this
// file has a constant bound, so the watchdog can only fire on a GPU/driver
// hang. Unref'd so it never keeps an otherwise-finished process alive.
const FRAME_BUDGET =
  selectedFixtures.reduce(
    (total, fixture) =>
      total +
      fixture.stations.length *
        (TRANSITION_FRAMES +
          STATION_SETTLE_FRAMES +
          2 * TOGGLE_SETTLE_FRAMES +
          2),
    0,
  ) +
  selectedSequences.reduce(
    (total, sequence) =>
      total + sequenceFrameBudget(sequence) + OCCUPANCY_MAX_FRAMES,
    0,
  );
const HARD_LIMIT_MS = Math.min(
  2_400_000,
  180_000 + FRAME_BUDGET * 120 + (selectedSequences.length + 1) * 90_000,
);
const watchdog = setTimeout(() => {
  console.error(
    `[cloud-tour-seq] WATCHDOG FIRED (${Math.round(HARD_LIMIT_MS / 1000)}s) — forcing exit`,
  );
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

// ── Node-side helpers ─────────────────────────────────────────────────────

function command(name, args) {
  try {
    return execFileSync(name, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function pngBufferFromDataUrl(dataUrl) {
  return Buffer.from(String(dataUrl).split(",")[1] ?? "", "base64");
}

/**
 * Decode a captured PNG to raw RGBA. The PNG is the immutable same-task
 * snapshot, so the metric and the saved artifact have the SAME source — a
 * screenshot and a number that disagree is a class of bug this avoids by
 * construction.
 */
async function decodeRgba(dataUrl) {
  const buffer = pngBufferFromDataUrl(dataUrl);
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, buffer };
}

function writePng(relativePath, dataUrl) {
  const buffer = pngBufferFromDataUrl(dataUrl);
  fs.writeFileSync(relativePath, buffer);
  return {
    path: relativePath,
    byteLength: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

const HIDE_CHROME = `
  #rendererToolbar,
  .cesium-viewer-toolbar,
  .cesium-viewer-animationContainer,
  .cesium-viewer-timelineContainer,
  .cesium-viewer-fullscreenContainer,
  .cesium-viewer-bottom,
  .cesium-navigation-help {
    display: none !important;
  }
`;

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const consoleErrors = attachConsoleErrorGate(page);
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) =>
    pageErrors.push(`pageerror: ${error.message}`),
  );
  await page.addInitScript(errorGateInit);
  await installCloudProbeHarnessOnPage(page);
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
    { waitUntil: "networkidle", timeout: 90_000 },
  );
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 90_000 });
  const armState = await armWebGPUDevices(page);
  await page.addStyleTag({ content: HIDE_CHROME });
  return { page, consoleErrors, pageErrors, armState };
}

async function closeGate(page, context) {
  const gate = await collectGateErrors(page);
  return [
    ...new Set([
      ...context.pageErrors,
      ...context.consoleErrors,
      ...(gate.errors ?? []),
      ...(gate.deviceLost ? [gate.deviceLost] : []),
      ...(context.armState.found < 1
        ? ["WebGPU error gate did not find a device"]
        : []),
    ]),
  ].filter(
    (error) =>
      !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon/i.test(error),
  );
}

// ── Browser-side: install the shared tour context ─────────────────────────
//
// Everything the phases need lives on `globalThis.__cloudTour` so it survives
// across separate `page.evaluate` calls (a Node closure does not cross that
// boundary — the phase runner is deliberately one evaluate per phase so the
// Node side can apply a viewport change between phases).

const INSTALL_TOUR = async (input) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  scene.requestRenderMode = false;
  scene.globe.show = true;
  scene.skyBox.show = true;
  scene.sun.show = true;
  scene.skyAtmosphere.show = true;
  scene.backgroundColor = C.Color.BLACK;

  const baseTime = C.JulianDate.fromIso8601(input.baseIso);
  viewer.clock.currentTime = baseTime;

  // SAME-TASK CAPTURE. The canonical source is checked byte-for-byte by
  // cloud-tour-sequences.spec.mjs. Never place a GPU-canvas read after a
  // browser-task yield: WebGL can clear it and WebGPU can invalidate it.
  // ==BEGIN same-task-capture==
  const makeSameTaskCapture = (scene, canvas, timeFn) => {
    const renderNow = () => scene.render(timeFn());
    const tmp = document.createElement("canvas");
    const ctx = tmp.getContext("2d", { willReadFrequently: true });
    const decodeSnapshot = async (snapshot) => {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        const decodeFailed = "same-task PNG decode failed";
        image.onload = resolve;
        image.onerror = () => reject(new Error(decodeFailed));
      });
      image.src = snapshot;
      await loaded;
      tmp.width = image.naturalWidth;
      tmp.height = image.naturalHeight;
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, tmp.width, tmp.height);
    };
    const snapshotNow = () => {
      renderNow();
      return canvas.toDataURL("image/png");
    };
    const captureNow = () => {
      const snapshot = snapshotNow();
      return decodeSnapshot(snapshot);
    };
    const grabNow = snapshotNow;
    const settleThen = async (maxFrames, done, capture) => {
      let settled = false;
      for (let k = 0; k < maxFrames; k++) {
        if (typeof done === "function" && done() === true) {
          settled = true;
          break;
        }
        renderNow();
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (!settled && typeof done === "function") {
        settled = done() === true;
      }
      const hasCapture = typeof capture === "function";
      const result = hasCapture ? await capture() : undefined;
      return { settled, result };
    };
    return { renderNow, captureNow, grabNow, settleThen };
  };
  // ==END same-task-capture==

  const state = {
    C,
    viewer,
    scene,
    baseIso: input.baseIso,
    baseTime,
    // Frame index the clock walk is measured from. Advanced by the phase
    // runner from a FIXED schedule, never from how long anything took.
    frameIndex: 0,
    stepSeconds: input.stepSeconds ?? 0,
    currentTime: baseTime,
  };
  state.timeFn = () => state.currentTime;
  state.advance = () => {
    state.frameIndex++;
    if (state.stepSeconds > 0) {
      state.currentTime = C.JulianDate.addSeconds(
        state.baseTime,
        state.frameIndex * state.stepSeconds,
        new C.JulianDate(),
      );
    }
  };
  const capture = makeSameTaskCapture(scene, scene.canvas, state.timeFn);
  state.renderNow = capture.renderNow;
  state.grabNow = capture.grabNow;
  state.captureNow = capture.captureNow;
  state.settleThen = capture.settleThen;
  // Mean luminance over an ImageData produced by `captureNow`. Reads the
  // decoded IMMUTABLE snapshot, never the live GPU canvas.
  state.meanLuminance = (image) => {
    const pixels = image?.data;
    if (!pixels || pixels.length === 0) {
      return null;
    }
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    }
    return sum / (pixels.length / 4);
  };

  state.setView = (view) => {
    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      orientation: {
        heading: C.Math.toRadians(view.heading),
        pitch: C.Math.toRadians(view.pitch),
        roll: 0,
      },
    });
  };
  state.cacheSnapshot = () => {
    const cache = scene.context?._cloudCache;
    const uniforms = cache?.uniformData;
    return {
      present: !!cache,
      initialized: cache?.initialized === true,
      pipelineReady: cache?.pipeline !== null && cache?.pipeline !== undefined,
      maxSteps: uniforms?.[44] ?? null,
      lightSteps: uniforms?.[45] ?? null,
      qualityFlags:
        uniforms?.[74] === undefined ? null : Math.trunc(uniforms[74]),
      currentTarget: {
        width: cache?.halfWidth || scene.canvas.width,
        height: cache?.halfHeight || scene.canvas.height,
        halfResActive: (cache?.halfWidth ?? 0) > 0,
      },
      historyTarget: {
        width: cache?.temporalWidth ?? 0,
        height: cache?.temporalHeight ?? 0,
        pipelineReady:
          cache?.temporalPipeline !== null &&
          cache?.temporalPipeline !== undefined,
      },
      temporal: {
        resetReasons: cache?.temporalHistoryResetReasons ?? null,
        latchedResetReasons: cache?.temporalHistoryLatchedResetReasons ?? null,
        generation: cache?.temporalHistoryGeneration ?? null,
        resetCount: cache?.temporalHistoryResetCount ?? null,
        acceptedFrames: cache?.temporalHistoryAcceptedFrames ?? null,
        firstFrame: cache?.temporalFirstFrame ?? null,
      },
      frameCounter: cache?.frameCounter ?? null,
    };
  };

  globalThis.__cloudTour = state;

  const context = scene.context;
  return {
    baseIso: input.baseIso,
    rendererType: context?.rendererType ?? null,
    timestampSupported: context?.hasFeature?.("timestamp-query") === true,
    adapterInfo: context?.adapter?.info
      ? {
          vendor: context.adapter.info.vendor || "",
          architecture: context.adapter.info.architecture || "",
          device: context.adapter.info.device || "",
          description: context.adapter.info.description || "",
        }
      : null,
    canvas: { width: scene.canvas.width, height: scene.canvas.height },
  };
};

/**
 * Configure clouds and drive the renderer to a state where the density field
 * the caller wants to measure is BOTH realized and visible.
 *
 * A loaded feature-renderer handle and a fixed rAF warm-up count are not
 * execution evidence (C13-35). `awaitProceduralReady` proves an actual execute
 * plus an initialized cache/pipeline; the bounded render-measure-check loop
 * after it proves the 3D noise bake has produced a field that is actually on
 * screen. On timeout the caller records a STRUCTURAL failure rather than a
 * meaningless number.
 */
const PREPARE = async (input) => {
  const state = globalThis.__cloudTour;
  const { C, viewer } = state;
  state.stepSeconds = 0;
  state.frameIndex = 0;
  state.currentTime = state.baseTime;
  viewer.clock.currentTime = state.baseTime;

  const configTruth = globalThis.__cloudProbe.configure({
    requireWebGPU: true,
    volumetric: input.volumetric,
  });
  state.volumetric = input.volumetric;

  state.setView(input.station);
  const readiness = await globalThis.__cloudProbe.awaitProceduralReady({
    featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
    frameTime: state.baseTime,
  });
  // `awaitProceduralReady` drives the camera; restore the exact evidence pose.
  state.setView(input.station);

  // BOUNDED render-measure-check. `settleThen` yields only on the LOADING side
  // and performs its capture with no yield after the final render, so the
  // realization predicate can be polled per frame without ever reading a
  // relinquished surface. The predicate is non-pixel (cache initialized +
  // pipeline ready); the single capture at the end answers the separate
  // question of whether anything actually reached the canvas, which keeps
  // "renderer never realized" and "realized but black" distinguishable.
  let meanLum = null;
  const settle = await state.settleThen(
    input.occupancyMaxFrames,
    () => {
      const realization = state.cacheSnapshot();
      return (
        realization.initialized === true && realization.pipelineReady === true
      );
    },
    async () => {
      const image = await state.captureNow();
      meanLum = state.meanLuminance(image);
      return meanLum;
    },
  );
  const nonBlack = Number.isFinite(meanLum) && meanLum > 0;
  const ok = settle.settled === true && nonBlack;
  return {
    configTruth,
    readiness,
    occupancy: {
      ok,
      reason: ok
        ? "ok"
        : !settle.settled
          ? "renderer-never-realized"
          : meanLum === null
            ? "canvas-readback-unavailable"
            : "canvas-readback-all-zero",
      maxFrames: input.occupancyMaxFrames,
      settled: settle.settled === true,
      meanLum: Number.isFinite(meanLum) ? +meanLum.toFixed(4) : null,
    },
    realization: state.cacheSnapshot(),
  };
};

/** Visit one fixture station: interpolate in, settle, then capture OFF/ON. */
const STATION = async (input) => {
  const state = globalThis.__cloudTour;
  const { C, viewer, scene } = state;
  const shortestDegrees = (from, to) =>
    ((((to - from) % 360) + 540) % 360) - 180;
  const interpolateHeight = (from, to, amount) =>
    Math.exp(
      Math.log(Math.max(1, from + 1)) * (1 - amount) +
        Math.log(Math.max(1, to + 1)) * amount,
    ) - 1;

  // Motion in, not a teleport: the row asks for MOVING sequences, and an
  // altitude/dateline/pole transition only exercises the intermediate frames if
  // the intermediate frames exist.
  if (input.from) {
    const lonDelta = shortestDegrees(input.from.lon, input.station.lon);
    const headingDelta = shortestDegrees(
      input.from.heading,
      input.station.heading,
    );
    for (let frame = 1; frame <= input.transitionFrames; frame++) {
      const linear = frame / input.transitionFrames;
      const amount = linear * linear * (3 - 2 * linear);
      state.setView({
        lon: input.from.lon + lonDelta * amount,
        lat: input.from.lat + (input.station.lat - input.from.lat) * amount,
        height: interpolateHeight(
          input.from.height,
          input.station.height,
          amount,
        ),
        heading: input.from.heading + headingDelta * amount,
        pitch:
          input.from.pitch + (input.station.pitch - input.from.pitch) * amount,
      });
      state.renderNow();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }
  state.setView(input.station);
  for (let frame = 0; frame < input.settleFrames; frame++) {
    state.renderNow();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  // OFF/ON at the SAME camera and the SAME instant. Anything that differs
  // between the two frames is the cloud pass and nothing else.
  globalThis.__cloudProbe.configure({ enableVolumetric: false });
  for (let frame = 0; frame < input.toggleSettleFrames; frame++) {
    state.renderNow();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const offDataUrl = state.grabNow();

  globalThis.__cloudProbe.configure({
    requireWebGPU: true,
    volumetric: state.volumetric,
  });
  for (let frame = 0; frame < input.toggleSettleFrames; frame++) {
    state.renderNow();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const onDataUrl = state.grabNow();

  const cartographic = viewer.camera.positionCartographic;
  return {
    offDataUrl,
    onDataUrl,
    realized: {
      longitudeDegrees: C.Math.toDegrees(cartographic.longitude),
      latitudeDegrees: C.Math.toDegrees(cartographic.latitude),
      height: cartographic.height,
    },
    canvas: { width: scene.canvas.width, height: scene.canvas.height },
    realization: state.cacheSnapshot(),
  };
};

/**
 * Run ONE sequence phase. Returns strided captures, CPU samples and the reset
 * mask observed across the phase's frames.
 *
 * The reset mask is OR-ed across the phase's frames rather than sampled once:
 * a reset is an EDGE, and a phase whose frame count exceeds one would otherwise
 * report whatever the last frame happened to hold.
 */
const PHASE = async (input) => {
  const state = globalThis.__cloudTour;
  const { scene } = state;
  const phase = input.phase;
  state.stepSeconds = input.stepSeconds ?? 0;

  if (phase.action === "disable-clouds") {
    globalThis.__cloudProbe.configure({ enableVolumetric: false });
  } else if (phase.action === "enable-clouds") {
    globalThis.__cloudProbe.configure({
      requireWebGPU: true,
      volumetric: state.volumetric,
    });
  } else if (phase.action === "set-deck") {
    state.volumetric = {
      ...state.volumetric,
      cloudLayerBottom: phase.deck.bottom,
      cloudLayerTop: phase.deck.top,
    };
    globalThis.__cloudProbe.configure({
      requireWebGPU: true,
      volumetric: state.volumetric,
    });
  }
  if (input.station && ["hold", "teleport", "return"].includes(phase.action)) {
    state.setView(input.station);
    // An absolute pose also re-anchors the pan heading. A `return` phase is
    // therefore exact regardless of what the preceding pan did, which is what
    // makes the ghost oracle's "same pose" claim true rather than approximate.
    state.panHeading = input.station.heading;
  }

  if (phase.action === "resize") {
    // The Node side already changed the page viewport, but `scene.render()` does
    // NOT resize the canvas — the widget's own render loop normally does that,
    // and this probe drives the scene directly. Without an explicit resize the
    // canvas keeps its old backing size and the RESOURCE reset this phase exists
    // to provoke never happens, so the assertion would fail for a reason that has
    // nothing to do with the renderer.
    state.viewer.resize?.();
  }

  const captures = [];
  const cpuSamples = [];
  let excludedCaptureFrames = 0;
  let resetMask = 0;
  let assertedResetMask = 0;
  const resetFrames = [];
  // Frames before the grace boundary are RECORDED but not ASSERTED: a phase
  // that follows a discontinuity carries that discontinuity's tail while the
  // history rebuilds.
  const assertFromFrame = phase.resetAssertFromFrame ?? 0;
  if (!Number.isFinite(state.panHeading)) {
    state.panHeading = input.panFrom?.heading ?? 0;
  }

  for (let frame = 0; frame < phase.frames; frame++) {
    if (phase.action === "pan") {
      // The heading lives on the shared state, not in this call: each phase is
      // its OWN page.evaluate, so a local would restart the pan-back from the
      // origin heading and the camera would end 40 degrees the wrong side of
      // where it started.
      state.panHeading += phase.pan.headingDeltaDegrees;
      state.setView({ ...input.panFrom, heading: state.panHeading });
    }
    const captureThisFrame =
      phase.capture === true &&
      (frame % input.captureStride === 0 || frame === phase.frames - 1);
    if (captureThisFrame) {
      // The snapshot is fused to its render inside `grabNow`; the PNG encode
      // cost is why this frame is excluded from the CPU distribution.
      captures.push({ frame, dataUrl: state.grabNow() });
      excludedCaptureFrames++;
    } else {
      const started = performance.now();
      state.renderNow();
      cpuSamples.push(performance.now() - started);
    }
    const snapshot = state.cacheSnapshot();
    const reasons = snapshot.temporal.resetReasons;
    if (Number.isInteger(reasons) && reasons !== 0) {
      resetMask |= reasons;
      if (frame >= assertFromFrame) {
        assertedResetMask |= reasons;
      }
      resetFrames.push({ frame, reasons });
    }
    state.advance();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  return {
    id: phase.id,
    action: phase.action,
    frames: phase.frames,
    captures,
    cpuSamples,
    excludedCaptureFrames,
    resetMask,
    assertedResetMask,
    assertFromFrame,
    resetFrames: resetFrames.slice(0, 8),
    endIso: state.C.JulianDate.toIso8601(state.currentTime),
    frameIndex: state.frameIndex,
    realization: state.cacheSnapshot(),
    canvas: { width: scene.canvas.width, height: scene.canvas.height },
  };
};

/** Arm / disarm the C13-39 GPU timestamp profiler and read its results. */
const GPU_TIMING = async (input) => {
  const state = globalThis.__cloudTour;
  const context = state.scene.context;
  if (input.action === "arm") {
    globalThis.CesiumDebug?.gpuPassCost?.(true);
    return { armed: true };
  }
  const device = context?.device;
  if (device) {
    await device.queue.onSubmittedWorkDone();
  }
  // Timestamp readback is mapAsync-based and settles a few frames late.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const results = context?.timestampProfiler?.getResults?.() ?? null;
  globalThis.CesiumDebug?.gpuPassCost?.(false);
  return { armed: false, results };
};

// ── Lane: fixtures ────────────────────────────────────────────────────────

async function runFixtureLane(browser) {
  const context = await openPage(browser);
  const { page } = context;
  const records = [];
  let environment = null;
  let laneError = null;
  try {
    // Discarded warm-up: the async pipeline/noise prewarm (C13-40) makes the
    // tour's FIRST fixture render stable-black long enough for the
    // stability-based occupancy settle to accept it — the calibration run
    // measured meanLum 3.3 on fixture 1 against 50–145 on every warmed
    // fixture. One throwaway first-station visit pays that cost off the
    // record; nothing from it is kept.
    if (selectedFixtures.length > 0) {
      const warm = selectedFixtures[0];
      await page.evaluate(INSTALL_TOUR, {
        baseIso: fixtureClockIso(warm),
        stepSeconds: 0,
      });
      await page.evaluate(PREPARE, {
        volumetric: warm.volumetric,
        station: warm.stations[0],
        occupancyMaxFrames: OCCUPANCY_MAX_FRAMES,
      });
      await page.evaluate(STATION, {
        station: warm.stations[0],
        from: null,
        transitionFrames: TRANSITION_FRAMES,
        settleFrames: STATION_SETTLE_FRAMES,
        toggleSettleFrames: TOGGLE_SETTLE_FRAMES,
      });
    }
    for (const fixture of selectedFixtures) {
      const baseIso = fixtureClockIso(fixture);
      const installed = await page.evaluate(INSTALL_TOUR, {
        baseIso,
        stepSeconds: 0,
      });
      environment = environment ?? installed;
      const prepared = await page.evaluate(PREPARE, {
        volumetric: fixture.volumetric,
        station: fixture.stations[0],
        occupancyMaxFrames: OCCUPANCY_MAX_FRAMES,
      });

      const stations = [];
      let previous = null;
      for (const station of fixture.stations) {
        const visited = await page.evaluate(STATION, {
          station,
          from: previous,
          transitionFrames: TRANSITION_FRAMES,
          settleFrames: STATION_SETTLE_FRAMES,
          toggleSettleFrames: TOGGLE_SETTLE_FRAMES,
        });
        previous = station;
        const off = await decodeRgba(visited.offDataUrl);
        const on = await decodeRgba(visited.onDataUrl);
        const contribution = imageDeltaMetrics(off.data, on.data);
        const gate = fixture.gate ?? {};
        const pass = Number.isFinite(gate.minChangedFraction)
          ? contribution.ok &&
            contribution.changedFraction >= gate.minChangedFraction
          : contribution.ok &&
            contribution.changedFraction <= gate.maxChangedFraction;
        stations.push({
          id: station.id,
          regime: station.regime,
          requested: station,
          realized: visited.realized,
          contribution,
          gate: {
            kind: Number.isFinite(gate.minChangedFraction)
              ? "floor"
              : "ceiling",
            threshold:
              gate.minChangedFraction ?? gate.maxChangedFraction ?? null,
            why: gate.why ?? null,
            pass,
          },
          screenshots: [
            writePng(
              `${OUT}/fixture-${fixture.id}-${station.id}-on.png`,
              visited.onDataUrl,
            ),
            writePng(
              `${OUT}/fixture-${fixture.id}-${station.id}-off.png`,
              visited.offDataUrl,
            ),
          ].map((shot, index) => ({
            phase: index === 0 ? `${station.id}-on` : `${station.id}-off`,
            ...shot,
          })),
          realization: visited.realization,
        });
      }

      const tier = deriveCloudTier({
        qualityFlags: prepared.realization.qualityFlags,
        lightSteps: prepared.realization.lightSteps,
        maxSteps: prepared.realization.maxSteps,
      });
      records.push({
        id: fixture.id,
        climate: fixture.climate,
        region: fixture.region,
        genus: fixture.cloudType,
        formation: fixture.formation,
        replayKey: replayKeyFor(fixtureReplaySubset(fixture)),
        clock: { baseIso, stepSeconds: 0 },
        configTruth: prepared.configTruth,
        readiness: prepared.readiness,
        occupancy: prepared.occupancy,
        tier,
        stations,
        structural: {
          ok:
            prepared.configTruth?.ok === true &&
            prepared.readiness?.ok === true &&
            prepared.occupancy?.ok === true,
          reason:
            prepared.occupancy?.ok === true ? null : prepared.occupancy?.reason,
        },
        gatesPassed: stations.every((station) => station.gate.pass),
      });
      console.log(
        `  [fixture] ${fixture.id}: tier=${tier.tierName} ` +
          `stations=${stations.length} ` +
          `gates=${stations.filter((s) => s.gate.pass).length}/${stations.length} ` +
          `contribution=${stations
            .map((s) => (s.contribution.changedFraction ?? 0).toFixed(4))
            .join(",")}`,
      );
    }
  } catch (error) {
    // A throw mid-lane is a STRUCTURAL failure, not a reason to lose the gate
    // evidence for the fixtures that did complete.
    laneError = `fixture lane threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  let errors;
  try {
    errors = await closeGate(page, context);
  } catch (error) {
    errors = [
      `gate collection failed: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  if (laneError) {
    errors.push(laneError);
  }
  await page.close().catch(() => {});
  return { records, environment, errors };
}

// ── Lane: sequences ───────────────────────────────────────────────────────

function stationForPhase(sequence, fixture, phase, lastStation) {
  if (phase.station) {
    return phase.station;
  }
  if (typeof phase.stationId === "string") {
    return fixture.stations.find((station) => station.id === phase.stationId);
  }
  return lastStation;
}

async function runSequence(browser, sequence, provenance) {
  const fixture = fixtureById(sequence.fixtureId);
  const baseIso = fixtureClockIso(fixture);
  const volumetric = { ...fixture.volumetric, ...(sequence.volumetric ?? {}) };
  const context = await openPage(browser);
  const { page } = context;
  let record;
  try {
    const installed = await page.evaluate(INSTALL_TOUR, {
      baseIso,
      stepSeconds: sequence.clock.stepSeconds,
    });
    const firstStation =
      stationForPhase(
        sequence,
        fixture,
        sequence.phases[0],
        fixture.stations[0],
      ) ?? fixture.stations[0];
    const prepared = await page.evaluate(PREPARE, {
      volumetric,
      station: firstStation,
      occupancyMaxFrames: OCCUPANCY_MAX_FRAMES,
    });

    // Warm-up runs BEFORE the timestamp profiler is armed so pipeline
    // compilation is not charged to the measured window.
    if (sequence.clock.warmFrames > 0) {
      await page.evaluate(PHASE, {
        phase: {
          id: "__warm",
          action: "hold",
          frames: sequence.clock.warmFrames,
          capture: false,
        },
        station: firstStation,
        stepSeconds: 0,
        captureStride: CAPTURE_STRIDE,
      });
      // The measured clock walk starts at the fixture's base instant, not at
      // base + warmFrames * step. Warm-up length is a constant so either choice
      // would be reproducible, but starting the walk at zero keeps `endIso`
      // readable as "base plus frames times step" without a hidden offset.
      await page.evaluate(() => {
        globalThis.__cloudTour.frameIndex = 0;
        globalThis.__cloudTour.currentTime = globalThis.__cloudTour.baseTime;
      });
    }
    await page.evaluate(GPU_TIMING, { action: "arm" });

    const phaseRecords = [];
    const cpuSamples = [];
    let lastStation = firstStation;
    let panFrom = firstStation;
    for (const phase of sequence.phases) {
      if (phase.action === "resize") {
        await page.setViewportSize({
          width: phase.viewport.width,
          height: phase.viewport.height,
        });
      }
      const station = stationForPhase(sequence, fixture, phase, lastStation);
      if (station) {
        lastStation = station;
        if (phase.action !== "pan") {
          panFrom = station;
        }
      }
      const result = await page.evaluate(PHASE, {
        phase,
        station: phase.action === "pan" ? null : station,
        panFrom,
        stepSeconds: sequence.clock.stepSeconds,
        captureStride: CAPTURE_STRIDE,
      });
      cpuSamples.push(...result.cpuSamples);

      const decoded = [];
      for (const capture of result.captures) {
        decoded.push({
          frame: capture.frame,
          ...(await decodeRgba(capture.dataUrl)),
        });
      }
      const screenshots = [];
      if (result.captures.length > 0) {
        const keep = [result.captures[0]];
        if (result.captures.length > 1) {
          keep.push(result.captures[result.captures.length - 1]);
        }
        for (const [index, capture] of keep.entries()) {
          screenshots.push({
            phase: `${phase.id}-${index === 0 ? "first" : "last"}`,
            ...writePng(
              `${OUT}/seq-${sequence.id}-${phase.id}-${index === 0 ? "first" : "last"}.png`,
              capture.dataUrl,
            ),
          });
        }
      }
      phaseRecords.push({
        id: phase.id,
        action: phase.action,
        frames: phase.frames,
        capturedFrames: decoded.length,
        excludedCaptureFrames: result.excludedCaptureFrames,
        reset: {
          ...assessPhaseReset(phase, result.assertedResetMask),
          // The full mask is recorded alongside the asserted one so a reader can
          // see what the grace window absorbed.
          observedAllFrames: result.resetMask,
          assertFromFrame: result.assertFromFrame,
        },
        resetFrames: result.resetFrames,
        framewise: framewiseDeltaSeries(decoded.map((entry) => entry.data)),
        endIso: result.endIso,
        realization: result.realization,
        canvas: result.canvas,
        screenshots,
        // Kept only for the cross-phase ghost oracle below; stripped before the
        // manifest is serialized.
        __decoded: decoded,
      });
    }

    const timing = await page.evaluate(GPU_TIMING, { action: "read" });
    const gpu = summarizeGpuPasses(timing.results, sequence.gpuPasses);

    // ── ghost oracle: same pose, before and after the motion ──
    let ghost = null;
    if (sequence.kind === "temporal-ghost") {
      const reference = phaseRecords.find(
        (phase) => phase.id === "converged-reference",
      );
      const reconverged = phaseRecords.find(
        (phase) => phase.id === "reconverged",
      );
      const motion = phaseRecords.find((phase) => phase.id === "pan-away");
      const lastOf = (phase) =>
        phase?.__decoded?.[phase.__decoded.length - 1]?.data ?? null;
      ghost = ghostMetrics({
        reference: lastOf(reference),
        reconverged: lastOf(reconverged),
        motionMid: lastOf(motion),
        floorMeanAbsRgbDelta: reference?.framewise?.meanAbsRgbDelta ?? null,
      });
    }

    const lastRealization =
      phaseRecords[phaseRecords.length - 1]?.realization ??
      prepared.realization;
    const tier = deriveCloudTier({
      qualityFlags: lastRealization.qualityFlags,
      lightSteps: lastRealization.lightSteps,
      maxSteps: lastRealization.maxSteps,
    });
    const errors = await closeGate(page, context);

    const resetOk = phaseRecords.every(
      (phase) => phase.reset.expected === null || phase.reset.ok,
    );
    const totalFrames = phaseRecords.reduce(
      (total, phase) => total + phase.frames,
      0,
    );
    record = {
      id: sequence.id,
      kind: sequence.kind,
      fixtureId: sequence.fixtureId,
      description: sequence.description,
      replayKey: replayKeyFor(sequenceReplaySubset(sequence)),
      provenance,
      environment: {
        adapterInfo: installed.adapterInfo,
        browserVersion: provenance.browserVersion,
        canvas: installed.canvas,
        viewport: { width: W, height: H },
      },
      configuration: {
        requestedVolumetric: volumetric,
        configTruth: prepared.configTruth,
      },
      clock: {
        baseIso,
        stepSeconds: sequence.clock.stepSeconds,
        frames: totalFrames,
        endIso: phaseRecords[phaseRecords.length - 1]?.endIso ?? baseIso,
      },
      realization: {
        tier: tier.tier,
        tierName: tier.tierName,
        tierEvidence: tier.evidence,
        currentTarget: lastRealization.currentTarget,
        historyTarget: lastRealization.historyTarget,
        frameCounter: lastRealization.frameCounter,
        temporal: lastRealization.temporal,
      },
      cpuFrames: {
        ...frameDistribution(cpuSamples),
        excludedCaptureFrames: phaseRecords.reduce(
          (total, phase) => total + phase.excludedCaptureFrames,
          0,
        ),
      },
      gpu: {
        supported: installed.timestampSupported === true,
        armed: true,
        // HONEST SCOPE. `WebGPUTimestampProfiler` keeps a ROLLING window (60
        // frames at the time of writing), and this probe arms it once per
        // sequence. For a sequence whose measured frames exceed that window the
        // reported average covers the LAST `frameCount` frames, which for a
        // multi-phase sequence can straddle a phase boundary. The number is
        // therefore a per-SEQUENCE figure, never a per-phase one, and
        // `measuredFrames` vs `windowFrames` makes the difference visible
        // instead of leaving a reader to assume full coverage.
        measuredFrames: totalFrames,
        windowFrames: gpu.profiler?.frameCount ?? null,
        windowCoversWholeSequence:
          Number.isFinite(gpu.profiler?.frameCount) &&
          gpu.profiler.frameCount >= totalFrames,
        ...gpu,
      },
      temporal: {
        phases: phaseRecords.map(({ __decoded, ...phase }) => phase),
        framewise: phaseRecords.map((phase) => ({
          id: phase.id,
          meanAbsRgbDelta: phase.framewise.meanAbsRgbDelta,
          maxAbsRgbDelta: phase.framewise.maxAbsRgbDelta,
          steps: phase.framewise.steps,
        })),
        ghost,
      },
      screenshots: phaseRecords.flatMap((phase) => phase.screenshots),
      readiness: prepared.readiness,
      occupancy: prepared.occupancy,
      errors,
      structural: {
        ok:
          prepared.configTruth?.ok === true &&
          prepared.readiness?.ok === true &&
          prepared.occupancy?.ok === true &&
          resetOk &&
          errors.length === 0,
        reason: !prepared.occupancy?.ok
          ? prepared.occupancy?.reason
          : !resetOk
            ? "a phase's temporal reset assertion failed"
            : errors.length > 0
              ? "console/device errors"
              : null,
      },
    };
  } catch (error) {
    // STRUCTURAL FAILURE CONVENTION: a sequence that throws still produces a
    // record. Returning `null` would push the failure into the manifest writer
    // as a crash, losing both the identity of the sequence that failed and the
    // records of the sequences that succeeded.
    record = {
      id: sequence.id,
      kind: sequence.kind,
      fixtureId: sequence.fixtureId,
      description: sequence.description,
      replayKey: replayKeyFor(sequenceReplaySubset(sequence)),
      provenance,
      environment: {
        adapterInfo: null,
        browserVersion: provenance.browserVersion,
        canvas: { width: null, height: null },
        viewport: { width: W, height: H },
      },
      configuration: { requestedVolumetric: volumetric, configTruth: null },
      clock: {
        baseIso,
        stepSeconds: sequence.clock.stepSeconds,
        frames: 0,
        endIso: baseIso,
      },
      realization: {
        tier: null,
        tierName: "unknown",
        tierEvidence: null,
        currentTarget: { width: null, height: null },
        historyTarget: { width: null, height: null },
      },
      cpuFrames: { ...frameDistribution([]), excludedCaptureFrames: 0 },
      gpu: {
        supported: null,
        armed: false,
        ...summarizeGpuPasses(null, sequence.gpuPasses),
      },
      temporal: { phases: [], framewise: [], ghost: null },
      screenshots: [],
      errors: [error instanceof Error ? error.message : String(error)],
      structural: {
        ok: false,
        reason: `sequence threw: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  } finally {
    await page.close().catch(() => {});
    // The viewport override from a resize phase is page-local; each sequence
    // opens its own page, so nothing to restore here.
  }
  return record;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const runtimeBundlePath = "Build/CesiumUnminified/Cesium.js";
  const runtimeBundle = fs.readFileSync(runtimeBundlePath);
  const provenanceBase = {
    commit: command("git", ["rev-parse", "HEAD"]),
    dirty: Boolean(command("git", ["status", "--porcelain"])),
    runtimeBundle: {
      path: runtimeBundlePath,
      byteLength: runtimeBundle.byteLength,
      sha256: createHash("sha256").update(runtimeBundle).digest("hex"),
    },
  };

  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const provenance = { ...provenanceBase, browserVersion: browser.version() };
  try {
    let fixtureLane = { records: [], environment: null, errors: [] };
    if (LANES.includes("fixtures")) {
      console.log(`\n--- FIXTURES (${selectedFixtures.length}) ---`);
      fixtureLane = await runFixtureLane(browser);
    }

    const sequenceRecords = [];
    if (LANES.includes("sequences")) {
      console.log(`\n--- SEQUENCES (${selectedSequences.length}) ---`);
      for (const sequence of selectedSequences) {
        console.log(`  [sequence] ${sequence.id} ...`);
        const record = await runSequence(browser, sequence, provenance);
        sequenceRecords.push(record);
        const ghost = record.temporal.ghost;
        console.log(
          `    tier=${record.realization.tierName} ` +
            `current=${record.realization.currentTarget.width}x${record.realization.currentTarget.height} ` +
            `history=${record.realization.historyTarget.width}x${record.realization.historyTarget.height} ` +
            `cpu p50/p95/p99=${record.cpuFrames.p50Ms}/${record.cpuFrames.p95Ms}/${record.cpuFrames.p99Ms}ms ` +
            `gpu=${record.gpu.observedCount}/${record.gpu.declaredCount} passes ` +
            `${ghost ? `ghost=${ghost.residual.meanAbsRgbDelta} (x${ghost.ghostOverFloor} floor) ` : ""}` +
            `[${record.structural.ok ? "OK" : `STRUCTURAL: ${record.structural.reason}`}]`,
        );
        for (const phase of record.temporal.phases) {
          if (phase.reset.expected !== null && !phase.reset.ok) {
            console.log(
              `      RESET MISMATCH ${phase.id}: expected [${phase.reset.expectedNames}] ` +
                `observed [${phase.reset.observedNames}] ` +
                `missing [${phase.reset.missing}] unexpected [${phase.reset.unexpected}]`,
            );
          }
        }
      }
    }

    const metricFailures = sequenceRecords.flatMap((record) =>
      validateSequenceMetricRecord(record),
    );

    const manifest = {
      manifestVersion: SEQUENCE_MANIFEST_VERSION,
      schemaVersion: CLOUD_TOUR_SCHEMA_VERSION,
      tag: TAG,
      pairId: PAIR_ID,
      round: ROUND,
      order: ORDER,
      source: provenanceBase,
      environment: {
        browserVersion: provenance.browserVersion,
        adapterInfo:
          sequenceRecords[0]?.environment?.adapterInfo ??
          fixtureLane.environment?.adapterInfo ??
          null,
        canvas:
          sequenceRecords[0]?.environment?.canvas ??
          fixtureLane.environment?.canvas ??
          null,
        viewport: { width: W, height: H },
      },
      measurement: {
        kind: "per-sequence-cpu-distribution-plus-webgpu-timestamp-passes",
        captureStride: CAPTURE_STRIDE,
        transitionFrames: TRANSITION_FRAMES,
        stationSettleFrames: STATION_SETTLE_FRAMES,
        toggleSettleFrames: TOGGLE_SETTLE_FRAMES,
        occupancyMaxFrames: OCCUPANCY_MAX_FRAMES,
      },
      coverage: summarizeFixtureCoverage(selectedFixtures),
      fixtures: fixtureLane.records,
      fixtureErrors: fixtureLane.errors,
      sequences: sequenceRecords,
      metricCompleteness: {
        ok: metricFailures.length === 0,
        failures: metricFailures,
      },
    };
    const manifestPath = PAIR_ID
      ? `${OUT}/cloud-tour-sequences-${PAIR_ID}-r${ROUND}-${TAG}.json`
      : `${OUT}/cloud-tour-sequences-${TAG}.json`;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // ── interleaved A/B, when the operator declared a pair ──
    let abAssessment = null;
    if (PAIR_ID) {
      const prefix = `cloud-tour-sequences-${PAIR_ID}-r`;
      const manifests = fs
        .readdirSync(OUT)
        .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
        .map((name) => JSON.parse(fs.readFileSync(`${OUT}/${name}`, "utf8")));
      abAssessment = assessInterleavedAb({
        manifests,
        controlPasses: parseControlPasses(
          process.env.TOUR_CONTROL_PASSES,
          selectedSequences,
        ),
      });
      fs.writeFileSync(
        `${OUT}/cloud-tour-ab-${PAIR_ID}.json`,
        JSON.stringify(
          { pairId: PAIR_ID, manifestCount: manifests.length, ...abAssessment },
          null,
          2,
        ),
      );
    }

    const fixtureGatesOk = fixtureLane.records.every(
      (record) => record.structural.ok && record.gatesPassed,
    );
    const sequencesOk = sequenceRecords.every((record) => record.structural.ok);
    // A/B statuses that mean "the protocol is not finished yet" are NOT failures
    // — they are the normal state of every round but the last. Statuses that
    // mean "these artifacts can never answer the question" are.
    const AB_FATAL = new Set([
      "incomparable-pair",
      "incomparable-environment",
      "no-manifests",
    ]);
    const abFatal = abAssessment !== null && AB_FATAL.has(abAssessment.status);
    const pass =
      fixtureGatesOk &&
      sequencesOk &&
      fixtureLane.errors.length === 0 &&
      metricFailures.length === 0 &&
      !abFatal;

    console.log("\n=== SUMMARY ===");
    for (const record of fixtureLane.records) {
      console.log(
        `  fixture ${record.id}: ${record.gatesPassed ? "GATES PASS" : "GATES FAIL"} ` +
          `${record.structural.ok ? "" : `STRUCTURAL: ${record.structural.reason}`}`,
      );
    }
    for (const record of sequenceRecords) {
      console.log(
        `  sequence ${record.id}: ${record.structural.ok ? "OK" : `FAIL (${record.structural.reason})`}`,
      );
    }
    if (metricFailures.length > 0) {
      console.log("\n  METRIC COMPLETENESS FAILURES:");
      for (const failure of metricFailures.slice(0, 12)) {
        console.log(`    - ${failure}`);
      }
    }
    if (fixtureLane.errors.length > 0) {
      console.log(
        `\n  fixture-lane errors: ${fixtureLane.errors.slice(0, 4).join(" | ")}`,
      );
    }
    console.log(`\nmanifest: ${manifestPath}`);
    console.log(`PNGs: ${OUT}/`);
    if (abAssessment) {
      console.log(
        `\nA/B (pairId=${PAIR_ID} round=${ROUND} order=${ORDER} tag=${TAG}): ` +
          `${abAssessment.status}`,
      );
      for (const failure of abAssessment.failures.slice(0, 6)) {
        console.log(`    - ${failure}`);
      }
      for (const round of abAssessment.rounds) {
        console.log(
          `    round ${round.round} (${round.order}): ` +
            `${round.usable ? "USABLE" : "DISCARDED"}` +
            `${round.failures.length ? ` — ${round.failures[0]}` : ""}`,
        );
      }
      for (const [key, entry] of Object.entries(abAssessment.verdict ?? {})) {
        console.log(
          `    ${key}: ${entry.direction} ` +
            `(per-round ${entry.deltaPctPerRound.join("%, ")}%)`,
        );
      }
      if (abAssessment.status !== "assessed") {
        console.log(
          "  Not an answer yet. Continue the interleave: alternate pre/post within\n" +
            "  ONE session, increment TOUR_ROUND, and run at least one round with\n" +
            "  TOUR_ORDER=post-first.",
        );
      }
      console.log(`  assessment: ${OUT}/cloud-tour-ab-${PAIR_ID}.json`);
    }
    console.log(`RESULT: ${pass ? "GREEN" : "RED"}`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

run();
