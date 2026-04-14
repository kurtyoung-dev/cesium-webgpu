/**
 * WebGPU Cloud Renderer
 *
 * Renders cumulus cloud collections using WebGPU instanced billboard quads
 * with procedural noise for volumetric cloud appearance.
 * Uses RTE (Relative-To-Eye) positioning for planetary-scale precision.
 *
 * @module WebGPUCloudRenderer
 */

import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { m4Values } from "./webgpuTypeHelpers.js";

interface CloudCache {
  quadVertexBuffer: GPUBuffer | null;
  instanceBuffer: GPUBuffer | null;
  uniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup: GPUBindGroup | null;
  noiseTexture: GPUTexture | null;
  noiseTextureView: GPUTextureView | null;
  sampler: GPUSampler | null;
  instanceCount: number;
  command: CesiumAnyDrawCommand | null;
  initialized: boolean;
  lastCloudCount: number;
}

const CLOUD_WGSL = /* wgsl */ `
struct CameraUniforms {
  modelViewProjectionRTE: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  time: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var noiseTex: texture_2d<f32>;
@group(0) @binding(2) var noiseSampler: sampler;

struct VertexInput {
  @location(0) quadPos: vec2<f32>,
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) scaleAndBrightness: vec4<f32>,
  @location(4) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) vColor: vec4<f32>,
  @location(2) vBrightness: f32,
};

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let posRTE = (input.positionHigh - camera.encodedCameraHigh)
             + (input.positionLow - camera.encodedCameraLow);
  let centerClip = camera.modelViewProjectionRTE * vec4<f32>(posRTE, 1.0);
  let offset = vec2<f32>(
    input.quadPos.x * input.scaleAndBrightness.x / camera.viewportSize.x * 2.0,
    input.quadPos.y * input.scaleAndBrightness.y / camera.viewportSize.y * 2.0
  );
  output.position = centerClip + vec4<f32>(offset * centerClip.w, 0.0, 0.0);
  output.uv = input.quadPos * 0.5 + 0.5;
  output.vColor = input.color;
  output.vBrightness = input.scaleAndBrightness.z;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let dist = length(input.uv - vec2<f32>(0.5));
  let alpha = smoothstep(0.5, 0.2, dist);
  let noise = textureSample(noiseTex, noiseSampler, input.uv * 2.0).r;
  let cloudAlpha = alpha * (0.5 + 0.5 * noise) * input.vColor.a;
  let cloudColor = input.vColor.rgb * input.vBrightness;
  if (cloudAlpha < 0.01) { discard; }
  return vec4<f32>(cloudColor, cloudAlpha);
}
`;

const scratchEncoded = { high: new Cartesian3(), low: new Cartesian3() };
const scratchMVP = new Matrix4();
// Scratch view matrix with translation column zeroed — used to build a
// translation-free MVP correctly (must zero before projecting).
const scratchMVRTE = new Matrix4();

function createNoiseTexture(device: GPUDevice): {
  texture: GPUTexture;
  view: GPUTextureView;
} {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const val = Math.floor(
        (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 256,
      );
      data[idx] = Math.abs(val);
      data[idx + 1] = Math.abs(val);
      data[idx + 2] = Math.abs(val);
      data[idx + 3] = 255;
    }
  }
  const texture = device.createTexture({
    size: { width: size, height: size },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: size * 4 },
    { width: size, height: size },
  );
  return { texture, view: texture.createView() };
}

function createQuadVB(device: GPUDevice): GPUBuffer {
  const v = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
  const buf = device.createBuffer({
    size: v.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, v);
  return buf;
}

function buildInstanceBuffer(
  device: GPUDevice,
  collection: CesiumObjectWithWebGPUCache,
): { buffer: GPUBuffer; count: number } {
  const clouds = collection._clouds || [];
  const count = clouds.length || collection.length || 0;
  if (count === 0) {
    return {
      buffer: device.createBuffer({ size: 48, usage: GPUBufferUsage.VERTEX }),
      count: 0,
    };
  }
  // Per instance: posHigh(12) + posLow(12) + scaleAndBrightness(16) + color(16) = 56 bytes
  const data = new Float32Array(count * 14);
  for (let i = 0; i < count; i++) {
    const rawCloud =
      clouds[i] || (collection.get ? collection.get(i) : undefined);
    if (!rawCloud) {
      continue;
    }
    const cloud = rawCloud as {
      position?: CesiumCartesian3;
      scale?: CesiumCartesian2;
      brightness?: number;
      slice?: number;
      color?: CesiumColor;
    };
    const pos = cloud.position || new Cartesian3();
    EncodedCartesian3.fromCartesian(pos, scratchEncoded);
    const off = i * 14;
    data[off] = scratchEncoded.high.x;
    data[off + 1] = scratchEncoded.high.y;
    data[off + 2] = scratchEncoded.high.z;
    data[off + 3] = scratchEncoded.low.x;
    data[off + 4] = scratchEncoded.low.y;
    data[off + 5] = scratchEncoded.low.z;
    data[off + 6] = cloud.scale?.x ?? 50.0;
    data[off + 7] = cloud.scale?.y ?? 30.0;
    data[off + 8] = cloud.brightness ?? 1.0;
    data[off + 9] = cloud.slice ?? 0.0;
    const c = cloud.color;
    data[off + 10] = c?.red ?? 1.0;
    data[off + 11] = c?.green ?? 1.0;
    data[off + 12] = c?.blue ?? 1.0;
    data[off + 13] = c?.alpha ?? 0.8;
  }
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return { buffer, count };
}

function updateWebGPUCloudCollection(
  collection: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const commandList = frameState.commandList;

  if (!collection.show || collection.length === 0) {
    return;
  }

  if (!collection._webgpuCache) {
    collection._webgpuCache = {
      quadVertexBuffer: null,
      instanceBuffer: null,
      uniformBuffer: null,
      pipeline: null,
      shaderModule: null,
      bindGroup: null,
      noiseTexture: null,
      noiseTextureView: null,
      sampler: null,
      instanceCount: 0,
      command: null,
      initialized: false,
      lastCloudCount: -1,
    } as CloudCache;
  }

  const cache = collection._webgpuCache as CloudCache;
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

  if (!cache.initialized) {
    cache.shaderModule = device.createShaderModule({ code: CLOUD_WGSL });
    cache.uniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const noise = createNoiseTexture(device);
    cache.noiseTexture = noise.texture;
    cache.noiseTextureView = noise.view;
    cache.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
    cache.quadVertexBuffer = createQuadVB(device);

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
          texture: { sampleType: "float" },
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
        module: cache.shaderModule,
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
            arrayStride: 56,
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
              {
                shaderLocation: 4,
                offset: 40,
                format: "float32x4" as GPUVertexFormat,
              },
            ],
          },
        ],
      },
      fragment: {
        module: cache.shaderModule,
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
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: false,
        // less-equal for planetary-scale precision robustness — see
        // the matching comment in WebGPUBufferPrimitiveRenderer.
        depthCompare: "less-equal",
      },
    });

    cache.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer } },
        { binding: 1, resource: cache.noiseTextureView! },
        { binding: 2, resource: cache.sampler! },
      ],
    });

    cache.initialized = true;
  }

  // Rebuild instance buffer when clouds change
  const cloudCount = collection.length;
  if (cloudCount !== cache.lastCloudCount) {
    if (cache.instanceBuffer) {
      cache.instanceBuffer.destroy();
    }
    const result = buildInstanceBuffer(device, collection);
    cache.instanceBuffer = result.buffer;
    cache.instanceCount = result.count;
    cache.lastCloudCount = cloudCount;
    cache.command = null;
  }

  if (cache.instanceCount === 0) {
    return;
  }

  // Pack camera uniforms.
  //
  // RTE: zero the translation column of VIEW *before* multiplying by
  // projection. Zeroing the result's col3 after the multiply wipes out
  // projection's P23 depth-mapping term, producing incorrect NDC depth.
  // See `UniformStateComputations.cleanModelViewProjectionRelativeToEye`
  // for the canonical pattern.
  const us = context.uniformState;
  const view = us.view;
  const proj = us.projection;
  Matrix4.clone(view, scratchMVRTE);
  scratchMVRTE[12] = 0;
  scratchMVRTE[13] = 0;
  scratchMVRTE[14] = 0;
  const mvp = m4Values(Matrix4.multiply(proj, scratchMVRTE, scratchMVP));

  const data = new Float32Array(28);
  for (let i = 0; i < 16; i++) {
    data[i] = mvp[i];
  }

  const camWorld = us.cameraPosition;
  EncodedCartesian3.fromCartesian(camWorld, scratchEncoded);
  data[16] = scratchEncoded.high.x;
  data[17] = scratchEncoded.high.y;
  data[18] = scratchEncoded.high.z;
  data[19] = 0;
  data[20] = scratchEncoded.low.x;
  data[21] = scratchEncoded.low.y;
  data[22] = scratchEncoded.low.z;
  data[23] = 0;

  const canvas = context._canvas || { width: 1920, height: 1080 };
  data[24] = canvas.width;
  data[25] = canvas.height;
  data[26] = frameState.frameNumber * 0.016; // approximate time for animation
  data[27] = 0;
  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);

  if (!cache.command) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup],
      vertexBuffers: [cache.quadVertexBuffer, cache.instanceBuffer],
      vertexCount: 6,
      instanceCount: cache.instanceCount,
      pass: Pass.TRANSLUCENT,
    });
  }

  commandList.push(cache.command);
}

function destroyWebGPUCloudResources(
  collection: CesiumObjectWithWebGPUCache,
): void {
  const cache = collection._webgpuCache as CloudCache | undefined;
  if (!cache) {
    return;
  }
  cache.quadVertexBuffer?.destroy();
  cache.instanceBuffer?.destroy();
  cache.uniformBuffer?.destroy();
  cache.noiseTexture?.destroy();
  collection._webgpuCache = undefined;
}

export { updateWebGPUCloudCollection, destroyWebGPUCloudResources };
export default { updateWebGPUCloudCollection, destroyWebGPUCloudResources };
