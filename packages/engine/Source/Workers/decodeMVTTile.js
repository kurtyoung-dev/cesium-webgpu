import defined from "../Core/defined.js";
import decodeMVT from "../Scene/decodeMVT.js";
import buildVectorGltfFromMVT from "../Scene/buildVectorGltfFromMVT.js";
import createTaskProcessorWorker from "./createTaskProcessorWorker.js";

/**
 * Web-worker task that decodes a Mapbox Vector Tile (.mvt / .pbf) binary and
 * builds a GLB payload off the main thread. Runs the exact same
 * {@link decodeMVT} + {@link buildVectorGltfFromMVT} pipeline the main-thread
 * fallback uses, so the produced GLB is identical — only the CPU work moves off
 * the main thread. Paired with {@link MVTTileDecoder} / {@link TaskProcessor}.
 *
 * @param {object} parameters
 * @param {ArrayBuffer} parameters.arrayBuffer Raw .pbf tile binary.
 * @param {{tileX:number, tileY:number, tileZ:number}} parameters.tileCoordinates
 * @param {string} [parameters.featureIdProperty] MVT property name to use as feature ID.
 * @param {Array} transferableObjects Filled with the GLB buffer to transfer back.
 * @returns {{glb: Uint8Array|undefined, hasFeatures: boolean}}
 * @private
 */
function decodeMVTTile(parameters, transferableObjects) {
  const decodedTile = decodeMVT(parameters.arrayBuffer);

  const glb = buildVectorGltfFromMVT(decodedTile, parameters.tileCoordinates, {
    featureIdProperty: parameters.featureIdProperty,
  });

  let hasFeatures = false;
  const layers = decodedTile.layers;
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].features.length > 0) {
      hasFeatures = true;
      break;
    }
  }

  if (defined(glb)) {
    transferableObjects.push(glb.buffer);
  }

  return { glb: glb, hasFeatures: hasFeatures };
}

export default createTaskProcessorWorker(decodeMVTTile);
