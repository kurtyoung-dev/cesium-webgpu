/**
 * @module WebGPUModelPipelineCache
 *
 * Manages GPU render pipeline variants for glTF Model rendering.
 * Pipelines vary by: alpha mode (OPAQUE/MASK/BLEND), cull mode (back/none),
 * and presentation format.
 *
 * All variants share the same vertex layout (7 attribute slots) and
 * bind group layouts (camera, material+light, textures, skinning).
 *
 * Skinning support: joints0 (vec4<u32>) and weights0 (vec4<f32>) are always
 * present in the vertex layout. Non-skinned primitives bind default zero buffers.
 * Joint matrices are provided via a storage buffer at bind group 3.
 *
 * @private
 */

import ModelPBRCompleteWGSL from "../../Shaders/WebGPU/Model/ModelPBRComplete.js";

// Alpha mode constants matching glTF spec
const ALPHA_OPAQUE = 0;
const ALPHA_MASK = 1;
const ALPHA_BLEND = 2;

/**
 * Computes a cache key from pipeline configuration.
 * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
 * @param {boolean} doubleSided - true = no backface culling
 * @returns {number}
 */
function computeKey(alphaMode, doubleSided) {
  return alphaMode | (doubleSided ? 4 : 0);
}

/**
 * Creates the four bind group layouts shared by all Model pipelines.
 * @param {GPUDevice} device
 * @returns {{ cameraBGL, materialBGL, textureBGL, skinningBGL }}
 */
function createBindGroupLayouts(device) {
  // Group 0: Camera uniforms (per-frame, shared across all models)
  const cameraBGL = device.createBindGroupLayout({
    label: "Model Camera BGL",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  // Group 1: Material + Light uniforms (per-material)
  const materialBGL = device.createBindGroupLayout({
    label: "Model Material+Light BGL",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  // Group 2: Textures (per-material) — 5 textures + 5 samplers
  const textureBGL = device.createBindGroupLayout({
    label: "Model Textures BGL",
    entries: [
      // baseColor
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
      // normal
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
      // metallicRoughness
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" },
      },
      {
        binding: 5,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
      // emissive
      {
        binding: 6,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" },
      },
      {
        binding: 7,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
      // occlusion
      {
        binding: 8,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" },
      },
      {
        binding: 9,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
    ],
  });

  // Group 3: Joint matrices storage buffer (for skinning)
  const skinningBGL = device.createBindGroupLayout({
    label: "Model Skinning BGL",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
    ],
  });

  return { cameraBGL, materialBGL, textureBGL, skinningBGL };
}

/**
 * Creates the vertex buffer layout descriptor.
 * 7 separate buffer slots, one per attribute.
 * Missing attributes use a 1-element instance-step buffer with defaults.
 */
function createVertexBufferLayout() {
  return [
    // Slot 0: positionMC (vec3<f32>) — ALWAYS present, vertex step
    {
      arrayStride: 12,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
    },
    // Slot 1: normalMC (vec3<f32>) — may use default
    {
      arrayStride: 12,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }],
    },
    // Slot 2: tangentMC (vec4<f32>) — may use default
    {
      arrayStride: 16,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 2, offset: 0, format: "float32x4" }],
    },
    // Slot 3: texCoord0 (vec2<f32>) — may use default
    {
      arrayStride: 8,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 3, offset: 0, format: "float32x2" }],
    },
    // Slot 4: color0 (vec4<f32>) — may use default
    {
      arrayStride: 16,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 4, offset: 0, format: "float32x4" }],
    },
    // Slot 5: joints0 (vec4<u32>) — may use default (zero joints)
    {
      arrayStride: 16,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 5, offset: 0, format: "uint32x4" }],
    },
    // Slot 6: weights0 (vec4<f32>) — may use default (zero weights)
    {
      arrayStride: 16,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 6, offset: 0, format: "float32x4" }],
    },
  ];
}

/**
 * Creates a render pipeline for the given configuration.
 * @param {GPUDevice} device
 * @param {GPUShaderModule} shaderModule
 * @param {GPUPipelineLayout} pipelineLayout
 * @param {string} presentationFormat
 * @param {string} depthFormat
 * @param {number} alphaMode
 * @param {boolean} doubleSided
 * @returns {GPURenderPipeline}
 */
function createPipeline(
  device,
  shaderModule,
  pipelineLayout,
  presentationFormat,
  depthFormat,
  alphaMode,
  doubleSided,
) {
  const cullMode = doubleSided ? "none" : "back";

  // Blend state depends on alpha mode
  let blend;
  if (alphaMode === ALPHA_BLEND) {
    blend = {
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
    };
  }

  // Depth write: disabled for transparent objects to avoid depth conflicts
  const depthWriteEnabled = alphaMode !== ALPHA_BLEND;

  const label = `Model PBR [alpha=${alphaMode},ds=${doubleSided}]`;

  return device.createRenderPipeline({
    label,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: createVertexBufferLayout(),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [
        {
          format: presentationFormat,
          blend,
        },
      ],
    },
    primitive: {
      topology: "triangle-list",
      cullMode,
    },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled,
      depthCompare: "less-equal",
    },
  });
}

/**
 * WebGPUModelPipelineCache manages GPU pipeline variants for Model rendering.
 */
class WebGPUModelPipelineCache {
  /**
   * @param {GPUDevice} device
   * @param {string} presentationFormat - e.g., "bgra8unorm"
   * @param {string} depthFormat - e.g., "depth24plus-stencil8"
   */
  constructor(device, presentationFormat, depthFormat) {
    this._device = device;
    this._presentationFormat = presentationFormat;
    this._depthFormat = depthFormat;
    this._pipelines = new Map();

    // Create shared bind group layouts
    const bgls = createBindGroupLayouts(device);
    this._cameraBGL = bgls.cameraBGL;
    this._materialBGL = bgls.materialBGL;
    this._textureBGL = bgls.textureBGL;
    this._skinningBGL = bgls.skinningBGL;

    // Create pipeline layout (shared by all variants, 4 bind groups)
    this._pipelineLayout = device.createPipelineLayout({
      label: "Model PBR PipelineLayout",
      bindGroupLayouts: [
        this._cameraBGL,
        this._materialBGL,
        this._textureBGL,
        this._skinningBGL,
      ],
    });

    // Create shader module from the combined VS+FS WGSL source
    this._shaderModule = device.createShaderModule({
      label: "Model PBR ShaderModule",
      code: ModelPBRCompleteWGSL,
    });

    // Create default 1x1 textures for missing material textures
    this._defaultWhiteTexture = this._createDefaultTexture(
      255,
      255,
      255,
      255,
      "default-white",
    );
    this._defaultNormalTexture = this._createDefaultTexture(
      128,
      128,
      255,
      255,
      "default-normal",
    );
    this._defaultBlackTexture = this._createDefaultTexture(
      0,
      0,
      0,
      255,
      "default-black",
    );
    this._defaultSampler = device.createSampler({
      label: "Model default sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });

    // Create default vertex buffers for missing attributes
    this._defaultNormalBuffer = this._createDefaultVertexBuffer(
      new Float32Array([0, 1, 0]),
      "default-normal-vb",
    );
    this._defaultTangentBuffer = this._createDefaultVertexBuffer(
      new Float32Array([1, 0, 0, 1]),
      "default-tangent-vb",
    );
    this._defaultUVBuffer = this._createDefaultVertexBuffer(
      new Float32Array([0, 0]),
      "default-uv-vb",
    );
    this._defaultColorBuffer = this._createDefaultVertexBuffer(
      new Float32Array([1, 1, 1, 1]),
      "default-color-vb",
    );
    // Skinning defaults: zero joints and zero weights
    this._defaultJointsBuffer = this._createDefaultVertexBuffer(
      new Uint32Array([0, 0, 0, 0]),
      "default-joints-vb",
    );
    this._defaultWeightsBuffer = this._createDefaultVertexBuffer(
      new Float32Array([0, 0, 0, 0]),
      "default-weights-vb",
    );

    // Default skinning bind group: 1-element identity matrix storage buffer
    // Used when a primitive has no skinning (FLAG_HAS_SKINNING will be false)
    const identityData = new Float32Array(16);
    identityData[0] = 1;
    identityData[5] = 1;
    identityData[10] = 1;
    identityData[15] = 1;
    this._defaultJointBuffer = device.createBuffer({
      label: "default-joint-matrices",
      size: 64, // 1 mat4 = 64 bytes
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._defaultJointBuffer, 0, identityData);
    this._defaultSkinningBG = device.createBindGroup({
      layout: this._skinningBGL,
      entries: [{ binding: 0, resource: { buffer: this._defaultJointBuffer } }],
    });
  }

  /**
   * Gets or creates a pipeline for the given material configuration.
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @returns {GPURenderPipeline}
   */
  getPipeline(alphaMode, doubleSided) {
    const key = computeKey(alphaMode, doubleSided);
    let pipeline = this._pipelines.get(key);
    if (pipeline) {
      return pipeline;
    }

    pipeline = createPipeline(
      this._device,
      this._shaderModule,
      this._pipelineLayout,
      this._presentationFormat,
      this._depthFormat,
      alphaMode,
      doubleSided,
    );
    this._pipelines.set(key, pipeline);
    return pipeline;
  }

  /** @returns {GPUBindGroupLayout} */
  get cameraBGL() {
    return this._cameraBGL;
  }

  /** @returns {GPUBindGroupLayout} */
  get materialBGL() {
    return this._materialBGL;
  }

  /** @returns {GPUBindGroupLayout} */
  get textureBGL() {
    return this._textureBGL;
  }

  /** @returns {GPUBindGroupLayout} Bind group layout for joint matrices storage buffer */
  get skinningBGL() {
    return this._skinningBGL;
  }

  /** @returns {GPUTexture} 1×1 white (255,255,255,255) */
  get defaultWhiteTexture() {
    return this._defaultWhiteTexture;
  }

  /** @returns {GPUTexture} 1×1 flat normal (128,128,255,255) */
  get defaultNormalTexture() {
    return this._defaultNormalTexture;
  }

  /** @returns {GPUTexture} 1×1 black (0,0,0,255) */
  get defaultBlackTexture() {
    return this._defaultBlackTexture;
  }

  /** @returns {GPUSampler} Default linear-repeat sampler */
  get defaultSampler() {
    return this._defaultSampler;
  }

  /** @returns {GPUBuffer} Default normal (0,1,0) as instance-step VB */
  get defaultNormalBuffer() {
    return this._defaultNormalBuffer;
  }

  /** @returns {GPUBuffer} Default tangent (1,0,0,1) as instance-step VB */
  get defaultTangentBuffer() {
    return this._defaultTangentBuffer;
  }

  /** @returns {GPUBuffer} Default UV (0,0) as instance-step VB */
  get defaultUVBuffer() {
    return this._defaultUVBuffer;
  }

  /** @returns {GPUBuffer} Default color (1,1,1,1) as instance-step VB */
  get defaultColorBuffer() {
    return this._defaultColorBuffer;
  }

  /** @returns {GPUBuffer} Default joints (0,0,0,0) as instance-step VB */
  get defaultJointsBuffer() {
    return this._defaultJointsBuffer;
  }

  /** @returns {GPUBuffer} Default weights (0,0,0,0) as instance-step VB */
  get defaultWeightsBuffer() {
    return this._defaultWeightsBuffer;
  }

  /** @returns {GPUBindGroup} Default skinning bind group with identity matrix */
  get defaultSkinningBindGroup() {
    return this._defaultSkinningBG;
  }

  /**
   * Creates a 1×1 RGBA texture with the given color.
   * @private
   */
  _createDefaultTexture(r, g, b, a, label) {
    const texture = this._device.createTexture({
      label,
      size: [1, 1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this._device.queue.writeTexture(
      { texture },
      new Uint8Array([r, g, b, a]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );
    return texture;
  }

  /**
   * Creates a small vertex buffer for default attribute values.
   * Used with instance step mode when an attribute is missing.
   * @private
   */
  _createDefaultVertexBuffer(data, label) {
    const buffer = this._device.createBuffer({
      label,
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this._device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  /**
   * Destroys all cached pipelines and default resources.
   */
  destroy() {
    this._pipelines.clear();
    this._defaultWhiteTexture?.destroy();
    this._defaultNormalTexture?.destroy();
    this._defaultBlackTexture?.destroy();
    this._defaultNormalBuffer?.destroy();
    this._defaultTangentBuffer?.destroy();
    this._defaultUVBuffer?.destroy();
    this._defaultColorBuffer?.destroy();
    this._defaultJointsBuffer?.destroy();
    this._defaultWeightsBuffer?.destroy();
    this._defaultJointBuffer?.destroy();
  }
}

// Export alpha mode constants for use by WebGPUModelRenderer
WebGPUModelPipelineCache.ALPHA_OPAQUE = ALPHA_OPAQUE;
WebGPUModelPipelineCache.ALPHA_MASK = ALPHA_MASK;
WebGPUModelPipelineCache.ALPHA_BLEND = ALPHA_BLEND;

export default WebGPUModelPipelineCache;
