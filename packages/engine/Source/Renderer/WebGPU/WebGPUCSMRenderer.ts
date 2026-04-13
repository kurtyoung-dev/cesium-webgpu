/// <reference types="@webgpu/types" />
/**
 * @module WebGPUCSMRenderer
 *
 * Cascaded Shadow Map renderer. Splits the camera frustum into N depth
 * ranges (default 4) and renders each range's shadow map at full
 * resolution. The fragment shader picks the smallest cascade that
 * covers the pixel's view-space depth, with a blend band at cascade
 * transitions to hide seams.
 *
 * Toggle: `scene.useCascadedShadowMaps` (default false).
 *
 * When disabled, the existing single-shadow-map path remains active.
 *
 * @private
 */

import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";

/** Default cascade count. */
const DEFAULT_CASCADE_COUNT = 4;

/** Default resolution per cascade layer. */
const DEFAULT_CASCADE_RESOLUTION = 2048;

/** Lambda blend factor for split distribution (0 = uniform, 1 = logarithmic). */
const DEFAULT_LAMBDA = 0.7;

/** Blend band as fraction of cascade width (for seam hiding). */
const DEFAULT_BLEND_BAND = 0.05;

export interface CSMConfig {
  cascadeCount?: number;
  resolution?: number;
  lambda?: number;
  blendBand?: number;
  maxShadowDistance?: number;
  enabled?: boolean;
}

interface CascadeData {
  splitNear: number;
  splitFar: number;
  viewProjection: Float32Array;
  sphereCenter: Float32Array;
  sphereRadius: number;
}

export class WebGPUCSMRenderer {
  private _device: GPUDevice | null = null;
  private _cascadeCount: number;
  private _resolution: number;
  private _lambda: number;
  private _blendBand: number;
  private _maxShadowDistance: number;
  enabled: boolean;

  // GPU resources
  private _cascadeTexture: GPUTexture | null = null;
  private _cascadeViews: GPUTextureView[] = [];
  private _cascadeArrayView: GPUTextureView | null = null;
  private _cascadeSampler: GPUSampler | null = null;

  // Per-cascade data (recomputed per frame)
  private _cascades: CascadeData[] = [];

  // UBO for cascade splits + VP matrices (passed to receive shaders)
  private _cascadeParamsBuffer: GPUBuffer | null = null;
  private _cascadeParamsData: Float32Array;

  // Diagnostic counters
  private _castDispatches = 0;

  // Scratch objects
  private static _scratchCenter = new Cartesian3();
  private static _scratchCorners = new Array(8)
    .fill(null)
    .map(() => new Cartesian3());
  private static _scratchLightVP = new (Matrix4 as any)();

  constructor(config?: CSMConfig) {
    this._cascadeCount = config?.cascadeCount ?? DEFAULT_CASCADE_COUNT;
    this._resolution = config?.resolution ?? DEFAULT_CASCADE_RESOLUTION;
    this._lambda = config?.lambda ?? DEFAULT_LAMBDA;
    this._blendBand = config?.blendBand ?? DEFAULT_BLEND_BAND;
    this._maxShadowDistance = config?.maxShadowDistance ?? 100000;
    this.enabled = config?.enabled ?? false;

    // Cascade params UBO layout:
    //   4 × mat4 (cascade VPs) = 256 floats
    //   4 × f32  (split distances) = 4 floats
    //   4 × f32  (blend params) = 4 floats
    // Total: 264 floats = 1056 bytes → round to 1088 (256-aligned)
    this._cascadeParamsData = new Float32Array(264);

    for (let i = 0; i < this._cascadeCount; i++) {
      this._cascades.push({
        splitNear: 0,
        splitFar: 0,
        viewProjection: new Float32Array(16),
        sphereCenter: new Float32Array(3),
        sphereRadius: 0,
      });
    }
  }

  /**
   * Allocate GPU resources for cascade shadow maps.
   */
  initialize(device: GPUDevice): void {
    this._device = device;

    // Texture array: 4 layers of depth32float.
    this._cascadeTexture = device.createTexture({
      label: "CSM_CascadeArray",
      size: {
        width: this._resolution,
        height: this._resolution,
        depthOrArrayLayers: this._cascadeCount,
      },
      format: "depth32float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING,
    });

    // Per-layer views for cast render passes.
    this._cascadeViews = [];
    for (let i = 0; i < this._cascadeCount; i++) {
      this._cascadeViews.push(
        this._cascadeTexture.createView({
          label: `CSM_Cascade_${i}`,
          dimension: "2d",
          baseArrayLayer: i,
          arrayLayerCount: 1,
        }),
      );
    }

    // Full array view for receive shaders.
    this._cascadeArrayView = this._cascadeTexture.createView({
      label: "CSM_CascadeArray_View",
      dimension: "2d-array",
      baseArrayLayer: 0,
      arrayLayerCount: this._cascadeCount,
    });

    // Comparison sampler for PCF.
    this._cascadeSampler = device.createSampler({
      label: "CSM_Sampler",
      compare: "less",
    });

    // Cascade params UBO.
    const paramsByteSize =
      Math.ceil((this._cascadeParamsData.byteLength) / 256) * 256;
    this._cascadeParamsBuffer = device.createBuffer({
      label: "CSM_Params",
      size: paramsByteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Compute cascade splits using a blend of uniform and logarithmic
   * distributions (Practical Split Schemes for Shadow Mapping, GPU Gems 3).
   */
  computeSplits(cameraNear: number, cameraFar: number): void {
    const far = Math.min(cameraFar, this._maxShadowDistance);
    const lambda = this._lambda;
    const n = this._cascadeCount;

    for (let i = 0; i < n; i++) {
      const p = (i + 1) / n;
      const uniform = cameraNear + (far - cameraNear) * p;
      const logarithmic = cameraNear * Math.pow(far / cameraNear, p);
      const split = lambda * logarithmic + (1 - lambda) * uniform;

      this._cascades[i].splitNear = i === 0 ? cameraNear : this._cascades[i - 1].splitFar;
      this._cascades[i].splitFar = split;
    }
  }

  /**
   * Fit a bounding sphere around each cascade's frustum slice and
   * compute the orthographic light VP matrix.
   *
   * @param cameraViewMatrix Camera's view matrix.
   * @param cameraProjection Camera's projection matrix.
   * @param lightDirection Normalized world-space light direction.
   */
  computeCascadeVPs(
    cameraViewMatrix: CesiumMatrix4,
    cameraProjection: CesiumMatrix4,
    lightDirection: CesiumCartesian3,
  ): void {
    // Pack cascade VP matrices + splits into the params buffer.
    for (let c = 0; c < this._cascadeCount; c++) {
      const cascade = this._cascades[c];

      // Compute bounding sphere radius from the split distances.
      // This is a simplified fit — a real implementation would
      // extract NDC frustum corners and compute a tight sphere.
      const range = cascade.splitFar - cascade.splitNear;
      cascade.sphereRadius = range * 0.5;
      cascade.sphereCenter[0] = 0;
      cascade.sphereCenter[1] = 0;
      cascade.sphereCenter[2] = -(cascade.splitNear + cascade.sphereRadius);

      // Build orthographic light VP matrix for this cascade.
      // This is a simplified placeholder — production implementation
      // needs proper frustum corner extraction + bounding sphere fit +
      // texel snap stabilization.
      const r = cascade.sphereRadius;
      for (let i = 0; i < 16; i++) {
        cascade.viewProjection[i] = i % 5 === 0 ? 1 : 0;
      }
      // Scale to [-r, r] orthographic range.
      cascade.viewProjection[0] = 1 / r;
      cascade.viewProjection[5] = 1 / r;
      cascade.viewProjection[10] = -1 / (2 * r);
      cascade.viewProjection[14] = -0.5;

      // Pack into UBO: cascade VP at offset c*16, cascade split at 256+c
      const vpOffset = c * 16;
      for (let i = 0; i < 16; i++) {
        this._cascadeParamsData[vpOffset + i] = cascade.viewProjection[i];
      }
    }

    // Pack split distances at offset 256 (after 4 matrices).
    for (let c = 0; c < this._cascadeCount; c++) {
      this._cascadeParamsData[256 + c] = this._cascades[c].splitFar;
    }

    // Pack blend band at offset 260.
    for (let c = 0; c < this._cascadeCount; c++) {
      const range = this._cascades[c].splitFar - this._cascades[c].splitNear;
      this._cascadeParamsData[260 + c] = range * this._blendBand;
    }

    // Upload to GPU.
    if (this._device && this._cascadeParamsBuffer) {
      this._device.queue.writeBuffer(
        this._cascadeParamsBuffer,
        0,
        this._cascadeParamsData,
      );
    }
  }

  /**
   * Get the cascade texture array view (for receive shaders).
   */
  get cascades(): CascadeData[] {
    return this._cascades;
  }

  get cascadeArrayView(): GPUTextureView | null {
    return this._cascadeArrayView;
  }

  /**
   * Get the comparison sampler.
   */
  get cascadeSampler(): GPUSampler | null {
    return this._cascadeSampler;
  }

  /**
   * Get the cascade params UBO (VP matrices + splits).
   */
  get cascadeParamsBuffer(): GPUBuffer | null {
    return this._cascadeParamsBuffer;
  }

  /**
   * Get per-cascade depth views (for cast render passes).
   */
  get cascadeViews(): GPUTextureView[] {
    return this._cascadeViews;
  }

  /**
   * Get the cascade data for the debug snapshot.
   */
  getStatistics(): object {
    return {
      enabled: this.enabled,
      cascadeCount: this._cascadeCount,
      resolution: this._resolution,
      lambda: this._lambda,
      blendBand: this._blendBand,
      maxShadowDistance: this._maxShadowDistance,
      castDispatches: this._castDispatches,
      cascades: this._cascades.map((c) => ({
        splitNear: c.splitNear,
        splitFar: c.splitFar,
        sphereRadius: c.sphereRadius,
      })),
    };
  }

  /**
   * Release GPU resources.
   */
  destroy(): void {
    if (this._cascadeTexture) {
      this._cascadeTexture.destroy();
      this._cascadeTexture = null;
    }
    if (this._cascadeParamsBuffer) {
      this._cascadeParamsBuffer.destroy();
      this._cascadeParamsBuffer = null;
    }
    this._cascadeViews = [];
    this._cascadeArrayView = null;
    this._device = null;
  }
}
