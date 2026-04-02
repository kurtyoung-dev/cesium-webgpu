/**
 * Reverse a logarithmic depth value back to a linear window-space depth.
 *
 * @chunk functions/csm_reverseLogDepth
 */
fn csm_reverseLogDepth(logZ: f32, far: f32) -> f32 {
    if (far == 0.0) { return 0.0; }
    let logFar = log2(far + 1.0);
    var z = pow(2.0, logZ * logFar) - 1.0;
    z = z / far;
    return z;
}
