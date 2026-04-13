import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Event from "../Core/Event.js";
import RenderLayer from "./RenderLayer.js";
import SortMode from "./SortMode.js";

/**
 * Manages an ordered collection of {@link RenderLayer} instances for a scene.
 * Provides default layers that map to CesiumJS's existing pass structure, and
 * allows users to add custom layers or reconfigure existing ones.
 *
 * Layers execute in ascending {@link RenderLayer#order}. The collection
 * automatically maintains sorted order and handles depth-clear boundaries.
 *
 * @alias RenderLayerCollection
 * @constructor
 *
 * @see RenderLayer
 * @see RenderScheduler
 */
class RenderLayerCollection {
  constructor() {
    /**
     * Sorted array of render layers (ascending order).
     * @private
     * @type {RenderLayer[]}
     */
    this._layers = [];

    /**
     * Fast lookup: order value → layer. Uses sparse array (not Map)
     * because layer orders are small integers.
     * @private
     * @type {Object<number, RenderLayer>}
     */
    this._orderToLayer = {};

    /**
     * Fast lookup: name → layer.
     * @private
     * @type {Object<string, RenderLayer>}
     */
    this._nameToLayer = {};

    /**
     * Event raised when any layer is added, removed, or reordered.
     * @type {Event}
     * @readonly
     */
    this.layerChanged = new Event();

    /**
     * Whether the sorted layer list needs rebuilding.
     * @private
     * @type {boolean}
     */
    this._needsSort = false;

    // Create default layers matching CesiumJS pass structure
    _createDefaultLayers(this);
  }

  /**
   * Retrieves a render layer by name.
   *
   * @param {string} name The layer name.
   * @returns {RenderLayer|undefined} The matching layer, or undefined if not found.
   */
  getByName(name) {
    return this._nameToLayer[name];
  }

  /**
   * Retrieves a render layer by its order value.
   *
   * @param {number} order The layer order.
   * @returns {RenderLayer|undefined} The matching layer, or undefined if not found.
   */
  getByOrder(order) {
    return this._orderToLayer[order];
  }

  /**
   * Retrieves a layer by index in the sorted array.
   *
   * @param {number} index Zero-based index.
   * @returns {RenderLayer} The layer at that index.
   */
  get(index) {
    //>>includeStart('debug', pragmas.debug);
    if (index < 0 || index >= this._layers.length) {
      throw new DeveloperError(
        `index ${index} out of range [0, ${this._layers.length - 1}]`,
      );
    }
    //>>includeEnd('debug');
    return this._layers[index];
  }

  /**
   * Adds a new render layer to the collection. The layer is inserted
   * in sorted order by its {@link RenderLayer#order} value.
   *
   * @param {RenderLayer} layer The layer to add.
   * @returns {RenderLayer} The added layer.
   *
   * @exception {DeveloperError} A layer with the same name already exists.
   * @exception {DeveloperError} A layer with the same order already exists.
   */
  add(layer) {
    //>>includeStart('debug', pragmas.debug);
    if (defined(this._nameToLayer[layer.name])) {
      throw new DeveloperError(
        `A layer named "${layer.name}" already exists. Use getByName() to reconfigure it.`,
      );
    }
    if (defined(this._orderToLayer[layer.order])) {
      throw new DeveloperError(
        `A layer with order ${layer.order} already exists (name: "${this._orderToLayer[layer.order].name}").`,
      );
    }
    //>>includeEnd('debug');

    this._layers.push(layer);
    this._orderToLayer[layer.order] = layer;
    this._nameToLayer[layer.name] = layer;
    this._needsSort = true;

    this.layerChanged.raiseEvent(layer, "add");
    return layer;
  }

  /**
   * Creates and adds a new render layer with the given options.
   *
   * @param {object} options Options passed to the {@link RenderLayer} constructor.
   * @returns {RenderLayer} The newly created layer.
   */
  create(options) {
    return this.add(new RenderLayer(options));
  }

  /**
   * Removes a user-created layer. Default layers cannot be removed.
   *
   * @param {RenderLayer|string} layerOrName The layer instance or name.
   * @returns {boolean} True if the layer was found and removed.
   *
   * @exception {DeveloperError} Cannot remove a default layer.
   */
  remove(layerOrName) {
    const layer =
      typeof layerOrName === "string"
        ? this._nameToLayer[layerOrName]
        : layerOrName;

    if (!defined(layer)) {
      return false;
    }

    //>>includeStart('debug', pragmas.debug);
    if (layer._isDefault) {
      throw new DeveloperError(
        `Cannot remove default layer "${layer.name}". Disable it instead.`,
      );
    }
    //>>includeEnd('debug');

    const idx = this._layers.indexOf(layer);
    if (idx === -1) {
      return false;
    }

    this._layers.splice(idx, 1);
    delete this._orderToLayer[layer.order];
    delete this._nameToLayer[layer.name];

    this.layerChanged.raiseEvent(layer, "remove");
    return true;
  }

  /**
   * Ensures the layer array is sorted by order. Called lazily
   * before rendering if any layer was added or reordered.
   * @private
   */
  _ensureSorted() {
    // Check if any layer's order changed (dirty flag)
    let needsSort = this._needsSort;
    if (!needsSort) {
      const layers = this._layers;
      for (let i = 0; i < layers.length; i++) {
        if (layers[i]._dirty) {
          needsSort = true;
          layers[i]._dirty = false;
        }
      }
    }

    if (needsSort) {
      this._layers.sort(compareLayerOrder);
      // Rebuild order lookup
      this._orderToLayer = {};
      const layers = this._layers;
      for (let i = 0; i < layers.length; i++) {
        this._orderToLayer[layers[i].order] = layers[i];
      }
      this._needsSort = false;
    }
  }

  /**
   * Resets all layer command buckets for a new frame.
   * @private
   */
  resetAllBuckets() {
    const layers = this._layers;
    for (let i = 0; i < layers.length; i++) {
      layers[i].resetCommandBuckets();
    }
  }

  /**
   * Returns a diagnostic summary of all layers and their command counts.
   * Useful for debugging render order issues.
   *
   * @returns {string} Formatted diagnostic string.
   */
  getDiagnostics() {
    this._ensureSorted();
    const lines = ["=== Render Layers ==="];
    const layers = this._layers;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const status = layer.enabled ? "ON" : "OFF";
      const depth = layer.clearDepth ? " [DEPTH CLEAR]" : "";
      const cmds = `O:${layer._opaqueCount} T:${layer._transparentCount} X:${layer._transmissiveCount}`;
      lines.push(
        `  [${i}] ${layer.name} (order=${layer.order}, ${status}${depth}) — ${cmds}`,
      );
    }
    return lines.join("\n");
  }

  /**
   * The number of layers in this collection.
   * @memberof RenderLayerCollection.prototype
   * @type {number}
   * @readonly
   */
  get length() {
    return this._layers.length;
  }
}

/**
 * Creates the built-in default layers that map to CesiumJS's existing pass structure.
 * These can be reconfigured by the user but not removed.
 * @private
 */
function _createDefaultLayers(collection) {
  const defaults = [
    {
      name: "Environment",
      order: RenderLayer.Order.ENVIRONMENT,
      opaqueSortMode: SortMode.NONE,
      transparentSortMode: SortMode.NONE,
    },
    {
      name: "Globe",
      order: RenderLayer.Order.GLOBE,
      opaqueSortMode: SortMode.MATERIAL_MESH,
      transparentSortMode: SortMode.BACK_TO_FRONT,
    },
    {
      name: "TerrainClassification",
      order: RenderLayer.Order.TERRAIN_CLASSIFICATION,
      opaqueSortMode: SortMode.MANUAL,
      transparentSortMode: SortMode.MANUAL,
    },
    {
      name: "Tiles3D",
      order: RenderLayer.Order.TILES_3D,
      opaqueSortMode: SortMode.MATERIAL_MESH,
      transparentSortMode: SortMode.BACK_TO_FRONT,
    },
    {
      name: "World",
      order: RenderLayer.Order.WORLD,
      opaqueSortMode: SortMode.MATERIAL_MESH,
      transparentSortMode: SortMode.BACK_TO_FRONT,
    },
    {
      name: "Annotations",
      order: RenderLayer.Order.ANNOTATIONS,
      clearDepth: true,
      opaqueSortMode: SortMode.MANUAL,
      transparentSortMode: SortMode.BACK_TO_FRONT,
    },
    {
      name: "Overlay",
      order: RenderLayer.Order.OVERLAY,
      clearDepth: true,
      opaqueSortMode: SortMode.NONE,
      transparentSortMode: SortMode.NONE,
    },
  ];

  for (let i = 0; i < defaults.length; i++) {
    const layer = new RenderLayer(defaults[i]);
    layer._isDefault = true;
    collection._layers.push(layer);
    collection._orderToLayer[layer.order] = layer;
    collection._nameToLayer[layer.name] = layer;
  }
}

/**
 * Sort comparator for layers by order.
 * @private
 */
function compareLayerOrder(a, b) {
  return a._order - b._order;
}

/**
 * Maps a CesiumJS Pass enum value to the default render layer order.
 * Used during the transition period to bin existing commands into layers.
 *
 * @param {number} passValue The Pass enum value (0-12).
 * @returns {number} The corresponding RenderLayer.Order value.
 * @private
 */
RenderLayerCollection.passToLayerOrder = function (passValue) {
  switch (passValue) {
    case 0: // ENVIRONMENT
      return RenderLayer.Order.ENVIRONMENT;
    case 1: // COMPUTE
      return RenderLayer.Order.ENVIRONMENT; // Compute runs with environment
    case 2: // GLOBE
      return RenderLayer.Order.GLOBE;
    case 3: // TERRAIN_CLASSIFICATION
      return RenderLayer.Order.TERRAIN_CLASSIFICATION;
    case 4: // CESIUM_3D_TILE_EDGES
    case 5: // CESIUM_3D_TILE
    case 6: // CESIUM_3D_TILE_CLASSIFICATION
    case 7: // CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW
      return RenderLayer.Order.TILES_3D;
    case 8: // OPAQUE
      return RenderLayer.Order.WORLD;
    case 9: // TRANSLUCENT
      return RenderLayer.Order.WORLD; // Transparent within world layer
    case 10: // VOXELS
    case 11: // GAUSSIAN_SPLATS
      return RenderLayer.Order.WORLD;
    case 12: // OVERLAY
      return RenderLayer.Order.OVERLAY;
    default:
      return RenderLayer.Order.WORLD;
  }
};

export default RenderLayerCollection;
