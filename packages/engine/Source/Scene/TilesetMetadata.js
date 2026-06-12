import Check from "../Core/Check.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import MetadataEntity from "./MetadataEntity.js";

/**
 * Metadata about the tileset.
 * <p>
 * See the {@link https://github.com/CesiumGS/3d-tiles/tree/main/extensions/3DTILES_metadata|3DTILES_metadata Extension} for 3D Tiles
 * </p>
 *
 * @param {object} options Object with the following properties:
 * @param {object} options.tileset The tileset metadata JSON object.
 * @param {MetadataClass} options.class The class that tileset metadata conforms to.
 *
 * @alias TilesetMetadata
 * @constructor
 * @private
 * @experimental This feature is using part of the 3D Tiles spec that is not final and is subject to change without Cesium's standard deprecation policy.
 */
class TilesetMetadata {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;
    const tileset = options.tileset;
    const metadataClass = options.class;

    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.object("options.tileset", tileset);
    Check.typeOf.object("options.class", metadataClass);
    //>>includeEnd('debug');

    const properties = defined(tileset.properties) ? tileset.properties : {};

    this._class = metadataClass;
    this._properties = properties;
    this._extras = tileset.extras;
    this._extensions = tileset.extensions;
  }

  /**
   * Returns whether the tileset has this property.
   *
   * @param {string} propertyId The case-sensitive ID of the property.
   * @returns {boolean} Whether the tileset has this property.
   * @private
   */
  hasProperty(propertyId) {
    return MetadataEntity.hasProperty(
      propertyId,
      this._properties,
      this._class,
    );
  }

  /**
   * Returns whether the tileset has a property with the given semantic.
   *
   * @param {string} semantic The case-sensitive semantic of the property.
   * @returns {boolean} Whether the tileset has a property with the given semantic.
   * @private
   */
  hasPropertyBySemantic(semantic) {
    return MetadataEntity.hasPropertyBySemantic(
      semantic,
      this._properties,
      this._class,
    );
  }

  /**
   * Returns an array of property IDs.
   *
   * @param {string[]} [results] An array into which to store the results.
   * @returns {string[]} The property IDs.
   * @private
   */
  getPropertyIds(results) {
    return MetadataEntity.getPropertyIds(
      this._properties,
      this._class,
      results,
    );
  }

  /**
   * Returns a copy of the value of the property with the given ID.
   * <p>
   * If the property is normalized the normalized value is returned.
   * </p>
   *
   * @param {string} propertyId The case-sensitive ID of the property.
   * @returns {*} The value of the property or <code>undefined</code> if the tileset does not have this property.
   * @private
   */
  getProperty(propertyId) {
    return MetadataEntity.getProperty(
      propertyId,
      this._properties,
      this._class,
    );
  }

  /**
   * Sets the value of the property with the given ID.
   * <p>
   * If the property is normalized a normalized value must be provided to this function.
   * </p>
   *
   * @param {string} propertyId The case-sensitive ID of the property.
   * @param {*} value The value of the property that will be copied.
   * @returns {boolean} <code>true</code> if the property was set, <code>false</code> otherwise.
   * @private
   */
  setProperty(propertyId, value) {
    return MetadataEntity.setProperty(
      propertyId,
      value,
      this._properties,
      this._class,
    );
  }

  /**
   * Returns a copy of the value of the property with the given semantic.
   *
   * @param {string} semantic The case-sensitive semantic of the property.
   * @returns {*} The value of the property or <code>undefined</code> if the tileset does not have this semantic.
   * @private
   */
  getPropertyBySemantic(semantic) {
    return MetadataEntity.getPropertyBySemantic(
      semantic,
      this._properties,
      this._class,
    );
  }

  /**
   * Sets the value of the property with the given semantic.
   *
   * @param {string} semantic The case-sensitive semantic of the property.
   * @param {*} value The value of the property that will be copied.
   * @returns {boolean} <code>true</code> if the property was set, <code>false</code> otherwise.
   * @private
   */
  setPropertyBySemantic(semantic, value) {
    return MetadataEntity.setPropertyBySemantic(
      semantic,
      value,
      this._properties,
      this._class,
    );
  }

  /**
   * The class that properties conform to.
   *
   * @type {MetadataClass}
   * @readonly
   * @private
   */
  get class() {
    return this._class;
  }

  /**
   * Extra user-defined properties.
   *
   * @type {*}
   * @readonly
   * @private
   */
  get extras() {
    return this._extras;
  }

  /**
   * An object containing extensions.
   *
   * @type {object}
   * @readonly
   * @private
   */
  get extensions() {
    return this._extensions;
  }
}

export default TilesetMetadata;
