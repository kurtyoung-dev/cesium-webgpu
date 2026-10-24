/**
 * The page side of the landing program's performance leg: the startup
 * timeline, a window of per-frame times, and a window of per-pass GPU cost,
 * each sampled from a staged CesiumViewer page that the probe renders frame by
 * frame.
 * @purpose Step piece for the R-2026-10-22-3 performance leg (PF-1..PF-4 inputs): in-page samplers for the startup timeline (first frame, first frame with clouds drawn, tiles loaded, in navigation-relative page time), per-frame times from scene.render to the device reporting the work done, CesiumDebug.gpuPassCost over its own window, and the renderer's cache statistics; plus the Node-side sequence that renders the warm-up first and then brackets exactly the measured frame window with two GPU device census snapshots.
 * @status ACTIVE
 *
 * THE PAGE RENDERS ONLY WHEN ASKED. `lib/landing-cell-stage.mjs` stops the
 * viewer's own render loop, so every frame here is one `scene.render(time)`
 * at the pinned clock followed by one animation frame, the shape every frame
 * driver in the kit uses. Nothing else draws between two samples.
 *
 * A FRAME TIME IS RENDER TO WORK DONE. On WebGPU the sampler awaits
 * `device.queue.onSubmittedWorkDone()` after the render (bounded by a
 * timeout, which is counted, never hidden); on WebGL it reads one pixel back,
 * which cannot return before the frame's commands have run. So `frameMs`
 * measures the frame's CPU and GPU work, not the display's refresh interval,
 * which an animation-frame cadence alone would measure on a fast scene.
 * `cpuMs` (the render call alone) is kept beside it.
 *
 * PER-PASS COST HAS ITS OWN WINDOW. Timestamp queries cost GPU time, so
 * `CesiumDebug.gpuPassCost(true)` is switched on only after the frame-time
 * window, for a second window, and switched off again; PF-1's frames never
 * carry the profiler.
 *
 * THE STARTUP TIMELINE is read in page time: `performance.now()` is measured
 * from the document's navigation start, so `firstCloudFrameAtMs` is already
 * "navigation to the first frame with clouds drawn". A frame has clouds drawn
 * when the WebGPU cloud cache is initialised with a pipeline and its march
 * dispatched at least one pixel in that frame (`_cloudCache.observability`,
 * the reading the 2026-09-26 E4 driver used); a scene without clouds never
 * sets it.
 *
 * Every page function is self-contained: it reads only its argument and the
 * page's globals (`window.viewer`, `window.CesiumDebug`).
 *
 * @module Tools/visual-regression/lib/frame-timing-steps
 */

/**
 * PAGE SIDE. Render frame by frame from now until the first frame, the first
 * frame with clouds drawn (when `expectClouds`) and the globe's tiles loaded
 * have all been seen, or until `maxFrames` or `deadlineMs`.
 *
 * @param {{maxFrames: number, deadlineMs: number, expectClouds: boolean,
 *   stagedAtMs: number|null, viewerReadyAtMs: number|null}} args
 * @returns {Promise<{viewerReadyAtMs: number|null, stagedAtMs: number|null,
 *   firstFrameAtMs: number|null, firstCloudFrameAtMs: number|null,
 *   tilesLoadedAtMs: number|null, frames: number, outcome: string,
 *   error?: string}>} `outcome` is `done`, `frame-cap`, `deadline` or
 *   `render-error`.
 */
export async function pageMeasureStartup({
  maxFrames,
  deadlineMs,
  expectClouds,
  stagedAtMs,
  viewerReadyAtMs,
}) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const scene = viewer.scene;
  const started = performance.now();
  const result = {
    viewerReadyAtMs: viewerReadyAtMs ?? null,
    stagedAtMs: stagedAtMs ?? null,
    firstFrameAtMs: null,
    firstCloudFrameAtMs: null,
    tilesLoadedAtMs: null,
    frames: 0,
    outcome: "frame-cap",
  };
  const cloudsDrawn = () => {
    const cache = scene.context && scene.context._cloudCache;
    if (!cache || cache.initialized !== true || !cache.pipeline) {
      return false;
    }
    const observed = cache.observability;
    return !!observed && (observed.marchPixels ?? 0) > 0;
  };
  while (result.frames < maxFrames) {
    if (performance.now() - started > deadlineMs) {
      result.outcome = "deadline";
      break;
    }
    try {
      scene.render(viewer.clock.currentTime);
    } catch (error) {
      result.outcome = "render-error";
      result.error = String(error && error.message ? error.message : error);
      break;
    }
    result.frames++;
    const at = performance.now();
    if (result.firstFrameAtMs === null) {
      result.firstFrameAtMs = at;
    }
    if (expectClouds && result.firstCloudFrameAtMs === null && cloudsDrawn()) {
      result.firstCloudFrameAtMs = at;
    }
    if (
      result.tilesLoadedAtMs === null &&
      scene.globe &&
      scene.globe.tilesLoaded
    ) {
      result.tilesLoadedAtMs = at;
    }
    if (
      result.tilesLoadedAtMs !== null &&
      (!expectClouds || result.firstCloudFrameAtMs !== null)
    ) {
      result.outcome = "done";
      break;
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return result;
}

/**
 * PAGE SIDE. Render `warmupFrames` unmeasured frames, then `frames` measured
 * ones, each timed from the render call to the frame's work done.
 *
 * @param {{frames: number, warmupFrames: number, workDoneTimeoutMs: number}} args
 * @returns {Promise<{renderer: string, frameMs: number[], cpuMs: number[],
 *   workDoneTimeouts: number, outcome: string, error?: string}>}
 */
export async function pageSampleFrameTimes({
  frames,
  warmupFrames,
  workDoneTimeoutMs,
}) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const scene = viewer.scene;
  const context = scene.context;
  const device = context && context._device;
  const gl = context && context._gl;
  const renderer = device ? "webgpu" : gl ? "webgl" : "unknown";
  const pixel = new Uint8Array(4);
  const result = {
    renderer,
    frameMs: [],
    cpuMs: [],
    workDoneTimeouts: 0,
    outcome: "done",
  };
  const waitForWork = async () => {
    if (device) {
      const done = await Promise.race([
        device.queue.onSubmittedWorkDone().then(() => true),
        new Promise((resolve) =>
          setTimeout(() => resolve(false), workDoneTimeoutMs),
        ),
      ]);
      if (!done) {
        result.workDoneTimeouts++;
      }
    } else if (gl) {
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    }
  };
  try {
    for (let i = 0; i < warmupFrames + frames; i++) {
      const t0 = performance.now();
      scene.render(viewer.clock.currentTime);
      const t1 = performance.now();
      await waitForWork();
      const t2 = performance.now();
      if (i >= warmupFrames) {
        result.cpuMs.push(t1 - t0);
        result.frameMs.push(t2 - t0);
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  } catch (error) {
    result.outcome = "render-error";
    result.error = String(error && error.message ? error.message : error);
  }
  return result;
}

/**
 * PAGE SIDE. Switch the per-pass GPU profiler on (which resets it), render
 * `frames` frames waiting for each frame's work, render `drainFrames` more so
 * the last readbacks resolve, read `CesiumDebug.gpuPassCost()` and switch the
 * profiler off.
 *
 * @param {{frames: number, drainFrames: number, workDoneTimeoutMs: number}} args
 * @returns {Promise<object>} A JSON-safe copy of the profiler's result, or
 *   `{available: false, reason}` on WebGL, without CesiumDebug, or when the
 *   profiler returns nothing (no `timestamp-query` on the adapter).
 */
export async function pageSampleGpuPassCost({
  frames,
  drainFrames,
  workDoneTimeoutMs,
}) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const debug = /** @type {any} */ (globalThis).CesiumDebug;
  const scene = viewer.scene;
  const device = scene.context && scene.context._device;
  if (!device) {
    return { available: false, reason: "not a WebGPU context" };
  }
  if (!debug || typeof debug.gpuPassCost !== "function") {
    return {
      available: false,
      reason: "window.CesiumDebug.gpuPassCost is absent",
    };
  }
  const quiet = console.log;
  let results;
  try {
    debug.gpuPassCost(true);
    for (let i = 0; i < frames + drainFrames; i++) {
      scene.render(viewer.clock.currentTime);
      await Promise.race([
        device.queue.onSubmittedWorkDone(),
        new Promise((resolve) => setTimeout(resolve, workDoneTimeoutMs)),
      ]);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    // The command prints a table on every call; the result is what is kept.
    console.log = () => {};
    results = debug.gpuPassCost();
  } catch (error) {
    return {
      available: false,
      reason: `gpuPassCost threw: ${String(error && error.message ? error.message : error)}`,
    };
  } finally {
    console.log = quiet;
    try {
      debug.gpuPassCost(false);
    } catch {
      // Switching off a profiler that never switched on is not a measurement.
    }
  }
  if (!results || typeof results !== "object") {
    return {
      available: false,
      reason:
        "gpuPassCost returned nothing (profiler off or no timestamp-query)",
    };
  }
  return JSON.parse(JSON.stringify(results));
}

/**
 * PAGE SIDE. The renderer's cache statistics that bear on startup: the render
 * pipeline cache and the WGSL module census. WebGPU only.
 *
 * @returns {{pipelineCache: object|null, shaderModuleCache: object|null}}
 */
export function pageReadRendererStatistics() {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const context = viewer && viewer.scene && viewer.scene.context;
  if (!context || typeof context.getRendererStatistics !== "function") {
    return { pipelineCache: null, shaderModuleCache: null };
  }
  try {
    const stats = context.getRendererStatistics();
    const copy = (value) =>
      value && typeof value === "object"
        ? JSON.parse(JSON.stringify(value))
        : null;
    return {
      pipelineCache: copy(stats.pipelineCache),
      shaderModuleCache: copy(stats.shaderModuleCache),
    };
  } catch (error) {
    return {
      pipelineCache: null,
      shaderModuleCache: null,
      error: String(error && error.message ? error.message : error),
    };
  }
}

/**
 * NODE SIDE. One performance window on a staged, settled page: the warm-up
 * frames, a census snapshot, the measured frame-time window, a second census
 * snapshot, then the per-pass window. The warm-up renders BEFORE the first
 * snapshot, so the two snapshots bracket exactly the frames PF-1 timed and
 * PF-4's growth is the growth over that steady window, not over the warm-up
 * (Ettenmoors pass 1, D5).
 *
 * @param {object} args
 * @param {{evaluate: Function}} args.page
 * @param {(page: object) => Promise<object>} args.readCensus Usually
 *   `readGpuDeviceCensus` from `lib/gpu-device-census.mjs`.
 * @param {number} args.frames The PF-1 window (the same on both arms).
 * @param {number} args.warmupFrames Unmeasured frames before it.
 * @param {number} args.passFrames The PF-2 window.
 * @param {number} [args.drainFrames] Frames after the PF-2 window for the last
 *   timestamp readbacks (default 8).
 * @param {number} [args.workDoneTimeoutMs] Per-frame bound (default 10000).
 * @returns {Promise<{warmup: object|null, frameTimes: object,
 *   census: {start: object, end: object}, passCost: object}>}
 */
export async function measureLandingPerformance({
  page,
  readCensus,
  frames,
  warmupFrames,
  passFrames,
  drainFrames = 8,
  workDoneTimeoutMs = 10000,
}) {
  const warmup =
    warmupFrames > 0
      ? await page.evaluate(pageSampleFrameTimes, {
          frames: 0,
          warmupFrames,
          workDoneTimeoutMs,
        })
      : null;
  const start = await readCensus(page);
  const frameTimes = await page.evaluate(pageSampleFrameTimes, {
    frames,
    warmupFrames: 0,
    workDoneTimeoutMs,
  });
  const end = await readCensus(page);
  const passCost =
    passFrames > 0
      ? await page.evaluate(pageSampleGpuPassCost, {
          frames: passFrames,
          drainFrames,
          workDoneTimeoutMs,
        })
      : { available: false, reason: "no per-pass window was requested" };
  return { warmup, frameTimes, census: { start, end }, passCost };
}
