import FeatureDetection from "../Core/FeatureDetection.js";
import TaskProcessor from "../Core/TaskProcessor.js";
import defined from "../Core/defined.js";

/**
 * Decodes Mapbox Vector Tiles off the main thread using a pool of web workers.
 *
 * The worker runs the same {@link decodeMVT} + {@link buildVectorGltfFromMVT}
 * pipeline used on the main thread, so the GLB output is identical — only the
 * (potentially expensive) protobuf decode + polygon tessellation moves off the
 * main thread. This is a pure-JS worker (no WebAssembly); a Rust/WASM
 * accelerator remains a future item (see migration_doc R-4).
 *
 * Callers MUST keep a synchronous main-thread decode path as a fallback: this
 * decoder returns {@link undefined} when the worker pool is saturated for the
 * current frame, and the input {@link ArrayBuffer} is intentionally NOT
 * transferred so the fallback can re-decode the intact buffer if the worker
 * task rejects.
 *
 * @namespace MVTTileDecoder
 * @private
 */
const MVTTileDecoder = {};

// Leave one core for the main thread, matching the other decode workers.
MVTTileDecoder._maxConcurrency = Math.max(
  FeatureDetection.hardwareConcurrency - 1,
  1,
);

MVTTileDecoder._taskProcessor = undefined;

/**
 * @returns {TaskProcessor}
 * @private
 */
MVTTileDecoder._getTaskProcessor = function () {
  if (!defined(MVTTileDecoder._taskProcessor)) {
    MVTTileDecoder._taskProcessor = new TaskProcessor(
      "decodeMVTTile",
      MVTTileDecoder._maxConcurrency,
    );
  }
  return MVTTileDecoder._taskProcessor;
};

/**
 * Schedules an MVT tile decode on a worker.
 *
 * @param {object} parameters
 * @param {ArrayBuffer} parameters.arrayBuffer Raw .pbf tile binary.
 * @param {{tileX:number, tileY:number, tileZ:number}} parameters.tileCoordinates
 * @param {string} [parameters.featureIdProperty] MVT property name to use as feature ID.
 * @returns {Promise<{glb: Uint8Array|undefined, hasFeatures: boolean}>|undefined}
 *   A promise resolving to the GLB result, or {@link undefined} if the worker
 *   pool is saturated this frame (the caller should fall back to a synchronous
 *   main-thread decode).
 * @private
 */
MVTTileDecoder.decode = function (parameters) {
  const taskProcessor = MVTTileDecoder._getTaskProcessor();
  // Deliberately do NOT transfer parameters.arrayBuffer: keeping the buffer
  // intact on the main thread preserves the synchronous fallback if the worker
  // task rejects (e.g. a malformed tile). The copy cost is negligible next to
  // the decode + tessellation work being offloaded.
  return taskProcessor.scheduleTask(parameters);
};

export default MVTTileDecoder;
