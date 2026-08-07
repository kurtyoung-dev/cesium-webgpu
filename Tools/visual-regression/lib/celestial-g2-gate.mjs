// celestial-g2-gate.mjs — pure verdict logic + display-transform inversion for
// the Campaign-12 **G2** gate ("white blobs": the star PSF, the delivered
// magnitude range, and C12-27's angular solar glare).
//
// WHAT G2 IS
// ----------
// `QUEUE_2026-07-19_CAMPAIGN12.md` §5:
//
//   G2 | White blobs | `r_1e-3 / r_core >= 8` — a Gaussian truncated at d=1.0
//   cannot exceed ~1.8, so this one number separates blob from star. Plus: two
//   agreeing log-log slopes in [-5,-2]; <25 clipped px/star; rendered
//   brightest:faintest >= 15:1 (today 4:1 by construction).
//
// and W2's gate row: "**G2** — must pass identically on **both** backends
// (shared code)". The `>= 8` figure is the CORE-COMPONENT HWHM definition; the
// orchestrator ruling `C12-G2-DEF` (Batch 748) binds the browser gate on the
// measurable COMPOSITE HWHM at **>= 4** instead, keeping the analytic `>= 8`
// proof in `starfield-psf.spec.mjs` as the math-layer guard. Both numbers are
// preserved so the change reads as the definitional calibration it is.
//
// C12-27 (angular solar glare) lands in W2 and is therefore gated by G2. Its
// own acceptance criterion — "stars at small angular separation dim measurably
// while stars at >90 deg separation are byte-identical to the no-Sun frame" —
// is carried here verbatim as the glare sub-lane.
//
// ─── WHY THE DISPLAY TRANSFORM HAD TO BE INVERTED ──────────────────────────
//
// Every G2 criterion is a RATIO taken across three or more decades of a radial
// profile, so it can only be read off a LINEAR-LIGHT image. The C12-02 bracket
// stitched `L = (v / 255) / f` — the raw 8-bit code divided by the exposure —
// on the stated assumption that "the display transform is locally LINEAR in the
// unclipped region". The shipped HDR chain is not:
//
//     PostProcessStages(exposure) -> czm_pbrNeutralTonemapping -> czm_inverseGamma
//
// (`Shaders/PostProcessStages/PbrNeutralTonemapping.glsl`, and the WGSL twin
// `Shaders/WebGPU/PostProcess/Tonemapping.wgsl`, which reproduces both). The
// gamma step alone is `pow(x, 1/2.2)`; PBR Neutral additionally subtracts a
// black offset that, for a neutral pixel below 0.08, leaves `6.25 x^2` — it
// SQUARES the faint end, which is precisely the halo region a PSF gate lives
// in. Measured on the shipped constants at the probe's own geometry, the naive
// stitch reports `r_1e-3/r_core = 9.01` where the linearized stitch reports
// 6.35 for the SAME synthetic profile, and 1.48 vs 2.07 for the old truncated
// Gaussian. Binding a gate to the naive number would be binding it to the
// tonemap.
//
// {@link displayToLinear} is the exact inverse, derived from the shipped shader
// bodies rather than fitted. `celestial-g2-gate.spec.mjs` round-trips it
// against a forward model transcribed from the same sources and runs the naive
// stitch as a REJECTED MUTANT.
//
// ─── BOTH BACKENDS, IDENTICALLY ────────────────────────────────────────────
//
// Campaign principle 5, maintainer-stated: the PSF is SHARED code (`StarField.wgsl`
// and `StarFieldFS.glsl` are character-identical and both consume
// `StarFieldMath.ts`), so a WebGPU-only pass is a FAIL, not a partial pass.
// {@link foldG2Verdict} evaluates every criterion per backend and names the
// backend in each failure string; there is no path by which one backend's
// green can carry the other.

/** sRGB-free display constants, transcribed from the shipped shaders. */

/**
 * `czm_gamma`'s shipped default — `Scene.js` sets `this.gamma = 2.2` and
 * `UniformState` forwards it to both backends. The bracket never changes it.
 * @type {number}
 */
export const DISPLAY_GAMMA = 2.2;

/** PBR Neutral `startCompression` (`0.8 - 0.04`). @type {number} */
export const PBRN_START_COMPRESSION = 0.76;

/** PBR Neutral `desaturation`. @type {number} */
export const PBRN_DESATURATION = 0.15;

/**
 * 8-bit code at or above which a bracket sample is treated as unusable.
 *
 * Inherited unchanged from the C12-02 stitch. It is not a "clip level" in
 * radiance terms — PBR Neutral asymptotes to 1.0 and never reaches it — it is
 * the point where one code value spans so much radiance that the sample stops
 * being informative.
 * @type {number}
 */
export const BRACKET_SATURATION_CODE = 250;

/**
 * Forward model of the shipped HDR display chain for one RGB triple, in
 * [0,1] linear scene radiance. Present so the spec can round-trip
 * {@link displayToLinear} against the thing it claims to invert.
 *
 * Transcribed from `czm_pbrNeutralTonemapping` (GLSL) / `pbrNeutralTonemap`
 * (WGSL); the two are asserted line-for-line equivalent by the spec.
 *
 * @param {number[]} rgb linear scene radiance, length 3
 * @returns {number[]} tonemapped radiance, length 3
 */
export function pbrNeutralTonemap(rgb) {
  const out = [rgb[0], rgb[1], rgb[2]];
  const x = Math.min(out[0], Math.min(out[1], out[2]));
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  out[0] -= offset;
  out[1] -= offset;
  out[2] -= offset;
  const peak = Math.max(out[0], Math.max(out[1], out[2]));
  if (peak < PBRN_START_COMPRESSION) {
    return out;
  }
  const d = 1.0 - PBRN_START_COMPRESSION;
  const newPeak = 1.0 - (d * d) / (peak + d - PBRN_START_COMPRESSION);
  const scale = newPeak / peak;
  out[0] *= scale;
  out[1] *= scale;
  out[2] *= scale;
  const g = 1.0 - 1.0 / (PBRN_DESATURATION * (peak - newPeak) + 1.0);
  return out.map((v) => v * (1.0 - g) + newPeak * g);
}

/**
 * Exact inverse of {@link pbrNeutralTonemap}.
 *
 * Both branches are invertible in closed form:
 *   * UNCOMPRESSED (`max(t) < startCompression`) — the operator is a uniform
 *     subtraction, so `min(t)` determines the offset: below `6.25*0.08^2 =
 *     0.04` the input minimum was `sqrt(min(t)/6.25)`, above it `min(t) + 0.04`.
 *   * COMPRESSED — `max(t)` IS `newPeak` (the desaturation mix leaves the peak
 *     channel at `newPeak`), so `peak` follows from the `newPeak` formula, `g`
 *     from `peak` and `newPeak`, and the mix and rescale are undone in order.
 *
 * @param {number[]} t tonemapped radiance, length 3
 * @returns {number[]} linear scene radiance, length 3
 */
export function pbrNeutralTonemapInverse(t) {
  const peakOut = Math.max(t[0], Math.max(t[1], t[2]));
  let c1;
  if (peakOut < PBRN_START_COMPRESSION) {
    c1 = [t[0], t[1], t[2]];
  } else {
    // `newPeak` -> 1 as `peak` -> infinity, so an output that quantized to
    // exactly 1.0 carries no upper bound at all. Clamp just below 1 and let the
    // caller's saturation flag say the sample is a LOWER BOUND, not a value.
    const newPeak = Math.min(peakOut, 1.0 - 1e-6);
    const d = 1.0 - PBRN_START_COMPRESSION;
    const peak = PBRN_START_COMPRESSION - d + (d * d) / (1.0 - newPeak);
    const g = 1.0 - 1.0 / (PBRN_DESATURATION * (peak - newPeak) + 1.0);
    const c2 = t.map((v) =>
      g >= 1.0 ? newPeak : (v - g * newPeak) / (1.0 - g),
    );
    const scale = peak / newPeak;
    c1 = c2.map((v) => v * scale);
  }
  const minOut = Math.min(c1[0], Math.min(c1[1], c1[2]));
  const x =
    minOut < 0.04 ? Math.sqrt(Math.max(minOut, 0.0) / 6.25) : minOut + 0.04;
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  return c1.map((v) => v + offset);
}

/**
 * Invert the whole shipped chain for one captured 8-bit pixel.
 *
 * @param {number} r 8-bit red
 * @param {number} g 8-bit green
 * @param {number} b 8-bit blue
 * @param {number} exposure `scene.postProcessStages.exposure` used for the capture
 * @param {{gamma?:number}} [options]
 * @returns {number[]} linear scene radiance, length 3
 */
export function displayToLinear(r, g, b, exposure, options = {}) {
  const gamma = options.gamma ?? DISPLAY_GAMMA;
  const t = [r, g, b].map((v) => Math.pow(Math.max(v, 0) / 255, gamma));
  const lin = pbrNeutralTonemapInverse(t);
  return lin.map((v) => v / exposure);
}

/**
 * Stitch an exposure bracket into a LINEAR-LIGHT float image.
 *
 * Same selection rule as the C12-02 stitch — take the highest exposure whose
 * sample is still unsaturated, because that maximises the signal-to-quantization
 * ratio at that pixel — but the sample is inverted through the shipped display
 * chain instead of being divided by 255. The choice is made on the pixel's
 * BRIGHTEST channel rather than per channel: PBR Neutral's offset and
 * compression are functions of the whole triple, so a per-channel mix of
 * exposures would invert against the wrong branch.
 *
 * @param {{data:ArrayLike<number>,width:number,height:number,exposureFactor:number}[]} captures
 * @param {{gamma?:number,saturationCode?:number}} [options]
 * @returns {{data:Float64Array,width:number,height:number,
 *            saturatedPixels:number}} linear-light composite; `saturatedPixels`
 *          counts pixels for which even the lowest exposure was saturated, i.e.
 *          pixels whose value is a LOWER BOUND.
 */
export function stitchBracketLinear(captures, options = {}) {
  const saturationCode = options.saturationCode ?? BRACKET_SATURATION_CODE;
  const { width, height } = captures[0];
  const n = width * height * 4;
  const out = new Float64Array(n);
  const ordered = captures
    .slice()
    .sort((a, b) => b.exposureFactor - a.exposureFactor);
  const lowest = ordered[ordered.length - 1];
  let saturatedPixels = 0;
  for (let i = 0; i < n; i += 4) {
    let chosen = null;
    for (const cap of ordered) {
      const peak = Math.max(
        cap.data[i],
        Math.max(cap.data[i + 1], cap.data[i + 2]),
      );
      if (peak < saturationCode) {
        chosen = cap;
        break;
      }
    }
    if (chosen === null) {
      chosen = lowest;
      saturatedPixels++;
    }
    const lin = displayToLinear(
      chosen.data[i],
      chosen.data[i + 1],
      chosen.data[i + 2],
      chosen.exposureFactor,
      options,
    );
    out[i] = lin[0];
    out[i + 1] = lin[1];
    out[i + 2] = lin[2];
    out[i + 3] = 1;
  }
  return { data: out, width, height, saturatedPixels };
}

// ---------------------------------------------------------------------------
// G2 THRESHOLDS
// ---------------------------------------------------------------------------

/**
 * Minimum number of pixels at which the exposure bracket must recover signal
 * the 1x capture quantized to hard zero.
 *
 * This is the bracket's own non-vacuity control: "an 8-bit readback cannot
 * measure a halo to 1e-3 of peak" is C12-02's whole premise, and a run in which
 * the 64x lane added nothing has not tested it. DERIVED from the modelled
 * profile at the telescope framing: the 1x capture quantizes to 0 beyond
 * ~78 px while the wing is still non-zero out to the quad edge at ~88.8 px, an
 * annulus of ~5,200 pixels. The bar is 50 — a 100x margin — because its job is
 * to refuse "one stray pixel" as evidence of four recovered decades.
 * @type {number}
 */
export const PSF_MIN_SUBFLOOR_RECOVERED = 50;

/**
 * G2 headline, as bound by orchestrator ruling `C12-G2-DEF` (Batch 748):
 * `r_1e-3 / r_core >= 4` on the MEASURABLE COMPOSITE-HWHM definition.
 *
 * Derivation and separation, computed on the shipped constants through the
 * shipped display chain at this probe's telescope framing (`fovX = 6 deg`,
 * 1280x720):
 *   NEW Moffat core+wing, brightest catalogue star : **7.20**
 *   OLD truncated Gaussian (the blob this replaced) : **1.79**
 * The bar sits between them with 1.8x margin above the blob and 1.8x below the
 * star. The analytic CORE-COMPONENT figure (`>= 8`, value 11.7) is unchanged
 * and still guarded by `starfield-psf.spec.mjs`.
 *
 * @type {number}
 */
export const PSF_RATIO_1E3_MIN = 4.0;

/**
 * "Two agreeing log-log slopes in [-5,-2]" (queue §5).
 *
 * The lower bound is the Moffat asymptote `-2*BETA = -4` with a decade of
 * slack; the upper bound rejects anything shallower than an inverse-square
 * wing. A truncated Gaussian has no power-law wing at all and produces a slope
 * that either steepens without bound or is UNMEASURABLE — both fail.
 * @type {{lo:number,hi:number}}
 */
export const PSF_SLOPE_BAND = Object.freeze({ lo: -5.0, hi: -2.0 });

/**
 * How far the inner and outer log-log slopes may disagree and still be called
 * "agreeing".
 *
 * DERIVED, not fitted: a Moffat wing has a CONSTANT asymptotic log-log slope,
 * so the two windows measure the same number up to where the core still
 * contributes. Simulated through the shipped chain at the telescope framing the
 * two windows read -3.560 and -3.633 — a gap of 0.073. The bound is 1.0, i.e.
 * 13x the modelled gap, because the measurement is on real pixels with
 * antialiasing and 8-bit quantization; it is still far tighter than the 3.0
 * span of the band itself.
 *
 * @type {number}
 */
export const PSF_SLOPE_AGREEMENT_MAX = 1.0;

/**
 * Maximum clipped pixels around the brightest star (queue §5: "<25 clipped
 * px/star").
 *
 * "Clipped" is evaluated in LINEAR SCENE RADIANCE against the LDR white point
 * of 1.0, NOT against 8-bit code 250. Under PBR Neutral a radiance of 1.0
 * renders as code 239 and code 250 is radiance ~2.6, so a code-based census
 * would silently move the criterion by a factor of 2.6 — the sort of definition
 * drift `C12-G2-DEF` exists to prevent.
 *
 * @type {number}
 */
export const CLIPPED_PIXELS_MAX = 25;

/**
 * Radius, in pixels, of the disc searched for clipped pixels around the
 * brightest detection. Generous: the analytic clip radius for the brightest
 * catalogue star is <= 1.5 px at the default framing, so 20 px cannot miss the
 * plateau it is bounding and cannot be gamed by shrinking the search.
 * @type {number}
 */
export const CLIPPED_SEARCH_RADIUS_PX = 20;

/**
 * G2 criterion 5 — rendered brightest:faintest peak ratio.
 *
 * Straight from the queue (">= 15:1; today 4:1 by construction") and from
 * `StarFieldMath.ts`, which anchors the exposure so that
 * `1.0 / FAINT_ANCHOR_PEAK = 1/0.06 = 16.7`. It is a regression gate against
 * the retired `FLUX_GAMMA = 0.5` band, which delivered 4:1.
 * @type {number}
 */
export const RENDERED_RANGE_MIN = 15.0;

/**
 * Minimum Spearman rank correlation between rendered peak and catalogue flux
 * over the UNCLIPPED matched stars.
 *
 * The retired gamma band destroyed flux ordering; linear Pogson preserves it
 * exactly, so the modelled value is 1.0. 0.90 leaves room for sub-pixel
 * sampling phase (which perturbs individual peaks by up to ~20%) without
 * admitting a compressed mapping.
 *
 * ⚠ FIRST-PASS DERIVED. No Edge run has produced this number yet.
 * @type {number}
 */
export const MAGNITUDE_SPEARMAN_MIN = 0.9;

/**
 * Minimum number of catalogue stars that must cross-match before the magnitude
 * sub-lane is allowed to return a verdict. Below this the rank correlation is
 * noise and the lane is STRUCTURAL, not FAIL.
 *
 * DERIVED FROM SKY DENSITY, not from a run. The default-framing crop spans
 * ~46.9 x 30 deg = ~1,400 square degrees, i.e. 3.4% of the sky; ~200 stars
 * are brighter than vmag 3.6 (the exposure anchor, and the faintest magnitude
 * the M1 census floor is guaranteed to resolve), so a uniform sky would put ~7
 * of them in frame. The aim is Sirius, and Canis Major / Orion / Puppis is one
 * of the richest fields there is, so the expected count is comfortably higher —
 * but the bar is set from the uniform-sky figure so it does not depend on that.
 * @type {number}
 */
export const MAGNITUDE_MIN_MATCHED = 6;

/**
 * Linear scene radiance at which a pixel counts as CLIPPED — the LDR white
 * point the C12-07 amplitude restructure is defined against.
 * @type {number}
 */
export const CLIP_LEVEL_LINEAR = 1.0;

/**
 * C12-27 far-field: the number of pixels allowed to differ between the
 * glare-ON and glare-OFF frames when every star in view is beyond the veil's
 * 90-degree support.
 *
 * EXACTLY ZERO, and that is the row's own acceptance criterion, not a tightened
 * one: `SOLAR_GLARE_ANGULAR_SUPPORT` is `PI/2`, the pedestal subtraction takes
 * the curve to exactly 0.0 there, every consumer additionally early-outs on
 * `cos(theta) <= 0`, and `x * 1.0 === x` for every finite IEEE-754 x. The
 * claim is byte-identity, not similarity.
 * @type {number}
 */
export const GLARE_FAR_FIELD_MAX_DIFFERING_PIXELS = 0;

/**
 * C12-27 near-field: minimum fraction of total frame energy the veil must
 * remove when the camera looks straight at the Sun.
 *
 * ⚠ FIRST-PASS DERIVED, NOT MEASURED. Geometry: the crop's most distant corner
 * from frame centre subtends 27.7 deg at the default 60-degree horizontal FOV,
 * where the shipped curve's veil is 0.0339 — so EVERY lit pixel in the frame
 * loses at least 3.4% of its radiance, and pixels within the 5.477-degree
 * half-amplitude angle lose at least 49.8%. The analytic energy-weighted floor
 * is therefore >= 0.034. The bar is set at 0.01, a third of that, because the
 * diffuse cube map peaks at 8-28 code values and an 8-bit capture rounds part
 * of its share of the drop away. Re-derive from the first Edge run.
 * @type {number}
 */
export const GLARE_NEAR_FIELD_MIN_ENERGY_DROP_FRACTION = 0.01;

/**
 * C12-27 near-field: minimum number of pixels that must actually change.
 *
 * ⚠ FIRST-PASS DERIVED. The veil exceeds 2.9% over the whole crop (see above),
 * and the crop is 640,000 pixels; even if only the brightest 1% of them register
 * a one-code change, that is 6,400. The bar is 1,000 — a 6x margin — and its
 * job is to refuse a "measurable dim" claim built on a handful of pixels.
 * @type {number}
 */
export const GLARE_NEAR_FIELD_MIN_CHANGED_PIXELS = 1000;

/**
 * Positive control for the far-field byte-identity claim: two BLACK frames are
 * also byte-identical. The anti-solar frame must carry content.
 *
 * The cube map covers the entire sky, so essentially every one of the 640,000
 * crop pixels is lit; 1,000 is 0.16% of that. A zero bar would be preferable on
 * principle but would be satisfied by a single stuck pixel, which is exactly
 * the vacuity this control exists to refuse.
 * @type {number}
 */
export const GLARE_MIN_LIT_PIXELS = 1000;

/** Verdict exit codes — the same contract as G1. */
export const EXIT_CODE = Object.freeze({
  PASS: 0,
  FAIL: 1,
  ERROR: 2,
  STRUCTURAL: 3,
});

/**
 * @param {number|null} x
 * @param {{lo:number,hi:number}} band
 * @returns {boolean} false for null/NaN without an explicit guard at call sites
 */
export function inBand(x, band) {
  return Number.isFinite(x) && x >= band.lo && x <= band.hi;
}

// ---------------------------------------------------------------------------
// SUB-LANE EVALUATION — one backend at a time. Every function returns
// `{criteria, structural, pass}` where `structural` is a list of reasons the
// leg could not see its subject. `pass` is guarded explicitly against the
// vacuous `{}.every(Boolean) === true`.
// ---------------------------------------------------------------------------

/**
 * PSF sub-lane — the "white blobs" measurement proper.
 *
 * @param {{sources:number,rCore:number,r1e3:number,ratio1e3:number,
 *          slopeInner:number,slopeOuter:number,rangeExtended:boolean,
 *          hdrEngaged:boolean}} m
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean}}
 */
export function evaluatePsfSubLane(m) {
  const structural = [];
  if (m?.hdrEngaged !== true) {
    structural.push(
      "the HDR path never engaged, so the exposure bracket did nothing and the " +
        "halo was never captured",
    );
  }
  if (!(m?.sources > 0)) {
    structural.push(
      "no resolved source was censused in the telescope frame — there is no " +
        "profile to measure",
    );
  } else if (!Number.isFinite(m.rCore) || !Number.isFinite(m.r1e3)) {
    structural.push(
      "the radial profile never crossed one of its isophotes inside the search " +
        "radius, so r_core / r_1e-3 are undefined",
    );
  }
  if (structural.length > 0) {
    return { criteria: {}, structural, pass: false };
  }
  const slopeGap = Math.abs(m.slopeInner - m.slopeOuter);
  const criteria = {
    psf_rangeExtended:
      Number.isFinite(m.subFloorPixelsRecovered) &&
      m.subFloorPixelsRecovered >= PSF_MIN_SUBFLOOR_RECOVERED,
    psf_ratio1e3_ge_4: Number.isFinite(m.ratio1e3)
      ? m.ratio1e3 >= PSF_RATIO_1E3_MIN
      : false,
    psf_slopeInner_in_band: inBand(m.slopeInner, PSF_SLOPE_BAND),
    psf_slopeOuter_in_band: inBand(m.slopeOuter, PSF_SLOPE_BAND),
    psf_slopes_agree: Number.isFinite(slopeGap)
      ? slopeGap <= PSF_SLOPE_AGREEMENT_MAX
      : false,
  };
  return {
    criteria,
    structural,
    slopeGap,
    pass: Object.values(criteria).every(Boolean),
  };
}

/**
 * Magnitude sub-lane — delivered dynamic range and flux ordering.
 *
 * `renderedRange` is `min(peak_brightest, 1.0) / peak_faintest` in LINEAR SCENE
 * RADIANCE, i.e. exactly the quantity `StarFieldMath.ts` anchors the exposure
 * against ("the rendered brightest(clipped 1.0):faintest peak ratio is >= 15:1,
 * ~16.7:1 at the anchor"). Clipping the numerator at the LDR white point is what
 * makes this a statement about what the DISPLAY delivers rather than a restatement
 * of the catalogue's own flux ratio — and it also removes the top-end 8-bit
 * quantization, which spans whole magnitudes per code value under PBR Neutral.
 *
 * `spearman` is taken over the UNCLIPPED matched subset only. A clipped star's
 * peak carries no ordering information, and several of them tie at the same
 * value, which would depress the correlation for a reason that has nothing to do
 * with the mapping under test.
 *
 * @param {{matched:number,matchedUnclipped:number,spearman:number,
 *          renderedRange:number,clippedPixels:number}} m
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean}}
 */
export function evaluateMagnitudeSubLane(m) {
  const structural = [];
  const matched = m?.matched ?? 0;
  const matchedUnclipped = m?.matchedUnclipped ?? 0;
  if (matched < MAGNITUDE_MIN_MATCHED) {
    structural.push(
      `only ${matched} catalogue star(s) cross-matched (need ${MAGNITUDE_MIN_MATCHED}) — ` +
        "the delivered range and the flux ordering are both unmeasurable here",
    );
    return { criteria: {}, structural, pass: false };
  }
  if (matchedUnclipped < MAGNITUDE_MIN_MATCHED) {
    structural.push(
      `only ${matchedUnclipped} of ${matched} matched stars are UNCLIPPED (need ` +
        `${MAGNITUDE_MIN_MATCHED}) — a rank correlation over clipped peaks measures ties`,
    );
    return { criteria: {}, structural, pass: false };
  }
  const criteria = {
    mag_renderedRange_ge_15: Number.isFinite(m.renderedRange)
      ? m.renderedRange >= RENDERED_RANGE_MIN
      : false,
    mag_spearman_ge_0_90: Number.isFinite(m.spearman)
      ? m.spearman >= MAGNITUDE_SPEARMAN_MIN
      : false,
    mag_clippedPixels_le_25: Number.isFinite(m.clippedPixels)
      ? m.clippedPixels <= CLIPPED_PIXELS_MAX
      : false,
  };
  return { criteria, structural, pass: Object.values(criteria).every(Boolean) };
}

/**
 * Glare sub-lane — C12-27's acceptance criterion, both halves.
 *
 * FAR field (anti-solar aim, every star beyond 90 deg): toggling the veil must
 * change NOTHING. The A/A control is what makes that claim falsifiable rather
 * than lucky: two captures of the SAME state must themselves be byte-identical,
 * or the renderer is not deterministic enough for a byte-identity claim and the
 * leg is STRUCTURAL rather than PASS.
 *
 * NEAR field (sun-facing aim): the veil must remove measurable energy, and —
 * because the veil is a pure dim — it must not brighten a single pixel.
 *
 * Both halves additionally require the resolved `strength` to be non-zero in
 * the ON leg. `SolarGlareAppearance` multiplies by `eclipseState.sunVisibleFraction`,
 * so a camera with the Earth between it and the Sun resolves strength 0 and the
 * whole test would pass vacuously.
 *
 * @param {object} m
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean}}
 */
export function evaluateGlareSubLane(m) {
  const structural = [];
  if (!(m?.onStrength > 0)) {
    structural.push(
      `the glare resolved to strength ${m?.onStrength ?? "null"} in the ON leg ` +
        "(toggle off, or the Sun is not visible from this camera) — every glare " +
        "criterion would pass vacuously",
    );
  }
  if (m?.offStrength !== 0) {
    structural.push(
      `the glare resolved to strength ${m?.offStrength ?? "null"} in the OFF leg; ` +
        "the OFF position is supposed to be exactly 0",
    );
  }
  if (!(m?.farLitPixels >= GLARE_MIN_LIT_PIXELS)) {
    structural.push(
      `the anti-solar frame carried only ${m?.farLitPixels ?? 0} lit pixels ` +
        `(need ${GLARE_MIN_LIT_PIXELS}) — two black frames are byte-identical too`,
    );
  }
  if (m?.farAaDifferingPixels !== 0) {
    structural.push(
      `the A/A control differed in ${m?.farAaDifferingPixels ?? "?"} pixels: two ` +
        "captures of the SAME state are not byte-identical, so this renderer " +
        "cannot support a byte-identity claim at all",
    );
  }
  if (structural.length > 0) {
    return { criteria: {}, structural, pass: false };
  }
  const criteria = {
    glare_farField_byteIdentical:
      m.farDifferingPixels <= GLARE_FAR_FIELD_MAX_DIFFERING_PIXELS,
    glare_nearField_energyDrop_ge_bound:
      Number.isFinite(m.nearEnergyDropFraction) &&
      m.nearEnergyDropFraction >= GLARE_NEAR_FIELD_MIN_ENERGY_DROP_FRACTION,
    glare_nearField_changedPixels_ge_bound:
      Number.isFinite(m.nearDifferingPixels) &&
      m.nearDifferingPixels >= GLARE_NEAR_FIELD_MIN_CHANGED_PIXELS,
    // The veil can only ever remove radiance. A brightened pixel means the
    // toggle changed something other than the veil.
    glare_nearField_noPixelBrightened: m.nearBrightenedPixels === 0,
  };
  return { criteria, structural, pass: Object.values(criteria).every(Boolean) };
}

/**
 * Evaluate one backend's whole G2 lane.
 *
 * @param {{renderer:string,psf:object,magnitude:object,glare:object}} backend
 * @returns {object}
 */
export function evaluateG2Backend(backend) {
  const psf = evaluatePsfSubLane(backend.psf);
  const magnitude = evaluateMagnitudeSubLane(backend.magnitude);
  const glare = evaluateGlareSubLane(backend.glare);
  const criteria = {
    ...psf.criteria,
    ...magnitude.criteria,
    ...glare.criteria,
  };
  const structural = [
    ...psf.structural.map((s) => `psf: ${s}`),
    ...magnitude.structural.map((s) => `magnitude: ${s}`),
    ...glare.structural.map((s) => `glare: ${s}`),
  ];
  return {
    renderer: backend.renderer,
    subLanes: { psf, magnitude, glare },
    // Carried to the top level so `foldG2Verdict` can compare the two backends'
    // PSF measurements without reaching into a sub-lane's internals.
    psfRatio1e3: backend.psf?.ratio1e3 ?? null,
    psfReport: backend.psf ?? null,
    magnitudeReport: backend.magnitude ?? null,
    glareReport: backend.glare ?? null,
    criteria,
    structural,
    // Explicit: an empty criteria set (every sub-lane structural) must NOT read
    // as a clean sheet.
    pass:
      structural.length === 0 &&
      Object.keys(criteria).length > 0 &&
      Object.values(criteria).every(Boolean),
  };
}

/**
 * Cross-backend parity of the PSF measurement itself.
 *
 * The PSF is shared code, so the two backends should measure the same profile.
 * A symmetric relative bound rather than an absolute one, because `ratio1e3` is
 * itself a ratio.
 *
 * ⚠ FIRST-PASS DERIVED: 15%. No Edge run has produced the pair yet; the
 * modelled value is identical on both backends by construction (one profile,
 * one set of constants), so any measured spread is sampling and quantization.
 * @type {number}
 */
export const PSF_CROSS_BACKEND_MAX_RELATIVE_SPREAD = 0.15;

/**
 * Fold the two backends into one G2 verdict.
 *
 * PRECEDENCE, identical to G1's: a criterion failure on a backend that COULD
 * see its subject outranks a structural leg, and a structural leg outranks a
 * clean sheet. A backend that passes while the other fails is a FAIL for the
 * gate — G2 covers shared code and campaign principle 5 forbids a one-backend
 * pass.
 *
 * @param {{webgl:object,webgpu:object}} evaluated
 * @returns {{verdict:string,exitCode:number,failures:string[],structural:string[]}}
 */
export function foldG2Verdict(evaluated) {
  const failures = [];
  const structural = [];

  for (const renderer of ["webgl", "webgpu"]) {
    const b = evaluated?.[renderer];
    if (!b) {
      structural.push(
        `${renderer} — lane absent; G2 cannot certify shared code`,
      );
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
        `${renderer} — no criterion was evaluated at all; an empty criteria set ` +
          "is not a pass",
      );
    }
  }

  // SHARED-CODE PARITY. Only meaningful when both sides actually measured a
  // profile; otherwise the per-backend structural notes already say why.
  const glRatio = evaluated?.webgl?.psfRatio1e3;
  const gpuRatio = evaluated?.webgpu?.psfRatio1e3;
  if (Number.isFinite(glRatio) && Number.isFinite(gpuRatio)) {
    const mean = 0.5 * (glRatio + gpuRatio);
    const spread = mean > 0 ? Math.abs(gpuRatio - glRatio) / mean : Infinity;
    if (!(spread <= PSF_CROSS_BACKEND_MAX_RELATIVE_SPREAD)) {
      failures.push(
        `cross-backend:psf_ratio1e3_parity (webgl ${glRatio}, webgpu ${gpuRatio}, ` +
          `relative spread ${spread})`,
      );
    }
  }

  let verdict = "PASS";
  let exitCode = EXIT_CODE.PASS;
  if (failures.length > 0) {
    verdict = "FAIL";
    exitCode = EXIT_CODE.FAIL;
  } else if (structural.length > 0) {
    verdict = "STRUCTURAL";
    exitCode = EXIT_CODE.STRUCTURAL;
  }
  return { verdict, exitCode, failures, structural };
}

/**
 * Build the printed G2 summary. Every bound travels WITH the number it bounds,
 * so a red gate can be read without opening this file.
 *
 * @param {object} result
 * @returns {object}
 */
export function buildG2Summary(result) {
  const backend = (b) =>
    b
      ? {
          criteria: b.criteria,
          structural: b.structural,
          psf: b.psfReport ?? null,
          magnitude: b.magnitudeReport ?? null,
          glare: b.glareReport ?? null,
        }
      : null;
  return {
    gate: "G2",
    verdict: result.verdict,
    exitCode: result.exitCode,
    bounds: {
      PSF_MIN_SUBFLOOR_RECOVERED,
      PSF_RATIO_1E3_MIN,
      PSF_SLOPE_BAND,
      PSF_SLOPE_AGREEMENT_MAX,
      CLIPPED_PIXELS_MAX,
      CLIP_LEVEL_LINEAR,
      RENDERED_RANGE_MIN,
      MAGNITUDE_SPEARMAN_MIN,
      MAGNITUDE_MIN_MATCHED,
      GLARE_FAR_FIELD_MAX_DIFFERING_PIXELS,
      GLARE_NEAR_FIELD_MIN_ENERGY_DROP_FRACTION,
      GLARE_NEAR_FIELD_MIN_CHANGED_PIXELS,
      GLARE_MIN_LIT_PIXELS,
      PSF_CROSS_BACKEND_MAX_RELATIVE_SPREAD,
    },
    failures: result.failures,
    structural: result.structural,
    backends: {
      webgl: backend(result.backends?.webgl),
      webgpu: backend(result.backends?.webgpu),
    },
  };
}

export default {
  PSF_MIN_SUBFLOOR_RECOVERED,
  DISPLAY_GAMMA,
  PBRN_START_COMPRESSION,
  PBRN_DESATURATION,
  BRACKET_SATURATION_CODE,
  pbrNeutralTonemap,
  pbrNeutralTonemapInverse,
  displayToLinear,
  stitchBracketLinear,
  evaluatePsfSubLane,
  evaluateMagnitudeSubLane,
  evaluateGlareSubLane,
  evaluateG2Backend,
  foldG2Verdict,
  buildG2Summary,
};
