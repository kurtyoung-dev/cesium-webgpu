/**
 * Shadow volume fragment shader for ground primitive classification.
 * Port of ShadowVolumeFS.glsl.
 * Used for stencil-based classification rendering.
 */

@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
    // Shadow volume rendering writes to stencil only.
    // The fragment color is unused but required for the pipeline.
    return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}
