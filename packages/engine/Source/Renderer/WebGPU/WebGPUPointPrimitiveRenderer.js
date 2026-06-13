/**
 * Handles WebGPU rendering of PointPrimitiveCollection.
 * Points are rendered as instanced screen-space quads (6 vertices per point)
 * because WebGPU has no gl_PointSize/gl_PointCoord support.
 *
 * Instance data layout (64 bytes per point, 4 x vec4):
 *   `location(0)` posHighAndSize:   vec4f — encodedPosition.high.xyz, pixelSize
 *   `location(1)` posLowAndOutline: vec4f — encodedPosition.low.xyz, outlineWidth
 *   `location(2)` color:            vec4f — color rgba
 *   `location(3)` outColorAndShow:  vec4f — outlineColor.rgb, show(0/1)
 *
 * Uniforms (256 bytes, aligned):
 *   mvpRelativeToEye:              mat4x4<f32> (64 bytes)  — RTE model-view-projection
 *   viewportSize:                  vec2<f32>   (8 bytes)
 *   splitPos:                      f32         (4 bytes)
 *   pad:                           f32         (4 bytes)
 *   encodedCameraPositionMCHigh:   vec3<f32>   (12 bytes)  — RTE camera high bits
 *   pad1:                          f32         (4 bytes)
 *   encodedCameraPositionMCLow:    vec3<f32>   (12 bytes)  — RTE camera low bits
 *   pad2:                          f32         (4 bytes)
 *
 * @private
 * @module WebGPUPointPrimitiveRenderer
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import WebGPUCollectionCameraUB from "./WebGPUCollectionCameraUB.js";
import { getCollectionShaderSource } from "./WebGPUCollectionShaders.js";
// Slice 5c-B Phase 1 (Batch 110) — scene-FB target helper.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import { WebGPUResidentInstanceBuffer } from "./WebGPUResidentInstanceBuffer.js";
import SceneMode from "../../Scene/SceneMode.js";

// =========================================================================
// Constants
// =========================================================================

/**
 * Floats per instance: 7 vec4 = 28 floats. Batch 21 extended from 4→5
 * for DP-H42 / DP-H40 `perInstanceFlags`. Batch 136 (Audit A.14) added
 * `translucencyByDistance` (slot 5) and `scaleByDistance` (slot 6) for
 * the EYE_DISTANCE_TRANSLUCENCY / EYE_DISTANCE_SCALING gates. Point
 * primitives have no pixelOffset attribute, so the
 * EYE_DISTANCE_PIXEL_OFFSET gate doesn't apply here.
 */
const FLOATS_PER_INSTANCE = 28;
/** Bytes per instance: 28 * 4 = 112 bytes */
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;
/** Vertices per quad: 6 (2 triangles, no index buffer needed) */
const VERTICES_PER_QUAD = 6;
/** Uniform buffer size (256-byte aligned) */
const UNIFORM_BUFFER_SIZE = 256;

// Scratch variables
const scratchModelView = new Matrix4();
const scratchModelViewRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchInverseModel = new Matrix4();
const scratchCameraPositionMC = new Cartesian3();
const scratchEncodedCamera = new EncodedCartesian3();
const scratchEncodedPosition = new EncodedCartesian3();

// =========================================================================
// Instance Data Building
// =========================================================================

/**
 * Batch 140 (NEW-DISABLE-DEPTH-DISTANCE-INFINITY-PARITY-POLYLINE-POINT) —
 * mirrors `WebGPUBillboardRenderer.encodeDisableDepthTestDistance`.
 * Maps `Number.POSITIVE_INFINITY` to `-1.0` so the WGSL `<0` always-
 * disable sentinel fires (matching WebGL
 * `PointPrimitiveCollection.js:1102` Infinity → -1 substitution).
 * Earlier the JS pack collapsed Infinity to 0.0 (the `isFinite` branch
 * returned the default), making the WGSL sentinel branch dead.
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
 * AUDIT_2026_05_02 A.14 (Batch 136) — pack a CesiumJS NearFarScalar
 * (near, nearValue, far, farValue) into 4 contiguous floats. Identity-NFS
 * written when `scalar` is undefined so the shader's gate produces the
 * unchanged baseline for points with no per-distance ramp configured.
 * Mirrors `WebGPUBillboardRenderer.packNearFarScalar`.
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

/**
 * Slot-presence predicate shared by the resident-instance manager and the
 * pick builder. Points (unlike billboards) keep hidden primitives IN the
 * packed stream — `_show` is packed into the instance record (slot 15)
 * and the shader collapses hidden quads — so a `show` toggle is a plain
 * property edit (partial write), never a slot shift. Only holes (removed
 * entries pending compaction, `null` per `PointPrimitiveCollection.remove`)
 * have no slot, and removal always arrives with `_createVertexArray`.
 * @private
 */
function isPointInstance(point) {
  return defined(point);
}

/**
 * Pack ONE point's 28-float instance record at `offset` floats into
 * `out`. Extracted from the former whole-collection `buildInstanceData`
 * loop (NEW-PARTIAL-WRITE-WIRE-BPL, point half) so the resident-instance
 * manager can re-pack a single changed slot without touching neighbors.
 * @private
 */
function packPointInstance(out, offset, point) {
  const position = point._actualPosition || point._position;

  // RTE: Encode position into high/low 32-bit float pairs
  // This enables sub-meter precision at planetary-scale coordinates
  EncodedCartesian3.fromCartesian(position, scratchEncodedPosition);
  const high = scratchEncodedPosition.high;
  const low = scratchEncodedPosition.low;

  // posHighAndSize: encodedPosition.high.xyz, pixelSize
  out[offset + 0] = high.x;
  out[offset + 1] = high.y;
  out[offset + 2] = high.z;
  out[offset + 3] = point._pixelSize;

  // posLowAndOutline: encodedPosition.low.xyz, outlineWidth
  out[offset + 4] = low.x;
  out[offset + 5] = low.y;
  out[offset + 6] = low.z;
  out[offset + 7] = point._outlineWidth;

  // color: rgba
  const color = point._color;
  out[offset + 8] = color.red;
  out[offset + 9] = color.green;
  out[offset + 10] = color.blue;
  out[offset + 11] = color.alpha;

  // outColorAndShow: outlineColor.rgb, show
  const outlineColor = point._outlineColor;
  out[offset + 12] = outlineColor.red;
  out[offset + 13] = outlineColor.green;
  out[offset + 14] = outlineColor.blue;
  out[offset + 15] = point._show ? 1.0 : 0.0;

  // perInstanceFlags — DP-H42 / DP-H40 / A.14 DDC.
  //   x: disableDepthTestDistance (raw meters; squared in shader)
  //   y: splitDirection (-1 LEFT / 0 NONE / +1 RIGHT)
  //   z: distanceDisplayCondition.near^2 (Batch 136)
  //   w: distanceDisplayCondition.far^2 (Batch 136)
  out[offset + 16] = encodeDisableDepthTestDistance(
    point._disableDepthTestDistance,
  );
  out[offset + 17] = point._splitDirection ?? 0.0;
  const ddc = point._distanceDisplayCondition;
  if (ddc) {
    const ddcNear = typeof ddc.near === "number" ? ddc.near : 0.0;
    const ddcFar =
      typeof ddc.far === "number" ? ddc.far : Number.POSITIVE_INFINITY;
    out[offset + 18] = ddcNear * ddcNear;
    out[offset + 19] = isFinite(ddcFar) ? ddcFar * ddcFar : Number.MAX_VALUE;
  } else {
    out[offset + 18] = 0.0;
    out[offset + 19] = Number.MAX_VALUE;
  }

  // AUDIT_2026_05_02 A.14 (Batch 136) — translucencyByDistance +
  // scaleByDistance NearFarScalars. Identity = 1.0 for both
  // (multiplicative). EYE_DISTANCE_PIXEL_OFFSET doesn't apply here
  // (Point has no pixelOffset attribute).
  packNearFarScalar(out, offset + 20, point._translucencyByDistance, 1.0);
  packNearFarScalar(out, offset + 24, point._scaleByDistance, 1.0);
}

/**
 * Builds a Float32Array of per-instance data from the collection's point primitives.
 *
 * Retained for export compatibility (test harnesses); the render path now
 * goes through `WebGPUResidentInstanceBuffer.sync` + `packPointInstance`.
 *
 * @param {PointPrimitiveCollection} collection - The point collection
 * @returns {{ instanceData: Float32Array, visibleCount: number }}
 * @private
 */
function buildInstanceData(collection) {
  const points = collection._pointPrimitives;
  const length = collection._pointPrimitivesLength;

  const instanceData = new Float32Array(length * FLOATS_PER_INSTANCE);
  let visibleCount = 0;

  for (let i = 0; i < length; i++) {
    const point = points[i];
    if (!isPointInstance(point)) {
      continue;
    }
    packPointInstance(instanceData, visibleCount * FLOATS_PER_INSTANCE, point);
    visibleCount++;
  }

  return { instanceData, visibleCount };
}

/**
 * Builds pick-variant instance data with pick colors instead of display colors.
 * Layout matches PointPrimitivePick.wgsl:
 *   `location(0)` posHighAndSize, `location(1)` posLowAndOutline,
 *   `location(2)` pickColorIn, `location(3)` showVec
 * @private
 */
function buildPickInstanceData(collection, context) {
  const points = collection._pointPrimitives;
  const length = collection._pointPrimitivesLength;
  const instanceData = new Float32Array(length * FLOATS_PER_INSTANCE);
  let visibleCount = 0;

  for (let i = 0; i < length; i++) {
    const point = points[i];
    if (!defined(point)) {
      continue;
    }

    const offset = visibleCount * FLOATS_PER_INSTANCE;
    const position = point._actualPosition || point._position;
    EncodedCartesian3.fromCartesian(position, scratchEncodedPosition);
    const high = scratchEncodedPosition.high;
    const low = scratchEncodedPosition.low;

    instanceData[offset + 0] = high.x;
    instanceData[offset + 1] = high.y;
    instanceData[offset + 2] = high.z;
    instanceData[offset + 3] = point._pixelSize;
    instanceData[offset + 4] = low.x;
    instanceData[offset + 5] = low.y;
    instanceData[offset + 6] = low.z;
    instanceData[offset + 7] = point._outlineWidth;

    // Pick color from context pick ID
    if (!defined(point._pickId)) {
      point._pickId = context.createPickId(point, "point");
    }
    const pc = point._pickId.color;
    instanceData[offset + 8] = pc.red;
    instanceData[offset + 9] = pc.green;
    instanceData[offset + 10] = pc.blue;
    instanceData[offset + 11] = pc.alpha;

    // show flag
    instanceData[offset + 12] = point._show ? 1.0 : 0.0;
    instanceData[offset + 13] = 0.0;
    instanceData[offset + 14] = 0.0;
    instanceData[offset + 15] = 0.0;

    // Same perInstanceFlags as the color path so pick obeys DP-H42 /
    // DP-H40 / A.14 DDC. Pick must mirror color visibility exactly so
    // an invisible point is also unpickable.
    instanceData[offset + 16] = encodeDisableDepthTestDistance(
      point._disableDepthTestDistance,
    );
    instanceData[offset + 17] = point._splitDirection ?? 0.0;
    const ddc = point._distanceDisplayCondition;
    if (ddc) {
      const ddcNear = typeof ddc.near === "number" ? ddc.near : 0.0;
      const ddcFar =
        typeof ddc.far === "number" ? ddc.far : Number.POSITIVE_INFINITY;
      instanceData[offset + 18] = ddcNear * ddcNear;
      instanceData[offset + 19] = isFinite(ddcFar)
        ? ddcFar * ddcFar
        : Number.MAX_VALUE;
    } else {
      instanceData[offset + 18] = 0.0;
      instanceData[offset + 19] = Number.MAX_VALUE;
    }
    // AUDIT_2026_05_02 A.14 (Batch 136) — pick path's NearFarScalars.
    packNearFarScalar(
      instanceData,
      offset + 20,
      point._translucencyByDistance,
      1.0,
    );
    packNearFarScalar(instanceData, offset + 24, point._scaleByDistance, 1.0);

    visibleCount++;
  }

  return { instanceData, visibleCount };
}

// =========================================================================
// Pipeline Creation
// =========================================================================

/**
 * Instance vertex buffer layout — step mode = instance, 112 bytes
 * stride (Batch 136). Bumped from 80 bytes to fit the two NearFarScalar
 * gates added by Audit A.14.
 * @private
 */
const INSTANCE_BUFFER_LAYOUT = {
  arrayStride: BYTES_PER_INSTANCE,
  stepMode: "instance",
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x4" }, // posHighAndSize
    { shaderLocation: 1, offset: 16, format: "float32x4" }, // posLowAndOutline
    { shaderLocation: 2, offset: 32, format: "float32x4" }, // color
    { shaderLocation: 3, offset: 48, format: "float32x4" }, // outColorAndShow
    // DP-H42 / DP-H40 / A.14 DDC — perInstanceFlags.
    { shaderLocation: 4, offset: 64, format: "float32x4" },
    // AUDIT_2026_05_02 A.14 (Batch 136) — translucencyByDistance +
    // scaleByDistance. Always declared so a single layout serves all
    // ifdef variants without rebuilding.
    { shaderLocation: 5, offset: 80, format: "float32x4" },
    { shaderLocation: 6, offset: 96, format: "float32x4" },
  ],
};

/**
 * AUDIT_2026_05_02 B.10 (Batch 148, NEW-COLLECTIONS-MOTION-VECTORS) —
 * second VB layout for the velocity pipeline. Same per-instance stride
 * as the regular instance buffer (the renderer keeps a one-frame-lagged
 * mirror of the same data); the velocity VS only reads positions via
 * locations 7-8, the next free slots after the current VS's 0-6
 * attribute set.
 * @private
 */
const VELOCITY_PREV_INSTANCE_BUFFER_LAYOUT = {
  arrayStride: BYTES_PER_INSTANCE,
  stepMode: "instance",
  attributes: [
    // prevPosHighAndSize at byte 0 — mirrors location 0.
    { shaderLocation: 7, offset: 0, format: "float32x4" },
    // prevPosLowAndOutline at byte 16 — mirrors location 1.
    { shaderLocation: 8, offset: 16, format: "float32x4" },
  ],
};

/**
 * Creates the render pipeline for point primitive rendering.
 *
 * @param {GPUDevice} device - The WebGPU device
 * @param {string} shaderCode - WGSL shader source
 * @param {GPUTextureFormat} format - Canvas presentation format
 * @param {GPUTextureFormat} depthFormat - Depth texture format
 * @param {boolean} [translucent=false] - Whether to enable alpha blending
 * @returns {{ pipeline: GPURenderPipeline, bindGroupLayout: GPUBindGroupLayout }}
 * @private
 */
function createPointBindGroupLayout(device) {
  return makeBindGroupLayout(device, "PointPrimitive bind group layout", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
  ]);
}

/**
 * Build the cache-friendly descriptor for the color pipeline. The actual
 * `GPURenderPipeline` is materialized by the central pipeline cache so
 * two PointPrimitiveCollections rendering with the same (format, depth
 * format, blend, defines) tuple share one pipeline.
 *
 * C-R7-RENDERER-MIGRATION (Batch 58).
 * @private
 */
function buildPointColorDescriptor(
  device,
  shaderModule,
  format,
  depthFormat,
  translucent,
  bindGroupLayout,
  defines,
  sampleCount,
) {
  const pipelineLayout = device.createPipelineLayout({
    label: "PointPrimitive pipeline layout",
    bindGroupLayouts: [bindGroupLayout],
  });

  const blendState = translucent
    ? {
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
      }
    : undefined;

  return {
    name: `PointPrimitive ${translucent ? "translucent" : "opaque"} [${format}/${depthFormat}/defines=0x${defines.toString(16)}/ms=${sampleCount ?? 1}]`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [INSTANCE_BUFFER_LAYOUT],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      // Slice 5c-B Phase 1 (Batch 110) — scene-FB color target via
      // helper. `blendState` is passed through verbatim (it's caller-
      // provided so preserving the exact reference matters for cache).
      targets: makeSceneFBTargets(format, { blend: blendState }),
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "none",
    },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: !translucent,
      depthCompare: "less-equal",
    },
    // Batch 134 — match scene-FB MSAA sample count (see WebGPUBillboardRenderer for rationale).
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  };
}

/**
 * AUDIT_2026_05_02 B.10 (Batch 148, NEW-COLLECTIONS-MOTION-VECTORS) —
 * descriptor for the velocity pipeline variant. Same VS layout /
 * shader module / pipeline layout as the regular point pipeline;
 * the fragment entry is `fragmentVelocityMain` and the target format
 * is `rg16float` (the scene-FB velocity texture format). Depth is
 * read-only so fragments behind opaque geometry fail the depth test.
 * Mirrors `buildBillboardVelocityDescriptor` (Batch 143).
 * @private
 */
function buildPointVelocityDescriptor(
  device,
  shaderModule,
  depthFormat,
  bindGroupLayout,
  defines,
) {
  const pipelineLayout = device.createPipelineLayout({
    label: "PointPrimitive velocity pipeline layout",
    bindGroupLayouts: [bindGroupLayout],
  });
  return {
    name: `PointPrimitive velocity [${depthFormat}/defines=0x${defines.toString(16)}]`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexVelocityMain",
      buffers: [INSTANCE_BUFFER_LAYOUT, VELOCITY_PREV_INSTANCE_BUFFER_LAYOUT],
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
 * Build the cache-friendly descriptor for the pick pipeline.
 *
 * C-R7-RENDERER-MIGRATION (Batch 58).
 * @private
 */
function buildPointPickDescriptor(
  device,
  shaderModule,
  format,
  depthFormat,
  bindGroupLayout,
  defines,
) {
  const pipelineLayout = device.createPipelineLayout({
    label: "PointPrimitive pick pipeline layout",
    bindGroupLayouts: [bindGroupLayout],
  });
  return {
    name: `PointPrimitive pick [${format}/${depthFormat}/defines=0x${defines.toString(16)}]`,
    layout: pipelineLayout,
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
 * Convert a `WebGPURenderPipelineDescriptor` to a raw WebGPU descriptor
 * for the synchronous fallback path (no central cache available).
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
 * Resolve a single pipeline (color or pick) through the central cache.
 * Returns the existing GPU pipeline if cached, otherwise kicks off async
 * creation via the cache and returns null. Synchronous fallback when no
 * central cache is wired (legacy callers / WebGL).
 *
 * The `entry` is a slot object that gets mutated:
 *   { pipeline: GPURenderPipeline | null, pending: boolean }
 *
 * C-R7-RENDERER-MIGRATION (Batch 58).
 * @private
 */
function tryResolvePointPipeline(device, pipelineCache, descriptor, entry) {
  if (entry.pipeline) {
    return entry.pipeline;
  }
  if (pipelineCache) {
    const sync = pipelineCache.getPipelineSync(descriptor);
    if (sync) {
      entry.pipeline = sync;
      entry.pending = false;
      return sync;
    }
    if (!entry.pending) {
      entry.pending = true;
      pipelineCache
        .getPipeline(descriptor)
        .then((p) => {
          entry.pipeline = p;
          entry.pending = false;
        })
        .catch(() => {
          // Errors already logged by the cache; clear in-flight flag so
          // subsequent frames can retry.
          entry.pending = false;
        });
    }
    return null;
  }
  // Fallback path — direct synchronous creation. Matches pre-migration
  // behavior for WebGL contexts or when the central cache isn't wired.
  entry.pipeline = device.createRenderPipeline(descriptorToGPU(descriptor));
  entry.pending = false;
  return entry.pipeline;
}

// Module-level shader-module cache keyed by GPUDevice. Shared across every
// PointPrimitiveCollection rendered on a given device.
const _pointShaderModuleCaches = new WeakMap();

function getPointShaderModuleCache(device) {
  let cache = _pointShaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _pointShaderModuleCaches.set(device, cache);
  }
  return cache;
}

/**
 * Prewarm the color + pick modules for the common define sets. Idempotent
 * per device. See `_initShaderCache` in `WebGPUGlobeSurfaceRenderer.ts`
 * for the "move shader compile off the render path" rationale.
 * @private
 */
function prewarmPointShaders(device, colorSource, pickSource) {
  const cache = getPointShaderModuleCache(device);
  if (cache._pointPrewarmed) {
    return;
  }
  const D = ShaderDefine;
  // AUDIT_2026_05_02 A.14 (Batch 136) — added DDC + translucency + scaling
  // variants. Point consumes 5 distance-related defines; we seed the
  // most common scenarios.
  const D_DDC_TRANS =
    D.DISTANCE_DISPLAY_CONDITION | D.EYE_DISTANCE_TRANSLUCENCY;
  const D_ALL_DIST =
    D.DISTANCE_DISPLAY_CONDITION |
    D.EYE_DISTANCE_TRANSLUCENCY |
    D.EYE_DISTANCE_SCALING;
  const D_PROD = D.DISABLE_DEPTH_DISTANCE | D.SPLIT_ENABLED | D_ALL_DIST;
  const defineSets = [
    0,
    D.DISABLE_DEPTH_DISTANCE,
    D.SPLIT_ENABLED,
    D.DISTANCE_DISPLAY_CONDITION,
    D.EYE_DISTANCE_TRANSLUCENCY,
    D.EYE_DISTANCE_SCALING,
    D.DISABLE_DEPTH_DISTANCE | D.SPLIT_ENABLED,
    D_DDC_TRANS,
    D_ALL_DIST,
    D_PROD,
  ];
  cache.prewarm(
    ShaderSourceId.POINT_PRIMITIVE_COLOR,
    colorSource,
    defineSets,
    "PointPrimitive color shader",
  );
  cache.prewarm(
    ShaderSourceId.POINT_PRIMITIVE_PICK,
    pickSource,
    defineSets,
    "PointPrimitive pick shader",
  );
  cache._pointPrewarmed = true;
}

/**
 * Per-frame scan for the active defines. Mirrors Billboard/Label.
 * Point consumes 5 of the 6 distance-related defines (no pixelOffset).
 * @private
 */
function computePointDefinesForFrame(collection, frameState) {
  let defines = 0;
  // Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH) — OR the LOG_DEPTH
  // bit when the master switch + per-frame flag are on. The bit keys the
  // shader-module cache AND the pipeline maps/names, so the flip rebuilds
  // through the normal keyed-miss path. Inert while the switch defaults
  // FALSE (defines unchanged, byte-identical shaders).
  if (isWebGPULogDepthActive(frameState?.context, frameState)) {
    defines |= ShaderDefine.LOG_DEPTH;
  }
  const frameMin =
    typeof frameState?.minimumDisableDepthTestDistance === "number"
      ? frameState.minimumDisableDepthTestDistance
      : 0.0;
  if (frameMin !== 0.0) {
    defines |= ShaderDefine.DISABLE_DEPTH_DISTANCE;
  }
  const points = collection._pointPrimitives;
  const length = collection._pointPrimitivesLength;
  const all =
    ShaderDefine.DISABLE_DEPTH_DISTANCE |
    ShaderDefine.SPLIT_ENABLED |
    ShaderDefine.DISTANCE_DISPLAY_CONDITION |
    ShaderDefine.EYE_DISTANCE_TRANSLUCENCY |
    ShaderDefine.EYE_DISTANCE_SCALING;
  for (let i = 0; i < length; i++) {
    if ((defines & all) === all) {
      break;
    }
    const p = points[i];
    if (!defined(p)) {
      continue;
    }
    if (
      (defines & ShaderDefine.DISABLE_DEPTH_DISTANCE) === 0 &&
      typeof p._disableDepthTestDistance === "number" &&
      p._disableDepthTestDistance !== 0.0
    ) {
      defines |= ShaderDefine.DISABLE_DEPTH_DISTANCE;
    }
    if (
      (defines & ShaderDefine.SPLIT_ENABLED) === 0 &&
      p._splitDirection !== undefined &&
      p._splitDirection !== 0.0
    ) {
      defines |= ShaderDefine.SPLIT_ENABLED;
    }
    // AUDIT_2026_05_02 A.14 (Batch 136) — DDC + translucency + scaling.
    if (
      (defines & ShaderDefine.DISTANCE_DISPLAY_CONDITION) === 0 &&
      defined(p._distanceDisplayCondition)
    ) {
      defines |= ShaderDefine.DISTANCE_DISPLAY_CONDITION;
    }
    if (
      (defines & ShaderDefine.EYE_DISTANCE_TRANSLUCENCY) === 0 &&
      defined(p._translucencyByDistance)
    ) {
      defines |= ShaderDefine.EYE_DISTANCE_TRANSLUCENCY;
    }
    if (
      (defines & ShaderDefine.EYE_DISTANCE_SCALING) === 0 &&
      defined(p._scaleByDistance)
    ) {
      defines |= ShaderDefine.EYE_DISTANCE_SCALING;
    }
  }
  return defines;
}

// =========================================================================
// Uniform Updates
// =========================================================================

/**
 * Packs RTE uniform data into a Float32Array.
 *
 * Layout (28 active floats, 256-byte buffer) — matches the unified
 * CameraUniforms struct in PointPrimitiveColor.wgsl / PointPrimitivePick.wgsl:
 *   [0-15]  mvpRelativeToEye (mat4x4) — MVP with translation zeroed
 *   [16-17] viewportSize (vec2)
 *   [18]    splitPosition (f32) — DP-H40 (framebuffer pixels)
 *   [19]    minimumDisableDepthTestDistance (f32) — DP-H42 (meters)
 *   [20-22] encodedCameraPositionMCHigh (vec3)
 *   [23]    _pad0 (f32)
 *   [24-26] encodedCameraPositionMCLow (vec3)
 *   [27]    _pad1 (f32)
 *
 * @param {Float32Array} uniformData - Target array (at least 28 floats)
 * @param {object} frameState - CesiumJS frame state
 * @param {Matrix4} modelMatrix - Collection's model matrix
 * @private
 */
function packUniforms(uniformData, frameState, modelMatrix) {
  const context = frameState.context;
  const uniformState = context.uniformState;
  const canvas = context.canvas;

  // Step 1: Compute modelView = view * model
  // Use uniformState.view instead of camera.viewMatrix for 2D/Columbus View support
  Matrix4.multiply(uniformState.view, modelMatrix, scratchModelView);

  // Step 2: Create modelViewRTE = modelView with translation column zeroed
  // This removes the large translation that causes float32 precision loss
  Matrix4.clone(scratchModelView, scratchModelViewRTE);
  scratchModelViewRTE[12] = 0.0;
  scratchModelViewRTE[13] = 0.0;
  scratchModelViewRTE[14] = 0.0;

  // Step 3: Compute mvpRelativeToEye = projection * modelViewRTE
  // Use uniformState.projection for 2D/Columbus View support
  Matrix4.multiply(uniformState.projection, scratchModelViewRTE, scratchMVPRTE);

  // Write mvpRelativeToEye matrix (16 floats at offset 0)
  Matrix4.pack(scratchMVPRTE, uniformData, 0);

  // Write viewport size (2 floats at offset 16)
  uniformData[16] = canvas.width;
  uniformData[17] = canvas.height;

  // DP-H40 — split cutoff in framebuffer pixels (fraction × drawing width).
  const splitFraction =
    typeof frameState?.splitPosition === "number"
      ? frameState.splitPosition
      : 0.0;
  const drawingBufferWidth = context?.drawingBufferWidth ?? canvas.width ?? 0.0;
  uniformData[18] = splitFraction * drawingBufferWidth;

  // DP-H42 — frame-wide fallback threshold (meters; squared in shader).
  uniformData[19] =
    typeof frameState?.minimumDisableDepthTestDistance === "number"
      ? frameState.minimumDisableDepthTestDistance
      : 0.0;

  // Step 4: Compute encoded camera position in model coordinates
  // cameraPositionMC = inverseModel * cameraPositionWorld
  Matrix4.inverse(modelMatrix, scratchInverseModel);
  Matrix4.multiplyByPoint(
    scratchInverseModel,
    frameState.camera.positionWC,
    scratchCameraPositionMC,
  );

  // Step 5: Encode camera position MC as high/low float pairs
  EncodedCartesian3.fromCartesian(
    scratchCameraPositionMC,
    scratchEncodedCamera,
  );

  // Write encodedCameraPositionMCHigh (3 floats at offset 20 + 1 pad)
  const camHigh = scratchEncodedCamera.high;
  uniformData[20] = camHigh.x;
  uniformData[21] = camHigh.y;
  uniformData[22] = camHigh.z;
  uniformData[23] = 0.0; // _pad1

  // Write encodedCameraPositionMCLow (3 floats at offset 24 + 1 pad)
  const camLow = scratchEncodedCamera.low;
  uniformData[24] = camLow.x;
  uniformData[25] = camLow.y;
  uniformData[26] = camLow.z;
  uniformData[27] = 0.0; // _pad2

  // DP-H41 (Batch 27) — previousViewProjection at slots 28..43 (16 floats,
  // 64 bytes). Fits in the existing 256-byte buffer — no resize needed.
  // `UniformState.update()` caches last frame's viewProjection for TAA /
  // motion-vector reprojection before overwriting the current frame's state.
  const prevVP = uniformState.previousViewProjection;
  if (prevVP) {
    Matrix4.pack(prevVP, uniformData, 28);
  } else {
    uniformData[28] = 1;
    uniformData[29] = 0;
    uniformData[30] = 0;
    uniformData[31] = 0;
    uniformData[32] = 0;
    uniformData[33] = 1;
    uniformData[34] = 0;
    uniformData[35] = 0;
    uniformData[36] = 0;
    uniformData[37] = 0;
    uniformData[38] = 1;
    uniformData[39] = 0;
    uniformData[40] = 0;
    uniformData[41] = 0;
    uniformData[42] = 0;
    uniformData[43] = 1;
  }

  // Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH) — logDepth vec4
  // (near, far, factor, reserved) at floats 44-47 (struct tail; the GPU
  // buffer is 256 bytes so no resize). Same encode frustum every producer
  // packs; unconditional — only the LOG_DEPTH shader variant reads it.
  const ldFrustum = uniformState.currentFrustum;
  const ldNear = ldFrustum ? ldFrustum.x : 0.0;
  const ldFar = ldFrustum ? ldFrustum.y : 0.0;
  let ldFactor =
    typeof uniformState.oneOverLog2FarDepthFromNearPlusOne === "number"
      ? uniformState.oneOverLog2FarDepthFromNearPlusOne
      : 0.0;
  if (!(ldFactor > 0.0) && ldFar > ldNear) {
    const ldLog2Far = Math.log2(ldFar - ldNear + 1.0);
    ldFactor = ldLog2Far > 0.0 ? 1.0 / ldLog2Far : 0.0;
  }
  uniformData[44] = ldNear;
  uniformData[45] = ldFar;
  uniformData[46] = ldFactor;
  uniformData[47] = 0.0;
}

// =========================================================================
// Main Render Function
// =========================================================================

/**
 * Creates or updates WebGPU draw commands for a PointPrimitiveCollection.
 * Called from PointPrimitiveCollection.update() when isWebGPU is true.
 *
 * Manages a GPU cache on the collection (_webgpuCache) containing:
 * - pipeline, bindGroupLayout (created once)
 * - instanceBuffer, uniformBuffer, bindGroup (created/updated as needed)
 * - colorCommand (the WebGPUDrawCommand)
 *
 * @param {PointPrimitiveCollection} collection - The point collection
 * @param {object} frameState - CesiumJS frame state
 * @param {object} commandList - Array to push draw commands into
 * @private
 */
function updateWebGPUPointPrimitives(collection, frameState, commandList) {
  const context = frameState.context;
  const device = context.device;
  const length = collection._pointPrimitivesLength;

  if (length === 0) {
    return;
  }

  // Initialize GPU cache on first call
  if (!defined(collection._webgpuCache)) {
    collection._webgpuCache = {};
  }
  const cache = collection._webgpuCache;

  // AUDIT_2026_05_02 A.14 (Batch 136) — all three Point distance gates
  // (DDC + translucencyByDistance + scaleByDistance) are wired. Point
  // has no pixelOffset attribute, so EYE_DISTANCE_PIXEL_OFFSET doesn't
  // apply here. Previous one-time warning retired.

  // Prewarm shader modules (idempotent per device).
  const colorShaderCode = getCollectionShaderSource("pointColor");
  const pickShaderCode = getCollectionShaderSource("pointPick");
  prewarmPointShaders(device, colorShaderCode, pickShaderCode);

  // Shared bind-group layout; pipelines vary per defines + shader module.
  if (!defined(cache.bindGroupLayout)) {
    cache.bindGroupLayout = createPointBindGroupLayout(device);
  }

  // DP-H42 / DP-H40 — pick the right pipeline for this frame's point state.
  const defines = computePointDefinesForFrame(collection, frameState);
  // C-R7-RENDERER-MIGRATION (Batch 58) — `cache.pipelines` is now a Map
  // of `defines → { descriptor, pipeline, pending }`. The descriptor is
  // built once per (defines) and passed to the central
  // `WebGPURenderPipelineCache`; the pipeline arrives async on the first
  // request, then synchronously on subsequent frames.
  if (!defined(cache.pipelines)) {
    cache.pipelines = new Map();
    // AUDIT_2026_05_02 B.10 (Batch 148, NEW-COLLECTIONS-MOTION-VECTORS)
    // — velocity pipeline cache. Same (defines) keying as the regular
    // pipeline so a point collection's color and velocity pipelines
    // stay in lockstep.
    cache.velocityPipelines = new Map();
  }
  // Batch 110 — invalidate cached pipelines on scene format change.
  const sceneGen = context._scenePipelineFormatGeneration ?? 0;
  if (cache._pipelineFormatGeneration !== sceneGen) {
    cache.pipelines.clear();
    cache.pickPipelines?.clear();
    cache.velocityPipelines?.clear();
    cache._pipelineFormatGeneration = sceneGen;
  }
  let pipelineEntry = cache.pipelines.get(defines);
  if (!defined(pipelineEntry)) {
    const format = context.scenePipelineFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const moduleCache = getPointShaderModuleCache(device);
    const shaderModule = moduleCache.getOrCreate(
      ShaderSourceId.POINT_PRIMITIVE_COLOR,
      colorShaderCode,
      defines,
      "PointPrimitive color shader",
    );
    const sampleCount = context._msaaSamples ?? 1;
    pipelineEntry = {
      descriptor: buildPointColorDescriptor(
        device,
        shaderModule,
        format,
        depthFmt,
        true,
        cache.bindGroupLayout,
        defines,
        sampleCount,
      ),
      pipeline: null,
      pending: false,
    };
    cache.pipelines.set(defines, pipelineEntry);
  }
  const pipeline = tryResolvePointPipeline(
    device,
    context.webgpuPipelineCache ?? null,
    pipelineEntry.descriptor,
    pipelineEntry,
  );
  if (!defined(pipeline)) {
    // Pipeline still materializing. Skip this frame's draw — the next
    // frame picks it up synchronously via `getPipelineSync`.
    return;
  }
  cache.pipeline = pipeline;
  cache.currentDefines = defines;

  // --- Uniform buffer (created once, updated every frame) ---
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      "PointPrimitive uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
  }

  // Update uniforms every frame (camera moves)
  const modelMatrix = collection.modelMatrix || Matrix4.IDENTITY;
  packUniforms(cache.uniformData, frameState, modelMatrix);
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  // --- Bind group (recreated if uniform buffer changes) ---
  if (!defined(cache.bindGroup)) {
    cache.bindGroup = device.createBindGroup({
      label: "PointPrimitive bind group",
      layout: cache.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
      ],
    });
  }

  // NEW-COLLECTIONS-PER-FRUSTUM-CAMERA-UB (Phase 3 Slice 1) — per-slice
  // camera-UB resolver. The static `cache.bindGroup` above carries the
  // slice-0 / single-frustum bake (packed just above); the resolver repacks
  // + binds a DISTINCT per-slice buffer at draw time so each depth slice the
  // multi-frustum loop re-executes this command in gets its OWN projection.
  // Group 0 is camera-UB-only for points (no atlas/depth), so no extraEntries.
  if (!defined(cache.cameraUB)) {
    cache.cameraUB = new WebGPUCollectionCameraUB(device, "PointPrimitive");
  }
  cache.cameraUB.bindUniformState(context.uniformState);
  cache.cameraResolver = cache.cameraUB.makeResolver({
    bufferSize: UNIFORM_BUFFER_SIZE,
    bindGroupLayout: cache.bindGroupLayout,
    pack: (data) => packUniforms(data, frameState, modelMatrix),
  });

  // --- Instance data — resident-instance partial-write path ---
  // (NEW-RESIDENT-INSTANCE-BUFFER-MGR + NEW-PARTIAL-WRITE-WIRE-BPL, point
  // half.) A settled collection uploads nothing; a sparse change re-packs
  // + uploads only the changed slots' byte ranges. The manager owns the
  // resident CPU array, the GPU vertex buffer, the _index→slot map, and
  // the slot-aligned velocity prev mirror (TAA motion vectors) — it
  // subsumes the former all-or-nothing `needsRebuild` gate.
  const taaEnabledThisFrame = frameState.taaEnabled === true;
  if (!defined(cache.instanceManager)) {
    cache.instanceManager = new WebGPUResidentInstanceBuffer(
      device,
      "PointPrimitive instances",
    );
  }

  // Structural invalidations the manager can't see from the dirty list
  // alone. `_createVertexArray` covers add/remove/removeAll/mode-change/
  // 2D-CV modelMatrix change (read BEFORE _consumeDirtyState clears it);
  // a defines rotation means a stale colorCommand could reference a
  // pipeline that doesn't match this frame's defines, so rebuild data +
  // command together; MORPHING recomputes every `_actualPosition` per
  // frame without dirtying. Mirrors the billboard wiring (no atlas guid
  // here — points sample no texture).
  const forceFullRebuild =
    collection._createVertexArray === true ||
    cache._instanceDefines !== defines ||
    cache._instanceSceneMode !== frameState.mode ||
    frameState.mode === SceneMode.MORPHING;

  // ORDERING (load-bearing): capture + sync the dirty list FIRST, then
  // consume. `_consumeDirtyState` resets `_pointPrimitivesToUpdateIndex`,
  // so syncing after the consume would always see an empty dirty list and
  // never partial-write. (NEW-DIRTY-CONSUME-POINT + Phase 1.)
  const syncResult = cache.instanceManager.sync({
    items: collection._pointPrimitives,
    length: length,
    dirtyList: collection._pointPrimitivesToUpdate,
    dirtyCount: collection._pointPrimitivesToUpdateIndex,
    packInstance: packPointInstance,
    isVisible: isPointInstance,
    floatsPerInstance: FLOATS_PER_INSTANCE,
    bytesPerInstance: BYTES_PER_INSTANCE,
    forceFullRebuild: forceFullRebuild,
    mirrorPrev: taaEnabledThisFrame,
  });
  cache._instanceDefines = defines;
  cache._instanceSceneMode = frameState.mode;

  // Consume the collection's dirty-tracking state now that this frame's
  // instance data is captured. Without it, `_createVertexArray`/`_dirty`
  // stay set on the WebGPU path: `updateMode` re-projects every position
  // every frame AND a moved point can never re-enqueue (the `if (!_dirty)`
  // guard in `_updatePointPrimitive`) so it renders stale. See
  // PointPrimitiveCollection._consumeDirtyState. (NEW-DIRTY-CONSUME-POINT.)
  collection._consumeDirtyState();

  const visibleCount = syncResult.visibleCount;
  if (visibleCount === 0 || !defined(syncResult.buffer)) {
    cache.colorCommand = undefined;
    return;
  }
  cache.instanceBuffer = syncResult.buffer;
  cache.visibleCount = visibleCount;

  // Create draw command (instanced: 6 verts per quad, N instances).
  // Recreated every frame (cheap object) so pipeline/defines rotation,
  // blend-option changes, and visible-count changes are always reflected
  // — mirrors the billboard wiring.
  // pass:0 was a real bug (that value is Pass.ENVIRONMENT, not OPAQUE),
  // causing points to render before the globe surface and paint over
  // the sky. OPAQUE=8 or TRANSLUCENT=9 are the valid pass values.
  // Pick by collection.blendOption — point primitives use discard-based
  // alpha cutoffs so OPAQUE is safe when the collection is all-opaque.
  const pointPass =
    collection._blendOption === 0
      ? 8 /* Pass.OPAQUE */
      : 9; /* Pass.TRANSLUCENT */
  cache.colorCommand = new WebGPUDrawCommand({
    pipeline: cache.pipeline,
    bindGroups: [cache.bindGroup],
    // NEW-COLLECTIONS-PER-FRUSTUM-CAMERA-UB (Phase 3 Slice 1) — per-slice
    // camera UB. Resolver returns null on single-frustum / first frame →
    // falls back to the static bind group, preserving prior behaviour.
    bindGroupResolvers: [cache.cameraResolver],
    vertexBuffers: [cache.instanceBuffer],
    vertexCount: VERTICES_PER_QUAD,
    instanceCount: visibleCount,
    pass: pointPass,
    owner: collection,
    boundingVolume: collection._boundingVolume,
    modelMatrix: modelMatrix,
    cull: true,
    // C-R1-COLLECTIONS-PER-ENCODER (Batch 39) — forward the matching
    // render-state (`_rsOpaque` vs `_rsTranslucent`) so
    // `applyPerEncoderState` drives the dynamic WebGPU pass state from
    // the same values the WebGL path uses.
    renderState:
      pointPass === 8 /* Pass.OPAQUE */
        ? collection._rsOpaque
        : collection._rsTranslucent,
  });

  // AUDIT_2026_05_02 B.10 (Batch 148, NEW-COLLECTIONS-MOTION-VECTORS) —
  // attach velocity command. The TAA pass walks the command list for
  // `cmd.velocityCommand` and dispatches it into the rg16float velocity
  // texture. The prev mirror is slot-aligned with the current buffer by
  // the resident-instance manager (partial writes mirror the prev slot
  // too — see WebGPUResidentInstanceBuffer), so the velocity VS reads
  // matching instances at locations 7/8.
  if (taaEnabledThisFrame && defined(syncResult.prevBuffer)) {
    // Resolve the velocity pipeline lazily.
    let velEntry = cache.velocityPipelines.get(cache.currentDefines ?? 0);
    if (!defined(velEntry)) {
      const depthFmt2 = context.depthFormat || "depth24plus-stencil8";
      const moduleCache2 = getPointShaderModuleCache(device);
      const shaderModule2 = moduleCache2.getOrCreate(
        ShaderSourceId.POINT_PRIMITIVE_COLOR,
        colorShaderCode,
        cache.currentDefines ?? 0,
        "PointPrimitive color shader",
      );
      velEntry = {
        descriptor: buildPointVelocityDescriptor(
          device,
          shaderModule2,
          depthFmt2,
          cache.bindGroupLayout,
          cache.currentDefines ?? 0,
        ),
        pipeline: null,
        pending: false,
      };
      cache.velocityPipelines.set(cache.currentDefines ?? 0, velEntry);
    }
    const velocityPipeline = tryResolvePointPipeline(
      device,
      context.webgpuPipelineCache ?? null,
      velEntry.descriptor,
      velEntry,
    );
    if (defined(velocityPipeline)) {
      cache.colorCommand.velocityCommand = new WebGPUDrawCommand({
        pipeline: velocityPipeline,
        bindGroups: [cache.bindGroup],
        vertexBuffers: [cache.instanceBuffer, syncResult.prevBuffer],
        vertexCount: VERTICES_PER_QUAD,
        instanceCount: visibleCount,
        pass: pointPass,
        owner: collection,
        boundingVolume: collection._boundingVolume,
        modelMatrix: modelMatrix,
        cull: true,
      });
    } else {
      cache.colorCommand.velocityCommand = undefined;
    }
  } else {
    cache.colorCommand.velocityCommand = undefined;
  }

  // --- Pick pass handling ---
  if (frameState.passes.pick) {
    _pushPickCommand(
      collection,
      context,
      device,
      cache,
      modelMatrix,
      commandList,
    );
  }

  // Push color draw command for render passes
  if (frameState.passes.render && defined(cache.colorCommand)) {
    commandList.push(cache.colorCommand);
  }
}

/**
 * Builds and pushes a pick draw command. Pick pipeline and instance buffer
 * are cached on _webgpuCache alongside the color pipeline.
 * @private
 */
function _pushPickCommand(
  collection,
  context,
  device,
  cache,
  modelMatrix,
  commandList,
) {
  // DP-H42 / DP-H40 — pick pipeline mirrors the color pipeline's defines
  // so the pick region matches what's visible on screen.
  // C-R7-RENDERER-MIGRATION (Batch 58) — `cache.pickPipelines` is now
  // `defines → { descriptor, pipeline, pending }` and the actual GPU
  // pipeline is materialized via `context.webgpuPipelineCache`.
  const pickDefines = cache.currentDefines ?? 0;
  if (!defined(cache.pickPipelines)) {
    cache.pickPipelines = new Map();
  }
  let pickEntry = cache.pickPipelines.get(pickDefines);
  if (!defined(pickEntry)) {
    const pickShader = getCollectionShaderSource("pointPick");
    const format = context.scenePipelineFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const moduleCache = getPointShaderModuleCache(device);
    const pickModule = moduleCache.getOrCreate(
      ShaderSourceId.POINT_PRIMITIVE_PICK,
      pickShader,
      pickDefines,
      "PointPrimitive pick shader",
    );
    if (!defined(cache.pickBindGroupLayout)) {
      cache.pickBindGroupLayout = createPointBindGroupLayout(device);
    }
    pickEntry = {
      descriptor: buildPointPickDescriptor(
        device,
        pickModule,
        format,
        depthFmt,
        cache.pickBindGroupLayout,
        pickDefines,
      ),
      pipeline: null,
      pending: false,
    };
    cache.pickPipelines.set(pickDefines, pickEntry);
    // Pick bind group also needs (re)building on first pick pipeline
    // creation; reuses the shared uniform buffer.
    if (!defined(cache.pickBindGroup)) {
      cache.pickBindGroup = device.createBindGroup({
        layout: cache.pickBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
        ],
      });
    }
  }
  const pickPipeline = tryResolvePointPipeline(
    device,
    context.webgpuPipelineCache ?? null,
    pickEntry.descriptor,
    pickEntry,
  );
  if (!defined(pickPipeline)) {
    // Pick pipeline still materializing — skip this frame's pick draw.
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
      false,
      "PointPrimitive pick instances",
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
    bindGroups: [cache.pickBindGroup],
    vertexBuffers: [cache.pickInstanceBuffer],
    vertexCount: VERTICES_PER_QUAD,
    instanceCount: pickResult.visibleCount,
    pass: 8,
    owner: collection,
    boundingVolume: collection._boundingVolume,
    modelMatrix: modelMatrix,
    cull: true,
    // Pick pass is OPAQUE — use `_rsOpaque` so pick-FBO depth behavior
    // matches the color-opaque path. Falls back to `_rsTranslucent`
    // when the collection is TRANSLUCENT-only.
    renderState: collection._rsOpaque ?? collection._rsTranslucent,
    // FORK-34 (Batch 207) — dedicated pick command marker.
    pickOnly: true,
  });

  commandList.push(cache.pickCommand);
}

/**
 * Destroys WebGPU resources cached on a PointPrimitiveCollection.
 * Called from PointPrimitiveCollection.destroy().
 *
 * @param {PointPrimitiveCollection} collection - The point collection
 * @private
 */
function destroyWebGPUPointResources(collection) {
  const cache = collection._webgpuCache;
  if (!defined(cache)) {
    return;
  }

  // The resident-instance manager owns the current instance buffer AND
  // the velocity prev mirror (cache.instanceBuffer is just an alias of
  // manager.buffer for the draw command).
  if (defined(cache.instanceManager)) {
    cache.instanceManager.destroy();
  }
  if (defined(cache.pickInstanceBuffer)) {
    cache.pickInstanceBuffer.destroy();
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }

  collection._webgpuCache = undefined;
}

// =========================================================================
// Exports
// =========================================================================

export {
  updateWebGPUPointPrimitives,
  destroyWebGPUPointResources,
  buildInstanceData,
  packUniforms,
  FLOATS_PER_INSTANCE,
  BYTES_PER_INSTANCE,
  VERTICES_PER_QUAD,
};

export default {
  updateWebGPUPointPrimitives,
  destroyWebGPUPointResources,
};
