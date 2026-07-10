import BoundingSphere from "../Core/BoundingSphere.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import Cartographic from "../Core/Cartographic.js";
import clone from "../Core/clone.js";
import Color from "../Core/Color.js";
import combine from "../Core/combine.js";
import CullingVolume from "../Core/CullingVolume.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import FeatureDetection from "../Core/FeatureDetection.js";
import Matrix4 from "../Core/Matrix4.js";
import OrthographicOffCenterFrustum from "../Core/OrthographicOffCenterFrustum.js";
import ClearCommand from "../Renderer/ClearCommand.js";
import DrawCommand from "../Renderer/DrawCommand.js";
import Pass from "../Renderer/Pass.js";
import PassState from "../Renderer/PassState.js";
import RenderState from "../Renderer/RenderState.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import CullFace from "./CullFace.js";
import ShadowMapShader from "./ShadowMapShader.js";
import {
  destroyFramebuffer,
  updateFramebuffer,
  clearFramebuffer,
  resize,
  updateCameras,
  computeCascades,
  fitShadowMapToScene,
  computeOmnidirectional,
  applyDebugSettings,
} from "./ShadowMapComputations.js";

/**
 * @private
 */
class ShadowMapCamera {
  constructor() {
    this.viewMatrix = new Matrix4();
    this.inverseViewMatrix = new Matrix4();
    this.frustum = undefined;
    this.positionCartographic = new Cartographic();
    this.positionWC = new Cartesian3();
    this.directionWC = Cartesian3.clone(Cartesian3.UNIT_Z);
    this.upWC = Cartesian3.clone(Cartesian3.UNIT_Y);
    this.rightWC = Cartesian3.clone(Cartesian3.UNIT_X);
    this.viewProjectionMatrix = new Matrix4();
  }

  clone(camera) {
    Matrix4.clone(camera.viewMatrix, this.viewMatrix);
    Matrix4.clone(camera.inverseViewMatrix, this.inverseViewMatrix);
    this.frustum = camera.frustum.clone(this.frustum);
    Cartographic.clone(camera.positionCartographic, this.positionCartographic);
    Cartesian3.clone(camera.positionWC, this.positionWC);
    Cartesian3.clone(camera.directionWC, this.directionWC);
    Cartesian3.clone(camera.upWC, this.upWC);
    Cartesian3.clone(camera.rightWC, this.rightWC);
  }

  getViewProjection() {
    const view = this.viewMatrix;
    const projection = this.frustum.projectionMatrix;
    Matrix4.multiply(projection, view, this.viewProjectionMatrix);
    Matrix4.multiply(
      scaleBiasMatrix,
      this.viewProjectionMatrix,
      this.viewProjectionMatrix,
    );
    return this.viewProjectionMatrix;
  }
}

// Converts from NDC space to texture space
const scaleBiasMatrix = new Matrix4(
  0.5,
  0.0,
  0.0,
  0.5,
  0.0,
  0.5,
  0.0,
  0.5,
  0.0,
  0.0,
  0.5,
  0.5,
  0.0,
  0.0,
  0.0,
  1.0,
);

/**
 * @private
 */
class ShadowPass {
  constructor(context) {
    this.camera = new ShadowMapCamera();
    this.passState = new PassState(context);
    this.framebuffer = undefined;
    this.textureOffsets = undefined;
    this.commandList = [];
    this.cullingVolume = undefined;
  }
}

function createRenderState(colorMask, bias) {
  return RenderState.fromCache({
    cull: {
      enabled: true,
      face: CullFace.BACK,
    },
    depthTest: {
      enabled: true,
    },
    colorMask: {
      red: colorMask,
      green: colorMask,
      blue: colorMask,
      alpha: colorMask,
    },
    depthMask: true,
    polygonOffset: {
      enabled: bias.polygonOffset,
      factor: bias.polygonOffsetFactor,
      units: bias.polygonOffsetUnits,
    },
  });
}

const scratchTexelStepSize = new Cartesian2();

function combineUniforms(shadowMap, uniforms, isTerrain) {
  const bias = shadowMap._isPointLight
    ? shadowMap._pointBias
    : isTerrain
      ? shadowMap._terrainBias
      : shadowMap._primitiveBias;

  const mapUniforms = {
    shadowMap_texture: function () {
      return shadowMap._shadowMapTexture;
    },
    shadowMap_textureCube: function () {
      return shadowMap._shadowMapTexture;
    },
    shadowMap_matrix: function () {
      return shadowMap._shadowMapMatrix;
    },
    shadowMap_cascadeSplits: function () {
      return shadowMap._cascadeSplits;
    },
    shadowMap_cascadeMatrices: function () {
      return shadowMap._cascadeMatrices;
    },
    shadowMap_lightDirectionEC: function () {
      return shadowMap._lightDirectionEC;
    },
    shadowMap_lightPositionEC: function () {
      return shadowMap._lightPositionEC;
    },
    shadowMap_cascadeDistances: function () {
      return shadowMap._cascadeDistances;
    },
    shadowMap_texelSizeDepthBiasAndNormalShadingSmooth: function () {
      const texelStepSize = scratchTexelStepSize;
      texelStepSize.x = 1.0 / shadowMap._textureSize.x;
      texelStepSize.y = 1.0 / shadowMap._textureSize.y;

      return Cartesian4.fromElements(
        texelStepSize.x,
        texelStepSize.y,
        bias.depthBias,
        bias.normalShadingSmooth,
        this.combinedUniforms1,
      );
    },
    shadowMap_normalOffsetScaleDistanceMaxDistanceAndDarkness: function () {
      return Cartesian4.fromElements(
        bias.normalOffsetScale,
        shadowMap._distance,
        shadowMap.maximumDistance,
        shadowMap._darkness,
        this.combinedUniforms2,
      );
    },

    combinedUniforms1: new Cartesian4(),
    combinedUniforms2: new Cartesian4(),
  };

  return combine(uniforms, mapUniforms, false);
}

function createCastDerivedCommand(
  shadowMap,
  shadowsDirty,
  command,
  context,
  oldShaderId,
  result,
) {
  let castShader;
  let castRenderState;
  let castUniformMap;
  if (defined(result)) {
    castShader = result.shaderProgram;
    castRenderState = result.renderState;
    castUniformMap = result.uniformMap;
  }

  result = DrawCommand.shallowClone(command, result);
  result.castShadows = true;
  result.receiveShadows = false;

  if (
    !defined(castShader) ||
    oldShaderId !== command.shaderProgram.id ||
    shadowsDirty
  ) {
    const shaderProgram = command.shaderProgram;

    const isTerrain = command.pass === Pass.GLOBE;
    const isOpaque = command.pass !== Pass.TRANSLUCENT;
    const isPointLight = shadowMap._isPointLight;
    const usesDepthTexture = shadowMap._usesDepthTexture;

    const vertexShaderSource = shaderProgram.vertexShaderSource;
    const fragmentShaderSource = shaderProgram.fragmentShaderSource;

    const hasClipping =
      isOpaque &&
      ShadowMapShader.hasClippingForShadowCast(fragmentShaderSource);

    const keyword = ShadowMapShader.getShadowCastShaderKeyword(
      isPointLight,
      isTerrain,
      usesDepthTexture,
      isOpaque,
      hasClipping,
    );
    castShader = context.shaderCache.getDerivedShaderProgram(
      shaderProgram,
      keyword,
    );
    if (!defined(castShader)) {
      const castVS = ShadowMapShader.createShadowCastVertexShader(
        vertexShaderSource,
        isPointLight,
        isTerrain,
      );
      const castFS = ShadowMapShader.createShadowCastFragmentShader(
        fragmentShaderSource,
        isPointLight,
        usesDepthTexture,
        isOpaque,
        hasClipping,
      );

      castShader = context.shaderCache.createDerivedShaderProgram(
        shaderProgram,
        keyword,
        {
          vertexShaderSource: castVS,
          fragmentShaderSource: castFS,
          attributeLocations: shaderProgram._attributeLocations,
        },
      );
    }

    castRenderState = shadowMap._primitiveRenderState;
    if (isPointLight) {
      castRenderState = shadowMap._pointRenderState;
    } else if (isTerrain) {
      castRenderState = shadowMap._terrainRenderState;
    }

    // Modify for commands that do not use back-face culling
    const cullEnabled = command.renderState.cull.enabled;
    if (!cullEnabled) {
      castRenderState = clone(castRenderState, false);
      castRenderState.cull = clone(castRenderState.cull, false);
      castRenderState.cull.enabled = false;
      castRenderState = RenderState.fromCache(castRenderState);
    }

    castUniformMap = combineUniforms(shadowMap, command.uniformMap, isTerrain);
  }

  result.shaderProgram = castShader;
  result.renderState = castRenderState;
  result.uniformMap = castUniformMap;

  return result;
}

/**
 * <div class="notice">
 * Use {@link Viewer#shadowMap} to get the scene's shadow map. Do not construct this directly.
 * </div>
 *
 * <p>
 * The normalOffset bias pushes the shadows forward slightly, and may be disabled
 * for applications that require ultra precise shadows.
 * </p>
 *
 * @alias ShadowMap
 * @internalConstructor
 * @class
 *
 * @privateParam {object} options An object containing the following properties:
 * @privateParam {Context} options.context The context
 * @privateParam {Camera} options.lightCamera A camera representing the light source.
 * @privateParam {boolean} [options.enabled=true] Whether the shadow map is enabled.
 * @privateParam {boolean} [options.isPointLight=false] Whether the light source is a point light. Point light shadows do not use cascades.
 * @privateParam {number} [options.pointLightRadius=100.0] Radius of the point light.
 * @privateParam {boolean} [options.cascadesEnabled=true] Use multiple shadow maps to cover different partitions of the view frustum.
 * @privateParam {number} [options.numberOfCascades=4] The number of cascades to use for the shadow map. Supported values are one and four.
 * @privateParam {number} [options.maximumDistance=5000.0] The maximum distance used for generating cascaded shadows. Lower values improve shadow quality.
 * @privateParam {number} [options.size=2048] The width and height, in pixels, of each shadow map.
 * @privateParam {boolean} [options.softShadows=false] Whether percentage-closer-filtering is enabled for producing softer shadows.
 * @privateParam {number} [options.darkness=0.3] The shadow darkness.
 * @privateParam {boolean} [options.normalOffset=true] Whether a normal bias is applied to shadows.
 * @privateParam {boolean} [options.fadingEnabled=true] Whether shadows start to fade out once the light gets closer to the horizon.
 *
 * @exception {DeveloperError} Only one or four cascades are supported.
 *
 * @demo {@link https://sandcastle.cesium.com/index.html?id=shadows|Cesium Sandcastle Shadows Demo}
 */
class ShadowMap {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;
    const context = options.context;

    //>>includeStart('debug', pragmas.debug);
    if (!defined(context)) {
      throw new DeveloperError("context is required.");
    }
    if (!defined(options.lightCamera)) {
      throw new DeveloperError("lightCamera is required.");
    }
    if (
      defined(options.numberOfCascades) &&
      options.numberOfCascades !== 1 &&
      options.numberOfCascades !== 4
    ) {
      throw new DeveloperError("Only one or four cascades are supported.");
    }
    //>>includeEnd('debug');

    this._enabled = options.enabled ?? true;
    this._softShadows = options.softShadows ?? false;
    this._normalOffset = options.normalOffset ?? true;
    this.dirty = true;

    /**
     * Specifies whether the shadow map originates from a light source. Shadow maps that are used for analytical
     * purposes should set this to false so as not to affect scene rendering.
     *
     * @private
     */
    this.fromLightSource = options.fromLightSource ?? true;

    /**
     * Determines the darkness of the shadows.
     *
     * @type {number}
     * @default 0.3
     */
    this.darkness = options.darkness ?? 0.3;
    this._darkness = this.darkness;

    /**
     * Determines whether shadows start to fade out once the light gets closer to the horizon.
     *
     * @type {boolean}
     * @default true
     */
    this.fadingEnabled = options.fadingEnabled ?? true;

    /**
     * Determines the maximum distance of the shadow map. Only applicable for cascaded shadows. Larger distances may result in lower quality shadows.
     *
     * @type {number}
     * @default 5000.0
     */
    this.maximumDistance = options.maximumDistance ?? 5000.0;

    this._outOfView = false;
    this._outOfViewPrevious = false;
    this._needsUpdate = true;

    // In IE11 and Edge polygon offset is not functional.
    // TODO : Also disabled for instances of Firefox and Chrome running ANGLE that do not support depth textures.
    // Re-enable once https://github.com/CesiumGS/cesium/issues/4560 is resolved.
    let polygonOffsetSupported = true;
    if (
      FeatureDetection.isEdge() ||
      ((FeatureDetection.isChrome() || FeatureDetection.isFirefox()) &&
        FeatureDetection.isWindows() &&
        !context.depthTexture)
    ) {
      polygonOffsetSupported = false;
    }
    this._polygonOffsetSupported = polygonOffsetSupported;

    this._terrainBias = {
      polygonOffset: polygonOffsetSupported,
      polygonOffsetFactor: 1.1,
      polygonOffsetUnits: 4.0,
      normalOffset: this._normalOffset,
      normalOffsetScale: 0.5,
      normalShading: true,
      normalShadingSmooth: 0.3,
      depthBias: 0.0001,
    };

    this._primitiveBias = {
      polygonOffset: polygonOffsetSupported,
      polygonOffsetFactor: 1.1,
      polygonOffsetUnits: 4.0,
      normalOffset: this._normalOffset,
      normalOffsetScale: 0.1,
      normalShading: true,
      normalShadingSmooth: 0.05,
      depthBias: 0.00002,
    };

    this._pointBias = {
      polygonOffset: false,
      polygonOffsetFactor: 1.1,
      polygonOffsetUnits: 4.0,
      normalOffset: this._normalOffset,
      normalOffsetScale: 0.0,
      normalShading: true,
      normalShadingSmooth: 0.1,
      depthBias: 0.0005,
    };

    // Framebuffer resources
    this._depthAttachment = undefined;
    this._colorAttachment = undefined;

    // Uniforms
    this._shadowMapMatrix = new Matrix4();
    this._shadowMapTexture = undefined;
    this._lightDirectionEC = new Cartesian3();
    this._lightPositionEC = new Cartesian4();
    this._distance = 0.0;

    this._lightCamera = options.lightCamera;
    this._shadowMapCamera = new ShadowMapCamera();
    this._shadowMapCullingVolume = undefined;
    this._sceneCamera = undefined;
    this._boundingSphere = new BoundingSphere();

    this._isPointLight = options.isPointLight ?? false;
    this._pointLightRadius = options.pointLightRadius ?? 100.0;

    this._cascadesEnabled = this._isPointLight
      ? false
      : (options.cascadesEnabled ?? true);
    this._numberOfCascades = !this._cascadesEnabled
      ? 0
      : (options.numberOfCascades ?? 4);
    this._fitNearFar = true;
    this._maximumCascadeDistances = [25.0, 150.0, 700.0, Number.MAX_VALUE];

    this._textureSize = new Cartesian2();

    this._isSpotLight = false;
    if (this._cascadesEnabled) {
      this._shadowMapCamera.frustum = new OrthographicOffCenterFrustum();
    } else if (defined(this._lightCamera.frustum.fov)) {
      this._isSpotLight = true;
    }

    // Uniforms
    this._cascadeSplits = [new Cartesian4(), new Cartesian4()];
    this._cascadeMatrices = [
      new Matrix4(),
      new Matrix4(),
      new Matrix4(),
      new Matrix4(),
    ];
    this._cascadeDistances = new Cartesian4();

    let numberOfPasses;
    if (this._isPointLight) {
      numberOfPasses = 6;
    } else if (!this._cascadesEnabled) {
      numberOfPasses = 1;
    } else {
      numberOfPasses = this._numberOfCascades;
    }

    this._passes = new Array(numberOfPasses);
    for (let i = 0; i < numberOfPasses; ++i) {
      this._passes[i] = new ShadowPass(context);
    }

    this.debugShow = false;
    this.debugFreezeFrame = false;
    this._debugFreezeFrame = false;
    this._debugCascadeColors = false;
    this._debugLightFrustum = undefined;
    this._debugCameraFrustum = undefined;
    this._debugCascadeFrustums = new Array(this._numberOfCascades);
    this._debugShadowViewCommand = undefined;

    this._usesDepthTexture = context.depthTexture;

    if (this._isPointLight) {
      this._usesDepthTexture = false;
    }

    // Create render states for shadow casters
    this._primitiveRenderState = undefined;
    this._terrainRenderState = undefined;
    this._pointRenderState = undefined;
    this._createRenderStates();

    // For clearing the shadow map texture every frame
    this._clearCommand = new ClearCommand({
      depth: 1.0,
      color: new Color(),
    });

    this._clearPassState = new PassState(context);

    this._size = options.size ?? 2048;
    this.size = this._size;
  }

  /**
   * Determines if the shadow map will be shown.
   *
   * @type {boolean}
   * @default true
   */
  get enabled() {
    return this._enabled;
  }

  set enabled(value) {
    this.dirty = this._enabled !== value;
    this._enabled = value;
  }

  /**
   * Determines if a normal bias will be applied to shadows.
   *
   * @type {boolean}
   * @default true
   */
  get normalOffset() {
    return this._normalOffset;
  }

  set normalOffset(value) {
    this.dirty = this._normalOffset !== value;
    this._normalOffset = value;
    this._terrainBias.normalOffset = value;
    this._primitiveBias.normalOffset = value;
    this._pointBias.normalOffset = value;
  }

  /**
   * Determines if soft shadows are enabled. Uses pcf filtering which requires more texture reads and may hurt performance.
   *
   * @type {boolean}
   * @default false
   */
  get softShadows() {
    return this._softShadows;
  }

  set softShadows(value) {
    this.dirty = this._softShadows !== value;
    this._softShadows = value;
  }

  /**
   * The width and height, in pixels, of each shadow map.
   *
   * @type {number}
   * @default 2048
   */
  get size() {
    return this._size;
  }

  set size(value) {
    resize(this, value);
  }

  /**
   * Whether the shadow map is out of view of the scene camera.
   *
   * @type {boolean}
   * @readonly
   * @private
   */
  get outOfView() {
    return this._outOfView;
  }

  /**
   * The culling volume of the shadow frustum.
   *
   * @type {CullingVolume}
   * @readonly
   * @private
   */
  get shadowMapCullingVolume() {
    return this._shadowMapCullingVolume;
  }

  /**
   * The passes used for rendering shadows. Each face of a point light or each cascade for a cascaded shadow map is a separate pass.
   *
   * @type {ShadowPass[]}
   * @readonly
   * @private
   */
  get passes() {
    return this._passes;
  }

  /**
   * Whether the light source is a point light.
   *
   * @type {boolean}
   * @readonly
   * @private
   */
  get isPointLight() {
    return this._isPointLight;
  }

  /**
   * Debug option for visualizing the cascades by color.
   *
   * @type {boolean}
   * @default false
   * @private
   */
  get debugCascadeColors() {
    return this._debugCascadeColors;
  }

  set debugCascadeColors(value) {
    this.dirty = this._debugCascadeColors !== value;
    this._debugCascadeColors = value;
  }

  /**
   * Rebuilds render states. Called by ShadowMapComputations when framebuffer
   * falls back from depth to color texture.
   * @private
   */
  _createRenderStates() {
    const colorMask = !this._usesDepthTexture;
    this._primitiveRenderState = createRenderState(
      colorMask,
      this._primitiveBias,
    );
    this._terrainRenderState = createRenderState(colorMask, this._terrainBias);
    this._pointRenderState = createRenderState(colorMask, this._pointBias);
  }

  /**
   * @private
   */
  debugCreateRenderStates() {
    this._createRenderStates();
  }

  /**
   * @private
   */
  update(frameState) {
    updateCameras(this, frameState);

    if (this._needsUpdate) {
      // WebGPU path — skip WebGL framebuffer creation; WebGPUShadowMapRenderer
      // manages its own depth32float texture + comparison sampler.
      const context = frameState.context;
      const shadowFr = context.getFeatureRenderer(
        FeatureRendererKey.SHADOW_MAP,
      );
      if (shadowFr) {
        shadowFr.init(this, context);
        this._featureRenderer = shadowFr;
      } else {
        updateFramebuffer(this, context);
      }

      if (this._isPointLight) {
        computeOmnidirectional(this, frameState);
      }

      if (this._cascadesEnabled) {
        fitShadowMapToScene(this, frameState);

        if (this._numberOfCascades > 1) {
          computeCascades(this, frameState);
        }
      }

      if (!this._isPointLight) {
        const shadowMapCamera = this._shadowMapCamera;
        const position = shadowMapCamera.positionWC;
        const direction = shadowMapCamera.directionWC;
        const up = shadowMapCamera.upWC;
        this._shadowMapCullingVolume =
          shadowMapCamera.frustum.computeCullingVolume(position, direction, up);

        if (this._passes.length === 1) {
          this._passes[0].camera.clone(shadowMapCamera);
        }
      } else {
        this._shadowMapCullingVolume = CullingVolume.fromBoundingSphere(
          this._boundingSphere,
        );
      }
    }

    if (this._passes.length === 1) {
      const inverseView = this._sceneCamera.inverseViewMatrix;
      Matrix4.multiply(
        this._shadowMapCamera.getViewProjection(),
        inverseView,
        this._shadowMapMatrix,
      );
    }

    if (this.debugShow) {
      applyDebugSettings(this, frameState);
    }
  }

  /**
   * @private
   */
  updatePass(context, shadowPass) {
    clearFramebuffer(this, context, shadowPass);
  }

  /**
   * @private
   */
  isDestroyed() {
    return false;
  }

  /**
   * @private
   */
  destroy() {
    if (this._featureRenderer) {
      this._featureRenderer.destroy(this);
    }
    destroyFramebuffer(this);

    this._debugLightFrustum =
      this._debugLightFrustum && this._debugLightFrustum.destroy();
    this._debugCameraFrustum =
      this._debugCameraFrustum && this._debugCameraFrustum.destroy();
    this._debugShadowViewCommand =
      this._debugShadowViewCommand &&
      this._debugShadowViewCommand.shaderProgram &&
      this._debugShadowViewCommand.shaderProgram.destroy();

    for (let i = 0; i < this._numberOfCascades; ++i) {
      this._debugCascadeFrustums[i] =
        this._debugCascadeFrustums[i] &&
        this._debugCascadeFrustums[i].destroy();
    }

    return destroyObject(this);
  }

  static createReceiveDerivedCommand(
    lightShadowMaps,
    command,
    shadowsDirty,
    context,
    result,
  ) {
    if (!defined(result)) {
      result = {};
    }

    const lightShadowMapsEnabled = lightShadowMaps.length > 0;
    const shaderProgram = command.shaderProgram;
    const vertexShaderSource = shaderProgram.vertexShaderSource;
    const fragmentShaderSource = shaderProgram.fragmentShaderSource;
    const isTerrain = command.pass === Pass.GLOBE;

    let hasTerrainNormal = false;
    if (isTerrain) {
      hasTerrainNormal =
        command.owner.data.renderedMesh.encoding.hasVertexNormals;
    }

    if (command.receiveShadows && lightShadowMapsEnabled) {
      let receiveShader;
      let receiveUniformMap;
      if (defined(result.receiveCommand)) {
        receiveShader = result.receiveCommand.shaderProgram;
        receiveUniformMap = result.receiveCommand.uniformMap;
      }

      result.receiveCommand = DrawCommand.shallowClone(
        command,
        result.receiveCommand,
      );
      result.castShadows = false;
      result.receiveShadows = true;

      const castShadowsDirty =
        result.receiveShaderCastShadows !== command.castShadows;
      const shaderDirty =
        result.receiveShaderProgramId !== command.shaderProgram.id;

      if (
        !defined(receiveShader) ||
        shaderDirty ||
        shadowsDirty ||
        castShadowsDirty
      ) {
        const keyword = ShadowMapShader.getShadowReceiveShaderKeyword(
          lightShadowMaps[0],
          command.castShadows,
          isTerrain,
          hasTerrainNormal,
        );
        receiveShader = context.shaderCache.getDerivedShaderProgram(
          shaderProgram,
          keyword,
        );
        if (!defined(receiveShader)) {
          const receiveVS = ShadowMapShader.createShadowReceiveVertexShader(
            vertexShaderSource,
            isTerrain,
            hasTerrainNormal,
          );
          const receiveFS = ShadowMapShader.createShadowReceiveFragmentShader(
            fragmentShaderSource,
            lightShadowMaps[0],
            command.castShadows,
            isTerrain,
            hasTerrainNormal,
          );

          receiveShader = context.shaderCache.createDerivedShaderProgram(
            shaderProgram,
            keyword,
            {
              vertexShaderSource: receiveVS,
              fragmentShaderSource: receiveFS,
              attributeLocations: shaderProgram._attributeLocations,
            },
          );
        }

        receiveUniformMap = combineUniforms(
          lightShadowMaps[0],
          command.uniformMap,
          isTerrain,
        );
      }

      result.receiveCommand.shaderProgram = receiveShader;
      result.receiveCommand.uniformMap = receiveUniformMap;
      result.receiveShaderProgramId = command.shaderProgram.id;
      result.receiveShaderCastShadows = command.castShadows;
    }

    return result;
  }

  static createCastDerivedCommand(
    shadowMaps,
    command,
    shadowsDirty,
    context,
    result,
  ) {
    if (!defined(result)) {
      result = {};
    }

    if (command.castShadows) {
      let castCommands = result.castCommands;
      if (!defined(castCommands)) {
        castCommands = result.castCommands = [];
      }

      const oldShaderId = result.castShaderProgramId;

      const shadowMapLength = shadowMaps.length;
      castCommands.length = shadowMapLength;

      for (let i = 0; i < shadowMapLength; ++i) {
        castCommands[i] = createCastDerivedCommand(
          shadowMaps[i],
          shadowsDirty,
          command,
          context,
          oldShaderId,
          castCommands[i],
        );
      }

      result.castShaderProgramId = command.shaderProgram.id;
    }

    return result;
  }
}

/**
 * Global maximum shadow distance used to prevent far off receivers from extending
 * the shadow far plane. This helps set a tighter near/far when viewing objects from space.
 *
 * @private
 */
ShadowMap.MAXIMUM_DISTANCE = 20000.0;

export default ShadowMap;
