import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Event from "../Core/Event.js";
import createMaterialPropertyDescriptor from "./createMaterialPropertyDescriptor.js";
import createPropertyDescriptor from "./createPropertyDescriptor.js";

/**
 * @typedef {object} PlaneGraphics.ConstructorOptions
 *
 * Initialization options for the PlaneGraphics constructor
 *
 * @property {Property | boolean} [show=true] A boolean Property specifying the visibility of the plane.
 * @property {Property | Plane} [plane] A {@link Plane} Property specifying the normal and distance for the plane.
 * @property {Property | Cartesian2} [dimensions] A {@link Cartesian2} Property specifying the width and height of the plane.
 * @property {Property | boolean} [fill=true] A boolean Property specifying whether the plane is filled with the provided material.
 * @property {MaterialProperty | Color} [material=Color.WHITE] A Property specifying the material used to fill the plane.
 * @property {Property | boolean} [outline=false] A boolean Property specifying whether the plane is outlined.
 * @property {Property | Color} [outlineColor=Color.BLACK] A Property specifying the {@link Color} of the outline.
 * @property {Property | number} [outlineWidth=1.0] A numeric Property specifying the width of the outline.
 * @property {Property | ShadowMode} [shadows=ShadowMode.DISABLED] An enum Property specifying whether the plane casts or receives shadows from light sources.
 * @property {Property | DistanceDisplayCondition} [distanceDisplayCondition] A Property specifying at what distance from the camera that this plane will be displayed.
 */

/**
 * Describes a plane. The center position and orientation are determined by the containing {@link Entity}.
 *
 * @alias PlaneGraphics
 * @constructor
 *
 * @param {PlaneGraphics.ConstructorOptions} [options] Object describing initialization options
 *
 * @demo {@link https://sandcastle.cesium.com/index.html?id=plane|Cesium Sandcastle Plane Demo}
 */
class PlaneGraphics {
  constructor(options) {
    this._definitionChanged = new Event();
    this._show = undefined;
    this._showSubscription = undefined;
    this._plane = undefined;
    this._planeSubscription = undefined;
    this._dimensions = undefined;
    this._dimensionsSubscription = undefined;
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
   * @param {PlaneGraphics} [result] The object onto which to store the result.
   * @returns {PlaneGraphics} The modified result parameter or a new instance if one was not provided.
   */
  clone(result) {
    if (!defined(result)) {
      return new PlaneGraphics(this);
    }
    result.show = this.show;
    result.plane = this.plane;
    result.dimensions = this.dimensions;
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
   * @param {PlaneGraphics} source The object to be merged into this object.
   */
  merge(source) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(source)) {
      throw new DeveloperError("source is required.");
    }
    //>>includeEnd('debug');

    this.show = this.show ?? source.show;
    this.plane = this.plane ?? source.plane;
    this.dimensions = this.dimensions ?? source.dimensions;
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
   * @memberof PlaneGraphics.prototype
   * @type {Event}
   * @readonly
   */
  get definitionChanged() {
    return this._definitionChanged;
  }
}

export default PlaneGraphics;
