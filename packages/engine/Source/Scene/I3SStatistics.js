import defined from "../Core/defined.js";
import I3SDataProvider from "./I3SDataProvider.js";
import Resource from "../Core/Resource.js";

/**
 * This class implements an I3S statistics for Building Scene Layer.
 * <p>
 * Do not construct this directly, instead access statistics through {@link I3SDataProvider}.
 * </p>
 * @alias I3SStatistics
 * @internalConstructor
 */
class I3SStatistics {
  constructor(dataProvider, uri) {
    this._dataProvider = dataProvider;

    this._resource = new Resource({ url: uri });
    this._resource.setQueryParameters(dataProvider.resource.queryParameters);
    this._resource.appendForwardSlash();
  }

  /**
   * Loads the content.
   * @returns {Promise<object>} A promise that is resolved when the data of the I3S statistics is loaded
   * @private
   */
  async load() {
    this._data = await I3SDataProvider.loadJson(this._resource);
    return this._data;
  }

  /**
   * @private
   */
  _getValues(attributeName) {
    const summary = this._data.summary;
    if (defined(summary)) {
      for (let i = 0; i < summary.length; ++i) {
        const attribute = summary[i];
        if (attribute.fieldName === attributeName) {
          if (defined(attribute.mostFrequentValues)) {
            return [...attribute.mostFrequentValues];
          }
          return [];
        }
      }
    }
  }

  /**
   * Gets the resource for the statistics
   * @type {Resource}
   * @readonly
   */
  get resource() {
    return this._resource;
  }

  /**
   * Gets the I3S data for this object.
   * @type {object}
   * @readonly
   */
  get data() {
    return this._data;
  }

  /**
   * Gets the collection of attribute names.
   * @type {string[]}
   * @readonly
   */
  get names() {
    const names = [];
    const summary = this._data.summary;
    if (defined(summary)) {
      for (let i = 0; i < summary.length; ++i) {
        names.push(summary[i].fieldName);
      }
    }
    return names;
  }
}

export default I3SStatistics;
