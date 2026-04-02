/**
 * Compute meters per pixel at a given position in eye coordinates.
 * Useful for LOD and size-based culling decisions.
 *
 * @chunk functions/csm_metersPerPixel
 * @requires CameraUniforms (projection, viewport)
 */
fn csm_metersPerPixel(positionEC: vec4<f32>, pixelRatio: f32, viewport: vec4<f32>, projection: mat4x4<f32>) -> f32 {
    let dist = length(positionEC.xyz);
    let mpp = dist / projection[1][1] * 2.0 / viewport.w;
    return max(mpp, mpp * pixelRatio);
}
