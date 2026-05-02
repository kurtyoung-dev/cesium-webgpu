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
import oneTimeWarning from "../../Core/oneTimeWarning.js";

export interface PostProcessCache {
  initialized: boolean;
  fxaaEnabled: boolean;
  tonemappingEnabled: boolean;
  tonemapMode: number;
  ambientOcclusionEnabled: boolean;
  bloomEnabled: boolean;
  depthOfFieldEnabled: boolean;
  // Track whether complex effects have been initialized on the pipeline
  bloomInitialized: boolean;
  aoInitialized: boolean;
  dofInitialized: boolean;
  // Track bloom/AO uniform values for dirty checking
  bloomThreshold: number;
  bloomIntensity: number;
  aoIntensity: number;
  aoBias: number;
}

function getDefaultCache(): PostProcessCache {
  return {
    initialized: false,
    fxaaEnabled: false,
    tonemappingEnabled: true,
    tonemapMode: TonemapMode.REINHARD,
    ambientOcclusionEnabled: false,
    bloomEnabled: false,
    depthOfFieldEnabled: false,
    bloomInitialized: false,
    aoInitialized: false,
    dofInitialized: false,
    bloomThreshold: 0.8,
    bloomIntensity: 0.5,
    aoIntensity: 3.0,
    aoBias: 0.1,
  };
}

/**
 * Map CesiumJS Tonemapper enum to our WebGPU tonemapping mode.
 * CesiumJS: REINHARD=0, MODIFIED_REINHARD=1, FILMIC=2, ACES=3, PBR_NEUTRAL=4
 */
function mapTonemapType(collection: CesiumObjectWithWebGPUCache): number {
  const type = collection._tonemapping?.type ?? collection._tonemappingType;
  switch (type) {
    case 0:
      return TonemapMode.REINHARD;
    case 1:
      return TonemapMode.MODIFIED_REINHARD;
    case 2:
      return TonemapMode.FILMIC;
    case 3:
      return TonemapMode.ACES;
    case 4:
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

  const cache = collection._webgpuCache as PostProcessCache;

  // Read current state from the CesiumJS collection
  cache.fxaaEnabled = collection.fxaa?.enabled ?? false;
  cache.tonemappingEnabled = collection._tonemapping?.enabled ?? true;
  cache.tonemapMode = mapTonemapType(collection);
  cache.bloomEnabled = collection.bloom?.enabled ?? false;
  cache.ambientOcclusionEnabled = collection.ambientOcclusion?.enabled ?? false;
  cache.depthOfFieldEnabled = collection._depthOfField?.enabled ?? false;

  // Cache bloom/AO uniform values for runtime update
  if (cache.bloomEnabled) {
    const bloom = collection.bloom;
    cache.bloomThreshold = bloom?.uniforms?.brightness ?? 0.8;
    cache.bloomIntensity = bloom?.uniforms?.glowOnly ? 1.0 : 0.5;
  }
  if (cache.ambientOcclusionEnabled) {
    const ao = collection.ambientOcclusion;
    cache.aoIntensity = ao?.uniforms?.intensity ?? 3.0;
    cache.aoBias = ao?.uniforms?.bias ?? 0.1;
  }

  // AUDIT_2026_05_02 A.13 — surface that user-added PostProcessStage
  // instances aren't yet honored on WebGPU. We walk built-in named slots
  // above; the user-added `_stages` array (where `scene.postProcessStages.add(...)`
  // entries land) is currently silently dropped. Warn once per process.
  //>>includeStart('debug', pragmas.debug);
  const userStages = (collection as unknown as { _stages?: unknown[] })._stages;
  if (Array.isArray(userStages)) {
    let userStageCount = 0;
    for (const s of userStages) {
      if (s !== undefined && s !== null) userStageCount++;
    }
    if (userStageCount > 0) {
      oneTimeWarning(
        "WebGPUPostProcessStageCollection.userStages",
        `${userStageCount} user-added PostProcessStage instance(s) detected on a ` +
          "WebGPU scene. User custom GLSL stages are not yet executed on the WebGPU " +
          "backend; only built-in named slots (fxaa, bloom, ambientOcclusion, " +
          "depthOfField, tonemapping) are honored. Track AUDIT_2026_05_02 A.13.",
      );
    }
  }
  //>>includeEnd('debug');

  collection._activeStagesChanged = false;
  cache.initialized = true;
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

  // --- TAA (controlled by scene.taaEnabled, not the collection) ---
  const taaEnabled = scene?.taaEnabled === true;
  pipeline.setStageEnabled("TAA", taaEnabled);
  // When TAA is active, disable FXAA (TAA provides superior AA).
  const fxaaEnabled = taaEnabled ? false : cache.fxaaEnabled;

  // --- FXAA ---
  pipeline.setStageEnabled("FXAA", fxaaEnabled);

  // --- Tonemapping ---
  pipeline.setStageEnabled("Tonemap", cache.tonemappingEnabled);
  pipeline.setTonemappingMode(cache.tonemapMode);

  // --- Bloom: lazily initialize on first enable ---
  if (cache.bloomEnabled && !cache.bloomInitialized) {
    const bloom = collection.bloom;
    pipeline.addBloom(device, canvasFormat, {
      threshold: bloom?.uniforms?.brightness ?? 0.8,
      intensity: bloom?.uniforms?.glowOnly ? 1.0 : 0.5,
      sigma: bloom?.uniforms?.sigma ?? 3.5,
      glowOnly: Boolean(bloom?.uniforms?.glowOnly ?? false),
    });
    cache.bloomInitialized = true;
  }
  pipeline.setStageEnabled("Bloom", cache.bloomEnabled);

  // Update bloom config if it changed
  if (cache.bloomEnabled && pipeline.bloomEffect) {
    const bloom = collection.bloom;
    const newThreshold = bloom?.uniforms?.brightness ?? 0.8;
    const newIntensity = bloom?.uniforms?.glowOnly ? 1.0 : 0.5;
    if (
      newThreshold !== cache.bloomThreshold ||
      newIntensity !== cache.bloomIntensity
    ) {
      pipeline.bloomEffect.updateConfig({
        threshold: newThreshold,
        intensity: newIntensity,
        glowOnly: Boolean(bloom?.uniforms?.glowOnly ?? false),
      });
      cache.bloomThreshold = newThreshold;
      cache.bloomIntensity = newIntensity;
    }
  }

  // --- Ambient Occlusion: lazily initialize on first enable ---
  if (cache.ambientOcclusionEnabled && !cache.aoInitialized) {
    const ao = collection.ambientOcclusion;
    // AUDIT_2026_05_02 B.13 — read `algorithm` from user uniforms so
    // GTAO is reachable without monkey-patching. Falls back to "hbao"
    // when unset for backwards compatibility.
    const rawAlgo = ao?.uniforms?.algorithm;
    const algorithm =
      rawAlgo === "gtao" || rawAlgo === "hbao" ? rawAlgo : "hbao";
    pipeline.addAmbientOcclusion(device, canvasFormat, {
      algorithm,
      intensity: ao?.uniforms?.intensity ?? 3.0,
      bias: ao?.uniforms?.bias ?? 0.1,
      lengthCap: ao?.uniforms?.lengthCap ?? 0.26,
      stepCount: ao?.uniforms?.stepSize ?? 4,
      directionCount: ao?.uniforms?.directionCount ?? 4,
      ambientOcclusionOnly: Boolean(
        ao?.uniforms?.ambientOcclusionOnly ?? false,
      ),
    });
    cache.aoInitialized = true;
  }
  pipeline.setStageEnabled("AmbientOcclusion", cache.ambientOcclusionEnabled);

  // --- Depth of Field: lazily initialize on first enable ---
  if (cache.depthOfFieldEnabled && !cache.dofInitialized) {
    const dof = collection._depthOfField;
    pipeline.addDepthOfField(device, canvasFormat, {
      focalDistance: dof?.uniforms?.focalDistance ?? 50.0,
      focalRange: dof?.uniforms?.delta ?? 20.0,
      blurSigma: dof?.uniforms?.sigma ?? 4.0,
    });
    cache.dofInitialized = true;
  }
  pipeline.setStageEnabled("DepthOfField", cache.depthOfFieldEnabled);
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
    cache.depthOfFieldEnabled
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
