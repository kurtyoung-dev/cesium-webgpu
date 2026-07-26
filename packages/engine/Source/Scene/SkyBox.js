import buildModuleUrl from "../Core/buildModuleUrl.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import CubeMapPanorama from "./CubeMapPanorama.js";
import SceneMode from "./SceneMode.js";
import StarField from "./StarField.js";
import destroyObject from "../Core/destroyObject.js";

/**
 * A sky box around the scene to draw stars.  The sky box is defined using the True Equator Mean Equinox (TEME) axes.
 * <p>
 * This is only supported in 3D.  The sky box is faded out when morphing to 2D or Columbus view.  The size of
 * the sky box must not exceed {@link Scene#maximumCubeMapSize}.
 * </p>
 *
 * @alias SkyBox
 *
 * @param {object} options Object with the following properties:
 * @param {object} [options.sources] The source URL or <code>Image</code> object for each of the six cube map faces.  See the example below.
 * @param {boolean} [options.show=true] Determines if this primitive will be shown.
 *
 *
 * @example
 * scene.skyBox = new Cesium.SkyBox({
 *   sources : {
 *     positiveX : 'skybox_px.png',
 *     negativeX : 'skybox_nx.png',
 *     positiveY : 'skybox_py.png',
 *     negativeY : 'skybox_ny.png',
 *     positiveZ : 'skybox_pz.png',
 *     negativeZ : 'skybox_nz.png'
 *   }
 * });
 *
 * @see Scene#skyBox
 * @see Transforms.computeTemeToPseudoFixedMatrix
 */
class SkyBox {
  constructor(options) {
    this._sources = options.sources;

    this._show = options.show ?? true;
    this._panorama = new CubeMapPanorama({
      sources: this._sources,
      show: this._show,
      returnCommand: true,
      isStarMap: true,
    });

    // Track V-C (NEW-STARS-BRIGHT-CATALOG) — real bright-star catalog
    // starfield. Backend-agnostic; renders additively on BOTH backends:
    // WebGPU through its STAR_FIELD feature renderer, WebGL through the
    // lazy-loaded twin registered in Context.js (STAR_FIELD loader,
    // Batch 324). Defaults ON to AUGMENT the cubemap (both render — the
    // catalog stars sit on top of the cubemap stars; their >1.0 output
    // feeds bloom only when HDR + bloom are enabled). Opt out via
    // `skyBox.starField.show = false`.
    this._starField = new StarField({
      show: options.showStarCatalog ?? true,
    });
  }

  /**
   * The real bright-star catalog starfield (Track V-C). Augments the
   * static star cubemap with points placed at actual RA/Dec on both
   * backends (WebGPU and WebGL). Toggle with `starField.show`.
   * @type {StarField}
   * @readonly
   */
  get starField() {
    return this._starField;
  }

  /**
   * Gets or sets the the primitive object.
   * @type {object}
   */
  get sources() {
    return this._panorama.sources;
  }

  set sources(value) {
    this._panorama.sources = value;
  }

  /**
   * Determines if the sky box will be shown.
   * @type {boolean}
   * @default true
   */
  get show() {
    return this._panorama.show;
  }

  set show(value) {
    this._panorama.show = value;
  }

  /**
   * Called when {@link Viewer} or {@link CesiumWidget} render the scene to
   * get the draw commands needed to render this primitive.
   * <p>
   * Do not call this function directly.  This is documented just to
   * list the exceptions that may be propagated when the scene is rendered:
   * </p>
   *
   * @exception {DeveloperError} this.sources is required and must have positiveX, negativeX, positiveY, negativeY, positiveZ, and negativeZ properties.
   * @exception {DeveloperError} this.sources properties must all be the same type.
   */
  update(frameState, useHdr) {
    const { mode, passes } = frameState;

    if (mode !== SceneMode.SCENE3D && mode !== SceneMode.MORPHING) {
      return;
    }

    if (!passes.render) {
      return;
    }

    // Delegate completely. The bright-star catalog starfield (Track V-C)
    // is driven separately by Scene.updateEnvironment via
    // `skyBox.starField.update(...)` so its command can be injected AFTER
    // this cubemap command (it augments — draws on top of — the cubemap).
    return this._panorama.update(frameState, useHdr);
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * <br /><br />
   * If this object was destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   *
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   *
   * @see SkyBox#destroy
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
   * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
   * <br /><br />
   * Once an object is destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
   * assign the return value (<code>undefined</code>) to the object as done in the example.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   *
   * @example
   * skyBox = skyBox && skyBox.destroy();
   *
   * @see SkyBox#isDestroyed
   */
  destroy() {
    this._panorama = this._panorama && this._panorama.destroy();
    this._starField = this._starField && this._starField.destroy();
    return destroyObject(this);
  }

  /**
   * Creates a skybox instance with the default starmap for the Earth.
   *
   * @param {string} [variant] One of {@link SkyBox.Variant}. Defaults to
   *        {@link SkyBox.defaultVariant}, which applications may set globally.
   * @return {SkyBox} The default skybox for the Earth
   *
   * @example
   * viewer.scene.skyBox = Cesium.SkyBox.createEarthSkyBox();
   *
   * @example
   * // Pick a specific star map for one skybox.
   * viewer.scene.skyBox = Cesium.SkyBox.createEarthSkyBox(
   *   Cesium.SkyBox.Variant.TYCHO_T5,
   * );
   *
   * @example
   * // Or change the default for every skybox created afterwards.
   * Cesium.SkyBox.defaultVariant = Cesium.SkyBox.Variant.TYCHO_T5;
   */
  static createEarthSkyBox(variant) {
    const v = variant ?? SkyBox.defaultVariant;
    const descriptor = skyBoxVariants[v];
    //>>includeStart('debug', pragmas.debug);
    if (!defined(descriptor)) {
      throw new DeveloperError(
        `Unknown SkyBox variant "${v}". Valid values are: ${Object.keys(skyBoxVariants).join(", ")}`,
      );
    }
    //>>includeEnd('debug');
    const resolved = descriptor ?? skyBoxVariants[SkyBox.Variant.TYCHO_T3];
    return new SkyBox({
      sources: {
        positiveX: resolved.url("px"),
        negativeX: resolved.url("mx"),
        positiveY: resolved.url("py"),
        negativeY: resolved.url("my"),
        positiveZ: resolved.url("pz"),
        negativeZ: resolved.url("mz"),
      },
    });
  }
}

/**
 * Selectable star-map variants for {@link SkyBox.createEarthSkyBox}.
 *
 * Each entry names a bundled cube-map set. Enumerated rather than raw strings
 * so a typo fails loudly in debug builds instead of silently 404-ing the sky.
 *
 * `TYCHO_T3` and `TYCHO_T5` are the faint and bright renders of the same NASA
 * SVS product (SVS 3572): SVS describes t3 as "the Milky Way is very faint" and
 * t5 as "the Milky Way is very bright and bright stars are large".
 *
 * @enum {string}
 * @readonly
 */
SkyBox.Variant = Object.freeze({
  /** Tycho catalogue skymap, faint Milky Way render. The historical default
   * (superseded as default by `TYCHO_T5` in C12-10); still bundled offline. */
  TYCHO_T3: "TYCHO_T3",
  /**
   * Tycho catalogue skymap, bright Milky Way render — the default (see
   * {@link SkyBox.defaultVariant}).
   *
   * Bundled at 2048/face (`tycho2t5_80_*.jpg`) alongside the historical `t3`
   * faces; both are offline, no network fetch. Baked from the SVS 3572
   * `TychoSkymapII.t5_16384x08192` equirectangular by the reproducible pipeline
   * at `Tools/skybox-bake/` (SMPTE gamma-1.8 → sRGB corrected). The asset's
   * terms are stated in `LICENSE.md` → Bundled Engine Assets (cleared for this
   * project's scope per `migration_doc/QUEUE_2026-07-19_CAMPAIGN12.md` §6f).
   */
  TYCHO_T5: "TYCHO_T5",
});

const skyBoxVariants = {
  [SkyBox.Variant.TYCHO_T3]: {
    prefix: "tycho2t3_80",
    url(suffix) {
      return buildModuleUrl(
        `Assets/Textures/SkyBox/${this.prefix}_${suffix}.jpg`,
      );
    },
  },
  [SkyBox.Variant.TYCHO_T5]: {
    prefix: "tycho2t5_80",
    url(suffix) {
      return buildModuleUrl(
        `Assets/Textures/SkyBox/${this.prefix}_${suffix}.jpg`,
      );
    },
  },
};

/**
 * The variant {@link SkyBox.createEarthSkyBox} uses when none is passed.
 *
 * `TYCHO_T5` — the bright Milky Way render — is the default as of `C12-10`
 * (Campaign 12): its faces are now bundled in the repository (see
 * {@link SkyBox.Variant.TYCHO_T5}). `TYCHO_T3` remains bundled and selectable
 * for applications that prefer the historical faint render; both are offline.
 *
 * @type {string}
 * @default SkyBox.Variant.TYCHO_T5
 */
SkyBox.defaultVariant = SkyBox.Variant.TYCHO_T5;

export default SkyBox;
