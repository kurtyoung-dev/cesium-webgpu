/// <reference types="@webgpu/types" />
/**
 * Module-level types, layout constants, and free helpers for
 * `WebGPUGlobeSurfaceRenderer`. The renderer re-exports `TileDrawDescriptor`
 * and `DebugFragmentMode` so downstream consumers that import them via
 * `WebGPUGlobeSurfaceRenderer.js` continue to compile.
 *
 * The layout-offset constants here must stay in lock-step with the
 * `CameraUniforms` and `TileUniforms` structs in
 * `Source/Shaders/WebGPU/GlobeTerrain.wgsl`. Adding or removing a field
 * requires updating both sides plus the `*_FLOATS` totals below.
 *
 * @module WebGPUGlobeSurfaceTypes
 */

import type { WebGPURenderPipelineDescriptor } from "./WebGPURenderPipelineCache.js";
import type { SharedImageryRealization } from "./WebGPUSharedImageryRealizations.js";

/**
 * Entry slot for the per-cacheKey pipeline maps. The descriptor is the
 * stable shape submitted to the central `webgpuPipelineCache`; the
 * pipeline is the materialized `GPURenderPipeline` (null until the
 * central cache resolves it). `pending` tracks whether a creation
 * promise is in flight, so the request is not re-issued per frame.
 *
 * @private
 */
export interface GlobePipelineEntry {
  descriptor: WebGPURenderPipelineDescriptor;
  pipeline: GPURenderPipeline | null;
  pending: boolean;
}

// CameraUniforms float layout. Must match the struct of the same name in
// GlobeTerrain.wgsl.
//
//   0   -  15  mvpRelativeToEye (mat4)
//   16  -  31  modifiedModelView (mat4)
//   32  -  47  modifiedModelViewProjection (mat4)
//   48  -  51  encodedCameraHigh (vec3 + ellipsoid inverse radius x)
//   52  -  55  encodedCameraLow (vec3 + ellipsoid inverse radius y)
//   56  -  59  center3DHigh (vec3 + ellipsoid inverse radius z)
//   60  -  63  center3DLow (vec3 + pad)
//   64  -  67  sunDirectionEC (vec3) + enableLighting
//   68  -  83  scaleAndBias (mat4, quantized-mesh decompression)
//   84  -  87  minMaxHeight (vec2) + ellipsoidRadius + pad
//   88  -  99  tileRectangle (vec4) + southAndNorthLatitude (vec2) +
//              southMercatorYAndOneOverHeight (vec2) + sceneMode + morphTime +
//              useWebMercator + pad
//   100 - 115  previousViewProjection (mat4)
//   116 - 131  ground-atmosphere ray-march parameters
//   132 - 135  lightColor (vec4)
//   136 - 139  lighting (vec4)
//   140 - 143  logDepth (vec4)
//   144 - 147  pickColor (vec4)
//   148 - 167  cloud-shadow single map (mat4 + control vec4)
//   168 - 179  underground tint (colour + alphaByDistance + control)
//   180 - 191  globe translucency (front + back alphaByDistance + control)
//   192 - 195  hdrControl (vec4)
//   196 - 231  cloud-shadow cascades (2 × mat4 + params vec4)
//
// center3D is a high/low f32 pair (emulated f64) so the SCENE3D vertex shader
// can combine it with the tile-local vertex position and the encoded camera
// pair without losing sub-meter precision. A raw f32 centre loses ~0.5 m per
// component at Earth radius, which defeats the RTE emulation and produces
// visible tile-seam jitter at orbital altitudes.
//
// previousViewProjection (offsets 100-115) is the previous frame's
// `viewProjection`, captured by `UniformState.update()`. Motion-vector
// pipelines (TAA, motion blur) reproject the current fragment into the
// previous frame's NDC through the shared `camera.previousViewProjection`
// slot.
//
// Ground-atmosphere ray-march parameters (offsets 116-131), consumed per
// vertex:
//
//   atmosphereLightDirectionAndIntensity (vec4, offset 116-119):
//     xyz = world-space atmosphere light direction (sun by default)
//     w   = atmosphereLightIntensity (default 10.0 from Atmosphere.js)
//   atmosphereRayleighCoefficientAndScale (vec4, offset 120-123):
//     xyz = Rayleigh scattering coefficients (m^-1, RGB)
//     w   = Rayleigh scale height (meters, default 8500)
//   atmosphereMieCoefficientAndScale (vec4, offset 124-127):
//     xyz = Mie scattering coefficients (m^-1, RGB)
//     w   = Mie scale height (meters, default 1200)
//   atmosphereParams (vec4, offset 128-131):
//     x = Mie anisotropy (Henyey-Greenstein g, default 0.758)
//     y = Atmosphere inner radius (meters; planet maximum ellipsoid radius)
//     z = Atmosphere outer radius (inner + 111e3, matches AtmosphereCommon)
//     w = Atmosphere shading enable flag (1.0 if fog or ground-atmosphere
//         is enabled, 0.0 otherwise — gates the VS ray-march so disabling
//         atmosphere costs nothing per-vertex).
//
// lightColor mirrors WebGL's `czm_lightColor` automatic uniform so
// scene-provided custom light colors propagate to the globe Lambert diffuse
// path:
//
//   lightColor (vec4, offset 132-135):
//     xyz = scene light color (matches `uniformState.lightColor`, which
//           is `lightColorHdr` clipped so its max channel ≤ 1)
//     w   = reserved (ambient color scalar or HDR multiplier)
//
// lighting carries the tile-provider-driven Lambert coefficients, mirroring
// WebGL's `u_lambertDiffuseMultiplier` + `u_vertexShadowDarkness` fragment
// uniforms (GlobeFS.glsl L132-133, L559). The WGSL Lambert path gates on the
// `hasVertexNormals` flag at .z to match WebGL's ENABLE_VERTEX_LIGHTING
// gating, which compiles only when the terrain provider exposes vertex
// normals:
//
//   lighting (vec4, offset 136-139):
//     x = lambertDiffuseMultiplier  (from tileProvider, default 0.9)
//     y = vertexShadowDarkness      (from tileProvider, default 0.3)
//     z = hasVertexNormals flag — when > 0.5, WGSL uses the (x, y)
//         coefficients directly (matches WebGL ENABLE_VERTEX_LIGHTING);
//         when ≤ 0.5, WGSL runs WebGL's ENABLE_DAYNIGHT_SHADING formula
//         `mix(1, clamp(NdotL × 5 + 0.3, 0, 1), lightingFade)`.
//     w = zoomedOutOceanSpecularIntensity. The DAYNIGHT_SHADING `fade` bridge
//         does not live here: the fade is per-frame tile-UB data and is
//         carried by `TileUniforms.lightingFade` (float 463) instead.
//
// logDepth (offsets 140-143) is (near, far,
// oneOverLog2FarDepthFromNearPlusOne, reserved) — see
// GlobeTerrain.wgsl's `CameraUniforms.logDepth`. The tail carries zero until
// log depth activates, so the larger UB is inert until then.
//
// pickColor (offsets 144-147) is the globe pick-ID color, read only by
// GlobeTerrain.wgsl::fragmentPickMain. Carries (0,0,0,0) unless
// `globe.pickable` is set.
//
// Cloud-shadow single map:
//   cloudShadowVP (mat4, offsets 148-163) — world ECEF → sun ortho clip
//   cloudShadowControl (vec4, offsets 164-167) — x=enabled, y=absorption,
//     z=strength, w=cascade count.
// Carries (identity, 0,0,0,0) unless `globe.cloudCastShadows` is set and the
// cloud renderer rendered a map, so the FS gate
// (`cloudShadowControl.x > 0.5`) stays closed by default, the shadow sample
// is skipped, and the render is byte-identical.
//
// Underground tint:
//   undergroundColor (vec4, offsets 168-171) — globe.undergroundColor RGBA
//   undergroundColorAlphaByDistance (vec4, offsets 172-175) — NearFarScalar
//     packed as (near, nearValue, far, farValue)
//   undergroundControl (vec4, offsets 176-179) — x=show flag (the WebGL
//     `showUndergroundColor` condition), y=max(eyeHeight, 0), z/w reserved.
// The show flag is 0 unless the camera can see underground and the
// underground color is visible, so the FS gate
// (`undergroundControl.x > 0.5`) stays closed by default and the render is
// byte-identical.
//
// Translucent-globe alpha:
//   translucencyFrontAlphaByDistance (vec4, offsets 180-183) — WebGL's
//     `u_frontFaceAlphaByDistance` NearFarScalar packed as
//     (near, nearValue, far, farValue); camera-underground swap pre-applied
//   translucencyBackAlphaByDistance (vec4, offsets 184-187) — WebGL's
//     `u_backFaceAlphaByDistance`
//   translucencyControl (vec4, offsets 188-191) — x = enable flag (mirrors
//     the WebGL TRANSLUCENT define, i.e. globeTranslucencyState.translucent),
//     y/z/w reserved.
// All-zero unless globe.translucency is enabled, so the FS gate
// (`translucencyControl.x > 0.5`) stays closed by default.
//
// czm_gammaCorrect HDR gate:
//   hdrControl (vec4, offsets 192-195) — x = 1.0 when the HDR canvas-output
//     path is active; y = czm_gamma (uniformState.gamma, default 2.2); z/w
//     reserved.
// The gate is 0 unless HDR canvas output is engaged, so `czm_gammaCorrect`
// stays an identity no-op and the default SDR render is byte-identical.
//
// Cloud-shadow cascades: cloudShadowVP1 (mat4, offsets 196-211) +
// cloudShadowVP2 (mat4, offsets 212-227) + cloudShadowCascadeParams (vec4,
// offsets 228-231). These carry the two far cascade forward-VP matrices;
// cascade 0 reuses the cloudShadowVP field above and the cascade count travels
// in cloudShadowControl.w. All-zero unless the opt-in `cloudShadowCascades`
// tier rendered the cascade atlas this frame, so the single-map path
// (cloudShadowControl.w < 1.5) is byte-identical.
export const CAMERA_UNIFORM_FLOATS = 232;
export const CAMERA_UNIFORM_BYTES = CAMERA_UNIFORM_FLOATS * 4;

// TileUniforms layout.
//
// The per-layer struct is 24 floats (96 bytes): the base 12 plus hue,
// oneOverGamma, split, colorToAlpha (vec4) and cutoutRectangle (vec4). The
// layer cap is 16, WebGPU's `maxSampledTexturesPerShaderStage` floor, which
// avoids device-limit probing. Tiles with more than 16 imagery layers fall
// back to multi-pass rendering, sliced by createTileCommands.
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
//   463        lightingFade — WebGL's day/night camera-distance fade,
//                `GlobeFS.glsl:620-644`:
//                  fade = clamp((cameraDist - fadeOutDist) /
//                               (fadeInDist - fadeOutDist), 0, 1)
//                with `cameraDist` selected per scene mode and both distances
//                reduced by the ellipsoid's maximum radius outside SCENE3D.
//                Consumed by the DAYNIGHT_SHADING arm as
//                `mix(1.0, diffuseIntensity, lightingFade)` (GlobeFS.glsl:852).
//                Distinct from `groundAtmosphereControl.y`, which carries the
//                same clamp but is forced to 0 whenever the ground-atmosphere
//                drape is off — WebGL applies no such gate to the lighting
//                fade.
//   464 - 467  debugFields (vec4)
//   468 - 471  hsbShift (vec4)
//   472 - 475  groundAtmosphereControl (vec4):
//                x = enable flag (1.0 if showGroundAtmosphere and the
//                    lightingFade fade > 0 and the camera is in 3D mode)
//                y = pre-computed fade scalar (matches WebGL's
//                    `fade = clamp((cameraDist - fadeOutDist) /
//                    (fadeInDist - fadeOutDist), 0, 1)` from GlobeFS.glsl
//                    line 391 — drives the no-fog GroundAtmosphere drape
//                    that's invisible whenever fog is off because the
//                    fog branch is the only delivery mechanism).
//                z = atmosphereLightIntensity (default 10.0)
//                w = reserved
//
//   476 - 479  initialColor (vec4) — globe.baseColor (WebGL
//                `u_initialColor`), consumed by the no-imagery first-pass base
//                color in GlobeTerrain.wgsl. Subsequent passes leave it zeroed
//                (transparent), matching WebGL's `otherPassesInitialColor`.
//   480 - 483  localizedTranslucencyRectangle (vec4) — WebGL's
//                `u_translucencyRectangle` (globe.translucency.rectangle
//                antimeridian-clipped + localized to tile UV, west/south/east/
//                north). All-zero when translucency is off; the FS only reads
//                it inside the `camera.translucencyControl.x > 0.5` gate.
//   484 - 487  oceanWavePhaseA (vec4) — ocean-wave RTE phase, f64-computed
//                per-tile offsets fract(rectOriginNorm × Rᵢ) for octaves 1 and
//                2: (.xy)=octave1 (u,v), (.zw)=octave2 (u,v). Removes the f32
//                quantization of the absolute global wave UV, where euv×R
//                reaches ~2.7e6 so one ulp is ~0.25 of a repeat, producing
//                staircase banding and a frozen animation. All-zero when the
//                tile has no rectangle.
//   488 - 491  oceanWavePhaseB (vec4) — (.xy)=octave3 phase (u,v),
//                (.zw)=oceanWaveSpanNorm (normalized ellipsoid-UV tile span:
//                width×1/2π, height×1/π). The span is packed rather than
//                computed in the FS as east−west, which would suffer f32
//                cancellation and produce tile-boundary wave-scale seams at
//                fine LOD.
//
// Total = 492 floats = 1968 bytes. Well under WebGPU's
// `maxUniformBufferBindingSize` floor (16 KiB).
export const TILE_UNIFORM_FLOATS = 492;
export const TILE_UNIFORM_BYTES = TILE_UNIFORM_FLOATS * 4;

// Normal-map repeat counts per octave, round(equatorial circumference /
// target wavelength). They are integers so the ±180° ellipsoid-UV wrap is an
// exact repeat count, which keeps the seam invisible and the CPU f64 phase
// offset consistent with the shader. Approximate wavelengths: 267167 →
// 150.0 m, 801500 → 50.0 m, 2671668 → 15.0 m (equatorial, zonal; meridional
// is ×2 — see the shader). These are the WebGPU wave-scale tunable; keep them
// in lockstep with GlobeTerrain.wgsl's OCEAN_OCTAVE_REPEATS_* and the
// ocean-wave-lod.spec.mjs cross-check.
export const OCEAN_OCTAVE_REPEATS = [267167.0, 801500.0, 2671668.0];

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
export const LIGHTING_FADE_OFFSET = 463;
export const DEBUG_FIELDS_OFFSET = 464;
export const HSB_SHIFT_OFFSET = 468;
export const GROUND_ATMOSPHERE_CONTROL_OFFSET = 472;
export const INITIAL_COLOR_OFFSET = 476;
export const LOCALIZED_TRANSLUCENCY_RECT_OFFSET = 480;
export const OCEAN_WAVE_PHASE_A_OFFSET = 484; // octave1.xy, octave2.xy
export const OCEAN_WAVE_PHASE_B_OFFSET = 488; // octave3.xy, spanNorm.xy

// Max imagery layers per tile in a single draw call (16 — WebGPU minimum
// `maxSampledTexturesPerShaderStage`). Tiles exceeding this count multi-pass.
export const MAX_IMAGERY_LAYERS = 16;

// Fragment-stage sampled textures the globe terrain pipeline layout needs
// besides the group-1 imagery slots:
//   group 2 (5): water mask, ocean normal, material image, material heights,
//     cloud shadow map (binding 9)
//   group 3 globe effects (7): shadow depth, clipping planes, polygon SDF,
//     2× atmosphere LUT, CSM cascade array, point-light cube depth (see
//     WebGPUEffectsBindGroup.js bindings 1/3/5/7/8/11/17). Model-only edge,
//     globe-depth, clustered, and area-light resources live in the complete
//     model/primitive effects layout and are intentionally not charged here.
// Full layout total = 12 + MAX_IMAGERY_LAYERS = 28. Keep this in sync
// when adding sampled textures to group 2 or the globe effects BGL — drift
// here silently re-breaks default-limit adapters.
export const GLOBE_NON_IMAGERY_FRAGMENT_TEXTURES = 12;

/**
 * Per-device imagery slot count for the globe terrain layout.
 *
 * Binary by design — the WGSL variant axis is one preprocessor bit
 * (`ShaderDefine.GLOBE_IMAGERY_REDUCED`), so the only two shapes are:
 *
 *   - 16 slots (full, single-pass up to 16 layers) when the device's
 *     `maxSampledTexturesPerShaderStage` covers the full layout's 28
 *     fragment-stage sampled textures, and
 *   - 4 slots (reduced, up to four layers per blend pass) otherwise — sized
 *     so the layout needs exactly 16, the WebGPU spec floor that every
 *     compliant adapter (incl. SwiftShader CI / compat mode) guarantees.
 *
 * Devices in the 17..27 band conservatively take the reduced layout;
 * in practice the pool's adaptive negotiator opts capable adapters up
 * to 64, so the band is essentially empty (adapters either sit at the
 * spec floor or well above 28).
 *
 * @private
 */
export function computeGlobeImagerySlotCount(
  limits: GPUSupportedLimits | undefined | null,
): number {
  const limit = limits?.maxSampledTexturesPerShaderStage ?? 16;
  return limit >= GLOBE_NON_IMAGERY_FRAGMENT_TEXTURES + MAX_IMAGERY_LAYERS
    ? MAX_IMAGERY_LAYERS
    : 4;
}

/**
 * Resolve an `ImageryLayer` property that the public API documents as either a
 * scalar or a callback `(frameState, layer, x, y, level) => number`. Writing
 * a Function into a Float32Array produces NaN which propagates through the
 * shader's multiplicative blend and makes the layer disappear on WebGPU.
 *
 * The callback signature matches WebGL's `ImageryLayerFeatureGetter`
 * convention: imagery layers that use it (hover-fade, time-of-day fade,
 * elevation-based fade) rely on per-tile arguments, so the tile rectangle's
 * level/x/y are passed when available.
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
  // True when `TerrainEncoding.hasGeodeticSurfaceNormals` is set, meaning the
  // last 3 floats of each vertex stride hold the WGS84 geodetic surface
  // normal. The pipeline builder then adds a `@location(2)` vec3 attribute and
  // activates the `GEODETIC_NORMAL` shader define so the exaggeration branch
  // uses the true geodetic normal instead of `normalize(position3D)`. When
  // false the shader define is off and the exaggeration branch falls back to
  // the ellipsocentric normal, which is sub-meter accurate near the equator
  // but drifts up to 0.2° at mid-latitudes on WGS84.
  hasGeodeticSurfaceNormals: boolean;
  meshGeneration: number;
  // Reference to the `mesh.vertices` Float32Array these GPU buffers were built
  // from. The cache key is only `${level}_${x}_${y}` and `meshGeneration` is
  // always 0 (nothing bumps `mesh._webgpuGeneration`), so without a
  // mesh-identity check the cache serves a tile's first-seen buffers forever,
  // even after `GlobeSurfaceTile.renderedMesh` swaps the fill/upsampled mesh
  // for the real terrain mesh at the same tile coordinates. Decoding that
  // stale vertex data with the current mesh's per-tile uniforms flings
  // individual vertices to Earth-radius distance and draws thin black
  // atmosphere-tinted wedge slivers during cold LOD refine — WebGPU only,
  // since WebGL re-uploads on every mesh change. A new mesh allocates a new
  // `vertices` array, so comparing the reference detects the swap and forces a
  // rebuild; an unchanged mesh keeps the identical reference and the cache
  // stays a byte-for-byte hit.
  sourceVertices: Float32Array;
  // Retains the source mesh without allocating a CPU payload or GPU buffer on
  // the default no-cast path. The first real cast demand packs the shared
  // 96-byte quantized/uncompressed layout, realizes the UB, and then releases
  // this extra mesh reference.
  shadowCastMesh?: CesiumTerrainMesh;
  shadowCastUniformData?: Float32Array;
  // Device identity for the optional lazy realization. A changed identity
  // forces deterministic retirement/recreation after device recovery.
  shadowCastDevice?: GPUDevice;
  shadowCastUB?: GPUBuffer;
  // Instrumented campaigns publish one nullable sink per renderer. Retaining
  // it here lets demand realization and eviction account for the resource
  // without threading a renderer host through the shadow-pass command.
  shadowCastCounters?: WebGPUGlobeLogicalCounters | null;
  shadowCastTileKey?: string;
}

/** Cached imagery texture */
export interface ImageryGPUTexture {
  texture: GPUTexture;
  view: GPUTextureView;
  sourceWidth: number;
  sourceHeight: number;
  /** Estimated owned allocation size, including mips, for diagnostics/lifetime. */
  byteSize?: number;
  /** Logical owner used by opt-in attribution; imported textures omit it. */
  logicalOwner?: "imagery";
  /**
   * When set, the texture and view are owned by this shared realization —
   * many tile cache entries reference the same one — not by this cache entry,
   * so the entry's cleanup releases the reference instead of destroying the
   * texture. Undefined means the cache entry owns its texture outright.
   */
  shared?: SharedImageryRealization;
}

/**
 * Opt-in logical counters used by the instrumented moving-camera campaign.
 *
 * The browser runner publishes the object before Cesium loads. Production and
 * clean timing runs leave it undefined, so the renderer allocates no counter
 * state and its instrumented sites reduce to nullable guards. These counters
 * cover JS objects and logical cache ownership that WebGPU API wrappers cannot
 * observe.
 *
 * @private
 */
export interface WebGPUGlobeLogicalCounters {
  /** Handshake proving an instrumented counter sink reached a renderer. */
  rendererInstancesAttached?: number;
  tileCalls?: number;
  readyLayerArrays?: number;
  readyLayers?: number;
  commandArrays?: number;
  passLayerSlices?: number;
  passDescriptors?: number;
  adapterCommandObjects?: number;
  pickCommandObjects?: number;
  cameraUniformPacks?: number;
  cameraUniformLogicalBytes?: number;
  cameraUniformAlignedBytes?: number;
  tileUniformPacks?: number;
  tileUniformLogicalBytes?: number;
  tileUniformAlignedBytes?: number;
  tileBufferCacheHits?: number;
  tileBufferCacheMisses?: number;
  tileBufferRebuilds?: number;
  tileBufferRetirements?: number;
  tileBufferLiveEntries?: number;
  tileBufferLiveBytes?: number;
  tileBufferHighWaterEntries?: number;
  tileBufferHighWaterBytes?: number;
  terrainShadowUniformDataPacks?: number;
  terrainShadowUniformBufferCreations?: number;
  terrainShadowUniformBufferWrites?: number;
  terrainShadowUniformBufferRetirements?: number;
  terrainShadowUniformBufferLiveEntries?: number;
  terrainShadowUniformBufferLiveBytes?: number;
  terrainShadowUniformBufferHighWaterEntries?: number;
  terrainShadowUniformBufferHighWaterBytes?: number;
  imageryTextureCacheHits?: number;
  imageryTextureCacheMisses?: number;
  imageryDirectUploads?: number;
  imageryDirectUploadBytes?: number;
  imageryOwnedRetirements?: number;
  imageryOwnedLiveTextures?: number;
  imageryOwnedLiveBytes?: number;
  imageryOwnedHighWaterTextures?: number;
  imageryOwnedHighWaterBytes?: number;
  /** Distinct shared imagery realizations created (a cache miss on the
   * shared table for a shareable, immutable source). */
  imageryRealizationsCreated?: number;
  /** Tile cache entries that referenced an existing shared realization
   * instead of realizing their own texture. */
  imageryRealizationShares?: number;
  /** Live bytes held by the shared realization table. */
  imageryRealizationLiveBytes?: number;
  /** Shared realizations retired through the grace LRU / teardown. */
  imageryRealizationRetirements?: number;
  /** Mip generations that fell back to a private draw-path submit because no
   * context was available. Stays 0 on the happy path — a probe tripwire. */
  imageryMipFallbackSubmits?: number;
  /** Times the per-frame globe effects handle was built fresh. */
  effectsHandlePrepares?: number;
  /** Times a tile or pass reused the prepared globe effects handle. */
  effectsHandleReuses?: number;
}

/** Descriptor for a single tile draw pass */
export interface TileDrawDescriptor {
  pipeline: GPURenderPipeline;
  // Globe terrain pick pipeline (fragmentPickMain, single pick-FBO target,
  // blend + G-buffer slot stripped, single-sample, depth-write forced on).
  // Present only on the primary first-pass color descriptor, never on the
  // translucency depth-only or back-face pre-pass descriptors. The scene
  // adapter (`addWebGPUDrawCommandsForTile`) builds the per-tile pick command
  // from this plus the same bind groups — the camera UB carries `pickColor` at
  // its tail — and attaches it via
  // `command.derivedCommands.picking.pickCommand`, so the WebGPU pick pass
  // dispatches it. `null` while the pipeline is still materializing in the
  // central cache, a one-frame skip like `pipeline`.
  pickPipeline?: GPURenderPipeline | null;
  bindGroups: GPUBindGroup[];
  // Dynamic byte offsets for group 0's three uniform-buffer bindings (camera
  // UB, tile UB, per-View eclipse UB). The group-0 bind group is built over
  // the ring page at offset 0 and these three values shift it to this draw's
  // actual slices at `setBindGroup(0, bg0, bindGroup0DynamicOffsets)` time.
  // Always a 3-element array `[cameraOffset, tileOffset, eclipseOffset]` when
  // group 0 uses the dynamic-offset layout, which is the standard path;
  // omitted only for the wireframe descriptors that do not route through group
  // 0 dynamically. The scene-adapter execute closure passes it straight
  // through to `renderPass.setBindGroup`.
  bindGroup0DynamicOffsets?: number[];
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  boundingVolume: CesiumBoundingSphere | undefined;
  isSubsequentPass: boolean;
  // Shadow-cast hints consumed by
  // `GlobeSurfaceTileProviderRendering.addWebGPUDrawCommandsForTile`, which
  // tags the generated scene command with the correct shadow-cast variant,
  // per-command UB, and effective VB stride. Every tile sets these three
  // fields; quantized tiles route to `quantized12` and uncompressed tiles to
  // `terrainUncompressed`.
  isQuantized?: boolean;
  shadowCastTerrainUB?: GPUBuffer;
  // Flagged when the tile's VB includes the geodetic surface normal attribute
  // (an extra 12 bytes / 3 floats at the tail of each vertex stride). It does
  // not affect shadow cast — the stride-aware pipeline registry handles any
  // stride through `strideBytes` below — but consumers that need to know
  // whether the attribute is present, such as the color pipeline, read it.
  hasGeodeticSurfaceNormals?: boolean;
  // The actual per-vertex byte stride of the tile's VB. The scene adapter
  // forwards it as `cmd.vertexStride` so the shadow-cast registry builds a
  // pipeline whose `arrayStride` matches. Without it the GPU walks the buffer
  // at the variant's declared default stride, silently misaligning every
  // vertex.
  strideBytes?: number;
  // Persistent owner for shadow-cast bind-group reuse. Globe tile draw
  // descriptors and their scene commands are rebuilt every frame, while the
  // TileGPUResources record survives for the lifetime of the cached mesh. The
  // renderer publishes that stable record here so the shadow renderer does not
  // fall back to caching on a transient command object.
  shadowCastBindGroupCacheHost?: object;
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
