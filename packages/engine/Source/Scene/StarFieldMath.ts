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
  //     inclusion bound (the faintest vendored star), not a bright-
  //     stars-only gate. The whole catalogue renders; stars between the
  //     3.6 anchor and the bound fall below the guaranteed M1 census floor
  //     but remain visible.
  //
  // C12-09 RE-DERIVATION (the deepening C12-08 anticipated). The catalogue
  // now runs to vmag 5.5 (2,870 stars, up from 263 at 5.0), so:
  //
  //   MAG_CUTOFF 5.0 -> 5.5. This is NOT a tuning choice: it is definitionally
  //     the faintest vendored star. Left at 5.0 the expression below would
  //     emit ZERO flux for the 1,240 rows between 5.0 and 5.5 — the deepening
  //     would be inert. `Tools/visual-regression/star-catalog-depth.spec.mjs`
  //     re-derives it from the shipped table and fails if the two drift.
  //
  //   FAINT_ANCHOR_MAG / FAINT_ANCHOR_PEAK — DELIBERATELY UNCHANGED at
  //     3.6 / 0.060. The anchor is an EXPOSURE decision derived from the M1
  //     census detection floor (P-B >= 12/255), not from where the catalogue
  //     happens to end; C12-08 tied it to the census, and the census did not
  //     move. Re-anchoring at 5.5 would multiply EXPOSURE by 10^(0.4*1.9) =
  //     5.75, taking Sirius from I = 5.87 to 33.8 — its quad growth sqrt(I) =
  //     5.81 would then be clipped hard by the 1-degree MAX_QUAD_SCALE (2.909)
  //     and the "glare area proportional to flux" law C12-06 derives would
  //     stop holding for every star brighter than ~1.5 mag. The faint end
  //     stays visible without it: a mag-5.5 star peaks at
  //     0.060 * 10^(-0.4*1.9) = 0.0104 ~ 2.7/255, and the exposure only falls
  //     below 1/255 past vmag 6.56 — so the sprite path still has ~1 magnitude
  //     of headroom beyond the current bound before rows would render into
  //     nothing. Re-derive BOTH again if a future deepening passes 6.5.
  //
  // The cubemap double-draw seam is owned and reconciled by C12-11; under
  // DR-01 the blurred bake carries diffuse light only, so the sprite side is
  // the sole source of resolved stars and deliberately renders the full
  // catalogue per the C12-08 mandate.
  const MAG_CUTOFF = 5.5;
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
    // Stars fainter than the vendored-catalogue bound emit zero (none exist
    // today — the bake refuses to emit them; the guard is the belt-and-braces
    // half of the C12-09 deepening valve).
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
    // The C12-34 single home of the solar-elevation derivation — shared
    // with the SkyBrightness estimator (and the C15 aurora edge).
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
    // result is the historical geometric fade. Between 60 and 111 km the
    // washout disappears smoothly; above the shell it is exactly 1. Scene
    // supplies ellipsoidal height, so this works at every WGS84 latitude and
    // on custom globe ellipsoids without an Earth-radius assumption.
    const column = computeAtmosphericColumnFactor(cameraHeight);
    dayFade = 1.0 - column * (1.0 - dayFade);
  }
  return dayFade;
}

// ─── C12-29 S6 / ruling E3 — star-brightness modulation ────────────────────
//
// The "star brightness at night" machinery is a single multiplier applied to
// the star CUBEMAP (`SkyBoxFS.glsl` on WebGL, `CubeMapPanorama.wgsl` on
// WebGPU) driven by `frameState.skyBrightness`. Ruling E3 flips it on by
// default at a countryside-like level and routes the reveal at totality
// through it rather than through a new eclipse-only path. This function is the
// CPU twin of the shader expression; both shaders and `StarField`'s sprite
// floor evaluate the same three lines.
//
//   t      = clamp((skyBrightness - inflection) * steepness, 0, 1)
//   factor = 1 - smoothstep(0, 1, t)
//
// WHY THESE DEFAULTS (they are derived, not dialled):
//
//  1. THE NIGHT END IS THE "COUNTRYSIDE" CLAIM. At `skyBrightness = 0` —
//     astronomical night, no moon — the factor is exactly 1.0 for any
//     non-negative inflection, i.e. the full vendored catalogue (MAG_CUTOFF
//     5.5 above, since C12-09) and the full star cubemap render undimmed.
//     Note the catalogue is still one magnitude short of the 6.5 reference
//     limit this rural claim cites; deepening it further is a bake-parameter
//     change (Tools/star-catalog-bake), not a code change. That is a rural
//     sky: Bortle class 4 / naked-eye limiting magnitude ~6.5, against ~4.5
//     for a suburban sky and ~3 for an inner city (Bortle, Sky & Telescope
//     2001, "The Bortle Dark-Sky Scale"; Crumey 2014, MNRAS 442:2600, for the
//     NELM<->sky-brightness relation). E3 forbids light-pollution modelling,
//     so there is no additive skyglow term anywhere here — only the natural
//     sources the estimator already carries (sun, moon, and the eclipse
//     factor S2 folds into `skyBrightness`).
//
//  2. THE STEEPNESS IS SET BY THE TOTALITY ANCHOR. During totality the sky
//     is civil twilight (~5 lux against ~100,000 lux full sun — AAS eclipse
//     basics; Optica sky-brightness survey, AO 10(6):1207) and observers see
//     the bright planets plus roughly first- to third-magnitude stars — not a
//     full night sky. Target: naked-eye limit 6.5 -> ~3.5, i.e. `dm = 3.0`
//     magnitudes, i.e. a Pogson flux multiplier
//
//       k = 10^(-0.4 * 3.0) = 0.06310
//
//     `Scene.updateEnvironment` publishes `skyBrightness =
//     computeSkyBrightness(...) * eclipseSceneLightFactor`, and S2's totality
//     value of that factor is
//     `ECLIPSE_TWILIGHT_FLOOR = (5/100000)^(1/3) = 0.0368403`. The strongest
//     suppression case is a HIGH-sun totality (2027-08-02 Luxor, sun 82 deg
//     up) where `computeSkyBrightness` is 1.0, so `B_totality = 0.0368403`.
//     Solving `1 - smoothstep(0,1,t*) = k` gives `t* = 0.8469590`, hence
//
//       steepness = t* / B_totality = 22.990  ->  23.0
//       inflection = 0.0
//
//     At the shipped 23.0 the factor at totality is 0.062810, i.e. -3.00 mag
//     to five figures. `eclipse-sky-totality.spec.mjs` re-derives both numbers
//     from the published constants and fails if they drift. A LOW-sun totality
//     (2026-08-12 Iceland, sun ~10 deg) lands at `B = 0.458141 * 0.0368403 =
//     0.016878` -> factor 0.664912 -> -0.44 mag under the C12-34 twilight
//     estimator: more stars, which is right, because the sky it started from
//     was already dimmer.
//
//  3. THE DAY END FALLS OUT. At `skyBrightness = 1` (sun >= ~23.6 deg up for
//     an in-atmosphere camera) `t` saturates and the factor is exactly 0 — no
//     naked-eye stars in daylight, which is the physical answer. C11-176's
//     regression was NOT this behaviour; it was that the flag also zeroed the
//     cubemap for ORBITAL cameras on the day side, where the sky really is
//     black and the stars really are there. That is fixed at the source:
//     `SkyBrightness.computeAtmosphericColumnFactor` now takes
//     `skyBrightness` to 0 above the engine's own 111 km scattering shell, so
//     an orbital camera gets factor 1.0 and is byte-identical.
//
// OFF-ANCHOR VALUES, now DERIVED rather than recorded-as-defects (C12-34).
// The two "measured consequences" this block used to carry — full moon
// overhead at factor 0.01818 (NELM ~2.2 against a published ~4.5) and mid
// civil twilight at exactly 0 — both followed from the pre-C12-34
// `computeSkyBrightness` collapsing to exactly 0 once the sun was below
// -5.74 deg: it had no dynamic range across the twilight decade, so no
// choice of these two curve parameters could separate "late civil twilight"
// from "astronomical night". The C12-34 log-luminance estimator (see
// `SkyBrightness.js`) restores that range at the SOURCE and calibrates its
// perceptual transfer against this curve, so the composition
// `modulation(computeSkyBrightness(...))` now reproduces the published
// naked-eye limits the old pair missed:
//   full moon overhead -> `skyBrightness` 0.0322377 -> factor 0.165959,
//     i.e. -1.95 mag, NELM 4.55 against the published full-moon ~4.5.
//   mid civil twilight (sun -2 deg) -> `skyBrightness` 0.0418355 ->
//     factor 0.004175, NELM 0.55: Venus and one or two first-magnitude
//     stars, which is what real observers report.
//   end of civil twilight (sun -6 deg) -> factor 0.026303 (NELM 2.55);
//   end of nautical (-12 deg) -> factor 0.363078 (NELM 5.40); the bands are
//   monotone and separated instead of all mapping to 0.
//
// MEASURED CONSEQUENCES OF THE SWAP — what actually moves on screen, at which
// solar elevations, and by how much. Every row is the shipped composition
// `modulation(computeSkyBrightness(sun at h, moonless, ground camera))`, run
// against the pre-C12-34 double-smoothstep and against the shipped estimator:
//
//   sun elev |  old factor (NELM) |  new factor (NELM) |  change
//   ---------|--------------------|--------------------|-------------------
//    <= -18  |  1.000000 (6.50)   |  1.000000 (6.50)   |  BYTE-IDENTICAL
//      -15   |  1.000000 (6.50)   |  0.604705 (5.95)   |  -0.55 mag
//      -12   |  1.000000 (6.50)   |  0.363078 (5.40)   |  -1.10 mag
//       -9   |  1.000000 (6.50)   |  0.098257 (3.98)   |  -2.52 mag
//       -6   |  1.000000 (6.50)   |  0.026303 (2.55)   |  -3.95 mag
//       -3   |  0.370549 (5.42)   |  0.006619 (1.05)   |  -4.37 mag
//       -2   |  0.000000 (none)   |  0.004175 (0.55)   |  stars RETURN
//        0   |  0.000000 (none)   |  0.001660 (-0.45)  |  ~none either way
//   >= +23.6 |  0.000000 (none)   |  0.000000 (none)   |  BYTE-IDENTICAL
//
// The single number that names the defect: across -18 deg to -6 deg — the
// astronomical and nautical bands, half the twilight decade — the OLD
// factor's total span was EXACTLY 0.000000. The new span is 0.973697. The
// old curve did all of its work inside one 3.7-degree window (-5.74 deg,
// factor 1, to -2 deg, factor 0) and none anywhere else; the new one is
// monotone across the whole range and hands each band a distinct sky.
//
// Moonlight moves too, and mostly at full phase, because the flat 4%
// perceptual constant is replaced by the published full-moon sky brightness
// plus the `p^3.64` phase-flux law (moon overhead, astronomical night):
//   p = 0.25 -> 0.865634 -> 0.902705   (+0.05 mag; a quarter moon was being
//               over-weighted ~6x by the old LINEAR phase scaling)
//   p = 0.50 -> 0.559872 -> 0.510830   (-0.10 mag)
//   p = 0.75 -> 0.228718 -> 0.273275   (+0.19 mag)
//   p = 1.00 -> 0.018176 -> 0.165959   (+2.40 mag; 9.13x. This is the queue
//               row's headline defect: NELM 2.15 -> 4.55 against a published
//               full-moon limit of ~4.5.)
//
// And the eclipse anchors, which had to survive unmoved and did: HIGH-sun
// totality is still `1.0 * ECLIPSE_TWILIGHT_FLOOR` -> factor 0.062810
// (-3.00 mag), bit-for-bit, because a saturated day is still exactly 1.0.
// Only the LOW-sun totality moves, 0.5246 -> 0.664912 (-0.70 -> -0.44 mag),
// and it moves in the correct direction for the same reason it always did.
//
// `sky-brightness-twilight.spec.mjs` re-derives every one of these from the
// published photometry chain — and re-runs the old estimator to prove the
// checks REJECT it — and fails if they drift.

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
