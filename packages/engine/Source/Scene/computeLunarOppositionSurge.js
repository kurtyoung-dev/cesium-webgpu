// C12-23 — lunar opposition surge (CPU-side, one scalar per frame).
//
// The Moon brightens far more steeply near zero phase angle than any
// Lambert or Lommel-Seeliger disc law predicts: disc-integrated brightness
// rises by more than 40% between phase angles 4° and 0° (Buratti, Hillier
// & Wang 1996, "The Lunar Opposition Surge: Observations by Clementine",
// Icarus 124). The mechanism is shadow-hiding plus coherent backscatter;
// the standard analytic form is Hapke's shadow-hiding opposition-effect
// (SHOE) term (Hapke 1986, Icarus 67):
//
//     B(α) = 1 + B0 / (1 + tan(α/2) / h)
//
// where B0 is the surge amplitude and h its angular half-width. For a
// distant decorative moon the phase angle α is effectively constant across
// the disc, so the multiplier is computed once per frame on the CPU and
// passed as a single uniform — zero per-pixel cost (the C12-23 queue-row
// design).
//
// Constants are tuned to the Clementine measurement: with B0 = 0.6 and
// h = tan(0.5°) ≈ 0.00873, B(0)/B(4°) = 1.6/1.12 ≈ 1.43 (the required
// >40% rise), and the term decays to < 1.01 by α = 90° so quarter-phase
// and crescent brightness is untouched.

// Surge amplitude B0 (dimensionless).
const SURGE_AMPLITUDE = 0.6;
// Angular half-width h ≈ tan(0.5°) — the surge is a few degrees wide.
const SURGE_ANGULAR_SCALE = 0.00873;

/**
 * Computes the lunar opposition-surge brightness multiplier for a given
 * phase angle (the Sun–Moon–observer angle). Returns exactly 1.0 for
 * invalid input and asymptotically 1.0 away from opposition, so the
 * multiplier is a no-op everywhere except within a few degrees of full
 * moon.
 *
 * @param {number} phaseAngle The phase angle in radians (0 = opposition /
 *   full moon, π = new moon).
 * @returns {number} The brightness multiplier, in [1, 1 + B0].
 * @private
 */
function computeLunarOppositionSurge(phaseAngle) {
  if (!(phaseAngle >= 0.0) || !isFinite(phaseAngle)) {
    return 1.0;
  }
  const t = Math.tan(0.5 * phaseAngle);
  if (!isFinite(t) || t < 0.0) {
    // tan blows up at α = π (new moon) — the surge is 1.0 there anyway.
    return 1.0;
  }
  return 1.0 + SURGE_AMPLITUDE / (1.0 + t / SURGE_ANGULAR_SCALE);
}

export default computeLunarOppositionSurge;
