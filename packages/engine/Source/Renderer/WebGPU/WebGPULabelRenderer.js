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
// Slice 5c-B Phase 1 (Batch 107) — scene-FB target helper.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";

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

// SDF instance data: 52 floats (208 bytes) — standard 24 floats + 8 for
// outline/SDF + 4 for perInstanceFlags (DP-H42 / DP-H40 / A.14 DDC) +
// 12 for 3 NearFarScalars (translucencyByDistance,
// pixelOffsetScaleByDistance, scaleByDistance — Batch 137 / Audit A.14)
// + 4 for threePointAttribs (depthOrigin + enableDepthCheck — Batch 138 /
// VS_THREE_POINT_DEPTH_CHECK clamp-to-ground terrain occlusion).
// Was 36 floats (Batch 21); 48 (Batch 137); now 52 (Batch 138).
const FLOATS_PER_SDF_INSTANCE = 52;
const BYTES_PER_SDF_INSTANCE = FLOATS_PER_SDF_INSTANCE * 4;
const VERTICES_PER_QUAD = 6;
const UNIFORM_BUFFER_SIZE = 256;

/**
 * Batch 139 (3rd-pass audit fix) — see WebGPUBillboardRenderer for
 * the full comment block. Mirrors WebGL's
 * `BillboardCollection.js:1798-1799` Infinity → -1 sentinel encode so
 * the WGSL shader's `< 0` "always disable" branch fires correctly.
 */
function encodeDisableDepthTestDistance(value) {
  if (typeof value !== "number") {
    return 0.0;
  }
  if (value === Number.POSITIVE_INFINITY) {
    return -1.0;
  }
  if (isFinite(value) && value > 0.0) {
    return value;
  }
  return 0.0;
}

/**
 * AUDIT_2026_05_02 A.14 (Batch 137) — pack a CesiumJS NearFarScalar
 * into 4 contiguous floats, mirroring `WebGPUBillboardRenderer.packNearFarScalar`.
 * Identity-NFS written when `scalar` is undefined so the WGSL gate
 * produces the unchanged baseline for labels with no per-distance ramp
 * configured.
 */
function packNearFarScalar(out, offset, scalar, identity) {
  if (scalar) {
    out[offset + 0] = typeof scalar.near === "number" ? scalar.near : 0.0;
    out[offset + 1] =
      typeof scalar.nearValue === "number" ? scalar.nearValue : identity;
    out[offset + 2] = typeof scalar.far === "number" ? scalar.far : 1.0e8;
    out[offset + 3] =
      typeof scalar.farValue === "number" ? scalar.farValue : identity;
  } else {
    out[offset + 0] = 0.0;
    out[offset + 1] = identity;
    out[offset + 2] = 1.0e8;
    out[offset + 3] = identity;
  }
}

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
    // DP-H42 / DP-H40 / A.14 DDC — perInstanceFlags.
    //   x: disableDepthTestDistance, y: splitDirection,
    //   z: ddcNearSq, w: ddcFarSq (Batch 137).
    { shaderLocation: 8, offset: 128, format: "float32x4" },
    // AUDIT_2026_05_02 A.14 (Batch 137) — three NearFarScalars for
    // distance-aware translucency / pixel-offset / scale ramps.
    { shaderLocation: 9, offset: 144, format: "float32x4" }, // translucencyByDistance
    { shaderLocation: 10, offset: 160, format: "float32x4" }, // pixelOffsetScaleByDistance
    { shaderLocation: 11, offset: 176, format: "float32x4" }, // scaleByDistance
    // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — depthOrigin + enable.
    { shaderLocation: 12, offset: 192, format: "float32x4" }, // threePointAttribs
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

    // DP-H42 / DP-H40 / A.14 — perInstanceFlags. Labels inherit
    // `disableDepthTestDistance`, `splitDirection`, and
    // `distanceDisplayCondition` from the parent Label; the glyph
    // billboards have these fields propagated from the label via
    // `Label.set distanceDisplayCondition` → `glyph.billboard.distanceDisplayCondition`.
    //   x: disableDepthTestDistance (raw meters; squared in shader)
    //   y: splitDirection
    //   z: distanceDisplayCondition.near^2 (Batch 137)
    //   w: distanceDisplayCondition.far^2 (Batch 137)
    instanceData[offset + 32] = encodeDisableDepthTestDistance(
      bb._disableDepthTestDistance,
    );
    instanceData[offset + 33] = bb._splitDirection ?? 0.0;
    const ddc = bb._distanceDisplayCondition;
    if (ddc) {
      const ddcNear = typeof ddc.near === "number" ? ddc.near : 0.0;
      const ddcFar =
        typeof ddc.far === "number" ? ddc.far : Number.POSITIVE_INFINITY;
      instanceData[offset + 34] = ddcNear * ddcNear;
      instanceData[offset + 35] = isFinite(ddcFar)
        ? ddcFar * ddcFar
        : Number.MAX_VALUE;
    } else {
      instanceData[offset + 34] = 0.0;
      instanceData[offset + 35] = Number.MAX_VALUE;
    }

    // AUDIT_2026_05_02 A.14 (Batch 137) — three NearFarScalar gates
    // packed into vec4 slots 9/10/11. Identity = 1.0 for all (each is
    // multiplicative onto alpha / pixel-offset / scale). The labels
    // propagate their parent's properties to glyph billboards via
    // `Label.set translucencyByDistance` etc., so reading from the
    // billboard's `_translucencyByDistance` etc. gives the right value.
    packNearFarScalar(
      instanceData,
      offset + 36,
      bb._translucencyByDistance,
      1.0,
    );
    packNearFarScalar(
      instanceData,
      offset + 40,
      bb._pixelOffsetScaleByDistance,
      1.0,
    );
    packNearFarScalar(instanceData, offset + 44, bb._scaleByDistance, 1.0);

    // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — threePointAttribs.
    //   .x: depthOrigin.x — Label-only "horizontal anchor for the
    //        depth-check sample point." Label uses HorizontalOrigin
    //        enum: LEFT=-1, CENTER=0, RIGHT=+1. We read from the
    //        underlying glyph billboard's `_horizontalOrigin` (set
    //        by `Label._rebindAllGlyphs`).
    //   .y: depthOrigin.y — VerticalOrigin enum: TOP=-1, CENTER=0,
    //        BOTTOM=+1.
    //   .z: enableDepthCheck — 1.0 default; future hook for the
    //        "label is below ellipsoid" case which WebGL detects via
    //        scene-mode + ellipsoid intersection. For first cut we
    //        always enable; deferred refinement matches WebGL's edge
    //        case.
    //   .w: reserved.
    const horizontalOrigin =
      typeof bb._horizontalOrigin === "number" ? bb._horizontalOrigin : 0;
    const verticalOrigin =
      typeof bb._verticalOrigin === "number" ? bb._verticalOrigin : 0;
    instanceData[offset + 48] = horizontalOrigin;
    instanceData[offset + 49] = verticalOrigin;
    instanceData[offset + 50] = 1.0;
    instanceData[offset + 51] = 0.0;

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
  // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — `_shaderClampToGround`
  // lives on the underlying glyph BillboardCollection (Label
  // delegates clamp-to-ground propagation through the billboard
  // collection it owns).
  if (glyphCollection._shaderClampToGround === true) {
    defines |= ShaderDefine.VS_THREE_POINT_DEPTH_CHECK;
  }
  const billboards = glyphCollection._billboards;
  const length = glyphCollection.length;
  // AUDIT_2026_05_02 A.14 (Batch 137) — labels participate in all 6
  // distance-related defines (Billboard's full set, since labels render
  // through the SDF Billboard variant).
  const all =
    ShaderDefine.DISABLE_DEPTH_DISTANCE |
    ShaderDefine.SPLIT_ENABLED |
    ShaderDefine.DISTANCE_DISPLAY_CONDITION |
    ShaderDefine.EYE_DISTANCE_TRANSLUCENCY |
    ShaderDefine.EYE_DISTANCE_PIXEL_OFFSET |
    ShaderDefine.EYE_DISTANCE_SCALING;
  for (let i = 0; i < length; i++) {
    if ((defines & all) === all) {
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
    // AUDIT_2026_05_02 A.14 (Batch 137) — DDC + 3 NearFarScalar gates.
    if (
      (defines & ShaderDefine.DISTANCE_DISPLAY_CONDITION) === 0 &&
      defined(bb._distanceDisplayCondition)
    ) {
      defines |= ShaderDefine.DISTANCE_DISPLAY_CONDITION;
    }
    if (
      (defines & ShaderDefine.EYE_DISTANCE_TRANSLUCENCY) === 0 &&
      defined(bb._translucencyByDistance)
    ) {
      defines |= ShaderDefine.EYE_DISTANCE_TRANSLUCENCY;
    }
    if (
      (defines & ShaderDefine.EYE_DISTANCE_PIXEL_OFFSET) === 0 &&
      defined(bb._pixelOffsetScaleByDistance)
    ) {
      defines |= ShaderDefine.EYE_DISTANCE_PIXEL_OFFSET;
    }
    if (
      (defines & ShaderDefine.EYE_DISTANCE_SCALING) === 0 &&
      defined(bb._scaleByDistance)
    ) {
      defines |= ShaderDefine.EYE_DISTANCE_SCALING;
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
  // AUDIT_2026_05_02 A.14 (Batch 137) — extend prewarm with the 4
  // new distance gates. Most KML / GeoJSON labels combine DDC +
  // translucency; some additionally use scale-by-distance for
  // zoom-aware UI labels.
  const D_KML = D.DISTANCE_DISPLAY_CONDITION | D.EYE_DISTANCE_TRANSLUCENCY;
  const ALL_DDC_GATES =
    D.DISTANCE_DISPLAY_CONDITION |
    D.EYE_DISTANCE_TRANSLUCENCY |
    D.EYE_DISTANCE_PIXEL_OFFSET |
    D.EYE_DISTANCE_SCALING;
  const D_PROD = D.DISABLE_DEPTH_DISTANCE | D.SPLIT_ENABLED | ALL_DDC_GATES;
  cache.prewarm(
    ShaderSourceId.BILLBOARD_COLLECTION_SDF,
    BillboardCollectionSDFWGSL,
    [
      0,
      D.DISABLE_DEPTH_DISTANCE,
      D.SPLIT_ENABLED,
      D.DISTANCE_DISPLAY_CONDITION,
      D.EYE_DISTANCE_TRANSLUCENCY,
      D.DISABLE_DEPTH_DISTANCE | D.SPLIT_ENABLED,
      D_KML,
      ALL_DDC_GATES,
      D_PROD,
      // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — clamp-to-ground
      // labels are very common (KML/GeoJSON) so warm the
      // 3-point-only and 3-point + KML combos.
      D.VS_THREE_POINT_DEPTH_CHECK,
      D.VS_THREE_POINT_DEPTH_CHECK | D_KML,
      D_PROD | D.VS_THREE_POINT_DEPTH_CHECK,
    ],
    "Label SDF shader",
  );
  cache._labelPrewarmed = true;
}

function packUniforms(uniformData, frameState, modelMatrix, labelCollection) {
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
  // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — pull threePointDepthTestDistance
  // from the parent LabelCollection's underlying glyph BillboardCollection.
  // Labels delegate to BillboardCollection internally, so the value
  // lives on the glyph collection.
  let threePointDist = 0.0;
  const glyphCollection = labelCollection?._glyphBillboardCollection;
  if (typeof glyphCollection?._threePointDepthTestDistance === "number") {
    threePointDist = glyphCollection._threePointDepthTestDistance;
  }
  uniformData[43] = threePointDist;

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
    // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — globe depth (packed-rgba)
    // + sampler. VS-only visibility; placeholder bound when the
    // feature is off so the BGL is canonical across all ifdef
    // variants.
    texture(3, Stage.VERTEX),
    sampler(4, Stage.VERTEX),
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
  sampleCount,
) {
  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  return {
    name: `Label SDF pipeline [${format}/${depthFormat}/defines=0x${defines.toString(16)}/ms=${sampleCount ?? 1}]`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [SDF_INSTANCE_BUFFER_LAYOUT],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      // Slice 5c-B Phase 1 (Batch 107) — scene-FB target. Standard
      // alpha-over blend matches the helper's `translucent: true`
      // default exactly (src-alpha / one-minus-src-alpha with explicit
      // `operation: "add"`), so we use the shorthand.
      targets: makeSceneFBTargets(format, { translucent: true }),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    // Batch 134 — match scene-FB MSAA sample count (see WebGPUBillboardRenderer for rationale).
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  };
}

/**
 * AUDIT_2026_05_02 B.10 (Batch 144, NEW-COLLECTIONS-MOTION-VECTORS) —
 * second VB layout for the velocity pipeline. Same per-instance stride
 * as the SDF instance buffer (the renderer keeps a one-frame-lagged
 * mirror of the same data); the velocity VS only reads positions via
 * locations 13 (high) + 14 (low), the next free slots after the SDF
 * VS's existing 0-12 attribute set.
 * @private
 */
const VELOCITY_PREV_INSTANCE_BUFFER_LAYOUT = {
  arrayStride: BYTES_PER_SDF_INSTANCE,
  stepMode: "instance",
  attributes: [
    // prevPosHighAndScale at byte 0 — mirrors SDF location 0.
    { shaderLocation: 13, offset: 0, format: "float32x4" },
    // prevPosLowAndRotation at byte 16 — mirrors SDF location 1.
    { shaderLocation: 14, offset: 16, format: "float32x4" },
  ],
};

/**
 * AUDIT_2026_05_02 B.10 (Batch 144, NEW-COLLECTIONS-MOTION-VECTORS) —
 * descriptor for the SDF velocity pipeline variant. Same VS layout /
 * shader module / pipeline layout as the regular SDF pipeline; the
 * fragment entry is `fragmentVelocityMain` and the target format is
 * `rg16float` (the scene-FB velocity texture format). Depth is read-
 * only so fragments behind opaque geometry fail the depth test.
 * Mirrors `WebGPUBillboardRenderer.buildBillboardVelocityDescriptor`.
 * @private
 */
function buildSDFVelocityDescriptor(
  device,
  shaderModule,
  depthFormat,
  bindGroupLayout,
  defines,
) {
  return {
    name: `Label SDF velocity pipeline [${depthFormat}/defines=0x${defines.toString(16)}]`,
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    }),
    vertex: {
      module: shaderModule,
      entryPoint: "vertexVelocityMain",
      buffers: [
        SDF_INSTANCE_BUFFER_LAYOUT,
        VELOCITY_PREV_INSTANCE_BUFFER_LAYOUT,
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentVelocityMain",
      targets: [{ format: "rg16float" }],
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
    // AUDIT_2026_05_02 B.10 (Batch 144) — velocity pipeline cache.
    // Same (defines) keying as the regular pipeline so a label
    // collection's color and velocity pipelines stay in lockstep.
    cache.sdfVelocityPipelineEntries = new Map();
  }
  // Batch 110 — invalidate cached pipeline entries on scene format change.
  const sceneGen = context._scenePipelineFormatGeneration ?? 0;
  if (cache._pipelineFormatGeneration !== sceneGen) {
    cache.sdfPipelineEntries.clear();
    cache.sdfVelocityPipelineEntries?.clear();
    cache._pipelineFormatGeneration = sceneGen;
  }
  let entry = cache.sdfPipelineEntries.get(defines);
  if (!defined(entry)) {
    const format = context.scenePipelineFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const moduleCache = getSDFShaderModuleCache(device);
    const shaderModule = moduleCache.getOrCreate(
      ShaderSourceId.BILLBOARD_COLLECTION_SDF,
      BillboardCollectionSDFWGSL,
      defines,
      "Label SDF shader",
    );
    const sampleCount = context._msaaSamples ?? 1;
    const descriptor = buildSDFDescriptor(
      device,
      shaderModule,
      format,
      depthFmt,
      cache.sdfBindGroupLayout,
      defines,
      sampleCount,
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

  // AUDIT_2026_05_02 B.10 (Batch 144, NEW-COLLECTIONS-MOTION-VECTORS) —
  // resolve the velocity pipeline lazily, gated on TAA being enabled
  // this frame. Static label scenes (TAA off) never construct a
  // velocity pipeline. Reuses the same shader module + bind group
  // layout as the color SDF pipeline.
  let velocityPipeline = null;
  if (frameState.scene?.taaEnabled === true) {
    let velEntry = cache.sdfVelocityPipelineEntries.get(defines);
    if (!defined(velEntry)) {
      const depthFmt2 = context.depthFormat || "depth24plus-stencil8";
      const moduleCache2 = getSDFShaderModuleCache(device);
      const shaderModule2 = moduleCache2.getOrCreate(
        ShaderSourceId.BILLBOARD_COLLECTION_SDF,
        BillboardCollectionSDFWGSL,
        defines,
        "Label SDF shader",
      );
      const velDescriptor = buildSDFVelocityDescriptor(
        device,
        shaderModule2,
        depthFmt2,
        cache.sdfBindGroupLayout,
        defines,
      );
      velEntry = { descriptor: velDescriptor, pipeline: null, pending: false };
      cache.sdfVelocityPipelineEntries.set(defines, velEntry);
    }
    velocityPipeline = tryResolveLabelSDFPipeline(
      device,
      context.webgpuPipelineCache ?? null,
      velEntry,
    );
  }
  cache.sdfVelocityPipeline = velocityPipeline;

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
  packUniforms(cache.uniformData, frameState, modelMatrix, labelCollection);
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

  // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — globe depth view +
  // sampler. Mirrors WebGPUBillboardRenderer's plumbing. Placeholder
  // bound when no globe depth is published this frame.
  if (!defined(cache.globeDepthPlaceholder)) {
    cache.globeDepthPlaceholder = device.createTexture({
      label: "Label globe-depth placeholder 1x1",
      size: [1, 1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: cache.globeDepthPlaceholder },
      new Uint8Array([0, 0, 0, 0]),
      { bytesPerRow: 4 },
      [1, 1, 1],
    );
    cache.globeDepthPlaceholderView = cache.globeDepthPlaceholder.createView();
    cache.globeDepthSampler = device.createSampler({
      label: "Label globe-depth sampler",
      minFilter: "nearest",
      magFilter: "nearest",
    });
  }
  // Batch 139 (NEW-LABEL-SDF-BIND-GROUP-CACHING fix) — track by
  // underlying texture identity, not view object. The scene renderer
  // creates a fresh `GPUTextureView` every frame from a stable
  // `GPUTexture`, so view-object identity comparison rebuilds bind
  // groups every frame on globe scenes. Texture identity is stable
  // across frames (only changes on viewport resize). When the texture
  // rotates we re-create the view; otherwise we reuse our cached
  // view + bind group.
  const globeDepthTexture = context._globeDepthTexture ?? null;
  if (cache.globeDepthCachedTexture !== globeDepthTexture) {
    cache.globeDepthCachedTexture = globeDepthTexture;
    cache.globeDepthCachedView =
      globeDepthTexture !== null ? globeDepthTexture.createView() : null;
  }
  const globeDepthView =
    cache.globeDepthCachedView ?? cache.globeDepthPlaceholderView;

  // NEW-LABEL-SDF-BIND-GROUP-CACHING (Batch 139) — gate the bind
  // group rebuild on whether ANY of the bound resources actually
  // changed since last frame. Pre-Batch-139 the bind group was
  // unconditionally recreated every frame, paying the
  // `createBindGroup` cost for every Sandcastle frame even when the
  // atlas, globe depth view, and uniform buffer were all stable.
  // With texture-identity tracking above, even globe scenes hit a
  // stable cache after the first frame.
  const uniformBuffer = cache.uniformBuffer.buffer;
  const sdfBindGroupNeedsRebuild =
    !defined(cache.sdfBindGroup) ||
    cache.sdfBindGroupAtlasView !== atlasTextureView ||
    cache.sdfBindGroupAtlasSampler !== atlasSampler ||
    cache.sdfBindGroupGlobeDepthView !== globeDepthView ||
    cache.sdfBindGroupUniformBuffer !== uniformBuffer;
  if (sdfBindGroupNeedsRebuild) {
    cache.sdfBindGroup = device.createBindGroup({
      layout: cache.sdfBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: atlasTextureView },
        { binding: 2, resource: atlasSampler },
        { binding: 3, resource: globeDepthView },
        { binding: 4, resource: cache.globeDepthSampler },
      ],
    });
    cache.sdfBindGroupAtlasView = atlasTextureView;
    cache.sdfBindGroupAtlasSampler = atlasSampler;
    cache.sdfBindGroupGlobeDepthView = globeDepthView;
    cache.sdfBindGroupUniformBuffer = uniformBuffer;
  }

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
      false,
      "Label SDF instances",
    );
  }

  // AUDIT_2026_05_02 B.10 (Batch 144, NEW-COLLECTIONS-MOTION-VECTORS) —
  // before overwriting the GPU instance buffer with this frame's data,
  // upload the PREVIOUS frame's data to the prev-instance buffer so
  // the velocity VS reads both streams at slot 0 and slot 1. See
  // `WebGPUBillboardRenderer.js`'s prev-instance pattern for the full
  // design notes — this mirror is identical except for the SDF
  // per-instance stride.
  const taaEnabledThisFrame = frameState.scene?.taaEnabled === true;
  if (taaEnabledThisFrame || defined(cache.sdfPrevInstanceBuffer)) {
    if (
      !defined(cache.sdfPrevInstanceBuffer) ||
      cache.sdfPrevInstanceBuffer.size < requiredSize
    ) {
      if (defined(cache.sdfPrevInstanceBuffer)) {
        cache.sdfPrevInstanceBuffer.destroy();
      }
      cache.sdfPrevInstanceBuffer = WebGPUBuffer.createVertexBuffer(
        device,
        requiredSize,
        false,
        "Label SDF prev instances",
      );
    }
    const prevSource = cache.sdfPrevInstanceData ?? instanceData;
    let prevPayload = prevSource;
    const expectedFloats = visibleCount * FLOATS_PER_SDF_INSTANCE;
    if (prevSource.length < expectedFloats) {
      // Last frame had fewer glyphs — pad the tail with current data so
      // newly-spawned glyphs see prev = current → zero velocity.
      prevPayload = new Float32Array(expectedFloats);
      prevPayload.set(prevSource);
      prevPayload.set(
        instanceData.subarray(prevSource.length, expectedFloats),
        prevSource.length,
      );
    } else if (prevSource.length > expectedFloats) {
      prevPayload = prevSource.subarray(0, expectedFloats);
    }
    device.queue.writeBuffer(
      cache.sdfPrevInstanceBuffer.buffer,
      0,
      prevPayload.buffer,
      prevPayload.byteOffset,
      requiredSize,
    );
  }

  device.queue.writeBuffer(
    cache.sdfInstanceBuffer.buffer,
    0,
    instanceData.buffer,
    0,
    requiredSize,
  );

  // Stash this frame's data so next frame's velocity pass has prev
  // available. Always done — even when TAA is off — so a TAA off → on
  // transition doesn't lose a frame of history.
  cache.sdfPrevInstanceData = instanceData;

  // Create SDF draw command. Labels are alpha-blended via the SDF shader, so
  // they must run in the TRANSLUCENT pass or they'll paint opaque rectangles
  // on top of anything rendered earlier. Match upstream's treatment of labels
  // as translucent geometry unless the collection explicitly asked for OPAQUE.
  const labelBlendOpt = labelCollection?._blendOption;
  const labelPass =
    labelBlendOpt === 0 ? 8 /* Pass.OPAQUE */ : 9; /* Pass.TRANSLUCENT */
  // C-R1-COLLECTIONS-PER-ENCODER (Batch 98) — forward the LabelCollection's
  // background billboard render state so `applyPerEncoderState` runs the
  // dynamic stencilRef / blendConstant / scissor / viewport ops in the
  // SDF label pass. Labels themselves don't expose a `_rsOpaque` /
  // `_rsTranslucent` (only their background billboards do, via the
  // delegated BillboardRenderer call below), but the collection's
  // `_backgroundBillboardCollection` carries one. Use it as a proxy when
  // present so the SDF pass picks up custom appearance state from the
  // owning collection. Falls back to undefined (no per-encoder state)
  // when no background billboards are wired — that's the OPAQUE-blend
  // pipeline-baked default and is the historical behavior.
  const labelRS =
    labelCollection?._backgroundBillboardCollection?._rsTranslucent ??
    labelCollection?._backgroundBillboardCollection?._rsOpaque;
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
    renderState: labelRS,
  });

  // AUDIT_2026_05_02 B.10 (Batch 144, NEW-COLLECTIONS-MOTION-VECTORS) —
  // attach the velocity command. The TAA pass walks the command list
  // for `cmd.velocityCommand` and dispatches it into the rg16float
  // velocity texture. Mirrors the Billboard attachment pattern from
  // Batch 143. Only emitted when TAA is enabled this frame AND the
  // velocity pipeline resolved (it can be null on the first frame
  // after TAA enables, while async pipeline creation is in flight).
  if (taaEnabledThisFrame && velocityPipeline && cache.sdfPrevInstanceBuffer) {
    const sdfVelocityCommand = new WebGPUDrawCommand({
      pipeline: velocityPipeline,
      bindGroups: [cache.sdfBindGroup],
      vertexBuffers: [cache.sdfInstanceBuffer, cache.sdfPrevInstanceBuffer],
      vertexCount: VERTICES_PER_QUAD,
      instanceCount: visibleCount,
      pass: labelPass,
      owner: labelCollection,
      boundingVolume: glyphCollection._boundingVolume,
      modelMatrix: modelMatrix,
      cull: true,
      renderState: labelRS,
    });
    sdfCommand.velocityCommand = sdfVelocityCommand;
  } else {
    sdfCommand.velocityCommand = undefined;
  }

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
  if (defined(cache.sdfPrevInstanceBuffer)) {
    cache.sdfPrevInstanceBuffer.destroy();
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
