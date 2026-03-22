/**
 * Multi-light uniform buffer structure.
 * Supports up to 8 simultaneous lights of any type (directional, point, spot).
 * Addresses upstream issue #8518 — previously only one directional sun light.
 *
 * Memory layout: 528 bytes total (4 header + 8 × 64 bytes)
 * Packed by LightCollection.pack() on the JS side.
 *
 * @chunk structs/LightUniforms
 */

// Light type constants (match LightType enum in Light.ts)
const LIGHT_TYPE_DIRECTIONAL: f32 = 0.0;
const LIGHT_TYPE_POINT: f32 = 1.0;
const LIGHT_TYPE_SPOT: f32 = 2.0;

// Maximum number of lights (must match LightCollection.MAX_LIGHTS)
const MAX_LIGHTS: u32 = 8u;

/**
 * Per-light data. Each light occupies 64 bytes (16 floats).
 *
 * For directional lights: directionOrPosition = light direction
 * For point/spot lights:  directionOrPosition = world-space position
 */
struct LightData {
    // vec4: direction/position.xyz + lightType
    directionOrPosition: vec3<f32>,
    lightType: f32,

    // vec4: color.rgb + intensity
    color: vec3<f32>,
    intensity: f32,

    // vec4: range + attenuation factors
    range: f32,
    constantAttenuation: f32,
    linearAttenuation: f32,
    quadraticAttenuation: f32,

    // vec4: spot cone angles + padding
    innerConeAngle: f32,
    outerConeAngle: f32,
    _padding0: f32,
    _padding1: f32,
}

/**
 * Light uniform buffer.
 * Header: lightCount + padding.
 * Body: array of MAX_LIGHTS LightData structs.
 *
 * Usage in shaders:
 * ```wgsl
 * @group(G) @binding(B) var<uniform> lights: LightUniforms;
 *
 * for (var i = 0u; i < u32(lights.lightCount); i++) {
 *     let light = lights.data[i];
 *     if (light.lightType == LIGHT_TYPE_DIRECTIONAL) {
 *         // Directional light: light.directionOrPosition is direction
 *     } else if (light.lightType == LIGHT_TYPE_POINT) {
 *         // Point light: light.directionOrPosition is position
 *     }
 * }
 * ```
 */
struct LightUniforms {
    lightCount: f32,
    _headerPad0: f32,
    _headerPad1: f32,
    _headerPad2: f32,
    data: array<LightData, 8>,
}

/**
 * Legacy single-light struct for backward compatibility.
 * Used by existing shaders that haven't been updated to multi-light.
 * Maps to the first light in a LightUniforms buffer.
 */
struct SingleLightUniforms {
    // Directional light
    lightDirection: vec3<f32>,
    _padding1: f32,
    lightColor: vec3<f32>,
    lightIntensity: f32,

    // Material properties
    ambientColor: vec3<f32>,
    _padding2: f32,
    diffuseColor: vec3<f32>,
    _padding3: f32,
    specularColor: vec3<f32>,
    shininess: f32,
}

/**
 * Compute attenuation for a point/spot light.
 * Uses the classic constant-linear-quadratic model.
 *
 * @param distance - Distance from the light to the fragment
 * @param light - The light data
 * @returns Attenuation factor [0, 1]
 */
fn csm_computeAttenuation(distance: f32, light: LightData) -> f32 {
    // Range cutoff
    if (light.range > 0.0 && distance > light.range) {
        return 0.0;
    }

    let attenuation = 1.0 / (
        light.constantAttenuation +
        light.linearAttenuation * distance +
        light.quadraticAttenuation * distance * distance
    );

    // Smooth range falloff
    if (light.range > 0.0) {
        let rangeFactor = 1.0 - pow(distance / light.range, 4.0);
        return attenuation * max(rangeFactor, 0.0);
    }

    return attenuation;
}

/**
 * Compute spot light cone falloff.
 *
 * @param lightToFrag - Direction from light to fragment (normalized)
 * @param lightDir - Light's forward direction (normalized)
 * @param light - The light data
 * @returns Cone factor [0, 1]
 */
fn csm_computeSpotCone(lightToFrag: vec3<f32>, lightDir: vec3<f32>, light: LightData) -> f32 {
    let cosAngle = dot(lightToFrag, lightDir);
    let cosOuter = cos(light.outerConeAngle);
    let cosInner = cos(light.innerConeAngle);
    return clamp((cosAngle - cosOuter) / max(cosInner - cosOuter, 0.0001), 0.0, 1.0);
}
