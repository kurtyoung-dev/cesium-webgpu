import AttributeCompression from "../Core/AttributeCompression.js";
import BoundingRectangle from "../Core/BoundingRectangle.js";
import BoundingSphere from "../Core/BoundingSphere.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Check from "../Core/Check.js";
import Color from "../Core/Color.js";
import ComponentDatatype from "../Core/ComponentDatatype.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import EncodedCartesian3 from "../Core/EncodedCartesian3.js";
import IndexDatatype from "../Core/IndexDatatype.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import Buffer from "../Renderer/Buffer.js";
import BufferUsage from "../Renderer/BufferUsage.js";
import ContextLimits from "../Renderer/ContextLimits.js";
import DrawCommand from "../Renderer/DrawCommand.js";
import Pass from "../Renderer/Pass.js";
import RenderState from "../Renderer/RenderState.js";
import ShaderProgram from "../Renderer/ShaderProgram.js";
import ShaderSource from "../Renderer/ShaderSource.js";
import VertexArrayFacade from "../Renderer/VertexArrayFacade.js";
import BillboardCollectionFS from "../Shaders/BillboardCollectionFS.js";
import BillboardCollectionVS from "../Shaders/BillboardCollectionVS.js";
import Billboard from "./Billboard.js";
import BlendingState from "./BlendingState.js";
import BlendOption from "./BlendOption.js";
import HeightReference, { isHeightReferenceClamp } from "./HeightReference.js";
import HorizontalOrigin from "./HorizontalOrigin.js";
import SceneMode from "./SceneMode.js";
import SDFSettings from "./SDFSettings.js";
import TextureAtlas from "../Renderer/TextureAtlas.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import VerticalOrigin from "./VerticalOrigin.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import WebGLConstants from "../Core/WebGLConstants.js";
import DeveloperError from "../Core/DeveloperError.js";

const SHOW_INDEX = Billboard.SHOW_INDEX;
const POSITION_INDEX = Billboard.POSITION_INDEX;
const PIXEL_OFFSET_INDEX = Billboard.PIXEL_OFFSET_INDEX;
const EYE_OFFSET_INDEX = Billboard.EYE_OFFSET_INDEX;
const HORIZONTAL_ORIGIN_INDEX = Billboard.HORIZONTAL_ORIGIN_INDEX;
const VERTICAL_ORIGIN_INDEX = Billboard.VERTICAL_ORIGIN_INDEX;
const SCALE_INDEX = Billboard.SCALE_INDEX;
const IMAGE_INDEX_INDEX = Billboard.IMAGE_INDEX_INDEX;
const COLOR_INDEX = Billboard.COLOR_INDEX;
const ROTATION_INDEX = Billboard.ROTATION_INDEX;
const ALIGNED_AXIS_INDEX = Billboard.ALIGNED_AXIS_INDEX;
const SCALE_BY_DISTANCE_INDEX = Billboard.SCALE_BY_DISTANCE_INDEX;
const TRANSLUCENCY_BY_DISTANCE_INDEX = Billboard.TRANSLUCENCY_BY_DISTANCE_INDEX;
const PIXEL_OFFSET_SCALE_BY_DISTANCE_INDEX =
  Billboard.PIXEL_OFFSET_SCALE_BY_DISTANCE_INDEX;
const DISTANCE_DISPLAY_CONDITION_INDEX = Billboard.DISTANCE_DISPLAY_CONDITION;
const DISABLE_DEPTH_DISTANCE = Billboard.DISABLE_DEPTH_DISTANCE;
const TEXTURE_COORDINATE_BOUNDS = Billboard.TEXTURE_COORDINATE_BOUNDS;
const SDF_INDEX = Billboard.SDF_INDEX;
const SPLIT_DIRECTION_INDEX = Billboard.SPLIT_DIRECTION_INDEX;
const NUMBER_OF_PROPERTIES = Billboard.NUMBER_OF_PROPERTIES;

const attributeLocations = {
  direction: 0,
  positionHighAndScale: 1,
  positionLowAndRotation: 2, // texture offset in w
  compressedAttribute0: 3,
  compressedAttribute1: 4,
  compressedAttribute2: 5,
  eyeOffset: 6, // texture range in w
  scaleByDistance: 7,
  pixelOffsetScaleByDistance: 8,
  compressedAttribute3: 9,
  textureCoordinateBoundsOrLabelTranslate: 10,
  a_batchId: 11,
  sdf: 12,
  splitDirection: 13,
};

/**
 * A renderable collection of billboards.  Billboards are viewport-aligned
 * images positioned in the 3D scene.
 * <br /><br />
 * <div align='center'>
 * <img src='Images/Billboard.png' width='400' height='300' /><br />
 * Example billboards
 * </div>
 * <br /><br />
 * Billboards are added and removed from the collection using {@link BillboardCollection#add}
 * and {@link BillboardCollection#remove}.  Billboards in a collection automatically share textures
 * for images with the same identifier.
 *
 * @alias BillboardCollection
 *
 * @param {object} [options] Object with the following properties:
 * @param {Matrix4} [options.modelMatrix=Matrix4.IDENTITY] The 4x4 transformation matrix that transforms each billboard from model to world coordinates.
 * @param {boolean} [options.debugShowBoundingVolume=false] For debugging only. Determines if this primitive's commands' bounding spheres are shown.
 * @param {Scene} [options.scene] Must be passed in for billboards that use the height reference property or will be depth tested against the globe.
 * @param {BlendOption} [options.blendOption=BlendOption.OPAQUE_AND_TRANSLUCENT] The billboard blending option. The default
 * is used for rendering both opaque and translucent billboards. However, if either all of the billboards are completely opaque or all are completely translucent,
 * setting the technique to BlendOption.OPAQUE or BlendOption.TRANSLUCENT can improve performance by up to 2x.
 * @param {boolean} [options.show=true] Determines if the billboards in the collection will be shown.
 * @param {number} [options.coarseDepthTestDistance] The distance from the camera, beyond which, billboards are depth-tested against an approximation of the globe ellipsoid rather than against the full globe depth buffer. If unspecified, the default value is determined relative to the value of {@link Ellipsoid.default}.
 * @param {number} [options.threePointDepthTestDistance] The distance from the camera, within which, billboards with a {@link Billboard#heightReference} value of {@link HeightReference.CLAMP_TO_GROUND} or {@link HeightReference.CLAMP_TO_TERRAIN} are depth tested against three key points. This ensures that if any key point of the billboard is visible, the whole billboard will be visible. If unspecified, the default value is determined relative to the value of {@link Ellipsoid.default}.
 * @performance For best performance, prefer a few collections, each with many billboards, to
 * many collections with only a few billboards each.  Organize collections so that billboards
 * with the same update frequency are in the same collection, i.e., billboards that do not
 * change should be in one collection; billboards that change every frame should be in another
 * collection; and so on.
 *
 * @see BillboardCollection#add
 * @see BillboardCollection#remove
 * @see Billboard
 * @see LabelCollection
 *
 * @demo {@link https://sandcastle.cesium.com/index.html?id=billboards|Cesium Sandcastle Billboard Demo}
 *
 * @example
 * // Create a billboard collection with two billboards
 * const billboards = scene.primitives.add(new Cesium.BillboardCollection());
 * billboards.add({
 *   position : new Cesium.Cartesian3(1.0, 2.0, 3.0),
 *   image : 'url/to/image'
 * });
 * billboards.add({
 *   position : new Cesium.Cartesian3(4.0, 5.0, 6.0),
 *   image : 'url/to/another/image'
 * });
 */
class BillboardCollection {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    this._scene = options.scene;
    this._batchTable = options.batchTable;

    let textureAtlas = options.textureAtlas; // Hidden option for internal use
    if (!defined(textureAtlas)) {
      textureAtlas = new TextureAtlas();
    }
    this._textureAtlas = textureAtlas;
    this._textureAtlasGUID = textureAtlas.guid;
    this._destroyTextureAtlas = true;
    this._billboardTextureCache = new Map();

    this._sp = undefined;
    this._spTranslucent = undefined;
    this._rsOpaque = undefined;
    this._rsTranslucent = undefined;
    this._vaf = undefined;

    this._billboards = [];
    this._billboardsToUpdate = [];
    this._billboardsToUpdateIndex = 0;
    this._billboardsRemoved = false;
    this._createVertexArray = false;

    this._shaderRotation = false;
    this._compiledShaderRotation = false;

    this._shaderAlignedAxis = false;
    this._compiledShaderAlignedAxis = false;

    this._shaderScaleByDistance = false;
    this._compiledShaderScaleByDistance = false;

    this._shaderTranslucencyByDistance = false;
    this._compiledShaderTranslucencyByDistance = false;

    this._shaderPixelOffsetScaleByDistance = false;
    this._compiledShaderPixelOffsetScaleByDistance = false;

    this._shaderDistanceDisplayCondition = false;
    this._compiledShaderDistanceDisplayCondition = false;

    this._shaderDisableDepthDistance = false;
    this._compiledShaderDisableDepthDistance = false;

    this._shaderClampToGround = false;
    this._compiledShaderClampToGround = false;

    this._propertiesChanged = new Uint32Array(NUMBER_OF_PROPERTIES);

    this._maxSize = 0.0;
    this._maxEyeOffset = 0.0;
    this._maxScale = 1.0;
    this._maxPixelOffset = 0.0;
    this._allHorizontalCenter = true;
    this._allVerticalCenter = true;
    this._allSizedInMeters = true;

    this._baseVolume = new BoundingSphere();
    this._baseVolumeWC = new BoundingSphere();
    this._baseVolume2D = new BoundingSphere();
    this._boundingVolume = new BoundingSphere();
    this._boundingVolumeDirty = false;

    this._colorCommands = [];

    this._allBillboardsReady = false;

    /**
     * Determines if billboards in this collection will be shown.
     *
     * @type {boolean}
     * @default true
     */
    this.show = options.show ?? true;

    /**
     * The render priority for this collection. Higher values render on top
     * (later in draw order). Maps to DrawCommand.sortPriority.
     * @type {number}
     * @default 0
     */
    this.renderPriority = options.renderPriority ?? 0;

    /**
     * The render layer order for this collection. Maps to DrawCommand.sortLayer.
     * @type {number}
     * @default 50
     */
    this.renderLayer = options.renderLayer ?? 50;

    /**
     * The 4x4 transformation matrix that transforms each billboard in this collection from model to world coordinates.
     * When this is the identity matrix, the billboards are drawn in world coordinates, i.e., Earth's WGS84 coordinates.
     * Local reference frames can be used by providing a different transformation matrix, like that returned
     * by {@link Transforms.eastNorthUpToFixedFrame}.
     *
     * @type {Matrix4}
     * @default {@link Matrix4.IDENTITY}
     *
     *
     * @example
     * const center = Cesium.Cartesian3.fromDegrees(-75.59777, 40.03883);
     * billboards.modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(center);
     * billboards.add({
     *   image : 'url/to/image',
     *   position : new Cesium.Cartesian3(0.0, 0.0, 0.0) // center
     * });
     * billboards.add({
     *   image : 'url/to/image',
     *   position : new Cesium.Cartesian3(1000000.0, 0.0, 0.0) // east
     * });
     * billboards.add({
     *   image : 'url/to/image',
     *   position : new Cesium.Cartesian3(0.0, 1000000.0, 0.0) // north
     * });
     * billboards.add({
     *   image : 'url/to/image',
     *   position : new Cesium.Cartesian3(0.0, 0.0, 1000000.0) // up
     * });
     *
     * @see Transforms.eastNorthUpToFixedFrame
     */
    this.modelMatrix = Matrix4.clone(options.modelMatrix ?? Matrix4.IDENTITY);
    this._modelMatrix = Matrix4.clone(Matrix4.IDENTITY);

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
     * This property is for debugging only; it is not for production use nor is it optimized.
     * <p>
     * Draws the texture atlas for this BillboardCollection as a fullscreen quad.
     * </p>
     *
     * @type {boolean}
     *
     * @default false
     */
    this.debugShowTextureAtlas = options.debugShowTextureAtlas ?? false;

    /**
     * The billboard blending option. The default is used for rendering both opaque and translucent billboards.
     * However, if either all of the billboards are completely opaque or all are completely translucent,
     * setting the technique to BlendOption.OPAQUE or BlendOption.TRANSLUCENT can improve
     * performance by up to 2x.
     * @type {BlendOption}
     * @default BlendOption.OPAQUE_AND_TRANSLUCENT
     */
    this.blendOption =
      options.blendOption ?? BlendOption.OPAQUE_AND_TRANSLUCENT;
    this._blendOption = undefined;

    this._mode = SceneMode.SCENE3D;

    // The buffer usage for each attribute is determined based on the usage of the attribute over time.
    this._buffersUsage = [
      BufferUsage.STATIC_DRAW, // SHOW_INDEX
      BufferUsage.STATIC_DRAW, // POSITION_INDEX
      BufferUsage.STATIC_DRAW, // PIXEL_OFFSET_INDEX
      BufferUsage.STATIC_DRAW, // EYE_OFFSET_INDEX
      BufferUsage.STATIC_DRAW, // HORIZONTAL_ORIGIN_INDEX
      BufferUsage.STATIC_DRAW, // VERTICAL_ORIGIN_INDEX
      BufferUsage.STATIC_DRAW, // SCALE_INDEX
      BufferUsage.STATIC_DRAW, // IMAGE_INDEX_INDEX
      BufferUsage.STATIC_DRAW, // COLOR_INDEX
      BufferUsage.STATIC_DRAW, // ROTATION_INDEX
      BufferUsage.STATIC_DRAW, // ALIGNED_AXIS_INDEX
      BufferUsage.STATIC_DRAW, // SCALE_BY_DISTANCE_INDEX
      BufferUsage.STATIC_DRAW, // TRANSLUCENCY_BY_DISTANCE_INDEX
      BufferUsage.STATIC_DRAW, // PIXEL_OFFSET_SCALE_BY_DISTANCE_INDEX
      BufferUsage.STATIC_DRAW, // DISTANCE_DISPLAY_CONDITION_INDEX
      BufferUsage.STATIC_DRAW, // TEXTURE_COORDINATE_BOUNDS
      BufferUsage.STATIC_DRAW, // SPLIT_DIRECTION_INDEX
    ];

    this._highlightColor = Color.clone(Color.WHITE); // Only used by Vector3DTilePoints
    this._coarseDepthTestDistance =
      options.coarseDepthTestDistance ?? Ellipsoid.default.minimumRadius / 10.0;
    this._threePointDepthTestDistance =
      options.threePointDepthTestDistance ??
      Ellipsoid.default.minimumRadius / 1000.0;

    this._uniforms = {
      u_atlas: () => {
        return this.textureAtlas.texture;
      },
      u_highlightColor: () => {
        return this._highlightColor;
      },
      u_coarseDepthTestDistance: () => {
        return this._coarseDepthTestDistance;
      },
      u_threePointDepthTestDistance: () => {
        return this._threePointDepthTestDistance;
      },
    };

    const scene = this._scene;
    if (defined(scene) && defined(scene.terrainProviderChanged)) {
      this._removeCallbackFunc = scene.terrainProviderChanged.addEventListener(
        function () {
          const billboards = this._billboards;
          const length = billboards.length;
          for (let i = 0; i < length; ++i) {
            if (defined(billboards[i])) {
              billboards[i]._updateClamping();
            }
          }
        },
        this,
      );
    }
  }

  /**
   * Returns the number of billboards in this collection.  This is commonly used with
   * {@link BillboardCollection#get} to iterate over all the billboards
   * in the collection.
   * @type {number}
   * @readonly
   */
  get length() {
    removeBillboards(this);
    return this._billboards.length;
  }

  /**
   * Gets or sets the textureAtlas.
   * @type {TextureAtlas}
   * @private
   */
  get textureAtlas() {
    return this._textureAtlas;
  }
  set textureAtlas(value) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("textureAtlas", value);
    //>>includeEnd('debug');

    if (this._textureAtlas !== value) {
      this._textureAtlas =
        this._destroyTextureAtlas &&
        this._textureAtlas &&
        this._textureAtlas.destroy();
      this._textureAtlas = value;
    }
  }

  /**
   * Gets or sets a value which determines if the texture atlas is
   * destroyed when the collection is destroyed.
   *
   * If the texture atlas is used by more than one collection, set this to <code>false</code>,
   * and explicitly destroy the atlas to avoid attempting to destroy it multiple times.
   *
   * @type {boolean}
   * @private
   *
   * @example
   * // Set destroyTextureAtlas
   * // Destroy a billboard collection but not its texture atlas.
   *
   * const atlas = new TextureAtlas();
   * billboards.textureAtlas = atlas;
   * billboards.destroyTextureAtlas = false;
   *
   * billboards = billboards.destroy();
   * console.log(atlas.isDestroyed()); // False
   */
  get destroyTextureAtlas() {
    return this._destroyTextureAtlas;
  }
  set destroyTextureAtlas(value) {
    this._destroyTextureAtlas = value;
  }

  /**
   * Returns the size in bytes of the WebGL texture resources.
   * @private
   * @type {number}
   * @readonly
   */
  get sizeInBytes() {
    return this._textureAtlas.sizeInBytes;
  }

  /**
   * True when all billboards currently in the collection are ready for rendering.
   * @private
   * @type {boolean}
   * @readonly
   */
  get ready() {
    return this._allBillboardsReady;
  }

  /**
   * Cache of loaded billboard images.
   * @private
   * @type {Map<string, BillboardTexture>}
   * @readonly
   */
  get billboardTextureCache() {
    return this._billboardTextureCache;
  }

  /**
   * The distance from the camera, beyond which, billboards are depth-tested against an approximation of
   * the globe ellipsoid rather than against the full globe depth buffer.
   * @type {number}
   */
  get coarseDepthTestDistance() {
    return this._coarseDepthTestDistance;
  }
  set coarseDepthTestDistance(value) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number("coarseDepthTestDistance", value);
    //>>includeEnd('debug');
    this._coarseDepthTestDistance = value;
  }

  /**
   * The distance from the camera, within which, billboards with a {@link Billboard#heightReference} value
   * of {@link HeightReference.CLAMP_TO_GROUND} or {@link HeightReference.CLAMP_TO_TERRAIN} are depth tested
   * against three key points.
   * @see {@link https://cesium.com/blog/2018/07/30/billboards-on-terrain-improvements/|Billboards and Labels on Terrain Improvements}
   * @type {number}
   */
  get threePointDepthTestDistance() {
    return this._threePointDepthTestDistance;
  }
  set threePointDepthTestDistance(value) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number("threePointDepthTestDistance", value);
    //>>includeEnd('debug');
    this._threePointDepthTestDistance = value;
  }

  /**
   * Creates and adds a billboard with the specified initial properties to the collection.
   * The added billboard is returned so it can be modified or removed from the collection later.
   *
   * @param {Billboard.ConstructorOptions}[options] A template describing the billboard's properties as shown in Example 1.
   * @returns {Billboard} The billboard that was added to the collection.
   *
   * @performance Calling <code>add</code> is expected constant time.  However, the collection's vertex buffer
   * is rewritten - an <code>O(n)</code> operation that also incurs CPU to GPU overhead.  For
   * best performance, add as many billboards as possible before calling <code>update</code>.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   *
   * @example
   * // Example 1:  Add a billboard, specifying all the default values.
   * const b = billboards.add({
   *   show : true,
   *   position : Cesium.Cartesian3.ZERO,
   *   pixelOffset : Cesium.Cartesian2.ZERO,
   *   eyeOffset : Cesium.Cartesian3.ZERO,
   *   heightReference : Cesium.HeightReference.NONE,
   *   horizontalOrigin : Cesium.HorizontalOrigin.CENTER,
   *   verticalOrigin : Cesium.VerticalOrigin.CENTER,
   *   scale : 1.0,
   *   image : 'url/to/image',
   *   imageSubRegion : undefined,
   *   color : Cesium.Color.WHITE,
   *   id : undefined,
   *   rotation : 0.0,
   *   alignedAxis : Cesium.Cartesian3.ZERO,
   *   width : undefined,
   *   height : undefined,
   *   scaleByDistance : undefined,
   *   translucencyByDistance : undefined,
   *   pixelOffsetScaleByDistance : undefined,
   *   sizeInMeters : false,
   *   distanceDisplayCondition : undefined
   * });
   *
   * @example
   * // Example 2:  Specify only the billboard's cartographic position.
   * const b = billboards.add({
   *   position : Cesium.Cartesian3.fromDegrees(longitude, latitude, height)
   * });
   *
   * @see BillboardCollection#remove
   * @see BillboardCollection#removeAll
   */
  add(options) {
    const billboard = new Billboard(options, this);
    billboard._index = this._billboards.length;

    this._billboards.push(billboard);
    this._createVertexArray = true;

    return billboard;
  }

  /**
   * Removes a billboard from the collection.
   *
   * @param {Billboard} billboard The billboard to remove.
   * @returns {boolean} <code>true</code> if the billboard was removed; <code>false</code> if the billboard was not found in the collection.
   *
   * @performance Calling <code>remove</code> is expected constant time.  However, the collection's vertex buffer
   * is rewritten - an <code>O(n)</code> operation that also incurs CPU to GPU overhead.  For
   * best performance, remove as many billboards as possible before calling <code>update</code>.
   * If you intend to temporarily hide a billboard, it is usually more efficient to call
   * {@link Billboard#show} instead of removing and re-adding the billboard.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   *
   * @example
   * const b = billboards.add(...);
   * billboards.remove(b);  // Returns true
   *
   * @see BillboardCollection#add
   * @see BillboardCollection#removeAll
   * @see Billboard#show
   */
  remove(billboard) {
    if (this.contains(billboard)) {
      this._billboards[billboard._index] = undefined; // Removed later
      this._billboardsRemoved = true;
      this._createVertexArray = true;
      billboard._destroy();
      return true;
    }

    return false;
  }

  /**
   * Removes all billboards from the collection.
   *
   * @performance <code>O(n)</code>.  It is more efficient to remove all the billboards
   * from a collection and then add new ones than to create a new collection entirely.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   *
   * @example
   * billboards.add(...);
   * billboards.add(...);
   * billboards.removeAll();
   *
   * @see BillboardCollection#add
   * @see BillboardCollection#remove
   */
  removeAll() {
    destroyBillboards(this._billboards);
    this._billboards = [];
    this._billboardsToUpdate = [];
    this._billboardsToUpdateIndex = 0;
    this._billboardsRemoved = false;

    this._createVertexArray = true;
  }

  /**
   * @private
   */
  _updateBillboard(billboard, propertyChanged) {
    if (!billboard._dirty) {
      this._billboardsToUpdate[this._billboardsToUpdateIndex++] = billboard;
    }

    ++this._propertiesChanged[propertyChanged];
  }

  /**
   * Clear the per-frame dirty-tracking state once a renderer has consumed it
   * for this frame — the "dirties consumed" semantics the WebGL vertex build
   * applies inline (it clears `billboard._dirty`/`.textureDirty` while writing,
   * and resets `_createVertexArray` / `_billboardsToUpdateIndex` /
   * `_propertiesChanged`).
   *
   * The WebGPU feature renderer REPLACES the vertex build, so it must call this
   * after capturing the instance data — otherwise `updateMode` (gated on
   * `_createVertexArray`) re-projects every position and the readiness loop
   * (gated on `textureDirty`) re-marks every image EVERY frame, so the
   * collection looks fully dirty forever (measured: ≈4 spurious
   * `_updateBillboard` calls per billboard per frame). That defeats any dirty
   * gate or per-instance partial-update path. Backend-agnostic and safe for the
   * WebGL path to call too; placed on the collection so Billboard / Label /
   * Point can share one dirty-lifecycle contract.
   * @private
   */
  _consumeDirtyState() {
    const billboards = this._billboards;
    const length = billboards.length;
    for (let i = 0; i < length; ++i) {
      const billboard = billboards[i];
      if (defined(billboard)) {
        billboard._dirty = false;
        billboard.textureDirty = false;
      }
    }
    this._billboardsToUpdateIndex = 0;
    this._createVertexArray = false;
    const propertiesChanged = this._propertiesChanged;
    for (let k = 0; k < propertiesChanged.length; ++k) {
      propertiesChanged[k] = 0;
    }
  }

  /**
   * Check whether this collection contains a given billboard.
   *
   * @param {Billboard} [billboard] The billboard to check for.
   * @returns {boolean} true if this collection contains the billboard, false otherwise.
   *
   * @see BillboardCollection#get
   */
  contains(billboard) {
    return defined(billboard) && billboard._billboardCollection === this;
  }

  /**
   * Returns the billboard in the collection at the specified index.  Indices are zero-based
   * and increase as billboards are added.  Removing a billboard shifts all billboards after
   * it to the left, changing their indices.  This function is commonly used with
   * {@link BillboardCollection#length} to iterate over all the billboards
   * in the collection.
   *
   * @param {number} index The zero-based index of the billboard.
   * @returns {Billboard} The billboard at the specified index.
   *
   * @performance Expected constant time.  If billboards were removed from the collection and
   * {@link BillboardCollection#update} was not called, an implicit <code>O(n)</code>
   * operation is performed.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   *
   * @example
   * // Toggle the show property of every billboard in the collection
   * const len = billboards.length;
   * for (let i = 0; i < len; ++i) {
   *   const b = billboards.get(i);
   *   b.show = !b.show;
   * }
   *
   * @see BillboardCollection#length
   */
  get(index) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number("index", index);
    //>>includeEnd('debug');

    removeBillboards(this);
    return this._billboards[index];
  }

  computeNewBuffersUsage() {
    const buffersUsage = this._buffersUsage;
    let usageChanged = false;

    const properties = this._propertiesChanged;
    for (let k = 0; k < NUMBER_OF_PROPERTIES; ++k) {
      const newUsage =
        properties[k] === 0 ? BufferUsage.STATIC_DRAW : BufferUsage.STREAM_DRAW;
      usageChanged = usageChanged || buffersUsage[k] !== newUsage;
      buffersUsage[k] = newUsage;
    }

    return usageChanged;
  }

  /**
   * Called when {@link Viewer} or {@link CesiumWidget} render the scene to
   * get the draw commands needed to render this primitive.
   * <p>
   * Do not call this function directly.  This is documented just to
   * list the exceptions that may be propagated when the scene is rendered:
   * </p>
   *
   * @exception {RuntimeError} image with id must be in the atlas.
   */
  update(frameState) {
    // ─── Shared scene logic (runs for BOTH WebGL and WebGPU) ───
    // Returns false when the collection is hidden — skip rendering entirely.
    if (!runSharedSceneLogic(this, frameState)) {
      return;
    }
    // ─── End shared scene logic ───

    const context = frameState.context;

    // Backend-specific rendering path — delegate to feature renderer if available
    const fr = context.getFeatureRenderer(
      FeatureRendererKey.BILLBOARD_COLLECTION,
    );
    if (fr) {
      this._featureRenderer = fr;
      // The WebGL path below computes the collection bounding volume (after its
      // own vertex build) via `updateBoundingVolume`, which the draw command's
      // frustum-cull test needs. The FR replaces that path, so compute the
      // bounding volume here for WebGPU. Without it the command carried the
      // default degenerate sphere (center 0,0,0, radius 0 = Earth's centre,
      // outside every frustum) AND — once the center was fixed — a radius-0
      // sphere sitting exactly on the surface was horizon-occluded; either way
      // `View.createPotentiallyVisibleSet` silently culled the command, so
      // billboards/labels never rendered on WebGPU in any scene mode.
      computeBoundingVolumeForFeatureRenderer(this, frameState);
      fr.update(this, frameState, frameState.commandList);
      return;
    }

    if (
      !context.instancedArrays ||
      !(ContextLimits.maximumVertexTextureImageUnits > 0)
    ) {
      throw new DeveloperError(
        "Beginning in CesiumJS 1.140, billboards and labels require device support for WebGL 2, " +
          "or WebGL 1 with ANGLE_instanced_arrays and MAX_VERTEX_TEXTURE_IMAGE_UNITS > 0. For more " +
          "information or to share feedback, see: https://github.com/CesiumGS/cesium/issues/13053",
      );
    }

    const textureAtlas = this._textureAtlas;

    if (!defined(textureAtlas.texture)) {
      return;
    }

    updateMode(this, frameState);

    const billboards = this._billboards;
    const billboardsLength = billboards.length;
    const billboardsToUpdate = this._billboardsToUpdate;
    const billboardsToUpdateLength = this._billboardsToUpdateIndex;

    const properties = this._propertiesChanged;

    const textureAtlasGUID = textureAtlas.guid;
    const createVertexArray =
      this._createVertexArray || this._textureAtlasGUID !== textureAtlasGUID;
    this._textureAtlasGUID = textureAtlasGUID;

    let vafWriters;
    const pass = frameState.passes;
    const picking = pass.pick;

    if (createVertexArray || (!picking && this.computeNewBuffersUsage())) {
      this._createVertexArray = false;

      for (let k = 0; k < NUMBER_OF_PROPERTIES; ++k) {
        properties[k] = 0;
      }

      this._vaf = this._vaf && this._vaf.destroy();

      if (billboardsLength > 0) {
        this._vaf = createVAF(
          context,
          billboardsLength,
          this._buffersUsage,
          this._batchTable,
          this._sdf,
        );
        vafWriters = this._vaf.writers;

        for (let i = 0; i < billboardsLength; ++i) {
          const billboard = this._billboards[i];
          billboard._dirty = false;
          billboard.textureDirty = false;
          writeBillboard(this, frameState, vafWriters, billboard);
        }

        this._vaf.commit(getIndexBuffer(context));
      }

      this._billboardsToUpdateIndex = 0;
    } else if (billboardsToUpdateLength > 0) {
      const writers = scratchWriterArray;
      writers.length = 0;

      if (
        properties[POSITION_INDEX] ||
        properties[ROTATION_INDEX] ||
        properties[SCALE_INDEX]
      ) {
        writers.push(writePositionScaleAndRotation);
      }
      if (
        properties[IMAGE_INDEX_INDEX] ||
        properties[PIXEL_OFFSET_INDEX] ||
        properties[HORIZONTAL_ORIGIN_INDEX] ||
        properties[VERTICAL_ORIGIN_INDEX] ||
        properties[SHOW_INDEX]
      ) {
        writers.push(writeCompressedAttrib0);
        writers.push(writeEyeOffset);
      }
      if (
        properties[IMAGE_INDEX_INDEX] ||
        properties[ALIGNED_AXIS_INDEX] ||
        properties[TRANSLUCENCY_BY_DISTANCE_INDEX]
      ) {
        writers.push(writeCompressedAttrib1);
        writers.push(writeCompressedAttrib2);
      }
      if (properties[IMAGE_INDEX_INDEX] || properties[COLOR_INDEX]) {
        writers.push(writeCompressedAttrib2);
      }
      if (properties[IMAGE_INDEX_INDEX] || properties[EYE_OFFSET_INDEX]) {
        writers.push(writeEyeOffset);
      }
      if (properties[SCALE_BY_DISTANCE_INDEX]) {
        writers.push(writeScaleByDistance);
      }
      if (properties[PIXEL_OFFSET_SCALE_BY_DISTANCE_INDEX]) {
        writers.push(writePixelOffsetScaleByDistance);
      }
      if (
        properties[DISTANCE_DISPLAY_CONDITION_INDEX] ||
        properties[DISABLE_DEPTH_DISTANCE] ||
        properties[IMAGE_INDEX_INDEX] ||
        properties[POSITION_INDEX]
      ) {
        writers.push(writeCompressedAttribute3);
      }
      if (properties[IMAGE_INDEX_INDEX] || properties[POSITION_INDEX]) {
        writers.push(writeTextureCoordinateBoundsOrLabelTranslate);
      }
      if (properties[SDF_INDEX]) {
        writers.push(writeSDF);
      }
      if (properties[SPLIT_DIRECTION_INDEX]) {
        writers.push(writeSplitDirection);
      }

      const numWriters = writers.length;
      vafWriters = this._vaf.writers;

      if (billboardsToUpdateLength / billboardsLength > 0.1) {
        for (let m = 0; m < billboardsToUpdateLength; ++m) {
          const b = billboardsToUpdate[m];
          b._dirty = false;
          b.textureDirty = false;
          for (let n = 0; n < numWriters; ++n) {
            writers[n](this, frameState, vafWriters, b);
          }
        }
        this._vaf.commit(getIndexBuffer(context));
      } else {
        for (let h = 0; h < billboardsToUpdateLength; ++h) {
          const bb = billboardsToUpdate[h];
          bb._dirty = false;
          bb.textureDirty = false;
          for (let o = 0; o < numWriters; ++o) {
            writers[o](this, frameState, vafWriters, bb);
          }
          this._vaf.subCommit(bb._index, 1);
        }
        this._vaf.endSubCommits();
      }

      this._billboardsToUpdateIndex = 0;
    }

    if (billboardsToUpdateLength > billboardsLength * 1.5) {
      billboardsToUpdate.length = billboardsLength;
    }

    if (!defined(this._vaf) || !defined(this._vaf.va)) {
      return;
    }

    if (this._boundingVolumeDirty) {
      this._boundingVolumeDirty = false;
      BoundingSphere.transform(
        this._baseVolume,
        this.modelMatrix,
        this._baseVolumeWC,
      );
    }

    let boundingVolume;
    let modelMatrix = Matrix4.IDENTITY;
    if (frameState.mode === SceneMode.SCENE3D) {
      modelMatrix = this.modelMatrix;
      boundingVolume = BoundingSphere.clone(
        this._baseVolumeWC,
        this._boundingVolume,
      );
    } else {
      boundingVolume = BoundingSphere.clone(
        this._baseVolume2D,
        this._boundingVolume,
      );
    }
    updateBoundingVolume(this, frameState, boundingVolume);

    const blendOptionChanged = this._blendOption !== this.blendOption;
    this._blendOption = this.blendOption;

    if (blendOptionChanged) {
      if (
        this._blendOption === BlendOption.OPAQUE ||
        this._blendOption === BlendOption.OPAQUE_AND_TRANSLUCENT
      ) {
        this._rsOpaque = RenderState.fromCache({
          depthTest: { enabled: true, func: WebGLConstants.LESS },
          depthMask: true,
        });
      } else {
        this._rsOpaque = undefined;
      }

      const useTranslucentDepthMask =
        this._blendOption === BlendOption.TRANSLUCENT;

      if (
        this._blendOption === BlendOption.TRANSLUCENT ||
        this._blendOption === BlendOption.OPAQUE_AND_TRANSLUCENT
      ) {
        this._rsTranslucent = RenderState.fromCache({
          depthTest: {
            enabled: true,
            func: useTranslucentDepthMask
              ? WebGLConstants.LEQUAL
              : WebGLConstants.LESS,
          },
          depthMask: useTranslucentDepthMask,
          blending: BlendingState.ALPHA_BLEND,
        });
      } else {
        this._rsTranslucent = undefined;
      }
    }

    this._shaderDisableDepthDistance =
      this._shaderDisableDepthDistance ||
      frameState.minimumDisableDepthTestDistance !== 0.0;

    let vsSource;
    let fsSource;
    let vs;
    let fs;
    let vertDefines;

    if (
      blendOptionChanged ||
      this._shaderRotation !== this._compiledShaderRotation ||
      this._shaderAlignedAxis !== this._compiledShaderAlignedAxis ||
      this._shaderScaleByDistance !== this._compiledShaderScaleByDistance ||
      this._shaderTranslucencyByDistance !==
        this._compiledShaderTranslucencyByDistance ||
      this._shaderPixelOffsetScaleByDistance !==
        this._compiledShaderPixelOffsetScaleByDistance ||
      this._shaderDistanceDisplayCondition !==
        this._compiledShaderDistanceDisplayCondition ||
      this._shaderDisableDepthDistance !==
        this._compiledShaderDisableDepthDistance ||
      this._shaderClampToGround !== this._compiledShaderClampToGround ||
      this._sdf !== this._compiledSDF
    ) {
      vsSource = BillboardCollectionVS;
      fsSource = BillboardCollectionFS;

      vertDefines = ["INSTANCED"];
      if (defined(this._batchTable)) {
        vertDefines.push("VECTOR_TILE");
        vsSource = this._batchTable.getVertexShaderCallback(
          false,
          "a_batchId",
          undefined,
        )(vsSource);
        fsSource = this._batchTable.getFragmentShaderCallback(
          false,
          undefined,
        )(fsSource);
      }

      vs = new ShaderSource({ defines: vertDefines, sources: [vsSource] });

      if (this._shaderRotation) {
        vs.defines.push("ROTATION");
      }
      if (this._shaderAlignedAxis) {
        vs.defines.push("ALIGNED_AXIS");
      }
      if (this._shaderScaleByDistance) {
        vs.defines.push("EYE_DISTANCE_SCALING");
      }
      if (this._shaderTranslucencyByDistance) {
        vs.defines.push("EYE_DISTANCE_TRANSLUCENCY");
      }
      if (this._shaderPixelOffsetScaleByDistance) {
        vs.defines.push("EYE_DISTANCE_PIXEL_OFFSET");
      }
      if (this._shaderDistanceDisplayCondition) {
        vs.defines.push("DISTANCE_DISPLAY_CONDITION");
      }
      if (this._shaderDisableDepthDistance) {
        vs.defines.push("DISABLE_DEPTH_DISTANCE");
      }
      if (this._shaderClampToGround) {
        vs.defines.push("VS_THREE_POINT_DEPTH_CHECK");
      }

      const sdfEdge = 1.0 - SDFSettings.CUTOFF;
      if (this._sdf) {
        vs.defines.push("SDF");
      }

      const vectorFragDefine = defined(this._batchTable) ? "VECTOR_TILE" : "";

      if (this._blendOption === BlendOption.OPAQUE_AND_TRANSLUCENT) {
        fs = new ShaderSource({
          defines: ["OPAQUE", vectorFragDefine],
          sources: [fsSource],
        });
        if (this._shaderClampToGround) {
          fs.defines.push("VS_THREE_POINT_DEPTH_CHECK");
        }
        if (this._sdf) {
          fs.defines.push("SDF");
          fs.defines.push(`SDF_EDGE ${sdfEdge}`);
        }
        this._sp = ShaderProgram.replaceCache({
          context: context,
          shaderProgram: this._sp,
          vertexShaderSource: vs,
          fragmentShaderSource: fs,
          attributeLocations: attributeLocations,
        });

        fs = new ShaderSource({
          defines: ["TRANSLUCENT", vectorFragDefine],
          sources: [fsSource],
        });
        if (this._shaderClampToGround) {
          fs.defines.push("VS_THREE_POINT_DEPTH_CHECK");
        }
        if (this._sdf) {
          fs.defines.push("SDF");
          fs.defines.push(`SDF_EDGE ${sdfEdge}`);
        }
        this._spTranslucent = ShaderProgram.replaceCache({
          context: context,
          shaderProgram: this._spTranslucent,
          vertexShaderSource: vs,
          fragmentShaderSource: fs,
          attributeLocations: attributeLocations,
        });
      }

      if (this._blendOption === BlendOption.OPAQUE) {
        fs = new ShaderSource({
          defines: [vectorFragDefine],
          sources: [fsSource],
        });
        if (this._shaderClampToGround) {
          fs.defines.push("VS_THREE_POINT_DEPTH_CHECK");
        }
        if (this._sdf) {
          fs.defines.push("SDF");
          fs.defines.push(`SDF_EDGE ${sdfEdge}`);
        }
        this._sp = ShaderProgram.replaceCache({
          context: context,
          shaderProgram: this._sp,
          vertexShaderSource: vs,
          fragmentShaderSource: fs,
          attributeLocations: attributeLocations,
        });
      }

      if (this._blendOption === BlendOption.TRANSLUCENT) {
        fs = new ShaderSource({
          defines: [vectorFragDefine],
          sources: [fsSource],
        });
        if (this._shaderClampToGround) {
          fs.defines.push("VS_THREE_POINT_DEPTH_CHECK");
        }
        if (this._sdf) {
          fs.defines.push("SDF");
          fs.defines.push(`SDF_EDGE ${sdfEdge}`);
        }
        this._spTranslucent = ShaderProgram.replaceCache({
          context: context,
          shaderProgram: this._spTranslucent,
          vertexShaderSource: vs,
          fragmentShaderSource: fs,
          attributeLocations: attributeLocations,
        });
      }

      this._compiledShaderRotation = this._shaderRotation;
      this._compiledShaderAlignedAxis = this._shaderAlignedAxis;
      this._compiledShaderScaleByDistance = this._shaderScaleByDistance;
      this._compiledShaderTranslucencyByDistance =
        this._shaderTranslucencyByDistance;
      this._compiledShaderPixelOffsetScaleByDistance =
        this._shaderPixelOffsetScaleByDistance;
      this._compiledShaderDistanceDisplayCondition =
        this._shaderDistanceDisplayCondition;
      this._compiledShaderDisableDepthDistance =
        this._shaderDisableDepthDistance;
      this._compiledShaderClampToGround = this._shaderClampToGround;
      this._compiledSDF = this._sdf;
    }

    const commandList = frameState.commandList;

    if (pass.render || pass.pick) {
      const colorList = this._colorCommands;

      const opaque = this._blendOption === BlendOption.OPAQUE;
      const opaqueAndTranslucent =
        this._blendOption === BlendOption.OPAQUE_AND_TRANSLUCENT;

      const va = this._vaf.va;
      const vaLength = va.length;

      let uniforms = this._uniforms;
      let pickId;
      if (defined(this._batchTable)) {
        uniforms = this._batchTable.getUniformMapCallback()(uniforms);
        pickId = this._batchTable.getPickId();
      } else {
        pickId = "v_pickColor";
      }

      colorList.length = vaLength;
      const totalLength = opaqueAndTranslucent ? vaLength * 2 : vaLength;
      for (let j = 0; j < totalLength; ++j) {
        let command = colorList[j];
        if (!defined(command)) {
          command = colorList[j] = new DrawCommand();
        }

        const opaqueCommand = opaque || (opaqueAndTranslucent && j % 2 === 0);

        command.pass =
          opaqueCommand || !opaqueAndTranslucent
            ? Pass.OPAQUE
            : Pass.TRANSLUCENT;
        command.owner = this;

        const index = opaqueAndTranslucent ? Math.floor(j / 2.0) : j;
        command.boundingVolume = boundingVolume;
        command.modelMatrix = modelMatrix;
        command.count = va[index].indicesCount;
        command.shaderProgram = opaqueCommand ? this._sp : this._spTranslucent;
        command.uniformMap = uniforms;
        command.vertexArray = va[index].va;
        command.renderState = opaqueCommand
          ? this._rsOpaque
          : this._rsTranslucent;
        command.debugShowBoundingVolume = this.debugShowBoundingVolume;
        command.pickId = pickId;

        command.count = 6;
        command.instanceCount = billboardsLength;

        // SORT-1: Wire collection renderPriority/renderLayer to DrawCommand sort properties
        command.sortPriority = this.renderPriority;
        command.sortLayer = this.renderLayer;

        commandList.push(command);
      }

      if (this.debugShowTextureAtlas) {
        if (!defined(this.debugCommand)) {
          this.debugCommand = createDebugCommand(this, frameState.context);
        }
        commandList.push(this.debugCommand);
      }
    }
  }

  /**
   * WebGPU-only: run the shared scene-logic prologue (atlas upload schedule,
   * actual-position + `_baseVolume` recompute, billboard readiness) AND compute
   * the feature-renderer bounding volume, WITHOUT emitting any draw commands.
   *
   * The {@link LabelCollection} WebGPU path delegates glyph rendering to the
   * dedicated SDF renderer and returns before calling
   * <code>glyphCollection.update()</code>, so it must invoke this on its glyph
   * and background billboard collections itself. Without it the glyph atlas is
   * never uploaded (the SDF pass samples the placeholder and discards) and the
   * glyph bounding volume stays degenerate (radius 0 at Earth's centre), which
   * the frustum cull rejects — labels rendered nothing on WebGPU.
   *
   * This is a no-op consumer of the same code `update()` runs on the WebGPU
   * branch; it must not be called on the WebGL path (which uses the full
   * <code>update()</code>).
   *
   * @param {FrameState} frameState The frame state.
   * @returns {boolean} <code>false</code> when the collection is hidden;
   *   the caller should skip rendering it. <code>true</code> otherwise.
   * @private
   */
  prepareForFeatureRenderer(frameState) {
    if (!runSharedSceneLogic(this, frameState)) {
      return false;
    }
    computeBoundingVolumeForFeatureRenderer(this, frameState);
    return true;
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * <br /><br />
   * If this object was destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   *
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   *
   * @see BillboardCollection#destroy
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
   * billboards = billboards && billboards.destroy();
   *
   * @see BillboardCollection#isDestroyed
   */
  destroy() {
    if (defined(this._removeCallbackFunc)) {
      this._removeCallbackFunc();
      this._removeCallbackFunc = undefined;
    }

    this._textureAtlas =
      this._destroyTextureAtlas &&
      this._textureAtlas &&
      this._textureAtlas.destroy();
    this._sp = this._sp && this._sp.destroy();
    this._spTranslucent = this._spTranslucent && this._spTranslucent.destroy();
    this._vaf = this._vaf && this._vaf.destroy();
    destroyBillboards(this._billboards);
    if (
      defined(this._featureRenderer) &&
      defined(this._featureRenderer.destroy)
    ) {
      this._featureRenderer.destroy(this);
    }

    return destroyObject(this);
  }
}

// File-scoped helper functions

function destroyBillboards(billboards) {
  const length = billboards.length;
  for (let i = 0; i < length; ++i) {
    if (billboards[i]) {
      billboards[i]._destroy();
    }
  }
}

function removeBillboards(billboardCollection) {
  if (billboardCollection._billboardsRemoved) {
    billboardCollection._billboardsRemoved = false;

    const newBillboards = [];
    const billboards = billboardCollection._billboards;
    const length = billboards.length;
    for (let i = 0, j = 0; i < length; ++i) {
      const billboard = billboards[i];
      if (defined(billboard)) {
        billboard._index = j++;
        newBillboards.push(billboard);
      }
    }

    billboardCollection._billboards = newBillboards;
  }
}

function getIndexBuffer(context) {
  let indexBuffer = context.cache.billboardCollection_indexBufferInstanced;
  if (defined(indexBuffer)) {
    return indexBuffer;
  }

  indexBuffer = Buffer.createIndexBuffer({
    context: context,
    typedArray: new Uint16Array([0, 1, 2, 0, 2, 3]),
    usage: BufferUsage.STATIC_DRAW,
    indexDatatype: IndexDatatype.UNSIGNED_SHORT,
  });

  indexBuffer.vertexArrayDestroyable = false;
  context.cache.billboardCollection_indexBufferInstanced = indexBuffer;
  return indexBuffer;
}

function getVertexBufferInstanced(context) {
  let vertexBuffer = context.cache.billboardCollection_vertexBufferInstanced;
  if (defined(vertexBuffer)) {
    return vertexBuffer;
  }

  vertexBuffer = Buffer.createVertexBuffer({
    context: context,
    typedArray: new Float32Array([0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]),
    usage: BufferUsage.STATIC_DRAW,
  });

  vertexBuffer.vertexArrayDestroyable = false;
  context.cache.billboardCollection_vertexBufferInstanced = vertexBuffer;
  return vertexBuffer;
}

function createVAF(context, numberOfBillboards, buffersUsage, batchTable, sdf) {
  const attributes = [
    {
      index: attributeLocations.positionHighAndScale,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: buffersUsage[POSITION_INDEX],
    },
    {
      index: attributeLocations.positionLowAndRotation,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: buffersUsage[POSITION_INDEX],
    },
    {
      index: attributeLocations.compressedAttribute0,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: buffersUsage[PIXEL_OFFSET_INDEX],
    },
    {
      index: attributeLocations.compressedAttribute1,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: buffersUsage[TRANSLUCENCY_BY_DISTANCE_INDEX],
    },
    {
      index: attributeLocations.compressedAttribute2,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: buffersUsage[COLOR_INDEX],
    },
    {
      index: attributeLocations.eyeOffset,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: buffersUsage[EYE_OFFSET_INDEX],
    },
    {
      index: attributeLocations.scaleByDistance,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: buffersUsage[SCALE_BY_DISTANCE_INDEX],
    },
    {
      index: attributeLocations.pixelOffsetScaleByDistance,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: buffersUsage[PIXEL_OFFSET_SCALE_BY_DISTANCE_INDEX],
    },
    {
      index: attributeLocations.compressedAttribute3,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: buffersUsage[DISTANCE_DISPLAY_CONDITION_INDEX],
    },
    {
      index: attributeLocations.textureCoordinateBoundsOrLabelTranslate,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: buffersUsage[TEXTURE_COORDINATE_BOUNDS],
    },
    {
      index: attributeLocations.splitDirection,
      componentsPerAttribute: 1,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: buffersUsage[SPLIT_DIRECTION_INDEX],
    },
    // Instancing requires one non-instanced attribute.
    {
      index: attributeLocations.direction,
      componentsPerAttribute: 2,
      componentDatatype: ComponentDatatype.FLOAT,
      vertexBuffer: getVertexBufferInstanced(context),
    },
  ];

  if (defined(batchTable)) {
    attributes.push({
      index: attributeLocations.a_batchId,
      componentsPerAttribute: 1,
      componentDatatype: ComponentDatatype.FLOAT,
      bufferUsage: BufferUsage.STATIC_DRAW,
    });
  }

  if (sdf) {
    attributes.push({
      index: attributeLocations.sdf,
      componentsPerAttribute: 2,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: buffersUsage[SDF_INDEX],
    });
  }

  return new VertexArrayFacade(context, attributes, numberOfBillboards, true);
}

///////////////////////////////////////////////////////////////////////////

const writePositionScratch = new EncodedCartesian3();

function writePositionScaleAndRotation(
  billboardCollection,
  frameState,
  vafWriters,
  billboard,
) {
  const positionHighWriter =
    vafWriters[attributeLocations.positionHighAndScale];
  const positionLowWriter =
    vafWriters[attributeLocations.positionLowAndRotation];
  const position = billboard._getActualPosition();

  if (billboardCollection._mode === SceneMode.SCENE3D) {
    BoundingSphere.expand(
      billboardCollection._baseVolume,
      position,
      billboardCollection._baseVolume,
    );
    billboardCollection._boundingVolumeDirty = true;
  }

  EncodedCartesian3.fromCartesian(position, writePositionScratch);
  const scale = billboard.scale;
  const rotation = billboard.rotation;

  if (rotation !== 0.0) {
    billboardCollection._shaderRotation = true;
  }

  billboardCollection._maxScale = Math.max(
    billboardCollection._maxScale,
    scale,
  );

  const high = writePositionScratch.high;
  const low = writePositionScratch.low;

  positionHighWriter(billboard._index, high.x, high.y, high.z, scale);
  positionLowWriter(billboard._index, low.x, low.y, low.z, rotation);
}

const scratchCartesian2 = new Cartesian2();

const UPPER_BOUND = 32768.0; // 2^15

const LEFT_SHIFT16 = 65536.0; // 2^16
const LEFT_SHIFT12 = 4096.0; // 2^12
const LEFT_SHIFT8 = 256.0; // 2^8
const LEFT_SHIFT7 = 128.0;
const LEFT_SHIFT5 = 32.0;
const LEFT_SHIFT3 = 8.0;
const LEFT_SHIFT2 = 4.0;

const RIGHT_SHIFT8 = 1.0 / 256.0;

const scratchBoundingRectangle = new BoundingRectangle();

function writeCompressedAttrib0(
  billboardCollection,
  frameState,
  vafWriters,
  billboard,
) {
  const writer = vafWriters[attributeLocations.compressedAttribute0];
  const pixelOffset = billboard.pixelOffset;
  const pixelOffsetX = pixelOffset.x;
  const pixelOffsetY = pixelOffset.y;

  const translate = billboard._translate;
  const translateX = translate.x;
  const translateY = translate.y;

  billboardCollection._maxPixelOffset = Math.max(
    billboardCollection._maxPixelOffset,
    Math.abs(pixelOffsetX + translateX),
    Math.abs(-pixelOffsetY + translateY),
  );

  const horizontalOrigin = billboard.horizontalOrigin;
  let verticalOrigin = billboard._verticalOrigin;
  let show = billboard.show && billboard.clusterShow;

  if (billboard.color.alpha === 0.0) {
    show = false;
  }

  if (verticalOrigin === VerticalOrigin.BASELINE) {
    verticalOrigin = VerticalOrigin.BOTTOM;
  }

  billboardCollection._allHorizontalCenter =
    billboardCollection._allHorizontalCenter &&
    horizontalOrigin === HorizontalOrigin.CENTER;
  billboardCollection._allVerticalCenter =
    billboardCollection._allVerticalCenter &&
    verticalOrigin === VerticalOrigin.CENTER;

  let bottomLeftX = 0;
  let bottomLeftY = 0;
  if (billboard.ready) {
    const imageRectangle = billboard.computeTextureCoordinates(
      scratchBoundingRectangle,
    );
    bottomLeftX = imageRectangle.x;
    bottomLeftY = imageRectangle.y;
  }

  let compressed0 =
    Math.floor(
      CesiumMath.clamp(pixelOffsetX, -UPPER_BOUND, UPPER_BOUND) + UPPER_BOUND,
    ) * LEFT_SHIFT7;
  compressed0 += (horizontalOrigin + 1.0) * LEFT_SHIFT5;
  compressed0 += (verticalOrigin + 1.0) * LEFT_SHIFT3;
  compressed0 += (show ? 1.0 : 0.0) * LEFT_SHIFT2;

  let compressed1 =
    Math.floor(
      CesiumMath.clamp(pixelOffsetY, -UPPER_BOUND, UPPER_BOUND) + UPPER_BOUND,
    ) * LEFT_SHIFT8;

  let compressed2 =
    Math.floor(
      CesiumMath.clamp(translateX * LEFT_SHIFT2, -UPPER_BOUND, UPPER_BOUND) +
        UPPER_BOUND,
    ) * LEFT_SHIFT8;

  const tempTanslateY =
    (CesiumMath.clamp(translateY * LEFT_SHIFT2, -UPPER_BOUND, UPPER_BOUND) +
      UPPER_BOUND) *
    RIGHT_SHIFT8;
  const upperTranslateY = Math.floor(tempTanslateY);
  const lowerTranslateY = Math.floor(
    (tempTanslateY - upperTranslateY) * LEFT_SHIFT8,
  );

  compressed1 += upperTranslateY;
  compressed2 += lowerTranslateY;

  scratchCartesian2.x = bottomLeftX;
  scratchCartesian2.y = bottomLeftY;
  const compressedTexCoordsLL =
    AttributeCompression.compressTextureCoordinates(scratchCartesian2);

  writer(
    billboard._index,
    compressed0,
    compressed1,
    compressed2,
    compressedTexCoordsLL,
  );
}

function writeCompressedAttrib1(
  billboardCollection,
  frameState,
  vafWriters,
  billboard,
) {
  const writer = vafWriters[attributeLocations.compressedAttribute1];
  const alignedAxis = billboard.alignedAxis;
  if (!Cartesian3.equals(alignedAxis, Cartesian3.ZERO)) {
    billboardCollection._shaderAlignedAxis = true;
  }

  let near = 0.0;
  let nearValue = 1.0;
  let far = 1.0;
  let farValue = 1.0;

  const translucency = billboard.translucencyByDistance;
  if (defined(translucency)) {
    near = translucency.near;
    nearValue = translucency.nearValue;
    far = translucency.far;
    farValue = translucency.farValue;
    if (nearValue !== 1.0 || farValue !== 1.0) {
      billboardCollection._shaderTranslucencyByDistance = true;
    }
  }

  const imageWidth = Math.round(billboard.width ?? 0);
  billboardCollection._maxSize = Math.max(
    billboardCollection._maxSize,
    imageWidth,
  );

  let compressed0 = CesiumMath.clamp(imageWidth, 0.0, LEFT_SHIFT16);
  let compressed1 = 0.0;

  if (
    Math.abs(Cartesian3.magnitudeSquared(alignedAxis) - 1.0) <
    CesiumMath.EPSILON6
  ) {
    compressed1 = AttributeCompression.octEncodeFloat(alignedAxis);
  }

  nearValue = CesiumMath.clamp(nearValue, 0.0, 1.0);
  nearValue = nearValue === 1.0 ? 255.0 : (nearValue * 255.0) | 0;
  compressed0 = compressed0 * LEFT_SHIFT8 + nearValue;

  farValue = CesiumMath.clamp(farValue, 0.0, 1.0);
  farValue = farValue === 1.0 ? 255.0 : (farValue * 255.0) | 0;
  compressed1 = compressed1 * LEFT_SHIFT8 + farValue;

  writer(billboard._index, compressed0, compressed1, near, far);
}

function writeCompressedAttrib2(
  billboardCollection,
  frameState,
  vafWriters,
  billboard,
) {
  const writer = vafWriters[attributeLocations.compressedAttribute2];
  const color = billboard.color;
  const pickColor = !defined(billboardCollection._batchTable)
    ? billboard.getPickId(frameState.context).color
    : Color.WHITE;
  const sizeInMeters = billboard.sizeInMeters ? 1.0 : 0.0;
  const validAlignedAxis =
    Math.abs(Cartesian3.magnitudeSquared(billboard.alignedAxis) - 1.0) <
    CesiumMath.EPSILON6
      ? 1.0
      : 0.0;

  billboardCollection._allSizedInMeters =
    billboardCollection._allSizedInMeters && sizeInMeters === 1.0;

  const imageHeight = billboard.height ?? 0;
  billboardCollection._maxSize = Math.max(
    billboardCollection._maxSize,
    imageHeight,
  );
  let labelHorizontalOrigin = billboard._labelHorizontalOrigin ?? -2;
  labelHorizontalOrigin += 2;

  const compressed0 = AttributeCompression.encodeRGB8(color);
  const compressed1 = AttributeCompression.encodeRGB8(pickColor);
  const compressed2 =
    Color.floatToByte(color.alpha) * LEFT_SHIFT16 +
    Color.floatToByte(pickColor.alpha) * LEFT_SHIFT8 +
    (sizeInMeters * 2.0 + validAlignedAxis);
  const compressed3 = imageHeight * LEFT_SHIFT2 + labelHorizontalOrigin;

  writer(billboard._index, compressed0, compressed1, compressed2, compressed3);
}

function writeEyeOffset(
  billboardCollection,
  frameState,
  vafWriters,
  billboard,
) {
  const writer = vafWriters[attributeLocations.eyeOffset];
  const eyeOffset = billboard.eyeOffset;

  let eyeOffsetZ = eyeOffset.z;
  if (billboard._heightReference !== HeightReference.NONE) {
    eyeOffsetZ *= 1.005;
  }
  billboardCollection._maxEyeOffset = Math.max(
    billboardCollection._maxEyeOffset,
    Math.abs(eyeOffset.x),
    Math.abs(eyeOffset.y),
    Math.abs(eyeOffsetZ),
  );

  scratchCartesian2.x = 0;
  scratchCartesian2.y = 0;

  if (billboard.ready) {
    const imageRectangle = billboard.computeTextureCoordinates(
      scratchBoundingRectangle,
    );
    scratchCartesian2.x = imageRectangle.width;
    scratchCartesian2.y = imageRectangle.height;
  }

  const compressedTexCoordsRange =
    AttributeCompression.compressTextureCoordinates(scratchCartesian2);

  writer(
    billboard._index,
    eyeOffset.x,
    eyeOffset.y,
    eyeOffsetZ,
    compressedTexCoordsRange,
  );
}

function writeScaleByDistance(
  billboardCollection,
  frameState,
  vafWriters,
  billboard,
) {
  const writer = vafWriters[attributeLocations.scaleByDistance];
  let near = 0.0;
  let nearValue = 1.0;
  let far = 1.0;
  let farValue = 1.0;

  const scale = billboard.scaleByDistance;
  if (defined(scale)) {
    near = scale.near;
    nearValue = scale.nearValue;
    far = scale.far;
    farValue = scale.farValue;
    if (nearValue !== 1.0 || farValue !== 1.0) {
      billboardCollection._shaderScaleByDistance = true;
    }
  }

  writer(billboard._index, near, nearValue, far, farValue);
}

function writePixelOffsetScaleByDistance(
  billboardCollection,
  frameState,
  vafWriters,
  billboard,
) {
  const writer = vafWriters[attributeLocations.pixelOffsetScaleByDistance];
  let near = 0.0;
  let nearValue = 1.0;
  let far = 1.0;
  let farValue = 1.0;

  const pixelOffsetScale = billboard.pixelOffsetScaleByDistance;
  if (defined(pixelOffsetScale)) {
    near = pixelOffsetScale.near;
    nearValue = pixelOffsetScale.nearValue;
    far = pixelOffsetScale.far;
    farValue = pixelOffsetScale.farValue;
    if (nearValue !== 1.0 || farValue !== 1.0) {
      billboardCollection._shaderPixelOffsetScaleByDistance = true;
    }
  }

  writer(billboard._index, near, nearValue, far, farValue);
}

function writeCompressedAttribute3(
  billboardCollection,
  frameState,
  vafWriters,
  billboard,
) {
  const writer = vafWriters[attributeLocations.compressedAttribute3];
  let near = 0.0;
  let far = Number.MAX_VALUE;

  const distanceDisplayCondition = billboard.distanceDisplayCondition;
  if (defined(distanceDisplayCondition)) {
    near = distanceDisplayCondition.near;
    far = distanceDisplayCondition.far;
    near *= near;
    far *= far;
    billboardCollection._shaderDistanceDisplayCondition = true;
  }

  let disableDepthTestDistance = billboard.disableDepthTestDistance;
  const clampToGround =
    isHeightReferenceClamp(billboard.heightReference) &&
    frameState.context.depthTexture;

  disableDepthTestDistance *= disableDepthTestDistance;
  if (clampToGround || disableDepthTestDistance > 0.0) {
    billboardCollection._shaderDisableDepthDistance = true;
    if (disableDepthTestDistance === Number.POSITIVE_INFINITY) {
      disableDepthTestDistance = -1.0;
    }
  }

  let imageHeight;
  let imageWidth;

  if (!defined(billboard._labelDimensions)) {
    imageWidth = billboard.width ?? 0;
    imageHeight = billboard.height ?? 0;
  } else {
    imageWidth = billboard._labelDimensions.x;
    imageHeight = billboard._labelDimensions.y;
  }

  const w = Math.floor(CesiumMath.clamp(imageWidth, 0.0, LEFT_SHIFT12));
  const h = Math.floor(CesiumMath.clamp(imageHeight, 0.0, LEFT_SHIFT12));
  const dimensions = w * LEFT_SHIFT12 + h;

  writer(billboard._index, near, far, disableDepthTestDistance, dimensions);
}

function writeTextureCoordinateBoundsOrLabelTranslate(
  billboardCollection,
  frameState,
  vafWriters,
  billboard,
) {
  if (isHeightReferenceClamp(billboard.heightReference)) {
    const scene = billboardCollection._scene;
    const context = frameState.context;
    const globeTranslucent = frameState.globeTranslucencyState.translucent;
    const depthTestAgainstTerrain =
      defined(scene.globe) && scene.globe.depthTestAgainstTerrain;

    billboardCollection._shaderClampToGround =
      context.depthTexture && !globeTranslucent && depthTestAgainstTerrain;
  }
  const writer =
    vafWriters[attributeLocations.textureCoordinateBoundsOrLabelTranslate];

  let translateX = 0;
  let translateY = 0;
  if (defined(billboard._labelTranslate)) {
    translateX = billboard._labelTranslate.x;
    translateY = billboard._labelTranslate.y;
  }

  writer(billboard._index, translateX, translateY, 0.0, 0.0);
}

function writeBatchId(billboardCollection, frameState, vafWriters, billboard) {
  if (!defined(billboardCollection._batchTable)) {
    return;
  }
  const writer = vafWriters[attributeLocations.a_batchId];
  writer(billboard._index, billboard._batchIndex);
}

function writeSDF(billboardCollection, frameState, vafWriters, billboard) {
  if (!billboardCollection._sdf) {
    return;
  }
  const writer = vafWriters[attributeLocations.sdf];
  const outlineColor = billboard.outlineColor;
  const outlineWidth = billboard.outlineWidth;
  const compressed0 = AttributeCompression.encodeRGB8(outlineColor);
  const outlineDistance = outlineWidth / SDFSettings.RADIUS;
  const compressed1 =
    Color.floatToByte(outlineColor.alpha) * LEFT_SHIFT16 +
    Color.floatToByte(outlineDistance) * LEFT_SHIFT8;
  writer(billboard._index, compressed0, compressed1);
}

function writeSplitDirection(
  billboardCollection,
  frameState,
  vafWriters,
  billboard,
) {
  const writer = vafWriters[attributeLocations.splitDirection];
  let direction = 0.0;
  const split = billboard.splitDirection;
  if (defined(split)) {
    direction = split;
  }
  writer(billboard._index, direction);
}

function writeBillboard(
  billboardCollection,
  frameState,
  vafWriters,
  billboard,
) {
  writePositionScaleAndRotation(
    billboardCollection,
    frameState,
    vafWriters,
    billboard,
  );
  writeCompressedAttrib0(
    billboardCollection,
    frameState,
    vafWriters,
    billboard,
  );
  writeCompressedAttrib1(
    billboardCollection,
    frameState,
    vafWriters,
    billboard,
  );
  writeCompressedAttrib2(
    billboardCollection,
    frameState,
    vafWriters,
    billboard,
  );
  writeEyeOffset(billboardCollection, frameState, vafWriters, billboard);
  writeScaleByDistance(billboardCollection, frameState, vafWriters, billboard);
  writePixelOffsetScaleByDistance(
    billboardCollection,
    frameState,
    vafWriters,
    billboard,
  );
  writeCompressedAttribute3(
    billboardCollection,
    frameState,
    vafWriters,
    billboard,
  );
  writeTextureCoordinateBoundsOrLabelTranslate(
    billboardCollection,
    frameState,
    vafWriters,
    billboard,
  );
  writeBatchId(billboardCollection, frameState, vafWriters, billboard);
  writeSDF(billboardCollection, frameState, vafWriters, billboard);
  writeSplitDirection(billboardCollection, frameState, vafWriters, billboard);
}

function recomputeActualPositions(
  billboardCollection,
  billboards,
  length,
  frameState,
  modelMatrix,
  recomputeBoundingVolume,
) {
  let boundingVolume;
  if (frameState.mode === SceneMode.SCENE3D) {
    boundingVolume = billboardCollection._baseVolume;
    billboardCollection._boundingVolumeDirty = true;
  } else {
    boundingVolume = billboardCollection._baseVolume2D;
  }

  const positions = [];
  for (let i = 0; i < length; ++i) {
    const billboard = billboards[i];
    const position = billboard.position;
    const actualPosition = Billboard._computeActualPosition(
      billboard,
      position,
      frameState,
      modelMatrix,
    );
    if (defined(actualPosition)) {
      billboard._setActualPosition(actualPosition);
      if (recomputeBoundingVolume) {
        positions.push(actualPosition);
      } else {
        BoundingSphere.expand(boundingVolume, actualPosition, boundingVolume);
      }
    }
  }

  if (recomputeBoundingVolume) {
    BoundingSphere.fromPoints(positions, boundingVolume);
  }
}

function updateMode(billboardCollection, frameState) {
  const mode = frameState.mode;
  const billboards = billboardCollection._billboards;
  const billboardsToUpdate = billboardCollection._billboardsToUpdate;
  const modelMatrix = billboardCollection._modelMatrix;

  if (
    billboardCollection._createVertexArray ||
    billboardCollection._mode !== mode ||
    (mode !== SceneMode.SCENE3D &&
      !Matrix4.equals(modelMatrix, billboardCollection.modelMatrix))
  ) {
    billboardCollection._mode = mode;
    Matrix4.clone(billboardCollection.modelMatrix, modelMatrix);
    billboardCollection._createVertexArray = true;

    if (
      mode === SceneMode.SCENE3D ||
      mode === SceneMode.SCENE2D ||
      mode === SceneMode.COLUMBUS_VIEW
    ) {
      recomputeActualPositions(
        billboardCollection,
        billboards,
        billboards.length,
        frameState,
        modelMatrix,
        true,
      );
    }
  } else if (mode === SceneMode.MORPHING) {
    recomputeActualPositions(
      billboardCollection,
      billboards,
      billboards.length,
      frameState,
      modelMatrix,
      true,
    );
  } else if (mode === SceneMode.SCENE2D || mode === SceneMode.COLUMBUS_VIEW) {
    recomputeActualPositions(
      billboardCollection,
      billboardsToUpdate,
      billboardCollection._billboardsToUpdateIndex,
      frameState,
      modelMatrix,
      false,
    );
  }
}

/**
 * Shared scene-logic prologue for `BillboardCollection.update()` that must run
 * for BOTH backends before the renderer branch: process pending removals,
 * recompute actual positions + `_baseVolume`/`_baseVolume2D` (`updateMode`),
 * surface per-billboard load errors, refresh dirty textures, and schedule the
 * texture-atlas GPU upload.
 *
 * Extracted so the WebGPU LabelCollection path can run it directly for its
 * glyph + background billboard collections via {@link BillboardCollection#prepareForFeatureRenderer}
 * — that path delegates glyph rendering to the dedicated SDF renderer and
 * returns before calling `glyphCollection.update()`, so without running this
 * the glyph atlas was never uploaded (labels sampled the 1×1 placeholder and
 * discarded every fragment).
 *
 * @returns {boolean} `false` when the collection is hidden (`show === false`);
 *   `true` otherwise.
 * @private
 */
function runSharedSceneLogic(collection, frameState) {
  removeBillboards(collection);

  if (!collection.show) {
    return false;
  }

  updateMode(collection, frameState);

  // Handle billboard load errors and dirty state (shared for both backends)
  const billboards = collection._billboards;
  const length = billboards.length;
  let allBillboardsReady = true;
  for (let i = 0; i < length; ++i) {
    const billboard = billboards[i];
    if (defined(billboard.loadError)) {
      console.error(
        `Error loading image for billboard: ${billboard.loadError}`,
      );
      billboard.image = undefined;
    }
    if (billboard.textureDirty) {
      collection._updateBillboard(billboard, IMAGE_INDEX_INDEX);
    }
    if (billboard.show) {
      allBillboardsReady = allBillboardsReady && billboard.ready;
    }
  }
  collection._allBillboardsReady = allBillboardsReady;

  // Schedule texture atlas update (needed by both backends for image loading)
  const textureAtlas = collection._textureAtlas;
  frameState.afterRender.push(() => {
    if (collection.isDestroyed()) {
      return;
    }
    return textureAtlas.update(frameState.context);
  });

  return true;
}

/**
 * Compute `collection._boundingVolume` for the WebGPU feature-renderer path.
 *
 * The WebGL render path computes the bounding volume AFTER its vertex build,
 * and the per-billboard vertex writers ALSO accumulate the `_max*`/`_all*`
 * aggregates (`_maxSize`, `_maxScale`, `_maxPixelOffset`, `_maxEyeOffset`,
 * `_allSizedInMeters`, `_allHorizontalCenter`, `_allVerticalCenter`) that
 * `updateBoundingVolume` reads to expand the sphere by the billboards'
 * screen-space extent. The WebGPU feature renderer replaces that vertex path,
 * so those aggregates were never produced — leaving a radius-0 sphere that the
 * frustum/horizon cull rejected, so billboards/labels never rendered. This
 * reproduces the same aggregates (one extra billboard pass on WebGPU only; the
 * WebGL path is untouched) and runs the identical transform + clone +
 * `updateBoundingVolume` the WebGL block uses. `_baseVolume`/`_baseVolume2D`
 * are produced by `updateMode` (shared, before the feature-renderer branch).
 * @private
 */
function computeBoundingVolumeForFeatureRenderer(collection, frameState) {
  // Reset to ctor defaults, then re-derive from the live billboards so removal
  // and per-frame property changes are reflected (the WebGL aggregates are
  // monotonic, but a fresh recompute is strictly more correct for the cull).
  collection._maxSize = 0.0;
  collection._maxScale = 1.0;
  collection._maxPixelOffset = 0.0;
  collection._maxEyeOffset = 0.0;
  collection._allHorizontalCenter = true;
  collection._allVerticalCenter = true;
  collection._allSizedInMeters = true;

  const billboards = collection._billboards;
  const length = billboards.length;
  for (let i = 0; i < length; ++i) {
    const billboard = billboards[i];
    if (!defined(billboard)) {
      continue;
    }
    // Mirror writeCompressedAttrib0/1/2 + writeEyeOffset aggregate updates.
    collection._maxScale = Math.max(collection._maxScale, billboard.scale);

    const pixelOffset = billboard.pixelOffset;
    const translate = billboard._translate;
    collection._maxPixelOffset = Math.max(
      collection._maxPixelOffset,
      Math.abs(pixelOffset.x + translate.x),
      Math.abs(-pixelOffset.y + translate.y),
    );

    let verticalOrigin = billboard._verticalOrigin;
    if (verticalOrigin === VerticalOrigin.BASELINE) {
      verticalOrigin = VerticalOrigin.BOTTOM;
    }
    collection._allHorizontalCenter =
      collection._allHorizontalCenter &&
      billboard.horizontalOrigin === HorizontalOrigin.CENTER;
    collection._allVerticalCenter =
      collection._allVerticalCenter && verticalOrigin === VerticalOrigin.CENTER;

    collection._maxSize = Math.max(
      collection._maxSize,
      Math.round(billboard.width ?? 0),
      billboard.height ?? 0,
    );
    collection._allSizedInMeters =
      collection._allSizedInMeters && billboard.sizeInMeters === true;

    const eyeOffset = billboard.eyeOffset;
    let eyeOffsetZ = eyeOffset.z;
    if (billboard._heightReference !== HeightReference.NONE) {
      eyeOffsetZ *= 1.005;
    }
    collection._maxEyeOffset = Math.max(
      collection._maxEyeOffset,
      Math.abs(eyeOffset.x),
      Math.abs(eyeOffset.y),
      Math.abs(eyeOffsetZ),
    );
  }

  // Same transform + clone + expand as the WebGL block (lines below in the
  // WebGL path). `updateMode` populated `_baseVolume`/`_baseVolume2D`.
  if (collection._boundingVolumeDirty) {
    collection._boundingVolumeDirty = false;
    BoundingSphere.transform(
      collection._baseVolume,
      collection.modelMatrix,
      collection._baseVolumeWC,
    );
  }
  const boundingVolume =
    frameState.mode === SceneMode.SCENE3D
      ? BoundingSphere.clone(
          collection._baseVolumeWC,
          collection._boundingVolume,
        )
      : BoundingSphere.clone(
          collection._baseVolume2D,
          collection._boundingVolume,
        );
  updateBoundingVolume(collection, frameState, boundingVolume);
}

function updateBoundingVolume(collection, frameState, boundingVolume) {
  let pixelScale = 1.0;
  if (!collection._allSizedInMeters || collection._maxPixelOffset !== 0.0) {
    pixelScale = frameState.camera.getPixelSize(
      boundingVolume,
      frameState.context.drawingBufferWidth,
      frameState.context.drawingBufferHeight,
    );
  }

  let size = pixelScale * collection._maxScale * collection._maxSize * 2.0;
  if (collection._allHorizontalCenter && collection._allVerticalCenter) {
    size *= 0.5;
  }

  const offset =
    pixelScale * collection._maxPixelOffset + collection._maxEyeOffset;
  boundingVolume.radius += size + offset;
}

function createDebugCommand(billboardCollection, context) {
  const fs =
    "uniform sampler2D billboard_texture; \n" +
    "in vec2 v_textureCoordinates; \n" +
    "void main() \n" +
    "{ \n" +
    "    out_FragColor = texture(billboard_texture, v_textureCoordinates); \n" +
    "} \n";

  const drawCommand = context.createViewportQuadCommand(fs, {
    uniformMap: {
      billboard_texture: function () {
        return billboardCollection.textureAtlas.texture;
      },
    },
  });
  drawCommand.pass = Pass.OVERLAY;
  return drawCommand;
}

const scratchWriterArray = [];

export default BillboardCollection;
