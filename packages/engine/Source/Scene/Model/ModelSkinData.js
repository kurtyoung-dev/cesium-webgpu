/**
 * Renderer-agnostic skinning data extractor for glTF model nodes.
 * Extracts computed joint matrices from a ModelRuntimeNode's skinning data
 * into a flat Float32Array, so both WebGL and WebGPU renderers can consume them.
 *
 * This separates "what joint matrices does this skinned node have?"
 * (shared logic — computed by ModelSkin.js + ModelRuntimeNode.js)
 * from "how do we upload them to the GPU?"
 * (renderer-specific: WebGL uniform array vs WebGPU storage/uniform buffer).
 *
 * Joint matrix computation pipeline (all shared, renderer-agnostic):
 *   1. ModelSkin.updateJointMatrices() — jointMatrix = jointWorldTransform * inverseBindMatrix
 *   2. ModelRuntimeNode.updateJointMatrices() — computedJointMatrix = inverseNodeWorld * jointMatrix
 *   3. This extractor — packs computedJointMatrices[] into flat Float32Array
 *
 * @private
 * @module ModelSkinData
 */
import defined from "../../Core/defined.js";
import Matrix4 from "../../Core/Matrix4.js";

/**
 * Extracts skinning data from a ModelRuntimeNode.
 *
 * @param {ModelRuntimeNode} runtimeNode - The runtime node to extract skin data from.
 * @returns {ModelSkinDataResult|null} Skinning data descriptor, or null if the node has no skin.
 */
function extractSkinData(runtimeNode) {
  if (!defined(runtimeNode)) {
    return null;
  }

  const runtimeSkin = runtimeNode._runtimeSkin;
  if (!defined(runtimeSkin)) {
    return null;
  }

  const jointMatrices = runtimeNode.computedJointMatrices;
  if (!defined(jointMatrices) || jointMatrices.length === 0) {
    return null;
  }

  const jointCount = jointMatrices.length;

  // Pack joint matrices into a flat Float32Array (16 floats per mat4)
  const packedSize = jointCount * 16;
  const packedMatrices = new Float32Array(packedSize);

  for (let i = 0; i < jointCount; i++) {
    Matrix4.pack(jointMatrices[i], packedMatrices, i * 16);
  }

  return {
    /**
     * Always true when this result is returned
     * @type {boolean}
     */
    hasSkinning: true,
    /**
     * Number of joints
     * @type {number}
     */
    jointCount: jointCount,
    /**
     * Flat array of mat4 values (16 floats per joint)
     * @type {Float32Array}
     */
    packedJointMatrices: packedMatrices,
    /**
     * Size in bytes of the packed matrices
     * @type {number}
     */
    byteLength: packedSize * 4,
    /**
     * Reference to the source Matrix4 array (for direct access)
     * @type {Matrix4[]}
     */
    jointMatrices: jointMatrices,
  };
}

/**
 * Updates an existing packed Float32Array with the current joint matrices.
 * This avoids re-allocating the array each frame.
 *
 * @param {ModelRuntimeNode} runtimeNode - The runtime node with updated joint matrices.
 * @param {Float32Array} packedMatrices - Pre-allocated Float32Array to write into.
 * @returns {boolean} True if the update succeeded, false if the node has no skin.
 */
function updatePackedJointMatrices(runtimeNode, packedMatrices) {
  if (!defined(runtimeNode)) {
    return false;
  }

  const runtimeSkin = runtimeNode._runtimeSkin;
  if (!defined(runtimeSkin)) {
    return false;
  }

  const jointMatrices = runtimeNode.computedJointMatrices;
  if (!defined(jointMatrices) || jointMatrices.length === 0) {
    return false;
  }

  const jointCount = jointMatrices.length;
  for (let i = 0; i < jointCount; i++) {
    Matrix4.pack(jointMatrices[i], packedMatrices, i * 16);
  }

  return true;
}

export { extractSkinData, updatePackedJointMatrices };
export default { extractSkinData, updatePackedJointMatrices };
