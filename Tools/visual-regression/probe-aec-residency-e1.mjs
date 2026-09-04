#!/usr/bin/env node
// @purpose E-1 corrected AEC residency measurement: profiles the WebGPU settle window of the demo's own clipped eight-tileset scene with a CPU sampling profile, a wall-clock-cadence pipelineCache created/pending poll, an allocation-site heap profile and an optional streamed heap snapshot, then reports equal-content frame cost and commandList length on one shared validated pick position under a deadline, or refuses the comparison when a backend never became ready.
// @status ACTIVE
//
// Q-143 / DM-09 — the instrument, not the fix.
//
// WHAT THIS IS FOR. Cirdan's station-3 review of the AEC design-model lane rules
// that no fix for the WebGPU residency stall may be funded until one corrected,
// interleaved measurement exists: both backends reaching `Scene.renderReady`
// before any timing phase, one validated pick position shared by both legs, a
// reversed-order second leg, a CPU sampling profile over the WebGPU settle
// window with the pipeline cache sampled across it, a heap reading at the end of
// each settle window, and equal-content frame cost plus `commandList.length` for
// both backends. Two code-reading diagnoses of this stall have already failed on
// magnitude, so the review's instruction is to build the instrument first.
//
// WHAT IT MEASURES THAT `probe-aec-perf.mjs` CANNOT. That probe waits for
// `Scene.renderReady` and then times; the stall lives BEFORE that gate, and on
// this scene the probe refuses (`first-traversal-not-observed`) rather than
// measuring it. This probe treats the settle window itself as the measurement:
// it profiles the window, tolerates a backend that never becomes ready as a
// recorded outcome, and refuses only the phases that a non-ready backend would
// void.
//
// PRE-REGISTERED PREDICTIONS. `E1_PREDICTIONS` in `lib/aec-residency-e1.mjs` is
// frozen before any run of this file, and `classifySettleWindow` reads nothing
// else. The two hypotheses make opposite predictions about main-thread busy
// fraction and pipeline-pending frame fraction, and the band table also admits
// "both", "neither" and "undecidable" so the prediction can come out wrong.
//
// TWO AXES, ONE WEIGHTING. The CPU axis is a continuous sampler and the pipeline
// axis is a 250 ms wall-clock poll weighted by the interval each sample
// terminates, so the two are comparable. A per-frame-only pipeline reading would
// have sampled roughly 18 instants of a 75 s window and never the gaps between
// them - which is where the hypothesis under test places the wait.
//
// EVERY WAIT IS BOUNDED. `--settle-deadline-ms` bounds the settle window and
// `--equal-content-deadline-ms` bounds the equal-content phase; both expire into
// recorded partial results rather than into a hang.
//
// Preconditions:
//   node server.js --port 8094 --serve-built
//
// Examples:
//   node Tools/visual-regression/probe-aec-residency-e1.mjs
//   node Tools/visual-regression/probe-aec-residency-e1.mjs --reverse
//   node Tools/visual-regression/probe-aec-residency-e1.mjs --heap-snapshot
//   node Tools/visual-regression/probe-aec-residency-e1.mjs --entry /Build/Cesium/index.js
//
// Exit codes:
//   0 measurement completed
//   2 probe/runtime error
//   3 refusal: the requested measurement could not be validated

import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  E1RefusalError,
  EXIT_CODES,
  aggregateHeapSamplingProfile,
  buildMarkdownSummary,
  buildReceipt,
  classifySettleWindow,
  decideEqualContentRefusal,
  deriveEntryContext,
  decideOriginRefusal,
  decidePreflightRefusal,
  decideReadinessRefusal,
  p50P95,
  parseArgs,
  summarizeModuleCoverage,
  throwForDecision,
} from "./lib/aec-residency-e1.mjs";

const HARNESS_PATH = "/Tools/visual-regression/aec-residency-e1-harness.html";

/**
 * The site clipping polygon the gallery demo attaches to the Google
 * Photorealistic tileset (`packages/sandcastle/gallery/aec-architectural-design/main.js:48-63`)
 * and the ancestor counters probe attaches too (the run that produced this row's
 * banked "75 s at 0.24 fps" baseline).
 *
 * It is part of the scene, not decoration. Clipping is a shader-variant axis —
 * `ModelClippingPolygonsPipelineStage.process` adds `ENABLE_CLIPPING_POLYGONS`
 * (`packages/engine/Source/Scene/Model/ModelClippingPolygonsPipelineStage.js:44`)
 * — so omitting it removes pipeline-creation work from the very window built to
 * decide whether pipeline creation is the bottleneck, and changes the traversal
 * and residency of the heaviest of the eight tilesets. A verdict measured
 * without it could not be set against the banked baseline.
 */
const SITE_CLIP_POSITIONS = Object.freeze([
  -79.887735, 40.022564, -79.886341, 40.023087, -79.886161, 40.023087,
  -79.885493, 40.022032, -79.88703, 40.021456, -79.887735, 40.022564,
]);

/**
 * The demo's tilesets, in the demo's own order. Structural is hidden exactly as
 * the gallery demo hides it, so the traversal gate on `show`
 * (`Cesium3DTileset.js:1449`) behaves as it does for a user.
 */
const TILESETS = Object.freeze([
  {
    title: "Google",
    assetId: 2275207,
    visible: true,
    clipPositions: SITE_CLIP_POSITIONS,
  },
  { title: "Architecture", assetId: 2887123, visible: true },
  { title: "Facade", assetId: 2887125, visible: true },
  { title: "Structural", assetId: 2887130, visible: false },
  { title: "Electrical", assetId: 2887124, visible: true },
  { title: "HVAC", assetId: 2887126, visible: true },
  { title: "Plumbing", assetId: 2887127, visible: true },
  { title: "Site", assetId: 2887129, visible: true },
]);

/**
 * The harness page. The widgets stylesheet is derived from the entry so a
 * `--entry /Build/Cesium/index.js` run is not a minified engine on an
 * unminified page.
 *
 * @param {string} stylesheetUrl Root-relative widgets stylesheet path.
 * @returns {string} HTML.
 */
function harnessHtml(stylesheetUrl) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>AEC residency E-1 probe</title>
  <link rel="stylesheet" href="${stylesheetUrl}">
  <style>
    html, body, #cesiumContainer {
      width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; background: #000;
    }
  </style>
</head>
<body>
<div id="cesiumContainer"></div>
</body>
</html>`;
}

/**
 * The page-side half, injected as a module script so the entry path is a runtime
 * argument rather than a build-time constant.
 *
 * `config` exists so a follow-on measurement can vary the scene WITHOUT
 * forking this text. Every field defaults to the value this probe has always
 * emitted, so a caller that passes no config gets a byte-identical module and
 * the readiness predicate, the recorder and the cache poll below stay one
 * definition shared by every run rather than two that can drift apart.
 *
 * @param {string} entry Root-relative served module path.
 * @param {string} baseUrl Root-relative build directory the entry lives in.
 * @param {string} renderer Backend name.
 * @param {ReadonlyArray<object>} tilesets Tileset descriptors.
 * @param {object} [config] Scene variations.
 * @param {Record<string, unknown>} [config.contextOptions] Extra context
 *   options emitted alongside `renderer`.
 * @param {boolean} [config.ambientOcclusion] Whether to enable the ambient
 *   occlusion stage. Defaults to true, as the demo does.
 * @param {string} [config.preludeSource] Page source injected before the
 *   viewer is created, for an observer that must be running first.
 * @param {string} [config.postViewerSource] Page source injected immediately
 *   after the viewer exists, for an observer that needs the scene.
 * @returns {string} Module source.
 */
function pageModule(entry, baseUrl, renderer, tilesets, config = {}) {
  const {
    contextOptions = {},
    ambientOcclusion = true,
    preludeSource = "",
    postViewerSource = "",
  } = config;
  // Emitted as source text rather than `JSON.stringify` of the whole object so
  // the default remains the exact `{ renderer: "webgpu" }` this file has always
  // written, and a config-free run is byte-identical to the runs already banked.
  const contextOptionsSource = Object.entries({ renderer, ...contextOptions })
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(", ");
  const preludeBlock = preludeSource === "" ? "" : `${preludeSource}\n`;
  const postViewerBlock =
    postViewerSource === "" ? "" : `\n${postViewerSource}`;
  const ambientOcclusionBlock = ambientOcclusion
    ? `if (Cesium.PostProcessStageLibrary.isAmbientOcclusionSupported(scene)) {
  const ao = scene.postProcessStages.ambientOcclusion;
  ao.enabled = true;
  ao.uniforms.intensity = 2.0;
  ao.uniforms.bias = 0.1;
  ao.uniforms.lengthCap = 0.5;
  ao.uniforms.directionCount = 16;
  ao.uniforms.stepCount = 32;
}
`
    : "";
  return `
window.CESIUM_BASE_URL = ${JSON.stringify(baseUrl)};
const Cesium = await import(${JSON.stringify(entry)});
window.Cesium = Cesium;
const e1 = (window.__e1 = { errors: [], frames: [], tilesets: [], ready: false });

window.addEventListener("error", (event) => {
  e1.errors.push("window.error: " + String(event.message || event.error));
});
window.addEventListener("unhandledrejection", (event) => {
  e1.errors.push("unhandledrejection: " + String(event.reason));
});
${preludeBlock}
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  globe: false,
  contextOptions: { ${contextOptionsSource} },
});
window.viewer = viewer;
const scene = viewer.scene;${postViewerBlock}

scene.skyAtmosphere.show = true;
${ambientOcclusionBlock}viewer.clock.currentTime = Cesium.JulianDate.fromIso8601("2024-11-22T18:00:00Z");
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-79.886626, 40.021649, 235.65),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-20), roll: 0 },
});

// Read the pipeline-cache counters through the PUBLIC statistics surface
// (\`GraphicsContext#getRendererStatistics\`, overridden by \`WebGPUContext\`),
// never through a private field. On WebGL the key is absent and every sample
// records null, which the summariser reports as "never sampled" rather than as
// a zero.
e1.readPipelineCache = function () {
  try {
    const context = scene.context;
    if (!context || typeof context.getRendererStatistics !== "function") {
      return null;
    }
    const stats = context.getRendererStatistics();
    const cache = stats && stats.pipelineCache;
    if (!cache || typeof cache !== "object" || cache.error) {
      return null;
    }
    return {
      hits: typeof cache.hits === "number" ? cache.hits : null,
      misses: typeof cache.misses === "number" ? cache.misses : null,
      created: typeof cache.created === "number" ? cache.created : null,
      pending: typeof cache.pending === "number" ? cache.pending : null,
    };
  } catch (error) {
    return null;
  }
};

// \`reached\` is the NON-VACUOUS predicate, not \`renderReady\` alone.
// \`Scene#renderReady\` reads true on a scene that has never rendered, so a leg
// that stalls can report renderReady true with zero frames; that record is the
// finding, and it must not be mistaken for readiness.
e1.readReadiness = function () {
  const commandList = scene.frameState && scene.frameState.commandList;
  const commandListLength = commandList ? commandList.length : 0;
  const renderReady = scene.renderReady === true;
  return {
    renderReady: renderReady,
    reached: renderReady && e1.frames.length >= 1 && commandListLength >= 1,
    framesProduced: e1.frames.length,
    commandListLength: commandListLength,
    pendingResourceCount:
      scene.context && typeof scene.context.pendingResourceCount === "number"
        ? scene.context.pendingResourceCount
        : null,
    sceneFrameNumber: scene.frameNumber,
  };
};

// One recorder, installed before any tileset exists, so the settle window is
// sampled from its first frame. \`postRender\` runs after the frame and before
// the next \`updateFrameState\` clears it, so \`commandList\` still holds this
// frame's commands.
let lastFrameAt = performance.now();
let lastCacheSampleAt = performance.now();
e1.recording = false;
e1.cacheSamples = [];

// The pipeline axis must be sampled on a WALL-CLOCK cadence, not only per
// frame. On the leg this row is about, frames arrive about 18 times in 75 s,
// so a per-frame reading samples 18 instants and never the intervals between
// them - which is where V-4 says the wait lives. Each sample carries the
// interval it terminates so a tick deferred behind a long task still accounts
// for all the time it covered.
e1.sampleCache = function () {
  const now = performance.now();
  e1.cacheSamples.push({
    atMs: now,
    sinceLastSampleMs: now - lastCacheSampleAt,
    pipelineCache: e1.readPipelineCache(),
  });
  lastCacheSampleAt = now;
};

e1.startRecording = function () {
  const now = performance.now();
  lastFrameAt = now;
  lastCacheSampleAt = now;
  e1.recording = true;
};
scene.postRender.addEventListener(function () {
  if (!e1.recording) {
    lastFrameAt = performance.now();
    return;
  }
  const now = performance.now();
  const commandList = scene.frameState && scene.frameState.commandList;
  e1.frames.push({
    index: e1.frames.length,
    frameNumber: scene.frameNumber,
    atMs: now,
    sinceLastFrameMs: now - lastFrameAt,
    commandListLength: commandList ? commandList.length : null,
    pipelineCache: e1.readPipelineCache(),
    renderReady: scene.renderReady === true,
  });
  lastFrameAt = now;
});

e1.addTilesets = async function (descriptors) {
  for (const descriptor of descriptors) {
    try {
      const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(descriptor.assetId);
      scene.primitives.add(tileset);
      tileset.show = descriptor.visible;
      if (descriptor.clipPositions && descriptor.clipPositions.length > 0) {
        tileset.clippingPolygons = new Cesium.ClippingPolygonCollection({
          polygons: [
            new Cesium.ClippingPolygon({
              positions: Cesium.Cartesian3.fromDegreesArray(
                descriptor.clipPositions,
              ),
            }),
          ],
        });
      }
      e1.tilesets.push({ title: descriptor.title, tileset: tileset });
    } catch (error) {
      e1.errors.push(descriptor.title + ": " + String(error && error.message));
    }
  }
};

e1.tilesetStatus = function () {
  return e1.tilesets.map(function (entry) {
    const statistics = entry.tileset.statistics || {};
    // The clipping state is a RUNTIME witness in the receipt, so a reader can
    // see that the scene carried the demo's site clip rather than take the
    // probe's word for it.
    const clipping = entry.tileset.clippingPolygons;
    return {
      title: entry.title,
      show: entry.tileset.show,
      clippingPolygonCount: clipping ? clipping.length : 0,
      tilesLoaded: entry.tileset.tilesLoaded === true,
      selected: statistics.selected ?? null,
      pendingRequests: statistics.numberOfPendingRequests ?? null,
      geometryBytes: statistics.geometryByteLength ?? null,
      texturesBytes: statistics.texturesByteLength ?? null,
      batchTableBytes: statistics.batchTableByteLength ?? null,
    };
  });
};

e1.descriptors = ${JSON.stringify(tilesets)};
e1.ready = true;
`;
}

/**
 * Run the settle window on one backend, with the profiler already attached.
 *
 * @param {object} input Page, CDP session and options.
 * @returns {Promise<object>} The leg's settle record.
 */
async function runSettleWindow({
  page,
  client,
  deadlineMs,
  samplingIntervalUs,
}) {
  await client.send("Profiler.enable");
  await client.send("Profiler.setSamplingInterval", {
    interval: samplingIntervalUs,
  });
  await client.send("HeapProfiler.enable").catch(() => {});
  await client
    .send("HeapProfiler.startSampling", { samplingInterval: 65536 })
    .catch(() => {});
  await client.send("Profiler.start");

  const startedAt = Date.now();
  await page.evaluate(() => {
    window.__e1.startRecording();
  });
  await page.evaluate(() => window.__e1.addTilesets(window.__e1.descriptors));

  const settle = await page.evaluate(async (deadline) => {
    const e1 = window.__e1;
    const start = performance.now();
    let stableSince = performance.now();
    let previousSelected = -1;
    // The page timestamp readiness was FIRST observed at, in the same clock as
    // the frame and poll samples. The returned `waitedMs` measures the whole
    // gate — readiness plus every tileset loaded plus a stable selection — so
    // it cannot answer "when did this scene become ready" on its own.
    let readinessReachedAtMs = null;
    while (performance.now() - start < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      e1.sampleCache();
      const status = e1.tilesetStatus();
      const selected = status.reduce(
        (sum, row) => sum + (row.selected ?? 0),
        0,
      );
      const pending = status.reduce(
        (sum, row) => sum + (row.pendingRequests ?? 0),
        0,
      );
      const allLoaded = status.every((row) => row.tilesLoaded === true);
      if (selected !== previousSelected) {
        previousSelected = selected;
        stableSince = performance.now();
      }
      const readiness = e1.readReadiness();
      if (readinessReachedAtMs === null && readiness.reached === true) {
        readinessReachedAtMs = performance.now();
      }
      if (
        readiness.reached === true &&
        allLoaded &&
        pending === 0 &&
        performance.now() - stableSince > 4000
      ) {
        return {
          stalled: false,
          waitedMs: performance.now() - start,
          readinessReachedAtMs,
        };
      }
    }
    return {
      stalled: true,
      waitedMs: performance.now() - start,
      readinessReachedAtMs,
    };
  }, deadlineMs);

  await page.evaluate(() => {
    window.__e1.recording = false;
  });

  const { profile } = await client.send("Profiler.stop");
  let heapSampling;
  try {
    const stopped = await client.send("HeapProfiler.stopSampling");
    heapSampling = aggregateHeapSamplingProfile(stopped?.profile ?? stopped);
  } catch (error) {
    heapSampling = { error: String(error?.message ?? error).slice(0, 200) };
  }

  const frames = await page.evaluate(() => window.__e1.frames);
  const cacheSamples = await page.evaluate(() => window.__e1.cacheSamples);
  const readiness = await page.evaluate(() => window.__e1.readReadiness());
  const tilesetStatus = await page.evaluate(() => window.__e1.tilesetStatus());
  const errors = await page.evaluate(() => window.__e1.errors);

  return {
    settleWindowMs: Math.round(Date.now() - startedAt),
    stalled: settle.stalled,
    // Carried for a caller that needs readiness itself rather than the whole
    // stability gate. This probe's own receipt does not read it.
    readinessReachedAtMs: settle.readinessReachedAtMs ?? null,
    profile,
    frames,
    cacheSamples,
    readiness,
    tilesetStatus,
    heapSampling,
    pageErrors: errors,
  };
}

/**
 * Stream a full heap snapshot to disk without parsing it.
 *
 * @param {object} client CDP session.
 * @param {string} filePath Destination.
 * @returns {Promise<object>} Bytes written, or an error record.
 */
async function streamHeapSnapshot(client, filePath) {
  return new Promise((resolve) => {
    let bytes = 0;
    const stream = createWriteStream(filePath);
    const onChunk = (event) => {
      bytes += event.chunk.length;
      stream.write(event.chunk);
    };
    client.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
    client
      .send("HeapProfiler.takeHeapSnapshot", {
        reportProgress: false,
        captureNumericValue: false,
      })
      .then(() => {
        client.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
        stream.end(() => resolve({ path: filePath, bytes }));
      })
      .catch((error) => {
        client.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
        stream.end(() =>
          resolve({ error: String(error?.message ?? error).slice(0, 200) }),
        );
      });
  });
}

/**
 * Search for a screen position that returns a `Cesium3DTileFeature`.
 *
 * @param {object} page Playwright page.
 * @returns {Promise<object>} The search result.
 */
async function findValidatedPick(page) {
  return page.evaluate(async () => {
    const Cesium = window.Cesium;
    const scene = window.viewer.scene;
    const width = scene.canvas.clientWidth;
    const height = scene.canvas.clientHeight;
    const position = new Cesium.Cartesian2();
    const tried = [];
    for (let row = 0; row < 5; row++) {
      for (let column = 0; column < 5; column++) {
        position.x = Math.round(width * (0.3 + 0.1 * column));
        position.y = Math.round(height * (0.35 + 0.08 * row));
        scene.pick(position);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const picked = scene.pick(position);
        const hit = picked instanceof Cesium.Cesium3DTileFeature;
        tried.push({ x: position.x, y: position.y, hit });
        if (hit) {
          return { found: true, x: position.x, y: position.y, tried };
        }
      }
    }
    return { found: false, x: null, y: null, tried };
  });
}

/**
 * Confirm that a position validated on one backend also returns a feature on
 * this one, without searching for a different position.
 *
 * @param {object} page Playwright page.
 * @param {{x: number, y: number}} pick The shared position.
 * @returns {Promise<{hit: boolean}>} Whether it hits here too.
 */
async function confirmPickPosition(page, pick) {
  return page.evaluate(
    async ([x, y]) => {
      const Cesium = window.Cesium;
      const scene = window.viewer.scene;
      const position = new Cesium.Cartesian2(x, y);
      scene.pick(position);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const picked = scene.pick(position);
      return { hit: picked instanceof Cesium.Cesium3DTileFeature };
    },
    [pick.x, pick.y],
  );
}

/**
 * Equal-content phase: frame cost, command-list length and pick cost at one
 * shared position. Only ever called on a leg that reached readiness.
 *
 * EVERY WAIT HERE IS BOUNDED. This phase waits on frames and on
 * `requestAnimationFrame` from a scene that has just been observed struggling to
 * produce frames at all, so an unbounded wait is not a theoretical hazard: a leg
 * that reaches readiness and then stops presenting would hang the probe with no
 * output. Both waits expire into PARTIAL samples plus a `timedOut` flag, which
 * the receipt and the summary carry, rather than into silence.
 *
 * @param {object} input Page, sample counts and the phase deadline.
 * @returns {Promise<object>} The measurement.
 */
async function measureEqualContent({
  page,
  sampleFrames,
  pickSamples,
  pick,
  deadlineMs,
}) {
  const frames = await page.evaluate(
    async ([count, deadline]) => {
      const scene = window.viewer.scene;
      const deltas = [];
      const commands = [];
      let last = performance.now();
      let remaining = count;
      const started = performance.now();
      const timedOut = await new Promise((resolve) => {
        let timer = null;
        const finish = (expired) => {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          scene.postRender.removeEventListener(listener);
          resolve(expired);
        };
        const listener = () => {
          const now = performance.now();
          deltas.push(now - last);
          last = now;
          const commandList = scene.frameState && scene.frameState.commandList;
          commands.push(commandList ? commandList.length : null);
          remaining--;
          if (remaining <= 0) {
            finish(false);
          }
        };
        scene.postRender.addEventListener(listener);
        timer = setTimeout(() => finish(true), deadline);
      });
      // The first delta is measured from before the phase began, so it is
      // dropped whether the phase completed or expired.
      deltas.shift();
      commands.shift();
      return {
        deltas,
        commands,
        timedOut,
        requestedFrames: count - 1,
        waitedMs: performance.now() - started,
      };
    },
    [sampleFrames + 1, deadlineMs],
  );

  const picks = await page.evaluate(
    async ([x, y, count, deadline]) => {
      const Cesium = window.Cesium;
      const scene = window.viewer.scene;
      const position = new Cesium.Cartesian2();
      const times = [];
      const expiresAt = performance.now() + deadline;
      let hits = 0;
      let timedOut = false;
      for (let index = 0; index < count; index++) {
        if (performance.now() >= expiresAt) {
          timedOut = true;
          break;
        }
        position.x = x + (index % 5) - 2;
        position.y = y + (((index / 5) | 0) % 5) - 2;
        const started = performance.now();
        const picked = scene.pick(position);
        times.push(performance.now() - started);
        if (picked instanceof Cesium.Cesium3DTileFeature) {
          hits++;
        }
        // A presented frame is preferred, but a scene that stops presenting
        // must not park the loop here forever.
        await new Promise((resolve) => {
          let settled = false;
          const settle = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          requestAnimationFrame(settle);
          setTimeout(settle, 1000);
        });
      }
      return { times, hits, samples: times.length, requested: count, timedOut };
    },
    [pick.x, pick.y, pickSamples, deadlineMs],
  );

  return {
    frameDeltaMs: p50P95(frames.deltas),
    commandListLength: p50P95(frames.commands),
    pickMs: p50P95(picks.times),
    pickHits: picks.hits,
    pickSamples: picks.samples,
    requestedFrames: frames.requestedFrames,
    requestedPickSamples: picks.requested,
    frameWaitMs: Math.round(frames.waitedMs),
    timedOut: frames.timedOut === true || picks.timedOut === true,
  };
}

/**
 * Drive one backend end to end.
 *
 * @param {object} input Browser, options and shared state.
 * @returns {Promise<object>} The leg record.
 */
async function runLeg({
  browser,
  backend,
  options,
  origin,
  outputDirectory,
  sharedPick,
  entryContext,
}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  const consoleLines = [];
  // What the page ACTUALLY loaded from this origin, so the receipt can state
  // which of those bytes the preflight proved rather than implying all of them.
  const loadedUrls = new Set();
  page.on("response", (response) => {
    const url = response.url();
    if (url.startsWith(origin) && loadedUrls.size < 500) {
      loadedUrls.add(url);
    }
  });
  page.on("console", (message) =>
    consoleLines.push(`${message.type()}: ${message.text()}`.slice(0, 300)),
  );
  page.on("pageerror", (error) =>
    consoleLines.push(`pageerror: ${error.message}`.slice(0, 300)),
  );

  const leg = { backend, entry: options.entry };
  try {
    await page.route(`**${HARNESS_PATH}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: harnessHtml(entryContext.stylesheetUrl),
      }),
    );
    await page.goto(`${origin}${HARNESS_PATH}`, {
      waitUntil: "domcontentloaded",
    });
    throwForDecision(
      decideOriginRefusal({ requestedOrigin: origin, actualUrl: page.url() }),
      "the page did not stay on the requested origin",
    );

    await page.addScriptTag({
      type: "module",
      content: pageModule(
        options.entry,
        entryContext.baseUrl,
        backend,
        TILESETS,
      ),
    });
    await page.waitForFunction(
      () => window.__e1 && window.__e1.ready === true,
      {
        timeout: 150000,
      },
    );

    const client = await page.context().newCDPSession(page);
    const settle = await runSettleWindow({
      page,
      client,
      deadlineMs: options.settleDeadlineMs,
      samplingIntervalUs: options.samplingIntervalUs,
    });

    if (options.heapSnapshot) {
      leg.heapSnapshotFile = await streamHeapSnapshot(
        client,
        path.join(outputDirectory, `heap-${backend}.heapsnapshot`),
      );
    }
    await client.detach().catch(() => {});

    leg.settleWindowMs = settle.settleWindowMs;
    leg.stalled = settle.stalled;
    leg.readiness = settle.readiness;
    leg.tilesetStatus = settle.tilesetStatus;
    leg.heapSampling = settle.heapSampling;
    leg.pageErrors = settle.pageErrors;

    throwForDecision(
      decideReadinessRefusal(settle.readiness),
      "the readiness observation contradicts itself",
    );

    leg.classification = classifySettleWindow({
      profile: settle.profile,
      frameSamples: settle.frames,
      cacheSamples: settle.cacheSamples,
      windowMs: settle.settleWindowMs,
    });
    leg.frameSamples = settle.frames;
    leg.cacheSamples = settle.cacheSamples;

    // The equal-content phase runs only on a leg that reached a NON-VACUOUS
    // readiness. A leg that never became ready records the stall and skips the
    // comparison rather than contributing a number taken inside a zero-frame
    // window — the defect that voided the 2026-08-29 pick ratio (Cirdan C-6).
    if (settle.readiness.reached === true) {
      if (sharedPick) {
        // The second leg does not run its own search: it must accept or reject
        // the FIRST leg's position, so both legs are pinned to one pixel.
        const confirmed = await confirmPickPosition(page, sharedPick);
        leg.pickSearch = {
          source: "shared-from-first-ready-leg",
          found: confirmed.hit,
          position: sharedPick,
        };
        if (confirmed.hit) {
          leg.validatedPick = { ...sharedPick };
        }
      } else {
        const discovered = await findValidatedPick(page);
        leg.pickSearch = {
          source: "search",
          found: discovered.found,
          tried: discovered.tried,
        };
        if (discovered.found) {
          leg.validatedPick = { x: discovered.x, y: discovered.y };
        }
      }

      if (leg.validatedPick) {
        leg.equalContent = await measureEqualContent({
          page,
          sampleFrames: options.sampleFrames,
          pickSamples: options.pickSamples,
          pick: leg.validatedPick,
          deadlineMs: options.equalContentDeadlineMs,
        });
      }
    }
    leg.console = consoleLines.slice(-40);
    leg.ok = true;
  } catch (error) {
    if (error instanceof E1RefusalError) {
      throw error;
    }
    leg.ok = false;
    leg.error = String(error?.message ?? error).slice(0, 400);
    leg.console = consoleLines.slice(-40);
  } finally {
    leg.moduleCoverage = summarizeModuleCoverage({
      loadedUrls: [...loadedUrls],
      requiredArtifacts: entryContext.requiredArtifacts,
      origin,
    });
    await context.close().catch(() => {});
  }
  return leg;
}

/**
 * Entry point.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Promise<number>} Exit code.
 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot =
    options.repositoryRoot ?? path.resolve(here, "..", "..");
  const outputDirectory =
    options.outputDirectory ??
    path.join(
      repositoryRoot,
      "Tools",
      "visual-regression",
      "output",
      "dm09-e1",
    );
  mkdirSync(outputDirectory, { recursive: true });

  const origin = `http://localhost:${options.port}`;
  // The bytes proven are the bytes this entry loads, plus the sibling
  // `Cesium.js` of the same build as a staleness witness. A fixed unminified
  // list would prove bytes a `--entry /Build/Cesium/index.js` run never loads.
  const entryContext = deriveEntryContext(options.entry);
  const { preflightServedBuildArtifacts } =
    await import("./lib/served-build-preflight.mjs");
  const preflight = await preflightServedBuildArtifacts({
    origin,
    repositoryRoot,
    artifacts: entryContext.requiredArtifacts,
  });
  throwForDecision(
    decidePreflightRefusal(preflight, entryContext.requiredArtifacts),
    "served-build preflight did not match the on-disk bundles",
  );

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    channel: "msedge",
    headless: !options.headed,
  });

  const order = options.reverse ? ["webgpu", "webgl"] : ["webgl", "webgpu"];
  const legs = [];
  let sharedPick = null;
  try {
    for (const backend of order) {
      const leg = await runLeg({
        browser,
        backend,
        options,
        origin,
        outputDirectory,
        sharedPick,
        entryContext,
      });
      legs.push(leg);
      if (!sharedPick && leg.validatedPick) {
        sharedPick = leg.validatedPick;
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const equalContentDecision = decideEqualContentRefusal({ legs });
  const equalContent = equalContentDecision.refuse
    ? {
        refused: true,
        reason: equalContentDecision.reason,
        details: equalContentDecision.details,
      }
    : {
        refused: false,
        validatedPick: legs[0].validatedPick,
        byBackend: Object.fromEntries(
          legs.map((leg) => [leg.backend, leg.equalContent ?? null]),
        ),
      };

  const receipt = buildReceipt({
    startedAt: new Date().toISOString(),
    origin,
    entry: options.entry,
    entryContext,
    reverse: options.reverse,
    preflight,
    legs,
    equalContent,
  });

  const jsonPath = path.join(outputDirectory, "dm09-e1-receipt.json");
  const markdownPath = path.join(outputDirectory, "dm09-e1-summary.md");
  writeFileSync(jsonPath, `${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(markdownPath, buildMarkdownSummary(receipt));

  console.log(buildMarkdownSummary(receipt));
  console.log(`receipt: ${jsonPath}`);
  return legs.every((leg) => leg.ok === true)
    ? EXIT_CODES.OK
    : EXIT_CODES.ERROR;
}

// Shared with the follow-on residency measurement so it runs the SAME scene,
// the same readiness predicate, the same per-frame recorder and the same
// wall-clock cache poll. A second copy of this text would be a second
// definition of readiness, and the two measurements would stop being
// comparable the first time one of them was edited.
export { harnessHtml, pageModule, runSettleWindow, TILESETS, HARNESS_PATH };

function isMainModule() {
  const entry = process.argv[1];
  return (
    typeof entry === "string" &&
    import.meta.url === pathToFileURL(path.resolve(entry)).href
  );
}

if (isMainModule()) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      if (error instanceof E1RefusalError) {
        console.error(`REFUSED (${error.reason}): ${error.message}`);
        console.error(JSON.stringify(error.details ?? null, null, 2));
        process.exit(EXIT_CODES.REFUSAL);
      }
      console.error("[probe-aec-residency-e1] FATAL", error);
      process.exit(EXIT_CODES.ERROR);
    });
}
