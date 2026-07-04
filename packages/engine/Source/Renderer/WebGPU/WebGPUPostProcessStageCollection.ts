/**
 * WebGPU Post-Process Stage Collection
 *
 * Integration layer that connects PostProcessStageCollection.js to the
 * WebGPUPostProcessPipeline infrastructure.
 *
 * This module has two roles:
 *
 * 1. **Feature renderer sync** (`updateWebGPUPostProcessStages`):
 *    Called by PostProcessStageCollection.update() via the feature renderer
 *    pattern (FeatureRendererKey.POST_PROCESS_COLLECTION). Caches the enabled/
 *    disabled state so the pipeline can read it without touching scene-layer objects.
 *
 * 2. **Pipeline configuration** (`configureWebGPUPostProcessPipeline`):
 *    Called by WebGPUSceneRenderer._ensureResources() to lazily initialize
 *    WebGPU effects (bloom, AO, DoF) on the pipeline when first enabled,
 *    and to sync enable/disable state each frame.
 *
 * Effects are fullscreen image-space operations — they apply to everything
 * in the rendered scene buffer (terrain, 3D tiles, Gaussian splats, models, etc.)
 * after the scene is composited. Users control them via the standard CesiumJS API:
 *
 *   scene.postProcessStages.fxaa.enabled = true;
 *   scene.postProcessStages.bloom.enabled = true;
 *   scene.postProcessStages.ambientOcclusion.enabled = true;
 *
 * @module WebGPUPostProcessStageCollection
 */

import {
  WebGPUPostProcessPipeline,
  TonemapMode,
} from "./WebGPUPostProcessPipeline.js";
// WIRE-PP-LIBRARY-BUILTINS — well-known PostProcessStageLibrary stage
// names intercepted and substituted with their WGSL twins.
import {
  getLibraryStageKey,
  type LibraryStageFrameContext,
} from "./WebGPULibraryPostProcessStage.js";
import oneTimeWarning from "../../Core/oneTimeWarning.js";

export interface PostProcessCache {
  initialized: boolean;
  fxaaEnabled: boolean;
  tonemappingEnabled: boolean;
  tonemapMode: number;
  ambientOcclusionEnabled: boolean;
  bloomEnabled: boolean;
  depthOfFieldEnabled: boolean;
  // Audit A.11 (Batch 133) -- GodRay (volumetric light scattering)
  // post-process. Activated via `scene.godRayEnabled = true` (optional
  // `scene.godRayConfig`); the per-frame configure pass updates the
  // sun screen UV from `scene.sun.position` projected through
  // viewProjection.
  godRayEnabled: boolean;
  godRayInitialized: boolean;
  // Atmospheric Effects Phase B (Batch 417b) -- HeatShimmer (animated
  // screen-space UV-warp) post-process. Activated via
  // `scene.heatShimmerEnabled = true`, intensity via
  // `scene.heatShimmerIntensity` (ad-hoc scene flags pushed by the
  // atmospheric auto-master in 417a). The per-frame configure pass pushes
  // the elapsed-seconds clock + intensity and keeps the scene rendering.
  heatShimmerEnabled: boolean;
  heatShimmerInitialized: boolean;
  // Atmospheric Effects Phase D (Batch 422) -- ColdOptics (22 ice-crystal
  // halo + sun-dogs) sky overlay. Activated via `scene.coldOpticsEnabled =
  // true`, intensity via `scene.coldOpticsIntensity` (ad-hoc scene flags
  // pushed by the atmospheric auto-master in 417a from sub-freezing
  // temperature). The per-frame configure pass pushes the camera/sun/inverse-
  // matrix uniforms and keeps the scene rendering.
  coldOpticsEnabled: boolean;
  coldOpticsInitialized: boolean;
  // Track V-A2 (NEW-ATMO-AERIAL-PERSPECTIVE-POSTPROCESS) — unified per-pixel
  // atmosphere. Activated via `scene.aerialPerspective = true` (optional
  // `scene.aerialPerspectiveConfig`). The per-frame configure pass pushes
  // camera/sun/atmosphere uniforms + the Bruneton transmittance LUT view.
  aerialPerspectiveEnabled: boolean;
  aerialPerspectiveInitialized: boolean;
  // WIRE-COLORGRADING-CALLER (Batch 480) — ColorGrading stage, scene-level
  // opt-in (`scene.colorGradingEnabled = true`, optional
  // `scene.colorGradingConfig`). No upstream PostProcessStageCollection
  // slot exists for grading (WebGL only reaches it via user-added custom
  // stages), so this mirrors the godRay scene-flag pattern. The stage runs
  // after Tonemap in the pipeline's single-pass chain (see the
  // ColorGrading.wgsl header + WebGPUPostProcessPipeline.execute()).
  colorGradingEnabled: boolean;
  colorGradingInitialized: boolean;
  // Last-applied config object reference — a NEW object assigned to
  // `scene.colorGradingConfig` at runtime replaces the full uniform block
  // via updateColorGradingUniforms() (identity check, so per-frame reads
  // of a stable object cost nothing).
  _colorGradingConfigRef?: object;
  // Track whether complex effects have been initialized on the pipeline
  bloomInitialized: boolean;
  aoInitialized: boolean;
  dofInitialized: boolean;
  // Track bloom/AO uniform values for dirty checking. The bloom set
  // mirrors ALL six `scene.postProcessStages.bloom.uniforms` 1:1
  // (NEW-BLOOM-UNIFORM-PARITY, Batch 240). Written ONLY by the
  // configure pass — `updateWebGPUPostProcessStages` must not refresh
  // them, or the configure-side dirty check can never fire.
  bloomContrast: number;
  bloomBrightness: number;
  bloomDelta: number;
  bloomSigma: number;
  bloomStepSize: number;
  bloomGlowOnly: boolean;
  aoIntensity: number;
  aoBias: number;
  // NEW-POSTPROCESS-USER-WGSL (Batch 198 first slice; Batch 199
  // formalization). Tracks whether `_userStages` on the pipeline has
  // been populated from `scene.postProcessStages._stages` already this
  // session. Set on first build, reset to `false` when the user
  // collection's stage list empties so the configure pass re-builds.
  _userStagesBuilt?: boolean;
  // NEW-POSTPROCESS-USER-WARN-PROD (Batch 290) — the user-stage list
  // length last consumed by a (re)build. The prior gate only re-scanned
  // the list on first build or when it EMPTIED, so a runtime
  // `postProcessStages.add(...)` (list 1→2, or the first add after the
  // empty-list first frame already flipped `_userStagesBuilt` true) never
  // rebuilt — neither compiling a runtime-added WGSL stage NOR firing the
  // GLSL-drop warning. Tracking the length lets the configure pass detect
  // any add/remove and re-scan, so the un-stripped warning actually
  // reaches users (and runtime WGSL stages compile). `undefined` until
  // the first build.
  _userStagesCount?: number;
  // NEW-WEBGPU-PP-LIBRARY-DEMO — the stage INSTANCES last consumed by a
  // (re)build. Count-only detection (above) misses a same-frame
  // remove()+add() swap (count 1→0→1 between configure calls), which left
  // the PREVIOUS stage's WGSL twin running — e.g. cycling library builtins
  // via `stages.remove(old); stages.add(new)` kept rendering the old
  // effect. Comparing element-wise identity against the live list catches
  // any composition change at equal length. `undefined` until first build.
  _userStagesRefs?: unknown[];
}

// Narrow a polymorphic PostProcessStage uniform value to a number for
// the dominant numeric-scalar reads (intensity, sigma, threshold, etc.).
// Returns the default when the uniform is undefined or carries a non-
// numeric value (the AO algorithm discriminator is the lone string-typed
// uniform — it has its own narrowing path at the read site). The pattern
// matches `Cesium.defaultValue(value, default)` semantics.
function numU(v: number | string | boolean | undefined, d: number): number {
  return typeof v === "number" ? v : d;
}

function getDefaultCache(): PostProcessCache {
  return {
    initialized: false,
    fxaaEnabled: false,
    // Session 65 cont. fix — default to FALSE to match WebGL's
    // `PostProcessStageCollection` (line 57: `tonemapping.enabled =
    // false; // will be enabled if necessary in update`).
    //
    // Previously defaulted to true, which caused the Tonemap stage to
    // run with Reinhard + sRGB encode on every frame on the bgra8unorm
    // SDR pipeline. The result: globe imagery (linear 0.1, 0.2, 0.4)
    // got tonemapped to (~0.725, 0.831, 0.902) before reaching the
    // canvas — root cause of NEW-VR2-3 "imagery wash-out" (Session 65
    // triage). Verified via a debug-return probe: globe shader emits
    // (0.1, 0.2, 0.4); canvas reads back (185, 212, 230) ≈ same
    // x/(x+0.087) Reinhard + pow(., 1/2.2) curve.
    //
    // Cesium's WebGL path tonemap.enabled flips to true only when
    // `useHdr === true` (PostProcessStageCollection.update line 575).
    // The sync layer below honors that via the `_tonemapping.enabled`
    // read — but if the WebGL collection has never been touched
    // (e.g., the WebGPU FR for POST_PROCESS_COLLECTION runs before
    // PostProcessStageCollection's constructor finishes setting
    // `_tonemapping`), the cache stays at this default. False matches
    // SDR-by-default; HDR turns it on via the cache.tonemappingEnabled
    // read below.
    tonemappingEnabled: false,
    tonemapMode: TonemapMode.REINHARD,
    ambientOcclusionEnabled: false,
    bloomEnabled: false,
    depthOfFieldEnabled: false,
    godRayEnabled: false,
    godRayInitialized: false,
    heatShimmerEnabled: false,
    heatShimmerInitialized: false,
    coldOpticsEnabled: false,
    coldOpticsInitialized: false,
    aerialPerspectiveEnabled: false,
    aerialPerspectiveInitialized: false,
    colorGradingEnabled: false,
    colorGradingInitialized: false,
    bloomInitialized: false,
    aoInitialized: false,
    dofInitialized: false,
    // WebGL defaults from PostProcessStageLibrary.createBloomStage
    // (contrast/brightness) + createBlur (delta/sigma/stepSize).
    bloomContrast: 128.0,
    bloomBrightness: -0.3,
    bloomDelta: 1.0,
    bloomSigma: 2.0,
    bloomStepSize: 1.0,
    bloomGlowOnly: false,
    aoIntensity: 3.0,
    aoBias: 0.1,
  };
}

/**
 * Batch 98 — locate the upstream DoF composite stage by name. The
 * fork's `cache.depthOfFieldEnabled = collection._depthOfField?.enabled`
 * read was always false because the upstream `PostProcessStageCollection`
 * never exposed a `_depthOfField` slot — DoF is only available via
 * `scene.postProcessStages.add(PostProcessStageLibrary.createDepthOfFieldStage())`.
 * That helper returns a `PostProcessStageComposite` with the well-known
 * name `czm_depth_of_field` whose own `enabled` flag controls visibility.
 *
 * Returns the composite stage if present, otherwise `null`. The caller
 * uses this to drive `cache.depthOfFieldEnabled` (no separate slot
 * needed) and to source the DoF uniforms during lazy init.
 */
function findDepthOfFieldStage(collection: unknown): {
  enabled: boolean;
  uniforms: {
    focalDistance?: number;
    delta?: number;
    sigma?: number;
    stepSize?: number;
  };
} | null {
  const stages = (
    collection as {
      _stages?: Array<{
        name?: string;
        enabled?: boolean;
        uniforms?: Record<string, unknown>;
      }>;
    }
  )._stages;
  if (!Array.isArray(stages)) return null;
  for (const s of stages) {
    if (!s) continue;
    if (s.name === "czm_depth_of_field") {
      return {
        enabled: !!s.enabled,
        uniforms: (s.uniforms ?? {}) as {
          focalDistance?: number;
          delta?: number;
          sigma?: number;
          stepSize?: number;
        },
      };
    }
  }
  return null;
}

/**
 * Map the CesiumJS Tonemapper to our WebGPU tonemapping mode.
 *
 * CesiumJS's `Tonemapper` is a STRING enum ("REINHARD" / "MODIFIED_REINHARD" /
 * "FILMIC" / "ACES" / "PBR_NEUTRAL") stored on
 * `PostProcessStageCollection._tonemapper` (the `tonemapper` getter/setter).
 *
 * Pre-fix this read `collection._tonemapping?.type ?? collection._tonemappingType`
 * — `_tonemapping` is the post-process STAGE object (no `.type`) and
 * `_tonemappingType` doesn't exist — AND switched on NUMBERS (0..4). Both the
 * property and the value type were wrong, so it ALWAYS hit the default: the
 * user-facing `scene.postProcessStages.tonemapper` setting was a silent no-op
 * (every scene rendered with PBR_NEUTRAL regardless of selection).
 */
function mapTonemapType(collection: CesiumObjectWithWebGPUCache): number {
  const type = collection._tonemapper ?? collection.tonemapper;
  switch (type) {
    case "REINHARD":
      return TonemapMode.REINHARD;
    case "MODIFIED_REINHARD":
      return TonemapMode.MODIFIED_REINHARD;
    case "FILMIC":
      return TonemapMode.FILMIC;
    case "ACES":
      return TonemapMode.ACES;
    case "PBR_NEUTRAL":
      return TonemapMode.PBR_NEUTRAL;
    default:
      return TonemapMode.PBR_NEUTRAL; // CesiumJS default
  }
}

/**
 * Feature renderer sync — called by PostProcessStageCollection.update()
 * via FeatureRendererKey.POST_PROCESS_COLLECTION.
 *
 * Caches the current enabled/disabled state of all post-processing stages.
 * Does NOT touch the WebGPU pipeline — that's configureWebGPUPostProcessPipeline's job.
 */
function updateWebGPUPostProcessStages(
  collection: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
): void {
  if (!collection._webgpuCache) {
    collection._webgpuCache = getDefaultCache();
  }

  // WIRE-PP-LIBRARY-BUILTINS — compact removed stages. Upstream's
  // `PostProcessStageCollection.update()` only runs its private
  // `removeStages()` AFTER the feature-renderer early-return, so on
  // WebGPU a `postProcessStages.remove(stage)` left an `undefined` hole
  // and `_stages.length` never shrank — the length-based rebuild gate in
  // the configure pass (Batch 290) missed removals entirely, leaking
  // both user WGSL stages and intercepted library stages until the next
  // ADD. Mirror the upstream compaction here (same algorithm, including
  // the `_index` re-derivation).
  const col = collection as unknown as {
    _stagesRemoved?: boolean;
    _stages?: Array<{ _index?: number } | undefined>;
  };
  if (col._stagesRemoved === true && Array.isArray(col._stages)) {
    col._stagesRemoved = false;
    const newStages: Array<{ _index?: number }> = [];
    let j = 0;
    for (const st of col._stages) {
      if (st) {
        st._index = j++;
        newStages.push(st);
      }
    }
    col._stages = newStages;
  }

  const cache = collection._webgpuCache as PostProcessCache;

  // Read current state from the CesiumJS collection
  cache.fxaaEnabled = collection.fxaa?.enabled ?? false;
  cache.tonemappingEnabled = collection._tonemapping?.enabled ?? true;
  cache.tonemapMode = mapTonemapType(collection);
  cache.bloomEnabled = collection.bloom?.enabled ?? false;
  cache.ambientOcclusionEnabled = collection.ambientOcclusion?.enabled ?? false;
  // Batch 98 — upstream DoF lives in `collection._stages`, not on a
  // dedicated slot. Walk the list for the well-known composite.
  const dofStage = findDepthOfFieldStage(collection);
  cache.depthOfFieldEnabled = dofStage?.enabled ?? false;

  // Cache AO uniform values for runtime update.
  // NEW-BLOOM-UNIFORM-PARITY (Batch 240): the bloom uniforms are
  // deliberately NOT cached here — `configureWebGPUPostProcessPipeline`
  // owns the bloom dirty check, and refreshing the cache in this
  // earlier-running sync masked every runtime uniform change (the
  // configure pass compared fresh reads against values this function
  // had already updated).
  if (cache.ambientOcclusionEnabled) {
    const ao = collection.ambientOcclusion;
    cache.aoIntensity = numU(ao?.uniforms?.intensity, 3.0);
    cache.aoBias = numU(ao?.uniforms?.bias, 0.1);
  }

  collection._activeStagesChanged = false;
  cache.initialized = true;
}

// NEW-WEBGPU-PP-LIBRARY-DEMO — true when the live user-stage list differs
// from the instances consumed by the last (re)build, element-wise by
// identity. Catches same-frame remove()+add() swaps that leave the list
// length unchanged (count-only detection kept the removed stage's WGSL twin
// running). O(n) over a typically tiny list, called once per frame.
function userStagesIdentityChanged(
  userStages: unknown[] | undefined,
  lastRefs: unknown[] | undefined,
): boolean {
  if (!Array.isArray(userStages)) {
    return (lastRefs?.length ?? 0) > 0;
  }
  if (!Array.isArray(lastRefs) || lastRefs.length !== userStages.length) {
    return true;
  }
  for (let i = 0; i < userStages.length; i++) {
    if (userStages[i] !== lastRefs[i]) {
      return true;
    }
  }
  return false;
}

/**
 * Configure the WebGPU post-process pipeline based on cached collection state.
 * Called by WebGPUSceneRenderer._ensureResources() each frame.
 *
 * Lazily initializes complex effects (bloom, AO, DoF) on the pipeline when
 * they are first enabled. Syncs enabled/disabled state and tonemapping mode.
 *
 * @param pipeline - The WebGPU post-process pipeline
 * @param collection - The CesiumJS PostProcessStageCollection
 * @param device - The GPU device
 * @param canvasFormat - The canvas texture format
 */
function configureWebGPUPostProcessPipeline(
  pipeline: WebGPUPostProcessPipeline,
  collection: CesiumPostProcessStageCollection,
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
  scene?: CesiumScene,
): void {
  const cache = (collection._webgpuCache ??
    getDefaultCache()) as PostProcessCache;

  // PARITY-F16-POSTPROCESS — resolve the f16 post-process opt-in once.
  // True only when the scene's context both opted in (`useShaderF16`) and
  // the device granted `shader-f16`. Threaded into the multi-pass effects'
  // add* methods so they compile the hand-tuned f16 shader variants.
  // Default false → the f32 shaders are selected unchanged (byte-identical
  // off-gate). Effects are only initialized once (guarded by their
  // `*Initialized` cache flags), so flipping this after init requires a
  // pipeline rebuild — matching how every other stage-shape choice works.
  const f16Context = (
    scene as unknown as {
      context?: { useShaderF16?: boolean; hasFeature?: (n: string) => boolean };
    }
  )?.context;
  const useShaderF16 =
    !!f16Context?.useShaderF16 && !!f16Context?.hasFeature?.("shader-f16");

  // Audit A.11 (Batch 133) -- GodRay enabled flag, scene-level (no
  // upstream PostProcessStageCollection slot exists for this fork
  // addition). Mirrors the `scene.taaEnabled` pattern.
  cache.godRayEnabled =
    (scene as unknown as { godRayEnabled?: boolean })?.godRayEnabled === true;

  // Atmospheric Effects Phase B (Batch 417b) -- HeatShimmer enabled flag,
  // scene-level (ad-hoc `scene.heatShimmerEnabled`, pushed by the 417a
  // atmospheric auto-master). Mirrors the godRay scene-flag read.
  cache.heatShimmerEnabled =
    (scene as unknown as { heatShimmerEnabled?: boolean })
      ?.heatShimmerEnabled === true;

  // Atmospheric Effects Phase D (Batch 422) -- ColdOptics enabled flag,
  // scene-level (ad-hoc `scene.coldOpticsEnabled`, pushed by the 417a
  // atmospheric auto-master from sub-freezing temperature). Mirrors the
  // heatShimmer scene-flag read.
  cache.coldOpticsEnabled =
    (scene as unknown as { coldOpticsEnabled?: boolean })?.coldOpticsEnabled ===
    true;

  // --- TAA (controlled by scene.taaEnabled, not the collection) ---
  // NEW-TAA-EFFECT-NEVER-ADDED (Batch 244) — lazily add the effect on
  // the first `scene.taaEnabled` frame, mirroring the bloom/AO/DoF
  // lazy-init below. Before this, `addTAA()` had ZERO callers, so
  // `setStageEnabled("TAA", true)` no-opped on a null `_taaEffect` and
  // `scene.taaEnabled = true` paid for velocity passes + the MSAA=1
  // downgrade while producing no temporal accumulation at all.
  //
  // The gate checks the LIVE `pipeline.taaEffect` slot (addTAA is also
  // internally idempotent) rather than a sticky `cache.taaInitialized`
  // flag so the effect transparently re-adds after any pipeline
  // recreate (HDR toggle, resize, device loss) that nulls the slot.
  const taaEnabled = scene?.taaEnabled === true;
  if (taaEnabled && !pipeline.taaEffect) {
    pipeline.addTAA(device, canvasFormat);
  }
  // Toggle-off is a clean bypass: `enabled = false` drops the effect
  // out of `execute()` and `hasActiveStages` while keeping the history
  // textures allocated (same policy as disabled bloom). On the
  // off→on rising edge, invalidate the stale history so the first
  // re-enabled frame doesn't blend 90% of an old scene back in.
  const taaFx = pipeline.taaEffect;
  if (taaFx && taaEnabled && !taaFx.enabled) {
    taaFx.resetHistory();
  }
  pipeline.setStageEnabled("TAA", taaEnabled);
  // When TAA is active, disable FXAA (TAA provides superior AA).
  const fxaaEnabled = taaEnabled ? false : cache.fxaaEnabled;

  // --- FXAA ---
  pipeline.setStageEnabled("FXAA", fxaaEnabled);

  // --- Tonemapping ---
  // HDR-DISPLAY (Batch 200; Batch 205 audit fix B200-D1 + D2) +
  // PARITY-HDR-PP-MATH — HDR canvas output mode. When the user opts
  // into wide-gamut HDR canvas output, the OS / display handles the
  // gamut + tone curve, so:
  //
  // - tonemap is bypassed (compressing HDR → SDR defeats the point)
  // - colorGrading + FXAA now KEEP RUNNING with HDR-aware math: the
  //   pipeline's setHDROutputMode() flips each stage's `hdrMode`
  //   uniform so the shaders grade / edge-detect in a Reinhard-
  //   compressed [0, 1) working space and emit linear HDR (previously
  //   both stages were skipped outright — users lost grading + AA
  //   entirely in HDR mode).
  //
  // HDR mode is opt-in via `scene.useHDRCanvasOutput = true` AND
  // requires `scene.highDynamicRange = true` (the latter ensures the
  // scene framebuffer is rgba16float so the HDR data actually exists
  // to forward). Falls through to the standard SDR pipeline when
  // either gate is off — backwards-compatible by default.
  const sceneAny = scene as
    { useHDRCanvasOutput?: boolean; highDynamicRange?: boolean } | undefined;
  const hdrOutputMode =
    sceneAny?.useHDRCanvasOutput === true &&
    sceneAny?.highDynamicRange === true;
  pipeline.setHDROutputMode(hdrOutputMode);
  // NEW-PP-LIBRARY-TONEMAP-ORDER — WebGL's PostProcessStageCollection.
  // update() assigns `tonemapping.enabled = useHdr` every frame
  // (PostProcessStageCollection.js ~:575), but on WebGPU that update
  // early-returns into this feature renderer BEFORE the assignment, so
  // the tonemap gate never engaged under `scene.highDynamicRange =
  // true` and the un-tonemapped HDR frame reached the SDR canvas.
  // Apply the same rule here, and mirror it onto the collection's
  // stage object + the cache so every observer (the early sync's
  // `_tonemapping.enabled` read, hasActiveWebGPUPostProcessStages)
  // agrees. SDR default (`highDynamicRange === false`) keeps the
  // historical disabled state — byte-identical off path.
  const useHdr = sceneAny?.highDynamicRange === true;
  if (collection._tonemapping) {
    collection._tonemapping.enabled = useHdr;
  }
  cache.tonemappingEnabled = useHdr;
  pipeline.setStageEnabled("Tonemap", useHdr && !hdrOutputMode);
  pipeline.setTonemappingMode(cache.tonemapMode);

  // --- Color grading: lazily initialize on first enable ---
  // WIRE-COLORGRADING-CALLER (Batch 480) — scene-level opt-in
  // (`scene.colorGradingEnabled`, optional `scene.colorGradingConfig`),
  // mirroring the godRay scene-flag pattern. Default OFF: the stage is
  // never compiled/added until the first enabled frame, so untouched
  // scenes stay byte-identical. Runs after Tonemap in the pipeline's
  // single-pass chain; under HDR canvas output the pipeline's
  // setHDROutputMode() flips the stage into HDR-aware math
  // (PARITY-HDR-PP-MATH, Batch 479).
  cache.colorGradingEnabled =
    (scene as unknown as { colorGradingEnabled?: boolean })
      ?.colorGradingEnabled === true;
  const colorGradingConfig = (
    scene as unknown as {
      colorGradingConfig?: import("./WebGPUPostProcessPipeline.js").ColorGradingConfig;
    }
  )?.colorGradingConfig;
  if (cache.colorGradingEnabled && !cache.colorGradingInitialized) {
    pipeline.addColorGrading(
      device,
      canvasFormat,
      colorGradingConfig,
      useShaderF16,
    );
    cache.colorGradingInitialized = true;
    cache._colorGradingConfigRef = colorGradingConfig;
  } else if (
    cache.colorGradingEnabled &&
    cache.colorGradingInitialized &&
    colorGradingConfig !== cache._colorGradingConfigRef
  ) {
    // Runtime re-grade: assigning a NEW config object to
    // `scene.colorGradingConfig` replaces the full uniform block
    // (updateColorGradingUniforms preserves the pipeline-managed
    // hdrMode flag). Identity comparison keeps steady-state frames free.
    if (colorGradingConfig) {
      pipeline.updateColorGradingUniforms(colorGradingConfig);
    }
    cache._colorGradingConfigRef = colorGradingConfig;
  }
  pipeline.setStageEnabled("ColorGrading", cache.colorGradingEnabled);

  // --- Auto-exposure: match WebGL (NEW-WEBGPU-SKYBOX-HDR-FAINT-STAR-PARITY,
  //     Batch 364) ---
  // WebGL only runs the auto-exposure reduction when the user opts in
  // (`PostProcessStageCollection._autoExposureEnabled`, default false).
  // `addAutoExposure` is wired unconditionally on WebGPU (B.14) and
  // `WebGPUAutoExposure.enabled` defaults true, and nothing here synced the
  // flag down — so WebGPU auto-exposed EVERY frame. On a near-black HDR
  // night sky the adaptive exposure collapsed the whole frame to black
  // (diag-stars-hdr-autoexposure: maxLum 0 with AE-on vs 761 / 5 saturated
  // bloom-feeding star points with AE-off), crushing the bright catalog
  // stars and their bloom halos. Honor the same opt-in flag WebGL uses so
  // the two backends expose identically by default; the always-on B.14
  // behavior (SDR day/night recovery) is itself a WebGL divergence and is
  // dropped in favor of parity. Users who set `autoExposure = true` get the
  // adaptive path on both backends.
  pipeline.autoExposureEnabled =
    (collection as unknown as { _autoExposureEnabled?: boolean })
      ._autoExposureEnabled === true;

  // --- Bloom: lazily initialize on first enable ---
  // NEW-BLOOM-UNIFORM-PARITY (Batch 240) — map ALL six WebGL bloom
  // uniforms (contrast, brightness, glowOnly, delta, sigma, stepSize)
  // 1:1 onto the WebGPU effect. The previous mapping fed WebGL's
  // BRIGHTNESS (-0.3 default) into a luminance THRESHOLD — a negative
  // threshold that passed every pixel, blooming the whole scene at
  // default uniforms. `intensity` is a fork extra (altitude-gate
  // lever); 1.0 matches WebGL's plain `bloom + color` composite.
  if (cache.bloomEnabled && !cache.bloomInitialized) {
    const bloom = collection.bloom;
    pipeline.addBloom(
      device,
      canvasFormat,
      {
        contrast: numU(bloom?.uniforms?.contrast, 128.0),
        brightness: numU(bloom?.uniforms?.brightness, -0.3),
        delta: numU(bloom?.uniforms?.delta, 1.0),
        sigma: numU(bloom?.uniforms?.sigma, 2.0),
        stepSize: numU(bloom?.uniforms?.stepSize, 1.0),
        glowOnly: Boolean(bloom?.uniforms?.glowOnly ?? false),
        intensity: 1.0,
      },
      useShaderF16,
    );
    cache.bloomInitialized = true;
  }
  pipeline.setStageEnabled("Bloom", cache.bloomEnabled);

  // Update bloom config if it changed
  if (cache.bloomEnabled && pipeline.bloomEffect) {
    const bloom = collection.bloom;
    const newContrast = numU(bloom?.uniforms?.contrast, 128.0);
    const newBrightness = numU(bloom?.uniforms?.brightness, -0.3);
    const newDelta = numU(bloom?.uniforms?.delta, 1.0);
    const newSigma = numU(bloom?.uniforms?.sigma, 2.0);
    const newStepSize = numU(bloom?.uniforms?.stepSize, 1.0);
    const newGlowOnly = Boolean(bloom?.uniforms?.glowOnly ?? false);
    if (
      newContrast !== cache.bloomContrast ||
      newBrightness !== cache.bloomBrightness ||
      newDelta !== cache.bloomDelta ||
      newSigma !== cache.bloomSigma ||
      newStepSize !== cache.bloomStepSize ||
      newGlowOnly !== cache.bloomGlowOnly
    ) {
      pipeline.bloomEffect.updateConfig({
        contrast: newContrast,
        brightness: newBrightness,
        delta: newDelta,
        sigma: newSigma,
        stepSize: newStepSize,
        glowOnly: newGlowOnly,
      });
      cache.bloomContrast = newContrast;
      cache.bloomBrightness = newBrightness;
      cache.bloomDelta = newDelta;
      cache.bloomSigma = newSigma;
      cache.bloomStepSize = newStepSize;
      cache.bloomGlowOnly = newGlowOnly;
    }
  }

  // --- Ambient Occlusion: lazily initialize on first enable ---
  if (cache.ambientOcclusionEnabled && !cache.aoInitialized) {
    const ao = collection.ambientOcclusion;
    // AUDIT_2026_05_02 B.13 — read `algorithm` from user uniforms so
    // GTAO is reachable without monkey-patching. Falls back to "hbao"
    // when unset for backwards compatibility. The AO algorithm
    // discriminator is the lone string-typed uniform — narrow it to
    // the literal union without going through `numU`.
    const rawAlgo = ao?.uniforms?.algorithm;
    const algorithm: "gtao" | "hbao" =
      rawAlgo === "gtao" || rawAlgo === "hbao" ? rawAlgo : "hbao";
    pipeline.addAmbientOcclusion(
      device,
      canvasFormat,
      {
        algorithm,
        intensity: numU(ao?.uniforms?.intensity, 3.0),
        bias: numU(ao?.uniforms?.bias, 0.1),
        lengthCap: numU(ao?.uniforms?.lengthCap, 0.26),
        stepCount: numU(ao?.uniforms?.stepSize, 4),
        directionCount: numU(ao?.uniforms?.directionCount, 4),
        ambientOcclusionOnly: Boolean(
          ao?.uniforms?.ambientOcclusionOnly ?? false,
        ),
      },
      useShaderF16,
    );
    cache.aoInitialized = true;
  }
  pipeline.setStageEnabled("AmbientOcclusion", cache.ambientOcclusionEnabled);

  // --- Depth of Field: lazily initialize on first enable ---
  // Batch 98 — uniforms now come from the upstream DoF composite stage
  // located by `findDepthOfFieldStage`, not the never-existed
  // `collection._depthOfField` slot.
  if (cache.depthOfFieldEnabled && !cache.dofInitialized) {
    const dof = findDepthOfFieldStage(collection);
    pipeline.addDepthOfField(
      device,
      canvasFormat,
      {
        focalDistance: numU(dof?.uniforms?.focalDistance, 50.0),
        focalRange: numU(dof?.uniforms?.delta, 20.0),
        blurSigma: numU(dof?.uniforms?.sigma, 4.0),
      },
      useShaderF16,
    );
    cache.dofInitialized = true;
  }
  pipeline.setStageEnabled("DepthOfField", cache.depthOfFieldEnabled);

  // NEW-POSTPROCESS-USER-WGSL (Batch 198 first slice; Batch 204
  // second slice — named-uniform schema + multi-pass) — user-supplied
  // WGSL stages from `scene.postProcessStages.add(...)`. Build once on
  // first configure call and rebuild if the user clears/adds stages.
  //
  // Recognized stage uniforms (Batch 204):
  //   - `wgslFragmentShader: string` — required. WGSL FS source.
  //   - `wgslUniformSchema: UniformSchema` — optional. Named-uniform
  //     schema mapping `{ [name]: { type, offset } }`. When present,
  //     vec3/vec4 uniform values may be `number[]` arrays.
  //   - `wgslNumberOfPasses: number` — optional. Default 1.
  //   - All other uniform keys: numeric scalars (or arrays when schema
  //     declares them as vec2/3/4) packed into the 64-byte UBO.
  const userStages = (collection as unknown as { _stages?: unknown[] })._stages;
  const userStageCount = Array.isArray(userStages) ? userStages.length : 0;
  // NEW-POSTPROCESS-USER-WARN-PROD (Batch 290) — rebuild whenever the
  // user-stage list length changes (add OR remove), not only on first
  // build / empty-list. A runtime add (e.g. `scene.postProcessStages.add`
  // after startup) previously left `_userStagesBuilt` stuck true, so the
  // new stage never compiled (WGSL) and never warned (GLSL). Comparing the
  // live length against the last-built count detects both directions; on a
  // mismatch we drop the existing user-stage compiles and re-scan from
  // scratch so the (re)build below is authoritative.
  // NEW-WEBGPU-PP-LIBRARY-DEMO — length alone misses a same-frame
  // remove()+add() swap (net length unchanged between configure calls), so
  // also compare element-wise stage identity against the last-built list.
  const listChanged =
    cache._userStagesBuilt &&
    (userStageCount !== (cache._userStagesCount ?? 0) ||
      userStagesIdentityChanged(userStages, cache._userStagesRefs));
  if (listChanged) {
    pipeline.clearUserWGSLStages();
    // WIRE-PP-LIBRARY-BUILTINS — intercepted library stages rebuild on
    // the same add/remove trigger as user WGSL stages.
    pipeline.clearLibraryStages();
    cache._userStagesBuilt = false;
  }
  if (!cache._userStagesBuilt && Array.isArray(userStages)) {
    let glslOnlyCount = 0;
    for (const s of userStages) {
      const stage = s as
        | { name?: string; uniforms?: Record<string, unknown> }
        | null
        | undefined;
      if (!stage) continue;
      // Batch 98 — skip the upstream DoF composite; it's intercepted
      // and routed through `pipeline.addDepthOfField` above. Counting
      // it as a GLSL-only stage would fire a misleading warning and
      // suggest the user supply a WGSL shader for an effect we
      // already handle natively.
      if (
        stage.name === "czm_depth_of_field" ||
        stage.name === "czm_depth_of_field_blur" ||
        stage.name === "czm_depth_of_field_composite"
      ) {
        continue;
      }
      // WIRE-PP-LIBRARY-BUILTINS — intercept named PostProcessStageLibrary
      // built-ins (czm_black_and_white, czm_brightness, czm_night_vision,
      // czm_silhouette, czm_edge_detection_*, czm_lens_flare,
      // czm_depth_view) and substitute the pre-translated WGSL twin
      // instead of dropping the GLSL stage. Uniforms + enabled state are
      // synced live each frame below (syncInterceptedLibraryStages), so
      // only registration happens here. NOT counted as GLSL-only — the
      // stage runs natively.
      if (getLibraryStageKey(stage.name) !== null) {
        pipeline.addLibraryStage(device, stage.name as string);
        continue;
      }
      const wgsl = stage.uniforms?.wgslFragmentShader;
      if (typeof wgsl === "string" && wgsl.length > 0) {
        const u = stage.uniforms as Record<string, unknown>;
        // Batch 204 — extract schema + numberOfPasses if provided.
        const schemaRaw = u.wgslUniformSchema;
        const schema =
          schemaRaw && typeof schemaRaw === "object"
            ? (schemaRaw as import("./WebGPUUserPostProcessStage.js").UniformSchema)
            : undefined;
        const numberOfPassesRaw = u.wgslNumberOfPasses;
        const numberOfPasses =
          typeof numberOfPassesRaw === "number" ? numberOfPassesRaw : undefined;

        // Pack uniforms — schema-driven mode allows number[] vec
        // values; iteration-order mode (no schema) accepts only
        // scalars. The user stage class handles the actual packing.
        const reservedKeys = new Set([
          "wgslFragmentShader",
          "wgslUniformSchema",
          "wgslNumberOfPasses",
        ]);
        const userUniforms: Record<string, number | number[]> = {};
        for (const k in u) {
          if (reservedKeys.has(k)) continue;
          const v = u[k];
          if (typeof v === "number") {
            userUniforms[k] = v;
          } else if (
            Array.isArray(v) &&
            v.every((x) => typeof x === "number")
          ) {
            userUniforms[k] = v as number[];
          }
        }

        pipeline.addUserWGSLStage(
          device,
          canvasFormat,
          stage.name ?? "user-wgsl",
          wgsl,
          userUniforms,
          schema,
          numberOfPasses,
        );
      } else {
        glslOnlyCount++;
      }
    }
    cache._userStagesBuilt = true;
    cache._userStagesCount = userStageCount;
    cache._userStagesRefs = userStages.slice();
    // NEW-POSTPROCESS-USER-WARN-PROD (Batch 290) — this warning is
    // PERMANENT (not pragma-stripped). A user-supplied GLSL
    // PostProcessStage is silently DROPPED on the WebGPU backend (WebGPU
    // needs WGSL); the dropped stage produces NO output and the user has
    // no other signal that their effect didn't run. That's a real,
    // user-actionable error per the CLAUDE.md logging rules ("Real
    // errors must always reach the console"), not a debug diagnostic —
    // stripping it in production left shipping users with silence.
    // `oneTimeWarning` is production-safe (only its internal
    // `defined(identifier)` assert is pragma-stripped; the `console.warn`
    // body runs in every build) and dedupes by identifier so a scene
    // with the same GLSL stage doesn't spam the console per frame.
    if (glslOnlyCount > 0) {
      oneTimeWarning(
        "WebGPUPostProcessStageCollection.userStagesGLSL",
        `${glslOnlyCount} user-added PostProcessStage instance(s) without ` +
          "a `wgslFragmentShader` uniform detected on a WebGPU scene. " +
          "GLSL custom shaders are not transpiled on the WebGPU backend; " +
          "these stages are SKIPPED (they produce no output). " +
          "Supply a `wgslFragmentShader: string` uniform on each stage to " +
          "execute custom WGSL post-process effects. Stages with " +
          "`wgslFragmentShader` set are honored. Track NEW-POSTPROCESS-USER-WGSL.",
      );
    }
  } else if (
    cache._userStagesBuilt &&
    (!Array.isArray(userStages) || userStages.length === 0)
  ) {
    pipeline.clearUserWGSLStages();
    // WIRE-PP-LIBRARY-BUILTINS — drop intercepted library stages when the
    // user collection empties, mirroring the user-WGSL teardown.
    pipeline.clearLibraryStages();
    cache._userStagesBuilt = false;
    cache._userStagesCount = 0;
    cache._userStagesRefs = [];
  }

  // WIRE-PP-LIBRARY-BUILTINS — per-frame sync for intercepted library
  // built-ins. The (re)build above only fires on list-length changes, so
  // `enabled` toggles and uniform edits on an already-added library stage
  // (e.g. `stage.uniforms.gradations = 8`) must be pushed every frame.
  // Cheap: a name-match walk over the (typically tiny) stage list; the
  // uniform repack happens GPU-side only for enabled stages at execute.
  syncInterceptedLibraryStages(pipeline, userStages, scene);

  // Audit A.11 (Batch 133) -- GodRay lazy init + per-frame sun UV
  // update. Config can be supplied via `scene.godRayConfig` (optional).
  // Skip when the scene has no sun configured -- the effect needs the
  // sun's screen-space position to draw the radial blur direction.
  if (cache.godRayEnabled && !cache.godRayInitialized) {
    const cfg = (
      scene as unknown as {
        godRayConfig?: import("./WebGPUGodRayEffect.js").GodRayConfig;
      }
    )?.godRayConfig;
    pipeline.addGodRay(device, canvasFormat, cfg, useShaderF16);
    cache.godRayInitialized = true;
  }
  // Audit re-review (Batch 134) -- GodRay enable rides
  // `pipeline.godRayEffect.enabled` directly; `setStageEnabled` only
  // recognizes the named slot stages (TAA, FXAA, Bloom, Tonemap, etc.)
  // and falls through to a no-op for unknown names. The previous
  // `setStageEnabled("GodRay", false)` call was dead and misleading
  // -- removed to keep the enable surface single-source.
  if (cache.godRayEnabled && pipeline.godRayEffect) {
    pipeline.godRayEffect.enabled = true;
    updateGodRaySunUV(pipeline, scene);
  } else if (pipeline.godRayEffect) {
    pipeline.godRayEffect.enabled = false;
  }

  // Atmospheric Effects Phase B (Batch 417b) -- HeatShimmer lazy init +
  // per-frame clock / intensity / continuous-render drive. Config can be
  // supplied via `scene.heatShimmerConfig` (optional).
  if (cache.heatShimmerEnabled && !cache.heatShimmerInitialized) {
    const cfg = (
      scene as unknown as {
        heatShimmerConfig?: import("./WebGPUHeatShimmerEffect.js").HeatShimmerConfig;
      }
    )?.heatShimmerConfig;
    pipeline.addHeatShimmer(device, canvasFormat, cfg);
    cache.heatShimmerInitialized = true;
  }
  if (cache.heatShimmerEnabled && pipeline.heatShimmerEffect) {
    pipeline.heatShimmerEffect.enabled = true;
    updateHeatShimmerFrameData(pipeline, scene);
  } else if (pipeline.heatShimmerEffect) {
    pipeline.heatShimmerEffect.enabled = false;
  }

  // Atmospheric Effects Phase D (Batch 422) -- ColdOptics lazy init +
  // per-frame camera/sun/inverse-matrix push. Config can be supplied via
  // `scene.coldOpticsConfig` (optional).
  if (cache.coldOpticsEnabled && !cache.coldOpticsInitialized) {
    const cfg = (
      scene as unknown as {
        coldOpticsConfig?: import("./WebGPUColdOpticsEffect.js").ColdOpticsConfig;
      }
    )?.coldOpticsConfig;
    pipeline.addColdOptics(device, canvasFormat, cfg);
    cache.coldOpticsInitialized = true;
  }
  if (cache.coldOpticsEnabled && pipeline.coldOpticsEffect) {
    pipeline.coldOpticsEffect.enabled = true;
    updateColdOpticsFrameData(pipeline, scene);
  } else if (pipeline.coldOpticsEffect) {
    pipeline.coldOpticsEffect.enabled = false;
  }

  // Track V-A2 (NEW-ATMO-AERIAL-PERSPECTIVE-POSTPROCESS) — unified aerial-
  // perspective atmosphere. Scene-level flag (`scene.aerialPerspective`), no
  // upstream PostProcessStageCollection slot. Lazy-init on first enable;
  // per-frame the configure pass pushes camera/sun/atmosphere uniforms + the
  // Bruneton transmittance LUT view.
  cache.aerialPerspectiveEnabled =
    (scene as unknown as { aerialPerspective?: boolean })?.aerialPerspective ===
    true;
  if (cache.aerialPerspectiveEnabled && !cache.aerialPerspectiveInitialized) {
    const cfg = (
      scene as unknown as {
        aerialPerspectiveConfig?: import("./WebGPUAerialPerspectiveEffect.js").AerialPerspectiveConfig;
      }
    )?.aerialPerspectiveConfig;
    pipeline.addAerialPerspective(device, canvasFormat, cfg);
    cache.aerialPerspectiveInitialized = true;
  }
  if (cache.aerialPerspectiveEnabled && pipeline.aerialPerspectiveEffect) {
    pipeline.aerialPerspectiveEffect.enabled = true;
    updateAerialPerspectiveFrameData(pipeline, scene);
  } else if (pipeline.aerialPerspectiveEffect) {
    pipeline.aerialPerspectiveEffect.enabled = false;
  }
}

/**
 * WIRE-PP-LIBRARY-BUILTINS — per-frame sync for intercepted
 * PostProcessStageLibrary built-ins. Walks the live collection stage
 * list and, for every stage whose name matches a wired library built-in,
 * pushes its `enabled` flag + uniform values + the frame context
 * (frameNumber for NightVision's animated noise, pixelRatio for
 * EdgeDetection's czm_pixelRatio-scaled texel offsets) into the
 * pipeline's matching library stage. No-op when no library stages were
 * intercepted (the default), keeping untouched scenes byte-identical.
 */
function syncInterceptedLibraryStages(
  pipeline: WebGPUPostProcessPipeline,
  userStages: unknown[] | undefined,
  scene?: CesiumScene,
): void {
  if (!Array.isArray(userStages) || userStages.length === 0) return;
  const fs = (
    scene as unknown as {
      frameState?: { frameNumber?: number; pixelRatio?: number };
    }
  )?.frameState;
  const frame: LibraryStageFrameContext = {
    frameNumber: fs?.frameNumber ?? 0,
    pixelRatio: fs?.pixelRatio ?? 1,
  };
  let lensFlareComputed = false;
  for (const s of userStages) {
    const stage = s as
      | { name?: string; enabled?: boolean; uniforms?: Record<string, unknown> }
      | null
      | undefined;
    if (!stage || typeof stage.name !== "string") continue;
    const key = getLibraryStageKey(stage.name);
    if (key === null) continue;
    if (key === "lensFlare" && !lensFlareComputed) {
      // Compute the czm_* sun/earth screen state the WebGL LensFlare
      // shader reads from built-in uniforms. Once per frame is enough
      // (all lens-flare stages share the camera).
      computeLensFlareFrameContext(scene, stage.uniforms ?? {}, frame);
      lensFlareComputed = true;
    }
    pipeline.syncLibraryStage(
      stage.name,
      stage.enabled !== false,
      stage.uniforms ?? {},
      frame,
    );
  }
}

// WGS84 maximum radius (metres) — the `earthRadius` uniform default of
// PostProcessStageLibrary.createLensFlareStage (Ellipsoid.WGS84
// .maximumRadius). Matches AP_WGS84_MAX_RADIUS below.
const LENS_FLARE_WGS84_MAX_RADIUS = 6378137.0;

/**
 * WIRE-PP-LIBRARY-BUILTINS — CPU twin of the czm_* frame state the WebGL
 * LensFlare shader reads from built-in uniforms:
 *
 *   - sun NDC position (czm_sunPositionWC → view → window → viewport-
 *     orthographic in GLSL ≡ a plain viewProjection → NDC projection)
 *   - viewer distance from the earth centre (czm_viewerPositionWC length
 *     — the "in space" gate at 6 500 000 m)
 *   - earth-centre NDC + the |NDC x| of an eye-space point offset by
 *     earthRadius * 1.5 (the isInEarth disk-mask radius)
 *
 * Mirrors the matrix-walk pattern of `updateGodRaySunUV` (column-major
 * flat indexing on uniformState's Matrix4s). Leaves the lens-flare
 * fields unset when uniformState isn't ready — the shader's space gate
 * then keeps the stage a pass-through, matching WebGL's conservative
 * behavior.
 */
function computeLensFlareFrameContext(
  scene: CesiumScene | undefined,
  stageUniforms: Record<string, unknown>,
  frame: LibraryStageFrameContext,
): void {
  const us = (
    scene as unknown as {
      context?: { uniformState?: unknown };
    }
  )?.context?.uniformState as
    | {
        viewProjection?: number[] | Float64Array;
        view?: number[] | Float64Array;
        projection?: number[] | Float64Array;
        sunPositionWC?: { x: number; y: number; z: number };
        cameraPosition?: { x: number; y: number; z: number };
      }
    | undefined;
  if (!us?.viewProjection || !us.view || !us.projection) return;
  const vp = us.viewProjection;
  const view = us.view;
  const proj = us.projection;

  const cam = us.cameraPosition;
  if (cam) {
    frame.viewerDistance = Math.sqrt(
      cam.x * cam.x + cam.y * cam.y + cam.z * cam.z,
    );
  }

  // Sun NDC (viewProjection * sunPositionWC, perspective divide).
  const sun = us.sunPositionWC;
  if (sun) {
    const cx = vp[0] * sun.x + vp[4] * sun.y + vp[8] * sun.z + vp[12];
    const cy = vp[1] * sun.x + vp[5] * sun.y + vp[9] * sun.z + vp[13];
    const cw = vp[3] * sun.x + vp[7] * sun.y + vp[11] * sun.z + vp[15];
    if (cw !== 0 && isFinite(cw)) {
      frame.sunNDC = [cx / cw, cy / cw];
    }
  }

  // Earth-centre NDC (viewProjection * origin = the matrix translation
  // column) + the isInEarth edge radius: eye-space earth centre offset
  // by earthRadius * 1.5 along eye X, projected to NDC.
  const ew = vp[15];
  if (ew !== 0 && isFinite(ew)) {
    frame.earthNDC = [vp[12] / ew, vp[13] / ew];
  }
  const earthRadius =
    typeof stageUniforms.earthRadius === "number"
      ? stageUniforms.earthRadius
      : LENS_FLARE_WGS84_MAX_RADIUS;
  // Eye-space earth centre = view matrix translation column.
  const ecx = view[12] + earthRadius * 1.5;
  const ecy = view[13];
  const ecz = view[14];
  const px = proj[0] * ecx + proj[4] * ecy + proj[8] * ecz + proj[12];
  const pw = proj[3] * ecx + proj[7] * ecy + proj[11] * ecz + proj[15];
  if (pw !== 0 && isFinite(pw)) {
    frame.earthEdgeAbsX = Math.abs(px / pw);
  }
}

// ── Track V-A2 atmosphere constants ──
// MUST match WebGPUSkyAtmosphereRenderer.js's DEFAULT_* / ATMOSPHERE_*
// constants so the aerial-perspective haze agrees with the sky shell + the
// Bruneton LUT bake (which uses the same coefficients). Kept inline here
// rather than imported because the renderer is plain JS with no exports for
// these; a divergence would desync the haze from the LUT, so this is the one
// spot to update if the renderer's defaults change.
const AP_RAYLEIGH_COEFFICIENT: [number, number, number] = [
  5.5e-6, 13.0e-6, 22.4e-6,
];
const AP_MIE_COEFFICIENT: [number, number, number] = [21e-6, 21e-6, 21e-6];
const AP_RAYLEIGH_SCALE_HEIGHT = 8500.0;
const AP_MIE_SCALE_HEIGHT = 1200.0;
const AP_MIE_ANISOTROPY = 0.758;
const AP_ATMOSPHERE_THICKNESS = 111e3; // WebGL ATMOSPHERE_THICKNESS.
// WGS84 max radius (metres) — matches Cartesian3.maximumComponent(WGS84.radii)
// used by the LUT bake. The LUT's transmittance UV parameterization keys off
// this same inner radius, so they must agree for the extinction lookup to be
// physically consistent.
const AP_WGS84_MAX_RADIUS = 6378137.0;

/**
 * Track V-A2 — push the per-frame camera / sun / atmosphere uniforms + the
 * transmittance LUT view into the aerial-perspective effect. Reads the
 * camera world position, inverse view-projection, and sun direction from
 * `uniformState`, the LUT view from the perf manager's atmosphere LUT
 * resources, and the atmosphere intensity from the scene's SkyAtmosphere.
 */
function updateAerialPerspectiveFrameData(
  pipeline: WebGPUPostProcessPipeline,
  scene?: CesiumScene,
): void {
  const fx = pipeline.aerialPerspectiveEffect;
  if (!fx) return;

  const sceneAny = scene as unknown as {
    context?: {
      uniformState?: {
        cameraPosition?: { x: number; y: number; z: number };
        sunDirectionWC?: { x: number; y: number; z: number };
        inverseProjection?: number[] | Float64Array;
        inverseView?: number[] | Float64Array;
      };
      performanceManager?: {
        _atmosphereLutResources?: {
          transmittanceView?: GPUTextureView;
          // Item 2.2 (ENV-AERIAL-MS, Batch 430) — sun-relative sky-view + MS
          // LUT views shared with the visible SkyAtmosphere.
          skyViewView?: GPUTextureView;
          multipleScatterView?: GPUTextureView;
        } | null;
      };
      // Item 2.2 (ENV-AERIAL-MS, Batch 430) — opt-in flag (default false) read
      // off the WebGPU context's getter (threaded from
      // `contextOptions.webgpu.envMapMultiScatter`).
      envMapMultiScatter?: boolean;
    };
    camera?: { frustum?: { near?: number; far?: number } };
    skyAtmosphere?: { atmosphereLightIntensity?: number };
    // Item 2.3 (AERIAL-FROXEL, Batch Q23) — opt-in froxel fast path (default
    // false; nested under the already-opt-in `aerialPerspective`).
    aerialPerspectiveFroxel?: boolean;
  };

  const us = sceneAny?.context?.uniformState;
  if (!us || !us.cameraPosition || !us.inverseProjection || !us.inverseView) {
    return;
  }

  // Push the transmittance LUT view (stable for the device lifetime — the
  // effect's bind-group cache invalidates at most once). Null until the
  // SkyAtmosphere renderer first allocates the LUTs; the effect binds a white
  // placeholder until then (extinction ratio 1 → passthrough), so aerial
  // perspective shows inscatter-only haze on the very first frame and the
  // full extinction once the LUT lands.
  const lut =
    sceneAny?.context?.performanceManager?._atmosphereLutResources ?? null;
  fx.setTransmittanceView(lut?.transmittanceView ?? null);

  // Item 2.2 (ENV-AERIAL-MS, Batch 430) — opt-in sky-view-LUT in-scatter
  // source. Default false → the analytic single-scatter march (byte-identical
  // parity). When on, push the sun-relative sky-view + MS LUT views (the SAME
  // tables the visible SkyAtmosphere samples) so the distance haze matches the
  // visible MS sky. The views/flag are pushed every frame; the effect binds the
  // white placeholder + keeps params1.z off until both are present.
  const envMapMultiScatter = sceneAny?.context?.envMapMultiScatter === true;
  fx.setSkyViewView(lut?.skyViewView ?? null);
  fx.setMultipleScatterView(lut?.multipleScatterView ?? null);
  fx.setUseMultiScatterLut(envMapMultiScatter);

  // Item 2.3 (AERIAL-FROXEL, Batch Q23) — opt-in froxel fast path. Default
  // false → the analytic per-pixel march (byte-identical). When on, the effect
  // bakes the 32³ froxel volume this frame and the fragment does one trilinear
  // fetch. Scene-level flag (`scene.aerialPerspectiveFroxel`).
  fx.setFroxelEnabled(sceneAny?.aerialPerspectiveFroxel === true);

  const cam = us.cameraPosition;
  const sun = us.sunDirectionWC ?? { x: 0, y: 0, z: 1 };
  const near = sceneAny?.camera?.frustum?.near ?? 1.0;
  const far = sceneAny?.camera?.frustum?.far ?? 1e8;
  const lightIntensity =
    sceneAny?.skyAtmosphere?.atmosphereLightIntensity ?? 50.0;

  // Batch 437 (CLOUD-SHADOWS) — feed the sun-view beer shadow map + its world→
  // sun-clip matrix from the procedural cloud renderer's cache so the inscatter
  // dims under the clouds. The cloud renderer runs in the same frame's
  // environmental-effects chain (BEFORE post-process), so the map + matrix are
  // current. When globe.cloudCastShadows is off, `shadowActive` is false → the
  // effect binds the placeholder + the disabled control → byte-identical.
  const cloudCache = (
    scene as unknown as {
      context?: {
        _cloudCache?: {
          shadowActive?: boolean;
          shadowView?: GPUTextureView | null;
          shadowSunViewVP?: Float32Array;
          shadowAbsorption?: number;
        };
      };
    }
  )?.context?._cloudCache;
  const csActive = cloudCache?.shadowActive === true && !!cloudCache.shadowView;
  fx.setCloudShadowView(csActive ? cloudCache!.shadowView! : null);

  fx.setFrameData({
    cameraPositionWC: [cam.x, cam.y, cam.z],
    innerRadius: AP_WGS84_MAX_RADIUS,
    sunDirectionWC: [sun.x, sun.y, sun.z],
    lightIntensity,
    rayleighCoefficient: AP_RAYLEIGH_COEFFICIENT,
    rayleighScaleHeight: AP_RAYLEIGH_SCALE_HEIGHT,
    mieCoefficient: AP_MIE_COEFFICIENT,
    mieScaleHeight: AP_MIE_SCALE_HEIGHT,
    mieAnisotropy: AP_MIE_ANISOTROPY,
    near,
    far,
    atmosphereThickness: AP_ATMOSPHERE_THICKNESS,
    inverseProjection: us.inverseProjection,
    inverseView: us.inverseView,
    cloudShadowVP: csActive ? cloudCache!.shadowSunViewVP : undefined,
    cloudShadowActive: csActive,
    cloudShadowAbsorption: cloudCache?.shadowAbsorption ?? 0.04,
  });
}

// Audit A.11 (Batch 133) -- per-frame sun screen-space UV computed
// by projecting `scene.sun.position` (or the directional sun direction
// when no Sun primitive is configured) through the camera's
// viewProjection matrix and converting NDC -> UV. Off-screen suns
// emit UVs outside [0, 1]; the GodRay shader still produces a
// directional glow across the visible region.
const _godRayScratchClip = new Float64Array(4);
function updateGodRaySunUV(
  pipeline: WebGPUPostProcessPipeline,
  scene?: CesiumScene,
): void {
  const fx = pipeline.godRayEffect;
  if (!fx) return;
  const us = (
    scene as unknown as {
      context?: { uniformState?: unknown };
    }
  )?.context?.uniformState as
    | {
        viewProjection?: number[] | Float64Array;
        sunPositionWC?: { x: number; y: number; z: number };
        sunDirectionWC?: { x: number; y: number; z: number };
        // Audit re-review (Batch 134) -- `currentFrustum` is set
        // per-frustum during the multi-frustum command-list traversal,
        // so by the time the post-process configure runs it carries
        // whichever frustum's near/far was last applied (typically the
        // far one). The full-scene depth-linearization for GodRay
        // needs the camera's overall near + far, not the last per-
        // frustum slice.
        currentFrustum?: { x: number; y: number };
      }
    | undefined;
  if (!us || !us.viewProjection) return;
  const vp = us.viewProjection;
  // Use sun position when available; else extrapolate the sun direction
  // far enough to project off the camera (constant 1.5e8 km mirrors the
  // Earth-sun distance scale).
  let sx: number;
  let sy: number;
  let sz: number;
  if (us.sunPositionWC) {
    sx = us.sunPositionWC.x;
    sy = us.sunPositionWC.y;
    sz = us.sunPositionWC.z;
  } else if (us.sunDirectionWC) {
    sx = us.sunDirectionWC.x * 1.5e11;
    sy = us.sunDirectionWC.y * 1.5e11;
    sz = us.sunDirectionWC.z * 1.5e11;
  } else {
    return;
  }
  // viewProjection is column-major mat4; NDC = vp * [sx, sy, sz, 1].
  const cx = vp[0] * sx + vp[4] * sy + vp[8] * sz + vp[12];
  const cy = vp[1] * sx + vp[5] * sy + vp[9] * sz + vp[13];
  const cw = vp[3] * sx + vp[7] * sy + vp[11] * sz + vp[15];
  if (cw === 0 || !isFinite(cw)) return;
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  // NDC [-1, 1] -> UV [0, 1]; flip Y so origin is top-left.
  const u = ndcX * 0.5 + 0.5;
  const v = -ndcY * 0.5 + 0.5;
  fx.setSunScreenUV(u, v);
  // Audit re-review (Batch 134) -- pull the frustum span from the
  // camera object, not `uniformState.currentFrustum`. The latter is
  // mutated per-frustum during command execution and by the time the
  // configure pass runs it reflects the LAST per-frustum slice (the
  // far one), so the GodRay generate pass would linearize depth
  // against the far slice's near/far -- foreground geometry depths
  // would all collapse to ~0 and gate every sample as "sky", letting
  // shafts leak through occluders. The camera's overall near/far
  // bracket the entire scene depth range correctly.
  const cam = (
    scene as unknown as {
      camera?: { frustum?: { near?: number; far?: number } };
    }
  )?.camera;
  const near = cam?.frustum?.near;
  const far = cam?.frustum?.far;
  if (typeof near === "number" && typeof far === "number" && far > near) {
    fx.setFrustum(near, far);
  }
  // Touch the scratch slot so esbuild can't tree-shake the alloc that
  // future versions may use for SIMD-aware projection.
  _godRayScratchClip[0] = cx;
}

// Atmospheric Effects Phase B (Batch 417b) -- monotonic epoch for the
// shimmer animation clock. Captured on first use so the shader receives a
// SMALL elapsed-seconds value: a raw `performance.now()` (or a JulianDate)
// loses f32 precision in the WGSL noise field and freezes the animation.
let _heatShimmerEpochMs = -1;

/**
 * Atmospheric Effects Phase B (Batch 417b) -- push the per-frame HeatShimmer
 * uniforms (elapsed-seconds clock + intensity + frustum near/far for the
 * optional depth fade) and keep the scene rendering.
 *
 * `requestRenderMode` scenes only render when something requests a frame; an
 * animated warp must advance every frame, so while the effect is enabled we
 * call `scene.requestRender()` each frame (the same mechanism TAA-style
 * continuous effects rely on). Without it the warp would freeze on a settled
 * camera under `requestRenderMode`.
 */
function updateHeatShimmerFrameData(
  pipeline: WebGPUPostProcessPipeline,
  scene?: CesiumScene,
): void {
  const fx = pipeline.heatShimmerEffect;
  if (!fx) return;

  // Elapsed seconds since first enable — small magnitude keeps f32 precision.
  const nowMs =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  if (_heatShimmerEpochMs < 0) {
    _heatShimmerEpochMs = nowMs;
  }
  fx.setTime((nowMs - _heatShimmerEpochMs) / 1000);

  // Intensity from the ad-hoc scene flag pushed in 417a; fall back to the
  // effect's config default (0.6) when unset.
  const intensity = (scene as unknown as { heatShimmerIntensity?: number })
    ?.heatShimmerIntensity;
  if (typeof intensity === "number") {
    fx.setIntensity(intensity);
  }

  // Frustum near/far for the optional depth fade (no-op when depthFadeFar<=0).
  const cam = (
    scene as unknown as {
      camera?: { frustum?: { near?: number; far?: number } };
    }
  )?.camera;
  const near = cam?.frustum?.near;
  const far = cam?.frustum?.far;
  if (typeof near === "number" && typeof far === "number" && far > near) {
    fx.setFrustum(near, far);
  }

  // Keep `requestRenderMode` scenes rendering so the warp animates.
  (scene as unknown as { requestRender?: () => void })?.requestRender?.();
}

// Atmospheric Effects Phase D (Batch 422) — WGS84 max radius (metres),
// matches Cartesian3.maximumComponent(WGS84.radii). Used as the inner radius
// for the world-up reconstruction; the effect only needs the ellipsoid scale
// to form local up from the camera position.
const COLD_OPTICS_INNER_RADIUS = 6378137.0;

/**
 * Atmospheric Effects Phase D (Batch 422) — push the per-frame camera / sun /
 * inverse-matrix uniforms into the ColdOptics effect and keep the scene
 * rendering. Reads the camera world position, inverse projection, inverse
 * view, and sun direction from `uniformState` (the SAME sources as
 * `updateAerialPerspectiveFrameData`), plus the intensity from the ad-hoc
 * `scene.coldOpticsIntensity` flag (417a auto-master). Mirrors the godRay /
 * heat-shimmer per-frame setters.
 *
 * `requestRenderMode` scenes only render on demand; the sun position drifts
 * with the clock, so while the effect is enabled we request a frame each pass
 * so the halo tracks the sun (same mechanism the heat-shimmer clock relies on).
 */
function updateColdOpticsFrameData(
  pipeline: WebGPUPostProcessPipeline,
  scene?: CesiumScene,
): void {
  const fx = pipeline.coldOpticsEffect;
  if (!fx) return;

  const sceneAny = scene as unknown as {
    context?: {
      uniformState?: {
        cameraPosition?: { x: number; y: number; z: number };
        sunDirectionWC?: { x: number; y: number; z: number };
        inverseProjection?: number[] | Float64Array;
        inverseView?: number[] | Float64Array;
      };
    };
    camera?: { frustum?: { near?: number; far?: number } };
    coldOpticsIntensity?: number;
    coldOpticsAdvanced?: boolean;
  };

  const us = sceneAny?.context?.uniformState;
  if (!us || !us.cameraPosition || !us.inverseProjection || !us.inverseView) {
    return;
  }

  // Intensity from the ad-hoc scene flag pushed in 417a; fall back to the
  // effect's config default (1.0) when unset.
  const intensity = sceneAny?.coldOpticsIntensity;
  if (typeof intensity === "number") {
    fx.setIntensity(intensity);
  }

  // COLD-OPTICS-HQ (Batch 442): the advanced opt-in from `effects.optics.advanced`
  // (pushed as `scene.coldOpticsAdvanced`). Drives the shader's advanced branch
  // (22+46 dispersed halos + tangent arc + light pillars). Default-off keeps
  // the legacy halo + sun-dogs path byte-identical.
  fx.setAdvanced(sceneAny?.coldOpticsAdvanced === true);

  const cam = us.cameraPosition;
  const sun = us.sunDirectionWC ?? { x: 0, y: 0, z: 1 };
  const near = sceneAny?.camera?.frustum?.near ?? 1.0;
  const far = sceneAny?.camera?.frustum?.far ?? 1e8;

  fx.setFrameData({
    cameraPositionWC: [cam.x, cam.y, cam.z],
    innerRadius: COLD_OPTICS_INNER_RADIUS,
    sunDirectionWC: [sun.x, sun.y, sun.z],
    near,
    far,
    inverseProjection: us.inverseProjection,
    inverseView: us.inverseView,
  });

  // Keep `requestRenderMode` scenes rendering so the halo tracks the sun.
  (scene as unknown as { requestRender?: () => void })?.requestRender?.();
}

/**
 * Destroy WebGPU post-process resources.
 */
function destroyWebGPUPostProcessResources(
  collection: CesiumObjectWithWebGPUCache,
): void {
  collection._webgpuCache = undefined;
}

/**
 * Check if any post-process stages are active for WebGPU.
 */
function hasActiveWebGPUPostProcessStages(
  collection: CesiumObjectWithWebGPUCache,
): boolean {
  const cache = collection._webgpuCache as PostProcessCache | undefined;
  if (!cache || !cache.initialized) {
    return false;
  }
  return (
    cache.fxaaEnabled ||
    cache.tonemappingEnabled ||
    cache.ambientOcclusionEnabled ||
    cache.bloomEnabled ||
    cache.depthOfFieldEnabled ||
    cache.godRayEnabled ||
    cache.heatShimmerEnabled ||
    cache.coldOpticsEnabled ||
    cache.aerialPerspectiveEnabled ||
    cache.colorGradingEnabled
  );
}

export {
  updateWebGPUPostProcessStages,
  configureWebGPUPostProcessPipeline,
  destroyWebGPUPostProcessResources,
  hasActiveWebGPUPostProcessStages,
};
export default {
  updateWebGPUPostProcessStages,
  configureWebGPUPostProcessPipeline,
  destroyWebGPUPostProcessResources,
  hasActiveWebGPUPostProcessStages,
};
