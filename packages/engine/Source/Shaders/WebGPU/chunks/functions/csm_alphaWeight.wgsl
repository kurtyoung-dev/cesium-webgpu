/**
 * Compute alpha weight for OIT (Order-Independent Transparency).
 * Based on McGuire and Bavoil, Weighted Blended OIT, 2013.
 *
 * @chunk functions/csm_alphaWeight
 */
fn csm_alphaWeight(a: f32, z: f32) -> f32 {
    return clamp(a * max(1e-2, min(3e3, 10.0 / (1e-5 + pow(z / 5.0, 2.0) + pow(z / 200.0, 6.0)))), 1e-2, 3e2);
}
