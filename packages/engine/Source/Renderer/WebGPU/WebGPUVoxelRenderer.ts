/**
 * WebGPU Voxel Renderer
 *
 * Renders volumetric voxel data via ray marching through a 3D texture.
 * Renders a bounding box as a proxy geometry, then ray-marches through
 * the voxel volume in the fragment shader.
 * Uses RTE (Relative-To-Eye) positioning for planetary-scale precision.
 *
 * @module WebGPUVoxelRenderer
 */

import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { m4Values } from "./webgpuTypeHelpers.js";

interface VoxelCache {
  uniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup: GPUBindGroup | null;
  vertexBuffer: GPUBuffer | null;
  indexBuffer: GPUBuffer | null;
  voxelTexture: GPUTexture | null;
  voxelTextureView: GPUTextureView | null;
  sampler: GPUSampler | null;
  command: CesiumAnyDrawCommand | null;
  initialized: boolean;
}

const VOXEL_WGSL = `
struct VertexInput {
  @location(0) positionHigh: vec3<f32>,
  @location(1) positionLow: vec3<f32>,
};
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
};
struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  minBounds: vec3<f32>,
  stepSize: f32,
  maxBounds: vec3<f32>,
  maxSteps: f32,
  cameraPositionEC: vec3<f32>,
  densityThreshold: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var voxelTex: texture_3d<f32>;
@group(0) @binding(2) var voxelSamp: sampler;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let posRTE = (input.positionHigh - u.encodedCameraHigh)
             + (input.positionLow - u.encodedCameraLow);
  output.position = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  output.worldPos = posRTE;
  return output;
}

fn intersectAABB(origin: vec3<f32>, invDir: vec3<f32>,
                 bMin: vec3<f32>, bMax: vec3<f32>) -> vec2<f32> {
  let t1 = (bMin - origin) * invDir;
  let t2 = (bMax - origin) * invDir;
  let tMin = min(t1, t2);
  let tMax = max(t1, t2);
  return vec2<f32>(max(max(tMin.x, tMin.y), tMin.z),
                   min(min(tMax.x, tMax.y), tMax.z));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let rayDir = normalize(input.worldPos - u.cameraPositionEC);
  let invDir = 1.0 / rayDir;
  let tr = intersectAABB(u.cameraPositionEC, invDir, u.minBounds, u.maxBounds);
  if (tr.x > tr.y) { discard; }
  let tS = max(tr.x, 0.0);
  let tE = tr.y;
  var accumC = vec3<f32>(0.0);
  var accumA: f32 = 0.0;
  let maxI = i32(u.maxSteps);
  for (var i = 0; i < maxI; i = i + 1) {
    let t = tS + f32(i) * u.stepSize;
    if (t > tE || accumA > 0.99) { break; }
    let p = u.cameraPositionEC + rayDir * t;
    let uvw = (p - u.minBounds) / (u.maxBounds - u.minBounds);
    if (any(uvw < vec3<f32>(0.0)) || any(uvw > vec3<f32>(1.0))) { continue; }
    let s = textureSample(voxelTex, voxelSamp, uvw);
    if (s.a > u.densityThreshold) {
      let sa = s.a * u.stepSize;
      accumC = accumC + s.rgb * sa * (1.0 - accumA);
      accumA = accumA + sa * (1.0 - accumA);
    }
  }
  if (accumA < 0.01) { discard; }
  return vec4<f32>(accumC, accumA);
}
`;

const scratchEncoded = { high: new Cartesian3(), low: new Cartesian3() };
const scratchMVP = new Matrix4();
// RTE scratch: view×model with translation column zeroed, used to
// build MVP correctly (must zero before projecting).
const scratchMVRTE = new Matrix4();

function createBoxGeometry(device: GPUDevice): {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
} {
  // Unit cube [-0.5, 0.5]^3 — will be scaled by model matrix
  const h = 0.5;
  const positions = new Float32Array([
    // Each vertex needs posHigh + posLow (for now, posLow = 0)
    -h,
    -h,
    -h,
    0,
    0,
    0,
    h,
    -h,
    -h,
    0,
    0,
    0,
    h,
    h,
    -h,
    0,
    0,
    0,
    -h,
    h,
    -h,
    0,
    0,
    0,
    -h,
    -h,
    h,
    0,
    0,
    0,
    h,
    -h,
    h,
    0,
    0,
    0,
    h,
    h,
    h,
    0,
    0,
    0,
    -h,
    h,
    h,
    0,
    0,
    0,
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 2, 6, 7, 2, 7, 3, 0,
    3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
  ]);
  const vb = device.createBuffer({
    size: positions.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vb, 0, positions);
  const ib = device.createBuffer({
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(ib, 0, indices);
  return { vertexBuffer: vb, indexBuffer: ib };
}

function createPlaceholderVoxelTexture(device: GPUDevice): {
  texture: GPUTexture;
  view: GPUTextureView;
} {
  const size = 4;
  const texture = device.createTexture({
    size: { width: size, height: size, depthOrArrayLayers: size },
    format: "rgba8unorm",
    dimension: "3d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // Fill with gradient for placeholder visibility
  const data = new Uint8Array(size * size * size * 4);
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (z * size * size + y * size + x) * 4;
        data[idx] = Math.floor((x / size) * 255);
        data[idx + 1] = Math.floor((y / size) * 255);
        data[idx + 2] = Math.floor((z / size) * 255);
        data[idx + 3] = 128; // semi-transparent
      }
    }
  }
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: size * 4, rowsPerImage: size },
    { width: size, height: size, depthOrArrayLayers: size },
  );
  return { texture, view: texture.createView() };
}

function updateWebGPUVoxelPrimitive(primitive: CesiumObjectWithWebGPUCache, frameState: CesiumFrameState): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const commandList = frameState.commandList;

  if (!primitive.show) {
    return;
  }

  if (!primitive._webgpuCache) {
    primitive._webgpuCache = {
      uniformBuffer: null,
      pipeline: null,
      shaderModule: null,
      bindGroup: null,
      vertexBuffer: null,
      indexBuffer: null,
      voxelTexture: null,
      voxelTextureView: null,
      sampler: null,
      command: null,
      initialized: false,
    } as VoxelCache;
  }

  const cache = primitive._webgpuCache as VoxelCache;
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

  if (!cache.initialized) {
    cache.uniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    cache.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    const { texture, view } = createPlaceholderVoxelTexture(device);
    cache.voxelTexture = texture;
    cache.voxelTextureView = view;

    const shaderModule = device.createShaderModule({ code: VOXEL_WGSL });
    cache.shaderModule = shaderModule;

    const bgl = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" as GPUBufferBindingType },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float", viewDimension: "3d" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    cache.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: 24,
            attributes: [
              {
                shaderLocation: 0,
                offset: 0,
                format: "float32x3" as GPUVertexFormat,
              },
              {
                shaderLocation: 1,
                offset: 12,
                format: "float32x3" as GPUVertexFormat,
              },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [
          {
            format: canvasFormat,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
              },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "front" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: false,
        // less-equal for planetary-scale precision robustness.
        depthCompare: "less-equal",
      },
    });

    cache.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer } },
        { binding: 1, resource: cache.voxelTextureView! },
        { binding: 2, resource: cache.sampler! },
      ],
    });

    const geom = createBoxGeometry(device);
    cache.vertexBuffer = geom.vertexBuffer;
    cache.indexBuffer = geom.indexBuffer;

    cache.initialized = true;
  }

  // Pack uniforms.
  //
  // RTE: zero the translation column of MV *before* multiplying by
  // projection. Zeroing after the multiply wipes out projection's P23
  // depth-mapping term, producing incorrect NDC depth. See
  // `UniformStateComputations.cleanModelViewProjectionRelativeToEye`.
  const us = context.uniformState;
  const modelMatrix = primitive.modelMatrix ?? Matrix4.IDENTITY;
  const view = us.view;
  const projection = us.projection;
  const mvRte = Matrix4.multiply(view, modelMatrix, scratchMVRTE);
  mvRte[12] = 0;
  mvRte[13] = 0;
  mvRte[14] = 0;
  const mvp = m4Values(Matrix4.multiply(projection, mvRte, scratchMVP));

  const camWorld = us.cameraPosition;
  const invModel = Matrix4.inverse(modelMatrix, new Matrix4());
  const camModel = Matrix4.multiplyByPoint(
    invModel,
    camWorld,
    new Cartesian3(),
  );
  EncodedCartesian3.fromCartesian(camModel, scratchEncoded);

  const data = new Float32Array(32);
  for (let i = 0; i < 16; i++) {
    data[i] = mvp[i];
  }
  data[16] = scratchEncoded.high.x;
  data[17] = scratchEncoded.high.y;
  data[18] = scratchEncoded.high.z;
  data[19] = 0;
  data[20] = scratchEncoded.low.x;
  data[21] = scratchEncoded.low.y;
  data[22] = scratchEncoded.low.z;
  data[23] = 0;
  data[24] = -0.5;
  data[25] = -0.5;
  data[26] = -0.5;
  data[27] = 0.02; // minBounds + stepSize
  data[28] = 0.5;
  data[29] = 0.5;
  data[30] = 0.5;
  data[31] = 128; // maxBounds + maxSteps
  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);

  // Camera position for ray origin
  const camData = new Float32Array(4);
  camData[0] = 0;
  camData[1] = 0;
  camData[2] = 0;
  camData[3] = 0.1; // cameraEC + densityThreshold
  device.queue.writeBuffer(cache.uniformBuffer!, 128, camData);

  if (!cache.command) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup],
      vertexBuffers: [cache.vertexBuffer],
      indexBuffer: cache.indexBuffer,
      indexCount: 36,
      pass: Pass.VOXELS,
    });
  }

  commandList.push(cache.command);
}

function destroyWebGPUVoxelResources(primitive: CesiumObjectWithWebGPUCache): void {
  const cache = primitive._webgpuCache as VoxelCache | undefined;
  if (!cache) {
    return;
  }
  cache.uniformBuffer?.destroy();
  cache.vertexBuffer?.destroy();
  cache.indexBuffer?.destroy();
  cache.voxelTexture?.destroy();
  primitive._webgpuCache = undefined;
}

export { updateWebGPUVoxelPrimitive, destroyWebGPUVoxelResources };
export default { updateWebGPUVoxelPrimitive, destroyWebGPUVoxelResources };
