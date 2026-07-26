/**
 * WebGPU shared atmosphere-uniform resolver (DP-H47, Campaign-7).
 *
 * Historically every WebGPU atmosphere consumer (SkyAtmosphere, the model
 * DynamicEnvironmentMap sky fill, procedural clouds, the globe ground
 * atmosphere) hand-rolled its own pull from `frameState.atmosphere` with its
 * own `DEFAULT_*` fallback constants. Because those hand-rolls read different
 * subsets of `scene.atmosphere.*`, a user-set field could land in one
 * renderer's packing and be silently defaulted in another — the WebGPU-internal
 * inconsistency tracked as DP-H47.
 *
 * This module is the single **parameterized-pull** seam recommended in
 * `migration_doc/DEFERRED_WORK.md` (DP-H47, arch step 1): each consumer keeps
 * its own historically-tuned fallback set (so migrating onto the resolver is
 * byte-identical when `scene.atmosphere` leaves a field unset), while a
 * user-set `scene.atmosphere.*` now resolves through ONE code path for every
 * consumer that reads `frameState.atmosphere`.
 *
 * IMPORTANT — SKY parity boundary (DEFERRED_WORK DP-H47, Q24R 2026-07-04):
 * the visible SkyAtmosphere scattering coefficients are driven by the
 * `SkyAtmosphere` INSTANCE properties (`atmosphereRayleighCoefficient`, …),
 * NOT by `scene.atmosphere.*` — this MIRRORS WebGL (`Scene/SkyAtmosphere.js`
 * binds `u_atmosphereRayleighCoefficient` from the instance; `czm_atmosphere*`
 * drives only the ground + model-IBL sky fill). Routing `scene.atmosphere.*`
 * scattering into the sky would DIVERGE from WebGL, so the sky consumer uses
 * this resolver ONLY for `dynamicLighting` (the one `scene.atmosphere.*` field
 * WebGL applies to the sky, via `SkyAtmosphere.setDynamicLighting`). Its
 * scattering coefficients stay on the instance.
 *
 * C12-29 S6 / obs-1 CORRECTION (2026-07-25): the sentence above was only half
 * true, and the half that was wrong produced a real divergence. WebGL does not
 * hand `scene.atmosphere.dynamicLighting` to the sky when a globe exists — it
 * hands `DynamicAtmosphereLightingType.fromGlobeFlags(globe)`
 * (`Scene.js` `updateEnvironment`), i.e. the LEGACY globe flags
 * (`enableLighting && dynamicAtmosphereLighting`, with
 * `dynamicAtmosphereLightingFromSun` selecting SUNLIGHT). `scene.atmosphere.
 * dynamicLighting` reaches the sky only on the globe-less branch. The value
 * `SkyAtmosphere.setDynamicLighting` stores is therefore the ONE resolved
 * answer, and a WebGPU sky consumer must read THAT, not re-resolve from
 * `frameState.atmosphere`. Use {@link resolveSkyDynamicLighting} for the sky;
 * {@link resolveDynamicLighting} remains correct for the model IBL fill, whose
 * WebGL twin (`DynamicEnvironmentMapManager`) genuinely reads
 * `scene.atmosphere.dynamicLighting` on both backends.
 *
 * CPU-only: this resolver changes no bind-group layout and no WGSL. It is
 * byte-identical at default `scene.atmosphere` settings.
 *
 * @module WebGPUAtmosphereUniforms
 */

/**
 * A minimal 3-component vector shape (Cartesian3-compatible) carrying a
 * per-channel scattering coefficient. Both `scene.atmosphere.rayleighCoefficient`
 * (a real `Cartesian3`) and a renderer's plain `{ x, y, z }` default literal
 * satisfy this.
 */
export interface AtmosphereCoefficient {
  x: number;
  y: number;
  z: number;
}

/**
 * Renderer-supplied fallback set. Each consumer passes its own historically
 * tuned `DEFAULT_*` constants so that resolving through this module produces
 * byte-identical output when `scene.atmosphere` omits a field.
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
 * `frameState.atmosphere` or the field is absent — the same fallback every
 * consumer used inline. Shared so the sky and the model IBL fill resolve it
 * identically.
 *
 * @param frameState the current frame state
 * @returns the `DynamicAtmosphereLightingType` enum value (0/1/2)
 */
export function resolveDynamicLighting(frameState: CesiumFrameState): number {
  return frameState.atmosphere?.dynamicLighting ?? 0;
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
 * Resolves the dynamic-atmosphere-lighting enum **for the sky shell**.
 *
 * C12-29 S6 / obs-1. `Scene.updateEnvironment` resolves this every frame and
 * stores it on the `SkyAtmosphere` instance:
 *
 * ```js
 * skyAtmosphere.setDynamicLighting(
 *   DynamicAtmosphereLightingType.fromGlobeFlags(globe),   // globe present
 * );
 * skyAtmosphere.setDynamicLighting(atmosphere.dynamicLighting); // no globe
 * ```
 *
 * WebGL's `u_radiiAndDynamicAtmosphereColor.z` reads exactly that stored
 * value, so WebGPU must too. Re-resolving from `frameState.atmosphere` gave
 * `NONE` on every globe scene with `globe.enableLighting = true` — where WebGL
 * gives `SCENE_LIGHT` — which collapses the WGSL shell's per-fragment
 * `nightAlpha` to a constant 1.0 and makes the ground-level shell fully
 * opaque. What that hid, precisely: the **skyBox cubemap** and the returned
 * **star-catalogue command**, which are the environment draws `SceneRenderer`
 * places before (and therefore visually behind) the binned atmosphere. The
 * moon and sun execute AFTER the atmosphere — the moon by append and the sun
 * because it is binned behind it.
 *
 * The `frameState` fallback covers a caller that passes no instance at all
 * (tooling, or a future consumer packing sky uniforms without a
 * `SkyAtmosphere`). It does NOT cover "an instance that never reached
 * `updateEnvironment`": `SkyAtmosphere`'s constructor initialises the slot to
 * `0`, so such an instance reports NONE and takes the instance path.
 *
 * @param skyAtmosphere the `SkyAtmosphere` instance being packed, if any
 * @param frameState the current frame state
 * @returns the `DynamicAtmosphereLightingType` enum value (0/1/2)
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
 * The resolved coefficient objects are returned by reference (the
 * `scene.atmosphere` `Cartesian3` when set, otherwise the caller's default
 * literal) — no allocation, matching the pre-resolver inline `?? DEFAULT`
 * reads exactly.
 *
 * @param frameState the current frame state
 * @param defaults the consumer's historically-tuned fallback set
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
