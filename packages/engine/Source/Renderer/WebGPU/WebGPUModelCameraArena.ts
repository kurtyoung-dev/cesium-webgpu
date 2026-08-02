/// <reference types="@webgpu/types" />
/**
 * C11-195 — group-0 view dynamic-offset arena for the WebGPU model path.
 *
 * Group 0 carries the two blocks that are a property of the (model, view) pair
 * rather than of any primitive: the 320-byte RTE camera block at binding 0 and
 * the 864-byte punctual/IBL/ambient light block at binding 1. Both are
 * camera-relative — the camera block carries the encoded RTE eye, and the
 * light block's punctual positions, reflection-proxy center, and
 * eye→world rotation are all expressed against THAT eye — so binding them
 * together from one acquisition is what makes the RTE pairing structural
 * instead of a convention two call sites have to remember.
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
 * The light block was worse: it was packed, byte-compared, and uploaded once
 * PER PRIMITIVE (`primCache.lightBuffer`) even though every primitive of a
 * model packs byte-identical contents. An `N`-primitive model paid `N` packs
 * and — because camera-relative light positions change whenever the camera
 * moves — `N` real uploads per frame, with the unchanged-write suppression
 * that guarded them succeeding only while the camera was perfectly still.
 *
 * This arena replaces all of it with one per-frame allocation arena:
 *
 *   - Bytes come from the context's shared per-frame ring
 *     (`WebGPURingBufferAllocator`, reached through `context.uniformAllocator`)
 *     — the SAME allocator the globe's group-0 camera/tile UBs and the landed
 *     capture-camera slices already ride. Reuse, not new machinery: the ring
 *     already gives 256-byte alignment, CPU staging, page rotation, overflow
 *     pages, and one `queue.writeBuffer` per dirty page at `flush()`.
 *   - The bind group is built ONCE per (layout, camera page, light page) tuple
 *     and reused via a context-local identity-keyed cache. The per-allocation byte offsets
 *     never enter the key; they are supplied per-draw as WebGPU dynamic
 *     offsets. Under sustained camera motion the page identities cycle through
 *     the ring's `pageCount` and recur every `pageCount` frames, so the cache
 *     converges to ~`pageCount` entries at ~100% hit rate while the offsets
 *     shift each frame. This is exactly the shape proven for the globe by
 *     NEW-GLOBE-DYNAMIC-OFFSET-UBO (Batch 292).
 *   - Acquisition itself allocates almost nothing (C11-195 tail): the
 *     `[cameraOffset, lightOffset]` pair is interned per value into a frozen
 *     shared tuple, and the bind-group cache key string is memoized per
 *     resource-identity tuple, so the per-acquire cost in steady state is one
 *     small binding record.
 *
 * ## Why the light rides group 0 and not the merged group 1
 *
 * The light block used to be binding 1 of the merged, `materialDefines`-keyed
 * group-1 layout, whose bind group is PER PRIMITIVE and cached on exact
 * resource identity (C9-17 Slice A). Two shapes were possible once the bytes
 * moved onto the ring:
 *
 *   1. Keep binding 1 in group 1 and make it dynamic. The group-1 bind group
 *      then references a ring PAGE, so page identity necessarily joins its
 *      cache key — and because the page rotates every frame, each primitive
 *      needs one cached group-1 bind group PER PAGE (`pageCount`x the resident
 *      ~40-entry bind groups of every loaded primitive) or it thrashes and
 *      rebuilds all of them every frame. It would also make group 1 a
 *      dynamic-offset group everywhere it is bound, adding a second offset
 *      consumer class to audit (capture replay, OIT accumulation, the
 *      indirect-merge run guard).
 *   2. Give the light its own bind group. Impossible: models already occupy
 *      groups 0-3 and Chromium-on-Windows caps `maxBindGroups` at the spec
 *      floor of 4 (the Batch-152 opt-up was reverted for exactly this).
 *
 * So the light joins the block it is already semantically bound to. Group 0 is
 * the only group whose contents are per (model, view) rather than per
 * primitive, its bind group is shared across the owning context, and its dynamic-offset
 * plumbing is already threaded and audited through all seven command variants.
 * The per-primitive group-1 cache keeps its single 100%-hit record and loses a
 * binding; the resident bind-group count does not grow anywhere.
 *
 * ## RTE law
 *
 * The arena moves BYTES, never MEANING. The 320-byte block it carries is
 * whatever `packCameraUniforms` produced: `mvpRelativeToEye`, the
 * model-space encoded camera high/low pair, and the `previousViewProjection`
 * tail mandated by the `CameraUniforms` doctrine. The 864-byte light block is
 * whatever `packLightUniforms` produced, including the camera-relative
 * punctual positions that pair with that same encoded eye. The arena never
 * inspects, reorders, or defaults any of it.
 *
 * ## Isolation contracts
 *
 * Every distinct camera view that a single frame renders must land on its own
 * slice, because a slice is written once and read by the GPU later:
 *
 *   - main view vs. SCENE2D IDL duplicate — two matrices, two slices, two
 *     dynamic offsets, one shared bind group. The light is NOT duplicated:
 *     the wrapped copy shifts the model matrix, not the eye, so both views
 *     address the same light slice;
 *   - main view vs. each environment-capture cube face — the capture pass
 *     repoints `UniformState` to a face camera and packs against the same
 *     staging array, so it MUST acquire a fresh camera slice per record AND a
 *     fresh light slice per face (its punctual positions are relative to the
 *     face eye, which is not the main eye);
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
 * The arena is owned by the exact `WebGPUContext` whose ring pages it binds.
 * Multiple contexts may share one pooled `GPUDevice` and immutable camera
 * layout, but they have independent allocators, frame epochs, and arenas. The
 * context invalidates and detaches the arena before destroying or rebuilding
 * its allocator; `beginFrame` also retains an allocator-identity guard so an
 * unexpected same-context allocator swap clears every cached bind group.
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
 * Byte width of the model group-0 light uniform block (binding 1). Must stay
 * in lockstep with the `LightUniforms` struct in the model WGSL and with
 * `packLightUniforms` in `WebGPUModelRenderer.ts`, which is the only writer.
 */
export const MODEL_LIGHT_UNIFORM_BYTES = 864;

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
 * One staged group-0 block that is NOT the camera: the buffer that holds it
 * and the byte offset of this acquisition inside that buffer. Produced by
 * {@link WebGPUModelCameraArena#acquireLightSlice} and handed straight back to
 * {@link WebGPUModelCameraArena#acquire}, which turns it into the second entry
 * of the group-0 bind group and the second dynamic offset.
 */
export interface ModelViewLightSlice {
  /** Ring page (or degraded private buffer) holding the block. */
  readonly buffer: GPUBuffer;
  /** 256-aligned byte offset of this acquisition inside {@link buffer}. */
  readonly offset: number;
  /** Allocation epoch this slice belongs to. See {@link ModelCameraBinding}. */
  readonly allocationEpoch: number;
  /** Exact allocator whose bytes this slice addresses, or null for fallback. */
  readonly allocator: ModelCameraArenaAllocator | null;
}

/**
 * One acquired view block pair: the shared group-0 bind group plus the dynamic
 * offsets that select this draw's camera and light slices inside it.
 */
export interface ModelCameraBinding {
  /** Bind group built over the whole ring page(s) at offset 0. */
  readonly bindGroup: GPUBindGroup;
  /**
   * `setBindGroup(0, bindGroup, dynamicOffsets)` argument. Exactly two
   * entries, ORDERED BY BINDING INDEX — `[cameraOffset, lightOffset]` — which
   * is the order WebGPU requires for a group with more than one
   * `hasDynamicOffset` binding. Never mutated after `acquire` returns, so the
   * same array instance is safely shared by every command variant of one draw.
   *
   * C11-195 allocation trim: the array is identity-cached by its VALUE pair
   * and frozen, so two acquisitions whose offsets coincide (the same slice
   * positions recurring as the ring rotates) receive the SAME instance and the
   * steady state allocates nothing. Consumers already compare offsets by value
   * (`sameDynamicOffsetArray`) and clone before deriving, so sharing is
   * observationally identical — and freezing turns a rogue write into a loud
   * TypeError instead of a silent cross-draw corruption.
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
  /** Live (layout, camera page, light page) bind-group entries. */
  entries: number;
  /** Lifetime `acquire()` calls. */
  acquisitions: number;
  /** Lifetime `acquire()` calls served in the current frame. */
  acquisitionsThisFrame: number;
  /**
   * Lifetime `acquireLightSlice()` calls. One per model per view per frame —
   * NOT one per primitive. A count that tracks the primitive count is the
   * regression this half of C11-195 exists to prevent.
   */
  lightAcquisitions: number;
  /** Lifetime `acquireLightSlice()` calls served in the current frame. */
  lightAcquisitionsThisFrame: number;
  /** Lifetime bind groups actually created (cache misses). */
  bindGroupCreates: number;
  /** Lifetime bind-group cache hits. */
  bindGroupHits: number;
  /** Lifetime acquisitions that fell back to a one-off buffer. */
  fallbackAllocations: number;
  /** Lifetime acquisitions rejected for a misaligned ring offset. */
  misalignedRejections: number;
  /** Lifetime stale light slices rejected before bind-group creation. */
  staleLightSliceRejections: number;
  /** Most recent `beginFrame` frame number. */
  frameNumber: number;
  /** Most recent allocator epoch observed. */
  allocationEpoch: number;
}

/**
 * Per-context owner of the model group-0 camera arena.
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
  private _hasWarnedStaleLightSlice = false;

  private _acquisitions = 0;
  private _acquisitionsThisFrame = 0;
  private _lightAcquisitions = 0;
  private _lightAcquisitionsThisFrame = 0;
  private _fallbackAllocations = 0;
  private _misalignedRejections = 0;
  private _staleLightSliceRejections = 0;

  // C11-195 allocation trim — the hot path used to allocate one template
  // string (the bind-group cache key) and one two-element offset array PER
  // ACQUIRE, i.e. per node per model per view per frame. Both are retained
  // instead:
  //
  //   - `_offsetTuples` interns the `[cameraOffset, lightOffset]` pair by
  //     value. Ring offsets recur every rotation, so the map converges to the
  //     distinct pairs a scene actually uses and steady-state acquisition
  //     allocates no arrays. Entries are frozen — see
  //     {@link ModelCameraBinding#dynamicOffsets}.
  //   - `_bindGroupKey*` memoizes the last (layout, camera page, light page,
  //     sizes) identity tuple with its computed key string. Within a frame
  //     every acquire normally lands on one ring page, so the string is built
  //     ~once per page transition instead of once per acquire. `idOf`
  //     identities are stable for the life of `_bindGroups` (its WeakMap is
  //     never reset, only the entry map is cleared), so a memoized string can
  //     never alias a different resource tuple.
  //
  // Both retain references to GPU objects / plain arrays only; they are
  // dropped on allocator swap and `invalidate()` so dead ring pages are not
  // kept reachable.
  private _offsetTuples: Map<number, Map<number, number[]>> = new Map();
  private _bindGroupKeyLayout: GPUBindGroupLayout | null = null;
  private _bindGroupKeyBuffer: GPUBuffer | null = null;
  private _bindGroupKeyLightBuffer: GPUBuffer | null = null;
  private _bindGroupKeyByteSize = -1;
  private _bindGroupKeyLightByteSize = -1;
  private _bindGroupKey = "";
  /**
   * Last-resort zero-filled light block. Only reachable when a caller supplies
   * no light slice at all, which our own call sites never do; retained so the
   * degraded frame still produces a VALID bind group instead of a WebGPU
   * validation error that invalidates the whole command buffer.
   */
  private _zeroLightBuffer: GPUBuffer | null = null;
  private _hasWarnedMissingLight = false;

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
      this._resetRetainedAcquisitionState();
      this._allocator = allocator;
      this._allocationEpoch = allocator?.allocationEpoch ?? -1;
    }
    if (frameNumber === this._frameNumber) {
      return;
    }
    this._frameNumber = frameNumber;
    this._acquisitionsThisFrame = 0;
    this._lightAcquisitionsThisFrame = 0;
    this._bindGroups.beginFrame(frameNumber);
  }

  /**
   * Stage one model/view-wide light block into this frame's arena.
   *
   * Separate from {@link acquire} because the two blocks have different
   * cardinality: a model packs ONE light block per view per frame, while each
   * of its transformed nodes (and the SCENE2D IDL duplicate) packs its own
   * camera block. The returned slice is handed to every `acquire` of that
   * model's update so all of them address the same 864 bytes.
   *
   * @param device the GPU device (used only for the degraded private buffer)
   * @param allocator the frame's ring allocator, or null to force the fallback
   * @param data CPU staging array holding the packed light block
   * @param byteSize the WGSL struct width to bind
   * @param label debug label for the fallback buffer
   */
  acquireLightSlice(
    device: GPUDevice,
    allocator: ModelCameraArenaAllocator | null,
    data: Float32Array,
    byteSize: number,
    label: string,
  ): ModelViewLightSlice {
    this._lightAcquisitions++;
    this._lightAcquisitionsThisFrame++;

    if (allocator !== null) {
      const writeBytes = Math.min(data.byteLength, byteSize);
      const upload =
        writeBytes === data.byteLength
          ? data
          : new Uint8Array(data.buffer, data.byteOffset, writeBytes);
      const allocation = allocator.allocateAndWrite(upload, byteSize);
      this._allocationEpoch = allocator.allocationEpoch;

      if (allocation.offset % MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT === 0) {
        return {
          buffer: allocation.buffer,
          offset: allocation.offset,
          allocationEpoch: this._allocationEpoch,
          allocator,
        };
      }
      // Same hard-error reasoning as the camera path: a misaligned dynamic
      // offset invalidates the entire frame's command buffer.
      this._misalignedRejections++;
      this._reportMisalignedOffset(allocation.offset);
    }

    return {
      buffer: this._createFallbackBuffer(device, data, byteSize, label),
      offset: 0,
      allocationEpoch: this._allocationEpoch,
      allocator,
    };
  }

  /**
   * Stage `data` into this frame's arena and return the bind group + dynamic
   * offsets that address it together with `lightSlice`.
   *
   * @param device the GPU device (used only for bind-group / fallback-buffer creation)
   * @param allocator the frame's ring allocator, or null to force the fallback
   * @param layout the model camera bind-group layout (both bindings must declare `hasDynamicOffset`)
   * @param data CPU staging array holding the packed camera block
   * @param byteSize the WGSL struct width to bind (not the allocator's aligned slot size)
   * @param label debug label for the fallback buffer
   * @param lightSlice this model/view's light block, from {@link acquireLightSlice}
   * @param lightByteSize the light struct's WGSL width
   */
  acquire(
    device: GPUDevice,
    allocator: ModelCameraArenaAllocator | null,
    layout: GPUBindGroupLayout,
    data: Float32Array,
    byteSize: number,
    label: string,
    lightSlice: ModelViewLightSlice | null,
    lightByteSize: number = MODEL_LIGHT_UNIFORM_BYTES,
  ): ModelCameraBinding {
    this._acquisitions++;
    this._acquisitionsThisFrame++;

    let light = lightSlice;
    if (
      light !== null &&
      allocator !== null &&
      (light.allocator !== allocator ||
        light.allocationEpoch !== allocator.allocationEpoch)
    ) {
      // A recycled ring page can retain the same GPUBuffer identity and offset
      // while holding unrelated bytes. Reject the stale slice before it enters
      // a bind group; a zero block is visually degraded but validation-safe
      // and, unlike the stale slice, cannot leak another model/view's lights.
      this._staleLightSliceRejections++;
      this._reportStaleLightSlice(
        light.allocationEpoch,
        allocator.allocationEpoch,
      );
      light = this._zeroLightSlice(device, lightByteSize, allocator, false);
    }
    light ??= this._zeroLightSlice(device, lightByteSize, allocator, true);

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
        this._reportMisalignedOffset(allocation.offset);
        return this._acquireFallback(
          device,
          layout,
          data,
          byteSize,
          label,
          light,
          lightByteSize,
        );
      }

      const bindGroup = this._getOrCreateBindGroup(
        device,
        layout,
        allocation.buffer,
        byteSize,
        light.buffer,
        lightByteSize,
      );
      return {
        bindGroup,
        dynamicOffsets: this._offsetTupleFor(allocation.offset, light.offset),
        allocationEpoch: this._allocationEpoch,
      };
    }

    return this._acquireFallback(
      device,
      layout,
      data,
      byteSize,
      label,
      light,
      lightByteSize,
    );
  }

  /**
   * Bind group over one ring page pair, keyed on (layout identity, camera page
   * identity, light page identity). The per-allocation byte offsets are
   * deliberately absent from the key — they ride as dynamic offsets instead,
   * which is what keeps this cache flat under camera motion. Both pages
   * normally come from the same ring page, so the key degenerates to the
   * camera-only shape; they differ only across a mid-frame overflow page.
   */
  private _getOrCreateBindGroup(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    buffer: GPUBuffer,
    byteSize: number,
    lightBuffer: GPUBuffer,
    lightByteSize: number,
  ): GPUBindGroup {
    const cache = this._bindGroups;
    // C11-195 allocation trim — reuse the last computed key while the
    // resource-identity tuple is unchanged (the within-frame common case).
    let key: string;
    if (
      layout === this._bindGroupKeyLayout &&
      buffer === this._bindGroupKeyBuffer &&
      lightBuffer === this._bindGroupKeyLightBuffer &&
      byteSize === this._bindGroupKeyByteSize &&
      lightByteSize === this._bindGroupKeyLightByteSize
    ) {
      key = this._bindGroupKey;
    } else {
      key =
        `mc|${cache.idOf(layout)}|${cache.idOf(buffer)}|${byteSize}` +
        `|${cache.idOf(lightBuffer)}|${lightByteSize}`;
      this._bindGroupKeyLayout = layout;
      this._bindGroupKeyBuffer = buffer;
      this._bindGroupKeyLightBuffer = lightBuffer;
      this._bindGroupKeyByteSize = byteSize;
      this._bindGroupKeyLightByteSize = lightByteSize;
      this._bindGroupKey = key;
    }
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
          {
            binding: 1,
            resource: {
              buffer: lightBuffer,
              offset: 0,
              size: lightByteSize,
            },
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
    light: ModelViewLightSlice,
    lightByteSize: number,
  ): ModelCameraBinding {
    if (!this._hasWarnedFallback) {
      this._hasWarnedFallback = true;
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        `[CesiumJS:webgpu] Model camera arena fell back to a private buffer ` +
          `for "${label}" — no per-frame uniform allocator was available.`,
      );
      //>>includeEnd('debug');
    }
    const buffer = this._createFallbackBuffer(device, data, byteSize, label);
    const bindGroup = device.createBindGroup({
      label: `${label} BG`,
      layout,
      entries: [
        { binding: 0, resource: { buffer, offset: 0, size: byteSize } },
        {
          binding: 1,
          resource: {
            buffer: light.buffer,
            offset: 0,
            size: lightByteSize,
          },
        },
      ],
    });
    return {
      bindGroup,
      // The camera rides its own private buffer at 0; the light keeps whatever
      // offset its own acquisition produced (it may still be a valid ring
      // slice — only the camera allocation degraded).
      dynamicOffsets: this._offsetTupleFor(0, light.offset),
      allocationEpoch: this._allocationEpoch,
    };
  }

  /**
   * Intern the `[cameraOffset, lightOffset]` dynamic-offset pair. Equal pairs
   * share one frozen array instance; see
   * {@link ModelCameraBinding#dynamicOffsets} for why sharing is sound.
   */
  private _offsetTupleFor(cameraOffset: number, lightOffset: number): number[] {
    let inner = this._offsetTuples.get(cameraOffset);
    if (inner === undefined) {
      inner = new Map<number, number[]>();
      this._offsetTuples.set(cameraOffset, inner);
    }
    let tuple = inner.get(lightOffset);
    if (tuple === undefined) {
      tuple = Object.freeze([cameraOffset, lightOffset]) as number[];
      inner.set(lightOffset, tuple);
    }
    return tuple;
  }

  /**
   * Drop the interned offset tuples and the memoized bind-group key so no
   * dead ring page (or its key string) stays reachable through the arena.
   */
  private _resetRetainedAcquisitionState(): void {
    this._offsetTuples.clear();
    this._bindGroupKeyLayout = null;
    this._bindGroupKeyBuffer = null;
    this._bindGroupKeyLightBuffer = null;
    this._bindGroupKeyByteSize = -1;
    this._bindGroupKeyLightByteSize = -1;
    this._bindGroupKey = "";
  }

  /**
   * Mint one tracked private uniform buffer holding `data`. Retained on
   * `_fallbackBuffers` so teardown frees it instead of leaking one buffer per
   * acquire the way a bare `createBuffer` would.
   */
  private _createFallbackBuffer(
    device: GPUDevice,
    data: Float32Array,
    byteSize: number,
    label: string,
  ): GPUBuffer {
    this._fallbackAllocations++;
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
    return buffer;
  }

  /**
   * Last-resort light block for an `acquire` that was handed none. Zero-filled
   * (which reads as an unlit model) but VALID, so the frame renders instead of
   * losing its whole command buffer to a validation error. Permanently
   * reported: reaching this means a call site skipped `acquireLightSlice`.
   */
  private _zeroLightSlice(
    device: GPUDevice,
    lightByteSize: number,
    allocator: ModelCameraArenaAllocator | null,
    reportMissing: boolean,
  ): ModelViewLightSlice {
    if (reportMissing && !this._hasWarnedMissingLight) {
      this._hasWarnedMissingLight = true;
      console.error(
        `[CesiumJS:webgpu] Model camera arena acquired a group-0 binding with ` +
          `no light slice. Every model draw must pair its camera block with ` +
          `the model/view light block from acquireLightSlice(); binding a ` +
          `zero-filled placeholder instead, which renders the model unlit.`,
      );
    }
    if (this._zeroLightBuffer === null) {
      this._zeroLightBuffer = device.createBuffer({
        label: "Model light arena zero placeholder",
        size: lightByteSize,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      });
      this._fallbackBuffers.push(this._zeroLightBuffer);
    }
    return {
      buffer: this._zeroLightBuffer,
      offset: 0,
      allocationEpoch: allocator?.allocationEpoch ?? this._allocationEpoch,
      allocator,
    };
  }

  /** Report and count a rejected prior-epoch light slice once per context. */
  private _reportStaleLightSlice(
    sliceEpoch: number,
    allocatorEpoch: number,
  ): void {
    if (this._hasWarnedStaleLightSlice) {
      return;
    }
    this._hasWarnedStaleLightSlice = true;
    console.error(
      `[CesiumJS:webgpu] Model camera arena rejected a stale light slice ` +
        `(slice epoch ${sliceEpoch}, allocator epoch ${allocatorEpoch}). ` +
        `The ring page may already contain another model/view's bytes; ` +
        `binding a zero-light placeholder for this draw.`,
    );
  }

  /**
   * Permanent (never pragma-stripped) report of an allocator that violated the
   * 256-byte dynamic-offset contract. Once per arena — a structural defect in
   * the allocator configuration repeats every frame otherwise.
   */
  private _reportMisalignedOffset(offset: number): void {
    if (this._hasWarnedMisaligned) {
      return;
    }
    this._hasWarnedMisaligned = true;
    console.error(
      `[CesiumJS:webgpu] Model camera arena received a ring offset of ` +
        `${offset}, which is not a multiple of ` +
        `${MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT}. The uniform ring ` +
        `allocator must be configured with minAlignment=` +
        `${MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT}. Falling back to a ` +
        `private camera buffer for affected draws.`,
    );
  }

  /**
   * Drop every cached bind group and free fallback buffers. Called when the
   * owning device-resource lease is released; also reachable directly for
   * recovery paths that must guarantee no stale page reference survives.
   */
  invalidate(): void {
    let firstDestroyError: unknown;
    let hasDestroyError = false;
    const destroyBestEffort = (destroy: () => void): void => {
      try {
        destroy();
      } catch (error) {
        if (!hasDestroyError) {
          firstDestroyError = error;
          hasDestroyError = true;
        }
      }
    };

    destroyBestEffort(() => this._bindGroups.clear());
    this._resetRetainedAcquisitionState();
    const fallbackBuffers = this._fallbackBuffers;
    this._fallbackBuffers = [];
    for (let i = 0; i < fallbackBuffers.length; i++) {
      destroyBestEffort(() => fallbackBuffers[i].destroy());
    }
    this._zeroLightBuffer = null;
    this._allocator = null;
    this._frameNumber = -1;
    this._allocationEpoch = -1;

    if (hasDestroyError) {
      throw firstDestroyError;
    }
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
      lightAcquisitions: this._lightAcquisitions,
      lightAcquisitionsThisFrame: this._lightAcquisitionsThisFrame,
      bindGroupCreates: bindGroupStats.creates,
      bindGroupHits: bindGroupStats.hits,
      fallbackAllocations: this._fallbackAllocations,
      misalignedRejections: this._misalignedRejections,
      staleLightSliceRejections: this._staleLightSliceRejections,
      frameNumber: this._frameNumber,
      allocationEpoch: this._allocationEpoch,
    };
  }
}

export default WebGPUModelCameraArena;
