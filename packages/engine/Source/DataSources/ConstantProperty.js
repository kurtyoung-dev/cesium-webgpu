import defined from "../Core/defined.js";
import Event from "../Core/Event.js";

/**
 * A {@link Property} whose value does not change with respect to simulation time.
 *
 * @alias ConstantProperty
 * @constructor
 *
 * @param {*} [value] The property value.
 *
 * @see ConstantPositionProperty
 */
class ConstantProperty {
  constructor(value) {
    this._value = undefined;
    this._hasClone = false;
    this._hasEquals = false;
    this._definitionChanged = new Event();
    this.setValue(value);
  }

  /**
   * Gets the value of the property.
   *
   * @param {JulianDate} [time] The time for which to retrieve the value.  This parameter is unused since the value does not change with respect to time.
   * @param {object} [result] The object to store the value into, if omitted, a new instance is created and returned.
   * @returns {object} The modified result parameter or a new instance if the result parameter was not supplied.
   */
  getValue(time, result) {
    return this._hasClone ? this._value.clone(result) : this._value;
  }

  /**
   * Sets the value of the property.
   *
   * @param {*} value The property value.
   */
  setValue(value) {
    const oldValue = this._value;
    if (oldValue !== value) {
      const isDefined = defined(value);
      const hasClone = isDefined && typeof value.clone === "function";
      const hasEquals = isDefined && typeof value.equals === "function";

      const changed = !hasEquals || !value.equals(oldValue);
      if (changed) {
        this._hasClone = hasClone;
        this._hasEquals = hasEquals;
        this._value = !hasClone ? value : value.clone(this._value);
        this._definitionChanged.raiseEvent(this);
      }
    }
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
      (other instanceof ConstantProperty && //
        ((!this._hasEquals && this._value === other._value) || //
          (this._hasEquals && this._value.equals(other._value))))
    );
  }

  /**
   * Gets this property's value.
   *
   * @returns {*} This property's value.
   */
  valueOf() {
    return this._value;
  }

  /**
   * Creates a string representing this property's value.
   *
   * @returns {string} A string representing the property's value.
   */
  toString() {
    return String(this._value);
  }

  /**
   * Gets a value indicating if this property is constant.
   * This property always returns <code>true</code>.
   *
   * @type {boolean}
   * @readonly
   */
  get isConstant() {
    return true;
  }

  /**
   * Gets the event that is raised whenever the definition of this property changes.
   * The definition is changed whenever setValue is called with data different
   * than the current value.
   *
   * @type {Event}
   * @readonly
   */
  get definitionChanged() {
    return this._definitionChanged;
  }
}

export default ConstantProperty;
