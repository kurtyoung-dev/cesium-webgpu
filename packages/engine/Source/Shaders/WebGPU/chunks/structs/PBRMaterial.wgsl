/**
 * PBR Material uniform buffer structure
 * Contains metallic-roughness workflow parameters compatible with glTF 2.0
 * 
 * @chunk structs/PBRMaterial
 */
struct PBRMaterial {
    // Base color factor (vec4 for albedo + alpha)
    baseColorFactor: vec4<f32>,

    // PBR parameters
    metallicFactor: f32,
    roughnessFactor: f32,

    // Normal map scale
    normalScale: f32,

    // Occlusion strength
    occlusionStrength: f32,

    // Emissive factor
    emissiveFactor: vec3<f32>,
    _padding: f32,
}
