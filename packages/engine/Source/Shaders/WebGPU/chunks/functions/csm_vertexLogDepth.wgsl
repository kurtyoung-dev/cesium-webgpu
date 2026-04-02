/**
 * Computes log depth in vertex shader. Port of czm_vertexLogDepth.
 * @chunk functions/csm_vertexLogDepth
 */
fn csm_vertexLogDepth(clipPos: vec4<f32>, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
    let w: f32 = clipPos.w;
    if (w > 0.0) {
        return log2(max(1e-6, w + 1.0)) * oneOverLog2FarDepthFromNearPlusOne;
    }
    return 0.0;
}
