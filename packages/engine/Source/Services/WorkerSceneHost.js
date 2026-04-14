/**
 * @module WorkerSceneHost
 *
 * Main-thread wrapper that owns a renderer worker. Each instance
 * manages exactly one worker that runs an independent Cesium Scene
 * against an `OffscreenCanvas`. Multiple `WorkerSceneHost` instances
 * can coexist in the same page — split-screen, multi-view, or
 * dashboards with N independent renderers.
 *
 * The host:
 *   - Owns the parent `<div>` and creates a child `<canvas>` inside it
 *     (the parent should NOT contain other children that depend on
 *     positioning, since the host treats the parent as its sandbox).
 *   - Spawns a Web Worker, transfers the canvas's OffscreenCanvas to
 *     it, and posts an `init` message.
 *   - Sends commands (camera, input, entities) via postMessage AND
 *     records them in shadow state so a restart can replay them.
 *   - Polls the worker with heartbeat pings and detects unresponsive
 *     workers within `HEARTBEAT_INTERVAL_MS * HEARTBEAT_MAX_MISSED` ms.
 *   - On crash, terminates the worker, destroys the dead canvas,
 *     creates a fresh canvas, spawns a new worker, and replays state.
 *   - Exposes a `getLiveStats()` / `getLiveFrameTimeSnapshot()` API
 *     that satisfies the FpsOverlay data-source contract — the
 *     overlay can be pointed at the host directly, no extra plumbing.
 *
 * ── Crash recovery tiers ───────────────────────────────────────────
 *
 *   Tier 1 (in-thread): GPU device lost. The worker handles it
 *     internally via `WebGPUDeviceLossRecovery`. The host receives
 *     `deviceLost` then `deviceRestored` notifications and forwards
 *     them as events for the application UI.
 *
 *   Tier 2 (soft reset): worker is alive but the Scene is unhappy.
 *     The host posts `reset`. Worker tears down its Scene and asks
 *     the host for a state replay. Used for recoverable engine
 *     errors that don't merit a full canvas swap.
 *
 *   Tier 3 (hard restart): worker `error` event, `messageerror`,
 *     or heartbeat timeout. Host terminates the worker, destroys the
 *     dead canvas (because OffscreenCanvas can only be transferred
 *     once per DOM canvas), creates a fresh canvas inside the parent,
 *     spawns a new worker, replays shadow state.
 *
 * ── Circuit breaker ────────────────────────────────────────────────
 *
 * If the worker crashes more than `RESTART_BURST_MAX` times within
 * `RESTART_BURST_WINDOW_MS`, the host stops auto-restarting and emits
 * a hard `failure` event. The application is responsible for
 * surfacing this to the user — there's no point silently looping on
 * a deterministic crash because we'd just burn CPU forever.
 *
 * @private
 */

import defined from "../Core/defined.js";
import {
  MSG_INIT,
  MSG_RESIZE,
  MSG_SET_VIEW,
  MSG_REQUEST_RENDER,
  MSG_SET_REQUEST_RENDER_MODE,
  MSG_SET_MAX_FPS,
  MSG_SET_FEATURE_FLAGS,
  MSG_INPUT_EVENT,
  MSG_HEARTBEAT_PING,
  MSG_DUMP_DEBUG_SNAPSHOT,
  MSG_READY,
  MSG_STATS,
  MSG_REPLAY_REQUEST,
  MSG_HEARTBEAT_PONG,
  MSG_DEVICE_LOST,
  MSG_DEVICE_RESTORED,
  MSG_REPLY,
  MSG_LOG,
  MSG_ERROR,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSED,
  RESTART_BURST_MAX,
  RESTART_BURST_WINDOW_MS,
  RESTART_HARD_BACKOFF_MS,
} from "./WorkerSceneProtocol.js";

class WorkerSceneHost {
  /**
   * @param {object} options
   * @param {HTMLElement} options.parent The DOM container that will
   *   own the canvas. Should be `position: relative` and sized via
   *   CSS — the host stretches its canvas to fill it.
   * @param {string} [options.rendererType="webgpu"] One of "webgl",
   *   "webgpu". Determines what backend the worker initializes.
   * @param {object} [options.sceneOptions] Forwarded to the worker
   *   and applied as `new Scene({...sceneOptions})`. Must be
   *   structured-cloneable (no functions, no DOM refs).
   * @param {URL|string} [options.workerUrl] Override for the worker
   *   script URL. Defaults to the bundled `RendererWorker.js`.
   * @param {boolean} [options.autoRestart=true] Whether to attempt
   *   automatic crash recovery. Set to false during debugging so the
   *   developer can inspect the dead worker.
   * @param {function(object): void} [options.onReady] Called when the
   *   worker reports successful init.
   * @param {function(object): void} [options.onCrash] Called whenever
   *   the host detects a crash, BEFORE the recovery attempt.
   * @param {function(object): void} [options.onFailure] Called when
   *   the circuit breaker opens (auto-restart disabled after burst).
   * @param {function(object): void} [options.onStats] Called whenever
   *   the worker posts a stats message. The argument is the same
   *   shape returned by `getLiveStats()`.
   * @param {?number} [options.maxFps=null] Initial render-loop max FPS
   *   cap. Pass `null` (the default) for "no throttle" — the worker
   *   uses the display refresh rate via `requestAnimationFrame`. Pass
   *   a positive number to cap the frame rate. Pass `0` to uncap
   *   (bypass `requestAnimationFrame` and run as fast as the JS
   *   engine allows — useful for benchmarking). Pass a negative
   *   number to pause the render loop. The cap can be changed at
   *   runtime via `setMaxFps()`.
   *
   *   This is the worker-thread equivalent of the existing
   *   `CesiumWidget.targetFrameRate` / `Viewer.targetFrameRate`
   *   property — the worker host adds the `0` (uncapped) and
   *   negative (paused) modes that the in-thread version doesn't
   *   support, so benchmark traces and pause-on-snapshot workflows
   *   can drive the worker the same way regardless of which
   *   backend it's using.
   */
  constructor(options) {
    if (!defined(options) || !defined(options.parent)) {
      throw new Error("WorkerSceneHost requires options.parent");
    }
    this._parent = options.parent;
    this._rendererType = options.rendererType ?? "webgpu";
    this._sceneOptions = options.sceneOptions ?? {};
    this._workerUrl = options.workerUrl ?? null;
    this._autoRestart = options.autoRestart !== false;
    this._onReady = options.onReady ?? null;
    this._onCrash = options.onCrash ?? null;
    this._onFailure = options.onFailure ?? null;
    this._onStats = options.onStats ?? null;
    // Initial max FPS — null means "no throttle, ride vsync".
    // Validated lazily by the worker's `_setMaxFps` so any reasonable
    // input including null/undefined/negative reaches the worker
    // unchanged and gets the documented behavior there.
    this._maxFps = defined(options.maxFps) ? options.maxFps : null;

    this._worker = null;
    this._canvas = null;
    this._sessionId = 0;
    this._isReady = false;
    this._isDestroyed = false;

    // Heartbeat state
    this._heartbeatTimerId = null;
    this._lastPingId = 0;
    this._lastAckedPingId = 0;
    this._missedPongs = 0;

    // Restart burst tracking
    this._restartTimestamps = [];

    // Cached live stats. The host satisfies the FpsOverlay data
    // source contract by storing the latest stats payload + frame
    // time snapshot from the worker. The overlay polls and reads
    // these without further postMessage round trips.
    this._lastStats = null;
    this._lastFrameTimes = new Float32Array(0);

    // Shadow state — every host→worker command we want to be able to
    // replay after a crash gets recorded here. Initialized below by
    // _resetShadowState() so the field list is in one place.
    this._shadowState = null;
    this._resetShadowState();

    // Pending requests waiting for replies (debugSnapshot, future
    // pickAt). Keyed by an incrementing requestId.
    this._nextRequestId = 1;
    this._pendingRequests = new Map();

    this._spawnFreshWorker("initial-spawn");
    this._installResizeObserver();
  }

  // ─── Public API ─────────────────────────────────────────────────

  /** True once the worker has acked the init message. */
  get isReady() {
    return this._isReady;
  }

  /** Currently configured renderer backend. */
  get rendererType() {
    return this._rendererType;
  }

  /** The DOM container the host renders into. */
  get parent() {
    return this._parent;
  }

  /** The current child canvas (recreated on hard restart). */
  get canvas() {
    return this._canvas;
  }

  /**
   * Send the camera setView. The latest view is recorded in shadow
   * state so a restart restores it before resuming normal commands.
   * @param {object} view setView descriptor.
   */
  setView(view) {
    this._shadowState.lastView = view;
    this._post(MSG_SET_VIEW, { view });
  }

  /** Force a one-shot render even if requestRenderMode is on. */
  requestRender() {
    this._post(MSG_REQUEST_RENDER);
  }

  /** Toggle requestRenderMode on the worker scene. */
  setRequestRenderMode(enabled) {
    this._shadowState.requestRenderMode = !!enabled;
    this._post(MSG_SET_REQUEST_RENDER_MODE, { enabled: !!enabled });
  }

  /**
   * Get the current max FPS cap. See `setMaxFps` for the value
   * semantics. The returned value is the cap requested by the host;
   * the actual frame rate the worker achieves is reported via
   * `getLiveStats().avgFps`.
   * @returns {?number}
   */
  get maxFps() {
    return this._maxFps;
  }

  /**
   * Update the worker's render-loop max FPS cap at runtime. Recorded
   * in shadow state so a worker restart restores the cap before the
   * application sees the new worker.
   *
   * **Value semantics** (mirrors and extends
   * `CesiumWidget.targetFrameRate`):
   *
   *   - `null` / `undefined` — no throttle. The worker rides vsync
   *     via `requestAnimationFrame` (or a 60 fps `setTimeout`
   *     fallback on Firefox/Safari workers).
   *   - positive number — clamp the loop to at most this many fps.
   *     With rAF available, the loop wakes every vsync but skips
   *     callbacks that arrive too early; effective rate is
   *     `min(displayHz, value)`.
   *   - `0` — uncapped. Bypasses `requestAnimationFrame` entirely
   *     and uses `setTimeout(0)`. The loop runs as fast as the JS
   *     engine allows — useful for benchmarks where the question is
   *     "how fast can the GPU sustain frames without vsync getting
   *     in the way".
   *   - negative number — pause the loop. The next call lifting the
   *     cap (positive value, 0, or null) resumes rendering.
   *
   * Anything else (NaN, strings, objects) is coerced to `null` by
   * the worker so a mistyped console command can't wedge the loop.
   *
   * @param {?number} value
   *
   * @example
   * // Application option from a settings panel
   * host.setMaxFps(30);              // 30 fps cap
   * host.setMaxFps(null);            // back to vsync
   * host.setMaxFps(0);               // uncapped (benchmark mode)
   * host.setMaxFps(-1);              // pause render loop
   */
  setMaxFps(value) {
    this._maxFps = defined(value) ? value : null;
    this._shadowState.maxFps = this._maxFps;
    this._post(MSG_SET_MAX_FPS, { maxFps: this._maxFps });
  }

  /**
   * Phase 5 WGF-1/WGF-3: replicate opt-in feature flags to the worker's
   * `scene.context`. The worker applies them on receipt and they survive
   * restarts via shadow-state replay.
   *
   * @param {{ useHardwareClipDistances?: boolean, useShaderF16?: boolean }} flags
   */
  setFeatureFlags(flags) {
    if (!this._shadowState.featureFlags) {
      this._shadowState.featureFlags = {};
    }
    Object.assign(this._shadowState.featureFlags, flags);
    this._post(MSG_SET_FEATURE_FLAGS, flags);
  }

  /**
   * Forward a DOM input event to the worker. The host caller is
   * responsible for serializing the relevant fields out of the
   * native Event object — DOM Events themselves are not
   * structured-cloneable.
   * @param {string} kind "mousedown" | "mouseup" | "mousemove" | "wheel" | "keydown" | ...
   * @param {object} payload Event field bag (clientX, button, deltaY, etc.)
   */
  forwardInput(kind, payload) {
    this._post(MSG_INPUT_EVENT, { kind, payload });
  }

  /**
   * Async pull of the worker scene's debug snapshot. Resolves when
   * the worker replies. Rejects if the request times out or the
   * worker crashes before answering.
   * @returns {Promise<object>}
   */
  fetchDebugSnapshot() {
    return new Promise((resolve, reject) => {
      const requestId = this._nextRequestId++;
      const timeoutId = setTimeout(() => {
        if (this._pendingRequests.has(requestId)) {
          this._pendingRequests.delete(requestId);
          reject(new Error("debug snapshot request timed out"));
        }
      }, 5000);
      this._pendingRequests.set(requestId, {
        kind: "debugSnapshot",
        resolve,
        reject,
        timeoutId,
      });
      this._post(MSG_DUMP_DEBUG_SNAPSHOT, { requestId });
    });
  }

  // ─── FpsOverlay data source contract ───────────────────────────

  /**
   * Returns the most recent live stats payload from the worker, or
   * a zeroed-out struct if no stats have arrived yet. The shape
   * matches `PerformanceTracker.getLiveStats()` exactly so an
   * `FpsOverlay` can use the host as its data source unmodified.
   */
  getLiveStats() {
    if (this._lastStats !== null) {
      return this._lastStats;
    }
    return {
      windowSeconds: 60,
      sampleCount: 0,
      avgFps: 0,
      avgFrameMs: 0,
      onePercentLowFps: 0,
      onePercentHighFps: 0,
      minFrameMs: 0,
      maxFrameMs: 0,
      latestFrameMs: 0,
      latestFps: 0,
    };
  }

  /**
   * Returns the most recent frame-time snapshot received from the
   * worker. The returned typed array is the buffer that the worker
   * transferred — do not retain references across polls; the next
   * stats message replaces it.
   * @param {number} count Maximum number of samples to return.
   */
  getLiveFrameTimeSnapshot(count) {
    const src = this._lastFrameTimes;
    if (!count || count >= src.length) {
      return src;
    }
    return src.subarray(src.length - count);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  /**
   * Tear down the host: terminates the worker, removes the canvas,
   * stops timers, releases all DOM references. Idempotent.
   */
  destroy() {
    if (this._isDestroyed) {
      return;
    }
    this._isDestroyed = true;
    this._stopHeartbeat();
    this._stopResizeObserver();
    this._terminateWorker();
    this._destroyCanvas();
    // Reject any pending requests so callers don't hang forever.
    for (const [, pending] of this._pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("WorkerSceneHost destroyed"));
    }
    this._pendingRequests.clear();
    this._parent = null;
    this._lastStats = null;
    this._lastFrameTimes = new Float32Array(0);
  }

  // ─── Worker lifecycle ──────────────────────────────────────────

  _spawnFreshWorker(reason) {
    if (this._isDestroyed) {
      return;
    }
    this._sessionId++;
    this._isReady = false;
    this._missedPongs = 0;
    this._lastPingId = 0;
    this._lastAckedPingId = 0;
    this._buildCanvas();

    // Resolve the worker URL. RendererWorker.js lives in Source/Workers/
    // and is bundled by the existing `bundleWorkers` pipeline, which
    // emits it to `<outputDirectory>/Workers/RendererWorker.js` as a
    // sibling of `index.js` and `Cesium.js`. The default resolution
    // here uses `./Workers/RendererWorker.js` relative to whichever
    // file the host code is loaded from — for the bundled case
    // (index.js / Cesium.js), this lands on the right file.
    //
    // The unbundled / direct-from-source case (loading
    // `packages/engine/Source/Services/WorkerSceneHost.js` directly
    // in dev) needs a different relative path. Consumers in that mode
    // should pass `options.workerUrl` explicitly:
    //
    //   new WorkerSceneHost({
    //     parent,
    //     workerUrl: new URL("../Workers/RendererWorker.js", import.meta.url),
    //   });
    //
    // We do NOT auto-detect bundled vs unbundled because there's no
    // reliable runtime signal — both contexts have a file: or http:
    // URL that looks the same.
    let workerUrl = this._workerUrl;
    if (!workerUrl) {
      try {
        workerUrl = new URL("./Workers/RendererWorker.js", import.meta.url);
      } catch (e) {
        throw new Error(
          `WorkerSceneHost cannot resolve a default worker URL — pass ` +
            `options.workerUrl explicitly. (cause: ${e.message})`,
        );
      }
    }

    let worker;
    try {
      worker = new Worker(workerUrl, { type: "module" });
    } catch (e) {
      this._handleSpawnFailure(e);
      return;
    }
    this._worker = worker;

    worker.addEventListener("message", (event) =>
      this._handleWorkerMessage(event.data),
    );
    // Tier 3 trigger #1: synchronous error inside the worker.
    worker.addEventListener("error", (event) => {
      this._noteCrash("worker.onerror", {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
      });
    });
    // Tier 3 trigger #2: a message from the worker that couldn't be
    // structured-cloned. Treated as a hard restart because the
    // protocol is broken at this point.
    worker.addEventListener("messageerror", () => {
      this._noteCrash("worker.onmessageerror", null);
    });

    // Transfer the OffscreenCanvas to the freshly-spawned worker.
    // After this call, the main thread cannot touch the canvas
    // anymore until the worker dies and we recreate it.
    let offscreen;
    try {
      offscreen = this._canvas.transferControlToOffscreen();
    } catch (e) {
      this._handleSpawnFailure(e);
      return;
    }

    worker.postMessage(
      {
        type: MSG_INIT,
        canvas: offscreen,
        rendererType: this._rendererType,
        sceneOptions: this._sceneOptions,
        sessionId: this._sessionId,
        // Carry the current max FPS so the worker's first frame uses
        // the right cap. Subsequent changes flow via MSG_SET_MAX_FPS.
        maxFps: this._maxFps,
      },
      [offscreen],
    );

    this._startHeartbeat();
    // Diagnostic: print the spawn reason so a multi-restart sequence
    // is easy to read in the console.
    if (reason !== "initial-spawn") {
      console.warn(
        `[WorkerSceneHost] worker spawned (session ${this._sessionId}) reason=${reason}`,
      );
    }
  }

  _terminateWorker() {
    if (this._worker) {
      try {
        this._worker.terminate();
      } catch (e) {
        // ignore — worker may already be dead
      }
      this._worker = null;
    }
  }

  _handleSpawnFailure(err) {
    console.error("[WorkerSceneHost] worker spawn failed:", err);
    this._terminateWorker();
    if (this._onFailure) {
      this._onFailure({
        reason: "spawn-failure",
        error: err,
      });
    }
  }

  // ─── Canvas lifecycle ──────────────────────────────────────────

  _buildCanvas() {
    if (this._canvas) {
      this._destroyCanvas();
    }
    const canvas = document.createElement("canvas");
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    // Set the backing store to match the parent's current size so the
    // worker's first frame doesn't render at 1x1.
    const rect = this._parent.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    this._parent.appendChild(canvas);
    this._canvas = canvas;
  }

  _destroyCanvas() {
    if (this._canvas && this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    this._canvas = null;
  }

  _installResizeObserver() {
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    this._resizeObserver = new ResizeObserver(() => {
      if (!this._canvas || !this._isReady) {
        return;
      }
      const rect = this._parent.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      this._post(MSG_RESIZE, { width: w, height: h });
    });
    this._resizeObserver.observe(this._parent);
  }

  _stopResizeObserver() {
    if (this._resizeObserver) {
      try {
        this._resizeObserver.disconnect();
      } catch (e) {
        // ignore
      }
      this._resizeObserver = null;
    }
  }

  // ─── Heartbeat ────────────────────────────────────────────────

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimerId = setInterval(() => {
      this._sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimerId !== null) {
      clearInterval(this._heartbeatTimerId);
      this._heartbeatTimerId = null;
    }
  }

  _sendHeartbeat() {
    if (this._isDestroyed || !this._worker) {
      return;
    }
    // Check that the previous N pings have all been acked. If too
    // many are outstanding, the worker is hung — escalate to Tier 3
    // restart.
    const outstanding = this._lastPingId - this._lastAckedPingId;
    if (outstanding >= HEARTBEAT_MAX_MISSED) {
      this._noteCrash("heartbeat-timeout", {
        outstanding,
        lastPingId: this._lastPingId,
        lastAckedPingId: this._lastAckedPingId,
      });
      return;
    }
    this._lastPingId++;
    this._post(MSG_HEARTBEAT_PING, { id: this._lastPingId });
  }

  // ─── Crash handling ───────────────────────────────────────────

  _noteCrash(reason, detail) {
    if (this._isDestroyed) {
      return;
    }
    const ts = Date.now();
    // Drop expired restart timestamps so the burst window is rolling.
    const cutoff = ts - RESTART_BURST_WINDOW_MS;
    while (
      this._restartTimestamps.length > 0 &&
      this._restartTimestamps[0] < cutoff
    ) {
      this._restartTimestamps.shift();
    }
    this._restartTimestamps.push(ts);

    if (this._onCrash) {
      try {
        this._onCrash({
          reason,
          detail,
          burstCount: this._restartTimestamps.length,
          burstWindowMs: RESTART_BURST_WINDOW_MS,
        });
      } catch (e) {
        // ignore — host callbacks must not throw
      }
    }

    if (
      !this._autoRestart ||
      this._restartTimestamps.length > RESTART_BURST_MAX
    ) {
      // Circuit breaker open — give up.
      this._terminateWorker();
      if (this._onFailure) {
        try {
          this._onFailure({
            reason: "circuit-breaker-open",
            burstCount: this._restartTimestamps.length,
            lastReason: reason,
            detail,
          });
        } catch (e) {
          // ignore
        }
      }
      return;
    }

    // Tier 3 hard restart: tear down the worker and the dead canvas,
    // wait the backoff, then spawn fresh and replay shadow state.
    this._terminateWorker();
    this._stopHeartbeat();
    setTimeout(() => {
      if (this._isDestroyed) {
        return;
      }
      this._spawnFreshWorker(`restart:${reason}`);
    }, RESTART_HARD_BACKOFF_MS);
  }

  // ─── Shadow state ─────────────────────────────────────────────

  _resetShadowState() {
    this._shadowState = {
      lastView: null,
      requestRenderMode: false,
      // null = inherit constructor default; otherwise the last value
      // applied via `setMaxFps`. We seed this from `_maxFps` in the
      // constructor's _spawnFreshWorker call so the very first init
      // payload carries the right cap.
      maxFps: undefined,
      // Future: entities, imagery layers, terrain provider, etc.
      // The shape stays open so each new shadow field is one place
      // to add (here) and one place to replay (_replayShadowState).
    };
  }

  _replayShadowState() {
    if (!this._shadowState) {
      return;
    }
    if (this._shadowState.lastView) {
      this._post(MSG_SET_VIEW, { view: this._shadowState.lastView });
    }
    if (this._shadowState.requestRenderMode) {
      this._post(MSG_SET_REQUEST_RENDER_MODE, { enabled: true });
    }
    // Replay maxFps if a runtime change has been recorded. The init
    // payload already carried the constructor default, so we only
    // need to replay when the host has actively changed it.
    if (this._shadowState.maxFps !== undefined) {
      this._post(MSG_SET_MAX_FPS, { maxFps: this._shadowState.maxFps });
    }
    // Phase 5 WGF-1/WGF-3: replay opt-in feature flags so they
    // survive worker restarts (crash recovery, soft reset).
    if (this._shadowState.featureFlags) {
      this._post(MSG_SET_FEATURE_FLAGS, this._shadowState.featureFlags);
    }
  }

  // ─── Worker→Host messages ─────────────────────────────────────

  _handleWorkerMessage(data) {
    if (!data || typeof data.type !== "string") {
      return;
    }
    // Drop messages from a previous session — they crossed in flight
    // with our restart and would corrupt the state of the new worker.
    if (
      typeof data.sessionId === "number" &&
      data.sessionId !== this._sessionId
    ) {
      return;
    }
    switch (data.type) {
      case MSG_READY:
        this._isReady = true;
        // Send any shadow state to the freshly-spawned worker before
        // the application gets the ready callback. This way, by the
        // time onReady fires, the new worker is already showing the
        // last camera position.
        this._replayShadowState();
        if (this._onReady) {
          try {
            this._onReady(data);
          } catch (e) {
            // ignore
          }
        }
        break;
      case MSG_STATS:
        this._lastStats = data.stats;
        if (data.frameTimes instanceof Float32Array) {
          this._lastFrameTimes = data.frameTimes;
        }
        if (this._onStats) {
          try {
            this._onStats(data.stats);
          } catch (e) {
            // ignore
          }
        }
        break;
      case MSG_HEARTBEAT_PONG:
        if (typeof data.pingId === "number") {
          this._lastAckedPingId = Math.max(this._lastAckedPingId, data.pingId);
        }
        break;
      case MSG_REPLAY_REQUEST:
        // Soft reset path: worker is alive but asked us to resend
        // shadow state. We re-emit it now without restarting the
        // worker.
        this._replayShadowState();
        break;
      case MSG_DEVICE_LOST:
        console.warn("[WorkerSceneHost] GPU device lost (worker recovering)");
        break;
      case MSG_DEVICE_RESTORED:
        console.info("[WorkerSceneHost] GPU device restored");
        break;
      case MSG_REPLY:
        if (typeof data.requestId === "number") {
          const pending = this._pendingRequests.get(data.requestId);
          if (pending) {
            this._pendingRequests.delete(data.requestId);
            clearTimeout(pending.timeoutId);
            if (data.error) {
              pending.reject(new Error(data.error));
            } else {
              pending.resolve(data);
            }
          }
        }
        break;
      case MSG_LOG:
        console.log(`[Worker:${data.level ?? "log"}] ${data.message ?? ""}`);
        break;
      case MSG_ERROR:
        // A non-fatal worker error. We log + count it but don't
        // restart on a single occurrence — the worker self-reported
        // and is presumably still alive. The heartbeat is the
        // ultimate authority on whether to escalate.

        console.error(
          `[WorkerSceneHost] worker error (${data.phase ?? "?"}): ${
            data.message
          }`,
        );
        break;
      default:
        // unknown message type from the worker — log and ignore

        console.warn(`[WorkerSceneHost] unknown worker msg: ${data.type}`);
    }
  }

  // ─── Internal post helper ─────────────────────────────────────

  _post(type, payload) {
    if (!this._worker) {
      return;
    }
    try {
      this._worker.postMessage({ type, ...(payload ?? {}) });
    } catch (e) {
      // postMessage failure (e.g., transferable already detached)
      // is treated as a crash signal — the worker can no longer be
      // talked to.
      this._noteCrash("postMessage-failure", {
        type,
        message: e && e.message,
      });
    }
  }
}

export default WorkerSceneHost;
