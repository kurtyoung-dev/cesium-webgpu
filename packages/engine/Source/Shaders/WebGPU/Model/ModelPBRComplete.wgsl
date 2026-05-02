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
  _pad0: f32,
  encodedCameraPositionMCLow: vec3<f32>,
  _pad1: f32,
  cameraPositionWC: vec3<f32>,
  _pad2: f32,
  // DP-H41 (Batch 27) — previous frame's viewProjection for
  // TAA / motion-vector reprojection. Sourced from
  // `UniformState._previousViewProjection` (f32 mat4).
  previousViewProjection: mat4x4<f32>,
};

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

// Joint matrices for skinning (bind group 3, only used when FLAG_HAS_SKINNING is set)
@group(2) @binding(0) var<storage, read> jointMatrices: array<mat4x4<f32>>;

// Morph targets (bind group 4, only used when FLAG_HAS_MORPH_TARGETS is set)
// Storage buffer: per-target blocks of (vertexCount × vec4) position deltas
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
// Storage buffer: array of mat4x4 — one per instance, column-major.
// Instance transform is applied to position/normal/tangent BEFORE morph/skin/RTE.
@group(2) @binding(3) var<storage, read> instanceTransforms: array<mat4x4<f32>>;

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

// ─── Effects bind group (shadow receive + clipping + atmosphere + CSM) ───
// NEW-BG-CONSOLIDATION (2026-04-30): effects binds at @group(3),
// matching the slot the globe terrain renderer uses for the same
// shared BGL. Was @group(7) prior; consolidation merged Model's other
// groups (camera kept at 0; material+textures+featureId merged into 1;
// skinning+morphTarget+instancing merged into 2; effects to 3) so the
// pipeline layout fits within spec-default `maxBindGroups: 4`. Struct
// layout MUST match the 336-byte EffectsUniforms in
// WebGPUEffectsBindGroup.js.
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
  // texCoord1 — glTF textures carry a per-texture `texCoord: 0|1` flag;
  // occlusion and clearcoat-normal commonly use UV set 1. When the
  // primitive has no TEXCOORD_1 accessor, the renderer binds uv0 data
  // into this slot as a safe fallback so samplers whose texCoord flag
  // is 1 degrade to "same UV as 0" rather than failing the bind.
  @location(7) texCoord1: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) positionEC: vec3<f32>,
  @location(1) normalEC: vec3<f32>,
  @location(2) texCoord0: vec2<f32>,
  @location(3) color0: vec4<f32>,
  @location(4) tangentEC: vec3<f32>,
  @location(5) bitangentEC: vec3<f32>,
  @location(6) texCoord1: vec2<f32>,
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
};

@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  var positionMC = input.positionMC;
  var normalMC = input.normalMC;
  var tangentMC = input.tangentMC;

  // ── Morph Targets ─────────────────────────────────────────────────────────
  // Must happen BEFORE skinning per glTF spec: morph → skin → RTE.
  // Reads weighted position deltas from storage buffer, indexed by vertex_index.
  if (hasFlag(material.materialFlags, FLAG_HAS_MORPH_TARGETS)) {
    let targetCount = u32(morphWeights.targetCount);
    let vertexCount = u32(morphWeights.vertexCount);
    let vid = input.vertexIndex;

    for (var t = 0u; t < targetCount; t = t + 1u) {
      // Weight for this target from the packed vec4 arrays
      let w = select(morphWeights.weights0[t], morphWeights.weights1[t - 4u], t >= 4u);
      if (abs(w) > 0.0001) {
        let idx = t * vertexCount + vid;
        let delta = morphDeltas[idx].xyz;
        positionMC = positionMC + delta * w;
      }
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
  // When FLAG_HAS_INSTANCING is set, apply per-instance transform from the
  // storage buffer. This positions each instance in model space.
  // Applied AFTER morph/skinning, BEFORE RTE (matches glTF EXT_mesh_gpu_instancing spec).
  if (hasFlag(material.materialFlags, FLAG_HAS_INSTANCING)) {
    let instMat = instanceTransforms[input.instanceIndex];
    let instMat3 = mat3x3<f32>(instMat[0].xyz, instMat[1].xyz, instMat[2].xyz);
    positionMC = (instMat * vec4<f32>(positionMC, 1.0)).xyz;
    normalMC = instMat3 * normalMC;
    tangentMC = vec4<f32>(instMat3 * tangentMC.xyz, tangentMC.w);
  }

  // RTE in model space: camera is encoded in model coords via inverse(modelMatrix)
  let rte = (positionMC - camera.encodedCameraPositionMCHigh)
          + (vec3<f32>(0.0) - camera.encodedCameraPositionMCLow);

  output.position = camera.mvpRelativeToEye * vec4<f32>(rte, 1.0);
  output.positionEC = (camera.modelViewRelativeToEye * vec4<f32>(rte, 1.0)).xyz;
  output.rteMC = rte;
  output.normalEC = normalize((camera.normalMatrix * vec4<f32>(normalMC, 0.0)).xyz);
  output.texCoord0 = input.texCoord0;
  output.texCoord1 = input.texCoord1;
  output.color0 = input.color0;

  // Tangent/Bitangent for normal mapping
  let tangentEC3 = normalize((camera.normalMatrix * vec4<f32>(tangentMC.xyz, 0.0)).xyz);
  output.tangentEC = tangentEC3;
  output.bitangentEC = cross(output.normalEC, tangentEC3) * tangentMC.w;

  // TAA Slice 2c (Batch 96) — previous-frame clip-space position. Uses
  // the SAME post-skinning / post-morph / post-instancing positionMC as
  // the current frame; pre-skinning prev-frame joint matrices are a
  // Slice 2d concern (treats animated geometry as rigid for now). For
  // rigid models, prev positionMC equals current positionMC and the
  // velocity captures only the model-matrix delta plus the camera
  // motion (`previousViewProjection * previousModelMatrix * worldPos`).
  // Absolute world position uses positionMC directly (RTE encoding is
  // a current-frame optimization; prev-frame uses unencoded positions
  // applied through the prev viewProjection in world space).
  let worldPosCurrent = material.modelMatrix * vec4<f32>(positionMC, 1.0);
  let worldPosPrevious =
    material.previousModelMatrix * vec4<f32>(positionMC, 1.0);
  output.previousClipPos =
    camera.previousViewProjection * worldPosPrevious;
  output.currentClipPosForVelocity =
    camera.mvpRelativeToEye * vec4<f32>(rte, 1.0);

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

// Roughness-aware Fresnel for IBL specular — smoother surfaces reflect more
fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
  let t = clamp(1.0 - cosTheta, 0.0, 1.0);
  let t2 = t * t;
  let oneMinusRoughness = vec3<f32>(1.0 - roughness);
  return F0 + (max(oneMinusRoughness, F0) - F0) * (t2 * t2 * t);
}

fn srgbToLinear(srgb: vec3<f32>) -> vec3<f32> {
  return pow(srgb, vec3<f32>(2.2));
}

fn tonemapAndGamma(color: vec3<f32>) -> vec3<f32> {
  let mapped = color / (color + vec3<f32>(1.0));
  return pow(mapped, vec3<f32>(1.0 / 2.2));
}

fn perturbNormal(nEC: vec3<f32>, tEC: vec3<f32>, bEC: vec3<f32>,
                 normalMap: vec3<f32>, scale: f32) -> vec3<f32> {
  var tn = normalMap * 2.0 - vec3<f32>(1.0);
  tn = vec3<f32>(tn.xy * scale, tn.z);
  tn = normalize(tn);
  let T = normalize(tEC);
  let B = normalize(bEC);
  let N = normalize(nEC);
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
fn lookupBatchColor(fid: i32) -> vec4<f32> {
  let step = featureId.textureStep;
  if (featureId.hasMultilineBatchTex != 0) {
    let dim = featureId.textureDimensions;
    let fidF = f32(fid);
    let st = vec2<f32>(
      (floor(fidF / dim.x) + 0.5) / dim.y,
      (fidF - floor(fidF / dim.x) * dim.x + 0.5) / dim.x
    );
    return textureSample(batchTexture, batchSampler, st);
  }
  // Single-line layout: feature ID maps to x coordinate
  let st = vec2<f32>(step.x * f32(fid) + step.y, 0.5);
  return textureSample(batchTexture, batchSampler, st);
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
    return textureSample(featurePickTexture, featurePickSampler, st);
  }
  let st = vec2<f32>(step.x * f32(fid) + step.y, 0.5);
  return textureSample(featurePickTexture, featurePickSampler, st);
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
  @location(6) texCoord1: vec2<f32>,
  @location(7) rteMC: vec3<f32>,
  // TAA Slice 2c (Batch 96) — interpolated previous- and current-frame
  // clip positions used for per-model motion-vector reconstruction.
  @location(8) previousClipPos: vec4<f32>,
  @location(9) currentClipPosForVelocity: vec4<f32>,
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
  return textureSampleCompareLevel(
    cascadeDepthArray,
    shadowCompSampler,
    uv,
    i32(cascadeIdx),
    depth,
  );
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

  // Compute the depth derivative BEFORE the per-pixel `edgeIdSample.r`
  // branch — `fwidth` requires uniform control flow within a fragment
  // quad. The early-outs above are all on uniform values
  // (edgeControl, viewport), so this point is reached uniformly when
  // edges are enabled and the value is safe to use later inside
  // non-uniform branches.
  let geomDepthLinearEarly = abs(positionEC.z); // looking -Z in EC
  let pixelStep = fwidth(geomDepthLinearEarly);

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
  let useUV1 = (material.texCoordFlags & slotBit) != 0u;
  return select(input.texCoord0, input.texCoord1, useUV1);
}

// AUDIT_2026_05_02 A.6 — port of `Shaders/Model/ModelClippingPlanesStageFS.glsl`
// for the WebGPU model path. WebGL Model rendering supports
// `model.clippingPlanes`; the WebGPU path declared `clippingPlaneTex` at
// `@group(3) @binding(3)` and the `EffectsUniforms.clippingPlaneCount` /
// `clippingUnionMode` / `clippingEdgeWidth` / `clippingEdgeColor` fields
// but never sampled them — model clipping was a complete no-op.
//
// Mirror of `globeClipByPlanes` in `GlobeTerrain.wgsl` adapted for the
// Model FS:
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
fn modelClipByPlanes(positionMC: vec3<f32>) -> f32 {
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
    let dist = dot(positionMC, planeData.xyz) + planeData.w;
    if (dist < minDistance) { minDistance = dist; }
    if (dist < 0.0) {
      clippedCount++;
      if (isUnion) { return -1.0; }
    }
  }
  if (!isUnion && clippedCount == count) { return -1.0; }
  return minDistance;
}

@fragment fn fragmentMain(input: FragmentInput) -> @location(0) vec4<f32> {
  let flags = material.materialFlags;

  // AUDIT_2026_05_02 A.6 — model clipping planes. Reconstruct positionMC
  // from the RTE-encoded model-space position carried via FragmentInput:
  // `rteMC = positionMC - cameraPositionMCHigh - cameraPositionMCLow`,
  // so adding both high/low halves back gives the absolute model-space
  // position for the clip-plane distance test.
  if (effects.clippingPlaneCount > 0u) {
    let positionMCAbs = input.rteMC
      + camera.encodedCameraPositionMCHigh
      + camera.encodedCameraPositionMCLow;
    let clipDist = modelClipByPlanes(positionMCAbs);
    if (clipDist < 0.0) { discard; }
    // Edge band: when the fragment is within `clippingEdgeWidth` of the
    // clip boundary, paint it with the user's edge color. Width is in
    // the same units as `positionMC` (typically meters in model space);
    // this matches the upstream GLSL stage's behavior.
    let edgeWidth = effects.clippingEdgeWidth;
    if (edgeWidth > 0.0 && clipDist < edgeWidth) {
      return effects.clippingEdgeColor;
    }
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
    let fidSampleEarly = textureSample(featureIdTexture, featureIdSampler, input.texCoord0);
    let fidIntEarly = unpackFeatureId(fidSampleEarly, featureId.channelCount);
    currentFeatureId = f32(fidIntEarly);
  }

  // ── Base color ────────────────────────────────────────────────────────────
  var baseColor = material.baseColorFactor;

  // baseColor / diffuse textures are uploaded as `rgba8unorm-srgb`
  // (WebGPUModelRenderer.js createGPUTextureFromReader), so
  // textureSample() already returns linear values. In-shader srgbToLinear
  // (pow(x, 2.2)) would apply the decode twice and darken mid-tones.
  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    baseColor = vec4<f32>(material.diffuseFactor_r, material.diffuseFactor_g,
                          material.diffuseFactor_b, material.diffuseFactor_a);
    if (hasFlag(flags, FLAG_HAS_DIFFUSE_TEXTURE)) {
      let tc = textureSample(baseColorTexture, baseColorSampler, baseColorUV(input));
      baseColor = baseColor * tc;
    }
  } else {
    if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
      let tc = textureSample(baseColorTexture, baseColorSampler, baseColorUV(input));
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
    return applyEdgeOverlay(
      unlitColor,
      input.positionEC,
      input.fragCoord.xy,
      currentFeatureId,
    );
  }

  // ── Normal ────────────────────────────────────────────────────────────────
  var N = normalize(input.normalEC);
  if (hasFlag(flags, FLAG_IS_DOUBLE_SIDED) && !input.frontFacing) { N = -N; }
  if (hasFlag(flags, FLAG_HAS_NORMAL_TEXTURE)) {
    let nm = textureSample(normalTexture, normalSampler, normalUV(input)).rgb;
    N = perturbNormal(N, input.tangentEC, input.bitangentEC, nm, material.normalScale);
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
      let sg = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, metallicRoughnessUV(input));
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
      let mr = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, metallicRoughnessUV(input));
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

  // C-R4-GLTF-KHR slice 5 — KHR_materials_iridescence (factor-level
  // approximation). Full thin-film interference requires per-wavelength
  // optical-path-difference math that's prohibitive without a
  // precomputed LUT — this matches the Khronos reference impl's
  // structure (sample LUT at NdotV, lerp into F0). For Slice 5 we use
  // a hue-shift approximation: blend baseColor toward an HSV-rotated
  // companion driven by `iridescenceFactor` and view angle. Visually
  // imperfect but structurally honest about which extension is firing.
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
    let thickness = mix(
      material.iridescenceFactors.z,
      material.iridescenceFactors.w,
      thickTex.g,
    );
    // Phase-shift driven hue approximation. NdotV gets reused below
    // after V is constructed; precompute here for the F0 modulation.
    let approxNdotV = max(dot(N, normalize(-input.positionEC)), 0.001);
    let phase = (thickness * (irIor - 1.0) * (1.0 - approxNdotV)) / 350.0;
    let irTint = vec3<f32>(
      0.5 + 0.5 * cos(phase * 6.2831853 + 0.0),
      0.5 + 0.5 * cos(phase * 6.2831853 + 2.094395),
      0.5 + 0.5 * cos(phase * 6.2831853 + 4.18879),
    );
    F0 = mix(F0, F0 * irTint, irFactor);
  }

  // ── Cook-Torrance BRDF ────────────────────────────────────────────────────
  let V = normalize(-input.positionEC);
  let L = normalize(light.sunDirectionEC);
  let H = normalize(V + L);
  let NdotL = max(dot(N, L), 0.0);
  let NdotV = max(dot(N, V), 0.001);
  let NdotH = max(dot(N, H), 0.0);
  let VdotH = max(dot(V, H), 0.0);

  let D = distributionGGX(NdotH, roughness);
  let G = geometrySmith(NdotV, NdotL, roughness);
  let F = fresnelSchlick(VdotH, F0);
  let specBRDF = D * G * F / (4.0 * NdotV * NdotL + 0.0001);

  let kD = (vec3<f32>(1.0) - F) * (1.0 - metallic);
  var direct = (kD * diffuseColor / PI + specBRDF) * light.sunColor * light.sunIntensity * NdotL;

  // C-R4-GLTF-KHR slice 4 — KHR_materials_anisotropy (factor-level).
  // Full anisotropic GGX needs the tangent-frame as a per-vertex
  // attribute (not currently passed through `FragmentInput`). For Slice
  // 4 we approximate by stretching the GGX D term along the half-vector
  // projection: rougher highlights along the view's right axis when
  // strength is positive, along the up axis when negative. Visually
  // produces the streak shape brushed-metal assets expect; full per-
  // tangent BRDF lands in a follow-up once tangents are plumbed.
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
    let aniT = normalize(input.tangentEC);
    let aniB = normalize(input.bitangentEC);
    let cosR = cos(aniRotation);
    let sinR = sin(aniRotation);
    let aniDir = aniT * cosR + aniB * sinR;
    let TdotH = dot(aniDir, H);
    let aniRough = mix(roughness, 1.0, abs(TdotH) * aniStrength);
    let Daniso = distributionGGX(NdotH, aniRough);
    let aniBRDF = Daniso * G * F / (4.0 * NdotV * NdotL + 0.0001);
    direct = direct + (aniBRDF - specBRDF) * light.sunColor *
                       light.sunIntensity * NdotL * aniStrength;
  }

  // C-R4-GLTF-KHR slice 2 — KHR_materials_clearcoat. Add a second GGX
  // specular lobe over the base contribution. Clearcoat fresnel uses a
  // fixed F0 = 0.04 (air-coat interface). The base material is
  // attenuated by (1 - F_clearcoat) so high-glance angles bias toward
  // the coat color rather than double-bouncing.
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

  // C-R4-GLTF-KHR slice 6 — KHR_materials_sheen. Charlie BRDF lobe
  // approximated with the Estevez/Kulla Charlie distribution. Energy-
  // additive on top of the base contribution; emulates fabric/velvet
  // retroreflection at grazing angles.
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
      // UV offset — project refracted vector to screen space. Without
      // a thickness sample we use a fixed step (kept small so
      // misaligned refraction reads stay near the original pixel).
      let refractionUV = clamp(
        input.fragCoord.xy / vec2<f32>(
          f32(textureDimensions(refractionSceneTexture).x),
          f32(textureDimensions(refractionSceneTexture).y),
        ) + refracted.xy * 0.05,
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
    var thickness = material.volumeFactors0.x;
    let attDistance = material.volumeFactors0.y;
    let attColor = material.volumeFactors1.xyz;
    // C-R4-GLTF-KHR-TEXTURES (Batch 102) — sample thicknessTexture (G)
    // to modulate per-pixel thickness. Per spec the texture stores a
    // unit-normalized thickness scaled by `thicknessFactor`.
    let thickTex = textureSampleLevel(
      thicknessTexture, khrSampler, baseColorUV(input), 0.0,
    );
    thickness = thickness * thickTex.g;
    if (attDistance > 0.0 && thickness > 0.0) {
      let attCoeff = -log(max(attColor, vec3<f32>(1.0e-3))) / attDistance;
      let attenuation = exp(-attCoeff * thickness);
      direct = direct * attenuation;
    }
  }

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

  // ── Ambient / IBL ─────────────────────────────────────────────────────────
  // Split-sum IBL approximation using Fresnel-roughness awareness.
  // When IBL factors are active (> 0), ambient light varies with roughness
  // and viewing angle for more physically correct results.
  let kS_ibl = fresnelSchlickRoughness(NdotV, F0, roughness);
  let kD_ibl = (vec3<f32>(1.0) - kS_ibl) * (1.0 - metallic);

  // Diffuse IBL: ambient color modulated by diffuse reflectance
  let diffuseIBL = light.ambientColor * diffuseColor * light.iblDiffuseFactor;

  // Specular IBL: roughness-aware Fresnel × ambient, scaled by mip-based factor.
  // Rougher surfaces get less specular ambient, smoother surfaces get more.
  let specLod = roughness * light.iblMaxMipLevel;
  let specAttenuation = 1.0 / (1.0 + specLod * 0.5);
  let specularIBL = light.ambientColor * kS_ibl * specAttenuation * light.iblSpecularFactor;

  var ambient = kD_ibl * diffuseIBL + specularIBL;

  // ── Occlusion ─────────────────────────────────────────────────────────────
  if (hasFlag(flags, FLAG_HAS_OCCLUSION_TEXTURE)) {
    let ao = textureSample(occlusionTexture, occlusionSampler, occlusionUV(input)).r;
    ambient = mix(ambient, ambient * ao, material.occlusionStrength);
  }

  // ── Emissive ──────────────────────────────────────────────────────────────
  // Emissive texture is uploaded as `rgba8unorm-srgb`, so textureSample
  // already returns linear values. See the base-color block above for the
  // full rationale on sRGB format selection.
  var emissive = material.emissiveFactor;
  if (hasFlag(flags, FLAG_HAS_EMISSIVE_TEXTURE)) {
    let et = textureSample(emissiveTexture, emissiveSampler, emissiveUV(input)).rgb;
    emissive = emissive * et;
  }

  // ── Per-feature styling (3D Tiles batch table) ────────────────────────────
  // Reuse `currentFeatureId` resolved up top so batch lookup and edge
  // gating share one feature-ID texture sample. Features with
  // `batchColor.a == 0` are hidden — discard them.
  var featureColor = vec4<f32>(1.0);
  if (hasFlag(flags, FLAG_HAS_FEATURE_ID_TEXTURE) && hasFlag(flags, FLAG_HAS_BATCH_TABLE)) {
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
  );

  return finalColor;
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
      let tc = textureSample(baseColorTexture, baseColorSampler, baseColorUV(input));
      baseColor = baseColor * tc;
    }
  } else if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
    let tc = textureSample(baseColorTexture, baseColorSampler, baseColorUV(input));
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
  if (hasFlag(flags, FLAG_HAS_FEATURE_ID_TEXTURE) && hasFlag(flags, FLAG_HAS_BATCH_TABLE)) {
    let fidSample = textureSample(featureIdTexture, featureIdSampler, input.texCoord0);
    let fidInt = unpackFeatureId(fidSample, featureId.channelCount);
    let batchColor = lookupBatchColor(fidInt);
    if (batchColor.a < 0.004) { discard; }
    if (featureId.featurePickEnabled > 0.5) {
      let featurePickColor = lookupFeaturePickColor(fidInt);
      // Feature-pick texture entries with alpha == 0 mean "no pickId
      // allocated for this feature" — fall through to the per-primitive
      // pick color so the primitive remains pickable.
      if (featurePickColor.a > 0.004) {
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
@fragment fn fragmentVelocityMain(input: FragmentInput) -> @location(0) vec2<f32> {
  let flags = material.materialFlags;

  // Alpha-mask discard parity with the color pass.
  var baseColor = material.baseColorFactor;
  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    baseColor = vec4<f32>(material.diffuseFactor_r, material.diffuseFactor_g,
                          material.diffuseFactor_b, material.diffuseFactor_a);
    if (hasFlag(flags, FLAG_HAS_DIFFUSE_TEXTURE)) {
      let tc = textureSample(baseColorTexture, baseColorSampler, baseColorUV(input));
      baseColor = baseColor * tc;
    }
  } else if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
    let tc = textureSample(baseColorTexture, baseColorSampler, baseColorUV(input));
    baseColor = baseColor * tc;
  }
  if (hasFlag(flags, FLAG_HAS_VERTEX_COLORS)) {
    baseColor = baseColor * input.color0;
  }
  if (hasFlag(flags, FLAG_ALPHA_MODE_MASK)) {
    if (baseColor.a < material.alphaCutoff) { discard; }
  }

  return computeMotionVectorScreenSpace(input);
}
