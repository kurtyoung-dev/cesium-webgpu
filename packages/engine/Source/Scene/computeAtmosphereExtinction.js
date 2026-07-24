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

// C12-30 — number of samples for the in-scattering (sky-wash) integral.
// Primary matches EXTINCTION_STEPS / the sky shader's PRIMARY_STEPS_MAX;
// the light (secondary) march matches the sky shader's LIGHT_STEPS_MAX.
const INSCATTER_PRIMARY_STEPS = 16;
const INSCATTER_LIGHT_STEPS = 4;

const scratchDir = new Cartesian3();
const scratchSample = new Cartesian3();
const scratchLightSample = new Cartesian3();

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

// ─────────────────────────────────────────────────────────────────────────
// C12-30 — atmospheric IN-SCATTERING (sky-wash) for celestial bodies.
//
// Extinction (above) is the multiplicative half of the atmospheric transfer
// along the camera→body ray: how much body light survives the path. This is
// the ADDITIVE half: how much sunlight is scattered INTO the path — the sky
// radiance rendered "in front of" the body's disc. Because the Moon/Sun
// discs are drawn opaquely OVER the sky-atmosphere shell, the disc pixels
// lose the sky radiance the neighboring pixels keep, so a daytime moon
// reads as a dark cutout against the bright sky. The correct composite is
//
//     pixel = discColor × extinction + inscatter
//
// mirroring the radiative transfer solution L = L0·T + ∫ S·T dt.
//
// The integral below is a CPU port of the sky-atmosphere shader's own
// single-scattering model (AtmosphereCommon.glsl `computeScattering` +
// `computeAtmosphereColor`, and the WGSL twin in SkyAtmosphere.wgsl):
// same 111 km shell, same Rayleigh/Mie coefficients + scale heights, same
// 16-step primary / 4-step light march, same Rayleigh + Henyey-Greenstein
// phase functions, same lightIntensity scale — so the disc wash matches
// the sky the atmosphere pass actually renders around it. Deliberate
// simplifications, each documented at its site:
//   - primary sample heights clamp to >= 0 (matches the sibling extinction
//     integrator; avoids over-dense samples when the reference sphere sits
//     above local terrain);
//   - the light march does NOT clamp heights — a light path through the
//     planet accumulates enormous optical depth and the attenuation goes
//     to zero, which IS the earth-shadow / night behavior (the shader's
//     `nightAlpha` stylistic gate is not replicated; the physics covers it);
//   - the shader's adaptive step-count/step-length heuristics are perf
//     optimizations for the GPU and are skipped (fixed 16/4 CPU steps).
//
// Display-space matching: with HDR off (the default) the sky FS tonemaps
// in-shader (czm_pbrNeutralTonemapping + czm_inverseGamma in GLSL; the
// unconditional tonemap chain in SkyAtmosphere.wgsl) and alpha-blends with
// `alpha = mix(color.b, 1.0, heightOpacity)` over the (near-black) space
// background. The wash reproduces that exact chain when `applyTonemap` is
// true so the disc blends seamlessly into the rendered sky; when HDR is on
// the caller passes false and the linear radiance rides the PP tonemap.
// ─────────────────────────────────────────────────────────────────────────

// JS port of czm_pbrNeutralTonemapping (KhronosGroup PBR Neutral).
// Operates on the result Cartesian3 in place.
function pbrNeutralTonemapInPlace(color) {
  const startCompression = 0.8 - 0.04;
  const desaturation = 0.15;
  let r = color.x;
  let g = color.y;
  let b = color.z;
  const x = Math.min(r, Math.min(g, b));
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= offset;
  g -= offset;
  b -= offset;
  const peak = Math.max(r, Math.max(g, b));
  if (peak < startCompression) {
    color.x = r;
    color.y = g;
    color.z = b;
    return color;
  }
  const d = 1.0 - startCompression;
  const newPeak = 1.0 - (d * d) / (peak + d - startCompression);
  const scale = newPeak / peak;
  r *= scale;
  g *= scale;
  b *= scale;
  const mixT = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  color.x = r + (newPeak - r) * mixT;
  color.y = g + (newPeak - g) * mixT;
  color.z = b + (newPeak - b) * mixT;
  return color;
}

/**
 * Computes the RGB in-scattered sky radiance (sky-wash) along the ray from
 * the camera to a distant celestial body (Moon, Sun), in display space.
 * This is the additive companion of {@link computeAtmosphereExtinction}:
 * an opaque celestial disc drawn over the sky-atmosphere shell should be
 * composited as `disc × extinction + inscatter` so a daytime body reads as
 * a pale, sky-washed disc instead of a dark cutout. Exactly
 * {@link Cartesian3#ZERO} when the ray never crosses the atmosphere shell
 * (from orbit / atmosphere hidden), so the body is byte-identically
 * unchanged there — the same identity contract as the extinction.
 *
 * @param {Cartesian3} result The Cartesian3 to store the RGB wash.
 * @param {Cartesian3} cameraPositionWC Camera position, Earth-centered fixed.
 * @param {Cartesian3} bodyPositionWC Celestial body position, Earth-centered fixed.
 * @param {Cartesian3} sunDirectionWC Unit direction toward the Sun, Earth-centered fixed.
 * @param {Atmosphere} atmosphere The scene atmosphere (coefficients, scale heights, lightIntensity, mieAnisotropy).
 * @param {number} innerRadius The atmosphere inner radius (Earth ellipsoid maximum radius), meters.
 * @param {boolean} applyTonemap Whether to apply the sky FS's non-HDR display transform (PBR Neutral + inverse gamma).
 * @param {number} gamma The scene gamma used by czm_inverseGamma (Scene.gamma, default 2.2).
 * @returns {Cartesian3} The `result` parameter, set to the RGB wash.
 * @private
 */
function computeAtmosphereInscatter(
  result,
  cameraPositionWC,
  bodyPositionWC,
  sunDirectionWC,
  atmosphere,
  innerRadius,
  applyTonemap,
  gamma,
) {
  if (!defined(result)) {
    result = new Cartesian3();
  }

  if (
    !defined(atmosphere) ||
    !defined(cameraPositionWC) ||
    !defined(bodyPositionWC) ||
    !defined(sunDirectionWC) ||
    innerRadius <= 0.0
  ) {
    return Cartesian3.clone(Cartesian3.ZERO, result);
  }

  // Ray from the camera toward the body (Earth-centered fixed frame).
  Cartesian3.subtract(bodyPositionWC, cameraPositionWC, scratchDir);
  const bodyDistance = Cartesian3.magnitude(scratchDir);
  if (bodyDistance <= 0.0) {
    return Cartesian3.clone(Cartesian3.ZERO, result);
  }
  Cartesian3.divideByScalar(scratchDir, bodyDistance, scratchDir);

  const outerRadius = innerRadius + ATMOSPHERE_THICKNESS;

  // Intersect the (unit-direction) ray with the outer atmosphere sphere.
  const b = 2.0 * Cartesian3.dot(cameraPositionWC, scratchDir);
  const cameraRadiusSq = Cartesian3.dot(cameraPositionWC, cameraPositionWC);
  const c = cameraRadiusSq - outerRadius * outerRadius;
  const disc = b * b - 4.0 * c;
  if (disc <= 0.0) {
    return Cartesian3.clone(Cartesian3.ZERO, result);
  }
  const sqrtDisc = Math.sqrt(disc);
  const t0 = (-b - sqrtDisc) * 0.5;
  const t1 = (-b + sqrtDisc) * 0.5;
  const tEntry = Math.max(t0, 0.0);
  const tExit = Math.min(t1, bodyDistance);
  if (tExit <= tEntry) {
    return Cartesian3.clone(Cartesian3.ZERO, result);
  }

  const rayleigh = atmosphere.rayleighCoefficient;
  const mie = atmosphere.mieCoefficient;
  const rayleighScaleHeight = atmosphere.rayleighScaleHeight;
  const mieScaleHeight = atmosphere.mieScaleHeight;

  const stepLength = (tExit - tEntry) / INSCATTER_PRIMARY_STEPS;

  // Running camera→sample optical depth (x = Rayleigh, y = Mie), matching
  // the shader's `opticalDepth` accumulator.
  let odRayleigh = 0.0;
  let odMie = 0.0;
  let rayleighAccumX = 0.0;
  let rayleighAccumY = 0.0;
  let rayleighAccumZ = 0.0;
  let mieAccumX = 0.0;
  let mieAccumY = 0.0;
  let mieAccumZ = 0.0;

  for (let i = 0; i < INSCATTER_PRIMARY_STEPS; ++i) {
    const t = tEntry + (i + 0.5) * stepLength;
    Cartesian3.multiplyByScalar(scratchDir, t, scratchSample);
    Cartesian3.add(cameraPositionWC, scratchSample, scratchSample);
    // Primary heights clamp to >= 0 — same rationale as the extinction
    // integrator above (a grazing sample fractionally below the reference
    // sphere must not produce a runaway density).
    const sampleHeight = Math.max(
      Cartesian3.magnitude(scratchSample) - innerRadius,
      0.0,
    );
    const densityRayleigh =
      Math.exp(-sampleHeight / rayleighScaleHeight) * stepLength;
    const densityMie = Math.exp(-sampleHeight / mieScaleHeight) * stepLength;
    odRayleigh += densityRayleigh;
    odMie += densityMie;

    // Light march: from the sample toward the sun, to the outer shell.
    // The sample is inside the shell so the far crossing is positive.
    const lb = 2.0 * Cartesian3.dot(scratchSample, sunDirectionWC);
    const lc =
      Cartesian3.dot(scratchSample, scratchSample) - outerRadius * outerRadius;
    const lDisc = lb * lb - 4.0 * lc;
    let lodRayleigh = 0.0;
    let lodMie = 0.0;
    if (lDisc > 0.0) {
      const lightExit = (-lb + Math.sqrt(lDisc)) * 0.5;
      const lightStepLength = lightExit / INSCATTER_LIGHT_STEPS;
      for (let j = 0; j < INSCATTER_LIGHT_STEPS; ++j) {
        const lt = (j + 0.5) * lightStepLength;
        Cartesian3.multiplyByScalar(sunDirectionWC, lt, scratchLightSample);
        Cartesian3.add(scratchSample, scratchLightSample, scratchLightSample);
        // NO height clamp here (unlike the primary march): a light path
        // that dives through the planet interior must accumulate enormous
        // optical depth so the attenuation goes to zero — that IS the
        // earth-shadow / night falloff.
        const lightHeight =
          Cartesian3.magnitude(scratchLightSample) - innerRadius;
        lodRayleigh +=
          Math.exp(-lightHeight / rayleighScaleHeight) * lightStepLength;
        lodMie += Math.exp(-lightHeight / mieScaleHeight) * lightStepLength;
      }
    }

    const attenX = Math.exp(
      -(mie.x * (odMie + lodMie) + rayleigh.x * (odRayleigh + lodRayleigh)),
    );
    const attenY = Math.exp(
      -(mie.y * (odMie + lodMie) + rayleigh.y * (odRayleigh + lodRayleigh)),
    );
    const attenZ = Math.exp(
      -(mie.z * (odMie + lodMie) + rayleigh.z * (odRayleigh + lodRayleigh)),
    );

    rayleighAccumX += densityRayleigh * attenX;
    rayleighAccumY += densityRayleigh * attenY;
    rayleighAccumZ += densityRayleigh * attenZ;
    mieAccumX += densityMie * attenX;
    mieAccumY += densityMie * attenY;
    mieAccumZ += densityMie * attenZ;
  }

  // Phase functions — identical constants to computeAtmosphereColor:
  // Rayleigh 3/(16π)(1 + cos²θ); Mie 3/(8π)·((1−g²)(1+cos²θ)) /
  // ((2+g²)(1+g²−2g·cosθ)^1.5).
  const cosAngle = Cartesian3.dot(scratchDir, sunDirectionWC);
  const cosAngleSq = cosAngle * cosAngle;
  const g = atmosphere.mieAnisotropy;
  const gSq = g * g;
  const rayleighPhase = (3.0 / 50.2654824574) * (1.0 + cosAngleSq);
  const miePhase =
    ((3.0 / 25.1327412287) * ((1.0 - gSq) * (cosAngleSq + 1.0))) /
    (Math.pow(1.0 + gSq - 2.0 * cosAngle * g, 1.5) * (2.0 + gSq));

  const lightIntensity = atmosphere.lightIntensity;
  result.x =
    (rayleighPhase * rayleigh.x * rayleighAccumX +
      miePhase * mie.x * mieAccumX) *
    lightIntensity;
  result.y =
    (rayleighPhase * rayleigh.y * rayleighAccumY +
      miePhase * mie.y * mieAccumY) *
    lightIntensity;
  result.z =
    (rayleighPhase * rayleigh.z * rayleighAccumZ +
      miePhase * mie.z * mieAccumZ) *
    lightIntensity;

  // Display transform — the sky FS's non-HDR chain (PBR Neutral + inverse
  // gamma), gated so an HDR pipeline can keep the wash linear.
  if (applyTonemap === true) {
    pbrNeutralTonemapInPlace(result);
    const invGamma = 1.0 / (defined(gamma) && gamma > 0.0 ? gamma : 2.2);
    result.x = Math.pow(Math.max(result.x, 0.0), invGamma);
    result.y = Math.pow(Math.max(result.y, 0.0), invGamma);
    result.z = Math.pow(Math.max(result.z, 0.0), invGamma);
  }

  // Alpha composite over the (near-black) space background, matching the
  // sky FS: heightOpacity fades the shell out as the camera climbs to the
  // shell top, and `alpha = mix(color.b, 1.0, heightOpacity)` keeps the
  // blue rim visible from orbit exactly like the rendered sky does.
  const cameraRadius = Math.sqrt(cameraRadiusSq);
  const heightOpacity = Math.min(
    Math.max((outerRadius - cameraRadius) / ATMOSPHERE_THICKNESS, 0.0),
    1.0,
  );
  const alphaBlue = Math.min(Math.max(result.z, 0.0), 1.0);
  const alpha = alphaBlue + (1.0 - alphaBlue) * heightOpacity;
  result.x *= alpha;
  result.y *= alpha;
  result.z *= alpha;

  return result;
}

/**
 * Creates a caller-owned scalar cache for {@link computeAtmosphereInscatterCached}.
 * Same contract as {@link createAtmosphereExtinctionCache}.
 *
 * @returns {object} The cache state.
 * @private
 */
function createAtmosphereInscatterCache() {
  return {
    _mode: CACHE_MODE_UNINITIALIZED,
    _cameraX: 0.0,
    _cameraY: 0.0,
    _cameraZ: 0.0,
    _bodyX: 0.0,
    _bodyY: 0.0,
    _bodyZ: 0.0,
    _sunX: 0.0,
    _sunY: 0.0,
    _sunZ: 0.0,
    _innerRadius: 0.0,
    _rayleighX: 0.0,
    _rayleighY: 0.0,
    _rayleighZ: 0.0,
    _mieX: 0.0,
    _mieY: 0.0,
    _mieZ: 0.0,
    _rayleighScaleHeight: 0.0,
    _mieScaleHeight: 0.0,
    _lightIntensity: 0.0,
    _mieAnisotropy: 0.0,
    _applyTonemap: false,
    _gamma: 0.0,
    _resultX: 0.0,
    _resultY: 0.0,
    _resultZ: 0.0,
    computations: 0,
    hits: 0,
  };
}

function setZeroResult(cache, result, mode) {
  cache._mode = mode;
  cache._resultX = 0.0;
  cache._resultY = 0.0;
  cache._resultZ = 0.0;
  result.x = 0.0;
  result.y = 0.0;
  result.z = 0.0;
  return result;
}

/**
 * Computes the atmospheric in-scattering wash only when one of its exact
 * scalar inputs has changed — the additive twin of
 * {@link computeAtmosphereExtinctionCached}. Disabled / incomplete inputs
 * produce the exact ADDITIVE identity (0,0,0).
 *
 * @param {object} cache A cache returned by {@link createAtmosphereInscatterCache}.
 * @param {Cartesian3} result The caller-owned Cartesian3 to store the result.
 * @param {boolean} enabled Whether the sky-wash is enabled.
 * @param {Cartesian3} cameraPositionWC Camera position, Earth-centered fixed.
 * @param {Cartesian3} bodyPositionWC Celestial body position, Earth-centered fixed.
 * @param {Cartesian3} sunDirectionWC Unit direction toward the Sun, Earth-centered fixed.
 * @param {Atmosphere} atmosphere The scene atmosphere.
 * @param {number} innerRadius The atmosphere inner radius, in meters.
 * @param {boolean} applyTonemap Whether to apply the non-HDR display transform.
 * @param {number} gamma The scene gamma.
 * @returns {Cartesian3} The caller-owned `result` parameter.
 * @private
 */
function computeAtmosphereInscatterCached(
  cache,
  result,
  enabled,
  cameraPositionWC,
  bodyPositionWC,
  sunDirectionWC,
  atmosphere,
  innerRadius,
  applyTonemap,
  gamma,
) {
  if (!defined(result)) {
    result = new Cartesian3();
  }

  if (enabled !== true) {
    if (cache._mode === CACHE_MODE_DISABLED) {
      ++cache.hits;
      return setCachedResult(cache, result);
    }
    return setZeroResult(cache, result, CACHE_MODE_DISABLED);
  }

  const rayleigh = defined(atmosphere)
    ? atmosphere.rayleighCoefficient
    : undefined;
  const mie = defined(atmosphere) ? atmosphere.mieCoefficient : undefined;
  if (
    !defined(cameraPositionWC) ||
    !defined(bodyPositionWC) ||
    !defined(sunDirectionWC) ||
    !defined(atmosphere) ||
    !defined(rayleigh) ||
    !defined(mie) ||
    !defined(atmosphere.rayleighScaleHeight) ||
    !defined(atmosphere.mieScaleHeight) ||
    !defined(atmosphere.lightIntensity) ||
    !defined(atmosphere.mieAnisotropy) ||
    !defined(innerRadius) ||
    innerRadius <= 0.0
  ) {
    if (cache._mode === CACHE_MODE_MISSING_INPUT) {
      ++cache.hits;
      return setCachedResult(cache, result);
    }
    return setZeroResult(cache, result, CACHE_MODE_MISSING_INPUT);
  }

  const rayleighScaleHeight = atmosphere.rayleighScaleHeight;
  const mieScaleHeight = atmosphere.mieScaleHeight;
  const lightIntensity = atmosphere.lightIntensity;
  const mieAnisotropy = atmosphere.mieAnisotropy;
  const tonemap = applyTonemap === true;
  const gammaValue = defined(gamma) ? gamma : 2.2;
  if (
    cache._mode === CACHE_MODE_ENABLED &&
    cache._cameraX === cameraPositionWC.x &&
    cache._cameraY === cameraPositionWC.y &&
    cache._cameraZ === cameraPositionWC.z &&
    cache._bodyX === bodyPositionWC.x &&
    cache._bodyY === bodyPositionWC.y &&
    cache._bodyZ === bodyPositionWC.z &&
    cache._sunX === sunDirectionWC.x &&
    cache._sunY === sunDirectionWC.y &&
    cache._sunZ === sunDirectionWC.z &&
    cache._innerRadius === innerRadius &&
    cache._rayleighX === rayleigh.x &&
    cache._rayleighY === rayleigh.y &&
    cache._rayleighZ === rayleigh.z &&
    cache._mieX === mie.x &&
    cache._mieY === mie.y &&
    cache._mieZ === mie.z &&
    cache._rayleighScaleHeight === rayleighScaleHeight &&
    cache._mieScaleHeight === mieScaleHeight &&
    cache._lightIntensity === lightIntensity &&
    cache._mieAnisotropy === mieAnisotropy &&
    cache._applyTonemap === tonemap &&
    cache._gamma === gammaValue
  ) {
    ++cache.hits;
    return setCachedResult(cache, result);
  }

  computeAtmosphereInscatter(
    result,
    cameraPositionWC,
    bodyPositionWC,
    sunDirectionWC,
    atmosphere,
    innerRadius,
    tonemap,
    gammaValue,
  );

  cache._mode = CACHE_MODE_ENABLED;
  cache._cameraX = cameraPositionWC.x;
  cache._cameraY = cameraPositionWC.y;
  cache._cameraZ = cameraPositionWC.z;
  cache._bodyX = bodyPositionWC.x;
  cache._bodyY = bodyPositionWC.y;
  cache._bodyZ = bodyPositionWC.z;
  cache._sunX = sunDirectionWC.x;
  cache._sunY = sunDirectionWC.y;
  cache._sunZ = sunDirectionWC.z;
  cache._innerRadius = innerRadius;
  cache._rayleighX = rayleigh.x;
  cache._rayleighY = rayleigh.y;
  cache._rayleighZ = rayleigh.z;
  cache._mieX = mie.x;
  cache._mieY = mie.y;
  cache._mieZ = mie.z;
  cache._rayleighScaleHeight = rayleighScaleHeight;
  cache._mieScaleHeight = mieScaleHeight;
  cache._lightIntensity = lightIntensity;
  cache._mieAnisotropy = mieAnisotropy;
  cache._applyTonemap = tonemap;
  cache._gamma = gammaValue;
  cache._resultX = result.x;
  cache._resultY = result.y;
  cache._resultZ = result.z;
  ++cache.computations;

  return result;
}

export {
  createAtmosphereExtinctionCache,
  computeAtmosphereExtinctionCached,
  computeAtmosphereInscatter,
  createAtmosphereInscatterCache,
  computeAtmosphereInscatterCached,
};
export default computeAtmosphereExtinction;
