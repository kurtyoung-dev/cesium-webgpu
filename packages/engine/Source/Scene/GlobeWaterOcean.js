import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import GeoidUndulationGrid from "../Core/GeoidUndulationGrid.js";
import VerticalDatum from "../Core/VerticalDatum.js";
import OceanSurfacePrimitive from "./OceanSurfacePrimitive.js";

/**
 * GlobeWaterOcean — opt-in FFT spectral ocean sub-facade (Campaign 6/7,
 * C6-FFT-OCEAN). Accessed as `scene.globe.water.ocean`.
 *
 * Default **off** and byte-identical when off: no {@link OceanSurfacePrimitive}
 * is created (and therefore no GPU resources are allocated and no compute passes
 * run) until `enabled` is set to `true`, at which point a single ocean primitive
 * is created and added to `scene.primitives`. Setting `enabled = false` removes
 * and destroys it. WebGPU-only — on WebGL the primitive renders nothing
 * (documented no-op, Principle 2/10).
 *
 * @alias GlobeWaterOcean
 * @constructor
 *
 * @param {Scene} scene The owning Scene (source of `scene.primitives`).
 * @param {Globe} [globe] The owning Globe. Read only for its
 *   `terrainProvider`, to derive the sea-level vertical datum under
 *   {@link VerticalDatum.AUTO}.
 */
function GlobeWaterOcean(scene, globe) {
  this._scene = scene;
  this._globe = globe;
  this._primitive = undefined;
  this._enabled = false;
  // Cached tunables applied to the primitive when (re)created / live.
  this._windSpeed = 12.0;
  this._windDirection = 0.0;
  this._amplitude = 4.0;
  this._choppiness = 1.0;
  this._deepColor = new Color(0.02, 0.08, 0.13, 1.0);
  // Vertical datum + tide (C6-FFT-OCEAN-TIDE-DATUM).
  this._verticalDatum = VerticalDatum.AUTO;
  this._tideEnabled = true;
  this._tideExaggeration = 1.0;
  this._tideCallback = undefined;
}

/**
 * Start the bundled geoid grid's fetch unless the datum is pinned to the
 * ellipsoid. Called on enable and on a datum change so the ~508 KiB asset is
 * usually resident before the first frame that needs it.
 *
 * `allowRetry = true` is deliberate: the loader latches a failure so the
 * per-frame path cannot re-fetch every frame, but a single transient network
 * error must not re-introduce the ~100 m datum defect for the page lifetime.
 * These two call sites are explicit USER actions, so one bounded retry each is
 * the right budget — and every failed attempt still logs.
 *
 * @param {GlobeWaterOcean} that The facade.
 * @private
 */
function prefetchGeoid(that) {
  if (that._verticalDatum !== VerticalDatum.ELLIPSOID) {
    GeoidUndulationGrid.loadEgm2008Async(true);
  }
}

Object.defineProperties(GlobeWaterOcean.prototype, {
  /**
   * Enables or disables the FFT ocean surface. Default `false`. Enabling
   * lazily creates one {@link OceanSurfacePrimitive} and adds it to
   * `scene.primitives`; disabling removes and destroys it. Off is byte-
   * identical (nothing is allocated).
   * @memberof GlobeWaterOcean.prototype
   * @type {boolean}
   */
  enabled: {
    get: function () {
      return this._enabled;
    },
    set: function (value) {
      value = value === true;
      if (value === this._enabled) {
        return;
      }
      this._enabled = value;
      if (value) {
        this._primitive = new OceanSurfacePrimitive({
          windSpeed: this._windSpeed,
          windDirection: this._windDirection,
          amplitude: this._amplitude,
          choppiness: this._choppiness,
          deepColor: this._deepColor,
          verticalDatum: this._verticalDatum,
          tideEnabled: this._tideEnabled,
          tideExaggeration: this._tideExaggeration,
          tideCallback: this._tideCallback,
          globe: this._globe ?? this._scene?.globe,
        });
        prefetchGeoid(this);
        this._scene.primitives.add(this._primitive);
      } else if (defined(this._primitive)) {
        this._scene.primitives.remove(this._primitive); // remove() destroys it
        this._primitive = undefined;
      }
    },
  },

  /**
   * The managed ocean primitive, or `undefined` when disabled.
   * @memberof GlobeWaterOcean.prototype
   * @type {OceanSurfacePrimitive|undefined}
   * @readonly
   */
  primitive: {
    get: function () {
      return this._primitive;
    },
  },

  /**
   * Wind speed U (m/s) controlling sea maturity. Applied on enable.
   * @memberof GlobeWaterOcean.prototype
   * @type {number}
   */
  windSpeed: {
    get: function () {
      return this._windSpeed;
    },
    set: function (v) {
      this._windSpeed = v;
      if (defined(this._primitive)) {
        this._primitive._windSpeed = v;
        this._primitive._paramsDirty = true;
      }
    },
  },

  /**
   * The sea-level vertical datum the patch anchors to — one of
   * {@link VerticalDatum} (`"AUTO"`, `"ELLIPSOID"`, `"GEOID"`). Default
   * `AUTO`, which derives the datum from the globe's terrain provider:
   * {@link EllipsoidTerrainProvider} gives `ELLIPSOID`, everything else gives
   * `GEOID` (see {@link VerticalDatum} for the full table and its evidence).
   *
   * This is **default-on correctness work, not a feature toggle**: anchoring at
   * ellipsoidal 0 over orthometric terrain put the patch a measured 101.64 m
   * above Cesium World Terrain's baked sea at the Sri Lanka coast. Pin
   * `ELLIPSOID` to restore the pre-fix anchor.
   *
   * @memberof GlobeWaterOcean.prototype
   * @type {string}
   * @default VerticalDatum.AUTO
   */
  verticalDatum: {
    get: function () {
      return this._verticalDatum;
    },
    set: function (v) {
      this._verticalDatum = v;
      if (defined(this._primitive)) {
        this._primitive._verticalDatum = v;
      }
      prefetchGeoid(this);
    },
  },

  /**
   * Whether the tide term is added to the sea-level anchor. When `false` the
   * tide contribution is exactly 0 (not "small"), so the anchor carries the
   * datum term alone.
   *
   * @memberof GlobeWaterOcean.prototype
   * @type {boolean}
   * @default true
   */
  tideEnabled: {
    get: function () {
      return this._tideEnabled;
    },
    set: function (v) {
      this._tideEnabled = v === true;
      if (defined(this._primitive)) {
        this._primitive._tideEnabled = this._tideEnabled;
      }
    },
  },

  /**
   * Multiplier on the tide term (ruling T3, precedent
   * {@link Scene#verticalExaggeration}). `1.0` is TRUE SCALE — and the true
   * equilibrium tide is only ±0.3 m, which is sub-pixel from orbit and reads
   * as a slow waterline creep at a shoreline framing. Values above 1 are
   * explicitly **stylised, not a prediction**; the underlying model is an
   * equilibrium tide with no basin amplification and no phase lag.
   *
   * @memberof GlobeWaterOcean.prototype
   * @type {number}
   * @default 1.0
   */
  tideExaggeration: {
    get: function () {
      return this._tideExaggeration;
    },
    set: function (v) {
      this._tideExaggeration = v;
      if (defined(this._primitive)) {
        this._primitive._tideExaggeration = v;
      }
    },
  },

  /**
   * Optional application tide source, `(positionWC, time) => metres`,
   * replacing the built-in {@link TideModel}. The returned value still passes
   * through {@link GlobeWaterOcean#tideExaggeration} and is still gated by
   * {@link GlobeWaterOcean#tideEnabled}; a non-finite return is treated as 0.
   *
   * This is the hook reserved by `WATER_RENDERING_DESIGN.md` OQ5. Its default
   * changed from "zero" to "the in-engine equilibrium model" when ruling T1
   * put {@link TideModel} in Core.
   *
   * @memberof GlobeWaterOcean.prototype
   * @type {Function|undefined}
   * @default undefined
   */
  tideCallback: {
    get: function () {
      return this._tideCallback;
    },
    set: function (v) {
      this._tideCallback = v;
      if (defined(this._primitive)) {
        this._primitive._tideCallback = v;
      }
    },
  },

  /**
   * The datum actually in force on the last rendered frame — never `AUTO`.
   * `undefined` until the ocean has rendered once.
   * @memberof GlobeWaterOcean.prototype
   * @type {string|undefined}
   * @readonly
   */
  resolvedVerticalDatum: {
    get: function () {
      return defined(this._primitive)
        ? this._primitive._resolvedVerticalDatum
        : undefined;
    },
  },

  /**
   * Geoid undulation applied at the patch anchor on the last rendered frame,
   * in metres. 0 under the ellipsoid datum, and 0 while the bundled grid is
   * still loading.
   * @memberof GlobeWaterOcean.prototype
   * @type {number|undefined}
   * @readonly
   */
  geoidUndulationMeters: {
    get: function () {
      return defined(this._primitive)
        ? this._primitive._geoidUndulationM
        : undefined;
    },
  },

  /**
   * Tide height applied at the patch anchor on the last rendered frame, in
   * metres, INCLUDING {@link GlobeWaterOcean#tideExaggeration}.
   * @memberof GlobeWaterOcean.prototype
   * @type {number|undefined}
   * @readonly
   */
  tideHeightMeters: {
    get: function () {
      return defined(this._primitive)
        ? this._primitive._tideHeightM
        : undefined;
    },
  },

  /**
   * Total anchor displacement along the local up on the last rendered frame,
   * in metres — the datum and tide terms after the vertical-exaggeration map.
   * @memberof GlobeWaterOcean.prototype
   * @type {number|undefined}
   * @readonly
   */
  anchorHeightMeters: {
    get: function () {
      return defined(this._primitive)
        ? this._primitive._anchorHeightM
        : undefined;
    },
  },
});

export default GlobeWaterOcean;
