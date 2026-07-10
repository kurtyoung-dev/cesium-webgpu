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
 *    view change, OR when the bounds pass re-dispatched — the
 *    assignment reads the AABBs, so a stationary-camera resize/FOV
 *    that only moves the bounds must still re-run assign; A7.2).
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
import { getLTCLUTBytes, LTC_LUT_SIZE } from "./WebGPULTCLUTData.js";

// Uniform buffer holds ClusteredParams: 2 vec4 = 32 bytes. Padded to
// 256-byte minimum alignment.
const PARAMS_UNIFORM_BYTES = 256;

// LTC analytic area lights (C6-LTC-AREA-LIGHTS). WebGPU-only, opt-in.
// A parallel storage buffer beside the clustered punctual path — NOT
// clustered in v1 (iterated directly in the FS, gated on
// activeLightCount.y). Struct stride 96 B = 6 vec4 = 24 floats.
const MAX_AREA_LIGHTS = 8;
const AREA_LIGHT_FLOATS = 24; // 6 vec4
const AREA_LIGHT_STRIDE_BYTES = AREA_LIGHT_FLOATS * 4; // 96
const AREA_LIGHTS_BUFFER_BYTES = MAX_AREA_LIGHTS * AREA_LIGHT_STRIDE_BYTES; // 768

/** Area-light type tags — match LightType.RECT_AREA / DISK_AREA. */
const AREA_LIGHT_TYPE_RECT = 3;
const AREA_LIGHT_TYPE_DISK = 4;

/**
 * World-space area-light entry consumed by the dispatcher. The
 * SceneRenderer hook normalizes `RectAreaLight` / `DiskAreaLight` into
 * this shape.
 */
export interface ClusterAreaLightInput {
  /** 3 = rect, 4 = disk (LightType.RECT_AREA / DISK_AREA). */
  lightType: number;
  positionWC: { x: number; y: number; z: number };
  /** Emitter normal (world). */
  directionWC: { x: number; y: number; z: number };
  /** Local up axis (world). */
  upWC: { x: number; y: number; z: number };
  /** Half-width (rect) or radiusX (disk), meters. */
  halfWidth: number;
  /** Half-height (rect) or radiusY (disk), meters. */
  halfHeight: number;
  color: {
    red?: number;
    green?: number;
    blue?: number;
    r?: number;
    g?: number;
    b?: number;
  };
  intensity?: number;
  twoSided?: boolean;
  /** Cull radius (0 = never cull). */
  range?: number;
}

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
  /**
   * Active area lights this frame (world-space). Empty/undefined ⇒ the
   * LTC area-light path stays inert (areaLightCount = 0, FS early-out).
   * C6-LTC-AREA-LIGHTS.
   */
  areaLights?: ReadonlyArray<ClusterAreaLightInput>;
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

  // ── LTC area lights (C6-LTC-AREA-LIGHTS) ──
  private readonly _areaLightsBuffer: GPUBuffer;
  private readonly _areaLightsData: Float32Array;
  private _lastAreaLightCount: number = 0;
  /** LUT texture is created lazily the first time an area light appears. */
  private _ltcTexture: GPUTexture | null = null;
  private _ltcView: GPUTextureView | null = null;

  constructor(device: GPUDevice) {
    this._device = device;
    this._bounds = new WebGPUClusterBoundsRenderer(device);
    this._assign = new WebGPUClusterAssignRenderer(device);
    // Area-light storage buffer — allocated up front (768 B, trivial),
    // zero-filled so a frame with no area lights reads cleanly.
    this._areaLightsBuffer = device.createBuffer({
      label: "LTC area lights",
      size: AREA_LIGHTS_BUFFER_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this._areaLightsData = new Float32Array(
      MAX_AREA_LIGHTS * AREA_LIGHT_FLOATS,
    );
    device.queue.writeBuffer(
      this._areaLightsBuffer,
      0,
      new Uint8Array(AREA_LIGHTS_BUFFER_BYTES),
    );
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

  // ── LTC area-light public handles (C6-LTC-AREA-LIGHTS) ──

  /** Storage buffer of packed eye-space LTCAreaLight records (768 B). */
  get areaLightsBuffer(): GPUBuffer {
    return this._areaLightsBuffer;
  }

  /**
   * The 64×64×2 rgba16float LTC LUT array texture view. Created lazily
   * the first time an area light is packed. Returns null before then —
   * callers fall back to the per-device placeholder LUT.
   */
  get ltcLUTView(): GPUTextureView | null {
    return this._ltcView;
  }

  /** Most recent packed area-light count. */
  get lastAreaLightCount(): number {
    return this._lastAreaLightCount;
  }

  /**
   * Create the LTC LUT array texture + sampler on first use. Two 64×64
   * rgba16float layers uploaded from the embedded fp16 payloads
   * (layer 0 = M⁻¹ terms, layer 1 = magnitude/Fresnel/sphere).
   */
  private _ensureLTCLUT(): void {
    if (this._ltcTexture) {
      return;
    }
    const device = this._device;
    const size = LTC_LUT_SIZE;
    const tex = device.createTexture({
      label: "LTC LUT (64x64x2 rgba16float)",
      size: { width: size, height: size, depthOrArrayLayers: 2 },
      format: "rgba16float",
      dimension: "2d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const bytes = getLTCLUTBytes();
    // 8 bytes per texel (rgba16float). writeTexture has no 256-byte
    // bytesPerRow alignment requirement.
    device.queue.writeTexture(
      { texture: tex },
      bytes,
      { bytesPerRow: size * 8, rowsPerImage: size },
      { width: size, height: size, depthOrArrayLayers: 2 },
    );
    this._ltcTexture = tex;
    this._ltcView = tex.createView({ dimension: "2d-array" });
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
    let areaCount = 0;
    if (inputs.enabled) {
      activeCount = this._packEyeSpaceLights(inputs.lights, inputs.viewMatrix);
      if (inputs.areaLights && inputs.areaLights.length > 0) {
        areaCount = this._packAreaLights(inputs.areaLights, inputs.viewMatrix);
      }
    }
    this._lastAreaLightCount = areaCount;

    // Update the params uniform first so consumer FS sees the right
    // activeLightCount even when we skip the compute dispatches.
    // .x = punctual clustered count (Batch 149 gate); .y = area-light
    // count (C6-LTC-AREA-LIGHTS gate — was documented-unused).
    const data = this._paramsData;
    data[0] = inputs.viewportWidth;
    data[1] = inputs.viewportHeight;
    data[2] = inputs.near;
    data[3] = inputs.far;
    // activeLightCount vec4 starts at data[4]: .x=data[4], .y=data[5],
    // .z=data[6], .w=data[7].
    data[4] = activeCount; // .x — clustered punctual gate (Batch 149 FS)
    data[5] = areaCount; // .y — LTC area-light gate (C6-LTC-AREA-LIGHTS FS)
    data[6] = 0;
    data[7] = 0;
    this._device.queue.writeBuffer(this._paramsBuffer, 0, data);

    if (activeCount === 0) {
      this._lastActiveLightCount = 0;
      return 0;
    }

    // Dispatch both compute passes. The bounds pass reports whether it
    // re-dispatched (viewport / FOV / near-far changed); that signal is
    // threaded into the assign pass so it re-runs even when the lights +
    // view are unchanged — otherwise a stationary-camera resize/FOV
    // leaves the per-cluster assignment bound to the stale AABBs
    // (A7.2 — Q10 CLUSTERED-ASSIGN-BOUNDS-DIRTY).
    const boundsChanged = this._bounds.dispatch(
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
      boundsChanged,
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

  /**
   * Transform world-space area lights to eye-space, pack into the
   * LTCAreaLight storage layout, upload, and ensure the LUT texture
   * exists. Returns the number packed (≤ MAX_AREA_LIGHTS).
   *
   * Per-record layout (24 floats):
   *   [0..3]   centerEC.xyz, lightType
   *   [4..7]   color.rgb, intensity
   *   [8..11]  axisXEC.xyz (half-width vector), halfWidth
   *   [12..15] axisYEC.xyz (half-height vector), halfHeight
   *   [16..19] twoSided, cullRadius, reserved, reserved
   *   [20..23] reserved (textured-emitter follow-up)
   *
   * Axes are transformed as directions (w=0); center as a position
   * (w=1) — same eye-space convention as the punctual pack.
   */
  private _packAreaLights(
    areaLights: ReadonlyArray<ClusterAreaLightInput>,
    viewMatrix: ArrayLike<number>,
  ): number {
    const m = viewMatrix;
    const cap = Math.min(areaLights.length, MAX_AREA_LIGHTS);
    const data = this._areaLightsData;
    data.fill(0);

    let out = 0;
    for (let i = 0; i < cap; i++) {
      const L = areaLights[i];

      // Build an orthonormal frame in world space: normal (n), right (x),
      // up (y). right = normalize(cross(n, up)); reorthogonalize up.
      let nx = L.directionWC.x;
      let ny = L.directionWC.y;
      let nz = L.directionWC.z;
      let nl = Math.hypot(nx, ny, nz) || 1.0;
      nx /= nl;
      ny /= nl;
      nz /= nl;

      let ux = L.upWC.x;
      let uy = L.upWC.y;
      let uz = L.upWC.z;
      // right = cross(n, up)
      let rx = ny * uz - nz * uy;
      let ry = nz * ux - nx * uz;
      let rz = nx * uy - ny * ux;
      let rl = Math.hypot(rx, ry, rz);
      if (rl < 1e-6) {
        // up parallel to normal — pick an arbitrary perpendicular.
        if (Math.abs(nx) < 0.9) {
          rx = 0;
          ry = nz;
          rz = -ny;
        } else {
          rx = -nz;
          ry = 0;
          rz = nx;
        }
        rl = Math.hypot(rx, ry, rz) || 1.0;
      }
      rx /= rl;
      ry /= rl;
      rz /= rl;
      // reorthogonalized up = cross(right, n)
      ux = ry * nz - rz * ny;
      uy = rz * nx - rx * nz;
      uz = rx * ny - ry * nx;

      const hw = Math.max(L.halfWidth, 1e-4);
      const hh = Math.max(L.halfHeight, 1e-4);
      // Half-extent axis vectors in world space.
      const axWx = rx * hw;
      const axWy = ry * hw;
      const axWz = rz * hw;
      const ayWx = ux * hh;
      const ayWy = uy * hh;
      const ayWz = uz * hh;

      // Transform center (w=1) + axes (w=0) into eye-space.
      const cex =
        m[0] * L.positionWC.x +
        m[4] * L.positionWC.y +
        m[8] * L.positionWC.z +
        m[12];
      const cey =
        m[1] * L.positionWC.x +
        m[5] * L.positionWC.y +
        m[9] * L.positionWC.z +
        m[13];
      const cez =
        m[2] * L.positionWC.x +
        m[6] * L.positionWC.y +
        m[10] * L.positionWC.z +
        m[14];
      const axex = m[0] * axWx + m[4] * axWy + m[8] * axWz;
      const axey = m[1] * axWx + m[5] * axWy + m[9] * axWz;
      const axez = m[2] * axWx + m[6] * axWy + m[10] * axWz;
      const ayex = m[0] * ayWx + m[4] * ayWy + m[8] * ayWz;
      const ayey = m[1] * ayWx + m[5] * ayWy + m[9] * ayWz;
      const ayez = m[2] * ayWx + m[6] * ayWy + m[10] * ayWz;

      const c = L.color;
      const base = out * AREA_LIGHT_FLOATS;
      const lightType =
        L.lightType === AREA_LIGHT_TYPE_DISK
          ? AREA_LIGHT_TYPE_DISK
          : AREA_LIGHT_TYPE_RECT;
      data[base + 0] = cex;
      data[base + 1] = cey;
      data[base + 2] = cez;
      data[base + 3] = lightType;
      data[base + 4] = c.r ?? c.red ?? 1;
      data[base + 5] = c.g ?? c.green ?? 1;
      data[base + 6] = c.b ?? c.blue ?? 1;
      data[base + 7] = L.intensity ?? 1;
      data[base + 8] = axex;
      data[base + 9] = axey;
      data[base + 10] = axez;
      data[base + 11] = hw;
      data[base + 12] = ayex;
      data[base + 13] = ayey;
      data[base + 14] = ayez;
      data[base + 15] = hh;
      data[base + 16] = L.twoSided ? 1 : 0;
      data[base + 17] = L.range ?? 0;
      out++;
    }

    if (out > 0) {
      this._ensureLTCLUT();
      this._device.queue.writeBuffer(
        this._areaLightsBuffer,
        0,
        this._areaLightsData,
        0,
        out * AREA_LIGHT_FLOATS,
      );
    }
    return out;
  }

  destroy(): void {
    this._bounds.destroy();
    this._assign.destroy();
    this._paramsBuffer.destroy();
    this._areaLightsBuffer.destroy();
    this._ltcTexture?.destroy();
    this._ltcTexture = null;
    this._ltcView = null;
  }
}

export default WebGPUClusteredLightingDispatcher;
