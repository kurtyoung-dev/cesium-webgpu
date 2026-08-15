import Cartesian3 from "./Cartesian3.js";
import Check from "./Check.js";
import DeveloperError from "./DeveloperError.js";
import RuntimeError from "./RuntimeError.js";

/**
 * The Earth-centred, Earth-fixed reference frame used by celestial ephemeris
 * samples.
 *
 * @type {string}
 * @private
 */
const ECEF_REFERENCE_FRAME = "ECEF";

/**
 * The distance unit used by celestial ephemeris samples.
 *
 * @type {string}
 * @private
 */
const METRES_UNIT = "metres";

const brandedSamples = new WeakSet();

function isFiniteCartesian3(value) {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

function isZeroMagnitude(value) {
  return value.x === 0.0 && value.y === 0.0 && value.z === 0.0;
}

/**
 * An interface for a synchronous Sun/Moon ephemeris sampled in Earth-fixed
 * coordinates. Providers write into a sample owned by the caller; they never
 * replace the sample or either of its Cartesian outputs.
 *
 * A provider may perform asynchronous setup before it can be constructed, but
 * {@link CelestialEphemerisProvider#compute} itself is always synchronous.
 *
 * @alias CelestialEphemerisProvider
 * @constructor
 * @abstract
 */
class CelestialEphemerisProvider {
  constructor() {
    if (new.target === CelestialEphemerisProvider) {
      DeveloperError.throwInstantiationError();
    }
  }

  /**
   * A stable identifier for the provider implementation and its data model.
   *
   * @memberof CelestialEphemerisProvider.prototype
   * @type {string}
   * @readonly
   */
  get id() {
    return DeveloperError.throwInstantiationError();
  }

  /**
   * A non-negative integer that changes when the provider's computed result
   * can change without changing simulation time.
   *
   * @memberof CelestialEphemerisProvider.prototype
   * @type {number}
   * @readonly
   */
  get revision() {
    return DeveloperError.throwInstantiationError();
  }

  /**
   * Frozen, implementation-specific provenance for the vectors.
   *
   * @memberof CelestialEphemerisProvider.prototype
   * @type {object}
   * @readonly
   */
  get provenance() {
    return DeveloperError.throwInstantiationError();
  }

  /**
   * Frozen declaration of the provider's time-scale assumptions.
   *
   * @memberof CelestialEphemerisProvider.prototype
   * @type {object}
   * @readonly
   */
  get timePolicy() {
    return DeveloperError.throwInstantiationError();
  }

  /**
   * Whether repeated calls retain the caller's sample and Cartesian identities.
   * Branded-sample validation and final checks create no per-call descriptor or
   * state records. This does not describe temporary allocations made by an
   * underlying ephemeris implementation.
   *
   * @memberof CelestialEphemerisProvider.prototype
   * @type {boolean}
   * @readonly
   */
  get outputAllocationStable() {
    return DeveloperError.throwInstantiationError();
  }

  /**
   * Whether the underlying third-party implementation creates no temporary
   * objects while sampling. This is separate from output allocation stability
   * so consumers cannot mistake one guarantee for the other.
   *
   * @memberof CelestialEphemerisProvider.prototype
   * @type {boolean}
   * @readonly
   */
  get thirdPartyTemporaryFree() {
    return DeveloperError.throwInstantiationError();
  }

  /**
   * Computes geocentric Sun and Moon positions in ECEF metres.
   *
   * @param {JulianDate} time The Cesium simulation time (internally TAI).
   * @param {CelestialEphemerisProvider.Sample} result A caller-owned sample.
   * @returns {CelestialEphemerisProvider.Sample} The unchanged result object.
   */
  compute(time, result) {
    DeveloperError.throwInstantiationError();
  }

  /**
   * Creates the only supported sample for passing to
   * {@link CelestialEphemerisProvider#compute}. During setup, its output slots
   * are fixed and its Cartesian components and metadata become non-configurable
   * writable data properties. Providers do not call it on the sampling path.
   *
   * @returns {CelestialEphemerisProvider.Sample} A new caller-owned sample.
   */
  static createSample() {
    const sunPositionWC = new Cartesian3();
    const moonPositionWC = new Cartesian3();
    Object.seal(sunPositionWC);
    Object.seal(moonPositionWC);

    const result = {
      sunPositionWC,
      moonPositionWC,
      providerId: undefined,
      providerRevision: undefined,
      provenance: undefined,
      timePolicy: undefined,
      referenceFrame: ECEF_REFERENCE_FRAME,
      units: METRES_UNIT,
      transformBranch: undefined,
      outputAllocationStable: undefined,
      thirdPartyTemporaryFree: undefined,
    };
    Object.defineProperty(result, "sunPositionWC", {
      writable: false,
    });
    Object.defineProperty(result, "moonPositionWC", {
      writable: false,
    });
    Object.seal(result);
    brandedSamples.add(result);
    return result;
  }

  /**
   * Validates the sample brand before any caller-controlled property read.
   * Branding and the non-configurable setup contract make validation
   * allocation-free on the sampling path.
   *
   * @param {CelestialEphemerisProvider.Sample} result The sample to validate.
   * @private
   */
  static validateResult(result) {
    Check.defined("result", result);
    if (!brandedSamples.has(result)) {
      throw new DeveloperError(
        "result must be returned by CelestialEphemerisProvider.createSample().",
      );
    }
  }

  /**
   * Validates computed vectors and attaches immutable provider declarations to
   * the caller-owned sample. The sample and Cartesian identities are retained.
   *
   * @param {CelestialEphemerisProvider.Sample} result The computed sample.
   * @param {CelestialEphemerisProvider} provider The provider that computed it.
   * @param {string} transformBranch The exact frame-transform branch used.
   * @returns {CelestialEphemerisProvider.Sample} The unchanged result object.
   * @private
   */
  static finalizeResult(result, provider, transformBranch) {
    result.providerId = provider.id;
    result.providerRevision = provider.revision;
    result.provenance = provider.provenance;
    result.timePolicy = provider.timePolicy;
    result.referenceFrame = ECEF_REFERENCE_FRAME;
    result.units = METRES_UNIT;
    result.transformBranch = transformBranch;
    result.outputAllocationStable = provider.outputAllocationStable;
    result.thirdPartyTemporaryFree = provider.thirdPartyTemporaryFree;

    if (
      !isFiniteCartesian3(result.sunPositionWC) ||
      !isFiniteCartesian3(result.moonPositionWC)
    ) {
      throw new RuntimeError(
        "The celestial ephemeris provider produced a non-finite position.",
      );
    }
    // A geocentric position of exactly zero is finite but has no direction.
    // Every downstream consumer normalizes these vectors, so a zero would
    // become a NaN Sun or Moon direction that silently poisons lighting,
    // eclipse geometry and the sky rather than failing where it originated.
    if (
      isZeroMagnitude(result.sunPositionWC) ||
      isZeroMagnitude(result.moonPositionWC)
    ) {
      throw new DeveloperError(
        "The celestial ephemeris provider must produce non-zero Sun and Moon positions.",
      );
    }
    return result;
  }
}

/**
 * @typedef {object} CelestialEphemerisProvider.Sample
 * @property {Cartesian3} sunPositionWC Geocentric Sun position in ECEF metres.
 * @property {Cartesian3} moonPositionWC Geocentric Moon position in ECEF metres.
 * @property {string} [providerId] Stable provider identifier.
 * @property {number} [providerRevision] Provider revision used for the sample.
 * @property {object} [provenance] Frozen vector provenance declaration.
 * @property {object} [timePolicy] Frozen time-scale policy declaration.
 * @property {string} referenceFrame Always `ECEF`.
 * @property {string} units Always `metres`.
 * @property {string} [transformBranch] Exact frame-transform branch used.
 * @property {boolean} [outputAllocationStable] Whether output identities remain stable.
 * @property {boolean} [thirdPartyTemporaryFree] Whether the underlying third-party path is temporary-free.
 */

export default CelestialEphemerisProvider;
