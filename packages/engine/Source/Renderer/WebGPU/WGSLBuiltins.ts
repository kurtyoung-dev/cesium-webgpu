/**
 * @module WGSLBuiltins
 *
 * Built-in WGSL shader chunks for CesiumJS WebGPU.
 * This module registers all default shader chunks with the WGSLShaderLibrary,
 * analogous to CzmBuiltins.js for the GLSL shader system.
 *
 * ## Organization
 * - **structs/**: Reusable uniform buffer and data structures
 * - **functions/**: Reusable shader functions (lighting, color, math)
 *
 * ## Naming Convention
 * - Functions use `csm_` prefix (Cesium Shader Module), mirroring `czm_` for GLSL
 * - Structs use PascalCase (e.g., CameraUniforms, PBRMaterial)
 * - Constants use `CSM_` prefix (e.g., CSM_PI, CSM_EPSILON7)
 *
 * ## Source of Truth & Sync Strategy (S4-1)
 *
 * **`WGSLBuiltins.ts` is the authoritative source** for all built-in shader chunks.
 * The inline string constants below are what the preprocessor actually uses at runtime.
 *
 * The `.wgsl` files in `Source/Shaders/WebGPU/chunks/` are **reference copies** intended for:
 * - IDE syntax highlighting and WGSL language server support
 * - Documentation and human-readable browsing
 * - Potential future use in a build step that auto-generates this file
 *
 * ### Rules
 * 1. **Edit `WGSLBuiltins.ts` first** when modifying chunk code.
 * 2. Copy changes to the corresponding `.wgsl` file to keep them in sync.
 * 3. The `.wgsl` files may include doc-comment headers (`/** ... *'/`) that are
 *    stripped by the preprocessor — this is fine and expected.
 * 4. A future build step may automate this sync (see WGSL_IMPORT_SYSTEM.md).
 */

import { WGSLShaderLibrary } from "./WGSLShaderPreprocessor.js";

// ============================================================================
// Inline chunk sources
// These are embedded directly to avoid async file loading at runtime.
// They match the .wgsl files in Source/Shaders/WebGPU/chunks/
// ============================================================================

// --- Structs ---

const CameraUniforms = `
struct CameraUniforms {
    // Standard matrices
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    viewProjectionMatrix: mat4x4<f32>,

    // Camera position (world space)
    cameraPosition: vec3<f32>,
    _padding0: f32,

    // RTE: Encoded camera position in model coordinates (high/low split)
    encodedCameraPositionMCHigh: vec3<f32>,
    _padding1: f32,
    encodedCameraPositionMCLow: vec3<f32>,
    _padding2: f32,

    // RTE: Matrices with translation zeroed (for use with eye-relative positions)
    modelViewRelativeToEye: mat4x4<f32>,
    modelViewProjectionRelativeToEye: mat4x4<f32>,
}
`;

const ModelUniforms = `
struct ModelUniforms {
    modelMatrix: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
}
`;

const LightUniforms = `
struct LightUniforms {
    lightDirection: vec3<f32>,
    _padding1: f32,
    lightColor: vec3<f32>,
    lightIntensity: f32,
    ambientColor: vec3<f32>,
    _padding2: f32,
    diffuseColor: vec3<f32>,
    _padding3: f32,
    specularColor: vec3<f32>,
    shininess: f32,
}
`;

const LightingUniforms = `
struct LightingUniforms {
    lightDirection: vec3<f32>,
    _padding1: f32,
    lightColor: vec3<f32>,
    lightIntensity: f32,
    iblIntensity: f32,
    _padding2: vec3<f32>,
}
`;

const PBRMaterial = `
struct PBRMaterial {
    baseColorFactor: vec4<f32>,
    metallicFactor: f32,
    roughnessFactor: f32,
    normalScale: f32,
    occlusionStrength: f32,
    emissiveFactor: vec3<f32>,
    _padding: f32,
}
`;

// --- Functions ---

const csm_constants = `
const CSM_PI: f32 = 3.14159265359;
const CSM_TWO_PI: f32 = 6.28318530718;
const CSM_HALF_PI: f32 = 1.57079632679;
const CSM_ONE_OVER_PI: f32 = 0.31830988618;
const CSM_ONE_OVER_TWO_PI: f32 = 0.15915494309;
const CSM_EPSILON1: f32 = 0.1;
const CSM_EPSILON2: f32 = 0.01;
const CSM_EPSILON3: f32 = 0.001;
const CSM_EPSILON4: f32 = 0.0001;
const CSM_EPSILON5: f32 = 0.00001;
const CSM_EPSILON6: f32 = 0.000001;
const CSM_EPSILON7: f32 = 0.0000001;
`;

const csm_distributionGGX = `
// #import "functions/csm_constants"

fn csm_distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH = max(dot(N, H), 0.0);
    let NdotH2 = NdotH * NdotH;

    let nom = a2;
    var denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = CSM_PI * denom * denom;

    return nom / denom;
}
`;

const csm_geometrySmith = `
fn csm_geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    let nom = NdotV;
    let denom = NdotV * (1.0 - k) + k;
    return nom / denom;
}

fn csm_geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
    let NdotV = max(dot(N, V), 0.0);
    let NdotL = max(dot(N, L), 0.0);
    let ggx2 = csm_geometrySchlickGGX(NdotV, roughness);
    let ggx1 = csm_geometrySchlickGGX(NdotL, roughness);
    return ggx1 * ggx2;
}
`;

const csm_fresnelSchlick = `
fn csm_fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (vec3<f32>(1.0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn csm_fresnelSchlickRoughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
    return F0 + (max(vec3<f32>(1.0 - roughness), F0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}
`;

const csm_phong = `
struct CsmPhongResult {
    ambient: vec3<f32>,
    diffuse: vec3<f32>,
    specular: vec3<f32>,
    combined: vec3<f32>,
}

fn csm_phong(
    N: vec3<f32>,
    V: vec3<f32>,
    L: vec3<f32>,
    lightColor: vec3<f32>,
    lightIntensity: f32,
    ambientColor: vec3<f32>,
    diffuseColor: vec3<f32>,
    specularColor: vec3<f32>,
    shininess: f32,
) -> CsmPhongResult {
    var result: CsmPhongResult;
    result.ambient = ambientColor * diffuseColor;
    let NdotL = max(dot(N, L), 0.0);
    result.diffuse = diffuseColor * lightColor * NdotL * lightIntensity;
    let H = normalize(L + V);
    let NdotH = max(dot(N, H), 0.0);
    let spec = pow(NdotH, shininess);
    result.specular = specularColor * lightColor * spec * lightIntensity;
    result.combined = result.ambient + result.diffuse + result.specular;
    return result;
}

fn csm_phongSimple(
    N: vec3<f32>,
    V: vec3<f32>,
    L: vec3<f32>,
    baseColor: vec3<f32>,
    shininess: f32,
) -> vec3<f32> {
    let ambient = 0.15 * baseColor;
    let NdotL = max(dot(N, L), 0.0);
    let diffuse = 0.7 * baseColor * NdotL;
    let H = normalize(L + V);
    let NdotH = max(dot(N, H), 0.0);
    let specular = 0.15 * pow(NdotH, shininess);
    return ambient + diffuse + vec3<f32>(specular);
}
`;

const csm_tonemapping = `
fn csm_reinhardTonemap(color: vec3<f32>) -> vec3<f32> {
    return color / (color + vec3<f32>(1.0));
}

fn csm_acesTonemap(color: vec3<f32>) -> vec3<f32> {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn csm_uncharted2Helper(x: vec3<f32>) -> vec3<f32> {
    let A = 0.15;
    let B = 0.50;
    let C = 0.10;
    let D = 0.20;
    let E = 0.02;
    let F = 0.30;
    return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

fn csm_uncharted2Tonemap(color: vec3<f32>) -> vec3<f32> {
    let W = 11.2;
    let exposureBias = 2.0;
    let curr = csm_uncharted2Helper(exposureBias * color);
    let whiteScale = vec3<f32>(1.0) / csm_uncharted2Helper(vec3<f32>(W));
    return curr * whiteScale;
}
`;

const csm_gammaCorrection = `
fn csm_linearToSrgb(color: vec3<f32>) -> vec3<f32> {
    return pow(color, vec3<f32>(1.0 / 2.2));
}

fn csm_srgbToLinear(color: vec3<f32>) -> vec3<f32> {
    return pow(color, vec3<f32>(2.2));
}

fn csm_linearToSrgbAccurate(color: vec3<f32>) -> vec3<f32> {
    let cutoff = vec3<f32>(0.0031308);
    let low = color * 12.92;
    let high = 1.055 * pow(color, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(high, low, color <= cutoff);
}

fn csm_srgbToLinearAccurate(color: vec3<f32>) -> vec3<f32> {
    let cutoff = vec3<f32>(0.04045);
    let low = color / 12.92;
    let high = pow((color + 0.055) / 1.055, vec3<f32>(2.4));
    return select(high, low, color <= cutoff);
}
`;

const csm_translateRelativeToEye = `
// RTE (Relative-To-Eye) emulated 64-bit precision for planetary-scale rendering.
// Subtracts encoded camera position from encoded vertex position in split domain.
fn csm_translateRelativeToEye(
    positionHigh: vec3<f32>,
    positionLow: vec3<f32>,
    encodedCameraPositionMCHigh: vec3<f32>,
    encodedCameraPositionMCLow: vec3<f32>,
) -> vec4<f32> {
    var highDifference = positionHigh - encodedCameraPositionMCHigh;
    if (length(highDifference) == 0.0) {
        highDifference = vec3<f32>(0.0, 0.0, 0.0);
    }
    let lowDifference = positionLow - encodedCameraPositionMCLow;
    return vec4<f32>(highDifference + lowDifference, 1.0);
}
`;

const csm_decodeRGB8 = `
// Decodes RGB values packed into a single float at 8-bit precision.
// Encoded representation is equivalent to 0xFFFFFF in JavaScript.
fn csm_decodeRGB8(encoded: f32) -> vec4<f32> {
    let SHIFT_RIGHT16: f32 = 1.0 / 65536.0;
    let SHIFT_RIGHT8: f32 = 1.0 / 256.0;
    let SHIFT_LEFT16: f32 = 65536.0;
    let SHIFT_LEFT8: f32 = 256.0;

    let r = floor(encoded * SHIFT_RIGHT16);
    let g = floor((encoded - r * SHIFT_LEFT16) * SHIFT_RIGHT8);
    let b = floor(encoded - r * SHIFT_LEFT16 - g * SHIFT_LEFT8);

    return vec4<f32>(r, g, b, 255.0) / 255.0;
}
`;

const csm_unpackTexture = `
// Reinterprets texture data as higher-precision unsigned integer values.
// Byte order: LITTLE-ENDIAN (matches GLSL czm_unpackTexture)
// Component x = byte 0 (LSB), y = byte 1, z = byte 2, w = byte 3 (MSB)
fn csm_unpackTexture1(channel: f32) -> u32 {
    return u32(channel * 255.0 + 0.5);
}

fn csm_unpackTexture2(channels: vec2<f32>) -> u32 {
    let bytes = vec2<u32>(channels * 255.0 + vec2<f32>(0.5));
    return bytes.x | (bytes.y << 8u);
}

fn csm_unpackTexture3(channels: vec3<f32>) -> u32 {
    let bytes = vec3<u32>(channels * 255.0 + vec3<f32>(0.5));
    return bytes.x | (bytes.y << 8u) | (bytes.z << 16u);
}

fn csm_unpackTexture4(channels: vec4<f32>) -> u32 {
    let bytes = vec4<u32>(channels * 255.0 + vec4<f32>(0.5));
    return bytes.x | (bytes.y << 8u) | (bytes.z << 16u) | (bytes.w << 24u);
}
`;

// Logarithmic depth for multi-frustum rendering (WebGPU uses a 0..1 NDC depth
// range). CANONICAL CONTRACT — these inline copies MUST stay byte-compatible
// with the .wgsl chunk files under Shaders/WebGPU/chunks/functions/. Slice 0 of
// the renderer-wide log-depth epic de-bundled csm_vertexLogDepth (which used to
// be defined inside csm_writeLogDepth here AND in its own chunk, colliding) and
// reconciled every signature to the WebGL math.

// functions/csm_vertexLogDepth — vertex stage: returns the LINEAR
// depthFromNearPlusOne to interpolate, + the clip-z clamp companion.
const csm_vertexLogDepth = `
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
  return (clipPosition.w - near) + 1.0;
}

fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
  var coords = clipPosition;
  coords.z = clamp(coords.z / coords.w, 0.0, 1.0) * coords.w;
  return coords;
}
`;

// functions/csm_writeLogDepth — fragment stage: interpolated depthFromNearPlusOne
// -> 0..1 frag depth. Assign to a @builtin(frag_depth) struct field.
const csm_writeLogDepth = `
fn csm_writeLogDepth(depthFromNearPlusOne: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
  return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne;
}
`;

// functions/csm_reverseLogDepth — reverse a 0..1 log-depth value to hyperbolic
// NDC z, plus the high-precision eye-distance variant for classifiers.
const csm_reverseLogDepth = `
fn csm_reverseLogDepth(logZ: f32, near: f32, far: f32) -> f32 {
  if (far == near) { return 0.0; }
  let log2FarDepthFromNearPlusOne = log2((far - near) + 1.0);
  let depthFromNear = exp2(logZ * log2FarDepthFromNearPlusOne) - 1.0;
  let depthFromCamera = depthFromNear + near;
  return far * (1.0 - near / depthFromCamera) / (far - near);
}

fn csm_reverseLogDepthToEyeDistance(logZ: f32, near: f32, far: f32) -> f32 {
  let log2FarDepthFromNearPlusOne = log2((far - near) + 1.0);
  let depthFromNear = exp2(logZ * log2FarDepthFromNearPlusOne) - 1.0;
  return depthFromNear + near;
}
`;

// functions/csm_readDepth — sample a log-depth texture + reverse to NDC z.
// Imports csm_reverseLogDepth; callers must include both chunks.
const csm_readDepth = `
fn csm_readDepth(
  depthTexture: texture_2d<f32>,
  depthSampler: sampler,
  texCoords: vec2<f32>,
  near: f32,
  far: f32,
) -> f32 {
  let rawDepth: f32 = textureSample(depthTexture, depthSampler, texCoords).r;
  return csm_reverseLogDepth(rawDepth, near, far);
}
`;

const csm_getNormalFromMap = `
fn csm_getNormalFromMap(
    normalSample: vec3<f32>,
    normalScale: f32,
    vertexNormal: vec3<f32>,
    vertexTangent: vec3<f32>,
    vertexBitangent: vec3<f32>,
) -> vec3<f32> {
    let tangentNormal = normalSample * 2.0 - 1.0;
    let scaledNormal = vec3<f32>(tangentNormal.xy * normalScale, tangentNormal.z);
    let N = normalize(vertexNormal);
    let T = normalize(vertexTangent);
    let B = normalize(vertexBitangent);
    let TBN = mat3x3<f32>(T, B, N);
    return normalize(TBN * scaledNormal);
}

fn csm_getNormalFromMapSimple(
    normalSample: vec3<f32>,
    normalScale: f32,
    vertexNormal: vec3<f32>,
    vertexTangent: vec4<f32>,
) -> vec3<f32> {
    let tangentNormal = normalSample * 2.0 - 1.0;
    let scaledNormal = vec3<f32>(tangentNormal.xy * normalScale, tangentNormal.z);
    let N = normalize(vertexNormal);
    let T = normalize(vertexTangent.xyz);
    let B = cross(N, T) * vertexTangent.w;
    let TBN = mat3x3<f32>(T, B, N);
    return normalize(TBN * scaledNormal);
}
`;

// ============================================================================
// Library Creation
// ============================================================================

/**
 * Create a WGSLShaderLibrary pre-populated with all built-in CesiumJS shader chunks.
 *
 * @returns {WGSLShaderLibrary} Library with all built-in chunks registered
 *
 * @example
 * ```typescript
 * const library = createDefaultWGSLLibrary();
 * const preprocessor = new WGSLShaderPreprocessor(library);
 * ```
 */
export function createDefaultWGSLLibrary(): WGSLShaderLibrary {
  const library = new WGSLShaderLibrary();

  // Register struct chunks
  library.registerCode("structs/CameraUniforms", CameraUniforms);
  library.registerCode("structs/ModelUniforms", ModelUniforms);
  library.registerCode("structs/LightUniforms", LightUniforms);
  library.registerCode("structs/LightingUniforms", LightingUniforms);
  library.registerCode("structs/PBRMaterial", PBRMaterial);

  // Register function chunks
  library.registerCode("functions/csm_constants", csm_constants);
  library.registerCode("functions/csm_distributionGGX", csm_distributionGGX);
  library.registerCode("functions/csm_geometrySmith", csm_geometrySmith);
  library.registerCode("functions/csm_fresnelSchlick", csm_fresnelSchlick);
  library.registerCode("functions/csm_phong", csm_phong);
  library.registerCode("functions/csm_tonemapping", csm_tonemapping);
  library.registerCode("functions/csm_gammaCorrection", csm_gammaCorrection);
  library.registerCode("functions/csm_getNormalFromMap", csm_getNormalFromMap);
  library.registerCode(
    "functions/csm_translateRelativeToEye",
    csm_translateRelativeToEye,
  );
  library.registerCode("functions/csm_decodeRGB8", csm_decodeRGB8);
  library.registerCode("functions/csm_unpackTexture", csm_unpackTexture);
  library.registerCode("functions/csm_vertexLogDepth", csm_vertexLogDepth);
  library.registerCode("functions/csm_writeLogDepth", csm_writeLogDepth);
  library.registerCode("functions/csm_reverseLogDepth", csm_reverseLogDepth);
  library.registerCode("functions/csm_readDepth", csm_readDepth);

  return library;
}

/**
 * Names of all built-in WGSL shader chunks
 */
export const WGSLBuiltinChunks = {
  // Structs
  CAMERA_UNIFORMS: "structs/CameraUniforms",
  MODEL_UNIFORMS: "structs/ModelUniforms",
  LIGHT_UNIFORMS: "structs/LightUniforms",
  LIGHTING_UNIFORMS: "structs/LightingUniforms",
  PBR_MATERIAL: "structs/PBRMaterial",

  // Functions
  CONSTANTS: "functions/csm_constants",
  DISTRIBUTION_GGX: "functions/csm_distributionGGX",
  GEOMETRY_SMITH: "functions/csm_geometrySmith",
  FRESNEL_SCHLICK: "functions/csm_fresnelSchlick",
  PHONG: "functions/csm_phong",
  TONEMAPPING: "functions/csm_tonemapping",
  GAMMA_CORRECTION: "functions/csm_gammaCorrection",
  GET_NORMAL_FROM_MAP: "functions/csm_getNormalFromMap",
  TRANSLATE_RELATIVE_TO_EYE: "functions/csm_translateRelativeToEye",
  DECODE_RGB8: "functions/csm_decodeRGB8",
  UNPACK_TEXTURE: "functions/csm_unpackTexture",
  VERTEX_LOG_DEPTH: "functions/csm_vertexLogDepth",
  WRITE_LOG_DEPTH: "functions/csm_writeLogDepth",
  REVERSE_LOG_DEPTH: "functions/csm_reverseLogDepth",
  READ_DEPTH: "functions/csm_readDepth",
} as const;

export default createDefaultWGSLLibrary;
