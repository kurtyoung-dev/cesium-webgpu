// SolarDiscModel.js — C12-15 / C12-16 / C12-27. THE single source of truth for
// the solar-disc photometry constants and the radial profiles the sun-disc bake
// and the angular star washout are built from.
//
// References:
//   - A. Claret, "A new non-linear limb-darkening law for LTE stellar
//     atmosphere models", Astronomy and Astrophysics 363, 1081 (2000) — the
//     quadratic law I(mu)/I(1) = a0 + a1*mu + a2*mu^2 whose coefficients this
//     module publishes.
//   - Arthur Cox (ed.), "Allen's Astrophysical Quantities" (4th edition,
//     2000), section 14.7, for the solar values that law is evaluated with.
//   - CIE 135/1:1999, "Disability Glare", for the 1/theta^2 veiling-glare
//     falloff the screen halo profile is regularised from.
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
 * ─── PROVENANCE AND ACCURACY (CO-35, ruling R-2026-08-10-2) ───────────────
 *
 * These three numbers are not tuned and are not this fork's. They are the
 * PUBLISHED solar limb-darkening coefficients for lambda = 550 nm, in the
 * identical functional form `I(psi)/I(0) = sum a_k cos^k psi`:
 *
 *   [R1] Cox, A. N. (ed.), *Allen's Astrophysical Quantities*, 4th ed.,
 *        AIP Press / Springer, 2000 (ISBN 0-387-98746-0) — solar
 *        limb-darkening table; the 550 nm row is `(a0, a1, a2) =
 *        (0.30, 0.93, -0.23)` exactly as shipped here.
 *
 * Corroborated by an independent implementation of the same Allen table,
 * NASA SPDF's `AllenCurve.cpp` (AIM/SOFIE Level-2 solar source model), whose
 * `U`/`V` entries at 0.50 and 0.60 micron interpolate to `(a0, a1, a2) =
 * (0.30000, 0.90500, -0.20500)` at 550 nm — the same `a0` to five digits.
 *
 * Checked against two INDEPENDENT primary datasets, both published as 5th-
 * order polynomials in `mu` at lambda = 579.88 nm (same functional family,
 * three more terms), tabulated side by side in
 *
 *   [R2] Hestroffer, D. & Magnan, C., "Wavelength dependency of the Solar
 *        limb darkening", *Astron. Astrophys.* **333**, 338-342 (1998),
 *        Table 1 (coefficients) and Table 2 (power-law exponent vs. lambda),
 *        which reprints
 *   [R3] Pierce, A. K. & Slaughter, C. D., "Solar limb darkening",
 *        *Solar Physics* **51**, 25 (1977)  — `a0 = 0.30505`, and
 *   [R4] Neckel, H. & Labs, D., "On the wavelength dependency of solar limb
 *        darkening (ll 303 to 1099 nm)", *Solar Physics* **153**, 91 (1994)
 *        — `a0 = 0.28392`.
 *
 * THE SHIPPED `a0 = 0.30` IS BRACKETED BY THOSE TWO (0.28392 < 0.30 <
 * 0.30505). Over `r <= 0.9` — the range [R2] states the two datasets agree
 * over, and outside which a polynomial fit at the limb "is difficult to
 * achieve from a numerical as well as an observational point of view" — the
 * shipped law tracks [R3] to a maximum absolute deviation of **0.00498** and
 * [R4] to **0.00517** in units of disc-centre intensity (RMS 0.0025 /
 * 0.0033), after transporting each to 550 nm through [R2]'s own measured
 * exponent relation `alpha ~ -0.023 + 0.292 / lambda[um]`.
 *
 * At the §5 sample point `x = 0.95` the shipped law gives 0.567967 against a
 * transported [R3]/[R4] midpoint of 0.573377 — **-0.94%**. Every credible
 * reference at ~550 nm lands in [0.5537, 0.5940], and 0.567967 is inside it.
 *
 * WAVELENGTH CHOICE IS ALSO CHECKED, not assumed. Weighting [R2]'s
 * `alpha(lambda)` by the CIE 1931 photopic `V(lambda)` times a 5772 K Planck
 * disc-centre spectrum gives an effective wavelength of **555.7 nm** for this
 * quantity — 5.7 nm from the shipped 550 nm, worth **+0.63%** on
 * `I(0.95R)/I(0)`. 550 nm is the right band centre for a broadband visual
 * render to within a percent.
 *
 * WHY NOT A "BETTER" LAW. The full spread above is 4.6% at `x = 0.95`. At the
 * shipped disc radiance (2.0) the sample point renders at 8-bit code 242.3,
 * where one code is worth 0.0416 of linear radiance — so the ENTIRE available
 * accuracy improvement is **0.3 to 1.2 display codes out of 255**, i.e. at or
 * below the quantum the picture is delivered in. Adopting a 5th-order fit
 * would additionally replace one verbatim citable table entry AT THE RIGHT
 * WAVELENGTH with a hand-transported hybrid of two datasets published 30 nm
 * away. The law stands.
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

// ─── C12-19 — TRUE HDR SUN RADIANCE ────────────────────────────────────────
//
// TWO PREMISE CORRECTIONS, recorded here because the row's own text and the
// Batch-906 record both carry the older reading:
//
// (1) THE BAKE CLAMP IS NOT WHAT MASKS LIMB DARKENING. `SunTextureFS.glsl`
//     writes `rgb = (1, 1, surface + 0.2)` and `alpha = surface + 0.75*glow`,
//     and the C12-18 default hands the halo to the post-process chain, which
//     sets `bakeHaloGain = 0` and deletes the `0.75*glow` term. What is left
//     is `alpha = surface = limb(x)`, which NEVER reaches the clamp, so the
//     limb law composites straight through: over a dark sky the disc runs
//     255 codes at centre to 77 at the extreme limb on BOTH backends AT HEAD.
//     C12-18 was its own unmasking row. The clamp still binds on exactly one
//     channel at the default — BLUE, over the inner disc, where
//     `surface + 0.2 > 1` — and there it is doing real work: the `+0.2` is a
//     HUE term (it makes the halo orange and the core white), so "removing
//     the clamp" on blue turns the sun's core blue. It is a WHITE POINT, not
//     a radiance clamp.
//
// (2) REMOVING THE CLAMP FROM ALPHA IS UNSAFE. Since C11-115/C12-18 both
//     backends blend the sun ALPHA_BLEND, where alpha is the DESTINATION
//     weight: `dst = src.rgb*a + dst*(1 - a)`. An alpha above 1 makes
//     `1 - a` negative and SUBTRACTS the sky — a dark ring around the sun,
//     i.e. exactly the Batch-364 black-sky class this row's own warning
//     names. On the `sunBloom = false` path the legacy baked halo drives
//     alpha to ~1.9, so the ring would be strong. The alpha saturation is a
//     BLEND WEIGHT clamp and must stay.
//
// So the radiance that the single old `clamp(color, 0, 1)` conflated with
// chroma and coverage is delivered as an EXPLICIT SCALE, applied in the sun
// fragment shaders AFTER `czm_gammaCorrect` — i.e. in linear space, where a
// radiance belongs — and is exactly 1.0 whenever the scene is not HDR, so the
// SDR frame is `x * 1.0 === x` for every finite float rather than merely
// "close".

/**
 * Disc radiance in the SDR position: the multiplicative identity.
 *
 * Stated as a constant rather than an inline `1.0` because it is the whole
 * SDR-safety argument — under `highDynamicRange = false` the sun path is not
 * "retuned to look similar", it is arithmetically unchanged.
 *
 * @private
 */
const SOLAR_DISC_SDR_RADIANCE = 1.0;

/**
 * `startCompression` and the pre-compression `offset` from
 * `czm_pbrNeutralTonemapping` (Shaders/Builtin/Functions/
 * pbrNeutralTonemapping.glsl), the DEFAULT tonemapper on both backends
 * (`PostProcessStageCollection` sets `Tonemapper.PBR_NEUTRAL`;
 * `WebGPUPostProcessStageCollection` maps to `TonemapMode.PBR_NEUTRAL`).
 *
 * Mirrored, not re-invented: `sun-hdr-radiance.spec.mjs` extracts both
 * literals from the GLSL and fails if they drift from these.
 *
 * @private
 */
const PBR_NEUTRAL_START_COMPRESSION = 0.8 - 0.04;
const PBR_NEUTRAL_OFFSET = 0.04;

/**
 * `czm_pbrNeutralTonemapping` restricted to NEUTRAL GREY inputs
 * (`r === g === b`), which is what the solar disc is — the bake's rgb is
 * `(1, 1, <=1)` and the disc core is white.
 *
 * On a neutral input the operator's `x = min(...)` and `peak = max(...)` are
 * the same number and the desaturating `mix` is an identity, so the whole
 * body collapses to the scalar below. That collapse is what makes the
 * limb-contrast solve closed enough to bisect on; the spec proves it agrees
 * with the full vector body of the GLSL over a dense sweep, so this is a
 * restriction rather than a second implementation.
 *
 * @param {number} v Linear radiance of a neutral grey.
 * @returns {number} Tonemapped value in [0, 1).
 * @private
 */
function pbrNeutralNeutralGrey(v) {
  const x = v < 0.0 ? 0.0 : v;
  const offset = x < 0.08 ? x - 6.25 * x * x : PBR_NEUTRAL_OFFSET;
  const peak = x - offset;
  if (peak < PBR_NEUTRAL_START_COMPRESSION) {
    return peak;
  }
  const d = 1.0 - PBR_NEUTRAL_START_COMPRESSION;
  return 1.0 - (d * d) / (peak + d - PBR_NEUTRAL_START_COMPRESSION);
}

/**
 * The 8-bit code a neutral linear radiance lands on after the default
 * tonemapper and `czm_inverseGamma` (`pow(color, 1/czm_gamma)`), at
 * `exposure = 1` (the shipped default of every tonemap stage).
 *
 * @param {number} linearRadiance Scene-linear radiance.
 * @param {number} [gamma=2.2] `scene.gamma`.
 * @returns {number} Display code in [0, 255].
 * @private
 */
function solarDiscDisplayCode(linearRadiance, gamma) {
  const g = gamma > 0.0 ? gamma : 2.2;
  const t = pbrNeutralNeutralGrey(linearRadiance);
  return 255.0 * Math.pow(t > 0.0 ? t : 0.0, 1.0 / g);
}

/**
 * Display-code difference between the disc CENTRE and the extreme LIMB at a
 * given disc radiance — i.e. how much of the C12-15 limb-darkening law
 * survives the display transform.
 *
 * The composited disc is `L * limb(x)` (the bake carries `limb` in alpha and
 * ALPHA_BLEND multiplies by it), so centre and limb are `L` and `a0 * L`.
 *
 * @param {number} linearRadiance Disc-centre radiance `L`.
 * @param {number} [gamma=2.2] `scene.gamma`.
 * @returns {number} Codes of contrast; 0 when the two saturate together.
 * @private
 */
function solarDiscLimbContrastCodes(linearRadiance, gamma) {
  return (
    solarDiscDisplayCode(linearRadiance, gamma) -
    solarDiscDisplayCode(SOLAR_LIMB_DARKENING_A0 * linearRadiance, gamma)
  );
}

/**
 * The limb-darkening law's UNDISTORTED contrast: what a pure display
 * transform (gamma only, no tone curve) would show for a disc whose centre
 * sits exactly at display white. `255 * (1 - a0^(1/gamma))` = 107.47 codes at
 * the shipped `a0 = 0.30`, `gamma = 2.2`.
 *
 * This is the yardstick the ceiling below is measured against.
 *
 * @private
 */
const SOLAR_DISC_LIMB_CONTRAST_IDEAL =
  255.0 * (1.0 - Math.pow(SOLAR_LIMB_DARKENING_A0, 1.0 / 2.2));

/**
 * Fraction of {@link SOLAR_DISC_LIMB_CONTRAST_IDEAL} the disc must retain.
 *
 * One half — the half-power point of the limb-darkening SIGNAL. Chosen as the
 * one fraction that needs no justification of its own: at the half-power point
 * the tone curve has taken exactly as much of the law as it has left.
 *
 * @private
 */
const SOLAR_DISC_LIMB_CONTRAST_FRACTION = 0.5;

/**
 * THE CEILING THIS ROW EXISTS TO NAME: the largest disc radiance at which more
 * than half of the limb-darkening law survives the default display transform.
 *
 * ⚠ RAISING THE SUN'S RADIANCE **DESTROYS** LIMB DARKENING; IT DOES NOT
 * UNMASK IT. PBR Neutral compresses everything above `startCompression` toward
 * a single white, so the centre and the limb converge as `L` grows. Measured
 * with the functions above (gamma 2.2, exposure 1, over a dark sky):
 *
 *   L      | centre code | limb code | contrast | fraction of ideal
 *   -------+-------------+-----------+----------+------------------
 *     1.0  |    239.24   |   138.24  |  101.01  |  0.940
 *     2.0  |    250.31   |   195.92  |   54.39  |  0.506
 *     3.0  |    252.25   |   234.37  |   17.88  |  0.166
 *     5.0  |    253.49   |   247.77  |    5.72  |  0.053
 *    10.0  |    254.29   |   252.25  |    2.05  |  0.019
 *   100.0  |    254.93   |   254.77  |    0.16  |  0.001
 *
 * i.e. the "~10^5 energy" the row's warning contemplates would render the
 * solar disc a flat white circle with the C12-15 law arithmetically invisible
 * — the inverse of the Batch-364 failure by a different route.
 *
 * Solved by bisection over `[1, 64]` with a FIXED 200-iteration budget (the
 * function is strictly decreasing in `L` over that interval, and a fixed trip
 * count is what keeps this a bounded loop at module scope). The result is
 * 2.0148, and the reason that number is not the shipped default is the next
 * constant.
 *
 * @private
 */
const SOLAR_DISC_RADIANCE_CONTRAST_CEILING = (() => {
  const target =
    SOLAR_DISC_LIMB_CONTRAST_FRACTION * SOLAR_DISC_LIMB_CONTRAST_IDEAL;
  let lo = 1.0;
  let hi = 64.0;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (solarDiscLimbContrastCodes(mid, 2.2) > target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
})();

/**
 * Hard upper bound on the disc radiance, from the HDR framebuffer's own
 * format rather than from taste.
 *
 * The scene buffer is `rgba16float` (`PixelDatatype.HALF_FLOAT`), whose
 * largest finite value is 65504. The brightest pixel the sun path can produce
 * is the disc (`L`) plus the C12-18 screen halo at its centre
 * (`SOLAR_HALO_AMPLITUDE * L`) plus the sun bloom's additive contribution,
 * which `BrightPass.glsl` bounds by 1 (`b / (offset + b) < 1`). Requiring that
 * sum to stay two stops below the format's ceiling — headroom for the
 * Gaussian blur's weighted sums and for fp16 rounding — gives
 *
 *   (1 + SOLAR_HALO_AMPLITUDE) * L + 1 <= 65504 / 4
 *
 * i.e. L <= 9357.1. It never binds at any default; it exists so that an app
 * which sets `scene.light.intensity` to something enormous gets a bright sun
 * rather than an `Inf` that propagates NaN through every downstream stage.
 *
 * @private
 */
const SOLAR_DISC_RADIANCE_FP16_CEILING =
  (65504.0 / 4.0 - 1.0) / (1.0 + SOLAR_HALO_AMPLITUDE);

/**
 * The disc's linear radiance for this frame.
 *
 * DERIVED FROM THE ENGINE'S OWN STATEMENT OF SOLAR RADIANCE, not dialled.
 * `UniformState.updateFrameState` builds `czm_lightColorHdr` as
 * `light.color * light.intensity` and then publishes `czm_lightColor` as that
 * value renormalised so its brightest channel is <= 1. Every PBR surface in
 * the scene is already lit by the HDR one and shaded by the LDR one; the two
 * differ by exactly this factor. The disc that EMITS `czm_lightColorHdr` must
 * HAVE `czm_lightColorHdr` — anything else asserts that the sun is dimmer
 * than the light it casts.
 *
 * At the shipped defaults (`SunLight`, white, `intensity = 2.0`) that is
 * **2.0**, which lands within 0.74% of
 * {@link SOLAR_DISC_RADIANCE_CONTRAST_CEILING} (2.0148) — two derivations
 * with nothing in common agreeing on the same number, which is the reason
 * this row ships a radiance of 2 and not of 10^5. The engine's own light
 * intensity is, to within a percent, the largest radiance at which the
 * C12-15 limb law still survives the default tonemapper.
 *
 * EXPLICITLY NOT the eclipse-dimmed light. `UniformState` applies
 * `eclipseSceneLightFactor` to BOTH `_lightColorHdr` and `_lightColor` after
 * the renormalisation, so their RATIO — this function's value — is invariant
 * to the eclipse. That is required, not incidental: `Sun.update` already
 * scales the billboard's ALPHA by `sunEclipseAlpha`, and a radiance that also
 * dimmed would SQUARE the fade, the same failure `SunHaloAppearance`'s header
 * records for the halo.
 *
 * @param {boolean} useHdr `frameState.useHDR` — whether the scene renders
 *        into a float framebuffer at all.
 * @param {object} [light] `frameState.light`.
 * @returns {number} Linear radiance; EXACTLY 1.0 whenever the scene is SDR.
 * @private
 */
function solarDiscHdrRadiance(useHdr, light) {
  if (useHdr !== true) {
    return SOLAR_DISC_SDR_RADIANCE;
  }
  const intensity = light?.intensity;
  const color = light?.color;
  if (!(intensity > 0.0)) {
    return SOLAR_DISC_SDR_RADIANCE;
  }
  const peak = Math.max(
    color?.red ?? 1.0,
    Math.max(color?.green ?? 1.0, color?.blue ?? 1.0),
  );
  const radiance = intensity * (peak > 0.0 ? peak : 1.0);
  if (!(radiance > SOLAR_DISC_SDR_RADIANCE)) {
    // A light dimmer than white must not make the DISC dimmer than the SDR
    // picture — that would be an appearance regression dressed as physics.
    return SOLAR_DISC_SDR_RADIANCE;
  }
  return Math.min(radiance, SOLAR_DISC_RADIANCE_FP16_CEILING);
}

// ─── C12-19 — BRIGHT-PASS RETUNE (WebGL sun bloom) ─────────────────────────
//
// `SunPostProcess` stage 1 is `BrightPass.glsl`, the ONLY consumer of that
// shader in the engine. (The file named `BrightPass.wgsl` on the WebGPU side
// is a port of `ContrastBias.glsl` — the global `scene.bloom` stage, default
// OFF on both backends — and is NOT this curve.) Its three uniforms were
// tuned against an input that could not exceed 1, which is no longer true
// once the disc carries HDR radiance.

/**
 * `avgLuminance` as `SunPostProcess` has always set it — "a guess at the
 * average luminance across the entire scene". Unchanged by this row: it is
 * the argument to `key()`, which is a scene-exposure heuristic, not a
 * bright-pass parameter.
 *
 * @private
 */
const SUN_BRIGHT_PASS_AVG_LUMINANCE = 0.5;

/**
 * The historical `threshold` / `offset` pair, kept so the SDR position is
 * reproducible from this module rather than re-typed at the call site.
 *
 * @private
 */
const SUN_BRIGHT_PASS_THRESHOLD_LEGACY = 0.25;
const SUN_BRIGHT_PASS_OFFSET_LEGACY = 0.1;

/**
 * JS twin of `key()` in `BrightPass.glsl`.
 *
 * @param {number} avg Average scene luminance.
 * @returns {number} The key value the shader scales luminance by.
 * @private
 */
function sunBrightPassKey(avg) {
  return Math.max(0.0, 1.5 - 1.5 / (avg * 0.1 + 1.0)) + 0.1;
}

/**
 * C12-19 bright-pass tuning, DERIVED from the disc radiance.
 *
 * `BrightPass.glsl` computes
 *
 *   scaled = key(avg) * luminance / avg          (a pure scale, s = key/avg)
 *   bright = max(scaled - threshold, 0)
 *   out    = bright / (offset + bright)
 *
 * so `threshold` names the luminance at which extraction STARTS and
 * `threshold + offset` names the luminance at which it reaches one half. Two
 * derivations, no free parameters:
 *
 *   * START AT DISPLAY WHITE. `threshold = s * 1.0`. The shipped 0.25 starts
 *     at luminance 0.7292 — BELOW white — so an ordinary bright sky was
 *     already blooming. Under SDR that is merely the shipped look; under HDR,
 *     where the scene legitimately contains values at and above 1, it washes
 *     the frame. (`s = key(0.5)/0.5 = 0.342857`, so `threshold = 0.342857`.)
 *
 *   * HALF-SATURATE AT THE GEOMETRIC MEAN OF THE RANGE. The curve must span
 *     `[1, L]`; the value that splits a multiplicative range in half is
 *     `sqrt(L)`, so `offset = s * (sqrt(L) - 1)`. That places `out = 0.5`
 *     exactly at `luminance = sqrt(L)` and `out = 1/sqrt(2)` exactly at
 *     `luminance = L`, both checkable identities rather than measurements.
 *     At the shipped `L = 2`: `offset = 0.142016`, half-saturation at 1.4142.
 *
 * With the shipped pair the sun's own range is FLAT: 0.4815 at white against
 * 0.8133 at L = 2, i.e. two thirds of the extraction is spent below display
 * white and the sun itself moves the output by only 0.33. The derived pair
 * spends the whole range on the sun.
 *
 * `L <= 1` returns the historical pair BIT-FOR-BIT — both because that is the
 * SDR identity position and because `offset` would otherwise be 0, which
 * turns the final divide into a hard step at the threshold.
 *
 * @param {number} linearRadiance {@link solarDiscHdrRadiance}.
 * @param {number} [avgLuminance] The stage's `avgLuminance` uniform.
 * @param {object} [result] Optional object to fill.
 * @returns {object} `{ threshold, offset }`.
 * @private
 */
function solarBrightPassTuning(linearRadiance, avgLuminance, result) {
  const out = result ?? { threshold: 0.0, offset: 0.0 };
  if (!(linearRadiance > SOLAR_DISC_SDR_RADIANCE)) {
    out.threshold = SUN_BRIGHT_PASS_THRESHOLD_LEGACY;
    out.offset = SUN_BRIGHT_PASS_OFFSET_LEGACY;
    return out;
  }
  const avg = avgLuminance > 0.0 ? avgLuminance : SUN_BRIGHT_PASS_AVG_LUMINANCE;
  const s = sunBrightPassKey(avg) / avg;
  out.threshold = s;
  out.offset = s * (Math.sqrt(linearRadiance) - 1.0);
  return out;
}

// ─── The sun-bloom chain's shape, shared by both backends ──────────────────
//
// `SunPostProcess` (WebGL) and `WebGPUSunBloomEffect` draw the same glow from
// the same numbers. The constants below are that glow's shape; the WebGL
// pipeline states them as stage options and instance fields, and
// `Tools/visual-regression/webgpu-sun-bloom-mirror.spec.mjs` parses the shipped
// `SunPostProcess.js` text and fails if any of them drifts from the value here.
// A second set of literals in the WebGPU effect is the failure this section
// exists to make impossible.

/**
 * Fraction of the drawing buffer the bright pass and the two blur passes run
 * at. The blur's screen-space footprint is `sigma` texels of this buffer, so
 * the pair `(scale, sigma)` — not `sigma` alone — is what sets the glow's
 * radius in pixels.
 *
 * @private
 */
const SUN_BLOOM_TEXTURE_SCALE = 0.125;

/**
 * The blur buffer is forced square, at the next power of two of the smaller
 * scaled dimension. That is not a rounding convenience: the shipped blur feeds
 * one `step` uniform to both directions (`step.x = step.y = 1 / width`), which
 * only describes an isotropic kernel while the buffer's texels are square.
 *
 * @param {number} width Drawing-buffer width in pixels.
 * @param {number} height Drawing-buffer height in pixels.
 * @returns {number} Edge length of the square blur buffer, in texels.
 * @private
 */
function solarBloomBlurBufferSize(width, height) {
  const scaled = Math.min(
    Math.ceil(width * SUN_BLOOM_TEXTURE_SCALE),
    Math.ceil(height * SUN_BLOOM_TEXTURE_SCALE),
  );
  if (!(scaled > 1)) {
    return 1;
  }
  return Math.pow(2, Math.ceil(Math.log2(scaled)));
}

/**
 * Incremental-Gaussian parameters of the two blur passes, in texels of the
 * buffer {@link solarBloomBlurBufferSize} sizes.
 *
 * @private
 */
const SUN_BLOOM_BLUR_DELTA = 1.0;
const SUN_BLOOM_BLUR_SIGMA = 2.0;

/**
 * The glow's composite footprint, in solar radii.
 *
 * `SUN_BLOOM_SIZE_RADII` is the box the bright pass is restricted to, measured
 * in solar radii across; `SUN_BLOOM_COMPOSITE_RADIUS_FRACTION` turns that box
 * into the radius the additive composite fades over. Their product is the only
 * form either backend uses, so it is exposed as a function rather than as two
 * numbers to be multiplied again at each call site.
 *
 * @private
 */
const SUN_BLOOM_SIZE_RADII = 30.0 * 2.0;
const SUN_BLOOM_COMPOSITE_RADIUS_FRACTION = 0.15;

/**
 * Radius, in drawing-buffer pixels, over which the additive composite fades the
 * glow out. The composite adds in full inside `0.5 x` this radius and adds
 * nothing outside `0.8 x` it, so this is what bounds the glow's support.
 *
 * @param {number} limbPx Pixels per solar radius (`SunHaloAppearance.limbPx`).
 * @returns {number} The composite radius in pixels; 0 for degenerate input,
 *          which makes the composite add nothing rather than divide by zero.
 * @private
 */
function solarBloomCompositeRadiusPx(limbPx) {
  if (!(limbPx > 0.0)) {
    return 0.0;
  }
  return limbPx * SUN_BLOOM_SIZE_RADII * SUN_BLOOM_COMPOSITE_RADIUS_FRACTION;
}

/**
 * The glow's amplitude at the disc centre, in the same linear units the disc
 * and the screen halo are measured in.
 *
 * This is the number that answers "does the glow double-count the halo". It is
 * {@link solarBrightPassTuning}'s own half-saturation identity read at the
 * disc: the derived `offset` places `out = 1/sqrt(2)` exactly at
 * `luminance = discRadiance`, so the glow contributes `1/sqrt(2)` there for
 * EVERY radiance while the disc contributes `discRadiance` and the halo
 * contributes `SOLAR_HALO_AMPLITUDE * discRadiance`. The glow is the only one
 * of the three that does not scale with radiance — the bright pass is a
 * saturating rational bounded by 1 — so its share of the composite falls as
 * the sun brightens and no renormalisation constant is needed to keep it
 * bounded.
 *
 * @param {number} linearRadiance {@link solarDiscHdrRadiance}.
 * @returns {number} Linear radiance the glow adds at the disc centre.
 * @private
 */
function solarBloomCentreAmplitude(linearRadiance) {
  const tuning = solarBrightPassTuning(
    linearRadiance,
    SUN_BRIGHT_PASS_AVG_LUMINANCE,
  );
  const scaled =
    (sunBrightPassKey(SUN_BRIGHT_PASS_AVG_LUMINANCE) * linearRadiance) /
    SUN_BRIGHT_PASS_AVG_LUMINANCE;
  const bright = Math.max(scaled - tuning.threshold, 0.0);
  return bright / (tuning.offset + bright);
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
  SOLAR_DISC_SDR_RADIANCE,
  PBR_NEUTRAL_START_COMPRESSION,
  PBR_NEUTRAL_OFFSET,
  SOLAR_DISC_LIMB_CONTRAST_IDEAL,
  SOLAR_DISC_LIMB_CONTRAST_FRACTION,
  SOLAR_DISC_RADIANCE_CONTRAST_CEILING,
  SOLAR_DISC_RADIANCE_FP16_CEILING,
  SUN_BRIGHT_PASS_AVG_LUMINANCE,
  SUN_BRIGHT_PASS_THRESHOLD_LEGACY,
  SUN_BRIGHT_PASS_OFFSET_LEGACY,
  SUN_BLOOM_TEXTURE_SCALE,
  SUN_BLOOM_BLUR_DELTA,
  SUN_BLOOM_BLUR_SIGMA,
  SUN_BLOOM_SIZE_RADII,
  SUN_BLOOM_COMPOSITE_RADIUS_FRACTION,
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
  pbrNeutralNeutralGrey,
  solarDiscDisplayCode,
  solarDiscLimbContrastCodes,
  solarDiscHdrRadiance,
  sunBrightPassKey,
  solarBrightPassTuning,
  solarBloomBlurBufferSize,
  solarBloomCompositeRadiusPx,
  solarBloomCentreAmplitude,
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
  SOLAR_DISC_SDR_RADIANCE,
  PBR_NEUTRAL_START_COMPRESSION,
  PBR_NEUTRAL_OFFSET,
  SOLAR_DISC_LIMB_CONTRAST_IDEAL,
  SOLAR_DISC_LIMB_CONTRAST_FRACTION,
  SOLAR_DISC_RADIANCE_CONTRAST_CEILING,
  SOLAR_DISC_RADIANCE_FP16_CEILING,
  SUN_BRIGHT_PASS_AVG_LUMINANCE,
  SUN_BRIGHT_PASS_THRESHOLD_LEGACY,
  SUN_BRIGHT_PASS_OFFSET_LEGACY,
  SUN_BLOOM_TEXTURE_SCALE,
  SUN_BLOOM_BLUR_DELTA,
  SUN_BLOOM_BLUR_SIGMA,
  SUN_BLOOM_SIZE_RADII,
  SUN_BLOOM_COMPOSITE_RADIUS_FRACTION,
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
  pbrNeutralNeutralGrey,
  solarDiscDisplayCode,
  solarDiscLimbContrastCodes,
  solarDiscHdrRadiance,
  sunBrightPassKey,
  solarBrightPassTuning,
  solarBloomBlurBufferSize,
  solarBloomCompositeRadiusPx,
  solarBloomCentreAmplitude,
  angularGlareVeil,
  solarAngularGlareVeil,
  solarAngularGlareFactor,
};
export default SolarDiscModel;
