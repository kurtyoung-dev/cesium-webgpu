/**
 * WebGPU Point Cloud Eye-Dome Lighting
 *
 * Applies EDL as a post-process to point cloud rendering.
 * EDL enhances depth perception by darkening edges based on
 * depth discontinuities between neighboring pixels.
 *
 * @module WebGPUPointCloudEyeDomeLighting
 */

import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import Pass from "../Pass.js";

interface EDLCache {
  uniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup: GPUBindGroup | null;
  colorTexture: GPUTexture | null;
  colorTextureView: GPUTextureView | null;
  depthTexture: GPUTexture | null;
  depthTextureView: GPUTextureView | null;
  sampler: GPUSampler | null;
  command: any | null;
  initialized: boolean;
  width: number;
  height: number;
}

const EDL_WGSL = `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
struct Params {
  texelSize: vec2<f32>,
  strength: f32,
  radius: f32,
  nearPlane: f32,
  farPlane: f32,
  _p0: f32,
  _p1: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> p: Params;

@vertex
fn vertexMain(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var o: VertexOutput;
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  o.position = vec4<f32>(x, y, 0.0, 1.0);
  o.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return o;
}

fn linearize(d: f32) -> f32 {
  return p.nearPlane * p.farPlane / (p.farPlane - d * (p.farPlane - p.nearPlane));
}

fn logD(uv: vec2<f32>) -> f32 {
  let d = textureSample(depthTex, samp, uv).r;
  if (d >= 1.0) { return 0.0; }
  return log2(max(linearize(d), 0.001));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(colorTex, samp, input.uv);
  let centerD = textureSample(depthTex, samp, input.uv).r;
  if (centerD >= 1.0) { return color; }
  let centerLog = logD(input.uv);
  let offsets = array<vec2<f32>, 8>(
    vec2<f32>(-1.0, 0.0), vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, -1.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0),
  );
  var resp: f32 = 0.0;
  for (var i = 0u; i < 8u; i = i + 1u) {
    let sUV = input.uv + offsets[i] * p.texelSize * p.radius;
    resp = resp + max(0.0, centerLog - logD(sUV));
  }
  resp = resp / 8.0;
  let shade = exp(-resp * 300.0 * p.strength);
  return vec4<f32>(color.rgb * shade, color.a);
}
`;

function updateWebGPUPointCloudEDL(
  edl: any,
  frameState: any,
  numSamples: number,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;

  if (!edl._webgpuCache) {
    edl._webgpuCache = {
      uniformBuffer: null,
      pipeline: null,
      shaderModule: null,
      bindGroup: null,
      colorTexture: null,
      colorTextureView: null,
      depthTexture: null,
      depthTextureView: null,
      sampler: null,
      command: null,
      initialized: false,
      width: 0,
      height: 0,
    } as EDLCache;
  }

  const cache = edl._webgpuCache as EDLCache;
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  const width = context.drawingBufferWidth;
  const height = context.drawingBufferHeight;

  if (!cache.initialized) {
    cache.uniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    cache.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
    cache.shaderModule = device.createShaderModule({ code: EDL_WGSL });
    cache.initialized = true;
  }

  // Resize FBO textures
  if (cache.width !== width || cache.height !== height) {
    if (cache.colorTexture) {
      cache.colorTexture.destroy();
    }
    if (cache.depthTexture) {
      cache.depthTexture.destroy();
    }

    cache.colorTexture = device.createTexture({
      size: { width, height },
      format: canvasFormat,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    cache.colorTextureView = cache.colorTexture.createView();

    cache.depthTexture = device.createTexture({
      size: { width, height },
      format: "depth24plus",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    cache.depthTextureView = cache.depthTexture.createView();

    cache.width = width;
    cache.height = height;
    cache.pipeline = null;
    cache.bindGroup = null;
    cache.command = null;
  }

  if (!cache.pipeline) {
    const bgl = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "unfilterable-float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" as GPUBufferBindingType },
        },
      ],
    });

    cache.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: { module: cache.shaderModule!, entryPoint: "vertexMain" },
      fragment: {
        module: cache.shaderModule!,
        entryPoint: "fragmentMain",
        targets: [{ format: canvasFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    cache.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: cache.colorTextureView! },
        { binding: 1, resource: cache.depthTextureView! },
        { binding: 2, resource: cache.sampler! },
        { binding: 3, resource: { buffer: cache.uniformBuffer! } },
      ],
    });
  }

  // Pack EDL uniforms
  const data = new Float32Array(8);
  data[0] = 1.0 / width; // texelSize.x
  data[1] = 1.0 / height; // texelSize.y
  data[2] = edl._strength ?? 1.0; // strength
  data[3] = edl._radius ?? 1.0; // radius
  const us = context.uniformState;
  data[4] = us.currentFrustum?.near ?? 0.1; // nearPlane
  data[5] = us.currentFrustum?.far ?? 10000.0; // farPlane
  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);
}

function destroyWebGPUPointCloudEDLResources(edl: any): void {
  const cache = edl._webgpuCache as EDLCache | undefined;
  if (!cache) {
    return;
  }
  cache.uniformBuffer?.destroy();
  cache.colorTexture?.destroy();
  cache.depthTexture?.destroy();
  edl._webgpuCache = undefined;
}

export { updateWebGPUPointCloudEDL, destroyWebGPUPointCloudEDLResources };
export default {
  updateWebGPUPointCloudEDL,
  destroyWebGPUPointCloudEDLResources,
};
