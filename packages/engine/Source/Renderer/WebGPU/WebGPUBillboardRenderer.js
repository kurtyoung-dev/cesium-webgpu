/**
 * @module WebGPUBillboardRenderer
 *
 * Handles WebGPU rendering of BillboardCollection.
 * Billboards are rendered as instanced screen-aligned quads with texture atlas.
 *
 * Instance data layout (96 bytes per billboard, 6 x vec4):
 *   posHighAndScale(4) + posLowAndRotation(4) + compressedAttr0(4) +
 *   compressedAttr1(4) + color(4) + miscFlags(4) = 24 floats
 *
 * @private
 */
import Cartesian2 from "../../Core/Cartesian2.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { getCollectionShaderSource } from "./WebGPUCollectionShaders.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

const FLOATS_PER_INSTANCE = 24;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;
const VERTICES_PER_QUAD = 6;
const UNIFORM_BUFFER_SIZE = 256;

const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();
const scratchEncodedPos = new EncodedCartesian3();

let _cachedShaderSource = null;
async function getShaderSource() {
  if (_cachedShaderSource) {
    return _cachedShaderSource;
  }
  const response = await fetch(
    "../../Source/Shaders/WebGPU/Collections/BillboardCollection.wgsl",
  );
  _cachedShaderSource = await response.text();
  return _cachedShaderSource;
}

/**
 * Build instance data from billboard collection.
 * @private
 */
function buildInstanceData(collection) {
  const billboards = collection._billboards;
  const length = collection.length;
  const instanceData = new Float32Array(length * FLOATS_PER_INSTANCE);
  let visibleCount = 0;

  for (let i = 0; i < length; i++) {
    const bb = billboards[i];
    // clusterShow is false when EntityCluster has folded this billboard into a
    // cluster glyph. Skipping these prevents the stack of overlapping icons
    // that WebGL already avoids via the same read.
    if (!defined(bb) || !bb.show || bb._clusterShow === false) {
      continue;
    }

    const offset = visibleCount * FLOATS_PER_INSTANCE;
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
    // alignedAxis is a Cartesian3 world-space axis; billboard shader supports
    // 2D eye-space rotation, so we project to the screen-plane components
    // (x = east-west, y = up-down). Non-(0,0,0) axes orient the billboard
    // around that world axis (e.g. flagpole pointing up, road chevrons
    // pointing along a road vector).
    const pixelOffset = bb.pixelOffset || Cartesian2.ZERO;
    const alignedAxis = bb._alignedAxis;
    instanceData[offset + 8] = pixelOffset.x;
    instanceData[offset + 9] = pixelOffset.y;
    instanceData[offset + 10] = alignedAxis ? alignedAxis.x : 0.0;
    instanceData[offset + 11] = alignedAxis ? alignedAxis.y : 0.0;

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

    // color
    const color = bb.color;
    instanceData[offset + 16] = color.red;
    instanceData[offset + 17] = color.green;
    instanceData[offset + 18] = color.blue;
    instanceData[offset + 19] = color.alpha;

    // miscFlags: show, sizeInMeters, width, height
    instanceData[offset + 20] = 1.0; // show
    instanceData[offset + 21] = bb.sizeInMeters ? 1.0 : 0.0;
    instanceData[offset + 22] = bb.width || 32.0;
    instanceData[offset + 23] = bb.height || 32.0;

    visibleCount++;
  }

  return { instanceData, visibleCount };
}

/**
 * Builds pick-variant instance data. Same layout as color but @location(4)
 * holds pick color instead of display color.
 * @private
 */
function buildPickInstanceData(collection, context) {
  const billboards = collection._billboards;
  const length = collection.length;
  const instanceData = new Float32Array(length * FLOATS_PER_INSTANCE);
  let visibleCount = 0;

  for (let i = 0; i < length; i++) {
    const bb = billboards[i];
    // clusterShow is false when EntityCluster has folded this billboard into a
    // cluster glyph. Skipping these prevents the stack of overlapping icons
    // that WebGL already avoids via the same read.
    if (!defined(bb) || !bb.show || bb._clusterShow === false) {
      continue;
    }

    const offset = visibleCount * FLOATS_PER_INSTANCE;
    const position = bb._actualPosition || bb._position || bb.position;
    EncodedCartesian3.fromCartesian(position, scratchEncodedPos);

    // Attributes 0-3 identical to color path
    instanceData[offset + 0] = scratchEncodedPos.high.x;
    instanceData[offset + 1] = scratchEncodedPos.high.y;
    instanceData[offset + 2] = scratchEncodedPos.high.z;
    instanceData[offset + 3] = bb.scale || 1.0;
    instanceData[offset + 4] = scratchEncodedPos.low.x;
    instanceData[offset + 5] = scratchEncodedPos.low.y;
    instanceData[offset + 6] = scratchEncodedPos.low.z;
    instanceData[offset + 7] = bb.rotation || 0.0;

    const pixelOffset = bb.pixelOffset || Cartesian2.ZERO;
    const alignedAxis = bb._alignedAxis;
    instanceData[offset + 8] = pixelOffset.x;
    instanceData[offset + 9] = pixelOffset.y;
    instanceData[offset + 10] = alignedAxis ? alignedAxis.x : 0.0;
    instanceData[offset + 11] = alignedAxis ? alignedAxis.y : 0.0;

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

    // @location(4): pick color instead of display color
    if (!defined(bb._pickId)) {
      bb._pickId = context.createPickId(bb, "billboard");
    }
    const pc = bb._pickId.color;
    instanceData[offset + 16] = pc.red;
    instanceData[offset + 17] = pc.green;
    instanceData[offset + 18] = pc.blue;
    instanceData[offset + 19] = pc.alpha;

    instanceData[offset + 20] = 1.0;
    instanceData[offset + 21] = bb.sizeInMeters ? 1.0 : 0.0;
    instanceData[offset + 22] = bb.width || 32.0;
    instanceData[offset + 23] = bb.height || 32.0;

    visibleCount++;
  }

  return { instanceData, visibleCount };
}

const INSTANCE_BUFFER_LAYOUT = {
  arrayStride: BYTES_PER_INSTANCE,
  stepMode: "instance",
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x4" },
    { shaderLocation: 1, offset: 16, format: "float32x4" },
    { shaderLocation: 2, offset: 32, format: "float32x4" },
    { shaderLocation: 3, offset: 48, format: "float32x4" },
    { shaderLocation: 4, offset: 64, format: "float32x4" },
    { shaderLocation: 5, offset: 80, format: "float32x4" },
  ],
};

function createBillboardPipeline(device, shaderCode, format, depthFormat) {
  const shaderModule = device.createShaderModule({
    label: "Billboard shader",
    code: shaderCode,
  });

  const bindGroupLayout = makeBindGroupLayout(
    device,
    "Billboard bind group layout",
    [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT),
      texture(1, Stage.FRAGMENT),
      sampler(2, Stage.FRAGMENT),
    ],
  );

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  const pipeline = device.createRenderPipeline({
    label: "Billboard pipeline",
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [INSTANCE_BUFFER_LAYOUT],
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
 * Creates a pick pipeline — no blending, depth write enabled, uses atlas
 * texture for alpha discard but outputs pick color.
 * @private
 */
function createBillboardPickPipeline(
  device,
  shaderCode,
  format,
  depthFormat,
  bindGroupLayout,
) {
  const shaderModule = device.createShaderModule({
    label: "Billboard pick shader",
    code: shaderCode,
  });

  const pipeline = device.createRenderPipeline({
    label: "Billboard pick pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    }),
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [INSTANCE_BUFFER_LAYOUT],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  });

  return pipeline;
}

function packUniforms(uniformData, frameState, modelMatrix) {
  const context = frameState.context;
  const uniformState = context.uniformState;
  const canvas = context.canvas;

  // Use uniformState.view/projection for 2D/Columbus View support
  Matrix4.multiply(uniformState.view, modelMatrix, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(uniformState.projection, scratchMVRTE, scratchMVPRTE);
  Matrix4.pack(scratchMVPRTE, uniformData, 0);

  // viewRotation (identity for now — simplified)
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
  uniformData[42] = 1.0; // highResMultiplier
  uniformData[43] = 0.0;
}

/**
 * Creates a placeholder 1x1 white texture for billboards without an atlas.
 * @private
 */
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

/**
 * Updates or creates WebGPU draw commands for BillboardCollection.
 * @param {BillboardCollection} collection
 * @param {FrameState} frameState
 * @param {Array} commandList
 */
async function updateWebGPUBillboards(collection, frameState, commandList) {
  const context = frameState.context;
  const device = context.device;
  const length = collection.length;
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
    const result = createBillboardPipeline(
      device,
      shaderCode,
      format,
      depthFmt,
    );
    cache.pipeline = result.pipeline;
    cache.bindGroupLayout = result.bindGroupLayout;
  }

  // Uniform buffer (once)
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      "Billboard uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
  }

  // Update uniforms
  const modelMatrix = collection.modelMatrix || Matrix4.IDENTITY;
  packUniforms(cache.uniformData, frameState, modelMatrix);
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  // Atlas texture. Two independent paths:
  //   1. Collection has a real `textureAtlas` with a populated GPU texture \u2014
  //      use the real view keyed by the atlas's `guid`. When the guid changes
  //      (new image added, atlas resized) drop the bind group so a new one
  //      binds the rotated texture view.
  //   2. Atlas not yet ready \u2014 bind a 1x1 white placeholder so the pipeline
  //      has a valid texture to sample. Any later frame with a ready atlas
  //      will swap in the real view via the path above.
  const atlas = collection._textureAtlas;
  const atlasTex = atlas?.texture;
  const atlasGpuTex = atlasTex?._texture?._webgpuTexture;
  const atlasGuid = atlas?.guid;

  if (defined(atlasGpuTex) && cache.atlasGuid !== atlasGuid) {
    // Real atlas is ready (or updated). Bind its view; drop any cached bind
    // group so it gets rebuilt with the new resource.
    cache.atlasTextureView = atlasGpuTex.view;
    cache.sampler = atlasGpuTex.sampler;
    cache.atlasGuid = atlasGuid;
    cache.bindGroup = undefined;
    // The placeholder (if we previously allocated one) is no longer needed.
    if (defined(cache.atlasPlaceholder)) {
      cache.atlasPlaceholder.destroy();
      cache.atlasPlaceholder = undefined;
    }
  } else if (!defined(cache.atlasTextureView)) {
    // Still waiting on the atlas; bind a placeholder so the pipeline is valid.
    cache.atlasPlaceholder = createPlaceholderTexture(device);
    cache.atlasTextureView = cache.atlasPlaceholder.createView();
    cache.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
    });
  }

  // Bind group \u2014 (re)created when the atlas view rotates.
  if (!defined(cache.bindGroup)) {
    cache.bindGroup = device.createBindGroup({
      layout: cache.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
        { binding: 1, resource: cache.atlasTextureView },
        { binding: 2, resource: cache.sampler },
      ],
    });
  }

  // Instance buffer
  const { instanceData, visibleCount } = buildInstanceData(collection);
  if (visibleCount === 0) {
    return;
  }

  const requiredSize = visibleCount * BYTES_PER_INSTANCE;
  if (
    !defined(cache.instanceBuffer) ||
    cache.instanceBuffer.size < requiredSize
  ) {
    if (defined(cache.instanceBuffer)) {
      cache.instanceBuffer.destroy();
    }
    cache.instanceBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      requiredSize,
      true,
      "Billboard instances",
    );
  }
  device.queue.writeBuffer(
    cache.instanceBuffer.buffer,
    0,
    instanceData.buffer,
    0,
    requiredSize,
  );

  // Pick the command pass from the collection's blendOption so translucent
  // billboards composite in the back-to-front translucent pass rather than
  // painting on top of opaque geometry in unsorted order. BlendOption is:
  //   OPAQUE = 0, TRANSLUCENT = 1, OPAQUE_AND_TRANSLUCENT = 2
  // For OPAQUE_AND_TRANSLUCENT we emit the command in the TRANSLUCENT pass
  // since billboard shaders use straight alpha blending; truly opaque glyphs
  // still composite correctly in the translucent pass. A future refinement
  // would emit two commands (one per pass) when the collection is mixed.
  const blendOpt = collection._blendOption;
  const billboardPass =
    blendOpt === 0 ? 8 /* Pass.OPAQUE */ : 9; /* Pass.TRANSLUCENT */

  cache.colorCommand = new WebGPUDrawCommand({
    pipeline: cache.pipeline,
    bindGroups: [cache.bindGroup],
    vertexBuffers: [cache.instanceBuffer],
    vertexCount: VERTICES_PER_QUAD,
    instanceCount: visibleCount,
    pass: billboardPass,
    owner: collection,
    boundingVolume: collection._boundingVolume,
    modelMatrix: modelMatrix,
    cull: true,
  });

  // Pick pass handling
  if (frameState.passes.pick) {
    _pushBillboardPickCommand(
      collection,
      context,
      device,
      cache,
      modelMatrix,
      visibleCount,
      commandList,
    );
  }

  // Push color command for render passes
  if (frameState.passes.render) {
    commandList.push(cache.colorCommand);
  }
}

/**
 * Builds and pushes a billboard pick draw command. Reuses the same
 * bind group layout as color (needs atlas for alpha discard).
 * @private
 */
function _pushBillboardPickCommand(
  collection,
  context,
  device,
  cache,
  modelMatrix,
  visibleCount,
  commandList,
) {
  if (!defined(cache.pickPipeline)) {
    const pickShader = getCollectionShaderSource("billboardPick");
    const format = context.presentationFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    cache.pickPipeline = createBillboardPickPipeline(
      device,
      pickShader,
      format,
      depthFmt,
      cache.bindGroupLayout,
    );
  }

  const pickResult = buildPickInstanceData(collection, context);
  if (pickResult.visibleCount === 0) {
    return;
  }

  const pickSize = pickResult.visibleCount * BYTES_PER_INSTANCE;
  if (
    !defined(cache.pickInstanceBuffer) ||
    cache.pickInstanceBuffer.size < pickSize
  ) {
    if (defined(cache.pickInstanceBuffer)) {
      cache.pickInstanceBuffer.destroy();
    }
    cache.pickInstanceBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      pickSize,
      true,
      "Billboard pick instances",
    );
  }
  device.queue.writeBuffer(
    cache.pickInstanceBuffer.buffer,
    0,
    pickResult.instanceData.buffer,
    0,
    pickSize,
  );

  cache.pickCommand = new WebGPUDrawCommand({
    pipeline: cache.pickPipeline,
    bindGroups: [cache.bindGroup], // Reuse color bind group (same uniforms + atlas)
    vertexBuffers: [cache.pickInstanceBuffer],
    vertexCount: VERTICES_PER_QUAD,
    instanceCount: pickResult.visibleCount,
    pass: 8,
    owner: collection,
    boundingVolume: collection._boundingVolume,
    modelMatrix: modelMatrix,
    cull: true,
  });

  commandList.push(cache.pickCommand);
}

function destroyWebGPUBillboardResources(collection) {
  const cache = collection._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.instanceBuffer)) {
    cache.instanceBuffer.destroy();
  }
  if (defined(cache.pickInstanceBuffer)) {
    cache.pickInstanceBuffer.destroy();
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  // Only destroy the placeholder \u2014 the real atlas texture is owned by the
  // collection's TextureAtlas and will be released by it.
  if (defined(cache.atlasPlaceholder)) {
    cache.atlasPlaceholder.destroy();
  }
  if (defined(cache.atlasTexture)) {
    // Legacy field from before atlas-invalidation landed; destroy if present.
    cache.atlasTexture.destroy();
  }
  collection._webgpuCache = undefined;
}

export { updateWebGPUBillboards, destroyWebGPUBillboardResources };
export default { updateWebGPUBillboards, destroyWebGPUBillboardResources };
