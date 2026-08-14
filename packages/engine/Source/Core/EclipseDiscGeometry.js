import Cartesian3 from "./Cartesian3.js";
import Check from "./Check.js";
import DeveloperError from "./DeveloperError.js";
import CesiumMath from "./Math.js";

/**
 * The geometric phase of an apparent solar eclipse. Atmospheric refraction,
 * terrain occlusion, the lunar limb profile, and diffraction are deliberately
 * outside this classification.
 *
 * Internal and external tangencies are not classified as central eclipses.
 * This keeps total and annular classifications strict and gives contact
 * solvers an unambiguous signed-gap zero.
 *
 * @enum {string}
 * @private
 */
const EclipseDiscPhase = Object.freeze({
  NONE: "NONE",
  PARTIAL: "PARTIAL",
  TOTAL: "TOTAL",
  ANNULAR: "ANNULAR",
});

function isFiniteCartesian3(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function clearDirection(direction) {
  direction.x = 0.0;
  direction.y = 0.0;
  direction.z = 0.0;
}

/**
 * Creates caller-owned storage for {@link computeEclipseDiscGeometry}.
 * Repeated computations preserve this object and both direction identities.
 *
 * @returns {object} New eclipse-disc geometry storage.
 * @private
 */
function createEclipseDiscGeometry() {
  return {
    valid: false,
    phase: EclipseDiscPhase.NONE,
    moonInFront: false,
    sunDirectionWC: new Cartesian3(),
    moonDirectionWC: new Cartesian3(),
    sunDistance: Number.NaN,
    moonDistance: Number.NaN,
    solarRadius: CesiumMath.SOLAR_RADIUS,
    lunarRadius: CesiumMath.LUNAR_RADIUS,
    solarAngularRadius: Number.NaN,
    lunarAngularRadius: Number.NaN,
    separation: Number.NaN,
    externalGap: Number.NaN,
    totalGap: Number.NaN,
    annularGap: Number.NaN,
    rawMagnitude: Number.NaN,
    magnitude: 0.0,
    obscuration: 0.0,
  };
}

/**
 * Clears an eclipse-disc geometry while preserving its object and vector
 * identities.
 *
 * @param {object} result The geometry to clear.
 * @returns {object} The unchanged result object.
 * @private
 */
function clearEclipseDiscGeometry(result) {
  Check.defined("result", result);
  Check.defined("result.sunDirectionWC", result.sunDirectionWC);
  Check.defined("result.moonDirectionWC", result.moonDirectionWC);

  result.phase = EclipseDiscPhase.NONE;
  result.valid = false;
  result.moonInFront = false;
  clearDirection(result.sunDirectionWC);
  clearDirection(result.moonDirectionWC);
  result.sunDistance = Number.NaN;
  result.moonDistance = Number.NaN;
  result.solarRadius = CesiumMath.SOLAR_RADIUS;
  result.lunarRadius = CesiumMath.LUNAR_RADIUS;
  result.solarAngularRadius = Number.NaN;
  result.lunarAngularRadius = Number.NaN;
  result.separation = Number.NaN;
  result.externalGap = Number.NaN;
  result.totalGap = Number.NaN;
  result.annularGap = Number.NaN;
  result.rawMagnitude = Number.NaN;
  result.magnitude = 0.0;
  result.obscuration = 0.0;
  return result;
}

function computeLensObscuration(
  separation,
  solarAngularRadius,
  lunarAngularRadius,
) {
  const radiusSum = solarAngularRadius + lunarAngularRadius;
  if (separation >= radiusSum) {
    return 0.0;
  }

  const radiusDifference = Math.abs(solarAngularRadius - lunarAngularRadius);
  if (separation <= radiusDifference) {
    if (lunarAngularRadius >= solarAngularRadius) {
      return 1.0;
    }
    const radiusRatio = lunarAngularRadius / solarAngularRadius;
    return radiusRatio * radiusRatio;
  }

  const solarSquared = solarAngularRadius * solarAngularRadius;
  const lunarSquared = lunarAngularRadius * lunarAngularRadius;
  const separationSquared = separation * separation;
  const solarAngle = Math.acos(
    clamp(
      (separationSquared + solarSquared - lunarSquared) /
        (2.0 * separation * solarAngularRadius),
      -1.0,
      1.0,
    ),
  );
  const lunarAngle = Math.acos(
    clamp(
      (separationSquared + lunarSquared - solarSquared) /
        (2.0 * separation * lunarAngularRadius),
      -1.0,
      1.0,
    ),
  );
  const radicand =
    (-separation + radiusSum) *
    (separation + solarAngularRadius - lunarAngularRadius) *
    (separation - solarAngularRadius + lunarAngularRadius) *
    (separation + radiusSum);
  const lensArea =
    solarSquared * solarAngle +
    lunarSquared * lunarAngle -
    0.5 * Math.sqrt(Math.max(0.0, radicand));

  return clamp(lensArea / (Math.PI * solarSquared), 0.0, 1.0);
}

/**
 * Computes apparent Sun/Moon disc geometry at an observer.
 *
 * Input positions are Earth-centred, Earth-fixed metres. The observer is
 * subtracted before distances and directions are computed. Angular separation
 * uses `atan2(|u x v|, u dot v)`, which remains well conditioned close to
 * conjunction. The radii are exactly {@link CesiumMath.SOLAR_RADIUS} and
 * {@link CesiumMath.LUNAR_RADIUS}; this function applies no per-event or hidden
 * angular-radius correction.
 *
 * @param {object} sample A synchronous celestial ephemeris sample.
 * @param {Cartesian3} observerPositionWC Observer position in ECEF metres.
 * @param {object} result Caller-owned result from {@link createEclipseDiscGeometry}.
 * @returns {object} The unchanged result object.
 * @private
 */
function computeEclipseDiscGeometry(sample, observerPositionWC, result) {
  Check.defined("sample", sample);
  Check.defined("sample.sunPositionWC", sample.sunPositionWC);
  Check.defined("sample.moonPositionWC", sample.moonPositionWC);
  Check.defined("observerPositionWC", observerPositionWC);
  Check.defined("result", result);
  Check.defined("result.sunDirectionWC", result.sunDirectionWC);
  Check.defined("result.moonDirectionWC", result.moonDirectionWC);

  if (result.sunDirectionWC === result.moonDirectionWC) {
    throw new DeveloperError(
      "result.sunDirectionWC and result.moonDirectionWC must be distinct objects.",
    );
  }
  result.valid = false;
  if (
    !isFiniteCartesian3(sample.sunPositionWC) ||
    !isFiniteCartesian3(sample.moonPositionWC) ||
    !isFiniteCartesian3(observerPositionWC)
  ) {
    throw new DeveloperError(
      "sample positions and observerPositionWC must have finite components.",
    );
  }

  const sunX = sample.sunPositionWC.x - observerPositionWC.x;
  const sunY = sample.sunPositionWC.y - observerPositionWC.y;
  const sunZ = sample.sunPositionWC.z - observerPositionWC.z;
  const moonX = sample.moonPositionWC.x - observerPositionWC.x;
  const moonY = sample.moonPositionWC.y - observerPositionWC.y;
  const moonZ = sample.moonPositionWC.z - observerPositionWC.z;
  const sunDistance = Math.hypot(sunX, sunY, sunZ);
  const moonDistance = Math.hypot(moonX, moonY, moonZ);
  const solarRadius = CesiumMath.SOLAR_RADIUS;
  const lunarRadius = CesiumMath.LUNAR_RADIUS;

  if (sunDistance <= solarRadius || moonDistance <= lunarRadius) {
    throw new DeveloperError(
      "The observer must be outside both apparent-body spheres.",
    );
  }

  const inverseSunDistance = 1.0 / sunDistance;
  const inverseMoonDistance = 1.0 / moonDistance;
  const sunDirection = result.sunDirectionWC;
  const moonDirection = result.moonDirectionWC;
  sunDirection.x = sunX * inverseSunDistance;
  sunDirection.y = sunY * inverseSunDistance;
  sunDirection.z = sunZ * inverseSunDistance;
  moonDirection.x = moonX * inverseMoonDistance;
  moonDirection.y = moonY * inverseMoonDistance;
  moonDirection.z = moonZ * inverseMoonDistance;

  const crossX =
    sunDirection.y * moonDirection.z - sunDirection.z * moonDirection.y;
  const crossY =
    sunDirection.z * moonDirection.x - sunDirection.x * moonDirection.z;
  const crossZ =
    sunDirection.x * moonDirection.y - sunDirection.y * moonDirection.x;
  const crossMagnitude = Math.hypot(crossX, crossY, crossZ);
  const dot = clamp(Cartesian3.dot(sunDirection, moonDirection), -1.0, 1.0);
  const separation = Math.atan2(crossMagnitude, dot);
  const solarAngularRadius = Math.asin(solarRadius / sunDistance);
  const lunarAngularRadius = Math.asin(lunarRadius / moonDistance);
  const externalGap = separation - (solarAngularRadius + lunarAngularRadius);
  const totalGap = separation + solarAngularRadius - lunarAngularRadius;
  const annularGap = separation + lunarAngularRadius - solarAngularRadius;
  const rawMagnitude =
    (solarAngularRadius + lunarAngularRadius - separation) /
    (2.0 * solarAngularRadius);
  const moonInFront = moonDistance < sunDistance;

  let phase = EclipseDiscPhase.NONE;
  if (moonInFront && externalGap < 0.0) {
    if (totalGap < 0.0) {
      phase = EclipseDiscPhase.TOTAL;
    } else if (annularGap < 0.0) {
      phase = EclipseDiscPhase.ANNULAR;
    } else {
      phase = EclipseDiscPhase.PARTIAL;
    }
  }

  result.valid = true;
  result.phase = phase;
  result.moonInFront = moonInFront;
  result.sunDistance = sunDistance;
  result.moonDistance = moonDistance;
  result.solarRadius = solarRadius;
  result.lunarRadius = lunarRadius;
  result.solarAngularRadius = solarAngularRadius;
  result.lunarAngularRadius = lunarAngularRadius;
  result.separation = separation;
  result.externalGap = externalGap;
  result.totalGap = totalGap;
  result.annularGap = annularGap;
  result.rawMagnitude = rawMagnitude;
  result.magnitude = Math.max(0.0, rawMagnitude);
  result.obscuration = moonInFront
    ? computeLensObscuration(separation, solarAngularRadius, lunarAngularRadius)
    : 0.0;
  return result;
}

export {
  clearEclipseDiscGeometry,
  createEclipseDiscGeometry,
  EclipseDiscPhase,
};
export default computeEclipseDiscGeometry;
