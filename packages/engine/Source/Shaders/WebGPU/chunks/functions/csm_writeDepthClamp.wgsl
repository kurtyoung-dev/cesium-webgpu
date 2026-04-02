/**
 * Fragment shader depth clamp write. Port of czm_writeDepthClamp.
 * In WebGPU, frag_depth output handles depth clamping.
 * @chunk functions/csm_writeDepthClamp
 */
fn csm_writeDepthClamp(windowZ: f32) -> f32 {
    return clamp(windowZ, 0.0, 1.0);
}
