// sun-radiance-delta.mjs — the solar disc measured at TWO disc radiances, and
// the discrimination that only a two-radiance run can make.
//
// WHAT THIS EXISTS TO SETTLE. Offline inversion of the sun-disc captures
// recovers a flat disc noticeably BRIGHTER than the radiance the frame itself
// resolved onto `frameState.sunHalo.discRadiance`. Two shapes explain that
// equally well from a single-radiance run, and they have completely different
// consequences:
//
//   MULTIPLICATIVE   rendered = k * L    — a missing gain somewhere in the
//                                          disc chain; every derivation that
//                                          reads `discRadiance` inherits it.
//   ADDITIVE         rendered = L + c    — a pedestal that is NOT the disc;
//                                          derivations that divide by `L` are
//                                          fine, those that subtract are not.
//
// At one radiance the two are algebraically indistinguishable: any k has a c
// that reproduces the same number. Vary the radiance and they separate
// immediately, and the separating statistic needs no fitted parameter at all:
//
//   rendered(L_hi) / rendered(L_lo)  =  L_hi / L_lo      under MULTIPLICATIVE
//                                    =  (L_hi + c)/(L_lo + c)  under ADDITIVE
//
// The first prediction does not contain k. It is the ratio of the two RESOLVED
// radiances and nothing else, so a run that measures the plateau on both legs
// either lands on it or does not.
//
// HOW THE RADIANCE IS VARIED. `lighting.enableTrueSolarRadiance` is the shipped
// toggle: ON resolves `discRadiance` from the scene light
// (`SolarDiscModel.solarDiscHdrRadiance`), OFF pins it to the SDR identity
// `1.0`, and `SunHaloAppearance` scales the screen halo's amplitude by the same
// scalar so the whole sun composite is exactly proportional to it. Nothing else
// about the scene moves.
//
// ⚠ NO SCENE FLAGS ARE PINNED TO "REMOVE THE HALO". The one-halo-source
// invariant in `Scene/SunHaloAppearance.js` derives `bakeHaloGain` from
// `screenHalo`, so turning the screen halo off does not delete the halo — it
// swaps in the legacy BAKED one, which drives the bake's own alpha above 1
// across the entire disc and renders it FLAT. No scene configuration produces a
// halo-free disc. The halo-free quantities are DIFFERENTIALS between legs,
// which is what this module measures:
//
//   D1 = flat - limb     the limb law, halo-cancelled by construction
//   D2 = flat - legacy   the disc's own radiance, as an annulus plateau
//
// no uniform the halo reads is a function of either disc toggle, so the
// cancellation is structural rather than configured.
//
// ⚠ THE THIRD LIGHT SOURCE, AND THE ONE THAT DOES **NOT** CANCEL. The sun
// composite is not two terms, it is THREE. `SunPostProcess` (WebGL) and its
// WebGPU mirror run a bright-pass -> blur -> ADDITIVE-BLEND chain BEFORE the
// halo stage, and that chain adds a fourth-order-of-nothing glow to the disc
// itself: `SolarDiscModel.solarBloomCentreAmplitude` is the shipped closed form
// of its centre value, and it is 0.4815 at `discRadiance = 1` and 0.7071 at
// `discRadiance = 2` — i.e. between a third and a half of the disc's own
// radiance, sitting ON the disc.
//
// It does not cancel in EITHER differential, because the bright pass reads the
// scene through a THRESHOLD and each leg presents it a different source:
//
//   D1 = flat - limb     the limb-darkened leg falls below the bright pass's
//                        threshold partway out, so its glow dies at
//                        `x = 0.847` (radiance 1) / `x = 0.974` (radiance 2)
//                        while the flat leg's runs to the limb.
//   D2 = flat - legacy   the legacy leg's disc ENDS at `1/sqrt(2) R`, so over
//                        the plateau annulus (0.78 R to 0.92 R) the flat leg is
//                        still glowing and the legacy leg is not.
//
// And it is neither proportional to the radiance nor independent of it: the
// bright pass is a saturating rational bounded by 1, so the glow grows by 47%
// while the disc doubles. A model that omits it therefore sees an "excess"
// that is MULTIPLICATIVE in neither shape and ADDITIVE in neither shape —
// which is exactly the verdict the first run returned.
//
// WHY D1 IS READ IN DISPLAY CODES. The halo cancels EXACTLY in linear light and
// only approximately in codes, because the display transform is non-linear and
// the halo shifts both legs' operating point along it. Reading D1 in codes is
// therefore the STRICTER test: it is sensitive to the absolute radiance as well
// as to the limb law, which is exactly the sensitivity a radiance question
// needs. The forward model below carries the halo AND the glow explicitly for
// that reason.
//
// @module sun-radiance-delta

import {
  BRACKET_SATURATION_CODE,
  DISPLAY_GAMMA,
} from "./celestial-g2-gate.mjs";
import {
  DISC_AIM_TOLERANCE_PX,
  DISC_MIN_DIFFERENTIAL_PIXELS,
  DISC_MIN_LIT_PIXELS,
  EXIT_CODE,
  G4_CROSS_BACKEND_MAX_RELATIVE_SPREAD,
  LIMB_DISC_ONLY_ANNULUS,
  LIMB_DISC_ONLY_CENTRE_RADIUS_PX,
  STRUCTURAL_NON_VERDICT_MARKER,
  SUN_BAKE_GAMMA_NOMINAL,
  annulusMean,
  bracketQuantum,
  describeAimMiss,
  relativeSpread,
} from "./celestial-g4-gate.mjs";
// The bright-pass chain itself lives in its own module because the celestial G4
// disc lane reads the same glow off the same captures. Re-exported below so
// every caller of this lane keeps its existing import surface.
import {
  BLOOM_FIELD_ANGULAR_SAMPLES,
  DISC_RADIANCE_RECOVERY_CEILING,
  brightPassSourceRadiusPx,
  deriveGlowCorrectedRecoveryBar,
  discBloomGlowField,
  discBloomPlateauDifferentialOver,
  discBloomSourceEdgeUncertaintyPx,
} from "./solar-bloom-glow.mjs";

export {
  BLOOM_FIELD_ANGULAR_SAMPLES,
  DISC_RADIANCE_RECOVERY_CEILING,
  brightPassSourceRadiusPx,
  discBloomGlowField,
  discBloomSourceEdgeUncertaintyPx,
};

// ---------------------------------------------------------------------------
// THE DELTA AXIS
// ---------------------------------------------------------------------------

/**
 * The two `lighting.enableTrueSolarRadiance` positions this run brackets, in
 * capture order. The SHIPPED position is captured LAST, so the certifying leg
 * is measured against the warmest caches — the same ordering rule every other
 * lane in this fleet follows.
 *
 * `key` is the leg name used throughout the report; `enableTrueSolarRadiance`
 * is written verbatim onto the atmospheric-conditions lighting leaf.
 * @type {ReadonlyArray<{key:string,enableTrueSolarRadiance:boolean,role:string}>}
 */
export const RADIANCE_DELTA_LEGS = Object.freeze([
  Object.freeze({
    key: "sdrRadiance",
    enableTrueSolarRadiance: false,
    role: "the SDR identity — `discRadiance` pinned to 1.0",
  }),
  Object.freeze({
    key: "trueRadiance",
    enableTrueSolarRadiance: true,
    role: "shipped default — `discRadiance` resolved from the scene light",
  }),
]);

/**
 * Exposure the differential is READ on.
 *
 * Not a preference. At exposure 1 the shipped disc sits at the very top of the
 * display curve, where one code is worth a large slice of the radiance and the
 * whole centre-to-limb gradient is a couple of codes wide; at 1/8 the same disc
 * spans tens of codes and is nowhere near saturation. The capture still brackets
 * BOTH exposures — the bright leg is what proves the disc is not clipped — but
 * the differential is quoted off the leg that actually resolves it.
 * @type {number}
 */
export const RADIANCE_DELTA_EXPOSURE = 0.125;

/**
 * Radii, as a fraction of the measured disc radius, at which `D1` is sampled.
 *
 * `0` is the null control: the limb law is exactly 1 at the disc centre, so
 * both legs render the same pixel there and their difference must be zero
 * whatever the radiance is. `0.95` is where the rest of this lane already reads
 * the limb law. `1.0` is the extreme limb, where the law is at its minimum and
 * the differential is largest.
 * @type {readonly number[]}
 */
export const RADIANCE_DELTA_SAMPLE_X = Object.freeze([0.0, 0.95, 1.0]);

/**
 * Half-width, in pixels, of the annulus each non-zero sample is averaged over.
 *
 * One radial bin. The band derivation's dominant term is exactly this width
 * carried through the model's own local slope, so the number the measurement
 * uses and the number the tolerance is built from are the same number.
 * @type {number}
 */
export const RADIANCE_DELTA_BIN_HALF_PX = 0.5;

/**
 * Minimum pixels the `D2` annulus must carry before a radiance is recovered
 * from it.
 *
 * DERIVED from the annulus the recovery already runs on: between 0.78 R and
 * 0.92 R of a ~170 px disc that is ~21,600 px. The bar is 2,000 — under 10% of
 * it — so it fails on an annulus that landed off the disc, not on one that is
 * merely smaller than modelled.
 * @type {number}
 */
export const RADIANCE_DELTA_MIN_PLATEAU_PIXELS = 2000;

/**
 * Minimum separation, in resolved linear radiance, the two legs must actually
 * achieve before the discrimination means anything.
 *
 * THE NON-VACUITY CONTROL FOR THE WHOLE RUN. If the toggle did not take — a
 * typo in the flag name, a facade that no longer republishes it, an engine that
 * stopped reading it — both legs resolve the same radiance, every difference
 * collapses to instrument noise, and a naive evaluator would report a beautiful
 * agreement between two identical measurements. The shipped positions are 2.0
 * and 1.0; the bar is half of that gap.
 * @type {number}
 */
export const RADIANCE_DELTA_MIN_RESOLVED_SEPARATION = 0.5;

/**
 * The pre-registered `D1` display codes, recorded BEFORE the run so the
 * measurement is checked against a written prediction rather than against
 * whatever it produced.
 *
 * These are the disc-radiance and halo-amplitude values the two toggle
 * positions resolve at the shipped defaults, pushed through
 * {@link discDifferentialCodeModel}. They are carried as DATA and reported
 * alongside the run-time derivation, which recomputes the same numbers from the
 * shipped model and the frame's own live scalars — if the two disagree, the
 * engine's resolved appearance has moved away from what was pre-registered, and
 * that is worth seeing rather than silently absorbing.
 * @type {Readonly<Record<string, readonly number[]>>}
 */
export const PRE_REGISTERED_D1_CODES = Object.freeze({
  trueRadiance: Object.freeze([0.04, 27.62, 43.23]),
  sdrRadiance: Object.freeze([0.14, 28.83, 39.34]),
});

/**
 * The table the FIRST two-radiance run was scored against, kept because it is
 * the evidence for what changed rather than a number to be quietly replaced.
 *
 * It was computed from a composite of DISC + SCREEN HALO. The measured `D1` at
 * `x = 0.95` came in at 28.05 and 28.18 codes against its 17.92 and 22.88 — and
 * the sign of that miss is the finding: a two-term model cannot be short by ten
 * codes on the low-radiance leg and by five on the high one unless the missing
 * term SATURATES, which the sun bloom's bright pass does. The rows above are
 * the same arithmetic with that third term carried; the null sample moves off
 * exactly zero for the same reason (the flat leg glows very slightly more than
 * the limb leg even at the disc centre, because the blur reaches a little
 * further out than the centre pixel).
 * @type {Readonly<Record<string, readonly number[]>>}
 */
export const PRE_REGISTERED_D1_CODES_NO_BLOOM = Object.freeze({
  trueRadiance: Object.freeze([0.0, 22.88, 39.69]),
  sdrRadiance: Object.freeze([0.0, 17.92, 31.46]),
});

/**
 * Maximum deviation, in codes, tolerated between the pre-registered table above
 * and the run-time derivation from the shipped model.
 *
 * Both are the SAME arithmetic over the same shipped functions, so the only
 * thing that separates them is the transcription rounding in the recorded
 * table. One code is far more than that and far less than any real drift.
 * @type {number}
 */
export const PRE_REGISTRATION_AGREEMENT_CODES = 1.0;

/**
 * Allowance, in display codes, a `D1` sample carries when NEITHER of its bins
 * dithers at all.
 *
 * Not a tolerance and not tuned: it is the exact worst case of the arithmetic.
 * A bin over which the leg's own code does not move renders as one integer on
 * each leg; each of those integers is within 0.5 of the value it quantized, so
 * their difference is within 1.0 of the true difference. There is no
 * `1/sqrt(N)` to be had — the pixels do not disagree, so averaging them cannot
 * average anything down. A bin that sweeps a full code contributes nothing, and
 * the derivation interpolates between the two rather than switching.
 *
 * The first two-radiance run is the case this exists for: at `x = 0` the twelve
 * centre pixels read `flat - limb = 1` EXACTLY on the shipped radiance leg and
 * `0` EXACTLY on the SDR one, both integers, against a band of 0.612 built on
 * `N = 12`. The two legs disagree because they sit at different points on the
 * display curve, which is the signature of deterministic rounding rather than
 * of a differential.
 * @type {number}
 */
export const ZERO_DITHER_QUANTUM_CODES = 1.0;

/** Verdicts {@link discriminateRadianceExcess} can return. */
export const EXCESS_SHAPE = Object.freeze({
  MULTIPLICATIVE: "MULTIPLICATIVE",
  ADDITIVE: "ADDITIVE",
  NEITHER: "NEITHER",
  NONE: "NO-EXCESS",
});

// ---------------------------------------------------------------------------
// FORWARD MODEL — THE COMPOSITE
// ---------------------------------------------------------------------------

/**
 * The display code the sun composite lands on at one radius, on one disc leg.
 *
 * Five shipped lines and nothing else:
 *
 *   bake        rgb = (1, 1, clamp(limb + 0.2))     alpha = limb
 *   SunFS       rgb = pow(rgb, gamma) * discRadiance
 *   blend       out = rgb * alpha                   (over a dark sky)
 *   sun bloom   out += glow                         (bright pass -> blur -> add)
 *   screen halo out += haloAmplitude * P(rho)
 *
 * evaluated on the PEAK channel, which is red and green: the bake writes those
 * as 1 before the gamma decode, so the peak channel carries `limb * L` with the
 * hue term absent. The peak channel is the right one to model because the
 * tonemapper's compression is a function of the triple's maximum, and it is the
 * one the measurement reads for the same reason.
 *
 * `glow` is a per-point INPUT rather than something computed here, for the same
 * reason `haloAmplitude` is: this function is the composite, not the chain that
 * produces one of its terms. {@link discBloomGlowField} is that chain, and
 * {@link deriveDiscDifferentialCodes} is what wires the two together.
 *
 * @param {{solarLimbIntensity:Function,solarScreenHaloProfile:Function,
 *          solarDiscDisplayCode:Function}} model The shipped `SolarDiscModel`
 *        namespace, or a mutant of it.
 * @param {{x:number,limbDarkened:boolean,discRadiance:number,
 *          haloAmplitude:number,haloCoreRadii:number,exposure:number,
 *          glow?:number,gamma?:number}} o
 * @returns {{linear:number,code:number}} Peak-channel radiance and its code.
 */
export function discDifferentialCodeModel(model, o) {
  const gamma = Number.isFinite(o?.gamma) ? o.gamma : SUN_BAKE_GAMMA_NOMINAL;
  const limb = o.limbDarkened ? model.solarLimbIntensity(o.x) : 1.0;
  const halo =
    o.haloAmplitude * model.solarScreenHaloProfile(o.x, o.haloCoreRadii);
  const glow = Number.isFinite(o?.glow) ? o.glow : 0.0;
  const linear = o.discRadiance * limb + halo + glow;
  return {
    linear,
    code: model.solarDiscDisplayCode(o.exposure * linear, gamma),
  };
}

/**
 * `D1 = flat - limb` in display codes at every sample, plus the band each one
 * certifies against and every term that set its width.
 *
 * ⚠ THE BAND IS A PREDICTION OF THE SHIPPED CHAIN, computed from the model and
 * the appearance scalars passed in. A MUTANT model, or a wrong radiance,
 * produces a different band — which is what lets a spec prove the derivation
 * actually reads each of its inputs rather than returning a constant.
 *
 * WIDTH, from three modelled terms:
 *
 *   T1  RADIAL BINNING — the sample is an annulus one radial bin wide, so the
 *       radius it reports is `x * R +/- RADIANCE_DELTA_BIN_HALF_PX`. Carried
 *       through the model's own local slope `d(D1)/dx`, evaluated by central
 *       difference so a mutant law's slope sets a mutant law's band. THE
 *       DOMINANT TERM everywhere the limb law is steep.
 *   T2  CODE QUANTIZATION — each leg's code is an 8-bit readback, so their
 *       difference carries `sqrt(2) * 0.5` codes of quantization at ONE pixel,
 *       divided by the square root of the annulus population. Small by design:
 *       it is why the samples are annuli and not pixels.
 *   T3  THE fp16 BAKE — both sun bakes store HDR as binary16, whose significand
 *       is 11 bits, over two legs.
 *
 *   T4  THE UNDITHERED REMAINDER — `1/sqrt(N)` is earned only where the bin's
 *       pixels round DIFFERENTLY, which needs the leg's own code to sweep at
 *       least one code across the bin. At the null sample it sweeps none: the
 *       disc centre is flat, all twelve pixels render the SAME integer on each
 *       leg, and their difference is an INTEGER whose smallest non-zero value
 *       is 1.0 — three times a band built on `N = 12`. T4 is the part of the
 *       quantum that no amount of averaging reaches, `(1 - sweep)/2` per leg,
 *       and it is a HARD bound rather than a sigma so it joins the bar OUTSIDE
 *       the 3x margin. A fully swept bin contributes exactly zero.
 *
 * The bar is then pinned between two requirements that both have to hold, in
 * the style this lane's other derived bounds use:
 *
 *   * at least 3x the modelled error, so modelling slop cannot fail a real
 *     measurement;
 *   * at most one third of the distance to the nearest thing it must REFUSE —
 *     a disc that renders FLAT, i.e. `D1 = 0`, which is the headline defect
 *     this differential exists to detect;
 *
 * and set to their GEOMETRIC MIDPOINT. At the null sample (`x = 0`) the
 * expectation is exactly zero and there is no multiplicative separation to
 * halve, so the band there is the modelled error alone — which is the correct
 * and stricter statement: the disc centre must show NO differential.
 *
 * ⚠ THE GLOW IS PART OF THE PREDICTION, NOT AN ERROR TERM. When `bloom`
 * geometry is supplied the derivation builds {@link discBloomGlowField} once per
 * leg and adds each leg's own glow to that leg's composite. Omitting it is not
 * a smaller model, it is a WRONG one — the flat and limb legs glow differently
 * by construction — so a call without `bloom` returns samples that are
 * explicitly NON-CERTIFYING rather than quietly scoring a two-term picture.
 *
 * ⚠ NOT EVERY SAMPLE CAN CERTIFY, AND THE DERIVATION SAYS WHICH. The limb law
 * has a VERTICAL TANGENT at the extreme limb — it is built on
 * `mu = sqrt(1 - x^2)`, whose derivative diverges as `x -> 1` — so T1 there is
 * not large, it is unbounded, and the shipped `solarLimbIntensity` additionally
 * clamps outside the disc, which the central difference straddles. A band wider
 * than the quantity it brackets admits `D1 = 0`, i.e. it admits the FLAT DISC
 * this differential exists to refuse, and a criterion that cannot go red is
 * worse than no criterion. Each sample therefore carries `certifying`, set by
 * the derivation itself: a non-zero sample certifies only when its band
 * excludes zero. The extreme limb is still measured, reported and compared to
 * the pre-registration — it is simply not scored, and it says so in the report
 * rather than passing silently. (This is the same reason the neighbouring
 * limb-shape and disc-only-ratio readings stop at `x = 0.95`.)
 *
 * @param {object} model The shipped `SolarDiscModel` namespace, or a mutant.
 * @param {{discRadiance:number,haloAmplitude:number,haloCoreRadii:number,
 *          exposure?:number,discRadiusPx:number,xs?:readonly number[],
 *          gamma?:number,bloom?:{viewportWidth:number,viewportHeight:number,
 *          limbPx:number,centerX?:number,centerY?:number}}} o Live-resolved
 *        appearance scalars, geometry, and the viewport the sun bloom's blur
 *        buffer is sized from.
 * @returns {{exposure:number,discRadiusPx:number,
 *            samples:Array<{x:number,flatCode:number,limbCode:number,
 *              d1Codes:number,band:{lo:number,hi:number},tolCodes:number,
 *              terms:object}>}}
 */
export function deriveDiscDifferentialCodes(model, o) {
  const exposure = Number.isFinite(o?.exposure)
    ? o.exposure
    : RADIANCE_DELTA_EXPOSURE;
  const gamma = Number.isFinite(o?.gamma) ? o.gamma : SUN_BAKE_GAMMA_NOMINAL;
  const xs = o?.xs ?? RADIANCE_DELTA_SAMPLE_X;
  const discRadiusPx = o?.discRadiusPx;
  const base = {
    discRadiance: o?.discRadiance,
    haloAmplitude: o?.haloAmplitude,
    haloCoreRadii: o?.haloCoreRadii,
    exposure,
    gamma,
  };

  // THE GLOW, built ONCE per leg. The disc's edge in pixels is the leg's own
  // `limbPx` — both D1 legs carry the true-size disc — and the two fields
  // differ only in whether the limb law is applied to the bright pass's input.
  const bloom = o?.bloom ?? null;
  const bloomUsable =
    bloom !== null &&
    bloom.viewportWidth > 0 &&
    bloom.viewportHeight > 0 &&
    bloom.limbPx > 0 &&
    o?.discRadiance > 0;
  const fields = bloomUsable
    ? {
        flat: discBloomGlowField(model, {
          discRadiance: o.discRadiance,
          limbDarkened: false,
          discEdgePx: bloom.limbPx,
          limbPx: bloom.limbPx,
          viewportWidth: bloom.viewportWidth,
          viewportHeight: bloom.viewportHeight,
          centerX: bloom.centerX,
          centerY: bloom.centerY,
        }),
        limb: discBloomGlowField(model, {
          discRadiance: o.discRadiance,
          limbDarkened: true,
          discEdgePx: bloom.limbPx,
          limbPx: bloom.limbPx,
          viewportWidth: bloom.viewportWidth,
          viewportHeight: bloom.viewportHeight,
          centerX: bloom.centerX,
          centerY: bloom.centerY,
        }),
      }
    : null;
  // The glow is read at the SAME physical radius the disc law is evaluated at,
  // so a sample at `x` reads `x * limbPx` and not `x * discRadiusPx`: the two
  // differ, and `discRadiusPx` is a MEASUREMENT while `limbPx` is the geometry
  // the engine drew with.
  const glowAt = (x, leg) =>
    fields ? fields[leg].sampleAtRadiusPx(Math.abs(x) * bloom.limbPx) : 0.0;

  const d1At = (x) =>
    discDifferentialCodeModel(model, {
      ...base,
      x,
      limbDarkened: false,
      glow: glowAt(x, "flat"),
    }).code -
    discDifferentialCodeModel(model, {
      ...base,
      x,
      limbDarkened: true,
      glow: glowAt(x, "limb"),
    }).code;

  const usable =
    o?.discRadiance > 0 &&
    o?.haloAmplitude >= 0 &&
    o?.haloCoreRadii > 0 &&
    discRadiusPx > 0;

  const samples = xs.map((x) => {
    const flat = discDifferentialCodeModel(model, {
      ...base,
      x,
      limbDarkened: false,
      glow: glowAt(x, "flat"),
    });
    const limb = discDifferentialCodeModel(model, {
      ...base,
      x,
      limbDarkened: true,
      glow: glowAt(x, "limb"),
    });
    const d1Codes = flat.code - limb.code;
    if (!usable || !Number.isFinite(d1Codes)) {
      return {
        x,
        flatCode: flat.code,
        limbCode: limb.code,
        d1Codes,
        band: { lo: NaN, hi: NaN },
        tolCodes: NaN,
        certifying: false,
        nonCertifyingReason:
          "the appearance scalars or the disc geometry were not usable, so no " +
          "band could be derived",
        terms: null,
      };
    }
    if (!bloomUsable) {
      return {
        x,
        flatCode: flat.code,
        limbCode: limb.code,
        d1Codes,
        band: { lo: NaN, hi: NaN },
        tolCodes: NaN,
        certifying: false,
        nonCertifyingReason:
          "no sun-bloom geometry was supplied, so the composite was modelled " +
          "as disc + halo only. The bright-pass chain adds a glow to the disc " +
          "that is between a third and a half of its own radiance and that " +
          "DIFFERS between the two legs, so a two-term prediction is wrong " +
          "rather than approximate. Measured and reported, not scored",
        terms: null,
      };
    }
    // T1 — one radial bin, through the model's own local slope.
    const h = 1e-6;
    const slope = (d1At(x + h) - d1At(x - h)) / (2 * h);
    const t1 = Math.abs(slope) * (RADIANCE_DELTA_BIN_HALF_PX / discRadiusPx);
    // T2 — the difference of two 8-bit readbacks, over the annulus population.
    const nBin =
      x > 0
        ? Math.max(
            1,
            Math.floor(
              2 * Math.PI * x * discRadiusPx * 2 * RADIANCE_DELTA_BIN_HALF_PX,
            ),
          )
        : Math.max(
            1,
            Math.floor(
              Math.PI *
                LIMB_DISC_ONLY_CENTRE_RADIUS_PX *
                LIMB_DISC_ONLY_CENTRE_RADIUS_PX,
            ),
          );
    // T2 — the difference of two 8-bit readbacks, over the annulus population.
    const t2 = (Math.SQRT2 * 0.5) / Math.sqrt(nBin);
    // T3 — the binary16 bake, two legs.
    const t3 = Math.abs(d1Codes) * 2 * Math.pow(2, -11);
    // ⚠ HOW MUCH OF THE BIN CANNOT DITHER, which is the part `1/sqrt(N)` never
    // reaches. Averaging beats quantization down only where the pixels round
    // DIFFERENTLY. Over a bin across which one leg's own code sweeps `s` codes,
    // the mean of the rounded values differs from the mean of the true ones by
    // at most `(1 - s)/2` — at `s = 1` a full ramp averages exactly and the
    // bound is 0, at `s = 0` every pixel is the same integer and the bound is
    // the half code that integer stands for. Each leg contributes its own, so
    // the difference carries their sum, and the sweep is asked of the MODEL at
    // the same radial half-bin T1 is derived over.
    //
    // This is a HARD bound, not a sigma, so it is added OUTSIDE the 3x
    // stochastic margin: exactly the allowance a sample the instrument cannot
    // resolve is owed, and none on a sample it can.
    const legCodeAt = (xx, leg) =>
      discDifferentialCodeModel(model, {
        ...base,
        x: xx,
        limbDarkened: leg === "limb",
        glow: glowAt(xx, leg),
      }).code;
    const dx = RADIANCE_DELTA_BIN_HALF_PX / discRadiusPx;
    const spreadOf = (leg) =>
      Math.abs(legCodeAt(x + dx, leg) - legCodeAt(Math.max(0, x - dx), leg));
    const codeSpread = { flat: spreadOf("flat"), limb: spreadOf("limb") };
    const quantum =
      0.5 *
      ZERO_DITHER_QUANTUM_CODES *
      (Math.max(0, 1 - codeSpread.flat) + Math.max(0, 1 - codeSpread.limb));
    const dithers = quantum <= 0;
    const modelled = t1 + t2 + t3;
    const loBar = 3 * modelled + quantum;
    // The nearest thing the band must refuse is a FLAT disc, `D1 = 0`.
    const hiBar = Math.abs(d1Codes) / 3;
    const tolCodes = hiBar > loBar ? Math.sqrt(loBar * hiBar) : loBar;
    // The null control certifies by construction — its whole claim is that the
    // measured value sits inside the instrument's own error of zero. Every
    // other sample certifies only if its band EXCLUDES zero, because a band
    // that contains zero admits the flat disc.
    const certifying = x === 0 ? true : tolCodes < Math.abs(d1Codes);
    return {
      x,
      flatCode: flat.code,
      limbCode: limb.code,
      d1Codes,
      band: { lo: d1Codes - tolCodes, hi: d1Codes + tolCodes },
      tolCodes,
      certifying,
      nonCertifyingReason: certifying
        ? null
        : `the derived band (+/-${tolCodes}) is wider than the expectation ` +
          `itself (${d1Codes}), so it would admit a FLAT disc; the limb law's ` +
          "radial derivative diverges as x approaches 1, which is where this " +
          "width comes from. Measured and reported, not scored",
      terms: {
        t1,
        t2,
        t3,
        slope,
        binPixels: nBin,
        codeSpread,
        dithers,
        quantum,
        glowFlat: glowAt(x, "flat"),
        glowLimb: glowAt(x, "limb"),
        modelled,
        loBar,
        hiBar,
      },
    };
  });
  return {
    exposure,
    discRadiusPx,
    gamma,
    bloomModelled: bloomUsable,
    bloomSourceRadiusPx: fields
      ? { flat: fields.flat.sourceRadiusPx, limb: fields.limb.sourceRadiusPx }
      : null,
    bloomCentreAmplitude: fields ? fields.flat.centreAmplitude : null,
    samples,
  };
}

/**
 * How well the display-code criteria could separate a disc rendering at its
 * RESOLVED radiance from one rendering at the RECOVERED radiance.
 *
 * A criterion's discriminating power is the distance between the two competing
 * predictions measured in units of its own tolerance. Below 1 the criterion
 * cannot tell them apart at all and its verdict says nothing about which is
 * true; well above 1 it can. Publishing this is what stops a green code
 * criterion from being read as evidence against a radiance excess it was never
 * sharp enough to see.
 *
 * @param {object} model The shipped `SolarDiscModel` namespace, or a mutant.
 * @param {{resolvedRadiance:number,recoveredRadiance:number,
 *          haloAmplitudePerRadiance:number,haloCoreRadii:number,
 *          discRadiusPx:number,exposure?:number,xs?:readonly number[],
 *          gamma?:number}} o
 * @returns {{samples:Array<{x:number,atResolved:number,atRecovered:number,
 *            separationCodes:number,tolCodes:number,power:number,
 *            certifying:boolean}>}}
 */
export function d1DiscriminationPower(model, o) {
  const common = {
    haloCoreRadii: o.haloCoreRadii,
    discRadiusPx: o.discRadiusPx,
    exposure: o.exposure,
    xs: o.xs,
    gamma: o.gamma,
    bloom: o.bloom,
  };
  // The halo's amplitude is a fixed multiple of the disc radiance, so a
  // hypothesis about the radiance is a hypothesis about the whole composite —
  // scaling one without the other would model a picture the engine cannot draw.
  const at = (L) =>
    deriveDiscDifferentialCodes(model, {
      ...common,
      discRadiance: L,
      haloAmplitude: o.haloAmplitudePerRadiance * L,
    });
  const resolved = at(o.resolvedRadiance);
  const recovered = at(o.recoveredRadiance);
  return {
    resolvedRadiance: o.resolvedRadiance,
    recoveredRadiance: o.recoveredRadiance,
    samples: resolved.samples.map((s, i) => {
      const other = recovered.samples[i];
      const separationCodes = Math.abs(other.d1Codes - s.d1Codes);
      return {
        x: s.x,
        atResolved: s.d1Codes,
        atRecovered: other.d1Codes,
        separationCodes,
        tolCodes: s.tolCodes,
        power: s.tolCodes > 0 ? separationCodes / s.tolCodes : NaN,
        certifying: s.certifying,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// MEASUREMENT
// ---------------------------------------------------------------------------

/**
 * Per-pixel PEAK-CHANNEL code of an 8-bit capture, as a neutral linear-light
 * image the rest of this lane's radial helpers can consume unchanged.
 *
 * The three channels are written to the SAME value, so `luminanceAt` — whose
 * weights sum to exactly 1 — returns that value. That is what lets
 * {@link annulusMean} be reused verbatim on a code image instead of a second
 * annulus walker existing to average codes.
 *
 * @param {{data:ArrayLike<number>,width:number,height:number}} capture
 * @returns {{data:Float64Array,width:number,height:number,saturated:number}}
 */
export function peakChannelCodeImage(capture) {
  const n = capture.data.length;
  const out = new Float64Array(n);
  let saturated = 0;
  for (let i = 0; i < n; i += 4) {
    const peak = Math.max(
      capture.data[i],
      Math.max(capture.data[i + 1], capture.data[i + 2]),
    );
    if (peak >= BRACKET_SATURATION_CODE) {
      saturated++;
    }
    out[i] = peak;
    out[i + 1] = peak;
    out[i + 2] = peak;
    out[i + 3] = 1;
  }
  return { data: out, width: capture.width, height: capture.height, saturated };
}

/**
 * Measure `D1 = flat - limb` in display codes from the two RAW 8-bit legs.
 *
 * Deliberately NOT taken off the stitched linear composite: the pre-registered
 * prediction is a statement about what the display chain emits, so the reading
 * has to be the codes themselves. The stitched composite is still what the
 * linear plateau and the disc geometry come from — this is the second, stricter
 * view of the same captures.
 *
 * @param {{flat:object,limb:object,cx:number,cy:number,discRadiusPx:number,
 *          xs?:readonly number[]}} o Raw captures plus the geometry the linear
 *        differential already established.
 * @returns {{samples:Array<{x:number,d1Codes:number,pixels:number}>,
 *            saturatedPixels:number,binHalfPx:number}}
 */
export function measureDiscDifferentialCodes(o) {
  const flat = peakChannelCodeImage(o.flat);
  const limb = peakChannelCodeImage(o.limb);
  const n = Math.min(flat.data.length, limb.data.length);
  const delta = new Float64Array(n);
  for (let i = 0; i < n; i += 4) {
    const d = flat.data[i] - limb.data[i];
    delta[i] = d;
    delta[i + 1] = d;
    delta[i + 2] = d;
    delta[i + 3] = 1;
  }
  const image = { data: delta, width: flat.width, height: flat.height };
  const xs = o.xs ?? RADIANCE_DELTA_SAMPLE_X;
  const samples = xs.map((x) => {
    const band =
      x > 0
        ? {
            r0: Math.max(0, x * o.discRadiusPx - RADIANCE_DELTA_BIN_HALF_PX),
            r1: x * o.discRadiusPx + RADIANCE_DELTA_BIN_HALF_PX,
          }
        : { r0: 0, r1: LIMB_DISC_ONLY_CENTRE_RADIUS_PX };
    const m = annulusMean(image, o.cx, o.cy, band.r0, band.r1);
    return { x, d1Codes: m.mean, pixels: m.pixels, r0: band.r0, r1: band.r1 };
  });
  return {
    samples,
    // Saturation on EITHER leg clips the difference, so the guard is the union.
    saturatedPixels: flat.saturated + limb.saturated,
    binHalfPx: RADIANCE_DELTA_BIN_HALF_PX,
  };
}

// ---------------------------------------------------------------------------
// THE DISCRIMINATION
// ---------------------------------------------------------------------------

/**
 * The sun bloom's contribution to THIS lane's `D2` PLATEAU, in the same linear
 * units the plateau is measured in — i.e. the number that has to come OFF the
 * plateau before it is read as a disc radiance.
 *
 * The chain is {@link discBloomPlateauDifferentialOver}'s; what this adds is the
 * band, which is a property of the measurement rather than of the bloom:
 * `D2 = flat - legacy` is averaged over {@link LIMB_DISC_ONLY_ANNULUS}, which
 * sits INSIDE the true-size disc and OUTSIDE the legacy one. A caller that
 * measured over a different band passes its own.
 *
 * @param {object} model The shipped `SolarDiscModel` namespace, or a mutant.
 * @param {{discRadiance:number,limbPx:number,viewportWidth:number,
 *          viewportHeight:number,centerX?:number,centerY?:number,
 *          annulus?:{lo:number,hi:number},discEdgeShiftPx?:number,
 *          samples?:number}} o
 * @returns {number} Linear light the glow adds to the plateau.
 */
export function discBloomPlateauDifferential(model, o) {
  return discBloomPlateauDifferentialOver(model, {
    ...o,
    annulus: o?.annulus ?? LIMB_DISC_ONLY_ANNULUS,
  });
}

/**
 * Decide whether the disc's rendered-versus-resolved radiance excess is
 * MULTIPLICATIVE or ADDITIVE, from the two legs' recovered plateaus.
 *
 * ⚠ WHAT THE PLATEAU IS, BEFORE ANY SHAPE QUESTION IS ASKED. The annulus does
 * not carry the disc alone: it carries the disc PLUS the sun bloom's glow
 * differential between the two legs (see
 * {@link discBloomPlateauDifferential}). A leg's `glowDifferential` is
 * therefore subtracted before its radiance is recovered. Omitting it does not
 * bias the answer by a constant — the glow is a saturating function of the
 * radiance, so it inflates the LOW leg by proportionally more than the high one
 * and the ratio lands between the two hypotheses, matching neither. That is
 * exactly the `NEITHER` the first two-radiance run returned, and it is a
 * statement about the model rather than about the engine.
 *
 * The separating statistic is the plateau RATIO, which under the multiplicative
 * shape equals the ratio of the two RESOLVED radiances exactly and contains no
 * fitted parameter. The additive prediction does contain one, so it is
 * estimated from the high leg itself (`c = plateau_hi - resolved_hi`) rather
 * than from a recorded value — a stale `c` would make the additive arm test a
 * number nobody measured.
 *
 * The band is pinned the same way every derived bound in this lane is: at least
 * 3x the modelled instrument error, at most a third of the distance to the
 * competing hypothesis, geometric midpoint. When the two predictions are closer
 * together than the instrument can resolve there is nothing to discriminate,
 * and the honest answer is that there is no excess to explain — reported as its
 * own verdict rather than as a coin flip between two shapes.
 *
 * @param {{legs:Array<{key:string,resolvedRadiance:number,plateau:number,
 *          plateauPixels:number,plateauQuantumLinear:number,
 *          glowDifferential?:number,glowDifferentialError?:number}>}} o
 * @returns {object} Every quantity the verdict was built from.
 */
export function discriminateRadianceExcess(o) {
  const legs = (o?.legs ?? [])
    .filter((l) => l && l.resolvedRadiance > 0 && Number.isFinite(l.plateau))
    .sort((a, b) => b.resolvedRadiance - a.resolvedRadiance);
  const fail = {
    verdict: EXCESS_SHAPE.NEITHER,
    usable: false,
    recovered: {},
    ratioMeasured: NaN,
    ratioMultiplicative: NaN,
    ratioAdditive: NaN,
    additiveConstant: NaN,
    separation: NaN,
    sigmaRatio: NaN,
    tolerance: NaN,
    terms: null,
  };
  if (legs.length < 2) {
    return fail;
  }
  const [hi, lo] = legs;
  if (!(hi.plateau > 0) || !(lo.plateau > 0)) {
    return fail;
  }
  // THE DISC'S OWN PLATEAU. The glow the bright-pass chain adds over the
  // annulus is not the disc and must come off before anything divides by the
  // resolved radiance. A leg that did not supply one contributes 0, and
  // `glowModelled` records that so a reader can see whether the correction was
  // applied rather than infer it from the numbers.
  const glowOf = (leg) =>
    Number.isFinite(leg.glowDifferential) ? leg.glowDifferential : 0;
  const discOf = (leg) => leg.plateau - glowOf(leg);
  const glowModelled = legs.every((l) => Number.isFinite(l.glowDifferential));
  if (!(discOf(hi) > 0) || !(discOf(lo) > 0)) {
    return { ...fail, glowModelled };
  }
  const recovered = {};
  const recoveredResidual = {};
  for (const leg of legs) {
    recovered[leg.key] = discOf(leg) / leg.resolvedRadiance;
    recoveredResidual[leg.key] = recovered[leg.key] - 1;
  }
  const ratioMeasured = discOf(hi) / discOf(lo);
  const ratioMultiplicative = hi.resolvedRadiance / lo.resolvedRadiance;
  const additiveConstant = discOf(hi) - hi.resolvedRadiance;
  const ratioAdditive =
    lo.resolvedRadiance + additiveConstant !== 0
      ? (hi.resolvedRadiance + additiveConstant) /
        (lo.resolvedRadiance + additiveConstant)
      : NaN;

  // INSTRUMENT ERROR ON THE RATIO. Each plateau is an annulus mean whose
  // per-pixel resolution is one display code at that brightness, so its own
  // relative error is `oneCode / plateau / sqrt(N)`; the ratio carries both in
  // quadrature. Where a glow correction was applied, ITS OWN error bar joins
  // them — the correction is a model, and a model's residual belongs in the
  // band that certifies what it corrected.
  const relOf = (leg) => {
    if (!(leg.plateauQuantumLinear > 0) || !(leg.plateauPixels > 0)) {
      return NaN;
    }
    const quantization =
      leg.plateauQuantumLinear / discOf(leg) / Math.sqrt(leg.plateauPixels);
    const glowError = Number.isFinite(leg.glowDifferentialError)
      ? Math.abs(leg.glowDifferentialError) / discOf(leg)
      : 0;
    return Math.hypot(quantization, glowError);
  };
  const relHi = relOf(hi);
  const relLo = relOf(lo);
  const sigmaRatio = ratioMeasured * Math.hypot(relHi, relLo);
  if (!Number.isFinite(sigmaRatio) || !Number.isFinite(ratioAdditive)) {
    return { ...fail, recovered, ratioMeasured, ratioMultiplicative };
  }

  const separation = Math.abs(ratioMultiplicative - ratioAdditive);
  const loBar = 3 * sigmaRatio;
  const hiBar = separation / 3;
  const tolerance = hiBar > loBar ? Math.sqrt(loBar * hiBar) : loBar;
  const terms = {
    relHi,
    relLo,
    loBar,
    hiBar,
    plateauHi: hi.plateau,
    plateauLo: lo.plateau,
    glowHi: glowOf(hi),
    glowLo: glowOf(lo),
    discPlateauHi: discOf(hi),
    discPlateauLo: discOf(lo),
    resolvedHi: hi.resolvedRadiance,
    resolvedLo: lo.resolvedRadiance,
  };
  // THE ABSOLUTE ARM, published alongside the shape arm because a ratio cannot
  // see a gain both legs share. `recoveredResidual` is what the excess actually
  // WAS; the bar is derived per leg from the glow correction's own bracket and
  // the plateau's quantization, capped so a degenerate geometry cannot buy
  // itself a generous one. The derivation is shared with the celestial G4 disc
  // lane, which recovers the same quantity from the same plateau. No
  // `undithered` term is passed here: this lane's plateau is read across the
  // full annulus of a bracketed stitch and its own dither residue is stated by
  // `ZERO_DITHER_QUANTUM_CODES` on the code-side samples instead.
  const recoveryBar = {};
  for (const leg of legs) {
    recoveryBar[leg.key] = deriveGlowCorrectedRecoveryBar({
      resolvedRadiance: leg.resolvedRadiance,
      glowError: leg.glowDifferentialError,
      plateauQuantumLinear: leg.plateauQuantumLinear,
      plateauPixels: leg.plateauPixels,
    }).tolRel;
  }
  const recoveryAgrees = legs.every(
    (l) => Math.abs(recoveredResidual[l.key]) <= recoveryBar[l.key],
  );

  const common = {
    usable: true,
    glowModelled,
    recovered,
    recoveredResidual,
    recoveryBar,
    recoveryAgrees,
    ratioMeasured,
    ratioMultiplicative,
    ratioAdditive,
    additiveConstant,
    separation,
    sigmaRatio,
    tolerance,
    terms,
  };

  // The two hypotheses are only distinguishable when their predictions are
  // further apart than the band that certifies either of them.
  if (!(separation > 2 * tolerance)) {
    return { verdict: EXCESS_SHAPE.NONE, ...common };
  }

  const nearMultiplicative =
    Math.abs(ratioMeasured - ratioMultiplicative) <= tolerance;
  const nearAdditive = Math.abs(ratioMeasured - ratioAdditive) <= tolerance;
  const verdict =
    nearMultiplicative && !nearAdditive
      ? EXCESS_SHAPE.MULTIPLICATIVE
      : nearAdditive && !nearMultiplicative
        ? EXCESS_SHAPE.ADDITIVE
        : EXCESS_SHAPE.NEITHER;
  return { verdict, ...common };
}

// ---------------------------------------------------------------------------
// EVALUATION
// ---------------------------------------------------------------------------

/**
 * Turn one backend's measurements into criteria plus structural notes.
 *
 * The ordering below is deliberate and matches the rest of this lane: a LIT
 * frame whose differential is empty is a DEFECT reported as a named criterion,
 * never as "could not see its subject", because a flat reference disc always
 * renders and `flat - limb == 0` can only mean the limb term did nothing.
 * Everything that genuinely prevents a reading — no sun in frame, a missed aim,
 * a saturated leg, a toggle that never took — is structural.
 *
 * @param {object} m One backend's measured payload.
 * @returns {{criteria:Object<string,boolean>,structural:string[],
 *            diagnostics:object,pass:boolean}}
 */
export function evaluateRadianceDeltaBackend(m) {
  const structural = [];
  const diagnostics = {};
  const legs = m?.legs ?? {};
  const keys = RADIANCE_DELTA_LEGS.map((l) => l.key);

  for (const key of keys) {
    const leg = legs[key];
    if (!leg) {
      structural.push(`the ${key} leg did not produce a measurement at all`);
      continue;
    }
    if (leg.hdrEngaged !== true) {
      structural.push(
        `${key} — the HDR path never engaged, so the exposure bracket did ` +
          "nothing and the disc was clipped by the 8-bit canvas before it " +
          "was read",
      );
    }
    if (!(leg.limbLegLitPixels >= DISC_MIN_LIT_PIXELS)) {
      structural.push(
        `${key} — the shipped disc leg carried only ${leg.limbLegLitPixels ?? 0} ` +
          `lit pixels (need ${DISC_MIN_LIT_PIXELS}); the Sun is not in frame`,
      );
    }
  }
  if (structural.length > 0) {
    return { criteria: {}, structural, diagnostics, pass: false };
  }

  // THE HEADLINE DEFECT, ahead of every structural guard below.
  const emptyDifferential = keys.filter(
    (k) =>
      !(legs[k].differentialPositivePixels >= DISC_MIN_DIFFERENTIAL_PIXELS),
  );
  if (emptyDifferential.length > 0) {
    return {
      criteria: { limb_differential_has_signal: false },
      structural,
      diagnostics: { emptyDifferentialLegs: emptyDifferential },
      pass: false,
    };
  }

  for (const key of keys) {
    const leg = legs[key];
    if (!(leg.aimDistancePx <= DISC_AIM_TOLERANCE_PX)) {
      structural.push(
        `${key} — ${describeAimMiss(
          "the limb differential's centroid",
          leg.aim ?? {
            measuredOffsetPx: leg.aimDistancePx,
            measuredOffsetDeg: leg.aimDistanceDeg,
          },
          DISC_AIM_TOLERANCE_PX,
        )}`,
      );
    }
    if (!(leg.plateauPixels >= RADIANCE_DELTA_MIN_PLATEAU_PIXELS)) {
      structural.push(
        `${key} — the disc-radiance annulus between ` +
          `${LIMB_DISC_ONLY_ANNULUS.lo} R and ${LIMB_DISC_ONLY_ANNULUS.hi} R ` +
          `carried ${leg.plateauPixels ?? 0} pixels (need ` +
          `${RADIANCE_DELTA_MIN_PLATEAU_PIXELS}), so no radiance can be ` +
          "recovered from it",
      );
    }
    if (leg.codes?.saturatedPixels > 0) {
      structural.push(
        `${key} — ${leg.codes.saturatedPixels} pixels of the differential leg ` +
          `reached the saturation code ${BRACKET_SATURATION_CODE}; a clipped ` +
          "code difference is not the differential this run reads",
      );
    }
  }

  // NON-VACUITY: the delta axis must have actually moved.
  const resolvedHi = legs[keys[keys.length - 1]]?.resolvedRadiance;
  const resolvedLo = legs[keys[0]]?.resolvedRadiance;
  const resolvedSeparation = Math.abs(resolvedHi - resolvedLo);
  diagnostics.resolvedSeparation = resolvedSeparation;
  if (!(resolvedSeparation >= RADIANCE_DELTA_MIN_RESOLVED_SEPARATION)) {
    structural.push(
      "the two legs resolved disc radiances " +
        `${resolvedLo} and ${resolvedHi}, a separation of ` +
        `${resolvedSeparation} against a required ` +
        `${RADIANCE_DELTA_MIN_RESOLVED_SEPARATION} — ` +
        "`enableTrueSolarRadiance` did not take, so every comparison below " +
        "would be between two measurements of the same thing. " +
        STRUCTURAL_NON_VERDICT_MARKER,
    );
  }
  if (structural.length > 0) {
    return { criteria: {}, structural, diagnostics, pass: false };
  }

  const criteria = { limb_differential_has_signal: true };

  // (a) the differential's display codes, against the derived band. Only
  // samples the derivation itself declared certifying are scored; the rest are
  // reported under `nonCertifyingSamples` so their absence from the criteria
  // list is visible rather than inferred.
  diagnostics.nonCertifyingSamples = [];
  for (const key of keys) {
    const leg = legs[key];
    const derived = leg.derived?.samples ?? [];
    const measured = leg.codes?.samples ?? [];
    for (let i = 0; i < derived.length; i++) {
      const d = derived[i];
      const s = measured[i];
      const label = `d1_codes_${key}_x${String(d.x).replace(".", "p")}`;
      if (d.certifying !== true) {
        diagnostics.nonCertifyingSamples.push({
          name: label,
          x: d.x,
          expected: d.d1Codes,
          measured: s?.d1Codes ?? NaN,
          tolCodes: d.tolCodes,
          reason: d.nonCertifyingReason,
        });
        continue;
      }
      criteria[label] =
        Number.isFinite(s?.d1Codes) &&
        Number.isFinite(d.band.lo) &&
        s.d1Codes >= d.band.lo &&
        s.d1Codes <= d.band.hi;
    }
    // The pre-registration is checked against the RUN-TIME derivation, so a
    // recorded table that no longer describes the shipped resolution shows up
    // as its own named failure rather than as a mysteriously shifted band.
    const pre = PRE_REGISTERED_D1_CODES[key] ?? [];
    criteria[`preregistration_still_describes_shipped_model_${key}`] =
      derived.length === pre.length &&
      derived.every(
        (d, i) =>
          Math.abs(d.d1Codes - pre[i]) <= PRE_REGISTRATION_AGREEMENT_CODES,
      );
  }

  // (b) the discrimination itself.
  const ex = m.excess;
  criteria.radiance_excess_shape_is_decided =
    ex?.usable === true && ex.verdict !== EXCESS_SHAPE.NEITHER;
  // (b2) THE ABSOLUTE ARM. A ratio is blind to a gain both legs share, so the
  // shape verdict alone cannot say the disc renders at the radiance the frame
  // resolved — and `NO-EXCESS` is only meaningful if the recovery LANDS. This
  // is the criterion that turns the formerly-unexplained excess into a scored
  // claim instead of a diagnostic.
  criteria.disc_radiance_recovers_resolved =
    ex?.usable === true &&
    ex.glowModelled === true &&
    ex.recoveryAgrees === true;
  diagnostics.excessVerdict = ex?.verdict ?? null;
  diagnostics.recovered = ex?.recovered ?? null;
  diagnostics.recoveredResidual = ex?.recoveredResidual ?? null;
  diagnostics.recoveryBar = ex?.recoveryBar ?? null;
  diagnostics.glowModelled = ex?.glowModelled ?? false;
  diagnostics.glowDifferential = {
    hi: ex?.terms?.glowHi ?? NaN,
    lo: ex?.terms?.glowLo ?? NaN,
  };
  diagnostics.ratioMeasured = ex?.ratioMeasured ?? NaN;

  // ⚠ HOW MUCH THE CODE CRITERIA ABOVE ACTUALLY SEPARATE THE TWO HYPOTHESES.
  // Published because the honest answer is "not much": the band at `x = 0.95`
  // is set by the requirement to refuse a flat disc, which is far coarser than
  // the code-level gap between a disc rendering at its RESOLVED radiance and
  // one rendering at the RECOVERED radiance. A reader who saw those criteria
  // pass and concluded the excess was thereby refuted would be wrong, so the
  // ratio of the two is stated rather than left to be inferred. The plateau
  // ratio in (b) is the discriminator; this is the receipt that (a) is not.
  diagnostics.d1DiscriminationPower = m.d1DiscriminationPower ?? null;

  return {
    criteria,
    structural,
    diagnostics,
    pass: Object.values(criteria).every(Boolean),
  };
}

/**
 * Fold both backends into one verdict, and add the cross-backend arm.
 *
 * A pass on ONE backend is a FAIL: every scalar this run reads is resolved on
 * the CPU, in shared code, before the backend branch — so the two backends
 * disagreeing about it is a finding in itself.
 *
 * @param {Object<string,object>} evaluated Per-backend evaluations.
 * @returns {{verdict:string,exitCode:number,failures:string[],
 *            structural:string[]}}
 */
export function foldRadianceDeltaVerdict(evaluated) {
  const failures = [];
  const structural = [];
  for (const renderer of ["webgl", "webgpu"]) {
    const b = evaluated?.[renderer];
    if (!b) {
      structural.push(`${renderer} — lane absent; the delta cannot certify`);
      continue;
    }
    for (const [name, ok] of Object.entries(b.criteria)) {
      if (!ok) {
        failures.push(`${renderer}:${name}`);
      }
    }
    for (const note of b.structural) {
      structural.push(`${renderer}:${note}`);
    }
    if (b.structural.length === 0 && Object.keys(b.criteria).length === 0) {
      structural.push(
        `${renderer} — no criterion was evaluated at all; an empty criteria ` +
          "set is not a pass",
      );
    }
  }

  // (c) CROSS-BACKEND AGREEMENT on the recovered ratio. Scoped: it certifies
  // only when BOTH backends produced a non-structural reading, otherwise the
  // spread would be computed over a frame a lane already declared it could not
  // see. The numbers are printed either way.
  const gl = evaluated?.webgl;
  const gpu = evaluated?.webgpu;
  const a = gl?.diagnostics?.ratioMeasured;
  const b = gpu?.diagnostics?.ratioMeasured;
  const blocked = ["webgl", "webgpu"].filter(
    (r) => (evaluated?.[r]?.structural?.length ?? 1) > 0,
  );
  if (gl && gpu) {
    const spread = relativeSpread(a, b);
    if (blocked.length > 0) {
      structural.push(
        `cross-backend:recoveredRatio_parity — STRUCTURAL: ${blocked.join(", ")} ` +
          "could not see the subject. MEASURED ANYWAY: webgl " +
          `${a}, webgpu ${b}, relative spread ${spread}, bound ` +
          `${G4_CROSS_BACKEND_MAX_RELATIVE_SPREAD}. ` +
          STRUCTURAL_NON_VERDICT_MARKER,
      );
    } else if (!(spread <= G4_CROSS_BACKEND_MAX_RELATIVE_SPREAD)) {
      failures.push("cross-backend:recoveredRatio_parity");
    }
  }

  const exitCode =
    structural.length > 0
      ? EXIT_CODE.STRUCTURAL
      : failures.length > 0
        ? EXIT_CODE.FAIL
        : EXIT_CODE.PASS;
  const verdict =
    exitCode === EXIT_CODE.PASS
      ? "PASS"
      : exitCode === EXIT_CODE.FAIL
        ? "FAIL"
        : "STRUCTURAL";
  return { verdict, exitCode, failures, structural };
}

/**
 * Reduce a run result to the block the probe prints.
 *
 * @param {object} result The probe's assembled result.
 * @returns {object} Printable summary.
 */
export function buildRadianceDeltaSummary(result) {
  const backend = (b) =>
    b
      ? {
          criteria: b.criteria,
          structural: b.structural,
          diagnostics: b.diagnostics,
          reports: b.reports,
        }
      : null;
  return {
    lane: "sun-radiance-delta",
    verdict: result.verdict,
    exitCode: result.exitCode,
    bounds: {
      RADIANCE_DELTA_EXPOSURE,
      RADIANCE_DELTA_SAMPLE_X,
      RADIANCE_DELTA_BIN_HALF_PX,
      RADIANCE_DELTA_MIN_PLATEAU_PIXELS,
      RADIANCE_DELTA_MIN_RESOLVED_SEPARATION,
      PRE_REGISTERED_D1_CODES,
      PRE_REGISTRATION_AGREEMENT_CODES,
      ZERO_DITHER_QUANTUM_CODES,
      DISC_RADIANCE_RECOVERY_CEILING,
      BLOOM_FIELD_ANGULAR_SAMPLES,
      DISC_AIM_TOLERANCE_PX,
      DISC_MIN_DIFFERENTIAL_PIXELS,
      DISC_MIN_LIT_PIXELS,
      LIMB_DISC_ONLY_ANNULUS,
      LIMB_DISC_ONLY_CENTRE_RADIUS_PX,
      BRACKET_SATURATION_CODE,
      DISPLAY_GAMMA,
      G4_CROSS_BACKEND_MAX_RELATIVE_SPREAD,
      STRUCTURAL_NON_VERDICT_MARKER,
    },
    failures: result.failures,
    structural: result.structural,
    backends: {
      webgl: backend(result.backends?.webgl),
      webgpu: backend(result.backends?.webgpu),
    },
  };
}

/**
 * Recover the linear radiance a leg's plateau implies, with the instrument's
 * own resolution at that brightness attached.
 *
 * Split out so the probe's per-leg reduction stays a thin wrapper and the
 * quantum the discrimination's error bar is built from is, by construction, the
 * quantum the capture that produced the plateau was bracketed at.
 *
 * @param {{plateau:number,plateauPixels:number,exposures:readonly number[]}} o
 * @returns {{plateau:number,plateauPixels:number,plateauQuantumLinear:number,
 *            plateauQuantumExposure:number,plateauQuantumCode:number}}
 */
export function plateauResolution(o) {
  const q = bracketQuantum(o.plateau, o.exposures);
  return {
    plateau: o.plateau,
    plateauPixels: o.plateauPixels,
    plateauQuantumLinear: q.oneCodeLinear,
    plateauQuantumExposure: q.exposure,
    plateauQuantumCode: q.code,
  };
}

export default {
  RADIANCE_DELTA_LEGS,
  RADIANCE_DELTA_EXPOSURE,
  RADIANCE_DELTA_SAMPLE_X,
  RADIANCE_DELTA_BIN_HALF_PX,
  RADIANCE_DELTA_MIN_PLATEAU_PIXELS,
  RADIANCE_DELTA_MIN_RESOLVED_SEPARATION,
  PRE_REGISTERED_D1_CODES,
  PRE_REGISTERED_D1_CODES_NO_BLOOM,
  PRE_REGISTRATION_AGREEMENT_CODES,
  ZERO_DITHER_QUANTUM_CODES,
  DISC_RADIANCE_RECOVERY_CEILING,
  BLOOM_FIELD_ANGULAR_SAMPLES,
  EXCESS_SHAPE,
  brightPassSourceRadiusPx,
  discBloomGlowField,
  discBloomPlateauDifferential,
  discBloomSourceEdgeUncertaintyPx,
  discDifferentialCodeModel,
  deriveDiscDifferentialCodes,
  d1DiscriminationPower,
  peakChannelCodeImage,
  measureDiscDifferentialCodes,
  discriminateRadianceExcess,
  evaluateRadianceDeltaBackend,
  foldRadianceDeltaVerdict,
  buildRadianceDeltaSummary,
  plateauResolution,
};
