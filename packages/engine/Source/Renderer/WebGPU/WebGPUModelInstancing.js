/**
 * @module WebGPUModelInstancing
 *
 * Packs instance transforms into a GPU storage buffer for WebGPU model
 * rendering via EXT_mesh_gpu_instancing or i3dm.
 *
 * Instance transforms are static per glTF spec — they're computed once
 * from TRANSLATION/ROTATION/SCALE attributes and cached for the lifetime
 * of the model.
 *
 * Storage buffer layout: array<mat4x4<f32>>
 *   Each instance has 16 floats (a full 4x4 matrix).
 *
 * The WebGL InstancingPipelineStage caches packed transforms as a 12-float
 * per-instance format (3 rows of vec4, column-major). We expand these to
 * full mat4x4 (16 floats) for the storage buffer.
 *
 * @private
 */
import defined from "../../Core/defined.js";

/**
 * Creates or retrieves cached instancing GPU resources for a runtime node.
 *
 * Reads from runtimeNode.transformsTypedArray (set by InstancingPipelineStage
 * when keepTypedArray is true, which includes WebGPU contexts).
 *
 * @param {GPUDevice} device
 * @param {object} nodeCache - Per-node cache from WebGPUModelRenderer
 * @param {object} runtimeNode - The ModelRuntimeNode
 * @returns {object|null} { storageBuffer, instanceCount } or null
 */
function ensureInstancingResources(device, nodeCache, runtimeNode) {
  // Already created — return cached
  if (defined(nodeCache.instancingBuffer)) {
    return {
      storageBuffer: nodeCache.instancingBuffer,
      instanceCount: nodeCache.instanceCount,
    };
  }

  const node = runtimeNode.node || runtimeNode._node;
  if (!defined(node) || !defined(node.instances)) {
    return null;
  }

  const instances = node.instances;
  const count = instances.attributes[0].count;
  if (count <= 0) {
    return null;
  }

  // Try the packed typed array cached by InstancingPipelineStage
  const packedData = runtimeNode.transformsTypedArray;
  let mat4Data;

  if (defined(packedData)) {
    mat4Data = expandPackedTransforms(packedData, count);
  } else {
    // Fallback: try to read from attribute typed arrays directly
    mat4Data = extractTransformsFromAttributes(instances, count);
  }

  if (!defined(mat4Data)) {
    return null;
  }

  // Create GPU storage buffer
  const bufferSize = mat4Data.byteLength;
  const storageBuffer = device.createBuffer({
    label: `Instance transforms (${count} instances)`,
    size: bufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(storageBuffer, 0, mat4Data);

  nodeCache.instancingBuffer = storageBuffer;
  nodeCache.instanceCount = count;

  return {
    storageBuffer: storageBuffer,
    instanceCount: count,
  };
}

/**
 * Expands the 12-float packed transform format (from InstancingPipelineStage)
 * into full 16-float mat4x4 for the storage buffer.
 *
 * Input format (per instance, 12 floats — transposed 3x4):
 *   [col0.x, col1.x, col2.x, col3.x,  // row 0
 *    col0.y, col1.y, col2.y, col3.y,  // row 1
 *    col0.z, col1.z, col2.z, col3.z]  // row 2
 *
 * Output format (per instance, 16 floats — column-major mat4x4):
 *   [col0.x, col0.y, col0.z, 0,
 *    col1.x, col1.y, col1.z, 0,
 *    col2.x, col2.y, col2.z, 0,
 *    col3.x, col3.y, col3.z, 1]
 *
 * @param {Float32Array} packed - 12 floats per instance, transposed row format
 * @param {number} count - Number of instances
 * @returns {Float32Array} 16 floats per instance, column-major mat4x4
 * @private
 */
function expandPackedTransforms(packed, count) {
  const mat4Data = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) {
    const src = i * 12;
    const dst = i * 16;

    // Row 0: [col0.x, col1.x, col2.x, col3.x]
    // Row 1: [col0.y, col1.y, col2.y, col3.y]
    // Row 2: [col0.z, col1.z, col2.z, col3.z]
    //
    // Column-major output for WGSL mat4x4:
    // col0: (row0[0], row1[0], row2[0], 0)
    // col1: (row0[1], row1[1], row2[1], 0)
    // col2: (row0[2], row1[2], row2[2], 0)
    // col3: (row0[3], row1[3], row2[3], 1)

    // Column 0
    mat4Data[dst + 0] = packed[src + 0]; // col0.x
    mat4Data[dst + 1] = packed[src + 4]; // col0.y
    mat4Data[dst + 2] = packed[src + 8]; // col0.z
    mat4Data[dst + 3] = 0.0;

    // Column 1
    mat4Data[dst + 4] = packed[src + 1]; // col1.x
    mat4Data[dst + 5] = packed[src + 5]; // col1.y
    mat4Data[dst + 6] = packed[src + 9]; // col1.z
    mat4Data[dst + 7] = 0.0;

    // Column 2
    mat4Data[dst + 8] = packed[src + 2]; // col2.x
    mat4Data[dst + 9] = packed[src + 6]; // col2.y
    mat4Data[dst + 10] = packed[src + 10]; // col2.z
    mat4Data[dst + 11] = 0.0;

    // Column 3 (translation)
    mat4Data[dst + 12] = packed[src + 3]; // col3.x (tx)
    mat4Data[dst + 13] = packed[src + 7]; // col3.y (ty)
    mat4Data[dst + 14] = packed[src + 11]; // col3.z (tz)
    mat4Data[dst + 15] = 1.0;
  }
  return mat4Data;
}

/**
 * Fallback: extract transforms directly from instance attribute typed arrays.
 * Only works if typed arrays haven't been consumed yet.
 *
 * @param {object} instances - node.instances from ModelComponents
 * @param {number} count
 * @returns {Float32Array|null} 16 floats per instance, or null
 * @private
 */
function extractTransformsFromAttributes(instances, count) {
  const attrs = instances.attributes;
  let translationData = null;
  let rotationData = null;
  let scaleData = null;

  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    const semantic = attr.semantic;
    if (semantic === "TRANSLATION" && defined(attr.typedArray)) {
      translationData = attr.typedArray;
    } else if (semantic === "ROTATION" && defined(attr.typedArray)) {
      rotationData = attr.typedArray;
    } else if (semantic === "SCALE" && defined(attr.typedArray)) {
      scaleData = attr.typedArray;
    }
  }

  // Need at least translation (or all zero = identity position)
  if (
    !defined(translationData) &&
    !defined(rotationData) &&
    !defined(scaleData)
  ) {
    return null;
  }

  const mat4Data = new Float32Array(count * 16);

  for (let i = 0; i < count; i++) {
    const dst = i * 16;
    const tx = defined(translationData) ? translationData[i * 3] : 0;
    const ty = defined(translationData) ? translationData[i * 3 + 1] : 0;
    const tz = defined(translationData) ? translationData[i * 3 + 2] : 0;
    const sx = defined(scaleData) ? scaleData[i * 3] : 1;
    const sy = defined(scaleData) ? scaleData[i * 3 + 1] : 1;
    const sz = defined(scaleData) ? scaleData[i * 3 + 2] : 1;

    if (defined(rotationData)) {
      // Build matrix from TRS with quaternion rotation
      const qx = rotationData[i * 4];
      const qy = rotationData[i * 4 + 1];
      const qz = rotationData[i * 4 + 2];
      const qw = rotationData[i * 4 + 3];

      // Rotation matrix from quaternion (column-major)
      const x2 = qx + qx,
        y2 = qy + qy,
        z2 = qz + qz;
      const xx = qx * x2,
        xy = qx * y2,
        xz = qx * z2;
      const yy = qy * y2,
        yz = qy * z2,
        zz = qz * z2;
      const wx = qw * x2,
        wy = qw * y2,
        wz = qw * z2;

      mat4Data[dst + 0] = (1 - (yy + zz)) * sx;
      mat4Data[dst + 1] = (xy + wz) * sx;
      mat4Data[dst + 2] = (xz - wy) * sx;
      mat4Data[dst + 3] = 0;
      mat4Data[dst + 4] = (xy - wz) * sy;
      mat4Data[dst + 5] = (1 - (xx + zz)) * sy;
      mat4Data[dst + 6] = (yz + wx) * sy;
      mat4Data[dst + 7] = 0;
      mat4Data[dst + 8] = (xz + wy) * sz;
      mat4Data[dst + 9] = (yz - wx) * sz;
      mat4Data[dst + 10] = (1 - (xx + yy)) * sz;
      mat4Data[dst + 11] = 0;
    } else {
      // Scale-only (no rotation)
      mat4Data[dst + 0] = sx;
      mat4Data[dst + 1] = 0;
      mat4Data[dst + 2] = 0;
      mat4Data[dst + 3] = 0;
      mat4Data[dst + 4] = 0;
      mat4Data[dst + 5] = sy;
      mat4Data[dst + 6] = 0;
      mat4Data[dst + 7] = 0;
      mat4Data[dst + 8] = 0;
      mat4Data[dst + 9] = 0;
      mat4Data[dst + 10] = sz;
      mat4Data[dst + 11] = 0;
    }

    // Translation column
    mat4Data[dst + 12] = tx;
    mat4Data[dst + 13] = ty;
    mat4Data[dst + 14] = tz;
    mat4Data[dst + 15] = 1;
  }

  return mat4Data;
}

/**
 * Destroys instancing GPU resources.
 * @param {object} nodeCache - Per-node cache
 */
function destroyInstancingResources(nodeCache) {
  if (defined(nodeCache.instancingBuffer)) {
    nodeCache.instancingBuffer.destroy();
    nodeCache.instancingBuffer = undefined;
  }
  nodeCache.instanceCount = undefined;
}

export { ensureInstancingResources, destroyInstancingResources };
export default {
  ensureInstancingResources,
  destroyInstancingResources,
};
