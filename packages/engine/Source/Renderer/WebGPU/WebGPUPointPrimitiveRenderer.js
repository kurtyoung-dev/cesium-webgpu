/**
 * @module WebGPUPointPrimitiveRenderer
 *
 * Handles WebGPU rendering of PointPrimitiveCollection.
 * Points are rendered as instanced screen-space quads (6 vertices per point)
 * because WebGPU has no gl_PointSize/gl_PointCoord support.
 *
 * Instance data layout (64 bytes per point, 4 x vec4):
 *   @location(0) posHighAndSize:   vec4<f32> — position.xyz, pixelSize
 *   @location(1) posLowAndOutline: vec4<f32> — 0,0,0, outlineWidth
 *   @location(2) color:            vec4<f32> — color rgba
 *   @location(3) outColorAndShow:  vec4<f32> — outlineColor.rgb, show(0/1)
 *
 * Uniforms (256 bytes, aligned):
 *   mvpMatrix:    mat4x4<f32> (64 bytes)
 *   viewportSize: vec2<f32>   (8 bytes)
 *   splitPos:     f32         (4 bytes)
 *   pad:          f32         (4 bytes)
 *
 * @private
 */
import defined from "../../Core/defined.js";
import Matrix4 from "../../Core/Matrix4.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { getCollectionShaderSource } from "./WebGPUCollectionShaders.js";

// =========================================================================
// Constants
// =========================================================================

/** Floats per instance: 4 vec4 = 16 floats */
const FLOATS_PER_INSTANCE = 16;
/** Bytes per instance: 16 * 4 = 64 bytes */
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;
/** Vertices per quad: 6 (2 triangles, no index buffer needed) */
const VERTICES_PER_QUAD = 6;
/** Uniform buffer size (256-byte aligned) */
const UNIFORM_BUFFER_SIZE = 256;

// Scratch variables
const scratchMVP = new Matrix4();

// =========================================================================
// Instance Data Building
// =========================================================================

/**
 * Builds a Float32Array of per-instance data from the collection's point primitives.
 *
 * @param {PointPrimitiveCollection} collection - The point collection
 * @returns {{ instanceData: Float32Array, visibleCount: number }}
 * @private
 */
function buildInstanceData(collection) {
  const points = collection._pointPrimitives;
  const length = collection._pointPrimitivesLength;

  const instanceData = new Float32Array(length * FLOATS_PER_INSTANCE);
  let visibleCount = 0;

  for (let i = 0; i < length; i++) {
    const point = points[i];
    if (!defined(point)) {
      continue;
    }

    const offset = visibleCount * FLOATS_PER_INSTANCE;
    const position = point._actualPosition || point._position;

    // posHighAndSize: position.xyz, pixelSize
    instanceData[offset + 0] = position.x;
    instanceData[offset + 1] = position.y;
    instanceData[offset + 2] = position.z;
    instanceData[offset + 3] = point._pixelSize;

    // posLowAndOutline: 0, 0, 0, outlineWidth
    instanceData[offset + 4] = 0.0;
    instanceData[offset + 5] = 0.0;
    instanceData[offset + 6] = 0.0;
    instanceData[offset + 7] = point._outlineWidth;

    // color: rgba
    const color = point._color;
    instanceData[offset + 8] = color.red;
    instanceData[offset + 9] = color.green;
    instanceData[offset + 10] = color.blue;
    instanceData[offset + 11] = color.alpha;

    // outColorAndShow: outlineColor.rgb, show
    const outlineColor = point._outlineColor;
    instanceData[offset + 12] = outlineColor.red;
    instanceData[offset + 13] = outlineColor.green;
    instanceData[offset + 14] = outlineColor.blue;
    instanceData[offset + 15] = point._show ? 1.0 : 0.0;

    visibleCount++;
  }

  return { instanceData, visibleCount };
}

// =========================================================================
// Pipeline Creation
// =========================================================================

/**
 * Instance vertex buffer layout — step mode = instance, 64 bytes stride.
 * @private
 */
const INSTANCE_BUFFER_LAYOUT = {
  arrayStride: BYTES_PER_INSTANCE,
  stepMode: "instance",
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x4" }, // posHighAndSize
    { shaderLocation: 1, offset: 16, format: "float32x4" }, // posLowAndOutline
    { shaderLocation: 2, offset: 32, format: "float32x4" }, // color
    { shaderLocation: 3, offset: 48, format: "float32x4" }, // outColorAndShow
  ],
};

/**
 * Creates the render pipeline for point primitive rendering.
 *
 * @param {GPUDevice} device - The WebGPU device
 * @param {string} shaderCode - WGSL shader source
 * @param {GPUTextureFormat} format - Canvas presentation format
 * @param {GPUTextureFormat} depthFormat - Depth texture format
 * @param {boolean} [translucent=false] - Whether to enable alpha blending
 * @returns {{ pipeline: GPURenderPipeline, bindGroupLayout: GPUBindGroupLayout }}
 * @private
 */
function createPointPipeline(
  device,
  shaderCode,
  format,
  depthFormat,
  translucent,
) {
  const shaderModule = device.createShaderModule({
    label: "PointPrimitive shader",
    code: shaderCode,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    label: "PointPrimitive bind group layout",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    label: "PointPrimitive pipeline layout",
    bindGroupLayouts: [bindGroupLayout],
  });

  const blendState = translucent
    ? {
        color: {
          srcFactor: "src-alpha",
          dstFactor: "one-minus-src-alpha",
          operation: "add",
        },
        alpha: {
          srcFactor: "one",
          dstFactor: "one-minus-src-alpha",
          operation: "add",
        },
      }
    : undefined;

  const pipeline = device.createRenderPipeline({
    label: `PointPrimitive pipeline (${translucent ? "translucent" : "opaque"})`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [INSTANCE_BUFFER_LAYOUT],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [
        {
          format: format,
          blend: blendState,
        },
      ],
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "none",
    },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: !translucent,
      depthCompare: "less-equal",
    },
  });

  return { pipeline, bindGroupLayout };
}

// =========================================================================
// Uniform Updates
// =========================================================================

/**
 * Packs uniform data (MVP matrix + viewport size) into a Float32Array.
 *
 * @param {Float32Array} uniformData - Target array (at least 20 floats)
 * @param {object} frameState - CesiumJS frame state
 * @param {Matrix4} modelMatrix - Collection's model matrix
 * @private
 */
function packUniforms(uniformData, frameState, modelMatrix) {
  const camera = frameState.camera;
  const canvas = frameState.context.canvas;

  // MVP = projection * view * model
  Matrix4.multiply(camera.viewMatrix, modelMatrix, scratchMVP);
  Matrix4.multiply(camera.frustum.projectionMatrix, scratchMVP, scratchMVP);

  // Write MVP matrix (16 floats)
  Matrix4.pack(scratchMVP, uniformData, 0);

  // Write viewport size (2 floats)
  uniformData[16] = canvas.width;
  uniformData[17] = canvas.height;

  // splitPosition + padding
  uniformData[18] = 0.0;
  uniformData[19] = 0.0;
}

// =========================================================================
// Main Render Function
// =========================================================================

/**
 * Creates or updates WebGPU draw commands for a PointPrimitiveCollection.
 * Called from PointPrimitiveCollection.update() when isWebGPU is true.
 *
 * Manages a GPU cache on the collection (_webgpuCache) containing:
 * - pipeline, bindGroupLayout (created once)
 * - instanceBuffer, uniformBuffer, bindGroup (created/updated as needed)
 * - colorCommand (the WebGPUDrawCommand)
 *
 * @param {PointPrimitiveCollection} collection - The point collection
 * @param {object} frameState - CesiumJS frame state
 * @param {object} commandList - Array to push draw commands into
 * @private
 */
function updateWebGPUPointPrimitives(collection, frameState, commandList) {
  const context = frameState.context;
  const device = context.device;
  const length = collection._pointPrimitivesLength;

  if (length === 0) {
    return;
  }

  // Initialize GPU cache on first call
  if (!defined(collection._webgpuCache)) {
    collection._webgpuCache = {};
  }
  const cache = collection._webgpuCache;

  // Determine if we need to rebuild instance data
  const needsRebuild =
    !defined(cache.instanceBuffer) ||
    !defined(cache.colorCommand) ||
    collection._pointPrimitivesToUpdate.length > 0 ||
    cache.lastLength !== length;

  // --- Pipeline (created once) ---
  if (!defined(cache.pipeline)) {
    const shaderCode = getCollectionShaderSource("pointColor");
    const format = context.presentationFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const result = createPointPipeline(
      device,
      shaderCode,
      format,
      depthFmt,
      true,
    );
    cache.pipeline = result.pipeline;
    cache.bindGroupLayout = result.bindGroupLayout;
  }

  // --- Uniform buffer (created once, updated every frame) ---
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      "PointPrimitive uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
  }

  // Update uniforms every frame (camera moves)
  const modelMatrix = collection.modelMatrix || Matrix4.IDENTITY;
  packUniforms(cache.uniformData, frameState, modelMatrix);
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  // --- Bind group (recreated if uniform buffer changes) ---
  if (!defined(cache.bindGroup)) {
    cache.bindGroup = device.createBindGroup({
      label: "PointPrimitive bind group",
      layout: cache.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
      ],
    });
  }

  // --- Instance buffer (rebuilt when points change) ---
  if (needsRebuild) {
    const { instanceData, visibleCount } = buildInstanceData(collection);

    if (visibleCount === 0) {
      cache.colorCommand = undefined;
      cache.lastLength = length;
      return;
    }

    // Create or resize instance buffer
    const requiredSize = visibleCount * BYTES_PER_INSTANCE;
    if (
      !defined(cache.instanceBuffer) ||
      cache.instanceBuffer.size < requiredSize
    ) {
      if (defined(cache.instanceBuffer)) {
        cache.instanceBuffer.destroy();
      }
      cache.instanceBuffer = WebGPUBuffer.createVertexBuffer(
        device,
        requiredSize,
        true, // mappedAtCreation = false, we'll writeBuffer
        "PointPrimitive instances",
      );
    }

    device.queue.writeBuffer(
      cache.instanceBuffer.buffer,
      0,
      instanceData.buffer,
      0,
      requiredSize,
    );

    cache.visibleCount = visibleCount;
    cache.lastLength = length;

    // Create draw command (instanced: 6 verts per quad, N instances)
    cache.colorCommand = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup],
      vertexBuffers: [cache.instanceBuffer],
      vertexCount: VERTICES_PER_QUAD,
      instanceCount: visibleCount,
      pass: 0, // Pass.OPAQUE — adjusted below
      owner: collection,
      boundingVolume: collection._boundingVolume,
      modelMatrix: modelMatrix,
      cull: true,
    });

    // Clear the dirty list
    collection._pointPrimitivesToUpdate.length = 0;
  } else if (defined(cache.colorCommand)) {
    // Only update instance count if it changed
    cache.colorCommand.instanceCount = cache.visibleCount;
  }

  // Push draw command to command list
  if (defined(cache.colorCommand)) {
    commandList.push(cache.colorCommand);
  }
}

/**
 * Destroys WebGPU resources cached on a PointPrimitiveCollection.
 * Called from PointPrimitiveCollection.destroy().
 *
 * @param {PointPrimitiveCollection} collection - The point collection
 * @private
 */
function destroyWebGPUPointResources(collection) {
  const cache = collection._webgpuCache;
  if (!defined(cache)) {
    return;
  }

  if (defined(cache.instanceBuffer)) {
    cache.instanceBuffer.destroy();
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }

  collection._webgpuCache = undefined;
}

// =========================================================================
// Exports
// =========================================================================

export {
  updateWebGPUPointPrimitives,
  destroyWebGPUPointResources,
  buildInstanceData,
  packUniforms,
  FLOATS_PER_INSTANCE,
  BYTES_PER_INSTANCE,
  VERTICES_PER_QUAD,
};

export default {
  updateWebGPUPointPrimitives,
  destroyWebGPUPointResources,
};
