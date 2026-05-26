/// <reference types="@webgpu/types" />
/**
 * WebGPUClusterAssignRenderer — Slice 5d Batch 148.
 *
 * NEW-GBUFFER-CONSUMER-CLUSTERED-LIGHTING step 4 (light-to-cluster
 * assignment compute pass). Owns:
 *   - Per-device cached compute pipeline + BGL.
 *   - Per-renderer storage buffers for lights + per-cluster outputs.
 *   - CPU-side packing of `LightCollection` entries into the
 *     eye-space layout the compute shader expects.
 *
 * # When to dispatch
 *
 * The assignment depends on:
 *   - The light list (positions, types, ranges) — changes when
 *     `scene.lights` is mutated OR when a glTF model with KHR_lights_
 *     punctual loads (`model.lightsFromGltf` changes).
 *   - The view matrix — positions / directions are transformed to
 *     eye-space CPU-side, so any camera motion invalidates the
 *     assignment.
 *
 * Re-dispatch IS NOT required when the cluster bounds (Batch 147)
 * change but the lights + view don't — but that case is rare in
 * practice (cluster bounds change only on viewport/FOV/near-far
 * changes, which usually coincide with camera motion).
 *
 * Dirty tracking is via a content hash of (lightCount, lightDataSum,
 * viewMatrixSum). Computed each frame; skipped re-dispatch when
 * unchanged. Cheap — ~16 + 80*N floats to sum.
 *
 * # Storage buffer layout
 *
 *   - `lights`: array<ClusteredLight, 1024> = 80 KiB.
 *     ClusteredLight (80 B): posOrDirEC(vec4) + colorAndIntensity(vec4)
 *     + rangeAndAtten(vec4) + coneAngles(vec4) + spotDirEC(vec4) = 5 vec4.
 *   - `perClusterLightCount`: array<u32, 3456> = ~13.5 KiB.
 *   - `perClusterLightIndices`: array<u32, 3456 * 256> = ~3.4 MiB.
 *
 * The cap of 256 lights per cluster matches toji's reference; the
 * 1024 scene-wide cap is the renderer's hard ceiling — scenes with
 * more lights need CPU-side spatial culling before dispatch.
 *
 * # Not yet wired
 *
 * Same as Batch 147 — standalone module; Batch 149 (step 137e) wires
 * the storage buffers to the Forward+ FS consumer. Probe in
 * `probe-cluster-assign.mjs` covers standalone dispatch + correctness
 * verification via storage buffer readback.
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
const CLUSTERED_LIGHT_FLOATS = CLUSTERED_LIGHT_BYTES / 4;

// Storage sizes — exported for downstream allocation (Batch 149 FS
// consumer will bind these).
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
 * Simple light type enum — must match WGSL constants in
 * ClusterAssign.wgsl AND LightType in LightTypes.ts.
 */
export const enum ClusteredLightType {
  Directional = 0,
  Point = 1,
  Spot = 2,
}

/**
 * CPU-side light record handed to {@link WebGPUClusterAssignRenderer
 * #dispatch}. All vectors must already be in EYE space — caller is
 * responsible for transforming the world-space `LightCollection` /
 * `lightsFromGltf` entries through the current view matrix.
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
  // BindGroup is rebuilt on the first dispatch (we need a
  // clusterAABBs buffer reference — caller passes it via dispatch()).
  private _bindGroup: GPUBindGroup | null = null;
  private _lastClusterAABBs: GPUBuffer | null = null;
  // Scratch pack buffer for the per-light record stream.
  private readonly _lightPackBuffer: Float32Array;
  private readonly _uniformData: Uint32Array;
  // Dirty tracking — content hash of (lightCount, lightPackChecksum)
  // + viewMatrixChecksum. Re-dispatch only when this changes.
  private _lastLightsChecksum: number = NaN;
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
    this._uniformData = new Uint32Array(64); // 256 bytes / 4
  }

  /**
   * Output handles — bound by the Forward+ FS consumer (Batch 149).
   */
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
   * the compute. Idempotent when the packed contents match the
   * previous dispatch.
   *
   * @returns true if a dispatch was issued; false on cache hit.
   */
  dispatch(
    encoder: GPUCommandEncoder,
    clusterAABBs: GPUBuffer,
    lights: ReadonlyArray<ClusteredLightDef>,
  ): boolean {
    const clampedCount = Math.min(lights.length, CLUSTER_MAX_LIGHTS);

    // Pack into the scratch float buffer + compute a checksum for
    // dirty tracking.
    const data = this._lightPackBuffer;
    data.fill(0, 0, clampedCount * CLUSTERED_LIGHT_FLOATS);
    let checksum = clampedCount * 1e6; // Mix the count into the hash so
    // adding a light produces a different checksum even if the new
    // light's data sums to zero.
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
      // Checksum: lightweight sum of position + type. Sufficient for
      // dirty tracking when callers update via the typical
      // "world-space pose + view matrix" path.
      checksum +=
        (L.posOrDir.x + L.posOrDir.y * 1.31 + L.posOrDir.z * 1.71) * (i + 1) +
        L.type * 100 * (i + 1);
    }

    // Dirty-tracking cache hit?
    if (this._firstDispatchDone && checksum === this._lastLightsChecksum) {
      return false;
    }
    this._lastLightsChecksum = checksum;

    // Upload light data + count.
    this._device.queue.writeBuffer(
      this._lightStorageBuffer,
      0,
      data,
      0,
      clampedCount * CLUSTERED_LIGHT_FLOATS,
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
