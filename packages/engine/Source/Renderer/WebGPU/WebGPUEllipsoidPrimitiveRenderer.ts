/**
 * WebGPU Ellipsoid Primitive Renderer
 *
 * Renders ray-marched ellipsoid primitives using WebGPU. Each ellipsoid
 * is rendered as a screen-space quad with a fragment shader that performs
 * analytical ray-ellipsoid intersection for pixel-perfect rendering.
 * Uses RTE (Relative-To-Eye) positioning for planetary-scale precision.
 *
 * @module WebGPUEllipsoidPrimitiveRenderer
 */

import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { m4Values, gpuData } from "./webgpuTypeHelpers.js";

interface EllipsoidCache {
  uniformBuffer: GPUBuffer | null;
  ellipsoidUniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup0: GPUBindGroup | null;
  bindGroup1: GPUBindGroup | null;
  vertexBuffer: GPUBuffer | null;
  indexBuffer: GPUBuffer | null;
  command: any | null;
  initialized: boolean;
}

// Inline WGSL for ray-marched ellipsoid
const ELLIPSOID_WGSL = `
struct CameraUniforms {
  modelViewProjectionRelativeToEye: mat4x4<f32>,
  modelViewRelativeToEye: mat4x4<f32>,
  encodedCameraPositionMCHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraPositionMCLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  _pad2: f32,
  _pad3: f32,
};

struct EllipsoidUniforms {
  radii: vec3<f32>,
  _pad0: f32,
  oneOverRadiiSq: vec3<f32>,
  _pad1: f32,
  color: vec4<f32>,
  centerHigh: vec3<f32>,
  _pad2: f32,
  centerLow: vec3<f32>,
  _pad3: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> ellipsoid: EllipsoidUniforms;

struct VertexInput {
  @location(0) position: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) eyeDirection: vec3<f32>,
  @location(1) ellipsoidCenter: vec3<f32>,
};

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(input.position, 0.0, 1.0);
  let centerRTE = (ellipsoid.centerHigh - camera.encodedCameraPositionMCHigh)
                + (ellipsoid.centerLow - camera.encodedCameraPositionMCLow);
  let centerEye = (camera.modelViewRelativeToEye * vec4<f32>(centerRTE, 1.0)).xyz;
  output.ellipsoidCenter = centerEye;
  let aspectRatio = camera.viewportSize.x / camera.viewportSize.y;
  output.eyeDirection = vec3<f32>(input.position.x * aspectRatio, input.position.y, -1.0);
  return output;
}

fn intersectEllipsoid(
  rayOrigin: vec3<f32>, rayDir: vec3<f32>,
  center: vec3<f32>, oneOverRadiiSq: vec3<f32>
) -> vec2<f32> {
  let oc = rayOrigin - center;
  let sqrtOORS = sqrt(oneOverRadiiSq);
  let ocScaled = oc * sqrtOORS;
  let dirScaled = rayDir * sqrtOORS;
  let a = dot(dirScaled, dirScaled);
  let b = 2.0 * dot(dirScaled, ocScaled);
  let c = dot(ocScaled, ocScaled) - 1.0;
  let disc = b * b - 4.0 * a * c;
  if (disc < 0.0) { return vec2<f32>(-1.0, -1.0); }
  let sd = sqrt(disc);
  return vec2<f32>((-b - sd) / (2.0 * a), (-b + sd) / (2.0 * a));
}

@fragment
fn fragmentMain(
  @builtin(position) fragPos: vec4<f32>,
  @location(0) eyeDirection: vec3<f32>,
  @location(1) ellipsoidCenter: vec3<f32>,
) -> @location(0) vec4<f32> {
  let rayDir = normalize(eyeDirection);
  let t = intersectEllipsoid(vec3<f32>(0.0), rayDir, ellipsoidCenter, ellipsoid.oneOverRadiiSq);
  if (t.x < 0.0 && t.y < 0.0) { discard; }
  var tHit = t.x;
  if (tHit < 0.0) { tHit = t.y; }
  if (tHit < 0.0) { discard; }
  let hit = rayDir * tHit;
  let n = normalize((hit - ellipsoidCenter) * ellipsoid.oneOverRadiiSq);
  let lightDir = normalize(vec3<f32>(0.5, 1.0, 0.3));
  let NdotL = max(dot(n, lightDir), 0.0);
  let col = ellipsoid.color.rgb * (0.3 + 0.7 * NdotL);
  return vec4<f32>(col, ellipsoid.color.a);
}
`;

// Scratch objects for RTE encoding
const scratchEncodedPosition = {
  high: new Cartesian3(),
  low: new Cartesian3(),
};
const scratchMVP = new Matrix4();
const scratchMV = new Matrix4();

function createQuadGeometry(device: GPUDevice): {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
} {
  const vertices = new Float32Array([
    -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0,
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

  const vertexBuffer = device.createBuffer({
    size: vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, gpuData(vertices));

  const indexBuffer = device.createBuffer({
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, gpuData(indices));

  return { vertexBuffer, indexBuffer };
}

function createPipelineAndLayouts(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
): {
  pipeline: GPURenderPipeline;
  shaderModule: GPUShaderModule;
  bindGroupLayout0: GPUBindGroupLayout;
  bindGroupLayout1: GPUBindGroupLayout;
} {
  const shaderModule = device.createShaderModule({ code: ELLIPSOID_WGSL });

  const bindGroupLayout0 = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" as GPUBufferBindingType },
      },
    ],
  });

  const bindGroupLayout1 = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" as GPUBufferBindingType },
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout0, bindGroupLayout1],
  });

  const pipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 8,
          attributes: [
            {
              shaderLocation: 0,
              offset: 0,
              format: "float32x2" as GPUVertexFormat,
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
      depthCompare: "less",
    },
  });

  return { pipeline, shaderModule, bindGroupLayout0, bindGroupLayout1 };
}

function packCameraUniforms(
  uniformState: any,
  modelMatrix: any,
  viewportWidth: number,
  viewportHeight: number,
): Float32Array {
  // 176 bytes = 44 floats: mvpRTE(16) + mvRTE(16) + camHigh(3+1) + camLow(3+1) + viewport(2+2 pad)
  const data = new Float32Array(44);
  const view = uniformState.view;
  const projection = uniformState.projection;
  const mvM4 = Matrix4.multiply(view, modelMatrix, scratchMV);
  const mv = m4Values(mvM4);
  const mvp = m4Values(Matrix4.multiply(projection, mvM4, scratchMVP));

  // Zero translation for RTE
  mvp[12] = 0;
  mvp[13] = 0;
  mvp[14] = 0;
  mv[12] = 0;
  mv[13] = 0;
  mv[14] = 0;

  // MVP relative to eye
  for (let i = 0; i < 16; i++) {
    data[i] = mvp[i];
  }
  // ModelView relative to eye
  for (let i = 0; i < 16; i++) {
    data[16 + i] = mv[i];
  }

  // Encoded camera position in model coordinates
  const invModel = Matrix4.inverse(modelMatrix, new Matrix4());
  const camWorld = uniformState.cameraPosition;
  const camModel = Matrix4.multiplyByPoint(
    invModel,
    camWorld,
    new Cartesian3(),
  );
  EncodedCartesian3.fromCartesian(camModel, scratchEncodedPosition);
  data[32] = scratchEncodedPosition.high.x;
  data[33] = scratchEncodedPosition.high.y;
  data[34] = scratchEncodedPosition.high.z;
  data[35] = 0; // pad
  data[36] = scratchEncodedPosition.low.x;
  data[37] = scratchEncodedPosition.low.y;
  data[38] = scratchEncodedPosition.low.z;
  data[39] = 0; // pad

  // viewportSize at offset 160 (float index 40)
  data[40] = viewportWidth;
  data[41] = viewportHeight;
  data[42] = 0; // _pad2
  data[43] = 0; // _pad3
  return data;
}

function packEllipsoidUniforms(primitive: any): Float32Array {
  // 96 bytes = 24 floats: radii(3+1) + oneOverRadiiSq(3+1) + color(4) + centerHigh(3+1) + centerLow(3+1)
  const data = new Float32Array(24);
  const radii = primitive.radii;
  data[0] = radii.x;
  data[1] = radii.y;
  data[2] = radii.z;
  data[3] = 0;

  const oors = primitive._oneOverEllipsoidRadiiSquared;
  data[4] = oors.x;
  data[5] = oors.y;
  data[6] = oors.z;
  data[7] = 0;

  // Color from material or default
  const color = primitive.material?.uniforms?.color;
  if (color) {
    data[8] = color.red ?? color.x ?? 1.0;
    data[9] = color.green ?? color.y ?? 1.0;
    data[10] = color.blue ?? color.z ?? 1.0;
    data[11] = color.alpha ?? color.w ?? 1.0;
  } else {
    data[8] = 1.0;
    data[9] = 1.0;
    data[10] = 1.0;
    data[11] = 1.0;
  }

  // Encode center position (from modelMatrix translation)
  const modelMatrix = primitive.modelMatrix ?? Matrix4.IDENTITY;
  const center = Matrix4.getTranslation(modelMatrix, new Cartesian3());
  EncodedCartesian3.fromCartesian(center, scratchEncodedPosition);
  data[12] = scratchEncodedPosition.high.x;
  data[13] = scratchEncodedPosition.high.y;
  data[14] = scratchEncodedPosition.high.z;
  data[15] = 0;
  data[16] = scratchEncodedPosition.low.x;
  data[17] = scratchEncodedPosition.low.y;
  data[18] = scratchEncodedPosition.low.z;
  data[19] = 0;

  return data;
}

/**
 * Update WebGPU ellipsoid primitive resources and issue draw commands.
 */
function updateWebGPUEllipsoidPrimitive(primitive: any, frameState: any): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const commandList = frameState.commandList;

  if (!primitive.show) {
    return;
  }

  // Compute oneOverEllipsoidRadiiSquared if needed
  const radii = primitive.radii;
  if (radii) {
    const oors = primitive._oneOverEllipsoidRadiiSquared;
    if (!oors || oors.x === 0) {
      primitive._oneOverEllipsoidRadiiSquared = new Cartesian3(
        1.0 / (radii.x * radii.x),
        1.0 / (radii.y * radii.y),
        1.0 / (radii.z * radii.z),
      );
    }
  }

  if (!primitive._webgpuCache) {
    primitive._webgpuCache = {
      uniformBuffer: null,
      ellipsoidUniformBuffer: null,
      pipeline: null,
      shaderModule: null,
      bindGroup0: null,
      bindGroup1: null,
      vertexBuffer: null,
      indexBuffer: null,
      command: null,
      initialized: false,
    } as EllipsoidCache;
  }

  const cache = primitive._webgpuCache as EllipsoidCache;
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

  // One-time initialization
  if (!cache.initialized) {
    // Camera UBO: 44 floats × 4 = 176 bytes (mvpRTE + mvRTE + camHigh/Low + viewport)
    cache.uniformBuffer = device.createBuffer({
      size: 176,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Ellipsoid UBO: 24 floats × 4 = 96 bytes (radii + oneOverRadiiSq + color + center)
    cache.ellipsoidUniformBuffer = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create pipeline
    const { pipeline, shaderModule, bindGroupLayout0, bindGroupLayout1 } =
      createPipelineAndLayouts(device, canvasFormat);
    cache.pipeline = pipeline;
    cache.shaderModule = shaderModule;

    // Create bind groups
    cache.bindGroup0 = device.createBindGroup({
      layout: bindGroupLayout0,
      entries: [{ binding: 0, resource: { buffer: cache.uniformBuffer } }],
    });
    cache.bindGroup1 = device.createBindGroup({
      layout: bindGroupLayout1,
      entries: [
        { binding: 0, resource: { buffer: cache.ellipsoidUniformBuffer } },
      ],
    });

    // Create quad geometry
    const geom = createQuadGeometry(device);
    cache.vertexBuffer = geom.vertexBuffer;
    cache.indexBuffer = geom.indexBuffer;

    cache.initialized = true;
  }

  // Per-frame uniform updates
  const uniformState = context.uniformState;
  const modelMatrix = primitive.modelMatrix ?? Matrix4.IDENTITY;

  const viewportWidth = context.drawingBufferWidth || 1;
  const viewportHeight = context.drawingBufferHeight || 1;
  const cameraData = packCameraUniforms(
    uniformState,
    modelMatrix,
    viewportWidth,
    viewportHeight,
  );
  device.queue.writeBuffer(cache.uniformBuffer!, 0, gpuData(cameraData));

  const ellipsoidData = packEllipsoidUniforms(primitive);
  device.queue.writeBuffer(
    cache.ellipsoidUniformBuffer!,
    0,
    gpuData(ellipsoidData),
  );

  // Create or update draw command
  if (!cache.command) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup0, cache.bindGroup1],
      vertexBuffers: [cache.vertexBuffer],
      indexBuffer: cache.indexBuffer,
      indexCount: 6,
      pass: Pass.OPAQUE,
    });
  }

  commandList.push(cache.command);
}

/**
 * Destroy WebGPU ellipsoid primitive resources.
 */
function destroyWebGPUEllipsoidPrimitiveResources(primitive: any): void {
  const cache = primitive._webgpuCache as EllipsoidCache | undefined;
  if (!cache) {
    return;
  }

  cache.uniformBuffer?.destroy();
  cache.ellipsoidUniformBuffer?.destroy();
  cache.vertexBuffer?.destroy();
  cache.indexBuffer?.destroy();

  primitive._webgpuCache = undefined;
}

export {
  updateWebGPUEllipsoidPrimitive,
  destroyWebGPUEllipsoidPrimitiveResources,
};
export default {
  updateWebGPUEllipsoidPrimitive,
  destroyWebGPUEllipsoidPrimitiveResources,
};
