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
// KHR material extension activation bits. Each block of factor reads and
// extension lighting is gated on the matching bit, so identity-default values
// stay branch-light.
const FLAG_HAS_CLEARCOAT: u32                  = 524288u;  // bit 19
const FLAG_HAS_SPECULAR_EXT: u32               = 1048576u; // bit 20
const FLAG_HAS_ANISOTROPY: u32                 = 2097152u; // bit 21
const FLAG_HAS_IRIDESCENCE: u32                = 4194304u; // bit 22
const FLAG_HAS_SHEEN: u32                      = 8388608u; // bit 23
const FLAG_HAS_VOLUME: u32                     = 16777216u; // bit 24
// Gates the refraction sampling branch. Transmission samples the prior-pass
// scene colour, the refraction MRT, at a refracted UV offset.
const FLAG_HAS_TRANSMISSION: u32               = 33554432u; // bit 25

// ─── Uniform Structures ──────────────────────────────────────────────────────

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  modelViewRelativeToEye: mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  encodedCameraPositionMCHigh: vec3<f32>,
  // Renderer-wide log depth: the lanes at floats 51, 55 and 59 carry the
  // log-depth scalars in `WebGPULogDepth.packCameraLogDepthLanes` order:
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
  // Q13-PLAIN-HDR-GAMMA-CORE — HDR gate at floats 76-79. These bytes were
  // already allocated as trailing padding in the 320-byte camera UB
  // (CAMERA_UNIFORM_SIZE; the struct declared through previousViewProjection
  // is only 304 bytes), so this appends WITHOUT growing the buffer and stays
  // zero (identity) on the default SDR path. x = 1.0 when
  // `scene.highDynamicRange` is on (`frameState.useHDR`), mirroring WebGL's
  // single `HDR` define so `tonemapAndGamma` skips the inline tonemap + gamma
  // encode and hands linear radiance to the post-process Tonemap stage.
  hdrControl: vec4<f32>,
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
  // Primitive-granularity pick colour. The pick fragment entry
  // (`fragmentPickMain`) writes this straight to the pick framebuffer's colour
  // attachment, so readback maps the bytes back to the
  // `{primitive: model, id: <primitiveIndex>}` target registered through
  // `context.createPickId(...)`. The lit fragment entry ignores the slot.
  // Per-feature picking is resolved separately, through the feature-pick
  // texture.
  pickColor: vec4<f32>,
  // KHR_texture_transform: per-texture 3x3 affine UV transforms, combining
  // offset, rotation and scale into one matrix, identity when the extension is
  // absent. Each is stored as three padded vec4 columns so std140 alignment
  // lines up, matching `czm_computeTextureTransform`. Bits in
  // `textureTransformFlags` mark which slots carry a non-identity transform,
  // and the fragment shader skips the multiply for identity slots so the common
  // no-extension case stays branch-light. The bit layout mirrors `texCoordFlags`
  // above: baseColor, normal, metallicRoughness, emissive, occlusion.
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
  // WIRE-MODEL-SILHOUETTE — historical pad lanes (floats 105-107), reused
  // to carry the silhouette scalars. Read only by the `//>>ifdef
  // MODEL_SILHOUETTE` blocks; zero-filled otherwise (packMaterialUniforms).
  //   _pad_tt0 = expandX (proj[0][0] · silhouetteSize · pixelRatio / vpWidth)
  //   _pad_tt1 = expandY (proj[1][1] · same scale)
  //   _pad_tt2 = silhouette-pass flag (0 = base stencil-write pass,
  //              1 = derived silhouette-colour pass)
  _pad_tt0: f32,
  _pad_tt1: f32,
  _pad_tt2: f32,

  // KHR material extension factors. Each block is 8 floats (32 bytes) on a
  // 16-byte boundary so std140 sees a vec4-aligned slot, and identity values
  // are written when the corresponding extension is absent. The fragment shader
  // gates each block on the matching `materialFlags` bit (HAS_CLEARCOAT,
  // HAS_SPECULAR and so on), so identity values are branch-light and the BRDF
  // math never runs.
  //
  // KHR_materials_clearcoat.
  // x: clearcoatFactor [0, 1]
  // y: clearcoatRoughnessFactor [0, 1]
  // z: clearcoatNormalScale, the multiplier applied to the per-fragment normal
  //    when a clearcoat normal map is sampled
  // w: reserved
  clearcoatFactors: vec4<f32>,
  // WIRE-MODEL-SILHOUETTE — historical pad lane (floats 112-115), reused
  // to carry `model.silhouetteColor` RGBA. Read only by the `//>>ifdef
  // MODEL_SILHOUETTE` FS block; zero-filled otherwise (packMaterialUniforms).
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
  // The previous frame's model matrix, for per-model motion vectors.
  //
  // Reprojecting from depth and `previousViewProjection` alone treats animated,
  // skinned and instanced geometry as static, which ghosts their motion. With
  // the previous frame's modelMatrix per primitive the vertex shader can
  // reconstruct the previous clip-space position as
  // `previousViewProjection * previousModelMatrix * positionMC`, which the
  // fragment shader converts to screen-space velocity.
  //
  // The velocity output at `@location(1)` is gated behind `motionFlags.x > 0.5`
  // and is off by default; enabling it requires the second colour attachment on
  // model pipelines.
  previousModelMatrix: mat4x4<f32>,
  // motionFlags.x: motion-vector output enabled (0 / 1)
  // motionFlags.y: motion vector scale (default 1.0)
  // motionFlags.z: the metadata-debug toggle, when MODEL_HAS_METADATA is
  //   active.
  // motionFlags.w: the `ColorBlendMode.getColorBlend(mode, amount)` scalar
  //   (0 = HIGHLIGHT, 1 = REPLACE, (0,1] = MIX). Read only by the
  //   `//>>ifdef MODEL_HAS_COLOR` blocks, and zero otherwise.
  motionFlags: vec4<f32>,
  // Cesium3DTileBatchTable per-feature render state. The batch texture's
  // per-feature RGBA carries an alpha that tile styling can drop below 1 to
  // make individual features translucent. WebGL handles this by emitting two
  // commands — `deriveOpaqueCommand` and `deriveTranslucentCommand` in
  // `Cesium3DTileBatchTable` — so the same primitive draws twice, once per
  // pass, each fragment-shader instance discarding the features of the wrong
  // class.
  //
  // tileBatchFlags layout:
  //   x: passClass (0 = opaque pass, 1 = translucent pass), consumed only when
  //      FLAG_HAS_BATCH_TABLE is set; otherwise a single class draws.
  //   y: the opaque-alpha threshold for the class discard, defaulting to 0.998
  //      to match 3D Tiles' "translucent if tile_translucentCommand and
  //      alpha < 0.998" gate.
  //   z, w: reserved.
  tileBatchFlags: vec4<f32>,
  // Transmission factor and index of refraction:
  //   x: transmissionFactor [0, 1]
  //   y: ior, defaulting to 1.5
  //   z, w: reserved
  transmissionFactors: vec4<f32>,
  // WIRE-MODEL-COLOR — historical reserved tail lane, reused to carry
  // `model.color` RGBA. Read only by the `//>>ifdef MODEL_HAS_COLOR`
  // blocks (applyModelColor); zero-filled otherwise.
  _pad_reserved8: vec4<f32>,
};

// Per-light data matching `LightCollection.pack()`: 20 floats, 80 bytes per
// light. Slot semantics depend on `lightType`:
//   DIRECTIONAL (0) : posOrDir = world direction; spotDirection ignored
//   POINT       (1) : posOrDir = camera-relative world position
//   SPOT        (2) : posOrDir = camera-relative world position;
//                     spotDirection = the world forward the spot is aimed
//                     along; inner and outer cone angles active
//
// Slots 16-18 carry the spot direction at vec3 alignment, the next 16-byte
// boundary after slot 15. Without a direction slot the cone math degenerates to
// point falloff, so the record must stay 20 floats wide.
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
  // Punctual lights from `scene.lights` and glTF KHR_lights_punctual, capped at
  // 8 to match `LightCollection.MAX_LIGHTS` and the JS pack budget.
  //
  // The padding members are discrete f32s rather than a vec3<f32> on purpose: a
  // vec3 would round its alignment up to 16 from offset 68, moving the array's
  // start to byte 96 instead of the byte 80 the JS pack writes. Discrete f32
  // padding keeps the offset at 4-byte alignment.
  punctualLightCount: f32, // i32 stored as f32 (uniform-buffer alignment)
  _pad2a: f32,
  _pad2b: f32,
  _pad2c: f32,
  punctualLights: array<PunctualLight, 8>,
  // The eye-to-IBL-reference-frame rotation, matching WebGL's
  // `model_iblReferenceFrameMatrix` in ImageBasedLightingPipelineStage:
  // `yUpToZUp * transpose(rotation(view3D * referenceMatrix))`.
  //
  // The diffuse normal and specular reflection vectors are computed in eye
  // space, then rotated into the fixed environment frame before the cubemap
  // sample, so IBL reflections stay world-anchored as the camera orbits rather
  // than rotating with it.
  //
  // It sits after the punctual-light array at byte 720, which is 16-aligned,
  // and a mat3x3 occupies 48 bytes as three vec4 columns under std140, making
  // LightUniforms 768 bytes. Identity when no IBL is configured, in which case
  // the fragment shader samples the placeholder cubemap, which is
  // rotation-invariant grey.
  iblReferenceFrameMatrix: mat3x3<f32>,
  // Parallax-corrected localized reflections against a box or sphere proxy,
  // opt-in through `DynamicEnvironmentMapManager.reflectionProxy`. When it is
  // unset, `control.x` packs to 0.0 and the specular-IBL path takes the raw
  // reflection vector; the proxy centre and extents are then ignored, while the
  // eye-to-world rotation stays live for punctual-light frame conversion.
  //
  // When it is set, the reflection ray — fragment world position plus the
  // reflection vector R — is intersected with the bounding proxy and the cube
  // sample direction is re-projected as `normalize(P - proxyCenter)`, so nearby
  // geometry and interiors reflect at the correct parallax rather than as an
  // infinitely distant cube.
  //
  //   control.x : mode (0 = off / raw R, 1 = box, 2 = sphere)
  //   control.y : sphere radius in metres; unused for box
  //   control.z,w : reserved
  //
  // `proxyCenter` and `proxyHalfExtents` are camera-relative world space, the
  // proxy minus the camera position, in the same frame as the fragment's
  // camera-relative world position `rteWC = modelMatrix * vec4(rteMC, 0)`. The
  // box is world-axis-aligned, matching the centre and half-extents the caller
  // supplies. `eyeToWorldRotation` is `UniformState.inverseViewRotation`, used
  // both by punctual lighting and to lift the eye-space reflection R into world
  // space for the intersection; transposing it pushes the corrected world
  // direction back to eye space, so the existing `iblReferenceFrameMatrix * dir`
  // cube-sample path is reused unchanged.
  //
  // Reference: Lagarde and Zanuttini, "Local Image-based Lighting With
  // Parallax-corrected Cubemaps" (SIGGRAPH 2012).
  reflectionProxyControl: vec4<f32>,
  reflectionProxyCenter: vec3<f32>,
  reflectionProxyHalfExtents: vec3<f32>,
  eyeToWorldRotation: mat3x3<f32>,
};

// Group 0 carries the two blocks that belong to the (model, view) pair rather
// than to any primitive: the relative-to-eye camera and the light. Both are
// packed once per model per view into the shared per-frame ring and addressed
// by dynamic offset through `WebGPUModelCameraArena`. The light's punctual
// positions, proxy centre and eye-to-world rotation are all relative to the
// same encoded eye the camera block carries, so keeping them in one bind group
// makes that pairing structural. Group 1 stays purely per-primitive.
@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> light: LightUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

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
// KHR extension primary textures and their shared sampler. Each binds a 1x1
// white placeholder when the matching extension is absent, and the fragment
// shader gates every sample on the extension's HAS_* flag so the placeholder is
// never read. See `WebGPUModelPipelineCache`'s `materialBGL` for why the
// sampler is shared.
//
// The `//>>ifdef MODEL_HAS_KHR_TEXTURES` wrapper lets the basic shader variant
// strip these 14 bindings — 12 textures, the sampler and 2 transmission slots —
// dropping the sampled-texture count from 23 to 10 and fitting the WebGPU spec
// floor of `maxSampledTexturesPerShaderStage = 16` for materials with no KHR
// extension. The renderer pairs the stripped shader with `materialBGL_basic`
// and the basic pipeline layout.
//>>ifdef MODEL_HAS_KHR_TEXTURES
@group(1) @binding(12) var clearcoatTexture: texture_2d<f32>;
@group(1) @binding(13) var specularColorTexture: texture_2d<f32>;
@group(1) @binding(14) var anisotropyTexture: texture_2d<f32>;
@group(1) @binding(15) var iridescenceTexture: texture_2d<f32>;
@group(1) @binding(16) var sheenColorTexture: texture_2d<f32>;
@group(1) @binding(17) var thicknessTexture: texture_2d<f32>;
// KHR secondary maps, following the same placeholder and flag-gated convention
// as the primary KHR slots.
@group(1) @binding(18) var clearcoatRoughnessTexture: texture_2d<f32>;
@group(1) @binding(19) var clearcoatNormalTexture: texture_2d<f32>;
@group(1) @binding(20) var sheenRoughnessTexture: texture_2d<f32>;
@group(1) @binding(21) var specularFactorTexture: texture_2d<f32>;
@group(1) @binding(22) var iridescenceThicknessTexture: texture_2d<f32>;
@group(1) @binding(23) var khrSampler: sampler;
// The refraction texture — a copy of the prior-pass scene colour — and the
// transmission factor map. The scene renderer captures scene colour into a
// dedicated refraction texture before the transmissive draw and binds it here.
// When KHR_materials_transmission is inactive the placeholder white texture
// binds, and FLAG_HAS_TRANSMISSION gates the branch so its content is unused.
@group(1) @binding(24) var transmissionTexture: texture_2d<f32>;
@group(1) @binding(25) var refractionSceneTexture: texture_2d<f32>;
//>>endif

// Joint matrices for skinning (bind group 3, only used when FLAG_HAS_SKINNING is set)
@group(2) @binding(0) var<storage, read> jointMatrices: array<mat4x4<f32>>;
// Previous-frame joint matrices for TAA velocity. The vertex shader re-runs
// skinning against these to produce `prevPositionMC`; without them
// `worldPosPrevious = previousModelMatrix * currentSkinnedPositionMC` yields a
// phantom velocity that ghosts across animated characters.
@group(2) @binding(4) var<storage, read> previousJointMatrices: array<mat4x4<f32>>;

// Morph targets (bind group 4, only used when FLAG_HAS_MORPH_TARGETS is set)
// Storage buffer: per-target blocks of (vertexCount × 3 × vec4) — for each
//   vertex an interleaved [positionDelta, normalDelta, tangentDelta] triple.
//   Index via base = (t * vertexCount + vid) * 3u; positionDelta =
//   morphDeltas[base], normalDelta = morphDeltas[base + 1u], tangentDelta =
//   morphDeltas[base + 2u]. The CPU pack, `FLOATS_PER_VERTEX_PER_TARGET = 12`
//   in WebGPUModelMorphTargets, must stay byte-consistent with this 3u stride.
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
// The per-instance translation is split relative-to-eye. It places each
// instance at its tile-relative ECEF offset, which at Earth scale (~6.4e6 m)
// overflows f32's ~2^23 mantissa and loses about a metre of sub-metre
// precision. Carrying the translation as a single f32 column and adding it to
// the local vertex position before the camera subtract destroys those bits
// before they can cancel, which shows as i3dm jitter under a stationary camera.
// So the rotation-and-scale linear part stays f32, where its magnitude is small
// enough to carry no precision risk, while the translation travels as a
// high/low pair split on the CPU, letting the vertex shader subtract the
// encoded camera through translateRelativeToEye.
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

// Previous-frame morph weights for the velocity pass. The vertex shader runs
// morph twice, current and previous, so animated blendshapes produce a correct
// per-vertex velocity instead of stretching the current pose against the
// previous frame's model matrix.
@group(2) @binding(5) var<uniform> previousMorphWeights: MorphWeightsUniforms;
// Previous-frame instance transforms. For static GPU instancing this aliases
// the current `instanceTransforms` buffer, so the previous pass produces the
// same world-space position as the current one and velocity collapses to the
// camera and model-matrix delta alone. An animated EXT_mesh_gpu_instancing
// asset would publish a separate previous buffer to get per-frame per-instance
// velocity.
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
  // When above 0.5 the pick fragment entry routes through
  // `lookupFeaturePickColor`, reading the per-feature pick texture, instead of
  // returning `material.pickColor`. `ensurePerFeaturePickIds` sets it whenever
  // it allocates per-feature pickIds, and leaves it clear otherwise so no
  // bandwidth is spent sampling a placeholder texture.
  featurePickEnabled: f32,
  _pad1: f32,
};
@group(1) @binding(26) var featureIdTexture: texture_2d<f32>;
@group(1) @binding(27) var featureIdSampler: sampler;
@group(1) @binding(28) var batchTexture: texture_2d<f32>;
@group(1) @binding(29) var batchSampler: sampler;
@group(1) @binding(30) var<uniform> featureId: FeatureIdUniforms;
// Per-feature pick colour lookup table. The layout matches the batch texture:
// RGBA8, one-dimensional for small feature counts and two-dimensional past 1024
// features. featureId 0 maps to texel (0.5 / W, 0.5 / H) and featureId N to
// ((N + 0.5) / W, ...). An entry with alpha 0 means no pickId was allocated, and
// the pick fragment entry falls through to `material.pickColor`. It carries real
// data only when `featureId.featurePickEnabled > 0.5`; the placeholder
// feature-id bind group holds a 1x1 transparent texel, so the binding is always
// valid.
@group(1) @binding(31) var featurePickTexture: texture_2d<f32>;
@group(1) @binding(32) var featurePickSampler: sampler;

// IBL cubemap bindings: the irradiance cubemap at 33 for diffuse ambient, the
// prefiltered radiance cubemap at 34 for specular ambient with mip-based
// roughness rangefinding, and a shared sampler at 35 that the pipeline cache
// configures linear and clamp-to-edge. The SH coefficients at 36 are optional,
// flagged active in slot 9.w; when active they short-circuit the irradiance
// cubemap sample with a 9-coefficient evaluation against the surface normal.
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

// The split-sum environment BRDF integration LUT: rg32float, 256x256, produced
// once by `WebGPUBrdfLutGenerator`. R is the scale factor for F0 and G the
// bias, indexed by (NdotV, roughness), consumed in the specular-IBL term as
// `radiance * (FssEss = F0 * scale + bias)` to match `computeSpecularIBL` and
// `textureIBL` in ImageBasedLightingStageFS.glsl.
//
// rg32float is non-filterable without the `float32-filterable` feature, so the
// sampler at binding 38 is non-filtering; the table is smooth enough that
// nearest sampling is visually indistinguishable.
@group(1) @binding(37) var brdfLutTexture: texture_2d<f32>;
@group(1) @binding(38) var brdfLutSampler: sampler;

// Effects bind group: shadow receive, clipping, atmosphere and CSM.
//
// Effects binds at `@group(3)`, the same slot the globe terrain renderer uses
// for this shared layout. The model's groups are consolidated to fit the
// spec-default `maxBindGroups: 4` — camera at 0; material, textures and
// featureId merged into 1; skinning, morph targets and instancing merged into
// 2; effects at 3. The struct layout must match the 480-byte EffectsUniforms in
// WebGPUEffectsBindGroup, whose tail carries the polygon-clipping atlas control
// and per-extent UV remap.
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
  // Inline edge-stage control. .x = edgeReady, gating the inline stage;
  // .y = isEdgePass, always 0 from the model fragment shader and kept for
  // parity with caller-driven gating; .z and .w = the current frustum's near
  // and far.
  edgeControl: vec4<f32>,
  // .xy = viewport (px), .z = relative depth tolerance, .w =
  // hasEdgeFeatureId flag.
  edgeViewport: vec4<f32>,
  // Point-light cube shadow control.
  // .x = enabled flag. Above 0.5 the receive shader takes the cube path; it is
  //      checked before the CSM gate so it wins when both are set. Only one
  //      shadow map is active at a time, so that only matters during
  //      transitions.
  // .y = farPlane, `shadowMap._pointLightRadius` in metres.
  // .z = nearPlane, 1.0 for `computeOmnidirectional`, kept explicit so a
  //      tunable near plane needs no uniform-buffer change.
  // .w = depthBias, subtracted from refDepth before the comparison sample to
  //      suppress shadow acne — the same role as `pointBias.depthBias` in the
  //      WebGL ShadowMap pipeline.
  pointLightControl: vec4<f32>,
  // .xyz = light position relative to the active camera origin, in world
  // axes. JavaScript subtracts f64 ECEF positions before f32 packing; the
  // receive shader subtracts the camera-relative fragment directly.
  // .w = PCF radius, in cube-face texels. The receive shader converts texels
  //      to a projected cube-face shift of `2 * radius / shadowMapSize.x`. 0.0
  //      selects hard sampling with a single tap; above 0 activates the 5-tap
  //      cross PCF kernel. This is not the same role as
  //      `effects.shadowDarkness`: darkness drives `mix()` in the caller, while
  //      pcfRadius drives kernel width here.
  pointLightPositionRTE: vec4<f32>,
  // Polygon-clipping atlas control and per-extent UV remap.
  // .x = extentsCount, the number of merged-extent groups in the SDF atlas.
  //      Polygons whose spherical bounding rectangles overlap are coalesced
  //      into one group on the CPU; see `ClippingPolygonCollection.getExtents`.
  // .y = the atlas inverse dimension, precomputed as `1.0 / dim` where `dim` is
  //      `ceil(log2(extentsCount))` above 2 and `extentsCount` otherwise. This
  //      saves a per-fragment log2.
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
// Inline edge-detection resources. The edge MRT views populate at the start of
// `_execute3DTilePasses`, before the model's OPAQUE pass, and the globe
// packed-depth view is produced by `WebGPUGlobeDepth.executeCopyDepth` earlier
// still. The sampler at 16 is shared filtering. The call site gates on
// `effects.edgeControl.x > 0.5`, so placeholder 1x1 transparent textures never
// influence the lit fragment.
@group(3) @binding(12) var edgeColorTex: texture_2d<f32>;
@group(3) @binding(13) var edgeIdTex: texture_2d<f32>;
@group(3) @binding(14) var edgeDepthTex: texture_2d<f32>;
@group(3) @binding(15) var globeDepthTex: texture_2d<f32>;
@group(3) @binding(16) var edgeSampler: sampler;
// Six-face cube depth, populated by `_renderPointLightCubeCastPasses` in
// WebGPUShadowMapRenderer and sampled through `samplePointShadow` below when
// `effects.pointLightControl.x > 0.5`. It reuses `shadowCompSampler` at binding
// 2 for the comparison sample. The placeholder is a 1x1x6 cube cleared to 1.0,
// so depth reads as the far plane, no occluder is closer than the light radius,
// and the fragment is lit by default.
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
  // glTF textures carry a per-texture texCoord flag of 0 or 1, and occlusion
  // and clearcoat-normal maps commonly use UV set 1. The
  // `//>>ifdef MODEL_HAS_TEXCOORD_1` wrapper keeps primitives without
  // TEXCOORD_1 from allocating a vertex buffer slot for it, which matters
  // against a `maxVertexBuffers = 8` adapter cap. The fragment-shader reads of
  // `input.texCoord1` are wrapped too, falling back to `texCoord0` when the
  // attribute is not bound.
  //>>ifdef MODEL_HAS_TEXCOORD_1
  @location(7) texCoord1: vec2<f32>,
  //>>endif
  // Per-vertex feature ID; the loader renames b3dm's `_BATCHID` to
  // `_FEATURE_ID_0`. It is cast to f32 for varying-friendly transport and the
  // fragment shader converts back to u32 for the batch and pick texture
  // lookups, gating the read on `FLAG_HAS_FEATURE_ID_ATTRIBUTE` so the zero
  // default never reaches a lookup when no feature ID is present.
  //
  // The declaration is variant-conditional: a primitive with no `_FEATURE_ID_0`
  // or `_BATCHID` accessor omits vertex buffer slot 8 — see
  // `createVertexBufferLayout` in `WebGPUModelPipelineCache` — and stripping
  // this keeps the WGSL in sync with the bound buffer count. Most glTF models
  // carry no feature IDs, so the common-case pipeline drops its eighth vertex
  // slot and clears the 8-slot adapter cap with headroom.
  //>>ifdef MODEL_HAS_FEATURE_ID_0
  @location(8) featureId0: f32,
  //>>endif
  // The EXT_structural_metadata property-attribute value,
  // `WebGPUModelMetadata.ensureMetadataResources` uploads into vertex buffer
  // slot 9. Conditional on MODEL_HAS_METADATA, so models without metadata never
  // allocate the slot and the common-case layout stays under the
  // `maxVertexBuffers = 8` cap.
  //
  // The renderer packs up to four components of the first GPU-compatible
  // property attribute per vertex, with normalized integers already decoded to
  // f32 on the CPU per the glTF `accessor.normalized` rule, and scalars
  // zero-padding `.yzw`. The generated `initializeMetadata` from
  // MetadataWGSLPipelineStage swizzles the transported components into the
  // property's real WGSL type.
  //>>ifdef MODEL_HAS_METADATA
  @location(9) metadataValue: vec4<f32>,
  // The widened transport for MAT3 and MAT4 property attributes: the slot-9
  // vertex buffer's arrayStride grows to 64 and carries four float32x4
  // attributes at locations 9-12, offsets 0, 16, 32 and 48 — 16 column-major
  // matrix elements per vertex, with MAT3 zero-padding elements 9 to 15.
  // Stripped for every scalar, vector and MAT2 metadata model, which keep the
  // single-vec4 layout.
  //>>ifdef MODEL_METADATA_MAT_TRANSPORT
  @location(10) metadataValue1: vec4<f32>,
  @location(11) metadataValue2: vec4<f32>,
  @location(12) metadataValue3: vec4<f32>,
  //>>endif
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
  // The previous-frame and matched-current clip positions, for per-model
  // motion-vector reconstruction. The current clip position duplicates what
  // `output.position` already holds; carrying it separately keeps the
  // previous-frame reprojection self-contained when MRT velocity output is
  // enabled, rather than overloading `output.position`'s semantics. Both are
  // homogeneous clip space, and the fragment shader divides by `.w` before
  // taking the screen-space delta.
  @location(8) previousClipPos: vec4<f32>,
  @location(9) currentClipPosForVelocity: vec4<f32>,
  // `@interpolate(flat)` so each fragment sees its provoking vertex's integer
  // feature ID rather than an average across the triangle. The fragment shader
  // converts back with `u32(featureId0)`.
  @location(10) @interpolate(flat) featureId0: f32,
  //>>ifdef LOG_DEPTH
  // Interpolated linear depthFromNearPlusOne; FS converts to frag_depth.
  @location(11) v_logDepth: f32,
  //>>endif
  // The flat-interpolated metadata value carried from vertex to fragment stage,
  // a vec4 because up to four property components travel per vertex.
  // `@interpolate(flat)` matches property-attribute semantics: a metadata value
  // is per-vertex, and flat picks the provoking vertex. Location 12 sits above
  // featureId0 at 10 and v_logDepth at 11.
  //>>ifdef MODEL_HAS_METADATA
  @location(12) @interpolate(flat) metadataValue: vec4<f32>,
  // The widened MAT3 and MAT4 transport carries three more flat vec4 varyings
  // at locations 13-15. With LOG_DEPTH active that lands exactly on the WebGPU
  // spec floor of 16 inter-stage variables.
  //>>ifdef MODEL_METADATA_MAT_TRANSPORT
  @location(13) @interpolate(flat) metadataValue1: vec4<f32>,
  @location(14) @interpolate(flat) metadataValue2: vec4<f32>,
  @location(15) @interpolate(flat) metadataValue3: vec4<f32>,
  //>>endif
  //>>endif
};

// `struct Metadata`, `fn initializeMetadata(...)` and
// `fn metadataDebugScalar(...)` are generated per metadata class by
// `Scene/Model/MetadataWGSLPipelineStage.generateMetadataWGSL` and prepended at
// the single injection point in
// `WebGPUModelPipelineCache._getOrCreateShaderModule`. Declaring them here as
// well would double-declare `struct Metadata`, so only the call site lives in
// this file, gated by `//>>ifdef MODEL_HAS_METADATA`:
//
//   - a model with metadata has the generated chunk prepended, so the struct,
//     initializer and accessor exist and the gated call site uses them;
//   - a model without metadata leaves the bit clear, so the prepended chunk is
//     the empty string and the call site is stripped, leaving preprocessed WGSL
//     byte-identical to a build with no metadata support and sharing its
//     compiled module.

@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  var positionMC = input.positionMC;
  var normalMC = input.normalMC;
  var tangentMC = input.tangentMC;

  // Morph targets. The glTF specification requires this before skinning: morph,
  // then skin, then subtract the camera. Weighted position and normal deltas
  // are read from the storage buffer, indexed by vertex_index. The buffer
  // interleaves a [positionDelta, normalDelta, tangentDelta] triple per vertex
  // per target, so morphed normals re-shade the deformed surface — freezing
  // them at the rest pose leaves a morph-animated mesh lit for a shape it no
  // longer has. Normal accumulation is additive, and a no-op for targets with
  // no NORMAL accessor, whose packed delta is zero.
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
        // Accumulate the morph TANGENT delta — xyz only, preserving the `.w`
        // handedness — so a normal-mapped morphed mesh re-derives its tangent
        // frame, matching getMorphedTangent. Zero for targets and models with
        // no TANGENT.
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

  // GPU instancing. When FLAG_HAS_INSTANCING is set, the per-instance transform
  // from the storage buffer positions each instance in model space, applied
  // after morph and skinning and before the camera subtract, as
  // EXT_mesh_gpu_instancing requires.
  //
  // Only the linear rotation-and-scale part multiplies the local vertex
  // position here; the CPU zeroes `linear`'s column 3. The per-instance
  // translation travels as a high/low pair and folds into the camera subtract
  // below rather than being added in f32. Adding the full Earth-scale
  // translation to the local position in single precision loses about a metre
  // before the camera can cancel it, which shows as i3dm jitter under a
  // stationary camera; keeping `positionMC` at local magnitude through the
  // subtract preserves sub-metre precision.
  var instTransHigh = vec3<f32>(0.0);
  var instTransLow = vec3<f32>(0.0);
  // PARITY-METADATA-TABLE-INSTANCE-SOURCE — per-instance feature ID transported
  // in the translationHigh.w pad (see WebGPUModelInstancing.writeInstance). Stays
  // 0 for non-instanced models and for instanced models without instance feature
  // IDs, so the featureId0 varying is byte-identical there.
  var instanceFeatureId0: f32 = 0.0;
  if (hasFlag(material.materialFlags, FLAG_HAS_INSTANCING)) {
    let inst = instanceTransforms[input.instanceIndex];
    let linear3 = mat3x3<f32>(inst.linear[0].xyz, inst.linear[1].xyz, inst.linear[2].xyz);
    positionMC = linear3 * positionMC;
    normalMC = linear3 * normalMC;
    tangentMC = vec4<f32>(linear3 * tangentMC.xyz, tangentMC.w);
    instTransHigh = inst.translationHigh.xyz;
    instTransLow = inst.translationLow.xyz;
    instanceFeatureId0 = inst.translationHigh.w;
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

  // Compute prevPositionMC by re-running the morph, skin and instance pipeline
  // with previous-frame data at every stage:
  //   - morph weights from `previousMorphWeights` (binding 5)
  //   - joint matrices from `previousJointMatrices` (binding 4)
  //   - instance transforms from `previousInstanceTransforms` (binding 6)
  //
  // For a rigid model — neither skinned, morphed nor instanced — all three
  // previous buffers default to their current counterparts, so prevPositionMC
  // equals positionMC and velocity captures only the model-matrix delta and
  // camera motion. An animated rig gets a correct per-vertex motion vector
  // across the full deformation pipeline.
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
        // The storage buffer interleaves [position, normal, tangent] triples,
        // so step the same 3u stride as the current-frame block. The
        // previous-frame velocity path needs only the position delta.
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
    // Reconstruct the full previous-frame model-space position from the split
    // struct. This path multiplies by `previousModelMatrix` at full magnitude
    // below rather than relative to the eye, so the translation is recombined
    // as a full f32 position here. The residual metre of precision loss does
    // not matter for motion vectors, and under static instancing the previous
    // buffer aliases the current one, so instancing contributes no velocity at
    // all.
    let prevInst = previousInstanceTransforms[input.instanceIndex];
    let prevLinear3 = mat3x3<f32>(
      prevInst.linear[0].xyz, prevInst.linear[1].xyz, prevInst.linear[2].xyz);
    prevPositionMC = prevLinear3 * prevPositionMC
                   + prevInst.translationHigh.xyz + prevInst.translationLow.xyz;
  }

  // Previous- and current-frame world positions feed the fragment shader's
  // reprojection. Both take the unencoded-position-times-matrix path; the
  // relative-to-eye form is a current-frame optimization the previous-frame
  // multiply does not share.
  let worldPosCurrent = material.modelMatrix * vec4<f32>(positionMC, 1.0);
  let worldPosPrevious =
    material.previousModelMatrix * vec4<f32>(prevPositionMC, 1.0);
  output.previousClipPos =
    camera.previousViewProjection * worldPosPrevious;
  output.currentClipPosForVelocity =
    camera.mvpRelativeToEye * vec4<f32>(rte, 1.0);

  // Pass the per-vertex feature ID to the fragment stage as a flat-interpolated
  // varying, so the provoking vertex's value wins for the whole triangle. That
  // matches per-feature semantics: a feature spans whole triangles and never
  // crosses one.
  //
  // Conditional on MODEL_HAS_FEATURE_ID_0. A primitive with no feature-ID
  // accessor — the common case for glTF models without batching — omits slot 8
  // from the vertex layout, so `input.featureId0` does not exist and the
  // fragment stage receives a zero default. The fragment shader reads
  // `featureId0` only when `FLAG_HAS_FEATURE_ID_ATTRIBUTE` is set in
  // `material.materialFlags`, so that default never reaches a lookup.
  //>>ifdef MODEL_HAS_FEATURE_ID_0
  output.featureId0 = input.featureId0;
  //>>else
  // PARITY-METADATA-TABLE-INSTANCE-SOURCE — with no per-vertex `_FEATURE_ID_0`
  // attribute, the feature ID for an instanced primitive comes from the
  // per-instance pad slot (0 otherwise → identical to the historical default).
  output.featureId0 = instanceFeatureId0;
  //>>endif

  // Forward the per-vertex metadata value to the fragment stage. With
  // MODEL_HAS_METADATA clear this is stripped entirely and no
  // `output.metadataValue` member exists.
  //>>ifdef MODEL_HAS_METADATA
  output.metadataValue = input.metadataValue;
  //>>ifdef MODEL_METADATA_MAT_TRANSPORT
  output.metadataValue1 = input.metadataValue1;
  output.metadataValue2 = input.metadataValue2;
  output.metadataValue3 = input.metadataValue3;
  //>>endif
  //>>endif

  //>>ifdef MODEL_SILHOUETTE
  // WIRE-MODEL-SILHOUETTE — the derived silhouette-colour command's
  // material UB sets `_pad_tt2 = 1`; inflate the clip position along the
  // eye-space normal (WebGL ModelSilhouetteStageVS.glsl parity — the
  // helper chunk is prepended by the pipeline cache when the
  // MODEL_SILHOUETTE bit is set). The base stencil-write command keeps
  // `_pad_tt2 = 0` and is untouched. Uses the post-morph/skin/instance
  // `normalMC`, matching WebGL's processed `attributes.normalMC`.
  if (material._pad_tt2 > 0.5) {
    output.position = modelSilhouetteStageVS(
      output.position,
      normalMC,
      camera.normalMatrix,
      vec2<f32>(material._pad_tt0, material._pad_tt1),
    );
  }
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

  // PARITY-CUSTOM-SHADER-WGSL — native-WGSL customShader vertex hook. Only
  // emitted when the customShader supplies `wgslVertexShaderText` (the generated
  // chunk defines `czm_customVertexMain`); the JS side never sets
  // MODEL_HAS_WGSL_CUSTOM_VERTEX otherwise, so this block is stripped and the
  // vertex stage is byte-identical for fragment-only + non-customShader models.
  //>>ifdef MODEL_HAS_WGSL_CUSTOM_VERTEX
  {
    var csVsInput: czm_customVertexInput;
    csVsInput.attributes.positionMC = positionMC;
    csVsInput.attributes.normalEC = output.normalEC;
    csVsInput.attributes.texCoord_0 = output.texCoord0;
    csVsInput.attributes.color_0 = output.color0;
    var csVsOutput: czm_customVertexOutput;
    csVsOutput.positionMC = positionMC;
    czm_customVertexMain(csVsInput, &csVsOutput);
  }
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

// Height-correlated Smith-joint visibility, byte-faithful to
// `smithVisibilityGGX` in pbrLighting.glsl. Returns
// `Vis = G / (4 * NdotL * NdotV)` with the `1 / (4 * NdotL * NdotV)`
// denominator folded in, so callers multiply D * Vis * F with no separate
// `/ (4 * NdotV * NdotL)` term. `alphaRoughness` is perceptualRoughness
// squared, the same convention the GLSL path passes. The direct-light paths use
// this rather than the separable Schlick-GGX `geometrySmith`, which clearcoat
// still uses.
//
// Reference: Heitz, "Understanding the Masking-Shadowing Function in
// Microfacet-Based BRDFs" (JCGT 2014).
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

// Fresnel-Schlick with an explicit f90 reflectance, byte-faithful to
// `fresnelSchlick2` in pbrLighting.glsl. The direct-light paths pass
// `f90 = clamp(maxComponent(F0) * 25, 0, 1)`, so a near-zero-reflectance
// dielectric tapers its grazing response instead of taking the bare
// `fresnelSchlick`'s implicit `f90 = 1`, which is always white at grazing.
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

// Box and sphere parallax correction.
//
// Given a fragment world position `originWC` in camera-relative world space and
// a world-space reflection direction `dirWC`, intersect the reflection ray with
// the bounding proxy and return the re-projected cube sample direction
// `normalize(P - proxyCenter)`. `mode` is 1 for box and 2 for sphere, and the
// proxy centre and half-extents live in the same camera-relative world frame as
// `originWC`.
//
// It falls back to the raw `dirWC` when the ray misses the proxy or the
// geometry degenerates, so a misplaced proxy can never produce a NaN sample
// direction. The box uses the standard slab method; the sphere uses the
// analytic ray-sphere far hit, since the reflection always exits the proxy in
// front of the surface.
fn parallaxCorrectReflection(
  originWC: vec3<f32>,
  dirWC: vec3<f32>,
  mode: f32,
  proxyCenter: vec3<f32>,
  proxyHalfExtents: vec3<f32>,
  proxyRadius: f32,
) -> vec3<f32> {
  if (mode < 1.5) {
    // Box proxy — slab method. Guard against a zero reflection component so
    // 1/dir doesn't yield Inf; a near-zero lane simply contributes no bound.
    let safeDir = vec3<f32>(
      select(dirWC.x, 1.0e-5, abs(dirWC.x) < 1.0e-5),
      select(dirWC.y, 1.0e-5, abs(dirWC.y) < 1.0e-5),
      select(dirWC.z, 1.0e-5, abs(dirWC.z) < 1.0e-5),
    );
    let invDir = vec3<f32>(1.0) / safeDir;
    let boxMin = proxyCenter - proxyHalfExtents;
    let boxMax = proxyCenter + proxyHalfExtents;
    let t1 = (boxMin - originWC) * invDir;
    let t2 = (boxMax - originWC) * invDir;
    let tMaxV = max(t1, t2);
    // Nearest positive exit distance along the reflection ray.
    let tHit = min(min(tMaxV.x, tMaxV.y), tMaxV.z);
    if (tHit <= 0.0) {
      return dirWC;
    }
    let hitP = originWC + dirWC * tHit;
    let corrected = hitP - proxyCenter;
    if (dot(corrected, corrected) < 1.0e-12) {
      return dirWC;
    }
    return normalize(corrected);
  }
  // Sphere proxy — analytic ray-sphere, take the far (exit) intersection.
  let oc = originWC - proxyCenter;
  let b = dot(oc, dirWC);
  let c = dot(oc, oc) - proxyRadius * proxyRadius;
  let disc = b * b - c;
  if (disc <= 0.0) {
    return dirWC;
  }
  let tHit = -b + sqrt(disc);
  if (tHit <= 0.0) {
    return dirWC;
  }
  let hitP = originWC + dirWC * tHit;
  let corrected = hitP - proxyCenter;
  if (dot(corrected, corrected) < 1.0e-12) {
    return dirWC;
  }
  return normalize(corrected);
}

// L2 spherical-harmonic irradiance. Nine coefficients across three bands give a
// low-frequency analytic approximation of diffuse irradiance from any
// direction — cheaper than a 32x32 cubemap convolution sample, and sufficient
// for ambient lighting, which carries no high-frequency detail. The coefficient
// order matches `ImageBasedLightingPipelineStage`'s packing, so one SH set
// serves both backends.
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
  // WebGL LightingStageFS applies tonemap (czm_pbrNeutralTonemapping) +
  // linearToSrgb encode ONLY when HDR is off (`#ifndef HDR`). Under
  // `scene.highDynamicRange` the frame buffer is linear and the
  // post-process chain does the tonemap + gamma — so the inline pair is
  // SKIPPED. Q13-PLAIN-HDR-GAMMA-CORE mirrors that: when `camera.hdrControl.x`
  // is raised (`frameState.useHDR`), return the raw linear color and let the
  // post-process Tonemap stage compress it. Without this gate the model was
  // tonemapped twice under plain `scene.highDynamicRange = true` (inline here
  // AND in the post-process pass). Default SDR path (gate 0) is unchanged.
  if (camera.hdrControl.x > 0.5) {
    return max(color, vec3<f32>(0.0));
  }
  let mapped = pbrNeutralTonemap(max(color, vec3<f32>(0.0)));
  return pow(mapped, vec3<f32>(1.0 / 2.2));
}

// Raw screen-space tangent direction and UV-jacobian determinant for the
// tangent-less normal-mapping fallback.
//
// This must be called from uniform control flow: it uses the derivative
// built-ins dpdx and dpdy, which WGSL forbids under non-uniform control flow.
// `perturbNormal` is reached through non-uniform branches — the double-sided
// `frontFacing` flip and the unlit early-out — so the derivatives cannot live
// inside it. Instead this is invoked once at the uniform entry of
// `fragmentMain`, mirroring the hoisted `edgePixelStep = fwidth(...)`, and its
// result is passed down.
//
// The formula is `computeTangent()` from MaterialStageFS.glsl. The
// orthogonalization and handedness happen in `perturbNormal`, so both backends
// agree on the normal-map green-channel sign and stay close over a tangent-less
// asset.
//
// Returns xyz as the raw tangent direction, before orthogonalization and before
// the divide, and w as the UV-jacobian determinant, used both to finish that
// divide and to detect degenerate UV gradients.
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

  // Screen-space derivative tangent frame. `derivedTangent` is the raw tangent
  // and UV-jacobian determinant `deriveTangentRaw` computed at the uniform
  // entry of `fragmentMain`.
  //
  // This is the fallback for a glTF primitive that declares a normal texture
  // without a TANGENT vertex accessor. The vertex path then computes
  // `tangentEC = normalize(normalMatrix * tangentMC)` over a zero tangent, so
  // `normalize(vec3(0))` makes the tEC and bEC arriving here NaN rather than
  // zero. Falling back to the flat geometric normal keeps lighting correct but
  // loses all normal-map surface detail; orthogonalizing the derived tangent
  // against N and taking `B = cross(N, T)` — WebGL's computeTangent path
  // byte for byte — preserves the detail with matching handedness. No
  // derivatives are taken here; they were already taken in uniform control flow
  // upstream.
  let det = derivedTangent.w;
  let tRaw = derivedTangent.xyz / det;
  let Td = normalize(tRaw - N * dot(N, tRaw));
  let Bd = normalize(cross(N, Td));

  // NaN-safe degeneracy test: `length(NaN)` is NaN and `NaN > 1e-4` is false,
  // so `!(len > 1e-4)` catches both the zero-length case (len == 0) and the NaN
  // case. A plain `len < 1e-4` would miss NaN, because `NaN < 1e-4` is also
  // false.
  let tlen = length(tEC);
  let blen = length(bEC);
  var T: vec3<f32>;
  var B: vec3<f32>;
  if (!(tlen > 1e-4) || !(blen > 1e-4)) {
    // No usable vertex tangent, so use the derived screen-space frame. Guard
    // degenerate UV derivatives, where det is near zero and tRaw is
    // non-finite: with no UV gradient there is no recoverable tangent, so keep
    // the flat geometric normal rather than emit a NaN.
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

// Per-feature pick colour lookup, with the same layout and addressing as
// `lookupBatchColor` but reading the per-feature pick texture. The pick
// fragment entry calls this when `featureId.featurePickEnabled > 0.5` and the
// batch table is bound.
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
  // Interpolated previous- and current-frame clip positions, used for per-model
  // motion-vector reconstruction.
  @location(8) previousClipPos: vec4<f32>,
  @location(9) currentClipPosForVelocity: vec4<f32>,
  // The flat-interpolated per-feature ID, b3dm's `_BATCHID`. Read by
  // fragmentMain for the batch-styling discard and by fragmentPickMain for the
  // per-feature pick lookup, when FLAG_HAS_FEATURE_ID_ATTRIBUTE is set.
  @location(10) @interpolate(flat) featureId0: f32,
  //>>ifdef LOG_DEPTH
  @location(11) v_logDepth: f32,
  //>>endif
  // The flat-interpolated metadata value, stripped when MODEL_HAS_METADATA is
  // clear so a model without metadata keeps an unchanged FragmentInput layout.
  //>>ifdef MODEL_HAS_METADATA
  @location(12) @interpolate(flat) metadataValue: vec4<f32>,
  // Locations 13-15 carry the widened MAT3 and MAT4 transport's remaining 12
  // matrix elements; see VertexOutput.
  //>>ifdef MODEL_METADATA_MAT_TRANSPORT
  @location(13) @interpolate(flat) metadataValue1: vec4<f32>,
  @location(14) @interpolate(flat) metadataValue2: vec4<f32>,
  @location(15) @interpolate(flat) metadataValue3: vec4<f32>,
  //>>endif
  //>>endif
  @builtin(front_facing) frontFacing: bool,
};

// Converts the interpolated current and previous clip-space positions into a
// screen-space velocity, an NDC delta in [-1, 1] by [-1, 1] units. Returns
// vec2(0) when motion-vector output is disabled, or when either clip position
// is degenerate with w <= 0. The caller owns the `@location(1)` MRT plumbing;
// this helper is pure math with no effect on the colour path.
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

// ─── Single shadow-map sampling ──────────────────────────────────────────────
//
// The default WebGPU scene shadow route is one fitted directional/spot map.
// `effects.shadowMatrix` transforms the fragment's eye-space position into
// that light's clip space, matching the globe receiver. CSM and point lights
// have their own explicit controls and take priority at the call site.

fn sampleSingleShadow(positionEC: vec3<f32>) -> f32 {
  let shadowPos = effects.shadowMatrix * vec4<f32>(positionEC, 1.0);
  // Already in WebGPU shadow-texture space: the NDC-to-texture scale and bias
  // come from `ShadowMap.getViewProjection`, and the v-origin flip from
  // `toWebGPUShadowReceiveMatrix`. A second `*0.5 + 0.5` here would sample the
  // wrong quadrant.
  let coord = shadowPos.xyz / shadowPos.w;
  let uv = coord.xy;
  let outOfBounds =
    uv.x < 0.0 || uv.x > 1.0 ||
    uv.y < 0.0 || uv.y > 1.0 ||
    coord.z < 0.0 || coord.z > 1.0;

  if (effects.shadowSoftShadows <= 0.5) {
    let visibility = textureSampleCompareLevel(
      shadowDepthTex,
      shadowCompSampler,
      uv,
      coord.z,
    );
    return select(visibility, 1.0, outOfBounds);
  }

  let texelSize = 1.0 / max(effects.shadowMapSize, vec2<f32>(1.0));
  var visibility = 0.0;
  for (var x: i32 = -1; x <= 1; x++) {
    for (var y: i32 = -1; y <= 1; y++) {
      let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
      visibility = visibility + textureSampleCompareLevel(
        shadowDepthTex,
        shadowCompSampler,
        uv + offset,
        coord.z,
      );
    }
  }
  return select(visibility * (1.0 / 9.0), 1.0, outOfBounds);
}

fn computeShadowFactorSingle(positionEC: vec3<f32>) -> f32 {
  if (effects.shadowDarkness >= 1.0) {
    return 1.0;
  }
  let visibility = sampleSingleShadow(positionEC);
  return mix(effects.shadowDarkness, 1.0, visibility);
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

// Cube shadow sampling.
//
// Mirrors the USE_CUBE_MAP_SHADOW path in `shadowVisibility.glsl` and
// `shadowDepthCompare.glsl`, adapted to WebGPU's `texture_depth_cube` and
// `textureSampleCompareLevel` semantics. The cast pipeline writes
// standard window-space depth (the context-owned WebGPU clip convention
// produces a [0,1] z_ndc, and the convention-aware NDC→texture transform
// preserves that z range before landing in the depth32float attachment)
// for each cube face using
// `near=1.0`, `far=lightRadius`, FOV=π/2 (see `computeOmnidirectional`
// in ShadowMapComputations.js). Receive math has to round-trip the
// SAME perspective-Z formula and depth convention, otherwise
// every fragment compares unequal against the texel and the scene
// renders fully shadowed or fully lit by accident.
//
// Reference depth derivation (matches the WebGPU-mode perspective in
// `Matrix4.computePerspectiveFieldOfView` plus the convention-aware
// NDC-to-texture matrix in `ShadowMap.js`):
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
//   z_attached = z_ndc_webgpu                 (already [0,1])
//
// The cube sample direction must be in world axes (NOT eye axes). Both the
// fragment and light operands are camera-relative, so camera translation
// cancels in `direction = fragRTE - lightRTE`. Magnitude is irrelevant —
// `textureSampleCompareLevel` normalizes internally for cube samplers.
//
// Per-fragment performance: one direction subtract, one length for the
// spherical light-volume gate, one max3 for the dominant projection axis,
// one division for the perspective-Z, and one cube sample.
// Cheaper than CSM (no cascade loop, no eye-space → cascade-clip
// transform).
fn samplePointShadow(fragRTE: vec3<f32>) -> f32 {
  let lightRTE = effects.pointLightPositionRTE.xyz;
  let direction = fragRTE - lightRTE;
  let absDir = abs(direction);
  let lightDistanceSquared = dot(direction, direction);
  // Dominant cube-face axis distance. `axisDist` is what the per-face
  // camera saw as |z_eye| for this fragment; the perspective-Z formula
  // below converts it to the depth value the cast pipeline wrote.
  let axisDist = max(absDir.x, max(absDir.y, absDir.z));
  let nearPlane = effects.pointLightControl.z;
  let farPlane = effects.pointLightControl.y;
  let depthBias = effects.pointLightControl.w;
  // The point-light radius is spherical. Keep dominant-axis distance for the
  // cube-camera perspective depth below, but use squared Euclidean distance
  // to reject diagonal fragments outside the light volume without a sqrt.
  if (lightDistanceSquared >= farPlane * farPlane) { return 1.0; }
  // Standard perspective-Z formula, WebGPU [0,1] convention. The
  // cast pipeline output values in this range too because it constructs the
  // projection with the owning context's WebGPU clip-space convention.
  let depthRange = farPlane - nearPlane;
  let zNdcWebGpu =
    farPlane / depthRange - (farPlane * nearPlane) / (axisDist * depthRange);
  // The convention-aware shadow transform preserves WebGPU z in [0,1].
  let zAttached = zNdcWebGpu;
  let refDepth = clamp(zAttached - depthBias, 0.0, 1.0);
  // Soft point-light shadows through a 5-tap cross PCF.
  //
  // `effects.pointLightPositionRTE.w` carries the PCF radius in cube-face
  // texels; 0 selects hard sampling and the typical soft setting is 1.0 to 2.0
  // texels. A zero radius drops straight through to the single comparison
  // sample, at identical cost and output to the hard-edge path.
  //
  // Above zero, the cube direction is perturbed along the two minor axes — the
  // ones that are not the dominant face axis. That keeps the perturbation
  // tangent to the cube face the dominant ray hits, so all five samples land on
  // the same face's depth texels instead of spilling into a neighbouring face,
  // where they would compare against a perspective-Z written by a different
  // per-face camera and band at the seams.
  //
  // Perturbation magnitude: a cube face spans projected coordinates [-1, 1],
  // so one texel is 2/N. The sample direction is meter-scale; multiplying by
  // axisDist makes the projected minor-axis shift exactly
  // `2 * radiusTexels / shadowMapSize.x`.
  let pcfRadius = effects.pointLightPositionRTE.w;
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
  let offset =
    2.0 * axisDist * pcfRadius / max(effects.shadowMapSize.x, 1.0);
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

fn computeShadowFactorPointLight(fragRTE: vec3<f32>) -> f32 {
  if (effects.shadowDarkness >= 1.0) { return 1.0; }
  let visibility = samplePointShadow(fragRTE);
  return mix(effects.shadowDarkness, 1.0, visibility);
}

// Inline edge detection.
//
// A WGSL port of `EdgeDetectionStageFS.glsl`, run inline inside the model
// fragment shader — see the `applyEdgeOverlay` call site in fragmentMain — so
// per-feature gating, edge colour and alpha all see the correct fragment
// context. A post-process overlay composite cannot, because per-fragment
// featureId is not available at composite time.
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
// Per-feature gating:
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

  // Compare the edge's stored featureId against the current fragment's.
  // 16-bit IDs are split across `id.g` as the low byte and `id.b` as the high
  // byte, each stored normalized to 0..1, and recomposed as
  // `low + high * 256` after denormalizing both channels, which round-trips
  // integer IDs 0..65535 exactly. Past 65535 the emitter saturates and IDs
  // become indistinguishable; that only arises for tilesets that would strain
  // the GPU batch-table side as well.
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

// Port of `Shaders/Model/ModelClippingPlanesStageFS.glsl` for the WebGPU model
// path, backing `model.clippingPlanes`.
//
// `WebGPUClippingPlaneCollection` uploads the planes in `clippingPlaneTex` in
// EYE SPACE, so that the fragment test `dot(eyePos, plane.xyz) + plane.w`
// matches the frame of `eyePos`. The fragment-side test must therefore consume
// eye-space position, never model-space; a reconstructed model-space position
// produces silently wrong output rather than an error.
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
// Polygon SDF clipping for models. Mirrors
// `Shaders/Model/ModelClippingPolygonsStageVS.glsl` for region selection and
// `Shaders/Builtin/Functions/clipPolygons.glsl` for atlas sampling, folded into
// one fragment function because the WebGPU model path has no separate clipping
// vertex pass.
//
// The input is a WORLD-space position, in metres from the Earth's centre. It is
// converted to approximate spherical (lat, lon) with the same
// `czm_fastApproximateAtan2` curve the SDF compute pass packs against; exact
// `atan2` and `asin` would mismatch the precomputed extents at sub-texel scale.
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
// Coverage is capped at 8 merged-extent groups. The CPU coalesces overlapping
// polygons into one extent group, so a typical cutaway scene with one to four
// polygons consumes one to four groups. A scene with more than 8 disjoint
// polygon groups misses the overflow; the JS side warns once about it.
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
  // A fragment outside every region's bounding rectangle must still respect the
  // inverse flag. The default cutout mode treats it as outside the polygon and
  // keeps it; inverse mode treats it as outside the polygon and discards it.
  // That matches the `czm_clipPolygons` early-return path, which runs
  // `#ifdef CLIPPING_INVERSE discard; #endif return;` when `regionIndex < 0` or
  // `rectUv` falls outside [0,1]. Returning `false` unconditionally here leaks
  // the whole outside-the-polygon region in inverse mode, so a "show only
  // inside" configuration renders everything.
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

// G-buffer MRT output for the model colour pipeline: slot 0 is the lit colour
// and slot 1 the eye-space normal plus roughness, packed as rgba16float.
//
// The model path is the most valuable G-buffer producer because its
// per-fragment N can be post-normal-map — FLAG_HAS_NORMAL_TEXTURE routes
// through perturbNormal — which diverges fundamentally from the depth-derived
// approximation an AO consumer falls back to. Its roughness is real material
// data too, the metallicRoughness texture's green channel times
// `material.roughnessFactor`, rather than the 0.5 placeholder other primitives
// emit.
//
// The pick, velocity and classification entry points stay single-target. They
// build their own pipelines against the pick, velocity and classification
// framebuffers rather than the scene framebuffer, so they need no slot 1
// declaration.
//>>ifdef MODEL_HAS_COLOR
// The `model.color`, `colorBlendMode` and `colorBlendAmount` blend, matching
// `ModelColorStageFS.glsl` exactly. Two lanes of the material uniform block
// carry it: `_pad_reserved8` holds the model colour RGBA and `motionFlags.w`
// the `ColorBlendMode.getColorBlend(mode, amount)` scalar, where 0 is
// HIGHLIGHT, 1 is REPLACE and (0,1] is a MIX amount. HIGHLIGHT makes the mix()
// a no-op and lets the ceil() select the multiply-by-colour term; REPLACE and
// MIX blend toward the colour and multiply by 1.
fn applyModelColor(color: vec4<f32>) -> vec4<f32> {
  let modelColor = material._pad_reserved8;
  let colorBlend = material.motionFlags.w;
  var diffuse = mix(color.rgb, modelColor.rgb, colorBlend);
  let highlight = ceil(colorBlend);
  diffuse = diffuse * mix(modelColor.rgb, vec3<f32>(1.0), highlight);
  return vec4<f32>(diffuse, color.a * modelColor.a);
}
//>>endif

struct FragOutput {
  @location(0) color: vec4<f32>,
  //>>ifdef CAPTURE_MODE
  //>>else
  @location(1) normalRoughness: vec4<f32>,
  //>>endif
  //>>ifdef LOG_DEPTH
  // Written for the depth TEST as well (frag_depth replaces rasterized z)
  // so translucent model passes test correctly against log scene depth.
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment fn fragmentMain(input: FragmentInput) -> FragOutput {
  let flags = material.materialFlags;
  //>>ifdef MODEL_SPLIT_ENABLED
  // WIRE-MODEL-SPLITTER — model.splitDirection FS discard (WebGL
  // `ModelSplitterStageFS.glsl` parity). The material UB pad lanes carry
  // the two scalars: `_pad_end2` = splitDirection (-1 LEFT / +1 RIGHT),
  // `_pad_end3` = czm_splitPosition (`frameState.splitPosition *
  // drawingBufferWidth`, framebuffer pixels — the same space as
  // fragCoord.x, matching WebGL's `gl_FragCoord.x > czm_splitPosition`).
  if (material._pad_end2 < 0.0 && input.fragCoord.x > material._pad_end3) { discard; }
  if (material._pad_end2 > 0.0 && input.fragCoord.x < material._pad_end3) { discard; }
  //>>endif

  // Geometric normal hoisted for the early-exit returns: the clipping edge band
  // and the unlit path. The main lit path computes its own `N`, which may be
  // post-normal-map, and returns that along with the real material roughness
  // rather than these placeholders.
  let geomNormalEC = normalize(input.normalEC);

  // Hoist fwidth() to uniform control flow at the entry of the fragment
  // shader. WGSL requires fwidth to be called from uniform control flow,
  // and the edge overlay (which uses pixelStep) is invoked from the
  // FLAG_IS_UNLIT early-out branch which the compiler can't prove is
  // uniform across the quad. Computing it once at the top sidesteps
  // the issue. Cost: every fragment computes pixelStep even when the
  // edge stage is disabled — negligible (one fwidth, ~2 ALU).
  let edgePixelStep = fwidth(abs(input.positionEC.z));

  // Hoist the screen-space derivative tangent to uniform control flow, for the
  // same reason as edgePixelStep above: the tangent-less normal-map fallback in
  // perturbNormal needs dpdx and dpdy of position and UV, but perturbNormal is
  // reached through non-uniform branches — the double-sided `frontFacing`
  // normal flip and the unlit early-out — so WGSL rejects derivative built-ins
  // inside it. The raw frame is computed here at the uniform entry and threaded
  // down.
  //
  // Two UV sets: the base normal map uses `normalUV`, and the rare clearcoat
  // normal uses `baseColorUV` to mirror its existing sampling site. The cost is
  // a handful of ALU per fragment even with no normal texture bound, and the
  // unconditional evaluation is what the uniformity guarantee requires.
  let normalDerivTangent = deriveTangentRaw(input.positionEC, normalUV(input));
  let clearcoatDerivTangent = deriveTangentRaw(input.positionEC, baseColorUV(input));

  // Per-fragment UV derivatives, taken at fragment entry while control flow is
  // still uniform, following the same pattern as `GlobeTerrain.wgsl`. The
  // material texture samples below use `textureSampleGrad(..., d_dx, d_dy)`
  // rather than `textureSampleLevel(..., 0.0)`, so the sampler picks the correct
  // mip from the generated chain; that removes minification shimmer on distant
  // geometry and matches WebGL trilinear.
  //
  // `textureSampleGrad` is the only mip-selecting sampler legal to call after
  // this shader's non-uniform discards for clipping and alpha-mask, but the
  // derivatives it consumes must be taken here, in uniform control flow. There
  // is one pair per material UV set: each `*UV()` returns the
  // KHR_texture_transform-transformed coordinate actually fed to the sampler,
  // so its derivative is the gradient of the transformed UV, which is what
  // trilinear selection needs.
  //
  // The cost is a handful of ALU per fragment even when a slot's texture is
  // unbound, and the unconditional evaluation is what the WGSL uniformity
  // guarantee requires. Data-lookup samples — batch table, featureId,
  // feature-pick, edge, globe-depth, SDF, clipping, IBL explicit-LOD,
  // atmosphere LUT and refraction screen-space — deliberately stay at LOD 0.
  let baseColorUV_dx = dpdx(baseColorUV(input));
  let baseColorUV_dy = dpdy(baseColorUV(input));
  let normalUV_dx = dpdx(normalUV(input));
  let normalUV_dy = dpdy(normalUV(input));
  let mrUV_dx = dpdx(metallicRoughnessUV(input));
  let mrUV_dy = dpdy(metallicRoughnessUV(input));
  let emissiveUV_dx = dpdx(emissiveUV(input));
  let emissiveUV_dy = dpdy(emissiveUV(input));
  let occlusionUV_dx = dpdx(occlusionUV(input));
  let occlusionUV_dy = dpdy(occlusionUV(input));

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
      // Clipping edge: no material work has run yet, so there is no PBR result
      // and no normal map. Emit the geometric vertex normal and a 0.5 roughness
      // placeholder. The edge band is thin — `clippingEdgeWidth` is around a
      // metre in eye space — so the placeholder costs consumers little.
      var out: FragOutput;
      out.color = effects.clippingEdgeColor;
      //>>ifdef CAPTURE_MODE
      //>>else
      out.normalRoughness = vec4<f32>(geomNormalEC, 0.5);
      //>>endif
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

  // Resolve the current fragment's featureId, if any, up front, so both
  // per-feature batch styling and the inline edge-detection stage can consume
  // it without a redundant texture sample. It stays 0.0 when the model has no
  // feature ID texture, and both consumers then degrade to "no feature".
  //
  // Feature IDs are integers in glTF EXT_mesh_features, but they are carried as
  // f32 here because the edge texture's `id.g` channel is an 8-bit normalized
  // float; matching keeps both sides of the comparison in one encoding.
  var currentFeatureId: f32 = 0.0;
  if (hasFlag(flags, FLAG_HAS_FEATURE_ID_TEXTURE)) {
    let fidSampleEarly = textureSampleLevel(featureIdTexture, featureIdSampler, input.texCoord0, 0.0);
    let fidIntEarly = unpackFeatureId(fidSampleEarly, featureId.channelCount);
    currentFeatureId = f32(fidIntEarly);
  } else if (hasFlag(flags, FLAG_HAS_FEATURE_ID_ATTRIBUTE)) {
    // Vertex-attribute path. b3dm tilesets encode batch IDs in the per-vertex
    // `_BATCHID` accessor, which the loader renames `_FEATURE_ID_0`. It is
    // flat-interpolated, so the value is exact across the triangle with no
    // rounding.
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
      let tc = textureSampleGrad(baseColorTexture, baseColorSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy);
      baseColor = baseColor * tc;
    }
  } else {
    if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
      let tc = textureSampleGrad(baseColorTexture, baseColorSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy);
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

  //>>ifdef MODEL_SILHOUETTE
  // WIRE-MODEL-SILHOUETTE — silhouette-colour pass early-out (WebGL
  // ModelSilhouetteStageFS.glsl parity). Placed AFTER the alpha-mask
  // discard so a MASK model's cutout holes stay cut out of the rim, and
  // BEFORE any lighting — the rim is a flat colour. The stencil
  // not-equal test on the derived command's pipeline kills every
  // fragment overlapping the base model; only the inflated rim reaches
  // the framebuffer. The base stencil-write command keeps
  // `_pad_tt2 = 0` and never takes this branch.
  if (material._pad_tt2 > 0.5) {
    var silhouetteOut: FragOutput;
    silhouetteOut.color = modelSilhouetteStageFS(material._pad_cc0);
    //>>ifdef CAPTURE_MODE
    //>>else
    // Benign G-buffer emit (geometric normal + 0.5 roughness placeholder)
    // — same convention as the clipping-edge / unlit early-outs.
    silhouetteOut.normalRoughness = vec4<f32>(geomNormalEC, 0.5);
    //>>endif
    //>>ifdef LOG_DEPTH
    silhouetteOut.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
    //>>endif
    return silhouetteOut;
  }
  //>>endif

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
    // Unlit path: the model has no shading normal by design, since FLAG_IS_UNLIT
    // skips the PBR and normal-map block. Emit the geometric vertex normal so
    // consumers such as AO and contact shadows still get a usable normal at
    // unlit-painted pixels, with a 0.5 roughness placeholder because unlit
    // carries no material specular.
    var out: FragOutput;
    out.color = unlitWithEdge;
    //>>ifdef MODEL_HAS_COLOR
    // WIRE-MODEL-COLOR — WebGL runs modelColorStage for unlit materials too
    // (ModelFS.glsl calls it unconditionally after lightingStage, and
    // LIGHTING_UNLIT is just a lighting-stage mode).
    out.color = applyModelColor(out.color);
    //>>endif
    //>>ifdef CAPTURE_MODE
    //>>else
    out.normalRoughness = vec4<f32>(geomNormalEC, 0.5);
    //>>endif
    //>>ifdef LOG_DEPTH
    out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
    //>>endif
    return out;
  }

  // ── Normal ────────────────────────────────────────────────────────────────
  var N = normalize(input.normalEC);
  if (hasFlag(flags, FLAG_IS_DOUBLE_SIDED) && !input.frontFacing) { N = -N; }
  if (hasFlag(flags, FLAG_HAS_NORMAL_TEXTURE)) {
    let nm = textureSampleGrad(normalTexture, normalSampler, normalUV(input), normalUV_dx, normalUV_dy).rgb;
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
      let sg = textureSampleGrad(metallicRoughnessTexture, metallicRoughnessSampler, metallicRoughnessUV(input), mrUV_dx, mrUV_dy);
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
      let mr = textureSampleGrad(metallicRoughnessTexture, metallicRoughnessSampler, metallicRoughnessUV(input), mrUV_dx, mrUV_dy);
      roughness = roughness * mr.g;
      metallic = metallic * mr.b;
    }
    roughness = clamp(roughness, 0.04, 1.0);
    metallic = clamp(metallic, 0.0, 1.0);
    F0 = mix(vec3<f32>(0.04), baseColor.rgb, metallic);
    diffuseColor = baseColor.rgb * (1.0 - metallic);
  }

  // KHR_materials_specular modifies dielectric F0: `specularFactor` scales its
  // intensity and `specularColorFactor` tints it chromatically. Per the
  // specification, a metallic surface ignores the colour factor and still takes
  // baseColor for F0; only the dielectric F0 component is recoloured.
  //
  // Reference: https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_specular
  //>>ifdef MODEL_HAS_KHR_TEXTURES
  if (hasFlag(flags, FLAG_HAS_SPECULAR_EXT)) {
    var sf = material.specularExtFactors.x;
    var sc = material.specularExtFactors.yzw;
    // Sample specularColorTexture's RGB and specularFactorTexture's alpha, per
    // the specification: the former modulates the F0 chromatic tint, the
    // latter's alpha channel scales the factor scalar.
    let scTex = textureSampleGrad(
      specularColorTexture, khrSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy,
    );
    sc = sc * scTex.rgb;
    let sfTex = textureSampleGrad(
      specularFactorTexture, khrSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy,
    );
    sf = sf * sfTex.a;
    // Recolor the dielectric component (mix factor = 1.0 - metallic).
    let dielectricF0 = vec3<f32>(0.04) * sc * sf;
    F0 = mix(dielectricF0, baseColor.rgb, metallic);
  }
  //>>endif

  // KHR_materials_iridescence, using the thin-film analytical integral the
  // Khronos reference implementation evaluates rather than a hue-shift
  // cos-phase approximation. No LUT is required: the per-wavelength sensitivity
  // terms are baked as fixed Gaussian fits from the Belcour and Barla
  // sensitivity tables and evaluated analytically.
  //
  // Reference: Belcour and Barla, "A Practical Extension to Microfacet Theory
  // for the Modeling of Varying Iridescence" (SIGGRAPH 2017); the Khronos
  // KHR_materials_iridescence specification; three.js `iridescenceFresnel`.
  //>>ifdef MODEL_HAS_KHR_TEXTURES
  if (hasFlag(flags, FLAG_HAS_IRIDESCENCE)) {
    var irFactor = material.iridescenceFactors.x;
    let irIor = material.iridescenceFactors.y;
    // Sample iridescenceTexture's red channel as the mask and
    // iridescenceThicknessTexture's green channel, per the specification.
    let irTex = textureSampleGrad(
      iridescenceTexture, khrSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy,
    );
    irFactor = irFactor * irTex.r;
    let thickTex = textureSampleGrad(
      iridescenceThicknessTexture, khrSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy,
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

  // PARITY-CUSTOM-SHADER-WGSL slice A — PRE-LIGHTING customShader injection.
  // Mirrors WebGL ModelFS ordering: customShaderStage() runs AFTER materialStage
  // but BEFORE lightingStage, so the user's material modifications
  // (diffuse/specular/roughness/emissive/alpha) flow THROUGH the PBR lighting
  // integral below. The B473 hook injected POST-lighting — it could only tint the
  // already-lit color, which diverged from WebGL for MODIFY_MATERIAL (the default
  // mode). Seeding differs by CustomShaderMode: MODIFY seeds the computed PBR
  // material; REPLACE seeds the czm default material (diffuse 0, specular 1,
  // roughness 1, emissive 0, alpha 1) — WebGL's defaultModelMaterial() with
  // materialStage skipped. `CZM_CUSTOM_SHADER_REPLACE` is a compile-time const
  // baked by the generated chunk so the branch folds. `csEmissive` / `csAlpha`
  // are function-scoped overrides consumed at the emissive + final-alpha sites
  // below. When MODEL_HAS_WGSL_CUSTOM_SHADER is clear the whole block is stripped
  // at preprocess time → byte-identical to the pre-customShader path.
  //>>ifdef MODEL_HAS_WGSL_CUSTOM_SHADER
  var csEmissive: vec3<f32> = material.emissiveFactor;
  if (hasFlag(flags, FLAG_HAS_EMISSIVE_TEXTURE)) {
    csEmissive = csEmissive * textureSampleGrad(
      emissiveTexture, emissiveSampler, emissiveUV(input), emissiveUV_dx, emissiveUV_dy).rgb;
  }
  var csAlpha: f32 = baseColor.a;
  // Q31 slice B — seed the user-modifiable ambient-occlusion factor from the
  // strength-mixed occlusion texture (matching WebGL materialStage's
  // material.occlusion). Applied to the ambient term below IN PLACE OF the
  // texture block when the customShader is active, so it is not double-counted.
  // Defaults to 1.0 (no texture) → byte-identical when the field is untouched.
  var csOcclusion: f32 = 1.0;
  if (hasFlag(flags, FLAG_HAS_OCCLUSION_TEXTURE)) {
    let csAo = textureSampleGrad(
      occlusionTexture, occlusionSampler, occlusionUV(input), occlusionUV_dx, occlusionUV_dy).r;
    csOcclusion = mix(1.0, csAo, material.occlusionStrength);
  }
  {
    var csMaterial: czm_customModelMaterial;
    if (CZM_CUSTOM_SHADER_REPLACE) {
      csMaterial.diffuse = vec3<f32>(0.0);
      csMaterial.specular = vec3<f32>(1.0);
      csMaterial.roughness = 1.0;
      csMaterial.emissive = vec3<f32>(0.0);
      csMaterial.alpha = 1.0;
      csMaterial.metalness = 0.0;
      csMaterial.occlusion = 1.0;
      csMaterial.normalEC = N;
    } else {
      csMaterial.diffuse = diffuseColor;
      csMaterial.specular = F0;
      csMaterial.roughness = roughness;
      csMaterial.emissive = csEmissive;
      csMaterial.alpha = csAlpha;
      csMaterial.metalness = metallic;
      csMaterial.occlusion = csOcclusion;
      csMaterial.normalEC = N;
    }
    var csInput: czm_customFragmentInput;
    csInput.attributes.positionMC = input.rteMC;
    csInput.attributes.positionEC = input.positionEC;
    csInput.attributes.normalEC = N;
    csInput.attributes.texCoord_0 = input.texCoord0;
    csInput.attributes.color_0 = input.color0;
    czm_customFragmentMain(csInput, &csMaterial);
    // Q31 slice B — metalness writeback (MODIFY mode only). When a customShader
    // changes material.metalness, re-split diffuse/F0 from baseColor using the
    // metallic-roughness convention. An untouched metalness is an exact copy of
    // the `metallic` seed, so the `!=` compare is false and the else branch
    // honors any direct diffuse/specular writes → OFF path byte-identical.
    if (!CZM_CUSTOM_SHADER_REPLACE && csMaterial.metalness != metallic) {
      let mNew = clamp(csMaterial.metalness, 0.0, 1.0);
      diffuseColor = baseColor.rgb * (1.0 - mNew);
      F0 = mix(vec3<f32>(0.04), baseColor.rgb, mNew);
    } else {
      diffuseColor = csMaterial.diffuse;
      F0 = csMaterial.specular;
    }
    roughness = csMaterial.roughness;
    csEmissive = csMaterial.emissive;
    csAlpha = csMaterial.alpha;
    csOcclusion = csMaterial.occlusion;
    // normalEC writeback — re-derives ALL downstream lighting (direct BRDF +
    // IBL) from the perturbed normal, since the BRDF integral below reads N.
    N = csMaterial.normalEC;
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

  // Mirrors `czm_pbrLighting`: height-correlated Smith-joint visibility with the
  // denominator folded in, plus f90 Fresnel. specBRDF is `F * Vis * D`, with no
  // separate `/ (4 * NdotV * NdotL)`.
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

  // The Forward+ clustered lighting additive contribution.
  // `WebGPUModelPipelineCache._getOrCreateShaderModule` prepends the
  // ClusteredLighting chunk, which declares `evalClusteredLights(...)` and the
  // `@group(3)` bindings 18 to 22 the effects bind group carries the
  // dispatcher's per-frame cluster data on. It early-outs to vec3(0) when
  // `clusterParams.activeLightCount.x == 0` — no lights this frame, or
  // clustered lighting disabled — so the cost when off is one uniform compare
  // per fragment.
  let clusteredContrib = evalClusteredLights(
    input.positionEC, N, V, F0, roughness, diffuseColor,
    input.fragCoord.xy, input.positionEC.z,
  );
  direct = direct + clusteredContrib;

  // C6-LTC-AREA-LIGHTS — analytic LTC rect/disk area lights. Early-outs
  // to vec3(0) when clusterParams.activeLightCount.y == 0 (no area
  // lights this frame), so the cost when off is one uniform compare.
  let ltcAreaContrib = evalLTCAreaLights(
    input.positionEC, N, V, F0, roughness, diffuseColor,
  );
  direct = direct + ltcAreaContrib;

  // KHR_materials_anisotropy. The GGX D term is stretched along the
  // half-vector projection: highlights grow rougher along the view's right axis
  // when strength is positive and along its up axis when negative, producing
  // the streak shape brushed-metal assets expect.
  //>>ifdef MODEL_HAS_KHR_TEXTURES
  if (hasFlag(flags, FLAG_HAS_ANISOTROPY)) {
    var aniStrength = material.anisotropyFactors.x;
    var aniRotation = material.anisotropyFactors.y;
    // Sample anisotropyTexture: RG carries the cosine and sine of a per-pixel
    // rotation offset and B scales the strength. The specification stores the
    // trig pair as `RG * 2 - 1`, so 0.5 means no rotation and 1.0 means +pi/2.
    let aniTex = textureSampleGrad(
      anisotropyTexture, khrSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy,
    );
    let aniRotOffset = atan2(aniTex.g * 2.0 - 1.0, aniTex.r * 2.0 - 1.0);
    aniRotation = aniRotation + aniRotOffset;
    aniStrength = aniStrength * aniTex.b;
    // Use the authored glTF TANGENT attribute, carried through FragmentInput as
    // tangentEC and bitangentEC, rather than a view-relative approximation. The
    // specification defines the anisotropy streak along the per-fragment
    // tangent direction, and substituting `cross(N, V)` gives wrong streaks on
    // brushed-metal materials with authored anisotropic UVs.
    //
    // Guard `normalize` against zero-length input: a primitive with no authored
    // TANGENT attribute uploads zeros into the tangent slot, and
    // `normalize(vec3(0))` is undefined in WGSL. A degenerate tangent falls
    // back to the view-relative basis, so an anisotropic material without
    // authored tangents still gets usable streaks.
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
    // Reuse the Smith-joint `Vis`, whose denominator is folded in, rather than
    // a separable `G` with an explicit `/ (4 * NdotV * NdotL)`, so this matches
    // the `specBRDF` it is differenced against.
    let aniBRDF = Daniso * Vis * F;
    direct = direct + (aniBRDF - specBRDF) * light.sunColor *
                       light.sunIntensity * NdotL * aniStrength;
  }
  //>>endif

  // KHR_materials_clearcoat adds a second GGX specular lobe over the base
  // contribution. Its Fresnel uses a fixed F0 of 0.04 for the air-coat
  // interface, and the base material is attenuated by `1 - F_clearcoat`, so
  // high glancing angles bias toward the coat colour instead of
  // double-bouncing.
  //>>ifdef MODEL_HAS_KHR_TEXTURES
  if (hasFlag(flags, FLAG_HAS_CLEARCOAT)) {
    var ccFactor = material.clearcoatFactors.x;
    var ccRough = clamp(material.clearcoatFactors.y, 0.04, 1.0);
    // Sample clearcoatTexture's red channel as intensity,
    // clearcoatRoughnessTexture's green as roughness, and
    // clearcoatNormalTexture's RGB as a tangent-space normal, per the
    // specification.
    let ccTex = textureSampleGrad(
      clearcoatTexture, khrSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy,
    );
    ccFactor = ccFactor * ccTex.r;
    let ccRoughTex = textureSampleGrad(
      clearcoatRoughnessTexture, khrSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy,
    );
    ccRough = clamp(ccRough * ccRoughTex.g, 0.04, 1.0);
    // Clearcoat normal: per spec, the second specular lobe uses its
    // own normal independent of the base surface's normalTexture.
    // Sample + perturb when the asset declares it; placeholder white
    // texture leaves N_cc identical to N (the FS gates on the
    // FLAG_HAS_CLEARCOAT bit, but with a 1×1 white placeholder the
    // perturbation reduces to identity since (R,G) decode to (1,1)
    // and `perturbNormal` outputs back the original axis).
    let ccNormalTex = textureSampleGrad(
      clearcoatNormalTexture, khrSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy,
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

  // KHR_materials_sheen. A Charlie BRDF lobe, added on top of the base
  // contribution, which reproduces the retroreflection fabric and velvet show
  // at grazing angles.
  //
  // Reference: Estevez and Kulla, "Production Friendly Microfacet Sheen BRDF"
  // (SIGGRAPH 2017).
  //>>ifdef MODEL_HAS_KHR_TEXTURES
  if (hasFlag(flags, FLAG_HAS_SHEEN)) {
    var sheenColor = material.sheenFactors.xyz;
    var sheenRough = clamp(material.sheenFactors.w, 0.07, 1.0);
    // Sample sheenColorTexture's RGB and sheenRoughnessTexture's alpha, per the
    // specification.
    let sheenTex = textureSampleGrad(
      sheenColorTexture, khrSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy,
    );
    sheenColor = sheenColor * sheenTex.rgb;
    let sheenRoughTex = textureSampleGrad(
      sheenRoughnessTexture, khrSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy,
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

  // KHR_materials_volume applies Beer-Lambert attenuation to the diffuse
  // contribution, mirroring the reference implementation's attenuation term
  // when transmission is 0 and the surface is opaque — the common case for
  // KHR_materials_volume on glass and translucent assets.
  //
  // KHR_materials_transmission then blends that diffuse contribution with a
  // sample of the refraction texture, a copy of the prior-pass scene colour,
  // offset along the refracted view direction. Physically correct transmission
  // needs a refraction MRT capturing opaque-only scene colour before any
  // transmissive draw; without that capture the sample reads this draw's own
  // contribution and double-counts. Where the capture is absent the fragment
  // shader samples the placeholder white texture and the transmission factor
  // scales the existing diffuse contribution instead.
  //
  // Transmission is applied after volume attenuation, so transmissive glass
  // behind volumetric absorption receives both effects in the right order.
  //>>ifdef MODEL_HAS_KHR_TEXTURES
  // Pre-compute the KHR_volume thickness so both the transmission and volume
  // blocks consume one value without duplicating the thicknessTexture sample.
  // The thickness modulates the refraction step, so thicker geometry bends
  // light more, as the KHR_volume specification expects: refraction is
  // proportional to the optical path length through the volume. A fixed step
  // would refract a thin glass pane and a thick crystal sphere identically.
  //
  // Gated on FLAG_HAS_VOLUME. An asset declaring KHR_transmission without
  // KHR_volume carries no authored thickness and keeps the fixed step. The
  // sample is taken once per fragment whichever blocks consume it.
  var thicknessForKHR: f32 = 0.0;
  if (hasFlag(flags, FLAG_HAS_VOLUME)) {
    let thickTex = textureSampleGrad(
      thicknessTexture, khrSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy,
    );
    thicknessForKHR = material.volumeFactors0.x * thickTex.g;
  }

  if (hasFlag(flags, FLAG_HAS_TRANSMISSION)) {
    var trFactor = material.transmissionFactors.x;
    let trTex = textureSampleGrad(
      transmissionTexture, khrSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy,
    );
    trFactor = trFactor * trTex.r;
    if (trFactor > 0.0) {
      // Refracted view direction (Snell's law) — IOR encoded on the
      // transmission factor block .y; defaults to 1.5 (standard glass)
      // when the asset doesn't override.
      let ior = max(material.transmissionFactors.y, 1.0);
      let eta = 1.0 / ior;
      let refracted = refract(-V, N, eta);
      // Couple the refraction step to volume thickness. The 0.05 baseline is
      // deliberately small, so a misaligned read stays near the original pixel
      // when no thickness is authored. With KHR_volume active the step scales
      // by `1 + 4 * thickness`, so a thickness near 0.25 doubles it and 0.5
      // triples it. The factor of 4 is a heuristic calibrated so a glass pane —
      // `thicknessFactor` around 0.01 to 0.05 in normalized model units —
      // produces a barely visible offset, while a thick sphere at 0.5 to 1.0
      // produces noticeable parallax, matching the reference implementation.
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
    // Reuse the pre-computed `thicknessForKHR` rather than re-sampling the
    // thicknessTexture. Per the specification that texture stores a
    // unit-normalized thickness scaled by `thicknessFactor`.
    let thickness = thicknessForKHR;
    if (attDistance > 0.0 && thickness > 0.0) {
      let attCoeff = -log(max(attColor, vec3<f32>(1.0e-3))) / attDistance;
      let attenuation = exp(-attCoeff * thickness);
      direct = direct * attenuation;
    }
  }
  //>>endif

  // When a point-light shadow map is bound, route through cube sampling. This
  // is checked before the CSM gate: only one shadow map is active at a time,
  // and if both flags ever fire the cube path wins, because a point light
  // cannot be expressed as cascades. The point light is packed relative to the
  // same camera origin as the encoded model-space delta:
  //   1. rotate `rteMC` (model-space RTE = positionMC - encodedCameraMC)
  //      through `material.modelMatrix` with w=0 → world-space camera-
  //      relative direction (rteWC). The matrix's translation column
  //      doesn't contribute, so this is exactly `pWC - camWC`.
  //   2. subtract the camera-relative light position directly. No absolute
  //      f32 ECEF reconstruction occurs in the fragment hot path.
  //
  // Ambient / emissive remain unshadowed per PBR convention.
  if (effects.pointLightControl.x > 0.5) {
    let rteWC = (material.modelMatrix * vec4<f32>(input.rteMC, 0.0)).xyz;
    let shadowFactor = computeShadowFactorPointLight(rteWC);
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
  } else if (effects.shadowDarkness < 1.0) {
    // Default directional/spot route. The placeholder effects UBO stores
    // darkness=1, so disabled/uninitialized shadows skip the sample exactly.
    let shadowFactor = computeShadowFactorSingle(input.positionEC);
    direct = direct * shadowFactor;
  }

  // Accumulate directional, point and spot lights from `scene.lights` with the
  // baseline Cook-Torrance BRDF, Lambert plus GGX, and without the KHR
  // extensions. Anisotropy, clearcoat and sheen apply to the sun alone, which
  // follows the usual treatment of the directional key light as the dominant
  // material-detail driver and punctual lights as fill. The loop is bounded by
  // `light.punctualLightCount`, so unused slots cost nothing.
  let pCount = i32(light.punctualLightCount);
  var punctualNWC = vec3<f32>(0.0);
  var punctualVWC = vec3<f32>(0.0);
  if (pCount > 0) {
    // The shared model BRDF operates in eye space. Punctual positions are kept
    // camera-relative in WORLD space so Earth-scale ECEF never enters f32;
    // rotate N/V once per fragment and keep every punctual vector coherent.
    // The branch preserves the zero-light path's prior cost.
    punctualNWC = normalize(light.eyeToWorldRotation * N);
    punctualVWC = normalize(light.eyeToWorldRotation * V);
  }
  for (var li = 0; li < pCount; li = li + 1) {
    let pl = light.punctualLights[li];
    let pType = i32(pl.lightType);

    // Compute per-light L vector + attenuation. Directional lights use
    // posOrDir as a world direction (already unit-length from JS pack); point
    // and spot use posOrDir as a camera-relative world position.
    var Lp: vec3<f32>;
    var atten: f32 = 1.0;
    if (pType == 0) {
      // Directional: posOrDir is the direction TOWARD the light source
      // (matches WebGL `light_directional` convention).
      Lp = normalize(pl.posOrDir);
    } else {
      // Point / spot: compare two camera-relative world positions. CPU packing
      // subtracts the active camera in f64 before writing pl.posOrDir; rteWC is
      // reconstructed without translation from the model-space RTE varying.
      // Never reconstruct absolute f32 ECEF here.
      let rteWC = (material.modelMatrix * vec4<f32>(input.rteMC, 0.0)).xyz;
      let toLight = pl.posOrDir - rteWC;
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
      // Spot cone narrowing, using the authored forward direction packed into
      // the per-light record's vec3-aligned slots 16-18. `pl.spotDirection` is
      // the spot's world-space pointing vector, normalized at construction. The
      // cosine of the angle between that forward and the direction to the
      // fragment (`-Lp`, light to fragment) drives a smoothstep between
      // cosOuter and cosInner: outside the outer cone it clamps to 0, inside
      // the inner cone to 1, and between them it interpolates linearly in
      // cosine space.
      if (pType == 2) {
        let cosOuter = cos(pl.outerConeAngle);
        let cosInner = cos(pl.innerConeAngle);
        let spotFwd = normalize(pl.spotDirection);
        let cd = dot(-Lp, spotFwd);
        let cone = smoothstep(cosOuter, cosInner, cd);
        atten = atten * cone;
      }
    }

    let NdotLp = max(dot(punctualNWC, Lp), 0.0);
    if (NdotLp > 0.0 && atten > 0.0) {
      let Hp = normalize(punctualVWC + Lp);
      let NdotHp = max(dot(punctualNWC, Hp), 0.0);
      let VdotHp = max(dot(punctualVWC, Hp), 0.0);
      // The same Smith-joint and f90 BRDF as the sun path above, for analytic
      // point and spot lights.
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

  // Ambient and IBL, matching `textureIBL` in ImageBasedLightingStageFS.glsl.
  // The split-sum environment BRDF is looked up from the precomputed LUT —
  // `brdfLutTexture`, R for scale and G for bias — and the diffuse and specular
  // contributions use the Fdez-Aguera single- and multi-scatter model rather
  // than a `fresnelSchlickRoughness` approximation.
  //
  // Both the diffuse normal and the specular reflection vector are rotated from
  // eye space into the fixed IBL reference frame,
  // `light.iblReferenceFrameMatrix`, before the cubemap sample. Sampling in eye
  // space instead would rotate the environment with the camera; rotating first
  // keeps the reflection world-anchored as the camera orbits.
  //
  // The roughness-dependent Fresnel matches `fresnelSchlick2(f0, f90, NdotV)`
  // with `f90 = max(1 - roughness, f0)`.
  //
  // Reference: Fdez-Aguera, "A Multiple-Scattering Microfacet Model for
  // Real-Time Image-Based Lighting" (JCGT 2019),
  // https://www.jcgt.org/published/0008/01/03/paper.pdf
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
  // Bend the reflection normal for anisotropic materials, so specular IBL
  // streaks along the authored tangent, matching `ImageBasedLightingStageFS.glsl`
  // under USE_ANISOTROPY. That bends about
  // `anisotropicB = cross(N, rotatedTangent)`, the anisotropy bitangent rather
  // than the tangent, hence `cross(N, aniDir)` here; `aniDir` is the authored
  // tangent rotated by the anisotropy rotation, derived exactly as in the
  // direct-light block above. `mix(anisotropicNormal, N, bendFactorPow4)` fades
  // the bend out as roughness approaches 1. Gated under MODEL_HAS_KHR_TEXTURES
  // because it samples `anisotropyTexture`.
  if (hasFlag(flags, FLAG_HAS_ANISOTROPY)) {
    let aniTexIBL = textureSampleGrad(
      anisotropyTexture, khrSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy,
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
  // Box and sphere parallax correction. With no `reflectionProxy` configured
  // the mode is 0, the `else` branch runs, and `Rcube` is the verbatim
  // eye-space reflection `R`. With a proxy set, the eye-space reflection is
  // lifted to world space, intersected with the proxy, and the corrected world
  // direction pushed back to eye space, so the existing
  // `iblReferenceFrameMatrix * dir` sample is reused unchanged. The diffuse
  // irradiance and SH path above is deliberately untouched: parallax
  // re-projects only the mirror-like specular reflection vector.
  var Rcube = R;
  let reflectionProxyMode = light.reflectionProxyControl.x;
  if (reflectionProxyMode > 0.5) {
    // Camera-relative world fragment position (same frame as the proxy
    // center/extents). Mirrors the point-light / CSM `rteWC` reconstruction.
    let fragRteWC = (material.modelMatrix * vec4<f32>(input.rteMC, 0.0)).xyz;
    // Eye-space reflection → world space via the eye→world rotation.
    let Rworld = light.eyeToWorldRotation * R;
    let correctedWorld = parallaxCorrectReflection(
      fragRteWC,
      Rworld,
      reflectionProxyMode,
      light.reflectionProxyCenter,
      light.reflectionProxyHalfExtents,
      light.reflectionProxyControl.y,
    );
    // World direction → eye space (transpose of the orthonormal eye→world
    // rotation) so the unchanged `iblReferenceFrameMatrix * dir` cube sample
    // below maps it into the environment frame exactly as the raw path does.
    Rcube = transpose(light.eyeToWorldRotation) * correctedWorld;
  }
  // Rotate the eye-space reflection into the fixed IBL reference frame so
  // the prefiltered-radiance sample stays world-anchored as the camera
  // orbits (matches WebGL `reflectMC = iblReferenceFrameMatrix * reflectEC`).
  let Ribl = normalize(light.iblReferenceFrameMatrix * Rcube);
  let specLod = roughness * light.iblMaxMipLevel;
  let radiance = textureSampleLevel(
    iblSpecularTexture, iblSampler, Ribl, specLod
  ).rgb;
  // Split-sum specular: radiance * FssEss (already folds the BRDF LUT
  // scale/bias) * the user specular factor. Matches WebGL
  // `specularContribution = radiance * FssEss * model_iblFactor.y`.
  let specularIBL = radiance * FssEss * light.iblSpecularFactor;

  // `diffuseIBL` already carries the full Fdez-Aguera diffuse term, FmsEms plus
  // dielectricScattering, so it is added directly alongside the specular
  // contribution. That has to match the GLSL path exactly:
  // `ImageBasedLightingStageFS.glsl`'s `textureIBL` returns
  // `diffuseContribution + specularContribution`, and `LightingStageFS.glsl`
  // adds it as `color += computeIBL(...)`. There is no separate ambient floor —
  // the ambient IS the IBL.
  //
  // No fallback floor is needed when IBL is unconfigured: `diffuseIBL` and
  // `specularIBL` always sample a cubemap, the mid-grey placeholder when no
  // environment has been generated, so ambient is never silently black. Adding
  // a floor term, or gating one on `light.iblHasSH`, introduces a code path the
  // GLSL side lacks and brightens and flattens an at-rest neutral model
  // relative to it.
  var ambient = diffuseIBL + specularIBL;

  // ── Occlusion ─────────────────────────────────────────────────────────────
  //>>ifdef MODEL_HAS_WGSL_CUSTOM_SHADER
  // Q31 slice B — apply the customShader-modifiable occlusion factor (seeded
  // from the strength-mixed occlusion texture at the pre-lighting seam) in
  // place of the texture block, so a customShader can scale AO. Untouched →
  // csOcclusion equals the texture-block result → byte-identical.
  ambient = ambient * csOcclusion;
  //>>else
  if (hasFlag(flags, FLAG_HAS_OCCLUSION_TEXTURE)) {
    let ao = textureSampleGrad(occlusionTexture, occlusionSampler, occlusionUV(input), occlusionUV_dx, occlusionUV_dy).r;
    ambient = mix(ambient, ambient * ao, material.occlusionStrength);
  }
  //>>endif

  // ── Emissive ──────────────────────────────────────────────────────────────
  // Emissive texture is uploaded as `rgba8unorm-srgb`, so textureSample
  // already returns linear values. See the base-color block above for the
  // full rationale on sRGB format selection.
  var emissive = material.emissiveFactor;
  if (hasFlag(flags, FLAG_HAS_EMISSIVE_TEXTURE)) {
    let et = textureSampleGrad(emissiveTexture, emissiveSampler, emissiveUV(input), emissiveUV_dx, emissiveUV_dy).rgb;
    emissive = emissive * et;
  }
  // PARITY-CUSTOM-SHADER-WGSL slice A — the pre-lighting injection may have
  // modified material.emissive; consume the override so it composites into the
  // final color exactly like WebGL's lightingStage adds material.emissive.
  //>>ifdef MODEL_HAS_WGSL_CUSTOM_SHADER
  emissive = csEmissive;
  //>>endif

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

    // Per-feature alpha-class discard. When the batch table has flipped some
    // features translucent, with RGBA alpha in [0.004, 0.998), and others
    // opaque at 0.998 or above, the renderer emits two commands per primitive:
    //   - opaque pass (passClass = 0) keeps features with alpha >= 0.998
    //   - translucent pass (passClass = 1) keeps features in [0.004, 0.998)
    // Both share the same vertex and index buffers and pipeline bindings; only
    // `tileBatchFlags.x` differs. Mirrors the `tile_translucentCommand` shader
    // uniform path in `Cesium3DTileBatchTable`.
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
  // PARITY-CUSTOM-SHADER-WGSL slice A — apply the customShader's alpha override
  // (WebGL feeds material.alpha into handleAlpha after lightingStage). Mirrors
  // the base `select(1.0, baseColor.a, BLEND)` with the custom alpha substituted,
  // preserving the alpha-mode + per-feature-alpha semantics.
  //>>ifdef MODEL_HAS_WGSL_CUSTOM_SHADER
  finalColor = vec4<f32>(
    finalColor.rgb,
    select(1.0, csAlpha, hasFlag(flags, FLAG_ALPHA_MODE_BLEND)) * featureColor.a);
  //>>endif

  // Aerial-perspective fog blend. The same math as PrimitivePhongTexturedColor,
  // with model-specific inputs: `input.rteMC`, the model-space camera-relative
  // position, rotated through `modelMatrix` gives the world-space
  // camera-relative vector, and `cameraPositionWC` is already an f32 vec3, so
  // nothing is reconstructed. Applied after tonemap and gamma so the fog colour
  // composites in display space.
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

  // The final overlay step, after tonemap, gamma and fog, so the edge colour —
  // which the emitter already authored in display space — composites without a
  // redundant tonemap. The GLSL stage runs in display space too. This applies
  // to lit and unlit fragments alike; the unlit early-out above also calls
  // applyEdgeOverlay before returning.
  finalColor = applyEdgeOverlay(
    finalColor,
    input.positionEC,
    input.fragCoord.xy,
    currentFeatureId,
    edgePixelStep,
  );

  // Main lit path: emit the full post-normal-map eye-space normal and the real
  // material roughness. This is the pixel class the G-buffer exists for.
  //   - With FLAG_HAS_NORMAL_TEXTURE set, `perturbNormal` has already perturbed
  //     `N` using the tangent-space normal map, so per-fragment N diverges
  //     substantially from the depth-derived approximation an AO consumer would
  //     otherwise fall back to.
  //   - `roughness` carries either `material.roughnessFactor` on the
  //     metallic-roughness path or `clamp(1.0 - gloss, 0.04, 1.0)` on the
  //     specular-glossiness path, times the metallicRoughness texture's green
  //     channel. A specular consumer such as SSR needs this for a correct
  //     response.
  var out: FragOutput;
  out.color = finalColor;

  // PARITY-CUSTOM-SHADER-WGSL slice A — the customShader fragment body now runs
  // PRE-lighting (see the injection block above the Cook-Torrance BRDF), matching
  // WebGL ModelFS's customShaderStage → lightingStage order. The former
  // post-lighting hook that lived here (B473) has been removed.

  //>>ifdef MODEL_HAS_COLOR
  // WIRE-MODEL-COLOR — blend model.color into the display-space colour.
  // Applied after the customShader hook, matching WebGL's ModelFS.glsl
  // stage order (lightingStage → cpuStylingStage → modelColorStage); WebGL's
  // lit colour is display-space (tonemapped) at that point too.
  out.color = applyModelColor(out.color);
  //>>endif

  // The metadata data-path proof. With MODEL_HAS_METADATA set and the per-model
  // debug toggle enabled — `material.motionFlags.z > 0.5`, driven by
  // `globalThis.CesiumWebGPUMetadataDebug` — the fragment colour is overridden
  // with the metadata value, so an automated probe can confirm the value
  // reached the shader. The toggle is purely additive: with it off the lit
  // appearance is untouched.
  //
  // The value flows through the generated `struct Metadata` and
  // `initializeMetadata`, which is named after the real metadata property and
  // applies the class offset and scale, and then through the generated
  // `metadataDebugScalar` accessor, which recovers the raw transported scalar
  // in [0,1].
  //
  // `initializeMetadata` takes the interpolated texCoords, so it can
  // `textureSample` each property texture, and the per-fragment feature ID —
  // the flat-interpolated `_FEATURE_ID_0` as an f32, defaulting to 0.0 — so it
  // can `textureLoad` the property-table row at
  // `(featureId, propertyInfoIndex)`. `input.featureId0` is always present in
  // FragmentInput, and the texCoord1 argument falls back to texCoord0 when the
  // primitive lacks TEXCOORD_1.
  //
  // The nested ifdefs below make the three branches mutually exclusive:
  // attribute, then texture-only, then table-only. `metadataDebugScalar`
  // prefers the attribute scalar, then texture, then table, so each path paints
  // a value that varies with the resolved metadata and nothing double-paints. A
  // model carrying both the attribute and texture bits takes the attribute
  // branch; `initializeMetadata` still samples the texture fields, but the
  // proof gradient stays attribute-sourced.
  //
  // The paint itself goes through the generated `metadataDebugColor(metadata)`
  // accessor: a scalar or matrix transported property emits the red-to-blue
  // gradient `vec4(s, 0, 1-s, 1)`, while a VEC2, VEC3 or VEC4 property paints
  // its raw per-component values as RGB, so a probe can confirm every component
  // round-tripped rather than only `.x`.
  //>>ifdef MODEL_HAS_METADATA
  if (material.motionFlags.z > 0.5) {
    //>>ifdef MODEL_HAS_TEXCOORD_1
    let metaTC1 = input.texCoord1;
    //>>else
    let metaTC1 = input.texCoord0;
    //>>endif
    // The matrix-transport chunk's generated `initializeMetadata` takes the
    // three extra widened-transport vec4s.
    //>>ifdef MODEL_METADATA_MAT_TRANSPORT
    let metadata = initializeMetadata(input.metadataValue, input.metadataValue1, input.metadataValue2, input.metadataValue3, input.texCoord0, metaTC1, input.featureId0);
    //>>else
    let metadata = initializeMetadata(input.metadataValue, input.texCoord0, metaTC1, input.featureId0);
    //>>endif
    out.color = metadataDebugColor(metadata);
  }
  //>>else
  //>>ifdef MODEL_HAS_PROPERTY_TEXTURES
  if (material.motionFlags.z > 0.5) {
    //>>ifdef MODEL_HAS_TEXCOORD_1
    let metaTC1 = input.texCoord1;
    //>>else
    let metaTC1 = input.texCoord0;
    //>>endif
    let metadata = initializeMetadata(vec4<f32>(0.0), input.texCoord0, metaTC1, input.featureId0);
    out.color = metadataDebugColor(metadata);
  }
  //>>else
  //>>ifdef MODEL_HAS_PROPERTY_TABLES
  if (material.motionFlags.z > 0.5) {
    // Table-only model (no property attribute, no property texture). The table
    // is read at the per-fragment feature ID — either the flat-interpolated
    // `input.featureId0` (attribute / implicit sources) or, for a
    // TEXTURE-sourced feature ID (METADATA-TABLE-SOURCES), a feature-ID
    // texture sample the generated chunk performs at the passed texCoords —
    // so texCoord1 must be the real TEXCOORD_1 when the primitive carries it.
    //>>ifdef MODEL_HAS_TEXCOORD_1
    let metaTC1 = input.texCoord1;
    //>>else
    let metaTC1 = input.texCoord0;
    //>>endif
    let metadata = initializeMetadata(vec4<f32>(0.0), input.texCoord0, metaTC1, input.featureId0);
    out.color = metadataDebugColor(metadata);
  }
  //>>endif
  //>>endif
  //>>endif
  //>>ifdef CAPTURE_MODE
  //>>else
  out.normalRoughness = vec4<f32>(N, roughness);
  //>>endif
  //>>ifdef LOG_DEPTH
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
  //>>endif
  return out;
}

// The pick fragment entry shares the vertex stage and bind-group layout with
// `fragmentMain`; only the entry name and the pick pipeline's blend and depth
// state differ, with no blend and depth writes enabled.
//
// Correctness:
//   - Alpha-mask discards run, because a mask hole is not visible and must not
//     claim the click. Alpha is sampled from the base-colour texture times
//     baseColorFactor, as in the lit path.
//   - Alpha-blend primitives pick on any non-discarded fragment. Depth-sorted
//     transparent picking would need OIT integration on the pick framebuffer.
//   - Unlit, metallic-roughness and specular-glossiness share one alpha-mask
//     path, so a single discard block covers all three.
//   - Vertex colours influence baseColor.a exactly as in the lit path, so
//     vertex-colour-driven masking applies to picking too.
//
// Translucent fragments take a stochastic dither alpha-test through Interleaved
// Gradient Noise, surviving with probability equal to their effective alpha;
// multi-frame averaging under TAA or hover motion converges to the
// alpha-weighted appearance. It is single-pass, needing no extra render passes
// or MRT targets: a translucent fragment becomes either opaque or discarded in
// the pick pass, so the standard depth-test pipeline handles winner selection.
//
// The dither is stable per cursor position by design. Moving the cursor
// produces different noise patterns across pixels, but a stationary cursor
// yields the same pick result on every call, so the UI feedback does not
// flicker.
//
// Reference: Jimenez, "Next Generation Post Processing in Call of Duty:
// Advanced Warfare" (SIGGRAPH 2014), for the Interleaved Gradient Noise.
fn pickHoverDither(fragCoord: vec2<f32>) -> f32 {
  // Jimenez IGN. Standard formula used by UE4/UE5/Frostbite for
  // dithered transparency. The magic constants come from a low-
  // discrepancy R2 sequence — produces blue-noise-like spectral
  // properties from a single fract() call, no texture lookup.
  return fract(52.9829189 * fract(0.06711056 * fragCoord.x + 0.00583715 * fragCoord.y));
}

// Shared pick output for the three model pick fragment entries —
// fragmentPickHoverMain, fragmentPickMain and fragmentPickMetadataMain, and by
// extension the two BLEND precise-pass pipelines that reuse fragmentPickMain.
//
// With `defines = 0`, the default pick-gated module, this is a single
// `@location(0)` struct whose output is identical to a bare
// `-> @location(0) vec4<f32>` return. When the log-depth gate is active the
// pick module compiles with LOG_DEPTH and the struct also carries a log-encoded
// `@builtin(frag_depth)`, in the same encoding `fragmentMain` writes as
// `out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor)`, so
// a converted model pick shares that log depth in the shared pick framebuffer.
struct PickFragOutput {
  @location(0) color: vec4<f32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};
fn makeModelPickOut(color: vec4<f32>, logDepth: f32) -> PickFragOutput {
  var out: PickFragOutput;
  out.color = color;
  //>>ifdef LOG_DEPTH
  out.depth = csm_writeLogDepth(logDepth, camera.logDepthFactor);
  //>>endif
  return out;
}

@fragment fn fragmentPickHoverMain(input: FragmentInput) -> PickFragOutput {
  let flags = material.materialFlags;
  //>>ifdef LOG_DEPTH
  // The log frag_depth source is the interpolated linear depthFromNearPlusOne
  // the VS wrote (present ONLY in the LOG_DEPTH-compiled pick module). In the
  // default pick-gated module (LOG_DEPTH off) `v_logDepth` is stripped from
  // FragmentInput, so the //>>else binds a placeholder makeModelPickOut ignores.
  let pickLogDepth = input.v_logDepth;
  //>>else
  let pickLogDepth = 0.0;
  //>>endif
  // Hoist the baseColor UV derivatives to the entry, in uniform control flow
  // and before any discard, so the alpha-test baseColor sample below uses
  // textureSampleGrad and selects the same mip as fragmentMain. That keeps the
  // alpha-mask and blend discard decisions consistent across the pick and
  // velocity passes at distance, as the GLSL path does by mip-sampling the
  // alpha test in every pass.
  let baseColorUV_dx = dpdx(baseColorUV(input));
  let baseColorUV_dy = dpdy(baseColorUV(input));
  var baseColor = material.baseColorFactor;

  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    baseColor = vec4<f32>(material.diffuseFactor_r, material.diffuseFactor_g,
                          material.diffuseFactor_b, material.diffuseFactor_a);
    if (hasFlag(flags, FLAG_HAS_DIFFUSE_TEXTURE)) {
      let tc = textureSampleGrad(baseColorTexture, baseColorSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy);
      baseColor = baseColor * tc;
    }
  } else if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
    let tc = textureSampleGrad(baseColorTexture, baseColorSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy);
    baseColor = baseColor * tc;
  }

  if (hasFlag(flags, FLAG_HAS_VERTEX_COLORS)) {
    baseColor = baseColor * input.color0;
  }

  // Alpha-mask discard — same as fragmentPickMain.
  if (hasFlag(flags, FLAG_ALPHA_MODE_MASK)) {
    if (baseColor.a < material.alphaCutoff) { discard; }
  }

  // Stochastic dither for BLEND: survival probability equals alpha, and
  // multi-frame averaging gives a perceptually correct alpha-weighted pick.
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
      // Gate on RGB, not alpha — see the detailed note in fragmentPickMain.
      // Pick-ID colours have alpha 0 for every key below 2^24, so a valid
      // pickId is identified by nonzero RGB.
      if (featurePickColor.r > 0.0 || featurePickColor.g > 0.0 || featurePickColor.b > 0.0) {
        return makeModelPickOut(featurePickColor, pickLogDepth);
      }
    }
  }

  return makeModelPickOut(material.pickColor, pickLogDepth);
}

@fragment fn fragmentPickMain(input: FragmentInput) -> PickFragOutput {
  let flags = material.materialFlags;
  //>>ifdef LOG_DEPTH
  // See fragmentPickHoverMain — the interpolated log-depth source, gated so the
  // default pick module (LOG_DEPTH off, `v_logDepth` stripped) stays compilable
  // and byte-identical.
  let pickLogDepth = input.v_logDepth;
  //>>else
  let pickLogDepth = 0.0;
  //>>endif
  // Hoist the baseColor UV derivatives to the entry, in uniform control flow
  // and before the split, clip and alpha discards, so the alpha-test baseColor
  // sample uses textureSampleGrad and selects the same mip as fragmentMain,
  // keeping the discard consistent across the pick and colour passes at
  // distance.
  let baseColorUV_dx = dpdx(baseColorUV(input));
  let baseColorUV_dy = dpdy(baseColorUV(input));
  //>>ifdef MODEL_SPLIT_ENABLED
  // WIRE-MODEL-SPLITTER — the hidden half of a split model must not be
  // pickable. WebGL's derived pick command keeps the splitter stage in
  // its FS, so mirror the fragmentMain discard here. See fragmentMain
  // for the pad-lane convention (_pad_end2 = direction, _pad_end3 = px).
  if (material._pad_end2 < 0.0 && input.fragCoord.x > material._pad_end3) { discard; }
  if (material._pad_end2 > 0.0 && input.fragCoord.x < material._pad_end3) { discard; }
  //>>endif

  // PARITY-CLIP-PLANES — clipped geometry must not be pickable. Mirror the
  // color path's `modelClipByPlanes` / `modelClipByPolygon` discards at the
  // top of the pick entry so a pick ray through a clipped-away region
  // returns undefined (matching WebGL, where the clip discard runs before
  // the pick-color write). Position-independent when `clippingPlaneCount`
  // is 0 — the loop early-returns 1.0 and no texture is sampled, so
  // unclipped models pick exactly as before.
  if (effects.clippingPlaneCount > 0u) {
    if (modelClipByPlanes(input.positionEC) < 0.0) { discard; }
  }
  if (effects.clippingPolygonCount > 0u) {
    let worldPos = camera.cameraPositionWC
      + (material.modelMatrix * vec4<f32>(input.rteMC, 0.0)).xyz;
    if (modelClipByPolygon(worldPos)) { discard; }
  }

  // Resolve baseColor.a only — that's all the alpha-mask path needs.
  // Skip every PBR / lighting / IBL / fog / edge stage; the pick FBO
  // doesn't care about anything but `material.pickColor` post-discard.
  var baseColor = material.baseColorFactor;

  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    baseColor = vec4<f32>(material.diffuseFactor_r, material.diffuseFactor_g,
                          material.diffuseFactor_b, material.diffuseFactor_a);
    if (hasFlag(flags, FLAG_HAS_DIFFUSE_TEXTURE)) {
      let tc = textureSampleGrad(baseColorTexture, baseColorSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy);
      baseColor = baseColor * tc;
    }
  } else if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
    let tc = textureSampleGrad(baseColorTexture, baseColorSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy);
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

  // BLEND primitives discard near-fully-transparent fragments, so glass, water
  // and ghost overlays do not claim the pick over opaque geometry visible
  // through them. The 0.004 cutoff matches the per-feature batch-table hide
  // threshold below and filters numerical noise, not real translucent surfaces.
  // It pairs with the BLEND pick pipeline's `depthWriteEnabled: false`, so the
  // depth test alone picks the closest non-discarded translucent fragment.
  if (hasFlag(flags, FLAG_ALPHA_MODE_BLEND)) {
    if (baseColor.a < 0.004) { discard; }
  }

  // Per-feature batch-table hide also has to gate picking — a feature
  // hidden by `batchColor.a == 0` must not be pickable. Mirrors the
  // discard at the same site in `fragmentMain`.
  //
  // When the batch table is active and per-feature pickIds have been allocated
  // — signalled by `featureId.featurePickEnabled > 0.5` — look up the feature's
  // pickColor from the dedicated feature-pick texture instead of returning the
  // primitive-granular `material.pickColor`. That texture is laid out like the
  // batch texture, a row of RGBA8 entries indexed by featureId in single- or
  // multi-line layout, and is uploaded whenever pickIds are allocated or change.
  //
  // It falls back to `material.pickColor` when:
  //   - there is no batch table, i.e. single-feature primitives and glTF
  //     without EXT_mesh_features;
  //   - the feature-pick texture has not been built, because the application
  //     did not opt into per-feature picking;
  //   - the feature ID lookup fails, because this pixel has no feature ID
  //     attribute or texture sample.
  //
  // The feature ID resolves from either the EXT_mesh_features texture or the
  // per-vertex `_FEATURE_ID_0` attribute (b3dm's `_BATCHID`). Both branches are
  // required: a texture-only gate never matches a b3dm tileset, which would
  // leave every one of them on the primitive-granular pick colour.
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
      // Gate on RGB, not alpha. Pick-ID colours come from `Color.fromRgba(key)`,
      // which on a little-endian host packs the key low to high: red is
      // `key & 0xff`, green `(key >> 8) & 0xff`, blue `(key >> 16) & 0xff` and
      // alpha `(key >> 24) & 0xff`. Every key below 2^24 — in practice all of
      // them — therefore has alpha 0, so an `a > 0.004` test falls through to
      // the per-primitive pick colour for every feature, and b3dm picks resolve
      // to the Model rather than the Cesium3DTileFeature. An unallocated
      // feature texel is (0,0,0,0), while a valid pickId has a nonzero key and
      // so nonzero RGB. This is the same nonzero-RGB decode
      // `WebGPUPickFramebuffer.pickObjectsFromPixels` performs.
      if (featurePickColor.r > 0.0 || featurePickColor.g > 0.0 || featurePickColor.b > 0.0) {
        return makeModelPickOut(featurePickColor, pickLogDepth);
      }
    }
  }

  return makeModelPickOut(material.pickColor, pickLogDepth);
}

// Snapping-pass fragment output: the WGSL twin of the GLSL snap payload that
// `DerivedCommand.createSnapDerivedCommand` compiles into a snap-derived shader
// from the `DrawCommand.snapId` expression `PickingPipelineStage.snapIdFromPickId`
// builds:
//
//     vec4(rgba8UnormToUint32(pickColor), isEdge ? 1.0 : 0.0, -v_positionEC.z, 0.0)
//
// WebGL retains that RGBA32F layout. WebGPU targets an RG32Uint attachment and
// transports the same decoded information in two exact 32-bit words:
//
//   R — the uint32 pick key, with no uint-to-f32 precision loss above 2^24.
//   G — linear EYE-SPACE depth (`-positionEC.z`) as positive IEEE-754 f32 bits;
//       the otherwise-clear sign bit carries isEdge.
//
// Eye space is global across the multifrustum and independent of log-depth, so
// `Snapping.snapHitToWorld` can unproject the decoded f32 directly. The public
// hit object remains identical between WebGL and WebGPU.
//
// `positionEC` is produced by the VS as
// `camera.modelViewRelativeToEye * vec4(rte, 1.0)` — already relative-to-eye, so
// the depth channel obeys the RTE law without a separate high/low pair (the
// quantity written is a CAMERA-RELATIVE distance, never an absolute position).
//
// isEdge is always false here. A model's edges are rasterized by the separate
// `WebGPUEdgeVisibilityEmitter` line pipeline, which carries no pick ID, rather
// than by a second model draw with the GLSL path's `u_isEdgePass` uniform, so
// edge snap candidates would require the emitter to grow a snap payload.
// Surface snapping is unaffected: `selectBestHit` falls back to the closest
// surface when a region contains no edge hits.
struct SnapFragOutput {
  @location(0) payload: vec2<u32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};

// WGSL twin of the `snapHelperSource` GLSL helper injected by
// `DerivedCommand.getSnapShaderProgram`. Repacks an RGBA8-normalized pick color
// into its uint32 pick key so the key survives losslessly in the integer word.
// The `* 255.0 + 0.5` round-trip matches the GLSL byte decode exactly.
fn rgba8UnormToUint32(c: vec4<f32>) -> u32 {
  let b = vec4<u32>(c * 255.0 + 0.5);
  return b.r | (b.g << 8u) | (b.b << 16u) | (b.a << 24u);
}

fn makeModelSnapOut(
  pickColor: vec4<f32>,
  isEdge: bool,
  positionEC: vec3<f32>,
  logDepth: f32,
) -> SnapFragOutput {
  var out: SnapFragOutput;
  let depthBits = bitcast<u32>(-positionEC.z) & 0x7fffffffu;
  out.payload = vec2<u32>(
    rgba8UnormToUint32(pickColor),
    depthBits | select(0u, 0x80000000u, isEdge),
  );
  //>>ifdef LOG_DEPTH
  // The snapping pass shares the pick mini-frame's depth attachment, which the
  // ordinary pick fleet populated in the occluder phase. Write the SAME log
  // encoding `fragmentPickMain` writes so the payload phase's `less-equal` test
  // compares coherently against it.
  out.depth = csm_writeLogDepth(logDepth, camera.logDepthFactor);
  //>>endif
  return out;
}

// Snapping-pass fragment entry: structurally the snap twin of
// `fragmentPickMain`, with the identical discard chain — split, clip,
// alpha-mask, blend-epsilon, batch-table hide — and identical per-feature
// pick-colour resolution, except that a surviving fragment writes the float
// snap payload above instead of the RGBA8 pick colour. The discard chain is
// duplicated rather than factored out for the same reason
// `fragmentPickHoverMain` duplicates it: the entries differ in their output
// struct, and WGSL cannot return a different struct from a shared helper.
@fragment fn fragmentSnapMain(input: FragmentInput) -> SnapFragOutput {
  let flags = material.materialFlags;
  //>>ifdef LOG_DEPTH
  let snapLogDepth = input.v_logDepth;
  //>>else
  let snapLogDepth = 0.0;
  //>>endif
  // Hoist the baseColor UV derivatives before any discard — see
  // fragmentPickMain — so the alpha-test mip selection matches the colour pass.
  let baseColorUV_dx = dpdx(baseColorUV(input));
  let baseColorUV_dy = dpdy(baseColorUV(input));
  //>>ifdef MODEL_SPLIT_ENABLED
  if (material._pad_end2 < 0.0 && input.fragCoord.x > material._pad_end3) { discard; }
  if (material._pad_end2 > 0.0 && input.fragCoord.x < material._pad_end3) { discard; }
  //>>endif

  if (effects.clippingPlaneCount > 0u) {
    if (modelClipByPlanes(input.positionEC) < 0.0) { discard; }
  }
  if (effects.clippingPolygonCount > 0u) {
    let worldPos = camera.cameraPositionWC
      + (material.modelMatrix * vec4<f32>(input.rteMC, 0.0)).xyz;
    if (modelClipByPolygon(worldPos)) { discard; }
  }

  var baseColor = material.baseColorFactor;

  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    baseColor = vec4<f32>(material.diffuseFactor_r, material.diffuseFactor_g,
                          material.diffuseFactor_b, material.diffuseFactor_a);
    if (hasFlag(flags, FLAG_HAS_DIFFUSE_TEXTURE)) {
      let tc = textureSampleGrad(baseColorTexture, baseColorSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy);
      baseColor = baseColor * tc;
    }
  } else if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
    let tc = textureSampleGrad(baseColorTexture, baseColorSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy);
    baseColor = baseColor * tc;
  }

  if (hasFlag(flags, FLAG_HAS_VERTEX_COLORS)) {
    baseColor = baseColor * input.color0;
  }

  if (hasFlag(flags, FLAG_ALPHA_MODE_MASK)) {
    if (baseColor.a < material.alphaCutoff) { discard; }
  }

  if (hasFlag(flags, FLAG_ALPHA_MODE_BLEND)) {
    if (baseColor.a < 0.004) { discard; }
  }

  let snapHasFidTex = hasFlag(flags, FLAG_HAS_FEATURE_ID_TEXTURE);
  let snapHasFidAttr = hasFlag(flags, FLAG_HAS_FEATURE_ID_ATTRIBUTE);
  if ((snapHasFidTex || snapHasFidAttr) && hasFlag(flags, FLAG_HAS_BATCH_TABLE)) {
    var fidInt: i32;
    if (snapHasFidTex) {
      let fidSample = textureSampleLevel(featureIdTexture, featureIdSampler, input.texCoord0, 0.0);
      fidInt = unpackFeatureId(fidSample, featureId.channelCount);
    } else {
      fidInt = i32(input.featureId0);
    }
    let batchColor = lookupBatchColor(fidInt);
    if (batchColor.a < 0.004) { discard; }
    if (featureId.featurePickEnabled > 0.5) {
      let featurePickColor = lookupFeaturePickColor(fidInt);
      // Same RGB!=0 validity gate as fragmentPickMain — pick keys below 2^24
      // have alpha 0, so an alpha test would reject every real feature.
      if (featurePickColor.r > 0.0 || featurePickColor.g > 0.0 || featurePickColor.b > 0.0) {
        return makeModelSnapOut(featurePickColor, false, input.positionEC, snapLogDepth);
      }
    }
  }

  return makeModelSnapOut(material.pickColor, false, input.positionEC, snapLogDepth);
}

// The metadata-pick fragment entry that produces `scene.pickMetadata`. The WGSL
// sibling of the `metadataPickingStage` path in `ModelFS.glsl`, the
// `#ifdef METADATA_PICKING_ENABLED` branch that sets `color = metadataValues`.
//
// `//>>ifdef METADATA_PICKING_ENABLED` restricts the entry to the pick-metadata
// module variant, the only module the generated metadata-pick chunk — which
// appends `fn metadataPickingStage(metadata) -> vec4<f32>` — is prepended to.
// Display, on-screen and regular-pick modules never set the bit, so the entry
// is stripped at preprocess time and their modules are unaffected. The bit also
// sits outside MATERIAL_DEFINE_MASK, so it never touches the bind-group layout,
// pipeline layout or vertex layout.
//
// It populates `metadata` exactly as the display path does, through the same
// generated `initializeMetadata`, reading the attribute scalar, property
// textures and property-table row. `metadataPickingStage` then packs the picked
// property's components — with offset, scale and normalization un-applied —
// into the RGBA8 pick-framebuffer channels
// `MetadataPicking.decodeMetadataValues` reads back. No lighting, PBR or IBL is
// evaluated, since the pick framebuffer carries only the metadata bytes.
// Alpha-mask and blend discards still run, so masked or fully transparent
// fragments do not claim the metadata pick.
//>>ifdef METADATA_PICKING_ENABLED
@fragment fn fragmentPickMetadataMain(input: FragmentInput) -> PickFragOutput {
  let flags = material.materialFlags;
  //>>ifdef LOG_DEPTH
  // See fragmentPickHoverMain — the interpolated log-depth source, gated so the
  // default pick module (LOG_DEPTH off, `v_logDepth` stripped) stays compilable
  // and byte-identical.
  let pickLogDepth = input.v_logDepth;
  //>>else
  let pickLogDepth = 0.0;
  //>>endif
  // Hoist the baseColor UV derivatives to the entry, in uniform control flow
  // and before the split and alpha discards, so the alpha-test baseColor sample
  // uses textureSampleGrad and selects the same mip as fragmentMain, keeping
  // the discard consistent across the metadata-pick and colour passes at
  // distance.
  let baseColorUV_dx = dpdx(baseColorUV(input));
  let baseColorUV_dy = dpdy(baseColorUV(input));
  //>>ifdef MODEL_SPLIT_ENABLED
  // WIRE-MODEL-SPLITTER — the hidden half of a split model must not claim
  // the metadata pick. WebGL's deriveMetadataPickingShader only adds
  // defines, so the splitter FS stage stays in the derived shader; mirror
  // the fragmentMain discard here (see fragmentMain for the pad-lane
  // convention: _pad_end2 = direction, _pad_end3 = split position px).
  if (material._pad_end2 < 0.0 && input.fragCoord.x > material._pad_end3) { discard; }
  if (material._pad_end2 > 0.0 && input.fragCoord.x < material._pad_end3) { discard; }
  //>>endif

  // Resolve baseColor.a for the mask / blend discards (same minimal path as
  // fragmentPickMain — the metadata pass doesn't need full shading).
  var baseColor = material.baseColorFactor;
  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    baseColor = vec4<f32>(material.diffuseFactor_r, material.diffuseFactor_g,
                          material.diffuseFactor_b, material.diffuseFactor_a);
    if (hasFlag(flags, FLAG_HAS_DIFFUSE_TEXTURE)) {
      let tc = textureSampleGrad(baseColorTexture, baseColorSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy);
      baseColor = baseColor * tc;
    }
  } else if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
    let tc = textureSampleGrad(baseColorTexture, baseColorSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy);
    baseColor = baseColor * tc;
  }
  if (hasFlag(flags, FLAG_HAS_VERTEX_COLORS)) {
    baseColor = baseColor * input.color0;
  }
  if (hasFlag(flags, FLAG_ALPHA_MODE_MASK)) {
    if (baseColor.a < material.alphaCutoff) { discard; }
  }
  if (hasFlag(flags, FLAG_ALPHA_MODE_BLEND)) {
    if (baseColor.a < 0.004) { discard; }
  }

  // Populate the metadata exactly as the display path does. The texCoord1 arg
  // falls back to texCoord0 when the primitive lacks TEXCOORD_1 (same as the
  // display call site). `input.metadataValue` carries the attribute scalar when
  // MODEL_HAS_METADATA is set; for texture-/table-only models it's 0.0 and the
  // generated initializer ignores it.
  //>>ifdef MODEL_HAS_TEXCOORD_1
  let metaPickTC1 = input.texCoord1;
  //>>else
  let metaPickTC1 = input.texCoord0;
  //>>endif
  //>>ifdef MODEL_HAS_METADATA
  // The extended call for the widened MAT3 and MAT4 transport, matching the
  // display call site.
  //>>ifdef MODEL_METADATA_MAT_TRANSPORT
  let pickMetadata = initializeMetadata(input.metadataValue, input.metadataValue1, input.metadataValue2, input.metadataValue3, input.texCoord0, metaPickTC1, input.featureId0);
  //>>else
  let pickMetadata = initializeMetadata(input.metadataValue, input.texCoord0, metaPickTC1, input.featureId0);
  //>>endif
  //>>else
  let pickMetadata = initializeMetadata(vec4<f32>(0.0), input.texCoord0, metaPickTC1, input.featureId0);
  //>>endif

  return makeModelPickOut(metadataPickingStage(pickMetadata), pickLogDepth);
}
//>>endif

// Velocity-only fragment entry. Writes per-pixel screen-space motion to a
// single rg16float colour attachment, the scene framebuffer's velocity texture
// that `ensureVelocityTexture` allocates. The velocity pipeline variant selects
// it; the pass runs after the main colour pass and shares scene depth as a
// read-only attachment, so fragments occluded by opaque geometry emit no
// velocity.
//
// This is a separate pass rather than a second MRT target on the main pass
// because the main scene render pass is shared by globe, primitive, billboard
// and model commands, all of which would have to grow a second colour target on
// every pipeline variant to satisfy WebGPU's pipeline-versus-render-pass
// attachment-count parity rule. Routing only model commands through a dedicated
// single-target velocity pass keeps that cost at zero — the rest of the
// renderer stays single-target — while still producing the per-pixel velocity
// texture the TAA shader binds.
//
// It returns the NDC-space delta of `clip.xy / clip.w`, which the TAA shader's
// `sampleMotionTexture` converts to a UV delta by `* vec2(0.5, -0.5)`. It
// returns vec2(0) when motion is disabled for the primitive
// (`motionFlags.x < 0.5`), so a static model emits no stale velocity.
//
// Alpha-mask discards run exactly as in fragmentMain, so masked-out texels
// leak no velocity into hole pixels. Lighting, IBL, atmosphere and edge stages
// are skipped; this emits motion vectors only.
struct VelocityFragOutput {
  @location(0) velocity: vec2<f32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment fn fragmentVelocityMain(input: FragmentInput) -> VelocityFragOutput {
  let flags = material.materialFlags;
  // Hoist the baseColor UV derivatives to the entry, in uniform control flow,
  // so the alpha-test baseColor sample uses textureSampleGrad and selects the
  // same mip as fragmentMain, keeping the alpha-mask discard consistent across
  // the velocity and colour passes at distance.
  let baseColorUV_dx = dpdx(baseColorUV(input));
  let baseColorUV_dy = dpdy(baseColorUV(input));

  // Alpha-mask discard parity with the color pass.
  var baseColor = material.baseColorFactor;
  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    baseColor = vec4<f32>(material.diffuseFactor_r, material.diffuseFactor_g,
                          material.diffuseFactor_b, material.diffuseFactor_a);
    if (hasFlag(flags, FLAG_HAS_DIFFUSE_TEXTURE)) {
      let tc = textureSampleGrad(baseColorTexture, baseColorSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy);
      baseColor = baseColor * tc;
    }
  } else if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
    let tc = textureSampleGrad(baseColorTexture, baseColorSampler, baseColorUV(input), baseColorUV_dx, baseColorUV_dy);
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

// Classifier fragment entry. Drapes the model's shape onto terrain or 3D-Tile
// surfaces by sampling the same packed globe-depth texture the depth-sample
// classifier renderers use, at group 3 binding 15, and discarding where the
// sampled depth is 0 — sky, or no surface. The colour comes from
// `material.baseColorFactor`, so the drape tint is tunable through the model's
// primary material.
//
// Unlike `fragmentMain` this entry skips PBR, IBL, lighting, shadows, edges and
// atmosphere, producing a single classification colour per pixel. The pipeline
// pairs it with the existing `vertexMain`: the model's geometry is itself the
// classifier volume, so no separate shadow-volume extrusion is needed — its
// mesh already encodes the drape shape.
//
// Viewport size is recovered from `textureDimensions(globeDepthTex)`
// instead of a UBO field — the globe depth texture is sized to the
// drawing buffer, identical to the fragment-coordinate space.
@fragment fn fragmentClassificationMain(input: FragmentInput) -> @location(0) vec4<f32> {
  //>>ifdef MODEL_SPLIT_ENABLED
  // WIRE-MODEL-SPLITTER — classification-model draws honor splitDirection
  // like WebGL's stage-chained classification FS. Same pad-lane convention
  // as fragmentMain (_pad_end2 = direction, _pad_end3 = split position px).
  if (material._pad_end2 < 0.0 && input.fragCoord.x > material._pad_end3) { discard; }
  if (material._pad_end2 > 0.0 && input.fragCoord.x < material._pad_end3) { discard; }
  //>>endif
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
