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
import Cartesian3 from "../../Core/Cartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import SDFSettings from "../../Scene/SDFSettings.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import FeatureRendererKey from "../FeatureRendererKey.js";

// Import SDF shader source
import BillboardCollectionSDFWGSL from "../../Shaders/WebGPU/Collections/BillboardCollectionSDF.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";

const SDF_EDGE = 1.0 - SDFSettings.CUTOFF; // 0.75

// SDF instance data: 36 floats (144 bytes) — standard 24 floats + 8 for
// outline/SDF + 4 for perInstanceFlags (DP-H42 / DP-H40, Batch 21).
const FLOATS_PER_SDF_INSTANCE = 36;
const BYTES_PER_SDF_INSTANCE = FLOATS_PER_SDF_INSTANCE * 4;
const VERTICES_PER_QUAD = 6;
const UNIFORM_BUFFER_SIZE = 256;

const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();
const scratchInverseModel = new Matrix4();
const scratchCameraMC = new Cartesian3();
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
    // DP-H42 / DP-H40 — perInstanceFlags. Same contract as Billboard's
    // @location(6): x=disableDepthTestDistance, y=splitDirection, zw=pad.
    { shaderLocation: 8, offset: 128, format: "float32x4" },
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

    // DP-H42 / DP-H40 — perInstanceFlags. Labels inherit the
    // `disableDepthTestDistance` and `splitDirection` from the parent
    // Label; the glyph billboards have these fields propagated from the
    // label via `Label._rebindAllGlyphs` → glyph.disableDepthTestDistance,
    // glyph.splitDirection, so reading from the billboard object is
    // equivalent to reading the parent label's property.
    const d = bb._disableDepthTestDistance;
    instanceData[offset + 32] = typeof d === "number" && isFinite(d) ? d : 0.0;
    instanceData[offset + 33] = bb._splitDirection ?? 0.0;
    instanceData[offset + 34] = 0.0;
    instanceData[offset + 35] = 0.0;

    visibleCount++;
  }

  return { instanceData, visibleCount };
}

/**
 * Walk the glyph collection and compute the active defines for this
 * frame. Mirrors BillboardCollection's defines path — any glyph with a
 * per-instance override or a non-zero split direction activates the
 * matching feature. When all labels are default the baseline (0)
 * pipeline stays the hot path.
 * @private
 */
function computeLabelDefinesForFrame(glyphCollection, frameState) {
  let defines = 0;
  const frameMin =
    typeof frameState?.minimumDisableDepthTestDistance === "number"
      ? frameState.minimumDisableDepthTestDistance
      : 0.0;
  if (frameMin !== 0.0) {
    defines |= ShaderDefine.DISABLE_DEPTH_DISTANCE;
  }
  const billboards = glyphCollection._billboards;
  const length = glyphCollection.length;
  const both = ShaderDefine.DISABLE_DEPTH_DISTANCE | ShaderDefine.SPLIT_ENABLED;
  for (let i = 0; i < length; i++) {
    if ((defines & both) === both) {
      break;
    }
    const bb = billboards[i];
    if (!defined(bb) || !bb.show) {
      continue;
    }
    if (
      (defines & ShaderDefine.DISABLE_DEPTH_DISTANCE) === 0 &&
      typeof bb._disableDepthTestDistance === "number" &&
      bb._disableDepthTestDistance !== 0.0
    ) {
      defines |= ShaderDefine.DISABLE_DEPTH_DISTANCE;
    }
    if (
      (defines & ShaderDefine.SPLIT_ENABLED) === 0 &&
      bb._splitDirection !== undefined &&
      bb._splitDirection !== 0.0
    ) {
      defines |= ShaderDefine.SPLIT_ENABLED;
    }
  }
  return defines;
}

// Module-level shader-module cache keyed by GPUDevice (same pattern as
// WebGPUBillboardRenderer). Shared across every LabelCollection.
const _sdfShaderModuleCaches = new WeakMap();

function getSDFShaderModuleCache(device) {
  let cache = _sdfShaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _sdfShaderModuleCaches.set(device, cache);
  }
  return cache;
}

/**
 * Prewarm the SDF shader module for every define set the first 30
 * frames are likely to touch. Idempotent per device.
 * @private
 */
function prewarmLabelShaders(device) {
  const cache = getSDFShaderModuleCache(device);
  if (cache._labelPrewarmed) {
    return;
  }
  const D = ShaderDefine;
  cache.prewarm(
    ShaderSourceId.BILLBOARD_COLLECTION_SDF,
    BillboardCollectionSDFWGSL,
    [
      0,
      D.DISABLE_DEPTH_DISTANCE,
      D.SPLIT_ENABLED,
      D.DISABLE_DEPTH_DISTANCE | D.SPLIT_ENABLED,
    ],
    "Label SDF shader",
  );
  cache._labelPrewarmed = true;
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

  // Encode camera in model frame to match per-vertex RTE encoding (C-P5).
  Matrix4.inverse(modelMatrix, scratchInverseModel);
  Matrix4.multiplyByPoint(
    scratchInverseModel,
    frameState.camera.positionWC,
    scratchCameraMC,
  );
  EncodedCartesian3.fromCartesian(scratchCameraMC, scratchEncodedCamera);
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

  // DP-H42 — frame-wide fallback threshold (meters).
  uniformData[44] =
    typeof frameState?.minimumDisableDepthTestDistance === "number"
      ? frameState.minimumDisableDepthTestDistance
      : 0.0;
  // DP-H40 — split cutoff in framebuffer pixels.
  const splitFraction =
    typeof frameState?.splitPosition === "number"
      ? frameState.splitPosition
      : 0.0;
  const drawingBufferWidth = context?.drawingBufferWidth ?? canvas.width ?? 0.0;
  uniformData[45] = splitFraction * drawingBufferWidth;
  uniformData[46] = 0.0;
  uniformData[47] = 0.0;

  // DP-H41 (Batch 27) — previousViewProjection at slots 48..63 (16 floats,
  // 64 bytes). Fits in the existing 256-byte buffer — no resize.
  // `UniformState.update()` caches last frame's viewProjection for TAA.
  const prevVP = uniformState.previousViewProjection;
  if (prevVP) {
    Matrix4.pack(prevVP, uniformData, 48);
  } else {
    uniformData[48] = 1;
    uniformData[49] = 0;
    uniformData[50] = 0;
    uniformData[51] = 0;
    uniformData[52] = 0;
    uniformData[53] = 1;
    uniformData[54] = 0;
    uniformData[55] = 0;
    uniformData[56] = 0;
    uniformData[57] = 0;
    uniformData[58] = 1;
    uniformData[59] = 0;
    uniformData[60] = 0;
    uniformData[61] = 0;
    uniformData[62] = 0;
    uniformData[63] = 1;
  }
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

function createSDFBindGroupLayout(device) {
  return makeBindGroupLayout(device, "Label SDF bind group layout", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
    texture(1, Stage.FRAGMENT),
    sampler(2, Stage.FRAGMENT),
  ]);
}

/**
 * Build the cache-friendly `WebGPURenderPipelineDescriptor` for a given
 * (defines, format, depthFormat) tuple. The actual `GPURenderPipeline`
 * is materialized through `webgpuPipelineCache.getPipeline()` so two
 * LabelCollections with identical render-target shape + defines share
 * one pipeline.
 *
 * C-R7-RENDERER-MIGRATION (Batch 73).
 * @private
 */
function buildSDFDescriptor(
  device,
  shaderModule,
  format,
  depthFormat,
  bindGroupLayout,
  defines,
) {
  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  return {
    name: `Label SDF pipeline [${format}/${depthFormat}/defines=0x${defines.toString(16)}]`,
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
  };
}

/**
 * Convert our cache-friendly descriptor back into the WebGPU descriptor
 * shape for the fallback path (no central cache available — typically a
 * WebGL-backed graphics context). Mirrors the helper in Polyline / Cloud /
 * Voxel migrations.
 * @private
 */
function descriptorToGPU(d) {
  return {
    label: d.name,
    layout: d.layout ?? "auto",
    vertex: {
      module: d.vertex.module,
      entryPoint: d.vertex.entryPoint,
      buffers: d.vertex.buffers,
    },
    fragment: d.fragment
      ? {
          module: d.fragment.module,
          entryPoint: d.fragment.entryPoint,
          targets: d.fragment.targets,
        }
      : undefined,
    primitive: d.primitive,
    depthStencil: d.depthStencil,
    multisample: d.multisample,
  };
}

/**
 * Resolve the SDF pipeline through the central pipeline cache. Returns
 * the existing GPU pipeline if cached; otherwise kicks off async creation
 * and returns null so the caller skips the frame.
 *
 * C-R7-RENDERER-MIGRATION (Batch 73). Mirrors `tryResolvePolylinePipeline`.
 * @private
 */
function tryResolveLabelSDFPipeline(device, pipelineCache, entry) {
  if (entry.pipeline) {
    return entry.pipeline;
  }
  if (pipelineCache) {
    const sync = pipelineCache.getPipelineSync(entry.descriptor);
    if (sync) {
      entry.pipeline = sync;
      entry.pending = false;
      return sync;
    }
    if (!entry.pending) {
      entry.pending = true;
      pipelineCache
        .getPipeline(entry.descriptor)
        .then((p) => {
          entry.pipeline = p;
          entry.pending = false;
        })
        .catch(() => {
          // Errors already logged by the cache.
          entry.pending = false;
        });
    }
    return null;
  }
  // Fallback — direct synchronous creation matches pre-migration behavior.
  entry.pipeline = device.createRenderPipeline(
    descriptorToGPU(entry.descriptor),
  );
  entry.pending = false;
  return entry.pipeline;
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

  // Prewarm SDF shader module variants (idempotent per device).
  prewarmLabelShaders(device);

  // Shared bind-group layout across every (defines-set) pipeline.
  if (!defined(cache.sdfBindGroupLayout)) {
    cache.sdfBindGroupLayout = createSDFBindGroupLayout(device);
  }

  // DP-H42 / DP-H40 — pick the right SDF pipeline for this frame's
  // glyph state. Pipeline + shader module cache by active defines.
  // C-R7-RENDERER-MIGRATION (Batch 73) — local Map now stores entry slots
  // `{ descriptor, pipeline, pending }`; the GPU pipeline is materialized
  // through the central `webgpuPipelineCache` so two LabelCollections
  // with identical (defines, render-target shape) share one
  // `GPURenderPipeline`.
  const defines = computeLabelDefinesForFrame(glyphCollection, frameState);
  if (!defined(cache.sdfPipelineEntries)) {
    cache.sdfPipelineEntries = new Map();
  }
  let entry = cache.sdfPipelineEntries.get(defines);
  if (!defined(entry)) {
    const format = context.presentationFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const moduleCache = getSDFShaderModuleCache(device);
    const shaderModule = moduleCache.getOrCreate(
      ShaderSourceId.BILLBOARD_COLLECTION_SDF,
      BillboardCollectionSDFWGSL,
      defines,
      "Label SDF shader",
    );
    const descriptor = buildSDFDescriptor(
      device,
      shaderModule,
      format,
      depthFmt,
      cache.sdfBindGroupLayout,
      defines,
    );
    entry = { descriptor, pipeline: null, pending: false };
    cache.sdfPipelineEntries.set(defines, entry);
  }
  const sdfPipeline = tryResolveLabelSDFPipeline(
    device,
    context.webgpuPipelineCache ?? null,
    entry,
  );
  if (!sdfPipeline) {
    // Pipeline still materializing in the central cache; skip this frame.
    return;
  }
  cache.sdfPipeline = sdfPipeline;

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

  // Atlas texture \u2014 use the glyph collection's texture atlas. Re-resolve every
  // frame against the atlas's `guid` so that when the atlas rasterizes new
  // glyphs (or is resized) the bind group picks up the new GPU texture view.
  // Previously the first-frame view (usually the placeholder) was cached
  // forever and labels stayed blank for the lifetime of the collection.
  const atlas = glyphCollection._textureAtlas;
  const atlasGuid = atlas?.guid;

  let atlasTextureView;
  let atlasSampler;
  let atlasSourceTag = "placeholder";

  if (defined(atlas) && defined(atlas._webgpuTexture)) {
    atlasTextureView = atlas._webgpuTexture.view;
    atlasSampler = atlas._webgpuTexture.sampler;
    atlasSourceTag = "glyph-atlas-direct";
  } else if (defined(atlas?.texture)) {
    // CesiumJS Texture wrapping the WebGL stub \u2014 dig down to the real WebGPU
    // resource published by WebGLStubTexture.
    const tex = atlas.texture;
    const stub = tex?._texture?._webgpuTexture || tex?._webgpuTexture;
    if (stub) {
      atlasTextureView = stub.view;
      atlasSampler =
        stub.sampler ||
        cache.defaultSampler ||
        device.createSampler({ minFilter: "linear", magFilter: "linear" });
      atlasSourceTag = "glyph-atlas-stub";
    }
  }

  if (!defined(atlasTextureView)) {
    // Still waiting on the SDF rasterizer; bind the 1x1 placeholder.
    if (!defined(cache.placeholderTexture)) {
      cache.placeholderTexture = createPlaceholderTexture(device);
      cache.placeholderTextureView = cache.placeholderTexture.createView();
      cache.defaultSampler = device.createSampler({
        minFilter: "linear",
        magFilter: "linear",
      });
    }
    atlasTextureView = cache.placeholderTextureView;
    atlasSampler = cache.defaultSampler;
  }

  // Cache the resolved view + guid so callers can detect when the bind group
  // needs rebuilding. We always rebuild below since atlas view may rotate.
  cache.atlasTextureView = atlasTextureView;
  cache.atlasSampler = atlasSampler;
  cache.atlasGuid = atlasGuid;
  cache.atlasSourceTag = atlasSourceTag;

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

  // Create SDF draw command. Labels are alpha-blended via the SDF shader, so
  // they must run in the TRANSLUCENT pass or they'll paint opaque rectangles
  // on top of anything rendered earlier. Match upstream's treatment of labels
  // as translucent geometry unless the collection explicitly asked for OPAQUE.
  const labelBlendOpt = labelCollection?._blendOption;
  const labelPass =
    labelBlendOpt === 0 ? 8 /* Pass.OPAQUE */ : 9; /* Pass.TRANSLUCENT */
  const sdfCommand = new WebGPUDrawCommand({
    pipeline: cache.sdfPipeline,
    bindGroups: [cache.sdfBindGroup],
    vertexBuffers: [cache.sdfInstanceBuffer],
    vertexCount: VERTICES_PER_QUAD,
    instanceCount: visibleCount,
    pass: labelPass,
    owner: labelCollection,
    boundingVolume: glyphCollection._boundingVolume,
    modelMatrix: modelMatrix,
    cull: true,
  });

  if (frameState.passes.render) {
    commandList.push(sdfCommand);
  }

  // Background billboards: route through standard billboard renderer (used
  // for label backgrounds; they're opaque quads the SDF pass doesn't draw).
  // M-R6 (Batch 35) — replaced numeric literal `0` with enum constant
  // per CLAUDE.md's "enumerated keys over string/numeric literal lookups"
  // rule.
  const billboardFR = context.getFeatureRenderer(
    FeatureRendererKey.BILLBOARD_COLLECTION,
  );
  if (backgroundCollection && backgroundCollection.length > 0 && billboardFR) {
    billboardFR.update(backgroundCollection, frameState, commandList);
  }

  // Label pick path: during pick frames, also route the glyph billboards
  // through the standard billboard pipeline so it emits a pick command per
  // glyph with the label's pick color. This produces correct `scene.pick()`
  // hits on visible glyph pixels (the SDF pipeline has no pick variant, so
  // without this `scene.pick()` on any label text returns undefined).
  // The billboard FR's pick command reads `bb._pickId`, which the Label
  // system already populates when it constructs the glyph billboards.
  if (
    frameState.passes.pick &&
    glyphCollection &&
    glyphCollection.length > 0 &&
    billboardFR
  ) {
    billboardFR.update(glyphCollection, frameState, commandList);
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
