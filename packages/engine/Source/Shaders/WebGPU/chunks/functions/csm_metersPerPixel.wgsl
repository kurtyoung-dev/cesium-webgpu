/**
 * Compute meters per pixel at a given position in eye coordinates.
 * Useful for LOD and size-based culling decisions.
 *
 * Twin of the GLSL builtin `Builtin/Functions/metersPerPixel.glsl`'s
 * `czm_metersPerPixel(positionEC, pixelRatio)`, with three known gaps against
 * that source that are left as approximations rather than reproduced:
 *   (a) `1.0 / projection[1][1]` recovers `tan(fovy/2)` (equivalently
 *       `top/near`) only for a SYMMETRIC frustum — an off-centre frustum is
 *       approximated.
 *   (b) the GLSL's `czm_sceneMode2D` / `czm_orthographicIn3D` orthographic
 *       arm is not reproduced here — this is the perspective-only answer. Do
 *       not add a 2D arm speculatively; wait for a caller that needs it.
 *   (c) the GLSL returns `max(pixelWidth, pixelHeight)`; this returns
 *       `pixelHeight` alone. For a symmetric frustum whose aspectRatio matches
 *       the viewport the two are exactly equal (`right/width == top/height`),
 *       so the drop is a no-op — but it IS a third divergence and a frustum
 *       whose aspect has drifted from the drawing buffer would see it.
 *
 * @chunk functions/csm_metersPerPixel
 * @requires CameraUniforms (projection, viewport)
 */
fn csm_metersPerPixel(positionEC: vec4<f32>, pixelRatio: f32, viewport: vec4<f32>, projection: mat4x4<f32>) -> f32 {
    // GLSL: `distanceToPixel = -positionEC.z` (eye-space depth along the view
    // axis), not the 3D vector length the previous, uncalled draft of this
    // chunk used.
    let distanceToPixel = -positionEC.z;
    let tanTheta = 1.0 / projection[1][1];
    let pixelHeight = 2.0 * distanceToPixel * tanTheta / viewport.w;
    return pixelHeight * pixelRatio;
}
