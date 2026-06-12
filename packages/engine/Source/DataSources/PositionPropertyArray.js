import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Event from "../Core/Event.js";
import EventHelper from "../Core/EventHelper.js";
import JulianDate from "../Core/JulianDate.js";
import ReferenceFrame from "../Core/ReferenceFrame.js";
import Property from "./Property.js";

/**
 * A {@link Property} whose value is an array whose items are the computed value
 * of other PositionProperty instances.
 *
 * @alias PositionPropertyArray
 * @constructor
 *
 * @param {Property[]} [value] An array of Property instances.
 * @param {ReferenceFrame} [referenceFrame=ReferenceFrame.FIXED] The reference frame in which the position is defined.
 */
class PositionPropertyArray {
  constructor(value, referenceFrame) {
    this._value = undefined;
    this._definitionChanged = new Event();
    this._eventHelper = new EventHelper();
    this._referenceFrame = referenceFrame ?? ReferenceFrame.FIXED;
    this.setValue(value);
  }

  /**
   * Gets the value of the property.
   *
   * @param {JulianDate} [time=JulianDate.now()] The time for which to retrieve the value. If omitted, the current system time is used.
   * @param {Cartesian3[]} [result] The object to store the value into, if omitted, a new instance is created and returned.
   * @returns {Cartesian3[]} The modified result parameter or a new instance if the result parameter was not supplied.
   */
  getValue(time, result) {
    if (!defined(time)) {
      time = JulianDate.now(timeScratch);
    }
    return this.getValueInReferenceFrame(time, ReferenceFrame.FIXED, result);
  }

  /**
   * Gets the value of the property at the provided time and in the provided reference frame.
   *
   * @param {JulianDate} time The time for which to retrieve the value.
   * @param {ReferenceFrame} referenceFrame The desired referenceFrame of the result.
   * @param {Cartesian3[]} [result] The object to store the value into, if omitted, a new instance is created and returned.
   * @returns {Cartesian3[]} The modified result parameter or a new instance if the result parameter was not supplied.
   */
  getValueInReferenceFrame(time, referenceFrame, result) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(time)) {
      throw new DeveloperError("time is required.");
    }
    if (!defined(referenceFrame)) {
      throw new DeveloperError("referenceFrame is required.");
    }
    //>>includeEnd('debug');

    const value = this._value;
    if (!defined(value)) {
      return undefined;
    }

    const length = value.length;
    if (!defined(result)) {
      result = new Array(length);
    }
    let i = 0;
    let x = 0;
    while (i < length) {
      const property = value[i];
      const itemValue = property.getValueInReferenceFrame(
        time,
        referenceFrame,
        result[i],
      );
      if (defined(itemValue)) {
        result[x] = itemValue;
        x++;
      }
      i++;
    }
    result.length = x;
    return result;
  }

  /**
   * Sets the value of the property.
   *
   * @param {Property[]} value An array of Property instances.
   */
  setValue(value) {
    const eventHelper = this._eventHelper;
    eventHelper.removeAll();

    if (defined(value)) {
      this._value = value.slice();
      const length = value.length;
      for (let i = 0; i < length; i++) {
        const property = value[i];
        if (defined(property)) {
          eventHelper.add(
            property.definitionChanged,
            PositionPropertyArray.prototype._raiseDefinitionChanged,
            this,
          );
        }
      }
    } else {
      this._value = undefined;
    }
    this._definitionChanged.raiseEvent(this);
  }

  /**
   * Compares this property to the provided property and returns
   * <code>true</code> if they are equal, <code>false</code> otherwise.
   *
   * @param {Property} [other] The other property.
   * @returns {boolean} <code>true</code> if left and right are equal, <code>false</code> otherwise.
   */
  equals(other) {
    return (
      this === other || //
      (other instanceof PositionPropertyArray && //
        this._referenceFrame === other._referenceFrame && //
        Property.arrayEquals(this._value, other._value))
    );
  }

  _raiseDefinitionChanged() {
    this._definitionChanged.raiseEvent(this);
  }

  /**
   * Gets a value indicating if this property is constant.  This property
   * is considered constant if all property items in the array are constant.
   *
   * @type {boolean}
   * @readonly
   */
  get isConstant() {
    const value = this._value;
    if (!defined(value)) {
      return true;
    }

    const length = value.length;
    for (let i = 0; i < length; i++) {
      if (!Property.isConstant(value[i])) {
        return false;
      }
    }
    return true;
  }

  /**
   * Gets the event that is raised whenever the definition of this property changes.
   * The definition is changed whenever setValue is called with data different
   * than the current value or one of the properties in the array also changes.
   *
   * @type {Event}
   * @readonly
   */
  get definitionChanged() {
    return this._definitionChanged;
  }

  /**
   * Gets the reference frame in which the position is defined.
   * @type {ReferenceFrame}
   * @default ReferenceFrame.FIXED;
   */
  get referenceFrame() {
    return this._referenceFrame;
  }
}

const timeScratch = new JulianDate();

export default PositionPropertyArray;
