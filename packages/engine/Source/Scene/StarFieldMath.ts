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

  // Per-star brightness from visual magnitude — C12-08 dynamic-range
  // restoration. The magnitude→intensity mapping is STRICTLY LINEAR in
  // flux (Pogson 1856: relative flux = 10^(−0.4·mag)); the historical
  // FLUX_GAMMA=0.5 / LO / HI band is GONE. That band pre-crushed the true
  // 38.4:1 flux range of the then-rendered set (mag −1.46…2.5) to 2.70:1
  // before any exposure control could act — Sirius and a 2nd-magnitude
  // star arrived nearly identical, then both clipped into the same white
  // plateau (CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md §2d).
  //
  // All compression now lives in ONE explicit exposure constant, anchored
  // at the faint end:
  //
  //   intensity I(m) = EXPOSURE · 10^(−0.4·m)
  //   EXPOSURE = FAINT_ANCHOR_PEAK / (1 + K_HALO) · 10^(0.4·FAINT_ANCHOR_MAG)
  //            ≈ 0.060 / 1.08 · 27.54 ≈ 1.53
  //
  // so a FAINT_ANCHOR_MAG (3.6) star renders a peak-pixel of
  // FAINT_ANCHOR_PEAK = 0.060 ≈ 15.3/255 — above the M1 detection floor
  // (P−B ≥ 12/255) with margin for sub-pixel sampling phase (the peak
  // sample sits up to 0.5 px off the profile centre; at σ_px ≈ 0.6 the
  // phase-median attenuation is ≈0.80, keeping the anchor star ≥ 12/255),
  // and below 1/15 so the rendered brightest(clipped 1.0):faintest peak
  // ratio is ≥ 15:1 (G2 criterion 5; ≈16.7:1 at the anchor). At the math
  // layer the range is fully linear: I(−1.46)/I(5.0) = 10^(0.4·6.46) ≈ 380:1.
  //
  // Retired / re-derived constants (C12-08 ledger):
  //   FLUX_GAMMA — RETIRED. Gamma-compression destroyed flux ordering
  //     information permanently; linearity is the whole point.
  //   LO — RETIRED. The faint floor is now the FAINT_ANCHOR_PEAK exposure
  //     anchor above, expressed in framebuffer units, not a remap band.
  //   HI — RETIRED. The bright peak now emerges from physics (I_max ≈ 5.87
  //     for Sirius); the C12-07 shader amplitude split confines the
  //     resulting clip to a ≤~1.3 px core instead of a 4 px plateau.
  //     Raising brightness caps under an LDR clamp only widens the white
  //     disc — do not reintroduce HI.
  //   MAG_CUTOFF — SURVIVES, re-derived: now the vendored-catalogue
  //     inclusion bound (5.0 = the faintest vendored star), not a bright-
  //     stars-only gate. The whole catalogue renders; stars between the
  //     3.6 anchor and 5.0 fall below the guaranteed M1 census floor but
  //     remain visible (a mag-5.0 star peaks ≈ 4/255). When C12-09 deepens
  //     the catalogue, re-derive MAG_CUTOFF and FAINT_ANCHOR_* together —
  //     Tools/visual-regression/starfield-psf.spec.mjs asserts the anchor
  //     invariants against the live catalogue data.
  //
  // The cubemap double-draw seam (t3 bake vs sprite overlap band) is owned
  // and reconciled by C12-11; the sprite side deliberately renders the full
  // catalogue per the C12-08 mandate.
  const MAG_CUTOFF = 5.0;
  const FAINT_ANCHOR_MAG = 3.6;
  const FAINT_ANCHOR_PEAK = 0.06; // ≈15.3/255: ≥ M1 floor 12/255, ≤ 1/15
  // Fragment-profile peak is (1 + K_HALO)·I — K_HALO here MUST equal the
  // shader constant STAR_PSF_K_HALO (StarField.wgsl / StarFieldFS.glsl);
  // starfield-psf.spec.mjs asserts the three stay identical.
  const K_HALO = 0.08;
  const EXPOSURE =
    (FAINT_ANCHOR_PEAK / (1.0 + K_HALO)) *
    Math.pow(10.0, 0.4 * FAINT_ANCHOR_MAG);
  // C12-06 — bright-star quad growth is HALO EXTENT, not core size. The
  // quad scale rides into the shader as (1 + sizeBoost); the fragment
  // profile multiplies the core's radius back by the same factor so the
  // core's on-screen size is invariant while the Moffat wing (whose α is
  // quad-relative) widens with the quad. Growth law: quadScale = √I for
  // clipping stars (I > 1) — glare area ∝ flux — clamped so the total
  // glare (quad) angular diameter never exceeds 1°: Celestia adopted the
  // same 1° bound after larger Gaussian glows produced visible squares
  // (CelestiaProject/Celestia#1948). Sirius: √5.87 ≈ 2.42 < 2.91 cap.
  const GLARE_MAX_DIAMETER_RAD = 0.017453292519943295; // 1 degree
  // 2 × StarField.js `_pointAngularSize` (0.0030 rad base half-angle) —
  // keep the two in sync; starfield-psf.spec.mjs cross-checks them.
  const BASE_QUAD_DIAMETER_RAD = 0.006;
  const MAX_QUAD_SCALE = GLARE_MAX_DIAMETER_RAD / BASE_QUAD_DIAMETER_RAD;

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

    // Linear Pogson flux scaled by the explicit exposure. Apparent
    // magnitude already encodes luminosity / distance² (inverse-square),
    // so this IS the distance-scaled brightness — no clamp, no gamma.
    // Stars fainter than the vendored-catalogue bound emit zero (none
    // exist today; the guard is the C12-09 deepening valve).
    const flux =
      vmag > MAG_CUTOFF ? 0.0 : EXPOSURE * Math.pow(10.0, -0.4 * vmag);

    const rgb = bvToRgb(bv);

    // C12-06 halo extent (see the derivation above): stars are unresolved
    // point sources, so the CORE never grows — the shader holds its pixel
    // size constant against this scale. The quad growth only creates room
    // for the Moffat glare wing of stars bright enough to clip (I > 1).
    const quadScale =
      flux > 1.0 ? Math.min(Math.sqrt(flux), MAX_QUAD_SCALE) : 1.0;
    const sizeBoost = quadScale - 1.0;

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
