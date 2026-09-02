/// <reference types="@webgpu/types" />

import {
  makeBindGroupLayout,
  uniformBuffer,
  storageBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

/**
 * Phase 3 activation wrapper for `GPUSortKeys.wgsl`. Owns the SOA
 * command metadata storage buffers (canonical distanceSquared + renderLayer
 * + sortPriority + materialSortId) and the packed output buffers
 * (sortKeysHigh + sortKeysLow + commandIndices), plus the SortKeyParams
 * UBO with command count + sort mode.
 *
 * Call shape:
 *
 *     const d = new WebGPUGPUSortKeysDispatcher(device);
 *     d.setShaderSource(GPUSortKeysSource);
 *     d.allocate(maxCommands);
 *     // per frame:
 *     d.dispatch(encoder, soa, { sortMode });
 *     // Later: a sort pass (e.g. PointCloudSort) reorders the
 *     // packed key + index buffers.
 *
 * This dispatcher only produces the packed 64-bit keys. The actual
 * key sort is a separate step that consumes the same
 * `sortKeysHigh` / `sortKeysLow` / `commandIndices` buffers. For the
 * common Cesium case (<50K commands), the JS multi-level comparator
 * in RenderScheduler is faster than the GPU path because the
 * encoder→submit→readback round trip dominates. The dispatcher is
 * here as infrastructure — the consumer integration in RenderScheduler
 * is a separate step tracked in the backlog.
 *
 * @private
 * @module WebGPUGPUSortKeysDispatcher
 */

const SORT_KEY_PARAMS_BYTES = 16; // 4 × u32

/**
 * Round `n` up to the next power of 2. Bitonic sort networks require a
 * power-of-2 element count; we pad with sentinel max-keys (handled in the
 * shader) for the OOB threads.
 */
function nextPowerOf2(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

interface GPUSortKeysResources {
  capacity: number;
  // The key/index buffers are sized to `nextPowerOf2(capacity)` because the
  // bitonic network dispatches over `nextPowerOf2(count)` elements. When
  // `capacity` is not itself a power of 2 (the common case for real
  // command counts), a sort over `paddedN > capacity` would read/write
  // out of bounds — OOB storage reads return 0 (the MINIMUM key), which
  // would sort garbage padding to the FRONT and corrupt the permutation.
  // Sizing the buffers to `paddedCapacity` + filling the [count,paddedN)
  // tail with sentinel max keys each frame (see `runBitonicSort`) makes
  // the consumer trustworthy for arbitrary counts, not just powers of 2.
  paddedCapacity: number;
  paramsBuffer: GPUBuffer;
  distanceSquaredBuffer: GPUBuffer;
  renderLayersBuffer: GPUBuffer;
  sortPrioritiesBuffer: GPUBuffer;
  materialSortIdsBuffer: GPUBuffer;
  sortKeysHighBuffer: GPUBuffer;
  sortKeysLowBuffer: GPUBuffer;
  commandIndicesBuffer: GPUBuffer;
  bindGroupLayout: GPUBindGroupLayout;
  bindGroup: GPUBindGroup;
  pipeline: GPUComputePipeline;
  // Bitonic-sort-over-u64 pipeline operating on `sortKeysHighBuffer +
  // sortKeysLowBuffer + commandIndicesBuffer` in place. Same buffers,
  // separate bind-group-layout. Lazy-built on first `runBitonicSort` call.
  sortParamsBuffer: GPUBuffer | null;
  sortBindGroupLayout: GPUBindGroupLayout | null;
  sortBindGroup: GPUBindGroup | null;
  sortLocalPipeline: GPUComputePipeline | null;
  sortMergePipeline: GPUComputePipeline | null;
  // Two-buffer readback ring for the sorted command-indices array. A single
  // staging buffer cannot pipeline GPU->CPU readback: `mapAsync` must run AFTER
  // the copy is submitted, yet the next frame's copy must not target a buffer
  // that is still mapping. With a ring, `prepareIndicesReadback` writes one
  // slot while the OTHER (written + submitted last frame) is mapped, so neither
  // "used in submit while pending map" nor "while mapped" can occur. Mirrors
  // `WebGPUGPUCuller`'s deferred-readback ring exactly.
  readbackBuffers: [GPUBuffer | null, GPUBuffer | null];
}

/**
 * Paired readback result: the decoded sorted COMPACTED command indices
 * plus the opaque `tag` the caller passed to `prepareIndicesReadback`.
 * The tag lets the consumer keep the indices paired with the exact
 * compaction map (compactedToOriginal + skipped) from the dispatch that
 * produced them, even though the ring surfaces results 1-2 frames later.
 */
export interface SortedIndicesReadback {
  indices: Uint32Array;
  count: number;
  tag: unknown;
}

const SORT_BITONIC_PARAMS_BYTES = 16; // 4 × u32: elementCount, k, j, _pad
// Per-stage stride for the dynamic-offset bitonic params buffer. Each
// bitonic stage (the local sort + every global merge sub-stage) needs
// its OWN (k, j) visible when that pass executes. queue.writeBuffer of a
// single fixed offset per stage collapses to the LAST write before the
// command buffer runs (all writes precede the submit), so every pass
// would read identical params → the merge stages never run and blocks
// stay locally-sorted-but-globally-unmerged. Writing each stage to a
// DISTINCT offset (no clobber) + a dynamic-offset bind group fixes it.
// 256 is the guaranteed-max default `minUniformBufferOffsetAlignment`,
// so it is a legal dynamic offset on every device.
const SORT_PARAMS_STRIDE = 256;

/**
 * Total bitonic stage count for a padded element count `paddedN`: 1 local
 * sort + Σ over k=512,1024,…,paddedN of log2(k) global merge sub-stages.
 * Bounds the dynamic-offset params buffer.
 */
function countSortStages(paddedN: number): number {
  let stages = 1; // local sort
  for (let k = 512; k <= paddedN; k <<= 1) {
    for (let j = k >> 1; j > 0; j >>= 1) stages++;
  }
  return stages;
}

/**
 * Sort mode values that match `GPUSortKeys.wgsl`'s SortKeyParams.sortMode.
 */
export const SORT_MODE_FRONT_TO_BACK = 0;
export const SORT_MODE_BACK_TO_FRONT = 1;

class WebGPUGPUSortKeysDispatcher {
  private _device: GPUDevice;

  /**
   * The device this dispatcher captured at construction. Exposed so the
   * per-context cache can tell a live instance from one left behind by a
   * device-loss recovery, which reuses the context object the cache is keyed on.
   */
  get device(): GPUDevice {
    return this._device;
  }
  private _resources: GPUSortKeysResources | null = null;
  private _shaderModule: GPUShaderModule | null = null;
  // Bitonic sort module.
  private _sortShaderModule: GPUShaderModule | null = null;
  private _sortParamsScratch = new Uint32Array(4);
  // Scratch filled with 0xFFFFFFFF used to write the [count,paddedN)
  // sentinel tail of the key/index buffers before each bitonic sort.
  // Grown on demand.
  private _sortPadScratch: Uint32Array = new Uint32Array(0);
  // Deferred-readback ring state — see `readbackBuffers` in
  // GPUSortKeysResources. `_latestSorted` holds the most recently decoded
  // paired result; `latestSortedIndices()` returns it (synchronous cache, same
  // contract as `WebGPUGPUCuller.readResults`).
  private _rbWriteIdx: number = 0;
  private _rbPendingIdx: number = -1;
  private _rbPendingCount: number = 0;
  private _rbPendingTag: unknown = null;
  private _rbMapping: [boolean, boolean] = [false, false];
  private _latestSorted: SortedIndicesReadback | null = null;
  // Lifetime sort dispatch counter for diagnostics.
  private _sortDispatches: number = 0;
  // Captured on first `_ensureResources` from
  // `frameState.context.webgpuComputePipelineCache`.
  private _computePipelineCache:
    | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
    | null = null;
  // Diagnostic counters.
  private _dispatches = 0;
  private _lastCommandCount = 0;
  // Scratch buffer for the params UBO upload, allocated once to
  // avoid per-frame GC pressure.
  private _paramsScratch = new ArrayBuffer(SORT_KEY_PARAMS_BYTES);
  private _paramsU32: Uint32Array;

  constructor(device: GPUDevice) {
    this._device = device;
    this._paramsU32 = new Uint32Array(this._paramsScratch);
  }

  /**
   * Inject the GPUSortKeys.wgsl source. Called once from the feature
   * renderer registration. Idempotent.
   */
  setShaderSource(wgsl: string): void {
    if (this._shaderModule) return;
    this._shaderModule = this._device.createShaderModule({
      label: "GPUSortKeys_Shader",
      code: wgsl,
    });
  }

  /**
   * Inject the BitonicSortU64.wgsl source. Called once at FR registration.
   * Idempotent.
   */
  setSortShaderSource(wgsl: string): void {
    if (this._sortShaderModule) return;
    this._sortShaderModule = this._device.createShaderModule({
      label: "GPUSortKeys_BitonicSort_Shader",
      code: wgsl,
    });
  }

  get sortShadersReady(): boolean {
    return !!this._sortShaderModule;
  }

  get shadersReady(): boolean {
    return !!this._shaderModule;
  }

  /**
   * Diagnostic snapshot for the central debug surface.
   */
  getStatistics(): {
    allocated: boolean;
    shadersReady: boolean;
    capacity: number;
    dispatches: number;
    lastCommandCount: number;
  } {
    return {
      allocated: !!this._resources,
      shadersReady: this.shadersReady,
      capacity: this._resources?.capacity ?? 0,
      dispatches: this._dispatches,
      lastCommandCount: this._lastCommandCount,
    };
  }

  /**
   * Output buffer accessors for consumers that need to wire the
   * packed keys into a downstream sort pass.
   */
  get sortKeysHighBuffer(): GPUBuffer | null {
    return this._resources?.sortKeysHighBuffer ?? null;
  }
  get sortKeysLowBuffer(): GPUBuffer | null {
    return this._resources?.sortKeysLowBuffer ?? null;
  }
  get commandIndicesBuffer(): GPUBuffer | null {
    return this._resources?.commandIndicesBuffer ?? null;
  }

  /**
   * Pipeline-cache injection point. Set before `allocate()`. The
   * dispatcher routes its compute pipeline through the cache when
   * non-null, falls back to direct sync creation otherwise.
   */
  _setComputePipelineCache(
    cache:
      | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
      | null,
  ): void {
    this._computePipelineCache = cache;
  }

  /**
   * Allocate (or reallocate) the SOA + output buffers + pipeline for
   * the given command capacity. Returns true on success.
   */
  allocate(maxCommands: number): boolean {
    if (!this.shadersReady) return false;
    if (maxCommands <= 0) return false;
    if (this._resources && this._resources.capacity >= maxCommands) {
      return true;
    }
    this.destroy();

    const device = this._device;
    const byteLen = maxCommands * 4;
    // Phase 3 — output (key/index) buffers must cover the padded bitonic
    // element count so a sort over `nextPowerOf2(count)` never runs OOB.
    const paddedCapacity = nextPowerOf2(maxCommands);
    const paddedByteLen = paddedCapacity * 4;

    const paramsBuffer = device.createBuffer({
      label: "GPUSortKeys_Params",
      size: SORT_KEY_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const makeStorageIn = (label: string) =>
      device.createBuffer({
        label,
        size: byteLen,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    const makeStorageOut = (label: string) =>
      device.createBuffer({
        label,
        size: paddedByteLen,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST,
      });

    const distanceSquaredBuffer = makeStorageIn("GPUSortKeys_DistanceSquared");
    const renderLayersBuffer = makeStorageIn("GPUSortKeys_RenderLayers");
    const sortPrioritiesBuffer = makeStorageIn("GPUSortKeys_SortPriorities");
    const materialSortIdsBuffer = makeStorageIn("GPUSortKeys_MaterialSortIds");
    const sortKeysHighBuffer = makeStorageOut("GPUSortKeys_KeysHigh");
    const sortKeysLowBuffer = makeStorageOut("GPUSortKeys_KeysLow");
    const commandIndicesBuffer = makeStorageOut("GPUSortKeys_Indices");

    const bindGroupLayout = makeBindGroupLayout(device, "GPUSortKeys_BGL", [
      uniformBuffer(0, Stage.COMPUTE),
      ...[1, 2, 3, 4].map((b) =>
        storageBuffer(b, Stage.COMPUTE, { readOnly: true }),
      ),
      ...[5, 6, 7].map((b) => storageBuffer(b, Stage.COMPUTE)),
    ]);

    const bindGroup = device.createBindGroup({
      label: "GPUSortKeys_BG",
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: { buffer: distanceSquaredBuffer } },
        { binding: 2, resource: { buffer: renderLayersBuffer } },
        { binding: 3, resource: { buffer: sortPrioritiesBuffer } },
        { binding: 4, resource: { buffer: materialSortIdsBuffer } },
        { binding: 5, resource: { buffer: sortKeysHighBuffer } },
        { binding: 6, resource: { buffer: sortKeysLowBuffer } },
        { binding: 7, resource: { buffer: commandIndicesBuffer } },
      ],
    });

    // Route through the central pipeline cache when available; fall back
    // to a direct synchronous create otherwise.
    const sortLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });
    const pipeline = this._computePipelineCache
      ? this._computePipelineCache.getOrCreateSync({
          name: "GPUSortKeys_Pipeline",
          layout: sortLayout,
          compute: { module: this._shaderModule!, entryPoint: "computeMain" },
        })
      : device.createComputePipeline({
          label: "GPUSortKeys_Pipeline",
          layout: sortLayout,
          compute: { module: this._shaderModule!, entryPoint: "computeMain" },
        });

    this._resources = {
      capacity: maxCommands,
      paddedCapacity,
      paramsBuffer,
      distanceSquaredBuffer,
      renderLayersBuffer,
      sortPrioritiesBuffer,
      materialSortIdsBuffer,
      sortKeysHighBuffer,
      sortKeysLowBuffer,
      commandIndicesBuffer,
      bindGroupLayout,
      bindGroup,
      pipeline,
      // Sort fields are lazy-built on first `runBitonicSort` call so
      // users that only consume the keys directly (no GPU sort) don't
      // pay the bind-group + pipeline cost.
      sortParamsBuffer: null,
      sortBindGroupLayout: null,
      sortBindGroup: null,
      sortLocalPipeline: null,
      sortMergePipeline: null,
      readbackBuffers: [null, null],
    };
    return true;
  }

  /**
   * Lazy-build the bitonic-sort pipelines + bind group, sized to the existing
   * `sortKeysHighBuffer` / `sortKeysLowBuffer` / `commandIndicesBuffer`. Called
   * from `runBitonicSort`.
   */
  private _ensureSortPipelines(): boolean {
    const r = this._resources;
    if (!r) return false;
    if (!this._sortShaderModule) return false;
    if (
      r.sortLocalPipeline &&
      r.sortMergePipeline &&
      r.sortBindGroup &&
      r.sortParamsBuffer &&
      r.readbackBuffers[0] &&
      r.readbackBuffers[1]
    ) {
      return true;
    }

    const device = this._device;
    // One params buffer holding every stage's (elementCount,k,j) at a
    // distinct 256-aligned offset, bound with a dynamic offset per pass.
    const maxStages = countSortStages(r.paddedCapacity);
    const sortParamsBuffer = device.createBuffer({
      label: "GPUSortKeys_BitonicParams",
      size: maxStages * SORT_PARAMS_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const sortBgl = makeBindGroupLayout(device, "BitonicSortU64_BGL", [
      uniformBuffer(0, Stage.COMPUTE, {
        hasDynamicOffset: true,
        minBindingSize: SORT_BITONIC_PARAMS_BYTES,
      }),
      storageBuffer(1, Stage.COMPUTE),
      storageBuffer(2, Stage.COMPUTE),
      storageBuffer(3, Stage.COMPUTE),
    ]);
    const sortBg = device.createBindGroup({
      label: "BitonicSortU64_BG",
      layout: sortBgl,
      entries: [
        // Dynamic-offset binding: base offset 0, size = one stage's
        // struct; the actual stage offset is supplied at setBindGroup.
        {
          binding: 0,
          resource: {
            buffer: sortParamsBuffer,
            offset: 0,
            size: SORT_BITONIC_PARAMS_BYTES,
          },
        },
        { binding: 1, resource: { buffer: r.sortKeysHighBuffer } },
        { binding: 2, resource: { buffer: r.sortKeysLowBuffer } },
        { binding: 3, resource: { buffer: r.commandIndicesBuffer } },
      ],
    });

    const sortLayout = device.createPipelineLayout({
      bindGroupLayouts: [sortBgl],
    });
    const sortLocalPipeline = this._computePipelineCache
      ? this._computePipelineCache.getOrCreateSync({
          name: "BitonicSortU64_Local_Pipeline",
          layout: sortLayout,
          compute: {
            module: this._sortShaderModule,
            entryPoint: "localBitonicSort256",
          },
        })
      : device.createComputePipeline({
          label: "BitonicSortU64_Local_Pipeline",
          layout: sortLayout,
          compute: {
            module: this._sortShaderModule,
            entryPoint: "localBitonicSort256",
          },
        });
    const sortMergePipeline = this._computePipelineCache
      ? this._computePipelineCache.getOrCreateSync({
          name: "BitonicSortU64_Merge_Pipeline",
          layout: sortLayout,
          compute: {
            module: this._sortShaderModule,
            entryPoint: "globalBitonicMerge",
          },
        })
      : device.createComputePipeline({
          label: "BitonicSortU64_Merge_Pipeline",
          layout: sortLayout,
          compute: {
            module: this._sortShaderModule,
            entryPoint: "globalBitonicMerge",
          },
        });

    const makeReadback = (slot: number) =>
      device.createBuffer({
        label: `GPUSortKeys_IndicesReadback${slot}`,
        size: r.capacity * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

    r.sortParamsBuffer = sortParamsBuffer;
    r.sortBindGroupLayout = sortBgl;
    r.sortBindGroup = sortBg;
    r.sortLocalPipeline = sortLocalPipeline;
    r.sortMergePipeline = sortMergePipeline;
    r.readbackBuffers = [makeReadback(0), makeReadback(1)];
    return true;
  }

  /**
   * Encode a full bitonic sort over the (sortKeysHigh, sortKeysLow,
   * commandIndices) triple. Must be called AFTER `dispatch()` in the same
   * encoder so the keys exist before the sort runs.
   *
   * Sort is in-place: the buffers are reordered s.t. position 0 holds
   * the smallest key (front-to-back when keys were generated with
   * `sortMode = 0`). `commandIndices[i]` is the original command
   * index that now occupies sorted position `i`.
   *
   * Returns true if the sort was dispatched.
   */
  runBitonicSort(encoder: GPUCommandEncoder, count: number): boolean {
    const r = this._resources;
    if (!r) return false;
    if (count <= 0 || count > r.capacity) return false;
    if (!this._ensureSortPipelines()) return false;

    // Pad count up to next power of 2 so the bitonic network has a
    // valid (k, j) sequence.
    const paddedN = nextPowerOf2(count);

    // Write the [count,paddedN) tail of the key + index buffers with sentinel
    // max (0xFFFFFFFF) BEFORE the sort runs. The GPUSortKeys compute pass only
    // writes [0,count); without this fill the padding slots hold stale (or
    // zero-init) data, and the bitonic network's in-shader pad branch only
    // triggers for `globalIdx >= elementCount` (= paddedN), never for the
    // [count,paddedN) middle. Sentinel-max keys sort those slots to the END so
    // the real commands occupy [0,count) and the permutation the consumer reads
    // back is correct for ANY count, not just powers of two. queue.writeBuffer
    // is ordered before the submitted command buffer, and the range is disjoint
    // from what the keygen pass writes, so both land before the bitonic pass
    // reads.
    if (paddedN > count) {
      const padElems = paddedN - count;
      if (this._sortPadScratch.length < padElems) {
        this._sortPadScratch = new Uint32Array(padElems).fill(0xffffffff);
      }
      const q = this._device.queue;
      const off = count * 4;
      q.writeBuffer(
        r.sortKeysHighBuffer,
        off,
        this._sortPadScratch,
        0,
        padElems,
      );
      q.writeBuffer(
        r.sortKeysLowBuffer,
        off,
        this._sortPadScratch,
        0,
        padElems,
      );
      q.writeBuffer(
        r.commandIndicesBuffer,
        off,
        this._sortPadScratch,
        0,
        padElems,
      );
    }

    // Build the full stage list: stage 0 = local sort (k=j=0, ignored by
    // the local shader), then the global merge sub-stages (k=512.., j).
    // Each stage's params live at a DISTINCT 256-aligned offset so the
    // per-stage writeBuffers don't clobber each other before the command
    // buffer executes; each pass binds its own stage via dynamic offset.
    const stageParams: Array<{ k: number; j: number; merge: boolean }> = [
      { k: 0, j: 0, merge: false },
    ];
    for (let k = 512; k <= paddedN; k <<= 1) {
      for (let j = k >> 1; j > 0; j >>= 1) {
        stageParams.push({ k, j, merge: true });
      }
    }
    const stageCount = stageParams.length;

    // Pack all stage params into one scratch (STRIDE u32s per stage) and
    // upload with a single writeBuffer.
    const strideU32 = SORT_PARAMS_STRIDE / 4;
    if (this._sortParamsScratch.length < stageCount * strideU32) {
      this._sortParamsScratch = new Uint32Array(stageCount * strideU32);
    }
    const scratch = this._sortParamsScratch;
    scratch.fill(0, 0, stageCount * strideU32);
    for (let s = 0; s < stageCount; s++) {
      const base = s * strideU32;
      scratch[base] = paddedN;
      scratch[base + 1] = stageParams[s].k;
      scratch[base + 2] = stageParams[s].j;
      scratch[base + 3] = 0;
    }
    this._device.queue.writeBuffer(
      r.sortParamsBuffer!,
      0,
      scratch.buffer,
      scratch.byteOffset,
      stageCount * SORT_PARAMS_STRIDE,
    );

    const workgroups = Math.ceil(paddedN / 256);
    for (let s = 0; s < stageCount; s++) {
      const stage = stageParams[s];
      const pass = encoder.beginComputePass({
        label: stage.merge
          ? `BitonicSortU64_Merge_k${stage.k}_j${stage.j}`
          : "BitonicSortU64_Local",
      });
      pass.setPipeline(
        stage.merge ? r.sortMergePipeline! : r.sortLocalPipeline!,
      );
      // Dynamic offset selects this stage's params slot.
      pass.setBindGroup(0, r.sortBindGroup!, [s * SORT_PARAMS_STRIDE]);
      pass.dispatchWorkgroups(workgroups, 1, 1);
      pass.end();
    }

    this._sortDispatches++;
    return true;
  }

  /**
   * Encode a `copyBufferToBuffer` from the sorted command-indices buffer
   * into a readback ring slot. Call AFTER `runBitonicSort` and BEFORE
   * `device.queue.submit`. `tag` is an opaque payload (the caller's
   * compaction map) returned verbatim alongside the decoded indices, so
   * the consumer keeps the two paired across the ring's deferral.
   *
   * Deferred-readback ring: first pumps the slot written on a PRIOR call — its
   * copy has been submitted by now, so `mapAsync` is legal and never targets
   * the slot we write below — then writes this frame's copy into a non-mapping
   * slot. Mirrors `WebGPUGPUCuller.prepareReadback`.
   */
  prepareIndicesReadback(
    encoder: GPUCommandEncoder,
    count: number,
    tag?: unknown,
  ): void {
    const r = this._resources;
    if (!r) return;
    if (count <= 0 || count > r.capacity) return;

    // Map the prior slot (submitted by now), decode into `_latestSorted`.
    this._pumpReadback();

    // Pick a slot that isn't currently mapping; if both are, skip this
    // frame's copy (the consumer keeps using the last decoded result).
    let i = this._rbWriteIdx;
    if (this._rbMapping[i]) {
      i ^= 1;
      if (this._rbMapping[i]) return;
    }
    const buf = r.readbackBuffers[i];
    if (!buf) return;

    encoder.copyBufferToBuffer(r.commandIndicesBuffer, 0, buf, 0, count * 4);
    this._rbPendingIdx = i;
    this._rbPendingCount = count;
    this._rbPendingTag = tag ?? null;
    this._rbWriteIdx = i ^ 1;
  }

  /**
   * Deferred-readback pump — maps the slot written by a PRIOR
   * `prepareIndicesReadback` (its copy is submitted by now, so `mapAsync`
   * is legal and the slot is not the one about to be written). Decodes
   * into `_latestSorted`. No-op when nothing pends or the slot is mapping.
   */
  private _pumpReadback(): void {
    const i = this._rbPendingIdx;
    if (i < 0 || this._rbMapping[i]) return;
    const count = this._rbPendingCount;
    const tag = this._rbPendingTag;
    this._rbPendingIdx = -1;
    if (count <= 0) return;
    const r = this._resources;
    if (!r) return;
    const buf = r.readbackBuffers[i];
    if (!buf) return;
    this._rbMapping[i] = true;
    buf
      .mapAsync(GPUMapMode.READ, 0, count * 4)
      .then(() => {
        const indices = new Uint32Array(
          new Uint32Array(buf.getMappedRange(0, count * 4)),
        );
        buf.unmap();
        this._latestSorted = { indices, count, tag };
      })
      .catch((e) => {
        //>>includeStart('debug', pragmas.debug);
        console.warn(
          `[BitonicSortU64] readback failed: ${(e as Error).message}`,
        );
        //>>includeEnd('debug');
        try {
          buf.unmap();
        } catch {
          /* not mapped */
        }
      })
      .finally(() => {
        this._rbMapping[i] = false;
      });
  }

  /**
   * Return the most recently decoded paired readback result (the sorted
   * COMPACTED command indices + the caller's tag), or null before the
   * first decode. Synchronous cache — the ring's `mapAsync` runs inside
   * `prepareIndicesReadback`, so this just hands back the latest decode.
   * Each decode allocates a fresh `indices` array, so a reference held by
   * the consumer stays valid until it chooses to replace it.
   */
  latestSortedIndices(): SortedIndicesReadback | null {
    return this._latestSorted;
  }

  /** Lifetime sort dispatch count, surfaced via diagnostic stats. */
  get sortDispatches(): number {
    return this._sortDispatches;
  }

  /**
   * Encode one dispatch that generates packed sort keys for the given
   * command metadata SOA. Returns true on success.
   */
  dispatch(
    encoder: GPUCommandEncoder,
    soa: {
      distanceSquared: Float32Array;
      renderLayers: Uint32Array;
      sortPriorities: Uint32Array;
      materialSortIds: Uint32Array;
      count: number;
    },
    params: {
      sortMode: number; // 0 = front-to-back, 1 = back-to-front
    },
  ): boolean {
    const r = this._resources;
    if (!r || !this.shadersReady) return false;
    if (soa.count <= 0 || soa.count > r.capacity) return false;

    const device = this._device;
    const byteLen = soa.count * 4;

    // Upload SOA components — only the valid range per component.
    device.queue.writeBuffer(
      r.distanceSquaredBuffer,
      0,
      soa.distanceSquared.buffer,
      soa.distanceSquared.byteOffset,
      byteLen,
    );
    device.queue.writeBuffer(
      r.renderLayersBuffer,
      0,
      soa.renderLayers.buffer,
      soa.renderLayers.byteOffset,
      byteLen,
    );
    device.queue.writeBuffer(
      r.sortPrioritiesBuffer,
      0,
      soa.sortPriorities.buffer,
      soa.sortPriorities.byteOffset,
      byteLen,
    );
    device.queue.writeBuffer(
      r.materialSortIdsBuffer,
      0,
      soa.materialSortIds.buffer,
      soa.materialSortIds.byteOffset,
      byteLen,
    );

    // Pack SortKeyParams: u32 commandCount + u32 sortMode + 2 × u32 pad.
    this._paramsU32[0] = soa.count;
    this._paramsU32[1] = params.sortMode | 0;
    this._paramsU32[2] = 0;
    this._paramsU32[3] = 0;
    device.queue.writeBuffer(r.paramsBuffer, 0, this._paramsScratch);

    const workgroupsX = Math.ceil(soa.count / 256);
    const pass = encoder.beginComputePass({
      label: "GPUSortKeys_Pass",
    });
    pass.setPipeline(r.pipeline);
    pass.setBindGroup(0, r.bindGroup);
    pass.dispatchWorkgroups(workgroupsX, 1, 1);
    pass.end();

    this._dispatches++;
    this._lastCommandCount = soa.count;
    return true;
  }

  destroy(): void {
    const r = this._resources;
    if (!r) return;
    try {
      r.paramsBuffer.destroy();
      r.distanceSquaredBuffer.destroy();
      r.renderLayersBuffer.destroy();
      r.sortPrioritiesBuffer.destroy();
      r.materialSortIdsBuffer.destroy();
      r.sortKeysHighBuffer.destroy();
      r.sortKeysLowBuffer.destroy();
      r.commandIndicesBuffer.destroy();
      // Bitonic-sort resources.
      r.sortParamsBuffer?.destroy();
      r.readbackBuffers[0]?.destroy();
      r.readbackBuffers[1]?.destroy();
    } catch (_e) {
      // Defensive — double-destroy is a no-op.
    }
    this._resources = null;
    // Reset the ring state so a subsequent allocate() + readback chain
    // starts clean (mirrors the old in-flight-flag reset).
    this._rbWriteIdx = 0;
    this._rbPendingIdx = -1;
    this._rbPendingCount = 0;
    this._rbPendingTag = null;
    this._rbMapping = [false, false];
    this._latestSorted = null;
  }
}

// ─── Feature renderer factory + entry points ───────────────────────

import { shouldRebuildForDevice } from "./WebGPUDeviceInvalidationBus.js";
import GPUSortKeysSource from "../../Shaders/WebGPU/Compute/GPUSortKeys.js";
// The matching bitonic-sort shader consumes the 64-bit keys produced above.
import BitonicSortU64Source from "../../Shaders/WebGPU/Compute/BitonicSortU64.js";

const _instances = new WeakMap<object, WebGPUGPUSortKeysDispatcher>();

function getOrCreateDispatcher(context: {
  device: GPUDevice | null | undefined;
}): WebGPUGPUSortKeysDispatcher | null {
  if (!context || !context.device) return null;
  let inst = _instances.get(context);
  // The cache stays keyed on the context because that is what callers hold,
  // but a context outlives the device it was created with: device-loss
  // recovery hands the same object back with a replacement device. Presence
  // alone would therefore return a dispatcher whose pipelines and buffers
  // belong to the dead device, so the cached value is revalidated too.
  if (inst && shouldRebuildForDevice(inst, context.device)) {
    try {
      inst.destroy();
    } catch {
      // A lost device can reject native teardown; the replacement still builds.
    }
    _instances.delete(context);
    inst = undefined;
  }
  if (!inst) {
    inst = new WebGPUGPUSortKeysDispatcher(context.device);
    inst.setShaderSource(GPUSortKeysSource);
    inst.setSortShaderSource(BitonicSortU64Source);
    _instances.set(context, inst);
  }
  return inst;
}

function initWebGPUGPUSortKeys(
  context: {
    device: GPUDevice | null | undefined;
    webgpuComputePipelineCache?:
      | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
      | null;
  },
  maxCommands: number,
): boolean {
  const inst = getOrCreateDispatcher(context);
  if (!inst) return false;
  // Capture the central cache before allocate() runs so the pipeline
  // creation routes through it.
  inst._setComputePipelineCache(context.webgpuComputePipelineCache ?? null);
  return inst.allocate(maxCommands);
}

function dispatchWebGPUGPUSortKeys(
  context: { device: GPUDevice | null | undefined },
  encoder: GPUCommandEncoder,
  soa: {
    distanceSquared: Float32Array;
    renderLayers: Uint32Array;
    sortPriorities: Uint32Array;
    materialSortIds: Uint32Array;
    count: number;
  },
  params: {
    sortMode: number;
  },
): boolean {
  const inst = _instances.get(context);
  if (!inst) return false;
  return inst.dispatch(encoder, soa, params);
}

function getWebGPUGPUSortKeysStatistics(context: {
  device: GPUDevice;
}): ReturnType<WebGPUGPUSortKeysDispatcher["getStatistics"]> | null {
  const inst = _instances.get(context);
  return inst ? inst.getStatistics() : null;
}

function destroyWebGPUGPUSortKeys(context: {
  device: GPUDevice | null | undefined;
}): void {
  const inst = _instances.get(context);
  if (inst) {
    inst.destroy();
    _instances.delete(context);
  }
}

/**
 * Chain the bitonic sort after `dispatchWebGPUGPUSortKeys` in the same
 * encoder. Must be called AFTER `dispatchWebGPUGPUSortKeys` and BEFORE
 * `device.queue.submit`.
 */
function runBitonicSortWebGPUGPUSortKeys(
  context: { device: GPUDevice | null | undefined },
  encoder: GPUCommandEncoder,
  count: number,
): boolean {
  const inst = _instances.get(context);
  if (!inst) return false;
  return inst.runBitonicSort(encoder, count);
}

/**
 * Schedule a copy of the sorted-indices buffer into a readback ring
 * slot. Called immediately after `runBitonicSort`. `tag` is returned
 * verbatim alongside the decoded indices via `latestSortedIndices`.
 */
function prepareIndicesReadbackWebGPUGPUSortKeys(
  context: { device: GPUDevice | null | undefined },
  encoder: GPUCommandEncoder,
  count: number,
  tag?: unknown,
): void {
  const inst = _instances.get(context);
  if (!inst) return;
  inst.prepareIndicesReadback(encoder, count, tag);
}

/**
 * Return the most recently decoded paired readback (sorted COMPACTED
 * indices + the caller's tag), or null before the first decode. The
 * ring's `mapAsync` runs inside `prepareIndicesReadback`, so this is a
 * synchronous cache read (same contract as `WebGPUGPUCuller.readResults`).
 */
function latestSortedIndicesWebGPUGPUSortKeys(context: {
  device: GPUDevice | null | undefined;
}): SortedIndicesReadback | null {
  const inst = _instances.get(context);
  if (!inst) return null;
  return inst.latestSortedIndices();
}

export {
  WebGPUGPUSortKeysDispatcher,
  SORT_KEY_PARAMS_BYTES,
  initWebGPUGPUSortKeys,
  dispatchWebGPUGPUSortKeys,
  runBitonicSortWebGPUGPUSortKeys,
  prepareIndicesReadbackWebGPUGPUSortKeys,
  latestSortedIndicesWebGPUGPUSortKeys,
  getWebGPUGPUSortKeysStatistics,
  destroyWebGPUGPUSortKeys,
};
export default WebGPUGPUSortKeysDispatcher;
