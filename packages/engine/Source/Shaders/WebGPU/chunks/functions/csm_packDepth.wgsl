/**
 * Pack a depth value [0,1] into an RGBA color.
 * Used for depth textures on platforms that don't support float textures.
 *
 * @chunk functions/csm_packDepth
 */
fn csm_packDepth(depth: f32) -> vec4<f32> {
    let r = depth;
    let g = fract(depth * 255.0);
    let b = fract(depth * 65025.0);
    let a = fract(depth * 16581375.0);
    return vec4<f32>(r, g, b, a) - vec4<f32>(g, b, a, 0.0) * (1.0 / 255.0);
}
