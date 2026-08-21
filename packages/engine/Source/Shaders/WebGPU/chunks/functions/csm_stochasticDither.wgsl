/**
 * Stochastic dither threshold for alpha-test rendering.
 *
 * Jorge Jimenez's Interleaved Gradient Noise (IGN) is inexpensive in the
 * fragment stage and has blue-noise-like spectral properties. Its
 * high-frequency, weakly correlated pixel noise avoids the structured
 * banding produced by a purely hash-based dither.
 *
 * Returns a value satisfying `0 <= result < 1` that varies with `fragCoord`:
 *   - Discarding fragments where `alpha < csm_stochasticDither(fragCoord)`
 *     produces probabilistic survival = alpha.
 *   - Multi-frame averaging (e.g., under TAA) converges to
 *     visually-correct alpha-weighted appearance.
 *
 * The optional `temporalOffset` parameter shifts the noise pattern
 * over time so multi-frame TAA accumulation sees uncorrelated noise
 * across frames — essential for the dither result to converge to the
 * true alpha-weighted appearance under temporal accumulation.
 *
 * @chunk functions/csm_stochasticDither
 */
fn csm_stochasticDither(fragCoord: vec2<f32>, temporalOffset: f32) -> f32 {
    let xy = fragCoord + vec2<f32>(temporalOffset, temporalOffset * 1.6180339887);
    return fract(52.9829189 * fract(0.06711056 * xy.x + 0.00583715 * xy.y));
}
