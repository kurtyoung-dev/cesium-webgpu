import buildModuleUrl from "../Core/buildModuleUrl.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import IauOrientationAxes from "../Core/IauOrientationAxes.js";
import Matrix3 from "../Core/Matrix3.js";
import Matrix4 from "../Core/Matrix4.js";
import Simon1994PlanetaryPositions from "../Core/Simon1994PlanetaryPositions.js";
import Transforms from "../Core/Transforms.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import EllipsoidPrimitive from "./EllipsoidPrimitive.js";
import Material from "./Material.js";

/**
 * Draws the Moon in 3D.
 * @alias Moon
 *
 * @param {object} [options] Object with the following properties:
 * @param {boolean} [options.show=true] Determines whether the moon will be rendered.
 * @param {string} [options.textureUrl=buildModuleUrl('Assets/Textures/moonSmall.jpg')] The moon texture.
 * @param {Ellipsoid} [options.ellipsoid=Ellipsoid.MOON] The moon ellipsoid.
 * @param {boolean} [options.onlySunLighting=true] Use the sun as the only light source.
 *
 *
 * @example
 * scene.moon = new Cesium.Moon();
 *
 * @see Scene#moon
 */
class Moon {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    let url = options.textureUrl;
    if (!defined(url)) {
      url = buildModuleUrl("Assets/Textures/moonSmall.jpg");
    }

    /**
     * Determines if the moon will be shown.
     *
     * @type {boolean}
     * @default true
     */
    this.show = options.show ?? true;

    /**
     * The moon texture.
     * @type {string}
     * @default buildModuleUrl('Assets/Textures/moonSmall.jpg')
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

const icrfToFixed = new Matrix3();
const rotationScratch = new Matrix3();
const translationScratch = new Cartesian3();
const scratchMoonDirWC = new Cartesian3();
const scratchCommandList = [];

export default Moon;
