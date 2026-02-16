/**
 * Light uniform buffer structure
 * Contains directional light parameters and material properties for Phong lighting
 * 
 * @chunk structs/LightUniforms
 */
struct LightUniforms {
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
