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
  readonly _pipelineLayout: GPUPipelineLayout | null;
  readonly _pipelineCache: Map<string, GlobePipelineEntry>;
  readonly _debugFragmentPipelineCache: Map<string, GlobePipelineEntry>;
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
  // with the pipeline's vertex buffer layout.
  const defines = hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0;
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
  const tbfLabel = translucentBackFace ? ", translucentBackFace" : "";
  const cullMode: GPUCullMode =
    depthOnlyBackFace || translucentBackFace
      ? "front"
      : disableCulling
        ? "none"
        : "back";
  const depthWriteEnabled = depthOnlyBackFace
    ? true
    : translucentBackFace
      ? false
      : !isBlend;
  // Force ALPHA blend for translucent back-face regardless of `isBlend`
  // input; the variant is by-definition translucent.
  const effectiveBlend = depthOnlyBackFace
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
  const colorWriteMask: GPUColorWriteFlags = depthOnlyBackFace ? 0 : 0xf;

  return {
    name: `Globe terrain (${quantLabel}, ${normLabel}, ${blendLabel}${debugLabel}${cdLabel}${dobLabel}${tbfLabel})`,
    layout: host._pipelineLayout!,
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
          format: host._canvasFormat,
          blend: effectiveBlend,
          writeMask: colorWriteMask,
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
      format: "depth24plus-stencil8",
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
    // Session 65 Batch 32 — match scene FB sample count.
    multisample:
      (host._sampleCount ?? 1) > 1 ? { count: host._sampleCount! } : undefined,
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
  const defines = hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0;
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
  const defines = hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0;
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
  const defines = hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0;
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
  const defines = hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0;
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
