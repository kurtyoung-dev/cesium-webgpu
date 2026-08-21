/// <reference types="@webgpu/types" />
/**
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
 * @module WebGPUCSMRenderer
 */

import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import defined from "../../Core/defined.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import { renderCSMCastPass } from "./WebGPUCSMCastPass.js";
import type { DebugStatsObject } from "../GraphicsContext.js";

// Re-declare the Matrix4 and Cartesian3 shapes so this file is independent of
// ambient Cesium globals, which are absent from some consumers. Their fields
// match Cesium's Core/Matrix4 and Core/Cartesian3.
type CesiumMatrix4 = number[] | Float64Array | Float32Array;
type CesiumCartesian3 = { x: number; y: number; z: number };

/** Default cascade count. */
const DEFAULT_CASCADE_COUNT = 4;

/**
 * Default resolution per cascade layer. 1024 balances quality and VRAM:
 * 1024² × 4 layers × 4B (depth32float) = 16 MB, vs 64 MB at 2048.
 * Mobile / integrated-GPU users can drop to 512 (4 MB). High-end
 * desktop setups can push to 2048 or 4096 when the artifact budget
 * demands sharper cascade-3 shadows. Set via `scene.useCascadedShadowMaps`
 * → constructed through `WebGPUContext._initCSMRenderer`, which passes
 * through the `resolution` field from `scene.cascadedShadowMapResolution`
 * when supplied.
 */
const DEFAULT_CASCADE_RESOLUTION = 1024;
const MIN_CASCADE_RESOLUTION = 256;
const MAX_CASCADE_RESOLUTION = 4096;

/** Lambda for split distribution: 0 is uniform and 1 is logarithmic. */
const DEFAULT_LAMBDA = 0.7;

/** Blend band as fraction of cascade width (for seam hiding). */
const DEFAULT_BLEND_BAND = 0.05;

/**
 * Default WGS84 ellipsoid radii in metres. The ground-clamp pass in
 * `_computeFrustumCornersWorldSpace` places each cascade's near and far
 * corners on the corresponding view-ray intersections with the globe. This
 * prevents a low top-down camera from fitting a multi-kilometre bounding
 * sphere to empty frustum volume and keeps the near cascade below one metre
 * per texel. Inverse-square radii are precomputed for the closed-form
 * ray/ellipsoid solve.
 *
 * These are defaults rather than fixed inputs.
 * `WebGPUContext.executeShadowMapCastCommands` supplies the scene ellipsoid
 * through {@link WebGPUCSMRenderer.setEllipsoid}, so non-Earth globes clamp
 * against their own surface. A WGS84 scene uses these exact values.
 */
const WGS84_RADII_X = 6378137.0;
const WGS84_RADII_Y = 6378137.0;
const WGS84_RADII_Z = 6356752.314245179;
const WGS84_ONE_OVER_RADII_SQ_X = 1.0 / (WGS84_RADII_X * WGS84_RADII_X);
const WGS84_ONE_OVER_RADII_SQ_Y = 1.0 / (WGS84_RADII_Y * WGS84_RADII_Y);
const WGS84_ONE_OVER_RADII_SQ_Z = 1.0 / (WGS84_RADII_Z * WGS84_RADII_Z);

/**
 * Closed-form parameter of the first ray/ellipsoid intersection for `origin`
 * and `dir` in world (ECEF) coordinates. The parameter is a distance when
 * `dir` is unit length. Returns the positive entry value, or `Infinity` when
 * the ray misses the ellipsoid. The calculation uses FP64 because squaring
 * Earth-scale ECEF coordinates in single precision loses the discriminant.
 * It scalarizes the quadratic from `IntersectionTests.rayEllipsoid` to avoid
 * four sets of `Ray`, `Cartesian3`, and `Interval` allocations per cascade.
 * Explicit inverse-square radii keep the solve aligned with the scene
 * ellipsoid supplied through `setEllipsoid`.
 */
function _rayEllipsoidEntryDistance(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  invRadiiSqX: number = WGS84_ONE_OVER_RADII_SQ_X,
  invRadiiSqY: number = WGS84_ONE_OVER_RADII_SQ_Y,
  invRadiiSqZ: number = WGS84_ONE_OVER_RADII_SQ_Z,
): number {
  // Scale into the unit-sphere frame where the ellipsoid becomes a sphere.
  const oxs = ox * ox * invRadiiSqX;
  const oys = oy * oy * invRadiiSqY;
  const ozs = oz * oz * invRadiiSqZ;
  const odd =
    ox * dx * invRadiiSqX + oy * dy * invRadiiSqY + oz * dz * invRadiiSqZ;
  const ddd =
    dx * dx * invRadiiSqX + dy * dy * invRadiiSqY + dz * dz * invRadiiSqZ;

  const a = ddd;
  const b = 2.0 * odd;
  const c = oxs + oys + ozs - 1.0;
  const disc = b * b - 4.0 * a * c;
  if (a <= 0.0 || disc < 0.0) {
    return Infinity;
  }
  const sqrtDisc = Math.sqrt(disc);
  // Smaller root = entry point. Both roots share denominator 2a (>0).
  const t0 = (-b - sqrtDisc) / (2.0 * a);
  const t1 = (-b + sqrtDisc) / (2.0 * a);
  // Camera is above ground (c < 0 → inside) or outside. Take the nearest
  // intersection in front of the camera; ignore intersections behind it.
  if (t0 > 0.0) {
    return t0;
  }
  if (t1 > 0.0) {
    return t1;
  }
  return Infinity;
}

/**
 * Per-cascade cast UBO size. Matches `SHADOW_UNIFORM_SIZE` over in
 * WebGPUShadowMapRenderer.js (same struct layout: VP + RTE camera +
 * biases), but bumped to 128 bytes for alignment. Keeping the shape
 * identical lets CSM reuse the existing per-vertex-layout cast
 * pipelines without a second compile.
 */
export const CSM_CAST_UBO_SIZE = 128;

/**
 * Scene-wide terrain shadow controls shared by every cascade/tile draw.
 * The logical payload is one vec4: exaggeration, relative height, scene mode,
 * and padding. WebGPUBuffer rounds the physical uniform allocation up to the
 * device-required alignment, but only these 16 bytes are written/read.
 */
export const CSM_TERRAIN_GLOBALS_SIZE = 16;

/**
 * Scratch `EncodedCartesian3` reused across cast-pass invocations. It is
 * restricted to the single-threaded main-frame path because it is not
 * thread-safe.
 */
// EncodedCartesian3's `.d.ts` declares `high: Cartesian3; low: Cartesian3;`
// directly, so no cast is needed — this is just a scratch instance reused
// across frames to avoid per-frame allocation in the RTE encode path.
const _scratchEncodedCamera = new EncodedCartesian3();

/**
 * Scratch 3-vector reused across the cascade loop in `computeCascadeVPs`
 * to avoid per-frame allocation of the snapped center. FP64 because the
 * basis projection (center · side) at Earth scale involves 6.4M-scale
 * dot products that need the full precision to keep the snap bit-stable.
 */
const _scratchSnappedCenter = new Float64Array(3);

/**
 * Subset of `WebGPUCSMRenderer` that the cast-pass helper reads and writes.
 */
export interface CSMCastPassHost {
  _device: GPUDevice | null;
  _cascadeTexture: GPUTexture | null;
  _cascadeViews: GPUTextureView[];
  _cascadeCount: number;
  _cascades: {
    sphereRadius: number;
    sphereCenter: Float32Array | number[];
    viewProjectionRTE: Float32Array | number[];
  }[];
  _castDispatches: number;
  _shadowContentState: "uninitialized" | "casters" | "empty";
  _shadowContentFrame: number | undefined;
  _cascadeCastBuffers: GPUBuffer[] | null;
  _cascadeCastBufferData: Float32Array[] | null;
  _cascadeCastBindGroups: Map<string, GPUBindGroup>[] | null;
  _terrainGlobalsUB: WebGPUBuffer | null;
  _terrainGlobalsData: Float32Array;
  _sharedPipelineCache: {
    castPipelines: Map<
      string,
      {
        pipeline: GPURenderPipeline;
        bgl: GPUBindGroupLayout;
        cacheKey: string;
      }
    >;
  } | null;
  enabled: boolean;
  // Per-cascade GPU cull state, allocated lazily on first dispatch. The
  // sphere-AABB test deliberately over-includes rather than risking a missed
  // caster; see the `WebGPUCSMCastPass.ts` module documentation.
  _cascadeCullActive: boolean[];
  _cascadeCullLastResults: Array<{
    visibilityFlags: Uint32Array;
    objectCount: number;
  } | null>;
  _cascadeCullSoA: Array<{
    centerX: Float32Array;
    centerY: Float32Array;
    centerZ: Float32Array;
    radius: Float32Array;
    capacity: number;
    interleaved: Float32Array;
  } | null>;
  _cascadeCullFilterPool: Array<unknown[]>;
  _cascadeCullDispatches: number;
  _cascadeCullLastInput: number[];
  _cascadeCullLastFiltered: number[];
}

/**
 * Duck-typed shape of a cast-compatible draw command. It mirrors the fields
 * read by `WebGPUShadowMapRenderer.renderShadowCastPass` and avoids importing
 * the entire `WebGPUDrawCommand` type surface for one call site.
 */
export interface CastCommandShape {
  vertexBuffers?: ReadonlyArray<unknown>;
  _vertexBuffer?: unknown;
  vertexBuffer?: unknown;
  vertexStride?: number;
  _vertexStride?: number;
  indexBuffer?: unknown;
  _indexBuffer?: unknown;
  indexFormat?: GPUIndexFormat;
  _indexFormat?: GPUIndexFormat;
  indexCount?: number;
  _indexCount?: number;
  vertexCount?: number;
  _vertexCount?: number;
  instanceCount?: number;
  _shadowCastLayout?: string;
  _shadowCastTopology?: GPUPrimitiveTopology;
  // Strip casters require this companion to `_shadowCastTopology`.
  _shadowCastStripIndexFormat?: GPUIndexFormat;
  _shadowCastCullMode?: GPUCullMode;
  // `WebGPUModelRenderer` supplies per-command bindings when a variant
  // declares `extraBindings`; the CSM cast loop reads them through the
  // variant's `perCommandBindingFields` names.
  _shadowCastModelUB?: unknown;
  _shadowCastJointMatricesSB?: unknown;
  _shadowCastInstancingSB?: unknown;
  _shadowCastInstanceVB?: unknown;
  // Stable resource owner used when the draw command itself is rebuilt each
  // frame, as model commands are. Other families use command-local caching.
  _shadowCastBindGroupCacheHost?: Record<string, unknown>;
}

export interface CSMConfig {
  cascadeCount?: number;
  resolution?: number;
  lambda?: number;
  blendBand?: number;
  maxShadowDistance?: number;
  enabled?: boolean;
  // A 3×3 PCF box kernel softens cascade edges in the receive shaders,
  // matching the `czm_shadowVisibility` soft-shadow path. When false, the
  // receivers use one hardware-comparison tap. The default is true.
  softShadows?: boolean;
  // PCF kernel radius in shadow texels (only used when softShadows is
  // true). 1.5 mirrors the single-shadow-map soft path's radius.
  pcfRadius?: number;
}

// Default PCF kernel radius (shadow texels) when soft shadows are on.
// Matches the single-shadow-map path's `shadowMap.softShadows ? 1.5`
// convention in WebGPUEffectsBindGroup.js.
export const DEFAULT_CSM_PCF_RADIUS = 1.5;

interface CascadeData {
  splitNear: number;
  splitFar: number;
  // World-space light VP retained for diagnostic snapshots. Cast and receive
  // shaders consume only the RTE-aware form below.
  viewProjection: Float32Array;
  // RTE-aware light VP = VP_world * T(+cameraWC). Applied on the GPU as
  //   clipPos = VP_RTE * vec4<f32>(eyePos, 1.0)
  // where eyePos = (positionHigh - camHigh) + (positionLow - camLow).
  // This avoids the ~1m FP32 quantization that occurs when reconstructing
  // worldPos = positionHigh + positionLow at Earth scale (6.37M m radius).
  viewProjectionRTE: Float32Array;
  sphereCenter: Float32Array;
  sphereRadius: number;
}

// Base per-cascade depth-bias constants. Cascade 0 (tightest) gets the
// smallest bias; larger cascades scale with sphere-radius ratio so the
// NDC-depth bias tracks the cascade's world-space extent.
export const BASE_MIN_BIAS = 0.00005;
export const BASE_MAX_SLOPE_BIAS = 0.0005;

export class WebGPUCSMRenderer {
  // Public underscore shared with the cast-pass helper.
  public _device: GPUDevice | null = null;
  public _cascadeCount: number;
  private _resolution: number;
  private _lambda: number;
  private _blendBand: number;
  private _maxShadowDistance: number;
  enabled: boolean;
  // PCF radius in shadow texels, uploaded through `effects.csmControl.y`.
  // Zero selects a hard single tap.
  private _pcfRadius: number;

  // GPU resources
  public _cascadeTexture: GPUTexture | null = null;
  public _cascadeViews: GPUTextureView[] = [];
  private _cascadeArrayView: GPUTextureView | null = null;
  private _cascadeSampler: GPUSampler | null = null;

  // Per-cascade data (recomputed per frame)
  public _cascades: CascadeData[] = [];

  // UBO for cascade splits + VP matrices (passed to receive shaders)
  private _cascadeParamsBuffer: GPUBuffer | null = null;
  private _cascadeParamsData: Float32Array;

  // Diagnostic counters
  public _castDispatches = 0;

  // Cast-pass-specific lazy resources. Allocated on first cast pass
  // rather than in initialize() so scenes that toggle CSM on later
  // don't pay upfront.
  public _cascadeCastBuffers: GPUBuffer[] | null = null;
  public _cascadeCastBufferData: Float32Array[] | null = null;
  public _cascadeCastBindGroups: Map<string, GPUBindGroup>[] | null = null;
  // Both terrain cast variants consume one scene-wide vec4 at binding 2.
  // Keep it renderer-owned rather than command-owned so every tile/cascade
  // shares one stable buffer and therefore one cache identity.
  public _terrainGlobalsUB: WebGPUBuffer | null = null;
  public _terrainGlobalsData = new Float32Array(
    CSM_TERRAIN_GLOBALS_SIZE / Float32Array.BYTES_PER_ELEMENT,
  );
  public _shadowContentState: "uninitialized" | "casters" | "empty" =
    "uninitialized";
  /**
   * Frame number on which casters were last rendered into the cascade array.
   * Read by `shouldClearShadowCastTarget` so a caster-less re-entry on the
   * same frame cannot wipe depth that the color pass is about to sample.
   */
  public _shadowContentFrame: number | undefined = undefined;
  /**
   * Shared pipeline cache passed to the cross-module cast-pipeline
   * factory. Holds the compiled per-vertex-layout pipelines keyed by
   * layout name. Separate from `shadowMap._webgpuCache` so CSM and
   * single-shadow-map paths have independent caches.
   */
  public _sharedPipelineCache: {
    castPipelines: Map<
      string,
      {
        pipeline: GPURenderPipeline;
        bgl: GPUBindGroupLayout;
        cacheKey: string;
      }
    >;
  } | null = null;

  // Size each cascade's cull state lazily. The context owns culler instances,
  // while `WebGPUCSMCastPass` owns dispatch and prior-readback filtering.
  public _cascadeCullActive: boolean[] = [];
  public _cascadeCullLastResults: Array<{
    visibilityFlags: Uint32Array;
    objectCount: number;
  } | null> = [];
  public _cascadeCullSoA: Array<{
    centerX: Float32Array;
    centerY: Float32Array;
    centerZ: Float32Array;
    radius: Float32Array;
    capacity: number;
    // Pool the interleaved `(cx, cy, cz, r)` upload buffer alongside the SoA
    // arrays to avoid allocating a new `Float32Array` each frame. Both
    // representations share a capacity and resize in lockstep.
    interleaved: Float32Array;
  } | null> = [];
  public _cascadeCullFilterPool: Array<unknown[]> = [];
  public _cascadeCullDispatches: number = 0;
  public _cascadeCullLastInput: number[] = [];
  public _cascadeCullLastFiltered: number[] = [];

  // The cascade ground clamp uses the scene ellipsoid, with WGS84 defaults.
  // `WebGPUContext.executeShadowMapCastCommands` supplies it once per cast
  // frame, and `setEllipsoid` makes unchanged values a no-op.
  private _ellipsoidRadiiX = WGS84_RADII_X;
  private _ellipsoidRadiiY = WGS84_RADII_Y;
  private _ellipsoidRadiiZ = WGS84_RADII_Z;
  private _oneOverRadiiSqX = WGS84_ONE_OVER_RADII_SQ_X;
  private _oneOverRadiiSqY = WGS84_ONE_OVER_RADII_SQ_Y;
  private _oneOverRadiiSqZ = WGS84_ONE_OVER_RADII_SQ_Z;

  // Scratch objects
  private static _scratchCenter = new Cartesian3();
  private static _scratchCorners = new Array(8)
    .fill(null)
    .map(() => new Cartesian3());
  private static _scratchLightVP = new Matrix4();

  constructor(config?: CSMConfig) {
    this._cascadeCount = config?.cascadeCount ?? DEFAULT_CASCADE_COUNT;
    // Clamp the requested resolution into [MIN, MAX]. WebGPU does not require
    // power-of-two depth32float array dimensions, so preserve values such as
    // 1536 and round only fractional inputs down.
    const requested = config?.resolution ?? DEFAULT_CASCADE_RESOLUTION;
    this._resolution = Math.max(
      MIN_CASCADE_RESOLUTION,
      Math.min(MAX_CASCADE_RESOLUTION, Math.floor(requested)),
    );
    this._lambda = config?.lambda ?? DEFAULT_LAMBDA;
    this._blendBand = config?.blendBand ?? DEFAULT_BLEND_BAND;
    this._maxShadowDistance = config?.maxShadowDistance ?? 100000;
    this.enabled = config?.enabled ?? false;
    // Soft shadows default to the WebGL `czm_shadowVisibility` soft-shadow
    // path; a zero PCF radius selects a hard edge.
    const softShadows = config?.softShadows ?? true;
    this._pcfRadius = softShadows
      ? (config?.pcfRadius ?? DEFAULT_CSM_PCF_RADIUS)
      : 0.0;

    // Cascade params UBO layout (float offsets, each slot is 4 floats):
    //   4 × mat4x4<f32> cascade VP_RTE matrices = 64 floats  offset   0
    //   vec4<f32> cascadeSplits                 =  4 floats  offset  64
    //   vec4<f32> blendBands                    =  4 floats  offset  68
    //   vec4<f32> cascadeMinBias                =  4 floats  offset  72
    //   vec4<f32> cascadeMaxSlopeBias           =  4 floats  offset  76
    // WGSL struct size: 80 floats = 320 bytes.
    // Over-allocate the staging array to 272 floats (1088 bytes) to match
    // `CSM_PARAMS_PLACEHOLDER_BYTES`, the shared binding-10 size. The shader
    // does not read the unwritten bytes beyond 320. Because 1088 is not
    // 256-byte aligned, buffer creation below rounds it up to 1280 bytes.
    this._cascadeParamsData = new Float32Array(272);

    for (let i = 0; i < this._cascadeCount; i++) {
      this._cascades.push({
        splitNear: 0,
        splitFar: 0,
        viewProjection: new Float32Array(16),
        viewProjectionRTE: new Float32Array(16),
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
    this._shadowContentState = "uninitialized";
    this._shadowContentFrame = undefined;

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
        GPUTextureUsage.TEXTURE_BINDING |
        // COPY_SRC lets `debugReadCascadeDepth` inspect a texel. The extra
        // usage bit encodes no GPU work unless the debug path runs.
        GPUTextureUsage.COPY_SRC,
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
      Math.ceil(this._cascadeParamsData.byteLength / 256) * 256;
    this._cascadeParamsBuffer = device.createBuffer({
      label: "CSM_Params",
      size: paramsByteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._terrainGlobalsUB = WebGPUBuffer.createUniformBuffer(
      device,
      CSM_TERRAIN_GLOBALS_SIZE,
      "CSM_TerrainGlobals",
    );
  }

  /**
   * Set the ellipsoid used by the cascade ground clamp. Accepts the scene
   * ellipsoid's `radii` in metres; `undefined` or `null` selects WGS84, while
   * non-positive radii leave the last valid ellipsoid unchanged. Repeated
   * calls with the same radii exit before recomputing inverse-square values.
   */
  setEllipsoid(radii?: { x: number; y: number; z: number } | null): void {
    const x = radii?.x ?? WGS84_RADII_X;
    const y = radii?.y ?? WGS84_RADII_Y;
    const z = radii?.z ?? WGS84_RADII_Z;
    if (!(x > 0) || !(y > 0) || !(z > 0)) {
      // Degenerate radii (0/NaN) would poison the quadratic — keep the
      // last valid ellipsoid rather than divide by zero.
      return;
    }
    if (
      x === this._ellipsoidRadiiX &&
      y === this._ellipsoidRadiiY &&
      z === this._ellipsoidRadiiZ
    ) {
      return;
    }
    this._ellipsoidRadiiX = x;
    this._ellipsoidRadiiY = y;
    this._ellipsoidRadiiZ = z;
    this._oneOverRadiiSqX = 1.0 / (x * x);
    this._oneOverRadiiSqY = 1.0 / (y * y);
    this._oneOverRadiiSqZ = 1.0 / (z * z);
  }

  /**
   * Largest along-view distance where one of the camera frustum's four
   * far-edge rays intersects the scene ellipsoid. This bounds the visible
   * ground patch so `computeSplits` can distribute cascades across actual
   * receivers instead of all of `[near, maxShadowDistance]`. Returns
   * `Infinity` when every edge ray misses the globe, allowing
   * `maxShadowDistance` to remain the fallback. The maximum edge distance
   * keeps the whole visible ground inside the cascade set; per-corner clamps
   * then tighten each cascade's bounding sphere.
   */
  computeVisibleGroundFar(camera: {
    positionWC: CesiumCartesian3;
    directionWC: CesiumCartesian3;
    upWC: CesiumCartesian3;
    rightWC: CesiumCartesian3;
    frustum: { fovy?: number; aspectRatio?: number };
  }): number {
    const fovy = camera.frustum.fovy ?? Math.PI / 3;
    const aspect = camera.frustum.aspectRatio ?? 1;
    const tanHalfFovY = Math.tan(fovy * 0.5);
    const tanW = tanHalfFovY * aspect;
    const pos = camera.positionWC;
    const fwd = camera.directionWC;
    const up = camera.upWC;
    const rt = camera.rightWC;

    let maxT = 0;
    let anyHit = false;
    const signs = [
      [-1, +1],
      [+1, +1],
      [-1, -1],
      [+1, -1],
    ];
    for (const [sW, sH] of signs) {
      const dirX = fwd.x + sW * tanW * rt.x + sH * tanHalfFovY * up.x;
      const dirY = fwd.y + sW * tanW * rt.y + sH * tanHalfFovY * up.y;
      const dirZ = fwd.z + sW * tanW * rt.z + sH * tanHalfFovY * up.z;
      const t = _rayEllipsoidEntryDistance(
        pos.x,
        pos.y,
        pos.z,
        dirX,
        dirY,
        dirZ,
        this._oneOverRadiiSqX,
        this._oneOverRadiiSqY,
        this._oneOverRadiiSqZ,
      );
      if (Number.isFinite(t)) {
        anyHit = true;
        if (t > maxT) maxT = t;
      }
    }
    return anyHit ? maxT : Infinity;
  }

  /**
   * Compute cascade splits using a blend of uniform and logarithmic
   * distributions (Practical Split Schemes for Shadow Mapping, GPU Gems 3).
   *
   * @param groundFar Optional visible-ground far distance from
   *   `computeVisibleGroundFar`. A finite value below `maxShadowDistance`
   *   distributes cascades over `[near, groundFar]` to keep the near cascade
   *   tight. When omitted or infinite, `maxShadowDistance` sets the limit.
   */
  computeSplits(
    cameraNear: number,
    cameraFar: number,
    groundFar?: number,
  ): void {
    let far = Math.min(cameraFar, this._maxShadowDistance);
    if (groundFar !== undefined && Number.isFinite(groundFar)) {
      // Pad the visible-ground far slightly so receivers right at the
      // horizon edge of the visible patch still fall inside the last
      // cascade (the per-corner clamp already tightens each slice).
      far = Math.min(far, groundFar * 1.1);
    }
    far = Math.max(far, cameraNear + 1.0);
    const lambda = this._lambda;
    const n = this._cascadeCount;

    for (let i = 0; i < n; i++) {
      const p = (i + 1) / n;
      const uniform = cameraNear + (far - cameraNear) * p;
      const logarithmic = cameraNear * Math.pow(far / cameraNear, p);
      const split = lambda * logarithmic + (1 - lambda) * uniform;

      this._cascades[i].splitNear =
        i === 0 ? cameraNear : this._cascades[i - 1].splitFar;
      this._cascades[i].splitFar = split;
    }
  }

  /**
   * Fit a bounding sphere around each cascade's frustum slice and
   * compute a proper light-space orthographic VP matrix.
   *
   * The math (per cascade):
   *
   *   1. Extract the 8 world-space corners of the sub-frustum bounded
   *      by `[splitNear, splitFar]` from the camera's position + basis
   *      + frustum FOV. The camera basis is used directly because it is more
   *      stable than inverse-projecting NDC corners across Cesium's wide
   *      near-far ratios (1 m to 100 km).
   *   2. Fit a bounding sphere around those 8 corners (center-of-mass
   *      + max distance). Sphere fit is rotation-invariant — a plain
   *      AABB fit would make shadow texels swim when the camera
   *      rotates.
   *   3. Build a light-space view matrix looking from
   *      `(center + lightDir * 2 * radius)` toward the center.
   *   4. Build an ortho projection with left/right/bottom/top at
   *      `±radius`, near/far at `0..3*radius`.  Result is an
   *      axis-aligned box in light space that encloses the sphere.
   *   5. VP = proj × view. Results stored column-major, matching
   *      Cesium's Matrix4 convention.
   *
   * Texel-snap stabilization maps the sphere center onto the light-space
   * shadow-map texel grid, eliminating shimmer during slow camera motion.
   *
   * @param camera Camera shape supplying position, basis vectors, `fovy`, and
   *               aspect ratio.
   * @param lightDirection Unit vector from the surface toward the light,
   *                       matching `ShadowMap.lightDirectionEC`.
   */
  computeCascadeVPs(
    camera: {
      positionWC: CesiumCartesian3;
      directionWC: CesiumCartesian3;
      upWC: CesiumCartesian3;
      rightWC: CesiumCartesian3;
      frustum: { fovy?: number; aspectRatio?: number };
    },
    lightDirection: CesiumCartesian3,
  ): void {
    const camX = camera.positionWC.x;
    const camY = camera.positionWC.y;
    const camZ = camera.positionWC.z;

    // First compute world-space VPs and sphere radii to select cascade 0's
    // reference radius for bias scaling below.
    for (let c = 0; c < this._cascadeCount; c++) {
      const cascade = this._cascades[c];
      // Ground-clamp both corner planes so a low top-down camera's near
      // cascade fits the visible ground patch instead of empty volume toward
      // the horizon. This keeps the 1024² near cascade below one metre per
      // texel and mirrors the tight visible-volume fit used by `ShadowMap`.
      const corners = _computeFrustumCornersWorldSpace(
        camera,
        cascade.splitNear,
        cascade.splitFar,
        true,
        this._oneOverRadiiSqX,
        this._oneOverRadiiSqY,
        this._oneOverRadiiSqZ,
      );
      const { center, radius } = _fitBoundingSphere(corners);

      // Texel-snap stabilization. Quantize the sphere center to the
      // shadow-texel grid in light space so static edges don't crawl
      // across sub-texel boundaries as the camera moves. See
      // `snapToTexelGrid` for the math; basis is stable across camera
      // motion so this is a world-grid-locked quantization, not a
      // camera-relative one.
      const snapped = _scratchSnappedCenter;
      snapToTexelGrid(
        center,
        radius,
        lightDirection,
        this._resolution,
        snapped,
      );
      cascade.sphereCenter[0] = snapped[0];
      cascade.sphereCenter[1] = snapped[1];
      cascade.sphereCenter[2] = snapped[2];
      cascade.sphereRadius = radius;

      _computeCascadeVPMatrix(
        snapped,
        radius,
        lightDirection,
        cascade.viewProjection,
      );

      // Derive RTE-aware VP by pre-cancelling the camera translation:
      //   VP_RTE = VP_world * T(+cameraWC)
      // Columns 0..2 are unchanged; column 3 absorbs the camera.
      // CameraWC is ~6.3M at Earth scale; the multiply uses JS `number`
      // (FP64) so the 6.3M scale values cancel cleanly inside VP's
      // translation before any FP32 storage.
      _applyCameraTranslationToVP(
        cascade.viewProjection,
        camX,
        camY,
        camZ,
        cascade.viewProjectionRTE,
      );

      // Pack VP_RTE into UBO at offset c*16.
      const vpOffset = c * 16;
      for (let i = 0; i < 16; i++) {
        this._cascadeParamsData[vpOffset + i] = cascade.viewProjectionRTE[i];
      }
    }

    // Pack split distances at float offset 64 (byte 256, right after the
    // 4 mat4x4<f32> VPs which occupy 64 floats total). The WGSL layout
    // of CSMParams places cascadeSplits immediately after cascadeVP3 in
    // natural std140-style layout; see the struct comment above.
    for (let c = 0; c < this._cascadeCount; c++) {
      this._cascadeParamsData[64 + c] = this._cascades[c].splitFar;
    }

    // Pack blend band at float offset 68 (byte 272).
    for (let c = 0; c < this._cascadeCount; c++) {
      const range = this._cascades[c].splitFar - this._cascades[c].splitNear;
      this._cascadeParamsData[68 + c] = range * this._blendBand;
    }

    // Pack per-cascade depth-bias constants at float offsets 72 (minBias)
    // and 76 (maxSlopeBias). Both scale with sphere-radius ratio against
    // cascade 0, so the NDC-depth bias stays proportional to the cascade's
    // orthographic depth range (fn = 3 * r inside _computeCascadeVPMatrix).
    const refRadius = Math.max(1.0, this._cascades[0].sphereRadius);
    for (let c = 0; c < this._cascadeCount; c++) {
      const scale = Math.max(1.0, this._cascades[c].sphereRadius / refRadius);
      this._cascadeParamsData[72 + c] = BASE_MIN_BIAS * scale;
      this._cascadeParamsData[76 + c] = BASE_MAX_SLOPE_BIAS * scale;
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
   * Number of cascades this renderer is configured for. Useful for
   * shader-side branch tuning and debug snapshots.
   */
  get cascadeCount(): number {
    return this._cascadeCount;
  }

  /**
   * Resolution (pixels per side) of each cascade's depth texture layer.
   * Used by the texel-snap stabilization math so specs + diagnostics can
   * reason about the shadow-grid size without poking at private state.
   */
  get cascadeResolution(): number {
    return this._resolution;
  }

  /**
   * PCF kernel radius (in shadow texels) the receive shaders use to
   * soften cascade edges. 0 → hard single tap. Uploaded into
   * `effects.csmControl.y` by `createEffectsBindGroup`.
   */
  get pcfRadius(): number {
    return this._pcfRadius;
  }

  /**
   * Whether soft (PCF) cascade shadows are active. Convenience over
   * `pcfRadius > 0`.
   */
  get softShadows(): boolean {
    return this._pcfRadius > 0.0;
  }

  set softShadows(value: boolean) {
    this._pcfRadius = value ? DEFAULT_CSM_PCF_RADIUS : 0.0;
  }

  /**
   * Run the cast pass for every cascade. Each cascade renders the
   * shadow-casting commands into its own array-layer of the cascade
   * depth texture, using a per-cascade uniform buffer that packs
   * `{ lightVP, encodedCameraHigh/Low, biases }` — the same layout
   * the single-shadow-map path uses, so every registered cast-variant
   * pipeline (`rte24`, `p12`, `quantized12`, `modelP12`,
   * `modelInstancedSB`, `modelSkinned`) works without modification.
   *
   * @param encoder Active command encoder (one pass per cascade is
   *                 recorded into it).
   * @param castCommands Shadow-casting draw commands for this frame.
   * @param cameraPositionWC Current camera world-space position; packed
   *                         into the RTE camera fields of each cascade's UBO.
   */
  renderCastPass(
    encoder: GPUCommandEncoder,
    castCommands: ReadonlyArray<unknown>,
    cameraPositionWC: CesiumCartesian3,
    frameState?: {
      mode?: number;
      verticalExaggeration?: number;
      verticalExaggerationRelativeHeight?: number;
      frameNumber?: number;
    },
    context?: {
      getGPUCullerForCascade?: (idx: number) => unknown;
      gpuCullingHint?: "auto" | "always" | "never";
      _currentCommandEncoder?: GPUCommandEncoder | null;
    },
  ): void {
    // The optional context exposes per-cascade cullers. Without it, this
    // helper skips GPU culling and renders the unfiltered cast list.
    //
    // Cast through `unknown` because this public context permits an `unknown`
    // return; the helper requires `GPUCullerLikeInstance | null`. Values
    // from `WebGPUContext.getGPUCullerForCascade` satisfy the tighter shape.
    renderCSMCastPass(
      this,
      encoder,
      castCommands,
      cameraPositionWC,
      frameState,
      context as Parameters<typeof renderCSMCastPass>[5],
    );
  }

  /**
   * Get the cascade data for the debug snapshot.
   */
  getStatistics(): DebugStatsObject {
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
   * Expose per-cascade RTE-aware VP matrices and sphere bounds for debugging.
   * A diagnostic can project a known ground point through the receive
   * shader's matrix and compare `(uv, ndc.z)` with stored cast depth. This
   * reads existing CPU state and performs no GPU work.
   */
  debugCascadeMatrices(): Array<{
    splitNear: number;
    splitFar: number;
    sphereCenter: [number, number, number];
    sphereRadius: number;
    viewProjectionRTE: number[];
    viewProjection: number[];
  }> {
    return this._cascades.map((c) => ({
      splitNear: c.splitNear,
      splitFar: c.splitFar,
      sphereCenter: [
        c.sphereCenter[0] as number,
        c.sphereCenter[1] as number,
        c.sphereCenter[2] as number,
      ],
      sphereRadius: c.sphereRadius,
      viewProjectionRTE: Array.from(c.viewProjectionRTE),
      viewProjection: Array.from(c.viewProjection),
    }));
  }

  /**
   * Read one texel from a cascade's stored depth map. Diagnostics use this to
   * compare caster depth at a projected UV with the receiver's reconstructed
   * NDC z. `u` and `v` use the receive shader's `[0, 1]` texture space. A
   * depth32float result maps 0 to light near and 1 to cleared or far
   * depth. The asynchronous copy returns `null` before CSM is initialized.
   */
  async debugReadCascadeDepth(
    cascadeIdx: number,
    u: number,
    v: number,
  ): Promise<number | null> {
    const device = this._device;
    const tex = this._cascadeTexture;
    if (!device || !tex) {
      return null;
    }
    const res = this._resolution;
    const px = Math.min(res - 1, Math.max(0, Math.floor(u * res)));
    const py = Math.min(res - 1, Math.max(0, Math.floor(v * res)));
    // Copy the full layer and index the texel. A partial-row copy with a
    // non-zero `origin.y` reads zero on Vulkan/SwiftShader, whereas the
    // full-layer shape is reliable. `bytesPerRow` must be 256-byte aligned.
    const bytesPerRow = Math.ceil((res * 4) / 256) * 256;
    const readback = device.createBuffer({
      label: "CSM_DebugDepthReadback",
      size: bytesPerRow * res,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder({
      label: "CSM_DebugDepthCopy",
    });
    encoder.copyTextureToBuffer(
      {
        texture: tex,
        mipLevel: 0,
        origin: { x: 0, y: 0, z: cascadeIdx },
        aspect: "depth-only",
      },
      { buffer: readback, bytesPerRow, rowsPerImage: res },
      { width: res, height: res, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(readback.getMappedRange());
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const value = dv.getFloat32(py * bytesPerRow + px * 4, true);
    readback.unmap();
    readback.destroy();
    return value;
  }

  /**
   * Copy a full cascade layer to the CPU and report its minimum, maximum, and
   * a coarse depth histogram. A uniform 1.0 means nothing was drawn; a
   * uniform 0.0 indicates a degenerate cast VP. This is a diagnostic surface.
   */
  async debugScanCascadeLayer(cascadeIdx: number): Promise<{
    min: number;
    max: number;
    nonOne: number;
    nonZero: number;
    total: number;
  } | null> {
    const device = this._device;
    const tex = this._cascadeTexture;
    if (!device || !tex) {
      return null;
    }
    const res = this._resolution;
    const bytesPerRow = Math.ceil((res * 4) / 256) * 256;
    const readback = device.createBuffer({
      label: "CSM_DebugLayerScan",
      size: bytesPerRow * res,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder({
      label: "CSM_DebugLayerCopy",
    });
    encoder.copyTextureToBuffer(
      {
        texture: tex,
        mipLevel: 0,
        origin: { x: 0, y: 0, z: cascadeIdx },
        aspect: "depth-only",
      },
      { buffer: readback, bytesPerRow, rowsPerImage: res },
      { width: res, height: res, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(readback.getMappedRange());
    let min = Infinity;
    let max = -Infinity;
    let nonOne = 0;
    let nonZero = 0;
    let total = 0;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let row = 0; row < res; row++) {
      for (let col = 0; col < res; col++) {
        const d = view.getFloat32(row * bytesPerRow + col * 4, true);
        if (d < min) min = d;
        if (d > max) max = d;
        if (d < 0.9999) nonOne++;
        if (d > 1e-6) nonZero++;
        total++;
      }
    }
    readback.unmap();
    readback.destroy();
    return { min, max, nonOne, nonZero, total };
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
    if (this._terrainGlobalsUB) {
      this._terrainGlobalsUB.destroy();
      this._terrainGlobalsUB = null;
    }
    this._cascadeViews = [];
    this._cascadeArrayView = null;
    if (this._cascadeCastBuffers) {
      for (let i = 0; i < this._cascadeCastBuffers.length; i++) {
        this._cascadeCastBuffers[i]?.destroy();
      }
    }
    this._cascadeCastBuffers = null;
    this._cascadeCastBufferData = null;
    this._cascadeCastBindGroups = null;
    this._sharedPipelineCache = null;
    this._shadowContentState = "uninitialized";
    this._shadowContentFrame = undefined;
    this._device = null;
  }
}

// Helpers exported for specs.

/**
 * Extract the 8 world-space corners of the camera sub-frustum between
 * view-space depths `nearDist` and `farDist`. Uses the camera's basis
 * vectors + FOV directly rather than an inverse-NDC walk — more
 * numerically stable under the wide near/far ranges Cesium scenes use.
 *
 * @param groundClamp When true, each near- and far-plane corner is placed at
 *   its view ray's ellipsoid intersection, clamped to this cascade's depth
 *   band. This prevents empty air beyond the visible ground from inflating a
 *   low top-down camera's fit. Rays that miss the ellipsoid keep their
 *   geometric slice depth. The default false returns raw frustum corners for
 *   callers that require them.
 * @param invRadiiSqX/Y/Z Inverse-square radii of the ellipsoid used by the
 *   ground clamp. The defaults are WGS84;
 *   `WebGPUCSMRenderer.computeCascadeVPs` supplies the scene ellipsoid.
 *
 * @returns Flat Float64Array of 24 floats (8 corners × xyz).
 */
export function computeFrustumCornersWorldSpace(
  camera: {
    positionWC: CesiumCartesian3;
    directionWC: CesiumCartesian3;
    upWC: CesiumCartesian3;
    rightWC: CesiumCartesian3;
    frustum: { fovy?: number; aspectRatio?: number };
  },
  nearDist: number,
  farDist: number,
  groundClamp = false,
  invRadiiSqX: number = WGS84_ONE_OVER_RADII_SQ_X,
  invRadiiSqY: number = WGS84_ONE_OVER_RADII_SQ_Y,
  invRadiiSqZ: number = WGS84_ONE_OVER_RADII_SQ_Z,
): Float64Array {
  return _computeFrustumCornersWorldSpace(
    camera,
    nearDist,
    farDist,
    groundClamp,
    invRadiiSqX,
    invRadiiSqY,
    invRadiiSqZ,
  );
}

function _computeFrustumCornersWorldSpace(
  camera: {
    positionWC: CesiumCartesian3;
    directionWC: CesiumCartesian3;
    upWC: CesiumCartesian3;
    rightWC: CesiumCartesian3;
    frustum: { fovy?: number; aspectRatio?: number };
  },
  nearDist: number,
  farDist: number,
  groundClamp = false,
  invRadiiSqX: number = WGS84_ONE_OVER_RADII_SQ_X,
  invRadiiSqY: number = WGS84_ONE_OVER_RADII_SQ_Y,
  invRadiiSqZ: number = WGS84_ONE_OVER_RADII_SQ_Z,
): Float64Array {
  const fovy = camera.frustum.fovy ?? Math.PI / 3;
  const aspect = camera.frustum.aspectRatio ?? 1;
  const tanHalfFovY = Math.tan(fovy * 0.5);
  const tanW = tanHalfFovY * aspect;

  const pos = camera.positionWC;
  const fwd = camera.directionWC;
  const up = camera.upWC;
  const rt = camera.rightWC;

  const out = new Float64Array(24);
  // A corner sits at `pos + dist * (fwd + sW*tanW*rt + sH*tanHalfFovY*up)`.
  // The bracketed vector is the (non-unit) ray direction through that
  // corner whose forward component is exactly 1, so the scalar `dist` IS
  // the along-view (planar) depth — clamping it keeps the corner on the
  // frustum edge while shortening the slice.
  const write = (i: number, dist: number, sW: number, sH: number) => {
    const dirX = fwd.x + sW * tanW * rt.x + sH * tanHalfFovY * up.x;
    const dirY = fwd.y + sW * tanW * rt.y + sH * tanHalfFovY * up.y;
    const dirZ = fwd.z + sW * tanW * rt.z + sH * tanHalfFovY * up.z;
    out[i * 3 + 0] = pos.x + dirX * dist;
    out[i * 3 + 1] = pos.y + dirY * dist;
    out[i * 3 + 2] = pos.z + dirZ * dist;
  };

  // Per-corner along-view distance to the ground (Infinity when the ray
  // misses the globe). `_rayEllipsoidEntryDistance` returns the along-ray
  // parameter `t`; because each corner ray has unit forward component,
  // that `t` is the same along-view distance the corner uses.
  const tGroundFor = (sW: number, sH: number): number => {
    const dirX = fwd.x + sW * tanW * rt.x + sH * tanHalfFovY * up.x;
    const dirY = fwd.y + sW * tanW * rt.y + sH * tanHalfFovY * up.y;
    const dirZ = fwd.z + sW * tanW * rt.z + sH * tanHalfFovY * up.z;
    return _rayEllipsoidEntryDistance(
      pos.x,
      pos.y,
      pos.z,
      dirX,
      dirY,
      dirZ,
      invRadiiSqX,
      invRadiiSqY,
      invRadiiSqZ,
    );
  };

  if (!groundClamp) {
    // Raw frustum corners are used by specs and by callers whose 2D or
    // Columbus View gating excludes the ground clamp.
    write(0, nearDist, -1, +1);
    write(1, nearDist, +1, +1);
    write(2, nearDist, -1, -1);
    write(3, nearDist, +1, -1);
    write(4, farDist, -1, +1);
    write(5, farDist, +1, +1);
    write(6, farDist, -1, -1);
    write(7, farDist, +1, -1);
    return out;
  }

  // Shadow receivers occupy a thin shell at the globe surface, while a raw
  // perspective slice contains mostly empty air. Place both near and far
  // corners at their ground intersections, bounded by `[splitNear,
  // splitFar]`, so the sphere fits only this cascade's visible ground patch.
  // A missed intersection retains its geometric depth to cover airborne
  // casters near the horizon.
  const clampToBand = (sW: number, sH: number, fallback: number): number => {
    const t = tGroundFor(sW, sH);
    if (!Number.isFinite(t)) {
      return fallback;
    }
    // Place the corner on the ground, but never outside this cascade's own
    // depth band — that keeps adjacent cascades from overlapping onto the
    // same ground ring and preserves the split partition.
    return Math.min(farDist, Math.max(nearDist, t));
  };

  // Near "plane": ground points at this cascade's near depth band edge.
  write(0, clampToBand(-1, +1, nearDist), -1, +1);
  write(1, clampToBand(+1, +1, nearDist), +1, +1);
  write(2, clampToBand(-1, -1, nearDist), -1, -1);
  write(3, clampToBand(+1, -1, nearDist), +1, -1);
  // Far "plane": ground points at this cascade's far depth band edge.
  write(4, clampToBand(-1, +1, farDist), -1, +1);
  write(5, clampToBand(+1, +1, farDist), +1, +1);
  write(6, clampToBand(-1, -1, farDist), -1, -1);
  write(7, clampToBand(+1, -1, farDist), +1, -1);
  return out;
}

/**
 * Fit a bounding sphere around a flat array of world-space points
 * (length % 3 === 0). Uses center-of-mass + max-distance — not the
 * tightest possible sphere (Welzl's is), but close enough for CSM
 * fitting and much cheaper. Rotation-invariant — key property for
 * keeping shadow texels stable under camera rotation.
 */
export function fitBoundingSphere(points: Float64Array): {
  center: [number, number, number];
  radius: number;
} {
  return _fitBoundingSphere(points);
}

function _fitBoundingSphere(points: Float64Array): {
  center: [number, number, number];
  radius: number;
} {
  const count = points.length / 3;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < count; i++) {
    cx += points[i * 3 + 0];
    cy += points[i * 3 + 1];
    cz += points[i * 3 + 2];
  }
  cx /= count;
  cy /= count;
  cz /= count;

  let maxSq = 0;
  for (let i = 0; i < count; i++) {
    const dx = points[i * 3 + 0] - cx;
    const dy = points[i * 3 + 1] - cy;
    const dz = points[i * 3 + 2] - cz;
    const dSq = dx * dx + dy * dy + dz * dz;
    if (dSq > maxSq) maxSq = dSq;
  }
  return { center: [cx, cy, cz], radius: Math.sqrt(maxSq) };
}

/**
 * Build a light-space orthographic VP matrix for a cascade given its
 * bounding sphere and the (normalized) light direction FROM surface
 * TOWARD light. Writes the result into `result` (column-major 16
 * entries, Cesium Matrix4 convention).
 */
export function computeCascadeVPMatrix(
  sphereCenter: [number, number, number],
  sphereRadius: number,
  lightDirection: CesiumCartesian3,
  result: Float64Array | Float32Array,
): Float64Array | Float32Array {
  return _computeCascadeVPMatrix(
    sphereCenter,
    sphereRadius,
    lightDirection,
    result,
  );
}

function _computeCascadeVPMatrix(
  center: [number, number, number] | Float32Array | Float64Array,
  radius: number,
  lightDir: CesiumCartesian3,
  result: Float64Array | Float32Array,
): Float64Array | Float32Array {
  const cx = center[0];
  const cy = center[1];
  const cz = center[2];
  const r = Math.max(radius, 1.0);

  // Place the eye on the light side of the cascade sphere and look along the
  // light's travel direction. `lightDir` points from the surface to the
  // light, so `center + lightDir * 2r` gives `forward = -lightDir`. Reversing
  // this sign can leave self-shadowing intact while mapping a cross-object
  // caster and receiver to different texels. The near plane sits just outside
  // the sphere and the far plane at 3r.
  const eyeX = cx + lightDir.x * 2 * r;
  const eyeY = cy + lightDir.y * 2 * r;
  const eyeZ = cz + lightDir.z * 2 * r;

  // Pick a world-up axis that is not parallel to the light direction. Use
  // world Z for a zenith sun and world Y for a horizon sun.
  let upX = 0;
  let upY = 1;
  let upZ = 0;
  if (Math.abs(lightDir.y) > 0.95) {
    upX = 0;
    upY = 0;
    upZ = 1;
  }

  // forward = normalize(center - eye)
  let fX = cx - eyeX;
  let fY = cy - eyeY;
  let fZ = cz - eyeZ;
  const fLen = Math.sqrt(fX * fX + fY * fY + fZ * fZ) || 1;
  fX /= fLen;
  fY /= fLen;
  fZ /= fLen;

  // side = normalize(cross(forward, up))
  let sX = fY * upZ - fZ * upY;
  let sY = fZ * upX - fX * upZ;
  let sZ = fX * upY - fY * upX;
  const sLen = Math.sqrt(sX * sX + sY * sY + sZ * sZ) || 1;
  sX /= sLen;
  sY /= sLen;
  sZ /= sLen;

  // up = cross(side, forward)
  const uX = sY * fZ - sZ * fY;
  const uY = sZ * fX - sX * fZ;
  const uZ = sX * fY - sY * fX;

  // Column-major view matrix. Cesium's convention: column 0 = right,
  // column 1 = up, column 2 = -forward, column 3 = translation.
  const view = [
    sX,
    uX,
    -fX,
    0,
    sY,
    uY,
    -fY,
    0,
    sZ,
    uZ,
    -fZ,
    0,
    -(sX * eyeX + sY * eyeY + sZ * eyeZ),
    -(uX * eyeX + uY * eyeY + uZ * eyeZ),
    -(-fX * eyeX - fY * eyeY - fZ * eyeZ),
    1,
  ];

  // WebGPU uses 0..1 depth range. Orthographic projection: L/R/B/T at
  // ±r, near at 0, far at 3r. Column-major:
  //   m00 = 2/(R-L), m11 = 2/(T-B), m22 = -1/(F-N), m32 = -N/(F-N)
  const left = -r;
  const right = r;
  const bottom = -r;
  const top = r;
  const nearZ = 0;
  const farZ = 3 * r;
  const rl = right - left;
  const tb = top - bottom;
  const fn = farZ - nearZ;
  const proj = [
    2 / rl,
    0,
    0,
    0,
    0,
    2 / tb,
    0,
    0,
    0,
    0,
    -1 / fn,
    0,
    -(right + left) / rl,
    -(top + bottom) / tb,
    -nearZ / fn,
    1,
  ];

  // VP = proj * view, column-major. result[col * 4 + row]
  for (let j = 0; j < 4; j++) {
    const v0 = view[j * 4 + 0];
    const v1 = view[j * 4 + 1];
    const v2 = view[j * 4 + 2];
    const v3 = view[j * 4 + 3];
    result[j * 4 + 0] =
      proj[0] * v0 + proj[4] * v1 + proj[8] * v2 + proj[12] * v3;
    result[j * 4 + 1] =
      proj[1] * v0 + proj[5] * v1 + proj[9] * v2 + proj[13] * v3;
    result[j * 4 + 2] =
      proj[2] * v0 + proj[6] * v1 + proj[10] * v2 + proj[14] * v3;
    result[j * 4 + 3] =
      proj[3] * v0 + proj[7] * v1 + proj[11] * v2 + proj[15] * v3;
  }
  return result;
}

/**
 * Pre-multiply a column-major 4×4 VP by a translation T(+cameraWC),
 * producing VP_RTE such that:
 *   VP_RTE * vec4(eyePos, 1) == VP_world * vec4(eyePos + cameraWC, 1)
 *                            == VP_world * vec4(worldPos, 1)
 *
 * Columns 0..2 (rotation/scale) are copied verbatim; only column 3 changes.
 * All math is in FP64 (JS `number`), so the 6.3M-magnitude `cameraWC` values
 * cancel inside the view matrix's translation column before conversion to
 * FP32 storage. Shaders complete the RTE transform by feeding `eyePos`, not
 * `worldPos`, into this matrix.
 */
export function applyCameraTranslationToVP(
  vpWorld: Float32Array | Float64Array,
  camX: number,
  camY: number,
  camZ: number,
  result: Float32Array | Float64Array,
): Float32Array | Float64Array {
  return _applyCameraTranslationToVP(vpWorld, camX, camY, camZ, result);
}

function _applyCameraTranslationToVP(
  vp: Float32Array | Float64Array,
  camX: number,
  camY: number,
  camZ: number,
  result: Float32Array | Float64Array,
): Float32Array | Float64Array {
  // Columns 0..2 are identical (T's top-left 3×3 is identity).
  for (let i = 0; i < 12; i++) {
    result[i] = vp[i];
  }
  // New column 3 = VP * [camX, camY, camZ, 1]^T. Column-major indexing:
  // vp[col*4 + row], so column k row r is vp[k*4 + r].
  result[12] = vp[0] * camX + vp[4] * camY + vp[8] * camZ + vp[12];
  result[13] = vp[1] * camX + vp[5] * camY + vp[9] * camZ + vp[13];
  result[14] = vp[2] * camX + vp[6] * camY + vp[10] * camZ + vp[14];
  result[15] = vp[3] * camX + vp[7] * camY + vp[11] * camZ + vp[15];
  return result;
}

/**
 * Quantize the cascade sphere center to the shadow-texel grid in light
 * space. This eliminates slow-motion shimmer on static edges: without
 * snapping, a cascade that moves by 0.5m as the camera moves will shift
 * its shadow texels by ~half a world-space texel, and every static edge
 * crawls across sub-texel boundaries. Snapping locks the texel grid to
 * the world so edges stay put until the camera moves by a full texel.
 *
 * Math:
 *   1. Build the light-space basis (side, up) from `lightDir` and the
 *      world-up fallback. It is independent of the camera and therefore
 *      stable across camera motion.
 *   2. Project the raw center onto (side, up) to get its light-space
 *      XY coordinates relative to the world origin.
 *   3. Round each coordinate to the nearest multiple of
 *      `texelWorld = 2 * radius / resolution` (the world-space extent
 *      of one shadow texel in the ortho-projected cascade).
 *   4. Re-express the snapped (xLS, yLS) back in world space via
 *      `snapped = raw + (xLS' - xLS)*side + (yLS' - yLS)*up`.
 *
 * The light-space Z coordinate is intentionally left unsnapped — the
 * ortho projection places the sphere at a fixed near/far position
 * regardless, and snapping Z would just shift the near/far cutoff
 * without improving shimmer.
 *
 * All math in FP64 (JS `number`). Texel-snapping is a pure position
 * adjustment — it changes `center` by at most ~texelWorld, so bounding
 * coverage is preserved (the same sphere, recentered within a texel).
 *
 * @param center Raw cascade sphere center (e.g., from `fitBoundingSphere`)
 * @param radius Sphere radius (world units)
 * @param lightDirection Normalized light direction (surface → light)
 * @param resolution Cascade texture resolution (pixels per side)
 * @param result Output snapped center (3-component)
 * @returns `result` (filled in place)
 */
export function snapToTexelGrid(
  center: ArrayLike<number>,
  radius: number,
  lightDirection: CesiumCartesian3,
  resolution: number,
  result: Float64Array | Float32Array | number[],
): Float64Array | Float32Array | number[] {
  // Match `_computeCascadeVPMatrix`'s world-up fallback so the snap grid uses
  // the same axes as the view matrix.
  let upX = 0;
  let upY = 1;
  let upZ = 0;
  if (Math.abs(lightDirection.y) > 0.95) {
    upX = 0;
    upY = 0;
    upZ = 1;
  }

  // `_computeCascadeVPMatrix` uses `-lightDirection` as forward. Using
  // `lightDirection` here flips both the side axis and its projected
  // coordinate, producing the same snapped world-space delta.
  let fX = lightDirection.x;
  let fY = lightDirection.y;
  let fZ = lightDirection.z;
  const fLen = Math.sqrt(fX * fX + fY * fY + fZ * fZ) || 1;
  fX /= fLen;
  fY /= fLen;
  fZ /= fLen;

  // side = normalize(cross(forward, up))
  let sX = fY * upZ - fZ * upY;
  let sY = fZ * upX - fX * upZ;
  let sZ = fX * upY - fY * upX;
  const sLen = Math.sqrt(sX * sX + sY * sY + sZ * sZ) || 1;
  sX /= sLen;
  sY /= sLen;
  sZ /= sLen;

  // up' = cross(side, forward) — orthonormalized
  const uX = sY * fZ - sZ * fY;
  const uY = sZ * fX - sX * fZ;
  const uZ = sX * fY - sY * fX;

  const cx = center[0];
  const cy = center[1];
  const cz = center[2];

  // Light-space XY of the raw center (relative to the world origin —
  // the origin of the basis is stable frame-to-frame so the quantized
  // coordinates correspond to fixed world-space texel centers).
  const xLS = cx * sX + cy * sY + cz * sZ;
  const yLS = cx * uX + cy * uY + cz * uZ;

  const texelWorld = (2.0 * Math.max(radius, 1.0)) / Math.max(resolution, 1);
  const xSnap = Math.round(xLS / texelWorld) * texelWorld;
  const ySnap = Math.round(yLS / texelWorld) * texelWorld;

  const dX = xSnap - xLS;
  const dY = ySnap - yLS;

  result[0] = cx + dX * sX + dY * uX;
  result[1] = cy + dX * sY + dY * uY;
  result[2] = cz + dX * sZ + dY * uZ;
  return result;
}

/**
 * CPU reference for the `rte24` shadow cast vertex shader math. Mirrors
 * the WGSL body in `WebGPUShadowMapRenderer.js` (SHADOW_CAST_VARIANTS.rte24):
 *
 *   let rte = (pH - u.camH) + (pL - u.camL);
 *   var pos = u.lightVP * vec4f(rte, 1.0);
 *   pos.z += u.depthBias;
 *
 * Every cast variant (`p12`, `quantized12`, `modelP12`, `modelInstancedSB`,
 * and `modelSkinned`) preserves the RTE subtraction and `lightVP_RTE`
 * multiply. Variant-specific vertex decompression happens before this step.
 *
 * Arithmetic runs in FP64 (JS `number`). Callers who want FP32 behavior
 * should pass Float32Array inputs — intermediate values still promote to
 * FP64 then round back on store. Using this helper in specs keeps the
 * lightVP_RTE identity (VP_RTE * rte ≡ VP_world * worldPos) explicit.
 *
 * @param pHigh 3-component split-position high bits (world-scale)
 * @param pLow 3-component split-position low bits (sub-meter residual)
 * @param camHigh 3-component encoded camera high bits
 * @param camLow 3-component encoded camera low bits
 * @param lightVpRte Column-major 4×4 VP_RTE; use
 *                   `applyCameraTranslationToVP`.
 * @param depthBias Per-cascade ortho-NDC depth offset added to clip.z. This
 *   matches the WGSL `pos.z += u.depthBias`. WebGPUCSMRenderer stores the
 *   positive scaled value `BASE_MIN_BIAS * (sphereRadius / cascade0Radius)`
 *   at UBO float slot 24; pass 0 for the raw untouched projection.
 * @param result 4-component clip-space output (x, y, z, w)
 */
export function computeCastClipPosition(
  pHigh: ArrayLike<number>,
  pLow: ArrayLike<number>,
  camHigh: ArrayLike<number>,
  camLow: ArrayLike<number>,
  lightVpRte: ArrayLike<number>,
  depthBias: number,
  result: Float32Array | Float64Array | number[],
): Float32Array | Float64Array | number[] {
  const rx = pHigh[0] - camHigh[0] + (pLow[0] - camLow[0]);
  const ry = pHigh[1] - camHigh[1] + (pLow[1] - camLow[1]);
  const rz = pHigh[2] - camHigh[2] + (pLow[2] - camLow[2]);
  result[0] =
    lightVpRte[0] * rx +
    lightVpRte[4] * ry +
    lightVpRte[8] * rz +
    lightVpRte[12];
  result[1] =
    lightVpRte[1] * rx +
    lightVpRte[5] * ry +
    lightVpRte[9] * rz +
    lightVpRte[13];
  result[2] =
    lightVpRte[2] * rx +
    lightVpRte[6] * ry +
    lightVpRte[10] * rz +
    lightVpRte[14] +
    depthBias;
  result[3] =
    lightVpRte[3] * rx +
    lightVpRte[7] * ry +
    lightVpRte[11] * rz +
    lightVpRte[15];
  return result;
}

export default WebGPUCSMRenderer;
