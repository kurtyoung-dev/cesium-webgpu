import BlendingState from "../Scene/BlendingState.js";
import Buffer from "./Buffer.js";
import BufferUsage from "./BufferUsage.js";
import ComponentDatatype from "../Core/ComponentDatatype.js";
import DrawCommand from "./DrawCommand.js";
import EncodedCartesian3 from "../Core/EncodedCartesian3.js";
import Pass from "./Pass.js";
import RenderState from "./RenderState.js";
import ShaderProgram from "./ShaderProgram.js";
import VertexArray from "./VertexArray.js";
import WebGLConstants from "../Core/WebGLConstants.js";
import defined from "../Core/defined.js";
import ComputeInstanceWebGLVS from "../Shaders/ComputeInstanceWebGLVS.js";
import ComputeInstanceWebGLFS from "../Shaders/ComputeInstanceWebGLFS.js";

/**
 * WebGL2 CPU-kernel fallback renderer for `ComputeInstanceCollection`
 * (NEW-COMPUTE-INSTANCE-WEBGL2-FALLBACK).
 *
 * WebGL2 has no compute shaders, so the user's WGSL `kernel` (the thing the
 * WebGPU backend dispatches each frame) cannot run here. This renderer is the
 * non-compute path: each frame it runs the collection's optional JS
 * `cpuKernel` — `(out, index, timeSeconds, params) => void`, writing
 * `out.position` (a Cartesian3-shaped {x,y,z} in absolute ECEF meters),
 * `out.color` ({red,green,blue,alpha} in [0,1]) and `out.pixelSize` (px) — over
 * every instance on the main thread, RTE-splits each position with the SAME
 * AGI high/low encode the WebGPU scaffold's records reconstruct against
 * (`EncodedCartesian3`), packs the per-instance records into a dynamic vertex
 * buffer, and issues ONE instanced quad draw (`ComputeInstanceWebGLVS/FS`,
 * 6 verts × N instances) that mirrors `ComputeInstanceRender.wgsl`'s vertex
 * layout and quad expansion. Positions therefore land on screen at the same
 * place the WebGPU compute leg puts them (within f32 tolerance), and the dots
 * move purely from the per-frame `timeSeconds` scalar.
 *
 * Backend-agnostic seam: this module lives under `Renderer/` (NOT
 * `Renderer/WebGPU/`), so the WebGL `Context` can register it under
 * `FeatureRendererKey.COMPUTE_INSTANCE_COLLECTION`. `ComputeInstanceCollection`
 * reaches it through `context.getFeatureRenderer(...)` exactly like the WebGPU
 * leg — the scene file never imports a backend renderer.
 *
 * When the collection has NO `cpuKernel`, this renderer renders nothing (the
 * historical WebGL behavior). The WGSL `kernel` is never interpreted on the
 * CPU — the two kernels share an element layout by the demo's contract, not by
 * the engine transpiling WGSL.
 *
 * Main-thread is acceptable for v1; a Worker + the now-loadable WASM bridge
 * (createTaskProcessorWorker/transferable) is the tracked enhancement
 * (NEW-COMPUTE-INSTANCE-WEBGL2-WORKER in DEFERRED_WORK.md).
 *
 * @private
 */

// Per-instance record stride (floats): positionHigh(3) + positionLow(3) +
// color(4) + pixelSize(1) = 11. Mirrors the WGSL InstanceRecord fields (the
// WebGL packing is tight — no std140 padding — because these are plain vertex
// attributes, not a storage-buffer struct).
const FLOATS_PER_RECORD = 11;

// Shared [-1,1] quad — 6 vertices, 2 triangles. Same shape as the WGSL quad
// VB (createQuadVB in WebGPUComputeInstanceRenderer).
const QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

// Attribute 0 MUST be the non-instanced quad corner: WebGL forbids attribute
// 0 from carrying an instanceDivisor. The four per-instance attributes follow.
const attributeLocations = {
  quadPos: 0,
  positionHigh: 1,
  positionLow: 2,
  color: 3,
  pixelSize: 4,
};

// Reusable scratch so the per-frame CPU kernel loop allocates nothing.
const scratchKernelOut = {
  position: { x: 0, y: 0, z: 0 },
  color: { red: 1, green: 1, blue: 1, alpha: 1 },
  pixelSize: 1,
};
const scratchEncoded = { high: 0.0, low: 0.0 };

function getCache(collection) {
  let cache = collection._webglCache;
  if (!defined(cache)) {
    cache = collection._webglCache = {
      quadBuffer: undefined,
      instanceBuffer: undefined,
      instanceData: undefined, // Float32Array, FLOATS_PER_RECORD * capacity
      capacity: 0,
      vertexArray: undefined,
      shaderProgram: undefined,
      renderState: undefined,
      command: undefined,
      lastInstanceCount: -1,
    };
  }
  return cache;
}

function ensureShader(context, cache) {
  if (defined(cache.shaderProgram)) {
    return;
  }
  cache.shaderProgram = ShaderProgram.fromCache({
    context: context,
    vertexShaderSource: ComputeInstanceWebGLVS,
    fragmentShaderSource: ComputeInstanceWebGLFS,
    attributeLocations: attributeLocations,
  });
  cache.renderState = RenderState.fromCache({
    depthTest: {
      enabled: true,
      func: WebGLConstants.LEQUAL,
    },
    // Translucent dots — write color, not depth (matches the WGSL render
    // pipeline's depthWriteEnabled:false + alpha blend).
    depthMask: false,
    blending: BlendingState.ALPHA_BLEND,
  });
}

function ensureQuadBuffer(context, cache) {
  if (defined(cache.quadBuffer)) {
    return;
  }
  cache.quadBuffer = Buffer.createVertexBuffer({
    context: context,
    typedArray: QUAD,
    usage: BufferUsage.STATIC_DRAW,
  });
  cache.quadBuffer.vertexArrayDestroyable = false;
}

// (Re)allocate the per-instance vertex buffer + the VAO when the capacity must
// grow. The instance data is uploaded fresh every frame (the kernel runs every
// frame), so the buffer usage is DYNAMIC_DRAW.
function ensureInstanceResources(context, cache, count) {
  if (count <= cache.capacity && defined(cache.vertexArray)) {
    return;
  }
  const capacity = Math.max(count, cache.capacity * 2, 64);
  cache.instanceData = new Float32Array(capacity * FLOATS_PER_RECORD);
  cache.capacity = capacity;

  // Destroy the old VAO FIRST — it OWNS the old instance buffer
  // (vertexArrayDestroyable defaults true), so its destroy frees that buffer.
  // Recreating the instance buffer separately first would double-free it.
  cache.vertexArray = cache.vertexArray && cache.vertexArray.destroy();
  cache.instanceBuffer = Buffer.createVertexBuffer({
    context: context,
    sizeInBytes: capacity * FLOATS_PER_RECORD * Float32Array.BYTES_PER_ELEMENT,
    usage: BufferUsage.DYNAMIC_DRAW,
  });

  const stride = FLOATS_PER_RECORD * Float32Array.BYTES_PER_ELEMENT;
  const F = ComponentDatatype.FLOAT;
  const attributes = [
    {
      index: attributeLocations.quadPos,
      vertexBuffer: cache.quadBuffer,
      componentsPerAttribute: 2,
      componentDatatype: F,
    },
    {
      index: attributeLocations.positionHigh,
      vertexBuffer: cache.instanceBuffer,
      componentsPerAttribute: 3,
      componentDatatype: F,
      offsetInBytes: 0,
      strideInBytes: stride,
      instanceDivisor: 1,
    },
    {
      index: attributeLocations.positionLow,
      vertexBuffer: cache.instanceBuffer,
      componentsPerAttribute: 3,
      componentDatatype: F,
      offsetInBytes: 3 * 4,
      strideInBytes: stride,
      instanceDivisor: 1,
    },
    {
      index: attributeLocations.color,
      vertexBuffer: cache.instanceBuffer,
      componentsPerAttribute: 4,
      componentDatatype: F,
      offsetInBytes: 6 * 4,
      strideInBytes: stride,
      instanceDivisor: 1,
    },
    {
      index: attributeLocations.pixelSize,
      vertexBuffer: cache.instanceBuffer,
      componentsPerAttribute: 1,
      componentDatatype: F,
      offsetInBytes: 10 * 4,
      strideInBytes: stride,
      instanceDivisor: 1,
    },
  ];

  cache.vertexArray = new VertexArray({
    context: context,
    attributes: attributes,
  });
  // The command holds the VAO reference; force a rebind next push.
  cache.command = undefined;
}

// Run the CPU kernel over every instance and pack the RTE-split records into
// the staging Float32Array. Returns the number of records written.
function packInstances(collection, count, timeSeconds) {
  const cpuKernel = collection._cpuKernel;
  const params = collection._paramsData;
  const data = collection._webglCache.instanceData;
  const out = scratchKernelOut;

  for (let i = 0; i < count; i++) {
    // Reset the scratch so a kernel that leaves a field untouched gets the
    // documented default (opaque white, 1 px) rather than the previous
    // instance's leftover value.
    out.color.red = 1.0;
    out.color.green = 1.0;
    out.color.blue = 1.0;
    out.color.alpha = 1.0;
    out.pixelSize = 1.0;
    cpuKernel(out, i, timeSeconds, params);

    const o = i * FLOATS_PER_RECORD;
    // AGI high/low split per component — the SAME encode the WebGPU records
    // reconstruct against (czm_translateRelativeToEye subtracts the matching
    // encoded camera high/low). This gives the WebGL leg a meaningful low
    // part (better than the WGSL f32 kernel's low=0) while landing the dot at
    // the same absolute position.
    EncodedCartesian3.encode(out.position.x, scratchEncoded);
    data[o] = scratchEncoded.high;
    data[o + 3] = scratchEncoded.low;
    EncodedCartesian3.encode(out.position.y, scratchEncoded);
    data[o + 1] = scratchEncoded.high;
    data[o + 4] = scratchEncoded.low;
    EncodedCartesian3.encode(out.position.z, scratchEncoded);
    data[o + 2] = scratchEncoded.high;
    data[o + 5] = scratchEncoded.low;

    data[o + 6] = out.color.red;
    data[o + 7] = out.color.green;
    data[o + 8] = out.color.blue;
    data[o + 9] = out.color.alpha;
    data[o + 10] = out.pixelSize;
  }
  return count;
}

/**
 * Per-frame update entry — registered under
 * `FeatureRendererKey.COMPUTE_INSTANCE_COLLECTION` on the WebGL `Context`.
 * `ComputeInstanceCollection.update` derives `_simulationTimeSeconds` (the
 * scene-clock-relative sim time, the SAME source the WebGPU leg uses) BEFORE
 * routing here, so both backends animate from one time source.
 *
 * @param {ComputeInstanceCollection} collection
 * @param {FrameState} frameState
 * @private
 */
function updateWebGLComputeInstanceCollection(collection, frameState) {
  // No CPU kernel → nothing to render on WebGL2 (historical behavior). The
  // WGSL `kernel` is never run on the CPU.
  const cpuKernel = collection._cpuKernel;
  if (
    collection.show === false ||
    !defined(cpuKernel) ||
    collection.length === 0
  ) {
    return;
  }
  if (!frameState.passes.render) {
    return;
  }

  const context = frameState.context;
  const cache = getCache(collection);
  const count = collection.length;

  ensureShader(context, cache);
  ensureQuadBuffer(context, cache);
  ensureInstanceResources(context, cache, count);

  const timeSeconds = collection._simulationTimeSeconds ?? 0;
  packInstances(collection, count, timeSeconds);

  // Upload this frame's records. copyFromArrayView writes the populated
  // sub-range; the buffer is sized to capacity so a shrunk count just leaves
  // stale tail records that the instanceCount below never references.
  cache.instanceBuffer.copyFromArrayView(
    cache.instanceData.subarray(0, count * FLOATS_PER_RECORD),
    0,
  );

  if (!defined(cache.command)) {
    cache.command = new DrawCommand({
      vertexArray: cache.vertexArray,
      shaderProgram: cache.shaderProgram,
      renderState: cache.renderState,
      pass: Pass.TRANSLUCENT,
      count: 6,
      owner: collection,
    });
  }
  const command = cache.command;
  command.instanceCount = count;
  // Bounding volume is a user contract (positions are produced by the kernel,
  // not known to the engine) — mirror the WebGPU leg: cull/bin when supplied,
  // never-cull when absent.
  const boundingSphere = collection.boundingSphere;
  command.boundingVolume = boundingSphere;
  command.cull = defined(boundingSphere);

  frameState.commandList.push(command);
}

/**
 * Release the WebGL resources this renderer allocated for the collection.
 * @param {ComputeInstanceCollection} collection
 * @private
 */
function destroyWebGLComputeInstanceResources(collection) {
  const cache = collection._webglCache;
  if (!defined(cache)) {
    return;
  }
  // The quad buffer is flagged not-vertexArrayDestroyable, so the VAO destroy
  // won't take it; destroy it explicitly. The instance buffer IS owned by the
  // VAO, so destroying the VAO frees it.
  cache.vertexArray = cache.vertexArray && cache.vertexArray.destroy();
  cache.quadBuffer = cache.quadBuffer && cache.quadBuffer.destroy();
  // ShaderProgram came from the cache (ref-counted) — release, don't destroy.
  cache.shaderProgram = cache.shaderProgram && cache.shaderProgram.destroy();
  collection._webglCache = undefined;
}

export {
  updateWebGLComputeInstanceCollection,
  destroyWebGLComputeInstanceResources,
};
export default {
  updateWebGLComputeInstanceCollection,
  destroyWebGLComputeInstanceResources,
};
