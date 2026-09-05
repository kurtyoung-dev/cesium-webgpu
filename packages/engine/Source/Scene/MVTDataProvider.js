// @ts-check

import Axis from "./Axis.js";
import Empty3DTileContent from "./Empty3DTileContent.js";
import RuntimeError from "../Core/RuntimeError.js";
import UrlTemplate3DTilesDataProvider from "./UrlTemplate3DTilesDataProvider.js";
import VectorGltf3DTileContent from "./VectorGltf3DTileContent.js";
import buildVectorGltfFromMVT from "./buildVectorGltfFromMVT.js";
import decodeMVT from "./decodeMVT.js";
import MVTTileDecoder from "./MVTTileDecoder.js";
import oneTimeWarning from "../Core/oneTimeWarning.js";
import defined from "../Core/defined.js";

/** @import Cesium3DTile from "./Cesium3DTile.js"; */
/** @import Cesium3DTileset from "./Cesium3DTileset.js"; */
/** @import HeightReference from "./HeightReference.js"; */
/** @import Rectangle from "../Core/Rectangle.js"; */
/** @import Resource from "../Core/Resource.js"; */
/** @import Scene from "./Scene.js"; */

/**
 * The decode-related provider options this class reads off the shared
 * {@link UrlTemplate3DTilesDataProvider} options bag.
 *
 * @typedef {object} MVTDecodeOptions
 * @property {boolean} [decodeInWorker] Whether tile decode runs in a worker.
 * @private
 */

/**
 * A Mapbox Vector Tiles (MVT) data provider. Loads .mvt or .pbf tiles, converting tiles
 * dynamically (at runtime) into 3D Tiles.
 *
 * <div class="notice">
 * This object is normally not instantiated directly, use {@link MVTDataProvider.fromUrl}.
 * </div>
 *
 * @extends UrlTemplate3DTilesDataProvider
 * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy.
 */
class MVTDataProvider extends UrlTemplate3DTilesDataProvider {
  /**
   * @param {Resource|string} url URL template, containing {z}, {x}, and {y} placeholders.
   * @param {object} [options] Provider options.
   * @ignore
   */
  constructor(url, options) {
    super(url, options);
    // Opt-in, default-off: when false the tile decode runs synchronously on the
    // main thread exactly as before. When true, decode + GLB build are moved to
    // a web worker (with a synchronous main-thread fallback). See MVTTileDecoder.
    this._decodeInWorker =
      /** @type {MVTDecodeOptions} */ (options ?? {}).decodeInWorker ?? false;
  }

  /**
   * Creates an MVTDataProvider from the specified URL template and options.
   *
   * @param {Resource|string} url URL template, containing {z}, {x}, and {y} placeholders.
   * @param {object} [options] Provider options.
   * @param {number} [options.minZoom=0] Minimum zoom level represented in the generated tileset.
   * @param {number} [options.maxZoom=14] Maximum zoom level represented in the generated tileset.
   * @param {Rectangle} [options.extent] Optional geographic extent in radians to constrain the generated tile tree.
   * @param {string} [options.featureIdProperty] MVT property name to use as feature ID.
   * @param {boolean} [options.decodeInWorker=false] When true, decode MVT tiles on a web worker (off the main thread) instead of synchronously. Falls back to synchronous decode when the worker pool is saturated or unavailable.
   * @param {HeightReference} [options.heightReference] Drapes the decoded points, lines and polygons onto the
   *   surfaces selected by the value: {@link HeightReference.CLAMP_TO_TERRAIN} drapes onto the globe,
   *   {@link HeightReference.CLAMP_TO_3D_TILE} drapes onto 3D Tiles and models, and
   *   {@link HeightReference.CLAMP_TO_GROUND} drapes onto both. Requires <code>options.scene</code>.
   * @param {Scene} [options.scene] The scene the generated tileset is rendered in, required when
   *   <code>options.heightReference</code> is a clamping value.
   * @returns {Promise<MVTDataProvider>}
   */
  static async fromUrl(url, options) {
    return /** @type {Promise<MVTDataProvider>} */ (
      super.fromUrl(url, options)
    );
  }

  /**
   * @returns {object}
   * @protected
   * @ignore
   */
  _createTilesetLoadOptions() {
    return {
      ...super._createTilesetLoadOptions(),
      skipLevelOfDetail: false,
      enablePick: true,
      featureIdLabel: "featureId_0",
      instanceFeatureIdLabel: "instanceFeatureId_0",
    };
  }

  /**
   * @param {Cesium3DTileset} tileset
   * @protected
   * @ignore
   */
  _configureTileset(tileset) {
    tileset._modelUpAxis = Axis.Z;
    tileset._modelForwardAxis = Axis.X;
  }

  /**
   * @returns {object}
   * @protected
   * @ignore
   */
  _createCodec() {
    const featureIdProperty = this._featureIdProperty;
    const decodeInWorker = this._decodeInWorker;
    return {
      contentType: "mvt",
      missingTilePolicy: { statusCodes: [404, 204] },

      /**
       * @param {Cesium3DTileset} tileset
       * @param {Cesium3DTile} tile
       * @param {Resource} resource
       * @param {ArrayBuffer} arrayBuffer
       * @ignore
       */
      createContent: async (tileset, tile, resource, arrayBuffer) => {
        if (decodeInWorker) {
          const tileCoordinates = parseTileCoordinates(
            resource.getUrlComponent(true),
          );
          const workerResult = await decodeMVTOffThread(
            arrayBuffer,
            tileCoordinates,
            featureIdProperty,
          );
          if (defined(workerResult)) {
            const workerGlb = workerResult.glb;
            if (!defined(workerGlb)) {
              if (!workerResult.hasFeatures) {
                return new Empty3DTileContent(tileset, tile);
              }
              throw new RuntimeError(
                "Decoded MVT tile did not produce vector glTF content.",
              );
            }
            return VectorGltf3DTileContent.fromGltf(
              tileset,
              tile,
              resource,
              workerGlb,
            );
          }
          // Worker pool saturated / unavailable — fall through to synchronous decode.
        }

        const decodedTile = decodeMVT(arrayBuffer);
        const tileCoordinates = parseTileCoordinates(
          resource.getUrlComponent(true),
        );
        const glb = buildVectorGltfFromMVT(decodedTile, tileCoordinates, {
          featureIdProperty: featureIdProperty,
        });
        if (!defined(glb)) {
          if (!hasAnyDecodedFeatures(decodedTile)) {
            return new Empty3DTileContent(tileset, tile);
          }
          throw new RuntimeError(
            "Decoded MVT tile did not produce vector glTF content.",
          );
        }
        return VectorGltf3DTileContent.fromGltf(tileset, tile, resource, glb);
      },
    };
  }
}

/**
 * Attempts to decode an MVT tile on a worker. Returns the worker result, or
 * {@link undefined} to signal the caller should fall back to synchronous decode
 * (worker pool saturated, worker unavailable, or the worker task rejected). The
 * input {@link ArrayBuffer} is not transferred, so it stays intact for the
 * synchronous fallback.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {{tileX:number, tileY:number, tileZ:number}} tileCoordinates
 * @param {string|undefined} featureIdProperty
 * @returns {Promise<{glb:(Uint8Array|undefined), hasFeatures:boolean}|undefined>}
 * @ignore
 */
async function decodeMVTOffThread(
  arrayBuffer,
  tileCoordinates,
  featureIdProperty,
) {
  let promise;
  try {
    promise = MVTTileDecoder.decode({
      arrayBuffer: arrayBuffer,
      tileCoordinates: tileCoordinates,
      featureIdProperty: featureIdProperty,
    });
  } catch (error) {
    // Worker could not be created (e.g. no Worker support) — use sync fallback.
    return undefined;
  }
  if (!defined(promise)) {
    // Worker pool saturated this frame — use sync fallback.
    return undefined;
  }
  try {
    return await promise;
  } catch (error) {
    // Worker task rejected. The arrayBuffer was not transferred, so the caller
    // can safely re-decode it synchronously (and surface the same error).
    return undefined;
  }
}

/**
 * @param {string} url
 * @returns {{tileZ:number, tileX:number, tileY:number}}
 * @ignore
 */
function parseTileCoordinates(url) {
  const match = url.match(/\/(\d+)\/(\d+)\/(\d+)(?:\.[^/?#]+)?(?:[?#]|$)/i);
  if (!match) {
    oneTimeWarning(
      "MVTDataProvider.parseTileCoordinates",
      `MVT tile URL did not match /{z}/{x}/{y} pattern. Falling back to z/x/y = 0/0/0. URL: ${url}`,
    );
    return { tileZ: 0, tileX: 0, tileY: 0 };
  }
  return {
    tileZ: parseInt(match[1], 10),
    tileX: parseInt(match[2], 10),
    tileY: parseInt(match[3], 10),
  };
}

/**
 * @param {{layers:Array<{features:Array<*>}>}} decodedTile
 * @returns {boolean}
 * @ignore
 */
function hasAnyDecodedFeatures(decodedTile) {
  const layers = decodedTile.layers;
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].features.length > 0) {
      return true;
    }
  }
  return false;
}

MVTDataProvider._parseTileCoordinates = parseTileCoordinates;

export default MVTDataProvider;
