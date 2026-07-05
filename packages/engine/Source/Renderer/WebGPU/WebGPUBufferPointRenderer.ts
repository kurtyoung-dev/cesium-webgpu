/**
 * WebGPU Buffer Point Renderer
 *
 * Per-collection slice extracted from `WebGPUBufferPrimitiveRenderer`
 * (Batch 157 of the maintainability sweep — final batch in the
 * Buffer-primitive decomposition arc).
 *
 * Owns the BufferPointCollection rendering path: cache type, pipeline
 * builder, init / repack / upload / update / destroy functions. Points
 * are instanced — one quad per point, six vertices. Per-instance attrs
 * carry position, pick color, show/size/color, outline width/color;
 * per-vertex carries the corner offset in [-1, 1].
 *
 * The two public-API symbols (`updateWebGPUBufferPointCollection`,
 * `destroyWebGPUBufferPointCollection`) are re-exported from the
 * parent module so external callers (`WebGPUFeatureRenderers.ts`)
 * keep their existing import path.
 *
 * @module WebGPUBufferPointRenderer
 */

import Color from "../../Core/Color.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import AttributeCompression from "../../Core/AttributeCompression.js";
import SceneMode from "../../Scene/SceneMode.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { gpuData } from "./webgpuTypeHelpers.js";
import BufferPoint from "../../Scene/BufferPoint.js";
import BufferPointMaterial from "../../Scene/BufferPointMaterial.js";
import BufferPointMaterialWGSL from "../../Shaders/WebGPU/Collections/BufferPointMaterial.js";
import WasmRTEBridge from "../../Scene/WasmRTEBridge.js";
// Slice 5c-B Phase 1 (Batch 109) — scene-FB target helper. Used only
// for the COLOR pipeline variant; the PICK variant stays single-target
// because it runs in its own pick-FB render pass.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";

import {
  packCameraUniforms,
  preprocessShader,
  makeCameraBindGroupLayout,
  createSharedCacheBase,
  createVB,
  destroyPickIds,
  getBufferPrimitiveShaderCache,
  projectBufferPositionForMode,
  bufferModeNeedsRepack,
  computeBufferModeBoundingVolume,
  bufferPositionNormalizeDivisor,
  normalizeBufferPositionInPlace,
  scratchColor,
  scratchCart,
  scratchEnc,
} from "./WebGPUBufferPrimitiveRenderer.js";
import { ShaderSourceId, ShaderDefine } from "./WebGPUShaderDefines.js";
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";
import { computeNoDepthTest } from "./WebGPUCollectionRendererBase.js";
import BlendOption from "../../Scene/BlendOption.js";
import type {
  BufferPrimitiveCollection,
  CesiumPickIdRef,
  SharedCache,
} from "./WebGPUBufferPrimitiveRenderer.js";

// ─── Point-specific scratch ──────────────────────────────────────────────────
const scratchPoint = new BufferPoint();
const scratchPointMat = new BufferPointMaterial();

// NEW-BUFFERCOLL-WASM-ENCODE-WIRE (Batch 272) / NEW-BUFFERCOLL-ENCODE-BENCHMARK
// (Batch 273) — minimum dirty primitive count before the position high/low lanes
// are routed through the batch RTE encode (one contiguous `batchEncodeRange`
// call: WASM SIMD kernel when the module loads, byte-identical scalar fround
// twin otherwise) instead of the per-primitive scalar `EncodedCartesian3` loop.
//
// Tuned from measurement (Batch 273), NOT assumption — see
// Tools/wasm-encode-benchmark.mjs (real-kernel CPU encode) +
// Tools/visual-regression/probe-buffercoll-encode-benchmark.mjs (end-to-end
// repack+upload, both backends). Findings:
//   - The DOMINANT win is hoisting the position encode OUT of the per-primitive
//     loop (the per-point EncodedCartesian3 65536-grid split is the bottleneck),
//     NOT WASM SIMD. The batch fround split over a contiguous Float64Array beats
//     the per-primitive scalar path by ~25-40% end-to-end at >= 1500 points on
//     BOTH backends, even with the WASM kernel dark (JS fround twin running).
//   - The real WASM kernel (Node micro-bench) adds only ~1.2x over scalar fround
//     at 10k-50k and ties at 100k — below browser measurement noise, so no
//     WASM-specific gating is warranted.
//   - Crossover: batch loses below ~750 points (fixed slice-setup overhead),
//     is marginal at ~1000, and wins reliably from ~1500 up. Absolute repack
//     time below 1500 is < 0.5 ms/frame — negligible vs the frame budget.
// 2000 sits comfortably inside the winning region with margin against noise.
export const BUFFER_WASM_ENCODE_THRESHOLD = 2000;

// The effective threshold honors an optional per-collection override
// (`_wasmEncodeThresholdOverride`) so the parity probe can force the SAME large
// collection onto the scalar path (override = Number.POSITIVE_INFINITY) or the
// batch path (override = 0) and pixel-compare both encodes. Absent the override,
// the module default applies.
function effectiveEncodeThreshold(
  collection: BufferPrimitiveCollection,
): number {
  const override = (
    collection as unknown as { _wasmEncodeThresholdOverride?: number }
  )._wasmEncodeThresholdOverride;
  return typeof override === "number" ? override : BUFFER_WASM_ENCODE_THRESHOLD;
}

// ─── PointCache type ─────────────────────────────────────────────────────────
export interface PointCache extends SharedCache {
  paramsUBO: GPUBuffer;
  /** Second bind group carrying the params UBO; created lazily during build. */
  paramsBindGroup?: GPUBindGroup;
  quadVB: GPUBuffer;
  positionHigh: GPUBuffer;
  positionLow: GPUBuffer;
  pickColor: GPUBuffer;
  showSizeAndColor: GPUBuffer;
  outlineWidthAndOutlineColor: GPUBuffer;
  positionHighArr: Float32Array;
  positionLowArr: Float32Array;
  pickColorArr: Uint8Array;
  showSizeAndColorArr: Float32Array;
  outlineWidthAndOutlineColorArr: Float32Array;
  primitiveCountMax: number;
  pipeline: GPURenderPipeline;
  pickPipeline: GPURenderPipeline;
  // OPAQUE blend variant of the color pipeline; built lazily (see polygon).
  opaquePipeline?: GPURenderPipeline;
  // PARITY-BUFFER-2DCV — settled-2D/CV coplanar-depth variants (lazy).
  noDepthTestPipeline?: GPURenderPipeline;
  noDepthTestOpaquePipeline?: GPURenderPipeline;
  commandNoDepthTest?: boolean;
  shaderModule: GPUShaderModule;
  bgls: GPUBindGroupLayout[];
  sampleCount: number;
  format: GPUTextureFormat;
  bindGroup: GPUBindGroup;
  command: WebGPUDrawCommand | null;
  pickCommand: WebGPUDrawCommand | null;
  pickIds: CesiumPickIdRef[];
  commandBlendOption?: number;
  // NEW-BUFFERCOLL-WASM-ENCODE-WIRE (Batch 272) — lazily-instantiated RTE
  // bridge for the threshold-gated batch position encode. Created on the cache
  // (one per collection); `loadWasm()` is kicked off once on first use and the
  // module-level WASM-ready flag is shared across all bridges, so first frames
  // before the module resolves fall back to the scalar `EncodedCartesian3` path
  // (byte-equivalent in eye space). Destroyed in destroyWebGPUBufferPointCollection.
  rteBridge?: WasmRTEBridge;
  /** Instrumentation: how many repacks took the WASM/batch position path. */
  wasmEncodeRepacks: number;
  /** Instrumentation: how many repacks took the scalar position path. */
  scalarEncodeRepacks: number;
  // NEW-BUFFERCOLL-ENCODE-BENCHMARK (Batch 273) — debug-only repack+upload
  // timing accumulators, populated only under the debug pragma (stripped from
  // production builds). `_repackMsLast` is the most recent repack+writeBuffer
  // duration (ms); `_repackMsTotal`/`_repackSamples` let the benchmark probe
  // average across frames. Read via the probe; never consulted at runtime.
  _repackMsLast?: number;
  _repackMsTotal?: number;
  _repackSamples?: number;
}

// ─── Pipeline builder ────────────────────────────────────────────────────────
function buildPointPipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  format: GPUTextureFormat,
  bgls: GPUBindGroupLayout[],
  fragmentEntryPoint: string = "fragmentMain",
  sampleCount: number = 1,
  // When true, build the OPAQUE color variant: blend disabled + depth write
  // on (matches WebGL blend-off + depthTest.enabled). Default false keeps the
  // historical TRANSLUCENT color path byte-identical (depth write off).
  opaque: boolean = false,
  // PARITY-BUFFER-2DCV — settled-2D/CV coplanar variant: depth test "always" +
  // no depth write. Default false keeps the historical path byte-identical.
  noDepthTest: boolean = false,
): GPURenderPipeline {
  // Color path draws into the MSAA scene FB → sample count must match
  // `context._msaaSamples`; pick path renders into the single-sample pick FB.
  const isPickStage = fragmentEntryPoint === "fragmentPickMain";
  const multisample =
    !isPickStage && sampleCount > 1 ? { count: sampleCount } : undefined;
  return device.createRenderPipeline({
    label: `BufferPoint pipeline (${fragmentEntryPoint}, ms=${
      multisample?.count ?? 1
    })`,
    layout: device.createPipelineLayout({ bindGroupLayouts: bgls }),
    multisample,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [
        // Per-instance: positionHigh, positionLow, pickColor, showSizeColor, outline
        {
          arrayStride: 12,
          stepMode: "instance",
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        },
        {
          arrayStride: 12,
          stepMode: "instance",
          attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }],
        },
        {
          arrayStride: 4,
          stepMode: "instance",
          attributes: [{ shaderLocation: 2, offset: 0, format: "unorm8x4" }],
        },
        // showPixelSizeAndColor: vec4 [show, pixelSize, encodedRGB8, alpha].
        // Widened vec3 → vec4 (stride 12 → 16, float32x3 → float32x4) in
        // lockstep with showSizeAndColorArr (width 4) + the WGSL vec4 field.
        {
          arrayStride: 16,
          stepMode: "instance",
          attributes: [{ shaderLocation: 3, offset: 0, format: "float32x4" }],
        },
        // outlineWidthAndOutlineColor: vec3 [outlineWidth, encodedRGB8, alpha].
        // Widened vec2 → vec3 (stride 8 → 12, float32x2 → float32x3) in
        // lockstep with outlineWidthAndOutlineColorArr (width 3) + WGSL vec3.
        {
          arrayStride: 12,
          stepMode: "instance",
          attributes: [{ shaderLocation: 4, offset: 0, format: "float32x3" }],
        },
        // Per-vertex quad corner
        {
          arrayStride: 8,
          stepMode: "vertex",
          attributes: [{ shaderLocation: 5, offset: 0, format: "float32x2" }],
        },
      ],
    },
    // Slice 5c-B Phase 1 (Batch 109) — split the targets array by pick
    // vs color path. Pick pipelines run in a separate pick-FB render
    // pass (`WebGPUSceneRendererPickPass.ts`) and must stay
    // single-target; color pipelines route through `makeSceneFBTargets`
    // so the Phase 2 atomic flip picks up the 2nd null slot.
    fragment: (() => {
      const blend: GPUBlendState = {
        color: {
          srcFactor: "src-alpha",
          dstFactor: "one-minus-src-alpha",
        },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      };
      const isPick = fragmentEntryPoint === "fragmentPickMain";
      // OPAQUE color variant: no blend (overwrite). Pick path unchanged.
      const colorTargetOpts = opaque ? {} : { blend };
      const targets: Array<GPUColorTargetState | null> = isPick
        ? [{ format, blend }]
        : makeSceneFBTargets(format, colorTargetOpts);
      return {
        module: shaderModule,
        entryPoint: fragmentEntryPoint,
        targets,
      };
    })(),
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      // OPAQUE color variant writes depth (correct occlusion/sort vs WebGL);
      // TRANSLUCENT default keeps depth write off (composite back-to-front).
      // PARITY-BUFFER-2DCV: coplanar-2D/CV variant never writes depth.
      depthWriteEnabled: !noDepthTest && opaque,
      // less-equal (not less) — lets primitives that project exactly
      // onto the far plane due to FP32 rounding still pass the depth
      // test. Safe at planetary scale where the Z range is huge and
      // precision collapses near z=1. In settled 2D/CV the coplanar point
      // uses "always" so it draws over the flat map without z-fighting.
      depthCompare: noDepthTest ? "always" : "less-equal",
    },
  });
}

// ─── BufferPointCollection ───────────────────────────────────────────────────

function initPointCache(
  collection: BufferPrimitiveCollection,
  context: CesiumGraphicsContext,
  format: GPUTextureFormat,
  defines: number,
): PointCache {
  const device: GPUDevice = context.device;
  const primitiveCountMax: number = collection.primitiveCountMax;

  const positionHighArr = new Float32Array(primitiveCountMax * 3);
  const positionLowArr = new Float32Array(primitiveCountMax * 3);
  const pickColorArr = new Uint8Array(primitiveCountMax * 4);
  // width 4 per instance: [show, pixelSize, encodedRGB8(color), color.alpha].
  const showSizeAndColorArr = new Float32Array(primitiveCountMax * 4);
  // width 3 per instance: [outlineWidth, encodedRGB8(outlineColor), alpha].
  const outlineWidthAndOutlineColorArr = new Float32Array(
    primitiveCountMax * 3,
  );

  // NEW-BUFFER-LOG-DEPTH (Batch 263) — resolve `//>>ifdef LOG_DEPTH` against
  // `defines` and key the module cache by it so LOG_DEPTH on/off compile to
  // distinct modules. The pick FS suffix is appended inside preprocessShader
  // and never sees the frag_depth write (pick stays hyperbolic).
  const shaderSource = preprocessShader(
    context,
    "BufferPointMaterial",
    BufferPointMaterialWGSL,
    defines,
  );
  const shaderModule = getBufferPrimitiveShaderCache(device).getOrCreate(
    ShaderSourceId.BUFFER_POINT_MATERIAL,
    shaderSource,
    defines,
    "BufferPointMaterial",
  );
  const bgls = makeCameraBindGroupLayout(device, true);
  const sampleCount = context._msaaSamples ?? 1;
  const pipeline = buildPointPipeline(
    device,
    shaderModule,
    format,
    bgls,
    "fragmentMain",
    sampleCount,
  );
  const pickPipeline = buildPointPipeline(
    device,
    shaderModule,
    format,
    bgls,
    "fragmentPickMain",
  );

  const base = createSharedCacheBase(device);
  const paramsUBO = device.createBuffer({
    label: "BufferPoint params UBO",
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Quad geometry: 6 vertices forming two triangles, corner offsets in [-1,1]
  const quadData = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
  const quadVB = device.createBuffer({
    label: "BufferPoint quad VB",
    size: quadData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(quadVB, 0, gpuData(quadData));

  const cache: PointCache = {
    ...base,
    paramsUBO,
    quadVB,
    positionHigh: createVB(device, positionHighArr.byteLength, "ptHigh"),
    positionLow: createVB(device, positionLowArr.byteLength, "ptLow"),
    pickColor: createVB(device, pickColorArr.byteLength, "ptPick"),
    showSizeAndColor: createVB(
      device,
      showSizeAndColorArr.byteLength,
      "ptShow",
    ),
    outlineWidthAndOutlineColor: createVB(
      device,
      outlineWidthAndOutlineColorArr.byteLength,
      "ptOutline",
    ),
    positionHighArr,
    positionLowArr,
    pickColorArr,
    showSizeAndColorArr,
    outlineWidthAndOutlineColorArr,
    primitiveCountMax,
    pipeline,
    pickPipeline,
    shaderModule,
    bgls,
    sampleCount,
    format,
    bindGroup: device.createBindGroup({
      label: "BufferPoint camera BG",
      layout: bgls[0],
      entries: [{ binding: 0, resource: { buffer: base.cameraUBO } }],
    }),
    command: null,
    pickCommand: null,
    pickIds: [],
    wasmEncodeRepacks: 0,
    scalarEncodeRepacks: 0,
  };
  cache.paramsBindGroup = device.createBindGroup({
    label: "BufferPoint params BG",
    layout: bgls[1],
    entries: [{ binding: 0, resource: { buffer: paramsUBO } }],
  });
  return cache;
}

function repackPointDirty(
  collection: BufferPrimitiveCollection,
  cache: PointCache,
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  // PARITY-BUFFER-2DCV — when the scene-mode projection frame changed with no
  // per-primitive edits, the points are not individually `_dirty`; `force`
  // re-processes every point in the (full) dirty range so the reprojected
  // positions refresh. Always false in the SCENE3D steady state.
  force: boolean,
): void {
  const dirtyOffset: number = collection._dirtyOffset;
  const dirtyCount: number = collection._dirtyCount;
  if (dirtyCount === 0) {
    return;
  }
  // PARITY-BUFFER-2DCV — in 2D / Columbus View / Morph the encoded positions
  // are the scene-mode-projected positions (not raw ECEF), so the contiguous
  // batch encode over `_positionView` (which holds ECEF) does not apply; take
  // the per-point scalar path that runs each position through
  // `projectBufferPositionForMode`. SCENE3D is unaffected (byte-identical).
  const reproject = frameState.mode !== SceneMode.SCENE3D;
  const modelMatrix = collection.modelMatrix ?? Matrix4.IDENTITY;
  const allowPicking: boolean = collection._allowPicking;
  // PARITY-BUFFER-POSITION-INT-NORMALIZED — 0 for the DOUBLE/FLOAT and
  // non-normalized-integer cases (encode stays byte-identical); a positive
  // divisor for normalized integer positions, applied before the RTE encode.
  const normDivisor = bufferPositionNormalizeDivisor(collection);

  // NEW-BUFFERCOLL-WASM-ENCODE-WIRE (Batch 272) — for large dirty ranges, encode
  // the POSITION high/low lanes for the whole contiguous slice in one batch call
  // (WASM SIMD when the module is ready, byte-equivalent scalar fallback before).
  // Points have vertexOffset == index, so _positionView[i*3..] is contiguous over
  // [dirtyOffset, dirtyOffset+dirtyCount) and maps 1:1 onto positionHighArr[i*3..].
  // Color / pick / outline interleave stays in the per-primitive JS loop below.
  //
  // The batch encode (fround split) and the scalar EncodedCartesian3 (AGI
  // 65536-grid split) produce DIFFERENT high/low bytes but the SAME eye-space
  // position after the shader's (posHigh-camHigh)+(posLow-camLow) reconstruction
  // (both encodings satisfy high+low == value exactly in f64; the f32 RTE
  // cancellation rounds identically), so the on-screen result is unchanged.
  const positionView = collection._positionView;
  const useBatchPositionEncode =
    !reproject &&
    dirtyCount >= effectiveEncodeThreshold(collection) &&
    positionView instanceof Float64Array;
  if (useBatchPositionEncode) {
    let bridge = cache.rteBridge;
    if (bridge === undefined) {
      bridge = new WasmRTEBridge();
      cache.rteBridge = bridge;
      // Fire-and-forget: until this resolves, batchEncodeRange uses the
      // byte-equivalent scalar fallback, so there is no visible pop. The
      // module-level ready flag is shared, so any prior bridge load is reused.
      void bridge.loadWasm();
    }
    bridge.batchEncodeRange(
      positionView,
      dirtyOffset,
      dirtyCount,
      cache.positionHighArr,
      cache.positionLowArr,
      dirtyOffset,
    );
    cache.wasmEncodeRepacks++;
  } else {
    cache.scalarEncodeRepacks++;
  }

  for (let i = dirtyOffset; i < dirtyOffset + dirtyCount; i++) {
    collection.get(i, scratchPoint);
    if (!scratchPoint._dirty && !force) {
      continue;
    }
    if (allowPicking && scratchPoint._pickId === 0) {
      const pickId = context.createPickId(
        {
          collection,
          index: i,
          get primitive() {
            return collection.get(i, new BufferPoint());
          },
        },
        "buffer-primitive",
      );
      scratchPoint._pickId = pickId.key;
      cache.pickIds.push(pickId);
    }
    if (!useBatchPositionEncode) {
      scratchPoint.getPosition(scratchCart);
      // PARITY-BUFFER-POSITION-INT-NORMALIZED — dequantize the raw integer
      // position to [-1,1]/[0,1] before reproject/encode (matches WebGL GPU
      // normalize). No-op when normDivisor === 0.
      if (normDivisor !== 0) {
        normalizeBufferPositionInPlace(scratchCart, normDivisor);
      }
      // PARITY-BUFFER-2DCV — reproject ECEF → scene-mode frame in 2D/CV/Morph.
      // No-op clone in SCENE3D (byte-identical encode of the raw ECEF position).
      if (reproject) {
        projectBufferPositionForMode(
          scratchCart,
          frameState,
          modelMatrix,
          scratchCart,
        );
      }
      EncodedCartesian3.fromCartesian(scratchCart, scratchEnc);

      cache.positionHighArr[i * 3] = scratchEnc.high.x;
      cache.positionHighArr[i * 3 + 1] = scratchEnc.high.y;
      cache.positionHighArr[i * 3 + 2] = scratchEnc.high.z;
      cache.positionLowArr[i * 3] = scratchEnc.low.x;
      cache.positionLowArr[i * 3 + 1] = scratchEnc.low.y;
      cache.positionLowArr[i * 3 + 2] = scratchEnc.low.z;
    }
    scratchPoint.getMaterial(scratchPointMat);
    Color.fromRgba(scratchPoint._pickId, scratchColor);

    cache.pickColorArr[i * 4] = Color.floatToByte(scratchColor.red);
    cache.pickColorArr[i * 4 + 1] = Color.floatToByte(scratchColor.green);
    cache.pickColorArr[i * 4 + 2] = Color.floatToByte(scratchColor.blue);
    cache.pickColorArr[i * 4 + 3] = Color.floatToByte(scratchColor.alpha);

    // Fill: [show, size, encodedRGB8(color), color.alpha] — width 4.
    const s4 = i * 4;
    cache.showSizeAndColorArr[s4] = scratchPoint.show ? 1 : 0;
    cache.showSizeAndColorArr[s4 + 1] = scratchPointMat.size;
    cache.showSizeAndColorArr[s4 + 2] = AttributeCompression.encodeRGB8(
      scratchPointMat.color,
    );
    cache.showSizeAndColorArr[s4 + 3] = scratchPointMat.color.alpha;

    // Outline: [outlineWidth, encodedRGB8(outlineColor), outlineColor.alpha]
    // — width 3. At outlineWidth==0, substitute the fill color/alpha so the
    // AA outer ring doesn't bleed a stale outline color (P2 fix; mirrors
    // WebGL renderBufferPointCollection.js:237-246).
    const hasOutline = scratchPointMat.outlineWidth > 0;
    const o3 = i * 3;
    cache.outlineWidthAndOutlineColorArr[o3] = scratchPointMat.outlineWidth;
    cache.outlineWidthAndOutlineColorArr[o3 + 1] =
      AttributeCompression.encodeRGB8(
        hasOutline ? scratchPointMat.outlineColor : scratchPointMat.color,
      );
    cache.outlineWidthAndOutlineColorArr[o3 + 2] = hasOutline
      ? scratchPointMat.outlineColor.alpha
      : scratchPointMat.color.alpha;

    scratchPoint._dirty = false;
  }
}

function uploadPointBuffers(device: GPUDevice, cache: PointCache): void {
  device.queue.writeBuffer(
    cache.positionHigh,
    0,
    gpuData(cache.positionHighArr),
  );
  device.queue.writeBuffer(cache.positionLow, 0, gpuData(cache.positionLowArr));
  device.queue.writeBuffer(cache.pickColor, 0, gpuData(cache.pickColorArr));
  device.queue.writeBuffer(
    cache.showSizeAndColor,
    0,
    gpuData(cache.showSizeAndColorArr),
  );
  device.queue.writeBuffer(
    cache.outlineWidthAndOutlineColor,
    0,
    gpuData(cache.outlineWidthAndOutlineColorArr),
  );
}

const pointParamsScratch = new Float32Array(8);

export function updateWebGPUBufferPointCollection(
  collection: BufferPrimitiveCollection,
  frameState: CesiumFrameState,
): void {
  if (!collection.show) {
    return;
  }
  const context = frameState.context;
  const device: GPUDevice = context.device;
  // Batch 110 — buffer primitives draw into scene FB; use scenePipelineFormat.
  const format: GPUTextureFormat =
    (
      context as unknown as {
        scenePipelineFormat?: GPUTextureFormat;
      }
    ).scenePipelineFormat ??
    (navigator.gpu.getPreferredCanvasFormat() as GPUTextureFormat);

  // NEW-BUFFER-LOG-DEPTH (Batch 263) — pick up the renderer-wide log-depth
  // master switch + per-frame flag. Activating OR's the LOG_DEPTH define into
  // the shader/pipeline build; flipping it invalidates the cache so the
  // pipeline + module rebuild (mirrors the format-generation guard below). The
  // master switch off is byte-identical to the historical hyperbolic path.
  const logDepthActive = isWebGPULogDepthActive(context, frameState);
  const defines = logDepthActive ? ShaderDefine.LOG_DEPTH : 0;

  let cache = collection._webgpuCache as PointCache | undefined;
  // Batch 110 — invalidate on scene format change (HDR toggle).
  const sceneGen =
    (context as unknown as { _scenePipelineFormatGeneration?: number })
      ._scenePipelineFormatGeneration ?? 0;
  if (
    cache &&
    ((cache as unknown as { _pipelineFormatGeneration?: number })
      ._pipelineFormatGeneration !== sceneGen ||
      (cache as unknown as { _logDepthEnabled?: boolean })._logDepthEnabled !==
        logDepthActive)
  ) {
    cache = undefined;
    collection._webgpuCache = undefined;
  }
  if (!cache) {
    cache = initPointCache(collection, context, format, defines);
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
    (cache as unknown as { _logDepthEnabled?: boolean })._logDepthEnabled =
      logDepthActive;
    collection._webgpuCache = cache;
    collection._dirtyOffset = 0;
    collection._dirtyCount = collection.primitiveCount;
  }

  // PARITY-BUFFER-2DCV — when the scene-mode projection frame changed (mode
  // switch or, during MORPHING, a new morphTime) the previously-encoded
  // reprojected positions are stale. Force a full re-pack of every primitive.
  // No-op in the SCENE3D steady state (`bufferModeNeedsRepack` returns false).
  const modeRepack = bufferModeNeedsRepack(cache, frameState);
  if (modeRepack) {
    collection._dirtyOffset = 0;
    collection._dirtyCount = collection.primitiveCount;
  }

  if (collection._dirtyCount > 0) {
    // NEW-BUFFERCOLL-ENCODE-BENCHMARK (Batch 273) — time the repack (position
    // encode + color/pick/outline interleave) AND the writeBuffer upload of the
    // dirty range together, so the benchmark probe can compare the batch-encode
    // vs scalar-encode strategies WITH the GPU-upload cost in the picture (the
    // upload may dominate the CPU encode at high counts). Debug-only: the timer
    // calls + accumulator writes are pragma-stripped from production builds.
    //>>includeStart('debug', pragmas.debug);
    const _repackT0 = performance.now();
    //>>includeEnd('debug');
    repackPointDirty(collection, cache, context, frameState, modeRepack);
    uploadPointBuffers(device, cache);
    //>>includeStart('debug', pragmas.debug);
    const _repackDt = performance.now() - _repackT0;
    cache._repackMsLast = _repackDt;
    cache._repackMsTotal = (cache._repackMsTotal ?? 0) + _repackDt;
    cache._repackSamples = (cache._repackSamples ?? 0) + 1;
    //>>includeEnd('debug');
    cache.command = null;
    cache.pickCommand = null;
  }

  packCameraUniforms(
    cache.cameraData,
    context.uniformState,
    collection.modelMatrix ?? Matrix4.IDENTITY,
  );
  device.queue.writeBuffer(cache.cameraUBO, 0, gpuData(cache.cameraData));

  const pixelRatio = frameState.pixelRatio ?? 1.0;
  const vw = context.drawingBufferWidth || 1;
  const vh = context.drawingBufferHeight || 1;
  pointParamsScratch[0] = pixelRatio;
  pointParamsScratch[1] = 0;
  pointParamsScratch[2] = 0;
  pointParamsScratch[3] = 0;
  pointParamsScratch[4] = 0;
  pointParamsScratch[5] = 0;
  pointParamsScratch[6] = vw;
  pointParamsScratch[7] = vh;
  device.queue.writeBuffer(cache.paramsUBO, 0, gpuData(pointParamsScratch));

  const primitiveCount: number = collection.primitiveCount;
  if (primitiveCount === 0) {
    collection._dirtyCount = 0;
    collection._dirtyOffset = 0;
    return;
  }

  const vbs = [
    cache.positionHigh,
    cache.positionLow,
    cache.pickColor,
    cache.showSizeAndColor,
    cache.outlineWidthAndOutlineColor,
    cache.quadVB,
  ];
  const bgs = [cache.bindGroup, cache.paramsBindGroup];

  // blendOption: OPAQUE (blend off, depth write on, Pass.OPAQUE) vs default
  // TRANSLUCENT. Mirrors the WebGL RenderState/Pass branch.
  const isOpaque = collection._blendOption === BlendOption.OPAQUE;
  // PARITY-BUFFER-2DCV — settled 2D/CV coplanar-depth flag (no-op in 3D/morph).
  const noDepthTest = computeNoDepthTest(frameState);
  // NEW-BUFFERPOLYLINE-2D-EXTRUSION — culling BV in the render frame the
  // packed positions actually live in (3D → same reference, byte-identical).
  const modeBV = computeBufferModeBoundingVolume(collection, frameState, cache);

  if (frameState.passes.render) {
    if (
      cache.command &&
      (cache.commandBlendOption !== collection._blendOption ||
        cache.commandNoDepthTest !== noDepthTest)
    ) {
      cache.command = null;
    }
    if (!cache.command) {
      let colorPipeline;
      if (noDepthTest) {
        if (isOpaque) {
          if (!cache.noDepthTestOpaquePipeline) {
            cache.noDepthTestOpaquePipeline = buildPointPipeline(
              device,
              cache.shaderModule,
              cache.format,
              cache.bgls,
              "fragmentMain",
              cache.sampleCount,
              true,
              true,
            );
          }
          colorPipeline = cache.noDepthTestOpaquePipeline;
        } else {
          if (!cache.noDepthTestPipeline) {
            cache.noDepthTestPipeline = buildPointPipeline(
              device,
              cache.shaderModule,
              cache.format,
              cache.bgls,
              "fragmentMain",
              cache.sampleCount,
              false,
              true,
            );
          }
          colorPipeline = cache.noDepthTestPipeline;
        }
      } else if (isOpaque) {
        if (!cache.opaquePipeline) {
          cache.opaquePipeline = buildPointPipeline(
            device,
            cache.shaderModule,
            cache.format,
            cache.bgls,
            "fragmentMain",
            cache.sampleCount,
            true,
          );
        }
        colorPipeline = cache.opaquePipeline;
      } else {
        colorPipeline = cache.pipeline;
      }
      cache.command = new WebGPUDrawCommand({
        pipeline: colorPipeline,
        bindGroups: bgs,
        vertexBuffers: vbs,
        vertexCount: 6,
        instanceCount: primitiveCount,
        pass: isOpaque ? Pass.OPAQUE : Pass.TRANSLUCENT,
        boundingVolume: modeBV,
        debugShowBoundingVolume: collection.debugShowBoundingVolume,
      });
      cache.commandBlendOption = collection._blendOption;
      cache.commandNoDepthTest = noDepthTest;
    } else {
      cache.command.instanceCount = primitiveCount;
    }
    cache.command.boundingVolume = modeBV;
    cache.command.debugShowBoundingVolume =
      collection.debugShowBoundingVolume ?? false;
    frameState.commandList.push(cache.command);
  }

  if (frameState.passes.pick && collection._allowPicking) {
    if (!cache.pickCommand) {
      cache.pickCommand = new WebGPUDrawCommand({
        pipeline: cache.pickPipeline,
        bindGroups: bgs,
        vertexBuffers: vbs,
        vertexCount: 6,
        instanceCount: primitiveCount,
        pass: Pass.TRANSLUCENT,
        // FORK-34 (Batch 207) — mark as a dedicated pick command so the
        // pick pass dispatches it instead of skipping it as a base
        // (no-pick-variant) command.
        pickOnly: true,
      });
    } else {
      cache.pickCommand.instanceCount = primitiveCount;
    }
    frameState.commandList.push(cache.pickCommand);
  }

  collection._dirtyCount = 0;
  collection._dirtyOffset = 0;
}

export function destroyWebGPUBufferPointCollection(
  collection: BufferPrimitiveCollection,
): void {
  const cache = collection._webgpuCache as PointCache | undefined;
  if (!cache) {
    return;
  }
  destroyPickIds(cache);
  // NEW-BUFFERCOLL-WASM-ENCODE-WIRE (Batch 272) — release the RTE bridge's
  // arena/version handle. The bridge's destroy() is idempotent and the WASM
  // module is shared, so this only frees this collection's buffer claim.
  cache.rteBridge?.destroy();
  cache.rteBridge = undefined;
  cache.cameraUBO.destroy();
  cache.paramsUBO.destroy();
  cache.quadVB.destroy();
  cache.positionHigh.destroy();
  cache.positionLow.destroy();
  cache.pickColor.destroy();
  cache.showSizeAndColor.destroy();
  cache.outlineWidthAndOutlineColor.destroy();
  collection._webgpuCache = undefined;
}
