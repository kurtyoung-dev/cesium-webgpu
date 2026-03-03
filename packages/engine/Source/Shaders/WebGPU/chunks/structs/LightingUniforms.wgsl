/**
 * Lighting uniform buffer structure for PBR rendering
 * Contains directional light and IBL parameters
 * 
 * @chunk structs/LightingUniforms
 */
struct LightingUniforms {
    // Directional light
    lightDirection: vec3<f32>,
    _padding1: f32,
    lightColor: vec3<f32>,
    lightIntensity: f32,

    // Image-based lighting
    iblIntensity: f32,
    _padding2: vec3<f32>,
}
