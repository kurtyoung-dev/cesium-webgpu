/// <reference types="@webgpu/types" />
/**
 * Pipeline-construction helpers extracted from `WebGPUGlobeSurfaceRenderer`.
 *
 * Batch 150 of the audit-recommended decomposition (sixth slice of the
 * GlobeSurface decomposition arc — see
 * `migration_doc/BATCH_145_PLAN_GLOBE_SURFACE_DECOMPOSITION.md`).
 *
 * Moves the pipeline-creation cluster off the renderer class:
 *
 *   - `buildPipelineDescriptor(host, …)` — produces a cache-friendly
 *     `WebGPURenderPipelineDescriptor` for a given quantization /
 *     normals / blend / clip-distances / debug-fragment combination.
 *     The biggest single helper in this batch (~250 LOC).
 *   - `descriptorToGPU(d)` — pure conversion of our cache-friendly
 *     descriptor back into the WebGPU shape for the central-cache-less
 *     fallback path. Takes no host.
 *   - `resolveGlobePipelineEntry(host, entry)` — resolves a cache entry
 *     to its `GPURenderPipeline` via the central cache (async creation
 *     + cache-result memoization). Returns null while the pipeline is
 *     still resolving so the caller can skip the tile this frame.
 *   - `selectPipeline(host, …)` — entry-based caching for the production
 *     pipeline. Used by `createTileCommands` for color, blend, and the
 *     C-R1-GLOBE-RENDERSTATE no-cull underground variant.
 *   - `selectDebugFragmentPipeline(host, mode, …)` — cold-path selector
 *     for the per-fragment debug variants (TRIANGULATION / LOD / NORMAL).
 *     Returns null when the device probe failed for the augmented module.
 *
 * The 3 outside callers (in `createTileCommands`) now invoke the helpers
 * directly with `this`. The wireframe module's call to
 * `host._resolveGlobePipelineEntry` was also updated to call this
 * module's `resolveGlobePipelineEntry` directly so the renderer no
 * longer needs to expose a `_resolveGlobePipelineEntry` method on the
 * host interface.
 *
 * The 3 host fields these helpers reach into (beyond shader-factory
 * inheritance) are flipped from `private` to `public` on the renderer:
 * `_pipelineCache`, `_debugFragmentPipelineCache`, `_centralPipelineCache`.
 *
 * @module WebGPUGlobeSurfacePipelines
 */

import { ShaderDefine } from "./WebGPUShaderDefines.js";
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
   * NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — the pick pipeline color-target
   * format, mirrored from `context.pickPipelineFormat` by the renderer on
   * every scene-format generation bump. Equals `_canvasFormat` in SDR;
   * stays an 8-bit unorm when the scene target is float/HDR.
   */
  readonly _pickFormat?: GPUTextureFormat;
  readonly _pipelineLayout: GPUPipelineLayout | null;
  readonly _pipelineCache: Map<string, GlobePipelineEntry>;
  readonly _debugFragmentPipelineCache: Map<string, GlobePipelineEntry>;
  /**
   * C2-25 ENV-SCENE-CAPTURE (Batch 446) — SEPARATE cache for the single-target
   * scene-capture pipeline variants, keyed on
   * `faceFormat + captureDepthFormat + sampleCount=1 + CAPTURE_MODE`. It is
   * INTENTIONALLY disjoint from `_pipelineCache` and is NEVER wiped by the
   * on-screen `createTileCommands` `_scenePipelineFormatGeneration` reset — the
   * capture format is fixed by the env cube (`rgba8unorm` / `rgba16float`), not
   * the canvas, so a canvas-format / MSAA flip must not invalidate it, and a
   * capture build must not bump the on-screen generation (which would force a
   * full on-screen globe pipeline rebuild every frame capture is active).
   */
  readonly _capturePipelineCache: Map<string, GlobePipelineEntry>;
  /**
   * Read+write — the central pipeline cache reference. Captured lazily
   * by `createTileCommands` from `frameState.context`; this module never
   * writes it (the renderer's outer code does the lazy capture).
   */
  readonly _centralPipelineCache: WebGPURenderPipelineCache | null;
  /**
   * Session 65 Batch 32 — MSAA sample count for the scene framebuffer.
   * The renderer's outer code captures `context._msaaSamples` here so
   * `buildPipelineDescriptor` can bake the matching `multisample.count`
   * into each variant. Default 1 (single-sample, no MSAA) matches the
   * pre-bridge behavior. Bumps with the bridge re-enable (Batch 21
   * MSAA-FLEET work).
   */
  readonly _sampleCount?: number;
  /**
   * Renderer-wide log-depth master switch, mirrored from
   * `context._logDepthWriteEnabled` by the renderer each frame. When true, the
   * pipeline builds OR `ShaderDefine.LOG_DEPTH` into their defines (+ cache
   * key) so the globe writes `@builtin(frag_depth)` log depth. Default
   * false/undefined → the bit is 0 and pipelines are byte-identical.
   */
  readonly _logDepthEnabled?: boolean;
  /**
   * NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — SEPARATE pick-fleet master
   * switch mirror. `selectPickPipeline` ORs `LOG_DEPTH` from THIS flag (via the
   * `logDepthOverride` arg to `buildPipelineDescriptor`) so the globe pick
   * module gates on the pick switch, not the scene switch. Default
   * false/undefined → the globe pick stays byte-identical hyperbolic.
   */
  readonly _pickLogDepthEnabled?: boolean;
}

// ─── Render Pipelines (lazily created per actual vertex stride) ───
// C-R7-RENDERER-MIGRATION (Batch 75) — returns a cache-friendly
// `WebGPURenderPipelineDescriptor`; the actual `GPURenderPipeline` is
// materialized through `webgpuPipelineCache` so that two
// GlobeSurfaceRenderer instances (split-screen, multi-viewer) sharing
// the same descriptor share one pipeline. Naming preserved as a
// private rename: `_createPipelineVariant` → `buildPipelineDescriptor`.
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
  // NEW-GLOBE-TRANSLUCENCY-MULTI-PASS (Batch 177) — depth-only back-face
  // pre-pass variant for translucent globe rendering.
  depthOnlyBackFace: boolean = false,
  // NEW-GLOBE-TRANSLUCENCY-MULTI-PASS (Batch 182) — translucent back-face
  // variant. Sits between the depth-only pre-pass (Batch 177) and the
  // standard translucent front-face command, completing the 3-pass
  // technique. When `true`:
  //   - cullMode: "front" (back faces only — blend FAR side first)
  //   - blend: ALPHA (forced regardless of `isBlend` input)
  //   - depthWriteEnabled: false (depth was already written by the
  //     pre-pass; this pass tests against it but doesn't overwrite)
  //   - colorWriteMask: 0xf (full color output)
  //
  // The caller dispatches this AFTER the depth-only back-face pre-pass
  // and BEFORE the translucent front-face command. The depth pre-pass
  // populates depth with the back-face surface; this pass blends the
  // back-face color over the cleared FB; the front-face command blends
  // its color over the back-face contribution. Final composite: correct
  // front-to-back ordering through the translucent planet instead of
  // the unsorted single-pass alpha blend used pre-Batch-182.
  translucentBackFace: boolean = false,
  // C2-25 ENV-SCENE-CAPTURE (Batch 446) — when set to a cube-face texture
  // format, builds the SINGLE-color-target scene-capture variant: ORs
  // `ShaderDefine.CAPTURE_MODE` into the defines (the production module then
  // drops the G-buffer slot-1 `@location(1)` output), emits ONE color target
  // (`{format: captureFaceFormat}`, no MRT slot-1), a no-stencil `depth24plus`
  // depth target, and NO MSAA — matching the transient per-face capture render
  // pass into `cache.faceViews[face]`. `undefined` (the default, every
  // on-screen call site) is byte-identical to the pre-446 descriptor.
  captureFaceFormat?: GPUTextureFormat,
  // GLOBE-TRANSLUCENCY-ALPHA — depth-only FRONT-face pre-pass variant.
  // Mirrors WebGL's DEPTH_ONLY_FRONT_FACE derived command
  // (GlobeTranslucencyState.js getDepthOnlyFrontFaceRenderState): cull BACK
  // faces (front faces only), colorWriteMask 0, depth-write enabled. Used
  // when the globe is translucent with an OPAQUE back face (the default
  // backFaceAlpha = 1): the color command switches to the depth-read-only
  // ALPHA-blend variant, so this pre-pass is what keeps the scene depth
  // populated with the near globe surface (sky/atmosphere gating, depth
  // plane, later primitives, pickPosition all read it).
  depthOnlyFrontFace: boolean = false,
  // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — when defined, this replaces
  // `host._logDepthEnabled` in the LOG_DEPTH define/module decision. The pick
  // pipeline (selectPickPipeline) passes `host._pickLogDepthEnabled` so the
  // globe pick module gates on the SEPARATE pick-fleet master switch. undefined
  // (every color/other call site) is byte-identical to before.
  logDepthOverride?: boolean,
): WebGPURenderPipelineDescriptor {
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
  // with the pipeline's vertex buffer layout. Batch 246 — the reduced-
  // imagery bit rides along on default-limit devices so the module's
  // group-1 declarations match the 1-slot pipeline layout.
  const isCapture = captureFaceFormat !== undefined;
  // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH — the pick pipeline overrides the log state
  // with the SEPARATE pick-fleet master switch; every other call site passes
  // undefined and keeps the scene `_logDepthEnabled`.
  const logDepthOn = logDepthOverride ?? host._logDepthEnabled;
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (logDepthOn ? ShaderDefine.LOG_DEPTH : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0) |
    // C2-25 (Batch 446) — capture variant drops the G-buffer slot-1 output so
    // the fragment stage matches the single-color-target capture pipeline.
    (isCapture ? ShaderDefine.CAPTURE_MODE : 0);
  const productionModule = getProductionShaderModuleHelper(host, defines);
  // Phase 5 WGF-1: when the hardware clip-distances variant is requested,
  // both stages must come from the augmented module — the vertex stage
  // declares the `@builtin(clip_distances)` output, and the fragment
  // stage's `globeClipByPlanes` discard has been neutralized to avoid
  // double-clipping.
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
    // If null, the augmentation failed and we silently fall back to the
    // production module + the legacy fragment-discard path. The caller's
    // cache key still distinguishes useClipDistances=true variants, so
    // we just hand back a "production" pipeline under that key.
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

  // NEW-GLOBE-TRANSLUCENCY-MULTI-PASS (Batches 177 + 182) — variant
  // overrides for the 3-pass globe-translucency technique:
  //   - depthOnlyBackFace (Batch 177): cullMode=front, color masked,
  //     depth-write enabled. Populates depth from FAR side.
  //   - translucentBackFace (Batch 182): cullMode=front, ALPHA blend,
  //     depth-write disabled. Blends FAR-side color first.
  //   - default (translucent FF or opaque): cullMode from disableCulling
  //     toggle.
  // Cache key suffixes (`_DOB`, `_TBF`) keep the three variants distinct.
  const dobLabel = depthOnlyBackFace ? ", depthOnlyBackFace" : "";
  const dofLabel = depthOnlyFrontFace ? ", depthOnlyFrontFace" : "";
  const tbfLabel = translucentBackFace ? ", translucentBackFace" : "";
  // Batch 246 — the central pipeline cache keys on the descriptor name
  // (plus structural fields); the reduced-imagery variant has a
  // different pipeline layout + shader module, so it MUST carry a
  // distinct name to avoid stale-pipeline aliasing in any shared cache.
  const imgLabel = host._imageryReduced ? ", imagery1" : "";
  const cullMode: GPUCullMode =
    depthOnlyBackFace || translucentBackFace
      ? "front"
      : depthOnlyFrontFace
        ? "back"
        : disableCulling
          ? "none"
          : "back";
  // GLOBE-UNDERGROUND-COLOR — the central pipeline cache keys on the
  // descriptor NAME (see `generateCacheKey` in WebGPURenderPipelineCache:
  // `parts = [descriptor.name]` when no variant is passed, and the globe's
  // `resolveGlobePipelineEntry` passes none). The no-cull (C-R1 underground /
  // provider-cull-off) variant previously differed ONLY in `primitive.cullMode`
  // with an identical name, so it ALIASED to whichever same-named pipeline
  // resolved first — usually the above-ground cull-back one. Symptom: with the
  // camera underground the terrain-surface back-faces never rasterized (only
  // the skirt walls, whose winding faces the camera, were visible) and the
  // result was nondeterministic across sessions (a creation race decided which
  // cull mode won). The `, noCull` marker keeps the central-cache key distinct,
  // matching the dob/tbf/cd/img labels that already follow this convention.
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

  // C2-25 ENV-SCENE-CAPTURE (Batch 446) — the capture variant renders into a
  // single cube-face color attachment (no MRT slot-1), a no-stencil
  // `depth24plus` depth target, and NO MSAA. The CAPTURE_MODE shader define
  // (folded into `defines` above) drops the `@location(1)` output so the
  // fragment stage matches the single target. The `_cap_<format>` name suffix
  // keeps the capture pipeline distinct in any shared cache.
  const capLabel = isCapture ? `, capture ${captureFaceFormat}` : "";
  // C11-158 — the enhanced-ocean STYLING variant compiles a DIFFERENT
  // GlobeTerrain module (the `ENHANCED_OCEAN` hi-word branch, via
  // `getProductionShaderModule` reading `host._enhancedOceanEnabled`). The
  // central pipeline cache keys on this descriptor name, so it MUST carry a
  // distinct marker or the enhanced + classic pipelines would alias. The
  // renderer-local pipeline caches (keyed without the hi word) are wiped on the
  // flag flip instead — see `WebGPUGlobeSurfaceRenderer._applyEnhancedOceanState`.
  const oceanLabel = host._enhancedOceanEnabled ? ", enhOcean" : "";
  return {
    name: `Globe terrain (${quantLabel}, ${normLabel}, ${blendLabel}${debugLabel}${cdLabel}${dobLabel}${dofLabel}${tbfLabel}${ncLabel}${imgLabel}${capLabel}${oceanLabel})`,
    layout: host._pipelineLayout!,
    vertex: {
      module: vertexModule,
      entryPoint,
      buffers: vertexBuffers,
    },
    fragment: {
      module: fragmentModule,
      entryPoint: fragmentEntry,
      // Slice 5c-B Batch 117 — globe pipeline emits BOTH targets now
      // that GlobeTerrain.wgsl's fragmentMain + the 3 debug variants
      // were rewired to return `FragOutput { @location(0) color,
      // @location(1) normalRoughness }` (see migration_doc/
      // WEBGPU_DEBUGGING_LOG.md Batch 117). Slot 1 is the eye-space
      // normal + roughness packed as rgba16float; consumers (AO today,
      // SSR / clustered lighting / contact shadows next) read it via
      // `gBufferFramebuffer.normalRoughnessTexture` and fall back to
      // the depth-derived path when the slot-1 sample is the
      // (0,0,0,*) sentinel emitted by debug-Tri / non-globe pixels.
      //
      // Depth-only back-face variant: still 0xf on slot 1 — the
      // `colorWriteMask=0` applies only to slot 0 (the canvas color)
      // because the variant is "depth-only" with respect to the SCENE
      // color, not the G-buffer. The G-buffer normal IS useful even
      // during the depth-only pre-pass (the back-faces it draws are
      // real geometry whose normals should populate the G-buffer for
      // any consumer that needs them). If a follow-up needs to mask
      // slot 1 too, gate `gbufferWriteMask` on `depthOnlyBackFace`.
      targets: isCapture
        ? // C2-25 (Batch 446) — single cube-face color target, no MRT slot-1.
          // Opaque write (no blend; the per-face pass composites globe OVER the
          // compute sky via the render-pass `loadOp: 'load'`, not a blend op).
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
      // C-R1-GLOBE-RENDERSTATE (Batch 99) — `disableCulling` opens
      // up the under-the-globe / globe-translucent path which needs
      // both faces visible. Mirrors WebGL's selection between
      // `_renderState` (cull on) and `_disableCullingRenderState`
      // (cull off) in `GlobeSurfaceTileProviderRendering.js:1226-1231`.
      // NEW-GLOBE-TRANSLUCENCY-MULTI-PASS (Batch 177) — depth-only
      // back-face overrides to "front" (cull front faces, draw back).
      cullMode,
      frontFace: "ccw",
    },
    depthStencil: {
      // C2-25 (Batch 446) — capture uses a transient no-stencil `depth24plus`
      // target (deliberately different from the on-screen
      // `depth24plus-stencil8`, which is precisely WHY the capture pipeline
      // variant is mandatory — a single-target/no-stencil mismatch against the
      // on-screen pipeline would be a WebGPU validation error).
      format: isCapture
        ? ("depth24plus" as GPUTextureFormat)
        : "depth24plus-stencil8",
      depthWriteEnabled,
      // ALWAYS use less-equal (not less), even for the first pass.
      // Planetary-scale FP32 precision can push the globe's clip-space
      // Z up against the far plane, and the paired vertex-shader clamp
      // `position.z = min(position.z, position.w)` produces exactly
      // z/w=1 for those vertices. `less` would discard them; we need
      // `less-equal` so they survive the depth test against the
      // cleared depth buffer (which starts at 1.0).
      depthCompare: "less-equal",
    },
    // Session 65 Batch 32 — match scene FB sample count. C2-25 (Batch 446) —
    // the capture pass is always single-sample (no MSAA), so force `undefined`.
    multisample:
      !isCapture && (host._sampleCount ?? 1) > 1
        ? { count: host._sampleCount! }
        : undefined,
  };
}

/**
 * Convert our cache-friendly descriptor back into the WebGPU
 * descriptor shape for the fallback path (no central cache available).
 * Pure function — does not need the host.
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
 * C-R7-RENDERER-MIGRATION (Batch 75). Mirrors `tryResolvePolylinePipeline`.
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
 * C2-25 ENV-SCENE-CAPTURE (Batch 446) — SYNCHRONOUS resolve for the scene-capture
 * pipeline. Unlike {@link resolveGlobePipelineEntry} (which returns null while
 * `createRenderPipelineAsync` cooks), this creates the pipeline synchronously via
 * `device.createRenderPipeline` on the first miss so the very FIRST capture pass
 * renders terrain — there is no "render every frame so a 1-frame pipeline delay
 * is invisible" cover for the capture path: the capture pass runs at most every
 * K frames AND `runProceduralSkyFill` rewrites the whole cube each refresh, so a
 * missed terrain composite leaves the face showing pure sky until the NEXT
 * refresh. A handful of async-pending capture frames therefore reads back as a
 * permanently flat (sky-only) reflection in any short-lived / debounced capture
 * window. The one-time synchronous compile stall (one variant per face format,
 * realistically one) is acceptable for an opt-in, debounced pass and is far
 * preferable to flat reflections.
 *
 * Still seeds the central cache's async path (so later frames + any on-screen
 * sibling that happens to want the same key hit the cache) but does NOT depend on
 * it for correctness.
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

// ═══════════════════════════════════════════════════════════════════════
// Pipeline Selection (lazy creation, keyed by actual vertex stride)
// ═══════════════════════════════════════════════════════════════════════

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
  // Phase 5 WGF-1: cache key includes a `C` suffix for the
  // hardware clip-distances variant so it shares the production cache
  // map cleanly without colliding with the legacy variants.
  // Batch 20: the active-defines bitmask (DP-H25's `GEODETIC_NORMAL`
  // and any future flags) appears as a `|0xNN` hex suffix so the
  // pipeline cache stays in sync with the shader module cache key.
  // C-R7-RENDERER-MIGRATION (Batch 75): the local Map now holds entry
  // slots; the GPU pipeline materializes through `webgpuPipelineCache`.
  // Returns null when the central cache hasn't materialized the
  // pipeline yet — the caller should skip this tile this frame.
  //
  // C-R1-GLOBE-RENDERSTATE (Batch 99): `disableCulling` adds a `_NC`
  // (no-cull) suffix to the cache key so underground / globe-
  // translucent tiles get a separate pipeline variant with
  // `cullMode: "none"`. Mirrors WebGL's
  // `tileProvider._disableCullingRenderState` selection at
  // `GlobeSurfaceTileProviderRendering.js:1226-1231` — picked when
  // `cameraUnderground || globeTranslucencyState.translucent`.
  // Without this variant, underground tiles render with cull-back and
  // their interior faces disappear at the rim.
  const cdSuffix = useClipDistances ? "_CD" : "";
  const ncSuffix = disableCulling ? "_NC" : "";
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (host._logDepthEnabled ? ShaderDefine.LOG_DEPTH : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0);
  const cacheKey = `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}${isBlend ? "B" : "O"}_${strideBytes}${cdSuffix}${ncSuffix}|${defines.toString(16)}`;
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

  // NEW-WEBGPU-PIPELINE-READY-SIGNAL (Phase 4) — warm-on-suspicion.
  // When the OPAQUE variant is requested for the first time, kick off
  // background creation of the BLEND counterpart so a future
  // globe-translucency toggle finds a hot pipeline. Only fires on the
  // first request per (stride, normals, mercator, ...) combo because
  // the cache.warm() call is no-op once the entry is cached or
  // pending. Skip the inverse direction (BLEND → OPAQUE warm) because
  // OPAQUE is the default state and almost always already cached by
  // the time a BLEND request fires.
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
 * C2-25 ENV-SCENE-CAPTURE (Batch 446) — select the single-color-target globe
 * terrain CAPTURE pipeline variant for the dynamic-environment-map scene-capture
 * pass. Renders the opaque globe surface into ONE cube-face color attachment
 * (`captureFaceFormat`), a transient no-stencil `depth24plus` depth target, and
 * no MSAA. The CAPTURE_MODE shader define drops the G-buffer slot-1 output so
 * the fragment stage matches the single target.
 *
 * Routes through the SEPARATE `_capturePipelineCache` so it never collides with
 * — and a capture build never invalidates — the on-screen `_pipelineCache`. The
 * cache key includes the face format (so an HDR env cube gets its own pipeline)
 * plus the standard vertex / shader-define dimensions; `isBlend` is hardcoded
 * false (capture is opaque, depth-write, single-pass).
 *
 * Culling is DISABLED (`cullMode: "none"`). The 6 ENU cube-face cameras are
 * built with a screen-matched basis (camera-right = +∂s, camera-up = −∂t of the
 * cube's `faceUvToDirection` convention) so the rendered texel lands exactly
 * where the sky fill + IBL prefilter sample it back — a cube render is inherently
 * left-handed under that convention, which flips triangle winding. Rather than
 * fight the winding sign per face, the capture pass disables culling and lets the
 * depth test pick the nearest surface (correct for a reflection source). See
 * `WebGPUDynamicEnvironmentMapCapture.buildCubeFaceCamera`.
 *
 * Resolves the pipeline SYNCHRONOUSLY (see `resolveCapturePipelineEntrySync`) so
 * the very first capture pass draws terrain: the capture pass is debounced + the
 * sky fill rewrites the whole cube each refresh, so an async-pending capture
 * frame would read back as a permanently-flat (sky-only) reflection. Returns null
 * only if the device is unavailable (then the caller omits this tile this frame).
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
  const cacheKey = `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}O_${strideBytes}_CAP_${captureFaceFormat}|${defines.toString(16)}`;
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
  // Synchronous resolve (NOT the async `resolveGlobePipelineEntry`): the capture
  // pass is debounced + sky-rewrites each refresh, so an async-pending frame
  // reads back as a permanently-flat (sky-only) reflection. Build the one capture
  // variant synchronously on first miss so the first capture draws terrain.
  return resolveCapturePipelineEntrySync(host, entry);
}

/**
 * DP-H44 (Batch 360) — select the globe terrain PICK pipeline variant.
 *
 * Derives from the OPAQUE color descriptor for the same vertex variant
 * (`buildPickPipelineDescriptor` swaps the fragment entry to
 * `fragmentPickMain`, strips blend + MSAA, stamps exactly one color target
 * with `host._pickFormat` — `context.pickPipelineFormat`, the byte-object-ID
 * authority shared with `WebGPUPickFramebuffer` — and forces
 * `depthWriteEnabled: true`). The result targets the single pick-FBO color
 * attachment in both SDR and HDR and writes standard rasterizer depth,
 * matching the model / primitive pick pipelines.
 *
 * Cache key shares the layout / vertex / shader-define dimensions with
 * `selectPipeline` and adds a `_PICK` suffix so it doesn't collide. `isBlend`
 * and `disableCulling` are hardcoded false — the pick pass is always opaque
 * with standard back-face culling (mirrors the color first pass).
 *
 * Returns null while the pipeline is materializing through the central cache;
 * the caller omits the pick command for this tile this frame (the color
 * command still renders, so the only effect is a one-frame gap in globe
 * pick coverage — `scene.pick` over a just-appeared tile variant).
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
  const cdSuffix = useClipDistances ? "_CD" : "";
  // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — the globe PICK module gates
  // LOG_DEPTH on the SEPARATE pick-fleet master switch, NOT the scene switch,
  // so the pick FBO is uniformly hyperbolic OR log across the whole fleet.
  const pickLogActive = host._pickLogDepthEnabled ?? false;
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (pickLogActive ? ShaderDefine.LOG_DEPTH : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0);
  const cacheKey = `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}O_${strideBytes}${cdSuffix}_PICK|${defines.toString(16)}`;
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
      // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH — force the pick module's LOG_DEPTH to
      // the pick-fleet switch (the pick reuses this descriptor's vertex + FS
      // module, so both stages get the pick-gated v_logDepth path).
      pickLogActive,
    );
    const descriptor = buildPickPipelineDescriptor(
      colorDescriptor,
      "fragmentPickMain",
      // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — stamp the context's pick
      // format authority (mirrored onto the host), never the scene format.
      host._pickFormat ?? "rgba8unorm",
      {
        name: `${colorDescriptor.name} pick`,
        forceDepthWriteEnabled: true,
      },
    );
    entry = { descriptor, pipeline: null, pending: false };
    host._pipelineCache.set(cacheKey, entry);
  }
  // DP-H44 — create the pick pipeline SYNCHRONOUSLY rather than routing through
  // the central async cache (`resolveGlobePipelineEntry`). The central cache's
  // async `getPipeline` path silently never resolves for this pick-descriptor
  // shape (single color target + `multisample: undefined`, derived by
  // `buildPickPipelineDescriptor`), leaving the entry permanently null — so the
  // globe pick command would never attach. Sync creation is the documented
  // cache-less fallback (`resolveGlobePipelineEntry` uses the same call when no
  // central cache is present) and is cheap here: the WGSL module is already
  // compiled for the color pipeline (shared module), so this only assembles the
  // pipeline object, once per variant (cached in `entry.pipeline`).
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
 * NEW-GLOBE-TRANSLUCENCY-MULTI-PASS (Batch 182) — select the translucent
 * back-face pipeline variant. Sits between the depth-only back-face
 * pre-pass (Batch 177) and the regular translucent front-face command,
 * completing the 3-pass globe-translucency technique:
 *
 *   1. Depth-only back-face: writes depth from FAR side of the globe
 *      (Batch 177's `selectDepthOnlyBackFacePipeline`).
 *   2. Translucent back-face (this variant): blends the FAR-side surface
 *      color over the cleared FB. cullMode: "front", blend: ALPHA,
 *      depthWriteEnabled: false.
 *   3. Translucent front-face: blends the NEAR-side surface over the
 *      back-face contribution. Uses the existing `selectPipeline` with
 *      `disableCulling=false` (cullMode: "back" front-face only) and
 *      `isBlend=true`.
 *
 * This produces correct front-to-back compositing through the planet
 * instead of the unsorted single-pass alpha blend (cullMode: "none")
 * used pre-Batch-182 for translucent globe rendering.
 *
 * Returns null while the pipeline is materializing in the central
 * cache. Caller skips the translucent-back-face command for this
 * tile this frame; the regular translucent + depth-only commands
 * still emit, so the visible artifact is "missing back-face
 * contribution for one frame" rather than a black tile.
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
  const cdSuffix = useClipDistances ? "_CD" : "";
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (host._logDepthEnabled ? ShaderDefine.LOG_DEPTH : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0);
  // `isBlend=true` forces the ALPHA blend state; `_TBF` (translucent
  // back-face) suffix distinguishes from the standard blend variant
  // which cullMode: "back" (front-face). _TBF means cullMode: "front"
  // (back-face) with the same alpha blend.
  const cacheKey = `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}B_${strideBytes}${cdSuffix}_TBF|${defines.toString(16)}`;
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
 * NEW-GLOBE-TRANSLUCENCY-MULTI-PASS (Batch 177) — select the depth-only
 * back-face pre-pass pipeline variant.
 *
 * Used by the globe surface renderer when `globeTranslucencyState.translucent`
 * is true: emits one depth-only command per tile BEFORE the imagery-
 * layer translucent commands. Populates the scene-FB depth attachment
 * with the FAR side of the globe (cullMode: "front") so the
 * subsequent translucent passes blend correctly against it. Without
 * this pre-pass, looking through the planet at antipodal terrain
 * produces inside-out z-fight artifacts in the alpha-blended single-
 * pass technique.
 *
 * Cache key shares the layout / vertex / shader-define dimensions with
 * `selectPipeline` and adds a `_DOB` suffix so it doesn't collide. The
 * variant is independent of imagery-layer multi-pass (no `_B`/`_O`
 * dimension because no color is written) — `isBlend = false` is hard-
 * coded for the cache key, but the depth-only override would produce
 * the same pipeline regardless.
 *
 * Doesn't take `disableCulling` because the depth-only variant always
 * culls FRONT faces (back-face only) by definition; combining with
 * `disableCulling: true` (cull none) would defeat the purpose.
 *
 * @returns null while the pipeline is materializing through the central
 *   cache; the caller should skip the depth-only command for this
 *   tile this frame and let the next frame (when the pipeline lands)
 *   start emitting it. The translucent commands continue to render
 *   without the pre-pass — a one-frame degraded artifact instead of
 *   a permanent black tile.
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
  const cdSuffix = useClipDistances ? "_CD" : "";
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (host._logDepthEnabled ? ShaderDefine.LOG_DEPTH : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0);
  // Use the same cache key shape as `selectPipeline` for diagnostic
  // readability. `isBlend=false` and `disableCulling=false` are
  // hardcoded since the depth-only override supersedes both axes.
  const cacheKey = `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}O_${strideBytes}${cdSuffix}_DOB|${defines.toString(16)}`;
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
 * GLOBE-TRANSLUCENCY-ALPHA — select the depth-only FRONT-face pre-pass
 * pipeline variant.
 *
 * Used by the globe surface renderer when the globe is translucent with an
 * OPAQUE back face (the default — `backFaceAlpha = 1`). Mirrors WebGL's
 * DEPTH_ONLY_FRONT_FACE derived command: the translucent color command runs
 * with depth-write OFF (ALPHA blend variant), so this pre-pass is what keeps
 * the scene-FB depth attachment populated with the NEAR globe surface —
 * sky/atmosphere gating, the depth plane, subsequently-rendered primitives,
 * and `pickPosition` all read that depth. Without it, the depth buffer holds
 * no globe surface at all and the sky pass floods the planet disk.
 *
 * Cache key mirrors `selectDepthOnlyBackFacePipeline` with a `_DOF` suffix.
 *
 * @returns null while the pipeline is materializing through the central
 *   cache; the caller skips the pre-pass command for this tile this frame
 *   (one-frame degraded depth instead of a permanent black tile).
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
  const cdSuffix = useClipDistances ? "_CD" : "";
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (host._logDepthEnabled ? ShaderDefine.LOG_DEPTH : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0);
  const cacheKey = `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}O_${strideBytes}${cdSuffix}_DOF|${defines.toString(16)}`;
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
  // Probe the augmented shader module first; the probe is define-keyed
  // and the `null` cache entry short-circuits pipeline builds when the
  // device rejected the augmented source for this define-set. Passing
  // the actual defines (instead of the pre-Batch 20 zero-arg call that
  // sat here as a sentinel) gives the per-define cache the right key
  // AND prevents an accidental compile probe with mismatched defines
  // from blocking the cache of another set.
  if (!getDebugFragmentShaderModuleHelper(host, defines)) {
    return null;
  }
  const cacheKey = `${mode}_${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}${isBlend ? "B" : "O"}_${strideBytes}|${defines.toString(16)}`;
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
