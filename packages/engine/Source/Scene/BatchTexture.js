import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian4 from "../Core/Cartesian4.js";
import Check from "../Core/Check.js";
import Color from "../Core/Color.js";
import createGuid from "../Core/createGuid.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import PixelFormat from "../Core/PixelFormat.js";
import PixelDatatype from "../Renderer/PixelDatatype.js";
import Sampler from "../Renderer/Sampler.js";
import Texture from "../Renderer/Texture.js";

/**
 * An object that manages color, show/hide and picking textures for a batch
 * table or feature table.
 *
 * @param {object} options Object with the following properties:
 * @param {number} featuresLength The number of features in the batch table or feature table
 * @param {Cesium3DTileContent|ModelFeatureTable} owner The owner of this batch texture. For 3D Tiles, this will be a {@link Cesium3DTileContent}. For glTF models, this will be a {@link ModelFeatureTable}.
 * @param {object} [statistics] The statistics object to update with information about the batch texture.
 * @param {Function} [colorChangedCallback] A callback function that is called whenever the color of a feature changes.
 *
 * @alias BatchTexture
 * @constructor
 *
 * @private
 */
class BatchTexture {
  constructor(options) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number("options.featuresLength", options.featuresLength);
    Check.typeOf.object("options.owner", options.owner);
    //>>includeEnd('debug');

    this._id = createGuid();

    const featuresLength = options.featuresLength;

    // PERFORMANCE_IDEA: These parallel arrays probably generate cache misses in get/set color/show
    // and use A LOT of memory.  How can we use less memory?
    this._showAlphaProperties = undefined; // [Show (0 or 255), Alpha (0 to 255)] property for each feature
    this._batchValues = undefined; // Per-feature RGBA (A is based on the color's alpha and feature's show property)

    this._batchValuesDirty = false;
    this._batchTexture = undefined;
    this._defaultTexture = undefined;

    this._pickTexture = undefined;
    this._pickIds = [];

    // CPU-side edits are allowed before the first render context is known.
    // Start with a flat logical layout, then finalize the GPU row width from
    // frameState.context.limits in update().
    let textureDimensions;
    let textureStep;

    if (featuresLength > 0) {
      const width = featuresLength;
      const height = 1;
      const stepX = 1.0 / width;
      const centerX = stepX * 0.5;
      const stepY = 1.0 / height;
      const centerY = stepY * 0.5;

      textureDimensions = new Cartesian2(width, height);
      textureStep = new Cartesian4(stepX, centerX, stepY, centerY);
    }

    this._translucentFeaturesLength = 0;
    this._featuresLength = featuresLength;
    this._textureDimensions = textureDimensions;
    this._textureStep = textureStep;
    this._textureMaximumSize = undefined;
    this._owner = options.owner;
    this._statistics = options.statistics;
    this._colorChangedCallback = options.colorChangedCallback;
  }

  /**
   * Set whether a feature is visible.
   *
   * @param {number} batchId the ID of the feature
   * @param {boolean} show <code>true</code> if the feature should be shown, <code>false</code> otherwise
   * @private
   */
  setShow(batchId, show) {
    //>>includeStart('debug', pragmas.debug);
    checkBatchId(batchId, this._featuresLength);
    Check.typeOf.bool("show", show);
    //>>includeEnd('debug');

    if (show && !defined(this._showAlphaProperties)) {
      // Avoid allocating since the default is show = true
      return;
    }

    const showAlphaProperties = getShowAlphaProperties(this);
    const propertyOffset = batchId * 2;

    const newShow = show ? 255 : 0;
    if (showAlphaProperties[propertyOffset] !== newShow) {
      showAlphaProperties[propertyOffset] = newShow;

      const batchValues = getBatchValues(this);

      // Compute alpha used in the shader based on show and color.alpha properties
      const offset = batchId * 4 + 3;
      batchValues[offset] = show ? showAlphaProperties[propertyOffset + 1] : 0;

      this._batchValuesDirty = true;
    }
  }

  /**
   * Set the show for all features at once.
   *
   * @param {boolean} show <code>true</code> if the feature should be shown, <code>false</code> otherwise
   * @private
   */
  setAllShow(show) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.bool("show", show);
    //>>includeEnd('debug');

    const featuresLength = this._featuresLength;
    for (let i = 0; i < featuresLength; ++i) {
      this.setShow(i, show);
    }
  }

  /**
   * Check the current show value for a feature
   *
   * @param {number} batchId the ID of the feature
   * @return {boolean} <code>true</code> if the feature is shown, or <code>false</code> otherwise
   * @private
   */
  getShow(batchId) {
    //>>includeStart('debug', pragmas.debug);
    checkBatchId(batchId, this._featuresLength);
    //>>includeEnd('debug');

    if (!defined(this._showAlphaProperties)) {
      // Avoid allocating since the default is show = true
      return true;
    }

    const offset = batchId * 2;
    return this._showAlphaProperties[offset] === 255;
  }

  /**
   * Set the styling color of a feature
   *
   * @param {number} batchId the ID of the feature
   * @param {Color} color the color to assign to this feature.
   *
   * @private
   */
  setColor(batchId, color) {
    //>>includeStart('debug', pragmas.debug);
    checkBatchId(batchId, this._featuresLength);
    Check.typeOf.object("color", color);
    //>>includeEnd('debug');

    if (
      Color.equals(color, BatchTexture.DEFAULT_COLOR_VALUE) &&
      !defined(this._batchValues)
    ) {
      // Avoid allocating since the default is white
      return;
    }

    const newColor = color.toBytes(scratchColorBytes);
    const newAlpha = newColor[3];

    const batchValues = getBatchValues(this);
    const offset = batchId * 4;

    const showAlphaProperties = getShowAlphaProperties(this);
    const propertyOffset = batchId * 2;

    if (
      batchValues[offset] !== newColor[0] ||
      batchValues[offset + 1] !== newColor[1] ||
      batchValues[offset + 2] !== newColor[2] ||
      showAlphaProperties[propertyOffset + 1] !== newAlpha
    ) {
      batchValues[offset] = newColor[0];
      batchValues[offset + 1] = newColor[1];
      batchValues[offset + 2] = newColor[2];

      const wasTranslucent = showAlphaProperties[propertyOffset + 1] !== 255;

      // Compute alpha used in the shader based on show and color.alpha properties
      const show = showAlphaProperties[propertyOffset] !== 0;
      batchValues[offset + 3] = show ? newAlpha : 0;
      showAlphaProperties[propertyOffset + 1] = newAlpha;

      // Track number of translucent features so we know if this tile needs
      // opaque commands, translucent commands, or both for rendering.
      const isTranslucent = newAlpha !== 255;
      if (isTranslucent && !wasTranslucent) {
        ++this._translucentFeaturesLength;
      } else if (!isTranslucent && wasTranslucent) {
        --this._translucentFeaturesLength;
      }

      this._batchValuesDirty = true;

      if (defined(this._colorChangedCallback)) {
        this._colorChangedCallback(batchId, color);
      }
    }
  }

  /**
   * Set the styling color for all features at once
   *
   * @param {Color} color the color to assign to all features.
   *
   * @private
   */
  setAllColor(color) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.object("color", color);
    //>>includeEnd('debug');

    const featuresLength = this._featuresLength;
    for (let i = 0; i < featuresLength; ++i) {
      this.setColor(i, color);
    }
  }

  /**
   * Get the current color of a feature
   *
   * @param {number} batchId The ID of the feature
   * @param {Color} result A color object where the result will be stored.
   * @return {Color} The color assigned to the selected feature
   *
   * @private
   */
  getColor(batchId, result) {
    //>>includeStart('debug', pragmas.debug);
    checkBatchId(batchId, this._featuresLength);
    Check.typeOf.object("result", result);
    //>>includeEnd('debug');

    if (!defined(this._batchValues)) {
      return Color.clone(BatchTexture.DEFAULT_COLOR_VALUE, result);
    }

    const batchValues = this._batchValues;
    const offset = batchId * 4;

    const showAlphaProperties = this._showAlphaProperties;
    const propertyOffset = batchId * 2;

    return Color.fromBytes(
      batchValues[offset],
      batchValues[offset + 1],
      batchValues[offset + 2],
      showAlphaProperties[propertyOffset + 1],
      result,
    );
  }

  /**
   * Get the pick color of a feature. This feature is an RGBA encoding of the
   * pick ID.
   *
   * @param {number} batchId The ID of the feature
   * @return {PickId} The picking color assigned to this feature
   *
   * @private
   */
  getPickColor(batchId) {
    //>>includeStart('debug', pragmas.debug);
    checkBatchId(batchId, this._featuresLength);
    //>>includeEnd('debug');
    return this._pickIds[batchId];
  }

  update(tileset, frameState) {
    const context = frameState.context;
    configureTextureLayout(this, context.limits.maximumTextureSize);
    this._defaultTexture = context.defaultTexture;

    const passes = frameState.passes;
    if (passes.pick || passes.postProcess) {
      createPickTexture(this, context);
    }

    if (this._batchValuesDirty) {
      this._batchValuesDirty = false;

      // Create batch texture on-demand
      if (!defined(this._batchTexture)) {
        this._batchTexture = createTexture(this, context, this._batchValues);

        // Make sure the tileset statistics are updated the frame when the
        // batch texture is created.
        if (defined(this._statistics)) {
          this._statistics.batchTableByteLength +=
            this._batchTexture.sizeInBytes;
        }
      }

      updateBatchTexture(this); // Apply per-feature show/color updates
    }
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * <p>
   * If this object was destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   * </p>
   *
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   *
   * @see BatchTexture#destroy
   * @private
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
   * @see BatchTexture#isDestroyed
   * @private
   */
  destroy() {
    this._batchTexture = this._batchTexture && this._batchTexture.destroy();
    this._pickTexture = this._pickTexture && this._pickTexture.destroy();

    const pickIds = this._pickIds;
    const length = pickIds.length;
    for (let i = 0; i < length; ++i) {
      pickIds[i].destroy();
    }

    return destroyObject(this);
  }

  /**
   * Number of features that are translucent
   *
   * @type {number}
   * @readonly
   * @private
   */
  get translucentFeaturesLength() {
    return this._translucentFeaturesLength;
  }

  /**
   * Total size of all GPU resources used by this batch texture.
   *
   * @type {number}
   * @readonly
   * @private
   */
  get byteLength() {
    let memory = 0;
    if (defined(this._pickTexture)) {
      memory += this._pickTexture.sizeInBytes;
    }
    if (defined(this._batchTexture)) {
      memory += this._batchTexture.sizeInBytes;
    }
    return memory;
  }

  /**
   * Dimensions of the underlying batch texture.
   *
   * @type {Cartesian2}
   * @readonly
   * @private
   */
  get textureDimensions() {
    return this._textureDimensions;
  }

  /**
   * Size of each texture and distance from side to center of a texel in
   * each direction. Stored as (stepX, centerX, stepY, centerY)
   *
   * @type {Cartesian4}
   * @readonly
   * @private
   */
  get textureStep() {
    return this._textureStep;
  }

  /**
   * The underlying texture used for styling. The texels are accessed
   * by batch ID, and the value is the color of this feature after accounting
   * for show/hide settings.
   *
   * @type {Texture}
   * @readonly
   * @private
   */
  get batchTexture() {
    return this._batchTexture;
  }

  /**
   * The default texture to use when there are no batch values
   *
   * @type {Texture}
   * @readonly
   * @private
   */
  get defaultTexture() {
    return this._defaultTexture;
  }

  /**
   * The underlying texture used for picking. The texels are accessed by
   * batch ID, and the value is the pick color.
   *
   * @type {Texture}
   * @readonly
   * @private
   */
  get pickTexture() {
    return this._pickTexture;
  }
}

BatchTexture.DEFAULT_COLOR_VALUE = Color.WHITE;
BatchTexture.DEFAULT_SHOW_VALUE = true;

function configureTextureLayout(batchTexture, maximumTextureSize) {
  if (
    batchTexture._featuresLength === 0 ||
    batchTexture._textureMaximumSize === maximumTextureSize
  ) {
    return;
  }

  const featuresLength = batchTexture._featuresLength;
  const width = Math.min(featuresLength, maximumTextureSize);
  const height = Math.ceil(featuresLength / maximumTextureSize);
  const stepX = 1.0 / width;
  const stepY = 1.0 / height;

  batchTexture._textureDimensions = new Cartesian2(width, height);
  batchTexture._textureStep = new Cartesian4(
    stepX,
    stepX * 0.5,
    stepY,
    stepY * 0.5,
  );
  batchTexture._textureMaximumSize = maximumTextureSize;

  const requiredByteLength = width * height * 4;
  const oldValues = batchTexture._batchValues;
  if (defined(oldValues) && oldValues.length !== requiredByteLength) {
    const resizedValues = new Uint8Array(requiredByteLength).fill(255);
    resizedValues.set(oldValues.subarray(0, requiredByteLength));
    batchTexture._batchValues = resizedValues;
    batchTexture._batchValuesDirty = true;
  }

  // A changed device limit (for example after device recovery) changes the
  // packed resource layout. Recreate context-bound textures deterministically.
  const statistics = batchTexture._statistics;
  if (defined(batchTexture._batchTexture)) {
    if (defined(statistics)) {
      statistics.batchTableByteLength -= batchTexture._batchTexture.sizeInBytes;
    }
    batchTexture._batchTexture = batchTexture._batchTexture.destroy();
    batchTexture._batchValuesDirty = defined(batchTexture._batchValues);
  }
  if (defined(batchTexture._pickTexture)) {
    if (defined(statistics)) {
      statistics.batchTableByteLength -= batchTexture._pickTexture.sizeInBytes;
    }
    batchTexture._pickTexture = batchTexture._pickTexture.destroy();
  }
}

function getByteLength(batchTexture) {
  const dimensions = batchTexture._textureDimensions;
  return dimensions.x * dimensions.y * 4;
}

function getBatchValues(batchTexture) {
  if (!defined(batchTexture._batchValues)) {
    // Default batch texture to RGBA = 255: white highlight (RGB) and show/alpha = true/255 (A).
    const byteLength = getByteLength(batchTexture);
    const bytes = new Uint8Array(byteLength).fill(255);
    batchTexture._batchValues = bytes;
  }

  return batchTexture._batchValues;
}

function getShowAlphaProperties(batchTexture) {
  if (!defined(batchTexture._showAlphaProperties)) {
    const byteLength = 2 * batchTexture._featuresLength;
    const bytes = new Uint8Array(byteLength).fill(255);
    // [Show = true, Alpha = 255]
    batchTexture._showAlphaProperties = bytes;
  }
  return batchTexture._showAlphaProperties;
}

function checkBatchId(batchId, featuresLength) {
  if (!defined(batchId) || batchId < 0 || batchId >= featuresLength) {
    throw new DeveloperError(
      `batchId is required and between zero and featuresLength - 1 (${featuresLength}` -
        +").",
    );
  }
}

const scratchColorBytes = new Array(4);

function createTexture(batchTexture, context, bytes) {
  const dimensions = batchTexture._textureDimensions;
  return new Texture({
    context: context,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
    source: {
      width: dimensions.x,
      height: dimensions.y,
      arrayBufferView: bytes,
    },
    flipY: false,
    sampler: Sampler.NEAREST,
  });
}

function createPickTexture(batchTexture, context) {
  const featuresLength = batchTexture._featuresLength;
  if (!defined(batchTexture._pickTexture) && featuresLength > 0) {
    const pickIds = batchTexture._pickIds;
    const byteLength = getByteLength(batchTexture);
    const bytes = new Uint8Array(byteLength);
    const owner = batchTexture._owner;
    const statistics = batchTexture._statistics;

    // PERFORMANCE_IDEA: we could skip the pick texture completely by allocating
    // a continuous range of pickIds and then converting the base pickId + batchId
    // to RGBA in the shader.  The only consider is precision issues, which might
    // not be an issue in WebGL 2.
    for (let i = 0; i < featuresLength; ++i) {
      let pickId = pickIds[i];
      if (!defined(pickId)) {
        pickId = context.createPickId(owner.getFeature(i), "tile-feature");
        pickIds[i] = pickId;
      }

      const pickColor = pickId.color;
      const offset = i * 4;
      bytes[offset] = Color.floatToByte(pickColor.red);
      bytes[offset + 1] = Color.floatToByte(pickColor.green);
      bytes[offset + 2] = Color.floatToByte(pickColor.blue);
      bytes[offset + 3] = Color.floatToByte(pickColor.alpha);
    }

    batchTexture._pickTexture = createTexture(batchTexture, context, bytes);

    // Make sure the tileset statistics are updated the frame when the pick
    // texture is created.
    if (defined(statistics)) {
      statistics.batchTableByteLength += batchTexture._pickTexture.sizeInBytes;
    }
  }
}

function updateBatchTexture(batchTexture) {
  const dimensions = batchTexture._textureDimensions;
  // PERFORMANCE_IDEA: Instead of rewriting the entire texture, use fine-grained
  // texture updates when less than, for example, 10%, of the values changed.  Or
  // even just optimize the common case when one feature show/color changed.
  batchTexture._batchTexture.copyFrom({
    source: {
      width: dimensions.x,
      height: dimensions.y,
      arrayBufferView: batchTexture._batchValues,
    },
  });
}

export default BatchTexture;
