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
import { createEffectsBindGroup } from "./WebGPUEffectsBindGroup.js";
import {
  attachPickToColorCommand,
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
//   floats 156-191: reserved (texture transform extensions for KHR slots,
//                             KHR_materials_pbrSpecularGlossiness lookups, etc.)
const MATERIAL_UNIFORM_SIZE = 768;
// Light uniform buffer: vec3+pad(sunDir) + vec3+f(sunCol+int) + vec3+pad(ambient)
//   + f(iblDiffuseFactor, iblSpecularFactor, iblMaxMipLevel, iblHasSH) = 64.
// Keep in sync with struct LightUniforms in ModelPBRComplete.wgsl.
const LIGHT_UNIFORM_SIZE = 64;

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

  // Reserved (slot 156-191). Zero-fill for std140 stability.
  for (let i = 156; i < 192; i++) {
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
  const sunDir =
    frameState.context?.uniformState?.sunDirectionEC || new Cartesian3(0, 0, 1);
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
  // Max mip level of the specular environment map. 8 is the typical prefilter
  // chain depth (256² cubemap → 9 mips); used to drive roughness→mip mapping.
  data[14] = ibl?._specularEnvironmentMapAtlas?._maximumMipmapLevel ?? 8.0;
  data[15] = ibl?._sphericalHarmonicCoefficients ? 1.0 : 0.0;
}

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
    );
  }

  // Create GPU textures from glTF image sources
  const textures = createMaterialTextures(device, pipelineCache, matInfo);
  primCache.gpuTextures = textures.created;

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
  primCache.textureBindGroup = device.createBindGroup({
    layout: pipelineCache.textureBGL,
    entries: [
      { binding: 0, resource: textures.baseColor.createView() },
      { binding: 1, resource: baseSampler || defSampler },
      { binding: 2, resource: textures.normal.createView() },
      { binding: 3, resource: normalSampler || defSampler },
      { binding: 4, resource: textures.metallicRoughness.createView() },
      { binding: 5, resource: mrSampler || defSampler },
      { binding: 6, resource: textures.emissive.createView() },
      { binding: 7, resource: emissiveSampler || defSampler },
      { binding: 8, resource: textures.occlusion.createView() },
      { binding: 9, resource: occlusionSampler || defSampler },
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

  function tryCreate(reader, fallback, colorSpace) {
    if (!defined(reader)) {
      return fallback;
    }
    const tex = createGPUTextureFromReader(device, reader, colorSpace);
    if (defined(tex)) {
      created.push(tex);
      return tex;
    }
    return fallback;
  }

  // Slot color-space classification (per glTF spec):
  //   srgb: baseColor (and specGloss diffuse), emissive.
  //   linear: normal, metallic-roughness (and specGloss specular), occlusion.
  // Storing sRGB slots as `rgba8unorm-srgb` makes the GPU sampler auto-decode
  // gamma, which is both perceptually correct for linear filtering AND
  // removes the need for in-shader pow(2.2) approximation.
  return {
    baseColor: tryCreate(
      matInfo.baseColorTextureReader || matInfo.diffuseTextureReader,
      defWhite,
      "srgb",
    ),
    normal: tryCreate(matInfo.normalTextureReader, defNormal, "linear"),
    metallicRoughness: tryCreate(
      matInfo.metallicRoughnessTextureReader || matInfo.specGlossTextureReader,
      defWhite,
      "linear",
    ),
    emissive: tryCreate(matInfo.emissiveTextureReader, defBlack, "srgb"),
    occlusion: tryCreate(matInfo.occlusionTextureReader, defWhite, "linear"),
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
  const viewportPx = uniformState?.viewportCartesian4;
  const edgesReady =
    !!edgeColorView &&
    !!edgeDepthView &&
    !!globeDepthView &&
    !!currentFrustum &&
    !!viewportPx;
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
        viewportWidth: viewportPx.z,
        viewportHeight: viewportPx.w,
        hasFeatureId: cache.hasEdgeFeatureIds === true,
      }
    : undefined;

  const fxRes = createEffectsBindGroup(device, frameState, {
    shadowMap: receiveShadowMap,
    csm: csmBinding,
    // Models don't carry their own clipping-plane set — clipping in
    // glTF flows through the scene-wide ClippingPlaneCollection if
    // any. Use the scene's camera position for in-plane-space (the
    // shader's clipping test is in eye space anyway; cameraInPlaneSpace
    // is only consumed by the globe's plane-space transform).
    cameraInPlaneSpace: frameState.context.uniformState.cameraPosition,
    edges: edgesPayload,
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

      // Update material uniforms (includes skinning + morph flags +
      // pick color slot).
      packMaterialUniforms(
        primCache.materialData,
        modelMatrix,
        matInfo,
        primHasSkinning,
        primHasMorphTargets,
        pickColor,
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
      packLightUniforms(primCache.lightData, frameState, model);
      device.queue.writeBuffer(
        primCache.lightBuffer.buffer,
        0,
        primCache.lightData.buffer,
        0,
        LIGHT_UNIFORM_SIZE,
      );

      // Assemble vertex buffers: [pos, normal, tangent, uv0, color, joints, weights, uv1]
      // Slot 7 (uv1) falls back to the uv0 default when the primitive has
      // no TEXCOORD_1 accessor — the shader is safe against that because
      // the per-texture-slot `texCoord` flag in the material UBO steers
      // sampling to uv0 unless the glTF explicitly asked for uv1.
      const vertexBuffers = [
        primCache.positionBuffer,
        primCache.normalBuffer || pipelineCache.defaultNormalBuffer,
        primCache.tangentBuffer || pipelineCache.defaultTangentBuffer,
        primCache.uvBuffer || pipelineCache.defaultUVBuffer,
        primCache.colorBuffer || pipelineCache.defaultColorBuffer,
        primCache.jointsBuffer || pipelineCache.defaultJointsBuffer,
        primCache.weightsBuffer || pipelineCache.defaultWeightsBuffer,
        primCache.uv1Buffer ||
          primCache.uvBuffer ||
          pipelineCache.defaultUVBuffer,
      ];

      // Use model.opaquePass to get the correct pass:
      //   - Pass.CESIUM_3D_TILE for 3D Tiles content (set by Model3DTileContent)
      //   - Pass.OPAQUE for standalone models
      // Alpha blend primitives override to TRANSLUCENT
      const pass =
        matInfo.alphaMode === AlphaModes.BLEND
          ? Pass.TRANSLUCENT
          : model.opaquePass;

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
          // Group 7 — effects (shadow receive + clipping + CSM). Shared
          // across all primitives of this model per the per-frame update
          // above; rebuilt each frame so scene-toggle changes (shadow
          // darkness, CSM enable) reach the pipeline without a recompile.
          cache.effectsBG,
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
        renderState: modelRenderState,
        // C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 79) — depth-write variant
        // pipeline for BLEND primitives. Only consumed when the command's
        // `depthForTranslucentClassification` flag is set (forwarded by
        // `Cesium3DTile.update` for translucent tile content). Undefined
        // for OPAQUE/MASK because they already write depth.
        classificationDepthPipeline: primCache.depthWritePipeline,
      });

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
      if (pickColor) {
        if (!defined(primCache.pickPipeline)) {
          primCache.pickPipeline = pipelineCache.getPickPipeline(
            matInfo.alphaMode,
            matInfo.isDoubleSided,
          );
        }
        const pickCmd = new WebGPUDrawCommand({
          pipeline: primCache.pickPipeline,
          bindGroups: [
            cache.cameraBG,
            primCache.materialBG,
            primCache.textureBindGroup,
            skinningBG,
            morphTargetBG,
            instancingBG,
            featureIdBG,
            cache.effectsBG,
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
          renderState: modelRenderState,
          pickOnly: true,
        });
        attachPickToColorCommand(webgpuCmd, pickCmd);
      }

      commandList.push(webgpuCmd);

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

          const edgeCmd = new WebGPUDrawCommand({
            pipeline: cache.edgeEmitterCache.pipeline,
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
    destroyInstancingResources(nc);
  }

  if (defined(cache.pipelineCache)) {
    cache.pipelineCache.destroy();
  }

  model._webgpuCache = undefined;
}

export { updateWebGPUModel, destroyWebGPUModelResources };
export default { updateWebGPUModel, destroyWebGPUModelResources };
