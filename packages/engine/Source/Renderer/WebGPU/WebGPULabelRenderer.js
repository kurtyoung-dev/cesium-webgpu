/**
 * @module WebGPULabelRenderer
 *
 * Handles WebGPU rendering of LabelCollection. Labels are composed of SDF
 * (Signed Distance Field) glyph billboards with antialiased edges and outlines.
 *
 * LabelCollection contains two BillboardCollections:
 *   - _glyphBillboardCollection — individual character glyphs (SDF text)
 *   - _backgroundBillboardCollection — solid background rectangles
 *
 * This renderer:
 *   1. Routes background billboards through the standard billboard pipeline
 *   2. Routes glyph billboards through the SDF pipeline with outline support
 *
 * SDF Settings (from SDFSettings.js):
 *   FONT_SIZE: 48px, PADDING: 10px, RADIUS: 8px, CUTOFF: 0.25
 *   SDF_EDGE = 1.0 - CUTOFF = 0.75 (distance at glyph boundary)
 *
 * @private
 */

import Cartesian2 from "../../Core/Cartesian2.js";
import Color from "../../Core/Color.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import SDFSettings from "../../Scene/SDFSettings.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";

// Import SDF shader source
import BillboardCollectionSDFWGSL from "../../Shaders/WebGPU/Collections/BillboardCollectionSDF.js";

const SDF_EDGE = 1.0 - SDFSettings.CUTOFF; // 0.75

// SDF instance data: 32 floats (128 bytes) — standard 24 floats + 8 for outline/SDF
const FLOATS_PER_SDF_INSTANCE = 32;
const BYTES_PER_SDF_INSTANCE = FLOATS_PER_SDF_INSTANCE * 4;
const VERTICES_PER_QUAD = 6;
const UNIFORM_BUFFER_SIZE = 256;

const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();
const scratchEncodedPos = new EncodedCartesian3();

const SDF_INSTANCE_BUFFER_LAYOUT = {
  arrayStride: BYTES_PER_SDF_INSTANCE,
  stepMode: "instance",
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x4" }, // posHighAndScale
    { shaderLocation: 1, offset: 16, format: "float32x4" }, // posLowAndRotation
    { shaderLocation: 2, offset: 32, format: "float32x4" }, // compressedAttr0
    { shaderLocation: 3, offset: 48, format: "float32x4" }, // compressedAttr1
    { shaderLocation: 4, offset: 64, format: "float32x4" }, // color (fill)
    { shaderLocation: 5, offset: 80, format: "float32x4" }, // miscFlags
    { shaderLocation: 6, offset: 96, format: "float32x4" }, // outlineColor
    { shaderLocation: 7, offset: 112, format: "float32x4" }, // sdfParams
  ],
};

/**
 * Build SDF instance data from label's glyph billboard collection.
 * Extends the standard billboard instance data with outline color and SDF params.
 * @private
 */
function buildSDFInstanceData(collection, labelCollection) {
  const billboards = collection._billboards;
  const length = collection.length;
  const instanceData = new Float32Array(length * FLOATS_PER_SDF_INSTANCE);
  let visibleCount = 0;

  for (let i = 0; i < length; i++) {
    const bb = billboards[i];
    if (!defined(bb) || !bb.show) {
      continue;
    }

    const offset = visibleCount * FLOATS_PER_SDF_INSTANCE;
    const position = bb._actualPosition || bb._position || bb.position;
    EncodedCartesian3.fromCartesian(position, scratchEncodedPos);

    // posHighAndScale
    instanceData[offset + 0] = scratchEncodedPos.high.x;
    instanceData[offset + 1] = scratchEncodedPos.high.y;
    instanceData[offset + 2] = scratchEncodedPos.high.z;
    instanceData[offset + 3] = bb.scale || 1.0;

    // posLowAndRotation
    instanceData[offset + 4] = scratchEncodedPos.low.x;
    instanceData[offset + 5] = scratchEncodedPos.low.y;
    instanceData[offset + 6] = scratchEncodedPos.low.z;
    instanceData[offset + 7] = bb.rotation || 0.0;

    // compressedAttr0: pixelOffset.xy, alignedAxis.xy
    const pixelOffset = bb.pixelOffset || Cartesian2.ZERO;
    instanceData[offset + 8] = pixelOffset.x;
    instanceData[offset + 9] = pixelOffset.y;
    instanceData[offset + 10] = 0.0;
    instanceData[offset + 11] = 0.0;

    // compressedAttr1: imageRect (x,y,w,h in atlas, normalized)
    const imageRect =
      bb._imageSubRegion || bb._textureCoordinateBoundsOrImageIndex;
    if (defined(imageRect) && typeof imageRect === "object") {
      instanceData[offset + 12] = imageRect.x || 0;
      instanceData[offset + 13] = imageRect.y || 0;
      instanceData[offset + 14] = imageRect.width || 1;
      instanceData[offset + 15] = imageRect.height || 1;
    } else {
      instanceData[offset + 12] = 0.0;
      instanceData[offset + 13] = 0.0;
      instanceData[offset + 14] = 1.0;
      instanceData[offset + 15] = 1.0;
    }

    // Fill color
    const color = bb.color || Color.WHITE;
    instanceData[offset + 16] = color.red;
    instanceData[offset + 17] = color.green;
    instanceData[offset + 18] = color.blue;
    instanceData[offset + 19] = color.alpha;

    // miscFlags: show, sizeInMeters, width, height
    instanceData[offset + 20] = 1.0;
    instanceData[offset + 21] = bb.sizeInMeters ? 1.0 : 0.0;
    instanceData[offset + 22] = bb.width || 32.0;
    instanceData[offset + 23] = bb.height || 32.0;

    // Outline color — from the billboard's label parent
    const outlineColor = bb.outlineColor || Color.BLACK;
    instanceData[offset + 24] = outlineColor.red;
    instanceData[offset + 25] = outlineColor.green;
    instanceData[offset + 26] = outlineColor.blue;
    instanceData[offset + 27] = outlineColor.alpha;

    // SDF params: outlineWidth, sdfEdge, 0, 0
    instanceData[offset + 28] = bb.outlineWidth || 0.0;
    instanceData[offset + 29] = SDF_EDGE;
    instanceData[offset + 30] = 0.0;
    instanceData[offset + 31] = 0.0;

    visibleCount++;
  }

  return { instanceData, visibleCount };
}

function packUniforms(uniformData, frameState, modelMatrix) {
  const context = frameState.context;
  const uniformState = context.uniformState;
  const canvas = context.canvas;

  Matrix4.multiply(uniformState.view, modelMatrix, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(uniformState.projection, scratchMVRTE, scratchMVPRTE);
  Matrix4.pack(scratchMVPRTE, uniformData, 0);

  Matrix4.pack(Matrix4.IDENTITY, uniformData, 16);

  EncodedCartesian3.fromCartesian(
    frameState.camera.positionWC,
    scratchEncodedCamera,
  );
  uniformData[32] = scratchEncodedCamera.high.x;
  uniformData[33] = scratchEncodedCamera.high.y;
  uniformData[34] = scratchEncodedCamera.high.z;
  uniformData[35] = 0.0;
  uniformData[36] = scratchEncodedCamera.low.x;
  uniformData[37] = scratchEncodedCamera.low.y;
  uniformData[38] = scratchEncodedCamera.low.z;
  uniformData[39] = 0.0;

  uniformData[40] = canvas.width;
  uniformData[41] = canvas.height;
  uniformData[42] = 1.0;
  uniformData[43] = 0.0;
}

function createPlaceholderTexture(device) {
  const texture = device.createTexture({
    size: [1, 1, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 4 },
    [1, 1, 1],
  );
  return texture;
}

function createSDFPipeline(device, format, depthFormat) {
  const shaderModule = device.createShaderModule({
    label: "Label SDF shader",
    code: BillboardCollectionSDFWGSL,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    label: "Label SDF bind group layout",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
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

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  const pipeline = device.createRenderPipeline({
    label: "Label SDF pipeline",
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [SDF_INSTANCE_BUFFER_LAYOUT],
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
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
  });

  return { pipeline, bindGroupLayout };
}

/**
 * Updates or creates WebGPU draw commands for LabelCollection.
 * Handles both glyph (SDF) and background billboard rendering.
 *
 * @param {LabelCollection} labelCollection
 * @param {FrameState} frameState
 * @param {Array} commandList
 */
function updateWebGPULabels(labelCollection, frameState, commandList) {
  const context = frameState.context;
  const device = context.device;
  const glyphCollection = labelCollection._glyphBillboardCollection;
  const backgroundCollection = labelCollection._backgroundBillboardCollection;

  if (!glyphCollection || glyphCollection.length === 0) {
    return;
  }

  if (!defined(labelCollection._webgpuLabelCache)) {
    labelCollection._webgpuLabelCache = {};
  }
  const cache = labelCollection._webgpuLabelCache;

  // SDF pipeline (once)
  if (!defined(cache.sdfPipeline)) {
    const format = context.presentationFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const result = createSDFPipeline(device, format, depthFmt);
    cache.sdfPipeline = result.pipeline;
    cache.sdfBindGroupLayout = result.bindGroupLayout;
  }

  // Uniform buffer (once)
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      "Label uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
  }

  // Update uniforms
  const modelMatrix = labelCollection.modelMatrix || Matrix4.IDENTITY;
  packUniforms(cache.uniformData, frameState, modelMatrix);
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  // Atlas texture — use the glyph collection's texture atlas
  let atlasTextureView = cache.atlasTextureView;
  let atlasSampler = cache.atlasSampler;

  if (!defined(atlasTextureView)) {
    // Try to get the atlas from the glyph collection
    const atlas = glyphCollection._textureAtlas;
    if (defined(atlas) && defined(atlas._webgpuTexture)) {
      atlasTextureView = atlas._webgpuTexture.view;
      atlasSampler = atlas._webgpuTexture.sampler;
    } else if (defined(atlas) && defined(atlas.texture)) {
      // WebGL texture — check for WebGPU backing
      const tex = atlas.texture;
      if (tex._webgpuTexture) {
        atlasTextureView = tex._webgpuTexture.view;
        atlasSampler =
          tex._webgpuTexture.sampler ||
          device.createSampler({
            minFilter: "linear",
            magFilter: "linear",
          });
      }
    }

    // Fallback: create placeholder
    if (!defined(atlasTextureView)) {
      if (!defined(cache.placeholderTexture)) {
        cache.placeholderTexture = createPlaceholderTexture(device);
        cache.placeholderTextureView = cache.placeholderTexture.createView();
      }
      atlasTextureView = cache.placeholderTextureView;
    }
    if (!defined(atlasSampler)) {
      atlasSampler = device.createSampler({
        minFilter: "linear",
        magFilter: "linear",
      });
    }

    cache.atlasTextureView = atlasTextureView;
    cache.atlasSampler = atlasSampler;
  }

  // Bind group — recreate each frame to pick up atlas changes
  cache.sdfBindGroup = device.createBindGroup({
    layout: cache.sdfBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
      { binding: 1, resource: atlasTextureView },
      { binding: 2, resource: atlasSampler },
    ],
  });

  // Build SDF instance data
  const { instanceData, visibleCount } = buildSDFInstanceData(
    glyphCollection,
    labelCollection,
  );

  if (visibleCount === 0) {
    return;
  }

  const requiredSize = visibleCount * BYTES_PER_SDF_INSTANCE;
  if (
    !defined(cache.sdfInstanceBuffer) ||
    cache.sdfInstanceBuffer.size < requiredSize
  ) {
    if (defined(cache.sdfInstanceBuffer)) {
      cache.sdfInstanceBuffer.destroy();
    }
    cache.sdfInstanceBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      requiredSize,
      true,
      "Label SDF instances",
    );
  }
  device.queue.writeBuffer(
    cache.sdfInstanceBuffer.buffer,
    0,
    instanceData.buffer,
    0,
    requiredSize,
  );

  // Create SDF draw command
  const sdfCommand = new WebGPUDrawCommand({
    pipeline: cache.sdfPipeline,
    bindGroups: [cache.sdfBindGroup],
    vertexBuffers: [cache.sdfInstanceBuffer],
    vertexCount: VERTICES_PER_QUAD,
    instanceCount: visibleCount,
    pass: 8, // Pass.OPAQUE
    owner: labelCollection,
    boundingVolume: glyphCollection._boundingVolume,
    modelMatrix: modelMatrix,
    cull: true,
  });

  if (frameState.passes.render) {
    commandList.push(sdfCommand);
  }

  // Background billboards: route through standard billboard renderer
  if (backgroundCollection && backgroundCollection.length > 0) {
    const billboardFR = context.getFeatureRenderer(0); // BILLBOARD_COLLECTION
    if (billboardFR) {
      billboardFR.update(backgroundCollection, frameState, commandList);
    }
  }
}

function destroyWebGPULabelResources(labelCollection) {
  const cache = labelCollection._webgpuLabelCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.sdfInstanceBuffer)) {
    cache.sdfInstanceBuffer.destroy();
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  if (defined(cache.placeholderTexture)) {
    cache.placeholderTexture.destroy();
  }
  labelCollection._webgpuLabelCache = undefined;
}

export { updateWebGPULabels, destroyWebGPULabelResources };
export default { updateWebGPULabels, destroyWebGPULabelResources };
