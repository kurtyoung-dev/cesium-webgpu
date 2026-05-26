/// <reference types="@webgpu/types" />
/**
 * WebGPUClusterBoundsRenderer — Slice 5d Batch 137c.
 *
 * NEW-GBUFFER-CONSUMER-CLUSTERED-LIGHTING step 3 (cluster bounds
 * compute pass). Owns a per-device pipeline + per-context resources
 * (uniform buffer + storage buffer) for the 16×9×24 Forward+ cluster
 * grid. Dispatches the `ClusterBounds.wgsl` compute shader to populate
 * eye-space AABBs for every cluster.
 *
 * # When to dispatch
 *
 * Cluster bounds depend on `(viewport, frustum.near, frustum.far,
 * projection)`. They DO NOT depend on camera position or orientation
 * — eye-space cluster geometry is invariant under camera motion. So
 * the dispatcher caches the (viewport, near, far, projection) tuple
 * and skips re-dispatch when nothing relevant changed.
 *
 * Typical Cesium scene → re-dispatch happens at most:
 *   - Once on first frame
 *   - Each viewport resize
 *   - Each FOV change (rare — only on programmatic camera changes)
 *   - Each near/far update (frequent — multi-frustum splits land here)
 *
 * Multi-frustum poses an interesting case: each frustum slice has its
 * own (near, far) so the cluster grid would need to be re-bound per
 * slice. Today the renderer only ever runs one set of bounds at a
 * time — caller (step 5, the FS consumer) is responsible for
 * coordinating per-frustum re-dispatch if it needs to. This file just
 * makes the operation cheap when the inputs haven't changed.
 *
 * # Storage buffer layout
 *
 * `array<ClusterAABB, 3456>` where `ClusterAABB = { min: vec4<f32>,
 * max: vec4<f32> }` — 32 bytes per cluster × 3456 = 110592 bytes
 * (≈108 KiB). Well within the storage-buffer-binding limit (default
 * 128 MiB).
 *
 * Layout matches the WGSL struct exactly (vec4 alignment 16 bytes,
 * struct alignment 16 bytes). Consumers index by
 * `i = tileX + tileY*16 + sliceZ*16*9`.
 *
 * # Not yet wired
 *
 * This module is self-contained. Nothing in the rest of the renderer
 * calls into it as of Batch 137c — Batch 137d will hook it into the
 * per-frame render loop (gated on clustered-lighting being active)
 * and Batch 137e will bind the storage buffer to the Forward+ FS
 * consumer. Standalone construction + dispatch is testable via
 * `Tools/visual-regression/probe-cluster-bounds.mjs`.
 *
 * @module WebGPUClusterBoundsRenderer
 */

import ClusterBoundsShader from "../../Shaders/WebGPU/Compute/ClusterBounds.js";

// Grid constants — must match ClusterBounds.wgsl. Exposed for the
// step 4 dispatcher (light-to-cluster assignment) so it can size its
// own per-cluster light-count buffer to the same total.
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
 * Per-renderer resources: the uniform buffer (cluster grid + frustum
 * config), the storage buffer (per-cluster AABBs), the bind group,
 * and the cached input tuple used for dirty tracking.
 *
 * One instance per scene. Held by the renderer (Batch 137d will own
 * it on `WebGPUSceneRenderer` or similar); a fresh probe just
 * constructs one and calls `dispatch()` directly.
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
  // 16-float column-major projection matrix; compared element-wise.
  private _cachedProjection: Float32Array = new Float32Array(16);
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
