/**
 * Stochastic dither threshold for alpha-test rendering.
 *
 * Uses Jorge Jimenez's Interleaved Gradient Noise (IGN) — a cheap
 * fragment-stage noise function with good blue-noise-like spectral
 * properties. UE4/UE5/Frostbite ship this for dithered transparency.
 *
 * Returns a value in [0, 1) that varies with `fragCoord` such that:
 *   - Discarding fragments where `alpha < csm_stochasticDither(fragCoord)`
 *     produces probabilistic survival = alpha.
 *   - Multi-frame averaging (e.g., under TAA) converges to
 *     visually-correct alpha-weighted appearance.
 *   - Spectral noise is high-frequency and low-correlated at the
 *     pixel level, avoiding the structured banding that purely
 *     hash-based dither produces.
 *
 * The optional `temporalOffset` parameter shifts the noise pattern
 * over time so multi-frame TAA accumulation sees uncorrelated noise
 * across frames — essential for the dither result to converge to the
 * true alpha-weighted appearance under temporal accumulation.
 *
 * Used by:
 *   - C-R9-MODEL-PICK-TRANSLUCENT hover pick (Batch 192) — translucent
 *     pick that doesn't stutter at 60fps hover.
 *   - Future: foliage / particle alpha-test rendering, translucent
 *     shadow casters, voxel ray-march early-termination.
 *
 * @chunk functions/csm_stochasticDither
 */
fn csm_stochasticDither(fragCoord: vec2<f32>, temporalOffset: f32) -> f32 {
    let xy = fragCoord + vec2<f32>(temporalOffset, temporalOffset * 1.6180339887);
    return fract(52.9829189 * fract(0.06711056 * xy.x + 0.00583715 * xy.y));
}
