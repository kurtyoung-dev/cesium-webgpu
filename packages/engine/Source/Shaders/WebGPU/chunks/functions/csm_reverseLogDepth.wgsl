/**
 * Reverse a logarithmic-depth value. Port of czm_reverseLogDepth /
 * the LOG_DEPTH branch of czm_screenToEyeCoordinates
 * (reverseLogDepth.glsl, windowToEyeCoordinates.glsl).
 *
 * CANONICAL CONTRACT (Slice 0 of the renderer-wide log-depth epic — keep this
 * byte-compatible with the inline copy in WGSLBuiltins.ts).
 *
 * Both functions take (logZ, near, far) and derive the per-frustum factor
 * internally (`log2((far - near) + 1)`) so call sites only need the frustum's
 * near/far. The previous 1-arg / near-assumed-zero forms are replaced.
 *
 * @chunk functions/csm_reverseLogDepth
 */

/**
 * logZ (the 0..1 log-depth value) -> hyperbolic window-space NDC z, the value a
 * standard inverse-projection consumer expects. Matches czm_reverseLogDepth.
 */
fn csm_reverseLogDepth(logZ: f32, near: f32, far: f32) -> f32 {
    if (far == near) { return 0.0; }
    let log2FarDepthFromNearPlusOne = log2((far - near) + 1.0);
    let depthFromNear = exp2(logZ * log2FarDepthFromNearPlusOne) - 1.0;
    let depthFromCamera = depthFromNear + near;
    return far * (1.0 - near / depthFromCamera) / (far - near);
}

/**
 * High-precision variant for eye-space reconstruction: returns the positive
 * eye-space distance (depthFromCamera = -eye_z). Reconstructors should set
 * eyeCoordinate.w = 1.0 / this instead of round-tripping through NDC z — matches
 * the LOG_DEPTH branch of czm_screenToEyeCoordinates ("Better precision").
 */
fn csm_reverseLogDepthToEyeDistance(logZ: f32, near: f32, far: f32) -> f32 {
    let log2FarDepthFromNearPlusOne = log2((far - near) + 1.0);
    let depthFromNear = exp2(logZ * log2FarDepthFromNearPlusOne) - 1.0;
    return depthFromNear + near;
}
