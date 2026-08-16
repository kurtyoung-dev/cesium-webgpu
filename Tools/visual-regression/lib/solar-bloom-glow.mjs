// solar-bloom-glow.mjs — the sun bloom's additive glow, as a forward model two
// lanes read.
// @purpose Forward model of the sun bloom's additive glow-on-disc so differential disc measurements carry the non-cancelling bloom term correctly.
// @status ACTIVE
//
// `SunPostProcess` (WebGL) and its WebGPU mirror run a bright-pass -> blur ->
// ADDITIVE-BLEND chain BEFORE the halo stage, and that chain puts light back
// ONTO the disc: `SolarDiscModel.solarBloomCentreAmplitude` is the shipped
// closed form of its centre value, 0.4815 at `discRadiance = 1` and 0.7071 at
// 2 — between a third and a half of the disc's own radiance.
//
// Any measurement that subtracts one disc leg from another has to carry it,
// because the bright pass reads the scene through a THRESHOLD and each leg
// presents it a different source, so the glow does NOT cancel in a differential:
//
//   flat - limb      the limb-darkened leg drops below the threshold partway
//                    out while the flat leg's source runs to the limb
//   flat - legacy    the legacy disc ENDS at `1/sqrt(2) R`, so over an annulus
//                    outside it the flat leg is still glowing and the legacy
//                    leg is not
//
// The two-radiance delta lane reads the first and the celestial G4 disc lane
// reads the second, against the same shipped chain — so the chain lives here,
// imported by both, rather than in either one of them. Nothing in this file
// imports either lane: it takes the model namespace and the geometry as
// arguments, which is also what lets a spec run it against a MUTANT model.
//
// @module solar-bloom-glow

// ---------------------------------------------------------------------------
// THE GLOW FIELD
// ---------------------------------------------------------------------------

/**
 * Angular samples the glow field is averaged over when it is read at a radius.
 *
 * The glow is NOT radially symmetric and cannot be made so: the blur runs on a
 * SQUARE power-of-two buffer covering a non-square viewport, so its one `step`
 * uniform is a different number of screen pixels on each axis (10.0 px in x
 * against 5.625 px in y at 1280x720). The measurement it is compared against is
 * an annulus MEAN, so the model has to take the same mean rather than evaluate
 * one direction and call it the radius.
 * @type {number}
 */
export const BLOOM_FIELD_ANGULAR_SAMPLES = 256;

/**
 * Radius, in drawing-buffer pixels, out to which ONE leg's disc still crosses
 * the bright pass's extraction threshold — i.e. the support of the source the
 * sun bloom is built from on that leg.
 *
 * `BrightPass.glsl` computes `scaled = key(avg) * luminance / avg` and extracts
 * `max(scaled - threshold, 0)`, so extraction starts at
 * `luminance = threshold / (key(avg)/avg)` exactly. On the FLAT and LEGACY legs
 * the disc's luminance is the constant `discRadiance`, so the source is the
 * disc or nothing; on the LIMB leg it is `discRadiance * limb(x)`, which crosses
 * the threshold at a radius strictly inside the limb. That crossing is why the
 * glow does not cancel out of `D1` and it is solved here in closed form from
 * the shipped quadratic law rather than searched for.
 *
 * @param {object} model The shipped `SolarDiscModel` namespace, or a mutant.
 * @param {{discRadiance:number,limbDarkened:boolean,discEdgePx:number}} o
 * @returns {number} Source radius in pixels; 0 when the leg never extracts.
 */
export function brightPassSourceRadiusPx(model, o) {
  const avg = model.SUN_BRIGHT_PASS_AVG_LUMINANCE;
  const scale = model.sunBrightPassKey(avg) / avg;
  const tuning = model.solarBrightPassTuning(o.discRadiance, avg);
  const needed = tuning.threshold / scale;
  const edge = o.discEdgePx;
  if (!(edge > 0)) {
    return 0;
  }
  if (o.limbDarkened !== true) {
    return o.discRadiance > needed ? edge : 0;
  }
  // `a0 + a1*mu + a2*mu^2 = needed / L`, with `a2 < 0`. The disc is brightest
  // at `mu = 1` and dims outward, so the crossing is the root the law reaches
  // FIRST going out from the centre, which is the larger `mu`.
  const target = needed / o.discRadiance;
  const a0 = model.SOLAR_LIMB_DARKENING_A0;
  const a1 = model.SOLAR_LIMB_DARKENING_A1;
  const a2 = model.SOLAR_LIMB_DARKENING_A2;
  if (!(model.solarLimbIntensity(0) > target)) {
    return 0;
  }
  if (model.solarLimbIntensity(1) >= target) {
    return edge;
  }
  const disc = a1 * a1 - 4 * a2 * (a0 - target);
  if (!(disc >= 0)) {
    return edge;
  }
  const mu = (-a1 + Math.sqrt(disc)) / (2 * a2);
  if (!(mu > 0 && mu < 1)) {
    return mu >= 1 ? 0 : edge;
  }
  return edge * Math.sqrt(Math.max(0, 1 - mu * mu));
}

/**
 * The sun bloom's additive glow, as a field that can be read at any radius.
 *
 * Every line of the shipped chain, in order, with nothing dialled:
 *
 *   stage 0  down-sample to `solarBloomBlurBufferSize(w, h)` square texels
 *   stage 1  `BrightPass.glsl` on that buffer
 *   stage 2  `GaussianBlur1D.glsl`, x, `sigma = SUN_BLOOM_BLUR_SIGMA`, and its
 *   stage 3  y twin, both at `step = 1 / bufferSize` (isotropic in TEXELS)
 *   stage 4  up-sample, bilinear
 *   stage 5  `AdditiveBlend.glsl` — `mix(glow + scene, scene, smoothstep(0.5,
 *            0.8, dist / solarBloomCompositeRadiusPx(limbPx)))`
 *
 * The blur weights are the un-normalised incremental Gaussian the shader
 * actually evaluates (its 15 taps sum to 0.99983, not to 1), because a model
 * that renormalised them would be describing a different picture.
 *
 * The bright pass is evaluated on the leg's OWN radial luminance rather than on
 * an indicator of its disc — that is the whole reason the glow does not cancel,
 * and an indicator would put the limb leg's source at full strength right up to
 * where it crosses the threshold instead of letting it decay into it.
 *
 * ⚠ THE ONE APPROXIMATION, AND WHERE ITS ERROR BAR COMES FROM. The disc's edge
 * is treated as a hard cut at `discEdgePx`. The real edge is soft twice over —
 * the bake's own texel (the disc's alpha is a bilinear reconstruction of a
 * `step()` across one bake texel) and the down-sample's point sampling (the
 * edge lands on a blur-buffer texel centre or it does not).
 * {@link discBloomSourceEdgeUncertaintyPx} states that bracket, and the callers
 * that need a tolerance derive it by moving the edge across it rather than by
 * choosing a number.
 *
 * @param {object} model The shipped `SolarDiscModel` namespace, or a mutant.
 * @param {{discRadiance:number,limbDarkened:boolean,discEdgePx:number,
 *          viewportWidth:number,viewportHeight:number,limbPx?:number,
 *          centerX?:number,centerY?:number}} o
 * @returns {{sampleAtRadiusPx:Function,bufferSize:number,
 *            sourceRadiusPx:number,centreAmplitude:number}}
 */
export function discBloomGlowField(model, o) {
  const width = o.viewportWidth;
  const height = o.viewportHeight;
  const n = model.solarBloomBlurBufferSize(width, height);
  const cx = Number.isFinite(o.centerX) ? o.centerX : width / 2;
  const cy = Number.isFinite(o.centerY) ? o.centerY : height / 2;
  const avg = model.SUN_BRIGHT_PASS_AVG_LUMINANCE;
  const scale = model.sunBrightPassKey(avg) / avg;
  const tuning = model.solarBrightPassTuning(o.discRadiance, avg);
  const edge = o.discEdgePx;
  // The scene luminance this leg presents the bright pass, at one radius. On a
  // dark sky the sun billboard's peak channel is `discRadiance * alpha` and
  // `alpha` IS the limb law, so this is the disc and nothing else — the screen
  // halo is stage 6, downstream of the whole bright-pass chain, and is not in
  // the picture the glow is extracted from.
  const luminanceAt = (r) => {
    if (!(edge > 0) || r > edge) {
      return 0;
    }
    return o.limbDarkened === true
      ? o.discRadiance * model.solarLimbIntensity(r / edge)
      : o.discRadiance;
  };
  const sourceRadiusPx = brightPassSourceRadiusPx(model, o);

  // The shipped incremental Gaussian, weights included, exactly as the shader
  // builds them: `g.x` starts at `1/(sqrt(2pi)*sigma)` and is stepped by `g.y`.
  const sigma = model.SUN_BLOOM_BLUR_SIGMA;
  const delta = model.SUN_BLOOM_BLUR_DELTA;
  const taps = [];
  {
    let gx = 1.0 / (Math.sqrt(2.0 * Math.PI) * sigma);
    let gy = Math.exp((-0.5 * delta * delta) / (sigma * sigma));
    const gz = gy * gy;
    taps.push([0, gx]);
    for (let i = 1; i < 8; i++) {
      gx *= gy;
      gy *= gz;
      taps.push([i, gx]);
    }
  }

  const src = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const px = ((i + 0.5) / n) * width - cx;
      const py = ((j + 0.5) / n) * height - cy;
      // `BrightPass.glsl`, verbatim, on this texel's luminance.
      const bright = Math.max(
        scale * luminanceAt(Math.hypot(px, py)) - tuning.threshold,
        0,
      );
      src[j * n + i] = bright / (tuning.offset + bright);
    }
  }
  const clamp = (v) => (v < 0 ? 0 : v > n - 1 ? n - 1 : v);
  const pass = (input, horizontal) => {
    const out = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (const [k, w] of taps) {
          if (k === 0) {
            acc += input[j * n + i] * w;
            continue;
          }
          const a = horizontal
            ? input[j * n + clamp(i - k)]
            : input[clamp(j - k) * n + i];
          const b = horizontal
            ? input[j * n + clamp(i + k)]
            : input[clamp(j + k) * n + i];
          acc += (a + b) * w;
        }
        out[j * n + i] = acc;
      }
    }
    return out;
  };
  const blurred = pass(pass(src, true), false);

  // Stage 5's radial fade. `limbPx` is the same scalar `SunHaloAppearance`
  // publishes; without it the composite radius is unknown and the honest
  // reading is "no fade", which is what the disc sees anyway (the fade starts
  // at 4.5 solar radii).
  const compositeRadius = model.solarBloomCompositeRadiusPx(
    Number.isFinite(o.limbPx) ? o.limbPx : 0,
  );
  const fadeAt = (r) => {
    if (!(compositeRadius > 0)) {
      return 1;
    }
    const t = r / compositeRadius;
    const u = Math.min(1, Math.max(0, (t - 0.5) / 0.3));
    return 1 - u * u * (3 - 2 * u);
  };

  const bilinear = (px, py) => {
    const u = (px / width) * n - 0.5;
    const v = (py / height) * n - 0.5;
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    const tu = u - i0;
    const tv = v - j0;
    const g = (i, j) => blurred[clamp(j) * n + clamp(i)];
    return (
      g(i0, j0) * (1 - tu) * (1 - tv) +
      g(i0 + 1, j0) * tu * (1 - tv) +
      g(i0, j0 + 1) * (1 - tu) * tv +
      g(i0 + 1, j0 + 1) * tu * tv
    );
  };

  const sampleAtRadiusPx = (r) => {
    if (!(r >= 0)) {
      return NaN;
    }
    let acc = 0;
    for (let a = 0; a < BLOOM_FIELD_ANGULAR_SAMPLES; a++) {
      const th = (2 * Math.PI * a) / BLOOM_FIELD_ANGULAR_SAMPLES;
      acc += bilinear(cx + r * Math.cos(th), cy + r * Math.sin(th));
    }
    return (acc / BLOOM_FIELD_ANGULAR_SAMPLES) * fadeAt(r);
  };

  return {
    sampleAtRadiusPx,
    bufferSize: n,
    sourceRadiusPx,
    centreAmplitude: model.solarBloomCentreAmplitude(o.discRadiance),
  };
}

/**
 * How far the bright pass's source edge is genuinely UNKNOWN, in drawing-buffer
 * pixels — the error bar {@link discBloomGlowField}'s hard-edge approximation
 * carries.
 *
 * Two quantized edges, added in quadrature because they are independent:
 *
 *   * THE BAKE TEXEL. The bake is `2^(ceil(log2(max(w,h))) - 2)` texels across
 *     a quad `2 * limbPx * (1 + 2*glowLengthTS)` pixels wide, and a bilinear
 *     reconstruction of the disc's `step()` spreads it over exactly one texel.
 *     Half of that is the distance the threshold crossing can sit from the
 *     geometric edge.
 *   * THE BLUR TEXEL. Stage 0 POINT-samples, so the source edge is resolved
 *     only to the blur buffer's own grid. Its coarser axis (the viewport's
 *     larger dimension) sets the bound.
 *
 * @param {object} model The shipped `SolarDiscModel` namespace, or a mutant.
 * @param {{limbPx:number,glowLengthTS?:number,viewportWidth:number,
 *          viewportHeight:number}} o
 * @returns {number} Half-width of the bracket, in pixels.
 */
export function discBloomSourceEdgeUncertaintyPx(model, o) {
  const glowLengthTS = Number.isFinite(o.glowLengthTS) ? o.glowLengthTS : 5.0;
  const w = o.viewportWidth;
  const h = o.viewportHeight;
  const bakeTexels = Math.max(
    1,
    Math.pow(2, Math.ceil(Math.log2(Math.max(w, h))) - 2),
  );
  const quadPx = 2 * o.limbPx * (1 + 2 * glowLengthTS);
  const bakeTexelPx = quadPx / bakeTexels;
  const blurTexelPx = Math.max(w, h) / model.solarBloomBlurBufferSize(w, h);
  return Math.hypot(0.5 * bakeTexelPx, 0.5 * blurTexelPx);
}

// ---------------------------------------------------------------------------
// THE PLATEAU CORRECTION
// ---------------------------------------------------------------------------

/**
 * The sun bloom's contribution to the `flat - legacy` PLATEAU, in the same
 * linear units the plateau is measured in — i.e. the number that has to come
 * OFF the plateau before it is read as a disc radiance.
 *
 * The annulus the plateau is averaged over sits INSIDE the true-size disc and
 * OUTSIDE the legacy one. Both legs carry the identical screen halo there and
 * it cancels exactly; the flat leg carries the disc and the legacy leg does
 * not, which is the reading the caller wants. But the flat leg is also still
 * GLOWING there and the legacy leg has stopped, because the legacy disc — the
 * bright pass's whole source on that leg — ended at `1/sqrt(2) R`, several blur
 * widths inside. That difference is a pure addition to the plateau and is what
 * an uncorrected recovery reads as a radiance excess.
 *
 * The average is weighted by radius, because an annulus mean over pixels is.
 *
 * `annulus` is REQUIRED and has no default here. Each lane owns the band its
 * own measurement averaged, and a default in this file would be a second
 * definition of somebody else's bound.
 *
 * @param {object} model The shipped `SolarDiscModel` namespace, or a mutant.
 * @param {{discRadiance:number,limbPx:number,viewportWidth:number,
 *          viewportHeight:number,annulus:{lo:number,hi:number},
 *          centerX?:number,centerY?:number,discEdgeShiftPx?:number,
 *          samples?:number}} o
 * @returns {number} Linear light the glow adds to the plateau; NaN when no
 *          usable annulus was supplied.
 */
export function discBloomPlateauDifferentialOver(model, o) {
  const band = o?.annulus;
  if (!(band?.lo >= 0) || !(band?.hi > band.lo)) {
    return NaN;
  }
  const shift = Number.isFinite(o.discEdgeShiftPx) ? o.discEdgeShiftPx : 0;
  const geometry = {
    discRadiance: o.discRadiance,
    limbPx: o.limbPx,
    viewportWidth: o.viewportWidth,
    viewportHeight: o.viewportHeight,
    centerX: o.centerX,
    centerY: o.centerY,
    limbDarkened: false,
  };
  const flat = discBloomGlowField(model, {
    ...geometry,
    discEdgePx: Math.max(0, o.limbPx + shift),
  });
  // The legacy disc is the true disc divided by the bakes' own length scalar —
  // `solarDiscBakeEdge` multiplies the legacy edge by it, so the ratio is that
  // constant and not a re-typed `sqrt(2)`.
  const legacyEdgePx = o.limbPx / model.SOLAR_DISC_BAKE_LENGTH_SCALAR;
  const legacy = discBloomGlowField(model, {
    ...geometry,
    discEdgePx: Math.max(0, legacyEdgePx + shift),
  });
  const n = Number.isFinite(o.samples) ? o.samples : 128;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const r = (band.lo + ((band.hi - band.lo) * (i + 0.5)) / n) * o.limbPx;
    num += r * (flat.sampleAtRadiusPx(r) - legacy.sampleAtRadiusPx(r));
    den += r;
  }
  return den > 0 ? num / den : NaN;
}

// ---------------------------------------------------------------------------
// THE RECOVERY BAR
// ---------------------------------------------------------------------------

/**
 * Fraction of the resolved disc radiance a glow-corrected recovery may miss by
 * before it is a finding rather than a modelling residual.
 *
 * DERIVED at evaluation time from {@link discBloomSourceEdgeUncertaintyPx} —
 * the glow's source edge is quantized twice (the bake's texel and the blur
 * buffer's), and moving it across that bracket moves the recovered radiance by
 * a computable amount. This constant is only the CEILING on that derivation, so
 * a run cannot invent an arbitrarily generous bar out of a degenerate geometry;
 * the derived number at the shipped framing is well inside it.
 * @type {number}
 */
export const DISC_RADIANCE_RECOVERY_CEILING = 0.05;

/**
 * The bar a glow-corrected radiance recovery is read against, as a fraction of
 * the resolved radiance.
 *
 * ONE definition, because both lanes that recover a radiance from a plateau
 * recover it the same way and must not drift apart on how much they allow. The
 * budget is three terms, and which of them are HARD bounds rather than sigmas
 * is what sets where the 3x stochastic margin applies:
 *
 *   glowError    HARD. The glow model treats the disc's edge as a cut at one
 *                radius; the real edge is quantized twice, and moving it across
 *                that bracket moves the correction by a computable amount.
 *                Enters at 1x — a bracket is already a worst case.
 *   undithered   HARD. Averaging beats quantization down only where the bin's
 *                pixels round DIFFERENTLY. Over a band across which a leg's own
 *                code does not sweep a full code, every pixel renders the same
 *                integer and `1/sqrt(N)` buys nothing; the caller states that
 *                residue per leg. A fully swept band contributes exactly zero.
 *   quant        STOCHASTIC. One display code on the plateau reading, over the
 *                annulus population. Enters at 3x.
 *
 * @param {{resolvedRadiance:number,glowError?:number,plateauQuantumLinear?:number,
 *          plateauPixels?:number,undithered?:number}} o
 * @returns {{tolRel:number,terms:{glowError:number,undithered:number,
 *            quant:number,budgetRel:number,capped:boolean}}}
 */
export function deriveGlowCorrectedRecoveryBar(o) {
  const glowError = Number.isFinite(o?.glowError) ? Math.abs(o.glowError) : 0;
  const undithered = Number.isFinite(o?.undithered)
    ? Math.abs(o.undithered)
    : 0;
  const quant =
    o?.plateauQuantumLinear > 0 && o?.plateauPixels > 0
      ? o.plateauQuantumLinear / Math.sqrt(o.plateauPixels)
      : 0;
  const budgetRel =
    o?.resolvedRadiance > 0
      ? (glowError + undithered + 3 * quant) / o.resolvedRadiance
      : NaN;
  const capped = budgetRel > DISC_RADIANCE_RECOVERY_CEILING;
  return {
    tolRel: Math.min(DISC_RADIANCE_RECOVERY_CEILING, budgetRel),
    terms: { glowError, undithered, quant, budgetRel, capped },
  };
}

export default {
  BLOOM_FIELD_ANGULAR_SAMPLES,
  DISC_RADIANCE_RECOVERY_CEILING,
  brightPassSourceRadiusPx,
  deriveGlowCorrectedRecoveryBar,
  discBloomGlowField,
  discBloomPlateauDifferentialOver,
  discBloomSourceEdgeUncertaintyPx,
};
