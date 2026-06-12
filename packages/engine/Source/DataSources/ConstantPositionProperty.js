import Cartesian3 from "../Core/Cartesian3.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Event from "../Core/Event.js";
import JulianDate from "../Core/JulianDate.js";
import ReferenceFrame from "../Core/ReferenceFrame.js";
import PositionProperty from "./PositionProperty.js";

/**
 * A {@link PositionProperty} whose value does not change in respect to the
 * {@link ReferenceFrame} in which is it defined.
 *
 * @alias ConstantPositionProperty
 * @constructor
 *
 * @param {Cartesian3} [value] The property value.
 * @param {ReferenceFrame} [referenceFrame=ReferenceFrame.FIXED] The reference frame in which the position is defined.
 */
class ConstantPositionProperty {
  constructor(value, referenceFrame) {
    this._definitionChanged = new Event();
    this._value = Cartesian3.clone(value);
    this._referenceFrame = referenceFrame ?? ReferenceFrame.FIXED;
  }

  /**
   * Gets the value of the property at the provided time in the fixed frame.
   *
   * @param {JulianDate} [time=JulianDate.now()] The time for which to retrieve the value. If omitted, the current system time is used.
   * @param {object} [result] The object to store the value into, if omitted, a new instance is created and returned.
   * @returns {object} The modified result parameter or a new instance if the result parameter was not supplied.
   */
  getValue(time, result) {
    if (!defined(time)) {
      time = JulianDate.now(timeScratch);
    }
    return this.getValueInReferenceFrame(time, ReferenceFrame.FIXED, result);
  }

  /**
   * Sets the value of the property.
   *
   * @param {Cartesian3} value The property value.
   * @param {ReferenceFrame} [referenceFrame=this.referenceFrame] The reference frame in which the position is defined.
   */
  setValue(value, referenceFrame) {
    let definitionChanged = false;
    if (!Cartesian3.equals(this._value, value)) {
      definitionChanged = true;
      this._value = Cartesian3.clone(value);
    }
    if (defined(referenceFrame) && this._referenceFrame !== referenceFrame) {
      definitionChanged = true;
      this._referenceFrame = referenceFrame;
    }
    if (definitionChanged) {
      this._definitionChanged.raiseEvent(this);
    }
  }

  /**
   * Gets the value of the property at the provided time and in the provided reference frame.
   *
   * @param {JulianDate} time The time for which to retrieve the value.
   * @param {ReferenceFrame} referenceFrame The desired referenceFrame of the result.
   * @param {Cartesian3} [result] The object to store the value into, if omitted, a new instance is created and returned.
   * @returns {Cartesian3} The modified result parameter or a new instance if the result parameter was not supplied.
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

    return PositionProperty.convertToReferenceFrame(
      time,
      this._value,
      this._referenceFrame,
      referenceFrame,
      result,
    );
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
      this === other ||
      (other instanceof ConstantPositionProperty &&
        Cartesian3.equals(this._value, other._value) &&
        this._referenceFrame === other._referenceFrame)
    );
  }

  /**
   * Gets a value indicating if this property is constant.  A property is considered
   * constant if getValue always returns the same result for the current definition.
   *
   * @type {boolean}
   * @readonly
   */
  get isConstant() {
    return (
      !defined(this._value) || this._referenceFrame === ReferenceFrame.FIXED
    );
  }

  /**
   * Gets the event that is raised whenever the definition of this property changes.
   * The definition is considered to have changed if a call to getValue would return
   * a different result for the same time.
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

export default ConstantPositionProperty;
