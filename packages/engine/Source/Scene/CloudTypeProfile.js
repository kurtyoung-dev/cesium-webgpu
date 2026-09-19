import CloudType from "./CloudType.js";

/**
 * Per-genus rendering profiles for the volumetric cloud raymarcher
 * (Weather Phase 0 — keystone for the weather-recreation roadmap).
 *
 * The 11 WMO genera ({@link CloudType}) collapse onto a small, renderable
 * parameter set. Each profile carries the five axes that distinguish the genera
 * for a volumetric raymarcher: altitude {@link CloudDeck}, vertical-extent
 * {@link CloudHeightGradientShape}, base density, optical extinction, the
 * Henyey-Greenstein anisotropy `phaseG` (≈0.86 for liquid water / ≈0.75 for
 * ice — see "THE `phaseG` COLUMN" below for the sources, and for the inversion
 * this sentence used to carry), and an {@link CloudErosionStyle} (fibrous ice
 * vs puffy water).
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
 * THE `phaseG` COLUMN — sourced, and corrected.
 *
 * This table shipped with ice and water INVERTED: the cirrus family carried
 * 0.88–0.9 and the water genera 0.76–0.78, and the module docstring stated that
 * intent explicitly. Both are backwards. The inversion was invisible for as
 * long as it survived because the shader function that reads the per-genus
 * offset had no call site; the values are corrected here by the same change
 * that first carries this column to the image.
 *
 * LIQUID WATER, visible wavelengths. Spherical droplets are strongly
 * forward-peaked. Kokhanovsky, "Optical properties of terrestrial clouds",
 * Earth-Science Reviews 64 (2004) 189–241, §3.1.4 p. 205, gives the
 * geometrical-optics limit g₀ ≈ 0.8843 at n = 1.333 (Eq. 3.32) and the size law
 * Eq. (3.35) `g = g₀ − C·x_ef^(−2/3)`, C ≈ 0.5, with `x_ef = 2π·a_ef/λ`.
 * Evaluated at λ = 0.55 µm:
 *
 *     a_ef µm │  4     5     6     8    10    12    15    20    30    → ∞
 *     g       │ .845  .851  .854  .860  .863  .866  .868  .871  .874  .8843
 *
 * Mie tabulations agree: g = 0.852 at 472 nm and 0.842 at 682 nm (Stephens
 * 1979 / Lobanova et al. 2010, reproduced in PMC6242289 Table 5). So a
 * physically-sized water cloud sits in **[0.84, 0.885]**, and 0.8843 is a
 * ceiling rather than a droplet value — it is the limit as the particle grows
 * without bound, which is why quoting it as "the" water constant overstates
 * forward scattering by 0.01–0.04 at realistic effective radii.
 *
 * ICE / CIRRUS, visible wavelengths. Non-spherical crystals are markedly less
 * forward-peaked. "Low and consistent asymmetry parameters in Arctic and
 * mid-latitude cirrus", Atmos. Chem. Phys. 26, 2465 (2026): campaign-wide
 * median g = 0.738, typical published range 0.73–0.79, per-size medians from
 * 0.777 (sub-30 µm, mid-latitude) down to 0.719/0.713 at 175 µm, observed
 * spread 0.65–0.79. MODIS Collection 6 uses a fixed 0.75. So ice sits in
 * **[0.70, 0.80]** — BELOW every liquid value, not above.
 *
 * PER-GENUS ASSIGNMENT. Each liquid genus is placed by its characteristic
 * effective radius through the Eq. (3.35) row above; each ice genus by crystal
 * size within the cirrus range. Altostratus and altocumulus are mixed-phase and
 * sit BETWEEN the two bands — altostratus lower because it is the more
 * ice-bearing of the pair. The renderer packs only the DIFFERENCE from CUMULUS
 * (`WebGPUProceduralCloudRenderer.ts`, slot 171 `genusPhaseDelta`), so the
 * absolute level is set by the tunable `phaseG1` uniform and only the ordering
 * and the spacing of this column reach the image. CUMULUS at 0.854 is within a
 * rounding of that uniform's 0.85 default, which is what keeps the default
 * genus byte-neutral.
 *
 * Cross-phase separation, cirrus 0.74 against cumulus 0.854, is 0.114 — over
 * bar A2's ≥ 0.05 per-genus clause with room. A2's ABSOLUTE band `g ∈ [0.75,
 * 0.95]` is NOT adopted here and must not be: its upper half is physically
 * unreachable for water and its lower bound excludes real cirrus. The two
 * sourced bands above are what a gate should use.
 */

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
  0.854, // liquid, a_ef ~6 um (continental cumulus); the phaseG1 reference
  PUFFY,
);
CloudTypeProfile.PROFILES[CloudType.CIRRUS] = profile(
  HIGH,
  SLAB,
  0.15,
  0.1,
  0.74, // ice; ACP 26/2465/2026 campaign median 0.738
  FIBROUS,
);
CloudTypeProfile.PROFILES[CloudType.CIRROSTRATUS] = profile(
  HIGH,
  SLAB,
  0.2,
  0.15,
  0.75, // ice; MODIS Collection 6 fixed ice asymmetry
  FIBROUS,
);
CloudTypeProfile.PROFILES[CloudType.CIRROCUMULUS] = profile(
  HIGH,
  BILLOWY,
  0.2,
  0.15,
  0.77, // ice, smallest crystals; ACP sub-30 um mid-latitude median 0.777
  FIBROUS,
);
CloudTypeProfile.PROFILES[CloudType.ALTOSTRATUS] = profile(
  MID,
  SLAB,
  0.5,
  0.45,
  0.81, // mixed phase, the more ice-bearing of the pair
  PUFFY,
);
CloudTypeProfile.PROFILES[CloudType.ALTOCUMULUS] = profile(
  MID,
  BILLOWY,
  0.45,
  0.4,
  0.83, // mixed phase, liquid-dominated
  PUFFY,
);
CloudTypeProfile.PROFILES[CloudType.NIMBOSTRATUS] = profile(
  MID,
  SLAB,
  0.95,
  0.9,
  0.866, // liquid, a_ef ~12 um (thick precipitating deck)
  PUFFY,
);
CloudTypeProfile.PROFILES[CloudType.STRATUS] = profile(
  LOW,
  SLAB,
  0.6,
  0.55,
  0.86, // liquid, a_ef ~8 um
  PUFFY,
);
CloudTypeProfile.PROFILES[CloudType.STRATOCUMULUS] = profile(
  LOW,
  BILLOWY,
  0.65,
  0.55,
  0.863, // liquid, a_ef ~10 um (marine Sc)
  PUFFY,
);
CloudTypeProfile.PROFILES[CloudType.CUMULUS_CONGESTUS] = profile(
  LOW,
  TOWER,
  0.85,
  0.75,
  0.866, // liquid, a_ef ~12 um
  PUFFY,
);
CloudTypeProfile.PROFILES[CloudType.CUMULONIMBUS] = profile(
  LOW,
  TOWER,
  1.0,
  0.95,
  0.871, // liquid, a_ef ~20 um (the optically dominant tower)
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

/**
 * Per-genus fibrous morphology parameters: the shape of the cirrus family, not
 * just its density scale.
 *
 * This table is what gives the {@link CloudErosionStyle} axis of `PROFILES` a
 * renderer consumer. Without it every genus renders the same cumuliform lobes,
 * differing only in `baseDensity` and `extinction`, so cirrus reads as a faint
 * scaled-down cumulus rather than as ice.
 *
 * The three numbers describe how the raymarcher carves a deck into ice
 * filaments, and follow from how cirriform cloud actually forms. Ice crystals
 * precipitate out of small generating cells near the tropopause and fall at
 * ~0.3-1 m/s while the horizontal wind changes strongly with height (jet-stream
 * shear of order 5-20 m/s per km). Each falling crystal is therefore advected
 * downstream as it descends, and the cloud is drawn out into long streaks
 * trailing beneath and downwind of its generating head — the "mare's tail".
 *
 * - `strength` — how deeply the filament field carves the deck. 0 leaves the
 *   cumuliform field untouched and is the value every puffy water-droplet genus
 *   takes, so a default render is unchanged. The values here stay conservative:
 *   the streak read comes entirely from `anisotropy`, since the measured
 *   elongation is independent of `strength`, while `strength` only removes
 *   optical mass — and the cirrus family is already thin twice over, at
 *   `baseDensity` 0.15 against cumulus 0.7 and `extinction` 0.1 against 0.6. A
 *   deep carve on top of that renders cirrus as very nearly nothing, so every
 *   row here retains more than half the deck's mean mass, and that floor is
 *   asserted rather than merely intended.
 * - `anisotropy` — the filament length:width aspect ratio along the wind.
 *   Observed cirrus streaks run roughly 5:1 to 20:1.
 * - `shear` — the along-wind lag of the streak's lower end relative to its
 *   generating head, in noise units per unit shell height (the fallstreak tilt).
 *
 * Per genus:
 * - CIRRUS is the archetype: detached, strongly sheared mare's tails.
 * - CIRROSTRATUS is a continuous fibrous VEIL — it has to stay a sheet (it is
 *   the genus that produces the 22-degree halo), so it carves less and tilts
 *   less than cirrus while keeping a visible fibre grain.
 * - CIRROCUMULUS is a granular "mackerel sky" of small ice cells; it is
 *   FIBROUS ice but BILLOWY in shape, so it takes a near-round aspect and
 *   almost no fallstreak tilt.
 * - Every water-droplet (PUFFY) genus takes the identity row.
 *
 * @type {Array<object>}
 * @constant
 */
CloudTypeProfile.FIBRE_MORPHOLOGY = [];
function fibre(strength, anisotropy, shear) {
  return { strength, anisotropy, shear };
}
/** The identity row: no fibrous carve, isotropic domain, no fallstreak tilt. */
const NO_FIBRE = fibre(0.0, 1.0, 0.0);
for (let i = 0; i < CloudType.COUNT; i++) {
  CloudTypeProfile.FIBRE_MORPHOLOGY[i] = NO_FIBRE;
}
CloudTypeProfile.FIBRE_MORPHOLOGY[CloudType.CIRRUS] = fibre(0.6, 9.0, 0.9);
CloudTypeProfile.FIBRE_MORPHOLOGY[CloudType.CIRROSTRATUS] = fibre(
  0.4,
  5.0,
  0.35,
);
CloudTypeProfile.FIBRE_MORPHOLOGY[CloudType.CIRROCUMULUS] = fibre(
  0.45,
  2.0,
  0.15,
);

/**
 * Returns the fibrous-morphology row for a cloud genus, or the identity row if
 * the type is out of range.
 * @param {CloudType} cloudType The cloud genus.
 * @returns {object} `{strength, anisotropy, shear}`.
 */
CloudTypeProfile.getFibreMorphology = function (cloudType) {
  const f = CloudTypeProfile.FIBRE_MORPHOLOGY[cloudType];
  return f ?? NO_FIBRE;
};

CloudTypeProfile.CloudDeck = CloudDeck;
CloudTypeProfile.CloudHeightGradientShape = CloudHeightGradientShape;
CloudTypeProfile.CloudErosionStyle = CloudErosionStyle;

Object.freeze(CloudTypeProfile.PROFILES);
Object.freeze(CloudTypeProfile.FIBRE_MORPHOLOGY);
Object.freeze(CloudTypeProfile);

export default CloudTypeProfile;
export { CloudDeck, CloudHeightGradientShape, CloudErosionStyle };
