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
import {
  makeBindGroupLayout,
  sampler,
  storageBuffer,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { getEffectsBindGroupLayout } from "./WebGPUEffectsBindGroup.js";

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
  const cameraBGL = makeBindGroupLayout(device, "Model Camera BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
  ]);

  // Group 1: Material + Light uniforms (per-material)
  const materialBGL = makeBindGroupLayout(device, "Model Material+Light BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
    uniformBuffer(1, Stage.FRAGMENT),
  ]);

  // Group 2: Textures (per-material) — 5 textures + 5 samplers
  // Pairs: (binding N = texture, binding N+1 = sampler) for baseColor,
  // normal, metallicRoughness, emissive, occlusion (bindings 0-9).
  const textureBGL = makeBindGroupLayout(device, "Model Textures BGL", [
    texture(0, Stage.FRAGMENT),
    sampler(1, Stage.FRAGMENT),
    texture(2, Stage.FRAGMENT),
    sampler(3, Stage.FRAGMENT),
    texture(4, Stage.FRAGMENT),
    sampler(5, Stage.FRAGMENT),
    texture(6, Stage.FRAGMENT),
    sampler(7, Stage.FRAGMENT),
    texture(8, Stage.FRAGMENT),
    sampler(9, Stage.FRAGMENT),
  ]);

  // Group 3: Joint matrices storage buffer (for skinning)
  const skinningBGL = makeBindGroupLayout(device, "Model Skinning BGL", [
    storageBuffer(0, Stage.VERTEX, { readOnly: true }),
  ]);

  // Group 4: Morph targets (storage buffer for deltas + uniform for weights)
  const morphTargetBGL = makeBindGroupLayout(device, "Model MorphTarget BGL", [
    storageBuffer(0, Stage.VERTEX, { readOnly: true }),
    uniformBuffer(1, Stage.VERTEX),
  ]);

  // Group 5: Instance transforms storage buffer (for GPU instancing)
  const instancingBGL = makeBindGroupLayout(device, "Model Instancing BGL", [
    storageBuffer(0, Stage.VERTEX, { readOnly: true }),
  ]);

  // Group 6: Feature ID texture + batch texture for per-feature styling
  // Used by EXT_mesh_features (feature ID textures) and 3D Tiles batch tables.
  // 0-1 = feature ID tex+sampler, 2-3 = batch tex+sampler, 4 = uniforms.
  const featureIdBGL = makeBindGroupLayout(device, "Model FeatureId BGL", [
    texture(0, Stage.FRAGMENT),
    sampler(1, Stage.FRAGMENT),
    texture(2, Stage.FRAGMENT),
    sampler(3, Stage.FRAGMENT),
    uniformBuffer(4, Stage.FRAGMENT),
  ]);

  return {
    cameraBGL,
    materialBGL,
    textureBGL,
    skinningBGL,
    morphTargetBGL,
    instancingBGL,
    featureIdBGL,
  };
}

// WebGL GL_* sampler-enum constants → GPU strings. Module-scope helpers
// so `getSamplerForReader` (method on the pipeline cache class) can use
// them without a per-call closure.
const _GL_NEAREST = 9728;
const _GL_LINEAR = 9729;
const _GL_NEAREST_MIPMAP_NEAREST = 9984;
const _GL_LINEAR_MIPMAP_NEAREST = 9985;
const _GL_NEAREST_MIPMAP_LINEAR = 9986;
const _GL_LINEAR_MIPMAP_LINEAR = 9987;
const _GL_REPEAT = 10497;
const _GL_CLAMP_TO_EDGE = 33071;
const _GL_MIRRORED_REPEAT = 33648;

function _mapGLFilter(glEnum, fallback) {
  if (glEnum === _GL_NEAREST) {
    return "nearest";
  }
  if (glEnum === _GL_LINEAR) {
    return "linear";
  }
  return fallback;
}

function _mapGLMinFilter(glEnum) {
  // Return { min, mip } because WebGPU splits filter + mipmap filter.
  switch (glEnum) {
    case _GL_NEAREST:
      return { min: "nearest", mip: "nearest" };
    case _GL_LINEAR:
      return { min: "linear", mip: "nearest" };
    case _GL_NEAREST_MIPMAP_NEAREST:
      return { min: "nearest", mip: "nearest" };
    case _GL_LINEAR_MIPMAP_NEAREST:
      return { min: "linear", mip: "nearest" };
    case _GL_NEAREST_MIPMAP_LINEAR:
      return { min: "nearest", mip: "linear" };
    case _GL_LINEAR_MIPMAP_LINEAR:
    default:
      // glTF spec default is LINEAR_MIPMAP_LINEAR — honor it explicitly.
      return { min: "linear", mip: "linear" };
  }
}

function _mapGLWrap(glEnum) {
  if (glEnum === _GL_CLAMP_TO_EDGE) {
    return "clamp-to-edge";
  }
  if (glEnum === _GL_MIRRORED_REPEAT) {
    return "mirror-repeat";
  }
  if (glEnum === _GL_REPEAT) {
    return "repeat";
  }
  return "repeat"; // glTF spec default when no match
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
    // Slot 7: texCoord1 (vec2<f32>) — used by textures whose
    // glTF textureInfo.texCoord == 1 (occlusion + clearcoat-normal are
    // the usual cases). May use default when the primitive has no
    // TEXCOORD_1 accessor; `ModelPBRComplete.wgsl` picks between
    // texCoord0 / texCoord1 per-slot via the uniform flag pushed into
    // the material UBO, so the shader is safe against missing data.
    {
      arrayStride: 8,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 7, offset: 0, format: "float32x2" }],
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
 * C-R9-MODEL-PICK (Batch 54) — pick pipeline. Mirrors `createPipeline` for
 * vertex stage, layout, and depth state, but the fragment entry is
 * `fragmentPickMain` (writes `material.pickColor`) and there's no blend
 * (pick FBO must receive byte-exact pick IDs for the readback).
 *
 * Depth write is forced ON for ALL alpha modes, even ALPHA_BLEND. The
 * lit path disables depth write for blend so translucent layers
 * composite without z-fighting; the pick path however needs depth
 * write so the front-most fragment wins the pick (matches WebGL's
 * `RenderState.depthMask = true` for pick passes). Translucent
 * picking is intentionally simplified to "first non-discarded
 * fragment wins" in this first cut — depth-correct alpha-blended
 * picking would need OIT integration on the pick FBO and is tracked
 * separately as `C-R9-MODEL-PICK-TRANSLUCENT`.
 *
 * Cull mode follows the doubleSided flag, same as the lit pipeline,
 * so a back face that wouldn't render also wouldn't pick — matching
 * WebGL's behaviour.
 *
 * @private
 */
function createPickPipeline(
  device,
  shaderModule,
  pipelineLayout,
  presentationFormat,
  depthFormat,
  alphaMode,
  doubleSided,
) {
  const cullMode = doubleSided ? "none" : "back";
  const label = `Model PBR pick [alpha=${alphaMode},ds=${doubleSided}]`;
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
      entryPoint: "fragmentPickMain",
      targets: [{ format: presentationFormat }],
    },
    primitive: {
      topology: "triangle-list",
      cullMode,
    },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: true,
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
    // C-R9-MODEL-PICK (Batch 54) — pick pipeline cache, keyed by the same
    // (alphaMode, doubleSided) pair as `_pipelines`. Each pick pipeline
    // shares the layout + vertex stage of its color sibling and only
    // differs in the fragment entry + no-blend target state.
    this._pickPipelines = new Map();

    // Create shared bind group layouts
    const bgls = createBindGroupLayouts(device);
    this._cameraBGL = bgls.cameraBGL;
    this._materialBGL = bgls.materialBGL;
    this._textureBGL = bgls.textureBGL;
    this._skinningBGL = bgls.skinningBGL;
    this._morphTargetBGL = bgls.morphTargetBGL;
    this._instancingBGL = bgls.instancingBGL;
    this._featureIdBGL = bgls.featureIdBGL;
    // CSM Slice 2c — effects group carries shadow receive, clipping,
    // atmosphere LUT control, and cascaded-shadow-map bindings (10 +
    // 11). Shared with the globe and primitive shaders via the
    // `getEffectsBindGroupLayout` factory so the BGL layout stays in
    // lockstep across every consumer.
    this._effectsBGL = getEffectsBindGroupLayout(device);

    // Create pipeline layout (shared by all variants, 8 bind groups)
    this._pipelineLayout = device.createPipelineLayout({
      label: "Model PBR PipelineLayout",
      bindGroupLayouts: [
        this._cameraBGL,
        this._materialBGL,
        this._textureBGL,
        this._skinningBGL,
        this._morphTargetBGL,
        this._instancingBGL,
        this._featureIdBGL,
        this._effectsBGL,
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

    // Per-textureInfo sampler cache. glTF textures each carry a
    // `sampler` object with magFilter / minFilter / wrapS / wrapT values;
    // creating a new GPUSampler per distinct combination and reusing it
    // avoids thrashing the device with duplicate samplers when a tileset
    // has thousands of glTF textures that share sampler state (common —
    // glTF authoring pipelines usually emit one sampler per material
    // repeated across all textures).
    this._samplerCache = new Map();

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

    // Default morph target bind group: 1-element storage + zero-weight uniform
    // Used when a primitive has no morph targets (FLAG_HAS_MORPH_TARGETS will be false)
    this._defaultMorphDeltaBuffer = device.createBuffer({
      label: "default-morph-deltas",
      size: 16, // 1 vec4 minimum
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // 12 floats: weights0(4) + weights1(4) + targetCount + vertexCount + pad(2)
    const zeroWeights = new Float32Array(12);
    this._defaultMorphWeightBuffer = device.createBuffer({
      label: "default-morph-weights",
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._defaultMorphWeightBuffer, 0, zeroWeights);
    this._defaultMorphTargetBG = device.createBindGroup({
      layout: this._morphTargetBGL,
      entries: [
        { binding: 0, resource: { buffer: this._defaultMorphDeltaBuffer } },
        { binding: 1, resource: { buffer: this._defaultMorphWeightBuffer } },
      ],
    });

    // Default instancing bind group: 1-element identity matrix storage buffer
    // Used when a primitive has no instancing (FLAG_HAS_INSTANCING will be false)
    this._defaultInstancingBuffer = device.createBuffer({
      label: "default-instance-transforms",
      size: 64, // 1 mat4 = 64 bytes
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._defaultInstancingBuffer, 0, identityData);
    this._defaultInstancingBG = device.createBindGroup({
      layout: this._instancingBGL,
      entries: [
        { binding: 0, resource: { buffer: this._defaultInstancingBuffer } },
      ],
    });

    // Default feature ID bind group: dummy textures + zero-length uniform
    // Used when a primitive has no feature IDs (FLAG_HAS_FEATURE_ID_TEXTURE will be false)
    const zeroFeatureUniforms = new Float32Array(12); // 48 bytes
    this._defaultFeatureUniformBuffer = device.createBuffer({
      label: "default-feature-uniforms",
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      this._defaultFeatureUniformBuffer,
      0,
      zeroFeatureUniforms,
    );
    this._defaultFeatureIdBG = device.createBindGroup({
      layout: this._featureIdBGL,
      entries: [
        {
          binding: 0,
          resource: this._defaultWhiteTexture.createView(),
        },
        { binding: 1, resource: this._defaultSampler },
        {
          binding: 2,
          resource: this._defaultWhiteTexture.createView(),
        },
        { binding: 3, resource: this._defaultSampler },
        {
          binding: 4,
          resource: { buffer: this._defaultFeatureUniformBuffer },
        },
      ],
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

  /**
   * C-R9-MODEL-PICK (Batch 54) — gets or creates a pick pipeline for
   * the given material configuration. Same layout + vertex stage as
   * the matching color pipeline; the fragment entry is `fragmentPickMain`
   * which emits `material.pickColor` instead of the lit color, and the
   * fragment target has no blend (pick FBO must receive byte-exact pick
   * IDs).
   *
   * Keyed identically to `getPipeline` so a primitive's color and pick
   * pipelines share the same `(alphaMode, doubleSided)` identity. The
   * pick pipeline is only built once per identity per device.
   *
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @returns {GPURenderPipeline}
   */
  getPickPipeline(alphaMode, doubleSided) {
    const key = computeKey(alphaMode, doubleSided);
    let pipeline = this._pickPipelines.get(key);
    if (pipeline) {
      return pipeline;
    }

    pipeline = createPickPipeline(
      this._device,
      this._shaderModule,
      this._pipelineLayout,
      this._presentationFormat,
      this._depthFormat,
      alphaMode,
      doubleSided,
    );
    this._pickPipelines.set(key, pipeline);
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

  /**
   * Build (or retrieve from cache) a `GPUSampler` matching the glTF
   * textureInfo's sampler block. Returns `defaultSampler` when the
   * reader has no sampler metadata (non-glTF texture or legacy path).
   *
   * WebGL sampler enum → WebGPU string translation:
   *   magFilter  NEAREST=9728, LINEAR=9729
   *   minFilter  NEAREST=9728, LINEAR=9729,
   *              NEAREST_MIPMAP_NEAREST=9984, LINEAR_MIPMAP_NEAREST=9985,
   *              NEAREST_MIPMAP_LINEAR=9986, LINEAR_MIPMAP_LINEAR=9987
   *   wrapS/T/R  REPEAT=10497, CLAMP_TO_EDGE=33071, MIRRORED_REPEAT=33648
   *
   * @param {object} textureReader glTF textureInfo; the `.texture._sampler`
   *   field carries the sampler metadata as either a CesiumJS Sampler
   *   instance or a plain object with the fields listed above.
   * @returns {GPUSampler}
   */
  getSamplerForReader(textureReader) {
    if (!textureReader || !textureReader.texture) {
      return this._defaultSampler;
    }
    const glSampler =
      textureReader.texture._sampler ||
      textureReader.texture.sampler ||
      textureReader.sampler;
    if (!glSampler) {
      return this._defaultSampler;
    }

    // Read fields — support both Cesium's Sampler class (minificationFilter
    // / magnificationFilter / wrapS / wrapT) and raw glTF sampler objects
    // (minFilter / magFilter / wrapS / wrapT).
    const magEnum = glSampler.magnificationFilter ?? glSampler.magFilter;
    const minEnum = glSampler.minificationFilter ?? glSampler.minFilter;
    const wrapSEnum = glSampler.wrapS;
    const wrapTEnum = glSampler.wrapT;

    const magFilter = _mapGLFilter(magEnum, "linear");
    const minFilterAndMip = _mapGLMinFilter(minEnum);
    const addrU = _mapGLWrap(wrapSEnum);
    const addrV = _mapGLWrap(wrapTEnum);

    // Cache key packs all sampler state into a single string. Identical
    // combinations across textures share a single GPUSampler.
    const key = `${magFilter}|${minFilterAndMip.min}|${minFilterAndMip.mip}|${addrU}|${addrV}`;
    let cached = this._samplerCache.get(key);
    if (cached) {
      return cached;
    }

    cached = this._device.createSampler({
      label: `glTF sampler ${key}`,
      magFilter,
      minFilter: minFilterAndMip.min,
      mipmapFilter: minFilterAndMip.mip,
      addressModeU: addrU,
      addressModeV: addrV,
    });
    this._samplerCache.set(key, cached);
    return cached;
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

  /** @returns {GPUBindGroupLayout} Bind group layout for morph target resources */
  get morphTargetBGL() {
    return this._morphTargetBGL;
  }

  /** @returns {GPUBindGroup} Default morph target bind group with empty deltas */
  get defaultMorphTargetBindGroup() {
    return this._defaultMorphTargetBG;
  }

  /** @returns {GPUBindGroupLayout} Bind group layout for instancing storage buffer */
  get instancingBGL() {
    return this._instancingBGL;
  }

  /** @returns {GPUBindGroup} Default instancing bind group with identity matrix */
  get defaultInstancingBindGroup() {
    return this._defaultInstancingBG;
  }

  /** @returns {GPUBindGroupLayout} Bind group layout for feature ID + batch textures */
  get featureIdBGL() {
    return this._featureIdBGL;
  }

  /** @returns {GPUBindGroup} Default feature ID bind group with dummy textures */
  get defaultFeatureIdBindGroup() {
    return this._defaultFeatureIdBG;
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
    // C-R9-MODEL-PICK (Batch 54) — drop pick pipelines too. GPUPipelines
    // are released via GC once all references go away; clearing the map
    // releases the cache's reference. Same lifecycle as `_pipelines`.
    this._pickPipelines.clear();
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
    this._defaultMorphDeltaBuffer?.destroy();
    this._defaultMorphWeightBuffer?.destroy();
    this._defaultInstancingBuffer?.destroy();
    this._defaultFeatureUniformBuffer?.destroy();
  }
}

// Export alpha mode constants for use by WebGPUModelRenderer
WebGPUModelPipelineCache.ALPHA_OPAQUE = ALPHA_OPAQUE;
WebGPUModelPipelineCache.ALPHA_MASK = ALPHA_MASK;
WebGPUModelPipelineCache.ALPHA_BLEND = ALPHA_BLEND;

export default WebGPUModelPipelineCache;
