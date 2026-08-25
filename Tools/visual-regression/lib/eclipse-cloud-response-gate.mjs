/**
 * The GATE half of `probe-eclipse-cloud-response.mjs` — C13-41's Edge
 * acceptance predicates, their pre-registered bands, and the fold that turns a
 * run's measurements into a verdict.
 * @purpose C13-41 Edge-acceptance predicates with derived-never-fitted bands for deck lighting, cloud-shadow invariance, IBL bucket fills, and submitted-refresh cost.
 * @status ACTIVE
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
 *   (iii) IBL refresh — a 0 -> 0.9 -> 0 sweep produces exactly 275
 *         eclipse-driven fills (1 baseline + 2 x 137 bucket edges, buckets
 *         256 -> 119), with no eclipse-driven fill on roughly two thirds of
 *         an 801-frame sweep.
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
 * `shadowDecrementRejectsAlternativeDesign` for the arithmetic that rules the
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
// This is retained as a HISTORICAL MECHANISM DIAGNOSTIC beside the operative
// raw-composite gate. The fourth Edge
// run measured `shadowContrastRatioAtDeepest` = 1.0496 against the legacy
// [0.97, 1.03] band, and the row derived the extension below on the hypothesis
// that the shadowed floor was ambient-lit by a different law. The derivation
// refutes that hypothesis without needing to know the split, but the recovered
// run later proved that the captured band also contains ProceduralClouds' later
// unshadowable over-composite. Consequently this split model is reported, not
// gated; R-2026-08-14-1 explicitly says that confound does not demote the raw
// measured red.
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
// THE LEGACY BAND DOES NOT MOVE AND R-2026-08-14-1 RESTORES IT AS A GATE. The
// extension still predicts 1.0002 and remains useful when investigating why the
// post-cloud-composite raw ratio reaches 1.0496; naming the composite confound
// is not an authorization to discard that reading. `evaluateShadowDecrementModel`
// remains a companion gate: its within-state difference cancels the additive
// cloud term, then compares the eclipse/clear decrement ratio with independent
// ABBA ground dim times actual producer strength. Passing the companion cannot
// erase a miss on the raw band.
//
// WHAT THE DERIVATION DOES LOCALISE. Because F cancels, the published laws also
// predict that BOTH ground bands dim by exactly F — `onNoShadow/offNoShadow` and
// `onShadow/offShadow` should each equal the published factor. The fourth run
// reads 1.126x and 1.182x of F at the deepest rung: the ground band UNDER-DIMS,
// and the contrast excess is the arithmetic consequence
// (1.181983 / 1.126131 = 1.0496). `extractShadowableDimming` inverts the two
// bands for the shadowable term's own law and reads d/F = 1.000 / 0.992 / 0.995 /
// 1.008 across the ladder — the shadowable path is exactly right to <1%, so the
// under-dim lives in the residue the shadow cannot touch. This remains a
// reported historical diagnosis; the raw invariant and the independently
// replicated decrement model each retain their own verdict.

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
 * independently predicted factor at the same 1400 m camera geometry. See the
 * block above for the derivation; the result is clamped to
 * `deckFreeGroundDimToleranceCap` so it can only ever tighten.
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
 * Counts LEVEL CHANGES in a committed-bucket series. Every transition proves
 * an eclipse-driven fill because the bucket is committed inside the refresh
 * branch, but a refresh for another reason can commit the same value and leave
 * no transition. This is therefore a fill witness, not a count of all
 * environment refreshes. A series that jumps two buckets in one step is ONE
 * change, not two — which is exactly why the ramp has to be fine enough not to
 * skip.
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
  // The first eclipse-driven fill walks NaN -> 256 during the warm-up, before
  // the sweep's first frame; the sweep itself contributes its level changes.
  const buckets = idealSweepBuckets();
  return 1 + countBucketChanges(buckets, buckets[0]);
}

/**
 * Largest single-frame bucket jump in a series. Must be at most 1, or the ramp
 * skipped an edge and the eclipse-driven fill count collapses toward the
 * number of jumps rather than the number of edges.
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

/** Half of one 8-bit display code, the quantization error of one band mean. */
export const BAND_MEAN_QUANTIZATION_HALF_STEP = 0.5 / 255;

/**
 * Exact positive-ratio interval after propagating bounded numerator and
 * denominator errors. This is an interval calculation, not a fitted tolerance.
 *
 * @param {number} numerator
 * @param {number} denominator
 * @param {number} numeratorError
 * @param {number} denominatorError
 * @returns {{lo:number, hi:number}|null}
 */
function boundedPositiveRatioInterval(
  numerator,
  denominator,
  numeratorError,
  denominatorError,
) {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    !Number.isFinite(numeratorError) ||
    !Number.isFinite(denominatorError) ||
    !(numerator > 0) ||
    !(denominator > denominatorError) ||
    !(numeratorError >= 0) ||
    !(denominatorError >= 0)
  ) {
    return null;
  }
  return {
    lo:
      Math.max(0, numerator - numeratorError) /
      (denominator + denominatorError),
    hi: (numerator + numeratorError) / (denominator - denominatorError),
  };
}

const intervalsOverlap = (left, right) =>
  left !== null && right !== null && left.lo <= right.hi && right.lo <= left.hi;

/**
 * Certify the terrain cloud-shadow decrement without treating the later cloud
 * over-composite as terrain. The full-resolution cloud pass produces
 * `C = (1-alpha) * G + alpha * H` after `GlobeTerrain` has already multiplied
 * `G` by the beer shadow. Consequently the raw `shadowed/unshadowed` display
 * contrast contains an unshadowable, independently tone-mapped `H` term. The
 * difference at one eclipse state cancels that additive term:
 *
 *   D = C_noShadow - C_shadow = (1-alpha) * (G_noShadow - G_shadow)
 *
 * and the ratio of decrements must follow the independently replicated ABBA
 * ground dim times the producer's actual shadow-strength ratio.
 *
 * Every input band is an 8-bit display mean. One mean is bounded by half a code
 * (`0.5/255`), so each two-mean decrement is bounded by one full code
 * (`1/255`). The returned intervals propagate those hard bounds through both
 * ratios exactly; no empirical percentage or widened legacy band is involved.
 *
 * @param {object} model
 * @param {object} model.shadow One rung's shadow block, including ABBA fields.
 * @param {number} model.strengthClear Actual producer strength in the clear leg.
 * @param {number} model.strengthEclipse Actual producer strength in the eclipse leg.
 * @param {number|null} [model.alternativeStrengthRatio] Rejected-design ratio.
 * @returns {object}
 */
export function evaluateShadowDecrementModel({
  shadow,
  strengthClear,
  strengthEclipse,
  alternativeStrengthRatio = null,
}) {
  const clearDecrement =
    Number.isFinite(shadow?.offNoShadow) && Number.isFinite(shadow?.offShadow)
      ? shadow.offNoShadow - shadow.offShadow
      : null;
  const eclipseDecrement =
    Number.isFinite(shadow?.onNoShadow) && Number.isFinite(shadow?.onShadow)
      ? shadow.onNoShadow - shadow.onShadow
      : null;
  const groundClear = shadow?.offNoCloud;
  const groundEclipse = shadow?.onNoCloud;
  const halfStep = BAND_MEAN_QUANTIZATION_HALF_STEP;
  const differenceError = halfStep * 2;
  const reasons = [];

  if (!(Number.isFinite(clearDecrement) && clearDecrement > differenceError)) {
    reasons.push(
      `clear shadow decrement ${clearDecrement} does not exceed one display code ${differenceError}`,
    );
  }
  if (!(Number.isFinite(eclipseDecrement) && eclipseDecrement > 0)) {
    reasons.push(
      `eclipse shadow decrement ${eclipseDecrement} is not positive`,
    );
  }
  if (!(Number.isFinite(groundClear) && groundClear > halfStep)) {
    reasons.push(
      `ABBA clear ground ${groundClear} is not quantization-resolvable`,
    );
  }
  if (!(Number.isFinite(groundEclipse) && groundEclipse > 0)) {
    reasons.push(`ABBA eclipse ground ${groundEclipse} is not positive`);
  }
  if (!(Number.isFinite(strengthClear) && strengthClear > 0)) {
    reasons.push(`clear producer strength ${strengthClear} is not positive`);
  }
  if (!(Number.isFinite(strengthEclipse) && strengthEclipse >= 0)) {
    reasons.push(`eclipse producer strength ${strengthEclipse} is invalid`);
  }

  const observed =
    reasons.length === 0 ? eclipseDecrement / clearDecrement : null;
  const groundDimming =
    reasons.length === 0 ? groundEclipse / groundClear : null;
  const strengthRatio =
    reasons.length === 0 ? strengthEclipse / strengthClear : null;
  const expected = reasons.length === 0 ? groundDimming * strengthRatio : null;
  const observedInterval =
    reasons.length === 0
      ? boundedPositiveRatioInterval(
          eclipseDecrement,
          clearDecrement,
          differenceError,
          differenceError,
        )
      : null;
  const groundInterval =
    reasons.length === 0
      ? boundedPositiveRatioInterval(
          groundEclipse,
          groundClear,
          halfStep,
          halfStep,
        )
      : null;
  const expectedInterval =
    groundInterval !== null && Number.isFinite(strengthRatio)
      ? {
          lo: groundInterval.lo * strengthRatio,
          hi: groundInterval.hi * strengthRatio,
        }
      : null;
  const alternativeExpected =
    Number.isFinite(groundDimming) &&
    Number.isFinite(alternativeStrengthRatio) &&
    alternativeStrengthRatio >= 0
      ? groundDimming * alternativeStrengthRatio
      : null;
  const alternativeExpectedInterval =
    groundInterval !== null &&
    Number.isFinite(alternativeStrengthRatio) &&
    alternativeStrengthRatio >= 0
      ? {
          lo: groundInterval.lo * alternativeStrengthRatio,
          hi: groundInterval.hi * alternativeStrengthRatio,
        }
      : null;

  return {
    valid:
      reasons.length === 0 &&
      observedInterval !== null &&
      expectedInterval !== null,
    reasons,
    clearDecrement,
    eclipseDecrement,
    groundDimming,
    strengthRatio,
    observed,
    expected,
    residual:
      Number.isFinite(observed) && Number.isFinite(expected)
        ? observed - expected
        : null,
    quantization: {
      bandMeanHalfStep: halfStep,
      twoMeanDifferenceError: differenceError,
      observedInterval,
      expectedInterval,
      residualInterval:
        observedInterval !== null && expectedInterval !== null
          ? {
              lo: observedInterval.lo - expectedInterval.hi,
              hi: observedInterval.hi - expectedInterval.lo,
            }
          : null,
    },
    withinQuantizationBound: intervalsOverlap(
      observedInterval,
      expectedInterval,
    ),
    alternativeExpected,
    alternativeExpectedInterval,
    alternativeWithinQuantizationBound: intervalsOverlap(
      observedInterval,
      alternativeExpectedInterval,
    ),
  };
}

/**
 * The dimmest deck-free ground band lane B may score at all — the floor of
 * `shadowGroundBrightness`. It is named here because it BOUNDS the propagated
 * tolerance of every ratio taken against that band: below it the lane is blind
 * and nothing downstream is scored, so no derived tolerance can be looser than
 * the one this floor admits.
 */
export const SHADOW_GROUND_BRIGHTNESS_FLOOR = 0.15;

// Independent read-only evaluation of the fixed four ladder ISOs through the
// current EclipseState implementation. This is the largest obscuration change
// observed when moving the same fixture from ellipsoid height to lane B's
// 1400 m camera; the historical ICRF/TEME branch disagreement at those ISOs was
// never smaller than 0.0063.
export const FIXED_LADDER_0_TO_1400_MAX_OBSCURATION_SHIFT = 7.91e-5;
export const HISTORICAL_EPHEMERIS_BRANCH_SHIFT_FLOOR = 0.0063;

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
    "NOT the tolerance — the CAP on it. `deckFreeGroundDimsByFactor` compares `onNoCloud/offNoCloud` against the independently predicted F at the same 1400 m camera geometry, with a tolerance PROPAGATED per rung from the band mean it was measured on, (d/U_off)*(1+r) with d = BAND_MEAN_CAPTURE_DELTA (see `deckFreeGroundDimTolerance`). A propagated tolerance widens as the band darkens, so it needs a ceiling that is not a choice: `shadowGroundIsBright` blinds the whole shadow domain below U_off = 0.15 and a ratio above 1 fails on its own terms, so (0.004/0.15)*(1+1) = 0.05333 is the loosest tolerance this predicate can EVER be scored with. At the fourth run's own deck-free band (0.27506) the propagated tolerance is 0.02129, and the under-dim the globe-path branch predicts (1.1261*F - F = 0.0585) is 2.75x it",
  ),

  shadowContrastRatio: band(
    0.97,
    1.03,
    "prediction (ii), restored as an operative gate by maintainer ruling R-2026-08-14-1: the post-cloud-composite ratio-of-ratios at obscuration 0.9 must remain inside the original [0.97, 1.03] display band. ProceduralClouds' later composite is a known mechanism confound, but the ruling explicitly preserves the measured 1.0496 red until that mechanism is investigated; it does not authorize demotion. The cloud-cancelling decrement model remains a separate pair of gates against independent ABBA ground dim and producer strength, using exact 8-bit quantization intervals.",
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
    "the row's eclipse-driven fill cadence. 274 of the 801 sweep frames change a bucket, so 527/801 = 0.658 have no eclipse-driven fill. The band is 0.658 -0.058/+0.092, wide enough to survive a handful of merged edges and narrow enough that an eclipse-driven fill EVERY frame (0.0) or NEVER (1.0) fails",
  ),

  controlRefreshCount: band(
    0,
    2,
    "the eclipse-OFF control over the identical 801-frame schedule. With the effect off the factor is exactly 1.0 on every frame, so the bucket can transition to the identity 256 at most once. Two is the allowance for that initial transition plus one resource-generation transition. Other refresh causes may recommit the same bucket value and remain separately visible as `controlRefreshes` in the cost block",
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

  scheduleObscurationTolerance: band(
    0,
    2.5e-4,
    `the realized obscuration at each scored camera geometry against the schedule derived in its own fresh context. DERIVE_SCHEDULE solves at ellipsoid height while lane A renders at 300 m: at minimum lunar distance, observer displacement normalized by the Sun's apparent radius and disc-overlap slope is (300/356500000)/0.00465*(4/pi) = 0.000230, so 0.00025 rounds that hard bound upward. Lane B and every deck-free ABBA session render at 1400 m; independent read-only evaluation of this fixed four-ISO ladder through current EclipseState measured a maximum 0 -> 1400 m shift of 7.91e-5 (${FIXED_LADDER_0_TO_1400_MAX_OBSCURATION_SHIFT}). The historical old-vs-current ICRF/TEME branch shift at those same ISOs was ${HISTORICAL_EPHEMERIS_BRANCH_SHIFT_FLOOR}-0.0077, so it remains structural`,
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

  deckFreeGroundSettleDelta: band(
    0,
    BAND_MEAN_CAPTURE_DELTA,
    "the absolute difference between independent fresh-context replicas of the deck-free ground band, on EACH eclipse leg. Runs 4-6 produced frozen-dark, sun-varying, then exact raw-baseColor controls because one persistent page repeatedly crossed cloud/effect configure states; a later same-page recapture could only report more state from that same epoch. The redesigned control is ABBA across four new browser contexts, exactly one configure per context before any scored frame. A difference beyond one eight-bit code is session-dependent apparatus, not a product finding, so it is STRUCTURAL for the `deck-free` domain and deliberately does not demote the cast-shadow ratio taken entirely among deck-present captures. The bound is `BAND_MEAN_CAPTURE_DELTA` verbatim. This cannot launder a defect: if both independent sessions agree on 0.449, replication passes and `deckFreeGroundDimsByFactor` still fails",
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
  "shadowDecrementMatchesGroundDim",
  "shadowDecrementRejectsAlternativeDesign",
  "shadowContrastModelIsBoundedByDirectional",
  // Lane B attribution leg — the deck-free ground's own dimming law. The
  // fresh-context and lit-surface preconditions are evaluated FIRST. The ABBA
  // sessions then have to reproduce; an attribution from a reused configure
  // epoch or a raw/unlit base-colour read is not an attribution.
  "deckFreeControlStateIsolated",
  "deckFreeGroundIsLit",
  "deckFreeGroundCapturesSettled",
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
  // A fresh ABBA measurement is an eligibility prerequisite, not a product
  // performance budget. Missing or ineligible accounting becomes STRUCTURAL.
  "refreshCostMeasured",
  // Instrument health
  "determinismBracketHolds",
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
  // CO-17. The ambient/direct-split model's agreement with the raw composite.
  // The recovered run established that the raw band contains a later
  // unshadowable cloud term, so disagreement is diagnostic rather than a
  // terrain failure. Read `shadowContrastModel` for the historical per-rung
  // arithmetic and `shadowDecrementModel` for the gate.
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
  // CO-21. Whether lane B's two retention ratios AGREE — `offNoShadow/offNoCloud`
  // (the gating `shadowGroundNotOccluded` reads it) against its previously
  // uncomputed eclipse-ON twin `onNoShadow/onNoCloud`. The fifth run read 0.9894
  // off and 2.2035 on, and one surface cannot produce both, so this is the
  // corroborating number for the whole enable-identity question. It is
  // reported-only because WHICH of the two is wrong is decided by
  // `deckFreeGroundCapturesSettled`, not by their disagreement: gating it would
  // score the same ambiguity twice and would fail a run in the exact shape where
  // the deck-present band is the contaminated one.
  "deckFreeGroundRetentionLegsAgreeReportedOnly",
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
  // CO-21 — the deck-free attribution leg is a CHILD of the shadow lane, not a
  // peer of it. Everything that blinds lane B blinds the attribution (it reads
  // lane B's own ground band, and `shadowGroundIsBright` is the band mean its
  // tolerance is propagated from), but the converse must NOT hold: an unsettled
  // deck-free CONTROL says nothing about the cast-shadow contrast, which is a
  // ratio OF ratios taken entirely among the deck-present captures. Blinding
  // the whole `shadow` domain for it would demote the row's real
  // `C13-41-SHADOW-CONTRAST-ECLIPSE-EXCESS` finding to non-gating — precisely
  // the per-lane over-scoping the third pass was told to stop doing.
  "deck-free": "shadow",
  "ibl-page": null,
  "ibl-model": "ibl-page",
  "refresh-cost": "ibl-page",
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
  shadowGroundIsBright: "deck-free",
  shadowGroundNotOccluded: "deck-free",
  shadowNonVacuous: "shadow",
  offShadowStrengthExactlyOne: "cloud-page",
  shadowStrengthMatchesDirectional: "cloud-page",
  // R-2026-08-14-1: the raw post-cloud-composite ratio is lane B's own
  // measurement. A blind deck-free attribution control must never quarantine
  // this red; only a blind shadow capture may make it unscorable.
  shadowContrastInvariant: "shadow",
  // The decrement model consumes the independently replicated ABBA ground dim,
  // so a blind deck-free control correctly quarantines these two companion
  // predicates without touching the raw invariant above.
  shadowDecrementMatchesGroundDim: "deck-free",
  shadowDecrementRejectsAlternativeDesign: "deck-free",
  // The split model's bound on itself: derived inside this module from the
  // published laws with no run input, so it is never quarantined — the same
  // domain, and for the same reason, as `predictedRefreshCountExact`.
  shadowContrastModelIsBoundedByDirectional: "gate-arithmetic",
  // The deck-free attribution leg reads lane B's own ground band, and its
  // precondition (`shadowGroundIsBright`, the band mean the tolerance is
  // propagated from) lives in the parent domain. Scoring an attribution over a
  // band too dark to carry one certifies nothing — and CO-21 adds the second
  // precondition, that the band had stopped moving when it was read.
  deckFreeControlStateIsolated: "deck-free",
  deckFreeGroundIsLit: "deck-free",
  deckFreeGroundCapturesSettled: "deck-free",
  deckFreeGroundDimsByFactor: "deck-free",
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
  refreshCostMeasured: "refresh-cost",
  // Instrument health
  determinismBracketHolds: "cloud-page",
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
// THE REFRESH-COST ARITHMETIC
// ─────────────────────────────────────────────────────────────────────────────
//
// The warm-ups, eight interleaved pairs, schedule, realized obscurations,
// submitted-refresh denominator, eclipse-driven fill count, and redundant
// aggregates are all recomputed from retained primitives. Valid renderer
// timestamps are preferred because CPU wall clock
// cannot separate pass cost from device power-state drift. Wall time remains a
// bound; only the backend without renderer timer accounting may use it as its
// named figure of record. Missing, unresolved, or negative GPU timing never
// becomes a numeric cost.

/** The ratified ABBA protocol uses exactly eight balanced segment pairs. */
export const REFRESH_COST_SEGMENTS_PER_LEG = 8;
/** Schema version for the live lane/protocol binding carried by cost ledgers. */
export const REFRESH_COST_PROTOCOL_VERSION = 4;
/** Renderer timestamp instrument and pass set carried by every ledger. */
export const REFRESH_COST_GPU_TIME_PROTOCOL = Object.freeze({
  instrument: "CesiumDebug.gpuPassCost",
  source: "WebGPUTimestampProfiler._latestResults",
  feature: "timestamp-query",
  passNames: Object.freeze([
    "DynEnvMap Sky Fill",
    "DynEnvMap IBL Irradiance",
    "DynEnvMap IBL Radiance Prefilter",
    "DynEnvMap SH Projection",
    "DynEnvMap Temporal Blend",
  ]),
  rawUnit: "ns",
  reportUnit: "ms",
  scope: "whole-refresh",
  scopeNote:
    "the declared set is every compute pass the refresh encodes: sky fill, IBL irradiance, IBL radiance prefilter (including optional source-mip preparation), SH projection, and temporal blend; the temporal-blend pass appears only when envMapTemporalAccumulation is enabled, so each segment records the labels that actually produced samples; excluded from the set are the two encoder-level cube copies in the temporal path, which cannot carry timestampWrites, and the optional scene-capture render pass, which could be timed via withRenderPassTimestamps but is not - both are inert at this lane's defaults (sceneCaptureReflections and envMapTemporalAccumulation are off)",
});
const REFRESH_COST_OPTIONAL_GPU_PASS_NAME =
  REFRESH_COST_GPU_TIME_PROTOCOL.passNames.at(-1);
const REFRESH_COST_MANDATORY_GPU_PASS_NAMES =
  REFRESH_COST_GPU_TIME_PROTOCOL.passNames.filter(
    (passName) => passName !== REFRESH_COST_OPTIONAL_GPU_PASS_NAME,
  );
/** Stable reasons distinguish a missing instrument from a measured result. */
export const REFRESH_COST_WEBGPU_GPU_UNAVAILABLE_REASON =
  "WebGPU timestamp-query feature is unavailable";
export const REFRESH_COST_WEBGL_GPU_UNAVAILABLE_REASON =
  "WebGL renderer has no GPU timestamp accounting path";

/**
 * Independently derives the one admissible near-equal partition: for 801 / 8,
 * one 101-frame pair followed by seven 100-frame pairs. The probe implements
 * the same quotient/remainder construction inside the page; the gate never
 * accepts arbitrary self-consistent bounds supplied by a report.
 *
 * @returns {Array<[number, number]>}
 */
export function deriveRefreshCostSegmentBounds() {
  const quotient = Math.floor(SWEEP_FRAMES / REFRESH_COST_SEGMENTS_PER_LEG);
  const remainder = SWEEP_FRAMES % REFRESH_COST_SEGMENTS_PER_LEG;
  const bounds = [];
  let from = 0;
  for (
    let pairIndex = 0;
    pairIndex < REFRESH_COST_SEGMENTS_PER_LEG;
    pairIndex++
  ) {
    const frames = quotient + (pairIndex < remainder ? 1 : 0);
    bounds.push([from, from + frames]);
    from += frames;
  }
  return bounds;
}

function gpuResolutionIsValid(value) {
  return (
    (value?.resolutionKnown === false && value.resolutionNs === null) ||
    (value?.resolutionKnown === true &&
      Number.isFinite(value.resolutionNs) &&
      value.resolutionNs > 0)
  );
}

function gpuResolutionMatches(value, reference) {
  return (
    gpuResolutionIsValid(value) &&
    value.resolutionKnown === reference.resolutionKnown &&
    Object.is(value.resolutionNs, reference.resolutionNs)
  );
}

/**
 * The twelve renderer-ledger counters a timed segment must close on, each with
 * the value that means "closed". Kept beside the fold that consumes them so a
 * counter cannot be added to the renderer and silently go unchecked here.
 */
export const REFRESH_COST_LEDGER_EXPECTATIONS = Object.freeze([
  Object.freeze({ counter: "enabled", closed: true }),
  Object.freeze({ counter: "attemptedFrameCount", closed: "frames" }),
  Object.freeze({ counter: "frameCount", closed: "frames" }),
  Object.freeze({ counter: "sampleLedgerBalanced", closed: true }),
  Object.freeze({ counter: "readbackSkipCount", closed: 0 }),
  Object.freeze({ counter: "failedReadbackCount", closed: 0 }),
  Object.freeze({ counter: "emptyFrameCount", closed: 0 }),
  Object.freeze({ counter: "lostSampleCount", closed: 0 }),
  Object.freeze({ counter: "pendingReadbackCount", closed: 0 }),
  Object.freeze({ counter: "unaccountedSampleCount", closed: 0 }),
  Object.freeze({ counter: "invertedSampleCount", closed: 0 }),
  Object.freeze({ counter: "droppedPassCount", closed: 0 }),
]);

/**
 * Name every renderer-ledger counter that did not close, with its value.
 *
 * A bare "did not close" sends the reader back to the JSON to find out WHICH
 * counter tripped, and the failure modes are not interchangeable: a saturated
 * readback ring reads as `frameCount` short of the segment with a matching
 * `readbackSkipCount` and loses only timing, while a dropped or lost sample
 * means the renderer discarded work the fold would have counted. Those must not
 * produce the same sentence.
 *
 * @param {object} results One segment's retained renderer counters.
 * @param {number} frames The segment's frame count.
 * @returns {string} Comma-separated `name=value` pairs; empty when all closed.
 */
export function describeRefreshCostLedgerClosure(results, frames) {
  if (!results || typeof results !== "object") {
    return "results absent";
  }
  return REFRESH_COST_LEDGER_EXPECTATIONS.filter(
    ({ counter, closed }) =>
      !Object.is(results[counter], closed === "frames" ? frames : closed),
  )
    .map(({ counter }) => `${counter}=${String(results[counter])}`)
    .join(", ");
}

/**
 * Prefix one segment-local refusal without duplicating a prefix already
 * retained by the probe.
 *
 * @param {number} pairIndex
 * @param {string} leg
 * @param {string} reason
 * @returns {string}
 */
export function formatRefreshCostSegmentReason(pairIndex, leg, reason) {
  const prefix = `pair ${pairIndex} ${leg}:`;
  return reason.startsWith(prefix) ? reason : `${prefix} ${reason}`;
}

function sumRefreshCostSamplesByPass(samplesMsByPass, refreshes) {
  const summedPassNames = Object.keys(samplesMsByPass);
  return Array.from({ length: refreshes }, (_, refreshIndex) =>
    summedPassNames.reduce(
      (total, passName) => total + samplesMsByPass[passName][refreshIndex],
      0,
    ),
  );
}

function readRefreshCostRefreshWitness(segment, backend, label) {
  const refused = (schemaError, invalidReason = null) => ({
    schemaError,
    valid: false,
    invalidReason,
    submittedTotal: null,
  });
  if (segment.refreshValid !== true) {
    const invalidIsNamed =
      segment.refreshValid === false &&
      typeof segment.refreshInvalidReason === "string" &&
      segment.refreshInvalidReason.length > 0;
    return invalidIsNamed
      ? refused(
          null,
          formatRefreshCostSegmentReason(
            segment.pairIndex,
            segment.leg,
            segment.refreshInvalidReason,
          ),
        )
      : refused(`${label} has no exact named environment-refresh witness`);
  }
  if (segment.refreshInvalidReason !== null) {
    return refused(
      `${label} marks its environment-refresh witness valid while retaining an invalid reason`,
    );
  }

  // Both backends retain one witness per frame, so the count this function
  // returns is DERIVED from the per-frame evidence and is what the cost
  // arithmetic divides by. `segment.refreshes` is cross-checked against it and
  // is never itself operative  a probe cannot declare a denominator.
  const submissions = segment.refreshSubmissions;
  const frameIds = segment.refreshFrameIds;
  const wantsFrameIds = backend !== "webgl";
  if (
    !Array.isArray(submissions) ||
    submissions.length !== segment.frames ||
    (wantsFrameIds &&
      (!Number.isSafeInteger(segment.refreshBaselineFrameId) ||
        !Array.isArray(frameIds) ||
        frameIds.length !== segment.frames))
  ) {
    return refused(
      `${label} does not retain one environment-refresh telemetry read for each of its ${segment.frames} frames`,
    );
  }
  if (
    !wantsFrameIds &&
    (segment.refreshBaselineFrameId !== null || frameIds !== null)
  ) {
    // WebGL has no frame ordinal to chain; carrying one would mean the witness
    // came from the wrong backend's accessor.
    return refused(
      `${label} retained WebGPU frame-ordinal telemetry for a WebGL last-time witness`,
    );
  }
  for (let index = 0; index < submissions.length; index++) {
    const submitted = submissions[index];
    if (!Number.isSafeInteger(submitted) || submitted < 0) {
      return refused(
        `${label} has malformed environment-refresh telemetry at frame offset ${index}`,
      );
    }
    if (!wantsFrameIds) {
      continue;
    }
    const frameId = frameIds[index];
    if (!Number.isSafeInteger(frameId)) {
      return refused(
        `${label} has malformed environment-refresh telemetry at frame offset ${index}`,
      );
    }
    const previousFrameId =
      index === 0 ? segment.refreshBaselineFrameId : frameIds[index - 1];
    if (frameId !== previousFrameId + 1) {
      return refused(
        null,
        formatRefreshCostSegmentReason(
          segment.pairIndex,
          segment.leg,
          `environment refresh telemetry frameId ${frameId} did not advance exactly once from ${previousFrameId}`,
        ),
      );
    }
  }
  const submittedTotal = submissions.reduce(
    (total, submitted) => total + submitted,
    0,
  );
  if (
    !Number.isSafeInteger(submittedTotal) ||
    submittedTotal !== segment.refreshes
  ) {
    return refused(
      `${label} retained ${submittedTotal} submitted refresh(es) in per-frame telemetry but declared ${segment.refreshes}`,
    );
  }
  return {
    schemaError: null,
    valid: true,
    invalidReason: null,
    submittedTotal,
  };
}

function readRefreshCostGpuSegment(
  block,
  header,
  frames,
  refreshes,
  fills,
  label,
) {
  if (!block || typeof block !== "object") {
    return {
      schemaError: `${label} has no GPU-time accounting block`,
      valid: false,
      totalMs: null,
      invalidReason: null,
    };
  }
  if (!gpuResolutionMatches(block, header)) {
    return {
      schemaError: `${label} GPU timestamp resolution does not match the protocol header`,
      valid: false,
      totalMs: null,
      invalidReason: null,
    };
  }
  if (!header.available) {
    const unavailableIsExact =
      block.status === "unavailable" &&
      block.available === false &&
      block.valid === false &&
      block.totalMs === null &&
      Array.isArray(block.samplesMs) &&
      block.samplesMs.length === 0 &&
      block.samplesMsByPass !== null &&
      typeof block.samplesMsByPass === "object" &&
      !Array.isArray(block.samplesMsByPass) &&
      Object.keys(block.samplesMsByPass).length === 0 &&
      block.invalidReason === header.unavailableReason &&
      block.queueDrain === null &&
      block.drain === null &&
      block.results === null;
    return unavailableIsExact
      ? {
          schemaError: null,
          valid: false,
          totalMs: null,
          invalidReason: header.unavailableReason,
        }
      : {
          schemaError: `${label} does not retain the protocol's exact GPU-unavailable witness`,
          valid: false,
          totalMs: null,
          invalidReason: null,
        };
  }
  if (block.available !== true) {
    return {
      schemaError: `${label} contradicts the available GPU-time protocol header`,
      valid: false,
      totalMs: null,
      invalidReason: null,
    };
  }
  if (block.valid !== true) {
    const invalidIsNamed =
      block.status === "invalid" &&
      block.totalMs === null &&
      typeof block.invalidReason === "string" &&
      block.invalidReason.length > 0;
    return invalidIsNamed
      ? {
          schemaError: null,
          valid: false,
          totalMs: null,
          invalidReason: block.invalidReason,
        }
      : {
          schemaError: `${label} reports unusable GPU time without an exact named reason`,
          valid: false,
          totalMs: null,
          invalidReason: null,
        };
  }

  const samples = block.samplesMs;
  const samplesMsByPass = block.samplesMsByPass;
  if (
    block.status !== "valid" ||
    block.invalidReason !== null ||
    !Array.isArray(samples) ||
    !samples.every((sample) => Number.isFinite(sample) && sample >= 0) ||
    samplesMsByPass === null ||
    typeof samplesMsByPass !== "object" ||
    Array.isArray(samplesMsByPass)
  ) {
    return {
      schemaError: `${label} has malformed resolved GPU pass samples`,
      valid: false,
      totalMs: null,
      invalidReason: null,
    };
  }
  const presentPassNames = Object.keys(samplesMsByPass);
  const undeclaredPassName = presentPassNames.find(
    (passName) => !REFRESH_COST_GPU_TIME_PROTOCOL.passNames.includes(passName),
  );
  if (undeclaredPassName) {
    return {
      schemaError: `${label} retained undeclared GPU pass ${undeclaredPassName}`,
      valid: false,
      totalMs: null,
      invalidReason: null,
    };
  }
  for (const passName of presentPassNames) {
    const passSamples = samplesMsByPass[passName];
    if (
      !Array.isArray(passSamples) ||
      !passSamples.every((sample) => Number.isFinite(sample) && sample >= 0)
    ) {
      return {
        schemaError: `${label} GPU pass ${passName} has malformed resolved samples`,
        valid: false,
        totalMs: null,
        invalidReason: null,
      };
    }
    if (passSamples.length !== refreshes) {
      return {
        schemaError: `${label} GPU pass ${passName} retained ${passSamples.length} sample(s) for ${refreshes} environment refresh(es) submitted (${fills} eclipse-driven fill(s))`,
        valid: false,
        totalMs: null,
        invalidReason: null,
      };
    }
  }
  const missingMandatoryLabel =
    refreshes > 0
      ? REFRESH_COST_MANDATORY_GPU_PASS_NAMES.find(
          (passName) => !Object.hasOwn(samplesMsByPass, passName),
        )
      : undefined;
  if (missingMandatoryLabel) {
    return {
      schemaError: `${label} is missing mandatory GPU pass ${missingMandatoryLabel} for ${refreshes} environment refresh(es) submitted (${fills} eclipse-driven fill(s))`,
      valid: false,
      totalMs: null,
      invalidReason: null,
    };
  }
  if (samples.length !== refreshes) {
    return {
      schemaError: `${label} retained ${samples.length} GPU environment-refresh sample(s) for ${refreshes} environment refresh(es) submitted (${fills} eclipse-driven fill(s))`,
      valid: false,
      totalMs: null,
      invalidReason: null,
    };
  }
  const summedSamples = sumRefreshCostSamplesByPass(samplesMsByPass, refreshes);
  const mismatchedRefresh = samples.findIndex(
    (sample, refreshIndex) => !Object.is(sample, summedSamples[refreshIndex]),
  );
  if (mismatchedRefresh !== -1) {
    return {
      schemaError: `${label} whole-refresh sample ${mismatchedRefresh} does not equal its retained per-pass sum`,
      valid: false,
      totalMs: null,
      invalidReason: null,
    };
  }
  const totalMs = samples.reduce((total, sample) => total + sample, 0);
  if (!Number.isFinite(totalMs) || !Object.is(block.totalMs, totalMs)) {
    return {
      schemaError: `${label} GPU total ${String(block.totalMs)} does not equal its retained pass-sample sum ${String(totalMs)}`,
      valid: false,
      totalMs: null,
      invalidReason: null,
    };
  }
  const queueDrain = block.queueDrain;
  const drain = block.drain;
  const results = block.results;
  const counters = [
    "readbackSkipCount",
    "failedReadbackCount",
    "emptyFrameCount",
    "lostSampleCount",
    "pendingReadbackCount",
    "unaccountedSampleCount",
    "invertedSampleCount",
    "droppedPassCount",
  ];
  if (
    queueDrain?.completed !== true ||
    queueDrain.timedOut !== false ||
    queueDrain.error !== null ||
    drain?.timedOut !== false ||
    drain.undrained !== 0 ||
    drain.abandoned !== 0 ||
    results?.enabled !== true ||
    results.attemptedFrameCount !== frames ||
    results.frameCount !== frames ||
    results.sampleLedgerBalanced !== true ||
    counters.some((field) => results[field] !== 0)
  ) {
    return {
      schemaError: `${label} GPU timestamp validity ledger does not close over its ${frames} measured frames`,
      valid: false,
      totalMs: null,
      invalidReason: null,
    };
  }
  return {
    schemaError: null,
    valid: true,
    totalMs,
    invalidReason: null,
  };
}

/**
 * Keep this as the sole fold over retained cost segments. Replacing it with
 * inline subtraction and division would make sequential A-then-B timing look
 * admissible again; the alternating segment ledger must control drift before
 * any cost arithmetic runs.
 *
 * @param {object} accounting The lane's `refreshCost` accounting.
 * @param {object} binding Live outer-lane and run identity to bind against.
 * @param {string} binding.runId The owning report's current run UUID.
 * @param {string} binding.expectedBackend `webgpu` or `webgl` for this lane.
 * @param {string} binding.expectedSessionLabel The driver's fixed lane label.
 * @param {object} binding.lane The live outer IBL lane.
 * @param {object} binding.peerLane The other backend's live outer IBL lane.
 * @returns {object} `{ valid, msPerRefresh, invalidReason, ... }`
 */
export function computeRefreshCost(accounting, binding) {
  const base = {
    valid: false,
    msPerRefresh: null,
    invalidReason: null,
    measurementSource: null,
    fallbackReason: null,
    msDelta: null,
    fillDelta: null,
    refreshDelta: null,
    gpuMsDelta: null,
    gpuMsPerRefresh: null,
    wallMsDelta: null,
    wallMsPerRefresh: null,
    wallClockRole: null,
    gpuTime: null,
    eclipseWallMs: null,
    controlWallMs: null,
    eclipseGpuMs: null,
    controlGpuMs: null,
    eclipseFills: null,
    controlFills: null,
    eclipseRefreshes: null,
    controlRefreshes: null,
    eclipseFrames: null,
    controlFrames: null,
    segmentsPerLeg: null,
    warmupBothLegs: null,
    warmupWitnessCount: null,
    retainedSegmentCount: null,
    derivedFromSegments: false,
    protocolBound: false,
  };
  const a = accounting;
  if (!a || typeof a !== "object") {
    return {
      ...base,
      invalidReason:
        "the lane reported no refresh-cost accounting — the interleaved legs did not run",
    };
  }

  // No aggregate-only fallback exists. These records are the fresh primitive.
  if (!Array.isArray(a.segments)) {
    return {
      ...base,
      invalidReason:
        "the lane retained no refresh-cost segment ledger — aggregate or historical summaries cannot substitute for fresh per-segment accounting",
    };
  }

  const live = binding?.lane;
  const peer = binding?.peerLane;
  const protocol = a.protocol;
  if (!binding || typeof binding !== "object" || !live) {
    return {
      ...base,
      retainedSegmentCount: a.segments.length,
      invalidReason:
        "the refresh-cost ledger has no live outer-lane binding — a self-contained or historical ledger cannot score",
    };
  }
  if (!protocol || typeof protocol !== "object") {
    return {
      ...base,
      retainedSegmentCount: a.segments.length,
      invalidReason:
        "the refresh-cost ledger has no protocol header binding it to the live run, backend, session, and factor schedule",
    };
  }
  const protocolBase = {
    ...base,
    retainedSegmentCount: a.segments.length,
  };
  if (protocol.version !== REFRESH_COST_PROTOCOL_VERSION) {
    return {
      ...protocolBase,
      invalidReason: `refresh-cost protocol version ${String(protocol.version)} is not ${REFRESH_COST_PROTOCOL_VERSION}`,
    };
  }
  const expectedBackend = binding.expectedBackend;
  if (expectedBackend !== "webgpu" && expectedBackend !== "webgl") {
    return {
      ...protocolBase,
      invalidReason: `refresh-cost binding names unknown expected backend ${String(expectedBackend)}`,
    };
  }
  if (live.rendererType !== expectedBackend) {
    return {
      ...protocolBase,
      invalidReason: `live ${expectedBackend} cost lane resolved rendererType ${String(live.rendererType)}`,
    };
  }
  if (protocol.backend !== expectedBackend) {
    return {
      ...protocolBase,
      invalidReason: `refresh-cost protocol backend ${String(protocol.backend)} does not match live ${expectedBackend} lane`,
    };
  }
  if (typeof binding.runId !== "string" || binding.runId.length === 0) {
    return {
      ...protocolBase,
      invalidReason: "the owning report has no current run identity",
    };
  }
  if (live.runId !== binding.runId || protocol.runId !== binding.runId) {
    return {
      ...protocolBase,
      invalidReason: `refresh-cost run identity diverges (report ${binding.runId}, lane ${String(live.runId)}, ledger ${String(protocol.runId)})`,
    };
  }
  if (
    typeof binding.expectedSessionLabel !== "string" ||
    binding.expectedSessionLabel.length === 0 ||
    live.sessionLabel !== binding.expectedSessionLabel ||
    protocol.sessionLabel !== binding.expectedSessionLabel
  ) {
    return {
      ...protocolBase,
      invalidReason: `refresh-cost session label diverges (expected ${String(binding.expectedSessionLabel)}, lane ${String(live.sessionLabel)}, ledger ${String(protocol.sessionLabel)})`,
    };
  }
  if (
    typeof live.sessionToken !== "string" ||
    live.sessionToken.length === 0 ||
    protocol.sessionToken !== live.sessionToken
  ) {
    return {
      ...protocolBase,
      invalidReason: `refresh-cost session token does not bind the ledger to live ${binding.expectedSessionLabel}`,
    };
  }
  if (
    typeof live.costLedgerId !== "string" ||
    live.costLedgerId.length === 0 ||
    protocol.ledgerId !== live.costLedgerId
  ) {
    return {
      ...protocolBase,
      invalidReason: `refresh-cost ledger identity does not bind to live ${binding.expectedSessionLabel}`,
    };
  }
  if (
    peer &&
    (live.sessionToken === peer.sessionToken ||
      live.costLedgerId === peer.costLedgerId)
  ) {
    return {
      ...protocolBase,
      invalidReason:
        "WebGPU and WebGL refresh-cost lanes reuse a session token or ledger identity",
    };
  }
  if (
    live.sweepFrames !== SWEEP_FRAMES ||
    protocol.sweepFrames !== SWEEP_FRAMES
  ) {
    return {
      ...protocolBase,
      invalidReason: `refresh-cost sweep length diverges from the ratified ${SWEEP_FRAMES} frames (lane ${String(live.sweepFrames)}, ledger ${String(protocol.sweepFrames)})`,
    };
  }
  if (protocol.segmentsPerLeg !== REFRESH_COST_SEGMENTS_PER_LEG) {
    return {
      ...protocolBase,
      invalidReason: `refresh-cost protocol declares ${String(protocol.segmentsPerLeg)} pairs per leg, not exactly ${REFRESH_COST_SEGMENTS_PER_LEG}`,
    };
  }
  const gpuHeader = protocol.gpuTime;
  if (!gpuHeader || typeof gpuHeader !== "object") {
    return {
      ...protocolBase,
      invalidReason: "refresh-cost protocol has no GPU-time instrument header",
    };
  }
  for (const [field, expected] of Object.entries(
    REFRESH_COST_GPU_TIME_PROTOCOL,
  )) {
    const actual = gpuHeader[field];
    const matches = Array.isArray(expected)
      ? Array.isArray(actual) &&
        actual.length === expected.length &&
        actual.every((value, index) => value === expected[index])
      : actual === expected;
    if (!matches) {
      return {
        ...protocolBase,
        invalidReason: `refresh-cost GPU-time protocol ${field}=${String(actual)} does not match ${expected}`,
      };
    }
  }
  if (
    typeof gpuHeader.featureAvailable !== "boolean" ||
    typeof gpuHeader.available !== "boolean" ||
    !gpuResolutionIsValid(gpuHeader)
  ) {
    return {
      ...protocolBase,
      invalidReason:
        "refresh-cost GPU-time protocol lacks explicit availability or timestamp-resolution flags",
    };
  }
  if (
    gpuHeader.available
      ? gpuHeader.featureAvailable !== true ||
        gpuHeader.unavailableReason !== null
      : typeof gpuHeader.unavailableReason !== "string" ||
        gpuHeader.unavailableReason.length === 0
  ) {
    return {
      ...protocolBase,
      invalidReason:
        "refresh-cost GPU-time protocol availability contradicts its feature or reason fields",
    };
  }
  if (
    !gpuHeader.available &&
    expectedBackend === "webgl" &&
    gpuHeader.unavailableReason !== REFRESH_COST_WEBGL_GPU_UNAVAILABLE_REASON
  ) {
    return {
      ...protocolBase,
      invalidReason: `WebGL GPU-time protocol must name its renderer limitation exactly: ${REFRESH_COST_WEBGL_GPU_UNAVAILABLE_REASON}`,
    };
  }
  if (
    !gpuHeader.available &&
    expectedBackend === "webgpu" &&
    gpuHeader.featureAvailable === false &&
    gpuHeader.unavailableReason !== REFRESH_COST_WEBGPU_GPU_UNAVAILABLE_REASON
  ) {
    return {
      ...protocolBase,
      invalidReason: `WebGPU GPU-time protocol must name its missing feature exactly: ${REFRESH_COST_WEBGPU_GPU_UNAVAILABLE_REASON}`,
    };
  }
  if (
    !Array.isArray(live.factors) ||
    live.factors.length !== SWEEP_FRAMES ||
    !Array.isArray(protocol.factorSchedule) ||
    protocol.factorSchedule.length !== SWEEP_FRAMES
  ) {
    return {
      ...protocolBase,
      invalidReason: `refresh-cost factor schedule must carry exactly ${SWEEP_FRAMES} live and ledger entries`,
    };
  }
  if (
    !Array.isArray(live.obscurations) ||
    live.obscurations.length !== SWEEP_FRAMES
  ) {
    return {
      ...protocolBase,
      invalidReason: `refresh-cost lane must carry exactly ${SWEEP_FRAMES} realized obscurations beside its factors`,
    };
  }
  // The sweep's clock instants are solved for the ratified obscuration ramp,
  // so the REALIZED obscuration each frame carries a solve residual well
  // inside the schedule band but far outside the f64 factor band. The factor
  // is therefore checked against the obscuration the engine actually saw
  // (same input, f64 band), and the obscuration against the ramp (schedule
  // band) - comparing the factor straight against the ramp's prediction
  // turned that residual into a false structural failure.
  for (let index = 0; index < SWEEP_FRAMES; index++) {
    const laneFactor = live.factors[index];
    const ledgerFactor = protocol.factorSchedule[index];
    if (!Number.isFinite(laneFactor) || !Object.is(ledgerFactor, laneFactor)) {
      return {
        ...protocolBase,
        invalidReason: `refresh-cost factor schedule diverges from the live lane at frame ${index}`,
      };
    }
    const realizedObscuration = live.obscurations[index];
    if (
      !Number.isFinite(realizedObscuration) ||
      Math.abs(laneFactor - predictFactor(realizedObscuration)) >
        ECLIPSE_CLOUD_BANDS.factorTolerance.hi
    ) {
      return {
        ...protocolBase,
        invalidReason: `live refresh-cost factor does not match its realized obscuration at frame ${index}`,
      };
    }
    const rampIndex =
      index < SWEEP_RISING_FRAMES ? index : SWEEP_FRAMES - 1 - index;
    const scheduledObscuration =
      (SWEEP_PEAK_OBSCURATION * rampIndex) / (SWEEP_RISING_FRAMES - 1);
    if (
      Math.abs(realizedObscuration - scheduledObscuration) >
      ECLIPSE_CLOUD_BANDS.scheduleObscurationTolerance.hi
    ) {
      return {
        ...protocolBase,
        invalidReason: `live refresh-cost factor schedule misses the ratified sweep at frame ${index}`,
      };
    }
  }

  const segmentsPerLeg = a.segmentsPerLeg;
  const ledgerBase = {
    ...protocolBase,
    segmentsPerLeg: Number.isSafeInteger(segmentsPerLeg)
      ? segmentsPerLeg
      : null,
    retainedSegmentCount: a.segments.length,
    protocolBound: true,
  };
  // RULE 2 — exactly the ratified eight-pair ABBA protocol. A different N is a
  // different estimator even if it remains internally self-consistent.
  if (segmentsPerLeg !== REFRESH_COST_SEGMENTS_PER_LEG) {
    return {
      ...ledgerBase,
      invalidReason: `the refresh-cost ledger has ${String(segmentsPerLeg)} pairs per leg, not exactly the ratified ${REFRESH_COST_SEGMENTS_PER_LEG}`,
    };
  }
  if (a.segments.length !== 2 * segmentsPerLeg) {
    return {
      ...ledgerBase,
      invalidReason: `the refresh-cost ledger has ${a.segments.length} records, not the exact 2*N cardinality ${2 * segmentsPerLeg} for ${segmentsPerLeg} segment pairs`,
    };
  }

  // RULE 1 — two retained, per-leg, full-schedule warm-up witnesses. A single
  // `warmupBothLegs: true` summary is not evidence that either loop ran.
  if (!Array.isArray(a.warmups) || a.warmups.length !== 2) {
    return {
      ...ledgerBase,
      warmupWitnessCount: Array.isArray(a.warmups) ? a.warmups.length : null,
      invalidReason: `warm-up parity has ${Array.isArray(a.warmups) ? a.warmups.length : 0} per-leg witness(es), not exactly two`,
    };
  }
  const withWarmups = {
    ...ledgerBase,
    warmupWitnessCount: a.warmups.length,
  };
  const warmupsByLeg = new Map();
  for (const [index, witness] of a.warmups.entries()) {
    if (!witness || typeof witness !== "object") {
      return {
        ...withWarmups,
        invalidReason: `warm-up witness ${index} is not an object`,
      };
    }
    if (witness.leg !== "eclipse" && witness.leg !== "control") {
      return {
        ...withWarmups,
        invalidReason: `warm-up witness ${index} names unknown leg ${String(witness.leg)}`,
      };
    }
    if (warmupsByLeg.has(witness.leg)) {
      return {
        ...withWarmups,
        invalidReason: `warm-up witnesses duplicate the ${witness.leg} leg`,
      };
    }
    if (witness.ledgerId !== protocol.ledgerId) {
      return {
        ...withWarmups,
        invalidReason: `the ${witness.leg} warm-up witness is not bound to refresh-cost ledger ${protocol.ledgerId}`,
      };
    }
    if (witness.completed !== true) {
      return {
        ...withWarmups,
        invalidReason: `the ${witness.leg} warm-up did not retain a completed full-schedule witness`,
      };
    }
    if (
      !Number.isSafeInteger(witness.from) ||
      !Number.isSafeInteger(witness.to) ||
      !Number.isSafeInteger(witness.frames) ||
      witness.from !== 0 ||
      witness.to !== SWEEP_FRAMES ||
      witness.frames !== SWEEP_FRAMES
    ) {
      return {
        ...withWarmups,
        invalidReason: `the ${witness.leg} warm-up witness does not cover the exact ratified schedule 0..${SWEEP_FRAMES} (${String(witness.from)}..${String(witness.to)}, ${String(witness.frames)} frames)`,
      };
    }
    warmupsByLeg.set(witness.leg, witness);
  }
  const eclipseWarmup = warmupsByLeg.get("eclipse");
  const controlWarmup = warmupsByLeg.get("control");
  if (!eclipseWarmup || !controlWarmup) {
    return {
      ...withWarmups,
      invalidReason:
        "warm-up parity requires one completed eclipse witness and one completed control witness",
    };
  }
  if (
    eclipseWarmup.from !== controlWarmup.from ||
    eclipseWarmup.to !== controlWarmup.to ||
    eclipseWarmup.frames !== controlWarmup.frames
  ) {
    return {
      ...withWarmups,
      invalidReason: `the warm-up witnesses cover different schedules (${eclipseWarmup.from}..${eclipseWarmup.to} eclipse vs ${controlWarmup.from}..${controlWarmup.to} control)`,
    };
  }
  if (a.warmupBothLegs !== true) {
    return {
      ...withWarmups,
      invalidReason:
        "warm-up parity summary disagrees with the two completed per-leg witnesses",
    };
  }

  const totals = {
    eclipse: { frames: 0, wallMs: 0, gpuMs: 0, fills: 0, refreshes: 0 },
    control: { frames: 0, wallMs: 0, gpuMs: 0, fills: 0, refreshes: 0 },
  };
  const refreshMeasurementInvalidReasons = [];
  const gpuMeasurementInvalidReasons = [];
  const expectedBounds = deriveRefreshCostSegmentBounds();
  let nextFrom = 0;
  for (let pairIndex = 0; pairIndex < segmentsPerLeg; pairIndex++) {
    const pair = a.segments.slice(2 * pairIndex, 2 * pairIndex + 2);
    const expectedLegs =
      (pairIndex & 1) === 0 ? ["eclipse", "control"] : ["control", "eclipse"];
    for (let position = 0; position < pair.length; position++) {
      const segment = pair[position];
      const expectedLeg = expectedLegs[position];
      if (!segment || typeof segment !== "object") {
        return {
          ...withWarmups,
          invalidReason: `refresh-cost segment ${2 * pairIndex + position} is not an object`,
        };
      }
      if (segment.pairIndex !== pairIndex) {
        return {
          ...withWarmups,
          invalidReason: `refresh-cost segment ${2 * pairIndex + position} carries pairIndex ${String(segment.pairIndex)}, expected ${pairIndex}`,
        };
      }
      if (segment.leg !== expectedLeg) {
        return {
          ...withWarmups,
          invalidReason: `refresh-cost pair ${pairIndex} violates ABBA order at position ${position}: ${String(segment.leg)} appeared where ${expectedLeg} was required`,
        };
      }
      if (segment.ledgerId !== protocol.ledgerId) {
        return {
          ...withWarmups,
          invalidReason: `refresh-cost pair ${pairIndex} ${segment.leg} is not bound to ledger ${protocol.ledgerId}`,
        };
      }
      if (
        !Number.isSafeInteger(segment.from) ||
        !Number.isSafeInteger(segment.to) ||
        segment.from < 0 ||
        segment.to <= segment.from
      ) {
        return {
          ...withWarmups,
          invalidReason: `refresh-cost pair ${pairIndex} ${segment.leg} has invalid integer bounds ${String(segment.from)}..${String(segment.to)}`,
        };
      }
      if (
        !Number.isSafeInteger(segment.frames) ||
        segment.frames < 0 ||
        segment.frames !== segment.to - segment.from
      ) {
        return {
          ...withWarmups,
          invalidReason: `refresh-cost pair ${pairIndex} ${segment.leg} has invalid integer frame count ${String(segment.frames)} for bounds ${segment.from}..${segment.to}`,
        };
      }
      if (
        !Number.isSafeInteger(segment.fills) ||
        segment.fills < 0 ||
        segment.fills > segment.frames
      ) {
        return {
          ...withWarmups,
          invalidReason: `refresh-cost pair ${pairIndex} ${segment.leg} has invalid integer fill count ${String(segment.fills)} for ${segment.frames} frames`,
        };
      }
      if (
        !Number.isSafeInteger(segment.refreshes) ||
        segment.refreshes < 0 ||
        segment.refreshes > segment.frames
      ) {
        return {
          ...withWarmups,
          invalidReason: `refresh-cost pair ${pairIndex} ${segment.leg} has invalid integer environment-refresh count ${String(segment.refreshes)} for ${segment.frames} frames`,
        };
      }
      if (!Number.isFinite(segment.wallMs) || segment.wallMs < 0) {
        return {
          ...withWarmups,
          invalidReason: `refresh-cost pair ${pairIndex} ${segment.leg} has invalid non-negative wall time ${String(segment.wallMs)}`,
        };
      }
    }

    const [first, second] = pair;
    if (
      first.from !== second.from ||
      first.to !== second.to ||
      first.frames !== second.frames
    ) {
      return {
        ...withWarmups,
        invalidReason: `refresh-cost pair ${pairIndex} does not share bounds/frame count (${first.from}..${first.to}/${first.frames} vs ${second.from}..${second.to}/${second.frames})`,
      };
    }
    const [expectedFrom, expectedTo] = expectedBounds[pairIndex];
    if (
      first.from !== expectedFrom ||
      first.to !== expectedTo ||
      first.frames !== expectedTo - expectedFrom
    ) {
      return {
        ...withWarmups,
        invalidReason: `refresh-cost pair ${pairIndex} covers ${first.from}..${first.to}/${first.frames}, not the independently derived ratified bounds ${expectedFrom}..${expectedTo}/${expectedTo - expectedFrom}`,
      };
    }
    if (first.from !== nextFrom) {
      return {
        ...withWarmups,
        invalidReason: `refresh-cost pair ${pairIndex} starts at ${first.from}, expected contiguous schedule bound ${nextFrom}`,
      };
    }
    nextFrom = first.to;
    for (const segment of pair) {
      const label = `refresh-cost pair ${pairIndex} ${segment.leg}`;
      const refreshWitness = readRefreshCostRefreshWitness(
        segment,
        expectedBackend,
        label,
      );
      if (refreshWitness.schemaError) {
        return {
          ...withWarmups,
          invalidReason: refreshWitness.schemaError,
        };
      }
      if (!refreshWitness.valid) {
        // Nothing downstream can be read off a segment whose own per-frame
        // witness failed: its derived count is absent, so a GPU cardinality
        // check here would report "for null refreshes" and bury the cause.
        refreshMeasurementInvalidReasons.push(refreshWitness.invalidReason);
        continue;
      }
      // The DERIVED count, never the declared field.
      const segmentRefreshes = refreshWitness.submittedTotal;
      const gpuSegment = readRefreshCostGpuSegment(
        segment.gpuTime,
        gpuHeader,
        segment.frames,
        segmentRefreshes,
        segment.fills,
        label,
      );
      if (gpuSegment.schemaError) {
        return {
          ...withWarmups,
          invalidReason: gpuSegment.schemaError,
        };
      }
      if (gpuSegment.valid) {
        totals[segment.leg].gpuMs += gpuSegment.totalMs;
        if (!Number.isFinite(totals[segment.leg].gpuMs)) {
          return {
            ...withWarmups,
            invalidReason: `the ${segment.leg} segment GPU-time sum overflowed`,
          };
        }
      } else if (gpuHeader.available) {
        gpuMeasurementInvalidReasons.push(
          formatRefreshCostSegmentReason(
            pairIndex,
            segment.leg,
            gpuSegment.invalidReason,
          ),
        );
      }
      totals[segment.leg].frames += segment.frames;
      totals[segment.leg].wallMs += segment.wallMs;
      totals[segment.leg].fills += segment.fills;
      totals[segment.leg].refreshes += segmentRefreshes;
      if (!Number.isFinite(totals[segment.leg].wallMs)) {
        return {
          ...withWarmups,
          invalidReason: `the ${segment.leg} segment wall-time sum overflowed`,
        };
      }
    }
  }

  // A broken per-frame witness is refused BEFORE any aggregate is compared:
  // the derived count is what every total below is built from, so an aggregate
  // mismatch computed on top of it would report a downstream symptom instead of
  // the cause.
  if (refreshMeasurementInvalidReasons.length > 0) {
    return {
      ...withWarmups,
      invalidReason: refreshMeasurementInvalidReasons.join(" | "),
    };
  }

  const scheduleFrames = eclipseWarmup.frames;
  if (nextFrom !== scheduleFrames) {
    return {
      ...withWarmups,
      invalidReason: `the refresh-cost segment bounds end at ${nextFrom}, not the warm-up schedule end ${scheduleFrames}`,
    };
  }
  if (
    totals.eclipse.frames !== scheduleFrames ||
    totals.control.frames !== scheduleFrames
  ) {
    return {
      ...withWarmups,
      invalidReason: `the two legs do not each cover the warmed schedule (${totals.eclipse.frames} eclipse, ${totals.control.frames} control, ${scheduleFrames} required)`,
    };
  }

  const out = {
    ...withWarmups,
    eclipseWallMs: totals.eclipse.wallMs,
    controlWallMs: totals.control.wallMs,
    eclipseFills: totals.eclipse.fills,
    controlFills: totals.control.fills,
    eclipseRefreshes: totals.eclipse.refreshes,
    controlRefreshes: totals.control.refreshes,
    eclipseFrames: totals.eclipse.frames,
    controlFrames: totals.control.frames,
    warmupBothLegs: true,
    derivedFromSegments: true,
  };

  // Aggregates are redundancy checks only. Every output above came from the
  // primitive ledger; a forged or stale summary makes the evidence STRUCTURAL.
  for (const [field, derived] of [
    ["eclipseFrames", out.eclipseFrames],
    ["controlFrames", out.controlFrames],
    ["eclipseWallMs", out.eclipseWallMs],
    ["controlWallMs", out.controlWallMs],
    ["eclipseFills", out.eclipseFills],
    ["controlFills", out.controlFills],
    ["eclipseRefreshes", out.eclipseRefreshes],
    ["controlRefreshes", out.controlRefreshes],
  ]) {
    if (!Object.is(a[field], derived)) {
      return {
        ...out,
        invalidReason: `declared refresh-cost aggregate ${field}=${String(a[field])} does not equal the retained segment total ${String(derived)}`,
      };
    }
  }

  const aggregateGpu = a.gpuTime;
  if (!aggregateGpu || typeof aggregateGpu !== "object") {
    return {
      ...out,
      invalidReason: "the refresh-cost ledger has no aggregate GPU-time block",
    };
  }
  if (!gpuResolutionMatches(aggregateGpu, gpuHeader)) {
    return {
      ...out,
      invalidReason:
        "aggregate GPU timestamp resolution does not match the protocol header",
    };
  }
  const captureHook = aggregateGpu.captureHook;
  const captureHookValid = gpuHeader.available
    ? captureHook?.installed === true &&
      captureHook.restored === true &&
      captureHook.originalIdentityRestored === true
    : captureHook?.installed === false &&
      captureHook.restored === true &&
      captureHook.originalIdentityRestored === true;
  if (!captureHookValid && !gpuHeader.available) {
    return {
      ...out,
      invalidReason:
        "the GPU-unavailable ledger has a malformed capture-hook witness",
    };
  }
  if (!captureHookValid && gpuHeader.available) {
    gpuMeasurementInvalidReasons.push(
      "GPU timestamp capture hook was not installed and restored exactly",
    );
  }
  const gpuMeasurementInvalidReason =
    gpuMeasurementInvalidReasons.length > 0
      ? gpuMeasurementInvalidReasons.join(" | ")
      : null;
  const gpuAggregateValid =
    gpuHeader.available && gpuMeasurementInvalidReason === null;
  const expectedGpuAggregate = gpuHeader.available
    ? {
        status: gpuAggregateValid ? "valid" : "invalid",
        available: true,
        valid: gpuAggregateValid,
        eclipseMs: gpuAggregateValid ? totals.eclipse.gpuMs : null,
        controlMs: gpuAggregateValid ? totals.control.gpuMs : null,
        invalidReason: gpuAggregateValid ? null : gpuMeasurementInvalidReason,
      }
    : {
        status: "unavailable",
        available: false,
        valid: false,
        eclipseMs: null,
        controlMs: null,
        invalidReason: gpuHeader.unavailableReason,
      };
  for (const [field, expected] of Object.entries(expectedGpuAggregate)) {
    if (!Object.is(aggregateGpu[field], expected)) {
      return {
        ...out,
        invalidReason: `declared aggregate GPU-time ${field}=${String(aggregateGpu[field])} does not equal the segment-derived value ${String(expected)}`,
      };
    }
  }
  const withGpu = {
    ...out,
    eclipseGpuMs: expectedGpuAggregate.eclipseMs,
    controlGpuMs: expectedGpuAggregate.controlMs,
    gpuTime: {
      ...expectedGpuAggregate,
      resolutionKnown: gpuHeader.resolutionKnown,
      resolutionNs: gpuHeader.resolutionNs,
    },
  };

  const fillDelta = withGpu.eclipseFills - withGpu.controlFills;
  const refreshDelta = withGpu.eclipseRefreshes - withGpu.controlRefreshes;
  const measuredCounts = {
    ...withGpu,
    fillDelta,
    refreshDelta,
  };
  if (!(refreshDelta > 0)) {
    return {
      ...measuredCounts,
      invalidReason: `no positive environment-refresh differential to attribute cost to (${withGpu.eclipseRefreshes} eclipse vs ${withGpu.controlRefreshes} control) — this run's fresh differential cannot be formed`,
    };
  }

  const wallMsDelta = withGpu.eclipseWallMs - withGpu.controlWallMs;
  const wallMsPerRefresh = wallMsDelta / refreshDelta;
  const wallClockRole =
    gpuHeader.available || expectedBackend === "webgpu"
      ? "bound"
      : "figure-of-record";
  const measuredBase = {
    ...measuredCounts,
    wallMsDelta,
    wallMsPerRefresh,
    wallClockRole,
  };

  if (gpuHeader.available && !gpuAggregateValid) {
    return {
      ...measuredBase,
      invalidReason: gpuMeasurementInvalidReason,
    };
  }

  const gpuTime = measuredBase.gpuTime;
  if (gpuTime.valid) {
    const gpuMsDelta = withGpu.eclipseGpuMs - withGpu.controlGpuMs;
    const gpuMsPerRefresh = gpuMsDelta / refreshDelta;
    const gpuMeasured = {
      ...measuredBase,
      measurementSource: "gpu-time",
      msDelta: gpuMsDelta,
      gpuMsDelta,
      gpuMsPerRefresh: gpuMsDelta < 0 ? null : gpuMsPerRefresh,
      gpuTime: {
        ...measuredBase.gpuTime,
        msDelta: gpuMsDelta,
        msPerRefresh: gpuMsDelta < 0 ? null : gpuMsPerRefresh,
      },
    };
    if (gpuMsDelta < 0) {
      return {
        ...gpuMeasured,
        invalidReason: `the environment-refresh GPU differential is negative (${withGpu.controlGpuMs} ms control vs ${withGpu.eclipseGpuMs} ms eclipse over the same ${withGpu.eclipseFrames} frames) — no per-refresh cost can be attributed to the submitted refreshes`,
      };
    }
    if (gpuMsDelta === 0 && gpuTime.resolutionKnown !== true) {
      return {
        ...gpuMeasured,
        invalidReason: `the environment-refresh GPU differential is exactly 0 ms over ${refreshDelta} submitted refreshes at an undeclared timestamp resolution — indistinguishable from a pass below one quantum, so it is a bound and not a figure`,
      };
    }
    return {
      ...gpuMeasured,
      msPerRefresh: gpuMsPerRefresh,
      valid: true,
    };
  }

  if (expectedBackend === "webgpu") {
    return {
      ...measuredBase,
      invalidReason: gpuHeader.unavailableReason,
    };
  }

  const wallFallback = {
    ...measuredBase,
    measurementSource: "wall-clock-fallback",
    fallbackReason: gpuHeader.unavailableReason,
    msDelta: wallMsDelta,
  };
  if (wallMsDelta < 0) {
    return {
      ...wallFallback,
      invalidReason: `the control leg outran the eclipse leg (${withGpu.controlWallMs} ms control vs ${withGpu.eclipseWallMs} ms eclipse over the same ${withGpu.eclipseFrames} frames) — the differential is negative, so no per-refresh cost can be attributed to the submitted refreshes`,
    };
  }
  return {
    ...wallFallback,
    msPerRefresh: wallMsPerRefresh,
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

// `null` rather than NaN when either read is absent, so a missing ABBA replica
// fails `inBand` and blinds the lane instead of silently passing it: an absent
// convergence check is exactly as uninformative as a failed one.
const absDelta = (a, b) =>
  Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) : null;

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
  const deckFreeControl = cloud.deckFreeControl;
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
    const scheduleFailures = rungs.flatMap((rung, index) => {
      const published = rung?.published;
      const scheduled = rung?.scheduledObscuration;
      const observed = published?.moonObscuration;
      const failures = [];
      if (published?.valid !== true) {
        failures.push(`rung ${index} published eclipse state is not valid`);
      }
      if (published?.enabled !== true) {
        failures.push(`rung ${index} published eclipse state is not enabled`);
      }
      if (!Number.isFinite(scheduled) || !Number.isFinite(observed)) {
        failures.push(`rung ${index} schedule obscuration is not finite`);
      } else if (
        Math.abs(observed - scheduled) > B.scheduleObscurationTolerance.hi
      ) {
        failures.push(
          `rung ${index} published obscuration ${observed} drifted from scheduled ${scheduled}`,
        );
      }
      return failures;
    });
    v.mainPageScheduleCertified =
      rungs.length > 0 && scheduleFailures.length === 0;
    if (!v.mainPageScheduleCertified) {
      markBlind(
        "cloud-page",
        `webgpu-cloud schedule certification failed: ${
          scheduleFailures.join("; ") || "no ladder rungs were published"
        }`,
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
    v.deckFreeControlStateIsolated =
      deckFreeControl?.stateIsolated === true &&
      deckFreeControl?.schema === "c13-41-deckfree-control-v5";
    if (!v.deckFreeControlStateIsolated) {
      markBlind(
        "deck-free",
        `the deck-free control is not four fresh ABBA configure epochs with pinned lighting and certified factors: ${(deckFreeControl?.isolationReasons ?? ["control evidence is absent"]).join("; ")}`,
      );
    }
    v.deckFreeGroundIsLit = deckFreeControl?.litSurfaceNonVacuous === true;
    if (!v.deckFreeGroundIsLit) {
      markBlind(
        "deck-free",
        (
          deckFreeControl?.nonVacuityReasons ?? [
            "deck-free lit-surface evidence is absent",
          ]
        ).join("; "),
      );
    }
    const shadowPlumbingFailures = rungs.flatMap((rung, index) => {
      const shadow = rung.shadow ?? {};
      const footprint = shadow.footprintOff;
      const footprintSamples = footprint?.samples;
      const producerOff = shadow.cloudCacheOff;
      const producerOn = shadow.cloudCacheOn;
      const failures = [];
      if (
        shadow.shadowActiveOff !== true ||
        producerOff?.shadowActive !== true ||
        producerOff?.shadowViewPresent !== true ||
        producerOff?.shadowFrameValid !== true
      ) {
        failures.push(`rung ${index} clear shadow producer is not live`);
      }
      if (
        shadow.shadowActiveOn !== true ||
        producerOn?.shadowActive !== true ||
        producerOn?.shadowViewPresent !== true ||
        producerOn?.shadowFrameValid !== true
      ) {
        failures.push(`rung ${index} eclipse shadow producer is not live`);
      }
      if (
        footprint?.allInside !== true ||
        !Array.isArray(footprintSamples) ||
        footprintSamples.length === 0 ||
        !footprintSamples.every(
          (sample) => sample?.groundHit === true && sample?.inside === true,
        )
      ) {
        failures.push(
          `rung ${index} scored ground band is outside the shadow footprint`,
        );
      }
      return failures;
    });
    v.shadowProducerAndFootprintCertified =
      rungs.length > 0 && shadowPlumbingFailures.length === 0;
    if (!v.shadowProducerAndFootprintCertified) {
      markBlind(
        "shadow",
        `cloud-shadow producer/footprint certification failed: ${
          shadowPlumbingFailures.join("; ") || "no shadow rungs were captured"
        }`,
      );
    }
    v.shadowGroundOnly = rungs[0]?.shadow?.offNoCloud ?? null;
    v.shadowGroundRetentionRatio = ratio(
      rungs[0]?.shadow?.offNoShadow,
      rungs[0]?.shadow?.offNoCloud,
    );
    if (!isBlind("deck-free")) {
      v.shadowGroundIsBright = inBand(
        v.shadowGroundOnly,
        B.shadowGroundBrightness,
      );
      if (!v.shadowGroundIsBright) {
        markBlind(
          "deck-free",
          `the deck-free ground band reads ${v.shadowGroundOnly} against the ${B.shadowGroundBrightness.lo} brightness floor — the cast shadow's 0.35 beer floor can remove at most 65% of that, so the ${B.shadowVacuityCeiling.hi} contrast ceiling is unreachable however well the shadow works`,
        );
      }
      v.shadowGroundNotOccluded = inBand(
        v.shadowGroundRetentionRatio,
        B.shadowGroundRetention,
      );
      if (!v.shadowGroundNotOccluded) {
        markBlind(
          "deck-free",
          `turning the deck on moves the ground band by ${v.shadowGroundRetentionRatio}x (outside [${B.shadowGroundRetention.lo}, ${B.shadowGroundRetention.hi}]) — the scored band is not the ground, so its contrast is not the cast shadow's`,
        );
      }
    }
    // ── THE FRESH-SESSION REPLICATION DETECTOR ───────────────────────────────
    // Both deck-free ABBA replicas, on both legs, against the one code value
    // this instrument can resolve. A drift makes EVERY deck-free attribution
    // below it session-dependent rather than a measurement of the engine.
    // STRUCTURAL for the same reason
    // `shadowGroundIsBright` is: the lane cannot answer, and pretending it did
    // is how the fifth run's 0.449 became attributable to two different causes.
    v.deckFreeGroundSettleDelta = rungs.map((rung) => {
      const s = rung.shadow ?? {};
      const offDelta = absDelta(s.offNoCloudSettled, s.offNoCloud);
      const onDelta = absDelta(s.onNoCloudSettled, s.onNoCloud);
      return {
        obscuration: rung.published?.moonObscuration ?? null,
        offFirst: Number.isFinite(s.offNoCloud) ? s.offNoCloud : null,
        offSettled: Number.isFinite(s.offNoCloudSettled)
          ? s.offNoCloudSettled
          : null,
        offDelta,
        onFirst: Number.isFinite(s.onNoCloud) ? s.onNoCloud : null,
        onSettled: Number.isFinite(s.onNoCloudSettled)
          ? s.onNoCloudSettled
          : null,
        onDelta,
        settled:
          inBand(offDelta, B.deckFreeGroundSettleDelta) &&
          inBand(onDelta, B.deckFreeGroundSettleDelta),
      };
    });
    v.deckFreeGroundCapturesSettled =
      v.deckFreeGroundSettleDelta.length > 0 &&
      v.deckFreeGroundSettleDelta.every((entry) => entry.settled === true);
    if (!isBlind("deck-free") && !v.deckFreeGroundCapturesSettled) {
      const worst = v.deckFreeGroundSettleDelta.find(
        (entry) => entry.settled !== true,
      );
      markBlind(
        "deck-free",
        `the fresh deck-free ABBA sessions did not reproduce within one capture code at obscuration ${worst?.obscuration}: eclipse-OFF sessions differ by ${worst?.offDelta} (${worst?.offFirst} vs ${worst?.offSettled}) and eclipse-ON sessions differ by ${worst?.onDelta} (${worst?.onFirst} vs ${worst?.onSettled}) against the ${B.deckFreeGroundSettleDelta.hi} bracket — the attribution is session-dependent and not an engine measurement`,
      );
    }
    // The ON-leg twin of `shadowGroundRetentionRatio`, REPORTED not gated. The
    // OFF-leg ratio says the scored band is ground; this one says whether it is
    // still ground once the eclipse is on. The fifth run read 0.9894 off and
    // 2.2035 on — the deck-present and deck-free bands cannot both be measuring
    // the same surface, and that contradiction is the whole CO-21 question. It
    // does not gate because which of the two readings is wrong is exactly what
    // `deckFreeGroundCapturesSettled` decides.
    v.deckFreeGroundOnRetentionRatio = ratio(
      rungs[0]?.shadow?.onNoShadow,
      rungs[0]?.shadow?.onNoCloud,
    );
    v.deckFreeGroundRetentionLegsAgreeReportedOnly = inBand(
      ratio(v.deckFreeGroundOnRetentionRatio, v.shadowGroundRetentionRatio),
      B.shadowGroundRetention,
    );
    v.shadowContrastClear = ratio(
      rungs[0]?.shadow?.offShadow,
      rungs[0]?.shadow?.offNoShadow,
    );
    if (!isBlind("shadow")) {
      const decrementFailures = rungs.flatMap((rung, index) => {
        const clear = rung.shadow?.offNoShadow - rung.shadow?.offShadow;
        const eclipse = rung.shadow?.onNoShadow - rung.shadow?.onShadow;
        const failures = [];
        if (
          !Number.isFinite(clear) ||
          !(clear > BAND_MEAN_QUANTIZATION_HALF_STEP * 2)
        ) {
          failures.push(
            `rung ${index}: clear ground contrast decrement ${clear} does not exceed one display code`,
          );
        }
        if (!Number.isFinite(eclipse) || !(eclipse > 0)) {
          failures.push(
            `rung ${index}: eclipse ground contrast decrement ${eclipse} is not positive`,
          );
        }
        return failures;
      });
      v.shadowNonVacuous =
        Number.isFinite(v.shadowContrastClear) &&
        v.shadowContrastClear <= B.shadowVacuityCeiling.hi &&
        v.shadowContrastClear > 0 &&
        decrementFailures.length === 0;
      if (!v.shadowNonVacuous) {
        markBlind(
          "shadow",
          `cloud-shadow decrement is not non-vacuous: ${
            decrementFailures.join("; ") ||
            `clear contrast ${v.shadowContrastClear} is outside (0, ${B.shadowVacuityCeiling.hi}]`
          }`,
        );
      }
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
    const observed = rung.published?.moonObscuration;
    const scheduled = rung.scheduledObscuration;
    const expected = predictFactor(observed);
    return (
      rung.published?.valid === true &&
      rung.published?.enabled === true &&
      Number.isFinite(scheduled) &&
      Number.isFinite(observed) &&
      Math.abs(observed - scheduled) <= B.scheduleObscurationTolerance.hi &&
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
    (rung) =>
      rung.publishedOff?.shadowStrength === 1 && rung.shadow?.strengthOff === 1,
  );
  v.shadowStrengthMatchesDirectional = rungs.every((rung) => {
    const publishedMeasured = rung.published?.shadowStrength;
    const publishedExpected = predictDirectional(
      rung.published?.moonObscuration ?? 0,
    );
    const producerMeasured = rung.shadow?.strengthOn;
    const producerExpected = predictDirectional(
      rung.deckFreePublished?.moonObscuration ?? 0,
    );
    return (
      Number.isFinite(publishedMeasured) &&
      Math.abs(publishedMeasured - publishedExpected) <=
        B.strengthTolerance.hi &&
      Number.isFinite(producerMeasured) &&
      Math.abs(producerMeasured - producerExpected) <= B.strengthTolerance.hi
    );
  });
  const contrastRatioAt = (rung) => {
    const on = ratio(rung?.shadow?.onShadow, rung?.shadow?.onNoShadow);
    const off = ratio(rung?.shadow?.offShadow, rung?.shadow?.offNoShadow);
    return ratio(on, off);
  };
  // The original raw image criterion. ProceduralClouds composites an
  // independently tone-mapped cloud term after the terrain shadow, which is a
  // known mechanism confound, but R-2026-08-14-1 explicitly restored this
  // unchanged [0.97, 1.03] reading as the operative prediction-(ii) gate. The
  // decrement model below remains a separately scored diagnostic mechanism; it
  // cannot replace or erase a valid raw miss.
  v.shadowContrastRatioAtDeepest = contrastRatioAt(deepest);
  v.shadowContrastRatioAtDiscriminating = contrastRatioAt(discriminating);
  v.shadowCompositeContrastRatioAtDeepest = v.shadowContrastRatioAtDeepest;
  v.shadowCompositeContrastRatioAtDiscriminating =
    v.shadowContrastRatioAtDiscriminating;
  v.shadowContrastInvariant = inBand(
    v.shadowContrastRatioAtDeepest,
    B.shadowContrastRatio,
  );
  v.shadowDecrementModel = rungs.map((rung) => {
    const deckFreeObscuration = rung.deckFreePublished?.moonObscuration;
    const alternativeStrengthRatio = Number.isFinite(deckFreeObscuration)
      ? predictFactor(deckFreeObscuration)
      : null;
    return {
      obscuration: Number.isFinite(deckFreeObscuration)
        ? deckFreeObscuration
        : null,
      ...evaluateShadowDecrementModel({
        shadow: rung.shadow,
        strengthClear: rung.shadow?.strengthOff,
        strengthEclipse: rung.shadow?.strengthOn,
        alternativeStrengthRatio,
      }),
    };
  });
  v.shadowDecrementModelAtDeepest =
    v.shadowDecrementModel[v.shadowDecrementModel.length - 1] ?? null;
  v.shadowDecrementMatchesGroundDim =
    v.shadowDecrementModel.length > 0 &&
    v.shadowDecrementModel.every(
      (entry) => entry.valid === true && entry.withinQuantizationBound === true,
    );
  // The REJECTED design's prediction at the discriminating rung, computed here
  // so the report carries both the historical contrast number and the decrement
  // interval the gate actually excludes. `s = F` instead of `s = Fd`.
  const discriminatingObscuration =
    discriminating?.published?.moonObscuration ?? 0;
  v.rejectedDesignContrastRatio =
    shadowContrast(predictFactor(discriminatingObscuration)) /
    shadowContrast(1.0);
  v.shadowDecrementRejectsAlternativeDesign =
    v.shadowDecrementModel.length > 0 &&
    v.shadowDecrementModel[rungs.indexOf(discriminating)]?.valid === true &&
    v.shadowDecrementModel[rungs.indexOf(discriminating)]
      ?.alternativeWithinQuantizationBound === false;
  // The extension is an arithmetic property of the model, not of this run.
  v.shadowContrastModelIsBoundedByDirectional =
    shadowContrastModelIsBoundedByDirectional();

  // ── THE DECK-FREE ATTRIBUTION LEG (CO-19) ────────────────────────────────
  // `onNoCloud / offNoCloud` against the independently predicted factor at the
  // SAME 1400 m camera geometry, per rung. `rung.published` is lane A at 300 m
  // and must never enter this comparison; `deckFreePublished` is captured on
  // lane B immediately after its eclipse-ON frame, while the fold binds every
  // fresh ABBA readback to that same geometry and factor. See the
  // derivation above `deckFreeGroundDimTolerance` for what each verdict means:
  // == F exonerates the globe's own light path and makes CO-17's under-dimming
  // residue CLOUD-DRIVEN; > F indicts the globe path and exonerates the cloud
  // subsystem. The tolerance is PROPAGATED from the band mean each ratio was
  // measured on, not chosen.
  v.deckFreeGroundDim = rungs.map((rung) => {
    const off = rung.shadow?.offNoCloud;
    const on = rung.shadow?.onNoCloud;
    const obscuration = rung.deckFreePublished?.moonObscuration;
    const publishedFactor = rung.deckFreePublished?.factor;
    const factor = Number.isFinite(obscuration)
      ? predictFactor(obscuration)
      : null;
    const factorCertified =
      Number.isFinite(publishedFactor) &&
      Number.isFinite(factor) &&
      Math.abs(publishedFactor - factor) <= B.factorTolerance.hi;
    const factorCameraHeight = rung.deckFreePublished?.cameraHeight;
    const measurementCameraHeight = rung.shadow?.cameraHeight;
    const cameraGeometryMatches =
      Number.isFinite(factorCameraHeight) &&
      Number.isFinite(measurementCameraHeight) &&
      factorCameraHeight === measurementCameraHeight;
    const measured = ratio(on, off);
    const tolerance = deckFreeGroundDimTolerance(off, measured);
    const delta =
      Number.isFinite(measured) && Number.isFinite(factor)
        ? measured - factor
        : null;
    return {
      obscuration: Number.isFinite(obscuration) ? obscuration : null,
      factor: factor ?? null,
      publishedFactor: Number.isFinite(publishedFactor)
        ? publishedFactor
        : null,
      factorCertified,
      factorSource: "predictFactor(deckFreePublished.moonObscuration)",
      factorCameraHeight: Number.isFinite(factorCameraHeight)
        ? factorCameraHeight
        : null,
      measurementCameraHeight: Number.isFinite(measurementCameraHeight)
        ? measurementCameraHeight
        : null,
      cameraGeometryMatches,
      scheduledLaneFactor: rung.published?.factor ?? null,
      offNoCloud: Number.isFinite(off) ? off : null,
      onNoCloud: Number.isFinite(on) ? on : null,
      measured,
      tolerance,
      delta,
      // The headline: what fraction of F the deck-free band actually retained.
      // 1.0 is the published law; CO-17 measured 1.126 with the deck ON.
      overFactor: ratio(measured, factor),
      withinTolerance:
        factorCertified &&
        cameraGeometryMatches &&
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
    const clearUnshadowed = rung.shadow?.offNoShadow;
    const clearShadowed = rung.shadow?.offShadow;
    const eclipseUnshadowed = rung.shadow?.onNoShadow;
    const eclipseShadowed = rung.shadow?.onShadow;
    const clearDecrement =
      Number.isFinite(clearUnshadowed) && Number.isFinite(clearShadowed)
        ? clearUnshadowed - clearShadowed
        : null;
    const eclipseDecrement =
      Number.isFinite(eclipseUnshadowed) && Number.isFinite(eclipseShadowed)
        ? eclipseUnshadowed - eclipseShadowed
        : null;
    // These two are the SAME reads as `groundDimming.shadowable` and
    // `groundDimming.unshadowed` below, under the decomposition's own names:
    // `extractShadowableDimming` is `(uF - sF) / (u1 - s1)` after its
    // `1 - c1` division, i.e. `terrainDim`, and `unshadowed` is `onNoShadow /
    // offNoShadow`, i.e. `compositeDim`. Both pairs are published because each
    // name is the one its own reader reaches for; they can differ in the last
    // ULP because the routes are different, never in value.
    const terrainDim = ratio(eclipseDecrement, clearDecrement);
    const compositeDim = ratio(eclipseUnshadowed, clearUnshadowed);
    const clearContrast = ratio(clearShadowed, clearUnshadowed);
    const strengthEclipse = rung.published?.shadowStrength;
    const strengthClear = rung.publishedOff?.shadowStrength;
    const factor = rung.published?.factor;
    const shadowable = extractShadowableDimming(rung.shadow);
    const unshadowed = ratio(rung.shadow?.onNoShadow, rung.shadow?.offNoShadow);
    const shadowed = ratio(rung.shadow?.onShadow, rung.shadow?.offShadow);
    return {
      obscuration: rung.published?.moonObscuration ?? null,
      factor: factor ?? null,
      terrainDim,
      compositeDim,
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
  const deepestShadowDims = v.shadowContrastModel.at(-1) ?? null;
  const residueShares = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
  v.shadowResidueDimLocus = residueShares.map((share) => ({
    share,
    requiredResidueDim:
      Number.isFinite(deepestShadowDims?.compositeDim) &&
      Number.isFinite(deepestShadowDims?.terrainDim)
        ? ratio(
            deepestShadowDims.compositeDim -
              deepestShadowDims.terrainDim * (1 - share),
            share,
          )
        : null,
  }));
  v.shadowResidueShareAtDeckRatio =
    Number.isFinite(deepestShadowDims?.compositeDim) &&
    Number.isFinite(deepestShadowDims?.terrainDim) &&
    Number.isFinite(v.deckRatioAtDeepest)
      ? ratio(
          deepestShadowDims.compositeDim - deepestShadowDims.terrainDim,
          v.deckRatioAtDeepest - deepestShadowDims.terrainDim,
        )
      : null;
  // A hard upper bound on the residue share, out of the shadow term's own
  // form. The clear contrast is `T*(1 - share) + share` with `T = mix(1, 0.35,
  // s)`, and `T` can never fall below the beer floor, so
  // `clearContrast >= 0.35 + 0.65*share` and the share cannot exceed
  // `(clearContrast - 0.35) / 0.65`. `requiredResidueDim` above is DECREASING
  // in share, so a ceiling on the share is a FLOOR on how slowly the residue
  // may dim: a hypothesis whose share exceeds this ceiling is out of range,
  // and the residue must dim by at least `requiredResidueDim(ceiling)`.
  // Reported only, like the locus it bounds.
  v.shadowResidueShareCeiling = Number.isFinite(
    deepestShadowDims?.clearContrast,
  )
    ? ratio(
        deepestShadowDims.clearContrast - CLOUD_SHADOW_BEER_FLOOR,
        1 - CLOUD_SHADOW_BEER_FLOOR,
      )
    : null;
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
  // The full telemetry object is reported. Lane B's producer-live and
  // footprint-inside subset is also a structural precondition: without it the
  // decrement predicates are quarantined rather than scored.
  v.shadowTelemetry = {
    producerActiveOff: rungs[0]?.shadow?.shadowActiveOff ?? null,
    producerActiveOn: rungs[0]?.shadow?.shadowActiveOn ?? null,
    producer: rungs[0]?.shadow?.cloudCacheOff ?? null,
    consumer: rungs[0]?.shadow?.globeUniformOff ?? null,
    footprint: rungs[0]?.shadow?.footprintOff ?? null,
    producerAndFootprintCertified: v.shadowProducerAndFootprintCertified,
    rawCompositeContrastAtDeepest: v.shadowCompositeContrastRatioAtDeepest,
    rawCompositeContrastInLegacyBand: v.shadowContrastInvariant,
    residueDimLocus: v.shadowResidueDimLocus,
    residueShareAtDeckRatio: v.shadowResidueShareAtDeckRatio,
    residueShareCeiling: v.shadowResidueShareCeiling,
    decrementModelAtDeepest: v.shadowDecrementModelAtDeepest,
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
    deckFreeControlStateIsolated: v.deckFreeControlStateIsolated,
    deckFreeGroundIsLit: v.deckFreeGroundIsLit,
    deckFreeSessionOrder: deckFreeControl?.sessionOrder ?? null,
    deckFreeSessionTokens: deckFreeControl?.sessionTokens ?? null,
    deckFreeRawBaseColorLuma: deckFreeControl?.rawBaseColorLuma ?? null,
    deckFreeMaximumRawDistance: deckFreeControl?.maximumRawDistance ?? null,
    deckFreeOffASpread: deckFreeControl?.offASpread ?? null,
    deckFreeOffBSpread: deckFreeControl?.offBSpread ?? null,
    deckFreeDirectionalDiagnostic:
      deckFreeControl?.directionalDiagnostic ?? null,
    deckFreeDiagnosticPixelTolerance:
      deckFreeControl?.diagnosticPixelTolerance ?? null,
    deckFreeExpectedBaseColor: deckFreeControl?.expectedBaseColor ?? null,
    deckFreeFactorTolerance: deckFreeControl?.factorTolerance ?? null,
    deckFreeScheduleObscurationTolerance:
      deckFreeControl?.scheduleObscurationTolerance ?? null,
    deckFreeFactorEvidence:
      deckFreeControl?.rungs?.map((rung) => rung.factorEvidence) ?? null,
    // CO-21: the convergence evidence, next to the number it qualifies. The
    // two retention ratios sit together because their DISAGREEMENT is the
    // question — the OFF leg says the scored band is ground, the ON leg says
    // the deck-present and deck-free bands are 2.2x apart, and only one of
    // those can be true of a single surface.
    deckFreeSettled: v.deckFreeGroundCapturesSettled,
    deckFreeSettleDelta: v.deckFreeGroundSettleDelta,
    groundRetentionOn: v.deckFreeGroundOnRetentionRatio,
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

  // Keep source preference and arithmetic in the cost function. Inlining three
  // arithmetic lines here would erase the alternating segment proof and make a
  // sequential A-then-B measurement look admissible again.
  const webgpuCost = computeRefreshCost(gpu.refreshCost, {
    runId: run?.runId,
    expectedBackend: "webgpu",
    expectedSessionLabel: "ibl-webgpu",
    lane: gpu,
    peerLane: gl,
  });
  const webglCost = computeRefreshCost(gl.refreshCost, {
    runId: run?.runId,
    expectedBackend: "webgl",
    expectedSessionLabel: "ibl-webgl",
    lane: gl,
    peerLane: gpu,
  });
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
  // This is an eligibility gate, not a speed budget. Missing or ineligible
  // accounting is structural, retains the exact reason, and is never replaced
  // by a historical estimate.
  v.refreshCostMeasured = webgpuCost.valid && webglCost.valid;
  if (!isBlind("ibl-page") && !v.refreshCostMeasured) {
    markBlind(
      "refresh-cost",
      `fresh refresh-cost measurement is ineligible: ${cost.invalidReasons.join("; ") || "no valid backend measurement was produced"}`,
    );
  }

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
