import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Event from "../Core/Event.js";
import createMaterialPropertyDescriptor from "./createMaterialPropertyDescriptor.js";
import createPropertyDescriptor from "./createPropertyDescriptor.js";

/**
 * @typedef {object} WallGraphics.ConstructorOptions
 *
 * Initialization options for the WallGraphics constructor
 *
 * @property {Property | boolean} [show=true] A boolean Property specifying the visibility of the wall.
 * @property {Property | Cartesian3[]} [positions] A Property specifying the array of {@link Cartesian3} positions which define the top of the wall.
 * @property {Property | number[]} [minimumHeights] A Property specifying an array of heights to be used for the bottom of the wall instead of the globe surface.
 * @property {Property | number[]} [maximumHeights] A Property specifying an array of heights to be used for the top of the wall instead of the height of each position.
 * @property {Property | number} [granularity=Cesium.Math.RADIANS_PER_DEGREE] A numeric Property specifying the angular distance between each latitude and longitude point.
 * @property {Property | boolean} [fill=true] A boolean Property specifying whether the wall is filled with the provided material.
 * @property {MaterialProperty | Color} [material=Color.WHITE] A Property specifying the material used to fill the wall.
 * @property {Property | boolean} [outline=false] A boolean Property specifying whether the wall is outlined.
 * @property {Property | Color} [outlineColor=Color.BLACK] A Property specifying the {@link Color} of the outline.
 * @property {Property | number} [outlineWidth=1.0] A numeric Property specifying the width of the outline.
 * @property {Property | ShadowMode} [shadows=ShadowMode.DISABLED] An enum Property specifying whether the wall casts or receives shadows from light sources.
 * @property {Property | DistanceDisplayCondition} [distanceDisplayCondition] A Property specifying at what distance from the camera that this wall will be displayed.
 */

/**
 * Describes a two dimensional wall defined as a line strip and optional maximum and minimum heights.
 * The wall conforms to the curvature of the globe and can be placed along the surface or at altitude.
 *
 * @alias WallGraphics
 * @constructor
 *
 * @param {WallGraphics.ConstructorOptions} [options] Object describing initialization options
 *
 * @see Entity
 * @demo {@link https://sandcastle.cesium.com/index.html?id=wall|Cesium Sandcastle Wall Demo}
 */
class WallGraphics {
  constructor(options) {
    this._definitionChanged = new Event();
    this._show = undefined;
    this._showSubscription = undefined;
    this._positions = undefined;
    this._positionsSubscription = undefined;
    this._minimumHeights = undefined;
    this._minimumHeightsSubscription = undefined;
    this._maximumHeights = undefined;
    this._maximumHeightsSubscription = undefined;
    this._granularity = undefined;
    this._granularitySubscription = undefined;
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
   * @param {WallGraphics} [result] The object onto which to store the result.
   * @returns {WallGraphics} The modified result parameter or a new instance if one was not provided.
   */
  clone(result) {
    if (!defined(result)) {
      return new WallGraphics(this);
    }
    result.show = this.show;
    result.positions = this.positions;
    result.minimumHeights = this.minimumHeights;
    result.maximumHeights = this.maximumHeights;
    result.granularity = this.granularity;
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
   * @param {WallGraphics} source The object to be merged into this object.
   */
  merge(source) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(source)) {
      throw new DeveloperError("source is required.");
    }
    //>>includeEnd('debug');

    this.show = this.show ?? source.show;
    this.positions = this.positions ?? source.positions;
    this.minimumHeights = this.minimumHeights ?? source.minimumHeights;
    this.maximumHeights = this.maximumHeights ?? source.maximumHeights;
    this.granularity = this.granularity ?? source.granularity;
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
   * @memberof WallGraphics.prototype
   *
   * @type {Event}
   * @readonly
   */
  get definitionChanged() {
    return this._definitionChanged;
  }
}

export default WallGraphics;
