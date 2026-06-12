import defined from "../Core/defined.js";

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
