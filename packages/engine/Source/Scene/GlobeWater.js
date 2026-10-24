import defined from "../Core/defined.js";
import {
  evaluateUnderwaterVerticalProfile,
  evaluateWaterlineMeniscusAndWetness,
  evaluatePolarSeaIceAndGlacialOptics,
  evaluateKelvinWakeAndBuoyancyQuery,
  evaluateCase2BioOpticalIOP,
  evaluateFetchLimitedWaveSpectrum,
} from "./BathymetryTensorMap.js";
import GlobeWaterOcean from "./GlobeWaterOcean.js";

/**
 * Quality preset tiers for planetary water, ocean, and underwater rendering.
 */
export const WaterQualityPreset = Object.freeze({
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
});

/**
 * Canonical 6 vertical altitude/depth regimes from orbit down to hadal trenches.
 */
export const WaterVerticalRegime = Object.freeze({
  ORBIT: "ORBIT",
  ATMOSPHERE: "ATMOSPHERE",
  IN_FLIGHT: "IN_FLIGHT",
  SEA_LEVEL: "SEA_LEVEL",
  SHALLOW_UNDERWATER: "SHALLOW_UNDERWATER",
  DEEP_UNDERWATER: "DEEP_UNDERWATER",
});

/**
 * Hydrological water body classification types (`WATER_RENDERING_DESIGN.md` §10.3).
 */
export const WaterType = Object.freeze({
  OCEAN: "OCEAN",
  SEA: "SEA",
  LAKE: "LAKE",
  RIVER_AREA: "RIVER_AREA",
  RIVER_LINE: "RIVER_LINE",
  WETLAND: "WETLAND",
  SWAMP: "SWAMP",
  DEEP_GLACIAL_LAKE: "DEEP_GLACIAL_LAKE",
  ANCIENT_RIFT_LAKE: "ANCIENT_RIFT_LAKE",
  HYPERSALINE_LAKE: "HYPERSALINE_LAKE",
  BLACKWATER_RIVER: "BLACKWATER_RIVER",
  ESTUARY: "ESTUARY",
});

/**
 * Maps OpenStreetMap / GeoJSON hydrological tags (`natural`, `water`, `waterway`)
 * into canonical {@link WaterType} classifications and optical defaults.
 *
 * <p>
 * It is not yet consumed by any renderer; it is scaffolding for vector water
 * data.
 * </p>
 *
 * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy.
 */
export const OsmWaterTypeAdapter = Object.freeze({
  classifyTags(tags = {}) {
    const natural = String(tags.natural ?? "").toLowerCase();
    const water = String(tags.water ?? "").toLowerCase();
    const waterway = String(tags.waterway ?? "").toLowerCase();
    const wetland = String(tags.wetland ?? "").toLowerCase();
    const saline = String(tags.saline ?? tags.salt ?? "").toLowerCase();
    const glacial = String(tags.glacial ?? "").toLowerCase();
    const tectonic = String(tags.tectonic ?? "").toLowerCase();

    if (
      wetland === "swamp" ||
      wetland === "bog" ||
      water === "swamp" ||
      water === "bayou" ||
      water === "oxbow"
    ) {
      return {
        waterType: WaterType.SWAMP,
        jerlovType: 9,
        waveAmplitudeScale: 0.03,
        fetchMeters: 90.0,
        bioOpticalIOP: evaluateCase2BioOpticalIOP({
          cdomConcentration: 3.4,
          chlorophyllConcentration: 1.8,
          mineralSpmConcentration: 0.25,
          salinityPermil: 0.5,
          stagnantMarginFactor: 0.85,
        }),
      };
    }
    if (
      natural === "wetland" ||
      water === "wetland" ||
      water === "marsh" ||
      water === "mangrove"
    ) {
      return {
        waterType: WaterType.WETLAND,
        jerlovType: 8,
        waveAmplitudeScale: 0.08,
        fetchMeters: 220.0,
        bioOpticalIOP: evaluateCase2BioOpticalIOP({
          cdomConcentration: 2.2,
          chlorophyllConcentration: 1.4,
          mineralSpmConcentration: 0.6,
          salinityPermil: 5.0,
          stagnantMarginFactor: 0.65,
        }),
      };
    }
    if (water === "blackwater" || waterway === "blackwater") {
      return {
        waterType: WaterType.BLACKWATER_RIVER,
        jerlovType: 9,
        waveAmplitudeScale: 0.14,
        fetchMeters: 800.0,
        bioOpticalIOP: evaluateCase2BioOpticalIOP({
          cdomConcentration: 3.8,
          chlorophyllConcentration: 0.2,
          mineralSpmConcentration: 0.08,
          salinityPermil: 0.1,
        }),
      };
    }
    if (waterway === "river" || waterway === "stream" || waterway === "canal") {
      return {
        waterType: WaterType.RIVER_LINE,
        jerlovType: 7,
        waveAmplitudeScale: 0.2,
        fetchMeters: 350.0,
        bioOpticalIOP: evaluateCase2BioOpticalIOP({
          cdomConcentration: 0.8,
          chlorophyllConcentration: 0.6,
          mineralSpmConcentration: 1.4,
          salinityPermil: 0.2,
        }),
      };
    }
    if (water === "estuary" || waterway === "tidal_channel") {
      return {
        waterType: WaterType.ESTUARY,
        jerlovType: 7,
        waveAmplitudeScale: 0.4,
        fetchMeters: 6500.0,
        bioOpticalIOP: evaluateCase2BioOpticalIOP({
          cdomConcentration: 1.1,
          chlorophyllConcentration: 0.9,
          mineralSpmConcentration: 2.2,
          salinityPermil: 18.0,
        }),
      };
    }
    if (water === "river" || waterway === "riverbank") {
      return {
        waterType: WaterType.RIVER_AREA,
        jerlovType: 7,
        waveAmplitudeScale: 0.35,
        fetchMeters: 1400.0,
        bioOpticalIOP: evaluateCase2BioOpticalIOP({
          cdomConcentration: 0.9,
          chlorophyllConcentration: 0.6,
          mineralSpmConcentration: 1.6,
          salinityPermil: 0.2,
        }),
      };
    }
    if (
      water === "salt_lake" ||
      water === "hypersaline" ||
      saline === "yes" ||
      saline === "hypersaline"
    ) {
      return {
        waterType: WaterType.HYPERSALINE_LAKE,
        jerlovType: 4,
        waveAmplitudeScale: 0.28,
        fetchMeters: 18000.0,
        bioOpticalIOP: evaluateCase2BioOpticalIOP({
          cdomConcentration: 0.3,
          chlorophyllConcentration: 0.4,
          mineralSpmConcentration: 1.1,
          salinityPermil: 295.0,
        }),
      };
    }
    if (water === "rift_lake" || tectonic === "rift") {
      return {
        waterType: WaterType.ANCIENT_RIFT_LAKE,
        jerlovType: 0,
        waveAmplitudeScale: 0.55,
        fetchMeters: 48000.0,
        bioOpticalIOP: evaluateCase2BioOpticalIOP({
          cdomConcentration: 0.05,
          chlorophyllConcentration: 0.08,
          mineralSpmConcentration: 0.04,
          salinityPermil: 0.1,
        }),
      };
    }
    if (water === "glacial_lake" || glacial === "yes") {
      return {
        waterType: WaterType.DEEP_GLACIAL_LAKE,
        jerlovType: 5,
        waveAmplitudeScale: 0.32,
        fetchMeters: 4500.0,
        bioOpticalIOP: evaluateCase2BioOpticalIOP({
          cdomConcentration: 0.04,
          chlorophyllConcentration: 0.06,
          mineralSpmConcentration: 2.4,
          glacialRockFlourFraction: 0.94,
          salinityPermil: 0.05,
        }),
      };
    }
    if (
      water === "lake" ||
      water === "reservoir" ||
      water === "pond" ||
      natural === "water"
    ) {
      return {
        waterType: WaterType.LAKE,
        jerlovType: 5,
        waveAmplitudeScale: 0.45,
        fetchMeters: 8500.0,
        bioOpticalIOP: evaluateCase2BioOpticalIOP({
          cdomConcentration: 0.45,
          chlorophyllConcentration: 0.55,
          mineralSpmConcentration: 0.35,
          salinityPermil: 0.2,
        }),
      };
    }
    if (water === "sea" || water === "bay" || water === "strait") {
      return {
        waterType: WaterType.SEA,
        jerlovType: 3,
        waveAmplitudeScale: 0.85,
        fetchMeters: 120000.0,
        bioOpticalIOP: evaluateCase2BioOpticalIOP({
          cdomConcentration: 0.18,
          chlorophyllConcentration: 0.25,
          mineralSpmConcentration: 0.15,
          salinityPermil: 36.0,
        }),
      };
    }
    return {
      waterType: WaterType.OCEAN,
      jerlovType: 2,
      waveAmplitudeScale: 1.0,
      fetchMeters: 500000.0,
      bioOpticalIOP: evaluateCase2BioOpticalIOP({
        cdomConcentration: 0.04,
        chlorophyllConcentration: 0.08,
        mineralSpmConcentration: 0.04,
        salinityPermil: 35.0,
      }),
    };
  },
});

/**
 * Spatial collection of geographic water parameter overrides (`scene.globe.water.regions`).
 *
 * <p>
 * The collection carries a monotonically increasing {@link WaterRegionCollection#version}
 * that {@link WaterRegionCollection#add}, {@link WaterRegionCollection#remove} and
 * {@link WaterRegionCollection#removeAll} bump. The globe compares it every frame and
 * rebuilds the water masks of the loaded tiles when it changes. A region entry
 * returned by <code>add</code> is a plain object: after editing one in place, call
 * {@link WaterRegionCollection#markDirty} so the change is seen.
 * </p>
 */
export class WaterRegionCollection {
  constructor() {
    this._regions = [];
    this._version = 0;
  }

  get length() {
    return this._regions.length;
  }

  /**
   * Increases by one every time the collection changes (a region added or
   * removed, or {@link WaterRegionCollection#markDirty} called). Compare it
   * with a remembered value to find out whether anything changed, wherever in
   * the list the change was.
   * @type {number}
   * @readonly
   */
  get version() {
    return this._version;
  }

  /**
   * Declares that a region entry was edited in place. Entries are plain
   * objects, so assigning to one of their fields is invisible to the
   * collection until this is called.
   */
  markDirty() {
    this._version++;
  }

  add(region) {
    if (!defined(region)) {
      throw new Error("region is required");
    }
    const entry = {
      id: region.id ?? `region_${this._regions.length}`,
      west: Number(region.west ?? -Math.PI),
      south: Number(region.south ?? -Math.PI / 2),
      east: Number(region.east ?? Math.PI),
      north: Number(region.north ?? Math.PI / 2),
      waterType: region.waterType ?? WaterType.OCEAN,
      jerlovType: Number(region.jerlovType ?? 2),
      waveAmplitudeScale: Number(region.waveAmplitudeScale ?? 1.0),
      iceConcentration: Number(region.iceConcentration ?? 0.0),
    };
    this._regions.push(entry);
    this._version++;
    return entry;
  }

  remove(idOrRegion) {
    const idx = this._regions.findIndex(
      (r) => r === idOrRegion || r.id === idOrRegion,
    );
    if (idx === -1) {
      return false;
    }
    this._regions.splice(idx, 1);
    this._version++;
    return true;
  }

  removeAll() {
    if (this._regions.length > 0) {
      this._regions.length = 0;
      this._version++;
    }
  }

  evaluateAtCartographic(longitudeRadians, latitudeRadians) {
    for (let i = this._regions.length - 1; i >= 0; i--) {
      const r = this._regions[i];
      if (
        longitudeRadians >= r.west &&
        longitudeRadians <= r.east &&
        latitudeRadians >= r.south &&
        latitudeRadians <= r.north
      ) {
        return r;
      }
    }
    return undefined;
  }
}

/**
 * What each {@link WaterQualityPreset} writes. `celestialReflection` and
 * `foamThreshold` go to the globe's own water; `celestialReflection`,
 * `detailScale` and `foamStrength` go to the FFT ocean sub-facade.
 */
const QUALITY_PRESET_DIALS = Object.freeze({
  [WaterQualityPreset.LOW]: Object.freeze({
    celestialReflection: false,
    foamThreshold: 0.72,
    detailScale: 0.75,
    foamStrength: 0.7,
  }),
  [WaterQualityPreset.MEDIUM]: Object.freeze({
    celestialReflection: true,
    foamThreshold: 0.65,
    detailScale: 1.5,
    foamStrength: 1.0,
  }),
  [WaterQualityPreset.HIGH]: Object.freeze({
    celestialReflection: true,
    foamThreshold: 0.58,
    detailScale: 2.25,
    foamStrength: 1.25,
  }),
});

/**
 * Half-width, in metres, of the terrain-height band the globe treats as "the
 * surface under the camera is sea level" for the opt-in water dive. See
 * {@link GlobeWater#canDiveAtSurfaceHeight}.
 */
const SEA_LEVEL_SURFACE_TOLERANCE_METERS = 110.0;

/**
 * The water facade, accessed as <code>scene.globe.water</code>.
 *
 * Like {@link AtmosphericConditions} this class is a facade: its accessors read
 * and write through to the existing {@link Globe} fields —
 * <code>showWaterEffect</code>, <code>oceanNormalMapUrl</code> and the
 * enhanced-ocean tunables — which remain authoritative.
 *
 * It hangs off the globe rather than off the scene because every water property
 * already lives on {@link Globe}, because water is rendered as part of the
 * terrain pass through the water mask, and because it then pairs symmetrically
 * with <code>scene.globe.atmosphericConditions</code>. Further water features
 * are added as sub-facades on this class.
 *
 * @alias GlobeWater
 * @constructor
 *
 * @param {Scene} scene The owning Scene (kept as a back-reference for
 *   future phases; currently unused).
 * @param {Globe} globe The owning Globe. All current properties delegate
 *   to fields on this object.
 */
class GlobeWater {
  constructor(scene, globe) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(scene)) {
      throw new Error("scene is required");
    }
    if (!defined(globe)) {
      throw new Error("globe is required");
    }
    //>>includeEnd('debug');

    this._scene = scene;
    this._globe = globe;
    this._ocean = undefined;
    this._regions = undefined;
    this._qualityPreset = WaterQualityPreset.MEDIUM;
    this._submersibleLightEnabled = false;
    this._submersibleLightIntensity = 1.0;
    this._bathymetricReliefBoost = 0.0;
    this._vesselWakeEnabled = false;
    this._vesselWakeIntensity = 1.0;
    this._vesselWakeEmitters = [];
    this._disableWaterCollision = false;
    this._nearSurfaceTransparency = 0.78;
    this._diveDepthMeters = 0.0;
    this._lastSubmergedTimeSeconds = 0.0;
    this._wasSubmerged = false;
    this._timeSinceEmergenceSeconds = 10.0;
    this._emergenceWetness = 0.0;
  }

  /**
   * Spatial collection of regional water classification and optical overrides.
   * @type {WaterRegionCollection}
   * @readonly
   */
  get regions() {
    if (!defined(this._regions)) {
      this._regions = new WaterRegionCollection();
    }
    return this._regions;
  }

  /**
   * Whether the {@link GlobeWater#ocean} sub-facade has been created, answered
   * WITHOUT creating it. The globe reads the ocean's tide settings every frame;
   * asking the public `ocean` accessor for that would create the sub-facade
   * for every scene that draws a globe.
   * @type {boolean}
   * @readonly
   * @private
   */
  get hasOcean() {
    return defined(this._ocean);
  }

  /**
   * The opt-in FFT spectral ocean sub-facade. Setting
   * <code>scene.globe.water.ocean.enabled = true</code> creates and adds an
   * {@link OceanSurfacePrimitive}; it is off by default and inert while off.
   * WebGPU only, and a no-op on WebGL.
   * @type {GlobeWaterOcean}
   * @readonly
   */
  get ocean() {
    if (!defined(this._ocean)) {
      this._ocean = new GlobeWaterOcean(this._scene, this._globe);
    }
    return this._ocean;
  }

  /**
   * The FFT surface's pinned simulation epoch, or <code>undefined</code>,
   * WITHOUT creating the ocean sub-facade.
   *
   * The globe's own water-mask ocean reads this every rendered frame so that a
   * single pin fixes both seas. The sub-facade is created lazily, and reading
   * the public accessor to find out whether anything had been pinned would
   * create it for every scene that draws a globe — so this asks the field
   * instead. That is safe rather than merely cheap: the only way to pin an
   * epoch is through <code>scene.globe.water.ocean</code>, which creates the
   * sub-facade on the way, so an absent sub-facade is proof that no pin exists.
   *
   * @type {JulianDate|undefined}
   * @readonly
   * @private
   */
  get pinnedOceanSimulationEpoch() {
    return this._ocean?.simulationEpoch;
  }

  /**
   * The sea-level vertical datum the FFT ocean surface anchors to — one of
   * {@link VerticalDatum} (`"AUTO"` | `"ELLIPSOID"` | `"GEOID"`). Delegates to
   * `scene.globe.water.ocean.verticalDatum`.
   *
   * <code>AUTO</code> derives the datum from the globe's terrain provider, and
   * is the default because an ellipsoid-0 anchor sits a measured 101.64 m above
   * Cesium World Terrain's baked sea at the Sri Lanka coast.
   *
   * @type {string}
   * @default VerticalDatum.AUTO
   */
  get oceanVerticalDatum() {
    return this.ocean.verticalDatum;
  }

  set oceanVerticalDatum(v) {
    this.ocean.verticalDatum = v;
  }

  /**
   * Whether the tide term is applied to the water surface. Delegates to
   * `scene.globe.water.ocean.tideEnabled`. `false` makes the tide contribution
   * exactly 0.
   * @type {boolean}
   * @default true
   */
  get tideEnabled() {
    return this.ocean.tideEnabled;
  }

  set tideEnabled(v) {
    this.ocean.tideEnabled = v;
  }

  /**
   * Multiplier on the tide term; 1.0 is true scale. Delegates to
   * <code>scene.globe.water.ocean.tideExaggeration</code>. Above 1.0 is
   * stylised rather than predictive: the underlying equilibrium tide is ±0.3 m,
   * with no basin amplification and no phase lag.
   * @type {number}
   * @default 1.0
   */
  get tideExaggeration() {
    return this.ocean.tideExaggeration;
  }

  set tideExaggeration(v) {
    this.ocean.tideExaggeration = v;
  }

  /**
   * Application-supplied tide source, `(positionWC, time) => metres`, used in
   * place of the in-engine {@link TideModel}. Delegates to
   * `scene.globe.water.ocean.tideCallback`.
   *
   * <code>null</code> means "use the engine's tide", not "no tide";
   * <code>tideEnabled = false</code> is what suppresses the term entirely.
   * @type {Function|undefined}
   * @default undefined
   */
  get tideCallback() {
    return this.ocean.tideCallback;
  }

  set tideCallback(v) {
    this.ocean.tideCallback = v;
  }

  /**
   * Enables or disables water rendering on the terrain surface (upstream
   * Cesium-owned). Delegates to `globe.showWaterEffect`.
   * @type {boolean}
   */
  get showWaterEffect() {
    return this._globe.showWaterEffect;
  }

  set showWaterEffect(v) {
    this._globe.showWaterEffect = v;
  }

  /**
   * When true, a lightweight vector dataset of global coastlines and oceans
   * provides water masks for all terrain tiles globally, enabling natural
   * planetary oceans and coastlines even when the terrain provider does not
   * supply a water mask. Delegates to `globe.globalWaterMask`.
   *
   * The dataset covers oceans, seas and coasts; inland lakes are not in it, so
   * they appear only when {@link GlobeWater#lakeWaterMask} is also true.
   * Enabling it fetches roughly 1.8 MiB of coastline data plus a roughly
   * 1.0 MiB bathymetry tensor, once, on first enable.
   * @type {boolean}
   * @default false
   */
  get globalWaterMask() {
    return this._globe.globalWaterMask;
  }

  set globalWaterMask(v) {
    this._globe.globalWaterMask = v;
  }

  /**
   * When true, supplementary Natural Earth lake polygons are composited over
   * the terrain water mask, enabling inland lakes (Great Lakes, Baikal, etc.)
   * to render with water animation. Delegates to `globe.lakeWaterMask`.
   * @type {boolean}
   * @default false
   */
  get lakeWaterMask() {
    return this._globe.lakeWaterMask;
  }

  set lakeWaterMask(v) {
    this._globe.lakeWaterMask = v;
  }

  /**
   * When true, major continental rivers and deltas from the bundled Natural Earth
   * 1:10m rivers dataset are composited into the terrain water mask. Delegates
   * to `globe.riverWaterMask`.
   * @type {boolean}
   * @default false
   */
  get riverWaterMask() {
    return this._globe.riverWaterMask;
  }

  set riverWaterMask(v) {
    this._globe.riverWaterMask = v;
  }

  /**
   * Ocean normal map URL (upstream Cesium-owned). Delegates to
   * `globe.oceanNormalMapUrl`.
   * @type {string}
   */
  get oceanNormalMapUrl() {
    return this._globe.oceanNormalMapUrl;
  }

  set oceanNormalMapUrl(v) {
    this._globe.oceanNormalMapUrl = v;
  }

  /**
   * Enables the fork's enhanced-ocean shading path. Delegates to
   * `globe.enableEnhancedOcean`.
   * @type {boolean}
   */
  get enableEnhanced() {
    return this._globe.enableEnhancedOcean;
  }

  set enableEnhanced(v) {
    this._globe.enableEnhancedOcean = v;
  }

  /**
   * Deep-water base color. Delegates to `globe.oceanDeepColor`.
   * @type {{x:number,y:number,z:number}}
   */
  get deepColor() {
    return this._globe.oceanDeepColor;
  }

  set deepColor(v) {
    this._globe.oceanDeepColor = v;
  }

  /**
   * Fresnel exponent for ocean reflectivity. Delegates to
   * `globe.oceanFresnelPower`.
   * @type {number}
   */
  get fresnelPower() {
    return this._globe.oceanFresnelPower;
  }

  set fresnelPower(v) {
    this._globe.oceanFresnelPower = v;
  }

  /**
   * Base reflectivity (F0) for water surfaces. Delegates to
   * `globe.oceanReflectivity`.
   * @type {number}
   */
  get reflectivity() {
    return this._globe.oceanReflectivity;
  }

  set reflectivity(v) {
    this._globe.oceanReflectivity = v;
  }

  /**
   * Threshold above which foam is rendered. Delegates to
   * `globe.oceanFoamThreshold`.
   * @type {number}
   */
  get foamThreshold() {
    return this._globe.oceanFoamThreshold;
  }

  set foamThreshold(v) {
    this._globe.oceanFoamThreshold = v;
  }

  /**
   * Darkening factor applied to underwater terrain. Delegates to
   * `globe.oceanDarkening`.
   * @type {number}
   */
  get darkening() {
    return this._globe.oceanDarkening;
  }

  set darkening(v) {
    this._globe.oceanDarkening = v;
  }

  /**
   * Reflects the Sun and the Moon on the globe's water through a microfacet
   * lobe instead of the classic Phong highlight. Delegates to
   * `globe.oceanCelestialReflection`.
   *
   * <p>
   * This configures the water the globe draws from its water mask. The opt-in
   * FFT surface has its own switch at
   * <code>scene.globe.water.ocean.celestialReflection</code>; the two resolve
   * through one shared law but are enabled independently, because a scene can
   * show both oceans at once.
   * </p>
   * @type {boolean}
   * @default false
   */
  get celestialReflection() {
    return this._globe.oceanCelestialReflection;
  }

  set celestialReflection(v) {
    this._globe.oceanCelestialReflection = v;
  }

  /**
   * Base microfacet roughness of the near water. Delegates to
   * `globe.oceanCelestialRoughness`.
   * @type {number}
   * @default 0.06
   */
  get celestialRoughness() {
    return this._globe.oceanCelestialRoughness;
  }

  set celestialRoughness(v) {
    this._globe.oceanCelestialRoughness = v;
  }

  /**
   * Multiplier on the reflected solar disc. Delegates to
   * `globe.oceanCelestialSunIntensity`.
   * @type {number}
   * @default 1
   */
  get celestialSunIntensity() {
    return this._globe.oceanCelestialSunIntensity;
  }

  set celestialSunIntensity(v) {
    this._globe.oceanCelestialSunIntensity = v;
  }

  /**
   * Multiplier on the reflected lunar disc. Delegates to
   * `globe.oceanCelestialMoonIntensity`.
   * @type {number}
   * @default 0.35
   */
  get celestialMoonIntensity() {
    return this._globe.oceanCelestialMoonIntensity;
  }

  set celestialMoonIntensity(v) {
    this._globe.oceanCelestialMoonIntensity = v;
  }

  /**
   * Active quality preset tier (`"LOW"`, `"MEDIUM"`, or `"HIGH"`).
   * Scales water reflection, foam, and wave detail budgets across all 6 regimes.
   *
   * <p>
   * Assigning a tier writes its dials through the public properties:
   * {@link GlobeWater#celestialReflection} and {@link GlobeWater#foamThreshold}
   * for the globe's water, and the FFT ocean's
   * <code>celestialReflection</code>, <code>detailScale</code> and
   * <code>foamStrength</code> (cached by the sub-facade, so a tier chosen
   * before <code>ocean.enabled = true</code> still applies). It never changes
   * {@link GlobeWater#enableEnhanced}.
   * </p>
   * <p>
   * The default, <code>MEDIUM</code>, is the nominal tier and means "nothing
   * has been assigned": every dial starts at its own default (celestial
   * reflection off, foam threshold 0.35, ocean detail scale 2.0, foam strength
   * 1.0), which are not the values assigning <code>MEDIUM</code> writes
   * (reflection on, 0.65, 1.5, 1.0). Assign it explicitly to apply those.
   * </p>
   * @type {string}
   * @default WaterQualityPreset.MEDIUM
   */
  get qualityPreset() {
    return this._qualityPreset;
  }

  set qualityPreset(preset) {
    const candidate =
      typeof preset === "string" ? preset.trim().toUpperCase() : "";
    const normalized =
      candidate === WaterQualityPreset.LOW ||
      candidate === WaterQualityPreset.MEDIUM ||
      candidate === WaterQualityPreset.HIGH
        ? candidate
        : WaterQualityPreset.MEDIUM;
    this._qualityPreset = normalized;
    const dials = QUALITY_PRESET_DIALS[normalized];
    // The globe's own water. `enableEnhancedOcean` is deliberately NOT written:
    // choosing a tier is not a request for the more expensive enhanced shader.
    this._globe.oceanCelestialReflection = dials.celestialReflection;
    this._globe.oceanFoamThreshold = dials.foamThreshold;
    // The FFT surface, through its public setters. The sub-facade caches the
    // values and applies them when the primitive is created, so a preset set
    // before `ocean.enabled = true` is not lost.
    const ocean = this.ocean;
    ocean.celestialReflection = dials.celestialReflection;
    ocean.detailScale = dials.detailScale;
    ocean.foamStrength = dials.foamStrength;
  }

  /**
   * Whether the camera may dive below the water surface at a point whose
   * terrain surface is at <code>globeHeight</code>. True only when
   * {@link GlobeWater#disableWaterCollision} is set AND that surface is at
   * sea level; over land (a ridge, a plateau) the camera keeps the stock
   * terrain collision, so the flag never lets it sink into the ground.
   *
   * <p>
   * "At sea level" is a height band, not a measurement of the water mask:
   * <code>|globeHeight| &lt;= 110 m</code>, which holds the whole range of the
   * EGM2008 undulation (about -107 m to +86 m) because terrain baked against
   * the geoid puts its sea surface there. Terrain deeper than that band is
   * bathymetry, which the stock terrain clamp already lets the camera descend
   * to, so it falls through to stock behaviour too.
   * </p>
   *
   * @param {number|undefined} globeHeight Terrain surface height under the
   *   camera, in metres above the ellipsoid (<code>scene.globeHeight</code>).
   * @returns {boolean}
   * @private
   */
  canDiveAtSurfaceHeight(globeHeight) {
    return (
      this._disableWaterCollision === true &&
      Number.isFinite(globeHeight) &&
      Math.abs(globeHeight) <= SEA_LEVEL_SURFACE_TOLERANCE_METERS
    );
  }

  /**
   * Opt-in camera-mounted ROV spotlight for deep underwater inspection.
   * Default `false` so deep aphotic waters (`< -1,000 m`) remain strictly physical.
   * @type {boolean}
   * @default false
   */
  get submersibleLightEnabled() {
    return this._submersibleLightEnabled;
  }

  set submersibleLightEnabled(v) {
    this._submersibleLightEnabled = v === true;
  }

  /**
   * Multiplier on the opt-in ROV submersible spotlight when enabled.
   * @type {number}
   * @default 1.0
   */
  get submersibleLightIntensity() {
    return this._submersibleLightIntensity;
  }

  set submersibleLightIntensity(v) {
    if (typeof v === "number" && Number.isFinite(v)) {
      this._submersibleLightIntensity = Math.max(0.0, v);
    }
  }

  /**
   * Opt-in topographic relief shading boost (`[0.0, 2.0]`) for inspecting
   * deep ocean trenches and abyssal morphology.
   * @type {number}
   * @default 0.0
   */
  get bathymetricReliefBoost() {
    return this._bathymetricReliefBoost;
  }

  set bathymetricReliefBoost(v) {
    if (typeof v === "number" && Number.isFinite(v)) {
      this._bathymetricReliefBoost = Math.max(0.0, Math.min(2.0, v));
    }
  }

  /**
   * Enables or disables dynamic Lord Kelvin 19.47 deg vessel V-wakes and
   * stern propeller wash on the water surface.
   *
   * <p>
   * The vessel wake is not yet consumed by any renderer: no shader places a
   * wake from the registered emitters, so no wake is drawn whatever this is
   * set to.
   * </p>
   *
   * @type {boolean}
   * @default false
   * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy.
   */
  get vesselWakeEnabled() {
    return this._vesselWakeEnabled;
  }

  set vesselWakeEnabled(v) {
    this._vesselWakeEnabled = v === true;
  }

  /**
   * Multiplier on dynamic Kelvin vessel wake height and stern foam (`[0.0, 2.0]`).
   * Not yet consumed by any renderer, like {@link GlobeWater#vesselWakeEnabled}.
   * @type {number}
   * @default 1.0
   * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy.
   */
  get vesselWakeIntensity() {
    return this._vesselWakeIntensity;
  }

  set vesselWakeIntensity(v) {
    if (typeof v === "number" && Number.isFinite(v)) {
      this._vesselWakeIntensity = Math.max(0.0, Math.min(2.0, v));
    }
  }

  /**
   * Registered vessel wake emitters (`{ x, y, vx, vy, lengthMeters }`). Not yet
   * consumed by any renderer.
   * @type {Array<object>}
   * @readonly
   * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy.
   */
  get vesselWakeEmitters() {
    return this._vesselWakeEmitters;
  }

  /**
   * Registers a dynamic vessel or seaplane wake emitter and enables vessel wakes.
   *
   * <p>
   * The emitter is stored but not yet consumed by any renderer. Omitted
   * fields default to <code>x = 95</code>, <code>y = 165</code>,
   * <code>vx = 6.4</code>, <code>vy = 4.8</code> and
   * <code>lengthMeters = 28</code>. Those are placeholder values; they are
   * unrelated to any constant in the shaders.
   * </p>
   *
   * @param {object} emitter Vessel position (`x, y` or `longitudeRadians, latitudeRadians`) and velocity (`vx, vy`).
   * @returns {object} Normalized emitter descriptor.
   * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy.
   */
  addVesselWakeEmitter(emitter = {}) {
    const entry = {
      x: Number(emitter.x ?? 95.0),
      y: Number(emitter.y ?? 165.0),
      vx: Number(emitter.vx ?? 6.4),
      vy: Number(emitter.vy ?? 4.8),
      lengthMeters: Math.max(2.0, Number(emitter.lengthMeters ?? 28.0)),
      longitudeRadians:
        emitter.longitudeRadians !== undefined
          ? Number(emitter.longitudeRadians)
          : undefined,
      latitudeRadians:
        emitter.latitudeRadians !== undefined
          ? Number(emitter.latitudeRadians)
          : undefined,
    };
    this._vesselWakeEmitters.push(entry);
    this._vesselWakeEnabled = true;
    return entry;
  }

  /**
   * Clears all registered vessel wake emitters.
   */
  clearVesselWakeEmitters() {
    this._vesselWakeEmitters.length = 0;
  }

  /**
   * When `true`, disables camera collision with the water surface and allows
   * manual mouse-wheel / drag zooming to descend smoothly underwater to inspect
   * the submerged surface and bathymetry.
   * @type {boolean}
   * @default false
   */
  get disableWaterCollision() {
    return this._disableWaterCollision;
  }

  set disableWaterCollision(v) {
    this._disableWaterCollision = v === true;
    if (!this._disableWaterCollision) {
      this._diveDepthMeters = 0.0;
    }
  }

  /**
   * Whether the camera collides with the water surface when zooming in (`!disableWaterCollision`).
   * @type {boolean}
   * @default true
   */
  get cameraCollisionEnabled() {
    return !this._disableWaterCollision;
  }

  set cameraCollisionEnabled(v) {
    this.disableWaterCollision = v === false;
  }

  /**
   * Controls how transparent the water imagery and surface become as the camera
   * approaches the water (`[0.0, 1.0]`), revealing the underwater seabed, reefs,
   * sandbars, caustics, and 3D bathymetric relief.
   * @type {number}
   * @default 0.78
   */
  get nearSurfaceTransparency() {
    return this._nearSurfaceTransparency;
  }

  set nearSurfaceTransparency(v) {
    if (typeof v === "number" && Number.isFinite(v)) {
      this._nearSurfaceTransparency = Math.max(0.0, Math.min(1.0, v));
    }
  }

  /**
   * Alias for {@link GlobeWater#nearSurfaceTransparency}.
   * @type {number}
   * @default 0.78
   */
  get surfaceTransparency() {
    return this._nearSurfaceTransparency;
  }

  set surfaceTransparency(v) {
    this.nearSurfaceTransparency = v;
  }

  /**
   * Active underwater dive depth in meters (`>= 0.0`) when the camera zooms
   * below the water surface with `disableWaterCollision = true`.
   * @type {number}
   * @default 0.0
   */
  get diveDepthMeters() {
    return this._diveDepthMeters;
  }

  set diveDepthMeters(v) {
    if (typeof v === "number" && Number.isFinite(v)) {
      this._diveDepthMeters = Math.max(0.0, Math.min(11000.0, v));
    }
  }

  /**
   * Updates the camera submergence-to-emergence transition timer and returns
   * the current exponential lens-drying wetness factor (`[0.0, 1.0]`).
   *
   * @param {number} altitudeMeters Signed camera altitude relative to sea level.
   * @param {number} currentTimeSeconds Monotonic simulation clock in seconds.
   * @returns {number} Active emergence lens wetness (`[0.0, 1.0]`).
   */
  updateCameraEmergenceState(altitudeMeters, currentTimeSeconds) {
    const rawAlt = Number.isFinite(altitudeMeters) ? altitudeMeters : 100.0;
    const alt =
      this._diveDepthMeters > 0.0 && rawAlt >= 0.0
        ? -this._diveDepthMeters
        : rawAlt;
    const now = Number.isFinite(currentTimeSeconds) ? currentTimeSeconds : 0.0;
    if (alt < -0.25) {
      this._wasSubmerged = true;
      this._lastSubmergedTimeSeconds = now;
      this._timeSinceEmergenceSeconds = 0.0;
      this._emergenceWetness = 1.0;
    } else if (this._wasSubmerged) {
      const dt = Math.max(0.0, now - this._lastSubmergedTimeSeconds);
      this._timeSinceEmergenceSeconds = dt;
      this._emergenceWetness = Math.exp(-dt / 1.5);
      if (dt > 8.0) {
        this._wasSubmerged = false;
        this._timeSinceEmergenceSeconds = 10.0;
        this._emergenceWetness = 0.0;
      }
    } else {
      this._timeSinceEmergenceSeconds = 10.0;
      this._emergenceWetness = 0.0;
    }
    return this._emergenceWetness;
  }

  /**
   * Resolves the active vertical regime (`ORBIT`, `ATMOSPHERE`, `IN_FLIGHT`,
   * `SEA_LEVEL`, `SHALLOW_UNDERWATER`, or `DEEP_UNDERWATER`) and underwater
   * optical telemetry for a camera altitude (positive above sea level, negative
   * when submerged).
   *
   * @param {number} altitudeMeters Signed camera altitude relative to sea level.
   * @param {object} [options] Optional optical evaluation overrides.
   * @returns {object} Active regime classification and optical telemetry.
   * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy. Not yet consumed by any renderer.
   */
  evaluateRegimeAtAltitude(altitudeMeters, options = {}) {
    const rawAlt = Number.isFinite(altitudeMeters) ? altitudeMeters : 0.0;
    const alt =
      this._diveDepthMeters > 0.0 &&
      rawAlt >= 0.0 &&
      rawAlt <= 45.0 &&
      !options.ignoreDiveDepth
        ? -this._diveDepthMeters
        : rawAlt;
    let regime;
    if (alt > 200000.0) {
      regime = WaterVerticalRegime.ORBIT;
    } else if (alt > 15000.0) {
      regime = WaterVerticalRegime.ATMOSPHERE;
    } else if (alt > 500.0) {
      regime = WaterVerticalRegime.IN_FLIGHT;
    } else if (alt >= 0.0) {
      regime = WaterVerticalRegime.SEA_LEVEL;
    } else if (alt >= -200.0) {
      regime = WaterVerticalRegime.SHALLOW_UNDERWATER;
    } else {
      regime = WaterVerticalRegime.DEEP_UNDERWATER;
    }

    let regionOverride;
    if (
      defined(this._regions) &&
      this._regions.length > 0 &&
      Number.isFinite(options.longitudeRadians) &&
      Number.isFinite(options.latitudeRadians)
    ) {
      regionOverride = this._regions.evaluateAtCartographic(
        options.longitudeRadians,
        options.latitudeRadians,
      );
    }

    const submergedDepth = alt < 0.0 ? -alt : -1.0;
    const underwaterProfile = evaluateUnderwaterVerticalProfile(
      submergedDepth,
      {
        ...options,
        jerlovType:
          options.jerlovType ?? regionOverride?.jerlovType ?? undefined,
        submersibleLightEnabled:
          options.submersibleLightEnabled ?? this._submersibleLightEnabled,
        submersibleLightIntensity:
          options.submersibleLightIntensity ?? this._submersibleLightIntensity,
        bathymetricReliefBoost:
          options.bathymetricReliefBoost ?? this._bathymetricReliefBoost,
      },
    );
    const waterlineMeniscus = evaluateWaterlineMeniscusAndWetness(
      alt,
      options.waveElevationMeters ?? 0.0,
      options.timeSinceEmergenceSeconds ??
        this._timeSinceEmergenceSeconds ??
        10.0,
      options.screenY ?? 0.5,
    );
    const polarSeaIce = evaluatePolarSeaIceAndGlacialOptics(
      options.latitudeRadians ?? 0.0,
      options.solarDeclinationRadians ?? 0.0,
      options.shoreSdf ?? 0.8,
    );

    return {
      regime,
      altitudeMeters: alt,
      qualityPreset: this._qualityPreset,
      regionOverride,
      underwaterProfile,
      waterlineMeniscus,
      polarSeaIce,
    };
  }

  /**
   * Evaluates up to 64 batched buoyancy query slots using 2 fixed-point
   * Gerstner horizontal displacement inversions and the analytical Lord Kelvin
   * 19.47 deg V-wake pattern.
   *
   * @param {Array<{x: number, y: number}>} queries Local horizontal query coordinates in metres.
   * @param {object} [vesselState] Optional vessel/seaplane position and velocity.
   * @param {object} [waveParams] Optional wave amplitude, wavelength, direction, and time.
   * @returns {Array<object>} Buoyancy elevation, normal, velocity, and Kelvin wake state per slot.
   * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy. Not yet consumed by any renderer.
   */
  queryBuoyancyAndKelvinWake(queries, vesselState = {}, waveParams = {}) {
    return evaluateKelvinWakeAndBuoyancyQuery(queries, vesselState, waveParams);
  }

  /**
   * Evaluates 3-component Case-2 bio-optical IOPs (CDOM tannins, Chlorophyll-a,
   * mineral SPM / glacial rock flour, hypersaline brine Fresnel) and JONSWAP
   * fetch-limited wave spectrum parameters for a hydrological biome.
   *
   * @param {string} [waterType=WaterType.OCEAN] Canonical {@link WaterType} identifier.
   * @param {object} [overrides] Optional bio-optical and wave-fetch overrides.
   * @returns {object} Resolved bio-optical IOP and fetch-limited wave spectrum.
   * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy. Not yet consumed by any renderer.
   */
  evaluateBiomeOptics(waterType = WaterType.OCEAN, overrides = {}) {
    let regionOverride;
    if (
      defined(this._regions) &&
      this._regions.length > 0 &&
      Number.isFinite(overrides.longitudeRadians) &&
      Number.isFinite(overrides.latitudeRadians)
    ) {
      regionOverride = this._regions.evaluateAtCartographic(
        overrides.longitudeRadians,
        overrides.latitudeRadians,
      );
    }
    const effectiveWaterType =
      waterType === WaterType.OCEAN && defined(regionOverride?.waterType)
        ? regionOverride.waterType
        : waterType;
    const tagMap = {
      [WaterType.SWAMP]: { wetland: "swamp" },
      [WaterType.WETLAND]: { natural: "wetland" },
      [WaterType.BLACKWATER_RIVER]: { water: "blackwater" },
      [WaterType.RIVER_LINE]: { waterway: "river" },
      [WaterType.RIVER_AREA]: { water: "river" },
      [WaterType.ESTUARY]: { water: "estuary" },
      [WaterType.HYPERSALINE_LAKE]: { water: "salt_lake" },
      [WaterType.ANCIENT_RIFT_LAKE]: { water: "rift_lake" },
      [WaterType.DEEP_GLACIAL_LAKE]: { water: "glacial_lake" },
      [WaterType.LAKE]: { water: "lake" },
      [WaterType.SEA]: { water: "sea" },
      [WaterType.OCEAN]: {},
    };
    const preset = OsmWaterTypeAdapter.classifyTags(
      tagMap[effectiveWaterType] ?? tagMap[WaterType.OCEAN],
    );
    const hasBioOverride =
      overrides.cdomConcentration !== undefined ||
      overrides.chlorophyllConcentration !== undefined ||
      overrides.mineralSpmConcentration !== undefined ||
      overrides.glacialRockFlourFraction !== undefined ||
      overrides.salinityPermil !== undefined ||
      overrides.stagnantMarginFactor !== undefined;
    const bioOpticalIOP = hasBioOverride
      ? evaluateCase2BioOpticalIOP({
          cdomConcentration: overrides.cdomConcentration,
          chlorophyllConcentration: overrides.chlorophyllConcentration,
          mineralSpmConcentration: overrides.mineralSpmConcentration,
          glacialRockFlourFraction: overrides.glacialRockFlourFraction,
          salinityPermil: overrides.salinityPermil,
          stagnantMarginFactor: overrides.stagnantMarginFactor,
        })
      : preset.bioOpticalIOP;
    const waveSpectrum = evaluateFetchLimitedWaveSpectrum({
      fetchMeters: overrides.fetchMeters ?? preset.fetchMeters,
      windSpeedMetersPerSecond: overrides.windSpeedMetersPerSecond ?? 8.0,
      waterDepthMeters:
        overrides.waterDepthMeters ??
        (preset.waterType === WaterType.OCEAN ? 2000.0 : 40.0),
      vegetationCanopyDamping:
        overrides.vegetationCanopyDamping ??
        (preset.waterType === WaterType.SWAMP ? 0.85 : 0.0),
      salinityPermil: overrides.salinityPermil ?? 35.0,
      flowSpeedMetersPerSecond: overrides.flowSpeedMetersPerSecond ?? 0.0,
      riverBedSlope: overrides.riverBedSlope ?? 0.0,
      timeSeconds: overrides.timeSeconds ?? 0.0,
    });
    return {
      waterType: preset.waterType,
      jerlovType: regionOverride?.jerlovType ?? preset.jerlovType,
      waveAmplitudeScale:
        regionOverride?.waveAmplitudeScale ?? preset.waveAmplitudeScale,
      regionOverride,
      bioOpticalIOP,
      waveSpectrum,
    };
  }
}

export default GlobeWater;
