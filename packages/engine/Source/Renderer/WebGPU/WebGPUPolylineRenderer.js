/**
 * @module WebGPUPolylineRenderer
 *
 * Handles WebGPU rendering of PolylineCollection.
 * Polylines are rendered as instanced screen-space quads per line segment.
 *
 * Instance data per segment (80 bytes, 5 x vec4):
 *   startPosHighAndWidth(4) + startPosLow(4) + endPosHighAndMiter(4) +
 *   endPosLow(4) + color(4) = 20 floats
 *
 * @private
 */
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";

const FLOATS_PER_SEGMENT = 20;
const BYTES_PER_SEGMENT = FLOATS_PER_SEGMENT * 4;
const VERTICES_PER_SEGMENT = 6;
const UNIFORM_BUFFER_SIZE = 256;

const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();
const scratchEncodedStart = new EncodedCartesian3();
const scratchEncodedEnd = new EncodedCartesian3();

let _cachedShaderSource = null;
async function getShaderSource() {
  if (_cachedShaderSource) {
    return _cachedShaderSource;
  }
  const response = await fetch(
    "../../Source/Shaders/WebGPU/Collections/PolylineCollection.wgsl",
  );
  _cachedShaderSource = await response.text();
  return _cachedShaderSource;
}

/**
 * Build segment instance data from polyline collection.
 * @private
 */
function buildSegmentData(collection) {
  const polylines = collection._polylines;
  const length = collection._polylinesLength;

  // Count total segments
  let totalSegments = 0;
  for (let i = 0; i < length; i++) {
    const polyline = polylines[i];
    if (!defined(polyline) || !polyline.show) {
      continue;
    }
    const positions = polyline.positions;
    if (positions.length >= 2) {
      totalSegments += positions.length - 1;
    }
  }

  const segmentData = new Float32Array(totalSegments * FLOATS_PER_SEGMENT);
  let segmentCount = 0;

  for (let i = 0; i < length; i++) {
    const polyline = polylines[i];
    if (!defined(polyline) || !polyline.show) {
      continue;
    }

    const positions = polyline.positions;
    const width = polyline.width || 1.0;
    const color = polyline._color || polyline.material?.uniforms?.color;
    const r = color ? color.red : 1.0;
    const g = color ? color.green : 1.0;
    const b = color ? color.blue : 1.0;
    const a = color ? color.alpha : 1.0;

    for (let j = 0; j < positions.length - 1; j++) {
      const offset = segmentCount * FLOATS_PER_SEGMENT;
      const start = positions[j];
      const end = positions[j + 1];

      EncodedCartesian3.fromCartesian(start, scratchEncodedStart);
      EncodedCartesian3.fromCartesian(end, scratchEncodedEnd);

      // startPosHighAndWidth
      segmentData[offset + 0] = scratchEncodedStart.high.x;
      segmentData[offset + 1] = scratchEncodedStart.high.y;
      segmentData[offset + 2] = scratchEncodedStart.high.z;
      segmentData[offset + 3] = width;

      // startPosLow
      segmentData[offset + 4] = scratchEncodedStart.low.x;
      segmentData[offset + 5] = scratchEncodedStart.low.y;
      segmentData[offset + 6] = scratchEncodedStart.low.z;
      segmentData[offset + 7] = 0.0;

      // endPosHighAndMiter
      segmentData[offset + 8] = scratchEncodedEnd.high.x;
      segmentData[offset + 9] = scratchEncodedEnd.high.y;
      segmentData[offset + 10] = scratchEncodedEnd.high.z;
      segmentData[offset + 11] = 2.0; // miterLimit

      // endPosLow
      segmentData[offset + 12] = scratchEncodedEnd.low.x;
      segmentData[offset + 13] = scratchEncodedEnd.low.y;
      segmentData[offset + 14] = scratchEncodedEnd.low.z;
      segmentData[offset + 15] = 0.0;

      // color
      segmentData[offset + 16] = r;
      segmentData[offset + 17] = g;
      segmentData[offset + 18] = b;
      segmentData[offset + 19] = a;

      segmentCount++;
    }
  }

  return { segmentData, segmentCount };
}

const SEGMENT_BUFFER_LAYOUT = {
  arrayStride: BYTES_PER_SEGMENT,
  stepMode: "instance",
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x4" },
    { shaderLocation: 1, offset: 16, format: "float32x4" },
    { shaderLocation: 2, offset: 32, format: "float32x4" },
    { shaderLocation: 3, offset: 48, format: "float32x4" },
    { shaderLocation: 4, offset: 64, format: "float32x4" },
  ],
};

function createPolylinePipeline(device, shaderCode, format, depthFormat) {
  const shaderModule = device.createShaderModule({
    label: "Polyline shader",
    code: shaderCode,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    label: "Polyline bind group layout",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  const pipeline = device.createRenderPipeline({
    label: "Polyline pipeline",
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [SEGMENT_BUFFER_LAYOUT],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
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
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  });

  return { pipeline, bindGroupLayout };
}

function packUniforms(uniformData, frameState, modelMatrix) {
  const camera = frameState.camera;
  const canvas = frameState.context.canvas;

  Matrix4.multiply(camera.viewMatrix, modelMatrix, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(
    camera.frustum.projectionMatrix,
    scratchMVRTE,
    scratchMVPRTE,
  );
  Matrix4.pack(scratchMVPRTE, uniformData, 0);

  EncodedCartesian3.fromCartesian(camera.positionWC, scratchEncodedCamera);
  uniformData[16] = scratchEncodedCamera.high.x;
  uniformData[17] = scratchEncodedCamera.high.y;
  uniformData[18] = scratchEncodedCamera.high.z;
  uniformData[19] = 0.0;
  uniformData[20] = scratchEncodedCamera.low.x;
  uniformData[21] = scratchEncodedCamera.low.y;
  uniformData[22] = scratchEncodedCamera.low.z;
  uniformData[23] = 0.0;

  uniformData[24] = canvas.width;
  uniformData[25] = canvas.height;
  uniformData[26] = 0.0;
  uniformData[27] = 0.0;
}

/**
 * Updates or creates WebGPU draw commands for PolylineCollection.
 */
async function updateWebGPUPolylines(collection, frameState, commandList) {
  const context = frameState.context;
  const device = context.device;
  const length = collection._polylinesLength;
  if (length === 0) {
    return;
  }

  if (!defined(collection._webgpuCache)) {
    collection._webgpuCache = {};
  }
  const cache = collection._webgpuCache;

  // Pipeline (once)
  if (!defined(cache.pipeline)) {
    const shaderCode = await getShaderSource();
    const format = context.presentationFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const result = createPolylinePipeline(device, shaderCode, format, depthFmt);
    cache.pipeline = result.pipeline;
    cache.bindGroupLayout = result.bindGroupLayout;
  }

  // Uniform buffer
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      "Polyline uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
  }

  const modelMatrix = collection.modelMatrix || Matrix4.IDENTITY;
  packUniforms(cache.uniformData, frameState, modelMatrix);
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  if (!defined(cache.bindGroup)) {
    cache.bindGroup = device.createBindGroup({
      layout: cache.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
      ],
    });
  }

  // Segment data
  const { segmentData, segmentCount } = buildSegmentData(collection);
  if (segmentCount === 0) {
    return;
  }

  const requiredSize = segmentCount * BYTES_PER_SEGMENT;
  if (
    !defined(cache.segmentBuffer) ||
    cache.segmentBuffer.size < requiredSize
  ) {
    if (defined(cache.segmentBuffer)) {
      cache.segmentBuffer.destroy();
    }
    cache.segmentBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      requiredSize,
      true,
      "Polyline segments",
    );
  }
  device.queue.writeBuffer(
    cache.segmentBuffer.buffer,
    0,
    segmentData.buffer,
    0,
    requiredSize,
  );

  cache.colorCommand = new WebGPUDrawCommand({
    pipeline: cache.pipeline,
    bindGroups: [cache.bindGroup],
    vertexBuffers: [cache.segmentBuffer],
    vertexCount: VERTICES_PER_SEGMENT,
    instanceCount: segmentCount,
    pass: 8, // Pass.OPAQUE
    owner: collection,
    boundingVolume: collection._boundingVolume,
    modelMatrix: modelMatrix,
    cull: true,
  });

  commandList.push(cache.colorCommand);
}

function destroyWebGPUPolylineResources(collection) {
  const cache = collection._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.segmentBuffer)) {
    cache.segmentBuffer.destroy();
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  collection._webgpuCache = undefined;
}

export { updateWebGPUPolylines, destroyWebGPUPolylineResources };
export default { updateWebGPUPolylines, destroyWebGPUPolylineResources };
