/// <reference types="@webgpu/types" />
/**
 * WebGPUClusteredLightingDispatcher — Slice 5d Batch 150.
 *
 * Per-frame orchestrator that ties together the cluster-bounds +
 * cluster-assign compute renderers (Batches 147 + 148) and produces
 * the three storage buffers + one uniform that consumer pipelines
 * bind at `@group(4)` via the chunk in `ClusteredLighting.wgsl`
 * (Batch 149).
 *
 * # Per-frame responsibilities
 *
 * 1. Read `scene.clusteredLightingEnabled` + light collections
 *    (`scene.lights` + every `model.lightsFromGltf`).
 * 2. Skip dispatch when disabled OR zero lights — in that case the
 *    dispatcher still provides placeholder buffers so the consumer
 *    BGL is always satisfiable (avoids pipeline-variant explosion
 *    from runtime feature gating).
 * 3. Transform each world-space light to eye-space using the current
 *    view matrix. Positions: `view * pointWC`. Directions: `view *
 *    dirWC` (w=0). spotDirEC: same as direction.
 * 4. Dispatch ClusterBoundsRenderer (re-dispatches only when
 *    viewport / near / far / projection change).
 * 5. Dispatch ClusterAssignRenderer (re-dispatches when lights or
 *    view change).
 * 6. Expose the four GPU buffers (clusterLights, clusterAABBs,
 *    perClusterLightCount, perClusterLightIndices) + the params
 *    uniform buffer so consumer pipelines can build their
 *    `@group(4)` bind groups.
 *
 * # The "always-bind-something" pattern
 *
 * Consumer pipelines have a fixed `@group(4)` BGL — adding/removing
 * a bind group at runtime requires rebuilding pipelines. Instead,
 * when clustered lighting is OFF or zero lights are active, the
 * dispatcher:
 *   - Skips the compute passes (cheap).
 *   - Sets `clusterParams.activeLightCount.x = 0` in the uniform,
 *     which makes `evalClusteredLights` early-out to vec3(0) in
 *     the FS chunk.
 *   - The storage buffers retain whatever previous-frame contents
 *     they had (or zeros on first frame from `device.createBuffer`).
 *     The FS never reads them when activeLightCount=0, so the
 *     contents don't matter.
 *
 * This keeps the consumer FS branch-light (one uniform compare to
 * skip the entire chain) and the consumer pipeline definition
 * static (no variant explosion).
 *
 * @module WebGPUClusteredLightingDispatcher
 */

import { WebGPUClusterBoundsRenderer } from "./WebGPUClusterBoundsRenderer.js";
import {
  WebGPUClusterAssignRenderer,
  CLUSTER_MAX_LIGHTS,
  type ClusteredLightDef,
} from "./WebGPUClusterAssignRenderer.js";
import {
  getClusteredLightingBGL,
  buildClusteredLightingBindGroup,
} from "./WebGPUClusteredLightingBGL.js";

// Uniform buffer holds ClusteredParams: 2 vec4 = 32 bytes. Padded to
// 256-byte minimum alignment.
const PARAMS_UNIFORM_BYTES = 256;

/**
 * Minimal interface for the world-space light entries this dispatcher
 * consumes. Matches the shape of `scene.lights.values` (LightCollection
 * entries) AND `model.lightsFromGltf[]` entries from GltfLoader.
 *
 * Caller-side: walk those two sources, normalize to this shape,
 * pass an array to `dispatch()`.
 */
export interface ClusterLightingInputLight {
  /** 0 = directional, 1 = point, 2 = spot — matches LightType enum. */
  lightType: number;
  /** World-space position (point/spot) OR direction (directional). */
  posOrDirWC: { x: number; y: number; z: number };
  color: {
    red?: number;
    green?: number;
    blue?: number;
    r?: number;
    g?: number;
    b?: number;
  };
  intensity?: number;
  range?: number;
  innerConeAngle?: number;
  outerConeAngle?: number;
  /** World-space spot direction (spot only). */
  spotDirWC?: { x: number; y: number; z: number };
}

/** Inputs to {@link WebGPUClusteredLightingDispatcher#dispatch}. */
export interface ClusterLightingDispatchInputs {
  /** `scene.clusteredLightingEnabled` */
  enabled: boolean;
  /** Active scene-wide light list (world-space) — concat of
   * `scene.lights.values` + every visible `model.lightsFromGltf[]`. */
  lights: ReadonlyArray<ClusterLightingInputLight>;
  viewportWidth: number;
  viewportHeight: number;
  near: number;
  far: number;
  /** Column-major 16-element inverse projection. */
  inverseProjection: ArrayLike<number>;
  /** Column-major 16-element view matrix (camera world → eye space). */
  viewMatrix: ArrayLike<number>;
}

export class WebGPUClusteredLightingDispatcher {
  private readonly _device: GPUDevice;
  private readonly _bounds: WebGPUClusterBoundsRenderer;
  private readonly _assign: WebGPUClusterAssignRenderer;
  private readonly _paramsBuffer: GPUBuffer;
  private readonly _paramsData: Float32Array;
  /** Scratch — reused each dispatch to avoid GC. */
  private readonly _scratchEyeLights: ClusteredLightDef[] = [];
  private _lastActiveLightCount: number = 0;

  constructor(device: GPUDevice) {
    this._device = device;
    this._bounds = new WebGPUClusterBoundsRenderer(device);
    this._assign = new WebGPUClusterAssignRenderer(device);
    this._paramsBuffer = device.createBuffer({
      label: "ClusteredLighting params",
      size: PARAMS_UNIFORM_BYTES,
      // COPY_SRC enables probe-side readback for testing (cost is zero
      // — buffer just lives in a different heap on some implementations).
      usage:
        GPUBufferUsage.UNIFORM |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
    this._paramsData = new Float32Array(8); // 2 vec4 of actual content
    // Initial state: 0 active lights (gates consumer FS early-out).
    this._paramsData[5] = 0;
    device.queue.writeBuffer(this._paramsBuffer, 0, this._paramsData);
  }

  /**
   * Public handles bound to consumer pipelines at `@group(4)`. These
   * exist for the lifetime of the dispatcher even when no dispatch
   * has happened yet — initial contents are device-cleared zeros
   * which are safe for the consumer (gated by `activeLightCount`).
   */
  get clusterLightsBuffer(): GPUBuffer {
    return this._assign.lightStorageBuffer;
  }
  get clusterAABBsBuffer(): GPUBuffer {
    return this._bounds.storageBuffer;
  }
  get perClusterLightCountBuffer(): GPUBuffer {
    return this._assign.perClusterLightCountBuffer;
  }
  get perClusterLightIndicesBuffer(): GPUBuffer {
    return this._assign.perClusterLightIndicesBuffer;
  }
  get paramsBuffer(): GPUBuffer {
    return this._paramsBuffer;
  }

  /**
   * Lazy-built bind group for the clustered-lighting resources. Buffers
   * don't change frame-to-frame (only their contents), so the bind group
   * is built once per dispatcher and reused. Cleared if the dispatcher
   * is destroyed.
   *
   * Currently unconsumed — Batch 152 originally landed Model PBR + Lit
   * Mat consumers at `@group(4)` but the platform's `maxBindGroups: 4`
   * ceiling forced a revert. Batch 153 will merge clustered-lighting
   * bindings into the existing group 3 (effects) BGL; at that point
   * this getter's bind group will be subsumed by the effects bind group
   * builder and the helper can be retired.
   *
   * The BGL itself comes from `getClusteredLightingBGL(device)`
   * (Batch 152) — same per-device cached BGL shared across every
   * consumer pipeline (provisional group slot).
   */
  private _consumerBindGroup: GPUBindGroup | null = null;
  get consumerBindGroup(): GPUBindGroup {
    if (!this._consumerBindGroup) {
      // Touch the BGL so it's cached for consumer pipeline layouts.
      getClusteredLightingBGL(this._device);
      this._consumerBindGroup = buildClusteredLightingBindGroup(this._device, {
        clusterLights: this.clusterLightsBuffer,
        clusterAABBs: this.clusterAABBsBuffer,
        perClusterLightCount: this.perClusterLightCountBuffer,
        perClusterLightIndices: this.perClusterLightIndicesBuffer,
        params: this.paramsBuffer,
      });
    }
    return this._consumerBindGroup;
  }

  /**
   * Per-frame dispatch. Records compute passes into the caller's
   * encoder; caller owns finish + submit (and must do so before any
   * consumer pipeline draws that bind the storage buffers).
   *
   * @returns the number of active lights packed this frame
   * (clamped to `CLUSTER_MAX_LIGHTS`). When 0, no compute passes
   * were issued — consumer FS will early-out via the uniform gate.
   */
  dispatch(
    encoder: GPUCommandEncoder,
    inputs: ClusterLightingDispatchInputs,
  ): number {
    let activeCount = 0;
    if (inputs.enabled) {
      activeCount = this._packEyeSpaceLights(inputs.lights, inputs.viewMatrix);
    }

    // Update the params uniform first so consumer FS sees the right
    // activeLightCount even when we skip the compute dispatches.
    const data = this._paramsData;
    data[0] = inputs.viewportWidth;
    data[1] = inputs.viewportHeight;
    data[2] = inputs.near;
    data[3] = inputs.far;
    data[4] = activeCount;
    data[5] = activeCount; // .x of activeLightCount vec4 (Batch 149 FS gate)
    data[6] = 0;
    data[7] = 0;
    this._device.queue.writeBuffer(this._paramsBuffer, 0, data);

    if (activeCount === 0) {
      this._lastActiveLightCount = 0;
      return 0;
    }

    // Dispatch both compute passes.
    this._bounds.dispatch(
      encoder,
      inputs.viewportWidth,
      inputs.viewportHeight,
      inputs.near,
      inputs.far,
      inputs.inverseProjection,
    );
    this._assign.dispatch(
      encoder,
      this._bounds.storageBuffer,
      this._scratchEyeLights.slice(0, activeCount),
    );

    this._lastActiveLightCount = activeCount;
    return activeCount;
  }

  /** Most recent active-light count from `dispatch()`. */
  get lastActiveLightCount(): number {
    return this._lastActiveLightCount;
  }

  /**
   * Transform world-space lights to eye-space and populate the
   * scratch ClusteredLightDef array. Returns the number of lights
   * actually packed (capped at CLUSTER_MAX_LIGHTS).
   */
  private _packEyeSpaceLights(
    lights: ReadonlyArray<ClusterLightingInputLight>,
    viewMatrix: ArrayLike<number>,
  ): number {
    const m = viewMatrix; // column-major 4x4
    const cap = Math.min(lights.length, CLUSTER_MAX_LIGHTS);
    // Grow scratch array if needed (kept across frames to avoid GC).
    while (this._scratchEyeLights.length < cap) {
      this._scratchEyeLights.push({
        type: 0,
        posOrDir: { x: 0, y: 0, z: 0 },
        color: { r: 1, g: 1, b: 1 },
        intensity: 1,
        range: 0,
      });
    }

    let outIndex = 0;
    for (let i = 0; i < cap; i++) {
      const L = lights[i];
      // Transform position (w=1) or direction (w=0) by the view matrix.
      const isDir = L.lightType === 0;
      const wx = L.posOrDirWC.x;
      const wy = L.posOrDirWC.y;
      const wz = L.posOrDirWC.z;
      const ww = isDir ? 0.0 : 1.0;
      const ex = m[0] * wx + m[4] * wy + m[8] * wz + m[12] * ww;
      const ey = m[1] * wx + m[5] * wy + m[9] * wz + m[13] * ww;
      const ez = m[2] * wx + m[6] * wy + m[10] * wz + m[14] * ww;

      const slot = this._scratchEyeLights[outIndex];
      slot.type = L.lightType;
      slot.posOrDir.x = ex;
      slot.posOrDir.y = ey;
      slot.posOrDir.z = ez;
      const c = L.color;
      slot.color.r = c.r ?? c.red ?? 1;
      slot.color.g = c.g ?? c.green ?? 1;
      slot.color.b = c.b ?? c.blue ?? 1;
      slot.intensity = L.intensity ?? 1;
      slot.range = L.range ?? 0;
      slot.innerConeAngle = L.innerConeAngle ?? 0;
      slot.outerConeAngle = L.outerConeAngle ?? 0;

      if (L.lightType === 2 && L.spotDirWC) {
        // Spot direction is a direction (w=0).
        const sx = L.spotDirWC.x;
        const sy = L.spotDirWC.y;
        const sz = L.spotDirWC.z;
        slot.spotDir = slot.spotDir ?? { x: 0, y: 0, z: 0 };
        slot.spotDir.x = m[0] * sx + m[4] * sy + m[8] * sz;
        slot.spotDir.y = m[1] * sx + m[5] * sy + m[9] * sz;
        slot.spotDir.z = m[2] * sx + m[6] * sy + m[10] * sz;
      } else if (slot.spotDir) {
        slot.spotDir.x = 0;
        slot.spotDir.y = 0;
        slot.spotDir.z = 0;
      }

      outIndex++;
    }

    return outIndex;
  }

  destroy(): void {
    this._bounds.destroy();
    this._assign.destroy();
    this._paramsBuffer.destroy();
  }
}

export default WebGPUClusteredLightingDispatcher;
