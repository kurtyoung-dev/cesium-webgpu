/**
 * WebGPU Post-Process Stage Collection
 *
 * Integration layer that connects PostProcessStageCollection.js to the
 * existing WebGPUPostProcessPipeline.ts infrastructure.
 *
 * Maps CesiumJS post-process stages to WebGPU render passes:
 * - FXAA (built-in via WebGPUPostProcessPipeline)
 * - Tonemapping / HDR (built-in via WebGPUPostProcessPipeline)
 * - Custom stages (mapped to WebGPU compute/render passes)
 *
 * @module WebGPUPostProcessStageCollection
 */

interface PostProcessCache {
  initialized: boolean;
  fxaaEnabled: boolean;
  tonemappingEnabled: boolean;
  ambientOcclusionEnabled: boolean;
  bloomEnabled: boolean;
}

/**
 * Update WebGPU post-process stage collection.
 * Delegates to WebGPUPostProcessPipeline for actual rendering.
 */
function updateWebGPUPostProcessStages(collection: any, frameState: any): void {
  const context = frameState.context;

  if (!collection._webgpuCache) {
    collection._webgpuCache = {
      initialized: false,
      fxaaEnabled: false,
      tonemappingEnabled: false,
      ambientOcclusionEnabled: false,
      bloomEnabled: false,
    } as PostProcessCache;
  }

  const cache = collection._webgpuCache as PostProcessCache;

  // Sync stage enable states from CesiumJS collection
  cache.fxaaEnabled = collection.fxaa ? collection.fxaa.enabled : false;
  cache.tonemappingEnabled = collection._tonemapping
    ? collection._tonemapping.enabled
    : true;
  cache.ambientOcclusionEnabled = collection.ambientOcclusion
    ? collection.ambientOcclusion.enabled
    : false;
  cache.bloomEnabled = collection.bloom ? collection.bloom.enabled : false;

  // The actual post-processing is handled by WebGPUPostProcessPipeline
  // which is invoked by WebGPUSceneRenderer during the resolve phase.
  // Here we just sync the configuration state.

  // Set flags that Scene.js checks for post-processing
  collection._activeStagesChanged = false;

  cache.initialized = true;
}

/**
 * Destroy WebGPU post-process resources.
 */
function destroyWebGPUPostProcessResources(collection: any): void {
  collection._webgpuCache = undefined;
}

/**
 * Check if any post-process stages are active for WebGPU.
 */
function hasActiveWebGPUPostProcessStages(collection: any): boolean {
  const cache = collection._webgpuCache as PostProcessCache | undefined;
  if (!cache || !cache.initialized) {
    return false;
  }
  return (
    cache.fxaaEnabled ||
    cache.tonemappingEnabled ||
    cache.ambientOcclusionEnabled ||
    cache.bloomEnabled
  );
}

export {
  updateWebGPUPostProcessStages,
  destroyWebGPUPostProcessResources,
  hasActiveWebGPUPostProcessStages,
};
export default {
  updateWebGPUPostProcessStages,
  destroyWebGPUPostProcessResources,
  hasActiveWebGPUPostProcessStages,
};
