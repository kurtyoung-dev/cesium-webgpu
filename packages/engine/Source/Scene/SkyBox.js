import buildModuleUrl from "../Core/buildModuleUrl.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import CubeMapPanorama from "./CubeMapPanorama.js";
import SceneMode from "./SceneMode.js";
import {
  DEFAULT_SKYBOX_RESOLUTION,
  SkyBoxResolution,
  estimateCubeMapVramBytes,
  resolveSkyBoxResolution,
} from "./SkyBoxResolutionPolicy.js";
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

    // C12-14 — which entry of {@link SkyBox.Variant} these sources came from,
    // when the sky box was built by {@link SkyBox.createEarthSkyBox}.
    // `undefined` for a hand-constructed sky box, because arbitrary `sources`
    // cannot be attributed to a variant. Load-bearing for a consumer of
    // {@link SkyBox#starCubeMap}: the default variant carries NO resolved
    // stars (DR-01), so the answer changes what sampling the cube map means.
    this._variant = options.variant;

    // C12-12 — the resolution tier these faces were served at, when the sky box
    // was built by {@link SkyBox.createEarthSkyBox}. `undefined` for a
    // hand-constructed sky box, whose faces can be any size.
    this._resolution = options.resolution;
    this._faceSize = options.faceSize;

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
   * @type {SkyBox.StarField}
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
    // The new faces are not attributable to a `SkyBox.Variant` entry, so stop
    // claiming one rather than reporting a stale answer.
    this._variant = undefined;
    // C12-12 — likewise for the resolution tier: arbitrary faces have no tier
    // and an unknown face size, so the VRAM estimate must stop answering too.
    this._resolution = undefined;
    this._faceSize = undefined;
  }

  /**
   * The {@link SkyBox.Variant} these faces came from, or `undefined` when the
   * sky box was constructed directly from arbitrary `sources` (or its sources
   * were replaced afterwards).
   *
   * Read this alongside {@link SkyBox#starCubeMap}: under the default
   * `TYCHO_T5_DIFFUSE` the cube map carries the diffuse galactic band and NO
   * resolved stars (Campaign-12 decision DR-01 gives those to the
   * {@link StarField} sprite catalogue), so a reflection that samples only the
   * cube map will show the Milky Way and no individual stars.
   *
   * @type {string|undefined}
   * @readonly
   */
  get variant() {
    return this._variant;
  }

  /**
   * C12-12 — the {@link SkyBox.Resolution} tier these faces were served at, or
   * `undefined` for a hand-constructed sky box.
   *
   * This can differ from what was requested: the policy never invents a URL,
   * so asking for a tier that is not bundled for the chosen variant serves the
   * closest bundled one instead. Read {@link SkyBox#estimatedVramBytes} for
   * what the choice actually costs.
   *
   * @type {string|undefined}
   * @readonly
   */
  get resolution() {
    return this._resolution;
  }

  /**
   * C12-12 — edge length in pixels of each of the six faces, or `undefined`
   * for a hand-constructed sky box.
   *
   * @type {number|undefined}
   * @readonly
   */
  get faceSize() {
    return this._faceSize;
  }

  /**
   * C12-12 — video memory the star cube map occupies once decoded:
   * `6 × faceSize² × 4` bytes. `undefined` for a hand-constructed sky box.
   *
   * Both backends upload the faces as `rgba8unorm` with a single mip level, so
   * this is exact rather than an estimate of an unknown format — 96 MiB at the
   * default 2048 tier, 384 MiB at 4096. The JPEG's on-disk size does not enter
   * into it. See `Scene/SkyBoxResolutionPolicy.js` for the loader evidence.
   *
   * @type {number|undefined}
   * @readonly
   */
  get estimatedVramBytes() {
    return defined(this._faceSize)
      ? estimateCubeMapVramBytes(this._faceSize)
      : undefined;
  }

  /**
   * C12-14 — a backend-neutral, SAMPLABLE handle to the star cube map, so code
   * outside the sky box can look the stars up in a shader rather than only
   * seeing them drawn. Refreshed once per frame on both backends; also
   * published as `frameState.starCubeMap`.
   *
   * `available` is false until the six faces finish loading, and the handles
   * are BORROWED — see `Scene/StarCubeMapResource.js` for the frame (TEME),
   * content, availability and ownership rules a consumer must respect.
   *
   * **Nothing samples this yet.** It exists to discharge the "samplable STAR
   * cubemap" blocker recorded against `C11-163` (celestial water reflection);
   * see that module's header before treating it as dead code (Principle 7).
   *
   * @type {object}
   * @readonly
   */
  get starCubeMap() {
    return this._panorama.samplableCubeMap;
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
   * @param {object} [options] C12-12 resolution policy options.
   * @param {string} [options.resolution] One of {@link SkyBox.Resolution}.
   *        Defaults to {@link SkyBox.defaultResolution} (2048/face, 96 MiB).
   *        A tier that is not bundled for the chosen variant resolves DOWN to
   *        the closest bundled one — no URL is ever fabricated.
   * @param {number} [options.maximumCubeMapSize] `scene.maximumCubeMapSize`,
   *        when the caller knows it. Steps the tier down to what the device
   *        can actually allocate.
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
   *
   * @example
   * // Opt into the high-resolution tier where it is bundled (384 MiB of VRAM).
   * viewer.scene.skyBox = Cesium.SkyBox.createEarthSkyBox(undefined, {
   *   resolution: Cesium.SkyBox.Resolution.SIZE_4096,
   *   maximumCubeMapSize: viewer.scene.maximumCubeMapSize,
   * });
   */
  static createEarthSkyBox(variant, options) {
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
    // C12-14 — record which variant these faces are, so a consumer of
    // `skyBox.starCubeMap` can tell whether the map carries resolved stars.
    const resolvedVariant = defined(descriptor) ? v : SkyBox.Variant.TYCHO_T3;

    // C12-12 — pick the resolution tier BEFORE building URLs. The variant is
    // already resolved above, so the policy can never see an unknown variant
    // from this path.
    const requested = options?.resolution;
    const tier = resolveSkyBoxResolution({
      variant: resolvedVariant,
      requested: requested ?? SkyBox.defaultResolution,
      maximumCubeMapSize: options?.maximumCubeMapSize,
    });
    //>>includeStart('debug', pragmas.debug);
    // Only complain when the caller asked for something specific. The default
    // request (2048) legitimately falls back on `TYCHO_T3`, which is bundled at
    // 1024 — warning about that on every default construction would be noise.
    if (defined(requested) && tier.fallback) {
      console.warn(
        `[CesiumJS:SkyBox] Resolution "${tier.requested}" is not bundled for variant "${resolvedVariant}" ` +
          `(available: ${tier.availableResolutions.join(", ")}); serving "${tier.resolution}". Reason: ${tier.reason}.`,
      );
    }
    //>>includeEnd('debug');
    if (tier.exceedsDeviceLimit) {
      console.error(
        `[CesiumJS:SkyBox] Smallest bundled star cube map for "${resolvedVariant}" is ${tier.faceSize}px/face, ` +
          `which exceeds this device's maximumCubeMapSize (${options?.maximumCubeMapSize}). The sky box will fail to load.`,
      );
    }

    const tierSuffix = tier.prefixSuffix;
    return new SkyBox({
      variant: resolvedVariant,
      resolution: tier.resolution,
      faceSize: tier.faceSize,
      sources: {
        positiveX: resolved.url("px", tierSuffix),
        negativeX: resolved.url("mx", tierSuffix),
        positiveY: resolved.url("py", tierSuffix),
        negativeY: resolved.url("my", tierSuffix),
        positiveZ: resolved.url("pz", tierSuffix),
        negativeZ: resolved.url("mz", tierSuffix),
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
   * Tycho catalogue skymap, bright Milky Way render. Was the default from
   * C12-10 until C12-11 (Batch 833) made `TYCHO_T5_DIFFUSE` the default so the
   * cubemap carries diffuse light only and the sprite catalogue owns every
   * resolved star (ruling DR-01). Still bundled offline; select it explicitly
   * to get baked stars back in the cubemap.
   *
   * Bundled at 2048/face (`tycho2t5_80_*.jpg`) alongside the historical `t3`
   * faces; both are offline, no network fetch. Baked from the SVS 3572
   * `TychoSkymapII.t5_16384x08192` equirectangular by the reproducible pipeline
   * at `Tools/skybox-bake/` (SMPTE gamma-1.8 → sRGB corrected). The asset's
   * terms are stated in `LICENSE.md` → Bundled Engine Assets (cleared for this
   * project's scope per `migration_doc/QUEUE_2026-07-19_CAMPAIGN12.md` §6f).
   */
  TYCHO_T5: "TYCHO_T5",
  /**
   * Tycho catalogue skymap, **diffuse Milky Way light only** — the default
   * (see {@link SkyBox.defaultVariant}).
   *
   * This is the Campaign-12 DR-01 seam: the cube map supplies the degrees-scale
   * galactic band and nothing else, while every *resolved* star comes from the
   * {@link StarField} sprite catalogue at its actual RA/Dec. One physical owner
   * per signal — so stars stay resolution-independent, share a single PSF and
   * B−V colour, and can respond to extinction, daytime fade and glare, none of
   * which a texel baked into a cube face can do.
   *
   * Baked from the same hash-pinned SVS 3572 `t5` source as
   * {@link SkyBox.Variant.TYCHO_T5} by `Tools/skybox-bake/`, low-passed with a
   * wrapped Gaussian of σ ≈ 0.44° (FWHM ≈ 1.03°) on the equirectangular before
   * reprojection — wide enough to annihilate point sources (Tycho stars render
   * under 0.1°) and far narrower than the band structure it preserves. The blur
   * runs on the *equirect*, not on six faces independently, so the cube stays
   * seam-continuous.
   *
   * `TYCHO_T5` remains bundled and selectable as the un-blurred reversal
   * artifact, so DR-01 can be reversed without a re-bake.
   */
  TYCHO_T5_DIFFUSE: "TYCHO_T5_DIFFUSE",
});

// C12-12 — `tierSuffix` is the resolution-tier infix from
// `Scene/SkyBoxResolutionPolicy.js`. It is empty for each variant's bundled
// tier, which is what keeps every default URL byte-identical to what shipped
// before the policy existed; a future 4096 bake would install
// `<prefix>_4096_<face>.jpg`.
const skyBoxVariants = {
  [SkyBox.Variant.TYCHO_T3]: {
    prefix: "tycho2t3_80",
    url(face, tierSuffix) {
      return buildModuleUrl(
        `Assets/Textures/SkyBox/${this.prefix}${tierSuffix ?? ""}_${face}.jpg`,
      );
    },
  },
  [SkyBox.Variant.TYCHO_T5]: {
    prefix: "tycho2t5_80",
    url(face, tierSuffix) {
      return buildModuleUrl(
        `Assets/Textures/SkyBox/${this.prefix}${tierSuffix ?? ""}_${face}.jpg`,
      );
    },
  },
  [SkyBox.Variant.TYCHO_T5_DIFFUSE]: {
    prefix: "tycho2t5_80_diffuse",
    url(face, tierSuffix) {
      return buildModuleUrl(
        `Assets/Textures/SkyBox/${this.prefix}${tierSuffix ?? ""}_${face}.jpg`,
      );
    },
  },
};

/**
 * The variant {@link SkyBox.createEarthSkyBox} uses when none is passed.
 *
 * `TYCHO_T5_DIFFUSE` is the default as of `C12-11` (Campaign 12), completing
 * the DR-01 seam: the cube map contributes diffuse galactic light and the
 * {@link StarField} sprite catalogue owns every resolved star. `C12-10` had
 * shipped the un-blurred `TYCHO_T5` faces as a deliberate transitional step,
 * before the catalogue was deep enough to take over — with both sources
 * painting the same stars, the sprites were very nearly invisible.
 *
 * All three variants stay bundled and offline: `TYCHO_T5` as DR-01's un-blurred
 * reversal artifact, and `TYCHO_T3` as the historical faint render.
 *
 * @type {string}
 * @default SkyBox.Variant.TYCHO_T5_DIFFUSE
 */
SkyBox.defaultVariant = SkyBox.Variant.TYCHO_T5_DIFFUSE;

/**
 * C12-12 — selectable star-cube-map face resolutions for
 * {@link SkyBox.createEarthSkyBox}.
 *
 * The star cube map is the largest fixed texture allocation in a default
 * scene and it is stored uncompressed (`rgba8unorm`, six faces, one mip level
 * on BOTH backends), so the tier is a VRAM decision before it is a quality
 * decision:
 *
 * | tier | VRAM  | note                                              |
 * |------|-------|---------------------------------------------------|
 * | 1024 | 24 MiB  | only `TYCHO_T3` ships at this size (upstream)    |
 * | 2048 | 96 MiB  | the default; `TYCHO_T5` and `TYCHO_T5_DIFFUSE`   |
 * | 4096 | 384 MiB | opt-in — **no 4096 faces are bundled at HEAD**   |
 *
 * Requesting a tier that is not bundled for the chosen variant serves the
 * closest bundled tier instead and reports it on {@link SkyBox#resolution};
 * no URL is fabricated. See `Scene/SkyBoxResolutionPolicy.js` for the policy,
 * the loader evidence behind those numbers, and what installing the 4096 tier
 * would take.
 *
 * @enum {string}
 * @readonly
 */
SkyBox.Resolution = SkyBoxResolution;

/**
 * The resolution tier {@link SkyBox.createEarthSkyBox} uses when none is
 * passed. 2048/face — 96 MiB of video memory, and the size
 * `Tools/skybox-bake/` actually installs.
 *
 * @type {string}
 * @default SkyBox.Resolution.SIZE_2048
 */
SkyBox.defaultResolution = DEFAULT_SKYBOX_RESOLUTION;

/**
 * Public controls for the bright-star catalog rendered by a sky box.
 *
 * @typedef {object} SkyBox.StarField
 * @property {boolean} show Whether the catalog is rendered.
 * @property {number} intensity The catalog brightness multiplier.
 */

export default SkyBox;
