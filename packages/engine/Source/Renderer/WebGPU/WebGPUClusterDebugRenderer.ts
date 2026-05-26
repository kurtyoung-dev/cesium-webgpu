/// <reference types="@webgpu/types" />
/**
 * WebGPUClusterDebugRenderer — Slice 5d Batch 149.
 *
 * Standalone debug pipeline that consumes ClusterBounds (Batch 147)
 * + ClusterAssign (Batch 148) storage buffers and renders a
 * fullscreen visualization of per-cluster light counts. Used by
 * `probe-cluster-fs-consumer.mjs` to end-to-end validate the full
 * Forward+ chain before the consumer chunk gets wired into Model PBR
 * + Lit Mat shaders (Batch 150+).
 *
 * Output color encoding (matches ClusterDebugVisualize.wgsl):
 *   - count == 0 → black
 *   - count == 1 → red
 *   - count == 2 → yellow
 *   - count == 3 → orange
 *   - count >= 4 → white
 *
 * @module WebGPUClusterDebugRenderer
 */

import ClusterDebugVisualizeShader from "../../Shaders/WebGPU/Compute/ClusterDebugVisualize.js";

const CLUSTER_DEBUG_UNIFORM_BYTES = 256;

interface ClusterDebugPipelineCache {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
}

const _perDevicePipelineCache = new WeakMap<
  GPUDevice,
  Map<GPUTextureFormat, ClusterDebugPipelineCache>
>();

function getPipelineCache(
  device: GPUDevice,
  targetFormat: GPUTextureFormat,
): ClusterDebugPipelineCache {
  let byFormat = _perDevicePipelineCache.get(device);
  if (!byFormat) {
    byFormat = new Map();
    _perDevicePipelineCache.set(device, byFormat);
  }
  const cached = byFormat.get(targetFormat);
  if (cached) return cached;

  const shaderModule = device.createShaderModule({
    label: "ClusterDebugVisualize shader",
    code: ClusterDebugVisualizeShader,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    label: "ClusterDebug BGL",
    entries: [
      // 0: clusterLights
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
      // 1: clusterAABBs (unused by the debug shader but kept in the
      // layout so the BG can re-use the ClusteredLighting binding
      // convention)
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
      // 2: perClusterLightCount
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
      // 3: perClusterLightIndices
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
      // 4: uniforms
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    label: "ClusterDebug pipeline layout",
    bindGroupLayouts: [bindGroupLayout],
  });

  const pipeline = device.createRenderPipeline({
    label: "ClusterDebug pipeline",
    layout: pipelineLayout,
    vertex: { module: shaderModule, entryPoint: "vertexMain" },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [{ format: targetFormat }],
    },
    primitive: { topology: "triangle-list" },
  });

  const entry: ClusterDebugPipelineCache = { pipeline, bindGroupLayout };
  byFormat.set(targetFormat, entry);
  return entry;
}

export class WebGPUClusterDebugRenderer {
  private readonly _device: GPUDevice;
  private readonly _uniformBuffer: GPUBuffer;
  private readonly _uniformData: Float32Array;
  private _bindGroup: GPUBindGroup | null = null;
  private _cachedTargetFormat: GPUTextureFormat | null = null;
  private _cachedLightBuf: GPUBuffer | null = null;
  private _cachedAABBBuf: GPUBuffer | null = null;
  private _cachedCountBuf: GPUBuffer | null = null;
  private _cachedIdxBuf: GPUBuffer | null = null;

  constructor(device: GPUDevice) {
    this._device = device;
    this._uniformBuffer = device.createBuffer({
      label: "ClusterDebug UB",
      size: CLUSTER_DEBUG_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._uniformData = new Float32Array(8);
  }

  /**
   * Render the debug visualization into the supplied texture view.
   *
   * @param encoder        - Active command encoder (caller owns
   *                         finish + submit).
   * @param targetView     - Color attachment view (must match
   *                         `targetFormat`).
   * @param targetFormat   - WebGPU texture format of the attachment.
   * @param viewport       - { width, height } of the render area.
   * @param near / far     - Frustum planes (positive distances).
   * @param testViewZ      - Eye-space Z to treat every pixel as
   *                         being at (probe walks slice index 0..23
   *                         to verify each slice's count buffer).
   * @param activeLightCount - Number of active lights this dispatch.
   *                           When 0 the shader early-outs to black.
   * @param lightBuf       - WebGPUClusterAssignRenderer.lightStorageBuffer
   * @param aabbBuf        - WebGPUClusterBoundsRenderer.storageBuffer
   * @param countBuf       - WebGPUClusterAssignRenderer.perClusterLightCountBuffer
   * @param idxBuf         - WebGPUClusterAssignRenderer.perClusterLightIndicesBuffer
   */
  render(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    targetFormat: GPUTextureFormat,
    viewport: { width: number; height: number },
    near: number,
    far: number,
    testViewZ: number,
    activeLightCount: number,
    lightBuf: GPUBuffer,
    aabbBuf: GPUBuffer,
    countBuf: GPUBuffer,
    idxBuf: GPUBuffer,
  ): void {
    const pipelineCache = getPipelineCache(this._device, targetFormat);

    // Pack uniforms.
    const data = this._uniformData;
    data[0] = viewport.width;
    data[1] = viewport.height;
    data[2] = near;
    data[3] = far;
    data[4] = testViewZ;
    data[5] = activeLightCount;
    data[6] = 0;
    data[7] = 0;
    this._device.queue.writeBuffer(this._uniformBuffer, 0, data);

    // Rebuild bind group if any input buffer changed.
    const buffersChanged =
      this._cachedLightBuf !== lightBuf ||
      this._cachedAABBBuf !== aabbBuf ||
      this._cachedCountBuf !== countBuf ||
      this._cachedIdxBuf !== idxBuf ||
      this._cachedTargetFormat !== targetFormat;
    if (this._bindGroup === null || buffersChanged) {
      this._bindGroup = this._device.createBindGroup({
        label: "ClusterDebug BG",
        layout: pipelineCache.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: lightBuf } },
          { binding: 1, resource: { buffer: aabbBuf } },
          { binding: 2, resource: { buffer: countBuf } },
          { binding: 3, resource: { buffer: idxBuf } },
          { binding: 4, resource: { buffer: this._uniformBuffer } },
        ],
      });
      this._cachedLightBuf = lightBuf;
      this._cachedAABBBuf = aabbBuf;
      this._cachedCountBuf = countBuf;
      this._cachedIdxBuf = idxBuf;
      this._cachedTargetFormat = targetFormat;
    }

    const passEncoder = encoder.beginRenderPass({
      label: "ClusterDebug render",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    passEncoder.setViewport(0, 0, viewport.width, viewport.height, 0, 1);
    passEncoder.setPipeline(pipelineCache.pipeline);
    passEncoder.setBindGroup(0, this._bindGroup);
    passEncoder.draw(3);
    passEncoder.end();
  }

  destroy(): void {
    this._uniformBuffer.destroy();
  }
}

export default WebGPUClusterDebugRenderer;
