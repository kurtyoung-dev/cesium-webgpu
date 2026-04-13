import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Event from "../Core/Event.js";
import createPropertyDescriptor from "./createPropertyDescriptor.js";

/**
 * @typedef {object} LabelGraphics.ConstructorOptions
 *
 * Initialization options for the LabelGraphics constructor
 *
 * @property {Property | boolean} [show=true] A boolean Property specifying the visibility of the label.
 * @property {Property | string} [text] A Property specifying the text. Explicit newlines '\n' are supported.
 * @property {Property | string} [font='30px sans-serif'] A Property specifying the CSS font.
 * @property {Property | LabelStyle} [style=LabelStyle.FILL] A Property specifying the {@link LabelStyle}.
 * @property {Property | number} [scale=1.0] A numeric Property specifying the scale to apply to the text.
 * @property {Property | boolean} [showBackground=false] A boolean Property specifying the visibility of the background behind the label.
 * @property {Property | Color} [backgroundColor=new Color(0.165, 0.165, 0.165, 0.8)] A Property specifying the background {@link Color}.
 * @property {Property | Cartesian2} [backgroundPadding=new Cartesian2(7, 5)] A {@link Cartesian2} Property specifying the horizontal and vertical background padding in pixels.
 * @property {Property | Cartesian2} [pixelOffset=Cartesian2.ZERO] A {@link Cartesian2} Property specifying the pixel offset.
 * @property {Property | Cartesian3} [eyeOffset=Cartesian3.ZERO] A {@link Cartesian3} Property specifying the eye offset.
 * @property {Property | HorizontalOrigin} [horizontalOrigin=HorizontalOrigin.CENTER] A Property specifying the {@link HorizontalOrigin}.
 * @property {Property | VerticalOrigin} [verticalOrigin=VerticalOrigin.CENTER] A Property specifying the {@link VerticalOrigin}.
 * @property {Property | HeightReference} [heightReference=HeightReference.NONE] A Property specifying what the height is relative to.
 * @property {Property | Color} [fillColor=Color.WHITE] A Property specifying the fill {@link Color}.
 * @property {Property | Color} [outlineColor=Color.BLACK] A Property specifying the outline {@link Color}.
 * @property {Property | number} [outlineWidth=1.0] A numeric Property specifying the outline width.
 * @property {Property | NearFarScalar} [translucencyByDistance] A {@link NearFarScalar} Property used to set translucency based on distance from the camera.
 * @property {Property | NearFarScalar} [pixelOffsetScaleByDistance] A {@link NearFarScalar} Property used to set pixelOffset based on distance from the camera.
 * @property {Property | NearFarScalar} [scaleByDistance] A {@link NearFarScalar} Property used to set scale based on distance from the camera.
 * @property {Property | DistanceDisplayCondition} [distanceDisplayCondition] A Property specifying at what distance from the camera that this label will be displayed.
 * @property {Property | number} [disableDepthTestDistance] A Property specifying the distance from the camera at which to disable the depth test to.
 */

/**
 * Describes a two dimensional label located at the position of the containing {@link Entity}.
 * <p>
 * <div align='center'>
 * <img src='Images/Label.png' width='400' height='300' /><br />
 * Example labels
 * </div>
 * </p>
 *
 * @alias LabelGraphics
 * @constructor
 *
 * @param {LabelGraphics.ConstructorOptions} [options] Object describing initialization options
 *
 * @demo {@link https://sandcastle.cesium.com/index.html?id=labels|Cesium Sandcastle Labels Demo}
 */
class LabelGraphics {
  constructor(options) {
    this._definitionChanged = new Event();
    this._show = undefined;
    this._showSubscription = undefined;
    this._text = undefined;
    this._textSubscription = undefined;
    this._font = undefined;
    this._fontSubscription = undefined;
    this._style = undefined;
    this._styleSubscription = undefined;
    this._scale = undefined;
    this._scaleSubscription = undefined;
    this._showBackground = undefined;
    this._showBackgroundSubscription = undefined;
    this._backgroundColor = undefined;
    this._backgroundColorSubscription = undefined;
    this._backgroundPadding = undefined;
    this._backgroundPaddingSubscription = undefined;
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
    this._fillColor = undefined;
    this._fillColorSubscription = undefined;
    this._outlineColor = undefined;
    this._outlineColorSubscription = undefined;
    this._outlineWidth = undefined;
    this._outlineWidthSubscription = undefined;
    this._translucencyByDistance = undefined;
    this._translucencyByDistanceSubscription = undefined;
    this._pixelOffsetScaleByDistance = undefined;
    this._pixelOffsetScaleByDistanceSubscription = undefined;
    this._scaleByDistance = undefined;
    this._scaleByDistanceSubscription = undefined;
    this._distanceDisplayCondition = undefined;
    this._distanceDisplayConditionSubscription = undefined;
    this._disableDepthTestDistance = undefined;
    this._disableDepthTestDistanceSubscription = undefined;

    this.merge(options ?? Frozen.EMPTY_OBJECT);
  }

  /**
   * Duplicates this instance.
   *
   * @param {LabelGraphics} [result] The object onto which to store the result.
   * @returns {LabelGraphics} The modified result parameter or a new instance if one was not provided.
   */
  clone(result) {
    if (!defined(result)) {
      return new LabelGraphics(this);
    }
    result.show = this.show;
    result.text = this.text;
    result.font = this.font;
    result.style = this.style;
    result.scale = this.scale;
    result.showBackground = this.showBackground;
    result.backgroundColor = this.backgroundColor;
    result.backgroundPadding = this.backgroundPadding;
    result.pixelOffset = this.pixelOffset;
    result.eyeOffset = this.eyeOffset;
    result.horizontalOrigin = this.horizontalOrigin;
    result.verticalOrigin = this.verticalOrigin;
    result.heightReference = this.heightReference;
    result.fillColor = this.fillColor;
    result.outlineColor = this.outlineColor;
    result.outlineWidth = this.outlineWidth;
    result.translucencyByDistance = this.translucencyByDistance;
    result.pixelOffsetScaleByDistance = this.pixelOffsetScaleByDistance;
    result.scaleByDistance = this.scaleByDistance;
    result.distanceDisplayCondition = this.distanceDisplayCondition;
    result.disableDepthTestDistance = this.disableDepthTestDistance;
    return result;
  }

  /**
   * Assigns each unassigned property on this object to the value
   * of the same property on the provided source object.
   *
   * @param {LabelGraphics} source The object to be merged into this object.
   */
  merge(source) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(source)) {
      throw new DeveloperError("source is required.");
    }
    //>>includeEnd('debug');

    this.show = this.show ?? source.show;
    this.text = this.text ?? source.text;
    this.font = this.font ?? source.font;
    this.style = this.style ?? source.style;
    this.scale = this.scale ?? source.scale;
    this.showBackground = this.showBackground ?? source.showBackground;
    this.backgroundColor = this.backgroundColor ?? source.backgroundColor;
    this.backgroundPadding = this.backgroundPadding ?? source.backgroundPadding;
    this.pixelOffset = this.pixelOffset ?? source.pixelOffset;
    this.eyeOffset = this.eyeOffset ?? source.eyeOffset;
    this.horizontalOrigin = this.horizontalOrigin ?? source.horizontalOrigin;
    this.verticalOrigin = this.verticalOrigin ?? source.verticalOrigin;
    this.heightReference = this.heightReference ?? source.heightReference;
    this.fillColor = this.fillColor ?? source.fillColor;
    this.outlineColor = this.outlineColor ?? source.outlineColor;
    this.outlineWidth = this.outlineWidth ?? source.outlineWidth;
    this.translucencyByDistance =
      this.translucencyByDistance ?? source.translucencyByDistance;
    this.pixelOffsetScaleByDistance =
      this.pixelOffsetScaleByDistance ?? source.pixelOffsetScaleByDistance;
    this.scaleByDistance = this.scaleByDistance ?? source.scaleByDistance;
    this.distanceDisplayCondition =
      this.distanceDisplayCondition ?? source.distanceDisplayCondition;
    this.disableDepthTestDistance =
      this.disableDepthTestDistance ?? source.disableDepthTestDistance;
  }

  /**
   * Gets the event that is raised whenever a property or sub-property is changed or modified.
   * @memberof LabelGraphics.prototype
   *
   * @type {Event}
   * @readonly
   */
  get definitionChanged() {
    return this._definitionChanged;
  }
}

export default LabelGraphics;
