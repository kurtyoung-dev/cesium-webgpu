/// <reference types="@webgpu/types" />
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
import {
  selectWireframePipeline as selectWireframePipelineHelper,
  getOrCreateWireframeIndices as getOrCreateWireframeIndicesHelper,
} from "./WebGPUGlobeSurfaceWireframe.js";
import {
  selectPipeline as selectPipelineHelper,
  selectDebugFragmentPipeline as selectDebugFragmentPipelineHelper,
  selectDepthOnlyBackFacePipeline as selectDepthOnlyBackFacePipelineHelper,
  selectTranslucentBackFacePipeline as selectTranslucentBackFacePipelineHelper,
  buildPipelineDescriptor,
  descriptorToGPU,
} from "./WebGPUGlobeSurfacePipelines.js";
import { ShaderDefine } from "./WebGPUShaderDefines.js";
import { preprocess as preprocessWGSL } from "./WebGPUShaderPreprocessor.js";
import {
  getTileKey as getTileKeyHelper,
  getOrCreateTileBuffers as getOrCreateTileBuffersHelper,
  evictStaleResources as evictStaleResourcesHelper,
  removeImageryTexture as removeImageryTextureHelper,
} from "./WebGPUGlobeSurfaceTileBuffers.js";
import { createCameraUniformBuffer as createCameraUniformBufferHelper } from "./WebGPUGlobeSurfaceCameraUB.js";
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
} from "./WebGPUGlobeSurfaceTypes.js";

// Re-export the public surface so existing import sites that pull
// `TileDrawDescriptor` / `DebugFragmentMode` from this file keep compiling.
export type { TileDrawDescriptor } from "./WebGPUGlobeSurfaceTypes.js";
export { DebugFragmentMode } from "./WebGPUGlobeSurfaceTypes.js";

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
  private _oceanNormalMapCache: Map<string, ImageryGPUTexture> = new Map();
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
  // Public underscore: shared with the wireframe helpers (Batch 149).
  public _canvasFormat: GPUTextureFormat = "bgra8unorm";
  // Session 65 Batch 32 — MSAA sample count tracked alongside format.
  // Captured from `context._msaaSamples` on each `maybeUpdateForScene
  // Format` call (mirrors `_canvasFormat`). Used by `PipelineHost`
  // consumers to bake `multisample.count` into globe pipelines. The
  // shared `_scenePipelineFormatGeneration` counter also bumps on
  // MSAA change (see `WebGPUSceneRenderer.prepareFrame` Batch 25),
  // triggering this renderer's pipeline cache wipe at the same point.
  public _sampleCount: number = 1;
  // Renderer-wide log-depth master switch, mirrored from
  // `context._logDepthWriteEnabled` each frame so `buildPipelineDescriptor`
  // (via `host._logDepthEnabled`) can OR the `LOG_DEPTH` shader define into
  // the globe pipeline's defines + cache key. Default false → the bit is 0 and
  // the globe pipeline is byte-identical until the epic's final flip.
  public _logDepthEnabled: boolean = false;
  // Batch 110 — track scene-pipeline format generation last applied
  // so a runtime HDR / canvas-format change clears the pipeline +
  // wireframe + debug-fragment caches and rebuilds against the new
  // scene FB color format.
  private _scenePipelineFormatGeneration: number = -1;

  // NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT (Batch 246) — per-device
  // imagery slot count (16 full / 1 reduced) and the matching
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

  // Per-tile GPU resource caches
  // Public underscore: shared with the tile-buffer helpers (Batch 151).
  public _tileBufferCache: Map<string, TileGPUResources> = new Map();
  // Public underscore: imagery + water-mask caches are shared with the
  // texture-cache helpers (Batch 148).
  public _imageryTextureCache: Map<string, ImageryGPUTexture> = new Map();
  public _waterMaskTextureCache: Map<string, ImageryGPUTexture> = new Map();

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

  constructor() {
    this._tileUniformU32View = new Uint32Array(this._tileUniformData.buffer);
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

    // Geometry variant key — same shape as the base pipeline cache key
    // minus the debug-fragment and translucent-back-face axes (those
    // variants don't currently route through the material path).
    const ncSuffix = disableCulling ? "_NC" : "";
    const defines = hasGeodeticSurfaceNormals
      ? ShaderDefine.GEODETIC_NORMAL
      : 0;
    const geomKey = `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}${isBlend ? "B" : "O"}_${strideBytes}${ncSuffix}|${defines.toString(16)}`;

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
          `${device.limits?.maxSampledTexturesPerShaderStage} < 31 ` +
          `(full globe layout). Multi-layer tiles will multi-pass.`,
      );
    }

    this._initShaderCache(shaderCode);
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

    // Mirror the log-depth master switch every frame (independent of the
    // ctxGen guard above). The flag flips once via _logDepthWriteEnabled; the
    // pipeline cache keys include the LOG_DEPTH define so the flip rebuilds the
    // globe pipeline through the normal keyed-miss path.
    this._logDepthEnabled =
      (frameState.context as unknown as { _logDepthWriteEnabled?: boolean })
        ._logDepthWriteEnabled ?? false;

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

    for (let pass = 0; pass < passCount; pass++) {
      const isSubsequentPass = pass > 0;
      const layerStart = pass * imagerySlots;
      const layerEnd = Math.min(layerStart + imagerySlots, totalLayers);
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
        pipeline = selectPipelineHelper(
          this,
          gpuResources.isQuantized,
          gpuResources.hasNormals,
          gpuResources.hasWebMercatorT,
          isSubsequentPass,
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

      const bindGroup0 = this._getOrCreateBindGroup0(device, cameraUB, tileUB);

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
      const receiveShadowMap =
        shadowState?.lightShadowsEnabled && shadowState?.lightShadowMaps?.[0]
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
      };
      const csmCandidate = frameState.context?.csmRenderer as
        | CSMRendererView
        | null
        | undefined;
      const csmBinding =
        csmCandidate &&
        csmCandidate.enabled === true &&
        csmCandidate.cascadeParamsBuffer &&
        csmCandidate.cascadeArrayView
          ? {
              enabled: true,
              paramsBuffer: csmCandidate.cascadeParamsBuffer,
              cascadeArrayView: csmCandidate.cascadeArrayView,
            }
          : undefined;

      let bindGroup3: GPUBindGroup;
      if (
        useClipDistances ||
        (tileProvider?.clippingPlanes &&
          tileProvider.clippingPlanes.length > 0) ||
        atmosphereLutViews !== null ||
        receiveShadowMap !== undefined ||
        csmBinding !== undefined
      ) {
        const fxRes = createEffectsBindGroup(device, frameState, {
          clippingPlanes: tileProvider.clippingPlanes,
          shadowMap: receiveShadowMap,
          csm: csmBinding,
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
      if (
        globeTranslucent &&
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
          });
        }
        // Same async-fallback semantics as the depth-only command:
        // null pipeline → skip this command for one frame. The other
        // two commands continue to render; the missing back-face
        // contribution is invisible after the first frame.
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

      commands.push({
        pipeline,
        bindGroups: [bindGroup0, bindGroup1, bindGroup2Final, bindGroup3],
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

  // ═══════════════════════════════════════════════════════════════════════
  // Texture Management
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Group 0 (camera UB + tile UB), cached on (buffer identity, byte
   * offset) of both ring-allocator slices. At a settled camera the
   * ring allocator reproduces the same (page, offset) tuples with
   * period = pageCount, so steady-state lookups hit. During tile churn
   * the offsets shift and this degrades gracefully to the pre-cache
   * create-per-call behavior. NEW-GLOBE-BINDGROUP-CACHE (Batch 241);
   * the offset-churn-proof fix is dynamic-offset BGL conversion
   * (NEW-GLOBE-DYNAMIC-OFFSET-UBO, deferred).
   */
  private _getOrCreateBindGroup0(
    device: GPUDevice,
    cameraUB: { buffer: GPUBuffer; offset: number; size: number },
    tileUB: { buffer: GPUBuffer; offset: number; size: number },
  ): GPUBindGroup {
    const cache = this._bindGroupCache;
    const key = `0|${cache.idOf(cameraUB.buffer)}:${cameraUB.offset}|${cache.idOf(tileUB.buffer)}:${tileUB.offset}`;
    return cache.getOrCreate(key, () =>
      device.createBindGroup({
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
      }),
    );
  }

  private _createTextureBindGroup(
    device: GPUDevice,
    passLayers: CesiumTileImagery[],
  ): GPUBindGroup {
    const textureViews: GPUTextureView[] = [];
    // NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT (Batch 246) — entry count
    // follows the per-device group-1 layout width (16 full / 1 reduced).
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
    let waterMaskView = this._placeholderView!;
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
      const source = onm._source ?? onm.image ?? oceanNormalMap;
      if (
        source instanceof HTMLImageElement ||
        source instanceof ImageBitmap ||
        source instanceof HTMLCanvasElement
      ) {
        const view = uploadImageSourceHelper(
          this,
          source,
          "oceanNormal",
          this._oceanNormalMapCache,
        );
        if (view) {
          normalMapView = view;
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
    const cache = this._bindGroupCache;
    const key =
      `2|${cache.idOf(waterMaskView)}|${cache.idOf(normalMapView)}|` +
      `${cache.idOf(matUBO)}|${cache.idOf(matImage)}|${cache.idOf(matHeights)}`;
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

    // Single pass for wireframe — no multi-pass imagery needed
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
      [],
      false,
    );

    const bindGroup0 = this._getOrCreateBindGroup0(device, cameraUB, tileUB);

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

  // C-R7-RENDERER-MIGRATION (Batch 75) — these legacy getters look up
  // specific pipeline variants by their hardcoded cache keys. After the
  // migration to entry-based caching the keys also carry a `|defines`
  // suffix; preserve the original key form (`UNO_28` etc.) by appending
  // `|0` for the no-defines (baseline) variant. Returns `null` when the
  // central pipeline cache hasn't yet materialized that variant —
  // unchanged from the prior behavior, which also returned null when the
  // variant hadn't been requested by `_selectPipeline` yet.
  get pipeline(): GPURenderPipeline | null {
    return this._pipelineCache.get("UNO_28|0")?.pipeline ?? null;
  }

  get pipelineNoNormals(): GPURenderPipeline | null {
    return this._pipelineCache.get("UXO_24|0")?.pipeline ?? null;
  }

  get pipelineQuantized(): GPURenderPipeline | null {
    return this._pipelineCache.get("QNO_16|0")?.pipeline ?? null;
  }

  get pipelineQuantizedNoNormals(): GPURenderPipeline | null {
    return this._pipelineCache.get("QXO_12|0")?.pipeline ?? null;
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
