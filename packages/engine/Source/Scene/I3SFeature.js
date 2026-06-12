import defined from "../Core/defined.js";
import I3SDataProvider from "./I3SDataProvider.js";

/**
 * This class implements an I3S Feature.
 * <p>
 * Do not construct this directly, instead access tiles through {@link I3SNode}.
 * </p>
 * @alias I3SFeature
 * @internalConstructor
 */
class I3SFeature {
  constructor(parent, uri) {
    this._parent = parent;
    this._dataProvider = parent._dataProvider;
    this._layer = parent._layer;

    if (defined(this._parent._nodeIndex)) {
      this._resource = this._parent._layer.resource.getDerivedResource({
        url: `nodes/${this._parent._data.mesh.attribute.resource}/${uri}`,
      });
    } else {
      this._resource = this._parent.resource.getDerivedResource({ url: uri });
    }
  }

  /**
   * Loads the content.
   * @returns {Promise<object>} A promise that is resolved when the data of the I3S feature is loaded
   * @private
   */
  async load() {
    this._data = await I3SDataProvider.loadJson(this._resource);
    return this._data;
  }

  /**
   * Gets the resource for the feature
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
}

export default I3SFeature;
