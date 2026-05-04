/**
 * @module WebGPUModelMorphTargets
 *
 * Packs morph target deltas into a GPU storage buffer and morph weights
 * into a uniform buffer for WebGPU model rendering.
 *
 * Storage buffer layout:
 *   [target0_posX, target0_posY, target0_posZ, pad,  // vertex 0, target 0
 *    target0_posX, target0_posY, target0_posZ, pad,  // vertex 1, target 0
 *    ...
 *    target1_posX, target1_posY, target1_posZ, pad,  // vertex 0, target 1
 *    ...]
 *
 * Weights are packed into a vec4 array (4 weights per vec4) in a
 * uniform buffer. Max 8 morph targets supported per primitive.
 *
 * @private
 */
import defined from "../../Core/defined.js";
import WebGPUBuffer from "./WebGPUBuffer.js";

const MAX_MORPH_TARGETS = 8;
// 2 vec4s for weights (8 floats) + targetCount + vertexCount + 2 pad
const MORPH_UNIFORM_SIZE = 48; // 12 floats × 4 bytes = 48 bytes, aligned to 16

/**
 * Creates or updates morph target GPU resources for a model primitive.
 *
 * @param {GPUDevice} device
 * @param {object} primCache - The per-primitive cache from WebGPUModelRenderer
 * @param {object} geometry - The extracted ModelPrimitiveGeometry with morphTargets
 * @param {number[]} morphWeights - Active morph weights from the model
 * @returns {object|null} Morph target resources, or null if no morph targets
 */
function ensureMorphTargetResources(device, primCache, geometry, morphWeights) {
  if (!defined(geometry) || geometry.morphTargetCount === 0) {
    return null;
  }

  const targetCount = Math.min(geometry.morphTargetCount, MAX_MORPH_TARGETS);
  const vertexCount = geometry.vertexCount;

  // Create storage buffer with packed morph deltas (once, on first call)
  if (!defined(primCache._morphStorageBuffer)) {
    const packedData = packMorphTargetDeltas(
      geometry.morphTargets,
      targetCount,
      vertexCount,
    );
    primCache._morphStorageBuffer = device.createBuffer({
      label: "MorphTarget deltas",
      size: packedData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(primCache._morphStorageBuffer, 0, packedData);
    primCache._morphTargetCount = targetCount;
    primCache._morphVertexCount = vertexCount;
  }

  // Create or update weights uniform buffer (every frame if weights change)
  if (!defined(primCache._morphWeightBuffer)) {
    primCache._morphWeightBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      MORPH_UNIFORM_SIZE,
      "MorphTarget weights",
    );
    primCache._morphWeightData = new Float32Array(MORPH_UNIFORM_SIZE / 4);
  }
  // NEW-TAA-MORPH-PREV (Batch 134) -- prev-frame weights mirror for
  // TAA velocity. The shader runs morph twice in vertexMain (once
  // current, once prev) and needs the prev weights to compute the
  // correct prevPositionMC. First-frame: alias prev = current so
  // velocity is zero on the first morphed frame rather than wildly
  // wrong from zero deltas.
  if (!defined(primCache._morphWeightBufferPrev)) {
    primCache._morphWeightBufferPrev = WebGPUBuffer.createUniformBuffer(
      device,
      MORPH_UNIFORM_SIZE,
      "MorphTarget weights (prev)",
    );
    primCache._morphWeightDataPrev = new Float32Array(MORPH_UNIFORM_SIZE / 4);
  }

  // NEW-TAA-MORPH-PREV (Batch 134) -- save current weights as prev
  // BEFORE overwriting with this frame's weights. Same swap pattern
  // as `prevPackedJointMatrices` in `WebGPUModelRenderer.js`.
  primCache._morphWeightDataPrev.set(primCache._morphWeightData);
  device.queue.writeBuffer(
    primCache._morphWeightBufferPrev.buffer,
    0,
    primCache._morphWeightDataPrev.buffer,
    0,
    MORPH_UNIFORM_SIZE,
  );

  // Pack weights into uniform buffer
  const weightData = primCache._morphWeightData;
  weightData.fill(0);
  // First 8 floats: weights (2 × vec4)
  const numWeights = Math.min(
    defined(morphWeights) ? morphWeights.length : 0,
    MAX_MORPH_TARGETS,
  );
  for (let i = 0; i < numWeights; i++) {
    weightData[i] = morphWeights[i];
  }
  // Float 8: target count, Float 9: vertex count
  weightData[8] = targetCount;
  weightData[9] = vertexCount;
  device.queue.writeBuffer(
    primCache._morphWeightBuffer.buffer,
    0,
    weightData.buffer,
    0,
    MORPH_UNIFORM_SIZE,
  );

  return {
    storageBuffer: primCache._morphStorageBuffer,
    weightBuffer: primCache._morphWeightBuffer.buffer,
    weightBufferPrev: primCache._morphWeightBufferPrev.buffer,
    targetCount: targetCount,
  };
}

/**
 * Pack morph target position deltas into a Float32Array for the storage buffer.
 * Layout: per-target blocks of (vertexCount × 4 floats) — vec4 padded.
 *
 * @param {object[]} morphTargets - Array of { positionData, normalData }
 * @param {number} targetCount
 * @param {number} vertexCount
 * @returns {Float32Array}
 * @private
 */
function packMorphTargetDeltas(morphTargets, targetCount, vertexCount) {
  // 4 floats per vertex per target (xyz + pad)
  const floatsPerTarget = vertexCount * 4;
  const totalFloats = floatsPerTarget * targetCount;
  const packed = new Float32Array(totalFloats);

  for (let t = 0; t < targetCount; t++) {
    const target = morphTargets[t];
    const posData = target.positionData;
    const baseOffset = t * floatsPerTarget;

    if (!defined(posData)) {
      continue;
    }

    for (let v = 0; v < vertexCount; v++) {
      const srcIdx = v * 3;
      const dstIdx = baseOffset + v * 4;
      packed[dstIdx] = posData[srcIdx]; // x
      packed[dstIdx + 1] = posData[srcIdx + 1]; // y
      packed[dstIdx + 2] = posData[srcIdx + 2]; // z
      // packed[dstIdx + 3] = 0.0 (padding, already zero)
    }
  }

  return packed;
}

/**
 * Destroys morph target GPU resources.
 * @param {object} primCache
 */
function destroyMorphTargetResources(primCache) {
  if (defined(primCache._morphStorageBuffer)) {
    primCache._morphStorageBuffer.destroy();
    primCache._morphStorageBuffer = undefined;
  }
  if (defined(primCache._morphWeightBufferPrev)) {
    primCache._morphWeightBufferPrev.destroy();
    primCache._morphWeightBufferPrev = undefined;
  }
  if (defined(primCache._morphWeightBuffer)) {
    primCache._morphWeightBuffer.destroy();
    primCache._morphWeightBuffer = undefined;
  }
  primCache._morphWeightData = undefined;
}

export {
  ensureMorphTargetResources,
  destroyMorphTargetResources,
  MAX_MORPH_TARGETS,
  MORPH_UNIFORM_SIZE,
};
export default {
  ensureMorphTargetResources,
  destroyMorphTargetResources,
  MAX_MORPH_TARGETS,
  MORPH_UNIFORM_SIZE,
};
