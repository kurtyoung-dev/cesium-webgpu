import BlendingState from "./BlendingState.js";
import Buffer from "../Renderer/Buffer.js";
import BufferUsage from "../Renderer/BufferUsage.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Check from "../Core/Check.js";
import Color from "../Core/Color.js";
import ComputeCommand from "../Renderer/ComputeCommand.js";
import CloudRenderMode from "./CloudRenderMode.js";
import CloudType from "./CloudType.js";
import CloudVolumetrics from "./CloudVolumetrics.js";
import CloudCollectionFS from "../Shaders/CloudCollectionFS.js";
import CloudCollectionVS from "../Shaders/CloudCollectionVS.js";
import CloudNoiseFS from "../Shaders/CloudNoiseFS.js";
import CloudNoiseVS from "../Shaders/CloudNoiseVS.js";
import ComponentDatatype from "../Core/ComponentDatatype.js";
import CumulusCloud from "./CumulusCloud.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import DrawCommand from "../Renderer/DrawCommand.js";
import EncodedCartesian3 from "../Core/EncodedCartesian3.js";
import IndexDatatype from "../Core/IndexDatatype.js";
import Pass from "../Renderer/Pass.js";
import PixelDatatype from "../Renderer/PixelDatatype.js";
import PixelFormat from "../Core/PixelFormat.js";
import RenderState from "../Renderer/RenderState.js";
import Sampler from "../Renderer/Sampler.js";
import ShaderSource from "../Renderer/ShaderSource.js";
import ShaderProgram from "../Renderer/ShaderProgram.js";
import Texture from "../Renderer/Texture.js";
import TextureMagnificationFilter from "../Renderer/TextureMagnificationFilter.js";
import TextureMinificationFilter from "../Renderer/TextureMinificationFilter.js";
import TextureWrap from "../Renderer/TextureWrap.js";
import VertexArray from "../Renderer/VertexArray.js";
import VertexArrayFacade from "../Renderer/VertexArrayFacade.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import WebGLConstants from "../Core/WebGLConstants.js";

let attributeLocations;
const scratchTextureDimensions = new Cartesian3();

const attributeLocationsBatched = {
  positionHighAndScaleX: 0,
  positionLowAndScaleY: 1,
  packedAttribute0: 2,
  packedAttribute1: 3,
  color: 4,
};

const attributeLocationsInstanced = {
  direction: 0,
  positionHighAndScaleX: 1,
  positionLowAndScaleY: 2,
  packedAttribute0: 3,
  packedAttribute1: 4,
  color: 5,
};

const SHOW_INDEX = CumulusCloud.SHOW_INDEX;
const POSITION_INDEX = CumulusCloud.POSITION_INDEX;
const SCALE_INDEX = CumulusCloud.SCALE_INDEX;
const MAXIMUM_SIZE_INDEX = CumulusCloud.MAXIMUM_SIZE_INDEX;
const SLICE_INDEX = CumulusCloud.SLICE_INDEX;
const BRIGHTNESS_INDEX = CumulusCloud.BRIGHTNESS_INDEX;
const NUMBER_OF_PROPERTIES = CumulusCloud.NUMBER_OF_PROPERTIES;
const COLOR_INDEX = CumulusCloud.COLOR_INDEX;

/**
 * A renderable collection of clouds in the 3D scene.
 * <br /><br />
 * <div align='center'>
 * <img src='Images/CumulusCloud.png' width='400' height='300' /><br />
 * Example cumulus clouds
 * </div>
 * <br /><br />
 * Clouds are added and removed from the collection using {@link CloudCollection#add}
 * and {@link CloudCollection#remove}.
 * @alias CloudCollection
 *
 * @param {object} [options] Object with the following properties:
 * @param {boolean} [options.show=true] Whether to display the clouds.
 * @param {number} [options.noiseDetail=16.0] Desired amount of detail in the noise texture.
 * @param {number} [options.noiseOffset=Cartesian3.ZERO] Desired translation of data in noise texture.
 * @param {boolean} [options.debugBillboards=false] For debugging only. Determines if the billboards are rendered with an opaque color.
 * @param {boolean} [options.debugEllipsoids=false] For debugging only. Determines if the clouds will be rendered as opaque ellipsoids.
 * @param {CloudRenderMode} [options.renderMode=CloudRenderMode.BILLBOARD] The exclusive render mode. <code>VOLUMETRIC</code> drives the WebGPU volumetric deck and suppresses this collection's billboards (WebGPU only; documented no-op on WebGL).
 * @param {boolean} [options.enableVolumetric=false] Convenience alias — when <code>true</code> sets <code>renderMode</code> to <code>VOLUMETRIC</code> and marks <code>volumetric.enabled</code>. WebGPU only.
 * @param {CloudType} [options.cloudType=CloudType.CUMULUS] Collection-level WMO genus for the volumetric deck. WebGPU volumetric only.
 * @param {object} [options.volumetric] Overrides for the collection's {@link CloudVolumetrics} config. WebGPU volumetric only.
 * @see CloudCollection#add
 * @see CloudCollection#remove
 * @see CumulusCloud
 *
 * @demo {@link https://sandcastle.cesium.com/index.html?id=clouds|Cesium Sandcastle Clouds Demo}
 * @demo {@link https://sandcastle.cesium.com/index.html?id=cloud-parameters|Cesium Sandcastle Cloud Parameters Demo}
 *
 * @example
 * // Create a cloud collection with two cumulus clouds
 * const clouds = scene.primitives.add(new Cesium.CloudCollection());
 * clouds.add({
 *   position : new Cesium.Cartesian3(1.0, 2.0, 3.0),
 *   maximumSize: new Cesium.Cartesian3(20.0, 12.0, 8.0)
 * });
 * clouds.add({
 *   position : new Cesium.Cartesian3(4.0, 5.0, 6.0),
 *   maximumSize: new Cesium.Cartesian3(15.0, 9.0, 9.0),
 *   slice: 0.5
 * });
 *
 */
class CloudCollection {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    this._clouds = [];
    this._cloudsToUpdate = [];
    this._cloudsToUpdateIndex = 0;
    this._cloudsRemoved = false;
    this._createVertexArray = false;

    this._propertiesChanged = new Uint32Array(NUMBER_OF_PROPERTIES);

    this._noiseTexture = undefined;
    this._textureSliceWidth = 128;
    this._noiseTextureRows = 4;

    /**
     * <p>
     * Controls the amount of detail captured in the precomputed noise texture
     * used to render the cumulus clouds. In order for the texture to be tileable,
     * this must be a power of two. For best results, set this to be a power of two
     * between <code>8.0</code> and <code>32.0</code> (inclusive).
     * </p>
     *
     * @type {number}
     *
     * @default 16.0
     */
    this.noiseDetail = options.noiseDetail ?? 16.0;

    /**
     * <p>
     * Applies a translation to noise texture coordinates to generate different data.
     * This can be modified if the default noise does not generate good-looking clouds.
     * </p>
     *
     * @type {Cartesian3}
     *
     * @default Cartesian3.ZERO
     */
    this.noiseOffset = Cartesian3.clone(options.noiseOffset ?? Cartesian3.ZERO);

    this._loading = false;
    this._ready = false;

    const that = this;
    this._uniforms = {
      u_noiseTexture: function () {
        return that._noiseTexture;
      },
      u_noiseTextureDimensions: getNoiseTextureDimensions(that),
      u_noiseDetail: function () {
        return that.noiseDetail;
      },
    };

    this._vaNoise = undefined;
    this._spNoise = undefined;

    this._spCreated = false;
    this._sp = undefined;
    this._rs = undefined;

    /**
     * Determines if billboards in this collection will be shown.
     *
     * @type {boolean}
     * @default true
     */
    this.show = options.show ?? true;

    this._colorCommands = [];

    /**
     * This property is for debugging only; it is not for production use nor is it optimized.
     * <p>
     * Renders the billboards with one opaque color for the sake of debugging.
     * </p>
     *
     * @type {boolean}
     *
     * @default false
     */
    this.debugBillboards = options.debugBillboards ?? false;
    this._compiledDebugBillboards = false;

    /**
     * This property is for debugging only; it is not for production use nor is it optimized.
     * <p>
     * Draws the clouds as opaque, monochrome ellipsoids for the sake of debugging.
     * If <code>debugBillboards</code> is also true, then the ellipsoids will draw on top of the billboards.
     * </p>
     *
     * @type {boolean}
     *
     * @default false
     */
    this.debugEllipsoids = options.debugEllipsoids ?? false;
    this._compiledDebugEllipsoids = false;

    // ── Cloud-unification epic (WebGPU volumetric via CloudCollection) ──
    // All three additions below are opt-in, default-off, and inert on the WebGL
    // renderer + when renderMode is BILLBOARD. Nothing reads them yet — the
    // publish/consume wiring lands in a later slice. See
    // migration_doc/CLOUD_UNIFICATION_DESIGN.md.

    // Exclusive render mode. BILLBOARD (default) keeps the classic behavior on
    // both backends; VOLUMETRIC drives the WebGPU volumetric deck and suppresses
    // this collection's billboards (WebGPU only; documented no-op on WebGL).
    this._renderMode =
      options.renderMode ??
      (options.enableVolumetric === true
        ? CloudRenderMode.VOLUMETRIC
        : CloudRenderMode.BILLBOARD);
    //>>includeStart('debug', pragmas.debug);
    if (!CloudRenderMode.validate(this._renderMode)) {
      throw new DeveloperError("invalid CloudCollection renderMode");
    }
    //>>includeEnd('debug');

    // Collection-level WMO genus selecting the volumetric altitude deck +
    // CloudTypeProfile (WebGPU volumetric only).
    this._cloudType = options.cloudType ?? CloudType.CUMULUS;
    //>>includeStart('debug', pragmas.debug);
    if (!CloudType.validate(this._cloudType)) {
      throw new DeveloperError("invalid CloudCollection cloudType");
    }
    //>>includeEnd('debug');

    // Lazily-created volumetric config carrier (see `volumetric` getter). Seeded
    // from options.volumetric on first access so a config bag passed at
    // construction is honored.
    this._volumetric = undefined;
    this._volumetricOptions = options.volumetric;
    if (options.enableVolumetric === true) {
      this._volumetricOptions = { ...this._volumetricOptions, enabled: true };
    }
  }

  /**
   * Returns the number of clouds in this collection.
   * @type {number}
   */
  get length() {
    removeClouds(this);
    return this._clouds.length;
  }

  /**
   * The exclusive render mode of this collection (see {@link CloudRenderMode}).
   * <p><code>BILLBOARD</code> (default) renders the classic billboards on both
   * backends. <code>VOLUMETRIC</code> drives the WebGPU volumetric ray-marched
   * deck from {@link CloudCollection#volumetric} and suppresses this
   * collection's billboards. <b>WebGPU only</b>; on the WebGL renderer a
   * <code>VOLUMETRIC</code> collection stores the mode but renders nothing
   * extra (documented graceful no-op).</p>
   * @type {CloudRenderMode}
   * @default CloudRenderMode.BILLBOARD
   */
  get renderMode() {
    return this._renderMode;
  }

  set renderMode(value) {
    //>>includeStart('debug', pragmas.debug);
    if (!CloudRenderMode.validate(value)) {
      throw new DeveloperError("invalid CloudCollection renderMode");
    }
    //>>includeEnd('debug');
    this._renderMode = value;
  }

  /**
   * The collection-level WMO genus (see {@link CloudType}) selecting the
   * volumetric altitude deck + density/lighting profile. <b>WebGPU volumetric
   * only</b>; no effect on the WebGL renderer or the billboard path.
   * @type {CloudType}
   * @default CloudType.CUMULUS
   */
  get cloudType() {
    return this._cloudType;
  }

  set cloudType(value) {
    //>>includeStart('debug', pragmas.debug);
    if (!CloudType.validate(value)) {
      throw new DeveloperError("invalid CloudCollection cloudType");
    }
    //>>includeEnd('debug');
    this._cloudType = value;
  }

  /**
   * The lazily-created {@link CloudVolumetrics} configuration for this
   * collection's WebGPU volumetric cloud deck. Mutating it has no effect unless
   * {@link CloudCollection#renderMode} is <code>VOLUMETRIC</code> and the WebGPU
   * renderer is active — on WebGL every field is an inert store (documented
   * graceful no-op).
   * @type {CloudVolumetrics}
   * @readonly
   */
  get volumetric() {
    if (!defined(this._volumetric)) {
      this._volumetric = new CloudVolumetrics(this._volumetricOptions);
    }
    return this._volumetric;
  }

  /**
   * Resolve this collection's {@link CloudVolumetrics} into the backend-neutral
   * config snapshot published to the context each frame via
   * {@link GraphicsContext#requestVolumetricClouds}. The env-effects phase feeds
   * it to the procedural-cloud renderer and to <code>publishCloudIblCoverage</code>.
   *
   * The volumetric renderer (and its IBL-coverage publish) gate on the historical
   * globe master flag <code>showProceduralClouds</code>; this maps the
   * collection's <code>volumetric.enabled</code> onto that field so the same
   * byte-locked code path the globe drove runs unchanged. Every other field is
   * carried through verbatim (identical names to <code>globe.cloud*</code>), so
   * the 136-float <code>CloudUniforms</code> packer stays byte-locked. A fresh
   * object is produced each frame — only on the opt-in volumetric-active path.
   *
   * The collection-level <code>cloudType</code> (WMO genus) is folded into the
   * snapshot as <code>config.cloudType</code> — the volumetric raymarcher reads
   * <code>config.cloudType ?? CloudType.CUMULUS</code>, so the default
   * <code>CUMULUS</code> resolves identically to the historical
   * <code>undefined</code> globe path (byte-locked). An explicit
   * <code>volumetric.cloudType</code> override still wins.
   *
   * @returns {object} A {@link CloudVolumetrics}-shaped request snapshot.
   * @private
   */
  _resolveVolumetricConfig() {
    return {
      ...this.volumetric,
      showProceduralClouds: true,
      cloudType: this.volumetric.cloudType ?? this._cloudType,
    };
  }

  /**
   * Creates and adds a cloud with the specified initial properties to the collection.
   * The added cloud is returned so it can be modified or removed from the collection later.
   *
   * @param {object}[options] A template describing the cloud's properties as shown in Example 1.
   * @returns {CumulusCloud} The cloud that was added to the collection.
   *
   * @performance Calling <code>add</code> is expected constant time.  However, the collection's vertex buffer
   * is rewritten - an <code>O(n)</code> operation that also incurs CPU to GPU overhead.  For
   * best performance, add as many clouds as possible before calling <code>update</code>.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   *
   * @example
   * // Example 1:  Add a cumulus cloud, specifying all the default values.
   * const c = clouds.add({
   *   show : true,
   *   position : Cesium.Cartesian3.ZERO,
   *   scale : new Cesium.Cartesian2(20.0, 12.0),
   *   maximumSize: new Cesium.Cartesian3(20.0, 12.0, 12.0),
   *   slice: -1.0,
   *   cloudType : CloudType.CUMULUS
   * });
   *
   * @example
   * // Example 2:  Specify only the cloud's cartographic position.
   * const c = clouds.add({
   *   position : Cesium.Cartesian3.fromDegrees(longitude, latitude, height)
   * });
   *
   * @see CloudCollection#remove
   * @see CloudCollection#removeAll
   */
  add(options) {
    options = options ?? Frozen.EMPTY_OBJECT;
    const cloudType = options.cloudType ?? CloudType.CUMULUS;
    //>>includeStart('debug', pragmas.debug);
    if (!CloudType.validate(cloudType)) {
      throw new DeveloperError("invalid cloud type");
    }
    //>>includeEnd('debug');

    // The billboard collection renders every genus as a cumulus-style puff —
    // per-genus billboard geometry is future work, and the WMO genus is consumed
    // by the volumetric raymarcher / weather-map path, not here. `validate`
    // above already rejected out-of-range types, so any validated genus creates
    // a puff (previously only CUMULUS did, silently returning undefined for the
    // rest — now that CloudType spans 11 genera that would be a footgun).
    const cloud = new CumulusCloud(options, this);
    cloud._index = this._clouds.length;
    this._clouds.push(cloud);
    this._createVertexArray = true;

    return cloud;
  }

  /**
   * Removes a cloud from the collection.
   *
   * @param {CumulusCloud} cloud The cloud to remove.
   * @returns {boolean} <code>true</code> if the cloud was removed; <code>false</code> if the cloud was not found in the collection.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   *
   * @example
   * const c = clouds.add(...);
   * clouds.remove(c);  // Returns true
   *
   * @see CloudCollection#add
   * @see CloudCollection#removeAll
   * @see CumulusCloud#show
   */
  remove(cloud) {
    if (this.contains(cloud)) {
      this._clouds[cloud._index] = undefined;
      this._cloudsRemoved = true;
      this._createVertexArray = true;
      cloud._destroy();
      return true;
    }

    return false;
  }

  /**
   * Removes all clouds from the collection.
   *
   * @performance <code>O(n)</code>.  It is more efficient to remove all the clouds
   * from a collection and then add new ones than to create a new collection entirely.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   * @example
   * clouds.add(...);
   * clouds.add(...);
   * clouds.removeAll();
   *
   * @see CloudCollection#add
   * @see CloudCollection#remove
   */
  removeAll() {
    destroyClouds(this._clouds);
    this._clouds = [];
    this._cloudsToUpdate = [];
    this._cloudsToUpdateIndex = 0;
    this._cloudsRemoved = false;

    this._createVertexArray = true;
  }

  _updateCloud(cloud, propertyChanged) {
    if (!cloud._dirty) {
      this._cloudsToUpdate[this._cloudsToUpdateIndex++] = cloud;
    }

    ++this._propertiesChanged[propertyChanged];
  }

  /**
   * Clears the per-frame dirty bookkeeping after a WebGPU feature renderer has
   * captured this collection's instance data. The WebGPU CloudRenderer replaces
   * the WebGL vertex-array build (`createVertexArray` / `updateClouds`), so the
   * per-cloud `_dirty` flags, the `_cloudsToUpdate` queue, `_createVertexArray`,
   * and `_cloudsRemoved` are never cleared on the FR path. Without this consume,
   * `_cloudsToUpdateIndex` grows unbounded and every property setter re-dirties
   * settled clouds each frame.
   *
   * Mirrors the WebGL clears:
   *  - per-cloud `_dirty = false` (`updateClouds`, CloudCollection.js:912/923)
   *  - `_cloudsToUpdateIndex = 0` (`updateClouds`, CloudCollection.js:938)
   *  - `_createVertexArray = false` (`createVertexArray`, CloudCollection.js:855)
   *  - `_cloudsRemoved = false` (`removeClouds`, CloudCollection.js:518)
   *  - zero `_propertiesChanged[]`
   *
   * NOTE: WebGPUCloudRenderer's rebuild gate reads `_cloudsToUpdateIndex` /
   * `_createVertexArray` BEFORE calling this consume so per-cloud property
   * edits trigger an instance-buffer re-upload (NEW-CLOUD-REBUILD-DIRTY-GATE,
   * Batch 233). Callers must preserve that read-before-consume ordering.
   *
   * @private
   */
  _consumeDirtyState() {
    const clouds = this._clouds;
    const length = clouds.length;
    for (let i = 0; i < length; ++i) {
      const cloud = clouds[i];
      if (defined(cloud)) {
        cloud._dirty = false;
      }
    }

    this._cloudsToUpdateIndex = 0;
    this._createVertexArray = false;
    this._cloudsRemoved = false;

    const propertiesChanged = this._propertiesChanged;
    for (let k = 0; k < NUMBER_OF_PROPERTIES; ++k) {
      propertiesChanged[k] = 0;
    }
  }

  /**
   * Check whether this collection contains a given cloud.
   *
   * @param {CumulusCloud} [cloud] The cloud to check for.
   * @returns {boolean} true if this collection contains the cloud, false otherwise.
   *
   * @see CloudCollection#get
   */
  contains(cloud) {
    return defined(cloud) && cloud._cloudCollection === this;
  }

  /**
   * Returns the cloud in the collection at the specified index. Indices are zero-based
   * and increase as clouds are added. Removing a cloud shifts all clouds after
   * it to the left, changing their indices. This function is commonly used with
   * {@link CloudCollection#length} to iterate over all the clouds in the collection.
   *
   * @param {number} index The zero-based index of the cloud.
   * @returns {CumulusCloud} The cloud at the specified index.
   *
   * @performance Expected constant time. If clouds were removed from the collection and
   * {@link CloudCollection#update} was not called, an implicit <code>O(n)</code>
   * operation is performed.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   *
   * @example
   * // Toggle the show property of every cloud in the collection
   * const len = clouds.length;
   * for (let i = 0; i < len; ++i) {
   *   const c = clouds.get(i);
   *   c.show = !c.show;
   * }
   *
   * @see CloudCollection#length
   */
  get(index) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number("index", index);
    //>>includeEnd('debug');

    removeClouds(this);
    return this._clouds[index];
  }

  /**
   * @private
   */
  update(frameState) {
    removeClouds(this);
    // Route to WebGPU feature renderer if available
    const context = frameState.context;
    const fr = context.getFeatureRenderer(FeatureRendererKey.CLOUD_COLLECTION);
    if (fr) {
      // Cloud-unification epic slice 3 — exclusive VOLUMETRIC toggle. When this
      // collection is shown, its renderMode is VOLUMETRIC, and its volumetric
      // config is enabled, PUBLISH a resolved CloudVolumetrics snapshot for the
      // env-effects phase to consume as the primary volumetric deck (the first
      // VOLUMETRIC collection this frame wins — see
      // GraphicsContext#requestVolumetricClouds). The `this.show` gate is
      // load-bearing: a hidden collection cedes the deck (publishes nothing).
      // The feature renderer itself suppresses THIS collection's billboards
      // whenever renderMode is VOLUMETRIC (the mode is exclusive). On the WebGL
      // renderer there is no CLOUD_COLLECTION FR, so `requestVolumetricClouds`
      // is a base-class no-op and the billboard path below runs unchanged — a
      // documented graceful no-op for the volumetric config.
      if (
        this.show &&
        this._renderMode === CloudRenderMode.VOLUMETRIC &&
        this.volumetric.enabled === true
      ) {
        context.requestVolumetricClouds(this._resolveVolumetricConfig());
      }
      fr.update(this, frameState);
      this._featureRenderer = fr;
      return;
    }
    if (!this.show) {
      return;
    }

    const debugging = this.debugBillboards || this.debugEllipsoids;
    this._ready = debugging ? true : defined(this._noiseTexture);

    if (!this._ready && !this._loading && !debugging) {
      createNoiseTexture(this, frameState, CloudNoiseVS, CloudNoiseFS);
    }

    this._instanced = frameState.context.instancedArrays;
    attributeLocations = this._instanced
      ? attributeLocationsInstanced
      : attributeLocationsBatched;
    getIndexBuffer = this._instanced
      ? getIndexBufferInstanced
      : getIndexBufferBatched;

    const clouds = this._clouds;
    const cloudsLength = clouds.length;
    const cloudsToUpdate = this._cloudsToUpdate;
    const cloudsToUpdateLength = this._cloudsToUpdateIndex;

    if (this._createVertexArray) {
      createVertexArray(this, frameState);
    } else if (cloudsToUpdateLength > 0) {
      updateClouds(this, frameState);
    }

    if (cloudsToUpdateLength > cloudsLength * 1.5) {
      cloudsToUpdate.length = cloudsLength;
    }

    if (
      !defined(this._vaf) ||
      !defined(this._vaf.va) ||
      !this._ready & !debugging
    ) {
      return;
    }

    if (
      !this._spCreated ||
      this.debugBillboards !== this._compiledDebugBillboards ||
      this.debugEllipsoids !== this._compiledDebugEllipsoids
    ) {
      createShaderProgram(
        this,
        frameState,
        CloudCollectionVS,
        CloudCollectionFS,
      );
    }

    createDrawCommands(this, frameState);
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * <br /><br />
   * If this object was destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   *
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   *
   * @see CloudCollection#destroy
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
   * clouds = clouds && clouds.destroy();
   *
   * @see CloudCollection#isDestroyed
   */
  destroy() {
    this._noiseTexture = this._noiseTexture && this._noiseTexture.destroy();
    this._sp = this._sp && this._sp.destroy();
    this._vaf = this._vaf && this._vaf.destroy();

    destroyClouds(this._clouds);

    if (this._featureRenderer) {
      this._featureRenderer.destroy(this);
    }
    return destroyObject(this);
  }
}

// --- File-scoped helpers (unchanged from original) ---

function getNoiseTextureDimensions(collection) {
  return function () {
    scratchTextureDimensions.x = collection._textureSliceWidth;
    scratchTextureDimensions.y = collection._noiseTextureRows;
    scratchTextureDimensions.z = 1.0 / collection._noiseTextureRows;
    return scratchTextureDimensions;
  };
}

function destroyClouds(clouds) {
  const length = clouds.length;
  for (let i = 0; i < length; ++i) {
    if (clouds[i]) {
      clouds[i]._destroy();
    }
  }
}

function removeClouds(cloudCollection) {
  if (cloudCollection._cloudsRemoved) {
    cloudCollection._cloudsRemoved = false;

    const newClouds = [];
    const clouds = cloudCollection._clouds;
    const length = clouds.length;
    for (let i = 0, j = 0; i < length; ++i) {
      const cloud = clouds[i];
      if (defined(cloud)) {
        clouds._index = j++;
        newClouds.push(cloud);
      }
    }

    cloudCollection._clouds = newClouds;
  }
}

const texturePositions = new Float32Array([
  -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0,
]);

const textureIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);

function createTextureVA(context) {
  const positionBuffer = Buffer.createVertexBuffer({
    context: context,
    typedArray: texturePositions,
    usage: BufferUsage.STATIC_DRAW,
  });
  const indexBuffer = Buffer.createIndexBuffer({
    context: context,
    typedArray: textureIndices,
    usage: BufferUsage.STATIC_DRAW,
    indexDatatype: IndexDatatype.UNSIGNED_SHORT,
  });

  const attributes = [
    {
      index: 0,
      vertexBuffer: positionBuffer,
      componentsPerAttribute: 2,
      componentDatatype: ComponentDatatype.FLOAT,
    },
  ];

  return new VertexArray({
    context: context,
    attributes: attributes,
    indexBuffer: indexBuffer,
  });
}

let getIndexBuffer;

function getIndexBufferBatched(context) {
  const sixteenK = 16 * 1024;

  let indexBuffer = context.cache.cloudCollection_indexBufferBatched;
  if (defined(indexBuffer)) {
    return indexBuffer;
  }

  const length = sixteenK * 6 - 6;
  const indices = new Uint16Array(length);
  for (let i = 0, j = 0; i < length; i += 6, j += 4) {
    indices[i] = j;
    indices[i + 1] = j + 1;
    indices[i + 2] = j + 2;

    indices[i + 3] = j;
    indices[i + 4] = j + 2;
    indices[i + 5] = j + 3;
  }

  indexBuffer = Buffer.createIndexBuffer({
    context: context,
    typedArray: indices,
    usage: BufferUsage.STATIC_DRAW,
    indexDatatype: IndexDatatype.UNSIGNED_SHORT,
  });
  indexBuffer.vertexArrayDestroyable = false;
  context.cache.cloudCollection_indexBufferBatched = indexBuffer;
  return indexBuffer;
}

function getIndexBufferInstanced(context) {
  let indexBuffer = context.cache.cloudCollection_indexBufferInstanced;
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
  context.cache.cloudCollection_indexBufferInstanced = indexBuffer;
  return indexBuffer;
}

function getVertexBufferInstanced(context) {
  let vertexBuffer = context.cache.cloudCollection_vertexBufferInstanced;
  if (defined(vertexBuffer)) {
    return vertexBuffer;
  }

  vertexBuffer = Buffer.createVertexBuffer({
    context: context,
    typedArray: new Float32Array([0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]),
    usage: BufferUsage.STATIC_DRAW,
  });

  vertexBuffer.vertexArrayDestroyable = false;
  context.cache.cloudCollection_vertexBufferInstanced = vertexBuffer;
  return vertexBuffer;
}

function createVAF(context, numberOfClouds, instanced) {
  const attributes = [
    {
      index: attributeLocations.positionHighAndScaleX,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: BufferUsage.STATIC_DRAW,
    },
    {
      index: attributeLocations.positionLowAndScaleY,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: BufferUsage.STATIC_DRAW,
    },
    {
      index: attributeLocations.packedAttribute0,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: BufferUsage.STATIC_DRAW,
    },
    {
      index: attributeLocations.packedAttribute1,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      usage: BufferUsage.STATIC_DRAW,
    },
    {
      index: attributeLocations.color,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
      normalize: true,
      usage: BufferUsage.STATIC_DRAW,
    },
  ];

  if (instanced) {
    attributes.push({
      index: attributeLocations.direction,
      componentsPerAttribute: 2,
      componentDatatype: ComponentDatatype.FLOAT,
      vertexBuffer: getVertexBufferInstanced(context),
    });
  }

  const sizeInVertices = instanced ? numberOfClouds : 4 * numberOfClouds;
  return new VertexArrayFacade(context, attributes, sizeInVertices, instanced);
}

const writePositionScratch = new EncodedCartesian3();

function writePositionAndScale(cloudCollection, frameState, vafWriters, cloud) {
  let i;
  const positionHighWriter =
    vafWriters[attributeLocations.positionHighAndScaleX];
  const positionLowWriter = vafWriters[attributeLocations.positionLowAndScaleY];
  const position = cloud.position;

  EncodedCartesian3.fromCartesian(position, writePositionScratch);
  const scale = cloud.scale;

  const high = writePositionScratch.high;
  const low = writePositionScratch.low;

  if (cloudCollection._instanced) {
    i = cloud._index;
    positionHighWriter(i, high.x, high.y, high.z, scale.x);
    positionLowWriter(i, low.x, low.y, low.z, scale.y);
  } else {
    i = cloud._index * 4;
    positionHighWriter(i + 0, high.x, high.y, high.z, scale.x);
    positionHighWriter(i + 1, high.x, high.y, high.z, scale.x);
    positionHighWriter(i + 2, high.x, high.y, high.z, scale.x);
    positionHighWriter(i + 3, high.x, high.y, high.z, scale.x);

    positionLowWriter(i + 0, low.x, low.y, low.z, scale.y);
    positionLowWriter(i + 1, low.x, low.y, low.z, scale.y);
    positionLowWriter(i + 2, low.x, low.y, low.z, scale.y);
    positionLowWriter(i + 3, low.x, low.y, low.z, scale.y);
  }
}

function writePackedAttribute0(cloudCollection, frameState, vafWriters, cloud) {
  let i;
  const writer = vafWriters[attributeLocations.packedAttribute0];
  const show = cloud.show;
  const brightness = cloud.brightness;

  if (cloudCollection._instanced) {
    i = cloud._index;
    writer(i, show, brightness, 0.0, 0.0);
  } else {
    i = cloud._index * 4;
    writer(i + 0, show, brightness, 0.0, 0.0);
    writer(i + 1, show, brightness, 1.0, 0.0);
    writer(i + 2, show, brightness, 1.0, 1.0);
    writer(i + 3, show, brightness, 0.0, 1.0);
  }
}

function writePackedAttribute1(cloudCollection, frameState, vafWriters, cloud) {
  let i;
  const writer = vafWriters[attributeLocations.packedAttribute1];
  const maximumSize = cloud.maximumSize;
  const slice = cloud.slice;

  if (cloudCollection._instanced) {
    i = cloud._index;
    writer(i, maximumSize.x, maximumSize.y, maximumSize.z, slice);
  } else {
    i = cloud._index * 4;
    writer(i + 0, maximumSize.x, maximumSize.y, maximumSize.z, slice);
    writer(i + 1, maximumSize.x, maximumSize.y, maximumSize.z, slice);
    writer(i + 2, maximumSize.x, maximumSize.y, maximumSize.z, slice);
    writer(i + 3, maximumSize.x, maximumSize.y, maximumSize.z, slice);
  }
}

function writeColor(cloudCollection, frameState, vafWriters, cloud) {
  let i;
  const writer = vafWriters[attributeLocations.color];
  const color = cloud.color;
  const red = Color.floatToByte(color.red);
  const green = Color.floatToByte(color.green);
  const blue = Color.floatToByte(color.blue);
  const alpha = Color.floatToByte(color.alpha);

  if (cloudCollection._instanced) {
    i = cloud._index;
    writer(i, red, green, blue, alpha);
  } else {
    i = cloud._index * 4;
    writer(i + 0, red, green, blue, alpha);
    writer(i + 1, red, green, blue, alpha);
    writer(i + 2, red, green, blue, alpha);
    writer(i + 3, red, green, blue, alpha);
  }
}

function writeCloud(cloudCollection, frameState, vafWriters, cloud) {
  writePositionAndScale(cloudCollection, frameState, vafWriters, cloud);
  writePackedAttribute0(cloudCollection, frameState, vafWriters, cloud);
  writePackedAttribute1(cloudCollection, frameState, vafWriters, cloud);
  writeColor(cloudCollection, frameState, vafWriters, cloud);
}

function createNoiseTexture(cloudCollection, frameState, vsSource, fsSource) {
  const that = cloudCollection;

  const textureSliceWidth = that._textureSliceWidth;
  const noiseTextureRows = that._noiseTextureRows;
  //>>includeStart('debug', pragmas.debug);
  if (
    textureSliceWidth / noiseTextureRows < 1 ||
    textureSliceWidth % noiseTextureRows !== 0
  ) {
    throw new DeveloperError(
      "noiseTextureRows must evenly divide textureSliceWidth",
    );
  }
  //>>includeEnd('debug');

  const context = frameState.context;
  that._vaNoise = createTextureVA(context);
  that._spNoise = ShaderProgram.fromCache({
    context: context,
    vertexShaderSource: vsSource,
    fragmentShaderSource: fsSource,
    attributeLocations: {
      position: 0,
    },
  });

  const noiseDetail = that.noiseDetail;
  const noiseOffset = that.noiseOffset;

  that._noiseTexture = new Texture({
    context: context,
    width: (textureSliceWidth * textureSliceWidth) / noiseTextureRows,
    height: textureSliceWidth * noiseTextureRows,
    pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
    pixelFormat: PixelFormat.RGBA,
    sampler: new Sampler({
      wrapS: TextureWrap.REPEAT,
      wrapT: TextureWrap.REPEAT,
      minificationFilter: TextureMinificationFilter.NEAREST,
      magnificationFilter: TextureMagnificationFilter.NEAREST,
    }),
  });

  const textureCommand = new ComputeCommand({
    vertexArray: that._vaNoise,
    shaderProgram: that._spNoise,
    outputTexture: that._noiseTexture,
    uniformMap: {
      u_noiseTextureDimensions: getNoiseTextureDimensions(that),
      u_noiseDetail: function () {
        return noiseDetail;
      },
      u_noiseOffset: function () {
        return noiseOffset;
      },
    },
    persists: false,
    owner: cloudCollection,
    postExecute: function (texture) {
      that._ready = true;
      that._loading = false;
    },
  });

  frameState.commandList.push(textureCommand);
  that._loading = true;
}

function createVertexArray(cloudCollection, frameState) {
  const that = cloudCollection;
  const context = frameState.context;
  that._createVertexArray = false;
  that._vaf = that._vaf && that._vaf.destroy();

  const clouds = cloudCollection._clouds;
  const cloudsLength = clouds.length;
  if (cloudsLength > 0) {
    that._vaf = createVAF(context, cloudsLength, that._instanced);
    const vafWriters = that._vaf.writers;

    let i;
    for (i = 0; i < cloudsLength; ++i) {
      const cloud = clouds[i];
      writeCloud(cloudCollection, frameState, vafWriters, cloud);
    }

    that._vaf.commit(getIndexBuffer(context));
  }
}

const scratchWriterArray = [];

function updateClouds(cloudCollection, frameState) {
  const context = frameState.context;
  const that = cloudCollection;
  const clouds = that._clouds;
  const cloudsLength = clouds.length;
  const cloudsToUpdate = that._cloudsToUpdate;
  const cloudsToUpdateLength = that._cloudsToUpdateIndex;

  const properties = that._propertiesChanged;

  const writers = scratchWriterArray;
  writers.length = 0;

  if (properties[POSITION_INDEX] || properties[SCALE_INDEX]) {
    writers.push(writePositionAndScale);
  }

  if (properties[SHOW_INDEX] || properties[BRIGHTNESS_INDEX]) {
    writers.push(writePackedAttribute0);
  }

  if (properties[MAXIMUM_SIZE_INDEX] || properties[SLICE_INDEX]) {
    writers.push(writePackedAttribute1);
  }

  if (properties[COLOR_INDEX]) {
    writers.push(writeColor);
  }

  const numWriters = writers.length;
  const vafWriters = that._vaf.writers;

  let i, c, w;
  if (cloudsToUpdateLength / cloudsLength > 0.1) {
    for (i = 0; i < cloudsToUpdateLength; ++i) {
      c = cloudsToUpdate[i];
      c._dirty = false;

      for (w = 0; w < numWriters; ++w) {
        writers[w](cloudCollection, frameState, vafWriters, c);
      }
    }

    that._vaf.commit(getIndexBuffer(context));
  } else {
    for (i = 0; i < cloudsToUpdateLength; ++i) {
      c = cloudsToUpdate[i];
      c._dirty = false;

      for (w = 0; w < numWriters; ++w) {
        writers[w](cloudCollection, frameState, vafWriters, c);
      }

      if (that._instanced) {
        that._vaf.subCommit(c._index, 1);
      } else {
        that._vaf.subCommit(c._index * 4, 4);
      }
    }
    that._vaf.endSubCommits();
  }

  that._cloudsToUpdateIndex = 0;
}

function createShaderProgram(cloudCollection, frameState, vsSource, fsSource) {
  const context = frameState.context;
  const that = cloudCollection;
  const vs = new ShaderSource({
    defines: [],
    sources: [vsSource],
  });

  if (that._instanced) {
    vs.defines.push("INSTANCED");
  }

  const fs = new ShaderSource({
    defines: [],
    sources: [fsSource],
  });

  if (that.debugBillboards) {
    fs.defines.push("DEBUG_BILLBOARDS");
  }

  if (that.debugEllipsoids) {
    fs.defines.push("DEBUG_ELLIPSOIDS");
  }

  that._sp = ShaderProgram.replaceCache({
    context: context,
    shaderProgram: that._sp,
    vertexShaderSource: vs,
    fragmentShaderSource: fs,
    attributeLocations: attributeLocations,
  });

  that._rs = RenderState.fromCache({
    depthTest: {
      enabled: true,
      func: WebGLConstants.LESS,
    },
    depthMask: false,
    blending: BlendingState.ALPHA_BLEND,
  });

  that._spCreated = true;
  that._compiledDebugBillboards = that.debugBillboards;
  that._compiledDebugEllipsoids = that.debugEllipsoids;
}

function createDrawCommands(cloudCollection, frameState) {
  const that = cloudCollection;
  const pass = frameState.passes;
  const uniforms = that._uniforms;
  const commandList = frameState.commandList;
  if (pass.render) {
    const colorList = that._colorCommands;

    const va = that._vaf.va;
    const vaLength = va.length;
    colorList.length = vaLength;
    for (let i = 0; i < vaLength; i++) {
      let command = colorList[i];
      if (!defined(command)) {
        command = colorList[i] = new DrawCommand();
      }
      command.pass = Pass.TRANSLUCENT;
      command.owner = cloudCollection;
      command.uniformMap = uniforms;
      command.count = va[i].indicesCount;
      command.vertexArray = va[i].va;
      command.shaderProgram = that._sp;
      command.renderState = that._rs;
      if (that._instanced) {
        command.count = 6;
        command.instanceCount = that._clouds.length;
      }

      commandList.push(command);
    }
  }
}

export default CloudCollection;
