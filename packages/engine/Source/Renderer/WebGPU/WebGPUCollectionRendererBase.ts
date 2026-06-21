/**
 * Shared base for the WebGPU collection feature renderers
 * (Billboard / Point / Label / Cloud / Polyline) — Phase 11,
 * NEW-COLLECTION-RENDERER-BASE + NEW-COLLECTIONS-ERROR-SENTINELS.
 *
 * The five collection renderers each re-implemented the same per-frame
 * scaffolding around `WebGPUResidentInstanceBuffer`:
 *   - the pipeline-cache invalidation on a scene-format generation bump,
 *   - the settled-2D/CV "coplanar depth" `noDepthTest` flag,
 *   - the resident-instance manager lifecycle (lazy create + the
 *     load-bearing "capture-dirty-list → sync → consume" ordering),
 *   - the grow-on-demand pick instance buffer + its `writeBuffer`, and
 *   - the per-`GPUDevice` shader-module-cache WeakMap accessor.
 *
 * This module folds those into a small set of composable helpers so the
 * renderers call ONE function per sub-flow instead of re-deriving the
 * predicate each time. The helpers are deliberately functions over the
 * existing `_webgpuCache` object (not a class that owns the whole flow)
 * so migration is byte-behavior-preserving: each renderer keeps its own
 * pack function, define scan, descriptor builders, and command assembly
 * — only the shared plumbing moves here.
 *
 * THREE MANDATED PERMANENT SENTINELS (CLAUDE.md "Permanent sentinels"):
 *   1. Re-entry / infinite-loop guard — `beginCollectionFrame` counts
 *      nested entries per collection and `console.error`s (throttled) if
 *      a renderer re-enters its own update for the same collection in one
 *      frame (a sign of a recursive command-list build).
 *   2. Null-target guard — `validateInstanceSyncResult` `console.error`s
 *      when the resident manager returns a null buffer for a non-zero
 *      visible count (a draw command with no vertex buffer is a hard bug).
 *      The explicit-buffer collections (Cloud / Polyline) that don't go
 *      through the resident manager call `validateDrawTargets` at their
 *      render-pass boundary for the same guarantee.
 *   3. Size-validation / overflow guard — `ensurePickInstanceBuffer` +
 *      `writePickInstances` `console.error` + clamp when the requested
 *      instance payload exceeds the allocated buffer, preventing an
 *      out-of-range `writeBuffer` / over-count instanced draw (BUG-15
 *      family). `validateInstancedDrawBuffer` is the explicit-buffer
 *      variant used by Cloud / Polyline / Label glyph draws: it clamps the
 *      drawn instance count to what the vertex/instance buffer physically
 *      holds.
 *
 * These are PERMANENT (no debug pragma) per CLAUDE.md — they indicate a
 * real bug producing broken output, so they must reach production
 * consoles. The re-entry counter increment is cheap (one integer add);
 * the throttle state lives on the cache.
 *
 * @private
 * @module WebGPUCollectionRendererBase
 */

/// <reference types="@webgpu/types" />

import WebGPUBuffer from "./WebGPUBuffer.js";
import SceneMode from "../../Scene/SceneMode.js";
import {
  WebGPUResidentInstanceBuffer,
  type ResidentInstanceItem,
  type ResidentInstanceSyncOptions,
  type ResidentInstanceSyncResult,
} from "./WebGPUResidentInstanceBuffer.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";

/**
 * The narrow slice of CesiumJS `FrameState` the base helpers read.
 * Kept structural (not an import of the ambient `CesiumFrameState`) so
 * this module stays decoupled from the scene-layer typings and callers
 * can pass their existing untyped frame-state objects.
 */
export interface CollectionFrameStateLike {
  mode?: number;
  morphTime?: number;
  taaEnabled?: boolean;
}

/** The minimal shape of the WebGPU device-carrying context the base reads. */
export interface CollectionContextLike {
  device: GPUDevice;
  _scenePipelineFormatGeneration?: number;
}

/**
 * The per-collection cache object (`collection._webgpuCache`). Only the
 * fields the base touches are typed; renderers add their own (pipelines,
 * bind groups, commands) on the same object.
 */
export interface CollectionRenderCache {
  instanceManager?: WebGPUResidentInstanceBuffer<ResidentInstanceItem>;
  pickInstanceBuffer?: WebGPUBuffer;
  _pipelineFormatGeneration?: number;
  // Sentinel state (re-entry guard).
  _frameReentryDepth?: number;
  _frameReentryLastLogTime?: number;
}

// =========================================================================
// Sentinel 1 — re-entry / infinite-loop guard
// =========================================================================

const REENTRY_LOG_THROTTLE_MS = 3000;

/**
 * Re-entry depth that signals a RUNAWAY (infinite-loop) command-list
 * build, not legitimate concurrency. A collection's `update()` is invoked
 * once per frustum SLICE and once per PASS (render / pick) within a frame,
 * and the billboard update is ASYNC (the caller doesn't await it), so a
 * handful of in-flight overlapping calls is NORMAL — `endCollectionFrame`
 * settles each one in its `finally` as its promise resolves. The sentinel
 * must therefore fire only on a SANE-LIMIT overrun (an unbounded recursive
 * re-enqueue), never on the small legitimate overlap. 16 comfortably
 * exceeds any real frustum×pass concurrency while still catching a runaway
 * loop long before it can starve the frame. (CLAUDE.md: "console.error
 * with throttle if it exceeds a sane limit".)
 */
const REENTRY_SANE_LIMIT = 16;

/**
 * Increment the per-collection re-entry depth at the top of a renderer's
 * `update*` entry point. A depth past {@link REENTRY_SANE_LIMIT} means the
 * collection's update is re-entering itself without the prior calls ever
 * settling — a recursive command-list build (the BUG-12 "clear loop"
 * failure mode applied to collections). PERMANENT `console.error`
 * (throttled), never pragma-stripped.
 *
 * Pair every `beginCollectionFrame` with an `endCollectionFrame` (call it
 * on every return path, or via try/finally) so the depth settles to 0.
 *
 * @returns the entry depth (1 on a normal, non-overlapping call).
 */
export function beginCollectionFrame(
  cache: CollectionRenderCache,
  label: string,
): number {
  const depth = (cache._frameReentryDepth ?? 0) + 1;
  cache._frameReentryDepth = depth;
  if (depth > REENTRY_SANE_LIMIT) {
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    if (
      cache._frameReentryLastLogTime === undefined ||
      now - cache._frameReentryLastLogTime >= REENTRY_LOG_THROTTLE_MS
    ) {
      cache._frameReentryLastLogTime = now;
      console.error(
        `[CesiumJS:webgpu] ${label} collection update re-entry depth ${depth} exceeds sane limit ${REENTRY_SANE_LIMIT} — recursive command-list build?`,
      );
    }
  }
  return depth;
}

/** Decrement the re-entry depth. Call on every return path of `update*`. */
export function endCollectionFrame(cache: CollectionRenderCache): void {
  const depth = cache._frameReentryDepth ?? 0;
  cache._frameReentryDepth = depth > 0 ? depth - 1 : 0;
}

// =========================================================================
// Pipeline-format-generation invalidation
// =========================================================================

/**
 * Clear the renderer's pipeline-entry maps when the scene render-target
 * format generation bumps (HDR toggle / MSAA change). Returns true when a
 * clear happened this frame (so the caller can drop its resolved-pipeline
 * aliases too, if any).
 *
 * `maps` are the renderer's `defines → entry` maps (color / pick /
 * velocity). Each may be undefined on the first frame.
 */
export function invalidatePipelinesOnSceneFormatChange(
  cache: CollectionRenderCache,
  context: CollectionContextLike,
  maps: Array<Map<unknown, unknown> | undefined | null>,
): boolean {
  const sceneGen = context._scenePipelineFormatGeneration ?? 0;
  if (cache._pipelineFormatGeneration === sceneGen) {
    return false;
  }
  for (let i = 0; i < maps.length; i++) {
    maps[i]?.clear();
  }
  cache._pipelineFormatGeneration = sceneGen;
  return true;
}

// =========================================================================
// Settled 2D / Columbus-View coplanar-depth flag
// =========================================================================

/**
 * NEW-COLLECTIONS-2DCV-COPLANAR-DEPTH — in settled 2D / Columbus View
 * (`morphTime === 0`, mode ≠ SCENE3D) collection quads sit coplanar with
 * the flat map and lose the `less-equal` depth test to z-fighting, so the
 * renderers disable the depth test there and draw on top. 3D + mid-morph
 * keep `less-equal`. This is the single source of truth for that flag.
 */
export function computeNoDepthTest(
  frameState: CollectionFrameStateLike,
): boolean {
  return frameState.morphTime === 0.0 && frameState.mode !== SceneMode.SCENE3D;
}

/** Bit 31 — folds `noDepthTest` into the pipeline-cache key above every ShaderDefine bit. */
export const NO_DEPTH_TEST_PIPELINE_KEY_BIT = 0x80000000;

/** Fold `noDepthTest` into a defines bitmask to key a DISTINCT pipeline. */
export function pipelineKeyWithDepthFlag(
  defines: number,
  noDepthTest: boolean,
): number {
  return noDepthTest ? defines | NO_DEPTH_TEST_PIPELINE_KEY_BIT : defines;
}

// =========================================================================
// Resident-instance manager fold
// =========================================================================

/** Lazily create (and cache) the collection's resident-instance manager. */
export function getOrCreateInstanceManager<T extends ResidentInstanceItem>(
  cache: CollectionRenderCache,
  device: GPUDevice,
  label: string,
): WebGPUResidentInstanceBuffer<T> {
  let mgr = cache.instanceManager as
    | WebGPUResidentInstanceBuffer<T>
    | undefined;
  if (mgr === undefined) {
    mgr = new WebGPUResidentInstanceBuffer<T>(device, label);
    cache.instanceManager =
      mgr as unknown as WebGPUResidentInstanceBuffer<ResidentInstanceItem>;
  }
  return mgr;
}

/**
 * Run the resident-instance manager's per-frame sync with the load-bearing
 * ORDERING enforced in one place: capture the dirty list, sync, THEN call
 * the collection's `consumeDirtyState`. Syncing after the consume would
 * always observe an empty dirty list and never partial-write
 * (NEW-DIRTY-CONSUME-*). The renderers used to inline this with a comment
 * warning about the order; folding it here makes the ordering structural.
 *
 * `consumeDirtyState` is invoked AFTER `sync` returns — `sync` reads the
 * `dirtyList` / `dirtyCount` snapshot the caller captured before calling.
 */
export function syncInstancesAndConsume<T extends ResidentInstanceItem>(
  manager: WebGPUResidentInstanceBuffer<T>,
  options: ResidentInstanceSyncOptions<T>,
  consumeDirtyState: () => void,
): ResidentInstanceSyncResult {
  const result = manager.sync(options);
  consumeDirtyState();
  return result;
}

/**
 * Sentinel 2 — null-target guard. A non-zero visible count with a null
 * buffer means the manager produced an instanced draw with no vertex
 * buffer — a hard bug (the draw would read garbage or be dropped). Returns
 * true when the result is SAFE TO DRAW (visibleCount > 0 and buffer set);
 * false when the caller should skip the draw this frame. PERMANENT log.
 */
export function validateInstanceSyncResult(
  result: ResidentInstanceSyncResult,
  label: string,
): boolean {
  if (result.visibleCount <= 0) {
    return false;
  }
  if (result.buffer === null) {
    console.error(
      `[CesiumJS:webgpu] ${label} resident-instance sync returned a null buffer for ${result.visibleCount} visible instances — skipping draw.`,
    );
    return false;
  }
  return true;
}

// =========================================================================
// Pick instance buffer (grow-on-demand) + size-validation sentinel
// =========================================================================

/**
 * Ensure the collection's pick instance buffer is at least `requiredBytes`,
 * growing (destroy + recreate) on demand. Returns the buffer to write into.
 *
 * Sentinel 3 (size-validation / overflow) lives in the writer
 * `writePickInstances` below — this allocator guarantees capacity, and the
 * writer asserts the payload fits before issuing `writeBuffer`.
 */
export function ensurePickInstanceBuffer(
  cache: CollectionRenderCache,
  device: GPUDevice,
  requiredBytes: number,
  label: string,
): WebGPUBuffer {
  const existing = cache.pickInstanceBuffer;
  if (existing === undefined || existing.size < requiredBytes) {
    if (existing !== undefined) {
      existing.destroy();
    }
    cache.pickInstanceBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      Math.max(requiredBytes, 4),
      false,
      label,
    );
  }
  return cache.pickInstanceBuffer as WebGPUBuffer;
}

/**
 * Write packed pick instance data to the pick buffer with the
 * size-validation / overflow sentinel (Sentinel 3, BUG-15 family).
 * `payloadBytes` is the byte length actually being written; if it exceeds
 * the buffer capacity we `console.error` and CLAMP to the buffer size so
 * the `writeBuffer` stays in range instead of throwing a validation error
 * that aborts the whole command encoder. PERMANENT log.
 *
 * @returns the number of instances safe to draw given the clamp.
 */
export function writePickInstances(
  device: GPUDevice,
  buffer: WebGPUBuffer,
  data: Float32Array,
  instanceCount: number,
  bytesPerInstance: number,
  label: string,
): number {
  let payloadBytes = instanceCount * bytesPerInstance;
  let safeInstanceCount = instanceCount;
  if (payloadBytes > buffer.size) {
    safeInstanceCount = Math.floor(buffer.size / bytesPerInstance);
    const clampedBytes = safeInstanceCount * bytesPerInstance;
    console.error(
      `[CesiumJS:webgpu] ${label} pick payload ${payloadBytes}B exceeds buffer ${buffer.size}B — clamping to ${safeInstanceCount} instances (${clampedBytes}B).`,
    );
    payloadBytes = clampedBytes;
  }
  if (payloadBytes > 0) {
    device.queue.writeBuffer(buffer.buffer, 0, data.buffer, 0, payloadBytes);
  }
  return safeInstanceCount;
}

// =========================================================================
// Sentinel 2 — null-target guard for explicit-buffer draws
// =========================================================================

const NULL_TARGET_LOG_THROTTLE_MS = 3000;
const _nullTargetLastLogTime: Record<string, number> = Object.create(null);

/**
 * Sentinel 2 (null-target guard), explicit-buffer variant. The
 * resident-instance collections (Billboard / Point / Label) use
 * {@link validateInstanceSyncResult}; the collections that build their own
 * vertex/instance buffers (Cloud / Polyline) call this at the render-pass
 * boundary instead. Returns true when EVERY supplied buffer/view is set
 * (safe to draw); when any is null/undefined, or a destroyed `WebGPUBuffer`
 * wrapper, it `console.error`s (throttled, keyed by `label`) and returns false
 * so the caller skips the draw rather than handing a null/destroyed vertex
 * buffer to the WebGPU validation layer. The log is PERMANENT (no debug
 * pragma) — a missing draw target is broken output.
 */
export function validateDrawTargets(
  buffers: ReadonlyArray<object | null | undefined>,
  label: string,
): boolean {
  for (let i = 0; i < buffers.length; i++) {
    const b = buffers[i];
    // A `WebGPUBuffer` wrapper exposes its underlying `GPUBuffer` as `.buffer`
    // and flips `.isDestroyed` on destroy — the `.buffer` reference is KEPT,
    // not nulled (see WebGPUBuffer.destroy). A raw `GPUBuffer` has neither
    // field, so `(b as ...).buffer` is `undefined`. A present object therefore
    // passes unless it has an explicitly-null `.buffer` or is a destroyed
    // wrapper (`isDestroyed === true`).
    const inner =
      b === null || b === undefined ? null : (b as { buffer?: unknown }).buffer;
    const destroyed =
      b !== null &&
      b !== undefined &&
      (b as { isDestroyed?: boolean }).isDestroyed === true;
    if (b === null || b === undefined || inner === null || destroyed) {
      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      const last = _nullTargetLastLogTime[label];
      if (last === undefined || now - last >= NULL_TARGET_LOG_THROTTLE_MS) {
        _nullTargetLastLogTime[label] = now;
        console.error(
          `[CesiumJS:webgpu] ${label} draw target ${i} is null or destroyed at the render-pass boundary — skipping draw.`,
        );
      }
      return false;
    }
  }
  return true;
}

// =========================================================================
// Sentinel 3 — instanced-draw size validation for explicit-buffer draws
// =========================================================================

const DRAW_OVERFLOW_LOG_THROTTLE_MS = 3000;
const _drawOverflowLastLogTime: Record<string, number> = Object.create(null);

/**
 * Sentinel 3 (size-validation / overflow), instanced-draw variant. Before
 * issuing an instanced draw whose per-instance data lives in `buffer`
 * (Cloud / Polyline / Label glyph streams), confirm the buffer is large
 * enough for `instanceCount * bytesPerInstance`. On the happy path the
 * buffer is grown to fit, so this is inert; on a drift (count outran the
 * last grow, or the buffer shrank) it `console.error`s (throttled, keyed by
 * `label`) and CLAMPS the returned instance count to what physically fits,
 * so the caller draws a safe sub-range instead of reading out of bounds
 * (the BUG-15 index/instance-overflow family). PERMANENT log.
 *
 * @returns the instance count that is safe to draw given the clamp.
 */
export function validateInstancedDrawBuffer(
  buffer: { size: number } | null | undefined,
  instanceCount: number,
  bytesPerInstance: number,
  label: string,
): number {
  if (instanceCount <= 0 || bytesPerInstance <= 0) {
    return instanceCount > 0 ? instanceCount : 0;
  }
  if (buffer === null || buffer === undefined) {
    return 0;
  }
  const requiredBytes = instanceCount * bytesPerInstance;
  if (requiredBytes <= buffer.size) {
    return instanceCount;
  }
  const safeCount = Math.floor(buffer.size / bytesPerInstance);
  const now =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const last = _drawOverflowLastLogTime[label];
  if (last === undefined || now - last >= DRAW_OVERFLOW_LOG_THROTTLE_MS) {
    _drawOverflowLastLogTime[label] = now;
    console.error(
      `[CesiumJS:webgpu] ${label} instanced draw needs ${requiredBytes}B (${instanceCount}×${bytesPerInstance}) but buffer is ${buffer.size}B — clamping to ${safeCount} instances.`,
    );
  }
  return safeCount;
}

// =========================================================================
// Per-device shader-module cache accessor
// =========================================================================

/**
 * Build a per-`GPUDevice` shader-module-cache accessor. Each renderer
 * keeps ONE module-level accessor (via a private WeakMap) so the same
 * (source, defines) tuple isn't recompiled per collection on a device.
 * Returns a getter that lazily creates the cache for a device.
 */
export function makeDeviceShaderModuleCacheAccessor(): (
  device: GPUDevice,
) => WebGPUShaderModuleCache {
  const caches = new WeakMap<GPUDevice, WebGPUShaderModuleCache>();
  return function getCache(device: GPUDevice): WebGPUShaderModuleCache {
    let cache = caches.get(device);
    if (cache === undefined) {
      cache = new WebGPUShaderModuleCache(device);
      caches.set(device, cache);
    }
    return cache;
  };
}

export default {
  beginCollectionFrame,
  endCollectionFrame,
  invalidatePipelinesOnSceneFormatChange,
  computeNoDepthTest,
  pipelineKeyWithDepthFlag,
  NO_DEPTH_TEST_PIPELINE_KEY_BIT,
  getOrCreateInstanceManager,
  syncInstancesAndConsume,
  validateInstanceSyncResult,
  validateDrawTargets,
  validateInstancedDrawBuffer,
  ensurePickInstanceBuffer,
  writePickInstances,
  makeDeviceShaderModuleCacheAccessor,
};
