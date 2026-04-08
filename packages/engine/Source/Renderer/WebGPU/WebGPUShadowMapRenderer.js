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

// ─── Shadow cast pipeline registry ───────────────────────────────────────
//
// Different vertex layouts (RTE primitives, single-position models, quantized
// terrain, instanced) can't share one shadow cast pipeline because WebGPU
// pipelines bake in the vertex buffer layout. Each entry registers:
//   - A WGSL fragment producing the vertex shader body (must declare its own
//     @vertex fn vs returning @builtin(position) and applying u.depthBias)
//   - A vertex buffer layout descriptor matching that shader's @location(s)
//
// Commands declare which key to use via `cmd._shadowCastLayout` (preferred)
// or fall back to `_inferShadowLayoutKey()` which sniffs vertexStride.
// Unknown layouts are skipped silently after a one-time warning.

const SHADOW_CAST_VARIANTS = {
  // RTE primitives: positionHigh + positionLow, stride 24, two float32x3.
  // The current default — covers all RTE-encoded primitive geometry.
  rte24: {
    vsCode: `
@vertex fn vs(@location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>) -> @builtin(position) vec4<f32> {
  let rte = (pH - u.camH) + (pL - u.camL);
  var pos = u.lightVP * vec4f(rte, 1.0);
  pos.z += u.depthBias;
  return pos;
}`,
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
};

const _shadowLayoutWarned = new Set();

/**
 * Maps a command's vertex configuration to a registered shadow cast layout
 * key. Returns null when no compatible cast pipeline exists for the command.
 * Logs once per unknown stride to avoid console spam.
 * @private
 */
function _inferShadowLayoutKey(cmd, vbStride) {
  // Explicit override on the command always wins.
  if (defined(cmd._shadowCastLayout)) {
    return cmd._shadowCastLayout;
  }
  // Stride-24 = canonical RTE primitive layout.
  if (vbStride === 24 || !defined(vbStride)) {
    return "rte24";
  }
  if (!_shadowLayoutWarned.has(vbStride)) {
    _shadowLayoutWarned.add(vbStride);
    console.warn(
      `[WebGPUShadowMap] No shadow cast pipeline registered for vertex stride ${vbStride}. ` +
        `Commands with this layout will be skipped. See SHADOW-LAYOUT in the migration backlog.`,
    );
  }
  return null;
}

const SHADOW_CAST_BIND_GROUP_PREFIX = `
struct U { lightVP: mat4x4<f32>, camH: vec3<f32>, _p0: f32, camL: vec3<f32>, _p1: f32,
  depthBias: f32, normalBias: f32, _p2: vec2<f32> };
@group(0) @binding(0) var<uniform> u: U;
@fragment fn fs() {}
`;

/**
 * Builds (and caches) the shadow cast pipeline for a given layout variant.
 * Pipelines are cached on the shadow map's `_webgpuCache.castPipelines` Map
 * keyed by variant name, so each shadow map only pays creation cost once
 * per layout it actually encounters.
 * @private
 */
function _getOrCreateCastPipeline(device, cache, layoutKey) {
  if (!defined(cache.castPipelines)) {
    cache.castPipelines = new Map();
    cache.castBindGroups = new Map();
  }
  let entry = cache.castPipelines.get(layoutKey);
  if (defined(entry)) {
    return entry;
  }
  const variant = SHADOW_CAST_VARIANTS[layoutKey];
  if (!defined(variant)) {
    return null;
  }

  const mod = device.createShaderModule({
    label: `Shadow cast (${layoutKey})`,
    code: SHADOW_CAST_BIND_GROUP_PREFIX + variant.vsCode,
  });
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
    label: `Shadow cast pipeline (${layoutKey})`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module: mod, entryPoint: "vs", buffers: variant.buffers },
    fragment: { module: mod, entryPoint: "fs", targets: [] },
    primitive: { topology: "triangle-list", cullMode: "front" },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
  });

  entry = { pipeline, bgl };
  cache.castPipelines.set(layoutKey, entry);
  return entry;
}

/**
 * Registers an additional shadow cast variant (called from outside this
 * module by renderers that need a specialized vertex layout — e.g.,
 * quantized terrain or model PBR). Variants registered after the first
 * shadow cast pass will be picked up on the next pass.
 *
 * @param {string} key Unique layout name (also used as `cmd._shadowCastLayout`)
 * @param {{vsCode: string, buffers: Array<GPUVertexBufferLayout>}} variant
 */
function registerShadowCastVariant(key, variant) {
  SHADOW_CAST_VARIANTS[key] = variant;
}

/**
 * Returns the list of currently-registered shadow cast layout keys.
 * Useful for diagnostics, tests, and visualizing which variants a renderer
 * has actually wired up.
 * @returns {string[]}
 */
function getRegisteredShadowCastVariantKeys() {
  return Object.keys(SHADOW_CAST_VARIANTS);
}

/**
 * Initializes or updates WebGPU shadow map resources.
 * @param {ShadowMap} shadowMap
 * @param {FrameState} frameState
 */
function initWebGPUShadowMap(shadowMap, frameState) {
  // Only directional/spot lights for now (point light shadow maps need cube faces)
  if (!shadowMap.enabled || shadowMap._isPointLight) {
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

  // Cast pipelines are now created lazily per vertex-layout variant
  // (see _getOrCreateCastPipeline). Eager creation removed so that
  // shadow maps which only ever see one layout don't pay for unused
  // variants.

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

  // Shadow bias comes from the appropriate bias object (primitive, terrain, or point)
  const bias = shadowMap._primitiveBias || shadowMap._terrainBias || {};
  data[24] = bias.depthBias || 0.005;
  data[25] = bias.normalShadingSmooth || 0.0;
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

  // Begin shadow render pass (depth-only)
  const passDesc = getShadowPassDescriptor(shadowMap);
  if (!passDesc) {
    return;
  }
  const pass = encoder.beginRenderPass(passDesc);

  // Per-layout pipeline switching — track the currently-bound variant so we
  // only call setPipeline/setBindGroup when the layout actually changes.
  // Sorting commands by layout key upstream would amortize this further but
  // is not required for correctness.
  let currentLayoutKey = null;

  // Draw each shadow-casting command's geometry through the matching cast
  // pipeline. Commands declare their layout via `cmd._shadowCastLayout` or
  // are inferred from vertex stride (see _inferShadowLayoutKey).
  //
  // Commands can be either:
  //   - WebGPU DrawCommands (have vertexBuffers[] with .buffer getter)
  //   - Ad-hoc commands (have _vertexBuffer with raw GPUBuffer)
  //   - WebGL DrawCommands (have vertexArray — skip these, can't render in WebGPU)
  for (let i = 0; i < castCommands.length; i++) {
    const cmd = castCommands[i];
    if (!defined(cmd)) {
      continue;
    }

    // Resolve vertex buffer — try WebGPU command, then ad-hoc, then skip
    let vb;
    let vbStride;
    if (defined(cmd.vertexBuffers) && cmd.vertexBuffers.length > 0) {
      const first = cmd.vertexBuffers[0];
      vb = defined(first.buffer) ? first.buffer : first;
      vbStride = first.arrayStride ?? cmd.vertexStride;
    } else if (defined(cmd._vertexBuffer)) {
      vb = defined(cmd._vertexBuffer.buffer)
        ? cmd._vertexBuffer.buffer
        : cmd._vertexBuffer;
      vbStride = cmd._vertexStride ?? cmd.vertexStride;
    } else if (defined(cmd.vertexBuffer)) {
      vb = defined(cmd.vertexBuffer.buffer)
        ? cmd.vertexBuffer.buffer
        : cmd.vertexBuffer;
      vbStride = cmd.vertexStride;
    } else {
      // No vertex data available (e.g., WebGL DrawCommand) — skip
      continue;
    }

    const layoutKey = _inferShadowLayoutKey(cmd, vbStride);
    if (layoutKey === null) {
      continue;
    }

    if (layoutKey !== currentLayoutKey) {
      const entry = _getOrCreateCastPipeline(device, cache, layoutKey);
      if (!defined(entry)) {
        continue;
      }
      // Lazily build the bind group for this variant. Bind groups can be
      // shared across variants only when the BGL is identical — currently
      // every variant uses the same single-uniform layout, but we still
      // cache per-variant to stay correct if a future variant adds bindings.
      let bg = cache.castBindGroups.get(layoutKey);
      if (!defined(bg)) {
        bg = device.createBindGroup({
          label: `Shadow cast bind group (${layoutKey})`,
          layout: entry.bgl,
          entries: [
            { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
          ],
        });
        cache.castBindGroups.set(layoutKey, bg);
      }
      pass.setPipeline(entry.pipeline);
      pass.setBindGroup(0, bg);
      currentLayoutKey = layoutKey;
    }

    pass.setVertexBuffer(0, vb);

    // Resolve index buffer
    const ib = cmd.indexBuffer || cmd._indexBuffer;
    if (defined(ib)) {
      const rawIb = defined(ib.buffer) ? ib.buffer : ib;
      const fmt = cmd.indexFormat || cmd._indexFormat || "uint16";
      const count = cmd.indexCount || cmd._indexCount || 0;
      pass.setIndexBuffer(rawIb, fmt);
      pass.drawIndexed(count);
    } else {
      const count = cmd.vertexCount || cmd._vertexCount || 0;
      pass.draw(count, cmd.instanceCount || 1);
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
  // Pipelines and bind groups are owned by the device and don't expose
  // explicit destroy(); dropping references is sufficient for GC.
  if (defined(cache.castPipelines)) {
    cache.castPipelines.clear();
  }
  if (defined(cache.castBindGroups)) {
    cache.castBindGroups.clear();
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
  registerShadowCastVariant,
  getRegisteredShadowCastVariantKeys,
};

export default {
  initWebGPUShadowMap,
  packShadowCastUniforms,
  getShadowPassDescriptor,
  getShadowMapResources,
  renderShadowCastPass,
  destroyWebGPUShadowMapResources,
  registerShadowCastVariant,
  getRegisteredShadowCastVariantKeys,
};
