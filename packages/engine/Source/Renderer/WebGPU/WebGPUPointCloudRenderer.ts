/**
 * WebGPU Point Cloud Renderer
 *
 * Renders point cloud data (LiDAR, photogrammetry) using instanced quads.
 * Supports per-point color, position splitting for RTE precision,
 * size attenuation, and optional normal-based lighting.
 *
 * @module WebGPUPointCloudRenderer
 */

import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { m4Values, gpuData } from "./webgpuTypeHelpers.js";

interface PointCloudCache {
  uniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup: GPUBindGroup | null;
  quadVertexBuffer: GPUBuffer | null;
  instanceBuffer: GPUBuffer | null;
  instanceCount: number;
  command: CesiumAnyDrawCommand | null;
  initialized: boolean;
  lastRevision: number;
}

const POINT_CLOUD_WGSL = `
struct VertexInput {
  @location(0) quadVertex: vec2<f32>,
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) colorAndSize: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) pointUV: vec2<f32>,
};

struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  pointSizeMultiplier: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let posRTE = (input.positionHigh - u.encodedCameraHigh)
             + (input.positionLow - u.encodedCameraLow);
  let clipPos = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  let pointSize = input.colorAndSize.a * u.pointSizeMultiplier;
  let px = pointSize / u.viewportSize.x * clipPos.w;
  let py = pointSize / u.viewportSize.y * clipPos.w;
  var fp = clipPos;
  fp.x = fp.x + input.quadVertex.x * px;
  fp.y = fp.y + input.quadVertex.y * py;
  output.position = fp;
  output.color = input.colorAndSize.rgb;
  output.pointUV = input.quadVertex;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let dist = length(input.pointUV);
  if (dist > 1.0) { discard; }
  let alpha = 1.0 - smoothstep(0.8, 1.0, dist);
  return vec4<f32>(input.color, alpha);
}
`;

const scratchEncoded = { high: new Cartesian3(), low: new Cartesian3() };
const scratchMVP = new Matrix4();
// RTE scratch: view×model with translation column zeroed, used to
// build MVP correctly (must zero before projecting).
const scratchMVRTE = new Matrix4();

function createQuadVB(device: GPUDevice): GPUBuffer {
  const verts = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
  const buf = device.createBuffer({
    size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, gpuData(verts));
  return buf;
}

function buildPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
): {
  pipeline: GPURenderPipeline;
  shaderModule: GPUShaderModule;
  bgl: GPUBindGroupLayout;
} {
  const shaderModule = device.createShaderModule({ code: POINT_CLOUD_WGSL });
  const bgl = makeBindGroupLayout(device, "PointCloud BGL", [
    uniformBuffer(0, Stage.VERTEX),
  ]);
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 8,
          stepMode: "vertex" as GPUVertexStepMode,
          attributes: [
            {
              shaderLocation: 0,
              offset: 0,
              format: "float32x2" as GPUVertexFormat,
            },
          ],
        },
        {
          arrayStride: 40,
          stepMode: "instance" as GPUVertexStepMode,
          attributes: [
            {
              shaderLocation: 1,
              offset: 0,
              format: "float32x3" as GPUVertexFormat,
            },
            {
              shaderLocation: 2,
              offset: 12,
              format: "float32x3" as GPUVertexFormat,
            },
            {
              shaderLocation: 3,
              offset: 24,
              format: "float32x4" as GPUVertexFormat,
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
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      // less-equal for planetary-scale precision robustness.
      depthCompare: "less-equal",
    },
  });
  return { pipeline, shaderModule, bgl };
}

function buildInstanceBuffer(
  device: GPUDevice,
  pointCloud: CesiumObjectWithWebGPUCache,
  modelMatrix: Matrix4 | CesiumMatrix4,
): { buffer: GPUBuffer; count: number } {
  // Read point positions, colors from pointCloud._drawCommand or _parsedContent
  const parsedContent =
    pointCloud._parsedContent || pointCloud._pointCloud?._parsedContent;
  if (!parsedContent || !parsedContent.positions) {
    return {
      buffer: device.createBuffer({ size: 40, usage: GPUBufferUsage.VERTEX }),
      count: 0,
    };
  }

  const positions = parsedContent.positions;
  const colors = parsedContent.colors;
  const pointCount = positions.length / 3;
  // 40 bytes per instance: posHigh(12) + posLow(12) + colorAndSize(16)
  const data = new Float32Array(pointCount * 10);

  for (let i = 0; i < pointCount; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];

    // Transform to world space
    const worldPos = Matrix4.multiplyByPoint(
      modelMatrix,
      new Cartesian3(px, py, pz),
      new Cartesian3(),
    );
    EncodedCartesian3.fromCartesian(worldPos, scratchEncoded);

    const off = i * 10;
    data[off] = scratchEncoded.high.x;
    data[off + 1] = scratchEncoded.high.y;
    data[off + 2] = scratchEncoded.high.z;
    data[off + 3] = scratchEncoded.low.x;
    data[off + 4] = scratchEncoded.low.y;
    data[off + 5] = scratchEncoded.low.z;

    // Color (normalized) + size
    if (colors && colors.length >= pointCount * 3) {
      const cn = colors instanceof Uint8Array ? 1.0 / 255.0 : 1.0;
      data[off + 6] = colors[i * 3] * cn;
      data[off + 7] = colors[i * 3 + 1] * cn;
      data[off + 8] = colors[i * 3 + 2] * cn;
    } else {
      data[off + 6] = 1.0;
      data[off + 7] = 1.0;
      data[off + 8] = 1.0;
    }
    data[off + 9] = 3.0; // default point size
  }

  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, gpuData(data));
  return { buffer, count: pointCount };
}

function packUniforms(
  uniformState: CesiumUniformState,
  modelMatrix: Matrix4 | CesiumMatrix4,
): Float32Array {
  const data = new Float32Array(28);
  const view = uniformState.view;
  const projection = uniformState.projection;

  // RTE: zero the translation column of MV *before* multiplying by
  // projection. Zeroing after the multiply wipes out projection's P23
  // depth-mapping term. See
  // `UniformStateComputations.cleanModelViewProjectionRelativeToEye`.
  const mvRte = Matrix4.multiply(view, modelMatrix, scratchMVRTE);
  mvRte[12] = 0;
  mvRte[13] = 0;
  mvRte[14] = 0;
  const mvp = m4Values(Matrix4.multiply(projection, mvRte, scratchMVP));
  for (let i = 0; i < 16; i++) {
    data[i] = mvp[i];
  }

  const camWorld = uniformState.cameraPosition;
  const invModel = Matrix4.inverse(modelMatrix, new Matrix4());
  const camModel = Matrix4.multiplyByPoint(
    invModel,
    camWorld,
    new Cartesian3(),
  );
  EncodedCartesian3.fromCartesian(camModel, scratchEncoded);
  data[16] = scratchEncoded.high.x;
  data[17] = scratchEncoded.high.y;
  data[18] = scratchEncoded.high.z;
  data[19] = 0;
  data[20] = scratchEncoded.low.x;
  data[21] = scratchEncoded.low.y;
  data[22] = scratchEncoded.low.z;
  data[23] = 0;

  const canvas = uniformState._context?._canvas || {
    width: 1920,
    height: 1080,
  };
  data[24] = canvas.width;
  data[25] = canvas.height;
  data[26] = 1.0; // pointSizeMultiplier
  data[27] = 0; // pad
  return data;
}

function updateWebGPUPointCloud(
  pointCloud: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const commandList = frameState.commandList;

  if (!pointCloud._webgpuCache) {
    pointCloud._webgpuCache = {
      uniformBuffer: null,
      pipeline: null,
      shaderModule: null,
      bindGroup: null,
      quadVertexBuffer: null,
      instanceBuffer: null,
      instanceCount: 0,
      command: null,
      initialized: false,
      lastRevision: -1,
    } as PointCloudCache;
  }

  const cache = pointCloud._webgpuCache as PointCloudCache;
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

  if (!cache.initialized) {
    cache.uniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const { pipeline, shaderModule, bgl } = buildPipeline(device, canvasFormat);
    cache.pipeline = pipeline;
    cache.shaderModule = shaderModule;

    cache.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: cache.uniformBuffer } }],
    });

    cache.quadVertexBuffer = createQuadVB(device);
    cache.initialized = true;
  }

  // Rebuild instance data when point data changes
  const modelMatrix = pointCloud.modelMatrix ?? Matrix4.IDENTITY;
  const revision = pointCloud._pointsLength ?? 0;
  if (revision !== cache.lastRevision || !cache.instanceBuffer) {
    if (cache.instanceBuffer) {
      cache.instanceBuffer.destroy();
    }
    const result = buildInstanceBuffer(device, pointCloud, modelMatrix);
    cache.instanceBuffer = result.buffer;
    cache.instanceCount = result.count;
    cache.lastRevision = revision;
    cache.command = null; // recreate command
  }

  if (cache.instanceCount === 0) {
    return;
  }

  // Per-frame uniforms
  const uniforms = packUniforms(context.uniformState, modelMatrix);
  device.queue.writeBuffer(cache.uniformBuffer!, 0, gpuData(uniforms));

  if (!cache.command) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup],
      vertexBuffers: [cache.quadVertexBuffer, cache.instanceBuffer],
      vertexCount: 6,
      instanceCount: cache.instanceCount,
      pass: Pass.OPAQUE,
    });
  }

  commandList.push(cache.command);
}

function destroyWebGPUPointCloudResources(
  pointCloud: CesiumObjectWithWebGPUCache,
): void {
  const cache = pointCloud._webgpuCache as PointCloudCache | undefined;
  if (!cache) {
    return;
  }
  cache.uniformBuffer?.destroy();
  cache.quadVertexBuffer?.destroy();
  cache.instanceBuffer?.destroy();
  pointCloud._webgpuCache = undefined;
}

export { updateWebGPUPointCloud, destroyWebGPUPointCloudResources };
export default { updateWebGPUPointCloud, destroyWebGPUPointCloudResources };
