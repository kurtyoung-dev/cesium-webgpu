/// <reference types="@webgpu/types" />
/**
 * @module WebGPUPointCloudSortDispatcher
 *
 * Phase 3 activation wrapper around the PointCloudSort.wgsl bitonic
 * merge sort. Provides a self-contained dispatcher that the consumer
 * (point cloud collection / 3D Tiles point primitive) can call without
 * having to manage SortParams UBO updates, the (k, j) global-merge
 * loop, or bind group construction.
 *
 * The shader itself runs in two phases:
 *   Phase 1 — `localBitonicSort`: one workgroup sorts up to 256
 *             elements via shared memory.
 *   Phase 2 — `globalBitonicMerge`: one dispatch per (k, j) pair of
 *             the merge network, run after the local phase.
 *
 * The dispatcher hides this from the caller behind a single
 * `sort(encoder, distSq, indices, count)` call. After the encoded
 * compute passes execute, the sorted indices live in the dispatcher's
 * `outputIndicesBuffer` (read-only on the consumer side).
 *
 * The buffers are owned by the dispatcher instance and are reallocated
 * lazily when the requested element count exceeds the previously
 * allocated size. The size is rounded up to the next power of two
 * because bitonic sort requires power-of-two element counts; padding
 * elements are filled with `0xFFFFFFFFu` so they sort to the end and
 * can be discarded after readback.
 *
 * Pure GPU resource manager — no JS fallback here. The fallback path
 * lives in `WasmPointCloudBridge.sortByDistance()` and the consumer
 * is responsible for choosing between this and that based on
 * `WebGPUPerformanceManager.shouldUseGPUPointCloud(count)`.
 *
 * @private
 */

const SORT_PARAMS_BYTES = 16; // 4 × u32

/**
 * GPU resources owned by one PointCloudSort dispatcher. Allocated
 * lazily on first `sort()` call and rebuilt when the requested
 * element count exceeds the current capacity.
 */
interface PointCloudSortResources {
  capacity: number; // power-of-two number of elements the buffers hold
  paramsBuffer: GPUBuffer;
  sortKeysBuffer: GPUBuffer;
  indicesBuffer: GPUBuffer;
  bindGroupLayout: GPUBindGroupLayout;
  bindGroup: GPUBindGroup;
}

/**
 * Round `n` up to the next power of two. Bitonic sort requires
 * power-of-two element counts; the dispatcher pads with sentinel
 * keys to satisfy this.
 */
function nextPow2(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Float-to-sortable-uint, matching the WGSL helper. Flips the sign
 * bit (or all bits for negatives) so IEEE-754 floats sort correctly
 * as unsigned integers.
 */
function floatToSortableUint(f: number): number {
  // Use a Float32Array view to get the bit pattern.
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, f, true);
  let bits = view.getUint32(0, true);
  if ((bits & 0x80000000) !== 0) {
    bits = ~bits >>> 0;
  } else {
    bits = (bits ^ 0x80000000) >>> 0;
  }
  return bits;
}

/** Inverse of `floatToSortableUint`. Test/diagnostic helper only. */
function sortableUintToFloat(u: number): number {
  let bits;
  if ((u & 0x80000000) !== 0) {
    bits = (u ^ 0x80000000) >>> 0;
  } else {
    bits = ~u >>> 0;
  }
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits, true);
  return view.getFloat32(0, true);
}

class WebGPUPointCloudSortDispatcher {
  private _device: GPUDevice;
  private _resources: PointCloudSortResources | null = null;
  // Diagnostic counters — exposed via getStatistics() for the central
  // debug surface so an operator can confirm "yes the GPU sort is
  // actually firing this frame".
  private _sortsDispatched = 0;
  private _localPasses = 0;
  private _globalMergePasses = 0;
  private _lastElementCount = 0;
  private _lastCapacity = 0;
  // Reused scratch arrays for the host-side params upload. Allocated
  // once to avoid per-frame GC pressure on the dispatch hot path.
  private _paramsScratch = new Uint32Array(4);

  constructor(device: GPUDevice) {
    this._device = device;
  }

  /**
   * Diagnostic snapshot for the central debug surface. Pure read; safe
   * to call any time.
   */
  getStatistics(): {
    sortsDispatched: number;
    localPasses: number;
    globalMergePasses: number;
    lastElementCount: number;
    lastCapacity: number;
    capacity: number;
  } {
    return {
      sortsDispatched: this._sortsDispatched,
      localPasses: this._localPasses,
      globalMergePasses: this._globalMergePasses,
      lastElementCount: this._lastElementCount,
      lastCapacity: this._lastCapacity,
      capacity: this._resources?.capacity ?? 0,
    };
  }

  /**
   * The GPU buffer holding the sorted indices after a `sort()` call.
   * Returns `null` until the first `sort()` invocation.
   */
  get sortedIndicesBuffer(): GPUBuffer | null {
    return this._resources?.indicesBuffer ?? null;
  }

  /**
   * The GPU buffer holding the sortable-uint sort keys (parallel to
   * `sortedIndicesBuffer`). Mostly useful for diagnostic readback.
   */
  get sortedKeysBuffer(): GPUBuffer | null {
    return this._resources?.sortKeysBuffer ?? null;
  }

  /**
   * Encode the full bitonic sort into the given command encoder.
   *
   * The caller supplies (a) a Float32Array of squared distances and
   * (b) the count. The dispatcher uploads them into its persistent
   * GPU buffers, encodes the local phase, then loops the global
   * merge phase over the (k, j) network and returns. After the
   * encoder is submitted, the dispatcher's `sortedIndicesBuffer`
   * holds the back-to-front index order.
   *
   * @param encoder Active command encoder.
   * @param distSq Squared distances, one per point.
   * @param count Number of valid points (must be ≤ `distSq.length`).
   * @returns true on success, false if compute is unavailable.
   */
  sort(
    encoder: GPUCommandEncoder,
    distSq: Float32Array,
    count: number,
  ): boolean {
    if (count <= 1) {
      // Single-element / empty sort is trivially sorted; nothing to do.
      // Still bump the dispatched counter so callers can confirm the
      // entry point fired.
      this._sortsDispatched++;
      this._lastElementCount = count;
      return true;
    }
    const r = this._ensureResources(count);
    this._uploadInputs(distSq, count, r);
    this._encodeLocalPhase(encoder, r, count);
    this._encodeGlobalPhases(encoder, r, count);
    this._sortsDispatched++;
    this._lastElementCount = count;
    this._lastCapacity = r.capacity;
    return true;
  }

  /**
   * Release all owned GPU buffers and reset the dispatcher to its
   * pre-allocation state. Idempotent.
   */
  destroy(): void {
    if (this._resources) {
      this._resources.paramsBuffer.destroy();
      this._resources.sortKeysBuffer.destroy();
      this._resources.indicesBuffer.destroy();
      this._resources = null;
    }
  }

  // ─── Private ────────────────────────────────────────────────────

  private _ensureResources(count: number): PointCloudSortResources {
    const requiredCapacity = nextPow2(Math.max(count, 256));
    if (this._resources && this._resources.capacity >= requiredCapacity) {
      return this._resources;
    }
    if (this._resources) {
      this.destroy();
    }
    const device = this._device;
    const capacity = requiredCapacity;
    const elementBytes = 4;
    const bufferBytes = capacity * elementBytes;

    const paramsBuffer = device.createBuffer({
      label: "PointCloudSort_Params",
      size: SORT_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const sortKeysBuffer = device.createBuffer({
      label: "PointCloudSort_Keys",
      size: bufferBytes,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
    const indicesBuffer = device.createBuffer({
      label: "PointCloudSort_Indices",
      size: bufferBytes,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });

    const bindGroupLayout = device.createBindGroupLayout({
      label: "PointCloudSort_BGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
      ],
    });

    const bindGroup = device.createBindGroup({
      label: "PointCloudSort_BG",
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: { buffer: sortKeysBuffer } },
        { binding: 2, resource: { buffer: indicesBuffer } },
      ],
    });

    this._resources = {
      capacity,
      paramsBuffer,
      sortKeysBuffer,
      indicesBuffer,
      bindGroupLayout,
      bindGroup,
    };
    return this._resources;
  }

  private _uploadInputs(
    distSq: Float32Array,
    count: number,
    r: PointCloudSortResources,
  ): void {
    // Build the sortable-uint key array + identity index array. We
    // pad up to `r.capacity` with sentinel `0xFFFFFFFF` so the bitonic
    // network has a power-of-two input but the padding sorts to the
    // back. The consumer trims the result to `count` after readback.
    const keys = new Uint32Array(r.capacity);
    const indices = new Uint32Array(r.capacity);
    for (let i = 0; i < count; i++) {
      keys[i] = floatToSortableUint(distSq[i]);
      indices[i] = i;
    }
    // Pad — already zero-initialized for indices, but set keys to max.
    for (let i = count; i < r.capacity; i++) {
      keys[i] = 0xffffffff;
      indices[i] = 0xffffffff;
    }
    this._device.queue.writeBuffer(r.sortKeysBuffer, 0, keys.buffer);
    this._device.queue.writeBuffer(r.indicesBuffer, 0, indices.buffer);
  }

  private _writeParams(
    r: PointCloudSortResources,
    elementCount: number,
    k: number,
    j: number,
  ): void {
    this._paramsScratch[0] = elementCount;
    this._paramsScratch[1] = k;
    this._paramsScratch[2] = j;
    this._paramsScratch[3] = 0;
    this._device.queue.writeBuffer(
      r.paramsBuffer,
      0,
      this._paramsScratch.buffer,
    );
  }

  private _encodeLocalPhase(
    encoder: GPUCommandEncoder,
    r: PointCloudSortResources,
    count: number,
  ): void {
    // The local phase doesn't actually consume k/j (it does the full
    // 2..256 network internally), but elementCount is read in the
    // bounds checks, so we still need to upload params.
    this._writeParams(r, r.capacity, 256, 128);
    const pipeline = this._getPipeline("localBitonicSort");
    if (!pipeline) return;
    const workgroups = Math.ceil(r.capacity / 256);
    const pass = encoder.beginComputePass({
      label: "PointCloudSort_LocalPhase",
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, r.bindGroup);
    pass.dispatchWorkgroups(workgroups, 1, 1);
    pass.end();
    this._localPasses++;
  }

  private _encodeGlobalPhases(
    encoder: GPUCommandEncoder,
    r: PointCloudSortResources,
    count: number,
  ): void {
    const N = r.capacity;
    if (N <= 256) {
      // Local phase already produced a fully sorted output.
      return;
    }
    const pipeline = this._getPipeline("globalBitonicMerge");
    if (!pipeline) return;
    const workgroups = Math.ceil(N / 256);
    // Network: for k = 512, 1024, ..., N
    //            for j = k/2, k/4, ..., 1
    //              dispatch one merge step
    for (let k = 512; k <= N; k <<= 1) {
      for (let j = k >> 1; j > 0; j >>= 1) {
        this._writeParams(r, N, k, j);
        const pass = encoder.beginComputePass({
          label: `PointCloudSort_GlobalMerge_k${k}_j${j}`,
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, r.bindGroup);
        pass.dispatchWorkgroups(workgroups, 1, 1);
        pass.end();
        this._globalMergePasses++;
      }
    }
  }

  private _pipelines: Map<string, GPUComputePipeline> = new Map();
  private _shaderModule: GPUShaderModule | null = null;

  /**
   * Inject the WGSL source. Called once on first use by the feature
   * renderer registration. Required because the dispatcher doesn't
   * import the shader source directly — it's provided by the build
   * pipeline so the WGSL stays in `Source/Shaders/WebGPU/Compute/`.
   */
  setShaderSource(wgsl: string): void {
    if (this._shaderModule) {
      // Idempotent — first source wins. Re-loading would invalidate
      // every cached pipeline.
      return;
    }
    this._shaderModule = this._device.createShaderModule({
      label: "PointCloudSort_Shader",
      code: wgsl,
    });
  }

  private _getPipeline(entryPoint: string): GPUComputePipeline | null {
    if (!this._shaderModule) {
      return null;
    }
    const cached = this._pipelines.get(entryPoint);
    if (cached) return cached;
    const pipeline = this._device.createComputePipeline({
      label: `PointCloudSort_${entryPoint}`,
      layout: this._device.createPipelineLayout({
        bindGroupLayouts: [this._resources!.bindGroupLayout],
      }),
      compute: {
        module: this._shaderModule,
        entryPoint,
      },
    });
    this._pipelines.set(entryPoint, pipeline);
    return pipeline;
  }
}

export {
  WebGPUPointCloudSortDispatcher,
  nextPow2,
  floatToSortableUint,
  sortableUintToFloat,
};
export default WebGPUPointCloudSortDispatcher;
