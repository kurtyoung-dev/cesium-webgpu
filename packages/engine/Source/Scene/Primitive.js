import BoundingSphere from "../Core/BoundingSphere.js";
import Cartesian3 from "../Core/Cartesian3.js";
import ComponentDatatype from "../Core/ComponentDatatype.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import Matrix4 from "../Core/Matrix4.js";
import RuntimeError from "../Core/RuntimeError.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import PrimitiveState from "./PrimitiveState.js";
import SceneMode from "./SceneMode.js";
import ShadowMode from "./ShadowMode.js";
import {
  modifyShaderPosition,
  appendShowToShader,
  updateColorAttribute,
  updatePickColorAttribute,
  appendOffsetToShader,
  appendDistanceDisplayConditionToShader,
} from "./PrimitiveShaderHelpers.js";
import {
  createRenderStates,
  createShaderProgram,
  createCommands,
  updateBoundingVolumes,
  updateAndQueueCommands,
} from "./PrimitiveCommandHelpers.js";
import {
  getAttributeValue,
  createBatchTable,
  loadAsynchronous,
  loadSynchronous,
  recomputeBoundingSpheres,
  updateBatchTableBoundingSpheres,
  updateBatchTableOffsets,
  createVertexArray,
  transformBoundingSphere,
} from "./PrimitiveGeometryHelpers.js";

/**
 * A primitive represents geometry in the {@link Scene}.  The geometry can be from a single {@link GeometryInstance}
 * as shown in example 1 below, or from an array of instances, even if the geometry is from different
 * geometry types, e.g., an {@link RectangleGeometry} and an {@link EllipsoidGeometry} as shown in Code Example 2.
 * <p>
 * A primitive combines geometry instances with an {@link Appearance} that describes the full shading, including
 * {@link Material} and {@link RenderState}.  Roughly, the geometry instance defines the structure and placement,
 * and the appearance defines the visual characteristics.  Decoupling geometry and appearance allows us to mix
 * and match most of them and add a new geometry or appearance independently of each other.
 * </p>
 * <p>
 * Combining multiple instances into one primitive is called batching, and significantly improves performance for static data.
 * Instances can be individually picked; {@link Scene#pick} returns their {@link GeometryInstance#id}.  Using
 * per-instance appearances like {@link PerInstanceColorAppearance}, each instance can also have a unique color.
 * </p>
 * <p>
 * {@link Geometry} can either be created and batched on a web worker or the main thread. The first two examples
 * show geometry that will be created on a web worker by using the descriptions of the geometry. The third example
 * shows how to create the geometry on the main thread by explicitly calling the <code>createGeometry</code> method.
 * </p>
 *
 * @alias Primitive
 *
 * @param {object} [options] Object with the following properties:
 * @param {GeometryInstance[]|GeometryInstance} [options.geometryInstances] The geometry instances - or a single geometry instance - to render.
 * @param {Appearance} [options.appearance] The appearance used to render the primitive.
 * @param {Appearance} [options.depthFailAppearance] The appearance used to shade this primitive when it fails the depth test.
 * @param {boolean} [options.show=true] Determines if this primitive will be shown.
 * @param {Matrix4} [options.modelMatrix=Matrix4.IDENTITY] The 4x4 transformation matrix that transforms the primitive (all geometry instances) from model to world coordinates.
 * @param {boolean} [options.vertexCacheOptimize=false] When <code>true</code>, geometry vertices are optimized for the pre and post-vertex-shader caches.
 * @param {boolean} [options.interleave=false] When <code>true</code>, geometry vertex attributes are interleaved, which can slightly improve rendering performance but increases load time.
 * @param {boolean} [options.compressVertices=true] When <code>true</code>, the geometry vertices are compressed, which will save memory.
 * @param {boolean} [options.releaseGeometryInstances=true] When <code>true</code>, the primitive does not keep a reference to the input <code>geometryInstances</code> to save memory.
 * @param {boolean} [options.allowPicking=true] When <code>true</code>, each geometry instance will only be pickable with {@link Scene#pick}.  When <code>false</code>, GPU memory is saved.
 * @param {boolean} [options.cull=true] When <code>true</code>, the renderer frustum culls and horizon culls the primitive's commands based on their bounding volume.  Set this to <code>false</code> for a small performance gain if you are manually culling the primitive.
 * @param {boolean} [options.asynchronous=true] Determines if the primitive will be created asynchronously or block until ready.
 * @param {boolean} [options.debugShowBoundingVolume=false] For debugging only. Determines if this primitive's commands' bounding spheres are shown.
 * @param {ShadowMode} [options.shadows=ShadowMode.DISABLED] Determines whether this primitive casts or receives shadows from light sources.
 *
 * @example
 * // 1. Draw a translucent ellipse on the surface with a checkerboard pattern
 * const instance = new Cesium.GeometryInstance({
 *   geometry : new Cesium.EllipseGeometry({
 *       center : Cesium.Cartesian3.fromDegrees(-100.0, 20.0),
 *       semiMinorAxis : 500000.0,
 *       semiMajorAxis : 1000000.0,
 *       rotation : Cesium.Math.PI_OVER_FOUR,
 *       vertexFormat : Cesium.VertexFormat.POSITION_AND_ST
 *   }),
 *   id : 'object returned when this instance is picked and to get/set per-instance attributes'
 * });
 * scene.primitives.add(new Cesium.Primitive({
 *   geometryInstances : instance,
 *   appearance : new Cesium.EllipsoidSurfaceAppearance({
 *     material : Cesium.Material.fromType('Checkerboard')
 *   })
 * }));
 *
 * @see GeometryInstance
 * @see Appearance
 * @see ClassificationPrimitive
 * @see GroundPrimitive
 */
class Primitive {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    /**
     * The geometry instances rendered with this primitive.  This may
     * be <code>undefined</code> if <code>options.releaseGeometryInstances</code>
     * is <code>true</code> when the primitive is constructed.
     * <p>
     * Changing this property after the primitive is rendered has no effect.
     * </p>
     *
     * @readonly
     * @type GeometryInstance[]|GeometryInstance
     *
     * @default undefined
     */
    this.geometryInstances = options.geometryInstances;

    /**
     * The {@link Appearance} used to shade this primitive. Each geometry
     * instance is shaded with the same appearance.  Some appearances, like
     * {@link PerInstanceColorAppearance} allow giving each instance unique
     * properties.
     *
     * @type Appearance
     *
     * @default undefined
     */
    this.appearance = options.appearance;
    this._appearance = undefined;
    this._material = undefined;

    /**
     * The {@link Appearance} used to shade this primitive when it fails the depth test. Each geometry
     * instance is shaded with the same appearance.  Some appearances, like
     * {@link PerInstanceColorAppearance} allow giving each instance unique
     * properties.
     *
     * <p>
     * When using an appearance that requires a color attribute, like PerInstanceColorAppearance,
     * add a depthFailColor per-instance attribute instead.
     * </p>
     *
     * <p>
     * Requires the EXT_frag_depth WebGL extension to render properly. If the extension is not supported,
     * there may be artifacts.
     * </p>
     * @type Appearance
     *
     * @default undefined
     */
    this.depthFailAppearance = options.depthFailAppearance;
    this._depthFailAppearance = undefined;
    this._depthFailMaterial = undefined;

    /**
     * The 4x4 transformation matrix that transforms the primitive (all geometry instances) from model to world coordinates.
     * When this is the identity matrix, the primitive is drawn in world coordinates, i.e., Earth's WGS84 coordinates.
     * Local reference frames can be used by providing a different transformation matrix, like that returned
     * by {@link Transforms.eastNorthUpToFixedFrame}.
     *
     * <p>
     * This property is only supported in 3D mode.
     * </p>
     *
     * @type Matrix4
     *
     * @default Matrix4.IDENTITY
     *
     * @example
     * const origin = Cesium.Cartesian3.fromDegrees(-95.0, 40.0, 200000.0);
     * p.modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
     */
    this.modelMatrix = Matrix4.clone(options.modelMatrix ?? Matrix4.IDENTITY);
    this._modelMatrix = new Matrix4();

    /**
     * Determines if the primitive will be shown.  This affects all geometry
     * instances in the primitive.
     *
     * @type {boolean}
     *
     * @default true
     */
    this.show = options.show ?? true;

    this._vertexCacheOptimize = options.vertexCacheOptimize ?? false;
    this._interleave = options.interleave ?? false;
    this._releaseGeometryInstances = options.releaseGeometryInstances ?? true;
    this._allowPicking = options.allowPicking ?? true;
    this._asynchronous = options.asynchronous ?? true;
    this._compressVertices = options.compressVertices ?? true;

    /**
     * When <code>true</code>, the renderer frustum culls and horizon culls the primitive's commands
     * based on their bounding volume.  Set this to <code>false</code> for a small performance gain
     * if you are manually culling the primitive.
     *
     * @type {boolean}
     *
     * @default true
     */
    this.cull = options.cull ?? true;

    /**
     * This property is for debugging only; it is not for production use nor is it optimized.
     * <p>
     * Draws the bounding sphere for each draw command in the primitive.
     * </p>
     *
     * @type {boolean}
     *
     * @default false
     */
    this.debugShowBoundingVolume = options.debugShowBoundingVolume ?? false;

    /**
     * @private
     */
    this.rtcCenter = options.rtcCenter;

    /**
     * The render priority for this primitive. Higher values render on top
     * (later in draw order). Maps to DrawCommand.sortPriority.
     * @type {number}
     * @default 0
     */
    this.renderPriority = options.renderPriority ?? 0;

    /**
     * The render layer order for this primitive. Controls which render layer
     * this primitive's commands are binned into. Maps to DrawCommand.sortLayer.
     * Use RenderLayer.Order constants for predefined layers.
     * @type {number}
     * @default 50
     */
    this.renderLayer = options.renderLayer ?? 50;

    //>>includeStart('debug', pragmas.debug);
    if (
      defined(this.rtcCenter) &&
      (!defined(this.geometryInstances) ||
        (Array.isArray(this.geometryInstances) &&
          this.geometryInstances.length !== 1))
    ) {
      throw new DeveloperError(
        "Relative-to-center rendering only supports one geometry instance.",
      );
    }
    //>>includeEnd('debug');

    /**
     * Determines whether this primitive casts or receives shadows from light sources.
     *
     * @type {ShadowMode}
     *
     * @default ShadowMode.DISABLED
     */
    this.shadows = options.shadows ?? ShadowMode.DISABLED;

    this._translucent = undefined;

    this._state = PrimitiveState.READY;
    this._geometries = [];
    this._error = undefined;
    this._numberOfInstances = 0;

    this._boundingSpheres = [];
    this._boundingSphereWC = [];
    this._boundingSphereCV = [];
    this._boundingSphere2D = [];
    this._boundingSphereMorph = [];
    this._perInstanceAttributeCache = new Map();
    this._instanceIds = [];
    this._lastPerInstanceAttributeIndex = 0;

    this._va = [];
    this._attributeLocations = undefined;
    this._primitiveType = undefined;

    this._frontFaceRS = undefined;
    this._backFaceRS = undefined;
    this._sp = undefined;

    this._depthFailAppearance = undefined;
    this._spDepthFail = undefined;
    this._frontFaceDepthFailRS = undefined;
    this._backFaceDepthFailRS = undefined;

    this._pickIds = [];

    this._colorCommands = [];
    this._pickCommands = [];
    // Q14-HDR-TOGGLE-INVALIDATION — last `context.renderTargetGeneration` the
    // alternate-renderer commands were built at. `-1` forces the first build;
    // a later mismatch (HDR toggle bumps the epoch) forces a command rebuild so
    // the WebGPU pipelines rekey to the new scene FB format. Unused on WebGL
    // (renderTargetGeneration is constant 0 there).
    this._renderTargetGeneration = -1;
    // Device-resource lifetime token. A recovered WebGPU device can have the
    // same render-target format as its predecessor, so format generation alone
    // cannot prove cached command buffers/bind groups are still valid.
    this._resourceGeneration = -1;

    this._createBoundingVolumeFunction = options._createBoundingVolumeFunction;
    this._createRenderStatesFunction = options._createRenderStatesFunction;
    this._createShaderProgramFunction = options._createShaderProgramFunction;
    this._createCommandsFunction = options._createCommandsFunction;
    this._updateAndQueueCommandsFunction =
      options._updateAndQueueCommandsFunction;

    this._createPickOffsets = options._createPickOffsets;
    this._pickOffsets = undefined;

    this._createGeometryResults = undefined;
    this._ready = false;

    this._batchTable = undefined;
    this._batchTableAttributeIndices = undefined;
    this._offsetInstanceExtend = undefined;
    this._batchTableOffsetAttribute2DIndex = undefined;
    this._batchTableOffsetsUpdated = false;
    this._instanceBoundingSpheres = undefined;
    this._instanceBoundingSpheresCV = undefined;
    this._tempBoundingSpheres = undefined;
    this._recomputeBoundingSpheres = false;
    this._batchTableBoundingSpheresUpdated = false;
    this._batchTableBoundingSphereAttributeIndices = undefined;
  }

  /**
   * When <code>true</code>, geometry vertices are optimized for the pre and post-vertex-shader caches.
   * @type {boolean}
   * @readonly
   * @default true
   */
  get vertexCacheOptimize() {
    return this._vertexCacheOptimize;
  }

  /**
   * Determines if geometry vertex attributes are interleaved, which can slightly improve rendering performance.
   * @type {boolean}
   * @readonly
   * @default false
   */
  get interleave() {
    return this._interleave;
  }

  /**
   * When <code>true</code>, the primitive does not keep a reference to the input <code>geometryInstances</code> to save memory.
   * @type {boolean}
   * @readonly
   * @default true
   */
  get releaseGeometryInstances() {
    return this._releaseGeometryInstances;
  }

  /**
   * When <code>true</code>, each geometry instance will only be pickable with {@link Scene#pick}.  When <code>false</code>, GPU memory is saved.
   * @type {boolean}
   * @readonly
   * @default true
   */
  get allowPicking() {
    return this._allowPicking;
  }

  /**
   * Determines if the geometry instances will be created and batched on a web worker.
   * @type {boolean}
   * @readonly
   * @default true
   */
  get asynchronous() {
    return this._asynchronous;
  }

  /**
   * When <code>true</code>, geometry vertices are compressed, which will save memory.
   * @type {boolean}
   * @readonly
   * @default true
   */
  get compressVertices() {
    return this._compressVertices;
  }

  /**
   * Determines if the primitive is complete and ready to render.  If this property is
   * true, the primitive will be rendered the next time that {@link Primitive#update}
   * is called.
   *
   * @type {boolean}
   * @readonly
   *
   * @example
   * // Wait for a primitive to become ready before accessing attributes
   * const removeListener = scene.postRender.addEventListener(() => {
   *   if (!frustumPrimitive.ready) {
   *     return;
   *   }
   *
   *   const attributes = primitive.getGeometryInstanceAttributes('an id');
   *   attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(Cesium.Color.AQUA);
   *
   *   removeListener();
   * });
   */
  get ready() {
    return this._ready;
  }

  /**
   * Called when {@link Viewer} or {@link CesiumWidget} render the scene to
   * get the draw commands needed to render this primitive.
   * <p>
   * Do not call this function directly.  This is documented just to
   * list the exceptions that may be propagated when the scene is rendered:
   * </p>
   *
   * @exception {DeveloperError} All instance geometries must have the same primitiveType.
   * @exception {DeveloperError} Appearance and material have a uniform with the same name.
   * @exception {DeveloperError} Primitive.modelMatrix is only supported in 3D mode.
   * @exception {RuntimeError} Vertex texture fetch support is required to render primitives with per-instance attributes. The maximum number of vertex texture image units must be greater than zero.
   */
  update(frameState) {
    if (
      (!defined(this.geometryInstances) && this._va.length === 0) ||
      (defined(this.geometryInstances) &&
        Array.isArray(this.geometryInstances) &&
        this.geometryInstances.length === 0) ||
      !defined(this.appearance) ||
      (frameState.mode !== SceneMode.SCENE3D && frameState.scene3DOnly) ||
      (!frameState.passes.render && !frameState.passes.pick)
    ) {
      return;
    }

    if (defined(this._error)) {
      throw this._error;
    }

    //>>includeStart('debug', pragmas.debug);
    if (defined(this.rtcCenter) && !frameState.scene3DOnly) {
      throw new DeveloperError(
        "RTC rendering is only available for 3D only scenes.",
      );
    }
    //>>includeEnd('debug');

    if (this._state === PrimitiveState.FAILED) {
      return;
    }

    const context = frameState.context;
    if (!defined(this._batchTable)) {
      createBatchTable(this, context);
    }
    if (this._batchTable.attributes.length > 0) {
      if (context.limits.maximumVertexTextureImageUnits === 0) {
        throw new RuntimeError(
          "Vertex texture fetch support is required to render primitives with per-instance attributes. The maximum number of vertex texture image units must be greater than zero.",
        );
      }
      this._batchTable.update(frameState);
    }

    if (
      this._state !== PrimitiveState.COMPLETE &&
      this._state !== PrimitiveState.COMBINED
    ) {
      if (this.asynchronous) {
        loadAsynchronous(this, frameState);
      } else {
        loadSynchronous(this, frameState);
      }
    }

    if (this._state === PrimitiveState.COMBINED) {
      updateBatchTableBoundingSpheres(this, frameState);
      updateBatchTableOffsets(this, frameState);
      createVertexArray(this, frameState);
    }

    if (!this.show || this._state !== PrimitiveState.COMPLETE) {
      return;
    }

    if (!this._batchTableOffsetsUpdated) {
      updateBatchTableOffsets(this, frameState);
    }
    if (this._recomputeBoundingSpheres) {
      recomputeBoundingSpheres(this, frameState);
    }

    // Create or recreate render state and shader program if appearance/material changed
    const appearance = this.appearance;
    const material = appearance.material;
    let createRS = false;
    let createSP = false;

    if (this._appearance !== appearance) {
      this._appearance = appearance;
      this._material = material;
      createRS = true;
      createSP = true;
    } else if (this._material !== material) {
      this._material = material;
      createSP = true;
    }

    const depthFailAppearance = this.depthFailAppearance;
    const depthFailMaterial = defined(depthFailAppearance)
      ? depthFailAppearance.material
      : undefined;

    if (this._depthFailAppearance !== depthFailAppearance) {
      this._depthFailAppearance = depthFailAppearance;
      this._depthFailMaterial = depthFailMaterial;
      createRS = true;
      createSP = true;
    } else if (this._depthFailMaterial !== depthFailMaterial) {
      this._depthFailMaterial = depthFailMaterial;
      createSP = true;
    }

    const translucent = this._appearance.isTranslucent();
    if (this._translucent !== translucent) {
      this._translucent = translucent;
      createRS = true;
    }

    if (defined(this._material)) {
      this._material.update(context);
    }

    // NEW-WEBGPU-DEPTHFAIL-MATERIAL (Batch 419) — the depthFail material also
    // needs per-frame `update()` so its `_uniformBuffer.gpuData` is populated/
    // refreshed for the WebGPU material twin (greater-depth pass). WebGL pulls
    // the depthFail uniforms through `getUniforms(_depthFailAppearance, …)` each
    // frame; the WebGPU path reads `material._uniformBuffer.gpuData` directly, so
    // the depthFail material must be `update()`-ed here just like `_material`.
    // No-op for the COLOR-appearance depthFail slice (no material) and benign on
    // WebGL (Material.update is backend-neutral).
    if (defined(this._depthFailMaterial)) {
      this._depthFailMaterial.update(context);
    }

    const twoPasses = appearance.closed && translucent;

    // For alternate renderers, skip WebGL-specific render state and shader program creation
    const hasAlternateRenderer = !!context.getFeatureRenderer(
      FeatureRendererKey.PRIMITIVE,
    );

    if (createRS && !hasAlternateRenderer) {
      const rsFunc = this._createRenderStatesFunction ?? createRenderStates;
      rsFunc(this, context, appearance, twoPasses);
    }

    if (createSP && !hasAlternateRenderer) {
      const spFunc = this._createShaderProgramFunction ?? createShaderProgram;
      spFunc(this, frameState, appearance);
    }

    // Q14-HDR-TOGGLE-INVALIDATION — an alternate renderer (WebGPU) bakes the
    // scene render-target color format into its cached pipelines. A mid-session
    // `scene.highDynamicRange` toggle flips that format and bumps
    // `context.renderTargetGeneration`; when it moves we must rebuild the
    // commands so the feature renderer rekeys its pipelines to the new format
    // (otherwise the stale-format pipeline fails attachment validation every
    // frame). WebGL returns a constant 0 here, so this never fires — the
    // WebGL path stays byte-identical.
    const renderTargetGeneration = context.renderTargetGeneration;
    const renderTargetFormatChanged =
      hasAlternateRenderer &&
      this._renderTargetGeneration !== renderTargetGeneration;
    const resourceGeneration = context.resourceGeneration ?? 0;
    const deviceResourcesChanged =
      hasAlternateRenderer && this._resourceGeneration !== resourceGeneration;

    // For alternate renderers, always create commands when they don't exist or when appearance changes
    const needsCommands = hasAlternateRenderer
      ? createRS ||
        createSP ||
        this._colorCommands.length === 0 ||
        renderTargetFormatChanged ||
        deviceResourcesChanged
      : createRS || createSP;

    if (needsCommands) {
      this._renderTargetGeneration = renderTargetGeneration;
      this._resourceGeneration = resourceGeneration;
      const commandFunc = this._createCommandsFunction ?? createCommands;
      commandFunc(
        this,
        appearance,
        material,
        translucent,
        twoPasses,
        this._colorCommands,
        this._pickCommands,
        frameState,
      );
    }

    const updateAndQueueCommandsFunc =
      this._updateAndQueueCommandsFunction ?? updateAndQueueCommands;
    updateAndQueueCommandsFunc(
      this,
      frameState,
      this._colorCommands,
      this._pickCommands,
      this.modelMatrix,
      this.cull,
      this.debugShowBoundingVolume,
      twoPasses,
    );
  }

  /**
   * Returns the modifiable per-instance attributes for a {@link GeometryInstance}.
   *
   * @param {*} id The id of the {@link GeometryInstance}.
   * @returns {object} The typed array in the attribute's format or undefined if the is no instance with id.
   *
   * @exception {DeveloperError} must call update before calling getGeometryInstanceAttributes.
   *
   * @example
   * const attributes = primitive.getGeometryInstanceAttributes('an id');
   * attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(Cesium.Color.AQUA);
   * attributes.show = Cesium.ShowGeometryInstanceAttribute.toValue(true);
   * attributes.distanceDisplayCondition = Cesium.DistanceDisplayConditionGeometryInstanceAttribute.toValue(100.0, 10000.0);
   * attributes.offset = Cesium.OffsetGeometryInstanceAttribute.toValue(Cartesian3.IDENTITY);
   */
  getGeometryInstanceAttributes(id) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(id)) {
      throw new DeveloperError("id is required");
    }
    if (!defined(this._batchTable)) {
      throw new DeveloperError(
        "must call update before calling getGeometryInstanceAttributes",
      );
    }
    //>>includeEnd('debug');

    let attributes = this._perInstanceAttributeCache.get(id);
    if (defined(attributes)) {
      return attributes;
    }

    let index = -1;
    const lastIndex = this._lastPerInstanceAttributeIndex;
    const ids = this._instanceIds;
    const length = ids.length;
    for (let i = 0; i < length; ++i) {
      const curIndex = (lastIndex + i) % length;
      if (id === ids[curIndex]) {
        index = curIndex;
        break;
      }
    }

    if (index === -1) {
      return undefined;
    }

    const batchTable = this._batchTable;
    const perInstanceAttributeIndices = this._batchTableAttributeIndices;
    attributes = {};
    const properties = {};

    for (const name in perInstanceAttributeIndices) {
      if (Object.hasOwn(perInstanceAttributeIndices, name)) {
        const attributeIndex = perInstanceAttributeIndices[name];
        properties[name] = {
          get: createGetFunction(batchTable, index, attributeIndex),
          set: createSetFunction(batchTable, index, attributeIndex, this, name),
        };
      }
    }

    createBoundingSphereProperties(this, properties, index);
    createPickIdProperty(this, properties, index);
    Object.defineProperties(attributes, properties);

    this._lastPerInstanceAttributeIndex = index;
    this._perInstanceAttributeCache.set(id, attributes);
    return attributes;
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   *
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   *
   * @see Primitive#destroy
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
   * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
   * <p>
   * Once an object is destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
   * assign the return value (<code>undefined</code>) to the object as done in the example.
   * </p>
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   * @example
   * e = e && e.destroy();
   *
   * @see Primitive#isDestroyed
   */
  destroy() {
    let length;
    let i;

    this._sp = this._sp && this._sp.destroy();
    this._spDepthFail = this._spDepthFail && this._spDepthFail.destroy();

    const va = this._va;
    length = va.length;
    for (i = 0; i < length; ++i) {
      va[i].destroy();
    }
    this._va = undefined;

    const pickIds = this._pickIds;
    length = pickIds.length;
    for (i = 0; i < length; ++i) {
      pickIds[i].destroy();
    }
    this._pickIds = undefined;

    this._batchTable = this._batchTable && this._batchTable.destroy();

    // These objects may be fairly large and reference other large objects (like Entities).
    // Explicitly set to undefined so memory can be freed even if a reference to the
    // destroyed Primitive has been kept around.
    this._instanceIds = undefined;
    this._perInstanceAttributeCache = undefined;
    this._attributeLocations = undefined;

    return destroyObject(this);
  }
}

// Static method aliases — used by ClassificationPrimitive and GroundPolylinePrimitive
Primitive._modifyShaderPosition = modifyShaderPosition;
Primitive._appendShowToShader = appendShowToShader;
Primitive._updateColorAttribute = updateColorAttribute;
Primitive._updatePickColorAttribute = updatePickColorAttribute;
Primitive._appendOffsetToShader = appendOffsetToShader;
Primitive._appendDistanceDisplayConditionToShader =
  appendDistanceDisplayConditionToShader;
Primitive._updateBoundingVolumes = updateBoundingVolumes;

// --- Instance attribute helpers (per-instance get/set via batch table) ---

function createGetFunction(batchTable, instanceIndex, attributeIndex) {
  return function () {
    const attributeValue = batchTable.getBatchedAttribute(
      instanceIndex,
      attributeIndex,
    );
    const attribute = batchTable.attributes[attributeIndex];
    const componentsPerAttribute = attribute.componentsPerAttribute;
    const value = ComponentDatatype.createTypedArray(
      attribute.componentDatatype,
      componentsPerAttribute,
    );
    if (defined(attributeValue.constructor.pack)) {
      attributeValue.constructor.pack(attributeValue, value, 0);
    } else {
      value[0] = attributeValue;
    }
    return value;
  };
}

function createSetFunction(
  batchTable,
  instanceIndex,
  attributeIndex,
  primitive,
  name,
) {
  return function (value) {
    //>>includeStart('debug', pragmas.debug);
    if (
      !defined(value) ||
      !defined(value.length) ||
      value.length < 1 ||
      value.length > 4
    ) {
      throw new DeveloperError(
        "value must be and array with length between 1 and 4.",
      );
    }
    //>>includeEnd('debug');
    const attributeValue = getAttributeValue(value);
    batchTable.setBatchedAttribute(
      instanceIndex,
      attributeIndex,
      attributeValue,
    );
    if (name === "offset") {
      primitive._recomputeBoundingSpheres = true;
      primitive._batchTableOffsetsUpdated = false;
    }
  };
}

const offsetScratch = new Cartesian3();

function createBoundingSphereProperties(primitive, properties, index) {
  properties.boundingSphere = {
    get: function () {
      let boundingSphere = primitive._instanceBoundingSpheres[index];
      if (defined(boundingSphere)) {
        boundingSphere = boundingSphere.clone();
        const modelMatrix = primitive.modelMatrix;
        const offset = properties.offset;
        if (defined(offset)) {
          transformBoundingSphere(
            boundingSphere,
            Cartesian3.fromArray(offset.get(), 0, offsetScratch),
            primitive._offsetInstanceExtend[index],
          );
        }
        if (defined(modelMatrix)) {
          boundingSphere = BoundingSphere.transform(
            boundingSphere,
            modelMatrix,
          );
        }
      }

      return boundingSphere;
    },
  };
  properties.boundingSphereCV = {
    get: function () {
      return primitive._instanceBoundingSpheresCV[index];
    },
  };
}

function createPickIdProperty(primitive, properties, index) {
  properties.pickId = {
    get: function () {
      return primitive._pickIds[index];
    },
  };
}

export default Primitive;
