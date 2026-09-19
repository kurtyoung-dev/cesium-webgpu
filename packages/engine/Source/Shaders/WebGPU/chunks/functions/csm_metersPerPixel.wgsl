/**
 * Compute meters per pixel at a given position in eye coordinates.
 * Useful for LOD and size-based culling decisions.
 *
 * Twin of the GLSL builtin `Builtin/Functions/metersPerPixel.glsl`'s
 * `czm_metersPerPixel(positionEC, pixelRatio)`, with two known gaps against
 * that source that are left as approximations rather than reproduced:
 *   (a) `1.0 / projection[1][1]` recovers `tan(fovy/2)` (equivalently
 *       `top/near`) only for a SYMMETRIC frustum — an off-centre frustum is
 *       approximated.
 *   (b) the perspective arm returns `pixelHeight` where the GLSL returns
 *       `max(pixelWidth, pixelHeight)`. For a symmetric frustum whose
 *       aspectRatio matches the viewport the two are exactly equal
 *       (`right/width == top/height`), so the drop is a no-op — but it IS a
 *       divergence and a frustum whose aspect has drifted from the drawing
 *       buffer would see it. The orthographic arm takes the `max` the GLSL
 *       takes.
 *
 * The GLSL's `czm_sceneMode2D || czm_orthographicIn3D` arm IS reproduced. It
 * covers exactly the frustums whose projection is orthographic, and that is
 * readable from the matrix this function already takes, so it needs no
 * scene-mode uniform.
 *
 * @chunk functions/csm_metersPerPixel
 * @requires CameraUniforms (projection, viewport)
 */
fn csm_metersPerPixel(positionEC: vec4<f32>, pixelRatio: f32, viewport: vec4<f32>, projection: mat4x4<f32>) -> f32 {
    // An orthographic pixel's size is fixed by the frustum extents and does
    // not depend on the eye-space depth. `Matrix4.computeOrthographicOffCenter`
    // writes 2/(right-left) and 2/(top-bottom) into [0][0] and [1][1] and 1.0
    // into [3][3]; the perspective builder writes 0.0 into [3][3]. Both hold
    // under either clip-space depth convention, which only rewrites the z row,
    // so [3][3] selects the arm and [0][0]/[1][1] recover the GLSL's
    // `frustumWidth / width` and `frustumHeight / height`.
    if (projection[3][3] > 0.5) {
        return max(2.0 / (projection[0][0] * viewport.z),
                   2.0 / (projection[1][1] * viewport.w)) * pixelRatio;
    }
    // GLSL: `distanceToPixel = -positionEC.z` (eye-space depth along the view
    // axis), not the 3D vector length the previous, uncalled draft of this
    // chunk used.
    let distanceToPixel = -positionEC.z;
    let tanTheta = 1.0 / projection[1][1];
    let pixelHeight = 2.0 * distanceToPixel * tanTheta / viewport.w;
    return pixelHeight * pixelRatio;
}
