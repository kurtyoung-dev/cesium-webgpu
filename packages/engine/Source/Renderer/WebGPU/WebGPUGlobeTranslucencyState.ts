/**
 * WebGPU Globe Translucency State
 *
 * Manages derived commands for translucent globe rendering in WebGPU.
 * Creates modified render pipeline states with appropriate blending
 * for translucent globe surface tiles.
 *
 * @module WebGPUGlobeTranslucencyState
 */

interface GlobeTranslucencyCache {
  initialized: boolean;
}

/**
 * Update derived commands for WebGPU globe translucency.
 * Creates pipeline variants with translucent blend states for globe tiles.
 */
function updateWebGPUGlobeTranslucencyDerivedCommands(
  state: any,
  command: any,
  frameState: any,
): void {
  if (!state._webgpuCache) {
    state._webgpuCache = {
      initialized: false,
    } as GlobeTranslucencyCache;
  }

  const cache = state._webgpuCache as GlobeTranslucencyCache;

  // For WebGPU, translucency is handled via pipeline blend state modifications
  // The command's pipeline is modified to use alpha blending when translucent
  if (!command._webgpuDerivedTranslucent) {
    command._webgpuDerivedTranslucent = true;
  }

  // The derived command types determine what modifications are needed:
  // - OPAQUE_FRONT_FACE: front face only, depth write
  // - OPAQUE_BACK_FACE: back face only, depth write
  // - DEPTH_ONLY_FRONT_FACE: front face, depth only (no color)
  // - DEPTH_ONLY_BACK_FACE: back face, depth only (no color)
  // - DEPTH_ONLY_FRONT_AND_BACK_FACE: both faces, depth only
  // - TRANSLUCENT_FRONT_FACE: front face, alpha blend
  // - TRANSLUCENT_BACK_FACE: back face, alpha blend
  // - TRANSLUCENT_FRONT_FACE_MANUAL_DEPTH_TEST: front + manual depth
  // - TRANSLUCENT_BACK_FACE_MANUAL_DEPTH_TEST: back + manual depth

  // For now, mark derived command states as ready
  // The actual pipeline modification happens at draw time via
  // WebGPUPipelineDescriptorBuilder blend state settings
  const derivedCommandTypes = state._derivedCommandTypesToUpdate;
  const derivedCommandCount = state._derivedCommandTypesToUpdateLength;

  for (let i = 0; i < derivedCommandCount; i++) {
    const type = derivedCommandTypes[i];
    // Store the derived type for pipeline creation
    if (!command._webgpuTranslucencyTypes) {
      command._webgpuTranslucencyTypes = [];
    }
    command._webgpuTranslucencyTypes[i] = type;
  }

  cache.initialized = true;
}

/**
 * Destroy WebGPU globe translucency resources.
 */
function destroyWebGPUGlobeTranslucencyResources(state: any): void {
  state._webgpuCache = undefined;
}

export {
  updateWebGPUGlobeTranslucencyDerivedCommands,
  destroyWebGPUGlobeTranslucencyResources,
};
export default {
  updateWebGPUGlobeTranslucencyDerivedCommands,
  destroyWebGPUGlobeTranslucencyResources,
};
