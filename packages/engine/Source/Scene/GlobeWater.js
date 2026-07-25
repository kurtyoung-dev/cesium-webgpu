import defined from "../Core/defined.js";
import GlobeWaterOcean from "./GlobeWaterOcean.js";

/**
 * GlobeWater — canonical facade (Phase 0.3).
 *
 * Accessed as `scene.globe.water`. Like {@link AtmosphericConditions}, this
 * class is a **facade**: its getters/setters read and write through to the
 * existing `Globe` fields (`showWaterEffect`, `oceanNormalMapUrl`, and the
 * enhanced-ocean tunables). No data migration, no behavior change — legacy
 * code paths remain untouched and authoritative.
 *
 * Why `scene.globe.water` and not `scene.water`?
 *  1. Every existing water property already lives on {@link Globe}.
 *  2. Water is rendered as part of the terrain pass via the water mask, so
 *     it conceptually belongs to the globe.
 *  3. It pairs symmetrically with `scene.globe.atmosphericConditions`.
 *
 * Future Phase 1+ water features (classification provider, flow maps,
 * caustics, refraction, underwater fog, water regions, debug toggles) will
 * be added as new sub-facades on this class. See
 * `migration_doc/WATER_RENDERING_DESIGN.md §5 Toggle Inventory` for the
 * planned surface.
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
  }

  /**
   * Opt-in FFT spectral ocean sub-facade (Campaign 6/7, C6-FFT-OCEAN).
   * `scene.globe.water.ocean.enabled = true` creates and adds an
   * {@link OceanSurfacePrimitive}; default off and byte-identical when off.
   * WebGPU-only (documented no-op on WebGL).
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
   * The sea-level vertical datum the FFT ocean surface anchors to — one of
   * {@link VerticalDatum} (`"AUTO"` | `"ELLIPSOID"` | `"GEOID"`). Delegates to
   * `scene.globe.water.ocean.verticalDatum`.
   *
   * Ruling T2 (`TIDES_FEASIBILITY_2026-07-24.md` §5a). `AUTO` derives the
   * datum from the globe's terrain provider. This is **default-on correctness
   * work**: the ellipsoid-0 anchor was a measured 101.64 m above Cesium World
   * Terrain's baked sea at the Sri Lanka coast.
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
   * Multiplier on the tide term; 1.0 is true scale (ruling T3). Delegates to
   * `scene.globe.water.ocean.tideExaggeration`. Above 1.0 is explicitly
   * stylised — the underlying equilibrium tide is ±0.3 m with no basin
   * amplification and no phase lag, not a prediction.
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
   * This is the hook reserved by `WATER_RENDERING_DESIGN.md` §5 / OQ5. Its
   * documented default was "null → 0"; ruling T1 replaced that default with
   * the in-engine equilibrium {@link TideModel}, so `null` now means "use the
   * engine's tide" and `tideEnabled = false` means "no tide at all".
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
}

export default GlobeWater;
