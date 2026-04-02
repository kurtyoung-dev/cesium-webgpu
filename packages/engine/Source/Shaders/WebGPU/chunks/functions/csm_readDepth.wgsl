/**
 * Reads depth from a depth texture and converts from log depth.
 * Port of czm_readDepth.
 * @chunk functions/csm_readDepth
 */
fn csm_readDepth(depthTexture: texture_2d<f32>, depthSampler: sampler, texCoords: vec2<f32>) -> f32 {
    let rawDepth: f32 = textureSample(depthTexture, depthSampler, texCoords).r;
    return csm_reverseLogDepth(rawDepth);
}
