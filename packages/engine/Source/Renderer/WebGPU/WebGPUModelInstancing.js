/**
 * Packs instance transforms into a GPU storage buffer for WebGPU model
 * rendering via EXT_mesh_gpu_instancing or i3dm.
 *
 * Instance transforms are static per glTF spec — they're computed once
 * from TRANSLATION/ROTATION/SCALE attributes and cached for the lifetime
 * of the model.
 *
 * Storage buffer layout: array<InstanceTransform> (DP-H36, Batch 325)
 *   Each instance is 24 floats / 96 bytes:
 *     linear:          mat4x4<f32>  floats  0..15  (rotation+scale, col3 zeroed)
 *     translationHigh: vec4<f32>    floats 16..19  (.xyz used, .w pad)
 *     translationLow:  vec4<f32>    floats 20..23  (.xyz used, .w pad)
 *
 * RTE precision (DP-H36): the per-instance translation places each instance
 * at its tile-relative ECEF offset, which at Earth scale (~6.4e6 m) exceeds
 * f32's ~2^23 mantissa and loses sub-meter precision. The translation is
 * split into high/low (EncodedCartesian3) so the vertex shader can RTE it
 * against the encoded camera instead of adding a raw f32 column — which
 * caused stationary-camera i3dm jitter. The linear (rotation+scale) part
 * stays single-precision (small magnitude, no precision risk).
 *
 * The WebGL InstancingPipelineStage caches packed transforms as a 12-float
 * per-instance format (3 rows of vec4, column-major); we read column 3 as
 * the translation and split it.
 *
 * @private
 * @module WebGPUModelInstancing
 */
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";

// DP-H36 (Batch 325) — per-instance storage stride. MUST stay byte-consistent
// with the WGSL `InstanceTransform` struct in ModelPBRComplete.wgsl and the
// default-buffer size in WebGPUModelPipelineCache.js.
const FLOATS_PER_INSTANCE = 24;

const scratchEncodeX = { high: 0.0, low: 0.0 };
const scratchEncodeY = { high: 0.0, low: 0.0 };
const scratchEncodeZ = { high: 0.0, low: 0.0 };

/**
 * Writes the linear (rotation+scale) 3x3 into the `linear` mat4x4 slot
 * (col3 zeroed) and the high/low split of the translation into the trailing
 * two vec4 slots.
 *
 * @param {Float32Array} out - destination, FLOATS_PER_INSTANCE-strided
 * @param {number} dst - base float offset for this instance
 * @param {number} c0x @param {number} c0y @param {number} c0z - column 0
 * @param {number} c1x @param {number} c1y @param {number} c1z - column 1
 * @param {number} c2x @param {number} c2y @param {number} c2z - column 2
 * @param {number} tx @param {number} ty @param {number} tz - translation
 * @private
 */
function writeInstance(
  out,
  dst,
  c0x,
  c0y,
  c0z,
  c1x,
  c1y,
  c1z,
  c2x,
  c2y,
  c2z,
  tx,
  ty,
  tz,
) {
  // linear mat4x4 (column-major); translation column zeroed — RTE handles it
  out[dst + 0] = c0x;
  out[dst + 1] = c0y;
  out[dst + 2] = c0z;
  out[dst + 3] = 0.0;
  out[dst + 4] = c1x;
  out[dst + 5] = c1y;
  out[dst + 6] = c1z;
  out[dst + 7] = 0.0;
  out[dst + 8] = c2x;
  out[dst + 9] = c2y;
  out[dst + 10] = c2z;
  out[dst + 11] = 0.0;
  out[dst + 12] = 0.0;
  out[dst + 13] = 0.0;
  out[dst + 14] = 0.0;
  out[dst + 15] = 1.0;

  // translationHigh.xyz (+ pad), translationLow.xyz (+ pad)
  EncodedCartesian3.encode(tx, scratchEncodeX);
  EncodedCartesian3.encode(ty, scratchEncodeY);
  EncodedCartesian3.encode(tz, scratchEncodeZ);
  out[dst + 16] = scratchEncodeX.high;
  out[dst + 17] = scratchEncodeY.high;
  out[dst + 18] = scratchEncodeZ.high;
  out[dst + 19] = 0.0;
  out[dst + 20] = scratchEncodeX.low;
  out[dst + 21] = scratchEncodeY.low;
  out[dst + 22] = scratchEncodeZ.low;
  out[dst + 23] = 0.0;
}

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
  let instanceData;

  if (defined(packedData)) {
    instanceData = expandPackedTransforms(packedData, count);
  } else {
    // Fallback: try to read from attribute typed arrays directly
    instanceData = extractTransformsFromAttributes(instances, count);
  }

  if (!defined(instanceData)) {
    return null;
  }

  // Create GPU storage buffer (FLOATS_PER_INSTANCE-strided InstanceTransform)
  const bufferSize = instanceData.byteLength;
  const storageBuffer = device.createBuffer({
    label: `Instance transforms (${count} instances)`,
    size: bufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(storageBuffer, 0, instanceData);

  nodeCache.instancingBuffer = storageBuffer;
  nodeCache.instanceCount = count;

  return {
    storageBuffer: storageBuffer,
    instanceCount: count,
  };
}

/**
 * Expands the 12-float packed transform format (from InstancingPipelineStage)
 * into the 24-float `InstanceTransform` storage layout (DP-H36).
 *
 * Input format (per instance, 12 floats — transposed 3x4):
 *   [col0.x, col1.x, col2.x, col3.x,  // row 0
 *    col0.y, col1.y, col2.y, col3.y,  // row 1
 *    col0.z, col1.z, col2.z, col3.z]  // row 2
 *
 * Output: see writeInstance — linear mat4x4 (col3 zeroed) + split translation.
 *
 * @param {Float32Array} packed - 12 floats per instance, transposed row format
 * @param {number} count - Number of instances
 * @returns {Float32Array} FLOATS_PER_INSTANCE floats per instance
 * @private
 */
function expandPackedTransforms(packed, count) {
  const data = new Float32Array(count * FLOATS_PER_INSTANCE);
  for (let i = 0; i < count; i++) {
    const src = i * 12;
    const dst = i * FLOATS_PER_INSTANCE;

    // Row 0: [col0.x, col1.x, col2.x, col3.x]
    // Row 1: [col0.y, col1.y, col2.y, col3.y]
    // Row 2: [col0.z, col1.z, col2.z, col3.z]
    // col3 = translation (tx, ty, tz)
    writeInstance(
      data,
      dst,
      packed[src + 0], // col0.x
      packed[src + 4], // col0.y
      packed[src + 8], // col0.z
      packed[src + 1], // col1.x
      packed[src + 5], // col1.y
      packed[src + 9], // col1.z
      packed[src + 2], // col2.x
      packed[src + 6], // col2.y
      packed[src + 10], // col2.z
      packed[src + 3], // tx (col3.x)
      packed[src + 7], // ty (col3.y)
      packed[src + 11], // tz (col3.z)
    );
  }
  return data;
}

/**
 * Fallback: extract transforms directly from instance attribute typed arrays.
 * Only works if typed arrays haven't been consumed yet.
 *
 * @param {object} instances - node.instances from ModelComponents
 * @param {number} count
 * @returns {Float32Array|null} FLOATS_PER_INSTANCE floats per instance, or null
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

  const data = new Float32Array(count * FLOATS_PER_INSTANCE);

  for (let i = 0; i < count; i++) {
    const dst = i * FLOATS_PER_INSTANCE;
    const tx = defined(translationData) ? translationData[i * 3] : 0;
    const ty = defined(translationData) ? translationData[i * 3 + 1] : 0;
    const tz = defined(translationData) ? translationData[i * 3 + 2] : 0;
    const sx = defined(scaleData) ? scaleData[i * 3] : 1;
    const sy = defined(scaleData) ? scaleData[i * 3 + 1] : 1;
    const sz = defined(scaleData) ? scaleData[i * 3 + 2] : 1;

    // Linear (rotation+scale) part as three columns; translation is split
    // separately inside writeInstance (DP-H36).
    let c0x, c0y, c0z, c1x, c1y, c1z, c2x, c2y, c2z;
    if (defined(rotationData)) {
      // Build rotation*scale columns from quaternion (column-major)
      const qx = rotationData[i * 4];
      const qy = rotationData[i * 4 + 1];
      const qz = rotationData[i * 4 + 2];
      const qw = rotationData[i * 4 + 3];

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

      c0x = (1 - (yy + zz)) * sx;
      c0y = (xy + wz) * sx;
      c0z = (xz - wy) * sx;
      c1x = (xy - wz) * sy;
      c1y = (1 - (xx + zz)) * sy;
      c1z = (yz + wx) * sy;
      c2x = (xz + wy) * sz;
      c2y = (yz - wx) * sz;
      c2z = (1 - (xx + yy)) * sz;
    } else {
      // Scale-only (no rotation)
      c0x = sx;
      c0y = 0;
      c0z = 0;
      c1x = 0;
      c1y = sy;
      c1z = 0;
      c2x = 0;
      c2y = 0;
      c2z = sz;
    }

    writeInstance(
      data,
      dst,
      c0x,
      c0y,
      c0z,
      c1x,
      c1y,
      c1z,
      c2x,
      c2y,
      c2z,
      tx,
      ty,
      tz,
    );
  }

  return data;
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
