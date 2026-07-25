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
//   autoExposure            boolean  atmosphericConditions.lighting.eclipseAutoExposure
//   sunVisibleFraction      [0,1]    limb-darkened surviving flux, camera-anchored
//   earthOcclusionFraction  [0,1]    flux removed by the Earth limb alone
//   moonObscuration         [0,1]    flux removed by the lunar disc alone
//   moonPositionWC          Cartesian3  ECEF metres (S5's per-fragment umbra input)
//   sunPositionWC           Cartesian3  ECEF metres (the position actually used)
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
// The SUN's world position is derived the same way when the caller does not
// supply one (S2). `Scene.render` now publishes the eclipse state BEFORE
// `uniformState.update(frameState)` — it has to, because `UniformState`
// itself is one of the S2 consumers and `uniformState.update` is re-entered
// several times per frame (picking, viewport executor, offscreen views), so a
// factor applied after the fact would be silently dropped by every one of
// those re-entries. Before that call `uniformState.sunPositionWC` still holds
// the PREVIOUS frame's value, which is harmless at 60 Hz but wrong by a whole
// step under the stepped/pinned clocks every probe uses. The derivation here
// is `setSunAndMoonDirections`' own pair of calls (Simon1994 in the inertial
// frame, then ICRF->fixed with the TEME fallback), so the two agree to the
// bit for a given time.
//
// ── S2: SCENE DIMMING (`getEclipseSceneLightFactor`) ───────────────────────
//
// S1 fades the sun BILLBOARD by `sunVisibleFraction`, which correctly folds
// in the Earth limb: the disc is genuinely hidden behind the Earth from that
// camera. S2 dims the WORLD, and for that the Earth term must NOT be used.
//
//   `earthOcclusionFraction` is 1 for every night frame and for most of
//   twilight — a ground camera's Earth occluder subtends ~85-86 deg (it is
//   built from `ellipsoid.minimumRadius`, so its limb sits several degrees
//   below the true horizon), so the term saturates once the sun is a few
//   degrees below the horizontal. Multiplying scene light or atmosphere
//   intensity by `1 - earthOcclusionFraction` would therefore black out
//   civil twilight, every sunrise/sunset gradient, and the day side of the
//   globe as seen from a night-side orbital camera. The engine ALREADY
//   models "the Earth is between me and the sun" per fragment, via N·L and
//   the day/night terminator; a global multiplier would double-count it.
//
// So the scene factor is driven by `moonObscuration` alone — the solar
// eclipse proper. It is still camera-anchored (the spatially correct
// per-fragment umbra is S5), which is the right first order: the umbra is
// only 100-160 km wide, so a camera that sees a 100%-obscured sun is, to
// within the approximation, standing in the shadow.
//
// THE CURVE. Linear in the limb-darkened flux fraction — no smoothstep, no
// invented easing (the research is explicit that Stellarium's magnitude-keyed
// darkening was the wrong quantity; obscuration is the right one):
//
//   f    = 1 - moonObscuration                              (photometric)
//   flux = f + ECLIPSE_RADIOMETRIC_FLOOR * (1 - f)          (== f exactly at f == 1)
//
// THE FLOOR. Totality is civil twilight, not night: ~5 lux against ~100,000
// lux full sun (AAS; Optica sky-brightness survey), and a full-moon night is
// ~10x darker still. `ECLIPSE_RADIOMETRIC_FLOOR = 5 / 100000` stands in for
// the light the camera-anchored model cannot compute — the umbral sky lit by
// multiple scattering from OUTSIDE the umbra (nonlocal; the exact treatment
// is Schneegans' precomputed eclipse-shadow Bruneton extension, recorded as a
// future L-item). It is what makes the multiplier bounded away from zero.
//
// THE ADAPTATION EXPONENT. Ruling E2 makes the human-eye impression the
// DEFAULT: no camera re-metering, the plunge is preserved. But the default
// display transform then performs none of the adaptation the eye performs
// between the 1e5-lux and 5-lux states, so shipping the raw 5e-5 radiometric
// ratio would render a pure-black frame — the one outcome the research
// forbids. The factor is therefore expressed in PERCEIVED brightness with the
// standard cube-root lightness relation (CIE L*, Stevens' brightness exponent
// ~1/3), which is a single documented constant applied to the curve, not a
// reshaping of it. What that buys, against the three documented perceptual
// anchors:
//
//   50% obscured  -> 0.794   ("no visible change until ~75%")
//   75% obscured  -> 0.630   (a light haze)
//   99% obscured  -> 0.216   ("overcast day")
//   totality      -> 0.0368  (a ~6x collapse from 99% in the last seconds)
//
// `eclipseAutoExposure = true` (ruling E2's togglable alternative) returns
// the LINEAR radiometric `flux` instead and hands the re-metering to the
// exposure chain, which is exactly what a camera does. See the toggle's
// documentation in `AtmosphericConditions.js` for the C12-19 seam.
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

// C12-29 S2 — the same memo for the solar ephemeris, used only when the
// caller does not supply `sunPositionWC`. Separate object (not a second field
// on `moonMemo`) so the two bodies can be sourced independently: the specs
// pass an explicit sun and let the moon be derived, and vice versa.
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
 * Memoised solar ephemeris lookup (C12-29 S2).
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
    // C12-29 S2 — ruling E2's togglable alternative mode. False (the default)
    // is the human-eye impression: the plunge is preserved.
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
function resetToIdentity(state, enabled, autoExposure) {
  state.enabled = enabled;
  state.autoExposure = autoExposure;
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
 * @param {boolean} [options.autoExposure=false] Whether the eclipse dimming
 *   should be handed to the exposure chain in LINEAR radiometric form
 *   (`atmosphericConditions.lighting.eclipseAutoExposure`, ruling E2's
 *   togglable camera mode) instead of the default eye-adapted form. Recorded
 *   on the state; read by {@link getEclipseSceneLightFactor}.
 * @param {Cartesian3} options.cameraPositionWC Camera position, ECEF metres.
 * @param {Cartesian3} [options.sunPositionWC] Sun position, ECEF metres.
 *   Omit it and the solar ephemeris is derived from `options.time` exactly as
 *   `setSunAndMoonDirections` derives `uniformState.sunPositionWC` — which is
 *   what `Scene.render` does, because it publishes the state BEFORE
 *   `uniformState.update` (see the module header).
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
  const cameraPositionWC = options.cameraPositionWC;

  if (options.active === false || !defined(cameraPositionWC)) {
    return resetToIdentity(state, enabled, autoExposure);
  }

  // C12-29 S2 — the sun is either supplied (specs, and any caller that
  // already has `uniformState.sunPositionWC` for the CURRENT frame) or
  // derived from the clock, which is what `Scene.render` does now that the
  // publication moved ahead of `uniformState.update`. Resolved AFTER the
  // gates above so 2D/Columbus-view frames do not pay for an ephemeris whose
  // result they discard.
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
    return resetToIdentity(state, enabled, autoExposure);
  }

  const toSun = Cartesian3.subtract(
    sunPositionWC,
    cameraPositionWC,
    toSunScratch,
  );
  const sunDistance = Cartesian3.magnitude(toSun);
  if (!(sunDistance > 0.0)) {
    return resetToIdentity(state, enabled, autoExposure);
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

// ─── C12-29 S2: the scene-dimming constants ────────────────────────────────
// Documented, not tuned by eye. See the module header for the derivation and
// for why the exponent exists at all.

/**
 * Horizontal illuminance under an unobstructed midday sun, lux. AAS eclipse
 * basics; corroborated by the Optica sky-brightness survey.
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
 * the totality/full-sun illuminance ratio, 5e-5. It stands in for the umbral
 * sky lit by multiple scattering from OUTSIDE the umbra, which a
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
 * The multiplier S2's consumers apply to every SUN-DRIVEN light and
 * atmosphere intensity: scene light colour (`UniformState`), the sky
 * atmosphere shell (both backends), the globe's ground atmosphere and its
 * fog (one `tileProvider` mirror, both backends), and `frameState.skyBrightness`.
 *
 * Returns exactly 1.0 — the multiplicative identity, hence byte-identical
 * output — when the state is absent, invalid, switched off, or simply has no
 * lunar obscuration this frame, which is every frame that is not a solar
 * eclipse. Consumers additionally short-circuit on `=== 1.0` so the
 * no-eclipse path is untouched by construction rather than by arithmetic.
 *
 * DELIBERATELY NOT `sunVisibleFraction`: that includes the Earth-limb term,
 * which saturates at 1 through twilight and all night, and using it here
 * would black out every sunset and the day side seen from a night-side
 * orbital camera. See the module header.
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
  const visible = obscuration >= 1.0 ? 0.0 : 1.0 - obscuration;
  // Linear in the limb-darkened flux fraction, lifted onto the twilight
  // floor. Exactly `visible` when `visible === 1`, and exactly the floor at
  // totality.
  const flux = visible + ECLIPSE_RADIOMETRIC_FLOOR * (1.0 - visible);
  if (state.autoExposure === true) {
    // Ruling E2's camera mode: hand the true linear radiometry to the
    // exposure chain and let it re-meter.
    return flux;
  }
  return Math.pow(flux, ECLIPSE_ADAPTATION_EXPONENT);
}

export {
  createEclipseState,
  updateEclipseState,
  getEclipseSunFactor,
  getEclipseSceneLightFactor,
  computeMoonPositionWC,
  computeSunPositionWC,
  ECLIPSE_FULL_SUN_ILLUMINANCE,
  ECLIPSE_TOTALITY_ILLUMINANCE,
  ECLIPSE_RADIOMETRIC_FLOOR,
  ECLIPSE_ADAPTATION_EXPONENT,
  ECLIPSE_TWILIGHT_FLOOR,
};
export default updateEclipseState;
