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
@group(2) @binding(0) var baseColorTexture: texture_2d<f32>;
@group(2) @binding(1) var baseColorSampler: sampler;
@group(2) @binding(2) var normalTexture: texture_2d<f32>;
@group(2) @binding(3) var normalSampler: sampler;
@group(2) @binding(4) var metallicRoughnessTexture: texture_2d<f32>;
@group(2) @binding(5) var metallicRoughnessSampler: sampler;
@group(2) @binding(6) var emissiveTexture: texture_2d<f32>;
@group(2) @binding(7) var emissiveSampler: sampler;
@group(2) @binding(8) var occlusionTexture: texture_2d<f32>;
@group(2) @binding(9) var occlusionSampler: sampler;

// Joint matrices for skinning (bind group 3, only used when FLAG_HAS_SKINNING is set)
@group(3) @binding(0) var<storage, read> jointMatrices: array<mat4x4<f32>>;

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
@group(4) @binding(0) var<storage, read> morphDeltas: array<vec4<f32>>;
@group(4) @binding(1) var<uniform> morphWeights: MorphWeightsUniforms;

// Instance transforms (bind group 5, only used when FLAG_HAS_INSTANCING is set)
// Storage buffer: array of mat4x4 — one per instance, column-major.
// Instance transform is applied to position/normal/tangent BEFORE morph/skin/RTE.
@group(5) @binding(0) var<storage, read> instanceTransforms: array<mat4x4<f32>>;

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
  _pad0: f32,
  _pad1: f32,
};
@group(6) @binding(0) var featureIdTexture: texture_2d<f32>;
@group(6) @binding(1) var featureIdSampler: sampler;
@group(6) @binding(2) var batchTexture: texture_2d<f32>;
@group(6) @binding(3) var batchSampler: sampler;
@group(6) @binding(4) var<uniform> featureId: FeatureIdUniforms;

// ─── Effects bind group (shadow receive + clipping + atmosphere + CSM) ───
// CSM Slice 2c — models now bind the effects group at @group(7) so the
// fragment shader can sample cascaded shadows alongside PBR lighting.
// Struct layout MUST match the 304-byte EffectsUniforms in
// WebGPUEffectsBindGroup.js. Every trailing field must be present
// (even when not consumed here) so `csmControl` / `edgeControl` /
// `edgeViewport` read from the right bytes.
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

@group(7) @binding(0) var<uniform> effects: EffectsUniforms;
@group(7) @binding(1) var shadowDepthTex: texture_depth_2d;
@group(7) @binding(2) var shadowCompSampler: sampler_comparison;
@group(7) @binding(3) var clippingPlaneTex: texture_2d<f32>;
@group(7) @binding(4) var clippingPlaneSampler: sampler;
// FEAT-GAP-09 — Aerial-perspective LUT. Bindings 7/8/9 are populated by
// WebGPUEffectsBindGroup.js when the atmosphere LUT is active; otherwise
// they resolve to 1×1 placeholder textures. Gated by
// `effects.atmosphereLutControl.x > 0.5` in fragmentMain. Note: this
// shader's own group-2 bindings 7/8/9 are the PBR occlusion/emissive
// textures (different group), so there's no collision.
@group(7) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(7) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(7) @binding(9) var atmosphereLutSampler: sampler;
@group(7) @binding(10) var<uniform> csmParams: CSMParams;
@group(7) @binding(11) var cascadeDepthArray: texture_depth_2d_array;
// C-R8-EDGE-INLINE — inline edge-detection resources. The edge MRT
// views populate at the start of `_execute3DTilePasses` (before the
// model's OPAQUE pass); the globe packed-depth view is produced by
// `WebGPUGlobeDepth.executeCopyDepth` even earlier. Sampler at 16 is
// shared filtering. Gated at call site on `effects.edgeControl.x > 0.5`
// so dead bindings (placeholder 1×1 transparent textures) never
// influence the lit fragment.
@group(7) @binding(12) var edgeColorTex: texture_2d<f32>;
@group(7) @binding(13) var edgeIdTex: texture_2d<f32>;
@group(7) @binding(14) var edgeDepthTex: texture_2d<f32>;
@group(7) @binding(15) var globeDepthTex: texture_2d<f32>;
@group(7) @binding(16) var edgeSampler: sampler;

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
  @builtin(front_facing) frontFacing: bool,
};

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

// Pick TEXCOORD_0 or TEXCOORD_1 for a given texture slot based on the
// bitmask uploaded by the CPU (one bit per slot). glTF textureInfos
// each carry a `texCoord: 0|1` flag; occlusion and clearcoat-normal
// commonly want slot 1 while base color stays on slot 0.
fn selectUV(input: FragmentInput, slotBit: u32) -> vec2<f32> {
  let useUV1 = (material.texCoordFlags & slotBit) != 0u;
  return select(input.texCoord0, input.texCoord1, useUV1);
}

@fragment fn fragmentMain(input: FragmentInput) -> @location(0) vec4<f32> {
  let flags = material.materialFlags;

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
      let tc = textureSample(baseColorTexture, baseColorSampler, selectUV(input, TEXCOORD_BIT_BASE_COLOR));
      baseColor = baseColor * tc;
    }
  } else {
    if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
      let tc = textureSample(baseColorTexture, baseColorSampler, selectUV(input, TEXCOORD_BIT_BASE_COLOR));
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
    let nm = textureSample(normalTexture, normalSampler, selectUV(input, TEXCOORD_BIT_NORMAL)).rgb;
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
      let sg = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, selectUV(input, TEXCOORD_BIT_METALLIC_ROUGHNESS));
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
      let mr = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, selectUV(input, TEXCOORD_BIT_METALLIC_ROUGHNESS));
      roughness = roughness * mr.g;
      metallic = metallic * mr.b;
    }
    roughness = clamp(roughness, 0.04, 1.0);
    metallic = clamp(metallic, 0.0, 1.0);
    F0 = mix(vec3<f32>(0.04), baseColor.rgb, metallic);
    diffuseColor = baseColor.rgb * (1.0 - metallic);
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

  // CSM Slice 2c — route direct sunlight through the cascaded shadow
  // path when the scene has CSM enabled. Convention matches the primitive
  // receivers: `viewDepth = |positionEC.z|` (eye-space Z in Cesium's
  // looking -Z convention), eyePos = world-space camera-relative vector
  // derived by rotating the model-space RTE through the model matrix (w=0
  // treats it as a direction, so the model's translation doesn't apply —
  // result is exactly `pWC - camWC` without FP32 reconstruction at Earth
  // scale). Ambient / emissive remain unshadowed per PBR convention.
  if (effects.csmControl.x > 0.5) {
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
    let ao = textureSample(occlusionTexture, occlusionSampler, selectUV(input, TEXCOORD_BIT_OCCLUSION)).r;
    ambient = mix(ambient, ambient * ao, material.occlusionStrength);
  }

  // ── Emissive ──────────────────────────────────────────────────────────────
  // Emissive texture is uploaded as `rgba8unorm-srgb`, so textureSample
  // already returns linear values. See the base-color block above for the
  // full rationale on sRGB format selection.
  var emissive = material.emissiveFactor;
  if (hasFlag(flags, FLAG_HAS_EMISSIVE_TEXTURE)) {
    let et = textureSample(emissiveTexture, emissiveSampler, selectUV(input, TEXCOORD_BIT_EMISSIVE)).rgb;
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
      let tc = textureSample(baseColorTexture, baseColorSampler, selectUV(input, TEXCOORD_BIT_BASE_COLOR));
      baseColor = baseColor * tc;
    }
  } else if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
    let tc = textureSample(baseColorTexture, baseColorSampler, selectUV(input, TEXCOORD_BIT_BASE_COLOR));
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
  if (hasFlag(flags, FLAG_HAS_FEATURE_ID_TEXTURE) && hasFlag(flags, FLAG_HAS_BATCH_TABLE)) {
    let fidSample = textureSample(featureIdTexture, featureIdSampler, input.texCoord0);
    let fidInt = unpackFeatureId(fidSample, featureId.channelCount);
    let batchColor = lookupBatchColor(fidInt);
    if (batchColor.a < 0.004) { discard; }
  }

  return material.pickColor;
}
