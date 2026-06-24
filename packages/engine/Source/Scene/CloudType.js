/**
 * Specifies the type of a cloud — the WMO meteorological genus.
 *
 * The full 11-genus taxonomy is the SHARED vocabulary for both cloud systems in
 * this fork: the billboard {@link CloudCollection} (which currently renders every
 * genus as a cumulus-style puff — per-genus billboard shapes are future work) and
 * the WebGPU procedural volumetric raymarcher / weather-map path, where the genus
 * selects the altitude deck + density/lighting profile (see {@link CloudTypeProfile}).
 *
 * <code>CUMULUS = 0</code> is kept first for backward compatibility with existing
 * {@link CloudCollection#add} usage.
 *
 * @enum {number}
 */
const CloudType = {
  /** Cumulus — low, puffy, rounded (the default). @type {number} @constant */
  CUMULUS: 0,
  /** Cirrus — high, wispy ice. @type {number} @constant */
  CIRRUS: 1,
  /** Cirrostratus — high, thin ice sheet. @type {number} @constant */
  CIRROSTRATUS: 2,
  /** Cirrocumulus — high, dappled ice. @type {number} @constant */
  CIRROCUMULUS: 3,
  /** Altostratus — mid-level grey sheet. @type {number} @constant */
  ALTOSTRATUS: 4,
  /** Altocumulus — mid-level dappled. @type {number} @constant */
  ALTOCUMULUS: 5,
  /** Nimbostratus — thick, mid/low, precipitating. @type {number} @constant */
  NIMBOSTRATUS: 6,
  /** Stratus — low, flat, featureless. @type {number} @constant */
  STRATUS: 7,
  /** Stratocumulus — low, lumpy layer. @type {number} @constant */
  STRATOCUMULUS: 8,
  /** Cumulus congestus — towering cumulus. @type {number} @constant */
  CUMULUS_CONGESTUS: 9,
  /** Cumulonimbus — deep convective, anvil top. @type {number} @constant */
  CUMULONIMBUS: 10,
};

/**
 * The number of distinct cloud genera (CUMULUS=0 .. CUMULONIMBUS=10).
 * @type {number}
 * @constant
 */
CloudType.COUNT = 11;

/**
 * Validates that the provided cloud type is a valid {@link CloudType}.
 *
 * @param {CloudType} cloudType The cloud type to validate.
 * @returns {boolean} <code>true</code> if the provided cloud type is a valid value; otherwise, <code>false</code>.
 *
 * @example
 * if (!Cesium.CloudType.validate(cloudType)) {
 *   throw new Cesium.DeveloperError('cloudType must be a valid value.');
 * }
 */
CloudType.validate = function (cloudType) {
  return (
    Number.isInteger(cloudType) &&
    cloudType >= CloudType.CUMULUS &&
    cloudType <= CloudType.CUMULONIMBUS
  );
};

Object.freeze(CloudType);

export default CloudType;
