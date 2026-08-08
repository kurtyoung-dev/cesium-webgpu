// celestial-g4-gate.mjs — pure metrics + verdict logic for the Campaign-12
// **G4** gate ("Sun + Moon"): the solar disc's angular size and limb-darkening
// profile, the C12-18 screen-space halo, the C12-28 SDR display policy, and the
// moon half — C12-21 phase-dependent earthshine and C12-22 soft terminator,
// whose owed Edge acceptance IS this lane's first run.
//
// WHAT G4 IS
// ----------
// `QUEUE_2026-07-19_CAMPAIGN12.md` §5:
//
//   G4 | Sun + Moon | Sun: `r_1e-3/r_core >= 10`; angular diameter within 5% of
//   0.5334 deg; `I(0.95R)/I(0)` in [0.3,0.5]. Moon: full:quarter
//   integrated-brightness ratio must exceed the Lambertian ~3:1.
//
// and W4's gate row adds "plus the `C12-28` check: byte-identical behaviour on
// SDR displays". The `r_1e-3/r_core` figure is the STAR PSF and is already
// bound by G2 (`celestial-g2-gate.mjs`, ruling `C12-G2-DEF`); it is not
// re-measured here on the SUN, whose profile is a limb-darkened disc plus a
// veiling-glare halo rather than a point spread function. What G4 owns on the
// sun side is the disc — its SIZE and its RADIAL LAW — and the halo the
// C12-18 batch moved off the billboard.
//
// ─── THE LANDED CONTENT THIS BINDS ─────────────────────────────────────────
//
//   C12-15  limb darkening        `SolarDiscModel.solarLimbIntensity`
//   C12-16  inverse-square glare   `SolarDiscModel.solarGlareProfile`
//   C12-17  WebGPU sun-texture format parity (the CPU bake's rgba16float leg)
//   C12-18  true-size disc + PP-chain halo + ALPHA_BLEND (Batch 906)
//   C12-28  HDR default on HDR-capable displays (Batch group CO-22)
//   C12-21  phase-dependent earthshine   (landed Batch 858, Edge acceptance OWED)
//   C12-22  soft terminator              (landed Batch 858, Edge acceptance OWED)
//   C12-30  moon-in-atmosphere appearance (caveat: this lane frames the moon
//           from ORBIT with the sky atmosphere OFF, so the C12-30 sky-wash and
//           extinction terms are identity here BY CONSTRUCTION and G4 makes no
//           claim about them — that is `probe-moon-atmosphere-appearance.mjs`)
//   C12-33  (caveat) the albedo/normal-map asset chain is not re-certified here
//
// ─── THE C12-19 ARM, AND WHAT RULING R-2026-08-10-2 CHANGED ────────────────
//
// `C12-19` (true HDR sun radiance) removes the `clamp(..., 0, 1)` from both sun
// bakes. It LANDED at Batch 937, and the arm below still self-activates from
// two independent live discriminators (the bake's source text and the measured
// peak radiance) with a DISAGREEMENT between them reported as STRUCTURAL rather
// than resolved by preferring one — the reference-disagreement rule.
//
// What the arm then CERTIFIES ON changed. Batches 941-950 measured the §5
// ratio on the shipped leg with no differencing and read 0.651-0.718 against
// `[0.3, 0.5]`, and {@link expectedCompositeLimbRatio} put the reason on the
// record as a number: at the shipped defaults a camera sees the disc PLUS the
// C12-18 screen halo, and the halo is a near-flat pedestal over the disc that
// lifts the ratio toward 1. The §5 band was ratified for the DISC-ONLY law.
//
// Ruling R-2026-08-10-2 (2026-08-10) re-ratified it "via the disc-only
// measurement arm — conditional on first confirming the shipped physics is as
// accurate as possible while remaining performant". CO-35 discharged that
// condition (the shipped Cox 2000 / Allen 550 nm coefficients are bracketed by
// Pierce & Slaughter 1977 and Neckel & Labs 1994 and stand unchanged — see the
// PROVENANCE block in `Scene/SolarDiscModel.js`), so the certifying criterion
// is now `limb_discOnlyRatio_I095_over_I0_in_band`: the halo-free reading built
// from the lane's own two differentials, against the band
// {@link deriveDiscOnlyLimbBand} derives from the shipped law and the frame's
// own resolved radiance. The composite ratio is still measured and printed
// every run, and `[0.3, 0.5]` is still carried in the record as
// `measured.supersededBand`.
//
// What IS measurable pre-C12-19 is limb darkening's PRESENCE and SHAPE, via a
// differential the toggle makes exact: `enableSolarLimbDarkening = false`
// passes `(a0,a1,a2) = (1,0,0)`, i.e. `I == 1` everywhere, so
//
//     D1(r) = flat(r) - limb(r) = (1 - I(r/R)) * discContribution
//
// and the screen-space halo — a function of screen geometry alone, identical in
// both legs — CANCELS EXACTLY. Same trick G1 Lane B uses to cancel the
// sky-atmosphere shell out of its star-modulation measurement.
//
// ─── BOTH BACKENDS, IDENTICALLY ────────────────────────────────────────────
//
// Campaign principle 5. Every term G4 measures is resolved CPU-side and
// published on `frameState` before the backend branch (`SunDiscAppearance`,
// `SunHaloAppearance`, `MoonPhaseAppearance`), and the two shader twins are
// asserted character-identical by their own specs — so a one-backend pass is a
// FAIL, not a partial pass. {@link foldG4Verdict} names the backend in every
// failure string and additionally requires the headline scalars to AGREE
// across backends.

// ONE definition of the shipped display chain. The 8-bit inversion and the
// bracket's saturation code live in the G2 lib because the C12-02 bracket was
// built there first; G4 IMPORTS them rather than re-deriving, so the quantum
// this lane floors a bound with is by construction the quantum the composite it
// measures was stitched from.
import {
  BRACKET_SATURATION_CODE,
  DISPLAY_GAMMA,
  displayToLinear,
  pbrNeutralTonemap,
} from "./celestial-g2-gate.mjs";

// ---------------------------------------------------------------------------
// EXIT CONTRACT — the same one G1/G2/G3 use.
// ---------------------------------------------------------------------------

/** Verdict exit codes. */
export const EXIT_CODE = Object.freeze({
  PASS: 0,
  FAIL: 1,
  ERROR: 2,
  STRUCTURAL: 3,
});

/**
 * Names of content this lane binds criteria to that may not exist at the
 * commit under test. A pending arm reports the row BY NAME so a reader can
 * tell "not yet built" from "not measured".
 */
export const PENDING_CONTENT = Object.freeze({
  C12_19:
    "C12-19 (true HDR sun radiance — removes the clamp(...,0,1) from both sun bakes)",
});

/** Pending-arm states. Only `ACTIVE` produces a certifying criterion. */
export const ARM_STATE = Object.freeze({
  ACTIVE: "ACTIVE",
  PENDING_CONTENT: "STRUCTURAL-pending-content",
  UNDETERMINED: "STRUCTURAL-pending-content-undetermined",
  DISAGREEMENT: "STRUCTURAL-discriminator-disagreement",
  // G4-FIRSTRUN-FIX-4. The arm reads an ABSOLUTE radial profile off the disc
  // lane's own captures, so a disc lane that could not see its subject cannot
  // hand it a certifying number — the ratio is still measured and printed.
  PENDING_AIM: "STRUCTURAL-pending-aim",
  // R-2. The disc-only ratio divides by a disc radiance recovered from the
  // frame; if that recovery disagrees with the frame's own resolved radiance,
  // the quotient is not the quantity §5 names.
  RADIANCE_UNRECOVERED: "STRUCTURAL-disc-radiance-unrecovered",
  // R-2. The band is DERIVED per run from the shipped model and the frame's
  // appearance scalars. A bound that could not be derived certifies nothing.
  BAND_UNDERIVED: "STRUCTURAL-band-underived",
});

// ---------------------------------------------------------------------------
// SUN — DISC SIZE
// ---------------------------------------------------------------------------

/**
 * §5's nominal solar angular diameter, in degrees. RATIFIED — it is the
 * queue's own number and is not to be moved to clear a red.
 * @type {number}
 */
export const SOLAR_ANGULAR_DIAMETER_NOMINAL_DEG = 0.5334;

/**
 * §5's tolerance on the above: "within 5%". RATIFIED.
 * @type {number}
 */
export const SOLAR_ANGULAR_DIAMETER_TOLERANCE = 0.05;

/**
 * Tolerance against the EPHEMERIS diameter measured in the same frame
 * (`2 * asin(SOLAR_RADIUS / |camera - sun|)`), which is the honest reference:
 * the nominal 0.5334 deg is a mean and the real diameter breathes +/-1.7% over
 * a year with Earth's orbital eccentricity.
 *
 * DERIVED, not fitted: the disc edge is located from the outer support of a
 * radially-binned difference profile, i.e. to +/-0.5 px on a modelled 170 px
 * radius = 0.3%; `Sun.update` additionally rounds the billboard's pixel size up
 * (`Math.ceil`), worth <= 1/4994 = 0.02% at this framing. 3% is 10x the sum.
 * @type {number}
 */
export const DISC_EPHEMERIS_TOLERANCE = 0.03;

/**
 * The C12-18 / Batch-906 regression pin: the true-size disc edge is the legacy
 * edge times `SOLAR_DISC_BAKE_LENGTH_SCALAR = 2/sqrt(2)`.
 *
 * This is the whole content of the C12-18 disc fix expressed as a number a
 * PIXEL measurement can carry: the shipped bake compared a CORNER-normalised
 * radius against a HALF-EXTENT-normalised `radiusTS`, so the disc subtended
 * 1/sqrt(2) of the Sun's true angular radius. Toggling
 * `enableTrueSolarDiscSize` off restores the undersized edge bit-for-bit, so
 * the ratio of the two measured edge radii IS the fix.
 * @type {number}
 */
export const TRUE_SIZE_RATIO_NOMINAL = 2.0 / Math.sqrt(2.0);

/**
 * Tolerance on {@link TRUE_SIZE_RATIO_NOMINAL}.
 *
 * DERIVED: each edge radius carries +/-0.5 px of binning uncertainty, on
 * modelled radii of 170 px (true) and 120 px (legacy), so the ratio's
 * quantization bound is 0.5/170 + 0.5/120 = 1.4%. The bar is 5%, 3.5x that —
 * and a regression to a single edge (the defect this pins) reads 1.000, which
 * is 29% away.
 * @type {number}
 */
export const TRUE_SIZE_RATIO_TOLERANCE = 0.05;

/**
 * How far the D1 centroid may sit from the crop centre before the disc lane is
 * declared unable to see its subject.
 *
 * The camera is aimed AT the Sun, so the disc is centred BY CONSTRUCTION; the
 * centroid of a radially symmetric difference is its centre. 8 px on a
 * modelled 170 px radius is 4.7% — far too small to be a real aim, large
 * enough to absorb sub-pixel projection and the billboard's integer sizing.
 * @type {number}
 */
export const DISC_AIM_TOLERANCE_PX = 8;

/**
 * Radius, in pixels, the halo lane searches for its brightest pixel.
 *
 * ⚠ THIS IS THE INSTRUMENT'S DYNAMIC RANGE, NOT ITS BOUND. The certifying
 * bound stays {@link HALO_AIM_TOLERANCE_PX} = 6. The first G4 run
 * (Batch 941) reported `aimDistancePx = 11.7686` on WebGL against a search
 * radius of 12 — i.e. the search hit its own wall and the number was a FLOOR,
 * not a measurement, so the structural note could not say how far off the aim
 * actually was. A search radius must exceed the miss it is asked to REPORT by
 * enough that the reported number is a value; 64 px is 10.6x the certifying
 * tolerance, is 3.3 deg at the halo lane's default framing (19.35 px/deg), and
 * still lands INSIDE the 16 R_sun band edge at 81.5 px, so the search cannot
 * latch onto the halo band it is about to measure.
 * @type {number}
 */
export const HALO_AIM_SEARCH_RADIUS_PX = 64;

/**
 * Fraction of the peak difference at which the disc edge is declared.
 *
 * The disc terminates in a `step()`, so `D1` drops from `(1 - a0) * K = 0.7 K`
 * to exactly 0 across the antialiasing width. Half of the value measured just
 * inside the edge is the standard half-maximum edge locator and is invariant to
 * `K` — which matters, because `K` depends on the blend chain and this gate
 * does not model it.
 * @type {number}
 */
export const DISC_EDGE_FRACTION = 0.5;

// ---------------------------------------------------------------------------
// SUN — LIMB DARKENING (C12-15)
// ---------------------------------------------------------------------------

/**
 * Projected radius fractions `x = r / R` at which the differential limb profile
 * is sampled. 0.95 is §5's own probe point and is the normalisation anchor.
 * @type {readonly number[]}
 */
export const LIMB_SHAPE_SAMPLE_X = Object.freeze([0.3, 0.5, 0.7, 0.9, 0.95]);

/**
 * Maximum relative deviation between the measured, anchor-normalised `1 - I(x)`
 * profile and the one computed from the SHIPPED `solarLimbIntensity`.
 *
 * DERIVED: the steepest sample is x = 0.95, where `d(1-I)/dx = 2.4`; an annulus
 * bin is +/-0.5 px on a 170 px radius, i.e. `dx = 0.0029`, so binning
 * contributes 0.7% there and less everywhere else. The bar is 20% — ~10x the
 * modelled sampling error, because the measurement also rides the exposure
 * stitch and the display-chain inversion — and it still separates: a LINEAR
 * limb law (`1 - 0.7x`), the obvious wrong implementation, normalises to
 * [0.30, 0.50, 0.70, 0.90, 1.0] against the shipped
 * [0.051, 0.155, 0.355, 0.783, 1.0] and is rejected at four of five samples.
 *
 * ⚠ FIRST-PASS DERIVED. No Edge run has produced this profile yet.
 * @type {number}
 */
export const LIMB_SHAPE_MAX_REL_DEV = 0.2;

/**
 * The differential must VANISH at disc centre: `I(0) = 1` in both legs, so
 * `D1(0) = 0` exactly.
 *
 * DERIVED: at x <= 0.1 the true `1 - I(x)` is 0.0024, i.e. 0.55% of its value
 * at x = 0.95. The bar is 5% of the anchor — 9x the true value — so it is a
 * real assertion rather than a restatement of the model, and a mutant that
 * applies a CONSTANT dim to the whole disc (the "limb darkening implemented as
 * an overall multiplier" error) fails it outright.
 * @type {number}
 */
export const LIMB_CENTRE_MAX_RELATIVE = 0.05;

/**
 * The differential must vanish OUTSIDE the disc: the toggle changes the disc's
 * radiance law and nothing else, so beyond the edge both legs are identical.
 *
 * DERIVED: analytically exactly 0; 2% of the anchor is the quantization
 * allowance. This is what refuses a mutant that leaks the limb term into the
 * halo.
 * @type {number}
 */
export const LIMB_OUTSIDE_MAX_RELATIVE = 0.02;

/**
 * Radius, as a multiple of the measured disc radius, beyond which
 * {@link LIMB_OUTSIDE_MAX_RELATIVE} is evaluated. 1.2 clears the disc edge and
 * its antialiasing by 20% of a radius.
 * @type {number}
 */
export const LIMB_OUTSIDE_RADIUS_FACTOR = 1.2;

/**
 * Minimum number of pixels the limb differential must carry before the disc
 * lane will read a radius off it.
 *
 * A differential with NO signal is a FAILURE, not a blind lane, and the
 * distinction is load-bearing. The reference leg is a FLAT disc, which always
 * renders whenever the Sun is in frame at all, so `flat - limb == 0` everywhere
 * can only mean the limb term did nothing — which is precisely the defect
 * `C12-15` exists to prevent, and reporting it as STRUCTURAL would file the
 * headline defect under "could not see its subject".
 *
 * The lane still has an honest blindness case and keeps it separate:
 * {@link DISC_MIN_LIT_PIXELS} on the SHIPPED leg, which fails when the Sun is
 * not in frame at all.
 *
 * DERIVED: the differential is a filled ring covering `x` from ~0.1 to 1, i.e.
 * ~99% of a modelled 170 px disc, ~90,000 pixels. The bar is 1,000 — 1% of
 * that.
 * @type {number}
 */
export const DISC_MIN_DIFFERENTIAL_PIXELS = 1000;

/**
 * Minimum number of lit pixels the SHIPPED disc leg must carry. Below this the
 * Sun is not in frame and the lane is STRUCTURAL.
 *
 * DERIVED: a modelled 170 px disc is ~90,000 pixels, and the screen halo lights
 * essentially the whole crop besides. 1,000 is ~1% of the disc alone.
 * @type {number}
 */
export const DISC_MIN_LIT_PIXELS = 1000;

/**
 * Linear luminance above which a disc-lane pixel counts as lit. One 8-bit code
 * in linear light at exposure 1 is ~3.0e-4; this is 10x that, comfortably below
 * anything the disc or its halo produce.
 * @type {number}
 */
export const DISC_LIT_FLOOR = 3.0e-3;

/**
 * Minimum absolute linear-radiance drop at `x = 0.95` — the non-vacuity control
 * for the whole differential. A limb term that never moved a pixel produces a
 * shape test over noise, which is exactly the kind of vacuous green a gate must
 * refuse.
 *
 * DERIVED FROM QUANTIZATION, not from a run: one 8-bit code at exposure 1 is
 * ~3.0e-4 in linear light (the same bound G1's `SKY_FLOOR_ABS_TOLERANCE` uses).
 * The bar is 0.01 — 33x that — and roughly 1/40 of the modelled drop, which is
 * `(1 - I(0.95)) = 0.432` times a disc contribution of order 1. Deliberately
 * loose at the top end: the absolute scale depends on the ALPHA_BLEND chain
 * C12-18 landed, which this gate does not model.
 *
 * ⚠ FIRST-PASS DERIVED.
 * @type {number}
 */
export const LIMB_MIN_DROP_LINEAR = 0.01;

/**
 * §5's original absolute limb ratio band, `I(0.95R) / I(0)`.
 *
 * ⚠ SUPERSEDED as the certifying bound by maintainer ruling R-2026-08-10-2
 * (see {@link deriveDiscOnlyLimbBand}). PRESERVED, not deleted, because the
 * run record has to show what moved and because the bound is not WRONG — it is
 * ratified for the wrong SAMPLE POINT. `[0.3, 0.5]` is exactly the band the
 * EXTREME limb sits in: the shipped `I(R)/I(0) = a0 = 0.30`, Pierce & Slaughter
 * (1977) give 0.30505 and Neckel & Labs (1994) 0.28392. At `0.95R` no shipped
 * or published law can enter it — every credible reference lands in
 * [0.5537, 0.5940] — so the old arm was measuring a real quantity against a
 * bound derived for a different radius.
 *
 * Still reported on every arm state as `measured.supersededBand`.
 * @type {{lo:number,hi:number}}
 */
export const LIMB_ABSOLUTE_RATIO_BAND = Object.freeze({ lo: 0.3, hi: 0.5 });

/**
 * The `x` §5's absolute ratio is sampled at. RATIFIED with the band; it is the
 * `0.95R` in `I(0.95R)/I(0)` and is carried as a named constant only so
 * {@link expectedCompositeLimbRatio} evaluates the confound at the SAME point
 * the criterion reads.
 * @type {number}
 */
export const LIMB_ABSOLUTE_RATIO_SAMPLE_X = 0.95;

// ---------------------------------------------------------------------------
// SUN — THE DISC-ONLY LIMB RATIO (ruling R-2026-08-10-2, CO-35)
//
// §5's `I(0.95R)/I(0) in [0.3, 0.5]` was ratified for the DISC-ONLY radial
// law, and {@link expectedCompositeLimbRatio} put the reason it could never be
// met on the record as a number: what a camera sees at the shipped defaults is
// disc PLUS the C12-18 screen halo, and the halo is a near-flat pedestal
// across the disc (`P(0.95)/P(0) = 0.953`) that lifts the ratio toward 1.
// Batch 950 measured 0.7138 / 0.7181 against a modelled 0.7330.
//
// THE FIX IS A MEASUREMENT, NOT A MOVED BOUND. The disc lane already captures
// three legs, and TWO differentials between them are halo-free BY
// CONSTRUCTION, because every uniform the halo reads (`limbPx`,
// `haloCoreRadii`, `haloIntensity`, `haloCenter` in `SolarHalo.glsl` /
// `SolarHalo.wgsl`) is a function of camera geometry and the resolved
// radiance, and NONE of them reads `enableSolarLimbDarkening` or
// `enableTrueSolarDiscSize`:
//
//   D1 = flat - limb    = L * (1 - chain(I(x)))      halo cancels exactly
//   D2 = flat - legacy  = L                          on 1/sqrt(2) < x < 1
//
// D2's annulus is the disc's OWN radiance in the lane's measured linear units
// (both legs are FLAT discs, so the limb law is absent from both, and only the
// disc EDGE differs), which makes `(L - D1(x)) / L` the disc's radial law with
// no halo in it at all. That is the disc-only measurement this ruling asks
// for, and it needs no new capture.
//
// AND IT IS RADIANCE-INVARIANT. `L` divides out of the ratio, so — unlike the
// composite — the disc-only reading does not move when the disc's radiance
// moves. Radiance enters only through the display quantum in the tolerance.
// That is precisely why this is the measurement that tests the LAW.
// ---------------------------------------------------------------------------

/**
 * Rec.709 luma weights — the ONE definition this lane reduces an RGB triple
 * with. Exported because {@link solarDiscChainLuminance} models the same
 * reduction in closed form and the two must not drift; {@link luminanceAt}
 * reads this array, so there is no second literal.
 * @type {readonly number[]}
 */
export const LUMINANCE_WEIGHTS = Object.freeze([0.2126, 0.7152, 0.0722]);

/**
 * The `+0.2` in `SunTextureFS.glsl`'s `vec4 color = vec4(vec2(1.0), surface +
 * 0.2, surface)` and its WebGPU CPU twin — the bake's HUE term.
 *
 * ⚠ IT IS NOT INERT ON THE DISC. Both bakes write rgb `(1, 1, clamp(limb +
 * 0.2))`, `SunFS.glsl`/`SunFS.wgsl` decode that with `pow(rgb, gamma)` under
 * HDR, and the billboard is then weighted by its own alpha (`= limb`). Over
 * the inner disc `limb + 0.2 > 1` and the clamp makes blue equal to red and
 * green — the core is white — but at `x = 0.95` the shipped law puts `limb` at
 * 0.568, so blue lands at `0.768^2.2 = 0.5593` and the pixel's LUMA is
 * 0.9682x the disc's own radial law rather than 1.0x. Modelling it is what
 * makes the derived band a prediction of the SHIPPED CHAIN instead of a
 * prediction of the law with a 3.2% systematic left in.
 * @type {number}
 */
export const SUN_BAKE_BLUE_HUE_OFFSET = 0.2;

/**
 * `scene.gamma`'s shipped default, which `czm_gammaCorrect` raises the sun
 * bake's rgb to under HDR (`Scene.js` sets `this.gamma = 2.2`; the WebGPU twin
 * passes the same number as `u.gamma`).
 * @type {number}
 */
export const SUN_BAKE_GAMMA_NOMINAL = 2.2;

/**
 * Radial band, as a fraction of the measured disc radius, over which `D2 =
 * flat - legacy` is averaged to recover the disc's linear radiance `L`.
 *
 * DERIVED from the two edges it must sit between: the legacy disc terminates
 * at `1/sqrt(2) = 0.7071` R (that IS the C12-18 defect) and the true-size disc
 * at 1.0 R. On the lane's modelled 170 px radius, 0.78 clears the inner edge
 * by 12.4 px and 0.92 clears the outer by 13.6 px — each ~6x the +/-2 px the
 * antialiased edge occupies — while still enclosing ~21,600 px, enough that
 * the annulus mean's quantization error is 1.2% / sqrt(21600) = 0.008%.
 * @type {{lo:number,hi:number}}
 */
export const LIMB_DISC_ONLY_ANNULUS = Object.freeze({ lo: 0.78, hi: 0.92 });

/**
 * Radius in pixels of the tight centre disc `D1` is averaged over for the
 * disc-only ratio's DENOMINATOR.
 *
 * 2 px, matching the convention the composite diagnostic already uses and for
 * the same reason: aiming at a source puts it at NDC (0,0), which for an
 * even-sized crop is a pixel CORNER, so a radial profile's radius-0 bin is
 * EMPTY and reads NaN. Over 2 px of a 170 px disc the true law is 0.99997, so
 * the denominator is the disc centre to within 3e-5.
 * @type {number}
 */
export const LIMB_DISC_ONLY_CENTRE_RADIUS_PX = 2;

/**
 * Disc radius, in pixels, the band's tolerance terms are modelled at.
 *
 * The lane's own established framing figure — `DISC_EPHEMERIS_TOLERANCE`,
 * `TRUE_SIZE_RATIO_TOLERANCE` and `LIMB_SHAPE_MAX_REL_DEV` all derive against
 * "a modelled 170 px radius", which is what `G4_SUN_DISC_FOV_X_DEG = 2.0` over
 * a 1280 px crop puts a 0.5334 deg disc at. Callers that have the RUN's own
 * `discRadiusPx` should pass it; this is the fallback the ratified band is
 * quoted at.
 * @type {number}
 */
export const LIMB_BAND_MODEL_DISC_RADIUS_PX = 170;

/**
 * The disc lane's exposure bracket. ONE definition, imported by the probe, so
 * the exposures the band's quantization term is derived against are the
 * exposures the capture actually used.
 * @type {readonly number[]}
 */
export const DISC_BRACKET_EXPOSURES = Object.freeze([1, 0.125]);

/**
 * Factor by which the measured `D2` annulus plateau may differ from the
 * frame's RESOLVED `discRadiance` before the disc-only arm reports STRUCTURAL.
 *
 * DERIVED as an instrument check, not a product bound: the plateau is a mean
 * over ~21,600 px whose per-pixel quantum is 1.2% of its own value, i.e. an
 * expected agreement of ~0.01%, and the whole display-chain inversion is what
 * would have to be wrong for it to drift. 0.35 is ~4000x that expectation —
 * it cannot fire on measurement noise, only on a plateau that is not the
 * disc's radiance at all (a mis-located edge, a missing leg, or a halo that
 * failed to cancel). A miss is STRUCTURAL because the ratio's denominator
 * would then not be `L`, so the reading would not be of `I(0.95R)/I(0)`.
 * @type {number}
 */
export const LIMB_DISC_RADIANCE_RECOVERY_TOLERANCE = 0.35;

/**
 * Peak linear scene radiance above which the sun bake CANNOT be the shipped
 * SDR-clamped one — the second, pixel-side C12-19 discriminator.
 *
 * DERIVED from the two builds it has to separate. Pre-C12-19: the bake's
 * chroma is bounded by 1.0 (the final saturation) and the C12-18 screen halo
 * adds at most `SOLAR_HALO_AMPLITUDE = 0.75`, so nothing in that chain can
 * put more than 1.75 at the disc centre (measured 1.74999 on synthetics).
 * Post-C12-19 (landed Batch 937): the disc carries an explicit linear
 * `discRadiance`, DERIVED in `SolarDiscModel.solarDiscHdrRadiance` from the
 * engine's own light (`intensity * max(color)` = 2.0 at the shipped
 * defaults) — NOT the row's original ~1e5, which the C12-19 batch showed
 * would render C12-15 limb darkening arithmetically invisible (maintainer
 * tradeoff filed as C12-19-RADIANCE-VS-LIMB-CONTRAST-TRADEOFF). The bar is
 * the geometric mean of the two edges, sqrt(1.75 x 2.0) = 1.8708 — above
 * everything the clamped build can emit and below the shipped HDR minimum.
 * The margins are deliberately symmetric and THIN (~7% each side); a
 * disagreement between this and the source-text discriminator reports
 * STRUCTURAL, never a product verdict, so a thin miss costs a re-look, not a
 * false red. (This constant was 4.0 when the lane was authored against the
 * row's pre-landing radiance expectation, in a worktree parallel to the
 * C12-19 one; re-derived at landing against the SHIPPED radiance.)
 * @type {number}
 */
export const C12_19_HDR_PEAK_DISCRIMINATOR = Math.sqrt(1.75 * 2.0);

// ---------------------------------------------------------------------------
// SUN — SCREEN-SPACE HALO (C12-18)
// ---------------------------------------------------------------------------

/**
 * Solar radii at which `screenHalo(rho) - bakedHalo(rho)` is maximal.
 *
 * This is B906's own derivation and it is EXACT rather than fitted: the baked
 * profile is pedestal-subtracted to reach 0 at `SOLAR_GLARE_SUPPORT`, which
 * maps to the quad's inscribed circle at 11 R_sun; the screen profile is the
 * same Lorentzian WITHOUT the subtraction, so the difference rises up to the
 * support and decays past it. The peak therefore sits exactly on the old
 * support radius.
 * @type {number}
 */
export const HALO_DELTA_PEAK_NOMINAL_RSUN = 11.0;

/**
 * Tolerance on {@link HALO_DELTA_PEAK_NOMINAL_RSUN}.
 *
 * This bound is on a MODEL SWEEP over the shipped module, not on pixels — a
 * 0.02 R_sun pixel bound would need a 550 px halo peak, i.e. a 50 px solar
 * radius, which does not fit a crop alongside 30 R_sun of tail. The sweep step
 * is 0.005 R_sun, so 0.02 is 4 steps.
 * @type {number}
 */
export const HALO_DELTA_PEAK_TOLERANCE_RSUN = 0.02;

/**
 * Inner and outer radii, in solar radii, of the band in which the screen halo
 * is measured against the bake.
 *
 * DERIVED FROM THE BILLBOARD'S OWN GEOMETRY: the quad's half-extent is
 * `1 + 2*glowLengthTS = 11` solar limbs, so its CORNER — the furthest any baked
 * texel can reach — is at `sqrt(2) * 11 = 15.56` R_sun. Beyond 16 R_sun there
 * is no disc, no baked halo and no lens-flare burst, so whatever is measured
 * there came from the post-process chain. The outer bound is set by the crop:
 * 30 R_sun is 168 px at the default framing against a 320 px crop half-height.
 * @type {{inner:number,outer:number}}
 */
export const HALO_BAND_RSUN = Object.freeze({ inner: 16.0, outer: 30.0 });

/**
 * Radii, in solar radii, at which the halo's SHAPE is sampled. The first is the
 * normalisation anchor.
 * @type {readonly number[]}
 */
export const HALO_SHAPE_SAMPLE_RSUN = Object.freeze([16.0, 20.0, 25.0, 30.0]);

/**
 * Maximum relative deviation between the measured, anchor-normalised halo
 * profile and `solarScreenHaloProfile` evaluated at the SHIPPED core radius.
 *
 * DERIVED: at 30 R_sun the modelled halo radiance is `0.75 * 0.0199 = 0.0149`,
 * which the 8x bracket leg carries at ~code 90 (per-code resolution ~2%), and
 * each sample averages an annulus of hundreds of pixels. The bar is 25%, ~8x
 * the modelled uncertainty, and it still separates the two mutants that matter:
 * a GAUSSIAN halo of the same half-amplitude normalises to
 * [1, 0.19, 0.009, 0.0001] and is rejected at three samples; a TERMINATING
 * (pedestal-subtracted) halo is exactly 0 across the whole band and is rejected
 * by the presence criterion before the shape test runs.
 *
 * ⚠ FIRST-PASS DERIVED.
 * @type {number}
 */
export const HALO_SHAPE_MAX_REL_DEV = 0.25;

/**
 * Band the measured log-log slope of the halo tail must fall in.
 *
 * DERIVED from the shipped profile: `d ln v / d ln rho = -2 rho^2/(c^2+rho^2)`
 * is -1.867 at 16 R_sun and -1.960 at 30 R_sun, so the true measured slope over
 * the band is -1.913 and varies by 0.09 across it. The band is -1.913 +/- 0.6,
 * i.e. ~13x that spread — wide enough that the bin geometry cannot move it,
 * narrow enough to exclude both an inverse-FOURTH-power Moffat wing (-4, the
 * STAR PSF's law, which must not be confused with this one) and a flat pedestal.
 * @type {{lo:number,hi:number}}
 */
export const HALO_TAIL_SLOPE_BAND = Object.freeze({ lo: -2.5, hi: -1.3 });

/**
 * Minimum mean linear radiance the SCREEN leg must carry across
 * {@link HALO_BAND_RSUN} — the halo's presence, i.e. C12-18's "non-terminating"
 * claim stated as a measurement.
 *
 * DERIVED: the modelled band mean is `0.75 * mean(veil) ~ 0.026`. The bar is
 * 0.002 — 13x below the model and ~7x above one 8-bit code in linear light.
 *
 * ⚠ FIRST-PASS DERIVED.
 * @type {number}
 */
export const HALO_MIN_BAND_RADIANCE = 0.002;

/**
 * Maximum mean linear radiance the BAKE leg may carry across the same band —
 * the positive control that the band is genuinely empty without the screen
 * halo, so the screen leg's signal cannot be background.
 *
 * DERIVED: analytically exactly 0 (the band starts past the billboard's
 * corner). 5.0e-4 is ~1.6 code values at exposure 1.
 * @type {number}
 */
export const HALO_BAKE_BAND_MAX_RADIANCE = 5.0e-4;

/**
 * How far the projected solar peak may sit from the crop centre in the halo
 * lane before the lane is declared blind. Same role as G2's
 * `PSF_AIM_TOLERANCE_PX`, same value.
 * @type {number}
 */
export const HALO_AIM_TOLERANCE_PX = 6;

// ---------------------------------------------------------------------------
// SUN — ECLIPSE ALPHA CHAIN (C12-29 S1 / CLT-C4, read live)
// ---------------------------------------------------------------------------
//
// Every sun criterion above is taken on the SUNLIT side, where nothing occults
// the Sun. The eclipse chain must therefore resolve to its multiplicative
// identity at every stage — and "exactly 1.0" is the claim, not "close to 1":
// `sunEclipseAlpha`, `sunHalo.eclipseFactor` and `eclipseState.sunVisibleFraction`
// are all documented as exact identities in the unocculted case, and
// `x * 1.0 === x` for every finite IEEE-754 x. A lane that measured the disc
// through a fractionally-dimmed chain would be measuring a different disc.

// ---------------------------------------------------------------------------
// SUN — C12-28 DISPLAY POLICY
// ---------------------------------------------------------------------------
//
// The W4 gate row's C12-28 clause is "byte-identical behaviour on SDR
// displays". Headless Edge reports an SDR display and there is no CDP override
// for `dynamic-range`, so the SDR leg is the only one reachable here — and, as
// the C12-28 row itself records, that leg "would pass identically with the
// feature reverted". A bare SDR-identity assertion is therefore VACUOUS.
//
// It is made non-vacuous by a live POSITIVE CONTROL: the probe forces the
// scene's detected display state to HDR, re-runs the real
// `Scene._applyHdrDisplayDefault()`, requires the scene HDR flag to FLIP, then
// restores the detected state and requires it to flip BACK. That proves the
// SDR result is a decision the shipped resolver made, not the absence of code.

/** The shipped default policy. `Scene.js` sets `HdrDisplayPolicy.SCENE`. */
export const HDR_EXPECTED_POLICY = "scene";

// ---------------------------------------------------------------------------
// MOON — EPOCHS
// ---------------------------------------------------------------------------

/**
 * Illuminated-fraction targets handed to the moon-appearance demo's own
 * `findTimeForPhase` search. These are the ESTABLISHED framings —
 * `packages/sandcastle/gallery/moon-appearance/main.js` ships 0.98 ("Full moon,
 * opposition surge"), 0.5 ("Terminator close-up") and 0.12 ("Thin crescent,
 * earthshine") — with the full target raised to 1.0 so the search returns its
 * BEST approach to opposition rather than stopping 16 degrees short of it (see
 * {@link SURGE_REACHABLE_MAX_PHASE_ANGLE_DEG}).
 * @type {Readonly<Record<string, number>>}
 */
export const MOON_PHASE_TARGETS = Object.freeze({
  full: 1.0,
  quarter: 0.5,
  crescent: 0.12,
});

/**
 * How far the resolved illuminated fraction may sit from its target before the
 * epoch is declared unusable.
 *
 * DERIVED: the search refines on a 10-minute grid and the illuminated fraction
 * moves ~0.008 per 10 minutes near quarter phase, so a correct search lands
 * within ~0.004. The bar is 0.03, ~7x that. `full` is excluded because its
 * target is deliberately unreachable — the fraction cannot reach 1 unless the
 * moon crosses the ecliptic exactly at opposition — and is governed by
 * {@link MOON_FULL_MIN_PHASE_FRACTION} instead.
 * @type {number}
 */
export const MOON_PHASE_TARGET_TOLERANCE = 0.03;

/**
 * Minimum illuminated fraction the `full` epoch must reach for the moon lanes
 * to run at all. 0.98 is the demo's own full-moon framing.
 * @type {number}
 */
export const MOON_FULL_MIN_PHASE_FRACTION = 0.98;

/**
 * Phase angle, in degrees, below which the C12-23 opposition surge contributes
 * at least 10% — i.e. the reachability condition for §5's full:quarter ratio.
 *
 * DERIVED FROM THE SHIPPED CONSTANTS, not chosen: `computeLunarOppositionSurge`
 * is `1 + B0/(1 + tan(a/2)/h)` with `B0 = 0.6` and `h = 0.00873`. At a = 5 deg,
 * `tan(2.5 deg)/h = 5.00` exactly, so `B = 1.100`. The C12-20 row states the
 * >3:1 bar "is exceeded by LS + C12-23 surge TOGETHER (~4.2:1) — gate the pair,
 * not LS alone"; outside this angle the pair cannot both be engaged and the
 * criterion is measuring Lommel-Seeliger alone, which the same row puts at
 * ~2.65:1, BELOW the bar, for a reason that is epoch selection rather than
 * product behaviour. So outside it the arm reports STRUCTURAL and prints the
 * number, rather than failing the gate for a framing it could not reach.
 * @type {number}
 */
export const SURGE_REACHABLE_MAX_PHASE_ANGLE_DEG = 5.0;

/**
 * §5's moon headline: "full:quarter integrated-brightness ratio must exceed the
 * Lambertian ~3:1". RATIFIED.
 * @type {number}
 */
export const MOON_FULL_QUARTER_RATIO_MIN = 3.0;

/**
 * The C12-20 row's recorded Lommel-Seeliger-alone expectation, carried so the
 * unreachable-arm diagnostic can be read against something.
 * @type {number}
 */
export const MOON_LS_ONLY_FULL_QUARTER_EXPECTATION = 2.65;

/**
 * Minimum integrated-brightness separation between adjacent phase epochs, as a
 * ratio. The disc must get brighter with phase in the obvious ordering
 * (full > quarter > crescent) — a weak claim, deliberately, because it is the
 * one phase claim that holds under EVERY disc law this campaign has shipped and
 * therefore the one a reachability-gated ratio can fall back on.
 *
 * DERIVED: Lommel-Seeliger's own quarter:crescent(0.12) ratio is ~3.0 and
 * full:quarter is ~2.65, so 1.30 is a wide margin under the shipped law while
 * still rejecting a disc whose brightness is phase-INDEPENDENT (ratio 1.00) —
 * the C11-176b blackout's inverse, and the failure this ordering exists to
 * catch.
 * @type {number}
 */
export const MOON_PHASE_ORDERING_MIN_RATIO = 1.3;

// ---------------------------------------------------------------------------
// MOON — EARTHSHINE (C12-21)
// ---------------------------------------------------------------------------

/**
 * Shipped earthshine tint ratios, blue/red and green/red, from the single pair
 * of literals both shader twins carry (`vec3(0.4, 0.5, 0.7) * 0.08`).
 * @type {number}
 */
export const EARTHSHINE_TINT_BR_NOMINAL = 0.7 / 0.4;
/** @type {number} */
export const EARTHSHINE_TINT_GR_NOMINAL = 0.5 / 0.4;

/**
 * Maximum relative deviation on either tint ratio.
 *
 * DERIVED: the measured delta is taken as a per-channel MEDIAN over thousands
 * of unlit-limb pixels, so 8-bit quantization contributes a few percent at the
 * red channel (the faintest of the three). The bar is 15%, ~5x that — and it
 * rejects a WHITE earthshine, the obvious wrong implementation, on BOTH ratios
 * (43% and 20% deviation).
 *
 * ⚠ FIRST-PASS DERIVED.
 * @type {number}
 */
export const EARTHSHINE_TINT_MAX_REL_DEV = 0.15;

/**
 * Minimum median linear-radiance delta on the unlit limb at the crescent epoch
 * — earthshine's PRESENCE.
 *
 * DERIVED FROM THE SHIPPED CONSTANTS: on the unlit hemisphere `rawNdotL` is 0,
 * so the term is exactly `0.7 * 0.08 * scale` in blue, and the resolved scale at
 * a 0.12 crescent is 0.88 — a modelled 0.0493. The bar is 0.005, 10x below the
 * model and ~16x above one 8-bit code in linear light.
 *
 * ⚠ FIRST-PASS DERIVED.
 * @type {number}
 */
export const EARTHSHINE_MIN_MEDIAN_DELTA = 0.005;

/**
 * Minimum number of unlit-limb pixels that must actually change.
 *
 * DERIVED FROM GEOMETRY: at a 0.12 crescent ~85% of a modelled 289 px-radius
 * disc is unlit, i.e. ~223,000 pixels. The bar is 500 — 0.2% of that — and its
 * job is to refuse an "earthshine is present" claim built on a handful of
 * pixels.
 * @type {number}
 */
export const EARTHSHINE_MIN_CHANGED_PIXELS = 500;

/**
 * Minimum unlit-limb mask size before the earthshine arm returns a verdict at
 * all. Below this the medians are noise and the lane is STRUCTURAL, not FAIL.
 * @type {number}
 */
export const EARTHSHINE_MIN_MASK_PIXELS = 2000;

/**
 * Maximum relative deviation between the measured crescent:quarter delta ratio
 * and the ratio of the LIVE resolved `moonEarthshinePhaseScale` values.
 *
 * This is C12-21 itself: the row's entire content is that earthshine is scaled
 * by Earth's phase, the exact complement of the Moon's. Predicting from the
 * LIVE resolved scale rather than from a hard-coded fraction means the
 * criterion reads "the pixels follow the resolved scale" and cannot drift if
 * the epochs move.
 *
 * DERIVED: both medians are taken over thousands of pixels on the same
 * geometry, so the dominant error is the unlit mask differing between epochs;
 * 20% is generous against that and still rejects the pre-C12-21 CONSTANT term,
 * which predicts a ratio of 1.00 against a modelled 1.76 (43% deviation).
 *
 * ⚠ FIRST-PASS DERIVED.
 * @type {number}
 */
export const EARTHSHINE_PHASE_SCALING_MAX_REL_DEV = 0.2;

/**
 * Slack factor on the near-full inertness bound: the CENSUSED delta over the
 * full-moon DISC must not exceed
 * `factor * medianDeltaCrescent * (scaleFull / scaleCrescent)`.
 *
 * MEASURED OVER THE WHOLE DISC, NOT THE UNLIT MASK, and that is a correction
 * rather than a convenience: at full moon there IS no unlit limb in view, so
 * the mask the crescent and quarter arms use is EMPTY and its median is NaN.
 * Evaluating inertness on an empty mask fails the criterion on a healthy
 * renderer for a reason that is pure geometry — the vacuity class this repo
 * keeps paying for, and it was caught here by the spec's own synthetic full
 * moon before any Edge run.
 *
 * DERIVED: with the phase scaling correct the two sides sit within the
 * lit-fraction geometry of each other, so the factor is measurement slack; 3x
 * absorbs it and the near-zero denominator's quantization. The criterion's
 * teeth are against the PRE-C12-21 CONSTANT term, whose full-moon delta equals
 * its crescent delta while `scaleFull/scaleCrescent` is ~3.7e-4.
 * @type {number}
 */
export const EARTHSHINE_INERTNESS_FACTOR = 3.0;

/**
 * Rank at which the full-moon inertness census reads the disc's ON-minus-OFF
 * delta. `G4-FOLLOWUP-EARTHSHINE-EXPOSURE`.
 *
 * ⚠ THIS REPLACES THE PEAK, AND WITH IT `G4-FIRSTRUN-FIX-3`'s instrument floor.
 * The peak of a ~247,000-pixel delta between two independently quantized
 * captures reads ONE CODE STEP by construction — a max over that population
 * lands on the brightest pixel, which is exactly where PBR Neutral's
 * compression makes a code step worth most. FIX-3 correctly floored the bound
 * at `1.5 x quantum` to stop grading that noise, and Batch 948 then showed why
 * a per-pixel floor cannot work at this framing: the full moon sits at 8-bit
 * codes ~(238,239,235) on the 1x leg, where one step is worth **0.0251** of
 * linear luminance, so the floor rose to **0.0376 — ABOVE the 0.0347 amplitude
 * of the constant-term mutant it must reject**. FIX-3's own cap fired and the
 * lane went STRUCTURAL, correctly.
 *
 * ⚠ AND A DEEPER EXPOSURE BRACKET CANNOT FIX IT, which is why this follow-up
 * takes the census-statistic option rather than the exposure option.
 * `stitchBracketLinear` (and its mirror {@link chooseBracketLeg}) select the
 * HIGHEST exposure whose sample is unsaturated. The full-moon peak reads 239 at
 * 1x, below `BRACKET_SATURATION_CODE` 250, so 1x is chosen — and stays chosen
 * whatever else is added to the bracket. A higher leg (8x, 64x) saturates there
 * and is skipped; a LOWER leg (0.5x would put the same pixel at code 178, where
 * one step is worth 8.1e-3 — a 3.1x finer quantum) is never reached. Only a
 * change to the C12-02 selection rule that all four gates share could reach it,
 * and that is not a moon-lane decision.
 *
 * DERIVED — the level is the geometric midpoint of the two fractions it has to
 * separate, both of which are MEASURED rather than assumed:
 *
 *   * NULL. With the shipped phase-scaled earthshine, Batch 948's own census
 *     found `changedPixels` 431/246,832 (webgl) and 311/246,832 (webgpu) —
 *     1.75e-3 and 1.26e-3 of the disc, plus 13 and 7 pixels that got DARKER
 *     when earthshine was switched ON, which an additive term cannot do. That
 *     population IS the readback noise, and a quantile above it reads exactly
 *     zero.
 *   * MUTANT. The pre-C12-21 CONSTANT term lights the full moon as hard as the
 *     crescent (0.0347), which is 1.38 code steps at the coarsest pixel the
 *     census can see, so EVERY disc pixel moves at least one code: its
 *     brightened fraction is 1.0.
 *   * MIDPOINT. `sqrt(1.746e-3 * 1.0) = 4.18e-2`, rounded to 5e-2, i.e. the
 *     95th percentile. 28.6x above the worse backend's measured noise floor and
 *     20x below the mutant's coverage.
 *
 * The premise is enforced by the criterion itself rather than by a separate
 * assumption: if readback noise ever did reach 5% of the disc, this quantile
 * stops reading zero and the criterion goes RED — the conservative direction.
 * @type {number}
 */
export const EARTHSHINE_INERTNESS_QUANTILE = 0.95;

/**
 * How many 8-bit code steps the constant-term mutant must move at the coarsest
 * pixel the inertness census can see, before the census is allowed to certify.
 * `G4-FOLLOWUP-EARTHSHINE-EXPOSURE` — this is `G4-FIRSTRUN-FIX-3`'s cap,
 * restated for the rank statistic that replaced the peak.
 *
 * FIX-3's cap asked whether the BOUND had risen to the mutant's amplitude,
 * because the bound carried a per-pixel quantum floor. The rank statistic's
 * null reading is zero, so the bound is purely physical again and that question
 * is no longer where the instrument can go blind. The question that survives
 * is the one underneath it: **can one code step still resolve the mutant at
 * all?** If the disc were bright enough that one step exceeded the mutant's own
 * amplitude, a 100%-coverage constant term would move zero codes on part of the
 * disc and the census would certify a defect it simply could not see.
 *
 * DERIVED at 1.0 — one whole code step, the smallest difference an 8-bit
 * readback can express. It is a RESOLVABILITY precondition, not a slack factor,
 * so there is nothing to pad: at 1.0 the mutant moves at least one code
 * everywhere, and the measured margins are 1.81x (webgl, quantum 0.019247) and
 * 1.38x (webgpu, quantum 0.025087) against a 0.0347 mutant.
 *
 * Enforced, not assumed: {@link evaluateEarthshineSubLane} returns STRUCTURAL
 * when it is violated, exactly as FIX-3's cap did.
 * @type {number}
 */
export const EARTHSHINE_INERTNESS_MIN_MUTANT_CODES = 1.0;

// ---------------------------------------------------------------------------
// MOON — SOFT TERMINATOR (C12-22)
// ---------------------------------------------------------------------------

/**
 * Band the live-resolved `frameState.moonTerminatorSoftness` must fall in, in
 * radians, with the toggle ON.
 *
 * DERIVED: `computeSolarAngularRadius` returns `asin(SOLAR_RADIUS / d)` at the
 * TRUE Sun->Moon distance; the mean is 4.6491e-3 rad and Earth's orbital
 * eccentricity moves it +/-1.7%, i.e. [4.571e-3, 4.727e-3]. The band is
 * [4.4e-3, 4.9e-3], ~3x that span. The OFF position is asserted as EXACTLY 0.0
 * separately — that is the module's documented byte-identical identity, not a
 * band.
 * @type {{lo:number,hi:number}}
 */
export const TERMINATOR_SOFTNESS_BAND = Object.freeze({
  lo: 4.4e-3,
  hi: 4.9e-3,
});

/**
 * Linear-radiance difference at which a pixel counts as changed by the
 * softening.
 *
 * DERIVED FROM QUANTIZATION AT THE BRACKET'S HIGH LEG: the terminator lane
 * brackets at 8x, where one 8-bit code is ~3.8e-5 in linear light. The bar is
 * 1.0e-4, ~2.6 codes there, and it sits well below the modelled peak softening
 * of `w/4 = 1.16e-3` in mu0 units.
 *
 * ⚠ FIRST-PASS DERIVED.
 * @type {number}
 */
export const TERMINATOR_DELTA_EPS = 1.0e-4;

/**
 * Minimum number of pixels the softening must brighten — its non-vacuity
 * control, and the criterion the HARD-EDGE mutant fails by construction.
 *
 * DERIVED FROM GEOMETRY: near the terminator `N.L ~ d / R` for a screen offset
 * `d`, so the band `|N.L| < w` is `2 w R` pixels wide — 2.7 px at the lane's
 * modelled 289 px disc radius — and ~578 px long, i.e. ~1,560 px. The bar is
 * 200, ~13% of that, because the quadratic wrap form puts less than half the
 * band above half the peak and the band's ends run out of disc.
 *
 * ⚠ FIRST-PASS DERIVED.
 * @type {number}
 */
export const TERMINATOR_MIN_CHANGED_PIXELS = 200;

/**
 * Pixels the softening may DARKEN. Exactly zero, and that is the model's own
 * property rather than a tightened bound: `softTerminatorMu0(c, w) >= max(c, 0)`
 * for every c, with equality outside `(-w, w)`. A darkened pixel means the
 * softening was implemented as a GATE (`max(c,0) * smoothstep(-w, w, c)`), which
 * darkens the lit side and leaves the dark side at zero — the mutant
 * `MoonPhaseAppearance`'s own docstring names.
 * @type {number}
 */
export const TERMINATOR_MAX_DARKENED_PIXELS = 0;

/**
 * Maximum fraction of the lunar disc the softening may touch.
 *
 * DERIVED: the modelled band is ~1,560 px against a ~262,000 px disc, i.e.
 * 0.6%. The bar is 10%, ~17x that, and its job is to reject a softening that is
 * not LOCAL — a softness one hundred times too large, or a term applied to the
 * whole disc rather than to the terminator band.
 * @type {number}
 */
export const TERMINATOR_MAX_BAND_FRACTION = 0.1;

/**
 * Minimum lunar-disc pixel count before the terminator arm returns a verdict.
 * @type {number}
 */
export const TERMINATOR_MIN_DISC_PIXELS = 20000;

// ---------------------------------------------------------------------------
// MOON — MASK GEOMETRY
// ---------------------------------------------------------------------------

/**
 * Fraction of the projected lunar radius used as the DISC mask.
 *
 * 0.98 trims the disc's own antialiased limb, where the two legs of any A/B can
 * differ for edge-coverage reasons that have nothing to do with the term under
 * test. It costs 4% of the disc's area and removes the one place a
 * "no pixel darkened" claim could be broken by resampling.
 * @type {number}
 */
export const MOON_DISC_MASK_FRACTION = 0.98;

/**
 * Fraction of the projected lunar radius used as the UNLIT-LIMB mask.
 *
 * Tighter than {@link MOON_DISC_MASK_FRACTION} because earthshine's per-pixel
 * value is a CONSTANT on the unlit hemisphere (`rawNdotL == 0` there), so the
 * median is only meaningful away from the limb's grazing geometry.
 * @type {number}
 */
export const MOON_UNLIT_MASK_FRACTION = 0.9;

/**
 * Linear luminance at or below which a pixel in the earthshine-OFF leg counts
 * as UNLIT.
 *
 * DERIVED: with earthshine off, `onlySunLighting` on, no globe, no atmosphere
 * and a black background, the Moon's night side receives NO light at all — its
 * radiance is exactly 0 up to quantization. 0.002 is ~6 code values at exposure
 * 1, i.e. comfortably above the floor and 2.5x below
 * {@link EARTHSHINE_MIN_MEDIAN_DELTA}, so the mask cannot swallow the signal it
 * exists to measure.
 * @type {number}
 */
export const MOON_UNLIT_DARK_FLOOR = 0.002;

/**
 * How far the PROJECTED lunar centre may sit from the crop centre.
 *
 * The camera is parked on the Earth->Moon line looking straight at the Moon, so
 * the two coincide by construction. A violation means either the aim failed or
 * the CSS-pixel -> drawing-buffer conversion is wrong, and both make every
 * masked measurement in the moon half meaningless — hence STRUCTURAL, not FAIL.
 * 16 px is 5.5% of the modelled 289 px disc radius.
 * @type {number}
 */
export const MOON_AIM_TOLERANCE_PX = 16;

// ---------------------------------------------------------------------------
// CROSS-BACKEND
// ---------------------------------------------------------------------------

/**
 * Maximum symmetric relative spread between the two backends on a PHOTOMETRIC
 * scalar (disc diameter, size ratio, earthshine median, brightness ratio).
 *
 * ⚠ FIRST-PASS DERIVED, and the same 15% G2 uses. Every quantity G4 measures is
 * resolved CPU-side and published on `frameState` before the backend branch, so
 * the modelled spread is zero and anything measured is sampling, antialiasing
 * and 8-bit quantization.
 * @type {number}
 */
export const G4_CROSS_BACKEND_MAX_RELATIVE_SPREAD = 0.15;

/**
 * The same, for PIXEL COUNTS.
 *
 * DERIVED separately and deliberately looser: the terminator band is ~2.7 px
 * wide, so a half-pixel difference in either backend's edge antialiasing moves
 * the count by ~20%. 40% is 2x that.
 *
 * ⚠ FIRST-PASS DERIVED.
 * @type {number}
 */
export const G4_CROSS_BACKEND_MAX_COUNT_SPREAD = 0.4;

/**
 * Which SUB-LANE each cross-backend scalar was harvested from
 * (`G4-FIRSTRUN-FIX-2`).
 *
 * ⚠ PER-LANE SCOPING APPLIES TO THE FOLD TOO. A sub-lane that reports
 * STRUCTURAL has said, in its own words, that it could not see its subject.
 * Every number it published is then a description of the wrong thing, and
 * comparing two backends' wrong things produces a cross-backend FAILURE whose
 * subject is the instrument. Batch 941 filed three such failures
 * (`discDiameterDeg`, `trueSizeRatio`, `haloBandMean`) off webgl's structural
 * disc and halo lanes.
 *
 * The gated scalar is NOT silently skipped: {@link foldG4Verdict} reports it
 * STRUCTURAL BY NAME, with both backends' values and the spread it would have
 * computed, so the number stays on the record and the reason it did not certify
 * is stated rather than inferred from an absence.
 * @type {Object<string,string>}
 */
/**
 * The label every entry {@link foldG4Verdict} routes to the STRUCTURAL channel
 * for a REPORTING reason carries, and the token the fold's own invariant reads.
 * `G4-FOLLOWUP-STRUCTURAL-PARITY-CHANNEL`.
 *
 * ⚠ WHAT THIS IS AND IS NOT. It marks an entry that was measured and printed by
 * name but is NOT a statement about the product — a cross-backend scalar whose
 * source sub-lane declared it could not see its subject, a scalar with no
 * declared source lane, a scalar that is not finite on both sides, an arm-state
 * difference caused by a structural gate rather than by the two backends
 * resolving the same discriminators differently. Sub-lane structural notes do
 * NOT carry it: they are the sub-lane's own words about its own frame, and the
 * fold does not re-label them.
 *
 * ⚠ WHY IT IS A TOKEN AND NOT JUST PROSE. Batch 948 filed
 * `G4-FOLLOWUP-STRUCTURAL-PARITY-CHANNEL` on the belief that these entries were
 * reaching `failures[]` and driving exit 1. Re-folding the run's own
 * `backends` object at that commit shows they were not — every one of them was
 * on `structural[]`, and the exit 1 came from three per-backend criterion reds.
 * The FILED MECHANISM IS REFUTED. What is real is the invariant behind it: a
 * labelled non-verdict must never be a failure. So rather than a point fix to a
 * seam that was already closed, the rule gets an ENFORCEABLE home — see the
 * invariant at the end of {@link foldG4Verdict}, which re-routes any marked
 * entry that reaches `failures[]` and reports the misroute as a permanent
 * `console.error` plus a `nonVerdictMisroutes` field on the verdict.
 * @type {string}
 */
export const STRUCTURAL_NON_VERDICT_MARKER = "NOT a verdict";

export const PARITY_SCALAR_SOURCE_LANE = Object.freeze({
  discDiameterDeg: "disc",
  trueSizeRatio: "disc",
  haloBandMean: "halo",
  earthshineMedianDelta: "earthshine",
  fullQuarterRatio: "phase",
  terminatorChangedPixels: "terminator",
  earthshineChangedPixels: "earthshine",
});

// ---------------------------------------------------------------------------
// PURE HELPERS — arithmetic
// ---------------------------------------------------------------------------

/**
 * @param {number|null|undefined} x
 * @param {{lo:number,hi:number}} band
 * @returns {boolean} false for null/NaN without an explicit guard at call sites
 */
export function inBand(x, band) {
  return Number.isFinite(x) && x >= band.lo && x <= band.hi;
}

/**
 * Symmetric relative spread of two values about their mean.
 *
 * @param {number} a
 * @param {number} b
 * @returns {number} `|a-b| / mean`, or Infinity when the mean is not positive.
 */
export function relativeSpread(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return Infinity;
  }
  const mean = 0.5 * (a + b);
  return mean > 0 ? Math.abs(a - b) / mean : Infinity;
}

/**
 * Relative deviation of `measured` from `expected`.
 *
 * @param {number} measured
 * @param {number} expected
 * @returns {number} `|m-e| / |e|`, or Infinity when `expected` is 0 / non-finite.
 */
export function relativeDeviation(measured, expected) {
  if (!Number.isFinite(measured) || !Number.isFinite(expected)) {
    return Infinity;
  }
  if (expected === 0) {
    return measured === 0 ? 0 : Infinity;
  }
  return Math.abs(measured - expected) / Math.abs(expected);
}

/**
 * Median of a numeric array. Does not mutate the input.
 *
 * @param {ArrayLike<number>} values
 * @returns {number} NaN for an empty input.
 */
export function median(values) {
  const n = values.length;
  if (n === 0) {
    return NaN;
  }
  const sorted = Array.prototype.slice.call(values).sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

/**
 * Least-squares slope of `log10(y)` against `log10(x)` over the strictly
 * positive samples.
 *
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>} ys
 * @returns {number} The slope, or NaN when fewer than two usable samples exist.
 */
export function logLogSlope(xs, ys) {
  const lx = [];
  const ly = [];
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i++) {
    if (xs[i] > 0 && ys[i] > 0) {
      lx.push(Math.log10(xs[i]));
      ly.push(Math.log10(ys[i]));
    }
  }
  if (lx.length < 2) {
    return NaN;
  }
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < lx.length; i++) {
    sx += lx[i];
    sy += ly[i];
  }
  const mx = sx / lx.length;
  const my = sy / ly.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < lx.length; i++) {
    num += (lx[i] - mx) * (ly[i] - my);
    den += (lx[i] - mx) * (lx[i] - mx);
  }
  return den > 0 ? num / den : NaN;
}

/**
 * Angle subtended by a pixel offset from the frame centre, in degrees, under
 * the perspective projection the probe actually renders with.
 *
 * NOT `offset * fovX / width`: that linearisation is only exact at the centre.
 * At the framings this lane uses the two agree to four decimals, but the exact
 * form costs one line and removes the approximation from the record.
 *
 * @param {number} offsetPx Pixel distance from the frame centre.
 * @param {number} fovXDeg Horizontal field of view, degrees.
 * @param {number} widthPx Drawing-buffer width in pixels.
 * @returns {number} Angle in degrees.
 */
export function angleDegForPixelOffset(offsetPx, fovXDeg, widthPx) {
  if (
    !(widthPx > 0) ||
    !Number.isFinite(fovXDeg) ||
    !Number.isFinite(offsetPx)
  ) {
    return NaN;
  }
  const halfTan = Math.tan((fovXDeg * Math.PI) / 360.0);
  return (Math.atan((2.0 * offsetPx * halfTan) / widthPx) * 180.0) / Math.PI;
}

// ---------------------------------------------------------------------------
// PURE HELPERS — images. Every image is `{data, width, height}` with `data` in
// RGBA order; linear-light images carry Float64Array, captured frames carry
// Uint8ClampedArray. Nothing below assumes which.
// ---------------------------------------------------------------------------

/** Rec.709 luminance of the pixel starting at `i`. */
export function luminanceAt(data, i) {
  return (
    LUMINANCE_WEIGHTS[0] * data[i] +
    LUMINANCE_WEIGHTS[1] * data[i + 1] +
    LUMINANCE_WEIGHTS[2] * data[i + 2]
  );
}

/**
 * Linear-luminance value of ONE 8-bit code step at a captured pixel — the
 * instrument's own resolution AT THAT BRIGHTNESS. `G4-FIRSTRUN-FIX-3`.
 *
 * The shipped display chain is `exposure -> PBR-Neutral -> gamma`, and its
 * inverse is violently non-linear near the top: the same one-code step is worth
 * 3.8e-3 of linear luminance at code 128 and 3.3e-1 at code 250. A single
 * constant "8-bit quantum" is therefore wrong everywhere except at one
 * brightness, which is why this is evaluated AT THE PIXEL rather than assumed.
 *
 * The step is taken as the LARGEST of the three single-channel steps, because
 * PBR Neutral's compression is a function of the triple's MAX channel: bumping
 * the max channel moves the inverse further than bumping either other one, and
 * the bound has to cover the worst channel the readback could have disagreed on.
 *
 * @param {ArrayLike<number>} codes Three 8-bit codes `[r,g,b]`.
 * @param {number} exposureFactor The capture's `postProcessStages.exposure`.
 * @param {{gamma?:number}} [options]
 * @returns {number} Linear-luminance value of one code step; NaN if the inputs
 *          are not usable.
 */
export function captureCodeQuantumLinear(codes, exposureFactor, options = {}) {
  if (!Array.isArray(codes) && !ArrayBuffer.isView(codes)) {
    return NaN;
  }
  if (codes.length < 3 || !(exposureFactor > 0)) {
    return NaN;
  }
  const base = displayToLinear(codes[0], codes[1], codes[2], exposureFactor, {
    ...options,
  });
  const baseLum = luminanceAt(base, 0);
  let worst = 0;
  for (let c = 0; c < 3; c++) {
    const bumped = [codes[0], codes[1], codes[2]];
    bumped[c] = Math.min(255, bumped[c] + 1);
    const lin = displayToLinear(
      bumped[0],
      bumped[1],
      bumped[2],
      exposureFactor,
      { ...options },
    );
    const step = Math.abs(luminanceAt(lin, 0) - baseLum);
    if (step > worst) {
      worst = step;
    }
  }
  return Number.isFinite(worst) ? worst : NaN;
}

/**
 * The bracket leg `stitchBracketLinear` would have chosen for one pixel.
 *
 * ⚠ THIS MIRRORS A RULE THAT LIVES SOMEWHERE ELSE, so it is written as one
 * function and pinned by a spec test that requires it to agree with
 * `stitchBracketLinear`'s own pick on a synthetic bracket. Two copies of a
 * selection rule that drift are worse than one copy that is checked.
 *
 * @param {{data:ArrayLike<number>,exposureFactor:number}[]} captures
 * @param {number} index Byte index of the pixel's RED channel.
 * @param {{saturationCode?:number}} [options]
 * @returns {{capture:object,exposureFactor:number,saturated:boolean}|null}
 */
export function chooseBracketLeg(captures, index, options = {}) {
  const saturationCode = options.saturationCode ?? BRACKET_SATURATION_CODE;
  if (!Array.isArray(captures) || captures.length === 0) {
    return null;
  }
  const ordered = captures
    .slice()
    .sort((a, b) => b.exposureFactor - a.exposureFactor);
  for (const cap of ordered) {
    const peak = Math.max(
      cap.data[index],
      Math.max(cap.data[index + 1], cap.data[index + 2]),
    );
    if (peak < saturationCode) {
      return {
        capture: cap,
        exposureFactor: cap.exposureFactor,
        saturated: false,
      };
    }
  }
  const lowest = ordered[ordered.length - 1];
  return {
    capture: lowest,
    exposureFactor: lowest.exposureFactor,
    saturated: true,
  };
}

/**
 * Instrument resolution of the STITCHED composite at one pixel, in linear
 * luminance — {@link chooseBracketLeg} composed with
 * {@link captureCodeQuantumLinear}.
 *
 * @param {{data:ArrayLike<number>,exposureFactor:number}[]} captures
 * @param {number} index Byte index of the pixel's RED channel.
 * @param {{saturationCode?:number,gamma?:number}} [options]
 * @returns {number} Linear-luminance value of one code step; NaN if unusable.
 */
export function bracketQuantumAt(captures, index, options = {}) {
  if (!Number.isFinite(index) || index < 0) {
    return NaN;
  }
  const leg = chooseBracketLeg(captures, index, options);
  if (leg === null) {
    return NaN;
  }
  const d = leg.capture.data;
  return captureCodeQuantumLinear(
    [d[index], d[index + 1], d[index + 2]],
    leg.exposureFactor,
    options,
  );
}

/**
 * Per-channel difference `a - b`, as a linear-light RGBA image.
 *
 * @param {{data:ArrayLike<number>,width:number,height:number}} a
 * @param {{data:ArrayLike<number>,width:number,height:number}} b
 * @returns {{data:Float64Array,width:number,height:number}}
 */
export function differenceImage(a, b) {
  const n = Math.min(a.data.length, b.data.length);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 4) {
    out[i] = a.data[i] - b.data[i];
    out[i + 1] = a.data[i + 1] - b.data[i + 1];
    out[i + 2] = a.data[i + 2] - b.data[i + 2];
    out[i + 3] = 1;
  }
  return { data: out, width: a.width, height: a.height };
}

/**
 * Luminance-weighted centroid of an image's POSITIVE pixels.
 *
 * Used to locate the solar disc from the limb differential, which is radially
 * symmetric about the disc centre and identically zero outside it. Robust where
 * a brightest-pixel search is not: the differential's maximum lies on an
 * ANNULUS, so its argmax is degenerate.
 *
 * @param {{data:ArrayLike<number>,width:number,height:number}} image
 * @param {number} [floor=0] Ignore pixels at or below this luminance.
 * @returns {{x:number,y:number,weight:number,pixels:number}}
 */
export function positiveCentroid(image, floor = 0) {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let pixels = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const v = luminanceAt(image.data, 4 * (y * image.width + x));
      if (v > floor) {
        sw += v;
        sx += v * (x + 0.5);
        sy += v * (y + 0.5);
        pixels++;
      }
    }
  }
  return sw > 0
    ? { x: sx / sw, y: sy / sw, weight: sw, pixels }
    : { x: NaN, y: NaN, weight: 0, pixels };
}

/**
 * Mean luminance in each 1-pixel-wide annulus about `(cx, cy)`.
 *
 * @param {{data:ArrayLike<number>,width:number,height:number}} image
 * @param {number} cx Centre x, in pixels (pixel centres are at +0.5).
 * @param {number} cy Centre y.
 * @param {number} maxRadius Largest radius sampled, in pixels.
 * @returns {{radii:Float64Array,mean:Float64Array,count:Uint32Array}}
 *          `mean[k]` is the mean luminance of the annulus at radius `k`.
 */
export function radialProfile(image, cx, cy, maxRadius) {
  const bins = Math.max(1, Math.floor(maxRadius) + 1);
  const sum = new Float64Array(bins);
  const count = new Uint32Array(bins);
  const x0 = Math.max(0, Math.floor(cx - maxRadius - 1));
  const x1 = Math.min(image.width - 1, Math.ceil(cx + maxRadius + 1));
  const y0 = Math.max(0, Math.floor(cy - maxRadius - 1));
  const y1 = Math.min(image.height - 1, Math.ceil(cy + maxRadius + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const k = Math.round(r);
      if (k < bins) {
        sum[k] += luminanceAt(image.data, 4 * (y * image.width + x));
        count[k]++;
      }
    }
  }
  const radii = new Float64Array(bins);
  const mean = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    radii[k] = k;
    mean[k] = count[k] > 0 ? sum[k] / count[k] : NaN;
  }
  return { radii, mean, count };
}

/**
 * Linear interpolation of a radial profile at a fractional radius.
 *
 * @param {{mean:ArrayLike<number>}} profile
 * @param {number} radius
 * @returns {number} NaN outside the profile or across an empty bin.
 */
export function profileAt(profile, radius) {
  if (!(radius >= 0)) {
    return NaN;
  }
  const k = Math.floor(radius);
  if (k + 1 >= profile.mean.length) {
    return NaN;
  }
  const a = profile.mean[k];
  const b = profile.mean[k + 1];
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return NaN;
  }
  const t = radius - k;
  return a * (1 - t) + b * t;
}

/**
 * Outermost radius at which a radial profile is still above `level`, refined by
 * linear interpolation against its neighbour.
 *
 * The disc terminates in a `step()`, so this is a half-maximum edge locator and
 * is invariant to the profile's overall scale.
 *
 * @param {{mean:ArrayLike<number>}} profile
 * @param {number} level
 * @returns {number} NaN when the profile never crosses `level`.
 */
export function outerCrossingRadius(profile, level) {
  const mean = profile.mean;
  let last = -1;
  for (let k = 0; k < mean.length; k++) {
    if (Number.isFinite(mean[k]) && mean[k] >= level) {
      last = k;
    }
  }
  if (last < 0 || last + 1 >= mean.length) {
    return NaN;
  }
  const a = mean[last];
  const b = mean[last + 1];
  if (!Number.isFinite(b) || a === b) {
    return last;
  }
  return last + (a - level) / (a - b);
}

/**
 * Innermost radius at which a radial profile FIRST rises above `level`, refined
 * the same way. This is the inner edge of the annulus the true-size/legacy
 * differential produces, i.e. the legacy disc's edge.
 *
 * @param {{mean:ArrayLike<number>}} profile
 * @param {number} level
 * @returns {number} NaN when the profile never crosses `level`.
 */
export function innerCrossingRadius(profile, level) {
  const mean = profile.mean;
  for (let k = 1; k < mean.length; k++) {
    if (Number.isFinite(mean[k]) && mean[k] >= level) {
      const a = mean[k - 1];
      const b = mean[k];
      if (!Number.isFinite(a) || a === b) {
        return k;
      }
      return k - (b - level) / (b - a);
    }
  }
  return NaN;
}

/**
 * Mean luminance over the annulus `[r0, r1)` about `(cx, cy)`.
 *
 * @param {{data:ArrayLike<number>,width:number,height:number}} image
 * @param {number} cx
 * @param {number} cy
 * @param {number} r0
 * @param {number} r1
 * @returns {{mean:number,pixels:number}}
 */
export function annulusMean(image, cx, cy, r0, r1) {
  let sum = 0;
  let pixels = 0;
  const x0 = Math.max(0, Math.floor(cx - r1 - 1));
  const x1 = Math.min(image.width - 1, Math.ceil(cx + r1 + 1));
  const y0 = Math.max(0, Math.floor(cy - r1 - 1));
  const y1 = Math.min(image.height - 1, Math.ceil(cy + r1 + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (r >= r0 && r < r1) {
        sum += luminanceAt(image.data, 4 * (y * image.width + x));
        pixels++;
      }
    }
  }
  return { mean: pixels > 0 ? sum / pixels : NaN, pixels };
}

/**
 * Per-channel statistics of `on - off` over a DISC MASK intersected with the
 * pixels that are dark in the `off` leg — the unlit limb.
 *
 * The mask is geometric (a disc of radius `radius * innerFraction` about the
 * projected lunar centre) intersected with `luminance(off) <= darkFloor`. That
 * is deliberately NOT derived from the `on` leg: "does earthshine light the
 * unlit limb" cannot be answered with a mask that earthshine itself defines.
 *
 * @param {{data:ArrayLike<number>,width:number,height:number}} on
 * @param {{data:ArrayLike<number>,width:number,height:number}} off
 * @param {{cx:number,cy:number,radius:number,innerFraction:number,
 *          darkFloor:number,changedEps:number}} options
 * @returns {{maskPixels:number,changedPixels:number,medianDelta:number,
 *            medianR:number,medianG:number,medianB:number,maxDelta:number}}
 */
export function unlitLimbDelta(on, off, options) {
  const { cx, cy, radius, innerFraction, darkFloor, changedEps } = options;
  const rMax = radius * innerFraction;
  const lum = [];
  const rs = [];
  const gs = [];
  const bs = [];
  let changedPixels = 0;
  let maxDelta = -Infinity;
  const x0 = Math.max(0, Math.floor(cx - rMax - 1));
  const x1 = Math.min(on.width - 1, Math.ceil(cx + rMax + 1));
  const y0 = Math.max(0, Math.floor(cy - rMax - 1));
  const y1 = Math.min(on.height - 1, Math.ceil(cy + rMax + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > rMax) {
        continue;
      }
      const i = 4 * (y * on.width + x);
      if (luminanceAt(off.data, i) > darkFloor) {
        continue;
      }
      const dl = luminanceAt(on.data, i) - luminanceAt(off.data, i);
      lum.push(dl);
      rs.push(on.data[i] - off.data[i]);
      gs.push(on.data[i + 1] - off.data[i + 1]);
      bs.push(on.data[i + 2] - off.data[i + 2]);
      if (dl > changedEps) {
        changedPixels++;
      }
      if (dl > maxDelta) {
        maxDelta = dl;
      }
    }
  }
  return {
    maskPixels: lum.length,
    changedPixels,
    medianDelta: median(lum),
    medianR: median(rs),
    medianG: median(gs),
    medianB: median(bs),
    maxDelta: Number.isFinite(maxDelta) ? maxDelta : NaN,
  };
}

/**
 * Brightened / darkened pixel census over a disc mask — the soft-terminator
 * measurement.
 *
 * @param {{data:ArrayLike<number>,width:number,height:number}} on Softening ON.
 * @param {{data:ArrayLike<number>,width:number,height:number}} off Softening OFF.
 * @param {{cx:number,cy:number,radius:number,eps:number,quantile?:number}} options
 *        `quantile`, when a finite level in `(0,1)`, additionally reports the
 *        delta at that RANK over the mask (`G4-FOLLOWUP-EARTHSHINE-EXPOSURE`).
 *        Omitted by callers that do not need it, because it costs one buffered
 *        pass over the mask.
 * @returns {{discPixels:number,changedPixels:number,darkenedPixels:number,
 *            peakDelta:number,peakIndex:number,totalDelta:number,
 *            quantileLevel:number|null,quantileDelta:number}}
 *          `peakIndex` is the RGBA byte index of the pixel that produced
 *          `peakDelta`, so a caller holding the raw bracket can ask what ONE
 *          CODE STEP was worth there (`G4-FIRSTRUN-FIX-3`). `quantileDelta` is
 *          NaN — never 0 — when no level was requested, so a consumer cannot
 *          mistake "not measured" for "measured zero".
 */
export function discDeltaCensus(on, off, options) {
  const { cx, cy, radius, eps } = options;
  const level = options.quantile;
  const wantQuantile = Number.isFinite(level) && level > 0 && level < 1;
  let discPixels = 0;
  let changedPixels = 0;
  let darkenedPixels = 0;
  let peakDelta = -Infinity;
  let peakIndex = NaN;
  let totalDelta = 0;
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(on.width - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(on.height - 1, Math.ceil(cy + radius + 1));
  // Sized from the bounding box, so the fill can never run past its end; the
  // buffer is local and dies with the call (`G4-FIRSTRUN-FIX-5` keeps pixel
  // arrays out of the REPORT, not out of the measurement).
  const deltas = wantQuantile
    ? new Float64Array(Math.max(0, (x1 - x0 + 1) * (y1 - y0 + 1)))
    : null;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > radius) {
        continue;
      }
      const i = 4 * (y * on.width + x);
      const d = luminanceAt(on.data, i) - luminanceAt(off.data, i);
      if (deltas !== null) {
        deltas[discPixels] = d;
      }
      discPixels++;
      if (d > eps) {
        changedPixels++;
        totalDelta += d;
      } else if (d < -eps) {
        darkenedPixels++;
      }
      if (d > peakDelta) {
        peakDelta = d;
        peakIndex = i;
      }
    }
  }
  let quantileDelta = NaN;
  if (deltas !== null && discPixels > 0) {
    // NEAREST-RANK on the ascending sort. `Float64Array.prototype.sort` is
    // numeric, so no comparator is needed — and no comparator is the only form
    // that cannot silently become lexicographic.
    const sorted = deltas.subarray(0, discPixels).sort();
    const rank = Math.min(
      discPixels - 1,
      Math.max(0, Math.ceil(level * discPixels) - 1),
    );
    quantileDelta = sorted[rank];
  }
  return {
    discPixels,
    changedPixels,
    darkenedPixels,
    peakDelta: Number.isFinite(peakDelta) ? peakDelta : NaN,
    peakIndex,
    totalDelta,
    quantileLevel: wantQuantile ? level : null,
    quantileDelta,
  };
}

/**
 * Integrated luminance over a disc mask — the moon's disc-integrated
 * brightness.
 *
 * @param {{data:ArrayLike<number>,width:number,height:number}} image
 * @param {{cx:number,cy:number,radius:number}} options
 * @returns {{integrated:number,pixels:number,peak:number}}
 */
export function discIntegratedBrightness(image, options) {
  const { cx, cy, radius } = options;
  let integrated = 0;
  let pixels = 0;
  let peak = -Infinity;
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(image.width - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(image.height - 1, Math.ceil(cy + radius + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > radius) {
        continue;
      }
      const v = luminanceAt(image.data, 4 * (y * image.width + x));
      integrated += v;
      pixels++;
      if (v > peak) {
        peak = v;
      }
    }
  }
  return {
    integrated,
    pixels,
    peak: Number.isFinite(peak) ? peak : NaN,
  };
}

// ---------------------------------------------------------------------------
// PURE MODEL — computed from the SHIPPED `Scene/SolarDiscModel.js`, which the
// caller passes in. The lib never imports engine source: keeping it a pure
// function of the module means the spec can run the SAME code against the real
// module and against mutants of it.
// ---------------------------------------------------------------------------

/**
 * §5's `I(0.95R)/I(0)` as the SHIPPED CHAIN actually renders it — disc plus the
 * C12-18 screen halo that sits over it — from closed form.
 *
 * ⚠ THIS IS THE NAMED CONFOUND, PUT ON THE RECORD AS A NUMBER
 * (`G4-FIRSTRUN-FIX-4`). §5's band `[0.3, 0.5]` was ratified for the DISC-ONLY
 * radial law. What a camera pointed at the Sun sees at the shipped defaults is
 *
 *     I_composite(x) = discRadiance * I_limb(x) + haloAmplitude * P(x)
 *
 * with `P` the screen halo's Lorentzian in SOLAR radii (`x` at the disc edge IS
 * one solar radius, so the disc's `x` and the halo's `rho` are the same
 * variable over the disc). The halo is nearly FLAT across the disc — its
 * half-amplitude radius is 4.278 R_sun, so `P(0.95)/P(0) = 0.953` — which means
 * it acts as a PEDESTAL under the ratio and lifts it toward 1.
 *
 * Two separate readings come out of this, and BOTH belong in the maintainer
 * pack rather than in a moved bound:
 *
 *   * `discOnlyRatio` — the shipped limb law alone at `x = 0.95` is
 *     `I(0.95)/I(0) = 0.5680` with the shipped `(a0,a1,a2) = (0.3, 0.93,
 *     -0.23)`, i.e. ALREADY ABOVE §5's 0.5 ceiling BEFORE any halo. §5's band
 *     is satisfied at the EXTREME limb (`I(1)/I(0) = a0 = 0.30`), not at 0.95R.
 *   * `compositeRatio` — with `discRadiance = 2` and `haloAmplitude = 1.5` (the
 *     C12-19 defaults: `SOLAR_HALO_AMPLITUDE * discRadiance`) the composite
 *     predicts 0.7330, and Batch 941 MEASURED 0.7138 on WebGPU — 2.6% away.
 *     The band is not being missed by an unknown amount; it is being missed by
 *     an amount the shipped laws predict.
 *
 * THE BAND IS NOT MOVED HERE. This function only makes the arithmetic
 * reviewable.
 *
 * @param {{solarLimbIntensity:Function,solarScreenHaloProfile:Function}} model
 *        The shipped `SolarDiscModel` namespace (or a mutant of it).
 * @param {{discRadiance:number,haloAmplitude:number,haloCoreRadii:number,
 *          x?:number}} o Live-resolved appearance scalars; `x` defaults to the
 *        §5 sample point 0.95.
 * @returns {{x:number,discOnlyRatio:number,compositeRatio:number,
 *            haloShareAtX:number,haloShareAtCentre:number,
 *            haloProfileAtX:number,haloProfileAtCentre:number}}
 */
export function expectedCompositeLimbRatio(model, o) {
  const x = Number.isFinite(o?.x) ? o.x : LIMB_ABSOLUTE_RATIO_SAMPLE_X;
  const d = o?.discRadiance;
  const h = o?.haloAmplitude;
  const core = o?.haloCoreRadii;
  const iX = model.solarLimbIntensity(x);
  const i0 = model.solarLimbIntensity(0.0);
  const discOnlyRatio = i0 > 0 ? iX / i0 : NaN;
  if (!(d >= 0) || !(h >= 0) || !(core > 0)) {
    return {
      x,
      discOnlyRatio,
      compositeRatio: NaN,
      haloShareAtX: NaN,
      haloShareAtCentre: NaN,
      haloProfileAtX: NaN,
      haloProfileAtCentre: NaN,
    };
  }
  const pX = model.solarScreenHaloProfile(x, core);
  const p0 = model.solarScreenHaloProfile(0.0, core);
  const num = d * iX + h * pX;
  const den = d * i0 + h * p0;
  // The same composite with the bake's HUE term carried (see
  // `SUN_BAKE_BLUE_HUE_OFFSET`). Reported alongside rather than replacing
  // `compositeRatio`, because the 0.7330 figure is the one the B948/B950
  // stamps and the maintainer pack quote. It is the better model of the two:
  // against Batch 950 it lands at 0.7227 (webgpu measured 0.7138, -1.2%;
  // webgl 0.7181, -0.6%) where the hue-free form reads 0.7330 (-2.6% / -2.0%).
  const numC = d * solarDiscChainLuminance(iX) + h * pX;
  const denC = d * solarDiscChainLuminance(i0) + h * p0;
  return {
    x,
    discOnlyRatio,
    compositeRatio: den > 0 ? num / den : NaN,
    compositeRatioChroma: denC > 0 ? numC / denC : NaN,
    haloShareAtX: num > 0 ? (h * pX) / num : NaN,
    haloShareAtCentre: den > 0 ? (h * p0) / den : NaN,
    haloProfileAtX: pX,
    haloProfileAtCentre: p0,
  };
}

/**
 * The LUMA the shipped chain renders a disc pixel at, per unit disc radiance,
 * when the limb law evaluates to `limb` there.
 *
 * Forward model of exactly four shipped lines and nothing else:
 *
 *   bake      rgb = (1, 1, clamp(limb + 0.2))          alpha = limb
 *   SunFS     rgb = pow(rgb, gamma) * discRadiance     (HDR only)
 *   blend     out = rgb * alpha                        (over a dark sky)
 *   reduce    luma = 0.2126 R + 0.7152 G + 0.0722 B
 *
 * so `chain(limb) = limb * (wr + wg + wb * clamp(limb + 0.2)^gamma)`. It is
 * exactly `limb` at the disc centre (`limb = 1` clamps blue to 1) and 0.9682 x
 * `limb` at `x = 0.95`.
 *
 * @param {number} limb The limb law's value, `I(x)/I(0)`.
 * @param {number} [gamma=SUN_BAKE_GAMMA_NOMINAL] `scene.gamma`.
 * @returns {number} Luma per unit disc radiance.
 */
export function solarDiscChainLuminance(limb, gamma = SUN_BAKE_GAMMA_NOMINAL) {
  if (!Number.isFinite(limb)) {
    return NaN;
  }
  const raw = limb + SUN_BAKE_BLUE_HUE_OFFSET;
  const blue = Math.pow(raw < 0 ? 0 : raw > 1 ? 1 : raw, gamma);
  return (
    limb *
    (LUMINANCE_WEIGHTS[0] + LUMINANCE_WEIGHTS[1] + LUMINANCE_WEIGHTS[2] * blue)
  );
}

/**
 * The display code a neutral linear radiance lands on, and the linear worth of
 * ONE code there, under the lane's own exposure bracket.
 *
 * Composed entirely of shipped pieces: the FORWARD chain is the G2 lib's
 * `pbrNeutralTonemap` (the transcription `displayToLinear` inverts) followed by
 * `czm_inverseGamma`; the leg is picked by the same "highest unsaturated"
 * rule `stitchBracketLinear` and {@link chooseBracketLeg} use; and the quantum
 * itself is {@link captureCodeQuantumLinear}, so the resolution this bound is
 * built from is the resolution the stitch is built from.
 *
 * Evaluated on a NEUTRAL triple: over the disc the operator's `min` and `max`
 * are the same channel (the bake's blue clamps to red and green over the inner
 * disc), and at `x = 0.95` the hue term moves the peak channel not at all —
 * blue is the DIMMEST channel there, and `captureCodeQuantumLinear` already
 * takes the worst of the three steps.
 *
 * @param {number} linear Scene-linear radiance.
 * @param {readonly number[]} exposures The lane's bracket.
 * @returns {{exposure:number,code:number,oneCodeLinear:number}}
 * @private
 */
function bracketQuantum(linear, exposures) {
  const ordered = exposures.slice().sort((a, b) => b - a);
  const codeAt = (v, e) =>
    255 *
    Math.pow(
      Math.max(pbrNeutralTonemap([v * e, v * e, v * e])[0], 0),
      1 / DISPLAY_GAMMA,
    );
  let exposure = ordered[ordered.length - 1];
  for (const e of ordered) {
    if (codeAt(linear, e) < BRACKET_SATURATION_CODE) {
      exposure = e;
      break;
    }
  }
  const code = codeAt(linear, exposure);
  return {
    exposure,
    code,
    oneCodeLinear: captureCodeQuantumLinear([code, code, code], exposure),
  };
}

/**
 * §5's disc-only limb ratio, DERIVED — the band the arm certifies against,
 * plus every term that set its width.
 *
 * ⚠ THE BAND IS A PREDICTION OF THE SHIPPED CHAIN, computed from the model
 * passed in. It is a pure function of `(model, appearance scalars, geometry)`,
 * so a MUTANT model (wrong coefficients, wrong radiance) produces a different
 * band and the spec can prove the derivation actually reads each input.
 *
 * CENTRE. `chain(I(0.95)) / chain(I(0))` — 0.549901 at the shipped law, whose
 * pure-law value is 0.567967; the 3.2% difference is the bake's own hue term
 * (see {@link SUN_BAKE_BLUE_HUE_OFFSET}), not an error.
 *
 * WIDTH, from three modelled terms and two constraints:
 *
 *   T1  radial binning — the profile bin is +/-0.5 px, so the sample point is
 *       `x = 0.95 * (1 +/- 0.5/R)`; at the lane's modelled R = 170 px that is
 *       `dx = 0.00279` against a local slope `d(ratio)/dx = -2.4736`, i.e.
 *       0.00691 (1.26%). THE DOMINANT TERM.
 *   T2  display quantization — one 8-bit code at each of the two samples,
 *       taken through the lane's own bracket, divided by sqrt(N) for the
 *       annulus the profile bin averages. At radiance 2.0 the samples land at
 *       codes 125.4 (0.125x) and 242.3 (1x), worth 1.47% and 3.73% of their
 *       own values, over N ~ 1014 px: 0.13%.
 *   T3  the fp16 bake — both sun bakes store HDR as binary16, whose
 *       significand is 11 bits, over two samples: 0.10%.
 *
 * Modelled total 1.48%. The bar is then pinned between two requirements that
 * both have to hold, in the style `EARTHSHINE_INERTNESS_QUANTILE` uses:
 *
 *   * at least 3x the modelled error, so modelling slop cannot fail a real
 *     measurement (4.44%);
 *   * at most one third of the distance to the nearest thing it must REFUSE —
 *     the halo-contaminated composite this arm exists to stop reading, at
 *     31.4% relative (10.47%).
 *
 * and set to their GEOMETRIC MIDPOINT, 6.82%. Band `[0.512395, 0.587407]`.
 *
 * WHAT THAT BAND ADMITS AND REFUSES, all computed, none fitted: it admits the
 * shipped prediction (0.5499) and the pure law (0.5680), and it admits every
 * credible published law transported to 550 nm through the same chain
 * (Pierce & Slaughter 1977: 0.5546; Neckel & Labs 1994: 0.5565; Hestroffer &
 * Magnan 1998's power law: 0.5352) — so it is a check on the RENDERING, not a
 * vote between references. It refuses a flat disc (1.0), a linear limb law
 * (0.3169), the extreme-limb value §5's old bound actually fits (0.30), and
 * the halo-contaminated composite in both its modelled (0.7227) and measured
 * (0.7138 / 0.7181) forms.
 *
 * ⚠ FIRST-PASS DERIVED. No Edge run has produced a disc-only reading yet.
 *
 * @param {{solarLimbIntensity:Function,solarScreenHaloProfile:Function,
 *          solarHaloCoreRadii:Function}} model The shipped `SolarDiscModel`
 *        namespace, or a mutant of it.
 * @param {{discRadiance:number,haloAmplitude:number,haloCoreRadii:number,
 *          discRadiusPx?:number,x?:number,gamma?:number,
 *          exposures?:readonly number[]}} o Live-resolved appearance scalars
 *        and the run's own geometry.
 * @returns {{x:number,predicted:number,pureLaw:number,band:{lo:number,hi:number},
 *            tolRel:number,terms:object,separationRel:number,
 *            modelledRel:number,discRadiusPx:number}}
 */
export function deriveDiscOnlyLimbBand(model, o) {
  const x = Number.isFinite(o?.x) ? o.x : LIMB_ABSOLUTE_RATIO_SAMPLE_X;
  const gamma = Number.isFinite(o?.gamma) ? o.gamma : SUN_BAKE_GAMMA_NOMINAL;
  const discRadiusPx =
    o?.discRadiusPx > 0 ? o.discRadiusPx : LIMB_BAND_MODEL_DISC_RADIUS_PX;
  const exposures = o?.exposures ?? DISC_BRACKET_EXPOSURES;
  const chain = (v) => solarDiscChainLuminance(v, gamma);
  const ratioAt = (xx) =>
    chain(model.solarLimbIntensity(xx)) / chain(model.solarLimbIntensity(0.0));
  const pureLaw = model.solarLimbIntensity(x) / model.solarLimbIntensity(0.0);
  const predicted = ratioAt(x);
  const fail = {
    x,
    predicted,
    pureLaw,
    band: { lo: NaN, hi: NaN },
    tolRel: NaN,
    terms: null,
    separationRel: NaN,
    modelledRel: NaN,
    discRadiusPx,
  };
  if (!(predicted > 0)) {
    return fail;
  }

  // T1 — radial binning. Central difference on the model itself, so a mutant
  // law's own slope sets its own band width.
  const h = 1e-6;
  const slope = (ratioAt(x + h) - ratioAt(x - h)) / (2 * h);
  const t1 = Math.abs(slope) * x * (0.5 / discRadiusPx);

  // T2 — display quantization at the two samples, averaged over the annulus
  // bin. Needs the RADIANCE: this is the only place it enters, and it is why
  // a wrong radiance produces a wrong band even though the RATIO is
  // radiance-invariant.
  const L = o?.discRadiance;
  let t2 = NaN;
  let quantum = null;
  if (L > 0) {
    const centreLinear = L * chain(model.solarLimbIntensity(0.0));
    const edgeLinear = L * chain(model.solarLimbIntensity(x));
    const qc = bracketQuantum(centreLinear, exposures);
    const qe = bracketQuantum(edgeLinear, exposures);
    const relC = qc.oneCodeLinear / centreLinear;
    const relE = qe.oneCodeLinear / edgeLinear;
    const nAnnulus = Math.max(1, Math.floor(2 * Math.PI * x * discRadiusPx));
    t2 = (Math.hypot(relC, relE) / Math.sqrt(nAnnulus)) * predicted;
    quantum = {
      centreLinear,
      edgeLinear,
      centre: qc,
      edge: qe,
      relCentre: relC,
      relEdge: relE,
      annulusPixels: nAnnulus,
    };
  }
  if (!Number.isFinite(t2)) {
    return fail;
  }

  // T3 — the binary16 bake, two samples.
  const t3 = predicted * 2 * Math.pow(2, -11);

  const modelledRel = (t1 + t2 + t3) / predicted;

  // The nearest thing the band must REFUSE: the halo-over-disc composite,
  // modelled through the same chain from the same scalars. Deliberately the
  // chroma-carrying form, which is the CLOSER of the two composite models and
  // therefore the more conservative bound.
  const composite = expectedCompositeLimbRatio(model, {
    discRadiance: o?.discRadiance,
    haloAmplitude: o?.haloAmplitude,
    haloCoreRadii: o?.haloCoreRadii,
    x,
  });
  const contaminated = composite.compositeRatioChroma;
  if (!(contaminated > predicted)) {
    return { ...fail, terms: { t1, t2, t3, quantum }, modelledRel };
  }
  const separationRel = (contaminated - predicted) / predicted;
  const loBar = 3 * modelledRel;
  const hiBar = separationRel / 3;
  const tolRel = Math.sqrt(loBar * hiBar);
  return {
    x,
    predicted,
    pureLaw,
    band: {
      lo: predicted * (1 - tolRel),
      hi: predicted * (1 + tolRel),
    },
    tolRel,
    terms: {
      t1,
      t2,
      t3,
      slope,
      quantum,
      loBar,
      hiBar,
      contaminated,
    },
    separationRel,
    modelledRel,
    discRadiusPx,
  };
}

/**
 * Radius, in solar radii, at which `screenHalo(rho) - bakedHalo(rho)` peaks.
 *
 * @param {{solarScreenHaloProfile:Function,solarGlareProfile:Function,
 *          solarHaloCoreRadii:Function,solarBakeRadiusToSolarRadii:Function}} model
 *        The shipped `SolarDiscModel` namespace (or a mutant of it).
 * @param {number} [glowLengthTS=5] `glowFactor * 5`, as both bakes compute it.
 * @param {number} [step=0.005] Sweep step in solar radii.
 * @param {number} [maxRadii=40] Sweep limit in solar radii.
 * @returns {{peakRadii:number,peakDelta:number,samples:number}}
 */
export function screenMinusBakedPeak(
  model,
  glowLengthTS = 5.0,
  step = 0.005,
  maxRadii = 40.0,
) {
  const core = model.solarHaloCoreRadii(glowLengthTS);
  // The bake is parameterised in texture radius, the screen halo in solar
  // radii; `solarBakeRadiusToSolarRadii` is the map between them, so its
  // inverse converts the sweep's solar radii back to the bake's domain.
  const halfExtent = 1.0 + 2.0 * glowLengthTS;
  const toBakeRadius = (rho) => rho / (Math.SQRT2 * halfExtent);
  let peakRadii = NaN;
  let peakDelta = -Infinity;
  let samples = 0;
  const steps = Math.ceil(maxRadii / step);
  for (let k = 0; k <= steps; k++) {
    const rho = k * step;
    const screen = model.solarScreenHaloProfile(rho, core);
    const baked = model.solarGlareProfile(toBakeRadius(rho));
    const delta = screen - baked;
    samples++;
    if (delta > peakDelta) {
      peakDelta = delta;
      peakRadii = rho;
    }
  }
  return { peakRadii, peakDelta, samples };
}

/**
 * The anchor-normalised `1 - I(x)` profile the limb differential must follow.
 *
 * @param {{solarLimbIntensity:Function}} model The shipped `SolarDiscModel`.
 * @param {readonly number[]} [xs=LIMB_SHAPE_SAMPLE_X]
 * @returns {number[]} Normalised so the LAST sample is exactly 1.
 */
export function limbShapeExpectation(model, xs = LIMB_SHAPE_SAMPLE_X) {
  const raw = xs.map((x) => 1.0 - model.solarLimbIntensity(x));
  const anchor = raw[raw.length - 1];
  return anchor > 0 ? raw.map((v) => v / anchor) : raw.map(() => NaN);
}

/**
 * The anchor-normalised halo profile the screen leg must follow.
 *
 * @param {{solarScreenHaloProfile:Function,solarHaloCoreRadii:Function}} model
 * @param {readonly number[]} [rhos=HALO_SHAPE_SAMPLE_RSUN]
 * @param {number} [glowLengthTS=5]
 * @returns {number[]} Normalised so the FIRST sample is exactly 1.
 */
export function haloShapeExpectation(
  model,
  rhos = HALO_SHAPE_SAMPLE_RSUN,
  glowLengthTS = 5.0,
) {
  const core = model.solarHaloCoreRadii(glowLengthTS);
  const raw = rhos.map((rho) => model.solarScreenHaloProfile(rho, core));
  const anchor = raw[0];
  return anchor > 0 ? raw.map((v) => v / anchor) : raw.map(() => NaN);
}

/**
 * Largest relative deviation between a measured, anchor-normalised profile and
 * its expectation.
 *
 * @param {ArrayLike<number>} measured Raw (un-normalised) measurements.
 * @param {readonly number[]} expected Normalised expectation.
 * @param {number} anchorIndex Index the measurement is normalised against.
 * @returns {{maxRelDev:number,normalized:number[],deviations:number[]}}
 */
export function shapeDeviation(measured, expected, anchorIndex) {
  const anchor = measured[anchorIndex];
  if (!Number.isFinite(anchor) || anchor === 0) {
    return { maxRelDev: Infinity, normalized: [], deviations: [] };
  }
  const normalized = [];
  const deviations = [];
  let maxRelDev = 0;
  for (let i = 0; i < expected.length; i++) {
    const norm = measured[i] / anchor;
    normalized.push(norm);
    const dev = relativeDeviation(norm, expected[i]);
    deviations.push(dev);
    if (!(dev <= maxRelDev)) {
      maxRelDev = dev;
    }
  }
  return { maxRelDev, normalized, deviations };
}

/**
 * Brightest pixel within `radius` of `(cx, cy)`.
 *
 * POSITIONAL, for the reason `probe-celestial-gates.mjs` records at its own
 * copy: aiming a camera AT a source puts it at NDC (0,0), which for an
 * even-sized crop is a pixel CORNER, so a strict local-maximum census drops all
 * four equal neighbours.
 *
 * @param {{data:ArrayLike<number>,width:number,height:number}} image
 * @param {number} cx
 * @param {number} cy
 * @param {number} radius
 * @returns {{x:number,y:number,value:number,distance:number}}
 */
export function brightestWithinRadius(image, cx, cy, radius) {
  let best = { x: -1, y: -1, value: -Infinity, distance: Infinity };
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(image.width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(image.height - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > radius) {
        continue;
      }
      const v = luminanceAt(image.data, 4 * (y * image.width + x));
      if (v > best.value) {
        best = { x, y, value: v, distance: d };
      }
    }
  }
  return best;
}

/**
 * The aim diagnostic every sun lane now reports, every run
 * (`G4-FIRSTRUN-FIX-1`, part b).
 *
 * ⚠ THE POINT OF THIS BLOCK IS THAT IT DISCRIMINATES, NOT THAT IT DESCRIBES. A
 * disc or halo lane that is off centre has exactly two possible causes and they
 * demand opposite responses:
 *
 *   * the CAMERA is not pointed at the Sun — an INSTRUMENT defect. Then the
 *     ephemeris projection of `sunPositionWC` is off centre by the same amount
 *     and in the same direction as the measured light, so
 *     `ephemerisVsMeasuredPx` is ~0 while `measuredOffsetPx` is not.
 *   * the SUN IS NOT DRAWN WHERE THE EPHEMERIS SAYS — a PRODUCT defect. Then
 *     the two disagree and `ephemerisVsMeasuredPx` is the size of the
 *     disagreement.
 *
 * Batch 941 had no such block, so its structural note could only say "the
 * camera is not looking at the Sun" — a conclusion, not a measurement. Both
 * numbers are reported in PIXELS and in DEGREES, because the pixel figure is
 * meaningless without the framing that produced it (the same 0.1739 deg aim
 * error reads 111 px at the disc lane's 2 deg fov and 3.4 px at the halo
 * lane's 60 deg).
 *
 * @param {{measuredPx:{x:number,y:number},width:number,height:number,
 *          fovXDeg:number,canvasWidth:number,
 *          sunProjection:{x:number,y:number}|null}} o
 * @returns {object} Diagnostic block; every field is a number or null.
 */
export function buildAimDiagnostic(o) {
  const cx = o.width / 2;
  const cy = o.height / 2;
  const toDeg = (px) => angleDegForPixelOffset(px, o.fovXDeg, o.canvasWidth);
  const mx = o?.measuredPx?.x;
  const my = o?.measuredPx?.y;
  const measuredOffsetPx =
    Number.isFinite(mx) && Number.isFinite(my)
      ? Math.hypot(mx - cx, my - cy)
      : NaN;
  const sp = o?.sunProjection ?? null;
  const hasProjection =
    sp !== null && Number.isFinite(sp.x) && Number.isFinite(sp.y);
  const ephemerisOffsetPx = hasProjection
    ? Math.hypot(sp.x - cx, sp.y - cy)
    : NaN;
  const ephemerisVsMeasuredPx =
    hasProjection && Number.isFinite(measuredOffsetPx)
      ? Math.hypot(sp.x - mx, sp.y - my)
      : NaN;
  return {
    cropCentrePx: { x: cx, y: cy },
    measuredPx:
      Number.isFinite(mx) && Number.isFinite(my) ? { x: mx, y: my } : null,
    measuredOffsetPx,
    measuredOffsetDeg: toDeg(measuredOffsetPx),
    ephemerisPx: hasProjection ? { x: sp.x, y: sp.y } : null,
    ephemerisOffsetPx,
    ephemerisOffsetDeg: toDeg(ephemerisOffsetPx),
    ephemerisVsMeasuredPx,
    ephemerisVsMeasuredDeg: toDeg(ephemerisVsMeasuredPx),
    fovXDeg: Number.isFinite(o.fovXDeg) ? o.fovXDeg : null,
    canvasWidth: Number.isFinite(o.canvasWidth) ? o.canvasWidth : null,
    pxPerDeg:
      Number.isFinite(o.fovXDeg) && o.canvasWidth > 0
        ? o.canvasWidth /
          (2.0 * ((Math.tan((o.fovXDeg * Math.PI) / 360.0) * 180.0) / Math.PI))
        : null,
  };
}

/**
 * One line naming an aim miss precisely, for a structural note.
 *
 * @param {string} lane Lane name, for the message.
 * @param {object} aim {@link buildAimDiagnostic}'s result.
 * @param {number} tolerancePx The lane's certifying tolerance.
 * @returns {string}
 */
export function describeAimMiss(lane, aim, tolerancePx) {
  const r3 = (v) => (Number.isFinite(v) ? Number(v.toFixed(4)) : "?");
  const verdict = !Number.isFinite(aim?.ephemerisVsMeasuredPx)
    ? "the ephemeris projection of the Sun was not available, so this run " +
      "cannot say whether the CAMERA or the DRAWN SUN is displaced"
    : aim.ephemerisVsMeasuredPx <= tolerancePx
      ? "the ephemeris projection of `sunPositionWC` lands on the SAME spot " +
        `(${r3(aim.ephemerisVsMeasuredPx)} px away), so the Sun IS drawn where ` +
        "the ephemeris puts it and the CAMERA AIM is what is displaced — an " +
        "instrument defect, not a product verdict"
      : `the ephemeris projection of \`sunPositionWC\` sits ${r3(aim.ephemerisVsMeasuredPx)} px ` +
        "from the measured light, so the drawn Sun and the ephemeris DISAGREE " +
        "— that is a product reading and must not be dismissed as aim";
  return (
    `${lane} sits ${r3(aim?.measuredOffsetPx)} px ` +
    `(${r3(aim?.measuredOffsetDeg)} deg) from the crop centre, against a ` +
    `tolerance of ${tolerancePx} px; the ephemeris projection sits ` +
    `${r3(aim?.ephemerisOffsetPx)} px (${r3(aim?.ephemerisOffsetDeg)} deg) off. ` +
    verdict
  );
}

/** Largest finite value in a radial profile's mean array. */
function profilePeak(profile) {
  let peak = 0;
  for (const v of profile.mean) {
    if (Number.isFinite(v) && v > peak) {
      peak = v;
    }
  }
  return peak;
}

// ---------------------------------------------------------------------------
// MEASUREMENT COMPOSITION. These live HERE rather than in the probe so the spec
// exercises the code the gate actually runs, over synthetic frames whose answer
// is known in closed form, instead of a re-implementation that can drift from
// it. The probe's job is reduced to capture, stitching and live state.
// ---------------------------------------------------------------------------

/**
 * Measure the solar disc from the three toggle legs.
 *
 * `D1 = flat - limb` isolates the limb law: the C12-18 screen halo is a
 * function of screen geometry alone and is IDENTICAL in both legs, so it
 * subtracts to exactly zero. `D2 = flat - legacy` isolates the two disc edges
 * as an annulus.
 *
 * @param {{flat:object,limb:object,legacy:object,model:object,fovXDeg:number,
 *          canvasWidth:number,ephemerisDiameterDeg:number}} o Linear-light
 *        images plus the shipped `SolarDiscModel` namespace.
 * @returns {object} Every measured quantity the disc sub-lane reads.
 */
export function measureDiscDifferential(o) {
  const d1 = differenceImage(o.flat, o.limb);
  const d2 = differenceImage(o.flat, o.legacy);
  const cx = d1.width / 2;
  const cy = d1.height / 2;
  const centroid = positiveCentroid(d1, 0);
  // A differential with no signal has no centroid, and "0 px off centre" is the
  // honest reading of that: the aim is not what is wrong, the limb term is.
  // `differentialPositivePixels` is what the evaluator separates the two on.
  const aimDistancePx = Number.isFinite(centroid.x)
    ? Math.hypot(centroid.x - cx, centroid.y - cy)
    : 0;
  const ux = Number.isFinite(centroid.x) ? centroid.x : cx;
  const uy = Number.isFinite(centroid.y) ? centroid.y : cy;
  const maxRadius = Math.floor(Math.min(d1.width, d1.height) / 2) - 2;
  let limbLegLitPixels = 0;
  for (let i = 0; i < o.limb.data.length; i += 4) {
    if (luminanceAt(o.limb.data, i) > DISC_LIT_FLOOR) {
      limbLegLitPixels++;
    }
  }

  const p1 = radialProfile(d1, ux, uy, maxRadius);
  const p2 = radialProfile(d2, ux, uy, maxRadius);
  const discRadiusPx = outerCrossingRadius(
    p1,
    profilePeak(p1) * DISC_EDGE_FRACTION,
  );
  const legacyRadiusPx = innerCrossingRadius(
    p2,
    profilePeak(p2) * DISC_EDGE_FRACTION,
  );
  const trueRadiusFromAnnulusPx = outerCrossingRadius(
    p2,
    profilePeak(p2) * DISC_EDGE_FRACTION,
  );

  const measuredShape = LIMB_SHAPE_SAMPLE_X.map((x) =>
    profileAt(p1, x * discRadiusPx),
  );
  const expectedShape = limbShapeExpectation(o.model, LIMB_SHAPE_SAMPLE_X);
  const shape = shapeDeviation(
    measuredShape,
    expectedShape,
    LIMB_SHAPE_SAMPLE_X.length - 1,
  );
  const limbAnchorDelta = measuredShape[LIMB_SHAPE_SAMPLE_X.length - 1];
  const centreMean = annulusMean(d1, ux, uy, 0, 0.1 * discRadiusPx).mean;
  const outside = annulusMean(
    d1,
    ux,
    uy,
    LIMB_OUTSIDE_RADIUS_FACTOR * discRadiusPx,
    Math.min(1.5 * discRadiusPx, maxRadius),
  );

  // C12-19 PENDING-ARM inputs — the ABSOLUTE ratio §5 asks for, taken on the
  // SHIPPED leg with no differencing, plus the peak radiance that says whether
  // the bake is still clamped.
  // The centre value is an ANNULUS mean rather than `profileAt(profile, 0)`:
  // aiming at a source puts it at NDC (0,0), which for an even-sized crop is a
  // pixel CORNER, so the radius-0 bin is EMPTY and the profile reads NaN there.
  // That NaN would silently propagate into the pending arm's measured ratio and
  // make every comparison against §5's band false — the arm would look like it
  // had measured something when it had not.
  const pLimb = radialProfile(o.limb, ux, uy, maxRadius);
  const centreValue = annulusMean(o.limb, ux, uy, 0, 2).mean;
  const edgeValue = profileAt(pLimb, 0.95 * discRadiusPx);
  const discPeak = discIntegratedBrightness(o.limb, {
    cx: ux,
    cy: uy,
    radius: Math.max(3, 0.2 * discRadiusPx),
  });

  // ─── THE DISC-ONLY LIMB RATIO (ruling R-2026-08-10-2) ────────────────────
  // Built from the SAME two differentials the shape arm already runs on, so
  // it costs no capture and inherits their exact halo cancellation:
  //
  //   L          = mean of D2 over the annulus between the legacy edge
  //                (1/sqrt(2) R) and the true edge (R). Both legs are FLAT
  //                discs, so the annulus carries the disc's own radiance and
  //                nothing else.
  //   discOnly(x)= (L - D1(x)) / L, i.e. the disc's radial law with the
  //                C12-18 screen halo subtracted rather than modelled.
  //
  // `L` divides out of the ratio, so this reading is RADIANCE-INVARIANT — the
  // property the composite reading lacks and the reason this is the one that
  // tests the LAW.
  const radiancePlateau = annulusMean(
    d2,
    ux,
    uy,
    LIMB_DISC_ONLY_ANNULUS.lo * discRadiusPx,
    LIMB_DISC_ONLY_ANNULUS.hi * discRadiusPx,
  );
  const discRadianceMeasured = radiancePlateau.mean;
  const d1CentreMean = annulusMean(
    d1,
    ux,
    uy,
    0,
    LIMB_DISC_ONLY_CENTRE_RADIUS_PX,
  ).mean;
  const discOnlyCentreValue = discRadianceMeasured - d1CentreMean;
  const discOnlyEdgeValue = discRadianceMeasured - limbAnchorDelta;
  const discOnlyRatio =
    discOnlyCentreValue > 0 ? discOnlyEdgeValue / discOnlyCentreValue : NaN;

  const aim = buildAimDiagnostic({
    measuredPx: Number.isFinite(centroid.x)
      ? { x: centroid.x, y: centroid.y }
      : null,
    width: d1.width,
    height: d1.height,
    fovXDeg: o.fovXDeg,
    canvasWidth: o.canvasWidth,
    sunProjection: o.sunProjectionCropPx ?? null,
  });

  return {
    aimDistancePx,
    aimDistanceDeg: angleDegForPixelOffset(
      aimDistancePx,
      o.fovXDeg,
      o.canvasWidth,
    ),
    aim,
    differentialPositivePixels: centroid.pixels,
    limbLegLitPixels,
    centroid: { x: centroid.x, y: centroid.y, pixels: centroid.pixels },
    discRadiusPx,
    legacyRadiusPx,
    trueRadiusFromAnnulusPx_DIAGNOSTIC: trueRadiusFromAnnulusPx,
    discDiameterDeg:
      2 * angleDegForPixelOffset(discRadiusPx, o.fovXDeg, o.canvasWidth),
    ephemerisDiameterDeg: o.ephemerisDiameterDeg,
    trueSizeRatio: discRadiusPx / legacyRadiusPx,
    limbAnchorDelta,
    limbShapeMeasured: measuredShape,
    limbShapeNormalized: shape.normalized,
    limbShapeExpected: expectedShape,
    limbShapeMaxRelDev: shape.maxRelDev,
    limbCentreRelative:
      limbAnchorDelta > 0 ? Math.abs(centreMean) / limbAnchorDelta : Infinity,
    limbOutsideRelative:
      limbAnchorDelta > 0 ? Math.abs(outside.mean) / limbAnchorDelta : Infinity,
    limbOutsidePixels: outside.pixels,
    ratioI095overI0_DIAGNOSTIC: centreValue > 0 ? edgeValue / centreValue : NaN,
    discPeakLinear: discPeak.peak,
    // R-2 — the certifying reading and everything it was built from.
    discRadianceMeasured,
    discRadiancePlateauPixels: radiancePlateau.pixels,
    discOnlyCentreValue,
    discOnlyEdgeValue,
    discOnlyRatio_I095_over_I0: discOnlyRatio,
  };
}

/**
 * Measure the C12-18 screen halo from the two halo legs.
 *
 * @param {{screen:object,bake:object,limbPx:number,model:object,
 *          aimSearchRadiusPx:number}} o
 * @returns {object} Every measured quantity the halo sub-lane reads, plus the
 *          MODEL half of the B906 peak derivation run against `o.model`.
 */
export function measureHaloProfile(o) {
  const cx = o.screen.width / 2;
  const cy = o.screen.height / 2;
  const aim = brightestWithinRadius(
    o.screen,
    cx,
    cy,
    o.aimSearchRadiusPx ?? HALO_AIM_SEARCH_RADIUS_PX,
  );
  const cropRadiusPx = Math.min(cx, cy);
  const bandInnerPx = HALO_BAND_RSUN.inner * o.limbPx;
  const bandOuterPx = HALO_BAND_RSUN.outer * o.limbPx;
  const screenBand = annulusMean(o.screen, cx, cy, bandInnerPx, bandOuterPx);
  const bakeBand = annulusMean(o.bake, cx, cy, bandInnerPx, bandOuterPx);
  const pScreen = radialProfile(
    o.screen,
    cx,
    cy,
    Math.max(1, Math.floor(Math.min(cropRadiusPx - 2, bandOuterPx + 2))),
  );
  const measuredShape = HALO_SHAPE_SAMPLE_RSUN.map((rho) =>
    profileAt(pScreen, rho * o.limbPx),
  );
  const expectedShape = haloShapeExpectation(o.model, HALO_SHAPE_SAMPLE_RSUN);
  const shape = shapeDeviation(measuredShape, expectedShape, 0);
  const modelPeak = screenMinusBakedPeak(o.model);
  const aimDiagnostic = buildAimDiagnostic({
    measuredPx: aim.x >= 0 ? { x: aim.x + 0.5, y: aim.y + 0.5 } : null,
    width: o.screen.width,
    height: o.screen.height,
    fovXDeg: o.fovXDeg,
    canvasWidth: o.canvasWidth,
    sunProjection: o.sunProjectionCropPx ?? null,
  });
  return {
    aimDistancePx: aim.distance,
    aimDistanceDeg: angleDegForPixelOffset(
      aim.distance,
      o.fovXDeg,
      o.canvasWidth,
    ),
    aim: aimDiagnostic,
    aimSearchRadiusPx: o.aimSearchRadiusPx ?? HALO_AIM_SEARCH_RADIUS_PX,
    limbPx: o.limbPx,
    cropRadiusPx,
    bandInnerPx,
    bandOuterPx,
    screenBandMean: screenBand.mean,
    screenBandPixels: screenBand.pixels,
    bakeBandMean: bakeBand.mean,
    bakeBandPixels: bakeBand.pixels,
    haloShapeMeasured: measuredShape,
    haloShapeNormalized: shape.normalized,
    haloShapeExpected: expectedShape,
    haloShapeMaxRelDev: shape.maxRelDev,
    haloTailSlope: logLogSlope(HALO_SHAPE_SAMPLE_RSUN, measuredShape),
    deltaPeakRadii: modelPeak.peakRadii,
    deltaPeakValue: modelPeak.peakDelta,
  };
}

// ---------------------------------------------------------------------------
// PENDING ARM — C12-19
// ---------------------------------------------------------------------------

/**
 * Resolve the C12-19 pending arm from TWO independent live discriminators.
 *
 *   * `bakeClampPresent` — whether `SunTextureFS.glsl`'s final
 *     `clamp(color, vec4(0.0), vec4(1.0))` is still in the SERVED source. That
 *     clamp is literally what the C12-19 row is defined to remove.
 *   * `discPeakLinear` — the measured peak linear scene radiance of the disc.
 *     Bounded by 1.75 on the clamped build (see
 *     {@link C12_19_HDR_PEAK_DISCRIMINATOR}).
 *
 * A DISAGREEMENT between them is reported as STRUCTURAL rather than resolved by
 * preferring one: two references that disagree mean the instrument, not the
 * product, is the thing under test.
 *
 * ⚠ AND IT IS GATED ON THE DISC LANE (`G4-FIRSTRUN-FIX-4`). Unlike the
 * differential arm, this one reads an ABSOLUTE radial profile off the shipped
 * disc leg, centred on the centroid the disc lane found. A disc lane that went
 * structural has, by its own declaration, no disc profile to read — Batch 941's
 * 0.679 / 0.714 readings were taken about a centroid 112 px from where the Sun
 * was, on a "disc" whose measured diameter was 0.292 deg against an ephemeris
 * 0.527 deg. Those are not measurements of `I(0.95R)/I(0)`. The arm therefore
 * reports {@link ARM_STATE.PENDING_AIM} and prints the ratio, exactly as it
 * does for pending CONTENT.
 *
 * @param {{bakeClampPresent:boolean|null,discPeakLinear:number,
 *          ratioI095overI0:number,discLaneStructural:boolean,
 *          expectedComposite:object}} m
 * @returns {{state:string,pending:string|null,criteria:Object<string,boolean>,
 *            reason:string,measured:object}}
 */
export function evaluateLimbAbsoluteArm(m) {
  const measured = {
    bakeClampPresent: m?.bakeClampPresent ?? null,
    discPeakLinear: Number.isFinite(m?.discPeakLinear)
      ? m.discPeakLinear
      : null,
    ratioI095overI0: Number.isFinite(m?.ratioI095overI0)
      ? m.ratioI095overI0
      : null,
    // R-2 — the CERTIFYING reading (disc-only) and the derived band it is read
    // against, plus the radiance plateau the ratio's denominator came from.
    discOnlyRatio: Number.isFinite(m?.discOnlyRatio) ? m.discOnlyRatio : null,
    discRadianceMeasured: Number.isFinite(m?.discRadianceMeasured)
      ? m.discRadianceMeasured
      : null,
    discRadianceResolved: Number.isFinite(m?.discRadianceResolved)
      ? m.discRadianceResolved
      : null,
    derivedBand: m?.derivedBand ?? null,
    // The SUPERSEDED §5 bound, preserved so the run record shows what moved.
    // It was ratified for the EXTREME limb (`I(R)/I(0) = a0 = 0.30`), not for
    // 0.95R, which is why no shipped or published law could ever meet it here.
    supersededBand: LIMB_ABSOLUTE_RATIO_BAND,
    // THE NAMED CONFOUND, AS A NUMBER. See `expectedCompositeLimbRatio`: the
    // §5 band was ratified for the DISC-ONLY law, and what this ratio is taken
    // over is disc PLUS the C12-18 screen halo (amplitude x2 under C12-19).
    // Reported on every arm state so the maintainer decision has the
    // arithmetic whether or not the arm certified.
    expectedComposite: m?.expectedComposite ?? null,
  };
  if (m?.bakeClampPresent !== true && m?.bakeClampPresent !== false) {
    return {
      state: ARM_STATE.UNDETERMINED,
      pending: PENDING_CONTENT.C12_19,
      criteria: {},
      reason:
        "the served sun bake source could not be read, so whether the C12-19 " +
        "clamp removal has landed is UNKNOWN — the absolute limb ratio is " +
        "neither certified nor skipped",
      measured,
    };
  }
  const peakSaysHdr =
    Number.isFinite(m.discPeakLinear) &&
    m.discPeakLinear > C12_19_HDR_PEAK_DISCRIMINATOR;
  const clampSaysHdr = m.bakeClampPresent === false;
  if (peakSaysHdr !== clampSaysHdr) {
    return {
      state: ARM_STATE.DISAGREEMENT,
      pending: PENDING_CONTENT.C12_19,
      criteria: {},
      reason:
        `the two C12-19 discriminators disagree: the bake clamp is ` +
        `${m.bakeClampPresent ? "PRESENT" : "ABSENT"} while the measured disc ` +
        `peak radiance ${measured.discPeakLinear} is ` +
        `${peakSaysHdr ? "above" : "at or below"} the ` +
        `${C12_19_HDR_PEAK_DISCRIMINATOR} discriminator — the arm reports ` +
        "STRUCTURAL rather than picking one",
      measured,
    };
  }
  if (!clampSaysHdr) {
    return {
      state: ARM_STATE.PENDING_CONTENT,
      pending: PENDING_CONTENT.C12_19,
      criteria: {},
      reason:
        "the sun bakes still clamp to [0,1], so the disc's radiance cannot " +
        "exceed the LDR white point and the ABSOLUTE limb ratio I(0.95R)/I(0) " +
        "is dominated by the C12-18 screen halo sitting over the disc. The " +
        "ratio is MEASURED and reported every run; it certifies nothing until " +
        "C12-19 lands. Limb darkening's presence and shape are certified " +
        "meanwhile by the differential arm, which cancels the halo exactly.",
      measured,
    };
  }
  // G4-FIRSTRUN-FIX-4 — the CONTENT is there, but the lane the number comes
  // from could not see its subject. Structural, by name, with the ratio still
  // on the record.
  if (m.discLaneStructural === true) {
    return {
      state: ARM_STATE.PENDING_AIM,
      pending: null,
      criteria: {},
      reason:
        "C12-19 has landed, but the DISC sub-lane is structural this run, so " +
        "the absolute ratio was taken about a centroid the lane itself " +
        "declared was not the Sun. The number is MEASURED and printed; it " +
        "certifies nothing until the disc lane comes back non-structural. " +
        "Limb darkening's presence and shape are unaffected — the " +
        "differential arm cancels the halo exactly and is gated separately.",
      measured,
    };
  }
  // R-2 — THE INSTRUMENT CHECK THAT GATES THE READING. The disc-only ratio's
  // denominator is `L`, recovered from the `flat - legacy` annulus. If that
  // plateau is not the frame's own resolved `discRadiance`, the denominator is
  // not `L` and the number is not `I(0.95R)/I(0)` — structural, by name, with
  // the reading still printed.
  const lMeasured = measured.discRadianceMeasured;
  const lResolved = measured.discRadianceResolved;
  const recovered =
    lMeasured > 0 &&
    lResolved > 0 &&
    Math.abs(lMeasured / lResolved - 1) <=
      LIMB_DISC_RADIANCE_RECOVERY_TOLERANCE;
  if (!recovered) {
    return {
      state: ARM_STATE.RADIANCE_UNRECOVERED,
      pending: null,
      criteria: {},
      reason:
        `the disc-only ratio's denominator is the disc radiance recovered ` +
        `from the flat-minus-legacy annulus, and that plateau (${lMeasured}) ` +
        `is not within ${LIMB_DISC_RADIANCE_RECOVERY_TOLERANCE} of the ` +
        `frame's resolved discRadiance (${lResolved}) — so what was divided ` +
        "by is not the disc's radiance and the quotient is not " +
        "I(0.95R)/I(0). The reading is MEASURED and printed; it certifies " +
        "nothing. Limb darkening's presence and shape are unaffected — the " +
        "differential arm is gated separately.",
      measured,
    };
  }
  const band = measured.derivedBand?.band;
  if (!(band?.lo > 0) || !(band?.hi > band.lo)) {
    return {
      state: ARM_STATE.BAND_UNDERIVED,
      pending: null,
      criteria: {},
      reason:
        "the disc-only band could not be derived from the shipped model and " +
        "this frame's resolved appearance scalars, so there is nothing to " +
        "certify against. A bound that cannot be derived is STRUCTURAL, not " +
        "a pass.",
      measured,
    };
  }
  return {
    state: ARM_STATE.ACTIVE,
    pending: null,
    criteria: {
      limb_discOnlyRatio_I095_over_I0_in_band: inBand(
        measured.discOnlyRatio,
        band,
      ),
    },
    reason:
      "C12-19 has landed (the bake clamp is gone and the disc carries " +
      "radiance above the LDR white point), so §5's limb ratio is measurable " +
      "— and per ruling R-2026-08-10-2 it is certified on the DISC-ONLY " +
      "reading, which subtracts the C12-18 screen halo through the lane's " +
      "own differentials rather than modelling it away, against a band " +
      "DERIVED from the shipped law and the frame's own radiance. The " +
      "halo-contaminated composite ratio is still measured and printed as a " +
      "diagnostic; it is no longer certifying.",
    measured,
  };
}

// ---------------------------------------------------------------------------
// SUB-LANE EVALUATION — one backend at a time. Every function returns
// `{criteria, structural, pass}`; `pass` is guarded explicitly against the
// vacuous `{}.every(Boolean) === true`.
// ---------------------------------------------------------------------------

/**
 * Disc sub-lane — angular size, the B906 size-ratio pin, and the differential
 * limb-darkening profile.
 *
 * @param {object} m
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean}}
 */
export function evaluateDiscSubLane(m) {
  const structural = [];
  if (m?.hdrEngaged !== true) {
    structural.push(
      "the HDR path never engaged, so the exposure bracket did nothing and " +
        "the disc's radiance was clipped by the 8-bit canvas before it was read",
    );
  }
  if (!(m?.limbLegLitPixels >= DISC_MIN_LIT_PIXELS)) {
    structural.push(
      `the shipped disc leg carried only ${m?.limbLegLitPixels ?? 0} lit pixels ` +
        `(need ${DISC_MIN_LIT_PIXELS}) — the Sun is not in frame, so there is ` +
        "nothing here to measure",
    );
  }
  if (structural.length > 0) {
    return { criteria: {}, structural, pass: false };
  }
  // A LIT frame whose differential is empty is a DEFECT, not blindness: the
  // reference leg is a flat disc that always renders, so `flat - limb == 0`
  // means the limb term did nothing. Reported as a named criterion, ahead of
  // every structural guard below, so the headline C12-15 defect can never be
  // filed as "could not see its subject".
  if (!(m.differentialPositivePixels >= DISC_MIN_DIFFERENTIAL_PIXELS)) {
    return {
      criteria: { limb_differential_has_signal: false },
      structural,
      pass: false,
    };
  }
  if (!(m.aimDistancePx <= DISC_AIM_TOLERANCE_PX)) {
    structural.push(
      describeAimMiss(
        "the limb differential's centroid",
        m.aim ?? {
          measuredOffsetPx: m.aimDistancePx,
          measuredOffsetDeg: m.aimDistanceDeg,
        },
        DISC_AIM_TOLERANCE_PX,
      ),
    );
  }
  if (!(m.discRadiusPx > 0) || !(m.legacyRadiusPx > 0)) {
    structural.push(
      "one of the two disc edges was never crossed inside the search radius, " +
        "so the angular size and the true-size ratio are both undefined",
    );
  }
  if (structural.length > 0) {
    return { criteria: {}, structural, pass: false };
  }
  const criteria = {
    limb_differential_has_signal: true,
    disc_angularDiameter_within_5pct_of_nominal:
      relativeDeviation(
        m.discDiameterDeg,
        SOLAR_ANGULAR_DIAMETER_NOMINAL_DEG,
      ) <= SOLAR_ANGULAR_DIAMETER_TOLERANCE,
    disc_angularDiameter_matches_ephemeris:
      relativeDeviation(m.discDiameterDeg, m.ephemerisDiameterDeg) <=
      DISC_EPHEMERIS_TOLERANCE,
    disc_trueSizeRatio_is_sqrt2:
      relativeDeviation(m.trueSizeRatio, TRUE_SIZE_RATIO_NOMINAL) <=
      TRUE_SIZE_RATIO_TOLERANCE,
    limb_drop_at_0_95R_measurable:
      Number.isFinite(m.limbAnchorDelta) &&
      m.limbAnchorDelta >= LIMB_MIN_DROP_LINEAR,
    limb_shape_matches_shipped_law:
      Number.isFinite(m.limbShapeMaxRelDev) &&
      m.limbShapeMaxRelDev <= LIMB_SHAPE_MAX_REL_DEV,
    limb_vanishes_at_disc_centre:
      Number.isFinite(m.limbCentreRelative) &&
      m.limbCentreRelative <= LIMB_CENTRE_MAX_RELATIVE,
    limb_vanishes_outside_disc:
      Number.isFinite(m.limbOutsideRelative) &&
      m.limbOutsideRelative <= LIMB_OUTSIDE_MAX_RELATIVE,
  };
  return { criteria, structural, pass: Object.values(criteria).every(Boolean) };
}

/**
 * Halo sub-lane — the C12-18 one-halo-source invariant read LIVE, the
 * non-terminating tail measured beyond the billboard's own corner, and the
 * eclipse alpha chain's identity on the sunlit side.
 *
 * @param {object} m
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean}}
 */
export function evaluateHaloSubLane(m) {
  const structural = [];
  if (m?.hdrEngaged !== true) {
    structural.push(
      "the HDR path never engaged, so the halo tail was read through an 8-bit " +
        "canvas whose floor is above the tail this lane measures",
    );
  }
  if (!(m?.aimDistancePx <= HALO_AIM_TOLERANCE_PX)) {
    structural.push(
      describeAimMiss(
        "the brightest pixel",
        m?.aim ?? {
          measuredOffsetPx: m?.aimDistancePx,
          measuredOffsetDeg: m?.aimDistanceDeg,
        },
        HALO_AIM_TOLERANCE_PX,
      ),
    );
  }
  if (!(m?.limbPx > 0)) {
    structural.push(
      "the live `sunHalo.limbPx` is not positive, so pixel radii cannot be " +
        "converted to solar radii and every band in this lane is undefined",
    );
  }
  if (!(m?.bandOuterPx < m?.cropRadiusPx)) {
    structural.push(
      `the ${HALO_BAND_RSUN.outer} R_sun band edge lands at ` +
        `${m?.bandOuterPx ?? "?"} px, outside the crop's ${m?.cropRadiusPx ?? "?"} px ` +
        "half-extent — the tail was never in frame",
    );
  }
  if (structural.length > 0) {
    return { criteria: {}, structural, pass: false };
  }
  const criteria = {
    // The C12-18 invariant, as an exhaustive live truth table.
    halo_screenLeg_bakeGain_is_zero: m.screenLeg?.bakeHaloGain === 0,
    halo_screenLeg_screenHalo_on: m.screenLeg?.screenHalo === true,
    halo_screenLeg_intensity_positive: m.screenLeg?.haloIntensity > 0,
    halo_bakeLeg_bakeGain_is_one: m.bakeLeg?.bakeHaloGain === 1,
    halo_bakeLeg_screenHalo_off: m.bakeLeg?.screenHalo === false,
    halo_bakeLeg_intensity_is_zero: m.bakeLeg?.haloIntensity === 0,
    // The tail exists past the billboard's own corner...
    halo_tail_present_beyond_billboard:
      Number.isFinite(m.screenBandMean) &&
      m.screenBandMean >= HALO_MIN_BAND_RADIANCE,
    // ...and the same band is empty without it (the positive control).
    halo_bakeLeg_band_is_empty:
      Number.isFinite(m.bakeBandMean) &&
      m.bakeBandMean <= HALO_BAKE_BAND_MAX_RADIANCE,
    halo_tail_shape_is_lorentzian:
      Number.isFinite(m.haloShapeMaxRelDev) &&
      m.haloShapeMaxRelDev <= HALO_SHAPE_MAX_REL_DEV,
    halo_tail_slope_in_band: inBand(m.haloTailSlope, HALO_TAIL_SLOPE_BAND),
    // The model half of the B906 derivation, run against the SHIPPED module.
    halo_deltaPeak_at_11_Rsun:
      Number.isFinite(m.deltaPeakRadii) &&
      Math.abs(m.deltaPeakRadii - HALO_DELTA_PEAK_NOMINAL_RSUN) <=
        HALO_DELTA_PEAK_TOLERANCE_RSUN,
    // Eclipse alpha chain — exact identities on the sunlit side.
    eclipse_sunVisibleFraction_is_one: m.sunVisibleFraction === 1,
    eclipse_sunEclipseAlpha_is_one: m.sunEclipseAlpha === 1,
    eclipse_haloEclipseFactor_is_one: m.screenLeg?.eclipseFactor === 1,
  };
  return { criteria, structural, pass: Object.values(criteria).every(Boolean) };
}

/**
 * C12-28 policy sub-lane — the SDR leg plus its live positive control.
 *
 * @param {object} m
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean}}
 */
export function evaluatePolicySubLane(m) {
  const structural = [];
  if (m?.displayIsHdr === true) {
    structural.push(
      "this display reports `(dynamic-range: high)`, so the SDR-identity leg — " +
        "the only leg reachable without HDR hardware — is not reachable here. " +
        "That is the C12-28 row's OWED manual HDR-hardware check, not a defect",
    );
  }
  if (m?.hdrSupported !== true) {
    structural.push(
      "`Scene#highDynamicRangeSupported` is false on this backend, so " +
        "`resolveHdrDefault` short-circuits on CONTEXT_UNSUPPORTED and the " +
        "display half of the policy is never consulted",
    );
  }
  if (structural.length > 0) {
    return { criteria: {}, structural, pass: false };
  }
  const criteria = {
    // The SDR leg: nothing turned on.
    hdr_sdrDisplay_scene_stays_off: m.sceneHdrOn === false,
    hdr_sdrDisplay_canvasOutput_stays_off: m.canvasOutputOn === false,
    hdr_policy_default_is_scene: m.policy === HDR_EXPECTED_POLICY,
    // Detection must not masquerade as an application assignment, or the very
    // first resolve would freeze the value forever.
    hdr_detection_did_not_set_userFlags: m.sceneHdrUserSet === false,
    // POSITIVE CONTROL — without it the three criteria above pass identically
    // with the whole feature reverted.
    hdr_control_flipsOn_for_synthetic_hdr_display: m.controlSceneHdrOn === true,
    hdr_control_restores_sdr_state: m.restoredSceneHdrOn === false,
    hdr_control_restores_userFlags: m.restoredSceneHdrUserSet === false,
  };
  return { criteria, structural, pass: Object.values(criteria).every(Boolean) };
}

/**
 * Earthshine sub-lane (C12-21) — presence at the crescent, the shipped ashen
 * tint, the phase-complement scaling, and inertness at full moon.
 *
 * @param {object} m
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean}}
 */
export function evaluateEarthshineSubLane(m) {
  const structural = [];
  if (m?.enableEarthshine !== true) {
    structural.push(
      "`lighting.enableEarthshine` did not resolve true at the shipped " +
        "defaults — ruling R5 flipped it ON, so a false here means the lane " +
        "measured a scene the product does not ship",
    );
  }
  if (!(m?.crescent?.maskPixels >= EARTHSHINE_MIN_MASK_PIXELS)) {
    structural.push(
      `the crescent epoch's unlit-limb mask holds only ` +
        `${m?.crescent?.maskPixels ?? 0} pixels (need ${EARTHSHINE_MIN_MASK_PIXELS}) — ` +
        "there is no unlit limb in frame to light",
    );
  }
  if (!(m?.quarter?.maskPixels >= EARTHSHINE_MIN_MASK_PIXELS)) {
    structural.push(
      `the quarter epoch's unlit-limb mask holds only ` +
        `${m?.quarter?.maskPixels ?? 0} pixels (need ${EARTHSHINE_MIN_MASK_PIXELS}) — ` +
        "the phase-scaling ratio has no second point",
    );
  }
  if (!(m?.full?.discPixels >= TERMINATOR_MIN_DISC_PIXELS)) {
    structural.push(
      `the full epoch's lunar disc holds only ${m?.full?.discPixels ?? 0} pixels ` +
        `(need ${TERMINATOR_MIN_DISC_PIXELS}) — the inertness census is taken ` +
        "over the WHOLE disc (there is no unlit limb at full moon) and has " +
        "nothing to census",
    );
  }
  if (!(m?.scaleCrescent > 0) || !(m?.scaleQuarter > 0)) {
    structural.push(
      "a resolved `moonEarthshinePhaseScale` was zero or missing, so the " +
        "predicted scaling ratio is undefined",
    );
  }
  if (!(m?.aimDistancePx <= MOON_AIM_TOLERANCE_PX)) {
    structural.push(
      `the projected lunar centre sits ${m?.aimDistancePx ?? "?"} px from the ` +
        `crop centre (tolerance ${MOON_AIM_TOLERANCE_PX}) — every masked ` +
        "measurement in this arm is taken against the wrong disc",
    );
  }
  if (structural.length > 0) {
    return { criteria: {}, structural, pass: false };
  }
  const predictedRatio = m.scaleCrescent / m.scaleQuarter;
  const measuredRatio = m.crescent.medianDelta / m.quarter.medianDelta;
  const brNominal = EARTHSHINE_TINT_BR_NOMINAL;
  const grNominal = EARTHSHINE_TINT_GR_NOMINAL;
  const br = m.crescent.medianB / m.crescent.medianR;
  const gr = m.crescent.medianG / m.crescent.medianR;

  // G4-FOLLOWUP-EARTHSHINE-EXPOSURE — the inertness census reads a RANK, not
  // the peak, and the bound is purely physical again. See
  // EARTHSHINE_INERTNESS_QUANTILE for why `G4-FIRSTRUN-FIX-3`'s per-pixel
  // instrument floor could not survive a near-white full moon, and why a deeper
  // exposure bracket cannot reach the pixel that produced the reading.
  const physicalBound =
    EARTHSHINE_INERTNESS_FACTOR *
      m.crescent.medianDelta *
      (m.scaleFull / m.scaleCrescent) +
    TERMINATOR_DELTA_EPS;
  const quantum = m.full?.peakQuantumLinear;
  // The pre-C12-21 CONSTANT term's own full-moon amplitude: an earthshine that
  // does not scale with phase lights the full moon exactly as hard as it lights
  // the crescent. This is what the criterion EXISTS to reject, so it is also
  // the ceiling above which the criterion has stopped being a criterion.
  const mutantLevel = m.crescent.medianDelta;
  const inertnessBound = physicalBound;
  const censusLevel = m.full?.quantileLevel;
  const censusDelta = m.full?.quantileDelta;
  const brightenedFraction =
    m.full?.discPixels > 0 ? m.full.changedPixels / m.full.discPixels : null;
  const inertnessDiagnostics = {
    inertnessBound,
    inertnessPhysicalBound: physicalBound,
    inertnessQuantumLinear: Number.isFinite(quantum) ? quantum : null,
    inertnessBoundSource:
      "phase-scaled crescent delta (the rank statistic's null reading is zero, " +
      "so no instrument floor is added to the bound)",
    inertnessCensusQuantile: Number.isFinite(censusLevel) ? censusLevel : null,
    inertnessCensusDelta: Number.isFinite(censusDelta) ? censusDelta : null,
    inertnessBrightenedFraction: brightenedFraction,
    inertnessMutantLevel: mutantLevel,
    inertnessMutantMargin:
      inertnessBound > 0 ? mutantLevel / inertnessBound : null,
    // How many 8-bit code steps the mutant would move at the coarsest pixel the
    // census can see. Below EARTHSHINE_INERTNESS_MIN_MUTANT_CODES the census is
    // blind to its own target.
    inertnessResolvabilityMargin: Number.isFinite(quantum)
      ? mutantLevel / quantum
      : null,
  };
  if (!Number.isFinite(quantum)) {
    return {
      criteria: {},
      structural: [
        "the capture bracket's quantization step at the full-moon peak pixel " +
          "could not be resolved, so the census cannot show that it is able to " +
          "resolve the constant-term mutant it exists to reject (that term " +
          `lights the full moon at ${mutantLevel}); a census that cannot state ` +
          "its own resolution does not certify",
      ],
      predictedRatio,
      measuredRatio,
      tintBR: br,
      tintGR: gr,
      ...inertnessDiagnostics,
      fullPeakDelta: m.full?.peakDelta ?? null,
      pass: false,
    };
  }
  if (censusLevel !== EARTHSHINE_INERTNESS_QUANTILE) {
    return {
      criteria: {},
      structural: [
        `the full-moon census reported quantile level ${censusLevel} but the ` +
          `criterion is derived at ${EARTHSHINE_INERTNESS_QUANTILE} — the ` +
          "probe and the evaluator have drifted apart, and a bound derived at " +
          "one rank cannot grade a reading taken at another",
      ],
      predictedRatio,
      measuredRatio,
      tintBR: br,
      tintGR: gr,
      ...inertnessDiagnostics,
      fullPeakDelta: m.full?.peakDelta ?? null,
      pass: false,
    };
  }
  if (!(quantum * EARTHSHINE_INERTNESS_MIN_MUTANT_CODES < mutantLevel)) {
    return {
      criteria: {},
      structural: [
        `one 8-bit code step at the coarsest pixel of the full-moon census is ` +
          `worth ${quantum}, which is not below the amplitude of the very ` +
          `defect the census exists to reject (the pre-C12-21 CONSTANT term ` +
          `lights the full moon at ${mutantLevel}). A constant term could then ` +
          "move ZERO codes over part of the disc and the census would certify " +
          "a defect it cannot see; an instrument that cannot resolve its own " +
          "target does not certify",
      ],
      predictedRatio,
      measuredRatio,
      tintBR: br,
      tintGR: gr,
      ...inertnessDiagnostics,
      fullPeakDelta: m.full?.peakDelta ?? null,
      pass: false,
    };
  }
  if (!(inertnessBound < mutantLevel)) {
    return {
      criteria: {},
      structural: [
        `the inertness bound (${inertnessBound}) has risen to the amplitude of ` +
          `the very defect it rejects (the pre-C12-21 CONSTANT term lights the ` +
          `full moon at ${mutantLevel}). A bound that cannot see its own ` +
          "target does not certify",
      ],
      predictedRatio,
      measuredRatio,
      tintBR: br,
      tintGR: gr,
      ...inertnessDiagnostics,
      fullPeakDelta: m.full?.peakDelta ?? null,
      pass: false,
    };
  }
  const criteria = {
    earthshine_lights_unlit_limb_at_crescent:
      Number.isFinite(m.crescent.medianDelta) &&
      m.crescent.medianDelta >= EARTHSHINE_MIN_MEDIAN_DELTA,
    earthshine_changedPixels_at_crescent:
      m.crescent.changedPixels >= EARTHSHINE_MIN_CHANGED_PIXELS,
    earthshine_tint_blue_over_red:
      relativeDeviation(br, brNominal) <= EARTHSHINE_TINT_MAX_REL_DEV,
    earthshine_tint_green_over_red:
      relativeDeviation(gr, grNominal) <= EARTHSHINE_TINT_MAX_REL_DEV,
    earthshine_scales_with_earth_phase_complement:
      relativeDeviation(measuredRatio, predictedRatio) <=
      EARTHSHINE_PHASE_SCALING_MAX_REL_DEV,
    // OVER THE WHOLE DISC — see EARTHSHINE_INERTNESS_FACTOR — and at a RANK
    // rather than the peak (EARTHSHINE_INERTNESS_QUANTILE). At full moon the
    // unlit mask is empty by construction, so a disc statistic is what is
    // defined; the peak of that statistic reads one code step of readback noise
    // by construction, so the rank is what is measurable.
    earthshine_inert_at_full_moon:
      Number.isFinite(censusDelta) && censusDelta <= inertnessBound,
  };
  return {
    criteria,
    structural,
    predictedRatio,
    measuredRatio,
    tintBR: br,
    tintGR: gr,
    ...inertnessDiagnostics,
    fullPeakDelta: m.full?.peakDelta ?? null,
    pass: Object.values(criteria).every(Boolean),
  };
}

/**
 * Soft-terminator sub-lane (C12-22).
 *
 * @param {object} m
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean}}
 */
export function evaluateTerminatorSubLane(m) {
  const structural = [];
  if (!(m?.discPixels >= TERMINATOR_MIN_DISC_PIXELS)) {
    structural.push(
      `only ${m?.discPixels ?? 0} lunar-disc pixels are in frame (need ` +
        `${TERMINATOR_MIN_DISC_PIXELS}) — the terminator band is ~0.0093 disc ` +
        "radii wide, so a small disc cannot resolve it at all",
    );
  }
  if (m?.softnessOff !== 0) {
    structural.push(
      `the softening resolved to ${m?.softnessOff ?? "null"} in the OFF leg; ` +
        "the OFF position is documented as EXACTLY 0.0 and the whole A/B rests " +
        "on that identity",
    );
  }
  if (!(m?.aimDistancePx <= MOON_AIM_TOLERANCE_PX)) {
    structural.push(
      `the projected lunar centre sits ${m?.aimDistancePx ?? "?"} px from the ` +
        `crop centre (tolerance ${MOON_AIM_TOLERANCE_PX}) — the disc mask does ` +
        "not cover the disc",
    );
  }
  if (structural.length > 0) {
    return { criteria: {}, structural, pass: false };
  }
  const criteria = {
    terminator_softness_is_solar_angular_radius: inBand(
      m.softnessOn,
      TERMINATOR_SOFTNESS_BAND,
    ),
    terminator_band_exists: m.changedPixels >= TERMINATOR_MIN_CHANGED_PIXELS,
    terminator_no_pixel_darkened:
      m.darkenedPixels <= TERMINATOR_MAX_DARKENED_PIXELS,
    terminator_band_is_local:
      m.discPixels > 0 &&
      m.changedPixels / m.discPixels <= TERMINATOR_MAX_BAND_FRACTION,
  };
  return {
    criteria,
    structural,
    bandFraction: m.discPixels > 0 ? m.changedPixels / m.discPixels : NaN,
    pass: Object.values(criteria).every(Boolean),
  };
}

/**
 * Phase sub-lane — the three epochs resolved, the disc brightening with phase,
 * and §5's full:quarter ratio behind its reachability gate.
 *
 * @param {object} m
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean}}
 */
export function evaluatePhaseSubLane(m) {
  const structural = [];
  for (const key of ["quarter", "crescent"]) {
    const e = m?.epochs?.[key];
    if (
      !e ||
      !(
        Math.abs(e.phaseFraction - MOON_PHASE_TARGETS[key]) <=
        MOON_PHASE_TARGET_TOLERANCE
      )
    ) {
      structural.push(
        `the ${key} epoch resolved to illuminated fraction ` +
          `${e?.phaseFraction ?? "null"} against a target of ` +
          `${MOON_PHASE_TARGETS[key]} (tolerance ${MOON_PHASE_TARGET_TOLERANCE}) — ` +
          "the phase search did not land, so nothing measured at this epoch " +
          "describes the phase it claims to",
      );
    }
  }
  const full = m?.epochs?.full;
  if (!(full?.phaseFraction >= MOON_FULL_MIN_PHASE_FRACTION)) {
    structural.push(
      `the full epoch reached only illuminated fraction ` +
        `${full?.phaseFraction ?? "null"} (need ${MOON_FULL_MIN_PHASE_FRACTION}) — ` +
        "the search window contains no full moon",
    );
  }
  if (structural.length > 0) {
    return { criteria: {}, structural, pass: false, surgeReachable: false };
  }
  const surgeReachable =
    Number.isFinite(m.fullPhaseAngleDeg) &&
    m.fullPhaseAngleDeg <= SURGE_REACHABLE_MAX_PHASE_ANGLE_DEG;
  const criteria = {
    moon_brightness_increases_full_over_quarter:
      Number.isFinite(m.fullQuarterRatio) &&
      m.fullQuarterRatio >= MOON_PHASE_ORDERING_MIN_RATIO,
    moon_brightness_increases_quarter_over_crescent:
      Number.isFinite(m.quarterCrescentRatio) &&
      m.quarterCrescentRatio >= MOON_PHASE_ORDERING_MIN_RATIO,
  };
  if (surgeReachable) {
    criteria.moon_fullQuarterRatio_exceeds_lambertian =
      Number.isFinite(m.fullQuarterRatio) &&
      m.fullQuarterRatio > MOON_FULL_QUARTER_RATIO_MIN;
  }
  return {
    criteria,
    structural: surgeReachable
      ? structural
      : [
          `§5's full:quarter bar (> ${MOON_FULL_QUARTER_RATIO_MIN}) is NOT ` +
            `certifying at this epoch: the resolved full moon sits ` +
            `${m.fullPhaseAngleDeg} deg from opposition, where the shipped ` +
            `C12-23 surge contributes ${m.fullSurgeMultiplier}x. The C12-20 row ` +
            "requires the LS + surge PAIR to be gated together (LS alone is " +
            `~${MOON_LS_ONLY_FULL_QUARTER_EXPECTATION}:1, below the bar), and ` +
            `only a phase angle <= ${SURGE_REACHABLE_MAX_PHASE_ANGLE_DEG} deg ` +
            `engages the pair. MEASURED ANYWAY: ${m.fullQuarterRatio}`,
        ],
    surgeReachable,
    pass:
      Object.keys(criteria).length > 0 &&
      Object.values(criteria).every(Boolean),
  };
}

/**
 * Evaluate one backend's whole G4 lane.
 *
 * @param {object} backend
 * @returns {object}
 */
export function evaluateG4Backend(backend) {
  const disc = evaluateDiscSubLane(backend.disc);
  const halo = evaluateHaloSubLane(backend.halo);
  const policy = evaluatePolicySubLane(backend.policy);
  const earthshine = evaluateEarthshineSubLane(backend.earthshine);
  const terminator = evaluateTerminatorSubLane(backend.terminator);
  const phase = evaluatePhaseSubLane(backend.phase);
  // G4-FIRSTRUN-FIX-4 — the arm's certifying read is gated on the lane its
  // number comes from. Injected here rather than asked of the probe: this is
  // the only place that knows the disc lane's verdict.
  const limbArm = evaluateLimbAbsoluteArm({
    ...(backend.limbAbsolute ?? {}),
    discLaneStructural: disc.structural.length > 0,
  });

  const criteria = {
    ...disc.criteria,
    ...halo.criteria,
    ...policy.criteria,
    ...earthshine.criteria,
    ...terminator.criteria,
    ...phase.criteria,
    ...limbArm.criteria,
  };
  const structural = [
    ...disc.structural.map((s) => `disc: ${s}`),
    ...halo.structural.map((s) => `halo: ${s}`),
    ...policy.structural.map((s) => `policy: ${s}`),
    ...earthshine.structural.map((s) => `earthshine: ${s}`),
    ...terminator.structural.map((s) => `terminator: ${s}`),
    ...phase.structural.map((s) => `phase: ${s}`),
  ];
  const pendingArms = {};
  if (limbArm.state !== ARM_STATE.ACTIVE) {
    pendingArms.limb_discOnlyRatio_I095_over_I0_in_band = {
      state: limbArm.state,
      pending: limbArm.pending,
      reason: limbArm.reason,
      measured: limbArm.measured,
    };
  }
  return {
    renderer: backend.renderer,
    subLanes: { disc, halo, policy, earthshine, terminator, phase },
    limbArm,
    pendingArms,
    reports: {
      disc: backend.disc ?? null,
      halo: backend.halo ?? null,
      policy: backend.policy ?? null,
      earthshine: backend.earthshine ?? null,
      terminator: backend.terminator ?? null,
      phase: backend.phase ?? null,
    },
    // Headline scalars the fold compares across backends without reaching into
    // a sub-lane's internals.
    parityScalars: {
      discDiameterDeg: backend.disc?.discDiameterDeg ?? null,
      trueSizeRatio: backend.disc?.trueSizeRatio ?? null,
      haloBandMean: backend.halo?.screenBandMean ?? null,
      earthshineMedianDelta: backend.earthshine?.crescent?.medianDelta ?? null,
      fullQuarterRatio: backend.phase?.fullQuarterRatio ?? null,
    },
    parityCounts: {
      terminatorChangedPixels: backend.terminator?.changedPixels ?? null,
      earthshineChangedPixels:
        backend.earthshine?.crescent?.changedPixels ?? null,
    },
    // G4-FIRSTRUN-FIX-2 — which SUB-LANE each parity scalar was harvested from.
    // The fold needs this to apply per-lane scoping to itself: a scalar taken
    // from a lane that could not see its subject is not a number two backends
    // can be compared on. Batch 941 compared webgl's 0.292 deg "disc" — the
    // mis-aimed crop — against webgpu's 0.527 deg and filed the 57% spread as
    // a cross-backend FAILURE.
    paritySources: PARITY_SCALAR_SOURCE_LANE,
    subLaneStructural: Object.fromEntries(
      Object.entries({ disc, halo, policy, earthshine, terminator, phase }).map(
        ([k, v]) => [k, v.structural.length > 0],
      ),
    ),
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
 * Fold the two backends into one G4 verdict.
 *
 * PRECEDENCE, identical to G1/G2/G3: a criterion failure on a backend that
 * COULD see its subject outranks a structural leg, and a structural leg
 * outranks a clean sheet. A backend that passes while the other fails is a FAIL
 * for the gate — every term G4 measures is CPU-resolved before the backend
 * branch, so principle 5 forbids a one-backend pass.
 *
 * @param {{webgl:object,webgpu:object}} evaluated
 * @returns {{verdict:string,exitCode:number,failures:string[],
 *            structural:string[],pendingArms:object,
 *            nonVerdictMisroutes:string[]}}
 *          `nonVerdictMisroutes` is normally empty; a non-empty list names
 *          entries that carried {@link STRUCTURAL_NON_VERDICT_MARKER} yet
 *          reached `failures[]`, and were re-routed
 *          (`G4-FOLLOWUP-STRUCTURAL-PARITY-CHANNEL`).
 */
export function foldG4Verdict(evaluated) {
  const failures = [];
  const structural = [];
  const pendingArms = {};

  for (const renderer of ["webgl", "webgpu"]) {
    const b = evaluated?.[renderer];
    if (!b) {
      structural.push(
        `${renderer} — lane absent; G4 cannot certify shared appearance state`,
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
    for (const [name, arm] of Object.entries(b.pendingArms ?? {})) {
      pendingArms[`${renderer}:${name}`] = arm;
    }
    if (b.structural.length === 0 && Object.keys(b.criteria).length === 0) {
      structural.push(
        `${renderer} — no criterion was evaluated at all; an empty criteria ` +
          "set is not a pass",
      );
    }
  }

  // CROSS-BACKEND PARITY, WITH PER-LANE SCOPING APPLIED TO THE FOLD ITSELF
  // (`G4-FIRSTRUN-FIX-2`). A scalar certifies only when the sub-lane it came
  // from is non-structural on BOTH backends; otherwise it is reported
  // STRUCTURAL BY NAME with both values and the spread still printed. See
  // PARITY_SCALAR_SOURCE_LANE.
  const gl = evaluated?.webgl;
  const gpu = evaluated?.webgpu;
  if (gl && gpu) {
    for (const [name, bound] of [
      ["parityScalars", G4_CROSS_BACKEND_MAX_RELATIVE_SPREAD],
      ["parityCounts", G4_CROSS_BACKEND_MAX_COUNT_SPREAD],
    ]) {
      for (const key of Object.keys(gl[name] ?? {})) {
        const a = gl[name][key];
        const b = gpu[name]?.[key];
        const lane = PARITY_SCALAR_SOURCE_LANE[key] ?? null;
        const blocked = [];
        for (const [renderer, side] of [
          ["webgl", gl],
          ["webgpu", gpu],
        ]) {
          if (lane === null) {
            continue;
          }
          if (side.subLaneStructural?.[lane] === true) {
            blocked.push(renderer);
          }
        }
        if (lane === null) {
          structural.push(
            `cross-backend:${key}_parity — the scalar has no declared source ` +
              "sub-lane, so the fold cannot tell whether the lane that " +
              "produced it could see its subject. Add it to " +
              `PARITY_SCALAR_SOURCE_LANE. ${STRUCTURAL_NON_VERDICT_MARKER}`,
          );
          continue;
        }
        if (blocked.length > 0) {
          structural.push(
            `cross-backend:${key}_parity — STRUCTURAL: its source sub-lane ` +
              `'${lane}' is structural on ${blocked.join(", ")}, so the ` +
              "values below describe a frame that lane declared it could not " +
              `see. MEASURED ANYWAY: webgl ${a}, webgpu ${b}, relative spread ` +
              `${relativeSpread(a, b)}, bound ${bound}. ` +
              STRUCTURAL_NON_VERDICT_MARKER,
          );
          continue;
        }
        if (!Number.isFinite(a) || !Number.isFinite(b)) {
          structural.push(
            `cross-backend:${key}_parity — STRUCTURAL: the scalar is not ` +
              `finite on both backends (webgl ${a}, webgpu ${b}) although ` +
              `sub-lane '${lane}' reported no structural note. A missing ` +
              `number is not agreement. ${STRUCTURAL_NON_VERDICT_MARKER}`,
          );
          continue;
        }
        const spread = relativeSpread(a, b);
        if (!(spread <= bound)) {
          failures.push(
            `cross-backend:${key}_parity (webgl ${a}, webgpu ${b}, relative ` +
              `spread ${spread}, bound ${bound})`,
          );
        }
      }
    }
    // A pending arm must resolve to the SAME state on both backends. One
    // backend certifying an arm the other calls pending would mean the two are
    // running different engine content — EXCEPT when the disagreement is
    // itself a structural gate (`PENDING_AIM`), which is a statement about one
    // backend's disc lane and not about the engine content the arm reads.
    const glState = gl.limbArm?.state;
    const gpuState = gpu.limbArm?.state;
    if (glState !== gpuState) {
      const aimGated =
        glState === ARM_STATE.PENDING_AIM || gpuState === ARM_STATE.PENDING_AIM;
      const note = `cross-backend:limbAbsoluteArm_state (webgl ${glState}, webgpu ${gpuState})`;
      if (aimGated) {
        structural.push(
          `${note} — STRUCTURAL: one backend's DISC sub-lane could not see its ` +
            "subject, so the two arms are gated by different things rather " +
            "than resolving the same discriminators differently. " +
            STRUCTURAL_NON_VERDICT_MARKER,
        );
      } else {
        failures.push(note);
      }
    }
  }

  // ENFORCED INVARIANT + PERMANENT SENTINEL
  // (`G4-FOLLOWUP-STRUCTURAL-PARITY-CHANNEL`). A labelled non-verdict must
  // never be a failure. Every branch above already routes correctly — the
  // filing's premise that they did not is refuted in
  // STRUCTURAL_NON_VERDICT_MARKER's own note — so this is not a point fix but
  // the rule's enforceable home: it holds for branches nobody has written yet.
  //
  // NOT pragma-stripped and NOT silent: a marked entry reaching `failures[]`
  // means the gate was about to report a defect it had itself declared was not
  // one, which is a wrong verdict, not a diagnostic.
  const nonVerdictMisroutes = failures.filter((f) =>
    String(f).includes(STRUCTURAL_NON_VERDICT_MARKER),
  );
  if (nonVerdictMisroutes.length > 0) {
    console.error(
      `[celestial-g4] ${nonVerdictMisroutes.length} labelled non-verdict(s) ` +
        "reached failures[] and were re-routed to the structural channel: " +
        nonVerdictMisroutes.join(" | "),
    );
    for (const entry of nonVerdictMisroutes) {
      failures.splice(failures.indexOf(entry), 1);
      structural.push(entry);
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
  return {
    verdict,
    exitCode,
    failures,
    structural,
    pendingArms,
    nonVerdictMisroutes,
  };
}

/**
 * Maximum length an array may have inside a REPORT before it is treated as a
 * retained image buffer. `G4-FIRSTRUN-FIX-5`.
 *
 * The largest legitimate array in a G4 report is a five-sample shape vector.
 * 4,096 is three orders of magnitude of slack and still four orders below the
 * 2,560,000-element capture arrays this guard exists to catch.
 * @type {number}
 */
export const REPORT_MAX_ARRAY_LENGTH = 4096;

/**
 * PERMANENT SENTINEL — find image buffers retained inside a report object.
 * `G4-FIRSTRUN-FIX-5`.
 *
 * The first G4 run OOM'd a ~3.6 GB default Node heap because all 56 captures
 * (28 per backend, each a 2,560,000-element plain `Array` at 8 bytes an
 * element = 20.5 MB) stayed live until the very end of the run. The structural
 * repair is to consume and release each lane's captures as it completes; this
 * is the check that the repair cannot silently regress by a pixel buffer
 * finding its way into the serialized report instead.
 *
 * Reported as a PATH LIST rather than a boolean so a hit names the field.
 *
 * @param {unknown} value Report object.
 * @param {{maxLength?:number,maxDepth?:number}} [options]
 * @returns {string[]} Dotted paths of offending nodes; empty when clean.
 */
export function findRetainedImageBuffers(value, options = {}) {
  const maxLength = options.maxLength ?? REPORT_MAX_ARRAY_LENGTH;
  const maxDepth = options.maxDepth ?? 12;
  const hits = [];
  const seen = new Set();
  const walk = (node, path, depth) => {
    if (node === null || typeof node !== "object" || depth > maxDepth) {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    if (ArrayBuffer.isView(node)) {
      hits.push(`${path} (${node.constructor.name}[${node.length}])`);
      return;
    }
    if (Array.isArray(node)) {
      if (node.length > maxLength) {
        hits.push(`${path} (Array[${node.length}])`);
        return;
      }
      for (let i = 0; i < node.length; i++) {
        walk(node[i], `${path}[${i}]`, depth + 1);
      }
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      walk(v, path === "" ? k : `${path}.${k}`, depth + 1);
    }
  };
  walk(value, "", 0);
  return hits;
}

/**
 * Build the printed G4 summary. Every bound travels WITH the number it bounds,
 * so a red gate can be read without opening this file.
 *
 * @param {object} result
 * @returns {object}
 */
export function buildG4Summary(result) {
  const backend = (b) =>
    b
      ? {
          criteria: b.criteria,
          structural: b.structural,
          pendingArms: b.pendingArms,
          parityScalars: b.parityScalars,
          parityCounts: b.parityCounts,
          subLaneStructural: b.subLaneStructural,
          limbArm: b.limbArm,
          reports: b.reports,
        }
      : null;
  return {
    gate: "G4",
    verdict: result.verdict,
    exitCode: result.exitCode,
    bounds: {
      SOLAR_ANGULAR_DIAMETER_NOMINAL_DEG,
      SOLAR_ANGULAR_DIAMETER_TOLERANCE,
      DISC_EPHEMERIS_TOLERANCE,
      DISC_AIM_TOLERANCE_PX,
      HALO_AIM_TOLERANCE_PX,
      HALO_AIM_SEARCH_RADIUS_PX,
      LIMB_ABSOLUTE_RATIO_SAMPLE_X,
      EARTHSHINE_INERTNESS_QUANTILE,
      EARTHSHINE_INERTNESS_MIN_MUTANT_CODES,
      PARITY_SCALAR_SOURCE_LANE,
      STRUCTURAL_NON_VERDICT_MARKER,
      TRUE_SIZE_RATIO_NOMINAL,
      TRUE_SIZE_RATIO_TOLERANCE,
      LIMB_SHAPE_SAMPLE_X,
      LIMB_SHAPE_MAX_REL_DEV,
      LIMB_CENTRE_MAX_RELATIVE,
      LIMB_OUTSIDE_MAX_RELATIVE,
      LIMB_MIN_DROP_LINEAR,
      LIMB_ABSOLUTE_RATIO_BAND,
      LIMB_DISC_ONLY_ANNULUS,
      LIMB_DISC_ONLY_CENTRE_RADIUS_PX,
      LIMB_BAND_MODEL_DISC_RADIUS_PX,
      LIMB_DISC_RADIANCE_RECOVERY_TOLERANCE,
      DISC_BRACKET_EXPOSURES,
      SUN_BAKE_BLUE_HUE_OFFSET,
      SUN_BAKE_GAMMA_NOMINAL,
      C12_19_HDR_PEAK_DISCRIMINATOR,
      HALO_DELTA_PEAK_NOMINAL_RSUN,
      HALO_DELTA_PEAK_TOLERANCE_RSUN,
      HALO_BAND_RSUN,
      HALO_SHAPE_SAMPLE_RSUN,
      HALO_SHAPE_MAX_REL_DEV,
      HALO_TAIL_SLOPE_BAND,
      HALO_MIN_BAND_RADIANCE,
      HALO_BAKE_BAND_MAX_RADIANCE,
      HDR_EXPECTED_POLICY,
      MOON_PHASE_TARGETS,
      MOON_PHASE_TARGET_TOLERANCE,
      MOON_FULL_MIN_PHASE_FRACTION,
      SURGE_REACHABLE_MAX_PHASE_ANGLE_DEG,
      MOON_FULL_QUARTER_RATIO_MIN,
      MOON_PHASE_ORDERING_MIN_RATIO,
      EARTHSHINE_TINT_BR_NOMINAL,
      EARTHSHINE_TINT_GR_NOMINAL,
      EARTHSHINE_TINT_MAX_REL_DEV,
      EARTHSHINE_MIN_MEDIAN_DELTA,
      EARTHSHINE_MIN_CHANGED_PIXELS,
      EARTHSHINE_PHASE_SCALING_MAX_REL_DEV,
      EARTHSHINE_INERTNESS_FACTOR,
      TERMINATOR_SOFTNESS_BAND,
      TERMINATOR_DELTA_EPS,
      TERMINATOR_MIN_CHANGED_PIXELS,
      TERMINATOR_MAX_DARKENED_PIXELS,
      TERMINATOR_MAX_BAND_FRACTION,
      TERMINATOR_MIN_DISC_PIXELS,
      MOON_DISC_MASK_FRACTION,
      MOON_UNLIT_MASK_FRACTION,
      MOON_UNLIT_DARK_FLOOR,
      MOON_AIM_TOLERANCE_PX,
      G4_CROSS_BACKEND_MAX_RELATIVE_SPREAD,
      G4_CROSS_BACKEND_MAX_COUNT_SPREAD,
    },
    failures: result.failures,
    structural: result.structural,
    // Normally `[]`. Printed unconditionally so a reader can see the invariant
    // was CHECKED rather than infer it from an absence
    // (`G4-FOLLOWUP-STRUCTURAL-PARITY-CHANNEL`).
    nonVerdictMisroutes: result.nonVerdictMisroutes ?? [],
    pendingArms: result.pendingArms,
    backends: {
      webgl: backend(result.backends?.webgl),
      webgpu: backend(result.backends?.webgpu),
    },
  };
}

export default {
  EXIT_CODE,
  ARM_STATE,
  PENDING_CONTENT,
  inBand,
  relativeSpread,
  relativeDeviation,
  median,
  logLogSlope,
  angleDegForPixelOffset,
  luminanceAt,
  differenceImage,
  positiveCentroid,
  radialProfile,
  profileAt,
  outerCrossingRadius,
  innerCrossingRadius,
  annulusMean,
  unlitLimbDelta,
  discDeltaCensus,
  discIntegratedBrightness,
  captureCodeQuantumLinear,
  chooseBracketLeg,
  bracketQuantumAt,
  buildAimDiagnostic,
  describeAimMiss,
  expectedCompositeLimbRatio,
  solarDiscChainLuminance,
  deriveDiscOnlyLimbBand,
  findRetainedImageBuffers,
  screenMinusBakedPeak,
  limbShapeExpectation,
  haloShapeExpectation,
  shapeDeviation,
  brightestWithinRadius,
  measureDiscDifferential,
  measureHaloProfile,
  evaluateLimbAbsoluteArm,
  evaluateDiscSubLane,
  evaluateHaloSubLane,
  evaluatePolicySubLane,
  evaluateEarthshineSubLane,
  evaluateTerminatorSubLane,
  evaluatePhaseSubLane,
  evaluateG4Backend,
  foldG4Verdict,
  buildG4Summary,
};
