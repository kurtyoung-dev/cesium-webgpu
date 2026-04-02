/**
 * Computes log2 depth from linear depth. Port of czm_log2Depth.
 * @chunk functions/csm_log2Depth
 */
fn csm_log2Depth(depth: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
    return log2(depth + 1.0) * oneOverLog2FarDepthFromNearPlusOne;
}
