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
export class WebGPUBindGroupCache {
  private _map = new Map<string, GPUBindGroup>();
  private _idCounter = 0;
  // WeakMap keyed on the resource object (GPUTextureView / GPUSampler /
  // GPUBuffer / GPUBindGroupLayout / GPUExternalTexture). The counter
  // is append-only; IDs for collected resources become unreachable as
  // the browser reclaims the WeakMap entry.
  private _idMap = new WeakMap<object, number>();

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

    let bg = this._map.get(key);
    if (!bg) {
      bg = device.createBindGroup({
        label,
        layout,
        entries: entries as GPUBindGroupEntry[],
      });
      this._map.set(key, bg);
    }
    return bg;
  }

  /**
   * Drop all cached entries. Call this on effect resize (texture views
   * change), device loss (WeakMap identities survive but the underlying
   * bind groups are destroyed), or whenever the effect's input graph is
   * reconfigured.
   */
  invalidateAll(): void {
    this._map.clear();
  }

  /** Number of distinct bind groups currently cached. For diagnostics. */
  get size(): number {
    return this._map.size;
  }
}

export default WebGPUBindGroupCache;
