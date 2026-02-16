/**
 * Camera uniform buffer structure
 * Contains view/projection matrices and camera position
 * 
 * @chunk structs/CameraUniforms
 */
struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    viewProjectionMatrix: mat4x4<f32>,
    cameraPosition: vec3<f32>,
    _padding: f32,
}
