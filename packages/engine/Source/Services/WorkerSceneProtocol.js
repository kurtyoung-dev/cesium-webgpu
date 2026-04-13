/**
 * @module WorkerSceneProtocol
 *
 * The postMessage protocol shared by `WorkerSceneHost` (main thread)
 * and `RendererWorker` (worker thread). Defining the message types as
 * exported constants in one place keeps both sides in sync without
 * either importing the other (they live in different module graphs).
 *
 * ── Wire format ─────────────────────────────────────────────────────
 *
 * Every message is `{ type: string, ...payload }`. Replies that
 * correspond to a request carry a `requestId` so the host can resolve
 * the right Promise. Async commands (entity adds, picks) use this;
 * fire-and-forget commands (camera updates, render requests) skip the
 * id and never wait for a reply.
 *
 * ── Crash recovery contract ─────────────────────────────────────────
 *
 * The host and worker exchange heartbeats once per second. The host
 * tags every command it sends with the matching session id; if the
 * worker dies and the host restarts it, the session id increments,
 * and any in-flight messages from the dead session that arrive late
 * are dropped on receipt. The host's shadow state (everything needed
 * to rebuild the scene from scratch) is replayed into the new worker
 * before any user-visible commands resume.
 *
 * @private
 */

// ─── Direction: Host → Worker ───────────────────────────────────────

/** Initial setup with the OffscreenCanvas. Sent once per worker. */
export const MSG_INIT = "init";

/** Soft reset — destroy and recreate the Scene without killing the worker. */
export const MSG_RESET = "reset";

/** Resize event from the parent container's ResizeObserver. */
export const MSG_RESIZE = "resize";

/** Camera setView command. */
export const MSG_SET_VIEW = "setView";

/** Generic camera property update (heading/pitch/roll/zoom). */
export const MSG_CAMERA_UPDATE = "cameraUpdate";

/** Force a single frame render even if requestRenderMode is on. */
export const MSG_REQUEST_RENDER = "requestRender";

/** Toggle requestRenderMode. */
export const MSG_SET_REQUEST_RENDER_MODE = "setRequestRenderMode";

/**
 * Set the worker's render-loop max FPS cap.
 *
 * Payload: `{ maxFps: number }` where `maxFps` is one of:
 *   -  > 0   — clamp the loop to at most this many frames per second
 *   -  0     — uncapped (use `setTimeout(0)`, bypass rAF; runs as fast
 *               as the JS engine allows, useful for benchmarking)
 *   -  < 0   — pause the render loop (no frames are rendered until
 *               another `setMaxFps` lifts the cap)
 *
 * The cap is enforced two ways depending on whether the worker has
 * `requestAnimationFrame` available:
 *   - rAF mode: the loop wakes every vsync but compares
 *     `now - lastRender >= 1000/maxFps` and skips frames that arrive
 *     too early. Effective rate is `min(displayHz, maxFps)`.
 *   - setTimeout fallback: the loop sets the next-tick interval to
 *     `1000/maxFps`. Effective rate is `min(setTimeoutFloor, maxFps)`
 *     where the floor is typically 4-10 ms in workers.
 *
 * To exceed the display refresh rate (e.g., for a benchmark trace
 * that wants 200+ fps), pass `0` to switch to the uncapped path —
 * the loop bypasses rAF entirely.
 */
export const MSG_SET_MAX_FPS = "setMaxFps";

/** Forwarded DOM input event (mouse, wheel, keyboard, touch). */
export const MSG_INPUT_EVENT = "inputEvent";

/** Add a basic primitive (entity / billboard / polyline) by descriptor. */
export const MSG_ADD_ENTITY = "addEntity";

/** Remove an entity by id. */
export const MSG_REMOVE_ENTITY = "removeEntity";

/** Add or change an imagery layer. */
export const MSG_SET_IMAGERY_LAYER = "setImageryLayer";

/** Set the terrain provider. */
export const MSG_SET_TERRAIN = "setTerrain";

/**
 * Phase 5 WGF-1/WGF-3: replicate opt-in feature flags to the worker.
 * Payload: `{ useHardwareClipDistances: boolean, useShaderF16: boolean }`.
 * The worker applies each flag to its `scene.context` after init.
 * Must be part of shadow-state replay so flags survive worker restarts.
 */
export const MSG_SET_FEATURE_FLAGS = "setFeatureFlags";

/** Heartbeat ping — worker must echo a HEARTBEAT_PONG within deadline. */
export const MSG_HEARTBEAT_PING = "heartbeatPing";

/** Force the worker to perform a self-snapshot of its current state. */
export const MSG_DUMP_DEBUG_SNAPSHOT = "dumpDebugSnapshot";

// ─── Direction: Worker → Host ───────────────────────────────────────

/** Worker has finished init. Includes detected backend type, capabilities. */
export const MSG_READY = "ready";

/** Periodic FPS / draw stats payload (8 Hz default). */
export const MSG_STATS = "stats";

/** Worker is requesting the host re-send shadow state (post soft reset). */
export const MSG_REPLAY_REQUEST = "replayRequest";

/** Heartbeat pong reply. */
export const MSG_HEARTBEAT_PONG = "heartbeatPong";

/** GPU device-lost notification (worker is attempting in-thread recovery). */
export const MSG_DEVICE_LOST = "deviceLost";

/** GPU device successfully restored after a device-lost event. */
export const MSG_DEVICE_RESTORED = "deviceRestored";

/** Async reply to a host request (carries requestId + payload OR error). */
export const MSG_REPLY = "reply";

/** Free-form log line for the host's debug overlay. */
export const MSG_LOG = "log";

/** Worker is reporting a recoverable runtime error. */
export const MSG_ERROR = "error";

// ─── Constants ──────────────────────────────────────────────────────

/** Default heartbeat interval in milliseconds. */
export const HEARTBEAT_INTERVAL_MS = 1000;

/** Number of consecutive missed pongs before declaring the worker dead. */
export const HEARTBEAT_MAX_MISSED = 3;

/** Default stats reporting interval in milliseconds. */
export const STATS_INTERVAL_MS = 125; // 8 Hz

/** Maximum auto-restart attempts within the burst window. */
export const RESTART_BURST_MAX = 3;

/** Burst window duration in milliseconds. After this many failures within
 *  this window, the host stops auto-restarting and surfaces a hard error. */
export const RESTART_BURST_WINDOW_MS = 60000;

/** Backoff before restarting after a soft (worker.onerror) crash. */
export const RESTART_SOFT_BACKOFF_MS = 100;

/** Backoff before restarting after a hard (heartbeat) crash. */
export const RESTART_HARD_BACKOFF_MS = 500;

export default {
  // Host → Worker
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
  // Worker → Host
  MSG_READY,
  MSG_STATS,
  MSG_REPLAY_REQUEST,
  MSG_HEARTBEAT_PONG,
  MSG_DEVICE_LOST,
  MSG_DEVICE_RESTORED,
  MSG_REPLY,
  MSG_LOG,
  MSG_ERROR,
  // Constants
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSED,
  STATS_INTERVAL_MS,
  RESTART_BURST_MAX,
  RESTART_BURST_WINDOW_MS,
  RESTART_SOFT_BACKOFF_MS,
  RESTART_HARD_BACKOFF_MS,
};
