import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Event from "../Core/Event.js";
import PolygonHierarchy from "../Core/PolygonHierarchy.js";
import ConstantProperty from "./ConstantProperty.js";
import createMaterialPropertyDescriptor from "./createMaterialPropertyDescriptor.js";
import createPropertyDescriptor from "./createPropertyDescriptor.js";

function createPolygonHierarchyProperty(value) {
  if (Array.isArray(value)) {
    // convert array of positions to PolygonHierarchy object
    value = new PolygonHierarchy(value);
  }
  return new ConstantProperty(value);
}

/**
 * @typedef {object} PolygonGraphics.ConstructorOptions
 *
 * Initialization options for the PolygonGraphics constructor
 *
 * @property {Property | boolean} [show=true] A boolean Property specifying the visibility of the polygon.
 * @property {Property | PolygonHierarchy | Cartesian3[]} [hierarchy] A Property specifying the {@link PolygonHierarchy}.
 * @property {Property | number} [height=0] A numeric Property specifying the altitude of the polygon relative to the ellipsoid surface.
 * @property {Property | HeightReference} [heightReference=HeightReference.NONE] A Property specifying what the height is relative to.
 * @property {Property | number} [extrudedHeight] A numeric Property specifying the altitude of the polygon's extruded face relative to the ellipsoid surface.
 * @property {Property | HeightReference} [extrudedHeightReference=HeightReference.NONE] A Property specifying what the extrudedHeight is relative to.
 * @property {Property | number} [stRotation=0.0] A numeric property specifying the rotation of the polygon texture counter-clockwise from north. Only has an effect if textureCoordinates is not defined.
 * @property {Property | number} [granularity=Cesium.Math.RADIANS_PER_DEGREE] A numeric Property specifying the angular distance between each latitude and longitude point.
 * @property {Property | boolean} [fill=true] A boolean Property specifying whether the polygon is filled with the provided material.
 * @property {MaterialProperty | Color} [material=Color.WHITE] A Property specifying the material used to fill the polygon.
 * @property {Property | boolean} [outline=false] A boolean Property specifying whether the polygon is outlined.
 * @property {Property | Color} [outlineColor=Color.BLACK] A Property specifying the {@link Color} of the outline.
 * @property {Property | number} [outlineWidth=1.0] A numeric Property specifying the width of the outline.
 * @property {Property | boolean} [perPositionHeight=false] A boolean specifying whether or not the height of each position is used.
 * @property {boolean | boolean} [closeTop=true] When false, leaves off the top of an extruded polygon open.
 * @property {boolean | boolean} [closeBottom=true] When false, leaves off the bottom of an extruded polygon open.
 * @property {Property | ArcType} [arcType=ArcType.GEODESIC] The type of line the polygon edges must follow.
 * @property {Property | ShadowMode} [shadows=ShadowMode.DISABLED] An enum Property specifying whether the polygon casts or receives shadows from light sources.
 * @property {Property | DistanceDisplayCondition} [distanceDisplayCondition] A Property specifying at what distance from the camera that this polygon will be displayed.
 * @property {Property | ClassificationType} [classificationType=ClassificationType.BOTH] An enum Property specifying whether this polygon will classify terrain, 3D Tiles, or both when on the ground.
 * @property {ConstantProperty | number} [zIndex=0] A property specifying the zIndex used for ordering ground geometry.  Only has an effect if the polygon is constant and neither height or extrudedHeight are specified.
 * @property {Property | PolygonHierarchy} [textureCoordinates] A Property specifying texture coordinates as a {@link PolygonHierarchy} of {@link Cartesian2} points. Has no effect for ground primitives.
 */

/**
 * Describes a polygon defined by an hierarchy of linear rings which make up the outer shape and any nested holes.
 * The polygon conforms to the curvature of the globe and can be placed on the surface or
 * at altitude and can optionally be extruded into a volume.
 *
 * @alias PolygonGraphics
 * @constructor
 *
 * @param {PolygonGraphics.ConstructorOptions} [options] Object describing initialization options
 *
 * @see Entity
 * @demo {@link https://sandcastle.cesium.com/index.html?id=polygon|Cesium Sandcastle Polygon Demo}
 */
class PolygonGraphics {
  constructor(options) {
    this._definitionChanged = new Event();
    this._show = undefined;
    this._showSubscription = undefined;
    this._hierarchy = undefined;
    this._hierarchySubscription = undefined;
    this._height = undefined;
    this._heightSubscription = undefined;
    this._heightReference = undefined;
    this._heightReferenceSubscription = undefined;
    this._extrudedHeight = undefined;
    this._extrudedHeightSubscription = undefined;
    this._extrudedHeightReference = undefined;
    this._extrudedHeightReferenceSubscription = undefined;
    this._stRotation = undefined;
    this._stRotationSubscription = undefined;
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
    this._perPositionHeight = undefined;
    this._perPositionHeightSubscription = undefined;
    this._closeTop = undefined;
    this._closeTopSubscription = undefined;
    this._closeBottom = undefined;
    this._closeBottomSubscription = undefined;
    this._arcType = undefined;
    this._arcTypeSubscription = undefined;
    this._shadows = undefined;
    this._shadowsSubscription = undefined;
    this._distanceDisplayCondition = undefined;
    this._distanceDisplayConditionSubscription = undefined;
    this._classificationType = undefined;
    this._classificationTypeSubscription = undefined;
    this._zIndex = undefined;
    this._zIndexSubscription = undefined;
    this._textureCoordinates = undefined;
    this._textureCoordinatesSubscription = undefined;

    this.merge(options ?? Frozen.EMPTY_OBJECT);
  }

  /**
   * Duplicates this instance.
   *
   * @param {PolygonGraphics} [result] The object onto which to store the result.
   * @returns {PolygonGraphics} The modified result parameter or a new instance if one was not provided.
   */
  clone(result) {
    if (!defined(result)) {
      return new PolygonGraphics(this);
    }
    result.show = this.show;
    result.hierarchy = this.hierarchy;
    result.height = this.height;
    result.heightReference = this.heightReference;
    result.extrudedHeight = this.extrudedHeight;
    result.extrudedHeightReference = this.extrudedHeightReference;
    result.stRotation = this.stRotation;
    result.granularity = this.granularity;
    result.fill = this.fill;
    result.material = this.material;
    result.outline = this.outline;
    result.outlineColor = this.outlineColor;
    result.outlineWidth = this.outlineWidth;
    result.perPositionHeight = this.perPositionHeight;
    result.closeTop = this.closeTop;
    result.closeBottom = this.closeBottom;
    result.arcType = this.arcType;
    result.shadows = this.shadows;
    result.distanceDisplayCondition = this.distanceDisplayCondition;
    result.classificationType = this.classificationType;
    result.zIndex = this.zIndex;
    result.textureCoordinates = this.textureCoordinates;
    return result;
  }

  /**
   * Assigns each unassigned property on this object to the value
   * of the same property on the provided source object.
   *
   * @param {PolygonGraphics} source The object to be merged into this object.
   */
  merge(source) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(source)) {
      throw new DeveloperError("source is required.");
    }
    //>>includeEnd('debug');

    this.show = this.show ?? source.show;
    this.hierarchy = this.hierarchy ?? source.hierarchy;
    this.height = this.height ?? source.height;
    this.heightReference = this.heightReference ?? source.heightReference;
    this.extrudedHeight = this.extrudedHeight ?? source.extrudedHeight;
    this.extrudedHeightReference =
      this.extrudedHeightReference ?? source.extrudedHeightReference;
    this.stRotation = this.stRotation ?? source.stRotation;
    this.granularity = this.granularity ?? source.granularity;
    this.fill = this.fill ?? source.fill;
    this.material = this.material ?? source.material;
    this.outline = this.outline ?? source.outline;
    this.outlineColor = this.outlineColor ?? source.outlineColor;
    this.outlineWidth = this.outlineWidth ?? source.outlineWidth;
    this.perPositionHeight = this.perPositionHeight ?? source.perPositionHeight;
    this.closeTop = this.closeTop ?? source.closeTop;
    this.closeBottom = this.closeBottom ?? source.closeBottom;
    this.arcType = this.arcType ?? source.arcType;
    this.shadows = this.shadows ?? source.shadows;
    this.distanceDisplayCondition =
      this.distanceDisplayCondition ?? source.distanceDisplayCondition;
    this.classificationType =
      this.classificationType ?? source.classificationType;
    this.zIndex = this.zIndex ?? source.zIndex;
    this.textureCoordinates =
      this.textureCoordinates ?? source.textureCoordinates;
  }

  /**
   * Gets the event that is raised whenever a property or sub-property is changed or modified.
   * @memberof PolygonGraphics.prototype
   *
   * @type {Event}
   * @readonly
   */
  get definitionChanged() {
    return this._definitionChanged;
  }
}

export default PolygonGraphics;
