/**
 * Select which direction vector to use for dynamic atmosphere lighting based on an enum value
 *
 * @name czm_getDynamicAtmosphereLightDirection
 * @glslfunction
 * @see DynamicAtmosphereLightingType.js
 *
 * The SKY SHELL does not call this function any more — it calls
 * {@link czm_getSkyAtmosphereLightDirection}, whose NONE arm is the astronomical
 * sun (C12-31). This function keeps the historical NONE behaviour for the
 * consumers that still depend on it (the model ground-atmosphere/fog stage and
 * the dynamic environment map's radiance bake), each of which owns its own
 * migration. Both functions agree on SCENE_LIGHT, SUNLIGHT and LEGACY_OVERHEAD.
 *
 * @param {vec3} positionWC the position of the vertex/fragment in world coordinates. This is normalized and returned when dynamic lighting is turned off.
 * @param {float} lightEnum The enum value for selecting between light sources.
 * @return {vec3} The normalized light direction vector. Depending on the enum value, it is either positionWC, czm_lightDirectionWC or czm_sunDirectionWC
 */
vec3 czm_getDynamicAtmosphereLightDirection(vec3 positionWC, float lightEnum) {
    const float NONE = 0.0;
    const float SCENE_LIGHT = 1.0;
    const float SUNLIGHT = 2.0;
    // C12-31: the explicit legacy-overhead compatibility mode selects the same
    // direction NONE does here. Without this arm every weight would be zero for
    // the new enum value and normalize() would return NaN.
    const float LEGACY_OVERHEAD = 3.0;

    vec3 lightDirection =
        positionWC * float(lightEnum == NONE) +
        czm_lightDirectionWC * float(lightEnum == SCENE_LIGHT) +
        czm_sunDirectionWC * float(lightEnum == SUNLIGHT) +
        positionWC * float(lightEnum == LEGACY_OVERHEAD);
    return normalize(lightDirection);
}
