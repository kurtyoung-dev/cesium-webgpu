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
import { WEBGPU_AO_FULL_SAMPLE_PATTERN } from "./WebGPUAmbientOcclusionEffect.js";
// Well-known PostProcessStageLibrary stage
// names intercepted and substituted with their WGSL twins.
import {
  getLibraryStageKey,
  type LibraryStageFrameContext,
} from "./WebGPULibraryPostProcessStage.js";
import oneTimeWarning from "../../Core/oneTimeWarning.js";
// The sun glow's shape and its one derived screen quantity, shared with the
// WebGL chain so neither backend carries a second set of literals.
import {
  SUN_BRIGHT_PASS_OFFSET_LEGACY,
  SUN_BRIGHT_PASS_THRESHOLD_LEGACY,
  solarBloomCompositeRadiusPx,
} from "../../Scene/SolarDiscModel.js";
// Resolves the renderer-wide log-depth state threaded into depth-reading
// post-process uniform buffers.
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";
// Request and read the procedural cloud renderer's screen-space
// transmittance mask, which resolves cloud occlusion of the god-ray shaft.
import {
  setCloudTransmittanceCapture,
  getCloudTransmittanceView,
} from "./WebGPUProceduralCloudRenderer.js";
// The shared cloud-shadow relative-to-eye frame owner.
import {
  type CloudShadowFrame,
  writeCloudShadowViewProjectionRelativeToEye,
} from "./WebGPUCloudShadowFrame.js";

// Reused eye-relative sun-view matrix for the aerial-perspective consumer. One
// per-module scratch keeps this off the per-frame allocation path.
const cloudShadowVpScratch = new Float32Array(16);

export interface PostProcessCache {
  initialized: boolean;
  fxaaEnabled: boolean;
  tonemappingEnabled: boolean;
  tonemapMode: number;
  ambientOcclusionEnabled: boolean;
  bloomEnabled: boolean;
  depthOfFieldEnabled: boolean;
  // GodRay (volumetric light scattering) post-process. Activated by
  // `scene.godRayEnabled = true`, with an optional `scene.godRayConfig`; the
  // per-frame configure pass updates the sun screen UV from
  // `scene.sun.position` projected through the view-projection.
  godRayEnabled: boolean;
  godRayInitialized: boolean;
  // Screen-space solar halo, driven by `scene.sunBloom`, which defaults true
  // and is the same flag that gates WebGL's `SunPostProcess`. On WebGPU
  // `supportsLegacySunBloom` returns false, so the legacy allocation is
  // skipped and this effect is what consumes the flag.
  sunHaloEnabled: boolean;
  sunHaloInitialized: boolean;
  // The bright-pass glow half of the same chain, on the SAME `scene.sunBloom`
  // flag and the same visibility test. Both backends therefore carry the glow
  // at the shipped default, which is what makes their sun-region response
  // comparable at all.
  sunBloomEnabled: boolean;
  sunBloomInitialized: boolean;
  // HeatShimmer, an animated screen-space UV warp. Activated by
  // `scene.heatShimmerEnabled = true`, with intensity from
  // `scene.heatShimmerIntensity`; both are scene flags the atmospheric
  // auto-master pushes. The per-frame configure pass pushes the
  // elapsed-seconds clock and intensity and keeps the scene rendering.
  heatShimmerEnabled: boolean;
  heatShimmerInitialized: boolean;
  // ColdOptics, the 22-degree ice-crystal halo and sun-dog sky overlay.
  // Activated by `scene.coldOpticsEnabled = true`, with intensity from
  // `scene.coldOpticsIntensity`; both are scene flags the atmospheric
  // auto-master pushes from a sub-freezing temperature. The per-frame
  // configure pass pushes the camera, sun and inverse-matrix uniforms and
  // keeps the scene rendering.
  coldOpticsEnabled: boolean;
  coldOpticsInitialized: boolean;
  // Unified per-pixel atmosphere. Activated by `scene.aerialPerspective =
  // true`, with an optional `scene.aerialPerspectiveConfig`. The per-frame
  // configure pass pushes the camera, sun and atmosphere uniforms and the
  // Bruneton transmittance LUT view.
  aerialPerspectiveEnabled: boolean;
  aerialPerspectiveInitialized: boolean;
  // ColorGrading stage, a scene-level opt-in through
  // `scene.colorGradingEnabled = true` with an optional
  // `scene.colorGradingConfig`. Upstream `PostProcessStageCollection` has no
  // grading slot — WebGL only reaches grading through user-added custom
  // stages — so this mirrors the godRay scene-flag pattern instead. The stage
  // runs after Tonemap in the pipeline's single-pass chain; see the
  // ColorGrading.wgsl header and `WebGPUPostProcessPipeline.execute()`.
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
  // Track bloom and AO uniform values for dirty checking. The bloom set
  // mirrors all six `scene.postProcessStages.bloom.uniforms` one to one.
  // Written only by the configure pass: if
  // `updateWebGPUPostProcessStages` refreshed them, the configure-side dirty
  // check could never fire.
  bloomContrast: number;
  bloomBrightness: number;
  bloomDelta: number;
  bloomSigma: number;
  bloomStepSize: number;
  bloomGlowOnly: boolean;
  aoIntensity: number;
  aoBias: number;
  // Whether `_userStages` on the pipeline has been populated from
  // `scene.postProcessStages._stages`. Set on the first build and reset when the
  // user collection's stage list empties so the configure pass rebuilds.
  _userStagesBuilt?: boolean;
  // The user-stage list length last consumed by a (re)build, `undefined`
  // until the first one. Rebuilding only on the first build or on an emptied
  // list misses a runtime `postProcessStages.add(...)` — a list going from 1
  // to 2, or the first add after an empty-list first frame has already set
  // `_userStagesBuilt` — so neither the runtime WGSL stage compiles nor the
  // GLSL-drop warning fires. Tracking the length lets the configure pass
  // detect any add or remove and re-scan.
  _userStagesCount?: number;
  // The stage instances last consumed by a (re)build, `undefined` until the
  // first one. Count-only detection misses a same-frame `remove()` then
  // `add()` swap, where the count goes 1 to 0 to 1 between configure calls
  // and the previous stage's WGSL twin keeps running — cycling library
  // builtins through `stages.remove(old); stages.add(new)` renders the old
  // effect. Comparing element-wise identity against the live list catches any
  // composition change at equal length.
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
    // False by default, matching WebGL's `PostProcessStageCollection`, whose
    // constructor sets `tonemapping.enabled = false` and lets `update` turn it
    // on when needed.
    //
    // Defaulting to true instead makes the Tonemap stage run Reinhard plus an
    // sRGB encode on every frame of an SDR bgra8unorm pipeline: linear globe
    // imagery at (0.1, 0.2, 0.4) reaches the canvas as roughly
    // (0.725, 0.831, 0.902), which is the whole frame washed out.
    //
    // WebGL flips `tonemap.enabled` to true only when `useHdr` is true. The
    // sync layer below honours that through the `_tonemapping.enabled` read,
    // but if the WebGL collection has never been touched — for instance when
    // the WebGPU feature renderer for the post-process collection runs before
    // `PostProcessStageCollection`'s constructor has finished setting
    // `_tonemapping` — the cache keeps this default. False matches
    // SDR-by-default, and HDR turns it on through the `cache.tonemappingEnabled`
    // read below.
    tonemappingEnabled: false,
    tonemapMode: TonemapMode.REINHARD,
    ambientOcclusionEnabled: false,
    bloomEnabled: false,
    depthOfFieldEnabled: false,
    godRayEnabled: false,
    godRayInitialized: false,
    sunHaloEnabled: false,
    sunHaloInitialized: false,
    sunBloomEnabled: false,
    sunBloomInitialized: false,
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
 * Locate the upstream depth-of-field composite stage by name.
 *
 * Upstream `PostProcessStageCollection` exposes no `_depthOfField` slot: DoF
 * is only available through
 * `scene.postProcessStages.add(PostProcessStageLibrary.createDepthOfFieldStage())`.
 * That helper returns a `PostProcessStageComposite` with the well-known name
 * `czm_depth_of_field`, whose own `enabled` flag controls visibility, so a
 * `collection._depthOfField?.enabled` read is always false.
 *
 * Returns the composite stage if present, otherwise `null`. The caller uses it
 * to drive `cache.depthOfFieldEnabled` and to source the DoF uniforms during
 * lazy init.
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
 * Maps the CesiumJS Tonemapper to the WebGPU tonemapping mode.
 *
 * CesiumJS's `Tonemapper` is a string-valued enum ("REINHARD" /
 * "MODIFIED_REINHARD" / "FILMIC" / "ACES" / "PBR_NEUTRAL") stored on
 * `PostProcessStageCollection._tonemapper` (the `tonemapper` getter/setter).
 *
 * The value comes from `PostProcessStageCollection._tonemapper`, with the public
 * getter as a fallback. Unknown values select `PBR_NEUTRAL`.
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

  // Compact removed stages. Upstream's `PostProcessStageCollection.update()`
  // only runs its private `removeStages()` after the feature-renderer
  // early-return, so on WebGPU a `postProcessStages.remove(stage)` leaves an
  // `undefined` hole and `_stages.length` never shrinks. The length-based
  // rebuild gate in the configure pass would then miss removals entirely and
  // leak both user WGSL stages and intercepted library stages until the next
  // add. This mirrors the upstream compaction, including its `_index`
  // re-derivation.
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
  // Upstream DoF lives in `collection._stages`, not on a dedicated slot. Walk
  // the list for the well-known composite.
  const dofStage = findDepthOfFieldStage(collection);
  cache.depthOfFieldEnabled = dofStage?.enabled ?? false;

  // Cache AO uniform values for runtime update. The bloom uniforms are
  // deliberately not cached here: `configureWebGPUPostProcessPipeline` owns
  // the bloom dirty check, and refreshing the cache in this earlier-running
  // sync masks every runtime uniform change, because the configure pass then
  // compares fresh reads against values this function has already updated.
  if (cache.ambientOcclusionEnabled) {
    const ao = collection.ambientOcclusion;
    cache.aoIntensity = numU(ao?.uniforms?.intensity, 3.0);
    cache.aoBias = numU(ao?.uniforms?.bias, 0.1);
  }

  collection._activeStagesChanged = false;
  cache.initialized = true;
}

// True when the live user-stage list differs element-wise, by identity, from
// the instances consumed by the last (re)build. Catches same-frame `remove()`
// then `add()` swaps that leave the list length unchanged, which count-only
// detection misses, leaving the removed stage's WGSL twin running. O(n) over a
// typically tiny list, called once per frame.
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

  // Resolve the f16 post-process opt-in once.
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

  // GodRay enabled flag, read at scene level because upstream
  // `PostProcessStageCollection` has no slot for this fork addition. Mirrors
  // the `scene.taaEnabled` pattern.
  cache.godRayEnabled =
    (scene as unknown as { godRayEnabled?: boolean })?.godRayEnabled === true;

  // The screen-space solar halo rides `scene.sunBloom`, the same public flag
  // WebGL's `SunPostProcess` rides, and the same
  // `environmentState.isSunVisible` occlusion test that gates the WebGL
  // chain: a Sun behind the Earth must not paint a halo through it.
  // `frameState.sunHalo.visible` additionally covers the behind-camera and
  // degenerate-geometry cases; `Sun.update` publishes it before the backend
  // branch, in `Scene/SunHaloAppearance.js`.
  cache.sunHaloEnabled =
    (scene as unknown as { sunBloom?: boolean })?.sunBloom === true &&
    (scene as unknown as { _environmentState?: { isSunVisible?: boolean } })
      ?._environmentState?.isSunVisible !== false;

  // The glow rides the same two conditions. It is deliberately NOT gated on
  // `enableScreenSpaceSunHalo`: the two stages are independent members of one
  // chain, and the WebGL twin transfers the bright-pass tuning even on frames
  // where the halo stage is off.
  cache.sunBloomEnabled = cache.sunHaloEnabled;

  // HeatShimmer enabled flag, read at scene level from
  // `scene.heatShimmerEnabled`, which the atmospheric auto-master pushes.
  // Mirrors the godRay scene-flag read.
  cache.heatShimmerEnabled =
    (scene as unknown as { heatShimmerEnabled?: boolean })
      ?.heatShimmerEnabled === true;

  // ColdOptics enabled flag, read at scene level from
  // `scene.coldOpticsEnabled`, which the atmospheric auto-master pushes from
  // a sub-freezing temperature. Mirrors the heatShimmer scene-flag read.
  cache.coldOpticsEnabled =
    (scene as unknown as { coldOpticsEnabled?: boolean })?.coldOpticsEnabled ===
    true;

  // TAA is controlled by `scene.taaEnabled`, not by the collection. The
  // effect is added lazily on the first enabled frame, mirroring the bloom,
  // AO and DoF lazy inits below. Without that, `setStageEnabled("TAA", true)`
  // no-ops on a null `_taaEffect` and `scene.taaEnabled = true` pays for the
  // velocity passes and the MSAA downgrade while producing no temporal
  // accumulation at all.
  //
  // The gate checks the live `pipeline.taaEffect` slot — `addTAA` is itself
  // idempotent — rather than a sticky `cache.taaInitialized` flag, so the
  // effect transparently re-adds after any pipeline recreate that nulls the
  // slot: an HDR toggle, a resize, or a device loss.
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

  // Lazily create the WebGPU velocity-buffer motion-blur effect when
  // `scene.motionBlur` is true. Checking the live `pipeline.motionBlurEffect`
  // slot lets a pipeline recreation add it again. With the default false gate,
  // the effect is neither instantiated nor executed.
  const motionBlurEnabled =
    (scene as unknown as { motionBlur?: boolean })?.motionBlur === true;
  if (motionBlurEnabled && !pipeline.motionBlurEffect) {
    pipeline.addMotionBlur(device, canvasFormat);
  }
  pipeline.setStageEnabled("MotionBlur", motionBlurEnabled);

  // When TAA is active, disable FXAA (TAA provides superior AA).
  const fxaaEnabled = taaEnabled ? false : cache.fxaaEnabled;

  // --- FXAA ---
  pipeline.setStageEnabled("FXAA", fxaaEnabled);

  // HDR canvas output mode. When the user opts into wide-gamut HDR canvas
  // output the OS and display handle the gamut and tone curve, so:
  //
  // - tonemap is bypassed, since compressing HDR to SDR defeats the point;
  // - colorGrading and FXAA keep running with HDR-aware math, because the
  //   pipeline's `setHDROutputMode()` flips each stage's `hdrMode` uniform so
  //   the shaders grade and edge-detect in a Reinhard-compressed [0, 1)
  //   working space and emit linear HDR. Skipping them outright instead would
  //   cost the user grading and anti-aliasing entirely in HDR mode.
  //
  // HDR mode is opt-in through `scene.useHDRCanvasOutput = true` and requires
  // `scene.highDynamicRange = true`, the latter because it is what makes the
  // scene framebuffer rgba16float so the HDR data exists to forward. With
  // either gate off this falls through to the standard SDR pipeline.
  const sceneAny = scene as
    { useHDRCanvasOutput?: boolean; highDynamicRange?: boolean } | undefined;
  const hdrOutputMode =
    sceneAny?.useHDRCanvasOutput === true &&
    sceneAny?.highDynamicRange === true;
  pipeline.setHDROutputMode(hdrOutputMode);
  // WebGL's `PostProcessStageCollection.update()` assigns
  // `tonemapping.enabled = useHdr` every frame, but on WebGPU that update
  // early-returns into this feature renderer before the assignment, so the
  // tonemap gate would never engage under `scene.highDynamicRange = true` and
  // an un-tonemapped HDR frame would reach the SDR canvas. The same rule is
  // applied here and mirrored onto the collection's stage object and the
  // cache, so every observer agrees — the early sync's `_tonemapping.enabled`
  // read and `hasActiveWebGPUPostProcessStages` included. With
  // `highDynamicRange === false` the stage stays disabled.
  const useHdr = sceneAny?.highDynamicRange === true;
  if (collection._tonemapping) {
    collection._tonemapping.enabled = useHdr;
  }
  cache.tonemappingEnabled = useHdr;
  pipeline.setStageEnabled("Tonemap", useHdr && !hdrOutputMode);
  pipeline.setTonemappingMode(cache.tonemapMode);
  // Mirror `PostProcessStageCollection._exposure` into WebGPU tonemapping. The
  // collection defaults to 1.0; auto exposure multiplies its adaptive value by
  // this manual base.
  const userExposure = (collection as unknown as { _exposure?: number })
    ._exposure;
  pipeline.setTonemappingExposure(
    typeof userExposure === "number" ? userExposure : 1.0,
  );

  // Optional triangular-PDF dither runs in tonemapping before conversion to an
  // 8-bit canvas. `scene.ditherEnabled` defaults false; the disabled path writes
  // zero strength and leaves output unchanged. An rgba16float intermediate
  // preserves the sub-LSB noise until the final conversion, whereas a fully
  // 8-bit scene chain has already quantized its gradients before post-process.
  const ditherScene = scene as unknown as {
    ditherEnabled?: boolean;
    ditherStrength?: number;
  };
  const ditherOn = ditherScene?.ditherEnabled === true;
  const ditherStrength = ditherOn
    ? typeof ditherScene.ditherStrength === "number"
      ? ditherScene.ditherStrength
      : 1.0
    : 0.0;
  pipeline.setTonemapDither(ditherStrength);

  // Color grading: lazily initialized on first enable. A scene-level opt-in
  // through `scene.colorGradingEnabled`, with an optional
  // `scene.colorGradingConfig`, mirroring the godRay scene-flag pattern. Off
  // by default, and the stage is not compiled or added until the first
  // enabled frame, so untouched scenes are unaffected. Runs after Tonemap in
  // the pipeline's single-pass chain; under HDR canvas output the pipeline's
  // `setHDROutputMode()` flips the stage into HDR-aware math.
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

  // Auto-exposure follows WebGL, which only runs the reduction when the user
  // opts in through `PostProcessStageCollection._autoExposureEnabled`,
  // default false. `addAutoExposure` is wired unconditionally on WebGPU and
  // `WebGPUAutoExposure.enabled` defaults true, so without syncing the flag
  // down WebGPU auto-exposes every frame. On a near-black HDR night sky the
  // adaptive exposure then collapses the whole frame to black — a measured
  // maximum luminance of 0 with it on, against 761 and five saturated
  // bloom-feeding star points with it off — crushing the bright catalog stars
  // and their bloom halos. Honouring the same opt-in flag WebGL uses makes
  // the two backends expose identically by default. Users who set
  // `autoExposure = true` get the adaptive path on both.
  pipeline.autoExposureEnabled =
    (collection as unknown as { _autoExposureEnabled?: boolean })
      ._autoExposureEnabled === true;

  // Bloom: lazily initialized on first enable. All six WebGL bloom uniforms —
  // contrast, brightness, glowOnly, delta, sigma, stepSize — map one to one
  // onto the WebGPU effect. Feeding WebGL's brightness, which defaults to
  // -0.3, into a luminance threshold instead gives a negative threshold that
  // passes every pixel and blooms the whole scene at default uniforms.
  // `intensity` is a fork extra, an altitude-gate lever; 1.0 matches WebGL's
  // plain `bloom + color` composite.
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

  // Lazily initialize ambient occlusion on first enable.
  if (cache.ambientOcclusionEnabled && !cache.aoInitialized) {
    const ao = collection.ambientOcclusion;
    // The algorithm discriminator is the lone string-typed AO uniform; narrow
    // it to the supported literal union without passing it through `numU`.
    const rawAlgo = ao?.uniforms?.algorithm;
    // `"ssgi"` is an explicit algorithm opt-in. Missing or unknown values
    // retain the `"hbao"` default, and the ambient-occlusion stage must also be
    // enabled.
    const algorithm: "gtao" | "hbao" | "ssgi" =
      rawAlgo === "gtao" || rawAlgo === "hbao" || rawAlgo === "ssgi"
        ? rawAlgo
        : "hbao";
    // Keep the bridge and shader loop policy on the same landing switch. The
    // false branch preserves the historical stepSize read and 4x4 defaults.
    const aoStepCount = WEBGPU_AO_FULL_SAMPLE_PATTERN
      ? numU(ao?.uniforms?.stepCount, 32)
      : numU(ao?.uniforms?.stepSize, 4);
    const aoDirectionCount = numU(
      ao?.uniforms?.directionCount,
      WEBGPU_AO_FULL_SAMPLE_PATTERN ? 8 : 4,
    );
    pipeline.addAmbientOcclusion(
      device,
      canvasFormat,
      {
        algorithm,
        intensity: numU(ao?.uniforms?.intensity, 3.0),
        bias: numU(ao?.uniforms?.bias, 0.1),
        lengthCap: numU(ao?.uniforms?.lengthCap, 0.26),
        stepCount: aoStepCount,
        directionCount: aoDirectionCount,
        ambientOcclusionOnly: Boolean(
          ao?.uniforms?.ambientOcclusionOnly ?? false,
        ),
        // SSILVB parameters; ignored unless the selected algorithm is `"ssgi"`.
        giIntensity: numU(ao?.uniforms?.giIntensity, 1.0),
        sliceCount: numU(ao?.uniforms?.sliceCount, 2),
        ssgiStepCount: numU(ao?.uniforms?.ssgiStepCount, 8),
        radiusPixels: numU(ao?.uniforms?.radiusPixels, 32.0),
        maxWorldRadius: numU(ao?.uniforms?.maxWorldRadius, 500.0),
        thicknessMin: numU(ao?.uniforms?.thicknessMin, 1.0),
        thicknessK: numU(ao?.uniforms?.thicknessK, 0.005),
        luminanceClamp: numU(ao?.uniforms?.luminanceClamp, 7.0),
        expFactor: numU(ao?.uniforms?.expFactor, 2.0),
        aoWeight: numU(ao?.uniforms?.aoWeight, 1.0),
        ssgiDebugMode: numU(ao?.uniforms?.ssgiDebugMode, 0),
      },
      useShaderF16,
    );
    cache.aoInitialized = true;
  }
  pipeline.setStageEnabled("AmbientOcclusion", cache.ambientOcclusionEnabled);
  // Refresh the enabled effect with the overall camera frustum and the current
  // renderer-wide log-depth state.
  if (cache.ambientOcclusionEnabled) {
    updateAmbientOcclusionFrameData(pipeline, scene);
  }

  // Depth of Field: lazily initialized on first enable. Its uniforms come
  // from the upstream DoF composite stage located by `findDepthOfFieldStage`,
  // since there is no `collection._depthOfField` slot to read.
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
  // Refresh the enabled effect with the overall camera frustum and the current
  // renderer-wide log-depth state.
  if (cache.depthOfFieldEnabled) {
    updateDepthOfFieldFrameData(pipeline, scene);
  }

  // User-supplied WGSL stages from `scene.postProcessStages.add(...)`. Built
  // once on the first configure call, and rebuilt if the user clears or adds
  // stages.
  //
  // Recognized stage uniforms:
  //   - `wgslFragmentShader: string` — required. WGSL fragment source.
  //   - `wgslUniformSchema: UniformSchema` — optional. Named-uniform schema
  //     mapping `{ [name]: { type, offset } }`. When present, vec3 and vec4
  //     uniform values may be `number[]` arrays.
  //   - `wgslNumberOfPasses: number` — optional, default 1.
  //   - All other uniform keys: numeric scalars, or arrays when the schema
  //     declares them as vec2, vec3 or vec4, packed into the 64-byte uniform
  //     buffer.
  const userStages = (collection as unknown as { _stages?: unknown[] })._stages;
  const userStageCount = Array.isArray(userStages) ? userStages.length : 0;
  // Rebuild whenever the user-stage list length changes, on an add or a
  // remove, not only on the first build or an emptied list. A runtime add
  // after startup otherwise leaves `_userStagesBuilt` stuck true, so the new
  // stage never compiles if it is WGSL and never warns if it is GLSL.
  // Comparing the live length against the last-built count detects both
  // directions; on a mismatch the existing user-stage compiles are dropped
  // and the list is re-scanned from scratch, so the rebuild below is
  // authoritative. Length alone misses a same-frame `remove()` then `add()`
  // swap, whose net length is unchanged between configure calls, so
  // element-wise stage identity is compared against the last-built list too.
  const listChanged =
    cache._userStagesBuilt &&
    (userStageCount !== (cache._userStagesCount ?? 0) ||
      userStagesIdentityChanged(userStages, cache._userStagesRefs));
  if (listChanged) {
    pipeline.clearUserWGSLStages();
    // Intercepted library stages rebuild on
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
      // Skip the upstream DoF composite: it is intercepted and routed through
      // `pipeline.addDepthOfField` above. Counting it as a GLSL-only stage
      // would fire a misleading warning and suggest the user supply a WGSL
      // shader for an effect already handled natively.
      if (
        stage.name === "czm_depth_of_field" ||
        stage.name === "czm_depth_of_field_blur" ||
        stage.name === "czm_depth_of_field_composite"
      ) {
        continue;
      }
      // Intercept named PostProcessStageLibrary
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
        // Extract the schema and pass count if provided.
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
    // This warning is permanent, not pragma-stripped. A user-supplied GLSL
    // PostProcessStage is silently dropped on the WebGPU backend, which needs
    // WGSL; the dropped stage produces no output and the user has no other
    // signal that their effect did not run. That is a real, user-actionable
    // error rather than a debug diagnostic, so stripping it in production
    // would leave shipping users with silence. `oneTimeWarning` is
    // production-safe — only its internal `defined(identifier)` assert is
    // pragma-stripped, and the `console.warn` body runs in every build — and
    // it dedupes by identifier, so a scene with the same GLSL stage does not
    // spam the console every frame.
    if (glslOnlyCount > 0) {
      oneTimeWarning(
        "WebGPUPostProcessStageCollection.userStagesGLSL",
        `${glslOnlyCount} user-added PostProcessStage instance(s) without ` +
          "a `wgslFragmentShader` uniform detected on a WebGPU scene. " +
          "GLSL custom shaders are not transpiled on the WebGPU backend; " +
          "these stages are SKIPPED (they produce no output). " +
          "Supply a `wgslFragmentShader: string` uniform on each stage to " +
          "execute custom WGSL post-process effects. Stages with " +
          "`wgslFragmentShader` set are honored.",
      );
    }
  } else if (
    cache._userStagesBuilt &&
    (!Array.isArray(userStages) || userStages.length === 0)
  ) {
    pipeline.clearUserWGSLStages();
    // Drop intercepted library stages when the
    // user collection empties, mirroring the user-WGSL teardown.
    pipeline.clearLibraryStages();
    cache._userStagesBuilt = false;
    cache._userStagesCount = 0;
    cache._userStagesRefs = [];
  }

  // Synchronize intercepted library built-ins each frame. The rebuild above
  // only fires on list-length changes, so
  // `enabled` toggles and uniform edits on an already-added library stage
  // (e.g. `stage.uniforms.gradations = 8`) must be pushed every frame.
  // Cheap: a name-match walk over the (typically tiny) stage list; the
  // uniform repack happens GPU-side only for enabled stages at execute.
  syncInterceptedLibraryStages(pipeline, userStages, scene);

  // SunHalo lazy init and per-frame state push. The gate checks the live
  // `pipeline.sunHaloEffect` slot rather than a sticky cache flag, so the
  // effect transparently re-adds after any pipeline recreate that nulls it —
  // an HDR toggle, a resize, a device loss — the same pattern the TAA
  // lazy-add uses.
  if (cache.sunHaloEnabled && !pipeline.sunHaloEffect) {
    pipeline.addSunHalo(device, canvasFormat);
    cache.sunHaloInitialized = true;
  }
  if (pipeline.sunHaloEffect) {
    pipeline.sunHaloEffect.enabled = cache.sunHaloEnabled;
    if (cache.sunHaloEnabled) {
      pushSunHaloFrameState(pipeline, scene);
    }
  }

  // The glow, added and pushed on the same live-slot pattern.
  if (cache.sunBloomEnabled && !pipeline.sunBloomEffect) {
    pipeline.addSunBloom(device, canvasFormat);
    cache.sunBloomInitialized = true;
  }
  if (pipeline.sunBloomEffect) {
    pipeline.sunBloomEffect.enabled = cache.sunBloomEnabled;
    if (cache.sunBloomEnabled) {
      pushSunBloomFrameState(pipeline, scene);
    }
  }

  // GodRay lazy init and per-frame sun UV update. Config can be supplied
  // through `scene.godRayConfig`. Skipped when the scene has no sun
  // configured, because the effect needs the sun's screen-space position to
  // orient the radial blur.
  if (cache.godRayEnabled && !cache.godRayInitialized) {
    const cfg = (
      scene as unknown as {
        godRayConfig?: import("./WebGPUGodRayEffect.js").GodRayConfig;
      }
    )?.godRayConfig;
    pipeline.addGodRay(device, canvasFormat, cfg, useShaderF16);
    cache.godRayInitialized = true;
  }
  // GodRay's enable rides `pipeline.godRayEffect.enabled` directly.
  // `setStageEnabled` only recognizes the named slot stages — TAA, FXAA,
  // Bloom, Tonemap and the rest — and falls through to a no-op for any other
  // name, so routing the god ray through it would be a silent no-op and a
  // second, misleading enable surface.
  if (cache.godRayEnabled && pipeline.godRayEffect) {
    pipeline.godRayEffect.enabled = true;
    updateGodRaySunUV(pipeline, scene);
  } else if (pipeline.godRayEffect) {
    pipeline.godRayEffect.enabled = false;
  }

  // When the opt-in `scene.godRayCloudAware` flag is on and both god rays and
  // procedural clouds are active, request the cloud renderer's screen-space
  // transmittance mask and feed it to the god-ray generate pass, so dense
  // clouds attenuate the shaft and crepuscular rays form through the gaps.
  // The capture flag is honoured by the next cloud pass, while the view read
  // here is the mask the cloud pass rendered this frame — null on the warmup
  // frame or when culled, at which point the effect uses its white 1×1
  // fallback. With the flag absent or clouds off, the capture is released and
  // the view cleared, leaving depth-only god rays.
  if (pipeline.godRayEffect) {
    const sceneCtx = (scene as unknown as { context?: unknown })?.context;
    // Cloud-unification epic slice 4A/4B — the volumetric-cloud gate reads the
    // managed default cloud collection's exclusive `renderMode` (VOLUMETRIC === 1).
    // The legacy `globe.showProceduralClouds` field was removed in 4B — the
    // collection's `renderMode` is the single authority. Default (BILLBOARD) →
    // false → the depth-only god rays stay byte-identical.
    const godRayGlobe = (
      scene as unknown as {
        globe?: {
          defaultCloudCollection?: { renderMode?: number };
        };
      }
    )?.globe;
    const cloudsActive = godRayGlobe?.defaultCloudCollection?.renderMode === 1; // CloudRenderMode.VOLUMETRIC
    const cloudAwareRequested =
      cache.godRayEnabled &&
      (scene as unknown as { godRayCloudAware?: boolean })?.godRayCloudAware ===
        true &&
      cloudsActive;
    if (sceneCtx) {
      const ctx = sceneCtx as Parameters<
        typeof setCloudTransmittanceCapture
      >[0];
      setCloudTransmittanceCapture(ctx, cloudAwareRequested);
      pipeline.godRayEffect.setCloudTransmittanceView(
        cloudAwareRequested ? getCloudTransmittanceView(ctx) : null,
      );
    } else if (!cloudAwareRequested) {
      pipeline.godRayEffect.setCloudTransmittanceView(null);
    }
  }

  // HeatShimmer lazy init, plus the per-frame clock, intensity and
  // continuous-render drive. Config can be supplied through
  // `scene.heatShimmerConfig`.
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

  // ColdOptics lazy init, plus the per-frame camera, sun and inverse-matrix
  // push. Config can be supplied through `scene.coldOpticsConfig`.
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

  // Unified aerial-perspective atmosphere, driven by the scene-level
  // `scene.aerialPerspective` flag, since upstream
  // `PostProcessStageCollection` has no slot for it. Lazily initialized on
  // first enable; per frame the configure pass pushes the camera, sun and
  // atmosphere uniforms and the Bruneton transmittance LUT view.
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

// Minimal structural view of a PostProcessStage / PostProcessStageComposite
// for the silhouette uniform walk — both expose `uniforms`, and composites
// expose their children on `_stages`.
interface StageNodeLike {
  uniforms?: Record<string, unknown>;
  _stages?: Array<StageNodeLike | undefined | null>;
}

/**
 * Resolve the effective edge `color`/`length`
 * uniforms for a `czm_silhouette` stage.
 *
 * Single-stage form: the outer composite's `uniforms` alias points at the
 * edge-detection stage's `{ length, color }`, so it's returned directly.
 *
 * Array form (`createSilhouetteStage([edgeStages])`): the outer wrapper's
 * `uniforms` alias is `undefined` because the intermediate
 * `czm_edge_detection_composite` is built without a uniforms option. The
 * real values live on the individual edge-detection stages nested under
 * `_stages`. Depth-first search returns the first descendant carrying an
 * own `length` or `color` uniform (the first edge stage — matching WebGL's
 * "first edge with alpha wins" combine order for the single edge pass the
 * WebGPU twin runs). Returns null when nothing is found.
 */
function resolveSilhouetteEdgeUniforms(
  node: unknown,
): Record<string, unknown> | null {
  const stage = node as StageNodeLike | null | undefined;
  if (!stage || typeof stage !== "object") return null;
  const u = stage.uniforms;
  if (
    u &&
    (Object.prototype.hasOwnProperty.call(u, "length") ||
      Object.prototype.hasOwnProperty.call(u, "color"))
  ) {
    return u;
  }
  const children = stage._stages;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = resolveSilhouetteEdgeUniforms(child);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Synchronize intercepted PostProcessStageLibrary built-ins each frame. Walk
 * the live collection stage list and, for every stage whose name matches a
 * wired library built-in, push its `enabled` flag + uniform values + the frame
 * context
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
    let uniforms = stage.uniforms ?? {};
    if (key === "silhouette") {
      // Array-form createSilhouetteStage([edgeStages]) wraps its edge
      // detection in a `czm_edge_detection_composite` composite that
      // carries NO uniforms, so the outer `czm_silhouette` composite's
      // `uniforms` alias is undefined and packEdgeUniforms would render
      // the black/0.25 defaults. The real color/length live on the
      // inner edge-detection stage(s). Walk `_stages` to find them so the
      // single edge pass matches WebGL's first-edge color/length. The
      // single-stage form already carries color/length on the outer
      // wrapper, so this returns it unchanged.
      const resolved = resolveSilhouetteEdgeUniforms(s);
      if (resolved !== null) {
        uniforms = resolved;
      }
    }
    pipeline.syncLibraryStage(
      stage.name,
      stage.enabled !== false,
      uniforms,
      frame,
    );
  }
}

// WGS84 maximum radius (metres) — the `earthRadius` uniform default of
// PostProcessStageLibrary.createLensFlareStage (Ellipsoid.WGS84
// .maximumRadius). Matches AP_WGS84_MAX_RADIUS below.
const LENS_FLARE_WGS84_MAX_RADIUS = 6378137.0;

/**
 * Compute the CPU twin of the czm_* frame state the WebGL
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

// Track V-A2 atmosphere constants
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
          // Sun-relative sky-view and multiple-scattering LUT views, shared
          // with the visible SkyAtmosphere.
          skyViewView?: GPUTextureView;
          multipleScatterView?: GPUTextureView;
        } | null;
      };
      // Opt-in flag, false by default, read off the WebGPU context's getter,
      // which is threaded from `contextOptions.webgpu.envMapMultiScatter`.
      envMapMultiScatter?: boolean;
    };
    camera?: { frustum?: { near?: number; far?: number } };
    skyAtmosphere?: { atmosphereLightIntensity?: number };
    // Opt-in froxel fast path, nested under the aerial-perspective opt-in.
    aerialPerspectiveFroxel?: boolean;
    // Runtime-mutable numeric haze settings, refreshed while the effect is
    // enabled and the required camera uniforms are available. Structural modes
    // use their dedicated scene-level controls.
    aerialPerspectiveConfig?: {
      intensity?: number;
      inscatterScale?: number;
    };
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

  // Opt-in sky-view-LUT in-scatter source, false by default, which leaves the
  // analytic single-scatter march in place. When on, the sun-relative
  // sky-view and multiple-scattering LUT views are pushed — the same tables
  // the visible SkyAtmosphere samples — so the distance haze matches the
  // visible sky. The views and flag are pushed every frame; the effect binds
  // the white placeholder and keeps `params1.z` off until both are present.
  const envMapMultiScatter = sceneAny?.context?.envMapMultiScatter === true;
  fx.setSkyViewView(lut?.skyViewView ?? null);
  fx.setMultipleScatterView(lut?.multipleScatterView ?? null);
  fx.setUseMultiScatterLut(envMapMultiScatter);

  // The opt-in froxel path bakes a 32³ volume and replaces the analytic
  // per-pixel march with one trilinear fetch. The default false gate retains
  // the analytic path.
  fx.setFroxelEnabled(sceneAny?.aerialPerspectiveFroxel === true);

  // Refresh the numeric haze settings on each valid enabled-frame update.
  // Missing properties leave the effect's current values unchanged; structural
  // modes are controlled separately.
  const apCfg = sceneAny?.aerialPerspectiveConfig;
  if (apCfg) {
    if (typeof apCfg.intensity === "number") {
      fx.setIntensity(apCfg.intensity);
    }
    if (typeof apCfg.inscatterScale === "number") {
      fx.setInscatterScale(apCfg.inscatterScale);
    }
  }

  const cam = us.cameraPosition;
  const sun = us.sunDirectionWC ?? { x: 0, y: 0, z: 1 };
  const near = sceneAny?.camera?.frustum?.near ?? 1.0;
  const far = sceneAny?.camera?.frustum?.far ?? 1e8;
  const lightIntensity =
    sceneAny?.skyAtmosphere?.atmosphereLightIntensity ?? 50.0;

  // Feed the sun-view beer shadow map and its world-to-sun-clip matrix from
  // the procedural cloud renderer's cache, so the inscatter dims under the
  // clouds. The cloud renderer runs earlier in the same frame's
  // environmental-effects chain, so the map and matrix read here are current.
  // With `globe.cloudCastShadows` off, `shadowActive` is false and the effect
  // binds the placeholder and the disabled control.
  const cloudCache = (
    scene as unknown as {
      context?: {
        _cloudCache?: {
          shadowActive?: boolean;
          shadowView?: GPUTextureView | null;
          shadowAbsorption?: number;
          // Eclipse-aware strength, from the one `_cloudCache` seam.
          shadowStrength?: number;
          shadowFrame?: CloudShadowFrame;
        };
      };
    }
  )?.context?._cloudCache;
  const csActive = cloudCache?.shadowActive === true && !!cloudCache.shadowView;
  fx.setCloudShadowView(csActive ? cloudCache!.shadowView! : null);
  // Emit the sun-view matrix relative to this effect's camera so the fragment
  // shader multiplies a camera-relative offset instead of a full-ECEF
  // position. The frame owner cancels the planet-scale translation in f64.
  const cloudShadowFrame = cloudCache?.shadowFrame;
  let cloudShadowVpRelativeToEye: Float32Array | undefined;
  if (csActive && cloudShadowFrame?.valid === true) {
    writeCloudShadowViewProjectionRelativeToEye(
      cloudShadowVpScratch,
      0,
      cloudShadowFrame,
      cam.x,
      cam.y,
      cam.z,
    );
    cloudShadowVpRelativeToEye = cloudShadowVpScratch;
  }

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
    cloudShadowVP: cloudShadowVpRelativeToEye,
    // A valid eye-relative frame is now part of "active": without it the FS
    // would project a camera-relative offset through an absolute matrix.
    cloudShadowActive: csActive && cloudShadowVpRelativeToEye !== undefined,
    cloudShadowAbsorption: cloudCache?.shadowAbsorption ?? 0.04,
    // The same `_cloudCache` seam as the absorption above.
    cloudShadowStrength: cloudCache?.shadowStrength ?? 1.0,
  });
}

/**
 * Push `frameState.sunHalo` into the WebGPU halo effect.
 *
 * A pure transfer, deliberately. Every number is resolved once in
 * `Scene/SunHaloAppearance.js` before the backend branch and consumed
 * identically by WebGL's `SolarHalo` stage; re-deriving any of it here — the
 * projection, the limb size, the eclipse factor — is exactly the drift the
 * publish-then-branch convention exists to prevent. When the publication is
 * missing or reports `visible === false`, the amplitude is pushed as 0, which
 * makes the effect skip its pass entirely.
 */
function pushSunHaloFrameState(
  pipeline: WebGPUPostProcessPipeline,
  scene: CesiumScene | undefined,
): void {
  const halo = (
    scene as unknown as {
      frameState?: {
        sunHalo?: {
          visible?: boolean;
          centerX?: number;
          centerY?: number;
          limbPx?: number;
          haloCoreRadii?: number;
          haloIntensity?: number;
          haloColorR?: number;
          haloColorG?: number;
          haloColorB?: number;
        };
      };
    }
  )?.frameState?.sunHalo;
  if (!halo || halo.visible !== true) {
    pipeline.setSunHaloFrameState({
      centerX: 0,
      centerY: 0,
      limbPx: 1,
      coreRadii: 1,
      intensity: 0,
      colorR: 1,
      colorG: 1,
      colorB: 1,
    });
    return;
  }
  pipeline.setSunHaloFrameState({
    centerX: halo.centerX ?? 0,
    centerY: halo.centerY ?? 0,
    limbPx: halo.limbPx ?? 1,
    coreRadii: halo.haloCoreRadii ?? 1,
    intensity: halo.haloIntensity ?? 0,
    colorR: halo.haloColorR ?? 1,
    colorG: halo.haloColorG ?? 1,
    colorB: halo.haloColorB ?? 1,
  });
}

/**
 * Push `frameState.sunHalo` into the WebGPU glow effect.
 *
 * Pure transfer, with the one derived quantity taken from the shared model
 * rather than recomputed: `solarBloomCompositeRadiusPx` turns the published
 * pixels-per-solar-radius into the composite's fade radius, and it is the same
 * function the WebGL chain's own radius is pinned against.
 *
 * The gate is `geometryValid`, not `visible`: `visible` additionally requires
 * the screen halo to be switched on, and an app that disables the halo still
 * gets the glow. A missing publication or an unusable projection pushes a
 * radius of 0, which makes the effect skip its passes entirely.
 */
function pushSunBloomFrameState(
  pipeline: WebGPUPostProcessPipeline,
  scene: CesiumScene | undefined,
): void {
  const halo = (
    scene as unknown as {
      frameState?: {
        sunHalo?: {
          geometryValid?: boolean;
          centerX?: number;
          centerY?: number;
          limbPx?: number;
          brightPassThreshold?: number;
          brightPassOffset?: number;
        };
      };
    }
  )?.frameState?.sunHalo;
  if (!halo || halo.geometryValid !== true) {
    pipeline.setSunBloomFrameState({
      brightPassThreshold: SUN_BRIGHT_PASS_THRESHOLD_LEGACY,
      brightPassOffset: SUN_BRIGHT_PASS_OFFSET_LEGACY,
      centerX: 0,
      centerY: 0,
      radiusPx: 0,
    });
    return;
  }
  pipeline.setSunBloomFrameState({
    brightPassThreshold:
      typeof halo.brightPassThreshold === "number"
        ? halo.brightPassThreshold
        : SUN_BRIGHT_PASS_THRESHOLD_LEGACY,
    brightPassOffset:
      typeof halo.brightPassOffset === "number"
        ? halo.brightPassOffset
        : SUN_BRIGHT_PASS_OFFSET_LEGACY,
    centerX: halo.centerX ?? 0,
    centerY: halo.centerY ?? 0,
    radiusPx: solarBloomCompositeRadiusPx(halo.limbPx ?? 0),
  });
}

// The per-frame sun screen-space UV, computed by projecting
// `scene.sun.position` — or the directional sun direction when no Sun
// primitive is configured — through the camera's view-projection matrix and
// converting NDC to UV. Off-screen suns emit UVs outside [0, 1]; the GodRay
// shader still produces a directional glow across the visible region.
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
        // `currentFrustum` is set per frustum during the multi-frustum
        // command-list traversal, so by the time the post-process configure
        // runs it carries whichever frustum's near and far were last applied,
        // typically the far one. The full-scene depth linearization for GodRay
        // needs the camera's overall near and far, not the last per-frustum
        // slice.
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
  // Pull the frustum span from the camera object, not from
  // `uniformState.currentFrustum`. The latter is mutated per frustum during
  // command execution, and by the time the configure pass runs it reflects
  // the last per-frustum slice, the far one. The GodRay generate pass would
  // then linearize depth against that slice's near and far, collapsing
  // foreground geometry depths to near zero, gating every sample as sky, and
  // letting shafts leak through occluders. The camera's overall near and far
  // bracket the entire scene depth range.
  const cam = (
    scene as unknown as {
      camera?: { frustum?: { near?: number; far?: number } };
    }
  )?.camera;
  const near = cam?.frustum?.near;
  const far = cam?.frustum?.far;
  if (typeof near === "number" && typeof far === "number" && far > near) {
    // Pass the renderer-wide log-depth state with the frustum; the God-ray
    // generate shader reverses sampled log depth when this flag is active.
    fx.setFrustum(
      near,
      far,
      isWebGPULogDepthActive(
        (scene as unknown as { context?: { _logDepthWriteEnabled?: boolean } })
          ?.context,
        (scene as unknown as { frameState?: { useLogDepth?: boolean } })
          ?.frameState,
      ),
    );
  }
  // Touch the scratch slot so esbuild can't tree-shake the alloc that
  // future versions may use for SIMD-aware projection.
  _godRayScratchClip[0] = cx;
}

/**
 * Resolves the overall camera frustum and renderer-wide log-depth state for a
 * depth-reading post-process effect. `uniformState.currentFrustum` is mutated
 * per slice and can represent only the far slice when configuration runs, so
 * this reads `scene.camera.frustum`. Returns `null` until near and far form a
 * valid bracket, leaving the effect's current values intact.
 */
function resolvePostProcessFrustum(scene?: CesiumScene): {
  near: number;
  far: number;
  logActive: boolean;
} | null {
  const sceneAny = scene as unknown as {
    camera?: { frustum?: { near?: number; far?: number } };
    context?: { _logDepthWriteEnabled?: boolean };
    frameState?: { useLogDepth?: boolean };
  };
  const near = sceneAny?.camera?.frustum?.near;
  const far = sceneAny?.camera?.frustum?.far;
  if (typeof near !== "number" || typeof far !== "number" || !(far > near)) {
    return null;
  }
  const logActive = isWebGPULogDepthActive(
    sceneAny?.context,
    sceneAny?.frameState,
  );
  return { near, far, logActive };
}

/**
 * Updates the ambient-occlusion generator with the live overall-camera
 * frustum and renderer-wide log-depth state.
 */
function updateAmbientOcclusionFrameData(
  pipeline: WebGPUPostProcessPipeline,
  scene?: CesiumScene,
): void {
  const fx = pipeline.ambientOcclusionEffect;
  if (!fx) return;
  const f = resolvePostProcessFrustum(scene);
  if (f) fx.setFrustum(f.near, f.far, f.logActive);
  // Fade SSGI from 1 at or below 8,000 metres to 0 at or above 60,000 metres so
  // orbit frames are a byte-exact no-op. `setAltitudeFade` ignores the HBAO and
  // GTAO algorithms.
  const cam = (
    scene as unknown as {
      camera?: { positionCartographic?: { height?: number } };
    }
  )?.camera;
  const height = cam?.positionCartographic?.height;
  if (typeof height === "number") {
    const loFade = 8000.0;
    const hiFade = 60000.0;
    const fade = Math.max(
      0.0,
      Math.min(1.0, 1.0 - (height - loFade) / (hiFade - loFade)),
    );
    fx.setAltitudeFade(fade);
  }
}

/**
 * Updates the depth-of-field composite with the live overall-camera frustum
 * and renderer-wide log-depth state.
 */
function updateDepthOfFieldFrameData(
  pipeline: WebGPUPostProcessPipeline,
  scene?: CesiumScene,
): void {
  const fx = pipeline.depthOfFieldEffect;
  if (!fx) return;
  const f = resolvePostProcessFrustum(scene);
  if (f) fx.setFrustum(f.near, f.far, f.logActive);
}

// Monotonic epoch for the shimmer animation clock, captured on first use so
// the shader receives a small elapsed-seconds value. A raw
// `performance.now()`, or a JulianDate, loses f32 precision in the WGSL noise
// field and freezes the animation.
let _heatShimmerEpochMs = -1;

/**
 * Push the per-frame HeatShimmer uniforms — the elapsed-seconds clock, the
 * intensity, and the frustum near and far for the optional depth fade — and
 * keep the scene rendering.
 *
 * `requestRenderMode` scenes only render when something requests a frame, and
 * an animated warp must advance every frame, so while the effect is enabled
 * this calls `scene.requestRender()` each frame, the same mechanism other
 * continuous effects rely on. Without it the warp freezes on a settled
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

// WGS84 max radius in metres, matching
// `Cartesian3.maximumComponent(WGS84.radii)`. Used as the inner radius for
// the world-up reconstruction; the effect only needs the ellipsoid scale to
// form local up from the camera position.
const COLD_OPTICS_INNER_RADIUS = 6378137.0;

/**
 * Push the per-frame camera, sun and inverse-matrix uniforms into the
 * ColdOptics effect and keep the scene rendering. Reads the camera world
 * position, inverse projection, inverse view and sun direction from
 * `uniformState` — the same sources as `updateAerialPerspectiveFrameData` —
 * plus the intensity from `scene.coldOpticsIntensity`. Mirrors the godRay and
 * heat-shimmer per-frame setters.
 *
 * `requestRenderMode` scenes only render on demand, and the sun position
 * drifts with the clock, so while the effect is enabled this requests a frame
 * each pass so the halo tracks the sun, the same mechanism the heat-shimmer
 * clock relies on.
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

  // The advanced opt-in from `effects.optics.advanced`, pushed as
  // `scene.coldOpticsAdvanced`. Drives the shader's advanced branch: the 22
  // and 46 degree dispersed halos, the tangent arc, and the light pillars.
  // Off by default, which keeps the halo and sun-dogs path.
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
