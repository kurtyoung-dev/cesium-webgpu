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
import { ShaderDefine } from "./WebGPUShaderDefines.js";
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

// C9-13 (NEW-GLOBE-EFFECTS-PER-VIEW-PREPARED-HANDLE) — the terrain-global
// group-3 effects state (shadow receive / CSM / atmosphere LUT / clipping
// planes+polygons) is identical for every selected tile in a frame/view, yet
// the pre-C9-13 path re-resolved and re-packed it once per tile per imagery
// pass (~200 tiles → ~200 identical repacks: a 480-byte `fill(0)`+repack,
// `computeClipPlaneDPrimes`, 22 WeakMap identity lookups, 3 string concats, and
// several wrapper-object literals). This snapshot records the exact inputs that
// determine those bytes and the placeholder-vs-active decision, so tiles 2..N
// reuse one prepared `GPUBindGroup`. The memo lives on the CONTEXT (not the
// per-GPUDevice renderer instance): post-Sol multi-context work shares pooled
// devices across Scenes, so a renderer-scoped memo keyed by frameNumber alone
// would alias Scene A's camera bytes into Scene B (see the same rationale in
// `WebGPUEffectsBindGroup.js` `_ensureEffectsBgCache`, and the primitive
// precedent `_getOrCreateSharedPrimitiveEffectsBG`).
interface GlobeEffectsHandleSnapshot {
  frameNumber: number;
  device: GPUDevice;
  bindGroup: GPUBindGroup;
  // Reference identity of every resolved effect input (undefined when the
  // feature is inactive). Any ref mismatch → miss → fresh prepare.
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
  // Camera position VALUES (not the mutated-in-place scratch Cartesian3 ref):
  // the clip-plane dPrime bytes depend on them, and a multi-view frame can
  // reuse one frameNumber across different cameras.
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
  // Public underscore: shared with the shader factory (Batch 146).
  public _device: GPUDevice | null = null;
  private _diagTileCount = 0;
  private _diagLastLogTime = 0;
  // Public underscore: the next 3 diag-throttle fields are shared with
  // the tile-UB packer (Batch 153).
  public _diagLastLayerCountLogMs = 0;
  public _diagLastFogLogMs = 0;
  public _diagFogMissingLogged = false;
  private _lastOverflowWarnTime = 0;

  /**
   * Throttle diagnostic logs to once per 3 seconds AND only the first tile.
   * In production builds (`removePragmas: true`), this method is replaced
   * with a constant `false` return by the pragma stripper, so the
   * diagnostic code at each call site is dead-code-eliminated by esbuild.
   */
  // Public underscore: shared with the texture-cache helpers (Batch 148).
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
  // BUG-11 imagery probe — last observed value of `frameState.debugShowImageryProbe`,
  // used to detect the rising edge so the probe latch resets when the
  // operator toggles the flag back on for a second sample.
  private _lastProbeFlag = false;
  // C-R7-RENDERER-MIGRATION (Batch 75) — local Map now stores
  // `GlobePipelineEntry` slots; the GPU pipeline materializes through
  // `webgpuPipelineCache` so two GlobeSurfaceRenderer instances (split-
  // screen, multi-viewer) sharing the same descriptor share one
  // `GPURenderPipeline`.
  // Public underscore: shared with the pipeline helpers (Batch 150).
  public _pipelineCache: Map<string, GlobePipelineEntry> = new Map();
  // Central pipeline cache reference, captured lazily on the first
  // `createTileCommands` call (which has access to `frameState.context`).
  // Stays null when the renderer's GraphicsContext doesn't expose one
  // (WebGL fallback shouldn't reach this code path, but defensive).
  // Public underscore: shared with the pipeline helpers (Batch 150).
  public _centralPipelineCache: WebGPURenderPipelineCache | null = null;
  // Batch 20 — the production shader module is now resolved through the
  // `WebGPUShaderModuleCache` keyed by `(ShaderSourceId.GLOBE_TERRAIN, defines)`.
  // The cache runs the `//>>ifdef` preprocessor against `_shaderCode` on
  // first use per define-set and deduplicates repeat requests. Prewarmed at
  // `initialize()` time with the common define sets so first-frame render
  // pays no shader-compile cost.
  // Public underscore: shared with the shader factory (Batch 146).
  public _shaderModuleCache: WebGPUShaderModuleCache | null = null;
  // Source preserved so we can lazily augment it with debug fragment
  // entry points (triangulation / LOD overlay / normal-as-color) and the
  // hardware clip-distances variant. Consumers run the preprocessor on
  // this raw source before creating derived modules.
  // Public underscore: shared with the shader factory (Batch 146).
  public _shaderCode: string = "";
  // Debug fragment augmented modules, keyed by active-defines bitmask. A
  // `null` value means the device rejected the augmented source for that
  // define-set during the one-shot validation probe — subsequent lookups
  // return null and the caller falls back to the production fragment.
  // Public underscore: shared with the shader factory (Batch 146).
  public _debugFragmentShaderModules = new Map<
    number,
    GPUShaderModule | null
  >();
  // Public underscore: shared with the pipeline helpers (Batch 150).
  public _debugFragmentPipelineCache: Map<string, GlobePipelineEntry> =
    new Map();
  // C2-25 ENV-SCENE-CAPTURE (Batch 446) — SEPARATE cache for single-target
  // scene-capture pipeline variants (keyed on face format + CAPTURE_MODE +
  // vertex shape). Deliberately NOT wiped by the
  // `_scenePipelineFormatGeneration` reset in `createTileCommands` — the
  // capture target format follows the env cube, not the canvas, so a
  // canvas-format / MSAA flip must not invalidate it; and a capture build must
  // not bump the on-screen generation (which would rebuild every on-screen
  // globe pipeline each frame capture runs). Public underscore: shared with the
  // capture-pipeline helper.
  public _capturePipelineCache: Map<string, GlobePipelineEntry> = new Map();
  // Phase 5 WGF-1: hardware clip-distances shader variant. Built lazily
  // by string-augmenting a preprocessed `_shaderCode` to (a) declare the
  // `@builtin(clip_distances)` vertex output and (b) compute it from the
  // precomputed `effects.clipPlaneEqHW` values. The fragment-side
  // `globeClipByPlanes` discard is neutralized in the augmented source so
  // the rasterizer is the sole authority. Probed once per active-defines
  // set; cached forever. `null` value after probe means the device
  // rejected the augmented source (driver bug or missing feature) and the
  // production module is the fallback.
  // Public underscore: shared with the shader factory (Batch 146).
  public _clipDistancesShaderModules = new Map<
    number,
    GPUShaderModule | null
  >();
  // Public underscore: the next 11 fields are shared with the layouts
  // initializer (Batch 147). The renderer reads them every frame and
  // clears them in `destroy()`; the helpers in `WebGPUGlobeSurfaceLayouts.ts`
  // populate them once at init time.
  public _sampler: GPUSampler | null = null;
  public _waterMaskSampler: GPUSampler | null = null;
  public _bindGroupLayout0: GPUBindGroupLayout | null = null;
  public _bindGroupLayout1: GPUBindGroupLayout | null = null;
  public _bindGroupLayout2: GPUBindGroupLayout | null = null;
  // Group 3 is now the effects bind group (merged water+ocean into group 2)
  public _effectsBGL: GPUBindGroupLayout | null = null;
  public _placeholderEffectsBG: GPUBindGroup | null = null;
  public _oceanNormalSampler: GPUSampler | null = null;
  // Batch 437 (CLOUD-SHADOWS) — the sun-view beer shadow map view + sampler to bind
  // at group 2 / bindings 9-10 this frame. Captured each frame from
  // `context._cloudCache` in `createTileCommands`; null → the group-2 bind group
  // uses the renderer's own 1×1 placeholder (`_placeholderView` + `_sampler`,
  // optical depth/white → transmittance 1). Their identity is folded into the
  // group-2 bind-group cache key so a real-vs-placeholder swap rebuilds the group.
  private _cloudShadowView: GPUTextureView | null = null;
  private _cloudShadowSampler: GPUSampler | null = null;
  private _oceanNormalMapCache: Map<string, ImageryGPUTexture> = new Map();
  // PERF-OCEAN-NORMAL-REUPLOAD (2026-07-19) — `uploadImageSource` only WRITES
  // to the cache map it is handed; it never reads it, and its shared-
  // realization dedupe is gated on `logicalOwner === "imagery"`, which the
  // ocean-normal call site does not pass. Without this source-identity guard
  // the normal map was re-uploaded (copyExternalImageToTexture + mip regen +
  // createView) once per tile per frame on a static scene — and because the
  // group-2 bind-group cache keys on view identity, a fresh view each call
  // also forced a createBindGroup every frame. Same idiom as
  // `_materialTextureCache` below.
  private _oceanNormalMapSource: unknown = null;
  private _oceanNormalMapView: GPUTextureView | null = null;
  public _pipelineLayout: GPUPipelineLayout | null = null;
  // Session 65 Cluster 3 — material lives at @group(2) bindings 4-8
  // (UBO + image texture/sampler + heights texture/sampler). The
  // merged-group strategy keeps total bind groups at 4 so devices that
  // report the WebGPU spec floor of `maxBindGroups: 4` (e.g., Edge on
  // some adapters) can still use the material pipeline path. No
  // separate material pipeline layout — the regular `_pipelineLayout`
  // is reused with a wider Group 2 layout.
  // Placeholder UBO bound at @group(2) @binding(4) when no material is
  // active, so the bind group still validates against the expanded
  // Group 2 layout. Lazy-initialized on first non-material draw.
  private _placeholderMaterialUBO: GPUBuffer | null = null;
  // Per-material cache. Keyed by `material.type` since (a) the WGSL
  // source is determined by the fabric (which is associated with the
  // type) and (b) Cesium's `MaterialCache` already deduplicates per-type.
  // Entry holds the assembled WGSL, the shader module, the UBO + its
  // layout, and a sub-cache of GPURenderPipelines keyed on the geometry
  // variant (one pipeline per stride/quantized/blend/etc combination).
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
  // NEW-GLOBE-BELOWSURFACE-FIX — 1×1 r8unorm ZERO fallback bound at
  // @group(2) @binding(0) when a tile's water mask isn't GPU-resident.
  // The white shared placeholder read as waterMask=1.0 (all water) and
  // ocean-shaded whole land tiles; zero = all land matches WebGL.
  public _noWaterMaskTexture: GPUTexture | null = null;
  public _noWaterMaskView: GPUTextureView | null = null;
  // Public underscore: shared with the wireframe helpers (Batch 149).
  public _canvasFormat: GPUTextureFormat = "bgra8unorm";
  // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — the globe pick pipeline's color
  // target format, mirrored from `context.pickPipelineFormat` (the sole
  // byte-object-ID attachment authority) whenever the scene-format
  // generation bumps. Equals `_canvasFormat` in SDR; stays an 8-bit unorm
  // when the scene target flips to a float/HDR format.
  public _pickFormat: GPUTextureFormat = "rgba8unorm";
  // Session 65 Batch 32 — MSAA sample count tracked alongside format.
  // Captured from `context._msaaSamples` on each `maybeUpdateForScene
  // Format` call (mirrors `_canvasFormat`). Used by `PipelineHost`
  // consumers to bake `multisample.count` into globe pipelines. The
  // shared `_scenePipelineFormatGeneration` counter also bumps on
  // MSAA change (see `WebGPUSceneRenderer.prepareFrame` Batch 25),
  // triggering this renderer's pipeline cache wipe at the same point.
  public _sampleCount: number = 1;
  // Renderer-wide log-depth state, resolved each frame from the SHARED gate
  // `isWebGPULogDepthActive(context, frameState)` = the `_logDepthWriteEnabled`
  // master switch AND `frameState.useLogDepth`, so `buildPipelineDescriptor`
  // (via `host._logDepthEnabled`) ORs the `LOG_DEPTH` shader define into the
  // globe pipeline's defines + cache key on exactly the frames every sibling
  // producer does.
  //
  // NEW-WEBGPU-GLOBE-USE-LOG-DEPTH — this used to mirror
  // `context._logDepthWriteEnabled` ALONE, making the globe the only WebGPU
  // depth producer that ignored `frameState.useLogDepth`. `Scene.js` clears
  // that flag on any orthographic frustum (2D / Columbus View /
  // `camera.switchToOrthographicFrustum()`) and whenever
  // `scene.logarithmicDepthBuffer` is false, so in those modes the globe wrote
  // LOG-encoded `frag_depth` into the same attachment the classifiers, the
  // enhanced-ocean depth test and the depth plane read as hyperbolic — mixed
  // encodings in one buffer. Under a pure orthographic frustum the log encode
  // also degenerates (clip `.w` is constant, so `csm_vertexLogDepth` collapses
  // to a per-draw constant, and it is NaN when near > 2.0).
  public _logDepthEnabled: boolean = false;
  // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — SEPARATE pick-fleet state,
  // resolved from `isWebGPUPickLogDepthActive(context, frameState)` (the
  // `_pickLogDepthWriteEnabled` master switch AND `frameState.useLogDepth`).
  // The globe PICK pipeline (selectPickPipeline) ORs LOG_DEPTH from THIS flag
  // (not `_logDepthEnabled`) into its pick-pipeline cache key. The pick
  // mini-frame owns ONE shared depth attachment (INV-2), so the whole fleet
  // must be uniformly hyperbolic OR log — and every sibling pick producer drops
  // to hyperbolic when `useLogDepth` is false, so the globe must too.
  public _pickLogDepthEnabled: boolean = false;
  // C11-158 (NEW-WEBGPU-ENHANCED-OCEAN-DEFAULT-PARITY-TOGGLE) — renderer mirror
  // of `Globe.enableEnhancedOcean` (default FALSE). When true, the globe shader
  // factory ORs `ShaderDefineHi.ENHANCED_OCEAN` into `definesHi` (via
  // `host._enhancedOceanEnabled`), selecting the enhanced ocean STYLING branch
  // of `computeEnhancedOcean`; false compiles the classic WebGL-parity branch.
  // Only the STYLING is gated — the shared wave march is unconditional. Set
  // each frame from the tile provider (which `Globe.render` copies the flag
  // onto) via `_applyEnhancedOceanState`, which wipes the renderer-local globe
  // pipeline caches on a flip so the module + pipeline re-resolve.
  public _enhancedOceanEnabled: boolean = false;
  // Batch 110 — track scene-pipeline format generation last applied
  // so a runtime HDR / canvas-format change clears the pipeline +
  // wireframe + debug-fragment caches and rebuilds against the new
  // scene FB color format.
  private _scenePipelineFormatGeneration: number = -1;

  // NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT (Batch 246) — per-device
  // imagery slot count (16 full / 4 reduced) and the matching
  // `GLOBE_IMAGERY_REDUCED` shader-define flag. Captured ONCE at
  // `initialize()` from `device.limits.maxSampledTexturesPerShaderStage`
  // (a device's limits are immutable, so this never flips at runtime).
  // Drives: group-1 BGL width (WebGPUGlobeSurfaceLayouts), the WGSL
  // variant (via the define bit ORed into every pipeline's defines),
  // the bind-group-1 entry count, and the CPU multi-pass slicing width
  // in `createTileCommands`.
  // Public underscore: shared with the layouts initializer + the shader/
  // pipeline/wireframe helper modules (same convention as Batches 142–153).
  public _imagerySlotCount: number = MAX_IMAGERY_LAYERS;
  public _imageryReduced: boolean = false;

  // Wireframe pipelines — keyed by the same shape string used by
  // _selectPipeline so they share variant granularity (Q/U, N/X, M/G, stride).
  // Lazily built on first wireframe request; production cache is untouched.
  // Public underscore: shared with the wireframe helpers (Batch 149).
  public _wireframePipelineCache: Map<string, GlobePipelineEntry> = new Map();
  public _wireframeIndexCache: Map<
    string,
    { buffer: GPUBuffer; count: number; format: GPUIndexFormat }
  > = new Map();

  // NEW-GLOBE-BINDGROUP-CACHE (Batch 241) — per-tile bind-group cache
  // keyed on bound-resource identity. Groups 0/1/2 route through it;
  // group 3 (effects) has its own cache in `WebGPUEffectsBindGroup.js`
  // (C-R11, Batch 55). Stats readable via
  // `CesiumDebug.globeBindGroups()` / `globalThis.__webgpuGlobeBindGroupCache`.
  private _bindGroupCache: WebGPUGlobeBindGroupCache =
    new WebGPUGlobeBindGroupCache();
  // C12-29 S5 — one dedicated 64-byte carrier per logical View/frame.
  // Active payloads are ring-allocated once and shared by every tile/pass;
  // inactive frames bind one stable renderer-owned inert buffer.
  private _eclipseUniforms = new WebGPUGlobeEclipseUniforms();

  // Per-tile GPU resource caches
  // Public underscore: shared with the tile-buffer helpers (Batch 151).
  public _tileBufferCache: Map<string, TileGPUResources> = new Map();
  // Public underscore: imagery + water-mask caches are shared with the
  // texture-cache helpers (Batch 148).
  public _imageryTextureCache: Map<string, ImageryGPUTexture> = new Map();
  public _waterMaskTextureCache: Map<string, ImageryGPUTexture> = new Map();
  // C9-12A (hardened Batch 686) — per-renderer (= per-pooled-GPUDevice, NOT
  // per-context: two viewers on one device share this renderer and this table)
  // shared imagery realization table, plus the CURRENT frame's context used for
  // frame-owned mip prep + deferred texture retirement. Both are populated each
  // frame from `createTileCommands` (the only site with `frameState.context`);
  // imagery uploads only occur from that path so they are set before
  // `uploadImageSource` runs. `_webgpuContext` always tracks the most recent
  // live context; the table never captures one (F0b). Rebuilt on a
  // device-generation change so GPU handles never cross devices.
  public _sharedImageryRealizations: WebGPUSharedImageryRealizations | null =
    null;
  public _webgpuContext: ImageryRealizationContext | null = null;
  // F4 (Batch 686) — frameNumber edge detector so the realization-table sweep
  // runs once per frame, not once per tile (createTileCommands is per-tile).
  private _lastRealizationSweepFrame = -1;
  // C9-01 — opt-in logical allocation/cache attribution. The performance
  // runner installs this object before Cesium loads only in its separately
  // instrumented lane. Clean/production runs retain null and allocate no
  // diagnostics state.
  public _logicalCounters: WebGPUGlobeLogicalCounters | null = null;

  // Reusable typed arrays for uniform data
  // Public underscore: shared with the camera-UB packer (Batch 152).
  public _cameraUniformData: Float32Array = new Float32Array(
    CAMERA_UNIFORM_FLOATS,
  );
  // Scratch for projection × modifiedModelView (column-major Float64).
  // 2D/CV/Morphing paths in the vertex shader use this matrix instead of
  // mvpRelativeToEye, since their positions are planar (not RTE).
  // Public underscore: shared with the camera-UB packer (Batch 152).
  public _cameraMvpScratch: Float64Array = new Float64Array(16);
  // Public underscore: shared with the tile-UB packer (Batch 153).
  public _tileUniformData: Float32Array = new Float32Array(TILE_UNIFORM_FLOATS);
  // Public underscore: shared with the tile-UB packer (Batch 153).
  public _tileUniformU32View: Uint32Array;

  private _isDestroyed: boolean = false;
  private _isInitialized: boolean = false;
  // Last context this renderer published its per-frame effects memo onto
  // (Batch 677 `_globeEffectsHandle`). Captured so `destroy()` can drop the
  // memo, which otherwise pins a bind group + shadowMap/clipping/tileProvider
  // for the context's lifetime. Null until the first effects prepare.
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
   * Cache shape: per-material-type entry holds the assembled WGSL
   * source, the compiled shader module, the UBO buffer + layout, and a
   * sub-cache of GPURenderPipelines keyed on the geometry variant.
   * Switching `globe.material` types pays a one-time pipeline build per
   * geometry variant the first time the new material renders.
   *
   * Cluster 3 / Step 5 (Session 65 Batch 11 — final integration).
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
      // Preprocess with MATERIAL_APPLY set so the `//>>ifdef`-gated
      // material call site + group(4) bindings are included. Batch 246:
      // the reduced-imagery bit must ride along — on a default-limit
      // device the material module would otherwise declare all 16
      // dayTextures and mismatch the 1-slot group-1 layout.
      const preprocessed = preprocessWGSL(
        fullSource,
        ShaderDefine.MATERIAL_APPLY |
          (this._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0),
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

    // Geometry variant key — the same grammar as the base pipeline cache key
    // minus the debug-fragment and translucent-back-face axes (those variants
    // don't currently route through the material path) and minus
    // clip-distances, which the material path never requests. Built through
    // the shared key module rather than inline: this map was a FIFTH private
    // copy of the format, i.e. the same latent defect that left the four
    // pipeline accessors reading a key shape the producer had abandoned.
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

    // NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT (Batch 246) — resolve the
    // per-device imagery slot count BEFORE the shader cache (prewarm
    // needs the define bit) and the bind-group layouts (group 1 width).
    this._imagerySlotCount = computeGlobeImagerySlotCount(device.limits);
    this._imageryReduced = this._imagerySlotCount < MAX_IMAGERY_LAYERS;
    if (this._imageryReduced) {
      // PERMANENT (not debug-pragma'd) — a degraded layout on a real
      // user device is something a bug report needs to show.
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

    // NEW-GLOBE-BINDGROUP-CACHE (Batch 241) — publish the bind-group
    // cache for `CesiumDebug.globeBindGroups()` and the regression
    // probe. Last-initialized renderer wins (same convention as
    // `__webgpuGlobeFragmentDebugRegistry`); split-screen debug reads
    // the most recent device's cache, which is the common case.
    (
      globalThis as { __webgpuGlobeBindGroupCache?: WebGPUGlobeBindGroupCache }
    ).__webgpuGlobeBindGroupCache = this._bindGroupCache;
    // NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT (Batch 246) — publish the
    // resolved slot count for probe-globe-default-limits.mjs and
    // CesiumDebug introspection (same last-initialized-wins convention).
    (
      globalThis as { __webgpuGlobeImagerySlotCount?: number }
    ).__webgpuGlobeImagerySlotCount = this._imagerySlotCount;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  // ─── Shader Module Cache ─────────────────────────────────────────
  // Bodies live in `WebGPUGlobeSurfaceShaders.ts` (Batch 146). These methods
  // are 1-line delegators kept on the class for call-site stability.

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
   * C11-158 (NEW-WEBGPU-ENHANCED-OCEAN-DEFAULT-PARITY-TOGGLE) — apply the
   * current `Globe.enableEnhancedOcean` state (mirrored onto the tile provider
   * each frame) to the renderer. On a FLIP, the enhanced ocean STYLING branch
   * of `computeEnhancedOcean` swaps in/out via the `ShaderDefineHi.ENHANCED_OCEAN`
   * hi-word define. The shader-module cache keys by `definesHi`, so it serves
   * the correct module on its own — but the renderer-local pipeline caches key
   * WITHOUT the hi word (only the central cache keys on the descriptor name,
   * which now carries an `enhOcean` label), and the clip-distances module map
   * keys by the lo defines only. So a flip must wipe those to force a
   * keyed-miss rebuild that re-resolves the module + pipeline — no reload
   * needed. Idempotent: returns immediately when the state is unchanged (the
   * common per-frame case), so the wipe fires only on the rare toggle.
   *
   * Called from BOTH `createTileCommands` (on-screen) and
   * `getOrCreateCaptureTileCommands` (env-map capture) — whichever runs first
   * in a frame wipes ALL globe pipeline caches, so the ordering between the two
   * (capture runs before `globe.render`) never leaves a stale cache behind.
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
    // The clip-distances MODULE map keys by the lo defines only; wipe it so the
    // next lookup rebuilds its base against the new `definesHi`.
    this._clipDistancesShaderModules.clear();
  }

  // ─── Bind Group Layouts, Pipeline Layout, Samplers, Placeholder Texture
  // Bodies live in `WebGPUGlobeSurfaceLayouts.ts` (Batch 147). Each helper
  // is invoked once from `initialize()`; no class-level wrappers remain.

  // ─── Render Pipelines / Pipeline Selection ───
  // Bodies for `buildPipelineDescriptor`, `descriptorToGPU`,
  // `resolveGlobePipelineEntry`, `selectPipeline`, and
  // `selectDebugFragmentPipeline` live in
  // `WebGPUGlobeSurfacePipelines.ts` (Batch 150). Callers in this file
  // invoke the helpers directly with `this` as the host.

  // ═══════════════════════════════════════════════════════════════════════
  // Tile Command Creation
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * C9-13 (NEW-GLOBE-EFFECTS-PER-VIEW-PREPARED-HANDLE) — resolve and pack the
   * terrain-global group-3 effects bind group ONCE per (context, frame/view).
   *
   * The shadow-receive / CSM / atmosphere-LUT / clipping-planes+polygons state
   * is identical for every selected tile and every imagery pass in a frame, so
   * the body below (moved verbatim from the old per-tile-per-pass inline block)
   * runs at most once; subsequent tiles/passes take the memo fast-path (a few
   * reference/scalar compares) and reuse the prepared `GPUBindGroup`.
   *
   * The memo is stored on the CONTEXT, not on this per-GPUDevice renderer
   * instance: pooled devices are shared across contexts post-Sol, so a memo
   * keyed by frameNumber on a device-shared renderer would alias Scene A's
   * camera bytes into Scene B. Any input mismatch falls through to a fresh
   * prepare (campaign rule 3: unknown ⇒ conservative execution).
   */
  private _getOrCreateFrameEffectsBindGroup(
    device: GPUDevice,
    frameState: CesiumFrameState,
    tileProvider: CesiumGlobeTileProvider,
    uniformState: CesiumUniformState,
  ): GPUBindGroup {
    // Phase 4 AtmosphereLUT integration: when the scene has an
    // atmosphere LUT ready (compute supported + SkyAtmosphere has
    // dispatched the LUT compute pass at least once), we route
    // through the active bind group builder to pass the LUT views
    // into bindings 7/8 of the effects BGL. The globe shader reads
    // those to compute fog color that matches the visible sky dome.
    // If neither clipping nor LUT is present we still take the
    // placeholder fast-path.
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
    const receivesShadows =
      shadowModeRuntime.receiveShadows(tileProvider.shadows) &&
      frameState.globeTranslucencyState?.translucent !== true;
    const receiveShadowMap =
      receivesShadows &&
      shadowState?.lightShadowsEnabled &&
      shadowState?.lightShadowMaps?.[0]
        ? shadowState.lightShadowMaps[0]
        : undefined;

    // CSM Slice 1 — resolve the context's cascaded shadow map renderer
    // when the scene has asked for cascades and the renderer has
    // initialized a cascade texture array. We pass the params UBO +
    // array view into the effects bind group so the shader's shadow
    // branch can route through `sampleCascadeShadow` (binding 10/11)
    // instead of the single-map path (binding 1/2).
    //
    // The ambient `csmRenderer: object | null` on the context is
    // intentionally opaque (cesium-js-types.d.ts keeps this file free
    // of WebGPU-renderer imports). Narrow it here to the local shape
    // we actually consume.
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
            // NEW-CSM-SOFT-SHADOW-PCF — soft-shadow kernel radius (texels).
            pcfRadius: csmCandidate.pcfRadius,
          }
        : undefined;

    // GLOBE-CLIPPOLY-GEODETIC — `globe.clippingPolygons`. Mirrors the
    // model renderer's gate: only an enabled, non-empty collection
    // activates the polygon SDF path (`effects.clippingPolygonCount`).
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

    // ── Memo fast-path ──────────────────────────────────────────────
    // Reuse the prepared handle only when EVERY input that determines the
    // packed bytes or the placeholder decision is unchanged. Ordered
    // cheapest-first: frameNumber (changes every tick) → device → refs →
    // camera values. `frameNumber` is read raw and a missing value disables
    // memoization (a `?? 0` fallback would alias distinct frames — queue
    // audit P1 #14). The memo is context-scoped (T1 pooled-device hazard).
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

    // ── Fresh prepare ───────────────────────────────────────────────
    // The active-vs-placeholder gate: any active effect routes through the
    // real bind group builder; otherwise the per-device placeholder is
    // returned (byte-identical zero-filled effects UBO). `useClipDistances`
    // from the per-pass loop is intentionally NOT a term here — it requires
    // `clippingPlanes.length > 0`, so it can never widen this condition
    // beyond the `clippingPlanesLength > 0` term (provably byte-equal).
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
      // Toggle-off transition: storing the placeholder here (not leaving the
      // stale active handle) means the next tile after shadows/CSM/LUT turn
      // off binds zero-filled effects data rather than last frame's control
      // bytes (the `WebGPUPrimitiveCommands._getOrCreateSharedPrimitiveEffectsBG`
      // lesson).
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
    // context's lazy getter only constructs the allocator on first access,
    // and `context.beginFrame()` only calls `beginFrame()` on the allocator
    // when it already exists. Without this touch the allocator would never
    // initialize and BUG-9's per-frame buffer leak would re-emerge.
    void frameState.context?.uniformAllocator;

    // C9-12A (hardened Batch 686) — plumb the shared imagery realization table
    // + the CURRENT frame's context for uploads. The table stores no context
    // closure (F0b): destruction routes through a scheduleDestroy callback
    // supplied at each call from the live `realizationContext`, so a viewer
    // teardown never pins a dead context's destroy queue while the pooled
    // device stays live for another viewer.
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
          // F6 — the `table.device !== device` arm is DEFENSIVE ONLY: this
          // renderer is constructed per pooled GPUDevice and `_device` is
          // written once at initialize, so with the current outer plumbing the
          // mismatch cannot occur. It is kept (cheap) so a future change to
          // the renderer pooling fails safe (rebuild) instead of serving
          // stale-device textures.
          if (table !== null) {
            table.destroyAll((t) =>
              realizationContext.scheduleTextureDestroy(t),
            );
          }
          this._sharedImageryRealizations = new WebGPUSharedImageryRealizations(
            device,
          );
        }
        // F4 — sweep once per frame (not per tile): createTileCommands is a
        // per-tile call site, so gate on the scene's frameNumber. The number
        // is used ONLY as an edge detector — the table keeps its own internal
        // clock (F0a), so two scenes sharing this renderer each tick the sweep
        // clock once per their frame (faster wall-clock aging = the safe
        // direction), with no cross-scene stamp mixing.
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

    // Batch 437 (CLOUD-SHADOWS) — capture the sun-view beer shadow map view +
    // sampler from the procedural cloud renderer's cache for the group-2 bind
    // group. The cloud renderer runs AFTER the globe terrain pass, so this reads
    // LAST frame's map (one frame late — fine for a slow, soft cloud shadow). When
    // the feature is off (the default) the cache has no real shadow view, so null
    // here → the bind group falls back to the renderer's 1×1 placeholder
    // (transmittance 1, no shadow) → byte-identical.
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
      // CLOUD-LOD-R5 — the opt-in cascade tier binds the 3-cascade atlas at
      // binding 9 (same texture_2d type; the FS reads it via the cascade branch
      // gated on cloudShadowControl.w). Aerial/fog consumers keep reading the
      // single map, which is still rendered alongside the atlas.
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

    // C-R7-RENDERER-MIGRATION (Batch 75) — capture the central pipeline
    // cache from the context. The select methods consult `this._centralPipelineCache`
    // to dedupe pipelines across renderer instances. Captured here (not in
    // `initialize()`) because `initialize()` only receives `device`,
    // not `context`.
    if (!this._centralPipelineCache) {
      this._centralPipelineCache =
        (
          frameState.context as unknown as {
            webgpuPipelineCache?: WebGPURenderPipelineCache | null;
          }
        ).webgpuPipelineCache ?? null;
    }

    // Batch 110 — invalidate cached pipelines when the scene-pipeline
    // format generation has changed (HDR toggle, MSAA toggle). Globe
    // terrain pipelines target the scene FB, so they must rebuild
    // against the new color format. Clears production, wireframe,
    // and debug-fragment caches.
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
      // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — mirror the context's pick
      // format authority alongside the scene format. The cache wipe below
      // drops any pick pipeline built against the previous format.
      this._pickFormat =
        (
          frameState.context as unknown as {
            pickPipelineFormat?: GPUTextureFormat;
          }
        ).pickPipelineFormat ?? "rgba8unorm";
      // Session 65 Batch 32 — capture MSAA sample count alongside the
      // canvas format. The cache wipe below ensures pipelines created
      // before the change are dropped; new lookups pick up `_sampleCount`
      // via `buildPipelineDescriptor → host._sampleCount`.
      this._sampleCount =
        (frameState.context as unknown as { _msaaSamples?: number })
          ._msaaSamples ?? 1;
      this._pipelineCache.clear();
      this._wireframePipelineCache.clear();
      this._debugFragmentPipelineCache.clear();
    }

    // NEW-WEBGPU-GLOBE-USE-LOG-DEPTH — resolve the log-depth state from the
    // SHARED gate every frame (independent of the ctxGen guard above), so the
    // globe's encoding tracks `frameState.useLogDepth` exactly like the model /
    // primitive / collection producers that share the depth attachment. No
    // cache wipe is needed on a flip: the renderer-local key ends in
    // `|${defines.toString(16)}` (which carries the LOG_DEPTH bit) and the
    // central key carries the `, ld=1` descriptor-name marker, so both caches
    // rebuild through a normal keyed miss.
    this._logDepthEnabled = isWebGPULogDepthActive(
      frameState.context,
      frameState,
    );
    // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — the SEPARATE pick-fleet gate,
    // so selectPickPipeline compiles its LOG_DEPTH module from it (its pick
    // cache key includes the define → the flip rebuilds via keyed miss).
    this._pickLogDepthEnabled = isWebGPUPickLogDepthActive(
      frameState.context,
      frameState,
    );

    // C11-158 — mirror `Globe.enableEnhancedOcean` (copied onto the tile
    // provider each frame by `Globe.render`) so the globe shader factory picks
    // the enhanced vs classic ocean STYLING module. Default false = classic
    // WebGL-parity water. A flip wipes the globe pipeline caches (see
    // `_applyEnhancedOceanState`) so it takes effect without a reload.
    this._applyEnhancedOceanState(tileProvider.enableEnhancedOcean ?? false);

    const device = this._device;
    const mesh = surfaceTile.renderedMesh || surfaceTile.mesh;
    if (!mesh) return null;

    // NEW-GLOBE-BINDGROUP-CACHE (Batch 241) — per-frame tick (no-ops
    // when called again for subsequent tiles in the same frame). Rolls
    // the per-frame stat counters and runs the periodic age eviction.
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

    // Determine number of passes needed. Pass width is the per-device
    // imagery slot count — 16 on full-layout adapters, 1 on default-
    // limit adapters (NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT, Batch 246),
    // so reduced devices render N layers as N blend passes.
    const imagerySlots = this._imagerySlotCount;
    const totalLayers = readyLayers.length;
    const passCount = Math.max(1, Math.ceil(totalLayers / imagerySlots));
    const commands: TileDrawDescriptor[] = [];
    if (logicalCounters) {
      logicalCounters.readyLayers =
        (logicalCounters.readyLayers ?? 0) + totalLayers;
      logicalCounters.commandArrays = (logicalCounters.commandArrays ?? 0) + 1;
    }

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

    // C-R1-GLOBE-RENDERSTATE (Batch 99) — derive cull-on/off from the
    // same gates WebGL uses in
    // `GlobeSurfaceTileProviderRendering.js:1224-1225`:
    //   backFaceCulling = tileProvider.backFaceCulling
    //                  && !cameraUnderground
    //                  && !globeTranslucencyState.translucent
    // Inverted: disable culling when underground OR translucent OR the
    // provider has back-face culling explicitly off. The runtime variant
    // selection feeds into `_selectPipeline`'s `disableCulling` flag.
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
    // NEW-GLOBE-TRANSLUCENCY-MULTI-PASS (Batch 182) — split the
    // disable-culling decision. Underground / provider-disabled-culling
    // still want cullMode: "none" (single-pass both-faces). But
    // globeTranslucent now wants the 3-pass technique:
    //   1. Depth-only back-face (Batch 177, cullMode: "front")
    //   2. Translucent back-face (NEW Batch 182, cullMode: "front", blend ALPHA)
    //   3. Translucent front-face (existing, but now cullMode: "back" via
    //      `disableCulling: false`, instead of cullMode: "none").
    // Camera-underground takes precedence over translucent — if both
    // are true, use single-pass both-faces (the user's primary intent
    // is "see through the globe").
    const disableCulling = !providerCullEnabled || cameraUnderground;

    // C12-29 S5 — terrain-global for this logical View/frame. `prepare`
    // returns a memoized active ring slice, or the stable inert slice without
    // allocating/uploading on ordinary frames. Every tile and imagery pass
    // binds this same carrier; only camera/tile UBs remain per-pass.
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

      // C-R7-RENDERER-MIGRATION (Batch 75) — `_select*` now returns
      // `GPURenderPipeline | null`. Null means the pipeline is still
      // materializing in the central cache; we `continue` to skip this
      // pass for this tile this frame. The same defines × stride × format
      // tuple resolves once and stays cached for the lifetime of the
      // device, so the skip only ever fires on the first frame a new
      // variant appears.
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
        // Cold path: try the debug fragment variant; gracefully fall back
        // to the production pipeline if the device can't compile the
        // augmented module (driver missing primitive_index, etc.).
        // The debug fragment + clip-distances combination is intentionally
        // unsupported — the debug variants don't share the augmented
        // VertexOutput. Fall through to the production module.
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
        // GLOBE-TRANSLUCENCY-ALPHA — when the globe is translucent, the
        // front-face color command MUST use the ALPHA-blend pipeline
        // variant (blend src-alpha/one-minus-src-alpha, depth-write off),
        // matching WebGL's `getTranslucentFrontFaceRenderState`
        // (BlendingState.ALPHA_BLEND + depthMask false). Previously only
        // subsequent imagery passes selected the blend variant, so the
        // first-pass translucent front-face rendered OPAQUE and the
        // per-fragment alpha from the FS was discarded by the pipeline —
        // an enabled translucent globe still composited fully opaque.
        // The depth-only back-face pre-pass (Batch 177) still writes the
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
        continue;
      }

      // ─── Cluster 3 Step 5 — material pipeline override ───
      // When `globe.material` is set (mirrored onto tileProvider.material
      // by Globe.update), build/cache a material-augmented pipeline.
      // The material UBO + textures are bound through Group 2 alongside
      // water-mask / ocean-normal (merged-group strategy keeps total
      // bind-group count at the WebGPU spec floor of 4).
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

      // Group 3: Effects (shadow receive + CSM + atmosphere LUT + clipping).
      //
      // C9-13 — the entire effects group is terrain-global: its bytes and its
      // placeholder-vs-active decision are identical for every selected tile
      // and every imagery pass in this frame/view. Resolve and pack it ONCE
      // per (context, frame) in `_getOrCreateFrameEffectsBindGroup`; tiles
      // 2..N and passes 2..M reuse the prepared handle. See that method for
      // the full move of the LUT/shadow/CSM/clipping resolution + gate that
      // used to run inline here (per tile per pass).
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

      // GLOBE-UNDERGROUND-COLOR — skirt suppression parity. WebGL truncates
      // the draw count to `mesh.indexCountWithoutSkirts` when
      // `showSkirts = tileProvider.showSkirts && !cameraUnderground &&
      // !translucent` is false (GlobeSurfaceTileProviderRendering.js:1395-1396,
      // 1836-1839 — skirt indices sit at the tail of the index buffer, so a
      // count truncation drops exactly the skirt walls). WebGPU previously
      // always drew the full buffer, so underground views showed bright
      // untinted skirt stripes across the underside that WebGL never renders.
      // Wireframe keeps its own dedicated line-list IB (no skirt split there —
      // matches the debug-only intent).
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

      // NEW-GLOBE-TRANSLUCENCY-MULTI-PASS (Batch 177) — depth-only
      // back-face pre-pass for translucent globe rendering. Push BEFORE
      // the regular imagery-layer command so the scene-FB depth
      // attachment is populated with the FAR side of the globe (cullMode:
      // "front", depthWriteEnabled: true, colorWriteMask: 0) before the
      // single-pass alpha blend writes the near side over it. Without
      // the pre-pass, looking through the planet at antipodal terrain
      // produces inside-out z-fight artifacts in the alpha-blend.
      //
      // Gates:
      // - `globeTranslucent` — only when the user actually requested
      //   translucent globe rendering. Static-opaque rendering pays
      //   nothing (no extra pipeline, no extra command).
      // - `!isSubsequentPass` — once per tile, not once per imagery
      //   layer pass. Imagery layers blend over each other in
      //   subsequent passes; the depth pre-pass only needs to run for
      //   the first one.
      // - `!debugWireframe && debugFragmentMode === NONE` — debug
      //   variants own the pipeline entirely; pre-pass is suppressed
      //   so the debug visualization renders its own depth without the
      //   pre-emptive write affecting LOD / triangulation overlay
      //   visibility.
      // NEW-GLOBE-TRANSLUCENCY-MULTI-PASS (Batch 183 fix) — the 3-pass
      // technique is mutually exclusive with cameraUnderground. When the
      // camera is underground, `disableCulling` above already forces
      // cullMode: "none" on the regular color command (single-pass
      // both-faces — the user wants to see through the globe). Letting
      // the 3-pass fire as well would double-blend back-faces (depth-
      // only pre-pass + translucent back-face + translucent front-face
      // command running with cullMode: "none" instead of "back"). The
      // `!cameraUnderground` gate keeps the underground path on the
      // legacy single-pass behavior.
      // GLOBE-TRANSLUCENCY-ALPHA — the 3-pass see-through technique (depth-
      // only back-face pre-pass + translucent back-face) only applies when
      // the BACK faces are themselves translucent (backFaceAlpha < 1 or
      // backFaceAlphaByDistance). WebGL's `getDerivedCommandTypes`
      // (GlobeTranslucencyState.js:496-520) makes the same split: when the
      // back face is opaque (the default — backFaceAlpha = 1), it renders
      // DEPTH_ONLY_FRONT_FACE + OPAQUE_BACK_FACE (z-rejected behind the
      // front depth, base depth func LESS) + TRANSLUCENT_FRONT_FACE — the
      // net composite is JUST the alpha-blended front face over the
      // background. Running the back-face passes in that case blends the
      // globe underside into the destination, which WebGL never shows.
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

        // NEW-GLOBE-TRANSLUCENCY-MULTI-PASS (Batch 182) — translucent
        // back-face command. Emitted AFTER the depth-only pre-pass and
        // BEFORE the regular translucent front-face command (pushed at
        // line ~916 below). Sequence per tile when globeTranslucent:
        //   1. Depth-only back-face (Batch 177) — populates depth
        //   2. Translucent back-face (NEW Batch 182) — blends FAR side
        //   3. Translucent front-face (existing) — blends NEAR side over
        // The existing front-face command's cullMode flipped from
        // "none" to "back" via the disableCulling decision split above.
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

      // GLOBE-TRANSLUCENCY-ALPHA — opaque-back-face translucency (the
      // default: backFaceAlpha = 1, frontFaceAlpha < 1). Mirrors WebGL's
      // DEPTH_ONLY_FRONT_FACE derived command: the color command below runs
      // on the ALPHA-blend pipeline with depth-write OFF, so without this
      // pre-pass the scene depth would hold no globe surface at all — the
      // sky/atmosphere pass then floods the planet disk and later
      // depth-reading passes (depth plane, pickPosition) break. WebGL's
      // OPAQUE_BACK_FACE sibling command is intentionally NOT mirrored: with
      // WebGL's base depth func LESS it is z-rejected against this pre-pass
      // depth everywhere (equal depth), so its net contribution is nothing;
      // WebGPU's globe pipelines use less-equal, where emitting it WOULD
      // wrongly overwrite the destination with the globe underside.
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

      // Cluster 3 — material slots are merged into Group 2. When a
      // material is active, rebuild bindGroup2 with the material UBO +
      // textures included; otherwise the existing 4-binding water/ocean
      // group is padded with placeholders to match the expanded layout.
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

      // DP-H44 (Batch 360) — globe terrain pick pipeline. Select once for the
      // PRIMARY (first) pass only; the scene adapter attaches the resulting
      // pick command to that command's `derivedCommands.picking.pickCommand`
      // so the WebGPU pick pass dispatches it (writes globe depth + the
      // `camera.pickColor` tail into the pick FBO). The pick pipeline uses the
      // SAME vertex variant (so the same bind groups + VB line up) but
      // `fragmentPickMain`; it is independent of imagery-layer multi-pass /
      // debug / material (those vary only the FRAGMENT of the color path), so
      // subsequent imagery passes need no pick command. Null while the central
      // cache materializes the variant — pick is simply absent for one frame.
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
        shadowCastBindGroupCacheHost: gpuResources,
      });
    }

    if (logicalCounters) {
      logicalCounters.passDescriptors =
        (logicalCounters.passDescriptors ?? 0) + commands.length;
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

  // ═══════════════════════════════════════════════════════════════════════
  // Texture Management
  // ═══════════════════════════════════════════════════════════════════════

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
    // NEW-GLOBE-DYNAMIC-OFFSET-UBO (Batch 292) — the bind group is built
    // over the ring page at offset 0 (size = struct width). Its key is
    // ONLY the (camera page, tile page, eclipse page/buffer) identities — the
    // per-allocation byte offset is supplied per-draw as a dynamic
    // offset instead. Under camera motion the page identities cycle
    // through the ring's pageCount and recur every pageCount frames, so
    // the cache converges to ~pageCount group-0 entries and stays at
    // ~100% hit-rate even while the byte offsets shift each frame.
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
    // NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT (Batch 246) — entry count
    // follows the per-device group-1 layout width (16 full / 4 reduced).
    const imagerySlots = this._imagerySlotCount;

    for (
      let i = 0;
      i < passLayers.length && textureViews.length < imagerySlots;
      i++
    ) {
      const tileImagery = passLayers[i];
      if (!tileImagery || !tileImagery.readyImagery) continue;

      const imagery = tileImagery.readyImagery;
      // Batch 65 — pass the full tileImagery so the cache can pick the
      // Mercator or Geographic variant based on
      // `tileImagery.useWebMercatorT` and the per-imagery dual textures.
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

    // NEW-GLOBE-BINDGROUP-CACHE (Batch 241) — keyed on the per-slot view
    // identities. Views are stable per texture (created once, cached in
    // `_imageryTextureCache` next to their GPUTexture), so a key change
    // means the underlying texture actually rotated. The sampler is an
    // init-time singleton and stays out of the key.
    const cache = this._bindGroupCache;
    let key = "1";
    for (let i = 0; i < imagerySlots; i++) {
      key += `|${cache.idOf(textureViews[i])}`;
    }

    // Batch 58 (C-R5) / Batch 246: one texture binding per imagery slot
    // + the shared sampler at binding 16 (both layout shapes keep the
    // sampler there). Each entry pulls from `textureViews[i]` which is
    // padded with placeholder views above so unused slots still bind a
    // valid resource.
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

  // Session 65 Cluster 3 — wraps `_createWaterOceanBindGroup` to accept
  // optional material entry + material data. When provided, fills the
  // material UBO + texture slots (bindings 4-8); otherwise binds
  // placeholders so the bind group still matches the layout.
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
    // Fallback is the ZERO (all-land) mask, NOT the white placeholder —
    // white means "all water" to the shader (NEW-GLOBE-BELOWSURFACE-FIX).
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
      // NS-WEBGPU-OCEAN-BRIGHT-NO-WAVES — prefer `_webgpuSource` (the decoded
      // image Globe.js retains for us; the WebGL Texture drops `_source`/`image`
      // after upload, so those are undefined here in practice). Without this the
      // resolver fell through to the Texture object itself, failed the
      // instanceof gate below, and left the wave sampler on the 1×1 placeholder
      // → a flat, non-animating ocean.
      const source = onm._webgpuSource ?? onm._source ?? onm.image;
      if (
        source instanceof HTMLImageElement ||
        source instanceof ImageBitmap ||
        source instanceof HTMLCanvasElement
      ) {
        // PERF-OCEAN-NORMAL-REUPLOAD — reuse the previously uploaded view while
        // the underlying source object is unchanged. The ocean normal map is a
        // decoded, immutable image retained by Globe.js, so identity equality is
        // a sound reuse test here (the same test `_resolveOrUploadMaterialTexture`
        // applies). A changed source (e.g. `oceanNormalMapUrl` swapped at
        // runtime) fails the identity check and re-uploads exactly once.
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
      // Session 65 Batch 16 — pull from the aggregated composite-uniforms
      // view so composite-fabric texture uniforms (e.g., the `image`
      // color-ramp on Bathymetry's `ElevationRamp` sub-material, owned
      // by `material.materials.elevationRampMaterial`, not the parent)
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

    // NEW-GLOBE-BINDGROUP-CACHE (Batch 241) — keyed on the 5 variable
    // resource identities (water mask view, ocean normal view, material
    // UBO + 2 material texture views). Samplers are init-time
    // singletons. The material UBO's CONTENTS are rewritten per frame
    // via writeBuffer, but the buffer object is stable per material
    // type, so the bind group itself is reusable. This also collapses
    // the per-pass double-create (`bindGroup2` for the translucency
    // pre-passes + `bindGroup2Final` for the color pass resolve to the
    // same key when their resolved resources match).
    // Batch 437 (CLOUD-SHADOWS) — bindings 9/10: the sun-view beer shadow map +
    // sampler, captured this frame from the cloud cache (real map when
    // globe.cloudCastShadows is on, else the renderer's 1×1 placeholder →
    // transmittance 1, no shadow). Folded into the cache key so a real-vs-
    // placeholder swap rebuilds the group.
    const cloudShadowView = this._cloudShadowView ?? this._placeholderView!;
    const cloudShadowSampler = this._cloudShadowSampler ?? this._sampler!;

    const cache = this._bindGroupCache;
    const key =
      `2|${cache.idOf(waterMaskView)}|${cache.idOf(normalMapView)}|` +
      `${cache.idOf(matUBO)}|${cache.idOf(matImage)}|${cache.idOf(matHeights)}|` +
      `${cache.idOf(cloudShadowView)}`;
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
        ],
      }),
    );
  }

  // ─── Imagery / Water-Mask Texture Cache ───
  // Bodies live in `WebGPUGlobeSurfaceTextures.ts` (Batch 148). The 3
  // per-method delegators that previously sat here were the only callers
  // for the imagery + water-mask paths; their single call sites now
  // invoke the helpers directly. The shared `uploadImageSource` helper
  // is also called directly from the ocean-normal-map upload site in
  // `_createWaterOceanBindGroup`.

  // ═══════════════════════════════════════════════════════════════════════
  // Wireframe Debug Mode
  // ═══════════════════════════════════════════════════════════════════════

  // ─── Wireframe helpers ───
  // Bodies for `selectWireframePipeline`, `buildWireframePipelineDescriptor`,
  // and `getOrCreateWireframeIndices` live in
  // `WebGPUGlobeSurfaceWireframe.ts` (Batch 149). The public-API
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

    // C-R7-RENDERER-MIGRATION (Batch 75) — capture the central pipeline
    // cache from the context (same as `createTileCommands`).
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

    // NEW-GLOBE-BINDGROUP-CACHE (Batch 241) — same per-frame tick as
    // `createTileCommands` (no-op when already ticked this frame).
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
    // C-R7 (Batch 75) — pipeline still resolving in the central cache.
    // Skip the wireframe overlay this frame; next frame it'll be ready.
    if (!pipeline) return null;

    // Wireframe parity with WebGL: WebGL's wireframe path only swaps the tile
    // command's vertexArray to the line VA + primitiveType to LINES, keeping the
    // full imagery uniformMap + textures, so the lines are shaded with real
    // imagery against the black background. The WebGPU path previously fed an
    // EMPTY layer set, so fragmentMain's imagery composite loop (gated on
    // tile.layerCount > 0) was skipped and the lines emitted the navy base color
    // (tile.initialColor ≈ (0,0,0.5)) — which reads as black. Feed the same
    // ready imagery layers createTileCommands gathers (single first pass — the
    // wireframe is a one-pass debug overlay, no multi-pass blend needed).
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

    // Real imagery textures (matches createTileCommands' first pass) so the
    // wireframe lines are imagery-colored, not the base-color black.
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
   * C2-25 ENV-SCENE-CAPTURE (Batch 446) — capture sibling of
   * `createTileCommands`. Builds ONE single-color-target draw command for a
   * tile, for rendering the opaque globe surface into a dynamic-environment-map
   * cube face. The caller (`runSceneCapture` in
   * `WebGPUDynamicEnvironmentMapManager`) has already repointed
   * `uniformState` at the active cube-face camera via
   * `uniformState.updateCamera(faceCamera)`, so `createCameraUniformBufferHelper`
   * packs the FACE-camera RTE matrices for free — the same override-camera seam
   * the WebGL shadow loop uses.
   *
   * Crucially this does NOT run the on-screen `createTileCommands`
   * `_scenePipelineFormatGeneration` reset (which wipes `_pipelineCache`): the
   * capture pipeline lives in the SEPARATE `_capturePipelineCache`, so a capture
   * build never invalidates the on-screen globe pipelines (no per-frame FPS
   * regression while capture is active). Reuses the standard group 0/1/2 bind
   * groups + the placeholder effects group; the single imagery pass is enough
   * for a reflection source (no multi-layer blend, no material, no debug, no
   * translucency).
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

    // Mirror the on-screen log-depth + imagery-reduced state so the capture
    // pipeline's shader-define set lines up with the bind-group layout. (The
    // on-screen `createTileCommands` sets `_logDepthEnabled` each frame; capture
    // runs in `primitives.update`, BEFORE `globe.render`, so resolve the gate
    // directly here to stay in sync on the first capture of the frame.)
    //
    // NEW-WEBGPU-GLOBE-USE-LOG-DEPTH — this MUST be the same expression the
    // on-screen writer uses. Both read the same `frameState`, so whichever runs
    // first this frame decides the same globe encoding; if the two ever diverge,
    // the capture cube and the on-screen frame disagree and the shared
    // `_pipelineCache` / module set thrashes between them every frame.
    this._logDepthEnabled = isWebGPULogDepthActive(
      frameState.context,
      frameState,
    );

    // C11-158 — mirror the ocean-styling toggle here too. Capture runs in
    // `primitives.update` (BEFORE `globe.render` / `createTileCommands`), so
    // read it directly to stay in sync on the first capture of the frame; the
    // shared `_applyEnhancedOceanState` wipes ALL globe pipeline caches on a
    // flip, so whichever path runs first covers both.
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

    // The carrier is geocentric, so every cube-face capture camera can reuse
    // the logical View's one S5 payload; only the camera UBO changes per face.
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

  // ═══════════════════════════════════════════════════════════════════════
  // Cache Eviction
  // ═══════════════════════════════════════════════════════════════════════

  // Public-API delegators for the tile-buffer / imagery-texture cache
  // helpers. Bodies live in `WebGPUGlobeSurfaceTileBuffers.ts` (Batch 151).

  evictStaleResources(activeTileKeys: Set<string>): void {
    evictStaleResourcesHelper(this, activeTileKeys);
  }

  removeImageryTexture(cacheKey: string): void {
    removeImageryTextureHelper(this, cacheKey);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Pipeline Access
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Enumerate every renderer-local pipeline cache truthfully.
   *
   * Replaces key-string spelunking as the way to ask what this renderer has
   * built. Covers all four maps — `_pipelineCache` (which holds the color,
   * pick, translucent-back-face and both depth-only kinds),
   * `_capturePipelineCache`, `_debugFragmentPipelineCache` and
   * `_wireframePipelineCache` — and reports one row per stored entry, so the
   * row count always equals the sum of the map sizes.
   *
   * Each row carries the parsed key fields, or `fields: null` when the stored
   * key does not match the grammar in `WebGPUGlobeSurfacePipelineKey`. That
   * null is deliberate and load-bearing: the four getters below silently
   * returned `null` for ~15 months because they assumed a key shape the
   * producer had stopped writing, and nothing reported the mismatch. An
   * unparseable row is the visible version of that failure.
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

  // C-R7-RENDERER-MIGRATION (Batch 75), repaired 2026-08-01 — these four
  // legacy accessors named a semantic variant ("uncompressed, with normals,
  // opaque, no extra defines") but looked it up through a hardcoded key
  // string. `831e2f189b` (2026-04-04) inserted the webMercatorT marker as a
  // fourth letter, so `UNO_28|0` and its three siblings stopped matching any
  // key the producer writes and all four returned `null` unconditionally for
  // ~15 months, with no caller and no signal.
  //
  // They now resolve through `findGlobePipelineVariant`, which parses the key
  // grammar from its single owning module and compares only the axes these
  // getters actually mean:
  //
  //   quantized / normals / opaque / no clip-distances / cull enabled /
  //   no active shader defines
  //
  // Two axes the old keys pinned by accident are deliberately left FREE:
  //   - webMercatorT — never part of any getter's name; pinning it is the
  //     precise bug being fixed.
  //   - stride — varies with the terrain encoding actually loaded (12/16/
  //     20/24/28/32/36/40+ bytes depending on quantization, webMercatorT,
  //     normals and DP-H25 geodetic surface normals), so the single
  //     hardcoded value was never more than a guess at one encoding.
  //
  // SHAPE CHANGE, deliberate: several materialized variants can satisfy one
  // getter. The lexicographically-smallest key wins so repeat calls are
  // stable rather than load-order dependent. Callers needing every match
  // should use `listPipelineVariants()`. Still returns `null` when no
  // matching variant has materialized — unchanged, and now for the honest
  // reason rather than because the key could never match.
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

  // ═══════════════════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════════════════

  destroy(): void {
    if (this._isDestroyed) return;

    // C9-AUDIT-P1-SWEEP (Batch 684) — drop the per-(context, frame) effects
    // memo this renderer published. It pins a bind group + shadowMap /
    // clipping / tileProvider refs for the context's lifetime otherwise. The
    // memo is intra-frame by design (reuse is gated on `frameNumber`), so
    // nulling it here is safe by construction — the next frame rebuilds it.
    if (this._effectsMemoContext) {
      this._effectsMemoContext._globeEffectsHandle = null;
      this._effectsMemoContext = null;
    }

    // Route final destruction through the same helper as production eviction
    // so C9-01's opt-in logical lifetime gauges close consistently.
    evictStaleResourcesHelper(this, new Set());

    for (const cacheKey of [...this._imageryTextureCache.keys()]) {
      removeImageryTextureHelper(this, cacheKey);
    }
    // C9-12A (hardened Batch 686) — release every shared imagery realization.
    // The map entries were already dropped above; this destroys the shared
    // GPUTextures the table owns. Destruction routes through the last live
    // context's deferred `scheduleTextureDestroy` (F0b — the table stores no
    // context closure); if no context was ever plumbed, inline destroy is the
    // only option and is stamped for the F7 mip-job skip.
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
      // F7 (Batch 686) — inline destroy: stamp so a same-frame pending mip job
      // for this texture is skipped instead of encoding on a dead texture.
      this._webgpuContext?.noteInlineTextureDestroy?.(cached.texture);
      cached.texture.destroy();
    }
    this._waterMaskTextureCache.clear();

    for (const [, cached] of this._oceanNormalMapCache) {
      // F7 — ocean-normal uploads enqueue frame-owned mip jobs every frame
      // (see NEW-WEBGPU-OCEANNORMAL-PER-CALL-REUPLOAD), so a mid-frame destroy
      // MUST stamp or endFrame would encode mips on a destroyed texture.
      this._webgpuContext?.noteInlineTextureDestroy?.(cached.texture);
      cached.texture.destroy();
    }
    this._oceanNormalMapCache.clear();
    // PERF-OCEAN-NORMAL-REUPLOAD — drop the reuse guard alongside the textures
    // it points at, or a later frame would hand out a view backed by a
    // destroyed texture.
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

    this._pipelineCache.clear();
    this._wireframePipelineCache.clear();
    this._debugFragmentPipelineCache.clear();
    // NEW-GLOBE-BINDGROUP-CACHE (Batch 241) — drop all cached bind
    // groups (they reference textures/buffers destroyed above) and
    // unpublish the debug handle if it points at this cache.
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
