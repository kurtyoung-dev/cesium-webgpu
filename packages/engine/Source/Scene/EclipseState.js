// Per-frame eclipse and occultation state, computed on the CPU and shared by
// both backends.
//
// This module computes, once per frame in f64, how much of the sun the camera
// can actually see, and publishes it on `frameState.eclipseState`. It runs
// unconditionally — a few tens of flops in the common case where nothing
// occludes anything — and the `enableEclipse` toggle gates only the
// application of the result, so a probe can read the physics with the effect
// switched off.
//
// Published contract (`frameState.eclipseState`, one object mutated in place
// and never reallocated, so consumers may hold the reference):
//
//   enabled                 boolean  atmosphericConditions.lighting.enableEclipse
//   autoExposure            boolean  atmosphericConditions.lighting.eclipseAutoExposure
//   sunVisibleFraction      [0,1]    limb-darkened surviving flux, camera-anchored
//   earthOcclusionFraction  [0,1]    flux removed by the Earth limb alone
//   moonObscuration         [0,1]    flux removed by the lunar disc alone
//   moonPositionWC          Cartesian3  ECEF metres, the per-fragment umbra input
//   sunPositionWC           Cartesian3  ECEF metres, the position actually used
//   sunAngularRadius        radians
//   earthAngularRadius      radians  (0 when the Earth term is gated off)
//   moonAngularRadius       radians
//   earthSeparation         radians  camera->nadir vs camera->sun
//   moonSeparation          radians  camera->moon vs camera->sun
//   eclipseMagnitude        >= 0     lunar magnitude, >= 1 means totality
//   horizonTwilightEnabled  boolean  atmosphericConditions.lighting.enableEclipseHorizonTwilight
//   horizonTwilightStrength [0,1]    the 360-degree horizon glow, geometry only
//   valid                   boolean  false when inputs were missing this frame
//
// Two occluders, one integrand. Both terms come from
// `computeSolarObscuration` — limb-darkened circle-circle overlap; see that
// module for the dual-cone umbra/penumbra/antumbra mapping and the
// limb-darkening law. Combining them uses the independent-attenuation form
//
//   sunVisibleFraction = (1 - earthOcclusionFraction) * (1 - moonObscuration)
//
// which is exact whenever either term is 0 or 1 — every single-occluder
// configuration, which is every configuration that occurs outside a lunar
// transit happening within a fraction of a degree of the Earth limb. It is
// continuous, monotone in both inputs and cannot leave [0,1]. Spatially
// correct treatment of simultaneous overlapping occluders is a per-fragment
// problem and not a camera-anchored scalar's job.
//
// The Earth term is gated on exactly the conditions that build the engine's
// occluder — SCENE3D, globe shown, camera not underground, globe not
// translucent (`SceneUtilities.getOccluder`) plus
// `GlobeTranslucencyState.sunVisibleThroughGlobe` (`Scene.js`). The caller
// passes `earthOccluderRadius = undefined` when any of those fails, and the
// Earth term is then exactly 0, which keeps the sun always visible in
// translucent and hidden-globe scenes.
//
// The whole computation additionally requires `options.active`, which the
// caller passes false outside `SceneMode.SCENE3D`: in 2D, Columbus view and
// MORPHING the camera position is in projected map coordinates while the sun
// and moon are ECEF. Gating only the Earth term there would leave the moon
// term running on mixed frames, with direction errors up to about 1.5 deg —
// several solar diameters.
//
// Scene normally supplies both world positions from FrameState's one shared,
// branded Earth-fixed sample. Local Simon1994 derivation remains for direct or
// bare callers, and for Scene's legacy central-body-hook lane where the
// implicit sample is deliberately suppressed. That fallback mirrors Moon's
// established Earth-fixed ICRF/TEME path; it does not apply UniformState's
// documented central-body hook.
//
// `Scene.render` publishes the eclipse state before
// `uniformState.update(frameState)`, and must: `UniformState` is itself one of
// the sample consumers, and its update is re-entered several times per frame
// — picking, viewport executor, offscreen views — so a factor applied
// afterwards would be silently dropped by every one of those re-entries.
//
// Scene dimming (`getEclipseSceneLightFactor`) uses a different combination.
// Fading the sun billboard by `sunVisibleFraction` correctly folds in the
// Earth limb, because the disc is genuinely hidden behind the Earth from that
// camera. Dimming the world must not use the Earth term at all:
//
//   `earthOcclusionFraction` is 1 for every night frame and for most of
//   twilight. A ground camera's Earth occluder subtends about 85-86 deg — it
//   is built from `ellipsoid.minimumRadius`, so its limb sits several degrees
//   below the true horizon — and the term saturates once the sun is a few
//   degrees below the horizontal. Multiplying scene light or atmosphere
//   intensity by `1 - earthOcclusionFraction` would black out civil twilight,
//   every sunrise and sunset gradient, and the day side of the globe as seen
//   from a night-side orbital camera. The engine already models "the Earth is
//   between me and the sun" per fragment, through N dot L and the day/night
//   terminator, and a global multiplier would double-count it.
//
// So the scene factor is driven by `moonObscuration` alone — the solar
// eclipse proper. It stays camera-anchored, which is the right first order:
// the umbra is only 100-160 km wide, so a camera that sees a fully obscured
// sun is, to within the approximation, standing in the shadow.
//
// The curve is linear in the limb-darkened flux fraction, with no smoothstep
// and no invented easing. Obscuration is the physical quantity; a
// magnitude-keyed darkening would not be.
//
//   f    = 1 - moonObscuration                              (photometric)
//   flux = f + ECLIPSE_RADIOMETRIC_FLOOR * (1 - f)          (== f exactly at f == 1)
//
// Totality is civil twilight, not night: about 5 lux against about 100,000
// lux for full sun, and a full-moon night is roughly ten times darker still.
// `ECLIPSE_RADIOMETRIC_FLOOR = 5 / 100000` stands in for the light the
// camera-anchored model cannot compute — the umbral sky lit by multiple
// scattering from outside the umbra, which is nonlocal and would need a
// precomputed eclipse-shadow extension of the atmosphere model. It is what
// keeps the multiplier bounded away from zero.
//
// The default is the human-eye impression: no camera re-metering, so the
// plunge is preserved. The default display transform performs none of the
// adaptation the eye performs between the 1e5-lux and 5-lux states, so the
// raw 5e-5 radiometric ratio would render a pure-black frame. The factor is
// therefore expressed in perceived brightness through the standard cube-root
// lightness relation (CIE L*, Stevens' brightness exponent near 1/3), a
// single constant applied to the curve rather than a reshaping of it. Against
// the three published perceptual anchors:
//
//   50% obscured  -> 0.794   (no visible change until about 75%)
//   75% obscured  -> 0.630   (a light haze)
//   99% obscured  -> 0.216   (an overcast day)
//   totality      -> 0.0368  (about a sixfold collapse in the last seconds)
//
// `eclipseAutoExposure = true` returns the linear radiometric `flux` instead
// and hands the re-metering to the exposure chain, which is what a camera
// does. `AtmosphericConditions.js` documents that toggle.
//
// @private
// @module EclipseState

import Cartesian3 from "../Core/Cartesian3.js";
import defined from "../Core/defined.js";
import JulianDate from "../Core/JulianDate.js";
import CesiumMath from "../Core/Math.js";
import Matrix3 from "../Core/Matrix3.js";
import Simon1994PlanetaryPositions from "../Core/Simon1994PlanetaryPositions.js";
import Transforms from "../Core/Transforms.js";
import { computeAtmosphericColumnFactor } from "./SkyBrightness.js";
import {
  computeEclipseMagnitude,
  computeSolarObscuration,
} from "./computeSolarObscuration.js";

const icrfToFixedScratch = new Matrix3();
const toSunScratch = new Cartesian3();
const toBodyScratch = new Cartesian3();

// Frame-time memo for the lunar fallback. Normal Scene views pass the shared
// FrameState sample and never enter this path. Direct/bare callers and Scene's
// legacy central-body-hook lane may omit it, so the Simon1994 series plus the
// ICRF rotation is still computed at most once per simulation instant.
//
// `usedIcrf` is part of the key rather than a diagnostic. `Transforms`
// silently falls back to the TEME pseudo-fixed rotation while the IAU2006 XYS
// data is still loading asynchronously, and the two rotations disagree by
// 0.3-0.4 deg in 2026, which is more than the 0.53 deg solar disc. Keyed on
// time alone, a memo built during the fallback window would be permanently
// retained under a pinned or paused clock while `Moon.update` switches to true
// ICRF the moment the data lands. The rendered moon and the fallback eclipse
// fade would then disagree by more than a solar diameter: a moon sitting on
// the sun with no dimming, or dimming with the moon visibly off-sun.
const moonMemo = {
  time: new JulianDate(),
  hasTime: false,
  usedIcrf: false,
  position: new Cartesian3(),
};

// The same memo for the solar ephemeris, used only when the caller does not
// supply `sunPositionWC`. A separate object rather than a second field on
// `moonMemo` so the two bodies can be sourced independently: a caller may
// pass an explicit sun and let the moon be derived, or the reverse.
const sunMemo = {
  time: new JulianDate(),
  hasTime: false,
  usedIcrf: false,
  position: new Cartesian3(),
};

// Return shape for the rotation-branch helper. Module-level so the ephemeris
// path stays allocation-free.
const branchResult = {
  matrix: undefined,
  usedIcrf: false,
};

/**
 * ICRF->fixed rotation WITH the branch reported. Behaviourally identical to
 * `Transforms.computeIcrfToCentralBodyFixedMatrix` (which hides the same
 * fallback), but the caller learns which rotation it got so the result can
 * be cached safely.
 *
 * @param {JulianDate} time
 * @param {Matrix3} result
 * @returns {object} The shared `branchResult` — `{matrix, usedIcrf}`. Read it
 *   immediately; the next call overwrites it.
 * @private
 */
function computeIcrfToFixedBranch(time, result) {
  const icrf = Transforms.computeIcrfToFixedMatrix(time, result);
  if (defined(icrf)) {
    branchResult.matrix = icrf;
    branchResult.usedIcrf = true;
  } else {
    branchResult.matrix = Transforms.computeTemeToPseudoFixedMatrix(
      time,
      result,
    );
    branchResult.usedIcrf = false;
  }
  return branchResult;
}

/**
 * Moon position in the Earth-centred FIXED frame (ECEF metres) for a given
 * time. Mirrors Moon's fixed fallback and UniformState's default bare
 * fallback: Simon1994 in the inertial frame, then the ICRF->fixed rotation
 * with the TEME pseudo-fixed fallback when earth-orientation data has not
 * loaded. It deliberately does not apply the central-body override that only
 * UniformState honors.
 *
 * @param {JulianDate} time The simulation time.
 * @param {Cartesian3} result The object onto which to store the result.
 * @returns {Cartesian3} The modified result parameter. The rotation branch
 *   that produced it is left in the shared `branchResult.usedIcrf`.
 * @private
 */
function computeMoonPositionWC(time, result) {
  const position =
    Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
      time,
      result,
    );
  const branch = computeIcrfToFixedBranch(time, icrfToFixedScratch);
  return Matrix3.multiplyByVector(branch.matrix, position, position);
}

/**
 * Sun position in the Earth-centred FIXED frame (ECEF metres). Normal Scene
 * rendering supplies FrameState's shared sample; this helper preserves the
 * independent fixed fallback so offline tooling, direct callers, and the node
 * specs can drive `updateEclipseState` without standing up a Scene.
 *
 * @param {JulianDate} time The simulation time.
 * @param {Cartesian3} result The object onto which to store the result.
 * @returns {Cartesian3} The modified result parameter.
 * @private
 */
function computeSunPositionWC(time, result) {
  const position =
    Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      time,
      result,
    );
  const branch = computeIcrfToFixedBranch(time, icrfToFixedScratch);
  return Matrix3.multiplyByVector(branch.matrix, position, position);
}

/**
 * Memoised ephemeris lookup keyed on the exact frame time AND on which
 * ICRF->fixed rotation produced the cached value.
 *
 * A hit built from the TEME fallback is re-probed every frame: XYS
 * availability is monotone, so the probe is a cheap `undefined` return until
 * the data lands and then the memo is rebuilt exactly once. A hit built from
 * true ICRF is reused unconditionally — for a fixed time the ICRF rotation
 * is deterministic and cannot revert.
 *
 * @param {object} memo One of the module-level memo records.
 * @param {Function} computeFn `(time, result) => Cartesian3`, which must leave
 *   the rotation branch it used in the shared `branchResult`.
 * @param {JulianDate} time
 * @param {Cartesian3} result
 * @returns {Cartesian3}
 * @private
 */
function getMemoisedPositionWC(memo, computeFn, time, result) {
  if (memo.hasTime && JulianDate.equals(memo.time, time)) {
    if (
      memo.usedIcrf ||
      !defined(Transforms.computeIcrfToFixedMatrix(time, icrfToFixedScratch))
    ) {
      return Cartesian3.clone(memo.position, result);
    }
    // ICRF just became available for a time we cached from the fallback —
    // fall through and rebuild.
  }
  computeFn(time, memo.position);
  memo.usedIcrf = branchResult.usedIcrf;
  JulianDate.clone(time, memo.time);
  memo.hasTime = true;
  return Cartesian3.clone(memo.position, result);
}

/**
 * Memoised lunar ephemeris lookup.
 *
 * @param {JulianDate} time
 * @param {Cartesian3} result
 * @returns {Cartesian3}
 * @private
 */
function getMoonPositionWC(time, result) {
  return getMemoisedPositionWC(moonMemo, computeMoonPositionWC, time, result);
}

/**
 * Memoised solar ephemeris lookup.
 *
 * @param {JulianDate} time
 * @param {Cartesian3} result
 * @returns {Cartesian3}
 * @private
 */
function getSunPositionWC(time, result) {
  return getMemoisedPositionWC(sunMemo, computeSunPositionWC, time, result);
}

/**
 * Allocate a fresh eclipse-state object in its identity configuration — no
 * occlusion, full sun. A scene holds exactly one of these for its lifetime.
 *
 * @returns {object} The eclipse state.
 * @private
 */
function createEclipseState() {
  return {
    enabled: true,
    // False, the default, is the human-eye impression, which preserves the
    // plunge; true hands re-metering to the exposure chain.
    autoExposure: false,
    valid: false,
    sunVisibleFraction: 1.0,
    earthOcclusionFraction: 0.0,
    moonObscuration: 0.0,
    moonPositionWC: new Cartesian3(),
    sunPositionWC: new Cartesian3(),
    sunAngularRadius: 0.0,
    earthAngularRadius: 0.0,
    moonAngularRadius: 0.0,
    earthSeparation: Math.PI,
    moonSeparation: Math.PI,
    eclipseMagnitude: 0.0,
    // The 360-degree horizon twilight, geometry only: 0 outside a near-total
    // eclipse and above the atmosphere. The toggles are applied by
    // `getEclipseHorizonTwilightFactor`.
    horizonTwilightEnabled: true,
    horizonTwilightStrength: 0.0,
  };
}

/**
 * Reset a state object to the identity (no occlusion) configuration while
 * preserving the `enabled` flag the caller resolved.
 *
 * @param {object} state
 * @param {boolean} enabled
 * @param {boolean} autoExposure
 * @returns {object} `state`
 * @private
 */
function resetToIdentity(state, enabled, autoExposure, horizonTwilightEnabled) {
  state.enabled = enabled;
  state.autoExposure = autoExposure;
  state.horizonTwilightEnabled = horizonTwilightEnabled !== false;
  state.horizonTwilightStrength = 0.0;
  state.valid = false;
  state.sunVisibleFraction = 1.0;
  state.earthOcclusionFraction = 0.0;
  state.moonObscuration = 0.0;
  state.sunAngularRadius = 0.0;
  state.earthAngularRadius = 0.0;
  state.moonAngularRadius = 0.0;
  state.earthSeparation = Math.PI;
  state.moonSeparation = Math.PI;
  state.eclipseMagnitude = 0.0;
  return state;
}

/**
 * Angular radius subtended by a sphere of radius `radius` whose centre is
 * `distance` away. Clamped at pi/2 for a camera on or inside the sphere,
 * which is the correct "the body fills the lower hemisphere" limit for a
 * ground-level camera and the Earth.
 *
 * @param {number} radius
 * @param {number} distance
 * @returns {number} radians
 * @private
 */
function angularRadius(radius, distance) {
  if (!(radius > 0.0) || !(distance > 0.0)) {
    return 0.0;
  }
  const s = radius / distance;
  return s >= 1.0 ? CesiumMath.PI_OVER_TWO : Math.asin(s);
}

/**
 * Angle between two already-normalized directions, guarded against the
 * out-of-domain drift that makes `Math.acos` return NaN.
 *
 * @param {Cartesian3} a
 * @param {Cartesian3} b
 * @returns {number} radians in [0, pi]
 * @private
 */
function angleBetween(a, b) {
  return Math.acos(CesiumMath.clamp(Cartesian3.dot(a, b), -1.0, 1.0));
}

/**
 * Recompute the per-frame eclipse state in place.
 *
 * @param {object} state The state object from {@link createEclipseState}.
 * @param {object} options
 * @param {boolean} [options.active=true] Whether the eclipse geometry is
 *   meaningful at all this frame. The caller passes `false` outside
 *   `SceneMode.SCENE3D`: in 2D, Columbus view and MORPHING the camera
 *   position is in PROJECTED MAP coordinates while the sun and moon are in
 *   ECEF, and mixing the two frames yields direction errors of up to ~1.5
 *   degrees — comfortably larger than the solar disc. The legacy engine had
 *   no sun occlusion in those modes at all, so identity (`valid = false`,
 *   factor 1.0) is correct by definition rather than a compromise.
 * @param {boolean} options.enabled Whether the effect is enabled
 *   (`atmosphericConditions.lighting.enableEclipse`). The physics is
 *   computed either way; consumers read this flag to decide whether to
 *   apply `sunVisibleFraction`.
 * @param {boolean} [options.autoExposure=false] Whether the eclipse dimming
 *   should be handed to the exposure chain in linear radiometric form
 *   (`atmosphericConditions.lighting.eclipseAutoExposure`) instead of the
 *   default eye-adapted form. Recorded on the state; read by
 *   {@link getEclipseSceneLightFactor}.
 * @param {boolean} [options.horizonTwilightEnabled=true] Whether the
 *   360-degree horizon twilight should be applied
 *   (`atmosphericConditions.lighting.enableEclipseHorizonTwilight`). Like
 *   `enabled`, it gates application only — `horizonTwilightStrength` is
 *   computed either way. Read by
 *   {@link getEclipseHorizonTwilightFactor}.
 * @param {Cartesian3} options.cameraPositionWC Camera position, ECEF metres.
 * @param {number} [options.cameraHeight=0.0] Ellipsoidal camera height in
 *   metres, used to fade atmospheric twilight without assuming Earth radius.
 * @param {Cartesian3} [options.sunPositionWC] Sun position, ECEF metres.
 *   Scene normally supplies the shared FrameState sample. Omit it and the
 *   fixed solar fallback is derived from `options.time` for direct/bare
 *   callers and the legacy central-body-hook lane (see the module header).
 * @param {JulianDate} [options.time] Simulation time, used to derive the
 *   lunar (and, when absent, the solar) ephemeris.
 * @param {Cartesian3} [options.moonPositionWC] Explicit moon position, ECEF
 *   metres. Supplying it skips the ephemeris entirely (used by the specs).
 * @param {number} [options.earthOccluderRadius] Radius of the Earth
 *   occluding sphere in metres — `ellipsoid.minimumRadius +
 *   frameState.minimumTerrainHeight`, matching `SceneUtilities.getOccluder`.
 *   Pass `undefined` (or a non-positive value) to disable the Earth term,
 *   which reproduces every guard the legacy occluder had.
 * @returns {object} `state`, mutated in place.
 * @private
 */
function updateEclipseState(state, options) {
  const enabled = options.enabled !== false;
  const autoExposure = options.autoExposure === true;
  const horizonTwilightEnabled = options.horizonTwilightEnabled !== false;
  const cameraPositionWC = options.cameraPositionWC;

  if (options.active === false || !defined(cameraPositionWC)) {
    return resetToIdentity(
      state,
      enabled,
      autoExposure,
      horizonTwilightEnabled,
    );
  }

  // Normal Scene rendering supplies FrameState's shared sample. Direct/bare
  // callers and the legacy central-body-hook lane derive the fixed fallback
  // from the clock. Resolve after the gates above so 2D and Columbus-view
  // frames do not pay for an ephemeris they discard.
  let sunPositionWC;
  if (defined(options.sunPositionWC)) {
    sunPositionWC = Cartesian3.clone(
      options.sunPositionWC,
      state.sunPositionWC,
    );
  } else if (defined(options.time)) {
    sunPositionWC = getSunPositionWC(options.time, state.sunPositionWC);
  }
  if (!defined(sunPositionWC)) {
    return resetToIdentity(
      state,
      enabled,
      autoExposure,
      horizonTwilightEnabled,
    );
  }

  const toSun = Cartesian3.subtract(
    sunPositionWC,
    cameraPositionWC,
    toSunScratch,
  );
  const sunDistance = Cartesian3.magnitude(toSun);
  if (!(sunDistance > 0.0)) {
    return resetToIdentity(
      state,
      enabled,
      autoExposure,
      horizonTwilightEnabled,
    );
  }
  Cartesian3.divideByScalar(toSun, sunDistance, toSun);
  const rs = angularRadius(CesiumMath.SOLAR_RADIUS, sunDistance);

  // ── Earth limb ──────────────────────────────────────────────────────────
  // The occluding sphere is centred on the ECEF origin, so the direction to
  // its centre is simply -normalize(camera).
  let earthOcclusion = 0.0;
  let earthAngular = 0.0;
  let earthSeparation = Math.PI;
  const earthRadius = options.earthOccluderRadius;
  const cameraDistance = Cartesian3.magnitude(cameraPositionWC);
  if (defined(earthRadius) && earthRadius > 0.0 && cameraDistance > 0.0) {
    const toEarth = Cartesian3.multiplyByScalar(
      cameraPositionWC,
      -1.0 / cameraDistance,
      toBodyScratch,
    );
    earthAngular = angularRadius(earthRadius, cameraDistance);
    earthSeparation = angleBetween(toEarth, toSun);
    earthOcclusion = computeSolarObscuration(rs, earthAngular, earthSeparation);
  }

  // ── Lunar disc ──────────────────────────────────────────────────────────
  let moonObscuration = 0.0;
  let moonAngular = 0.0;
  let moonSeparation = Math.PI;
  let moonMagnitude = 0.0;
  let haveMoon = false;
  if (defined(options.moonPositionWC)) {
    Cartesian3.clone(options.moonPositionWC, state.moonPositionWC);
    haveMoon = true;
  } else if (defined(options.time)) {
    getMoonPositionWC(options.time, state.moonPositionWC);
    haveMoon = true;
  }
  if (haveMoon) {
    const toMoon = Cartesian3.subtract(
      state.moonPositionWC,
      cameraPositionWC,
      toBodyScratch,
    );
    const moonDistance = Cartesian3.magnitude(toMoon);
    if (moonDistance > 0.0) {
      Cartesian3.divideByScalar(toMoon, moonDistance, toMoon);
      moonAngular = angularRadius(CesiumMath.LUNAR_RADIUS, moonDistance);
      moonSeparation = angleBetween(toMoon, toSun);
      // The Moon only occults the Sun when it is BETWEEN camera and Sun.
      // Without this the far-side moon (a "full moon" near the anti-solar
      // point) would be treated as an occluder whenever it happened to line
      // up, which is the lunar-eclipse geometry, not a solar one.
      if (moonDistance < sunDistance) {
        moonObscuration = computeSolarObscuration(
          rs,
          moonAngular,
          moonSeparation,
        );
        moonMagnitude = computeEclipseMagnitude(
          rs,
          moonAngular,
          moonSeparation,
        );
      }
    }
  }

  // Independent-attenuation combination — exact for every single-occluder
  // case, continuous and monotone everywhere. See the module header.
  let visible = (1.0 - earthOcclusion) * (1.0 - moonObscuration);
  visible = visible < 0.0 ? 0.0 : visible > 1.0 ? 1.0 : visible;

  state.enabled = enabled;
  state.autoExposure = autoExposure;
  state.horizonTwilightEnabled = horizonTwilightEnabled;
  // Geometry only; the toggles are applied by the accessor, following this
  // module's convention that the physics is always computed so tooling can
  // read it with the effect switched off.
  state.horizonTwilightStrength =
    computeHorizonTwilightStrength(moonObscuration, rs, moonAngular) *
    computeAtmosphericColumnFactor(options.cameraHeight);
  state.valid = true;
  state.sunVisibleFraction = visible;
  state.earthOcclusionFraction = earthOcclusion;
  state.moonObscuration = moonObscuration;
  state.sunAngularRadius = rs;
  state.earthAngularRadius = earthAngular;
  state.moonAngularRadius = moonAngular;
  state.earthSeparation = earthSeparation;
  state.moonSeparation = moonSeparation;
  state.eclipseMagnitude = moonMagnitude;
  return state;
}

/**
 * The multiplier a renderer should apply, given a published state. Returns
 * exactly 1.0 (the multiplicative identity, hence byte-identical output)
 * when the state is absent, invalid, or the effect is switched off — which
 * is what makes the `enableEclipse = false` position provably legacy.
 *
 * @param {object|undefined} state
 * @returns {number} in [0, 1]
 * @private
 */
function getEclipseSunFactor(state) {
  if (!defined(state) || state.enabled !== true || state.valid !== true) {
    return 1.0;
  }
  const f = state.sunVisibleFraction;
  return typeof f === "number" && f >= 0.0 && f <= 1.0 ? f : 1.0;
}

/**
 * Horizontal illuminance under an unobstructed midday sun, lux. The first of
 * the scene-dimming constants, all of which are published figures rather than
 * values tuned by eye; the module header derives the curve they feed.
 *
 * References:
 *   - American Astronomical Society, "Eclipse basics".
 *   - Optica sky-brightness survey.
 * @type {number}
 * @private
 */
const ECLIPSE_FULL_SUN_ILLUMINANCE = 100000.0;

/**
 * Horizontal illuminance inside the umbra at totality, lux — deep civil
 * twilight, and about 10x brighter than a full-moon night. Same sources.
 * @type {number}
 * @private
 */
const ECLIPSE_TOTALITY_ILLUMINANCE = 5.0;

/**
 * The radiometric floor the eclipse multiplier is bounded away from zero by:
 * the totality-to-full-sun illuminance ratio, 5e-5. It stands in for the
 * umbral sky lit by multiple scattering from outside the umbra, which a
 * camera-anchored scalar cannot compute.
 * @type {number}
 * @private
 */
const ECLIPSE_RADIOMETRIC_FLOOR =
  ECLIPSE_TOTALITY_ILLUMINANCE / ECLIPSE_FULL_SUN_ILLUMINANCE;

/**
 * Stevens' brightness exponent / the CIE L* cube root — the eye's partial
 * adaptation between the two illuminance states above. Applied only in the
 * DEFAULT (human-eye, AE-exempt) mode; `eclipseAutoExposure` skips it.
 * @type {number}
 * @private
 */
const ECLIPSE_ADAPTATION_EXPONENT = 1.0 / 3.0;

/**
 * The rendered floor at totality: `ECLIPSE_RADIOMETRIC_FLOOR` carried through
 * the adaptation, ~0.0368. This is the "never black" constant — a deep
 * twilight frame rather than an extinguished one.
 * @type {number}
 * @private
 */
// `Math.pow`, not `Math.cbrt`: the factor below is computed with `Math.pow`
// and the two can disagree in the last ulp, which would make "totality lands
// exactly on the floor" a fuzzy assertion instead of an exact one.
const ECLIPSE_TWILIGHT_FLOOR = Math.pow(
  ECLIPSE_RADIOMETRIC_FLOOR,
  ECLIPSE_ADAPTATION_EXPONENT,
);

/**
 * The scene-light transfer curve, isolated so the globe-shadow path can
 * evaluate the identical law at a fragment's obscuration.
 *
 * @param {number} obscuration Blocked solar flux fraction in [0, 1].
 * @param {boolean} [autoExposure=false] Return linear radiometry when true.
 * @returns {number} A multiplier in [ECLIPSE_TWILIGHT_FLOOR, 1].
 * @private
 */
function eclipseSceneLightCurve(obscuration, autoExposure) {
  const visible = obscuration >= 1.0 ? 0.0 : 1.0 - obscuration;
  const flux = visible + ECLIPSE_RADIOMETRIC_FLOOR * (1.0 - visible);
  return autoExposure === true
    ? flux
    : Math.pow(flux, ECLIPSE_ADAPTATION_EXPONENT);
}

/**
 * The multiplier every consumer applies to a sun-driven light or atmosphere
 * intensity: scene light colour (`UniformState`), the sky atmosphere shell on
 * both backends, the globe's ground atmosphere and its fog (one
 * `tileProvider` mirror, both backends), and `frameState.skyBrightness`.
 *
 * Returns exactly 1.0 — the multiplicative identity, hence byte-identical
 * output — when the state is absent, invalid, switched off, or simply has no
 * lunar obscuration this frame, which is every frame that is not a solar
 * eclipse. Consumers additionally short-circuit on `=== 1.0` so the
 * no-eclipse path is untouched by construction rather than by arithmetic.
 *
 * Not `sunVisibleFraction`: that includes the Earth-limb term, which
 * saturates at 1 through twilight and all night, and using it here would
 * black out every sunset and the day side seen from a night-side orbital
 * camera. The module header derives that.
 *
 * SOLAR ONLY, and deliberately so. Every quantity this module computes is
 * about the Moon standing in front of the Sun; the "lunar obscuration" above
 * names the Moon as the OCCULTER, not a lunar eclipse. Earth's shadow falling
 * on the Moon dims a different light — the Moon's own reflected sunlight — and
 * its multiplier is {@link getLunarEclipseMoonlightFactor} below, which the
 * same two consumers apply under the complementary light-type gate. Neither
 * factor may be substituted for the other: applying this one during a lunar
 * eclipse would darken a fully sunlit scene, and applying that one during a
 * solar eclipse would do nothing at all.
 *
 * @param {object|undefined} state
 * @returns {number} in [ECLIPSE_TWILIGHT_FLOOR, 1]
 * @private
 */
function getEclipseSceneLightFactor(state) {
  if (!defined(state) || state.enabled !== true || state.valid !== true) {
    return 1.0;
  }
  const obscuration = state.moonObscuration;
  if (typeof obscuration !== "number" || !(obscuration > 0.0)) {
    return 1.0;
  }
  return eclipseSceneLightCurve(obscuration, state.autoExposure === true);
}

/**
 * The multiplier a MOONLIGHT-driven scene light is scaled by while Earth's
 * shadow is on the Moon — the lunar arm of the contract stated above.
 *
 * The quantity is the Moon's disc-averaged brightness relative to an
 * uneclipsed full Moon, integrated by `Scene/LunarEclipseState.js` over the
 * same per-point law the two moon disc shaders evaluate per fragment. That
 * shared law is the point: a separately tuned dimming curve here would let the
 * rendered disc and the light it casts disagree about how eclipsed the Moon
 * is, which is exactly the artefact a viewer notices — a coppery Moon lighting
 * the ground as brightly as a full one.
 *
 * No radiometric floor. Unlike the solar curve, which floors on the ~5-lux
 * twilight constant because a total solar eclipse is never actually dark, this
 * one needs none: the refracted umbral light is part of the law being
 * integrated, so the factor bottoms out near 0.026 at central totality rather
 * than reaching zero.
 *
 * Returns exactly 1.0 — the multiplicative identity — when no lunar eclipse is
 * in progress, when the state is absent, and in the
 * `atmosphericConditions.lighting.enableLunarEclipse = false` position, which
 * is the same gate the disc appearance reads. Consumers additionally
 * short-circuit on `=== 1.0`, so a scene lit by moonlight on any other night
 * is untouched by construction rather than by arithmetic.
 *
 * @param {object|undefined} state `frameState.lunarEclipse`.
 * @param {object} [lighting] The `atmosphericConditions.lighting` leaf.
 * @returns {number} in (0, 1]
 * @private
 */
function getLunarEclipseMoonlightFactor(state, lighting) {
  if (defined(lighting) && lighting.enableLunarEclipse === false) {
    return 1.0;
  }
  if (!defined(state) || state.inProgress !== true) {
    return 1.0;
  }
  const factor = state.discLuminanceFactor;
  if (typeof factor !== "number" || !(factor > 0.0) || factor > 1.0) {
    return 1.0;
  }
  return factor;
}

// The constants below parameterise the 360-degree horizon twilight of a total
// eclipse.
//
// Standing in the umbra an observer is surrounded by penumbra. The umbral
// ground track is only 100-160 km wide — about 115 km in 2017, with path
// widths reaching 270 km (NASA/EclipseWise) — so in every azimuth the
// still-sunlit atmosphere begins a few tens of km away and its scattered
// light arrives as a sunset-coloured band hugging the horizon, all the way
// round. It is the most recognisable totality cue after the corona, and a
// camera-anchored dimming scalar cannot produce it, because that darkens the
// whole sky uniformly.
//
// The shape is geometric rather than tuned. From the umbra centre the near
// edge of the bright penumbral atmosphere is 50-80 km away, half the track
// width, and the scattering layer that carries the glow is the troposphere
// plus lower stratosphere, about 25 km deep. The lit region therefore subtends
// elevations from the horizon up to roughly
//
//   atan(25 km / 60 km) = 22.6 degrees
//
// which is the shader's `ECLIPSE_TWILIGHT_ELEVATION_RAD`. Above that the
// observer is looking at umbral sky and the term is exactly 0, which is what
// makes the effect read as a band rather than a wash and keeps it from
// drowning the stars appearing overhead.
//
// The onset is keyed to obscuration, the same quantity the scene dimming uses,
// and never to magnitude. Below `ECLIPSE_TWILIGHT_ONSET` the strength is
// exactly 0, so every partial eclipse is byte-identical.
//
// Excluding annular eclipses is a separate, type-level decision, and
// obscuration cannot make it. A concentric annular ring at radius ratio 0.98
// obscures 0.9794, at 0.99 it obscures 0.9905, at 0.995 0.9955 and at 0.999
// 0.9992 — all above the 0.98 onset. Hybrid and near-hybrid eclipses, about
// 5% of solar eclipses, run annular phases right through that band, so an
// obscuration-only gate would fire an umbra-only effect at near-full gain
// over a track with no umbra on it.
//
// The discriminator is the angular-radius ratio `ro / rs`: the moon's disc is
// larger than the sun's if and only if the eclipse is total, which is a
// property of the eclipse type rather than of the instant. It is exactly the
// eclipse magnitude evaluated at central alignment, `M(d=0) = (rs+ro)/(2rs)
// >= 1  <=>  ro >= rs`. The instantaneous magnitude will not do: for a total
// eclipse `M >= 1` is algebraically identical to `d <= ro - rs`, i.e. to the
// umbra branch, i.e. to obscuration being exactly 1.0, so gating on it would
// collapse the whole obscuration ramp into a step at second contact. The
// ratio keeps the ramp and still excludes every annular geometry exactly.
//
// The ratio gate carries a narrow smoothstep rather than a hard step so a
// hybrid eclipse — annular at the ends of its track, total in the middle —
// crosses it continuously, which is what a hybrid physically does. A total
// eclipse sits at `ro/rs` between about 1.01 and 1.08 at greatest eclipse and
// is fully inside the gate; every annular ratio is below 1 by definition and
// is exactly 0.
//
// The amplitude is a perceptual constant and is labelled as one. The mechanism
// fixes the shape and the direction but not a radiance ratio, and the totality
// sky-brightness literature reports illuminances rather than the
// zenith-to-horizon contrast a shader needs. The term is expressed as a
// multiple of the sky's own luminance along the same ray, which makes it
// self-scaling under the eclipse dimming, the tonemap and the user's
// `atmosphereLightIntensity` with no calibration to drift, and the probe gates
// on shape — present at every azimuth, monotone in obscuration, confined to
// the band, absent when the toggle is off — rather than on the number.

/**
 * Obscuration below which there is no 360-degree twilight at all. This is the
 * strength ramp only — annular exclusion is
 * {@link ECLIPSE_TWILIGHT_TOTAL_RATIO_LO}'s job, because annular obscuration
 * reaches 0.9992 at a 0.999 radius ratio and cannot be separated here.
 * @type {number}
 * @private
 */
const ECLIPSE_TWILIGHT_ONSET = 0.98;

/**
 * Moon/sun angular-radius ratio at and below which the eclipse is annular and
 * the 360-degree twilight is exactly 0 — there is no umbra on the ground, so
 * there is no surrounding penumbral horizon to see. Equivalently, the eclipse
 * magnitude at central alignment is below 1.
 * @type {number}
 * @private
 */
const ECLIPSE_TWILIGHT_TOTAL_RATIO_LO = 1.0;

/**
 * Ratio at and above which the eclipse is fully total for this purpose. The
 * narrow band between the two exists so a hybrid eclipse — annular at the ends
 * of its track, total in the middle — crosses continuously instead of popping.
 * A total eclipse sits at 1.01-1.08 at greatest eclipse.
 * @type {number}
 * @private
 */
const ECLIPSE_TWILIGHT_TOTAL_RATIO_HI = 1.001;

/**
 * Peak strength of the horizon band, as a multiple of the sky's own luminance
 * along the same ray. 2.0 means "the horizon reads three times the local sky"
 * at the deepest point of totality. Perceptual, not measured — see the note
 * above.
 * @type {number}
 * @private
 */
const ECLIPSE_TWILIGHT_HORIZON_GAIN = 2.0;

/**
 * Elevation at which the band has fallen to zero, radians — `atan(25/60)`,
 * the angle the sunlit penumbral atmosphere subtends from the middle of a
 * ~120 km umbral track. Consumed by both shaders.
 * @type {number}
 * @private
 */
const ECLIPSE_TWILIGHT_ELEVATION_RAD = Math.atan2(25000.0, 60000.0);

/**
 * Warm tint of the band, normalised so the peak channel is 1. Derived, not
 * picked: Rayleigh transmission `exp(-tau * (550/lambda)^4)` at `tau = 0.5`
 * (a grazing horizon path) for lambda = 650/550/450 nm gives
 * (0.774, 0.607, 0.328), which normalises to the triple below — the same
 * physics that reddens an ordinary sunset, applied to the long slant path out
 * to the penumbra.
 * @type {number[]}
 * @private
 */
const ECLIPSE_TWILIGHT_TINT = [1.0, 0.784, 0.424];

/**
 * Geometric strength of the 360-degree horizon twilight, before the toggles.
 *
 * Two factors, answering two different questions. The obscuration ramp
 * answers how close to totality this instant is; the angular-radius ratio
 * answers whether the eclipse is capable of casting an umbra at all.
 * Obscuration alone cannot do the second — a 0.999-ratio annular ring
 * obscures 0.9992 — and the instantaneous magnitude cannot do the first,
 * because `M >= 1` is algebraically the umbra branch and so is true only
 * where obscuration is already exactly 1. The block above the constants
 * derives both.
 *
 * @param {number} moonObscuration
 * @param {number} [sunAngularRadius] Solar angular radius, radians. Omitted or
 *   non-positive leaves the type unknown, and the type factor is then 1,
 *   which is what a caller supplying obscuration alone expects.
 * @param {number} [moonAngularRadius] Lunar angular radius, radians.
 * @returns {number} in [0, 1]
 * @private
 */
function computeHorizonTwilightStrength(
  moonObscuration,
  sunAngularRadius,
  moonAngularRadius,
) {
  if (typeof moonObscuration !== "number" || !(moonObscuration > 0.0)) {
    return 0.0;
  }
  const t =
    (moonObscuration - ECLIPSE_TWILIGHT_ONSET) / (1.0 - ECLIPSE_TWILIGHT_ONSET);
  if (!(t > 0.0)) {
    return 0.0;
  }
  const ramp = t >= 1.0 ? 1.0 : t * t * (3.0 - 2.0 * t);

  // Total-vs-annular. Only applied when both radii are supplied and usable;
  // an unknown type cannot be used to switch the effect off silently.
  if (
    typeof sunAngularRadius !== "number" ||
    typeof moonAngularRadius !== "number" ||
    !(sunAngularRadius > 0.0) ||
    !(moonAngularRadius >= 0.0)
  ) {
    return ramp;
  }
  const ratio = moonAngularRadius / sunAngularRadius;
  if (ratio <= ECLIPSE_TWILIGHT_TOTAL_RATIO_LO) {
    return 0.0;
  }
  if (ratio >= ECLIPSE_TWILIGHT_TOTAL_RATIO_HI) {
    return ramp;
  }
  const u =
    (ratio - ECLIPSE_TWILIGHT_TOTAL_RATIO_LO) /
    (ECLIPSE_TWILIGHT_TOTAL_RATIO_HI - ECLIPSE_TWILIGHT_TOTAL_RATIO_LO);
  return ramp * u * u * (3.0 - 2.0 * u);
}

/**
 * The 360-degree horizon-twilight gain a sky shell should apply, given a
 * published state. Returns exactly 0.0 — hence a byte-identical shell —
 * whenever the state is absent, invalid, either toggle is off, or the
 * obscuration has not reached the onset, which is every frame that is not the
 * last seconds of a total eclipse seen from inside the atmosphere.
 *
 * @param {object|undefined} state
 * @returns {number} in [0, ECLIPSE_TWILIGHT_HORIZON_GAIN]
 * @private
 */
function getEclipseHorizonTwilightFactor(state) {
  if (
    !defined(state) ||
    state.enabled !== true ||
    state.horizonTwilightEnabled !== true ||
    state.valid !== true
  ) {
    return 0.0;
  }
  const strength = state.horizonTwilightStrength;
  if (typeof strength !== "number" || !(strength > 0.0)) {
    return 0.0;
  }
  const clamped = strength > 1.0 ? 1.0 : strength;
  return clamped * ECLIPSE_TWILIGHT_HORIZON_GAIN;
}

export {
  createEclipseState,
  updateEclipseState,
  getEclipseSunFactor,
  getEclipseSceneLightFactor,
  getLunarEclipseMoonlightFactor,
  eclipseSceneLightCurve,
  getEclipseHorizonTwilightFactor,
  computeHorizonTwilightStrength,
  computeMoonPositionWC,
  computeSunPositionWC,
  ECLIPSE_FULL_SUN_ILLUMINANCE,
  ECLIPSE_TOTALITY_ILLUMINANCE,
  ECLIPSE_RADIOMETRIC_FLOOR,
  ECLIPSE_ADAPTATION_EXPONENT,
  ECLIPSE_TWILIGHT_FLOOR,
  ECLIPSE_TWILIGHT_ONSET,
  ECLIPSE_TWILIGHT_TOTAL_RATIO_LO,
  ECLIPSE_TWILIGHT_TOTAL_RATIO_HI,
  ECLIPSE_TWILIGHT_HORIZON_GAIN,
  ECLIPSE_TWILIGHT_ELEVATION_RAD,
  ECLIPSE_TWILIGHT_TINT,
};
export default updateEclipseState;
