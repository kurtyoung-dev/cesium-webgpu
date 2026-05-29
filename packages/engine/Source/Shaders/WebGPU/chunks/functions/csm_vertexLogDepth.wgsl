/**
 * Logarithmic-depth vertex-stage helpers. Port of czm_vertexLogDepth /
 * czm_updatePositionDepth (vertexLogDepth.glsl).
 *
 * CANONICAL CONTRACT (Slice 0 of the renderer-wide log-depth epic — keep this
 * byte-compatible with the inline copy in WGSLBuiltins.ts):
 *   vertex stage:   v_logDepth = csm_vertexLogDepth(clipPosition, near);
 *                   out.position = csm_updatePositionDepth(clipPosition);
 *   fragment stage: out.depth = csm_writeLogDepth(v_logDepth, oneOverLog2FarDepthFromNearPlusOne);
 *
 * `csm_vertexLogDepth` returns the LINEAR "eye distance from the near plane,
 * plus one" — exactly WebGL's `v_depthFromNearPlusOne = (clipCoords.w - near) + 1`.
 * The fragment stage takes log2 of the *interpolated* linear value; interpolating
 * the linear distance (not its log) is what matches WebGL's precision behavior.
 *
 * @chunk functions/csm_vertexLogDepth
 */
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
    // clipPosition.w is the positive eye-space distance (perspective w = -eye_z).
    return (clipPosition.w - near) + 1.0;
}

/**
 * Clamp clip-space z so floating-point rounding at the very high far/near ratios
 * used with a logarithmic depth buffer cannot clip a vertex before the fragment
 * stage writes the correct log depth. WebGPU NDC z is [0,1] (WebGL is [-1,1]),
 * so the clamp range differs from czm_updatePositionDepth's [-1,1].
 */
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
    var coords = clipPosition;
    coords.z = clamp(coords.z / coords.w, 0.0, 1.0) * coords.w;
    return coords;
}
