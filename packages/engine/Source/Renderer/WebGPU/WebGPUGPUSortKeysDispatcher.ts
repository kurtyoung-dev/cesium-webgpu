/// <reference types="@webgpu/types" />

import {
  makeBindGroupLayout,
  uniformBuffer,
  storageBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

/**
 * Phase 3 activation wrapper for `GPUSortKeys.wgsl`. Owns the SOA
 * command metadata storage buffers (centerX/Y/Z + renderLayer +
 * sortPriority + materialSortId) and the packed output buffers
 * (sortKeysHigh + sortKeysLow + commandIndices), plus the SortKeyParams
 * UBO with camera position + sort mode.
 *
 * Call shape:
 *
 *     const d = new WebGPUGPUSortKeysDispatcher(device);
 *     d.setShaderSource(GPUSortKeysSource);
 *     d.allocate(maxCommands);
 *     // per frame:
 *     d.dispatch(encoder, soa, { cameraPosition, sortMode });
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

const SORT_KEY_PARAMS_BYTES = 32; // 8 × u32

/**
 * NEW-GPU-SORT-PIPELINE Phase 2 (Batch 228) — round `n` up to the
 * next power of 2. Bitonic sort networks require a power-of-2
 * element count; we pad with sentinel max-keys (handled in the
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
  paramsBuffer: GPUBuffer;
  centerXBuffer: GPUBuffer;
  centerYBuffer: GPUBuffer;
  centerZBuffer: GPUBuffer;
  renderLayersBuffer: GPUBuffer;
  sortPrioritiesBuffer: GPUBuffer;
  materialSortIdsBuffer: GPUBuffer;
  sortKeysHighBuffer: GPUBuffer;
  sortKeysLowBuffer: GPUBuffer;
  commandIndicesBuffer: GPUBuffer;
  bindGroupLayout: GPUBindGroupLayout;
  bindGroup: GPUBindGroup;
  pipeline: GPUComputePipeline;
  // NEW-GPU-SORT-PIPELINE Phase 2 (Batch 228) — bitonic-sort-over-u64
  // pipeline operating on `sortKeysHighBuffer + sortKeysLowBuffer +
  // commandIndicesBuffer` in place. Same buffers, separate
  // bind-group-layout. Lazy-built on first `runBitonicSort` call.
  sortParamsBuffer: GPUBuffer | null;
  sortBindGroupLayout: GPUBindGroupLayout | null;
  sortBindGroup: GPUBindGroup | null;
  sortLocalPipeline: GPUComputePipeline | null;
  sortMergePipeline: GPUComputePipeline | null;
  // Readback buffer for sorted command-indices array. Mapped after
  // `prepareIndicesReadback` + queue-submit. Same 1-frame latency
  // contract as the cull readbacks.
  indicesReadbackBuffer: GPUBuffer | null;
}

const SORT_BITONIC_PARAMS_BYTES = 16; // 4 × u32: elementCount, k, j, _pad

/**
 * Sort mode values that match `GPUSortKeys.wgsl`'s SortKeyParams.sortMode.
 */
export const SORT_MODE_FRONT_TO_BACK = 0;
export const SORT_MODE_BACK_TO_FRONT = 1;

class WebGPUGPUSortKeysDispatcher {
  private _device: GPUDevice;
  private _resources: GPUSortKeysResources | null = null;
  private _shaderModule: GPUShaderModule | null = null;
  // NEW-GPU-SORT-PIPELINE Phase 2 (Batch 228) — bitonic sort module.
  private _sortShaderModule: GPUShaderModule | null = null;
  private _sortParamsScratch = new Uint32Array(4);
  // True while a Promise from `readSortedIndices` is pending — prevents
  // stacking duplicate readback calls per frame.
  private _sortReadbackInFlight: boolean = false;
  // Lifetime sort dispatch counter for diagnostics.
  private _sortDispatches: number = 0;
  // C-R7-COMPUTE-PIPELINE-CACHE (Batch 76) — captured on first
  // `_ensureResources` from `frameState.context.webgpuComputePipelineCache`.
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
  private _paramsF32: Float32Array;

  constructor(device: GPUDevice) {
    this._device = device;
    this._paramsU32 = new Uint32Array(this._paramsScratch);
    this._paramsF32 = new Float32Array(this._paramsScratch);
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
   * NEW-GPU-SORT-PIPELINE Phase 2 (Batch 228) — inject the
   * BitonicSortU64.wgsl source. Called once at FR registration.
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
   *
   * C-R7-COMPUTE-PIPELINE-CACHE (Batch 76).
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
        size: byteLen,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST,
      });

    const centerXBuffer = makeStorageIn("GPUSortKeys_CenterX");
    const centerYBuffer = makeStorageIn("GPUSortKeys_CenterY");
    const centerZBuffer = makeStorageIn("GPUSortKeys_CenterZ");
    const renderLayersBuffer = makeStorageIn("GPUSortKeys_RenderLayers");
    const sortPrioritiesBuffer = makeStorageIn("GPUSortKeys_SortPriorities");
    const materialSortIdsBuffer = makeStorageIn("GPUSortKeys_MaterialSortIds");
    const sortKeysHighBuffer = makeStorageOut("GPUSortKeys_KeysHigh");
    const sortKeysLowBuffer = makeStorageOut("GPUSortKeys_KeysLow");
    const commandIndicesBuffer = makeStorageOut("GPUSortKeys_Indices");

    const bindGroupLayout = makeBindGroupLayout(device, "GPUSortKeys_BGL", [
      uniformBuffer(0, Stage.COMPUTE),
      ...[1, 2, 3, 4, 5, 6].map((b) =>
        storageBuffer(b, Stage.COMPUTE, { readOnly: true }),
      ),
      ...[7, 8, 9].map((b) => storageBuffer(b, Stage.COMPUTE)),
    ]);

    const bindGroup = device.createBindGroup({
      label: "GPUSortKeys_BG",
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: { buffer: centerXBuffer } },
        { binding: 2, resource: { buffer: centerYBuffer } },
        { binding: 3, resource: { buffer: centerZBuffer } },
        { binding: 4, resource: { buffer: renderLayersBuffer } },
        { binding: 5, resource: { buffer: sortPrioritiesBuffer } },
        { binding: 6, resource: { buffer: materialSortIdsBuffer } },
        { binding: 7, resource: { buffer: sortKeysHighBuffer } },
        { binding: 8, resource: { buffer: sortKeysLowBuffer } },
        { binding: 9, resource: { buffer: commandIndicesBuffer } },
      ],
    });

    // C-R7-COMPUTE-PIPELINE-CACHE (Batch 76) — central cache when
    // available, sync direct create otherwise.
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
      paramsBuffer,
      centerXBuffer,
      centerYBuffer,
      centerZBuffer,
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
      indicesReadbackBuffer: null,
    };
    return true;
  }

  /**
   * NEW-GPU-SORT-PIPELINE Phase 2 (Batch 228) — lazy-build the
   * bitonic-sort pipelines + bind group, sized to the existing
   * `sortKeysHighBuffer` / `sortKeysLowBuffer` / `commandIndicesBuffer`.
   * Called from `runBitonicSort`.
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
      r.indicesReadbackBuffer
    ) {
      return true;
    }

    const device = this._device;
    const sortParamsBuffer = device.createBuffer({
      label: "GPUSortKeys_BitonicParams",
      size: SORT_BITONIC_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const sortBgl = makeBindGroupLayout(device, "BitonicSortU64_BGL", [
      uniformBuffer(0, Stage.COMPUTE),
      storageBuffer(1, Stage.COMPUTE),
      storageBuffer(2, Stage.COMPUTE),
      storageBuffer(3, Stage.COMPUTE),
    ]);
    const sortBg = device.createBindGroup({
      label: "BitonicSortU64_BG",
      layout: sortBgl,
      entries: [
        { binding: 0, resource: { buffer: sortParamsBuffer } },
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

    const indicesReadbackBuffer = device.createBuffer({
      label: "GPUSortKeys_IndicesReadback",
      size: r.capacity * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    r.sortParamsBuffer = sortParamsBuffer;
    r.sortBindGroupLayout = sortBgl;
    r.sortBindGroup = sortBg;
    r.sortLocalPipeline = sortLocalPipeline;
    r.sortMergePipeline = sortMergePipeline;
    r.indicesReadbackBuffer = indicesReadbackBuffer;
    return true;
  }

  /**
   * NEW-GPU-SORT-PIPELINE Phase 2 (Batch 228) — encode a full bitonic
   * sort over the (sortKeysHigh, sortKeysLow, commandIndices) triple.
   * Must be called AFTER `dispatch()` in the same encoder so the keys
   * exist before the sort runs.
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
    // valid (k, j) sequence. The shader handles OOB by padding with
    // 0xFFFFFFFF keys (sort to end), so the extra threads are no-ops.
    const paddedN = nextPowerOf2(count);

    // Phase 1: local sort within workgroups (256 threads each).
    {
      this._sortParamsScratch[0] = paddedN;
      this._sortParamsScratch[1] = 0;
      this._sortParamsScratch[2] = 0;
      this._sortParamsScratch[3] = 0;
      this._device.queue.writeBuffer(
        r.sortParamsBuffer!,
        0,
        this._sortParamsScratch.buffer,
      );
      const pass = encoder.beginComputePass({
        label: "BitonicSortU64_Local",
      });
      pass.setPipeline(r.sortLocalPipeline!);
      pass.setBindGroup(0, r.sortBindGroup!);
      pass.dispatchWorkgroups(Math.ceil(paddedN / 256), 1, 1);
      pass.end();
    }

    // Phase 2: global merge passes for k > 256. O(log²N) dispatches
    // — at N = 65536 that's about 28 passes; cheap.
    // B228-O1 (Batch 230 audit fix) — removed `if (j < 256 && k <= 256)
    // continue;` from this loop. The outer loop starts at k=512 so
    // `k <= 256` was never true; the skip was dead code.
    for (let k = 512; k <= paddedN; k <<= 1) {
      for (let j = k >> 1; j > 0; j >>= 1) {
        this._sortParamsScratch[0] = paddedN;
        this._sortParamsScratch[1] = k;
        this._sortParamsScratch[2] = j;
        this._sortParamsScratch[3] = 0;
        this._device.queue.writeBuffer(
          r.sortParamsBuffer!,
          0,
          this._sortParamsScratch.buffer,
        );
        const pass = encoder.beginComputePass({
          label: `BitonicSortU64_Merge_k${k}_j${j}`,
        });
        pass.setPipeline(r.sortMergePipeline!);
        pass.setBindGroup(0, r.sortBindGroup!);
        pass.dispatchWorkgroups(Math.ceil(paddedN / 256), 1, 1);
        pass.end();
      }
    }

    this._sortDispatches++;
    return true;
  }

  /**
   * Encode a `copyBufferToBuffer` from the sorted command-indices
   * buffer into the readback staging buffer. Call AFTER
   * `runBitonicSort` and BEFORE `device.queue.submit`.
   */
  prepareIndicesReadback(encoder: GPUCommandEncoder, count: number): void {
    const r = this._resources;
    if (!r || !r.indicesReadbackBuffer) return;
    if (count <= 0 || count > r.capacity) return;
    encoder.copyBufferToBuffer(
      r.commandIndicesBuffer,
      0,
      r.indicesReadbackBuffer,
      0,
      count * 4,
    );
  }

  /**
   * Async readback of the sorted indices array. Returns a
   * `Uint32Array` of length `count` where each element is the
   * original (pre-sort) command index that now occupies sorted
   * position `i`. Returns null when a readback is already in
   * flight (caller is expected to drop and try next frame).
   */
  async readSortedIndices(count: number): Promise<Uint32Array | null> {
    const r = this._resources;
    if (!r || !r.indicesReadbackBuffer) return null;
    if (this._sortReadbackInFlight) return null;
    if (count <= 0 || count > r.capacity) return null;
    this._sortReadbackInFlight = true;
    try {
      await r.indicesReadbackBuffer.mapAsync(GPUMapMode.READ, 0, count * 4);
      const range = r.indicesReadbackBuffer.getMappedRange(0, count * 4);
      const result = new Uint32Array(new Uint32Array(range));
      r.indicesReadbackBuffer.unmap();
      return result;
    } catch (e) {
      //>>includeStart('debug', pragmas.debug);
      console.warn(`[BitonicSortU64] readback failed: ${(e as Error).message}`);
      //>>includeEnd('debug');
      return null;
    } finally {
      this._sortReadbackInFlight = false;
    }
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
      centerX: Float32Array;
      centerY: Float32Array;
      centerZ: Float32Array;
      renderLayers: Uint32Array;
      sortPriorities: Uint32Array;
      materialSortIds: Uint32Array;
      count: number;
    },
    params: {
      cameraPosition: { x: number; y: number; z: number };
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
      r.centerXBuffer,
      0,
      soa.centerX.buffer,
      soa.centerX.byteOffset,
      byteLen,
    );
    device.queue.writeBuffer(
      r.centerYBuffer,
      0,
      soa.centerY.buffer,
      soa.centerY.byteOffset,
      byteLen,
    );
    device.queue.writeBuffer(
      r.centerZBuffer,
      0,
      soa.centerZ.buffer,
      soa.centerZ.byteOffset,
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

    // Pack SortKeyParams: u32 commandCount + f32 cameraXYZ + u32 sortMode + 3 × u32 pad.
    this._paramsU32[0] = soa.count;
    this._paramsF32[1] = params.cameraPosition.x;
    this._paramsF32[2] = params.cameraPosition.y;
    this._paramsF32[3] = params.cameraPosition.z;
    this._paramsU32[4] = params.sortMode | 0;
    this._paramsU32[5] = 0;
    this._paramsU32[6] = 0;
    this._paramsU32[7] = 0;
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
      r.centerXBuffer.destroy();
      r.centerYBuffer.destroy();
      r.centerZBuffer.destroy();
      r.renderLayersBuffer.destroy();
      r.sortPrioritiesBuffer.destroy();
      r.materialSortIdsBuffer.destroy();
      r.sortKeysHighBuffer.destroy();
      r.sortKeysLowBuffer.destroy();
      r.commandIndicesBuffer.destroy();
      // Batch 228 sort resources.
      r.sortParamsBuffer?.destroy();
      r.indicesReadbackBuffer?.destroy();
    } catch (_e) {
      // Defensive — double-destroy is a no-op.
    }
    this._resources = null;
    // B228-N1 (Batch 230 audit fix) — reset the in-flight flag so a
    // subsequent allocate() + readback chain can fire. Prior code
    // left the flag stuck-true if destroy() ran while a readback
    // promise was pending; the next session would never readback.
    this._sortReadbackInFlight = false;
  }
}

// ─── Feature renderer factory + entry points ───────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import GPUSortKeysSource from "../../Shaders/WebGPU/Compute/GPUSortKeys.js";
// Batch 228 — bitonic-sort-over-u64 source paired with the keygen.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import BitonicSortU64Source from "../../Shaders/WebGPU/Compute/BitonicSortU64.js";

const _instances = new WeakMap<object, WebGPUGPUSortKeysDispatcher>();

function getOrCreateDispatcher(context: {
  device: GPUDevice | null | undefined;
}): WebGPUGPUSortKeysDispatcher | null {
  if (!context || !context.device) return null;
  let inst = _instances.get(context);
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
  // C-R7-COMPUTE-PIPELINE-CACHE (Batch 76) — capture the central cache
  // before allocate() runs so the pipeline creation routes through it.
  inst._setComputePipelineCache(context.webgpuComputePipelineCache ?? null);
  return inst.allocate(maxCommands);
}

function dispatchWebGPUGPUSortKeys(
  context: { device: GPUDevice | null | undefined },
  encoder: GPUCommandEncoder,
  soa: {
    centerX: Float32Array;
    centerY: Float32Array;
    centerZ: Float32Array;
    renderLayers: Uint32Array;
    sortPriorities: Uint32Array;
    materialSortIds: Uint32Array;
    count: number;
  },
  params: {
    cameraPosition: { x: number; y: number; z: number };
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
 * NEW-GPU-SORT-PIPELINE Phase 2 (Batch 228) — chain the bitonic sort
 * after `dispatchWebGPUGPUSortKeys` in the same encoder. Must be
 * called AFTER `dispatchWebGPUGPUSortKeys` and BEFORE
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
 * Schedule a copy of the sorted-indices buffer into the readback
 * staging buffer. Called immediately after `runBitonicSort`.
 */
function prepareIndicesReadbackWebGPUGPUSortKeys(
  context: { device: GPUDevice | null | undefined },
  encoder: GPUCommandEncoder,
  count: number,
): void {
  const inst = _instances.get(context);
  if (!inst) return;
  inst.prepareIndicesReadback(encoder, count);
}

/**
 * Async readback of the sorted command-indices array. Returns
 * `Uint32Array(count)` where `result[i]` is the original (pre-sort)
 * command index that ended up in sorted position `i`. Returns null
 * when no readback was prepared, the dispatcher isn't allocated, or
 * a readback is already in flight.
 */
async function readSortedIndicesWebGPUGPUSortKeys(
  context: { device: GPUDevice | null | undefined },
  count: number,
): Promise<Uint32Array | null> {
  const inst = _instances.get(context);
  if (!inst) return null;
  return inst.readSortedIndices(count);
}

export {
  WebGPUGPUSortKeysDispatcher,
  SORT_KEY_PARAMS_BYTES,
  initWebGPUGPUSortKeys,
  dispatchWebGPUGPUSortKeys,
  runBitonicSortWebGPUGPUSortKeys,
  prepareIndicesReadbackWebGPUGPUSortKeys,
  readSortedIndicesWebGPUGPUSortKeys,
  getWebGPUGPUSortKeysStatistics,
  destroyWebGPUGPUSortKeys,
};
export default WebGPUGPUSortKeysDispatcher;
