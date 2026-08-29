/// <reference types="@webgpu/types" />
import ShadowMode from "../../Scene/ShadowMode.js";
import { createEffectsBindGroup } from "./WebGPUEffectsBindGroup.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import {
  initShaderCache as initShaderCacheHelper,
  getProductionShaderModule as getProductionShaderModuleHelper,
  getDebugFragmentShaderModule as getDebugFragmentShaderModuleHelper,
  getClipDistancesShaderModule as getClipDistancesShaderModuleHelper,
} from "./WebGPUGlobeSurfaceShaders.js";
import {
  createBindGroupLayouts as createBindGroupLayoutsHelper,
  createPipelineLayout as createPipelineLayoutHelper,
  createSamplers as createSamplersHelper,
  createPlaceholderTexture as createPlaceholderTextureHelper,
} from "./WebGPUGlobeSurfaceLayouts.js";
import {
  getOrCreateImageryTexture as getOrCreateImageryTextureHelper,
  getOrCreateWaterMaskTexture as getOrCreateWaterMaskTextureHelper,
  uploadImageSource as uploadImageSourceHelper,
} from "./WebGPUGlobeSurfaceTextures.js";
import type { ImageryRealizationContext } from "./WebGPUGlobeSurfaceTextures.js";
import {
  VECTOR_TILE_PLACEHOLDER_BYTES,
  resolveVectorTileBuffer,
} from "./WebGPUVectorTileResources.js";
import { WebGPUSharedImageryRealizations } from "./WebGPUSharedImageryRealizations.js";
import {
  selectWireframePipeline as selectWireframePipelineHelper,
  getOrCreateWireframeIndices as getOrCreateWireframeIndicesHelper,
} from "./WebGPUGlobeSurfaceWireframe.js";
import {
  selectPipeline as selectPipelineHelper,
  selectPickPipeline as selectPickPipelineHelper,
  selectDebugFragmentPipeline as selectDebugFragmentPipelineHelper,
  selectDepthOnlyBackFacePipeline as selectDepthOnlyBackFacePipelineHelper,
  selectDepthOnlyFrontFacePipeline as selectDepthOnlyFrontFacePipelineHelper,
  selectTranslucentBackFacePipeline as selectTranslucentBackFacePipelineHelper,
  selectCapturePipeline as selectCapturePipelineHelper,
  buildPipelineDescriptor,
  descriptorToGPU,
} from "./WebGPUGlobeSurfacePipelines.js";
import { ShaderDefine, ShaderDefineHi } from "./WebGPUShaderDefines.js";
import {
  isWebGPULogDepthActive,
  isWebGPUPickLogDepthActive,
} from "./WebGPULogDepth.js";
import {
  buildGlobePipelineCacheKey,
  findGlobePipelineVariant,
  listGlobePipelineVariants,
} from "./WebGPUGlobeSurfacePipelineKey.js";
import type {
  GlobePipelineVariantInfo,
  GlobePipelineVariantKind,
} from "./WebGPUGlobeSurfacePipelineKey.js";
import { preprocess as preprocessWGSL } from "./WebGPUShaderPreprocessor.js";
import {
  getTileKey as getTileKeyHelper,
  getOrCreateTileBuffers as getOrCreateTileBuffersHelper,
  evictStaleResources as evictStaleResourcesHelper,
  removeImageryTexture as removeImageryTextureHelper,
} from "./WebGPUGlobeSurfaceTileBuffers.js";
import { createCameraUniformBuffer as createCameraUniformBufferHelper } from "./WebGPUGlobeSurfaceCameraUB.js";
import { WebGPUGlobeEclipseUniforms } from "./WebGPUGlobeEclipseUniforms.js";
import { createTileUniformBuffer as createTileUniformBufferHelper } from "./WebGPUGlobeSurfaceTileUB.js";
import { WebGPUGlobeBindGroupCache } from "./WebGPUGlobeBindGroupCache.js";
import {
  aggregateCompositeUniforms,
  buildMaterialPrelude,
  rewriteMaterialBody,
  packMaterialUBO,
  assembleMaterialWGSLSource,
  resolveMaterialTextureView,
  type MaterialPipelineCacheEntry,
} from "./WebGPUGlobeMaterial.js";
import type { WebGPURenderPipelineCache } from "./WebGPURenderPipelineCache.js";
import {
  CAMERA_UNIFORM_FLOATS,
  TILE_UNIFORM_FLOATS,
  MAX_IMAGERY_LAYERS,
  computeGlobeImagerySlotCount,
  DebugFragmentMode,
} from "./WebGPUGlobeSurfaceTypes.js";
import type {
  GlobePipelineEntry,
  TileGPUResources,
  ImageryGPUTexture,
  TileDrawDescriptor,
  WebGPUGlobeLogicalCounters,
} from "./WebGPUGlobeSurfaceTypes.js";

// ShadowMode.js adds its helper functions after constructing the enum object.
// TypeScript sees only the initial enum literals across the JS module boundary,
// so preserve the canonical runtime helper with its complete structural shape.
const shadowModeRuntime = ShadowMode as typeof ShadowMode & {
  receiveShadows(shadowMode: unknown): boolean;
};

// Re-export the public surface so existing import sites that pull
// `TileDrawDescriptor` / `DebugFragmentMode` from this file keep compiling.
export type { TileDrawDescriptor } from "./WebGPUGlobeSurfaceTypes.js";
export { DebugFragmentMode } from "./WebGPUGlobeSurfaceTypes.js";

// The terrain-global group-3 effects state — shadow receive, CSM, atmosphere
// LUT, clipping planes and polygons — is identical for every selected tile in a
// frame/view, so it is resolved and packed once and reused. This snapshot
// records the exact inputs that determine those bytes and the
// placeholder-versus-active decision, so tiles 2..N reuse one prepared
// `GPUBindGroup`.
//
// The memo lives on the context, not on the per-GPUDevice renderer instance:
// pooled devices are shared across Scenes, so a renderer-scoped memo keyed by
// frameNumber alone would alias Scene A's camera bytes into Scene B. Same
// rationale as `_ensureEffectsBgCache` in `WebGPUEffectsBindGroup.js` and the
// primitive path's `_getOrCreateSharedPrimitiveEffectsBG`.
interface GlobeEffectsHandleSnapshot {
  frameNumber: number;
  device: GPUDevice;
  bindGroup: GPUBindGroup;
  // Reference identity of every resolved effect input, undefined when the
  // feature is inactive. Any reference mismatch misses and forces a fresh
  // prepare.
  receiveShadowMap: unknown;
  csmParamsBuffer: unknown;
  csmArrayView: unknown;
  csmPcfRadius: number | undefined;
  lutTransmittance: unknown;
  lutInscatter: unknown;
  clippingPlanes: unknown;
  clippingPlanesLength: number;
  clippingPolygons: unknown;
  clippingPolygonsLength: number;
  tileProvider: unknown;
  // Camera position values, not the mutated-in-place scratch Cartesian3
  // reference: the clip-plane dPrime bytes depend on them, and a multi-view
  // frame can reuse one frameNumber across different cameras.
  cameraX: number;
  cameraY: number;
  cameraZ: number;
}

// Home for the per-(context, frame) prepared globe effects handle. Mirrors the
// `_primitiveEffectsBG*` fields the primitive path declares on the context.
type GlobeEffectsMemoContext = {
  _globeEffectsHandle?: GlobeEffectsHandleSnapshot | null;
};

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
export class WebGPUGlobeSurfaceRenderer {
  // Public underscore: shared with the shader factory.
  public _device: GPUDevice | null = null;
  private _diagTileCount = 0;
  private _diagLastLogTime = 0;
  // Public underscore: the next 3 diag-throttle fields are shared with
  // the tile-UB packer.
  public _diagLastLayerCountLogMs = 0;
  public _diagLastFogLogMs = 0;
  public _diagFogMissingLogged = false;
  private _lastOverflowWarnTime = 0;

  /**
   * Throttle diagnostic logs to once per 3 seconds, and only for the first
   * tile. In production builds (`removePragmas: true`) the pragma stripper
   * replaces this method with a constant `false` return, so the diagnostic code
   * at each call site is dead-code-eliminated by esbuild.
   */
  // Public underscore: shared with the texture-cache helpers.
  public _diagShouldLog(): boolean {
    //>>includeStart('debug', pragmas.debug);
    if (this._diagTileCount !== 0) return false;
    const now = performance.now();
    if (now - this._diagLastLogTime < 3000) return false;
    this._diagLastLogTime = now;
    return true;
    //>>includeEnd('debug');
    return false;
  }
  // Last observed value of `frameState.debugShowImageryProbe`, used to detect
  // the rising edge so the imagery-probe latch resets when the operator toggles
  // the flag back on for a second sample.
  private _lastProbeFlag = false;
  // Holds `GlobePipelineEntry` slots; the GPU pipeline materializes through
  // `webgpuPipelineCache` so two GlobeSurfaceRenderer instances (split-screen,
  // multi-viewer) sharing the same descriptor share one `GPURenderPipeline`.
  // Public underscore: shared with the pipeline helpers.
  public _pipelineCache: Map<string, GlobePipelineEntry> = new Map();
  // Central pipeline cache reference, captured lazily on the first
  // `createTileCommands` call (which has access to `frameState.context`).
  // Stays null when the renderer's GraphicsContext doesn't expose one
  // (WebGL fallback shouldn't reach this code path, but defensive).
  // Public underscore: shared with the pipeline helpers.
  public _centralPipelineCache: WebGPURenderPipelineCache | null = null;
  // The production shader module is resolved through the
  // `WebGPUShaderModuleCache` keyed by `(ShaderSourceId.GLOBE_TERRAIN, defines)`.
  // The cache runs the `//>>ifdef` preprocessor against `_shaderCode` on
  // first use per define-set and deduplicates repeat requests. Prewarmed at
  // `initialize()` time with the common define sets so first-frame render
  // pays no shader-compile cost.
  // Public underscore: shared with the shader factory.
  public _shaderModuleCache: WebGPUShaderModuleCache | null = null;
  // Source preserved so it can be lazily augmented with debug fragment entry
  // points (triangulation / LOD overlay / normal-as-color) and the hardware
  // clip-distances variant. Consumers run the preprocessor on this raw source
  // before creating derived modules.
  // Public underscore: shared with the shader factory.
  public _shaderCode: string = "";
  // Debug fragment augmented modules, keyed by active-defines bitmask. A
  // `null` value means the device rejected the augmented source for that
  // define-set during the one-shot validation probe — subsequent lookups
  // return null and the caller falls back to the production fragment.
  // Public underscore: shared with the shader factory.
  public _debugFragmentShaderModules = new Map<
    number,
    GPUShaderModule | null
  >();
  // Public underscore: shared with the pipeline helpers.
  public _debugFragmentPipelineCache: Map<string, GlobePipelineEntry> =
    new Map();
  // Cache for single-target scene-capture pipeline variants, keyed on face
  // format, CAPTURE_MODE and vertex shape. Deliberately not wiped by the
  // `_scenePipelineFormatGeneration` reset in `createTileCommands`: the capture
  // target format follows the env cube rather than the canvas, so a
  // canvas-format or MSAA flip must not invalidate it, and a capture build must
  // not bump the on-screen generation, which would rebuild every on-screen
  // globe pipeline on each frame capture runs. Public underscore: shared with
  // the capture-pipeline helper.
  public _capturePipelineCache: Map<string, GlobePipelineEntry> = new Map();
  // Hardware clip-distances shader variant, built lazily by string-augmenting a
  // preprocessed `_shaderCode` to declare the `@builtin(clip_distances)` vertex
  // output and compute it from the precomputed `effects.clipPlaneEqHW` values.
  // The fragment-side `globeClipByPlanes` discard is neutralized in the
  // augmented source so the rasterizer is the sole authority. Probed once per
  // active-defines set and cached for the lifetime of the renderer; a `null`
  // value after the probe means the device rejected the augmented source — a
  // driver bug or a missing feature — and the production module is the
  // fallback.
  // Public underscore: shared with the shader factory.
  public _clipDistancesShaderModules = new Map<
    number,
    GPUShaderModule | null
  >();
  // Public underscore: the next 11 fields are shared with the layouts
  // initializer. The renderer reads them every frame and clears them in
  // `destroy()`; the helpers in `WebGPUGlobeSurfaceLayouts.ts` populate them
  // once at init time.
  public _sampler: GPUSampler | null = null;
  public _waterMaskSampler: GPUSampler | null = null;
  public _bindGroupLayout0: GPUBindGroupLayout | null = null;
  public _bindGroupLayout1: GPUBindGroupLayout | null = null;
  public _bindGroupLayout2: GPUBindGroupLayout | null = null;
  // Group 3 is the effects bind group; water and ocean are merged into group 2.
  public _effectsBGL: GPUBindGroupLayout | null = null;
  public _placeholderEffectsBG: GPUBindGroup | null = null;
  public _oceanNormalSampler: GPUSampler | null = null;
  // The sun-view Beer shadow map view and sampler to bind at group 2, bindings
  // 9-10, this frame. Captured each frame from `context._cloudCache` in
  // `createTileCommands`; null makes the group-2 bind group use the renderer's
  // own 1×1 placeholder (`_placeholderView` + `_sampler`, an optical depth of
  // white, so transmittance 1). Their identity is folded into the group-2
  // bind-group cache key so a real-versus-placeholder swap rebuilds the group.
  private _cloudShadowView: GPUTextureView | null = null;
  private _cloudShadowSampler: GPUSampler | null = null;
  private _oceanNormalMapCache: Map<string, ImageryGPUTexture> = new Map();
  // `uploadImageSource` only writes to the cache map it is handed — it never
  // reads it — and its shared-realization dedupe is gated on
  // `logicalOwner === "imagery"`, which the ocean-normal call site does not
  // pass. Without this source-identity guard the normal map is re-uploaded
  // (copyExternalImageToTexture, mip regen, createView) once per tile per frame
  // even on a static scene, and because the group-2 bind-group cache keys on
  // view identity, a fresh view each call also forces a createBindGroup every
  // frame. Same idiom as `_materialTextureCache` below.
  private _oceanNormalMapSource: unknown = null;
  private _oceanNormalMapView: GPUTextureView | null = null;
  public _pipelineLayout: GPUPipelineLayout | null = null;
  // Material state lives at @group(2) bindings 4-8: UBO, image
  // texture/sampler, heights texture/sampler. Merging it into group 2 keeps the
  // total bind-group count at 4, so devices reporting the WebGPU spec floor of
  // `maxBindGroups: 4` — Edge on some adapters — can still use the material
  // pipeline path. There is no separate material pipeline layout; the regular
  // `_pipelineLayout` is reused with a wider group 2.
  //
  // This placeholder UBO is bound at @group(2) @binding(4) when no material is
  // active, so the bind group still validates against the expanded group-2
  // layout. Lazy-initialized on the first non-material draw.
  private _placeholderMaterialUBO: GPUBuffer | null = null;
  // The shared all-zero storage buffer bound at @group(2) @binding(11) for
  // every tile without draped vector geometry. Its zeroed `gridWidth` header
  // word is the shader's early-out sentinel. Lazy-initialized on the first
  // group-2 build.
  private _placeholderVectorBuffer: GPUBuffer | null = null;
  // Per-material cache. Keyed by `material.type` since (a) the WGSL
  // source is determined by the fabric (which is associated with the
  // type) and (b) Cesium's `MaterialCache` already deduplicates per-type.
  // Entry holds the assembled WGSL, the shader module, the UBO + its
  // layout, and a sub-cache of GPURenderPipelines keyed on the geometry and
  // render-target variant (one pipeline per stride/quantized/blend/format/
  // sample-count combination).
  private _materialPipelineCache: Map<string, MaterialPipelineCacheEntry> =
    new Map();
  // Per-material texture cache. Cesium materials (e.g., ElevationRamp)
  // generate `image` uniforms as HTMLCanvasElement on the JS side —
  // they don't go through the imagery upload pipeline so they have no
  // `_webgpuTexture`. Cache uploaded views by `${materialType}|${uniformName}`
  // and re-upload only when the source identity changes.
  private _materialTextureCache: Map<
    string,
    { source: unknown; view: GPUTextureView }
  > = new Map();
  public _placeholderTexture: GPUTexture | null = null;
  public _placeholderView: GPUTextureView | null = null;
  // 1×1 r8unorm zero fallback bound at @group(2) @binding(0) when a tile's
  // water mask is not GPU-resident. The shared white placeholder reads as
  // waterMask=1.0, all water, and ocean-shades whole land tiles; zero means all
  // land, which matches WebGL.
  public _noWaterMaskTexture: GPUTexture | null = null;
  public _noWaterMaskView: GPUTextureView | null = null;
  // Public underscore: shared with the wireframe helpers.
  public _canvasFormat: GPUTextureFormat = "bgra8unorm";
  // The globe pick pipeline's color target format, mirrored from
  // `context.pickPipelineFormat` — the sole byte-object-ID attachment
  // authority — whenever the scene-format generation bumps. Equals
  // `_canvasFormat` in SDR; stays an 8-bit unorm when the scene target flips to
  // a float/HDR format.
  public _pickFormat: GPUTextureFormat = "rgba8unorm";
  // MSAA sample count, tracked alongside the format and captured from
  // `context._msaaSamples` on each `maybeUpdateForSceneFormat` call, mirroring
  // `_canvasFormat`. `PipelineHost` consumers read it to bake
  // `multisample.count` into globe pipelines. The shared
  // `_scenePipelineFormatGeneration` counter also bumps on an MSAA change (see
  // `WebGPUSceneRenderer.prepareFrame`), triggering this renderer's pipeline
  // cache wipe at the same point.
  public _sampleCount: number = 1;
  // Renderer-wide log-depth state, resolved each frame from the SHARED gate
  // `isWebGPULogDepthActive(context, frameState)` = the `_logDepthWriteEnabled`
  // master switch AND `frameState.useLogDepth`, so `buildPipelineDescriptor`
  // (via `host._logDepthEnabled`) ORs the `LOG_DEPTH` shader define into the
  // globe pipeline's defines + cache key on exactly the frames every sibling
  // producer does.
  //
  // Mirroring `context._logDepthWriteEnabled` alone would make the globe the
  // only WebGPU depth producer that ignores `frameState.useLogDepth`. `Scene.js`
  // clears that flag on any orthographic frustum (2D, Columbus View,
  // `camera.switchToOrthographicFrustum()`) and whenever
  // `scene.logarithmicDepthBuffer` is false, so in those modes the globe would
  // write log-encoded `frag_depth` into the same attachment the classifiers,
  // the enhanced-ocean depth test and the depth plane read as hyperbolic —
  // mixed encodings in one buffer. Under a pure orthographic frustum the log
  // encode also degenerates: clip `.w` is constant, so `csm_vertexLogDepth`
  // collapses to a per-draw constant, and it is NaN when near > 2.0.
  public _logDepthEnabled: boolean = false;
  // Pick-fleet log-depth state, held separately from `_logDepthEnabled` and
  // resolved from `isWebGPUPickLogDepthActive(context, frameState)` — the
  // `_pickLogDepthWriteEnabled` master switch and `frameState.useLogDepth`.
  // `selectPickPipeline` ORs LOG_DEPTH from this flag, not `_logDepthEnabled`,
  // into its pick-pipeline cache key. The pick mini-frame owns one shared depth
  // attachment, so the whole fleet must be uniformly hyperbolic or uniformly
  // log; every sibling pick producer drops to hyperbolic when `useLogDepth` is
  // false, so the globe must too.
  public _pickLogDepthEnabled: boolean = false;
  // Renderer mirror of `Globe.enableEnhancedOcean`, default false. When true,
  // the globe shader factory ORs `ShaderDefineHi.ENHANCED_OCEAN` into
  // `definesHi` through `host._enhancedOceanEnabled`, selecting the enhanced
  // ocean styling branch of `computeEnhancedOcean`; false compiles the classic
  // WebGL-parity branch. Only the styling is gated — the shared wave march is
  // unconditional. Set each frame from the tile provider, which `Globe.render`
  // copies the flag onto, through `_applyEnhancedOceanState`, which wipes the
  // renderer-local globe pipeline caches on a flip so the module and pipeline
  // re-resolve.
  public _enhancedOceanEnabled: boolean = false;
  // The scene-pipeline format generation last applied, so a runtime HDR or
  // canvas-format change clears the pipeline, wireframe and debug-fragment
  // caches and rebuilds against the new scene framebuffer color format.
  private _scenePipelineFormatGeneration: number = -1;

  // Per-device imagery slot count (16 full, 4 reduced) and the matching
  // `GLOBE_IMAGERY_REDUCED` shader-define flag. Captured once at `initialize()`
  // from `device.limits.maxSampledTexturesPerShaderStage`; a device's limits
  // are immutable, so this never flips at runtime. It drives the group-1
  // bind-group-layout width (`WebGPUGlobeSurfaceLayouts`), the WGSL variant
  // through the define bit ORed into every pipeline's defines, the bind-group-1
  // entry count, and the CPU multi-pass slicing width in `createTileCommands`.
  // Public underscore: shared with the layouts initializer and the shader,
  // pipeline and wireframe helper modules.
  public _imagerySlotCount: number = MAX_IMAGERY_LAYERS;
  public _imageryReduced: boolean = false;

  // Wireframe pipelines, keyed by the same shape string `selectPipeline` uses
  // so they share variant granularity (Q/U, N/X, M/G, stride). Lazily built on
  // the first wireframe request; the production cache is untouched.
  // Public underscore: shared with the wireframe helpers.
  public _wireframePipelineCache: Map<string, GlobePipelineEntry> = new Map();
  public _wireframeIndexCache: Map<
    string,
    { buffer: GPUBuffer; count: number; format: GPUIndexFormat }
  > = new Map();

  // Per-tile bind-group cache keyed on bound-resource identity. Groups 0, 1 and
  // 2 route through it; group 3, effects, has its own cache in
  // `WebGPUEffectsBindGroup.js`. Stats are readable through
  // `CesiumDebug.globeBindGroups()` and
  // `globalThis.__webgpuGlobeBindGroupCache`.
  private _bindGroupCache: WebGPUGlobeBindGroupCache =
    new WebGPUGlobeBindGroupCache();
  // One dedicated 64-byte eclipse carrier per logical view/frame. Active
  // payloads are ring-allocated once and shared by every tile and pass;
  // inactive frames bind one stable renderer-owned inert buffer.
  private _eclipseUniforms = new WebGPUGlobeEclipseUniforms();

  // Per-tile GPU resource caches
  // Public underscore: shared with the tile-buffer helpers.
  public _tileBufferCache: Map<string, TileGPUResources> = new Map();
  // Public underscore: imagery + water-mask caches are shared with the
  // texture-cache helpers.
  public _imageryTextureCache: Map<string, ImageryGPUTexture> = new Map();
  public _waterMaskTextureCache: Map<string, ImageryGPUTexture> = new Map();
  // Shared imagery realization table, per renderer and therefore per pooled
  // GPUDevice rather than per context: two viewers on one device share this
  // renderer and this table. `_webgpuContext` is the current frame's context,
  // used for frame-owned mip prep and deferred texture retirement. Both are
  // populated each frame from `createTileCommands`, the only site with
  // `frameState.context`, and imagery uploads only occur from that path, so
  // they are set before `uploadImageSource` runs. `_webgpuContext` always
  // tracks the most recent live context; the table never captures one. Rebuilt
  // on a device-generation change so GPU handles never cross devices.
  public _sharedImageryRealizations: WebGPUSharedImageryRealizations | null =
    null;
  public _webgpuContext: ImageryRealizationContext | null = null;
  // frameNumber edge detector, so the realization-table sweep runs once per
  // frame rather than once per tile — `createTileCommands` is a per-tile call.
  private _lastRealizationSweepFrame = -1;
  // Opt-in logical allocation and cache attribution. The performance runner
  // installs this object before Cesium loads, and only in its separately
  // instrumented lane. Clean and production runs leave it null and allocate no
  // diagnostics state.
  public _logicalCounters: WebGPUGlobeLogicalCounters | null = null;

  // Reusable typed arrays for uniform data
  // Public underscore: shared with the camera-UB packer.
  public _cameraUniformData: Float32Array = new Float32Array(
    CAMERA_UNIFORM_FLOATS,
  );
  // Scratch for projection × modifiedModelView (column-major Float64).
  // 2D/CV/Morphing paths in the vertex shader use this matrix instead of
  // mvpRelativeToEye, since their positions are planar (not RTE).
  // Public underscore: shared with the camera-UB packer.
  public _cameraMvpScratch: Float64Array = new Float64Array(16);
  // Public underscore: shared with the tile-UB packer.
  public _tileUniformData: Float32Array = new Float32Array(TILE_UNIFORM_FLOATS);
  // Public underscore: shared with the tile-UB packer.
  public _tileUniformU32View: Uint32Array;

  private _isDestroyed: boolean = false;
  private _isInitialized: boolean = false;
  // Last context this renderer published its per-frame `_globeEffectsHandle`
  // memo onto. Captured so `destroy()` can drop the memo, which otherwise pins
  // a bind group plus the shadow map, clipping state and tile provider for the
  // context's lifetime. Null until the first effects prepare.
  private _effectsMemoContext: GlobeEffectsMemoContext | null = null;

  constructor() {
    this._tileUniformU32View = new Uint32Array(this._tileUniformData.buffer);
    this._logicalCounters =
      (
        globalThis as unknown as {
          __webgpuGlobeLogicalCounters?: WebGPUGlobeLogicalCounters;
        }
      ).__webgpuGlobeLogicalCounters ?? null;
    if (this._logicalCounters) {
      this._logicalCounters.rendererInstancesAttached =
        (this._logicalCounters.rendererInstancesAttached ?? 0) + 1;
    }
  }

  /**
   * Get or create a material-augmented pipeline + the per-frame bind
   * Material UBO + textures land at @group(2) bindings 4-8 alongside
   * water/ocean. Returns `null` when the material doesn't have a
   * usable `wgslShaderSource` (an opt-out path — caller falls back to
   * the non-material pipeline).
   *
   * Cache shape: the per-material-type entry holds the assembled WGSL source,
   * the compiled shader module, the UBO buffer and its layout, and a sub-cache
   * of GPURenderPipelines keyed on the geometry variant. Switching
   * `globe.material` types pays a one-time pipeline build per geometry variant
   * the first time the new material renders.
   * @private
   */
  private _getOrCreateMaterialPipeline(
    material: {
      type: string;
      uniforms: Record<string, unknown>;
      wgslShaderSource: string;
    },
    isQuantized: boolean,
    hasNormals: boolean,
    hasWebMercatorT: boolean,
    isBlend: boolean,
    strideBytes: number,
    hasGeodeticSurfaceNormals: boolean,
    disableCulling: boolean,
  ): { pipeline: GPURenderPipeline; entry: MaterialPipelineCacheEntry } | null {
    if (!material.wgslShaderSource || material.wgslShaderSource.length === 0) {
      return null;
    }
    const device = this._device!;

    // Lazy-build the per-material entry. Shader module + UBO are
    // reused across geometry variants (one of each per material type).
    let entry = this._materialPipelineCache.get(material.type);
    if (!entry) {
      const built = buildMaterialPrelude(material as never);
      if (!built) return null;
      const rewritten = rewriteMaterialBody(
        material.wgslShaderSource,
        built.uboLayout,
        built.textureNames,
      );
      const fullSource = assembleMaterialWGSLSource(
        this._shaderCode,
        built.prelude,
        rewritten,
      );
      // Preprocess with MATERIAL_APPLY set so the `//>>ifdef`-gated material
      // call site and group(4) bindings are included. The reduced-imagery bit
      // must ride along: on a default-limit device the material module would
      // otherwise declare all 16 dayTextures and mismatch the 1-slot group-1
      // layout. Enhanced ocean is a hi-word define; it must be supplied here
      // because the material module replaces both ocean-aware production
      // stages in the descriptor below.
      const preprocessed = preprocessWGSL(
        fullSource,
        ShaderDefine.MATERIAL_APPLY |
          (this._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0),
        this._enhancedOceanEnabled ? ShaderDefineHi.ENHANCED_OCEAN : 0,
      );
      const module = device.createShaderModule({
        label: `Globe material module ${material.type}`,
        code: preprocessed,
      });
      const ubo = device.createBuffer({
        label: `Globe material UBO ${material.type}`,
        size: Math.max(16, built.uboSize),
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      entry = {
        wgslSource: fullSource,
        shaderModule: module,
        uboLayout: built.uboLayout,
        uboSize: built.uboSize,
        textureNames: built.textureNames,
        ubo,
        pipelines: new Map(),
      };
      this._materialPipelineCache.set(material.type, entry);
    }

    // Geometry and render-target variant key — the same grammar as the base
    // pipeline cache key,
    // minus the debug-fragment and translucent-back-face axes, whose variants
    // do not route through the material path, and minus clip-distances, which
    // the material path never requests. Built through the shared key module
    // rather than inline: a private copy of the format is how a reader ends up
    // parsing a key shape the producer has abandoned.
    const defines = hasGeodeticSurfaceNormals
      ? ShaderDefine.GEODETIC_NORMAL
      : 0;
    const geomKey = buildGlobePipelineCacheKey({
      kind: "color",
      isQuantized,
      hasNormals,
      hasWebMercatorT,
      isBlend,
      strideBytes,
      useClipDistances: false,
      disableCulling,
      defines,
      targetFormat: this._canvasFormat,
      sampleCount: this._sampleCount,
    });

    let pipeline = entry.pipelines.get(geomKey);
    if (!pipeline) {
      // Build the base descriptor (vertex layout, depth/stencil,
      // primitive, multisample, fragment targets) using the same
      // factory the non-material path uses, then override the module
      // refs + layout for material support.
      const descriptor = buildPipelineDescriptor(
        this,
        isQuantized,
        hasNormals,
        hasWebMercatorT,
        isBlend,
        strideBytes,
        DebugFragmentMode.NONE,
        false, // useClipDistances — skipped in material path for MVP
        hasGeodeticSurfaceNormals,
        disableCulling,
      );
      descriptor.vertex.module = entry.shaderModule;
      if (descriptor.fragment) {
        descriptor.fragment.module = entry.shaderModule;
      }
      // Material path reuses the regular pipeline layout — material
      // slots live in Group 2 alongside water-mask / ocean-normal so
      // the total bind-group count stays at the WebGPU spec floor of 4.
      descriptor.layout = this._pipelineLayout!;
      const gpuDesc = descriptorToGPU(descriptor);
      pipeline = device.createRenderPipeline(gpuDesc);
      entry.pipelines.set(geomKey, pipeline);
    }

    // Pack the material's uniform values into the UBO + upload. The
    // group 2 bind group (water/ocean/material) is built by the regular
    // per-tile bind-group construction site; the entry returned here
    // supplies `ubo` and `textureNames` for that site to consume.
    const uboData = packMaterialUBO(
      material as never,
      entry.uboLayout,
      entry.uboSize,
    );
    device.queue.writeBuffer(entry.ubo, 0, uboData);

    return { pipeline, entry };
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

    // Resolve the per-device imagery slot count before the shader cache, whose
    // prewarm needs the define bit, and before the bind-group layouts, which
    // need the group-1 width.
    this._imagerySlotCount = computeGlobeImagerySlotCount(device.limits);
    this._imageryReduced = this._imagerySlotCount < MAX_IMAGERY_LAYERS;
    if (this._imageryReduced) {
      // Permanent rather than debug-pragma'd: a degraded layout on a real user
      // device is something a bug report needs to show.
      // lint-debug-pragmas-allow: this device-layout degradation must remain visible
      console.warn(
        `[CesiumJS:WebGPU] Globe imagery layout reduced to ` +
          `${this._imagerySlotCount} slot(s)/pass: device ` +
          `maxSampledTexturesPerShaderStage=` +
          `${device.limits?.maxSampledTexturesPerShaderStage} < 28 ` +
          `(full globe layout). Multi-layer tiles will multi-pass.`,
      );
    }

    this._initShaderCache(shaderCode);
    this._eclipseUniforms.initialize(device);
    createBindGroupLayoutsHelper(this);
    createPipelineLayoutHelper(this);
    createSamplersHelper(this);
    createPlaceholderTextureHelper(this);
    // Pipelines are created lazily in _selectPipeline based on actual tile stride
    this._isInitialized = true;

    // Publish the bind-group cache for `CesiumDebug.globeBindGroups()` and the
    // regression probe. The last-initialized renderer wins, matching the
    // `__webgpuGlobeFragmentDebugRegistry` convention; split-screen debug then
    // reads the most recent device's cache, which is the common case.
    (
      globalThis as { __webgpuGlobeBindGroupCache?: WebGPUGlobeBindGroupCache }
    ).__webgpuGlobeBindGroupCache = this._bindGroupCache;
    // Publish the resolved slot count for `probe-globe-default-limits.mjs` and
    // CesiumDebug introspection, under the same last-initialized-wins
    // convention.
    (
      globalThis as { __webgpuGlobeImagerySlotCount?: number }
    ).__webgpuGlobeImagerySlotCount = this._imagerySlotCount;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  // Shader-module cache accessors. The bodies live in
  // `WebGPUGlobeSurfaceShaders.ts`; these one-line delegators stay on the class
  // for call-site stability.

  private _initShaderCache(code: string): void {
    initShaderCacheHelper(this, code);
  }

  private _getProductionShaderModule(defines: number): GPUShaderModule {
    return getProductionShaderModuleHelper(this, defines);
  }

  private _getDebugFragmentShaderModule(
    defines: number,
  ): GPUShaderModule | null {
    return getDebugFragmentShaderModuleHelper(this, defines);
  }

  private _getClipDistancesShaderModule(
    defines: number,
  ): GPUShaderModule | null {
    return getClipDistancesShaderModuleHelper(this, defines);
  }

  /**
   * Apply the current `Globe.enableEnhancedOcean` state, mirrored onto the tile
   * provider each frame, to the renderer. On a flip, the enhanced ocean styling
   * branch of `computeEnhancedOcean` swaps in or out through the
   * `ShaderDefineHi.ENHANCED_OCEAN` hi-word define. The shader-module cache
   * keys by `definesHi` and serves the correct module on its own, but the
   * renderer-local pipeline caches key without the hi word — only the central
   * cache keys on the descriptor name, which carries an `enhOcean` label — and
   * the clip-distances module map keys by the lo defines only. A flip must
   * therefore wipe those to force a keyed-miss rebuild that re-resolves the
   * module and pipeline without a reload. Idempotent: returns immediately when
   * the state is unchanged, which is the common per-frame case, so the wipe
   * fires only on the rare toggle.
   *
   * Called from both `createTileCommands` (on-screen) and
   * `getOrCreateCaptureTileCommands` (env-map capture). Whichever runs first in
   * a frame wipes all globe pipeline caches, so the ordering between the two —
   * capture runs before `globe.render` — never leaves a stale cache behind.
   */
  private _applyEnhancedOceanState(enabled: boolean): void {
    if (this._enhancedOceanEnabled === enabled) {
      return;
    }
    this._enhancedOceanEnabled = enabled;
    this._pipelineCache.clear();
    this._wireframePipelineCache.clear();
    this._debugFragmentPipelineCache.clear();
    this._capturePipelineCache.clear();
    this._materialPipelineCache.clear();
    // The clip-distances module map keys by the lo defines only; wipe it so the
    // next lookup rebuilds its base against the new `definesHi`.
    this._clipDistancesShaderModules.clear();
  }

  // Bind-group layouts, pipeline layout, samplers and the placeholder texture
  // are built by `WebGPUGlobeSurfaceLayouts.ts`. Each helper is invoked once
  // from `initialize()`, so no class-level wrappers exist for them.
  //
  // `buildPipelineDescriptor`, `descriptorToGPU`, `resolveGlobePipelineEntry`,
  // `selectPipeline` and `selectDebugFragmentPipeline` live in
  // `WebGPUGlobeSurfacePipelines.ts`. Callers in this file invoke those helpers
  // directly with `this` as the host.

  /**
   * Resolve and pack the terrain-global group-3 effects bind group once per
   * (context, frame/view).
   *
   * The shadow-receive, CSM, atmosphere-LUT and clipping-planes/polygons state
   * is identical for every selected tile and every imagery pass in a frame, so
   * the body below runs at most once; subsequent tiles and passes take the memo
   * fast path — a few reference and scalar compares — and reuse the prepared
   * `GPUBindGroup`.
   *
   * The memo is stored on the context, not on this per-GPUDevice renderer
   * instance: pooled devices are shared across contexts, so a memo keyed by
   * frameNumber on a device-shared renderer would alias Scene A's camera bytes
   * into Scene B. Any input mismatch falls through to a fresh prepare.
   */
  private _getOrCreateFrameEffectsBindGroup(
    device: GPUDevice,
    frameState: CesiumFrameState,
    tileProvider: CesiumGlobeTileProvider,
    uniformState: CesiumUniformState,
  ): GPUBindGroup {
    // When the scene has an atmosphere LUT ready — compute is supported and
    // SkyAtmosphere has dispatched the LUT compute pass at least once — the
    // active bind group builder passes the LUT views into bindings 7 and 8 of
    // the effects bind-group layout. The globe shader reads those to compute a
    // fog color that matches the visible sky dome. With neither clipping nor a
    // LUT present, the placeholder fast path still applies.
    const perfMgr = (
      frameState as {
        context?: {
          performanceManager?: {
            ensureAtmosphereLUTResources?: (d: GPUDevice) => {
              transmittanceView?: GPUTextureView;
              inscatterView?: GPUTextureView;
            } | null;
          };
        };
      }
    ).context?.performanceManager;
    let atmosphereLutViews: {
      transmittance: GPUTextureView;
      inscatter: GPUTextureView;
    } | null = null;
    if (perfMgr?.ensureAtmosphereLUTResources) {
      // Read the existing LUT views without consulting
      // `shouldRecomputeAtmosphereLUT()`: that method is side-effecting — it
      // clears the dirty flag on read — and the flag belongs to SkyAtmosphere's
      // dispatch lifecycle, so consuming it here would stop SkyAtmosphere
      // seeing "needs recompute" on its next frame.
      //
      // Binding whatever the texture currently contains instead lets the
      // shader's `lutLuminance > 0.001` check in `sampleAtmosphereFogLut`
      // decide whether the data is meaningful. Before SkyAtmosphere has
      // dispatched, on the first frame, the textures are all zero and the
      // shader takes the inline Rayleigh/Mie fallback, so there is no flash or
      // pop.
      const res = perfMgr.ensureAtmosphereLUTResources(device);
      if (res && res.transmittanceView && res.inscatterView) {
        atmosphereLutViews = {
          transmittance: res.transmittanceView,
          inscatter: res.inscatterView,
        };
      }
    }
    // Resolve the scene's receive shadow map so the globe gets
    // shadow-darkening when `viewer.shadows = true`. WebGL routes through
    // Scene.js per-command receive logic; on WebGPU the globe manages its own
    // bind groups, so the same lookup is inlined here. `lightShadowMaps[0]` is
    // the canonical receive source — cascades, spot and directional all land
    // there after update. Gated on `lightShadowsEnabled` to match Scene.js.
    const shadowState = frameState?.shadowState;
    const receivesShadows =
      shadowModeRuntime.receiveShadows(tileProvider.shadows) &&
      frameState.globeTranslucencyState?.translucent !== true;
    // An out-of-view map — the below-horizon cull in
    // `ShadowMap.checkVisibility` — is not cast into this frame, so sampling it
    // would darken the night side from a stale, day-lit depth target. WebGL
    // skips the receive derivation for the same reason, in
    // `Scene/SceneRenderer.js` `executeShadowMapCastCommands` and the
    // per-command receive swap, and the WebGPU cast dispatch already skips on
    // it.
    const candidateShadowMap = shadowState?.lightShadowMaps?.[0];
    const receiveShadowMap =
      receivesShadows &&
      shadowState?.lightShadowsEnabled &&
      candidateShadowMap &&
      candidateShadowMap.outOfView !== true
        ? candidateShadowMap
        : undefined;

    // Resolve the context's cascaded shadow map renderer when the scene has
    // asked for cascades and the renderer has initialized a cascade texture
    // array. The params UBO and array view go into the effects bind group so
    // the shader's shadow branch can route through `sampleCascadeShadow`
    // (bindings 10 and 11) instead of the single-map path (bindings 1 and 2).
    //
    // The ambient `csmRenderer: object | null` on the context is deliberately
    // opaque — `cesium-js-types.d.ts` keeps this file free of WebGPU-renderer
    // imports — so it is narrowed here to the shape this site consumes.
    type CSMRendererView = {
      enabled?: boolean;
      cascadeParamsBuffer?: GPUBuffer | null;
      cascadeArrayView?: GPUTextureView | null;
      pcfRadius?: number;
    };
    const csmCandidate = frameState.context?.csmRenderer as
      CSMRendererView | null | undefined;
    const csmBinding =
      receivesShadows &&
      frameState.useCascadedShadowMaps === true &&
      csmCandidate &&
      csmCandidate.enabled === true &&
      csmCandidate.cascadeParamsBuffer &&
      csmCandidate.cascadeArrayView
        ? {
            enabled: true,
            paramsBuffer: csmCandidate.cascadeParamsBuffer,
            cascadeArrayView: csmCandidate.cascadeArrayView,
            // Soft-shadow kernel radius, in texels.
            pcfRadius: csmCandidate.pcfRadius,
          }
        : undefined;

    // `globe.clippingPolygons`, gated exactly as the model renderer gates it:
    // only an enabled, non-empty collection activates the polygon SDF path
    // through `effects.clippingPolygonCount`.
    const tpClippingPolygons = tileProvider?.clippingPolygons;
    const activeClippingPolygons =
      tpClippingPolygons &&
      tpClippingPolygons.enabled &&
      tpClippingPolygons.length > 0
        ? tpClippingPolygons
        : undefined;

    const clippingPlanes = tileProvider?.clippingPlanes;
    const clippingPlanesLength = clippingPlanes?.length ?? 0;
    const clippingPolygonsLength = activeClippingPolygons?.length ?? 0;
    const cameraPosition = uniformState.cameraPosition;
    const cameraX = cameraPosition?.x ?? 0;
    const cameraY = cameraPosition?.y ?? 0;
    const cameraZ = cameraPosition?.z ?? 0;

    // Reuse the prepared handle only when every input that determines the
    // packed bytes or the placeholder decision is unchanged. Ordered
    // cheapest-first: frameNumber, which changes every tick, then device, then
    // references, then camera values. `frameNumber` is read raw and a missing
    // value disables memoization, because a `?? 0` fallback would alias
    // distinct frames. The memo is context-scoped so a pooled device shared
    // across Scenes cannot cross-serve.
    const memoCtx = frameState.context as unknown as
      GlobeEffectsMemoContext | undefined;
    const frameNumber = frameState.frameNumber;
    const logicalCounters = this._logicalCounters;
    if (memoCtx && typeof frameNumber === "number") {
      const memo = memoCtx._globeEffectsHandle;
      if (
        memo &&
        memo.frameNumber === frameNumber &&
        memo.device === device &&
        memo.receiveShadowMap === receiveShadowMap &&
        memo.csmParamsBuffer === csmBinding?.paramsBuffer &&
        memo.csmArrayView === csmBinding?.cascadeArrayView &&
        memo.csmPcfRadius === csmBinding?.pcfRadius &&
        memo.lutTransmittance === atmosphereLutViews?.transmittance &&
        memo.lutInscatter === atmosphereLutViews?.inscatter &&
        memo.clippingPlanes === clippingPlanes &&
        memo.clippingPlanesLength === clippingPlanesLength &&
        memo.clippingPolygons === activeClippingPolygons &&
        memo.clippingPolygonsLength === clippingPolygonsLength &&
        memo.tileProvider === tileProvider &&
        memo.cameraX === cameraX &&
        memo.cameraY === cameraY &&
        memo.cameraZ === cameraZ
      ) {
        if (logicalCounters) {
          logicalCounters.effectsHandleReuses =
            (logicalCounters.effectsHandleReuses ?? 0) + 1;
        }
        return memo.bindGroup;
      }
    }

    // The active-versus-placeholder gate: any active effect routes through the
    // real bind group builder; otherwise the per-device placeholder is returned
    // with a zero-filled effects UBO. `useClipDistances` from the per-pass loop
    // is deliberately not a term here — it requires `clippingPlanes.length > 0`,
    // so it can never widen this condition beyond the
    // `clippingPlanesLength > 0` term.
    let bindGroup3: GPUBindGroup;
    if (
      clippingPlanesLength > 0 ||
      activeClippingPolygons !== undefined ||
      atmosphereLutViews !== null ||
      receiveShadowMap !== undefined ||
      csmBinding !== undefined
    ) {
      const fxRes = createEffectsBindGroup(device, frameState, {
        consumer: "globe",
        // Stable per-Scene/view owner. Camera movement updates one bounded
        // effects slot shared by every terrain tile in this frame.
        owner: frameState,
        clippingPlanes: clippingPlanes,
        clippingPolygons: activeClippingPolygons,
        shadowMap: receiveShadowMap,
        csm: csmBinding,
        // Globe terrain model matrix is identity, so the camera in
        // plane-space is the same as the world camera position.
        cameraInPlaneSpace: cameraPosition,
        atmosphereLutTransmittanceView: atmosphereLutViews?.transmittance,
        atmosphereLutInscatterView: atmosphereLutViews?.inscatter,
        // The SkyAtmosphere convention: WGS84 plus 2.5% atmosphere thickness,
        // which is what the LUT compute dispatcher defaults to unless
        // `SkyAtmosphere.atmosphereLightIntensity` has been customized. The
        // shader clamps altitudes, so scene-specific radii are not plumbed
        // through.
        atmosphereLutPlanetRadii: {
          inner: 6378137.0,
          outer: 6378137.0 * 1.025,
        },
      });
      bindGroup3 = fxRes.bindGroup;
    } else {
      // On a toggle-off transition, storing the placeholder rather than leaving
      // the stale active handle means the next tile after shadows, CSM or the
      // LUT turn off binds zero-filled effects data instead of last frame's
      // control bytes. Same constraint as
      // `WebGPUPrimitiveCommands._getOrCreateSharedPrimitiveEffectsBG`.
      bindGroup3 = this._placeholderEffectsBG!;
    }

    // Publish the prepared handle + its exact input snapshot for tiles 2..N.
    if (memoCtx && typeof frameNumber === "number") {
      // Remember which context owns the memo so destroy() can release it.
      this._effectsMemoContext = memoCtx;
      memoCtx._globeEffectsHandle = {
        frameNumber,
        device,
        bindGroup: bindGroup3,
        receiveShadowMap,
        csmParamsBuffer: csmBinding?.paramsBuffer,
        csmArrayView: csmBinding?.cascadeArrayView,
        csmPcfRadius: csmBinding?.pcfRadius,
        lutTransmittance: atmosphereLutViews?.transmittance,
        lutInscatter: atmosphereLutViews?.inscatter,
        clippingPlanes,
        clippingPlanesLength,
        clippingPolygons: activeClippingPolygons,
        clippingPolygonsLength,
        tileProvider,
        cameraX,
        cameraY,
        cameraZ,
      };
    }
    if (logicalCounters) {
      logicalCounters.effectsHandlePrepares =
        (logicalCounters.effectsHandlePrepares ?? 0) + 1;
    }
    return bindGroup3;
  }

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
    const logicalCounters = this._logicalCounters;
    if (logicalCounters) {
      logicalCounters.tileCalls = (logicalCounters.tileCalls ?? 0) + 1;
    }

    // Eagerly touch the uniform ring buffer allocator on first use. The
    // context's lazy getter only constructs the allocator on first access, and
    // `context.beginFrame()` only calls `beginFrame()` on the allocator when it
    // already exists. Without this touch the allocator never initializes and
    // every frame leaks its uniform buffers.
    void frameState.context?.uniformAllocator;

    // Plumb the shared imagery realization table and the current frame's
    // context for uploads. The table stores no context closure: destruction
    // routes through a scheduleDestroy callback supplied at each call from the
    // live `realizationContext`, so a viewer teardown never pins a dead
    // context's destroy queue while the pooled device stays live for another
    // viewer.
    const realizationContext = frameState.context as unknown as
      ImageryRealizationContext | undefined;
    if (
      realizationContext &&
      typeof realizationContext.enqueueTextureMipGeneration === "function"
    ) {
      this._webgpuContext = realizationContext;
      const device = this._device;
      if (device) {
        const table = this._sharedImageryRealizations;
        if (table === null || table.device !== device) {
          // The `table.device !== device` arm is defensive only: this renderer
          // is constructed per pooled GPUDevice and `_device` is written once
          // at initialize, so with the current outer plumbing the mismatch
          // cannot occur. It is cheap, and it makes a change to the renderer
          // pooling fail safe by rebuilding instead of serving stale-device
          // textures.
          if (table !== null) {
            table.destroyAll((t) =>
              realizationContext.scheduleTextureDestroy(t),
            );
          }
          this._sharedImageryRealizations = new WebGPUSharedImageryRealizations(
            device,
          );
        }
        // Sweep once per frame rather than once per tile: `createTileCommands`
        // is a per-tile call site, so the scene's frameNumber gates it. The
        // number is used only as an edge detector — the table keeps its own
        // internal clock — so two scenes sharing this renderer each tick the
        // sweep clock once per their own frame, ageing faster in wall-clock
        // terms, which is the safe direction, and with no cross-scene stamp
        // mixing.
        const activeTable = this._sharedImageryRealizations;
        if (activeTable) {
          const frameNumber =
            (frameState as unknown as { frameNumber?: number }).frameNumber ??
            0;
          if (this._lastRealizationSweepFrame !== frameNumber) {
            this._lastRealizationSweepFrame = frameNumber;
            const retired = activeTable.sweep((t) =>
              realizationContext.scheduleTextureDestroy(t),
            );
            if (retired > 0 && this._logicalCounters) {
              this._logicalCounters.imageryRealizationRetirements =
                (this._logicalCounters.imageryRealizationRetirements ?? 0) +
                retired;
            }
          }
        }
      }
    }

    // Capture the sun-view Beer shadow map view and sampler from the procedural
    // cloud renderer's cache for the group-2 bind group. The cloud renderer
    // runs after the globe terrain pass, so this reads last frame's map — one
    // frame late, which a slow, soft cloud shadow tolerates. When the feature
    // is off, the default, the cache has no real shadow view, so null here
    // makes the bind group fall back to the renderer's 1×1 placeholder:
    // transmittance 1, no shadow.
    const cloudCacheForShadow = (
      frameState.context as unknown as {
        _cloudCache?: {
          shadowActive?: boolean;
          shadowView?: GPUTextureView | null;
          shadowSampler?: GPUSampler | null;
          shadowCascadeActive?: boolean;
          shadowCascadeView?: GPUTextureView | null;
        };
      }
    )?._cloudCache;
    if (
      cloudCacheForShadow?.shadowCascadeActive === true &&
      cloudCacheForShadow.shadowCascadeView
    ) {
      // The opt-in cascade tier binds the three-cascade atlas at binding 9 —
      // the same texture_2d type; the fragment shader reads it through the
      // cascade branch gated on `cloudShadowControl.w`. Aerial and fog
      // consumers keep reading the single map, which is still rendered
      // alongside the atlas.
      this._cloudShadowView = cloudCacheForShadow.shadowCascadeView;
      this._cloudShadowSampler =
        cloudCacheForShadow.shadowSampler ?? this._sampler;
    } else if (
      cloudCacheForShadow?.shadowActive === true &&
      cloudCacheForShadow.shadowView
    ) {
      this._cloudShadowView = cloudCacheForShadow.shadowView;
      this._cloudShadowSampler =
        cloudCacheForShadow.shadowSampler ?? this._sampler;
    } else {
      this._cloudShadowView = null;
      this._cloudShadowSampler = null;
    }

    // Capture the central pipeline cache from the context. The select methods
    // consult `this._centralPipelineCache` to dedupe pipelines across renderer
    // instances. It is captured here rather than in `initialize()` because
    // `initialize()` only receives `device`, not `context`.
    if (!this._centralPipelineCache) {
      this._centralPipelineCache =
        (
          frameState.context as unknown as {
            webgpuPipelineCache?: WebGPURenderPipelineCache | null;
          }
        ).webgpuPipelineCache ?? null;
    }

    // Invalidate cached pipelines when the scene-pipeline format generation has
    // changed, on an HDR or MSAA toggle. Globe terrain pipelines target the
    // scene framebuffer, so they must rebuild against the new color format.
    // Clears the production, wireframe, debug-fragment and material caches.
    const ctxGen =
      (
        frameState.context as unknown as {
          _scenePipelineFormatGeneration?: number;
          scenePipelineFormat?: GPUTextureFormat;
        }
      )._scenePipelineFormatGeneration ?? 0;
    if (this._scenePipelineFormatGeneration !== ctxGen) {
      this._scenePipelineFormatGeneration = ctxGen;
      const newFormat =
        (
          frameState.context as unknown as {
            scenePipelineFormat?: GPUTextureFormat;
          }
        ).scenePipelineFormat ?? this._canvasFormat;
      this._canvasFormat = newFormat;
      // Mirror the context's pick format authority alongside the scene format.
      // The cache wipe below drops any pick pipeline built against the previous
      // format.
      this._pickFormat =
        (
          frameState.context as unknown as {
            pickPipelineFormat?: GPUTextureFormat;
          }
        ).pickPipelineFormat ?? "rgba8unorm";
      // Capture the MSAA sample count alongside the canvas format. The cache
      // wipe below drops pipelines created before the change; new lookups pick
      // up `_sampleCount` through `buildPipelineDescriptor → host._sampleCount`.
      this._sampleCount =
        (frameState.context as unknown as { _msaaSamples?: number })
          ._msaaSamples ?? 1;
      this._pipelineCache.clear();
      this._wireframePipelineCache.clear();
      this._debugFragmentPipelineCache.clear();
      this._materialPipelineCache.clear();
    }

    // Resolve the log-depth state from the shared gate every frame,
    // independently of the `ctxGen` guard above, so the globe's encoding tracks
    // `frameState.useLogDepth` exactly like the model, primitive and collection
    // producers that share the depth attachment. No cache wipe is needed on a
    // flip: the renderer-local key ends in `|${defines.toString(16)}`, which
    // carries the LOG_DEPTH bit, and the central key carries the `, ld=1`
    // descriptor-name marker, so both caches rebuild through a normal keyed
    // miss.
    this._logDepthEnabled = isWebGPULogDepthActive(
      frameState.context,
      frameState,
    );
    // The separate pick-fleet gate, from which `selectPickPipeline` compiles
    // its LOG_DEPTH module. Its pick cache key includes the define, so a flip
    // rebuilds through a keyed miss.
    this._pickLogDepthEnabled = isWebGPUPickLogDepthActive(
      frameState.context,
      frameState,
    );

    // Mirror `Globe.enableEnhancedOcean`, which `Globe.render` copies onto the
    // tile provider each frame, so the globe shader factory picks the enhanced
    // or the classic ocean styling module. The default, false, is classic
    // WebGL-parity water. A flip wipes the globe pipeline caches — see
    // `_applyEnhancedOceanState` — so it takes effect without a reload.
    this._applyEnhancedOceanState(tileProvider.enableEnhancedOcean ?? false);

    const device = this._device;
    const mesh = surfaceTile.renderedMesh || surfaceTile.mesh;
    if (!mesh) return null;

    // Per-frame tick, a no-op when called again for subsequent tiles in the
    // same frame. Rolls the per-frame stat counters and runs the periodic age
    // eviction.
    this._bindGroupCache.beginFrame(frameState.frameNumber ?? 0);

    const tileKey = getTileKeyHelper(tile);
    const gpuResources = getOrCreateTileBuffersHelper(this, tileKey, mesh);
    if (!gpuResources) return null;

    // Count total ready imagery layers
    const imageryCollection = surfaceTile.imagery;
    const readyLayers: CesiumTileImagery[] = [];
    if (logicalCounters) {
      logicalCounters.readyLayerArrays =
        (logicalCounters.readyLayerArrays ?? 0) + 1;
    }
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

    // Determine the number of passes needed. Pass width is the per-device
    // imagery slot count — 16 on full-layout adapters, 1 on default-limit
    // adapters — so reduced devices render N layers as N blend passes.
    const imagerySlots = this._imagerySlotCount;
    const totalLayers = readyLayers.length;
    const passCount = Math.max(1, Math.ceil(totalLayers / imagerySlots));
    const commands: TileDrawDescriptor[] = [];
    // Passes this tile wanted and could not build, because the pipeline the
    // pass needs is still materializing. Published to
    // `frameState.commandsDeferred` at the bottom of this method, but only
    // when at least one pass did build: a tile that produced nothing at all
    // returns null, and the scene-layer caller counts that whole tile once, so
    // publishing here as well would double-count it.
    let deferredPasses = 0;
    if (logicalCounters) {
      logicalCounters.readyLayers =
        (logicalCounters.readyLayers ?? 0) + totalLayers;
      logicalCounters.commandArrays = (logicalCounters.commandArrays ?? 0) + 1;
    }

    // Imagery probe diagnostic, off by default — opt in with
    // `scene.debugShowImageryProbe = true` when investigating an imagery render
    // bug. Logs the first 4 tiles after the flag is set, then quiets so the
    // console does not drown. Toggling the flag from false to true resets the
    // latch so a second sample can be captured.
    const probeOn = frameState.debugShowImageryProbe === true;
    if (probeOn && !this._lastProbeFlag) {
      // Rising edge — reset the latch so the next 4 tiles dump again.
      this._diagTileCount = 0;
    }
    this._lastProbeFlag = probeOn;
    if (probeOn) {
      this._diagTileCount++;
    }
    //>>includeStart('debug', pragmas.debug);
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
    //>>includeEnd('debug');

    // Hot-path discipline: read all per-frame debug flags once, outside the
    // per-pass loop. The four fragment debug modes are mutually exclusive, only
    // one fragment overlay showing at a time, so collapsing them into a single
    // integer mode makes the per-pass branch one comparison against NONE rather
    // than a chain of if-elses.
    //
    // Wireframe is not a fragment mode — it is a topology plus index-buffer
    // swap — so it stays its own boolean and wins over the fragment modes,
    // being the more structural diagnostic.
    const debugWireframe = frameState.debugShowGlobeWireframe === true;
    let debugFragmentMode: DebugFragmentMode = DebugFragmentMode.NONE;
    if (frameState.debugShowTriangulation === true) {
      debugFragmentMode = DebugFragmentMode.TRIANGULATION;
    } else if (frameState.debugShowTerrainLOD === true) {
      debugFragmentMode = DebugFragmentMode.LOD;
    } else if (frameState.debugShowTerrainNormals === true) {
      debugFragmentMode = DebugFragmentMode.NORMAL;
    }

    // Derive cull on/off from the same gates WebGL uses in
    // `GlobeSurfaceTileProviderRendering.js:1224-1225`:
    //   backFaceCulling = tileProvider.backFaceCulling
    //                  && !cameraUnderground
    //                  && !globeTranslucencyState.translucent
    // Inverted here: disable culling when underground, or translucent, or the
    // provider has back-face culling explicitly off. The result feeds
    // `selectPipeline`'s `disableCulling` flag.
    const cameraUnderground =
      (frameState as unknown as { cameraUnderground?: boolean })
        .cameraUnderground === true;
    const globeTranslucent =
      (
        frameState as unknown as {
          globeTranslucencyState?: { translucent?: boolean };
        }
      ).globeTranslucencyState?.translucent === true;
    const providerCullEnabled =
      (tileProvider as unknown as { backFaceCulling?: boolean })
        .backFaceCulling !== false;
    // The disable-culling decision is split. Underground, and a provider with
    // culling disabled, want cullMode: "none" — single-pass, both faces. A
    // translucent globe instead wants the three-pass technique:
    //   1. Depth-only back-face (cullMode: "front")
    //   2. Translucent back-face (cullMode: "front", blend ALPHA)
    //   3. Translucent front-face (cullMode: "back" through
    //      `disableCulling: false`, rather than cullMode: "none")
    // Camera-underground takes precedence over translucent: when both are true,
    // single-pass both-faces wins, because the primary intent is to see through
    // the globe.
    const disableCulling = !providerCullEnabled || cameraUnderground;

    // Terrain-global for this logical view/frame. `prepare` returns a memoized
    // active ring slice, or the stable inert slice without allocating or
    // uploading on ordinary frames. Every tile and imagery pass binds this same
    // carrier; only the camera and tile UBs remain per-pass.
    const eclipseUB = this._eclipseUniforms.prepare(device, frameState);

    for (let pass = 0; pass < passCount; pass++) {
      const isSubsequentPass = pass > 0;
      const layerStart = pass * imagerySlots;
      const layerEnd = Math.min(layerStart + imagerySlots, totalLayers);
      const passLayers = readyLayers.slice(layerStart, layerEnd);
      if (logicalCounters) {
        logicalCounters.passLayerSlices =
          (logicalCounters.passLayerSlices ?? 0) + 1;
      }

      // Pick the hardware clip-distances variant only when all of the
      // following hold. Each condition is a correctness gate; the
      // fragment-discard path handles every other case.
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
      //      additionally supports intersection mode, clipping only when
      //      every plane clips, so routing intersection-mode collections to
      //      the hardware variant would over-clip.
      const ctx = frameState?.context;
      const cp = tileProvider?.clippingPlanes;
      const isScene3D = (frameState?.mode ?? 3) >= 2.5; // SceneMode.SCENE3D = 3
      const useClipDistances =
        !!(ctx && ctx.useHardwareClipDistances) &&
        !!(cp && cp.length > 0) &&
        isScene3D &&
        !!cp.unionClippingRegions;

      // A null from the `select*` helpers means the pipeline is still
      // materializing in the central cache, and the loop `continue`s to skip
      // this pass for this tile this frame. The same defines × stride × format
      // tuple resolves once and stays cached for the lifetime of the device, so
      // the skip only ever fires on the first frame a new variant appears.
      let pipeline: GPURenderPipeline | null;
      // Wireframe is a structural overlay — only the first pass renders it,
      // subsequent passes are the multi-imagery overdraw which would just
      // double-rasterize the same edges.
      if (debugWireframe && !isSubsequentPass) {
        pipeline = selectWireframePipelineHelper(
          this,
          gpuResources.isQuantized,
          gpuResources.hasNormals,
          gpuResources.hasWebMercatorT,
          gpuResources.strideBytes,
          gpuResources.hasGeodeticSurfaceNormals,
        );
      } else if (debugFragmentMode !== DebugFragmentMode.NONE) {
        // Cold path: try the debug fragment variant, falling back to the
        // production pipeline when the device cannot compile the augmented
        // module — a driver missing primitive_index, for instance. The debug
        // fragment and clip-distances combination is deliberately unsupported,
        // since the debug variants do not share the augmented VertexOutput, so
        // it also falls through to the production module.
        pipeline =
          selectDebugFragmentPipelineHelper(
            this,
            debugFragmentMode,
            gpuResources.isQuantized,
            gpuResources.hasNormals,
            gpuResources.hasWebMercatorT,
            isSubsequentPass,
            gpuResources.strideBytes,
            gpuResources.hasGeodeticSurfaceNormals,
          ) ??
          selectPipelineHelper(
            this,
            gpuResources.isQuantized,
            gpuResources.hasNormals,
            gpuResources.hasWebMercatorT,
            isSubsequentPass,
            gpuResources.strideBytes,
            false,
            gpuResources.hasGeodeticSurfaceNormals,
            disableCulling,
          );
      } else {
        // When the globe is translucent, the front-face color command takes the
        // ALPHA-blend pipeline variant — blend src-alpha/one-minus-src-alpha,
        // depth-write off — matching WebGL's
        // `getTranslucentFrontFaceRenderState` (BlendingState.ALPHA_BLEND with
        // depthMask false). Selecting the blend variant only for subsequent
        // imagery passes would leave the first-pass translucent front face
        // opaque, with the pipeline discarding the per-fragment alpha the
        // fragment shader produced, so an enabled translucent globe would still
        // composite fully opaque. The depth-only back-face pre-pass writes the
        // far-side depth, so the blend pass has correct occlusion.
        pipeline = selectPipelineHelper(
          this,
          gpuResources.isQuantized,
          gpuResources.hasNormals,
          gpuResources.hasWebMercatorT,
          isSubsequentPass || globeTranslucent,
          gpuResources.strideBytes,
          useClipDistances,
          gpuResources.hasGeodeticSurfaceNormals,
          disableCulling,
        );
      }
      if (!pipeline) {
        deferredPasses++;
        continue;
      }

      // Material pipeline override. When `globe.material` is set — mirrored
      // onto `tileProvider.material` by `Globe.update` — build and cache a
      // material-augmented pipeline. The material UBO and textures bind through
      // group 2 alongside the water mask and ocean normal, which keeps the
      // total bind-group count at the WebGPU spec floor of 4.
      let materialEntry: MaterialPipelineCacheEntry | null = null;
      const tpMaterial = (
        tileProvider as unknown as {
          material?: {
            type: string;
            uniforms: Record<string, unknown>;
            wgslShaderSource: string;
          };
        }
      ).material;
      if (
        !isSubsequentPass &&
        !debugWireframe &&
        debugFragmentMode === DebugFragmentMode.NONE &&
        tpMaterial &&
        tpMaterial.wgslShaderSource &&
        tpMaterial.wgslShaderSource.length > 0
      ) {
        const matResult = this._getOrCreateMaterialPipeline(
          tpMaterial,
          gpuResources.isQuantized,
          gpuResources.hasNormals,
          gpuResources.hasWebMercatorT,
          isSubsequentPass,
          gpuResources.strideBytes,
          gpuResources.hasGeodeticSurfaceNormals,
          disableCulling,
        );
        if (matResult) {
          pipeline = matResult.pipeline;
          materialEntry = matResult.entry;
        }
      }

      const cameraUB = createCameraUniformBufferHelper(
        this,
        device,
        uniformState,
        surfaceTile,
        tileProvider,
        mesh,
        frameState,
        tile,
      );
      const tileUB = createTileUniformBufferHelper(
        this,
        device,
        surfaceTile,
        tileProvider,
        frameState,
        tile,
        passLayers,
        isSubsequentPass,
      );
      if (logicalCounters) {
        logicalCounters.cameraUniformPacks =
          (logicalCounters.cameraUniformPacks ?? 0) + 1;
        logicalCounters.cameraUniformLogicalBytes =
          (logicalCounters.cameraUniformLogicalBytes ?? 0) + cameraUB.size;
        logicalCounters.cameraUniformAlignedBytes =
          (logicalCounters.cameraUniformAlignedBytes ?? 0) +
          Math.ceil(cameraUB.size / 256) * 256;
        logicalCounters.tileUniformPacks =
          (logicalCounters.tileUniformPacks ?? 0) + 1;
        logicalCounters.tileUniformLogicalBytes =
          (logicalCounters.tileUniformLogicalBytes ?? 0) + tileUB.size;
        logicalCounters.tileUniformAlignedBytes =
          (logicalCounters.tileUniformAlignedBytes ?? 0) +
          Math.ceil(tileUB.size / 256) * 256;
      }

      const bg0 = this._getOrCreateBindGroup0(
        device,
        cameraUB,
        tileUB,
        eclipseUB,
      );
      const bindGroup0 = bg0.bindGroup;
      const bindGroup0DynamicOffsets = bg0.dynamicOffsets;

      const bindGroup1 = this._createTextureBindGroup(device, passLayers);
      // Group 2: Merged water mask + ocean normal map
      const bindGroup2 = this._createWaterOceanBindGroup(
        device,
        isSubsequentPass ? null : surfaceTile,
        tileProvider,
      );

      // Group 3: effects — shadow receive, CSM, atmosphere LUT and clipping.
      //
      // The entire effects group is terrain-global: its bytes and its
      // placeholder-versus-active decision are identical for every selected
      // tile and every imagery pass in this frame/view, so
      // `_getOrCreateFrameEffectsBindGroup` resolves and packs it once per
      // (context, frame) and tiles 2..N and passes 2..M reuse the prepared
      // handle.
      const bindGroup3 = this._getOrCreateFrameEffectsBindGroup(
        device,
        frameState,
        tileProvider,
        uniformState,
      );

      // Wireframe overlay: swap the index buffer to the line-list version.
      // The wireframe IB is only used on the first pass (matches the pipeline
      // selection above) — subsequent passes still use the standard tri IB
      // because they're not running the wireframe pipeline.
      let drawIndexBuffer = gpuResources.indexBuffer;
      let drawIndexCount = gpuResources.indexCount;
      let drawIndexFormat = gpuResources.indexFormat;
      if (debugWireframe && !isSubsequentPass) {
        const wire = getOrCreateWireframeIndicesHelper(this, tileKey, mesh);
        if (wire) {
          drawIndexBuffer = wire.buffer;
          drawIndexCount = wire.count;
          drawIndexFormat = wire.format;
        }
      }

      // Index buffer overflow guard. A mismatch between indexCount and the
      // buffer size produces a WebGPU validation error that invalidates the
      // whole command buffer for the frame, turning the canvas black, so the
      // count is clamped.
      const bytesPerIndex = drawIndexFormat === "uint32" ? 4 : 2;
      const maxIndicesInBuffer = Math.floor(
        drawIndexBuffer.size / bytesPerIndex,
      );
      if (drawIndexCount > maxIndicesInBuffer) {
        // Permanent rather than debug-only: this indicates real data corruption
        // that produces visible rendering gaps. Throttled to once per 5 seconds
        // so recurring tiles do not spam the console.
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

      // Skirt suppression parity. WebGL truncates the draw count to
      // `mesh.indexCountWithoutSkirts` when
      // `showSkirts = tileProvider.showSkirts && !cameraUnderground &&
      // !translucent` is false (GlobeSurfaceTileProviderRendering.js:1395-1396,
      // 1836-1839). Skirt indices sit at the tail of the index buffer, so the
      // count truncation drops exactly the skirt walls. Drawing the full buffer
      // instead puts bright untinted skirt stripes across the underside of
      // underground views that WebGL never renders. Wireframe keeps its own
      // dedicated line-list index buffer, with no skirt split, matching its
      // debug-only intent.
      const showSkirts =
        (tileProvider as unknown as { showSkirts?: boolean }).showSkirts !==
          false &&
        !cameraUnderground &&
        !globeTranslucent;
      if (!showSkirts && (!debugWireframe || isSubsequentPass)) {
        const noSkirtCount = mesh.indexCountWithoutSkirts;
        if (typeof noSkirtCount === "number" && noSkirtCount > 0) {
          drawIndexCount = Math.min(drawIndexCount, noSkirtCount);
        }
      }

      // Depth-only back-face pre-pass for translucent globe rendering, pushed
      // before the regular imagery-layer command so the scene framebuffer's
      // depth attachment holds the far side of the globe — cullMode: "front",
      // depthWriteEnabled: true, colorWriteMask: 0 — before the single-pass
      // alpha blend writes the near side over it. Without the pre-pass, looking
      // through the planet at antipodal terrain produces inside-out z-fight
      // artifacts in the alpha blend.
      //
      // Gates:
      // - `globeTranslucent` — only when translucent globe rendering was
      //   requested. Static-opaque rendering pays nothing: no extra pipeline,
      //   no extra command.
      // - `!isSubsequentPass` — once per tile, not once per imagery-layer pass.
      //   Imagery layers blend over each other in subsequent passes; the depth
      //   pre-pass only needs to run for the first.
      // - `!debugWireframe && debugFragmentMode === NONE` — the debug variants
      //   own the pipeline entirely, so the pre-pass is suppressed and the
      //   debug visualization renders its own depth without a pre-emptive write
      //   affecting LOD or triangulation overlay visibility.
      // - `!cameraUnderground` — the three-pass technique is mutually exclusive
      //   with an underground camera. Underground, `disableCulling` above
      //   already forces cullMode: "none" on the regular color command, giving
      //   single-pass both-faces so the globe can be seen through. Letting the
      //   three-pass fire as well would double-blend back faces: depth-only
      //   pre-pass, translucent back face, and a translucent front-face command
      //   running with cullMode: "none" rather than "back".
      // - `backTranslucent` — the three-pass see-through technique, depth-only
      //   back-face pre-pass plus translucent back face, only applies when the
      //   back faces are themselves translucent (backFaceAlpha < 1, or
      //   backFaceAlphaByDistance). WebGL's `getDerivedCommandTypes`
      //   (GlobeTranslucencyState.js:496-520) makes the same split: with an
      //   opaque back face, the default backFaceAlpha = 1, it renders
      //   DEPTH_ONLY_FRONT_FACE, OPAQUE_BACK_FACE (z-rejected behind the front
      //   depth under base depth func LESS) and TRANSLUCENT_FRONT_FACE, whose
      //   net composite is just the alpha-blended front face over the
      //   background. Running the back-face passes there would blend the globe
      //   underside into the destination, which WebGL never shows.
      const backTranslucent =
        (
          frameState as unknown as {
            globeTranslucencyState?: { _backFaceTranslucent?: boolean };
          }
        ).globeTranslucencyState?._backFaceTranslucent === true;
      if (
        globeTranslucent &&
        backTranslucent &&
        !cameraUnderground &&
        !isSubsequentPass &&
        !debugWireframe &&
        debugFragmentMode === DebugFragmentMode.NONE
      ) {
        const depthOnlyPipeline = selectDepthOnlyBackFacePipelineHelper(
          this,
          gpuResources.isQuantized,
          gpuResources.hasNormals,
          gpuResources.hasWebMercatorT,
          gpuResources.strideBytes,
          useClipDistances,
          gpuResources.hasGeodeticSurfaceNormals,
        );
        if (depthOnlyPipeline) {
          // Reuse the regular tile bind groups — same pipeline layout,
          // same vertex transforms, same UBs. The fragment stage is
          // colorWriteMask: 0 so no fragment writes leak into the
          // imagery / atmosphere paths; only depth is written.
          commands.push({
            pipeline: depthOnlyPipeline,
            bindGroups: [bindGroup0, bindGroup1, bindGroup2, bindGroup3],
            bindGroup0DynamicOffsets,
            vertexBuffer: gpuResources.vertexBuffer,
            indexBuffer: drawIndexBuffer,
            indexCount: drawIndexCount,
            indexFormat: drawIndexFormat,
            boundingVolume:
              (tile.boundingVolume as CesiumBoundingSphere | undefined) ||
              surfaceTile.boundingSphere3D,
            isSubsequentPass: false,
            isQuantized: gpuResources.isQuantized,
            shadowCastTerrainUB: gpuResources.shadowCastUB,
            hasGeodeticSurfaceNormals: gpuResources.hasGeodeticSurfaceNormals,
            strideBytes: gpuResources.strideBytes,
            shadowCastBindGroupCacheHost: gpuResources,
          });
        }
        // If `selectDepthOnlyBackFacePipelineHelper` returns null the
        // central pipeline cache hasn't materialized this variant yet
        // (first-frame asynchrony). The translucent commands continue
        // to render without the pre-pass — a one-frame degraded
        // artifact instead of a permanent black tile.

        // Translucent back-face command, emitted after the depth-only pre-pass
        // and before the regular translucent front-face command. The per-tile
        // sequence when `globeTranslucent` is:
        //   1. Depth-only back-face — populates depth
        //   2. Translucent back-face — blends the far side
        //   3. Translucent front-face — blends the near side over it
        // The front-face command runs with cullMode "back" rather than "none",
        // through the `disableCulling` decision split above.
        const translucentBackPipeline = selectTranslucentBackFacePipelineHelper(
          this,
          gpuResources.isQuantized,
          gpuResources.hasNormals,
          gpuResources.hasWebMercatorT,
          gpuResources.strideBytes,
          useClipDistances,
          gpuResources.hasGeodeticSurfaceNormals,
        );
        if (translucentBackPipeline) {
          commands.push({
            pipeline: translucentBackPipeline,
            bindGroups: [bindGroup0, bindGroup1, bindGroup2, bindGroup3],
            bindGroup0DynamicOffsets,
            vertexBuffer: gpuResources.vertexBuffer,
            indexBuffer: drawIndexBuffer,
            indexCount: drawIndexCount,
            indexFormat: drawIndexFormat,
            boundingVolume:
              (tile.boundingVolume as CesiumBoundingSphere | undefined) ||
              surfaceTile.boundingSphere3D,
            isSubsequentPass: false,
            isQuantized: gpuResources.isQuantized,
            shadowCastTerrainUB: gpuResources.shadowCastUB,
            hasGeodeticSurfaceNormals: gpuResources.hasGeodeticSurfaceNormals,
            strideBytes: gpuResources.strideBytes,
            shadowCastBindGroupCacheHost: gpuResources,
          });
        }
        // Same async-fallback semantics as the depth-only command:
        // null pipeline → skip this command for one frame. The other
        // two commands continue to render; the missing back-face
        // contribution is invisible after the first frame.
      }

      // Opaque-back-face translucency, the default: backFaceAlpha = 1,
      // frontFaceAlpha < 1. Mirrors WebGL's DEPTH_ONLY_FRONT_FACE derived
      // command. The color command below runs on the ALPHA-blend pipeline with
      // depth-write off, so without this pre-pass the scene depth would hold no
      // globe surface at all, the sky/atmosphere pass would flood the planet
      // disk, and later depth-reading passes — the depth plane, pickPosition —
      // would break. WebGL's OPAQUE_BACK_FACE sibling command is deliberately
      // not mirrored: under WebGL's base depth func LESS it is z-rejected
      // against this pre-pass depth everywhere, at equal depth, so its net
      // contribution is nothing, whereas WebGPU's globe pipelines use
      // less-equal, where emitting it would wrongly overwrite the destination
      // with the globe underside.
      if (
        globeTranslucent &&
        !backTranslucent &&
        !cameraUnderground &&
        !isSubsequentPass &&
        !debugWireframe &&
        debugFragmentMode === DebugFragmentMode.NONE
      ) {
        const depthOnlyFrontPipeline = selectDepthOnlyFrontFacePipelineHelper(
          this,
          gpuResources.isQuantized,
          gpuResources.hasNormals,
          gpuResources.hasWebMercatorT,
          gpuResources.strideBytes,
          useClipDistances,
          gpuResources.hasGeodeticSurfaceNormals,
        );
        if (depthOnlyFrontPipeline) {
          // Reuse the regular tile bind groups — same pipeline layout,
          // same vertex transforms, same UBs. colorWriteMask: 0 → only
          // depth is written.
          commands.push({
            pipeline: depthOnlyFrontPipeline,
            bindGroups: [bindGroup0, bindGroup1, bindGroup2, bindGroup3],
            bindGroup0DynamicOffsets,
            vertexBuffer: gpuResources.vertexBuffer,
            indexBuffer: drawIndexBuffer,
            indexCount: drawIndexCount,
            indexFormat: drawIndexFormat,
            boundingVolume:
              (tile.boundingVolume as CesiumBoundingSphere | undefined) ||
              surfaceTile.boundingSphere3D,
            isSubsequentPass: false,
            isQuantized: gpuResources.isQuantized,
            shadowCastTerrainUB: gpuResources.shadowCastUB,
            hasGeodeticSurfaceNormals: gpuResources.hasGeodeticSurfaceNormals,
            strideBytes: gpuResources.strideBytes,
            shadowCastBindGroupCacheHost: gpuResources,
          });
        }
        // Null pipeline → the central cache is still materializing this
        // variant; skip the pre-pass for one frame (same fallback
        // semantics as the back-face pre-pass above).
      }

      // Material slots are merged into group 2. When a material is active,
      // rebuild bindGroup2 with the material UBO and textures included;
      // otherwise the four-binding water/ocean group is padded with
      // placeholders to match the expanded layout.
      let bindGroup2Final = bindGroup2;
      if (materialEntry) {
        bindGroup2Final = this._createWaterOceanMaterialBindGroup(
          surfaceTile,
          tileProvider,
          materialEntry,
          tpMaterial!,
        );
      } else {
        bindGroup2Final = this._createWaterOceanMaterialBindGroup(
          surfaceTile,
          tileProvider,
          null,
          null,
        );
      }

      // Globe terrain pick pipeline, selected for the primary (first) pass
      // only. The scene adapter attaches the resulting pick command to that
      // command's `derivedCommands.picking.pickCommand` so the WebGPU pick pass
      // dispatches it, writing globe depth and the `camera.pickColor` tail into
      // the pick FBO. The pick pipeline uses the same vertex variant, so the
      // same bind groups and vertex buffer line up, but `fragmentPickMain`. It
      // is independent of imagery-layer multi-pass, debug and material, which
      // vary only the fragment stage of the color path, so subsequent imagery
      // passes need no pick command. Null while the central cache materializes
      // the variant, leaving pick absent for one frame.
      const pickPipeline = !isSubsequentPass
        ? selectPickPipelineHelper(
            this,
            gpuResources.isQuantized,
            gpuResources.hasNormals,
            gpuResources.hasWebMercatorT,
            gpuResources.strideBytes,
            useClipDistances,
            gpuResources.hasGeodeticSurfaceNormals,
          )
        : null;

      commands.push({
        pipeline,
        pickPipeline,
        bindGroups: [bindGroup0, bindGroup1, bindGroup2Final, bindGroup3],
        bindGroup0DynamicOffsets,
        vertexBuffer: gpuResources.vertexBuffer,
        indexBuffer: drawIndexBuffer,
        indexCount: drawIndexCount,
        indexFormat: drawIndexFormat,
        boundingVolume:
          (tile.boundingVolume as CesiumBoundingSphere | undefined) ||
          surfaceTile.boundingSphere3D,
        isSubsequentPass,
        // Shadow cast wiring. Every tile, quantized or not, carries its
        // shadow-cast UB and its true vertex-buffer stride so the stride-aware
        // pipeline registry in WebGPUShadowMapRenderer can build a pipeline
        // whose `arrayStride` matches this tile's actual vertex buffer. The
        // scene adapter translates these three fields into
        // `_shadowCastLayout`, `_shadowCastTerrainUB` and `vertexStride` on the
        // Cesium draw command.
        isQuantized: gpuResources.isQuantized,
        shadowCastTerrainUB: gpuResources.shadowCastUB,
        hasGeodeticSurfaceNormals: gpuResources.hasGeodeticSurfaceNormals,
        strideBytes: gpuResources.strideBytes,
        shadowCastBindGroupCacheHost: gpuResources,
      });
    }

    if (logicalCounters) {
      logicalCounters.passDescriptors =
        (logicalCounters.passDescriptors ?? 0) + commands.length;
    }
    if (deferredPasses > 0 && commands.length > 0) {
      // Partially drawn tile: some imagery passes are on screen and some are
      // not. `Scene.renderReady` reads this so a frame missing an imagery
      // blend pass is not reported as complete. The whole-tile case is counted
      // by the caller against the null return below.
      const fs = frameState as unknown as { commandsDeferred?: number };
      fs.commandsDeferred = (fs.commandsDeferred ?? 0) + deferredPasses;
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
      bindGroup0DynamicOffsets: cmd.bindGroup0DynamicOffsets,
      vertexBuffer: cmd.vertexBuffer,
      indexBuffer: cmd.indexBuffer,
      indexCount: cmd.indexCount,
      indexFormat: cmd.indexFormat,
      boundingVolume: cmd.boundingVolume,
      isSubsequentPass: false,
    };
  }

  /**
   * Group 0 (camera UB + tile UB + eclipse UB), cached on the three backing
   * buffer identities. Per-allocation offsets are dynamic and therefore do
   * not participate in the key. The eclipse identity is load-bearing: active
   * slices may land on a different ring page than camera/tile, while ordinary
   * frames use the renderer-owned inert buffer.
   */
  private _getOrCreateBindGroup0(
    device: GPUDevice,
    cameraUB: { buffer: GPUBuffer; offset: number; size: number },
    tileUB: { buffer: GPUBuffer; offset: number; size: number },
    eclipseUB: { buffer: GPUBuffer; offset: number; size: number },
  ): { bindGroup: GPUBindGroup; dynamicOffsets: number[] } {
    const cache = this._bindGroupCache;
    // The bind group is built over the ring page at offset 0, with size equal
    // to the struct width. Its key is only the camera page, tile page and
    // eclipse page/buffer identities; the per-allocation byte offset is
    // supplied per draw as a dynamic offset instead. Under camera motion the
    // page identities cycle through the ring's pageCount and recur every
    // pageCount frames, so the cache converges to about pageCount group-0
    // entries and stays near a 100% hit rate even while the byte offsets shift
    // each frame.
    const key =
      `0|${cache.idOf(cameraUB.buffer)}|${cache.idOf(tileUB.buffer)}|` +
      `${cache.idOf(eclipseUB.buffer)}`;
    const bindGroup = cache.getOrCreate(key, () =>
      device.createBindGroup({
        layout: this._bindGroupLayout0!,
        entries: [
          {
            binding: 0,
            resource: {
              buffer: cameraUB.buffer,
              offset: 0,
              size: cameraUB.size,
            },
          },
          {
            binding: 1,
            resource: {
              buffer: tileUB.buffer,
              offset: 0,
              size: tileUB.size,
            },
          },
          {
            binding: 2,
            resource: {
              buffer: eclipseUB.buffer,
              offset: 0,
              size: eclipseUB.size,
            },
          },
        ],
      }),
    );
    // Dynamic offsets must be multiples of minUniformBufferOffsetAlignment
    // (256). The ring allocator aligns every allocation to 256, and the
    // first-frame fallback path returns offset 0 — both satisfy the
    // constraint. The array order matches the binding order (0, 1, 2).
    return {
      bindGroup,
      dynamicOffsets: [cameraUB.offset, tileUB.offset, eclipseUB.offset],
    };
  }

  private _createTextureBindGroup(
    device: GPUDevice,
    passLayers: CesiumTileImagery[],
  ): GPUBindGroup {
    const textureViews: GPUTextureView[] = [];
    // The entry count follows the per-device group-1 layout width: 16 full, 4
    // reduced.
    const imagerySlots = this._imagerySlotCount;

    for (
      let i = 0;
      i < passLayers.length && textureViews.length < imagerySlots;
      i++
    ) {
      const tileImagery = passLayers[i];
      if (!tileImagery || !tileImagery.readyImagery) continue;

      const imagery = tileImagery.readyImagery;
      // Pass the full tileImagery so the cache can pick the Mercator or
      // Geographic variant from `tileImagery.useWebMercatorT` and the
      // per-imagery dual textures.
      const result = getOrCreateImageryTextureHelper(this, tileImagery);
      if (result) {
        textureViews.push(result.view);
      } else if (this._diagShouldLog()) {
        //>>includeStart('debug', pragmas.debug);
        console.warn(
          `[WebGPU:GlobeTile] _getOrCreateImageryTexture returned null for imagery`,
          {
            hasImage: !!imagery?.image,
            hasTexture: !!imagery?.texture,
            hasMerc: !!imagery?._webgpuMercatorTexture,
            hasReproj: !!imagery?._webgpuReprojectedTexture,
            texSource: !!(
              imagery?.texture as CesiumTextureWithSource | undefined
            )?._source,
          },
        );
        //>>includeEnd('debug');
      }
    }

    while (textureViews.length < imagerySlots) {
      textureViews.push(this._placeholderView!);
    }

    // Keyed on the per-slot view identities. Views are stable per texture —
    // created once and cached in `_imageryTextureCache` next to their
    // GPUTexture — so a key change means the underlying texture actually
    // rotated. The sampler is an init-time singleton and stays out of the key.
    const cache = this._bindGroupCache;
    let key = "1";
    for (let i = 0; i < imagerySlots; i++) {
      key += `|${cache.idOf(textureViews[i])}`;
    }

    // One texture binding per imagery slot, plus the shared sampler at binding
    // 16, where both layout shapes keep it. Each entry pulls from
    // `textureViews[i]`, padded with placeholder views above so unused slots
    // still bind a valid resource.
    return cache.getOrCreate(key, () => {
      const entries: GPUBindGroupEntry[] = [];
      for (let i = 0; i < imagerySlots; i++) {
        entries.push({ binding: i, resource: textureViews[i] });
      }
      entries.push({ binding: 16, resource: this._sampler! });
      return device.createBindGroup({
        layout: this._bindGroupLayout1!,
        entries,
      });
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
    return this._createWaterOceanMaterialBindGroupInner(
      surfaceTile,
      tileProvider,
      null,
      null,
    );
  }

  // Wraps `_createWaterOceanBindGroup` to accept an optional material entry and
  // material data. When they are provided, the material UBO and texture slots
  // (bindings 4-8) are filled; otherwise placeholders bind there so the bind
  // group still matches the layout.
  private _createWaterOceanMaterialBindGroup(
    surfaceTile: CesiumGlobeSurfaceTile | null,
    tileProvider: CesiumGlobeTileProvider,
    materialEntry: MaterialPipelineCacheEntry | null,
    material: { uniforms: Record<string, unknown> } | null,
  ): GPUBindGroup {
    return this._createWaterOceanMaterialBindGroupInner(
      surfaceTile,
      tileProvider,
      materialEntry,
      material,
    );
  }

  // Resolve a material texture-uniform to a GPUTextureView. First checks
  // for a `_webgpuTexture.view` (the imagery upload path), then for a
  // `_webgpuReprojectedTexture` (imagery reprojection), then falls back
  // to uploading the raw HTMLCanvasElement / HTMLImageElement / ImageBitmap
  // value via `uploadImageSource` (the path Cesium materials use —
  // `Material._textures[uniformId]` is constructed lazily from canvases
  // generated by the JS side, never routes through imagery upload).
  // The uploaded view is cached keyed on `materialType|uniformName`
  // and re-uploaded only when the underlying source identity changes.
  private _resolveOrUploadMaterialTexture(
    materialType: string,
    uniformName: string,
    value: unknown,
  ): GPUTextureView | null {
    if (!value) return null;
    // Fast path: WebGPU view already exists on the value.
    const existingView = resolveMaterialTextureView(value);
    if (existingView) return existingView;

    // Direct-image path: upload via `uploadImageSource`.
    if (
      !(value instanceof HTMLImageElement) &&
      !(value instanceof HTMLCanvasElement) &&
      !(value instanceof ImageBitmap)
    ) {
      return null;
    }
    const key = `${materialType}|${uniformName}`;
    const cached = this._materialTextureCache.get(key);
    if (cached && cached.source === value) return cached.view;

    const view = uploadImageSourceHelper(
      this,
      value,
      `globeMaterial_${key}`,
      this._imageryTextureCache,
    );
    if (view) {
      this._materialTextureCache.set(key, { source: value, view });
    }
    return view;
  }

  private _createWaterOceanMaterialBindGroupInner(
    surfaceTile: CesiumGlobeSurfaceTile | null,
    tileProvider: CesiumGlobeTileProvider,
    materialEntry: MaterialPipelineCacheEntry | null,
    material: { uniforms: Record<string, unknown> } | null,
  ): GPUBindGroup {
    const device = this._device!;
    // The fallback is the zero, all-land mask rather than the white
    // placeholder, which the shader reads as all water.
    let waterMaskView = this._noWaterMaskView!;
    let normalMapView = this._placeholderView!;

    if (surfaceTile) {
      const waterMaskTex = surfaceTile.waterMaskTexture;
      if (waterMaskTex) {
        const wmView = getOrCreateWaterMaskTextureHelper(this, waterMaskTex);
        if (wmView) {
          waterMaskView = wmView;
        }
      }
    }

    const oceanNormalMap = tileProvider?.oceanNormalMap;
    if (oceanNormalMap) {
      const onm = oceanNormalMap as CesiumTextureWithSource;
      // Prefer `_webgpuSource`, the decoded image Globe.js retains: the WebGL
      // Texture drops `_source` and `image` after upload, so in practice those
      // are undefined here. Without it the resolver falls through to the
      // Texture object itself, fails the instanceof gate below, and leaves the
      // wave sampler on the 1×1 placeholder, giving a flat, non-animating
      // ocean.
      const source = onm._webgpuSource ?? onm._source ?? onm.image;
      if (
        source instanceof HTMLImageElement ||
        source instanceof ImageBitmap ||
        source instanceof HTMLCanvasElement
      ) {
        // Reuse the previously uploaded view while the underlying source object
        // is unchanged. The ocean normal map is a decoded, immutable image
        // retained by Globe.js, so identity equality is a sound reuse test —
        // the same test `_resolveOrUploadMaterialTexture` applies. A changed
        // source, such as `oceanNormalMapUrl` swapped at runtime, fails the
        // identity check and re-uploads exactly once.
        if (this._oceanNormalMapView && this._oceanNormalMapSource === source) {
          normalMapView = this._oceanNormalMapView;
        } else {
          const view = uploadImageSourceHelper(
            this,
            source,
            "oceanNormal",
            this._oceanNormalMapCache,
          );
          if (view) {
            normalMapView = view;
            this._oceanNormalMapSource = source;
            this._oceanNormalMapView = view;
          }
        }
      }
    }

    // Material UBO + textures — slots 4-8. When no material is bound,
    // the slots receive the singleton placeholder UBO + placeholder
    // textures so the bind group still validates against the expanded
    // Group 2 layout.
    let matUBO: GPUBuffer;
    let matImage = this._placeholderView!;
    let matHeights = this._placeholderView!;
    if (materialEntry && material) {
      matUBO = materialEntry.ubo;
      // Pull from the aggregated composite-uniforms view so composite-fabric
      // texture uniforms — for instance the `image` color ramp on Bathymetry's
      // `ElevationRamp` sub-material, owned by
      // `material.materials.elevationRampMaterial` rather than the parent —
      // resolve through the same lookup path as scalar uniforms in
      // `packMaterialUBO`.
      const uniforms = aggregateCompositeUniforms(material as never);
      const matType = (material as unknown as { type?: string }).type ?? "?";
      if (materialEntry.textureNames.length > 0) {
        const v = this._resolveOrUploadMaterialTexture(
          matType,
          materialEntry.textureNames[0],
          uniforms[materialEntry.textureNames[0]],
        );
        if (v) matImage = v;
      }
      if (materialEntry.textureNames.length > 1) {
        const v = this._resolveOrUploadMaterialTexture(
          matType,
          materialEntry.textureNames[1],
          uniforms[materialEntry.textureNames[1]],
        );
        if (v) matHeights = v;
      }
    } else {
      // Lazy-init a singleton placeholder UBO (16 bytes of zeros).
      if (!this._placeholderMaterialUBO) {
        this._placeholderMaterialUBO = device.createBuffer({
          label: "Globe material placeholder UBO",
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      }
      matUBO = this._placeholderMaterialUBO;
    }

    // The group-2 cache key is the five variable resource identities: water
    // mask view, ocean normal view, material UBO and two material texture
    // views. Samplers are init-time singletons. The material UBO's contents are
    // rewritten per frame through writeBuffer, but the buffer object is stable
    // per material type, so the bind group itself is reusable. This also
    // collapses the per-pass double create: `bindGroup2` for the translucency
    // pre-passes and `bindGroup2Final` for the color pass resolve to the same
    // key when their resolved resources match.
    //
    // Bindings 9 and 10 are the sun-view Beer shadow map and sampler, captured
    // this frame from the cloud cache — the real map when
    // `globe.cloudCastShadows` is on, otherwise the renderer's 1×1 placeholder,
    // which reads as transmittance 1, no shadow. They are folded into the cache
    // key so a real-versus-placeholder swap rebuilds the group.
    const cloudShadowView = this._cloudShadowView ?? this._placeholderView!;
    const cloudShadowSampler = this._cloudShadowSampler ?? this._sampler!;

    // Binding 11 is the tile's draped vector-polyline lookup buffer, realized
    // at bake time by `prepareWebGPUVectorTileData`. Tiles with no clamped
    // vector geometry — the overwhelming majority — share one 32-byte all-zero
    // placeholder whose `gridWidth` header word is 0, the shader's early-out
    // sentinel, so the layout never forks and the cache key stays stable across
    // a whole globe of vector-free tiles.
    if (!this._placeholderVectorBuffer) {
      this._placeholderVectorBuffer = device.createBuffer({
        label: "Globe vector tile placeholder",
        size: VECTOR_TILE_PLACEHOLDER_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    const vectorBuffer = resolveVectorTileBuffer(
      device,
      surfaceTile?.vectorData,
      this._placeholderVectorBuffer,
    );

    const cache = this._bindGroupCache;
    const key =
      `2|${cache.idOf(waterMaskView)}|${cache.idOf(normalMapView)}|` +
      `${cache.idOf(matUBO)}|${cache.idOf(matImage)}|${cache.idOf(matHeights)}|` +
      `${cache.idOf(cloudShadowView)}|${cache.idOf(vectorBuffer)}`;
    return cache.getOrCreate(key, () =>
      device.createBindGroup({
        layout: this._bindGroupLayout2!,
        entries: [
          { binding: 0, resource: waterMaskView },
          { binding: 1, resource: this._waterMaskSampler! },
          { binding: 2, resource: normalMapView },
          { binding: 3, resource: this._oceanNormalSampler! },
          { binding: 4, resource: { buffer: matUBO } },
          { binding: 5, resource: matImage },
          { binding: 6, resource: this._sampler! },
          { binding: 7, resource: matHeights },
          { binding: 8, resource: this._sampler! },
          { binding: 9, resource: cloudShadowView },
          { binding: 10, resource: cloudShadowSampler },
          { binding: 11, resource: { buffer: vectorBuffer } },
        ],
      }),
    );
  }

  // The imagery and water-mask texture caches are managed by
  // `WebGPUGlobeSurfaceTextures.ts`, whose helpers the single call sites above
  // invoke directly. The shared `uploadImageSource` helper is likewise called
  // directly from the ocean-normal-map upload site in
  // `_createWaterOceanMaterialBindGroupInner`.
  //
  // `selectWireframePipeline`, `buildWireframePipelineDescriptor` and
  // `getOrCreateWireframeIndices` live in `WebGPUGlobeSurfaceWireframe.ts`; the
  // `createWireframeTileCommands` orchestrator below calls them directly.

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

    // Capture the central pipeline cache from the context, as
    // `createTileCommands` does.
    if (!this._centralPipelineCache) {
      this._centralPipelineCache =
        (
          frameState.context as unknown as {
            webgpuPipelineCache?: WebGPURenderPipelineCache | null;
          }
        ).webgpuPipelineCache ?? null;
    }

    const device = this._device;
    const mesh = surfaceTile.renderedMesh || surfaceTile.mesh;
    if (!mesh) return null;

    // The same per-frame tick `createTileCommands` runs; a no-op when the frame
    // has already been ticked.
    this._bindGroupCache.beginFrame(frameState.frameNumber ?? 0);

    const tileKey = getTileKeyHelper(tile);
    const gpuResources = getOrCreateTileBuffersHelper(this, tileKey, mesh);
    if (!gpuResources) return null;

    const wireIB = getOrCreateWireframeIndicesHelper(this, tileKey, mesh);
    if (!wireIB) return null;

    const pipeline = selectWireframePipelineHelper(
      this,
      gpuResources.isQuantized,
      gpuResources.hasNormals,
      gpuResources.hasWebMercatorT,
      gpuResources.strideBytes,
      gpuResources.hasGeodeticSurfaceNormals,
    );
    // A null pipeline means it is still resolving in the central cache, so the
    // wireframe overlay is skipped this frame and picked up on the next.
    if (!pipeline) return null;

    // Wireframe parity with WebGL: WebGL's wireframe path only swaps the tile
    // command's vertexArray to the line vertex array and its primitiveType to
    // LINES, keeping the full imagery uniformMap and textures, so the lines are
    // shaded with real imagery against the black background. Feeding an empty
    // layer set here would skip `fragmentMain`'s imagery composite loop, which
    // is gated on `tile.layerCount > 0`, and the lines would emit the navy base
    // color `tile.initialColor` ≈ (0, 0, 0.5), which reads as black. So the
    // same ready imagery layers `createTileCommands` gathers are fed through,
    // as a single first pass — the wireframe is a one-pass debug overlay and
    // needs no multi-pass blend.
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
    const wireLayers = readyLayers.slice(0, this._imagerySlotCount);

    const cameraUB = createCameraUniformBufferHelper(
      this,
      device,
      uniformState,
      surfaceTile,
      tileProvider,
      mesh,
      frameState,
      tile,
    );
    const tileUB = createTileUniformBufferHelper(
      this,
      device,
      surfaceTile,
      tileProvider,
      frameState,
      tile,
      wireLayers,
      false,
    );

    const eclipseUB = this._eclipseUniforms.prepare(device, frameState);
    const bg0 = this._getOrCreateBindGroup0(
      device,
      cameraUB,
      tileUB,
      eclipseUB,
    );

    // Real imagery textures, matching `createTileCommands`' first pass, so the
    // wireframe lines are imagery-colored rather than base-color black.
    const bindGroup1 = this._createTextureBindGroup(device, wireLayers);
    const bindGroup2 = this._createWaterOceanBindGroup(
      device,
      surfaceTile,
      tileProvider,
    );

    return [
      {
        pipeline,
        bindGroups: [
          bg0.bindGroup,
          bindGroup1,
          bindGroup2,
          this._placeholderEffectsBG!,
        ],
        bindGroup0DynamicOffsets: bg0.dynamicOffsets,
        vertexBuffer: gpuResources.vertexBuffer,
        indexBuffer: wireIB.buffer,
        indexCount: wireIB.count,
        indexFormat: wireIB.format,
        boundingVolume:
          (tile.boundingVolume as CesiumBoundingSphere | undefined) ||
          surfaceTile.boundingSphere3D,
        isSubsequentPass: false,
        shadowCastBindGroupCacheHost: gpuResources,
      },
    ];
  }

  /**
   * Capture sibling of `createTileCommands`. Builds one single-color-target
   * draw command for a tile, rendering the opaque globe surface into a
   * dynamic-environment-map cube face. The caller, `runSceneCapture` in
   * `WebGPUDynamicEnvironmentMapManager`, has already repointed `uniformState`
   * at the active cube-face camera through
   * `uniformState.updateCamera(faceCamera)`, so
   * `createCameraUniformBufferHelper` packs the face-camera RTE matrices for
   * free, through the same override-camera seam the WebGL shadow loop uses.
   *
   * This deliberately does not run the on-screen `createTileCommands`
   * `_scenePipelineFormatGeneration` reset, which wipes `_pipelineCache`: the
   * capture pipeline lives in the separate `_capturePipelineCache`, so a
   * capture build never invalidates the on-screen globe pipelines and costs no
   * per-frame FPS while capture is active. It reuses the standard group 0, 1
   * and 2 bind groups plus the placeholder effects group; a single imagery pass
   * is enough for a reflection source, with no multi-layer blend, material,
   * debug variant or translucency.
   *
   * @param faceFormat the cube-face color attachment format (`rgba8unorm` /
   *   `rgba16float`) — keys the capture pipeline variant.
   * @returns one capture command, or null while the pipeline is still
   *   materializing (the tile is simply omitted from this capture frame) or the
   *   tile has no renderable mesh.
   */
  getOrCreateCaptureTileCommands(
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
    faceFormat: GPUTextureFormat,
  ): TileDrawDescriptor[] | null {
    if (!this._isInitialized || !this._device) return null;

    if (!this._centralPipelineCache) {
      this._centralPipelineCache =
        (
          frameState.context as unknown as {
            webgpuPipelineCache?: WebGPURenderPipelineCache | null;
          }
        ).webgpuPipelineCache ?? null;
    }

    // Mirror the on-screen log-depth and imagery-reduced state so the capture
    // pipeline's shader-define set lines up with the bind-group layout. The
    // on-screen `createTileCommands` sets `_logDepthEnabled` each frame, but
    // capture runs in `primitives.update`, before `globe.render`, so the gate
    // is resolved directly here to stay in sync on the first capture of the
    // frame.
    //
    // This has to be the same expression the on-screen writer uses. Both read
    // the same `frameState`, so whichever runs first this frame decides the
    // same globe encoding; were the two to diverge, the capture cube and the
    // on-screen frame would disagree and the shared `_pipelineCache` and module
    // set would thrash between them every frame.
    this._logDepthEnabled = isWebGPULogDepthActive(
      frameState.context,
      frameState,
    );

    // Mirror the ocean-styling toggle here too. Capture runs in
    // `primitives.update`, before `globe.render` and `createTileCommands`, so
    // it is read directly to stay in sync on the first capture of the frame.
    // The shared `_applyEnhancedOceanState` wipes all globe pipeline caches on
    // a flip, so whichever path runs first covers both.
    this._applyEnhancedOceanState(tileProvider.enableEnhancedOcean ?? false);

    const device = this._device;
    const mesh = surfaceTile.renderedMesh || surfaceTile.mesh;
    if (!mesh) return null;

    this._bindGroupCache.beginFrame(frameState.frameNumber ?? 0);

    const tileKey = getTileKeyHelper(tile);
    const gpuResources = getOrCreateTileBuffersHelper(this, tileKey, mesh);
    if (!gpuResources) return null;

    const pipeline = selectCapturePipelineHelper(
      this,
      gpuResources.isQuantized,
      gpuResources.hasNormals,
      gpuResources.hasWebMercatorT,
      gpuResources.strideBytes,
      faceFormat,
      gpuResources.hasGeodeticSurfaceNormals,
    );
    // `selectCapturePipeline` resolves synchronously, so this is null only if
    // the device is unavailable — skip the tile this capture frame.
    if (!pipeline) return null;

    // First imagery pass only — the reflection source needs real imagery color,
    // but not the multi-layer blend or material/debug variants.
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
    const captureLayers = readyLayers.slice(0, this._imagerySlotCount);

    const cameraUB = createCameraUniformBufferHelper(
      this,
      device,
      uniformState,
      surfaceTile,
      tileProvider,
      mesh,
      frameState,
      tile,
    );
    const tileUB = createTileUniformBufferHelper(
      this,
      device,
      surfaceTile,
      tileProvider,
      frameState,
      tile,
      captureLayers,
      false,
    );

    // The eclipse carrier is geocentric, so every cube-face capture camera
    // reuses the logical view's single payload; only the camera UBO changes per
    // face.
    const eclipseUB = this._eclipseUniforms.prepare(device, frameState);
    const bg0 = this._getOrCreateBindGroup0(
      device,
      cameraUB,
      tileUB,
      eclipseUB,
    );
    const bindGroup1 = this._createTextureBindGroup(device, captureLayers);
    const bindGroup2 = this._createWaterOceanBindGroup(
      device,
      surfaceTile,
      tileProvider,
    );

    return [
      {
        pipeline,
        bindGroups: [
          bg0.bindGroup,
          bindGroup1,
          bindGroup2,
          this._placeholderEffectsBG!,
        ],
        bindGroup0DynamicOffsets: bg0.dynamicOffsets,
        vertexBuffer: gpuResources.vertexBuffer,
        indexBuffer: gpuResources.indexBuffer,
        indexCount: gpuResources.indexCount,
        indexFormat: gpuResources.indexFormat,
        boundingVolume:
          (tile.boundingVolume as CesiumBoundingSphere | undefined) ||
          surfaceTile.boundingSphere3D,
        isSubsequentPass: false,
      },
    ];
  }

  // Public delegators for the tile-buffer and imagery-texture cache eviction
  // helpers, whose bodies live in `WebGPUGlobeSurfaceTileBuffers.ts`.

  evictStaleResources(activeTileKeys: Set<string>): void {
    evictStaleResourcesHelper(this, activeTileKeys);
  }

  removeImageryTexture(cacheKey: string): void {
    removeImageryTextureHelper(this, cacheKey);
  }

  /**
   * Enumerate every renderer-local pipeline cache.
   *
   * This replaces key-string spelunking as the way to ask what this renderer
   * has built. It covers all four maps — `_pipelineCache`, which holds the
   * color, pick, translucent-back-face and both depth-only kinds,
   * `_capturePipelineCache`, `_debugFragmentPipelineCache` and
   * `_wireframePipelineCache` — and reports one row per stored entry, so the
   * row count always equals the sum of the map sizes.
   *
   * Each row carries the parsed key fields, or `fields: null` when the stored
   * key does not match the grammar in `WebGPUGlobeSurfacePipelineKey`. That
   * null is load-bearing: a reader assuming a key shape the producer has
   * stopped writing otherwise fails silently, and an unparseable row is the
   * visible form of that divergence.
   *
   * `descriptorName` is the leading segment of the CENTRAL cache key
   * (`WebGPURenderPipelineCache.describeCacheKey`), so two rows with distinct
   * `key`s but an identical `descriptorName` are exactly the shape that
   * aliases one `GPURenderPipeline` across two logical variants.
   *
   * @param kind optional filter on the parsed variant kind. Rows whose key
   *   does not parse are excluded when a filter is supplied (they have no
   *   known kind to match) and always included when it is not.
   * @returns one row per cached entry
   */
  listPipelineVariants(
    kind?: GlobePipelineVariantKind,
  ): GlobePipelineVariantInfo[] {
    const rows = [
      ...listGlobePipelineVariants(this._pipelineCache, "pipeline"),
      ...listGlobePipelineVariants(this._capturePipelineCache, "capture"),
      ...listGlobePipelineVariants(
        this._debugFragmentPipelineCache,
        "debugFragment",
      ),
      ...listGlobePipelineVariants(this._wireframePipelineCache, "wireframe"),
    ];
    if (kind === undefined) {
      return rows;
    }
    return rows.filter((row) => row.fields?.kind === kind);
  }

  // These four accessors each name a semantic variant — "uncompressed, with
  // normals, opaque, no extra defines" and its siblings — and resolve it
  // through `findGlobePipelineVariant`, which parses the key grammar from its
  // single owning module. A hardcoded key string here instead would silently
  // stop matching the moment the producer's grammar gains a field. They compare
  // only the axes the getters actually mean:
  //
  //   quantized / normals / opaque / no clip-distances / cull enabled /
  //   no active shader defines
  //
  // Two axes are deliberately left free:
  //   - webMercatorT — no getter names it, so pinning it would exclude
  //     materialized variants the getter is meant to find.
  //   - stride — varies with the terrain encoding actually loaded (12, 16, 20,
  //     24, 28, 32, 36, 40 or more bytes, depending on quantization,
  //     webMercatorT, normals and geodetic surface normals), so any single
  //     value would be a guess at one encoding.
  //
  // Several materialized variants can therefore satisfy one getter. The
  // lexicographically smallest key wins, so repeat calls are stable rather than
  // load-order dependent; callers needing every match use
  // `listPipelineVariants()`. Returns `null` when no matching variant has
  // materialized.
  get pipeline(): GPURenderPipeline | null {
    return findGlobePipelineVariant(this._pipelineCache, {
      kind: "color",
      isQuantized: false,
      hasNormals: true,
      isBlend: false,
      useClipDistances: false,
      disableCulling: false,
      defines: 0,
    });
  }

  get pipelineNoNormals(): GPURenderPipeline | null {
    return findGlobePipelineVariant(this._pipelineCache, {
      kind: "color",
      isQuantized: false,
      hasNormals: false,
      isBlend: false,
      useClipDistances: false,
      disableCulling: false,
      defines: 0,
    });
  }

  get pipelineQuantized(): GPURenderPipeline | null {
    return findGlobePipelineVariant(this._pipelineCache, {
      kind: "color",
      isQuantized: true,
      hasNormals: true,
      isBlend: false,
      useClipDistances: false,
      disableCulling: false,
      defines: 0,
    });
  }

  get pipelineQuantizedNoNormals(): GPURenderPipeline | null {
    return findGlobePipelineVariant(this._pipelineCache, {
      kind: "color",
      isQuantized: true,
      hasNormals: false,
      isBlend: false,
      useClipDistances: false,
      disableCulling: false,
      defines: 0,
    });
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

  destroy(): void {
    if (this._isDestroyed) return;

    // Drop the per-(context, frame) effects memo this renderer published; it
    // otherwise pins a bind group plus shadow-map, clipping and tile-provider
    // references for the context's lifetime. The memo is intra-frame by design,
    // since reuse is gated on `frameNumber`, so nulling it here is safe by
    // construction and the next frame rebuilds it.
    if (this._effectsMemoContext) {
      this._effectsMemoContext._globeEffectsHandle = null;
      this._effectsMemoContext = null;
    }

    // Route final destruction through the same helper as production eviction so
    // the opt-in logical lifetime gauges close consistently.
    evictStaleResourcesHelper(this, new Set());

    for (const cacheKey of [...this._imageryTextureCache.keys()]) {
      removeImageryTextureHelper(this, cacheKey);
    }
    // Release every shared imagery realization. The map entries were dropped
    // above; this destroys the shared GPUTextures the table owns. Destruction
    // routes through the last live context's deferred `scheduleTextureDestroy`,
    // since the table stores no context closure of its own; if no context was
    // ever plumbed, inline destroy is the only option and is stamped so a
    // pending mip job for the texture is skipped.
    if (this._sharedImageryRealizations) {
      const ctx = this._webgpuContext;
      this._sharedImageryRealizations.destroyAll((t) => {
        if (ctx) {
          ctx.scheduleTextureDestroy(t);
        } else {
          try {
            t.destroy();
          } catch {
            // Device already lost — destroy() is a safe no-op.
          }
        }
      });
      this._sharedImageryRealizations = null;
    }

    for (const [, cached] of this._waterMaskTextureCache) {
      // An inline destroy is stamped so a same-frame pending mip job for this
      // texture is skipped instead of encoding on a dead texture.
      this._webgpuContext?.noteInlineTextureDestroy?.(cached.texture);
      cached.texture.destroy();
    }
    this._waterMaskTextureCache.clear();

    for (const [, cached] of this._oceanNormalMapCache) {
      // Ocean-normal uploads enqueue frame-owned mip jobs, so a mid-frame
      // destroy must stamp or `endFrame` would encode mips on a destroyed
      // texture.
      this._webgpuContext?.noteInlineTextureDestroy?.(cached.texture);
      cached.texture.destroy();
    }
    this._oceanNormalMapCache.clear();
    // Drop the reuse guard alongside the textures it points at, or a later
    // frame would hand out a view backed by a destroyed texture.
    this._oceanNormalMapSource = null;
    this._oceanNormalMapView = null;
    this._webgpuContext = null;

    for (const [, wf] of this._wireframeIndexCache) {
      wf.buffer.destroy();
    }
    this._wireframeIndexCache.clear();

    if (this._placeholderTexture) {
      this._placeholderTexture.destroy();
    }

    if (this._noWaterMaskTexture) {
      this._noWaterMaskTexture.destroy();
      this._noWaterMaskTexture = null;
      this._noWaterMaskView = null;
    }

    // The shared vector placeholder is renderer-owned. Per-tile vector buffers
    // belong to their `VectorTileData` and are released through
    // `VectorPipeline.freeResources`, not here.
    if (this._placeholderVectorBuffer) {
      this._placeholderVectorBuffer.destroy();
      this._placeholderVectorBuffer = null;
    }

    this._pipelineCache.clear();
    this._wireframePipelineCache.clear();
    this._debugFragmentPipelineCache.clear();
    // Drop all cached bind groups, which reference textures and buffers
    // destroyed above, and unpublish the debug handle if it points at this
    // cache.
    this._bindGroupCache.clear();
    const g = globalThis as {
      __webgpuGlobeBindGroupCache?: WebGPUGlobeBindGroupCache;
    };
    if (g.__webgpuGlobeBindGroupCache === this._bindGroupCache) {
      g.__webgpuGlobeBindGroupCache = undefined;
    }
    this._eclipseUniforms.destroy();
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
