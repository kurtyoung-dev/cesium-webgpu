import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import GeoidUndulationGrid from "../Core/GeoidUndulationGrid.js";
import VerticalDatum from "../Core/VerticalDatum.js";
import {
  CELESTIAL_DEFAULT_MOON_INTENSITY,
  CELESTIAL_DEFAULT_ROUGHNESS,
  CELESTIAL_DEFAULT_SUN_INTENSITY,
} from "./CelestialWaterReflection.js";
import OceanSurfacePrimitive, {
  cloneSimulationEpoch,
} from "./OceanSurfacePrimitive.js";

/**
 * The opt-in FFT spectral ocean sub-facade, accessed as
 * <code>scene.globe.water.ocean</code>.
 *
 * Off by default, and inert while off: no {@link OceanSurfacePrimitive} is
 * created, so no GPU resources are allocated and no compute passes run, until
 * <code>enabled</code> is set to <code>true</code>, at which point a single
 * ocean primitive is created and added to <code>scene.primitives</code>.
 * Setting <code>enabled = false</code> removes and destroys it. WebGPU only —
 * on WebGL the primitive renders nothing.
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
  // Vertical datum and tide.
  this._verticalDatum = VerticalDatum.AUTO;
  this._tideEnabled = true;
  this._tideExaggeration = 1.0;
  this._tideCallback = undefined;
  // Celestial reflection. Off by default: while it is off the shader draws
  // the highlight it always drew and the uniform tail stays zeroed.
  this._celestialReflection = false;
  this._celestialRoughness = CELESTIAL_DEFAULT_ROUGHNESS;
  this._celestialSunIntensity = CELESTIAL_DEFAULT_SUN_INTENSITY;
  this._celestialMoonIntensity = CELESTIAL_DEFAULT_MOON_INTENSITY;
  this._simulationEpoch = undefined;
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
          celestialReflection: this._celestialReflection,
          celestialRoughness: this._celestialRoughness,
          celestialSunIntensity: this._celestialSunIntensity,
          celestialMoonIntensity: this._celestialMoonIntensity,
          simulationEpoch: this._simulationEpoch,
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
   * Multiplier on the tide term, following the precedent of
   * {@link Scene#verticalExaggeration}. <code>1.0</code> is true scale, and the
   * true equilibrium tide is only ±0.3 m, which is sub-pixel from orbit and
   * reads as a slow waterline creep in a shoreline framing. Values above 1 are
   * stylised rather than predictive: the underlying model is an equilibrium
   * tide with no basin amplification and no phase lag.
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
   * Leaving it undefined uses the in-engine equilibrium model rather than
   * suppressing the tide.
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
   * WebGPU only, like the surface it configures: the FFT ocean's update
   * returns immediately on a WebGL context, so this switch has no WebGL
   * counterpart. The globe's own water-mask ocean carries the feature on both
   * backends under {@link GlobeWater#celestialReflection}.
   *
   * Whether the water reflects the sky's light sources through a microfacet
   * lobe instead of the historical Blinn-Phong highlight. Default `false`.
   *
   * The switch is a uniform value, not a shader define, because the same lobe
   * serves the night-side terms and both have to turn on without a
   * recompile. While it is `false` the uniform tail the feature occupies is
   * written as exact zeros — the value it carried before the feature existed
   * — and the shader takes its historical branch, so the default look is
   * unchanged.
   *
   * @memberof GlobeWaterOcean.prototype
   * @type {boolean}
   * @default false
   */
  celestialReflection: {
    get: function () {
      return this._celestialReflection;
    },
    set: function (v) {
      this._celestialReflection = v === true;
      if (defined(this._primitive)) {
        this._primitive._celestialReflection = this._celestialReflection;
      }
    },
  },

  /**
   * The instant the wave simulation counts from. Leave it undefined — the
   * default — and the surface adopts the first frame's scene time, so its wave
   * phase begins at zero and advances with the clock from there. That is a
   * phase origin, not a calm: the spectrum is already fully developed at phase
   * zero, so the sea has its waves from the first frame and simply starts
   * evolving from a repeatable point rather than from an arbitrary clock
   * offset.
   *
   * <p>
   * Pin it to make the surface reproducible: two viewers showing the same
   * scene time with the same epoch show the same sea, whatever either one has
   * rendered before. That is what a capture needs, and it is the honest form
   * of frame-locking — the surface is frozen because the clock is, not because
   * the renderer was called the same number of times.
   * </p>
   *
   * @memberof GlobeWaterOcean.prototype
   * @type {JulianDate|undefined}
   * @default undefined
   */
  simulationEpoch: {
    get: function () {
      return this._simulationEpoch;
    },
    set: function (v) {
      // Copied, not kept: the two instants a caller is most likely to pin to —
      // `viewer.clock.currentTime` and `frameState.time` — are both rewritten
      // in place by the engine, and holding either reference would make the
      // epoch chase the clock and freeze the sea.
      this._simulationEpoch = cloneSimulationEpoch(v);
      if (defined(this._primitive)) {
        this._primitive._simulationEpoch = cloneSimulationEpoch(v);
      }
    },
  },

  /**
   * Base microfacet roughness of the water at the near patch, clamped to
   * `[0.02, 1]`. Smaller values tighten the glitter path toward a mirror;
   * larger ones spread it. The shader raises this further with distance,
   * where the wave slope stops being resolvable, so this is the near value
   * rather than a whole-surface one. Read only while
   * {@link GlobeWaterOcean#celestialReflection} is `true`.
   *
   * @memberof GlobeWaterOcean.prototype
   * @type {number}
   * @default 0.06
   */
  celestialRoughness: {
    get: function () {
      return this._celestialRoughness;
    },
    set: function (v) {
      this._celestialRoughness = v;
      if (defined(this._primitive)) {
        this._primitive._celestialRoughness = v;
      }
    },
  },

  /**
   * Multiplier on the reflected solar disc, floored at 0. Read only while
   * {@link GlobeWaterOcean#celestialReflection} is `true`.
   *
   * @memberof GlobeWaterOcean.prototype
   * @type {number}
   * @default 1.0
   */
  celestialSunIntensity: {
    get: function () {
      return this._celestialSunIntensity;
    },
    set: function (v) {
      this._celestialSunIntensity = v;
      if (defined(this._primitive)) {
        this._primitive._celestialSunIntensity = v;
      }
    },
  },

  /**
   * Multiplier on the reflected lunar disc, floored at 0 and applied before
   * the Moon's illuminated fraction and the night ramp — so a new Moon and a
   * daylit sea both stay dark whatever this is set to. Read only while
   * {@link GlobeWaterOcean#celestialReflection} is `true`.
   *
   * It is an appearance dial rather than a photometric ratio: the ocean's
   * radiance is not calibrated in physical units, so the true four-millionths
   * of sunlight that full moonlight carries would render as nothing.
   *
   * @memberof GlobeWaterOcean.prototype
   * @type {number}
   * @default 0.35
   */
  celestialMoonIntensity: {
    get: function () {
      return this._celestialMoonIntensity;
    },
    set: function (v) {
      this._celestialMoonIntensity = v;
      if (defined(this._primitive)) {
        this._primitive._celestialMoonIntensity = v;
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
