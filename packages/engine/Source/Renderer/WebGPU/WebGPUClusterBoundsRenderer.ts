/// <reference types="@webgpu/types" />
/**
 * Computes eye-space AABBs for a 16×9×24 Forward+ cluster grid.
 *
 * Each dispatcher owns the uniform and storage buffers, while the stateless
 * pipeline and bind-group layout are cached per device. Bounds depend on the
 * viewport, near and far planes, and inverse projection. They are invariant
 * under camera position and orientation, so unchanged inputs skip the compute
 * pass.
 *
 * The scene supplies one near/far pair spanning its outermost visible frustum.
 * The resulting grid covers the full visible depth range rather than being
 * rebuilt for each multi-frustum slice.
 *
 * The output is `array<ClusterAABB, 3456>`. Each pair of aligned `vec4<f32>`
 * values occupies 32 bytes, for a 110592-byte buffer, well below the default
 * 128 MiB storage-binding limit. Consumers index it with
 * `tileX + tileY * 16 + sliceZ * 16 * 9`.
 *
 * @module WebGPUClusterBoundsRenderer
 */

import ClusterBoundsShader from "../../Shaders/WebGPU/Compute/ClusterBounds.js";

// Grid constants must match `ClusterBounds.wgsl`. The assignment renderer uses
// the exported total to size its per-cluster output buffers.
export const CLUSTER_TILE_COUNT_X = 16;
export const CLUSTER_TILE_COUNT_Y = 9;
export const CLUSTER_SLICE_COUNT_Z = 24;
export const CLUSTER_TOTAL_COUNT =
  CLUSTER_TILE_COUNT_X * CLUSTER_TILE_COUNT_Y * CLUSTER_SLICE_COUNT_Z;

// Storage-buffer size: 32 bytes per cluster × CLUSTER_TOTAL_COUNT.
const CLUSTER_AABB_BYTES_PER_CLUSTER = 32;
export const CLUSTER_BOUNDS_STORAGE_BYTES =
  CLUSTER_AABB_BYTES_PER_CLUSTER * CLUSTER_TOTAL_COUNT;

// Uniform-buffer size: 2 vec4 (32 bytes) + mat4 (64 bytes) = 96 bytes.
// Padded to 256-byte alignment minimum.
const CLUSTER_BOUNDS_UNIFORM_BYTES = 256;

// Workgroup size from ClusterBounds.wgsl: (8, 8, 1). Dispatch covers
// the full 16×9×24 grid: ceil(16/8)=2, ceil(9/8)=2, 24 → (2, 2, 24).
const DISPATCH_GROUPS_X = Math.ceil(CLUSTER_TILE_COUNT_X / 8);
const DISPATCH_GROUPS_Y = Math.ceil(CLUSTER_TILE_COUNT_Y / 8);
const DISPATCH_GROUPS_Z = CLUSTER_SLICE_COUNT_Z;

interface ClusterBoundsPipelineCache {
  pipeline: GPUComputePipeline;
  bindGroupLayout: GPUBindGroupLayout;
}

const _perDevicePipelineCache = new WeakMap<
  GPUDevice,
  ClusterBoundsPipelineCache
>();

/**
 * Per-device cached pipeline + BGL. Cached because the pipeline +
 * BGL are stateless and reusable across every render target / scene.
 */
function getPipelineCache(device: GPUDevice): ClusterBoundsPipelineCache {
  const cached = _perDevicePipelineCache.get(device);
  if (cached) return cached;

  const shaderModule = device.createShaderModule({
    label: "ClusterBounds shader",
    code: ClusterBoundsShader,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    label: "ClusterBounds BGL",
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
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    label: "ClusterBounds pipeline layout",
    bindGroupLayouts: [bindGroupLayout],
  });

  const pipeline = device.createComputePipeline({
    label: "ClusterBounds pipeline",
    layout: pipelineLayout,
    compute: {
      module: shaderModule,
      entryPoint: "main",
    },
  });

  const entry: ClusterBoundsPipelineCache = { pipeline, bindGroupLayout };
  _perDevicePipelineCache.set(device, entry);
  return entry;
}

/**
 * Per-dispatcher resources for cluster configuration, AABB output, and the
 * cached input tuple used to skip redundant dispatches.
 */
export class WebGPUClusterBoundsRenderer {
  private readonly _device: GPUDevice;
  private readonly _pipelineCache: ClusterBoundsPipelineCache;
  private readonly _uniformBuffer: GPUBuffer;
  private readonly _storageBuffer: GPUBuffer;
  private readonly _bindGroup: GPUBindGroup;
  private readonly _uniformData: Float32Array;
  // Cached input tuple for dirty tracking. Re-dispatch skipped when
  // these all match.
  private _cachedViewportW: number = -1;
  private _cachedViewportH: number = -1;
  private _cachedNear: number = -1;
  private _cachedFar: number = -1;
  // Keep the column-major projection cache as f64 `number[]` values. A
  // `Float32Array` would round the input, so strict comparison against the
  // caller's f64 values would report a change on every frame.
  private _cachedProjection: number[] = new Array(16).fill(0);
  private _firstDispatchDone: boolean = false;

  constructor(device: GPUDevice) {
    this._device = device;
    this._pipelineCache = getPipelineCache(device);

    this._uniformBuffer = device.createBuffer({
      label: "ClusterBounds UB",
      size: CLUSTER_BOUNDS_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._storageBuffer = device.createBuffer({
      label: "ClusterBounds storage",
      size: CLUSTER_BOUNDS_STORAGE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this._bindGroup = device.createBindGroup({
      label: "ClusterBounds BG",
      layout: this._pipelineCache.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this._uniformBuffer } },
        { binding: 1, resource: { buffer: this._storageBuffer } },
      ],
    });

    // 24 floats = 96 bytes of actual data; the rest of the 256-byte
    // buffer stays zero-padded.
    this._uniformData = new Float32Array(24);
  }

  /** Public read-only handle to the populated AABB storage buffer. */
  get storageBuffer(): GPUBuffer {
    return this._storageBuffer;
  }

  /**
   * Dispatch the cluster-bounds compute pass when (viewport, near,
   * far, projection) changed since the last dispatch. Idempotent
   * when nothing changed. Records into the caller-provided
   * `encoder` so the work fits within the frame's command stream;
   * caller is responsible for `encoder.finish()` + queue.submit.
   *
   * Returns true when a dispatch was issued, false when the cache
   * was hit and the pass was skipped.
   */
  dispatch(
    encoder: GPUCommandEncoder,
    viewportWidth: number,
    viewportHeight: number,
    near: number,
    far: number,
    inverseProjection: ArrayLike<number>,
  ): boolean {
    // Compare against cached inputs. The inverseProjection is a 16-
    // float column-major matrix; compare element-wise.
    if (
      this._firstDispatchDone &&
      viewportWidth === this._cachedViewportW &&
      viewportHeight === this._cachedViewportH &&
      near === this._cachedNear &&
      far === this._cachedFar
    ) {
      let projectionMatches = true;
      for (let i = 0; i < 16; i++) {
        if (this._cachedProjection[i] !== inverseProjection[i]) {
          projectionMatches = false;
          break;
        }
      }
      if (projectionMatches) {
        return false;
      }
    }

    // Cache miss — repack and re-dispatch.
    this._cachedViewportW = viewportWidth;
    this._cachedViewportH = viewportHeight;
    this._cachedNear = near;
    this._cachedFar = far;
    for (let i = 0; i < 16; i++) {
      this._cachedProjection[i] = inverseProjection[i];
    }

    // Pack uniforms.
    const data = this._uniformData;
    // viewportAndPlanes (vec4): width, height, near, far
    data[0] = viewportWidth;
    data[1] = viewportHeight;
    data[2] = near;
    data[3] = far;
    // gridDims (vec4): tileCountX, tileCountY, sliceCountZ, _
    data[4] = CLUSTER_TILE_COUNT_X;
    data[5] = CLUSTER_TILE_COUNT_Y;
    data[6] = CLUSTER_SLICE_COUNT_Z;
    data[7] = 0;
    // inverseProjection (mat4x4): column-major copy
    for (let i = 0; i < 16; i++) {
      data[8 + i] = inverseProjection[i];
    }
    this._device.queue.writeBuffer(this._uniformBuffer, 0, data);

    // Dispatch.
    const passEncoder = encoder.beginComputePass({
      label: "ClusterBounds compute pass",
    });
    passEncoder.setPipeline(this._pipelineCache.pipeline);
    passEncoder.setBindGroup(0, this._bindGroup);
    passEncoder.dispatchWorkgroups(
      DISPATCH_GROUPS_X,
      DISPATCH_GROUPS_Y,
      DISPATCH_GROUPS_Z,
    );
    passEncoder.end();

    this._firstDispatchDone = true;
    return true;
  }

  /**
   * Release GPU resources. Pipeline + BGL stay cached on the device
   * via the module-level `_perDevicePipelineCache` (next renderer
   * instance reuses them) — only the per-renderer buffers + bind
   * group go away here.
   */
  destroy(): void {
    this._uniformBuffer.destroy();
    this._storageBuffer.destroy();
  }
}

export default WebGPUClusterBoundsRenderer;
