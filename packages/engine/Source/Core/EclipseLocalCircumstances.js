import Cartesian3 from "./Cartesian3.js";
import CelestialEphemerisProvider from "./CelestialEphemerisProvider.js";
import Check from "./Check.js";
import defined from "./defined.js";
import DeveloperError from "./DeveloperError.js";
import {
  clearEclipseDiscGeometry,
  createEclipseDiscGeometry,
  EclipseDiscPhase,
  default as computeEclipseDiscGeometry,
} from "./EclipseDiscGeometry.js";
import Ellipsoid from "./Ellipsoid.js";
import JulianDate from "./JulianDate.js";
import CesiumMath from "./Math.js";
import RuntimeError from "./RuntimeError.js";

const DEFAULT_TOLERANCE_SECONDS = 0.05;
const MAXIMUM_BRACKET_SECONDS = 36.0 * 60.0 * 60.0;
const MAXIMUM_ROOT_ITERATIONS = 64;
const MAXIMUM_SEARCH_ITERATIONS = 64;
const GOLDEN_RATIO_CONJUGATE = (Math.sqrt(5.0) - 1.0) * 0.5;
// A fixed terrestrial observer cannot see the physical Sun/Moon contact gap
// change anywhere near this quickly. This deliberately generous ceiling makes
// the 0.05 s tolerance imply a finite residual while rejecting discontinuous
// ephemerides that merely change sign across a bisection interval.
const MAXIMUM_CONTACT_GAP_RATE = 0.001;

const GAP_EXTERNAL = 0;
const GAP_TOTAL = 1;
const GAP_ANNULAR = 2;

function isFiniteCartesian3(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

function isFiniteJulianDate(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isFinite(value.dayNumber) &&
    Number.isFinite(value.secondsOfDay)
  );
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function haveSameSign(left, right) {
  return left < 0.0 === right < 0.0;
}

function createEvent(label) {
  const event = createEclipseDiscGeometry();
  event.label = label;
  event.valid = false;
  event.time = new JulianDate();
  // These are geometric elevations above the ellipsoid tangent plane. They do
  // not claim terrain visibility or include atmospheric refraction. The upper
  // limb value is the maximum elevation of any solar-disc point and is bounded
  // at the zenith.
  event.sunCenterElevation = Number.NaN;
  event.sunUpperLimbElevation = Number.NaN;
  event.transformBranch = undefined;
  return event;
}

function clearEvent(event) {
  clearEclipseDiscGeometry(event);
  event.valid = false;
  event.time.dayNumber = 0;
  event.time.secondsOfDay = 0.0;
  event.sunCenterElevation = Number.NaN;
  event.sunUpperLimbElevation = Number.NaN;
  event.transformBranch = undefined;
}

function copyGeometry(source, destination) {
  destination.phase = source.phase;
  destination.moonInFront = source.moonInFront;
  Cartesian3.clone(source.sunDirectionWC, destination.sunDirectionWC);
  Cartesian3.clone(source.moonDirectionWC, destination.moonDirectionWC);
  destination.sunDistance = source.sunDistance;
  destination.moonDistance = source.moonDistance;
  destination.solarRadius = source.solarRadius;
  destination.lunarRadius = source.lunarRadius;
  destination.solarAngularRadius = source.solarAngularRadius;
  destination.lunarAngularRadius = source.lunarAngularRadius;
  destination.separation = source.separation;
  destination.externalGap = source.externalGap;
  destination.totalGap = source.totalGap;
  destination.annularGap = source.annularGap;
  destination.rawMagnitude = source.rawMagnitude;
  destination.magnitude = source.magnitude;
  destination.obscuration = source.obscuration;
}

function validateEvent(label, event) {
  Check.defined(label, event);
  Check.defined("event.time", event.time);
  Check.defined("event.sunDirectionWC", event.sunDirectionWC);
  Check.defined("event.moonDirectionWC", event.moonDirectionWC);
  if (event.sunDirectionWC === event.moonDirectionWC) {
    throw new DeveloperError(
      `${label}.sunDirectionWC and ${label}.moonDirectionWC must be distinct objects.`,
    );
  }
}

function getResultEvent(result, index) {
  if (index === 0) {
    return result.firstContact;
  }
  if (index === 1) {
    return result.secondContact;
  }
  if (index === 2) {
    return result.maximum;
  }
  if (index === 3) {
    return result.thirdContact;
  }
  return result.fourthContact;
}

function getResultTime(result, index) {
  if (index === 0) {
    return result.startTime;
  }
  if (index === 1) {
    return result.stopTime;
  }
  return getResultEvent(result, index - 2).time;
}

function getResultVector(result, index) {
  if (index === 0) {
    return result.observerPositionWC;
  }
  if (index === 1) {
    return result.observerNormalWC;
  }
  if (index === 2) {
    return result.ellipsoidRadii;
  }
  const eventIndex = Math.floor((index - 3) * 0.5);
  const event = getResultEvent(result, eventIndex);
  return (index - 3) % 2 === 0 ? event.sunDirectionWC : event.moonDirectionWC;
}

function validateDistinctResultStorage(result) {
  let left;
  let right;
  for (left = 0; left < 5; ++left) {
    for (right = left + 1; right < 5; ++right) {
      if (getResultEvent(result, left) === getResultEvent(result, right)) {
        throw new DeveloperError("result event objects must be distinct.");
      }
    }
  }
  for (left = 0; left < 7; ++left) {
    for (right = left + 1; right < 7; ++right) {
      if (getResultTime(result, left) === getResultTime(result, right)) {
        throw new DeveloperError("result JulianDate objects must be distinct.");
      }
    }
  }
  for (left = 0; left < 13; ++left) {
    for (right = left + 1; right < 13; ++right) {
      if (getResultVector(result, left) === getResultVector(result, right)) {
        throw new DeveloperError("result Cartesian objects must be distinct.");
      }
    }
  }
}

function validateResult(result) {
  Check.defined("result", result);
  Check.defined("result.observerPositionWC", result.observerPositionWC);
  Check.defined("result.observerNormalWC", result.observerNormalWC);
  Check.defined("result.ellipsoidRadii", result.ellipsoidRadii);
  Check.defined("result.startTime", result.startTime);
  Check.defined("result.stopTime", result.stopTime);
  validateEvent("result.firstContact", result.firstContact);
  validateEvent("result.secondContact", result.secondContact);
  validateEvent("result.maximum", result.maximum);
  validateEvent("result.thirdContact", result.thirdContact);
  validateEvent("result.fourthContact", result.fourthContact);

  if (
    result.observerPositionWC === result.observerNormalWC ||
    result.observerPositionWC === result.ellipsoidRadii ||
    result.observerNormalWC === result.ellipsoidRadii
  ) {
    throw new DeveloperError(
      "result observer position, normal, and ellipsoid radii must be distinct objects.",
    );
  }
  validateDistinctResultStorage(result);
}

function clearResult(result) {
  result.valid = false;
  result.hasEclipse = false;
  result.kind = EclipseDiscPhase.NONE;
  result.observerLongitude = Number.NaN;
  result.observerLatitude = Number.NaN;
  result.observerHeight = Number.NaN;
  result.observerPositionWC.x = 0.0;
  result.observerPositionWC.y = 0.0;
  result.observerPositionWC.z = 0.0;
  result.observerNormalWC.x = 0.0;
  result.observerNormalWC.y = 0.0;
  result.observerNormalWC.z = 0.0;
  result.ellipsoidRadii.x = 0.0;
  result.ellipsoidRadii.y = 0.0;
  result.ellipsoidRadii.z = 0.0;
  result.startTime.dayNumber = 0;
  result.startTime.secondsOfDay = 0.0;
  result.stopTime.dayNumber = 0;
  result.stopTime.secondsOfDay = 0.0;
  result.solarRadius = CesiumMath.SOLAR_RADIUS;
  result.lunarRadius = CesiumMath.LUNAR_RADIUS;
  result.partialDurationSeconds = 0.0;
  result.centralDurationSeconds = 0.0;
  result.providerId = undefined;
  result.providerRevision = undefined;
  result.provenance = undefined;
  result.timePolicy = undefined;
  result.transformBranch = undefined;
  result.outputAllocationStable = undefined;
  result.thirdPartyTemporaryFree = undefined;
  result.toleranceSeconds = DEFAULT_TOLERANCE_SECONDS;
  result.evaluationCount = 0;
  clearEvent(result.firstContact);
  clearEvent(result.secondContact);
  clearEvent(result.maximum);
  clearEvent(result.thirdContact);
  clearEvent(result.fourthContact);
}

function getGap(geometry, gapKind) {
  if (gapKind === GAP_EXTERNAL) {
    return geometry.externalGap;
  }
  if (gapKind === GAP_TOTAL) {
    return geometry.totalGap;
  }
  return geometry.annularGap;
}

function validateProviderDeclaration(
  id,
  revision,
  provenance,
  timePolicy,
  outputAllocationStable,
  thirdPartyTemporaryFree,
) {
  if (typeof id !== "string" || id.length === 0) {
    throw new RuntimeError("The ephemeris provider has an invalid id.");
  }
  if (!Number.isInteger(revision) || revision < 0) {
    throw new RuntimeError("The ephemeris provider has an invalid revision.");
  }
  if (
    provenance === null ||
    typeof provenance !== "object" ||
    timePolicy === null ||
    typeof timePolicy !== "object" ||
    !Object.isFrozen(provenance) ||
    !Object.isFrozen(timePolicy)
  ) {
    throw new RuntimeError(
      "The ephemeris provider must publish frozen provenance and a frozen time policy.",
    );
  }
  if (
    typeof outputAllocationStable !== "boolean" ||
    typeof thirdPartyTemporaryFree !== "boolean"
  ) {
    throw new RuntimeError(
      "The ephemeris provider must publish its allocation declarations.",
    );
  }
}

/**
 * Solves observer-local solar-eclipse circumstances from a synchronous ECEF
 * ephemeris. The caller supplies a padded bracket containing one conjunction;
 * both endpoints must be strictly outside the external contact and the bracket
 * may span no more than 36 SI hours on Cesium's internal TAI timeline.
 *
 * This solver owns the contact math. Third-party eclipse searches may be used
 * by callers to find a coarse bracket, but their contacts are never accepted as
 * local-circumstances authority here.
 *
 * The provider-independent physical contract is a fixed observer and finite,
 * continuous Sun/Moon ECEF trajectories over a single, raw-magnitude-unimodal
 * conjunction. The contact gap must vary by less than 0.001 radians per SI
 * second. Provider declarations and transform branches must remain constant.
 *
 * @alias EclipseLocalCircumstances
 * @constructor
 *
 * @param {CelestialEphemerisProvider} provider A ready, synchronous provider.
 * @private
 */
class EclipseLocalCircumstances {
  constructor(provider) {
    Check.defined("provider", provider);
    Check.typeOf.func("provider.compute", provider.compute);

    this._provider = provider;
    this._sample = CelestialEphemerisProvider.createSample();
    this._sampleIdentity = this._sample;
    this._sunPositionIdentity = this._sample.sunPositionWC;
    this._moonPositionIdentity = this._sample.moonPositionWC;
    this._geometry = createEclipseDiscGeometry();
    this._evaluationTime = new JulianDate();
    this._solveStartTime = new JulianDate();
    this._solveStopTime = new JulianDate();
    this._observerPositionWC = new Cartesian3();
    this._observerNormalWC = new Cartesian3();
    this._evaluationCount = 0;
    this._activeResult = undefined;
    this._metadataInitialized = false;
    this._providerId = undefined;
    this._providerRevision = undefined;
    this._providerProvenance = undefined;
    this._providerTimePolicy = undefined;
    this._transformBranch = undefined;
    this._outputAllocationStable = undefined;
    this._thirdPartyTemporaryFree = undefined;
    this._rootLeft = Number.NaN;
    this._rootRight = Number.NaN;
    this._rootLeftValue = Number.NaN;
    this._rootRightValue = Number.NaN;
    this._rootGapKind = undefined;
    this._solving = false;
  }

  /**
   * Creates caller-owned local-circumstances storage. Repeated calls preserve
   * the result, event, JulianDate, and Cartesian identities.
   *
   * @returns {object} New result storage.
   */
  static createResult() {
    return {
      valid: false,
      hasEclipse: false,
      kind: EclipseDiscPhase.NONE,
      observerLongitude: Number.NaN,
      observerLatitude: Number.NaN,
      observerHeight: Number.NaN,
      observerPositionWC: new Cartesian3(),
      observerNormalWC: new Cartesian3(),
      ellipsoidRadii: new Cartesian3(),
      startTime: new JulianDate(),
      stopTime: new JulianDate(),
      solarRadius: CesiumMath.SOLAR_RADIUS,
      lunarRadius: CesiumMath.LUNAR_RADIUS,
      partialDurationSeconds: 0.0,
      centralDurationSeconds: 0.0,
      providerId: undefined,
      providerRevision: undefined,
      provenance: undefined,
      timePolicy: undefined,
      transformBranch: undefined,
      outputAllocationStable: undefined,
      thirdPartyTemporaryFree: undefined,
      toleranceSeconds: DEFAULT_TOLERANCE_SECONDS,
      evaluationCount: 0,
      firstContact: createEvent("C1"),
      secondContact: createEvent("C2"),
      maximum: createEvent("MAX"),
      thirdContact: createEvent("C3"),
      fourthContact: createEvent("C4"),
    };
  }

  _evaluate(offsetSeconds) {
    const provider = this._provider;
    const sample = this._sample;
    const result = this._activeResult;
    JulianDate.addSeconds(
      this._solveStartTime,
      offsetSeconds,
      this._evaluationTime,
    );
    const expectedDayNumber = this._evaluationTime.dayNumber;
    const expectedSecondsOfDay = this._evaluationTime.secondsOfDay;

    const idBefore = provider.id;
    const revisionBefore = provider.revision;
    const provenanceBefore = provider.provenance;
    const timePolicyBefore = provider.timePolicy;
    const outputAllocationStableBefore = provider.outputAllocationStable;
    const thirdPartyTemporaryFreeBefore = provider.thirdPartyTemporaryFree;
    validateProviderDeclaration(
      idBefore,
      revisionBefore,
      provenanceBefore,
      timePolicyBefore,
      outputAllocationStableBefore,
      thirdPartyTemporaryFreeBefore,
    );

    ++this._evaluationCount;
    result.evaluationCount = this._evaluationCount;
    const returnedSample = provider.compute(this._evaluationTime, sample);
    CelestialEphemerisProvider.validateResult(sample);

    if (
      returnedSample !== this._sampleIdentity ||
      this._sample !== this._sampleIdentity ||
      sample.sunPositionWC !== this._sunPositionIdentity ||
      sample.moonPositionWC !== this._moonPositionIdentity
    ) {
      throw new RuntimeError(
        "The ephemeris provider replaced caller-owned sample or vector storage.",
      );
    }
    if (
      this._evaluationTime.dayNumber !== expectedDayNumber ||
      this._evaluationTime.secondsOfDay !== expectedSecondsOfDay
    ) {
      throw new RuntimeError(
        "The ephemeris provider mutated the solver-owned evaluation time.",
      );
    }
    if (
      !isFiniteCartesian3(this._sunPositionIdentity) ||
      !isFiniteCartesian3(this._moonPositionIdentity)
    ) {
      throw new RuntimeError(
        "The ephemeris provider produced a non-finite position.",
      );
    }

    const idAfter = provider.id;
    const revisionAfter = provider.revision;
    const provenanceAfter = provider.provenance;
    const timePolicyAfter = provider.timePolicy;
    const outputAllocationStableAfter = provider.outputAllocationStable;
    const thirdPartyTemporaryFreeAfter = provider.thirdPartyTemporaryFree;
    validateProviderDeclaration(
      idAfter,
      revisionAfter,
      provenanceAfter,
      timePolicyAfter,
      outputAllocationStableAfter,
      thirdPartyTemporaryFreeAfter,
    );
    if (
      idAfter !== idBefore ||
      provenanceAfter !== provenanceBefore ||
      timePolicyAfter !== timePolicyBefore ||
      outputAllocationStableAfter !== outputAllocationStableBefore ||
      thirdPartyTemporaryFreeAfter !== thirdPartyTemporaryFreeBefore
    ) {
      throw new RuntimeError(
        "The ephemeris provider declaration changed during an evaluation.",
      );
    }
    if (
      sample.providerId !== idBefore ||
      sample.provenance !== provenanceBefore ||
      sample.timePolicy !== timePolicyBefore ||
      sample.referenceFrame !== "ECEF" ||
      sample.units !== "metres" ||
      sample.outputAllocationStable !== outputAllocationStableBefore ||
      sample.thirdPartyTemporaryFree !== thirdPartyTemporaryFreeBefore ||
      typeof sample.transformBranch !== "string" ||
      sample.transformBranch.length === 0
    ) {
      throw new RuntimeError(
        "The ephemeris sample does not truthfully match its provider declaration.",
      );
    }

    if (!this._metadataInitialized) {
      if (sample.providerRevision !== revisionAfter) {
        throw new RuntimeError(
          "The first ephemeris sample does not match its post-compute provider revision.",
        );
      }
      this._metadataInitialized = true;
      this._providerId = idBefore;
      this._providerRevision = revisionAfter;
      this._providerProvenance = provenanceBefore;
      this._providerTimePolicy = timePolicyBefore;
      this._transformBranch = sample.transformBranch;
      this._outputAllocationStable = outputAllocationStableBefore;
      this._thirdPartyTemporaryFree = thirdPartyTemporaryFreeBefore;
    } else if (
      idBefore !== this._providerId ||
      revisionBefore !== this._providerRevision ||
      revisionAfter !== this._providerRevision ||
      sample.providerRevision !== this._providerRevision ||
      provenanceBefore !== this._providerProvenance ||
      timePolicyBefore !== this._providerTimePolicy ||
      sample.transformBranch !== this._transformBranch ||
      outputAllocationStableBefore !== this._outputAllocationStable ||
      thirdPartyTemporaryFreeBefore !== this._thirdPartyTemporaryFree
    ) {
      throw new RuntimeError(
        "The ephemeris provider provenance, revision, or transform branch drifted during the solve.",
      );
    }

    return computeEclipseDiscGeometry(
      sample,
      this._observerPositionWC,
      this._geometry,
    );
  }

  _storeEvent(offsetSeconds, event) {
    const geometry = this._evaluate(offsetSeconds);
    copyGeometry(geometry, event);
    JulianDate.clone(this._evaluationTime, event.time);
    const normalDotSun = clamp(
      Cartesian3.dot(this._observerNormalWC, geometry.sunDirectionWC),
      -1.0,
      1.0,
    );
    event.sunCenterElevation = Math.asin(normalDotSun);
    event.sunUpperLimbElevation = Math.min(
      CesiumMath.PI_OVER_TWO,
      event.sunCenterElevation + geometry.solarAngularRadius,
    );
    event.transformBranch = this._transformBranch;
    event.valid = true;
    return event;
  }

  _bisect(left, right, leftValue, rightValue, gapKind) {
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      throw new RuntimeError("A contact bracket contains a non-finite gap.");
    }
    if (leftValue === 0.0) {
      this._setRootBracket(left, left, 0.0, 0.0, gapKind);
      return left;
    }
    if (rightValue === 0.0) {
      this._setRootBracket(right, right, 0.0, 0.0, gapKind);
      return right;
    }
    if (haveSameSign(leftValue, rightValue)) {
      throw new RuntimeError("A contact root is not bracketed.");
    }

    let iteration = 0;
    while (
      right - left > DEFAULT_TOLERANCE_SECONDS &&
      iteration < MAXIMUM_ROOT_ITERATIONS
    ) {
      const middle = 0.5 * (left + right);
      const middleValue = getGap(this._evaluate(middle), gapKind);
      if (middleValue === 0.0) {
        this._setRootBracket(middle, middle, 0.0, 0.0, gapKind);
        return middle;
      }
      if (haveSameSign(middleValue, leftValue)) {
        left = middle;
        leftValue = middleValue;
      } else {
        right = middle;
        rightValue = middleValue;
      }
      ++iteration;
    }
    if (right - left > DEFAULT_TOLERANCE_SECONDS) {
      throw new RuntimeError(
        "A contact root did not converge within the iteration bound.",
      );
    }
    this._setRootBracket(left, right, leftValue, rightValue, gapKind);
    return 0.5 * (left + right);
  }

  _setRootBracket(left, right, leftValue, rightValue, gapKind) {
    this._rootLeft = left;
    this._rootRight = right;
    this._rootLeftValue = leftValue;
    this._rootRightValue = rightValue;
    this._rootGapKind = gapKind;
  }

  _storeContact(offsetSeconds, event, gapKind) {
    this._storeEvent(offsetSeconds, event);
    const bracketWidth = this._rootRight - this._rootLeft;
    const leftValue = this._rootLeftValue;
    const rightValue = this._rootRightValue;
    const residual = Math.abs(getGap(event, gapKind));
    const maximumResidual =
      MAXIMUM_CONTACT_GAP_RATE * DEFAULT_TOLERANCE_SECONDS +
      CesiumMath.EPSILON14;
    if (
      this._rootGapKind !== gapKind ||
      !Number.isFinite(bracketWidth) ||
      bracketWidth < 0.0 ||
      bracketWidth > DEFAULT_TOLERANCE_SECONDS ||
      offsetSeconds < this._rootLeft ||
      offsetSeconds > this._rootRight ||
      !Number.isFinite(leftValue) ||
      !Number.isFinite(rightValue) ||
      (leftValue !== 0.0 &&
        rightValue !== 0.0 &&
        haveSameSign(leftValue, rightValue)) ||
      !Number.isFinite(residual) ||
      residual > maximumResidual
    ) {
      throw new RuntimeError(
        "A contact root failed its final sign-bracket or angular-residual audit.",
      );
    }
    return event;
  }

  _findMaximum(durationSeconds) {
    let left = 0.0;
    let right = durationSeconds;
    let innerLeft = right - GOLDEN_RATIO_CONJUGATE * (right - left);
    let innerRight = left + GOLDEN_RATIO_CONJUGATE * (right - left);
    let leftMagnitude = this._evaluate(innerLeft).rawMagnitude;
    let rightMagnitude = this._evaluate(innerRight).rawMagnitude;
    let iteration = 0;

    while (
      right - left > DEFAULT_TOLERANCE_SECONDS &&
      iteration < MAXIMUM_SEARCH_ITERATIONS
    ) {
      if (leftMagnitude < rightMagnitude) {
        left = innerLeft;
        innerLeft = innerRight;
        leftMagnitude = rightMagnitude;
        innerRight = left + GOLDEN_RATIO_CONJUGATE * (right - left);
        rightMagnitude = this._evaluate(innerRight).rawMagnitude;
      } else {
        right = innerRight;
        innerRight = innerLeft;
        rightMagnitude = leftMagnitude;
        innerLeft = right - GOLDEN_RATIO_CONJUGATE * (right - left);
        leftMagnitude = this._evaluate(innerLeft).rawMagnitude;
      }
      ++iteration;
    }
    if (right - left > DEFAULT_TOLERANCE_SECONDS) {
      throw new RuntimeError(
        "The conjunction maximum did not converge within the iteration bound.",
      );
    }
    return 0.5 * (left + right);
  }

  _validatePublishedResult(
    result,
    firstOffset,
    secondOffset,
    maximumOffset,
    thirdOffset,
    fourthOffset,
  ) {
    const maximum = result.maximum;
    let valid =
      maximum.valid &&
      Number.isFinite(maximumOffset) &&
      Math.abs(
        JulianDate.secondsDifference(maximum.time, result.startTime) -
          maximumOffset,
      ) <= CesiumMath.EPSILON9;

    if (result.hasEclipse) {
      const first = result.firstContact;
      const fourth = result.fourthContact;
      const partialDuration = fourthOffset - firstOffset;
      valid =
        valid &&
        first.valid &&
        fourth.valid &&
        firstOffset < maximumOffset &&
        maximumOffset < fourthOffset &&
        JulianDate.compare(first.time, maximum.time) < 0 &&
        JulianDate.compare(maximum.time, fourth.time) < 0 &&
        Number.isFinite(partialDuration) &&
        partialDuration > 0.0 &&
        result.partialDurationSeconds === partialDuration &&
        Math.abs(
          JulianDate.secondsDifference(first.time, result.startTime) -
            firstOffset,
        ) <= CesiumMath.EPSILON9 &&
        Math.abs(
          JulianDate.secondsDifference(fourth.time, result.startTime) -
            fourthOffset,
        ) <= CesiumMath.EPSILON9;

      const central =
        result.kind === EclipseDiscPhase.TOTAL ||
        result.kind === EclipseDiscPhase.ANNULAR;
      if (central) {
        const second = result.secondContact;
        const third = result.thirdContact;
        const centralDuration = thirdOffset - secondOffset;
        valid =
          valid &&
          second.valid &&
          third.valid &&
          firstOffset < secondOffset &&
          secondOffset < maximumOffset &&
          maximumOffset < thirdOffset &&
          thirdOffset < fourthOffset &&
          JulianDate.compare(first.time, second.time) < 0 &&
          JulianDate.compare(second.time, maximum.time) < 0 &&
          JulianDate.compare(maximum.time, third.time) < 0 &&
          JulianDate.compare(third.time, fourth.time) < 0 &&
          Number.isFinite(centralDuration) &&
          centralDuration > 0.0 &&
          result.centralDurationSeconds === centralDuration &&
          Math.abs(
            JulianDate.secondsDifference(second.time, result.startTime) -
              secondOffset,
          ) <= CesiumMath.EPSILON9 &&
          Math.abs(
            JulianDate.secondsDifference(third.time, result.startTime) -
              thirdOffset,
          ) <= CesiumMath.EPSILON9;
      } else {
        valid =
          valid &&
          !result.secondContact.valid &&
          !result.thirdContact.valid &&
          result.centralDurationSeconds === 0.0;
      }
    } else {
      valid =
        valid &&
        result.kind === EclipseDiscPhase.NONE &&
        !result.firstContact.valid &&
        !result.secondContact.valid &&
        !result.thirdContact.valid &&
        !result.fourthContact.valid &&
        result.partialDurationSeconds === 0.0 &&
        result.centralDurationSeconds === 0.0;
    }

    if (!valid || result.kind !== maximum.phase) {
      throw new RuntimeError(
        "The solved contacts failed their ordering, duration, or time-offset audit.",
      );
    }
  }

  /**
   * Computes local circumstances in caller-owned storage.
   *
   * @param {object} options Solve inputs.
   * @param {Cartographic} options.observer Observer longitude/latitude in radians and finite ellipsoid height in metres.
   * @param {Ellipsoid} [options.ellipsoid=Ellipsoid.default] Observer ellipsoid.
   * @param {JulianDate} options.startTime Strictly outside first external contact.
   * @param {JulianDate} options.stopTime Strictly outside fourth external contact.
   * @param {object} result Caller-owned result from {@link EclipseLocalCircumstances.createResult}.
   * @returns {object} The unchanged result object.
   */
  compute(options, result) {
    if (this._solving) {
      throw new DeveloperError(
        "EclipseLocalCircumstances.compute cannot be called reentrantly.",
      );
    }
    validateResult(result);

    let succeeded = false;
    this._evaluationCount = 0;
    this._activeResult = result;
    this._metadataInitialized = false;
    this._providerId = undefined;
    this._providerRevision = undefined;
    this._providerProvenance = undefined;
    this._providerTimePolicy = undefined;
    this._transformBranch = undefined;
    this._outputAllocationStable = undefined;
    this._thirdPartyTemporaryFree = undefined;
    this._solving = true;

    try {
      Check.defined("options", options);
      Check.defined("options.observer", options.observer);
      Check.defined("options.startTime", options.startTime);
      Check.defined("options.stopTime", options.stopTime);
      JulianDate.clone(options.startTime, this._solveStartTime);
      JulianDate.clone(options.stopTime, this._solveStopTime);
      clearResult(result);

      const observer = options.observer;
      const ellipsoid = defined(options.ellipsoid)
        ? options.ellipsoid
        : Ellipsoid.default;
      const startTime = this._solveStartTime;
      const stopTime = this._solveStopTime;
      if (
        !Number.isFinite(observer.longitude) ||
        !Number.isFinite(observer.latitude) ||
        !Number.isFinite(observer.height)
      ) {
        throw new DeveloperError(
          "options.observer longitude, latitude, and height must be finite.",
        );
      }
      if (
        observer.latitude < -CesiumMath.PI_OVER_TWO ||
        observer.latitude > CesiumMath.PI_OVER_TWO
      ) {
        throw new DeveloperError(
          "options.observer latitude must be between -pi/2 and pi/2.",
        );
      }
      Check.defined("ellipsoid", ellipsoid);
      Check.defined("ellipsoid.radii", ellipsoid.radii);
      if (
        !isFiniteCartesian3(ellipsoid.radii) ||
        ellipsoid.radii.x <= 0.0 ||
        ellipsoid.radii.y <= 0.0 ||
        ellipsoid.radii.z <= 0.0
      ) {
        throw new DeveloperError(
          "options.ellipsoid must have finite, positive radii.",
        );
      }
      if (!isFiniteJulianDate(startTime) || !isFiniteJulianDate(stopTime)) {
        throw new DeveloperError(
          "options.startTime and options.stopTime must be finite JulianDates.",
        );
      }

      const durationSeconds = JulianDate.secondsDifference(stopTime, startTime);
      if (
        durationSeconds <= 2.0 * DEFAULT_TOLERANCE_SECONDS ||
        durationSeconds > MAXIMUM_BRACKET_SECONDS
      ) {
        throw new DeveloperError(
          "The solve bracket must be positive, padded, and no longer than 36 hours.",
        );
      }

      ellipsoid.cartographicToCartesian(observer, this._observerPositionWC);
      ellipsoid.geodeticSurfaceNormalCartographic(
        observer,
        this._observerNormalWC,
      );
      if (
        !isFiniteCartesian3(this._observerPositionWC) ||
        !isFiniteCartesian3(this._observerNormalWC)
      ) {
        throw new DeveloperError(
          "The observer could not be converted on the supplied ellipsoid.",
        );
      }

      JulianDate.clone(startTime, result.startTime);
      JulianDate.clone(stopTime, result.stopTime);
      Cartesian3.clone(this._observerPositionWC, result.observerPositionWC);
      Cartesian3.clone(this._observerNormalWC, result.observerNormalWC);
      Cartesian3.clone(ellipsoid.radii, result.ellipsoidRadii);
      result.observerLongitude = observer.longitude;
      result.observerLatitude = observer.latitude;
      result.observerHeight = observer.height;

      const startGeometry = this._evaluate(0.0);
      const startExternalGap = startGeometry.externalGap;
      const startRawMagnitude = startGeometry.rawMagnitude;
      const stopGeometry = this._evaluate(durationSeconds);
      const stopExternalGap = stopGeometry.externalGap;
      const stopRawMagnitude = stopGeometry.rawMagnitude;
      if (startExternalGap <= 0.0 || stopExternalGap <= 0.0) {
        throw new DeveloperError(
          "Both solve-bracket endpoints must be strictly outside external contact.",
        );
      }

      const maximumOffset = this._findMaximum(durationSeconds);
      const maximum = this._storeEvent(maximumOffset, result.maximum);
      if (
        maximumOffset <= DEFAULT_TOLERANCE_SECONDS ||
        maximumOffset >= durationSeconds - DEFAULT_TOLERANCE_SECONDS ||
        maximum.rawMagnitude <= startRawMagnitude ||
        maximum.rawMagnitude <= stopRawMagnitude ||
        !maximum.moonInFront
      ) {
        throw new DeveloperError(
          "The bracket must isolate one interior solar conjunction with the Moon in front.",
        );
      }

      result.hasEclipse = maximum.externalGap < 0.0;
      result.kind = result.hasEclipse ? maximum.phase : EclipseDiscPhase.NONE;

      let firstOffset;
      let secondOffset;
      let thirdOffset;
      let fourthOffset;

      if (result.hasEclipse) {
        firstOffset = this._bisect(
          0.0,
          maximumOffset,
          startExternalGap,
          maximum.externalGap,
          GAP_EXTERNAL,
        );
        const first = this._storeContact(
          firstOffset,
          result.firstContact,
          GAP_EXTERNAL,
        );
        fourthOffset = this._bisect(
          maximumOffset,
          durationSeconds,
          maximum.externalGap,
          stopExternalGap,
          GAP_EXTERNAL,
        );
        const fourth = this._storeContact(
          fourthOffset,
          result.fourthContact,
          GAP_EXTERNAL,
        );
        result.partialDurationSeconds = fourthOffset - firstOffset;

        let centralGapKind;
        if (maximum.phase === EclipseDiscPhase.TOTAL) {
          centralGapKind = GAP_TOTAL;
        } else if (maximum.phase === EclipseDiscPhase.ANNULAR) {
          centralGapKind = GAP_ANNULAR;
        }

        if (defined(centralGapKind)) {
          const firstCentralGap = getGap(first, centralGapKind);
          const maximumCentralGap = getGap(maximum, centralGapKind);
          const fourthCentralGap = getGap(fourth, centralGapKind);
          secondOffset = this._bisect(
            firstOffset,
            maximumOffset,
            firstCentralGap,
            maximumCentralGap,
            centralGapKind,
          );
          this._storeContact(
            secondOffset,
            result.secondContact,
            centralGapKind,
          );
          thirdOffset = this._bisect(
            maximumOffset,
            fourthOffset,
            maximumCentralGap,
            fourthCentralGap,
            centralGapKind,
          );
          this._storeContact(thirdOffset, result.thirdContact, centralGapKind);
          result.centralDurationSeconds = thirdOffset - secondOffset;
        }
      }

      this._validatePublishedResult(
        result,
        firstOffset,
        secondOffset,
        maximumOffset,
        thirdOffset,
        fourthOffset,
      );

      result.solarRadius = CesiumMath.SOLAR_RADIUS;
      result.lunarRadius = CesiumMath.LUNAR_RADIUS;
      result.providerId = this._providerId;
      result.providerRevision = this._providerRevision;
      result.provenance = this._providerProvenance;
      result.timePolicy = this._providerTimePolicy;
      result.transformBranch = this._transformBranch;
      result.outputAllocationStable = this._outputAllocationStable;
      result.thirdPartyTemporaryFree = this._thirdPartyTemporaryFree;
      result.evaluationCount = this._evaluationCount;
      result.valid = true;
      succeeded = true;
      return result;
    } finally {
      try {
        if (!succeeded) {
          const evaluationCount = this._evaluationCount;
          clearResult(result);
          result.evaluationCount = evaluationCount;
        }
      } finally {
        this._activeResult = undefined;
        this._solving = false;
      }
    }
  }
}

export default EclipseLocalCircumstances;
