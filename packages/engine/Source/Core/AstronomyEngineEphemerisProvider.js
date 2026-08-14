import AstronomyEngineTimeAdapter from "./AstronomyEngineTimeAdapter.js";
import CelestialEphemerisProvider from "./CelestialEphemerisProvider.js";
import DeveloperError from "./DeveloperError.js";
import RuntimeError from "./RuntimeError.js";
import TimeConstants from "./TimeConstants.js";

const ASTRONOMICAL_UNIT_METRES = 149597870700.0;
const ASTRONOMY_ENGINE_PROVIDER_ID = "astronomy-engine-2.1.19-ecef";
const ASTRONOMY_ENGINE_PROVIDER_REVISION = 1;
const ASTRONOMY_ENGINE_TRANSFORM_BRANCH =
  "GEOVECTOR_EQJ_TO_EQD_TO_ECEF_NEGATIVE_GAST";
const constructionToken = {};

let astronomyEngineModulePromise;

function loadAstronomyEngine() {
  if (astronomyEngineModulePromise === undefined) {
    astronomyEngineModulePromise = import("astronomy-engine").catch((error) => {
      // Permit a later retry after a transient chunk/load failure. Concurrent
      // callers still share the one in-flight import promise.
      astronomyEngineModulePromise = undefined;
      throw error;
    });
  }
  return astronomyEngineModulePromise;
}

function validateAstronomyEngine(module) {
  const requiredFunctions = [
    "AstroTime",
    "DeltaT_EspenakMeeus",
    "GeoVector",
    "RotateVector",
    "Rotation_EQJ_EQD",
    "SiderealTime",
  ];
  for (const name of requiredFunctions) {
    if (typeof module[name] !== "function") {
      throw new DeveloperError(
        `astronomy-engine 2.1.19 is missing required export ${name}.`,
      );
    }
  }
  if (module.Body?.Sun === undefined || module.Body?.Moon === undefined) {
    throw new DeveloperError(
      "astronomy-engine 2.1.19 is missing Body.Sun or Body.Moon.",
    );
  }
}

function createPinnedAstroTimeClass(AstroTime, deltaTEspenakMeeus) {
  return class PinnedAstronomyEngineTime extends AstroTime {
    constructor(ut) {
      super(ut);
      const expectedTerrestrialTime =
        this.ut + deltaTEspenakMeeus(this.ut) / TimeConstants.SECONDS_PER_DAY;
      if (
        this.ut !== ut ||
        !Number.isFinite(this.tt) ||
        !Number.isFinite(expectedTerrestrialTime) ||
        this.tt !== expectedTerrestrialTime
      ) {
        throw new RuntimeError(
          "Astronomy Engine's global delta-T function no longer matches the pinned Espenak/Meeus policy.",
        );
      }
      this.tt = expectedTerrestrialTime;
    }

    AddDays(days) {
      return new PinnedAstronomyEngineTime(this.ut + days);
    }
  };
}

const ASTRONOMY_ENGINE_PROVENANCE = Object.freeze({
  id: "astronomy-engine@2.1.19/geovector-apparent-eqj-eqd-gast",
  packageName: "astronomy-engine",
  packageVersion: "2.1.19",
  vectorPolicy:
    "GeoVector(apparent=true) EQJ -> Rotation_EQJ_EQD/RotateVector -> Rz(-GAST) ECEF",
  astronomicalUnitMetres: ASTRONOMICAL_UNIT_METRES,
  outputFrame: "ECEF",
  outputUnits: "metres",
  eventSpecificCorrections: false,
  angularRadiusCorrections: false,
  mutatesGlobalDeltaT: false,
  deltaTGuard:
    "Pinned AstroTime subclass validates root and light-time AddDays TT against DeltaT_EspenakMeeus",
  outputAllocationStable: true,
  sampleValidationTemporaryFree: true,
  sampleValidationPolicy:
    "WeakSet brand with fixed sealed output structure; no per-call descriptor/state records",
  thirdPartyTemporaryFree: false,
  thirdPartyTemporaryReason:
    "Astronomy Engine public AstroTime/vector/rotation APIs return new objects and expose no result parameters.",
});

function writeEcef(eqdVector, gastRadians, result) {
  const cosine = Math.cos(gastRadians);
  const sine = Math.sin(gastRadians);

  // Conventional active Rz(-GAST): EQD inertial axes to Earth-fixed axes.
  // Written explicitly so the sign and axis mapping remain reviewable.
  result.x =
    (cosine * eqdVector.x + sine * eqdVector.y) * ASTRONOMICAL_UNIT_METRES;
  result.y =
    (-sine * eqdVector.x + cosine * eqdVector.y) * ASTRONOMICAL_UNIT_METRES;
  result.z = eqdVector.z * ASTRONOMICAL_UNIT_METRES;
}

/**
 * Opt-in high-precision Sun/Moon vectors backed by astronomy-engine 2.1.19.
 * Use {@link AstronomyEngineEphemerisProvider.create} so the dependency is
 * fetched through a lazy dynamic import and never enters the default engine
 * module graph eagerly. After setup, {@link compute} is synchronous.
 *
 * The caller-owned sample and Cartesian outputs are allocation-stable. The
 * third-party public API necessarily creates AstroTime, vector, and rotation
 * temporaries for a changing time; provenance reports that limitation as
 * `thirdPartyTemporaryFree: false` instead of claiming zero heap activity.
 *
 * @alias AstronomyEngineEphemerisProvider
 * @constructor
 * @extends CelestialEphemerisProvider
 */
class AstronomyEngineEphemerisProvider extends CelestialEphemerisProvider {
  constructor(token, astronomyEngine) {
    super();
    if (token !== constructionToken) {
      throw new DeveloperError(
        "Use AstronomyEngineEphemerisProvider.create() to load the opt-in provider.",
      );
    }
    validateAstronomyEngine(astronomyEngine);
    this._astronomyEngine = astronomyEngine;
    this._PinnedAstroTime = createPinnedAstroTimeClass(
      astronomyEngine.AstroTime,
      astronomyEngine.DeltaT_EspenakMeeus,
    );
    this._sunBody = astronomyEngine.Body.Sun;
    this._moonBody = astronomyEngine.Body.Moon;
  }

  /**
   * Lazily loads astronomy-engine exactly once for all default-factory calls.
   *
   * @returns {Promise<AstronomyEngineEphemerisProvider>} The ready provider.
   */
  static async create() {
    const astronomyEngine = await loadAstronomyEngine();
    return new AstronomyEngineEphemerisProvider(
      constructionToken,
      astronomyEngine,
    );
  }

  get id() {
    return ASTRONOMY_ENGINE_PROVIDER_ID;
  }

  get revision() {
    return ASTRONOMY_ENGINE_PROVIDER_REVISION;
  }

  get provenance() {
    return ASTRONOMY_ENGINE_PROVENANCE;
  }

  get timePolicy() {
    return AstronomyEngineTimeAdapter.policy;
  }

  get outputAllocationStable() {
    return true;
  }

  get thirdPartyTemporaryFree() {
    return false;
  }

  compute(time, result) {
    CelestialEphemerisProvider.validateResult(result);
    const sunPositionWC = result.sunPositionWC;
    const moonPositionWC = result.moonPositionWC;

    const api = this._astronomyEngine;
    const geoVector = api.GeoVector;
    const rotateVector = api.RotateVector;
    const rotationEqjEqd = api.Rotation_EQJ_EQD;
    const siderealTime = api.SiderealTime;
    const utcDays = AstronomyEngineTimeAdapter.toUtcDaysSinceJ2000(time);
    const astroTime = new this._PinnedAstroTime(utcDays);
    const rotation = rotationEqjEqd(astroTime);
    const gastRadians = (siderealTime(astroTime) * Math.PI) / 12.0;

    const sunEqj = geoVector(this._sunBody, astroTime, true);
    const moonEqj = geoVector(this._moonBody, astroTime, true);
    // Finish every third-party operation before touching caller-owned outputs.
    // A hostile Cartesian setter therefore cannot change global delta-T between
    // Sun and Moon sampling and create a mixed-policy result.
    const sunEqd = rotateVector(rotation, sunEqj);
    const moonEqd = rotateVector(rotation, moonEqj);
    writeEcef(sunEqd, gastRadians, sunPositionWC);
    writeEcef(moonEqd, gastRadians, moonPositionWC);

    return CelestialEphemerisProvider.finalizeResult(
      result,
      this,
      ASTRONOMY_ENGINE_TRANSFORM_BRANCH,
    );
  }
}

export { ASTRONOMICAL_UNIT_METRES };
export default AstronomyEngineEphemerisProvider;
