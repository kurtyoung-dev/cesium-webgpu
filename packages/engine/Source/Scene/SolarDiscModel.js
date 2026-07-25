// SolarDiscModel.js — C12-15 / C12-16. THE single source of truth for the
// solar-disc photometry constants and the two radial profiles the sun-disc
// bake is built from.
//
// WHY THIS MODULE EXISTS. Before it, the limb-darkening triple lived only in
// `computeSolarObscuration.js` (C12-29 S1's eclipse photometry) and the sun
// billboard's own disc was a *binary* `step()` with no limb darkening at all,
// while the glare falloff was a bare `1.0 - smoothstep(0.0, 0.55, r)` literal
// duplicated between `Shaders/SunTextureFS.glsl` (WebGL) and the CPU bake in
// `Renderer/WebGPU/WebGPUEnvironmentRenderer.js` (WebGPU). The C12-15 queue
// row requires ONE constants source once the sun wave lands. Three consumers
// now read this module:
//
//   1. `computeSolarObscuration.js` — the eclipse flux quadrature.
//   2. `Scene/Sun.js` — feeds the values to `SunTextureFS.glsl` as UNIFORMS
//      (`u_limbDarkening`, `u_glareCore`, `u_glarePedestal`, `u_glareLegacy`),
//      so the GLSL carries no numeric copy of them at all.
//   3. `Renderer/WebGPU/WebGPUEnvironmentRenderer.js` — imports the pure
//      functions directly for its CPU bake.
//
// That makes "one constants source" structural rather than a comment: there
// is no second literal to drift.
//
// COORDINATE CONVENTION (shared by both bakes, do not change without changing
// both). The bake runs over the square billboard texture; with
// `p = uv - vec2(0.5)` and `lengthScalar = 2 / sqrt(2)`, the shaders use
//
//     radius = length(p) * lengthScalar
//
// so `radius == 1` at the texture CORNER and `radius == 1/sqrt(2)` at the
// edge midpoint. Because the billboard spans `1 + 2*glowLengthTS` solar
// radii per half-extent (11 R_sun at the default `glowFactor = 1`), the
// map from `radius` to solar radii is
//
//     rho_Rsun = radius * 22 / sqrt(2) = radius / 0.0642824
//
// i.e. `radius = 1/sqrt(2)` is exactly 11 R_sun (the inscribed circle of the
// quad) and `radius = 0.55` — the legacy glare cutoff — is 8.556 R_sun.
//
// @private
// @module SolarDiscModel

/**
 * C12-15 quadratic limb-darkening coefficients, `I(mu) = a0 + a1*mu + a2*mu^2`
 * with `mu = cos(heliocentric angle)`, normalised so `I(1) = a0+a1+a2 = 1` at
 * disc centre and `I(0) = a0 = 0.30` at the limb (the limb is ~30% of centre
 * in the broadband visual, the figure the C12-15 row quotes).
 *
 * Passing `(1, 0, 0)` instead reproduces the historical flat disc EXACTLY
 * (`I == 1` everywhere), which is how the `enableSolarLimbDarkening = false`
 * position stays byte-identical without a shader branch.
 *
 * @private
 */
const SOLAR_LIMB_DARKENING_A0 = 0.3;
const SOLAR_LIMB_DARKENING_A1 = 0.93;
const SOLAR_LIMB_DARKENING_A2 = -0.23;

/**
 * Half-amplitude radius of the C12-16 glare core, in the `radius` units
 * described in the module header. 0.275 is the legacy profile's own
 * half-amplitude point (`1 - smoothstep(0, 0.55, r) == 0.5` at `r = 0.275`),
 * chosen so the new curve is anchored to the shipped look rather than to a
 * free parameter.
 *
 * @private
 */
const SOLAR_GLARE_CORE = 0.275;

/**
 * Outer support of the glare profile: the largest radius whose full circle
 * still fits inside the square billboard. A veiling-glare PSF falls as
 * `1/theta^2` and never truly terminates (the C12-16 row's complaint about
 * `1 - smoothstep(0, 0.55, r)`, which hits exactly zero at 0.55 and stays
 * there), but a FINITE quad must reach zero somewhere or the halo shows the
 * billboard's straight edges. Taking the inscribed circle is the widest
 * support the existing geometry allows and keeps the termination circular,
 * so no square edge is ever visible.
 *
 * The genuinely non-terminating tail is C12-18's job — the screen-space halo
 * from the post-process chain, which has no quad to fall off. This constant
 * is the honest bound of what a baked billboard can carry.
 *
 * @private
 */
const SOLAR_GLARE_SUPPORT = Math.SQRT1_2;

/**
 * Value the raw Lorentzian takes at {@link SOLAR_GLARE_SUPPORT}. Subtracting
 * it (and renormalising) is what makes the profile reach exactly 0.0 at the
 * support radius instead of leaving a ~0.13 pedestal that would paint a
 * visible disc edge at the inscribed circle.
 *
 * @private
 */
const SOLAR_GLARE_PEDESTAL =
  1.0 /
  (1.0 +
    (SOLAR_GLARE_SUPPORT / SOLAR_GLARE_CORE) *
      (SOLAR_GLARE_SUPPORT / SOLAR_GLARE_CORE));

/**
 * Legacy glare cutoff radius — the `0.55` in `1 - smoothstep(0, 0.55, r)`.
 * Exported so the legacy branch in `SunTextureFS.glsl` can be fed rather
 * than re-typed.
 *
 * @private
 */
const SOLAR_GLARE_LEGACY_EDGE = 0.55;

/**
 * Solar limb-darkening intensity at projected radius fraction `x = r / R_sun`,
 * normalised to 1.0 at disc centre. Identical law to
 * `computeSolarObscuration.limbIntensity`, which now imports these
 * coefficients from here.
 *
 * @param {number} x Projected radius fraction; values outside [0, 1] are clamped.
 * @returns {number} Relative intensity in [a0, 1].
 * @private
 */
function solarLimbIntensity(x) {
  const xc = x < 0.0 ? 0.0 : x > 1.0 ? 1.0 : x;
  const s = 1.0 - xc * xc;
  const mu = s > 0.0 ? Math.sqrt(s) : 0.0;
  return (
    SOLAR_LIMB_DARKENING_A0 +
    SOLAR_LIMB_DARKENING_A1 * mu +
    SOLAR_LIMB_DARKENING_A2 * mu * mu
  );
}

/**
 * C12-16 glare profile — a Lorentzian core with a `1/radius^2` tail, the
 * shape a veiling-glare / disability-glare point-spread function takes
 * (`L_veil ∝ E / theta^2`, the CIE stray-light form). Pedestal-subtracted so
 * it is exactly 0 at {@link SOLAR_GLARE_SUPPORT}.
 *
 *   raw(r)     = 1 / (1 + (r / core)^2)
 *   profile(r) = (raw(r) - pedestal) / (1 - pedestal), clamped to [0, 1]
 *
 * Measured against the legacy curve at the default `glowFactor = 1`
 * (`radius = 0.0642824 * rho_Rsun`):
 *
 *   rho (R_sun) | radius  | legacy  | C12-16  | delta
 *   ------------+---------+---------+---------+-------
 *          0.0  | 0.0000  | 1.0000  | 1.0000  |  0.000
 *          1.5  | 0.0964  | 0.9186  | 0.8740  | -0.045
 *          3.11 | 0.2000  | 0.6995  | 0.6017  | -0.098  (round radius 0.2)
 *          3.23 | 0.2077  | 0.6798  | 0.5818  | -0.0981 <- TRUE extremum
 *          4.28 | 0.2750  | 0.5000  | 0.4244  | -0.076
 *          6.0  | 0.3857  | 0.2144  | 0.2367  | +0.022
 *          8.56 | 0.5500  | 0.0000  | 0.0790  | +0.079
 *         11.0  | 0.7071  | 0.0000  | 0.0000  |  0.000
 *
 * So the visible support grows from 8.556 R_sun to 11.0 R_sun and the tail
 * decays as an inverse square instead of terminating, at the cost of at most
 * 0.09805 profile units (0.0735 in alpha, ~19/255) in the mid halo, located
 * at rho = 3.2313 R_sun (radius 0.2077) — found by a 600k-sample sweep, not
 * by reading the nearest round row. That table
 * is also the arithmetic that rules C12-16 OUT as the cause of
 * `probe-eclipse-sun-fade`'s `glowOffRaw == 0` on WebGPU over the 1.5x..6x
 * annulus: BOTH curves put alpha (0.75 x profile) between 0.16 and 0.69
 * there, two orders of magnitude above the 1/255 quantisation floor and far
 * inside either support radius. Reshaping the falloff cannot turn a measured
 * zero into a non-zero, so the zero has a different cause — see
 * `probe-sun-glow-profile.mjs`.
 *
 * @param {number} radius Bake radius (module-header convention).
 * @returns {number} Glare weight in [0, 1].
 * @private
 */
function solarGlareProfile(radius) {
  const t = radius / SOLAR_GLARE_CORE;
  const raw = 1.0 / (1.0 + t * t);
  const v = (raw - SOLAR_GLARE_PEDESTAL) / (1.0 - SOLAR_GLARE_PEDESTAL);
  return v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v;
}

/**
 * The historical glare profile, `1 - smoothstep(0, 0.55, radius)`. Kept so
 * the `enableSolarGlareFalloff = false` position is reproducible from the
 * same module (and so the Node spec can assert the two curves agree at the
 * anchor points rather than trusting a comment).
 *
 * @param {number} radius Bake radius (module-header convention).
 * @returns {number} Glare weight in [0, 1].
 * @private
 */
function solarGlareProfileLegacy(radius) {
  const t0 = radius / SOLAR_GLARE_LEGACY_EDGE;
  const t = t0 < 0.0 ? 0.0 : t0 > 1.0 ? 1.0 : t0;
  return 1.0 - t * t * (3.0 - 2.0 * t);
}

/**
 * Converts a bake `radius` to solar radii at a given glow length, so probes
 * and specs never re-derive the 22/sqrt(2) factor.
 *
 * @param {number} radius Bake radius (module-header convention).
 * @param {number} glowLengthTS `glowFactor * 5`, as both bakes compute it.
 * @returns {number} Distance from the solar centre in solar radii.
 * @private
 */
function solarBakeRadiusToSolarRadii(radius, glowLengthTS) {
  const halfExtentRsun = 1.0 + 2.0 * glowLengthTS;
  return radius * Math.SQRT2 * halfExtentRsun;
}

/**
 * Frozen namespace default export.
 *
 * REQUIRED, not stylistic: `packages/engine/index.js` is GENERATED and
 * gitignored, and `scripts/build.js` emits `export { default as X } from
 * './<path>.js'` for EVERY file under `Source/**` with no exclusion
 * mechanism. A module with named exports only therefore fails
 * `npx gulp build` with "No matching export ... for import default" — and
 * `npx tsc --noEmit` does NOT catch it, because tsc never type-checks the
 * generated barrel. A gulp build is the only gate that catches this class.
 *
 * A frozen object rather than "one of the functions" because this module is
 * a constants + profile bundle with no single primary entry point; the
 * sibling modules that DO have one (`computeSolarObscuration`,
 * `EclipseState`, `SkyBrightness`) default-export that function instead.
 *
 * @private
 */
const SolarDiscModel = Object.freeze({
  SOLAR_LIMB_DARKENING_A0,
  SOLAR_LIMB_DARKENING_A1,
  SOLAR_LIMB_DARKENING_A2,
  SOLAR_GLARE_CORE,
  SOLAR_GLARE_SUPPORT,
  SOLAR_GLARE_PEDESTAL,
  SOLAR_GLARE_LEGACY_EDGE,
  solarLimbIntensity,
  solarGlareProfile,
  solarGlareProfileLegacy,
  solarBakeRadiusToSolarRadii,
});

export {
  SOLAR_LIMB_DARKENING_A0,
  SOLAR_LIMB_DARKENING_A1,
  SOLAR_LIMB_DARKENING_A2,
  SOLAR_GLARE_CORE,
  SOLAR_GLARE_SUPPORT,
  SOLAR_GLARE_PEDESTAL,
  SOLAR_GLARE_LEGACY_EDGE,
  solarLimbIntensity,
  solarGlareProfile,
  solarGlareProfileLegacy,
  solarBakeRadiusToSolarRadii,
};
export default SolarDiscModel;
