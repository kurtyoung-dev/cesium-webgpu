/// <reference types="@webgpu/types" />
import { m4Values, gpuData } from "./webgpuTypeHelpers.js";
import {
  getEffectsBindGroupLayout,
  getPlaceholderEffects,
  createEffectsBindGroup,
} from "./WebGPUEffectsBindGroup.js";
import { assertCameraRTERoundTrip } from "./WebGPURTEAssertions.js";
import {
  makeBindGroupLayout,
  sampler,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import { preprocess as preprocessShaderSource } from "./WebGPUShaderPreprocessor.js";
/**
 * WebGPU Globe Surface Renderer
 *
 * Converts terrain tile data (from GlobeSurfaceTileProvider) into WebGPU
 * draw commands. Manages pipeline creation, vertex/index buffer upload,
 * imagery texture creation, and per-tile uniform buffer management.
 *
 * Supports:
 *   - Uncompressed terrain (TerrainQuantization.NONE)
 *   - Quantized terrain (TerrainQuantization.BITS12)
 *   - Up to 4 imagery layers per draw call (multi-pass for >4)
 *   - Water mask textures for ocean rendering
 *   - Day/night alpha blending per imagery layer
 *   - Cartographic limit rectangle clipping
 *   - Fog, atmosphere, and Lambert diffuse lighting
 *   - Multi-pass rendering for tiles with >4 imagery layers
 *   - Globe translucency blend pipeline variants
 *
 * @private
 */

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
const CAMERA_UNIFORM_FLOATS = 116;
const CAMERA_UNIFORM_BYTES = CAMERA_UNIFORM_FLOATS * 4;

// TileUniforms: layers(4×12=48) + layerCount(1) + fog(3) +
//   waterMaskTS(4) + cartLimitRect(4) + nightFade(2) +
//   dayNightAlpha0-3(4×2=8) + flags(4) + exaggeration(2) + time(1) + pad(1)
//   + oceanParams(4) + nightOceanParams(4) + useWebMercatorTLayer(4)
//   + debugFields(4) + hsbShift(4) = 100 floats
//
// debugFields layout (offsets 92-95):
//   .x = tileLevel (LOD depth integer, read by fragmentDebugLod)
//   .y = isolateImageryLayer (-1 or 0..3, read by fragmentMain)
//   .z, .w = reserved
// hsbShift layout (offsets 96-99) — DP-H24, mirrors WebGL GlobeFS.glsl
// `u_hsbShift`. Sourced from `tileProvider.hueShift / saturationShift /
// brightnessShift`. Shader skips the HSB round-trip when all three are
// within ±0.001 of zero, so the default case is free.
const TILE_UNIFORM_FLOATS = 100;
const TILE_UNIFORM_BYTES = TILE_UNIFORM_FLOATS * 4;

// Max imagery layers per tile in single draw call
const MAX_IMAGERY_LAYERS = 4;

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
function resolveImageryLayerValue(
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
function multiplyMat4ColumnMajor(
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
const enum PipelineKey {
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
interface TileGPUResources {
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
interface ImageryGPUTexture {
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

export class WebGPUGlobeSurfaceRenderer {
  private _device: GPUDevice | null = null;
  private _diagTileCount = 0;
  private _diagLastLogTime = 0;
  private _diagLastLayerCountLogMs = 0;
  private _diagLastFogLogMs = 0;
  private _diagFogMissingLogged = false;
  private _lastOverflowWarnTime = 0;

  /**
   * Throttle diagnostic logs to once per 3 seconds AND only the first tile.
   * In production builds (`removePragmas: true`), this method is replaced
   * with a constant `false` return by the pragma stripper, so the
   * diagnostic code at each call site is dead-code-eliminated by esbuild.
   */
  private _diagShouldLog(): boolean {
    //>>includeStart('debug', pragmas.debug);
    if (this._diagTileCount !== 0) return false;
    const now = performance.now();
    if (now - this._diagLastLogTime < 3000) return false;
    this._diagLastLogTime = now;
    return true;
    //>>includeEnd('debug');
    return false;
  }
  // BUG-11 imagery probe — last observed value of `frameState.debugShowImageryProbe`,
  // used to detect the rising edge so the probe latch resets when the
  // operator toggles the flag back on for a second sample.
  private _lastProbeFlag = false;
  private _pipelineCache: Map<string, GPURenderPipeline> = new Map();
  // Batch 20 — the production shader module is now resolved through the
  // `WebGPUShaderModuleCache` keyed by `(ShaderSourceId.GLOBE_TERRAIN, defines)`.
  // The cache runs the `//>>ifdef` preprocessor against `_shaderCode` on
  // first use per define-set and deduplicates repeat requests. Prewarmed at
  // `initialize()` time with the common define sets so first-frame render
  // pays no shader-compile cost.
  private _shaderModuleCache: WebGPUShaderModuleCache | null = null;
  // Source preserved so we can lazily augment it with debug fragment
  // entry points (triangulation / LOD overlay / normal-as-color) and the
  // hardware clip-distances variant. Consumers run the preprocessor on
  // this raw source before creating derived modules.
  private _shaderCode: string = "";
  // Debug fragment augmented modules, keyed by active-defines bitmask. A
  // `null` value means the device rejected the augmented source for that
  // define-set during the one-shot validation probe — subsequent lookups
  // return null and the caller falls back to the production fragment.
  private _debugFragmentShaderModules = new Map<number, GPUShaderModule | null>();
  private _debugFragmentPipelineCache: Map<string, GPURenderPipeline> =
    new Map();
  // Phase 5 WGF-1: hardware clip-distances shader variant. Built lazily
  // by string-augmenting a preprocessed `_shaderCode` to (a) declare the
  // `@builtin(clip_distances)` vertex output and (b) compute it from the
  // precomputed `effects.clipPlaneEqHW` values. The fragment-side
  // `globeClipByPlanes` discard is neutralized in the augmented source so
  // the rasterizer is the sole authority. Probed once per active-defines
  // set; cached forever. `null` value after probe means the device
  // rejected the augmented source (driver bug or missing feature) and the
  // production module is the fallback.
  private _clipDistancesShaderModules = new Map<number, GPUShaderModule | null>();
  private _sampler: GPUSampler | null = null;
  private _waterMaskSampler: GPUSampler | null = null;
  private _bindGroupLayout0: GPUBindGroupLayout | null = null;
  private _bindGroupLayout1: GPUBindGroupLayout | null = null;
  private _bindGroupLayout2: GPUBindGroupLayout | null = null;
  // Group 3 is now the effects bind group (merged water+ocean into group 2)
  private _effectsBGL: GPUBindGroupLayout | null = null;
  private _placeholderEffectsBG: GPUBindGroup | null = null;
  private _oceanNormalSampler: GPUSampler | null = null;
  private _oceanNormalMapCache: Map<string, ImageryGPUTexture> = new Map();
  private _pipelineLayout: GPUPipelineLayout | null = null;
  private _placeholderTexture: GPUTexture | null = null;
  private _placeholderView: GPUTextureView | null = null;
  private _canvasFormat: GPUTextureFormat = "bgra8unorm";

  // Wireframe pipelines — keyed by the same shape string used by
  // _selectPipeline so they share variant granularity (Q/U, N/X, M/G, stride).
  // Lazily built on first wireframe request; production cache is untouched.
  private _wireframePipelineCache: Map<string, GPURenderPipeline> = new Map();
  private _wireframeIndexCache: Map<
    string,
    { buffer: GPUBuffer; count: number; format: GPUIndexFormat }
  > = new Map();

  // Per-tile GPU resource caches
  private _tileBufferCache: Map<string, TileGPUResources> = new Map();
  private _imageryTextureCache: Map<string, ImageryGPUTexture> = new Map();
  private _waterMaskTextureCache: Map<string, ImageryGPUTexture> = new Map();

  // Reusable typed arrays for uniform data
  private _cameraUniformData: Float32Array = new Float32Array(
    CAMERA_UNIFORM_FLOATS,
  );
  // Scratch for projection × modifiedModelView (column-major Float64).
  // 2D/CV/Morphing paths in the vertex shader use this matrix instead of
  // mvpRelativeToEye, since their positions are planar (not RTE).
  private _cameraMvpScratch: Float64Array = new Float64Array(16);
  private _tileUniformData: Float32Array = new Float32Array(
    TILE_UNIFORM_FLOATS,
  );
  private _tileUniformU32View: Uint32Array;

  private _isDestroyed: boolean = false;
  private _isInitialized: boolean = false;

  constructor() {
    this._tileUniformU32View = new Uint32Array(this._tileUniformData.buffer);
  }

  /**
   * Initialize the renderer with the GPU device and shader code.
   */
  initialize(
    device: GPUDevice,
    shaderCode: string,
    canvasFormat: GPUTextureFormat,
  ): void {
    if (this._isInitialized) return;
    this._device = device;
    this._canvasFormat = canvasFormat;

    this._initShaderCache(shaderCode);
    this._createBindGroupLayouts();
    this._createPipelineLayout();
    this._createSamplers();
    this._createPlaceholderTexture();
    // Pipelines are created lazily in _selectPipeline based on actual tile stride
    this._isInitialized = true;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  // ─── Shader Module Cache ─────────────────────────────────────────
  // Batch 20 — the globe terrain shader flows through `WebGPUShaderModuleCache`
  // which preprocesses `//>>ifdef` directives against an active-defines bitmask,
  // deduplicates module compilation across wireframe/debug/production pipelines
  // that share a source, and prewarms common variants so the first-frame
  // render path has no shader-compile jank.
  private _initShaderCache(code: string): void {
    this._shaderCode = code;
    this._shaderModuleCache = new WebGPUShaderModuleCache(this._device!);

    // Prewarm: the baseline module plus every variant we expect the first
    // ~30 frames of rendering to touch. Compiling them up-front moves
    // ~10–20 ms of shader-compile cost off the render path. The list is
    // deliberately concrete rather than computed — it should match the
    // call sites in `_createPipelineVariant` / `_createWireframePipelineVariant`.
    const prewarmSets: readonly number[] = [
      0, // production terrain without geodetic normals
      ShaderDefine.GEODETIC_NORMAL, // DP-H25 path for exaggerated terrain
    ];
    this._shaderModuleCache.prewarm(
      ShaderSourceId.GLOBE_TERRAIN,
      code,
      prewarmSets,
      "GlobeTerrain shader",
    );
  }

  /**
   * Resolve the production terrain shader module for a given active-defines
   * bitmask. First call per define-set runs the `//>>ifdef` preprocessor and
   * `createShaderModule`; later calls return the cached module directly.
   */
  private _getProductionShaderModule(defines: number): GPUShaderModule {
    return this._shaderModuleCache!.getOrCreate(
      ShaderSourceId.GLOBE_TERRAIN,
      this._shaderCode,
      defines,
      "GlobeTerrain shader",
    );
  }

  /**
   * Lazily builds the augmented shader module that hosts every debug
   * fragment entry point. The vertex stages are reused unchanged from the
   * production module, so the augmented version can pair with any of the
   * existing `vertexMain*` variants — only the fragment binding differs.
   *
   * Hosted entry points:
   *   - `fragmentDebugTri`     — per-triangle face color via @builtin(primitive_index)
   *   - `fragmentDebugLod`     — tile depth-level color overlay (reads tile.tileLevel)
   *   - `fragmentDebugNormal`  — eye-space normal mapped into RGB
   *
   * Wrapped in `pushErrorScope("validation")` so a driver that rejects
   * `@builtin(primitive_index)` (older Mali/Intel paths) disables the
   * entire debug path silently instead of crashing the frame.
   *
   * Returns null if the device fails to compile the augmented module.
   * Result is cached forever.
   */
  private _getDebugFragmentShaderModule(
    defines: number,
  ): GPUShaderModule | null {
    // Probe-and-cache per active-defines set. A `null` value means the
    // device rejected the augmented source for this define-set during
    // the one-shot validation probe; don't retry.
    if (this._debugFragmentShaderModules.has(defines)) {
      return this._debugFragmentShaderModules.get(defines) ?? null;
    }
    const device = this._device;
    if (!device || !this._shaderCode) {
      return null;
    }

    // Batch 20 — run the `//>>ifdef` preprocessor on the base source
    // FIRST, then append the debug fragment entry points. If we skipped
    // preprocessing, the raw directive lines between `//>>ifdef` /
    // `//>>endif` would be comments but the body lines between them
    // would accumulate (both branches of the if/else materialize),
    // producing invalid WGSL like `f(a); g(b));`.
    const preprocessedBase = preprocessShaderSource(this._shaderCode, defines);

    // The three debug fragment entry points share the same vertex outputs
    // as the production fragment, so they can be appended to the existing
    // shader source without touching VertexOutput / TileUniforms.
    //
    // - fragmentDebugTri: uses @builtin(primitive_index) for face coloring.
    // - fragmentDebugLod: reads `tile.tileLevel` (added to TileUniforms in
    //   this session) and maps it to a deterministic color.
    // - fragmentDebugNormal: emits the interpolated eye-space normal as
    //   RGB after a [-1,1]→[0,1] remap. Useful for verifying the
    //   normal-map shaders we modernized in WGF-5.
    const augmented = `${preprocessedBase}

@fragment
fn fragmentDebugTri(@builtin(primitive_index) primIndex: u32)
    -> @location(0) vec4<f32> {
  let r = f32((primIndex * 73u) & 255u) / 255.0;
  let g = f32((primIndex * 151u + 31u) & 255u) / 255.0;
  let b = f32((primIndex * 211u + 89u) & 255u) / 255.0;
  return vec4<f32>(r, g, b, 1.0);
}

@fragment
fn fragmentDebugLod(input: VertexOutput) -> @location(0) vec4<f32> {
  // Deterministic per-level palette: 12 hues cycle through the spectrum
  // so adjacent levels are visually distinct. Levels above 11 wrap.
  let level = u32(tile.debugFields.x + 0.5) % 12u;
  var color: vec3<f32>;
  switch (level) {
    case 0u:  { color = vec3<f32>(1.00, 0.00, 0.00); }
    case 1u:  { color = vec3<f32>(1.00, 0.50, 0.00); }
    case 2u:  { color = vec3<f32>(1.00, 1.00, 0.00); }
    case 3u:  { color = vec3<f32>(0.50, 1.00, 0.00); }
    case 4u:  { color = vec3<f32>(0.00, 1.00, 0.00); }
    case 5u:  { color = vec3<f32>(0.00, 1.00, 0.50); }
    case 6u:  { color = vec3<f32>(0.00, 1.00, 1.00); }
    case 7u:  { color = vec3<f32>(0.00, 0.50, 1.00); }
    case 8u:  { color = vec3<f32>(0.00, 0.00, 1.00); }
    case 9u:  { color = vec3<f32>(0.50, 0.00, 1.00); }
    case 10u: { color = vec3<f32>(1.00, 0.00, 1.00); }
    default:  { color = vec3<f32>(1.00, 0.00, 0.50); }
  }
  return vec4<f32>(color, 1.0);
}

@fragment
fn fragmentDebugNormal(input: VertexOutput) -> @location(0) vec4<f32> {
  // Eye-space normal as RGB. Remap from [-1,1] to [0,1] so all components
  // are visible. Useful for verifying that vertex normals are correctly
  // interpolated and that the normal-map shaders (WGF-5) produce
  // sensible orientations. Flat-shaded tiles will show single colors
  // per primitive; smooth-shaded tiles will show gradients.
  let n = normalize(input.v_normalEC);
  return vec4<f32>(n * 0.5 + 0.5, 1.0);
}
`;

    try {
      device.pushErrorScope("validation");
      const mod = device.createShaderModule({
        label: `GlobeTerrain shader (debug variants, defines=0x${defines.toString(16)})`,
        code: augmented,
      });
      // Drain the validation scope. If the driver rejected the builtin we
      // still hold the module reference, but the next pipeline build will
      // fail noisily — replace the entry with `null` so we never retry
      // for this define-set.
      device.popErrorScope().then((err) => {
        if (err) {
          this._debugFragmentShaderModules.set(defines, null);
          console.warn(
            `[WebGPUGlobeSurfaceRenderer] debug fragment variants disabled ` +
              `for defines=0x${defines.toString(16)}: ${err.message}`,
          );
        }
      });
      this._debugFragmentShaderModules.set(defines, mod);
      return mod;
    } catch (e) {
      this._debugFragmentShaderModules.set(defines, null);
      return null;
    }
  }

  /**
   * Phase 5 WGF-1: build (and cache) the GlobeTerrain shader module
   * variant that uses `@builtin(clip_distances)` for hardware clipping
   * planes. The base source is augmented in three places:
   *
   *   1. The `VertexOutput` struct gets a new
   *      `@builtin(clip_distances) clipDistances: array<f32, 8>` member.
   *
   *   2. The `processVertex` function writes 8 clip distances at the
   *      end (right after the existing far-plane Z clamp), each computed
   *      as `dot(eqHW.xyz, eyePos) + eqHW.w` against
   *      `effects.clipPlaneEqHW[i]`. The CPU has already precomputed
   *      `eqHW = (n.xyz, d + dot(n, cameraWC))` in FP64 — see
   *      `WebGPUClipDistancePrecompute.ts`.
   *
   *   3. The fragment-side `globeClipByPlanes(input.v_positionMC)`
   *      discard is neutralized so the rasterizer is the sole authority
   *      for the clipping decision. The edge-highlight code path that
   *      reads `clippingPlaneTex` for visualization is left untouched
   *      because it's a color decoration, not a geometric clip.
   *
   * The variant requires the `clip-distances` device feature; the caller
   * gates pipeline creation on `context.useHardwareClipDistances`.
   * Returns null if the device rejects the augmented source — callers
   * fall back to the production module + the legacy fragment-discard
   * path.
   */
  private _getClipDistancesShaderModule(
    defines: number,
  ): GPUShaderModule | null {
    // Probe-and-cache per active-defines set; same pattern as the debug
    // fragment module.
    if (this._clipDistancesShaderModules.has(defines)) {
      return this._clipDistancesShaderModules.get(defines) ?? null;
    }
    const device = this._device;
    if (!device || !this._shaderCode) {
      return null;
    }

    // Batch 20 — preprocess first so the anchor-string search in
    // `_buildClipDistancesShaderSource` sees a valid-WGSL base. Without
    // preprocessing, the `//>>ifdef` body lines (e.g. the extra
    // `input.geodeticSurfaceNormal` arg) would still be present and
    // would match the anchor patterns but produce invalid output when
    // combined with the `//>>else` branch.
    const preprocessedBase = preprocessShaderSource(this._shaderCode, defines);
    const augmented = this._buildClipDistancesShaderSource(preprocessedBase);
    if (augmented === null) {
      console.warn(
        "[WebGPUGlobeSurfaceRenderer] clip-distances shader augmentation " +
          "could not locate one of its anchor strings; falling back to the " +
          "fragment-discard path.",
      );
      this._clipDistancesShaderModules.set(defines, null);
      return null;
    }

    try {
      device.pushErrorScope("validation");
      const mod = device.createShaderModule({
        label: `GlobeTerrain shader (clip-distances variant, defines=0x${defines.toString(16)})`,
        code: augmented,
      });
      device.popErrorScope().then((err) => {
        if (err) {
          this._clipDistancesShaderModules.set(defines, null);
          console.warn(
            `[WebGPUGlobeSurfaceRenderer] clip-distances variant disabled ` +
              `for defines=0x${defines.toString(16)}: ${err.message}`,
          );
        }
      });
      this._clipDistancesShaderModules.set(defines, mod);
      return mod;
    } catch (e) {
      this._clipDistancesShaderModules.set(defines, null);
      return null;
    }
  }

  /**
   * Pure string transformation: take the base GlobeTerrain.wgsl source and
   * return the clip-distances variant. Returns null when any of the three
   * anchor strings is missing — that means the source has drifted and the
   * substitution is unsafe.
   *
   * Kept as a separate method (not inlined) so it can be unit-tested
   * against fixture sources without needing a real GPUDevice.
   */
  private _buildClipDistancesShaderSource(source: string): string | null {
    // Anchor 1: VertexOutput struct definition. Inject the builtin
    // clip-distances output as the last member, right before the closing
    // brace. We match the precise existing v_distance line so the patch
    // can't drift onto an unrelated struct.
    const vertexOutputAnchor = "@location(4) v_distance: f32,\n};";
    if (!source.includes(vertexOutputAnchor)) {
      return null;
    }
    let out = source.replace(
      vertexOutputAnchor,
      "@location(4) v_distance: f32,\n" +
        "  // WGF-1: hardware clip distances. The 8 entries hold the\n" +
        "  // signed distance from the eye-relative vertex position to\n" +
        "  // each clipping plane; the rasterizer clips fragments where\n" +
        "  // any value is < 0. Slots beyond the active plane count are\n" +
        "  // computed against `(0,0,0,+inf)` and trivially survive.\n" +
        "  @builtin(clip_distances) clipDistances: array<f32, 8>,\n" +
        "};",
    );

    // Anchor 2: end of processVertex (right after the far-plane Z clamp).
    // Compute eyeRelativePos in WC, then write all 8 clip distances. The
    // 2D / Columbus / Morphing branches don't go through the RTE path,
    // so eyePos is the direct (positionWC - cameraWC) which gives
    // FP32-precision 0.6m noise at Earth radius — fine because clipping
    // planes are the only consumer and they have meter-scale tolerance.
    // For the SCENE3D path, the same expression is exactly the
    // `rtePosition.xyz` we already computed; recomputing it here lets the
    // augmentation work uniformly across all four scene modes.
    const processVertexAnchor =
      "out.position.z = min(out.position.z, out.position.w);\n\n  return out;";
    if (!out.includes(processVertexAnchor)) {
      return null;
    }
    const cdInjection =
      "out.position.z = min(out.position.z, out.position.w);\n\n" +
      "  // WGF-1: emit hardware clip distances. eyePosWC reconstructs the\n" +
      "  // eye-relative position in the same coordinate frame the CPU used\n" +
      "  // when precomputing `effects.clipPlaneEqHW`. We use position3DWC\n" +
      "  // (the world-space terrain position) and subtract the unencoded\n" +
      "  // camera (high+low). At Earth radius this is FP32 with ~0.6 m\n" +
      "  // noise, which is comfortably below the meter-scale tolerance of\n" +
      "  // any realistic clipping plane test.\n" +
      "  let cdEyePos = position3DWC - (camera.encodedCameraHigh + camera.encodedCameraLow);\n" +
      "  for (var cdI: u32 = 0u; cdI < 8u; cdI = cdI + 1u) {\n" +
      "    let eq = effects.clipPlaneEqHW[cdI];\n" +
      "    out.clipDistances[cdI] = dot(eq.xyz, cdEyePos) + eq.w;\n" +
      "  }\n\n" +
      "  return out;";
    out = out.replace(processVertexAnchor, cdInjection);

    // Anchor 3: fragment-side discard. The legacy path is unconditionally
    // safe to remove because the rasterizer's clip distance check is a
    // strict superset (it operates on every interpolated pixel of every
    // clipped triangle). We replace the discard line with a comment so
    // line numbers in errors stay close to the original.
    const fragmentDiscardAnchor =
      "if (globeClipByPlanes(input.v_positionMC)) { discard; }";
    if (!out.includes(fragmentDiscardAnchor)) {
      return null;
    }
    out = out.replace(
      fragmentDiscardAnchor,
      "// WGF-1: clipping handled by rasterizer via @builtin(clip_distances).",
    );

    // The clip_distances builtin requires an `enable` directive at the top
    // of the WGSL file (matches the f16 / subgroups pattern). The directive
    // must precede every other declaration; prepend it unconditionally.
    return `enable clip_distances;\n${out}`;
  }

  // ─── Bind Group Layouts ───
  private _createBindGroupLayouts(): void {
    const device = this._device!;

    // Group 0: Camera + Tile uniform buffers
    this._bindGroupLayout0 = makeBindGroupLayout(
      device,
      "Globe terrain uniforms layout",
      [
        uniformBuffer(0, Stage.VERTEX_FRAGMENT),
        uniformBuffer(1, Stage.VERTEX_FRAGMENT),
      ],
    );

    // Group 1: Day imagery textures (4) + shared sampler at binding 4
    this._bindGroupLayout1 = makeBindGroupLayout(
      device,
      "Globe terrain textures layout",
      [
        texture(0, Stage.FRAGMENT),
        texture(1, Stage.FRAGMENT),
        texture(2, Stage.FRAGMENT),
        texture(3, Stage.FRAGMENT),
        sampler(4, Stage.FRAGMENT),
      ],
    );

    // Group 2: Water mask + Ocean normal map (merged to stay within 4 bind groups)
    this._bindGroupLayout2 = makeBindGroupLayout(
      device,
      "Globe water mask + ocean normal layout",
      [
        texture(0, Stage.FRAGMENT),
        sampler(1, Stage.FRAGMENT),
        texture(2, Stage.FRAGMENT),
        sampler(3, Stage.FRAGMENT),
      ],
    );

    // Group 3: Effects (shadow receive + clipping planes) — shared layout
    this._effectsBGL = getEffectsBindGroupLayout(device);
    const placeholder = getPlaceholderEffects(device);
    this._placeholderEffectsBG = placeholder.bindGroup;
  }

  // ─── Pipeline Layout ───
  private _createPipelineLayout(): void {
    this._pipelineLayout = this._device!.createPipelineLayout({
      label: "Globe terrain pipeline layout",
      bindGroupLayouts: [
        this._bindGroupLayout0!,
        this._bindGroupLayout1!,
        this._bindGroupLayout2!,
        this._effectsBGL!,
      ],
    });
  }

  // ─── Samplers ───
  private _createSamplers(): void {
    this._sampler = this._device!.createSampler({
      label: "Globe terrain sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    // Water mask uses linear filtering to match WebGL — matches the WGSL's
    // `smoothstep(0.3, 0.7, waterMask)` transition, which can't smooth a
    // purely binary (nearest-sampled) value. Nearest filtering produces
    // jagged staircase coastlines at any zoom level.
    this._waterMaskSampler = this._device!.createSampler({
      label: "Globe water mask sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    // Ocean normal map uses repeating linear filtering for tiled wave patterns
    this._oceanNormalSampler = this._device!.createSampler({
      label: "Globe ocean normal sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
  }

  // ─── Placeholder 1×1 white texture ───
  private _createPlaceholderTexture(): void {
    const device = this._device!;
    this._placeholderTexture = device.createTexture({
      label: "Globe placeholder texture",
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this._placeholderTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
    this._placeholderView = this._placeholderTexture.createView();
  }

  // ─── Render Pipelines (lazily created per actual vertex stride) ───
  private _createPipelineVariant(
    isQuantized: boolean,
    hasNormals: boolean,
    hasWebMercatorT: boolean,
    isBlend: boolean,
    strideBytes: number,
    debugFragmentMode: DebugFragmentMode = DebugFragmentMode.NONE,
    useClipDistances: boolean = false,
    hasGeodeticSurfaceNormals: boolean = false,
  ): GPURenderPipeline {
    const device = this._device!;

    let vertexBuffers: GPUVertexBufferLayout[];
    let entryPoint: string;

    // DP-H25 (Batch 19) — when the encoding includes geodetic surface
    // normals they occupy the trailing 3 floats (12 bytes) of the stride
    // and the shader's `GEODETIC_NORMAL` define (Batch 20) activates the
    // `@location(2) geodeticSurfaceNormal` input + the exaggeration
    // branch override. The entry-point NAMES are unqualified — the
    // module compiled with `GEODETIC_NORMAL=on` contains the same entry
    // point names, just with different struct membership.
    if (isQuantized) {
      // BITS12 quantized: compressed0 layout depends on encoding flags.
      // Three cases (see TerrainEncoding.getAttributes:680-691):
      //   hasWebMercatorT && hasNormals: compressed0.w = compressed webMercT,
      //     and the oct-encoded normal lives in a single-float compressed1
      //     attribute at location 1 (extra 4 bytes of stride).
      //   hasWebMercatorT (no normals): compressed0.w = compressed webMercT.
      //   hasNormals (no webMercT):    compressed0.w = encodedNormal.
      //   neither:                      compressed0 has only 3 components.
      let format: GPUVertexFormat;
      const hasCompressed1 = hasWebMercatorT && hasNormals;
      if (hasCompressed1) {
        format = "float32x4";
        entryPoint = "vertexMainQuantizedWebMercNormals";
      } else if (hasWebMercatorT) {
        format = "float32x4";
        entryPoint = "vertexMainQuantizedWebMerc";
      } else if (hasNormals) {
        format = "float32x4";
        entryPoint = "vertexMainQuantized";
      } else {
        format = "float32x3";
        entryPoint = "vertexMainQuantized";
      }
      // Stride math: base compressed0 is 16 bytes (4 floats) or 12 bytes
      // (3 floats, neither-case). Add 4 more bytes for compressed1 when
      // both webMercT and normals are present. DP-H25 appends 12 bytes
      // for the geodetic normal at the end of stride.
      const baseStride = hasWebMercatorT || hasNormals ? 16 : 12;
      const minStride =
        baseStride +
        (hasCompressed1 ? 4 : 0) +
        (hasGeodeticSurfaceNormals ? 12 : 0);
      const actualStride = Math.max(strideBytes, minStride);
      const attributes: GPUVertexAttribute[] = [
        { shaderLocation: 0, offset: 0, format },
      ];
      if (hasCompressed1) {
        attributes.push({
          shaderLocation: 1,
          offset: 16,
          format: "float32",
        });
      }
      if (hasGeodeticSurfaceNormals) {
        // Offset = (stride - 12) so the attribute points at the last 3
        // floats of the stride. TerrainEncoding always appends geodetic
        // normals after every other attribute (TerrainEncoding.js:625-628),
        // so `actualStride - 12` is the canonical location.
        attributes.push({
          shaderLocation: 2,
          offset: actualStride - 12,
          format: "float32x3",
        });
      }
      vertexBuffers = [
        {
          arrayStride: actualStride,
          stepMode: "vertex",
          attributes,
        },
      ];
    } else {
      // Uncompressed vertex data layout (per TerrainEncoding):
      //   [0-3]: posX, posY, posZ, height  (float32x4 @ location 0)
      //   [4-5]: u, v                      (always present)
      //   [6]:   webMercatorT              (if hasWebMercatorT)
      //   [6/7]: encodedNormal             (if hasVertexNormals, after webMercatorT if both)
      //
      // We read all data after position as a single attribute at location 1:
      //   - No extras:           float32x2 (u, v)         → vertexMain
      //   - webMercT only:       float32x3 (u, v, mercT)  → vertexMainWebMerc
      //   - normals only:        float32x3 (u, v, normal)  → vertexMain
      //   - webMercT + normals:  float32x4 (u, v, mercT, normal) → vertexMainWebMercNormals
      let texCoordFormat: GPUVertexFormat;
      if (hasWebMercatorT && hasNormals) {
        texCoordFormat = "float32x4";
        entryPoint = "vertexMainWebMercNormals";
      } else if (hasWebMercatorT) {
        texCoordFormat = "float32x3";
        entryPoint = "vertexMainWebMerc";
      } else if (hasNormals) {
        texCoordFormat = "float32x3";
        entryPoint = "vertexMain";
      } else {
        texCoordFormat = "float32x2";
        entryPoint = "vertexMain";
      }
      // Base uncompressed stride is 24 bytes (pos4 + tex2). DP-H25 adds
      // 12 more bytes when geodetic normals are present.
      const minUncompressedStride = 24 + (hasGeodeticSurfaceNormals ? 12 : 0);
      const actualStride = Math.max(strideBytes, minUncompressedStride);
      const attributes: GPUVertexAttribute[] = [
        { shaderLocation: 0, offset: 0, format: "float32x4" },
        { shaderLocation: 1, offset: 16, format: texCoordFormat },
      ];
      if (hasGeodeticSurfaceNormals) {
        attributes.push({
          shaderLocation: 2,
          offset: actualStride - 12,
          format: "float32x3",
        });
      }
      vertexBuffers = [
        {
          arrayStride: actualStride,
          stepMode: "vertex",
          attributes,
        },
      ];
    }

    const quantLabel = isQuantized ? "quantized" : "uncompressed";
    const normLabel = hasNormals ? "normals" : "noNormals";
    const blendLabel = isBlend ? "blend" : "opaque";

    // Blend state for subsequent imagery passes (additive alpha blending)
    const blendState: GPUBlendState | undefined = isBlend
      ? {
          color: {
            srcFactor: "src-alpha",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
          alpha: {
            srcFactor: "one",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
        }
      : undefined;

    // Batch 20 — resolve the correct production shader module for the
    // active-defines set. DP-H25's geodetic-normal path flips the
    // `GEODETIC_NORMAL` define; the cache hands back the preprocessed
    // module. Augmented variants (debug fragment / clip distances)
    // inherit the same define set so their base source stays consistent
    // with the pipeline's vertex buffer layout.
    const defines = hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0;
    const productionModule = this._getProductionShaderModule(defines);
    // Phase 5 WGF-1: when the hardware clip-distances variant is requested,
    // both stages must come from the augmented module — the vertex stage
    // declares the `@builtin(clip_distances)` output, and the fragment
    // stage's `globeClipByPlanes` discard has been neutralized to avoid
    // double-clipping.
    let vertexModule: GPUShaderModule = productionModule;
    let fragmentModule: GPUShaderModule = productionModule;
    let cdLabel: string = "";
    if (useClipDistances) {
      const cdModule = this._getClipDistancesShaderModule(defines);
      if (cdModule) {
        vertexModule = cdModule;
        fragmentModule = cdModule;
        cdLabel = ", clipDist";
      }
      // If null, the augmentation failed and we silently fall back to the
      // production module + the legacy fragment-discard path. The caller's
      // cache key still distinguishes useClipDistances=true variants, so
      // we just hand back a "production" pipeline under that key.
    }
    let fragmentEntry: string = "fragmentMain";
    let debugLabel: string = "";
    const debugFragModule =
      debugFragmentMode !== DebugFragmentMode.NONE
        ? this._getDebugFragmentShaderModule(defines)
        : null;
    if (debugFragmentMode !== DebugFragmentMode.NONE && debugFragModule) {
      fragmentModule = debugFragModule;
      switch (debugFragmentMode) {
        case DebugFragmentMode.TRIANGULATION:
          fragmentEntry = "fragmentDebugTri";
          debugLabel = ", debugTri";
          break;
        case DebugFragmentMode.LOD:
          fragmentEntry = "fragmentDebugLod";
          debugLabel = ", debugLod";
          break;
        case DebugFragmentMode.NORMAL:
          fragmentEntry = "fragmentDebugNormal";
          debugLabel = ", debugNormal";
          break;
      }
    }

    return device.createRenderPipeline({
      label: `Globe terrain (${quantLabel}, ${normLabel}, ${blendLabel}${debugLabel}${cdLabel})`,
      layout: this._pipelineLayout!,
      vertex: {
        module: vertexModule,
        entryPoint,
        buffers: vertexBuffers,
      },
      fragment: {
        module: fragmentModule,
        entryPoint: fragmentEntry,
        targets: [
          {
            format: this._canvasFormat,
            blend: blendState,
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "back",
        frontFace: "ccw",
      },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: !isBlend,
        // ALWAYS use less-equal (not less), even for the first pass.
        // Planetary-scale FP32 precision can push the globe's clip-space
        // Z up against the far plane, and the paired vertex-shader clamp
        // `position.z = min(position.z, position.w)` produces exactly
        // z/w=1 for those vertices. `less` would discard them; we need
        // `less-equal` so they survive the depth test against the
        // cleared depth buffer (which starts at 1.0).
        depthCompare: "less-equal",
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Pipeline Selection (lazy creation, keyed by actual vertex stride)
  // ═══════════════════════════════════════════════════════════════════════

  private _selectPipeline(
    isQuantized: boolean,
    hasNormals: boolean,
    hasWebMercatorT: boolean,
    isBlend: boolean,
    strideBytes: number,
    useClipDistances: boolean = false,
    hasGeodeticSurfaceNormals: boolean = false,
  ): GPURenderPipeline {
    // Phase 5 WGF-1: cache key includes a `C` suffix for the
    // hardware clip-distances variant so it shares the production cache
    // map cleanly without colliding with the legacy variants.
    // Batch 20: the active-defines bitmask (DP-H25's `GEODETIC_NORMAL`
    // and any future flags) appears as a `|0xNN` hex suffix so the
    // pipeline cache stays in sync with the shader module cache key.
    const cdSuffix = useClipDistances ? "_CD" : "";
    const defines = hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0;
    const cacheKey = `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}${isBlend ? "B" : "O"}_${strideBytes}${cdSuffix}|${defines.toString(16)}`;
    let pipeline = this._pipelineCache.get(cacheKey);
    if (!pipeline) {
      pipeline = this._createPipelineVariant(
        isQuantized,
        hasNormals,
        hasWebMercatorT,
        isBlend,
        strideBytes,
        DebugFragmentMode.NONE,
        useClipDistances,
        hasGeodeticSurfaceNormals,
      );
      this._pipelineCache.set(cacheKey, pipeline);
    }
    return pipeline;
  }

  /**
   * Cold path used when any of the per-fragment debug modes
   * (TRIANGULATION / LOD / NORMAL) is active for this frame. Kept off
   * `_selectPipeline` so the production hot path stays branch-free.
   *
   * Returns null when:
   *   - the requested mode is NONE (caller should use the production path)
   *   - the device fails the augmented-module compile probe (driver
   *     missing primitive_index support, etc.) — caller should fall back
   *     to the production pipeline transparently
   *
   * Cache key includes the mode integer so the four debug variants share
   * a single map without collision. Production cache is untouched.
   */
  private _selectDebugFragmentPipeline(
    mode: DebugFragmentMode,
    isQuantized: boolean,
    hasNormals: boolean,
    hasWebMercatorT: boolean,
    isBlend: boolean,
    strideBytes: number,
    hasGeodeticSurfaceNormals: boolean = false,
  ): GPURenderPipeline | null {
    if (mode === DebugFragmentMode.NONE) {
      return null;
    }
    if (!this._getDebugFragmentShaderModule()) {
      return null;
    }
    const defines = hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0;
    const cacheKey = `${mode}_${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}${isBlend ? "B" : "O"}_${strideBytes}|${defines.toString(16)}`;
    let pipeline = this._debugFragmentPipelineCache.get(cacheKey);
    if (!pipeline) {
      pipeline = this._createPipelineVariant(
        isQuantized,
        hasNormals,
        hasWebMercatorT,
        isBlend,
        strideBytes,
        mode,
        false,
        hasGeodeticSurfaceNormals,
      );
      this._debugFragmentPipelineCache.set(cacheKey, pipeline);
    }
    return pipeline;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Tile Command Creation
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create WebGPU draw command(s) for a terrain tile.
   * Returns an array of descriptors — one per pass.
   * Tiles with >4 imagery layers produce multiple passes.
   */
  createTileCommands(
    tile: {
      level: number;
      x: number;
      y: number;
      rectangle: CesiumRectangle;
      boundingVolume?: CesiumBoundingSphere;
    },
    surfaceTile: CesiumGlobeSurfaceTile,
    tileProvider: CesiumGlobeTileProvider,
    frameState: CesiumFrameState,
    uniformState: CesiumUniformState,
  ): TileDrawDescriptor[] | null {
    if (!this._isInitialized || !this._device) return null;

    // Eagerly touch the uniform ring buffer allocator on first use. The
    // context's lazy getter only constructs the allocator on first access,
    // and `context.beginFrame()` only calls `beginFrame()` on the allocator
    // when it already exists. Without this touch the allocator would never
    // initialize and BUG-9's per-frame buffer leak would re-emerge.
    void frameState.context?.uniformAllocator;

    const device = this._device;
    const mesh = surfaceTile.renderedMesh || surfaceTile.mesh;
    if (!mesh) return null;

    const tileKey = this._getTileKey(tile);
    const gpuResources = this._getOrCreateTileBuffers(tileKey, mesh);
    if (!gpuResources) return null;

    // Count total ready imagery layers
    const imageryCollection = surfaceTile.imagery;
    const readyLayers: CesiumTileImagery[] = [];
    if (imageryCollection) {
      for (let i = 0; i < imageryCollection.length; i++) {
        const tileImagery = imageryCollection[i];
        if (
          tileImagery &&
          tileImagery.readyImagery &&
          tileImagery.readyImagery.imageryLayer
        ) {
          readyLayers.push(tileImagery);
        }
      }
    }

    // Determine number of passes needed (4 imagery layers per pass)
    const totalLayers = readyLayers.length;
    const passCount = Math.max(1, Math.ceil(totalLayers / MAX_IMAGERY_LAYERS));
    const commands: TileDrawDescriptor[] = [];

    // BUG-11 imagery probe diagnostic. Off by default — opt in via
    // `scene.debugShowImageryProbe = true` when investigating an
    // imagery render bug. Logs the first 4 tiles after the flag is set,
    // then quiets so the console doesn't drown. Toggling the flag from
    // false → true resets the latch so a second sample can be captured.
    const probeOn = frameState.debugShowImageryProbe === true;
    if (probeOn && !this._lastProbeFlag) {
      // Rising edge — reset the latch so the next 4 tiles dump again.
      this._diagTileCount = 0;
    }
    this._lastProbeFlag = probeOn;
    if (probeOn) {
      this._diagTileCount++;
    }
    if (probeOn && this._diagTileCount <= 4) {
      const imgLen = imageryCollection ? imageryCollection.length : 0;
      const rect = tile.rectangle;
      const latInfo = rect
        ? `lat=[${((rect.south * 180) / Math.PI).toFixed(1)},${((rect.north * 180) / Math.PI).toFixed(1)}]`
        : "lat=?";
      console.log(
        `[WebGPU:GlobeTile] tile=${tileKey} lvl=${tile.level} ${latInfo} imagery=${imgLen} ready=${totalLayers} ` +
          `stride=${gpuResources.strideFloats} webMercT=${gpuResources.hasWebMercatorT} ` +
          `hasNormals=${gpuResources.hasNormals} quant=${gpuResources.isQuantized} idxCount=${gpuResources.indexCount}`,
      );
      if (totalLayers > 0) {
        const sample = readyLayers[0];
        const ri = sample?.readyImagery;
        const ts = sample?.textureTranslationAndScale;
        const tcr = sample?.textureCoordinateRectangle;
        console.log(
          `[WebGPU:GlobeTile]   imagery: hasImage=${!!ri?.image} hasWebGPUTex=${!!ri?._webgpuReprojectedTexture} ` +
            `useWebMercT=${sample?.useWebMercatorT} state=${ri?.state}`,
        );
        console.log(
          `[WebGPU:GlobeTile]   transScale: (${ts?.x?.toFixed(4)}, ${ts?.y?.toFixed(4)}, ${ts?.z?.toFixed(4)}, ${ts?.w?.toFixed(4)})` +
            ` texCoordsRect: (${tcr?.x?.toFixed(4)}, ${tcr?.y?.toFixed(4)}, ${tcr?.z?.toFixed(4)}, ${tcr?.w?.toFixed(4)})`,
        );
        // Log texture dimensions
        const gpuTex = ri?._webgpuReprojectedTexture;
        if (gpuTex) {
          console.log(
            `[WebGPU:GlobeTile]   texture: ${gpuTex.width}x${gpuTex.height} fmt=${gpuTex.format}`,
          );
        }
        // Log a few vertex UV values from the mesh for cross-check
        const verts = mesh.vertices;
        const stride = gpuResources.strideFloats;
        if (verts && stride >= 6 && !gpuResources.isQuantized) {
          const v0u = verts[4],
            v0v = verts[5];
          const midIdx = Math.floor(verts.length / stride / 2) * stride;
          const vMu = verts[midIdx + 4],
            vMv = verts[midIdx + 5];
          const lastIdx = (Math.floor(verts.length / stride) - 1) * stride;
          const vLu = verts[lastIdx + 4],
            vLv = verts[lastIdx + 5];
          console.log(
            `[WebGPU:GlobeTile]   vertUV: first=(${v0u?.toFixed(4)}, ${v0v?.toFixed(4)}) ` +
              `mid=(${vMu?.toFixed(4)}, ${vMv?.toFixed(4)}) last=(${vLu?.toFixed(4)}, ${vLv?.toFixed(4)})`,
          );
        }
      } else {
        console.warn(
          `[WebGPU:GlobeTile]   NO READY IMAGERY for tile ${tileKey} ${latInfo}`,
        );
      }
    }

    // Hot-path discipline: read all per-frame debug flags once *outside*
    // the per-pass loop. The four fragment debug modes are mutually
    // exclusive (you can only show one fragment overlay at a time);
    // collapse them into a single integer mode so the per-pass branch
    // is one comparison against NONE rather than a chain of if-elses.
    //
    // Wireframe is *not* a fragment mode — it's a topology + IB swap —
    // so it stays as its own boolean and wins over fragment modes
    // (more structural diagnostic value).
    const debugWireframe = frameState.debugShowGlobeWireframe === true;
    let debugFragmentMode: DebugFragmentMode = DebugFragmentMode.NONE;
    if (frameState.debugShowTriangulation === true) {
      debugFragmentMode = DebugFragmentMode.TRIANGULATION;
    } else if (frameState.debugShowTerrainLOD === true) {
      debugFragmentMode = DebugFragmentMode.LOD;
    } else if (frameState.debugShowTerrainNormals === true) {
      debugFragmentMode = DebugFragmentMode.NORMAL;
    }

    for (let pass = 0; pass < passCount; pass++) {
      const isSubsequentPass = pass > 0;
      const layerStart = pass * MAX_IMAGERY_LAYERS;
      const layerEnd = Math.min(layerStart + MAX_IMAGERY_LAYERS, totalLayers);
      const passLayers = readyLayers.slice(layerStart, layerEnd);

      // Phase 5 WGF-1: pick the hardware clip-distances variant only when
      // ALL of the following hold. Each condition is a real correctness
      // gate — the legacy fragment-discard path handles every other case.
      //
      //   1. context flag is on (auto-set when device granted clip-distances)
      //   2. tile provider has an active ClippingPlaneCollection
      //   3. SCENE3D mode — in 2D / Columbus / Morphing the vertex shader
      //      writes `out.position` from `modifiedModelViewProjection` against
      //      a planar position, while the clip-distance loop computes
      //      against `position3DWC` (ECEF). The rasterizer interpolates
      //      the clip distance across screen-space of the *drawn* primitive,
      //      so the spatial relationship between the clipping plane and
      //      the rendered triangle is non-linear in those modes. Falling
      //      back to fragment discard preserves correct behavior.
      //   4. Union mode (`unionClippingRegions === true`). The hardware
      //      `@builtin(clip_distances)` is purely union semantics — any
      //      negative slot causes a clip. The fragment-discard path
      //      additionally supports intersection mode (clip only when ALL
      //      planes clip); routing intersection-mode collections to the
      //      hardware variant would over-clip.
      const ctx = frameState?.context;
      const cp = tileProvider?.clippingPlanes;
      const isScene3D = (frameState?.mode ?? 3) >= 2.5; // SceneMode.SCENE3D = 3
      const useClipDistances =
        !!(ctx && ctx.useHardwareClipDistances) &&
        !!(cp && cp.length > 0) &&
        isScene3D &&
        !!cp.unionClippingRegions;

      let pipeline: GPURenderPipeline;
      // Wireframe is a structural overlay — only the first pass renders it,
      // subsequent passes are the multi-imagery overdraw which would just
      // double-rasterize the same edges.
      if (debugWireframe && !isSubsequentPass) {
        pipeline = this._selectWireframePipeline(
          gpuResources.isQuantized,
          gpuResources.hasNormals,
          gpuResources.hasWebMercatorT,
          gpuResources.strideBytes,
          gpuResources.hasGeodeticSurfaceNormals,
        );
      } else if (debugFragmentMode !== DebugFragmentMode.NONE) {
        // Cold path: try the debug fragment variant; gracefully fall back
        // to the production pipeline if the device can't compile the
        // augmented module (driver missing primitive_index, etc.).
        // The debug fragment + clip-distances combination is intentionally
        // unsupported — the debug variants don't share the augmented
        // VertexOutput. Fall through to the production module.
        pipeline =
          this._selectDebugFragmentPipeline(
            debugFragmentMode,
            gpuResources.isQuantized,
            gpuResources.hasNormals,
            gpuResources.hasWebMercatorT,
            isSubsequentPass,
            gpuResources.strideBytes,
            gpuResources.hasGeodeticSurfaceNormals,
          ) ??
          this._selectPipeline(
            gpuResources.isQuantized,
            gpuResources.hasNormals,
            gpuResources.hasWebMercatorT,
            isSubsequentPass,
            gpuResources.strideBytes,
            false,
            gpuResources.hasGeodeticSurfaceNormals,
          );
      } else {
        pipeline = this._selectPipeline(
          gpuResources.isQuantized,
          gpuResources.hasNormals,
          gpuResources.hasWebMercatorT,
          isSubsequentPass,
          gpuResources.strideBytes,
          useClipDistances,
          gpuResources.hasGeodeticSurfaceNormals,
        );
      }

      const cameraUB = this._createCameraUniformBuffer(
        device,
        uniformState,
        surfaceTile,
        tileProvider,
        mesh,
        frameState,
        tile,
      );
      const tileUB = this._createTileUniformBuffer(
        device,
        surfaceTile,
        tileProvider,
        frameState,
        tile,
        passLayers,
        isSubsequentPass,
      );

      const bindGroup0 = device.createBindGroup({
        layout: this._bindGroupLayout0!,
        entries: [
          {
            binding: 0,
            resource: {
              buffer: cameraUB.buffer,
              offset: cameraUB.offset,
              size: cameraUB.size,
            },
          },
          {
            binding: 1,
            resource: {
              buffer: tileUB.buffer,
              offset: tileUB.offset,
              size: tileUB.size,
            },
          },
        ],
      });

      const bindGroup1 = this._createTextureBindGroup(device, passLayers);
      // Group 2: Merged water mask + ocean normal map
      const bindGroup2 = this._createWaterOceanBindGroup(
        device,
        isSubsequentPass ? null : surfaceTile,
        tileProvider,
      );

      // Group 3: Effects (shadow receive + clipping planes).
      //
      // Phase 5 WGF-1: when clipping planes are active on the tile
      // provider AND the hardware clip-distances pipeline variant is on,
      // build a real effects bind group with the precomputed
      // `clipPlaneEqHW` quads. The legacy fragment-discard path is also
      // covered by this branch — `useClipDistances` may be false but the
      // collection still active, in which case the bind group still
      // populates the texture binding for the legacy path.
      //
      // When neither shadows nor clipping are active the placeholder is
      // returned (no per-frame allocation), preserving the existing
      // hot-path behavior for the common case.
      //
      // Phase 4 AtmosphereLUT integration: when the scene has an
      // atmosphere LUT ready (compute supported + SkyAtmosphere has
      // dispatched the LUT compute pass at least once), we route
      // through the active bind group builder to pass the LUT views
      // into bindings 7/8 of the effects BGL. The globe shader reads
      // those to compute fog color that matches the visible sky dome.
      // If neither clipping nor LUT is present we still take the
      // placeholder fast-path.
      const perfMgr = (frameState as { context?: { performanceManager?: { ensureAtmosphereLUTResources?: (d: GPUDevice) => { transmittanceView?: GPUTextureView; inscatterView?: GPUTextureView; } | null; } } }).context
        ?.performanceManager;
      let atmosphereLutViews:
        | { transmittance: GPUTextureView; inscatter: GPUTextureView }
        | null = null;
      if (perfMgr?.ensureAtmosphereLUTResources) {
        // Read the existing LUT views. We deliberately don't consult
        // `shouldRecomputeAtmosphereLUT()` here because that method is
        // side-effecting — it clears the dirty flag on read, and the
        // flag belongs to SkyAtmosphere's dispatch lifecycle. Consuming
        // it here would prevent SkyAtmosphere from seeing "needs
        // recompute" on its next frame.
        //
        // Instead we bind whatever the texture currently contains and
        // let the shader's `lutLuminance > 0.001` check in
        // `sampleAtmosphereFogLut` decide whether the data is
        // meaningful. Before SkyAtmosphere has dispatched (first frame)
        // the textures are all-zero and the shader takes the inline
        // Rayleigh/Mie fallback, which produces the same look as
        // pre-LUT builds — no flash or pop.
        const res = perfMgr.ensureAtmosphereLUTResources(device);
        if (res && res.transmittanceView && res.inscatterView) {
          atmosphereLutViews = {
            transmittance: res.transmittanceView,
            inscatter: res.inscatterView,
          };
        }
      }
      // DP-H28 — resolve the scene's receive shadow map so the globe
      // actually gets shadow-darkening when `viewer.shadows = true`.
      // WebGL routes through Scene.js per-command receive logic; in
      // WebGPU the globe manages its own bind groups, so we inline the
      // same lookup here. `lightShadowMaps[0]` is the canonical receive
      // source (cascades, spot, directional all land there post-update).
      // Gated on `lightShadowsEnabled` to match Scene.js:4389.
      const shadowState = frameState?.shadowState;
      const receiveShadowMap =
        shadowState?.lightShadowsEnabled && shadowState?.lightShadowMaps?.[0]
          ? shadowState.lightShadowMaps[0]
          : undefined;

      let bindGroup3: GPUBindGroup;
      if (
        useClipDistances ||
        (tileProvider?.clippingPlanes &&
          tileProvider.clippingPlanes.length > 0) ||
        atmosphereLutViews !== null ||
        receiveShadowMap !== undefined
      ) {
        const fxRes = createEffectsBindGroup(device, frameState, {
          clippingPlanes: tileProvider.clippingPlanes,
          shadowMap: receiveShadowMap,
          // Globe terrain model matrix is identity, so the camera in
          // plane-space is the same as the world camera position.
          cameraInPlaneSpace: uniformState.cameraPosition,
          atmosphereLutTransmittanceView: atmosphereLutViews?.transmittance,
          atmosphereLutInscatterView: atmosphereLutViews?.inscatter,
          // Use the SkyAtmosphere convention — WGS84 + 2.5% atmosphere
          // thickness matches the default the LUT compute dispatcher
          // uses unless SkyAtmosphere.atmosphereLightIntensity has
          // been customized. Full scene-specific radii plumbing is a
          // small follow-on but the shader clamps altitudes anyway.
          atmosphereLutPlanetRadii: {
            inner: 6378137.0,
            outer: 6378137.0 * 1.025,
          },
        });
        bindGroup3 = fxRes.bindGroup;
      } else {
        bindGroup3 = this._placeholderEffectsBG!;
      }

      // Wireframe overlay: swap the index buffer to the line-list version.
      // The wireframe IB is only used on the first pass (matches the pipeline
      // selection above) — subsequent passes still use the standard tri IB
      // because they're not running the wireframe pipeline.
      let drawIndexBuffer = gpuResources.indexBuffer;
      let drawIndexCount = gpuResources.indexCount;
      let drawIndexFormat = gpuResources.indexFormat;
      if (debugWireframe && !isSubsequentPass) {
        const wire = this._getOrCreateWireframeIndices(tileKey, mesh);
        if (wire) {
          drawIndexBuffer = wire.buffer;
          drawIndexCount = wire.count;
          drawIndexFormat = wire.format;
        }
      }

      // ── Index buffer overflow guard ──
      // A mismatched indexCount vs buffer size produces a WebGPU validation
      // error that invalidates the ENTIRE command buffer for the frame —
      // making the canvas go black. Clamp to prevent that.
      const bytesPerIndex = drawIndexFormat === "uint32" ? 4 : 2;
      const maxIndicesInBuffer = Math.floor(
        drawIndexBuffer.size / bytesPerIndex,
      );
      if (drawIndexCount > maxIndicesInBuffer) {
        // PERMANENT warning (not debug-only) — this indicates real data
        // corruption that produces visible rendering gaps. Throttled to
        // once per 5 seconds to prevent console spam from recurring tiles.
        const now = performance.now();
        if (
          !this._lastOverflowWarnTime ||
          now - this._lastOverflowWarnTime > 5000
        ) {
          this._lastOverflowWarnTime = now;
          console.error(
            `[CesiumJS:WebGPU] INDEX OVERFLOW — tile=${tileKey} ` +
              `indexCount=${drawIndexCount} maxInBuffer=${maxIndicesInBuffer} ` +
              `bufSize=${drawIndexBuffer.size} format=${drawIndexFormat}. ` +
              `Clamped to prevent command buffer invalidation. ` +
              `This causes visible gaps in the globe.`,
          );
        }
        drawIndexCount = maxIndicesInBuffer;
      }

      commands.push({
        pipeline,
        bindGroups: [bindGroup0, bindGroup1, bindGroup2, bindGroup3],
        vertexBuffer: gpuResources.vertexBuffer,
        indexBuffer: drawIndexBuffer,
        indexCount: drawIndexCount,
        indexFormat: drawIndexFormat,
        boundingVolume:
          (tile.boundingVolume as CesiumBoundingSphere | undefined) ||
          surfaceTile.boundingSphere3D,
        isSubsequentPass,
        // Shadow cast wiring (Batch 24). Every tile — quantized or not —
        // carries its shadow-cast UB and its true VB stride so the
        // stride-aware pipeline registry in WebGPUShadowMapRenderer can
        // build a pipeline whose `arrayStride` matches this tile's
        // actual VB. The scene adapter translates these three fields
        // into `_shadowCastLayout` + `_shadowCastTerrainUB` +
        // `vertexStride` on the Cesium draw command.
        isQuantized: gpuResources.isQuantized,
        shadowCastTerrainUB: gpuResources.shadowCastUB,
        hasGeodeticSurfaceNormals: gpuResources.hasGeodeticSurfaceNormals,
        strideBytes: gpuResources.strideBytes,
      });
    }

    return commands.length > 0 ? commands : null;
  }

  /**
   * Legacy single-command interface for backward compatibility.
   * @deprecated Use createTileCommands for multi-pass support.
   */
  createTileCommand(
    tile: {
      level: number;
      x: number;
      y: number;
      rectangle: CesiumRectangle;
      boundingVolume?: CesiumBoundingSphere;
    },
    surfaceTile: CesiumGlobeSurfaceTile,
    tileProvider: CesiumGlobeTileProvider,
    frameState: CesiumFrameState,
    uniformState: CesiumUniformState,
  ): TileDrawDescriptor | null {
    const commands = this.createTileCommands(
      tile,
      surfaceTile,
      tileProvider,
      frameState,
      uniformState,
    );
    if (!commands || commands.length === 0) return null;

    // Return the first pass descriptor in the old format
    const cmd = commands[0];
    return {
      pipeline: cmd.pipeline,
      bindGroups: cmd.bindGroups,
      vertexBuffer: cmd.vertexBuffer,
      indexBuffer: cmd.indexBuffer,
      indexCount: cmd.indexCount,
      indexFormat: cmd.indexFormat,
      boundingVolume: cmd.boundingVolume,
      isSubsequentPass: false,
    };
  }

  private _getTileKey(tile: { level: number; x: number; y: number }): string {
    return `${tile.level}_${tile.x}_${tile.y}`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Vertex / Index Buffer Management
  // ═══════════════════════════════════════════════════════════════════════

  private _getOrCreateTileBuffers(
    tileKey: string,
    mesh: CesiumTerrainMesh,
  ): TileGPUResources | null {
    const device = this._device!;
    const generation = mesh._webgpuGeneration || 0;

    const cached = this._tileBufferCache.get(tileKey);
    if (cached && cached.meshGeneration === generation) {
      return cached;
    }

    if (cached) {
      cached.vertexBuffer.destroy();
      cached.indexBuffer.destroy();
      cached.shadowCastUB?.destroy();
    }

    const vertices: Float32Array = mesh.vertices;
    let indices: Uint8Array | Uint16Array | Uint32Array = mesh.indices;
    if (
      !vertices ||
      !indices ||
      vertices.length === 0 ||
      indices.length === 0
    ) {
      return null;
    }

    // WebGPU does not support uint8 index format — only uint16 and uint32.
    // `TerrainFillMesh` stores indices as `Uint8Array` when `vertexCount < 256`
    // to save memory (see `TerrainFillMesh.js:1236`). Up-convert to Uint16Array
    // here so the buffer size, byte-length, and declared `indexFormat` all
    // agree. Historical bug: leaving the Uint8Array in place made
    // `indices.byteLength` equal to `indexCount` (1 byte/index), the buffer
    // was created at half the needed size, and the index format was still
    // reported as uint16 — the GPU then read 2 bytes per index and tried to
    // walk past the end of the buffer, invalidating the whole command buffer
    // and producing an invisible globe at default zoom.
    if (indices instanceof Uint8Array) {
      const upconverted = new Uint16Array(indices.length);
      for (let k = 0; k < indices.length; k++) upconverted[k] = indices[k];
      indices = upconverted;
    }

    const encoding = mesh.encoding;
    let stride = encoding.stride;
    let hasNormals = encoding.hasVertexNormals === true;
    let hasWebMercatorT = encoding.hasWebMercatorT === true;
    // TerrainQuantization.BITS12 = 1; NONE = 0
    const isQuantized =
      encoding.quantization !== undefined && encoding.quantization === 1;

    // Validate stride against actual vertex data. Fill tiles (TerrainFillMesh)
    // may have vertex data with a different stride than their encoding reports,
    // because the encoding is inherited from the parent tile. The encoding may
    // say stride=8 (pos+h+uv+webMercT+normal) but the fill mesh only wrote
    // stride=6 (pos+h+uv). Detect this by finding the smallest valid stride
    // that accommodates all indices.
    if (indices.length > 0 && vertices.length > 0) {
      let maxIdx = 0;
      for (let k = 0; k < indices.length; k++) {
        if (indices[k] > maxIdx) maxIdx = indices[k];
      }
      const neededVerts = maxIdx + 1;
      const vertCountAtStride = Math.floor(vertices.length / stride);
      if (neededVerts > vertCountAtStride) {
        // Current stride doesn't fit — find smallest valid stride.
        // Fill tiles may use stride as low as 4 (pos+height only).
        let correctedStride = 0;
        const minStride = isQuantized ? 3 : 4;
        for (let s = minStride; s <= stride; s++) {
          if (Math.floor(vertices.length / s) >= neededVerts) {
            correctedStride = s;
            break;
          }
        }
        // If corrected stride < 6 (uncompressed) or no stride found,
        // the vertex data lacks UV coordinates — skip this fill tile
        // rather than rendering with garbage UVs that produce black lines.
        if (correctedStride === 0 || (!isQuantized && correctedStride < 6)) {
          return null;
        }
        stride = correctedStride;
        // Recompute flags based on corrected stride
        if (!isQuantized) {
          hasWebMercatorT = stride >= 7 && encoding.hasWebMercatorT === true;
          hasNormals = stride >= 8 || (stride >= 7 && !hasWebMercatorT);
        }
      }
    }

    // WebGPU requires buffer sizes to be multiples of 4
    const vbSize = Math.ceil(vertices.byteLength / 4) * 4;
    const vertexBuffer = device.createBuffer({
      label: `Terrain VB ${tileKey}`,
      size: vbSize,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, gpuData(vertices));

    // Index buffers with Uint16Array may have non-4-byte-aligned byteLength;
    // pad to 4-byte alignment for writeBuffer compatibility
    const ibByteLength = indices.byteLength;
    const ibAlignedSize = Math.ceil(ibByteLength / 4) * 4;
    const indexBuffer = device.createBuffer({
      label: `Terrain IB ${tileKey}`,
      size: ibAlignedSize,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    if (ibAlignedSize !== ibByteLength) {
      // Pad to 4-byte alignment
      const padded = new Uint8Array(ibAlignedSize);
      padded.set(
        new Uint8Array(indices.buffer, indices.byteOffset, ibByteLength),
      );
      device.queue.writeBuffer(indexBuffer, 0, padded);
    } else {
      device.queue.writeBuffer(indexBuffer, 0, gpuData(indices));
    }

    const indexFormat: GPUIndexFormat =
      indices.BYTES_PER_ELEMENT === 4 ? "uint32" : "uint16";

    const strideBytes = stride * 4;

    // Final validation: vertex count must accommodate all indices.
    // This is a safety net — the upfront stride correction above should
    // handle most fill tile mismatches, but edge cases can still occur.
    const vertexCount = Math.floor(vbSize / strideBytes);
    let validIndexCount = indices.length;
    if (vertexCount > 0 && indices.length > 0) {
      let maxIdx = 0;
      for (let k = 0; k < indices.length; k++) {
        if (indices[k] > maxIdx) maxIdx = indices[k];
      }
      if (maxIdx >= vertexCount) {
        // Stride mismatch — encoding stride doesn't match actual vertex data.
        // Try to infer the correct stride from data length and max index.
        const actualVertCount = maxIdx + 1;
        const inferredStride = Math.floor(vertices.length / actualVertCount);

        // If we can infer a valid stride, use it instead
        if (
          inferredStride >= 3 &&
          inferredStride <= 11 &&
          vertices.length >= actualVertCount * inferredStride
        ) {
          const correctedStrideBytes = inferredStride * 4;
          const correctedVertCount = Math.floor(vbSize / correctedStrideBytes);
          if (maxIdx < correctedVertCount) {
            // DP-H25 — geodetic normals occupy the trailing 3 floats of the
            // stride when `encoding.hasGeodeticSurfaceNormals` is set. The
            // inferred-stride fallback only fires for fill tiles so we defer
            // to the encoding flag here; downstream `_selectPipeline` handles
            // the case where stride is too small to actually carry it.
            const inferredHasGeoNormal =
              encoding.hasGeodeticSurfaceNormals === true &&
              inferredStride >=
                (isQuantized ? 4 : hasWebMercatorT || hasNormals ? 7 : 6) + 3;
            const resources: TileGPUResources = {
              vertexBuffer,
              indexBuffer,
              indexCount: indices.length,
              indexFormat,
              strideFloats: inferredStride,
              strideBytes: correctedStrideBytes,
              hasNormals:
                inferredStride >= 7 || (isQuantized && inferredStride >= 4),
              hasWebMercatorT,
              isQuantized,
              hasGeodeticSurfaceNormals: inferredHasGeoNormal,
              meshGeneration: generation,
            };
            this._tileBufferCache.set(tileKey, resources);
            return resources;
          }
        }

        // Fallback: clamp to safe indices
        let safeCount = 0;
        for (let k = 0; k < indices.length; k += 3) {
          if (
            k + 2 < indices.length &&
            indices[k] < vertexCount &&
            indices[k + 1] < vertexCount &&
            indices[k + 2] < vertexCount
          ) {
            safeCount = k + 3;
          } else {
            break;
          }
        }
        validIndexCount = safeCount;
        if (validIndexCount === 0) {
          vertexBuffer.destroy();
          indexBuffer.destroy();
          return null;
        }
      }
    }

    const resources: TileGPUResources = {
      vertexBuffer,
      indexBuffer,
      indexCount: validIndexCount,
      indexFormat,
      strideFloats: stride,
      strideBytes,
      hasNormals,
      hasWebMercatorT,
      isQuantized,
      // DP-H25 — `TerrainEncoding` flips `hasGeodeticSurfaceNormals` on when
      // the per-vertex stride is widened to include the normal (see
      // TerrainEncoding.js:320). The pipeline builder uses this flag to
      // add a `@location(2)` vec3 attribute over the trailing 12 bytes of
      // the stride and enable the `GEODETIC_NORMAL` shader define.
      hasGeodeticSurfaceNormals: encoding.hasGeodeticSurfaceNormals === true,
      meshGeneration: generation,
    };

    // Allocate a shadow cast UB for every tile regardless of quantization.
    // Before Batch 24 this was quantized-only, which meant uncompressed
    // tiles fell through to the `rte24` variant via stride-inference —
    // and `rte24` reads two vec3s (positionHigh + positionLow) where
    // the uncompressed VB actually has `position3DAndHeight` + tex
    // coords. The resulting RTE math produced shadow coordinates
    // unrelated to the actual terrain. Batch 24's new
    // `terrainUncompressed` shadow cast variant consumes the same UB
    // layout as `quantized12` (scaleAndBias + center3D + minMaxHeight),
    // so every tile — quantized or not — needs the buffer populated.
    // The buffer is static for the tile's lifetime; when the tile's
    // mesh is regenerated we rebuild it alongside the vertex buffer
    // (next cache-miss path).
    const shadowUB = device.createBuffer({
      label: `Terrain shadow cast UB (${tileKey})`,
      // 96 bytes: scaleAndBias(64) + center3D+pad(16) + minMaxHeight+pad(16)
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._writeTerrainShadowUB(device, shadowUB, mesh);
    resources.shadowCastUB = shadowUB;

    this._tileBufferCache.set(tileKey, resources);
    return resources;
  }

  /**
   * Writes the `quantized12` shadow-cast variant's uniform data for
   * a tile. Layout (96 bytes, must match
   * WebGPUShadowMapRenderer.js::SHADOW_CAST_VARIANTS.quantized12):
   *
   *   offset  0: scaleAndBias: mat4x4<f32>  (from mesh.encoding.matrix)
   *   offset 64: center3D:     vec3<f32>    (from mesh.center)
   *   offset 76: _pad0:        f32
   *   offset 80: minMaxHeight: vec2<f32>
   *   offset 88: _pad1:        vec2<f32>
   *
   * @private
   */
  private _writeTerrainShadowUB(
    device: GPUDevice,
    buffer: GPUBuffer,
    mesh: CesiumTerrainMesh,
  ): void {
    const data = new Float32Array(24); // 96 bytes
    const encoding = mesh.encoding;
    if (encoding && encoding.matrix) {
      const m = m4Values(encoding.matrix);
      for (let i = 0; i < 16; i++) data[i] = m[i];
    } else {
      for (let i = 0; i < 16; i++) data[i] = i % 5 === 0 ? 1.0 : 0.0;
    }
    const center = mesh.center ||
      (encoding && encoding.center) || { x: 0, y: 0, z: 0 };
    data[16] = center.x;
    data[17] = center.y;
    data[18] = center.z;
    data[19] = 0;
    data[20] = encoding?.minimumHeight ?? 0;
    data[21] = encoding?.maximumHeight ?? 0;
    data[22] = 0;
    data[23] = 0;
    device.queue.writeBuffer(buffer, 0, data.buffer, 0, 96);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Uniform Buffer Creation
  // ═══════════════════════════════════════════════════════════════════════

  private _createCameraUniformBuffer(
    device: GPUDevice,
    uniformState: CesiumUniformState,
    surfaceTile: CesiumGlobeSurfaceTile,
    tileProvider: CesiumGlobeTileProvider,
    mesh: CesiumTerrainMesh,
    frameState?: CesiumFrameState,
    tile?: { level: number; x: number; y: number; rectangle: CesiumRectangle },
  ): { buffer: GPUBuffer; offset: number; size: number } {
    const data = this._cameraUniformData;
    let offset = 0;

    // mvpRelativeToEye (mat4x4, 16 floats)
    const mvpRTE = m4Values(uniformState.modelViewProjectionRelativeToEye);
    for (let i = 0; i < 16; i++) data[offset++] = mvpRTE[i];

    // modifiedModelView (mat4x4, 16 floats)
    const modifiedView = this._computeModifiedModelView(
      uniformState,
      surfaceTile,
    );
    const mv = m4Values(modifiedView);
    for (let i = 0; i < 16; i++) data[offset++] = mv[i];

    // modifiedModelViewProjection (mat4x4, 16 floats) — used by 2D/CV/Morphing
    // paths in the WGSL vertex shader. Equals projection × modifiedModelView.
    // Matches WebGL u_modifiedModelViewProjection (see
    // GlobeSurfaceTileProviderRendering.js).
    const mvp = this._cameraMvpScratch;
    multiplyMat4ColumnMajor(uniformState.projection, modifiedView, mvp);
    for (let i = 0; i < 16; i++) data[offset++] = mvp[i];

    // encodedCameraHigh (vec3 + pad)
    const camHigh = uniformState.encodedCameraPositionMCHigh;
    data[offset++] = camHigh.x;
    data[offset++] = camHigh.y;
    data[offset++] = camHigh.z;
    data[offset++] = 0;

    // encodedCameraLow (vec3 + pad)
    const camLow = uniformState.encodedCameraPositionMCLow;
    data[offset++] = camLow.x;
    data[offset++] = camLow.y;
    data[offset++] = camLow.z;
    data[offset++] = 0;

    //>>includeStart('debug', pragmas.debug);
    // RTE round-trip: verify that high+low reconstructs the unencoded camera
    // position. Catches off-by-one packer bugs that swap the high/low slots
    // (visible symptom: ~6 m geometry jitter at orbital altitude).
    //
    // For terrain the model matrix is identity (`inverseModel` is identity),
    // so the MC-encoded high/low must reconstruct to `cameraPosition` (WC)
    // exactly. UniformState computes the encoded MC pair from
    // `inverseModel × cameraPosition` (UniformStateComputations.js:404-416).
    if (camHigh && camLow && uniformState.cameraPosition) {
      assertCameraRTERoundTrip(
        camHigh,
        camLow,
        uniformState.cameraPosition,
        "Globe terrain camera UB",
      );
    }
    //>>includeEnd('debug');

    // center3D (vec3 + pad) — MUST match the encoding center that vertex
    // positions are relative to. In `TerrainEncoding.encode`, each vertex
    // is stored as `(position - encoding.center)`, so the vertex shader
    // reconstructs the world position via `exaggeratedPosition + camera.center3D`.
    // If we feed `mesh.center` here but `mesh.center !== encoding.center`,
    // the reconstructed world position is wrong by exactly that delta —
    // which would produce per-tile radius variance in wireframe, matching
    // the user-reported symptom.
    //
    // Therefore: ALWAYS use `encoding.center` here, not `mesh.center`.
    // They should normally be equal, but subtle paths (TerrainFillMesh OBB
    // vs rectangle center, upsampled meshes, cloned encodings) can make
    // them diverge, and `encoding.center` is the authoritative source for
    // "the reference point the vertices were encoded against."
    const encodingCenter = mesh.encoding?.center;
    const meshCenter = mesh.center;
    const center = encodingCenter || meshCenter || { x: 0, y: 0, z: 0 };
    //>>includeStart('debug', pragmas.debug);
    if (this._diagShouldLog()) {
      const mag = Math.sqrt(
        (center.x || 0) * (center.x || 0) +
          (center.y || 0) * (center.y || 0) +
          (center.z || 0) * (center.z || 0),
      );
      // isFill check: "fill" meshes are stored separately on
      // `surfaceTile.fill.mesh`, not on `surfaceTile.mesh`. Check both.
      const fillMesh = surfaceTile.fill?.mesh;
      const isFillByRef = mesh === fillMesh;
      const isCachedMesh = mesh === surfaceTile.mesh;
      // Ctor name reveals which TerrainData class produced this mesh
      // (QuantizedMeshTerrainData / HeightmapTerrainData / Cesium3DTilesTerrainData
      // / TerrainFillMesh). The center bug is almost certainly "which
      // constructor was called with what center", so this is the
      // fingerprint we need.
      const meshCtor = mesh?.constructor?.name ?? "?";
      const encCtor = mesh?.encoding?.constructor?.name ?? "?";
      const tdCtor =
        (surfaceTile.data as { constructor?: { name?: string } } | undefined)
          ?.constructor?.name ?? "?";
      console.log(
        `[WebGPU:GlobeTile] center3D tile=${tile?.level}_${tile?.x}_${tile?.y} ` +
          `meshCtor=${meshCtor} encCtor=${encCtor} terrainDataCtor=${tdCtor} ` +
          `isFillByRef=${isFillByRef} isCachedMesh=${isCachedMesh} ` +
          `magKm=${(mag / 1000).toFixed(3)} ` +
          `center.xyz=(${(center.x || 0).toFixed(1)},${(center.y || 0).toFixed(1)},${(center.z || 0).toFixed(1)}) ` +
          `quantized=${!!mesh.encoding?.quantization}`,
      );
    }
    //>>includeEnd('debug');
    // Split center3D into high/low f32 so the SCENE3D RTE assembly in
    // GlobeTerrain.wgsl can do `(centerH - camH) + (centerL + pos - camL)`
    // without losing sub-meter precision. The encoding matches
    // `EncodedCartesian3.fromCartesian`: for each component, high =
    // reinterpret(f32(value & ~((1<<24)-1))), low = value - high. When the
    // camera is close to the tile, both (centerH - camH) and
    // (centerL - camL) are small, so the RTE sum keeps sub-meter precision.
    const cxF32 = Math.fround(center.x);
    const cyF32 = Math.fround(center.y);
    const czF32 = Math.fround(center.z);
    const splitShift = 65536.0; // 2^16
    // Canonical EncodedCartesian3 split: mask off the low ~24 bits by
    // multiplying by 2^-16, flooring, and multiplying back. This is what
    // `EncodedCartesian3.fromCartesian` does.
    const cxHigh = Math.fround(Math.floor(cxF32 / splitShift) * splitShift);
    const cyHigh = Math.fround(Math.floor(cyF32 / splitShift) * splitShift);
    const czHigh = Math.fround(Math.floor(czF32 / splitShift) * splitShift);
    const cxLow = Math.fround(cxF32 - cxHigh);
    const cyLow = Math.fround(cyF32 - cyHigh);
    const czLow = Math.fround(czF32 - czHigh);
    // center3DHigh (vec3 + pad)
    data[offset++] = cxHigh;
    data[offset++] = cyHigh;
    data[offset++] = czHigh;
    data[offset++] = 0;
    // center3DLow (vec3 + pad)
    data[offset++] = cxLow;
    data[offset++] = cyLow;
    data[offset++] = czLow;
    data[offset++] = 0;

    // sunDirectionEC (vec3) + enableLighting (f32)
    const sunDir = uniformState.sunDirectionEC;
    data[offset++] = sunDir.x;
    data[offset++] = sunDir.y;
    data[offset++] = sunDir.z;
    data[offset++] = tileProvider.enableLighting ? 1.0 : 0.0;

    // scaleAndBias (mat4x4, 16 floats) — for quantized mesh decompression
    const encoding = mesh.encoding;
    if (encoding && encoding.matrix) {
      const sbm = m4Values(encoding.matrix);
      for (let i = 0; i < 16; i++) data[offset++] = sbm[i];
    } else {
      // Identity fallback (uncompressed terrain doesn't use this)
      for (let i = 0; i < 16; i++) data[offset++] = i % 5 === 0 ? 1.0 : 0.0;
    }

    // minMaxHeight (vec2) + ellipsoidRadius (f32) + pad (f32)
    // ellipsoidRadius carries the tile provider's ellipsoid maximum radius
    // so the shader's altitude calculations work for non-WGS84 ellipsoids
    // (Mars, Moon, custom). Falls through to 0 when unavailable; the shader
    // detects a zero and substitutes the WGS84 fallback constant.
    data[offset++] = encoding?.minimumHeight ?? 0.0;
    data[offset++] = encoding?.maximumHeight ?? 0.0;
    const ell = (tileProvider?._ellipsoid ?? tileProvider?.ellipsoid) as
      | { maximumRadius?: number }
      | undefined;
    data[offset++] = ell?.maximumRadius ?? 0.0;
    data[offset++] = 0; // reserved (future minor-axis radius)

    // ─── 2D / Columbus View support ───
    // tileRectangle (vec4): west, south, east, north (radians)
    const rectangle = tile?.rectangle;
    if (rectangle) {
      data[offset++] = rectangle.west;
      data[offset++] = rectangle.south;
      data[offset++] = rectangle.east;
      data[offset++] = rectangle.north;
    } else {
      data[offset++] = 0;
      data[offset++] = 0;
      data[offset++] = 0;
      data[offset++] = 0;
    }

    // southAndNorthLatitude (vec2)
    if (rectangle) {
      data[offset++] = rectangle.south;
      data[offset++] = rectangle.north;
    } else {
      data[offset++] = 0;
      data[offset++] = 0;
    }

    // southMercatorYAndOneOverHeight (vec2)
    // Computed from tile rectangle: southMercY = log((1+sin(south))/(1-sin(south))) * 0.5
    // mercatorHeight = northMercY - southMercY
    if (rectangle) {
      const south = Math.max(rectangle.south, -1.4844222297453324);
      const north = Math.min(rectangle.north, 1.4844222297453324);
      const sinS = Math.sin(south);
      const sinN = Math.sin(north);
      const southMercY = 0.5 * Math.log((1 + sinS) / (1 - sinS));
      const northMercY = 0.5 * Math.log((1 + sinN) / (1 - sinN));
      const height = northMercY - southMercY;
      data[offset++] = southMercY;
      data[offset++] = height > 1e-9 ? 1.0 / height : 0.0;
    } else {
      data[offset++] = 0;
      data[offset++] = 0;
    }

    // sceneMode (f32): 0=MORPH, 1=COLUMBUS, 2=2D, 3=3D
    data[offset++] = frameState?.mode ?? 3;
    // morphTime (f32): 0..1, used for morphing transitions
    data[offset++] = frameState?.morphTime ?? 1.0;
    // useWebMercator (f32): 1 if Web Mercator projection, 0 if Geographic
    const projection = frameState?.mapProjection;
    const isWebMercator =
      projection &&
      projection.constructor &&
      projection.constructor.name === "WebMercatorProjection";
    data[offset++] = isWebMercator ? 1.0 : 0.0;
    data[offset++] = 0; // pad

    // ─── DP-H41: previousViewProjection (mat4x4, 16 floats, offsets 100–115)
    // `UniformState.update()` clones the current viewProjection into
    // `_previousViewProjection` before overwriting it with the new camera
    // state, so on frame N this field is the viewProjection from frame N-1.
    // TAA / motion-vector shaders consume it via `camera.previousViewProjection`.
    // Writing zeros on the very first frame (when previousViewProjection is
    // still Matrix4.IDENTITY) is fine — motion-vector consumers detect the
    // first frame via a separate "valid history" flag on their own pass.
    const prevVP = uniformState.previousViewProjection;
    if (prevVP) {
      const prev = m4Values(prevVP);
      for (let i = 0; i < 16; i++) data[offset++] = prev[i];
    } else {
      // Identity fallback keeps the shader contract stable.
      data[offset++] = 1;
      data[offset++] = 0;
      data[offset++] = 0;
      data[offset++] = 0;
      data[offset++] = 0;
      data[offset++] = 1;
      data[offset++] = 0;
      data[offset++] = 0;
      data[offset++] = 0;
      data[offset++] = 0;
      data[offset++] = 1;
      data[offset++] = 0;
      data[offset++] = 0;
      data[offset++] = 0;
      data[offset++] = 0;
      data[offset++] = 1;
    }

    const bufferSize = Math.max(CAMERA_UNIFORM_BYTES, 256);
    return this._writeUniformSlice(
      device,
      frameState,
      data,
      bufferSize,
      "Terrain camera UB",
    );
  }

  /**
   * Sub-allocate a uniform buffer slice from the context's ring buffer
   * (when available) and write `data` into it. Falls back to a fresh
   * `device.createBuffer` for the rare path where the ring allocator is
   * unavailable (early init / non-WebGPU context). Caller binds the slice
   * via `{ buffer, offset, size }` in the bind group entry.
   *
   * BUG-9 fix: previously every call here allocated a fresh `GPUBuffer`
   * with no destruction. With ~30 tiles × 2 buffers per frame × 60fps the
   * device ran out of memory in seconds and reported "Device lost (OOM)".
   * The ring allocator suballocates from triple-buffered 4MB pages,
   * eliminating the per-frame churn entirely.
   */
  private _writeUniformSlice(
    device: GPUDevice,
    frameState: CesiumFrameState,
    data: Float32Array,
    bufferSize: number,
    label: string,
  ): { buffer: GPUBuffer; offset: number; size: number } {
    const ctx = frameState?.context as
      | (CesiumGraphicsContext & {
          uniformAllocator?: {
            allocate(size: number): { buffer: GPUBuffer; offset: number };
          };
        })
      | undefined;
    const allocator = ctx?.uniformAllocator;
    const writeBytes = Math.min(data.byteLength, bufferSize);

    if (allocator) {
      const alloc = allocator.allocate(bufferSize);
      device.queue.writeBuffer(
        alloc.buffer,
        alloc.offset,
        data.buffer,
        data.byteOffset,
        writeBytes,
      );
      // Bind exactly the requested struct size, not the allocator's
      // 256-aligned slice size. The shader struct is `bufferSize` bytes;
      // padding bytes [bufferSize, alloc.size) belong to the allocator's
      // alignment slack and may overlap into the next allocation's data
      // on the next frame. Reporting the exact struct size keeps the
      // binding view tight against the WGSL struct definition.
      return { buffer: alloc.buffer, offset: alloc.offset, size: bufferSize };
    }

    // Fallback path — only reached when the ring allocator hasn't been
    // initialized yet (e.g., very first frame on a fresh context).
    const buffer = device.createBuffer({
      label,
      size: bufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      buffer,
      0,
      data.buffer,
      data.byteOffset,
      writeBytes,
    );
    return { buffer, offset: 0, size: bufferSize };
  }

  private _computeModifiedModelView(
    uniformState: CesiumUniformState,
    surfaceTile: CesiumGlobeSurfaceTile,
  ): Float64Array {
    const view = uniformState.view;
    const center = surfaceTile.center;
    if (!center) return new Float64Array(view);

    const result = new Float64Array(16);
    for (let i = 0; i < 16; i++) result[i] = view[i];

    result[12] += view[0] * center.x + view[4] * center.y + view[8] * center.z;
    result[13] += view[1] * center.x + view[5] * center.y + view[9] * center.z;
    result[14] += view[2] * center.x + view[6] * center.y + view[10] * center.z;

    return result;
  }

  /**
   * Create tile uniform buffer with imagery, fog, water mask, clipping,
   * and day/night params. Supports per-pass imagery layer subsets.
   */
  private _createTileUniformBuffer(
    device: GPUDevice,
    surfaceTile: CesiumGlobeSurfaceTile,
    tileProvider: CesiumGlobeTileProvider,
    frameState: CesiumFrameState,
    tile: { level: number; x: number; y: number; rectangle: CesiumRectangle },
    passLayers: CesiumTileImagery[],
    isSubsequentPass: boolean,
  ): { buffer: GPUBuffer; offset: number; size: number } {
    const data = this._tileUniformData;
    const u32 = this._tileUniformU32View;
    data.fill(0);

    // ─── Imagery layers (offsets 0-47) ───
    let layerCount = 0;

    for (
      let i = 0;
      i < passLayers.length && layerCount < MAX_IMAGERY_LAYERS;
      i++
    ) {
      const tileImagery = passLayers[i];
      if (!tileImagery || !tileImagery.readyImagery) continue;

      const imagery = tileImagery.readyImagery;
      if (!imagery.imageryLayer) continue;

      const baseOffset = layerCount * 12;

      // translationAndScale (vec4) — uses the cached value directly.
      // When useWebMercatorT=true, the cached values are in Mercator-native
      // space and the shader samples with webMercatorT (matching WebGL behavior).
      const ts = tileImagery.textureTranslationAndScale;
      if (ts) {
        data[baseOffset + 0] = ts.x;
        data[baseOffset + 1] = ts.y;
        data[baseOffset + 2] = ts.z;
        data[baseOffset + 3] = ts.w;
      } else {
        data[baseOffset + 2] = 1;
        data[baseOffset + 3] = 1;
      }

      // useWebMercatorT per layer (offsets 88-91)
      data[88 + layerCount] = tileImagery.useWebMercatorT ? 1.0 : 0.0;

      // texCoordsRectangle (vec4)
      const rect = tileImagery.textureCoordinateRectangle;
      if (rect) {
        data[baseOffset + 4] = rect.x;
        data[baseOffset + 5] = rect.y;
        data[baseOffset + 6] = rect.z;
        data[baseOffset + 7] = rect.w;
      } else {
        data[baseOffset + 6] = 1;
        data[baseOffset + 7] = 1;
      }

      const layer = imagery.imageryLayer;
      // Several of these properties are documented as scalar-OR-callback
      // (ImageryLayer JSDoc). Writing a Function into a Float32Array yields
      // NaN, which propagates through the imagery blend and makes the entire
      // layer disappear. Resolve callbacks against the tile rectangle so
      // dynamic-alpha use cases (hover-fade, time-of-day fade) work on WebGPU.
      data[baseOffset + 8] = resolveImageryLayerValue(
        layer.alpha,
        1.0,
        frameState,
        layer,
        tile,
      );
      data[baseOffset + 9] = resolveImageryLayerValue(
        layer.brightness,
        1.0,
        frameState,
        layer,
        tile,
      );
      data[baseOffset + 10] = resolveImageryLayerValue(
        layer.contrast,
        1.0,
        frameState,
        layer,
        tile,
      );
      data[baseOffset + 11] = resolveImageryLayerValue(
        layer.saturation,
        1.0,
        frameState,
        layer,
        tile,
      );

      // Day/night alpha at offsets 62+ (packed per layer)
      const dnOffset = 62 + layerCount * 2;
      data[dnOffset] = resolveImageryLayerValue(
        layer.dayAlpha,
        1.0,
        frameState,
        layer,
        tile,
      );
      data[dnOffset + 1] = resolveImageryLayerValue(
        layer.nightAlpha,
        1.0,
        frameState,
        layer,
        tile,
      );

      layerCount++;
    }

    // ─── layerCount (f32 at float offset 48) ───
    // Changed from u32 to f32 to diagnose uniform buffer data transfer issue.
    // If the globe turns yellow with this change, the data IS reaching the
    // shader but the u32 interpretation was wrong.
    data[48] = layerCount;

    //>>includeStart('debug', pragmas.debug);
    // Dedicated diagnostic — logs EVERY frame (throttled to 1/sec) even
    // when layerCount=0, because layerCount=0 is exactly the failure mode
    // we need to catch. Fires independently of the shared `_diagShouldLog`
    // counter to avoid getting starved by center3D logging.

    const nowMs3 =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    if (
      this._diagLastLayerCountLogMs === undefined ||
      nowMs3 - this._diagLastLayerCountLogMs >= 1000
    ) {
      this._diagLastLayerCountLogMs = nowMs3;
      const readyCount = passLayers.filter(
        (l: CesiumTileImagery) => l?.readyImagery?.imageryLayer,
      ).length;
      const level = tile?.level ?? -1;
      const tileImageryCount = surfaceTile.imagery?.length ?? -1;
      console.log(
        `[WebGPU:GlobeTile] LAYERS tile=${level}_${tile?.x}_${tile?.y} ` +
          `layerCount=${layerCount} passLayersLen=${passLayers.length} ` +
          `readyInPass=${readyCount} surfaceTileImagery=${tileImageryCount} ` +
          `isSubsequentPass=${isSubsequentPass}`,
      );
    }
    //>>includeEnd('debug');

    // ─── Fog parameters (offsets 49-51) ───
    // Phase 1.4 — `frameState.atmosphericConditions.weather.humidity`
    // (default 0.5 = no change) modulates fog density on a (0.5+humidity)
    // multiplier: 0.0 humidity → 0.5× density (very dry desert), 0.5 →
    // 1.0× (default, no change), 1.0 → 1.5× (tropical jungle haze).
    // Linear and bounded so the existing fog tuning stays predictable.
    //
    // CRITICAL — belt-and-suspenders: when `fog.enabled === false`, force
    // density to 0 regardless of what `fog.density` says. `Fog.update()`
    // early-returns when `this.enabled` is false, which leaves any prior
    // non-zero density value sitting on `frameState.fog.density` stale.
    // At planetary scale that stale value causes the shader to fog every
    // distant pixel to black — the "black globe at distance" bug.
    // Explicitly zeroing when !enabled makes the GPU state consistent
    // with the user-facing switch.
    if (frameState && frameState.fog) {
      const fogEnabled = frameState.fog.enabled !== false;
      let density = fogEnabled ? (frameState.fog.density ?? 0.0) : 0.0;
      if (fogEnabled) {
        const ac = frameState.atmosphericConditions;
        const weather = ac && ac.weather ? ac.weather : undefined;
        if (weather && typeof weather.humidity === "number") {
          density = density * (0.5 + weather.humidity);
        }
      }
      data[49] = density;
      data[50] = fogEnabled ? (frameState.fog.offset ?? 0.0) : 0.0;
      data[51] = frameState.fog.minimumBrightness ?? 0.03;
      //>>includeStart('debug', pragmas.debug);
      // Dedicated throttle (independent of the tile-center3D log) so we
      // always see fog state at camera altitude transitions. Logs once
      // per second regardless of what other diagnostics are firing.
      const nowMs =
        typeof performance !== "undefined" ? performance.now() : Date.now();

      if (
        this._diagLastFogLogMs === undefined ||
        nowMs - this._diagLastFogLogMs >= 1000
      ) {
        this._diagLastFogLogMs = nowMs;
        const cameraHeight =
          frameState.camera?.positionCartographic?.height ?? -1;
        console.log(
          `[WebGPU:GlobeTile] fog density=${density.toExponential(3)} ` +
            `rawDensity=${(frameState.fog.density ?? 0).toExponential(3)} ` +
            `offset=${(data[50] ?? 0).toExponential(3)} ` +
            `minBrightness=${(frameState.fog.minimumBrightness ?? 0.03).toFixed(3)} ` +
            `enabled=${frameState.fog.enabled} gated=${fogEnabled} ` +
            `cameraHeight=${(cameraHeight / 1000).toFixed(0)}km`,
        );
      }
      //>>includeEnd('debug');
    } else {
      data[51] = 0.03;
      //>>includeStart('debug', pragmas.debug);
      // Called once — frameState.fog is missing entirely. That means
      // Scene.fog.update() never ran for this frame, which would fully
      // explain the "black globe at orbit" symptom: density stays at
      // whatever it was last set to and no zeroing path runs.

      if (!this._diagFogMissingLogged) {
        this._diagFogMissingLogged = true;
        console.error(
          `[WebGPU:GlobeTile] frameState.fog is UNDEFINED — ` +
            `Scene.fog.update() probably not running for this render path. ` +
            `Fog density will be stale from initialization.`,
        );
      }
      //>>includeEnd('debug');
    }

    // ─── Water mask translation and scale (offsets 52-55, vec4) ───
    if (!isSubsequentPass) {
      const wmTS = surfaceTile.waterMaskTranslationAndScale;
      if (wmTS) {
        data[52] = wmTS.x;
        data[53] = wmTS.y;
        data[54] = wmTS.z;
        data[55] = wmTS.w;
      }
    }

    // ─── Cartographic limit rectangle (offsets 56-59, vec4) ───
    if (tileProvider && tileProvider.cartographicLimitRectangle) {
      const limitRect = tileProvider.cartographicLimitRectangle;
      const tileRect = tile.rectangle;
      if (tileRect) {
        const invW = 1.0 / tileRect.width;
        const invH = 1.0 / tileRect.height;
        data[56] = (limitRect.west - tileRect.west) * invW;
        data[57] = (limitRect.south - tileRect.south) * invH;
        data[58] = (limitRect.east - tileRect.west) * invW;
        data[59] = (limitRect.north - tileRect.south) * invH;
      }
    } else {
      // No clipping — full tile visible
      data[58] = 1.0;
      data[59] = 1.0;
    }

    // ─── Night fade distance (offsets 60-61, vec2) ───
    if (tileProvider) {
      data[60] = tileProvider.nightFadeOutDistance ?? 10000000.0;
      data[61] = tileProvider.nightFadeInDistance ?? 50000000.0;
    } else {
      data[60] = 10000000.0;
      data[61] = 50000000.0;
    }

    // dayNightAlpha0-3 already set above during layer iteration (offsets 62-69)

    // ─── Padding (offsets 70-71) ───
    // Required for vec4 alignment of flags

    // ─── Flags (offsets 72-75, vec4) ───
    const hasWaterMask =
      !isSubsequentPass &&
      tileProvider &&
      tileProvider.hasWaterMask &&
      surfaceTile.waterMaskTexture !== undefined;
    const enableClipping =
      tileProvider &&
      tileProvider.cartographicLimitRectangle &&
      tileProvider.cartographicLimitRectangle.width < Math.PI * 2 - 0.001;
    const showOceanWaves =
      hasWaterMask &&
      tileProvider.showWaterEffect &&
      tileProvider.oceanNormalMap !== undefined;

    data[72] = hasWaterMask ? 1.0 : 0.0;
    data[73] = enableClipping ? 1.0 : 0.0;
    data[74] = showOceanWaves ? 1.0 : 0.0;
    data[75] = isSubsequentPass ? 1.0 : 0.0;

    // ─── Vertical exaggeration (offsets 76-77, vec2) ───
    data[76] = frameState?.verticalExaggeration ?? 1.0;
    data[77] = frameState?.verticalExaggerationRelativeHeight ?? 0.0;

    // ─── Time for ocean wave animation (offset 78) ───
    // Derive animation clock from `frameState.time` (a JulianDate) so every
    // view in a multi-view render pass samples the same wave phase and
    // screenshots are deterministic. Previously the renderer read
    // `performance.now()` directly, which drifts per-view and breaks
    // deterministic capture. Mod by 1e6 s (~11.6 days) to keep the
    // monotonic counter within f32 precision for smooth `sin(k*t)` / `fract`
    // kernels in the shader.
    const t = frameState?.time as
      | { dayNumber?: number; secondsOfDay?: number }
      | undefined;
    let waveTime = 0.0;
    if (t) {
      const secs = (t.dayNumber ?? 0) * 86400.0 + (t.secondsOfDay ?? 0);
      waveTime = secs % 1000000.0;
    }
    data[78] = waveTime;
    // OPEN-5 fix: fogVisualDensityScalar (offset 79) — replaces the pad.
    // Matches WebGL's `czm_fogVisualDensityScalar` auto-uniform (default
    // 0.15 from UniformState). Without this the fog formula is ~6.7x
    // stronger than WebGL at horizontal viewing angles.
    data[79] =
      frameState?.context?.uniformState?.fogVisualDensityScalar ?? 0.15;

    // ─── Ocean enhancement params (offsets 80-83, vec4) ───
    // oceanParams: x=deepR, y=deepG, z=deepB, w=fresnelPower
    // Defaults applied in shader when all zero (no tileProvider config needed)
    if (tileProvider?.oceanDeepColor) {
      const c = tileProvider.oceanDeepColor;
      data[80] = c.red ?? c.x ?? 0.008;
      data[81] = c.green ?? c.y ?? 0.045;
      data[82] = c.blue ?? c.z ?? 0.12;
    }
    data[83] = tileProvider?.oceanFresnelPower ?? 0.0; // 0 = use shader default

    // ─── Night & ocean secondary params (offsets 84-87, vec4) ───
    // nightOceanParams: x=nightIntensity, y=oceanReflectivity, z=foamThreshold, w=oceanDarkening
    data[84] = (tileProvider?.nightIntensity as number | undefined) ?? 0.0; // 0 = use shader default (2.5)
    data[85] = (tileProvider?.oceanReflectivity as number | undefined) ?? 0.0; // 0 = use shader default (0.04)
    data[86] = (tileProvider?.oceanFoamThreshold as number | undefined) ?? 0.0; // 0 = use shader default (0.35)
    data[87] = (tileProvider?.oceanDarkening as number | undefined) ?? 0.0; // 0 = use shader default (0.6)

    // ─── Per-tile debug fields (offsets 92-95, vec4) ───
    // Tier 2 debug: tile depth-level + imagery layer isolation. Both
    // sourced from frameState so a single Scene property toggle flips
    // them on for every tile uniformly. Production cost is two property
    // reads + two array writes per tile, sub-noise-floor.
    //   .x = tileLevel — read by fragmentDebugLod for the LOD overlay
    //   .y = isolateImageryLayer — when >= 0, fragmentMain renders only
    //        that layer index (0..3 within the current pass) and skips
    //        the rest of the imagery composite. -1 = production behavior.
    //   .z, .w = reserved for future per-tile debug toggles
    data[92] = tile?.level ?? 0;
    const isolate = frameState.debugShowImageryLayer;
    data[93] = typeof isolate === "number" && isolate >= 0 ? isolate : -1;
    data[94] = 0;
    data[95] = 0;

    // ─── DP-H24: HSB shift (offsets 96-99, vec4) ───
    // Mirrors WebGL GlobeFS.glsl `u_hsbShift`. `Globe.update()` copies
    // `Globe.atmosphereHueShift/Saturation/Brightness` onto the tile
    // provider each frame, so tileProvider is authoritative here.
    // The shader gates the HSB round-trip on |any| > 0.001, so writing
    // zeros (the default) carries no GPU cost.
    const tpHsb = tileProvider as unknown as {
      hueShift?: number;
      saturationShift?: number;
      brightnessShift?: number;
    };
    data[96] = typeof tpHsb.hueShift === "number" ? tpHsb.hueShift : 0;
    data[97] =
      typeof tpHsb.saturationShift === "number" ? tpHsb.saturationShift : 0;
    data[98] =
      typeof tpHsb.brightnessShift === "number" ? tpHsb.brightnessShift : 0;
    data[99] = 0;

    return this._writeUniformSlice(
      device,
      frameState,
      data,
      Math.max(TILE_UNIFORM_BYTES, 256),
      "Terrain tile UB",
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Texture Management
  // ═══════════════════════════════════════════════════════════════════════

  private _createTextureBindGroup(
    device: GPUDevice,
    passLayers: CesiumTileImagery[],
  ): GPUBindGroup {
    const textureViews: GPUTextureView[] = [];

    for (
      let i = 0;
      i < passLayers.length && textureViews.length < MAX_IMAGERY_LAYERS;
      i++
    ) {
      const tileImagery = passLayers[i];
      if (!tileImagery || !tileImagery.readyImagery) continue;

      const imagery = tileImagery.readyImagery;
      const view = this._getOrCreateImageryTexture(imagery);
      if (view) {
        textureViews.push(view);
      } else if (this._diagShouldLog()) {
        console.warn(
          `[WebGPU:GlobeTile] _getOrCreateImageryTexture returned null for imagery`,
          {
            hasImage: !!imagery?.image,
            hasTexture: !!imagery?.texture,
            hasWebGPUTex: !!imagery?._webgpuReprojectedTexture,
            texSource: !!(
              imagery?.texture as CesiumTextureWithSource | undefined
            )?._source,
          },
        );
      }
    }

    while (textureViews.length < MAX_IMAGERY_LAYERS) {
      textureViews.push(this._placeholderView!);
    }

    return device.createBindGroup({
      layout: this._bindGroupLayout1!,
      entries: [
        { binding: 0, resource: textureViews[0] },
        { binding: 1, resource: textureViews[1] },
        { binding: 2, resource: textureViews[2] },
        { binding: 3, resource: textureViews[3] },
        { binding: 4, resource: this._sampler! },
      ],
    });
  }

  /**
   * Create merged water mask + ocean normal bind group (Group 2).
   * Bindings 0-1: water mask texture + sampler
   * Bindings 2-3: ocean normal texture + sampler
   * Uses placeholder textures when resources are unavailable.
   */
  private _createWaterOceanBindGroup(
    device: GPUDevice,
    surfaceTile: CesiumGlobeSurfaceTile | null,
    tileProvider: CesiumGlobeTileProvider,
  ): GPUBindGroup {
    let waterMaskView = this._placeholderView!;
    let normalMapView = this._placeholderView!;

    if (surfaceTile) {
      const waterMaskTex = surfaceTile.waterMaskTexture;
      if (waterMaskTex) {
        const wmView = this._getOrCreateWaterMaskTexture(waterMaskTex);
        if (wmView) {
          waterMaskView = wmView;
        }
      }
    }

    const oceanNormalMap = tileProvider?.oceanNormalMap;
    if (oceanNormalMap) {
      const onm = oceanNormalMap as CesiumTextureWithSource;
      const source = onm._source ?? onm.image ?? oceanNormalMap;
      if (
        source instanceof HTMLImageElement ||
        source instanceof ImageBitmap ||
        source instanceof HTMLCanvasElement
      ) {
        const view = this._uploadImageSource(
          source,
          "oceanNormal",
          this._oceanNormalMapCache,
        );
        if (view) {
          normalMapView = view;
        }
      }
    }

    return device.createBindGroup({
      layout: this._bindGroupLayout2!,
      entries: [
        { binding: 0, resource: waterMaskView },
        { binding: 1, resource: this._waterMaskSampler! },
        { binding: 2, resource: normalMapView },
        { binding: 3, resource: this._oceanNormalSampler! },
      ],
    });
  }

  private _getOrCreateImageryTexture(
    imagery: CesiumReadyImagery | null | undefined,
  ): GPUTextureView | null {
    if (!imagery) return null;

    const cacheKey =
      imagery.key ||
      `${imagery.x ?? 0}_${imagery.y ?? 0}_${imagery.level ?? 0}`;
    const cached = this._imageryTextureCache.get(cacheKey);
    if (cached) return cached.view;

    // If imagery was reprojected by WebGPUImageryReprojection, use
    // the pre-reprojected GPUTexture directly instead of re-uploading.
    if (imagery._webgpuReprojectedTexture) {
      const gpuTex = imagery._webgpuReprojectedTexture;
      const view = gpuTex.createView({ label: `imagery_reproj_${cacheKey}` });
      this._imageryTextureCache.set(cacheKey, {
        texture: gpuTex,
        view,
        sourceWidth: gpuTex.width,
        sourceHeight: gpuTex.height,
      });
      return view;
    }

    const source = imagery.image || imagery._source;
    if (!source) {
      if (this._diagShouldLog()) {
        console.warn(`[WebGPU:GlobeTile] No image source for ${cacheKey}`, {
          hasImage: !!imagery.image,
          hasTexture: !!imagery.texture,
          texSource: !!imagery._source,
        });
      }
      return null;
    }

    if (this._diagShouldLog()) {
      console.log(
        `[WebGPU:GlobeTile] Uploading image for ${cacheKey} type=${(source as object).constructor?.name}`,
      );
    }
    return this._uploadImageSource(
      source as HTMLImageElement | HTMLCanvasElement | ImageBitmap,
      cacheKey,
      this._imageryTextureCache,
    );
  }

  private _getOrCreateWaterMaskTexture(
    waterMaskTex: CesiumOpaqueTexture,
  ): GPUTextureView | null {
    // Water mask textures are WebGL Texture objects; extract the source image
    const wm = waterMaskTex as CesiumTextureWithSource;
    const source = wm._source || wm.image;
    if (!source) return null;

    const cacheKey = `wm_${wm._id || "default"}`;
    const cached = this._waterMaskTextureCache.get(cacheKey);
    if (cached) return cached.view;

    return this._uploadImageSource(
      source,
      cacheKey,
      this._waterMaskTextureCache,
    );
  }

  /**
   * Upload an image source (ImageBitmap, HTMLImageElement, HTMLCanvasElement)
   * to a GPU texture.
   */
  private _uploadImageSource(
    source: ImageBitmap | HTMLImageElement | HTMLCanvasElement | unknown,
    cacheKey: string,
    cache: Map<string, ImageryGPUTexture>,
  ): GPUTextureView | null {
    // `source` is declared wider than the WebGPU-supported types because
    // the caller passes heterogeneous imagery payloads; the instanceof
    // chain below narrows to the actual GPU-copyable variants.
    const device = this._device!;

    try {
      let width: number, height: number;
      let gpuSource: ImageBitmap | HTMLImageElement | HTMLCanvasElement;
      if (source instanceof ImageBitmap) {
        width = source.width;
        height = source.height;
        gpuSource = source;
      } else if (source instanceof HTMLImageElement) {
        // C-P18: reject not-yet-decoded images. Without this check,
        // `copyExternalImageToTexture` throws "source is not in a valid
        // state" for any HTMLImageElement whose load/decode hasn't
        // completed — which happens unpredictably when imagery layers
        // hand off `<img>` refs immediately after `src=` assignment.
        // The uploader returns null; the caller's cache miss path
        // retries on the next frame when `complete` flips to true.
        if (!source.complete || source.naturalWidth === 0) {
          return null;
        }
        width = source.naturalWidth || source.width;
        height = source.naturalHeight || source.height;
        gpuSource = source;
      } else if (source instanceof HTMLCanvasElement) {
        width = source.width;
        height = source.height;
        gpuSource = source;
      } else {
        return null;
      }

      if (width === 0 || height === 0) return null;

      const texture = device.createTexture({
        label: `Globe ${cacheKey}`,
        size: [width, height],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });

      device.queue.copyExternalImageToTexture(
        { source: gpuSource },
        { texture },
        [width, height],
      );

      const view = texture.createView();
      cache.set(cacheKey, {
        texture,
        view,
        sourceWidth: width,
        sourceHeight: height,
      });

      return view;
    } catch (e) {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Wireframe Debug Mode
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get or lazily create a wireframe (line-list) pipeline for the given
   * quantization/normals combination. Wireframe pipelines reuse the same
   * shaders but use line-list topology with no back-face culling.
   */
  /**
   * Cold-path wireframe pipeline selector. Mirrors `_selectPipeline` exactly
   * in shape (Q/U, N/X, M/G, stride) so the wireframe variant uses the same
   * vertex layout as the production pipeline for the tile being drawn —
   * crucial because mismatched strides crash the GPU. Only differs in
   * topology (line-list vs triangle-list) and cull mode.
   *
   * Kept entirely off the hot path; only invoked when
   * `frameState.debugShowGlobeWireframe` is true.
   */
  private _selectWireframePipeline(
    isQuantized: boolean,
    hasNormals: boolean,
    hasWebMercatorT: boolean,
    strideBytes: number,
    hasGeodeticSurfaceNormals: boolean = false,
  ): GPURenderPipeline {
    const defines = hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0;
    const cacheKey = `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}_${strideBytes}|${defines.toString(16)}`;
    let pipeline = this._wireframePipelineCache.get(cacheKey);
    if (pipeline) {
      return pipeline;
    }
    pipeline = this._createWireframePipelineVariant(
      isQuantized,
      hasNormals,
      hasWebMercatorT,
      strideBytes,
      hasGeodeticSurfaceNormals,
    );
    this._wireframePipelineCache.set(cacheKey, pipeline);
    return pipeline;
  }

  /**
   * Builds a wireframe variant of the terrain pipeline. Vertex stage is the
   * full production layout (matching `_createPipelineVariant`); only the
   * primitive topology and depth/cull state differ. Reuses the production
   * shader module — no special wireframe entry point needed because line-list
   * topology applied to triangle indices produces edges automatically when
   * the IB is converted (see `_getOrCreateWireframeIndices`).
   */
  private _createWireframePipelineVariant(
    isQuantized: boolean,
    hasNormals: boolean,
    hasWebMercatorT: boolean,
    strideBytes: number,
    hasGeodeticSurfaceNormals: boolean = false,
  ): GPURenderPipeline {
    const device = this._device!;

    let vertexBuffers: GPUVertexBufferLayout[];
    let entryPoint: string;
    // Batch 20 — the production shader module + our `GEODETIC_NORMAL`
    // define keep the wireframe pipeline's vertex layout in sync with
    // the colored pass automatically. Entry-point names are unqualified;
    // the correct variant is selected via the active-defines bitmask
    // passed to `_getProductionShaderModule`.
    const defines = hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0;

    if (isQuantized) {
      // See `_createPipelineVariant` for the full documentation of the
      // compressed0 / compressed1 layout. This block must stay in sync.
      let format: GPUVertexFormat;
      const hasCompressed1 = hasWebMercatorT && hasNormals;
      if (hasCompressed1) {
        format = "float32x4";
        entryPoint = "vertexMainQuantizedWebMercNormals";
      } else if (hasWebMercatorT) {
        format = "float32x4";
        entryPoint = "vertexMainQuantizedWebMerc";
      } else if (hasNormals) {
        format = "float32x4";
        entryPoint = "vertexMainQuantized";
      } else {
        format = "float32x3";
        entryPoint = "vertexMainQuantized";
      }
      const baseStride = hasWebMercatorT || hasNormals ? 16 : 12;
      const minStride =
        baseStride +
        (hasCompressed1 ? 4 : 0) +
        (hasGeodeticSurfaceNormals ? 12 : 0);
      const actualStride = Math.max(strideBytes, minStride);
      const attributes: GPUVertexAttribute[] = [
        { shaderLocation: 0, offset: 0, format },
      ];
      if (hasCompressed1) {
        attributes.push({
          shaderLocation: 1,
          offset: 16,
          format: "float32",
        });
      }
      if (hasGeodeticSurfaceNormals) {
        attributes.push({
          shaderLocation: 2,
          offset: actualStride - 12,
          format: "float32x3",
        });
      }
      vertexBuffers = [
        {
          arrayStride: actualStride,
          stepMode: "vertex",
          attributes,
        },
      ];
    } else {
      let texCoordFormat: GPUVertexFormat;
      if (hasWebMercatorT && hasNormals) {
        texCoordFormat = "float32x4";
        entryPoint = "vertexMainWebMercNormals";
      } else if (hasWebMercatorT) {
        texCoordFormat = "float32x3";
        entryPoint = "vertexMainWebMerc";
      } else if (hasNormals) {
        texCoordFormat = "float32x3";
        entryPoint = "vertexMain";
      } else {
        texCoordFormat = "float32x2";
        entryPoint = "vertexMain";
      }
      const minUncompressedStride = 24 + (hasGeodeticSurfaceNormals ? 12 : 0);
      const actualStride = Math.max(strideBytes, minUncompressedStride);
      const attributes: GPUVertexAttribute[] = [
        { shaderLocation: 0, offset: 0, format: "float32x4" },
        { shaderLocation: 1, offset: 16, format: texCoordFormat },
      ];
      if (hasGeodeticSurfaceNormals) {
        attributes.push({
          shaderLocation: 2,
          offset: actualStride - 12,
          format: "float32x3",
        });
      }
      vertexBuffers = [
        {
          arrayStride: actualStride,
          stepMode: "vertex",
          attributes,
        },
      ];
    }

    const quantLabel = isQuantized ? "quantized" : "uncompressed";
    const normLabel = hasNormals ? "normals" : "noNormals";
    const mercLabel = hasWebMercatorT ? "webMerc" : "geo";

    // Batch 20 — wireframe fetches the module from the shader cache with
    // the same `defines` used by the production pipeline for this tile,
    // so the wireframe overlay always matches its colored counterpart.
    const shaderModule = this._getProductionShaderModule(defines);
    return device.createRenderPipeline({
      label: `Globe wireframe (${quantLabel}, ${normLabel}, ${mercLabel}, ${strideBytes}b)`,
      layout: this._pipelineLayout!,
      vertex: {
        module: shaderModule,
        entryPoint,
        buffers: vertexBuffers,
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: this._canvasFormat }],
      },
      primitive: {
        topology: "line-list",
        cullMode: "none",
      },
      depthStencil: {
        format: "depth24plus-stencil8",
        // Slight depth bias would be ideal here, but WebGPU's depthBias
        // applies only to triangle topology — for line-list we accept the
        // co-planar z-fight and rely on the wireframe being a debug overlay.
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    });
  }

  /**
   * Convert triangle indices to line indices. Each triangle (i0, i1, i2)
   * produces 3 line segments: (i0,i1), (i1,i2), (i2,i0). Creates and
   * caches a GPU index buffer for the wireframe.
   */
  private _getOrCreateWireframeIndices(
    tileKey: string,
    mesh: CesiumTerrainMesh,
  ): { buffer: GPUBuffer; count: number; format: GPUIndexFormat } | null {
    const cached = this._wireframeIndexCache.get(tileKey);
    if (cached) return cached;

    const device = this._device!;
    const triIndices = mesh.indices;
    if (!triIndices || triIndices.length < 3) return null;

    const triCount = Math.floor(triIndices.length / 3);
    const lineCount = triCount * 3; // 3 edges per triangle
    const lineIndexCount = lineCount * 2; // 2 indices per line

    // Use same index type as the source
    const use32 = triIndices.BYTES_PER_ELEMENT === 4;
    const wireIndices = use32
      ? new Uint32Array(lineIndexCount)
      : new Uint16Array(lineIndexCount);

    let out = 0;
    for (let t = 0; t < triCount; t++) {
      const base = t * 3;
      const i0 = triIndices[base];
      const i1 = triIndices[base + 1];
      const i2 = triIndices[base + 2];
      wireIndices[out++] = i0;
      wireIndices[out++] = i1;
      wireIndices[out++] = i1;
      wireIndices[out++] = i2;
      wireIndices[out++] = i2;
      wireIndices[out++] = i0;
    }

    const buffer = device.createBuffer({
      label: `Terrain wireframe IB ${tileKey}`,
      size: wireIndices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, gpuData(wireIndices));

    const result = {
      buffer,
      count: lineIndexCount,
      format: (use32 ? "uint32" : "uint16") as GPUIndexFormat,
    };
    this._wireframeIndexCache.set(tileKey, result);
    return result;
  }

  /**
   * Create wireframe draw commands for a tile. Uses line-list topology
   * pipeline and triangle-to-line converted index buffer.
   */
  createWireframeTileCommands(
    tile: {
      level: number;
      x: number;
      y: number;
      rectangle: CesiumRectangle;
      boundingVolume?: CesiumBoundingSphere;
    },
    surfaceTile: CesiumGlobeSurfaceTile,
    tileProvider: CesiumGlobeTileProvider,
    frameState: CesiumFrameState,
    uniformState: CesiumUniformState,
  ): TileDrawDescriptor[] | null {
    if (!this._isInitialized || !this._device) return null;

    const device = this._device;
    const mesh = surfaceTile.renderedMesh || surfaceTile.mesh;
    if (!mesh) return null;

    const tileKey = this._getTileKey(tile);
    const gpuResources = this._getOrCreateTileBuffers(tileKey, mesh);
    if (!gpuResources) return null;

    const wireIB = this._getOrCreateWireframeIndices(tileKey, mesh);
    if (!wireIB) return null;

    const pipeline = this._selectWireframePipeline(
      gpuResources.isQuantized,
      gpuResources.hasNormals,
      gpuResources.hasWebMercatorT,
      gpuResources.strideBytes,
      gpuResources.hasGeodeticSurfaceNormals,
    );

    // Single pass for wireframe — no multi-pass imagery needed
    const cameraUB = this._createCameraUniformBuffer(
      device,
      uniformState,
      surfaceTile,
      tileProvider,
      mesh,
      frameState,
      tile,
    );
    const tileUB = this._createTileUniformBuffer(
      device,
      surfaceTile,
      tileProvider,
      frameState,
      tile,
      [],
      false,
    );

    const bindGroup0 = device.createBindGroup({
      layout: this._bindGroupLayout0!,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: cameraUB.buffer,
            offset: cameraUB.offset,
            size: cameraUB.size,
          },
        },
        {
          binding: 1,
          resource: {
            buffer: tileUB.buffer,
            offset: tileUB.offset,
            size: tileUB.size,
          },
        },
      ],
    });

    // Use placeholder textures for wireframe — imagery not needed
    const bindGroup1 = this._createTextureBindGroup(device, []);
    const bindGroup2 = this._createWaterOceanBindGroup(
      device,
      null,
      tileProvider,
    );

    return [
      {
        pipeline,
        bindGroups: [
          bindGroup0,
          bindGroup1,
          bindGroup2,
          this._placeholderEffectsBG!,
        ],
        vertexBuffer: gpuResources.vertexBuffer,
        indexBuffer: wireIB.buffer,
        indexCount: wireIB.count,
        indexFormat: wireIB.format,
        boundingVolume:
          (tile.boundingVolume as CesiumBoundingSphere | undefined) ||
          surfaceTile.boundingSphere3D,
        isSubsequentPass: false,
      },
    ];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Cache Eviction
  // ═══════════════════════════════════════════════════════════════════════

  evictStaleResources(activeTileKeys: Set<string>): void {
    for (const [key, resources] of this._tileBufferCache) {
      if (!activeTileKeys.has(key)) {
        resources.vertexBuffer.destroy();
        resources.indexBuffer.destroy();
        resources.shadowCastUB?.destroy();
        this._tileBufferCache.delete(key);
      }
    }
  }

  removeImageryTexture(cacheKey: string): void {
    const cached = this._imageryTextureCache.get(cacheKey);
    if (cached) {
      cached.texture.destroy();
      this._imageryTextureCache.delete(cacheKey);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Pipeline Access
  // ═══════════════════════════════════════════════════════════════════════

  get pipeline(): GPURenderPipeline | null {
    return this._pipelineCache.get("UNO_28") ?? null;
  }

  get pipelineNoNormals(): GPURenderPipeline | null {
    return this._pipelineCache.get("UXO_24") ?? null;
  }

  get pipelineQuantized(): GPURenderPipeline | null {
    return this._pipelineCache.get("QNO_16") ?? null;
  }

  get pipelineQuantizedNoNormals(): GPURenderPipeline | null {
    return this._pipelineCache.get("QXO_12") ?? null;
  }

  get bindGroupLayout0(): GPUBindGroupLayout | null {
    return this._bindGroupLayout0;
  }

  get bindGroupLayout1(): GPUBindGroupLayout | null {
    return this._bindGroupLayout1;
  }

  get bindGroupLayout2(): GPUBindGroupLayout | null {
    return this._bindGroupLayout2;
  }

  get sampler(): GPUSampler | null {
    return this._sampler;
  }

  get placeholderTextureView(): GPUTextureView | null {
    return this._placeholderView;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════════════════

  destroy(): void {
    if (this._isDestroyed) return;

    for (const [, resources] of this._tileBufferCache) {
      resources.vertexBuffer.destroy();
      resources.indexBuffer.destroy();
      resources.shadowCastUB?.destroy();
    }
    this._tileBufferCache.clear();

    for (const [, cached] of this._imageryTextureCache) {
      cached.texture.destroy();
    }
    this._imageryTextureCache.clear();

    for (const [, cached] of this._waterMaskTextureCache) {
      cached.texture.destroy();
    }
    this._waterMaskTextureCache.clear();

    for (const [, cached] of this._oceanNormalMapCache) {
      cached.texture.destroy();
    }
    this._oceanNormalMapCache.clear();

    for (const [, wf] of this._wireframeIndexCache) {
      wf.buffer.destroy();
    }
    this._wireframeIndexCache.clear();

    if (this._placeholderTexture) {
      this._placeholderTexture.destroy();
    }

    this._pipelineCache.clear();
    this._wireframePipelineCache.clear();
    this._debugFragmentPipelineCache.clear();
    if (this._shaderModuleCache) {
      this._shaderModuleCache.destroy();
      this._shaderModuleCache = null;
    }
    this._debugFragmentShaderModules.clear();
    this._clipDistancesShaderModules.clear();
    this._sampler = null;
    this._waterMaskSampler = null;
    this._oceanNormalSampler = null;
    this._bindGroupLayout0 = null;
    this._bindGroupLayout1 = null;
    this._bindGroupLayout2 = null;
    this._effectsBGL = null;
    this._placeholderEffectsBG = null;
    this._pipelineLayout = null;
    this._device = null;
    this._isInitialized = false;
    this._isDestroyed = true;
  }

  isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
