#ifdef USE_IBL_LIGHTING
vec3 computeIBL(vec3 position, vec3 normal, vec3 lightDirection, vec3 lightColorHdr, czm_modelMaterial material)
{
    #if defined(DIFFUSE_IBL) || defined(SPECULAR_IBL)
        // Environment maps were provided, use them for IBL
        vec3 viewDirection = -normalize(position);
        vec3 iblColor = textureIBL(viewDirection, normal, material);
        return iblColor;
    #endif
    
    return vec3(0.0);
}
#endif

#ifdef USE_CLEARCOAT
vec3 addClearcoatReflection(vec3 baseLayerColor, vec3 position, vec3 lightDirection, vec3 lightColorHdr, czm_modelMaterial material)
{
    vec3 viewDirection = -normalize(position);
    vec3 halfwayDirection = normalize(viewDirection + lightDirection);
    vec3 normal = material.clearcoatNormal;
    float NdotL = clamp(dot(normal, lightDirection), 0.001, 1.0);

    // clearcoatF0 = vec3(pow((ior - 1.0) / (ior + 1.0), 2.0)), but without KHR_materials_ior, ior is a constant 1.5.
    vec3 f0 = vec3(0.04);
    vec3 f90 = vec3(1.0);
    // Note: clearcoat Fresnel computed with dot(n, v) instead of dot(v, h).
    // This is to make it energy conserving with a simple layering function.
    float NdotV = clamp(dot(normal, viewDirection), 0.0, 1.0);
    vec3 F = fresnelSchlick2(f0, f90, NdotV);

    // compute specular reflection from direct lighting
    float roughness = material.clearcoatRoughness;
    float alphaRoughness = roughness * roughness;
    float directStrength = computeDirectSpecularStrength(normal, lightDirection, viewDirection, halfwayDirection, alphaRoughness);
    vec3 directReflection = F * directStrength * NdotL;
    vec3 color = lightColorHdr * directReflection;

    #ifdef SPECULAR_IBL
        // Find the direction in which to sample the environment map
        vec3 reflectMC = normalize(model_iblReferenceFrameMatrix * reflect(-viewDirection, normal));
        vec3 iblColor = computeSpecularIBL(reflectMC, NdotV, f0, roughness);
        color += iblColor * material.occlusion;
    #endif

    float clearcoatFactor = material.clearcoatFactor;
    vec3 clearcoatColor = color * clearcoatFactor;

    // Dim base layer based on transmission loss through clearcoat
    return baseLayerColor * (1.0 - clearcoatFactor * F) + clearcoatColor;
}
#endif

#if defined(LIGHTING_PBR) && defined(HAS_NORMALS)

/**
 * Unpack a single light from the czm_lightsData vec4 array.
 * Layout: 1 vec4 header + 5 vec4s per light, matching LightCollection.pack().
 * The fifth vec4 carries the spot direction on its own 16-byte boundary; this
 * struct has no field for it yet, so it is stepped over rather than read.
 */
czm_lightData czm_unpackLight(int index)
{
    czm_lightData light;
    int base = 1 + index * 5; // skip 1-vec4 header
    vec4 v0 = czm_lightsData[base];
    vec4 v1 = czm_lightsData[base + 1];
    vec4 v2 = czm_lightsData[base + 2];
    vec4 v3 = czm_lightsData[base + 3];
    light.directionOrPosition = v0.xyz;
    light.lightType = v0.w;
    light.color = v1.xyz;
    light.intensity = v1.w;
    light.range = v2.x;
    light.constantAttenuation = v2.y;
    light.linearAttenuation = v2.z;
    light.quadraticAttenuation = v2.w;
    light.innerConeAngle = v3.x;
    light.outerConeAngle = v3.y;
    return light;
}

/**
 * Compute the lighting contribution from a single additional light source.
 * Handles directional, point, and spot lights with attenuation.
 */
vec3 computeAdditionalLightPBR(
    in czm_lightData light,
    in vec3 viewDirection,
    in vec3 normal,
    in vec3 positionEC,
    in czm_modelMaterial material
)
{
    vec3 lightDir;
    float attenuation = 1.0;

    if (light.lightType < 0.5) {
        // Directional light — direction is in eye coordinates
        lightDir = normalize(light.directionOrPosition);
    } else {
        // Point or spot light — position is in eye coordinates
        vec3 toLight = light.directionOrPosition - positionEC;
        float dist = length(toLight);
        lightDir = toLight / max(dist, 0.001);
        attenuation = czm_computeAttenuation(
            dist, light.range,
            light.constantAttenuation,
            light.linearAttenuation,
            light.quadraticAttenuation
        );
        if (light.lightType > 1.5) {
            // Spot light — apply cone factor
            // For spot lights, directionOrPosition is the position;
            // the spot direction must come from a second field or be
            // precomputed. Use negative lightDir as approximation when
            // spot direction is embedded in the data layout.
            attenuation *= czm_computeSpotCone(
                normalize(-light.directionOrPosition),
                -lightDir,
                light.innerConeAngle,
                light.outerConeAngle
            );
        }
    }

    vec3 lightColor = light.color * light.intensity;
    vec3 directLighting = czm_pbrLighting(viewDirection, normal, lightDir, material);
    return lightColor * directLighting * attenuation;
}

vec3 computePbrLighting(in czm_modelMaterial material, in vec3 position)
{
    #ifdef USE_CUSTOM_LIGHT_COLOR
        vec3 lightColorHdr = model_lightColorHdr;
    #else
        vec3 lightColorHdr = czm_lightColorHdr;
    #endif

    vec3 viewDirection = -normalize(position);
    vec3 normal = material.normalEC;
    vec3 lightDirection = normalize(czm_lightDirectionEC);

    // Primary light (sun or user-specified directional light)
    vec3 directLighting = czm_pbrLighting(viewDirection, normal, lightDirection, material);
    vec3 directColor = lightColorHdr * directLighting;

    // Accumulate colors from base layer
    vec3 color = directColor + material.emissive;

    // Additional lights from scene.lights (LightCollection)
    int additionalLightCount = int(czm_lightCount);
    for (int i = 0; i < 8; i++) {
        if (i >= additionalLightCount) {
            break;
        }
        czm_lightData light = czm_unpackLight(i);
        color += computeAdditionalLightPBR(light, viewDirection, normal, position, material);
    }

    #ifdef USE_IBL_LIGHTING
        color += computeIBL(position, normal, lightDirection, lightColorHdr, material);
    #endif

    #ifdef USE_CLEARCOAT
        color = addClearcoatReflection(color, position, lightDirection, lightColorHdr, material);
    #endif

    return color;
}
#endif

/**
 * Compute the material color under the current lighting conditions.
 * All other material properties are passed through so further stages
 * have access to them.
 *
 * @param {czm_modelMaterial} material The material properties from {@MaterialStageFS}
 * @param {ProcessedAttributes} attributes
 */
void lightingStage(inout czm_modelMaterial material, ProcessedAttributes attributes)
{
    #ifdef LIGHTING_PBR
        #ifdef HAS_NORMALS
            vec3 color = computePbrLighting(material, attributes.positionEC);
        #else
            vec3 color = material.diffuse * material.occlusion + material.emissive;
        #endif
        // In HDR mode, the frame buffer is in linear color space. The
        // post-processing stages (see PostProcessStageCollection) will handle
        // tonemapping. However, if HDR is not enabled, we must tonemap else large
        // values may be clamped to 1.0
        #ifndef HDR
            color = czm_pbrNeutralTonemapping(color);
        #endif
    #else // unlit
        vec3 color = material.diffuse;
    #endif

    #ifdef HAS_POINT_CLOUD_COLOR_STYLE
        // The colors resulting from point cloud styles are adjusted differently.
        color = czm_gammaCorrect(color);
    #elif !defined(HDR)
        // If HDR is not enabled, the frame buffer stores sRGB colors rather than
        // linear colors so the linear value must be converted.
        color = czm_linearToSrgb(color);
    #endif

    material.diffuse = color;
}
