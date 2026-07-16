import Cartesian4 from "../Core/Cartesian4.js";
import Check from "../Core/Check.js";
import createWorldImageryAsync from "../Scene/createWorldImageryAsync.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import Event from "../Core/Event.js";
import CesiumMath from "../Core/Math.js";
import PixelFormat from "../Core/PixelFormat.js";
import Rectangle from "../Core/Rectangle.js";
import WebMercatorProjection from "../Core/WebMercatorProjection.js";
import ComputeCommand from "../Renderer/ComputeCommand.js";
import Sampler from "../Renderer/Sampler.js";
import Texture from "../Renderer/Texture.js";
import TextureMagnificationFilter from "../Renderer/TextureMagnificationFilter.js";
import TextureMinificationFilter from "../Renderer/TextureMinificationFilter.js";
import TextureWrap from "../Renderer/TextureWrap.js";
import GeographicProjection from "../Core/GeographicProjection.js";
import MipmapHint from "../Renderer/MipmapHint.js";
import Imagery from "./Imagery.js";
import ImageryState from "./ImageryState.js";
import SplitDirection from "./SplitDirection.js";
import TileImagery from "./TileImagery.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import {
  createTileImagerySkeletons,
  requestImagery,
  reprojectToGeographic,
  getSamplerKey,
  getImageryCacheKey,
  handlePromise,
} from "./ImageryLayerHelpers.js";

/**
 * @typedef {object} ImageryLayer.ConstructorOptions
 *
 * Initialization options for the ImageryLayer constructor.
 *
 * @property {Rectangle} [rectangle=imageryProvider.rectangle] The rectangle of the layer.  This rectangle
 *        can limit the visible portion of the imagery provider.
 * @property {number|Function} [alpha=1.0] The alpha blending value of this layer, from 0.0 to 1.0.
 *                          This can either be a simple number or a function with the signature
 *                          <code>function(frameState, layer, x, y, level)</code>.  The function is passed the
 *                          current frame state, this layer, and the x, y, and level coordinates of the
 *                          imagery tile for which the alpha is required, and it is expected to return
 *                          the alpha value to use for the tile.
 * @property {number|Function} [nightAlpha=1.0] The alpha blending value of this layer on the night side of the globe, from 0.0 to 1.0.
 *                          This can either be a simple number or a function with the signature
 *                          <code>function(frameState, layer, x, y, level)</code>.  The function is passed the
 *                          current frame state, this layer, and the x, y, and level coordinates of the
 *                          imagery tile for which the alpha is required, and it is expected to return
 *                          the alpha value to use for the tile. This only takes effect when <code>enableLighting</code> is <code>true</code>.
 * @property {number|Function} [dayAlpha=1.0] The alpha blending value of this layer on the day side of the globe, from 0.0 to 1.0.
 *                          This can either be a simple number or a function with the signature
 *                          <code>function(frameState, layer, x, y, level)</code>.  The function is passed the
 *                          current frame state, this layer, and the x, y, and level coordinates of the
 *                          imagery tile for which the alpha is required, and it is expected to return
 *                          the alpha value to use for the tile. This only takes effect when <code>enableLighting</code> is <code>true</code>.
 * @property {number|Function} [brightness=1.0] The brightness of this layer.  1.0 uses the unmodified imagery
 *                          color.  Less than 1.0 makes the imagery darker while greater than 1.0 makes it brighter.
 * @property {number|Function} [contrast=1.0] The contrast of this layer.  1.0 uses the unmodified imagery color.
 *                          Less than 1.0 reduces the contrast while greater than 1.0 increases it.
 * @property {number|Function} [hue=0.0] The hue of this layer in radians. 0.0 uses the unmodified imagery color.
 * @property {number|Function} [saturation=1.0] The saturation of this layer. 1.0 uses the unmodified imagery color.
 *                          Less than 1.0 reduces the saturation while greater than 1.0 increases it.
 * @property {number|Function} [gamma=1.0] The gamma correction to apply to this layer.  1.0 uses the unmodified imagery color.
 * @property {SplitDirection|Function} [splitDirection=SplitDirection.NONE] The {@link SplitDirection} split to apply to this layer.
 * @property {TextureMinificationFilter} [minificationFilter=TextureMinificationFilter.LINEAR] The
 *                                    texture minification filter to apply to this layer.
 * @property {TextureMagnificationFilter} [magnificationFilter=TextureMagnificationFilter.LINEAR] The
 *                                     texture magnification filter to apply to this layer.
 * @property {boolean} [show=true] True if the layer is shown; otherwise, false.
 * @property {number} [maximumAnisotropy=maximum supported] The maximum anisotropy level to use for texture filtering.
 * @property {number} [minimumTerrainLevel] The minimum terrain level-of-detail at which to show this imagery layer.
 * @property {number} [maximumTerrainLevel] The maximum terrain level-of-detail at which to show this imagery layer.
 * @property {Rectangle} [cutoutRectangle] Cartographic rectangle for cutting out a portion of this ImageryLayer.
 * @property {Color} [colorToAlpha] Color to be used as alpha.
 * @property {number} [colorToAlphaThreshold=0.004] Threshold for color-to-alpha.
 */

/**
 * An imagery layer that displays tiled image data from a single imagery provider
 * on a {@link Globe} or {@link Cesium3DTileset}.
 *
 * @alias ImageryLayer
 *
 * @param {ImageryProvider} [imageryProvider] The imagery provider to use.
 * @param {ImageryLayer.ConstructorOptions} [options] An object describing initialization options
 *
 * @see {@link ImageryLayer.fromProviderAsync} for creating an imagery layer from an asynchronous imagery provider.
 * @see {@link ImageryLayer.fromWorldImagery} for creating an imagery layer for Cesium ion's default global base imagery layer.
 * @see {@link Scene#imageryLayers} for adding an imagery layer to the globe.
 * @see {@link Cesium3DTileset#imageryLayers} for adding an imagery layer to a 3D tileset.
 *
 * @example
 * // Add an OpenStreetMaps layer
 * const imageryLayer = new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({
 *   url: "https://tile.openstreetmap.org/"
 * }));
 * scene.imageryLayers.add(imageryLayer);
 *
 * @example
 * // Add Cesium ion's default world imagery layer
 * const imageryLayer = Cesium.ImageryLayer.fromWorldImagery();
 * scene.imageryLayers.add(imageryLayer);
 *
 * @example
 * // Add a new transparent layer from Cesium ion
 * const imageryLayer = Cesium.ImageryLayer.fromProviderAsync(Cesium.IonImageryProvider.fromAssetId(3812));
 * imageryLayer.alpha = 0.5;
 * scene.imageryLayers.add(imageryLayer);
 */
class ImageryLayer {
  constructor(imageryProvider, options) {
    this._imageryProvider = imageryProvider;

    this._readyEvent = new Event();
    this._errorEvent = new Event();

    options = options ?? Frozen.EMPTY_OBJECT;
    imageryProvider = imageryProvider ?? Frozen.EMPTY_OBJECT;

    /**
     * The alpha blending value of this layer, with 0.0 representing fully transparent and
     * 1.0 representing fully opaque.
     * @type {number}
     * @default 1.0
     */
    this.alpha = options.alpha ?? imageryProvider._defaultAlpha ?? 1.0;

    /**
     * The alpha blending value of this layer on the night side of the globe.
     * @type {number}
     * @default 1.0
     */
    this.nightAlpha =
      options.nightAlpha ?? imageryProvider._defaultNightAlpha ?? 1.0;

    /**
     * The alpha blending value of this layer on the day side of the globe.
     * @type {number}
     * @default 1.0
     */
    this.dayAlpha = options.dayAlpha ?? imageryProvider._defaultDayAlpha ?? 1.0;

    /**
     * The brightness of this layer.  1.0 uses the unmodified imagery color.
     * @type {number}
     * @default {@link ImageryLayer.DEFAULT_BRIGHTNESS}
     */
    this.brightness =
      options.brightness ??
      imageryProvider._defaultBrightness ??
      ImageryLayer.DEFAULT_BRIGHTNESS;

    /**
     * The contrast of this layer.  1.0 uses the unmodified imagery color.
     * @type {number}
     * @default {@link ImageryLayer.DEFAULT_CONTRAST}
     */
    this.contrast =
      options.contrast ??
      imageryProvider._defaultContrast ??
      ImageryLayer.DEFAULT_CONTRAST;

    /**
     * The hue of this layer in radians. 0.0 uses the unmodified imagery color.
     * @type {number}
     * @default {@link ImageryLayer.DEFAULT_HUE}
     */
    this.hue =
      options.hue ?? imageryProvider._defaultHue ?? ImageryLayer.DEFAULT_HUE;

    /**
     * The saturation of this layer.
     * @type {number}
     * @default {@link ImageryLayer.DEFAULT_SATURATION}
     */
    this.saturation =
      options.saturation ??
      imageryProvider._defaultSaturation ??
      ImageryLayer.DEFAULT_SATURATION;

    /**
     * The gamma correction to apply to this layer.
     * @type {number}
     * @default {@link ImageryLayer.DEFAULT_GAMMA}
     */
    this.gamma =
      options.gamma ??
      imageryProvider._defaultGamma ??
      ImageryLayer.DEFAULT_GAMMA;

    /**
     * The {@link SplitDirection} to apply to this layer.
     * @type {SplitDirection}
     * @default {@link ImageryLayer.DEFAULT_SPLIT}
     */
    this.splitDirection = options.splitDirection ?? ImageryLayer.DEFAULT_SPLIT;

    /**
     * The {@link TextureMinificationFilter} to apply to this layer.
     * @type {TextureMinificationFilter}
     * @default {@link ImageryLayer.DEFAULT_MINIFICATION_FILTER}
     */
    this.minificationFilter =
      options.minificationFilter ??
      imageryProvider._defaultMinificationFilter ??
      ImageryLayer.DEFAULT_MINIFICATION_FILTER;

    /**
     * The {@link TextureMagnificationFilter} to apply to this layer.
     * @type {TextureMagnificationFilter}
     * @default {@link ImageryLayer.DEFAULT_MAGNIFICATION_FILTER}
     */
    this.magnificationFilter =
      options.magnificationFilter ??
      imageryProvider._defaultMagnificationFilter ??
      ImageryLayer.DEFAULT_MAGNIFICATION_FILTER;

    /**
     * Determines if this layer is shown.
     * @type {boolean}
     * @default true
     */
    this.show = options.show ?? true;

    this._minimumTerrainLevel = options.minimumTerrainLevel;
    this._maximumTerrainLevel = options.maximumTerrainLevel;

    this._rectangle = options.rectangle ?? Rectangle.MAX_VALUE;
    this._maximumAnisotropy = options.maximumAnisotropy;

    this._imageryCache = {};

    this._skeletonPlaceholder = new TileImagery(
      Imagery.createPlaceholder(this),
    );

    this._show = true;
    this._layerIndex = -1;
    this._isBaseLayer = false;
    this._requestImageError = undefined;
    this._reprojectComputeCommands = [];

    /**
     * Rectangle cutout in this layer of imagery.
     * @type {Rectangle}
     */
    this.cutoutRectangle = options.cutoutRectangle;

    /**
     * Color value that should be set to transparent.
     * @type {Color}
     */
    this.colorToAlpha = options.colorToAlpha;

    /**
     * Normalized (0-1) threshold for color-to-alpha.
     * @type {number}
     */
    this.colorToAlphaThreshold =
      options.colorToAlphaThreshold ??
      ImageryLayer.DEFAULT_APPLY_COLOR_TO_ALPHA_THRESHOLD;
  }

  /**
   * Gets the imagery provider for this layer.
   * @type {ImageryProvider}
   * @readonly
   */
  get imageryProvider() {
    return this._imageryProvider;
  }

  /**
   * Returns true when the imagery provider has been successfully created.
   * @type {boolean}
   * @readonly
   */
  get ready() {
    return defined(this._imageryProvider);
  }

  /**
   * Gets an event that is raised when the imagery provider encounters an asynchronous error.
   * @type {Event<ImageryLayer.ErrorEventCallback>}
   * @readonly
   */
  get errorEvent() {
    return this._errorEvent;
  }

  /**
   * Gets an event that is raised when the imagery provider has been successfully created.
   * @type {Event<ImageryLayer.ReadyEventCallback>}
   * @readonly
   */
  get readyEvent() {
    return this._readyEvent;
  }

  /**
   * Gets the rectangle of this layer.
   * @type {Rectangle}
   * @readonly
   */
  get rectangle() {
    return this._rectangle;
  }

  /**
   * Gets a value indicating whether this layer is the base layer in the
   * {@link ImageryLayerCollection}.
   * @returns {boolean} true if this is the base layer; otherwise, false.
   */
  isBaseLayer() {
    return this._isBaseLayer;
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * @returns {boolean} True if this object was destroyed; otherwise, false.
   * @see ImageryLayer#destroy
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys the WebGL resources held by this object.
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   * @example
   * imageryLayer = imageryLayer && imageryLayer.destroy();
   * @see ImageryLayer#isDestroyed
   */
  destroy() {
    return destroyObject(this);
  }

  /**
   * Computes the intersection of this layer's rectangle with the imagery provider's
   * availability rectangle.
   * @returns {Rectangle} A rectangle which defines the overall bounds of imagery.
   * @example
   * const imageryRectangle = imageryLayer.getImageryRectangle();
   * scene.camera.flyTo({ destination: imageryRectangle });
   */
  getImageryRectangle() {
    const imageryProvider = this._imageryProvider;
    const rectangle = this._rectangle;
    return Rectangle.intersection(imageryProvider.rectangle, rectangle);
  }

  /**
   * @private
   */
  _createTileImagerySkeletons(tile, terrainProvider, insertionPoint) {
    return createTileImagerySkeletons(
      this,
      tile,
      terrainProvider,
      insertionPoint,
    );
  }

  /**
   * @private
   */
  _calculateTextureTranslationAndScale(tile, tileImagery) {
    let imageryRectangle = tileImagery.readyImagery.rectangle;
    let terrainRectangle = tile.rectangle;

    if (tileImagery.useWebMercatorT) {
      const tilingScheme =
        tileImagery.readyImagery.imageryLayer.imageryProvider.tilingScheme;
      imageryRectangle = tilingScheme.rectangleToNativeRectangle(
        imageryRectangle,
        imageryBoundsScratch,
      );
      terrainRectangle = tilingScheme.rectangleToNativeRectangle(
        terrainRectangle,
        terrainRectangleScratch,
      );
    }

    const terrainWidth = terrainRectangle.width;
    const terrainHeight = terrainRectangle.height;

    const scaleX = terrainWidth / imageryRectangle.width;
    const scaleY = terrainHeight / imageryRectangle.height;
    return new Cartesian4(
      (scaleX * (terrainRectangle.west - imageryRectangle.west)) / terrainWidth,
      (scaleY * (terrainRectangle.south - imageryRectangle.south)) /
        terrainHeight,
      scaleX,
      scaleY,
    );
  }

  /**
   * @private
   */
  _requestImagery(imagery, context) {
    requestImagery(this, imagery, context);
  }

  _createTextureWebGL(context, imagery) {
    const sampler = new Sampler({
      minificationFilter: this.minificationFilter,
      magnificationFilter: this.magnificationFilter,
    });

    const image = imagery.image;

    if (defined(image.internalFormat)) {
      return new Texture({
        context: context,
        pixelFormat: image.internalFormat,
        width: image.width,
        height: image.height,
        source: {
          arrayBufferView: image.bufferView,
        },
        sampler: sampler,
      });
    }
    return new Texture({
      context: context,
      source: image,
      pixelFormat: this._imageryProvider.hasAlphaChannel
        ? PixelFormat.RGBA
        : PixelFormat.RGB,
      sampler: sampler,
    });
  }

  /**
   * Create a texture for a given {@link Imagery} instance.
   * Uses native WebGPU path when available, falls back to WebGL.
   * @private
   */
  _createTexture(context, imagery) {
    const imageryProvider = this._imageryProvider;
    const image = imagery.image;

    if (defined(imageryProvider.tileDiscardPolicy)) {
      const discardPolicy = imageryProvider.tileDiscardPolicy;
      if (defined(discardPolicy)) {
        if (!discardPolicy.isReady()) {
          imagery.state = ImageryState.RECEIVED;
          return;
        }

        if (discardPolicy.shouldDiscardImage(image)) {
          imagery.state = ImageryState.INVALID;
          return;
        }
      }
    }

    //>>includeStart('debug', pragmas.debug);
    if (
      this.minificationFilter !== TextureMinificationFilter.NEAREST &&
      this.minificationFilter !== TextureMinificationFilter.LINEAR
    ) {
      throw new DeveloperError(
        "ImageryLayer minification filter must be NEAREST or LINEAR",
      );
    }
    //>>includeEnd('debug');

    // When the globe surface renderer handles texture upload directly
    // (e.g., via feature renderer), skip WebGL Texture creation and
    // use a lightweight placeholder so texture.width/height work.
    // The image source is preserved for GPU upload later.
    const globeSurfaceFR = context.getFeatureRenderer(
      FeatureRendererKey.GLOBE_SURFACE,
    );
    if (globeSurfaceFR) {
      const width = image.width || image.naturalWidth || 256;
      const height = image.height || image.naturalHeight || 256;
      const placeholder = {
        width: width,
        height: height,
        _isPlaceholder: true,
        destroy: function () {
          // No-op — placeholder has no GPU resources to release.
          // The real texture is managed by the globe surface renderer's
          // texture cache.
        },
      };

      if (
        imageryProvider.tilingScheme.projection instanceof WebMercatorProjection
      ) {
        imagery.textureWebMercator = placeholder;
      } else {
        imagery.texture = placeholder;
      }
      imagery.state = ImageryState.TEXTURE_LOADED;
      return;
    }

    const texture = this._createTextureWebGL(context, imagery);

    if (
      imageryProvider.tilingScheme.projection instanceof WebMercatorProjection
    ) {
      imagery.textureWebMercator = texture;
    } else {
      imagery.texture = texture;
    }

    imagery.image = undefined;
    imagery.state = ImageryState.TEXTURE_LOADED;
  }

  _finalizeReprojectTexture(context, texture) {
    let minificationFilter = this.minificationFilter;
    const magnificationFilter = this.magnificationFilter;
    const usesLinearTextureFilter =
      minificationFilter === TextureMinificationFilter.LINEAR &&
      magnificationFilter === TextureMagnificationFilter.LINEAR;
    if (
      usesLinearTextureFilter &&
      !PixelFormat.isCompressedFormat(texture.pixelFormat) &&
      CesiumMath.isPowerOfTwo(texture.width) &&
      CesiumMath.isPowerOfTwo(texture.height)
    ) {
      minificationFilter = TextureMinificationFilter.LINEAR_MIPMAP_LINEAR;
      const maximumSupportedAnisotropy =
        context.limits.maximumTextureFilterAnisotropy;
      const maximumAnisotropy = Math.min(
        maximumSupportedAnisotropy,
        this._maximumAnisotropy ?? maximumSupportedAnisotropy,
      );
      const mipmapSamplerKey = getSamplerKey(
        minificationFilter,
        magnificationFilter,
        maximumAnisotropy,
      );
      let mipmapSamplers = context.cache.imageryLayerMipmapSamplers;
      if (!defined(mipmapSamplers)) {
        mipmapSamplers = {};
        context.cache.imageryLayerMipmapSamplers = mipmapSamplers;
      }
      let mipmapSampler = mipmapSamplers[mipmapSamplerKey];
      if (!defined(mipmapSampler)) {
        mipmapSampler = mipmapSamplers[mipmapSamplerKey] = new Sampler({
          wrapS: TextureWrap.CLAMP_TO_EDGE,
          wrapT: TextureWrap.CLAMP_TO_EDGE,
          minificationFilter: minificationFilter,
          magnificationFilter: magnificationFilter,
          maximumAnisotropy: maximumAnisotropy,
        });
      }
      texture.generateMipmap(MipmapHint.NICEST);
      texture.sampler = mipmapSampler;
    } else {
      const nonMipmapSamplerKey = getSamplerKey(
        minificationFilter,
        magnificationFilter,
        0,
      );
      let nonMipmapSamplers = context.cache.imageryLayerNonMipmapSamplers;
      if (!defined(nonMipmapSamplers)) {
        nonMipmapSamplers = {};
        context.cache.imageryLayerNonMipmapSamplers = nonMipmapSamplers;
      }
      let nonMipmapSampler = nonMipmapSamplers[nonMipmapSamplerKey];
      if (!defined(nonMipmapSampler)) {
        nonMipmapSampler = nonMipmapSamplers[nonMipmapSamplerKey] = new Sampler(
          {
            wrapS: TextureWrap.CLAMP_TO_EDGE,
            wrapT: TextureWrap.CLAMP_TO_EDGE,
            minificationFilter: minificationFilter,
            magnificationFilter: magnificationFilter,
          },
        );
      }
      texture.sampler = nonMipmapSampler;
    }
  }

  /**
   * @private
   */
  _reprojectTexture(frameState, imagery, needGeographicProjection) {
    const texture = imagery.textureWebMercator || imagery.texture;
    const rectangle = imagery.rectangle;
    const context = frameState.context;

    needGeographicProjection = needGeographicProjection ?? true;

    const isMercatorProvider = !(
      this._imageryProvider.tilingScheme.projection instanceof
      GeographicProjection
    );

    // Batch 65 — WebGPU dual-texture upload. When the IMAGERY_REPROJECTION
    // feature renderer exposes `uploadAndReproject`, run the dual-texture
    // path for ANY Mercator-provider tile regardless of whether geographic
    // projection is currently requested by the caller. This is critical
    // because:
    //
    //   1. When ALL skeletons reference this imagery with
    //      `useWebMercatorT === true`, `TileImagery.processStateMachine`
    //      calls down with `needGeographicProjection = false`. The legacy
    //      path then skips reprojection AND skips any GPU upload, which
    //      leaves the WebGPU cache to lazily upload `imagery.image` as a
    //      geographic-keyed texture — but the data is Mercator-V, so the
    //      shader's `useWebMercatorTLayer = 1.0` sampling (`webMercT × cached
    //      Mercator-space translation/scale`) ends up reading from a
    //      texture keyed against a geographic-V interpretation.
    //
    //   2. The bind-group setup and the tile-UB packer run independently
    //      in the renderer and both need to agree on which texture variant
    //      is bound. Eagerly setting `imagery._webgpuMercatorTexture` and
    //      `imagery._webgpuReprojectedTexture` during the state machine
    //      gives both code paths a fixed view of the imagery from frame 1.
    //
    // Mirrors WebGL's `imagery.textureWebMercator` / `imagery.texture`
    // dual-texture architecture (`_createTexture` produces the Mercator
    // texture; `_reprojectTexture` produces the geographic one).
    const fr = context.getFeatureRenderer(
      FeatureRendererKey.IMAGERY_REPROJECTION,
    );
    if (
      isMercatorProvider &&
      fr &&
      typeof fr.uploadAndReproject === "function" &&
      defined(imagery.image)
    ) {
      const device = context._device;
      const image = imagery.image;
      const dual = fr.uploadAndReproject(
        device,
        image,
        image.width,
        image.height,
        rectangle.south,
        rectangle.north,
      );
      imagery._webgpuMercatorTexture = dual.mercator;
      imagery._webgpuReprojectedTexture = dual.reprojected;
      // Hand the imagery the context so its eviction (Imagery.releaseReference)
      // can DEFER these GPUTextures' destruction past the in-flight frame
      // instead of freeing them inline (which races a still-submitted globe
      // draw → "Destroyed texture used in a submit"). See
      // WebGPUContext.scheduleTextureDestroy.
      imagery._webgpuContext = context;
      // Set texture property for compatibility with existing code paths.
      imagery.texture = texture;
      // Both GPU textures own the pixel data — release the host-side
      // ImageBitmap/Canvas/Img so it doesn't stay pinned.
      imagery.image = undefined;
      imagery.state = ImageryState.READY;
      return;
    }

    const needsReprojection =
      needGeographicProjection &&
      isMercatorProvider &&
      rectangle.width / texture.width > 1e-5;

    if (needsReprojection) {
      // FR exists but image source not available — use texture as-is.
      // This handles contexts where reprojection is managed by the feature
      // renderer but the image was released before reprojection could run.
      if (fr) {
        imagery.texture = texture;
        imagery.state = ImageryState.READY;
        return;
      }

      // No feature renderer — use ComputeCommand for GPGPU reprojection
      const that = this;
      imagery.addReference();
      const computeCommand = new ComputeCommand({
        persists: true,
        owner: this,
        preExecute: function (command) {
          reprojectToGeographic(command, context, texture, imagery.rectangle);
        },
        postExecute: function (outputTexture) {
          imagery.texture = outputTexture;
          that._finalizeReprojectTexture(context, outputTexture);
          imagery.state = ImageryState.READY;
          imagery.releaseReference();
        },
        canceled: function () {
          imagery.state = ImageryState.TEXTURE_LOADED;
          imagery.releaseReference();
        },
      });
      this._reprojectComputeCommands.push(computeCommand);
    } else {
      if (needGeographicProjection) {
        imagery.texture = texture;
      }
      // When the globe surface renderer handles its own texture management,
      // skip _finalizeReprojectTexture (sampler/mipmap setup) since that is
      // backend-specific and handled by the renderer's own texture pipeline.
      if (!context.getFeatureRenderer(FeatureRendererKey.GLOBE_SURFACE)) {
        this._finalizeReprojectTexture(context, texture);
      }
      imagery.state = ImageryState.READY;
    }
  }

  /**
   * Updates frame state to execute any queued texture re-projections.
   * @private
   */
  queueReprojectionCommands(frameState) {
    const computeCommands = this._reprojectComputeCommands;
    const length = computeCommands.length;
    for (let i = 0; i < length; ++i) {
      frameState.commandList.push(computeCommands[i]);
    }
    computeCommands.length = 0;
  }

  /**
   * Cancels re-projection commands queued for the next frame.
   * @private
   */
  cancelReprojections() {
    this._reprojectComputeCommands.forEach(function (command) {
      if (defined(command.canceled)) {
        command.canceled();
      }
    });
    this._reprojectComputeCommands.length = 0;
  }

  getImageryFromCache(x, y, level, imageryRectangle) {
    const cacheKey = getImageryCacheKey(x, y, level);
    let imagery = this._imageryCache[cacheKey];

    if (!defined(imagery)) {
      imagery = new Imagery(this, x, y, level, imageryRectangle);
      this._imageryCache[cacheKey] = imagery;
    }

    imagery.addReference();
    return imagery;
  }

  removeImageryFromCache(imagery) {
    const cacheKey = getImageryCacheKey(imagery.x, imagery.y, imagery.level);
    delete this._imageryCache[cacheKey];
  }

  /**
   * Create a new imagery layer from an asynchronous imagery provider.
   *
   * @param {Promise<ImageryProvider>} imageryProviderPromise A promise which resolves to a imagery provider
   * @param {ImageryLayer.ConstructorOptions} [options] An object describing initialization options
   * @returns {ImageryLayer} The created imagery layer.
   *
   * @example
   * // Create a new base layer
   * const viewer = new Cesium.Viewer("cesiumContainer", {
   *   baseLayer: Cesium.ImageryLayer.fromProviderAsync(Cesium.IonImageryProvider.fromAssetId(3812));
   * });
   *
   * @see ImageryLayer#errorEvent
   * @see ImageryLayer#readyEvent
   * @see ImageryLayer#imageryProvider
   * @see ImageryLayer.fromWorldImagery
   */
  static fromProviderAsync(imageryProviderPromise, options) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.object("imageryProviderPromise", imageryProviderPromise);
    //>>includeEnd('debug');

    const layer = new ImageryLayer(undefined, options);
    handlePromise(layer, Promise.resolve(imageryProviderPromise));
    return layer;
  }

  /**
   * Create a new imagery layer for ion's default global base imagery layer, currently Bing Maps.
   *
   * @param {ImageryLayer.WorldImageryConstructorOptions} [options] An object describing initialization options
   * @returns {ImageryLayer} The created imagery layer.
   *
   * @example
   * const viewer = new Cesium.Viewer("cesiumContainer", {
   *   baseLayer: Cesium.ImageryLayer.fromWorldImagery();
   * });
   *
   * @see ImageryLayer#errorEvent
   * @see ImageryLayer#readyEvent
   * @see ImageryLayer#imageryProvider
   */
  static fromWorldImagery(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    return ImageryLayer.fromProviderAsync(
      createWorldImageryAsync({
        style: options.style,
      }),
      options,
    );
  }
}

const imageryBoundsScratch = new Rectangle();
const terrainRectangleScratch = new Rectangle();

/**
 * @type {number}
 * @default 1.0
 */
ImageryLayer.DEFAULT_BRIGHTNESS = 1.0;
/**
 * @type {number}
 * @default 1.0
 */
ImageryLayer.DEFAULT_CONTRAST = 1.0;
/**
 * @type {number}
 * @default 0.0
 */
ImageryLayer.DEFAULT_HUE = 0.0;
/**
 * @type {number}
 * @default 1.0
 */
ImageryLayer.DEFAULT_SATURATION = 1.0;
/**
 * @type {number}
 * @default 1.0
 */
ImageryLayer.DEFAULT_GAMMA = 1.0;
/**
 * @type {SplitDirection}
 * @default SplitDirection.NONE
 */
ImageryLayer.DEFAULT_SPLIT = SplitDirection.NONE;
/**
 * @type {TextureMinificationFilter}
 * @default TextureMinificationFilter.LINEAR
 */
ImageryLayer.DEFAULT_MINIFICATION_FILTER = TextureMinificationFilter.LINEAR;
/**
 * @type {TextureMagnificationFilter}
 * @default TextureMagnificationFilter.LINEAR
 */
ImageryLayer.DEFAULT_MAGNIFICATION_FILTER = TextureMagnificationFilter.LINEAR;
/**
 * @type {number}
 * @default 0.004
 */
ImageryLayer.DEFAULT_APPLY_COLOR_TO_ALPHA_THRESHOLD = 0.004;

export default ImageryLayer;

/**
 * A function that is called when an error occurs.
 * @callback ImageryLayer.ErrorEventCallback
 * @this ImageryLayer
 * @param {Error} err An object holding details about the error that occurred.
 */

/**
 * A function that is called when the provider has been created
 * @callback ImageryLayer.ReadyEventCallback
 * @this ImageryLayer
 * @param {ImageryProvider} provider The created imagery provider.
 */
