/// <reference types="@webgpu/types" />
/**
 * Persistent target pool for the dynamic-environment refresh path.
 *
 * Without it, every refresh creates and destroys its own packed parameter arena
 * buffer (`createIBLCommandEncodingScope` / `destroyIBLCommandEncodingScope`),
 * and every manager privately owns a `size x size` capture depth target for a
 * resource that is `depthStoreOp: "discard"` and therefore has no cross-refresh
 * contents worth keeping per-owner. Behind the bounded refresh drain, this
 * small context-owned pool lets the whole refresh path settle on a handful of
 * long-lived objects instead of one create/destroy pair per refresh per
 * manager.
 *
 * ## Ownership and device generation
 *
 * The pool is context-owned and keyed to exactly one `(device,
 * resourceGeneration)` pair. Nothing from a previous generation may ever be
 * handed out: `adopt()` destroys the whole cache when either identity changes,
 * and a handle released while carrying a stale generation is destroyed rather
 * than pooled. Both identities are tracked for the same reason the dynamic
 * environment cache tracks both — `device` catches replacement-device swaps
 * directly, while `resourceGeneration` follows the context's recovery epoch
 * even if a recovery implementation preserves a wrapper identity. Borrowed
 * handles stamp and validate both halves of that tuple on release.
 *
 * ## In-flight safety
 *
 * A released handle is not destroyed; it returns to a free list. That is what
 * makes release-before-submit safe: WebGPU keeps a texture or buffer alive for
 * commands already recorded against it as long as `destroy()` is not called.
 * Re-issuing the same depth target to another consumer inside one frame is
 * likewise safe because every capture face pass uses `depthLoadOp: "clear"`, so
 * no consumer can observe another's depth. The idle trim is the one path that
 * does destroy, so it refuses to touch anything used on the current frame.
 *
 * @module WebGPUEnvironmentTargetPool
 */

/** Smallest parameter-arena bucket. Below this the bucketing has no value. */
const MIN_PARAMETER_BYTES = 256;

/** Free entries retained per bucket. Over this, release destroys instead. */
const MAX_IDLE_PER_BUCKET = 2;

/** Frames an unused entry survives a trim before it is destroyed. */
const IDLE_TRIM_FRAMES = 120;

/** Handle returned by {@link WebGPUEnvironmentTargetPool#acquireParameterBuffer}. */
export interface PooledParameterBuffer {
  buffer: GPUBuffer;
  byteLength: number;
  /** Bucket key; also the buffer's real allocated size. */
  capacityBytes: number;
  /** Exact physical device that allocated {@link buffer}. */
  device: GPUDevice;
  generation: number;
}

/** Handle returned by {@link WebGPUEnvironmentTargetPool#acquireDepthTarget}. */
export interface PooledDepthTarget {
  texture: GPUTexture;
  view: GPUTextureView;
  size: number;
  format: GPUTextureFormat;
  /** Exact physical device that allocated {@link texture}. */
  device: GPUDevice;
  generation: number;
}

interface PooledBufferEntry {
  buffer: GPUBuffer;
  capacityBytes: number;
  lastUsedFrameId: number;
}

interface PooledDepthEntry {
  texture: GPUTexture;
  view: GPUTextureView;
  size: number;
  format: GPUTextureFormat;
  lastUsedFrameId: number;
}

interface DetachedPoolEntries {
  buffers: Map<number, PooledBufferEntry[]>;
  depth: Map<string, PooledDepthEntry[]>;
}

interface PoolCleanupResult {
  failed: boolean;
  firstError: unknown;
}

/** Plain, JSON-safe counters exposed through renderer statistics. */
export interface WebGPUEnvironmentTargetPoolTelemetry {
  resourceGeneration: number;
  frameId: number;
  bufferAcquires: number;
  bufferHits: number;
  bufferCreates: number;
  bufferDestroys: number;
  bufferIdle: number;
  bufferLive: number;
  depthAcquires: number;
  depthHits: number;
  depthCreates: number;
  depthDestroys: number;
  depthIdle: number;
  depthLive: number;
  staleReleases: number;
  generationResets: number;
  trimmed: number;
}

function bucketBytes(byteLength: number): number {
  const requested = Math.max(
    MIN_PARAMETER_BYTES,
    Math.ceil(Number.isFinite(byteLength) ? byteLength : MIN_PARAMETER_BYTES),
  );
  // Next power of two, so a handful of buckets covers every HQ / non-HQ
  // parameter capacity the refresh path asks for.
  let bucket = MIN_PARAMETER_BYTES;
  while (bucket < requested) {
    bucket *= 2;
  }
  return bucket;
}

function depthKey(size: number, format: GPUTextureFormat): string {
  return `${size}:${format}`;
}

/**
 * Per-context, generation-keyed pool of transient environment-refresh targets.
 */
export class WebGPUEnvironmentTargetPool {
  private _device: GPUDevice;
  private _resourceGeneration: number;
  private _frameId = 0;
  private _idleBuffers = new Map<number, PooledBufferEntry[]>();
  private _idleDepth = new Map<string, PooledDepthEntry[]>();
  private _liveBuffers = 0;
  private _liveDepth = 0;
  private _destroyed = false;
  private _telemetry: WebGPUEnvironmentTargetPoolTelemetry;

  constructor(device: GPUDevice, resourceGeneration: number) {
    this._device = device;
    this._resourceGeneration = resourceGeneration;
    this._telemetry = this._createTelemetry();
  }

  get resourceGeneration(): number {
    return this._resourceGeneration;
  }

  get device(): GPUDevice {
    return this._device;
  }

  get isDestroyed(): boolean {
    return this._destroyed;
  }

  /**
   * Adopt the current device identity for a new frame.
   *
   * A change in either identity destroys the entire cache before anything is
   * handed out, so a recovered context can never issue a lost device's object.
   */
  beginFrame(
    frameId: number,
    device: GPUDevice,
    resourceGeneration: number,
  ): void {
    this._frameId = frameId;
    this.adopt(device, resourceGeneration);
  }

  adopt(device: GPUDevice, resourceGeneration: number): void {
    if (this._destroyed) {
      return;
    }
    if (
      device === this._device &&
      resourceGeneration === this._resourceGeneration
    ) {
      return;
    }
    // Detach and publish first. A native destroy() owned by the lost tuple may
    // throw (or re-enter in a synthetic implementation), but neither case may
    // leave the old maps/device identity addressable or roll back recovery.
    const detached = this._detachAllEntries();
    this._device = device;
    this._resourceGeneration = resourceGeneration;
    // Objects handed out under the old generation are still owned by their
    // borrowers. They are refused on release (and destroyed there) rather than
    // tracked here, because the borrower is the only party that knows when its
    // commands stopped referencing them.
    this._liveBuffers = 0;
    this._liveDepth = 0;
    this._telemetry.generationResets += 1;
    this._telemetry.resourceGeneration = resourceGeneration;
    const cleanup = this._destroyDetachedEntries(detached);
    if (cleanup.failed) {
      // lint-debug-pragmas-allow: old-device cleanup is diagnostic, never candidate-fatal
      console.warn(
        "[WebGPU] Environment target pool adopted with an old-device cleanup error:",
        cleanup.firstError,
      );
    }
  }

  /**
   * Borrow a uniform parameter arena of at least `byteLength` bytes.
   *
   * The returned buffer's real size is `capacityBytes` (the bucket), which is
   * >= `byteLength`. Callers must write and bind only within `byteLength`.
   */
  acquireParameterBuffer(
    byteLength: number,
    label: string,
  ): PooledParameterBuffer {
    const capacityBytes = bucketBytes(byteLength);
    const telemetry = this._telemetry;
    telemetry.bufferAcquires += 1;

    const free = this._idleBuffers.get(capacityBytes);
    if (free !== undefined && free.length > 0) {
      const entry = free.pop() as PooledBufferEntry;
      this._liveBuffers += 1;
      telemetry.bufferHits += 1;
      telemetry.bufferIdle = this._countIdleBuffers();
      telemetry.bufferLive = this._liveBuffers;
      return {
        buffer: entry.buffer,
        byteLength,
        capacityBytes,
        device: this._device,
        generation: this._resourceGeneration,
      };
    }

    const buffer = this._device.createBuffer({
      label: label,
      size: capacityBytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._liveBuffers += 1;
    telemetry.bufferCreates += 1;
    telemetry.bufferLive = this._liveBuffers;
    return {
      buffer,
      byteLength,
      capacityBytes,
      device: this._device,
      generation: this._resourceGeneration,
    };
  }

  /** Return a parameter arena. Stale generations are destroyed, not pooled. */
  releaseParameterBuffer(handle: PooledParameterBuffer | null): void {
    if (handle === null) {
      return;
    }
    const telemetry = this._telemetry;
    if (
      this._destroyed ||
      handle.device !== this._device ||
      handle.generation !== this._resourceGeneration
    ) {
      telemetry.staleReleases += 1;
      telemetry.bufferDestroys += 1;
      handle.buffer.destroy();
      return;
    }

    this._liveBuffers = Math.max(0, this._liveBuffers - 1);
    let free = this._idleBuffers.get(handle.capacityBytes);
    if (free === undefined) {
      free = [];
      this._idleBuffers.set(handle.capacityBytes, free);
    }
    if (free.length >= MAX_IDLE_PER_BUCKET) {
      telemetry.bufferDestroys += 1;
      handle.buffer.destroy();
    } else {
      free.push({
        buffer: handle.buffer,
        capacityBytes: handle.capacityBytes,
        lastUsedFrameId: this._frameId,
      });
    }
    telemetry.bufferIdle = this._countIdleBuffers();
    telemetry.bufferLive = this._liveBuffers;
  }

  /**
   * Borrow a `size x size` depth render target.
   *
   * Every consumer opens its passes with `depthLoadOp: "clear"`, so one target
   * may serve several consumers in submission order within a frame.
   */
  acquireDepthTarget(
    size: number,
    format: GPUTextureFormat,
    label: string,
  ): PooledDepthTarget {
    const telemetry = this._telemetry;
    telemetry.depthAcquires += 1;
    const key = depthKey(size, format);

    const free = this._idleDepth.get(key);
    if (free !== undefined && free.length > 0) {
      const entry = free.pop() as PooledDepthEntry;
      this._liveDepth += 1;
      telemetry.depthHits += 1;
      telemetry.depthIdle = this._countIdleDepth();
      telemetry.depthLive = this._liveDepth;
      return {
        texture: entry.texture,
        view: entry.view,
        size,
        format,
        device: this._device,
        generation: this._resourceGeneration,
      };
    }

    const texture = this._device.createTexture({
      label: label,
      size: { width: size, height: size },
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    let view: GPUTextureView;
    try {
      view = texture.createView();
    } catch (error) {
      try {
        texture.destroy();
      } catch {
        // Preserve the candidate setup failure that makes this acquisition
        // unusable; the unpublished native is best-effort cleanup only.
      }
      throw error;
    }
    this._liveDepth += 1;
    telemetry.depthCreates += 1;
    telemetry.depthLive = this._liveDepth;
    return {
      texture,
      view,
      size,
      format,
      device: this._device,
      generation: this._resourceGeneration,
    };
  }

  /** Return a depth target. Stale generations are destroyed, not pooled. */
  releaseDepthTarget(handle: PooledDepthTarget | null): void {
    if (handle === null) {
      return;
    }
    const telemetry = this._telemetry;
    if (
      this._destroyed ||
      handle.device !== this._device ||
      handle.generation !== this._resourceGeneration
    ) {
      telemetry.staleReleases += 1;
      telemetry.depthDestroys += 1;
      handle.texture.destroy();
      return;
    }

    this._liveDepth = Math.max(0, this._liveDepth - 1);
    const key = depthKey(handle.size, handle.format);
    let free = this._idleDepth.get(key);
    if (free === undefined) {
      free = [];
      this._idleDepth.set(key, free);
    }
    if (free.length >= MAX_IDLE_PER_BUCKET) {
      telemetry.depthDestroys += 1;
      handle.texture.destroy();
    } else {
      free.push({
        texture: handle.texture,
        view: handle.view,
        size: handle.size,
        format: handle.format,
        lastUsedFrameId: this._frameId,
      });
    }
    telemetry.depthIdle = this._countIdleDepth();
    telemetry.depthLive = this._liveDepth;
  }

  /**
   * Destroy entries idle for more than {@link IDLE_TRIM_FRAMES} frames.
   *
   * Entries last used on the current frame are never touched: the commands
   * recorded against them may not have been submitted yet.
   */
  trim(frameId: number): void {
    if (this._destroyed) {
      return;
    }
    this._frameId = frameId;
    const cutoff = frameId - IDLE_TRIM_FRAMES;
    const telemetry = this._telemetry;

    for (const [key, free] of this._idleBuffers) {
      for (let i = free.length - 1; i >= 0; i--) {
        const entry = free[i];
        if (
          entry.lastUsedFrameId < cutoff &&
          entry.lastUsedFrameId !== frameId
        ) {
          entry.buffer.destroy();
          free.splice(i, 1);
          telemetry.bufferDestroys += 1;
          telemetry.trimmed += 1;
        }
      }
      if (free.length === 0) {
        this._idleBuffers.delete(key);
      }
    }

    for (const [key, free] of this._idleDepth) {
      for (let i = free.length - 1; i >= 0; i--) {
        const entry = free[i];
        if (
          entry.lastUsedFrameId < cutoff &&
          entry.lastUsedFrameId !== frameId
        ) {
          entry.texture.destroy();
          free.splice(i, 1);
          telemetry.depthDestroys += 1;
          telemetry.trimmed += 1;
        }
      }
      if (free.length === 0) {
        this._idleDepth.delete(key);
      }
    }

    telemetry.bufferIdle = this._countIdleBuffers();
    telemetry.depthIdle = this._countIdleDepth();
  }

  /** Allocation-bearing debug snapshot; never called from the render hot path. */
  getTelemetry(): WebGPUEnvironmentTargetPoolTelemetry {
    const telemetry = this._telemetry;
    telemetry.frameId = this._frameId;
    telemetry.resourceGeneration = this._resourceGeneration;
    telemetry.bufferIdle = this._countIdleBuffers();
    telemetry.depthIdle = this._countIdleDepth();
    telemetry.bufferLive = this._liveBuffers;
    telemetry.depthLive = this._liveDepth;
    return { ...telemetry };
  }

  /**
   * Destroy every pooled object. Handles still held by a borrower are refused
   * on release afterwards and destroyed there, so nothing leaks and nothing is
   * double-destroyed.
   */
  destroy(): void {
    if (this._destroyed) {
      return;
    }
    const detached = this._detachAllEntries();
    this._destroyed = true;
    this._liveBuffers = 0;
    this._liveDepth = 0;
    const cleanup = this._destroyDetachedEntries(detached);
    if (cleanup.failed) {
      throw cleanup.firstError;
    }
  }

  private _createTelemetry(): WebGPUEnvironmentTargetPoolTelemetry {
    return {
      resourceGeneration: this._resourceGeneration,
      frameId: this._frameId,
      bufferAcquires: 0,
      bufferHits: 0,
      bufferCreates: 0,
      bufferDestroys: 0,
      bufferIdle: 0,
      bufferLive: 0,
      depthAcquires: 0,
      depthHits: 0,
      depthCreates: 0,
      depthDestroys: 0,
      depthIdle: 0,
      depthLive: 0,
      staleReleases: 0,
      generationResets: 0,
      trimmed: 0,
    };
  }

  private _detachAllEntries(): DetachedPoolEntries {
    const detached = {
      buffers: this._idleBuffers,
      depth: this._idleDepth,
    };
    this._idleBuffers = new Map();
    this._idleDepth = new Map();
    this._telemetry.bufferIdle = 0;
    this._telemetry.depthIdle = 0;
    return detached;
  }

  private _destroyDetachedEntries(
    entries: DetachedPoolEntries,
  ): PoolCleanupResult {
    const telemetry = this._telemetry;
    let firstError: unknown;
    let failed = false;
    const destroyBestEffort = (destroy: () => void): void => {
      try {
        destroy();
      } catch (error) {
        if (!failed) {
          firstError = error;
          failed = true;
        }
      }
    };
    for (const free of entries.buffers.values()) {
      for (let i = 0; i < free.length; i++) {
        telemetry.bufferDestroys += 1;
        destroyBestEffort(() => free[i].buffer.destroy());
      }
    }

    for (const free of entries.depth.values()) {
      for (let i = 0; i < free.length; i++) {
        telemetry.depthDestroys += 1;
        destroyBestEffort(() => free[i].texture.destroy());
      }
    }
    entries.buffers.clear();
    entries.depth.clear();
    return { failed, firstError };
  }

  private _countIdleBuffers(): number {
    let count = 0;
    for (const free of this._idleBuffers.values()) {
      count += free.length;
    }
    return count;
  }

  private _countIdleDepth(): number {
    let count = 0;
    for (const free of this._idleDepth.values()) {
      count += free.length;
    }
    return count;
  }
}

export default WebGPUEnvironmentTargetPool;
