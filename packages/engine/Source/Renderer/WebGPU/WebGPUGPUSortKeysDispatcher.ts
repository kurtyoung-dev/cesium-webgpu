/// <reference types="@webgpu/types" />
/**
 * @module WebGPUGPUSortKeysDispatcher
 *
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
 */

const SORT_KEY_PARAMS_BYTES = 32; // 8 × u32

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
}

/**
 * Sort mode values that match `GPUSortKeys.wgsl`'s SortKeyParams.sortMode.
 */
export const SORT_MODE_FRONT_TO_BACK = 0;
export const SORT_MODE_BACK_TO_FRONT = 1;

class WebGPUGPUSortKeysDispatcher {
  private _device: GPUDevice;
  private _resources: GPUSortKeysResources | null = null;
  private _shaderModule: GPUShaderModule | null = null;
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

    const bindGroupLayout = device.createBindGroupLayout({
      label: "GPUSortKeys_BGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        ...[1, 2, 3, 4, 5, 6].map((b) => ({
          binding: b,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" as GPUBufferBindingType },
        })),
        ...[7, 8, 9].map((b) => ({
          binding: b,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" as GPUBufferBindingType },
        })),
      ],
    });

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

    const pipeline = device.createComputePipeline({
      label: "GPUSortKeys_Pipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
      }),
      compute: {
        module: this._shaderModule!,
        entryPoint: "computeMain",
      },
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
    };
    return true;
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
    } catch (_e) {
      // Defensive — double-destroy is a no-op.
    }
    this._resources = null;
  }
}

// ─── Feature renderer factory + entry points ───────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import GPUSortKeysSource from "../../Shaders/WebGPU/Compute/GPUSortKeys.js";

const _instances = new WeakMap<object, WebGPUGPUSortKeysDispatcher>();

function getOrCreateDispatcher(context: {
  device: GPUDevice | null | undefined;
}): WebGPUGPUSortKeysDispatcher | null {
  if (!context || !context.device) return null;
  let inst = _instances.get(context);
  if (!inst) {
    inst = new WebGPUGPUSortKeysDispatcher(context.device);
    inst.setShaderSource(GPUSortKeysSource);
    _instances.set(context, inst);
  }
  return inst;
}

function initWebGPUGPUSortKeys(
  context: { device: GPUDevice | null | undefined },
  maxCommands: number,
): boolean {
  const inst = getOrCreateDispatcher(context);
  if (!inst) return false;
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
}): object | null {
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

export {
  WebGPUGPUSortKeysDispatcher,
  SORT_KEY_PARAMS_BYTES,
  initWebGPUGPUSortKeys,
  dispatchWebGPUGPUSortKeys,
  getWebGPUGPUSortKeysStatistics,
  destroyWebGPUGPUSortKeys,
};
export default WebGPUGPUSortKeysDispatcher;
