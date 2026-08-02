/**
 * CPU-side estimator that maps sun + moon altitude (relative to the local
 * up at the camera) to a 0..1 sky brightness scalar. Phase 1.3 of the
 * celestial atmosphere design uses this to drive star modulation in the
 * cubemap panorama shader and (later) night-sky dimming in the sky
 * atmosphere shader.
 *
 * C12-34 (NEW-SKY-BRIGHTNESS-ESTIMATOR-NO-TWILIGHT-RANGE) replaced the
 * original double-smoothstep with a log-luminance model: the sun term is a
 * published zenith sky-brightness-vs-solar-depression curve (V mag/arcsec²,
 * the standard twilight photometry of Patat et al. 2006-class measurements),
 * the moon term is the published full-moon sky brightness scaled by a
 * measured phase-flux law, the two are summed in LINEAR luminance, and the
 * combined log-luminance is mapped to the published 0..1 scalar through a
 * perceptual transfer derived from the naked-eye limiting-magnitude (NELM)
 * relation (Crumey 2014). The original sun smoothstep reached EXACTLY 0 once
 * the sun was below −5.74° and therefore carried no dynamic range at all
 * across the twilight decade — civil twilight, nautical twilight and
 * astronomical night all collapsed to the same input value. See
 * `computeSkyBrightnessFromZenithMagnitude` for the full derivation.
 *
 * The estimate is intentionally cheap — a few dot products, one or two
 * pow/log pairs and a trig inverse — so it can run unconditionally in
 * `Scene.updateFrameState()` once per frame. A GPU readback of actual
 * rendered sky color would be more accurate but cost an extra round-trip;
 * for star modulation this approximation is indistinguishable from the
 * truth at any reasonable viewing distance.
 *
 * Why not put this on `AtmosphericConditions`? It's a derived per-frame
 * value, not a configuration knob. The B-series toggles live on
 * `AtmosphericConditions`; the *result* of running them lives on
 * `frameState`.
 *
 * @private
 * @module SkyBrightness
 */

import defined from "../Core/defined.js";

/**
 * Altitude at which the remaining Rayleigh column stops mattering, metres.
 * The engine's own default Rayleigh scale height is 10 km
 * (`SkyAtmosphere.atmosphereRayleighScaleHeight`), so at 60 km the density is
 * `exp(-6) = 2.5e-3` of sea level: less than 0.3% of the scattering column
 * remains above it.
 * @type {number}
 * @private
 */
const ATMOSPHERIC_COLUMN_FADE_START = 60000.0;

/**
 * Altitude at which the engine has no scattering medium AT ALL, metres. This
 * is `ATMOSPHERE_THICKNESS` — the shell thickness `czm_computeScattering` and
 * `SkyAtmosphere.wgsl` both integrate over (inner + 111e3). Above it the sky
 * shaders return no inscatter, so an estimator that still reported a bright
 * sky would contradict the pixels.
 * @type {number}
 * @private
 */
const ATMOSPHERIC_COLUMN_FADE_END = 111000.0;

/**
 * How much scattering column sits above the camera, as a 0..1 scale on the
 * whole sky-brightness estimate.
 *
 * C12-29 S6 / ruling E3. `computeSkyBrightness` is a SKY brightness — it is
 * produced by sunlight scattering in the air above the observer. Above the
 * atmosphere there is no such air, the sky is black, and stars are visible on
 * the day side; that is why `StarFieldMath.computeStarDayFade` has carried a
 * 100 km cutoff for the sprite starfield since it was written. Without the
 * same gate here, flipping `enableStarBrightnessModulation` on by default
 * would have zeroed the star cubemap across the entire sunlit hemisphere for
 * an orbital camera — the exact regression C11-176 turned the flag off for.
 *
 * A ramp rather than `computeStarDayFade`'s hard cut, so a camera climbing
 * through the boundary does not pop; the sibling's 100 km step sits inside the
 * band.
 *
 * The caller supplies ellipsoidal height rather than asking this helper to
 * subtract a hard-coded Earth radius from an ECEF magnitude. Scene already
 * maintains `camera.positionCartographic.height`; using it is both cheaper and
 * correct at every latitude and for custom globe ellipsoids.
 *
 * @param {number|undefined} cameraHeight Ellipsoidal camera height in metres.
 * @returns {number} 1.0 at and below {@link ATMOSPHERIC_COLUMN_FADE_START},
 *   0.0 at and above {@link ATMOSPHERIC_COLUMN_FADE_END}, smooth between.
 */
export function computeAtmosphericColumnFactor(cameraHeight) {
  if (typeof cameraHeight !== "number" || !Number.isFinite(cameraHeight)) {
    return 1.0;
  }
  return (
    1.0 -
    smoothstep(
      ATMOSPHERIC_COLUMN_FADE_START,
      ATMOSPHERIC_COLUMN_FADE_END,
      cameraHeight,
    )
  );
}

/**
 * Standard smoothstep — same Hermite curve `smoothstep` from GLSL/WGSL.
 *
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number}
 * @private
 */
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Exact analytic inverse of `smoothstep(0, 1, t)` — solves
 * `3t² − 2t³ = x` for `t` on [0, 1] via the trigonometric cubic root:
 * `t = 0.5 − sin(asin(1 − 2x) / 3)`.
 *
 * @param {number} x Smoothstep output in [0, 1] (clamped).
 * @returns {number} The `t` in [0, 1] with `smoothstep(0, 1, t) === x`.
 * @private
 */
function inverseSmoothstep(x) {
  const y = x < 0.0 ? 0.0 : x > 1.0 ? 1.0 : x;
  return 0.5 - Math.sin(Math.asin(1.0 - 2.0 * y) / 3.0);
}

// ─── C12-34 — log-luminance twilight model ──────────────────────────────────
//
// The model works in zenith sky brightness μ, V magnitudes per arcsec² — the
// unit published twilight photometry is measured in. Larger μ = darker sky;
// μ is a LOG-luminance (each +2.5 μ is a 10× drop in luminance).

/**
 * Zenith sky brightness of the reference moonless rural night, V mag/arcsec².
 * This is the Bortle-4 "countryside" sky the ruling-E3 star machinery is
 * anchored to: Crumey (2014, MNRAS 442:2600) pairs ~21.9-22.0 mag/arcsec²
 * with the NELM 6.5 reference limit `StarFieldMath` carries as
 * `STAR_REFERENCE_LIMITING_MAGNITUDE`.
 * @type {number}
 * @private
 */
export const NIGHT_ZENITH_MAGNITUDE = 21.9;

/**
 * Zenith sky brightness of full clear daylight, V mag/arcsec² (~3-4 in the
 * literature for a high sun; the day end of the published day-night sky range
 * of ~18 magnitudes ≈ a 1.5e7 : 1 luminance ratio).
 * @type {number}
 * @private
 */
export const DAY_ZENITH_MAGNITUDE = 4.0;

/**
 * Zenith sky brightness under a full moon at the zenith, V mag/arcsec².
 * The published moonlit-sky value (~18) sits ~3.9 magnitudes above the
 * moonless night sky. Through the NELM slope below this reproduces the
 * published full-moon naked-eye limit of ≈4.5 — the anchor the C12-34 queue
 * row cites — as a DERIVED value: 6.5 − 0.5·(21.9 − 18.0) = 4.55.
 * @type {number}
 * @private
 */
export const FULL_MOON_ZENITH_MAGNITUDE = 18.0;

/**
 * Naked-eye limiting-magnitude loss per magnitude/arcsec² of sky brightening
 * — the local slope of the Crumey/Schaefer NELM ↔ surface-brightness
 * relation in the mesopic regime. Validated internally at both ends: μ 21.9
 * → NELM 6.5 (the rural reference) and μ 18.0 → NELM 4.55 (published
 * full-moon ≈ 4.5).
 * @type {number}
 * @private
 */
export const NELM_PER_ZENITH_MAGNITUDE = 0.5;

/**
 * Moonlight flux vs illuminated fraction `p`, as `p^exponent`. The quarter
 * moon (p = 0.5) delivers ≈ 8% of full-moon illuminance (Allen,
 * Astrophysical Quantities — the non-Lambertian lunar phase curve plus the
 * opposition surge), and `0.5^3.64 = 0.0802`. The old estimator scaled
 * moonlight LINEARLY with p, overstating a quarter moon's sky ~6×.
 * @type {number}
 * @private
 */
export const MOON_PHASE_FLUX_EXPONENT = 3.64;

/**
 * Added zenith luminance of the full moon in units of the moonless night
 * sky: `10^(0.4·(21.9 − 18.0)) − 1 ≈ 35.31`. The `− 1` removes the night
 * baseline so a moonless frame is EXACTLY the night sky.
 * @type {number}
 * @private
 */
const FULL_MOON_ADDED_LUMINANCE =
  Math.pow(10.0, 0.4 * (NIGHT_ZENITH_MAGNITUDE - FULL_MOON_ZENITH_MAGNITUDE)) -
  1.0;

/**
 * sin(solar altitude) at which the day sky saturates to
 * {@link DAY_ZENITH_MAGNITUDE}. 0.4 (≈ +23.6°) is deliberately the SAME
 * saturation point the original smoothstep's upper edge had, so the day-side
 * behaviour of the estimator is unchanged in character.
 * @type {number}
 * @private
 */
const DAY_SATURATION_SINE = 0.4;

/**
 * Twilight zenith-brightness anchors: [sin(solar altitude), μ]. Piecewise
 * linear between them; exactly {@link NIGHT_ZENITH_MAGNITUDE} at and below
 * −18° (end of astronomical twilight — the sun term is exactly zero there,
 * which keeps deep night bit-exact); linear from 8.0 at the horizon to
 * {@link DAY_ZENITH_MAGNITUDE} at {@link DAY_SATURATION_SINE} on the day
 * side.
 *
 * The values are the standard zenith twilight photometry curve (e.g. Patat
 * et al. 2006, A&A 455:385, and the classical twilight-illuminance ladder:
 * sunset ~400 lux, end of civil ~3.4 lux, end of nautical ~0.008 lux):
 * sunset ≈ 8, end of civil twilight (−6°) ≈ 14, end of nautical (−12°)
 * ≈ 19.7 — a ~1 mag/degree decay through civil+nautical twilight — then a
 * flattening tail into the −18° night level. This is the dynamic range the
 * pre-C12-34 estimator did not have.
 * @type {number[][]}
 * @private
 */
const TWILIGHT_ANCHORS = [
  [Math.sin((-18.0 * Math.PI) / 180.0), NIGHT_ZENITH_MAGNITUDE],
  [Math.sin((-12.0 * Math.PI) / 180.0), 19.7],
  [Math.sin((-6.0 * Math.PI) / 180.0), 14.0],
  [0.0, 8.0],
];

/**
 * Duplicates of the star-modulation curve constants
 * (`StarFieldMath.STAR_MODULATION_INFLECTION` / `_STEEPNESS`). They live here
 * as module constants because `StarFieldMath.ts` already imports from this
 * module (`computeAtmosphericColumnFactor`) — importing back would create a
 * cycle. `sky-brightness-twilight.spec.mjs` and
 * `eclipse-sky-totality.spec.mjs` assert the two pairs stay identical, the
 * same enforced-identity pattern K_HALO uses against the shader constant.
 * @type {number}
 * @private
 */
const STAR_CURVE_INFLECTION = 0.0;

/**
 * See {@link STAR_CURVE_INFLECTION}.
 * @type {number}
 * @private
 */
const STAR_CURVE_STEEPNESS = 23.0;

/**
 * μ at which the perceptual transfer switches from the star-visibility law
 * to the plain daylight ramp — the sunset anchor. Above this brightness
 * (μ < 8) no naked-eye star survives anyway (NELM ≈ −0.45 at μ = 8), so the
 * scalar is free to sweep the remaining range up to 1.0 = noon.
 * @type {number}
 * @private
 */
const STAR_WINDOW_FLOOR_MAGNITUDE = 8.0;

/**
 * Precomputed transfer value at {@link STAR_WINDOW_FLOOR_MAGNITUDE}
 * (≈ 0.0424475), the join point of the two transfer segments.
 * @type {number}
 * @private
 */
const STAR_WINDOW_FLOOR_BRIGHTNESS =
  STAR_CURVE_INFLECTION +
  inverseSmoothstep(
    1.0 -
      Math.pow(
        10.0,
        -0.4 *
          NELM_PER_ZENITH_MAGNITUDE *
          (NIGHT_ZENITH_MAGNITUDE - STAR_WINDOW_FLOOR_MAGNITUDE),
      ),
  ) /
    STAR_CURVE_STEEPNESS;

/**
 * sin(altitude) of a world-space direction above the local horizon at the
 * camera — THE single home of the solar-elevation derivation (C12-34; the
 * C15 aurora campaign reuses this edge). Local up is approximated as the
 * normalized camera position vector, which is exact on a sphere and within
 * sub-degree of accurate on the WGS84 ellipsoid for any near-surface camera.
 *
 * DEGENERATE-INPUT POLICY (one policy for the whole module): anything this
 * helper cannot answer becomes `undefined`, and every caller resolves
 * `undefined` toward the FULL-BRIGHT end. That is the historical contract the
 * origin-camera guard in {@link computeSkyBrightness} already stated — a
 * misconfigured scene must not silently dim the stars to black — and the
 * log-luminance model has to keep it, because its own "no sun" value is the
 * DARK end and would otherwise invert the policy on a NaN.
 *
 * @param {Cartesian3|undefined} directionWC Unit direction in world (ECEF)
 *   coordinates (sun, moon, …).
 * @param {Cartesian3|undefined} cameraPositionWC Camera position in world
 *   coordinates.
 * @returns {number|undefined} The sine of the direction's altitude, or
 *   `undefined` when either input is missing, the camera sits at the planet
 *   center (no meaningful "up"), or either input carries a non-finite
 *   component.
 */
export function computeCelestialElevationSine(directionWC, cameraPositionWC) {
  if (!defined(directionWC) || !defined(cameraPositionWC)) {
    return undefined;
  }
  const upX = cameraPositionWC.x;
  const upY = cameraPositionWC.y;
  const upZ = cameraPositionWC.z;
  const upMag = Math.sqrt(upX * upX + upY * upY + upZ * upZ);
  if (!(upMag >= 1e-6)) {
    // `!(x >= e)` rather than `x < e` so a NaN magnitude takes this branch.
    return undefined;
  }
  const invMag = 1.0 / upMag;
  const sine =
    directionWC.x * (upX * invMag) +
    directionWC.y * (upY * invMag) +
    directionWC.z * (upZ * invMag);
  return Number.isFinite(sine) ? sine : undefined;
}

/**
 * The published zenith sky brightness (V mag/arcsec²) produced by the sun at
 * a given altitude — piecewise linear through {@link TWILIGHT_ANCHORS},
 * exactly {@link NIGHT_ZENITH_MAGNITUDE} at and below −18°, linear from the
 * sunset value to {@link DAY_ZENITH_MAGNITUDE} at
 * {@link DAY_SATURATION_SINE} and saturated above it.
 *
 * @param {number} sinAltitude sin(solar altitude). A non-finite value returns
 *   {@link DAY_ZENITH_MAGNITUDE} — the module's one degenerate-input policy
 *   (see {@link computeCelestialElevationSine}), reached only by a direct
 *   external call because `computeSkyBrightness` resolves the same case
 *   earlier.
 * @returns {number} Zenith sky brightness μ in V mag/arcsec².
 */
export function computeTwilightZenithMagnitude(sinAltitude) {
  if (!Number.isFinite(sinAltitude)) {
    return DAY_ZENITH_MAGNITUDE;
  }
  if (sinAltitude <= TWILIGHT_ANCHORS[0][0]) {
    return NIGHT_ZENITH_MAGNITUDE;
  }
  if (sinAltitude >= DAY_SATURATION_SINE) {
    return DAY_ZENITH_MAGNITUDE;
  }
  if (sinAltitude >= 0.0) {
    // Horizon → day saturation: 8.0 → 4.0 linearly in sin(altitude).
    const daySlope =
      (TWILIGHT_ANCHORS[TWILIGHT_ANCHORS.length - 1][1] -
        DAY_ZENITH_MAGNITUDE) /
      DAY_SATURATION_SINE;
    return (
      TWILIGHT_ANCHORS[TWILIGHT_ANCHORS.length - 1][1] - daySlope * sinAltitude
    );
  }
  for (let i = 1; i < TWILIGHT_ANCHORS.length; i++) {
    if (sinAltitude <= TWILIGHT_ANCHORS[i][0]) {
      const s0 = TWILIGHT_ANCHORS[i - 1][0];
      const m0 = TWILIGHT_ANCHORS[i - 1][1];
      const s1 = TWILIGHT_ANCHORS[i][0];
      const m1 = TWILIGHT_ANCHORS[i][1];
      return m0 + ((m1 - m0) * (sinAltitude - s0)) / (s1 - s0);
    }
  }
  // sinAltitude in (last twilight anchor, 0) is unreachable — the last
  // anchor IS 0 — but a fall-through must stay monotone.
  return TWILIGHT_ANCHORS[TWILIGHT_ANCHORS.length - 1][1];
}

/**
 * Perceptual transfer: combined zenith log-luminance μ → the published 0..1
 * sky-brightness scalar.
 *
 * The scalar's ONLY shipped consumer contract is the star-brightness
 * modulation curve `1 − smoothstep(0, 1, (B − inflection)·steepness)`
 * (ruling E3; four lockstep implementations), and Scene's published channel
 * multiplies the scalar by S2's `eclipseSceneLightFactor` whose totality
 * value `ECLIPSE_TWILIGHT_FLOOR = 0.0368403` must keep mapping to the
 * ratified −3.00 mag star reveal. Those two fixed points pin the curve
 * constants at (inflection 0, steepness 23.0) — the C12-34 re-derivation
 * CONFIRMS the shipped pair rather than moving it — and therefore pin the
 * star-visibility window of the scalar to [0, 1/23]. The published
 * photometry consequently enters through THIS transfer: for every μ in the
 * star window the transfer emits exactly the scalar whose curve output is
 * the NELM-chain star-visibility factor
 *
 *   factor(μ) = 10^(−0.4 · NELM_PER_ZENITH_MAGNITUDE · (μ_night − μ))
 *
 * i.e. `B(μ) = inflection + invSmoothstep(1 − factor(μ)) / steepness`. That
 * makes the composition `modulation(B(μ))` reproduce published naked-eye
 * limits EXACTLY at every anchor: μ 21.9 → NELM 6.5 (rural night), μ 18.0
 * → 4.55 (full moon, published ≈ 4.5), μ 14 (−6°) → 2.55, μ 10 (−2°) →
 * 0.55 — "Venus and one or two first-magnitude stars", the C12-34 civil
 * twilight demand — with monotone, band-separated values through the whole
 * twilight decade the old estimator collapsed to 0.
 *
 * Above the μ = 8 sunset anchor (NELM −0.45; no naked-eye stars) the
 * transfer leaves the star window and sweeps the remaining scalar range
 * linearly to 1.0 at the μ = 4 full-daylight level, preserving the "0 =
 * night, 1 = noon" semantic for future consumers. Both endpoints are exact:
 * μ ≥ 21.9 → 0.0 and μ ≤ 4 → 1.0 bit-exactly, which keeps deep night
 * byte-identical and keeps the S2 totality product exactly
 * `1.0 × ECLIPSE_TWILIGHT_FLOOR`.
 *
 * @param {number} zenithMagnitude Combined zenith sky brightness μ in
 *   V mag/arcsec². A non-finite value returns 1.0 — the module's one
 *   degenerate-input policy (see {@link computeCelestialElevationSine}).
 * @returns {number} Sky brightness scalar in [0, 1].
 */
export function computeSkyBrightnessFromZenithMagnitude(zenithMagnitude) {
  if (!Number.isFinite(zenithMagnitude)) {
    return 1.0;
  }
  if (zenithMagnitude >= NIGHT_ZENITH_MAGNITUDE) {
    return 0.0;
  }
  if (zenithMagnitude <= DAY_ZENITH_MAGNITUDE) {
    return 1.0;
  }
  if (zenithMagnitude >= STAR_WINDOW_FLOOR_MAGNITUDE) {
    const factor = Math.pow(
      10.0,
      -0.4 *
        NELM_PER_ZENITH_MAGNITUDE *
        (NIGHT_ZENITH_MAGNITUDE - zenithMagnitude),
    );
    return (
      STAR_CURVE_INFLECTION +
      inverseSmoothstep(1.0 - factor) / STAR_CURVE_STEEPNESS
    );
  }
  return (
    STAR_WINDOW_FLOOR_BRIGHTNESS +
    ((1.0 - STAR_WINDOW_FLOOR_BRIGHTNESS) *
      (STAR_WINDOW_FLOOR_MAGNITUDE - zenithMagnitude)) /
      (STAR_WINDOW_FLOOR_MAGNITUDE - DAY_ZENITH_MAGNITUDE)
  );
}

/**
 * Compute the sky brightness scalar for the current frame.
 *
 * The model is two-source: a daylight/twilight term driven by the sun's
 * altitude relative to the local horizon (the published zenith
 * twilight-photometry curve), and a moon term scaled by the moon's
 * altitude AND a photometric phase-flux law (so a new moon contributes
 * nothing even when overhead). The two are summed in LINEAR luminance —
 * relative to the moonless night sky — and the combined log-luminance is
 * mapped through {@link computeSkyBrightnessFromZenithMagnitude}.
 *
 * Local up is approximated as the normalized camera position vector,
 * which is exact on a sphere and within sub-degree of accurate on the
 * WGS84 ellipsoid for any near-surface camera. Off-planet cameras
 * (lunar orbit, deep space) get the same formula — the result is
 * still meaningful as "how bright the sky LOOKS to me here".
 *
 * @param {Cartesian3|undefined} sunDirWC Sun direction in world (ECEF)
 *   coordinates, normalized. Pass `undefined` to skip sun contribution.
 * @param {Cartesian3|undefined} moonDirWC Moon direction in world (ECEF)
 *   coordinates, normalized. Pass `undefined` to skip moon contribution.
 *   Scene publishes the current frame's value through `Moon.update()` before
 *   calling this estimator.
 * @param {number} moonPhaseFraction Moon illuminated fraction in [0..1].
 *   0 = new moon (no contribution), 1 = full moon. When `enableMoonPhase`
 *   is off this should be passed as `1.0` so the moon term acts as a
 *   constant (matching the legacy "always-full" assumption).
 * @param {Cartesian3} cameraPositionWC Camera position in world coords,
 *   used to derive local up. Must be non-zero — the function returns
 *   `1.0` (full bright) for a degenerate origin camera.
 * @param {number} [cameraHeight=0.0] Ellipsoidal camera height in metres.
 *   Scene passes `camera.positionCartographic.height`, which keeps the
 *   atmospheric-column ramp correct for WGS84 latitude and custom ellipsoids.
 * @returns {number} Sky brightness in [0..1]. `0` = full astronomical
 *   night, `1` = noon under a clear sky.
 */
export function computeSkyBrightness(
  sunDirWC,
  moonDirWC,
  moonPhaseFraction,
  cameraPositionWC,
  cameraHeight = 0.0,
) {
  if (!defined(cameraPositionWC)) {
    return 1.0;
  }

  const upMag = Math.sqrt(
    cameraPositionWC.x * cameraPositionWC.x +
      cameraPositionWC.y * cameraPositionWC.y +
      cameraPositionWC.z * cameraPositionWC.z,
  );
  if (!(upMag >= 1e-6)) {
    // Camera at the planet center — no meaningful "up" direction. (`!(x >= e)`
    // so a NaN position takes this branch too.) Return full bright so star
    // modulation doesn't dim everything to black for a misconfigured scene.
    return 1.0;
  }

  // Sun contribution: the published twilight zenith-brightness curve of
  // solar altitude. Exactly the night level at and below −18° (end of
  // astronomical twilight), continuous dynamic range through the civil /
  // nautical / astronomical bands, saturating to full daylight at the same
  // +23.6° the original smoothstep saturated at.
  let sunMagnitude = NIGHT_ZENITH_MAGNITUDE;
  if (defined(sunDirWC)) {
    const sunAlt = computeCelestialElevationSine(sunDirWC, cameraPositionWC);
    if (sunAlt === undefined) {
      // A sun direction was supplied but yields no finite elevation. The
      // pre-C12-34 double-smoothstep answered that with 1.0 (NaN failed its
      // final `total < 1.0` test); the log-luminance model's own "no sun"
      // value is the DARK end, so the policy has to be restated explicitly
      // here or a NaN would invert it into a bright, starry midnight.
      return 1.0;
    }
    sunMagnitude = computeTwilightZenithMagnitude(sunAlt);
  }

  // Moon contribution, in linear luminance relative to the night sky. The
  // altitude ramp keeps its historical shape (horizon extinction and
  // geometry approximation); the magnitude is now the published full-moon
  // sky brightness and the phase scaling the published phase-flux law
  // rather than a flat 4% perceptual constant.
  let moonLuminance = 0.0;
  if (defined(moonDirWC) && moonPhaseFraction > 0) {
    const moonAlt = computeCelestialElevationSine(moonDirWC, cameraPositionWC);
    if (moonAlt !== undefined) {
      const moonAboveHorizon = smoothstep(-0.05, 0.15, moonAlt);
      if (moonAboveHorizon > 0.0) {
        moonLuminance =
          FULL_MOON_ADDED_LUMINANCE *
          Math.pow(moonPhaseFraction, MOON_PHASE_FLUX_EXPONENT) *
          moonAboveHorizon;
      }
    }
  }

  // Combine the sources in LINEAR luminance, then return to log-luminance.
  // The moonless path skips the exp/log round trip entirely — not just for
  // speed: it keeps the sun-only μ bit-exact, so deep night is exactly 0.0
  // and a saturated day is exactly 1.0 (the S2 totality anchor multiplies
  // the day value by ECLIPSE_TWILIGHT_FLOOR and needs it to be exactly 1).
  let zenithMagnitude;
  if (moonLuminance > 0.0) {
    const sunLuminance =
      Math.pow(10.0, 0.4 * (NIGHT_ZENITH_MAGNITUDE - sunMagnitude)) - 1.0;
    zenithMagnitude =
      NIGHT_ZENITH_MAGNITUDE -
      2.5 * Math.log10(1.0 + sunLuminance + moonLuminance);
  } else {
    zenithMagnitude = sunMagnitude;
  }

  const clamped = computeSkyBrightnessFromZenithMagnitude(zenithMagnitude);
  // C12-29 S6 / ruling E3 — no scattering column above the camera means no
  // sky brightness, whatever the sun is doing. Exactly 1.0 (bit-exact
  // multiply) for every camera below 60 km, i.e. every in-atmosphere frame.
  return clamped * computeAtmosphericColumnFactor(cameraHeight);
}

export default computeSkyBrightness;
