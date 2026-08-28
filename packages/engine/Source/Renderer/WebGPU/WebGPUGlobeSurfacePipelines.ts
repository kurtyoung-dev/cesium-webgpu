/// <reference types="@webgpu/types" />
/**
 * Pipeline construction and selection for the WebGPU globe surface.
 *
 * Each helper takes the renderer as a {@link PipelineHost} instead of living on
 * it, which is why the renderer declares `_pipelineCache`,
 * `_debugFragmentPipelineCache` and `_centralPipelineCache` public:
 *
 *   - `buildPipelineDescriptor(host, …)` — a cache-friendly
 *     `WebGPURenderPipelineDescriptor` for a given quantization / normals /
 *     blend / clip-distances / debug-fragment combination.
 *   - `descriptorToGPU(d)` — pure conversion of that descriptor back into the
 *     WebGPU shape, for the path where no central cache is available.
 *   - `resolveGlobePipelineEntry(host, entry)` — resolves a cache entry to its
 *     `GPURenderPipeline` through the central cache, memoizing the result.
 *     Returns null while creation is still in flight so the caller can skip
 *     the tile this frame.
 *   - `selectPipeline(host, …)` — entry-based caching for the production
 *     pipeline: color, blend, and the no-cull underground variant.
 *   - `selectDebugFragmentPipeline(host, mode, …)` — cold-path selector for
 *     the per-fragment debug variants (TRIANGULATION / LOD / NORMAL). Returns
 *     null when the device rejects the augmented module.
 *
 * @module WebGPUGlobeSurfacePipelines
 */

import { ShaderDefine } from "./WebGPUShaderDefines.js";
import { buildGlobePipelineCacheKey } from "./WebGPUGlobeSurfacePipelineKey.js";
import {
  getProductionShaderModule as getProductionShaderModuleHelper,
  getDebugFragmentShaderModule as getDebugFragmentShaderModuleHelper,
  getClipDistancesShaderModule as getClipDistancesShaderModuleHelper,
  type ShaderFactoryHost,
} from "./WebGPUGlobeSurfaceShaders.js";
import {
  DebugFragmentMode,
  type GlobePipelineEntry,
} from "./WebGPUGlobeSurfaceTypes.js";
import { buildPickPipelineDescriptor } from "./WebGPUPickCommandHelpers.js";
import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";

/**
 * The renderer surface the pipeline helpers reach into. Extends
 * `ShaderFactoryHost` so `buildPipelineDescriptor` can call the shader
 * factory's three module getters without going back through the
 * renderer.
 */
export interface PipelineHost extends ShaderFactoryHost {
  readonly _canvasFormat: GPUTextureFormat;
  /**
   * The pick pipeline color-target format, mirrored from
   * `context.pickPipelineFormat` by the renderer on every scene-format
   * generation bump. Equals `_canvasFormat` in SDR; stays an 8-bit unorm when
   * the scene target is float/HDR.
   */
  readonly _pickFormat?: GPUTextureFormat;
  readonly _pipelineLayout: GPUPipelineLayout | null;
  readonly _pipelineCache: Map<string, GlobePipelineEntry>;
  readonly _debugFragmentPipelineCache: Map<string, GlobePipelineEntry>;
  /**
   * Cache for the single-target scene-capture pipeline variants, keyed on
   * `faceFormat + captureDepthFormat + sampleCount=1 + CAPTURE_MODE`. It is
   * deliberately disjoint from `_pipelineCache` and is never wiped by the
   * on-screen `createTileCommands` `_scenePipelineFormatGeneration` reset: the
   * capture format is fixed by the env cube (`rgba8unorm` / `rgba16float`)
   * rather than by the canvas, so a canvas-format or MSAA flip must not
   * invalidate it, and a capture build must not bump the on-screen generation,
   * which would force a full on-screen globe pipeline rebuild on every frame
   * capture is active.
   */
  readonly _capturePipelineCache: Map<string, GlobePipelineEntry>;
  /**
   * Read+write — the central pipeline cache reference. Captured lazily
   * by `createTileCommands` from `frameState.context`; this module never
   * writes it (the renderer's outer code does the lazy capture).
   */
  readonly _centralPipelineCache: WebGPURenderPipelineCache | null;
  /**
   * MSAA sample count for the scene framebuffer. The renderer captures
   * `context._msaaSamples` here so `buildPipelineDescriptor` can bake the
   * matching `multisample.count` into each variant. Default 1 is
   * single-sample, no MSAA.
   */
  readonly _sampleCount?: number;
  /**
   * Renderer-wide log-depth state, resolved by the renderer each frame from
   * `isWebGPULogDepthActive(context, frameState)` — the
   * `_logDepthWriteEnabled` master switch and `frameState.useLogDepth`. When
   * true, pipeline builds OR `ShaderDefine.LOG_DEPTH` into their defines and
   * cache key so the globe writes `@builtin(frag_depth)` log depth. False or
   * undefined leaves the bit clear and the globe writes the rasterizer's
   * hyperbolic NDC z, matching every sibling producer that shares the depth
   * attachment.
   */
  readonly _logDepthEnabled?: boolean;
  /**
   * Pick-fleet log-depth state, resolved from
   * `isWebGPUPickLogDepthActive(context, frameState)` and held separately from
   * `_logDepthEnabled`. `selectPickPipeline` ORs `LOG_DEPTH` from this flag,
   * through the `logDepthOverride` argument to `buildPipelineDescriptor`, so
   * the globe pick module gates on the pick switch rather than the scene
   * switch. False or undefined means the globe pick writes hyperbolic depth
   * into the shared pick FBO.
   */
  readonly _pickLogDepthEnabled?: boolean;
}

// Pipelines are built lazily, one per actual vertex stride. This returns a
// cache-friendly `WebGPURenderPipelineDescriptor`; the `GPURenderPipeline`
// itself is materialized through `webgpuPipelineCache`, so two
// GlobeSurfaceRenderer instances (split-screen, multi-viewer) sharing a
// descriptor share one pipeline.
export function buildPipelineDescriptor(
  host: PipelineHost,
  isQuantized: boolean,
  hasNormals: boolean,
  hasWebMercatorT: boolean,
  isBlend: boolean,
  strideBytes: number,
  debugFragmentMode: DebugFragmentMode = DebugFragmentMode.NONE,
  useClipDistances: boolean = false,
  hasGeodeticSurfaceNormals: boolean = false,
  disableCulling: boolean = false,
  // Depth-only back-face pre-pass variant for translucent globe rendering.
  depthOnlyBackFace: boolean = false,
  // Translucent back-face variant, dispatched between the depth-only back-face
  // pre-pass and the translucent front-face command to complete the three-pass
  // technique. When `true`:
  //   - cullMode: "front" (back faces only — blend the far side first)
  //   - blend: ALPHA, forced regardless of the `isBlend` input
  //   - depthWriteEnabled: false (the pre-pass already wrote depth; this pass
  //     tests against it without overwriting)
  //   - colorWriteMask: 0xf (full color output)
  //
  // The depth pre-pass populates depth with the back-face surface, this pass
  // blends the back-face color over the cleared framebuffer, and the front-face
  // command blends over that. The three together composite front-to-back
  // through the translucent planet, which a single unsorted alpha-blend pass
  // cannot.
  translucentBackFace: boolean = false,
  // When set to a cube-face texture format, builds the single-color-target
  // scene-capture variant: ORs `ShaderDefine.CAPTURE_MODE` into the defines, so
  // the production module drops the G-buffer slot-1 `@location(1)` output, and
  // emits one color target (`{format: captureFaceFormat}`, no MRT slot-1), a
  // no-stencil `depth24plus` depth target and no MSAA — matching the transient
  // per-face capture render pass into `cache.faceViews[face]`. Left undefined
  // by every on-screen call site.
  captureFaceFormat?: GPUTextureFormat,
  // Depth-only front-face pre-pass variant, mirroring WebGL's
  // DEPTH_ONLY_FRONT_FACE derived command
  // (GlobeTranslucencyState.js getDepthOnlyFrontFaceRenderState): cull back
  // faces, colorWriteMask 0, depth-write enabled. Used when the globe is
  // translucent with an opaque back face (the default backFaceAlpha = 1),
  // where the color command switches to the depth-read-only ALPHA-blend
  // variant — this pre-pass is what keeps the scene depth populated with the
  // near globe surface, which sky/atmosphere gating, the depth plane, later
  // primitives and pickPosition all read.
  depthOnlyFrontFace: boolean = false,
  // When defined, replaces `host._logDepthEnabled` in the LOG_DEPTH define and
  // module decision. `selectPickPipeline` passes `host._pickLogDepthEnabled` so
  // the globe pick module gates on the pick-fleet master switch; every other
  // call site leaves this undefined.
  logDepthOverride?: boolean,
): WebGPURenderPipelineDescriptor {
  let vertexBuffers: GPUVertexBufferLayout[];
  let entryPoint: string;

  // When the encoding includes geodetic surface normals they occupy the
  // trailing 3 floats (12 bytes) of the stride, and the shader's
  // `GEODETIC_NORMAL` define activates the `@location(2)
  // geodeticSurfaceNormal` input plus the exaggeration branch override. The
  // entry-point names are unqualified: the module compiled with
  // `GEODETIC_NORMAL=on` carries the same entry-point names, only with
  // different struct membership.
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
    // both webMercT and normals are present, and 12 more for the geodetic
    // normal at the end of stride.
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
    // Everything after position is read as a single attribute at location 1:
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
    // Base uncompressed stride is 24 bytes (pos4 + tex2), plus 12 more when
    // geodetic normals are present.
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

  const isCapture = captureFaceFormat !== undefined;
  // The pick pipeline overrides the log state with the pick-fleet master
  // switch; every other call site passes undefined and keeps the scene
  // `_logDepthEnabled`.
  const logDepthOn = logDepthOverride ?? host._logDepthEnabled;
  // The active-defines set the production shader module is resolved against.
  // The geodetic-normal path flips `GEODETIC_NORMAL` and the cache hands back
  // the preprocessed module; augmented variants (debug fragment, clip
  // distances) inherit the same set so their base source stays consistent with
  // the pipeline's vertex buffer layout. The reduced-imagery bit rides along on
  // default-limit devices so the module's group-1 declarations match the
  // 1-slot pipeline layout.
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (logDepthOn ? ShaderDefine.LOG_DEPTH : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0) |
    // The capture variant drops the G-buffer slot-1 output so the fragment
    // stage matches the single-color-target capture pipeline.
    (isCapture ? ShaderDefine.CAPTURE_MODE : 0);
  const productionModule = getProductionShaderModuleHelper(host, defines);
  // When the hardware clip-distances variant is requested, both stages must
  // come from the augmented module: the vertex stage declares the
  // `@builtin(clip_distances)` output, and the fragment stage's
  // `globeClipByPlanes` discard is neutralized there to avoid double-clipping.
  let vertexModule: GPUShaderModule = productionModule;
  let fragmentModule: GPUShaderModule = productionModule;
  let cdLabel: string = "";
  if (useClipDistances) {
    const cdModule = getClipDistancesShaderModuleHelper(host, defines);
    if (cdModule) {
      vertexModule = cdModule;
      fragmentModule = cdModule;
      cdLabel = ", clipDist";
    }
    // A null module means the augmentation failed; the production module and
    // the fragment-discard path are the fallback. The caller's cache key still
    // distinguishes `useClipDistances=true` variants, so a production pipeline
    // is handed back under that key.
  }
  let fragmentEntry: string = "fragmentMain";
  let debugLabel: string = "";
  const debugFragModule =
    debugFragmentMode !== DebugFragmentMode.NONE
      ? getDebugFragmentShaderModuleHelper(host, defines)
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

  // Variant overrides for the three-pass globe-translucency technique:
  //   - depthOnlyBackFace: cullMode=front, color masked, depth-write enabled.
  //     Populates depth from the far side.
  //   - translucentBackFace: cullMode=front, ALPHA blend, depth-write
  //     disabled. Blends far-side color first.
  //   - default (translucent front face or opaque): cullMode follows the
  //     `disableCulling` toggle.
  // The `_DOB` and `_TBF` cache-key suffixes keep the three variants distinct.
  const dobLabel = depthOnlyBackFace ? ", depthOnlyBackFace" : "";
  const dofLabel = depthOnlyFrontFace ? ", depthOnlyFrontFace" : "";
  const tbfLabel = translucentBackFace ? ", translucentBackFace" : "";
  // The reduced-imagery variant has a different pipeline layout and shader
  // module, so it carries a distinct descriptor name.
  const imgLabel = host._imageryReduced ? ", imagery4" : "";
  const cullMode: GPUCullMode =
    depthOnlyBackFace || translucentBackFace
      ? "front"
      : depthOnlyFrontFace
        ? "back"
        : disableCulling
          ? "none"
          : "back";
  // The no-cull variant — underground camera, or a provider with back-face
  // culling switched off — differs from the cull-back variant only in
  // `primitive.cullMode`, which `generateCacheKey` does not read. The
  // `, noCull` marker is what names it in the central-cache key, matching the
  // dob/tbf/cd/img labels that follow the same convention.
  const ncLabel = cullMode === "none" ? ", noCull" : "";
  const depthWriteEnabled =
    depthOnlyBackFace || depthOnlyFrontFace
      ? true
      : translucentBackFace
        ? false
        : !isBlend;
  // Force ALPHA blend for translucent back-face regardless of `isBlend`
  // input; the variant is by-definition translucent.
  const effectiveBlend =
    depthOnlyBackFace || depthOnlyFrontFace
      ? undefined
      : translucentBackFace
        ? {
            color: {
              srcFactor: "src-alpha" as GPUBlendFactor,
              dstFactor: "one-minus-src-alpha" as GPUBlendFactor,
              operation: "add" as GPUBlendOperation,
            },
            alpha: {
              srcFactor: "one" as GPUBlendFactor,
              dstFactor: "one-minus-src-alpha" as GPUBlendFactor,
              operation: "add" as GPUBlendOperation,
            },
          }
        : blendState;
  // Mask all color writes when running the depth-only pre-pass. The
  // fragment stage is retained (rather than omitted) so the same module
  // compiles unchanged; its output is masked to nothing at the target
  // state level. WebGPU spec: `writeMask: 0` is equivalent to
  // GPUColorWrite.NONE and validates against the canvas format.
  const colorWriteMask: GPUColorWriteFlags =
    depthOnlyBackFace || depthOnlyFrontFace ? 0 : 0xf;

  // The capture variant renders into a single cube-face color attachment (no
  // MRT slot-1), a no-stencil `depth24plus` depth target, and no MSAA. The
  // CAPTURE_MODE define folded into `defines` above drops the `@location(1)`
  // output so the fragment stage matches the single target.
  const capLabel = isCapture ? `, capture ${captureFaceFormat}` : "";
  // The enhanced-ocean styling variant compiles a different GlobeTerrain
  // module — the `ENHANCED_OCEAN` hi-word branch, selected inside
  // `getProductionShaderModule` from `host._enhancedOceanEnabled`. The
  // renderer-local pipeline caches key without the hi word, so they are wiped
  // on a flag flip instead; see
  // `WebGPUGlobeSurfaceRenderer._applyEnhancedOceanState`.
  const oceanLabel = host._enhancedOceanEnabled ? ", enhOcean" : "";
  // `logDepthOn` selects a different GlobeTerrain module through the `defines`
  // bitmask above. `generateCacheKey` folds shader-module identity into every
  // central-cache key, so the two modules cannot collide on their own; this
  // marker is what says which of them a key names in `describeCacheKey()`,
  // `listPipelineVariants()` and devtools labels, where a bare `sh:41.…`
  // segment separates the variants without identifying them. `ld=` matches the
  // spelling used by Ocean, Cloud, FlowField, ComputeInstance and
  // GaussianSplat. The pick descriptor derives its name from this one and the
  // env-map capture descriptor routes through this function, so both inherit
  // the marker.
  //
  // The renderer-local caches carry the mask outright: every key built in this
  // module omits the optional material target axes and therefore ends with
  // `|${defines.toString(16)}`.
  const ldLabel = logDepthOn ? ", ld=1" : "";
  // Keep the diagnostic name legible on the descriptor axes that tooling
  // compares. Use effective values so clamped strides and capture MSAA do not
  // advertise states that the descriptor does not actually contain.
  const strideLabel = `, stride=${vertexBuffers[0].arrayStride}`;
  const mercatorLabel = hasWebMercatorT ? ", webMercatorT" : "";
  const geodeticLabel = hasGeodeticSurfaceNormals ? ", geodeticNormals" : "";
  const sampleLabel = `, samples=${isCapture ? 1 : (host._sampleCount ?? 1)}`;
  return {
    name: `Globe terrain (${quantLabel}, ${normLabel}, ${blendLabel}${debugLabel}${cdLabel}${dobLabel}${dofLabel}${tbfLabel}${ncLabel}${imgLabel}${capLabel}${oceanLabel}${ldLabel}${strideLabel}${mercatorLabel}${geodeticLabel}${sampleLabel})`,
    // Declare the lo-word define mask the modules above were compiled with.
    // Optional as far as the cache is concerned (module identity already
    // separates every variant); supplied here because the globe has the mask
    // to hand and it makes the central key self-describing on the axis that
    // caused this whole defect class.
    defines,
    layout: host._pipelineLayout!,
    vertex: {
      module: vertexModule,
      entryPoint,
      buffers: vertexBuffers,
    },
    fragment: {
      module: fragmentModule,
      entryPoint: fragmentEntry,
      // Both targets are emitted: `GlobeTerrain.wgsl`'s `fragmentMain` and the
      // three debug variants return `FragOutput { @location(0) color,
      // @location(1) normalRoughness }`. Slot 1 is the eye-space normal plus
      // roughness packed as rgba16float; consumers such as the ambient
      // occlusion pass read it through
      // `gBufferFramebuffer.normalRoughnessTexture` and fall back to the
      // depth-derived path when the slot-1 sample is the (0,0,0,*) sentinel
      // emitted by debug-Tri and non-globe pixels.
      //
      // The depth-only back-face variant still writes 0xf on slot 1: the
      // `colorWriteMask=0` applies only to slot 0, the scene color, because
      // the variant is depth-only with respect to the scene color and not the
      // G-buffer. The back faces it draws are real geometry whose normals
      // should populate the G-buffer for any consumer that needs them. Masking
      // slot 1 as well would mean gating `gbufferWriteMask` on
      // `depthOnlyBackFace`.
      targets: isCapture
        ? // Single cube-face color target, no MRT slot-1. An opaque write with
          // no blend: the per-face pass composites the globe over the compute
          // sky through the render pass `loadOp: 'load'`, not a blend op.
          [
            {
              format: captureFaceFormat!,
              writeMask: 0xf,
            },
          ]
        : [
            {
              format: host._canvasFormat,
              blend: effectiveBlend,
              writeMask: colorWriteMask,
            },
            {
              format: "rgba16float" as GPUTextureFormat,
              writeMask: 0xf,
            },
          ],
    },
    primitive: {
      topology: "triangle-list",
      // `disableCulling` opens up the under-the-globe / globe-translucent path,
      // which needs both faces visible. Mirrors WebGL's selection between
      // `_renderState` (cull on) and `_disableCullingRenderState` (cull off) in
      // `GlobeSurfaceTileProviderRendering.js:1226-1231`. The depth-only
      // back-face variant overrides to "front": cull front faces, draw back.
      cullMode,
      frontFace: "ccw",
    },
    depthStencil: {
      // Capture uses a transient no-stencil `depth24plus` target, deliberately
      // different from the on-screen `depth24plus-stencil8`, which is precisely
      // why the capture pipeline variant is mandatory: a single-target,
      // no-stencil mismatch against the on-screen pipeline is a WebGPU
      // validation error.
      format: isCapture
        ? ("depth24plus" as GPUTextureFormat)
        : "depth24plus-stencil8",
      depthWriteEnabled,
      // less-equal rather than less, even for the first pass. Planetary-scale
      // FP32 precision can push the globe's clip-space z up against the far
      // plane, and the paired vertex-shader clamp
      // `position.z = min(position.z, position.w)` produces exactly z/w=1 for
      // those vertices. `less` would discard them; `less-equal` lets them
      // survive the depth test against the cleared depth buffer, which starts
      // at 1.0.
      depthCompare: "less-equal",
    },
    // Match the scene framebuffer sample count. The capture pass is always
    // single-sample, so it forces `undefined`.
    multisample:
      !isCapture && (host._sampleCount ?? 1) > 1
        ? { count: host._sampleCount! }
        : undefined,
  };
}

/**
 * Convert the cache-friendly descriptor back into the WebGPU descriptor shape,
 * for the fallback path where no central cache is available. Pure function —
 * does not need the host.
 * @private
 */
export function descriptorToGPU(
  d: WebGPURenderPipelineDescriptor,
): GPURenderPipelineDescriptor {
  return {
    label: d.name,
    layout: d.layout ?? "auto",
    vertex: {
      module: d.vertex.module,
      entryPoint: d.vertex.entryPoint,
      buffers: d.vertex.buffers,
    },
    fragment: d.fragment
      ? {
          module: d.fragment.module,
          entryPoint: d.fragment.entryPoint,
          targets: d.fragment.targets,
        }
      : undefined,
    primitive: d.primitive,
    depthStencil: d.depthStencil,
    multisample: d.multisample,
  };
}

/**
 * Resolve a globe pipeline through the central pipeline cache. Returns
 * the existing GPU pipeline if cached; otherwise kicks off async
 * creation and returns null. Falls back to direct synchronous creation
 * when no central cache is available.
 *
 * Mirrors `tryResolvePolylinePipeline`.
 * @private
 */
export function resolveGlobePipelineEntry(
  host: PipelineHost,
  entry: GlobePipelineEntry,
): GPURenderPipeline | null {
  if (entry.pipeline) {
    return entry.pipeline;
  }
  const pipelineCache = host._centralPipelineCache;
  if (pipelineCache) {
    const sync = pipelineCache.getPipelineSync(entry.descriptor);
    if (sync) {
      entry.pipeline = sync;
      entry.pending = false;
      return sync;
    }
    if (!entry.pending) {
      entry.pending = true;
      pipelineCache
        .getPipeline(entry.descriptor)
        .then((p) => {
          entry.pipeline = p;
          entry.pending = false;
        })
        .catch(() => {
          entry.pending = false;
        });
    }
    return null;
  }
  // Fallback — direct synchronous creation.
  entry.pipeline = host._device!.createRenderPipeline(
    descriptorToGPU(entry.descriptor),
  );
  entry.pending = false;
  return entry.pipeline;
}

/**
 * Synchronous resolve for the scene-capture pipeline. Unlike
 * {@link resolveGlobePipelineEntry}, which returns null while
 * `createRenderPipelineAsync` cooks, this creates the pipeline synchronously
 * through `device.createRenderPipeline` on the first miss, so the first capture
 * pass already renders terrain. The capture path has no "render every frame, so
 * a one-frame pipeline delay is invisible" cover: the capture pass runs at most
 * every K frames and `runProceduralSkyFill` rewrites the whole cube on each
 * refresh, so a missed terrain composite leaves the face showing pure sky until
 * the next refresh. A handful of async-pending capture frames therefore reads
 * back as a permanently flat, sky-only reflection in any short-lived or
 * debounced capture window. The one-time synchronous compile stall — one variant
 * per face format, realistically one — is the cheaper trade for an opt-in,
 * debounced pass.
 *
 * Still seeds the central cache's async path, so later frames and any on-screen
 * sibling wanting the same key hit the cache, but does not depend on it for
 * correctness.
 */
export function resolveCapturePipelineEntrySync(
  host: PipelineHost,
  entry: GlobePipelineEntry,
): GPURenderPipeline | null {
  if (entry.pipeline) {
    return entry.pipeline;
  }
  const pipelineCache = host._centralPipelineCache;
  if (pipelineCache) {
    // Prefer a cached pipeline (e.g. a prior frame already built it async).
    const sync = pipelineCache.getPipelineSync(entry.descriptor);
    if (sync) {
      entry.pipeline = sync;
      entry.pending = false;
      return sync;
    }
  }
  // Not cached → build synchronously so this capture frame can draw terrain.
  if (!host._device) {
    return null;
  }
  entry.pipeline = host._device.createRenderPipeline(
    descriptorToGPU(entry.descriptor),
  );
  entry.pending = false;
  return entry.pipeline;
}

// Selects the production globe pipeline for one vertex / blend / cull
// combination, creating and caching the entry on first request. Returns null
// while the central cache is still materializing the pipeline, in which case
// the caller skips this tile this frame.
export function selectPipeline(
  host: PipelineHost,
  isQuantized: boolean,
  hasNormals: boolean,
  hasWebMercatorT: boolean,
  isBlend: boolean,
  strideBytes: number,
  useClipDistances: boolean = false,
  hasGeodeticSurfaceNormals: boolean = false,
  disableCulling: boolean = false,
): GPURenderPipeline | null {
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (host._logDepthEnabled ? ShaderDefine.LOG_DEPTH : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0);
  // The key format is owned by `WebGPUGlobeSurfacePipelineKey` so the
  // diagnostic readers — `listPipelineVariants` and the four legacy pipeline
  // getters — parse the same grammar this writes; building the string inline
  // here lets a reader drift against a stale copy of the format. The key
  // carries the clip-distances variant, the active-defines bitmask (which keeps
  // this map in step with the shader-module cache key), and `disableCulling`,
  // which selects the `cullMode: "none"` variant underground and
  // globe-translucent tiles need. That mirrors WebGL's
  // `tileProvider._disableCullingRenderState` selection at
  // `GlobeSurfaceTileProviderRendering.js:1226-1231`, picked when
  // `cameraUnderground || globeTranslucencyState.translucent`. Without a
  // distinct variant, underground tiles render cull-back and their interior
  // faces disappear at the rim.
  const cacheKey = buildGlobePipelineCacheKey({
    kind: "color",
    isQuantized,
    hasNormals,
    hasWebMercatorT,
    isBlend,
    strideBytes,
    useClipDistances,
    disableCulling,
    defines,
  });
  let entry = host._pipelineCache.get(cacheKey);
  let entryWasJustCreated = false;
  if (!entry) {
    const descriptor = buildPipelineDescriptor(
      host,
      isQuantized,
      hasNormals,
      hasWebMercatorT,
      isBlend,
      strideBytes,
      DebugFragmentMode.NONE,
      useClipDistances,
      hasGeodeticSurfaceNormals,
      disableCulling,
    );
    entry = { descriptor, pipeline: null, pending: false };
    host._pipelineCache.set(cacheKey, entry);
    entryWasJustCreated = true;
  }
  const pipeline = resolveGlobePipelineEntry(host, entry);

  // Warm on suspicion: when the opaque variant is requested for the first time,
  // kick off background creation of the blend counterpart so a later
  // globe-translucency toggle finds a hot pipeline. Only fires on the first
  // request per (stride, normals, mercator, …) combination, because
  // `cache.warm()` is a no-op once the entry is cached or pending. The inverse
  // direction is skipped: opaque is the default state and is almost always
  // already cached by the time a blend request fires.
  if (
    entryWasJustCreated &&
    !isBlend &&
    !disableCulling &&
    host._centralPipelineCache
  ) {
    const blendDescriptor = buildPipelineDescriptor(
      host,
      isQuantized,
      hasNormals,
      hasWebMercatorT,
      true, // isBlend
      strideBytes,
      DebugFragmentMode.NONE,
      useClipDistances,
      hasGeodeticSurfaceNormals,
      disableCulling,
    );
    host._centralPipelineCache.warm(blendDescriptor);
  }

  return pipeline;
}

/**
 * Select the single-color-target globe terrain capture pipeline variant for the
 * dynamic-environment-map scene-capture pass. Renders the opaque globe surface
 * into one cube-face color attachment (`captureFaceFormat`), a transient
 * no-stencil `depth24plus` depth target, and no MSAA. The CAPTURE_MODE shader
 * define drops the G-buffer slot-1 output so the fragment stage matches the
 * single target.
 *
 * Routes through the separate `_capturePipelineCache`, so it never collides
 * with — and a capture build never invalidates — the on-screen
 * `_pipelineCache`. The cache key includes the face format, giving an HDR env
 * cube its own pipeline, plus the standard vertex and shader-define dimensions;
 * `isBlend` is hardcoded false because capture is opaque, depth-write and
 * single-pass.
 *
 * Culling is disabled (`cullMode: "none"`). The six ENU cube-face cameras are
 * built with a screen-matched basis — camera-right = +∂s, camera-up = −∂t of
 * the cube's `faceUvToDirection` convention — so a rendered texel lands exactly
 * where the sky fill and IBL prefilter sample it back. A cube render is
 * inherently left-handed under that convention, which flips triangle winding;
 * rather than track the winding sign per face, the capture pass disables culling
 * and lets the depth test pick the nearest surface, which is correct for a
 * reflection source. See
 * `WebGPUDynamicEnvironmentMapCapture.buildCubeFaceCamera`.
 *
 * Resolves the pipeline synchronously (see `resolveCapturePipelineEntrySync`) so
 * the first capture pass draws terrain: the capture pass is debounced and the
 * sky fill rewrites the whole cube on each refresh, so an async-pending capture
 * frame reads back as a permanently flat, sky-only reflection. Returns null only
 * when the device is unavailable, in which case the caller omits this tile from
 * this capture frame.
 */
export function selectCapturePipeline(
  host: PipelineHost,
  isQuantized: boolean,
  hasNormals: boolean,
  hasWebMercatorT: boolean,
  strideBytes: number,
  captureFaceFormat: GPUTextureFormat,
  hasGeodeticSurfaceNormals: boolean = false,
): GPURenderPipeline | null {
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (host._logDepthEnabled ? ShaderDefine.LOG_DEPTH : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0) |
    ShaderDefine.CAPTURE_MODE;
  const cacheKey = buildGlobePipelineCacheKey({
    kind: "capture",
    isQuantized,
    hasNormals,
    hasWebMercatorT,
    isBlend: false, // capture is opaque (depth-write)
    strideBytes,
    captureFaceFormat,
    defines,
  });
  let entry = host._capturePipelineCache.get(cacheKey);
  if (!entry) {
    const descriptor = buildPipelineDescriptor(
      host,
      isQuantized,
      hasNormals,
      hasWebMercatorT,
      false, // isBlend — capture is opaque (depth-write)
      strideBytes,
      DebugFragmentMode.NONE,
      false, // useClipDistances
      hasGeodeticSurfaceNormals,
      true, // disableCulling — cube-face render is left-handed; depth picks nearest
      false, // depthOnlyBackFace
      false, // translucentBackFace
      captureFaceFormat, // → single-target capture variant
    );
    entry = { descriptor, pipeline: null, pending: false };
    host._capturePipelineCache.set(cacheKey, entry);
  }
  // Synchronous resolve rather than the async `resolveGlobePipelineEntry`: the
  // capture pass is debounced and the sky fill rewrites the cube on each
  // refresh, so an async-pending frame reads back as a permanently flat,
  // sky-only reflection. Building the one capture variant synchronously on the
  // first miss means the first capture draws terrain.
  return resolveCapturePipelineEntrySync(host, entry);
}

function buildGlobePickPipelineDescriptor(
  host: PipelineHost,
  colorDescriptor: WebGPURenderPipelineDescriptor,
): WebGPURenderPipelineDescriptor {
  // Pick rendering is always single-sample. Rewrite the terminal marker so
  // the derived descriptor does not advertise the scene's MSAA count. A
  // missing suffix is a diagnostics defect, never a reason to kill the pick
  // path: report it and fall through with the unmodified name.
  const singleSampleName = colorDescriptor.name.replace(
    /, samples=\d+\)$/u,
    ", samples=1)",
  );
  if (singleSampleName === colorDescriptor.name) {
    console.error(
      `[CesiumJS:webgpu] Globe color descriptor name is missing its effective sample suffix: ${colorDescriptor.name}`,
    );
  }
  return buildPickPipelineDescriptor(
    colorDescriptor,
    "fragmentPickMain",
    host._pickFormat ?? "rgba8unorm",
    {
      name: `${singleSampleName} pick`,
      forceDepthWriteEnabled: true,
    },
  );
}

/**
 * Select the globe terrain pick pipeline variant.
 *
 * Derives from the opaque color descriptor for the same vertex variant:
 * `buildPickPipelineDescriptor` swaps the fragment entry to `fragmentPickMain`,
 * strips blend and MSAA, stamps exactly one color target with
 * `host._pickFormat` — `context.pickPipelineFormat`, the byte-object-ID
 * authority shared with `WebGPUPickFramebuffer` — and forces
 * `depthWriteEnabled: true`. The result targets the single pick-FBO color
 * attachment in both SDR and HDR and writes standard rasterizer depth, matching
 * the model and primitive pick pipelines.
 *
 * The cache key shares the layout, vertex and shader-define dimensions with
 * `selectPipeline` and adds a `_PICK` suffix so it does not collide. `isBlend`
 * and `disableCulling` are hardcoded false: the pick pass is always opaque with
 * standard back-face culling, mirroring the color first pass.
 *
 * Returns null while the pipeline is materializing through the central cache;
 * the caller omits the pick command for this tile this frame. The color command
 * still renders, so the only effect is a one-frame gap in globe pick coverage —
 * a `scene.pick` over a just-appeared tile variant.
 */
export function selectPickPipeline(
  host: PipelineHost,
  isQuantized: boolean,
  hasNormals: boolean,
  hasWebMercatorT: boolean,
  strideBytes: number,
  useClipDistances: boolean = false,
  hasGeodeticSurfaceNormals: boolean = false,
): GPURenderPipeline | null {
  // The globe pick module gates LOG_DEPTH on the pick-fleet master switch
  // rather than the scene switch, so the pick FBO is uniformly hyperbolic or
  // uniformly log across the whole fleet.
  const pickLogActive = host._pickLogDepthEnabled ?? false;
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (pickLogActive ? ShaderDefine.LOG_DEPTH : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0);
  const cacheKey = buildGlobePipelineCacheKey({
    kind: "pick",
    isQuantized,
    hasNormals,
    hasWebMercatorT,
    isBlend: false, // pick is opaque (depth-write)
    strideBytes,
    useClipDistances,
    defines,
  });
  let entry = host._pipelineCache.get(cacheKey);
  if (!entry) {
    const colorDescriptor = buildPipelineDescriptor(
      host,
      isQuantized,
      hasNormals,
      hasWebMercatorT,
      false, // isBlend — pick is opaque (depth-write)
      strideBytes,
      DebugFragmentMode.NONE,
      useClipDistances,
      hasGeodeticSurfaceNormals,
      false, // disableCulling — standard back-face cull, matches color first pass
      false, // depthOnlyBackFace
      false, // translucentBackFace
      undefined, // captureFaceFormat
      false, // depthOnlyFrontFace
      // Force the pick module's LOG_DEPTH to the pick-fleet switch. The pick
      // reuses this descriptor's vertex and fragment modules, so both stages
      // get the pick-gated v_logDepth path.
      pickLogActive,
    );
    const descriptor = buildGlobePickPipelineDescriptor(host, colorDescriptor);
    entry = { descriptor, pipeline: null, pending: false };
    host._pipelineCache.set(cacheKey, entry);
  }
  // Create the pick pipeline synchronously rather than routing through the
  // central async cache. That cache's async `getPipeline` path never resolves
  // for this pick-descriptor shape — a single color target plus
  // `multisample: undefined`, as derived by `buildPickPipelineDescriptor` — so
  // the entry would stay null and the globe pick command would never attach.
  // Sync creation is the same call `resolveGlobePipelineEntry` makes when no
  // central cache is present, and is cheap here: the WGSL module is already
  // compiled for the color pipeline, so this only assembles the pipeline
  // object, once per variant, cached in `entry.pipeline`.
  if (!entry.pipeline && host._device) {
    try {
      entry.pipeline = host._device.createRenderPipeline(
        descriptorToGPU(entry.descriptor),
      );
    } catch (e) {
      // Permanent error — a broken pick pipeline silently disables globe
      // picking, which is a real bug a report needs to surface.
      console.error(
        `[CesiumJS:WebGPU] Globe pick pipeline creation failed (${cacheKey}):`,
        e,
      );
    }
  }
  return entry.pipeline;
}

/**
 * Select the translucent back-face pipeline variant. It sits between the
 * depth-only back-face pre-pass and the regular translucent front-face command,
 * completing the three-pass globe-translucency technique:
 *
 *   1. Depth-only back-face: writes depth from the far side of the globe
 *      (`selectDepthOnlyBackFacePipeline`).
 *   2. Translucent back-face, this variant: blends the far-side surface color
 *      over the cleared framebuffer. cullMode: "front", blend: ALPHA,
 *      depthWriteEnabled: false.
 *   3. Translucent front-face: blends the near-side surface over the back-face
 *      contribution, through `selectPipeline` with `disableCulling=false`
 *      (cullMode: "back", front faces only) and `isBlend=true`.
 *
 * The three together composite front-to-back through the planet, which a single
 * unsorted alpha-blend pass with cullMode: "none" cannot.
 *
 * Returns null while the pipeline is materializing in the central cache; the
 * caller then skips the translucent back-face command for this tile this frame.
 * The regular translucent and depth-only commands still emit, so the visible
 * artifact is one frame without the back-face contribution rather than a black
 * tile.
 */
export function selectTranslucentBackFacePipeline(
  host: PipelineHost,
  isQuantized: boolean,
  hasNormals: boolean,
  hasWebMercatorT: boolean,
  strideBytes: number,
  useClipDistances: boolean = false,
  hasGeodeticSurfaceNormals: boolean = false,
): GPURenderPipeline | null {
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (host._logDepthEnabled ? ShaderDefine.LOG_DEPTH : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0);
  // `isBlend=true` forces the ALPHA blend state; the `_TBF` (translucent
  // back-face) suffix distinguishes this from the standard blend variant,
  // which uses cullMode: "back". `_TBF` means cullMode: "front" with the same
  // alpha blend.
  const cacheKey = buildGlobePipelineCacheKey({
    kind: "translucentBackFace",
    isQuantized,
    hasNormals,
    hasWebMercatorT,
    isBlend: true, // translucent back-face uses ALPHA blend
    strideBytes,
    useClipDistances,
    defines,
  });
  let entry = host._pipelineCache.get(cacheKey);
  if (!entry) {
    const descriptor = buildPipelineDescriptor(
      host,
      isQuantized,
      hasNormals,
      hasWebMercatorT,
      true, // isBlend — translucent back-face uses ALPHA blend
      strideBytes,
      DebugFragmentMode.NONE,
      useClipDistances,
      hasGeodeticSurfaceNormals,
      false, // disableCulling — overridden by translucentBackFace below
      false, // depthOnlyBackFace
      true, // translucentBackFace — sets cullMode: "front" + blend ALPHA
    );
    entry = { descriptor, pipeline: null, pending: false };
    host._pipelineCache.set(cacheKey, entry);
  }
  return resolveGlobePipelineEntry(host, entry);
}

/**
 * Select the depth-only back-face pre-pass pipeline variant.
 *
 * Used by the globe surface renderer when `globeTranslucencyState.translucent`
 * is true: it emits one depth-only command per tile before the imagery-layer
 * translucent commands, populating the scene framebuffer's depth attachment
 * with the far side of the globe (cullMode: "front") so the subsequent
 * translucent passes blend correctly against it. Without the pre-pass, looking
 * through the planet at antipodal terrain produces inside-out z-fight artifacts
 * in the alpha-blended single-pass technique.
 *
 * The cache key shares the layout, vertex and shader-define dimensions with
 * `selectPipeline` and adds a `_DOB` suffix so it does not collide. The variant
 * is independent of imagery-layer multi-pass — there is no `_B`/`_O` dimension
 * because no color is written — so `isBlend = false` is hardcoded for the cache
 * key even though the depth-only override would produce the same pipeline
 * either way.
 *
 * Takes no `disableCulling` argument: the depth-only variant always culls front
 * faces by definition, and combining it with cull-none would defeat the purpose.
 *
 * @returns null while the pipeline is materializing through the central cache;
 *   the caller then skips the depth-only command for this tile this frame and
 *   starts emitting it once the pipeline lands. The translucent commands
 *   continue to render without the pre-pass — a one-frame degraded artifact
 *   rather than a permanent black tile.
 */
export function selectDepthOnlyBackFacePipeline(
  host: PipelineHost,
  isQuantized: boolean,
  hasNormals: boolean,
  hasWebMercatorT: boolean,
  strideBytes: number,
  useClipDistances: boolean = false,
  hasGeodeticSurfaceNormals: boolean = false,
): GPURenderPipeline | null {
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (host._logDepthEnabled ? ShaderDefine.LOG_DEPTH : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0);
  // Use the same cache key shape as `selectPipeline` for diagnostic
  // readability. `isBlend=false` and `disableCulling=false` are
  // hardcoded since the depth-only override supersedes both axes.
  const cacheKey = buildGlobePipelineCacheKey({
    kind: "depthOnlyBackFace",
    isQuantized,
    hasNormals,
    hasWebMercatorT,
    isBlend: false,
    strideBytes,
    useClipDistances,
    defines,
  });
  let entry = host._pipelineCache.get(cacheKey);
  if (!entry) {
    const descriptor = buildPipelineDescriptor(
      host,
      isQuantized,
      hasNormals,
      hasWebMercatorT,
      false, // isBlend — irrelevant for depth-only (no color writes)
      strideBytes,
      DebugFragmentMode.NONE,
      useClipDistances,
      hasGeodeticSurfaceNormals,
      false, // disableCulling — depth-only forces cullMode: "front"
      true, // depthOnlyBackFace
      false, // translucentBackFace
    );
    entry = { descriptor, pipeline: null, pending: false };
    host._pipelineCache.set(cacheKey, entry);
  }
  return resolveGlobePipelineEntry(host, entry);
}

/**
 * Select the depth-only front-face pre-pass pipeline variant.
 *
 * Used by the globe surface renderer when the globe is translucent with an
 * opaque back face, the default `backFaceAlpha = 1`. Mirrors WebGL's
 * DEPTH_ONLY_FRONT_FACE derived command: the translucent color command runs
 * with depth-write off on the ALPHA-blend variant, so this pre-pass is what
 * keeps the scene framebuffer's depth attachment populated with the near globe
 * surface, which sky/atmosphere gating, the depth plane, subsequently rendered
 * primitives and `pickPosition` all read. Without it the depth buffer holds no
 * globe surface at all and the sky pass floods the planet disk.
 *
 * The cache key mirrors `selectDepthOnlyBackFacePipeline` with a `_DOF` suffix.
 *
 * @returns null while the pipeline is materializing through the central cache;
 *   the caller then skips the pre-pass command for this tile this frame, giving
 *   one frame of degraded depth rather than a permanent black tile.
 */
export function selectDepthOnlyFrontFacePipeline(
  host: PipelineHost,
  isQuantized: boolean,
  hasNormals: boolean,
  hasWebMercatorT: boolean,
  strideBytes: number,
  useClipDistances: boolean = false,
  hasGeodeticSurfaceNormals: boolean = false,
): GPURenderPipeline | null {
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (host._logDepthEnabled ? ShaderDefine.LOG_DEPTH : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0);
  const cacheKey = buildGlobePipelineCacheKey({
    kind: "depthOnlyFrontFace",
    isQuantized,
    hasNormals,
    hasWebMercatorT,
    isBlend: false,
    strideBytes,
    useClipDistances,
    defines,
  });
  let entry = host._pipelineCache.get(cacheKey);
  if (!entry) {
    const descriptor = buildPipelineDescriptor(
      host,
      isQuantized,
      hasNormals,
      hasWebMercatorT,
      false, // isBlend — irrelevant for depth-only (no color writes)
      strideBytes,
      DebugFragmentMode.NONE,
      useClipDistances,
      hasGeodeticSurfaceNormals,
      false, // disableCulling — depth-only front-face forces cullMode: "back"
      false, // depthOnlyBackFace
      false, // translucentBackFace
      undefined, // captureFaceFormat
      true, // depthOnlyFrontFace
    );
    entry = { descriptor, pipeline: null, pending: false };
    host._pipelineCache.set(cacheKey, entry);
  }
  return resolveGlobePipelineEntry(host, entry);
}

/**
 * Cold path used when any of the per-fragment debug modes
 * (TRIANGULATION / LOD / NORMAL) is active for this frame. Kept off
 * `selectPipeline` so the production hot path stays branch-free.
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
export function selectDebugFragmentPipeline(
  host: PipelineHost,
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
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (host._logDepthEnabled ? ShaderDefine.LOG_DEPTH : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0);
  // Probe the augmented shader module first. The probe is define-keyed, and a
  // `null` cache entry short-circuits pipeline builds when the device rejected
  // the augmented source for this define-set. Passing the actual defines gives
  // the per-define cache the right key and keeps a compile probe with
  // mismatched defines from blocking the cache of another set.
  if (!getDebugFragmentShaderModuleHelper(host, defines)) {
    return null;
  }
  const cacheKey = buildGlobePipelineCacheKey({
    kind: "debugFragment",
    debugFragmentMode: mode,
    isQuantized,
    hasNormals,
    hasWebMercatorT,
    isBlend,
    strideBytes,
    defines,
  });
  let entry = host._debugFragmentPipelineCache.get(cacheKey);
  if (!entry) {
    const descriptor = buildPipelineDescriptor(
      host,
      isQuantized,
      hasNormals,
      hasWebMercatorT,
      isBlend,
      strideBytes,
      mode,
      false,
      hasGeodeticSurfaceNormals,
    );
    entry = { descriptor, pipeline: null, pending: false };
    host._debugFragmentPipelineCache.set(cacheKey, entry);
  }
  return resolveGlobePipelineEntry(host, entry);
}
