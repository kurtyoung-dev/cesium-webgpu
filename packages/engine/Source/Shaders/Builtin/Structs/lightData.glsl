/**
 * Light data structure for multi-light rendering.
 * Matches the layout of LightCollection.pack() in Light.ts and
 * the LightData struct in LightUniforms.wgsl (WebGPU path).
 *
 * @name czm_lightData
 * @glslStruct
 *
 * @see Light
 * @see LightCollection
 */
struct czm_lightData
{
    vec3 directionOrPosition;
    float lightType;        // 0=directional, 1=point, 2=spot
    vec3 color;
    float intensity;
    float range;
    float constantAttenuation;
    float linearAttenuation;
    float quadraticAttenuation;
    float innerConeAngle;
    float outerConeAngle;
    vec2 _padding;
};
