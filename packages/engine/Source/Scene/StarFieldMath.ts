/**
 * Backend-neutral bright-star catalog math.
 *
 * This module owns the *physics* of the starfield — the parts that are
 * identical whether the stars are drawn through WGSL (WebGPU) or GLSL
 * (WebGL):
 *
 *   - {@link bvToRgb}: B−V color index → blackbody color temperature
 *     (Ballesteros 2012) → Planckian-locus RGB.
 *   - {@link buildStarInstanceData}: the per-instance vertex record built
 *     once from {@link BrightStarCatalog} — RA/Dec → TEME unit direction,
 *     visual magnitude → Pogson-scaled HDR brightness, B−V → RGB, plus a
 *     brightness-driven size boost.
 *   - {@link computeStarDayFade}: the camera-altitude-gated daytime fade.
 *
 * References:
 *   - Norman Pogson, "Magnitudes of Thirty-six of the Minor Planets", Monthly
 *     Notices of the Royal Astronomical Society 17, 12 (1856) — the
 *     five-magnitudes-per-factor-of-100 scale the brightness mapping inverts.
 *   - Fernando Ballesteros, "New insights into black bodies", Europhysics
 *     Letters 97, 34008 (2012) — the B-V to effective-temperature relation.
 *   - Max Planck's blackbody spectrum, integrated against the CIE 1931
 *     colour-matching functions, gives the Planckian locus that temperature is
 *     then mapped through.
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
import {
  computeAtmosphericColumnFactor,
  computeCelestialElevationSine,
} from "./SkyBrightness.js";

// Per-instance vertex layout (floats):
//   directionFixed (3) + intensity (1) + color (3) + sizeBoost (1) = 8
/** Number of floats per packed per-instance star record. @private */
export const FLOATS_PER_STAR = 8;

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
 * is applied per frame by the renderer rather than baked here, so the same
 * buffer is correct for every scene time and for both backends.
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

  // Per-star brightness from visual magnitude. The magnitude-to-intensity
  // mapping is strictly linear in flux (Pogson 1856: relative flux =
  // 10^(−0.4·mag)) — no gamma, no low/high remap band. A compressing band
  // ahead of the exposure control destroys flux ordering permanently: a 0.5
  // gamma over a low/high window crushes the 38.4:1 flux range of the naked-
  // eye set (mag −1.46…2.5) to 2.70:1, at which point Sirius and a
  // second-magnitude star arrive nearly identical and both clip into the same
  // white plateau.
  //
  // All compression lives in one explicit exposure constant, anchored at the
  // faint end:
  //
  //   intensity I(m) = EXPOSURE · 10^(−0.4·m)
  //   EXPOSURE = FAINT_ANCHOR_PEAK / (1 + K_HALO) · 10^(0.4·FAINT_ANCHOR_MAG)
  //            ≈ 0.060 / 1.08 · 27.54 ≈ 1.53
  //
  // so a FAINT_ANCHOR_MAG (3.6) star renders a peak pixel of
  // FAINT_ANCHOR_PEAK = 0.060 ≈ 15.3/255 — above the census detection floor
  // (peak minus background ≥ 12/255) with margin for sub-pixel sampling phase
  // (the peak sample sits up to 0.5 px off the profile centre; at σ_px ≈ 0.6
  // the phase-median attenuation is ≈ 0.80, keeping the anchor star ≥ 12/255),
  // and below 1/15 so the rendered brightest (clipped at 1.0) to faintest peak
  // ratio is ≥ 15:1, ≈ 16.7:1 at the anchor. At the math layer the range is
  // fully linear: I(−1.46)/I(5.0) = 10^(0.4·6.46) ≈ 380:1. The bright peak
  // emerges from that physics (I_max ≈ 5.87 for Sirius) and the shader's
  // amplitude split confines the resulting clip to a ≤ ~1.3 px core; a cap on
  // brightness would not narrow it, because under an LDR clamp raising
  // intensities only widens the white disc.
  //
  // MAG_CUTOFF is definitionally the faintest vendored star, not a tuning
  // choice. Left behind a deepened table it emits exactly zero flux for every
  // row past the old bound, so the deepening would be inert.
  // `Tools/visual-regression/star-catalog-depth.spec.mjs` re-derives it from
  // the shipped table and fails if the two drift. Stars between the 3.6 anchor
  // and the bound fall below the guaranteed census floor but stay visible.
  //
  // FAINT_ANCHOR_MAG / FAINT_ANCHOR_PEAK are pinned to that census detection
  // floor rather than to where the catalogue happens to end, and do not move
  // with it. Re-anchoring at the 5.5 bound would multiply EXPOSURE by
  // 10^(0.4·1.9) = 5.75, taking Sirius from I = 5.87 to 33.8; its quad growth
  // sqrt(I) = 5.81 would then be clipped hard by the 1-degree MAX_QUAD_SCALE
  // (2.909), and the "glare area proportional to flux" law derived below would
  // stop holding for every star brighter than ~1.5 mag. The faint end stays
  // visible without it: a mag-5.5 star peaks at 0.060 · 10^(−0.4·1.9) = 0.0104
  // ≈ 2.7/255, and the exposure only falls below 1/255 past vmag 6.56, so the
  // sprite path has ~1 magnitude of headroom beyond the current bound before
  // rows would render into nothing. Re-derive both if a deepening passes 6.5.
  //
  // The blurred cubemap bake carries diffuse light only, so the sprite side is
  // the sole source of resolved stars and deliberately renders the whole
  // catalogue.
  const MAG_CUTOFF = 5.5;
  const FAINT_ANCHOR_MAG = 3.6;
  const FAINT_ANCHOR_PEAK = 0.06; // ≈15.3/255: ≥ the 12/255 floor, ≤ 1/15
  // Fragment-profile peak is (1 + K_HALO)·I — K_HALO here must equal the
  // shader constant STAR_PSF_K_HALO (StarField.wgsl / StarFieldFS.glsl);
  // starfield-psf.spec.mjs asserts the three stay identical.
  const K_HALO = 0.08;
  const EXPOSURE =
    (FAINT_ANCHOR_PEAK / (1.0 + K_HALO)) *
    Math.pow(10.0, 0.4 * FAINT_ANCHOR_MAG);
  // Bright-star quad growth is halo extent, not core size. The quad scale
  // rides into the shader as (1 + sizeBoost); the fragment profile multiplies
  // the core's radius back by the same factor so the core's on-screen size is
  // invariant while the Moffat wing (whose α is quad-relative) widens with the
  // quad. Growth law: quadScale = √I for clipping stars (I > 1), so glare area
  // is proportional to flux, clamped so the total glare (quad) angular
  // diameter never exceeds 1°. Celestia adopted the same 1° bound after larger
  // Gaussian glows produced visible squares (CelestiaProject/Celestia#1948).
  // Sirius: √5.87 ≈ 2.42, under the 2.91 cap.
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
    // magnitude already encodes luminosity / distance² (inverse-square), so
    // this is the distance-scaled brightness — no clamp, no gamma. Stars
    // fainter than the vendored-catalogue bound emit zero; the bake refuses
    // to emit such rows, so this guard is the second half of that valve.
    const flux =
      vmag > MAG_CUTOFF ? 0.0 : EXPOSURE * Math.pow(10.0, -0.4 * vmag);

    const rgb = bvToRgb(bv);

    // Halo extent (see the derivation above): stars are unresolved point
    // sources, so the core never grows — the shader holds its pixel size
    // constant against this scale. The quad growth only creates room for the
    // Moffat glare wing of stars bright enough to clip (I > 1).
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
 * climbs above the horizon for a surface-level camera, then continuously
 * restore them as the atmospheric column falls away. Returns 1.0 (no fade)
 * when the sun direction or camera position is unavailable.
 *
 * Identical math for both backends so the WebGL fade matches WebGPU.
 *
 * @param {Cartesian3|undefined} sunDirectionWC Unit sun direction (WC).
 * @param {Cartesian3|undefined} cameraPositionWC Camera ECEF position.
 * @param {number|undefined} cameraHeight Ellipsoidal camera height in metres.
 * @returns {number} Fade multiplier in [0, 1].
 * @private
 */
export function computeStarDayFade(
  sunDirectionWC: Cartesian3 | undefined,
  cameraPositionWC: Cartesian3 | undefined,
  cameraHeight?: number,
): number {
  let dayFade = 1.0;
  if (!defined(sunDirectionWC) || !defined(cameraPositionWC)) {
    return dayFade;
  }
  const camLen = Cartesian3.magnitude(cameraPositionWC);
  if (camLen > 1.0) {
    // The single home of the solar-elevation derivation, shared with the
    // SkyBrightness estimator.
    const solarAltSin = computeCelestialElevationSine(
      sunDirectionWC,
      cameraPositionWC,
    );
    if (solarAltSin === undefined) {
      return dayFade;
    }
    // Full brightness when sun is > ~6° below horizon (astronomical
    // twilight-ish), fully faded when sun is > ~3° above horizon.
    // smoothstep over sin(altitude): [-0.10, +0.05].
    const t = CesiumMath.clamp((solarAltSin - -0.1) / (0.05 - -0.1), 0.0, 1.0);
    dayFade = 1.0 - t;
    // One atmospheric-column law for both star paths. At low altitude the
    // result is the purely geometric fade. Between 60 and 111 km the
    // washout disappears smoothly; above the shell it is exactly 1. Scene
    // supplies ellipsoidal height, so this works at every WGS84 latitude and
    // on custom globe ellipsoids without an Earth-radius assumption.
    const column = computeAtmosphericColumnFactor(cameraHeight);
    dayFade = 1.0 - column * (1.0 - dayFade);
  }
  return dayFade;
}

// Star-brightness modulation: a single multiplier applied to the star cubemap
// (`SkyBoxFS.glsl` on WebGL, `CubeMapPanorama.wgsl` on WebGPU) driven by
// `frameState.skyBrightness`. It is on by default at a countryside-like level,
// and the reveal of stars at eclipse totality runs through it rather than
// through a separate eclipse-only path. `computeStarBrightnessModulation`
// below is the CPU twin of the shader expression; both shaders and
// `StarField`'s sprite floor evaluate the same three lines.
//
//   t      = clamp((skyBrightness - inflection) * steepness, 0, 1)
//   factor = 1 - smoothstep(0, 1, t)
//
// The two defaults are derived, not dialled:
//
//  1. The night end is the countryside claim. At `skyBrightness = 0` —
//     astronomical night, no moon — the factor is exactly 1.0 for any
//     non-negative inflection, so the whole vendored catalogue (MAG_CUTOFF
//     5.5 above) and the whole star cubemap render undimmed. The catalogue is
//     one magnitude short of the 6.5 reference limit this rural claim cites;
//     deepening it further is a bake-parameter change
//     (Tools/star-catalog-bake), not a code change. That is a rural sky:
//     Bortle class 4 / naked-eye limiting magnitude ~6.5, against ~4.5 for a
//     suburban sky and ~3 for an inner city (Bortle, Sky & Telescope 2001,
//     "The Bortle Dark-Sky Scale"; Crumey 2014, MNRAS 442:2600, for the
//     relation between naked-eye limit and sky brightness). Light pollution is
//     out of scope, so there is no additive skyglow term anywhere here — only
//     the natural sources the estimator already carries: sun, moon, and the
//     eclipse factor folded into `skyBrightness`.
//
//  2. The steepness is set by the totality anchor. During totality the sky is
//     civil twilight (~5 lux against ~100,000 lux full sun — AAS eclipse
//     basics; Optica sky-brightness survey, AO 10(6):1207) and observers see
//     the bright planets plus roughly first- to third-magnitude stars, not a
//     full night sky. Target: naked-eye limit 6.5 -> ~3.5, i.e. `dm = 3.0`
//     magnitudes, i.e. a Pogson flux multiplier
//
//       k = 10^(-0.4 * 3.0) = 0.06310
//
//     `Scene.updateEnvironment` publishes `skyBrightness =
//     computeSkyBrightness(...) * eclipseSceneLightFactor`, whose totality
//     value is `ECLIPSE_TWILIGHT_FLOOR = (5/100000)^(1/3) = 0.0368403`. The
//     strongest suppression case is a high-sun totality (2027-08-02 Luxor, sun
//     82 deg up) where `computeSkyBrightness` is 1.0, so
//     `B_totality = 0.0368403`. Solving `1 - smoothstep(0,1,t*) = k` gives
//     `t* = 0.8469590`, hence
//
//       steepness = t* / B_totality = 22.990  ->  23.0
//       inflection = 0.0
//
//     At the shipped 23.0 the factor at totality is 0.062810, i.e. -3.00 mag
//     to five figures. `eclipse-sky-totality.spec.mjs` re-derives both numbers
//     from the published constants and fails if they drift. A low-sun totality
//     (2026-08-12 Iceland, sun ~10 deg) lands at `B = 0.458141 * 0.0368403 =
//     0.016878` -> factor 0.664912 -> -0.44 mag: more stars, which is right,
//     because the sky it started from was already dimmer.
//
//  3. The day end falls out. At `skyBrightness = 1` (sun >= ~23.6 deg up for
//     an in-atmosphere camera) `t` saturates and the factor is exactly 0 — no
//     naked-eye stars in daylight, which is the physical answer. The case that
//     must not be caught by it is the orbital camera on the day side, where
//     the sky really is black and the stars really are there; that is handled
//     at the source, because `SkyBrightness.computeAtmosphericColumnFactor`
//     takes `skyBrightness` to 0 above the engine's own 111 km scattering
//     shell, so an orbital camera gets factor 1.0 and renders identically to
//     one with the modulation disabled.
//
// Off the two anchors the curve is composed with the log-luminance estimator
// in `SkyBrightness.js`, which carries dynamic range across the whole twilight
// decade; the composition `modulation(computeSkyBrightness(...))` reproduces
// the published naked-eye limits. Moonless ground camera, by solar elevation:
//
//   sun elev |  factor   | naked-eye limit
//   ---------|-----------|-----------------
//    <= -18  |  1.000000 |  6.50
//      -15   |  0.604705 |  5.95
//      -12   |  0.363078 |  5.40   (end of nautical twilight)
//       -9   |  0.098257 |  3.98
//       -6   |  0.026303 |  2.55   (end of civil twilight)
//       -3   |  0.006619 |  1.05
//       -2   |  0.004175 |  0.55   (`skyBrightness` 0.0418355; Venus and one
//            |           |          or two first-magnitude stars, which is
//            |           |          what observers report)
//        0   |  0.001660 | -0.45
//   >= +23.6 |  0.000000 |  none
//
// The bands are monotone and separated across the full range; a curve that
// reaches 0 anywhere above -6 deg collapses the astronomical and nautical
// bands onto a single sky.
//
// Moonlight enters through the published full-moon sky brightness and the
// `p^3.64` phase-flux law rather than a flat perceptual constant, which is
// what keeps a quarter moon from being weighted like a gibbous one (moon
// overhead, astronomical night):
//   p = 0.25 -> factor 0.902705
//   p = 0.50 -> factor 0.510830
//   p = 0.75 -> factor 0.273275
//   p = 1.00 -> `skyBrightness` 0.0322377 -> factor 0.165959 (-1.95 mag,
//               naked-eye limit 4.55 against a published full-moon limit
//               of ~4.5)
//
// `sky-brightness-twilight.spec.mjs` re-derives every one of these from the
// published photometry chain, requires the checks to reject a curve without
// twilight range, and fails if they drift.

/** Default modulation-curve inflection (see the derivation above). */
export const STAR_MODULATION_INFLECTION = 0.0;

/** Default modulation-curve steepness (see the derivation above). */
export const STAR_MODULATION_STEEPNESS = 23.0;

/**
 * Reference naked-eye limiting magnitude of the undimmed (factor 1.0) sky —
 * a rural Bortle-4 night. Used only to state what a given factor means in
 * magnitudes; nothing reads it at render time.
 */
export const STAR_REFERENCE_LIMITING_MAGNITUDE = 6.5;

/**
 * Evaluate the star-brightness modulation factor. Byte-for-byte the same
 * expression as `SkyBoxFS.glsl` and `CubeMapPanorama.wgsl`, so the CPU-side
 * consumers (`StarField`'s sprite floor) and the GPU-side consumers cannot
 * disagree about how bright the stars are.
 *
 * @param {number} skyBrightness `frameState.skyBrightness`, 0..1.
 * @param {number} inflection Curve inflection (sky brightness at which stars
 *   start being lost).
 * @param {number} steepness Curve steepness.
 * @returns {number} Multiplier in [0, 1]; exactly 1.0 at `skyBrightness = 0`
 *   for any non-negative inflection.
 * @private
 */
export function computeStarBrightnessModulation(
  skyBrightness: number,
  inflection: number,
  steepness: number,
): number {
  if (
    !isFinite(skyBrightness) ||
    !isFinite(inflection) ||
    !isFinite(steepness)
  ) {
    return 1.0;
  }
  let t = (skyBrightness - inflection) * steepness;
  t = t < 0.0 ? 0.0 : t > 1.0 ? 1.0 : t;
  return 1.0 - t * t * (3.0 - 2.0 * t);
}

export default {
  FLOATS_PER_STAR,
  bvToRgb,
  buildStarInstanceData,
  computeStarDayFade,
  computeStarBrightnessModulation,
  STAR_MODULATION_INFLECTION,
  STAR_MODULATION_STEEPNESS,
  STAR_REFERENCE_LIMITING_MAGNITUDE,
};
