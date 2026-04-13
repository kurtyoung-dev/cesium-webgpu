import Check from "../Core/Check.js";
import defined from "../Core/defined.js";
import I3SDataProvider from "./I3SDataProvider.js";
import I3SLayer from "./I3SLayer.js";
import Resource from "../Core/Resource.js";

/**
 * This class implements an I3S sublayer for Building Scene Layer.
 * <p>
 * This object is normally not instantiated directly, use {@link I3SSublayer.fromData}.
 * </p>
 * @alias I3SSublayer
 * @internalConstructor
 */
class I3SSublayer {
  constructor(dataProvider, parent, sublayerData) {
    this._dataProvider = dataProvider;
    this._parent = parent;
    this._data = sublayerData;
    this._name = sublayerData.name;
    this._modelName = sublayerData.modelName;
    this._visibility = sublayerData.visibility ?? true;
    this._resource = undefined;
    this._sublayers = [];
    this._i3sLayers = [];
  }

  /**
   * Gets the resource for the sublayer
   * @memberof I3SSublayer.prototype
   * @type {Resource}
   * @readonly
   */
  get resource() {
    return this._resource;
  }

  /**
   * Gets the I3S data for this object.
   * @memberof I3SSublayer.prototype
   * @type {object}
   * @readonly
   */
  get data() {
    return this._data;
  }

  /**
   * Gets the name for the sublayer.
   * @memberof I3SSublayer.prototype
   * @type {string}
   * @readonly
   */
  get name() {
    return this._name;
  }

  /**
   * Gets the model name for the sublayer.
   * @memberof I3SSublayer.prototype
   * @type {string}
   * @readonly
   */
  get modelName() {
    return this._modelName;
  }

  /**
   * Gets the collection of child sublayers.
   * @memberof I3SSublayer.prototype
   * @type {I3SSublayer[]}
   * @readonly
   */
  get sublayers() {
    return this._sublayers;
  }

  /**
   * Gets or sets the sublayer visibility.
   * @memberof I3SSublayer.prototype
   * @type {boolean}
   */
  get visibility() {
    return this._visibility;
  }

  /**
   * Gets or sets the sublayer visibility.
   * @memberof I3SSublayer.prototype
   * @type {boolean}
   */
  set visibility(value) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("value", value);
    //>>includeEnd('debug');

    if (this._visibility !== value) {
      this._visibility = value;
      for (let i = 0; i < this._i3sLayers.length; i++) {
        this._i3sLayers[i]._updateVisibility();
      }
    }
  }

  /**
   * Determines if the sublayer will be shown.
   * @memberof I3SSublayer.prototype
   * @type {boolean}
   * @readonly
   */
  get show() {
    return this._visibility && this._parent.show;
  }
}

/**
 * @private
 */
I3SSublayer._fromData = async function (
  dataProvider,
  buildingLayerUrl,
  sublayerData,
  parent,
) {
  const sublayer = new I3SSublayer(dataProvider, parent, sublayerData);
  if (sublayer._data.layerType === "group") {
    const sublayers = sublayer._data.sublayers;
    if (defined(sublayers)) {
      const promises = [];
      for (let i = 0; i < sublayers.length; i++) {
        const promise = I3SSublayer._fromData(
          dataProvider,
          buildingLayerUrl,
          sublayers[i],
          sublayer,
        );
        promises.push(promise);
      }
      const childSublayers = await Promise.all(promises);
      for (let i = 0; i < childSublayers.length; i++) {
        const childSublayer = childSublayers[i];
        sublayer._sublayers.push(childSublayer);
        sublayer._i3sLayers.push(...childSublayer._i3sLayers);
      }
    }
  } else if (sublayer._data.layerType === "3DObject") {
    const sublayerUrl = buildingLayerUrl.concat(
      `/sublayers/${sublayer._data.id}`,
    );
    const resource = new Resource({ url: sublayerUrl });
    resource.setQueryParameters(dataProvider.resource.queryParameters);
    resource.appendForwardSlash();
    sublayer._resource = resource;

    const layerData = await I3SDataProvider.loadJson(sublayer._resource);
    const layer = new I3SLayer(dataProvider, layerData, sublayer);
    sublayer._i3sLayers.push(layer);
  } else {
    // Filter other scene layer types out
    console.log(
      `${sublayer._data.layerType} layer ${sublayer._data.name} is skipped as not supported.`,
    );
  }
  return sublayer;
};

export default I3SSublayer;
