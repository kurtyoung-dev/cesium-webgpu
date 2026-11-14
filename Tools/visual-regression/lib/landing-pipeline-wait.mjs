/**
 * The landing stage's pending-pipeline wait. Signed Legolin.
 * @purpose Page-side reader of the WebGPU render pipeline cache's pending count (`pageReadPendingPipelines`), the page-side wait that drives frames at the frozen clock until the cache reads 0 pending (`pageWaitForPendingPipelines`) and the Node-side read of the count (`readPendingPipelines`), for the landing stage's opt-in `waitForPendingPipelines` option and for the probes that use them (a probe that hands a page function to `page.evaluate` imports it from this module; Node-side callers may import through `lib/landing-cell-stage.mjs`).
 * @status ACTIVE
 *
 * WHY A SEPARATE PIECE. The three functions are one cohesive block: the reader
 * is serialised as source text into the wait, and the Node-side function only
 * evaluates the reader. Nothing here reads a rig or a dial. The stage
 * re-exports all three for callers in Node. A module that hands
 * `pageReadPendingPipelines` or `pageWaitForPendingPipelines` to
 * `page.evaluate` imports it from here: the page-scope analyzer
 * (`probe-fleet-contract.spec.mjs`, case G4) follows one import hop and
 * needs the literal function, which a re-export does not hold. The defaults
 * of the wait (`PIPELINE_WAIT_DEFAULTS`) and the decision to wait
 * (`stageLandingCell`) stay in the stage.
 *
 * SELF-CONTAINED PAGE FUNCTIONS. `page.evaluate` serialises a function, so the
 * page-side functions here reference no module-scope binding; the wait takes
 * the reader as source text (`readerSource`).
 *
 * @module Tools/visual-regression/lib/landing-pipeline-wait
 */

/**
 * PAGE SIDE. The render pipeline cache's pending count, read from the
 * renderer statistics `CesiumDebug.cacheStats()` reports (`pipelineCache`,
 * `detail: pending=`). Read through `context.getRendererStatistics()` rather
 * than `cacheStats()` itself, because `cacheStats()` prints a console table on
 * every call and the probe reads the page console for errors. Self-contained.
 *
 * @returns {{available: boolean, rendererType: string|null,
 *   pending: number|null, created: number|null, reason?: string}}
 */
export function pageReadPendingPipelines() {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const context = viewer && viewer.scene && viewer.scene.context;
  const rendererType = context
    ? String(
        context.rendererType || (context.isWebGPU ? "webgpu" : "webgl"),
      ).toLowerCase()
    : null;
  if (!context || !context.isWebGPU) {
    return {
      available: false,
      rendererType,
      pending: null,
      created: null,
      reason: "the render pipeline cache is WebGPU-only",
    };
  }
  if (typeof context.getRendererStatistics !== "function") {
    return {
      available: false,
      rendererType,
      pending: null,
      created: null,
      reason: "the context exposes no getRendererStatistics",
    };
  }
  try {
    const cache = context.getRendererStatistics().pipelineCache;
    const pending =
      cache && Number.isFinite(cache.pending) ? cache.pending : null;
    return {
      available: true,
      rendererType,
      pending,
      created: cache && Number.isFinite(cache.created) ? cache.created : null,
      ...(pending === null
        ? { reason: "no pipeline cache statistics yet (no frame rendered)" }
        : {}),
    };
  } catch (error) {
    return {
      available: false,
      rendererType,
      pending: null,
      created: null,
      reason: String(error && error.message ? error.message : error),
    };
  }
}

/**
 * PAGE SIDE (round 5, K5-2). Render frame by frame at the frozen clock until
 * the render pipeline cache has read 0 pending on `settleReads` consecutive
 * reads after at least one frame, or until `deadlineMs` / `maxFrames`. On a
 * page without the cache (WebGL) it renders nothing and says so. Self-contained
 * apart from its argument and the reader passed in as source text.
 *
 * @param {{deadlineMs: number, maxFrames: number, settleReads: number,
 *   readerSource: string}} args
 * @returns {Promise<{requested: true, available: boolean,
 *   pendingAtStart: number|null, pendingAtEnd: number|null,
 *   pendingMax: number|null, createdAtEnd: number|null, framesWaited: number,
 *   waitedMs: number, timedOut: boolean, reason?: string}>}
 */
export async function pageWaitForPendingPipelines({
  deadlineMs,
  maxFrames,
  settleReads,
  readerSource,
}) {
  // eslint-disable-next-line no-new-func
  const read = new Function(`return (${readerSource})();`);
  const viewer = /** @type {any} */ (globalThis).viewer;
  const started = performance.now();
  const first = read();
  const out = {
    requested: true,
    available: first.available,
    pendingAtStart: first.pending,
    pendingAtEnd: first.pending,
    pendingMax: first.pending,
    createdAtEnd: first.created,
    framesWaited: 0,
    waitedMs: 0,
    timedOut: false,
  };
  if (!first.available) {
    out.reason = first.reason;
    return out;
  }
  let zeroReads = 0;
  for (;;) {
    const now = read();
    out.pendingAtEnd = now.pending;
    out.createdAtEnd = now.created;
    if (now.pending !== null) {
      out.pendingMax = Math.max(out.pendingMax ?? 0, now.pending);
    }
    zeroReads = now.pending === 0 && out.framesWaited > 0 ? zeroReads + 1 : 0;
    if (zeroReads >= settleReads) {
      break;
    }
    if (
      out.framesWaited >= maxFrames ||
      performance.now() - started >= deadlineMs
    ) {
      out.timedOut = true;
      break;
    }
    viewer.scene.render(viewer.clock.currentTime);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    out.framesWaited++;
  }
  out.waitedMs = performance.now() - started;
  return out;
}

/**
 * NODE SIDE. The pending count now (see {@link pageReadPendingPipelines}).
 *
 * @param {{evaluate: Function}} page
 * @returns {Promise<object>}
 */
export function readPendingPipelines(page) {
  return page.evaluate(pageReadPendingPipelines);
}
