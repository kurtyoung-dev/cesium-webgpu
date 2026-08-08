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
// WHY D1 IS READ IN DISPLAY CODES. The halo cancels EXACTLY in linear light and
// only approximately in codes, because the display transform is non-linear and
// the halo shifts both legs' operating point along it. Reading D1 in codes is
// therefore the STRICTER test: it is sensitive to the absolute radiance as well
// as to the limb law, which is exactly the sensitivity a radiance question
// needs. The forward model below carries the halo explicitly for that reason.
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

/** Verdicts {@link discriminateRadianceExcess} can return. */
export const EXCESS_SHAPE = Object.freeze({
  MULTIPLICATIVE: "MULTIPLICATIVE",
  ADDITIVE: "ADDITIVE",
  NEITHER: "NEITHER",
  NONE: "NO-EXCESS",
});

// ---------------------------------------------------------------------------
// FORWARD MODEL
// ---------------------------------------------------------------------------

/**
 * The display code the sun composite lands on at one radius, on one disc leg.
 *
 * Four shipped lines and nothing else:
 *
 *   bake        rgb = (1, 1, clamp(limb + 0.2))     alpha = limb
 *   SunFS       rgb = pow(rgb, gamma) * discRadiance
 *   blend       out = rgb * alpha                   (over a dark sky)
 *   screen halo out += haloAmplitude * P(rho)
 *
 * evaluated on the PEAK channel, which is red and green: the bake writes those
 * as 1 before the gamma decode, so the peak channel carries `limb * L` with the
 * hue term absent. The peak channel is the right one to model because the
 * tonemapper's compression is a function of the triple's maximum, and it is the
 * one the measurement reads for the same reason.
 *
 * @param {{solarLimbIntensity:Function,solarScreenHaloProfile:Function,
 *          solarDiscDisplayCode:Function}} model The shipped `SolarDiscModel`
 *        namespace, or a mutant of it.
 * @param {{x:number,limbDarkened:boolean,discRadiance:number,
 *          haloAmplitude:number,haloCoreRadii:number,exposure:number,
 *          gamma?:number}} o
 * @returns {{linear:number,code:number}} Peak-channel radiance and its code.
 */
export function discDifferentialCodeModel(model, o) {
  const gamma = Number.isFinite(o?.gamma) ? o.gamma : SUN_BAKE_GAMMA_NOMINAL;
  const limb = o.limbDarkened ? model.solarLimbIntensity(o.x) : 1.0;
  const halo =
    o.haloAmplitude * model.solarScreenHaloProfile(o.x, o.haloCoreRadii);
  const linear = o.discRadiance * limb + halo;
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
 *          gamma?:number}} o Live-resolved appearance scalars and geometry.
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
  const d1At = (x) =>
    discDifferentialCodeModel(model, { ...base, x, limbDarkened: false }).code -
    discDifferentialCodeModel(model, { ...base, x, limbDarkened: true }).code;

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
    });
    const limb = discDifferentialCodeModel(model, {
      ...base,
      x,
      limbDarkened: true,
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
    const t2 = (Math.SQRT2 * 0.5) / Math.sqrt(nBin);
    // T3 — the binary16 bake, two legs.
    const t3 = Math.abs(d1Codes) * 2 * Math.pow(2, -11);
    const modelled = t1 + t2 + t3;
    const loBar = 3 * modelled;
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
      terms: { t1, t2, t3, slope, binPixels: nBin, modelled, loBar, hiBar },
    };
  });
  return { exposure, discRadiusPx, gamma, samples };
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
 * Decide whether the disc's rendered-versus-resolved radiance excess is
 * MULTIPLICATIVE or ADDITIVE, from the two legs' recovered plateaus.
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
 *          plateauPixels:number,plateauQuantumLinear:number}>}} o
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
  const recovered = {};
  for (const leg of legs) {
    recovered[leg.key] = leg.plateau / leg.resolvedRadiance;
  }
  const ratioMeasured = hi.plateau / lo.plateau;
  const ratioMultiplicative = hi.resolvedRadiance / lo.resolvedRadiance;
  const additiveConstant = hi.plateau - hi.resolvedRadiance;
  const ratioAdditive =
    lo.resolvedRadiance + additiveConstant !== 0
      ? (hi.resolvedRadiance + additiveConstant) /
        (lo.resolvedRadiance + additiveConstant)
      : NaN;

  // INSTRUMENT ERROR ON THE RATIO. Each plateau is an annulus mean whose
  // per-pixel resolution is one display code at that brightness, so its own
  // relative error is `oneCode / plateau / sqrt(N)`; the ratio carries both in
  // quadrature.
  const relOf = (leg) =>
    leg.plateauQuantumLinear > 0 && leg.plateauPixels > 0
      ? leg.plateauQuantumLinear / leg.plateau / Math.sqrt(leg.plateauPixels)
      : NaN;
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
    resolvedHi: hi.resolvedRadiance,
    resolvedLo: lo.resolvedRadiance,
  };

  // The two hypotheses are only distinguishable when their predictions are
  // further apart than the band that certifies either of them.
  if (!(separation > 2 * tolerance)) {
    return {
      verdict: EXCESS_SHAPE.NONE,
      usable: true,
      recovered,
      ratioMeasured,
      ratioMultiplicative,
      ratioAdditive,
      additiveConstant,
      separation,
      sigmaRatio,
      tolerance,
      terms,
    };
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
  return {
    verdict,
    usable: true,
    recovered,
    ratioMeasured,
    ratioMultiplicative,
    ratioAdditive,
    additiveConstant,
    separation,
    sigmaRatio,
    tolerance,
    terms,
  };
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
  diagnostics.excessVerdict = ex?.verdict ?? null;
  diagnostics.recovered = ex?.recovered ?? null;
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
  PRE_REGISTRATION_AGREEMENT_CODES,
  EXCESS_SHAPE,
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
