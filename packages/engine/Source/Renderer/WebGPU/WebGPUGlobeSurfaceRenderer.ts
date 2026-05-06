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
} from "./WebGPUGlobeSurfacePipelines.js";
import {
  getTileKey as getTileKeyHelper,
  getOrCreateTileBuffers as getOrCreateTileBuffersHelper,
  evictStaleResources as evictStaleResourcesHelper,
  removeImageryTexture as removeImageryTextureHelper,
} from "./WebGPUGlobeSurfaceTileBuffers.js";
import { createCameraUniformBuffer as createCameraUniformBufferHelper } from "./WebGPUGlobeSurfaceCameraUB.js";
import { createTileUniformBuffer as createTileUniformBufferHelper } from "./WebGPUGlobeSurfaceTileUB.js";
import type { WebGPURenderPipelineCache } from "./WebGPURenderPipelineCache.js";
import {
  CAMERA_UNIFORM_FLOATS,
  TILE_UNIFORM_FLOATS,
  MAX_IMAGERY_LAYERS,
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
  public _placeholderTexture: GPUTexture | null = null;
  public _placeholderView: GPUTextureView | null = null;
  // Public underscore: shared with the wireframe helpers (Batch 149).
  public _canvasFormat: GPUTextureFormat = "bgra8unorm";
  // Batch 110 — track scene-pipeline format generation last applied
  // so a runtime HDR / canvas-format change clears the pipeline +
  // wireframe + debug-fragment caches and rebuilds against the new
  // scene FB color format.
  private _scenePipelineFormatGeneration: number = -1;

  // Wireframe pipelines — keyed by the same shape string used by
  // _selectPipeline so they share variant granularity (Q/U, N/X, M/G, stride).
  // Lazily built on first wireframe request; production cache is untouched.
  // Public underscore: shared with the wireframe helpers (Batch 149).
  public _wireframePipelineCache: Map<string, GlobePipelineEntry> = new Map();
  public _wireframeIndexCache: Map<
    string,
    { buffer: GPUBuffer; count: number; format: GPUIndexFormat }
  > = new Map();

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
    createBindGroupLayoutsHelper(this);
    createPipelineLayoutHelper(this);
    createSamplersHelper(this);
    createPlaceholderTextureHelper(this);
    // Pipelines are created lazily in _selectPipeline based on actual tile stride
    this._isInitialized = true;
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
      this._pipelineCache.clear();
      this._wireframePipelineCache.clear();
      this._debugFragmentPipelineCache.clear();
    }

    const device = this._device;
    const mesh = surfaceTile.renderedMesh || surfaceTile.mesh;
    if (!mesh) return null;

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
    const disableCulling =
      !providerCullEnabled || cameraUnderground || globeTranslucent;

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
      if (
        globeTranslucent &&
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
      const view = getOrCreateImageryTextureHelper(this, imagery);
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

    // Batch 58 (C-R5): 16 texture bindings + sampler at binding 16. Each
    // entry pulls from `textureViews[i]` which is padded with placeholder
    // views above so unused slots still bind a valid resource.
    return device.createBindGroup({
      layout: this._bindGroupLayout1!,
      entries: [
        { binding: 0, resource: textureViews[0] },
        { binding: 1, resource: textureViews[1] },
        { binding: 2, resource: textureViews[2] },
        { binding: 3, resource: textureViews[3] },
        { binding: 4, resource: textureViews[4] },
        { binding: 5, resource: textureViews[5] },
        { binding: 6, resource: textureViews[6] },
        { binding: 7, resource: textureViews[7] },
        { binding: 8, resource: textureViews[8] },
        { binding: 9, resource: textureViews[9] },
        { binding: 10, resource: textureViews[10] },
        { binding: 11, resource: textureViews[11] },
        { binding: 12, resource: textureViews[12] },
        { binding: 13, resource: textureViews[13] },
        { binding: 14, resource: textureViews[14] },
        { binding: 15, resource: textureViews[15] },
        { binding: 16, resource: this._sampler! },
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
