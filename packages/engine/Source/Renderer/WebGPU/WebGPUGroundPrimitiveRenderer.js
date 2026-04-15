/**
 * @module WebGPUGroundPrimitiveRenderer
 *
 * Handles WebGPU rendering of GroundPrimitive / ClassificationPrimitive.
 * Uses two-pass stencil approach:
 *   Pass 1: Render geometry to stencil buffer only (mark terrain coverage)
 *   Pass 2: Render color only where stencil passes (paint on terrain)
 *
 * @private
 */
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

const UNIFORM_BUFFER_SIZE = 256;
const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();

/**
 * Creates stencil and color pipelines for ground primitive rendering.
 * @private
 */
function createGroundPipelines(device, format, depthFormat) {
  const code = `
struct U { mvpRTE: mat4x4<f32>, camH: vec3<f32>, _p0: f32, camL: vec3<f32>, _p1: f32, color: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;

struct VO { @builtin(position) pos: vec4<f32> };
struct CO { @builtin(position) pos: vec4<f32>, @location(0) col: vec4<f32> };

@vertex fn stencilVS(@location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>) -> VO {
  var o: VO;
  let rte = (pH - u.camH) + (pL - u.camL);
  o.pos = u.mvpRTE * vec4f(rte, 1.0);
  return o;
}

@fragment fn stencilFS() -> @location(0) vec4<f32> { return vec4f(0.0); }

@vertex fn colorVS(@location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>) -> CO {
  var o: CO;
  let rte = (pH - u.camH) + (pL - u.camL);
  o.pos = u.mvpRTE * vec4f(rte, 1.0);
  o.col = u.color;
  return o;
}

@fragment fn colorFS(i: CO) -> @location(0) vec4<f32> { return i.col; }
`;

  const mod = device.createShaderModule({ label: "GroundPrimitive", code });
  const bgl = makeBindGroupLayout(device, "GroundPrimitive BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
  ]);
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const vertexBuffers = [
    {
      arrayStride: 24,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x3" },
      ],
    },
  ];

  // Stencil pass: write stencil, no color write, no depth write
  const stencilPipeline = device.createRenderPipeline({
    label: "GroundPrimitive stencil",
    layout,
    vertex: { module: mod, entryPoint: "stencilVS", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "stencilFS",
      targets: [{ format, writeMask: 0 }], // No color write
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
      stencilFront: {
        compare: "always",
        passOp: "replace",
        failOp: "keep",
        depthFailOp: "keep",
      },
      stencilBack: {
        compare: "always",
        passOp: "replace",
        failOp: "keep",
        depthFailOp: "keep",
      },
      stencilReadMask: 0xff,
      stencilWriteMask: 0xff,
    },
  });

  // Color pass: read stencil, write color, no depth write
  const colorPipeline = device.createRenderPipeline({
    label: "GroundPrimitive color",
    layout,
    vertex: { module: mod, entryPoint: "colorVS", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "colorFS",
      targets: [
        {
          format,
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
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
      stencilFront: {
        compare: "equal",
        passOp: "keep",
        failOp: "keep",
        depthFailOp: "keep",
      },
      stencilBack: {
        compare: "equal",
        passOp: "keep",
        failOp: "keep",
        depthFailOp: "keep",
      },
      stencilReadMask: 0xff,
      stencilWriteMask: 0x00,
    },
  });

  return { stencilPipeline, colorPipeline, bgl };
}

function packUniforms(data, frameState, modelMatrix, color) {
  const uniformState = frameState.context.uniformState;
  // Use uniformState.view/projection for 2D/Columbus View support
  Matrix4.multiply(uniformState.view, modelMatrix, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(uniformState.projection, scratchMVRTE, scratchMVPRTE);
  Matrix4.pack(scratchMVPRTE, data, 0);

  EncodedCartesian3.fromCartesian(
    frameState.camera.positionWC,
    scratchEncodedCamera,
  );
  data[16] = scratchEncodedCamera.high.x;
  data[17] = scratchEncodedCamera.high.y;
  data[18] = scratchEncodedCamera.high.z;
  data[19] = 0.0;
  data[20] = scratchEncodedCamera.low.x;
  data[21] = scratchEncodedCamera.low.y;
  data[22] = scratchEncodedCamera.low.z;
  data[23] = 0.0;

  data[24] = color?.red ?? 1.0;
  data[25] = color?.green ?? 0.0;
  data[26] = color?.blue ?? 0.0;
  data[27] = color?.alpha ?? 0.5;
}

/**
 * Creates WebGPU commands for a GroundPrimitive.
 * Returns both stencil and color commands.
 */
function createWebGPUGroundPrimitiveCommands(primitive, frameState) {
  const context = frameState.context;
  const device = context.device;

  if (!defined(primitive._webgpuCache)) {
    primitive._webgpuCache = {};
  }
  const cache = primitive._webgpuCache;

  if (!defined(cache.stencilPipeline)) {
    const format = context.presentationFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const result = createGroundPipelines(device, format, depthFmt);
    cache.stencilPipeline = result.stencilPipeline;
    cache.colorPipeline = result.colorPipeline;
    cache.bgl = result.bgl;
  }

  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      "GroundPrimitive uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
    cache.bindGroup = device.createBindGroup({
      layout: cache.bgl,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
      ],
    });
  }

  const modelMatrix = primitive.modelMatrix || Matrix4.IDENTITY;
  const color = primitive.appearance?.material?.uniforms?.color;
  packUniforms(cache.uniformData, frameState, modelMatrix, color);
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  // Build actual draw commands if vertex data is available
  const geomData = primitive._webgpuGeometryData;
  if (!defined(geomData) || !defined(geomData.vertexBuffer)) {
    return {
      stencilPipeline: cache.stencilPipeline,
      colorPipeline: cache.colorPipeline,
      bindGroup: cache.bindGroup,
      stencilCommand: null,
      colorCommand: null,
    };
  }

  // Create vertex buffer once
  if (!defined(cache.vertexGPUBuffer)) {
    const vbData = geomData.vertexBuffer;
    cache.vertexGPUBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      vbData.byteLength,
      false,
      "GroundPrimitive VB",
    );
    device.queue.writeBuffer(cache.vertexGPUBuffer.buffer, 0, vbData);
    cache.vertexCount = geomData.vertexCount || vbData.byteLength / 24;
  }

  // Create index buffer if indexed geometry
  if (defined(geomData.indexBuffer) && !defined(cache.indexGPUBuffer)) {
    const ibData = geomData.indexBuffer;
    cache.indexGPUBuffer = device.createBuffer({
      label: "GroundPrimitive IB",
      size: ibData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(cache.indexGPUBuffer, 0, ibData);
    cache.indexCount = geomData.indexCount || ibData.byteLength / 2;
  }

  // Stencil pass draw command (mark coverage, no color output)
  const stencilCommand = new WebGPUDrawCommand({
    pipeline: cache.stencilPipeline,
    bindGroups: [cache.bindGroup],
    vertexBuffers: [cache.vertexGPUBuffer],
    indexBuffer: cache.indexGPUBuffer || undefined,
    indexCount: cache.indexCount || 0,
    indexFormat: "uint16",
    vertexCount: cache.vertexCount || 0,
    stencilReference: 1,
    pass: 3, // Pass.TERRAIN_CLASSIFICATION
    owner: primitive,
  });

  // Color pass draw command (render color where stencil passes)
  const colorCommand = new WebGPUDrawCommand({
    pipeline: cache.colorPipeline,
    bindGroups: [cache.bindGroup],
    vertexBuffers: [cache.vertexGPUBuffer],
    indexBuffer: cache.indexGPUBuffer || undefined,
    indexCount: cache.indexCount || 0,
    indexFormat: "uint16",
    vertexCount: cache.vertexCount || 0,
    stencilReference: 1,
    pass: 3, // Pass.TERRAIN_CLASSIFICATION
    owner: primitive,
  });

  return {
    stencilPipeline: cache.stencilPipeline,
    colorPipeline: cache.colorPipeline,
    bindGroup: cache.bindGroup,
    stencilCommand,
    colorCommand,
  };
}

function destroyWebGPUGroundPrimitiveResources(primitive) {
  const cache = primitive._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  primitive._webgpuCache = undefined;
}

export {
  createWebGPUGroundPrimitiveCommands,
  destroyWebGPUGroundPrimitiveResources,
};
export default {
  createWebGPUGroundPrimitiveCommands,
  destroyWebGPUGroundPrimitiveResources,
};
