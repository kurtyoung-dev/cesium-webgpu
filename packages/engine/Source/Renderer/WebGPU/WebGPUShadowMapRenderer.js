/**
 * @module WebGPUShadowMapRenderer
 *
 * Handles WebGPU shadow map generation and shadow receiving.
 * Creates a depth-only render target for the shadow map, renders scene
 * from light's perspective, then provides shadow sampling for color passes.
 *
 * @private
 */
import defined from "../../Core/defined.js";
import Matrix4 from "../../Core/Matrix4.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import WebGPUBuffer from "./WebGPUBuffer.js";

const SHADOW_MAP_SIZE = 2048;
const SHADOW_UNIFORM_SIZE = 128;

const scratchEncodedCamera = new EncodedCartesian3();

/**
 * Creates shadow map depth texture and render target.
 * @private
 */
function createShadowMapTexture(device, size) {
  const texture = device.createTexture({
    label: "Shadow map depth",
    size: [size, size, 1],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });

  const sampler = device.createSampler({
    label: "Shadow map comparison sampler",
    compare: "less",
    magFilter: "linear",
    minFilter: "linear",
  });

  return { texture, sampler };
}

/**
 * Creates the shadow cast pipeline (depth-only rendering from light's perspective).
 * @private
 */
function createShadowCastPipeline(device) {
  const code = `
struct U { lightVP: mat4x4<f32>, camH: vec3<f32>, _p0: f32, camL: vec3<f32>, _p1: f32,
  depthBias: f32, normalBias: f32, _p2: vec2<f32> };
@group(0) @binding(0) var<uniform> u: U;

@vertex fn vs(@location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>) -> @builtin(position) vec4<f32> {
  let rte = (pH - u.camH) + (pL - u.camL);
  var pos = u.lightVP * vec4f(rte, 1.0);
  pos.z += u.depthBias;
  return pos;
}

@fragment fn fs() {}
`;

  const mod = device.createShaderModule({ label: "Shadow cast", code });
  const bgl = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
    ],
  });

  const pipeline = device.createRenderPipeline({
    label: "Shadow cast pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: {
      module: mod,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
          ],
        },
      ],
    },
    fragment: { module: mod, entryPoint: "fs", targets: [] },
    primitive: { topology: "triangle-list", cullMode: "front" },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
  });

  return { pipeline, bgl };
}

/**
 * Initializes or updates WebGPU shadow map resources.
 * @param {ShadowMap} shadowMap
 * @param {FrameState} frameState
 */
function initWebGPUShadowMap(shadowMap, frameState) {
  if (!shadowMap.enabled || !shadowMap._isPointLight === false) {
    return;
  }

  const device = frameState.context.device;

  if (!defined(shadowMap._webgpuCache)) {
    shadowMap._webgpuCache = {};
  }
  const cache = shadowMap._webgpuCache;

  // Create shadow map texture once
  if (!defined(cache.depthTexture)) {
    const size = shadowMap._textureSize?.x || SHADOW_MAP_SIZE;
    const result = createShadowMapTexture(device, size);
    cache.depthTexture = result.texture;
    cache.depthTextureView = result.texture.createView();
    cache.comparisonSampler = result.sampler;
    cache.size = size;
  }

  // Create cast pipeline once
  if (!defined(cache.castPipeline)) {
    const result = createShadowCastPipeline(device);
    cache.castPipeline = result.pipeline;
    cache.castBGL = result.bgl;
  }

  // Uniform buffer
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      SHADOW_UNIFORM_SIZE,
      "Shadow uniforms",
    );
    cache.uniformData = new Float32Array(SHADOW_UNIFORM_SIZE / 4);
  }
}

/**
 * Packs shadow cast uniforms.
 * @private
 */
function packShadowCastUniforms(data, shadowMap, frameState) {
  const lightVP = shadowMap._shadowMapMatrix || Matrix4.IDENTITY;
  Matrix4.pack(lightVP, data, 0);

  EncodedCartesian3.fromCartesian(
    frameState.camera.positionWC,
    scratchEncodedCamera,
  );
  data[16] = scratchEncodedCamera.high.x;
  data[17] = scratchEncodedCamera.high.y;
  data[18] = scratchEncodedCamera.high.z;
  data[19] = 0.0;
  data[20] = scratchEncodedCamera.low.x;
  data[21] = scratchEncodedCamera.low.y;
  data[22] = scratchEncodedCamera.low.z;
  data[23] = 0.0;

  data[24] = shadowMap._bias?.depthBias || 0.005;
  data[25] = shadowMap._bias?.normalShadingSmooth || 0.0;
  data[26] = 0.0;
  data[27] = 0.0;
}

/**
 * Creates a shadow map render pass descriptor.
 * @param {ShadowMap} shadowMap
 * @returns {GPURenderPassDescriptor|null}
 */
function getShadowPassDescriptor(shadowMap) {
  const cache = shadowMap._webgpuCache;
  if (!defined(cache) || !defined(cache.depthTextureView)) {
    return null;
  }

  return {
    colorAttachments: [],
    depthStencilAttachment: {
      view: cache.depthTextureView,
      depthClearValue: 1.0,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  };
}

/**
 * Gets the shadow map texture and sampler for use in color pass shaders.
 * @param {ShadowMap} shadowMap
 * @returns {{ texture: GPUTexture, view: GPUTextureView, sampler: GPUSampler, matrix: Matrix4 }|null}
 */
function getShadowMapResources(shadowMap) {
  const cache = shadowMap._webgpuCache;
  if (!defined(cache) || !defined(cache.depthTexture)) {
    return null;
  }

  return {
    texture: cache.depthTexture,
    view: cache.depthTextureView,
    sampler: cache.comparisonSampler,
    matrix: shadowMap._shadowMapMatrix || Matrix4.IDENTITY,
    size: cache.size || SHADOW_MAP_SIZE,
    darkness: shadowMap.darkness || 0.3,
    softShadows: shadowMap.softShadows || false,
  };
}

/**
 * Renders a shadow cast pass — draws all shadow-casting commands from the light's perspective.
 * Uses the shadow cast pipeline with depth-only output to the shadow map texture.
 *
 * @param {GPUCommandEncoder} encoder - Active command encoder
 * @param {ShadowMap} shadowMap - The shadow map with cached WebGPU resources
 * @param {FrameState} frameState
 * @param {Array} castCommands - Array of WebGPUDrawCommands that cast shadows
 */
function renderShadowCastPass(encoder, shadowMap, frameState, castCommands) {
  const cache = shadowMap._webgpuCache;
  if (!defined(cache) || !defined(cache.depthTextureView)) {
    return;
  }
  if (!castCommands || castCommands.length === 0) {
    return;
  }

  // Update shadow uniforms
  packShadowCastUniforms(cache.uniformData, shadowMap, frameState);
  const device = frameState.context.device;
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    SHADOW_UNIFORM_SIZE,
  );

  // Create bind group for shadow uniforms
  if (!defined(cache.castBindGroup)) {
    cache.castBindGroup = device.createBindGroup({
      layout: cache.castBGL,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
      ],
    });
  }

  // Begin shadow render pass (depth-only)
  const passDesc = getShadowPassDescriptor(shadowMap);
  if (!passDesc) {
    return;
  }
  const pass = encoder.beginRenderPass(passDesc);
  pass.setPipeline(cache.castPipeline);
  pass.setBindGroup(0, cache.castBindGroup);

  // Draw each shadow-casting command's geometry through shadow pipeline
  for (let i = 0; i < castCommands.length; i++) {
    const cmd = castCommands[i];
    if (!defined(cmd) || !defined(cmd.vertexBuffers)) {
      continue;
    }
    // Set vertex buffers from the command
    const vbs = cmd.vertexBuffers;
    for (let j = 0; j < vbs.length; j++) {
      const vb = vbs[j];
      if (defined(vb) && defined(vb.buffer)) {
        pass.setVertexBuffer(j, vb.buffer);
      }
    }
    // Draw indexed or non-indexed
    if (defined(cmd.indexBuffer)) {
      pass.setIndexBuffer(cmd.indexBuffer, cmd.indexFormat || "uint16");
      pass.drawIndexed(cmd.indexCount || 0);
    } else {
      pass.draw(cmd.vertexCount || 0, cmd.instanceCount || 1);
    }
  }

  pass.end();
}

function destroyWebGPUShadowMapResources(shadowMap) {
  const cache = shadowMap._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.depthTexture)) {
    cache.depthTexture.destroy();
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  shadowMap._webgpuCache = undefined;
}

export {
  initWebGPUShadowMap,
  packShadowCastUniforms,
  getShadowPassDescriptor,
  getShadowMapResources,
  renderShadowCastPass,
  destroyWebGPUShadowMapResources,
};

export default {
  initWebGPUShadowMap,
  packShadowCastUniforms,
  getShadowPassDescriptor,
  getShadowMapResources,
  renderShadowCastPass,
  destroyWebGPUShadowMapResources,
};
