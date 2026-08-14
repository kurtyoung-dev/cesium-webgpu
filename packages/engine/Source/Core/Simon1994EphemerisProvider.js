import CelestialEphemerisProvider from "./CelestialEphemerisProvider.js";
import Check from "./Check.js";
import defined from "./defined.js";
import DeveloperError from "./DeveloperError.js";
import JulianDate from "./JulianDate.js";
import Matrix3 from "./Matrix3.js";
import Simon1994PlanetaryPositions from "./Simon1994PlanetaryPositions.js";
import Transforms from "./Transforms.js";

const SIMON1994_PROVIDER_ID = "cesium-simon1994-ecef";
const SIMON1994_TEME_PROVIDER_REVISION = 1;
const SIMON1994_ICRF_PROVIDER_REVISION = 2;
const ICRF_BRANCH = "SIMON1994_ICRF_TO_FIXED_IAU2006_XYS";
const TEME_BRANCH = "SIMON1994_TEME_TO_PSEUDO_FIXED_IAU1982_GMST";

const SIMON1994_TIME_POLICY = Object.freeze({
  id: "cesium-julian-date-tai/simon1994-tdb/icrf-with-teme-fallback",
  inputTimeScale: "TAI",
  ephemerisDynamicalScale: "TDB_APPROXIMATION",
  primaryEarthRotation: "IAU2006_XYS",
  fallbackEarthRotation: "IAU1982_GMST_TEME_PSEUDO_FIXED",
});

const SIMON1994_PROVENANCE = Object.freeze({
  id: "cesium-simon1994-planetary-positions/current-engine-series",
  sunAndMoonSeries: "Simon1994PlanetaryPositions",
  outputFrame: "ECEF",
  outputUnits: "metres",
  eventSpecificCorrections: false,
  angularRadiusCorrections: false,
  revisionPolicy:
    "1=TEME pseudo-fixed fallback; 2=ICRF-to-fixed IAU2006 XYS branch",
  outputAllocationStable: true,
  sampleValidationTemporaryFree: true,
  sampleValidationPolicy:
    "WeakSet brand with fixed sealed output structure; no per-call descriptor/state records",
  thirdPartyTemporaryFree: true,
});

/**
 * The lightweight built-in celestial ephemeris. It mirrors the engine's
 * current Simon-1994 inertial vectors and ICRF-to-fixed transform, including
 * the existing TEME pseudo-fixed fallback while IAU2006 XYS data is absent.
 * The exact branch is reported on every sample.
 *
 * @alias Simon1994EphemerisProvider
 * @constructor
 * @extends CelestialEphemerisProvider
 */
class Simon1994EphemerisProvider extends CelestialEphemerisProvider {
  constructor() {
    super();
    this._inertialToFixed = new Matrix3();
    this._lastSampleTime = new JulianDate();
    this._hasLastSampleTime = false;
    this._lastTransformBranch = undefined;
    this._revision = SIMON1994_TEME_PROVIDER_REVISION;
    this._computeDepth = 0;
  }

  get id() {
    return SIMON1994_PROVIDER_ID;
  }

  get revision() {
    // A same-time sample can start on the TEME fallback and later gain the
    // ICRF branch when XYS data finishes loading. Re-probe that retained time
    // from the revision getter so a time+revision cache cannot hide the
    // transition by skipping compute.
    if (
      this._computeDepth === 0 &&
      this._hasLastSampleTime &&
      this._lastTransformBranch === TEME_BRANCH &&
      defined(
        Transforms.computeIcrfToFixedMatrix(
          this._lastSampleTime,
          this._inertialToFixed,
        ),
      )
    ) {
      this._lastTransformBranch = ICRF_BRANCH;
      this._revision = SIMON1994_ICRF_PROVIDER_REVISION;
    }
    return this._revision;
  }

  get provenance() {
    return SIMON1994_PROVENANCE;
  }

  get timePolicy() {
    return SIMON1994_TIME_POLICY;
  }

  get outputAllocationStable() {
    return true;
  }

  get thirdPartyTemporaryFree() {
    return true;
  }

  compute(time, result) {
    if (this._computeDepth !== 0) {
      throw new DeveloperError(
        "Simon1994EphemerisProvider does not support reentrant compute calls.",
      );
    }
    this._computeDepth++;
    try {
      Check.defined("time", time);
      CelestialEphemerisProvider.validateResult(result);
      const sunPositionWC = result.sunPositionWC;
      const moonPositionWC = result.moonPositionWC;

      Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
        time,
        sunPositionWC,
      );
      Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
        time,
        moonPositionWC,
      );

      let transformBranch;
      let inertialToFixed = Transforms.computeIcrfToFixedMatrix(
        time,
        this._inertialToFixed,
      );
      if (defined(inertialToFixed)) {
        transformBranch = ICRF_BRANCH;
        this._revision = SIMON1994_ICRF_PROVIDER_REVISION;
      } else {
        inertialToFixed = Transforms.computeTemeToPseudoFixedMatrix(
          time,
          this._inertialToFixed,
        );
        transformBranch = TEME_BRANCH;
        this._revision = SIMON1994_TEME_PROVIDER_REVISION;
      }
      this._lastTransformBranch = transformBranch;
      JulianDate.clone(time, this._lastSampleTime);
      this._hasLastSampleTime = true;

      Matrix3.multiplyByVector(inertialToFixed, sunPositionWC, sunPositionWC);
      Matrix3.multiplyByVector(inertialToFixed, moonPositionWC, moonPositionWC);

      return CelestialEphemerisProvider.finalizeResult(
        result,
        this,
        transformBranch,
      );
    } finally {
      this._computeDepth--;
    }
  }
}

export default Simon1994EphemerisProvider;
