import Clock from "../Core/Clock.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Event from "../Core/Event.js";
import JulianDate from "../Core/JulianDate.js";
import createRawPropertyDescriptor from "./createRawPropertyDescriptor.js";

/**
 * Represents desired clock settings for a particular {@link DataSource}.  These settings may be applied
 * to the {@link Clock} when the DataSource is loaded.
 *
 * @alias DataSourceClock
 * @constructor
 */
class DataSourceClock {
  constructor() {
    this._definitionChanged = new Event();
    this._startTime = undefined;
    this._stopTime = undefined;
    this._currentTime = undefined;
    this._clockRange = undefined;
    this._clockStep = undefined;
    this._multiplier = undefined;
  }

  /**
   * Duplicates a DataSourceClock instance.
   *
   * @param {DataSourceClock} [result] The object onto which to store the result.
   * @returns {DataSourceClock} The modified result parameter or a new instance if one was not provided.
   */
  clone(result) {
    if (!defined(result)) {
      result = new DataSourceClock();
    }
    result.startTime = this.startTime;
    result.stopTime = this.stopTime;
    result.currentTime = this.currentTime;
    result.clockRange = this.clockRange;
    result.clockStep = this.clockStep;
    result.multiplier = this.multiplier;
    return result;
  }

  /**
   * Returns true if this DataSourceClock is equivalent to the other
   *
   * @param {DataSourceClock} [other] The other DataSourceClock to compare to.
   * @returns {boolean} <code>true</code> if the DataSourceClocks are equal; otherwise, <code>false</code>.
   */
  equals(other) {
    return (
      this === other ||
      (defined(other) &&
        JulianDate.equals(this.startTime, other.startTime) &&
        JulianDate.equals(this.stopTime, other.stopTime) &&
        JulianDate.equals(this.currentTime, other.currentTime) &&
        this.clockRange === other.clockRange &&
        this.clockStep === other.clockStep &&
        this.multiplier === other.multiplier)
    );
  }

  /**
   * Assigns each unassigned property on this object to the value
   * of the same property on the provided source object.
   *
   * @param {DataSourceClock} source The object to be merged into this object.
   */
  merge(source) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(source)) {
      throw new DeveloperError("source is required.");
    }
    //>>includeEnd('debug');

    this.startTime = this.startTime ?? source.startTime;
    this.stopTime = this.stopTime ?? source.stopTime;
    this.currentTime = this.currentTime ?? source.currentTime;
    this.clockRange = this.clockRange ?? source.clockRange;
    this.clockStep = this.clockStep ?? source.clockStep;
    this.multiplier = this.multiplier ?? source.multiplier;
  }

  /**
   * Gets the value of this clock instance as a {@link Clock} object.
   *
   * @returns {Clock} The modified result parameter or a new instance if one was not provided.
   */
  getValue(result) {
    if (!defined(result)) {
      result = new Clock();
    }
    result.startTime = this.startTime ?? result.startTime;
    result.stopTime = this.stopTime ?? result.stopTime;
    result.currentTime = this.currentTime ?? result.currentTime;
    result.clockRange = this.clockRange ?? result.clockRange;
    result.multiplier = this.multiplier ?? result.multiplier;
    result.clockStep = this.clockStep ?? result.clockStep;
    return result;
  }

  /**
   * Gets the event that is raised whenever a new property is assigned.
   * @memberof DataSourceClock.prototype
   *
   * @type {Event}
   * @readonly
   */
  get definitionChanged() {
    return this._definitionChanged;
  }
}

export default DataSourceClock;
