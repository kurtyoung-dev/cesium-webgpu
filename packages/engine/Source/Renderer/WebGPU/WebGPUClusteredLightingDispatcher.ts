/// <reference types="@webgpu/types" />
/**
 * Per-frame orchestration for WebGPU Forward+ clustered lighting.
 *
 * The dispatcher accepts caller-selected world-space punctual and area lights,
 * transforms them to eye space, and writes resources exposed through the
 * shared effects bind group. Punctual lights run through the cluster-bounds and
 * cluster-assignment compute passes. Area lights use a parallel storage buffer
 * and are iterated directly by the fragment shader.
 *
 * Cluster bounds are recomputed when the viewport, near or far plane, or
 * projection changes. Assignment is recomputed when its light checksum changes
 * or when new bounds invalidate the existing bins. A bounds change must reach
 * the assignment pass even for a stationary camera because the assignment
 * reads the bounds buffer.
 *
 * Disabled and empty punctual-light frames skip both compute passes. The
 * parameter uniform carries zero active counts, so consumers return before
 * reading stale storage contents. Keeping the resources and effects layout
 * fixed avoids pipeline variants when lighting is toggled.
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

// Area lights use a parallel storage buffer rather than the punctual cluster
// lists. The fragment shader iterates up to eight records when
// `activeLightCount.y` is nonzero. Each record is 6 vec4, or 96 bytes.
const MAX_AREA_LIGHTS = 8;
const AREA_LIGHT_FLOATS = 24; // 6 vec4
const AREA_LIGHT_STRIDE_BYTES = AREA_LIGHT_FLOATS * 4; // 96
const AREA_LIGHTS_BUFFER_BYTES = MAX_AREA_LIGHTS * AREA_LIGHT_STRIDE_BYTES; // 768

/** Area-light type tags — match LightType.RECT_AREA / DISK_AREA. */
const AREA_LIGHT_TYPE_RECT = 3;
const AREA_LIGHT_TYPE_DISK = 4;

/**
 * World-space area-light entry consumed by the dispatcher. The scene renderer
 * normalizes `RectAreaLight` and `DiskAreaLight` instances into this shape.
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
 * World-space punctual-light entry consumed by the dispatcher. The caller
 * selects and normalizes the active light sources before dispatch.
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
  /** Active world-space punctual lights selected by the caller. */
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
   * Active world-space area lights. An empty or undefined list leaves
   * `activeLightCount.y` at zero, so the fragment shader skips LTC evaluation.
   */
  areaLights?: ReadonlyArray<ClusterAreaLightInput>;
}

export class WebGPUClusteredLightingDispatcher {
  private readonly _device: GPUDevice;

  /**
   * The device this dispatcher captured at construction. Exposed so the
   * SceneRenderer's cached reference can be told apart from one left behind by
   * a device-loss recovery, which reuses the SceneRenderer instance.
   */
  get device(): GPUDevice {
    return this._device;
  }
  private readonly _bounds: WebGPUClusterBoundsRenderer;
  private readonly _assign: WebGPUClusterAssignRenderer;
  private readonly _paramsBuffer: GPUBuffer;
  private readonly _paramsData: Float32Array;
  /** Scratch — reused each dispatch to avoid GC. */
  private readonly _scratchEyeLights: ClusteredLightDef[] = [];
  private _lastActiveLightCount: number = 0;
  private _lastWrittenActiveLightCount: number = 0;

  private readonly _areaLightsBuffer: GPUBuffer;
  private readonly _areaLightsData: Float32Array;
  private _lastAreaLightCount: number = 0;
  private _lastWrittenAreaLightCount: number = 0;
  /** LUT texture is created lazily the first time an area light appears. */
  private _ltcTexture: GPUTexture | null = null;
  private _ltcView: GPUTextureView | null = null;

  constructor(device: GPUDevice) {
    this._device = device;
    this._bounds = new WebGPUClusterBoundsRenderer(device);
    this._assign = new WebGPUClusterAssignRenderer(device);
    // Allocate the 768-byte area-light buffer up front so its identity remains
    // stable; zero initialization keeps inactive records deterministic.
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
      // COPY_SRC permits asynchronous diagnostic readback of the parameter
      // uniform.
      usage:
        GPUBufferUsage.UNIFORM |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
    this._paramsData = new Float32Array(8); // 2 vec4 of actual content
    // Zero active counts gate both fragment-lighting paths.
    this._paramsData[5] = 0;
    device.queue.writeBuffer(this._paramsBuffer, 0, this._paramsData);
  }

  /**
   * Handles used to populate clustered-lighting entries in the shared effects
   * bind group. They exist for the dispatcher's lifetime, and zero active
   * counts gate reads before the first dispatch.
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

  /** Whether the params buffer's last-written light counts were both zero. */
  get paramsAreAllZero(): boolean {
    return (
      this._lastWrittenActiveLightCount === 0 &&
      this._lastWrittenAreaLightCount === 0
    );
  }

  /**
   * Create the LTC LUT array texture on first use. The two 64×64
   * `rgba16float` layers contain the inverse-matrix terms and the
   * magnitude, Fresnel, and sphere terms.
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
   * Lazily built group-4 compatibility bind group. Its buffer identities do
   * not change between frames, so one instance is reused for the dispatcher's
   * lifetime. Current consumer pipelines bind these resources through the
   * shared effects group and do not read this getter.
   *
   * `getClusteredLightingBGL(device)` supplies the per-device cached layout.
   */
  private _consumerBindGroup: GPUBindGroup | null = null;
  get consumerBindGroup(): GPUBindGroup {
    if (!this._consumerBindGroup) {
      // Ensure the compatibility layout is cached before building the group.
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
   * (clamped to `CLUSTER_MAX_LIGHTS`). A return value of zero means no
   * punctual-light compute passes were issued; area lights may still have
   * been packed and evaluated.
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

    // Eliding the write also freezes the viewport and near/far slots at their
    // last written values — zeros on a dispatcher that has never packed a
    // light. Every consumer reads those slots only after the active-light
    // count gate, so keep that gate if the params layout grows.
    const redundantZeroParams =
      activeCount === 0 &&
      areaCount === 0 &&
      this._lastWrittenActiveLightCount === 0 &&
      this._lastWrittenAreaLightCount === 0;
    if (redundantZeroParams) {
      this._lastActiveLightCount = 0;
      return 0;
    }

    // Update the params uniform before compute work so consumers see the new
    // counts even when no compute pass is needed.
    // `activeLightCount.x` gates punctual clustered lights, and `.y` gates
    // analytic area lights. The remaining lanes are reserved.
    const data = this._paramsData;
    data[0] = inputs.viewportWidth;
    data[1] = inputs.viewportHeight;
    data[2] = inputs.near;
    data[3] = inputs.far;
    // activeLightCount vec4 starts at data[4]: .x=data[4], .y=data[5],
    // .z=data[6], .w=data[7].
    data[4] = activeCount; // .x — clustered punctual-light gate
    data[5] = areaCount; // .y — analytic area-light gate
    data[6] = 0;
    data[7] = 0;
    this._device.queue.writeBuffer(this._paramsBuffer, 0, data);
    this._lastWrittenActiveLightCount = activeCount;
    this._lastWrittenAreaLightCount = areaCount;

    if (activeCount === 0) {
      this._lastActiveLightCount = 0;
      return 0;
    }

    // Thread the bounds pass's change signal into assignment. A viewport,
    // projection, or near/far change makes the previous bins stale even when
    // the eye-space light data is unchanged.
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
   *   [20..23] reserved
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
