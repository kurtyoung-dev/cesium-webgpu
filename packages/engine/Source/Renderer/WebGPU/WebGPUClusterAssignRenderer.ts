/// <reference types="@webgpu/types" />
/**
 * Assigns eye-space punctual lights to a 16×9×24 Forward+ cluster grid.
 *
 * The renderer owns a per-device compute pipeline, a packed light buffer, and
 * the per-cluster count and index outputs. The caller supplies the AABB buffer
 * and eye-space light records. A change to the AABBs invalidates every bin even
 * when the packed light data is unchanged, so `boundsChanged` bypasses the cache.
 *
 * Dirty tracking compares the light count and every packed float against the
 * last upload, so cache hits can safely skip both the upload and assignment.
 *
 * Storage layout:
 *   - `lights`: 1024 records × 80 bytes = 80 KiB.
 *   - `perClusterLightCount`: 3456 `u32` values = 13.5 KiB.
 *   - `perClusterLightIndices`: 3456 × 256 `u32` values = 3.375 MiB.
 *
 * The renderer clamps the scene-wide list to 1024 lights, so larger lists
 * require caller-side spatial culling. The 256-light per-cluster cap matches
 * Brandon Jones's WebGPU clustered-shading reference:
 * https://github.com/toji/webgpu-clustered-shading.
 *
 * @module WebGPUClusterAssignRenderer
 */

import ClusterAssignShader from "../../Shaders/WebGPU/Compute/ClusterAssign.js";
import {
  CLUSTER_TILE_COUNT_X,
  CLUSTER_TILE_COUNT_Y,
  CLUSTER_SLICE_COUNT_Z,
  CLUSTER_TOTAL_COUNT,
} from "./WebGPUClusterBoundsRenderer.js";

// Scene-wide light cap. Beyond this, CPU-side spatial culling must
// drop lights before dispatching. Matches MAX_LIGHTS in
// ClusterAssign.wgsl.
export const CLUSTER_MAX_LIGHTS = 1024;

// Per-cluster overlap cap. Matches MAX_LIGHTS_PER_CLUSTER in
// ClusterAssign.wgsl.
export const CLUSTER_MAX_LIGHTS_PER_CLUSTER = 256;

// Per-light record size in bytes (matches ClusteredLight struct in
// ClusterAssign.wgsl: 5 vec4 = 80 B).
const CLUSTERED_LIGHT_BYTES = 80;
export const CLUSTERED_LIGHT_FLOATS = CLUSTERED_LIGHT_BYTES / 4;

export function packedClusteredLightsChanged(
  previousData: Float32Array,
  previousLightCount: number,
  currentData: Float32Array,
  currentLightCount: number,
): boolean {
  if (previousLightCount !== currentLightCount) {
    return true;
  }

  const packedFloatCount = currentLightCount * CLUSTERED_LIGHT_FLOATS;
  if (
    previousData.length < packedFloatCount ||
    currentData.length < packedFloatCount
  ) {
    return true;
  }

  for (let i = 0; i < packedFloatCount; i++) {
    if (!Object.is(previousData[i], currentData[i])) {
      return true;
    }
  }
  return false;
}

// Exported storage sizes match the compute outputs consumed by fragment
// pipelines.
export const CLUSTER_LIGHT_STORAGE_BYTES =
  CLUSTER_MAX_LIGHTS * CLUSTERED_LIGHT_BYTES;
export const CLUSTER_LIGHT_COUNT_STORAGE_BYTES = CLUSTER_TOTAL_COUNT * 4;
export const CLUSTER_LIGHT_INDICES_STORAGE_BYTES =
  CLUSTER_TOTAL_COUNT * CLUSTER_MAX_LIGHTS_PER_CLUSTER * 4;

// Uniform buffer: just `lightCount` (u32) + 12 bytes pad to 256-byte
// alignment minimum.
const CLUSTER_ASSIGN_UNIFORM_BYTES = 256;

// Workgroup size: (8, 8, 1). Dispatch: (2, 2, 24) — matches the
// ClusterBounds compute (same grid).
const DISPATCH_GROUPS_X = Math.ceil(CLUSTER_TILE_COUNT_X / 8);
const DISPATCH_GROUPS_Y = Math.ceil(CLUSTER_TILE_COUNT_Y / 8);
const DISPATCH_GROUPS_Z = CLUSTER_SLICE_COUNT_Z;

interface ClusterAssignPipelineCache {
  pipeline: GPUComputePipeline;
  bindGroupLayout: GPUBindGroupLayout;
}

const _perDevicePipelineCache = new WeakMap<
  GPUDevice,
  ClusterAssignPipelineCache
>();

function getPipelineCache(device: GPUDevice): ClusterAssignPipelineCache {
  const cached = _perDevicePipelineCache.get(device);
  if (cached) return cached;

  const shaderModule = device.createShaderModule({
    label: "ClusterAssign shader",
    code: ClusterAssignShader,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    label: "ClusterAssign BGL",
    entries: [
      // 0: clusterAABBs (read-only storage, from ClusterBounds output)
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" },
      },
      // 1: lights (read-only storage, packed CPU-side per dispatch)
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" },
      },
      // 2: uniforms (lightCount)
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" },
      },
      // 3: perClusterLightCount (read-write storage)
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
      // 4: perClusterLightIndices (read-write storage)
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    label: "ClusterAssign pipeline layout",
    bindGroupLayouts: [bindGroupLayout],
  });

  const pipeline = device.createComputePipeline({
    label: "ClusterAssign pipeline",
    layout: pipelineLayout,
    compute: {
      module: shaderModule,
      entryPoint: "main",
    },
  });

  const entry: ClusterAssignPipelineCache = { pipeline, bindGroupLayout };
  _perDevicePipelineCache.set(device, entry);
  return entry;
}

/**
 * Light type enum shared with `ClusterAssign.wgsl` and `LightTypes.ts`.
 */
export const enum ClusteredLightType {
  Directional = 0,
  Point = 1,
  Spot = 2,
}

/**
 * CPU-side light record handed to {@link WebGPUClusterAssignRenderer
 * #dispatch}. All vectors must already be in eye space; the caller is
 * responsible for applying the current view transform.
 *
 * Field meanings mirror the WGSL `ClusteredLight` struct one-to-one.
 */
export interface ClusteredLightDef {
  type: ClusteredLightType;
  /** Eye-space position (point/spot) or direction (directional). */
  posOrDir: { x: number; y: number; z: number };
  color: { r: number; g: number; b: number };
  intensity: number;
  /** Effective range in meters. 0 = infinite. */
  range: number;
  constantAtt?: number;
  linearAtt?: number;
  quadraticAtt?: number;
  innerConeAngle?: number;
  outerConeAngle?: number;
  /** Eye-space forward direction for spot lights. */
  spotDir?: { x: number; y: number; z: number };
}

export class WebGPUClusterAssignRenderer {
  private readonly _device: GPUDevice;
  private readonly _pipelineCache: ClusterAssignPipelineCache;
  private readonly _lightStorageBuffer: GPUBuffer;
  private readonly _uniformBuffer: GPUBuffer;
  private readonly _perClusterCountBuffer: GPUBuffer;
  private readonly _perClusterIndicesBuffer: GPUBuffer;
  // The first dispatch supplies the cluster-AABB buffer needed to build this
  // bind group.
  private _bindGroup: GPUBindGroup | null = null;
  private _lastClusterAABBs: GPUBuffer | null = null;
  // Scratch pack buffer for the per-light record stream.
  private readonly _lightPackBuffer: Float32Array;
  private readonly _lastUploadedLightData: Float32Array;
  private readonly _uniformData: Uint32Array;
  private _lastUploadedLightCount: number = 0;
  private _firstDispatchDone: boolean = false;

  constructor(device: GPUDevice) {
    this._device = device;
    this._pipelineCache = getPipelineCache(device);

    this._lightStorageBuffer = device.createBuffer({
      label: "ClusterAssign lights",
      size: CLUSTER_LIGHT_STORAGE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this._uniformBuffer = device.createBuffer({
      label: "ClusterAssign UB",
      size: CLUSTER_ASSIGN_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._perClusterCountBuffer = device.createBuffer({
      label: "ClusterAssign perClusterLightCount",
      size: CLUSTER_LIGHT_COUNT_STORAGE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this._perClusterIndicesBuffer = device.createBuffer({
      label: "ClusterAssign perClusterLightIndices",
      size: CLUSTER_LIGHT_INDICES_STORAGE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    this._lightPackBuffer = new Float32Array(
      CLUSTER_MAX_LIGHTS * CLUSTERED_LIGHT_FLOATS,
    );
    this._lastUploadedLightData = new Float32Array(
      CLUSTER_MAX_LIGHTS * CLUSTERED_LIGHT_FLOATS,
    );
    this._uniformData = new Uint32Array(64); // 256 bytes / 4
  }

  /** Per-cluster output handles consumed by Forward+ fragment shaders. */
  get perClusterLightCountBuffer(): GPUBuffer {
    return this._perClusterCountBuffer;
  }
  get perClusterLightIndicesBuffer(): GPUBuffer {
    return this._perClusterIndicesBuffer;
  }
  /** The packed light record buffer (also bound by the FS consumer). */
  get lightStorageBuffer(): GPUBuffer {
    return this._lightStorageBuffer;
  }

  /**
   * Pack the eye-space light defs into the GPU buffer + dispatch
   * the compute. Idempotent when the packed light data matches the
   * previous dispatch and the cluster bounds did not change.
   *
   * @param boundsChanged When true, the upstream cluster-bounds pass
   *   re-dispatched this frame (viewport / FOV / near-far changed), so
   *   the previous assignment is stale even if the packed light data
   *   matches. Forces a re-dispatch regardless of the packed-light
   *   cache. Defaults to false.
   * @returns true if a dispatch was issued; false on cache hit.
   */
  dispatch(
    encoder: GPUCommandEncoder,
    clusterAABBs: GPUBuffer,
    lights: ReadonlyArray<ClusteredLightDef>,
    boundsChanged: boolean = false,
  ): boolean {
    const clampedCount = Math.min(lights.length, CLUSTER_MAX_LIGHTS);

    // Pack into the scratch float buffer for dirty tracking.
    const data = this._lightPackBuffer;
    data.fill(0, 0, clampedCount * CLUSTERED_LIGHT_FLOATS);
    for (let i = 0; i < clampedCount; i++) {
      const offset = i * CLUSTERED_LIGHT_FLOATS;
      const L = lights[i];
      // posOrDirEC (vec4): xyz + lightType-as-float
      data[offset + 0] = L.posOrDir.x;
      data[offset + 1] = L.posOrDir.y;
      data[offset + 2] = L.posOrDir.z;
      data[offset + 3] = L.type;
      // colorAndIntensity (vec4)
      data[offset + 4] = L.color.r;
      data[offset + 5] = L.color.g;
      data[offset + 6] = L.color.b;
      data[offset + 7] = L.intensity;
      // rangeAndAtten (vec4)
      data[offset + 8] = L.range ?? 0;
      data[offset + 9] = L.constantAtt ?? 1;
      data[offset + 10] = L.linearAtt ?? 0;
      data[offset + 11] = L.quadraticAtt ?? 0;
      // coneAngles (vec4)
      data[offset + 12] = L.innerConeAngle ?? 0;
      data[offset + 13] = L.outerConeAngle ?? 0;
      // [14, 15] pad
      // spotDirEC (vec4)
      const sd = L.spotDir;
      data[offset + 16] = sd?.x ?? 0;
      data[offset + 17] = sd?.y ?? 0;
      data[offset + 18] = sd?.z ?? 0;
      // [19] pad
    }

    // Cache hits skip the upload as well as assignment, so every packed float
    // and the light count must match the last upload.
    const lightsChanged = packedClusteredLightsChanged(
      this._lastUploadedLightData,
      this._lastUploadedLightCount,
      data,
      clampedCount,
    );
    if (!boundsChanged && this._firstDispatchDone && !lightsChanged) {
      return false;
    }

    const packedFloatCount = clampedCount * CLUSTERED_LIGHT_FLOATS;
    for (let i = 0; i < packedFloatCount; i++) {
      this._lastUploadedLightData[i] = data[i];
    }
    this._lastUploadedLightCount = clampedCount;

    // Upload light data + count.
    this._device.queue.writeBuffer(
      this._lightStorageBuffer,
      0,
      data,
      0,
      packedFloatCount,
    );
    this._uniformData[0] = clampedCount;
    this._device.queue.writeBuffer(this._uniformBuffer, 0, this._uniformData);

    // Rebuild the bind group whenever the upstream clusterAABBs
    // buffer changes (shouldn't happen often — same buffer for the
    // life of a ClusterBoundsRenderer instance).
    if (this._bindGroup === null || this._lastClusterAABBs !== clusterAABBs) {
      this._bindGroup = this._device.createBindGroup({
        label: "ClusterAssign BG",
        layout: this._pipelineCache.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: clusterAABBs } },
          { binding: 1, resource: { buffer: this._lightStorageBuffer } },
          { binding: 2, resource: { buffer: this._uniformBuffer } },
          { binding: 3, resource: { buffer: this._perClusterCountBuffer } },
          { binding: 4, resource: { buffer: this._perClusterIndicesBuffer } },
        ],
      });
      this._lastClusterAABBs = clusterAABBs;
    }

    // Dispatch.
    const passEncoder = encoder.beginComputePass({
      label: "ClusterAssign compute pass",
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

  destroy(): void {
    this._lightStorageBuffer.destroy();
    this._uniformBuffer.destroy();
    this._perClusterCountBuffer.destroy();
    this._perClusterIndicesBuffer.destroy();
  }
}

export default WebGPUClusterAssignRenderer;
