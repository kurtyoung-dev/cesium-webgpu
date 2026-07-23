/**
 * Side-effect-free demand checks for the WebGPU post-frustum environmental
 * chain. Kept separate from the effect implementations so the scene renderer
 * can make its empty-frustum scheduling decision without loading or executing
 * any effect.
 *
 * @module WebGPUSceneRendererEnvironmentDemand
 */

interface EnvironmentalEffectDemandScene {
  _enableSSR?: boolean;
  _enableNPROutlines?: boolean;
  _enableContactShadows?: boolean;
  _enableWeather?: boolean;
  globe?: {
    defaultCloudCollection?: {
      renderMode?: number;
      volumetric?: { enabled?: boolean };
    };
  };
  _frameState?: {
    atmosphericConditions?: {
      volumetricFog?: { enabled?: boolean };
      effects?: { groundFog?: { enabled?: boolean } };
    };
  };
}

interface EnvironmentalEffectDemandContext {
  readonly hasVolumetricCloudRequest?: boolean;
}

/**
 * Whether the current frame has an environmental consumer that needs the
 * post-frustum canvas chain. This includes both managed and user-published
 * volumetric cloud decks.
 *
 * @param scene - Scene feature flags for the current frame.
 * @param context - Graphics context carrying per-frame cloud demand.
 * @returns `true` when skipping the post-frustum chain would suppress an
 *   enabled effect.
 */
export function hasEnvironmentalEffectDemand(
  scene: unknown,
  context: EnvironmentalEffectDemandContext,
): boolean {
  const demandScene = scene as EnvironmentalEffectDemandScene;
  const atmosphericConditions = demandScene._frameState?.atmosphericConditions;
  const managedClouds = demandScene.globe?.defaultCloudCollection;

  return (
    context.hasVolumetricCloudRequest === true ||
    (managedClouds?.renderMode === 1 &&
      managedClouds.volumetric?.enabled === true) ||
    demandScene._enableSSR === true ||
    demandScene._enableNPROutlines === true ||
    demandScene._enableContactShadows === true ||
    demandScene._enableWeather === true ||
    atmosphericConditions?.volumetricFog?.enabled === true ||
    atmosphericConditions?.effects?.groundFog?.enabled === true
  );
}

/**
 * Empty geometry must not suppress a demanded environmental frame. Conversely,
 * a genuinely empty frame with no consumers retains the existing zero-work
 * fast path.
 *
 * @param numFrustums - Number of geometry/environment command frustums.
 * @param scene - Scene feature flags for the current frame.
 * @param context - Graphics context carrying per-frame cloud demand.
 * @returns Whether the WebGPU canvas/post-frustum chain must run.
 */
export function shouldExecuteWebGPUSceneFrame(
  numFrustums: number,
  scene: unknown,
  context: EnvironmentalEffectDemandContext,
): boolean {
  return numFrustums > 0 || hasEnvironmentalEffectDemand(scene, context);
}
