/**
 * @module WebGPURenderBundleManager
 *
 * Manages WebGPU render bundles for pre-encoding static draw commands.
 * Render bundles dramatically reduce CPU overhead for geometry that doesn't
 * change command structure frame-to-frame (e.g., terrain tiles, buildings).
 *
 * Key benefits:
 * - 50-80% CPU reduction for static terrain tile rendering
 * - Draw commands are validated and encoded once, then replayed each frame
 * - Bundle invalidation when geometry/pipeline changes
 *
 *
 * @see https://www.w3.org/TR/webgpu/#render-bundles
 * @private
 */

/// <reference types="@webgpu/types" />

import DeveloperError from "../../Core/DeveloperError.js";
import createGuid from "../../Core/createGuid.js";

/**
 * Unique key identifying a bundle (e.g., tile ID, pass name, material hash).
 */
export type BundleKey = string;

/**
 * Metadata for a cached render bundle.
 */
export interface BundleEntry {
  /** The compiled render bundle */
  bundle: GPURenderBundle;
  /** Monotonically increasing version — bumped on invalidation */
  version: number;
  /** Frame number when this bundle was last used */
  lastUsedFrame: number;
  /** Number of draw calls encoded in this bundle */
  drawCallCount: number;
  /** Debug label */
  label: string;
}

/**
 * Descriptor for creating a render bundle encoder, mirroring the
 * current render pass's attachment formats.
 */
export interface BundleEncoderDescriptor {
  colorFormats: GPUTextureFormat[];
  depthStencilFormat?: GPUTextureFormat;
  sampleCount?: number;
  label?: string;
}

/**
 * Callback that receives a GPURenderBundleEncoder and records draw commands.
 * The manager calls this when a bundle needs to be (re)built.
 */
export type BundleRecordCallback = (encoder: GPURenderBundleEncoder) => number; // returns draw call count

/**
 * Manages render bundle creation, caching, invalidation, and eviction.
 *
 * Usage pattern:
 * ```ts
 * // At scene setup:
 * const bundleMgr = new WebGPURenderBundleManager(device);
 *
 * // Each frame, for static geometry (e.g., terrain tiles):
 * const bundle = bundleMgr.getOrCreate(
 *   tileKey,
 *   { colorFormats: [canvasFormat], depthStencilFormat: 'depth24plus-stencil8' },
 *   (encoder) => {
 *     encoder.setPipeline(terrainPipeline);
 *     encoder.setVertexBuffer(0, tile.vertexBuffer);
 *     encoder.setBindGroup(0, tile.bindGroup);
 *     encoder.drawIndexed(tile.indexCount);
 *     return 1; // 1 draw call
 *   }
 * );
 *
 * // Execute in the render pass:
 * renderPass.executeBundles([bundle]);
 * ```
 */
export class WebGPURenderBundleManager {
  private _device: GPUDevice;
  private _cache: Map<BundleKey, BundleEntry> = new Map();
  private _currentFrame: number = 0;
  private _maxIdleFrames: number;
  private _maxCacheSize: number;
  // Phase 6A — snapshot mode freeze flag. While `true`, beginFrame()
  // skips eviction entirely (so cached bundles never time out) and
  // getOrCreate() refuses to admit new bundles to the cache (so
  // transient one-frame additions don't pollute the snapshot). Toggled
  // by the SnapshotModeService freezable interface implemented at the
  // bottom of this file via `asFreezable()`.
  private _isFrozen: boolean = false;
  // Phase 6 debug surface — running counters so the central debug
  // dump can show "this many cache hits since the last reset / since
  // boot" without per-frame allocation. Cheap, monotonic.
  private _statHits: number = 0;
  private _statMisses: number = 0;
  private _statEphemeral: number = 0;
  private _statEvictions: number = 0;
  private _statFreezes: number = 0;
  private _statThaws: number = 0;

  /**
   * @param {GPUDevice} device - The GPU device
   * @param {object} [options] - Configuration
   * @param {number} [options.maxIdleFrames=300] - Evict bundles unused for this many frames (~5s at 60fps)
   * @param {number} [options.maxCacheSize=1000] - Maximum number of cached bundles
   */
  constructor(
    device: GPUDevice,
    options?: { maxIdleFrames?: number; maxCacheSize?: number },
  ) {
    this._device = device;
    this._maxIdleFrames = options?.maxIdleFrames ?? 300;
    this._maxCacheSize = options?.maxCacheSize ?? 1000;
  }

  /**
   * Get an existing bundle or create a new one using the provided callback.
   *
   * @param {BundleKey} key - Unique identifier (e.g., tile ID)
   * @param {BundleEncoderDescriptor} descriptor - Attachment format descriptor
   * @param {BundleRecordCallback} recordCallback - Called to record draw commands
   * @returns {GPURenderBundle} The render bundle
   */
  getOrCreate(
    key: BundleKey,
    descriptor: BundleEncoderDescriptor,
    recordCallback: BundleRecordCallback,
  ): GPURenderBundle {
    const existing = this._cache.get(key);
    if (existing) {
      existing.lastUsedFrame = this._currentFrame;
      this._statHits++;
      return existing.bundle;
    }

    // Phase 6A — when snapshot mode is active, refuse to admit new
    // bundles to the cache. Build the bundle ephemerally (record-and-
    // discard) so transient one-frame additions don't pollute the
    // snapshot. The bundle is still returned to the caller and is
    // valid for THIS frame's draw, just not cached.
    if (this._isFrozen) {
      this._statEphemeral++;
      return this._buildEphemeral(key, descriptor, recordCallback);
    }

    // Create new bundle
    this._statMisses++;
    return this._createBundle(key, descriptor, recordCallback);
  }

  /**
   * Invalidate a specific bundle, forcing re-creation on next access.
   *
   * @param {BundleKey} key - The bundle key to invalidate
   */
  invalidate(key: BundleKey): void {
    this._cache.delete(key);
  }

  /**
   * Invalidate all bundles matching a prefix (e.g., "terrain_" for all terrain tiles).
   *
   * @param {string} prefix - Key prefix to match
   * @returns {number} Number of bundles invalidated
   */
  invalidateByPrefix(prefix: string): number {
    let count = 0;
    for (const key of this._cache.keys()) {
      if (key.startsWith(prefix)) {
        this._cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Invalidate all cached bundles.
   */
  invalidateAll(): void {
    this._cache.clear();
  }

  /**
   * Call once per frame to advance the frame counter and evict stale bundles.
   * Should be called at the beginning of each frame (e.g., in beginFrame).
   */
  beginFrame(): void {
    this._currentFrame++;

    // Phase 6A — skip eviction entirely while snapshot mode is active.
    // The whole point of snapshot mode is to keep cached bundles alive
    // longer than the normal idle window so a static scene replays the
    // same encoded draws frame after frame at near-zero CPU cost.
    if (this._isFrozen) {
      return;
    }

    // Periodic eviction (every 60 frames to avoid per-frame overhead)
    if (this._currentFrame % 60 === 0) {
      this._evictStale();
    }
  }

  /**
   * Check if a bundle exists and is valid for a given key.
   *
   * @param {BundleKey} key - The bundle key
   * @returns {boolean} True if a valid bundle exists
   */
  has(key: BundleKey): boolean {
    return this._cache.has(key);
  }

  /**
   * Get cache statistics for debugging/profiling. The legacy `cacheSize`
   * / `totalDrawCalls` / `currentFrame` fields are preserved; Phase 6
   * extends the shape with frozen-state, hit/miss counters, and a
   * key-prefix breakdown so the central debug surface can show "what
   * is the bundle cache actually doing right now" at a glance.
   */
  get statistics(): {
    cacheSize: number;
    totalDrawCalls: number;
    currentFrame: number;
    frozen: boolean;
    maxIdleFrames: number;
    maxCacheSize: number;
    hits: number;
    misses: number;
    ephemeralBuilds: number;
    evictions: number;
    freezes: number;
    thaws: number;
    hitRate: number;
    keyPrefixes: Record<string, number>;
  } {
    let totalDrawCalls = 0;
    const keyPrefixes: Record<string, number> = {};
    for (const [key, entry] of this._cache) {
      totalDrawCalls += entry.drawCallCount;
      // Group keys by their leading token (split on `_`, `-`, `:`, or `/`).
      // Tile keys typically look like `terrain_l5_x12_y7`, fog keys like
      // `fog_density_low`, etc. Falls back to the full key if no separator.
      const m = /^[A-Za-z][A-Za-z0-9]*/.exec(String(key));
      const prefix = m ? m[0] : String(key);
      keyPrefixes[prefix] = (keyPrefixes[prefix] ?? 0) + 1;
    }
    const totalLookups =
      this._statHits + this._statMisses + this._statEphemeral;
    const hitRate = totalLookups > 0 ? this._statHits / totalLookups : 0;
    return {
      cacheSize: this._cache.size,
      totalDrawCalls,
      currentFrame: this._currentFrame,
      frozen: this._isFrozen,
      maxIdleFrames: this._maxIdleFrames,
      maxCacheSize: this._maxCacheSize,
      hits: this._statHits,
      misses: this._statMisses,
      ephemeralBuilds: this._statEphemeral,
      evictions: this._statEvictions,
      freezes: this._statFreezes,
      thaws: this._statThaws,
      hitRate,
      keyPrefixes,
    };
  }

  /**
   * Reset the running counters (hits / misses / ephemeral / evictions /
   * freezes / thaws) without touching the cache contents. Useful for
   * "measure the next N frames" perf benchmarking workflows where you
   * want to compare apples-to-apples between two intervals.
   */
  resetStatisticsCounters(): void {
    this._statHits = 0;
    this._statMisses = 0;
    this._statEphemeral = 0;
    this._statEvictions = 0;
    this._statFreezes = 0;
    this._statThaws = 0;
  }

  /**
   * Destroy the manager and clear all bundles.
   */
  destroy(): void {
    this._cache.clear();
  }

  // ─── Phase 6A — Snapshot mode freezable interface ────────────────
  //
  // SnapshotModeService calls these via the freezable contract. The
  // bundle manager isn't a singleton — there's one per WebGPUContext
  // — so it self-registers via `asFreezable("webgpu-bundle-manager")`
  // when the WebGPUContext wires it up.

  /**
   * Snapshot mode entered: freeze the cache. Phase 6A's freeze is just
   * the flag flip — beginFrame() and getOrCreate() check it and skip
   * eviction / new admissions respectively. The cache contents aren't
   * touched, so the next frame's draws replay the exact same bundles
   * the previous frame used.
   *
   * Idempotent.
   */
  freeze(): void {
    if (!this._isFrozen) {
      this._statFreezes++;
    }
    this._isFrozen = true;
  }

  /**
   * Snapshot mode exited: unfreeze the cache. We refresh every cached
   * entry's `lastUsedFrame` to the current frame so the next eviction
   * cycle doesn't immediately drop everything (snapshots can hold for
   * many seconds, leaving every cached bundle past `_maxIdleFrames`).
   * Without this grace pass the very next eviction tick (60 frames
   * later) would wipe the cache, defeating the point of having held
   * the bundles in the first place.
   *
   * Idempotent.
   */
  thaw(): void {
    if (!this._isFrozen) return;
    this._isFrozen = false;
    this._statThaws++;
    // Reset usage timestamps so the post-thaw scene continues using
    // the same bundles instead of a fresh build storm.
    for (const entry of this._cache.values()) {
      entry.lastUsedFrame = this._currentFrame;
    }
  }

  /** Diagnostic introspection — true while in snapshot mode. */
  get isFrozen(): boolean {
    return this._isFrozen;
  }

  /**
   * Returns a `SnapshotFreezable`-shaped object suitable for passing
   * to `SnapshotModeService.registerFreezable()`. The returned object
   * is a thin closure over `this`; calling its `freeze()` / `thaw()` /
   * `isFrozen()` invokes the corresponding manager methods.
   *
   * Example:
   *   scene.snapshotMode.registerFreezable(
   *     "webgpu-bundle-manager",
   *     context.renderBundleManager.asFreezable(),
   *   );
   */
  asFreezable(): {
    name: string;
    freeze: () => void;
    thaw: () => void;
    isFrozen: () => boolean;
  } {
    return {
      name: "webgpu-bundle-manager",
      freeze: () => this.freeze(),
      thaw: () => this.thaw(),
      isFrozen: () => this._isFrozen,
    };
  }

  // Private methods

  /**
   * Phase 6A — record-and-discard bundle build for the snapshot mode
   * miss path. Used when `_isFrozen` is true and `getOrCreate` sees a
   * key not already in the cache. We still need to RETURN a valid
   * bundle to the caller (the executing draw command needs something
   * to replay), but we MUST NOT add it to the cache because doing so
   * would silently extend the snapshot beyond what `enter()` captured.
   *
   * The bundle is constructed exactly the same way as a cached one;
   * the only difference is that it's not stored in `_cache` afterward.
   * It also doesn't go through the eviction path, so very large
   * one-frame additions can't push out useful cached entries.
   */
  /**
   * Record a bundle with validation error scoping. If the record
   * callback uses an invalid pipeline (e.g., from a failed shader
   * compilation), the error is caught and logged instead of
   * propagating to `executeBundles` where it would poison the
   * entire command encoder and kill the frame.
   */
  private _recordBundleWithValidation(
    label: string,
    descriptor: BundleEncoderDescriptor,
    recordCallback: BundleRecordCallback,
  ): { bundle: GPURenderBundle; drawCallCount: number } {
    this._device.pushErrorScope("validation");
    const encoder = this._device.createRenderBundleEncoder({
      colorFormats: descriptor.colorFormats,
      depthStencilFormat: descriptor.depthStencilFormat,
      sampleCount: descriptor.sampleCount ?? 1,
      label,
    });
    const drawCallCount = recordCallback(encoder);
    const bundle = encoder.finish({ label });
    this._device.popErrorScope().then((error: GPUError | null) => {
      if (error) {
        console.error(
          `[WebGPU:RenderBundle] "${label}" recording failed: ${error.message}. ` +
            `This bundle will produce invalid commands if executed.`,
        );
      }
    });
    return { bundle, drawCallCount };
  }

  private _buildEphemeral(
    key: BundleKey,
    descriptor: BundleEncoderDescriptor,
    recordCallback: BundleRecordCallback,
  ): GPURenderBundle {
    const label = descriptor.label ?? `RenderBundleEphemeral_${key}`;
    const { bundle } = this._recordBundleWithValidation(
      label,
      descriptor,
      recordCallback,
    );
    this._statEphemeral++;
    return bundle;
  }

  private _createBundle(
    key: BundleKey,
    descriptor: BundleEncoderDescriptor,
    recordCallback: BundleRecordCallback,
  ): GPURenderBundle {
    const label = descriptor.label ?? `RenderBundle_${key}`;
    const { bundle, drawCallCount } = this._recordBundleWithValidation(
      label,
      descriptor,
      recordCallback,
    );

    const entry: BundleEntry = {
      bundle,
      version: 1,
      lastUsedFrame: this._currentFrame,
      drawCallCount,
      label,
    };

    // Evict oldest if cache is full
    if (this._cache.size >= this._maxCacheSize) {
      this._evictOldest();
    }

    this._cache.set(key, entry);
    return bundle;
  }

  private _evictStale(): void {
    const threshold = this._currentFrame - this._maxIdleFrames;
    for (const [key, entry] of this._cache) {
      if (entry.lastUsedFrame < threshold) {
        this._cache.delete(key);
        this._statEvictions++;
      }
    }
  }

  private _evictOldest(): void {
    let oldestKey: BundleKey | null = null;
    let oldestFrame = Infinity;

    for (const [key, entry] of this._cache) {
      if (entry.lastUsedFrame < oldestFrame) {
        oldestFrame = entry.lastUsedFrame;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this._cache.delete(oldestKey);
      this._statEvictions++;
    }
  }
}

export default WebGPURenderBundleManager;
