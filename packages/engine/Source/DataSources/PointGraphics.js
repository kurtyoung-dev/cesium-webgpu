import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Event from "../Core/Event.js";
import createPropertyDescriptor from "./createPropertyDescriptor.js";

/**
 * @typedef {object} PointGraphics.ConstructorOptions
 *
 * Initialization options for the PointGraphics constructor
 *
 * @property {Property | boolean} [show=true] A boolean Property specifying the visibility of the point.
 * @property {Property | number} [pixelSize=1] A numeric Property specifying the size in pixels.
 * @property {Property | HeightReference} [heightReference=HeightReference.NONE] A Property specifying what the height is relative to.
 * @property {Property | Color} [color=Color.WHITE] A Property specifying the {@link Color} of the point.
 * @property {Property | Color} [outlineColor=Color.BLACK] A Property specifying the {@link Color} of the outline.
 * @property {Property | number} [outlineWidth=0] A numeric Property specifying the the outline width in pixels.
 * @property {Property | NearFarScalar} [scaleByDistance] A {@link NearFarScalar} Property used to scale the point based on distance.
 * @property {Property | NearFarScalar} [translucencyByDistance] A {@link NearFarScalar} Property used to set translucency based on distance from the camera.
 * @property {Property | DistanceDisplayCondition} [distanceDisplayCondition] A Property specifying at what distance from the camera that this point will be displayed.
 * @property {Property | number} [disableDepthTestDistance] A Property specifying the distance from the camera at which to disable the depth test to.
 * @property {Property | SplitDirection} [splitDirection] A Property specifying the {@link SplitDirection} split to apply to this point.
 */

/**
 * Describes a graphical point located at the position of the containing {@link Entity}.
 *
 * @alias PointGraphics
 * @constructor
 *
 * @param {PointGraphics.ConstructorOptions} [options] Object describing initialization options
 */
class PointGraphics {
  constructor(options) {
    this._definitionChanged = new Event();
    this._show = undefined;
    this._showSubscription = undefined;
    this._pixelSize = undefined;
    this._pixelSizeSubscription = undefined;
    this._heightReference = undefined;
    this._heightReferenceSubscription = undefined;
    this._color = undefined;
    this._colorSubscription = undefined;
    this._outlineColor = undefined;
    this._outlineColorSubscription = undefined;
    this._outlineWidth = undefined;
    this._outlineWidthSubscription = undefined;
    this._scaleByDistance = undefined;
    this._scaleByDistanceSubscription = undefined;
    this._translucencyByDistance = undefined;
    this._translucencyByDistanceSubscription = undefined;
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
   * @param {PointGraphics} [result] The object onto which to store the result.
   * @returns {PointGraphics} The modified result parameter or a new instance if one was not provided.
   */
  clone(result) {
    if (!defined(result)) {
      return new PointGraphics(this);
    }
    result.show = this.show;
    result.pixelSize = this.pixelSize;
    result.heightReference = this.heightReference;
    result.color = this.color;
    result.outlineColor = this.outlineColor;
    result.outlineWidth = this.outlineWidth;
    result.scaleByDistance = this.scaleByDistance;
    result.translucencyByDistance = this._translucencyByDistance;
    result.distanceDisplayCondition = this.distanceDisplayCondition;
    result.disableDepthTestDistance = this.disableDepthTestDistance;
    result.splitDirection = this.splitDirection;
    return result;
  }

  /**
   * Assigns each unassigned property on this object to the value
   * of the same property on the provided source object.
   *
   * @param {PointGraphics} source The object to be merged into this object.
   */
  merge(source) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(source)) {
      throw new DeveloperError("source is required.");
    }
    //>>includeEnd('debug');

    this.show = this.show ?? source.show;
    this.pixelSize = this.pixelSize ?? source.pixelSize;
    this.heightReference = this.heightReference ?? source.heightReference;
    this.color = this.color ?? source.color;
    this.outlineColor = this.outlineColor ?? source.outlineColor;
    this.outlineWidth = this.outlineWidth ?? source.outlineWidth;
    this.scaleByDistance = this.scaleByDistance ?? source.scaleByDistance;
    this.translucencyByDistance =
      this._translucencyByDistance ?? source.translucencyByDistance;
    this.distanceDisplayCondition =
      this.distanceDisplayCondition ?? source.distanceDisplayCondition;
    this.disableDepthTestDistance =
      this.disableDepthTestDistance ?? source.disableDepthTestDistance;

    this.splitDirection = this.splitDirection ?? source.splitDirection;
  }

  /**
   * Gets the event that is raised whenever a property or sub-property is changed or modified.
   * @memberof PointGraphics.prototype
   *
   * @type {Event}
   * @readonly
   */
  get definitionChanged() {
    return this._definitionChanged;
  }
}

export default PointGraphics;
