import CloudType from "./CloudType.js";

/**
 * Per-genus rendering profiles for the volumetric cloud raymarcher
 * (Weather Phase 0 — keystone for the weather-recreation roadmap).
 *
 * The 11 WMO genera ({@link CloudType}) collapse onto a small, renderable
 * parameter set. Each profile carries the five axes that distinguish the genera
 * for a volumetric raymarcher: altitude {@link CloudDeck}, vertical-extent
 * {@link CloudHeightGradientShape}, base density, optical extinction, the
 * Henyey-Greenstein anisotropy `phaseG` (≈0.9 for ice / ≈0.75 for water), and an
 * {@link CloudErosionStyle} (fibrous ice vs puffy water).
 *
 * This table is JS-authoritative; the WebGPU renderer uploads it as a small
 * uniform array / data texture and the WGSL shader selects a profile per
 * sample/deck. It is NOT consumed by the billboard {@link CloudCollection}
 * (which renders genus-agnostic puffs).
 *
 * @namespace CloudTypeProfile
 */
const CloudTypeProfile = {};

/**
 * Altitude deck a cloud genus occupies. Bounds (meters above the surface) are in
 * {@link CloudDeck.bounds}; the volumetric path's multi-deck slice (Phase 2)
 * marches one shell per active deck.
 * @enum {number}
 */
const CloudDeck = {
  LOW: 0, // 0 – 2 km
  MID: 1, // 2 – 7 km
  HIGH: 2, // 5 – 13 km
};
/** Per-deck altitude bounds `[bottom, top]` in meters. @type {Array<Array<number>>} @constant */
CloudDeck.bounds = [
  [0.0, 2000.0],
  [2000.0, 7000.0],
  [5000.0, 13000.0],
];
Object.freeze(CloudDeck);

/**
 * Vertical-extent shape of the height-density gradient.
 * @enum {number}
 */
const CloudHeightGradientShape = {
  SLAB: 0, // flat layer (stratus / cirrostratus / altostratus)
  BILLOWY: 1, // rounded-top (cumulus / altocumulus / stratocumulus)
  TOWERING_ANVIL: 2, // deep convective with anvil (congestus / cumulonimbus)
};
Object.freeze(CloudHeightGradientShape);

/**
 * Detail-erosion style — drives the high-frequency Worley erosion character.
 * @enum {number}
 */
const CloudErosionStyle = {
  FIBROUS: 0, // wispy, streaky ice (cirrus family)
  PUFFY: 1, // cauliflower water droplets (cumulus / stratus)
};
Object.freeze(CloudErosionStyle);

const LOW = CloudDeck.LOW;
const MID = CloudDeck.MID;
const HIGH = CloudDeck.HIGH;
const SLAB = CloudHeightGradientShape.SLAB;
const BILLOWY = CloudHeightGradientShape.BILLOWY;
const TOWER = CloudHeightGradientShape.TOWERING_ANVIL;
const FIBROUS = CloudErosionStyle.FIBROUS;
const PUFFY = CloudErosionStyle.PUFFY;

function profile(deck, shape, baseDensity, extinction, phaseG, erosion) {
  return { deck, shape, baseDensity, extinction, phaseG, erosion };
}

/**
 * Profile table indexed by {@link CloudType} (CUMULUS=0 .. CUMULONIMBUS=10).
 * @type {Array<object>}
 * @constant
 */
CloudTypeProfile.PROFILES = [];
CloudTypeProfile.PROFILES[CloudType.CUMULUS] = profile(
  LOW,
  BILLOWY,
  0.7,
  0.6,
  0.78,
  PUFFY,
);
CloudTypeProfile.PROFILES[CloudType.CIRRUS] = profile(
  HIGH,
  SLAB,
  0.15,
  0.1,
  0.9,
  FIBROUS,
);
CloudTypeProfile.PROFILES[CloudType.CIRROSTRATUS] = profile(
  HIGH,
  SLAB,
  0.2,
  0.15,
  0.9,
  FIBROUS,
);
CloudTypeProfile.PROFILES[CloudType.CIRROCUMULUS] = profile(
  HIGH,
  BILLOWY,
  0.2,
  0.15,
  0.88,
  FIBROUS,
);
CloudTypeProfile.PROFILES[CloudType.ALTOSTRATUS] = profile(
  MID,
  SLAB,
  0.5,
  0.45,
  0.8,
  PUFFY,
);
CloudTypeProfile.PROFILES[CloudType.ALTOCUMULUS] = profile(
  MID,
  BILLOWY,
  0.45,
  0.4,
  0.79,
  PUFFY,
);
CloudTypeProfile.PROFILES[CloudType.NIMBOSTRATUS] = profile(
  MID,
  SLAB,
  0.95,
  0.9,
  0.76,
  PUFFY,
);
CloudTypeProfile.PROFILES[CloudType.STRATUS] = profile(
  LOW,
  SLAB,
  0.6,
  0.55,
  0.76,
  PUFFY,
);
CloudTypeProfile.PROFILES[CloudType.STRATOCUMULUS] = profile(
  LOW,
  BILLOWY,
  0.65,
  0.55,
  0.77,
  PUFFY,
);
CloudTypeProfile.PROFILES[CloudType.CUMULUS_CONGESTUS] = profile(
  LOW,
  TOWER,
  0.85,
  0.75,
  0.78,
  PUFFY,
);
CloudTypeProfile.PROFILES[CloudType.CUMULONIMBUS] = profile(
  LOW,
  TOWER,
  1.0,
  0.95,
  0.78,
  PUFFY,
);

/**
 * Returns the rendering profile for a cloud genus, or the CUMULUS profile if the
 * type is out of range.
 * @param {CloudType} cloudType The cloud genus.
 * @returns {object} `{deck, shape, baseDensity, extinction, phaseG, erosion}`.
 */
CloudTypeProfile.get = function (cloudType) {
  const p = CloudTypeProfile.PROFILES[cloudType];
  return p ?? CloudTypeProfile.PROFILES[CloudType.CUMULUS];
};

CloudTypeProfile.CloudDeck = CloudDeck;
CloudTypeProfile.CloudHeightGradientShape = CloudHeightGradientShape;
CloudTypeProfile.CloudErosionStyle = CloudErosionStyle;

Object.freeze(CloudTypeProfile.PROFILES);
Object.freeze(CloudTypeProfile);

export default CloudTypeProfile;
export { CloudDeck, CloudHeightGradientShape, CloudErosionStyle };
