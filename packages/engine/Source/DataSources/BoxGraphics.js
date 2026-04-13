import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Event from "../Core/Event.js";
import createMaterialPropertyDescriptor from "./createMaterialPropertyDescriptor.js";
import createPropertyDescriptor from "./createPropertyDescriptor.js";

/**
 * @typedef {object} BoxGraphics.ConstructorOptions
 *
 * Initialization options for the BoxGraphics constructor
 *
 * @property {Property | boolean} [show=true] A boolean Property specifying the visibility of the box.
 * @property {Property | Cartesian3} [dimensions] A {@link Cartesian3} Property specifying the length, width, and height of the box.
 * @property {Property | HeightReference} [heightReference=HeightReference.NONE] A Property specifying what the height from the entity position is relative to.
 * @property {Property | boolean} [fill=true] A boolean Property specifying whether the box is filled with the provided material.
 * @property {MaterialProperty | Color} [material=Color.WHITE] A Property specifying the material used to fill the box.
 * @property {Property | boolean} [outline=false] A boolean Property specifying whether the box is outlined.
 * @property {Property | Color} [outlineColor=Color.BLACK] A Property specifying the {@link Color} of the outline.
 * @property {Property | number} [outlineWidth=1.0] A numeric Property specifying the width of the outline.
 * @property {Property | ShadowMode} [shadows=ShadowMode.DISABLED] An enum Property specifying whether the box casts or receives shadows from light sources.
 * @property {Property | DistanceDisplayCondition} [distanceDisplayCondition] A Property specifying at what distance from the camera that this box will be displayed.
 *
 */

/**
 * Describes a box. The center position and orientation are determined by the containing {@link Entity}.
 *
 * @alias BoxGraphics
 * @constructor
 *
 * @param {BoxGraphics.ConstructorOptions} [options] Object describing initialization options
 *
 * @demo {@link https://sandcastle.cesium.com/index.html?id=box|Cesium Sandcastle Box Demo}
 */
class BoxGraphics {
  constructor(options) {
    this._definitionChanged = new Event();
    this._show = undefined;
    this._showSubscription = undefined;
    this._dimensions = undefined;
    this._dimensionsSubscription = undefined;
    this._heightReference = undefined;
    this._heightReferenceSubscription = undefined;
    this._fill = undefined;
    this._fillSubscription = undefined;
    this._material = undefined;
    this._materialSubscription = undefined;
    this._outline = undefined;
    this._outlineSubscription = undefined;
    this._outlineColor = undefined;
    this._outlineColorSubscription = undefined;
    this._outlineWidth = undefined;
    this._outlineWidthSubscription = undefined;
    this._shadows = undefined;
    this._shadowsSubscription = undefined;
    this._distanceDisplayCondition = undefined;
    this._distanceDisplayConditionSubscription = undefined;

    this.merge(options ?? Frozen.EMPTY_OBJECT);
  }

  /**
   * Duplicates this instance.
   *
   * @param {BoxGraphics} [result] The object onto which to store the result.
   * @returns {BoxGraphics} The modified result parameter or a new instance if one was not provided.
   */
  clone(result) {
    if (!defined(result)) {
      return new BoxGraphics(this);
    }
    result.show = this.show;
    result.dimensions = this.dimensions;
    result.heightReference = this.heightReference;
    result.fill = this.fill;
    result.material = this.material;
    result.outline = this.outline;
    result.outlineColor = this.outlineColor;
    result.outlineWidth = this.outlineWidth;
    result.shadows = this.shadows;
    result.distanceDisplayCondition = this.distanceDisplayCondition;
    return result;
  }

  /**
   * Assigns each unassigned property on this object to the value
   * of the same property on the provided source object.
   *
   * @param {BoxGraphics} source The object to be merged into this object.
   */
  merge(source) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(source)) {
      throw new DeveloperError("source is required.");
    }
    //>>includeEnd('debug');

    this.show = this.show ?? source.show;
    this.dimensions = this.dimensions ?? source.dimensions;
    this.heightReference = this.heightReference ?? source.heightReference;
    this.fill = this.fill ?? source.fill;
    this.material = this.material ?? source.material;
    this.outline = this.outline ?? source.outline;
    this.outlineColor = this.outlineColor ?? source.outlineColor;
    this.outlineWidth = this.outlineWidth ?? source.outlineWidth;
    this.shadows = this.shadows ?? source.shadows;
    this.distanceDisplayCondition =
      this.distanceDisplayCondition ?? source.distanceDisplayCondition;
  }

  /**
   * Gets the event that is raised whenever a property or sub-property is changed or modified.
   * @memberof BoxGraphics.prototype
   * @type {Event}
   * @readonly
   */
  get definitionChanged() {
    return this._definitionChanged;
  }
}

export default BoxGraphics;
