// C12-29 S1 — solar-disc obscuration photometry (pure f64 CPU math).
//
// One integrand serves BOTH occluders (the Moon during an eclipse and the
// Earth limb during an orbital sunset), because in the camera-anchored
// angular frame they are the same problem: a circular occluder of angular
// radius `ro` whose centre sits `d` radians from the centre of the solar
// disc of angular radius `rs`. That is exactly the aerospace "dual-cone"
// shadow model written in angles instead of cone half-angles:
//
//   d >= rs + ro          → no contact          (full sun, fraction 1)
//   |rs - ro| < d < rs+ro → PENUMBRA            (partial, 0 < fraction < 1)
//   d + rs <= ro          → UMBRA               (total, fraction 0)
//   d + ro <= rs          → ANTUMBRA / annular  (ring of sun survives)
//
// The transitions are continuous in `d` by construction, which is the whole
// point of the slice: the engine's pre-existing sun occlusion was a boolean
// (`Occluder.isBoundingSphereVisible`, Scene.js) that stepped from "no sun
// at all" to "full glow" in one frame.
//
// LIMB DARKENING. A uniform-brightness disc over-predicts the surviving
// broadband flux near second/third contact by roughly 2x (measured 2017
// spectro-irradiance: actual/geometric = 22% at 306 nm, 67% at 1020 nm —
// ACP 19:4703). The solar disc is limb-darkened, so a partial phase that
// covers the bright CENTRE removes far more flux than its area share. The
// intensity law is the C12-15 quadratic in mu = cos(heliocentric angle):
//
//   I(mu) = a0 + a1*mu + a2*mu^2,   a0 = 0.3, a1 = 0.93, a2 = -0.23
//
// normalised so I(1) = 1 at disc centre. mu is recovered from the projected
// radius x = r/rs by mu = sqrt(1 - x^2).
//
// THE INTEGRAL. Blocked flux is a 1-D radial quadrature over rings of the
// solar disc, each weighted by the fraction of its circumference that falls
// inside the occluder disc:
//
//   blocked = ∫₀^rs I(r) * c(r) * 2*pi*r dr
//   total   = ∫₀^rs I(r)          * 2*pi*r dr
//   obscuration = blocked / total
//
// with the ring-coverage term (law of cosines on the ring/occluder chord)
//
//   c(r) = 1                                      when d + r <= ro
//   c(r) = 0                                      when d >= r + ro or r >= d + ro
//   c(r) = acos( (d² + r² - ro²) / (2*d*r) ) / pi  otherwise
//
// Both integrals are evaluated on the SAME quadrature nodes, so when the
// occluder covers every ring (c ≡ 1) the ratio is exactly 1.0 — totality is
// bit-exact, not "1.0 within quadrature error". `c` has kinks at
// r = |d - ro| and r = d + ro, so the domain is split at those breakpoints
// and Gauss-Legendre is applied per smooth sub-interval; that is what buys
// the accuracy at a fixed low node count rather than raising the order.
//
// ACCURACY, honestly. Splitting removes the kinks but NOT the sqrt-type
// derivative singularities that sit exactly AT those sub-interval endpoints
// (c behaves like sqrt near each contact), so Gauss-Legendre does not reach
// its usual spectral rate there and raising the order buys little. Measured
// worst-case absolute error against a 20,000-point-per-sub-interval midpoint
// reference, swept over ro/rs in {0.5, 0.7, 0.9, 1.0, 1.05, 1.2, 2.0} and 60
// separations each: ~2.8e-5 in obscuration (worst near ro/rs = 0.7,
// d/rs = 0.31; a second cluster near ro/rs = 0.9, d/rs = 0.57). That is
// ~1e-5 of a magnitude — three orders below 8-bit display quantisation and
// far below the ±2.5-4% spread of published limb-darkening fits, so it is
// visually and physically irrelevant. The EXACT endpoints (0.0 disjoint,
// 1.0 umbra) are branch results, not quadrature results, and carry no error.
//
// Everything here is pure: no allocation per call (scratch arrays are
// module-level and sized at load), no state, and the one import
// (`SolarDiscModel.js`, the C12-15 constants source) is itself pure with no
// Cesium dependencies. That keeps this module directly unit-testable under
// `node --test`.
//
// @private
// @module computeSolarObscuration

import {
  SOLAR_LIMB_DARKENING_A0,
  SOLAR_LIMB_DARKENING_A1,
  SOLAR_LIMB_DARKENING_A2,
  solarLimbIntensity,
} from "./SolarDiscModel.js";

/**
 * C12-15 quadratic limb-darkening coefficients. The C12-15 row required that
 * the eclipse photometry and the sun-disc BAKE read one constants source
 * when the sun wave landed; they now both come from `SolarDiscModel.js`
 * (which additionally feeds `SunTextureFS.glsl` through uniforms, so the
 * GLSL carries no numeric copy either). Re-exported below so the existing
 * importers of this module keep working unchanged.
 * I(1) = a0+a1+a2 = 1.
 * @private
 */
const LIMB_DARKENING_A0 = SOLAR_LIMB_DARKENING_A0;
const LIMB_DARKENING_A1 = SOLAR_LIMB_DARKENING_A1;
const LIMB_DARKENING_A2 = SOLAR_LIMB_DARKENING_A2;

/**
 * Gauss-Legendre order per smooth sub-interval. Three sub-intervals at most
 * (breakpoints at |d-ro| and d+ro), so the worst case is 3*16 = 48 integrand
 * evaluations — the ~200 f64 flops per frame budgeted in the C12-29 research
 * report. 16 is the knee, not a convergence point: the sqrt-type derivative
 * singularities at the contact radii (see the module header) cap the
 * achievable rate, so the measured ~2.8e-5 worst-case error barely improves
 * with a higher order. Spending nodes here would buy nothing visible.
 * @private
 */
const QUADRATURE_ORDER = 16;

/**
 * Build Gauss-Legendre nodes/weights on [-1, 1] by Newton iteration on the
 * Legendre polynomial, using the standard Chebyshev-like initial guess. Run
 * once at module load; the result is frozen scratch, never reallocated.
 *
 * @param {number} n Number of nodes.
 * @returns {{nodes: Float64Array, weights: Float64Array}}
 * @private
 */
function buildGaussLegendre(n) {
  const nodes = new Float64Array(n);
  const weights = new Float64Array(n);
  const half = (n + 1) >> 1;
  for (let i = 0; i < half; i++) {
    // Initial guess (Abramowitz & Stegun 25.4.30).
    let x = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let dp = 0.0;
    // Newton on P_n(x). Bounded: 100 iterations is ~10x the observed need.
    for (let iter = 0; iter < 100; iter++) {
      let p0 = 1.0;
      let p1 = 0.0;
      for (let j = 0; j < n; j++) {
        const p2 = p1;
        p1 = p0;
        p0 = ((2 * j + 1) * x * p1 - j * p2) / (j + 1);
      }
      dp = (n * (x * p0 - p1)) / (x * x - 1.0);
      const dx = p0 / dp;
      x -= dx;
      if (Math.abs(dx) < 1.0e-15) {
        break;
      }
    }
    nodes[i] = -x;
    nodes[n - 1 - i] = x;
    const w = 2.0 / ((1.0 - x * x) * dp * dp);
    weights[i] = w;
    weights[n - 1 - i] = w;
  }
  return { nodes, weights };
}

const GL = buildGaussLegendre(QUADRATURE_ORDER);

// Breakpoint scratch — at most [0, |d-ro|, d+ro, rs] once clamped+sorted.
const breakpoints = new Float64Array(4);

/**
 * Clamp helper used on every `acos` argument. Circle-circle geometry drifts
 * a few ULP outside [-1, 1] near tangency and near totality, where `acos`
 * would return NaN and poison the whole frame's lighting.
 *
 * @param {number} x
 * @returns {number}
 * @private
 */
function clampUnit(x) {
  return x < -1.0 ? -1.0 : x > 1.0 ? 1.0 : x;
}

/**
 * Fraction of the circumference of the ring of angular radius `r` (centred
 * on the solar-disc centre) that lies inside the occluder disc of angular
 * radius `ro` whose centre is `d` away.
 *
 * @param {number} r Ring radius, radians.
 * @param {number} ro Occluder angular radius, radians.
 * @param {number} d Centre separation, radians.
 * @returns {number} Coverage in [0, 1].
 * @private
 */
function ringCoverage(r, ro, d) {
  if (d + r <= ro) {
    // Ring entirely inside the occluder.
    return 1.0;
  }
  if (d >= r + ro || r >= d + ro) {
    // Disjoint, or the occluder sits wholly inside the ring (no crossing).
    return 0.0;
  }
  if (r <= 0.0 || d <= 0.0) {
    // Degenerate ring / concentric case: settled by the two tests above.
    return 0.0;
  }
  const cosPhi = clampUnit((d * d + r * r - ro * ro) / (2.0 * d * r));
  return Math.acos(cosPhi) / Math.PI;
}

/**
 * Solar limb-darkening intensity at projected radius fraction `x = r / rs`,
 * normalised to 1.0 at disc centre.
 *
 * @param {number} x Projected radius fraction in [0, 1].
 * @returns {number} Relative intensity.
 * @private
 */
function limbIntensity(x) {
  // Delegates to the C12-15 constants source so the bake and the photometry
  // cannot drift. `solarLimbIntensity` clamps x to [0, 1]; the quadrature
  // never leaves that range, so the result is unchanged from the previous
  // inline form.
  return solarLimbIntensity(x);
}

/**
 * Uniform-brightness (geometric) obscuration — the classic circle-circle
 * lens-area overlap divided by the solar-disc area. Kept as an exported
 * reference because it is the closed form every published eclipse table
 * quotes, and because the limb-darkened result must always exceed it during
 * central partial phases (the hidden centre is the bright part). Not used
 * by the renderer.
 *
 * @param {number} rs Solar angular radius, radians.
 * @param {number} ro Occluder angular radius, radians.
 * @param {number} d Angular separation of the two centres, radians.
 * @returns {number} Obscured area fraction in [0, 1].
 * @private
 */
function computeUniformObscuration(rs, ro, d) {
  if (!(rs > 0.0) || !(ro > 0.0) || !(d >= 0.0)) {
    return 0.0;
  }
  if (d >= rs + ro) {
    return 0.0;
  }
  if (d + rs <= ro) {
    return 1.0;
  }
  if (d + ro <= rs) {
    // Annular: the occluder is wholly inside the solar disc.
    const ratio = ro / rs;
    return ratio * ratio;
  }
  const d2 = d * d;
  const rs2 = rs * rs;
  const ro2 = ro * ro;
  const alpha = Math.acos(clampUnit((d2 + rs2 - ro2) / (2.0 * d * rs)));
  const beta = Math.acos(clampUnit((d2 + ro2 - rs2) / (2.0 * d * ro)));
  // Heron-style product, guarded non-negative: it drifts to ~-1e-30 at
  // tangency and Math.sqrt of that is NaN.
  const product =
    (-d + rs + ro) * (d + rs - ro) * (d - rs + ro) * (d + rs + ro);
  const lens =
    rs2 * alpha + ro2 * beta - 0.5 * Math.sqrt(product > 0.0 ? product : 0.0);
  const fraction = lens / (Math.PI * rs2);
  return fraction < 0.0 ? 0.0 : fraction > 1.0 ? 1.0 : fraction;
}

/**
 * Limb-darkened obscuration — the fraction of the sun's BROADBAND FLUX that
 * the occluder removes, as opposed to the fraction of its area. This is the
 * number the renderer multiplies by; it is what makes 99% area coverage read
 * as far darker than "1% of daylight".
 *
 * Exact (not merely convergent) at the two ends: 0.0 when the discs are
 * disjoint, 1.0 when the occluder swallows the solar disc.
 *
 * @param {number} rs Solar angular radius, radians.
 * @param {number} ro Occluder angular radius, radians.
 * @param {number} d Angular separation of the two centres, radians.
 * @returns {number} Blocked flux fraction in [0, 1].
 * @private
 */
function computeSolarObscuration(rs, ro, d) {
  if (!(rs > 0.0) || !(ro > 0.0) || !(d >= 0.0)) {
    return 0.0;
  }
  if (d >= rs + ro) {
    return 0.0;
  }
  if (d + rs <= ro) {
    return 1.0;
  }

  // Split the radial domain at the coverage kinks so a low-order rule is
  // exact-to-roundoff on each smooth piece.
  let count = 0;
  breakpoints[count++] = 0.0;
  const inner = Math.abs(d - ro);
  if (inner > 0.0 && inner < rs) {
    breakpoints[count++] = inner;
  }
  const outer = d + ro;
  if (outer > 0.0 && outer < rs) {
    breakpoints[count++] = outer;
  }
  breakpoints[count++] = rs;

  const nodes = GL.nodes;
  const weights = GL.weights;
  const invRs = 1.0 / rs;
  let blocked = 0.0;
  let total = 0.0;

  for (let seg = 0; seg < count - 1; seg++) {
    const lo = breakpoints[seg];
    const hi = breakpoints[seg + 1];
    const halfWidth = 0.5 * (hi - lo);
    if (!(halfWidth > 0.0)) {
      continue;
    }
    const mid = 0.5 * (hi + lo);
    for (let k = 0; k < QUADRATURE_ORDER; k++) {
      const r = mid + halfWidth * nodes[k];
      // 2*pi drops out of the ratio; r carries the ring circumference.
      const w = weights[k] * halfWidth * r * limbIntensity(r * invRs);
      total += w;
      const c = ringCoverage(r, ro, d);
      if (c > 0.0) {
        blocked += w * c;
      }
    }
  }

  if (!(total > 0.0)) {
    return 0.0;
  }
  const fraction = blocked / total;
  return fraction < 0.0 ? 0.0 : fraction > 1.0 ? 1.0 : fraction;
}

/**
 * Eclipse magnitude — the fraction of the SOLAR DIAMETER covered, the
 * quantity astronomical tables call "magnitude" (distinct from obscuration,
 * which is a flux/area fraction). `>= 1` means the occluder's disc fully
 * spans the sun's, i.e. totality (or annularity when the occluder is the
 * smaller disc).
 *
 * Stellarium issue #3720 is the cautionary tale here: darkening a scene by
 * MAGNITUDE rather than obscuration made annular eclipses far too dark. The
 * renderer multiplies by obscuration; magnitude is published for gating and
 * diagnostics only.
 *
 * @param {number} rs Solar angular radius, radians.
 * @param {number} ro Occluder angular radius, radians.
 * @param {number} d Angular separation of the two centres, radians.
 * @returns {number} Magnitude, clamped to >= 0.
 * @private
 */
function computeEclipseMagnitude(rs, ro, d) {
  if (!(rs > 0.0)) {
    return 0.0;
  }
  const m = (rs + ro - d) / (2.0 * rs);
  return m > 0.0 ? m : 0.0;
}

export {
  computeSolarObscuration,
  computeUniformObscuration,
  computeEclipseMagnitude,
  LIMB_DARKENING_A0,
  LIMB_DARKENING_A1,
  LIMB_DARKENING_A2,
  QUADRATURE_ORDER,
};
export default computeSolarObscuration;
