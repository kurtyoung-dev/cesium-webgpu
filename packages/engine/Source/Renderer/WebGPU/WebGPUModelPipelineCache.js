/**
 * @module WebGPUModelPipelineCache
 *
 * Manages GPU render pipeline variants for glTF Model rendering.
 * Pipelines vary by: alpha mode (OPAQUE/MASK/BLEND), cull mode (back/none),
 * and presentation format.
 *
 * All variants share the same vertex layout (7 attribute slots) and the
 * 4 bind group layouts produced by `createBindGroupLayouts`:
 *   Group 0 — camera UBO (per-frame).
 *   Group 1 — merged material UBO + light UBO + 24 PBR/KHR textures +
 *             7 featureId entries (per-material).
 *   Group 2 — merged joint matrices + morph deltas + morph weights +
 *             instance transforms (per-instance vertex).
 *   Group 3 — effects BGL shared with globe + primitive (shadow +
 *             clipping + atmosphere + CSM + edges + globe depth).
 *
 * Consolidated from 8 logical groups in NEW-BG-CONSOLIDATION (Batch 122)
 * to fit within the WebGPU spec-mandated `maxBindGroups: 4` limit
 * (universal in Chromium, April 2026 — verified via
 * `Tools/visual-regression/probe-adapter-limits.mjs`).
 *
 * Skinning support: joints0 (vec4<u32>) and weights0 (vec4<f32>) are always
 * present in the vertex layout. Non-skinned primitives bind default zero
 * buffers via the merged group 2. Joint matrices ride storage at group
 * 2 binding 0; morph deltas at binding 1; morph weights at binding 2;
 * instance transforms at binding 3.
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
import { ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";

// C-R7-SHADER-MODULE-DEDUP (Batch 162) — per-device shader-module cache so
// every `WebGPUModelPipelineCache` (one per `Model`) on the same `GPUDevice`
// shares a single compiled `GPUShaderModule` for `ModelPBRComplete.wgsl`.
// Pipelines themselves stay per-cache (their formats + alphaMode + doubleSided
// keys differ); only the WGSL compilation is shared.
const _modelShaderModuleCaches = new WeakMap();

function getModelShaderModuleCache(device) {
  let cache = _modelShaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _modelShaderModuleCaches.set(device, cache);
  }
  return cache;
}

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
 *
 * **NEW-BG-CONSOLIDATION (2026-04-30, Batch 122):** Consolidated from 8
 * logical groups to 4 physical groups so the Model PBR pipeline fits
 * within the WebGPU spec-mandated `maxBindGroups: 4` limit (universal
 * across Chromium configs in April 2026 — verified via
 * `Tools/visual-regression/probe-adapter-limits.mjs`).
 *
 * Layout:
 *   Group 0 — CAMERA (1 binding, V+F)
 *   Group 1 — MATERIAL+TEXTURES+FEATURE (33 bindings, mostly fragment)
 *     0-1   : material UBO + light UBO       (was old group 1)
 *     2-25  : 24 PBR/KHR textures + samplers (was old group 2 +2 offset)
 *     26-32 : featureId / batch / featurePick (was old group 6 +26)
 *   Group 2 — INSTANCE (4 bindings, all VERTEX)
 *     0 : joint matrices storage  (was old group 3 binding 0)
 *     1 : morph deltas storage    (was old group 4 binding 0)
 *     2 : morph weights UBO       (was old group 4 binding 1)
 *     3 : instance transforms     (was old group 5 binding 0)
 *   Group 3 — EFFECTS (shared with globe + primitive)
 *     Layout owned by `WebGPUEffectsBindGroup.getEffectsBindGroupLayout`.
 *
 * @param {GPUDevice} device
 * @returns {{ cameraBGL, materialBGL, instanceBGL }}
 */
function createBindGroupLayouts(device) {
  // ── Group 0: CAMERA ── per-frame, shared across all models.
  const cameraBGL = makeBindGroupLayout(device, "Model Camera BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
  ]);

  // ── Group 1: MATERIAL + TEXTURES + FEATURE ──
  // 33 entries. Uses maxSampledTexturesPerShaderStage opt-in (default
  // 16, opted up to 48 in WebGPUContext.requestDevice).
  const materialBGL = makeBindGroupLayout(
    device,
    "Model Material+Textures+Feature BGL",
    [
      // 0-1: Material + Light UBOs
      uniformBuffer(0, Stage.VERTEX_FRAGMENT),
      uniformBuffer(1, Stage.FRAGMENT),
      // 2-11: Five PBR texture + sampler pairs (baseColor, normal,
      // metallic-roughness, emissive, occlusion).
      texture(2, Stage.FRAGMENT),
      sampler(3, Stage.FRAGMENT),
      texture(4, Stage.FRAGMENT),
      sampler(5, Stage.FRAGMENT),
      texture(6, Stage.FRAGMENT),
      sampler(7, Stage.FRAGMENT),
      texture(8, Stage.FRAGMENT),
      sampler(9, Stage.FRAGMENT),
      texture(10, Stage.FRAGMENT),
      sampler(11, Stage.FRAGMENT),
      // 12-22: 11 KHR-extension textures (clearcoat, specularColor,
      // anisotropy, iridescence, sheenColor, thickness, clearcoat
      // roughness, clearcoat normal, sheen roughness, specular factor,
      // iridescence thickness).
      texture(12, Stage.FRAGMENT),
      texture(13, Stage.FRAGMENT),
      texture(14, Stage.FRAGMENT),
      texture(15, Stage.FRAGMENT),
      texture(16, Stage.FRAGMENT),
      texture(17, Stage.FRAGMENT),
      texture(18, Stage.FRAGMENT),
      texture(19, Stage.FRAGMENT),
      texture(20, Stage.FRAGMENT),
      texture(21, Stage.FRAGMENT),
      texture(22, Stage.FRAGMENT),
      // 23: shared KHR sampler.
      sampler(23, Stage.FRAGMENT),
      // 24-25: transmission texture + refraction scene texture
      // (Batch 105 KHR_materials_transmission).
      texture(24, Stage.FRAGMENT),
      texture(25, Stage.FRAGMENT),
      // 26-32: feature ID + batch + per-feature pick (was old group 6).
      texture(26, Stage.FRAGMENT), // featureId
      sampler(27, Stage.FRAGMENT),
      texture(28, Stage.FRAGMENT), // batch
      sampler(29, Stage.FRAGMENT),
      uniformBuffer(30, Stage.FRAGMENT), // featureId UBO
      texture(31, Stage.FRAGMENT), // featurePick
      sampler(32, Stage.FRAGMENT),
    ],
  );

  // ── Group 2: INSTANCE ── per-instance vertex stage data.
  const instanceBGL = makeBindGroupLayout(device, "Model Instance BGL", [
    storageBuffer(0, Stage.VERTEX, { readOnly: true }), // joint matrices
    storageBuffer(1, Stage.VERTEX, { readOnly: true }), // morph deltas
    uniformBuffer(2, Stage.VERTEX), // morph weights
    storageBuffer(3, Stage.VERTEX, { readOnly: true }), // instance transforms
  ]);

  return {
    cameraBGL,
    materialBGL,
    instanceBGL,
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
  forceDepthWrite,
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

  // Depth write: disabled for transparent objects to avoid depth conflicts.
  // C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 79) — translucent 3D-tile commands
  // tagged for classification need a depth-write variant so the existing
  // stencil-based GroundPrimitive classifier can clip volumes against the
  // tile surface. Caller passes forceDepthWrite=true to fetch that variant.
  const depthWriteEnabled = forceDepthWrite || alphaMode !== ALPHA_BLEND;

  const variantTag = forceDepthWrite ? ",dwForceOn" : "";
  const label = `Model PBR [alpha=${alphaMode},ds=${doubleSided}${variantTag}]`;

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
 * TAA Slice 2e (Batch 106) — velocity-only pipeline variant. Single
 * `rg16float` color target matching the scene-FB velocity texture
 * format (Batch 104). Vertex stage and bind-group layout are identical
 * to the color pipeline; only the fragment entry (`fragmentVelocityMain`)
 * and target format differ.
 *
 * Depth is bound read-only (`depthWriteEnabled: false`,
 * `depthCompare: less-equal`) so the velocity pass shares the scene
 * depth from the main color pass — fragments behind opaque geometry
 * fail the depth test and don't emit velocity. The velocity pass runs
 * AFTER the main color pass closes, so the depth attachment must be
 * loaded with `depthLoadOp: load` at the pass level — that's a render-
 * pass concern, not a pipeline concern.
 *
 * Cull mode follows the doubleSided flag (matches the color pipeline)
 * so velocity is emitted from exactly the same fragments the color
 * pass shaded — no risk of velocity for back-faces that weren't drawn.
 *
 * @private
 */
function createVelocityPipeline(
  device,
  shaderModule,
  pipelineLayout,
  depthFormat,
  alphaMode,
  doubleSided,
) {
  const cullMode = doubleSided ? "none" : "back";
  const label = `Model PBR velocity [alpha=${alphaMode},ds=${doubleSided}]`;
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
      entryPoint: "fragmentVelocityMain",
      targets: [{ format: "rg16float" }],
    },
    primitive: {
      topology: "triangle-list",
      cullMode,
    },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
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
    // Batch 110 — track the scene pipeline format generation last
    // applied so a runtime HDR / canvas-format change can invalidate
    // every cached pipeline (color, pick, depth-write, velocity).
    // Pipelines have their fragment target format baked in at
    // creation; without invalidation the cached entries would
    // produce validation errors against the recreated scene FB.
    // -1 sentinel so the first call to `maybeUpdateForSceneFormat`
    // unconditionally writes the current generation without a clear.
    this._sceneFormatGeneration = -1;
    this._pipelines = new Map();
    // C-R9-MODEL-PICK (Batch 54) — pick pipeline cache, keyed by the same
    // (alphaMode, doubleSided) pair as `_pipelines`. Each pick pipeline
    // shares the layout + vertex stage of its color sibling and only
    // differs in the fragment entry + no-blend target state.
    this._pickPipelines = new Map();
    // C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 79) — depth-write variant cache,
    // populated lazily for translucent commands tagged with
    // `depthForTranslucentClassification`. Same key shape as `_pipelines`
    // (alphaMode, doubleSided), so a translucent BLEND primitive that
    // also needs depth-write gets a separate pipeline that writes depth.
    // The two variants share layout, vertex, fragment, and blend state;
    // only `depthWriteEnabled` differs. We cannot reuse `_pipelines`
    // because its key would collide for the same (alphaMode, doubleSided).
    this._depthWritePipelines = new Map();
    // TAA Slice 2e (Batch 106) — velocity pipeline cache. Same key shape
    // (alphaMode, doubleSided) as the color cache; entries are built on
    // demand the first frame TAA is enabled for any primitive carrying
    // a given (alphaMode, doubleSided) identity. Static scenes (TAA
    // off) never construct a velocity pipeline.
    this._velocityPipelines = new Map();

    // Create shared bind group layouts (NEW-BG-CONSOLIDATION, 4 groups).
    const bgls = createBindGroupLayouts(device);
    this._cameraBGL = bgls.cameraBGL;
    this._materialBGL = bgls.materialBGL; // merged: material+textures+featureId
    this._instanceBGL = bgls.instanceBGL; // merged: skinning+morph+instancing
    // Effects BGL (group 3) — shared with globe + primitive via
    // `getEffectsBindGroupLayout` factory.
    this._effectsBGL = getEffectsBindGroupLayout(device);

    // Pipeline layout — 4 bind groups. Was 8 prior to NEW-BG-CONSOLIDATION;
    // the spec-mandated `maxBindGroups: 4` requires the consolidation.
    this._pipelineLayout = device.createPipelineLayout({
      label: "Model PBR PipelineLayout",
      bindGroupLayouts: [
        this._cameraBGL, // group 0
        this._materialBGL, // group 1 (merged material + textures + feature)
        this._instanceBGL, // group 2 (merged skinning + morph + instance)
        this._effectsBGL, // group 3 (shared with globe)
      ],
    });

    // C-R7-SHADER-MODULE-DEDUP (Batch 162) — fetch from the per-device
    // cache so multiple `Model` instances on the same device share a
    // single compiled `GPUShaderModule`. The pipeline cache (this class)
    // stays per-Model because format/alphaMode/doubleSided variants are
    // per-instance; only the WGSL compilation is amortized.
    this._shaderModule = getModelShaderModuleCache(device).getOrCreate(
      ShaderSourceId.MODEL_PBR_COMPLETE,
      ModelPBRCompleteWGSL,
      0,
      "Model PBR ShaderModule",
    );

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
    // NEW-BG-CONSOLIDATION (Batch 122) — no standalone skinning BG.
    // The renderer composes the merged group 2 BG per-frame from this
    // joint buffer + morph deltas + morph weights + instance transforms.

    // Morph delta storage (1-vec4 zero), morph weight UBO (12 floats zero).
    this._defaultMorphDeltaBuffer = device.createBuffer({
      label: "default-morph-deltas",
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const zeroWeights = new Float32Array(12);
    this._defaultMorphWeightBuffer = device.createBuffer({
      label: "default-morph-weights",
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._defaultMorphWeightBuffer, 0, zeroWeights);

    // Identity instance transform storage.
    this._defaultInstancingBuffer = device.createBuffer({
      label: "default-instance-transforms",
      size: 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._defaultInstancingBuffer, 0, identityData);

    // NEW-BG-CONSOLIDATION (Batch 122) — merged group 2 default bind group.
    // Used when a primitive has none of skinning / morph / instancing.
    // All four resources are placeholder defaults; the shader checks
    // FLAG_HAS_SKINNING / FLAG_HAS_MORPH_TARGETS / FLAG_HAS_INSTANCING
    // before reading any of the underlying storage so the placeholder
    // contents are never consumed.
    this._defaultInstanceBG = device.createBindGroup({
      layout: this._instanceBGL,
      entries: [
        { binding: 0, resource: { buffer: this._defaultJointBuffer } },
        { binding: 1, resource: { buffer: this._defaultMorphDeltaBuffer } },
        { binding: 2, resource: { buffer: this._defaultMorphWeightBuffer } },
        { binding: 3, resource: { buffer: this._defaultInstancingBuffer } },
      ],
    });
    // Feature ID default UBO (14 floats — `featurePickEnabled = 0`).
    const zeroFeatureUniforms = new Float32Array(14);
    this._defaultFeatureUniformBuffer = device.createBuffer({
      label: "default-feature-uniforms",
      size: 56,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      this._defaultFeatureUniformBuffer,
      0,
      zeroFeatureUniforms,
    );
    // NEW-BG-CONSOLIDATION (Batch 122) — feature ID resources moved into
    // the merged group 1 (bindings 26-32). The default placeholder
    // entries are exposed as a function so callers can splice them
    // into a merged group-1 bind group's `entries[]` array. There's no
    // standalone feature-ID bind group anymore; the renderer always
    // builds the merged group 1.
    this._defaultFeatureIdEntries = () => [
      { binding: 26, resource: this._defaultWhiteTexture.createView() },
      { binding: 27, resource: this._defaultSampler },
      { binding: 28, resource: this._defaultWhiteTexture.createView() },
      { binding: 29, resource: this._defaultSampler },
      {
        binding: 30,
        resource: { buffer: this._defaultFeatureUniformBuffer },
      },
      { binding: 31, resource: this._defaultWhiteTexture.createView() },
      { binding: 32, resource: this._defaultSampler },
    ];
  }

  /**
   * Batch 110 — invalidate cached pipelines when the scene pipeline
   * format generation has changed (HDR toggle, MSAA toggle). Updates
   * `_presentationFormat` to the new scene-pipeline format so newly
   * created pipelines target the right fragment-output format.
   *
   * Caller (model renderer's update) invokes this once per frame
   * before any `getPipeline` / `getPickPipeline` / `getVelocityPipeline`
   * lookup. Cheap reference compare; only the first frame after a
   * format change pays for the cache wipe.
   *
   * @param {object} context WebGPUContext
   */
  maybeUpdateForSceneFormat(context) {
    const generation = context._scenePipelineFormatGeneration ?? 0;
    if (this._sceneFormatGeneration === generation) {
      return;
    }
    this._sceneFormatGeneration = generation;
    const newFormat = context.scenePipelineFormat ?? this._presentationFormat;
    if (newFormat !== this._presentationFormat) {
      this._presentationFormat = newFormat;
    }
    // Wipe all cached pipelines so the next lookup creates fresh
    // entries against the current `_presentationFormat`. The cached
    // pipelines themselves aren't `destroy()`-ed (WebGPU has no
    // pipeline destroy) — releasing the Map references is enough
    // for the JS GC to collect them once any in-flight commands
    // referencing them complete.
    this._pipelines.clear();
    this._pickPipelines.clear();
    this._depthWritePipelines.clear();
    this._velocityPipelines.clear();
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
      false,
    );
    this._pipelines.set(key, pipeline);
    return pipeline;
  }

  /**
   * C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 79) — gets or creates a depth-write
   * variant of the color pipeline for translucent 3D-tile commands tagged
   * with `depthForTranslucentClassification`. The variant differs from
   * the standard pipeline only in that `depthWriteEnabled = true` is
   * forced even for `ALPHA_BLEND`. Used by `WebGPUDrawCommand.execute()`
   * when the flag is set so flagged tiles populate the scene framebuffer's
   * depth attachment, letting the stencil-based GroundPrimitive classifier
   * clip its volumes against the tile surface instead of the globe behind it.
   *
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @returns {GPURenderPipeline}
   */
  getDepthWritePipeline(alphaMode, doubleSided) {
    const key = computeKey(alphaMode, doubleSided);
    let pipeline = this._depthWritePipelines.get(key);
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
      true,
    );
    this._depthWritePipelines.set(key, pipeline);
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

  /**
   * TAA Slice 2e (Batch 106) — gets or creates a velocity pipeline for
   * the given material configuration. Same vertex stage and pipeline
   * layout as the color pipeline; the fragment entry is
   * `fragmentVelocityMain` and the target format is `rg16float` (the
   * scene-FB velocity texture format). Depth is read-only (color pass
   * already wrote depth; velocity pass shares the same depth view at
   * `depthLoadOp: load`).
   *
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @returns {GPURenderPipeline}
   */
  getVelocityPipeline(alphaMode, doubleSided) {
    const key = computeKey(alphaMode, doubleSided);
    let pipeline = this._velocityPipelines.get(key);
    if (pipeline) {
      return pipeline;
    }
    pipeline = createVelocityPipeline(
      this._device,
      this._shaderModule,
      this._pipelineLayout,
      this._depthFormat,
      alphaMode,
      doubleSided,
    );
    this._velocityPipelines.set(key, pipeline);
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

  /**
   * Returns a fresh array of `entries[]` objects (bindings 26-32) for
   * the merged group 1 bind group when no feature ID resources are
   * available. The renderer splices these into the merged-group-1
   * `entries[]` so the BG validates against the materialBGL layout.
   * @returns {Array<GPUBindGroupEntry>}
   */
  defaultFeatureIdEntries() {
    return this._defaultFeatureIdEntries();
  }

  /** @returns {GPUBindGroupLayout} Merged group-2 BGL (skinning + morph + instancing) */
  get instanceBGL() {
    return this._instanceBGL;
  }

  /** @returns {GPUBindGroup} Default merged group-2 bind group (all-placeholder resources) */
  get defaultInstanceBindGroup() {
    return this._defaultInstanceBG;
  }

  // NEW-BG-CONSOLIDATION (Batch 122) — accessors for the underlying
  // default buffers. The renderer composes merged group 2 bind groups
  // per-frame; when a primitive lacks one of skinning / morph / instancing,
  // the corresponding slot binds the default placeholder buffer here.
  /** @returns {GPUBuffer} Identity 4×4 joint matrices storage buffer */
  get defaultJointBuffer() {
    return this._defaultJointBuffer;
  }
  /** @returns {GPUBuffer} Zero-filled morph deltas storage buffer */
  get defaultMorphDeltaBuffer() {
    return this._defaultMorphDeltaBuffer;
  }
  /** @returns {GPUBuffer} Zero-filled morph weights uniform buffer */
  get defaultMorphWeightBuffer() {
    return this._defaultMorphWeightBuffer;
  }
  /** @returns {GPUBuffer} Identity 4×4 instance transform storage buffer */
  get defaultInstancingBuffer() {
    return this._defaultInstancingBuffer;
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
