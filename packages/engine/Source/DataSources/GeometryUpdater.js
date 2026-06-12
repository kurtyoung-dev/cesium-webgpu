import Check from "../Core/Check.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import DistanceDisplayCondition from "../Core/DistanceDisplayCondition.js";
import Event from "../Core/Event.js";
import Iso8601 from "../Core/Iso8601.js";
import oneTimeWarning from "../Core/oneTimeWarning.js";
import ClassificationType from "../Scene/ClassificationType.js";
import ShadowMode from "../Scene/ShadowMode.js";
import ColorMaterialProperty from "./ColorMaterialProperty.js";
import ConstantProperty from "./ConstantProperty.js";
import Entity from "./Entity.js";
import Property from "./Property.js";

const defaultMaterial = new ColorMaterialProperty(Color.WHITE);
const defaultShow = new ConstantProperty(true);
const defaultFill = new ConstantProperty(true);
const defaultOutline = new ConstantProperty(false);
const defaultOutlineColor = new ConstantProperty(Color.BLACK);
const defaultShadows = new ConstantProperty(ShadowMode.DISABLED);
const defaultDistanceDisplayCondition = new ConstantProperty(
  new DistanceDisplayCondition(),
);
const defaultClassificationType = new ConstantProperty(ClassificationType.BOTH);

/**
 * An abstract class for updating geometry entities.
 * @alias GeometryUpdater
 * @constructor
 *
 * @param {object} options An object with the following properties:
 * @param {Entity} options.entity The entity containing the geometry to be visualized.
 * @param {Scene} options.scene The scene where visualization is taking place.
 * @param {object} options.geometryOptions Options for the geometry
 * @param {string} options.geometryPropertyName The geometry property name
 * @param {string[]} options.observedPropertyNames The entity properties this geometry cares about
 */
class GeometryUpdater {
  constructor(options) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("options.entity", options.entity);
    Check.defined("options.scene", options.scene);
    Check.defined("options.geometryOptions", options.geometryOptions);
    Check.defined("options.geometryPropertyName", options.geometryPropertyName);
    Check.defined(
      "options.observedPropertyNames",
      options.observedPropertyNames,
    );
    //>>includeEnd('debug');

    const entity = options.entity;
    const geometryPropertyName = options.geometryPropertyName;

    this._entity = entity;
    this._scene = options.scene;
    this._fillEnabled = false;
    this._isClosed = false;
    this._onTerrain = false;
    this._dynamic = false;
    this._outlineEnabled = false;
    this._geometryChanged = new Event();
    this._showProperty = undefined;
    this._materialProperty = undefined;
    this._showOutlineProperty = undefined;
    this._outlineColorProperty = undefined;
    this._outlineWidth = 1.0;
    this._shadowsProperty = undefined;
    this._distanceDisplayConditionProperty = undefined;
    this._classificationTypeProperty = undefined;
    this._options = options.geometryOptions;
    this._geometryPropertyName = geometryPropertyName;
    this._id = `${geometryPropertyName}-${entity.id}`;
    this._observedPropertyNames = options.observedPropertyNames;
    this._supportsMaterialsforEntitiesOnTerrain =
      Entity.supportsMaterialsforEntitiesOnTerrain(options.scene);
  }

  /**
   * Checks if the geometry is outlined at the provided time.
   *
   * @param {JulianDate} time The time for which to retrieve visibility.
   * @returns {boolean} true if geometry is outlined at the provided time, false otherwise.
   */
  isOutlineVisible(time) {
    const entity = this._entity;
    const visible =
      this._outlineEnabled &&
      entity.isAvailable(time) &&
      this._showProperty.getValue(time) &&
      this._showOutlineProperty.getValue(time);
    return visible ?? false;
  }

  /**
   * Checks if the geometry is filled at the provided time.
   *
   * @param {JulianDate} time The time for which to retrieve visibility.
   * @returns {boolean} true if geometry is filled at the provided time, false otherwise.
   */
  isFilled(time) {
    const entity = this._entity;
    const visible =
      this._fillEnabled &&
      entity.isAvailable(time) &&
      this._showProperty.getValue(time) &&
      this._fillProperty.getValue(time);
    return visible ?? false;
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   *
   * @returns {boolean} True if this object was destroyed; otherwise, false.
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys and resources used by the object.  Once an object is destroyed, it should not be used.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   */
  destroy() {
    destroyObject(this);
  }

  /**
   * @param {Entity} entity
   * @param {object} geometry
   * @private
   */
  _isHidden(entity, geometry) {
    const show = geometry.show;
    return (
      defined(show) && show.isConstant && !show.getValue(Iso8601.MINIMUM_VALUE)
    );
  }

  /**
   * @param {Entity} entity
   * @param {object} geometry
   * @private
   */
  _isOnTerrain(entity, geometry) {
    return false;
  }

  /**
   * @param {GeometryOptions} options
   * @private
   */
  _getIsClosed(options) {
    return true;
  }

  /**
   * @param {Entity} entity
   * @param {string} propertyName
   * @param {*} newValue
   * @param {*} oldValue
   * @private
   */
  _onEntityPropertyChanged(entity, propertyName, newValue, oldValue) {
    if (!this._observedPropertyNames.includes(propertyName)) {
      return;
    }

    const geometry = this._entity[this._geometryPropertyName];

    if (!defined(geometry)) {
      if (this._fillEnabled || this._outlineEnabled) {
        this._fillEnabled = false;
        this._outlineEnabled = false;
        this._geometryChanged.raiseEvent(this);
      }
      return;
    }

    const fillProperty = geometry.fill;
    const fillEnabled =
      defined(fillProperty) && fillProperty.isConstant
        ? fillProperty.getValue(Iso8601.MINIMUM_VALUE)
        : true;

    const outlineProperty = geometry.outline;
    let outlineEnabled = defined(outlineProperty);
    if (outlineEnabled && outlineProperty.isConstant) {
      outlineEnabled = outlineProperty.getValue(Iso8601.MINIMUM_VALUE);
    }

    if (!fillEnabled && !outlineEnabled) {
      if (this._fillEnabled || this._outlineEnabled) {
        this._fillEnabled = false;
        this._outlineEnabled = false;
        this._geometryChanged.raiseEvent(this);
      }
      return;
    }

    const show = geometry.show;
    if (this._isHidden(entity, geometry)) {
      if (this._fillEnabled || this._outlineEnabled) {
        this._fillEnabled = false;
        this._outlineEnabled = false;
        this._geometryChanged.raiseEvent(this);
      }
      return;
    }

    this._materialProperty = geometry.material ?? defaultMaterial;
    this._fillProperty = fillProperty ?? defaultFill;
    this._showProperty = show ?? defaultShow;
    this._showOutlineProperty = geometry.outline ?? defaultOutline;
    this._outlineColorProperty = outlineEnabled
      ? (geometry.outlineColor ?? defaultOutlineColor)
      : undefined;
    this._shadowsProperty = geometry.shadows ?? defaultShadows;
    this._distanceDisplayConditionProperty =
      geometry.distanceDisplayCondition ?? defaultDistanceDisplayCondition;
    this._classificationTypeProperty =
      geometry.classificationType ?? defaultClassificationType;

    this._fillEnabled = fillEnabled;

    const onTerrain =
      this._isOnTerrain(entity, geometry) &&
      (this._supportsMaterialsforEntitiesOnTerrain ||
        this._materialProperty instanceof ColorMaterialProperty);

    if (outlineEnabled && onTerrain) {
      oneTimeWarning(oneTimeWarning.geometryOutlines);
      outlineEnabled = false;
    }

    this._onTerrain = onTerrain;
    this._outlineEnabled = outlineEnabled;

    if (this._isDynamic(entity, geometry)) {
      if (!this._dynamic) {
        this._dynamic = true;
        this._geometryChanged.raiseEvent(this);
      }
    } else {
      this._setStaticOptions(entity, geometry);
      this._isClosed = this._getIsClosed(this._options);
      const outlineWidth = geometry.outlineWidth;
      this._outlineWidth = defined(outlineWidth)
        ? outlineWidth.getValue(Iso8601.MINIMUM_VALUE)
        : 1.0;
      this._dynamic = false;
      this._geometryChanged.raiseEvent(this);
    }
  }

  /**
   * Creates the dynamic updater to be used when GeometryUpdater#isDynamic is true.
   *
   * @param {PrimitiveCollection} primitives The primitive collection to use.
   * @param {PrimitiveCollection} [groundPrimitives] The primitive collection to use for ground primitives.
   *
   * @returns {DynamicGeometryUpdater} The dynamic updater used to update the geometry each frame.
   *
   * @exception {DeveloperError} This instance does not represent dynamic geometry.
   * @private
   */
  createDynamicUpdater(primitives, groundPrimitives) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("primitives", primitives);
    Check.defined("groundPrimitives", groundPrimitives);

    if (!this._dynamic) {
      throw new DeveloperError(
        "This instance does not represent dynamic geometry.",
      );
    }
    //>>includeEnd('debug');

    return new this.constructor.DynamicGeometryUpdater(
      this,
      primitives,
      groundPrimitives,
    );
  }

  /**
   * Gets the unique ID associated with this updater
   * @type {string}
   * @readonly
   */
  get id() {
    return this._id;
  }

  /**
   * Gets the entity associated with this geometry.
   *
   * @type {Entity}
   * @readonly
   */
  get entity() {
    return this._entity;
  }

  /**
   * Gets a value indicating if the geometry has a fill component.
   *
   * @type {boolean}
   * @readonly
   */
  get fillEnabled() {
    return this._fillEnabled;
  }

  /**
   * Gets a value indicating if fill visibility varies with simulation time.
   *
   * @type {boolean}
   * @readonly
   */
  get hasConstantFill() {
    return (
      !this._fillEnabled ||
      (!defined(this._entity.availability) &&
        Property.isConstant(this._showProperty) &&
        Property.isConstant(this._fillProperty))
    );
  }

  /**
   * Gets the material property used to fill the geometry.
   *
   * @type {MaterialProperty}
   * @readonly
   */
  get fillMaterialProperty() {
    return this._materialProperty;
  }

  /**
   * Gets a value indicating if the geometry has an outline component.
   *
   * @type {boolean}
   * @readonly
   */
  get outlineEnabled() {
    return this._outlineEnabled;
  }

  /**
   * Gets a value indicating if the geometry has an outline component.
   *
   * @type {boolean}
   * @readonly
   */
  get hasConstantOutline() {
    return (
      !this._outlineEnabled ||
      (!defined(this._entity.availability) &&
        Property.isConstant(this._showProperty) &&
        Property.isConstant(this._showOutlineProperty))
    );
  }

  /**
   * Gets the {@link Color} property for the geometry outline.
   *
   * @type {Property}
   * @readonly
   */
  get outlineColorProperty() {
    return this._outlineColorProperty;
  }

  /**
   * Gets the constant with of the geometry outline, in pixels.
   * This value is only valid if isDynamic is false.
   *
   * @type {number}
   * @readonly
   */
  get outlineWidth() {
    return this._outlineWidth;
  }

  /**
   * Gets the property specifying whether the geometry
   * casts or receives shadows from light sources.
   *
   * @type {Property}
   * @readonly
   */
  get shadowsProperty() {
    return this._shadowsProperty;
  }

  /**
   * Gets or sets the {@link DistanceDisplayCondition} Property specifying at what distance from the camera that this geometry will be displayed.
   *
   * @type {Property}
   * @readonly
   */
  get distanceDisplayConditionProperty() {
    return this._distanceDisplayConditionProperty;
  }

  /**
   * Gets or sets the {@link ClassificationType} Property specifying if this geometry will classify terrain, 3D Tiles, or both when on the ground.
   *
   * @type {Property}
   * @readonly
   */
  get classificationTypeProperty() {
    return this._classificationTypeProperty;
  }

  /**
   * Gets a value indicating if the geometry is time-varying.
   *
   *
   * @type {boolean}
   * @readonly
   */
  get isDynamic() {
    return this._dynamic;
  }

  /**
   * Gets a value indicating if the geometry is closed.
   * This property is only valid for static geometry.
   *
   * @type {boolean}
   * @readonly
   */
  get isClosed() {
    return this._isClosed;
  }

  /**
   * Gets a value indicating if the geometry should be drawn on terrain.
   * @memberof EllipseGeometryUpdater.prototype
   *
   * @type {boolean}
   * @readonly
   */
  get onTerrain() {
    return this._onTerrain;
  }

  /**
   * Gets an event that is raised whenever the public properties
   * of this updater change.
   *
   * @type {boolean}
   * @readonly
   */
  get geometryChanged() {
    return this._geometryChanged;
  }
}

/**
 * Creates the geometry instance which represents the fill of the geometry.
 *
 * @function
 * @param {JulianDate} time The time to use when retrieving initial attribute values.
 * @returns {GeometryInstance} The geometry instance representing the filled portion of the geometry.
 *
 * @exception {DeveloperError} This instance does not represent a filled geometry.
 */
GeometryUpdater.prototype.createFillGeometryInstance =
  DeveloperError.throwInstantiationError;

/**
 * Creates the geometry instance which represents the outline of the geometry.
 *
 * @function
 * @param {JulianDate} time The time to use when retrieving initial attribute values.
 * @returns {GeometryInstance} The geometry instance representing the outline portion of the geometry.
 *
 * @exception {DeveloperError} This instance does not represent an outlined geometry.
 */
GeometryUpdater.prototype.createOutlineGeometryInstance =
  DeveloperError.throwInstantiationError;

/**
 * @param {Entity} entity
 * @param {object} geometry
 * @private
 */
GeometryUpdater.prototype._isDynamic = DeveloperError.throwInstantiationError;

/**
 * @param {Entity} entity
 * @param {object} geometry
 * @private
 */
GeometryUpdater.prototype._setStaticOptions =
  DeveloperError.throwInstantiationError;

export default GeometryUpdater;
