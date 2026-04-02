/**
 * Compute shadow visibility with normal bias and darkness control.
 * Supports soft shadows and normal-based attenuation.
 *
 * @chunk functions/csm_shadowVisibility
 */
fn csm_private_shadowVisibility(visibility: f32, nDotL: f32, normalShadingSmooth: f32, darkness: f32) -> f32 {
    var vis = visibility;
    // When using normal shading, attenuate shadow by surface orientation
    let strength = clamp(nDotL / max(normalShadingSmooth, 0.001), 0.0, 1.0);
    vis *= strength;
    vis = max(vis, darkness);
    return vis;
}

fn csm_shadowVisibility(
    shadowMap: texture_depth_2d,
    shadowSampler: sampler_comparison,
    texCoords: vec2<f32>,
    depth: f32,
    depthBias: f32,
    nDotL: f32,
    normalShadingSmooth: f32,
    darkness: f32
) -> f32 {
    let biasedDepth = depth - depthBias;
    let visibility = textureSampleCompare(shadowMap, shadowSampler, texCoords, biasedDepth);
    return csm_private_shadowVisibility(visibility, nDotL, normalShadingSmooth, darkness);
}

fn csm_shadowVisibility_soft(
    shadowMap: texture_depth_2d,
    shadowSampler: sampler_comparison,
    texCoords: vec2<f32>,
    shadowMapSize: f32,
    depth: f32,
    depthBias: f32,
    nDotL: f32,
    normalShadingSmooth: f32,
    darkness: f32
) -> f32 {
    let biasedDepth = depth - depthBias;
    let texelSize = 1.0 / shadowMapSize;

    // 3x3 PCF sampling
    var visibility = 0.0;
    for (var x = -1i; x <= 1i; x++) {
        for (var y = -1i; y <= 1i; y++) {
            let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
            visibility += textureSampleCompare(shadowMap, shadowSampler, texCoords + offset, biasedDepth);
        }
    }
    visibility /= 9.0;

    return csm_private_shadowVisibility(visibility, nDotL, normalShadingSmooth, darkness);
}
