/**
 * Packs morph target deltas into a GPU storage buffer and morph weights
 * into a uniform buffer for WebGPU model rendering.
 *
 * Storage buffer layout (DP-H35, Batch 329 — interleaved POSITION + NORMAL):
 *   [target0_posX, target0_posY, target0_posZ, pad,  // vertex 0, target 0 — POSITION
 *    target0_nrmX, target0_nrmY, target0_nrmZ, pad,  // vertex 0, target 0 — NORMAL
 *    target0_posX, target0_posY, target0_posZ, pad,  // vertex 1, target 0 — POSITION
 *    target0_nrmX, target0_nrmY, target0_nrmZ, pad,  // vertex 1, target 0 — NORMAL
 *    ...
 *    target1_posX, target1_posY, target1_posZ, pad,  // vertex 0, target 1 — POSITION
 *    target1_nrmX, target1_nrmY, target1_nrmZ, pad,  // vertex 0, target 1 — NORMAL
 *    ...]
 *
 * Each vertex contributes TWO vec4s per target: [positionDelta, normalDelta].
 * A morph target with no NORMAL accessor writes a zero normal delta, so the
 * WGSL normal accumulation is a no-op for it (matches the WebGL path, which
 * only emits getMorphedNormal when the target carries a NORMAL delta).
 * The CPU pack stride (FLOATS_PER_VERTEX_PER_TARGET = 12) MUST stay in lockstep
 * with the WGSL morph indexing (base = (t*vertexCount + vid) * 3u).
 *
 * Weights are packed into a vec4 array (4 weights per vec4) in a
 * uniform buffer. Max 8 morph targets supported per primitive.
 *
 * @private
 * @module WebGPUModelMorphTargets
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
 * @param {boolean} [resetPreviousToCurrent=false] Whether a visibility-admission
 *        gap requires previous weights to match the current pose.
 * @returns {object|null} Morph target resources, or null if no morph targets
 */
function ensureMorphTargetResources(
  device,
  primCache,
  geometry,
  morphWeights,
  resetPreviousToCurrent = false,
) {
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
  if (!resetPreviousToCurrent) {
    primCache._morphWeightDataPrev.set(primCache._morphWeightData);
    device.queue.writeBuffer(
      primCache._morphWeightBufferPrev.buffer,
      0,
      primCache._morphWeightDataPrev.buffer,
      0,
      MORPH_UNIFORM_SIZE,
    );
  }

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

  // C11-185 — after one or more rejected frames, the previous GPU pose is the
  // last visible pose, not t-1. Reset it to the just-packed current pose so TAA
  // sees zero velocity on readmission instead of a multi-frame jump.
  if (resetPreviousToCurrent) {
    primCache._morphWeightDataPrev.set(weightData);
    device.queue.writeBuffer(
      primCache._morphWeightBufferPrev.buffer,
      0,
      primCache._morphWeightDataPrev.buffer,
      0,
      MORPH_UNIFORM_SIZE,
    );
  }

  return {
    storageBuffer: primCache._morphStorageBuffer,
    weightBuffer: primCache._morphWeightBuffer.buffer,
    weightBufferPrev: primCache._morphWeightBufferPrev.buffer,
    targetCount: targetCount,
  };
}

// DP-H35 (Batch 329) added a NORMAL vec4 after POSITION so morphed normals
// re-shade the deformed surface (WebGL morphs normals via getMorphedNormal;
// WebGPU previously froze them at the rest pose → frozen lighting on a
// morph-animated mesh).
// C2-4 (Batch 373): +TANGENT vec4 — each vertex now carries POSITION, NORMAL,
// then TANGENT (12 floats), so a normal-mapped morphed mesh keeps a correct
// tangent frame (the WebGL path morphs tangents via getMorphedTangent). This
// constant is the lockstep anchor: it MUST match the *3u stride the WGSL morph
// blocks (current + TAA-prev) use to step from one vertex's [pos,nrm,tan]
// triple to the next.
const FLOATS_PER_VERTEX_PER_TARGET = 12; // POSITION vec4 (4) + NORMAL vec4 (4) + TANGENT vec4 (4)

/**
 * Pack morph target position + normal + tangent deltas into a Float32Array for
 * the storage buffer. Layout: per-target blocks of (vertexCount × 12 floats) —
 * three vec4-padded entries per vertex (positionDelta, normalDelta, tangentDelta).
 *
 * @param {object[]} morphTargets - Array of { positionData, normalData, tangentData }
 * @param {number} targetCount
 * @param {number} vertexCount
 * @returns {Float32Array}
 * @private
 */
function packMorphTargetDeltas(morphTargets, targetCount, vertexCount) {
  const floatsPerTarget = vertexCount * FLOATS_PER_VERTEX_PER_TARGET;
  const totalFloats = floatsPerTarget * targetCount;
  const packed = new Float32Array(totalFloats);

  for (let t = 0; t < targetCount; t++) {
    const target = morphTargets[t];
    const posData = target.positionData;
    // normalData is optional per glTF — a target without a NORMAL accessor
    // leaves the (zero-initialized) normal slot at zero, making the WGSL
    // normal accumulation a no-op for that target (parity with WebGL).
    const normalData = target.normalData;
    // tangentData is optional per glTF — a target without a TANGENT accessor
    // leaves the (zero-initialized) tangent slot at zero, making the WGSL
    // tangent accumulation a no-op for that target (parity with WebGL).
    const tangentData = target.tangentData;
    const baseOffset = t * floatsPerTarget;

    if (!defined(posData)) {
      continue;
    }

    const hasNormal = defined(normalData);
    const hasTangent = defined(tangentData);
    for (let v = 0; v < vertexCount; v++) {
      const srcIdx = v * 3;
      const dstIdx = baseOffset + v * FLOATS_PER_VERTEX_PER_TARGET;
      // POSITION delta (vec4 0)
      packed[dstIdx] = posData[srcIdx]; // x
      packed[dstIdx + 1] = posData[srcIdx + 1]; // y
      packed[dstIdx + 2] = posData[srcIdx + 2]; // z
      // packed[dstIdx + 3] = 0.0 (padding, already zero)
      // NORMAL delta (vec4 1)
      if (hasNormal) {
        packed[dstIdx + 4] = normalData[srcIdx]; // x
        packed[dstIdx + 5] = normalData[srcIdx + 1]; // y
        packed[dstIdx + 6] = normalData[srcIdx + 2]; // z
        // packed[dstIdx + 7] = 0.0 (padding, already zero)
      }
      // TANGENT delta (vec4 2) — VEC3 (the .w handedness is not morphed)
      if (hasTangent) {
        packed[dstIdx + 8] = tangentData[srcIdx]; // x
        packed[dstIdx + 9] = tangentData[srcIdx + 1]; // y
        packed[dstIdx + 10] = tangentData[srcIdx + 2]; // z
        // packed[dstIdx + 11] = 0.0 (padding, already zero)
      }
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
  // Exported for unit-test access to the CPU pack layout. packMorphTargetDeltas
  // + FLOATS_PER_VERTEX_PER_TARGET are the lockstep anchor that MUST stay in step
  // with the WGSL morph indexing (base = (t*vertexCount + vid) * 3u). @private.
  packMorphTargetDeltas,
  FLOATS_PER_VERTEX_PER_TARGET,
};
export default {
  ensureMorphTargetResources,
  destroyMorphTargetResources,
  MAX_MORPH_TARGETS,
  MORPH_UNIFORM_SIZE,
};
