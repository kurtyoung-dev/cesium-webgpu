/**
 * Sample a log-depth texture and reverse to hyperbolic window-space NDC z.
 * Port of czm_readDepth.
 *
 * CANONICAL CONTRACT (Slice 0 of the renderer-wide log-depth epic). Takes the
 * frustum near/far so it can call the reconciled 3-arg csm_reverseLogDepth
 * (the previous 1-arg call did not compile). Imports functions/csm_reverseLogDepth.
 *
 * @chunk functions/csm_readDepth
 */
fn csm_readDepth(
    depthTexture: texture_2d<f32>,
    depthSampler: sampler,
    texCoords: vec2<f32>,
    near: f32,
    far: f32,
) -> f32 {
    let rawDepth: f32 = textureSample(depthTexture, depthSampler, texCoords).r;
    return csm_reverseLogDepth(rawDepth, near, far);
}
