// ModelPBRComplete.wgsl — Comprehensive PBR shader for glTF models
// Combined vertex + fragment shader for WebGPU Model rendering.
// Supports: metallic-roughness, specular-glossiness, unlit, all texture types,
// alpha modes (OPAQUE, MASK, BLEND), normal mapping, double-sided, vertex colors.
//
// Model positions remain in model coordinates (3 floats, NOT high/low split).
// Camera position is encoded in model space via inverse(modelMatrix) * cameraPositionWC.
//
// Material features controlled by materialFlags bitfield uniform:
//   bit 0:  HAS_BASE_COLOR_TEXTURE
//   bit 1:  HAS_NORMAL_TEXTURE
//   bit 2:  HAS_METALLIC_ROUGHNESS_TEXTURE
//   bit 3:  HAS_EMISSIVE_TEXTURE
//   bit 4:  HAS_OCCLUSION_TEXTURE
//   bit 5:  HAS_VERTEX_COLORS
//   bit 6:  ALPHA_MODE_MASK
//   bit 7:  ALPHA_MODE_BLEND
//   bit 8:  IS_DOUBLE_SIDED
//   bit 9:  IS_UNLIT
//   bit 10: USE_SPECULAR_GLOSSINESS
//   bit 11: HAS_SPECULAR_GLOSSINESS_TEXTURE
//   bit 12: HAS_DIFFUSE_TEXTURE
//   bit 13: HAS_SKINNING
//   bit 14: HAS_MORPH_TARGETS
//
// Morph target pipeline:
//   Morph deltas extracted on CPU (ModelPrimitiveGeometry.js — shared)
//   Packed into storage buffer (WebGPUModelMorphTargets.js — GPU-specific)
//   Weights packed into uniform buffer (max 8 targets)
//   Applied per-vertex BEFORE skinning (glTF spec: morph → skin → RTE)
//
// Skinning pipeline:
//   Joint matrices computed on CPU (ModelSkin.js + ModelRuntimeNode.js — shared)
//   Packed into Float32Array (ModelSkinData.js — shared extractor)
//   Uploaded to storage buffer (WebGPUModelRenderer.js — GPU-specific)
//   Applied per-vertex in this shader (JOINTS_0 + WEIGHTS_0 → weighted blend)
//   Skinning happens IN MODEL SPACE, BEFORE the RTE subtraction — correct order.

// ─── Material Flag Constants ─────────────────────────────────────────────────

const FLAG_HAS_BASE_COLOR_TEXTURE: u32         = 1u;
const FLAG_HAS_NORMAL_TEXTURE: u32             = 2u;
const FLAG_HAS_METALLIC_ROUGHNESS_TEXTURE: u32 = 4u;
const FLAG_HAS_EMISSIVE_TEXTURE: u32           = 8u;
const FLAG_HAS_OCCLUSION_TEXTURE: u32          = 16u;
const FLAG_HAS_VERTEX_COLORS: u32              = 32u;
const FLAG_ALPHA_MODE_MASK: u32                = 64u;
const FLAG_ALPHA_MODE_BLEND: u32               = 128u;
const FLAG_IS_DOUBLE_SIDED: u32                = 256u;
const FLAG_IS_UNLIT: u32                       = 512u;
const FLAG_USE_SPECULAR_GLOSSINESS: u32        = 1024u;
const FLAG_HAS_SPECGLOSS_TEXTURE: u32          = 2048u;
const FLAG_HAS_DIFFUSE_TEXTURE: u32            = 4096u;
const FLAG_HAS_SKINNING: u32                   = 8192u;
const FLAG_HAS_MORPH_TARGETS: u32              = 16384u;
const FLAG_HAS_INSTANCING: u32                 = 32768u;
const FLAG_HAS_FEATURE_ID_TEXTURE: u32         = 65536u;  // bit 16
const FLAG_HAS_FEATURE_ID_ATTRIBUTE: u32       = 131072u; // bit 17
const FLAG_HAS_BATCH_TABLE: u32                = 262144u; // bit 18
// C-R4-GLTF-KHR (slices 2-7) — KHR material extension activation bits.
// Each block of factor reads + extension lighting is gated on the
// matching bit so identity-default values stay branch-light.
const FLAG_HAS_CLEARCOAT: u32                  = 524288u;  // bit 19
const FLAG_HAS_SPECULAR_EXT: u32               = 1048576u; // bit 20
const FLAG_HAS_ANISOTROPY: u32                 = 2097152u; // bit 21
const FLAG_HAS_IRIDESCENCE: u32                = 4194304u; // bit 22
const FLAG_HAS_SHEEN: u32                      = 8388608u; // bit 23
const FLAG_HAS_VOLUME: u32                     = 16777216u; // bit 24
// C-R4-GLTF-KHR-TRANSMISSION (Batch 105) — gates the FS refraction
// sampling branch. Transmission samples the prior-pass scene color
// (refraction MRT) at a refracted UV offset.
const FLAG_HAS_TRANSMISSION: u32               = 33554432u; // bit 25

// ─── Uniform Structures ──────────────────────────────────────────────────────

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  modelViewRelativeToEye: mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  encodedCameraPositionMCHigh: vec3<f32>,
  // Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH) — the three
  // formerly-pad lanes at floats 51/55/59 carry the log-depth scalars in
  // the WebGPULogDepth.ts packCameraLogDepthLanes convention:
  //   51 = oneOverLog2FarDepthFromNearPlusOne (factor)
  //   55 = encode frustum near
  //   59 = encode frustum far
  // Packed unconditionally by the model renderer; only the
  // `//>>ifdef LOG_DEPTH` blocks read them.
  logDepthFactor: f32,
  encodedCameraPositionMCLow: vec3<f32>,
  logDepthNear: f32,
  cameraPositionWC: vec3<f32>,
  logDepthFar: f32,
    previousViewProjection: mat4x4<f32>,
};

//>>ifdef LOG_DEPTH
// Renderer-wide log depth — canonical inline copies; see
// chunks/functions/csm_{vertexLogDepth,writeLogDepth}.wgsl.
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
  return (clipPosition.w - near) + 1.0;
}
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
  var coords = clipPosition;
  coords.z = clamp(coords.z / coords.w, 0.0, 1.0) * coords.w;
  return coords;
}
fn csm_writeLogDepth(depthFromNearPlusOne: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
  return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne;
}
//>>endif

struct MaterialUniforms {
  modelMatrix: mat4x4<f32>,
  baseColorFactor: vec4<f32>,
  emissiveFactor: vec3<f32>,
  metallicFactor: f32,
  roughnessFactor: f32,
  alphaCutoff: f32,
  normalScale: f32,
  occlusionStrength: f32,
  materialFlags: u32,
  specularFactor_r: f32,
  specularFactor_g: f32,
  specularFactor_b: f32,
  glossinessFactor: f32,
  diffuseFactor_r: f32,
  diffuseFactor_g: f32,
  diffuseFactor_b: f32,
  diffuseFactor_a: f32,
  // Per-texture UV-set bitmask. One bit per texture slot: 0 = sample
  // using TEXCOORD_0, 1 = sample using TEXCOORD_1. Maps to glTF
  // textureInfo.texCoord for each slot. Bit layout:
  //   bit 0: baseColor
  //   bit 1: normal
  //   bit 2: metallicRoughness
  //   bit 3: emissive
  //   bit 4: occlusion
  texCoordFlags: u32,
  _pad_end2: f32,
  _pad_end3: f32,
  // C-R9-MODEL-PICK (Batch 54) — primitive-granularity pick color. The
  // pick fragment entry (`fragmentPickMain`) writes this directly to the
  // pick FBO color attachment so the readback maps the bytes back to the
  // {primitive: model, id: <primitiveIndex>} target registered via
  // `context.createPickId(...)`. Lit fragment ignores the slot. Per-
  // feature picking (KHR_mesh_features / EXT_structural_metadata) is a
  // separate follow-up — see `C-R9-MODEL-FEATURE-PICK`.
  pickColor: vec4<f32>,
  // C-R4-GLTF-KHR (slice 1, KHR_texture_transform). Per-texture 3x3
  // affine UV transforms (offset/rotation/scale combined into a 3x3
  // matrix; identity when the extension is absent). Stored as 3
  // padded vec4 columns each so std140 alignment lines up. Matches
  // WebGL's `czm_computeTextureTransform`. Slot bits in
  // `textureTransformFlags` indicate which slots have non-identity
  // transforms; the FS skips the multiply for identity slots so the
  // common no-extension case stays branch-light. Bit layout mirrors
  // texCoordFlags above (baseColor / normal / metallicRoughness /
  // emissive / occlusion).
  baseColorTextureTransform0: vec4<f32>,
  baseColorTextureTransform1: vec4<f32>,
  baseColorTextureTransform2: vec4<f32>,
  normalTextureTransform0: vec4<f32>,
  normalTextureTransform1: vec4<f32>,
  normalTextureTransform2: vec4<f32>,
  metallicRoughnessTextureTransform0: vec4<f32>,
  metallicRoughnessTextureTransform1: vec4<f32>,
  metallicRoughnessTextureTransform2: vec4<f32>,
  emissiveTextureTransform0: vec4<f32>,
  emissiveTextureTransform1: vec4<f32>,
  emissiveTextureTransform2: vec4<f32>,
  occlusionTextureTransform0: vec4<f32>,
  occlusionTextureTransform1: vec4<f32>,
  occlusionTextureTransform2: vec4<f32>,
  textureTransformFlags: u32,
  _pad_tt0: f32,
  _pad_tt1: f32,
  _pad_tt2: f32,

  // C-R4-GLTF-KHR (slices 2-7). Each block is 8 floats (32 B) at a
  // 16-byte boundary so std140 sees a vec4-aligned slot. Identity
  // values are written when the corresponding extension is absent.
  // The FS gates each block on the matching `materialFlags` bit
  // (HAS_CLEARCOAT, HAS_SPECULAR, ...) so identity values are
  // branch-light: the BRDF math never runs.
  //
  // Slice 2 — KHR_materials_clearcoat.
  // x: clearcoatFactor [0, 1]
  // y: clearcoatRoughnessFactor [0, 1]
  // z: clearcoatNormalScale (multiplier for the per-fragment normal
  //    if a clearcoat normal map were sampled — left in the layout so
  //    the texture-binding follow-up slice doesn't need a re-layout)
  // w: reserved
  clearcoatFactors: vec4<f32>,
  _pad_cc0: vec4<f32>,
  // Slice 3 — KHR_materials_specular.
  // x: specularFactor (modulates F0 intensity)
  // yzw: specularColorFactor (tints F0 chromatically)
  specularExtFactors: vec4<f32>,
  _pad_se0: vec4<f32>,
  // Slice 4 — KHR_materials_anisotropy.
  // x: strength
  // y: rotation (radians, CCW from tangent)
  // zw: reserved
  anisotropyFactors: vec4<f32>,
  _pad_an0: vec4<f32>,
  // Slice 5 — KHR_materials_iridescence.
  // x: factor [0, 1]
  // y: ior
  // z: thicknessMinimum (nm)
  // w: thicknessMaximum (nm)
  iridescenceFactors: vec4<f32>,
  _pad_ir0: vec4<f32>,
  // Slice 6 — KHR_materials_sheen.
  // xyz: sheenColorFactor
  // w: sheenRoughnessFactor
  sheenFactors: vec4<f32>,
  _pad_sh0: vec4<f32>,
  // Slice 7 — KHR_materials_volume.
  // x: thicknessFactor (geometry-units)
  // y: attenuationDistance (0 = no attenuation sentinel)
  // zw: padding into next slot
  // attenuationColor lives in the second vec4 of this slot.
  volumeFactors0: vec4<f32>,
  volumeFactors1: vec4<f32>,
  // TAA Slice 2c (Batch 96) — previous-frame model matrix for per-model
  // motion-vector computation. The TAA shader currently reprojects via
  // depth + previousViewProjection alone, which treats animated /
  // skinned / instanced geometry as static and ghosts the motion.
  // Capturing prev-frame's modelMatrix per primitive lets the VS
  // reconstruct the previous-frame clip-space position
  // (`previousViewProjection * previousModelMatrix * positionMC`),
  // which the FS can then convert to screen-space velocity. The
  // velocity output (@location(1) MRT) is gated behind the
  // `motionFlags.x > 0.5` toggle and currently disabled — turning it
  // on requires the second color attachment to be added to model
  // pipelines, which is a follow-up slice. Plumbing the data through
  // first lets the FS-side enablement land without renderer-wide
  // pipeline format churn.
  previousModelMatrix: mat4x4<f32>,
  // motionFlags.x: motion-vector output enabled (0 / 1)
  // motionFlags.y: motion vector scale (default 1.0)
  // motionFlags.zw: reserved for slice 2d (sky reprojection / disocclusion tweaks)
  motionFlags: vec4<f32>,
  // C-R1-TILE-BATCH (Batch 100) — Cesium3DTileBatchTable per-feature
  // renderState support. The batch texture's per-feature RGBA carries
  // an alpha that tile styling can flip <1 to make individual features
  // translucent. WebGL handles this via dual-command emission
  // (deriveOpaqueCommand + deriveTranslucentCommand at
  // `Cesium3DTileBatchTable.js:497-507`) — the same primitive draws
  // twice, once per pass, with each FS instance discarding the wrong-
  // class features.
  //
  // tileBatchFlags layout:
  //   x: passClass (0 = opaque pass, 1 = translucent pass). Only
  //      consumed when FLAG_HAS_BATCH_TABLE is set; otherwise the
  //      historical single-class behavior is preserved.
  //   y: opaque-alpha threshold for the class discard (default 0.998
  //      — matches Cesium 3D Tiles' "feature is translucent if
  //      tile_translucentCommand &&  alpha < 0.998" gate).
  //   z, w: reserved.
  tileBatchFlags: vec4<f32>,
  // C-R4-GLTF-KHR-TRANSMISSION (Batch 105) — transmission factor +
  // ior. Replaces _pad_reserved7. Layout:
  //   x: transmissionFactor [0, 1]
  //   y: ior (default 1.5 — index of refraction)
  //   z, w: reserved
  transmissionFactors: vec4<f32>,
  _pad_reserved8: vec4<f32>,
};

// Audit B.3 (Batch 131) + re-review (Batch 134) -- per-light data
// structure matching the JS `LightCollection.pack()` output (20 floats
// / 80 bytes per light). Slot semantics depend on `lightType`:
//   DIRECTIONAL (0) : posOrDir = direction; spotDirection ignored
//   POINT       (1) : posOrDir = position; spotDirection ignored
//   SPOT        (2) : posOrDir = position; spotDirection = forward
//                     (the direction the spot is aimed); inner/outer
//                     cone angles active
//
// Slots 16-18 carry the spot direction at vec3 alignment (the next
// 16-byte boundary after slot 15). Pre-Batch-134 the record was 16
// floats and spot lights had no direction slot -- the cone math fell
// back to point falloff. With direction packed, spot cone gating is
// fully correct.
struct PunctualLight {
  posOrDir: vec3<f32>,
  lightType: f32,         // cast to int via `i32(lightType)`
  color: vec3<f32>,
  intensity: f32,
  range: f32,
  constantAtt: f32,
  linearAtt: f32,
  quadraticAtt: f32,
  innerConeAngle: f32,
  outerConeAngle: f32,
  _pad0: f32,
  _pad1: f32,
  spotDirection: vec3<f32>,
  _pad2: f32,
};

struct LightUniforms {
  sunDirectionEC: vec3<f32>,
  _pad0: f32,
  sunColor: vec3<f32>,
  sunIntensity: f32,
  ambientColor: vec3<f32>,
  _pad1: f32,
  // IBL parameters
  iblDiffuseFactor: f32,
  iblSpecularFactor: f32,
  iblMaxMipLevel: f32,
  iblHasSH: f32,  // 1.0 if SH coefficients are available
  // Audit B.3 (Batch 131) -- punctual lights from `scene.lights` (and
  // future glTF KHR_lights_punctual). Cap is 8 -- matches
  // `LightCollection.MAX_LIGHTS` and the JS pack budget. The padding
  // members are deliberately discrete f32s rather than a vec3<f32> --
  // a vec3 would round up to alignment 16 from offset 64+4=68, jumping
  // the array's start to byte 96 instead of the byte 80 the JS pack
  // expects. Discrete f32 padding keeps offset = 4 alignment.
  punctualLightCount: f32, // i32 stored as f32 (uniform-buffer alignment)
  _pad2a: f32,
  _pad2b: f32,
  _pad2c: f32,
  punctualLights: array<PunctualLight, 8>,
  // NEW-MODEL-IBL-REFERENCE-FRAME (Batch 287) — eye→IBL-reference-frame
  // rotation. Matches WebGL's `model_iblReferenceFrameMatrix`
  // (ImageBasedLightingPipelineStage.js): `yUpToZUp *
  // transpose(rotation(view3D * referenceMatrix))`. The diffuse normal
  // and specular reflection vectors are computed in eye space, then
  // rotated by this matrix into the fixed environment frame BEFORE the
  // cubemap sample, so IBL reflections stay world-anchored as the camera
  // orbits instead of rotating with it. Appended after the punctual-
  // light array at byte 720 (16-aligned); a mat3x3 occupies 48 bytes
  // (3 × vec4 columns in std140), so LightUniforms is now 768 bytes.
  // Identity when no IBL is configured (FS still samples the placeholder
  // cubemap, which is rotation-invariant grey).
  iblReferenceFrameMatrix: mat3x3<f32>,
};

// ─── Bind Groups ─────────────────────────────────────────────────────────────

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(1) @binding(1) var<uniform> light: LightUniforms;

// Textures — bind 1x1 default textures when not available
@group(1) @binding(2) var baseColorTexture: texture_2d<f32>;
@group(1) @binding(3) var baseColorSampler: sampler;
@group(1) @binding(4) var normalTexture: texture_2d<f32>;
@group(1) @binding(5) var normalSampler: sampler;
@group(1) @binding(6) var metallicRoughnessTexture: texture_2d<f32>;
@group(1) @binding(7) var metallicRoughnessSampler: sampler;
@group(1) @binding(8) var emissiveTexture: texture_2d<f32>;
@group(1) @binding(9) var emissiveSampler: sampler;
@group(1) @binding(10) var occlusionTexture: texture_2d<f32>;
@group(1) @binding(11) var occlusionSampler: sampler;
// C-R4-GLTF-KHR-TEXTURES (Batch 102) — KHR extension primary textures
// + shared sampler. Bound to a 1×1 white placeholder when the
// matching extension is absent; the FS gates each sample on the
// extension's HAS_* flag so the placeholder is never sampled in
// production. See WebGPUModelPipelineCache `materialBGL` for the
// rationale on the shared sampler.
//
// Batch 174 (B.4) — Wrapped in `//>>ifdef MODEL_HAS_KHR_TEXTURES` so
// the basic shader variant strips these 14 bindings (12 textures +
// sampler + 2 transmission). Total sampled-texture count drops 23 →
// 10, fitting within the WebGPU spec floor `maxSampledTexturesPerShaderStage = 16`
// for materials without any KHR extension. The renderer pairs the
// stripped shader with `materialBGL_basic` + the basic pipeline
// layout (see `WebGPUModelPipelineCache.materialBGL_basic`).
//>>ifdef MODEL_HAS_KHR_TEXTURES
@group(1) @binding(12) var clearcoatTexture: texture_2d<f32>;
@group(1) @binding(13) var specularColorTexture: texture_2d<f32>;
@group(1) @binding(14) var anisotropyTexture: texture_2d<f32>;
@group(1) @binding(15) var iridescenceTexture: texture_2d<f32>;
@group(1) @binding(16) var sheenColorTexture: texture_2d<f32>;
@group(1) @binding(17) var thicknessTexture: texture_2d<f32>;
// C-R4-GLTF-KHR-TEXTURES (Batch 103) — KHR secondary maps. Same
// placeholder + flag-gated convention as the primary KHR slots.
@group(1) @binding(18) var clearcoatRoughnessTexture: texture_2d<f32>;
@group(1) @binding(19) var clearcoatNormalTexture: texture_2d<f32>;
@group(1) @binding(20) var sheenRoughnessTexture: texture_2d<f32>;
@group(1) @binding(21) var specularFactorTexture: texture_2d<f32>;
@group(1) @binding(22) var iridescenceThicknessTexture: texture_2d<f32>;
@group(1) @binding(23) var khrSampler: sampler;
// C-R4-GLTF-KHR-TRANSMISSION (Batch 105) — refraction texture (a copy
// of the prior-pass scene color) + transmission factor map. The
// SceneRenderer is responsible for capturing scene color into a
// dedicated refraction texture before the transmissive draw and
// binding it here. When KHR_materials_transmission isn't active the
// placeholder white texture binds (FS branch is gated on
// FLAG_HAS_TRANSMISSION so the placeholder content is unused).
@group(1) @binding(24) var transmissionTexture: texture_2d<f32>;
@group(1) @binding(25) var refractionSceneTexture: texture_2d<f32>;
//>>endif

// Joint matrices for skinning (bind group 3, only used when FLAG_HAS_SKINNING is set)
@group(2) @binding(0) var<storage, read> jointMatrices: array<mat4x4<f32>>;
// Audit A.5 (Batch 130) -- prev-frame joint matrices for TAA
// velocity. The vertex shader re-runs skinning with these to produce
// `prevPositionMC` (otherwise `worldPosPrevious = previousModelMatrix
// * currentSkinnedPositionMC` produces phantom velocity that ghosts
// across animated characters).
@group(2) @binding(4) var<storage, read> previousJointMatrices: array<mat4x4<f32>>;

// Morph targets (bind group 4, only used when FLAG_HAS_MORPH_TARGETS is set)
// Storage buffer: per-target blocks of (vertexCount × 3 × vec4) — for each
//   vertex an interleaved [positionDelta, normalDelta, tangentDelta] triple
//   (DP-H35 added normal Batch 329; C2-4 added tangent Batch 373). Index via
//   base = (t * vertexCount + vid) * 3u; positionDelta = morphDeltas[base],
//   normalDelta = morphDeltas[base + 1u], tangentDelta = morphDeltas[base + 2u].
//   The CPU pack (WebGPUModelMorphTargets.js FLOATS_PER_VERTEX_PER_TARGET = 12)
//   MUST stay byte-consistent with this *3u stride.
// Uniform buffer: weights (2 × vec4 = 8 weights max) + targetCount + vertexCount
struct MorphWeightsUniforms {
  weights0: vec4<f32>,    // morph weights 0-3
  weights1: vec4<f32>,    // morph weights 4-7
  targetCount: f32,
  vertexCount: f32,
  _pad0: f32,
  _pad1: f32,
};
@group(2) @binding(1) var<storage, read> morphDeltas: array<vec4<f32>>;
@group(2) @binding(2) var<uniform> morphWeights: MorphWeightsUniforms;

// Instance transforms (bind group 5, only used when FLAG_HAS_INSTANCING is set)
// Storage buffer: array of InstanceTransform — one per instance.
//
// DP-H36 (Batch 325) — RTE split for the per-instance TRANSLATION. The
// instance translation places each instance at its tile-relative ECEF
// offset, which at Earth scale (~6.4e6 m) overflows f32's ~2^23 mantissa
// and loses ~1 m of sub-meter precision. Packing the translation as a
// single f32 column (the old `mat4x4` layout) and adding it to the local
// vertex position BEFORE the RTE camera subtract destroyed those bits
// before they could cancel — producing visible i3dm jitter under a
// stationary camera. The fix keeps the rotation+scale linear part in f32
// (small magnitude, no precision risk) but carries the translation as a
// high/low pair (EncodedCartesian3 split on the CPU) so the vertex shader
// can RTE it directly against the encoded camera via translateRelativeToEye.
//
// Layout (std430, 96 bytes / 24 floats per instance):
//   linear:          mat4x4<f32>  offset 0   (rotation+scale, col3 zeroed)
//   translationHigh: vec4<f32>    offset 64  (.xyz used, .w pad)
//   translationLow:  vec4<f32>    offset 80  (.xyz used, .w pad)
// CPU pack width, GPU buffer stride, and this struct MUST stay byte-consistent.
struct InstanceTransform {
  linear: mat4x4<f32>,
  translationHigh: vec4<f32>,
  translationLow: vec4<f32>,
}
@group(2) @binding(3) var<storage, read> instanceTransforms: array<InstanceTransform>;

// NEW-TAA-MORPH-PREV (Batch 134) -- previous-frame morph weights for
// the velocity pass. The vertex shader runs morph twice (current +
// prev) so animated facial blendshapes / lipsync produce correct
// per-vertex velocity instead of stretching whatever the current
// pose happens to be against the previous-frame model matrix.
@group(2) @binding(5) var<uniform> previousMorphWeights: MorphWeightsUniforms;
// NEW-TAA-INSTANCE-PREV (Batch 134) -- previous-frame instance
// transforms. For static GPU instancing (today's only case) this
// aliases the current `instanceTransforms` buffer in JS, so the prev
// pass produces the same world-space position as the current pass and
// velocity collapses to camera/model-matrix delta only. Animated
// EXT_mesh_gpu_instancing assets would publish a separate prev
// buffer for per-frame per-instance velocity.
@group(2) @binding(6) var<storage, read> previousInstanceTransforms: array<InstanceTransform>;

// Feature ID + batch texture (bind group 6, for per-feature styling in 3D Tiles)
// Feature ID texture: encodes integer feature IDs in RGBA channels (EXT_mesh_features)
// Batch texture: maps feature ID → RGBA color for per-feature styling
struct FeatureIdUniforms {
  featuresLength: i32,
  channelCount: i32,
  texCoordIndex: i32,
  hasMultilineBatchTex: i32,
  textureStep: vec4<f32>,
  textureDimensions: vec2<f32>,
  // C-R9-MODEL-FEATURE-PICK (Batch 100). When > 0.5 the pickFS routes
  // through `lookupFeaturePickColor` (the per-feature pick texture
  // bound at @binding(5)) instead of returning `material.pickColor`.
  // The JS side flips this on whenever it allocates per-feature pickIds
  // (via `ensurePerFeaturePickIds`); off otherwise so we don't sample
  // a placeholder texture and waste bandwidth.
  featurePickEnabled: f32,
  _pad1: f32,
};
@group(1) @binding(26) var featureIdTexture: texture_2d<f32>;
@group(1) @binding(27) var featureIdSampler: sampler;
@group(1) @binding(28) var batchTexture: texture_2d<f32>;
@group(1) @binding(29) var batchSampler: sampler;
@group(1) @binding(30) var<uniform> featureId: FeatureIdUniforms;
// C-R9-MODEL-FEATURE-PICK (Batch 100) — per-feature pick color lookup
// table. Layout matches the batch texture (RGBA8, 1D for small feature
// counts and 2D for >1024 features). featureId 0 maps to texel
// (0.5 / W, 0.5 / H), featureId N maps to (N + 0.5 / W, ...). Entries
// with alpha == 0 mean "no pickId allocated" and the pickFS falls
// through to `material.pickColor`. Bound only when
// `featureId.featurePickEnabled > 0.5`; the placeholder feature-id
// bind group from Batch 53 carries a 1×1 transparent texel so the
// binding is always valid.
@group(1) @binding(31) var featurePickTexture: texture_2d<f32>;
@group(1) @binding(32) var featurePickSampler: sampler;

// Audit A.9 (Batch 130) -- IBL cubemap bindings. Irradiance cubemap
// (33) for diffuse ambient, prefiltered radiance cubemap (34) for
// specular ambient with mip-based roughness rangefinding, shared
// sampler (35) configured linear/clamp-to-edge by the JS pipeline
// cache. SH coefficients (36) are optional (active flag in slot 9.w);
// when active they short-circuit the irradiance cubemap sample with
// a 9-coefficient evaluation against the surface normal.
@group(1) @binding(33) var iblDiffuseTexture: texture_cube<f32>;
@group(1) @binding(34) var iblSpecularTexture: texture_cube<f32>;
@group(1) @binding(35) var iblSampler: sampler;
struct SHUniforms {
  // 9 SH coefficients (L0, L1m1, L10, L11, L2m2, L2m1, L20, L21, L22)
  // Each as vec3<f32>; uniform layout pads vec3 to vec4, so this is
  // 9 vec4 + 1 vec4 control slot = 160 bytes total (matches the JS
  // `defaultSHBuffer` allocation in WebGPUModelPipelineCache).
  c0: vec4<f32>,
  c1: vec4<f32>,
  c2: vec4<f32>,
  c3: vec4<f32>,
  c4: vec4<f32>,
  c5: vec4<f32>,
  c6: vec4<f32>,
  c7: vec4<f32>,
  c8: vec4<f32>,
  // .w == 1.0 when SH is active (model.imageBasedLighting set
  // `sphericalHarmonicCoefficients`); else fall back to cubemap.
  control: vec4<f32>,
};
@group(1) @binding(36) var<uniform> sh: SHUniforms;

// NEW-MODEL-IBL-BRDF-LUT (Batch 287) — split-sum environment BRDF
// integration LUT (rg32float 256×256, produced once by
// `WebGPUBrdfLutGenerator`). R = scale factor for F0, G = bias, indexed
// by (NdotV, roughness). Consumed in the specular-IBL term as
// `radiance * (FssEss = F0 * scale + bias)` to match WebGL's
// `computeSpecularIBL`/`textureIBL` (ImageBasedLightingStageFS.glsl).
// rg32float is non-filterable without `float32-filterable`, so the
// sampler at binding 38 is non-filtering; the table is smooth enough
// that nearest sampling is visually indistinct.
@group(1) @binding(37) var brdfLutTexture: texture_2d<f32>;
@group(1) @binding(38) var brdfLutSampler: sampler;

// ─── Effects bind group (shadow receive + clipping + atmosphere + CSM) ───
// NEW-BG-CONSOLIDATION (2026-04-30): effects binds at @group(3),
// matching the slot the globe terrain renderer uses for the same
// shared BGL. Was @group(7) prior; consolidation merged Model's other
// groups (camera kept at 0; material+textures+featureId merged into 1;
// skinning+morphTarget+instancing merged into 2; effects to 3) so the
// pipeline layout fits within spec-default `maxBindGroups: 4`. Struct
// layout MUST match the 480-byte EffectsUniforms in
// WebGPUEffectsBindGroup.js (size bumped from 336 → 480 in Batch 160 to
// carry polygon-clipping atlas control + per-extent UV remap).
struct EffectsUniforms {
  shadowMatrix: mat4x4<f32>,
  shadowMapSize: vec2<f32>,
  shadowDarkness: f32,
  shadowSoftShadows: f32,
  clippingPlaneCount: u32,
  clippingUnionMode: u32,
  clippingEdgeWidth: f32,
  clippingPolygonCount: u32,
  clippingEdgeColor: vec4<f32>,
  clipPlaneEqHW: array<vec4<f32>, 8>,
  // Unused by models but required for struct size parity.
  atmosphereLutControl: vec4<f32>,
  // .x = csmEnabled flag (1.0 → route through CSM path).
  csmControl: vec4<f32>,
  // C-R8-EDGE-INLINE control. .x = edgeReady (gate the inline stage),
  // .y = isEdgePass (always 0 from Model FS — kept for parity with
  // future caller-driven gating), .z/.w = currentFrustum near/far.
  edgeControl: vec4<f32>,
  // .xy = viewport (px), .z = relative depth tolerance, .w =
  // hasEdgeFeatureId flag.
  edgeViewport: vec4<f32>,
  // C-R10-POINT-LIGHT-RECEIVE — point-light cube shadow control.
  // .x = enabled flag (>0.5 routes the receive shader through the
  //      cube path; checked BEFORE the CSM gate so it takes priority
  //      when both happen to be set — only one shadow map is active
  //      at a time in Cesium, so this only matters during transitions).
  // .y = farPlane (`shadowMap._pointLightRadius`, meters).
  // .z = nearPlane (=1.0 for `computeOmnidirectional`, kept explicit
  //      so future tunable-near callers don't need a UBO bump).
  // .w = depthBias (subtracted from refDepth before the comparison
  //      sample to suppress shadow acne — same role as
  //      `pointBias.depthBias` in the WebGL ShadowMap pipeline).
  pointLightControl: vec4<f32>,
  // .xyz = world-space light position (meters; absolute world coords,
  // not camera-relative). The receive shader reconstructs `fragWC =
  // cameraPositionWC + (modelMatrix * vec4(rteMC, 0)).xyz` and computes
  // `direction = fragWC - lightWC`.
  // .w = PCF radius (Batch 63). Units are cube-face texels — the
  //      receive shader scales the perturbation by `1.0 / shadowMapSize.x`
  //      to convert texels → unit-direction offsets. 0.0 means hard
  //      sampling (single tap, identical to Batch 57's behavior); >0
  //      activates the 5-tap cross PCF kernel. Not the same role as
  //      `effects.shadowDarkness` — darkness drives `mix()` in the
  //      caller; pcfRadius drives kernel width here.
  pointLightPositionWC: vec4<f32>,
  // Batch 160 — AUDIT_2026_05_02 A.6 NEW-MODEL-CLIPPING-POLYGONS.
  // Polygon-clipping atlas control + per-extent UV remap.
  // .x = extentsCount (number of merged-extent groups in the SDF atlas;
  //      polygons whose spherical bounding rectangles overlap are
  //      coalesced into one group on the CPU — see
  //      `ClippingPolygonCollection.getExtents`).
  // .y = atlas inverse dimension precomputed on the JS side
  //      (1.0 / dim where dim = ceil(log2(extentsCount)) for >2,
  //      else extentsCount). Saves a per-fragment log2.
  // .z, .w = reserved.
  clippingPolygonControl: vec4<f32>,
  // 8 merged-extent groups, each packed as (south, west, invLatRange,
  // invLonRange) — same layout as `ClippingPolygonCollection._extentsFloat32View`.
  // Indexed by region (= atlas slot). Fragments outside an extent's
  // padded rectangle are not clipped by that group; the loop in
  // `modelClipByPolygon` picks the first containing group.
  clippingPolygonExtents: array<vec4<f32>, 8>,
};

// CSM cascade parameters (bindings 10/11). Layout matches
// `WebGPUCSMRenderer._cascadeParamsData` (272 floats, 1088 bytes).
// The VP matrices are RTE-aware — multiply by world-space camera-relative
// position (derived in FS from `input.rteMC` rotated through the model
// matrix). Placeholder zero-filled when CSM is off; the shader gates on
// `effects.csmControl.x > 0.5` before sampling.
struct CSMParams {
  cascadeVP0: mat4x4<f32>,
  cascadeVP1: mat4x4<f32>,
  cascadeVP2: mat4x4<f32>,
  cascadeVP3: mat4x4<f32>,
  cascadeSplits: vec4<f32>,
  blendBands: vec4<f32>,
  cascadeMinBias: vec4<f32>,
  cascadeMaxSlopeBias: vec4<f32>,
};

@group(3) @binding(0) var<uniform> effects: EffectsUniforms;
@group(3) @binding(1) var shadowDepthTex: texture_depth_2d;
@group(3) @binding(2) var shadowCompSampler: sampler_comparison;
@group(3) @binding(3) var clippingPlaneTex: texture_2d<f32>;
@group(3) @binding(4) var clippingPlaneSampler: sampler;
// AUDIT_2026_05_02 A.6 — clipping polygon SDF binding. Generated by
// `WebGPUClippingPolygonCollection.computePolygonSDF` (PolygonSignedDistance.wgsl
// compute pass) into a 256×256 r32float atlas. SDF encoding: 0.5 = on
// edge, < 0.5 = inside polygon, > 0.5 = outside. Models sample this in
// `modelClipByPolygon` to discard fragments outside the polygon's
// kept region (CesiumJS default — fragments INSIDE polygons are
// clipped on the globe, but for models we follow the same flow as
// `Shaders/Model/ModelClippingPolygonsStageFS.glsl` which discards
// fragments OUTSIDE the polygon).
@group(3) @binding(5) var clippingPolygonTex: texture_2d<f32>;
@group(3) @binding(6) var clippingPolygonSampler: sampler;
// FEAT-GAP-09 — Aerial-perspective LUT. Bindings 7/8/9 are populated by
// WebGPUEffectsBindGroup.js when the atmosphere LUT is active; otherwise
// they resolve to 1×1 placeholder textures. Gated by
// `effects.atmosphereLutControl.x > 0.5` in fragmentMain. Note: this
// shader's own group-2 bindings 7/8/9 are the PBR occlusion/emissive
// textures (different group), so there's no collision.
@group(3) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(3) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(3) @binding(9) var atmosphereLutSampler: sampler;
@group(3) @binding(10) var<uniform> csmParams: CSMParams;
@group(3) @binding(11) var cascadeDepthArray: texture_depth_2d_array;
// C-R8-EDGE-INLINE — inline edge-detection resources. The edge MRT
// views populate at the start of `_execute3DTilePasses` (before the
// model's OPAQUE pass); the globe packed-depth view is produced by
// `WebGPUGlobeDepth.executeCopyDepth` even earlier. Sampler at 16 is
// shared filtering. Gated at call site on `effects.edgeControl.x > 0.5`
// so dead bindings (placeholder 1×1 transparent textures) never
// influence the lit fragment.
@group(3) @binding(12) var edgeColorTex: texture_2d<f32>;
@group(3) @binding(13) var edgeIdTex: texture_2d<f32>;
@group(3) @binding(14) var edgeDepthTex: texture_2d<f32>;
@group(3) @binding(15) var globeDepthTex: texture_2d<f32>;
@group(3) @binding(16) var edgeSampler: sampler;
// C-R10-POINT-LIGHT-RECEIVE — 6-face cube depth populated by
// `_renderPointLightCubeCastPasses` in WebGPUShadowMapRenderer. Sampled
// via `samplePointShadow` below when `effects.pointLightControl.x > 0.5`.
// Reuses `shadowCompSampler` at binding 2 for the comparison sample.
// Placeholder is a 1×1×6 cube cleared to 1.0 (depth = far plane → no
// occluder closer than the light radius → fragment is lit by default).
@group(3) @binding(17) var pointLightCubeDepth: texture_depth_cube;

// ─── Vertex Shader ───────────────────────────────────────────────────────────

struct VertexInput {
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
  @location(0) positionMC: vec3<f32>,
  @location(1) normalMC: vec3<f32>,
  @location(2) tangentMC: vec4<f32>,
  @location(3) texCoord0: vec2<f32>,
  @location(4) color0: vec4<f32>,
  @location(5) joints0: vec4<u32>,
  @location(6) weights0: vec4<f32>,
  // texCoord1 -- glTF textures carry a per-texture texCoord: 0|1 flag;
  // occlusion and clearcoat-normal commonly use UV set 1. Wrapped in
  // `//>>ifdef MODEL_HAS_TEXCOORD_1` (Session 62 NEW-VR-VERTEX-BUFFER-VARIANT)
  // so primitives without TEXCOORD_1 don't allocate a vertex buffer
  // slot for it — fits Edge's `maxVertexBuffers = 8` adapter cap. The
  // FS reads of `input.texCoord1` are also wrapped, falling back to
  // `texCoord0` when the attribute isn't bound.
  //>>ifdef MODEL_HAS_TEXCOORD_1
  @location(7) texCoord1: vec2<f32>,
  //>>endif
  // Audit B.2 (Batch 130) -- per-vertex feature ID (b3dm _BATCHID
  // renamed to _FEATURE_ID_0 by the loader). f32 cast for
  // varying-friendly transport; the FS converts back to u32 for the
  // batch / pick texture lookup. The FS gates the read on
  // `FLAG_HAS_FEATURE_ID_ATTRIBUTE` so the zero default never reaches
  // the lookup when no feature ID is present.
  //
  // Session 65 follow-up — variant-conditional. When the primitive has
  // no `_FEATURE_ID_0` / `_BATCHID` accessor the pipeline omits vertex
  // buffer slot 8 (see `createVertexBufferLayout` in
  // `WebGPUModelPipelineCache.js`) and this declaration is stripped so
  // the WGSL stays in sync with the bound buffer count. Most standard
  // glTF models lack feature IDs, so this removes the eighth vertex
  // slot from the common-case pipeline — fits Edge's 8-slot adapter
  // cap with headroom.
  //>>ifdef MODEL_HAS_FEATURE_ID_0
  @location(8) featureId0: f32,
  //>>endif
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) positionEC: vec3<f32>,
  @location(1) normalEC: vec3<f32>,
  @location(2) texCoord0: vec2<f32>,
  @location(3) color0: vec4<f32>,
  @location(4) tangentEC: vec3<f32>,
  @location(5) bitangentEC: vec3<f32>,
  //>>ifdef MODEL_HAS_TEXCOORD_1
  @location(6) texCoord1: vec2<f32>,
  //>>endif
  // Model-space RTE vector: `(positionMC - encodedCameraPositionMC_high)
  // + (- encodedCameraPositionMC_low)`. The fragment shader rotates it
  // into world-space RTE via `material.modelMatrix * vec4(rteMC, 0.0)`
  // for CSM cascade sampling. Kept in model space through the varying
  // so interpolation stays precise at Earth scale — rotating in FS is
  // a single mat4*vec4 per fragment and preserves the RTE cancellation.
  @location(7) rteMC: vec3<f32>,
  // TAA Slice 2c (Batch 96) — previous-frame and matched-current clip
  // positions for per-model motion-vector reconstruction. The current
  // clip pos is the SAME value `output.position` already holds, but
  // duplicating it here keeps the prev-frame reprojection self-
  // contained when MRT velocity output is enabled (so no juggle of
  // `output.position` semantics). Both are in homogeneous clip space;
  // FS divides by .w before the screen-space delta.
  @location(8) previousClipPos: vec4<f32>,
  @location(9) currentClipPosForVelocity: vec4<f32>,
  // Audit B.2 (Batch 130) -- @interpolate(flat) so each fragment sees
  // its provoking vertex's integer feature ID without averaging across
  // the triangle. The FS converts back to u32 with `u32(featureId0)`.
  @location(10) @interpolate(flat) featureId0: f32,
  //>>ifdef LOG_DEPTH
  // Interpolated linear depthFromNearPlusOne; FS converts to frag_depth.
  @location(11) v_logDepth: f32,
  //>>endif
};

@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  var positionMC = input.positionMC;
  var normalMC = input.normalMC;
  var tangentMC = input.tangentMC;

  // ── Morph Targets ─────────────────────────────────────────────────────────
  // Must happen BEFORE skinning per glTF spec: morph → skin → RTE.
  // Reads weighted position + normal deltas from the storage buffer, indexed by
  // vertex_index. DP-H35 (Batch 329): the storage buffer now interleaves a
  // [positionDelta, normalDelta] vec4 pair per vertex per target, so morphed
  // normals re-shade the deformed surface (WebGL morphs normals via
  // getMorphedNormal; WebGPU previously froze them at the rest pose → frozen
  // lighting on a morph-animated mesh). Normal accumulation is ADDITIVE and a
  // no-op for targets with no NORMAL accessor (their packed delta is zero).
  var morphedNormal = false;
  if (hasFlag(material.materialFlags, FLAG_HAS_MORPH_TARGETS)) {
    let targetCount = u32(morphWeights.targetCount);
    let vertexCount = u32(morphWeights.vertexCount);
    let vid = input.vertexIndex;

    for (var t = 0u; t < targetCount; t = t + 1u) {
      // Weight for this target from the packed vec4 arrays
      let w = select(morphWeights.weights0[t], morphWeights.weights1[t - 4u], t >= 4u);
      if (abs(w) > 0.0001) {
        let base = (t * vertexCount + vid) * 3u;
        let posDelta = morphDeltas[base].xyz;
        let nrmDelta = morphDeltas[base + 1u].xyz;
        let tanDelta = morphDeltas[base + 2u].xyz;
        positionMC = positionMC + posDelta * w;
        normalMC = normalMC + nrmDelta * w;
        // C2-4: accumulate the morph TANGENT delta (xyz; .w handedness preserved)
        // so a normal-mapped morphed mesh re-derives its tangent frame, matching
        // WebGL getMorphedTangent. Zero for targets/models without TANGENT.
        tangentMC = vec4<f32>(tangentMC.xyz + tanDelta * w, tangentMC.w);
        morphedNormal = true;
      }
    }
  }
  // glTF morphed normals are not guaranteed unit-length after the weighted
  // accumulation; re-normalize so downstream lighting (and the skinning
  // matrix3 transform below) operates on a unit normal. Guard against a
  // degenerate (near-zero) result so we don't emit NaNs.
  if (morphedNormal) {
    let nlen = length(normalMC);
    if (nlen > 1e-6) {
      normalMC = normalMC / nlen;
    }
  }

  // ── Skinning ──────────────────────────────────────────────────────────────
  // When FLAG_HAS_SKINNING is set, apply joint matrix weighted blend to
  // position, normal, and tangent. Matches the GLSL SkinningStageVS.glsl logic:
  //   skinMatrix = w.x * J[j.x] + w.y * J[j.y] + w.z * J[j.z] + w.w * J[j.w]
  if (hasFlag(material.materialFlags, FLAG_HAS_SKINNING)) {
    let j = input.joints0;
    let w = input.weights0;
    let skinMatrix = w.x * jointMatrices[j.x]
                   + w.y * jointMatrices[j.y]
                   + w.z * jointMatrices[j.z]
                   + w.w * jointMatrices[j.w];
    let skinMatrix3 = mat3x3<f32>(skinMatrix[0].xyz, skinMatrix[1].xyz, skinMatrix[2].xyz);
    positionMC = (skinMatrix * vec4<f32>(positionMC, 1.0)).xyz;
    normalMC = skinMatrix3 * normalMC;
    tangentMC = vec4<f32>(skinMatrix3 * tangentMC.xyz, tangentMC.w);
  }

  // ── GPU Instancing ────────────────────────────────────────────────────────
  // When FLAG_HAS_INSTANCING is set, apply the per-instance transform from
  // the storage buffer. This positions each instance in model space.
  // Applied AFTER morph/skinning, BEFORE RTE (matches glTF EXT_mesh_gpu_instancing spec).
  //
  // DP-H36 (Batch 325) — only the LINEAR part (rotation+scale, `linear`'s
  // col3 is zeroed on the CPU) multiplies the local vertex position here;
  // the per-instance TRANSLATION is carried as a high/low pair and folded
  // into the RTE subtract below instead of being added in f32. Adding the
  // full Earth-scale translation to the local position in single precision
  // (the old `instMat * pos` path) lost ~1 m before the camera could cancel
  // it → stationary-camera i3dm jitter. Keeping `positionMC` at local
  // magnitude through the RTE subtract preserves sub-meter precision.
  var instTransHigh = vec3<f32>(0.0);
  var instTransLow = vec3<f32>(0.0);
  if (hasFlag(material.materialFlags, FLAG_HAS_INSTANCING)) {
    let inst = instanceTransforms[input.instanceIndex];
    let linear3 = mat3x3<f32>(inst.linear[0].xyz, inst.linear[1].xyz, inst.linear[2].xyz);
    positionMC = linear3 * positionMC;
    normalMC = linear3 * normalMC;
    tangentMC = vec4<f32>(linear3 * tangentMC.xyz, tangentMC.w);
    instTransHigh = inst.translationHigh.xyz;
    instTransLow = inst.translationLow.xyz;
  }

  // RTE in model space: camera is encoded in model coords via inverse(modelMatrix).
  // For instanced geometry the per-instance translation (high/low) is the
  // large-magnitude term, so it is differenced against the encoded camera in
  // the split domain (translateRelativeToEye); the local `positionMC` (linear
  // part only) is small and added after the cancellation.
  let rte = (instTransHigh - camera.encodedCameraPositionMCHigh)
          + (instTransLow - camera.encodedCameraPositionMCLow)
          + positionMC;

  output.position = camera.mvpRelativeToEye * vec4<f32>(rte, 1.0);
  output.positionEC = (camera.modelViewRelativeToEye * vec4<f32>(rte, 1.0)).xyz;
  output.rteMC = rte;
  output.normalEC = normalize((camera.normalMatrix * vec4<f32>(normalMC, 0.0)).xyz);
  output.texCoord0 = input.texCoord0;
  //>>ifdef MODEL_HAS_TEXCOORD_1
  output.texCoord1 = input.texCoord1;
  //>>endif
  output.color0 = input.color0;

  // Tangent/Bitangent for normal mapping
  let tangentEC3 = normalize((camera.normalMatrix * vec4<f32>(tangentMC.xyz, 0.0)).xyz);
  output.tangentEC = tangentEC3;
  output.bitangentEC = cross(output.normalEC, tangentEC3) * tangentMC.w;

  // Audit A.5 (Batch 130) + re-review (Batch 134) -- compute
  // prevPositionMC by re-running the morph -> skin -> instance
  // pipeline with PREV-FRAME data on every stage:
  //   - morph weights from `previousMorphWeights` (binding 5,
  //     NEW-TAA-MORPH-PREV)
  //   - joint matrices from `previousJointMatrices` (binding 4)
  //   - instance transforms from `previousInstanceTransforms`
  //     (binding 6, NEW-TAA-INSTANCE-PREV)
  // For rigid (non-skinned, non-morphed, non-instanced) models, all
  // three prev buffers default to their CURRENT counterparts so
  // prevPositionMC equals positionMC and velocity captures only the
  // model-matrix delta + camera motion. Animated rigs now produce
  // the correct per-vertex motion vector across the full deformation
  // pipeline.
  var prevPositionMC = input.positionMC;
  if (hasFlag(material.materialFlags, FLAG_HAS_MORPH_TARGETS)) {
    let targetCount = u32(previousMorphWeights.targetCount);
    let vertexCount = u32(previousMorphWeights.vertexCount);
    let vid = input.vertexIndex;
    for (var t = 0u; t < targetCount; t = t + 1u) {
      let w = select(
        previousMorphWeights.weights0[t],
        previousMorphWeights.weights1[t - 4u],
        t >= 4u,
      );
      if (abs(w) > 0.0001) {
        // The storage buffer interleaves [pos, nrm, tan] triples (C2-4) — step
        // the same *3u stride as the current-frame block; the prev-frame
        // velocity path only needs the POSITION delta (base + 0).
        let base = (t * vertexCount + vid) * 3u;
        let delta = morphDeltas[base].xyz;
        prevPositionMC = prevPositionMC + delta * w;
      }
    }
  }
  if (hasFlag(material.materialFlags, FLAG_HAS_SKINNING)) {
    let j = input.joints0;
    let w = input.weights0;
    let prevSkinMatrix = w.x * previousJointMatrices[j.x]
                       + w.y * previousJointMatrices[j.y]
                       + w.z * previousJointMatrices[j.z]
                       + w.w * previousJointMatrices[j.w];
    prevPositionMC = (prevSkinMatrix * vec4<f32>(prevPositionMC, 1.0)).xyz;
  }
  if (hasFlag(material.materialFlags, FLAG_HAS_INSTANCING)) {
    // DP-H36 (Batch 325) — reconstruct the full prev-frame model-space
    // position from the split struct. This prev path multiplies by
    // `previousModelMatrix` (full-magnitude, non-RTE) below, so the
    // translation is recombined as a full f32 position here; the residual
    // ~1 m precision loss is irrelevant for motion vectors, and for static
    // instancing the prev buffer aliases the current one so the instancing
    // contribution to velocity is zero regardless.
    let prevInst = previousInstanceTransforms[input.instanceIndex];
    let prevLinear3 = mat3x3<f32>(
      prevInst.linear[0].xyz, prevInst.linear[1].xyz, prevInst.linear[2].xyz);
    prevPositionMC = prevLinear3 * prevPositionMC
                   + prevInst.translationHigh.xyz + prevInst.translationLow.xyz;
  }

  // TAA Slice 2c (Batch 96) -- previous- and current-frame world
  // positions feed the FS reprojection. Both go through the
  // unencoded-position * matrix path (RTE is a current-frame
  // optimization that the prev-frame matmul doesn't share).
  let worldPosCurrent = material.modelMatrix * vec4<f32>(positionMC, 1.0);
  let worldPosPrevious =
    material.previousModelMatrix * vec4<f32>(prevPositionMC, 1.0);
  output.previousClipPos =
    camera.previousViewProjection * worldPosPrevious;
  output.currentClipPosForVelocity =
    camera.mvpRelativeToEye * vec4<f32>(rte, 1.0);

  // Audit B.2 (Batch 130) -- pass per-vertex feature ID through to
  // FS as a flat-interpolated varying. The provoking-vertex's value
  // wins for the entire triangle, which matches the per-feature
  // semantics (a feature spans whole triangles, never crosses).
  //
  // Session 65 follow-up — variant-conditional on MODEL_HAS_FEATURE_ID_0.
  // When the primitive has no feature ID accessor (the common case
  // for standard glTF models without batching), slot 8 is omitted from
  // the vertex layout and `input.featureId0` doesn't exist, so we hand
  // the FS a zero default. The FS only reads `featureId0` when
  // `FLAG_HAS_FEATURE_ID_ATTRIBUTE` is set in `material.materialFlags`,
  // so the default never reaches a lookup.
  //>>ifdef MODEL_HAS_FEATURE_ID_0
  output.featureId0 = input.featureId0;
  //>>else
  output.featureId0 = 0.0;
  //>>endif

  //>>ifdef LOG_DEPTH
  // Renderer-wide log depth — interpolate the linear depthFromNearPlusOne
  // and clamp clip-z so huge far/near ratios can't clip the vertex before
  // the FS writes log depth. Shared by every fragment entry point of this
  // module (color/pick/velocity/classification); only entries that write
  // frag_depth consume the varying.
  output.v_logDepth = csm_vertexLogDepth(output.position, camera.logDepthNear);
  output.position = csm_updatePositionDepth(output.position);
  //>>endif

  return output;
}

// ─── PBR Helper Functions ────────────────────────────────────────────────────

const PI: f32 = 3.14159265358979323846;

fn hasFlag(flags: u32, flag: u32) -> bool {
  return (flags & flag) != 0u;
}

fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 0.0001);
}

fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k + 0.0001);
}

fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
}

fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
  let t = clamp(1.0 - cosTheta, 0.0, 1.0);
  let t2 = t * t;
  return F0 + (vec3<f32>(1.0) - F0) * (t2 * t2 * t);
}

// NEW-MODEL-DIRECT-BRDF-PARITY (Batch 355) -- height-correlated Smith-joint
// visibility (Heitz 2014), byte-faithful to WebGL `pbrLighting.glsl`
// smithVisibilityGGX. Returns Vis = G / (4·NdotL·NdotV): the 1/(4·NdotL·NdotV)
// denominator is FOLDED IN, so callers multiply D·Vis·F with NO separate
// /(4·NdotV·NdotL) term. `alphaRoughness` = perceptualRoughness² (the same
// convention WebGL passes). Replaces the separable Schlick-GGX `geometrySmith`
// on the direct-light paths (clearcoat keeps geometrySmith).
fn smithVisibilityGGX(alphaRoughness: f32, NdotL: f32, NdotV: f32) -> f32 {
  let aSq = alphaRoughness * alphaRoughness;
  let GGXV = NdotL * sqrt(NdotV * NdotV * (1.0 - aSq) + aSq);
  let GGXL = NdotV * sqrt(NdotL * NdotL * (1.0 - aSq) + aSq);
  let GGX = GGXV + GGXL;
  if (GGX > 0.0) {
    return 0.5 / GGX;
  }
  return 0.0;
}

// NEW-MODEL-DIRECT-BRDF-PARITY (Batch 355) -- Fresnel-Schlick with an explicit
// f90 reflectance, byte-faithful to WebGL `pbrLighting.glsl` fresnelSchlick2.
// The direct-light paths pass f90 = clamp(maxComponent(F0)·25, 0, 1) so
// near-zero-reflectance dielectrics taper their grazing response instead of
// the bare `fresnelSchlick`'s implicit f90 = 1 (always white at grazing).
fn fresnelSchlick2(f0: vec3<f32>, f90: vec3<f32>, VdotH: f32) -> vec3<f32> {
  let versine = clamp(1.0 - VdotH, 0.0, 1.0);
  let v2 = versine * versine;
  return f0 + (f90 - f0) * (v2 * v2 * versine);
}

// Roughness-aware Fresnel for IBL specular — smoother surfaces reflect more
fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
  let t = clamp(1.0 - cosTheta, 0.0, 1.0);
  let t2 = t * t;
  let oneMinusRoughness = vec3<f32>(1.0 - roughness);
  return F0 + (max(oneMinusRoughness, F0) - F0) * (t2 * t2 * t);
}

// Audit A.9 (Batch 130) -- L2 spherical-harmonic irradiance.
// 9 coefficients (3 bands) provide a low-frequency analytic
// approximation of diffuse irradiance from any direction; cheaper
// than a 32x32 cubemap convolution sample, sufficient for ambient
// lighting that doesn't carry high-frequency detail. Coefficient
// order matches the WebGL `ImageBasedLightingPipelineStage` packing
// so authors can supply the same SH set across both backends.
fn evalSphericalHarmonics(N: vec3<f32>) -> vec3<f32> {
  var c = sh.c0.xyz;
  c = c + sh.c1.xyz * N.y;
  c = c + sh.c2.xyz * N.z;
  c = c + sh.c3.xyz * N.x;
  c = c + sh.c4.xyz * (N.x * N.y);
  c = c + sh.c5.xyz * (N.y * N.z);
  c = c + sh.c6.xyz * (3.0 * N.z * N.z - 1.0);
  c = c + sh.c7.xyz * (N.z * N.x);
  c = c + sh.c8.xyz * (N.x * N.x - N.y * N.y);
  return max(c, vec3<f32>(0.0));
}

fn srgbToLinear(srgb: vec3<f32>) -> vec3<f32> {
  return pow(srgb, vec3<f32>(2.2));
}

// Khronos PBR Neutral tonemap — matches WebGL czm_pbrNeutralTonemapping
// (packages/engine/Source/Shaders/Builtin/Functions/pbrNeutralTonemapping.glsl).
// Identity for input <= 0.76; gentle peak compression with desaturation
// preservation above. Replaces an earlier Reinhard implementation that
// crushed mid-tones (RGB 0.5 -> 0.333) and produced visibly washed-out
// glTF models compared to WebGL where the WebGL LightingStageFS applies
// the Khronos curve when HDR is off.
fn pbrNeutralTonemap(color: vec3<f32>) -> vec3<f32> {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;
  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  var c = color - vec3<f32>(offset);
  let peak = max(c.r, max(c.g, c.b));
  if (peak < startCompression) { return c; }
  let d = 1.0 - startCompression;
  let newPeak = 1.0 - d * d / (peak + d - startCompression);
  c = c * (newPeak / peak);
  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(c, vec3<f32>(newPeak), vec3<f32>(g));
}

fn tonemapAndGamma(color: vec3<f32>) -> vec3<f32> {
  // WebGL LightingStageFS applies tonemap + linearToSrgb only when HDR
  // is OFF (the default). HDR is currently always-off in the active
  // WebGPU paths, so this is unconditional here. When HDR plumbing
  // lands, gate both the tonemap and the gamma on the HDR flag.
  let mapped = pbrNeutralTonemap(max(color, vec3<f32>(0.0)));
  return pow(mapped, vec3<f32>(1.0 / 2.2));
}

// Raw screen-space tangent direction + UV-jacobian determinant for the
// tangent-less normal-mapping fallback (Slice 5d Batch 159). MUST be called
// from uniform control flow — it contains derivative built-ins (dpdx/dpdy),
// which WGSL forbids in non-uniform control flow. `perturbNormal` is reached
// through non-uniform branches (the double-sided `frontFacing` flip, the
// unlit early-out), so the derivatives can't live inside it; instead this is
// invoked once at the uniform entry of `fragmentMain` (mirroring the hoisted
// `edgePixelStep = fwidth(...)`) and the result is passed down.
//
// The formula is WebGL's computeTangent() in MaterialStageFS.glsl (the
// glTF-sample-viewer method); the orthogonalization + handedness happen in
// `perturbNormal` so the two backends agree on the normal-map green-channel
// sign and the WebGL↔WebGPU diff over a tangent-less asset stays tight.
// Returns xyz = raw tangent direction (pre-orthogonalization, pre-divide),
// w = UV-jacobian determinant (used both to finish the divide and to detect
// degenerate UV gradients).
fn deriveTangentRaw(posEC: vec3<f32>, uv: vec2<f32>) -> vec4<f32> {
  let texDx = dpdx(uv);
  let texDy = dpdy(uv);
  let det = texDx.x * texDy.y - texDy.x * texDx.y;
  let tRaw = texDy.y * dpdx(posEC) - texDx.y * dpdy(posEC);
  return vec4<f32>(tRaw, det);
}

fn perturbNormal(nEC: vec3<f32>, tEC: vec3<f32>, bEC: vec3<f32>,
                 normalMap: vec3<f32>, scale: f32,
                 derivedTangent: vec4<f32>) -> vec3<f32> {
  let N = normalize(nEC);

  // Decode the tangent-space normal once — shared by whichever tangent
  // frame we end up using below.
  var tn = normalMap * 2.0 - vec3<f32>(1.0);
  tn = vec3<f32>(tn.xy * scale, tn.z);
  tn = normalize(tn);

  // ── Screen-space derivative tangent frame (Slice 5d Batch 159) ──────────
  // `derivedTangent` is the raw tangent + UV-jacobian determinant computed
  // by `deriveTangentRaw` at the uniform entry of `fragmentMain`. This is
  // the fallback for the case diagnosed in Batch 153: a glTF primitive can
  // declare a normal texture WITHOUT a TANGENT vertex accessor. The vertex
  // path then computes `tangentEC = normalize(normalMatrix * tangentMC)`
  // over a zero tangent → `normalize(vec3(0))` → NaN, so the tEC/bEC
  // reaching this function are NaN (not zero). Batch 153 fell back to the
  // flat geometric normal (lighting stayed correct but lost all normal-map
  // surface detail); this orthogonalizes the derived tangent against N and
  // takes `B = cross(N, T)` — byte-for-byte WebGL's computeTangent path —
  // so the detail is preserved with matching handedness. No derivatives
  // here: they were already taken in uniform control flow upstream.
  let det = derivedTangent.w;
  let tRaw = derivedTangent.xyz / det;
  let Td = normalize(tRaw - N * dot(N, tRaw));
  let Bd = normalize(cross(N, Td));

  // NaN-safe degeneracy test: `length(NaN)` is NaN and `NaN > 1e-4` is
  // false, so `!(len > 1e-4)` catches BOTH the zero-length case (len == 0)
  // AND the NaN case. A plain `len < 1e-4` would miss NaN (`NaN < 1e-4` is
  // also false) — the bug the Batch 153 guard originally had.
  let tlen = length(tEC);
  let blen = length(bEC);
  var T: vec3<f32>;
  var B: vec3<f32>;
  if (!(tlen > 1e-4) || !(blen > 1e-4)) {
    // No usable vertex tangent — use the derived screen-space frame.
    // Guard degenerate UV derivatives (det ≈ 0 → tRaw is non-finite): with
    // no UV gradient there is no recoverable tangent, so keep the flat
    // geometric normal (the Batch 153 behavior) rather than emit a NaN.
    if (!(abs(det) > 1e-10)) {
      return N;
    }
    T = Td;
    B = Bd;
  } else {
    // Precomputed vertex tangent frame present + finite.
    T = tEC / tlen;
    B = bEC / blen;
  }
  return normalize(T * tn.x + B * tn.y + N * tn.z);
}

// ─── Feature ID / Batch Texture Helpers ──────────────────────────────────────

// Unpacks a feature ID integer from 1-4 RGBA channel bytes (0-255 range).
// Mirrors czm_unpackUint in GLSL: r + g*256 + b*65536 + a*16777216
fn unpackFeatureId(channels: vec4<f32>, channelCount: i32) -> i32 {
  let r = i32(channels.r * 255.0 + 0.5);
  if (channelCount <= 1) { return r; }
  let g = i32(channels.g * 255.0 + 0.5);
  if (channelCount == 2) { return r + g * 256; }
  let b = i32(channels.b * 255.0 + 0.5);
  if (channelCount == 3) { return r + g * 256 + b * 65536; }
  let a = i32(channels.a * 255.0 + 0.5);
  return r + g * 256 + b * 65536 + a * 16777216;
}

// Looks up the batch texture color for a given feature ID.
// Handles single-line and multi-line batch texture layouts.
//
// Uses `textureSampleLevel(..., 0.0)` instead of `textureSample` because
// this function is called from non-uniform control flow (the batch
// sample depends on per-fragment featureId values). WGSL requires
// `textureSample` to be in uniform control flow; the *Level variants
// are exempt because they don't compute screen-space derivatives for
// mip selection.
fn lookupBatchColor(fid: i32) -> vec4<f32> {
  let step = featureId.textureStep;
  if (featureId.hasMultilineBatchTex != 0) {
    let dim = featureId.textureDimensions;
    let fidF = f32(fid);
    let st = vec2<f32>(
      (floor(fidF / dim.x) + 0.5) / dim.y,
      (fidF - floor(fidF / dim.x) * dim.x + 0.5) / dim.x
    );
    return textureSampleLevel(batchTexture, batchSampler, st, 0.0);
  }
  // Single-line layout: feature ID maps to x coordinate
  let st = vec2<f32>(step.x * f32(fid) + step.y, 0.5);
  return textureSampleLevel(batchTexture, batchSampler, st, 0.0);
}

// C-R9-MODEL-FEATURE-PICK (Batch 100) — per-feature pick color lookup.
// Same layout/addressing as `lookupBatchColor` but reads from the
// per-feature pick texture instead. The pick FS calls this when
// `featureId.featurePickEnabled > 0.5` AND the batch table is bound.
fn lookupFeaturePickColor(fid: i32) -> vec4<f32> {
  let step = featureId.textureStep;
  if (featureId.hasMultilineBatchTex != 0) {
    let dim = featureId.textureDimensions;
    let fidF = f32(fid);
    let st = vec2<f32>(
      (floor(fidF / dim.x) + 0.5) / dim.y,
      (fidF - floor(fidF / dim.x) * dim.x + 0.5) / dim.x
    );
    return textureSampleLevel(featurePickTexture, featurePickSampler, st, 0.0);
  }
  let st = vec2<f32>(step.x * f32(fid) + step.y, 0.5);
  return textureSampleLevel(featurePickTexture, featurePickSampler, st, 0.0);
}

// ─── Fragment Shader ─────────────────────────────────────────────────────────

struct FragmentInput {
  @builtin(position) fragCoord: vec4<f32>,
  @location(0) positionEC: vec3<f32>,
  @location(1) normalEC: vec3<f32>,
  @location(2) texCoord0: vec2<f32>,
  @location(3) color0: vec4<f32>,
  @location(4) tangentEC: vec3<f32>,
  @location(5) bitangentEC: vec3<f32>,
  //>>ifdef MODEL_HAS_TEXCOORD_1
  @location(6) texCoord1: vec2<f32>,
  //>>endif
  @location(7) rteMC: vec3<f32>,
  // TAA Slice 2c (Batch 96) — interpolated previous- and current-frame
  // clip positions used for per-model motion-vector reconstruction.
  @location(8) previousClipPos: vec4<f32>,
  @location(9) currentClipPosForVelocity: vec4<f32>,
  // Audit B.2 (Batch 130) -- flat-interpolated per-feature ID
  // (b3dm _BATCHID). Read by fragmentMain (batch styling discard) +
  // fragmentPickMain (per-feature pick lookup) when
  // FLAG_HAS_FEATURE_ID_ATTRIBUTE is set.
  @location(10) @interpolate(flat) featureId0: f32,
  //>>ifdef LOG_DEPTH
  @location(11) v_logDepth: f32,
  //>>endif
  @builtin(front_facing) frontFacing: bool,
};

// TAA Slice 2c (Batch 96) — converts the interpolated current/previous
// clip-space positions into a screen-space velocity (NDC delta in
// [-1, 1] × [-1, 1] units). Returns vec2(0) when motion-vector output
// is disabled OR when either clip pos is degenerate (w <= 0). Caller
// is responsible for the @location(1) MRT plumbing — this helper is
// pure math, no side-effects on the FS color path.
fn computeMotionVectorScreenSpace(input: FragmentInput) -> vec2<f32> {
  if (material.motionFlags.x < 0.5) {
    return vec2<f32>(0.0);
  }
  let cur = input.currentClipPosForVelocity;
  let prev = input.previousClipPos;
  if (cur.w <= 0.0 || prev.w <= 0.0) {
    return vec2<f32>(0.0);
  }
  let curNdc = cur.xy / cur.w;
  let prevNdc = prev.xy / prev.w;
  // NDC delta. The TAA sampling path expects screen-space UV delta;
  // the @location(1) MRT consumer (slice 2d) will transform NDC →
  // [0, 1] UV with `(curNdc - prevNdc) * vec2(0.5, -0.5)`.
  return (curNdc - prevNdc) * material.motionFlags.y;
}

// ─── CSM cascade sampling ────────────────────────────────────────────────────
// Inlined from ShadowReceiveCSM.wgsl (the WGSL preprocessor's #include path
// isn't wired for this shader yet; sharing the file across receivers is
// tracked in CSM_DESIGN.md). Gated at call site on
// `effects.csmControl.x > 0.5` — the fragment shader only routes here
// when the scene has `useCascadedShadowMaps = true` AND the CSM renderer
// has a valid cascade texture. See PrimitivePhongTexturedColor.wgsl for
// the reference implementation — math is identical, only the RTE source
// differs (model shader rotates `rteMC` through the model matrix to get
// the world-space camera-relative vector that cascade VPs expect).

fn selectCascade(viewDepth: f32, splits: vec4<f32>) -> u32 {
  if (viewDepth < splits.x) { return 0u; }
  if (viewDepth < splits.y) { return 1u; }
  if (viewDepth < splits.z) { return 2u; }
  return 3u;
}

fn getCascadeVP(idx: u32) -> mat4x4<f32> {
  switch (idx) {
    case 0u: { return csmParams.cascadeVP0; }
    case 1u: { return csmParams.cascadeVP1; }
    case 2u: { return csmParams.cascadeVP2; }
    default: { return csmParams.cascadeVP3; }
  }
}

fn cascadeDepthBias(cascadeIdx: u32, normal: vec3<f32>, lightDir: vec3<f32>) -> f32 {
  let nDotL = clamp(dot(normalize(normal), normalize(lightDir)), 0.0, 1.0);
  let minBias = csmParams.cascadeMinBias[cascadeIdx];
  let maxSlope = csmParams.cascadeMaxSlopeBias[cascadeIdx];
  let slopeBias = maxSlope * (1.0 - nDotL);
  return max(minBias, slopeBias);
}

fn sampleOneCascade(eyePos: vec3<f32>, cascadeIdx: u32, depthBias: f32) -> f32 {
  let vp = getCascadeVP(cascadeIdx);
  let clipPos = vp * vec4<f32>(eyePos, 1.0);
  let ndc = clipPos.xyz / clipPos.w;
  let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
  let depth = ndc.z - depthBias;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ||
      depth > 1.0 || depth < 0.0) {
    return 1.0;
  }
  // CSM-PCF-SOFT: soften the cascade edge with a 3x3 PCF box kernel,
  // matching WebGL's czm_shadowVisibility USE_SOFT_SHADOWS path. The
  // kernel radius (in shadow texels) is effects.csmControl.y; 0 keeps
  // the original single hardware-comparison tap (hard edge).
  let csmPcfRadius = effects.csmControl.y;
  if (csmPcfRadius <= 0.0) {
    return textureSampleCompareLevel(
      cascadeDepthArray, shadowCompSampler, uv, i32(cascadeIdx), depth);
  }
  let csmDim = vec2<f32>(textureDimensions(cascadeDepthArray, 0));
  let csmTexel = csmPcfRadius / max(csmDim, vec2<f32>(1.0));
  var csmVis = 0.0;
  for (var sx: i32 = -1; sx <= 1; sx++) {
    for (var sy: i32 = -1; sy <= 1; sy++) {
      let csmOff = vec2<f32>(f32(sx), f32(sy)) * csmTexel;
      csmVis = csmVis + textureSampleCompareLevel(
          cascadeDepthArray, shadowCompSampler, uv + csmOff, i32(cascadeIdx), depth);
    }
  }
  return csmVis * (1.0 / 9.0);
}

fn sampleCascadeShadow(
  eyePos: vec3<f32>,
  viewDepth: f32,
  normal: vec3<f32>,
  lightDir: vec3<f32>,
) -> f32 {
  let cascadeIdx = selectCascade(viewDepth, csmParams.cascadeSplits);
  let bias0 = cascadeDepthBias(cascadeIdx, normal, lightDir);
  let s0 = sampleOneCascade(eyePos, cascadeIdx, bias0);
  let splitDist = csmParams.cascadeSplits[cascadeIdx];
  let blendBand = csmParams.blendBands[cascadeIdx];
  let blendStart = splitDist - blendBand;
  if (viewDepth > blendStart && cascadeIdx < 3u) {
    let nextIdx = cascadeIdx + 1u;
    let bias1 = cascadeDepthBias(nextIdx, normal, lightDir);
    let s1 = sampleOneCascade(eyePos, nextIdx, bias1);
    let blendT = smoothstep(blendStart, splitDist, viewDepth);
    return mix(s0, s1, blendT);
  }
  return s0;
}

fn computeShadowFactorCSM(
  eyePos: vec3<f32>,
  viewDepth: f32,
  normal: vec3<f32>,
  lightDir: vec3<f32>,
) -> f32 {
  if (effects.shadowDarkness >= 1.0) { return 1.0; }
  let visibility = sampleCascadeShadow(eyePos, viewDepth, normal, lightDir);
  return mix(effects.shadowDarkness, 1.0, visibility);
}

// ─── C-R10-POINT-LIGHT-RECEIVE — cube shadow sampling ───────────────────────
//
// Mirrors WebGL's USE_CUBE_MAP_SHADOW path (`shadowVisibility.glsl` +
// `shadowDepthCompare.glsl`) but adapted to WebGPU's `texture_depth_cube`
// + `textureSampleCompareLevel` semantics. The cast pipeline writes
// standard window-space depth (after `_depthRangeType = "webgpu"` produces
// a [0,1] z_ndc, the per-face camera's `getViewProjection()` further
// applies a NDC→texture scaleBias that compresses to [0.5, 1] before
// landing in the depth32float attachment) for each cube face using
// `near=1.0`, `far=lightRadius`, FOV=π/2 (see `computeOmnidirectional`
// in ShadowMapComputations.js). Receive math has to round-trip the
// SAME perspective-Z formula and apply the SAME scaleBias remap, otherwise
// every fragment compares unequal against the texel and the scene
// renders fully shadowed or fully lit by accident.
//
// Reference depth derivation (matches the WebGPU-mode perspective in
// `Matrix4.computePerspectiveFieldOfView` plus the trailing scaleBias
// matrix in `ShadowMap.js`):
//
//   For a fragment at world-space distance `d` from the light along
//   the dominant cube-face axis, z_eye = -d (looking down -Z in eye
//   space; the dominant axis projects perpendicular to its face).
//   The WebGPU-mode projection has:
//     col2[2] =  far / (near - far)
//     col3[2] =  near * far / (near - far)
//   z_clip = z_eye * col2[2] + col3[2]   (with col2[3] = -1 → w_clip = -z_eye = d)
//   z_ndc_webgpu = z_clip / w_clip
//                = (-d * far/(near-far) + near*far/(near-far)) / d
//                = far*(d - near) / (d * (far - near))            (after sign cleanup)
//                = far/(far-near) - far*near / (d * (far-near))
//   z_attached = z_ndc_webgpu * 0.5 + 0.5     (scaleBias remap)
//
// The cube sample direction must be in world space (NOT eye space) and
// matches `direction = fragWC - lightWC`. Magnitude is irrelevant —
// `textureSampleCompareLevel` normalizes internally for cube samplers.
//
// Per-fragment performance: one direction subtract, one max3 for the
// dominant axis, one division for the perspective-Z, one cube sample.
// Cheaper than CSM (no cascade loop, no eye-space → cascade-clip
// transform).
fn samplePointShadow(fragWC: vec3<f32>) -> f32 {
  let lightWC = effects.pointLightPositionWC.xyz;
  let direction = fragWC - lightWC;
  let absDir = abs(direction);
  // Dominant cube-face axis distance. `axisDist` is what the per-face
  // camera saw as |z_eye| for this fragment; the perspective-Z formula
  // below converts it to the depth value the cast pipeline wrote.
  let axisDist = max(absDir.x, max(absDir.y, absDir.z));
  let nearPlane = effects.pointLightControl.z;
  let farPlane = effects.pointLightControl.y;
  let depthBias = effects.pointLightControl.w;
  // Outside the cube's far plane → the cast pipeline never wrote a
  // depth here (or wrote 1.0 = cleared). Treat as fully lit. Without
  // this gate, a fragment beyond `farPlane` would compare its
  // ref > 1.0 against the cleared texel (1.0) and `compare: less`
  // would yield 0 (shadowed) — the wrong direction.
  if (axisDist >= farPlane) { return 1.0; }
  // Standard perspective-Z formula, WebGPU [0,1] convention. The
  // cast pipeline output values in this range too because Cesium
  // sets `Matrix4._depthRangeType = "webgpu"` at scene creation.
  let depthRange = farPlane - nearPlane;
  let zNdcWebGpu =
    farPlane / depthRange - (farPlane * nearPlane) / (axisDist * depthRange);
  // ShadowMap.js's `scaleBiasMatrix` post-multiplies the projection,
  // remapping z_ndc [-1,1] → [0,1] for WebGL OR z_ndc [0,1] → [0.5,1]
  // for WebGPU. Either way the cast path applied it, so the receive
  // path has to apply the same remap before the comparison sample to
  // round-trip correctly.
  let zAttached = zNdcWebGpu * 0.5 + 0.5;
  let refDepth = clamp(zAttached - depthBias, 0.0, 1.0);
  // Batch 63 — Soft point-light shadows via 5-tap cross PCF.
  //
  // `effects.pointLightPositionWC.w` carries the PCF radius in
  // cube-face texels (0 → hard sampling; the typical soft setting is
  // 1.0–2.0 texels). When the radius is zero we drop straight through
  // to the single comparison sample — identical performance + output
  // to Batch 57's hard-edge path.
  //
  // For radius > 0 we perturb the cube direction along the two MINOR
  // axes (the axes that AREN'T the dominant face axis). This keeps
  // the perturbation tangent to the cube face the dominant ray hits,
  // so all 5 samples sit on the same face's depth texels rather than
  // spilling into a neighboring face (which would compare against a
  // perspective-Z written by a different per-face camera and produce
  // banding at face seams).
  //
  // Perturbation magnitude: `radiusTexels * texelStep` where
  // `texelStep = 1.0 / shadowMapSize.x` — this converts a "1 texel"
  // request into a unit-direction offset on the unit cube. The cube
  // face is unit-sized in clip space so 1 texel = 1/N of a face.
  // The cube sampler normalizes the direction internally, so the
  // small perturbation cleanly biases which texel is sampled without
  // affecting which face is hit (radius is bounded well below the
  // dominant axis magnitude in any reasonable scene — even radius=4
  // texels at shadowMapSize=512 = 0.0078 unit-direction offset, vs
  // the dominant axis being normalized to ≥0.577).
  let pcfRadius = effects.pointLightPositionWC.w;
  if (pcfRadius <= 0.0) {
    return textureSampleCompareLevel(
      pointLightCubeDepth,
      shadowCompSampler,
      direction,
      refDepth,
    );
  }
  // Pick the two minor axes by checking which component is the
  // dominant. Each branch returns a pair of unit vectors tangent to
  // the dominant axis. Using axis-aligned tangents keeps the kernel
  // shape the same regardless of where on the face the ray lands —
  // a rotated kernel would shift the apparent shadow softness with
  // viewing angle.
  var minorA: vec3<f32>;
  var minorB: vec3<f32>;
  if (absDir.x >= absDir.y && absDir.x >= absDir.z) {
    // Dominant X face → tangent axes are Y and Z.
    minorA = vec3<f32>(0.0, 1.0, 0.0);
    minorB = vec3<f32>(0.0, 0.0, 1.0);
  } else if (absDir.y >= absDir.z) {
    // Dominant Y face → tangent axes are X and Z.
    minorA = vec3<f32>(1.0, 0.0, 0.0);
    minorB = vec3<f32>(0.0, 0.0, 1.0);
  } else {
    // Dominant Z face → tangent axes are X and Y.
    minorA = vec3<f32>(1.0, 0.0, 0.0);
    minorB = vec3<f32>(0.0, 1.0, 0.0);
  }
  // `shadowMapSize.x` carries the cube-face edge length (cast pipeline
  // sets it to the same value as the 2D path; for point lights this is
  // the per-face render-target size — typically 1024 or 2048). Falling
  // back to 1.0 / 1024.0 if shadowMapSize.x is zero (placeholder UB)
  // keeps the kernel scaled sensibly even before resources are wired.
  let texelStep = 1.0 / max(effects.shadowMapSize.x, 1.0);
  let offset = pcfRadius * texelStep;
  // 5-tap cross kernel — center + 4 perturbed taps along ±minorA / ±minorB.
  // The 9-tap version (center + 4 axial + 4 diagonal) is materially more
  // expensive on cube samplers because every comparison sample touches
  // the cube TLB; the 5-tap version captures most of the visual smoothing
  // for ~half the cost. Each comparison sample returns 0 or 1 (or a
  // PCF-filtered intermediate when the sampler is configured with
  // `comparison: less` and bilinear filtering — our `shadowCompSampler`
  // IS so configured); averaging the 5 results gives the visibility
  // factor.
  var sum = 0.0;
  sum = sum + textureSampleCompareLevel(
    pointLightCubeDepth,
    shadowCompSampler,
    direction,
    refDepth,
  );
  sum = sum + textureSampleCompareLevel(
    pointLightCubeDepth,
    shadowCompSampler,
    direction + minorA * offset,
    refDepth,
  );
  sum = sum + textureSampleCompareLevel(
    pointLightCubeDepth,
    shadowCompSampler,
    direction - minorA * offset,
    refDepth,
  );
  sum = sum + textureSampleCompareLevel(
    pointLightCubeDepth,
    shadowCompSampler,
    direction + minorB * offset,
    refDepth,
  );
  sum = sum + textureSampleCompareLevel(
    pointLightCubeDepth,
    shadowCompSampler,
    direction - minorB * offset,
    refDepth,
  );
  return sum * 0.2; // average of 5 taps
}

fn computeShadowFactorPointLight(fragWC: vec3<f32>) -> f32 {
  if (effects.shadowDarkness >= 1.0) { return 1.0; }
  let visibility = samplePointShadow(fragWC);
  return mix(effects.shadowDarkness, 1.0, visibility);
}

// ─── C-R8-EDGE-INLINE ─────────────────────────────────────────────────────
//
// Authoritative WGSL port of WebGL's `EdgeDetectionStageFS.glsl`. Runs
// inline inside the model fragment shader (see `applyEdgeOverlay`
// callsite in fragmentMain) so per-feature gating, edge color, and
// alpha all see the correct fragment context. Replaces the post-process
// overlay composite (`WebGPUEdgeComposite`) which couldn't access per-
// fragment featureId at composite time.
//
// Math notes:
//   * `unpackEdgeDepth` is the inverse of the WGSL `czm_packDepth`
//     scheme used by `WebGPUEdgeVisibilityEmitter` (8-bit RGBA →
//     normalised float). Globe depth uses the same packing scheme.
//   * `linearizeWindowDepth` mirrors WebGL's NDC-Z → linear-eye-Z math.
//     Geometry depth comes straight from `input.positionEC.z` (already
//     linear), no inverse-projection needed.
//   * `geomDepthLinear * 0.0005` relative tolerance widens the depth-
//     equality test as fragments get further from the camera. The
//     stage is robust against small jitter (anti-aliasing, sub-pixel
//     offsets) without bleeding edges over geometry that's clearly
//     in front.
//   * Background gate: when `geomDepthLinear > globeDepthLinear`,
//     the fragment is sky / above-globe and the edge is always drawn.
//     Otherwise (fragment is a 3D-tile surface), the edge composites
//     only when its depth matches the fragment's.
//
// Per-feature gating (C-R8-EDGE-FEATURE-ID):
//   When `effects.edgeViewport.w > 0.5`, the edge passes only over
//   matching feature IDs OR the background. Three drawEdge cases:
//     - background → always draw
//     - !hasEdgeFeature OR !hasCurrentFeature → draw (fail-open
//       semantics matching WebGL)
//     - featuresMatch → draw
//     - else → skip (different feature owns the edge → it belongs
//       to that feature, not this fragment)

fn unpackEdgeDepth(p: vec4<f32>) -> f32 {
  return dot(p, vec4<f32>(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}

fn linearizeWindowDepth(d: f32, near: f32, far: f32) -> f32 {
  let z_ndc = d * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z_ndc * (far - near));
}

fn applyEdgeOverlay(
  color: vec4<f32>,
  positionEC: vec3<f32>,
  fragCoordXY: vec2<f32>,
  currentFeatureId: f32,
  // Caller-supplied pixelStep (fwidth of linear depth). Hoisted to
  // uniform control flow at the top of fragmentMain because WGSL
  // requires `fwidth` to only run from uniform control flow, and
  // applyEdgeOverlay is called from inside the FLAG_IS_UNLIT branch
  // where the compiler can't prove the branch is uniform.
  pixelStep: f32,
) -> vec4<f32> {
  // Stage gate. `edgeControl.x` is 1.0 only when the emitter wrote MRT
  // outputs this frame AND the host renderer plumbed valid views into
  // the effects bind group. Otherwise the placeholder 1×1 transparent
  // textures bound at 12-15 keep the stage benign.
  if (effects.edgeControl.x <= 0.5) {
    return color;
  }
  // Reserved reverse-gate for future caller-driven flagging (e.g.,
  // pick passes that should skip overlay). Kept for parity with
  // WebGL's `if (u_isEdgePass) return;`.
  if (effects.edgeControl.y > 0.5) {
    return color;
  }

  let viewport = effects.edgeViewport.xy;
  if (viewport.x <= 1.0 || viewport.y <= 1.0) {
    return color;
  }
  let screenCoord = fragCoordXY / viewport;

  // pixelStep is now caller-supplied (see fn signature). The
  // geomDepthLinearEarly value is still needed locally for the
  // depth-delta calculation below.
  let geomDepthLinearEarly = abs(positionEC.z); // looking -Z in EC

  let edgeColor = textureSampleLevel(edgeColorTex, edgeSampler, screenCoord, 0.0);
  let edgeIdSample = textureSampleLevel(edgeIdTex, edgeSampler, screenCoord, 0.0);
  let edgeDepthPacked = textureSampleLevel(edgeDepthTex, edgeSampler, screenCoord, 0.0);
  let globeDepthPacked = textureSampleLevel(globeDepthTex, edgeSampler, screenCoord, 0.0);

  // No edge written here → leave the fragment alone. Mirrors the
  // implicit "edgeId.r > 0.0" gate in WebGL: if no emitter touched
  // this pixel, the rgba8 attachment is the cleared (0,0,0,0).
  if (edgeIdSample.r <= 0.0) {
    return color;
  }

  let near = effects.edgeControl.z;
  let far = effects.edgeControl.w;
  let edgeDepthWin = unpackEdgeDepth(edgeDepthPacked);
  let edgeDepthLinear = linearizeWindowDepth(edgeDepthWin, near, far);
  let geomDepthLinear = geomDepthLinearEarly;

  let depthDelta = abs(edgeDepthLinear - geomDepthLinear);
  let relTolerance = geomDepthLinear * effects.edgeViewport.z;
  let eps = max(near * 1e-4, max(pixelStep * 1.5, relTolerance));

  if (depthDelta >= eps) {
    return color;
  }

  // Background gating uses globe packed depth — when no globe pixel
  // covers this screen position the unpack returns 0 (cleared
  // attachment). Treating "globe depth zero" as "no globe here →
  // fragment is in front" matches the WebGL semantics: any fragment
  // whose linear depth is past the cleared globe surface is rendered
  // on top of the sky / outside the globe horizon.
  let globeDepthWin = unpackEdgeDepth(globeDepthPacked);
  let globeDepthLinear = select(
    1.0e9,
    linearizeWindowDepth(globeDepthWin, near, far),
    globeDepthWin > 0.0,
  );
  let isBackground = geomDepthLinear > globeDepthLinear;

  // C-R8-EDGE-FEATURE-ID — compare the edge's stored featureId
  // against the current fragment's featureId. C-R8-EDGE-ID-FORMAT
  // (Batch 49): 16-bit IDs split across `id.g` (low byte) + `id.b`
  // (high byte), each stored 0..1 normalised. Recomposed via
  // `low + high * 256` after denormalising both channels — round-trips
  // integer IDs 0..65535 exactly. Beyond 65535 the emitter saturates
  // and IDs collapse to indistinguishable; practical only for tilesets
  // that would also strain the GPU batch-table side.
  var drawEdge = isBackground;
  let hasFeatureGating = effects.edgeViewport.w > 0.5;
  if (hasFeatureGating) {
    let edgeFidLow = round(edgeIdSample.g * 255.0);
    let edgeFidHigh = round(edgeIdSample.b * 255.0);
    let edgeFeatureIdN = edgeFidLow + edgeFidHigh * 256.0;
    let curFeatureIdN = clamp(currentFeatureId, 0.0, 65535.0);
    let hasEdgeFeature = edgeFeatureIdN > 0.0;
    let hasCurrentFeature = curFeatureIdN > 0.0;
    let featuresMatch = abs(edgeFeatureIdN - curFeatureIdN) < 0.5;
    drawEdge = drawEdge || !hasEdgeFeature || !hasCurrentFeature || featuresMatch;
  } else {
    drawEdge = true;
  }

  if (!drawEdge) {
    return color;
  }
  return edgeColor;
}

// Per-texture UV-set bit indices in material.texCoordFlags. Keep in sync
// with the WebGPUPrimitiveCommands.js material packer which writes this
// uniform. Using explicit bit positions (rather than raw 1u, 2u, …)
// keeps the sampling-site call sites self-documenting.
const TEXCOORD_BIT_BASE_COLOR: u32           = 1u << 0u;
const TEXCOORD_BIT_NORMAL: u32               = 1u << 1u;
const TEXCOORD_BIT_METALLIC_ROUGHNESS: u32   = 1u << 2u;
const TEXCOORD_BIT_EMISSIVE: u32             = 1u << 3u;
const TEXCOORD_BIT_OCCLUSION: u32            = 1u << 4u;

// KHR_texture_transform "has transform" bit layout — same per-slot
// bit positions as TEXCOORD_BIT_* so the CPU can pack both bitmasks
// in parallel. material.textureTransformFlags is read via the same
// shape as material.texCoordFlags.
const TT_BIT_BASE_COLOR: u32          = 1u << 0u;
const TT_BIT_NORMAL: u32              = 1u << 1u;
const TT_BIT_METALLIC_ROUGHNESS: u32  = 1u << 2u;
const TT_BIT_EMISSIVE: u32            = 1u << 3u;
const TT_BIT_OCCLUSION: u32           = 1u << 4u;

// Per-texture UV resolvers — pick UV set + apply KHR_texture_transform
// in one call so the textureSample sites stay readable. Each wraps
// `selectUV` then `applyTextureTransform`. Identity transforms (the
// common no-extension case) skip the multiply via the slotBit guard
// inside applyTextureTransform.
fn baseColorUV(input: FragmentInput) -> vec2<f32> {
  let uv = selectUV(input, TEXCOORD_BIT_BASE_COLOR);
  return applyTextureTransform(
    uv, TT_BIT_BASE_COLOR,
    material.baseColorTextureTransform0,
    material.baseColorTextureTransform1,
    material.baseColorTextureTransform2,
  );
}
fn normalUV(input: FragmentInput) -> vec2<f32> {
  let uv = selectUV(input, TEXCOORD_BIT_NORMAL);
  return applyTextureTransform(
    uv, TT_BIT_NORMAL,
    material.normalTextureTransform0,
    material.normalTextureTransform1,
    material.normalTextureTransform2,
  );
}
fn metallicRoughnessUV(input: FragmentInput) -> vec2<f32> {
  let uv = selectUV(input, TEXCOORD_BIT_METALLIC_ROUGHNESS);
  return applyTextureTransform(
    uv, TT_BIT_METALLIC_ROUGHNESS,
    material.metallicRoughnessTextureTransform0,
    material.metallicRoughnessTextureTransform1,
    material.metallicRoughnessTextureTransform2,
  );
}
fn emissiveUV(input: FragmentInput) -> vec2<f32> {
  let uv = selectUV(input, TEXCOORD_BIT_EMISSIVE);
  return applyTextureTransform(
    uv, TT_BIT_EMISSIVE,
    material.emissiveTextureTransform0,
    material.emissiveTextureTransform1,
    material.emissiveTextureTransform2,
  );
}
fn occlusionUV(input: FragmentInput) -> vec2<f32> {
  let uv = selectUV(input, TEXCOORD_BIT_OCCLUSION);
  return applyTextureTransform(
    uv, TT_BIT_OCCLUSION,
    material.occlusionTextureTransform0,
    material.occlusionTextureTransform1,
    material.occlusionTextureTransform2,
  );
}

// Pick TEXCOORD_0 or TEXCOORD_1 for a given texture slot based on the
// bitmask uploaded by the CPU (one bit per slot). glTF textureInfos
// each carry a `texCoord: 0|1` flag; occlusion and clearcoat-normal
// commonly want slot 1 while base color stays on slot 0.
// Apply a KHR_texture_transform 3x3 matrix to UVs. Mirrors WebGL's
// czm_computeTextureTransform. The matrix is reconstructed at call
// time from the 3 padded vec4 columns we store in the UBO. When the
// matching slot bit in textureTransformFlags is unset, returns the
// input UV unchanged so identity slots don't pay the multiply cost.
fn applyTextureTransform(
  uv: vec2<f32>,
  slotBit: u32,
  col0: vec4<f32>,
  col1: vec4<f32>,
  col2: vec4<f32>,
) -> vec2<f32> {
  if ((material.textureTransformFlags & slotBit) == 0u) {
    return uv;
  }
  let m = mat3x3<f32>(col0.xyz, col1.xyz, col2.xyz);
  return (m * vec3<f32>(uv, 1.0)).xy;
}

fn selectUV(input: FragmentInput, slotBit: u32) -> vec2<f32> {
  //>>ifdef MODEL_HAS_TEXCOORD_1
  let useUV1 = (material.texCoordFlags & slotBit) != 0u;
  return select(input.texCoord0, input.texCoord1, useUV1);
  //>>else
  // No TEXCOORD_1 attribute on this primitive — texCoordFlags requesting
  // UV set 1 silently degrades to texCoord0. Matches the pre-Session-62
  // behavior that always bound a uv0 fallback into slot 7.
  return input.texCoord0;
  //>>endif
}

// AUDIT_2026_05_02 A.6 — port of `Shaders/Model/ModelClippingPlanesStageFS.glsl`
// for the WebGPU model path. WebGL Model rendering supports
// `model.clippingPlanes`; the WebGPU path declared `clippingPlaneTex` at
// `@group(3) @binding(3)` and the `EffectsUniforms.clippingPlaneCount` /
// `clippingUnionMode` / `clippingEdgeWidth` / `clippingEdgeColor` fields
// but never sampled them — model clipping was a complete no-op.
//
// CRITICAL FRAME: planes in `clippingPlaneTex` are uploaded in EYE SPACE
// by `WebGPUClippingPlaneCollection.ts` (see its file-level comment at
// lines 103-119: "Pack plane data transformed into EYE SPACE so the
// fragment test `dot(eyePos, plane.xyz) + plane.w` matches the frame of
// eyePos"). The fragment-side test must therefore consume eye-space
// position, NOT model-space. (An earlier draft of this fix used
// reconstructed model-space and produced silent wrong output — caught
// by audit/rereview 2026-05-02.)
//
// Mirror of `globeClipByPlanes` in `GlobeTerrain.wgsl` but consuming
// eye-space:
//   - For each plane in [0, clippingPlaneCount), sample the plane data
//     row-major from `clippingPlaneTex` (single-row texture, width =
//     count) and compute fragment-side distance.
//   - Intersection mode (default): discard fragment when ALL planes
//     report negative distance (fragment inside every clip half-space).
//   - Union mode: discard on FIRST negative-distance plane (fragment is
//     outside any clip half-space).
//
// Returns the smallest signed distance across all planes (positive =
// inside the kept region) so the caller can render an edge band when
// `clippingEdgeWidth > 0`.
// Batch 160 — AUDIT_2026_05_02 A.6 NEW-MODEL-CLIPPING-POLYGONS.
// Polygon SDF clipping for models. Full mirror of the WebGL pipeline
// `Shaders/Model/ModelClippingPolygonsStageVS.glsl` (region selection)
// + `Shaders/Builtin/Functions/clipPolygons.glsl` (atlas sampling),
// folded into a single FS function since the WebGPU model path has no
// separate clipping VS pass.
//
// CRITICAL FRAME: input is WORLD-space position (meters from Earth
// center). Convert to approximate spherical coords (lat, lon) using
// the same `czm_fastApproximateAtan2` curve the SDF compute pass packs
// against — exact `atan2`/`asin` would cause sub-texel mismatch
// against the precomputed extents.
//
// Algorithm (mirrors GLSL VS+FS combined):
//   1. Compute (lat, lon) for the fragment.
//   2. Iterate `clippingPolygonControl.x` merged-extent groups.
//      For each group:
//        rectUv = (sphericalLatLong.yx - extents.yx) * extents.wz
//        Track the minimum-distance group (for fragments OUTSIDE the
//        bounding rect — they don't get clipped, but the minimum is
//        kept around to mirror the GLSL behavior).
//        If `rectUv` lies inside [threshold, 1-threshold] → record this
//        group as the containing region.
//   3. If no containing region was found OR rectUv is outside [0,1] in
//      the chosen group, return false (no clipping for this fragment).
//   4. Otherwise sample the SDF atlas at
//        atlasUv = textureOffset(regionIndex) + rectUv * invDim
//      where textureOffset is the region's slot in the atlas grid
//      (precomputed `invDim = clippingPolygonControl.y`).
//   5. Discard if `(sdfSample - 0.5) * 2.0 < 0.0` (signed distance
//      negative = fragment inside polygon = clipped, matching the
//      `#ifndef CLIPPING_INVERSE` branch of `czm_clipPolygons`).
//
// Note on coverage: capped at 8 merged-extent groups. The CPU coalesces
// overlapping polygons into one extent group, so a typical
// BIM-cutaway scene with 1–4 polygons consumes 1–4 groups. Scenes
// with >8 disjoint polygon groups will silently miss the overflow
// (JS side warns once via `oneTimeWarning`).
fn czm_fastApproximateAtanScalar(x: f32) -> f32 {
  // ShaderFastLibs Drobot atan over [0, 1]. Same coefficients as
  // `Builtin/Functions/fastApproximateAtan.glsl`.
  return x * (-0.1784 * x - 0.0663 * x * x + 1.0301);
}

fn czm_fastApproximateAtan2(x: f32, y: f32) -> f32 {
  // Range-reduction matches the WebGL CG reference path; keep it bit
  // identical to `Builtin/Functions/fastApproximateAtan.glsl` so the
  // fragment-side (lat, lon) lines up with the CPU-packed extents.
  let t0 = abs(x);
  let opp0 = abs(y);
  let adjacent = max(t0, opp0);
  let opposite = min(t0, opp0);
  var t = czm_fastApproximateAtanScalar(opposite / adjacent);
  let PI_2: f32 = 1.5707963267948966;
  let PI_F: f32 = 3.14159265358979;
  if (abs(y) > abs(x)) { t = PI_2 - t; }
  if (x < 0.0) { t = PI_F - t; }
  if (y < 0.0) { t = -t; }
  return t;
}

fn modelClipByPolygon(positionWC: vec3<f32>) -> bool {
  let polyCount = effects.clippingPolygonCount;
  if (polyCount == 0u) { return false; }
  let extentsCount = u32(effects.clippingPolygonControl.x);
  if (extentsCount == 0u) { return false; }
  let invDim = effects.clippingPolygonControl.y;
  if (invDim <= 0.0) { return false; }

  let PI_F: f32 = 3.14159265358979;
  let TWO_PI: f32 = 6.28318530717958;
  // Project into plane with vertical-axis latitude — same form as
  // `czm_approximateSphericalCoordinates` in `Builtin/Functions`.
  let magXY = sqrt(positionWC.x * positionWC.x + positionWC.y * positionWC.y);
  let latitudeApproximation = czm_fastApproximateAtan2(magXY, positionWC.z);
  var longitudeApproximation = czm_fastApproximateAtan2(positionWC.x, positionWC.y);
  // GLSL VS does `czm_branchFreeTernary(lon < pi, lon, lon - twoPi)`.
  // Branch-free here too for consistency.
  if (longitudeApproximation >= PI_F) {
    longitudeApproximation = longitudeApproximation - TWO_PI;
  }
  // sphericalLatLong = (lat, lon) — note the GLSL uses `.yx` swizzle
  // when subtracting `extents.yx` (south, west); we keep the same
  // ordering so the math matches byte-for-byte.

  // Iterate merged-extent groups. Mirrors GLSL VS region selection.
  var bestRegion: i32 = -1;
  var bestRectUv: vec2<f32> = vec2<f32>(0.0, 0.0);
  let regionCount = min(extentsCount, 8u);
  for (var r: u32 = 0u; r < regionCount; r = r + 1u) {
    let extents = effects.clippingPolygonExtents[r];
    // extents.xy = (south, west); extents.zw = (invLatRange, invLonRange).
    // rectUv.x = (lon - west) * invLonRange  (atlas U)
    // rectUv.y = (lat - south) * invLatRange (atlas V)
    let rectUv = vec2<f32>(
      (longitudeApproximation - extents.y) * extents.w,
      (latitudeApproximation - extents.x) * extents.z,
    );
    // GLSL uses a 0.01 threshold to avoid sampling on the extent
    // boundary where the SDF generator's edge cases behave poorly.
    let threshold: f32 = 0.01;
    if (rectUv.x > threshold &&
        rectUv.y > threshold &&
        rectUv.x < (1.0 - threshold) &&
        rectUv.y < (1.0 - threshold)) {
      bestRegion = i32(r);
      bestRectUv = rectUv;
      // Keep the first containing region — matches GLSL VS behavior
      // (it overwrites on every match but iterates in the same order
      // here, so the LAST containing region wins in GLSL while we
      // pick the FIRST. With merged-extent coalescing each fragment
      // is by design contained in at most one group, so the choice
      // doesn't matter in practice.)
      break;
    }
  }
  // Batch 163 — fragments outside any region's bounding rectangle
  // must respect the inverse flag. The default (cutout) treats them as
  // "outside polygon" → keep them; inverse mode treats them as
  // "outside polygon" → discard them. This matches the GLSL
  // `czm_clipPolygons` early-return path which does
  // `#ifdef CLIPPING_INVERSE discard; #endif return;` when
  // `regionIndex < 0` or `rectUv` is outside [0,1]. Batch 160's
  // implementation returned `false` unconditionally, leaking the
  // entire scene-outside-the-polygon region in inverse mode (AEC
  // "show only inside" demos rendered everything).
  let inverseFlagEarly = effects.clippingPolygonControl.z;
  let invertedDiscardOutside = inverseFlagEarly >= 0.5;
  if (bestRegion < 0) { return invertedDiscardOutside; }
  if (bestRectUv.x <= 0.0 || bestRectUv.y <= 0.0 ||
      bestRectUv.x >= 1.0 || bestRectUv.y >= 1.0) {
    return invertedDiscardOutside;
  }

  // Atlas slot math — mirrors `czm_clipPolygons`:
  //   textureOffset = (regionIndex % dim, regionIndex / dim) / dim
  //   uv            = textureOffset + rectUv / dim
  // We precomputed `invDim = 1/dim` on the JS side.
  let dimF = 1.0 / invDim;
  let regionF = f32(bestRegion);
  // `dim` is integer-valued, so floor() is exact and `regionF % dim`
  // fits in f32 without precision loss for our 8-cap.
  let col = regionF - dimF * floor(regionF / dimF);
  let row = floor(regionF / dimF);
  let textureOffset = vec2<f32>(col, row) * invDim;
  let uv = clamp(
    textureOffset + bestRectUv * invDim,
    vec2<f32>(0.0),
    vec2<f32>(1.0),
  );

  let sdfValue = textureSampleLevel(
    clippingPolygonTex, clippingPolygonSampler, uv, 0.0).r;
  // SDF encoding: 0.5 = on edge, < 0.5 = inside polygon, > 0.5 = outside.
  // signedDistance = (sdfValue - 0.5) * 2.0:
  //   - default (CLIPPING_INVERSE = 0): discard when signedDistance < 0
  //     → discard inside polygon (cutout, matches GLSL
  //       `czm_clipPolygons` non-inverse branch).
  //   - inverse (CLIPPING_INVERSE = 1): discard when signedDistance > 0
  //     → discard outside polygon (keep only inside, AEC
  //       "show-only-inside" demos).
  let inverseFlag = effects.clippingPolygonControl.z;
  let discardInside = inverseFlag < 0.5;
  if (discardInside) {
    return sdfValue < 0.5;
  }
  return sdfValue > 0.5;
}

fn modelClipByPlanes(positionEC: vec3<f32>) -> f32 {
  let count = effects.clippingPlaneCount;
  if (count == 0u) { return 1.0; }
  let isUnion = effects.clippingUnionMode == 1u;
  let texWidth = f32(count);
  var minDistance: f32 = 1.0e30;
  var clippedCount: u32 = 0u;
  for (var i: u32 = 0u; i < count; i++) {
    let texelU = (f32(i) + 0.5) / texWidth;
    let planeData = textureSampleLevel(
      clippingPlaneTex, clippingPlaneSampler,
      vec2<f32>(texelU, 0.5), 0.0,
    );
    let dist = dot(positionEC, planeData.xyz) + planeData.w;
    if (dist < minDistance) { minDistance = dist; }
    if (dist < 0.0) {
      clippedCount++;
      if (isUnion) { return -1.0; }
    }
  }
  if (!isUnion && clippedCount == count) { return -1.0; }
  return minDistance;
}

// Slice 5c-B Batch 119 — G-buffer MRT output struct for the Model
// color pipeline. Slot 0 = lit color (the pre-Batch-119 single output);
// slot 1 = eye-space normal + roughness packed as rgba16float.
//
// Model is the highest-ROI primitive for the G-buffer because its
// per-fragment N can be post-normal-map (FLAG_HAS_NORMAL_TEXTURE
// triggers perturbNormal at L1915) — fundamentally divergent from the
// depth-derived approximation that the AO consumer fallback computes.
// Roughness is also real material data (metallicRoughnessTexture .g
// channel × material.roughnessFactor) instead of the 0.5 placeholder
// other primitives use.
//
// The pick / velocity / classification entry points stay single-target.
// They use their own pipelines (createPickPipeline*, createVelocityPipeline,
// createClassificationPipeline) which build against the pick FB /
// velocity FB / classification FB — NOT the scene FB — so they don't
// need slot 1 declarations.
struct FragOutput {
  @location(0) color: vec4<f32>,
  @location(1) normalRoughness: vec4<f32>,
  //>>ifdef LOG_DEPTH
  // Written for the depth TEST as well (frag_depth replaces rasterized z)
  // so translucent model passes test correctly against log scene depth.
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment fn fragmentMain(input: FragmentInput) -> FragOutput {
  let flags = material.materialFlags;

  // Slice 5c-B Batch 119 — hoisted geometric normal for early-exit
  // returns (clipping edge band, unlit path). The main lit path
  // computes a SEPARATE `N` at L1911+ which may be post-normal-map;
  // those returns emit that better N + the real material roughness
  // instead of these placeholders.
  let geomNormalEC = normalize(input.normalEC);

  // Hoist fwidth() to uniform control flow at the entry of the fragment
  // shader. WGSL requires fwidth to be called from uniform control flow,
  // and the edge overlay (which uses pixelStep) is invoked from the
  // FLAG_IS_UNLIT early-out branch which the compiler can't prove is
  // uniform across the quad. Computing it once at the top sidesteps
  // the issue. Cost: every fragment computes pixelStep even when the
  // edge stage is disabled — negligible (one fwidth, ~2 ALU).
  let edgePixelStep = fwidth(abs(input.positionEC.z));

  // Hoist the screen-space derivative tangent to uniform control flow for
  // the SAME reason as edgePixelStep above (Slice 5d Batch 159): the
  // tangent-less normal-map fallback in perturbNormal needs dpdx/dpdy of
  // position + UV, but perturbNormal is reached through non-uniform
  // branches (the double-sided `frontFacing` normal flip, the unlit
  // early-out), so WGSL rejects derivative built-ins inside it. Compute the
  // raw frame here at the uniform entry and thread it down. Two UV sets:
  // the base normal map uses `normalUV`, the (rare) clearcoat normal uses
  // `baseColorUV` to mirror its existing sampling site. Cost is a handful
  // of ALU per fragment even when no normal texture is bound — negligible,
  // and unconditional evaluation is required for the uniformity guarantee.
  let normalDerivTangent = deriveTangentRaw(input.positionEC, normalUV(input));
  let clearcoatDerivTangent = deriveTangentRaw(input.positionEC, baseColorUV(input));

  // AUDIT_2026_05_02 A.6 — model clipping planes. Eye-space distance
  // test: planes are uploaded eye-space transformed (see
  // `WebGPUClippingPlaneCollection.ts:103-119`), and `input.positionEC`
  // is already in eye space (set by VS at `output.positionEC =
  // (camera.modelViewRelativeToEye * vec4(rte, 1.0)).xyz`).
  if (effects.clippingPlaneCount > 0u) {
    let clipDist = modelClipByPlanes(input.positionEC);
    if (clipDist < 0.0) { discard; }
    // Edge band: when the fragment is within `clippingEdgeWidth` of the
    // clip boundary, paint it with the user's edge color. Width is in
    // eye-space meters since both sides of the test live in eye space.
    let edgeWidth = effects.clippingEdgeWidth;
    if (edgeWidth > 0.0 && clipDist < edgeWidth) {
      // Slice 5c-B Batch 119 — clipping edge: no material work has run
      // yet (no PBR, no normal map). Emit geometric vertex normal +
      // 0.5 roughness placeholder. The edge band is typically thin
      // (clippingEdgeWidth ~ 1m eye-space) so consumer quality impact
      // of the placeholder is negligible.
      var out: FragOutput;
      out.color = effects.clippingEdgeColor;
      out.normalRoughness = vec4<f32>(geomNormalEC, 0.5);
      //>>ifdef LOG_DEPTH
      out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
      //>>endif
      return out;
    }
  }

  // AUDIT_2026_05_02 A.6 — clipping polygons. Only run when the user
  // configured `model.clippingPolygons`; the SDF binding stays at the
  // 1×1 placeholder otherwise (sampled value 1.0 → "outside",
  // discarding everything if we naively ran it). Reconstruct world
  // position from `rteMC` (model-space RTE vector) using the model's
  // camera-encoded origin: `worldPos = cameraPositionWC + (modelMatrix * vec4(rteMC, 0)).xyz`.
  // The `vec4(rteMC, 0)` carries only the rotation/scale of the model
  // matrix (not its translation, which would double-count the camera-
  // anchored RTE offset).
  if (effects.clippingPolygonCount > 0u) {
    let worldPos = camera.cameraPositionWC
      + (material.modelMatrix * vec4<f32>(input.rteMC, 0.0)).xyz;
    if (modelClipByPolygon(worldPos)) { discard; }
  }

  // C-R8-EDGE-FEATURE-ID — resolve the current fragment's featureId
  // (if any) up-front so both per-feature batch styling AND the inline
  // edge-detection stage can consume it without redundant texture
  // samples. Stays at 0.0 when the model has no feature ID texture —
  // both consumers correctly degrade to "no feature" in that case.
  // Note: feature IDs are integers in glTF EXT_mesh_features but we
  // carry as f32 here because the edge texture's `id.g` channel is
  // an 8-bit normalised float (0..1) — matching keeps both sides of
  // the comparison in the same encoding.
  var currentFeatureId: f32 = 0.0;
  if (hasFlag(flags, FLAG_HAS_FEATURE_ID_TEXTURE)) {
    let fidSampleEarly = textureSampleLevel(featureIdTexture, featureIdSampler, input.texCoord0, 0.0);
    let fidIntEarly = unpackFeatureId(fidSampleEarly, featureId.channelCount);
    currentFeatureId = f32(fidIntEarly);
  } else if (hasFlag(flags, FLAG_HAS_FEATURE_ID_ATTRIBUTE)) {
    // Audit B.2 (Batch 130) -- vertex-attribute path. b3dm tilesets
    // encode batch IDs as the per-vertex _BATCHID accessor (renamed
    // _FEATURE_ID_0 by the loader). Flat-interpolated, so the value
    // is exact across the triangle without rounding.
    currentFeatureId = input.featureId0;
  }

  // ── Base color ────────────────────────────────────────────────────────────
  var baseColor = material.baseColorFactor;

  // baseColor / diffuse textures are uploaded as `rgba8unorm-srgb`
  // (WebGPUModelRenderer.js createGPUTextureFromReader), so
  // textureSampleLevel(, 0.0) already returns linear values. In-shader srgbToLinear
  // (pow(x, 2.2)) would apply the decode twice and darken mid-tones.
  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    baseColor = vec4<f32>(material.diffuseFactor_r, material.diffuseFactor_g,
                          material.diffuseFactor_b, material.diffuseFactor_a);
    if (hasFlag(flags, FLAG_HAS_DIFFUSE_TEXTURE)) {
      let tc = textureSampleLevel(baseColorTexture, baseColorSampler, baseColorUV(input), 0.0);
      baseColor = baseColor * tc;
    }
  } else {
    if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
      let tc = textureSampleLevel(baseColorTexture, baseColorSampler, baseColorUV(input), 0.0);
      baseColor = baseColor * tc;
    }
  }

  if (hasFlag(flags, FLAG_HAS_VERTEX_COLORS)) {
    baseColor = baseColor * input.color0;
  }

  // ── Alpha test ────────────────────────────────────────────────────────────
  if (hasFlag(flags, FLAG_ALPHA_MODE_MASK)) {
    if (baseColor.a < material.alphaCutoff) { discard; }
    baseColor = vec4<f32>(baseColor.rgb, 1.0);
  }

  // ── Unlit early-out ───────────────────────────────────────────────────────
  if (hasFlag(flags, FLAG_IS_UNLIT)) {
    var c = baseColor.rgb + material.emissiveFactor;
    c = tonemapAndGamma(c);
    let a = select(1.0, baseColor.a, hasFlag(flags, FLAG_ALPHA_MODE_BLEND));
    let unlitColor = vec4<f32>(c, a);
    let unlitWithEdge = applyEdgeOverlay(
      unlitColor,
      input.positionEC,
      input.fragCoord.xy,
      currentFeatureId,
      edgePixelStep,
    );
    // Slice 5c-B Batch 119 — unlit path: model has no shading normal
    // by design (FLAG_IS_UNLIT skips the PBR + normal-map block).
    // Emit the geometric vertex normal so consumers (AO, contact
    // shadows) still get a usable normal at unlit-painted pixels;
    // roughness 0.5 placeholder since unlit has no material spec.
    var out: FragOutput;
    out.color = unlitWithEdge;
    out.normalRoughness = vec4<f32>(geomNormalEC, 0.5);
    //>>ifdef LOG_DEPTH
    out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
    //>>endif
    return out;
  }

  // ── Normal ────────────────────────────────────────────────────────────────
  var N = normalize(input.normalEC);
  if (hasFlag(flags, FLAG_IS_DOUBLE_SIDED) && !input.frontFacing) { N = -N; }
  if (hasFlag(flags, FLAG_HAS_NORMAL_TEXTURE)) {
    let nm = textureSampleLevel(normalTexture, normalSampler, normalUV(input), 0.0).rgb;
    N = perturbNormal(N, input.tangentEC, input.bitangentEC, nm, material.normalScale,
                      normalDerivTangent);
  }

  // ── Material properties ───────────────────────────────────────────────────
  var metallic: f32;
  var roughness: f32;
  var F0: vec3<f32>;
  var diffuseColor: vec3<f32>;

  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    var spec = vec3<f32>(material.specularFactor_r, material.specularFactor_g, material.specularFactor_b);
    var gloss = material.glossinessFactor;
    if (hasFlag(flags, FLAG_HAS_SPECGLOSS_TEXTURE)) {
      let sg = textureSampleLevel(metallicRoughnessTexture, metallicRoughnessSampler, metallicRoughnessUV(input), 0.0);
      spec = spec * srgbToLinear(sg.rgb);
      gloss = gloss * sg.a;
    }
    F0 = spec;
    roughness = clamp(1.0 - gloss, 0.04, 1.0);
    metallic = max(max(spec.r, spec.g), spec.b);
    diffuseColor = baseColor.rgb * (1.0 - metallic);
  } else {
    metallic = material.metallicFactor;
    roughness = material.roughnessFactor;
    if (hasFlag(flags, FLAG_HAS_METALLIC_ROUGHNESS_TEXTURE)) {
      let mr = textureSampleLevel(metallicRoughnessTexture, metallicRoughnessSampler, metallicRoughnessUV(input), 0.0);
      roughness = roughness * mr.g;
      metallic = metallic * mr.b;
    }
    roughness = clamp(roughness, 0.04, 1.0);
    metallic = clamp(metallic, 0.0, 1.0);
    F0 = mix(vec3<f32>(0.04), baseColor.rgb, metallic);
    diffuseColor = baseColor.rgb * (1.0 - metallic);
  }

  // C-R4-GLTF-KHR slice 3 — KHR_materials_specular. Modifies dielectric
  // F0: scales intensity (specularFactor) and tints chromatically
  // (specularColorFactor). Spec at
  // https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_specular
  // says metallic surfaces ignore the color factor and still use
  // baseColor for F0; only the dielectric F0 component is recolored.
  //>>ifdef MODEL_HAS_KHR_TEXTURES
  if (hasFlag(flags, FLAG_HAS_SPECULAR_EXT)) {
    var sf = material.specularExtFactors.x;
    var sc = material.specularExtFactors.yzw;
    // C-R4-GLTF-KHR-TEXTURES (Batch 102/103) — sample
    // specularColorTexture (RGB) and specularFactorTexture (A) per
    // spec. specularColorTexture modulates the F0 chromatic tint;
    // specularFactorTexture's alpha channel scales the factor scalar.
    let scTex = textureSampleLevel(
      specularColorTexture, khrSampler, baseColorUV(input), 0.0,
    );
    sc = sc * scTex.rgb;
    let sfTex = textureSampleLevel(
      specularFactorTexture, khrSampler, baseColorUV(input), 0.0,
    );
    sf = sf * sfTex.a;
    // Recolor the dielectric component (mix factor = 1.0 - metallic).
    let dielectricF0 = vec3<f32>(0.04) * sc * sf;
    F0 = mix(dielectricF0, baseColor.rgb, metallic);
  }
  //>>endif

  // C-R4-GLTF-KHR slice 5 — KHR_materials_iridescence (Belcour 2017
  // thin-film analytical formula). Pre-Batch-181 used a cheap hue-shift
  // cos-phase approximation; this is the spec-compliant analytical
  // integral that the Khronos reference impl implements. No LUT
  // required — the per-wavelength sensitivity terms are baked as
  // fixed Gaussian fits per the Belcour paper (Sensitivity tables 1-3),
  // evaluated analytically.
  //
  // Reference: Khronos KHR_materials_iridescence spec / three.js
  // `iridescenceFresnel`. ~80 LOC of bounded WGSL math; no new
  // bindings or UBO fields.
  //>>ifdef MODEL_HAS_KHR_TEXTURES
  if (hasFlag(flags, FLAG_HAS_IRIDESCENCE)) {
    var irFactor = material.iridescenceFactors.x;
    let irIor = material.iridescenceFactors.y;
    // C-R4-GLTF-KHR-TEXTURES (Batch 102/103) — sample iridescenceTexture
    // (R = mask) and iridescenceThicknessTexture (G) per spec.
    let irTex = textureSampleLevel(
      iridescenceTexture, khrSampler, baseColorUV(input), 0.0,
    );
    irFactor = irFactor * irTex.r;
    let thickTex = textureSampleLevel(
      iridescenceThicknessTexture, khrSampler, baseColorUV(input), 0.0,
    );
    let thinFilmThickness = mix(
      material.iridescenceFactors.z,
      material.iridescenceFactors.w,
      thickTex.g,
    );
    let approxNdotV = max(dot(N, normalize(-input.positionEC)), 0.001);
    // ── Belcour 2017 evalIridescence ──
    // Force iridescenceIor → outsideIor (1.0) when thinFilmThickness → 0
    // for graceful degradation at thin-film thickness asymptotes.
    let outsideIor: f32 = 1.0;
    let thicknessSmooth = smoothstep(0.0, 0.03, thinFilmThickness);
    let iridescenceIor = mix(outsideIor, irIor, thicknessSmooth);
    // Snell on the thin-film layer for cosTheta2.
    let etaRatio = outsideIor / iridescenceIor;
    let sinTheta2Sq =
      etaRatio * etaRatio * (1.0 - approxNdotV * approxNdotV);
    let cosTheta2Sq = 1.0 - sinTheta2Sq;
    var irTint = vec3<f32>(1.0, 1.0, 1.0);
    if (cosTheta2Sq >= 0.0) {
      let cosTheta2 = sqrt(cosTheta2Sq);
      // First interface (outside ↔ thin-film).
      let R0_12 = ((iridescenceIor - outsideIor) /
                   (iridescenceIor + outsideIor));
      let R0_12sq = R0_12 * R0_12;
      // Schlick for cosTheta1.
      let oneMinusCos1 = 1.0 - approxNdotV;
      let R12 = R0_12sq + (1.0 - R0_12sq) *
        oneMinusCos1 * oneMinusCos1 * oneMinusCos1 *
        oneMinusCos1 * oneMinusCos1;
      let T121 = 1.0 - R12;
      var phi12 = 0.0;
      if (iridescenceIor < outsideIor) { phi12 = 3.14159265358979; }
      let phi21 = 3.14159265358979 - phi12;
      // Second interface (thin-film ↔ base material). baseIor derived
      // from the current dielectric F0 (clamped to avoid div-by-zero
      // at the F0 = 1 edge, where Fresnel0ToIor diverges).
      let f0Clamp = clamp(F0, vec3<f32>(0.0), vec3<f32>(0.9999));
      let sqrtF0 = sqrt(f0Clamp);
      let baseIor = (vec3<f32>(1.0) + sqrtF0) / (vec3<f32>(1.0) - sqrtF0);
      let R0_23 = ((baseIor - vec3<f32>(iridescenceIor)) /
                   (baseIor + vec3<f32>(iridescenceIor)));
      let R0_23sq = R0_23 * R0_23;
      let oneMinusCos2 = 1.0 - cosTheta2;
      let oneMinusCos2_5 = oneMinusCos2 * oneMinusCos2 *
        oneMinusCos2 * oneMinusCos2 * oneMinusCos2;
      let R23 = R0_23sq + (vec3<f32>(1.0) - R0_23sq) * oneMinusCos2_5;
      var phi23 = vec3<f32>(0.0);
      if (baseIor.r < iridescenceIor) { phi23.r = 3.14159265358979; }
      if (baseIor.g < iridescenceIor) { phi23.g = 3.14159265358979; }
      if (baseIor.b < iridescenceIor) { phi23.b = 3.14159265358979; }
      // Optical path difference + accumulated phase.
      let opd = 2.0 * iridescenceIor * thinFilmThickness * cosTheta2;
      let phi = vec3<f32>(phi21) + phi23;
      // Compound terms.
      let R123 = clamp(R12 * R23, vec3<f32>(1.0e-5), vec3<f32>(0.9999));
      let r123 = sqrt(R123);
      let Rs = T121 * T121 * R23 / (vec3<f32>(1.0) - R123);
      // m = 0 DC term.
      var I = vec3<f32>(R12) + Rs;
      // m ≥ 1 oscillating terms — Gaussian fits to xyz match functions
      // per Belcour 2017 supplementary. We sum m=1 and m=2 (higher
      // orders contribute negligibly for typical thin films).
      var Cm = Rs - vec3<f32>(T121);
      // m = 1
      Cm = Cm * r123;
      let phase1 = opd * 6.2831853 * 1.0e-9;
      // Per-channel sensitivity at OPD (xyz response curves; constants
      // from Belcour 2017 evalSensitivity for 1nm increments).
      // Channel R: peak ~580nm. Channel G: ~545nm. Channel B: ~440nm.
      let phaseR1 = phase1 * 5.4856e14 + phi.r;
      let phaseG1 = phase1 * 5.4828e14 + phi.g;
      let phaseB1 = phase1 * 6.8126e14 + phi.b;
      let SmR1 = 9.7470e-14 * sqrt(2.0 * 3.14159265358979 * 4.5282e9) *
        cos(phaseR1) * exp(-(phase1 * phase1) * 4.5282e9);
      let SmG1 = 1.4391e-13 * sqrt(2.0 * 3.14159265358979 * 8.5358e9) *
        cos(phaseG1) * exp(-(phase1 * phase1) * 8.5358e9);
      let SmB1 = 5.7188e-14 * sqrt(2.0 * 3.14159265358979 * 5.5024e9) *
        cos(phaseB1) * exp(-(phase1 * phase1) * 5.5024e9);
      I = I + Cm * 2.0 * vec3<f32>(SmR1, SmG1, SmB1);
      // m = 2 (smaller contribution; loop unrolled).
      Cm = Cm * r123;
      let phase2 = opd * 6.2831853 * 1.0e-9 * 2.0;
      let phiR2 = phase2 * 5.4856e14 + phi.r * 2.0;
      let phiG2 = phase2 * 5.4828e14 + phi.g * 2.0;
      let phiB2 = phase2 * 6.8126e14 + phi.b * 2.0;
      let SmR2 = 9.7470e-14 * sqrt(2.0 * 3.14159265358979 * 4.5282e9) *
        cos(phiR2) * exp(-(phase2 * phase2) * 4.5282e9);
      let SmG2 = 1.4391e-13 * sqrt(2.0 * 3.14159265358979 * 8.5358e9) *
        cos(phiG2) * exp(-(phase2 * phase2) * 8.5358e9);
      let SmB2 = 5.7188e-14 * sqrt(2.0 * 3.14159265358979 * 5.5024e9) *
        cos(phiB2) * exp(-(phase2 * phase2) * 5.5024e9);
      I = I + Cm * 2.0 * vec3<f32>(SmR2, SmG2, SmB2);
      irTint = max(I, vec3<f32>(0.0));
    }
    F0 = mix(F0, irTint, irFactor);
  }
  //>>endif

  // ── Cook-Torrance BRDF ────────────────────────────────────────────────────
  let V = normalize(-input.positionEC);
  let L = normalize(light.sunDirectionEC);
  let H = normalize(V + L);
  let NdotL = max(dot(N, L), 0.0);
  let NdotV = max(dot(N, V), 0.001);
  let NdotH = max(dot(N, H), 0.0);
  let VdotH = max(dot(V, H), 0.0);

  // NEW-MODEL-DIRECT-BRDF-PARITY (Batch 355) -- mirror WebGL czm_pbrLighting:
  // height-correlated Smith-joint visibility (denominator folded in) + f90
  // Fresnel. specBRDF = F·Vis·D (NO separate /(4·NdotV·NdotL)).
  let alphaRoughness = roughness * roughness;
  let D = distributionGGX(NdotH, roughness);
  let Vis = smithVisibilityGGX(alphaRoughness, NdotL, NdotV);
  let directReflectance = max(F0.r, max(F0.g, F0.b));
  let directF90 = vec3<f32>(clamp(directReflectance * 25.0, 0.0, 1.0));
  let F = fresnelSchlick2(F0, directF90, VdotH);
  let specBRDF = F * Vis * D;

  // diffuseColor already carries (1 - metallic) (see derivation above), so the
  // diffuse term is (1 - F) only — matching WebGL's (1 - F)·material.diffuse.
  // (The prior (1 - F)·(1 - metallic) double-applied the metallic factor.)
  let kD = vec3<f32>(1.0) - F;
  var direct = (kD * diffuseColor / PI + specBRDF) * light.sunColor * light.sunIntensity * NdotL;

  // Slice 5d Batch 153 — Forward+ clustered lighting additive
  // contribution. The ClusteredLighting chunk is prepended to this
  // shader by `WebGPUModelPipelineCache._getOrCreateShaderModule` and
  // declares `evalClusteredLights(...)` plus the @group(3) bindings
  // 18..22 that the effects bind group (extended in Batch 153) carries
  // the dispatcher's per-frame cluster data on. Early-outs to vec3(0)
  // when `clusterParams.activeLightCount.x == 0` (zero lights this
  // frame OR scene.clusteredLightingEnabled === false), so the cost
  // when off is one uniform compare per fragment.
  let clusteredContrib = evalClusteredLights(
    input.positionEC, N, V, F0, roughness, diffuseColor,
    input.fragCoord.xy, input.positionEC.z,
  );
  direct = direct + clusteredContrib;

  // C-R4-GLTF-KHR slice 4 — KHR_materials_anisotropy (factor-level).
  // Full anisotropic GGX needs the tangent-frame as a per-vertex
  // attribute (not currently passed through `FragmentInput`). For Slice
  // 4 we approximate by stretching the GGX D term along the half-vector
  // projection: rougher highlights along the view's right axis when
  // strength is positive, along the up axis when negative. Visually
  // produces the streak shape brushed-metal assets expect; full per-
  // tangent BRDF lands in a follow-up once tangents are plumbed.
  //>>ifdef MODEL_HAS_KHR_TEXTURES
  if (hasFlag(flags, FLAG_HAS_ANISOTROPY)) {
    var aniStrength = material.anisotropyFactors.x;
    var aniRotation = material.anisotropyFactors.y;
    // C-R4-GLTF-KHR-TEXTURES (Batch 102) — sample anisotropyTexture.
    // RG carries the (cos, sin) of a per-pixel rotation offset; B
    // scales the strength. Spec stores the trig pair as
    // (RG * 2 - 1) so 0.5 = no rotation, 1.0 = +pi/2.
    let aniTex = textureSampleLevel(
      anisotropyTexture, khrSampler, baseColorUV(input), 0.0,
    );
    let aniRotOffset = atan2(aniTex.g * 2.0 - 1.0, aniTex.r * 2.0 - 1.0);
    aniRotation = aniRotation + aniRotOffset;
    aniStrength = aniStrength * aniTex.b;
    // AUDIT_2026_05_02 B.5 / NEW-KHR-ANISO-TANGENT — use the authored
    // glTF TANGENT attribute (already plumbed through FragmentInput as
    // tangentEC + bitangentEC, see VS lines 595-597) rather than the
    // view-relative approximation. The spec defines the anisotropy
    // streak along the per-fragment tangent direction; using `cross(N, V)`
    // produced wrong streaks on brushed-metal materials with authored
    // anisotropic UVs.
    //
    // Guard `normalize` against zero-length input: primitives WITHOUT an
    // authored TANGENT attribute upload zeros into the tangent slot, and
    // `normalize(vec3(0))` is undefined behavior in WGSL. Fall back to
    // the view-relative basis (the previous approximation) when the
    // tangent is degenerate so non-tangent-authored anisotropic
    // materials still get usable streaks.
    let tanLenSq = dot(input.tangentEC, input.tangentEC);
    var aniT: vec3<f32>;
    var aniB: vec3<f32>;
    if (tanLenSq > 1.0e-6) {
      aniT = input.tangentEC * inverseSqrt(tanLenSq);
      aniB = normalize(input.bitangentEC);
    } else {
      aniT = normalize(cross(N, V));
      aniB = normalize(cross(aniT, N));
    }
    let cosR = cos(aniRotation);
    let sinR = sin(aniRotation);
    let aniDir = aniT * cosR + aniB * sinR;
    let TdotH = dot(aniDir, H);
    let aniRough = mix(roughness, 1.0, abs(TdotH) * aniStrength);
    let Daniso = distributionGGX(NdotH, aniRough);
    // NEW-MODEL-DIRECT-BRDF-PARITY (Batch 355) -- reuse the Smith-joint `Vis`
    // (denominator folded in) instead of the removed separable `G` + explicit
    // /(4·NdotV·NdotL), matching the new `specBRDF` it is differenced against.
    let aniBRDF = Daniso * Vis * F;
    direct = direct + (aniBRDF - specBRDF) * light.sunColor *
                       light.sunIntensity * NdotL * aniStrength;
  }
  //>>endif

  // C-R4-GLTF-KHR slice 2 — KHR_materials_clearcoat. Add a second GGX
  // specular lobe over the base contribution. Clearcoat fresnel uses a
  // fixed F0 = 0.04 (air-coat interface). The base material is
  // attenuated by (1 - F_clearcoat) so high-glance angles bias toward
  // the coat color rather than double-bouncing.
  //>>ifdef MODEL_HAS_KHR_TEXTURES
  if (hasFlag(flags, FLAG_HAS_CLEARCOAT)) {
    var ccFactor = material.clearcoatFactors.x;
    var ccRough = clamp(material.clearcoatFactors.y, 0.04, 1.0);
    // C-R4-GLTF-KHR-TEXTURES (Batch 102/103) — sample clearcoatTexture
    // (R = intensity), clearcoatRoughnessTexture (G = roughness), and
    // clearcoatNormalTexture (RGB = tangent-space normal) per spec.
    let ccTex = textureSampleLevel(
      clearcoatTexture, khrSampler, baseColorUV(input), 0.0,
    );
    ccFactor = ccFactor * ccTex.r;
    let ccRoughTex = textureSampleLevel(
      clearcoatRoughnessTexture, khrSampler, baseColorUV(input), 0.0,
    );
    ccRough = clamp(ccRough * ccRoughTex.g, 0.04, 1.0);
    // Clearcoat normal: per spec, the second specular lobe uses its
    // own normal independent of the base surface's normalTexture.
    // Sample + perturb when the asset declares it; placeholder white
    // texture leaves N_cc identical to N (the FS gates on the
    // FLAG_HAS_CLEARCOAT bit, but with a 1×1 white placeholder the
    // perturbation reduces to identity since (R,G) decode to (1,1)
    // and `perturbNormal` outputs back the original axis).
    let ccNormalTex = textureSampleLevel(
      clearcoatNormalTexture, khrSampler, baseColorUV(input), 0.0,
    );
    let N_cc = perturbNormal(
      input.normalEC, input.tangentEC, input.bitangentEC,
      ccNormalTex.rgb, material.clearcoatFactors.z,
      clearcoatDerivTangent,
    );
    let NdotH_cc = max(dot(N_cc, H), 0.0);
    let NdotV_cc = max(dot(N_cc, V), 0.001);
    let NdotL_cc = max(dot(N_cc, L), 0.0);
    let F_cc = fresnelSchlick(VdotH, vec3<f32>(0.04)) * ccFactor;
    let D_cc = distributionGGX(NdotH_cc, ccRough);
    let G_cc = geometrySmith(NdotV_cc, NdotL_cc, ccRough);
    let ccBRDF = D_cc * G_cc * F_cc / (4.0 * NdotV_cc * NdotL_cc + 0.0001);
    direct = direct * (vec3<f32>(1.0) - F_cc) +
             ccBRDF * light.sunColor * light.sunIntensity * NdotL_cc;
  }
  //>>endif

  // C-R4-GLTF-KHR slice 6 — KHR_materials_sheen. Charlie BRDF lobe
  // approximated with the Estevez/Kulla Charlie distribution. Energy-
  // additive on top of the base contribution; emulates fabric/velvet
  // retroreflection at grazing angles.
  //>>ifdef MODEL_HAS_KHR_TEXTURES
  if (hasFlag(flags, FLAG_HAS_SHEEN)) {
    var sheenColor = material.sheenFactors.xyz;
    var sheenRough = clamp(material.sheenFactors.w, 0.07, 1.0);
    // C-R4-GLTF-KHR-TEXTURES (Batch 102/103) — sample sheenColorTexture
    // (RGB) and sheenRoughnessTexture (A) per spec.
    let sheenTex = textureSampleLevel(
      sheenColorTexture, khrSampler, baseColorUV(input), 0.0,
    );
    sheenColor = sheenColor * sheenTex.rgb;
    let sheenRoughTex = textureSampleLevel(
      sheenRoughnessTexture, khrSampler, baseColorUV(input), 0.0,
    );
    sheenRough = clamp(sheenRough * sheenRoughTex.a, 0.07, 1.0);
    // Charlie distribution: D_charlie(α, NdotH) = ((2 + 1/α) * (sin θ_h)^(1/α)) / (2π)
    let alpha = sheenRough * sheenRough;
    let invAlpha = 1.0 / max(alpha, 1.0e-4);
    let sin2 = max(1.0 - NdotH * NdotH, 0.0);
    let D_sheen = (2.0 + invAlpha) * pow(sin2, invAlpha * 0.5) / (2.0 * PI);
    // Visibility approximation (Neubelt & Pettineo) — cheap enough at
    // factor-level; full Ashikhmin V_charlie can land with the texture
    // slice.
    let V_sheen = 1.0 / (4.0 * (NdotL + NdotV - NdotL * NdotV));
    let sheenBRDF = D_sheen * V_sheen;
    direct = direct + sheenColor * sheenBRDF * light.sunColor *
                       light.sunIntensity * NdotL;
  }
  //>>endif

  // C-R4-GLTF-KHR slice 7 — KHR_materials_volume. Beer-Lambert
  // attenuation on the diffuse contribution as a stand-in for the
  // proper transmission path (which needs KHR_materials_transmission
  // and a refraction render target — full impl deferred). Mirrors the
  // attenuation term of the reference implementation when transmission
  // is 0 and the surface is purely opaque, which is the common case for
  // KHR_materials_volume on glass/translucent assets in our tilesets.
  // C-R4-GLTF-KHR-TRANSMISSION (Batch 105) — KHR_materials_transmission.
  // Transmissive surfaces blend the diffuse contribution with a sample
  // of the refraction texture (a copy of prior-pass scene color),
  // offset along the refracted view direction. This is a simplified
  // path: full physically-correct transmission requires a refraction
  // MRT that captures opaque-only scene color BEFORE transmissive
  // draws — without that capture the sample reads "this draw's own
  // contribution" which double-counts. The capture is the architectural
  // gap the next slice closes; for now the FS samples the placeholder
  // white texture and the transmission factor scales the existing
  // diffuse contribution to "fake" the transmissive look.
  //
  // Branch ordering: applied AFTER volume attenuation so transmissive
  // glass behind volumetric absorption gets the correct double effect.
  //>>ifdef MODEL_HAS_KHR_TEXTURES
  // NEW-KHR-TRANSMISSION-THICKNESS (Batch 176) — pre-compute KHR_volume
  // thickness so BOTH the transmission and volume blocks can consume
  // the same value without duplicating the thicknessTexture sample.
  // Pre-Batch-176 the transmission block used a fixed `0.05` UV offset
  // step regardless of the asset's volume thickness, so a thin glass
  // pane and a thick crystal sphere refracted identically. The volume
  // thickness now modulates the refraction step so thicker geometry
  // bends light more — matching the Khronos KHR_volume spec's
  // expectation that refraction is proportional to the optical path
  // length through the volume.
  //
  // Gated on FLAG_HAS_VOLUME — assets that declare KHR_transmission
  // without KHR_volume don't carry an authored thickness, so the
  // pre-Batch-176 fixed step stays as the fallback for them. Sampled
  // once per fragment regardless of which block(s) consume it.
  var thicknessForKHR: f32 = 0.0;
  if (hasFlag(flags, FLAG_HAS_VOLUME)) {
    let thickTex = textureSampleLevel(
      thicknessTexture, khrSampler, baseColorUV(input), 0.0,
    );
    thicknessForKHR = material.volumeFactors0.x * thickTex.g;
  }

  if (hasFlag(flags, FLAG_HAS_TRANSMISSION)) {
    var trFactor = material.transmissionFactors.x;
    let trTex = textureSampleLevel(
      transmissionTexture, khrSampler, baseColorUV(input), 0.0,
    );
    trFactor = trFactor * trTex.r;
    if (trFactor > 0.0) {
      // Refracted view direction (Snell's law) — IOR encoded on the
      // transmission factor block .y; defaults to 1.5 (standard glass)
      // when the asset doesn't override.
      let ior = max(material.transmissionFactors.y, 1.0);
      let eta = 1.0 / ior;
      let refracted = refract(-V, N, eta);
      // NEW-KHR-TRANSMISSION-THICKNESS (Batch 176) — couple refraction
      // step to volume thickness. `0.05` is the historical baseline
      // (kept small so misaligned reads stay near the original pixel
      // when no thickness is authored). When KHR_volume is active,
      // scale the step by `(1 + 4 × thickness)` so a thickness of
      // ~0.25 doubles the step, ~0.5 triples it, etc. The 4× factor
      // is heuristic — calibrated so a 1m glass pane (typical
      // `thicknessFactor` ~ 0.01-0.05 in normalized model units)
      // produces a barely-visible offset, while a thick sphere
      // (thickness ~ 0.5-1.0) produces a noticeable parallax — both
      // matching artist expectations from the reference impl.
      let baseStep: f32 = 0.05;
      let thicknessStepScale = 1.0 + 4.0 * thicknessForKHR;
      let refractionUV = clamp(
        input.fragCoord.xy / vec2<f32>(
          f32(textureDimensions(refractionSceneTexture).x),
          f32(textureDimensions(refractionSceneTexture).y),
        ) + refracted.xy * (baseStep * thicknessStepScale),
        vec2<f32>(0.0),
        vec2<f32>(1.0),
      );
      let refractedColor = textureSampleLevel(
        refractionSceneTexture, khrSampler, refractionUV, 0.0,
      ).rgb;
      // Blend transmissive lookup with the lit diffuse contribution.
      // Per spec, transmission is applied to the diffuse component only;
      // the specular highlight rides on top via the existing F + specBRDF
      // term (which we leave intact in `direct`).
      let diffuseTransmitted = mix(direct, refractedColor, trFactor);
      direct = diffuseTransmitted;
    }
  }

  if (hasFlag(flags, FLAG_HAS_VOLUME)) {
    let attDistance = material.volumeFactors0.y;
    let attColor = material.volumeFactors1.xyz;
    // NEW-KHR-TRANSMISSION-THICKNESS (Batch 176) — reuse the pre-
    // computed `thicknessForKHR` instead of re-sampling the
    // thicknessTexture. C-R4-GLTF-KHR-TEXTURES (Batch 102) note
    // preserved: per spec the texture stores a unit-normalized
    // thickness scaled by `thicknessFactor`.
    let thickness = thicknessForKHR;
    if (attDistance > 0.0 && thickness > 0.0) {
      let attCoeff = -log(max(attColor, vec3<f32>(1.0e-3))) / attDistance;
      let attenuation = exp(-attCoeff * thickness);
      direct = direct * attenuation;
    }
  }
  //>>endif

  // C-R10-POINT-LIGHT-RECEIVE — when a point-light shadow map is bound,
  // route through cube sampling. Checked BEFORE the CSM gate (only one
  // shadow map is active at a time in Cesium; if both flags ever fire
  // the cube path takes precedence because point lights can't be
  // expressed as cascades). `fragWC` reconstructs the absolute world
  // position from the RTE-encoded model-space delta, in two steps that
  // preserve f32 precision:
  //   1. rotate `rteMC` (model-space RTE = positionMC - encodedCameraMC)
  //      through `material.modelMatrix` with w=0 → world-space camera-
  //      relative direction (rteWC). The matrix's translation column
  //      doesn't contribute, so this is exactly `pWC - camWC`.
  //   2. add `camera.cameraPositionWC` → absolute world position. The
  //      receive math then takes `direction = fragWC - lightWC`, where
  //      both summands are absolute world coords; the subtract collapses
  //      back to a small relative vector well within f32 precision (any
  //      fragment beyond `farPlane = lightRadius` early-outs as lit).
  //
  // Ambient / emissive remain unshadowed per PBR convention.
  if (effects.pointLightControl.x > 0.5) {
    let rteWC = (material.modelMatrix * vec4<f32>(input.rteMC, 0.0)).xyz;
    let fragWC = camera.cameraPositionWC + rteWC;
    let shadowFactor = computeShadowFactorPointLight(fragWC);
    direct = direct * shadowFactor;
  } else if (effects.csmControl.x > 0.5) {
    // CSM Slice 2c — route direct sunlight through the cascaded shadow
    // path when the scene has CSM enabled. Convention matches the
    // primitive receivers: `viewDepth = |positionEC.z|` (eye-space Z in
    // Cesium's looking -Z convention), eyePos = world-space camera-
    // relative vector derived by rotating the model-space RTE through
    // the model matrix (w=0 treats it as a direction, so the model's
    // translation doesn't apply — result is exactly `pWC - camWC`
    // without FP32 reconstruction at Earth scale).
    let rteWC = (material.modelMatrix * vec4<f32>(input.rteMC, 0.0)).xyz;
    let viewDepth = abs(input.positionEC.z);
    let shadowFactor = computeShadowFactorCSM(
      rteWC,
      viewDepth,
      N,
      L,
    );
    direct = direct * shadowFactor;
  }

  // ── Punctual lights (Audit B.3, Batch 131) ───────────────────────────────
  // Accumulate directional / point / spot lights from `scene.lights`.
  // Uses the baseline Cook-Torrance BRDF (Lambert + GGX) without the
  // KHR extensions (anisotropy / clearcoat / sheen apply only to the
  // sun for now -- typical engines treat the directional key light as
  // the dominant material-detail driver and punctual fill as ambient
  // augmentation). Loop is bounded by `light.punctualLightCount` so
  // unused slots don't pay sample cost.
  let pCount = i32(light.punctualLightCount);
  for (var li = 0; li < pCount; li = li + 1) {
    let pl = light.punctualLights[li];
    let pType = i32(pl.lightType);

    // Compute per-light L vector + attenuation. Directional lights use
    // posOrDir as direction (already unit-length from JS pack); point
    // and spot use posOrDir as a world-space position.
    var Lp: vec3<f32>;
    var atten: f32 = 1.0;
    if (pType == 0) {
      // Directional: posOrDir is the direction TOWARD the light source
      // (matches WebGL `light_directional` convention).
      Lp = normalize(pl.posOrDir);
    } else {
      // Point / spot: world-space position. Convert model's fragment
      // position to world via modelMatrix * positionEC, but
      // positionEC is eye-space so we'd need the inverse view -- use
      // the cached `material.modelMatrix * input.rteMC` shortcut +
      // re-add the camera position for absolute world.
      // Reconstruct absolute world-space fragment position:
      //   rteWC = modelMatrix * vec4(rteMC, 0)  (camera-relative WC)
      //   worldFrag = cameraPositionWC + rteWC
      // Mirrors the CSM block's pattern at line ~1913.
      let rteWC = (material.modelMatrix * vec4<f32>(input.rteMC, 0.0)).xyz;
      let worldFrag = camera.cameraPositionWC + rteWC;
      let toLight = pl.posOrDir - worldFrag;
      let dist = length(toLight);
      Lp = toLight / max(dist, 0.0001);
      // Range-based smooth attenuation (glTF KHR_lights_punctual spec
      // uses `1 / d^2` with a smooth `1 - (d / range)^4` cutoff).
      let invSqr = 1.0 / max(dist * dist, 0.0001);
      var rangeFalloff = 1.0;
      if (pl.range > 0.0) {
        let dr = clamp(dist / pl.range, 0.0, 1.0);
        let dr2 = dr * dr;
        rangeFalloff = max(1.0 - dr2 * dr2, 0.0);
        rangeFalloff = rangeFalloff * rangeFalloff;
      }
      atten = invSqr * rangeFalloff;
      // Audit re-review (Batch 134) -- spot cone narrowing using the
      // authored forward direction packed into the per-light record's
      // slot 16-18 (vec3-aligned). `pl.spotDirection` is the spot's
      // pointing vector in world space (normalized at JS construction
      // time). Cosine of the angle between the spot's forward and the
      // direction TO the fragment (-Lp = light->fragment) gives the
      // smoothstep gate between cosOuter and cosInner. Outside the
      // outer cone the result clamps to 0; inside the inner cone it
      // clamps to 1; in between, linear interpolation in cos space.
      if (pType == 2) {
        let cosOuter = cos(pl.outerConeAngle);
        let cosInner = cos(pl.innerConeAngle);
        let spotFwd = normalize(pl.spotDirection);
        let cd = dot(-Lp, spotFwd);
        let cone = smoothstep(cosOuter, cosInner, cd);
        atten = atten * cone;
      }
    }

    let NdotLp = max(dot(N, Lp), 0.0);
    if (NdotLp > 0.0 && atten > 0.0) {
      let Hp = normalize(V + Lp);
      let NdotHp = max(dot(N, Hp), 0.0);
      let VdotHp = max(dot(V, Hp), 0.0);
      // NEW-MODEL-DIRECT-BRDF-PARITY (Batch 355) -- same Smith-joint + f90
      // BRDF as the sun path above, for analytic point/spot lights.
      let alphaRoughnessP = roughness * roughness;
      let Dp = distributionGGX(NdotHp, roughness);
      let Visp = smithVisibilityGGX(alphaRoughnessP, NdotLp, NdotV);
      let reflectanceP = max(F0.r, max(F0.g, F0.b));
      let f90p = vec3<f32>(clamp(reflectanceP * 25.0, 0.0, 1.0));
      let Fp = fresnelSchlick2(F0, f90p, VdotHp);
      let specBRDFp = Fp * Visp * Dp;
      let kDp = vec3<f32>(1.0) - Fp;
      let radiance = pl.color * pl.intensity * atten;
      direct = direct + (kDp * diffuseColor / PI + specBRDFp) * radiance * NdotLp;
    }
  }

  // ── Ambient / IBL ─────────────────────────────────────────────────────────
  // NEW-MODEL-IBL-BRDF-LUT + NEW-MODEL-IBL-REFERENCE-FRAME (Batch 287).
  // Matches WebGL `textureIBL` (ImageBasedLightingStageFS.glsl): the
  // split-sum environment BRDF is looked up from the precomputed LUT
  // (`brdfLutTexture`, R = scale / G = bias) and the diffuse + specular
  // contributions use the Fdez-Aguera single+multi-scatter model rather
  // than the prior `fresnelSchlickRoughness` approximation. Both the
  // diffuse normal and the specular reflection vector are rotated from
  // eye space into the fixed IBL reference frame
  // (`light.iblReferenceFrameMatrix`) BEFORE the cubemap sample, so the
  // reflection stays world-anchored as the camera orbits (previously the
  // eye-space sample rotated the environment with the camera).
  //
  // Roughness-dependent Fresnel from Fdez-Aguera (see
  // https://www.jcgt.org/published/0008/01/03/paper.pdf), matching WebGL's
  // fresnelSchlick2(f0, f90, NdotV) with f90 = max(1 - roughness, f0).
  let f90 = max(vec3<f32>(1.0 - roughness), F0);
  let fresnelT = clamp(1.0 - NdotV, 0.0, 1.0);
  let fresnelT5 = fresnelT * fresnelT * fresnelT * fresnelT * fresnelT;
  let Fr = F0 + (f90 - F0) * fresnelT5;
  let brdfLut = textureSampleLevel(
    brdfLutTexture, brdfLutSampler, vec2<f32>(NdotV, roughness), 0.0
  ).rg;
  let FssEss = Fr * brdfLut.x + brdfLut.y;

  // Diffuse IBL irradiance. SH path is cheaper (constant-time
  // analytic) and lower-frequency; cubemap path is ground-truth for
  // assets without authored SH coefficients. Sample in the fixed IBL
  // reference frame.
  let Nibl = normalize(light.iblReferenceFrameMatrix * N);
  var irradiance: vec3<f32>;
  if (sh.control.w > 0.5) {
    irradiance = evalSphericalHarmonics(Nibl);
  } else {
    irradiance = textureSampleLevel(iblDiffuseTexture, iblSampler, Nibl, 0.0).rgb;
  }
  // Fdez-Aguera multi-scatter diffuse (matches WebGL textureIBL):
  // averageFresnel + Ems multiple-scatter energy compensation, then the
  // dielectric scattering term scaled by the diffuse albedo.
  let averageFresnel = F0 + (vec3<f32>(1.0) - F0) / 21.0;
  let Ems = 1.0 - brdfLut.x - brdfLut.y;
  let FmsEms = FssEss * averageFresnel * Ems / (vec3<f32>(1.0) - averageFresnel * Ems);
  let dielectricScattering = (vec3<f32>(1.0) - FssEss - FmsEms) * diffuseColor;
  let diffuseIBL = irradiance * (FmsEms + dielectricScattering) * light.iblDiffuseFactor;

  // Specular IBL radiance from the prefiltered cubemap. Roughness
  // selects the mip level (mirror = mip 0, fully diffuse = max mip).
  // `textureSampleLevel` is required for explicit lod control; the
  // FS would otherwise get an implicit derivative-based lod that
  // doesn't align with the prefilter's roughness convention.
  var R = reflect(-V, N);
  //>>ifdef MODEL_HAS_KHR_TEXTURES
  // NEW-KHR-ANISO-TANGENT (IBL) — bend the reflection normal for
  // anisotropic materials so the specular IBL streaks along the authored
  // tangent, matching WebGL `ImageBasedLightingStageFS.glsl` USE_ANISOTROPY
  // (lines 78-86). WebGL bends about `anisotropicB = cross(N, rotatedTangent)`
  // (the anisotropy BITANGENT), not the tangent itself — so we compute
  // `cross(N, aniDir)` here. `aniDir` is the authored tangent rotated by the
  // anisotropy rotation, derived exactly as the direct-light block above.
  // `mix(anisotropicNormal, N, bendFactorPow4)` fades the bend out as
  // roughness -> 1 (bendFactorPow4 -> 1 -> unbent N). Gated under
  // MODEL_HAS_KHR_TEXTURES because it samples `anisotropyTexture`.
  if (hasFlag(flags, FLAG_HAS_ANISOTROPY)) {
    let aniTexIBL = textureSampleLevel(
      anisotropyTexture, khrSampler, baseColorUV(input), 0.0,
    );
    let aniRotIBL = material.anisotropyFactors.y +
      atan2(aniTexIBL.g * 2.0 - 1.0, aniTexIBL.r * 2.0 - 1.0);
    let aniStrIBL = material.anisotropyFactors.x * aniTexIBL.b;
    let tanLenSqIBL = dot(input.tangentEC, input.tangentEC);
    var aniTI: vec3<f32>;
    var aniBI: vec3<f32>;
    if (tanLenSqIBL > 1.0e-6) {
      aniTI = input.tangentEC * inverseSqrt(tanLenSqIBL);
      aniBI = normalize(input.bitangentEC);
    } else {
      aniTI = normalize(cross(N, V));
      aniBI = normalize(cross(aniTI, N));
    }
    let aniDirIBL = aniTI * cos(aniRotIBL) + aniBI * sin(aniRotIBL);
    let anisotropyDirection = cross(N, aniDirIBL);
    let anisotropicTangent = cross(anisotropyDirection, V);
    let anisotropicNormal = cross(anisotropicTangent, anisotropyDirection);
    let bendFactor = 1.0 - aniStrIBL * (1.0 - roughness);
    let bendFactorPow4 = bendFactor * bendFactor * bendFactor * bendFactor;
    let bentNormal = normalize(mix(anisotropicNormal, N, bendFactorPow4));
    R = reflect(-V, bentNormal);
  }
  //>>endif
  // Rotate the eye-space reflection into the fixed IBL reference frame so
  // the prefiltered-radiance sample stays world-anchored as the camera
  // orbits (matches WebGL `reflectMC = iblReferenceFrameMatrix * reflectEC`).
  let Ribl = normalize(light.iblReferenceFrameMatrix * R);
  let specLod = roughness * light.iblMaxMipLevel;
  let radiance = textureSampleLevel(
    iblSpecularTexture, iblSampler, Ribl, specLod
  ).rgb;
  // Split-sum specular: radiance * FssEss (already folds the BRDF LUT
  // scale/bias) * the user specular factor. Matches WebGL
  // `specularContribution = radiance * FssEss * model_iblFactor.y`.
  let specularIBL = radiance * FssEss * light.iblSpecularFactor;

  // `diffuseIBL` already carries the full Fdez-Aguera diffuse term
  // (FmsEms + dielectricScattering); add it directly alongside the
  // specular contribution as WebGL does. This MUST match WebGL exactly:
  // `ImageBasedLightingStageFS.glsl::textureIBL` returns
  // `diffuseContribution + specularContribution` and `LightingStageFS.glsl`
  // adds it as `color += computeIBL(...)` — there is NO separate ambient
  // floor. WebGL's ambient IS the IBL.
  //
  // NEW-MODEL-PBR-DIRECT-LIGHT-IBL-PARITY (D2): the previous
  // `+ light.ambientColor * diffuseColor * 0.05` term was a non-physical
  // floor WebGL does not have; it brightened/flattened the at-rest neutral
  // model relative to WebGL. Removed for parity. No fallback floor is needed
  // even when IBL is unconfigured: `diffuseIBL`/`specularIBL` always sample a
  // cubemap (the mid-grey placeholder when no environment is generated — see
  // the placeholder IBL bind-group entries in WebGPUModelRenderer.js), so the
  // ambient is never silently black. Gating a floor on `light.iblHasSH` would
  // re-introduce a code path WebGL lacks and reproduce the same divergence in
  // the SH-less case, so it is deliberately omitted.
  var ambient = diffuseIBL + specularIBL;

  // ── Occlusion ─────────────────────────────────────────────────────────────
  if (hasFlag(flags, FLAG_HAS_OCCLUSION_TEXTURE)) {
    let ao = textureSampleLevel(occlusionTexture, occlusionSampler, occlusionUV(input), 0.0).r;
    ambient = mix(ambient, ambient * ao, material.occlusionStrength);
  }

  // ── Emissive ──────────────────────────────────────────────────────────────
  // Emissive texture is uploaded as `rgba8unorm-srgb`, so textureSample
  // already returns linear values. See the base-color block above for the
  // full rationale on sRGB format selection.
  var emissive = material.emissiveFactor;
  if (hasFlag(flags, FLAG_HAS_EMISSIVE_TEXTURE)) {
    let et = textureSampleLevel(emissiveTexture, emissiveSampler, emissiveUV(input), 0.0).rgb;
    emissive = emissive * et;
  }

  // ── Per-feature styling (3D Tiles batch table) ────────────────────────────
  // Reuse `currentFeatureId` resolved up top so batch lookup and edge
  // gating share one feature-ID texture sample. Features with
  // `batchColor.a == 0` are hidden — discard them.
  var featureColor = vec4<f32>(1.0);
  let hasFeatureIdSource = hasFlag(flags, FLAG_HAS_FEATURE_ID_TEXTURE)
                        || hasFlag(flags, FLAG_HAS_FEATURE_ID_ATTRIBUTE);
  if (hasFeatureIdSource && hasFlag(flags, FLAG_HAS_BATCH_TABLE)) {
    let batchColor = lookupBatchColor(i32(currentFeatureId));
    if (batchColor.a < 0.004) { discard; } // Feature is hidden
    featureColor = batchColor;

    // C-R1-TILE-BATCH (Batch 100) — per-feature alpha-class discard.
    // When the batch table has flipped some features to translucent
    // (their RGBA.a in [0.004, 0.998)) and others to opaque (a >=
    // 0.998), the JS renderer emits two commands per primitive:
    //   - opaque pass    (passClass = 0): keep features with a >= 0.998
    //   - translucent pass (passClass = 1): keep features with a in [0.004, 0.998)
    // Both passes share the same vertex/index buffers and pipeline
    // bindings; only `tileBatchFlags.x` differs. Mirrors WebGL's
    // `tile_translucentCommand` shader uniform path at
    // `Cesium3DTileBatchTable.js:325-326`.
    let opaqueThreshold = max(material.tileBatchFlags.y, 0.5);
    let isTranslucentPass = material.tileBatchFlags.x > 0.5;
    if (isTranslucentPass && batchColor.a >= opaqueThreshold) {
      // Feature is opaque; should land in the opaque pass instead.
      discard;
    }
    if (!isTranslucentPass && batchColor.a < opaqueThreshold) {
      // Feature is translucent; should land in the translucent pass instead.
      discard;
    }
  } else if (hasFlag(flags, FLAG_HAS_BATCH_TABLE)) {
    // Batch table without feature ID texture — use vertex color as proxy
    // (for feature ID attributes passed via batch texture directly)
    // Fall through with featureColor = white (no tinting)
  }

  // ── Final composition ─────────────────────────────────────────────────────
  var color = direct + ambient + emissive;
  color = color * featureColor.rgb;
  color = tonemapAndGamma(color);
  let alpha = select(1.0, baseColor.a, hasFlag(flags, FLAG_ALPHA_MODE_BLEND));
  var finalColor = vec4<f32>(color, alpha * featureColor.a);

  // FEAT-GAP-09 — Aerial-perspective fog blend (Session 34 pattern).
  // Same math as PrimitivePhongTexturedColor but using Model-specific
  // inputs: `input.rteMC` (model-space RTE) rotated through `modelMatrix`
  // gives the world-space camera-relative vector, and `cameraPositionWC`
  // is available directly as a f32 vec3 (no reconstruction needed).
  // Applied AFTER tonemap+gamma so the fog color composites in display space.
  if (effects.atmosphereLutControl.x > 0.5) {
    let innerRadius = effects.atmosphereLutControl.y;
    let thickness = max(1.0, effects.atmosphereLutControl.z);
    let cameraWC = camera.cameraPositionWC;
    let rteWC = (material.modelMatrix * vec4<f32>(input.rteMC, 0.0)).xyz;
    let viewDirWS = normalize(rteWC);
    let upDir = normalize(cameraWC);
    let cosViewZenith = clamp(dot(viewDirWS, upDir), -1.0, 1.0);
    let cameraAltitude = max(0.0, length(cameraWC) - innerRadius);
    let uCoord = clamp(cosViewZenith * 0.5 + 0.5, 0.0, 1.0);
    let vCoord = clamp(cameraAltitude / thickness, 0.0, 1.0);

    let tSample = textureSampleLevel(
      atmosphereTransmittanceLut, atmosphereLutSampler,
      vec2<f32>(uCoord, vCoord), 0.0,
    );
    let iSample = textureSampleLevel(
      atmosphereInscatterLut, atmosphereLutSampler,
      vec2<f32>(uCoord, vCoord), 0.0,
    );
    let transmittance =
      clamp((tSample.r + tSample.g + tSample.b) / 3.0, 0.0, 1.0);

    let excessAltitude = max(0.0, cameraAltitude - thickness);
    let orbitFalloff = exp(-excessAltitude / thickness);

    let fogWeight = clamp(iSample.a, 0.0, 1.0) * orbitFalloff;
    finalColor = vec4<f32>(
      mix(finalColor.rgb, iSample.rgb, fogWeight),
      finalColor.a,
    );
    if (effects.atmosphereLutControl.w > 0.5) {
      finalColor = vec4<f32>(
        finalColor.rgb * mix(1.0, transmittance, fogWeight),
        finalColor.a,
      );
    }
  }

  // C-R8-EDGE-INLINE — final overlay step, after tonemap/gamma + fog so
  // the edge color (already authored in display space by the emitter)
  // composites without a redundant tonemap. WebGL's stage runs in
  // display space too. Applied here for both lit and unlit fragments
  // (the unlit early-out above also calls applyEdgeOverlay before
  // returning).
  finalColor = applyEdgeOverlay(
    finalColor,
    input.positionEC,
    input.fragCoord.xy,
    currentFeatureId,
    edgePixelStep,
  );

  // Slice 5c-B Batch 119 — main lit path: emit the FULL post-normal-map
  // eye-space normal + real material roughness. This is the wide-
  // divergence pixel class the G-buffer was designed for:
  //   - When FLAG_HAS_NORMAL_TEXTURE is set, `N` was perturbed by
  //     perturbNormal() at L1915 using the tangent-space normal map.
  //     This makes per-fragment N diverge SIGNIFICANTLY from the
  //     depth-derived approximation the AO consumer fallback computes.
  //   - `roughness` carries either material.roughnessFactor (metallic-
  //     roughness path) or `clamp(1.0 - gloss, 0.04, 1.0)` (specular-
  //     glossiness path) × the .g channel of the MR texture. Future
  //     consumers (SSR) need this for proper specular response.
  var out: FragOutput;
  out.color = finalColor;
  out.normalRoughness = vec4<f32>(N, roughness);
  //>>ifdef LOG_DEPTH
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
  //>>endif
  return out;
}

// C-R9-MODEL-PICK (Batch 54) — pick fragment entry. Shares the vertex
// stage and bind-group layout with `fragmentMain`; the only differences
// are the fragment entry name and the pick pipeline's blend/depth state
// (no blend, depth write enabled — see WebGPUModelPipelineCache.js).
//
// Correctness:
//   * Alpha-mask discards run (a mask hole must NOT be pickable — it's
//     not visible, so it shouldn't claim the click). Sampled from the
//     base-color texture × baseColorFactor, same as the lit path.
//   * Alpha-blend primitives DO pick on any non-discarded fragment in
//     this first cut. Transparent picking (depth-sorted alpha pick)
//     would need OIT integration on the pick FBO and is tracked as a
//     separate follow-up under `C-R9-MODEL-PICK-TRANSLUCENT`.
//   * Unlit / metallic-roughness / specular-glossiness all share the
//     same alpha-mask path so a single discard block covers them all.
//   * Vertex colors influence baseColor.a the same way they do in the
//     lit path, so vertex-color-driven masking applies to picking too.
//
// Per-feature pick (each glTF feature ID = one pick target instead of
// one primitive = one target) is the larger workstream — picking up
// `EXT_mesh_features` / `EXT_structural_metadata` per-fragment feature
// IDs and rerouting the pick color through the batch table. Tracked
// separately as `C-R9-MODEL-FEATURE-PICK`.
// C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — Option D / hover-pick path.
// Stochastic dither alpha-test for translucent fragments via Interleaved
// Gradient Noise (Jorge Jimenez). Survives with probability = effective
// alpha; multi-frame averaging (under TAA or hover motion) converges to
// the alpha-weighted appearance. Single-pass — no extra render passes,
// no extra MRT targets. Translucent fragments become "opaque or
// discarded" in the pick pass, so the standard depth-test pipeline
// (depthWriteEnabled: true, depthCompare: less-equal) handles winner
// selection naturally. Guaranteed stutter-free at 60fps hover frequency.
//
// Note: dither sample-stability is intentionally per-cursor-position
// — moving the cursor produces different noise patterns across pixels
// (spatial decorrelation), but a stationary cursor yields the same
// pick result on every call (no flickering UI feedback).
fn pickHoverDither(fragCoord: vec2<f32>) -> f32 {
  // Jimenez IGN. Standard formula used by UE4/UE5/Frostbite for
  // dithered transparency. The magic constants come from a low-
  // discrepancy R2 sequence — produces blue-noise-like spectral
  // properties from a single fract() call, no texture lookup.
  return fract(52.9829189 * fract(0.06711056 * fragCoord.x + 0.00583715 * fragCoord.y));
}

@fragment fn fragmentPickHoverMain(input: FragmentInput) -> @location(0) vec4<f32> {
  let flags = material.materialFlags;
  var baseColor = material.baseColorFactor;

  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    baseColor = vec4<f32>(material.diffuseFactor_r, material.diffuseFactor_g,
                          material.diffuseFactor_b, material.diffuseFactor_a);
    if (hasFlag(flags, FLAG_HAS_DIFFUSE_TEXTURE)) {
      let tc = textureSampleLevel(baseColorTexture, baseColorSampler, baseColorUV(input), 0.0);
      baseColor = baseColor * tc;
    }
  } else if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
    let tc = textureSampleLevel(baseColorTexture, baseColorSampler, baseColorUV(input), 0.0);
    baseColor = baseColor * tc;
  }

  if (hasFlag(flags, FLAG_HAS_VERTEX_COLORS)) {
    baseColor = baseColor * input.color0;
  }

  // Alpha-mask discard — same as fragmentPickMain.
  if (hasFlag(flags, FLAG_ALPHA_MODE_MASK)) {
    if (baseColor.a < material.alphaCutoff) { discard; }
  }

  // Stochastic dither for BLEND. Replaces the Batch 186 first-slice
  // `< 0.004` discard. Survival probability = alpha; multi-frame
  // averaging gives the perceptually-correct alpha-weighted pick.
  if (hasFlag(flags, FLAG_ALPHA_MODE_BLEND)) {
    let threshold = pickHoverDither(input.fragCoord.xy);
    if (baseColor.a < threshold) { discard; }
  }

  // Per-feature batch-table hide + pick-color resolution — identical
  // to fragmentPickMain. Duplicated rather than refactored into a
  // helper because WGSL function calls can't return early via
  // `discard`, and refactoring would obscure the discard sites.
  let pickHasFidTex = hasFlag(flags, FLAG_HAS_FEATURE_ID_TEXTURE);
  let pickHasFidAttr = hasFlag(flags, FLAG_HAS_FEATURE_ID_ATTRIBUTE);
  if ((pickHasFidTex || pickHasFidAttr) && hasFlag(flags, FLAG_HAS_BATCH_TABLE)) {
    var fidInt: i32;
    if (pickHasFidTex) {
      let fidSample = textureSampleLevel(featureIdTexture, featureIdSampler, input.texCoord0, 0.0);
      fidInt = unpackFeatureId(fidSample, featureId.channelCount);
    } else {
      fidInt = i32(input.featureId0);
    }
    let batchColor = lookupBatchColor(fidInt);
    if (batchColor.a < 0.004) { discard; }
    if (featureId.featurePickEnabled > 0.5) {
      let featurePickColor = lookupFeaturePickColor(fidInt);
      // C-R9-MODEL-FEATURE-PICK fix — gate on RGB, not alpha (see the
      // detailed note in fragmentPickMain). Pick-ID colors have alpha 0 for
      // keys below 2^24; a valid pickId is identified by nonzero RGB.
      if (featurePickColor.r > 0.0 || featurePickColor.g > 0.0 || featurePickColor.b > 0.0) {
        return featurePickColor;
      }
    }
  }

  return material.pickColor;
}

@fragment fn fragmentPickMain(input: FragmentInput) -> @location(0) vec4<f32> {
  let flags = material.materialFlags;

  // Resolve baseColor.a only — that's all the alpha-mask path needs.
  // Skip every PBR / lighting / IBL / fog / edge stage; the pick FBO
  // doesn't care about anything but `material.pickColor` post-discard.
  var baseColor = material.baseColorFactor;

  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    baseColor = vec4<f32>(material.diffuseFactor_r, material.diffuseFactor_g,
                          material.diffuseFactor_b, material.diffuseFactor_a);
    if (hasFlag(flags, FLAG_HAS_DIFFUSE_TEXTURE)) {
      let tc = textureSampleLevel(baseColorTexture, baseColorSampler, baseColorUV(input), 0.0);
      baseColor = baseColor * tc;
    }
  } else if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
    let tc = textureSampleLevel(baseColorTexture, baseColorSampler, baseColorUV(input), 0.0);
    baseColor = baseColor * tc;
  }

  if (hasFlag(flags, FLAG_HAS_VERTEX_COLORS)) {
    baseColor = baseColor * input.color0;
  }

  // Alpha-mask discard — keep parity with the lit path so masked-out
  // texels (e.g., foliage cutout, decals) never claim the pick.
  if (hasFlag(flags, FLAG_ALPHA_MODE_MASK)) {
    if (baseColor.a < material.alphaCutoff) { discard; }
  }

  // C-R9-MODEL-PICK-TRANSLUCENT (Batch 186) — first slice. BLEND
  // primitives discard near-fully-transparent fragments so glass /
  // water / ghost overlays don't claim the pick over opaque geometry
  // visible through them. The 0.004 cutoff matches the per-feature
  // batch-table hide threshold (`batchColor.a < 0.004 -> discard`)
  // below — it filters numerical noise, not real translucent surfaces.
  // Pairs with the BLEND pick pipeline's `depthWriteEnabled: false`
  // change so depth-test alone picks the closest non-discarded
  // translucent fragment.
  if (hasFlag(flags, FLAG_ALPHA_MODE_BLEND)) {
    if (baseColor.a < 0.004) { discard; }
  }

  // Per-feature batch-table hide also has to gate picking — a feature
  // hidden by `batchColor.a == 0` must not be pickable. Mirrors the
  // discard at the same site in `fragmentMain`.
  //
  // C-R9-MODEL-FEATURE-PICK (Batch 100) — when the batch table is
  // active AND the JS-side allocated per-feature pickIds (signaled by
  // featureId.featurePickEnabled > 0.5), look up the feature's pickColor
  // from the dedicated feature-pick texture instead of returning the
  // primitive-granular `material.pickColor`. The feature-pick texture
  // is laid out the same as the batch texture (one row of RGBA8 entries
  // indexed by featureId, single-line or multi-line layout); the JS
  // renderer uploads it whenever pickIds are allocated/changed for the
  // batch.
  //
  // Falls back to `material.pickColor` when:
  //   - no batch table (single-feature primitives, glTF without
  //     EXT_mesh_features)
  //   - feature-pick texture not yet built (per-feature pick not
  //     opted in by the application)
  //   - feature ID lookup fails (current pixel has no feature ID
  //     attribute / texture sample)
  // Audit B.2 (Batch 130) -- resolve feature ID from EITHER the
  // EXT_mesh_features texture OR the per-vertex _FEATURE_ID_0
  // attribute (b3dm _BATCHID). The attribute branch was the missing
  // piece that left every b3dm tileset stuck on the primitive-
  // granular pick color (no per-feature pick lookup was possible
  // because the texture-only gate never matched).
  let pickHasFidTex = hasFlag(flags, FLAG_HAS_FEATURE_ID_TEXTURE);
  let pickHasFidAttr = hasFlag(flags, FLAG_HAS_FEATURE_ID_ATTRIBUTE);
  if ((pickHasFidTex || pickHasFidAttr) && hasFlag(flags, FLAG_HAS_BATCH_TABLE)) {
    var fidInt: i32;
    if (pickHasFidTex) {
      let fidSample = textureSampleLevel(featureIdTexture, featureIdSampler, input.texCoord0, 0.0);
      fidInt = unpackFeatureId(fidSample, featureId.channelCount);
    } else {
      fidInt = i32(input.featureId0);
    }
    let batchColor = lookupBatchColor(fidInt);
    if (batchColor.a < 0.004) { discard; }
    if (featureId.featurePickEnabled > 0.5) {
      let featurePickColor = lookupFeaturePickColor(fidInt);
      // C-R9-MODEL-FEATURE-PICK fix — gate on RGB, not alpha. Pick-ID colors
      // come from `Color.fromRgba(key)`, which on a little-endian host packs
      // the key low-to-high: red=key&0xff, green=(key>>8)&0xff,
      // blue=(key>>16)&0xff, ALPHA=(key>>24)&0xff. Every key below 2^24
      // (essentially all of them) therefore has alpha 0, so the old
      // `a > 0.004` test fell through to the per-primitive pick color for
      // EVERY feature — the b3dm picks resolved to the Model, not the
      // Cesium3DTileFeature. Unallocated feature texels are (0,0,0,0); a
      // valid pickId has a nonzero key → nonzero RGB. Same RGB!=0 decode as
      // WebGPUPickFramebuffer.pickObjectsFromPixels.
      if (featurePickColor.r > 0.0 || featurePickColor.g > 0.0 || featurePickColor.b > 0.0) {
        return featurePickColor;
      }
    }
  }

  return material.pickColor;
}

// TAA Slice 2e (Batch 106) — velocity-only fragment entry. Writes per-
// pixel screen-space motion to a single rg16float color attachment
// (the scene-FB velocity texture allocated by `ensureVelocityTexture`,
// Batch 104). Selected by the velocity pipeline variant; the velocity
// pass runs after the main color pass and shares scene depth as a
// read-only attachment so fragments occluded by opaque geometry don't
// emit velocity.
//
// Why a separate pass (not single-pass MRT @location(1)): the main
// scene render pass is shared by globe / primitives / billboards /
// model commands, all of which would have to grow a second color
// target on every pipeline variant just to satisfy WebGPU's
// pipeline-vs-renderpass attachment-count parity rule. Routing only
// model commands through a dedicated single-target velocity pass
// keeps the cross-cutting cost zero — the rest of the renderer stays
// 1-target — while still delivering the TAA shader the same per-
// pixel velocity texture it already binds at @binding(5) (Batch 104).
//
// Returns NDC-space delta of (clip.xy/clip.w). The TAA shader's
// `sampleMotionTexture` (Batch 104) converts this to UV delta via
// `* vec2(0.5, -0.5)`. Returns vec2(0) when motion is disabled at
// this primitive (motionFlags.x < 0.5) so static models don't emit
// stale velocity into the texture.
//
// Alpha-mask discards run identical to fragmentMain so masked-out
// texels don't leak velocity into hole pixels. Skips lighting / IBL /
// atmosphere / edge stages — pure motion vector emission.
struct VelocityFragOutput {
  @location(0) velocity: vec2<f32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment fn fragmentVelocityMain(input: FragmentInput) -> VelocityFragOutput {
  let flags = material.materialFlags;

  // Alpha-mask discard parity with the color pass.
  var baseColor = material.baseColorFactor;
  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    baseColor = vec4<f32>(material.diffuseFactor_r, material.diffuseFactor_g,
                          material.diffuseFactor_b, material.diffuseFactor_a);
    if (hasFlag(flags, FLAG_HAS_DIFFUSE_TEXTURE)) {
      let tc = textureSampleLevel(baseColorTexture, baseColorSampler, baseColorUV(input), 0.0);
      baseColor = baseColor * tc;
    }
  } else if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
    let tc = textureSampleLevel(baseColorTexture, baseColorSampler, baseColorUV(input), 0.0);
    baseColor = baseColor * tc;
  }
  if (hasFlag(flags, FLAG_HAS_VERTEX_COLORS)) {
    baseColor = baseColor * input.color0;
  }
  if (hasFlag(flags, FLAG_ALPHA_MODE_MASK)) {
    if (baseColor.a < material.alphaCutoff) { discard; }
  }

  var velOut: VelocityFragOutput;
  //>>ifdef LOG_DEPTH
  velOut.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
  //>>endif
  velOut.velocity = computeMotionVectorScreenSpace(input);
  return velOut;
}

// AUDIT_2026_05_02 A.8 (Batch 142, NEW-MODEL-AS-CLASSIFIER) — classifier
// fragment entry point. Drape the model's shape onto terrain or 3D-Tile
// surfaces by sampling the same packed globe-depth texture the depth-sample
// classifier renderers use (group 3 binding 15) and discarding where the
// sampled depth is 0 (sky / no surface). Color comes from
// `material.baseColorFactor` so the user can tune the drape tint via the
// model's primary material.
//
// Unlike `fragmentMain`, this entry skips PBR / IBL / lighting / shadows /
// edges / atmosphere — it produces a single classification color per pixel.
// The pipeline pairs it with `vertexMain` (existing — the model's geometry
// IS the classifier volume; no separate shadow-volume extrusion is needed
// because the model's mesh already encodes the desired drape shape).
//
// Viewport size is recovered from `textureDimensions(globeDepthTex)`
// instead of a UBO field — the globe depth texture is sized to the
// drawing buffer, identical to the fragment-coordinate space.
@fragment fn fragmentClassificationMain(input: FragmentInput) -> @location(0) vec4<f32> {
  let dims = textureDimensions(globeDepthTex);
  // FragmentInput names the @builtin(position) field `fragCoord` — the
  // earlier `input.position.xy` access didn't compile (struct member
  // not found) and broke 41 demos that pulled this WGSL via the model
  // pipeline (3D Tiles, photogrammetry, point cloud variants, etc.).
  let screenUV = input.fragCoord.xy / vec2<f32>(f32(dims.x), f32(dims.y));
  let packed = textureSampleLevel(globeDepthTex, edgeSampler, screenUV, 0.0);
  let surfaceDepth = unpackEdgeDepth(packed);
  if (surfaceDepth == 0.0) {
    discard;
  }
  // Honor the model's base color factor as the classification tint.
  // KHR_materials_pbrSpecularGlossiness uses `diffuseFactor` instead, so
  // mirror the same fallback the lit FS does when the flag is set.
  let flags = material.materialFlags;
  var tint = material.baseColorFactor;
  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    tint = vec4<f32>(material.diffuseFactor_r, material.diffuseFactor_g,
                     material.diffuseFactor_b, material.diffuseFactor_a);
  }
  return tint;
}
