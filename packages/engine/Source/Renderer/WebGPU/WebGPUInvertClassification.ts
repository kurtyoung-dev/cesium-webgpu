/**
 * WebGPU Invert Classification
 *
 * Applies a highlight/dim effect to unclassified regions of 3D Tiles.
 * Uses a fullscreen composite pass that reads from a classified texture
 * and applies color modification to areas not covered by classification.
 *
 * @module WebGPUInvertClassification
 */

import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";

interface InvertClassificationCache {
  uniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup: GPUBindGroup | null;
  classifiedTexture: GPUTexture | null;
  classifiedTextureView: GPUTextureView | null;
  sampler: GPUSampler | null;
  framebuffer: any | null;
  command: CesiumAnyDrawCommand | null;
  initialized: boolean;
  width: number;
  height: number;
}

const INVERT_CLASS_WGSL = `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
struct Uniforms {
  highlightColor: vec4<f32>,
  enableHighlight: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};
@group(0) @binding(0) var sceneTex: texture_2d<f32>;
@group(0) @binding(1) var classifiedTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> params: Uniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var o: VertexOutput;
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  o.position = vec4<f32>(x, y, 0.0, 1.0);
  o.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return o;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let sceneColor = textureSample(sceneTex, samp, input.uv);
  let classColor = textureSample(classifiedTex, samp, input.uv);
  if (classColor.a > 0.0) { return sceneColor; }
  if (params.enableHighlight > 0.5) {
    let blended = mix(sceneColor.rgb, params.highlightColor.rgb, params.highlightColor.a);
    return vec4<f32>(blended, sceneColor.a);
  }
  return sceneColor;
}
`;

function updateWebGPUInvertClassification(
  invertClass: CesiumObjectWithWebGPUCache,
  context: CesiumGraphicsContext,
  numSamples: number,
  globeFramebuffer: any,
): void {
  const device: GPUDevice = context.device;

  if (!invertClass._webgpuCache) {
    invertClass._webgpuCache = {
      uniformBuffer: null,
      pipeline: null,
      shaderModule: null,
      bindGroup: null,
      classifiedTexture: null,
      classifiedTextureView: null,
      sampler: null,
      framebuffer: null,
      command: null,
      initialized: false,
      width: 0,
      height: 0,
    } as InvertClassificationCache;
  }

  const cache = invertClass._webgpuCache as InvertClassificationCache;
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

    const sm = device.createShaderModule({ code: INVERT_CLASS_WGSL });
    cache.shaderModule = sm;

    cache.initialized = true;
  }

  // Resize classified texture if needed
  if (cache.width !== width || cache.height !== height) {
    if (cache.classifiedTexture) {
      cache.classifiedTexture.destroy();
    }
    cache.classifiedTexture = device.createTexture({
      size: { width, height },
      format: canvasFormat,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    cache.classifiedTextureView = cache.classifiedTexture.createView();
    cache.width = width;
    cache.height = height;
    cache.bindGroup = null; // needs recreation
    cache.pipeline = null;
    cache.command = null;
  }

  // Create pipeline if needed (depends on format)
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
          texture: { sampleType: "float" },
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
      primitive: { topology: "triangle-list" },
    });

    // Create a placeholder scene texture view for the bind group
    // In practice, this would come from the scene framebuffer
    const placeholderTex = device.createTexture({
      size: { width: 1, height: 1 },
      format: canvasFormat,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    cache.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: placeholderTex.createView() },
        { binding: 1, resource: cache.classifiedTextureView! },
        { binding: 2, resource: cache.sampler! },
        { binding: 3, resource: { buffer: cache.uniformBuffer! } },
      ],
    });
  }

  // Pack uniforms
  const highlightColor = invertClass._highlightColor ?? {
    red: 1,
    green: 1,
    blue: 0,
    alpha: 0.5,
  };
  const data = new Float32Array(8);
  data[0] = highlightColor.red ?? 1.0;
  data[1] = highlightColor.green ?? 1.0;
  data[2] = highlightColor.blue ?? 0.0;
  data[3] = highlightColor.alpha ?? 0.5;
  data[4] = invertClass._enabled ? 1.0 : 0.0;
  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);
}

function destroyWebGPUInvertClassificationResources(invertClass: CesiumObjectWithWebGPUCache): void {
  const cache = invertClass._webgpuCache as
    | InvertClassificationCache
    | undefined;
  if (!cache) {
    return;
  }
  cache.uniformBuffer?.destroy();
  cache.classifiedTexture?.destroy();
  invertClass._webgpuCache = undefined;
}

export {
  updateWebGPUInvertClassification,
  destroyWebGPUInvertClassificationResources,
};
export default {
  updateWebGPUInvertClassification,
  destroyWebGPUInvertClassificationResources,
};
