/**
 * Backend-neutral bright-star catalog math (Track V-C,
 * NEW-STARS-BRIGHT-CATALOG / NEW-STARS-BRIGHT-CATALOG-WEBGL-FALLBACK).
 *
 * This module owns the *physics* of the starfield — the parts that are
 * identical whether the stars are drawn through WGSL (WebGPU) or GLSL
 * (WebGL):
 *
 *   - {@link bvToRgb}: B−V color index → blackbody color temperature
 *     (Ballesteros 2012) → Planckian-locus RGB.
 *   - {@link buildStarInstanceData}: the per-instance vertex record built
 *     ONCE from {@link BrightStarCatalog} — RA/Dec → TEME unit direction,
 *     visual magnitude → Pogson-scaled HDR brightness, B−V → RGB, plus a
 *     brightness-driven size boost.
 *   - {@link computeStarDayFade}: the camera-altitude-gated daytime fade.
 *
 * Both the WebGPU renderer ({@link WebGPUStarFieldRenderer}) and the WebGL
 * renderer ({@link WebGLStarFieldRenderer}) import these so the two
 * backends place / color / brighten the same stars identically — only the
 * draw path (WGSL vs GLSL point sprites) differs. Keeping the math here
 * (not duplicated in each renderer) is the contract that guarantees
 * WebGL↔WebGPU starfield parity.
 *
 * @private
 * @module StarFieldMath
 */
import Cartesian3 from "../Core/Cartesian3.js";
import CesiumMath from "../Core/Math.js";
import defined from "../Core/defined.js";
import BrightStarCatalog from "./BrightStarCatalog.js";

// Per-instance vertex layout (floats):
//   directionFixed (3) + intensity (1) + color (3) + sizeBoost (1) = 8
/** Number of floats per packed per-instance star record. @private */
export const FLOATS_PER_STAR = 8;

const scratchCamUp = new Cartesian3();

/**
 * Convert a B−V color index to an approximate RGB color via a blackbody
 * temperature fit. Hot blue stars (B−V < 0) skew toward 0.6–0.8 in red
 * and ~1.0 in blue; cool red stars (B−V > 1.4) skew toward ~1.0 red and
 * low blue. Returns a normalized-ish RGB (brightest channel ≈ 1.0) so the
 * per-star Pogson intensity controls absolute brightness, not the hue.
 *
 * Ballesteros (2012): T ≈ 4600 K · (1/(0.92·BV + 1.7) + 1/(0.92·BV + 0.62)).
 * The Planckian-locus RGB below is a compact piecewise fit good enough
 * for a visual starfield (not colorimetric accuracy).
 *
 * @param {number} bv B−V color index.
 * @returns {number[]} [r, g, b] in [0, 1].
 * @private
 */
export function bvToRgb(bv: number): [number, number, number] {
  const denomA = 0.92 * bv + 1.7;
  const denomB = 0.92 * bv + 0.62;
  // Guard against the (rare for real stars) pole near bv ≈ -1.8 / -0.67.
  const t =
    4600.0 *
    (1.0 / (Math.abs(denomA) < 1e-3 ? 1e-3 : denomA) +
      1.0 / (Math.abs(denomB) < 1e-3 ? 1e-3 : denomB));
  // Clamp to a sane stellar temperature window.
  const temp = Math.min(40000.0, Math.max(1500.0, t)) / 100.0;

  let r;
  let g;
  let b;
  // Tanner Helland's blackbody fit (public-domain algorithm), normalized.
  if (temp <= 66.0) {
    r = 255.0;
    g = 99.4708025861 * Math.log(temp) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(temp - 60.0, -0.1332047592);
    g = 288.1221695283 * Math.pow(temp - 60.0, -0.0755148492);
  }
  if (temp >= 66.0) {
    b = 255.0;
  } else if (temp <= 19.0) {
    b = 0.0;
  } else {
    b = 138.5177312231 * Math.log(temp - 10.0) - 305.0447927307;
  }
  r = Math.min(255.0, Math.max(0.0, r)) / 255.0;
  g = Math.min(255.0, Math.max(0.0, g)) / 255.0;
  b = Math.min(255.0, Math.max(0.0, b)) / 255.0;
  // Renormalize so the brightest channel is 1.0 — keeps absolute
  // brightness in the Pogson intensity, not the color.
  const peak = Math.max(r, g, b, 1e-3);
  return [r / peak, g / peak, b / peak];
}

/**
 * Build the static per-instance star buffer from the catalog. Each star's
 * J2000 RA/Dec becomes a TEME-frame unit direction; magnitude becomes a
 * Pogson intensity; B−V becomes a blackbody RGB. The TEME→fixed rotation
 * is applied per frame by the renderer (NOT baked here), so the same
 * buffer is correct for every scene time and BOTH backends.
 *
 * Layout per star (8 floats): directionFixed.xyz, intensity, color.rgb,
 * sizeBoost.
 *
 * @private
 */
export function buildStarInstanceData(): Float32Array {
  const cat = BrightStarCatalog.data;
  const stride = BrightStarCatalog.STRIDE;
  const count = BrightStarCatalog.count;
  const out = new Float32Array(count * FLOATS_PER_STAR);

  // Per-star brightness from visual magnitude (Pogson scale). The raw
  // flux ratio across the catalog (mag −1.46 … +4.4) spans ~240×, far too
  // wide to map linearly onto a display — the faintest stars would vanish
  // below 1/255 while Sirius alone fills the frame. We therefore:
  //   1) compute the true Pogson flux relative to the faint limit, then
  //   2) gamma-compress it (exponent < 1) so the faint end lifts into
  //      visibility, then
  //   3) remap into a [LO, HI] band where LO keeps the faintest star a
  //      dim-but-real point and HI lets the brightest stars overflow 1.0
  //      (HDR) so the additive scene-FB target feeds them into bloom.
  // This preserves the PERCEPTUAL ordering (brighter magnitude ⇒ brighter
  // pixel ⇒ larger bloomed disc) while keeping the whole catalog visible.
  const faintLimitMag = 4.6;
  const brightestFlux = Math.pow(10.0, -0.4 * (-1.46 - faintLimitMag));
  const FLUX_GAMMA = 0.38; // < 1 lifts the faint tail
  const LO = 0.55; // faintest star brightness (clearly visible point)
  const HI = 6.0; // brightest star brightness (overflows → bloom)

  for (let i = 0; i < count; i++) {
    const base = i * stride;
    const raDeg = cat[base + 0];
    const decDeg = cat[base + 1];
    const vmag = cat[base + 2];
    const bv = cat[base + 3];

    const ra = CesiumMath.toRadians(raDeg);
    const dec = CesiumMath.toRadians(decDeg);
    // RA/Dec → equatorial-inertial unit vector (TEME axes: x toward
    // vernal equinox, z toward north celestial pole).
    const cosDec = Math.cos(dec);
    const dx = cosDec * Math.cos(ra);
    const dy = cosDec * Math.sin(ra);
    const dz = Math.sin(dec);

    // Pogson flux relative to the faint limit, in [~0, 1].
    const rawFlux = Math.pow(10.0, -0.4 * (vmag - faintLimitMag));
    const norm = Math.min(1.0, rawFlux / brightestFlux);
    const compressed = Math.pow(norm, FLUX_GAMMA);
    const flux = LO + compressed * (HI - LO);

    const rgb = bvToRgb(bv);

    // sizeBoost: brighter stars (lower magnitude) get a larger disc.
    // Map mag −1.5 → ~1.7 boost, mag 4 → ~0 boost.
    const sizeBoost = Math.max(0.0, (4.0 - vmag) * 0.42);

    const o = i * FLOATS_PER_STAR;
    out[o + 0] = dx;
    out[o + 1] = dy;
    out[o + 2] = dz;
    out[o + 3] = flux;
    out[o + 4] = rgb[0];
    out[o + 5] = rgb[1];
    out[o + 6] = rgb[2];
    out[o + 7] = sizeBoost;
  }
  return out;
}

/**
 * Compute the daytime-fade multiplier for the stars: dim them as the sun
 * climbs above the horizon for a surface-level camera, but keep them at
 * full brightness above ~100 km where the atmosphere no longer scatters
 * enough sunlight to wash them out. Returns 1.0 (no fade) when the sun
 * direction or camera position is unavailable.
 *
 * Identical math for both backends so the WebGL fade matches WebGPU.
 *
 * @param {Cartesian3|undefined} sunDirectionWC Unit sun direction (WC).
 * @param {Cartesian3|undefined} cameraPositionWC Camera ECEF position.
 * @returns {number} Fade multiplier in [0, 1].
 * @private
 */
export function computeStarDayFade(
  sunDirectionWC: Cartesian3 | undefined,
  cameraPositionWC: Cartesian3 | undefined,
): number {
  let dayFade = 1.0;
  if (!defined(sunDirectionWC) || !defined(cameraPositionWC)) {
    return dayFade;
  }
  const camLen = Cartesian3.magnitude(cameraPositionWC);
  if (camLen > 1.0) {
    Cartesian3.normalize(cameraPositionWC, scratchCamUp);
    const solarAltSin = Cartesian3.dot(sunDirectionWC, scratchCamUp);
    // Full brightness when sun is > ~6° below horizon (astronomical
    // twilight-ish), fully faded when sun is > ~3° above horizon.
    // smoothstep over sin(altitude): [-0.10, +0.05].
    const t = CesiumMath.clamp((solarAltSin - -0.1) / (0.05 - -0.1), 0.0, 1.0);
    dayFade = 1.0 - t;
    // Above ~100 km the atmosphere no longer scatters enough sunlight to
    // wash out stars — keep them visible regardless of solar altitude.
    // camLen is distance from Earth's center; subtract a mean Earth
    // radius for a crude altitude (good enough to gate the fade).
    const altitude = camLen - 6371000.0;
    if (altitude > 100000.0) {
      dayFade = 1.0;
    }
  }
  return dayFade;
}

export default {
  FLOATS_PER_STAR,
  bvToRgb,
  buildStarInstanceData,
  computeStarDayFade,
};
