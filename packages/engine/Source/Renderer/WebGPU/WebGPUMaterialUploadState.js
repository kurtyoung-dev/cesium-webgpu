import defined from "../../Core/defined.js";

/**
 * Per-GPU-buffer upload cursor for a shared MaterialUniformBuffer. Material
 * mutation state belongs to the material, but upload completion belongs to
 * each concrete backend buffer. A consumer must therefore advance only its
 * own cursor and must never clear the shared material's dirty flag.
 *
 * @typedef {object} WebGPUMaterialUploadState
 * @property {object|undefined} source
 * @property {number|undefined} version
 * @property {boolean} initialized
 * @private
 */

/**
 * @returns {WebGPUMaterialUploadState}
 * @private
 */
function createMaterialUploadState() {
  return {
    source: undefined,
    version: undefined,
    initialized: false,
  };
}

/**
 * Uploads packed material bytes when this concrete GPU buffer has not seen
 * the material's current version. Legacy test doubles without a version keep
 * their old dirty-flag behavior, but the flag is deliberately never cleared
 * here because another command, context, or backend may still need it.
 *
 * @param {GPUDevice|object} device
 * @param {GPUBuffer|object} buffer
 * @param {object|undefined} uniformBuffer
 * @param {WebGPUMaterialUploadState} state
 * @param {boolean} [force=false]
 * @returns {boolean} Whether bytes were uploaded.
 * @private
 */
function uploadMaterialUniformBuffer(
  device,
  buffer,
  uniformBuffer,
  state,
  force,
) {
  if (!defined(uniformBuffer) || !defined(buffer)) {
    return false;
  }

  const data = uniformBuffer.gpuData;
  if (!defined(data)) {
    return false;
  }

  const version = uniformBuffer.version;
  const hasVersion = typeof version === "number";
  const sourceChanged = state.source !== uniformBuffer;
  const needsUpload =
    force === true ||
    !state.initialized ||
    sourceChanged ||
    (hasVersion ? state.version !== version : uniformBuffer.isDirty !== false);

  if (!needsUpload) {
    return false;
  }

  device.queue.writeBuffer(buffer, 0, data);
  state.source = uniformBuffer;
  state.version = hasVersion ? version : undefined;
  state.initialized = true;
  return true;
}

const WebGPUMaterialUploadState = Object.freeze({
  create: createMaterialUploadState,
  upload: uploadMaterialUniformBuffer,
});

export default WebGPUMaterialUploadState;
export { createMaterialUploadState, uploadMaterialUniformBuffer };
