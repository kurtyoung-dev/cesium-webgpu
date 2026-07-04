import buildVoxelDrawCommands from "./buildVoxelDrawCommands.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import Cesium3DTilesetStatistics from "./Cesium3DTilesetStatistics.js";
import CesiumMath from "../Core/Math.js";
import Check from "../Core/Check.js";
import Color from "../Core/Color.js";
import ClippingPlaneCollection from "./ClippingPlaneCollection.js";
import CustomShader from "./Model/CustomShader.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import Event from "../Core/Event.js";
import Matrix3 from "../Core/Matrix3.js";
import Matrix4 from "../Core/Matrix4.js";
import PolylineCollection from "./PolylineCollection.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";

import {
  initializeShape,
  initFromProvider,
  checkTransformAndBounds,
  updateVerticalExaggeration,
  updateShapeAndTransforms,
  checkShapeDefines,
  getKeyframeLocation,
  updateClippingPlanes,
  updateNearestSampling,
  updateRenderBoundPlanes,
  getTileCoordinates,
  orientedBoundingBoxToNdcAabb,
  debugDraw,
  DefaultVoxelProvider,
} from "./VoxelPrimitiveHelpers.js";

const scratchNdcAabb = new Cartesian4();
const scratchCameraTileCoordinates = new Cartesian4();

/**
 * A primitive that renders voxel data from a {@link VoxelProvider}.
 *
 * @alias VoxelPrimitive
 *
 * @param {object} [options] Object with the following properties:
 * @param {VoxelProvider} [options.provider] The voxel provider that supplies the primitive with tile data.
 * @param {Matrix4} [options.modelMatrix=Matrix4.IDENTITY] The model matrix used to transform the primitive.
 * @param {CustomShader} [options.customShader] The custom shader used to style the primitive.
 * @param {Clock} [options.clock] The clock used to control time dynamic behavior.
 * @param {boolean} [options.calculateStatistics] Generate statistics for performance profile.
 *
 * @see VoxelProvider
 * @see Cesium3DTilesVoxelProvider
 * @see VoxelShapeType
 *
 * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy.
 */
class VoxelPrimitive {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    this._ready = false;
    this._provider = options.provider ?? VoxelPrimitive.DefaultProvider;
    this._traversal = undefined;
    // Set on the WebGPU feature-renderer path (VoxelPrimitive.update) so
    // pickVoxel can resolve a keyframe node when `_traversal` is absent.
    this._featureRenderer = undefined;
    this._statistics = new Cesium3DTilesetStatistics();
    this._calculateStatistics = options.calculateStatistics ?? false;
    this._shape = undefined;
    this._shapeVisible = false;
    this._dimensions = new Cartesian3();
    this._inputDimensions = new Cartesian3();
    this._paddingBefore = new Cartesian3();
    this._paddingAfter = new Cartesian3();
    this._availableLevels = 1;
    this._minBounds = new Cartesian3();
    this._minBoundsOld = new Cartesian3();
    this._maxBounds = new Cartesian3();
    this._maxBoundsOld = new Cartesian3();
    this._minClippingBounds = new Cartesian3();
    this._minClippingBoundsOld = new Cartesian3();
    this._maxClippingBounds = new Cartesian3();
    this._maxClippingBoundsOld = new Cartesian3();
    this._verticalExaggeration = 1.0;
    this._verticalExaggerationRelativeHeight = 0.0;
    this._clippingPlanes = undefined;
    this._clippingPlanesState = 0;
    this._clippingPlanesEnabled = false;
    this._modelMatrix = Matrix4.clone(options.modelMatrix ?? Matrix4.IDENTITY);
    this._modelMatrixOld = Matrix4.clone(this._modelMatrix);
    this._customShader =
      options.customShader ?? VoxelPrimitive.DefaultCustomShader;
    this._customShaderCompilationEvent = new Event();
    this._shaderDirty = true;
    this._drawCommand = undefined;
    this._drawCommandPick = undefined;
    this._pickId = undefined;
    this._clock = options.clock;

    // Transforms computed when the shape changes
    this._transformPositionLocalToWorld = new Matrix4();
    this._transformPositionWorldToLocal = new Matrix4();
    this._transformPlaneLocalToView = new Matrix4();
    this._transformDirectionWorldToLocal = new Matrix3();

    // Rendering
    this._nearestSampling = false;
    this._levelBlendFactor = 0.0;
    this._stepSizeMultiplier = 1.0;
    this._depthTest = true;
    this._useLogDepth = undefined;
    this._screenSpaceError = 4.0;

    // Debug / statistics
    this._debugPolylines = new PolylineCollection();
    this._debugDraw = false;
    this._disableRender = false;
    this._disableUpdate = false;

    this._uniforms = {
      octreeInternalNodeTexture: undefined,
      octreeInternalNodeTilesPerRow: 0,
      octreeInternalNodeTexelSizeUv: new Cartesian2(),
      octreeLeafNodeTexture: undefined,
      octreeLeafNodeTilesPerRow: 0,
      octreeLeafNodeTexelSizeUv: new Cartesian2(),
      megatextureTextures: [],
      megatextureTileCounts: new Cartesian3(),
      dimensions: new Cartesian3(),
      inputDimensions: new Cartesian3(),
      paddingBefore: new Cartesian3(),
      paddingAfter: new Cartesian3(),
      transformPositionViewToLocal: new Matrix4(),
      transformDirectionViewToLocal: new Matrix3(),
      cameraPositionLocal: new Cartesian3(),
      cameraDirectionLocal: new Cartesian3(),
      cameraTileCoordinates: new Cartesian4(),
      cameraTileUv: new Cartesian3(),
      ndcSpaceAxisAlignedBoundingBox: new Cartesian4(),
      clippingPlanesTexture: undefined,
      clippingPlanesMatrix: new Matrix4(),
      renderBoundPlanesTexture: undefined,
      stepSize: 0,
      pickColor: new Color(),
    };

    this._shapeDefinesOld = {};

    this._uniformMap = {};
    const uniforms = this._uniforms;
    const uniformMap = this._uniformMap;
    for (const key in uniforms) {
      if (Object.hasOwn(uniforms, key)) {
        const name = `u_${key}`;
        uniformMap[name] = function () {
          return uniforms[key];
        };
      }
    }

    /**
     * This event fires when a tile's content was loaded.
     * @type {Event}
     */
    this.tileLoad = new Event();

    /**
     * This event fires once for each visible tile in a frame.
     * @type {Event}
     */
    this.tileVisible = new Event();

    /**
     * The event fired to indicate that a tile's content failed to load.
     * @type {Event}
     */
    this.tileFailed = new Event();

    /**
     * The event fired to indicate that a tile's content was unloaded.
     * @type {Event}
     */
    this.tileUnload = new Event();

    /**
     * The event fired to indicate progress of loading new tiles.
     * @type {Event}
     */
    this.loadProgress = new Event();

    /**
     * The event fired to indicate that all tiles that meet the screen space error this frame are loaded.
     * @type {Event}
     */
    this.allTilesLoaded = new Event();

    /**
     * The event fired once when all tiles in the initial view are loaded.
     * @type {Event}
     */
    this.initialTilesLoaded = new Event();

    // If the provider fails to initialize the primitive will fail too.
    initializeShape(this, this._provider);
  }

  // --- Getters/Setters ---

  get ready() {
    return this._ready;
  }

  get provider() {
    return this._provider;
  }

  get boundingSphere() {
    return this._shape.boundingSphere;
  }

  get orientedBoundingBox() {
    return this._shape.orientedBoundingBox;
  }

  get modelMatrix() {
    return this._modelMatrix;
  }

  set modelMatrix(modelMatrix) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.object("modelMatrix", modelMatrix);
    //>>includeEnd('debug');
    this._modelMatrix = Matrix4.clone(modelMatrix, this._modelMatrix);
  }

  get shape() {
    return this._provider.shape;
  }

  get dimensions() {
    return this._dimensions;
  }

  get inputDimensions() {
    return this._inputDimensions;
  }

  get paddingBefore() {
    return this._paddingBefore;
  }

  get paddingAfter() {
    return this._paddingAfter;
  }

  get minimumValues() {
    return this._provider.minimumValues;
  }

  get maximumValues() {
    return this._provider.maximumValues;
  }

  get show() {
    return !this._disableRender;
  }

  set show(show) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.bool("show", show);
    //>>includeEnd('debug');
    this._disableRender = !show;
  }

  get disableUpdate() {
    return this._disableUpdate;
  }

  set disableUpdate(disableUpdate) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.bool("disableUpdate", disableUpdate);
    //>>includeEnd('debug');
    this._disableUpdate = disableUpdate;
  }

  get debugDraw() {
    return this._debugDraw;
  }

  set debugDraw(val) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.bool("debugDraw", val);
    //>>includeEnd('debug');
    this._debugDraw = val;
  }

  get depthTest() {
    return this._depthTest;
  }

  set depthTest(depthTest) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.bool("depthTest", depthTest);
    //>>includeEnd('debug');
    if (this._depthTest !== depthTest) {
      this._depthTest = depthTest;
      this._shaderDirty = true;
    }
  }

  get nearestSampling() {
    return this._nearestSampling;
  }

  set nearestSampling(nearestSampling) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.bool("nearestSampling", nearestSampling);
    //>>includeEnd('debug');
    this._nearestSampling = nearestSampling;
  }

  /**
   * @private
   */
  get levelBlendFactor() {
    return this._levelBlendFactor;
  }

  set levelBlendFactor(levelBlendFactor) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number("levelBlendFactor", levelBlendFactor);
    //>>includeEnd('debug');
    this._levelBlendFactor = CesiumMath.clamp(levelBlendFactor, 0.0, 1.0);
  }

  get screenSpaceError() {
    return this._screenSpaceError;
  }

  set screenSpaceError(screenSpaceError) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number("screenSpaceError", screenSpaceError);
    //>>includeEnd('debug');
    this._screenSpaceError = screenSpaceError;
  }

  get stepSize() {
    return this._stepSizeMultiplier;
  }

  set stepSize(stepSize) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number("stepSize", stepSize);
    //>>includeEnd('debug');
    this._stepSizeMultiplier = stepSize;
  }

  get minBounds() {
    return this._minBounds;
  }

  set minBounds(minBounds) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("minBounds", minBounds);
    //>>includeEnd('debug');
    this._minBounds = Cartesian3.clone(minBounds, this._minBounds);
  }

  get maxBounds() {
    return this._maxBounds;
  }

  set maxBounds(maxBounds) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("maxBounds", maxBounds);
    //>>includeEnd('debug');
    this._maxBounds = Cartesian3.clone(maxBounds, this._maxBounds);
  }

  get minClippingBounds() {
    return this._minClippingBounds;
  }

  set minClippingBounds(minClippingBounds) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("minClippingBounds", minClippingBounds);
    //>>includeEnd('debug');
    this._minClippingBounds = Cartesian3.clone(
      minClippingBounds,
      this._minClippingBounds,
    );
  }

  get maxClippingBounds() {
    return this._maxClippingBounds;
  }

  set maxClippingBounds(maxClippingBounds) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("maxClippingBounds", maxClippingBounds);
    //>>includeEnd('debug');
    this._maxClippingBounds = Cartesian3.clone(
      maxClippingBounds,
      this._maxClippingBounds,
    );
  }

  get clippingPlanes() {
    return this._clippingPlanes;
  }

  set clippingPlanes(clippingPlanes) {
    ClippingPlaneCollection.setOwner(clippingPlanes, this, "_clippingPlanes");
  }

  get customShader() {
    return this._customShader;
  }

  set customShader(customShader) {
    if (this._customShader !== customShader) {
      const uniformMap = this._uniformMap;
      const oldCustomShader = this._customShader;
      const oldCustomShaderUniformMap = oldCustomShader.uniformMap;
      for (const uniformName in oldCustomShaderUniformMap) {
        if (Object.hasOwn(oldCustomShaderUniformMap, uniformName)) {
          delete uniformMap[uniformName];
        }
      }

      if (!defined(customShader)) {
        this._customShader = VoxelPrimitive.DefaultCustomShader;
      } else {
        this._customShader = customShader;
      }
      this._shaderDirty = true;
    }
  }

  get customShaderCompilationEvent() {
    return this._customShaderCompilationEvent;
  }

  /**
   * @type {Cesium3DTilesetStatistics}
   * @readonly
   * @private
   */
  get statistics() {
    return this._statistics;
  }

  // --- Methods ---

  /**
   * @param {FrameState} frameState
   * @private
   */
  update(frameState) {
    // Backend-specific rendering path
    const fr = frameState.context.getFeatureRenderer(
      FeatureRendererKey.VOXEL_PRIMITIVE,
    );
    if (fr) {
      this._featureRenderer = fr;
      fr.update(this, frameState);
      return;
    }

    const provider = this._provider;
    const uniforms = this._uniforms;

    this._customShader.update(frameState);

    const context = frameState.context;
    if (!this._ready) {
      initFromProvider(this, provider, context);
      frameState.afterRender.push(() => {
        this._ready = true;
        return true;
      });
      return;
    }

    const shapeDirty = checkTransformAndBounds(this);
    const exaggerationChanged = updateVerticalExaggeration(this, frameState);
    if (shapeDirty || exaggerationChanged) {
      this._shapeVisible = updateShapeAndTransforms(this);
      if (checkShapeDefines(this)) {
        this._shaderDirty = true;
      }
    }
    if (!this._shapeVisible) {
      return;
    }

    this._shape.updateViewTransforms(frameState);

    const keyframeLocation = getKeyframeLocation(
      provider.timeIntervalCollection,
      this._clock,
    );

    const traversal = this._traversal;
    const sampleCountOld = traversal._sampleCount;

    traversal.update(
      frameState,
      keyframeLocation,
      shapeDirty,
      this._disableUpdate,
    );

    if (sampleCountOld !== traversal._sampleCount) {
      this._shaderDirty = true;
    }

    if (!traversal.isRenderable(traversal.rootNode)) {
      return;
    }

    if (this._debugDraw) {
      debugDraw(this, frameState);
    }

    if (this._disableRender) {
      return;
    }

    if (this._useLogDepth !== frameState.useLogDepth) {
      this._useLogDepth = frameState.useLogDepth;
      this._shaderDirty = true;
    }

    const clippingPlanesChanged = updateClippingPlanes(this, frameState);
    if (clippingPlanesChanged) {
      this._shaderDirty = true;
    }

    const leafNodeTexture = traversal.leafNodeTexture;
    if (defined(leafNodeTexture)) {
      uniforms.octreeLeafNodeTexture = traversal.leafNodeTexture;
      uniforms.octreeLeafNodeTexelSizeUv = Cartesian2.clone(
        traversal.leafNodeTexelSizeUv,
        uniforms.octreeLeafNodeTexelSizeUv,
      );
      uniforms.octreeLeafNodeTilesPerRow = traversal.leafNodeTilesPerRow;
    }

    if (this._shaderDirty) {
      buildVoxelDrawCommands(this, context);
      this._shaderDirty = false;
    }

    const transformPositionWorldToProjection =
      context.uniformState.viewProjection;
    const { orientedBoundingBox } = this._shape;
    const ndcAabb = orientedBoundingBoxToNdcAabb(
      orientedBoundingBox,
      transformPositionWorldToProjection,
      scratchNdcAabb,
    );

    const offscreen =
      ndcAabb.x === +1.0 ||
      ndcAabb.y === +1.0 ||
      ndcAabb.z === -1.0 ||
      ndcAabb.w === -1.0;
    if (offscreen) {
      return;
    }

    uniforms.ndcSpaceAxisAlignedBoundingBox = Cartesian4.clone(
      ndcAabb,
      uniforms.ndcSpaceAxisAlignedBoundingBox,
    );
    const transformPositionViewToWorld = context.uniformState.inverseView;
    const transformPositionViewToLocal = Matrix4.multiplyTransformation(
      this._transformPositionWorldToLocal,
      transformPositionViewToWorld,
      uniforms.transformPositionViewToLocal,
    );

    this._transformPlaneLocalToView = Matrix4.transpose(
      transformPositionViewToLocal,
      this._transformPlaneLocalToView,
    );

    const transformDirectionViewToWorld =
      context.uniformState.inverseViewRotation;
    uniforms.transformDirectionViewToLocal = Matrix3.multiply(
      this._transformDirectionWorldToLocal,
      transformDirectionViewToWorld,
      uniforms.transformDirectionViewToLocal,
    );
    uniforms.cameraPositionLocal = Matrix4.multiplyByPoint(
      this._transformPositionWorldToLocal,
      frameState.camera.positionWC,
      uniforms.cameraPositionLocal,
    );
    uniforms.cameraDirectionLocal = Matrix3.multiplyByVector(
      this._transformDirectionWorldToLocal,
      frameState.camera.directionWC,
      uniforms.cameraDirectionLocal,
    );
    const cameraTileCoordinates = getTileCoordinates(
      this,
      uniforms.cameraPositionLocal,
      scratchCameraTileCoordinates,
    );
    uniforms.cameraTileCoordinates = Cartesian4.fromElements(
      Math.floor(cameraTileCoordinates.x),
      Math.floor(cameraTileCoordinates.y),
      Math.floor(cameraTileCoordinates.z),
      cameraTileCoordinates.w,
      uniforms.cameraTileCoordinates,
    );
    uniforms.cameraTileUv = Cartesian3.fromElements(
      cameraTileCoordinates.x - Math.floor(cameraTileCoordinates.x),
      cameraTileCoordinates.y - Math.floor(cameraTileCoordinates.y),
      cameraTileCoordinates.z - Math.floor(cameraTileCoordinates.z),
      uniforms.cameraTileUv,
    );
    uniforms.stepSize = this._stepSizeMultiplier;

    updateNearestSampling(this);
    updateRenderBoundPlanes(this, frameState);

    const command = frameState.passes.pick
      ? this._drawCommandPick
      : frameState.passes.pickVoxel
        ? this._drawCommandPickVoxel
        : this._drawCommand;
    command.boundingVolume = this._shape.boundingSphere;
    frameState.commandList.push(command);
  }

  /**
   * Resolve the keyframe node for a picked tile index, for {@link Scene#pickVoxel}.
   * On the WebGL path this consults the CPU-side {@link VoxelTraversal}. On the
   * WebGPU feature-renderer path — which returns from {@link VoxelPrimitive#update}
   * before {@link initFromProvider} ever builds a traversal — it delegates to the
   * renderer's uploaded-content resolver. Returns <code>undefined</code> when no
   * tile matches (pickVoxel then yields no cell — no throw), matching the WebGL
   * "keyframe node not found" behavior.
   *
   * @param {number} tileIndex The picked megatexture / tile index.
   * @returns {KeyframeNode|undefined}
   * @private
   */
  _getPickKeyframeNode(tileIndex) {
    // Feature renderer first: on the WebGPU path a `_traversal` may have been
    // constructed during the initial frames BEFORE the lazy voxel feature
    // renderer finished loading (VoxelPrimitive.update ran the WebGL body once),
    // but it is never populated once the FR takes over — its keyframeNode table
    // is empty. When an FR is servicing this primitive it is the source of
    // truth for pick resolution.
    const featureRenderer = this._featureRenderer;
    if (
      defined(featureRenderer) &&
      typeof featureRenderer.getPickKeyframeNode === "function"
    ) {
      return featureRenderer.getPickKeyframeNode(this, tileIndex);
    }
    const traversal = this._traversal;
    if (defined(traversal)) {
      return traversal.findKeyframeNode(tileIndex);
    }
    return undefined;
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    const drawCommand = this._drawCommand;
    if (defined(drawCommand)) {
      drawCommand.shaderProgram =
        drawCommand.shaderProgram && drawCommand.shaderProgram.destroy();
    }
    const drawCommandPick = this._drawCommandPick;
    if (defined(drawCommandPick)) {
      drawCommandPick.shaderProgram =
        drawCommandPick.shaderProgram &&
        drawCommandPick.shaderProgram.destroy();
    }

    this._pickId = this._pickId && this._pickId.destroy();
    this._traversal = this._traversal && this._traversal.destroy();
    this.statistics.texturesByteLength = 0;
    this._clippingPlanes =
      this._clippingPlanes && this._clippingPlanes.destroy();

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
 * The default custom shader used by the primitive.
 * @type {CustomShader}
 * @constant
 * @readonly
 * @private
 */
VoxelPrimitive.DefaultCustomShader = new CustomShader({
  fragmentShaderText: `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
{
    vec3 voxelNormal = fsInput.attributes.normalEC;
    float diffuse = max(0.0, dot(voxelNormal, czm_lightDirectionEC));
    float lighting = 0.5 + 0.5 * diffuse;
    material.diffuse = vec3(lighting);
    material.alpha = 1.0;
}`,
});

VoxelPrimitive.DefaultProvider = new DefaultVoxelProvider();

export default VoxelPrimitive;
