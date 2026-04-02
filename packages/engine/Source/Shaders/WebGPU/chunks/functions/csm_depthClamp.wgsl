/**
 * Emulates GL_DEPTH_CLAMP. Adjusts vertex position depth to clamp to near/far.
 * Port of czm_depthClamp.
 * @chunk functions/csm_depthClamp
 */
fn csm_depthClamp(clipPos: vec4<f32>) -> vec4<f32> {
    // In WebGPU (0..1 depth range), clamp the NDC z to valid range
    var result: vec4<f32> = clipPos;
    result.z = clamp(result.z, 0.0, result.w);
    return result;
}
