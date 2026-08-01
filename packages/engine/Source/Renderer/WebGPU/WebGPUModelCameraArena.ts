/// <reference types="@webgpu/types" />
/**
 * C11-195 — group-0 camera dynamic-offset arena for the WebGPU model path.
 *
 * Before this module every model wrote its 320-byte RTE camera block into a
 * PERSISTENT per-model (and per-transformed-node, and per-2D/IDL-duplicate)
 * `GPUBuffer` with one `device.queue.writeBuffer` call each, every frame,
 * unconditionally. A scene with `M` models and `N` transformed nodes paid
 * `M * (1 + N)` queue writes per frame — plus a second `M * N` for the SCENE2D
 * IDL duplicate — even when nothing but the camera moved. The environment
 * capture path avoided the persistent buffers (it must, because the main pass
 * reads them later in the same frame) but paid a fresh `createBindGroup` per
 * primitive per cube face instead.
 *
 * This arena replaces all four with one per-frame allocation arena:
 *
 *   - Bytes come from the context's shared per-frame ring
 *     (`WebGPURingBufferAllocator`, reached through `context.uniformAllocator`)
 *     — the SAME allocator the globe's group-0 camera/tile UBs and the landed
 *     capture-camera slices already ride. Reuse, not new machinery: the ring
 *     already gives 256-byte alignment, CPU staging, page rotation, overflow
 *     pages, and one `queue.writeBuffer` per dirty page at `flush()`.
 *   - The bind group is built ONCE per (layout, ring page) pair and reused via
 *     an identity-keyed cache. The per-allocation byte offset never enters the
 *     key; it is supplied per-draw as a WebGPU dynamic offset. Under sustained
 *     camera motion the page identities cycle through the ring's `pageCount`
 *     and recur every `pageCount` frames, so the cache converges to
 *     ~`pageCount` entries at ~100% hit rate while the offsets shift each
 *     frame. This is exactly the shape proven for the globe by
 *     NEW-GLOBE-DYNAMIC-OFFSET-UBO (Batch 292).
 *
 * ## RTE law
 *
 * The arena moves BYTES, never MEANING. The 320-byte block it carries is
 * whatever `packCameraUniforms` produced: `mvpRelativeToEye`, the
 * model-space encoded camera high/low pair, and the `previousViewProjection`
 * tail mandated by the `CameraUniforms` doctrine. The arena never inspects,
 * reorders, or defaults any of it.
 *
 * ## Isolation contracts
 *
 * Every distinct camera view that a single frame renders must land on its own
 * slice, because a slice is written once and read by the GPU later:
 *
 *   - main view vs. SCENE2D IDL duplicate — two matrices, two slices, two
 *     dynamic offsets, one shared bind group;
 *   - main view vs. each environment-capture cube face — the capture pass
 *     repoints `UniformState` to a face camera and packs against the same
 *     staging array, so it MUST acquire a fresh slice per record;
 *   - first vs. second SCENE2D split viewport — `beginSecondaryViewport()`
 *     flushes the ring and submits the first segment while keeping the same
 *     logical-frame page, so the second viewport's acquires occupy distinct
 *     slices instead of rewriting bytes the first viewport has recorded but
 *     not yet consumed.
 *
 * A binding is therefore valid only for the allocation epoch that produced it.
 * Callers must hold bindings in per-frame locals and re-acquire every update;
 * they must never memoize one on a model/node cache across frames.
 *
 * ## Device / allocator generation
 *
 * The arena is owned per `GPUDevice` by `WebGPUModelDeviceResources`, whose
 * pool is a `WeakMap` keyed by the device — a lost device produces a new
 * `GPUDevice`, hence a new pool entry and a new arena. The context can also
 * destroy and rebuild the ring allocator on the SAME device during recovery,
 * which destroys the pages the cached bind groups reference; `beginFrame`
 * detects that by allocator identity and clears the cache.
 *
 * @private
 */

// Generic identity-keyed bind-group cache with age-based eviction and
// per-frame stat windows. Named for its first consumer (the globe surface),
// but it carries no globe-specific state and no imports of its own — reused
// here rather than growing a second copy. Folding it and the generic
// post-process cache together is tracked as NEW-BINDGROUPCACHE-EVICTION.
import WebGPUGlobeBindGroupCache from "./WebGPUGlobeBindGroupCache.js";

// `GPUBufferUsage` only exists on WebGPU-capable hosts. The engine bundle is
// evaluated under Node (verify-package CI) and in browsers without WebGPU, and
// the fallback path below can be reached from a synthetic host, so resolve the
// constants defensively. Values are fixed by the WebGPU spec.
const BufferUsage: { readonly UNIFORM: number; readonly COPY_DST: number } =
  typeof GPUBufferUsage !== "undefined"
    ? GPUBufferUsage
    : { UNIFORM: 0x0040, COPY_DST: 0x0008 };

/**
 * Byte width of the model group-0 camera uniform block. Must stay in lockstep
 * with the `Camera` struct in the model WGSL and with `packCameraUniforms`
 * in `WebGPUModelRenderer.ts`, which is the only writer.
 */
export const MODEL_CAMERA_UNIFORM_BYTES = 320;

/**
 * WebGPU requires every dynamic uniform offset to be a multiple of
 * `limits.minUniformBufferOffsetAlignment`. 256 is that limit's maximum
 * permitted value and the ring allocator's configured `minAlignment`, so
 * satisfying 256 satisfies every conformant adapter.
 */
export const MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT = 256;

/**
 * The narrow slice of `WebGPURingBufferAllocator` the arena depends on.
 * Declared structurally so the arena can be exercised without a GPU device.
 */
export interface ModelCameraArenaAllocator {
  allocateAndWrite(
    data: ArrayBuffer | ArrayBufferView,
    allocationSize?: number,
  ): { buffer: GPUBuffer; offset: number };
  readonly allocationEpoch: number;
}

/**
 * One acquired camera block: the shared group-0 bind group plus the single
 * dynamic offset that selects this draw's slice inside it.
 */
export interface ModelCameraBinding {
  /** Bind group built over the whole ring page at offset 0. */
  readonly bindGroup: GPUBindGroup;
  /**
   * `setBindGroup(0, bindGroup, dynamicOffsets)` argument. Exactly one entry
   * (binding 0). Never mutated after `acquire` returns, so the same array
   * instance is safely shared by every command variant of one draw.
   */
  readonly dynamicOffsets: number[];
  /**
   * Allocation epoch this slice belongs to. A binding whose epoch differs
   * from `WebGPUModelCameraArena.allocationEpoch` refers to bytes that a
   * later frame may already have overwritten.
   */
  readonly allocationEpoch: number;
}

/** Diagnostic snapshot. Counters other than `entries` are debug-build only. */
export interface ModelCameraArenaStats {
  /** Live (layout, page) bind-group entries. */
  entries: number;
  /** Lifetime `acquire()` calls. */
  acquisitions: number;
  /** Lifetime `acquire()` calls served in the current frame. */
  acquisitionsThisFrame: number;
  /** Lifetime bind groups actually created (cache misses). */
  bindGroupCreates: number;
  /** Lifetime bind-group cache hits. */
  bindGroupHits: number;
  /** Lifetime acquisitions that fell back to a one-off buffer. */
  fallbackAllocations: number;
  /** Lifetime acquisitions rejected for a misaligned ring offset. */
  misalignedRejections: number;
  /** Most recent `beginFrame` frame number. */
  frameNumber: number;
  /** Most recent allocator epoch observed. */
  allocationEpoch: number;
}

/**
 * Per-device owner of the model group-0 camera arena.
 */
export class WebGPUModelCameraArena {
  private _bindGroups = new WebGPUGlobeBindGroupCache();
  private _allocator: ModelCameraArenaAllocator | null = null;
  private _frameNumber = -1;
  private _allocationEpoch = -1;
  /**
   * One-off buffers minted when no ring allocator is available (device torn
   * down, or a synthetic host). Retained so teardown can free them instead of
   * leaking one buffer per acquire the way a bare `createBuffer` fallback does.
   */
  private _fallbackBuffers: GPUBuffer[] = [];
  private _hasWarnedFallback = false;
  private _hasWarnedMisaligned = false;

  private _acquisitions = 0;
  private _acquisitionsThisFrame = 0;
  private _fallbackAllocations = 0;
  private _misalignedRejections = 0;

  /**
   * Per-frame tick. Idempotent within a frame number, so it is safe to call
   * from every model update rather than needing a single privileged caller.
   *
   * Passing the frame's allocator lets the arena notice a recovery rebuild:
   * a different allocator instance means the pages the cached bind groups
   * were built over have been destroyed, so the cache must be dropped.
   */
  beginFrame(
    frameNumber: number,
    allocator: ModelCameraArenaAllocator | null,
  ): void {
    if (allocator !== this._allocator) {
      // Allocator identity change == ring pages destroyed and rebuilt. Every
      // cached bind group references a dead GPUBuffer.
      this._bindGroups.clear();
      this._allocator = allocator;
    }
    if (frameNumber === this._frameNumber) {
      return;
    }
    this._frameNumber = frameNumber;
    this._acquisitionsThisFrame = 0;
    this._bindGroups.beginFrame(frameNumber);
  }

  /**
   * Stage `data` into this frame's arena and return the bind group + dynamic
   * offset that address it.
   *
   * @param device the GPU device (used only for bind-group / fallback-buffer creation)
   * @param allocator the frame's ring allocator, or null to force the fallback
   * @param layout the model camera bind-group layout (must declare `hasDynamicOffset`)
   * @param data CPU staging array holding the packed camera block
   * @param byteSize the WGSL struct width to bind (not the allocator's aligned slot size)
   * @param label debug label for the fallback buffer
   */
  acquire(
    device: GPUDevice,
    allocator: ModelCameraArenaAllocator | null,
    layout: GPUBindGroupLayout,
    data: Float32Array,
    byteSize: number,
    label: string,
  ): ModelCameraBinding {
    this._acquisitions++;
    this._acquisitionsThisFrame++;

    if (allocator !== null) {
      const writeBytes = Math.min(data.byteLength, byteSize);
      const upload =
        writeBytes === data.byteLength
          ? data
          : new Uint8Array(data.buffer, data.byteOffset, writeBytes);
      const allocation = allocator.allocateAndWrite(upload, byteSize);
      this._allocationEpoch = allocator.allocationEpoch;

      if (allocation.offset % MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT !== 0) {
        // A misaligned dynamic offset is a hard WebGPU validation error that
        // invalidates the whole frame's command buffer, so it must never reach
        // setBindGroup. Report permanently (this is a structural defect in the
        // allocator configuration, not a diagnostic) and degrade this one
        // acquisition to a private buffer so the frame still renders.
        this._misalignedRejections++;
        if (!this._hasWarnedMisaligned) {
          this._hasWarnedMisaligned = true;
          console.error(
            `[CesiumJS:webgpu] Model camera arena received a ring offset of ` +
              `${allocation.offset}, which is not a multiple of ` +
              `${MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT}. The uniform ring ` +
              `allocator must be configured with minAlignment=` +
              `${MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT}. Falling back to a ` +
              `private camera buffer for affected draws.`,
          );
        }
        return this._acquireFallback(device, layout, data, byteSize, label);
      }

      const bindGroup = this._getOrCreateBindGroup(
        device,
        layout,
        allocation.buffer,
        byteSize,
      );
      return {
        bindGroup,
        dynamicOffsets: [allocation.offset],
        allocationEpoch: this._allocationEpoch,
      };
    }

    return this._acquireFallback(device, layout, data, byteSize, label);
  }

  /**
   * Bind group over one ring page, keyed on (layout identity, page identity).
   * The per-allocation byte offset is deliberately absent from the key — it
   * rides as a dynamic offset instead, which is what keeps this cache flat
   * under camera motion.
   */
  private _getOrCreateBindGroup(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    buffer: GPUBuffer,
    byteSize: number,
  ): GPUBindGroup {
    const cache = this._bindGroups;
    const key = `mc|${cache.idOf(layout)}|${cache.idOf(buffer)}|${byteSize}`;
    return cache.getOrCreate(key, () =>
      device.createBindGroup({
        label: "Model camera arena BG",
        layout,
        entries: [
          {
            binding: 0,
            // Base offset 0 + exactly the WGSL struct width. The draw-time
            // dynamic offset selects the slice; binding the struct width
            // (not the allocator's aligned slot size) keeps the binding view
            // tight so padding bytes belonging to the next allocation are
            // never visible to the shader.
            resource: { buffer, offset: 0, size: byteSize },
          },
        ],
      }),
    );
  }

  /**
   * Degenerate path: no ring allocator (device unavailable / synthetic host)
   * or a misaligned allocation. Mints a private buffer bound at offset 0.
   * Dynamic offset 0 is always alignment-legal.
   */
  private _acquireFallback(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    data: Float32Array,
    byteSize: number,
    label: string,
  ): ModelCameraBinding {
    this._fallbackAllocations++;
    if (!this._hasWarnedFallback) {
      this._hasWarnedFallback = true;
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        `[CesiumJS:webgpu] Model camera arena fell back to a private buffer ` +
          `for "${label}" — no per-frame uniform allocator was available.`,
      );
      //>>includeEnd('debug');
    }
    const buffer = device.createBuffer({
      label,
      size: byteSize,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this._fallbackBuffers.push(buffer);
    device.queue.writeBuffer(
      buffer,
      0,
      data.buffer,
      data.byteOffset,
      Math.min(data.byteLength, byteSize),
    );
    const bindGroup = device.createBindGroup({
      label: `${label} BG`,
      layout,
      entries: [
        { binding: 0, resource: { buffer, offset: 0, size: byteSize } },
      ],
    });
    return {
      bindGroup,
      dynamicOffsets: [0],
      allocationEpoch: this._allocationEpoch,
    };
  }

  /**
   * Drop every cached bind group and free fallback buffers. Called when the
   * owning device-resource lease is released; also reachable directly for
   * recovery paths that must guarantee no stale page reference survives.
   */
  invalidate(): void {
    this._bindGroups.clear();
    for (let i = 0; i < this._fallbackBuffers.length; i++) {
      this._fallbackBuffers[i].destroy();
    }
    this._fallbackBuffers.length = 0;
    this._allocator = null;
    this._frameNumber = -1;
    this._allocationEpoch = -1;
  }

  /** Frame number of the most recent {@link beginFrame} tick. */
  get frameNumber(): number {
    return this._frameNumber;
  }

  /** Allocation epoch of the most recent {@link acquire}. */
  get allocationEpoch(): number {
    return this._allocationEpoch;
  }

  getStats(): ModelCameraArenaStats {
    const bindGroupStats = this._bindGroups.getStats();
    return {
      entries: bindGroupStats.entries,
      acquisitions: this._acquisitions,
      acquisitionsThisFrame: this._acquisitionsThisFrame,
      bindGroupCreates: bindGroupStats.creates,
      bindGroupHits: bindGroupStats.hits,
      fallbackAllocations: this._fallbackAllocations,
      misalignedRejections: this._misalignedRejections,
      frameNumber: this._frameNumber,
      allocationEpoch: this._allocationEpoch,
    };
  }
}

export default WebGPUModelCameraArena;
