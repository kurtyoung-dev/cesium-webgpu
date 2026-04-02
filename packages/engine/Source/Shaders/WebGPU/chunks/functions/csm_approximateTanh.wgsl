/**
 * Attempt to approximate tanh(x). Port of czm_approximateTanh.
 *
 * @chunk functions/csm_approximateTanh
 */
fn csm_approximateTanh(x: f32) -> f32 {
    let x2: f32 = x * x;
    return sign(x) * sqrt(x2 / (1.0 + x2));
}
