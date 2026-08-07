import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import Color from "../Core/Color.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import JulianDate from "../Core/JulianDate.js";
import Matrix4 from "../Core/Matrix4.js";
import PixelFormat from "../Core/PixelFormat.js";
import SceneMode from "./SceneMode.js";
import Transforms from "../Core/Transforms.js";
import ComputeCommand from "../Renderer/ComputeCommand.js";
import CubeMap from "../Renderer/CubeMap.js";
import Framebuffer from "../Renderer/Framebuffer.js";
import Texture from "../Renderer/Texture.js";
import PixelDatatype from "../Renderer/PixelDatatype.js";
import Sampler from "../Renderer/Sampler.js";
import ShaderProgram from "../Renderer/ShaderProgram.js";
import ShaderSource from "../Renderer/ShaderSource.js";
import TextureMinificationFilter from "../Renderer/TextureMinificationFilter.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import Atmosphere from "./Atmosphere.js";
import DynamicAtmosphereLightingType from "./DynamicAtmosphereLightingType.js";
// C13-41 — the same eclipse response module the WebGPU environment manager
// imports, so both backends dim the same lockstep scalar on the same grid.
import {
  applyEclipseCloudDimming,
  quantizeEclipseEnvironmentRefreshInput,
  resolveEclipseCloudFactor,
} from "./EclipseCloudResponse.js";
import AtmosphereCommon from "../Shaders/AtmosphereCommon.js";
import ComputeIrradianceFS from "../Shaders/ComputeIrradianceFS.js";
import ComputeRadianceMapFS from "../Shaders/ComputeRadianceMapFS.js";
import ConvolveSpecularMapFS from "../Shaders/ConvolveSpecularMapFS.js";
import ConvolveSpecularMapVS from "../Shaders/ConvolveSpecularMapVS.js";

/**
 * @typedef {object} DynamicEnvironmentMapManager.ConstructorOptions
 * Options for the DynamicEnvironmentMapManager constructor
 * @property {boolean} [enabled=true] If true, the environment map and related properties will continue to update.
 * @property {number} [mipmapLevels=7] The maximum desired number of mipmap levels to generate for specular maps. More mipmap levels will produce a higher resolution specular reflection. The actual number of mipmaps used will be bounded by the cubemap texture size supported on the client machine. The number of mipmaps must be at least one for the environment map to be generated.
 * @property {number} [maximumSecondsDifference=3600] The maximum amount of elapsed seconds before a new environment map is created.
 * @property {number} [maximumPositionEpsilon=1000] The maximum difference in position before a new environment map is created, in meters. Small differences in position will not visibly affect results.
 * @property {number} [atmosphereScatteringIntensity=2.0] The intensity of the scattered light emitted from the atmosphere. This should be adjusted relative to the value of {@link Scene.light} intensity.
 * @property {number} [gamma=1.0] The gamma correction to apply to the range of light emitted from the environment. 1.0 uses the unmodified emitted light color.
 * @property {number} [brightness=1.0] The brightness of light emitted from the environment. 1.0 uses the unmodified emitted environment color. Less than 1.0 makes the light darker while greater than 1.0 makes it brighter.
 * @property {number} [saturation=1.0] The saturation of the light emitted from the environment. 1.0 uses the unmodified emitted environment color. Less than 1.0 reduces the saturation while greater than 1.0 increases it.
 * @property {Color} [groundColor=DynamicEnvironmentMapManager.AVERAGE_EARTH_GROUND_COLOR] Solid color used to represent the ground.
 * @property {number} [groundAlbedo=0.31] The percentage of light reflected from the ground. The average earth albedo is 0.31.
 * @property {DynamicEnvironmentMapManager.ReflectionProxy} [reflectionProxy] WebGPU only. Opt-in bounding proxy (box or sphere) for Lagarde parallax-corrected localized reflections. Default <code>undefined</code> (raw infinitely-distant cube).
 */

/**
 * @typedef {object} DynamicEnvironmentMapManager.ReflectionProxy
 * A bounding proxy used by the WebGPU model renderer to parallax-correct
 * specular IBL reflections (Lagarde box/sphere projection).
 * @property {string} type Either <code>"box"</code> or <code>"sphere"</code>.
 * @property {Cartesian3} center World-space (ECEF) proxy center, in meters.
 * @property {Cartesian3} [halfExtents] World-axis-aligned half-extents, in meters. Required for <code>type: "box"</code>.
 * @property {number} [radius] Proxy radius, in meters. Required for <code>type: "sphere"</code>.
 */

/**
 * Generates an environment map at the given position based on scene's current lighting conditions. From this, it produces multiple levels of specular maps and spherical harmonic coefficients than can be used with {@link ImageBasedLighting} for models or tilesets.
 * @alias DynamicEnvironmentMapManager
 * @constructor
 * @param {DynamicEnvironmentMapManager.ConstructorOptions} [options] An object describing initialization options.
 *
 * @example
 * // Enable time-of-day environment mapping in a scene
 * scene.atmosphere.dynamicLighting = Cesium.DynamicAtmosphereLightingType.SUNLIGHT;
 *
 * // Decrease the directional lighting contribution
 * scene.light.intensity = 0.5
 *
 * // Increase the intensity of of the environment map lighting contribution
 * const environmentMapManager = tileset.environmentMapManager;
 * environmentMapManager.atmosphereScatteringIntensity = 3.0;
 *
 * @example
 * // Change the ground color used for a model's environment map to a forest green
 * const environmentMapManager = model.environmentMapManager;
 * environmentMapManager.groundColor = Cesium.Color.fromCssColorString("#203b34");
 */
class DynamicEnvironmentMapManager {
  constructor(options) {
    this._position = undefined;

    this._radianceMapDirty = false;
    this._radianceCommandsDirty = false;
    this._convolutionsCommandsDirty = false;
    this._irradianceCommandDirty = false;
    this._irradianceTextureDirty = false;
    this._sphericalHarmonicCoefficientsDirty = false;

    this._shouldRegenerateShaders = false;
    this._shouldReset = false;

    options = options ?? Frozen.EMPTY_OBJECT;

    const requestedMipmapLevels = options.mipmapLevels ?? 7;
    const mipmapLevels = Math.max(Math.floor(requestedMipmapLevels), 0);

    this._requestedMipmapLevels = requestedMipmapLevels;
    this._maximumCubeMapSize = undefined;
    this._mipmapLevels = mipmapLevels;

    const arrayLength = Math.max(mipmapLevels - 1, 0) * 6;
    this._radianceMapComputeCommands = new Array(6);
    this._convolutionComputeCommands = new Array(arrayLength);
    this._irradianceComputeCommand = undefined;

    this._radianceMapFS = undefined;
    this._irradianceMapFS = undefined;
    this._convolveSP = undefined;
    this._va = undefined;

    this._radianceMapTextures = new Array(6);
    this._specularMapTextures = new Array(arrayLength);
    this._radianceCubeMap = undefined;
    this._irradianceMapTexture = undefined;

    this._sphericalHarmonicCoefficients =
      DynamicEnvironmentMapManager.DEFAULT_SPHERICAL_HARMONIC_COEFFICIENTS.slice();

    this._lastTime = new JulianDate();
    // C13-41 — the quantized eclipse factor the last radiance bake used. NaN
    // forces the first regeneration test to fire, matching the WebGPU cache's
    // `lastEclipseEnvBucket` convention. Compared as an exact integer LEVEL, so
    // an eclipse ENDING re-bakes just as reliably as one beginning.
    this._lastEclipseEnvBucket = NaN;
    const width = Math.max(Math.pow(2, mipmapLevels - 1), 1);
    this._textureDimensions = new Cartesian2(width, width);

    this._radiiAndDynamicAtmosphereColor = new Cartesian3();
    this._sceneEnvironmentMap = undefined;
    this._backgroundColor = undefined;

    // If this DynamicEnvironmentMapManager has an owner, only its owner should update or destroy it.
    // This is because in a Cesium3DTileset multiple models may reference one tileset's DynamicEnvironmentMapManager.
    this._owner = undefined;

    /**
     * If true, the environment map and related properties will continue to update.
     * @type {boolean}
     * @default true
     */
    this.enabled = options.enabled ?? true;

    /**
     * Disables updates. For internal use.
     * @private
     * @default true
     */
    this.shouldUpdate = true;

    /**
     * The maximum amount of elapsed seconds before a new environment map is created.
     * @type {number}
     * @default 3600
     */
    this.maximumSecondsDifference = options.maximumSecondsDifference ?? 60 * 60;

    /**
     * The maximum difference in position before a new environment map is created, in meters. Small differences in position will not visibly affect results.
     * @type {number}
     * @default 1000
     */
    this.maximumPositionEpsilon = options.maximumPositionEpsilon ?? 1000.0;

    /**
     * The intensity of the scattered light emitted from the atmosphere. This should be adjusted relative to the value of {@link Scene.light} intensity.
     * @type {number}
     * @default 2.0
     * @see DirectionalLight.intensity
     * @see SunLight.intensity
     */
    this.atmosphereScatteringIntensity =
      options.atmosphereScatteringIntensity ?? 2.0;

    /**
     * The gamma correction to apply to the range of light emitted from the environment. 1.0 uses the unmodified incoming light color.
     * @type {number}
     * @default 1.0
     */
    this.gamma = options.gamma ?? 1.0;

    /**
     * The brightness of light emitted from the environment. 1.0 uses the unmodified emitted environment color. Less than 1.0
     * makes the light darker while greater than 1.0 makes it brighter.
     * @type {number}
     * @default 1.0
     */
    this.brightness = options.brightness ?? 1.0;

    /**
     * The saturation of the light emitted from the environment. 1.0 uses the unmodified emitted environment color. Less than 1.0 reduces the
     * saturation while greater than 1.0 increases it.
     * @type {number}
     * @default 1.0
     */
    this.saturation = options.saturation ?? 1.0;

    /**
     * Solid color used to represent the ground.
     * @type {Color}
     * @default DynamicEnvironmentMapManager.AVERAGE_EARTH_GROUND_COLOR
     */
    this.groundColor =
      options.groundColor ??
      DynamicEnvironmentMapManager.AVERAGE_EARTH_GROUND_COLOR;

    /**
     * The percentage of light reflected from the ground. The average earth albedo is 0.31.
     * @type {number}
     * @default 0.31
     */
    this.groundAlbedo = options.groundAlbedo ?? 0.31;

    /**
     * C2-25 ENV-SCENE-CAPTURE (Batch 446, WebGPU only) — opt-in flag that, when
     * paired with the context option <code>contextOptions.webgpu.sceneCaptureReflections</code>,
     * renders the opaque globe surface (later: 3D Tiles + glTF) into the dynamic
     * environment cube's 6 faces from 6 ENU cube-face cameras, so terrain
     * appears in water / PBR reflections instead of just procedural sky.
     * Default <code>false</code> — both this flag AND the context option must be
     * true for any capture pass to run; when either is false the env cube is
     * filled only by the procedural sky (byte-identical to the shipped path).
     * Ignored on WebGL.
     * @type {boolean}
     * @default false
     */
    this.enableSceneCapture = options.enableSceneCapture ?? false;

    /**
     * C2-25 ENV-PARALLAX (Batch 451, WebGPU only) — opt-in localized-reflection
     * proxy for Lagarde box/sphere parallax correction. When set, models lit by
     * this manager's environment map intersect their specular-IBL reflection ray
     * with this bounding proxy and re-project the cube fetch as
     * <code>normalize(P - center)</code>, so nearby geometry / interiors reflect
     * at the correct parallax instead of as an infinitely-distant cube. When
     * <code>undefined</code> (the default) the raw reflection vector is used —
     * byte-identical to the shipped path. Ignored on WebGL.
     *
     * The proxy is an object of the form:
     * <pre><code>
     * // Box proxy (world-axis-aligned):
     * { type: "box", center: Cartesian3, halfExtents: Cartesian3 }
     * // Sphere proxy:
     * { type: "sphere", center: Cartesian3, radius: Number }
     * </code></pre>
     * <code>center</code> and <code>halfExtents</code> are world-space
     * (ECEF) Cartesian3 in meters; <code>radius</code> is meters.
     *
     * @type {DynamicEnvironmentMapManager.ReflectionProxy|undefined}
     * @default undefined
     *
     * @example
     * // Reflect a nearby wall plausibly in a metallic model sitting in front of it
     * model.environmentMapManager.reflectionProxy = {
     *   type: "box",
     *   center: Cesium.Cartesian3.fromDegrees(-75.0, 40.0, 5.0),
     *   halfExtents: new Cesium.Cartesian3(10.0, 10.0, 10.0),
     * };
     */
    this.reflectionProxy = options.reflectionProxy ?? undefined;
  }

  /**
   * Cancels any in-progress commands and marks the environment map as dirty.
   * @private
   */
  reset() {
    let length = this._radianceMapComputeCommands.length;
    for (let i = 0; i < length; ++i) {
      if (defined(this._radianceMapComputeCommands[i])) {
        this._radianceMapComputeCommands[i].canceled = true;
      }
      this._radianceMapComputeCommands[i] = undefined;
    }

    length = this._convolutionComputeCommands.length;
    for (let i = 0; i < length; ++i) {
      if (defined(this._convolutionComputeCommands[i])) {
        this._convolutionComputeCommands[i].canceled = true;
      }
      this._convolutionComputeCommands[i] = undefined;
    }

    if (defined(this._irradianceComputeCommand)) {
      this._irradianceComputeCommand.canceled = true;
      this._irradianceComputeCommand = undefined;
    }

    this._radianceMapDirty = true;
    this._radianceCommandsDirty = true;
    this._convolutionsCommandsDirty = false;
    this._irradianceCommandDirty = false;
  }

  /**
   * Called when {@link Viewer} or {@link CesiumWidget} render the scene to
   * build the resources for the environment maps.
   * <p>
   * Do not call this function directly.
   * </p>
   * @private
   */
  update(frameState) {
    configureMipmapLevels(this, frameState.context.limits.maximumCubeMapSize);

    // Route to WebGPU feature renderer if available
    const fr = frameState.context.getFeatureRenderer(
      FeatureRendererKey.DYNAMIC_ENVIRONMENT_MAP,
    );
    if (fr) {
      fr.update(this, frameState);
      this._featureRenderer = fr;
      return;
    }

    const mode = frameState.mode;
    const isSupported =
      // @ts-expect-error A FrameState type works here because the function only references the context parameter.
      DynamicEnvironmentMapManager.isDynamicUpdateSupported(frameState) &&
      this._mipmapLevels >= 1;

    if (
      !isSupported ||
      !this.enabled ||
      !this.shouldUpdate ||
      !defined(this._position) ||
      mode === SceneMode.MORPHING
    ) {
      this._shouldRegenerateShaders = false;
      return;
    }

    DynamicEnvironmentMapManager._updateCommandQueue(frameState);

    const dynamicLighting = frameState.atmosphere.dynamicLighting;
    // C13-41 — the eclipse-keyed regeneration input, the WebGL twin of the
    // WebGPU cache's `eclipseEnvChanged`. `updateRadianceMap` now dims its bake
    // by S2's scene-light factor, and nothing else in this gate can see that:
    // `atmosphereNeedsUpdate` only watches radii / dynamic-lighting mode /
    // scene environment map / background colour, and the scene-clock term needs
    // `maximumSecondsDifference` (3600 s by default) AND the SUNLIGHT mode. A
    // dimmed bake would therefore stay dark for up to an hour after third
    // contact. Snap-and-compare on the shared 1/256 grid, as an exact integer
    // LEVEL — so an eclipse ending regenerates exactly as reliably as one
    // starting, with no second "recovery" code path.
    const eclipseEnvBucket = quantizeEclipseEnvironmentRefreshInput(
      resolveEclipseCloudFactor(frameState),
    );
    const regenerateEnvironmentMap =
      atmosphereNeedsUpdate(this, frameState) ||
      eclipseEnvBucket !== this._lastEclipseEnvBucket ||
      (dynamicLighting === DynamicAtmosphereLightingType.SUNLIGHT &&
        !JulianDate.equalsEpsilon(
          frameState.time,
          this._lastTime,
          this.maximumSecondsDifference,
        ));

    if (this._shouldReset || regenerateEnvironmentMap) {
      this.reset();
      this._shouldReset = false;
      this._lastTime = JulianDate.clone(frameState.time, this._lastTime);
      this._lastEclipseEnvBucket = eclipseEnvBucket;
      return;
    }

    if (this._radianceMapDirty) {
      updateRadianceMap(this, frameState);
      this._radianceMapDirty = false;
    }

    if (this._convolutionsCommandsDirty) {
      updateSpecularMaps(this, frameState);
      this._convolutionsCommandsDirty = false;
    }

    if (this._irradianceCommandDirty) {
      updateIrradianceResources(this, frameState);
      this._irradianceCommandDirty = false;
    }

    if (this._irradianceTextureDirty) {
      this._shouldRegenerateShaders = false;
      return;
    }

    if (this._sphericalHarmonicCoefficientsDirty) {
      updateSphericalHarmonicCoefficients(this, frameState);
      this._sphericalHarmonicCoefficientsDirty = false;
      return;
    }

    this._shouldRegenerateShaders = false;
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * <br /><br />
   * If this object was destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   * @see DynamicEnvironmentMapManager#destroy
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
   * @throws {DeveloperError} This object was destroyed, i.e., destroy() was called.
   * @example
   * mapManager = mapManager && mapManager.destroy();
   * @see DynamicEnvironmentMapManager#isDestroyed
   */
  destroy() {
    // Cancel in-progress commands
    let length = this._radianceMapComputeCommands.length;
    for (let i = 0; i < length; ++i) {
      this._radianceMapComputeCommands[i] = undefined;
    }

    length = this._convolutionComputeCommands.length;
    for (let i = 0; i < length; ++i) {
      this._convolutionComputeCommands[i] = undefined;
    }

    this._irradianceMapComputeCommand = undefined;

    // Destroy all textures
    length = this._radianceMapTextures.length;
    for (let i = 0; i < length; ++i) {
      this._radianceMapTextures[i] =
        this._radianceMapTextures[i] &&
        !this._radianceMapTextures[i].isDestroyed() &&
        this._radianceMapTextures[i].destroy();
    }

    length = this._specularMapTextures.length;
    for (let i = 0; i < length; ++i) {
      this._specularMapTextures[i] =
        this._specularMapTextures[i] &&
        !this._specularMapTextures[i].isDestroyed() &&
        this._specularMapTextures[i].destroy();
    }

    this._radianceCubeMap =
      this._radianceCubeMap && this._radianceCubeMap.destroy();
    this._irradianceMapTexture =
      this._irradianceMapTexture &&
      !this._irradianceMapTexture.isDestroyed() &&
      this._irradianceMapTexture.destroy();

    if (defined(this._va)) {
      this._va.destroy();
    }

    if (defined(this._convolveSP)) {
      this._convolveSP.destroy();
    }

    if (this._featureRenderer) {
      this._featureRenderer.destroy(this);
    }
    return destroyObject(this);
  }

  /**
   * A reference to the DynamicEnvironmentMapManager's owner, if any.
   * @type {object|undefined}
   * @readonly
   * @private
   */
  get owner() {
    return this._owner;
  }

  /**
   * True if model shaders need to be regenerated to account for updates.
   * @type {boolean}
   * @readonly
   * @private
   */
  get shouldRegenerateShaders() {
    return this._shouldRegenerateShaders;
  }

  /**
   * The position around which the environment map is generated.
   * @type {Cartesian3|undefined}
   */
  get position() {
    return this._position;
  }

  set position(value) {
    if (
      Cartesian3.equalsEpsilon(
        value,
        this._position,
        0.0,
        this.maximumPositionEpsilon,
      )
    ) {
      return;
    }

    this._position = Cartesian3.clone(value, this._position);
    this._shouldReset = true;
  }

  /**
   * The computed radiance map, or <code>undefined</code> if it has not yet been created.
   * @type {CubeMap|undefined}
   * @readonly
   * @private
   */
  get radianceCubeMap() {
    return this._radianceCubeMap;
  }

  /**
   * The maximum number of mip levels available in the radiance cubemap.
   * @type {number}
   * @readonly
   * @private
   */
  get maximumMipmapLevel() {
    return this._mipmapLevels;
  }

  /**
   * The third order spherical harmonic coefficients used for the diffuse color of image-based lighting.
   * <p>
   * There are nine <code>Cartesian3</code> coefficients.
   * The order of the coefficients is: L<sub>0,0</sub>, L<sub>1,-1</sub>, L<sub>1,0</sub>, L<sub>1,1</sub>, L<sub>2,-2</sub>, L<sub>2,-1</sub>, L<sub>2,0</sub>, L<sub>2,1</sub>, L<sub>2,2</sub>
   * </p>
   * @readonly
   * @type {Cartesian3[]}
   * @see {@link https://graphics.stanford.edu/papers/envmap/envmap.pdf|An Efficient Representation for Irradiance Environment Maps}
   * @private
   */
  get sphericalHarmonicCoefficients() {
    return this._sphericalHarmonicCoefficients;
  }
}

function configureMipmapLevels(manager, maximumCubeMapSize) {
  if (manager._maximumCubeMapSize === maximumCubeMapSize) {
    return;
  }

  const mipmapLevels = Math.max(
    Math.floor(
      Math.min(manager._requestedMipmapLevels, Math.log2(maximumCubeMapSize)),
    ),
    0,
  );
  manager._maximumCubeMapSize = maximumCubeMapSize;

  if (manager._mipmapLevels === mipmapLevels) {
    return;
  }

  manager.reset();

  for (const texture of manager._radianceMapTextures) {
    if (defined(texture) && !texture.isDestroyed()) {
      texture.destroy();
    }
  }
  for (const texture of manager._specularMapTextures) {
    if (defined(texture) && !texture.isDestroyed()) {
      texture.destroy();
    }
  }
  if (defined(manager._radianceCubeMap)) {
    manager._radianceCubeMap = manager._radianceCubeMap.destroy();
  }

  manager._mipmapLevels = mipmapLevels;
  const arrayLength = Math.max(mipmapLevels - 1, 0) * 6;
  manager._convolutionComputeCommands = new Array(arrayLength);
  manager._specularMapTextures = new Array(arrayLength);
  manager._radianceMapTextures = new Array(6);

  const width = Math.max(Math.pow(2, mipmapLevels - 1), 1);
  manager._textureDimensions.x = width;
  manager._textureDimensions.y = width;
  manager._shouldRegenerateShaders = true;
}

// Commands and GPU resources are context-bound. A WeakMap prevents work
// queued by one renderer from being submitted to another renderer's command
// list while still sharing a budget among managers in the same context.
const commandQueuesByContext = new WeakMap();

function getCommandQueue(frameState) {
  const context = frameState.context;
  let queue = commandQueuesByContext.get(context);
  if (!defined(queue)) {
    queue = {
      maximumComputeCommandCount: Math.max(
        Math.floor(Math.log2(context.limits.maximumCubeMapSize)),
        1,
      ),
      activeComputeCommandCount: 0,
      nextFrameCommandQueue: [],
    };
    commandQueuesByContext.set(context, queue);
  }
  return queue;
}

function releaseCommandBudget(command) {
  const queue = command._dynamicEnvironmentQueue;
  if (defined(queue)) {
    queue.activeComputeCommandCount = Math.max(
      queue.activeComputeCommandCount - 1,
      0,
    );
    command._dynamicEnvironmentQueue = undefined;
  }
}
/**
 * Add a command to the queue. If possible, it will be added to the list of commands for the next frame. Otherwise, it will be added to a backlog
 * and attempted next frame.
 * @private
 * @param {ComputeCommand} command The created command
 * @param {FrameState} frameState The current frame state
 */
DynamicEnvironmentMapManager._queueCommand = (command, frameState) => {
  const queue = getCommandQueue(frameState);
  if (queue.activeComputeCommandCount >= queue.maximumComputeCommandCount) {
    // Command will instead be scheduled next frame
    queue.nextFrameCommandQueue.push(command);
    return;
  }

  frameState.commandList.push(command);
  queue.activeComputeCommandCount++;
  command._dynamicEnvironmentQueue = queue;
};
/**
 * If there are any backlogged commands, queue up as many as possible for the next frame.
 * @private
 * @param {FrameState} frameState The current frame state
 */
DynamicEnvironmentMapManager._updateCommandQueue = (frameState) => {
  const queue = getCommandQueue(frameState);
  queue.maximumComputeCommandCount = Math.max(
    Math.floor(Math.log2(frameState.context.limits.maximumCubeMapSize)),
    1,
  );

  if (
    queue.nextFrameCommandQueue.length > 0 &&
    queue.activeComputeCommandCount < queue.maximumComputeCommandCount
  ) {
    let command = queue.nextFrameCommandQueue.shift();
    while (
      defined(command) &&
      queue.activeComputeCommandCount < queue.maximumComputeCommandCount
    ) {
      if (command.owner.isDestroyed() || command.canceled) {
        command = queue.nextFrameCommandQueue.shift();
        continue;
      }

      frameState.commandList.push(command);
      queue.activeComputeCommandCount++;
      command._dynamicEnvironmentQueue = queue;
      command = queue.nextFrameCommandQueue.shift();
    }

    if (defined(command)) {
      queue.nextFrameCommandQueue.push(command);
    }
  }
};

/**
 * Sets the owner for the input DynamicEnvironmentMapManager if there wasn't another owner.
 * Destroys the owner's previous DynamicEnvironmentMapManager if setting is successful.
 * @param {DynamicEnvironmentMapManager} [environmentMapManager] A DynamicEnvironmentMapManager (or undefined) being attached to an object
 * @param {object} owner An Object that should receive the new DynamicEnvironmentMapManager
 * @param {string} key The Key for the Object to reference the DynamicEnvironmentMapManager
 * @private
 */
DynamicEnvironmentMapManager.setOwner = function (
  environmentMapManager,
  owner,
  key,
) {
  // Don't destroy the DynamicEnvironmentMapManager if it's already owned by newOwner
  if (environmentMapManager === owner[key]) {
    return;
  }
  // Destroy the existing DynamicEnvironmentMapManager, if any
  owner[key] = owner[key] && owner[key].destroy();
  if (defined(environmentMapManager)) {
    //>>includeStart('debug', pragmas.debug);
    if (defined(environmentMapManager._owner)) {
      throw new DeveloperError(
        "DynamicEnvironmentMapManager should only be assigned to one object",
      );
    }
    //>>includeEnd('debug');
    environmentMapManager._owner = owner;
    owner[key] = environmentMapManager;
  }
};

const scratchPackedAtmosphere = new Cartesian3();
const scratchSurfacePosition = new Cartesian3();

/**
 * Update atmosphere properties and returns true if the environment map needs to be regenerated.
 * @param {DynamicEnvironmentMapManager} manager this manager
 * @param {FrameState} frameState the current frameState
 * @returns {boolean} true if the environment map needs to be regenerated.
 * @private
 */
function atmosphereNeedsUpdate(manager, frameState) {
  const position = manager._position;
  const atmosphere = frameState.atmosphere;

  const ellipsoid = frameState.mapProjection.ellipsoid;
  const surfacePosition = ellipsoid.scaleToGeodeticSurface(
    position,
    scratchSurfacePosition,
  );
  const outerEllipsoidScale = 1.025;

  // Pack outer radius, inner radius, and dynamic atmosphere flag
  const radiiAndDynamicAtmosphereColor = scratchPackedAtmosphere;
  const radius = defined(surfacePosition)
    ? Cartesian3.magnitude(surfacePosition)
    : ellipsoid.maximumRadius;
  radiiAndDynamicAtmosphereColor.x = radius * outerEllipsoidScale;
  radiiAndDynamicAtmosphereColor.y = radius;
  radiiAndDynamicAtmosphereColor.z = atmosphere.dynamicLighting;

  if (
    !Cartesian3.equalsEpsilon(
      manager._radiiAndDynamicAtmosphereColor,
      radiiAndDynamicAtmosphereColor,
    ) ||
    frameState.environmentMap !== manager._sceneEnvironmentMap ||
    frameState.backgroundColor !== manager._backgroundColor
  ) {
    Cartesian3.clone(
      radiiAndDynamicAtmosphereColor,
      manager._radiiAndDynamicAtmosphereColor,
    );
    manager._sceneEnvironmentMap = frameState.environmentMap;
    manager._backgroundColor = frameState.backgroundColor;
    return true;
  }

  return false;
}

const scratchCartesian = new Cartesian3();
const scratchMatrix = new Matrix4();
const scratchAdjustments = new Cartesian4();
const scratchColor = new Color();

/**
 * Renders the highest resolution specular map by creating compute commands for each cube face
 * @param {DynamicEnvironmentMapManager} manager this manager
 * @param {FrameState} frameState the current frameState
 * @private
 */
function updateRadianceMap(manager, frameState) {
  const context = frameState.context;
  const textureDimensions = manager._textureDimensions;

  if (!defined(manager._radianceCubeMap)) {
    manager._radianceCubeMap = new CubeMap({
      context: context,
      width: textureDimensions.x,
      height: textureDimensions.y,
      pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
      pixelFormat: PixelFormat.RGBA,
    });
  }

  if (manager._radianceCommandsDirty) {
    let fs = manager._radianceMapFS;
    if (!defined(fs)) {
      fs = new ShaderSource({
        sources: [AtmosphereCommon, ComputeRadianceMapFS],
      });
      manager._radianceMapFS = fs;
    }

    if (Atmosphere.requiresColorCorrect(frameState.atmosphere)) {
      fs.defines.push("ATMOSPHERE_COLOR_CORRECT");
    }

    const position = manager._position;
    const radiiAndDynamicAtmosphereColor =
      manager._radiiAndDynamicAtmosphereColor;

    const ellipsoid = frameState.mapProjection.ellipsoid;
    const enuToFixedFrame = Transforms.eastNorthUpToFixedFrame(
      position,
      ellipsoid,
      scratchMatrix,
    );

    const adjustments = scratchAdjustments;

    adjustments.x = manager.brightness;
    adjustments.y = manager.saturation;
    adjustments.z = manager.gamma;
    // C13-41 — the eclipse dims this bake. `.w` reaches the shader as
    // `u_brightnessSaturationGammaIntensity.w`, the multiplier on the FINAL sky
    // and ground radiance in `ComputeRadianceMapFS.glsl`, and is the exact
    // lockstep twin of WebGPU's `SkyUniforms.scatteringIntensity` (slot 34) —
    // so neither backend needs a shader edit and neither can drift. The
    // step-3 `updateSphericalHarmonicCoefficients` multiply is deliberately NOT
    // dimmed on either backend: it projects THIS bake and inherits the dimming
    // exactly once. Safe only because the regeneration gate in `update()` now
    // carries the quantized eclipse bucket; without it this would latch dark.
    adjustments.w = applyEclipseCloudDimming(
      manager.atmosphereScatteringIntensity,
      resolveEclipseCloudFactor(frameState),
    );

    if (
      manager.brightness !== 1.0 ||
      manager.saturation !== 1.0 ||
      manager.gamma !== 1.0
    ) {
      fs.defines.push("ENVIRONMENT_COLOR_CORRECT");
    }

    let i = 0;
    for (const face of CubeMap.faceNames()) {
      let texture = manager._radianceMapTextures[i];
      // Destroy any existing textures that have no yet been cleaned up
      if (defined(texture) && !texture.isDestroyed()) {
        texture.destroy();
      }

      texture = new Texture({
        context: context,
        width: textureDimensions.x,
        height: textureDimensions.y,
        pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
        pixelFormat: PixelFormat.RGBA,
      });
      manager._radianceMapTextures[i] = texture;

      const index = i;
      const command = new ComputeCommand({
        fragmentShaderSource: fs,
        outputTexture: texture,
        uniformMap: {
          u_radiiAndDynamicAtmosphereColor: () =>
            radiiAndDynamicAtmosphereColor,
          u_enuToFixedFrame: () => enuToFixedFrame,
          u_faceDirection: () => CubeMap.getDirection(face, scratchCartesian),
          u_positionWC: () => position,
          u_brightnessSaturationGammaIntensity: () => adjustments,
          u_groundColor: () => {
            return manager.groundColor.withAlpha(
              manager.groundAlbedo,
              scratchColor,
            );
          },
        },
        owner: manager,
      });
      command.postExecute = () => {
        if (manager.isDestroyed() || command.canceled) {
          releaseCommandBudget(command);
          return;
        }

        const commands = manager._radianceMapComputeCommands;
        commands[index] = undefined;

        const framebuffer = new Framebuffer({
          context: context,
          colorTextures: [manager._radianceMapTextures[index]],
        });

        // Copy the output texture into the corresponding cubemap face
        framebuffer._bind();
        manager._radianceCubeMap[face].copyFromFramebuffer();
        framebuffer._unBind();
        framebuffer.destroy();

        releaseCommandBudget(command);

        if (!commands.some(defined)) {
          manager._convolutionsCommandsDirty = true;
          manager._shouldRegenerateShaders = true;
        }
      };

      manager._radianceMapComputeCommands[i] = command;
      DynamicEnvironmentMapManager._queueCommand(command, frameState);
      i++;
    }
    manager._radianceCommandsDirty = false;
  }
}

/**
 * Creates a mipmap chain for the cubemap by convolving the environment map for each roughness level
 * @param {DynamicEnvironmentMapManager} manager this manager
 * @param {FrameState} frameState the current frameState
 * @private
 */
function updateSpecularMaps(manager, frameState) {
  const radianceCubeMap = manager._radianceCubeMap;
  radianceCubeMap.generateMipmap();

  const mipmapLevels = manager._mipmapLevels;
  const textureDimensions = manager._textureDimensions;
  let width = textureDimensions.x / 2;
  let height = textureDimensions.y / 2;
  const context = frameState.context;

  let facesCopied = 0;
  const checkComplete = () => {
    // All faces for each mipmap level have been copied
    const length = manager._specularMapTextures.length;
    if (facesCopied >= length) {
      manager._irradianceCommandDirty = true;

      if (mipmapLevels > 1) {
        radianceCubeMap.sampler = new Sampler({
          minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
        });

        manager._shouldRegenerateShaders = true;

        // Cleanup shared resources
        manager._va.destroy();
        manager._va = undefined;
        manager._convolveSP.destroy();
        manager._convolveSP = undefined;
      }
    }
  };

  const getPostExecute = (command, index, texture, face, level) => () => {
    if (manager.isDestroyed() || command.canceled) {
      releaseCommandBudget(command);
      return;
    }

    // Copy output texture to corresponding face and mipmap level
    const commands = manager._convolutionComputeCommands;
    commands[index] = undefined;

    radianceCubeMap.copyFace(frameState, texture, face, level);
    facesCopied++;
    releaseCommandBudget(command);

    texture.destroy();
    manager._specularMapTextures[index] = undefined;

    checkComplete();
  };

  let index = 0;
  for (let level = 1; level < mipmapLevels; ++level) {
    for (const face of CubeMap.faceNames()) {
      if (defined(manager._specularMapTextures[index])) {
        manager._specularMapTextures[index].destroy();
      }

      const texture = (manager._specularMapTextures[index] = new Texture({
        context: context,
        width: width,
        height: height,
        pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
        pixelFormat: PixelFormat.RGBA,
      }));

      let vertexArray = manager._va;
      if (!defined(vertexArray)) {
        vertexArray = CubeMap.createVertexArray(context, face);
        manager._va = vertexArray;
      }

      let shaderProgram = manager._convolveSP;
      if (!defined(shaderProgram)) {
        shaderProgram = ShaderProgram.fromCache({
          context: context,
          vertexShaderSource: ConvolveSpecularMapVS,
          fragmentShaderSource: ConvolveSpecularMapFS,
          attributeLocations: {
            positions: 0,
          },
        });
        manager._convolveSP = shaderProgram;
      }

      const command = new ComputeCommand({
        shaderProgram: shaderProgram,
        vertexArray: vertexArray,
        outputTexture: texture,
        // Persist so we can use a shared shader progam and vertex array across all commands
        // Shared resources are instead destroyed in postExecute
        persists: true,
        owner: manager,
        uniformMap: {
          u_roughness: () => level / (mipmapLevels - 1),
          u_radianceTexture: () => radianceCubeMap ?? context.defaultTexture,
          u_faceDirection: () => {
            return CubeMap.getDirection(face, scratchCartesian);
          },
        },
      });
      command.postExecute = getPostExecute(
        command,
        index,
        texture,
        face,
        level,
      );
      manager._convolutionComputeCommands[index] = command;
      DynamicEnvironmentMapManager._queueCommand(command, frameState);
      ++index;
    }

    width /= 2;
    height /= 2;
  }
  checkComplete();
}

const irradianceTextureDimensions = new Cartesian2(3, 3); // 9 coefficients

/**
 * Computes spherical harmonic coefficients by convolving the environment map.
 * @param {DynamicEnvironmentMapManager} manager this manager
 * @param {FrameState} frameState the current frameState
 * @private
 */
function updateIrradianceResources(manager, frameState) {
  const context = frameState.context;
  const dimensions = irradianceTextureDimensions;

  let texture = manager._irradianceMapTexture;
  if (defined(texture) && !texture.isDestroyed()) {
    texture.destroy();
  }

  texture = new Texture({
    context: context,
    width: dimensions.x,
    height: dimensions.y,
    pixelDatatype: PixelDatatype.FLOAT,
    pixelFormat: PixelFormat.RGBA,
  });
  manager._irradianceMapTexture = texture;

  let fs = manager._irradianceMapFS;
  if (!defined(fs)) {
    fs = new ShaderSource({
      sources: [ComputeIrradianceFS],
    });
    manager._irradianceMapFS = fs;
  }

  const command = new ComputeCommand({
    fragmentShaderSource: fs,
    outputTexture: texture,
    owner: manager,
    uniformMap: {
      u_radianceMap: () => manager._radianceCubeMap ?? context.defaultTexture,
    },
  });

  command.postExecute = () => {
    if (manager.isDestroyed() || command.canceled) {
      releaseCommandBudget(command);
      return;
    }
    manager._irradianceTextureDirty = false;
    manager._irradianceComputeCommand = undefined;
    manager._sphericalHarmonicCoefficientsDirty = true;
    manager._irradianceMapFS = undefined;

    releaseCommandBudget(command);
  };

  manager._irradianceComputeCommand = command;
  DynamicEnvironmentMapManager._queueCommand(command, frameState);
  manager._irradianceTextureDirty = true;
}

/**
 * Copies coefficients from the output texture using readPixels.
 * @param {DynamicEnvironmentMapManager} manager this manager
 * @param {FrameState} frameState the current frameState
 * @private
 */
function updateSphericalHarmonicCoefficients(manager, frameState) {
  const context = frameState.context;

  if (!defined(manager._irradianceMapTexture)) {
    // Operation was canceled
    return;
  }

  const framebuffer = new Framebuffer({
    context: context,
    colorTextures: [manager._irradianceMapTexture],
    destroyAttachments: false,
  });

  const dimensions = irradianceTextureDimensions;
  const data = context.readPixels({
    x: 0,
    y: 0,
    width: dimensions.x,
    height: dimensions.y,
    framebuffer: framebuffer,
  });

  for (let i = 0; i < 9; ++i) {
    manager._sphericalHarmonicCoefficients[i] = Cartesian3.unpack(data, i * 4);
    Cartesian3.multiplyByScalar(
      manager._sphericalHarmonicCoefficients[i],
      manager.atmosphereScatteringIntensity,
      manager._sphericalHarmonicCoefficients[i],
    );
  }

  framebuffer.destroy();
  manager._irradianceMapTexture.destroy();
  manager._irradianceMapTexture = undefined;
  manager._shouldRegenerateShaders = true;
}

/**
 * Returns <code>true</code> if dynamic updates are supported in the current WebGL rendering context.
 * Dynamic updates requires the EXT_color_buffer_float or EXT_color_buffer_half_float extension.
 *
 * @param {Scene} scene The object containing the rendering context
 * @returns {boolean} true if supported
 */
DynamicEnvironmentMapManager.isDynamicUpdateSupported = function (scene) {
  const context = scene.context;
  return context.halfFloatingPointTexture || context.colorBufferFloat;
};

/**
 * Average hue of ground color on earth, a warm green-gray.
 * @type {Color}
 * @readonly
 */
DynamicEnvironmentMapManager.AVERAGE_EARTH_GROUND_COLOR = Object.freeze(
  Color.fromCssColorString("#717145"),
);

/**
 * The default third order spherical harmonic coefficients used for the diffuse color of image-based lighting, a white ambient light with low intensity.
 * <p>
 * There are nine <code>Cartesian3</code> coefficients.
 * The order of the coefficients is: L<sub>0,0</sub>, L<sub>1,-1</sub>, L<sub>1,0</sub>, L<sub>1,1</sub>, L<sub>2,-2</sub>, L<sub>2,-1</sub>, L<sub>2,0</sub>, L<sub>2,1</sub>, L<sub>2,2</sub>
 * </p>
 * @readonly
 * @type {Cartesian3[]}
 * @see {@link https://graphics.stanford.edu/papers/envmap/envmap.pdf|An Efficient Representation for Irradiance Environment Maps}
 */
DynamicEnvironmentMapManager.DEFAULT_SPHERICAL_HARMONIC_COEFFICIENTS =
  Object.freeze([
    Object.freeze(new Cartesian3(0.35449, 0.35449, 0.35449)),
    Cartesian3.ZERO,
    Cartesian3.ZERO,
    Cartesian3.ZERO,
    Cartesian3.ZERO,
    Cartesian3.ZERO,
    Cartesian3.ZERO,
    Cartesian3.ZERO,
    Cartesian3.ZERO,
  ]);

export default DynamicEnvironmentMapManager;
