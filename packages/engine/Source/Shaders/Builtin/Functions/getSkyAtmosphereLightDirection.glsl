/**
 * Select the light direction for the NATURAL SKY atmosphere.
 *
 * This is the sky-shell counterpart of {@link czm_getDynamicAtmosphereLightDirection}.
 * The two differ in exactly one arm, and that arm is the C12-31 fix:
 *
 *   NONE (0, the default)      this function returns the astronomical Sun;
 *                              the legacy function returns `positionWC`.
 *   SCENE_LIGHT (1)            identical — `czm_lightDirectionWC`.
 *   SUNLIGHT (2)               identical — `czm_sunDirectionWC`.
 *   LEGACY_OVERHEAD (3)        identical — `positionWC` ("lit from directly
 *                              above"), the named compatibility mode that
 *                              reproduces the historical NONE appearance.
 *
 * WHY THE NONE ARM MOVED (C12-31, root cause recorded 2026-07-28):
 * `Globe.enableLighting` defaults to `false`, so `Scene.updateEnvironment`
 * resolves the sky's enum through `DynamicAtmosphereLightingType.fromGlobeFlags`
 * to NONE in the default viewer. The legacy NONE arm then substitutes
 * `normalize(positionWC)` — a DIFFERENT "sun directly overhead" at every sample
 * — for the one astronomical Sun. `czm_computeAtmosphereColor` takes
 * `cosAngle = dot(cameraToPositionWCDirection, lightDirection)`, which under
 * that substitution is ≈1 for every ray a ground observer looks along, so the
 * Mie phase sits on its forward peak everywhere. At the default anisotropy
 * `g = 0.9` that peak is 4869.9× the 90° value, producing a broad white
 * aureole locked to the view/zenith rather than to the Sun — visible even when
 * the Sun is elsewhere in the sky or below the horizon.
 *
 * Terrain lighting and natural sky lighting are separate concerns: turning
 * `globe.enableLighting` off must not silently replace the sky's Sun. Keeping
 * the ENUM VALUE at NONE (rather than remapping it to SUNLIGHT) is deliberate:
 * NONE names "natural sky, no scene light source", and the way back to the
 * historical look is LEGACY_OVERHEAD rather than a second enum.
 *
 * The day/night alpha ramp in `SkyAtmosphereCommon.glsl` and its WGSL twin read
 * this same returned direction instead of testing the enum, so a shell coloured
 * by the astronomical Sun is also opened and closed by it. The ramp is inert in
 * LEGACY_OVERHEAD by construction — that arm's light direction IS
 * `normalize(positionWC)`, so the ramp's own dot is 1.0 — which is how the
 * compatibility mode keeps its permanent-day opacity. While the enum test was
 * still in place, the natural-sky mode was coloured by the real Sun but pinned
 * to permanent-day OPACITY, so a ground camera's shell stayed opaque through
 * the night and alpha-blended the star cubemap and the catalogue sprites, both
 * drawn before the atmosphere, down below one 8-bit code.
 *
 * WGSL twin: the `isLegacyOverhead` block in
 * `Shaders/WebGPU/Environment/SkyAtmosphere.wgsl`.
 *
 * @name czm_getSkyAtmosphereLightDirection
 * @glslfunction
 * @see DynamicAtmosphereLightingType.js
 * @see czm_getDynamicAtmosphereLightDirection
 *
 * @param {vec3} positionWC the position of the vertex/fragment in world coordinates. This is normalized and returned only in the explicit LEGACY_OVERHEAD compatibility mode.
 * @param {float} lightEnum The enum value for selecting between light sources.
 * @return {vec3} The normalized light direction vector.
 */
vec3 czm_getSkyAtmosphereLightDirection(vec3 positionWC, float lightEnum) {
    const float SCENE_LIGHT = 1.0;
    const float LEGACY_OVERHEAD = 3.0;

    // Branch-free selection, same shape as the legacy builtin. Every enum
    // other than SCENE_LIGHT and LEGACY_OVERHEAD — which is NONE and SUNLIGHT
    // today, and any future natural-sky mode — is lit by the astronomical Sun.
    float sceneLightWeight = float(lightEnum == SCENE_LIGHT);
    float legacyOverheadWeight = float(lightEnum == LEGACY_OVERHEAD);
    float sunWeight = 1.0 - sceneLightWeight - legacyOverheadWeight;

    vec3 lightDirection =
        czm_sunDirectionWC * sunWeight +
        czm_lightDirectionWC * sceneLightWeight +
        positionWC * legacyOverheadWeight;
    return normalize(lightDirection);
}
