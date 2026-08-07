/**
 * The GATE half of `probe-eclipse-cloud-response.mjs` — C13-41's Edge
 * acceptance predicates, their pre-registered bands, and the fold that turns a
 * run's measurements into a verdict.
 *
 * WHY THIS IS ITS OWN MODULE, AND NOT A `judge()` INSIDE THE PROBE. The same
 * reason `eclipse-ladder-rungs.mjs` exists: a predicate that lives inside a
 * Playwright driver can only be exercised by a full browser run, so its own
 * arithmetic is never tested. Every number below is derivable without an
 * adapter, and `eclipse-cloud-response-gate.spec.mjs` proves the composition —
 * including that each gating predicate can FAIL, which is the property a
 * gate-with-no-mutant silently lacks.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE PRE-REGISTERED PREDICTIONS (C13-41, Batch 871), and where each one
 * is measured
 * ─────────────────────────────────────────────────────────────────────────────
 *   (i)   deck lighting — at obscuration 0.9 the PRE-tonemap deck radiance
 *         ratio is exactly 0.4642; the DISPLAYED ratio lands in [0.46, ~0.63],
 *         never above ~0.7.                       -> `deckRatioInBand`
 *   (ii)  cloud shadow — the ground contrast `mix(1, 0.35, s)` moves
 *         0.350000 -> 0.350293, i.e. +0.08%; a LARGE measured change REFUTES
 *         the model.                              -> `shadowContrastInvariant`
 *   (iii) IBL refresh — a 0 -> 0.9 -> 0 sweep produces exactly 275 environment
 *         refreshes (1 baseline + 2 x 137 bucket edges, buckets 256 -> 119),
 *         quiescent on roughly two thirds of an 801-frame sweep.
 *                             -> `predictedRefreshCountExact` + the two engine
 *                                count bands + `sweepQuiescenceInBand`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY BAND IS `DERIVED` UNTIL THE FIRST EDGE RUN
 * ─────────────────────────────────────────────────────────────────────────────
 * No band here was fitted to a measurement. Each carries its derivation in
 * `why`. After a confirming Edge run the orchestrator may TIGHTEN a band
 * against the observed margin; widening one to make a run pass is the failure
 * mode this note exists to make visible.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE FIRST EDGE RUN (Batch 908) CHANGED HERE — three INSTRUMENT defects,
 * zero band movement
 * ─────────────────────────────────────────────────────────────────────────────
 * The first run came back STRUCTURAL with a deck ratio of 2.937 against
 * [0.44, 0.70] and a negative refresh cost. Not one band moved; three pieces of
 * apparatus did.
 *
 *   1. EXIT CONTRACT. The probe exited 2 on a STRUCTURAL verdict, colliding
 *      with its own watchdog. `eclipseCloudExitCode` now owns the mapping —
 *      0 PASS / 1 FAIL / 2 harness fault / 3 STRUCTURAL — as a pure function
 *      the spec pins directly.
 *   2. PER-LANE SCOPING. A vacuous SHADOW lane demoted the whole gate, so a
 *      3x out-of-band DECK reading printed `failedPredicates: []`. Quarantine
 *      is now per-domain: see `ECLIPSE_CLOUD_PREDICATE_LANES`.
 *   3. DECK ISOLATION. The 2.937 is not attainable by any deck. The deck's
 *      pre-tonemap radiance is exactly linear in the eclipse factor (both
 *      `sunIntensity` and `ambientIntensity` carry it) and Reinhard is
 *      monotone, so H(F) <= H(1) and the pure deck ratio is bounded by 1. The
 *      difference image was never isolating the deck: the composite is
 *      `mix(sceneColor, deckColor, alpha)`, so `cloudsOn - cloudsOff` is
 *      `alpha * (H - S)` and the sky survives with a minus sign. See
 *      `deckBackgroundCeiling.why`; the precondition is now READ BACK.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE SECOND EDGE RUN (Batch 910) CHANGED HERE — one more precondition
 * pair, still zero band movement
 * ─────────────────────────────────────────────────────────────────────────────
 * The second run came back EXIT 1 with the deck lane on a provably black
 * background (`deckBackgroundMax` 0) reading 0.894 against [0.44, 0.70], and the
 * shadow lane STILL blind at 0.9987 after Batch 909 had fixed its geometry.
 *
 *   - The DECK reading is a REAL product finding and stays one. It is NOT the
 *     aerial addend: at the lane-A camera the haze fraction
 *     `clamp(midDist/60000, 0, 0.85)` runs 0.086..0.170 over the scored band, so
 *     `aerialColor` contributes ~10% of the deck's band mean and dimming it can
 *     move the ratio to at best 0.79. See the C13-41 row for the full
 *     arithmetic; the residual is the deck's own Reinhard at `cloud.exposure`
 *     0.22 running at an exposed radiance of ~7.7, where a 2.15x radiance drop
 *     displays as 1.13x. `deckDisplayedRatio` is NOT widened for that — a band
 *     moved to admit the reading it was built to catch certifies nothing.
 *   - The SHADOW lane was vacuous for a SECOND, independent reason the contrast
 *     ceiling structurally cannot express. Batch 909 fixed the GEOMETRIC vacuity
 *     (sub-texel band) and flew the lane at 9000 m — ABOVE the 1500-4000 m deck,
 *     so the line of sight to the ground crossed the cloud. Fitting that run's
 *     own numbers gives ~70% opaque cloud over a `baseColor`-only globe whose
 *     display luma is 0.036: a ~1.8% ground share, against which the beer floor
 *     can move the band by at most 0.65 * 0.018 = 1.2%. The 0.98 ceiling was
 *     unreachable however well the cast shadow worked — and the 0.126% it DID
 *     move is ~11% of the visible ground fully shadowed, i.e. the shadow was
 *     there. `shadowGroundBrightness` and `shadowGroundRetention` are the two
 *     read-backs that make that diagnosable instead of inferable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE FOURTH EDGE RUN's TWO DEFERRALS BECAME (CO-17) — two derivations,
 * still ZERO band movement, and the second-run note above is now WRONG in one
 * clause
 * ─────────────────────────────────────────────────────────────────────────────
 * The fourth run scored every lane and left two numbers owed a model. Both are
 * derived below, next to the functions that compute them:
 *
 *   - THE SHADOW's 1.0496 -> see the block above `predictShadowContrastRatio`.
 *     The ambient/direct split the row named as the next derivation REFUTES its
 *     own hypothesis: the eclipse factor cancels out of the contrast, the closed
 *     form has no free parameter, and the directional-only model turns out to be
 *     the SUPREMUM of the split family rather than a rival — so the band cannot
 *     move outward and 1.0496 is a real finding. The derivation also relocates
 *     it: the SHADOWABLE term dims by exactly the published factor, and it is
 *     the ground band as a whole that under-dims by 12.6%.
 *   - THE DECK's `e` -> see the block above `deckDisplayedRatio`. **The
 *     second-run note above is superseded on exactly one clause:** "it is NOT
 *     the aerial addend ... ~10% of the deck's band mean" is wrong by 7.2x. The
 *     addend's DISPLAY share is 0.710, derived by subtracting the two runs, and
 *     with it the tonemap entry re-fits to `e = 1.01` — inside the band's own
 *     `e <= 1` design envelope, not the 7.7 that note records. The ~10% figure
 *     was an aerial FRACTION used as a display SHARE, and it was measured for a
 *     near-field march where the scored band is horizon-weighted. The clause is
 *     left standing rather than edited so the correction is visible as one.
 */

/** The engine's totality floor, recomputed from the two published illuminances
 * rather than imported, so a silent retune of the engine constant fails the
 * probe instead of riding along with it. */
export const ECLIPSE_RADIOMETRIC_FLOOR = 5.0 / 100000.0;
/** The eye-adaptation exponent S2 carries unless `eclipseAutoExposure` is on. */
export const ECLIPSE_ADAPTATION_EXPONENT = 1.0 / 3.0;
/** The 1/256 unit grid the environment-refresh input snaps to. */
export const ENV_REFRESH_STEPS = 256;

/** The sweep's peak obscuration — the row's own `0 -> 0.9 -> 0`. */
export const SWEEP_PEAK_OBSCURATION = 0.9;
/** Frames on the rising branch, inclusive of both ends. */
export const SWEEP_RISING_FRAMES = 401;
/** Total sweep frames: rising + the reverse replay with the peak not repeated. */
export const SWEEP_FRAMES = SWEEP_RISING_FRAMES * 2 - 1;

/**
 * S2's scene-light curve, reimplemented from the published constants. A SECOND
 * implementation on purpose: a gate that echoed `getEclipseSceneLightFactor`
 * would certify that the engine agrees with itself.
 *
 * @param {number} obscuration
 * @param {boolean} [autoExposure=false] Ruling E2's linear radiometric mode.
 * @returns {number}
 */
export function predictFactor(obscuration, autoExposure = false) {
  if (!(obscuration > 0)) {
    return 1.0;
  }
  const visible = obscuration >= 1 ? 0 : 1 - obscuration;
  const flux = visible + ECLIPSE_RADIOMETRIC_FLOOR * (1 - visible);
  return autoExposure ? flux : Math.pow(flux, ECLIPSE_ADAPTATION_EXPONENT);
}

/**
 * C13-41's DIRECTIONAL fraction — the share of the surviving flux a cast
 * shadow can still modulate. Deliberately NOT the scene factor: see
 * `shadowContrastRejectsAlternativeDesign` for the arithmetic that rules the
 * substitution out.
 *
 * @param {number} obscuration
 * @returns {number} exactly 1.0 at zero obscuration, exactly 0 at totality
 */
export function predictDirectional(obscuration) {
  if (!(obscuration > 0)) {
    return 1.0;
  }
  const visible = obscuration >= 1 ? 0 : 1 - obscuration;
  const flux = visible + ECLIPSE_RADIOMETRIC_FLOOR * (1 - visible);
  return flux > 0 ? visible / flux : 0;
}

/**
 * The refresh grid: an exact integer bucket. Bucket `k` covers
 * `[(k - 0.5)/256, (k + 0.5)/256)`, so the identity bucket 256 covers a factor
 * at or above 0.998046875.
 *
 * @param {number} factor
 * @returns {number}
 */
export function predictBucket(factor) {
  const clamped =
    typeof factor === "number" && factor >= 0 && factor <= 1 ? factor : 1;
  return Math.round(clamped * ENV_REFRESH_STEPS);
}

/**
 * The shadowed-ground contrast term the globe applies, `mix(1, T, s)` with the
 * beer floor T = 0.35. Used by both the invariance gate and its refutation
 * control.
 *
 * @param {number} strength The published `shadowStrength`.
 * @returns {number}
 */
export function shadowContrast(strength) {
  return 1.0 - 0.65 * strength;
}

/** Beer floor the globe's cloud-shadow mix targets. */
export const CLOUD_SHADOW_BEER_FLOOR = 0.35;

// ─────────────────────────────────────────────────────────────────────────────
// THE AMBIENT/DIRECT SPLIT — the fifth-pass extension of the shadow model
// (C13-41-SHADOW-CONTRAST-ECLIPSE-EXCESS, CO-17)
// ─────────────────────────────────────────────────────────────────────────────
//
// The fourth Edge run measured `shadowContrastRatioAtDeepest` = 1.0496 against
// the [0.97, 1.03] invariant, on a lane whose vacuity was fully cleared. The row
// named the extension below as the next derivation, on the hypothesis that "the
// shadowed floor is ambient-lit and the ambient dims by a different law than the
// direct term". THE DERIVATION REFUTES THAT HYPOTHESIS, and it does so without
// needing to know the split.
//
// THE SHADER'S OWN STRUCTURE gives the split exactly. `GlobeTerrain.wgsl:4838`
// applies the cast shadow as `color = color * sampleCloudGroundShadow(...)` — a
// MULTIPLY on the whole accumulated surface colour — and everything ADDED after
// that line (the ground-atmosphere + fog block) is a floor the shadow cannot
// touch. So with `D` the shadowable term and `A` the un-shadowable residue:
//
//   U(F) = D*d(F) + A*a(F)                 unshadowed
//   S(F) = T_F*D*d(F) + A*a(F)             shadowed, T_F = mix(1, tau, s_F)
//
// UNDER THE PUBLISHED LAWS d AND a ARE THE SAME FUNCTION. C13-41 multiplies the
// cloud's direct term, the cloud's ambient term and both environment bakes by
// ONE scalar (`applyEclipseCloudDimming`, a plain multiply by
// `resolveEclipseCloudFactor`), and C12-29 S2 multiplies the scene light colour,
// the sky shell, the ground atmosphere and the fog by that same scalar. There is
// no second law in the publication. Set d = a = F and F CANCELS OUT of both
// bands:
//
//   c(F) = (T_F*D + A) / (D + A)
//
// so the ONLY thing that moves the contrast at all is `T_F`, i.e. the shadow
// strength — exactly the quantity the original directional-only model already
// carried. The split changes the prediction's SIZE but not its cause, and it can
// only make it SMALLER, because A dilutes the move.
//
// THE CLOSED FORM HAS NO FREE PARAMETERS. Writing x = A/(D + A) and using the
// MEASURED clear-sky contrast c1 = T_1*(1-x) + x = 1 - s_1*(1-tau)*(1-x):
//
//   (1 - tau)*(1 - x) = (1 - c1) / s_1                      [from c1 alone]
//   c(F) = c1 + (s_1 - s_F) * (1 - tau) * (1 - x)
//        = c1 + (s_1 - s_F) * (1 - c1) / s_1
//   ratio = c(F)/c1 = 1 + (s_1 - s_F) * (1 - c1) / (s_1 * c1)
//
// Both `tau` (the beer transmittance the band actually averages) and `x` (the
// split) CANCEL against the measured clear contrast. That is why the extension
// cannot be tuned to reach 1.05: it has nothing to tune.
//
// AT THE FOURTH RUN'S NUMBERS (deepest rung: s_F = 0.9995501, c1 = 0.679870):
//
//   ratio = 1 + (1 - 0.9995501) * (1 - 0.679870) / 0.679870
//         = 1 + 0.00044989 * 0.470868
//         = 1.00021184
//
// against the directional-only 1.00083551 and the MEASURED 1.049596. The
// extension moves the prediction 3.9x CLOSER to 1, in the opposite direction
// from the measurement.
//
// THE DIRECTIONAL-ONLY MODEL IS THE SUPREMUM OF THIS FAMILY, not a rejected
// alternative. `ratio - 1` is decreasing in c1, and c1 = tau*(1-x) + x is
// minimised at x = 0 (no residue) and tau at the beer floor, where c1 = 0.35 and
//
//   ratio = 1 + (1 - s_F) * 0.65 / 0.35 = (1 - 0.65*s_F) / 0.35
//
// which is `shadowContrast(s_F) / shadowContrast(1)` — the original prediction,
// verbatim. So NO admissible split reaches 1.0496: at the published s_F the
// whole family is capped at 1.00084, and the measurement is 59x past that cap.
// `shadowContrastModelIsBoundedByDirectional` gates the inequality.
//
// THEREFORE THE BAND DOES NOT MOVE. The row asked for it to move BY DERIVATION
// if the extension predicted ~1.05; the extension predicts 1.0002, so
// [0.97, 1.03] stands and 1.0496 is a REAL finding. The band's headroom over the
// model grew from 36x to 142x, which is a reason to keep it, not to widen it.
//
// WHAT THE DERIVATION DOES LOCALISE. Because F cancels, the published laws also
// predict that BOTH ground bands dim by exactly F — `onNoShadow/offNoShadow` and
// `onShadow/offShadow` should each equal the published factor. The fourth run
// reads 1.126x and 1.182x of F at the deepest rung: the ground band UNDER-DIMS,
// and the contrast excess is the arithmetic consequence
// (1.181983 / 1.126131 = 1.0496). `extractShadowableDimming` inverts the two
// bands for the shadowable term's own law and reads d/F = 1.000 / 0.992 / 0.995 /
// 1.008 across the ladder — the shadowable path is exactly right to <1%, so the
// under-dim lives ENTIRELY in the residue the shadow cannot touch. Reported, not
// gated: naming a residue is a diagnosis, and the fifth run's clouds-off
// eclipse-ON control is what attributes it.

/**
 * The ambient/direct-split prediction for the eclipse contrast ratio, in closed
 * form. See the block above: the split `x` and the beer transmittance `tau`
 * cancel against the measured clear contrast, so this takes no split parameter
 * and cannot be tuned.
 *
 * @param {object} model
 * @param {number} model.strengthClear Published `shadowStrength` in the clear leg.
 * @param {number} model.strengthEclipse Published `shadowStrength` under eclipse.
 * @param {number} model.clearContrast MEASURED `shadowOn/shadowOff` in the clear leg.
 * @returns {number|null} the predicted `contrast|eclipse / contrast|clear`
 */
export function predictShadowContrastRatio({
  strengthClear,
  strengthEclipse,
  clearContrast,
}) {
  if (
    !Number.isFinite(strengthClear) ||
    !Number.isFinite(strengthEclipse) ||
    !Number.isFinite(clearContrast) ||
    !(strengthClear > 0) ||
    !(clearContrast > 0)
  ) {
    return null;
  }
  return (
    1 +
    ((strengthClear - strengthEclipse) * (1 - clearContrast)) /
      (strengthClear * clearContrast)
  );
}

/**
 * The SUPREMUM of {@link predictShadowContrastRatio} over every admissible split
 * — attained at zero residue with the beer transmittance at its floor, where the
 * closed form reduces to `shadowContrast(s_F) / shadowContrast(s_1)`, i.e. the
 * original directional-only model verbatim.
 *
 * @param {number} strengthEclipse
 * @param {number} [strengthClear=1]
 * @returns {number}
 */
export function shadowContrastRatioSupremum(
  strengthEclipse,
  strengthClear = 1,
) {
  return shadowContrast(strengthEclipse) / shadowContrast(strengthClear);
}

/**
 * Proves, over the whole admissible domain, that the extended model can never
 * exceed the directional-only one — the property that keeps the invariant band
 * from moving outward. Pure arithmetic with no run input, so it belongs to
 * `gate-arithmetic` and is never quarantined.
 *
 * @returns {boolean}
 */
export function shadowContrastModelIsBoundedByDirectional() {
  // The clear contrast a real band can carry: at least the beer floor (a fully
  // shadowed band) and below 1 (a band with no shadow at all is vacuous and is
  // caught by `shadowVacuityCeiling`).
  for (let i = 0; i <= 64; i++) {
    const clearContrast =
      CLOUD_SHADOW_BEER_FLOOR +
      ((1 - CLOUD_SHADOW_BEER_FLOOR) * i) / 65; /* strictly below 1 */
    for (let j = 0; j <= 64; j++) {
      const strengthEclipse = j / 64;
      const split = predictShadowContrastRatio({
        strengthClear: 1,
        strengthEclipse,
        clearContrast,
      });
      const supremum = shadowContrastRatioSupremum(strengthEclipse);
      // Equality is REQUIRED at the beer floor — that is what makes the
      // directional-only model the supremum rather than merely an upper bound.
      if (!(split <= supremum + 1e-12)) {
        return false;
      }
      if (i === 0 && Math.abs(split - supremum) > 1e-12) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Inverts one rung's four ground-band reads for the law the SHADOWABLE term
 * actually followed, with no assumption about the residue's share or the beer
 * transmittance. From the model in the block above, at one instant:
 *
 *   U(F)/U(1) - S(F)/U(1) = (1 - T)*(1 - x) * d(F)
 *   1 - c1                = (1 - T)*(1 - x)          [c1 = S(1)/U(1)]
 *
 * so `d(F)` is the quotient. Under the published laws it must equal the
 * published factor; anything else localises the defect to the shadowable path
 * rather than to the residue.
 *
 * @param {object} shadow One rung's `shadow` block.
 * @returns {number|null}
 */
export function extractShadowableDimming(shadow) {
  const u1 = shadow?.offNoShadow;
  const s1 = shadow?.offShadow;
  const uF = shadow?.onNoShadow;
  const sF = shadow?.onShadow;
  if (![u1, s1, uF, sF].every((value) => Number.isFinite(value)) || !(u1 > 0)) {
    return null;
  }
  const clearContrast = s1 / u1;
  const denominator = 1 - clearContrast;
  if (!(Math.abs(denominator) > 1e-9)) {
    return null;
  }
  return (uF - sF) / u1 / denominator;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DECK-FREE GROUND ATTRIBUTION LEG — `onNoCloud / offNoCloud` vs F
// (C13-41-SHADOW-CONTRAST-ECLIPSE-EXCESS, CO-19; pre-registered by CO-17)
// ─────────────────────────────────────────────────────────────────────────────
//
// CO-17 derived that the published laws require BOTH scored ground bands to dim
// by exactly F, and measured 1.126x and 1.182x of F instead. It could not say
// WHOSE residue that is, because every band it had was captured with the deck
// ON. Lane B already flew a DECK-FREE control in the eclipse-OFF position
// (`offNoCloud`); the eclipse-ON twin at the same instant is the one number that
// splits the candidates:
//
//   onNoCloud / offNoCloud == F   the globe's own light path dims correctly, so
//                                 the residue is CLOUD-DRIVEN — which the
//                                 existing numbers already point at, since
//                                 turning the deck on ADDS 13.7% to the ground
//                                 band at rung 0 (offNoShadow/offNoCloud =
//                                 1.1589) even though the lane flies at 1400 m
//                                 BELOW a 1500 m deck floor and no downward ray
//                                 reaches the deck. Suspects then are the
//                                 cloud-driven post-process addends
//                                 (WebGPUAerialPerspectiveEffect,
//                                 WebGPUVolumetricFogRenderer) and the filed
//                                 C13-41-ENV-GROUND-INSCATTER-ADDEND-UNDIMMED.
//   onNoCloud / offNoCloud >  F   the globe's own light path carries an
//                                 under-dimmed term and the cloud subsystem is
//                                 EXONERATED.
//
// THE TOLERANCE IS PROPAGATED, NOT CHOSEN. The comparison is a ratio of two
// captured band means, each resolvable to one eight-bit code
// (`BAND_MEAN_CAPTURE_DELTA`, the same quantity `determinismDelta` bounds). For
// r = U_on / U_off:
//
//   |dr| <= d*|dr/dU_on| + d*|dr/dU_off|
//         = d/U_off + d*U_on/U_off^2
//         = (d / U_off) * (1 + r)
//
// At the fourth run's own deck-free band (U_off = 0.27506) and r ~ F = 0.4642
// that is (0.004/0.27506) * 1.4642 = 0.02129 — and the under-dim the reframing
// predicts if the globe path were the carrier is 1.1261*F - F = 0.0585, i.e.
// 2.75x the tolerance. The instrument can resolve the answer either way.
//
// AND IT IS BOUNDED ABOVE BY CONSTRUCTION. The tolerance grows as the band
// darkens, but `shadowGroundIsBright` blinds the whole `shadow` domain below
// U_off = SHADOW_GROUND_BRIGHTNESS_FLOOR, and a ratio above 1 means the eclipse
// BRIGHTENED the ground (a failure on its own terms), so the loosest tolerance
// this predicate can ever be scored with is
// (0.004/0.15)*(1+1) = 0.05333 — `deckFreeGroundDimToleranceCap`. A derived
// tolerance is clamped to that cap so a dark band can never buy itself a wider
// gate than the structural floor already allows.

/**
 * The propagated tolerance for one rung's `onNoCloud / offNoCloud` against the
 * published factor. See the block above for the derivation; the result is
 * clamped to `deckFreeGroundDimToleranceCap` so it can only ever tighten.
 *
 * @param {number} deckFreeBandMean The eclipse-OFF deck-free ground band mean.
 * @param {number} measuredRatio The measured `onNoCloud / offNoCloud`.
 * @returns {number|null}
 */
export function deckFreeGroundDimTolerance(deckFreeBandMean, measuredRatio) {
  if (
    !Number.isFinite(deckFreeBandMean) ||
    !Number.isFinite(measuredRatio) ||
    !(deckFreeBandMean > 0) ||
    !(measuredRatio >= 0)
  ) {
    return null;
  }
  const propagated =
    (BAND_MEAN_CAPTURE_DELTA / deckFreeBandMean) * (1 + measuredRatio);
  const cap =
    (BAND_MEAN_CAPTURE_DELTA / SHADOW_GROUND_BRIGHTNESS_FLOOR) * (1 + 1);
  return Math.min(propagated, cap);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DECK'S DISPLAY TRANSFORM — re-derived from the fourth run
// (C13-41-CLOUD-DECK-TONEMAP-SWALLOWS-THE-DIM, CO-17)
// ─────────────────────────────────────────────────────────────────────────────
//
// The deck's displayed value is NOT the Reinhard alone. `ProceduralClouds.wgsl`
// tonemaps at :2543-2544 and then lerps toward the aerial tint at :2557:
//
//   hazed = mix(toneMapped, cloud.aerialColor, aerial)
//
// Batch 912 made `cloud.aerialColor` eclipse-dimmed at the pack site
// (`dimAerialTint`), so the tint term is EXACTLY LINEAR in F while the tonemapped
// core is compressive. With `s` the tint's share of the un-eclipsed displayed
// deck and `e = cloud.exposure * L` the tonemap entry:
//
//   R(F) = (1 - s) * F*(1 + e)/(1 + F*e) + s * F
//
// THE THIRD-PASS FIT INVERTED THE WRONG EQUATION. It solved the single-term form
// `R = F(1+e)/(1+F*e)` against 0.882, a ratio taken while the tint was still
// UNDIMMED — i.e. it charged the whole of an undimmed ADDEND to the tonemap's
// compression and got e ~ 7.7. The fourth run dimmed the addend and measured
// 0.5139 at the same rung, which is what makes the two-term form solvable.
//
// `s` FALLS OUT OF THE TWO RUNS BY SUBTRACTION, with no fitting at all. The only
// difference between the runs is the tint's law (1 vs F), so
//
//   R_undimmed(F) - R_dimmed(F) = s * (1 - F)
//
// and the three non-trivial rungs each give `s` independently:
//
//   0.983 - 0.903215 = 0.079785 / (1 - 0.887905) = 0.7118
//   0.962 - 0.798213 = 0.163787 / (1 - 0.769032) = 0.7091
//   0.894 - 0.513868 = 0.380132 / (1 - 0.464200) = 0.7095
//
// — self-consistent to 0.4%, which is itself the check that the two-term form is
// the right one. With s = 0.709 the deepest rung gives
//
//   rho = (0.513868 - 0.709*0.464200) / 0.291 = 0.634880
//   e   = (rho - F) / (F * (1 - rho)) = 0.170680 / 0.169490 = 1.0070
//
// and an unconstrained two-parameter fit of the FOURTH RUN ALONE lands at
// s = 0.7175, e = 1.0525 with an RMS residual of 1.05e-5 over three rungs —
// agreement, not independent confirmation (that fit is ill-conditioned on its
// own: perturbing every measured ratio by one 8-bit code admits e in [0.21, 11.7]).
// The cross-run subtraction is what pins it, and the fifth run's
// `cloudAerialStrength = 0` leg is what will pin it in ONE number.
//
// AN UNFITTED PARAMETER LANDS INSIDE ITS SHADER RANGE, which is the strongest
// check available without a new run. The un-eclipsed deck band is 0.627369; the
// decomposition puts the tint at s*0.627369 = 0.450 and the core at 0.177, so
// with alpha ~ 1 the tint fraction is a = 0.654 and the tint's own luma is
// 0.450/0.654 = 0.6879. `cloud.aerialColor`'s Rec.709 luma runs 0.6496 (todT 0)
// to 0.7081 (todT 1) from the packed literals at
// `WebGPUProceduralCloudRenderer.ts:2297-2299` — 0.6879 is inside that window at
// todT ~ 0.66. Nothing in the fit knew those literals.
//
// CONSEQUENCE FOR THE ROW: e = 1.05 (bracketed [1.007, 1.053] by the two
// derivations) is INSIDE the band's own design envelope. `deckDisplayedRatio`'s
// [0.44, 0.70] is `F(1+e)/(1+F*e)` for e in [0, 1] and its 0.70 ceiling holds up
// to e = 1.693. At e = 1.05 the pure-deck ratio is 0.6401, in band; the deck as
// composited reads 0.5139, in band. The "private Reinhard at exposure 0.22
// flattens every light change" claim is REFUTED — the flattening the third pass
// measured was an undimmed addend, and it is fixed.

/** The deck exposure the shader packs by default (`cloud.exposure`, float 97). */
export const DECK_TONEMAP_EXPOSURE = 0.22;
/** The tonemap entry at which `deckDisplayedRatio`'s 0.70 ceiling is reached. */
export const DECK_TONEMAP_ENTRY_CEILING = 1.693;

/**
 * The aerial tint's MEASURED share of the un-eclipsed displayed deck.
 *
 * This is a measurement, not a band — the only one in this module — and it is
 * here because the fit it feeds is reported-only and because the subtraction
 * that produces it is reproducible from two recorded numbers per rung rather
 * than from a curve. It is deliberately NOT used by any gating predicate: a
 * cross-run input has no place in a gate.
 *
 * The three rungs agree to 0.4% (0.7118 / 0.7091 / 0.7095); the value below is
 * their mean, and `fitDeckAerialShare` is the function that produces each.
 * A fifth run with a `cloudAerialStrength = 0` diagnostic leg replaces it with a
 * single-run number, at which point this constant should be retired.
 * @type {number}
 */
export const DECK_AERIAL_SHARE_CROSS_RUN = 0.7101;
/** Where {@link DECK_AERIAL_SHARE_CROSS_RUN} comes from, printed with the fit. */
export const DECK_AERIAL_SHARE_CROSS_RUN_PROVENANCE =
  "second Edge run (tip 1970806a59, tint UNDIMMED) minus fourth Edge run (tip 6e9c997287, tint dimmed) over the 3 non-trivial rungs: (0.983-0.903215)/0.112095=0.7118, (0.962-0.798213)/0.230968=0.7091, (0.894-0.513868)/0.535800=0.7095";

/**
 * The deck's displayed ratio under the two-term model: a compressive Reinhard
 * core plus an aerial tint that is now exactly linear in the eclipse factor.
 *
 * @param {number} factor The eclipse factor F.
 * @param {number} tonemapEntry `cloud.exposure * L`, the un-eclipsed exposed radiance.
 * @param {number} [aerialShare=0] The tint's share of the un-eclipsed displayed deck.
 * @returns {number}
 */
export function deckDisplayedRatio(factor, tonemapEntry, aerialShare = 0) {
  const rho = (factor * (1 + tonemapEntry)) / (1 + factor * tonemapEntry);
  return (1 - aerialShare) * rho + aerialShare * factor;
}

/**
 * The aerial tint's share of the un-eclipsed displayed deck, by SUBTRACTION of
 * two runs that differ only in whether the tint is dimmed. No fitting.
 *
 * @param {number} factor
 * @param {number} ratioUndimmedAddend Displayed ratio with the tint undimmed.
 * @param {number} ratioDimmedAddend Displayed ratio with the tint dimmed by F.
 * @returns {number|null}
 */
export function fitDeckAerialShare(
  factor,
  ratioUndimmedAddend,
  ratioDimmedAddend,
) {
  if (
    !Number.isFinite(factor) ||
    !Number.isFinite(ratioUndimmedAddend) ||
    !Number.isFinite(ratioDimmedAddend) ||
    !(factor < 1)
  ) {
    return null;
  }
  return (ratioUndimmedAddend - ratioDimmedAddend) / (1 - factor);
}

/**
 * Inverts {@link deckDisplayedRatio} for the tonemap entry `e`, given the aerial
 * share. Returns `null` when the measurement is outside the model's range (a
 * displayed ratio at or below the linear F cannot be produced by a compressive
 * transform, and one at or above 1 cannot be produced at all).
 *
 * @param {number} factor
 * @param {number} ratio The measured displayed ratio.
 * @param {number} [aerialShare=0]
 * @returns {number|null}
 */
export function fitDeckTonemapEntry(factor, ratio, aerialShare = 0) {
  if (
    !Number.isFinite(factor) ||
    !Number.isFinite(ratio) ||
    !Number.isFinite(aerialShare) ||
    !(aerialShare < 1) ||
    !(factor > 0) ||
    !(factor < 1)
  ) {
    return null;
  }
  const rho = (ratio - aerialShare * factor) / (1 - aerialShare);
  if (!(rho > factor) || !(rho < 1)) {
    return null;
  }
  return (rho - factor) / (factor * (1 - rho));
}

/**
 * The aerial tint's share of the un-eclipsed displayed deck from ONE run, using
 * the `cloudAerialStrength = 0` diagnostic leg (CO-19). Zeroing float 91 sets
 * the tint fraction `a` to exactly 0, so that leg's own displayed ratio IS the
 * pure deck ratio `rho`, and the composited ratio measured at the same instant
 * gives the share by subtraction with nothing fitted:
 *
 *   R = (1 - s)*rho + s*F   =>   s = (rho - R) / (rho - F)
 *
 * This is the single-run replacement for {@link DECK_AERIAL_SHARE_CROSS_RUN}.
 * It returns `null` rather than a number whenever the subtraction is degenerate
 * (rho == F, i.e. a deck with no compression at all, where the share is not
 * identifiable) or lands outside [0, 1), because a share at or above 1 makes
 * {@link fitDeckTonemapEntry} unsolvable and a negative one is not a share.
 *
 * @param {number} factor The eclipse factor F at that instant.
 * @param {number} ratioComposited The normal leg's displayed deck ratio R.
 * @param {number} ratioPureDeck The `cloudAerialStrength = 0` leg's ratio rho.
 * @returns {number|null}
 */
export function fitDeckAerialShareFromPureDeck(
  factor,
  ratioComposited,
  ratioPureDeck,
) {
  if (
    !Number.isFinite(factor) ||
    !Number.isFinite(ratioComposited) ||
    !Number.isFinite(ratioPureDeck)
  ) {
    return null;
  }
  const denominator = ratioPureDeck - factor;
  // A pure-deck ratio indistinguishable from the linear factor carries no
  // information about the split — the two terms coincide and any share fits.
  if (!(Math.abs(denominator) > 1e-6)) {
    return null;
  }
  const share = (ratioPureDeck - ratioComposited) / denominator;
  if (!(share >= 0) || !(share < 1)) {
    return null;
  }
  return share;
}

/**
 * Counts LEVEL CHANGES in a committed-bucket series, which is what an
 * environment refresh count is: the managers commit the bucket only inside the
 * branch that actually re-fills, so one transition is one fill. A series that
 * jumps two buckets in one step is ONE change, not two — which is exactly why
 * the ramp has to be fine enough not to skip.
 *
 * @param {Array<number>} series
 * @param {number} [seed=Number.NaN] The committed level before the series.
 * @returns {number}
 */
export function countBucketChanges(series, seed = Number.NaN) {
  let changes = 0;
  let previous = seed;
  for (const value of series) {
    if (!Object.is(value, previous)) {
      changes++;
      previous = value;
    }
  }
  return changes;
}

/**
 * The IDEAL sweep's bucket series: the linear obscuration ramp `0 -> 0.9`
 * across `SWEEP_RISING_FRAMES`, then its reverse replay.
 *
 * @returns {Array<number>}
 */
export function idealSweepBuckets() {
  const rising = [];
  for (let k = 0; k < SWEEP_RISING_FRAMES; k++) {
    const obscuration =
      (SWEEP_PEAK_OBSCURATION * k) / (SWEEP_RISING_FRAMES - 1);
    rising.push(predictBucket(predictFactor(obscuration)));
  }
  const full = rising.slice();
  for (let k = SWEEP_RISING_FRAMES - 2; k >= 0; k--) {
    full.push(rising[k]);
  }
  return full;
}

/**
 * The row's headline number: `1 + 2 x 137`. Computed rather than written down,
 * so a retune of the curve, the exponent, the floor or the grid moves it and
 * the gate notices.
 *
 * @returns {number}
 */
export function predictedSweepRefreshCount() {
  // The first commit walks NaN -> 256 during the warm-up, before the sweep's
  // first frame; the sweep itself then contributes its own level changes.
  const buckets = idealSweepBuckets();
  return 1 + countBucketChanges(buckets, buckets[0]);
}

/**
 * Largest single-frame bucket jump in a series. Must be at most 1, or the ramp
 * skipped an edge and the refresh count collapses toward the number of jumps
 * rather than the number of edges.
 *
 * @param {Array<number>} series
 * @returns {number}
 */
export function maxBucketStep(series) {
  let worst = 0;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1];
    const b = series[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      continue;
    }
    const step = Math.abs(b - a);
    if (step > worst) {
      worst = step;
    }
  }
  return worst;
}

/**
 * One eight-bit code value on a band mean — the smallest difference this
 * instrument can resolve at all. NAMED rather than repeated, because two bands
 * are derived from it (`determinismDelta` is it verbatim, and
 * `deckFreeGroundDimToleranceCap` is its propagation through a ratio) and a
 * literal written twice drifts once.
 */
export const BAND_MEAN_CAPTURE_DELTA = 0.004;

/**
 * The dimmest deck-free ground band lane B may score at all — the floor of
 * `shadowGroundBrightness`. It is named here because it BOUNDS the propagated
 * tolerance of every ratio taken against that band: below it the lane is blind
 * and nothing downstream is scored, so no derived tolerance can be looser than
 * the one this floor admits.
 */
export const SHADOW_GROUND_BRIGHTNESS_FLOOR = 0.15;

const band = (lo, hi, why) => Object.freeze({ lo, hi, why, status: "DERIVED" });

/**
 * Every pre-registered band, each with its derivation. `status: "DERIVED"`
 * until the first Edge run confirms the margin.
 */
export const ECLIPSE_CLOUD_BANDS = Object.freeze({
  /** Lane A/B ladder targets. 0.5452 is the discriminating rung — see below. */
  ladderTargets: Object.freeze([0.0, 0.3, 0.5452, SWEEP_PEAK_OBSCURATION]),

  deckDisplayedRatio: band(
    0.44,
    0.7,
    "prediction (i) verbatim: the PRE-tonemap ratio is exactly 0.4642 and the row states the DISPLAYED ratio lands between 0.46 and ~0.63, never above ~0.7. The upper bound is the row's own ceiling. The lower bound is 0.4642 minus a 5% relative allowance (0.0232) for 8-bit quantization on a DIFFERENCE image (deck = cloudsOn - cloudsOff, so two quantized band means are subtracted before the ratio is taken); a compressive tonemap can only push the displayed ratio ABOVE the linear value, so the lower bound is measurement slack rather than physics",
  ),

  deckPureDeckRatio: band(
    0.625,
    0.645,
    "CO-17's PRE-REGISTRATION VERBATIM for the fifth run's `cloudAerialStrength = 0` diagnostic leg: 'the deepest rung reads 0.635 +/- 0.01'. With the tint removed the leg's displayed ratio IS the pure deck ratio rho = F(1+e)/(1+F*e), so this band is a band on `e` in disguise: [0.625, 0.645] at F = 0.464228 maps to e in [0.9235, 1.0969]. It is deliberately TIGHTER than `deckDisplayedRatio`'s 5% relative allowance, because its job is to DISCRIMINATE rather than to admit — it brackets the cross-run per-rung spread e = [1.0033, 1.0127] with ~9x margin while excluding both e = 0 (a linear deck; rho = 0.464228, 17 half-widths below) and the third pass's e = 7.70 (rho = 0.882880, 24.8 half-widths above). A miss REFUTES the cross-run subtraction that produced e = 1.01 and is a finding against that fit, NOT a band to widen: the whole point of a single-run leg is that it can disagree with the cross-run number",
  ),

  deckFreeGroundDimToleranceCap: band(
    0,
    (BAND_MEAN_CAPTURE_DELTA / SHADOW_GROUND_BRIGHTNESS_FLOOR) * (1 + 1),
    "NOT the tolerance — the CAP on it. `deckFreeGroundDimsByFactor` compares `onNoCloud/offNoCloud` against the published F with a tolerance PROPAGATED per rung from the band mean it was measured on, (d/U_off)*(1+r) with d = BAND_MEAN_CAPTURE_DELTA (see `deckFreeGroundDimTolerance`). A propagated tolerance widens as the band darkens, so it needs a ceiling that is not a choice: `shadowGroundIsBright` blinds the whole shadow domain below U_off = 0.15 and a ratio above 1 fails on its own terms, so (0.004/0.15)*(1+1) = 0.05333 is the loosest tolerance this predicate can EVER be scored with. At the fourth run's own deck-free band (0.27506) the propagated tolerance is 0.02129, and the under-dim the globe-path branch predicts (1.1261*F - F = 0.0585) is 2.75x it",
  ),

  shadowContrastRatio: band(
    0.97,
    1.03,
    "prediction (ii) verbatim: mix(1, 0.35, s) moves 0.350000 -> 0.350293, i.e. +0.084%. +/-3% is two orders of magnitude wider than the predicted move and is set by 8-bit quantization on a ground band, NOT by the effect. It is also the DISCRIMINATOR: the rejected design (shadow strength = S2's factor) puts the contrast at 1 - 0.65*0.769 = 0.5001 against an un-eclipsed 0.35 at the 0.5452 rung, a ratio of 1.429 — 14x outside this band. A measured move beyond it REFUTES the shipped model, exactly as the row asks. FIFTH-PASS EXTENSION (CO-17), and the band DOES NOT MOVE: the row named the ambient/direct split as the derivation that might justify moving it, and the derivation refutes its own hypothesis. The cast shadow is a MULTIPLY on the whole surface colour (GlobeTerrain.wgsl:4838), so only what is ADDED after that line is un-shadowable; C13-41 and C12-29 S2 dim every term on BOTH sides of that line by the SAME scalar, so the eclipse factor cancels out of the contrast entirely and the closed form is ratio = 1 + (s_1 - s_F)*(1 - c_clear)/(s_1*c_clear) with the split and the beer transmittance both cancelled against the MEASURED clear contrast — no free parameter to tune. At the fourth run's numbers that is 1.00021, which is 3.9x CLOSER to 1 than the directional-only 1.00084, because the residue DILUTES the move. The directional-only model is the SUPREMUM of the whole split family (attained at zero residue with tau at the beer floor), so no admissible split reaches 1.05 and the measured 1.0496 is 59x past the family's cap — a REAL finding, not a modelling gap. `shadowContrastModelIsBoundedByDirectional` gates that inequality; the band's headroom over the model went from 36x to 142x, which is a reason to keep it rather than widen it",
  ),

  iblDeepestRatio: band(
    0.3,
    0.85,
    "the model's displayed IBL brightness at obscuration 0.9 against its clear baseline. The cube is dimmed by the same 0.4642 factor pre-tonemap, so a linear display would read 0.464; the PBR-Neutral shoulder plus the SH projection of an already-dimmed cube compress that upward. The upper bound 0.85 requires a VISIBLE response (a leg that barely moves is the undimmed-IBL defect this row exists to fix); the lower bound 0.30 catches DOUBLE application — the SH step-3 multiply acquiring the factor as well would square it to 0.2155, which lands below this bound",
  ),

  iblRecoveryRatio: band(
    0.98,
    1.02,
    "the anti-latch assertion. After the sweep has been through the deep phase and back, the model's brightness at the SAME clear instant must return to its own baseline. +/-2% is capture noise on a static scene; the defect this catches (a one-way 'only re-fill when it got darker' gate) leaves the environment at ~0.46 of baseline, which is 27 band-widths away",
  ),

  engineRefreshCount: band(
    234,
    275,
    "the ENGINE's committed-bucket transition count. 275 is a HARD CEILING by construction: the managers commit the bucket only inside the branch that re-fills, and a bounded-refresh deferral (C11-193) can only MERGE two adjacent edges into one fill, never create one. The floor allows 15% of the 274 sweep edges to be merged. The exact-275 reading is reported separately (`engineRefreshCountExactReportedOnly`) so a merge is visible without being a false failure on a first run",
  ),

  sweepQuiescence: band(
    0.6,
    0.75,
    "the row's 'quiescent on roughly two thirds of an 801-frame sweep'. 274 of the 801 sweep frames change a bucket, so 527/801 = 0.658 are quiescent. The band is 0.658 -0.058/+0.092, wide enough to survive a handful of merged edges and narrow enough that a refresh EVERY frame (0.0) or a refresh NEVER (1.0) fails",
  ),

  controlRefreshCount: band(
    0,
    2,
    "the eclipse-OFF control over the identical 801-frame schedule. With the effect off the factor is exactly 1.0 on every frame, so the bucket sits at the identity 256 and commits at most once. Two is the allowance for the initial commit plus one resource-generation re-commit",
  ),

  determinismDelta: band(
    0,
    BAND_MEAN_CAPTURE_DELTA,
    "the repeat bracket: the first scored configuration re-captured at the end of the lane. 0.004 is ~1 eight-bit code value on a band mean — the smallest difference distinguishable at all. Set strictly INSIDE the tightest scored margin (lane B's +/-3% of a ~0.35 contrast is 0.0105), so a control PASS means residual capture noise cannot flip an assertion",
  ),

  factorTolerance: band(
    0,
    1e-9,
    "the published `eclipseSceneLightFactor` against this module's second implementation, and across backends. It is ONE CPU module evaluated on f64 inputs, so anything above f64 round-off is a real divergence",
  ),

  strengthTolerance: band(
    0,
    1e-9,
    "the published `shadowStrength` against `predictDirectional`. Same reasoning: one CPU expression, no shader involved",
  ),

  deckVacuityFloor: band(
    0.01,
    1,
    "the deck's own contribution (cloudsOn - cloudsOff) in the UN-eclipsed leg. Below 0.01 there is no deck in frame and every ratio computed from it is noise over noise — the `NEW-PROBE-VACUOUS-REACHABILITY-ASSERTION` class. STRUCTURAL, not a product failure",
  ),

  deckBackgroundCeiling: band(
    0,
    0.02,
    "the clouds-OFF band mean, i.e. whatever is BEHIND the deck. This is a PRECONDITION of the isolation, not a product claim, and it exists because the first Edge run measured a deck ratio of 2.937 — a number no deck can produce. The composite is `mix(sceneColor, deckColor, cloudAlpha)`, so `cloudsOn - cloudsOff` is `alpha * (H - S)`, NOT `alpha * H`: the background S survives the difference with a MINUS sign. It does not cancel between eclipse positions either, because the sky is tonemapped by the scene chain (Reinhard + inverseGamma) while the deck carries its OWN private Reinhard at `cloud.exposure` and composites AFTER the gamma stage, so the two dim at different DISPLAY rates. When H and S are close the denominator `H(1) - S(1)` collapses and the ratio diverges — which is exactly the 2.937 regime. The band's own [0.44, 0.70] window is `F*(1+e)/(1+F*e)` for e in [0,1] (0.4642 at e=0, 0.6341 at e=1 — the row's '0.46 faint / ~0.63 bright core' verbatim), i.e. it was DERIVED for the pure deck ratio H(F)/H(1). The probe therefore removes the background (sky shell, skybox, sun, moon, black clear) so S ~ 0 and the difference IS the deck; this ceiling is the read-back that proves it took. Above 0.02 the isolation assumption is false and the deck lane is STRUCTURAL — a ratio above 1.0 is unattainable for ANY deck model, dimmed or not, because the pre-tonemap radiance is exactly linear in the eclipse factor and Reinhard is monotone",
  ),

  shadowVacuityCeiling: band(
    0,
    0.98,
    "the un-eclipsed ground contrast (shadowOn / shadowOff). At or above 0.98 the cast shadow is not darkening the ground at all, so its invariance under an eclipse is unmeasurable. STRUCTURAL",
  ),

  shadowGroundBrightness: band(
    SHADOW_GROUND_BRIGHTNESS_FLOOR,
    1,
    "the DECK-FREE ground band mean, i.e. the brightness of the surface the cast shadow has to darken. This is a PRECONDITION, and it exists because the second Edge run's lane B was vacuous for a reason the ceiling above cannot express. The offline pin removes every imagery layer, so the globe renders `GlobeSurfaceTileProvider.baseColor`, whose default `new Color(0, 0, 0.5, 1)` has a Rec.709 luma of 0.036 BEFORE the Lambert term. The cast shadow floors the ground at `max(exp(-tau*0.04), 0.35)`, so it can remove at most 65% of whatever the ground contributes: at 0.036 that is 0.023 of a full band and the 0.98 ceiling is unreachable by construction. 0.15 is the floor at which a fully-shadowed ground band moves the contrast by 0.65*0.15 = 0.0975, 4.875x the 0.02 the ceiling asks for. STRUCTURAL, not a product failure",
  ),

  shadowGroundRetention: band(
    0.85,
    1.18,
    "`offNoShadow / offNoCloud` — the fraction of the scored ground band that survives turning the DECK on. The second Edge run flew lane B at 9000 m, ABOVE a 1500-4000 m deck, so the line of sight to the ground crossed it: fitting that run's own numbers gives ~70% opaque cloud and a ~1.8% ground share, and the 0.126% contrast it measured is ~11% of the visible ground fully shadowed — the cast shadow WAS working and the band could not see it. Flying below the deck floor makes the ratio ~1, and this band is that read-back. The window is deliberately two-sided: below 0.85 the deck has taken the band over, above 1.18 the deck is ADDING brightness to it (cloud tops in frame), and either way the band is not measuring ground. STRUCTURAL",
  ),

  iblVacuityFloor: band(
    0.05,
    1,
    "lit fraction of the model band in the clear baseline. Below 5% the model is not in frame (or is unlit) and the dim/recover ratios are noise. STRUCTURAL",
  ),
});

/**
 * The predicates that COMPOSE the verdict, in evaluation order.
 *
 * This list IS the gate: `judgeEclipseCloudResponse` folds it to produce PASS
 * and filters it to produce `failedPredicates`, so there is no second
 * hand-maintained conjunction that could disagree. Adding a name adds a gate;
 * removing one removes a gate. `eclipse-cloud-response-gate.spec.mjs` pins the
 * membership so neither happens by accident.
 */
export const ECLIPSE_CLOUD_GATE_PREDICATES = Object.freeze([
  // Lane A — deck lighting (prediction i)
  "cloudLaneIsWebGPU",
  "deckBackgroundIsDark",
  "deckNonVacuous",
  "offFactorExactlyOne",
  "factorMatchesSecondImplementation",
  "deckRatioInBand",
  "deckRatioMonotone",
  // Lane A diagnostic leg — the pure deck ratio at `cloudAerialStrength = 0`
  "deckPureRatioInBand",
  // Lane B — cloud shadow (prediction ii)
  "shadowGroundIsBright",
  "shadowGroundNotOccluded",
  "shadowNonVacuous",
  "offShadowStrengthExactlyOne",
  "shadowStrengthMatchesDirectional",
  "shadowContrastInvariant",
  "shadowContrastRejectsAlternativeDesign",
  "shadowContrastModelIsBoundedByDirectional",
  // Lane B attribution leg — the deck-free ground's own dimming law
  "deckFreeGroundDimsByFactor",
  // Lane C — IBL dim, refresh cadence, recovery (prediction iii)
  "predictedRefreshCountExact",
  "rampNeverSkipsABucket",
  "engineRefreshCountWebGPUInBand",
  "engineRefreshCountWebGLInBand",
  "controlRefreshQuiescent",
  "sweepQuiescenceInBand",
  "iblNonVacuous",
  "iblDimsAtDeepest",
  "iblRecovers",
  // Instrument health
  "determinismBracketHolds",
  "refreshCostMeasured",
]);

/** Cross-backend predicates, folded the same way. */
export const ECLIPSE_CLOUD_PARITY_PREDICATES = Object.freeze([
  "sweepFactorSeriesParity",
  "predictedRefreshCountParity",
]);

/**
 * Computed and reported, deliberately NOT gating, with the reason each may
 * legitimately read false.
 */
export const ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES = Object.freeze([
  // A C11-193 bounded-refresh deferral can merge two adjacent bucket edges
  // into a single fill. That is correct behaviour, not a defect, so the exact
  // reading is information rather than a verdict — the BAND gates.
  "engineRefreshCountExactReportedOnly",
  // The linear (untonemapped) comparison. Kept because it is the number the
  // row's 0.4642 actually names, but the capture is post-tonemap so it cannot
  // gate — the same lesson `probe-eclipse-scene-dimming` learned over four
  // rounds of trying to predict a saturating display transform.
  "deckRatioMatchesLinearReportedOnly",
  // CO-17. The ambient/direct-split model's own agreement with the measurement.
  // It reads FALSE on the fourth run's numbers BY DESIGN — that disagreement IS
  // `C13-41-SHADOW-CONTRAST-ECLIPSE-EXCESS`, and it is already carried by the
  // gating `shadowContrastInvariant`. Gating it too would score one finding
  // twice. Read `shadowContrastModel` for the per-rung arithmetic.
  "shadowContrastMatchesSplitModelReportedOnly",
  // CO-17. Whether the fitted deck tonemap entry sits inside the design
  // envelope `deckDisplayedRatio` was derived for. NOT gating because the fit
  // needs the aerial share, which a single run can only supply by subtraction
  // against a PREVIOUS run — a cross-run input has no place in a gate. The
  // fifth run's `cloudAerialStrength = 0` leg makes it a single-run number.
  "deckTonemapEntryWithinDesignEnvelopeReportedOnly",
  // CO-19. THE INSTRUMENT TELL, and it is reported-only on purpose. The fourth
  // run's `offNoCloud` read bit-identical 0.2750603921572111 at ALL FOUR rungs,
  // across instants 54 minutes apart, while `offNoShadow` at the same instants
  // moved +3.3%. The lane's camera is sun-locked in HEADING only, so the local
  // sun ELEVATION does change and a deck-free ground band should move with it.
  // Either it is genuinely invariant for a reason worth knowing or it is not
  // being re-captured per rung — and a fifth run that still reads four
  // identical f64s becomes its own instrument investigation rather than a
  // product verdict, which is exactly why this does not gate.
  "offNoCloudVariesWithSun",
]);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PER-LANE STRUCTURAL SCOPING — a blind lane quarantines only ITS OWN gates
 * ─────────────────────────────────────────────────────────────────────────────
 * The first Edge run (Batch 908) exposed the defect this map exists to fix. The
 * shadow lane went vacuous (un-eclipsed ground contrast 0.9969 against the 0.98
 * floor) and the old fold demoted EVERY gate to unscored, so `failedPredicates`
 * printed `[]` while `deckRatioInBand` was false at 2.937 — a 3x out-of-band
 * deck reading reported as "no product verdict at all".
 *
 * A blind lane certifies nothing about ITS OWN subject. It says nothing
 * whatsoever about the others, and suppressing their verdicts is not caution,
 * it is data loss. Each gating predicate therefore declares the BLINDNESS
 * DOMAIN it is measured in, and domains NEST — blinding a parent blinds its
 * children:
 *
 *   gate-arithmetic   never blind. Derived inside this module from the
 *                     published constants with no run input at all.
 *   cloud-page        the WebGPU cloud page ran and resolved the WebGPU
 *                     backend. Covers the CPU-published reads
 *                     (`eclipseSceneLightFactor`, `_cloudCache.shadowStrength`)
 *                     and the determinism bracket — none of which need a deck
 *                     or a shadow to be VISIBLE, only the page to have run.
 *   deck   (child)    the deck difference image `cloudsOn - cloudsOff` carries
 *                     real signal.
 *   shadow (child)    the cast shadow actually darkens the ground.
 *   ibl-page          both IBL lanes ran. Covers the refresh counters, the
 *                     quiescence fold and the wall-clock cost — counter and
 *                     clock reads rather than pixels.
 *   ibl-model (child) the model band is lit and in frame.
 *
 * The vacuity DETECTOR for a domain lives IN that domain, so a vacuous lane
 * reports ONE structural reason rather than a structural reason plus a derived
 * FAIL restating it.
 */
export const ECLIPSE_CLOUD_LANE_PARENTS = Object.freeze({
  "gate-arithmetic": null,
  "cloud-page": null,
  deck: "cloud-page",
  shadow: "cloud-page",
  "ibl-page": null,
  "ibl-model": "ibl-page",
});

/** Every gating predicate's blindness domain. Membership is spec-pinned. */
export const ECLIPSE_CLOUD_PREDICATE_LANES = Object.freeze({
  // Lane A — deck lighting (prediction i)
  cloudLaneIsWebGPU: "cloud-page",
  deckBackgroundIsDark: "deck",
  deckNonVacuous: "deck",
  offFactorExactlyOne: "cloud-page",
  factorMatchesSecondImplementation: "cloud-page",
  deckRatioInBand: "deck",
  deckRatioMonotone: "deck",
  // The `cloudAerialStrength = 0` leg is a DECK measurement — it is the same
  // difference image with one shader term removed, so everything that blinds
  // the deck blinds it too. A leg that is simply ABSENT is deliberately NOT
  // structural: the probe captures it unconditionally, so a null here is an
  // instrument defect and must surface as a named FAIL rather than quietly
  // quarantining the deck lane's other verdicts.
  deckPureRatioInBand: "deck",
  // Lane B — cloud shadow (prediction ii)
  shadowGroundIsBright: "shadow",
  shadowGroundNotOccluded: "shadow",
  shadowNonVacuous: "shadow",
  offShadowStrengthExactlyOne: "cloud-page",
  shadowStrengthMatchesDirectional: "cloud-page",
  shadowContrastInvariant: "shadow",
  shadowContrastRejectsAlternativeDesign: "shadow",
  // The split model's bound on itself: derived inside this module from the
  // published laws with no run input, so it is never quarantined — the same
  // domain, and for the same reason, as `predictedRefreshCountExact`.
  shadowContrastModelIsBoundedByDirectional: "gate-arithmetic",
  // The deck-free attribution leg reads lane B's own ground band, and its
  // precondition (`shadowGroundIsBright`, the band mean the tolerance is
  // propagated from) lives in the same domain. Scoring an attribution over a
  // band too dark to carry one certifies nothing.
  deckFreeGroundDimsByFactor: "shadow",
  // Lane C — IBL dim, refresh cadence, recovery (prediction iii)
  predictedRefreshCountExact: "gate-arithmetic",
  rampNeverSkipsABucket: "ibl-page",
  engineRefreshCountWebGPUInBand: "ibl-page",
  engineRefreshCountWebGLInBand: "ibl-page",
  controlRefreshQuiescent: "ibl-page",
  sweepQuiescenceInBand: "ibl-page",
  iblNonVacuous: "ibl-model",
  iblDimsAtDeepest: "ibl-model",
  iblRecovers: "ibl-model",
  // Instrument health
  determinismBracketHolds: "cloud-page",
  refreshCostMeasured: "ibl-page",
});

/** Both cross-backend predicates compare the two IBL lanes. */
export const ECLIPSE_CLOUD_PARITY_LANE = "ibl-page";

/**
 * Resolves a domain to blind/not-blind through the parent chain. Bounded by the
 * depth of `ECLIPSE_CLOUD_LANE_PARENTS`, and defensively by a step cap so a
 * mis-edited parent map cannot spin.
 *
 * @param {object} blind `{ domain: [reason, ...] }`
 * @param {string} domain
 * @returns {boolean}
 */
export function laneIsBlind(blind, domain) {
  let current = domain;
  for (let depth = 0; depth < 8 && current; depth++) {
    if ((blind[current]?.length ?? 0) > 0) {
      return true;
    }
    current = ECLIPSE_CLOUD_LANE_PARENTS[current] ?? null;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE REFRESH-COST ARITHMETIC (C13-41-ECLIPSE-REFRESH-COST-UNMEASURED)
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THIS IS A FUNCTION AND NOT THREE LINES INSIDE THE FOLD. The first run's
// cost leg produced -18.9 ms/refresh: the eclipse leg ran FIRST at 0.77 s and
// the control leg ran SECOND at 5.97 s, so the differential `sweep - control`
// was dominated by whatever the second leg paid that the first did not. A
// wall-clock A/B whose two legs do not pay the same warm-up is not a
// measurement, and the fleet already learned this for GPU timing (Batch 762's
// mandatory interleaved-A/B protocol). The instrument's answer is structural:
//
//   1. BOTH legs run a DISCARDED warm-up segment before either is timed;
//   2. the two legs are INTERLEAVED in segments over one schedule, so any
//      monotone drift (thermal, cache, GC) lands on both in equal measure;
//   3. the estimate is either non-negative or explicitly INVALID with a named
//      reason — a negative number is never reported as if it were a cost.
//
// This function owns rule 3 and VERIFIES rules 1 and 2 from the accounting the
// lane hands in, so a probe that quietly stops interleaving fails here rather
// than reporting a plausible-looking number.

/** Minimum interleaved segments per leg. Two legs of one segment each is just
 * the sequential design that produced the negative reading. */
export const REFRESH_COST_MIN_SEGMENTS_PER_LEG = 3;

/**
 * @param {object} accounting The lane's `refreshCost` accounting.
 * @returns {object} `{ valid, msPerRefresh, invalidReason, ... }`
 */
export function computeRefreshCost(accounting) {
  const base = {
    valid: false,
    msPerRefresh: null,
    invalidReason: null,
    msDelta: null,
    fillDelta: null,
    eclipseWallMs: null,
    controlWallMs: null,
    eclipseFills: null,
    controlFills: null,
    eclipseFrames: null,
    controlFrames: null,
    segmentsPerLeg: null,
    warmupBothLegs: null,
  };
  const a = accounting;
  if (!a || typeof a !== "object") {
    return {
      ...base,
      invalidReason:
        "the lane reported no refresh-cost accounting — the interleaved legs did not run",
    };
  }

  const out = {
    ...base,
    eclipseWallMs: Number.isFinite(a.eclipseWallMs) ? a.eclipseWallMs : null,
    controlWallMs: Number.isFinite(a.controlWallMs) ? a.controlWallMs : null,
    eclipseFills: Number.isFinite(a.eclipseFills) ? a.eclipseFills : null,
    controlFills: Number.isFinite(a.controlFills) ? a.controlFills : null,
    eclipseFrames: Number.isFinite(a.eclipseFrames) ? a.eclipseFrames : null,
    controlFrames: Number.isFinite(a.controlFrames) ? a.controlFrames : null,
    segmentsPerLeg: Number.isFinite(a.segmentsPerLeg) ? a.segmentsPerLeg : null,
    warmupBothLegs: a.warmupBothLegs === true,
  };

  // RULE 1 — warm-up parity. This is the named cause of the first run's
  // negative reading, so its absence is its own reason rather than a generic
  // "invalid".
  if (out.warmupBothLegs !== true) {
    return {
      ...out,
      invalidReason:
        "warm-up parity was not established — only one leg paid the first-touch cost, which is exactly the asymmetry that produced the first run's negative per-refresh",
    };
  }

  // RULE 2 — interleaving. A single segment per leg is the sequential design.
  if (!(out.segmentsPerLeg >= REFRESH_COST_MIN_SEGMENTS_PER_LEG)) {
    return {
      ...out,
      invalidReason: `the legs were not interleaved (${out.segmentsPerLeg} segment(s) per leg, minimum ${REFRESH_COST_MIN_SEGMENTS_PER_LEG}) — a sequential A/B attributes drift to the effect`,
    };
  }
  if (out.eclipseFrames !== out.controlFrames) {
    return {
      ...out,
      invalidReason: `the two legs rendered different frame counts (${out.eclipseFrames} eclipse vs ${out.controlFrames} control) — everything except the fills no longer cancels`,
    };
  }
  if (!(out.eclipseFrames > 0)) {
    return {
      ...out,
      invalidReason: "neither leg rendered a frame",
    };
  }

  const fillDelta = out.eclipseFills - out.controlFills;
  if (!Number.isFinite(fillDelta) || !(fillDelta > 0)) {
    return {
      ...out,
      fillDelta: Number.isFinite(fillDelta) ? fillDelta : null,
      invalidReason: `no eclipse-driven fills to attribute cost to (${out.eclipseFills} eclipse vs ${out.controlFills} control) — the differential cannot be formed and the row does NOT discharge`,
    };
  }

  const msDelta = out.eclipseWallMs - out.controlWallMs;
  if (!Number.isFinite(msDelta)) {
    return {
      ...out,
      fillDelta,
      invalidReason: "a leg reported no wall clock",
    };
  }
  // RULE 3 — non-negative or INVALID. A negative differential means the control
  // leg outran the eclipse leg, i.e. something other than the fills dominated;
  // reporting `msDelta / fillDelta` there would publish a negative cost as a
  // measurement, which is what the first run did.
  if (msDelta < 0) {
    return {
      ...out,
      fillDelta,
      msDelta,
      invalidReason: `the control leg outran the eclipse leg (${out.controlWallMs} ms control vs ${out.eclipseWallMs} ms eclipse over the same ${out.eclipseFrames} frames) — the differential is negative, so no per-refresh cost can be attributed to the fills`,
    };
  }

  return {
    ...out,
    fillDelta,
    msDelta,
    msPerRefresh: msDelta / fillDelta,
    valid: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE EXIT CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
//
// 0 PASS / 1 FAIL / 2 harness fault (watchdog or throw) / 3 STRUCTURAL.
//
// The first run printed EXIT 2 on a STRUCTURAL verdict, which collides with the
// watchdog's own code — a reader cannot tell a probe that refused to certify
// from a probe that never finished. The mapping lives here, as a pure function
// over the verdict, so the spec can pin it directly instead of regex-matching a
// ternary in the driver.
//
// FAIL outranks STRUCTURAL deliberately: with per-lane scoping a run can carry
// both a quarantined lane and a real failure in an evaluable one, and the real
// failure is the actionable half.
export const ECLIPSE_CLOUD_EXIT = Object.freeze({
  PASS: 0,
  FAIL: 1,
  HARNESS: 2,
  STRUCTURAL: 3,
});

/**
 * @param {object} outcome `{ harnessFault, structuralReasons, failedPredicates, parityFailed }`
 * @returns {number}
 */
export function eclipseCloudExitCode(outcome) {
  const o = outcome ?? {};
  if (o.harnessFault === true) {
    return ECLIPSE_CLOUD_EXIT.HARNESS;
  }
  const failures =
    (o.failedPredicates?.length ?? 0) + (o.parityFailed?.length ?? 0);
  if (failures > 0) {
    return ECLIPSE_CLOUD_EXIT.FAIL;
  }
  if ((o.structuralReasons?.length ?? 0) > 0) {
    return ECLIPSE_CLOUD_EXIT.STRUCTURAL;
  }
  return ECLIPSE_CLOUD_EXIT.PASS;
}

/**
 * The one-word label that must agree with `eclipseCloudExitCode`.
 *
 * @param {object} outcome
 * @returns {string}
 */
export function eclipseCloudGateLabel(outcome) {
  switch (eclipseCloudExitCode(outcome)) {
    case ECLIPSE_CLOUD_EXIT.PASS:
      return "PASS";
    case ECLIPSE_CLOUD_EXIT.FAIL:
      return "FAIL";
    case ECLIPSE_CLOUD_EXIT.HARNESS:
      return "HARNESS FAULT";
    default:
      return "STRUCTURAL";
  }
}

const inBand = (value, b) =>
  Number.isFinite(value) && value >= b.lo && value <= b.hi;

const ratio = (a, b) =>
  Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null;

/**
 * Folds one run's measurements into the verdict.
 *
 * A missing lane, a vacuous measurement or a backend mismatch is STRUCTURAL —
 * never a product FAIL. A gate verdict over a measurement that could not have
 * seen its subject certifies nothing, and this fleet has re-learned that often
 * enough for it to be a rule.
 *
 * SCOPING (Batch 909, from the first run's evidence): the quarantine is
 * PER-LANE. A blind lane's own predicates go UNSCORED and are named in
 * `unscoredPredicates`; every other lane still gates, and its failures are
 * FAILURES. See `ECLIPSE_CLOUD_PREDICATE_LANES` for the domain map and the
 * defect that forced it.
 *
 * @param {object} run
 * @param {object} run.cloudLanes WebGPU lanes A + B.
 * @param {object} run.iblWebGPU Lane C on WebGPU.
 * @param {object} run.iblWebGL Lane C on WebGL.
 */
export function judgeEclipseCloudResponse(run) {
  const v = {};
  const structuralReasons = [];
  const blind = {};
  const B = ECLIPSE_CLOUD_BANDS;
  const cloud = run?.cloudLanes ?? {};
  const gpu = run?.iblWebGPU ?? {};
  const gl = run?.iblWebGL ?? {};

  /** Blind one domain and record the reason once, in both places. */
  const markBlind = (domain, reason) => {
    (blind[domain] ??= []).push(reason);
    structuralReasons.push(reason);
  };
  const isBlind = (domain) => laneIsBlind(blind, domain);

  // ── Lane presence. A page that never ran blinds the domains it owns and
  // NOTHING else — the other pages' measurements are untouched by it.
  for (const [name, lane, domain] of [
    ["webgpu-cloud", run?.cloudLanes, "cloud-page"],
    ["webgpu-ibl", run?.iblWebGPU, "ibl-page"],
    ["webgl-ibl", run?.iblWebGL, "ibl-page"],
  ]) {
    if (!lane || lane.structuralError) {
      markBlind(
        domain,
        `${name}: ${lane?.structuralError ?? "lane did not run"}`,
      );
    }
  }

  const rungs = cloud.rungs ?? [];
  const deepest = rungs[rungs.length - 1];
  // The rung whose obscuration is closest to 0.5452 — where the REJECTED
  // design peaks and this band's discrimination is widest.
  const discriminating = rungs.reduce((best, rung) => {
    const d = Math.abs((rung.published?.moonObscuration ?? 0) - 0.5452);
    const bd = Math.abs((best?.published?.moonObscuration ?? 0) - 0.5452);
    return best === undefined || d < bd ? rung : best;
  }, undefined);

  // ── Backend resolution blinds the whole cloud PAGE (both lanes A and B). ──
  if (!isBlind("cloud-page")) {
    v.cloudLaneIsWebGPU = cloud.rendererType === "webgpu";
    if (!v.cloudLaneIsWebGPU) {
      markBlind(
        "cloud-page",
        `webgpu-cloud: rendererType resolved "${cloud.rendererType}", not webgpu`,
      );
    }
  }

  // ── Vacuity, checked BEFORE any ratio is scored, and scoped to ONE lane ──
  // Each detector is evaluated only if its own page ran, and blinds only its
  // own domain. The deck going vacuous says nothing about the shadow, and the
  // shadow going vacuous says nothing about the deck — that conflation is the
  // exact defect the first Edge run exposed.
  v.deckContributionOff = deepest?.deck?.offContribution ?? null;
  if (!isBlind("cloud-page")) {
    // ISOLATION PRECONDITION, checked before the vacuity floor: the difference
    // `cloudsOn - cloudsOff` is only the deck when there is nothing behind it.
    // See `deckBackgroundCeiling.why` for the arithmetic and for why the first
    // run's 2.937 is unattainable by any deck.
    v.deckBackgroundMax = rungs.reduce((worst, rung) => {
      const values = [rung.deck?.offBare, rung.deck?.onBare].filter((value) =>
        Number.isFinite(value),
      );
      return values.length === 0 ? worst : Math.max(worst, ...values);
    }, 0);
    v.deckBackgroundIsDark =
      rungs.length > 0 &&
      rungs.every(
        (rung) =>
          inBand(rung.deck?.offBare, B.deckBackgroundCeiling) &&
          inBand(rung.deck?.onBare, B.deckBackgroundCeiling),
      );
    if (!v.deckBackgroundIsDark) {
      markBlind(
        "deck",
        `the clouds-off background reads ${v.deckBackgroundMax} against the ${B.deckBackgroundCeiling.hi} isolation ceiling — the difference image carries a background term, so the ratio is (H-S)/(H-S) and not the deck's own H(F)/H(1)`,
      );
    }
    v.deckNonVacuous =
      rungs.length > 0 &&
      rungs.every((rung) =>
        inBand(rung.deck?.offContribution, B.deckVacuityFloor),
      );
    if (!v.deckNonVacuous) {
      markBlind(
        "deck",
        `deck contribution below the vacuity floor ${B.deckVacuityFloor.lo} on at least one rung — no deck in frame`,
      );
    }
    // PHOTOMETRIC PRECONDITIONS, checked BEFORE the contrast ceiling and in this
    // order, because each one bounds what the ceiling can possibly read. A dark
    // ground caps the achievable contrast move at `0.65 * groundShare`; a deck
    // sitting in the band caps `groundShare` itself. Both were true of the
    // second Edge run, and the ceiling could only report the SYMPTOM.
    v.shadowGroundOnly = rungs[0]?.shadow?.offNoCloud ?? null;
    v.shadowGroundIsBright = inBand(
      v.shadowGroundOnly,
      B.shadowGroundBrightness,
    );
    if (!v.shadowGroundIsBright) {
      markBlind(
        "shadow",
        `the deck-free ground band reads ${v.shadowGroundOnly} against the ${B.shadowGroundBrightness.lo} brightness floor — the cast shadow's 0.35 beer floor can remove at most 65% of that, so the ${B.shadowVacuityCeiling.hi} contrast ceiling is unreachable however well the shadow works`,
      );
    }
    v.shadowGroundRetentionRatio = ratio(
      rungs[0]?.shadow?.offNoShadow,
      rungs[0]?.shadow?.offNoCloud,
    );
    v.shadowGroundNotOccluded = inBand(
      v.shadowGroundRetentionRatio,
      B.shadowGroundRetention,
    );
    if (!v.shadowGroundNotOccluded) {
      markBlind(
        "shadow",
        `turning the deck on moves the ground band by ${v.shadowGroundRetentionRatio}x (outside [${B.shadowGroundRetention.lo}, ${B.shadowGroundRetention.hi}]) — the scored band is not the ground, so its contrast is not the cast shadow's`,
      );
    }
    v.shadowContrastClear = ratio(
      rungs[0]?.shadow?.offShadow,
      rungs[0]?.shadow?.offNoShadow,
    );
    v.shadowNonVacuous =
      Number.isFinite(v.shadowContrastClear) &&
      v.shadowContrastClear <= B.shadowVacuityCeiling.hi &&
      v.shadowContrastClear > 0;
    if (!v.shadowNonVacuous) {
      markBlind(
        "shadow",
        `un-eclipsed ground contrast ${v.shadowContrastClear} is not below ${B.shadowVacuityCeiling.hi} — the cast shadow is not darkening the ground`,
      );
    }
  }
  if (!isBlind("ibl-page")) {
    v.iblNonVacuous =
      inBand(gpu.ibl?.baseline?.litFraction, B.iblVacuityFloor) &&
      inBand(gl.ibl?.baseline?.litFraction, B.iblVacuityFloor);
    if (!v.iblNonVacuous) {
      markBlind(
        "ibl-model",
        "the IBL model band is unlit or out of frame on at least one backend",
      );
    }
  }

  // ── Lane A: prediction (i) ───────────────────────────────────────────────
  v.offFactorExactlyOne = rungs.every(
    (rung) => rung.publishedOff?.factor === 1,
  );
  v.factorMatchesSecondImplementation = rungs.every((rung) => {
    const measured = rung.published?.factor;
    const expected = predictFactor(rung.published?.moonObscuration ?? 0);
    return (
      Number.isFinite(measured) &&
      Math.abs(measured - expected) <= B.factorTolerance.hi
    );
  });
  v.deckRatios = rungs.map((rung) =>
    ratio(rung.deck?.onContribution, rung.deck?.offContribution),
  );
  v.deckRatioAtDeepest = v.deckRatios[v.deckRatios.length - 1];
  v.deckRatioInBand = inBand(v.deckRatioAtDeepest, B.deckDisplayedRatio);
  // Monotone in the eclipse's depth: each successive rung must not be BRIGHTER
  // than the previous one. A small tolerance absorbs 8-bit noise on a
  // difference image without admitting a real inversion.
  v.deckRatioMonotone = v.deckRatios.every(
    (value, index) =>
      index === 0 ||
      (Number.isFinite(value) && value <= v.deckRatios[index - 1] + 0.02),
  );
  v.deckRatioMatchesLinearReportedOnly =
    Number.isFinite(v.deckRatioAtDeepest) &&
    Math.abs(
      v.deckRatioAtDeepest -
        predictFactor(deepest?.published?.moonObscuration ?? 0),
    ) <= 0.02;

  // ── THE `cloudAerialStrength = 0` DIAGNOSTIC LEG (CO-19) ─────────────────
  // Pre-registered by CO-17 as the one measurement that pins the deck's display
  // transform with NO cross-run input. Zeroing float 91 removes the aerial tint
  // entirely, so that leg's own `cloudsOn - cloudsOff` difference IS the pure
  // deck ratio rho = F(1+e)/(1+F*e) — the exact quantity `deckDisplayedRatio`'s
  // [0.44, 0.70] window was derived for — and `e` reads off ONE measurement.
  //
  // The tint's share then falls out of the SAME run by subtraction against the
  // composited ratio measured at the same instant, s = (rho - R)/(rho - F). The
  // derivation lives HERE rather than in the lane because `page.evaluate`
  // cannot import this module, and a formula duplicated across the
  // serialization boundary is a drift this fleet has already paid for once. An
  // explicit `cloudLanes.deckAerialShare` still wins, so a lane (or a fixture)
  // that supplies its own share is not locked out.
  const aerialZero = deepest?.deckAerialZero ?? null;
  v.deckPureRatio = ratio(
    aerialZero?.onContribution,
    aerialZero?.offContribution,
  );
  v.deckPureRatioInBand = inBand(v.deckPureRatio, B.deckPureDeckRatio);
  v.deckAerialShareSingleRun = fitDeckAerialShareFromPureDeck(
    deepest?.published?.factor,
    v.deckRatioAtDeepest,
    v.deckPureRatio,
  );
  // `e` straight off the tint-free leg, with no share involved at all — the
  // number the pre-registration is really about.
  v.deckTonemapEntryFromPureLeg = fitDeckTonemapEntry(
    deepest?.published?.factor,
    v.deckPureRatio,
    0,
  );

  // ── Lane B: prediction (ii), and its refutation control ──────────────────
  v.offShadowStrengthExactlyOne = rungs.every(
    (rung) => rung.publishedOff?.shadowStrength === 1,
  );
  v.shadowStrengthMatchesDirectional = rungs.every((rung) => {
    const measured = rung.published?.shadowStrength;
    const expected = predictDirectional(rung.published?.moonObscuration ?? 0);
    return (
      Number.isFinite(measured) &&
      Math.abs(measured - expected) <= B.strengthTolerance.hi
    );
  });
  const contrastRatioAt = (rung) => {
    const on = ratio(rung?.shadow?.onShadow, rung?.shadow?.onNoShadow);
    const off = ratio(rung?.shadow?.offShadow, rung?.shadow?.offNoShadow);
    return ratio(on, off);
  };
  v.shadowContrastRatioAtDeepest = contrastRatioAt(deepest);
  v.shadowContrastRatioAtDiscriminating = contrastRatioAt(discriminating);
  v.shadowContrastInvariant = inBand(
    v.shadowContrastRatioAtDeepest,
    B.shadowContrastRatio,
  );
  // The REJECTED design's prediction at the discriminating rung, computed here
  // so the report carries the number the band is excluding rather than a bare
  // boolean. `s = F` instead of `s = Fd`.
  const discriminatingObscuration =
    discriminating?.published?.moonObscuration ?? 0;
  v.rejectedDesignContrastRatio =
    shadowContrast(predictFactor(discriminatingObscuration)) /
    shadowContrast(1.0);
  v.shadowContrastRejectsAlternativeDesign =
    inBand(v.shadowContrastRatioAtDiscriminating, B.shadowContrastRatio) &&
    !inBand(v.rejectedDesignContrastRatio, B.shadowContrastRatio);
  // The extension is an arithmetic property of the model, not of this run.
  v.shadowContrastModelIsBoundedByDirectional =
    shadowContrastModelIsBoundedByDirectional();

  // ── THE DECK-FREE ATTRIBUTION LEG (CO-19) ────────────────────────────────
  // `onNoCloud / offNoCloud` against the published factor, per rung. See the
  // derivation above `deckFreeGroundDimTolerance` for what each verdict means:
  // == F exonerates the globe's own light path and makes CO-17's under-dimming
  // residue CLOUD-DRIVEN; > F indicts the globe path and exonerates the cloud
  // subsystem. The tolerance is PROPAGATED from the band mean each ratio was
  // measured on, not chosen.
  v.deckFreeGroundDim = rungs.map((rung) => {
    const off = rung.shadow?.offNoCloud;
    const on = rung.shadow?.onNoCloud;
    const factor = rung.published?.factor;
    const measured = ratio(on, off);
    const tolerance = deckFreeGroundDimTolerance(off, measured);
    const delta =
      Number.isFinite(measured) && Number.isFinite(factor)
        ? measured - factor
        : null;
    return {
      obscuration: rung.published?.moonObscuration ?? null,
      factor: factor ?? null,
      offNoCloud: Number.isFinite(off) ? off : null,
      onNoCloud: Number.isFinite(on) ? on : null,
      measured,
      tolerance,
      delta,
      // The headline: what fraction of F the deck-free band actually retained.
      // 1.0 is the published law; CO-17 measured 1.126 with the deck ON.
      overFactor: ratio(measured, factor),
      withinTolerance:
        delta !== null &&
        Number.isFinite(tolerance) &&
        Math.abs(delta) <= tolerance,
    };
  });
  v.deckFreeGroundDimsByFactor =
    v.deckFreeGroundDim.length > 0 &&
    v.deckFreeGroundDim.every((entry) => entry.withinTolerance === true);
  v.deckFreeGroundExcessAtDeepest =
    v.deckFreeGroundDim[v.deckFreeGroundDim.length - 1]?.overFactor ?? null;

  // ── THE INSTRUMENT TELL, reported not gated (CO-19) ──────────────────────
  // The fourth run's `offNoCloud` read bit-identical at all four rungs across
  // instants 54 minutes apart while `offNoShadow` moved +3.3% over the same
  // span. Both series are published so the comparison is on the page rather
  // than in a reader's head, and `offNoCloudVariesWithSun` is the tell in one
  // boolean: four identical f64s cannot be four independent captures of a
  // sun-lit band at four different sun elevations.
  const finite = (series) => series.filter((value) => Number.isFinite(value));
  const spread = (series) => {
    const values = finite(series);
    return values.length > 0 ? Math.max(...values) - Math.min(...values) : null;
  };
  v.offNoCloudSeries = rungs.map((rung) => rung.shadow?.offNoCloud ?? null);
  v.offNoShadowSeries = rungs.map((rung) => rung.shadow?.offNoShadow ?? null);
  v.offNoCloudSpread = spread(v.offNoCloudSeries);
  v.offNoShadowSpread = spread(v.offNoShadowSeries);
  v.offNoCloudVariesWithSun =
    finite(v.offNoCloudSeries).length > 1 &&
    new Set(finite(v.offNoCloudSeries)).size > 1;

  // ── THE AMBIENT/DIRECT SPLIT, per rung — reported, not gated (CO-17) ──────
  // See the derivation block above `predictShadowContrastRatio`. Three columns
  // per rung, and between them they say WHERE the excess lives:
  //   `predicted`  the split model's closed form. No free parameter.
  //   `supremum`   the directional-only model, i.e. the split family's cap.
  //   `groundDimming` what each band ACTUALLY did against the published factor —
  //                   under the published laws both must read exactly 1.0.
  // `shadowable` inverts the four reads for the law the shadowable term followed;
  // it reading ~1.0 while `unshadowed`/`shadowed` read >1.0 is what localises the
  // under-dim to the residue the cast shadow cannot touch.
  v.shadowContrastModel = rungs.map((rung) => {
    const clearContrast = ratio(
      rung.shadow?.offShadow,
      rung.shadow?.offNoShadow,
    );
    const strengthEclipse = rung.published?.shadowStrength;
    const strengthClear = rung.publishedOff?.shadowStrength;
    const factor = rung.published?.factor;
    const shadowable = extractShadowableDimming(rung.shadow);
    const unshadowed = ratio(rung.shadow?.onNoShadow, rung.shadow?.offNoShadow);
    const shadowed = ratio(rung.shadow?.onShadow, rung.shadow?.offShadow);
    return {
      obscuration: rung.published?.moonObscuration ?? null,
      factor: factor ?? null,
      clearContrast,
      measured: contrastRatioAt(rung),
      predicted: predictShadowContrastRatio({
        strengthClear,
        strengthEclipse,
        clearContrast,
      }),
      supremum: Number.isFinite(strengthEclipse)
        ? shadowContrastRatioSupremum(strengthEclipse, strengthClear ?? 1)
        : null,
      groundDimming: {
        unshadowed,
        shadowed,
        shadowable,
        unshadowedOverFactor: ratio(unshadowed, factor),
        shadowedOverFactor: ratio(shadowed, factor),
        shadowableOverFactor: ratio(shadowable, factor),
      },
    };
  });
  // Agreement within the determinism bracket, which is the tightest difference
  // this instrument can resolve at all. FALSE on the fourth run's numbers by
  // design — see the reported-only list for why it does not gate.
  v.shadowContrastMatchesSplitModelReportedOnly =
    v.shadowContrastModel.length > 0 &&
    v.shadowContrastModel.every(
      (entry) =>
        Number.isFinite(entry.measured) &&
        Number.isFinite(entry.predicted) &&
        Math.abs(entry.measured - entry.predicted) <= B.determinismDelta.hi,
    );

  // ── THE DECK'S TONEMAP ENTRY, re-fitted — reported, not gated (CO-17) ─────
  // The aerial share cannot be read from a single run (the tint is dimmed on
  // BOTH legs of this one), so the fit consumes the share the lane hands in,
  // whether that came from a `cloudAerialStrength = 0` diagnostic leg or from a
  // cross-run subtraction. With no share supplied the fit degenerates to the
  // single-term form — which is exactly the inversion the third pass performed,
  // and it is kept reachable so its e ~ 7.7 can be reproduced and shown to be an
  // artefact of the undimmed addend rather than a property of the tonemap.
  const laneShare = Number.isFinite(cloud.deckAerialShare)
    ? cloud.deckAerialShare
    : null;
  // CO-19: the `cloudAerialStrength = 0` leg makes the share a SINGLE-RUN
  // number, so it outranks the cross-run constant whenever the leg ran. The
  // precedence is explicit rather than incidental — an explicitly supplied
  // share still wins over both, because a caller that states one is asserting
  // something the leg cannot contradict.
  const singleRunShare = v.deckAerialShareSingleRun ?? null;
  const fittedShare =
    laneShare ?? singleRunShare ?? DECK_AERIAL_SHARE_CROSS_RUN;
  v.deckTonemapFit = {
    aerialShare: fittedShare,
    aerialShareSource:
      laneShare !== null
        ? "lane-supplied (a cloudAerialStrength = 0 diagnostic leg)"
        : singleRunShare !== null
          ? `single-run subtraction against this run's own cloudAerialStrength = 0 leg: s = (rho - R)/(rho - F) = (${v.deckPureRatio} - ${v.deckRatioAtDeepest})/(${v.deckPureRatio} - ${deepest?.published?.factor})`
          : `cross-run subtraction, ${DECK_AERIAL_SHARE_CROSS_RUN_PROVENANCE}`,
    // The scaffolding half: a lane that runs the tint-free leg hands its own
    // share in and this stops being a cross-run number. Kept reachable rather
    // than assumed absent — Principle 7.
    laneSuppliedShare: laneShare,
    singleRunShare,
    entries: rungs.map((rung) => {
      const factor = rung.published?.factor;
      const measured = ratio(
        rung.deck?.onContribution,
        rung.deck?.offContribution,
      );
      const tonemapEntry = fitDeckTonemapEntry(factor, measured, fittedShare);
      return {
        obscuration: rung.published?.moonObscuration ?? null,
        factor: factor ?? null,
        measured,
        tonemapEntry,
        // The pure-deck (tint-free) ratio the fitted entry implies — the
        // quantity `deckDisplayedRatio`'s [0.44, 0.70] window was derived for.
        pureDeckRatio: Number.isFinite(tonemapEntry)
          ? deckDisplayedRatio(factor, tonemapEntry, 0)
          : null,
        // The THIRD PASS's inversion, reproduced: the same measurement charged
        // entirely to the tonemap with no addend term at all. Reported so the
        // e ~ 7.7 reading is visible as a modelling choice rather than a
        // property of the shader.
        tonemapEntrySingleTerm: fitDeckTonemapEntry(factor, measured, 0),
      };
    }),
  };
  v.deckTonemapEntryAtDeepest =
    v.deckTonemapFit.entries[v.deckTonemapFit.entries.length - 1]
      ?.tonemapEntry ?? null;
  v.deckTonemapEntryWithinDesignEnvelopeReportedOnly =
    Number.isFinite(v.deckTonemapEntryAtDeepest) &&
    v.deckTonemapEntryAtDeepest <= DECK_TONEMAP_ENTRY_CEILING;

  // ── SHADOW TELEMETRY, reported not gated (Batch 911) ─────────────────────
  // The second run's report DID carry `shadowActiveOff/On` — three levels down
  // in `webgpuCloudLanes.rungs[i].shadow`, where no verdict and no console line
  // read it, so the row recorded "the promised telemetry did not appear". It
  // appears HERE now, next to the verdict that needs it, so a blind shadow lane
  // is diagnosable from the printed summary alone:
  //   producer  `shadowActive` + the published strength/absorption/map size
  //   consumer  the packed `cloudShadowControl` the terrain FS branches on
  //   geometry  where the scored band lands in the 512-texel footprint
  // Deliberately NOT gating: each can legitimately read false in a
  // configuration that is not lane B's (a clouds-off leg publishes no map), and
  // the gate is the contrast, not the plumbing.
  v.shadowTelemetry = {
    producerActiveOff: rungs[0]?.shadow?.shadowActiveOff ?? null,
    producerActiveOn: rungs[0]?.shadow?.shadowActiveOn ?? null,
    producer: rungs[0]?.shadow?.cloudCacheOff ?? null,
    consumer: rungs[0]?.shadow?.globeUniformOff ?? null,
    footprint: rungs[0]?.shadow?.footprintOff ?? null,
    groundOnly: v.shadowGroundOnly,
    groundRetention: v.shadowGroundRetentionRatio,
    // CO-19: the four per-rung deck-free reads, printed in full so the tell is
    // visible in the console line rather than three levels down in the JSON.
    // Four identical f64s IS the finding.
    offNoCloudSeries: v.offNoCloudSeries,
    offNoCloudSpread: v.offNoCloudSpread,
    offNoShadowSpread: v.offNoShadowSpread,
    offNoCloudVariesWithSun: v.offNoCloudVariesWithSun,
    deckFreeExcessAtDeepest: v.deckFreeGroundExcessAtDeepest,
    cameraHeight: rungs[0]?.shadow?.cameraHeight ?? null,
    pitchDegrees: rungs[0]?.shadow?.pitchDegrees ?? null,
  };

  // ── Lane C: prediction (iii) ─────────────────────────────────────────────
  v.predictedSweepRefreshCount = predictedSweepRefreshCount();
  v.predictedRefreshCountExact = v.predictedSweepRefreshCount === 275;

  const realizedBuckets = (lane) =>
    (lane.factors ?? []).map((factor) => predictBucket(factor));
  const gpuBuckets = realizedBuckets(gpu);
  const glBuckets = realizedBuckets(gl);
  v.maxBucketStepWebGPU = maxBucketStep(gpuBuckets);
  v.maxBucketStepWebGL = maxBucketStep(glBuckets);
  v.rampNeverSkipsABucket =
    v.maxBucketStepWebGPU <= 1 && v.maxBucketStepWebGL <= 1;

  v.engineRefreshCountWebGPU = gpu.engineRefreshCount ?? null;
  v.engineRefreshCountWebGL = gl.engineRefreshCount ?? null;
  v.engineRefreshCountWebGPUInBand = inBand(
    v.engineRefreshCountWebGPU,
    B.engineRefreshCount,
  );
  v.engineRefreshCountWebGLInBand = inBand(
    v.engineRefreshCountWebGL,
    B.engineRefreshCount,
  );
  v.engineRefreshCountExactReportedOnly =
    v.engineRefreshCountWebGPU === 275 && v.engineRefreshCountWebGL === 275;

  v.controlRefreshQuiescent =
    inBand(gpu.controlRefreshCount, B.controlRefreshCount) &&
    inBand(gl.controlRefreshCount, B.controlRefreshCount);

  const quiescence = (lane, buckets) => {
    const frames = lane.sweepFrames ?? buckets.length;
    if (!(frames > 0)) {
      return null;
    }
    return (frames - countBucketChanges(buckets, buckets[0])) / frames;
  };
  v.sweepQuiescenceWebGPU = quiescence(gpu, gpuBuckets);
  v.sweepQuiescenceWebGL = quiescence(gl, glBuckets);
  v.sweepQuiescenceInBand =
    inBand(v.sweepQuiescenceWebGPU, B.sweepQuiescence) &&
    inBand(v.sweepQuiescenceWebGL, B.sweepQuiescence);

  v.iblDeepRatioWebGPU = ratio(gpu.ibl?.deepest?.mean, gpu.ibl?.baseline?.mean);
  v.iblDeepRatioWebGL = ratio(gl.ibl?.deepest?.mean, gl.ibl?.baseline?.mean);
  v.iblDimsAtDeepest =
    inBand(v.iblDeepRatioWebGPU, B.iblDeepestRatio) &&
    inBand(v.iblDeepRatioWebGL, B.iblDeepestRatio);

  v.iblRecoveryRatioWebGPU = ratio(
    gpu.ibl?.recovered?.mean,
    gpu.ibl?.baseline?.mean,
  );
  v.iblRecoveryRatioWebGL = ratio(
    gl.ibl?.recovered?.mean,
    gl.ibl?.baseline?.mean,
  );
  v.iblRecovers =
    inBand(v.iblRecoveryRatioWebGPU, B.iblRecoveryRatio) &&
    inBand(v.iblRecoveryRatioWebGL, B.iblRecoveryRatio);

  // ── Instrument health ────────────────────────────────────────────────────
  v.determinismDelta = cloud.repeat?.delta ?? null;
  v.determinismBracketHolds = inBand(v.determinismDelta, B.determinismDelta);

  // C13-41-ECLIPSE-REFRESH-COST-UNMEASURED: the differential wall clock of the
  // eclipse-driven fills, over INTERLEAVED legs that both paid a discarded
  // warm-up. `computeRefreshCost` owns the arithmetic AND the validity rules;
  // see its header for why a sequential A/B is not a measurement.
  const webgpuCost = computeRefreshCost(gpu.refreshCost);
  const webglCost = computeRefreshCost(gl.refreshCost);
  const cost = {
    webgpu: webgpuCost,
    webgl: webglCost,
    // Flat aliases the driver's one-line COST print reads. `null` whenever the
    // estimate is INVALID, so a negative differential can never surface as a
    // number that looks like a cost.
    webgpuMsPerRefresh: webgpuCost.valid ? webgpuCost.msPerRefresh : null,
    webglMsPerRefresh: webglCost.valid ? webglCost.msPerRefresh : null,
    invalidReasons: [
      webgpuCost.valid ? null : `webgpu: ${webgpuCost.invalidReason}`,
      webglCost.valid ? null : `webgl: ${webglCost.invalidReason}`,
    ].filter((reason) => reason !== null),
  };
  // MEASURED, not bounded: the row asks for the number, and there is no
  // pre-registered budget to score it against. The gate is only that a real,
  // non-negative number came back on both backends — an INVALID estimate means
  // the differential could not be formed and the row does NOT discharge.
  v.refreshCostMeasured = webgpuCost.valid && webglCost.valid;

  // ── Parity ───────────────────────────────────────────────────────────────
  const parity = {};
  const n = Math.min((gpu.factors ?? []).length, (gl.factors ?? []).length);
  let maxFactorDelta = 0;
  for (let i = 0; i < n; i++) {
    const a = gpu.factors[i];
    const b = gl.factors[i];
    if (Number.isFinite(a) && Number.isFinite(b)) {
      maxFactorDelta = Math.max(maxFactorDelta, Math.abs(a - b));
    }
  }
  parity.maxFactorDelta = maxFactorDelta;
  parity.sweepFactorSeriesParity =
    n > 0 && maxFactorDelta <= B.factorTolerance.hi;
  parity.predictedRefreshCountParity =
    countBucketChanges(gpuBuckets, gpuBuckets[0]) ===
    countBucketChanges(glBuckets, glBuckets[0]);
  // Both cross-backend predicates read the two IBL lanes, so they are scored
  // exactly when that domain can see.
  const parityBlind = isBlind(ECLIPSE_CLOUD_PARITY_LANE);
  const parityFailed = parityBlind
    ? []
    : ECLIPSE_CLOUD_PARITY_PREDICATES.filter((name) => parity[name] !== true);

  // ── The scoped fold ──────────────────────────────────────────────────────
  const unscoredPredicates = ECLIPSE_CLOUD_GATE_PREDICATES.filter((name) =>
    isBlind(ECLIPSE_CLOUD_PREDICATE_LANES[name]),
  );
  const unscored = new Set(unscoredPredicates);

  v.parity = parity;
  v.gatePredicates = ECLIPSE_CLOUD_GATE_PREDICATES;
  v.predicateLanes = ECLIPSE_CLOUD_PREDICATE_LANES;
  v.reportedOnlyPredicates = ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES;
  v.structuralReasons = structuralReasons;
  v.blindLanes = blind;
  v.unscoredPredicates = unscoredPredicates;
  v.unscoredParityPredicates = parityBlind
    ? [...ECLIPSE_CLOUD_PARITY_PREDICATES]
    : [];
  v.cost = cost;
  v.failedPredicates = ECLIPSE_CLOUD_GATE_PREDICATES.filter(
    (name) => !unscored.has(name) && v[name] !== true,
  );
  v.parityFailed = parityFailed;
  v.PASS =
    structuralReasons.length === 0 &&
    v.failedPredicates.length === 0 &&
    parityFailed.length === 0;
  v.exitCode = eclipseCloudExitCode(v);
  v.GATE = eclipseCloudGateLabel(v);
  return v;
}
