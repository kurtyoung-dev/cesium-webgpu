import buildModuleUrl from "../Core/buildModuleUrl.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import IauOrientationAxes from "../Core/IauOrientationAxes.js";
import Matrix3 from "../Core/Matrix3.js";
import Matrix4 from "../Core/Matrix4.js";
import Simon1994PlanetaryPositions from "../Core/Simon1994PlanetaryPositions.js";
import Transforms from "../Core/Transforms.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import {
  computeAtmosphereExtinctionCached,
  createAtmosphereExtinctionCache,
  computeAtmosphereInscatterCached,
  createAtmosphereInscatterCache,
} from "./computeAtmosphereExtinction.js";
import computeLunarOppositionSurge from "./computeLunarOppositionSurge.js";
import EllipsoidPrimitive from "./EllipsoidPrimitive.js";
import Material from "./Material.js";

/**
 * Draws the Moon in 3D.
 * @alias Moon
 *
 * @param {object} [options] Object with the following properties:
 * @param {boolean} [options.show=true] Determines whether the moon will be rendered.
 * @param {string} [options.textureUrl] The moon texture. Defaults to the albedo
 *        map of {@link Moon.defaultVariant}; pass an explicit URL to override
 *        the bundled maps entirely.
 * @param {string} [options.variant] One of {@link Moon.Variant}, selecting which
 *        bundled albedo map to use. Ignored when <code>textureUrl</code> is given.
 *        Defaults to {@link Moon.defaultVariant}.
 * @param {Ellipsoid} [options.ellipsoid=Ellipsoid.MOON] The moon ellipsoid.
 * @param {boolean} [options.onlySunLighting=true] Use the sun as the only light source.
 *
 *
 * @example
 * scene.moon = new Cesium.Moon();
 *
 * @example
 * // Restore the historical low-resolution albedo map.
 * scene.moon = new Cesium.Moon({ variant: Cesium.Moon.Variant.SMALL });
 *
 * @see Scene#moon
 */
class Moon {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    let url = options.textureUrl;
    if (!defined(url)) {
      url = Moon.getVariantTextureUrl(options.variant);
    }

    /**
     * Determines if the moon will be shown.
     *
     * @type {boolean}
     * @default true
     */
    this.show = options.show ?? true;

    /**
     * The moon texture — an equirectangular (plate carrée) albedo map, centred
     * on 0° longitude with east to the right and north at the top of the image.
     * That is the convention {@link czm_ellipsoidTextureCoordinates} and its
     * WGSL twin unwrap to; see `Tools/moon-albedo-bake/lunar-landmarks.mjs`
     * for the checked assertion of it.
     * @type {string}
     * @default the albedo map of {@link Moon.defaultVariant}
     */
    this.textureUrl = url;

    this._ellipsoid = options.ellipsoid ?? Ellipsoid.MOON;

    /**
     * Use the sun as the only light source.
     * @type {boolean}
     * @default true
     */
    this.onlySunLighting = options.onlySunLighting ?? true;

    this._ellipsoidPrimitive = new EllipsoidPrimitive({
      radii: this.ellipsoid.radii,
      material: Material.fromType(Material.ImageType),
      depthTestEnabled: false,
      _owner: this,
    });
    this._ellipsoidPrimitive.material.translucent = false;

    this._axes = new IauOrientationAxes();

    // C9-06 — per-primitive scalar cache for the shared camera→Moon
    // atmospheric extinction integration. Reused across frames so the
    // 16-sample optical-depth march only recomputes when an exact physical
    // input (camera, Moon position, atmosphere coefficients/scale heights,
    // inner radius, or the enabled gate) changes. Keeps the Moon consistent
    // with the Sun/star extinction, which use the same cached integrator.
    this._atmosphereExtinctionCache = createAtmosphereExtinctionCache();

    // C12-30 — cache for the additive in-scattering (sky-wash) integral,
    // the extinction's additive twin. Same exact-input caching contract.
    this._atmosphereInscatterCache = createAtmosphereInscatterCache();
  }

  /**
   * Get the ellipsoid that defines the shape of the moon.
   *
   * @type {Ellipsoid}
   * @readonly
   *
   * @default {@link Ellipsoid.MOON}
   */
  get ellipsoid() {
    return this._ellipsoid;
  }

  /**
   * @private
   */
  update(frameState) {
    if (!this.show) {
      return;
    }

    const ellipsoidPrimitive = this._ellipsoidPrimitive;
    ellipsoidPrimitive.material.uniforms.image = this.textureUrl;
    ellipsoidPrimitive.onlySunLighting = this.onlySunLighting;

    const date = frameState.time;
    if (!defined(Transforms.computeIcrfToFixedMatrix(date, icrfToFixed))) {
      Transforms.computeTemeToPseudoFixedMatrix(date, icrfToFixed);
    }

    const rotation = this._axes.evaluate(date, rotationScratch);
    Matrix3.transpose(rotation, rotation);
    Matrix3.multiply(icrfToFixed, rotation, rotation);

    const translation =
      Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
        date,
        translationScratch,
      );
    Matrix3.multiplyByVector(icrfToFixed, translation, translation);

    Matrix4.fromRotationTranslation(
      rotation,
      translation,
      ellipsoidPrimitive.modelMatrix,
    );

    // Phase 1.2: publish moon ephemeris onto frameState for renderers
    // (Moon fragment shader, atmosphere, night-side lighting). `translation`
    // is the moon position in world coords (earth-centered fixed frame),
    // so its normalized form is the world-space direction from the earth
    // center toward the moon.
    const moonDirWC = Cartesian3.normalize(translation, scratchMoonDirWC);

    // Pull sun direction (WC) from the per-frame uniform state. Scene.js
    // updates uniformState before calling Moon.update, so this is current.
    let phaseFraction = 1.0;
    const uniformState = defined(frameState.context)
      ? frameState.context.uniformState
      : undefined;
    if (defined(uniformState) && defined(uniformState.sunDirectionWC)) {
      const sunDirWC = uniformState.sunDirectionWC;
      const sunLenSq = Cartesian3.magnitudeSquared(sunDirWC);
      const moonLenSq = Cartesian3.magnitudeSquared(moonDirWC);
      if (sunLenSq > 0.0 && moonLenSq > 0.0) {
        // 0 = new moon (sun and moon in same direction), 0.5 = quarter,
        // 1 = full moon (opposite directions).
        const cosAngle = Cartesian3.dot(moonDirWC, sunDirWC);
        phaseFraction = 0.5 * (1.0 - cosAngle);
      } else {
        phaseFraction = 0.5;
      }
    }

    // Gate on atmospheric-conditions lighting toggle. When disabled or when
    // no globe is attached, fall back to "always full" (1.0) — simpler flat
    // disc shading that matches pre-Phase-1 behavior.
    const ac = frameState.atmosphericConditions;
    const enableMoonPhase =
      defined(ac) && defined(ac.lighting) ? ac.lighting.enableMoonPhase : false;
    if (!enableMoonPhase) {
      phaseFraction = 1.0;
    }

    frameState.moonDirectionWC = Cartesian3.clone(
      moonDirWC,
      frameState.moonDirectionWC,
    );
    frameState.moonPhaseFraction = phaseFraction;

    // NS-MOON-ATMOSPHERE-EXTINCTION — attenuate and redden the moon by the
    // atmospheric optical path along the view ray. `translation` is the moon
    // position in Earth-centered fixed coordinates; the extinction integrates
    // the Rayleigh/Mie optical depth from the camera to the moon through the
    // atmosphere shell. Gated on the sky atmosphere actually being rendered so
    // the moon is byte-identical when the atmosphere is hidden, and the
    // physics yields exactly Cartesian3.ONE from orbit (ray never crosses the
    // shell) — so the off-gate is byte-identical there too.
    const camPos = defined(frameState.camera)
      ? frameState.camera.positionWC
      : undefined;
    const extinctionEnabled =
      frameState.skyAtmosphereVisible === true &&
      defined(frameState.atmosphere) &&
      defined(camPos);
    // Cached shared integrator (C9-06). When disabled it returns the exact
    // multiplicative identity (1,1,1) — byte-identical to the prior
    // `scratchExtinctionOne` fallback — and from orbit the ray never crosses
    // the shell so the physics also yields ONE.
    const extinction = computeAtmosphereExtinctionCached(
      this._atmosphereExtinctionCache,
      scratchExtinction,
      extinctionEnabled,
      camPos,
      translation,
      frameState.atmosphere,
      Ellipsoid.default.maximumRadius,
    );
    frameState.moonAtmosphereExtinction = Cartesian3.clone(
      extinction,
      frameState.moonAtmosphereExtinction,
    );
    // Hand the extinction to the WebGL moon primitive. Undefined disables the
    // shader path (byte-identical) when the atmosphere is hidden.
    ellipsoidPrimitive.atmosphereExtinction =
      frameState.skyAtmosphereVisible === true ? extinction : undefined;

    // C12-30 — atmospheric IN-SCATTERING (sky-wash), the additive half of
    // the transfer the extinction above is the multiplicative half of. The
    // opaque disc is drawn OVER the sky-atmosphere shell, so without this
    // term the disc loses the sky radiance its neighboring pixels keep and
    // a daytime moon reads as a dark cutout. The CPU integral mirrors the
    // sky shader's own single-scattering model (see
    // computeAtmosphereInscatter) so the disc blends into the rendered sky:
    //     disc = discColor × extinction + inscatter.
    // Gated on the same skyAtmosphereVisible condition as the extinction
    // plus the atmosphericConditions.lighting.enableMoonSkyWash toggle;
    // disabled (or from orbit, where the ray misses the shell) the wash is
    // exactly (0,0,0) — the additive identity, byte-identical.
    const lighting =
      defined(ac) && defined(ac.lighting) ? ac.lighting : undefined;
    const sunDirWCForWash =
      defined(uniformState) && defined(uniformState.sunDirectionWC)
        ? uniformState.sunDirectionWC
        : undefined;
    const washEnabled =
      extinctionEnabled &&
      defined(sunDirWCForWash) &&
      defined(lighting) &&
      lighting.enableMoonSkyWash === true;
    // Display-space matching: with HDR off (the default) the sky FS
    // tonemaps in-shader, so the wash applies the same transform; with HDR
    // on the wash stays linear and rides the post-process tonemap.
    const applyWashTonemap = frameState.useHDR !== true;
    const washGamma =
      defined(uniformState) && defined(uniformState.gamma)
        ? uniformState.gamma
        : 2.2;
    const inscatter = computeAtmosphereInscatterCached(
      this._atmosphereInscatterCache,
      scratchInscatter,
      washEnabled,
      camPos,
      translation,
      sunDirWCForWash,
      frameState.atmosphere,
      Ellipsoid.default.maximumRadius,
      applyWashTonemap,
      washGamma,
    );
    frameState.moonAtmosphereInscatter = Cartesian3.clone(
      inscatter,
      frameState.moonAtmosphereInscatter,
    );
    // Hand the wash to the WebGL moon primitive. Undefined disables the
    // shader path (no define, byte-identical) when the wash is off.
    ellipsoidPrimitive.atmosphereInscatter = washEnabled
      ? inscatter
      : undefined;

    // C12-20 — Lommel-Seeliger lunar reflectance toggle. The shader-side
    // branch (both backends) replaces the Lambert disc law with the lunar
    // regolith law; the flag just routes it. Default ON via
    // AtmosphericConditions.lighting.enableLunarBRDF.
    const lunarBRDF = defined(lighting) && lighting.enableLunarBRDF === true;
    ellipsoidPrimitive.lunarBRDF = lunarBRDF;

    // C12-23 — opposition surge: one CPU-side Hapke-SHOE multiplier from
    // the true Sun–Moon–observer phase angle (constant across the distant
    // disc), passed as a single uniform. 1.0 (identity) when disabled or
    // away from opposition.
    const surgeEnabled =
      defined(lighting) && lighting.enableOppositionSurge === true;
    let oppositionSurge = 1.0;
    if (
      surgeEnabled &&
      defined(uniformState) &&
      defined(uniformState.sunPositionWC) &&
      defined(camPos)
    ) {
      const moonToSun = Cartesian3.subtract(
        uniformState.sunPositionWC,
        translation,
        scratchMoonToSun,
      );
      const moonToCamera = Cartesian3.subtract(
        camPos,
        translation,
        scratchMoonToCamera,
      );
      const sunDistance = Cartesian3.magnitude(moonToSun);
      const cameraDistance = Cartesian3.magnitude(moonToCamera);
      if (sunDistance > 0.0 && cameraDistance > 0.0) {
        let cosPhaseAngle =
          Cartesian3.dot(moonToSun, moonToCamera) /
          (sunDistance * cameraDistance);
        cosPhaseAngle = Math.min(Math.max(cosPhaseAngle, -1.0), 1.0);
        oppositionSurge = computeLunarOppositionSurge(Math.acos(cosPhaseAngle));
      }
    }
    frameState.moonOppositionSurge = oppositionSurge;
    ellipsoidPrimitive.oppositionSurge = surgeEnabled
      ? oppositionSurge
      : undefined;

    // Backend-specific path — delegate to feature renderer if available
    const context = frameState.context;
    const fr = context.getFeatureRenderer(FeatureRendererKey.MOON);
    if (fr) {
      this._featureRenderer = fr;
      const savedCommandList = frameState.commandList;
      frameState.commandList = scratchCommandList;
      scratchCommandList.length = 0;
      fr.update(this, frameState, scratchCommandList);
      frameState.commandList = savedCommandList;
      return scratchCommandList.length === 1
        ? scratchCommandList[0]
        : undefined;
    }

    const savedCommandList = frameState.commandList;
    frameState.commandList = scratchCommandList;
    scratchCommandList.length = 0;
    ellipsoidPrimitive.update(frameState);
    frameState.commandList = savedCommandList;
    return scratchCommandList.length === 1 ? scratchCommandList[0] : undefined;
  }

  /**
   * Phase 6 debug surface — returns a diagnostic snapshot of the moon's
   * current per-frame state. Backend-agnostic dispatch: routes through
   * the registered MOON feature renderer's `getStatistics(moon)` entry
   * point so Scene code can call this without importing from
   * `Renderer/WebGPU/`. Returns `null` when no feature renderer is
   * registered (e.g., WebGL backend) or when the moon hasn't yet had
   * its first `update()` call.
   *
   * @param {Scene} scene The owning scene; used to obtain the active
   *   GraphicsContext for the feature renderer lookup.
   * @returns {object|null}
   */
  getDebugStatistics(scene) {
    if (!defined(scene) || !defined(scene.context)) {
      return null;
    }
    const fr = scene.context.getFeatureRenderer(FeatureRendererKey.MOON);
    if (!defined(fr) || typeof fr.getStatistics !== "function") {
      return null;
    }
    try {
      return fr.getStatistics(this);
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * <br /><br />
   * If this object was destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   *
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   *
   * @see Moon#destroy
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
   * moon = moon && moon.destroy();
   *
   * @see Moon#isDestroyed
   */
  destroy() {
    this._ellipsoidPrimitive =
      this._ellipsoidPrimitive && this._ellipsoidPrimitive.destroy();
    if (
      defined(this._featureRenderer) &&
      defined(this._featureRenderer.destroy)
    ) {
      this._featureRenderer.destroy(this);
    }
    return destroyObject(this);
  }
}

/**
 * Selectable bundled albedo maps for {@link Moon}.
 *
 * Enumerated rather than raw strings so a typo fails loudly in debug builds
 * instead of silently 404-ing the moon into its placeholder. Mirrors
 * {@link SkyBox.Variant}, which does the same for the bundled star maps.
 *
 * Both variants use the SAME projection — equirectangular, centred on 0°
 * longitude, east right, north at the top of the image — so switching between
 * them changes only resolution and source, never orientation.
 *
 * @enum {string}
 * @readonly
 */
Moon.Variant = Object.freeze({
  /**
   * The historical 256×128 `moonSmall.jpg` inherited from upstream Cesium.
   * At the ~190 px disc of a zoomed-in view its visible hemisphere is only
   * 128 texels — 0.67 texels/px, i.e. under-resolved (C12-24). Retained as
   * the low-bandwidth option (17.8 KB) and as the fallback if an application
   * prefers the historical look.
   */
  SMALL: "SMALL",
  /**
   * NASA/GSFC SVS 4720 "CGI Moon Kit" 2019 colour map at 2048×1024 — the
   * default as of C12-24. Derived from the LROC Wide Angle Camera "Hapke
   * normalized" mosaic, gamma corrected and white balanced by SVS to
   * approximate human vision. Bundled offline at 550 KB (JPEG q90 4:4:4) by
   * the reproducible pipeline at `Tools/moon-albedo-bake/`. The asset's terms
   * are stated in `LICENSE.md` → Bundled Engine Assets.
   */
  LROC_COLOR_2K: "LROC_COLOR_2K",
});

const moonVariants = {
  [Moon.Variant.SMALL]: "Assets/Textures/moonSmall.jpg",
  [Moon.Variant.LROC_COLOR_2K]: "Assets/Textures/Moon/lroc_color_poles_2k.jpg",
};

/**
 * The variant {@link Moon} uses when neither `textureUrl` nor `variant` is
 * passed.
 *
 * `LROC_COLOR_2K` is the default as of `C12-24` (Campaign 12): the historical
 * 256×128 map is under-resolved at any zoomed view. `SMALL` remains bundled
 * and selectable; both are offline.
 *
 * @type {string}
 * @default Moon.Variant.LROC_COLOR_2K
 */
Moon.defaultVariant = Moon.Variant.LROC_COLOR_2K;

/**
 * Resolves a {@link Moon.Variant} to the URL of its bundled albedo map.
 *
 * @param {string} [variant] One of {@link Moon.Variant}. Defaults to
 *        {@link Moon.defaultVariant}.
 * @returns {string} The module-relative URL of the variant's texture.
 */
Moon.getVariantTextureUrl = function (variant) {
  const v = variant ?? Moon.defaultVariant;
  // Own-property lookup only: a bare `moonVariants[v]` resolves inherited
  // Object.prototype keys, so `variant: "constructor"` would sail past the
  // defined() guard and hand buildModuleUrl a function.
  const asset = Object.prototype.hasOwnProperty.call(moonVariants, v)
    ? moonVariants[v]
    : undefined;
  //>>includeStart('debug', pragmas.debug);
  if (!defined(asset)) {
    throw new DeveloperError(
      `Unknown Moon variant "${v}". Valid values are: ${Object.keys(moonVariants).join(", ")}`,
    );
  }
  //>>includeEnd('debug');
  return buildModuleUrl(asset ?? moonVariants[Moon.Variant.LROC_COLOR_2K]);
};

const icrfToFixed = new Matrix3();
const rotationScratch = new Matrix3();
const translationScratch = new Cartesian3();
const scratchMoonDirWC = new Cartesian3();
const scratchExtinction = new Cartesian3();
const scratchInscatter = new Cartesian3();
const scratchMoonToSun = new Cartesian3();
const scratchMoonToCamera = new Cartesian3();
const scratchCommandList = [];

export default Moon;
