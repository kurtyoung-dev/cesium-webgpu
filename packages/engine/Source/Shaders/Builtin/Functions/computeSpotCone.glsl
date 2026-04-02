/**
 * Computes the spot light cone falloff factor.
 * Returns 1.0 inside the inner cone, smoothly fades to 0.0 at the outer cone edge.
 *
 * Matches csm_computeSpotCone() in LightUniforms.wgsl (WebGPU path).
 *
 * @name czm_computeSpotCone
 * @glslFunction
 *
 * @param {vec3} lightDirection The normalized direction the spot light is pointing.
 * @param {vec3} toFragment The normalized direction from the light to the fragment.
 * @param {float} innerConeAngle The inner cone half-angle in radians (full intensity).
 * @param {float} outerConeAngle The outer cone half-angle in radians (zero intensity).
 * @returns {float} The spotlight cone factor in [0, 1].
 */
float czm_computeSpotCone(vec3 lightDirection, vec3 toFragment, float innerConeAngle, float outerConeAngle)
{
    float cosOuter = cos(outerConeAngle);
    float cosInner = cos(innerConeAngle);
    float cosAngle = dot(lightDirection, toFragment);
    return clamp((cosAngle - cosOuter) / max(cosInner - cosOuter, 0.001), 0.0, 1.0);
}
