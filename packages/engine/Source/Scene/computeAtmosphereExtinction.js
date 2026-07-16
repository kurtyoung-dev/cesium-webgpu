import Cartesian3 from "../Core/Cartesian3.js";
import defined from "../Core/defined.js";

// Thickness of the scattering atmosphere shell, in meters. Matches the
// `ATMOSPHERE_THICKNESS` constant in AtmosphereCommon.glsl so the moon's
// extinction integration uses the same outer boundary as the sky-atmosphere
// scattering pass.
const ATMOSPHERE_THICKNESS = 111e3;

// Number of samples along the camera→body ray used to integrate the Rayleigh
// and Mie optical depth. 16 matches the sky-atmosphere `PRIMARY_STEPS_MAX`;
// this runs once per frame per celestial body on the CPU, so the cost is
// negligible.
const EXTINCTION_STEPS = 16;

const scratchDir = new Cartesian3();
const scratchSample = new Cartesian3();

/**
 * Computes the RGB atmospheric transmittance (extinction factor) for light
 * travelling from a distant celestial body (Moon, Sun) through Earth's
 * atmosphere to the camera. The result is a per-channel multiplier in
 * [0, 1]: near the horizon the long slant path through the dense lower
 * atmosphere drives the factor toward zero and reddens it (blue is
 * scattered out first, matching the larger Rayleigh coefficient for blue),
 * reproducing the way a real Moon dims and reddens as it approaches the
 * horizon. From orbit — where the view ray to the body never crosses the
 * atmosphere shell — the optical depth is exactly zero, so the factor is
 * exactly {@link Cartesian3#ONE} and the body is byte-identically unchanged.
 *
 * The integration reuses the same Rayleigh/Mie scattering coefficients and
 * scale heights that drive the sky-atmosphere pass ({@link Atmosphere}), so
 * the extinction stays consistent with the rendered sky.
 *
 * @param {Cartesian3} result The Cartesian3 to store the RGB transmittance.
 * @param {Cartesian3} cameraPositionWC Camera position, Earth-centered fixed.
 * @param {Cartesian3} bodyPositionWC Celestial body position, Earth-centered fixed.
 * @param {Atmosphere} atmosphere The scene atmosphere (scattering coefficients + scale heights).
 * @param {number} innerRadius The atmosphere inner radius (Earth ellipsoid maximum radius), meters.
 * @returns {Cartesian3} The `result` parameter, set to the RGB transmittance.
 * @private
 */
function computeAtmosphereExtinction(
  result,
  cameraPositionWC,
  bodyPositionWC,
  atmosphere,
  innerRadius,
) {
  if (!defined(result)) {
    result = new Cartesian3();
  }

  // No atmosphere data → no extinction (identity).
  if (
    !defined(atmosphere) ||
    !defined(cameraPositionWC) ||
    innerRadius <= 0.0
  ) {
    return Cartesian3.clone(Cartesian3.ONE, result);
  }

  const bodyPos = defined(bodyPositionWC) ? bodyPositionWC : undefined;
  if (!defined(bodyPos)) {
    return Cartesian3.clone(Cartesian3.ONE, result);
  }

  // Ray from the camera toward the body (Earth-centered fixed frame).
  Cartesian3.subtract(bodyPos, cameraPositionWC, scratchDir);
  const bodyDistance = Cartesian3.magnitude(scratchDir);
  if (bodyDistance <= 0.0) {
    return Cartesian3.clone(Cartesian3.ONE, result);
  }
  Cartesian3.divideByScalar(scratchDir, bodyDistance, scratchDir);

  const outerRadius = innerRadius + ATMOSPHERE_THICKNESS;

  // Intersect the ray (origin = camera, unit dir) with the outer atmosphere
  // sphere centered at the Earth's center (the origin of the fixed frame).
  // Because dir is unit length, a == 1.
  const b = 2.0 * Cartesian3.dot(cameraPositionWC, scratchDir);
  const cameraRadiusSq = Cartesian3.dot(cameraPositionWC, cameraPositionWC);
  const c = cameraRadiusSq - outerRadius * outerRadius;
  const disc = b * b - 4.0 * c;
  if (disc <= 0.0) {
    // Ray never crosses the atmosphere shell (e.g. from deep space looking
    // away from Earth) → no extinction.
    return Cartesian3.clone(Cartesian3.ONE, result);
  }
  const sqrtDisc = Math.sqrt(disc);
  const t0 = (-b - sqrtDisc) * 0.5;
  const t1 = (-b + sqrtDisc) * 0.5;

  // Entry is the first crossing in front of the camera (0 if the camera is
  // already inside the shell); exit is the far crossing, clamped to the
  // distance to the body (the body sits far outside the shell, so this is
  // effectively `t1`).
  const tEntry = Math.max(t0, 0.0);
  const tExit = Math.min(t1, bodyDistance);
  if (tExit <= tEntry) {
    // The atmosphere segment is behind the camera or degenerate.
    return Cartesian3.clone(Cartesian3.ONE, result);
  }

  const rayleighScaleHeight = atmosphere.rayleighScaleHeight;
  const mieScaleHeight = atmosphere.mieScaleHeight;

  const segmentLength = tExit - tEntry;
  const stepLength = segmentLength / EXTINCTION_STEPS;
  let rayleighOpticalDepth = 0.0;
  let mieOpticalDepth = 0.0;

  for (let i = 0; i < EXTINCTION_STEPS; ++i) {
    const t = tEntry + (i + 0.5) * stepLength;
    Cartesian3.multiplyByScalar(scratchDir, t, scratchSample);
    Cartesian3.add(cameraPositionWC, scratchSample, scratchSample);
    // Height above the atmosphere inner radius. Clamp to >= 0 so a sample
    // that dips fractionally below the reference sphere (numerical, or a
    // ray grazing the surface) does not produce a runaway exp() term.
    const height = Math.max(
      Cartesian3.magnitude(scratchSample) - innerRadius,
      0.0,
    );
    rayleighOpticalDepth +=
      Math.exp(-height / rayleighScaleHeight) * stepLength;
    mieOpticalDepth += Math.exp(-height / mieScaleHeight) * stepLength;
  }

  const rayleigh = atmosphere.rayleighCoefficient;
  const mie = atmosphere.mieCoefficient;

  result.x = Math.exp(
    -(rayleigh.x * rayleighOpticalDepth + mie.x * mieOpticalDepth),
  );
  result.y = Math.exp(
    -(rayleigh.y * rayleighOpticalDepth + mie.y * mieOpticalDepth),
  );
  result.z = Math.exp(
    -(rayleigh.z * rayleighOpticalDepth + mie.z * mieOpticalDepth),
  );

  return result;
}

const CACHE_MODE_UNINITIALIZED = 0;
const CACHE_MODE_DISABLED = 1;
const CACHE_MODE_MISSING_INPUT = 2;
const CACHE_MODE_ENABLED = 3;

/**
 * Creates a caller-owned scalar cache for {@link computeAtmosphereExtinctionCached}.
 * The cache is intended to be created once per celestial primitive and reused for
 * every update.
 *
 * @returns {object} The cache state.
 * @private
 */
function createAtmosphereExtinctionCache() {
  return {
    _mode: CACHE_MODE_UNINITIALIZED,
    _cameraX: 0.0,
    _cameraY: 0.0,
    _cameraZ: 0.0,
    _bodyX: 0.0,
    _bodyY: 0.0,
    _bodyZ: 0.0,
    _innerRadius: 0.0,
    _rayleighX: 0.0,
    _rayleighY: 0.0,
    _rayleighZ: 0.0,
    _mieX: 0.0,
    _mieY: 0.0,
    _mieZ: 0.0,
    _rayleighScaleHeight: 0.0,
    _mieScaleHeight: 0.0,
    _resultX: 1.0,
    _resultY: 1.0,
    _resultZ: 1.0,
    computations: 0,
    hits: 0,
  };
}

function setCachedResult(cache, result) {
  result.x = cache._resultX;
  result.y = cache._resultY;
  result.z = cache._resultZ;
  return result;
}

function setIdentityResult(cache, result, mode) {
  cache._mode = mode;
  cache._resultX = 1.0;
  cache._resultY = 1.0;
  cache._resultZ = 1.0;
  result.x = 1.0;
  result.y = 1.0;
  result.z = 1.0;
  return result;
}

/**
 * Computes atmospheric extinction only when one of its exact scalar inputs has
 * changed. Cache hits copy the cached RGB scalars into the caller-owned result;
 * no vectors, arrays, strings, or hashes are allocated on the steady-state path.
 *
 * Disabled extinction and incomplete inputs produce the exact multiplicative
 * identity. Those states are kept separate from an enabled result so disabling
 * and then re-enabling the effect cannot reuse stale extinction.
 *
 * @param {object} cache A cache returned by {@link createAtmosphereExtinctionCache}.
 * @param {Cartesian3} result The caller-owned Cartesian3 to store the result.
 * @param {boolean} enabled Whether atmospheric extinction is enabled.
 * @param {Cartesian3} cameraPositionWC Camera position, Earth-centered fixed.
 * @param {Cartesian3} bodyPositionWC Celestial body position, Earth-centered fixed.
 * @param {Atmosphere} atmosphere The scene atmosphere.
 * @param {number} innerRadius The atmosphere inner radius, in meters.
 * @returns {Cartesian3} The caller-owned `result` parameter.
 * @private
 */
function computeAtmosphereExtinctionCached(
  cache,
  result,
  enabled,
  cameraPositionWC,
  bodyPositionWC,
  atmosphere,
  innerRadius,
) {
  if (!defined(result)) {
    result = new Cartesian3();
  }

  if (enabled !== true) {
    if (cache._mode === CACHE_MODE_DISABLED) {
      ++cache.hits;
      return setCachedResult(cache, result);
    }
    return setIdentityResult(cache, result, CACHE_MODE_DISABLED);
  }

  const rayleigh = defined(atmosphere)
    ? atmosphere.rayleighCoefficient
    : undefined;
  const mie = defined(atmosphere) ? atmosphere.mieCoefficient : undefined;
  if (
    !defined(cameraPositionWC) ||
    !defined(bodyPositionWC) ||
    !defined(cameraPositionWC.x) ||
    !defined(cameraPositionWC.y) ||
    !defined(cameraPositionWC.z) ||
    !defined(bodyPositionWC.x) ||
    !defined(bodyPositionWC.y) ||
    !defined(bodyPositionWC.z) ||
    !defined(atmosphere) ||
    !defined(rayleigh) ||
    !defined(mie) ||
    !defined(rayleigh.x) ||
    !defined(rayleigh.y) ||
    !defined(rayleigh.z) ||
    !defined(mie.x) ||
    !defined(mie.y) ||
    !defined(mie.z) ||
    !defined(atmosphere.rayleighScaleHeight) ||
    !defined(atmosphere.mieScaleHeight) ||
    !defined(innerRadius) ||
    innerRadius <= 0.0
  ) {
    if (cache._mode === CACHE_MODE_MISSING_INPUT) {
      ++cache.hits;
      return setCachedResult(cache, result);
    }
    return setIdentityResult(cache, result, CACHE_MODE_MISSING_INPUT);
  }

  const rayleighScaleHeight = atmosphere.rayleighScaleHeight;
  const mieScaleHeight = atmosphere.mieScaleHeight;
  if (
    cache._mode === CACHE_MODE_ENABLED &&
    cache._cameraX === cameraPositionWC.x &&
    cache._cameraY === cameraPositionWC.y &&
    cache._cameraZ === cameraPositionWC.z &&
    cache._bodyX === bodyPositionWC.x &&
    cache._bodyY === bodyPositionWC.y &&
    cache._bodyZ === bodyPositionWC.z &&
    cache._innerRadius === innerRadius &&
    cache._rayleighX === rayleigh.x &&
    cache._rayleighY === rayleigh.y &&
    cache._rayleighZ === rayleigh.z &&
    cache._mieX === mie.x &&
    cache._mieY === mie.y &&
    cache._mieZ === mie.z &&
    cache._rayleighScaleHeight === rayleighScaleHeight &&
    cache._mieScaleHeight === mieScaleHeight
  ) {
    ++cache.hits;
    return setCachedResult(cache, result);
  }

  computeAtmosphereExtinction(
    result,
    cameraPositionWC,
    bodyPositionWC,
    atmosphere,
    innerRadius,
  );

  cache._mode = CACHE_MODE_ENABLED;
  cache._cameraX = cameraPositionWC.x;
  cache._cameraY = cameraPositionWC.y;
  cache._cameraZ = cameraPositionWC.z;
  cache._bodyX = bodyPositionWC.x;
  cache._bodyY = bodyPositionWC.y;
  cache._bodyZ = bodyPositionWC.z;
  cache._innerRadius = innerRadius;
  cache._rayleighX = rayleigh.x;
  cache._rayleighY = rayleigh.y;
  cache._rayleighZ = rayleigh.z;
  cache._mieX = mie.x;
  cache._mieY = mie.y;
  cache._mieZ = mie.z;
  cache._rayleighScaleHeight = rayleighScaleHeight;
  cache._mieScaleHeight = mieScaleHeight;
  cache._resultX = result.x;
  cache._resultY = result.y;
  cache._resultZ = result.z;
  ++cache.computations;

  return result;
}

export { createAtmosphereExtinctionCache, computeAtmosphereExtinctionCached };
export default computeAtmosphereExtinction;
