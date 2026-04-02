/**
 * Morph between 2D/Columbus View and 3D positions.
 * Uses manual linear interpolation to avoid GPU mix() jitter at t=0 and t=1.
 *
 * @chunk functions/csm_columbusViewMorph
 */
fn csm_columbusViewMorph(position2D: vec4<f32>, position3D: vec4<f32>, time: f32) -> vec4<f32> {
    // Manual formulation avoids jitter on some GPUs (NVidia 3070 Ti, Intel Arc A750)
    let p = position2D.xyz * (1.0 - time) + position3D.xyz * time;
    return vec4<f32>(p, 1.0);
}
