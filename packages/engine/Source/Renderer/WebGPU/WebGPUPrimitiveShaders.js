/**
 * @module WebGPUPrimitiveShaders
 *
 * WebGPU shader definitions and selection logic for the Primitive rendering pipeline.
 * Contains inline WGSL shaders optimized for CesiumJS Primitive geometry, and helper
 * functions for shader selection, vertex layout configuration, and uniform buffer sizing.
 *
 * These shaders use a compact uniform layout designed for per-primitive rendering:
 * - Group 0: Uniform buffer (MVP, ModelView, NormalMatrix, LightDirection)
 * - Group 1: Texture sampler + texture (textured variants only)
 *
 * Shader hierarchy (auto-selected based on geometry attributes):
 * - basic:          position + color
 * - phong:          position + normal + color
 * - basicTextured:  position + uv + color
 * - phongTextured:  position + normal + uv + color
 *
 * @private
 */
import defined from "../../Core/defined.js";

// =========================================================================
// WGSL Shader Strings
// =========================================================================

/**
 * BasicColor Shader: position + color only (no lighting)
 * Uniform: MVP matrix only (64 bytes, padded to 256)
 * @type {string}
 */
const basicColorWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.color = input.color;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    return input.color;
}
`;

/**
 * Phong Shader: position + normal + color (with diffuse + specular lighting)
 * Uniform: MVP(64) + ModelView(64) + NormalMatrix(64) + LightDir(16) = 208 bytes, padded to 256
 * @type {string}
 */
const phongColorWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) worldNormal: vec3<f32>,
    @location(2) viewPosition: vec3<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    modelView: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
    lightDirection: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.clipPosition = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.color = input.color;

    // Transform normal using the normal matrix (upper-left 3x3 of normalMatrix)
    let n = vec3<f32>(
        uniforms.normalMatrix[0].xyz
    );
    let transformedNormal = normalize(
        mat3x3<f32>(
            uniforms.normalMatrix[0].xyz,
            uniforms.normalMatrix[1].xyz,
            uniforms.normalMatrix[2].xyz
        ) * input.normal
    );
    output.worldNormal = transformedNormal;

    // View-space position for specular
    let viewPos = uniforms.modelView * vec4<f32>(input.position, 1.0);
    output.viewPosition = viewPos.xyz;

    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let normal = normalize(input.worldNormal);
    let lightDir = normalize(uniforms.lightDirection.xyz);

    // Ambient
    let ambient = 0.15;

    // Diffuse (Lambertian)
    let NdotL = max(dot(normal, lightDir), 0.0);
    let diffuse = NdotL * 0.7;

    // Specular (Blinn-Phong)
    let viewDir = normalize(-input.viewPosition);
    let halfDir = normalize(lightDir + viewDir);
    let NdotH = max(dot(normal, halfDir), 0.0);
    let specular = pow(NdotH, 32.0) * 0.15;

    let lighting = ambient + diffuse + specular;
    let finalColor = input.color.rgb * lighting;

    return vec4<f32>(finalColor, input.color.a);
}
`;

/**
 * BasicTexturedColor Shader: position + uv + color (texture sampling modulated by color)
 * Uniform: MVP matrix only (64 bytes, padded to 256)
 * Uses @group(1) for texture sampler and texture
 * @type {string}
 */
const basicTexturedColorWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
    @location(2) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(0) var textureSampler: sampler;
@group(1) @binding(1) var colorTexture: texture_2d<f32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.color = input.color;
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let texColor = textureSample(colorTexture, textureSampler, input.texCoord);
    return texColor * input.color;
}
`;

/**
 * PhongTexturedColor Shader: position + normal + uv + color (Phong + texture)
 * Uniform: MVP(64) + ModelView(64) + NormalMatrix(64) + LightDir(16) = 208 bytes, padded to 256
 * Uses @group(1) for texture sampler and texture
 * @type {string}
 */
const phongTexturedColorWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
    @location(3) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) worldNormal: vec3<f32>,
    @location(2) viewPosition: vec3<f32>,
    @location(3) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    modelView: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
    lightDirection: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(0) var textureSampler: sampler;
@group(1) @binding(1) var colorTexture: texture_2d<f32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.clipPosition = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.color = input.color;
    output.texCoord = input.texCoord;

    let transformedNormal = normalize(
        mat3x3<f32>(
            uniforms.normalMatrix[0].xyz,
            uniforms.normalMatrix[1].xyz,
            uniforms.normalMatrix[2].xyz
        ) * input.normal
    );
    output.worldNormal = transformedNormal;

    let viewPos = uniforms.modelView * vec4<f32>(input.position, 1.0);
    output.viewPosition = viewPos.xyz;

    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let normal = normalize(input.worldNormal);
    let lightDir = normalize(uniforms.lightDirection.xyz);

    let ambient = 0.15;
    let NdotL = max(dot(normal, lightDir), 0.0);
    let diffuse = NdotL * 0.7;

    let viewDir = normalize(-input.viewPosition);
    let halfDir = normalize(lightDir + viewDir);
    let NdotH = max(dot(normal, halfDir), 0.0);
    let specular = pow(NdotH, 32.0) * 0.15;

    let lighting = ambient + diffuse + specular;
    let texColor = textureSample(colorTexture, textureSampler, input.texCoord);
    let baseColor = texColor * input.color;
    let finalColor = baseColor.rgb * lighting;

    return vec4<f32>(finalColor, baseColor.a);
}
`;

// =========================================================================
// Shader Selection & Configuration
// =========================================================================

/**
 * Determines which WGSL shader to use based on available geometry attributes.
 * Shader selection hierarchy:
 * - phongTextured: position + normal + st → Phong lighting + texture sampling
 * - basicTextured: position + st → Texture sampling + color
 * - phong: position + normal → Phong lighting + color
 * - basic: position → Color only
 *
 * @param {object} attributes - Geometry attributes
 * @returns {{ type: string, code: string, hasUV: boolean }} Shader type, WGSL code, and UV flag
 * @private
 */
function selectWebGPUShader(attributes) {
  const hasNormals =
    defined(attributes.normal) && defined(attributes.normal.values);
  const hasST = defined(attributes.st) && defined(attributes.st.values);

  if (hasNormals && hasST) {
    return { type: "phongTextured", code: phongTexturedColorWGSL, hasUV: true };
  }
  if (hasST) {
    return { type: "basicTextured", code: basicTexturedColorWGSL, hasUV: true };
  }
  if (hasNormals) {
    return { type: "phong", code: phongColorWGSL, hasUV: false };
  }
  return { type: "basic", code: basicColorWGSL, hasUV: false };
}

/**
 * Returns the vertex buffer layout descriptor for a given shader type.
 * Each layout defines the interleaved vertex format with stride and attribute offsets.
 *
 * @param {string} shaderType - 'basic', 'phong', 'basicTextured', or 'phongTextured'
 * @returns {{ floatsPerVertex: number, stride: number, layout: GPUVertexBufferLayout }}
 * @private
 */
function getVertexLayoutForShader(shaderType) {
  if (shaderType === "phongTextured") {
    // position(3) + normal(3) + uv(2) + color(4) = 12 floats = 48 bytes
    return {
      floatsPerVertex: 12,
      stride: 48,
      layout: {
        arrayStride: 48,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" }, // position
          { shaderLocation: 1, offset: 12, format: "float32x3" }, // normal
          { shaderLocation: 2, offset: 24, format: "float32x2" }, // texCoord
          { shaderLocation: 3, offset: 32, format: "float32x4" }, // color
        ],
      },
    };
  }
  if (shaderType === "basicTextured") {
    // position(3) + uv(2) + color(4) = 9 floats = 36 bytes
    return {
      floatsPerVertex: 9,
      stride: 36,
      layout: {
        arrayStride: 36,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" }, // position
          { shaderLocation: 1, offset: 12, format: "float32x2" }, // texCoord
          { shaderLocation: 2, offset: 20, format: "float32x4" }, // color
        ],
      },
    };
  }
  if (shaderType === "phong") {
    // position(3) + normal(3) + color(4) = 10 floats = 40 bytes
    return {
      floatsPerVertex: 10,
      stride: 40,
      layout: {
        arrayStride: 40,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" }, // position
          { shaderLocation: 1, offset: 12, format: "float32x3" }, // normal
          { shaderLocation: 2, offset: 24, format: "float32x4" }, // color
        ],
      },
    };
  }
  // basic: position(3) + color(4) = 7 floats = 28 bytes
  return {
    floatsPerVertex: 7,
    stride: 28,
    layout: {
      arrayStride: 28,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" }, // position
        { shaderLocation: 1, offset: 12, format: "float32x4" }, // color
      ],
    },
  };
}

/**
 * Returns the uniform buffer size needed for a given shader type.
 * All sizes are 256-byte aligned per WebGPU requirements.
 *
 * @param {string} shaderType - 'basic', 'phong', 'basicTextured', or 'phongTextured'
 * @returns {number} Size in bytes (256-byte aligned)
 * @private
 */
function getUniformSizeForShader(shaderType) {
  if (shaderType === "phong" || shaderType === "phongTextured") {
    // MVP(64) + ModelView(64) + NormalMatrix(64) + LightDir(16) = 208 → aligned to 256
    return 256;
  }
  // basic, basicTextured: MVP(64) → aligned to 256
  return 256;
}

/**
 * Returns true if the shader type is a Phong variant (needs normal matrix uniforms).
 * @param {string} shaderType
 * @returns {boolean}
 * @private
 */
function isPhongShader(shaderType) {
  return shaderType === "phong" || shaderType === "phongTextured";
}

/**
 * Returns true if the shader type needs a texture bind group.
 * @param {string} shaderType
 * @returns {boolean}
 * @private
 */
function isTexturedShader(shaderType) {
  return shaderType === "basicTextured" || shaderType === "phongTextured";
}

// =========================================================================
// Pick Shader Strings
// =========================================================================

/**
 * Pick shader for "basic" vertex layout: position(3) + color(4)
 * Uniform: MVP(64) + PickColor(16) = 80 bytes, padded to 256
 * Outputs the pick color (unique per instance) for GPU-based object identification.
 * @type {string}
 */
const pickBasicWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    pickColor: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    return output;
}

@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
    return uniforms.pickColor;
}
`;

/**
 * Pick shader for "phong" vertex layout: position(3) + normal(3) + color(4)
 * Uniform: MVP(64) + PickColor(16) = 80 bytes, padded to 256
 * @type {string}
 */
const pickPhongWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    pickColor: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    return output;
}

@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
    return uniforms.pickColor;
}
`;

/**
 * Pick shader for "basicTextured" vertex layout: position(3) + uv(2) + color(4)
 * Uniform: MVP(64) + PickColor(16) = 80 bytes, padded to 256
 * @type {string}
 */
const pickBasicTexturedWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
    @location(2) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    pickColor: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    return output;
}

@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
    return uniforms.pickColor;
}
`;

/**
 * Pick shader for "phongTextured" vertex layout: position(3) + normal(3) + uv(2) + color(4)
 * Uniform: MVP(64) + PickColor(16) = 80 bytes, padded to 256
 * @type {string}
 */
const pickPhongTexturedWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
    @location(3) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    pickColor: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    return output;
}

@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
    return uniforms.pickColor;
}
`;

// =========================================================================
// Material WGSL Shaders
// =========================================================================

/**
 * Material Color Flat: position + st, uniform materialColor, no lighting.
 * For EllipsoidSurfaceAppearance + Color material, or flat MaterialAppearance + Color.
 * Vertex layout: position(3) + st(2) = 5 floats = 20 bytes
 * Uniform: MVP(64) + materialColor(16) = 80 bytes, padded to 256
 * @type {string}
 */
const matColorFlatWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    materialColor: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    return uniforms.materialColor;
}
`;

/**
 * Material Color Lit: position + normal + st, uniform materialColor + Phong lighting.
 * Vertex layout: position(3) + normal(3) + st(2) = 8 floats = 32 bytes
 * Uniform: MVP(64) + ModelView(64) + NormalMatrix(64) + LightDir(16) + materialColor(16) = 224 bytes, padded to 256
 * @type {string}
 */
const matColorLitWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) worldNormal: vec3<f32>,
    @location(1) viewPosition: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    modelView: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
    lightDirection: vec4<f32>,
    materialColor: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.clipPosition = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.texCoord = input.texCoord;

    let transformedNormal = normalize(
        mat3x3<f32>(
            uniforms.normalMatrix[0].xyz,
            uniforms.normalMatrix[1].xyz,
            uniforms.normalMatrix[2].xyz
        ) * input.normal
    );
    output.worldNormal = transformedNormal;

    let viewPos = uniforms.modelView * vec4<f32>(input.position, 1.0);
    output.viewPosition = viewPos.xyz;

    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let normal = normalize(input.worldNormal);
    let lightDir = normalize(uniforms.lightDirection.xyz);

    let ambient = 0.15;
    let NdotL = max(dot(normal, lightDir), 0.0);
    let diffuse = NdotL * 0.7;

    let viewDir = normalize(-input.viewPosition);
    let halfDir = normalize(lightDir + viewDir);
    let NdotH = max(dot(normal, halfDir), 0.0);
    let specular = pow(NdotH, 32.0) * 0.15;

    let lighting = ambient + diffuse + specular;
    let finalColor = uniforms.materialColor.rgb * lighting;

    return vec4<f32>(finalColor, uniforms.materialColor.a);
}
`;

/**
 * Material Image Flat: position + st, texture sampling modulated by tint color, no lighting.
 * Vertex layout: position(3) + st(2) = 5 floats = 20 bytes
 * Uniform: MVP(64) + colorTint(16) + repeat(8 + 8pad = 16) = 96 bytes, padded to 256
 * Group 1: sampler + texture2D
 * @type {string}
 */
const matImageFlatWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    colorTint: vec4<f32>,
    repeat: vec2<f32>,
    _pad0: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(0) var textureSampler: sampler;
@group(1) @binding(1) var colorTexture: texture_2d<f32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let uv = fract(uniforms.repeat * input.texCoord);
    let texColor = textureSample(colorTexture, textureSampler, uv);
    return texColor * uniforms.colorTint;
}
`;

/**
 * Material Image Lit: position + normal + st, texture + tint + Phong lighting.
 * Vertex layout: position(3) + normal(3) + st(2) = 8 floats = 32 bytes
 * Uniform: MVP(64) + ModelView(64) + NormalMatrix(64) + LightDir(16) + colorTint(16) + repeat(16) = 240 bytes, padded to 256
 * Group 1: sampler + texture2D
 * @type {string}
 */
const matImageLitWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) worldNormal: vec3<f32>,
    @location(1) viewPosition: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    modelView: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
    lightDirection: vec4<f32>,
    colorTint: vec4<f32>,
    repeat: vec2<f32>,
    _pad0: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(0) var textureSampler: sampler;
@group(1) @binding(1) var colorTexture: texture_2d<f32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.clipPosition = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.texCoord = input.texCoord;

    let transformedNormal = normalize(
        mat3x3<f32>(
            uniforms.normalMatrix[0].xyz,
            uniforms.normalMatrix[1].xyz,
            uniforms.normalMatrix[2].xyz
        ) * input.normal
    );
    output.worldNormal = transformedNormal;

    let viewPos = uniforms.modelView * vec4<f32>(input.position, 1.0);
    output.viewPosition = viewPos.xyz;

    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let normal = normalize(input.worldNormal);
    let lightDir = normalize(uniforms.lightDirection.xyz);

    let ambient = 0.15;
    let NdotL = max(dot(normal, lightDir), 0.0);
    let diffuse = NdotL * 0.7;

    let viewDir = normalize(-input.viewPosition);
    let halfDir = normalize(lightDir + viewDir);
    let NdotH = max(dot(normal, halfDir), 0.0);
    let specular = pow(NdotH, 32.0) * 0.15;

    let lighting = ambient + diffuse + specular;
    let uv = fract(uniforms.repeat * input.texCoord);
    let texColor = textureSample(colorTexture, textureSampler, uv);
    let baseColor = texColor * uniforms.colorTint;
    let finalColor = baseColor.rgb * lighting;

    return vec4<f32>(finalColor, baseColor.a);
}
`;

/**
 * Material Checkerboard Flat: position + st, procedural checkerboard, no lighting.
 * Vertex layout: position(3) + st(2) = 5 floats = 20 bytes
 * Uniform: MVP(64) + lightColor(16) + darkColor(16) + repeat(16) = 112 bytes, padded to 256
 * @type {string}
 */
const matCheckerFlatWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    lightColor: vec4<f32>,
    darkColor: vec4<f32>,
    repeat: vec2<f32>,
    _pad0: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let uv = input.texCoord * uniforms.repeat;
    let cx = floor(uv.x);
    let cy = floor(uv.y);
    let checker = ((cx + cy) % 2.0);
    if (checker < 0.5) {
        return uniforms.lightColor;
    }
    return uniforms.darkColor;
}
`;

/**
 * Material Checkerboard Lit: position + normal + st, procedural checkerboard + Phong.
 * Vertex layout: position(3) + normal(3) + st(2) = 8 floats = 32 bytes
 * Uniform: MVP(64) + ModelView(64) + NormalMatrix(64) + LightDir(16) + lightColor(16) + darkColor(16) + repeat(16) = 256 bytes
 * @type {string}
 */
const matCheckerLitWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) worldNormal: vec3<f32>,
    @location(1) viewPosition: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    modelView: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
    lightDirection: vec4<f32>,
    lightColor: vec4<f32>,
    darkColor: vec4<f32>,
    repeat: vec2<f32>,
    _pad0: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.clipPosition = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.texCoord = input.texCoord;

    let transformedNormal = normalize(
        mat3x3<f32>(
            uniforms.normalMatrix[0].xyz,
            uniforms.normalMatrix[1].xyz,
            uniforms.normalMatrix[2].xyz
        ) * input.normal
    );
    output.worldNormal = transformedNormal;

    let viewPos = uniforms.modelView * vec4<f32>(input.position, 1.0);
    output.viewPosition = viewPos.xyz;

    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let normal = normalize(input.worldNormal);
    let lightDir = normalize(uniforms.lightDirection.xyz);

    let ambient = 0.15;
    let NdotL = max(dot(normal, lightDir), 0.0);
    let diffuse = NdotL * 0.7;

    let viewDir = normalize(-input.viewPosition);
    let halfDir = normalize(lightDir + viewDir);
    let NdotH = max(dot(normal, halfDir), 0.0);
    let specular = pow(NdotH, 32.0) * 0.15;

    let lighting = ambient + diffuse + specular;

    let uv = input.texCoord * uniforms.repeat;
    let cx = floor(uv.x);
    let cy = floor(uv.y);
    let checker = ((cx + cy) % 2.0);
    var baseColor: vec4<f32>;
    if (checker < 0.5) {
        baseColor = uniforms.lightColor;
    } else {
        baseColor = uniforms.darkColor;
    }

    let finalColor = baseColor.rgb * lighting;
    return vec4<f32>(finalColor, baseColor.a);
}
`;

/**
 * Material Grid Flat: position + st, procedural grid lines, no lighting.
 * Vertex layout: position(3) + st(2) = 5 floats = 20 bytes
 * Uniform: MVP(64) + color(16) + cellAlpha_lineCount(16) + lineThickness_lineOffset(16) = 112, padded to 256
 * @type {string}
 */
const matGridFlatWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    color: vec4<f32>,
    cellAlpha_lineCount: vec4<f32>,
    lineThickness_lineOffset: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let cellAlpha = uniforms.cellAlpha_lineCount.x;
    let lineCountX = uniforms.cellAlpha_lineCount.y;
    let lineCountY = uniforms.cellAlpha_lineCount.z;
    let lineThicknessX = uniforms.lineThickness_lineOffset.x;
    let lineThicknessY = uniforms.lineThickness_lineOffset.y;
    let lineOffsetX = uniforms.lineThickness_lineOffset.z;
    let lineOffsetY = uniforms.lineThickness_lineOffset.w;

    let st = input.texCoord;
    let scaledX = fract((st.x - lineOffsetX) * lineCountX);
    let scaledY = fract((st.y - lineOffsetY) * lineCountY);

    let threshX = lineThicknessX / (1.0 / lineCountX) * 0.01;
    let threshY = lineThicknessY / (1.0 / lineCountY) * 0.01;

    let onLineX = f32(scaledX < threshX || scaledX > (1.0 - threshX));
    let onLineY = f32(scaledY < threshY || scaledY > (1.0 - threshY));
    let onLine = max(onLineX, onLineY);

    let alpha = mix(cellAlpha * uniforms.color.a, uniforms.color.a, onLine);
    return vec4<f32>(uniforms.color.rgb, alpha);
}
`;

/**
 * Material Stripe Flat: position + st, procedural horizontal/vertical stripes, no lighting.
 * Vertex layout: position(3) + st(2) = 5 floats = 20 bytes
 * Uniform: MVP(64) + evenColor(16) + oddColor(16) + params(16) = 112, padded to 256
 * params: x=offset, y=repeat, z=horizontal(0 or 1), w=unused
 * @type {string}
 */
const matStripeFlatWGSL = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    evenColor: vec4<f32>,
    oddColor: vec4<f32>,
    params: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let offset = uniforms.params.x;
    let repeatCount = uniforms.params.y;
    let isHorizontal = uniforms.params.z;

    var coord: f32;
    if (isHorizontal > 0.5) {
        coord = input.texCoord.y;
    } else {
        coord = input.texCoord.x;
    }

    let value = fract((coord - offset) * repeatCount);
    if (value < 0.5) {
        return uniforms.evenColor;
    }
    return uniforms.oddColor;
}
`;

// =========================================================================
// Material Shader Selection & Configuration
// =========================================================================

/**
 * Determines which WGSL material shader to use based on material type and geometry attributes.
 *
 * @param {object} material - The CesiumJS Material object
 * @param {boolean} isFlat - Whether the appearance uses flat shading
 * @param {boolean} hasNormals - Whether the geometry has normals
 * @param {boolean} hasST - Whether the geometry has texture coordinates
 * @returns {{ type: string, code: string, needsTexture: boolean }} Shader info
 * @private
 */
function selectMaterialShader(material, isFlat, hasNormals, hasST) {
  const materialType = defined(material) ? material.type : "Color";
  const useLighting = hasNormals && !isFlat;

  // Image / DiffuseMap materials → texture sampling shaders
  if (materialType === "Image" || materialType === "DiffuseMap") {
    if (useLighting && hasST) {
      return { type: "matImageLit", code: matImageLitWGSL, needsTexture: true };
    }
    return { type: "matImageFlat", code: matImageFlatWGSL, needsTexture: true };
  }

  // Checkerboard material → procedural checkerboard
  if (materialType === "Checkerboard") {
    if (useLighting && hasST) {
      return {
        type: "matCheckerLit",
        code: matCheckerLitWGSL,
        needsTexture: false,
      };
    }
    return {
      type: "matCheckerFlat",
      code: matCheckerFlatWGSL,
      needsTexture: false,
    };
  }

  // Grid material → procedural grid
  if (materialType === "Grid") {
    return { type: "matGridFlat", code: matGridFlatWGSL, needsTexture: false };
  }

  // Stripe material → procedural stripes
  if (materialType === "Stripe") {
    return {
      type: "matStripeFlat",
      code: matStripeFlatWGSL,
      needsTexture: false,
    };
  }

  // Color material (default) → uniform color
  if (useLighting && hasST) {
    return { type: "matColorLit", code: matColorLitWGSL, needsTexture: false };
  }
  return { type: "matColorFlat", code: matColorFlatWGSL, needsTexture: false };
}

/**
 * Returns the vertex buffer layout for material shaders.
 * Material shaders do NOT use per-vertex color — color comes from the material.
 *
 * @param {string} shaderType - Material shader type
 * @returns {{ floatsPerVertex: number, stride: number, layout: GPUVertexBufferLayout }}
 * @private
 */
function getMaterialVertexLayout(shaderType) {
  const isLit = shaderType.endsWith("Lit");

  if (isLit) {
    // position(3) + normal(3) + st(2) = 8 floats = 32 bytes
    return {
      floatsPerVertex: 8,
      stride: 32,
      layout: {
        arrayStride: 32,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" }, // position
          { shaderLocation: 1, offset: 12, format: "float32x3" }, // normal
          { shaderLocation: 2, offset: 24, format: "float32x2" }, // texCoord
        ],
      },
    };
  }

  // Flat variants: position(3) + st(2) = 5 floats = 20 bytes
  return {
    floatsPerVertex: 5,
    stride: 20,
    layout: {
      arrayStride: 20,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" }, // position
        { shaderLocation: 1, offset: 12, format: "float32x2" }, // texCoord
      ],
    },
  };
}

/**
 * Returns the uniform buffer size for material shaders.
 * All sizes are 256-byte aligned.
 *
 * @param {string} shaderType - Material shader type
 * @returns {number} Size in bytes (256-byte aligned)
 * @private
 */
function getMaterialUniformSize(shaderType) {
  // All material shaders fit within 256 bytes
  return 256;
}

/**
 * Returns true if a material shader type uses Phong lighting.
 * @param {string} shaderType
 * @returns {boolean}
 * @private
 */
function isMaterialLitShader(shaderType) {
  return shaderType.endsWith("Lit");
}

/**
 * Returns true if a shader type is a material shader (starts with "mat").
 * @param {string} shaderType
 * @returns {boolean}
 * @private
 */
function isMaterialShader(shaderType) {
  return defined(shaderType) && shaderType.startsWith("mat");
}

/**
 * Returns true if a material shader needs a texture bind group.
 * @param {string} shaderType
 * @returns {boolean}
 * @private
 */
function isMaterialTexturedShader(shaderType) {
  return shaderType === "matImageFlat" || shaderType === "matImageLit";
}

// =========================================================================
// Pick Shader Selection
// =========================================================================

/**
 * Returns the WGSL pick shader code for a given color shader type.
 * The pick shader has the same vertex input layout as the color shader
 * but only uses position, outputting a uniform pick color.
 *
 * @param {string} shaderType - 'basic', 'phong', 'basicTextured', or 'phongTextured'
 * @returns {string} WGSL pick shader source code
 * @private
 */
function getPickShaderForType(shaderType) {
  if (shaderType === "phongTextured") {
    return pickPhongTexturedWGSL;
  }
  if (shaderType === "basicTextured") {
    return pickBasicTexturedWGSL;
  }
  if (shaderType === "phong") {
    return pickPhongWGSL;
  }
  return pickBasicWGSL;
}

/**
 * Returns the uniform buffer size for pick shaders.
 * All pick shaders use: MVP(64) + PickColor(16) = 80 bytes → padded to 256.
 *
 * @returns {number} Size in bytes (256-byte aligned)
 * @private
 */
function getPickUniformSize() {
  return 256;
}

const WebGPUPrimitiveShaders = {
  basicColorWGSL,
  phongColorWGSL,
  basicTexturedColorWGSL,
  phongTexturedColorWGSL,
  pickBasicWGSL,
  pickPhongWGSL,
  pickBasicTexturedWGSL,
  pickPhongTexturedWGSL,
  selectWebGPUShader,
  getVertexLayoutForShader,
  getUniformSizeForShader,
  getPickShaderForType,
  getPickUniformSize,
  isPhongShader,
  isTexturedShader,
  selectMaterialShader,
  getMaterialVertexLayout,
  getMaterialUniformSize,
  isMaterialLitShader,
  isMaterialShader,
  isMaterialTexturedShader,
};

export default WebGPUPrimitiveShaders;
export {
  basicColorWGSL,
  phongColorWGSL,
  basicTexturedColorWGSL,
  phongTexturedColorWGSL,
  pickBasicWGSL,
  pickPhongWGSL,
  pickBasicTexturedWGSL,
  pickPhongTexturedWGSL,
  selectWebGPUShader,
  getVertexLayoutForShader,
  getUniformSizeForShader,
  getPickShaderForType,
  getPickUniformSize,
  isPhongShader,
  isTexturedShader,
  selectMaterialShader,
  getMaterialVertexLayout,
  getMaterialUniformSize,
  isMaterialLitShader,
  isMaterialShader,
  isMaterialTexturedShader,
};
