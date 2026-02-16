/**
 * Model uniform buffer structure
 * Contains model and normal matrices for transforming geometry
 * 
 * @chunk structs/ModelUniforms
 */
struct ModelUniforms {
    modelMatrix: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
}
