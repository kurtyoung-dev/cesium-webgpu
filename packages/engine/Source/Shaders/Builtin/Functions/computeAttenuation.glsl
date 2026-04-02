/**
 * Computes distance attenuation for point and spot lights.
 * Uses the standard inverse-square-law with configurable constant,
 * linear, and quadratic factors. If range > 0, the light is clamped
 * to zero beyond that distance.
 *
 * Matches csm_computeAttenuation() in LightUniforms.wgsl (WebGPU path).
 *
 * @name czm_computeAttenuation
 * @glslFunction
 *
 * @param {float} distance The distance from the light source to the fragment.
 * @param {float} range The maximum range of the light (0 = infinite).
 * @param {float} constantAtt Constant attenuation factor.
 * @param {float} linearAtt Linear attenuation factor.
 * @param {float} quadraticAtt Quadratic attenuation factor.
 * @returns {float} The attenuation factor in [0, 1].
 */
float czm_computeAttenuation(float distance, float range, float constantAtt, float linearAtt, float quadraticAtt)
{
    if (range > 0.0 && distance > range)
    {
        return 0.0;
    }
    return 1.0 / (constantAtt + linearAtt * distance + quadraticAtt * distance * distance);
}
