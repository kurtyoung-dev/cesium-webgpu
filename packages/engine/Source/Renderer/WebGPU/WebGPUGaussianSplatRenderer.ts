/**
 * WebGPU Gaussian Splat Renderer
 *
 * Renders 3D Gaussian Splatting primitives. Each splat is projected from
 * a 3D Gaussian to a 2D screen-space Gaussian evaluated per-pixel.
 * Uses RTE (Relative-To-Eye) positioning for planetary-scale precision.
 *
 * @module WebGPUGaussianSplatRenderer
 */

import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { m4Values } from "./webgpuTypeHelpers.js";
import { WebGPUOIT } from "./WebGPUOIT.js";

interface GaussianSplatCache {
  uniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  oitPipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup: GPUBindGroup | null;
  quadVertexBuffer: GPUBuffer | null;
  splatBuffer: GPUBuffer | null;
  splatCount: number;
  command: any | null;
  initialized: boolean;
  lastRevision: number;
  pipelineLayout: GPUPipelineLayout | null;
}

const SPLAT_WGSL = `
struct VertexInput {
  @location(0) quadVertex: vec2<f32>,
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) covA: vec3<f32>,
  @location(4) covB: vec3<f32>,
  @location(5) colorAndAlpha: vec4<f32>,
};
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) conic: vec3<f32>,
  @location(2) centerOffset: vec2<f32>,
};
struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  modelViewRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  focalX: f32,
  focalY: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let posRTE = (input.positionHigh - u.encodedCameraHigh)
             + (input.positionLow - u.encodedCameraLow);
  let clipPos = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  let t = u.modelViewRelativeToEye * vec4<f32>(posRTE, 1.0);
  let J00 = u.focalX / t.z;
  let J02 = -(u.focalX * t.x / t.z) / t.z;
  let J11 = u.focalY / t.z;
  let J12 = -(u.focalY * t.y / t.z) / t.z;
  let a = input.covA.x; let b = input.covA.y; let c = input.covA.z;
  let d = input.covB.x; let e = input.covB.y; let f = input.covB.z;
  let c00 = J00*J00*a + 2.0*J00*J02*c + J02*J02*f + 0.3;
  let c01 = J00*J11*b + J00*J12*e + J02*J11*c + J02*J12*f;
  let c11 = J11*J11*d + 2.0*J11*J12*e + J12*J12*f + 0.3;
  let det = c00*c11 - c01*c01;
  if (det <= 0.0) {
    output.position = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    output.color = vec4<f32>(0.0); output.conic = vec3<f32>(0.0);
    output.centerOffset = vec2<f32>(0.0); return output;
  }
  let invDet = 1.0 / det;
  let conic = vec3<f32>(c11*invDet, -c01*invDet, c00*invDet);
  let eigenMax = 0.5*(c00+c11+sqrt((c00-c11)*(c00-c11)+4.0*c01*c01));
  let radius = ceil(3.0 * sqrt(eigenMax));
  let pixOff = input.quadVertex * radius;
  let ndcOff = pixOff / u.viewportSize * 2.0 * clipPos.w;
  var fp = clipPos;
  fp.x = fp.x + ndcOff.x; fp.y = fp.y + ndcOff.y;
  output.position = fp;
  output.color = input.colorAndAlpha;
  output.conic = conic;
  output.centerOffset = pixOff;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let off = input.centerOffset;
  let power = -0.5*(input.conic.x*off.x*off.x + input.conic.z*off.y*off.y)
              - input.conic.y*off.x*off.y;
  if (power > 0.0) { discard; }
  let alpha = min(0.99, input.color.a * exp(power));
  if (alpha < 1.0/255.0) { discard; }
  return vec4<f32>(input.color.rgb * alpha, alpha);
}
`;

const scratchEncoded = { high: new Cartesian3(), low: new Cartesian3() };
const scratchMVP = new Matrix4();
const scratchMV = new Matrix4();

function createQuadVB(device: GPUDevice): GPUBuffer {
  const v = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
  const buf = device.createBuffer({
    size: v.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, v);
  return buf;
}

function buildPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
): {
  pipeline: GPURenderPipeline;
  oitPipeline: GPURenderPipeline | null;
  bgl: GPUBindGroupLayout;
  layout: GPUPipelineLayout;
} {
  const sm = device.createShaderModule({ code: SPLAT_WGSL });
  const bgl = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" as GPUBufferBindingType },
      },
    ],
  });
  // Instance stride: posHigh(12) + posLow(12) + covA(12) + covB(12) + color(16) = 64 bytes
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const pipeline = device.createRenderPipeline({
    layout,
    vertex: {
      module: sm,
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
          arrayStride: 64,
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
              format: "float32x3" as GPUVertexFormat,
            },
            {
              shaderLocation: 4,
              offset: 36,
              format: "float32x3" as GPUVertexFormat,
            },
            {
              shaderLocation: 5,
              offset: 48,
              format: "float32x4" as GPUVertexFormat,
            },
          ],
        },
      ],
    },
    fragment: {
      module: sm,
      entryPoint: "fragmentMain",
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: false,
      depthCompare: "less",
    },
  });

  // GS-WSR: Create OIT pipeline variant for weighted-sum rendering
  let oitPipeline: GPURenderPipeline | null = null;
  try {
    const oitCode = WebGPUOIT.injectOITOutput(SPLAT_WGSL, "fragmentMain");
    const oitSM = device.createShaderModule({
      label: "GaussianSplat-OIT-GS-WSR",
      code: oitCode,
    });
    oitPipeline = device.createRenderPipeline({
      label: "GaussianSplat-OIT-Pipeline",
      layout,
      vertex: {
        module: oitSM,
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
            arrayStride: 64,
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
                format: "float32x3" as GPUVertexFormat,
              },
              {
                shaderLocation: 4,
                offset: 36,
                format: "float32x3" as GPUVertexFormat,
              },
              {
                shaderLocation: 5,
                offset: 48,
                format: "float32x4" as GPUVertexFormat,
              },
            ],
          },
        ],
      },
      fragment: {
        module: oitSM,
        entryPoint: "fragmentMain",
        targets: WebGPUOIT.OIT_TARGETS,
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: false,
        depthCompare: "less",
      },
    });
  } catch (e) {
    // OIT variant creation is non-fatal — falls back to standard alpha blending
  }

  return { pipeline, oitPipeline, bgl, layout };
}

function updateWebGPUGaussianSplats(primitive: any, frameState: any): void {
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
      oitPipeline: null,
      shaderModule: null,
      bindGroup: null,
      quadVertexBuffer: null,
      splatBuffer: null,
      splatCount: 0,
      command: null,
      initialized: false,
      lastRevision: -1,
      pipelineLayout: null,
    } as GaussianSplatCache;
  }

  const cache = primitive._webgpuCache as GaussianSplatCache;
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

  if (!cache.initialized) {
    // 40 floats RTE matrices/cam + 4 floats viewport/focal = 44 floats = 176 bytes
    cache.uniformBuffer = device.createBuffer({
      size: 176,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const { pipeline, oitPipeline, bgl, layout } = buildPipeline(
      device,
      canvasFormat,
    );
    cache.pipeline = pipeline;
    cache.oitPipeline = oitPipeline;
    cache.pipelineLayout = layout;
    cache.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: cache.uniformBuffer } }],
    });
    cache.quadVertexBuffer = createQuadVB(device);

    // Create placeholder splat buffer (will be replaced when data loads)
    cache.splatBuffer = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.VERTEX,
    });
    cache.splatCount = 0;
    cache.initialized = true;
  }

  // Check if splat data has been uploaded
  const splatData =
    primitive._splatData || primitive._renderResources?.splatBuffer;
  const revision = primitive._splatCount ?? 0;
  if (revision !== cache.lastRevision && splatData) {
    if (cache.splatBuffer) {
      cache.splatBuffer.destroy();
    }
    cache.splatBuffer = device.createBuffer({
      size: splatData.byteLength || 64,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    if (splatData.byteLength > 0) {
      device.queue.writeBuffer(cache.splatBuffer, 0, splatData);
    }
    cache.splatCount = revision;
    cache.lastRevision = revision;
    cache.command = null;
  }

  if (cache.splatCount === 0) {
    return;
  }

  // Pack uniforms
  const us = context.uniformState;
  const mm = primitive.modelMatrix ?? Matrix4.IDENTITY;
  const mvM4 = Matrix4.multiply(us.view, mm, scratchMV);
  const mv = m4Values(mvM4);
  const mvp = m4Values(Matrix4.multiply(us.projection, mvM4, scratchMVP));
  mvp[12] = 0;
  mvp[13] = 0;
  mvp[14] = 0;
  mv[12] = 0;
  mv[13] = 0;
  mv[14] = 0;

  const camWorld = us.cameraPosition;
  const invM = Matrix4.inverse(mm, new Matrix4());
  const camM = Matrix4.multiplyByPoint(invM, camWorld, new Cartesian3());
  EncodedCartesian3.fromCartesian(camM, scratchEncoded);

  const data = new Float32Array(40);
  for (let i = 0; i < 16; i++) {
    data[i] = mvp[i];
  }
  for (let i = 0; i < 16; i++) {
    data[16 + i] = mv[i];
  }
  data[32] = scratchEncoded.high.x;
  data[33] = scratchEncoded.high.y;
  data[34] = scratchEncoded.high.z;
  data[35] = 0;
  data[36] = scratchEncoded.low.x;
  data[37] = scratchEncoded.low.y;
  data[38] = scratchEncoded.low.z;
  data[39] = 0;

  // Viewport + focal length derived from the perspective projection matrix.
  // For a standard perspective: P[0][0] = 1/(aspect*tan(fov/2)),
  // P[1][1] = 1/tan(fov/2). Pixel-space focal = P[i][i] * (viewportDim/2).
  const vpData = new Float32Array(4);
  const viewportW =
    context.drawingBufferWidth || context._canvas?.width || 1920;
  const viewportH =
    context.drawingBufferHeight || context._canvas?.height || 1080;
  const proj = m4Values(us.projection);
  vpData[0] = viewportW;
  vpData[1] = viewportH;
  vpData[2] = proj[0] * (viewportW * 0.5); // focal X (pixels)
  vpData[3] = proj[5] * (viewportH * 0.5); // focal Y (pixels)
  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);
  device.queue.writeBuffer(cache.uniformBuffer!, 160, vpData);

  if (!cache.command) {
    const cmd = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup],
      vertexBuffers: [cache.quadVertexBuffer, cache.splatBuffer],
      vertexCount: 6,
      instanceCount: cache.splatCount,
      pass: Pass.GAUSSIAN_SPLATS,
    });
    // GS-WSR: attach OIT pipeline variant for weighted-sum rendering
    if (cache.oitPipeline) {
      cmd._oitPipeline = cache.oitPipeline;
    }
    // Store shader code for dynamic OIT variant creation via scene renderer
    cmd._shaderCode = SPLAT_WGSL;
    cache.command = cmd;
  }

  commandList.push(cache.command);
}

function destroyWebGPUGaussianSplatResources(primitive: any): void {
  const cache = primitive._webgpuCache as GaussianSplatCache | undefined;
  if (!cache) {
    return;
  }
  cache.uniformBuffer?.destroy();
  cache.quadVertexBuffer?.destroy();
  cache.splatBuffer?.destroy();
  primitive._webgpuCache = undefined;
}

// Alias for scene file import compatibility
const updateWebGPUGaussianSplatPrimitive = updateWebGPUGaussianSplats;
const destroyWebGPUGaussianSplatPrimitiveResources =
  destroyWebGPUGaussianSplatResources;

export {
  updateWebGPUGaussianSplats,
  updateWebGPUGaussianSplatPrimitive,
  destroyWebGPUGaussianSplatResources,
  destroyWebGPUGaussianSplatPrimitiveResources,
};
export default {
  updateWebGPUGaussianSplats,
  updateWebGPUGaussianSplatPrimitive,
  destroyWebGPUGaussianSplatResources,
  destroyWebGPUGaussianSplatPrimitiveResources,
};
