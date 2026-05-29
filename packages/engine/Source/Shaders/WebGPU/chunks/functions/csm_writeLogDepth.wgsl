/**
 * Logarithmic-depth fragment-stage write. Port of czm_writeLogDepth
 * (writeLogDepth.glsl).
 *
 * CANONICAL CONTRACT (Slice 0 of the renderer-wide log-depth epic — keep this
 * byte-compatible with the inline copy in WGSLBuiltins.ts). This file defines
 * ONLY csm_writeLogDepth; csm_vertexLogDepth lives in its own chunk
 * (functions/csm_vertexLogDepth). They were previously bundled here with a
 * COLLIDING 1-arg csm_vertexLogDepth — that duplicate is removed.
 *
 * WebGPU uses a 0..1 NDC depth range. Given the interpolated linear
 * `depthFromNearPlusOne` from csm_vertexLogDepth, the final depth is:
 *   fragDepth = log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne
 * matching `gl_FragDepth = log2(depth) * czm_oneOverLog2FarDepthFromNearPlusOne`.
 *
 * Assign the result to a struct field declared `@builtin(frag_depth)`. To match
 * czm_writeLogDepth's near/far culling, the caller's fragment body should
 * `discard` when `depthFromNearPlusOne <= 0.9999999` or beyond the far plane
 * (WGSL `discard` must appear in the caller, not in this pure value function).
 *
 * @chunk functions/csm_writeLogDepth
 */
fn csm_writeLogDepth(depthFromNearPlusOne: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
    return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne;
}
