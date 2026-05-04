/**
 * @module WebGPUBillboardRenderer
 *
 * Handles WebGPU rendering of BillboardCollection.
 * Billboards are rendered as instanced screen-aligned quads with texture atlas.
 *
 * Instance data layout (112 bytes per billboard, 7 x vec4):
 *   posHighAndScale(4) + posLowAndRotation(4) + compressedAttr0(4) +
 *   compressedAttr1(4) + color(4) + miscFlags(4) +
 *   perInstanceFlags(4 = disableDepthTestDistance, splitDirection, pad, pad)
 *   = 28 floats
 *
 * The `perInstanceFlags` slot is always present (16-byte alignment +
 * future-proofing for per-instance flags DP-H42/H40 consume). The shader
 * only reads it inside `//>>ifdef DISABLE_DEPTH_DISTANCE` / `//>>ifdef
 * SPLIT_ENABLED` blocks — when both features are off, the attribute is
 * declared-unused and the rasterizer ignores the slot.
 *
 * @private
 */
import Cartesian2 from "../../Core/Cartesian2.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import oneTimeWarning from "../../Core/oneTimeWarning.js";
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
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";

// Per-instance stride now carries a 7th vec4 for the DP-H42/H40 flags.
// Bumping from 24 → 28 floats keeps the stride a multiple of 16 bytes
// (WebGPU requirement for `arrayStride`).
const FLOATS_PER_INSTANCE = 28;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;
const VERTICES_PER_QUAD = 6;
const UNIFORM_BUFFER_SIZE = 256;

const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();
const scratchEncodedPos = new EncodedCartesian3();
const scratchInverseModel = new Matrix4();
const scratchCameraMC = new Cartesian3();

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

    // perInstanceFlags — DP-H42 / DP-H40 / A.14 per-billboard state.
    //   x: disableDepthTestDistance (raw meters; squared in shader)
    //   y: splitDirection (-1 LEFT / 0 NONE / +1 RIGHT)
    //   z: distanceDisplayCondition.near^2 (squared meters; 0 if unset)
    //   w: distanceDisplayCondition.far^2 (squared meters; +Inf if unset)
    const d = bb._disableDepthTestDistance;
    instanceData[offset + 24] = typeof d === "number" && isFinite(d) ? d : 0.0;
    instanceData[offset + 25] = bb._splitDirection ?? 0.0;
    // AUDIT_2026_05_02 A.14 (Batch 135) — pack the squared near/far
    // distance display window. WGSL gate compares squared eye distance
    // against [near^2, far^2] (no sqrt). Default values match WebGL's
    // `czm_nearFarScalar` semantics: near=0 / far=Infinity → always
    // visible. The renderer also flips DISTANCE_DISPLAY_CONDITION on
    // the pipeline key so the gate's runtime cost is paid only when
    // any billboard in the collection actually sets a window.
    const ddc = bb._distanceDisplayCondition;
    if (ddc) {
      const near = typeof ddc.near === "number" ? ddc.near : 0.0;
      const far =
        typeof ddc.far === "number" ? ddc.far : Number.POSITIVE_INFINITY;
      instanceData[offset + 26] = near * near;
      instanceData[offset + 27] = isFinite(far) ? far * far : Number.MAX_VALUE;
    } else {
      instanceData[offset + 26] = 0.0;
      instanceData[offset + 27] = Number.MAX_VALUE;
    }

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

    // Same perInstanceFlags as the color path — the pick pipeline obeys
    // DP-H42, DP-H40, and A.14 too so the picked region matches what
    // the user sees on screen (a clicked pixel below the camera's
    // DepthDistance threshold should still pick the billboard above
    // terrain; a pixel outside the split-cutoff or distance window
    // should not pick a billboard it can't see).
    const d = bb._disableDepthTestDistance;
    instanceData[offset + 24] = typeof d === "number" && isFinite(d) ? d : 0.0;
    instanceData[offset + 25] = bb._splitDirection ?? 0.0;
    const ddc = bb._distanceDisplayCondition;
    if (ddc) {
      const near = typeof ddc.near === "number" ? ddc.near : 0.0;
      const far =
        typeof ddc.far === "number" ? ddc.far : Number.POSITIVE_INFINITY;
      instanceData[offset + 26] = near * near;
      instanceData[offset + 27] = isFinite(far) ? far * far : Number.MAX_VALUE;
    } else {
      instanceData[offset + 26] = 0.0;
      instanceData[offset + 27] = Number.MAX_VALUE;
    }

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
    // DP-H42 / DP-H40 — perInstanceFlags. Always declared in the layout;
    // the shader only reads it inside the matching `//>>ifdef` blocks.
    { shaderLocation: 6, offset: 96, format: "float32x4" },
  ],
};

function createBillboardBindGroupLayout(device) {
  return makeBindGroupLayout(device, "Billboard bind group layout", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
    texture(1, Stage.FRAGMENT),
    sampler(2, Stage.FRAGMENT),
  ]);
}

/**
 * Build the cache-friendly descriptor for the color (alpha-blended)
 * billboard pipeline. The actual `GPURenderPipeline` is materialized
 * through `webgpuPipelineCache.getPipeline()` so two BillboardCollections
 * with identical (defines, format, depthFormat) share one pipeline.
 *
 * C-R7-RENDERER-MIGRATION (Batch 73).
 * @private
 */
function buildBillboardDescriptor(
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
    name: `Billboard pipeline [${format}/${depthFormat}/defines=0x${defines.toString(16)}]`,
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
  };
}

/**
 * Build the cache-friendly descriptor for the billboard pick pipeline —
 * no blending, depth write enabled, uses atlas texture for alpha discard
 * but outputs pick color. C-R7-RENDERER-MIGRATION (Batch 73).
 * @private
 */
function buildBillboardPickDescriptor(
  device,
  shaderModule,
  format,
  depthFormat,
  bindGroupLayout,
  defines,
) {
  return {
    name: `Billboard pick pipeline [${format}/${depthFormat}/defines=0x${defines.toString(16)}]`,
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
  };
}

/**
 * Convert our cache-friendly descriptor back into the WebGPU descriptor
 * shape for the fallback path (no central cache available).
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
 * Resolve a billboard pipeline (color or pick) through the central
 * pipeline cache. Returns the existing GPU pipeline if cached; otherwise
 * kicks off async creation and returns null so the caller skips the
 * frame. Falls back to direct synchronous creation when `pipelineCache`
 * is null.
 *
 * C-R7-RENDERER-MIGRATION (Batch 73). Mirrors `tryResolvePolylinePipeline`.
 * @private
 */
function tryResolveBillboardPipeline(device, pipelineCache, entry) {
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
          entry.pending = false;
        });
    }
    return null;
  }
  entry.pipeline = device.createRenderPipeline(
    descriptorToGPU(entry.descriptor),
  );
  entry.pending = false;
  return entry.pipeline;
}

// Module-level shader-module cache keyed by GPUDevice. Shared across every
// BillboardCollection rendered on a given device so we don't recompile
// the same (source, defines) tuple for each collection. Weak so a lost
// device is GC'd along with its modules.
const _shaderModuleCaches = new WeakMap();

function getShaderModuleCache(device) {
  let cache = _shaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _shaderModuleCaches.set(device, cache);
  }
  return cache;
}

/**
 * Prewarm the most-likely define sets on first use per device. Called
 * lazily from `updateWebGPUBillboards` the first time a collection renders
 * so we don't pay for WebGPU device access at module load. Compiling the
 * four common variants (none / DDD only / split only / both) up front
 * moves the shader compile off the render path for any scene that uses
 * these features.
 * @private
 */
function prewarmBillboardShaders(device, colorSource, pickSource) {
  const cache = getShaderModuleCache(device);
  if (cache._billboardPrewarmed) {
    return;
  }
  const D = ShaderDefine;
  // AUDIT_2026_05_02 A.14 (Batch 135) — added DISTANCE_DISPLAY_CONDITION
  // variants to the prewarm set. Most production scenes that use KML /
  // GeoJSON entities also set distance windows, so warming the gated
  // variant on first frame avoids a stutter when the user interacts
  // with the entity afterwards.
  const D_PROD =
    D.DISABLE_DEPTH_DISTANCE | D.SPLIT_ENABLED | D.DISTANCE_DISPLAY_CONDITION;
  const defineSets = [
    0,
    D.DISABLE_DEPTH_DISTANCE,
    D.SPLIT_ENABLED,
    D.DISTANCE_DISPLAY_CONDITION,
    D.DISABLE_DEPTH_DISTANCE | D.SPLIT_ENABLED,
    D.DISABLE_DEPTH_DISTANCE | D.DISTANCE_DISPLAY_CONDITION,
    D.SPLIT_ENABLED | D.DISTANCE_DISPLAY_CONDITION,
    D_PROD,
  ];
  cache.prewarm(
    ShaderSourceId.BILLBOARD_COLLECTION,
    colorSource,
    defineSets,
    "Billboard shader",
  );
  if (defined(pickSource)) {
    cache.prewarm(
      ShaderSourceId.BILLBOARD_COLLECTION_PICK,
      pickSource,
      defineSets,
      "Billboard pick shader",
    );
  }
  cache._billboardPrewarmed = true;
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

  // RTE encoding MUST be done in the same coordinate frame as the
  // per-vertex positions. Billboard instance data encodes positions as
  // `EncodedCartesian3.fromCartesian(worldPos)` in WORLD frame, so the
  // camera must also be encoded in world frame — BUT the mvpRTE above
  // uses `view * modelMatrix` with translation zeroed, which implicitly
  // treats vertex input as MODEL-space. When modelMatrix ≠ identity
  // (any entity cluster with a local frame, any BillboardCollection
  // whose `modelMatrix` is set), the two frames disagree and the RTE
  // cancellation fails at Earth scale — billboards drift by thousands
  // of metres.
  //
  // Fix: encode the camera in the same frame the positions live in.
  // `modelMatrix` is typically identity for billboard collections, in
  // which case `inverse(modelMatrix) * positionWC === positionWC` and
  // this is a no-op; when it's set, we get the correct local-frame
  // camera.
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
  uniformData[42] = 1.0; // highResMultiplier
  uniformData[43] = 0.0;

  // DP-H42 — frame-wide minimum disable-depth-test distance in meters.
  // `frameState.minimumDisableDepthTestDistance` is populated by Scene.js
  // each frame from the `Scene.minimumDisableDepthTestDistance` setter.
  uniformData[44] =
    typeof frameState?.minimumDisableDepthTestDistance === "number"
      ? frameState.minimumDisableDepthTestDistance
      : 0.0;

  // DP-H40 — split cutoff in framebuffer pixels. WebGL keeps this in
  // pixel space as `czm_splitPosition`, which is
  // `frameState.splitPosition * drawingBufferWidth`. Mirror that here so
  // the fragment-stage compare sits in the same coord system as
  // `position.x` (which WebGPU defines as framebuffer pixels).
  const splitFraction =
    typeof frameState?.splitPosition === "number"
      ? frameState.splitPosition
      : 0.0;
  const drawingBufferWidth = context?.drawingBufferWidth ?? canvas.width ?? 0.0;
  uniformData[45] = splitFraction * drawingBufferWidth;
  uniformData[46] = 0.0;
  uniformData[47] = 0.0;

  // DP-H41 (Batch 27) — previousViewProjection at slots 48..63 (16 floats,
  // 64 bytes). Fits in the existing 256-byte uniform buffer — no resize.
  // `UniformState.update()` caches last frame's viewProjection, so on frame
  // N this slot holds frame N-1. TAA / motion-vector shaders read it via
  // `camera.previousViewProjection`.
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

/**
 * Scan the collection for the defines a billboard's active state requires.
 * Called once per frame before shader module / pipeline lookup; keeps the
 * cost to one pass over the billboards. We flag `DISABLE_DEPTH_DISTANCE`
 * if ANY billboard has a per-instance override OR the frame-wide minimum
 * is non-zero, and `SPLIT_ENABLED` if ANY billboard's `_splitDirection`
 * is non-zero.
 *
 * Returning zero on both flags lets the baseline (no-features) pipeline
 * stay the fast path — existing scenes pay no new shader cost.
 * @private
 */
function computeDefinesForFrame(collection, frameState) {
  let defines = 0;
  const frameMin =
    typeof frameState?.minimumDisableDepthTestDistance === "number"
      ? frameState.minimumDisableDepthTestDistance
      : 0.0;
  if (frameMin !== 0.0) {
    defines |= ShaderDefine.DISABLE_DEPTH_DISTANCE;
  }
  const billboards = collection._billboards;
  const length = collection.length;
  // Short-circuit the scan once all three flags are set.
  const all =
    ShaderDefine.DISABLE_DEPTH_DISTANCE |
    ShaderDefine.SPLIT_ENABLED |
    ShaderDefine.DISTANCE_DISPLAY_CONDITION;
  for (let i = 0; i < length; i++) {
    if ((defines & all) === all) {
      break;
    }
    const bb = billboards[i];
    if (!defined(bb) || !bb.show || bb._clusterShow === false) {
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
    // AUDIT_2026_05_02 A.14 (Batch 135) — DISTANCE_DISPLAY_CONDITION
    // gate. Flip the bit so the baseline pipeline stays the fast
    // path; collections that never set a window pay zero shader cost
    // for the gate.
    if (
      (defines & ShaderDefine.DISTANCE_DISPLAY_CONDITION) === 0 &&
      defined(bb._distanceDisplayCondition)
    ) {
      defines |= ShaderDefine.DISTANCE_DISPLAY_CONDITION;
    }
  }
  return defines;
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

  // AUDIT_2026_05_02 A.14 — `distanceDisplayCondition` is now wired
  // (Batch 135) via the DISTANCE_DISPLAY_CONDITION shader define +
  // `perInstanceFlags.zw` near^2/far^2 packing. The remaining three
  // gates — `translucencyByDistance`, `pixelOffsetScaleByDistance`,
  // and `scaleByDistance` — still silently no-op on WebGPU. Each
  // would slot into `perInstanceFlags` (or a new vec4) using the
  // same nearFarScalar pattern; tracked as
  // NEW-COLLECTIONS-DISTANCE-ATTRIBS in DEFERRED_WORK.
  //>>includeStart('debug', pragmas.debug);
  for (let i = 0; i < length; i++) {
    const bb = collection.get(i);
    if (
      defined(bb.translucencyByDistance) ||
      defined(bb.pixelOffsetScaleByDistance) ||
      defined(bb.scaleByDistance)
    ) {
      oneTimeWarning(
        "WebGPUBillboard.distanceAttribs",
        "BillboardCollection on WebGPU now honors " +
          "`distanceDisplayCondition` (Batch 135) but does not yet " +
          "honor `translucencyByDistance` / `pixelOffsetScaleByDistance` / " +
          "`scaleByDistance`. The billboard renders/scales as if those " +
          "are unset. Track NEW-COLLECTIONS-DISTANCE-ATTRIBS.",
      );
      break;
    }
  }
  //>>includeEnd('debug');

  // Shader source + prewarm (once per device; `prewarmBillboardShaders`
  // is idempotent so repeated collections on the same device no-op).
  const shaderCode = await getShaderSource();
  const pickShaderCode = getCollectionShaderSource("billboardPick");
  prewarmBillboardShaders(device, shaderCode, pickShaderCode);

  // Bind-group layout is shared across every (defines-set) pipeline —
  // only the pipeline + shader module vary per define set.
  if (!defined(cache.bindGroupLayout)) {
    cache.bindGroupLayout = createBillboardBindGroupLayout(device);
  }

  // DP-H42 / DP-H40 — pick the right shader module + pipeline for the
  // current frame's billboard state. Unchanged billboard collections
  // settle to the same `defines` value every frame, so the map lookup
  // is the hot path and pipeline resolution only fires on the first
  // frame that exercises a new combination.
  // C-R7-RENDERER-MIGRATION (Batch 73) — local Map now holds entry slots
  // `{ descriptor, pipeline, pending }`; the GPU pipeline is materialized
  // through the central `webgpuPipelineCache` so two BillboardCollections
  // with identical render-target shape + defines share one pipeline.
  const defines = computeDefinesForFrame(collection, frameState);
  if (!defined(cache.pipelineEntries)) {
    cache.pipelineEntries = new Map();
    cache.pickPipelineEntries = new Map();
  }
  // Batch 110 — invalidate cached pipeline entries on scene format
  // change (HDR toggle).
  const sceneGen = context._scenePipelineFormatGeneration ?? 0;
  if (cache._pipelineFormatGeneration !== sceneGen) {
    cache.pipelineEntries.clear();
    cache.pickPipelineEntries?.clear();
    cache._pipelineFormatGeneration = sceneGen;
  }
  let entry = cache.pipelineEntries.get(defines);
  if (!defined(entry)) {
    const format = context.scenePipelineFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const moduleCache = getShaderModuleCache(device);
    const shaderModule = moduleCache.getOrCreate(
      ShaderSourceId.BILLBOARD_COLLECTION,
      shaderCode,
      defines,
      "Billboard shader",
    );
    const descriptor = buildBillboardDescriptor(
      device,
      shaderModule,
      format,
      depthFmt,
      cache.bindGroupLayout,
      defines,
    );
    entry = { descriptor, pipeline: null, pending: false };
    cache.pipelineEntries.set(defines, entry);
  }
  const pipeline = tryResolveBillboardPipeline(
    device,
    context.webgpuPipelineCache ?? null,
    entry,
  );
  if (!pipeline) {
    return;
  }
  cache.pipeline = pipeline;
  cache.currentDefines = defines;

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

  // C-R1-COLLECTIONS-PER-ENCODER (Batch 39) — forward the source
  // JS-side renderState from BillboardCollection (`_rsOpaque` /
  // `_rsTranslucent`) so `applyPerEncoderState` drives the dynamic
  // WebGPU pass state (stencil ref, blend constant, scissor,
  // viewport) from the same values the WebGL path uses. Without this
  // the command ran with whatever the encoder's default was for the
  // current pass, producing subtle stencil/blend drift relative to
  // WebGL. The `pass: OPAQUE` emit uses `_rsOpaque`; every other
  // emit (TRANSLUCENT or OPAQUE_AND_TRANSLUCENT) uses `_rsTranslucent`.
  const colorRenderState =
    billboardPass === 8 /* Pass.OPAQUE */
      ? collection._rsOpaque
      : collection._rsTranslucent;

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
    renderState: colorRenderState,
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
  // DP-H42 / DP-H40 — pick pipeline uses the same defines as the color
  // pipeline for this frame so the pick region exactly matches the
  // rendered region. Falls back to the baseline (0) when the color path
  // hasn't set currentDefines yet (first-ever frame).
  // C-R7-RENDERER-MIGRATION (Batch 73) — entry-based caching via
  // `cache.pickPipelineEntries`; pipeline resolves through the central
  // pipeline cache. Skip the pick command if the pipeline is still
  // materializing (a frame later it'll be ready).
  const pickDefines = cache.currentDefines ?? 0;
  if (!defined(cache.pickPipelineEntries)) {
    cache.pickPipelineEntries = new Map();
  }
  let pickEntry = cache.pickPipelineEntries.get(pickDefines);
  if (!defined(pickEntry)) {
    const pickShader = getCollectionShaderSource("billboardPick");
    const format = context.scenePipelineFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const moduleCache = getShaderModuleCache(device);
    // Pick shader has its own source ID so its cache entries stay
    // distinct from the color pipeline's at the same defines.
    const pickModule = moduleCache.getOrCreate(
      ShaderSourceId.BILLBOARD_COLLECTION_PICK,
      pickShader,
      pickDefines,
      "Billboard pick shader",
    );
    const descriptor = buildBillboardPickDescriptor(
      device,
      pickModule,
      format,
      depthFmt,
      cache.bindGroupLayout,
      pickDefines,
    );
    pickEntry = { descriptor, pipeline: null, pending: false };
    cache.pickPipelineEntries.set(pickDefines, pickEntry);
  }
  const pickPipeline = tryResolveBillboardPipeline(
    device,
    context.webgpuPipelineCache ?? null,
    pickEntry,
  );
  if (!pickPipeline) {
    return;
  }
  cache.pickPipeline = pickPipeline;

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

  // Pick always runs in the OPAQUE pass — use `_rsOpaque` so the pick
  // FBO sees the same depth behavior as the color opaque path. When
  // the collection is TRANSLUCENT-only `_rsOpaque` is undefined, and
  // the command falls back to encoder defaults (pick commands don't
  // blend, so that's safe).
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
    renderState: collection._rsOpaque ?? collection._rsTranslucent,
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
