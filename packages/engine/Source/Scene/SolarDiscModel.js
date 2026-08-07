// SolarDiscModel.js — C12-15 / C12-16 / C12-27. THE single source of truth for
// the solar-disc photometry constants and the radial profiles the sun-disc bake
// and the angular star washout are built from.
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
//   4. `Scene/SolarGlareAppearance.js` — C12-27's per-frame resolver, which
//      feeds the ANGULAR parameterisation of the same veiling-glare curve to
//      four shaders (star sprites + star cube map, both backends) as uniforms.
//
// That makes "one constants source" structural rather than a comment: there
// is no second literal to drift.
//
// ─── ONE CURVE, TWO PARAMETERISATIONS (C12-27) ─────────────────────────────
//
// C12-16's `solarGlareProfile` and C12-27's `solarAngularGlareVeil` are the
// SAME pedestal-subtracted Lorentzian, `{@link pedestalLorentzian}`, evaluated
// over two different domains:
//
//   C12-16  x = bake `radius` (the billboard's own texture coordinate)
//   C12-27  x = ANGULAR separation from the Sun, in radians
//
// Both decay as `1/x^2` — the Stiles-Holladay / CIE disability-glare form
// `L_veil ∝ E / theta^2`. The C12-27 queue row prescribes reusing "the C12-05
// Stiles-Holladay math"; that identification is WRONG and is recorded here so
// nobody re-derives it. `C12-05` DID land (Batch 748), but its Moffat wing is
// `(1 + (r/alpha)^2)^(-beta)` with `STAR_PSF_BETA = 2.0`, i.e. a log-log slope
// of `-2*beta = -4`: an inverse-FOURTH-power wing, deliberately, because it
// models a single unresolved star's point-spread function and not the veiling
// luminance across the sky. The landed inverse-SQUARE veiling form in this fork
// is C12-16's, right here. So the glare curve has exactly one home, and it is
// this module.
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
 * Value the raw Lorentzian `1 / (1 + (support/core)^2)` takes at the support
 * radius. Subtracting it (and renormalising) is what makes a profile reach
 * exactly 0.0 at its support instead of leaving a pedestal that would paint a
 * visible hard edge there.
 *
 * @param {number} support Outer support, in the profile's own domain units.
 * @param {number} core Half-amplitude radius, same units.
 * @returns {number} The raw Lorentzian value at `support`.
 * @private
 */
function lorentzianPedestal(support, core) {
  return 1.0 / (1.0 + (support / core) * (support / core));
}

/**
 * The shared pedestal-subtracted Lorentzian both glare profiles are made of
 * (see the "one curve, two parameterisations" note in the module header).
 *
 *   raw(x)     = 1 / (1 + (x / core)^2)          ->  ~ (core/x)^2 for x >> core
 *   profile(x) = (raw(x) - pedestal) / (1 - pedestal), clamped to [0, 1]
 *
 * The clamp is what terminates the curve at the support radius: beyond it
 * `raw < pedestal`, so the numerator goes negative and the result is exactly
 * 0.0 — not "small", zero. Callers that need a byte-identical no-op outside
 * the support rely on that.
 *
 * The operation ORDER here is byte-for-byte the expression `solarGlareProfile`
 * carried before C12-27 factored it out; `solar-glare-star-washout.spec.mjs`
 * pins the two against a frozen copy of the pre-C12-27 body over a dense sweep
 * and requires EXACT equality, so the refactor cannot have moved a bit.
 *
 * @param {number} x Position in the profile's own domain.
 * @param {number} core Half-amplitude radius.
 * @param {number} pedestal {@link lorentzianPedestal} at the support radius.
 * @returns {number} Glare weight in [0, 1].
 * @private
 */
function pedestalLorentzian(x, core, pedestal) {
  const t = x / core;
  const raw = 1.0 / (1.0 + t * t);
  const v = (raw - pedestal) / (1.0 - pedestal);
  return v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v;
}

/**
 * Value the raw Lorentzian takes at {@link SOLAR_GLARE_SUPPORT}. Subtracting
 * it (and renormalising) is what makes the profile reach exactly 0.0 at the
 * support radius instead of leaving a ~0.13 pedestal that would paint a
 * visible disc edge at the inscribed circle.
 *
 * @private
 */
const SOLAR_GLARE_PEDESTAL = lorentzianPedestal(
  SOLAR_GLARE_SUPPORT,
  SOLAR_GLARE_CORE,
);

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
  return pedestalLorentzian(radius, SOLAR_GLARE_CORE, SOLAR_GLARE_PEDESTAL);
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

// ─── C12-18 — THE DISC IS UNDERSIZED BY EXACTLY sqrt(2) ────────────────────
//
// Both bakes compare the CORNER-normalised `radius` against `radiusTS`, but
// `radiusTS = 0.5 / (1 + 2*glowLengthTS)` is expressed as a fraction of the
// quad's HALF-EXTENT (`|p| <= 0.5`), not of the corner distance. Concretely,
// with `p = uv - 0.5` the on-screen offset of a texel is `p * quadWidth`, the
// quad half-width is `(1 + 2*glowLengthTS)` solar limbs, and so
//
//   |p| == radiusTS   <=>   on-screen offset == 1.0 solar limb  (correct)
//   radius == radiusTS  <=>  |p| == radiusTS / lengthScalar
//                        <=>  offset == 1/sqrt(2) == 0.7071 solar limbs
//
// i.e. the shipped disc subtends 0.7071 x the Sun's true angular radius —
// 0.3767 deg of diameter instead of 0.5327 deg. `solarBakeRadiusToSolarRadii`
// above says the same thing in one line: it maps the shipped `radiusTS` to
// 0.70711 R_sun. WebGPU's CPU bake reproduced the WebGL expression faithfully,
// so BOTH backends are undersized by the same factor and the defect is
// invisible to any WebGL-vs-WebGPU diff. This is the "disc at true 0.53 deg"
// half of the C12-18 row.

/**
 * The `lengthScalar` both bakes apply to `length(uv - 0.5)`.
 *
 * Written as `2 / sqrt(2)` and NOT as `Math.SQRT2` deliberately: that is the
 * literal expression in `SunTextureFS.glsl` and in the WebGPU CPU bake, and
 * in IEEE-754 binary64 the two differ by one ULP
 * (`2 / Math.sqrt(2) === 1.414213562373095` vs `Math.SQRT2 ===
 * 1.4142135623730951`). Both round to the same binary32, so nothing visible
 * turns on it, but "one constants source" means carrying the bakes' own
 * expression rather than a mathematically-equal neighbour.
 *
 * @private
 */
const SOLAR_DISC_BAKE_LENGTH_SCALAR = 2.0 / Math.sqrt(2.0);

/**
 * Historical (undersized) disc edge in bake-`radius` units:
 * `0.5 / (1 + 2*glowLengthTS)`, which lands at 1/sqrt(2) solar radii.
 *
 * @param {number} glowLengthTS `glowFactor * 5`, as both bakes compute it.
 * @returns {number} Bake radius at which the legacy disc terminates.
 * @private
 */
function solarDiscBakeEdgeLegacy(glowLengthTS) {
  return 0.5 / (1.0 + 2.0 * glowLengthTS);
}

/**
 * C12-18 disc edge in bake-`radius` units — the radius at which the disc
 * terminates so that it subtends the Sun's TRUE angular radius.
 *
 * `solarBakeRadiusToSolarRadii(solarDiscBakeEdge(g), g) === 1` to within a
 * binary64 ULP, by construction; `solar-sun-halo-model.spec.mjs` pins that.
 *
 * @param {number} glowLengthTS `glowFactor * 5`, as both bakes compute it.
 * @param {boolean} [trueSize=true] `false` returns the legacy edge EXACTLY
 *        (`solarDiscBakeEdgeLegacy`), which is the byte-identical off
 *        position of `lighting.enableTrueSolarDiscSize`.
 * @returns {number} Bake radius at which the disc terminates.
 * @private
 */
function solarDiscBakeEdge(glowLengthTS, trueSize) {
  const legacy = solarDiscBakeEdgeLegacy(glowLengthTS);
  return trueSize === false ? legacy : legacy * SOLAR_DISC_BAKE_LENGTH_SCALAR;
}

// ─── C12-18 — THE SCREEN-SPACE HALO ────────────────────────────────────────
//
// `SOLAR_GLARE_SUPPORT` above records the honest bound of a BAKED halo: a
// finite quad must reach zero somewhere or its straight edges show, so the
// C12-16 profile is pedestal-subtracted to terminate on the inscribed circle
// at 11 R_sun. Its own doc comment names the sequel: "The genuinely
// non-terminating tail is C12-18's job — the screen-space halo from the
// post-process chain, which has no quad to fall off."
//
// This is that tail. It is the SAME Lorentzian, evaluated in ANGULAR units
// (solar radii from the projected solar centre) and WITHOUT the pedestal
// subtraction or the support clamp, because in screen space there is no quad
// to fall off. Amplitude is the bake's own `0.75` glare weight, so the two
// compositions are continuous at the centre by construction.

/**
 * Alpha weight the bake gives its glare halo (`color.ba += glow * 0.75`).
 * The screen-space halo inherits it so the hand-off changes the halo's
 * SHAPE (non-terminating) and not its overall level.
 *
 * @private
 */
const SOLAR_HALO_AMPLITUDE = 0.75;

/**
 * Half-amplitude radius of the screen-space halo, in SOLAR RADII.
 *
 * Derived, not dialled: it is {@link SOLAR_GLARE_CORE} pushed through the
 * bake's own radius→solar-radii map, so the screen-space curve and the baked
 * curve are the same curve. At the default `glowFactor = 1` it is
 * `0.275 * sqrt(2) * 11 = 4.27800 R_sun`, i.e. 1.1397 deg — the halo is at
 * half strength a bit over one degree from the Sun.
 *
 * @param {number} glowLengthTS `glowFactor * 5`, as both bakes compute it.
 * @returns {number} Half-amplitude radius in solar radii.
 * @private
 */
function solarHaloCoreRadii(glowLengthTS) {
  return solarBakeRadiusToSolarRadii(SOLAR_GLARE_CORE, glowLengthTS);
}

/**
 * C12-18 screen-space veiling-glare profile — the REFERENCE IMPLEMENTATION of
 * the shader math. `SolarHalo.glsl` and `SolarHalo.wgsl` are line-for-line
 * translations of this body and `solar-sun-halo-model.spec.mjs` extracts,
 * compiles and compares all three.
 *
 *   veil(rho) = 1 / (1 + (rho / core)^2)
 *
 * NO pedestal subtraction and NO support clamp, unlike
 * {@link solarGlareProfile}. That is the entire point of moving the halo off
 * the billboard: the profile decays as `1/rho^2` forever instead of being
 * truncated at the quad's inscribed circle. Measured difference against the
 * baked profile at `glowFactor = 1` (in ALPHA units, i.e. x0.75):
 *
 *   rho (R_sun) | baked  | screen | delta alpha | 8-bit codes
 *   ------------+--------+--------+-------------+------------
 *          0.0  | 1.0000 | 1.0000 |     0.0000  |   0.0
 *          1.0  | 0.9404 | 0.9482 |     0.0059  |   1.5
 *          4.28 | 0.4244 | 0.5000 |     0.0567  |  14.5
 *          8.56 | 0.0790 | 0.2000 |     0.0908  |  23.1
 *         11.0  | 0.0000 | 0.1314 |     0.0985  |  25.1   <- worst case
 *         20.0  | 0.0000 | 0.0438 |     0.0328  |   8.4
 *         50.0  | 0.0000 | 0.0073 |     0.0055  |   1.4
 *        100.0  | 0.0000 | 0.0018 |     0.0014  |   0.35  <- sub-LSB
 *
 * The worst-case brightening is therefore EXACTLY at the old support radius
 * (11 R_sun = 2.93 deg) and is 25/255; the halo stays above one 8-bit code
 * out to ~57 R_sun (15 deg) and falls below it beyond. Both facts are
 * pinned by the spec, because "non-terminating" must not be allowed to mean
 * "washes the whole sky".
 *
 * @param {number} rhoRsun Distance from the solar centre in solar radii.
 * @param {number} coreRsun {@link solarHaloCoreRadii}.
 * @returns {number} Veil weight in (0, 1]; 1.0 at the centre.
 * @private
 */
function solarScreenHaloProfile(rhoRsun, coreRsun) {
  const t = rhoRsun / coreRsun;
  return 1.0 / (1.0 + t * t);
}

// ─── C12-27 — ANGULAR parameterisation (star washout near the Sun) ─────────
//
// The deleted `enableStarBrightnessModulation` global dim was keyed to the
// SUN'S ELEVATION above the camera's local horizon, so it dimmed stars 180 deg
// away from the Sun just as hard as stars beside it, and it did nothing at all
// in orbit. What actually washes out stars near the Sun is veiling glare —
// light scattered inside the eye/optics — and that is a function of ANGULAR
// SEPARATION, which is what the constants below parameterise.
//
// NOT GATED BY `computeAtmosphericColumnFactor`, DELIBERATELY. The C12-29 S6
// star-brightness modulation is inert above the engine's 111 km scattering
// shell, by design: it models sky glow from the atmospheric COLUMN, and above
// the column there is no glow. Veiling glare is a DIFFERENT physical mechanism
// — scattering in the observer's eye and optics, which travel with the
// observer — so it must NOT inherit that gate. An astronaut looking 5 deg from
// the Sun sees no stars there; that is exactly the case the column factor
// switches off. (Stated here because this is the first question any auditor
// comparing the two terms will ask.)

/**
 * Lower and upper bounds of the angular band over which the Stiles-Holladay
 * inverse-square disability-glare law `L_veil = k * E / theta^2` (theta in
 * degrees) is the accepted description. Inside ~1 deg the point-source
 * idealisation breaks down against the source's own angular size; past
 * ~30 deg the CIE general equation's other terms take over. Recorded as
 * constants because {@link SOLAR_GLARE_ANGULAR_CORE} is DERIVED from them
 * rather than dialled.
 *
 * @private
 */
const SOLAR_GLARE_ANGULAR_VALID_MIN_DEG = 1.0;
const SOLAR_GLARE_ANGULAR_VALID_MAX_DEG = 30.0;

/**
 * Half-amplitude angle of the veiling-glare veil, in RADIANS.
 *
 * Derived, not tuned: it is the GEOMETRIC centre of the validity band above,
 * `sqrt(1 * 30) = 5.477225575 deg`. Anchoring there puts the curve's knee in
 * the middle of the decade where the inverse-square law is the accepted
 * description, so the whole of that band is carried by a genuine `1/theta^2`
 * tail rather than by the regularised core.
 *
 * WHY NOT THE SUN'S OWN ANGULAR RADIUS. A Lorentzian regularised at the
 * source's angular size (0.2664 deg, the figure `MoonPhaseAppearance` derives)
 * is the "pure" Stiles-Holladay reading, but it puts the veil at
 * `(0.2664/10)^2 = 7e-4` at 10 deg — three orders of magnitude below one 8-bit
 * code value, i.e. arithmetically inert everywhere it is supposed to act. The
 * observed washout is dominated by ocular/instrument stray light, whose
 * effective source size is the glare spread of the optics, not the disc. The
 * amplitude of that spread is an APPEARANCE parameter and is disclosed as one;
 * the SHAPE and the SUPPORT are not.
 *
 * @private
 */
const SOLAR_GLARE_ANGULAR_CORE =
  (Math.sqrt(
    SOLAR_GLARE_ANGULAR_VALID_MIN_DEG * SOLAR_GLARE_ANGULAR_VALID_MAX_DEG,
  ) *
    Math.PI) /
  180.0;

/**
 * Outer support of the angular veil, in radians — exactly 90 degrees.
 *
 * This is a GATE constant, not a photometric one. The C12-27 acceptance
 * criterion is "stars at >90 deg separation are byte-identical to the no-Sun
 * frame", so the curve is pedestal-subtracted to reach exactly 0.0 at
 * `PI/2` and every consumer additionally early-outs on `cos(theta) <= 0`,
 * which is the same half-space. The multiplier there is exactly 1.0, and
 * `x * 1.0 === x` for every finite IEEE-754 `x` — byte-identical, not close.
 *
 * A real veiling-glare PSF of course does not terminate at 90 deg; the
 * pedestal subtraction is the same honest bound C12-16 documents for the
 * finite billboard, applied to a finite acceptance criterion.
 *
 * @private
 */
const SOLAR_GLARE_ANGULAR_SUPPORT = Math.PI / 2.0;

/**
 * Value the raw angular Lorentzian takes at {@link SOLAR_GLARE_ANGULAR_SUPPORT}.
 *
 * @private
 */
const SOLAR_GLARE_ANGULAR_PEDESTAL = lorentzianPedestal(
  SOLAR_GLARE_ANGULAR_SUPPORT,
  SOLAR_GLARE_ANGULAR_CORE,
);

/**
 * C12-27 REFERENCE IMPLEMENTATION of the shader math — the JS twin of
 * `solarGlareVeil` in `StarField.wgsl`, `StarFieldVS.glsl`,
 * `CubeMapPanorama.wgsl` and `SkyBoxFS.glsl`. Written FLAT (rather than
 * delegating to {@link pedestalLorentzian}) so the four shader bodies are a
 * line-for-line translation of it and `solar-glare-star-washout.spec.mjs` can
 * extract, compile and compare them; the spec separately proves this flat form
 * and `pedestalLorentzian` agree, so "one curve" stays a measured fact.
 *
 * Takes the COSINE of the separation because that is what every consumer
 * already has — a dot product of two unit vectors in the star (TEME) frame —
 * and because `cos <= 0` is exactly the ">= 90 deg" half-space the gate needs.
 *
 * THREE REDUNDANT ZERO-GUARDS, DELIBERATELY. The `cos <= 0` early-out, the
 * `theta >= support` test and the lower clamp all return exact zero over the
 * same half-space at the shipped `support == PI/2`, so removing any ONE of
 * them leaves this function bit-identical (measured — see the "mutually
 * REDUNDANT" test in `solar-glare-star-washout.spec.mjs`, which also proves
 * the redundancy is CONDITIONAL: at a support below 90 deg the early-out alone
 * is not sufficient). Keep all three: the early-out is a real fast path that
 * skips an `acos` for half the sky, and the other two are what keep the
 * function correct if the support ever moves.
 *
 * @param {number} cosSeparation `dot(starDirection, sunDirection)`, both unit.
 * @param {number} core Half-amplitude angle in radians.
 * @param {number} pedestal Raw Lorentzian value at `support`.
 * @param {number} support Outer support angle in radians (must be <= PI/2 for
 *        the `cosSeparation <= 0` early-out to be exact).
 * @returns {number} Veil weight in [0, 1]; exactly 0 at and beyond `support`.
 * @private
 */
function angularGlareVeil(cosSeparation, core, pedestal, support) {
  if (cosSeparation <= 0.0) {
    return 0.0;
  }
  const theta = Math.acos(Math.min(cosSeparation, 1.0));
  if (theta >= support) {
    return 0.0;
  }
  const t = theta / core;
  const raw = 1.0 / (1.0 + t * t);
  const v = (raw - pedestal) / (1.0 - pedestal);
  return v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v;
}

/**
 * {@link angularGlareVeil} bound to the shipped constants.
 *
 * @param {number} cosSeparation `dot(starDirection, sunDirection)`, both unit.
 * @returns {number} Veil weight in [0, 1].
 * @private
 */
function solarAngularGlareVeil(cosSeparation) {
  return angularGlareVeil(
    cosSeparation,
    SOLAR_GLARE_ANGULAR_CORE,
    SOLAR_GLARE_ANGULAR_PEDESTAL,
    SOLAR_GLARE_ANGULAR_SUPPORT,
  );
}

/**
 * The multiplier every C12-27 consumer applies to star radiance.
 *
 * `1 - strength * veil`: exactly 1.0 (a byte-identical no-op) when the toggle
 * is off (`strength === 0`) or the star is at or beyond the support angle,
 * exactly `1 - strength` dead on the Sun.
 *
 * @param {number} cosSeparation `dot(starDirection, sunDirection)`, both unit.
 * @param {number} strength Washout strength; 0 disables, 1 fully extinguishes
 *        a star at zero separation.
 * @returns {number} Radiance multiplier in [1 - strength, 1].
 * @private
 */
function solarAngularGlareFactor(cosSeparation, strength) {
  return 1.0 - strength * solarAngularGlareVeil(cosSeparation);
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
  SOLAR_GLARE_ANGULAR_VALID_MIN_DEG,
  SOLAR_GLARE_ANGULAR_VALID_MAX_DEG,
  SOLAR_GLARE_ANGULAR_CORE,
  SOLAR_GLARE_ANGULAR_SUPPORT,
  SOLAR_GLARE_ANGULAR_PEDESTAL,
  SOLAR_DISC_BAKE_LENGTH_SCALAR,
  SOLAR_HALO_AMPLITUDE,
  lorentzianPedestal,
  pedestalLorentzian,
  solarLimbIntensity,
  solarGlareProfile,
  solarGlareProfileLegacy,
  solarBakeRadiusToSolarRadii,
  solarDiscBakeEdgeLegacy,
  solarDiscBakeEdge,
  solarHaloCoreRadii,
  solarScreenHaloProfile,
  angularGlareVeil,
  solarAngularGlareVeil,
  solarAngularGlareFactor,
});

export {
  SOLAR_LIMB_DARKENING_A0,
  SOLAR_LIMB_DARKENING_A1,
  SOLAR_LIMB_DARKENING_A2,
  SOLAR_GLARE_CORE,
  SOLAR_GLARE_SUPPORT,
  SOLAR_GLARE_PEDESTAL,
  SOLAR_GLARE_LEGACY_EDGE,
  SOLAR_GLARE_ANGULAR_VALID_MIN_DEG,
  SOLAR_GLARE_ANGULAR_VALID_MAX_DEG,
  SOLAR_GLARE_ANGULAR_CORE,
  SOLAR_GLARE_ANGULAR_SUPPORT,
  SOLAR_GLARE_ANGULAR_PEDESTAL,
  SOLAR_DISC_BAKE_LENGTH_SCALAR,
  SOLAR_HALO_AMPLITUDE,
  lorentzianPedestal,
  pedestalLorentzian,
  solarLimbIntensity,
  solarGlareProfile,
  solarGlareProfileLegacy,
  solarBakeRadiusToSolarRadii,
  solarDiscBakeEdgeLegacy,
  solarDiscBakeEdge,
  solarHaloCoreRadii,
  solarScreenHaloProfile,
  angularGlareVeil,
  solarAngularGlareVeil,
  solarAngularGlareFactor,
};
export default SolarDiscModel;
