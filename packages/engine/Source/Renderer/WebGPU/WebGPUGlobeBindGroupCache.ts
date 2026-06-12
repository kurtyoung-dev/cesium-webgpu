/// <reference types="@webgpu/types" />
/**
 * Per-tile bind-group cache for the globe surface renderer
 * (NEW-GLOBE-BINDGROUP-CACHE, Batch 241).
 *
 * Before this cache, `WebGPUGlobeSurfaceRenderer.createTileCommands`
 * called `device.createBindGroup` 3-4 times per tile per pass per FRAME
 * (~600-800 creations/sec steady-state at a fixed camera). Bind groups
 * are immutable descriptors over resource identities, so re-creating
 * one whose bound resources haven't changed is pure waste.
 *
 * Keying strategy (mirrors the C-R11 effects-BG cache in
 * `WebGPUEffectsBindGroup.js`): every GPU resource object gets a stable
 * numeric identity via WeakMap; a bind group's key is the joined
 * identity tuple of its actual bound resources. This is the
 * Batch-139 lesson applied — key on the stable underlying objects
 * (textures' cached views, buffers, offsets), never on per-frame
 * wrapper objects.
 *
 *   - Group 0 (camera UB + tile UB): keyed on
 *     `(buffer id, byte offset)` for both slices. The UBs are
 *     sub-allocated from the per-frame ring allocator
 *     (`WebGPURingBufferAllocator`, N pages cycling). At a settled
 *     camera the per-frame allocation sequence is deterministic, so
 *     the same (page, offset) tuples recur with period = pageCount and
 *     the cache converges to ~pageCount entries per tile-pass with
 *     ZERO steady-state creations. When the allocation sequence shifts
 *     (tile churn during pan), keys miss and fresh entries are created
 *     — exactly the pre-cache behavior, never worse. The full fix for
 *     offset-churn during motion is dynamic-offset BGL conversion
 *     (NEW-GLOBE-DYNAMIC-OFFSET-UBO) — tracked, out of scope here.
 *   - Group 1 (16 imagery texture views + sampler): keyed on the 16
 *     view identities. Views are stable per texture — they're created
 *     once and cached in `_imageryTextureCache` /
 *     `_waterMaskTextureCache` alongside their `GPUTexture` (see
 *     `WebGPUGlobeSurfaceTextures.ts`); when a texture rotates, a new
 *     view object appears and the key changes.
 *   - Group 2 (water mask + ocean normal + material UBO/textures):
 *     keyed on the 5 variable resource identities. Samplers and the
 *     placeholder material UBO are init-time singletons.
 *   - Group 3 (effects) is NOT routed through this cache — it already
 *     has its own identity-keyed cache (C-R11-EFFECTS-BGL-COLLECTION-
 *     CACHE, Batch 55) shared with the model/primitive paths.
 *
 * Eviction: age-based. Entries unused for `EVICT_AFTER_FRAMES` are
 * dropped on a periodic scan (`SCAN_EVERY_FRAMES`). This bounds the
 * cache during tile churn (pan/zoom) and reclaims entries whose
 * underlying textures/ring-pages were destroyed — a stale entry is
 * harmless as long as it's never looked up again, because destroyed
 * resources can never re-acquire the same identity key.
 *
 * Stats: creation/hit counters are debug-pragma'd (zero cost in
 * production builds). Read them via `CesiumDebug.globeBindGroups()`
 * or `globalThis.__webgpuGlobeBindGroupCache.getStats()`.
 *
 * Why not reuse the generic `WebGPUBindGroupCache` (C-R11, post-process
 * paths)? Three contract differences, each load-bearing here:
 *   1. The generic cache has NO eviction (only `invalidateAll()` —
 *      tracked as NEW-BINDGROUPCACHE-EVICTION). The globe tile path is
 *      the highest key-churn path in the engine (group-0 keys rotate
 *      with ring-allocator offsets during camera motion); without
 *      aging, the map grows unboundedly over long sessions.
 *   2. Its `getOrCreate(device, label, layout, entries)` requires the
 *      caller to build the full entries array per call to compute the
 *      key — a 17-entry array per tile-pass per frame on the group-1
 *      path even on hits. This cache takes a caller-computed compact
 *      key and only runs the builder on miss.
 *   3. Per-frame stat windows (`lastFrameCreates`) that the regression
 *      probe and `CesiumDebug.globeBindGroups()` assert on.
 * If the generic cache later grows aging + keyed lookups, folding this
 * one into it is a welcome consolidation.
 *
 * @private
 */

interface BindGroupCacheEntry {
  bindGroup: GPUBindGroup;
  lastUsedFrame: number;
}

/** Statistics snapshot returned by {@link WebGPUGlobeBindGroupCache.getStats}. */
export interface GlobeBindGroupCacheStats {
  /** Live entry count in the cache map. */
  entries: number;
  /** Lifetime `device.createBindGroup` calls routed through the cache (debug builds only). */
  creates: number;
  /** Lifetime cache hits (debug builds only). */
  hits: number;
  /** Creations during the last completed frame (debug builds only). */
  lastFrameCreates: number;
  /** Hits during the last completed frame (debug builds only). */
  lastFrameHits: number;
  /** Lifetime hit rate 0..1 (debug builds only; 0 when no traffic). */
  hitRate: number;
  /** Frame number of the most recent beginFrame tick. */
  frameNumber: number;
}

// Entries unused for this many frames get evicted. ~10s at 60fps —
// long enough that a brief camera excursion and return still hits,
// short enough that pan-churn entries don't accumulate.
const EVICT_AFTER_FRAMES = 600;
// Run the eviction scan every N frames. Scan cost is O(entries) string
// map iteration — trivial at the ~100-1000 entry scale this cache runs.
const SCAN_EVERY_FRAMES = 120;

export class WebGPUGlobeBindGroupCache {
  private _entries: Map<string, BindGroupCacheEntry> = new Map();
  // Stable numeric identity per GPU resource object. Append-only; GC
  // reclaims slots when the resource becomes unreachable (WeakMap).
  private _idMap: WeakMap<object, number> = new WeakMap();
  private _idCounter = 0;
  private _frameNumber = -1;
  private _lastScanFrame = 0;

  // ── Stats ──
  // Public underscore: `_bindGroupCreates` is the probe-visible counter
  // named by NEW-GLOBE-BINDGROUP-CACHE. Increments are pragma-stripped
  // in production builds; the fields read 0 there.
  public _bindGroupCreates = 0;
  public _bindGroupHits = 0;
  private _createsThisFrame = 0;
  private _hitsThisFrame = 0;
  private _lastFrameCreates = 0;
  private _lastFrameHits = 0;

  /**
   * Stable >0 identity for a GPU resource object; 0 for null/undefined.
   */
  idOf(resource: object | null | undefined): number {
    if (resource === null || resource === undefined) {
      return 0;
    }
    let id = this._idMap.get(resource);
    if (id === undefined) {
      id = ++this._idCounter;
      this._idMap.set(resource, id);
    }
    return id;
  }

  /**
   * Per-frame tick. Safe to call once per tile — no-ops unless the
   * frame number actually changed. Rolls the per-frame stat counters
   * and runs the periodic age-based eviction scan.
   */
  beginFrame(frameNumber: number): void {
    if (frameNumber === this._frameNumber) {
      return;
    }
    this._frameNumber = frameNumber;
    //>>includeStart('debug', pragmas.debug);
    this._lastFrameCreates = this._createsThisFrame;
    this._lastFrameHits = this._hitsThisFrame;
    this._createsThisFrame = 0;
    this._hitsThisFrame = 0;
    //>>includeEnd('debug');

    if (Math.abs(frameNumber - this._lastScanFrame) >= SCAN_EVERY_FRAMES) {
      this._lastScanFrame = frameNumber;
      const cutoff = frameNumber - EVICT_AFTER_FRAMES;
      for (const [key, entry] of this._entries) {
        if (entry.lastUsedFrame < cutoff) {
          this._entries.delete(key);
        }
      }
    }
  }

  /**
   * Return the cached bind group for `key`, or build + cache it.
   * The builder runs only on miss.
   */
  getOrCreate(key: string, build: () => GPUBindGroup): GPUBindGroup {
    const existing = this._entries.get(key);
    if (existing !== undefined) {
      existing.lastUsedFrame = this._frameNumber;
      //>>includeStart('debug', pragmas.debug);
      this._bindGroupHits++;
      this._hitsThisFrame++;
      //>>includeEnd('debug');
      return existing.bindGroup;
    }
    const bindGroup = build();
    this._entries.set(key, { bindGroup, lastUsedFrame: this._frameNumber });
    //>>includeStart('debug', pragmas.debug);
    this._bindGroupCreates++;
    this._createsThisFrame++;
    //>>includeEnd('debug');
    return bindGroup;
  }

  get size(): number {
    return this._entries.size;
  }

  getStats(): GlobeBindGroupCacheStats {
    const total = this._bindGroupCreates + this._bindGroupHits;
    return {
      entries: this._entries.size,
      creates: this._bindGroupCreates,
      hits: this._bindGroupHits,
      lastFrameCreates: this._lastFrameCreates,
      lastFrameHits: this._lastFrameHits,
      hitRate: total > 0 ? this._bindGroupHits / total : 0,
      frameNumber: this._frameNumber,
    };
  }

  clear(): void {
    this._entries.clear();
  }
}

export default WebGPUGlobeBindGroupCache;
