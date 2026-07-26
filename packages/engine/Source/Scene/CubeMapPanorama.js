import BoxGeometry from "../Core/BoxGeometry.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import Check from "../Core/Check.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import GeometryPipeline from "../Core/GeometryPipeline.js";
import Matrix4 from "../Core/Matrix4.js";
import VertexFormat from "../Core/VertexFormat.js";
import BufferUsage from "../Renderer/BufferUsage.js";
import CubeMap from "../Renderer/CubeMap.js";
import DrawCommand from "../Renderer/DrawCommand.js";
import loadCubeMap from "../Renderer/loadCubeMap.js";
import RenderState from "../Renderer/RenderState.js";
import ShaderProgram from "../Renderer/ShaderProgram.js";
import ShaderSource from "../Renderer/ShaderSource.js";
import VertexArray from "../Renderer/VertexArray.js";
import SkyBoxFS from "../Shaders/SkyBoxFS.js";
import SkyBoxVS from "../Shaders/SkyBoxVS.js";
import CubeMapPanoramaVS from "../Shaders/CubeMapPanoramaVS.js";
import BlendingState from "./BlendingState.js";
import SceneMode from "./SceneMode.js";
import Pass from "../Renderer/Pass.js";
import Credit from "../Core/Credit.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import {
  STAR_MODULATION_INFLECTION,
  STAR_MODULATION_STEEPNESS,
} from "./StarFieldMath.js";

/**
 * @typedef {object} CubeMapPanorama.ConstructorOptions
 *
 * Initialization options for the CubeMapPanorama constructor
 *
 * @property {object} [options.sources] The source URL or <code>Image</code> object for each of the six cube map faces.  See the example below.
 * @property {Matrix4} [options.transform] A 4x4 transformation matrix that defines the panorama's position and orientation
 * @property {boolean} [options.show=true] Determines if this primitive will be shown.
 * @property {boolean} [options.isStarMap=false] Whether this cube map contains celestial star imagery that should respond to atmospheric star brightness and cloud occlusion.
 * @property {Credit|string} [options.credit] A credit for the panorama, which is displayed on the canvas.
 *
 */

/**
 * A {@link Panorama} that displays imagery in cube map format in a scene.
 * <p>
 * This is only supported in 3D.  The cube map panorama is faded out when morphing to 2D or Columbus view.  The size of
 * the cube map panorama must not exceed {@link Scene#maximumSkyBoxSize}.
 * </p>
 *
 * @alias CubeMapPanorama
 *
 * @param {CubeMapPanorama.ConstructorOptions} options Object describing initialization options
 *
 * @example
 * const modelMatrix = Cesium.Matrix4.getMatrix3(
 *   Cesium.Transforms.localFrameToFixedFrameGenerator("north", "down")(
 *     Cesium.Cartesian3.fromDegrees(longitude, latitude, height),
 *     Cesium.Ellipsoid.default
 *   ),
 *   new Cesium.Matrix3()
 * );
 *
 *
 * scene.primitives.add(new Cesium.CubeMapPanorama({
 *   sources : {
 *     positiveX : 'cubemap_px.png',
 *     negativeX : 'cubemap_nx.png',
 *     positiveY : 'cubemap_py.png',
 *     negativeY : 'cubemap_ny.png',
 *     positiveZ : 'cubemap_pz.png',
 *     negativeZ : 'cubemap_nz.png'
 *   }
 *   transform: modelMatrix,
 * }));
 *
 * @see SkyBox
 *
 * @demo {@link https://sandcastle.cesium.com/index.html?id=panorama|Cesium Sandcastle Panorama}
 */
class CubeMapPanorama {
  constructor(options) {
    /**
     * The sources used to create the cube map faces: an object
     * with <code>positiveX</code>, <code>negativeX</code>, <code>positiveY</code>,
     * <code>negativeY</code>, <code>positiveZ</code>, and <code>negativeZ</code> properties.
     * These can be either URLs or <code>Image</code> objects.
     *
     * @type {object}
     * @default undefined
     */
    this.sources = options.sources;
    this._sources = undefined;

    this._transform = options.transform ?? undefined;

    /**
     * Determines if the cube map panorama will be shown.
     *
     * @type {boolean}
     * @default true
     */
    this.show = options.show ?? true;

    this._isStarMap = options.isStarMap === true;
    this._returnCommand = options.returnCommand ?? false;
    this._addToPanoramaCommandList = !this._returnCommand;

    this._command = new DrawCommand({
      modelMatrix: Matrix4.clone(Matrix4.IDENTITY),
      owner: this,
      // render before everything else
      pass: Pass.ENVIRONMENT,
    });
    this._cubeMap = undefined;

    this._attributeLocations = undefined;
    this._useHdr = undefined;
    this._hasError = false;
    this._error = undefined;

    // C12-29 S6 / ruling E3 — star-brightness modulation inputs for
    // `SkyBoxFS.glsl`, refreshed once per WebGL update and read by the uniform
    // closures at draw time. `u_starModulation` = (inflection, steepness,
    // enableFlag, cloudCover); the identity values below leave the cubemap
    // untouched, so a panorama that never reaches `update` (or a frame with no
    // `atmosphericConditions`) renders exactly as it did before.
    this._starModulation = new Cartesian4(
      STAR_MODULATION_INFLECTION,
      STAR_MODULATION_STEEPNESS,
      0.0,
      0.0,
    );
    this._skyBrightness = 0.0;

    // Credit specified by the user.
    let credit = options.credit;
    if (typeof credit === "string") {
      credit = new Credit(credit);
    }
    this._credit = credit;
  }

  /**
   * Gets the transform of the panorama.
   * @type {Matrix4}
   * @readonly
   */
  get transform() {
    return this._transform;
  }

  /**
   * Gets the credits of the panorama.
   * @type {Credit}
   * @readonly
   */
  get credit() {
    return defined(this._credit) ? this._credit : undefined;
  }

  /**
   * Whether this panorama contains celestial star imagery. Only star maps are
   * attenuated by atmospheric brightness and weather cloud cover; generic
   * photographic panoramas, including Street View, remain unchanged.
   *
   * @type {boolean}
   * @readonly
   */
  get isStarMap() {
    return this._isStarMap;
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
    const that = this;
    const { mode, passes, context, panoramaCommandList } = frameState;

    if (!this.show) {
      return undefined;
    }

    if (mode !== SceneMode.SCENE3D && mode !== SceneMode.MORPHING) {
      return undefined;
    }

    // The cube map panorama is only rendered during the render pass; it is not pickable, it doesn't cast shadows, etc.
    if (!passes.render) {
      return undefined;
    }

    // Throw any errors that had previously occurred asynchronously so they aren't
    // ignored when running.  See https://github.com/CesiumGS/cesium/pull/12307
    if (this._hasError) {
      const error = this._error;
      this._hasError = false;
      this._error = undefined;
      throw error;
    }

    // Backend-independent validation of the public sources contract. This
    // must run BEFORE the feature-renderer dispatch so WebGL and WebGPU
    // enforce identical debug-time validation (item 64 / C8-30 "panorama
    // validation matches across backends"). C9-AUDIT-P1-SWEEP (Batch 684):
    // validate unconditionally in debug. The former `this._sources !==
    // this.sources` gate was vestigial — Batch 674 moved the realize
    // assignment that reset that sentinel down into the WebGL path, and the
    // WebGPU path never resets it, so the gate made validation once-per-change
    // on WebGL but every-frame on WebGPU (NOT the "identical" validation the
    // comment claims). Dropping it makes the two backends truly symmetric;
    // the whole block is pragma-stripped, so release bytes are unchanged.
    //>>includeStart('debug', pragmas.debug);
    const validatedSources = this.sources;
    Check.defined("this.sources", validatedSources);
    if (
      Object.values(CubeMap.FaceName).some(
        (faceName) => !defined(validatedSources[faceName]),
      )
    ) {
      throw new DeveloperError(
        "this.sources must have positiveX, negativeX, positiveY, negativeY, positiveZ, and negativeZ properties.",
      );
    }

    const validatedSourceType = typeof validatedSources.positiveX;
    if (
      Object.values(CubeMap.FaceName).some(
        (faceName) => typeof validatedSources[faceName] !== validatedSourceType,
      )
    ) {
      throw new DeveloperError(
        "this.sources properties must all be the same type.",
      );
    }
    //>>includeEnd('debug');

    // Resolve once in backend-neutral scene code. Both feature renderers
    // consume these exact values, preventing a generic photographic panorama
    // from inheriting SkyBox-only star/weather attenuation.
    updateStarModulation(this, frameState);

    // WebGPU rendering path — delegates to feature renderer
    const fr = context.getFeatureRenderer(FeatureRendererKey.CUBE_MAP_PANORAMA);
    if (fr) {
      return fr.update(this, frameState, useHdr);
    }

    // WebGL rendering path.

    if (this._sources !== this.sources) {
      this._sources = this.sources;
      const sources = this.sources;

      if (typeof sources.positiveX === "string") {
        // Given urls for cube-map images.  Load them.
        loadCubeMap(context, this._sources)
          .then(function (cubeMap) {
            that._cubeMap = that._cubeMap && that._cubeMap.destroy();
            that._cubeMap = cubeMap;
          })
          .catch((error) => {
            // Defer throwing the error until the next call to update to prevent
            // test from failing in `afterAll` if this is rejected after the test
            // using the Skybox ends.  See https://github.com/CesiumGS/cesium/pull/12307
            this._hasError = true;
            this._error = error;
          });
      } else {
        this._cubeMap = this._cubeMap && this._cubeMap.destroy();
        this._cubeMap = new CubeMap({
          context: context,
          source: sources,
        });
      }
      this._addToPanoramaCommandList = true;
    }

    const command = this._command;

    if (!defined(command.vertexArray)) {
      command.uniformMap = {
        u_cubeMap: function () {
          return that._cubeMap;
        },
        u_cubeMapPanoramaTransform: function () {
          return that._transform;
        },
        u_starModulation: function () {
          return that._starModulation;
        },
        u_skyBrightness: function () {
          return that._skyBrightness;
        },
      };

      const geometry = BoxGeometry.createGeometry(
        BoxGeometry.fromDimensions({
          dimensions: new Cartesian3(2.0, 2.0, 2.0),
          vertexFormat: VertexFormat.POSITION_ONLY,
        }),
      );
      const attributeLocations = (this._attributeLocations =
        GeometryPipeline.createAttributeLocations(geometry));

      command.vertexArray = VertexArray.fromGeometry({
        context: context,
        geometry: geometry,
        attributeLocations: attributeLocations,
        bufferUsage: BufferUsage.STATIC_DRAW,
      });

      // no depth test/write
      command.renderState = RenderState.fromCache({
        depthTest: { enabled: false },
        depthMask: false,
        blending: BlendingState.ALPHA_BLEND,
      });
      this._addToPanoramaCommandList = true;
    }

    if (!defined(command.shaderProgram) || this._useHdr !== useHdr) {
      const fs = new ShaderSource({
        defines: [useHdr ? "HDR" : ""],
        sources: [SkyBoxFS],
      });
      command.shaderProgram = ShaderProgram.fromCache({
        context: context,
        //vertexShaderSource: SkyBoxVS,
        vertexShaderSource: defined(this._transform)
          ? CubeMapPanoramaVS
          : SkyBoxVS,
        fragmentShaderSource: fs,
        attributeLocations: this._attributeLocations,
      });
      this._useHdr = useHdr;
      this._addToPanoramaCommandList = true;
    }

    if (!defined(this._cubeMap)) {
      return undefined;
    }

    if (this.show && defined(this._credit) && !this._returnCommand) {
      const creditDisplay = frameState.creditDisplay;
      creditDisplay.addCreditToNextFrame(this._credit);
    }

    if (this._returnCommand) {
      return command;
    }

    if (this._addToPanoramaCommandList) {
      panoramaCommandList.push(command);
      this._addToPanoramaCommandList = false;
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
   * @see CubeMapPanorama#destroy
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
   * cubeMapPanorama = cubeMapPanorama && cubeMapPanorama.destroy();
   *
   * @see CubeMapPanorama#isDestroyed
   */
  destroy() {
    // WebGL cleanup
    const command = this._command;
    command.vertexArray = command.vertexArray && command.vertexArray.destroy();
    command.shaderProgram =
      command.shaderProgram && command.shaderProgram.destroy();
    this._cubeMap = this._cubeMap && this._cubeMap.destroy();

    return destroyObject(this);
  }
}

/**
 * Resolve the backend-neutral star-modulation inputs for this frame (C12-29
 * S6, ruling E3). WebGL uniform closures and the WebGPU uniform packer consume
 * these same values. Generic photographic panoramas resolve exact identity;
 * only SkyBox's explicitly marked celestial panorama is attenuated.
 *
 * @param {CubeMapPanorama} panorama
 * @param {FrameState} frameState
 * @private
 */
function updateStarModulation(panorama, frameState) {
  const ac = frameState.atmosphericConditions;
  const sky =
    defined(ac) && defined(ac.skyAtmosphere) ? ac.skyAtmosphere : undefined;
  const curve =
    defined(sky) && defined(sky.starModulationCurve)
      ? sky.starModulationCurve
      : undefined;
  const enable =
    panorama._isStarMap === true &&
    defined(sky) &&
    sky.enableStarBrightnessModulation === true &&
    frameState.skyAtmosphereVisible === true;
  // Weather-gated cloud occlusion, mirroring the WebGPU packing: unread unless
  // `scene.enableWeather` is on, because `globe.cloudCoverage` defaults to 0.5
  // and an ungated read would halve every default scene's star map.
  const weather = defined(ac) && defined(ac.weather) ? ac.weather : undefined;
  const cloudCover =
    panorama._isStarMap === true &&
    defined(weather) &&
    weather.enabled === true &&
    typeof weather.cloudCover === "number"
      ? weather.cloudCover
      : 0.0;

  const m = panorama._starModulation;
  m.x = defined(curve) ? curve.inflection : STAR_MODULATION_INFLECTION;
  m.y = defined(curve) ? curve.steepness : STAR_MODULATION_STEEPNESS;
  m.z = enable ? 1.0 : 0.0;
  m.w = cloudCover;
  panorama._skyBrightness = frameState.skyBrightness ?? 1.0;
}

export default CubeMapPanorama;
