import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
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
 */
function GlobeWaterOcean(scene) {
  this._scene = scene;
  this._primitive = undefined;
  this._enabled = false;
  // Cached tunables applied to the primitive when (re)created / live.
  this._windSpeed = 12.0;
  this._windDirection = 0.0;
  this._amplitude = 4.0;
  this._choppiness = 1.0;
  this._deepColor = new Color(0.02, 0.08, 0.13, 1.0);
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
        });
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
});

export default GlobeWaterOcean;
