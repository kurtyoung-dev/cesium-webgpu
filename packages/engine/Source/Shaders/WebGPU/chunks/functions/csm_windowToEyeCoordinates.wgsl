/**
 * Transforms window coordinates back to eye coordinates.
 * Port of czm_windowToEyeCoordinates.
 * @chunk functions/csm_windowToEyeCoordinates
 */
fn csm_windowToEyeCoordinates(
    windowPos: vec2<f32>,
    depth: f32,
    inverseProjection: mat4x4<f32>,
    viewport: vec4<f32>
) -> vec4<f32> {
    // Convert window to NDC
    let ndcX: f32 = (windowPos.x - viewport.x) / viewport.z * 2.0 - 1.0;
    let ndcY: f32 = (windowPos.y - viewport.y) / viewport.w * 2.0 - 1.0;
    // WebGPU depth is [0,1]
    let ndcZ: f32 = depth;
    let clipPos: vec4<f32> = vec4<f32>(ndcX, ndcY, ndcZ, 1.0);
    let eyePos: vec4<f32> = inverseProjection * clipPos;
    return eyePos / eyePos.w;
}
