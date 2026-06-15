/// <reference types="@webgpu/types" />
/**
 * Bind group cache for hot post-process / effects paths.
 *
 * Post-process effects (Bloom, SSAO, DoF, GodRays, AutoExposure, etc.)
 * create their bind groups every frame using stable input textures,
 * samplers, and uniform buffers. The first `execute()` allocates a
 * fresh `GPUBindGroup`; every subsequent frame, the same resource
 * tuple allocates another `GPUBindGroup` that is identical to the
 * previous frame's. Each bind group carries ~150-300 bytes of driver
 * state that is only reclaimed when the wrapper is GC'd.
 *
 * At ~60 Hz with a 4-stage bloom pipeline, the Naive path burns
 * 4×60 = 240 GPUBindGroup objects per second, plus allocations for
 * every other active effect. For long-running Cesium viewer sessions
 * (planetary tours, kiosk installations) this is the dominant memory
 * growth class.
 *
 * {@link WebGPUBindGroupCache} keys each bind group on the composite
 * identity of its inputs (`layout` + each `entry.resource`) using a
 * per-cache identity map. When the inputs are stable, `getOrCreate()`
 * returns the same bind group across frames and skips the allocation.
 * When any input changes (typical after a texture resize), the cache
 * produces a new bind group and evicts the stale one lazily.
 *
 * Fix sketch: **C-R11** of the Renderer-Deep principal-engineer review.
 *
 * @private
 */

/**
 * A subset of `GPUBindGroupEntry` with enough structure for identity-
 * based caching. We read the resource-object identity directly — we
 * don't need `GPUBindGroupEntry`'s full contract for key computation.
 */
export type CacheableBindGroupEntry =
  | {
      binding: number;
      resource: GPUTextureView | GPUSampler;
    }
  | {
      binding: number;
      resource: {
        buffer: GPUBuffer;
        offset?: number;
        size?: number;
      };
    }
  | {
      binding: number;
      resource: GPUExternalTexture;
    };

/**
 * Per-cache identity-based bind group store.
 *
 * Usage (typical effect path):
 * ```ts
 * class BloomEffect {
 *   private _bgCache = new WebGPUBindGroupCache();
 *
 *   execute(encoder, sourceView, ..., sampler) {
 *     const brightBG = this._bgCache.getOrCreate(device, "Bloom-Bright",
 *       this._singleTexLayout, [
 *         { binding: 0, resource: sourceView },
 *         { binding: 1, resource: sampler },
 *         { binding: 2, resource: { buffer: this._brightUniforms } },
 *       ]);
 *     // ...
 *   }
 *
 *   resize(...) {
 *     // Texture views change on resize; drop stale entries.
 *     this._bgCache.invalidateAll();
 *     // ... recreate textures
 *   }
 * }
 * ```
 */
/**
 * Hit/miss/invalidation counters surfaced by {@link WebGPUBindGroupCache.getStats}.
 * Useful for confirming the dedup architecture is actually saving allocations
 * — a 0% hit rate signals that resource identities are churning every frame
 * (typical cause: texture views reallocated without a corresponding cache
 * invalidation).
 */
export interface BindGroupCacheStats {
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  readonly invalidations: number;
  /** Number of entries dropped by bounded LRU / age eviction. */
  readonly evictions: number;
  /** Hit rate as a fraction in [0, 1]. NaN when no lookups have run. */
  readonly hitRate: number;
}

/**
 * Eviction-tuning knobs. Both are bounded growth guards, not correctness
 * controls — a stable-identity caller never hits either bound because its
 * key set is finite. They exist for the pathological churn case the class
 * docstring warns about (input texture views recreated every frame without
 * a matching {@link WebGPUBindGroupCache.invalidateAll}), where the key set
 * grows once per frame forever.
 */
export interface BindGroupCacheOptions {
  /**
   * Hard upper bound on distinct cached bind groups. On a miss that would
   * exceed this, the least-recently-used entry is evicted first. Default
   * 1024 — comfortably above any real post-process pipeline's stable key
   * set (a 4-stage bloom is single digits) while capping a churning
   * cache's growth.
   */
  maxEntries?: number;
  /**
   * Evict entries not touched within this many `beginFrame()` ticks. 0
   * disables age eviction (LRU cap still applies). Default 0 — most
   * effect caches don't drive a frame clock; callers that do (or that
   * want a TTL) pass a positive value. ~600 ≈ 10 s at 60 fps.
   */
  maxIdleFrames?: number;
}

/** One cached bind group plus the frame it was last touched (for age eviction). */
interface BindGroupCacheEntry {
  bindGroup: GPUBindGroup;
  lastUsedFrame: number;
}

export class WebGPUBindGroupCache {
  // Map iteration order == insertion order; we keep it as a recency list by
  // re-inserting (delete + set) an entry whenever it's touched. The first
  // key in iteration order is therefore the least-recently-used → O(1)
  // eviction without a separate ordering structure.
  private _map = new Map<string, BindGroupCacheEntry>();
  private _idCounter = 0;
  // WeakMap keyed on the resource object (GPUTextureView / GPUSampler /
  // GPUBuffer / GPUBindGroupLayout / GPUExternalTexture). The counter
  // is append-only; IDs for collected resources become unreachable as
  // the browser reclaims the WeakMap entry.
  private _idMap = new WeakMap<object, number>();
  // AUDIT_2026_05_02 C.8 — hit/miss telemetry so PerformanceManager can
  // surface "are we actually deduping?" Cheap counters; no allocation in
  // the hot path.
  private _hits = 0;
  private _misses = 0;
  private _invalidations = 0;
  // NEW-BINDGROUPCACHE-EVICTION — bounded growth guards.
  private _evictions = 0;
  private _maxEntries: number;
  private _maxIdleFrames: number;
  private _currentFrame = 0;

  constructor(options: BindGroupCacheOptions = {}) {
    this._maxEntries = options.maxEntries ?? 1024;
    this._maxIdleFrames = options.maxIdleFrames ?? 0;
  }

  /** Stable numeric ID for any GPU resource object. */
  private _idFor(obj: object): number {
    let id = this._idMap.get(obj);
    if (id === undefined) {
      id = ++this._idCounter;
      this._idMap.set(obj, id);
    }
    return id;
  }

  /**
   * Fetch or create a `GPUBindGroup` for the given layout + entries.
   *
   * The cache key encodes each entry's `binding` plus the identity of
   * its resource object (texture view, sampler, buffer, or external
   * texture). Buffer entries additionally encode `offset` / `size`
   * because the same `GPUBuffer` can back multiple bind groups at
   * different byte ranges.
   *
   * Returns the cached bind group on a hit, allocates + stores a new
   * one on a miss. No invalidation unless the caller explicitly calls
   * {@link invalidateAll} — the typical resize hook.
   */
  getOrCreate(
    device: GPUDevice,
    label: string,
    layout: GPUBindGroupLayout,
    entries: CacheableBindGroupEntry[],
  ): GPUBindGroup {
    const keyParts: string[] = [`l:${this._idFor(layout)}`];
    for (const entry of entries) {
      const res = entry.resource as unknown;
      if (
        res !== null &&
        typeof res === "object" &&
        "buffer" in (res as object)
      ) {
        const b = res as { buffer: GPUBuffer; offset?: number; size?: number };
        keyParts.push(
          `b${entry.binding}:${this._idFor(b.buffer)}:${b.offset ?? 0}:${
            b.size ?? -1
          }`,
        );
      } else if (res !== null && typeof res === "object") {
        keyParts.push(`r${entry.binding}:${this._idFor(res as object)}`);
      } else {
        keyParts.push(`n${entry.binding}`);
      }
    }
    const key = keyParts.join("|");

    const existing = this._map.get(key);
    if (existing) {
      this._hits++;
      // Touch for LRU recency: move to the tail of the iteration order so
      // it isn't a near-term eviction candidate, and stamp the frame for
      // age eviction.
      existing.lastUsedFrame = this._currentFrame;
      this._map.delete(key);
      this._map.set(key, existing);
      return existing.bindGroup;
    }

    this._misses++;
    // Make room before inserting so the cache never exceeds the cap.
    if (this._map.size >= this._maxEntries) {
      this._evictLRU();
    }
    const bindGroup = device.createBindGroup({
      label,
      layout,
      entries: entries as GPUBindGroupEntry[],
    });
    this._map.set(key, { bindGroup, lastUsedFrame: this._currentFrame });
    return bindGroup;
  }

  /**
   * Evict the single least-recently-used entry. The first key in Map
   * iteration order is the LRU because every hit re-inserts its entry at
   * the tail. O(1) — `keys().next()` short-circuits on the first key.
   */
  private _evictLRU(): void {
    const lruKey = this._map.keys().next().value;
    if (lruKey !== undefined) {
      this._map.delete(lruKey);
      this._evictions++;
    }
  }

  /**
   * Advance the frame clock and, when `maxIdleFrames > 0`, drop entries
   * not touched within that window. Call once per frame from the owner's
   * frame loop. No-op for age eviction when `maxIdleFrames === 0` (the
   * LRU cap still bounds growth on every miss regardless).
   */
  beginFrame(): void {
    this._currentFrame++;
    if (this._maxIdleFrames <= 0) return;
    const threshold = this._currentFrame - this._maxIdleFrames;
    for (const [key, entry] of this._map) {
      if (entry.lastUsedFrame < threshold) {
        this._map.delete(key);
        this._evictions++;
      }
    }
  }

  /**
   * Drop all cached entries. Call this on effect resize (texture views
   * change), device loss (WeakMap identities survive but the underlying
   * bind groups are destroyed), or whenever the effect's input graph is
   * reconfigured.
   */
  invalidateAll(): void {
    if (this._map.size > 0) this._invalidations++;
    this._map.clear();
  }

  /** Number of distinct bind groups currently cached. For diagnostics. */
  get size(): number {
    return this._map.size;
  }

  /**
   * AUDIT_2026_05_02 C.8 — telemetry snapshot of cache effectiveness.
   * A hitRate near 0 means the dedup architecture isn't working — typically
   * because input texture views are recreated every frame without a
   * matching `invalidateAll` call.
   */
  getStats(): BindGroupCacheStats {
    const total = this._hits + this._misses;
    return {
      size: this._map.size,
      hits: this._hits,
      misses: this._misses,
      invalidations: this._invalidations,
      evictions: this._evictions,
      hitRate: total > 0 ? this._hits / total : NaN,
    };
  }

  /** Reset hit/miss/invalidation/eviction counters without dropping cache contents. */
  resetStats(): void {
    this._hits = 0;
    this._misses = 0;
    this._invalidations = 0;
    this._evictions = 0;
  }
}

export default WebGPUBindGroupCache;
