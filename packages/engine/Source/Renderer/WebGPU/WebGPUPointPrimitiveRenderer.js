/**
 * @module WebGPUPointPrimitiveRenderer
 *
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
import { getCollectionShaderSource } from "./WebGPUCollectionShaders.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";

// =========================================================================
// Constants
// =========================================================================

/**
 * Floats per instance: 5 vec4 = 20 floats (Batch 21 extends from 4→5 for
 * DP-H42 / DP-H40 `perInstanceFlags` at @location(4)).
 */
const FLOATS_PER_INSTANCE = 20;
/** Bytes per instance: 20 * 4 = 80 bytes */
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
 * Builds a Float32Array of per-instance data from the collection's point primitives.
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
    if (!defined(point)) {
      continue;
    }

    const offset = visibleCount * FLOATS_PER_INSTANCE;
    const position = point._actualPosition || point._position;

    // RTE: Encode position into high/low 32-bit float pairs
    // This enables sub-meter precision at planetary-scale coordinates
    EncodedCartesian3.fromCartesian(position, scratchEncodedPosition);
    const high = scratchEncodedPosition.high;
    const low = scratchEncodedPosition.low;

    // posHighAndSize: encodedPosition.high.xyz, pixelSize
    instanceData[offset + 0] = high.x;
    instanceData[offset + 1] = high.y;
    instanceData[offset + 2] = high.z;
    instanceData[offset + 3] = point._pixelSize;

    // posLowAndOutline: encodedPosition.low.xyz, outlineWidth
    instanceData[offset + 4] = low.x;
    instanceData[offset + 5] = low.y;
    instanceData[offset + 6] = low.z;
    instanceData[offset + 7] = point._outlineWidth;

    // color: rgba
    const color = point._color;
    instanceData[offset + 8] = color.red;
    instanceData[offset + 9] = color.green;
    instanceData[offset + 10] = color.blue;
    instanceData[offset + 11] = color.alpha;

    // outColorAndShow: outlineColor.rgb, show
    const outlineColor = point._outlineColor;
    instanceData[offset + 12] = outlineColor.red;
    instanceData[offset + 13] = outlineColor.green;
    instanceData[offset + 14] = outlineColor.blue;
    instanceData[offset + 15] = point._show ? 1.0 : 0.0;

    // perInstanceFlags — DP-H42 / DP-H40.
    //   x: disableDepthTestDistance (raw meters; squared in shader)
    //   y: splitDirection (-1 LEFT / 0 NONE / +1 RIGHT)
    //   z, w: reserved
    const d = point._disableDepthTestDistance;
    instanceData[offset + 16] = typeof d === "number" && isFinite(d) ? d : 0.0;
    instanceData[offset + 17] = point._splitDirection ?? 0.0;
    instanceData[offset + 18] = 0.0;
    instanceData[offset + 19] = 0.0;

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

    // Same perInstanceFlags as the color path so pick obeys DP-H42/H40.
    const d = point._disableDepthTestDistance;
    instanceData[offset + 16] = typeof d === "number" && isFinite(d) ? d : 0.0;
    instanceData[offset + 17] = point._splitDirection ?? 0.0;
    instanceData[offset + 18] = 0.0;
    instanceData[offset + 19] = 0.0;

    visibleCount++;
  }

  return { instanceData, visibleCount };
}

// =========================================================================
// Pipeline Creation
// =========================================================================

/**
 * Instance vertex buffer layout — step mode = instance, 64 bytes stride.
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
    // DP-H42 / DP-H40 — perInstanceFlags (same contract as Billboard
    // @location(6) / Label @location(8)).
    { shaderLocation: 4, offset: 64, format: "float32x4" },
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
    name: `PointPrimitive ${translucent ? "translucent" : "opaque"} [${format}/${depthFormat}/defines=0x${defines.toString(16)}]`,
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
          format: format,
          blend: blendState,
        },
      ],
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
  const defineSets = [
    0,
    D.DISABLE_DEPTH_DISTANCE,
    D.SPLIT_ENABLED,
    D.DISABLE_DEPTH_DISTANCE | D.SPLIT_ENABLED,
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
 * @private
 */
function computePointDefinesForFrame(collection, frameState) {
  let defines = 0;
  const frameMin =
    typeof frameState?.minimumDisableDepthTestDistance === "number"
      ? frameState.minimumDisableDepthTestDistance
      : 0.0;
  if (frameMin !== 0.0) {
    defines |= ShaderDefine.DISABLE_DEPTH_DISTANCE;
  }
  const points = collection._pointPrimitives;
  const length = collection._pointPrimitivesLength;
  const both = ShaderDefine.DISABLE_DEPTH_DISTANCE | ShaderDefine.SPLIT_ENABLED;
  for (let i = 0; i < length; i++) {
    if ((defines & both) === both) {
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
  }
  let pipelineEntry = cache.pipelines.get(defines);
  if (!defined(pipelineEntry)) {
    const format = context.presentationFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const moduleCache = getPointShaderModuleCache(device);
    const shaderModule = moduleCache.getOrCreate(
      ShaderSourceId.POINT_PRIMITIVE_COLOR,
      colorShaderCode,
      defines,
      "PointPrimitive color shader",
    );
    pipelineEntry = {
      descriptor: buildPointColorDescriptor(
        device,
        shaderModule,
        format,
        depthFmt,
        true,
        cache.bindGroupLayout,
        defines,
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

  // Determine if we need to rebuild instance data. Also rebuild when the
  // active-defines bitmask changes — the per-instance buffer layout is
  // constant, but having distinct colorCommand pipelines means stale
  // commands can reference a pipeline that doesn't match this frame's
  // defines. Simplest fix: touch needsRebuild whenever defines rotate.
  const definesChanged = cache.lastDefines !== defines;
  const needsRebuild =
    !defined(cache.instanceBuffer) ||
    !defined(cache.colorCommand) ||
    collection._pointPrimitivesToUpdate.length > 0 ||
    cache.lastLength !== length ||
    definesChanged;
  cache.lastDefines = defines;

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

  // --- Instance buffer (rebuilt when points change) ---
  if (needsRebuild) {
    const { instanceData, visibleCount } = buildInstanceData(collection);

    if (visibleCount === 0) {
      cache.colorCommand = undefined;
      cache.lastLength = length;
      return;
    }

    // Create or resize instance buffer
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
        true, // mappedAtCreation = false, we'll writeBuffer
        "PointPrimitive instances",
      );
    }

    device.queue.writeBuffer(
      cache.instanceBuffer.buffer,
      0,
      instanceData.buffer,
      0,
      requiredSize,
    );

    cache.visibleCount = visibleCount;
    cache.lastLength = length;

    // Create draw command (instanced: 6 verts per quad, N instances)
    cache.colorCommand = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup],
      vertexBuffers: [cache.instanceBuffer],
      vertexCount: VERTICES_PER_QUAD,
      instanceCount: visibleCount,
      // pass:0 was a real bug (that value is Pass.ENVIRONMENT, not OPAQUE),
      // causing points to render before the globe surface and paint over
      // the sky. OPAQUE=8 or TRANSLUCENT=9 are the valid pass values.
      // Pick by collection.blendOption — point primitives use discard-based
      // alpha cutoffs so OPAQUE is safe when the collection is all-opaque.
      pass:
        collection._blendOption === 0
          ? 8 /* Pass.OPAQUE */
          : 9 /* Pass.TRANSLUCENT */,
      owner: collection,
      boundingVolume: collection._boundingVolume,
      modelMatrix: modelMatrix,
      cull: true,
    });

    // Clear the dirty list
    collection._pointPrimitivesToUpdate.length = 0;
  } else if (defined(cache.colorCommand)) {
    // Only update instance count if it changed
    cache.colorCommand.instanceCount = cache.visibleCount;
  }

  // C-R1-COLLECTIONS-PER-ENCODER (Batch 39) — forward the matching
  // render-state (`_rsOpaque` vs `_rsTranslucent`) onto the colorCommand.
  // PointPrimitiveCollection rebuilds these when `blendOption` changes
  // (line 624/639 in the collection) so we write them every frame to
  // stay in sync. The WebGL path does the equivalent at line 785 of
  // PointPrimitiveCollection.js.
  if (defined(cache.colorCommand)) {
    cache.colorCommand.renderState =
      cache.colorCommand.pass === 8 /* Pass.OPAQUE */
        ? collection._rsOpaque
        : collection._rsTranslucent;
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
    const format = context.presentationFormat || "bgra8unorm";
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
      true,
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

  if (defined(cache.instanceBuffer)) {
    cache.instanceBuffer.destroy();
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
