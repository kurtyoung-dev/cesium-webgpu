// C12-29 S1 — per-frame eclipse / occultation state (backend-agnostic CPU).
//
// WHAT THIS REPLACES. Sun occlusion in this engine was a boolean with no
// intensity path. WebGL culled the whole sun billboard once its bounding
// sphere (SOLAR_RADIUS * (1 + glowLengthTS), roughly 6 solar radii — see
// `Sun.js`) fell entirely inside the Earth occluder's horizon cone
// (`Occluder.isBoundingSphereVisible` via `Scene.updateEnvironment`), so the
// glow snapped from absent to full in a single frame. WebGPU built its sun
// command with NO bounding volume at all (`WebGPUEnvironmentRenderer.js`),
// so it never culled and instead hard-clipped per pixel against the globe's
// depth. Neither backend treated the Moon as an occluder anywhere: a solar
// eclipse rendered as two independent bodies with zero light coupling.
//
// This module computes, once per frame in f64, how much of the sun the
// camera can actually see, and publishes it on `frameState.eclipseState`.
// It is deliberately unconditional (a few tens of flops in the common case
// where nothing occludes anything); the `enableEclipse` toggle gates only
// the APPLICATION of the result, so probes can read the physics with the
// effect switched off.
//
// PUBLISHED CONTRACT (`frameState.eclipseState`, one object mutated in
// place — never reallocated, so consumers may hold the reference):
//
//   enabled                 boolean  atmosphericConditions.lighting.enableEclipse
//   sunVisibleFraction      [0,1]    limb-darkened surviving flux, camera-anchored
//   earthOcclusionFraction  [0,1]    flux removed by the Earth limb alone
//   moonObscuration         [0,1]    flux removed by the lunar disc alone
//   moonPositionWC          Cartesian3  ECEF metres (S5's per-fragment umbra input)
//   sunAngularRadius        radians
//   earthAngularRadius      radians  (0 when the Earth term is gated off)
//   moonAngularRadius       radians
//   earthSeparation         radians  camera->nadir vs camera->sun
//   moonSeparation          radians  camera->moon vs camera->sun
//   eclipseMagnitude        >= 0     lunar magnitude, >= 1 means totality
//   valid                   boolean  false when inputs were missing this frame
//
// TWO OCCLUDERS, ONE INTEGRAND. Both terms come from
// `computeSolarObscuration` (limb-darkened circle-circle overlap); see that
// module for the dual-cone umbra/penumbra/antumbra mapping and the C12-15
// limb-darkening law. Combining them uses the independent-attenuation form
//
//   sunVisibleFraction = (1 - earthOcclusionFraction) * (1 - moonObscuration)
//
// which is EXACT whenever either term is 0 or 1 — i.e. every single-occluder
// configuration, which is every configuration that actually occurs outside a
// lunar transit happening within a fraction of a degree of the Earth limb.
// It is continuous, monotone in both inputs and cannot leave [0,1]. The
// spatially correct treatment of simultaneous overlapping occluders is S5
// territory (per-fragment), not a camera-anchored scalar's job.
//
// GUARD PARITY. The Earth term is gated on exactly the conditions that
// produced the legacy occluder — SCENE3D, globe shown, camera not
// underground, globe not translucent (`SceneUtilities.getOccluder`) plus
// `GlobeTranslucencyState.sunVisibleThroughGlobe` (`Scene.js`). The caller
// passes `earthOccluderRadius = undefined` when any of those fails, and the
// Earth term is then exactly 0 — identity, matching today's "sun always
// visible" behaviour in translucent/hidden-globe scenes.
//
// FRAME PARITY. The whole computation additionally requires
// `options.active` — the caller passes false outside `SceneMode.SCENE3D`,
// because in 2D/Columbus view/MORPHING the camera position is in PROJECTED
// MAP coordinates while the sun and moon are ECEF. Gating only the Earth
// term there would leave the MOON term running on mixed frames (direction
// errors up to ~1.5 deg, several solar diameters). Legacy had no sun
// occlusion in those modes, so full identity is correct by definition.
//
// EPHEMERIS. The Moon's world position is computed here rather than read
// from `Moon.js`, for two reasons verified in the C12-29 research: (a)
// `UniformState` keeps only the moon's EYE-space direction, discarding the
// world-fixed position, and (b) `Moon.update` runs only when `moon.show` is
// true — an eclipse must dim the sun whether or not the decorative moon
// primitive is being drawn. The result is memoised on the frame time so
// multi-view scenes pay for it once.
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
import {
  computeEclipseMagnitude,
  computeSolarObscuration,
} from "./computeSolarObscuration.js";

const icrfToFixedScratch = new Matrix3();
const toSunScratch = new Cartesian3();
const toBodyScratch = new Cartesian3();

// Frame-time memo for the lunar ephemeris. Multi-view scenes call
// `updateEclipseState` once per view with the same `frameState.time`; the
// Simon1994 series plus the ICRF rotation is the only non-trivial cost in
// this module, so it is computed at most once per simulation instant.
//
// `usedIcrf` is PART OF THE KEY, not a diagnostic. `Transforms` silently
// falls back to the TEME pseudo-fixed rotation while the IAU2006 XYS data is
// still loading asynchronously, and the two rotations disagree by ~0.3-0.4
// deg in 2026 — LARGER than the ~0.53 deg solar disc. Keyed on time alone,
// a memo built during the fallback window would be permanently retained
// under a pinned/paused clock (every probe, and a common user pattern)
// while `Moon.update` and `UniformState` recompute every frame and switch to
// true ICRF the moment the data lands. The rendered moon and the eclipse
// fade would then disagree by more than a solar diameter: a moon sitting on
// the sun with no dimming, or dimming with the moon visibly off-sun.
const moonMemo = {
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
 * time. Mirrors `Moon.update` and `UniformStateComputations` exactly —
 * Simon1994 in the inertial frame, then the ICRF->fixed rotation with the
 * TEME pseudo-fixed fallback applied when earth-orientation data has not
 * loaded yet.
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
 * Sun position in the Earth-centred FIXED frame (ECEF metres). The engine
 * itself reads `uniformState.sunPositionWC`, which is produced by this same
 * pair of calls; this helper exists so offline tooling and the node specs
 * can drive `updateEclipseState` without standing up a `UniformState`.
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
 * Memoised lunar ephemeris lookup keyed on the exact frame time AND on which
 * ICRF->fixed rotation produced the cached value.
 *
 * A hit built from the TEME fallback is re-probed every frame: XYS
 * availability is monotone, so the probe is a cheap `undefined` return until
 * the data lands and then the memo is rebuilt exactly once. A hit built from
 * true ICRF is reused unconditionally — for a fixed time the ICRF rotation
 * is deterministic and cannot revert.
 *
 * @param {JulianDate} time
 * @param {Cartesian3} result
 * @returns {Cartesian3}
 * @private
 */
function getMoonPositionWC(time, result) {
  if (moonMemo.hasTime && JulianDate.equals(moonMemo.time, time)) {
    if (
      moonMemo.usedIcrf ||
      !defined(Transforms.computeIcrfToFixedMatrix(time, icrfToFixedScratch))
    ) {
      return Cartesian3.clone(moonMemo.position, result);
    }
    // ICRF just became available for a time we cached from the fallback —
    // fall through and rebuild.
  }
  computeMoonPositionWC(time, moonMemo.position);
  moonMemo.usedIcrf = branchResult.usedIcrf;
  JulianDate.clone(time, moonMemo.time);
  moonMemo.hasTime = true;
  return Cartesian3.clone(moonMemo.position, result);
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
    valid: false,
    sunVisibleFraction: 1.0,
    earthOcclusionFraction: 0.0,
    moonObscuration: 0.0,
    moonPositionWC: new Cartesian3(),
    sunAngularRadius: 0.0,
    earthAngularRadius: 0.0,
    moonAngularRadius: 0.0,
    earthSeparation: Math.PI,
    moonSeparation: Math.PI,
    eclipseMagnitude: 0.0,
  };
}

/**
 * Reset a state object to the identity (no occlusion) configuration while
 * preserving the `enabled` flag the caller resolved.
 *
 * @param {object} state
 * @param {boolean} enabled
 * @returns {object} `state`
 * @private
 */
function resetToIdentity(state, enabled) {
  state.enabled = enabled;
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
 * @param {boolean} options.enabled Whether the EFFECT is enabled
 *   (`atmosphericConditions.lighting.enableEclipse`). The physics is
 *   computed either way; consumers read this flag to decide whether to
 *   apply `sunVisibleFraction`.
 * @param {Cartesian3} options.cameraPositionWC Camera position, ECEF metres.
 * @param {Cartesian3} options.sunPositionWC Sun position, ECEF metres
 *   (`uniformState.sunPositionWC`).
 * @param {JulianDate} [options.time] Simulation time, used to derive the
 *   lunar ephemeris when `moonPositionWC` is not supplied.
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
  const cameraPositionWC = options.cameraPositionWC;
  const sunPositionWC = options.sunPositionWC;

  if (
    options.active === false ||
    !defined(cameraPositionWC) ||
    !defined(sunPositionWC)
  ) {
    return resetToIdentity(state, enabled);
  }

  const toSun = Cartesian3.subtract(
    sunPositionWC,
    cameraPositionWC,
    toSunScratch,
  );
  const sunDistance = Cartesian3.magnitude(toSun);
  if (!(sunDistance > 0.0)) {
    return resetToIdentity(state, enabled);
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

export {
  createEclipseState,
  updateEclipseState,
  getEclipseSunFactor,
  computeMoonPositionWC,
  computeSunPositionWC,
};
export default updateEclipseState;
