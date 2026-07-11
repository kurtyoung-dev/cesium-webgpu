import Color from "../Core/Color.js";
import Frozen from "../Core/Frozen.js";
import Resource from "../Core/Resource.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";

const TWO_PI = 2.0 * Math.PI;

// Deterministic PRNG (mulberry32) so the seeded initial particle field — and
// therefore probe captures at a fixed frame — are reproducible across runs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A GPU flow-field wind-particle layer (Campaign 6, C6-FLOWFIELD-WIND):
 * Windy / earth.nullschool-class wind visualization. N particles are advected
 * each frame by a velocity field (an RGBA8 image where R encodes the eastward
 * component and G the northward component, normalized against sidecar
 * min/max), then drawn as anti-aliased dots at their geographic positions on
 * the globe.
 *
 * <h4>Opt-in, default-off</h4>
 *
 * The layer allocates NO GPU resources until it is added to
 * {@link Scene#primitives}, its {@link FlowFieldWindLayer#show} is
 * <code>true</code>, and its velocity source has finished loading. Removing
 * the layer (or setting <code>show = false</code>, or calling
 * {@link FlowFieldWindLayer#destroy}) frees everything — a scene without a
 * flow-field layer is byte-identical to one before this feature existed.
 *
 * <h4>Backend support</h4>
 *
 * The particle advection + rendering is a WebGPU compute + instanced-draw
 * pipeline (a WebGPU-exceeds feature — there is no WebGL parity requirement).
 * On a WebGL context no flow-field feature renderer is registered, so the
 * layer renders nothing (documented no-op) and never allocates resources.
 *
 * <h4>Data</h4>
 *
 * The bundled sample (<code>Apps/SampleData/wind/gfs-wind-sample.png</code> +
 * <code>.json</code>) is 10 m GFS wind (NOAA/NCEP, US-Government public
 * domain). Any image in the same mapbox/webgl-wind RGBA layout works — pass
 * your own <code>url</code> + <code>metadata</code>. Live ingest (NWS-MDL EDR
 * CoverageJSON) and ocean currents (RTOFS/OSCAR) are tracked follow-ups
 * (see migration_doc/DEFERRED_WORK.md, NEW-FLOWFIELD-*).
 *
 * @alias FlowFieldWindLayer
 *
 * @param {object} options Object with the following properties:
 * @param {string} [options.url] URL of the velocity RGBA image (R = u, G = v).
 *        Required unless <code>image</code> is supplied.
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} [options.image] A
 *        pre-decoded velocity image (alternative to <code>url</code>).
 * @param {object} [options.metadata] Sidecar describing the velocity encoding:
 *        <code>{ width, height, uMin, uMax, vMin, vMax }</code>. When omitted
 *        and a <code>url</code> is given, the sidecar is fetched from the
 *        <code>url</code> with its extension replaced by <code>.json</code>.
 *        Required when <code>image</code> is supplied.
 * @param {number} [options.particleCount=65536] Number of particles.
 * @param {number} [options.speedScale=0.0002] Radians of longitude advanced
 *        per (m/s) per frame at the equator — the master motion-speed dial.
 * @param {number} [options.lifetime=120] Frames a particle lives before a
 *        forced respawn (keeps the field from collapsing into attractors).
 * @param {number} [options.dropRate=0.003] Per-frame probability a particle
 *        respawns at a fresh random position.
 * @param {number} [options.maxSpeed=40] Wind speed (m/s) mapped to the fast
 *        end of the color ramp.
 * @param {number} [options.heightOffset=15000] Meters above the ellipsoid the
 *        particles are lifted so they read above the globe surface.
 * @param {number} [options.pixelSize=2.5] Dot diameter in pixels.
 * @param {number} [options.alpha=0.9] Overall particle opacity.
 * @param {Color} [options.colorSlow=Color(0.1,0.35,1.0)] Color for slow winds.
 * @param {Color} [options.colorFast=Color.WHITE] Color for fast winds.
 * @param {boolean} [options.show=true] Whether the layer is displayed.
 * @param {number} [options.seed=1] Seed for the deterministic initial field.
 *
 * @example
 * const wind = scene.primitives.add(
 *   new Cesium.FlowFieldWindLayer({
 *     url: "SampleData/wind/gfs-wind-sample.png",
 *   }),
 * );
 */
class FlowFieldWindLayer {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    if (!defined(options.url) && !defined(options.image)) {
      throw new DeveloperError(
        "FlowFieldWindLayer requires options.url or options.image.",
      );
    }
    if (defined(options.image) && !defined(options.metadata)) {
      throw new DeveloperError(
        "FlowFieldWindLayer requires options.metadata when options.image is supplied.",
      );
    }

    /**
     * Whether the layer is displayed. Toggling to <code>false</code> stops the
     * advection dispatch and the draw; GPU resources are retained for an
     * instant re-enable and freed on {@link FlowFieldWindLayer#destroy}.
     * @type {boolean}
     * @default true
     */
    this.show = options.show ?? true;

    // ── Simulation / appearance dials (read by the feature renderer each
    // frame, so they can be tuned live). Underscore-prefixed = renderer ABI.
    this._particleCount = options.particleCount ?? 65536;
    this._speedScale = options.speedScale ?? 0.0002;
    this._lifetime = options.lifetime ?? 120;
    this._dropRate = options.dropRate ?? 0.003;
    this._maxSpeed = options.maxSpeed ?? 40;
    this._heightOffset = options.heightOffset ?? 15000;
    this._pixelSize = options.pixelSize ?? 2.5;
    this._alpha = options.alpha ?? 0.9;
    this._colorSlow = Color.clone(
      options.colorSlow ?? new Color(0.1, 0.35, 1.0, 1.0),
    );
    this._colorFast = Color.clone(options.colorFast ?? Color.WHITE);
    this._seed = options.seed ?? 1;

    // ── Velocity field state (populated by the async load). ──
    this._velocityImage = options.image;
    this._velocityWidth = 0;
    this._velocityHeight = 0;
    this._velocityReady = false;
    this._velocityVersion = 0;
    this._uMin = -1;
    this._uMax = 1;
    this._vMin = -1;
    this._vMax = 1;

    // Deterministic initial particle state (seeded), built once.
    this._initialState = this._buildInitialState();

    this._featureRenderer = undefined;
    this._webgpuCache = undefined;
    this._loadError = undefined;

    if (defined(options.metadata)) {
      this._applyMetadata(options.metadata);
    }
    if (defined(options.image) && defined(options.metadata)) {
      // Pre-decoded image path: ready immediately.
      this._velocityReady = true;
      this._velocityVersion++;
    } else if (defined(options.url)) {
      this._load(options.url, options.metadata);
    }
  }

  /**
   * Number of particles. Immutable after construction.
   * @type {number}
   * @readonly
   */
  get particleCount() {
    return this._particleCount;
  }

  /**
   * True once the velocity field has finished loading and the layer is ready
   * to render.
   * @type {boolean}
   * @readonly
   */
  get ready() {
    return this._velocityReady === true;
  }

  _applyMetadata(meta) {
    this._velocityWidth = meta.width ?? this._velocityWidth;
    this._velocityHeight = meta.height ?? this._velocityHeight;
    this._uMin = meta.uMin ?? this._uMin;
    this._uMax = meta.uMax ?? this._uMax;
    this._vMin = meta.vMin ?? this._vMin;
    this._vMax = meta.vMax ?? this._vMax;
  }

  _buildInitialState() {
    const count = this._particleCount;
    const data = new Float32Array(count * 4);
    const rand = mulberry32(this._seed >>> 0);
    const lifetime = this._lifetime;
    for (let i = 0; i < count; i++) {
      const lon = rand() * TWO_PI;
      // Area-uniform latitude so particles don't clump at the poles.
      const lat = Math.asin(Math.min(1, Math.max(-1, rand() * 2 - 1)));
      const age = rand() * lifetime; // staggered so respawns spread out
      const o = i * 4;
      data[o] = lon;
      data[o + 1] = lat;
      data[o + 2] = age;
      data[o + 3] = 0;
    }
    return data;
  }

  _load(url, metadata) {
    const self = this;
    const imageResource = new Resource({ url: url });
    imageResource
      .fetchImage({ preferImageBitmap: true })
      .then(function (image) {
        self._velocityImage = image;
        if (
          (!defined(self._velocityWidth) || self._velocityWidth === 0) &&
          defined(image)
        ) {
          self._velocityWidth = image.width;
          self._velocityHeight = image.height;
        }
      })
      .catch(function (e) {
        self._loadError = e;
      });

    if (defined(metadata)) {
      this._applyMetadata(metadata);
      this._maybeReady();
    } else {
      // Sidecar: same URL with the extension swapped to .json.
      const jsonUrl = url.replace(/\.[^./?#]+($|[?#])/, ".json$1");
      new Resource({ url: jsonUrl })
        .fetchJson()
        .then(function (meta) {
          self._applyMetadata(meta);
          self._maybeReady();
        })
        .catch(function (e) {
          self._loadError = e;
        });
    }
  }

  _maybeReady() {
    // Both the image and the metadata (dimensions + min/max) must be present.
    if (
      defined(this._velocityImage) &&
      this._velocityWidth > 0 &&
      this._velocityHeight > 0
    ) {
      this._velocityReady = true;
      this._velocityVersion++;
    }
  }

  /**
   * @private
   */
  update(frameState) {
    if (this.show === false || this._particleCount === 0) {
      return;
    }
    // The image resolves on a separate promise than the metadata; flip ready
    // once both have landed (cheap re-check each frame until ready).
    if (!this._velocityReady) {
      this._maybeReady();
      if (!this._velocityReady) {
        return;
      }
    }

    const context = frameState.context;
    // WebGPU-only: getFeatureRenderer kicks the lazy loader on the first call
    // (returns undefined that frame — the WebGL context never registers one,
    // so the layer is a documented no-op there).
    const fr = context.getFeatureRenderer(FeatureRendererKey.FLOW_FIELD);
    if (fr) {
      fr.update(this, frameState);
      this._featureRenderer = fr;
    }
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * @returns {boolean}
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys the GPU resources held by this layer.
   * @example
   * layer = layer && layer.destroy();
   */
  destroy() {
    if (defined(this._featureRenderer)) {
      this._featureRenderer.destroy(this);
      this._featureRenderer = undefined;
    }
    return destroyObject(this);
  }
}

export default FlowFieldWindLayer;
