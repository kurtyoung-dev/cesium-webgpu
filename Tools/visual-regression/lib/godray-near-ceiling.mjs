/**
 * The god-ray probe's NEAR-sun amplitude ceiling, derived from the law's own
 * glow profile.
 *
 * WHY THIS FILE EXISTS. `probe-godray-energy-law.mjs` had a floor on the
 * near-sun lift (G3, "a shaft still exists") and a ceiling only on the FAR
 * band (G2), so a shaft that blew the near-sun disc out to white passed every
 * bar: G1 is count-invariant whether or not the picture is too bright, G2
 * measures a region the blow-out does not reach, and G3/G4 pass HARDER the
 * brighter it gets. The ceiling below is the missing direction. It lives in
 * its own module, with NO imports, so that the probe can use it, a spec can
 * EXECUTE it rather than grep for it, and a mutated copy can be imported from
 * a `data:` URL without resolving a single specifier.
 *
 * THE DERIVATION — all of it, so the number is checkable rather than chosen.
 *
 * The probe's NEAR region is the disc `|(du * aspect, dv)| <= r` around the
 * projected sun, and the shader's glow is `1 / (1 + (d / r)^2)` over that same
 * aspect-corrected metric (`GodRayGenerate.wgsl`, `godRaySunGlow` and the
 * `offset` it is called with). So the NEAR region is exactly the glow's own
 * unit-radius disc, and it is a circle in PIXELS, which makes pixel density
 * over it uniform and the area mean an honest integral:
 *
 *   E[glow] = (1 / (pi r^2)) * int_0^r 1/(1+(d/r)^2) * 2 pi d dd
 *           = 2 * int_0^1 s/(1+s^2) ds
 *           = ln 2                                          (= 0.693147...)
 *
 * Let `alpha` be the peak added radiance at the sun centre divided by the
 * radiance headroom there — the amount of room the OFF frame leaves before the
 * display white point. The composite is a plain `scene.rgb + rays.rgb`
 * (`GodRayComposite.wgsl`) and every display transform after it is monotone,
 * so a pixel clips exactly where `alpha * glow(s) >= 1`, i.e. where
 * `s^2 <= alpha - 1`. The clipped AREA FRACTION of the near disc is therefore
 *
 *   clipped(alpha) = alpha - 1        for 1 <= alpha <= 2,   1 above that
 *
 * — an exact result that does NOT depend on the shape of the tone map, only on
 * it being monotone with a finite white point. Integrating the clipped profile
 * gives the disc's mean added display value as a fraction of the headroom:
 *
 *   M(alpha) = alpha * ln 2                              for alpha <= 1
 *   M(alpha) = (alpha - 1) + alpha * (ln 2 - ln alpha)   for 1 <= alpha <= 2
 *   M(alpha) = 1                                         for alpha >= 2
 *
 * with `M(1) = ln 2` (the peak exactly reaches white, nothing clips) and
 * `M(2) = 1` (the whole disc is white — the blow-out). That whole range is the
 * discriminator: `nearDelta / (1 - offNear)` reads 0.693 when the shaft just
 * touches white and 1.000 when it is a white plateau.
 *
 * THE ONE JUDGEMENT. `NEAR_CEILING_ALPHA = 1.1` — the shaft's peak may exceed
 * the display white point by at most 10%, which by the exact law above clips
 * at most the inner 10% of the disc AREA. A bright sun core is allowed; a
 * white plateau is not. Everything else here is arithmetic.
 *
 * WHAT THE BAR APPROXIMATES, stated because it is what a first capture will
 * test. The mapping from `alpha` to a MEAN is written in display units with a
 * locally linear response, and the two error directions are opposite: pixels
 * the OFF frame already saturated (the sun's own billboard) contribute zero to
 * `nearDelta` and push the measurement DOWN, while a compressive tone map
 * flattens the displayed profile and pushes the mean/peak ratio UP from ln 2.
 * The clipped-area law is exact under either. That is why the probe records
 * `nearSaturatedAll` / `nearSaturatedAny` beside the ceiling: the first
 * capture replaces this judgement with the measured clipped fraction, and the
 * receipt already carries everything that replacement needs.
 *
 * @module godray-near-ceiling
 */

/** Area mean of the unclipped glow over its own unit-radius disc. */
export const NEAR_DISC_MEAN_GLOW = Math.log(2);

/**
 * The allowed overshoot of the display white point at the sun centre. By
 * `clipped(alpha) = alpha - 1` this is also the allowed clipped area fraction
 * of the near disc: 1.1 permits the inner 10%.
 */
export const NEAR_CEILING_ALPHA = 1.1;

/**
 * Mean added display value over the near disc, as a fraction of the headroom,
 * for a peak that overshoots the white point by `alpha`.
 *
 * @param {number} alpha Peak added radiance / headroom at the sun centre.
 * @returns {number} The mean, in [0, 1].
 */
export function nearDiscMeanFraction(alpha) {
  if (!(alpha > 0)) {
    return 0;
  }
  if (alpha <= 1) {
    return alpha * NEAR_DISC_MEAN_GLOW;
  }
  if (alpha >= 2) {
    return 1;
  }
  return alpha - 1 + alpha * (NEAR_DISC_MEAN_GLOW - Math.log(alpha));
}

/** The shipped ceiling, as a fraction of the near disc's display headroom. */
export const NEAR_CEILING_FRACTION = nearDiscMeanFraction(NEAR_CEILING_ALPHA);

/**
 * The ceiling on the measured near-sun lift, in luma, for a capture whose OFF
 * leg measured `offNear` over the same disc. Computed from the capture's own
 * headroom, so the bar is calibrated by the evidence rather than invented.
 *
 * @param {number} offNear Mean luma of the near disc with god rays OFF.
 * @returns {number} The largest `nearDelta` the law admits.
 */
export function nearCeiling(offNear) {
  return NEAR_CEILING_FRACTION * Math.max(0, 1 - offNear);
}

/**
 * The overshoot the measurement implies — the inverse of
 * `nearDiscMeanFraction`, so a failing capture says by how much rather than
 * only that it failed. Saturates at 2, where the whole disc is white.
 *
 * @param {number} nearDelta Measured near-sun lift, in luma.
 * @param {number} offNear Mean luma of the near disc with god rays OFF.
 * @returns {number} The implied alpha, in [0, 2].
 */
export function impliedOvershoot(nearDelta, offNear) {
  const headroom = 1 - offNear;
  if (!(headroom > 0) || !(nearDelta > 0)) {
    return 0;
  }
  const ratio = nearDelta / headroom;
  if (ratio <= NEAR_DISC_MEAN_GLOW) {
    return ratio / NEAR_DISC_MEAN_GLOW;
  }
  if (ratio >= 1) {
    return 2;
  }
  // `nearDiscMeanFraction` is strictly increasing on [1, 2]; 60 bisections
  // take the bracket below f64 resolution.
  let lo = 1;
  let hi = 2;
  for (let i = 0; i < 60; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (nearDiscMeanFraction(mid) < ratio) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}
