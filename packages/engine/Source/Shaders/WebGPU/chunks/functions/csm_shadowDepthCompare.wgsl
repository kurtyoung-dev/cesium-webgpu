/**
 * Compare a depth value against a shadow map depth.
 * Uses hardware comparison sampling when available.
 *
 * @chunk functions/csm_shadowDepthCompare
 */
fn csm_shadowDepthCompare(shadowDepth: f32, depth: f32) -> f32 {
    return select(0.0, 1.0, depth <= shadowDepth);
}

fn csm_shadowDepthCompare_tex(shadowMap: texture_depth_2d, shadowSampler: sampler_comparison, uv: vec2<f32>, depth: f32) -> f32 {
    return textureSampleCompare(shadowMap, shadowSampler, uv, depth);
}
