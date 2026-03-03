/**
 * Camera uniform buffer structure
 * Contains view/projection matrices, camera position, and RTE (Relative-To-Eye)
 * uniforms for emulated 64-bit precision at planetary scale.
 *
 * RTE fields:
 *   encodedCameraPositionMCHigh/Low — Camera position in model coordinates,
 *     split into two 32-bit floats via EncodedCartesian3. Used by
 *     csm_translateRelativeToEye() to compute eye-relative positions.
 *   modelViewRelativeToEye — The modelView matrix with translation column zeroed.
 *     Used with RTE positions for view-space lighting calculations.
 *   modelViewProjectionRelativeToEye — projection × modelViewRelativeToEye.
 *     Used with RTE positions for clip-space output.
 *
 * @chunk structs/CameraUniforms
 */
struct CameraUniforms {
    // Standard matrices
    viewMatrix: mat4x4<f32>,                       // offset   0, size 64
    projectionMatrix: mat4x4<f32>,                 // offset  64, size 64
    viewProjectionMatrix: mat4x4<f32>,             // offset 128, size 64

    // Camera position (world space)
    cameraPosition: vec3<f32>,                     // offset 192, size 12
    _padding0: f32,                                // offset 204, size  4

    // RTE: Encoded camera position in model coordinates (high/low split)
    encodedCameraPositionMCHigh: vec3<f32>,         // offset 208, size 12
    _padding1: f32,                                // offset 220, size  4
    encodedCameraPositionMCLow: vec3<f32>,          // offset 224, size 12
    _padding2: f32,                                // offset 236, size  4

    // RTE: Matrices with translation zeroed (for use with eye-relative positions)
    modelViewRelativeToEye: mat4x4<f32>,           // offset 240, size 64
    modelViewProjectionRelativeToEye: mat4x4<f32>, // offset 304, size 64
}
// Total size: 368 bytes
