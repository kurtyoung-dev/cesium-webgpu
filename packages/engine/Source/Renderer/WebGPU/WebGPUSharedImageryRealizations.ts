/// <reference types="@webgpu/types" />
/**
 * Per-renderer (= per-`GPUDevice`) table of shared imagery GPU realizations
 * (C9-12A-IMAGERY-SOURCE-REALIZATION-DEDUP-AND-MIP-PREP; hardened Batch 686).
 *
 * NOTE on scope (Batch-686 F0c): the owning `WebGPUGlobeSurfaceRenderer` is
 * keyed per pooled `GPUDevice` (`GlobeSurfaceTileProviderRendering`), so when
 * two viewers share one device they share ONE renderer and therefore ONE of
 * these tables. The table is NOT per-context — no context object may be
 * captured here (see the clock and destroy invariants below).
 *
 * A single immutable imagery source (see `Renderer/ImagerySourceIdentity`) is
 * realized into ONE `GPUTexture` + `GPUTextureView`, shared by reference across
 * every terrain-tile imagery cache entry that binds it. Tile entries hold
 * references. When a reference count reaches zero:
 *
 *   - an entry that was EVER shared (peak refCount > 1, or revived/re-leased
 *     after reaching zero) enters a byte-budgeted zero-ref pool so churn (a
 *     tile evicted and re-selected shortly after) revives the same realization
 *     rather than re-uploading;
 *   - an entry that was NEVER shared (a streamed per-tile `ImageBitmap` that
 *     never recurred) is retired PROMPTLY — parity with the owned-texture path
 *     for the streaming class, so unique bitmaps never accumulate in the pool
 *     (Batch-686 F2a).
 *
 * The zero-ref pool is bounded HARD by `BYTE_BUDGET`: whenever the summed
 * zero-ref bytes exceed it, `sweep` retires oldest-first regardless of age
 * until at/below budget. While under budget, zero-ref entries are simply kept
 * (Batch-686 F2b — there is no age-based retirement; age orders eviction).
 *
 * Invariants:
 *   - Active/leased realizations (refCount > 0) are pinned unconditionally.
 *   - The table keeps its OWN monotonic clock (one tick per `sweep` call) for
 *     zero-ref ordering. It never reads any scene's `frameNumber` — multiple
 *     scenes sharing the device each trigger sweeps, which merely advances the
 *     clock faster than wall-frames (shorter effective retention — the safe
 *     direction) and can never produce negative ages or a stuck pool
 *     (Batch-686 F0a).
 *   - Destruction always routes through a `scheduleDestroy` callback supplied
 *     BY THE CALLER at call time (`release`/`sweep`/`destroyAll`), so it uses
 *     a currently-live context's deferred-destroy queue. The table never
 *     stores a context-owned closure — a captured closure would pin the first
 *     context and degrade to inline `texture.destroy()` on a still-live device
 *     after that context dies (Batch-686 F0b).
 *   - The table is keyed to one `GPUDevice`. On device change the owner
 *     rebuilds a fresh table (this one is torn down); GPU handles never cross
 *     device generations.
 *
 * @module WebGPUSharedImageryRealizations
 */

/** Hard budget for total zero-ref (pooled) bytes. Whenever the summed zero-ref
 * byte total exceeds this, `sweep` retires oldest-first regardless of age until
 * at/below budget; under budget, pooled realizations are kept for revival. */
const BYTE_BUDGET = 64 * 1024 * 1024;

/** Destruction callback supplied by the calling context at call time — always
 * `WebGPUContext.scheduleTextureDestroy` of a LIVE context (never stored). */
export type ScheduleTextureDestroy = (texture: GPUTexture) => void;

export interface SharedImageryRealization {
  fingerprint: string;
  texture: GPUTexture;
  view: GPUTextureView;
  byteSize: number;
  refCount: number;
  /** True once the realization has ever served more than one simultaneous
   * reference OR been revived/re-leased after reaching zero — i.e. actual
   * reuse was observed. Never-shared entries retire promptly at zero refs. */
  everShared: boolean;
  /** Internal sweep-clock tick when refCount last reached 0; -1 while
   * referenced. Orders oldest-first eviction; never a scene frame number. */
  zeroRefSinceTick: number;
}

export interface SharedImageryRealizationDiagnostics {
  entries: number;
  liveBytes: number;
  zeroRefBytes: number;
  highWaterEntries: number;
  highWaterBytes: number;
}

export class WebGPUSharedImageryRealizations {
  private readonly _device: GPUDevice;
  private readonly _entries = new Map<string, SharedImageryRealization>();
  private _highWaterEntries = 0;
  private _highWaterBytes = 0;
  // F0a — internal monotonic clock: one tick per sweep() call. The ONLY time
  // source used for zeroRefSinceTick stamps and eviction ordering.
  private _clock = 0;

  constructor(device: GPUDevice) {
    this._device = device;
  }

  /** The device this table's realizations belong to; owner compares against its
   * live device to detect a device-generation change. */
  get device(): GPUDevice {
    return this._device;
  }

  /**
   * Fetch an existing realization for a fingerprint, reviving it from the
   * zero-ref pool (refCount 0 → 1) when found. Any hit marks the entry as
   * shared — reuse has been observed. Returns undefined on a miss.
   */
  get(fingerprint: string): SharedImageryRealization | undefined {
    const entry = this._entries.get(fingerprint);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.refCount === 0) {
      entry.refCount = 1;
      entry.zeroRefSinceTick = -1;
    } else {
      entry.refCount++;
    }
    entry.everShared = true;
    return entry;
  }

  /**
   * Register a freshly-created realization (refCount = 1, not yet shared). The
   * caller owns the texture/view creation; the table owns their lifetime from
   * here.
   */
  register(
    fingerprint: string,
    texture: GPUTexture,
    view: GPUTextureView,
    byteSize: number,
  ): SharedImageryRealization {
    const entry: SharedImageryRealization = {
      fingerprint,
      texture,
      view,
      byteSize,
      refCount: 1,
      everShared: false,
      zeroRefSinceTick: -1,
    };
    this._entries.set(fingerprint, entry);
    if (this._entries.size > this._highWaterEntries) {
      this._highWaterEntries = this._entries.size;
    }
    const liveBytes = this._sumBytes();
    if (liveBytes > this._highWaterBytes) {
      this._highWaterBytes = liveBytes;
    }
    return entry;
  }

  addRef(entry: SharedImageryRealization): void {
    if (entry.refCount === 0) {
      entry.zeroRefSinceTick = -1;
    }
    entry.refCount++;
    if (entry.refCount > 1) {
      entry.everShared = true;
    }
  }

  /**
   * Drop one reference. At zero: an ever-shared realization enters the
   * zero-ref pool stamped with the current internal clock tick; a never-shared
   * one (streamed per-tile bitmap that never recurred) is retired PROMPTLY via
   * the caller's `scheduleDestroy` (F2a). Returns true when the entry was
   * retired by this call (so callers can hit retirement counters).
   */
  release(
    entry: SharedImageryRealization,
    scheduleDestroy: ScheduleTextureDestroy,
  ): boolean {
    if (entry.refCount <= 0) {
      return false;
    }
    entry.refCount--;
    if (entry.refCount !== 0) {
      return false;
    }
    if (!entry.everShared) {
      this._entries.delete(entry.fingerprint);
      scheduleDestroy(entry.texture);
      return true;
    }
    entry.zeroRefSinceTick = this._clock;
    return false;
  }

  /**
   * Byte-budget sweep — call once per frame per owning scene. Advances the
   * internal clock, then, while total zero-ref bytes exceed BYTE_BUDGET,
   * retires zero-ref realizations oldest-first REGARDLESS of age until
   * at/below budget (F2b). Active realizations are never touched. Returns the
   * number retired.
   */
  sweep(scheduleDestroy: ScheduleTextureDestroy): number {
    this._clock++;
    let zeroRefBytes = 0;
    let zeroRefCount = 0;
    for (const entry of this._entries.values()) {
      if (entry.refCount === 0) {
        zeroRefBytes += entry.byteSize;
        zeroRefCount++;
      }
    }
    if (zeroRefBytes <= BYTE_BUDGET || zeroRefCount === 0) {
      return 0;
    }

    const candidates: SharedImageryRealization[] = [];
    for (const entry of this._entries.values()) {
      if (entry.refCount === 0) {
        candidates.push(entry);
      }
    }
    candidates.sort((a, b) => a.zeroRefSinceTick - b.zeroRefSinceTick);

    let retired = 0;
    for (let i = 0; i < candidates.length && zeroRefBytes > BYTE_BUDGET; ++i) {
      const entry = candidates[i];
      this._entries.delete(entry.fingerprint);
      scheduleDestroy(entry.texture);
      zeroRefBytes -= entry.byteSize;
      retired++;
    }
    return retired;
  }

  /** Teardown / device change: schedule destruction of every realization via
   * the caller-supplied (live-context) destroy route. */
  destroyAll(scheduleDestroy: ScheduleTextureDestroy): void {
    for (const entry of this._entries.values()) {
      scheduleDestroy(entry.texture);
    }
    this._entries.clear();
  }

  getDiagnostics(): SharedImageryRealizationDiagnostics {
    let liveBytes = 0;
    let zeroRefBytes = 0;
    for (const entry of this._entries.values()) {
      liveBytes += entry.byteSize;
      if (entry.refCount === 0) {
        zeroRefBytes += entry.byteSize;
      }
    }
    return {
      entries: this._entries.size,
      liveBytes,
      zeroRefBytes,
      highWaterEntries: this._highWaterEntries,
      highWaterBytes: this._highWaterBytes,
    };
  }

  private _sumBytes(): number {
    let bytes = 0;
    for (const entry of this._entries.values()) {
      bytes += entry.byteSize;
    }
    return bytes;
  }
}

export default WebGPUSharedImageryRealizations;
