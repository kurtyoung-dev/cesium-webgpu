/**
 * @module WebGPUModelRenderer
 *
 * Comprehensive WebGPU rendering of glTF Model instances with full PBR support.
 *
 * Architecture:
 * - Model.update() runs the WebGL pipeline stages → populates renderResources
 * - Model.submitDrawCommands() delegates to this renderer via feature renderer
 * - We use shared extractors (ModelMaterialInfo, ModelPrimitiveGeometry,
 *   ModelSkinData) for renderer-agnostic data, then create WebGPU GPU resources
 *
 * Supports:
 * - Metallic-Roughness PBR (baseColor, normal, MR, emissive, occlusion textures)
 * - Specular-Glossiness PBR (diffuse, specGloss textures)
 * - Unlit materials
 * - Alpha modes (OPAQUE, MASK, BLEND)
 * - Double-sided rendering
 * - Vertex colors
 * - Normal mapping via tangent space
 * - Model-space RTE (camera encoded in model space, NOT per-vertex high/low)
 * - Skeletal animation / Skinning (joint matrices via storage buffer)
 *
 * @private
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import {
  extractMaterialInfo,
  AlphaModes,
  MaterialFlags,
} from "../../Scene/Model/ModelMaterialInfo.js";
import {
  extractPrimitiveGeometry,
  normalizeColorData,
} from "../../Scene/Model/ModelPrimitiveGeometry.js";
import {
  extractSkinData,
  updatePackedJointMatrices,
} from "../../Scene/Model/ModelSkinData.js";
import {
  ensureMorphTargetResources,
  destroyMorphTargetResources,
} from "./WebGPUModelMorphTargets.js";
import {
  ensureInstancingResources,
  destroyInstancingResources,
} from "./WebGPUModelInstancing.js";
import {
  ensureFeatureIdResources,
  destroyFeatureIdResources,
} from "./WebGPUModelFeatureId.js";
import Pass from "../Pass.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import WebGPUModelPipelineCache from "./WebGPUModelPipelineCache.js";

// ─── Constants ───────────────────────────────────────────────────────────────

// Camera uniform buffer: mat4(mvpRTE) + mat4(mvRTE) + mat4(normal) +
//   vec3+pad(camHighMC) + vec3+pad(camLowMC) + vec3+pad(camWC) = 256 bytes
const CAMERA_UNIFORM_SIZE = 256;
// Material uniform buffer: mat4(model) + vec4(baseColor) + vec3+f(emissive+metallic)
//   + 4f(rough/alpha/normal/occ) + u32(flags) + 3f(specRGB) + f(gloss) +
//   4f(diffuseRGBA) + 3f(padding) = 320 bytes (rounded to 16-byte alignment)
const MATERIAL_UNIFORM_SIZE = 320;
// Light uniform buffer: vec3+pad(sunDir) + vec3+f(sunCol+int) + vec3+pad(ambient) = 48
const LIGHT_UNIFORM_SIZE = 48;

// materialFlags bit for skinning (bit 13 = 8192)
const FLAG_HAS_SKINNING = 8192;
// materialFlags bit for instancing (bit 15 = 32768)
const FLAG_HAS_INSTANCING = 32768;

// ─── Scratch Variables ───────────────────────────────────────────────────────

const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchNormal = new Matrix4();
const scratchInverseModel = new Matrix4();
const scratchCameraMC = new Cartesian3();
const scratchEncodedCamera = new EncodedCartesian3();

// ─── Camera Uniform Packing ─────────────────────────────────────────────────

function packCameraUniforms(data, frameState, modelMatrix) {
  const uniformState = frameState.context.uniformState;

  // modelView = view * model
  Matrix4.multiply(uniformState.view, modelMatrix, scratchModelView);
  // modelViewRTE = modelView with translation zeroed
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  // mvpRTE = projection * modelViewRTE
  Matrix4.multiply(uniformState.projection, scratchMVRTE, scratchMVPRTE);

  Matrix4.pack(scratchMVPRTE, data, 0); // [0-15]
  Matrix4.pack(scratchMVRTE, data, 16); // [16-31]

  // Normal matrix = transpose(inverse(modelView))
  Matrix4.inverse(scratchModelView, scratchNormal);
  Matrix4.transpose(scratchNormal, scratchNormal);
  Matrix4.pack(scratchNormal, data, 32); // [32-47]

  // Camera position in MODEL coordinates (key RTE fix!)
  // inverse(model) * cameraPositionWC → camera in model space
  Matrix4.inverse(modelMatrix, scratchInverseModel);
  Matrix4.multiplyByPoint(
    scratchInverseModel,
    frameState.camera.positionWC,
    scratchCameraMC,
  );
  EncodedCartesian3.fromCartesian(scratchCameraMC, scratchEncodedCamera);

  data[48] = scratchEncodedCamera.high.x;
  data[49] = scratchEncodedCamera.high.y;
  data[50] = scratchEncodedCamera.high.z;
  data[51] = 0.0;
  data[52] = scratchEncodedCamera.low.x;
  data[53] = scratchEncodedCamera.low.y;
  data[54] = scratchEncodedCamera.low.z;
  data[55] = 0.0;

  // Camera position WC (for specular/IBL effects)
  const camWC = frameState.camera.positionWC;
  data[56] = camWC.x;
  data[57] = camWC.y;
  data[58] = camWC.z;
  data[59] = 0.0;
}

// ─── Material Uniform Packing ────────────────────────────────────────────────

function packMaterialUniforms(
  data,
  modelMatrix,
  matInfo,
  hasSkinning,
  hasMorphTargets,
) {
  Matrix4.pack(modelMatrix, data, 0); // [0-15]

  // baseColorFactor (vec4)
  const bc = matInfo.baseColorFactor;
  data[16] = bc[0];
  data[17] = bc[1];
  data[18] = bc[2];
  data[19] = bc[3];

  // emissiveFactor (vec3) + metallicFactor (f32)
  const ef = matInfo.emissiveFactor;
  data[20] = ef[0];
  data[21] = ef[1];
  data[22] = ef[2];
  data[23] = matInfo.metallicFactor;

  // roughness, alphaCutoff, normalScale, occlusionStrength
  data[24] = matInfo.roughnessFactor;
  data[25] = matInfo.alphaCutoff;
  data[26] = matInfo.normalScale;
  data[27] = matInfo.occlusionStrength;

  // materialFlags (u32 stored as float bits) — add skinning/morph flags
  let flags = matInfo.materialFlags;
  if (hasSkinning) {
    flags |= FLAG_HAS_SKINNING;
  }
  if (hasMorphTargets) {
    flags |= MaterialFlags.HAS_MORPH_TARGETS;
  }
  const flagsView = new DataView(data.buffer, data.byteOffset);
  flagsView.setUint32(28 * 4, flags, true);

  // specularFactor (vec3) for SpecGloss path
  const sf = matInfo.specularFactor;
  data[29] = sf[0];
  data[30] = sf[1];
  data[31] = sf[2];

  // glossinessFactor
  data[32] = matInfo.glossinessFactor;

  // diffuseFactor (vec4) for SpecGloss path
  const df = matInfo.diffuseFactor;
  data[33] = df[0];
  data[34] = df[1];
  data[35] = df[2];
  data[36] = df[3];

  // Padding to 320 bytes (80 floats)
  data[37] = 0;
  data[38] = 0;
  data[39] = 0;
}

// ─── Light Uniform Packing ───────────────────────────────────────────────────

function packLightUniforms(data, frameState) {
  const sunDir =
    frameState.context?.uniformState?.sunDirectionEC || new Cartesian3(0, 0, 1);
  data[0] = sunDir.x;
  data[1] = sunDir.y;
  data[2] = sunDir.z;
  data[3] = 0.0;
  data[4] = 1.0;
  data[5] = 1.0;
  data[6] = 1.0;
  data[7] = frameState.light?.intensity ?? 2.0;
  data[8] = 0.2;
  data[9] = 0.2;
  data[10] = 0.2;
  data[11] = 0.0;
}

// ─── GPU Texture Creation from glTF TextureReader ────────────────────────────

function createGPUTextureFromReader(device, textureReader) {
  if (!defined(textureReader)) {
    return null;
  }

  // Try to get the image source from the CesiumJS Texture
  const cesiumTexture = textureReader.texture;
  if (!defined(cesiumTexture)) {
    return null;
  }

  // The CesiumJS Texture._source holds the original ImageBitmap/HTMLImageElement
  const source =
    cesiumTexture._source || cesiumTexture.source || cesiumTexture._image;
  if (!defined(source)) {
    return null;
  }

  // Determine dimensions
  const width = source.width || source.naturalWidth || 1;
  const height = source.height || source.naturalHeight || 1;
  if (width === 0 || height === 0) {
    return null;
  }

  try {
    const gpuTexture = device.createTexture({
      label: `Model glTF texture ${width}x${height}`,
      size: [width, height, 1],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    device.queue.copyExternalImageToTexture(
      { source, flipY: false },
      { texture: gpuTexture },
      { width, height },
    );

    return gpuTexture;
  } catch (_e) {
    // Image source may not be usable (e.g., already transferred)
    return null;
  }
}

// ─── Vertex Buffer Creation ──────────────────────────────────────────────────

function createVertexBuffer(device, data, label) {
  const buffer = device.createBuffer({
    label,
    size: Math.max(data.byteLength, 4),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

// ─── Joint Matrix Buffer ─────────────────────────────────────────────────────

/**
 * Creates or updates GPU storage buffer for joint matrices.
 * @private
 */
function ensureJointMatricesBuffer(device, pipelineCache, nodeCache, skinData) {
  const byteLength = skinData.byteLength;

  // Create storage buffer if it doesn't exist or joint count changed
  if (
    !defined(nodeCache.jointBuffer) ||
    nodeCache.jointBufferSize !== byteLength
  ) {
    if (defined(nodeCache.jointBuffer)) {
      nodeCache.jointBuffer.destroy();
    }
    nodeCache.jointBuffer = device.createBuffer({
      label: `Joint matrices (${skinData.jointCount} joints)`,
      size: byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    nodeCache.jointBufferSize = byteLength;

    // Recreate bind group for new buffer
    nodeCache.skinningBG = device.createBindGroup({
      layout: pipelineCache.skinningBGL,
      entries: [{ binding: 0, resource: { buffer: nodeCache.jointBuffer } }],
    });
  }

  // Upload joint matrices
  device.queue.writeBuffer(
    nodeCache.jointBuffer,
    0,
    skinData.packedJointMatrices,
  );
}

// ─── Per-Primitive Cache ─────────────────────────────────────────────────────

/**
 * Creates or retrieves cached GPU resources for a single primitive.
 * @private
 */
function ensurePrimitiveCache(
  device,
  cache,
  pipelineCache,
  primKey,
  geometry,
  matInfo,
) {
  if (defined(cache.primitives[primKey])) {
    return cache.primitives[primKey];
  }

  const primCache = {
    positionBuffer: null,
    normalBuffer: null,
    tangentBuffer: null,
    uvBuffer: null,
    colorBuffer: null,
    jointsBuffer: null,
    weightsBuffer: null,
    indexBuffer: null,
    indexCount: 0,
    indexFormat: "uint16",
    vertexCount: geometry.vertexCount,
    materialBindGroup: null,
    textureBindGroup: null,
    pipeline: null,
    gpuTextures: [],
    hasSkinningAttributes: false,
  };

  // Position buffer (model-space, 3 floats per vertex — NOT high/low split)
  primCache.positionBuffer = createVertexBuffer(
    device,
    geometry.positionData,
    `Prim position`,
  );

  // Normal buffer
  if (geometry.hasNormals) {
    primCache.normalBuffer = createVertexBuffer(
      device,
      geometry.normalData,
      `Prim normal`,
    );
  }

  // Tangent buffer
  if (geometry.hasTangents) {
    primCache.tangentBuffer = createVertexBuffer(
      device,
      geometry.tangentData,
      `Prim tangent`,
    );
  }

  // TexCoord0 buffer
  if (geometry.hasTexCoord0) {
    primCache.uvBuffer = createVertexBuffer(
      device,
      geometry.texCoord0Data,
      `Prim uv0`,
    );
  }

  // Color0 buffer (normalize to float32)
  if (geometry.hasColor0) {
    const colorFloat = normalizeColorData(
      geometry.color0Data,
      geometry.color0ComponentType,
      geometry.color0Normalized,
    );
    primCache.colorBuffer = createVertexBuffer(
      device,
      colorFloat,
      `Prim color`,
    );
  }

  // Joints0 buffer (for skinning)
  if (geometry.hasJoints && defined(geometry.joints0Data)) {
    // JOINTS_0 must be uint32x4 for the shader
    let jointsData = geometry.joints0Data;
    if (!(jointsData instanceof Uint32Array)) {
      // Convert from Uint8Array or Uint16Array to Uint32Array
      jointsData = new Uint32Array(jointsData);
    }
    primCache.jointsBuffer = createVertexBuffer(
      device,
      jointsData,
      `Prim joints`,
    );
    primCache.hasSkinningAttributes = true;
  }

  // Weights0 buffer (for skinning)
  if (defined(geometry.weights0Data)) {
    primCache.weightsBuffer = createVertexBuffer(
      device,
      geometry.weights0Data,
      `Prim weights`,
    );
  }

  // Index buffer
  if (defined(geometry.indexData)) {
    primCache.indexFormat =
      geometry.indexType === "UNSIGNED_INT" ? "uint32" : "uint16";
    primCache.indexCount = geometry.indexCount;
    primCache.indexBuffer = device.createBuffer({
      label: `Prim index`,
      size: geometry.indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(primCache.indexBuffer, 0, geometry.indexData);
  }

  // Pipeline (varies by alpha mode and double-sided)
  primCache.pipeline = pipelineCache.getPipeline(
    matInfo.alphaMode,
    matInfo.isDoubleSided,
  );

  // Create GPU textures from glTF image sources
  const textures = createMaterialTextures(device, pipelineCache, matInfo);
  primCache.gpuTextures = textures.created;

  // Texture bind group
  const defSampler = pipelineCache.defaultSampler;
  primCache.textureBindGroup = device.createBindGroup({
    layout: pipelineCache.textureBGL,
    entries: [
      { binding: 0, resource: textures.baseColor.createView() },
      { binding: 1, resource: defSampler },
      { binding: 2, resource: textures.normal.createView() },
      { binding: 3, resource: defSampler },
      { binding: 4, resource: textures.metallicRoughness.createView() },
      { binding: 5, resource: defSampler },
      { binding: 6, resource: textures.emissive.createView() },
      { binding: 7, resource: defSampler },
      { binding: 8, resource: textures.occlusion.createView() },
      { binding: 9, resource: defSampler },
    ],
  });

  cache.primitives[primKey] = primCache;
  return primCache;
}

/**
 * Creates GPU textures for a material, falling back to defaults.
 * @private
 */
function createMaterialTextures(device, pipelineCache, matInfo) {
  const created = [];
  const defWhite = pipelineCache.defaultWhiteTexture;
  const defNormal = pipelineCache.defaultNormalTexture;
  const defBlack = pipelineCache.defaultBlackTexture;

  function tryCreate(reader, fallback) {
    if (!defined(reader)) {
      return fallback;
    }
    const tex = createGPUTextureFromReader(device, reader);
    if (defined(tex)) {
      created.push(tex);
      return tex;
    }
    return fallback;
  }

  return {
    baseColor: tryCreate(
      matInfo.baseColorTextureReader || matInfo.diffuseTextureReader,
      defWhite,
    ),
    normal: tryCreate(matInfo.normalTextureReader, defNormal),
    metallicRoughness: tryCreate(
      matInfo.metallicRoughnessTextureReader || matInfo.specGlossTextureReader,
      defWhite,
    ),
    emissive: tryCreate(matInfo.emissiveTextureReader, defBlack),
    occlusion: tryCreate(matInfo.occlusionTextureReader, defWhite),
    created,
  };
}

// ─── Main Entry Points ───────────────────────────────────────────────────────

/**
 * Updates or creates WebGPU draw commands for a Model.
 * Called from Model.submitDrawCommands() via the feature renderer.
 * Commands are pushed to frameState.commandList.
 *
 * Iterates sceneGraph._runtimeNodes → runtimeNode.runtimePrimitives
 * to access each node's skinning data alongside its primitives.
 *
 * @param {Model} model - The Model instance
 * @param {FrameState} frameState
 */
function updateWebGPUModel(model, frameState) {
  if (!model.show || !model.ready) {
    return;
  }

  const commandList = frameState.commandList;
  const context = frameState.context;
  const device = context.device;

  // Initialize model cache
  if (!defined(model._webgpuCache)) {
    model._webgpuCache = {
      pipelineCache: null,
      cameraBuffer: null,
      cameraData: null,
      cameraBG: null,
      primitives: {}, // keyed by "nodeIdx_primIdx"
      nodes: {}, // per-node skinning data, keyed by nodeIdx
    };
  }
  const cache = model._webgpuCache;

  // Create pipeline cache (shared across all primitives of this model)
  if (!defined(cache.pipelineCache)) {
    const fmt = context.presentationFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    cache.pipelineCache = new WebGPUModelPipelineCache(device, fmt, depthFmt);
  }
  const pipelineCache = cache.pipelineCache;

  // Camera uniform buffer (updated per frame)
  if (!defined(cache.cameraBuffer)) {
    cache.cameraBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      CAMERA_UNIFORM_SIZE,
      "Model camera",
    );
    cache.cameraData = new Float32Array(CAMERA_UNIFORM_SIZE / 4);
    cache.cameraBG = device.createBindGroup({
      layout: pipelineCache.cameraBGL,
      entries: [
        { binding: 0, resource: { buffer: cache.cameraBuffer.buffer } },
      ],
    });
  }

  const modelMatrix = model.modelMatrix || Matrix4.IDENTITY;
  packCameraUniforms(cache.cameraData, frameState, modelMatrix);
  device.queue.writeBuffer(
    cache.cameraBuffer.buffer,
    0,
    cache.cameraData.buffer,
    0,
    CAMERA_UNIFORM_SIZE,
  );

  // Process model by iterating nodes → primitives
  // This is the correct traversal that gives us access to each node's
  // skinning data (computedJointMatrices) alongside its primitives.
  const sceneGraph = model._sceneGraph;
  if (!defined(sceneGraph) || !defined(sceneGraph._runtimeNodes)) {
    return;
  }

  const runtimeNodes = sceneGraph._runtimeNodes;

  for (let nodeIdx = 0; nodeIdx < runtimeNodes.length; nodeIdx++) {
    const runtimeNode = runtimeNodes[nodeIdx];
    if (!defined(runtimeNode)) {
      continue;
    }

    const prims = runtimeNode.runtimePrimitives;
    if (!defined(prims) || prims.length === 0) {
      continue;
    }

    // Extract skinning data for this node (shared, renderer-agnostic)
    const skinData = extractSkinData(runtimeNode);
    const hasSkinning = defined(skinData);

    // Per-node skinning: create/update joint matrices GPU buffer
    if (hasSkinning) {
      if (!defined(cache.nodes[nodeIdx])) {
        cache.nodes[nodeIdx] = {
          jointBuffer: null,
          jointBufferSize: 0,
          skinningBG: null,
          packedJointMatrices: null,
        };
      }
      const nodeCache = cache.nodes[nodeIdx];

      // First frame: full extraction. Subsequent: incremental update.
      if (!defined(nodeCache.packedJointMatrices)) {
        nodeCache.packedJointMatrices = skinData.packedJointMatrices;
        ensureJointMatricesBuffer(device, pipelineCache, nodeCache, skinData);
      } else {
        // Update packed matrices in-place (avoids allocation)
        updatePackedJointMatrices(runtimeNode, nodeCache.packedJointMatrices);
        device.queue.writeBuffer(
          nodeCache.jointBuffer,
          0,
          nodeCache.packedJointMatrices,
        );
      }
    }

    // Get skinning bind group (node-level or default)
    const skinningBG = hasSkinning
      ? cache.nodes[nodeIdx].skinningBG
      : pipelineCache.defaultSkinningBindGroup;

    // GPU Instancing: detect from node.instances and create resources
    const nodeForInst = runtimeNode.node || runtimeNode._node;
    const hasInstancing =
      defined(nodeForInst) && defined(nodeForInst.instances);
    let instancingBG = pipelineCache.defaultInstancingBindGroup;
    let instanceCount = 1;

    if (hasInstancing) {
      if (!defined(cache.nodes[nodeIdx])) {
        cache.nodes[nodeIdx] = {
          jointBuffer: null,
          jointBufferSize: 0,
          skinningBG: null,
          packedJointMatrices: null,
        };
      }
      const nodeCache = cache.nodes[nodeIdx];
      const instRes = ensureInstancingResources(device, nodeCache, runtimeNode);
      if (defined(instRes)) {
        instanceCount = instRes.instanceCount;
        if (!defined(nodeCache.instancingBG)) {
          nodeCache.instancingBG = device.createBindGroup({
            layout: pipelineCache.instancingBGL,
            entries: [
              { binding: 0, resource: { buffer: instRes.storageBuffer } },
            ],
          });
        }
        instancingBG = nodeCache.instancingBG;
      }
    }

    // Process each primitive on this node
    for (let primIdx = 0; primIdx < prims.length; primIdx++) {
      const rp = prims[primIdx];
      const primKey = `${nodeIdx}_${primIdx}`;

      // Use shared extractors for renderer-agnostic data
      const geometry = extractPrimitiveGeometry(rp);
      if (!defined(geometry)) {
        continue;
      }

      // Get material from the primitive's glTF data
      const glTFPrimitive = rp.primitive || rp._primitive;
      const material = glTFPrimitive?.material;
      const matInfo = extractMaterialInfo(
        material,
        geometry.hasColor0,
        geometry.hasNormals,
      );

      // Get or create cached GPU resources for this primitive
      const primCache = ensurePrimitiveCache(
        device,
        cache,
        pipelineCache,
        primKey,
        geometry,
        matInfo,
      );

      // Create per-primitive material + light uniform buffers (once)
      if (!defined(primCache.materialBG)) {
        primCache.materialBuffer = WebGPUBuffer.createUniformBuffer(
          device,
          MATERIAL_UNIFORM_SIZE,
          `Prim material`,
        );
        primCache.materialData = new Float32Array(MATERIAL_UNIFORM_SIZE / 4);
        primCache.lightBuffer = WebGPUBuffer.createUniformBuffer(
          device,
          LIGHT_UNIFORM_SIZE,
          `Prim light`,
        );
        primCache.lightData = new Float32Array(LIGHT_UNIFORM_SIZE / 4);

        primCache.materialBG = device.createBindGroup({
          layout: pipelineCache.materialBGL,
          entries: [
            {
              binding: 0,
              resource: { buffer: primCache.materialBuffer.buffer },
            },
            { binding: 1, resource: { buffer: primCache.lightBuffer.buffer } },
          ],
        });
      }

      // Determine if this specific primitive has skinning
      // (node has skin AND primitive has joints/weights attributes)
      const primHasSkinning = hasSkinning && primCache.hasSkinningAttributes;

      // Morph targets: create/update GPU resources per-primitive
      const morphWeights =
        runtimeNode.morphWeights ?? runtimeNode._morphWeights;
      const primHasMorphTargets =
        geometry.morphTargetCount > 0 &&
        defined(morphWeights) &&
        morphWeights.length > 0;
      let morphTargetBG = pipelineCache.defaultMorphTargetBindGroup;

      if (primHasMorphTargets) {
        const morphRes = ensureMorphTargetResources(
          device,
          primCache,
          geometry,
          morphWeights,
        );
        if (defined(morphRes)) {
          // Create or update the morph target bind group
          if (!defined(primCache._morphTargetBG)) {
            primCache._morphTargetBG = device.createBindGroup({
              layout: pipelineCache.morphTargetBGL,
              entries: [
                { binding: 0, resource: { buffer: morphRes.storageBuffer } },
                { binding: 1, resource: { buffer: morphRes.weightBuffer } },
              ],
            });
          }
          morphTargetBG = primCache._morphTargetBG;
        }
      }

      // Update material uniforms (includes skinning + morph flags)
      packMaterialUniforms(
        primCache.materialData,
        modelMatrix,
        matInfo,
        primHasSkinning,
        primHasMorphTargets,
      );

      // Feature ID textures + batch texture (for per-feature styling)
      let featureIdBG = pipelineCache.defaultFeatureIdBindGroup;
      const featureIdRes = ensureFeatureIdResources(
        device,
        primCache,
        model,
        glTFPrimitive,
        runtimeNode,
        pipelineCache,
      );

      // Set instancing + feature ID flags AFTER packMaterialUniforms
      {
        const flagsView = new DataView(
          primCache.materialData.buffer,
          primCache.materialData.byteOffset,
        );
        let currentFlags = flagsView.getUint32(28 * 4, true);
        if (hasInstancing && instanceCount > 1) {
          currentFlags |= FLAG_HAS_INSTANCING;
        }
        if (defined(featureIdRes)) {
          currentFlags |= featureIdRes.flags;
          featureIdBG = featureIdRes.featureIdBG;
        }
        flagsView.setUint32(28 * 4, currentFlags, true);
      }

      device.queue.writeBuffer(
        primCache.materialBuffer.buffer,
        0,
        primCache.materialData.buffer,
        0,
        MATERIAL_UNIFORM_SIZE,
      );

      // Update light uniforms (per frame)
      packLightUniforms(primCache.lightData, frameState);
      device.queue.writeBuffer(
        primCache.lightBuffer.buffer,
        0,
        primCache.lightData.buffer,
        0,
        LIGHT_UNIFORM_SIZE,
      );

      // Assemble vertex buffers: [pos, normal, tangent, uv, color, joints, weights]
      const vertexBuffers = [
        primCache.positionBuffer,
        primCache.normalBuffer || pipelineCache.defaultNormalBuffer,
        primCache.tangentBuffer || pipelineCache.defaultTangentBuffer,
        primCache.uvBuffer || pipelineCache.defaultUVBuffer,
        primCache.colorBuffer || pipelineCache.defaultColorBuffer,
        primCache.jointsBuffer || pipelineCache.defaultJointsBuffer,
        primCache.weightsBuffer || pipelineCache.defaultWeightsBuffer,
      ];

      // Use model.opaquePass to get the correct pass:
      //   - Pass.CESIUM_3D_TILE for 3D Tiles content (set by Model3DTileContent)
      //   - Pass.OPAQUE for standalone models
      // Alpha blend primitives override to TRANSLUCENT
      const pass =
        matInfo.alphaMode === AlphaModes.BLEND
          ? Pass.TRANSLUCENT
          : model.opaquePass;

      const webgpuCmd = new WebGPUDrawCommand({
        pipeline: primCache.pipeline,
        bindGroups: [
          cache.cameraBG,
          primCache.materialBG,
          primCache.textureBindGroup,
          skinningBG,
          morphTargetBG,
          instancingBG,
          featureIdBG,
        ],
        vertexBuffers: vertexBuffers,
        indexBuffer: primCache.indexBuffer || undefined,
        indexCount: primCache.indexCount || 0,
        indexFormat: primCache.indexFormat || "uint16",
        vertexCount: primCache.vertexCount || 0,
        instanceCount: instanceCount,
        pass: pass,
        owner: model,
        boundingVolume: model.boundingSphere,
        modelMatrix: modelMatrix,
        cull: model._cull ?? true,
      });

      commandList.push(webgpuCmd);
    }
  }
}

/**
 * Destroys cached WebGPU resources for a Model.
 */
function destroyWebGPUModelResources(model) {
  const cache = model._webgpuCache;
  if (!defined(cache)) {
    return;
  }

  if (defined(cache.cameraBuffer)) {
    cache.cameraBuffer.destroy();
  }

  // Destroy per-primitive resources
  const primKeys = Object.keys(cache.primitives);
  for (let i = 0; i < primKeys.length; i++) {
    const pc = cache.primitives[primKeys[i]];
    if (!defined(pc)) {
      continue;
    }

    pc.positionBuffer?.destroy();
    pc.normalBuffer?.destroy();
    pc.tangentBuffer?.destroy();
    pc.uvBuffer?.destroy();
    pc.colorBuffer?.destroy();
    pc.jointsBuffer?.destroy();
    pc.weightsBuffer?.destroy();
    pc.indexBuffer?.destroy();
    pc.materialBuffer?.destroy();
    pc.lightBuffer?.destroy();

    // Destroy created GPU textures (not default ones)
    for (const tex of pc.gpuTextures) {
      tex?.destroy();
    }

    // Destroy morph target resources
    destroyMorphTargetResources(pc);

    // Destroy feature ID resources
    destroyFeatureIdResources(pc);
  }

  // Destroy per-node skinning + instancing resources
  const nodeKeys = Object.keys(cache.nodes);
  for (let i = 0; i < nodeKeys.length; i++) {
    const nc = cache.nodes[nodeKeys[i]];
    if (!defined(nc)) {
      continue;
    }
    if (defined(nc.jointBuffer)) {
      nc.jointBuffer.destroy();
    }
    destroyInstancingResources(nc);
  }

  if (defined(cache.pipelineCache)) {
    cache.pipelineCache.destroy();
  }

  model._webgpuCache = undefined;
}

export { updateWebGPUModel, destroyWebGPUModelResources };
export default { updateWebGPUModel, destroyWebGPUModelResources };
