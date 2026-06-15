/**
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
 * @module WebGPUModelRenderer
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import oneTimeWarning from "../../Core/oneTimeWarning.js";
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
  synthesizeImplicitFeatureIdData,
} from "./WebGPUModelFeatureId.js";
import Pass from "../Pass.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import WebGPUModelPipelineCache from "./WebGPUModelPipelineCache.js";
import { createEffectsBindGroup } from "./WebGPUEffectsBindGroup.js";
import { ShaderDefine } from "./WebGPUShaderDefines.js";
import {
  isWebGPULogDepthActive,
  packCameraLogDepthLanes,
} from "./WebGPULogDepth.js";
import {
  attachPickToColorCommand,
  attachPickVariantsToColorCommand,
  destroyPickIds,
  ensurePickId,
} from "./WebGPUPickCommandHelpers.js";
import {
  extractEdgeGeometry,
  createEdgeEmitterCache,
  destroyEdgeEmitterCache,
  ensureEdgeEmitterPipeline,
  createEdgePrimitiveResources,
  destroyEdgePrimitiveResources,
  writeEdgeEmitterUniforms,
} from "./WebGPUEdgeVisibilityEmitter.js";

// ─── Constants ───────────────────────────────────────────────────────────────

// Camera uniform buffer: mat4(mvpRTE) + mat4(mvRTE) + mat4(normal) +
//   vec3+pad(camHighMC) + vec3+pad(camLowMC) + vec3+pad(camWC) +
//   mat4(previousViewProjection)  = 320 bytes.
// DP-H41 (Batch 27) — previousViewProjection added at the tail for TAA /
// motion-vector reprojection. 16-byte alignment preserved (20 vec4s).
const CAMERA_UNIFORM_SIZE = 320;
// Material uniform buffer: mat4(model) + vec4(baseColor) + vec3+f(emissive+metallic)
//   + 4f(rough/alpha/normal/occ) + u32(flags) + 3f(specRGB) + f(gloss) +
//   4f(diffuseRGBA) + 3f(padding) + ... = expanded for KHR extensions.
// 768 bytes = 192 floats. Layout:
//   floats   0-15 : modelMatrix          (mat4x4)
//   floats  16-19 : baseColorFactor      (vec4)
//   floats  20-23 : emissiveFactor + metallicFactor
//   floats  24-27 : roughness/alphaCutoff/normalScale/occlusionStrength
//   floats  28    : materialFlags        (u32 stored as float bits)
//   floats  29-31 : specularFactor       (vec3)
//   floats  32    : glossinessFactor
//   floats  33-36 : diffuseFactor        (vec4)
//   floats  37    : texCoordFlags        (u32)
//   floats  38-39 : padding
//   floats  40-43 : pickColor            (vec4)
//   floats  44-55 : baseColor texture transform (3 padded vec4 cols)
//   floats  56-67 : normal texture transform
//   floats  68-79 : metallicRoughness texture transform
//   floats  80-91 : emissive texture transform
//   floats  92-103: occlusion texture transform
//   floats 104    : textureTransformFlags (u32)
//   floats 105-107: padding
//
// C-R4-GLTF-KHR (slices 2-7): each KHR extension occupies a contiguous
// 8-float (32-byte) slot at a 16-byte boundary so the WGSL std140 layout
// matches without internal padding. Factors only — texture readers are
// resolved through the existing texture binding path in a follow-up
// slice (bind-group restructure required to add the per-extension
// sampled textures).
//
//   floats 108-115: clearcoat   (factor, roughness, normalScale, _, _, _, _, _)
//   floats 116-123: specular    (factor, colorR, colorG, colorB, _, _, _, _)
//   floats 124-131: anisotropy  (strength, rotation, _, _, _, _, _, _)
//   floats 132-139: iridescence (factor, ior, thickMin, thickMax, _, _, _, _)
//   floats 140-147: sheen       (colorR, colorG, colorB, roughness, _, _, _, _)
//   floats 148-155: volume      (thickness, attenDistance, attColorR, attColorG, attColorB, _, _, _)
//   floats 156-171: previousModelMatrix (mat4x4) — TAA Slice 2c (Batch 96)
//   floats 172-175: motionFlags         (vec4: enabled, scale, _, _)
//   floats 176-179: tileBatchFlags      (vec4: passClass, opaqueThreshold, _, _) — C-R1-TILE-BATCH (Batch 100)
//   floats 180-191: reserved (texture transform extensions for KHR slots,
//                             KHR_materials_pbrSpecularGlossiness lookups, etc.)
const MATERIAL_UNIFORM_SIZE = 768;
// Light uniform buffer layout (Audit B.3 -- Batch 131; Batch 134
// bumped per-light record from 16 to 20 floats for spot direction):
//   bytes 0-63   : sun + ambient + IBL block (16 floats)
//                  - 0-3   sunDirectionEC (vec3+pad)
//                  - 4-7   sunColor (vec3) + sunIntensity
//                  - 8-11  ambientColor (vec3+pad)
//                  - 12-15 iblDiffuseFactor, iblSpecularFactor, iblMaxMipLevel, iblHasSH
//   bytes 64-79  : punctual header (4 floats)
//                  - 16    punctualLightCount (i32 stored as f32)
//                  - 17-19 padding
//   bytes 80-719 : 8 punctual lights * 20 floats = 160 floats
//                  Per-light layout matches `LightCollection.pack()`:
//                  - +0..2  direction OR position xyz
//                  - +3     lightType (0=DIR, 1=POINT, 2=SPOT)
//                  - +4..6  color rgb
//                  - +7     intensity
//                  - +8     range
//                  - +9..11 const/linear/quadratic attenuation
//                  - +12..13 inner/outer cone angles (radians)
//                  - +14..15 padding
//                  - +16..18 spotDirection xyz (spot lights only)
//                  - +19    padding
//   bytes 720-767: iblReferenceFrameMatrix (mat3x3) — NEW-MODEL-IBL-
//                  REFERENCE-FRAME (Batch 287). 3 vec4-padded columns:
//                  col0 @ floats 180-182, col1 @ 184-186, col2 @ 188-190.
// Total: 64 + 656 + 48 = 768 bytes. Keep in sync with struct
// LightUniforms in ModelPBRComplete.wgsl.
const LIGHT_UNIFORM_SIZE = 768;

// materialFlags bit for skinning (bit 13 = 8192)
const FLAG_HAS_SKINNING = 8192;
// materialFlags bit for instancing (bit 15 = 32768)
const FLAG_HAS_INSTANCING = 32768;

// Batch 174 — B.4 KHR materialBGL split. Aggregate mask of all
// KHR-extension bits the FS gates on. Mirrors the FLAG_HAS_*
// constants in ModelPBRComplete.wgsl (bits 19-25). When the
// material's flags AND this mask is zero, the renderer routes
// through the basic shader/BGL/pipeline-layout variant — bindings
// 12-25 of the materialBGL are stripped, dropping the sampled-
// texture count from 23 to 10 so the pipeline fits within the
// WebGPU spec floor `maxSampledTexturesPerShaderStage = 16`.
//
// **Scalability note:** today this is a coarse OR — any KHR bit set
// routes through the full variant. The architecture (manifest-driven
// BGL builder + per-variant pipeline cache + per-variant shader-module
// cache, all keyed on `materialDefines: number`) supports per-extension
// granular splits without further refactoring. When the WGSL ifdefs
// are split per-extension (follow-up to Batch 174), this helper can
// return a granular `materialDefines` like
// `MODEL_HAS_KHR_SPECULAR | MODEL_HAS_KHR_CLEARCOAT` — the cache will
// build a minimal layout for that exact subset that fits a 16-texture
// device even if the asset uses some KHR extensions.
const FLAG_HAS_KHR_MASK =
  524288 | // FLAG_HAS_CLEARCOAT (bit 19)
  1048576 | // FLAG_HAS_SPECULAR_EXT (bit 20)
  2097152 | // FLAG_HAS_ANISOTROPY (bit 21)
  4194304 | // FLAG_HAS_IRIDESCENCE (bit 22)
  8388608 | // FLAG_HAS_SHEEN (bit 23)
  16777216 | // FLAG_HAS_VOLUME (bit 24)
  33554432; // FLAG_HAS_TRANSMISSION (bit 25)

/**
 * Batch 174 — Computes the `materialDefines` bitmask for a primitive
 * given its material flags. The pipeline cache + BGL builder + shader-
 * module cache all key on this value.
 *
 * Today the result is binary: `0` (basic, no KHR — fits the 16-sampled-
 * texture spec floor) or `MODEL_HAS_KHR_TEXTURES` (full, all KHR
 * bindings present — needs the device to opt up
 * `maxSampledTexturesPerShaderStage` past the spec floor).
 *
 * Future: when the WGSL ifdefs are split per-KHR-extension and a new
 * `MODEL_HAS_KHR_SPECULAR` / `MODEL_HAS_KHR_CLEARCOAT` / etc. set of
 * `ShaderDefine` bits is added, this function returns the exact OR of
 * the bits the primitive's flags activate, and the cache builds a
 * minimal layout fitting within `device.limits.maxSampledTexturesPerShaderStage`.
 *
 * @private
 * @param {number} materialFlags
 * @returns {number}
 */
function computeMaterialDefines(materialFlags) {
  if ((materialFlags & FLAG_HAS_KHR_MASK) !== 0) {
    return ShaderDefine.MODEL_HAS_KHR_TEXTURES;
  }
  return 0;
}

// ─── Scratch Variables ───────────────────────────────────────────────────────

const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchNormal = new Matrix4();
const scratchInverseModel = new Matrix4();
const scratchCameraMC = new Cartesian3();
const scratchEncodedCamera = new EncodedCartesian3();
// AUDIT_2026_05_02 B.8 (Batch 152, fixed Batch 154) — per-runtime-node
// modelMatrix scratch for `modelMatrix * runtimeNode.computedTransform`.
// Reused per node per frame. Originally cited `transformToRoot` here, which
// is wrong: per `ModelRuntimeNode.js:19` `transformToRoot` excludes the
// node's own transform. WebGL's `ModelMatrixUpdateStage.updateRuntimeNode`
// (`ModelMatrixUpdateStage.js:82-86`) multiplies in `runtimeNode.transform`
// before consuming, equivalent to using `runtimeNode.computedTransform`.
const scratchNodeModelMatrix = new Matrix4();

// AUDIT_2026_05_02 B.8 — cheap "is identity" check used to skip per-node
// camera resource allocation when the node has no parent-chain transform
// (the common case for single-node models). Inlined comparison avoids the
// O(16) `Matrix4.equalsEpsilon` and the closure cost of an exact-equals path
// when called per-node per-frame.
function isIdentityMatrix4(m) {
  return (
    m[0] === 1 &&
    m[5] === 1 &&
    m[10] === 1 &&
    m[15] === 1 &&
    m[1] === 0 &&
    m[2] === 0 &&
    m[3] === 0 &&
    m[4] === 0 &&
    m[6] === 0 &&
    m[7] === 0 &&
    m[8] === 0 &&
    m[9] === 0 &&
    m[11] === 0 &&
    m[12] === 0 &&
    m[13] === 0 &&
    m[14] === 0
  );
}

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

  // Renderer-wide log depth — floats 51/55/59 carry (factor, near, far)
  // per the WebGPULogDepth.ts lane convention. Fills previously-zero pad
  // lanes; only the LOG_DEPTH module variant reads them.
  packCameraLogDepthLanes(data, 0, uniformState);

  // DP-H41 (Batch 27) — previousViewProjection at offset 60..75 (16 floats).
  // `UniformState.update()` clones the current viewProjection into
  // `_previousViewProjection` BEFORE overwriting it with the new camera
  // state, so on frame N this slot holds frame N-1's viewProjection.
  // TAA / motion-vector shaders consume it via `camera.previousViewProjection`.
  const prevVP = uniformState.previousViewProjection;
  if (prevVP) {
    Matrix4.pack(prevVP, data, 60);
  } else {
    // Column-major identity fallback (frame 0).
    data[60] = 1;
    data[61] = 0;
    data[62] = 0;
    data[63] = 0;
    data[64] = 0;
    data[65] = 1;
    data[66] = 0;
    data[67] = 0;
    data[68] = 0;
    data[69] = 0;
    data[70] = 1;
    data[71] = 0;
    data[72] = 0;
    data[73] = 0;
    data[74] = 0;
    data[75] = 1;
  }
}

// ─── Material Uniform Packing ────────────────────────────────────────────────

function packMaterialUniforms(
  data,
  modelMatrix,
  matInfo,
  hasSkinning,
  hasMorphTargets,
  pickColor,
  previousModelMatrix,
  motionEnabled,
  passClass,
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

  // Per-texture UV-set bitmask (slot 37, u32). glTF textureInfos carry a
  // per-texture `texCoord: 0|1` flag that selects which vertex UV set
  // (TEXCOORD_0 or TEXCOORD_1) a given sampler reads. Occlusion maps
  // commonly use TEXCOORD_1 while the base color stays on TEXCOORD_0;
  // without honoring the flag, occlusion blotches land in the wrong place
  // relative to the diffuse image. The shader reads this bitmask via
  // `material.texCoordFlags` and branches the UV input per sampling site.
  let tcFlags = 0;
  const baseReader =
    matInfo.baseColorTextureReader || matInfo.diffuseTextureReader;
  const normalReader = matInfo.normalTextureReader;
  const mrReader =
    matInfo.metallicRoughnessTextureReader || matInfo.specGlossTextureReader;
  const emissiveReader = matInfo.emissiveTextureReader;
  const occlusionReader = matInfo.occlusionTextureReader;
  if (baseReader && baseReader.texCoord === 1) {
    tcFlags |= 0x01;
  }
  if (normalReader && normalReader.texCoord === 1) {
    tcFlags |= 0x02;
  }
  if (mrReader && mrReader.texCoord === 1) {
    tcFlags |= 0x04;
  }
  if (emissiveReader && emissiveReader.texCoord === 1) {
    tcFlags |= 0x08;
  }
  if (occlusionReader && occlusionReader.texCoord === 1) {
    tcFlags |= 0x10;
  }
  flagsView.setUint32(37 * 4, tcFlags, true);

  // Padding to maintain vec4 alignment for the next field (pickColor).
  // texCoordFlags lives at slot 37; slots 38-39 pad up to the 16-byte
  // boundary at slot 40 where pickColor (vec4) starts.
  data[38] = 0;
  data[39] = 0;

  // C-R9-MODEL-PICK (Batch 54) — pickColor slot (floats 40-43). Zero
  // when no pick ID has been registered yet (e.g., a non-pick render
  // pass before the model first enters a pick pass). The pick command
  // itself is only attached to derivedCommands.picking when a pick
  // color is available, so the zeros never reach the pick FBO.
  if (pickColor) {
    data[40] = pickColor.red;
    data[41] = pickColor.green;
    data[42] = pickColor.blue;
    data[43] = pickColor.alpha;
  } else {
    data[40] = 0;
    data[41] = 0;
    data[42] = 0;
    data[43] = 0;
  }

  // C-R4-GLTF-KHR (slice 1) — KHR_texture_transform per-texture 3x3.
  // GltfLoaderUtil.createModelTextureReader extracts the
  // `KHR_texture_transform` extension into a Matrix3 stored on the
  // reader's `.transform` slot when the asset uses the extension.
  // Pack each (or identity) into 3 padded vec4 columns. Bits in
  // textureTransformFlags indicate which slots have non-identity
  // transforms so the FS can skip the matrix multiply for the common
  // no-extension case.
  let ttFlags = 0;
  ttFlags |= writeTextureTransform(data, 44, baseReader?.transform) ? 0x01 : 0;
  ttFlags |= writeTextureTransform(data, 56, normalReader?.transform)
    ? 0x02
    : 0;
  ttFlags |= writeTextureTransform(data, 68, mrReader?.transform) ? 0x04 : 0;
  ttFlags |= writeTextureTransform(data, 80, emissiveReader?.transform)
    ? 0x08
    : 0;
  ttFlags |= writeTextureTransform(data, 92, occlusionReader?.transform)
    ? 0x10
    : 0;
  flagsView.setUint32(104 * 4, ttFlags, true);
  // Padding to 16-byte boundary.
  data[105] = 0;
  data[106] = 0;
  data[107] = 0;

  // C-R4-GLTF-KHR (slices 2-7) — KHR material extension factors.
  // Each block is 8 floats (32 B); identity values for the inactive
  // case are written so a stale buffer never stamps garbage into a
  // newly-promoted "extension active" frame.

  // Clearcoat (slot 108-115).
  data[108] = matInfo.hasClearcoat ? matInfo.clearcoatFactor : 0.0;
  data[109] = matInfo.hasClearcoat ? matInfo.clearcoatRoughnessFactor : 0.0;
  data[110] = matInfo.hasClearcoat ? matInfo.clearcoatNormalScale : 1.0;
  data[111] = 0;
  data[112] = 0;
  data[113] = 0;
  data[114] = 0;
  data[115] = 0;

  // Specular ext (slot 116-123).
  data[116] = matInfo.hasSpecularExt ? matInfo.specularExtFactor : 1.0;
  if (matInfo.hasSpecularExt) {
    const sec = matInfo.specularExtColorFactor;
    data[117] = sec[0];
    data[118] = sec[1];
    data[119] = sec[2];
  } else {
    data[117] = 1;
    data[118] = 1;
    data[119] = 1;
  }
  data[120] = 0;
  data[121] = 0;
  data[122] = 0;
  data[123] = 0;

  // Anisotropy (slot 124-131).
  data[124] = matInfo.hasAnisotropy ? matInfo.anisotropyStrength : 0.0;
  data[125] = matInfo.hasAnisotropy ? matInfo.anisotropyRotation : 0.0;
  data[126] = 0;
  data[127] = 0;
  data[128] = 0;
  data[129] = 0;
  data[130] = 0;
  data[131] = 0;

  // Iridescence (slot 132-139).
  data[132] = matInfo.hasIridescence ? matInfo.iridescenceFactor : 0.0;
  data[133] = matInfo.hasIridescence ? matInfo.iridescenceIor : 1.3;
  data[134] = matInfo.hasIridescence
    ? matInfo.iridescenceThicknessMinimum
    : 100;
  data[135] = matInfo.hasIridescence
    ? matInfo.iridescenceThicknessMaximum
    : 400;
  data[136] = 0;
  data[137] = 0;
  data[138] = 0;
  data[139] = 0;

  // Sheen (slot 140-147).
  if (matInfo.hasSheen) {
    const sc = matInfo.sheenColorFactor;
    data[140] = sc[0];
    data[141] = sc[1];
    data[142] = sc[2];
    data[143] = matInfo.sheenRoughnessFactor;
  } else {
    data[140] = 0;
    data[141] = 0;
    data[142] = 0;
    data[143] = 0;
  }
  data[144] = 0;
  data[145] = 0;
  data[146] = 0;
  data[147] = 0;

  // Volume (slot 148-155). attenuationDistance defaults to +Infinity in
  // glTF spec; encode as 0 in the shader's "no attenuation" sentinel
  // since dividing by it would NaN the FS — the FS reads `volumeFlags`
  // (HAS_VOLUME bit) before applying Beer-Lambert anyway.
  data[148] = matInfo.hasVolume ? matInfo.thicknessFactor : 0.0;
  if (matInfo.hasVolume) {
    const ad = matInfo.attenuationDistance;
    data[149] = isFinite(ad) ? ad : 0.0;
    const ac = matInfo.attenuationColor;
    data[150] = ac[0];
    data[151] = ac[1];
    data[152] = ac[2];
  } else {
    data[149] = 0;
    data[150] = 1;
    data[151] = 1;
    data[152] = 1;
  }
  data[153] = 0;
  data[154] = 0;
  data[155] = 0;

  // TAA Slice 2c (Batch 96) — previousModelMatrix (slots 156-171). Pack
  // the prev-frame matrix when one is provided; otherwise mirror the
  // current matrix so a model in its first rendered frame produces
  // zero velocity (no spurious motion blur on initial display). The
  // WGSL VS reads this through `material.previousModelMatrix` and
  // multiplies by `camera.previousViewProjection` for the prev clip
  // pos.
  if (previousModelMatrix) {
    Matrix4.pack(previousModelMatrix, data, 156);
  } else {
    Matrix4.pack(modelMatrix, data, 156);
  }

  // motionFlags (slot 172-175):
  //   x: motion-vector output enabled (0 / 1) — the WGSL FS
  //      `computeMotionVectorScreenSpace` early-outs to zero when 0.
  //   y: motion-vector scale (default 1.0)
  //   z, w: reserved (sky reprojection / disocclusion params, slice 2d)
  data[172] = motionEnabled ? 1.0 : 0.0;
  data[173] = 1.0;
  data[174] = 0;
  data[175] = 0;

  // C-R1-TILE-BATCH (Batch 100) — tileBatchFlags (slot 176-179):
  //   x: passClass (0 = opaque pass, 1 = translucent pass) — only
  //      consumed when the FLAG_HAS_BATCH_TABLE bit is set; otherwise
  //      the FS branch is short-circuited.
  //   y: opaque-alpha threshold (default 0.998) used by the FS branch
  //      to decide which pass a given feature lands in.
  //   z, w: reserved.
  data[176] = passClass ? 1.0 : 0.0;
  data[177] = 0.998;
  data[178] = 0;
  data[179] = 0;

  // C-R4-GLTF-KHR-TRANSMISSION (Batch 105) — transmissionFactors
  // (slot 180-183):
  //   x: transmissionFactor [0, 1]
  //   y: ior (default 1.5 — common dielectric / glass refractive index)
  //   z, w: reserved
  data[180] = matInfo.hasTransmission ? matInfo.transmissionFactor : 0.0;
  data[181] = 1.5;
  data[182] = 0;
  data[183] = 0;

  // Reserved (slot 184-191). Zero-fill for std140 stability.
  for (let i = 184; i < 192; i++) {
    data[i] = 0;
  }
}

/**
 * Pack a Matrix3 into 3 padded vec4 columns starting at `offsetFloats`
 * (12 floats consumed). Returns true when a non-identity matrix was
 * written (signal the caller to set the corresponding "has transform"
 * bit). When `m` is undefined or null, writes an identity matrix and
 * returns false.
 *
 * The caller's UBO layout reserves 12 floats per slot for std140-
 * compatible 3-padded-vec4 storage; the WGSL side reconstructs the
 * mat3x3 with `mat3x3<f32>(col0.xyz, col1.xyz, col2.xyz)`.
 *
 * @param {Float32Array} data
 * @param {number} offsetFloats
 * @param {Matrix3|undefined|null} m  Cesium Matrix3 (column-major: m[0..2]=col0, m[3..5]=col1, m[6..8]=col2)
 * @returns {boolean} true iff `m` was a defined matrix.
 * @private
 */
function writeTextureTransform(data, offsetFloats, m) {
  if (defined(m)) {
    // Column 0
    data[offsetFloats + 0] = m[0];
    data[offsetFloats + 1] = m[1];
    data[offsetFloats + 2] = m[2];
    data[offsetFloats + 3] = 0;
    // Column 1
    data[offsetFloats + 4] = m[3];
    data[offsetFloats + 5] = m[4];
    data[offsetFloats + 6] = m[5];
    data[offsetFloats + 7] = 0;
    // Column 2
    data[offsetFloats + 8] = m[6];
    data[offsetFloats + 9] = m[7];
    data[offsetFloats + 10] = m[8];
    data[offsetFloats + 11] = 0;
    return true;
  }
  // Identity (no transform). The FS guard skips the multiply when the
  // slot's "has transform" bit is unset, so these slots are technically
  // never read — but writing the identity keeps the buffer
  // self-consistent and makes the dump readable in PIX/RenderDoc.
  data[offsetFloats + 0] = 1;
  data[offsetFloats + 1] = 0;
  data[offsetFloats + 2] = 0;
  data[offsetFloats + 3] = 0;
  data[offsetFloats + 4] = 0;
  data[offsetFloats + 5] = 1;
  data[offsetFloats + 6] = 0;
  data[offsetFloats + 7] = 0;
  data[offsetFloats + 8] = 0;
  data[offsetFloats + 9] = 0;
  data[offsetFloats + 10] = 1;
  data[offsetFloats + 11] = 0;
  return false;
}

// ─── Light Uniform Packing ───────────────────────────────────────────────────

function packLightUniforms(data, frameState, model) {
  // Session 65 Batch 18 — pack `lightDirectionEC` (the SCENE LIGHT
  // direction) instead of `sunDirectionEC`. When the scene uses a
  // SunLight, these are identical (see `UniformState.update` line
  // 836-844). When the scene overrides `scene.light` with a custom
  // `DirectionalLight` (e.g., a hillshade direction or an artist-
  // controlled key light), only `lightDirectionEC` reflects the
  // user-set value. Mirrors upstream PBR shaders which reference
  // `czm_lightDirectionEC`, not `czm_sunDirectionEC`. The previous
  // sun-direction code path caused custom-lit models to receive sun
  // illumination regardless of `scene.light`, identical in shape to
  // the Globe lighting bug fixed in Batch 17. Variable name kept as
  // `sunDir` for back-compat with the WGSL uniform field — renaming
  // is a separate refactor.
  const sunDir =
    frameState.context?.uniformState?.lightDirectionEC ||
    new Cartesian3(0, 0, 1);
  data[0] = sunDir.x;
  data[1] = sunDir.y;
  data[2] = sunDir.z;
  data[3] = 0.0;

  // sunColor — honor scene.light.color (public API, defaults to white sunlight).
  const light = frameState.light;
  const lightColor = light?.color;
  if (lightColor) {
    data[4] = lightColor.red;
    data[5] = lightColor.green;
    data[6] = lightColor.blue;
  } else {
    data[4] = 1.0;
    data[5] = 1.0;
    data[6] = 1.0;
  }
  data[7] = light?.intensity ?? 2.0;

  // ambientColor — small neutral floor so unlit faces aren't pitch black.
  data[8] = 0.2;
  data[9] = 0.2;
  data[10] = 0.2;
  data[11] = 0.0;

  // IBL factors — consumed by ModelPBRComplete.wgsl for split-sum ambient.
  // When the model's ImageBasedLighting is disabled or absent we still write a
  // sensible default so the ambient term isn't silently zeroed (shader
  // multiplies ambientColor * iblDiffuseFactor; a zero factor drops the term).
  const ibl = model?._imageBasedLighting;
  const iblFactor = ibl?._imageBasedLightingFactor; // Cartesian2 (x=diffuse, y=specular)
  data[12] = iblFactor?.x ?? 1.0;
  data[13] = iblFactor?.y ?? 1.0;
  // Audit A.9 (Batch 130) — max mip level of the prefiltered specular
  // cubemap. The WebGPU IBL pipeline (`WebGPUImageBasedLighting`)
  // exposes `_webgpuMaxMipLevel` after generation; falls back to the
  // upstream `_specularEnvironmentMapAtlas` mip count for compatibility
  // with assets that bypassed the prefilter, and finally to 5 (matches
  // the `RADIANCE_MIP_LEVELS - 1` default in `WebGPUIBLPipeline.ts`).
  data[14] =
    ibl?._webgpuMaxMipLevel ??
    ibl?._specularEnvironmentMapAtlas?._maximumMipmapLevel ??
    5.0;
  data[15] = ibl?._sphericalHarmonicCoefficients ? 1.0 : 0.0;

  // Audit B.3 (Batch 131) + re-review (Batch 134) -- punctual lights.
  // Merges `frameState.lights` (scene-level, world-space) with
  // `model.lightsFromGltf` (KHR_lights_punctual asset lights, model
  // space transformed through `model.modelMatrix` here). Caps at 8
  // total -- scene lights win when the union exceeds the cap so
  // user-added lights aren't silently dropped by a noisy asset.
  packPunctualLights(data, 16, frameState.lights, model);

  // NEW-MODEL-IBL-REFERENCE-FRAME (Batch 287) — eye→IBL-frame rotation
  // (`model._iblReferenceFrameMatrix`, a column-major Cesium Matrix3 set
  // by `updateReferenceMatrices` every frame). Mirrors WebGL's
  // `model_iblReferenceFrameMatrix` mat3 uniform. Packed at the tail of
  // LightUniforms (byte 720 / float 180) as a WGSL mat3x3<f32>: three
  // vec4-padded columns (each column's xyz at floats 0/1/2, pad at 3).
  // Defaults to identity (Matrix3.IDENTITY clone) so a model without IBL
  // configured samples the placeholder cubemap unrotated.
  packIBLReferenceFrame(data, 180, model);
}

// NEW-MODEL-IBL-REFERENCE-FRAME (Batch 287) — writes the model's
// `_iblReferenceFrameMatrix` (column-major Matrix3) into a WGSL
// std140 mat3x3 slot (3 vec4-padded columns).
function packIBLReferenceFrame(data, floatOffset, model) {
  const m = model?._iblReferenceFrameMatrix;
  if (!m) {
    // Identity fallback (no IBL frame available yet).
    data[floatOffset + 0] = 1.0;
    data[floatOffset + 1] = 0.0;
    data[floatOffset + 2] = 0.0;
    data[floatOffset + 4] = 0.0;
    data[floatOffset + 5] = 1.0;
    data[floatOffset + 6] = 0.0;
    data[floatOffset + 8] = 0.0;
    data[floatOffset + 9] = 0.0;
    data[floatOffset + 10] = 1.0;
    return;
  }
  // Cesium Matrix3 is column-major: m[0..2]=col0, m[3..5]=col1, m[6..8]=col2.
  // WGSL mat3x3 columns are vec4-padded (stride 4 floats).
  data[floatOffset + 0] = m[0];
  data[floatOffset + 1] = m[1];
  data[floatOffset + 2] = m[2];
  data[floatOffset + 4] = m[3];
  data[floatOffset + 5] = m[4];
  data[floatOffset + 6] = m[5];
  data[floatOffset + 8] = m[6];
  data[floatOffset + 9] = m[7];
  data[floatOffset + 10] = m[8];
}

// Audit B.3 (Batch 131) + re-review (Batch 134) -- pre-allocated
// scratch matching `LightCollection.pack()`'s output (164 floats =
// 656 bytes; 4-float header + 8 lights × 20 floats). Re-used per-
// call to avoid GC pressure on every model draw.
const scratchLightPack = new Float32Array(164);

// NEW-KHR-LIGHTS-PUNCTUAL (Batch 134) -- pack scene-level
// `LightCollection` lights AND glTF KHR_lights_punctual lights
// (model-space, transformed by model.modelMatrix here) into the
// per-model UBO's punctual region starting at `floatOffset`. Scene
// lights take priority when the combined count exceeds MAX_LIGHTS=8.
const MAX_PUNCTUAL_LIGHTS = 8;
const FLOATS_PER_PUNCTUAL_LIGHT = 20;
function packPunctualLights(data, floatOffset, sceneLights, model) {
  // Header (4 floats: lightCount + 3 pad) followed by 8 light slots.
  // Total region = 4 + 8 * 20 = 164 floats. Always zero the entire
  // region first so previous frame's data doesn't leak when light
  // counts shrink.
  const regionEnd =
    floatOffset + 4 + MAX_PUNCTUAL_LIGHTS * FLOATS_PER_PUNCTUAL_LIGHT;
  data.fill(0, floatOffset, regionEnd);

  let writeIndex = 0;

  // 1. Scene lights -- already world-space, use the existing pack().
  if (sceneLights && sceneLights.length > 0) {
    const packed = sceneLights.pack(scratchLightPack);
    const sceneCount = packed[0] | 0;
    const sceneSlots = Math.min(sceneCount, MAX_PUNCTUAL_LIGHTS);
    for (let i = 0; i < sceneSlots; i++) {
      const srcOffset = 4 + i * FLOATS_PER_PUNCTUAL_LIGHT;
      const dstOffset =
        floatOffset + 4 + writeIndex * FLOATS_PER_PUNCTUAL_LIGHT;
      for (let f = 0; f < FLOATS_PER_PUNCTUAL_LIGHT; f++) {
        data[dstOffset + f] = packed[srcOffset + f];
      }
      writeIndex++;
    }
  }

  // 2. glTF KHR_lights_punctual lights -- model space, transform with
  // model.modelMatrix to get world space. Each entry's
  // position/direction is already model-space (node hierarchy applied
  // at parse time); we just multiply by the model matrix to lift to
  // world coords.
  const gltfLights = model?.lightsFromGltf;
  if (
    Array.isArray(gltfLights) &&
    gltfLights.length > 0 &&
    writeIndex < MAX_PUNCTUAL_LIGHTS
  ) {
    const mm = model.modelMatrix;
    const remaining = MAX_PUNCTUAL_LIGHTS - writeIndex;
    const gltfCount = Math.min(gltfLights.length, remaining);
    for (let i = 0; i < gltfCount; i++) {
      const lt = gltfLights[i];
      const dst = floatOffset + 4 + writeIndex * FLOATS_PER_PUNCTUAL_LIGHT;
      // Resolve world position / direction. Directional: posOrDir
      // holds direction; point/spot: posOrDir holds position.
      const wp = lt.position
        ? mm
          ? Matrix4.multiplyByPoint(mm, lt.position, scratchLightVec3a)
          : lt.position
        : null;
      const wd = lt.direction
        ? mm
          ? Matrix4.multiplyByPointAsVector(mm, lt.direction, scratchLightVec3b)
          : lt.direction
        : null;
      // Slots 0-2: posOrDir (directional uses direction; others use position).
      if (lt.type === 0 /* DIR */) {
        data[dst + 0] = wd?.x ?? 0;
        data[dst + 1] = wd?.y ?? 0;
        data[dst + 2] = wd?.z ?? 0;
      } else {
        data[dst + 0] = wp?.x ?? 0;
        data[dst + 1] = wp?.y ?? 0;
        data[dst + 2] = wp?.z ?? 0;
      }
      data[dst + 3] = lt.type;
      data[dst + 4] = lt.color?.red ?? 1;
      data[dst + 5] = lt.color?.green ?? 1;
      data[dst + 6] = lt.color?.blue ?? 1;
      data[dst + 7] = lt.intensity ?? 1;
      data[dst + 8] = lt.range ?? 0;
      // Const/linear/quadratic atten unused for spec-compliant range
      // attenuation; leave zero.
      data[dst + 12] = lt.innerConeAngle ?? 0;
      data[dst + 13] = lt.outerConeAngle ?? 0;
      // Spot direction at slots 16-18 (when applicable).
      if (lt.type === 2 /* SPOT */ && wd) {
        data[dst + 16] = wd.x;
        data[dst + 17] = wd.y;
        data[dst + 18] = wd.z;
      }
      writeIndex++;
    }
  }

  // Header: total lightCount.
  data[floatOffset] = writeIndex;
}

// Scratch Cartesians for the matrix-multiply in `packPunctualLights`
// (avoid per-frame allocation).
const scratchLightVec3a = new Cartesian3();
const scratchLightVec3b = new Cartesian3();

// ─── GPU Texture Creation from glTF TextureReader ────────────────────────────

function createGPUTextureFromReader(device, textureReader, colorSpace) {
  if (!defined(textureReader)) {
    return null;
  }

  // Try to get the image source from the CesiumJS Texture
  const cesiumTexture = textureReader.texture;
  if (!defined(cesiumTexture)) {
    return null;
  }

  // Session 65 fix for "3D Tiles base color white" (Mars / Moon /
  // Aerometrex SF / BIM photogrammetry): in WebGPU mode the CesiumJS
  // Texture is backed by WebGLStubTexture, which uploads the image to
  // a real `GPUTexture` and stashes it on `texture._texture._webgpuTexture.texture`.
  // The previous implementation only looked at `cesiumTexture._source`
  // (the original ImageBitmap), which CesiumJS Texture does NOT
  // retain after upload — so every glTF / 3D Tiles texture fell back
  // to the white placeholder, which is exactly the symptom reported.
  // Reuse the already-uploaded GPU texture directly when available.
  const stubWrapper = cesiumTexture._texture;
  const stubGPU = stubWrapper && stubWrapper._webgpuTexture;
  if (stubGPU && stubGPU.texture) {
    return stubGPU.texture;
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

  // Pick the texture format based on the semantic color space of the slot:
  //   "srgb" → rgba8unorm-srgb: GPU sampler auto-decodes sRGB → linear, so
  //            the shader doesn't need pow(x, 2.2) approximation, and
  //            linear filtering is perceptually correct.
  //   else   → rgba8unorm: stays in linear (correct for normal / MR /
  //            occlusion / data textures that must not be gamma-corrected).
  const format = colorSpace === "srgb" ? "rgba8unorm-srgb" : "rgba8unorm";

  try {
    const gpuTexture = device.createTexture({
      label: `Model glTF texture ${width}x${height} (${format})`,
      size: [width, height, 1],
      format,
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
    // NEW-BG-CONSOLIDATION (Batch 122) — no standalone skinning BG
    // anymore. The renderer composes the merged group 2 BG per-frame
    // using `nodeCache.jointBuffer` directly.
  }

  // Upload joint matrices
  device.queue.writeBuffer(
    nodeCache.jointBuffer,
    0,
    skinData.packedJointMatrices,
  );
}

/**
 * Audit A.5 (Batch 130) — lazily allocates the per-node prev-frame
 * joint matrix storage buffer that the WGSL velocity pass binds
 * at group(2) binding(4). Sized to match the current `jointBuffer`
 * (`prevPackedJointMatrices` length × 4 bytes); recreated when the
 * skin's joint count changes (skin swaps are rare but legal in glTF).
 *
 * @private
 */
function ensurePrevJointMatricesBuffer(device, nodeCache) {
  const byteLength = nodeCache.prevPackedJointMatrices.byteLength;
  if (
    !defined(nodeCache.prevJointBuffer) ||
    nodeCache.prevJointBuffer.size !== byteLength
  ) {
    if (defined(nodeCache.prevJointBuffer)) {
      nodeCache.prevJointBuffer.destroy();
    }
    nodeCache.prevJointBuffer = device.createBuffer({
      label: `Prev joint matrices`,
      size: byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }
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
    featureIdBuffer: null,
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

  // TexCoord1 buffer — glTF textureInfos carry a `texCoord: 0|1` flag,
  // so occlusion + clearcoat-normal frequently want TEXCOORD_1 while the
  // base color stays on TEXCOORD_0. Upload the slot whenever the primitive
  // provided it; the pipeline layout + shader consumer wire it to the
  // binding used by textures whose texCoord == 1 (see
  // WebGPUModelPipelineCache.js vertex-layout slot 7 / TEXCOORD_1).
  if (geometry.hasTexCoord1 && defined(geometry.texCoord1Data)) {
    primCache.uv1Buffer = createVertexBuffer(
      device,
      geometry.texCoord1Data,
      `Prim uv1`,
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

  // Audit B.2 (Batch 130) — `_FEATURE_ID_0` (b3dm `_BATCHID`) vertex
  // buffer. Required for per-feature pick / per-feature styling on
  // tilesets that encode feature IDs as a vertex attribute (the
  // dominant b3dm case). Without this slot bound, the FS pick path
  // can only resolve features when the source uses the
  // EXT_mesh_features texture variant — almost no production tileset
  // does.
  if (geometry.hasFeatureId0 && defined(geometry.featureId0Data)) {
    primCache.featureIdBuffer = createVertexBuffer(
      device,
      geometry.featureId0Data,
      `Prim featureId`,
    );
  }

  // Index buffer
  if (defined(geometry.indexData)) {
    primCache.indexFormat =
      geometry.indexType === "UNSIGNED_INT" ? "uint32" : "uint16";
    primCache.indexCount = geometry.indexCount;
    // WebGPU requires `writeBuffer` source byteLength to be a multiple
    // of 4. Uint16 index buffers with an odd index count produce
    // `byteLength % 4 === 2`, which the original code passed straight
    // to `writeBuffer` and crashed under glTF models that have one —
    // CZML Model Articulations is one such asset. Pad the buffer +
    // source to the nearest 4 bytes; the extra slot is never read
    // because `indexCount` stays at the geometry's authoritative
    // value (Session 65 Batch 5, 2026-05-11).
    const indexByteLength = geometry.indexData.byteLength;
    const alignedIndexByteLength = (indexByteLength + 3) & ~3;
    primCache.indexBuffer = device.createBuffer({
      label: `Prim index`,
      size: Math.max(alignedIndexByteLength, 4),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    if (alignedIndexByteLength === indexByteLength) {
      device.queue.writeBuffer(primCache.indexBuffer, 0, geometry.indexData);
    } else {
      const padded = new Uint8Array(alignedIndexByteLength);
      padded.set(
        new Uint8Array(
          geometry.indexData.buffer,
          geometry.indexData.byteOffset,
          indexByteLength,
        ),
      );
      device.queue.writeBuffer(primCache.indexBuffer, 0, padded);
    }
  }

  // Pipeline (varies by alpha mode and double-sided)
  // Batch 174 — B.4 select the materialDefines bitmask based on the
  // primitive's material flags. Track the value on primCache so
  // subsequent pipeline lookups (pick, velocity, classification,
  // depth-write) stay consistent across passes for this primitive.
  // This same value is also used to filter the texture-entries array
  // and select the matching per-variant materialBGL when building
  // the merged group 1 bind group below.
  // Session 62 NEW-VR-VERTEX-BUFFER-VARIANT — primitive's TEXCOORD_1
  // attribute presence drives MODEL_HAS_TEXCOORD_1. When unset, the
  // pipeline omits vertex buffer slot 7 (8-slot layout, fitting Edge's
  // adapter cap of `maxVertexBuffers = 8`); when set, the layout
  // includes slot 7 (9 slots, requires adapter ≥ 9).
  //
  // Session 65 follow-up — same treatment for slot 8 (featureId0). With
  // both flags off (the common case for standard glTF models without
  // multi-UV or batched feature IDs) the pipeline lands at 7 slots,
  // leaving headroom on Edge's adapter. The implicit-range synthesis
  // above sets `geometry.hasFeatureId0 = true` when a batched 3D Tile
  // expects feature IDs but the glTF accessor is missing, so this read
  // sees the final, post-synthesis value.
  let materialDefines = computeMaterialDefines(matInfo.materialFlags);
  if (geometry.hasTexCoord1) {
    materialDefines |= ShaderDefine.MODEL_HAS_TEXCOORD_1;
  }
  if (geometry.hasFeatureId0) {
    materialDefines |= ShaderDefine.MODEL_HAS_FEATURE_ID_0;
  }
  primCache.materialDefines = materialDefines;
  primCache.pipeline = pipelineCache.getPipeline(
    matInfo.alphaMode,
    matInfo.isDoubleSided,
    materialDefines,
  );

  // C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 79) — for translucent BLEND
  // primitives we eagerly cache the depth-write variant too. A 3D-tile
  // model whose content carries this primitive may set
  // `depthForTranslucentClassification = true` on its WebGPUDrawCommand
  // (per `Cesium3DTile.update`); when that flag is set the command will
  // bind this variant in `WebGPUDrawCommand.execute()` so the tile
  // surface populates the scene-FB depth attachment, letting the
  // stencil-based GroundPrimitive classifier clip against the tile.
  // OPAQUE/MASK primitives already write depth, so the variant only
  // matters for BLEND.
  if (matInfo.alphaMode === AlphaModes.BLEND) {
    primCache.depthWritePipeline = pipelineCache.getDepthWritePipeline(
      matInfo.alphaMode,
      matInfo.isDoubleSided,
      materialDefines,
    );
  }

  // Create GPU textures from glTF image sources
  const textures = createMaterialTextures(device, pipelineCache, matInfo);
  primCache.gpuTextures = textures.created;
  // Stash matInfo + placeholderSlots so the per-frame
  // refreshDeferredModelTextures helper can poll the readers and
  // upgrade fallback-textured slots when the real images finish
  // loading. See refreshDeferredModelTextures() comment.
  primCache.matInfo = matInfo;
  primCache.placeholderSlots = textures.placeholderSlots;

  // Texture bind group — one sampler per slot, resolved from the glTF
  // textureInfo's sampler block so per-texture magFilter / wrapS / wrapT
  // actually propagate. Missing samplers fall back to defaultSampler
  // (linear / linear / repeat) which matches the glTF spec default.
  const defSampler = pipelineCache.defaultSampler;
  const baseSampler = pipelineCache.getSamplerForReader(
    matInfo.baseColorTextureReader || matInfo.diffuseTextureReader,
  );
  const normalSampler = pipelineCache.getSamplerForReader(
    matInfo.normalTextureReader,
  );
  const mrSampler = pipelineCache.getSamplerForReader(
    matInfo.metallicRoughnessTextureReader || matInfo.specGlossTextureReader,
  );
  const emissiveSampler = pipelineCache.getSamplerForReader(
    matInfo.emissiveTextureReader,
  );
  const occlusionSampler = pipelineCache.getSamplerForReader(
    matInfo.occlusionTextureReader,
  );
  // Cache per-binding views + samplers on the prim cache so the
  // texture bind group can be rebuilt cheaply when the SceneRenderer's
  // refraction capture (Batch 107) publishes a new
  // `_refractionSceneView`. Without this cache the rebuild would have
  // to re-create the views every frame from `textures.*`.
  primCache.textureViews = {
    baseColor: textures.baseColor.createView(),
    normal: textures.normal.createView(),
    metallicRoughness: textures.metallicRoughness.createView(),
    emissive: textures.emissive.createView(),
    occlusion: textures.occlusion.createView(),
    clearcoat: textures.clearcoat.createView(),
    specularColor: textures.specularColor.createView(),
    anisotropy: textures.anisotropy.createView(),
    iridescence: textures.iridescence.createView(),
    sheenColor: textures.sheenColor.createView(),
    thickness: textures.thickness.createView(),
    clearcoatRoughness: textures.clearcoatRoughness.createView(),
    clearcoatNormal: textures.clearcoatNormal.createView(),
    sheenRoughness: textures.sheenRoughness.createView(),
    specularFactor: textures.specularFactor.createView(),
    iridescenceThickness: textures.iridescenceThickness.createView(),
    transmission: textures.transmission.createView(),
    refractionPlaceholder: textures.refractionScene.createView(),
  };
  primCache.textureSamplers = {
    base: baseSampler || defSampler,
    normal: normalSampler || defSampler,
    mr: mrSampler || defSampler,
    emissive: emissiveSampler || defSampler,
    occlusion: occlusionSampler || defSampler,
    def: defSampler,
  };
  // NEW-BG-CONSOLIDATION (Batch 122) — track texture entries on the
  // primCache. The full merged group 1 bind group is built per-frame
  // at the draw command emission site; this is just the cached
  // texture portion.
  // Batch 174 — entries are now filtered by `primCache.materialDefines`:
  // basic variant emits bindings 2-11 only; full variant emits 2-25.
  // The matching per-variant `materialBGL` is selected at bind-group
  // construction time via `pipelineCache.getOrCreateMaterialBGL(materialDefines)`.
  primCache.textureEntries = getModelTextureEntries(
    primCache,
    null,
    materialDefines,
  );
  primCache.refractionViewBound = null;

  cache.primitives[primKey] = primCache;
  return primCache;
}

/**
 * NEW-BG-CONSOLIDATION (Batch 122) — returns the texture portion of the
 * merged group 1 bind group as an `entries[]` array. Bindings 0-1
 * (material+light UBOs) and 26-32 (featureId) are spliced in at the
 * renderer's per-frame draw-command emission site.
 *
 * Was the standalone "texture bind group" prior to NEW-BG-CONSOLIDATION;
 * binding numbers are shifted by +2 because slots 0-1 are now occupied
 * by the merged material/light UBOs.
 *
 * Batch 174 — KHR materialBGL split. The texture entries for bindings
 * 12-25 are gated on the variant's `materialDefines` mask: basic
 * variant (`materialDefines = 0`) emits PBR bindings 2-11 only; full
 * variant (`MODEL_HAS_KHR_TEXTURES` set) emits 2-25. The returned
 * array MUST match the layout of the per-variant `materialBGL`
 * fetched via `pipelineCache.getOrCreateMaterialBGL(materialDefines)`,
 * or `device.createBindGroup` will reject the entry list.
 *
 * @private
 * @param {object} primCache
 * @param {GPUTextureView | null} refractionView - Optional refraction
 *   capture view from the SceneRenderer; bound at slot 25 when the
 *   variant includes it, else falls back to the cached placeholder.
 * @param {number} materialDefines - Variant mask (bitmask of
 *   ShaderDefine bits). When `MODEL_HAS_KHR_TEXTURES` is set, the
 *   KHR slots (12-25) are emitted; when clear they're omitted.
 */
function getModelTextureEntries(primCache, refractionView, materialDefines) {
  const v = primCache.textureViews;
  const s = primCache.textureSamplers;
  const entries = [
    // 2-11: PBR (always, both basic and full variants)
    { binding: 2, resource: v.baseColor },
    { binding: 3, resource: s.base },
    { binding: 4, resource: v.normal },
    { binding: 5, resource: s.normal },
    { binding: 6, resource: v.metallicRoughness },
    { binding: 7, resource: s.mr },
    { binding: 8, resource: v.emissive },
    { binding: 9, resource: s.emissive },
    { binding: 10, resource: v.occlusion },
    { binding: 11, resource: s.occlusion },
  ];

  // 12-25: KHR — gated on materialDefines. Emitted only when the
  // matching gate define is set. Today every KHR slot shares a single
  // gate (`MODEL_HAS_KHR_TEXTURES`); when the WGSL ifdefs are split
  // per-extension this branching mirrors the manifest in the pipeline
  // cache so each KHR group's slots only emit when its specific gate
  // bit is in the variant.
  if ((materialDefines & ShaderDefine.MODEL_HAS_KHR_TEXTURES) !== 0) {
    entries.push(
      { binding: 12, resource: v.clearcoat },
      { binding: 13, resource: v.specularColor },
      { binding: 14, resource: v.anisotropy },
      { binding: 15, resource: v.iridescence },
      { binding: 16, resource: v.sheenColor },
      { binding: 17, resource: v.thickness },
      { binding: 18, resource: v.clearcoatRoughness },
      { binding: 19, resource: v.clearcoatNormal },
      { binding: 20, resource: v.sheenRoughness },
      { binding: 21, resource: v.specularFactor },
      { binding: 22, resource: v.iridescenceThickness },
      { binding: 23, resource: s.def },
      { binding: 24, resource: v.transmission },
      // Binding 25: refractionSceneTexture. When the SceneRenderer's
      // capture pass has published a view, use it. Otherwise fall back
      // to the cached white placeholder (the FS gates this sample on
      // FLAG_HAS_TRANSMISSION).
      {
        binding: 25,
        resource: refractionView ?? v.refractionPlaceholder,
      },
    );
  }

  return entries;
}

/**
 * NEW-BG-CONSOLIDATION (Batch 122) — builds the merged group 1 bind
 * group. Per-frame allocation; cheap because the entry objects are
 * small and the underlying GPU resources are reused.
 *
 * Batch 174 (B.4 KHR materialBGL split) — the layout is now per-variant.
 * Caller passes the primitive's `materialDefines` mask; this function
 * fetches (or builds, on first use) the matching `GPUBindGroupLayout`
 * via `pipelineCache.getOrCreateMaterialBGL(materialDefines)`. The
 * `textureEntries` array MUST already be filtered to match the layout
 * — `getModelTextureEntries` honors the same mask.
 *
 * @private
 */
function buildMergedMaterialBindGroup(
  device,
  pipelineCache,
  materialBuffer,
  lightBuffer,
  textureEntries,
  featureIdEntries,
  iblEntries,
  materialDefines,
  frameState,
) {
  return device.createBindGroup({
    layout: pipelineCache.getOrCreateMaterialBGL(materialDefines | 0),
    entries: [
      { binding: 0, resource: { buffer: materialBuffer.buffer } },
      { binding: 1, resource: { buffer: lightBuffer.buffer } },
      ...textureEntries,
      ...(featureIdEntries ?? pipelineCache.defaultFeatureIdEntries()),
      ...(iblEntries ?? defaultIBLEntries(pipelineCache, frameState)),
    ],
  });
}

/**
 * Audit A.9 (Batch 130) -- placeholder IBL bind-group entries (33-36).
 * Used when a model has no `imageBasedLighting` configured or its
 * source environment cubemap hasn't generated yet. The defaults
 * produce mid-grey ambient sampling so the FS doesn't have to gate
 * the cubemap sample on an explicit "iblEnabled" flag.
 * @private
 */
function defaultIBLEntries(pipelineCache, frameState) {
  return [
    { binding: 33, resource: pipelineCache.defaultIBLCubemapView },
    { binding: 34, resource: pipelineCache.defaultIBLCubemapView },
    { binding: 35, resource: pipelineCache.defaultIBLSampler },
    { binding: 36, resource: { buffer: pipelineCache.defaultSHBuffer } },
    ...brdfLutEntries(pipelineCache, frameState),
  ];
}

/**
 * NEW-MODEL-IBL-BRDF-LUT (Batch 287) — bindings 37/38 (split-sum
 * environment BRDF integration LUT + non-filtering sampler). The LUT is
 * device-global (generated once by `BrdfLutGenerator`); the WebGPU
 * generator stores its view + sampler on `_colorTexture` (see
 * WebGPUBrdfLutGenerator.update). Falls back to the pipeline cache's 1×1
 * (scale=1, bias=0) placeholder until the real table is generated, which
 * collapses the split-sum term to `radiance * F0`.
 * @private
 */
function brdfLutEntries(pipelineCache, frameState) {
  const lutTex = frameState?.brdfLutGenerator?._colorTexture;
  const lutView = lutTex?._webgpuTextureView;
  return [
    {
      binding: 37,
      resource: defined(lutView) ? lutView : pipelineCache.defaultBrdfLutView,
    },
    { binding: 38, resource: pipelineCache.defaultBrdfLutSampler },
  ];
}

/**
 * Audit A.9 (Batch 130) -- builds the per-model IBL bind-group entries
 * from the model's `imageBasedLighting` cache, or returns null when
 * the cache hasn't run yet (caller falls back to defaults).
 * `WebGPUImageBasedLighting.update` populates `_webgpuSpecularView`,
 * `_webgpuDiffuseView`, `_webgpuSampler`, `_webgpuSHBuffer` on the
 * model's IBL instance once the radiance + irradiance prefilter has
 * generated mips.
 * @private
 */
function buildModelIBLEntries(model, pipelineCache, frameState) {
  const ibl = model?._imageBasedLighting;
  let specularView = ibl?._webgpuSpecularView;
  let diffuseView = ibl?._webgpuDiffuseView;
  let sampler = ibl?._webgpuSampler;
  const shBuffer = ibl?._webgpuSHBuffer;

  // Audit A.12 (Batch 131) -- when the explicit IBL hasn't generated
  // (no `specularEnvironmentMaps` configured), fall back to the
  // model's `environmentMapManager` procedural-sky cubemap. The
  // manager runs a procedural sky compute pass + the same
  // `generateIBLMaps` prefilter as explicit IBL, so the fallback views
  // are first-class -- not a placeholder.
  const envManager = model?.environmentMapManager;
  if (defined(envManager)) {
    if (!defined(diffuseView) && defined(envManager._webgpuIBLDiffuseView)) {
      diffuseView = envManager._webgpuIBLDiffuseView;
    }
    if (!defined(specularView) && defined(envManager._webgpuIBLSpecularView)) {
      specularView = envManager._webgpuIBLSpecularView;
    }
    if (!defined(sampler) && defined(envManager._webgpuIBLSampler)) {
      sampler = envManager._webgpuIBLSampler;
    }
  }

  if (!defined(specularView) || !defined(diffuseView) || !defined(sampler)) {
    return null;
  }
  // SH falls back to the cache's default (zeros + inactive flag) when
  // neither the explicit IBL nor the env manager publishes one. The
  // shader gates on `sh.control.w` so the default just makes the
  // diffuse path use the irradiance cubemap (which is what we want
  // when the env manager is the source).
  const shResource = defined(shBuffer)
    ? { buffer: shBuffer }
    : { buffer: pipelineCache.defaultSHBuffer };
  return [
    { binding: 33, resource: diffuseView },
    { binding: 34, resource: specularView },
    { binding: 35, resource: sampler },
    { binding: 36, resource: shResource },
    ...brdfLutEntries(pipelineCache, frameState),
  ];
}

/**
 * NEW-BG-CONSOLIDATION (Batch 122) — builds the merged group 2 bind
 * group (4 entries: joint matrices + morph deltas + morph weights +
 * instance transforms). Falls through to default placeholder buffers
 * when a primitive has no skinning / no morph targets / no instancing
 * — the shader gates on FLAG_HAS_SKINNING / FLAG_HAS_MORPH_TARGETS /
 * FLAG_HAS_INSTANCING so placeholder contents are never sampled.
 *
 * @private
 */
function buildMergedInstanceBindGroup(
  device,
  pipelineCache,
  jointBuffer,
  morphDeltaBuffer,
  morphWeightBuffer,
  instanceBuffer,
  prevJointBuffer,
  prevMorphWeightBuffer,
  prevInstanceBuffer,
) {
  return device.createBindGroup({
    layout: pipelineCache.instanceBGL,
    entries: [
      {
        binding: 0,
        resource: { buffer: jointBuffer ?? pipelineCache.defaultJointBuffer },
      },
      {
        binding: 1,
        resource: {
          buffer: morphDeltaBuffer ?? pipelineCache.defaultMorphDeltaBuffer,
        },
      },
      {
        binding: 2,
        resource: {
          buffer: morphWeightBuffer ?? pipelineCache.defaultMorphWeightBuffer,
        },
      },
      {
        binding: 3,
        resource: {
          buffer: instanceBuffer ?? pipelineCache.defaultInstancingBuffer,
        },
      },
      {
        // Audit A.5 (Batch 130) -- previous-frame joint matrices for
        // TAA velocity. Falls back to the identity buffer (same as
        // binding 0's default) so non-skinned primitives produce no
        // skinning velocity contribution. Skinned primitives that
        // haven't yet captured a previous frame fall back to the
        // CURRENT joint buffer so velocity is zero on the first frame
        // of an animation rather than wildly wrong from the identity.
        binding: 4,
        resource: {
          buffer:
            prevJointBuffer ?? jointBuffer ?? pipelineCache.defaultJointBuffer,
        },
      },
      {
        // NEW-TAA-MORPH-PREV (Batch 134) -- previous-frame morph
        // weights uniform. Falls back to the CURRENT weights when no
        // prev mirror exists yet (first morphed frame); zero-weights
        // default when no morph at all.
        binding: 5,
        resource: {
          buffer:
            prevMorphWeightBuffer ??
            morphWeightBuffer ??
            pipelineCache.defaultMorphWeightBuffer,
        },
      },
      {
        // NEW-TAA-INSTANCE-PREV (Batch 134) -- previous-frame instance
        // transforms. Static GPU instancing (today's only case) aliases
        // the current buffer for zero velocity contribution. Animated
        // EXT_mesh_gpu_instancing assets would override.
        binding: 6,
        resource: {
          buffer:
            prevInstanceBuffer ??
            instanceBuffer ??
            pipelineCache.defaultInstancingBuffer,
        },
      },
    ],
  });
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
  // Session 65 BUG-WEBGPU-MODEL-TEXTURE-PLACEHOLDER-STUCK fix.
  // Track which slots fell back to the default placeholder texture
  // because the matching reader hadn't resolved its image source yet.
  // The per-frame `refreshDeferredTextures` helper polls these slots
  // and swaps in the real GPUTexture as soon as the reader is ready.
  // Without this, models whose textures load AFTER the first
  // `ensurePrimitiveCache` call (Mars, Moon, Aerometrex SF
  // photogrammetry, BIM base color) render with white-fallback
  // bind groups for their entire lifetime.
  const placeholderSlots = new Set();

  function tryCreate(slot, reader, fallback, colorSpace) {
    if (!defined(reader)) {
      return fallback;
    }
    const tex = createGPUTextureFromReader(device, reader, colorSpace);
    if (defined(tex)) {
      // Only push to `created` (which the primCache destroys later) if
      // this WebGPU texture was allocated *here* via copyExternalImageToTexture.
      // When the CesiumJS Texture is backed by a WebGLStubTexture, the GPU
      // texture is owned by that stub and reused by reference; pushing it to
      // `created` would cause a double-destroy. The stub-owned check uses
      // the same path createGPUTextureFromReader took for ownership detection.
      const stubWrapper = reader.texture && reader.texture._texture;
      const reusedFromStub =
        stubWrapper &&
        stubWrapper._webgpuTexture &&
        stubWrapper._webgpuTexture.texture === tex;
      if (!reusedFromStub) {
        created.push(tex);
      }
      return tex;
    }
    placeholderSlots.add(slot);
    return fallback;
  }

  // Slot color-space classification (per glTF spec):
  //   srgb: baseColor (and specGloss diffuse), emissive.
  //   linear: normal, metallic-roughness (and specGloss specular), occlusion.
  // Storing sRGB slots as `rgba8unorm-srgb` makes the GPU sampler auto-decode
  // gamma, which is both perceptually correct for linear filtering AND
  // removes the need for in-shader pow(2.2) approximation.
  //
  // C-R4-GLTF-KHR-TEXTURES (Batch 102) — KHR extension texture
  // color-space defaults per the relevant Khronos extension specs:
  //   srgb: specularColor (chromatic F0 tint), sheenColor.
  //   linear: clearcoat (intensity scalar), anisotropy (RG = direction
  //           encoded as f32 trig), iridescence (R = factor scalar),
  //           thickness (G = volume thickness scalar).
  return {
    baseColor: tryCreate(
      "baseColor",
      matInfo.baseColorTextureReader || matInfo.diffuseTextureReader,
      defWhite,
      "srgb",
    ),
    normal: tryCreate(
      "normal",
      matInfo.normalTextureReader,
      defNormal,
      "linear",
    ),
    metallicRoughness: tryCreate(
      "metallicRoughness",
      matInfo.metallicRoughnessTextureReader || matInfo.specGlossTextureReader,
      defWhite,
      "linear",
    ),
    emissive: tryCreate(
      "emissive",
      matInfo.emissiveTextureReader,
      defBlack,
      "srgb",
    ),
    occlusion: tryCreate(
      "occlusion",
      matInfo.occlusionTextureReader,
      defWhite,
      "linear",
    ),
    clearcoat: tryCreate(
      "clearcoat",
      matInfo.clearcoatTextureReader,
      defWhite,
      "linear",
    ),
    specularColor: tryCreate(
      "specularColor",
      matInfo.specularExtColorTextureReader,
      defWhite,
      "srgb",
    ),
    anisotropy: tryCreate(
      "anisotropy",
      matInfo.anisotropyTextureReader,
      defWhite,
      "linear",
    ),
    iridescence: tryCreate(
      "iridescence",
      matInfo.iridescenceTextureReader,
      defWhite,
      "linear",
    ),
    sheenColor: tryCreate(
      "sheenColor",
      matInfo.sheenColorTextureReader,
      defWhite,
      "srgb",
    ),
    thickness: tryCreate(
      "thickness",
      matInfo.thicknessTextureReader,
      defWhite,
      "linear",
    ),
    // C-R4-GLTF-KHR-TEXTURES (Batch 103) — KHR secondary maps. Each
    // is linear-encoded scalar/normal data per the relevant Khronos
    // extension specs (clearcoat normal uses the standard normal-map
    // default placeholder so the FS perturbNormal call passes through
    // identity when the asset omits the texture).
    clearcoatRoughness: tryCreate(
      "clearcoatRoughness",
      matInfo.clearcoatRoughnessTextureReader,
      defWhite,
      "linear",
    ),
    clearcoatNormal: tryCreate(
      "clearcoatNormal",
      matInfo.clearcoatNormalTextureReader,
      defNormal,
      "linear",
    ),
    sheenRoughness: tryCreate(
      "sheenRoughness",
      matInfo.sheenRoughnessTextureReader,
      defWhite,
      "linear",
    ),
    specularFactor: tryCreate(
      "specularFactor",
      matInfo.specularExtTextureReader,
      defWhite,
      "linear",
    ),
    iridescenceThickness: tryCreate(
      "iridescenceThickness",
      matInfo.iridescenceThicknessTextureReader,
      defWhite,
      "linear",
    ),
    // C-R4-GLTF-KHR-TRANSMISSION (Batch 105) — transmission texture
    // (R = factor scalar) + refraction scene-color sample source. The
    // refractionScene fallback is the white placeholder; the actual
    // refraction MRT populated by the SceneRenderer is bound through
    // a separate per-frame rebuild in update(). Here we just stamp the
    // placeholder so the bind group is always valid.
    transmission: tryCreate(
      "transmission",
      matInfo.transmissionTextureReader,
      defWhite,
      "linear",
    ),
    refractionScene: defWhite,
    created,
    placeholderSlots,
  };
}

// Mapping of slot name → which matInfo reader field + colorSpace.
// Used by `refreshDeferredModelTextures` to refresh slots that were
// initially fallback-textured because the reader hadn't loaded yet.
// Mirrors the schema in createMaterialTextures so the two stay in sync.
const TEXTURE_SLOT_SCHEMA = [
  {
    slot: "baseColor",
    readers: ["baseColorTextureReader", "diffuseTextureReader"],
    colorSpace: "srgb",
  },
  { slot: "normal", readers: ["normalTextureReader"], colorSpace: "linear" },
  {
    slot: "metallicRoughness",
    readers: ["metallicRoughnessTextureReader", "specGlossTextureReader"],
    colorSpace: "linear",
  },
  { slot: "emissive", readers: ["emissiveTextureReader"], colorSpace: "srgb" },
  {
    slot: "occlusion",
    readers: ["occlusionTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "clearcoat",
    readers: ["clearcoatTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "specularColor",
    readers: ["specularExtColorTextureReader"],
    colorSpace: "srgb",
  },
  {
    slot: "anisotropy",
    readers: ["anisotropyTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "iridescence",
    readers: ["iridescenceTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "sheenColor",
    readers: ["sheenColorTextureReader"],
    colorSpace: "srgb",
  },
  {
    slot: "thickness",
    readers: ["thicknessTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "clearcoatRoughness",
    readers: ["clearcoatRoughnessTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "clearcoatNormal",
    readers: ["clearcoatNormalTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "sheenRoughness",
    readers: ["sheenRoughnessTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "specularFactor",
    readers: ["specularExtTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "iridescenceThickness",
    readers: ["iridescenceThicknessTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "transmission",
    readers: ["transmissionTextureReader"],
    colorSpace: "linear",
  },
];

/**
 * Per-frame poll: for each slot that was filled with a fallback
 * placeholder when this primitive was first set up, check if the
 * matching glTF texture reader has now resolved its image source.
 * If so, upload the real GPU texture and update primCache.textureViews
 * + gpuTextures so the next bind group rebuild picks it up.
 *
 * Returns true if any slot was upgraded, signaling the caller to
 * rebuild `primCache.textureEntries` so the bind group references
 * the new view instead of the white placeholder.
 *
 * Session 65 fix for the "Mars/Moon render solid white" cluster:
 * before this, the bind group was built once with whatever textures
 * had loaded by the first frame, and never refreshed.
 *
 * @private
 */
function refreshDeferredModelTextures(device, primCache, matInfo) {
  const placeholders = primCache.placeholderSlots;
  if (!placeholders || placeholders.size === 0) {
    return false;
  }
  let changed = false;
  for (const schema of TEXTURE_SLOT_SCHEMA) {
    if (!placeholders.has(schema.slot)) {
      continue;
    }
    let reader = null;
    for (const r of schema.readers) {
      if (defined(matInfo[r])) {
        reader = matInfo[r];
        break;
      }
    }
    if (!defined(reader)) {
      continue;
    }
    const tex = createGPUTextureFromReader(device, reader, schema.colorSpace);
    if (!defined(tex)) {
      continue;
    }
    // Only track in gpuTextures if we own the lifetime — see tryCreate
    // for the same stub-ownership check. Stub-owned GPUTextures are
    // shared with the CesiumJS Texture wrapper and would double-destroy.
    const stubWrapper = reader.texture && reader.texture._texture;
    const reusedFromStub =
      stubWrapper &&
      stubWrapper._webgpuTexture &&
      stubWrapper._webgpuTexture.texture === tex;
    if (!reusedFromStub) {
      primCache.gpuTextures.push(tex);
    }
    primCache.textureViews[schema.slot] = tex.createView();
    placeholders.delete(schema.slot);
    changed = true;
  }
  return changed;
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

  // AUDIT_2026_05_02 A.7 — surface silent feature gaps that the WebGPU
  // model path doesn't yet honor. Each warning fires once per process to
  // alert users instead of letting the feature appear "working" when it
  // silently no-ops.
  //>>includeStart('debug', pragmas.debug);
  if (defined(model.customShader)) {
    oneTimeWarning(
      "WebGPUModel.customShader",
      "Model.customShader is not yet supported on the WebGPU backend. " +
        "User-supplied GLSL is silently ignored on WebGPU; the model will " +
        "render with the standard PBR pipeline. Track AUDIT_2026_05_02 A.7.",
    );
  }
  // AUDIT_2026_05_02 A.8 (Batch 142, NEW-MODEL-AS-CLASSIFIER — resolved):
  // model.classificationType now routes through
  // `pipelineCache.getClassificationPipeline` and emits at the matching
  // TERRAIN/3D-Tile classification pass. The depth-sample classifier
  // FS samples the same `globeDepthTex` (group 3 binding 15) the four
  // classifier renderers use, so model classifiers participate in the
  // shared depth-sample architecture without per-renderer plumbing.
  //>>includeEnd('debug');

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
    const fmt = context.scenePipelineFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    cache.pipelineCache = new WebGPUModelPipelineCache(device, fmt, depthFmt);
  }
  const pipelineCache = cache.pipelineCache;
  // Batch 110 — drop per-primitive pipeline refs when the scene
  // pipeline format generation bumps (HDR toggle, MSAA toggle). The
  // pipelineCache wipes its own cache via maybeUpdateForSceneFormat;
  // the per-primitive cache holds direct references that still point
  // at the OLD pipeline objects, so we re-fetch them from the now-
  // empty pipelineCache below per primitive (in the per-frame loop
  // each primitive sees `pc.pipeline = pipelineCache.getPipeline(...)`
  // re-fired). Lazy-allocated variants (pick/velocity/translucent/
  // depth-write) drop to undefined and are re-fetched on next use.
  const previousGen = pipelineCache._sceneFormatGeneration;
  pipelineCache.maybeUpdateForSceneFormat(context);
  // Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH) — mirror the master
  // switch into the pipeline cache; a flip wipes pipelines so modules
  // recompile with/without the LOG_DEPTH define.
  const logDepthFlipped = pipelineCache.maybeUpdateForLogDepth(
    isWebGPULogDepthActive(context, frameState),
  );
  // A log-depth flip needs the SAME per-primitive direct-reference drop as
  // a scene-format change (pc.pipeline & friends point at wiped pipelines).
  const sceneFormatChanged =
    previousGen !== pipelineCache._sceneFormatGeneration || logDepthFlipped;
  if (sceneFormatChanged) {
    const primKeys = Object.keys(cache.primitives);
    for (let i = 0; i < primKeys.length; i++) {
      const pc = cache.primitives[primKeys[i]];
      if (defined(pc)) {
        pc.pipeline = null;
        pc.pickPipeline = undefined;
        pc.depthWritePipeline = undefined;
        pc.velocityPipeline = undefined;
        pc.translucentPipeline = undefined;
        // Tag for the per-frame loop so it re-fetches pc.pipeline
        // before the command emission below (the initial pipeline
        // assignment lives inside ensurePrimitiveCache which only
        // runs once per primitive lifecycle).
        pc._pipelineNeedsRefetch = true;
      }
    }
  }

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

  // Use the scene graph's _computedModelMatrix which folds in:
  //   model.modelMatrix * components.transform * _axisCorrectionMatrix
  //     * scale(model.computedScale)
  // Falling back to model.modelMatrix omits glTF root transform, axis
  // correction (Z-up → Y-up), and the user-supplied scale — which made
  // models render at the wrong scale (typically 1× instead of computedScale,
  // e.g. CesiumAir.glb collapsing to a few pixels at scale=4) and with the
  // wrong axis orientation. The same field is what the upstream WebGL
  // ModelDrawCommand uses (see ModelSceneGraph.js:823).
  const modelMatrix =
    model._sceneGraph?._computedModelMatrix ||
    model.modelMatrix ||
    Matrix4.IDENTITY;
  packCameraUniforms(cache.cameraData, frameState, modelMatrix);
  device.queue.writeBuffer(
    cache.cameraBuffer.buffer,
    0,
    cache.cameraData.buffer,
    0,
    CAMERA_UNIFORM_SIZE,
  );

  // ── Effects bind group (shadow receive + clipping + CSM) ──
  //
  // CSM Slice 2c — the model pipeline layout now includes the effects
  // BGL at @group(7). Rebuild the bind group each frame so the effects
  // UBO (shadow darkness, csmControl flag, clipping plane count,
  // atmosphere LUT control, etc.) reflects the current scene state.
  // Mirrors the pattern in WebGPUGlobeSurfaceRenderer ~line 1554.
  //
  // Scope note: called per-model per-frame. The UB write is 272 bytes
  // and the bind group is a thin metadata wrapper, so the cost is
  // linear in model count × 1 small write. If this becomes a hotspot
  // with many models, cache a scene-wide effects bind group on the
  // frame context and share across all models in the scene.
  const shadowState = frameState.shadowState;
  const receiveShadowMap =
    shadowState?.lightShadowsEnabled && shadowState?.lightShadowMaps?.[0]
      ? shadowState.lightShadowMaps[0]
      : undefined;
  const csmCandidate = frameState.context?.csmRenderer;
  const csmBinding =
    defined(csmCandidate) &&
    csmCandidate.enabled === true &&
    defined(csmCandidate.cascadeParamsBuffer) &&
    defined(csmCandidate.cascadeArrayView)
      ? {
          enabled: true,
          paramsBuffer: csmCandidate.cascadeParamsBuffer,
          cascadeArrayView: csmCandidate.cascadeArrayView,
          // NEW-CSM-SOFT-SHADOW-PCF — soft-shadow kernel radius (texels).
          pcfRadius: csmCandidate.pcfRadius,
        }
      : undefined;
  // C-R8-EDGE-INLINE — gather edge-detection inputs for the inline
  // stage in `ModelPBRComplete.wgsl`. The scene renderer publishes
  // resolved edge MRT views (CESIUM_3D_TILE_EDGES pass) AND the globe
  // packed-depth view (`executeCopyDepth`) on the context each frame.
  // Both need to be populated for the gate to flip — when either is
  // missing we fall through to the placeholder bind group and the
  // shader's `edgeControl.x <= 0.5` early-out keeps the stage benign.
  const ctx = frameState.context;
  const edgeColorView = ctx?._edgeColorView ?? null;
  const edgeIdView = ctx?._edgeIdView ?? null;
  const edgeDepthView = ctx?._edgeDepthView ?? null;
  const globeDepthView = ctx?._globeDepthView ?? null;
  const uniformState = ctx?.uniformState;
  const currentFrustum = uniformState?.currentFrustum;
  // Viewport — source from context.drawingBufferWidth/Height directly.
  // `uniformState.viewportCartesian4` is zero-initialized at FR-update
  // time (FR runs during Scene primitive update, before per-frame
  // viewport is established). The bug-pattern hunt 2026-04-30 found
  // four other classification renderers reading zero viewports through
  // the same path; here Model uses it for edge-overlay readiness gating
  // — `!!viewportPx` reads truthy on a zero-init Cartesian4 (the object
  // exists), so edges shipped with zw=0 ⇒ NaN screenUV ⇒ broken edge
  // overlay. Match the canvas dimensions instead.
  const dbw = ctx?.drawingBufferWidth || 1;
  const dbh = ctx?.drawingBufferHeight || 1;
  const edgesReady =
    !!edgeColorView && !!edgeDepthView && !!globeDepthView && !!currentFrustum;
  // C-R8-EDGE-FEATURE-ID — the inline stage gates on the same flag the
  // emitter side toggles when feature IDs are populated. The flag
  // is set sticky-true in the per-primitive edge extraction below
  // when at least one primitive in this model emitted a non-zero
  // feature ID, so per-feature gating activates as soon as a model
  // with batch-table-tagged geometry reaches this code path. Models
  // without feature IDs leave the flag false and the inline stage
  // falls back to "always draw on match" (WebGL fail-open).
  const edgesPayload = edgesReady
    ? {
        ready: true,
        edgeColorView,
        edgeIdView,
        edgeDepthView,
        globeDepthView,
        near: currentFrustum.x,
        far: currentFrustum.y,
        viewportWidth: dbw,
        viewportHeight: dbh,
        hasFeatureId: cache.hasEdgeFeatureIds === true,
      }
    : undefined;

  // AUDIT_2026_05_02 A.6 — wire model.clippingPlanes / model.clippingPolygons
  // through to the effects bind group. The previous comment claimed
  // "Models don't carry their own clipping-plane set" but
  // `Model.js:369-388` shows both APIs are supported. Without this
  // wiring, `model.clippingPlanes = …` produced no visual change
  // (the scene-wide clipping never applied to models) and
  // `model.clippingPolygons = …` was a complete no-op. The model's
  // collections also need their per-frame `update(frameState)` to
  // run so `_webgpuCache` is populated; that already happens inside
  // `Model.update()` (lines 2774-2775 / 917-924).
  const modelClippingPlanes = model._clippingPlanes;
  const modelClippingPolygons = model._clippingPolygons;
  const fxRes = createEffectsBindGroup(device, frameState, {
    shadowMap: receiveShadowMap,
    csm: csmBinding,
    clippingPlanes:
      modelClippingPlanes !== undefined &&
      modelClippingPlanes.enabled &&
      modelClippingPlanes.length !== 0
        ? modelClippingPlanes
        : undefined,
    clippingPolygons:
      modelClippingPolygons !== undefined &&
      modelClippingPolygons.enabled &&
      modelClippingPolygons.length !== 0
        ? modelClippingPolygons
        : undefined,
    cameraInPlaneSpace: frameState.context.uniformState.cameraPosition,
    edges: edgesPayload,
    // Slice 5d Batch 153 — Forward+ clustered lighting. SceneRenderer's
    // _dispatchClusteredLighting hook stashes the dispatcher's per-
    // frame buffers on context._clusteredLightingBuffers each frame.
    // When omitted (e.g., scene without WebGPUSceneRenderer hooked up),
    // the effects bind group falls back to per-device placeholders and
    // the FS chunk early-outs via activeLightCount=0.
    clusteredLighting: frameState.context._clusteredLightingBuffers,
  });
  cache.effectsBG = fxRes.bindGroup;

  // ── Shadow cast UB (shared across all primitives of this model) ──
  //
  // The WebGPUShadowMapRenderer's `modelP12` variant needs the model's
  // world-space transform to project vertices into light-space. Every
  // primitive in this model has the same modelMatrix, so we allocate
  // one UB per model and share it across all the command tags below.
  //
  // The UB is written unconditionally each frame — the shadow cast
  // pass is free to ignore it (if the model has castShadows=false)
  // and the cost of a single 64-byte writeBuffer is negligible.
  const castShadows = model.shadows !== undefined ? model.shadows >= 2 : true;
  if (castShadows) {
    if (!defined(cache.shadowCastUB)) {
      cache.shadowCastUB = WebGPUBuffer.createUniformBuffer(
        device,
        64, // mat4x4<f32>
        "Model shadow cast UB",
      );
      cache.shadowCastData = new Float32Array(16);
    }
    Matrix4.pack(modelMatrix, cache.shadowCastData, 0);
    device.queue.writeBuffer(
      cache.shadowCastUB.buffer,
      0,
      cache.shadowCastData.buffer,
      0,
      64,
    );
  }

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

    // AUDIT_2026_05_02 B.8 (Batch 152, fixed Batch 154) — apply per-
    // runtime-node `computedTransform = transformToRoot × transform` to
    // the model matrix so multi-node hierarchies and AGI_articulations /
    // non-skinned animated rigs render at their correct world position.
    // Mirrors WebGL's `ModelMatrixUpdateStage.updateRuntimeNode` which
    // multiplies `runtimeNode.transform` into the inherited
    // `transformToRoot` BEFORE forwarding to `updateDrawCommand`; the
    // result it forwards is `transformToRoot × transform`, exactly what
    // `runtimeNode.computedTransform` returns (`ModelRuntimeNode.js:252-258`).
    //
    // Original Batch 152 used `runtimeNode.transformToRoot` directly,
    // which excludes the node's own transform — wrong for any rig with a
    // non-identity local transform (the entire point of articulations).
    //
    // Skinning compatibility: `runtimeNode.computedJointMatrices` (Batch 130
    // TAA velocity input) is built with `inverseNodeWorldTransform =
    // inverse(transformToRoot × transform)` baked in
    // (`ModelRuntimeNode.js:283-298`); the cancellation only works when
    // the per-primitive modelMatrix carries the matching
    // `(transformToRoot × transform) = computedTransform`, so this fix is
    // also a correctness fix for skinned rigs whose skin root has any
    // non-identity local OR ancestor transform.
    const computedTransform = runtimeNode.computedTransform;
    const transformIsIdentity =
      !defined(computedTransform) || isIdentityMatrix4(computedTransform);
    const nodeModelMatrix = transformIsIdentity
      ? modelMatrix
      : Matrix4.multiplyTransformation(
          modelMatrix,
          computedTransform,
          scratchNodeModelMatrix,
        );

    // Extract skinning data for this node (shared, renderer-agnostic)
    const skinData = extractSkinData(runtimeNode);
    const hasSkinning = defined(skinData);

    // AUDIT_2026_05_02 B.8 (Batch 152, fixed Batch 154) — allocate the
    // per-node cache slot unconditionally for any node with non-identity
    // computedTransform, so the camera buffer + bind group below can be
    // lazily attached to it even when the node has neither skinning nor
    // instancing. Skinning / instancing branches further down extend the
    // same nodeCache shape.
    if (!transformIsIdentity && !defined(cache.nodes[nodeIdx])) {
      cache.nodes[nodeIdx] = {
        jointBuffer: null,
        jointBufferSize: 0,
        skinningBG: null,
        packedJointMatrices: null,
        prevJointBuffer: null,
        prevPackedJointMatrices: null,
        // Per-node camera resources (Batch 152, NEW-MODEL-NODE-TRANSFORMS).
        cameraBuffer: null,
        cameraData: null,
        cameraBG: null,
        // NEW-MODEL-NODE-TRANSFORMS-PREV (Batch 175) — per-node previous
        // frame's `nodeModelMatrix`. Pre-Batch-175 the velocity pack
        // pulled `cache.prevModelMatrix` (the model-level matrix), which
        // was correct for static articulations (set once, then locked)
        // but produced ghosting under TAA when articulation animations
        // mutate `runtimeNode.transform` per-frame. The per-node slot
        // is captured at the END of each node iteration so the next
        // frame's pack reads this frame's value as `prev`.
        prevNodeModelMatrix: null,
      };
    }

    // Per-node skinning: create/update joint matrices GPU buffer
    if (hasSkinning) {
      if (!defined(cache.nodes[nodeIdx])) {
        cache.nodes[nodeIdx] = {
          jointBuffer: null,
          jointBufferSize: 0,
          skinningBG: null,
          packedJointMatrices: null,
          // Audit A.5 (Batch 130) — prev-frame mirrors for TAA velocity.
          prevJointBuffer: null,
          prevPackedJointMatrices: null,
          // NEW-MODEL-NODE-TRANSFORMS-PREV (Batch 175). See above.
          prevNodeModelMatrix: null,
        };
      }
      const nodeCache = cache.nodes[nodeIdx];

      // First frame: full extraction. Subsequent: incremental update.
      if (!defined(nodeCache.packedJointMatrices)) {
        nodeCache.packedJointMatrices = skinData.packedJointMatrices;
        ensureJointMatricesBuffer(device, pipelineCache, nodeCache, skinData);
      } else {
        // Audit A.5 (Batch 130) — capture the about-to-be-overwritten
        // current matrices as "previous" BEFORE applying this frame's
        // pose. Reuses a persistent Float32Array to avoid per-frame
        // allocation. The first capture (no prevPackedJointMatrices
        // yet) lazily allocates a same-size buffer + GPU storage so
        // the velocity pass has a real `t-1` pose to skin against;
        // the FS would otherwise see prev == current and emit zero
        // velocity for the first animated frame.
        if (!defined(nodeCache.prevPackedJointMatrices)) {
          nodeCache.prevPackedJointMatrices = new Float32Array(
            nodeCache.packedJointMatrices.length,
          );
        }
        nodeCache.prevPackedJointMatrices.set(nodeCache.packedJointMatrices);
        ensurePrevJointMatricesBuffer(device, nodeCache);
        device.queue.writeBuffer(
          nodeCache.prevJointBuffer,
          0,
          nodeCache.prevPackedJointMatrices,
        );
        // Update packed matrices in-place (avoids allocation)
        updatePackedJointMatrices(runtimeNode, nodeCache.packedJointMatrices);
        device.queue.writeBuffer(
          nodeCache.jointBuffer,
          0,
          nodeCache.packedJointMatrices,
        );
      }
    }

    // NEW-BG-CONSOLIDATION (Batch 122) — track raw GPU buffers instead
    // of standalone bind groups. The merged group 2 bind group is built
    // per-frame at the draw command emission site.
    const nodeJointBuffer = hasSkinning
      ? cache.nodes[nodeIdx].jointBuffer
      : null;
    // Audit A.5 (Batch 130) — prev-frame joint matrices for TAA
    // velocity. Falls through to null on the first frame so the BG
    // builder can substitute the current buffer (zero skinning
    // velocity contribution, never identity which would explode).
    const nodePrevJointBuffer = hasSkinning
      ? cache.nodes[nodeIdx].prevJointBuffer
      : null;

    // GPU Instancing: detect from node.instances and create resources
    const nodeForInst = runtimeNode.node || runtimeNode._node;
    const hasInstancing =
      defined(nodeForInst) && defined(nodeForInst.instances);
    let instanceBuffer = null;
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
        instanceBuffer = instRes.storageBuffer;
      }
    }

    // AUDIT_2026_05_02 B.8 (Batch 152) — per-node camera UBO + bind group.
    // The model-level cache.cameraBG was packed at line ~1681 with the
    // model-level modelMatrix; deeper nodes need their own mvpRTE +
    // encodedCameraPositionMC + normalMatrix (all model-matrix-dependent
    // fields in `packCameraUniforms`). Lazy-allocate a dedicated buffer +
    // bind group on the per-node cache and re-pack each frame so
    // articulation animation re-projects the rig correctly.
    let nodeCameraBG = cache.cameraBG;
    if (!transformIsIdentity) {
      const nc = cache.nodes[nodeIdx];
      if (!defined(nc.cameraBuffer)) {
        nc.cameraBuffer = WebGPUBuffer.createUniformBuffer(
          device,
          CAMERA_UNIFORM_SIZE,
          `Model camera node[${nodeIdx}]`,
        );
        nc.cameraData = new Float32Array(CAMERA_UNIFORM_SIZE / 4);
        nc.cameraBG = device.createBindGroup({
          label: `Model camera BG node[${nodeIdx}]`,
          layout: pipelineCache.cameraBGL,
          entries: [
            { binding: 0, resource: { buffer: nc.cameraBuffer.buffer } },
          ],
        });
      }
      packCameraUniforms(nc.cameraData, frameState, nodeModelMatrix);
      device.queue.writeBuffer(
        nc.cameraBuffer.buffer,
        0,
        nc.cameraData.buffer,
        0,
        CAMERA_UNIFORM_SIZE,
      );
      nodeCameraBG = nc.cameraBG;
    }

    // NEW-MODEL-NODE-TRANSFORMS-PREV (Batch 175) — resolve the per-node
    // PREVIOUS-frame nodeModelMatrix for the velocity pack. Pre-Batch-175
    // every primitive's pack pulled `cache.prevModelMatrix` (the model-
    // level matrix), which was correct for static articulations (set
    // once, then locked) but produced ghosting under TAA when articulation
    // animations mutate `runtimeNode.transform` per-frame. Examples that
    // hit this path: satellite solar-panel deploy animations, robot-arm
    // articulations, AGI_articulations rigs whose nodes animate while
    // TAA is on.
    //
    // For identity-transform nodes the per-node `nodeModelMatrix` equals
    // the model-level `modelMatrix`, so `cache.prevModelMatrix` is also
    // the correct prev — fall back to it (no per-node storage cost on
    // the common single-node-or-static-articulation case).
    //
    // For non-identity nodes, read the per-node slot. First frame
    // (`prevNodeModelMatrix === null`) initializes from this frame's
    // `nodeModelMatrix` so velocity is exactly zero — equivalent to
    // "no history yet", matching TAA's first-frame fallback.
    let prevNodeModelMatrixForPack;
    const nodeCacheForPrev = cache.nodes[nodeIdx];
    if (transformIsIdentity || !defined(nodeCacheForPrev)) {
      prevNodeModelMatrixForPack = cache.prevModelMatrix;
    } else {
      if (!defined(nodeCacheForPrev.prevNodeModelMatrix)) {
        nodeCacheForPrev.prevNodeModelMatrix = Matrix4.clone(nodeModelMatrix);
      }
      prevNodeModelMatrixForPack = nodeCacheForPrev.prevNodeModelMatrix;
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
      // NEW-FEATURE-ID-VERTEX-ATTR (Batch 188) — `FeatureIdImplicitRange`
      // primitives have no `_FEATURE_ID_0` accessor, so
      // `extractPrimitiveGeometry` leaves `featureId0Data` null. Synthesize
      // the per-vertex array here (`offset + floor(v / repeat)`) when the
      // model's selected feature ID is implicit; the existing slot-8
      // upload path then carries it like a regular vertex attribute, and
      // the FS lights up the same `FLAG_HAS_FEATURE_ID_ATTRIBUTE` branch.
      // Closes the implicit-range follow-up after Batch 130's audit B.2.
      if (!geometry.hasFeatureId0 && defined(glTFPrimitive)) {
        // Batch 191 (B188-D1 audit fix) — was `rn` (undefined) which
        // would have thrown ReferenceError at runtime when an
        // implicit-range glTF model loaded. The variable in scope is
        // `runtimeNode` from the enclosing for-loop at line ~1916.
        const synthesized = synthesizeImplicitFeatureIdData(
          model,
          runtimeNode,
          glTFPrimitive,
          geometry.vertexCount,
        );
        if (defined(synthesized)) {
          geometry.featureId0Data = synthesized;
          geometry.hasFeatureId0 = true;
        }
      }
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

      // Batch 110 — re-fetch the primary color pipeline when the
      // scene pipeline format generation has bumped since this
      // primitive was first set up. The pipelineCache was already
      // cleared by `maybeUpdateForSceneFormat` above, so the
      // getPipeline call below builds a fresh pipeline against the
      // current `_presentationFormat` (which now mirrors the scene
      // FB color format, e.g., rgba16float in HDR). Lazy variants
      // (pick / velocity / translucent / depth-write) refresh
      // themselves on their next-use sites — they're already
      // undefined-tagged for re-fetch, the existing
      // `if (!defined(primCache.X))` gates handle them.
      if (primCache._pipelineNeedsRefetch || primCache.pipeline === null) {
        // Batch 174 — preserve the materialDefines variant across the
        // format-change refetch.
        const md = primCache.materialDefines | 0;
        primCache.pipeline = pipelineCache.getPipeline(
          matInfo.alphaMode,
          matInfo.isDoubleSided,
          md,
        );
        if (matInfo.alphaMode === AlphaModes.BLEND) {
          primCache.depthWritePipeline = pipelineCache.getDepthWritePipeline(
            matInfo.alphaMode,
            matInfo.isDoubleSided,
            md,
          );
        }
        primCache._pipelineNeedsRefetch = false;
      }

      // Session 65 BUG-WEBGPU-MODEL-TEXTURE-PLACEHOLDER-STUCK fix.
      // Per-frame poll: any slot that fell back to a default
      // placeholder texture during the initial ensurePrimitiveCache
      // call gets re-checked here. As soon as the matching glTF
      // texture reader resolves its image source we upload the real
      // GPU texture and force a textureEntries rebuild below so the
      // bind group picks up the new view.
      // Cheap when nothing's pending (single Set.size check); the
      // upload cost only fires once per slot per primitive.
      const texturesUpgraded = refreshDeferredModelTextures(
        device,
        primCache,
        matInfo,
      );

      // C-R4-GLTF-KHR-TRANSMISSION (Batch 107) — when the primitive
      // declares transmission AND the SceneRenderer has published a
      // refraction view this frame, ensure the texture bind group
      // points at the latest view. Cheap: a reference compare against
      // the last-bound view; rebuild only on first use OR when the
      // scene framebuffer reallocates the refraction texture (resize,
      // HDR toggle). Also publishes the per-frame "scene has
      // transmission" flag so the SceneRenderer's capture pass fires.
      // NEW-BG-CONSOLIDATION (Batch 122) — track texture entries
      // instead of a standalone bind group. Rebuilt only when the
      // refraction view changes (per-frame ref compare).
      if (matInfo.hasTransmission) {
        context._sceneHasTransmission = true;
        const currentRefractionView = context._refractionSceneView ?? null;
        if (primCache.refractionViewBound !== currentRefractionView) {
          primCache.textureEntries = getModelTextureEntries(
            primCache,
            currentRefractionView,
            primCache.materialDefines | 0,
          );
          primCache.refractionViewBound = currentRefractionView;
        }
      }
      // First-frame texture-entries build (no transmission).
      // Also rebuild when refreshDeferredModelTextures upgraded a
      // placeholder slot above — the textureViews map now points at
      // a real GPU texture but textureEntries still references the
      // stale placeholder view. Without this rebuild, the bind group
      // keeps the white fallback even after the real texture loads
      // (root cause of Mars/Moon/Aerometrex/BIM "all-white" cluster).
      if (!defined(primCache.textureEntries) || texturesUpgraded) {
        primCache.textureEntries = getModelTextureEntries(
          primCache,
          primCache.refractionViewBound ?? null,
          primCache.materialDefines | 0,
        );
      }

      // Create per-primitive material + light uniform buffers (once).
      // The merged group 1 bind group is built per-frame at the draw
      // command emission site (combines material UBO + light UBO +
      // texture entries + featureId entries into one BG).
      if (!defined(primCache.materialBuffer)) {
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
      // NEW-BG-CONSOLIDATION (Batch 122) — track morph target buffers
      // instead of a standalone bind group. The merged group 2 bind
      // group at the draw command emission site composes them with
      // skinning + instancing into one bind group.
      let morphDeltaBuffer = null;
      let morphWeightBuffer = null;
      // NEW-TAA-MORPH-PREV (Batch 134) -- prev-frame mirror for TAA
      // velocity. Same swap pattern as `prevPackedJointMatrices`.
      let prevMorphWeightBuffer = null;
      if (primHasMorphTargets) {
        const morphRes = ensureMorphTargetResources(
          device,
          primCache,
          geometry,
          morphWeights,
        );
        if (defined(morphRes)) {
          morphDeltaBuffer = morphRes.storageBuffer;
          morphWeightBuffer = morphRes.weightBuffer;
          prevMorphWeightBuffer = morphRes.weightBufferPrev;
        }
      }

      // C-R9-MODEL-PICK (Batch 54 / refactored Batch 59) — per-glTF-
      // primitive pick ID allocation delegated to {@link ensurePickId} in
      // multi-id mode (`idKey = primKey`). Each glTF primitive of a model
      // gets its own pick color so `scene.pick()` can resolve back to
      // {primitive: model, id: primKey}. Per-feature pick (each
      // EXT_mesh_features feature → one pick target) is the larger
      // workstream tracked as `C-R9-MODEL-FEATURE-PICK`. The cache key
      // `nodeIdx_primIdx` matches `primKey` so pick IDs follow primitive
      // identity stably across re-extractions.
      const passes = frameState.passes;
      const allowAllocate = !!(passes && (passes.pick || passes.render));
      const modelPickId = ensurePickId(model, context, cache, {
        idKey: primKey,
        allowAllocate,
      });
      const pickColor = modelPickId?.color;

      // TAA Slice 2c (Batch 96) — track per-model previousModelMatrix on
      // the model's WebGPU cache (one slot for the whole model — every
      // primitive shares the same matrix per frame). The motion-vector
      // output gates on `frameState.taaEnabled` so static scenes don't
      // pay the per-fragment velocity cost. Capturing the matrix on the
      // model rather than the primitive avoids storing it once per
      // primitive of a multi-mesh asset (ECS behavior — per model).
      if (!defined(cache.prevModelMatrix)) {
        cache.prevModelMatrix = Matrix4.clone(modelMatrix);
      }
      const motionEnabled = frameState?.taaEnabled === true;

      // C-R1-TILE-BATCH (Batch 100) — primary command class. The model
      // emits the OPAQUE-class command first (passClass=0). When the
      // model carries a Cesium3DTileBatchTable AND its alphaMode is
      // OPAQUE/MASK, the renderer emits a SECOND translucent-class
      // command (passClass=1, pass=Pass.TRANSLUCENT) so per-feature
      // styling can flip individual features to translucent without
      // pipeline state changes — see the dual-command emission block
      // below for the second command. Models whose alphaMode is BLEND
      // already land in TRANSLUCENT pass; their primary command is the
      // translucent-class one and no derivation is needed.
      const passClass = matInfo.alphaMode === AlphaModes.BLEND ? 1 : 0;

      // Update material uniforms (includes skinning + morph flags +
      // pick color slot + TAA per-model motion + tile-batch passClass).
      // AUDIT_2026_05_02 B.8 (Batch 152, fixed Batch 154) — passes the
      // per-runtime-node modelMatrix (`modelMatrix * runtimeNode.computedTransform`,
      // where `computedTransform = transformToRoot × transform`) so the
      // FS world-space reconstructions (`material.modelMatrix * input.rteMC`
      // — see ModelPBRComplete.wgsl:1600/2016/2029/2072/2233) compose with
      // the correct parent-chain + local transform for articulated rigs.
      packMaterialUniforms(
        primCache.materialData,
        nodeModelMatrix,
        matInfo,
        primHasSkinning,
        primHasMorphTargets,
        pickColor,
        // NEW-MODEL-NODE-TRANSFORMS-PREV (Batch 175) — per-node prev.
        prevNodeModelMatrixForPack,
        motionEnabled,
        passClass,
      );

      // Feature ID textures + batch texture (for per-feature styling).
      // C-R9-MODEL-FEATURE-PICK (Batch 101) — threads `context` +
      // `cache` (per-model cache) + a `pickPassActive` hint so
      // `ensurePerFeaturePickIds` can allocate per-feature pickIds.
      // NEW-BG-CONSOLIDATION (Batch 122) — `featureIdRes.featureIdEntries`
      // are entries (bindings 26-32) spliced into the merged group 1.
      let featureIdEntries = null;
      const pickPassActive = !!(passes && passes.pick);
      const featureIdRes = ensureFeatureIdResources(
        device,
        primCache,
        model,
        glTFPrimitive,
        runtimeNode,
        pipelineCache,
        context,
        cache,
        pickPassActive,
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
          featureIdEntries = featureIdRes.featureIdEntries;
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
      packLightUniforms(primCache.lightData, frameState, model);
      device.queue.writeBuffer(
        primCache.lightBuffer.buffer,
        0,
        primCache.lightData.buffer,
        0,
        LIGHT_UNIFORM_SIZE,
      );

      // Session 62 NEW-VR-VERTEX-BUFFER-VARIANT (+ Session 65 follow-up)
      // — variant-aware vertex buffer slots. When MODEL_HAS_TEXCOORD_1
      // is unset, the pipeline omits slot 7 (texCoord1); when
      // MODEL_HAS_FEATURE_ID_0 is unset, slot 8 (featureId0) is also
      // omitted. The buffers array must match the pipeline layout count
      // or `setVertexBuffer(N, ...)` errors with "slot larger than
      // maximum" on Edge (which caps maxVertexBuffers at 8).
      //
      // Layout permutations:
      //   - both unset   → 7 slots (positions 0-6)            ← common case
      //   - tex1 only    → 8 slots (positions 0-7, no featureId0)
      //   - feat0 only   → 8 slots (positions 0-6, 8; slot 7 = featureId0)*
      //   - both set     → 9 slots (positions 0-8)
      //
      // (*) When tex1 is unset but feat0 is set we still have to push
      // featureId0 — but at the SAME `shaderLocation = 8` per the
      // `createVertexBufferLayout` contract. WebGPU keys buffer slots
      // by their position in the `buffers` array, not by shader
      // location; the binding order here matches the array index, so
      // pushing featureId0 in 8th place (index 7) into a 7+1=8-slot
      // array is correct: it goes to GPU slot 7, which the layout
      // declares to feed `shaderLocation = 8`.
      const hasTexCoord1 =
        (primCache.materialDefines & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0;
      const hasFeatureId0 =
        (primCache.materialDefines & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0;
      const vertexBuffers = [
        primCache.positionBuffer,
        primCache.normalBuffer || pipelineCache.defaultNormalBuffer,
        primCache.tangentBuffer || pipelineCache.defaultTangentBuffer,
        primCache.uvBuffer || pipelineCache.defaultUVBuffer,
        primCache.colorBuffer || pipelineCache.defaultColorBuffer,
        primCache.jointsBuffer || pipelineCache.defaultJointsBuffer,
        primCache.weightsBuffer || pipelineCache.defaultWeightsBuffer,
      ];
      if (hasTexCoord1) {
        vertexBuffers.push(
          primCache.uv1Buffer ||
            primCache.uvBuffer ||
            pipelineCache.defaultUVBuffer,
        );
      }
      if (hasFeatureId0) {
        vertexBuffers.push(
          primCache.featureIdBuffer || pipelineCache.defaultFeatureIdBuffer,
        );
      }

      // Use model.opaquePass to get the correct pass:
      //   - Pass.CESIUM_3D_TILE for 3D Tiles content (set by Model3DTileContent)
      //   - Pass.OPAQUE for standalone models
      // Alpha blend primitives override to TRANSLUCENT
      // AUDIT_2026_05_02 A.8 (Batch 142, NEW-MODEL-AS-CLASSIFIER) —
      // when `model.classificationType` is set, the model becomes a
      // classification volume: route the command into the appropriate
      // classifier pass and use the depth-sample classifier pipeline
      // instead of the lit PBR pipeline. Mirrors WebGL's
      // `ClassificationModelDrawCommand` pass routing
      // (`Source/Scene/Model/ClassificationModelDrawCommand.js`).
      // AUDIT_2026_05_02 A.3 (Batch 146) — `classificationType: BOTH`
      // now emits TWO commands per primitive (one for TERRAIN, one for
      // 3D Tile) instead of collapsing to a single 3D Tile pass. The
      // non-classifier path still emits a single command. Both paths
      // run through the same `passes` loop below.
      const isClassifier = defined(model.classificationType);
      const drawPasses = [];
      if (isClassifier) {
        const classType = model.classificationType;
        if (classType === 0 /* TERRAIN */ || classType === 2 /* BOTH */) {
          drawPasses.push(Pass.TERRAIN_CLASSIFICATION);
        }
        if (
          classType === 1 /* CESIUM_3D_TILE */ ||
          classType === 2 /* BOTH */
        ) {
          drawPasses.push(Pass.CESIUM_3D_TILE_CLASSIFICATION);
        }
      } else {
        drawPasses.push(
          matInfo.alphaMode === AlphaModes.BLEND
            ? Pass.TRANSLUCENT
            : model.opaquePass,
        );
      }

      // C-R1 (Batch 37) — forward the source JS-side renderState from
      // `runtimePrimitive.drawCommand._command.renderState` so our
      // Batch 30 `applyPerEncoderState` hook fires per-draw
      // stencilRef / blendConstant / viewport / scissor. Model
      // primitives set distinct renderStates for silhouette / shadow /
      // backface / classification variants (`ModelDrawCommand.js` lines
      // 626, 641, 767, 818, 868, 925, 950); forwarding the base-color
      // renderState covers the primary draw. Derived-variant coverage
      // (silhouette / shadow-receive / depth-fail) remains follow-up
      // per the Batch 29 `selectCommandVariant` dispatcher — when
      // populators land they'll pull renderState from their
      // corresponding derived ModelDrawCommand slot.
      const rpDrawCommand = rp.drawCommand;
      const modelRenderState = rpDrawCommand?._command?.renderState;

      // NEW-BG-CONSOLIDATION (Batch 122) — 4 merged bind groups.
      // Batch 174 — `materialDefines` selects the per-variant materialBGL.
      const iblEntries = buildModelIBLEntries(model, pipelineCache, frameState);
      const mergedMaterialBG = buildMergedMaterialBindGroup(
        device,
        pipelineCache,
        primCache.materialBuffer,
        primCache.lightBuffer,
        primCache.textureEntries,
        featureIdEntries,
        iblEntries,
        primCache.materialDefines | 0,
        frameState,
      );
      const mergedInstanceBG = buildMergedInstanceBindGroup(
        device,
        pipelineCache,
        nodeJointBuffer,
        morphDeltaBuffer,
        morphWeightBuffer,
        instanceBuffer,
        nodePrevJointBuffer,
        prevMorphWeightBuffer,
        // NEW-TAA-INSTANCE-PREV (Batch 134) -- static GPU instancing
        // (today's only case) aliases the current buffer for zero
        // velocity contribution. When animated instancing lands the
        // node cache will hold a separate `prevInstancingBuffer`.
        instanceBuffer,
      );

      // AUDIT_2026_05_02 A.8 (Batch 142, NEW-MODEL-AS-CLASSIFIER) —
      // route through the classification pipeline when the model is a
      // classifier. Same vertex stage / bind groups / vertex buffers /
      // index buffer; only the fragment entry differs (samples globe
      // depth, discards on sky, emits `material.baseColorFactor`).
      const activePipeline = isClassifier
        ? pipelineCache.getClassificationPipeline(
            matInfo.alphaMode,
            matInfo.isDoubleSided,
            // Batch 174 — preserve materialDefines variant for the
            // classification pipeline so it pairs with the matching
            // per-variant materialBGL the bind group above was
            // constructed against.
            primCache.materialDefines | 0,
          )
        : primCache.pipeline;

      // AUDIT_2026_05_02 A.3 (Batch 146) — `passes[0]` is the primary
      // pass. The non-classifier path always has length 1, so the
      // existing pick/velocity/dual/translucent/edge code below operates
      // on `webgpuCmd` (the primary command). The classifier path may
      // have length 2 for BOTH; the second command is built from the
      // same args after the primary push and goes straight onto the
      // commandList without pick/velocity attachments (classifier
      // doesn't pick or emit velocity).
      const primaryPass = drawPasses[0];
      const webgpuCmdArgs = {
        pipeline: activePipeline,
        bindGroups: [
          nodeCameraBG, // group 0 — per-runtime-node when computedTransform != I (B.8)
          mergedMaterialBG, // group 1 (material + light + textures + featureId)
          mergedInstanceBG, // group 2 (skinning + morph + instancing)
          cache.effectsBG, // group 3 (was group 7)
        ],
        vertexBuffers: vertexBuffers,
        indexBuffer: primCache.indexBuffer || undefined,
        indexCount: primCache.indexCount || 0,
        indexFormat: primCache.indexFormat || "uint16",
        vertexCount: primCache.vertexCount || 0,
        instanceCount: instanceCount,
        pass: primaryPass,
        owner: model,
        boundingVolume: model.boundingSphere,
        modelMatrix: modelMatrix,
        cull: model._cull ?? true,
        renderState: modelRenderState,
        // C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 79) — depth-write variant
        // pipeline for BLEND primitives. Only consumed when the command's
        // `depthForTranslucentClassification` flag is set (forwarded by
        // `Cesium3DTile.update` for translucent tile content). Undefined
        // for OPAQUE/MASK because they already write depth.
        classificationDepthPipeline: primCache.depthWritePipeline,
      };
      const webgpuCmd = new WebGPUDrawCommand(webgpuCmdArgs);

      // ── Shadow cast tagging ──
      //
      // Three variants cover the model path:
      //
      //   primHasSkinning          → `modelSkinned`
      //       Binding 1 = per-model modelMatrix UB
      //       Binding 2 = joint matrices storage buffer (same buffer
      //       the color pass binds at @group(3))
      //       VBs pulled from slots 0/5/6 of the command's full
      //       7-buffer layout (pos, joints0, weights0).
      //
      //   instanceCount === 1      → `modelP12`
      //       Single-instance non-skinned case. Binding 1 = per-model UB.
      //
      //   instanceCount > 1        → `modelInstancedSB`
      //       GPU-instanced non-skinned case. Binding 1 = per-model UB,
      //       Binding 2 = per-instance transforms storage buffer
      //       (same buffer the color pass binds at @group(5)).
      //
      // Skinning + instancing together is uncommon (animated crowds)
      // and not covered by a variant yet — those commands currently
      // fall through to modelInstancedSB without applying the skin
      // transform. A `modelSkinnedInstanced` variant could be added
      // following the same pattern if needed.
      if (castShadows) {
        const nodeCache = cache.nodes[nodeIdx];
        if (primHasSkinning && nodeCache && nodeCache.jointBuffer) {
          webgpuCmd._shadowCastLayout = "modelSkinned";
          webgpuCmd._shadowCastModelUB = cache.shadowCastUB;
          webgpuCmd._shadowCastJointMatricesSB = nodeCache.jointBuffer;
        } else if (instanceCount === 1) {
          webgpuCmd._shadowCastLayout = "modelP12";
          webgpuCmd._shadowCastModelUB = cache.shadowCastUB;
        } else if (
          instanceCount > 1 &&
          nodeCache &&
          nodeCache.instancingBuffer
        ) {
          webgpuCmd._shadowCastLayout = "modelInstancedSB";
          webgpuCmd._shadowCastModelUB = cache.shadowCastUB;
          webgpuCmd._shadowCastInstancingSB = nodeCache.instancingBuffer;
        }
      }

      // C-R9-MODEL-PICK (Batch 54) — pick command. Same layout, vertex
      // stage, vertex buffers, bind groups, and index buffer as the
      // color command; only the pipeline differs (pick fragment entry,
      // no blend, depth write forced on). Wired onto the color command's
      // `derivedCommands.picking.pickCommand` so the Batch 29 dispatcher
      // (`selectCommandVariant` in `WebGPUSceneRenderer.ts`) routes here
      // during pick passes. Only materialized when a pick ID exists —
      // models in non-pick render passes (frameState.passes.pick=false
      // and passes.render=false) skip pick-id allocation, so `pickColor`
      // can be undefined here for an OFFSCREEN/UPDATE-only frame.
      // AUDIT_2026_05_02 A.8 (Batch 142) — classifiers don't pick. The
      // WebGL `ClassificationModelDrawCommand` doesn't allocate a pick
      // command either; classifier draws into TERRAIN/3D-Tile pass on
      // the scene FB, not the pick FBO.
      if (pickColor && !isClassifier) {
        if (!defined(primCache.pickPipeline)) {
          primCache.pickPipeline = pipelineCache.getPickPipeline(
            matInfo.alphaMode,
            matInfo.isDoubleSided,
            // Batch 174 — pick pipeline must use the same per-variant
            // pipeline layout as the color pipeline so it pairs with
            // the same merged group-1 bind group at draw time.
            primCache.materialDefines | 0,
          );
        }
        // Shared draw args reused across all pick variants (default,
        // hover, precise pass 1, precise pass 2). Only the pipeline
        // differs between them; same vertex buffers, bind groups, and
        // index buffer apply to every variant.
        const sharedPickDrawArgs = {
          bindGroups: [
            nodeCameraBG, // B.8 (Batch 152) — per-runtime-node camera BG
            mergedMaterialBG,
            mergedInstanceBG,
            cache.effectsBG,
          ],
          vertexBuffers: vertexBuffers,
          indexBuffer: primCache.indexBuffer || undefined,
          indexCount: primCache.indexCount || 0,
          indexFormat: primCache.indexFormat || "uint16",
          vertexCount: primCache.vertexCount || 0,
          instanceCount: instanceCount,
          pass: primaryPass,
          owner: model,
          boundingVolume: model.boundingSphere,
          modelMatrix: modelMatrix,
          cull: model._cull ?? true,
          renderState: modelRenderState,
          pickOnly: true,
        };
        const pickCmd = new WebGPUDrawCommand({
          ...sharedPickDrawArgs,
          pipeline: primCache.pickPipeline,
        });
        attachPickToColorCommand(webgpuCmd, pickCmd);

        // C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — Option D / hover
        // pick variant. Lazily build pipeline on first frame the scene
        // requests hover-mode pick. Built unconditionally here for
        // BLEND alphaMode so the cost is paid up-front (1 pipeline
        // alloc); for OPAQUE/MASK the factory delegates to the regular
        // pick pipeline so no extra alloc happens (cache hit).
        //
        // Scene flag `_webgpuPickHoverEnabled` is set to true the first
        // time `Scene.pickHoverAsync` is called on the scene; once
        // enabled it stays on for the scene's lifetime (the WGSL
        // module cache dedupes the dither variant across all model
        // instances on the device, so the marginal cost is the FS
        // entry compile + per-(alphaMode, doubleSided, materialDefines)
        // pipeline alloc).
        const scene = frameState?.scene;
        const wantHover = scene?._webgpuPickHoverEnabled === true;
        if (wantHover) {
          if (!defined(primCache.pickHoverPipeline)) {
            primCache.pickHoverPipeline = pipelineCache.getPickHoverPipeline(
              matInfo.alphaMode,
              matInfo.isDoubleSided,
              primCache.materialDefines | 0,
            );
          }
          const pickHoverCmd = new WebGPUDrawCommand({
            ...sharedPickDrawArgs,
            pipeline: primCache.pickHoverPipeline,
          });
          attachPickVariantsToColorCommand(webgpuCmd, {
            hoverPick: pickHoverCmd,
          });
        }

        // C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — Option C precise
        // pick variant. For OPAQUE/MASK, pass 1 IS the regular pick
        // pipeline (factory delegates) and pass 2 is null — dispatcher
        // handles the null fall-through by skipping pass 2. For BLEND,
        // both passes are real with depth-only pass 1 + depth-EQUAL
        // color pass 2, sharing the pick FBO depth attachment within
        // a single render pass.
        //
        // Scene flag `_webgpuPickPreciseEnabled` set on first
        // `Scene.pickPreciseAsync` call. The 2× translucent
        // rasterization cost is paid only when this flag is true, and
        // only for the precise pick path (regular `pick()` and
        // `pickHover()` keep their own pipelines).
        const wantPrecise = scene?._webgpuPickPreciseEnabled === true;
        if (wantPrecise) {
          if (!defined(primCache.pickPrecisePass1Pipeline)) {
            primCache.pickPrecisePass1Pipeline =
              pipelineCache.getPickPrecisePass1Pipeline(
                matInfo.alphaMode,
                matInfo.isDoubleSided,
                primCache.materialDefines | 0,
              );
          }
          if (
            matInfo.alphaMode === AlphaModes.BLEND &&
            !defined(primCache.pickPrecisePass2Pipeline)
          ) {
            primCache.pickPrecisePass2Pipeline =
              pipelineCache.getPickPrecisePass2Pipeline(
                matInfo.alphaMode,
                matInfo.isDoubleSided,
                primCache.materialDefines | 0,
              );
          }
          // Batch 194 (B192-D1 audit fix) — both precise passes need
          // stencilReference=1 set on the render pass encoder before
          // their draw. Pass 1's `passOp: replace` writes 1 (replacing
          // the cleared 0); pass 2's `compare: equal` matches stencil
          // == 1 (only pass-1-covered pixels). Without this, the
          // stencil mechanism is non-functional: pass 1 writes 0 (the
          // default ref) which is identical to the FBO clear value, so
          // pass 2 fires on every pixel rather than only pass-1
          // winners. `applyPerEncoderState` reads `renderState.
          // stencilTest.reference` and calls `passEncoder.
          // setStencilReference()` when nonzero.
          const preciseRenderState = {
            ...modelRenderState,
            stencilTest: { reference: 1 },
          };
          const precisePass1Cmd = new WebGPUDrawCommand({
            ...sharedPickDrawArgs,
            pipeline: primCache.pickPrecisePass1Pipeline,
            renderState: preciseRenderState,
          });
          const precisePass2Cmd = defined(primCache.pickPrecisePass2Pipeline)
            ? new WebGPUDrawCommand({
                ...sharedPickDrawArgs,
                pipeline: primCache.pickPrecisePass2Pipeline,
                renderState: preciseRenderState,
              })
            : undefined;
          attachPickVariantsToColorCommand(webgpuCmd, {
            precisePass1: precisePass1Cmd,
            precisePass2: precisePass2Cmd,
          });
        }
      }

      // TAA Slice 2e (Batch 106) — velocity command derivation. When
      // TAA is on (frameState.taaEnabled), attach a velocity-only draw
      // command alongside the color command. The SceneRenderer's
      // velocity pass (`_runVelocityPass`) walks the frustum command
      // lists, picks any command carrying a `.velocityCommand` slot,
      // and dispatches it into a single-target rg16float render pass
      // sharing scene depth read-only. Reuses the color command's
      // bind groups, vertex buffers, index buffer, and instance count
      // — the only differences are the pipeline (velocity variant)
      // and the absence of blend / depth-write state. Materialized
      // ONCE per primitive per frame.
      //
      // Translucent (BLEND) primitives skip velocity emission for now —
      // they don't write scene depth in the color pass, so the
      // velocity pass's read-only depth attachment can't establish
      // visibility for them. A future follow-up could route translucent
      // velocity through OIT-style accumulation, but that needs more
      // architectural work (the rg16float resolve target doesn't
      // accumulate cleanly with src-alpha blending).
      if (
        motionEnabled &&
        matInfo.alphaMode !== AlphaModes.BLEND &&
        !isClassifier
      ) {
        if (!defined(primCache.velocityPipeline)) {
          primCache.velocityPipeline = pipelineCache.getVelocityPipeline(
            matInfo.alphaMode,
            matInfo.isDoubleSided,
            // Batch 174 — velocity pipeline must use the same
            // per-variant pipeline layout as the color pipeline so it
            // pairs with the same merged group-1 bind group at draw time.
            primCache.materialDefines | 0,
          );
        }
        const velocityCmd = new WebGPUDrawCommand({
          pipeline: primCache.velocityPipeline,
          bindGroups: [
            nodeCameraBG, // B.8 (Batch 152) — per-runtime-node camera BG
            mergedMaterialBG,
            mergedInstanceBG,
            cache.effectsBG,
          ],
          vertexBuffers: vertexBuffers,
          indexBuffer: primCache.indexBuffer || undefined,
          indexCount: primCache.indexCount || 0,
          indexFormat: primCache.indexFormat || "uint16",
          vertexCount: primCache.vertexCount || 0,
          instanceCount: instanceCount,
          pass: primaryPass,
          owner: model,
          boundingVolume: model.boundingSphere,
          modelMatrix: modelMatrix,
          cull: model._cull ?? true,
          renderState: modelRenderState,
        });
        webgpuCmd.velocityCommand = velocityCmd;
      }

      commandList.push(webgpuCmd);

      // AUDIT_2026_05_02 A.3 (Batch 146) — for `classificationType: BOTH`
      // emit a SECOND command targeting the second pass. Same args as
      // the primary command except the `pass` field. Both commands share
      // the same pipeline / bind groups / vertex buffers — the renderer
      // already computed those for the primary command and they're
      // identical for the second pass (depth-sample classifier doesn't
      // distinguish TERRAIN vs 3D Tile in its pipeline state, only in
      // the pass enum the dispatcher routes through).
      if (isClassifier && drawPasses.length > 1) {
        for (let p = 1; p < drawPasses.length; p++) {
          const extraCmd = new WebGPUDrawCommand({
            ...webgpuCmdArgs,
            pass: drawPasses[p],
          });
          commandList.push(extraCmd);
        }
      }

      // AUDIT_2026_05_02 A.8 (Batch 142, NEW-MODEL-AS-CLASSIFIER) —
      // when the model is a classifier, we've already pushed the
      // classification command(s). The remaining variants (tile-batch
      // dual command, translucent depth-write, edge emitter) don't
      // apply: classifiers don't pick (no pick FBO entry needed —
      // ClassificationModelDrawCommand on WebGL also skips pick),
      // they don't emit velocity (no TAA on classified content),
      // and they don't run the edge stage (the classifier FS is a
      // depth-sample emit, not the lit PBR FS that hosts the edge
      // overlay). Skip the rest of this primitive's emission.
      if (isClassifier) {
        continue;
      }

      // C-R1-TILE-BATCH (Batch 101) — dual-command emission. When the
      // primary command class is opaque (passClass === 0) AND the
      // primitive has a batch table active, also emit a TRANSLUCENT-
      // class derived command so per-feature styling can flip
      // individual features to translucent without pipeline state
      // changes. Mirrors WebGL's `deriveTranslucentCommand` at
      // `Cesium3DTileBatchTable.js:497`. The FS uses
      // `material.tileBatchFlags.x` (passClass) to discard the wrong-
      // class features at each pass — see the WGSL gate added in
      // Batch 100. Uses a SEPARATE material UB so the two commands
      // can hold passClass = 0 / passClass = 1 independently without
      // a per-frame second writeBuffer collision.
      const hasBatchTable =
        defined(featureIdRes) &&
        (featureIdRes.flags & MaterialFlags.HAS_BATCH_TABLE) !== 0;
      if (passClass === 0 && hasBatchTable) {
        if (!defined(primCache.materialBufferTranslucent)) {
          primCache.materialBufferTranslucent =
            WebGPUBuffer.createUniformBuffer(
              device,
              MATERIAL_UNIFORM_SIZE,
              `Prim material (translucent class)`,
            );
          primCache.materialDataTranslucent = new Float32Array(
            MATERIAL_UNIFORM_SIZE / 4,
          );
          // NEW-BG-CONSOLIDATION (Batch 122) — the translucent-class
          // material UB is an alternate buffer; the merged group 1 BG
          // for this pass is built per-frame at the draw command site
          // below using `materialBufferTranslucent` instead of the
          // primary `materialBuffer`.
        }
        // Pack with passClass=1 (the only field that differs from the
        // primary). Re-running the full packer is the simplest path —
        // costs ~768 B/frame extra writeBuffer per batch-table primitive,
        // negligible vs. the per-fragment savings of correct classification.
        packMaterialUniforms(
          primCache.materialDataTranslucent,
          modelMatrix,
          matInfo,
          primHasSkinning,
          primHasMorphTargets,
          pickColor,
          cache.prevModelMatrix,
          motionEnabled,
          1, // passClass = translucent
        );
        // Mirror the post-pack instancing / featureId flag patch from
        // the primary buffer so the translucent UB observes the same
        // FLAG_HAS_INSTANCING / FLAG_HAS_FEATURE_ID_* / FLAG_HAS_BATCH_TABLE
        // bits the FS gates the dual-discard branch on.
        {
          const flagsView = new DataView(
            primCache.materialDataTranslucent.buffer,
            primCache.materialDataTranslucent.byteOffset,
          );
          let currentFlags = flagsView.getUint32(28 * 4, true);
          if (hasInstancing && instanceCount > 1) {
            currentFlags |= FLAG_HAS_INSTANCING;
          }
          if (defined(featureIdRes)) {
            currentFlags |= featureIdRes.flags;
          }
          flagsView.setUint32(28 * 4, currentFlags, true);
        }
        device.queue.writeBuffer(
          primCache.materialBufferTranslucent.buffer,
          0,
          primCache.materialDataTranslucent.buffer,
          0,
          MATERIAL_UNIFORM_SIZE,
        );

        // Translucent-pass pipeline: BLEND alphaMode regardless of the
        // primary's mode so the second draw composites properly.
        if (!defined(primCache.translucentPipeline)) {
          primCache.translucentPipeline = pipelineCache.getPipeline(
            AlphaModes.BLEND,
            matInfo.isDoubleSided,
            // Batch 174 — translucent dual-command pipeline shares the
            // same per-variant materialBGL as the primary so the
            // mergedMaterialBGTranslucent below validates against it.
            primCache.materialDefines | 0,
          );
        }
        // NEW-BG-CONSOLIDATION (Batch 122) — translucent-class merged
        // group 1 BG. Same shape as the primary `mergedMaterialBG` but
        // with the alternate `materialBufferTranslucent` instead.
        const mergedMaterialBGTranslucent = buildMergedMaterialBindGroup(
          device,
          pipelineCache,
          primCache.materialBufferTranslucent,
          primCache.lightBuffer,
          primCache.textureEntries,
          featureIdEntries,
          iblEntries,
          primCache.materialDefines | 0,
          frameState,
        );
        const translucentCmd = new WebGPUDrawCommand({
          pipeline: primCache.translucentPipeline,
          bindGroups: [
            nodeCameraBG, // B.8 (Batch 152) — per-runtime-node camera BG
            mergedMaterialBGTranslucent,
            mergedInstanceBG,
            cache.effectsBG,
          ],
          vertexBuffers: vertexBuffers,
          indexBuffer: primCache.indexBuffer || undefined,
          indexCount: primCache.indexCount || 0,
          indexFormat: primCache.indexFormat || "uint16",
          vertexCount: primCache.vertexCount || 0,
          instanceCount: instanceCount,
          pass: Pass.TRANSLUCENT,
          owner: model,
          boundingVolume: model.boundingSphere,
          modelMatrix: modelMatrix,
          cull: model._cull ?? true,
          renderState: modelRenderState,
        });
        // AUDIT_2026_05_02 B.7 — Batch 79's selective depth-write fix
        // previously only fired for tile-owned models (Cesium3DTile.js sets
        // `depthForTranslucentClassification = true`). Standalone Models —
        // including any glTF added via `viewer.scene.primitives.add(...)` and
        // any Model used as a classifier — also need the depth-write variant
        // so `pickPosition` and ground/Vector3DTile classifiers don't see
        // through them. Opt-in via `model.depthWriteForTranslucentPicking`
        // (default false to preserve existing performance), or
        // automatically when `model.classificationType !== undefined`.
        if (
          primCache.depthWritePipeline &&
          (model.depthWriteForTranslucentPicking === true ||
            defined(model.classificationType))
        ) {
          translucentCmd.depthForTranslucentClassification = true;
          translucentCmd.classificationDepthPipeline =
            primCache.depthWritePipeline;
        }
        commandList.push(translucentCmd);
      }

      // C-R8-EDGE-EMITTER (Batch 45) — Emit edge visibility commands
      // for primitives that carry `EXT_mesh_primitive_edge_visibility`
      // data. The edges render into the WebGPUEdgeFramebuffer MRT via
      // the redirect in `WebGPUSceneRenderer._execute3DTilePasses`,
      // and the Batch 44 composite overlays them onto scene color.
      //
      // Resources are built once per primitive and reused across
      // frames; per-frame cost is two `writeBuffer` calls for the
      // camera + edge uniform UBs. Primitives without edge data skip
      // the whole block (the `extractEdgeGeometry` early-returns).
      const edgeGltfPrimitive = rp.primitive || rp._primitive;
      if (defined(edgeGltfPrimitive?.edgeVisibility)) {
        if (!defined(cache.edgeEmitterCache)) {
          cache.edgeEmitterCache = createEdgeEmitterCache();
        }
        const sceneSampleCount = context._msaaSamples ?? 1;
        const sceneColorFormat = context._sceneColorFormat ?? "bgra8unorm";
        ensureEdgeEmitterPipeline(
          cache.edgeEmitterCache,
          device,
          sceneColorFormat,
          sceneSampleCount,
        );

        // Build per-primitive edge buffers lazily. If the primitive's
        // edge data hasn't been extracted yet, do it now; otherwise
        // reuse the cached GPUBuffers.
        if (!defined(primCache.edgeResources)) {
          // C-R8-EDGE-FEATURE-ID — pull per-vertex feature IDs from the
          // glTF FEATURE_ID_0 attribute when present. Mirrors the
          // WebGL edge stage at `EdgeVisibilityPipelineStage.js:1242-
          // 1281` (lookup by `featureIds[0].setIndex` → matching
          // `attributes` entry → `typedArray`). When absent, the
          // emitter falls back to writing 0 in id.g and the consumer's
          // gate stays off.
          let edgeFeatureIdData = null;
          const fidSets = edgeGltfPrimitive.featureIds;
          if (defined(fidSets) && fidSets.length > 0) {
            const fidSet = fidSets[0];
            if (
              defined(fidSet?.setIndex) &&
              defined(edgeGltfPrimitive.attributes)
            ) {
              const fidAttr = edgeGltfPrimitive.attributes.find(
                (attr) =>
                  attr.semantic === "_FEATURE_ID" ||
                  (attr.name && attr.name.startsWith("_FEATURE_ID_")),
              );
              if (defined(fidAttr) && defined(fidAttr.typedArray)) {
                edgeFeatureIdData = fidAttr.typedArray;
              }
            }
          }
          const edgeGeom = extractEdgeGeometry(
            edgeGltfPrimitive,
            geometry.positionData,
            edgeFeatureIdData,
          );
          if (defined(edgeGeom)) {
            primCache.edgeResources = createEdgePrimitiveResources(
              device,
              cache.edgeEmitterCache,
              edgeGeom,
            );
            // Track per-primitive whether feature IDs were populated;
            // the model-FS effects bind group reads this through the
            // model-level rollup (`cache.hasEdgeFeatureIds`) to flip
            // the inline detection's per-feature gate.
            if (primCache.edgeResources) {
              primCache.edgeResources.hasFeatureIds = !!edgeGeom.hasFeatureIds;
              if (edgeGeom.hasFeatureIds) {
                cache.hasEdgeFeatureIds = true;
              }
            }
          } else {
            // Mark this primitive as having no edges so we don't
            // re-extract every frame. Use `false` as a sentinel
            // distinct from `undefined` (meaning "not yet checked").
            primCache.edgeResources = false;
          }
        }

        if (primCache.edgeResources) {
          // Compute MVP = projection * view * model and MV = view * model.
          // Both are needed: MVP for clip-space output, MV for the
          // silhouette discard's eye-space face-normal transform.
          // Standard RTE isn't applied — edge positions are model-
          // space; native 32-bit precision is fine at typical edge-
          // rendering distances. (Future: switch to RTE when an edge-
          // enabled model gets used at planet-scale distances.)
          const us = context.uniformState;
          const vp = us?.viewProjection;
          const view = us?.view;
          let mvp;
          if (defined(vp)) {
            mvp = Matrix4.multiply(vp, modelMatrix, scratchEdgeMVP);
          } else {
            mvp = Matrix4.clone(modelMatrix, scratchEdgeMVP);
          }
          const mvpData = Matrix4.toArray(mvp, scratchEdgeMVPArray);

          let mv;
          if (defined(view)) {
            mv = Matrix4.multiply(view, modelMatrix, scratchEdgeMV);
          } else {
            mv = Matrix4.clone(modelMatrix, scratchEdgeMV);
          }
          const mvData = Matrix4.toArray(mv, scratchEdgeMVArray);

          // Edge color: prefer the extension's `materialColor` if set;
          // otherwise default to black (matches the WebGL "edge color
          // overrides fragment color" behavior when `v_edgeColor.a`
          // is positive).
          const matColor = edgeGltfPrimitive.edgeVisibility?.materialColor;
          const edgeColor =
            defined(matColor) && matColor.length >= 4
              ? {
                  r: matColor[0],
                  g: matColor[1],
                  b: matColor[2],
                  a: matColor[3],
                }
              : { r: 0.0, g: 0.0, b: 0.0, a: 1.0 };

          // Viewport for NDC→pixel offset math in the wide-line VS.
          const vpW = context.drawingBufferWidth ?? 1;
          const vpH = context.drawingBufferHeight ?? 1;
          // Line width: prefer the model's per-edge override if it
          // ever lands on the model object; default to 2 px for a
          // visibly-non-degenerate edge regardless of DPR.
          const lineWidth = model._edgeLineWidth ?? 2.0;
          // Line pattern: 0xffff = solid. Per-model override slot
          // ready for `_edgeLinePattern` to land later.
          const linePattern = (model._edgeLinePattern ?? 0xffff) & 0xffff;

          writeEdgeEmitterUniforms(
            device,
            primCache.edgeResources,
            mvpData,
            mvData,
            edgeColor,
            vpW,
            vpH,
            lineWidth,
            linePattern,
          );

          // Session 65 Batch 13 (NEW-VR-DEPTHPLANE-EDGEEMITTER-
          // PIPELINE-FORMAT) — pick the MRT pipeline when the scene's
          // edge framebuffer redirect is active, otherwise the
          // single-target variant so edges draw safely onto the
          // regular 1-attachment scene framebuffer. Tracks
          // `scene._enableEdgeVisibility` (the same flag that gates
          // `_edgeFramebuffer` allocation in
          // `WebGPUSceneRendererEnsureResources`). The transient
          // "_enableEdgeVisibility flipped on this frame but the FBO
          // hasn't finished allocating yet" race resolves naturally:
          // the 3D-tile dispatcher falls back to the scene FB pass
          // when `edgeFB.isReady` is false (see
          // `WebGPUSceneRenderer3DTilePasses.ts:185`), and since the
          // pipeline was selected for the MRT layout, the validation
          // catches it. The fallback isn't visually critical (one
          // frame of clipped edges on toggle); the pipeline mismatch
          // we ARE fixing is the steady-state case where edge
          // visibility is off entirely.
          const sceneForEdge = frameState?.scene;
          const edgeVisibilityOn = sceneForEdge?._enableEdgeVisibility === true;
          const edgePipeline = edgeVisibilityOn
            ? cache.edgeEmitterCache.pipeline
            : cache.edgeEmitterCache.pipelineSingleTarget;
          const edgeCmd = new WebGPUDrawCommand({
            pipeline: edgePipeline,
            bindGroups: [
              primCache.edgeResources.cameraBG,
              primCache.edgeResources.edgeBG,
            ],
            vertexBuffers: [primCache.edgeResources.vertexBuffer],
            indexBuffer: primCache.edgeResources.indexBuffer,
            indexCount: primCache.edgeResources.indexCount,
            indexFormat: "uint32",
            instanceCount: 1,
            pass: Pass.CESIUM_3D_TILE_EDGES,
            owner: model,
            boundingVolume: model.boundingSphere,
            modelMatrix: modelMatrix,
            cull: model._cull ?? true,
          });
          commandList.push(edgeCmd);
        }
      }
    }

    // NEW-MODEL-NODE-TRANSFORMS-PREV (Batch 175) — capture THIS frame's
    // `nodeModelMatrix` into the per-node cache slot so the NEXT frame's
    // pack reads it as `prev`. Mirrors the model-level capture at the
    // end of `update()`. Only fires for non-identity nodes (identity
    // nodes share `cache.prevModelMatrix`); the slot lives on the
    // already-allocated `cache.nodes[nodeIdx]` (Batch 152 NEW-MODEL-
    // NODE-TRANSFORMS allocation). Clones the scratch matrix because
    // `scratchNodeModelMatrix` is reused across nodes per frame.
    if (!transformIsIdentity && defined(cache.nodes[nodeIdx])) {
      const ncForPrev = cache.nodes[nodeIdx];
      if (!defined(ncForPrev.prevNodeModelMatrix)) {
        ncForPrev.prevNodeModelMatrix = Matrix4.clone(nodeModelMatrix);
      } else {
        Matrix4.clone(nodeModelMatrix, ncForPrev.prevNodeModelMatrix);
      }
    }
  }

  // TAA Slice 2c (Batch 96) — capture this frame's modelMatrix as
  // `prevModelMatrix` so the next frame's primitive pack reads the
  // correct previous value. Done at the END of update so every
  // primitive saw the same prev-frame value during its pack call.
  // For static models the value never changes; for animated entities
  // (transforms updated by the host app each frame) the per-frame
  // delta drives the per-pixel velocity output gated on
  // `frameState.taaEnabled`.
  if (!defined(cache.prevModelMatrix)) {
    cache.prevModelMatrix = Matrix4.clone(modelMatrix);
  } else {
    Matrix4.clone(modelMatrix, cache.prevModelMatrix);
  }
}

// Scratch matrices for the edge-emitter MVP/MV build (avoids per-
// primitive allocation inside the hot loop).
const scratchEdgeMVP = new Matrix4();
const scratchEdgeMVPArray = new Float32Array(16);
const scratchEdgeMV = new Matrix4();
const scratchEdgeMVArray = new Float32Array(16);

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
  if (defined(cache.shadowCastUB)) {
    cache.shadowCastUB.destroy();
    cache.shadowCastUB = undefined;
  }

  // C-R9-MODEL-PICK (Batch 54 / refactored Batch 59) — release every
  // per-primitive pick ID back to the registry so its slot can be reused.
  // No-op if the model never entered a render or pick pass.
  destroyPickIds(cache);

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
    pc.uv1Buffer?.destroy();
    pc.colorBuffer?.destroy();
    pc.jointsBuffer?.destroy();
    pc.weightsBuffer?.destroy();
    pc.featureIdBuffer?.destroy();
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

    // C-R8-EDGE-EMITTER (Batch 45) — destroy per-primitive edge
    // buffers. `edgeResources === false` is the sentinel for
    // "primitive had no edges"; skip in that case.
    if (pc.edgeResources && pc.edgeResources !== false) {
      destroyEdgePrimitiveResources(pc.edgeResources);
    }
  }

  // C-R8-EDGE-EMITTER (Batch 45) — destroy the shared edge pipeline
  // cache when the model itself is torn down.
  if (defined(cache.edgeEmitterCache)) {
    destroyEdgeEmitterCache(cache.edgeEmitterCache);
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
    if (defined(nc.prevJointBuffer)) {
      nc.prevJointBuffer.destroy();
    }
    // AUDIT_2026_05_02 B.8 (Batch 152) — release per-node camera buffer.
    if (defined(nc.cameraBuffer)) {
      nc.cameraBuffer.destroy();
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
