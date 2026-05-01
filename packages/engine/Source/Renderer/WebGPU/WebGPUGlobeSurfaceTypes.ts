/// <reference types="@webgpu/types" />
/**
 * Module-level types, layout constants, and free helpers for
 * `WebGPUGlobeSurfaceRenderer`.
 *
 * Batch 145 of the audit-recommended decomposition (the first slice of the
 * GlobeSurface decomposition arc — see
 * `migration_doc/BATCH_145_PLAN_GLOBE_SURFACE_DECOMPOSITION.md`).
 *
 * Pure lift of the constants/interfaces/enums/free helpers that previously
 * sat above the `WebGPUGlobeSurfaceRenderer` class. No behavior change. The
 * renderer re-exports `TileDrawDescriptor` and `DebugFragmentMode` so that
 * any downstream consumer that still imports them via
 * `WebGPUGlobeSurfaceRenderer.js` continues to compile.
 *
 * The layout-offset constants here MUST stay in lock-step with the
 * `CameraUniforms` and `TileUniforms` structs in
 * `Source/Shaders/WebGPU/GlobeTerrain.wgsl`. Adding/removing fields
 * requires updating both sides plus the `*_FLOATS` totals below.
 *
 * @module WebGPUGlobeSurfaceTypes
 */

import type { WebGPURenderPipelineDescriptor } from "./WebGPURenderPipelineCache.js";

/**
 * Entry slot for the per-cacheKey pipeline maps. The descriptor is the
 * stable shape submitted to the central `webgpuPipelineCache`; the
 * pipeline is the materialized `GPURenderPipeline` (null until the
 * central cache resolves it). `pending` tracks whether a creation
 * promise is in-flight so we don't re-issue per frame.
 *
 * C-R7-RENDERER-MIGRATION (Batch 75).
 * @private
 */
export interface GlobePipelineEntry {
  descriptor: WebGPURenderPipelineDescriptor;
  pipeline: GPURenderPipeline | null;
  pending: boolean;
}

// ─── Uniform buffer sizes (must match GlobeTerrain.wgsl CameraUniforms) ───
// CameraUniforms: mvpRTE(16) + modifiedMV(16) + modifiedMVP(16) +
//   camHigh(3+1) + camLow(3+1) +
//   center3DHigh(3+1) + center3DLow(3+1) +
//   sunDirEC(3)+enableLighting(1) + scaleAndBias(16) +
//   minMaxHeight(2) + pad(2) = 88 floats (3D core)
//   + tileRectangle(4) + southAndNorthLatitude(2) + southMercY(2) +
//   sceneMode(1) + morphTime(1) + useWebMercator(1) + pad(1) = 12 floats (2D/Columbus)
//   + previousViewProjection(16) = 16 floats (TAA/motion — DP-H41)
//   = 116 floats total
//
// The center3D field is stored as a high/low f32 pair (emulated f64) so the
// SCENE3D vertex shader can combine it with the tile-local vertex position
// and the encoded camera pair without losing sub-meter precision. Previously
// raw f32 `center3D` lost ~0.5 m of precision per component at Earth radius,
// which defeated the RTE emulation and produced visible tile-seam jitter at
// orbital altitudes.
//
// previousViewProjection (offsets 100–115): last frame's `viewProjection`
// captured by `UniformState.update()`. Exposing it unblocks motion-vector
// pipelines (TAA, motion blur) that need to reproject the current fragment
// into the previous frame's NDC. Consumers read it via the shared
// `camera.previousViewProjection` slot in `CameraUniforms`.
export const CAMERA_UNIFORM_FLOATS = 116;
export const CAMERA_UNIFORM_BYTES = CAMERA_UNIFORM_FLOATS * 4;

// TileUniforms layout — Batch 58 (C-R5 imagery layer expansion):
//
// Per-layer struct widened from 12 to 24 floats (96 bytes) to carry the 5
// new effect fields previously WebGL-only: hue, oneOverGamma, split,
// colorToAlpha (vec4), cutoutRectangle (vec4). Layer cap raised from 4 to
// 16 to hit WebGPU's `maxSampledTexturesPerShaderStage` floor without
// device-limit probing. Tiles with >16 imagery layers continue to fall
// back to multi-pass rendering (createTileCommands handles the slicing).
//
// Float offsets (each row in this table is 4 bytes × stated count):
//   0   - 383  layers[16]                (16 × 24 = 384)
//   384 - 415  dayNightAlpha[8]<vec4>     (32; packed two layers per vec4 — see WGSL note)
//   416 - 431  useWebMercatorTLayer[4]<vec4> (16; 4 layers per vec4)
//   432        layerCount
//   433        fogDensity
//   434        fogOffset
//   435        fogMinimumBrightness
//   436 - 439  waterMaskTranslationAndScale (vec4)
//   440 - 443  cartographicLimitRect (vec4)
//   444        nightFadeOutDistance
//   445        nightFadeInDistance
//   446        verticalExaggeration
//   447        verticalExaggerationRelativeHeight
//   448 - 451  flags (vec4: hasWaterMask, enableClipping, showOceanWaves, isSubsequentPass)
//   452 - 455  oceanParams (vec4)
//   456 - 459  nightOceanParams (vec4)
//   460        time
//   461        fogVisualDensityScalar
//   462        splitPosition (in framebuffer pixels — frameState.splitPosition × drawingBufferWidth)
//   463        _pad
//   464 - 467  debugFields (vec4)
//   468 - 471  hsbShift (vec4)
//
// Total = 472 floats = 1888 bytes. Well under WebGPU's
// `maxUniformBufferBindingSize` floor (16 KiB).
export const TILE_UNIFORM_FLOATS = 472;
export const TILE_UNIFORM_BYTES = TILE_UNIFORM_FLOATS * 4;

// Per-layer floats: vec4 translationAndScale + vec4 texCoordsRect +
// vec4 colorToAlpha + vec4 cutoutRectangle + (alpha,brightness,contrast,saturation)
// + (hue, oneOverGamma, split, _pad). 4×4 + 4 + 4 = 24 floats.
export const LAYER_FLOATS = 24;

// Float offsets within TileUniforms — keep in sync with the WGSL struct.
export const LAYERS_OFFSET = 0;
export const DAY_NIGHT_ALPHA_OFFSET = 384; // 16 × 24
export const USE_WEB_MERC_OFFSET = 416; // + 8 vec4 packed pairs
export const LAYER_COUNT_OFFSET = 432;
export const FOG_DENSITY_OFFSET = 433;
export const FOG_OFFSET_OFFSET = 434;
export const FOG_MIN_BRIGHTNESS_OFFSET = 435;
export const WATER_MASK_TS_OFFSET = 436;
export const CART_LIMIT_RECT_OFFSET = 440;
export const NIGHT_FADE_OUT_OFFSET = 444;
export const NIGHT_FADE_IN_OFFSET = 445;
export const VERT_EXAG_OFFSET = 446;
export const VERT_EXAG_REL_HEIGHT_OFFSET = 447;
export const FLAGS_OFFSET = 448;
export const OCEAN_PARAMS_OFFSET = 452;
export const NIGHT_OCEAN_PARAMS_OFFSET = 456;
export const TIME_OFFSET = 460;
export const FOG_VIS_DENSITY_OFFSET = 461;
export const SPLIT_POSITION_OFFSET = 462;
export const DEBUG_FIELDS_OFFSET = 464;
export const HSB_SHIFT_OFFSET = 468;

// Max imagery layers per tile in a single draw call (16 — WebGPU minimum
// `maxSampledTexturesPerShaderStage`). Tiles exceeding this count multi-pass.
export const MAX_IMAGERY_LAYERS = 16;

/**
 * Resolve an `ImageryLayer` property that the public API documents as either a
 * scalar or a callback `(frameState, layer, x, y, level) => number`. Writing
 * a Function into a Float32Array produces NaN which propagates through the
 * shader's multiplicative blend and makes the layer disappear on WebGPU.
 *
 * The callback signature matches WebGL's `ImageryLayerFeatureGetter`
 * convention: imagery layers that use it (hover-fade, time-of-day fade,
 * elevation-based fade) rely on per-tile arguments, so we pass the tile
 * rectangle's level/x/y when available.
 *
 * @private
 */
export function resolveImageryLayerValue(
  value: unknown,
  defaultValue: number,
  frameState: CesiumFrameState,
  layer: unknown,
  tile?: { level: number; x: number; y: number; rectangle: CesiumRectangle },
): number {
  if (typeof value === "function") {
    try {
      const fn = value as (
        fs: CesiumFrameState,
        l: unknown,
        x: number,
        y: number,
        level: number,
      ) => number;
      const resolved = fn(
        frameState,
        layer,
        tile?.x ?? 0,
        tile?.y ?? 0,
        tile?.level ?? 0,
      );
      return typeof resolved === "number" && isFinite(resolved)
        ? resolved
        : defaultValue;
    } catch {
      return defaultValue;
    }
  }
  return typeof value === "number" && isFinite(value) ? value : defaultValue;
}

// Column-major 4×4 matrix multiply: result = a × b. All inputs and result
// are stored as Float64Array of length 16 in column-major order (Cesium's
// Matrix4 convention). Used by the camera UB to build modifiedMVP from
// projection × modifiedModelView for 2D / Columbus View paths.
export function multiplyMat4ColumnMajor(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  result: Float64Array,
): void {
  const a00 = a[0],
    a01 = a[4],
    a02 = a[8],
    a03 = a[12];
  const a10 = a[1],
    a11 = a[5],
    a12 = a[9],
    a13 = a[13];
  const a20 = a[2],
    a21 = a[6],
    a22 = a[10],
    a23 = a[14];
  const a30 = a[3],
    a31 = a[7],
    a32 = a[11],
    a33 = a[15];
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4 + 0];
    const b1 = b[col * 4 + 1];
    const b2 = b[col * 4 + 2];
    const b3 = b[col * 4 + 3];
    result[col * 4 + 0] = a00 * b0 + a01 * b1 + a02 * b2 + a03 * b3;
    result[col * 4 + 1] = a10 * b0 + a11 * b1 + a12 * b2 + a13 * b3;
    result[col * 4 + 2] = a20 * b0 + a21 * b1 + a22 * b2 + a23 * b3;
    result[col * 4 + 3] = a30 * b0 + a31 * b1 + a32 * b2 + a33 * b3;
  }
}

/** Pipeline variant key: encodes quantization + normals state */
export const enum PipelineKey {
  UNCOMPRESSED_NORMALS = 0,
  UNCOMPRESSED_NO_NORMALS = 1,
  QUANTIZED_NORMALS = 2,
  QUANTIZED_NO_NORMALS = 3,
  // Blend variants for multi-pass (subsequent imagery passes)
  UNCOMPRESSED_NORMALS_BLEND = 4,
  UNCOMPRESSED_NO_NORMALS_BLEND = 5,
  QUANTIZED_NORMALS_BLEND = 6,
  QUANTIZED_NO_NORMALS_BLEND = 7,
}

/** Cached per-tile WebGPU resources */
export interface TileGPUResources {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  strideFloats: number;
  strideBytes: number;
  hasNormals: boolean;
  hasWebMercatorT: boolean;
  isQuantized: boolean;
  // DP-H25 — true when `TerrainEncoding.hasGeodeticSurfaceNormals` is set,
  // meaning the last 3 floats of each vertex stride hold the WGS84 geodetic
  // surface normal. The pipeline builder adds a `@location(2)` vec3 attribute
  // and activates the `GEODETIC_NORMAL` shader define (Batch 20) so the
  // exaggeration branch uses the true geodetic normal instead of
  // `normalize(position3D)`. When false the shader define is off and the
  // exaggeration branch falls back to the ellipsocentric normal (sub-meter
  // accurate near the equator, drifts up to 0.2° at mid-latitudes on WGS84).
  hasGeodeticSurfaceNormals: boolean;
  meshGeneration: number;
  // Per-tile shadow cast uniform buffer for the `quantized12` variant.
  // Holds scaleAndBias (mat4), center3D (vec3+pad), and minMaxHeight
  // (vec2+pad). Only populated for quantized tiles; uncompressed tiles
  // don't need the extra UB because the rte24 variant handles them.
  shadowCastUB?: GPUBuffer;
}

/** Cached imagery texture */
export interface ImageryGPUTexture {
  texture: GPUTexture;
  view: GPUTextureView;
  sourceWidth: number;
  sourceHeight: number;
}

/** Descriptor for a single tile draw pass */
export interface TileDrawDescriptor {
  pipeline: GPURenderPipeline;
  bindGroups: GPUBindGroup[];
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  boundingVolume: CesiumBoundingSphere | undefined;
  isSubsequentPass: boolean;
  // Shadow cast hints (Batch 24) — consumed by
  // `GlobeSurfaceTileProviderRendering.addWebGPUDrawCommandsForTile` to
  // tag the generated scene command with the correct shadow cast
  // variant + per-command UB + effective VB stride. Every tile sets
  // these three fields; quantized tiles route to `quantized12` and
  // uncompressed tiles to `terrainUncompressed` (new in Batch 24).
  isQuantized?: boolean;
  shadowCastTerrainUB?: GPUBuffer;
  // DP-H25 — flagged when the tile's VB includes the geodetic surface
  // normal attribute (extra 12 bytes / 3 floats at the tail of each
  // vertex stride). No longer affects shadow cast directly — Batch 24's
  // stride-aware pipeline registry handles any stride correctly via
  // `strideBytes` below — but consumers that need to know whether the
  // attribute is present (e.g. the color pipeline) continue to check
  // this flag.
  hasGeodeticSurfaceNormals?: boolean;
  // Batch 24 — the ACTUAL per-vertex byte stride of the tile's VB. The
  // scene adapter forwards this as `cmd.vertexStride` so the shadow
  // cast registry builds a pipeline whose `arrayStride` matches.
  // Without this the GPU walks the buffer at the variant's declared
  // default stride, silently misaligning every vertex.
  strideBytes?: number;
}

/**
 * Mutually-exclusive debug fragment variants for the globe surface.
 * Bumped through `frameState.debugTerrainFragmentMode` (set by Scene from
 * the individual `debugShow*` flags). NONE = production fragment.
 *
 * The values are stable; do not renumber without updating Scene.js.
 */
export const enum DebugFragmentMode {
  NONE = 0,
  TRIANGULATION = 1, // per-triangle face color via @builtin(primitive_index)
  LOD = 2, // tile depth-level color overlay
  NORMAL = 3, // eye-space normal as RGB
}
