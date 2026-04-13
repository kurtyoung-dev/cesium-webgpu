/**
 * WebGPU Globe Translucency State
 *
 * Manages derived commands for translucent globe rendering in WebGPU.
 * Creates modified render pipeline states with appropriate blending
 * for translucent globe surface tiles.
 *
 * Derived command types (from GlobeTranslucencyState):
 *   OPAQUE_FRONT_FACE        — front face only, depth write, no blend
 *   OPAQUE_BACK_FACE         — back face only, depth write, no blend
 *   DEPTH_ONLY_FRONT_FACE    — front face, depth only (no color)
 *   DEPTH_ONLY_BACK_FACE     — back face, depth only (no color)
 *   DEPTH_ONLY_FRONT_AND_BACK_FACE — both faces, depth only
 *   TRANSLUCENT_FRONT_FACE   — front face, alpha blend
 *   TRANSLUCENT_BACK_FACE    — back face, alpha blend
 *   TRANSLUCENT_FRONT_FACE_MANUAL_DEPTH_TEST  — front + manual depth
 *   TRANSLUCENT_BACK_FACE_MANUAL_DEPTH_TEST   — back + manual depth
 *
 * For WebGPU, the blend state and cull mode are baked into the pipeline,
 * so we mark commands with the derived type. At execute time, the
 * WebGPU command executor creates/selects the correct pipeline variant
 * based on these markers.
 *
 * @module WebGPUGlobeTranslucencyState
 */

/** Per-command translucency cache attached to the GlobeTranslucencyState */
interface GlobeTranslucencyCache {
  initialized: boolean;
  derivedCommands: Map<number, WebGPUDerivedCommand>;
}

/** A derived command variant for a specific translucency type */
interface WebGPUDerivedCommand {
  type: number;
  blendEnabled: boolean;
  depthWriteEnabled: boolean;
  depthTestEnabled: boolean;
  cullFront: boolean;
  cullBack: boolean;
  colorWriteEnabled: boolean;
}

// Derived command type constants — must match GlobeTranslucencyState
const DerivedCommandType = {
  OPAQUE_FRONT_FACE: 0,
  OPAQUE_BACK_FACE: 1,
  DEPTH_ONLY_FRONT_FACE: 2,
  DEPTH_ONLY_BACK_FACE: 3,
  DEPTH_ONLY_FRONT_AND_BACK_FACE: 4,
  TRANSLUCENT_FRONT_FACE: 5,
  TRANSLUCENT_BACK_FACE: 6,
  TRANSLUCENT_FRONT_FACE_MANUAL_DEPTH_TEST: 7,
  TRANSLUCENT_BACK_FACE_MANUAL_DEPTH_TEST: 8,
} as const;

/**
 * Compute the render state parameters for a given derived command type.
 */
function getDerivedCommandState(type: number): WebGPUDerivedCommand {
  switch (type) {
    case DerivedCommandType.OPAQUE_FRONT_FACE:
      return {
        type,
        blendEnabled: false,
        depthWriteEnabled: true,
        depthTestEnabled: true,
        cullFront: false,
        cullBack: true,
        colorWriteEnabled: true,
      };
    case DerivedCommandType.OPAQUE_BACK_FACE:
      return {
        type,
        blendEnabled: false,
        depthWriteEnabled: true,
        depthTestEnabled: true,
        cullFront: true,
        cullBack: false,
        colorWriteEnabled: true,
      };
    case DerivedCommandType.DEPTH_ONLY_FRONT_FACE:
      return {
        type,
        blendEnabled: false,
        depthWriteEnabled: true,
        depthTestEnabled: true,
        cullFront: false,
        cullBack: true,
        colorWriteEnabled: false,
      };
    case DerivedCommandType.DEPTH_ONLY_BACK_FACE:
      return {
        type,
        blendEnabled: false,
        depthWriteEnabled: true,
        depthTestEnabled: true,
        cullFront: true,
        cullBack: false,
        colorWriteEnabled: false,
      };
    case DerivedCommandType.DEPTH_ONLY_FRONT_AND_BACK_FACE:
      return {
        type,
        blendEnabled: false,
        depthWriteEnabled: true,
        depthTestEnabled: true,
        cullFront: false,
        cullBack: false,
        colorWriteEnabled: false,
      };
    case DerivedCommandType.TRANSLUCENT_FRONT_FACE:
      return {
        type,
        blendEnabled: true,
        depthWriteEnabled: false,
        depthTestEnabled: true,
        cullFront: false,
        cullBack: true,
        colorWriteEnabled: true,
      };
    case DerivedCommandType.TRANSLUCENT_BACK_FACE:
      return {
        type,
        blendEnabled: true,
        depthWriteEnabled: false,
        depthTestEnabled: true,
        cullFront: true,
        cullBack: false,
        colorWriteEnabled: true,
      };
    case DerivedCommandType.TRANSLUCENT_FRONT_FACE_MANUAL_DEPTH_TEST:
      return {
        type,
        blendEnabled: true,
        depthWriteEnabled: false,
        depthTestEnabled: false,
        cullFront: false,
        cullBack: true,
        colorWriteEnabled: true,
      };
    case DerivedCommandType.TRANSLUCENT_BACK_FACE_MANUAL_DEPTH_TEST:
      return {
        type,
        blendEnabled: true,
        depthWriteEnabled: false,
        depthTestEnabled: false,
        cullFront: true,
        cullBack: false,
        colorWriteEnabled: true,
      };
    default:
      return {
        type,
        blendEnabled: false,
        depthWriteEnabled: true,
        depthTestEnabled: true,
        cullFront: false,
        cullBack: true,
        colorWriteEnabled: true,
      };
  }
}

/**
 * Update derived commands for WebGPU globe translucency.
 * Marks the command with translucency state metadata so the WebGPU
 * command executor can select the correct pipeline variant at draw time.
 *
 * @param state - The GlobeTranslucencyState instance
 * @param command - The WebGPU draw command to modify
 * @param frameState - Current frame state
 */
function updateWebGPUGlobeTranslucencyDerivedCommands(
  state: CesiumObjectWithWebGPUCache,
  command: CesiumAnyDrawCommand,
  frameState: CesiumFrameState,
): void {
  if (!state._webgpuCache) {
    state._webgpuCache = {
      initialized: false,
      derivedCommands: new Map(),
    } as GlobeTranslucencyCache;
  }

  const cache = state._webgpuCache as GlobeTranslucencyCache;

  // Build derived command descriptors from the state's update list.
  // GlobeTranslucencyState populates _derivedCommandTypesToUpdate each frame.
  const derivedCommandTypes = state._derivedCommandTypesToUpdate;
  const derivedCommandCount = state._derivedCommandTypesToUpdateLength;

  if (!command._webgpuTranslucencyDerived) {
    command._webgpuTranslucencyDerived = [];
  }

  for (let i = 0; i < derivedCommandCount; i++) {
    const type = derivedCommandTypes[i];

    // Cache the derived command state to avoid re-computing each frame
    let derivedState = cache.derivedCommands.get(type);
    if (!derivedState) {
      derivedState = getDerivedCommandState(type);
      cache.derivedCommands.set(type, derivedState);
    }

    command._webgpuTranslucencyDerived[i] = derivedState;
  }

  command._webgpuTranslucencyDerivedCount = derivedCommandCount;
  command._webgpuDerivedTranslucent = true;

  cache.initialized = true;
}

/**
 * Destroy WebGPU globe translucency resources.
 */
function destroyWebGPUGlobeTranslucencyResources(state: CesiumObjectWithWebGPUCache): void {
  if (state._webgpuCache) {
    (state._webgpuCache as GlobeTranslucencyCache).derivedCommands.clear();
  }
  state._webgpuCache = undefined;
}

export {
  updateWebGPUGlobeTranslucencyDerivedCommands,
  destroyWebGPUGlobeTranslucencyResources,
  DerivedCommandType,
};
export default {
  updateWebGPUGlobeTranslucencyDerivedCommands,
  destroyWebGPUGlobeTranslucencyResources,
  DerivedCommandType,
};
