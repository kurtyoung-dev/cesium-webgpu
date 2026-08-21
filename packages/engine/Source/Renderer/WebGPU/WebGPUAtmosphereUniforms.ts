/**
 * Shared WebGPU atmosphere-uniform resolution.
 *
 * Consumers reading `frameState.atmosphere` supply renderer-specific fallback
 * coefficients. This preserves each renderer's tuned defaults while routing
 * an explicitly configured `scene.atmosphere.*` field through one resolver.
 *
 * The visible sky shell has a different parity boundary. Its scattering
 * coefficients come from the `SkyAtmosphere` instance, matching WebGL's
 * `Scene/SkyAtmosphere.js`; `scene.atmosphere.*` supplies the ground and model
 * IBL terms instead. The sky's dynamic-lighting mode is also resolved by
 * `Scene.updateEnvironment`: globe scenes derive it from the globe flags,
 * while globeless scenes use `scene.atmosphere.dynamicLighting`. The resolved
 * value is stored on `SkyAtmosphere`, so sky consumers use
 * {@link resolveSkyDynamicLighting}. Model IBL consumers use
 * {@link resolveDynamicLighting} because their WebGL counterpart reads
 * `scene.atmosphere.dynamicLighting` directly.
 *
 * This resolver is CPU-only and changes neither bind-group layouts nor WGSL.
 * Renderer defaults remain byte-identical when no atmosphere field is set.
 *
 * @module WebGPUAtmosphereUniforms
 */

/**
 * A minimal 3-component vector shape (Cartesian3-compatible) carrying a
 * per-channel scattering coefficient. Both
 * `scene.atmosphere.rayleighCoefficient` (a real `Cartesian3`) and a
 * renderer's plain `{ x, y, z }` default literal satisfy this.
 */
export interface AtmosphereCoefficient {
  x: number;
  y: number;
  z: number;
}

/**
 * Renderer-supplied fallback set. Each consumer passes its own tuned
 * `DEFAULT_*` constants so resolving through this module remains
 * byte-identical when `scene.atmosphere` omits a field.
 */
export interface AtmosphereScatteringDefaults {
  rayleighCoefficient: AtmosphereCoefficient;
  mieCoefficient: AtmosphereCoefficient;
  rayleighScaleHeight: number;
  mieScaleHeight: number;
  mieAnisotropy: number;
  lightIntensity: number;
}

/**
 * Fully-resolved scattering terms plus the `dynamicLighting` enum, ready to
 * pack into a consumer's uniform layout.
 */
export interface ResolvedAtmosphereScattering {
  rayleighCoefficient: AtmosphereCoefficient;
  mieCoefficient: AtmosphereCoefficient;
  rayleighScaleHeight: number;
  mieScaleHeight: number;
  mieAnisotropy: number;
  lightIntensity: number;
  dynamicLighting: number;
}

/**
 * Resolves the dynamic-atmosphere-lighting enum from `scene.atmosphere`.
 *
 * `0` (`DynamicAtmosphereLightingType.NONE`) is the default when
 * `frameState.atmosphere` or the field is absent. Centralizing the fallback
 * keeps all direct consumers consistent.
 *
 * @param frameState the current frame state
 * @returns the `DynamicAtmosphereLightingType` enum value (0/1/2/3)
 */
export function resolveDynamicLighting(frameState: CesiumFrameState): number {
  return frameState.atmosphere?.dynamicLighting ?? 0;
}

/**
 * True when the given `DynamicAtmosphereLightingType` selects an explicit
 * scene light source &mdash; `SCENE_LIGHT` (1) or `SUNLIGHT` (2).
 *
 * `LEGACY_OVERHEAD` (3) is a compatibility mode whose direction varies per
 * texel or fragment, so it cannot bake a table against one scene-wide light
 * direction. This predicate therefore treats it like `NONE` while keeping
 * `SCENE_LIGHT` and `SUNLIGHT` as the explicit directional modes.
 *
 * @param dynamicLighting the `DynamicAtmosphereLightingType` enum value
 * @returns whether the mode resolves to one scene-wide light direction
 */
export function usesSceneLightDirection(dynamicLighting: number): boolean {
  return dynamicLighting === 1 || dynamicLighting === 2;
}

/**
 * The shape a sky consumer needs from the `SkyAtmosphere` instance: the
 * dynamic-lighting enum `Scene.updateEnvironment` already resolved for this
 * frame through `SkyAtmosphere.setDynamicLighting`.
 */
export interface SkyDynamicLightingSource {
  dynamicLighting?: number;
}

/**
 * Resolves the dynamic-atmosphere-lighting enum for the sky shell.
 *
 * `Scene.updateEnvironment` resolves this every frame and stores it on the
 * `SkyAtmosphere` instance:
 *
 * ```js
 * skyAtmosphere.setDynamicLighting(
 *   DynamicAtmosphereLightingType.fromGlobeFlags(globe),   // globe present
 * );
 * skyAtmosphere.setDynamicLighting(atmosphere.dynamicLighting); // no globe
 * ```
 *
 * WebGL's `u_radiiAndDynamicAtmosphereColor.z` reads that stored value, so
 * WebGPU must do the same. Re-resolving from `frameState.atmosphere` in a globe
 * scene can produce `NONE` while the instance contains `SCENE_LIGHT`. That
 * makes the WGSL shell's per-fragment `nightAlpha` a constant 1.0 and the
 * ground-level shell fully opaque, hiding the sky-box cube map and star-catalog
 * command rendered behind the atmosphere. The moon and sun render after the
 * atmosphere and are unaffected by that ordering.
 *
 * The `frameState` fallback covers a caller that passes no instance at all
 * when packing sky uniforms. It does not override an instance that has not
 * reached `updateEnvironment`: the `SkyAtmosphere` constructor initializes the
 * slot to `0`, so that instance reports `NONE` and takes the instance path.
 *
 * The resolved value controls both the sky's day/night alpha and its light
 * direction. WGSL uses `u.sunDirectionWC` for every mode except the explicit
 * `LEGACY_OVERHEAD` (3) compatibility mode. The alpha gate remains keyed to
 * `dynamicLighting != 0`.
 *
 * @param skyAtmosphere the `SkyAtmosphere` instance being packed, if any
 * @param frameState the current frame state
 * @returns the `DynamicAtmosphereLightingType` enum value (0/1/2/3)
 */
export function resolveSkyDynamicLighting(
  skyAtmosphere: SkyDynamicLightingSource | undefined,
  frameState: CesiumFrameState,
): number {
  const resolved = skyAtmosphere?.dynamicLighting;
  return typeof resolved === "number" && isFinite(resolved)
    ? resolved
    : resolveDynamicLighting(frameState);
}

/**
 * Resolves the full scattering-coefficient set (+ `dynamicLighting`) from
 * `scene.atmosphere`, falling back to the caller-supplied `defaults` for any
 * unset field.
 *
 * The resolved coefficient objects are returned by reference: the configured
 * `scene.atmosphere` `Cartesian3`, or the caller's default literal otherwise.
 * This avoids allocation and preserves the selected object's identity.
 *
 * @param frameState the current frame state
 * @param defaults the consumer's renderer-specific fallback set
 * @returns the resolved scattering terms + dynamic-lighting enum
 */
export function resolveAtmosphereScattering(
  frameState: CesiumFrameState,
  defaults: AtmosphereScatteringDefaults,
): ResolvedAtmosphereScattering {
  const atmosphere = frameState.atmosphere;
  return {
    rayleighCoefficient:
      atmosphere?.rayleighCoefficient ?? defaults.rayleighCoefficient,
    mieCoefficient: atmosphere?.mieCoefficient ?? defaults.mieCoefficient,
    rayleighScaleHeight:
      atmosphere?.rayleighScaleHeight ?? defaults.rayleighScaleHeight,
    mieScaleHeight: atmosphere?.mieScaleHeight ?? defaults.mieScaleHeight,
    mieAnisotropy: atmosphere?.mieAnisotropy ?? defaults.mieAnisotropy,
    lightIntensity: atmosphere?.lightIntensity ?? defaults.lightIntensity,
    dynamicLighting: resolveDynamicLighting(frameState),
  };
}
