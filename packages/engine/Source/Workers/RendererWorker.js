/**
 * @module RendererWorker
 *
 * Worker-thread entry point for the per-renderer worker pattern. This
 * file runs INSIDE a Web Worker. The main thread imports it as a
 * worker URL via `new Worker(new URL("./RendererWorker.js", import.meta.url))`
 * — see `WorkerSceneHost.js` for the host-side counterpart.
 *
 * Lifecycle:
 *   1. Wait for the host's `init` message carrying the OffscreenCanvas
 *      and configuration (renderer type, scene options).
 *   2. Lazy-import the smallest set of Cesium modules needed to spin
 *      up a Scene against the OffscreenCanvas. We deliberately import
 *      only what we need to keep the worker bundle small — no Viewer,
 *      no widgets, no DOM-coupled code.
 *   3. Run our own RAF loop on the worker thread, calling
 *      `scene.render()` once per vsync. The worker has its own
 *      `requestAnimationFrame` (since OffscreenCanvas is in scope it's
 *      tied to the host canvas's display refresh).
 *   4. Track FPS via the local `PerformanceTracker` and post stats
 *      back to the host every `STATS_INTERVAL_MS` ms.
 *   5. Echo heartbeat pings so the host knows we're alive.
 *   6. Listen for camera/input/entity commands and apply them to the
 *      Scene.
 *
 * Crash recovery:
 *   - GPU device lost is handled in-thread by `WebGPUDeviceLossRecovery`.
 *     The worker posts `deviceLost` then `deviceRestored` so the host
 *     can show a UI indicator.
 *   - Soft reset: the host sends `reset` and the worker tears down
 *     the current Scene, requests a state replay, and rebuilds.
 *   - Hard restart: the worker simply dies and is replaced; this file
 *     never sees that case.
 *
 * @private
 */

// NOTE: this file deliberately does NOT statically import Cesium
// modules at the top. It uses dynamic `await import()` inside the init
// handler so the worker bundle starts as a tiny bootstrap and only
// pulls the engine when it actually receives the OffscreenCanvas. This
// makes the host's startup ordering simpler — `new Worker()` returns
// immediately without paying the engine's parse cost.

import {
  MSG_INIT,
  MSG_RESET,
  MSG_RESIZE,
  MSG_SET_VIEW,
  MSG_CAMERA_UPDATE,
  MSG_REQUEST_RENDER,
  MSG_SET_REQUEST_RENDER_MODE,
  MSG_SET_MAX_FPS,
  MSG_SET_FEATURE_FLAGS,
  MSG_INPUT_EVENT,
  MSG_ADD_ENTITY,
  MSG_REMOVE_ENTITY,
  MSG_SET_IMAGERY_LAYER,
  MSG_SET_TERRAIN,
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
  STATS_INTERVAL_MS,
} from "../Services/WorkerSceneProtocol.js";

// Worker-global state. There is exactly one Scene per worker, so a
// module-level singleton is the cleanest model — no class instances,
// no `this` confusion across postMessage handlers.
let _scene = null;
let _canvas = null;
let _rendererType = null;
let _initialized = false;
let _lastStatsTime = 0;
let _sessionId = 0;
const _shutdownRequested = false;

/**
 * Post a structured message back to the host. Wraps `self.postMessage`
 * so we never have to remember the type-string convention at call sites.
 */
function post(type, payload) {
  // Object spread is fine here — payload is small and infrequent.
  // Hot-path messages (stats) deliberately reuse a typed-array buffer
  // when bandwidth matters.
  self.postMessage({ type, ...(payload ?? {}) });
}

/** Best-effort logger that the host can route to its debug overlay. */
function workerLog(level, message) {
  post(MSG_LOG, { level, message });
}

/**
 * Request the host re-send shadow state after a soft reset. The worker
 * cannot replay a frame on its own — it has to ask the host because
 * the host is the source of truth for "what's in the scene right now."
 */
function requestReplay(reason) {
  post(MSG_REPLAY_REQUEST, { reason, sessionId: _sessionId });
}

// ─── Init / teardown ─────────────────────────────────────────────

/**
 * Handle the initial `init` message. Loads Cesium modules dynamically,
 * creates a Scene against the provided OffscreenCanvas, and starts
 * the RAF loop.
 */
async function handleInit(payload) {
  if (_initialized) {
    workerLog("warn", "RendererWorker already initialized; ignoring init");
    return;
  }
  _canvas = payload.canvas;
  _rendererType = payload.rendererType ?? "webgpu";
  _sessionId = payload.sessionId ?? 0;
  // Honor the host's initial maxFps so the very first frame uses the
  // configured cap. Subsequent changes flow via MSG_SET_MAX_FPS.
  if (Object.prototype.hasOwnProperty.call(payload, "maxFps")) {
    _setMaxFps(payload.maxFps);
  }

  if (!_canvas || typeof _canvas.getContext !== "function") {
    post(MSG_ERROR, {
      message: "init payload missing OffscreenCanvas",
    });
    return;
  }

  try {
    // Headless Scene construction. The Scene + CreditDisplay path was
    // updated in this session to detect `typeof document === "undefined"`
    // and skip all DOM construction. The worker can now construct an
    // empty Scene against the OffscreenCanvas. Globe / imagery /
    // terrain / entities are NOT auto-added — the host adds them via
    // protocol messages once the Scene exists.
    //
    // If we hit a DOM dependency we missed during the audit, the
    // catch block below surfaces the specific exception to the host
    // so the next layer of the migration knows where to dig.

    // Dynamic import keeps the worker bundle's startup cost low and
    // lets esbuild code-split the engine into a separate chunk.
    // The worker bundle's entry point should be tiny.
    const engine = await import("@cesium/engine");

    // The two backend-specific paths diverge here. Both produce a
    // Scene we can drive with `render()` from inside the RAF loop.
    if (_rendererType === "webgl") {
      _scene = await _createWebGLScene(engine, _canvas, payload.sceneOptions);
    } else {
      _scene = await _createWebGPUScene(engine, _canvas, payload.sceneOptions);
    }

    // Hook GPU device-lost recovery if available. The recovery
    // service catches `device.lost` promises and rebuilds the
    // device + pipeline cache without killing the worker.
    _wireDeviceLossRecovery(_scene);

    _initialized = true;
    post(MSG_READY, {
      sessionId: _sessionId,
      rendererType: _rendererType,
      width: _canvas.width,
      height: _canvas.height,
    });
    _startRenderLoop();
  } catch (err) {
    // Init failure is recoverable from the host's perspective —
    // it can decide to spawn a fresh worker with different options.
    post(MSG_ERROR, {
      phase: "init",
      message: (err && err.message) || String(err),
      stack: (err && err.stack) || null,
    });
  }
}

/**
 * Build a WebGL Scene against an OffscreenCanvas. The classic Cesium
 * Context constructor accepts the OffscreenCanvas directly because
 * `getContext('webgl2')` works the same way on both DOM and offscreen
 * canvases.
 */
async function _createWebGLScene(engine, canvas, sceneOptions) {
  // Use the lower-level Scene constructor (NOT Viewer) because Viewer
  // assumes a DOM container with credit display + toolbar elements
  // that don't exist in a worker. Scene-only is the right fit.
  const Scene = engine.Scene;
  const scene = new Scene({
    canvas,
    ...sceneOptions,
    contextOptions: {
      ...(sceneOptions?.contextOptions ?? {}),
      renderer: "webgl",
    },
  });
  return scene;
}

/**
 * Build a WebGPU Scene against an OffscreenCanvas. WebGPU's
 * `canvas.getContext('webgpu')` works on OffscreenCanvas in modern
 * browsers (Chrome 113+, Firefox 115+, Safari 16.4+). The async
 * adapter request is the only difference from the WebGL path.
 */
async function _createWebGPUScene(engine, canvas, sceneOptions) {
  if (typeof engine.Scene.createAsync !== "function") {
    throw new Error(
      "engine.Scene.createAsync is missing — the WebGPU async init path " +
        "requires the version of @cesium/engine that ships Scene.createAsync.",
    );
  }
  const scene = await engine.Scene.createAsync({
    canvas,
    ...sceneOptions,
    contextOptions: {
      ...(sceneOptions?.contextOptions ?? {}),
      renderer: "webgpu",
    },
  });
  return scene;
}

/**
 * Wire device-lost recovery notifications to the host.
 *
 * `WebGPUDeviceLossRecovery` exposes a single `onDeviceLost(callback)`
 * method whose callback receives `{ reason, message, attempts, recovered }`.
 * The `recovered` flag tells us whether in-thread recovery succeeded —
 * we use that to emit either DEVICE_LOST (still recovering or failed)
 * or DEVICE_RESTORED (recovered cleanly). The two-message host
 * protocol stays the same; we just synthesise both from one callback.
 *
 * The recovery service is currently a private field on
 * `WebGPUContext`, so we duck-type it via best-effort property access.
 * If the field isn't reachable, we skip the wiring — the WebGPUContext
 * still recovers internally; the host just won't get a UI signal.
 */
function _wireDeviceLossRecovery(scene) {
  if (!scene || !scene.context) {
    return;
  }
  const ctx = scene.context;
  const dlr =
    ctx._deviceLossRecovery ||
    ctx.deviceLossRecovery ||
    (typeof ctx.getDeviceLossRecovery === "function"
      ? ctx.getDeviceLossRecovery()
      : null);
  if (!dlr || typeof dlr.onDeviceLost !== "function") {
    workerLog(
      "info",
      "device loss recovery not reachable from worker; skipping host notification wiring",
    );
    return;
  }
  dlr.onDeviceLost((info) => {
    post(MSG_DEVICE_LOST, {
      sessionId: _sessionId,
      reason: info && info.reason,
      message: info && info.message,
      attempts: info && info.attempts,
    });
    // The single callback fires once per loss event, but `info.recovered`
    // flips to true once the in-thread recovery loop succeeds. We post
    // a follow-up RESTORED message in that case so the host's UI can
    // un-flash its recovery indicator.
    if (info && info.recovered === true) {
      post(MSG_DEVICE_RESTORED, { sessionId: _sessionId });
    }
  });
}

/**
 * Tear down the current Scene without killing the worker. Used by the
 * `reset` message. After this returns, the worker is uninitialized
 * and ready to receive a fresh `init` message — but the canvas it
 * had is GONE because OffscreenCanvas can only be initialized once
 * per renderer context. The host has to recreate the canvas + worker.
 *
 * (We keep this function for completeness, but in practice the host
 * goes straight to hard restart whenever soft reset wouldn't help.)
 */
function handleReset() {
  _cancelRenderLoop();
  if (_scene && typeof _scene.destroy === "function") {
    try {
      _scene.destroy();
    } catch (e) {
      workerLog("warn", `scene.destroy threw: ${(e && e.message) || e}`);
    }
  }
  _scene = null;
  _initialized = false;
  requestReplay("post-reset");
}

// ─── Render loop ─────────────────────────────────────────────────

/**
 * Drive the worker's render loop with a runtime-configurable max FPS cap.
 *
 * **`maxFps` semantics** (mirrors and extends `CesiumWidget.targetFrameRate`):
 *
 *   - **`null` / `undefined`** (default): no throttle. Uses
 *     `requestAnimationFrame` when available so the worker rides
 *     vsync at the display refresh rate (60/120/144/240 Hz). On
 *     Firefox/Safari workers (no rAF), falls back to `setTimeout`
 *     at `FALLBACK_FPS_NO_CAP` (60 fps approximation). This matches
 *     the historical Cesium behavior where `targetFrameRate` is
 *     undefined.
 *
 *   - **`> 0`** (cap): uses rAF when available but SKIPS callbacks
 *     that arrive less than `1000/maxFps` ms after the previous
 *     render. Without rAF, uses `setTimeout(1000/maxFps)` directly.
 *     Effective rate is `min(displayHz, maxFps)` in Chromium and
 *     `maxFps` in the fallback.
 *
 *   - **`0`** (uncapped): bypasses rAF entirely and uses
 *     `setTimeout(tick, 0)`. Frame rate is bounded only by the JS
 *     engine's setTimeout floor (typically 1-4 ms in workers — there
 *     is no 4 ms hidden-tab clamp inside workers). Used for
 *     benchmarking the renderer's pure throughput when the question
 *     is "how many frames per second can the GPU sustain without
 *     vsync getting in the way".
 *
 *   - **`< 0`** (paused): scheduling stops; the loop waits for a
 *     `setMaxFps` lifting the cap. Useful for power-saving and for
 *     freezing the GPU state during a debug snapshot.
 *
 * Browser support reality check: `requestAnimationFrame` is exposed on
 * `DedicatedWorkerGlobalScope` in Chromium-based browsers (Chrome, Edge,
 * Brave) since v69, but NOT in Firefox or Safari workers as of 2026.
 * The setTimeout fallback handles those cleanly.
 *
 * If the worker host wants a vsync-aligned rate on Firefox/Safari, the
 * canonical workaround is for the main thread to post a `tick` message
 * on its own rAF — but that creates a hard coupling to the main thread
 * that defeats half the point of running in a worker. We deliberately
 * do NOT do that here.
 */
const FALLBACK_FPS_NO_CAP = 60; // Used by setTimeout fallback when maxFps is null
const _hasRaf = typeof requestAnimationFrame === "function";

// `_maxFps === null` is the documented "no throttle / use display refresh"
// state. Other sentinels: `0` = uncapped, `< 0` = paused, `> 0` = cap.
let _maxFps = null;
let _renderLoopHandle = 0;
// Distinguishes "schedule via rAF" from "schedule via setTimeout" so
// `_cancelRenderLoop` calls the right cancel function. Re-evaluated on
// each `setMaxFps` change because uncapped mode forces setTimeout.
let _renderLoopUsesRaf = false;
let _lastRenderTime = 0;

function _startRenderLoop() {
  if (!_hasRaf) {
    workerLog(
      "info",
      "requestAnimationFrame unavailable in this worker; using setTimeout fallback",
    );
  }

  const tick = () => {
    if (_shutdownRequested || !_initialized || !_scene) {
      return;
    }
    // Paused mode — skip render but DO NOT reschedule. The loop only
    // resumes when `_setMaxFps` is called with a non-negative value.
    // The `typeof === "number"` check excludes `null` (no throttle),
    // which must NOT trigger pause.
    if (typeof _maxFps === "number" && _maxFps < 0) {
      _renderLoopHandle = 0;
      return;
    }

    const now = (typeof performance !== "undefined" ? performance : Date).now();
    let shouldRender = true;

    // Capped mode with rAF: skip frames that arrive too early. The
    // rAF callback still fires every vsync; we just no-op on the
    // ones that fall inside the per-frame budget. Uncapped mode
    // (`_maxFps === 0`) and no-throttle mode (`_maxFps === null`)
    // skip this check entirely and render on every tick.
    if (typeof _maxFps === "number" && _maxFps > 0 && _renderLoopUsesRaf) {
      const minIntervalMs = 1000 / _maxFps;
      if (now - _lastRenderTime < minIntervalMs - 0.5) {
        // The -0.5 ms slop accounts for timer/jitter so a 60 fps cap
        // on a 60 Hz display doesn't accidentally drop every other
        // frame because of sub-millisecond rAF jitter.
        shouldRender = false;
      }
    }

    if (shouldRender) {
      _lastRenderTime = now;
      try {
        _scene.render();
      } catch (err) {
        // A render-time exception is recoverable — the next frame may
        // succeed. We log it but keep going so a single bad frame
        // doesn't kill the worker.
        post(MSG_ERROR, {
          phase: "render",
          message: (err && err.message) || String(err),
          stack: (err && err.stack) || null,
        });
      }
      // Periodic stats post — pulls live FPS from the scene's
      // PerformanceTracker. This is the data that drives the FpsOverlay.
      if (now - _lastStatsTime >= STATS_INTERVAL_MS) {
        _lastStatsTime = now;
        _postStats();
      }
    }

    _scheduleNextTick(tick);
  };
  _scheduleNextTick(tick);
}

function _scheduleNextTick(tick) {
  // Mode dispatch:
  //   null      → no throttle. rAF if available, else setTimeout at the
  //               fallback rate (60 fps). This is the default.
  //   > 0       → cap. rAF if available (with skip-frames check in tick),
  //               else setTimeout(1000/maxFps).
  //   === 0     → uncapped. Always setTimeout(0); bypass rAF entirely so
  //               the loop can exceed the display refresh rate.
  //   < 0       → paused. Should never reach here (early return in tick).
  const useRaf = _hasRaf && _maxFps !== 0;
  _renderLoopUsesRaf = useRaf;
  if (useRaf) {
    _renderLoopHandle = requestAnimationFrame(tick);
    return;
  }
  // setTimeout path:
  //   uncapped (_maxFps === 0)        → 0 ms (run as fast as possible)
  //   no throttle (_maxFps === null)  → 1000/FALLBACK_FPS_NO_CAP
  //   cap (_maxFps > 0 && !rAF)       → 1000/_maxFps
  let intervalMs;
  if (_maxFps === 0) {
    intervalMs = 0;
  } else if (_maxFps === null || _maxFps === undefined) {
    intervalMs = 1000 / FALLBACK_FPS_NO_CAP;
  } else {
    intervalMs = 1000 / _maxFps;
  }
  _renderLoopHandle = setTimeout(tick, intervalMs);
}

function _cancelRenderLoop() {
  if (_renderLoopHandle === 0) {
    return;
  }
  if (_renderLoopUsesRaf) {
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(_renderLoopHandle);
    }
  } else {
    clearTimeout(_renderLoopHandle);
  }
  _renderLoopHandle = 0;
}

/**
 * Update the max FPS cap and resume the loop if it was paused.
 * Called from the `MSG_SET_MAX_FPS` message handler and at init time
 * to honor the host's constructor option.
 *
 * Accepted values:
 *   - `null` / `undefined` → no throttle (default — display refresh)
 *   - positive number      → cap at that rate
 *   - `0`                  → uncapped (faster than vsync via setTimeout)
 *   - negative number      → pause the loop
 *
 * Anything else (NaN, strings, objects) is coerced to `null` so a
 * mistyped console command can't wedge the loop.
 */
function _setMaxFps(value) {
  const wasPaused = typeof _maxFps === "number" && _maxFps < 0;

  let next;
  if (value === null || value === undefined) {
    next = null;
  } else if (typeof value !== "number" || !isFinite(value)) {
    workerLog(
      "warn",
      `setMaxFps received non-numeric value (${typeof value}); coercing to null (no throttle)`,
    );
    next = null;
  } else {
    next = value;
  }

  _maxFps = next;
  let label;
  if (next === null) {
    label = "no throttle (display refresh)";
  } else if (next === 0) {
    label = "uncapped (setTimeout 0)";
  } else if (next < 0) {
    label = "paused";
  } else {
    label = `${next} fps cap`;
  }
  workerLog("info", `maxFps -> ${label}`);

  // If the loop was paused (handle == 0 due to early return), kick
  // it back into action now that the cap allows rendering again.
  const isResuming =
    wasPaused &&
    (next === null || next >= 0) &&
    _initialized &&
    _renderLoopHandle === 0;
  if (isResuming) {
    _startRenderLoop();
  }
}

/**
 * Pull live stats from the scene's PerformanceTracker and post them
 * back to the host. The frame-time snapshot is sent as an ArrayBuffer
 * for transferable speed; the stats summary is a small object that's
 * cheap to structured-clone.
 */
function _postStats() {
  if (!_scene || !_scene.performanceTracker) {
    return;
  }
  const tracker = _scene.performanceTracker;
  const stats = tracker.getLiveStats();
  // Copy the cached snapshot into a fresh object so the host gets a
  // stable value (the tracker recycles its snapshot buffer).
  const statsCopy = {
    windowSeconds: stats.windowSeconds,
    sampleCount: stats.sampleCount,
    avgFps: stats.avgFps,
    avgFrameMs: stats.avgFrameMs,
    onePercentLowFps: stats.onePercentLowFps,
    onePercentHighFps: stats.onePercentHighFps,
    minFrameMs: stats.minFrameMs,
    maxFrameMs: stats.maxFrameMs,
    latestFrameMs: stats.latestFrameMs,
    latestFps: stats.latestFps,
  };

  // Send the recent frame-time slice as a transferable typed array
  // for the FPS graph. We send up to 600 frames (~10 seconds at 60fps)
  // because the host overlay never draws more than that at full width.
  const snapshot = tracker.getLiveFrameTimeSnapshot(600);
  // postMessage with `transfer` moves ownership of the underlying
  // ArrayBuffer to the host with no copy. The local snapshot reference
  // becomes detached after this call — that's fine, we don't reuse it.
  self.postMessage(
    {
      type: MSG_STATS,
      sessionId: _sessionId,
      stats: statsCopy,
      frameTimes: snapshot,
    },
    [snapshot.buffer],
  );
}

// ─── Command handlers ────────────────────────────────────────────

function handleResize(payload) {
  if (!_canvas || !_scene) {
    return;
  }
  // OffscreenCanvas is resizable; just write width/height. The Scene
  // picks this up on the next frame via its existing resize hook.
  _canvas.width = payload.width;
  _canvas.height = payload.height;
}

function handleSetView(payload) {
  if (!_scene) {
    return;
  }
  try {
    _scene.camera.setView(payload.view);
  } catch (e) {
    workerLog("warn", `setView threw: ${e && e.message}`);
  }
}

function handleCameraUpdate(payload) {
  if (!_scene) {
    return;
  }
  const cam = _scene.camera;
  if (typeof payload.heading === "number") {
    cam.setView({
      orientation: {
        heading: payload.heading,
        pitch: cam.pitch,
        roll: cam.roll,
      },
    });
  }
  // Other modes (zoom, fly) are routed via setView with the same payload shape.
}

function handleRequestRender() {
  if (_scene && typeof _scene.requestRender === "function") {
    _scene.requestRender();
  }
}

function handleSetRequestRenderMode(payload) {
  if (_scene) {
    _scene.requestRenderMode = !!payload.enabled;
  }
}

function handleSetMaxFps(payload) {
  _setMaxFps(payload?.maxFps);
}

function handleSetFeatureFlags(payload) {
  if (!_scene || !_scene.context) {
    workerLog("warn", "setFeatureFlags before scene init — deferred");
    return;
  }
  const ctx = _scene.context;
  if (payload.useHardwareClipDistances !== undefined) {
    ctx.useHardwareClipDistances = !!payload.useHardwareClipDistances;
  }
  if (payload.useShaderF16 !== undefined) {
    ctx.useShaderF16 = !!payload.useShaderF16;
  }
}

function handleInputEvent(payload) {
  // Phase 1 stub: input event forwarding is implemented in a follow-up.
  // The current scope is FPS counter + worker isolation; full input
  // synthesis (synthetic MouseEvent / WheelEvent / KeyboardEvent on a
  // worker-side ScreenSpaceEventHandler shim) is the next layer.
  // For now, just record the call so the spec can verify it arrives.
  workerLog("debug", `inputEvent ${payload.kind ?? "?"} (stub)`);
}

function handleAddEntity(payload) {
  workerLog("debug", `addEntity ${payload.id ?? "?"} (stub)`);
}

function handleRemoveEntity(payload) {
  workerLog("debug", `removeEntity ${payload.id ?? "?"} (stub)`);
}

function handleSetImageryLayer(payload) {
  workerLog("debug", `setImageryLayer ${payload.url ?? "?"} (stub)`);
}

function handleSetTerrain(payload) {
  workerLog("debug", `setTerrain ${payload.url ?? "?"} (stub)`);
}

function handleHeartbeatPing(payload) {
  // Echo back immediately. The host's deadline starts when it sends
  // the ping, so a delayed echo (because the worker is busy rendering)
  // counts as a "missed pong" if it crosses the deadline.
  post(MSG_HEARTBEAT_PONG, {
    pingId: payload.id,
    sessionId: _sessionId,
    workerNow: (typeof performance !== "undefined" ? performance : Date).now(),
  });
}

function handleDumpDebugSnapshot() {
  if (!_scene) {
    post(MSG_REPLY, { requestId: -1, error: "no scene" });
    return;
  }
  let snapshot = null;
  try {
    snapshot =
      typeof _scene.getDebugSnapshot === "function"
        ? _scene.getDebugSnapshot()
        : null;
  } catch (e) {
    snapshot = { error: (e && e.message) || String(e) };
  }
  post(MSG_REPLY, { kind: "debugSnapshot", snapshot });
}

// ─── Message router ──────────────────────────────────────────────

self.onmessage = function (event) {
  const data = event.data;
  if (!data || typeof data.type !== "string") {
    return;
  }
  switch (data.type) {
    case MSG_INIT:
      handleInit(data);
      break;
    case MSG_RESET:
      handleReset();
      break;
    case MSG_RESIZE:
      handleResize(data);
      break;
    case MSG_SET_VIEW:
      handleSetView(data);
      break;
    case MSG_CAMERA_UPDATE:
      handleCameraUpdate(data);
      break;
    case MSG_REQUEST_RENDER:
      handleRequestRender();
      break;
    case MSG_SET_REQUEST_RENDER_MODE:
      handleSetRequestRenderMode(data);
      break;
    case MSG_SET_MAX_FPS:
      handleSetMaxFps(data);
      break;
    case MSG_SET_FEATURE_FLAGS:
      handleSetFeatureFlags(data);
      break;
    case MSG_INPUT_EVENT:
      handleInputEvent(data);
      break;
    case MSG_ADD_ENTITY:
      handleAddEntity(data);
      break;
    case MSG_REMOVE_ENTITY:
      handleRemoveEntity(data);
      break;
    case MSG_SET_IMAGERY_LAYER:
      handleSetImageryLayer(data);
      break;
    case MSG_SET_TERRAIN:
      handleSetTerrain(data);
      break;
    case MSG_HEARTBEAT_PING:
      handleHeartbeatPing(data);
      break;
    case MSG_DUMP_DEBUG_SNAPSHOT:
      handleDumpDebugSnapshot();
      break;
    default:
      workerLog("warn", `unknown message type: ${data.type}`);
  }
};

// Defensive: surface uncaught errors to the host so it knows to
// terminate + restart instead of waiting for a heartbeat timeout.
self.addEventListener("error", function (event) {
  post(MSG_ERROR, {
    phase: "uncaught",
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

self.addEventListener("unhandledrejection", function (event) {
  post(MSG_ERROR, {
    phase: "unhandledrejection",
    message: (event.reason && event.reason.message) || String(event.reason),
  });
});
