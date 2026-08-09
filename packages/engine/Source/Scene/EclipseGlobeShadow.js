// Camera-independent lunar shadow data for globe fragments.
//
// Raw f32 Sun/Moon ECEF positions make the shader subtract Earth-scale and
// astronomical values before normalizing. High/low pairs do not repair that
// hot expression unless it is scaled first. This block instead publishes a
// geocentric common ray and a small differential, computed in CPU f64:
//
//   uS = normalize(S), a = 1 / |S|
//   dU = normalize(M) - uS, b = 1 / |M|
//
// For a fragment at ECEF P the shader/reference reconstructs scaled rays:
//
//   s = uS - P*a                    = (S - P) / |S|
//   D = dU + P*(a - b)
//   m = s + D                       = (M - P) / |M|
//
// The angular separation is evaluated without subtracting two independently
// rounded unit vectors:
//
//   d = atan2(|cross(s, D)|, dot(s, m))
//
// because cross(s,m) = cross(s,D). All operands are O(1) or smaller, the
// Moon-Sun differential retains its useful f32 bits, and the payload is
// independent of render/capture cameras. The globe shaders use the existing
// model-coordinate ECEF varying directly, then immediately multiply it by the
// tiny inverse ranges. This avoids reconstructing P through camera high/low
// state and keeps the eclipse payload safe for offscreen/cube-face Views.

// Reference: the umbra/penumbra construction is the standard two-cone
// solar-eclipse geometry — the shadow axis through the two body centres, the
// penumbra as the external tangent cone and the umbra as the internal one,
// with the observed obscuration read from the overlap of the two apparent
// discs. See Jean Meeus, "Astronomical Algorithms" (2nd edition, 1998),
// chapters 54 and 55, for the same construction in its classical form.

import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import defined from "../Core/defined.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import VerticalExaggeration from "../Core/VerticalExaggeration.js";
import {
  computeSolarObscuration,
  computeUniformObscuration,
} from "./computeSolarObscuration.js";
import {
  ECLIPSE_ADAPTATION_EXPONENT,
  ECLIPSE_RADIOMETRIC_FLOOR,
  eclipseSceneLightCurve,
} from "./EclipseState.js";
import SceneMode from "./SceneMode.js";
import SunLight from "./SunLight.js";

const FIT_SAMPLE_COUNT = 12;
const FIT_ANCHOR_LO = 0.05;
const FIT_ANCHOR_HI = 0.95;
const FIT_ANCHOR_FADE = 0.03;
// The exact local disc-support reject is evaluated in shader f32. WGSL permits
// fused/reassociated arithmetic, so retain 32 FLT_EPSILON of outward slack
// before declaring a fragment clear. False positives only reach the exact
// analytic lens test; false negatives would clip a real penumbra.
const ECLIPSE_BROAD_REJECT_SAFETY_FACTOR = Math.fround(
  1.0 - 32.0 * Math.pow(2.0, -23),
);

const fitSampleA = new Float64Array(FIT_SAMPLE_COUNT);
const fitSampleO = new Float64Array(FIT_SAMPLE_COUNT);
const fitNormalMatrix = new Float64Array(12);
const fitUnconstrained = { c1: 0.0, c2: 0.0, c3: 0.0 };
const fitConstrained = { c1: 0.0, c2: 0.0, c3: 0.0 };
const scratchFit = {
  c1: 0.0,
  c2: 0.0,
  c3: 0.0,
  annularLift: 0.0,
  anchorWeight: 0.0,
};

const scratchSunUnit = new Cartesian3();
const scratchMoonUnit = new Cartesian3();
const scratchChord = new Cartesian3();
const scratchScaledPosition = new Cartesian3();
const scratchScaledSunRay = new Cartesian3();
const scratchRayDelta = new Cartesian3();
const scratchCross = new Cartesian3();
const scratchEllipsoidPosition = new Cartesian3();
const scratchEllipsoidSunRay = new Cartesian3();
const scratchPenumbraAxis = new Cartesian3();
const scratchPenumbraApex = new Cartesian3();
const scratchPenumbraOffset = new Cartesian3();
const scratchPenumbraCross = new Cartesian3();
const scratchTerrainEclipseSphere = {
  center: new Cartesian3(),
  radius: 0.0,
};
const CPU_BROAD_REJECT_ROUNDING_MARGIN = 1.0 + 64.0 * Number.EPSILON;
// The mesh bounds are f64, while the rendered vertex reaches the fragment
// shader through f32 terrain decode/interpolation. Keep a two-metre floor for
// small bodies and scale by eight f32 epsilons for large custom ellipsoids.
// The latter covers several decode/interpolation operations without making an
// Earth-scale tile materially looser beside a kilometre-scale penumbra.
const TERRAIN_ECLIPSE_BOUND_SAFETY_METERS = 2.0;
const TERRAIN_ECLIPSE_BOUND_RELATIVE_SAFETY = 8.0 * Math.pow(2.0, -23);
const PENUMBRA_CONE_SAFETY_METERS = 1.0;
const SCALED_ENU_FINITE_INDICES = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14];

const scratchFrameGlobeOptions = {
  eclipseState: undefined,
  sceneLightFactor: 1.0,
  active: true,
  surfaceRadius: undefined,
  surfaceIntersectsPenumbra: undefined,
  sceneLightDimmed: true,
};

/**
 * Cubic map from uniform-disc overlap to limb-darkened obscuration. Its
 * endpoints are structural: h(0)=0 and h(1)=1 for all coefficients.
 *
 * @param {number} a
 * @param {number} c1
 * @param {number} c2
 * @param {number} c3
 * @returns {number}
 * @private
 */
function applyLimbDarkeningFit(a, c1, c2, c3) {
  return a + a * (1.0 - a) * (c1 + c2 * a + c3 * a * a);
}

/**
 * Well-conditioned angular separation for two unit vectors.
 *
 * @param {Cartesian3} u
 * @param {Cartesian3} v
 * @returns {number}
 * @private
 */
function angleBetweenUnitVectors(u, v) {
  const chord = Cartesian3.magnitude(Cartesian3.subtract(u, v, scratchChord));
  return 2.0 * Math.asin(Math.min(1.0, 0.5 * chord));
}

/**
 * Reference twin of the shader's fitted obscuration law.
 *
 * @param {number} rs Solar angular radius.
 * @param {number} ro Lunar angular radius.
 * @param {number} d Centre separation.
 * @param {number} c1
 * @param {number} c2
 * @param {number} c3
 * @param {number} annularLift
 * @returns {number}
 * @private
 */
function evaluateFragmentObscuration(rs, ro, d, c1, c2, c3, annularLift) {
  const a = computeUniformObscuration(rs, ro, d);
  if (!(a > 0.0)) {
    return 0.0;
  }
  if (a >= 1.0) {
    return 1.0;
  }

  const inner = rs - ro;
  let obscuration;
  if (inner > 0.0 && d <= inner) {
    const t = d / inner;
    obscuration =
      applyLimbDarkeningFit(a, c1, c2, c3) + annularLift * (1.0 - t * t);
  } else {
    obscuration = applyLimbDarkeningFit(a, c1, c2, c3);
  }
  return CesiumMath.clamp(obscuration, 0.0, 1.0);
}

/**
 * Solve a 3x3 augmented system in place without allocation.
 *
 * @param {Float64Array} matrix
 * @param {object} result
 * @returns {boolean}
 * @private
 */
function solve3x3(matrix, result) {
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) {
      if (
        Math.abs(matrix[row * 4 + column]) >
        Math.abs(matrix[pivot * 4 + column])
      ) {
        pivot = row;
      }
    }
    if (!(Math.abs(matrix[pivot * 4 + column]) > 0.0)) {
      return false;
    }
    if (pivot !== column) {
      for (let k = 0; k < 4; k++) {
        const swap = matrix[column * 4 + k];
        matrix[column * 4 + k] = matrix[pivot * 4 + k];
        matrix[pivot * 4 + k] = swap;
      }
    }
    for (let row = 0; row < 3; row++) {
      if (row === column) {
        continue;
      }
      const factor = matrix[row * 4 + column] / matrix[column * 4 + column];
      for (let k = column; k < 4; k++) {
        matrix[row * 4 + k] -= factor * matrix[column * 4 + k];
      }
    }
  }
  result.c1 = matrix[3] / matrix[0];
  result.c2 = matrix[7] / matrix[5];
  result.c3 = matrix[11] / matrix[10];
  return true;
}

/**
 * Fit the three-coefficient limb-darkening map once per active frame. The
 * optional camera anchor is faded out near 0/1, where the interpolation
 * constraint is ill-conditioned.
 *
 * @param {number} rs
 * @param {number} ro
 * @param {number} anchorSeparation
 * @param {number} anchorObscuration
 * @param {object} result
 * @returns {object}
 * @private
 */
function fitEclipseLimbDarkening(
  rs,
  ro,
  anchorSeparation,
  anchorObscuration,
  result,
) {
  result.c1 = 0.0;
  result.c2 = 0.0;
  result.c3 = 0.0;
  result.annularLift = 0.0;
  result.anchorWeight = 0.0;
  if (!(rs > 0.0) || !(ro > 0.0)) {
    return result;
  }

  const dLo = Math.abs(rs - ro);
  const dHi = rs + ro;
  const span = dHi - dLo;
  if (!(span > 0.0)) {
    return result;
  }

  let sampleCount = 0;
  for (let i = 1; i < FIT_SAMPLE_COUNT; i++) {
    const d = dLo + (span * i) / FIT_SAMPLE_COUNT;
    fitSampleA[sampleCount] = computeUniformObscuration(rs, ro, d);
    fitSampleO[sampleCount] = computeSolarObscuration(rs, ro, d);
    sampleCount++;
  }

  fitNormalMatrix.fill(0.0);
  for (let i = 0; i < sampleCount; i++) {
    const a = fitSampleA[i];
    const w = a * (1.0 - a);
    const b0 = w;
    const b1 = w * a;
    const b2 = w * a * a;
    const y = fitSampleO[i] - a;
    fitNormalMatrix[0] += b0 * b0;
    fitNormalMatrix[1] += b0 * b1;
    fitNormalMatrix[2] += b0 * b2;
    fitNormalMatrix[3] += b0 * y;
    fitNormalMatrix[4] += b1 * b0;
    fitNormalMatrix[5] += b1 * b1;
    fitNormalMatrix[6] += b1 * b2;
    fitNormalMatrix[7] += b1 * y;
    fitNormalMatrix[8] += b2 * b0;
    fitNormalMatrix[9] += b2 * b1;
    fitNormalMatrix[10] += b2 * b2;
    fitNormalMatrix[11] += b2 * y;
  }
  fitUnconstrained.c1 = 0.0;
  fitUnconstrained.c2 = 0.0;
  fitUnconstrained.c3 = 0.0;
  solve3x3(fitNormalMatrix, fitUnconstrained);

  let anchorA = -1.0;
  let weight = 0.0;
  if (
    defined(anchorSeparation) &&
    typeof anchorObscuration === "number" &&
    anchorObscuration > 0.0 &&
    anchorObscuration < 1.0 &&
    anchorSeparation > dLo &&
    anchorSeparation < dHi
  ) {
    const a = computeUniformObscuration(rs, ro, anchorSeparation);
    if (a > 0.0 && a < 1.0) {
      let t;
      if (a >= FIT_ANCHOR_LO && a <= FIT_ANCHOR_HI) {
        t = 1.0;
      } else if (a < FIT_ANCHOR_LO) {
        t = (a - (FIT_ANCHOR_LO - FIT_ANCHOR_FADE)) / FIT_ANCHOR_FADE;
      } else {
        t = (FIT_ANCHOR_HI + FIT_ANCHOR_FADE - a) / FIT_ANCHOR_FADE;
      }
      t = CesiumMath.clamp(t, 0.0, 1.0);
      weight = t * t * (3.0 - 2.0 * t);
      if (weight > 0.0) {
        anchorA = a;
      }
    }
  }

  if (anchorA > 0.0) {
    const q = (anchorObscuration - anchorA) / (anchorA * (1.0 - anchorA));
    const anchorASquared = anchorA * anchorA;
    let s22 = 0.0;
    let s23 = 0.0;
    let s33 = 0.0;
    let r2 = 0.0;
    let r3 = 0.0;
    for (let i = 0; i < sampleCount; i++) {
      const a = fitSampleA[i];
      const w = a * (1.0 - a);
      const b2 = w * (a - anchorA);
      const b3 = w * (a * a - anchorASquared);
      const y = fitSampleO[i] - a - w * q;
      s22 += b2 * b2;
      s23 += b2 * b3;
      s33 += b3 * b3;
      r2 += b2 * y;
      r3 += b3 * y;
    }
    const determinant = s22 * s33 - s23 * s23;
    let c2 = 0.0;
    let c3 = 0.0;
    if (Math.abs(determinant) > 0.0) {
      c2 = (r2 * s33 - r3 * s23) / determinant;
      c3 = (s22 * r3 - s23 * r2) / determinant;
    }
    fitConstrained.c1 = q - c2 * anchorA - c3 * anchorASquared;
    fitConstrained.c2 = c2;
    fitConstrained.c3 = c3;

    if (weight >= 1.0) {
      result.c1 = fitConstrained.c1;
      result.c2 = fitConstrained.c2;
      result.c3 = fitConstrained.c3;
    } else {
      result.c1 =
        fitUnconstrained.c1 +
        weight * (fitConstrained.c1 - fitUnconstrained.c1);
      result.c2 =
        fitUnconstrained.c2 +
        weight * (fitConstrained.c2 - fitUnconstrained.c2);
      result.c3 =
        fitUnconstrained.c3 +
        weight * (fitConstrained.c3 - fitUnconstrained.c3);
    }
    result.anchorWeight = weight;
  } else {
    result.c1 = fitUnconstrained.c1;
    result.c2 = fitUnconstrained.c2;
    result.c3 = fitUnconstrained.c3;
  }

  if (ro < rs) {
    const ratio = ro / rs;
    const aMax = ratio * ratio;
    const edge = applyLimbDarkeningFit(aMax, result.c1, result.c2, result.c3);
    result.annularLift = computeSolarObscuration(rs, ro, 0.0) - edge;
  }
  return result;
}

/**
 * Return the neighbouring f64 reciprocal that minimizes |f*r-1|.
 *
 * @param {number} factor
 * @returns {number}
 * @private
 */
function compositionReciprocal(factor) {
  const reciprocal = 1.0 / factor;
  let best = reciprocal;
  let bestError = Math.abs(factor * reciprocal - 1.0);
  if (bestError === 0.0) {
    return reciprocal;
  }

  const magnitude = Math.abs(reciprocal);
  if (!(magnitude > 0.0) || !isFinite(magnitude)) {
    return reciprocal;
  }
  const ulp = Math.pow(2.0, Math.floor(Math.log2(magnitude)) - 52);
  for (let step = 1; step <= 3; step++) {
    const up = reciprocal + step * ulp;
    const upError = Math.abs(factor * up - 1.0);
    if (upError < bestError) {
      best = up;
      bestError = upError;
    }
    const down = reciprocal - step * ulp;
    const downError = Math.abs(factor * down - 1.0);
    if (downError < bestError) {
      best = down;
      bestError = downError;
    }
  }
  return best;
}

/**
 * Reference composition of S2's camera factor with S5's fragment factor.
 *
 * @param {number} sceneLightFactor
 * @param {number} invSceneLightFactor
 * @param {number} fragmentObscuration
 * @param {boolean} autoExposure
 * @param {boolean} dimmedByS2
 * @returns {number}
 * @private
 */
function composeGlobeSurfaceFactor(
  sceneLightFactor,
  invSceneLightFactor,
  fragmentObscuration,
  autoExposure,
  dimmedByS2,
) {
  const absolute =
    fragmentObscuration > 0.0
      ? eclipseSceneLightCurve(fragmentObscuration, autoExposure)
      : 1.0;
  return dimmedByS2
    ? sceneLightFactor * (absolute * invSceneLightFactor)
    : absolute;
}

/**
 * Allocate the stable block consumed by both backends.
 *
 * `params.x`: 0 inert, 1 active/custom scene light, 2 active/SunLight dimmed,
 * 3 correction-only/SunLight, 4 correction-only/custom scene light.
 * `params.y`: reciprocal of S2's camera-anchored scene factor.
 *
 * @returns {object}
 * @private
 */
function createEclipseGlobeShadow() {
  const shadow = {
    revision: 0,
    active: false,
    sceneLightDimmed: false,
    anchorWeight: 0.0,
    sunDirectionAndInvRange: new Cartesian4(),
    moonDirectionDeltaAndInvRange: new Cartesian4(),
    params: new Cartesian4(0.0, 1.0, 0.0, 0.0),
    params2: new Cartesian4(
      ECLIPSE_RADIOMETRIC_FLOOR,
      ECLIPSE_ADAPTATION_EXPONENT,
      0.0,
      0.0,
    ),
    // WebGL has no shared per-View uniform block. Pack the four vectors into
    // one mat4 so every terrain draw performs one manual-uniform lookup and
    // one cached comparison instead of four. WebGPU continues to consume the
    // same logical vectors through its dedicated 64-byte UBO.
    webglPackedUniform: new Matrix4(),
  };
  syncWebGLPackedUniform(shadow);
  return shadow;
}

/**
 * Keep WebGL's single mat4 carrier in column-major vec4 order.
 *
 * @param {object} shadow
 * @private
 */
function syncWebGLPackedUniform(shadow) {
  const packed = shadow.webglPackedUniform;
  const sun = shadow.sunDirectionAndInvRange;
  const moon = shadow.moonDirectionDeltaAndInvRange;
  const params = shadow.params;
  const params2 = shadow.params2;
  packed[0] = sun.x;
  packed[1] = sun.y;
  packed[2] = sun.z;
  packed[3] = sun.w;
  packed[4] = moon.x;
  packed[5] = moon.y;
  packed[6] = moon.z;
  packed[7] = moon.w;
  packed[8] = params.x;
  packed[9] = params.y;
  packed[10] = params.z;
  packed[11] = params.w;
  packed[12] = params2.x;
  packed[13] = params2.y;
  packed[14] = params2.z;
  packed[15] = params2.w;
}

function sameF32(left, right) {
  return Math.fround(left) === Math.fround(right);
}

/**
 * Close the shader gate. The already-inert state is stable: ordinary
 * non-eclipse frames must not rotate a GPU slice or upload identical bytes.
 *
 * @param {object} shadow
 * @returns {object}
 * @private
 */
function resetEclipseGlobeShadow(shadow) {
  // The block is renderer-owned and reset writes every inert field together.
  // Once closed, ordinary frames can return without 16 f32 comparisons and
  // 16 stores. Active/correction-only states still take the full reset below.
  if (shadow.active !== true) {
    return shadow;
  }

  const changed =
    shadow.active === true ||
    !sameF32(shadow.sunDirectionAndInvRange.x, 0.0) ||
    !sameF32(shadow.sunDirectionAndInvRange.y, 0.0) ||
    !sameF32(shadow.sunDirectionAndInvRange.z, 0.0) ||
    !sameF32(shadow.sunDirectionAndInvRange.w, 0.0) ||
    !sameF32(shadow.moonDirectionDeltaAndInvRange.x, 0.0) ||
    !sameF32(shadow.moonDirectionDeltaAndInvRange.y, 0.0) ||
    !sameF32(shadow.moonDirectionDeltaAndInvRange.z, 0.0) ||
    !sameF32(shadow.moonDirectionDeltaAndInvRange.w, 0.0) ||
    !sameF32(shadow.params.x, 0.0) ||
    !sameF32(shadow.params.y, 1.0) ||
    !sameF32(shadow.params.z, 0.0) ||
    !sameF32(shadow.params.w, 0.0) ||
    !sameF32(shadow.params2.x, ECLIPSE_RADIOMETRIC_FLOOR) ||
    !sameF32(shadow.params2.y, ECLIPSE_ADAPTATION_EXPONENT) ||
    !sameF32(shadow.params2.z, 0.0) ||
    !sameF32(shadow.params2.w, 0.0);

  shadow.active = false;
  shadow.sceneLightDimmed = false;
  shadow.anchorWeight = 0.0;
  shadow.sunDirectionAndInvRange.x = 0.0;
  shadow.sunDirectionAndInvRange.y = 0.0;
  shadow.sunDirectionAndInvRange.z = 0.0;
  shadow.sunDirectionAndInvRange.w = 0.0;
  shadow.moonDirectionDeltaAndInvRange.x = 0.0;
  shadow.moonDirectionDeltaAndInvRange.y = 0.0;
  shadow.moonDirectionDeltaAndInvRange.z = 0.0;
  shadow.moonDirectionDeltaAndInvRange.w = 0.0;
  shadow.params.x = 0.0;
  shadow.params.y = 1.0;
  shadow.params.z = 0.0;
  shadow.params.w = 0.0;
  shadow.params2.x = ECLIPSE_RADIOMETRIC_FLOOR;
  shadow.params2.y = ECLIPSE_ADAPTATION_EXPONENT;
  shadow.params2.z = 0.0;
  shadow.params2.w = 0.0;
  if (changed) {
    syncWebGLPackedUniform(shadow);
    shadow.revision++;
  }
  return shadow;
}

/**
 * Publish only the reciprocal of S2's camera-anchored scene factor. This is
 * used when the camera sees an eclipse but the authoritative rendered-terrain
 * bound proves that no globe fragment can. The shader restores every term
 * that S2 actually dimmed (SunLight terrain plus ground atmosphere, or only
 * ground atmosphere for a custom light) without paying the per-fragment
 * common-ray, horizon, lens-overlap, or limb-fit work.
 *
 * @param {object} shadow
 * @param {number} invSceneLightFactor
 * @param {boolean} sceneLightDimmed
 * @returns {object}
 * @private
 */
function setCorrectionOnlyEclipseGlobeShadow(
  shadow,
  invSceneLightFactor,
  sceneLightDimmed,
) {
  const gate = sceneLightDimmed ? 3.0 : 4.0;
  const changed =
    shadow.active !== true ||
    shadow.sceneLightDimmed !== sceneLightDimmed ||
    !sameF32(shadow.sunDirectionAndInvRange.x, 0.0) ||
    !sameF32(shadow.sunDirectionAndInvRange.y, 0.0) ||
    !sameF32(shadow.sunDirectionAndInvRange.z, 0.0) ||
    !sameF32(shadow.sunDirectionAndInvRange.w, 0.0) ||
    !sameF32(shadow.moonDirectionDeltaAndInvRange.x, 0.0) ||
    !sameF32(shadow.moonDirectionDeltaAndInvRange.y, 0.0) ||
    !sameF32(shadow.moonDirectionDeltaAndInvRange.z, 0.0) ||
    !sameF32(shadow.moonDirectionDeltaAndInvRange.w, 0.0) ||
    !sameF32(shadow.params.x, gate) ||
    !sameF32(shadow.params.y, invSceneLightFactor) ||
    !sameF32(shadow.params.z, 0.0) ||
    !sameF32(shadow.params.w, 0.0) ||
    !sameF32(shadow.params2.x, ECLIPSE_RADIOMETRIC_FLOOR) ||
    !sameF32(shadow.params2.y, ECLIPSE_ADAPTATION_EXPONENT) ||
    !sameF32(shadow.params2.z, 0.0) ||
    !sameF32(shadow.params2.w, 0.0);

  shadow.active = true;
  shadow.sceneLightDimmed = sceneLightDimmed;
  shadow.anchorWeight = 0.0;
  shadow.sunDirectionAndInvRange.x = 0.0;
  shadow.sunDirectionAndInvRange.y = 0.0;
  shadow.sunDirectionAndInvRange.z = 0.0;
  shadow.sunDirectionAndInvRange.w = 0.0;
  shadow.moonDirectionDeltaAndInvRange.x = 0.0;
  shadow.moonDirectionDeltaAndInvRange.y = 0.0;
  shadow.moonDirectionDeltaAndInvRange.z = 0.0;
  shadow.moonDirectionDeltaAndInvRange.w = 0.0;
  shadow.params.x = gate;
  shadow.params.y = invSceneLightFactor;
  shadow.params.z = 0.0;
  shadow.params.w = 0.0;
  shadow.params2.x = ECLIPSE_RADIOMETRIC_FLOOR;
  shadow.params2.y = ECLIPSE_ADAPTATION_EXPONENT;
  shadow.params2.z = 0.0;
  shadow.params2.w = 0.0;
  if (changed) {
    syncWebGLPackedUniform(shadow);
    shadow.revision++;
  }
  return shadow;
}

/**
 * Conservative test for whether any point inside a planet-radius sphere can
 * see overlapping solar and lunar discs.
 *
 * @param {Cartesian3} sunPositionWC
 * @param {Cartesian3} moonPositionWC
 * @param {number} surfaceRadius
 * @returns {boolean}
 * @private
 */
function surfaceEclipsePossible(sunPositionWC, moonPositionWC, surfaceRadius) {
  const sunRange = Cartesian3.magnitude(sunPositionWC);
  const moonRange = Cartesian3.magnitude(moonPositionWC);
  if (!(sunRange > 0.0) || !(moonRange > 0.0)) {
    return false;
  }

  Cartesian3.divideByScalar(sunPositionWC, sunRange, scratchSunUnit);
  Cartesian3.divideByScalar(moonPositionWC, moonRange, scratchMoonUnit);

  // Cheap conservative reject for the overwhelmingly common non-eclipse
  // frame. For 0 <= x <= xMax,
  //
  //   asin(x) <= x / sqrt(1 - xMax^2).
  //
  // Therefore the sum below upper-bounds the two apparent body radii plus
  // both observer-sphere parallax angles. The unit-vector chord is no larger
  // than the exact centre angle, so chord > upperBound proves disjointness.
  // Near an eclipse (or any degenerate close-body geometry) we fall through
  // to the exact asin expression; this gate can only reject clear frames.
  const sunNear = Math.max(sunRange - surfaceRadius, 1.0);
  const moonNear = Math.max(moonRange - surfaceRadius, 1.0);
  const sunRadiusRatio = Math.min(1.0, CesiumMath.SOLAR_RADIUS / sunNear);
  const moonRadiusRatio = Math.min(1.0, CesiumMath.LUNAR_RADIUS / moonNear);
  const sunParallaxRatio = Math.min(1.0, surfaceRadius / sunRange);
  const moonParallaxRatio = Math.min(1.0, surfaceRadius / moonRange);
  const maximumRatio = Math.max(
    sunRadiusRatio,
    moonRadiusRatio,
    sunParallaxRatio,
    moonParallaxRatio,
  );
  if (maximumRatio < 1.0) {
    const angularSupportUpperBound =
      ((sunRadiusRatio +
        moonRadiusRatio +
        sunParallaxRatio +
        moonParallaxRatio) /
        Math.sqrt(1.0 - maximumRatio * maximumRatio)) *
      CPU_BROAD_REJECT_ROUNDING_MARGIN;
    Cartesian3.subtract(scratchSunUnit, scratchMoonUnit, scratchChord);
    if (
      Cartesian3.magnitudeSquared(scratchChord) >
      angularSupportUpperBound * angularSupportUpperBound
    ) {
      return false;
    }
  }

  const discSupport = maximumSurfaceDiscSupport(
    sunRange,
    moonRange,
    surfaceRadius,
  );
  const centreSeparation = angleBetweenUnitVectors(
    scratchSunUnit,
    scratchMoonUnit,
  );
  // Exact angular envelope of each body direction over the observer sphere.
  // The former near-distance small-angle ratio was safely conservative but
  // overstated the lunar envelope by roughly 100 km at the surface, keeping
  // the fragment path active outside a grazing penumbra. The asin form is the
  // tight no-false-negative bound.
  const surfaceParallax =
    Math.asin(Math.min(1.0, surfaceRadius / sunRange)) +
    Math.asin(Math.min(1.0, surfaceRadius / moonRange));
  return centreSeparation - surfaceParallax < discSupport;
}

/**
 * Maximum sum of the apparent solar and lunar angular radii for any observer
 * inside the supplied surface sphere.
 *
 * @param {number} sunRange
 * @param {number} moonRange
 * @param {number} surfaceRadius
 * @returns {number}
 * @private
 */
function maximumSurfaceDiscSupport(sunRange, moonRange, surfaceRadius) {
  const sunNear = Math.max(sunRange - surfaceRadius, 1.0);
  const moonNear = Math.max(moonRange - surfaceRadius, 1.0);
  const rsMax = Math.asin(Math.min(1.0, CesiumMath.SOLAR_RADIUS / sunNear));
  const roMax = Math.asin(Math.min(1.0, CesiumMath.LUNAR_RADIUS / moonNear));
  return rsMax + roMax;
}

function isFiniteCartesian3(value) {
  return (
    defined(value) &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

/**
 * Bound the unit cube transformed by a TerrainEncoding `fromScaledENU`
 * matrix. Terrain workers build this transform from an ENU AABB after adding
 * skirts, so it is the authoritative cheap bound for quantized terrain.
 *
 * @param {ArrayLike<number>} matrix
 * @param {{center: Cartesian3, radius: number}} result
 * @returns {object|undefined}
 * @private
 */
function computeScaledEnuBoundingSphere(matrix, result) {
  if (!defined(matrix)) {
    return undefined;
  }
  for (let i = 0; i < SCALED_ENU_FINITE_INDICES.length; i++) {
    if (!Number.isFinite(matrix[SCALED_ENU_FINITE_INDICES[i]])) {
      return undefined;
    }
  }

  const halfColumn0X = matrix[0] * 0.5;
  const halfColumn0Y = matrix[1] * 0.5;
  const halfColumn0Z = matrix[2] * 0.5;
  const halfColumn1X = matrix[4] * 0.5;
  const halfColumn1Y = matrix[5] * 0.5;
  const halfColumn1Z = matrix[6] * 0.5;
  const halfColumn2X = matrix[8] * 0.5;
  const halfColumn2Y = matrix[9] * 0.5;
  const halfColumn2Z = matrix[10] * 0.5;

  result.center.x = matrix[12] + halfColumn0X + halfColumn1X + halfColumn2X;
  result.center.y = matrix[13] + halfColumn0Y + halfColumn1Y + halfColumn2Y;
  result.center.z = matrix[14] + halfColumn0Z + halfColumn1Z + halfColumn2Z;

  // Do not assume the supplied transform is orthogonal. Eight scalar corner
  // checks are still allocation-free and preserve a no-false-negative bound
  // for custom terrain encodings with shear.
  let maximumRadiusSquared = 0.0;
  for (let corner = 0; corner < 8; corner++) {
    const sign0 = (corner & 1) === 0 ? -1.0 : 1.0;
    const sign1 = (corner & 2) === 0 ? -1.0 : 1.0;
    const sign2 = (corner & 4) === 0 ? -1.0 : 1.0;
    const x =
      sign0 * halfColumn0X + sign1 * halfColumn1X + sign2 * halfColumn2X;
    const y =
      sign0 * halfColumn0Y + sign1 * halfColumn1Y + sign2 * halfColumn2Y;
    const z =
      sign0 * halfColumn0Z + sign1 * halfColumn1Z + sign2 * halfColumn2Z;
    maximumRadiusSquared = Math.max(
      maximumRadiusSquared,
      x * x + y * y + z * z,
    );
  }
  result.radius = Math.sqrt(maximumRadiusSquared);
  return result;
}

/**
 * Conservatively intersect an ECEF bounding sphere with the solid lunar
 * penumbra cone.
 *
 * The cone is the common-internal-tangent surface of the solar and lunar
 * spheres. Its apex lies between the bodies and its one relevant nappe opens
 * from the Moon toward the Earth. Every observer from which the apparent
 * discs overlap lies inside this cone. Testing the solid cone against a sphere
 * can therefore produce harmless false positives from empty space inside a
 * loose terrain bound, but cannot reject real shadowed geometry.
 *
 * @param {Cartesian3} sunPositionWC
 * @param {Cartesian3} moonPositionWC
 * @param {{center: Cartesian3, radius: number}} boundingSphere
 * @returns {boolean}
 * @private
 */
function eclipsePenumbraIntersectsBoundingSphere(
  sunPositionWC,
  moonPositionWC,
  boundingSphere,
) {
  const center = boundingSphere?.center;
  const radius = boundingSphere?.radius;
  if (
    !isFiniteCartesian3(sunPositionWC) ||
    !isFiniteCartesian3(moonPositionWC) ||
    !isFiniteCartesian3(center) ||
    !Number.isFinite(radius) ||
    radius < 0.0
  ) {
    return true;
  }

  Cartesian3.subtract(moonPositionWC, sunPositionWC, scratchPenumbraAxis);
  const bodySeparation = Cartesian3.magnitude(scratchPenumbraAxis);
  const radiiSum = CesiumMath.SOLAR_RADIUS + CesiumMath.LUNAR_RADIUS;
  if (!(bodySeparation > radiiSum) || !Number.isFinite(bodySeparation)) {
    return true;
  }
  Cartesian3.divideByScalar(
    scratchPenumbraAxis,
    bodySeparation,
    scratchPenumbraAxis,
  );

  // Internal homothety centre:
  //   A = S + Rs/(Rs+Rm) * (M-S)
  Cartesian3.subtract(moonPositionWC, sunPositionWC, scratchPenumbraApex);
  Cartesian3.multiplyByScalar(
    scratchPenumbraApex,
    CesiumMath.SOLAR_RADIUS / radiiSum,
    scratchPenumbraApex,
  );
  Cartesian3.add(sunPositionWC, scratchPenumbraApex, scratchPenumbraApex);

  Cartesian3.subtract(center, scratchPenumbraApex, scratchPenumbraOffset);
  const axialDistance = Cartesian3.dot(
    scratchPenumbraOffset,
    scratchPenumbraAxis,
  );
  Cartesian3.cross(
    scratchPenumbraOffset,
    scratchPenumbraAxis,
    scratchPenumbraCross,
  );
  const radialDistance = Cartesian3.magnitude(scratchPenumbraCross);
  const sinHalfAngle = radiiSum / bodySeparation;
  const cosHalfAngle = Math.sqrt(
    Math.max(0.0, 1.0 - sinHalfAngle * sinHalfAngle),
  );

  // In the axial/radial cross-section, project the sphere centre onto a cone
  // generator. Behind the apex the closest point is the apex; otherwise the
  // positive signed line distance is the exact distance to the solid cone.
  const generatorProjection =
    axialDistance * cosHalfAngle + radialDistance * sinHalfAngle;
  let distanceToCone;
  if (generatorProjection < 0.0) {
    distanceToCone = Cartesian3.magnitude(scratchPenumbraOffset);
  } else {
    distanceToCone = Math.max(
      0.0,
      radialDistance * cosHalfAngle - axialDistance * sinHalfAngle,
    );
  }
  return distanceToCone <= radius + PENUMBRA_CONE_SAFETY_METERS;
}

/**
 * Build a conservative ECEF sphere for the mesh positions the terrain shader
 * actually renders.
 *
 * A TerrainEncoding's scaled-ENU AABB encloses the raw vertices including
 * quantized-mesh skirts. Some server-provided `boundingSphere3D` values omit
 * those client-generated skirts, so that sphere is only used when the index
 * buffer proves there are no skirts. Vertical exaggeration moves each vertex
 * along a unit geodetic normal by `exaggeratedHeight - height`; expanding the
 * base radius by the maximum endpoint displacement encloses the exaggerated
 * mesh without decoding or allocating per vertex.
 *
 * @param {object} mesh
 * @param {number} exaggeration
 * @param {number} exaggerationRelativeHeight
 * @param {{center: Cartesian3, radius: number}} result
 * @returns {object|undefined}
 * @private
 */
function computeRenderedMeshEclipseBoundingSphere(
  mesh,
  exaggeration,
  exaggerationRelativeHeight,
  result,
) {
  const rawSphere = mesh?.boundingSphere3D;
  if (!defined(result) || !defined(result.center)) {
    return undefined;
  }

  const indexLength = mesh.indices?.length;
  const indexCountWithoutSkirts = mesh.indexCountWithoutSkirts;
  const skirtPresenceKnown =
    Number.isFinite(indexLength) && Number.isFinite(indexCountWithoutSkirts);
  const hasSkirts =
    !skirtPresenceKnown || indexLength !== indexCountWithoutSkirts;
  const encodedSphere = computeScaledEnuBoundingSphere(
    mesh.encoding?.fromScaledENU,
    result,
  );
  if (!defined(encodedSphere)) {
    if (
      hasSkirts ||
      !isFiniteCartesian3(rawSphere?.center) ||
      !Number.isFinite(rawSphere?.radius) ||
      rawSphere.radius < 0.0
    ) {
      return undefined;
    }
    Cartesian3.clone(rawSphere.center, result.center);
    result.radius = rawSphere.radius;
  }

  let exaggerationExpansion = 0.0;
  if (exaggeration !== 1.0) {
    let minimumHeight = mesh.encoding?.minimumHeight;
    let maximumHeight = mesh.encoding?.maximumHeight;
    if (!Number.isFinite(minimumHeight) || !Number.isFinite(maximumHeight)) {
      if (hasSkirts) {
        return undefined;
      }
      minimumHeight = mesh.minimumHeight;
      maximumHeight = mesh.maximumHeight;
    }
    if (!Number.isFinite(minimumHeight) || !Number.isFinite(maximumHeight)) {
      return undefined;
    }

    const exaggeratedMinimum = VerticalExaggeration.getHeight(
      minimumHeight,
      exaggeration,
      exaggerationRelativeHeight,
    );
    const exaggeratedMaximum = VerticalExaggeration.getHeight(
      maximumHeight,
      exaggeration,
      exaggerationRelativeHeight,
    );
    if (
      !Number.isFinite(exaggeratedMinimum) ||
      !Number.isFinite(exaggeratedMaximum)
    ) {
      return undefined;
    }
    exaggerationExpansion = Math.max(
      Math.abs(exaggeratedMinimum - minimumHeight),
      Math.abs(exaggeratedMaximum - maximumHeight),
    );
  }

  const unprotectedRadius = result.radius + exaggerationExpansion;
  const coordinateScale =
    Cartesian3.magnitude(result.center) + unprotectedRadius;
  const safety = Math.max(
    TERRAIN_ECLIPSE_BOUND_SAFETY_METERS,
    coordinateScale * TERRAIN_ECLIPSE_BOUND_RELATIVE_SAFETY,
  );
  result.radius = unprotectedRadius + safety;
  return result;
}

/**
 * Test the rendered meshes in the selected quadtree list against the current
 * penumbra. This function is called only after the planet-wide O(1) broad
 * reject says an eclipse is possible.
 *
 * Missing mesh data means the tile emits no terrain draw. Invalid bounds for a
 * mesh that will draw are conservative-active.
 *
 * @param {object} eclipseState
 * @param {ArrayLike<object>} selectedTiles
 * @param {number} exaggeration
 * @param {number} exaggerationRelativeHeight
 * @returns {boolean}
 * @private
 */
function selectedTerrainIntersectsPenumbra(
  eclipseState,
  selectedTiles,
  exaggeration,
  exaggerationRelativeHeight,
) {
  const sunPositionWC = eclipseState?.sunPositionWC;
  const moonPositionWC = eclipseState?.moonPositionWC;
  if (
    !isFiniteCartesian3(sunPositionWC) ||
    !isFiniteCartesian3(moonPositionWC) ||
    !defined(selectedTiles)
  ) {
    return true;
  }

  for (let i = 0; i < selectedTiles.length; i++) {
    const mesh = selectedTiles[i]?.data?.renderedMesh;
    if (!defined(mesh)) {
      continue;
    }
    const sphere = computeRenderedMeshEclipseBoundingSphere(
      mesh,
      exaggeration,
      exaggerationRelativeHeight,
      scratchTerrainEclipseSphere,
    );
    if (
      !defined(sphere) ||
      eclipsePenumbraIntersectsBoundingSphere(
        sunPositionWC,
        moonPositionWC,
        sphere,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Update the block in place. Body rays are geocentric and therefore shared
 * across all render/pass cameras; only the fit/composition terms are anchored
 * to the supplied view-owned eclipse state.
 *
 * @param {object} shadow
 * @param {object} options
 * @param {object} [options.eclipseState]
 * @param {number} [options.sceneLightFactor=1.0]
 * @param {boolean} [options.active=true]
 * @param {number} [options.surfaceRadius]
 * @param {boolean} [options.surfaceIntersectsPenumbra]
 * @param {boolean} [options.sceneLightDimmed=false]
 * @returns {object}
 * @private
 */
function updateEclipseGlobeShadow(shadow, options) {
  const state = options.eclipseState;
  if (
    options.active === false ||
    !defined(state) ||
    state.enabled !== true ||
    state.valid !== true
  ) {
    return resetEclipseGlobeShadow(shadow);
  }

  const rs = state.sunAngularRadius;
  const ro = state.moonAngularRadius;
  const sunPosition = state.sunPositionWC;
  const moonPosition = state.moonPositionWC;
  if (
    !(rs > 0.0) ||
    !(ro > 0.0) ||
    !defined(sunPosition) ||
    !defined(moonPosition)
  ) {
    return resetEclipseGlobeShadow(shadow);
  }

  const surfaceRadius =
    typeof options.surfaceRadius === "number" &&
    Number.isFinite(options.surfaceRadius) &&
    options.surfaceRadius > 0.0
      ? options.surfaceRadius
      : undefined;
  const surfaceIntersectsPenumbra =
    typeof options.surfaceIntersectsPenumbra === "boolean"
      ? options.surfaceIntersectsPenumbra
      : !defined(surfaceRadius) ||
        surfaceEclipsePossible(sunPosition, moonPosition, surfaceRadius);
  const surfaceExcluded = !surfaceIntersectsPenumbra;

  const sceneLightFactor =
    typeof options.sceneLightFactor === "number" &&
    options.sceneLightFactor > 0.0
      ? options.sceneLightFactor
      : 1.0;
  const invSceneLightFactor =
    sceneLightFactor === 1.0 ? 1.0 : compositionReciprocal(sceneLightFactor);
  const sceneLightDimmed =
    options.sceneLightDimmed === true && sceneLightFactor !== 1.0;

  if (surfaceExcluded) {
    // A camera eclipse can dim the SunLight through S2 even when the rendered
    // globe lies outside the entire shadow footprint. Preserve that feature
    // by cancelling S2 on globe terms, but skip all local shadow geometry.
    return state.moonObscuration > 0.0 && sceneLightFactor !== 1.0
      ? setCorrectionOnlyEclipseGlobeShadow(
          shadow,
          invSceneLightFactor,
          sceneLightDimmed,
        )
      : resetEclipseGlobeShadow(shadow);
  }

  const sunRange = Cartesian3.magnitude(sunPosition);
  const moonRange = Cartesian3.magnitude(moonPosition);
  if (!(sunRange > 0.0) || !(moonRange > 0.0)) {
    return resetEclipseGlobeShadow(shadow);
  }
  Cartesian3.divideByScalar(sunPosition, sunRange, scratchSunUnit);
  Cartesian3.divideByScalar(moonPosition, moonRange, scratchMoonUnit);

  fitEclipseLimbDarkening(
    rs,
    ro,
    state.moonSeparation,
    state.moonObscuration,
    scratchFit,
  );

  const sunX = scratchSunUnit.x;
  const sunY = scratchSunUnit.y;
  const sunZ = scratchSunUnit.z;
  const invSunRange = 1.0 / sunRange;
  const moonDeltaX = scratchMoonUnit.x - scratchSunUnit.x;
  const moonDeltaY = scratchMoonUnit.y - scratchSunUnit.y;
  const moonDeltaZ = scratchMoonUnit.z - scratchSunUnit.z;
  const invMoonRange = 1.0 / moonRange;
  const gate = sceneLightDimmed ? 2.0 : 1.0;
  const exponent =
    state.autoExposure === true ? 1.0 : ECLIPSE_ADAPTATION_EXPONENT;
  const payloadChanged =
    shadow.active !== true ||
    !sameF32(shadow.sunDirectionAndInvRange.x, sunX) ||
    !sameF32(shadow.sunDirectionAndInvRange.y, sunY) ||
    !sameF32(shadow.sunDirectionAndInvRange.z, sunZ) ||
    !sameF32(shadow.sunDirectionAndInvRange.w, invSunRange) ||
    !sameF32(shadow.moonDirectionDeltaAndInvRange.x, moonDeltaX) ||
    !sameF32(shadow.moonDirectionDeltaAndInvRange.y, moonDeltaY) ||
    !sameF32(shadow.moonDirectionDeltaAndInvRange.z, moonDeltaZ) ||
    !sameF32(shadow.moonDirectionDeltaAndInvRange.w, invMoonRange) ||
    !sameF32(shadow.params.x, gate) ||
    !sameF32(shadow.params.y, invSceneLightFactor) ||
    !sameF32(shadow.params.z, scratchFit.c1) ||
    !sameF32(shadow.params.w, scratchFit.c2) ||
    !sameF32(shadow.params2.x, ECLIPSE_RADIOMETRIC_FLOOR) ||
    !sameF32(shadow.params2.y, exponent) ||
    !sameF32(shadow.params2.z, scratchFit.annularLift) ||
    !sameF32(shadow.params2.w, scratchFit.c3);

  const sunRay = shadow.sunDirectionAndInvRange;
  sunRay.x = sunX;
  sunRay.y = sunY;
  sunRay.z = sunZ;
  sunRay.w = invSunRange;

  const moonRay = shadow.moonDirectionDeltaAndInvRange;
  moonRay.x = moonDeltaX;
  moonRay.y = moonDeltaY;
  moonRay.z = moonDeltaZ;
  moonRay.w = invMoonRange;

  shadow.active = true;
  shadow.sceneLightDimmed = sceneLightDimmed;
  shadow.anchorWeight = scratchFit.anchorWeight;
  shadow.params.x = gate;
  shadow.params.y = invSceneLightFactor;
  shadow.params.z = scratchFit.c1;
  shadow.params.w = scratchFit.c2;
  shadow.params2.x = ECLIPSE_RADIOMETRIC_FLOOR;
  shadow.params2.y = exponent;
  shadow.params2.z = scratchFit.annularLift;
  shadow.params2.w = scratchFit.c3;
  if (payloadChanged) {
    syncWebGLPackedUniform(shadow);
    shadow.revision++;
  }
  return shadow;
}

/**
 * F64 reference for the exact common-ray differential the shaders consume.
 *
 * @param {object} shadow
 * @param {Cartesian3} positionWC Fragment ECEF position.
 * @returns {number} Limb-darkened obscuration in [0, 1].
 * @private
 */
function computeGlobeFragmentObscuration(
  shadow,
  positionWC,
  ellipsoid = Ellipsoid.default,
) {
  if (!defined(shadow) || !defined(positionWC) || shadow.params.x < 0.5) {
    return 0.0;
  }

  const sunRay = shadow.sunDirectionAndInvRange;
  const moonRay = shadow.moonDirectionDeltaAndInvRange;
  const invSunRange = sunRay.w;
  const invMoonRange = moonRay.w;
  if (!(invSunRange > 0.0) || !(invMoonRange > 0.0)) {
    return 0.0;
  }

  Cartesian3.multiplyByScalar(positionWC, invSunRange, scratchScaledPosition);
  Cartesian3.subtract(sunRay, scratchScaledPosition, scratchScaledSunRay);
  // Angular overlap also exists through the solid body from the antipode.
  // Use the exact ray/ellipsoid limb test shared conceptually by both globe
  // shaders. Unlike a radial or geodetic-normal sign test, this is correct for
  // oblate/custom ellipsoids and lets elevated terrain see over the horizon.
  if (
    !eclipseSunVisibleAboveEllipsoid(
      positionWC,
      scratchScaledSunRay,
      ellipsoid.oneOverRadii,
    )
  ) {
    return 0.0;
  }
  Cartesian3.multiplyByScalar(
    positionWC,
    invSunRange - invMoonRange,
    scratchScaledPosition,
  );
  Cartesian3.add(moonRay, scratchScaledPosition, scratchRayDelta);

  const sunLengthSquared = Cartesian3.magnitudeSquared(scratchScaledSunRay);
  const sunDeltaDot = Cartesian3.dot(scratchScaledSunRay, scratchRayDelta);
  const moonLengthSquared =
    sunLengthSquared +
    2.0 * sunDeltaDot +
    Cartesian3.magnitudeSquared(scratchRayDelta);
  if (!(sunLengthSquared > 0.0) || !(moonLengthSquared > 0.0)) {
    return 0.0;
  }

  const sunLength = Math.sqrt(sunLengthSquared);
  const moonLength = Math.sqrt(moonLengthSquared);
  const rs = Math.asin(
    CesiumMath.clamp(
      (CesiumMath.SOLAR_RADIUS * invSunRange) / sunLength,
      0.0,
      1.0,
    ),
  );
  const ro = Math.asin(
    CesiumMath.clamp(
      (CesiumMath.LUNAR_RADIUS * invMoonRange) / moonLength,
      0.0,
      1.0,
    ),
  );

  Cartesian3.cross(scratchScaledSunRay, scratchRayDelta, scratchCross);
  const crossMagnitude = Cartesian3.magnitude(scratchCross);
  const dotSunMoon = sunLengthSquared + sunDeltaDot;
  const separation = Math.atan2(crossMagnitude, dotSunMoon);
  return evaluateFragmentObscuration(
    rs,
    ro,
    separation,
    shadow.params.z,
    shadow.params.w,
    shadow.params2.w,
    shadow.params2.z,
  );
}

/**
 * Determine whether a fragment-to-Sun ray clears an ellipsoid.
 *
 * The position is transformed to a unit sphere with oneOverRadii. The Sun
 * vector may have any positive scale (S5 supplies `(S-P)/|S|`). An outward
 * ray is immediately visible; an inward ray is visible only when its closest
 * point stays outside the unit sphere. A 32-epsilon inward margin keeps f32
 * shader evaluation from clipping a true grazing ray.
 *
 * @param {Cartesian3} positionWC
 * @param {Cartesian3} toSun
 * @param {Cartesian3} oneOverRadii
 * @returns {boolean}
 * @private
 */
function eclipseSunVisibleAboveEllipsoid(positionWC, toSun, oneOverRadii) {
  Cartesian3.multiplyComponents(
    positionWC,
    oneOverRadii,
    scratchEllipsoidPosition,
  );
  Cartesian3.multiplyComponents(toSun, oneOverRadii, scratchEllipsoidSunRay);
  const rayLengthSquared = Cartesian3.magnitudeSquared(scratchEllipsoidSunRay);
  if (!(rayLengthSquared > 0.0)) {
    return false;
  }
  const positionDotRay = Cartesian3.dot(
    scratchEllipsoidPosition,
    scratchEllipsoidSunRay,
  );
  if (positionDotRay >= 0.0) {
    return true;
  }
  Cartesian3.cross(
    scratchEllipsoidPosition,
    scratchEllipsoidSunRay,
    scratchCross,
  );
  const closestSquared =
    Cartesian3.magnitudeSquared(scratchCross) / rayLengthSquared;
  return closestSquared >= ECLIPSE_BROAD_REJECT_SAFETY_FACTOR;
}

/**
 * Publish the active View's globe-shadow block using a rendered-geometry
 * coverage bound. Dynamic-environment capture calls this for its retained
 * sources; main terrain and pick call it after selecting their exact tile set
 * and before consuming the block in commands.
 *
 * @param {object} frameState
 * @param {number|undefined} surfaceRadius
 * @param {ArrayLike<object>} [selectedTiles]
 * @param {number} [selectionRevision]
 * @returns {object|undefined}
 * @private
 */
function updateEclipseGlobeShadowForFrameState(
  frameState,
  surfaceRadius,
  selectedTiles,
  selectionRevision,
) {
  if (!defined(frameState)) {
    return undefined;
  }
  const shadow = frameState?.view?._eclipseGlobeShadow;
  if (!defined(shadow)) {
    frameState.eclipseGlobeShadow = undefined;
    return undefined;
  }
  const hasSelectedTerrain = defined(selectedTiles);
  const sameSelectedTerrain =
    !hasSelectedTerrain ||
    (defined(selectionRevision) &&
      Object.is(
        frameState.eclipseGlobeShadowSelectionRevision,
        selectionRevision,
      ));
  if (
    frameState.eclipseGlobeShadowPrepared === true &&
    Object.is(frameState.eclipseGlobeShadowSurfaceRadius, surfaceRadius) &&
    sameSelectedTerrain
  ) {
    return frameState.eclipseGlobeShadow;
  }
  const eclipseLighting = frameState.atmosphericConditions?.lighting;
  scratchFrameGlobeOptions.eclipseState = frameState.eclipseState;
  scratchFrameGlobeOptions.sceneLightFactor =
    frameState.eclipseSceneLightFactor ?? 1.0;
  scratchFrameGlobeOptions.active =
    frameState.mode === SceneMode.SCENE3D &&
    eclipseLighting?.enableEclipse !== false &&
    eclipseLighting?.enableEclipseGlobeShadow !== false;
  scratchFrameGlobeOptions.surfaceRadius = surfaceRadius;
  scratchFrameGlobeOptions.surfaceIntersectsPenumbra = undefined;
  const state = frameState.eclipseState;
  const validSurfaceRadius =
    typeof surfaceRadius === "number" &&
    Number.isFinite(surfaceRadius) &&
    surfaceRadius > 0.0;
  if (
    hasSelectedTerrain &&
    validSurfaceRadius &&
    scratchFrameGlobeOptions.active &&
    state?.enabled === true &&
    state.valid === true &&
    isFiniteCartesian3(state.sunPositionWC) &&
    isFiniteCartesian3(state.moonPositionWC)
  ) {
    // Ordinary frames stop at this O(1) planet-wide gate. Only a globally
    // possible penumbra pays the selected-mesh scan and cone tests.
    const globallyPossible = surfaceEclipsePossible(
      state.sunPositionWC,
      state.moonPositionWC,
      surfaceRadius,
    );
    scratchFrameGlobeOptions.surfaceIntersectsPenumbra =
      globallyPossible &&
      selectedTerrainIntersectsPenumbra(
        state,
        selectedTiles,
        frameState.verticalExaggeration ?? 1.0,
        frameState.verticalExaggerationRelativeHeight ?? 0.0,
      );
  }
  scratchFrameGlobeOptions.sceneLightDimmed =
    !defined(frameState.light) || frameState.light instanceof SunLight;
  frameState.eclipseGlobeShadow = updateEclipseGlobeShadow(
    shadow,
    scratchFrameGlobeOptions,
  );
  frameState.eclipseGlobeShadowSurfaceRadius = surfaceRadius;
  frameState.eclipseGlobeShadowSelectionRevision = hasSelectedTerrain
    ? selectionRevision
    : undefined;
  frameState.eclipseGlobeShadowPrepared = true;
  return frameState.eclipseGlobeShadow;
}

export {
  FIT_ANCHOR_LO,
  FIT_ANCHOR_HI,
  FIT_ANCHOR_FADE,
  FIT_SAMPLE_COUNT,
  angleBetweenUnitVectors,
  createEclipseGlobeShadow,
  updateEclipseGlobeShadow,
  resetEclipseGlobeShadow,
  computeGlobeFragmentObscuration,
  evaluateFragmentObscuration,
  applyLimbDarkeningFit,
  fitEclipseLimbDarkening,
  composeGlobeSurfaceFactor,
  compositionReciprocal,
  surfaceEclipsePossible,
  maximumSurfaceDiscSupport,
  ECLIPSE_BROAD_REJECT_SAFETY_FACTOR,
  PENUMBRA_CONE_SAFETY_METERS,
  TERRAIN_ECLIPSE_BOUND_SAFETY_METERS,
  TERRAIN_ECLIPSE_BOUND_RELATIVE_SAFETY,
  eclipsePenumbraIntersectsBoundingSphere,
  computeRenderedMeshEclipseBoundingSphere,
  selectedTerrainIntersectsPenumbra,
  eclipseSunVisibleAboveEllipsoid,
  updateEclipseGlobeShadowForFrameState,
};
export default updateEclipseGlobeShadow;
