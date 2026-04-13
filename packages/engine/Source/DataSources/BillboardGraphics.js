import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Event from "../Core/Event.js";
import createPropertyDescriptor from "./createPropertyDescriptor.js";

/**
 * @typedef {object} BillboardGraphics.ConstructorOptions
 *
 * Initialization options for the BillboardGraphics constructor
 *
 * @property {Property | boolean} [show=true] A boolean Property specifying the visibility of the billboard.
 * @property {Property | string | HTMLImageElement | HTMLCanvasElement} [image] A Property specifying the Image, URI, or Canvas to use for the billboard.
 * @property {Property | number} [scale=1.0] A numeric Property specifying the scale to apply to the image size.
 * @property {Property | Cartesian2} [pixelOffset=Cartesian2.ZERO] A {@link Cartesian2} Property specifying the pixel offset.
 * @property {Property | Cartesian3} [eyeOffset=Cartesian3.ZERO] A {@link Cartesian3} Property specifying the eye offset.
 * @property {Property | HorizontalOrigin} [horizontalOrigin=HorizontalOrigin.CENTER] A Property specifying the {@link HorizontalOrigin}.
 * @property {Property | VerticalOrigin} [verticalOrigin=VerticalOrigin.CENTER] A Property specifying the {@link VerticalOrigin}.
 * @property {Property | HeightReference} [heightReference=HeightReference.NONE] A Property specifying what the height is relative to.
 * @property {Property | Color} [color=Color.WHITE] A Property specifying the tint {@link Color} of the image.
 * @property {Property | number} [rotation=0] A numeric Property specifying the rotation about the alignedAxis.
 * @property {Property | Cartesian3} [alignedAxis=Cartesian3.ZERO] A {@link Cartesian3} Property specifying the unit vector axis of rotation.
 * @property {Property | boolean} [sizeInMeters] A boolean Property specifying whether this billboard's size should be measured in meters.
 * @property {Property | number} [width] A numeric Property specifying the width of the billboard in pixels, overriding the native size.
 * @property {Property | number} [height] A numeric Property specifying the height of the billboard in pixels, overriding the native size.
 * @property {Property | NearFarScalar} [scaleByDistance] A {@link NearFarScalar} Property used to scale the point based on distance from the camera.
 * @property {Property | NearFarScalar} [translucencyByDistance] A {@link NearFarScalar} Property used to set translucency based on distance from the camera.
 * @property {Property | NearFarScalar} [pixelOffsetScaleByDistance] A {@link NearFarScalar} Property used to set pixelOffset based on distance from the camera.
 * @property {Property | BoundingRectangle} [imageSubRegion] A Property specifying a {@link BoundingRectangle} that defines a sub-region of the image to use for the billboard, rather than the entire image, measured in pixels from the bottom-left.
 * @property {Property | DistanceDisplayCondition} [distanceDisplayCondition] A Property specifying at what distance from the camera that this billboard will be displayed.
 * @property {Property | number} [disableDepthTestDistance] A Property specifying the distance from the camera at which to disable the depth test to.
 * @property {Property | SplitDirection} [splitDirection] A Property specifying the {@link SplitDirection} of the billboard.
 */

/**
 * Describes a two dimensional icon located at the position of the containing {@link Entity}.
 * <p>
 * <div align='center'>
 * <img src='Images/Billboard.png' width='400' height='300' /><br />
 * Example billboards
 * </div>
 * </p>
 *
 * @alias BillboardGraphics
 * @constructor
 *
 * @param {BillboardGraphics.ConstructorOptions} [options] Object describing initialization options
 *
 * @demo {@link https://sandcastle.cesium.com/index.html?id=billboards|Cesium Sandcastle Billboard Demo}
 */
class BillboardGraphics {
  constructor(options) {
    this._definitionChanged = new Event();
    this._show = undefined;
    this._showSubscription = undefined;
    this._image = undefined;
    this._imageSubscription = undefined;
    this._scale = undefined;
    this._scaleSubscription = undefined;
    this._pixelOffset = undefined;
    this._pixelOffsetSubscription = undefined;
    this._eyeOffset = undefined;
    this._eyeOffsetSubscription = undefined;
    this._horizontalOrigin = undefined;
    this._horizontalOriginSubscription = undefined;
    this._verticalOrigin = undefined;
    this._verticalOriginSubscription = undefined;
    this._heightReference = undefined;
    this._heightReferenceSubscription = undefined;
    this._color = undefined;
    this._colorSubscription = undefined;
    this._rotation = undefined;
    this._rotationSubscription = undefined;
    this._alignedAxis = undefined;
    this._alignedAxisSubscription = undefined;
    this._sizeInMeters = undefined;
    this._sizeInMetersSubscription = undefined;
    this._width = undefined;
    this._widthSubscription = undefined;
    this._height = undefined;
    this._heightSubscription = undefined;
    this._scaleByDistance = undefined;
    this._scaleByDistanceSubscription = undefined;
    this._translucencyByDistance = undefined;
    this._translucencyByDistanceSubscription = undefined;
    this._pixelOffsetScaleByDistance = undefined;
    this._pixelOffsetScaleByDistanceSubscription = undefined;
    this._imageSubRegion = undefined;
    this._imageSubRegionSubscription = undefined;
    this._distanceDisplayCondition = undefined;
    this._distanceDisplayConditionSubscription = undefined;
    this._disableDepthTestDistance = undefined;
    this._disableDepthTestDistanceSubscription = undefined;
    this._splitDirection = undefined;
    this._splitDirectionSubscription = undefined;

    this.merge(options ?? Frozen.EMPTY_OBJECT);
  }

  /**
   * Duplicates this instance.
   *
   * @param {BillboardGraphics} [result] The object onto which to store the result.
   * @returns {BillboardGraphics} The modified result parameter or a new instance if one was not provided.
   */
  clone(result) {
    if (!defined(result)) {
      return new BillboardGraphics(this);
    }
    result.show = this._show;
    result.image = this._image;
    result.scale = this._scale;
    result.pixelOffset = this._pixelOffset;
    result.eyeOffset = this._eyeOffset;
    result.horizontalOrigin = this._horizontalOrigin;
    result.verticalOrigin = this._verticalOrigin;
    result.heightReference = this._heightReference;
    result.color = this._color;
    result.rotation = this._rotation;
    result.alignedAxis = this._alignedAxis;
    result.sizeInMeters = this._sizeInMeters;
    result.width = this._width;
    result.height = this._height;
    result.scaleByDistance = this._scaleByDistance;
    result.translucencyByDistance = this._translucencyByDistance;
    result.pixelOffsetScaleByDistance = this._pixelOffsetScaleByDistance;
    result.imageSubRegion = this._imageSubRegion;
    result.distanceDisplayCondition = this._distanceDisplayCondition;
    result.disableDepthTestDistance = this._disableDepthTestDistance;
    result.splitDirection = this._splitDirection;
    return result;
  }

  /**
   * Assigns each unassigned property on this object to the value
   * of the same property on the provided source object.
   *
   * @param {BillboardGraphics} source The object to be merged into this object.
   */
  merge(source) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(source)) {
      throw new DeveloperError("source is required.");
    }
    //>>includeEnd('debug');

    this.show = this._show ?? source.show;
    this.image = this._image ?? source.image;
    this.scale = this._scale ?? source.scale;
    this.pixelOffset = this._pixelOffset ?? source.pixelOffset;
    this.eyeOffset = this._eyeOffset ?? source.eyeOffset;
    this.horizontalOrigin = this._horizontalOrigin ?? source.horizontalOrigin;
    this.verticalOrigin = this._verticalOrigin ?? source.verticalOrigin;
    this.heightReference = this._heightReference ?? source.heightReference;
    this.color = this._color ?? source.color;
    this.rotation = this._rotation ?? source.rotation;
    this.alignedAxis = this._alignedAxis ?? source.alignedAxis;
    this.sizeInMeters = this._sizeInMeters ?? source.sizeInMeters;
    this.width = this._width ?? source.width;
    this.height = this._height ?? source.height;
    this.scaleByDistance = this._scaleByDistance ?? source.scaleByDistance;
    this.translucencyByDistance =
      this._translucencyByDistance ?? source.translucencyByDistance;
    this.pixelOffsetScaleByDistance =
      this._pixelOffsetScaleByDistance ?? source.pixelOffsetScaleByDistance;
    this.imageSubRegion = this._imageSubRegion ?? source.imageSubRegion;
    this.distanceDisplayCondition =
      this._distanceDisplayCondition ?? source.distanceDisplayCondition;
    this.disableDepthTestDistance =
      this._disableDepthTestDistance ?? source.disableDepthTestDistance;
    this.splitDirection = this.splitDirection ?? source.splitDirection;
  }

  /**
   * Gets the event that is raised whenever a property or sub-property is changed or modified.
   * @memberof BillboardGraphics.prototype
   *
   * @type {Event}
   * @readonly
   */
  get definitionChanged() {
    return this._definitionChanged;
  }
}

export default BillboardGraphics;
