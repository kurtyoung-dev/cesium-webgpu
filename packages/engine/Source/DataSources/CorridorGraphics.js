import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Event from "../Core/Event.js";
import createMaterialPropertyDescriptor from "./createMaterialPropertyDescriptor.js";
import createPropertyDescriptor from "./createPropertyDescriptor.js";

/**
 * @typedef {object} CorridorGraphics.ConstructorOptions
 *
 * Initialization options for the CorridorGraphics constructor
 *
 * @property {Property | boolean} [show=true] A boolean Property specifying the visibility of the corridor.
 * @property {Property | Cartesian3[]} [positions] A Property specifying the array of {@link Cartesian3} positions that define the centerline of the corridor.
 * @property {Property | number} [width] A numeric Property specifying the distance between the edges of the corridor.
 * @property {Property | number} [height=0] A numeric Property specifying the altitude of the corridor relative to the ellipsoid surface.
 * @property {Property | HeightReference} [heightReference=HeightReference.NONE] A Property specifying what the height is relative to.
 * @property {Property | number} [extrudedHeight] A numeric Property specifying the altitude of the corridor's extruded face relative to the ellipsoid surface.
 * @property {Property | HeightReference} [extrudedHeightReference=HeightReference.NONE] A Property specifying what the extrudedHeight is relative to.
 * @property {Property | CornerType} [cornerType=CornerType.ROUNDED] A {@link CornerType} Property specifying the style of the corners.
 * @property {Property | number} [granularity=Cesium.Math.RADIANS_PER_DEGREE] A numeric Property specifying the distance between each latitude and longitude.
 * @property {Property | boolean} [fill=true] A boolean Property specifying whether the corridor is filled with the provided material.
 * @property {MaterialProperty | Color} [material=Color.WHITE] A Property specifying the material used to fill the corridor.
 * @property {Property | boolean} [outline=false] A boolean Property specifying whether the corridor is outlined.
 * @property {Property | Color} [outlineColor=Color.BLACK] A Property specifying the {@link Color} of the outline.
 * @property {Property | number} [outlineWidth=1.0] A numeric Property specifying the width of the outline.
 * @property {Property | ShadowMode} [shadows=ShadowMode.DISABLED] An enum Property specifying whether the corridor casts or receives shadows from light sources.
 * @property {Property | DistanceDisplayCondition} [distanceDisplayCondition] A Property specifying at what distance from the camera that this corridor will be displayed.
 * @property {Property | ClassificationType} [classificationType=ClassificationType.BOTH] An enum Property specifying whether this corridor will classify terrain, 3D Tiles, or both when on the ground.
 * @property {ConstantProperty | number} [zIndex] A Property specifying the zIndex of the corridor, used for ordering.  Only has an effect if height and extrudedHeight are undefined, and if the corridor is static.
 */

/**
 * Describes a corridor, which is a shape defined by a centerline and width that
 * conforms to the curvature of the globe. It can be placed on the surface or at altitude
 * and can optionally be extruded into a volume.
 *
 * @alias CorridorGraphics
 * @constructor
 *
 * @param {CorridorGraphics.ConstructorOptions} [options] Object describing initialization options
 *
 * @see Entity
 * @demo {@link https://sandcastle.cesium.com/index.html?id=corridor|Cesium Sandcastle Corridor Demo}
 */
class CorridorGraphics {
  constructor(options) {
    this._definitionChanged = new Event();
    this._show = undefined;
    this._showSubscription = undefined;
    this._positions = undefined;
    this._positionsSubscription = undefined;
    this._width = undefined;
    this._widthSubscription = undefined;
    this._height = undefined;
    this._heightSubscription = undefined;
    this._heightReference = undefined;
    this._heightReferenceSubscription = undefined;
    this._extrudedHeight = undefined;
    this._extrudedHeightSubscription = undefined;
    this._extrudedHeightReference = undefined;
    this._extrudedHeightReferenceSubscription = undefined;
    this._cornerType = undefined;
    this._cornerTypeSubscription = undefined;
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
    this._classificationType = undefined;
    this._classificationTypeSubscription = undefined;
    this._zIndex = undefined;
    this._zIndexSubscription = undefined;

    this.merge(options ?? Frozen.EMPTY_OBJECT);
  }

  /**
   * Duplicates this instance.
   *
   * @param {CorridorGraphics} [result] The object onto which to store the result.
   * @returns {CorridorGraphics} The modified result parameter or a new instance if one was not provided.
   */
  clone(result) {
    if (!defined(result)) {
      return new CorridorGraphics(this);
    }
    result.show = this.show;
    result.positions = this.positions;
    result.width = this.width;
    result.height = this.height;
    result.heightReference = this.heightReference;
    result.extrudedHeight = this.extrudedHeight;
    result.extrudedHeightReference = this.extrudedHeightReference;
    result.cornerType = this.cornerType;
    result.granularity = this.granularity;
    result.fill = this.fill;
    result.material = this.material;
    result.outline = this.outline;
    result.outlineColor = this.outlineColor;
    result.outlineWidth = this.outlineWidth;
    result.shadows = this.shadows;
    result.distanceDisplayCondition = this.distanceDisplayCondition;
    result.classificationType = this.classificationType;
    result.zIndex = this.zIndex;
    return result;
  }

  /**
   * Assigns each unassigned property on this object to the value
   * of the same property on the provided source object.
   *
   * @param {CorridorGraphics} source The object to be merged into this object.
   */
  merge(source) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(source)) {
      throw new DeveloperError("source is required.");
    }
    //>>includeEnd('debug');

    this.show = this.show ?? source.show;
    this.positions = this.positions ?? source.positions;
    this.width = this.width ?? source.width;
    this.height = this.height ?? source.height;
    this.heightReference = this.heightReference ?? source.heightReference;
    this.extrudedHeight = this.extrudedHeight ?? source.extrudedHeight;
    this.extrudedHeightReference =
      this.extrudedHeightReference ?? source.extrudedHeightReference;
    this.cornerType = this.cornerType ?? source.cornerType;
    this.granularity = this.granularity ?? source.granularity;
    this.fill = this.fill ?? source.fill;
    this.material = this.material ?? source.material;
    this.outline = this.outline ?? source.outline;
    this.outlineColor = this.outlineColor ?? source.outlineColor;
    this.outlineWidth = this.outlineWidth ?? source.outlineWidth;
    this.shadows = this.shadows ?? source.shadows;
    this.distanceDisplayCondition =
      this.distanceDisplayCondition ?? source.distanceDisplayCondition;
    this.classificationType =
      this.classificationType ?? source.classificationType;
    this.zIndex = this.zIndex ?? source.zIndex;
  }

  /**
   * Gets the event that is raised whenever a property or sub-property is changed or modified.
   * @memberof CorridorGraphics.prototype
   * @type {Event}
   * @readonly
   */
  get definitionChanged() {
    return this._definitionChanged;
  }
}

export default CorridorGraphics;
