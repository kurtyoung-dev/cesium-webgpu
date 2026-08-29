import defined from "../Core/defined.js";
import GlobeWaterOcean from "./GlobeWaterOcean.js";

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
}

export default GlobeWater;
