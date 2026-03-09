/**
 * WebGPUCubeMapPanoramaRenderer.js
 *
 * Handles WebGPU rendering for CubeMapPanorama (used by SkyBox and standalone panoramas).
 * Creates pipelines, buffers, bind groups, and WebGPUDrawCommand instances for cubemap
 * panorama rendering in the WebGPU renderer.
 *
 * Uniform layout matches CubeMapPanorama.wgsl (208 bytes, 256-aligned):
 *   projection:         mat4x4<f32>  (offset 0,  64 bytes)
 *   viewRotation:       mat4x4<f32>  (offset 64, 64 bytes)
 *   panoramaTransform:  mat4x4<f32>  (offset 128, 64 bytes)
 *   params:             vec4<f32>    (offset 192, 16 bytes)
 */
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import defined from "../../Core/defined.js";
import Matrix3 from "../../Core/Matrix3.js";
import Matrix4 from "../../Core/Matrix4.js";

// Embedded WGSL shader source (avoids async fetch dependency)
const CUBEMAP_PANORAMA_WGSL = `
struct CubeMapPanoramaUniforms {
  projection: mat4x4<f32>,
  viewRotation: mat4x4<f32>,
  panoramaTransform: mat4x4<f32>,
  params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: CubeMapPanoramaUniforms;
@group(1) @binding(0) var cubeMapSampler: sampler;
@group(1) @binding(1) var cubeMapTexture: texture_cube<f32>;

struct VertexInput {
  @location(0) position: vec3<f32>,
};
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec3<f32>,
};

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let far = uniforms.params.x;
  let scaledPos = far * input.position;
  let pt = mat3x3<f32>(
    uniforms.panoramaTransform[0].xyz,
    uniforms.panoramaTransform[1].xyz,
    uniforms.panoramaTransform[2].xyz,
  );
  let transformed = pt * scaledPos;
  let vr = mat3x3<f32>(
    uniforms.viewRotation[0].xyz,
    uniforms.viewRotation[1].xyz,
    uniforms.viewRotation[2].xyz,
  );
  let rotated = vr * transformed;
  output.position = uniforms.projection * vec4<f32>(rotated, 1.0);
  output.texCoord = input.position;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(cubeMapTexture, cubeMapSampler, normalize(input.texCoord));
  let morphTime = uniforms.params.y;
  let corrected = pow(color.rgb, vec3<f32>(1.0 / 2.2));
  return vec4<f32>(corrected, morphTime);
}
`;

// Uniform buffer size: 208 bytes data, padded to 256 for GPU alignment
const UNIFORM_BUFFER_SIZE = 256;
const UNIFORM_FLOAT_COUNT = UNIFORM_BUFFER_SIZE / 4;

// Cached per-device resources (shader module, pipeline, bind group layouts)
let _cachedShaderModule = null;
let _cachedPipeline = null;
let _cachedBindGroupLayout0 = null;
let _cachedBindGroupLayout1 = null;
let _cachedPipelineLayout = null;
let _cachedDevice = null;

/**
 * Get or create the cached shader module for cubemap panorama rendering.
 * @param {GPUDevice} device
 * @returns {GPUShaderModule}
 */
function getShaderModule(device) {
  if (_cachedShaderModule && _cachedDevice === device) {
    return _cachedShaderModule;
  }
  _cachedDevice = device;
  _cachedShaderModule = device.createShaderModule({
    label: "CubeMapPanorama",
    code: CUBEMAP_PANORAMA_WGSL,
  });
  // Invalidate pipeline cache when shader module changes
  _cachedPipeline = null;
  return _cachedShaderModule;
}

/**
 * Get or create bind group layouts and pipeline layout.
 * @param {GPUDevice} device
 */
function ensureLayouts(device) {
  if (_cachedBindGroupLayout0 && _cachedDevice === device) {
    return;
  }
  _cachedDevice = device;

  _cachedBindGroupLayout0 = device.createBindGroupLayout({
    label: "CubeMapPanorama-uniforms",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  _cachedBindGroupLayout1 = device.createBindGroupLayout({
    label: "CubeMapPanorama-textures",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "cube" },
      },
    ],
  });

  _cachedPipelineLayout = device.createPipelineLayout({
    label: "CubeMapPanorama-layout",
    bindGroupLayouts: [_cachedBindGroupLayout0, _cachedBindGroupLayout1],
  });
}

/**
 * Get or create the cached render pipeline.
 * @param {GPUDevice} device
 * @param {GPUTextureFormat} format - Canvas preferred format
 * @returns {GPURenderPipeline}
 */
function getPipeline(device, format) {
  if (_cachedPipeline && _cachedDevice === device) {
    return _cachedPipeline;
  }

  const shaderModule = getShaderModule(device);
  ensureLayouts(device);

  _cachedPipeline = device.createRenderPipeline({
    label: "CubeMapPanorama-pipeline",
    layout: _cachedPipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 12, // vec3<f32> = 3 * 4 bytes
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [
        {
          format: format,
          blend: {
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
          },
        },
      ],
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "none",
    },
    depthStencil: undefined, // No depth test for environment pass
  });

  return _cachedPipeline;
}

/**
 * Pack a Matrix3 into a Float32Array as a mat4x4<f32> (column-major, 16 floats).
 * @param {Matrix3} m3 - Source 3x3 rotation matrix
 * @param {Float32Array} dst - Destination array
 * @param {number} offset - Offset in floats
 */
function packMatrix3As4x4(m3, dst, offset) {
  // Column 0
  dst[offset + 0] = m3[Matrix3.COLUMN0ROW0];
  dst[offset + 1] = m3[Matrix3.COLUMN0ROW1];
  dst[offset + 2] = m3[Matrix3.COLUMN0ROW2];
  dst[offset + 3] = 0.0;
  // Column 1
  dst[offset + 4] = m3[Matrix3.COLUMN1ROW0];
  dst[offset + 5] = m3[Matrix3.COLUMN1ROW1];
  dst[offset + 6] = m3[Matrix3.COLUMN1ROW2];
  dst[offset + 7] = 0.0;
  // Column 2
  dst[offset + 8] = m3[Matrix3.COLUMN2ROW0];
  dst[offset + 9] = m3[Matrix3.COLUMN2ROW1];
  dst[offset + 10] = m3[Matrix3.COLUMN2ROW2];
  dst[offset + 11] = 0.0;
  // Column 3
  dst[offset + 12] = 0.0;
  dst[offset + 13] = 0.0;
  dst[offset + 14] = 0.0;
  dst[offset + 15] = 1.0;
}

/**
 * Pack a Matrix4 into a Float32Array (column-major, 16 floats).
 * @param {Matrix4} m4
 * @param {Float32Array} dst
 * @param {number} offset
 */
function packMatrix4(m4, dst, offset) {
  for (let i = 0; i < 16; i++) {
    dst[offset + i] = m4[i];
  }
}

// Identity Matrix3 for when no panorama transform is set
const IDENTITY_MATRIX3 = Matrix3.clone(Matrix3.IDENTITY);

// Scratch variables
const scratchMatrix3 = new Matrix3();

/**
 * Create WebGPU vertex and index buffers from box geometry.
 *
 * @param {GPUDevice} device
 * @param {Object} geometry - CesiumJS Geometry object from BoxGeometry.createGeometry()
 * @returns {{ vertexBuffer: WebGPUBuffer, indexBuffer: WebGPUBuffer, indexCount: number }}
 */
export function createGeometryBuffers(device, geometry) {
  const positions = geometry.attributes.position.values;
  const indices = geometry.indices;

  const vertexBuffer = new WebGPUBuffer({
    device: device,
    typedArray: new Float32Array(positions),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    label: "CubeMapPanorama-vertices",
  });

  const indexBuffer = new WebGPUBuffer({
    device: device,
    typedArray: new Uint16Array(indices),
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    label: "CubeMapPanorama-indices",
  });

  return { vertexBuffer, indexBuffer, indexCount: indices.length };
}

/**
 * Create the uniform buffer for cubemap panorama rendering.
 * @param {GPUDevice} device
 * @returns {{ uniformBuffer: GPUBuffer, uniformData: Float32Array }}
 */
export function createUniformBuffer(device) {
  const uniformData = new Float32Array(UNIFORM_FLOAT_COUNT);
  const uniformBuffer = device.createBuffer({
    label: "CubeMapPanorama-uniforms",
    size: UNIFORM_BUFFER_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  return { uniformBuffer, uniformData };
}

/**
 * Create a cubemap sampler for the panorama.
 * @param {GPUDevice} device
 * @returns {GPUSampler}
 */
export function createCubeMapSampler(device) {
  return device.createSampler({
    label: "CubeMapPanorama-sampler",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
    addressModeW: "clamp-to-edge",
  });
}

/**
 * Create bind groups for the cubemap panorama.
 * @param {GPUDevice} device
 * @param {GPUBuffer} uniformBuffer
 * @param {GPUSampler} sampler
 * @param {GPUTextureView} cubeMapView - Cubemap texture view
 * @returns {{ bindGroup0: GPUBindGroup, bindGroup1: GPUBindGroup }}
 */
export function createBindGroups(device, uniformBuffer, sampler, cubeMapView) {
  ensureLayouts(device);

  const bindGroup0 = device.createBindGroup({
    label: "CubeMapPanorama-bg0-uniforms",
    layout: _cachedBindGroupLayout0,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  const bindGroup1 = device.createBindGroup({
    label: "CubeMapPanorama-bg1-textures",
    layout: _cachedBindGroupLayout1,
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: cubeMapView },
    ],
  });

  return { bindGroup0, bindGroup1 };
}

/**
 * Update the uniform buffer with per-frame camera and transform data.
 *
 * @param {GPUDevice} device
 * @param {GPUBuffer} uniformBuffer
 * @param {Float32Array} uniformData
 * @param {Object} uniformState - CesiumJS UniformState
 * @param {Matrix3|Matrix4|undefined} panoramaTransform - Panorama orientation transform
 */
export function updateUniforms(
  device,
  uniformBuffer,
  uniformData,
  uniformState,
  panoramaTransform,
) {
  // Projection matrix (offset 0, 16 floats)
  packMatrix4(uniformState.projection, uniformData, 0);

  // View rotation as mat4x4 (offset 16, 16 floats)
  const viewRotation = uniformState.viewRotation;
  packMatrix3As4x4(viewRotation, uniformData, 16);

  // Panorama transform as mat4x4 (offset 32, 16 floats)
  let transform = IDENTITY_MATRIX3;
  if (defined(panoramaTransform)) {
    if (panoramaTransform.length === 16) {
      // Matrix4 — extract 3x3 rotation part
      Matrix4.getMatrix3(panoramaTransform, scratchMatrix3);
      transform = scratchMatrix3;
    } else {
      // Matrix3
      transform = panoramaTransform;
    }
  }
  packMatrix3As4x4(transform, uniformData, 32);

  // Params: x=far, y=morphTime (offset 48, 4 floats)
  uniformData[48] = uniformState.entireFrustum.y; // far
  uniformData[49] = uniformState.morphTime;
  uniformData[50] = 0.0;
  uniformData[51] = 0.0;

  device.queue.writeBuffer(uniformBuffer, 0, uniformData);
}

/**
 * Create a complete WebGPUDrawCommand for cubemap panorama rendering.
 *
 * @param {GPUDevice} device
 * @param {GPUTextureFormat} canvasFormat
 * @param {WebGPUBuffer} vertexBuffer
 * @param {WebGPUBuffer} indexBuffer
 * @param {number} indexCount
 * @param {GPUBindGroup} bindGroup0
 * @param {GPUBindGroup} bindGroup1
 * @returns {WebGPUDrawCommand}
 */
export function createDrawCommand(
  device,
  canvasFormat,
  vertexBuffer,
  indexBuffer,
  indexCount,
  bindGroup0,
  bindGroup1,
) {
  const pipeline = getPipeline(device, canvasFormat);

  return new WebGPUDrawCommand({
    pipeline: pipeline,
    bindGroups: [bindGroup0, bindGroup1],
    vertexBuffers: [vertexBuffer],
    indexBuffer: indexBuffer,
    indexFormat: "uint16",
    indexCount: indexCount,
    pass: 0, // Pass.ENVIRONMENT
    owner: null,
  });
}

/**
 * Destroy cached device-specific resources.
 * Called when the CubeMapPanorama is destroyed.
 */
export function resetCache() {
  _cachedShaderModule = null;
  _cachedPipeline = null;
  _cachedBindGroupLayout0 = null;
  _cachedBindGroupLayout1 = null;
  _cachedPipelineLayout = null;
  _cachedDevice = null;
}

export default {
  createGeometryBuffers,
  createUniformBuffer,
  createCubeMapSampler,
  createBindGroups,
  updateUniforms,
  createDrawCommand,
  resetCache,
};
