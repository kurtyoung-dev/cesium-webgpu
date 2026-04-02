/**
 * Multiply texel with color while maintaining perceptual balance.
 *
 * @chunk functions/csm_multiplyWithColorBalance
 */
fn csm_multiplyWithColorBalance(tex: vec3<f32>, color: vec3<f32>) -> vec3<f32> {
    let W = vec3<f32>(0.2125, 0.7154, 0.0721);
    let texL = dot(tex, W);
    if (texL == 0.0) {
        return color;
    }
    let colorL = dot(color, W);
    return color * (texL / colorL);
}
