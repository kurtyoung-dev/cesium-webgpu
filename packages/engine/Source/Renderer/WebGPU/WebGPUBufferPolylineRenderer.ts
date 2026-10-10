/**
 * WebGPU Buffer Polyline Renderer
 *
 * Per-collection renderer used by `WebGPUBufferPrimitiveRenderer`.
 *
 * Owns the BufferPolylineCollection rendering path: cache type,
 * pipeline builder, init / repack / upload / update / destroy
 * functions. Each polyline vertex is duplicated (one per side of the
 * line); the shader extrudes the segment quad using prev/next position
 * attributes that are precomputed here.
 *
 * The two public-API symbols (`updateWebGPUBufferPolylineCollection`,
 * `destroyWebGPUBufferPolylineCollection`) are re-exported from the
 * parent module so external callers (`WebGPUFeatureRenderers.ts`)
 * keep their existing import path.
 *
 * @module WebGPUBufferPolylineRenderer
 */

import Cartesian3 from "../../Core/Cartesian3.js";
import Color from "../../Core/Color.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import AttributeCompression from "../../Core/AttributeCompression.js";
import IndexDatatype from "../../Core/IndexDatatype.js";
import SceneMode from "../../Scene/SceneMode.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { gpuData, jsModule, numericArray } from "./webgpuTypeHelpers.js";
import BufferPolyline from "../../Scene/BufferPolyline.js";
import BufferPolylineMaterial from "../../Scene/BufferPolylineMaterial.js";
import BufferPolylineMaterialWGSL from "../../Shaders/WebGPU/Collections/BufferPolylineMaterial.js";
// Builds fragment targets that match the active scene framebuffer.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";

import {
  packCameraUniforms,
  preprocessShader,
  preprocessPickShader,
  BUFFER_PICK_MODULE_KEYSALT,
  makeCameraBindGroupLayout,
  createSharedCacheBase,
  createVB,
  createIB,
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
import {
  isWebGPULogDepthActive,
  isWebGPUPickLogDepthActive,
} from "./WebGPULogDepth.js";
import { computeNoDepthTest } from "./WebGPUCollectionRendererBase.js";
import BlendOption from "../../Scene/BlendOption.js";
import type {
  BufferPrimitiveCollection,
  CesiumPickIdRef,
  SharedCache,
  IndexDatatypeStatics,
} from "./WebGPUBufferPrimitiveRenderer.js";

// ─── Polyline-specific scratch ───────────────────────────────────────────────
const scratchPolyline = new BufferPolyline();
const scratchPolylineMat = new BufferPolylineMaterial();
const scratchPrev = new Cartesian3();
const scratchNext = new Cartesian3();
const scratchPrevEnc = { high: new Cartesian3(), low: new Cartesian3() };
const scratchNextEnc = { high: new Cartesian3(), low: new Cartesian3() };

// Floats per vertex copy in the interleaved slot-7 buffer: the
// showColorWidthAndTexCoord vec4 at floats 0-3 (location 7), alpha at float 4
// (location 8) and the expand direction at float 5 (location 9). The pack, the
// allocation and the pipeline's arrayStride all read it.
const POLYLINE_RECORD_FLOATS = 6;

// ─── PolylineCache type ──────────────────────────────────────────────────────
export interface PolylineCache extends SharedCache {
  paramsUBO: GPUBuffer;
  /** Second bind group carrying the params UBO; created lazily during build. */
  paramsBindGroup?: GPUBindGroup;
  positionHigh: GPUBuffer;
  positionLow: GPUBuffer;
  prevPositionHigh: GPUBuffer;
  prevPositionLow: GPUBuffer;
  nextPositionHigh: GPUBuffer;
  nextPositionLow: GPUBuffer;
  pickColor: GPUBuffer;
  // This interleaved buffer carries location 7 (vec4
  // showColorWidthAndTexCoord), location 8 (f32 alpha) and location 9 (f32
  // expand direction) so the polyline pipeline stays within WebGPU's
  // 8-vertex-buffer limit. Its array holds POLYLINE_RECORD_FLOATS per vertex.
  showColorWidthAndTexCoord: GPUBuffer;
  indexBuffer: GPUBuffer;
  positionHighArr: Float32Array;
  positionLowArr: Float32Array;
  prevPositionHighArr: Float32Array;
  prevPositionLowArr: Float32Array;
  nextPositionHighArr: Float32Array;
  nextPositionLowArr: Float32Array;
  pickColorArr: Uint8Array;
  showColorWidthAndTexCoordArr: Float32Array;
  indexArr: Uint16Array | Uint32Array;
  indexFormat: GPUIndexFormat;
  vertexCountMax: number;
  pipeline: GPURenderPipeline;
  pickPipeline: GPURenderPipeline;
  // OPAQUE blend variant of the color pipeline; built lazily (see polygon).
  opaquePipeline?: GPURenderPipeline;
  // Settled 2D/CV coplanar-depth variants are built lazily.
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
}

// ─── Pipeline builder ────────────────────────────────────────────────────────
function buildPolylinePipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  format: GPUTextureFormat,
  bgls: GPUBindGroupLayout[],
  fragmentEntryPoint: string = "fragmentMain",
  sampleCount: number = 1,
  // When true, build the opaque color variant with blending disabled.
  // The default translucent variant uses blending; both write depth.
  opaque: boolean = false,
  // Settled 2D and Columbus View use a coplanar variant with an always depth
  // comparison and no depth writes.
  noDepthTest: boolean = false,
  // The pick-log switch only selects the diagnostic label here; the pick shader
  // module supplies logarithmic fragment depth. Color pipelines ignore it.
  pickLogActive: boolean = false,
): GPURenderPipeline {
  const float3 = (loc: number): GPUVertexBufferLayout => ({
    arrayStride: 12,
    attributes: [{ shaderLocation: loc, offset: 0, format: "float32x3" }],
  });
  // Color path draws into the MSAA scene FB → sample count must match
  // `context._msaaSamples`; pick path renders into the single-sample pick FB.
  const isPickStage = fragmentEntryPoint === "fragmentPickMain";
  const multisample =
    !isPickStage && sampleCount > 1 ? { count: sampleCount } : undefined;
  return device.createRenderPipeline({
    label: `BufferPolyline pipeline (${fragmentEntryPoint}, ms=${
      multisample?.count ?? 1
    })${isPickStage && pickLogActive ? " [ld]" : ""}`,
    layout: device.createPipelineLayout({ bindGroupLayouts: bgls }),
    multisample,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [
        float3(0),
        float3(1),
        float3(2),
        float3(3),
        float3(4),
        float3(5),
        {
          arrayStride: 4,
          attributes: [{ shaderLocation: 6, offset: 0, format: "unorm8x4" }],
        },
        // Locations 7, 8 and 9 share one interleaved buffer: the vec4 is at
        // offset 0, alpha at offset 16 and the expand direction at offset 20.
        // This keeps the pipeline at WebGPU's guaranteed limit of eight vertex
        // buffers.
        {
          arrayStride: POLYLINE_RECORD_FLOATS * 4,
          attributes: [
            { shaderLocation: 7, offset: 0, format: "float32x4" },
            { shaderLocation: 8, offset: 16, format: "float32" },
            { shaderLocation: 9, offset: 20, format: "float32" },
          ],
        },
      ],
    },
    // Picking uses its separate single-target framebuffer; color targets are
    // built to match the scene framebuffer's attachment topology.
    fragment: (() => {
      const blend: GPUBlendState = {
        color: {
          srcFactor: "src-alpha",
          dstFactor: "one-minus-src-alpha",
        },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      };
      const isPick = fragmentEntryPoint === "fragmentPickMain";
      // The opaque color variant overwrites, while the translucent color and
      // pick variants keep alpha blending.
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
      // The coplanar 2D/CV variant never writes depth.
      depthWriteEnabled: !noDepthTest,
      // less-equal (not less) — lets primitives that project exactly
      // onto the far plane due to FP32 rounding still pass the depth
      // test. Safe at planetary scale where the Z range is huge and
      // precision collapses near z=1. In settled 2D/CV the coplanar line
      // uses "always" so it draws over the flat map without z-fighting.
      depthCompare: noDepthTest ? "always" : "less-equal",
    },
  });
}

// ─── BufferPolylineCollection ────────────────────────────────────────────────

function initPolylineCache(
  collection: BufferPrimitiveCollection,
  context: CesiumGraphicsContext,
  format: GPUTextureFormat,
  defines: number,
  // Pick-log depth is controlled independently of the color shader defines.
  pickLogActive: boolean,
): PolylineCache {
  const device: GPUDevice = context.device;
  const vertexCountMax: number = collection.vertexCountMax * 2; // each vertex written twice
  const segmentCountMax: number =
    collection.vertexCountMax - collection.primitiveCount;

  const f3 = () => new Float32Array(vertexCountMax * 3);
  const positionHighArr = f3();
  const positionLowArr = f3();
  const prevPositionHighArr = f3();
  const prevPositionLowArr = f3();
  const nextPositionHighArr = f3();
  const nextPositionLowArr = f3();
  const pickColorArr = new Uint8Array(vertexCountMax * 4);
  // One record per vertex copy: the vec4, then alpha and the expand direction.
  const showColorWidthAndTexCoordArr = new Float32Array(
    vertexCountMax * POLYLINE_RECORD_FLOATS,
  );
  const indexArr = jsModule<IndexDatatypeStatics>(
    IndexDatatype,
  ).createTypedArray(vertexCountMax, segmentCountMax * 6);
  const indexFormat: GPUIndexFormat =
    indexArr instanceof Uint32Array ? "uint32" : "uint16";

  // Resolve the log-depth pragma against `defines` and include the result in
  // the module-cache key so enabled and disabled variants stay distinct.
  const shaderSource = preprocessShader(
    context,
    "BufferPolylineMaterial",
    BufferPolylineMaterialWGSL,
    defines,
  );
  const shaderModule = getBufferPrimitiveShaderCache(device).getOrCreate(
    ShaderSourceId.BUFFER_POLYLINE_MATERIAL,
    shaderSource,
    defines,
    "BufferPolylineMaterial",
  );
  // The pick fleet has an independent log-depth switch. Its enabled variant
  // preprocesses both the source and pick suffix so `v_logDepth` is available
  // to the fragment shader. The key salt prevents it from aliasing a color
  // module with the same source identifier and define bits.
  const pickDefines =
    (defines & ~ShaderDefine.LOG_DEPTH) |
    (pickLogActive ? ShaderDefine.LOG_DEPTH : 0);
  const pickModule = pickLogActive
    ? getBufferPrimitiveShaderCache(device).getOrCreate(
        ShaderSourceId.BUFFER_POLYLINE_MATERIAL,
        preprocessPickShader(
          context,
          "BufferPolylineMaterial",
          BufferPolylineMaterialWGSL,
          pickDefines,
        ),
        pickDefines,
        "BufferPolylineMaterial [ld pick]",
        BUFFER_PICK_MODULE_KEYSALT,
      )
    : shaderModule;
  const bgls = makeCameraBindGroupLayout(device, true);
  const sampleCount = context._msaaSamples ?? 1;
  const pipeline = buildPolylinePipeline(
    device,
    shaderModule,
    format,
    bgls,
    "fragmentMain",
    sampleCount,
  );
  // The pick pipeline targets the context's byte-object-ID format, matching
  // the pick framebuffer rather than a possibly floating-point scene format.
  // Its selected module supplies logarithmic fragment depth when enabled.
  const pickPipeline = buildPolylinePipeline(
    device,
    pickModule,
    context.pickPipelineFormat ?? "rgba8unorm",
    bgls,
    "fragmentPickMain",
    1,
    false,
    false,
    pickLogActive,
  );

  const base = createSharedCacheBase(device);
  const paramsUBO = device.createBuffer({
    label: "BufferPolyline params UBO",
    // pixelRatio + 3 pad + viewport vec4 + viewportTransformation mat4
    // + viewportOrthographic mat4
    size: 160,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const cache: PolylineCache = {
    ...base,
    paramsUBO,
    positionHigh: createVB(device, positionHighArr.byteLength, "lineHigh"),
    positionLow: createVB(device, positionLowArr.byteLength, "lineLow"),
    prevPositionHigh: createVB(
      device,
      prevPositionHighArr.byteLength,
      "linePrevHigh",
    ),
    prevPositionLow: createVB(
      device,
      prevPositionLowArr.byteLength,
      "linePrevLow",
    ),
    nextPositionHigh: createVB(
      device,
      nextPositionHighArr.byteLength,
      "lineNextHigh",
    ),
    nextPositionLow: createVB(
      device,
      nextPositionLowArr.byteLength,
      "lineNextLow",
    ),
    pickColor: createVB(device, pickColorArr.byteLength, "linePick"),
    showColorWidthAndTexCoord: createVB(
      device,
      showColorWidthAndTexCoordArr.byteLength,
      "lineShow",
    ),
    indexBuffer: createIB(device, indexArr.byteLength, "lineIdx"),
    positionHighArr,
    positionLowArr,
    prevPositionHighArr,
    prevPositionLowArr,
    nextPositionHighArr,
    nextPositionLowArr,
    pickColorArr,
    showColorWidthAndTexCoordArr,
    indexArr,
    indexFormat,
    vertexCountMax,
    pipeline,
    pickPipeline,
    shaderModule,
    bgls,
    sampleCount,
    format,
    bindGroup: device.createBindGroup({
      label: "BufferPolyline camera BG",
      layout: bgls[0],
      entries: [{ binding: 0, resource: { buffer: base.cameraUBO } }],
    }),
    command: null,
    pickCommand: null,
    pickIds: [],
  };
  // Stash second bind group for params on cache for command attachment
  cache.paramsBindGroup = device.createBindGroup({
    label: "BufferPolyline params BG",
    layout: bgls[1],
    entries: [{ binding: 0, resource: { buffer: paramsUBO } }],
  });
  return cache;
}

function repackPolylineDirty(
  collection: BufferPrimitiveCollection,
  cache: PolylineCache,
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  // `force` reprocesses every polyline in the dirty range when the scene-mode
  // projection frame changed with no per-primitive edits.
  force: boolean,
): void {
  const dirtyOffset: number = collection._dirtyOffset;
  const dirtyCount: number = collection._dirtyCount;
  if (dirtyCount === 0) {
    return;
  }
  const allowPicking: boolean = collection._allowPicking;
  // In 2D, Columbus View, and morphing, project each raw ECEF position into the
  // scene-mode frame before endpoint extrapolation so the miter
  // adjacency is computed in the projected frame (mirrors WebGL's per-vertex
  // projection). Scene 3D keeps the raw-ECEF encode.
  const reproject = frameState.mode !== SceneMode.SCENE3D;
  const modelMatrix = collection.modelMatrix ?? Matrix4.IDENTITY;
  // This divisor is zero unless the collection stores normalized integer
  // positions. Apply it to every raw position read (current + prev/next
  // adjacency) before the scene-mode reproject and the RTE encode.
  const normDivisor = bufferPositionNormalizeDivisor(collection);
  // A negative packed width marks ground metres (converted to device pixels
  // by BufferPolylineMaterial.wgsl's csm_metersPerPixel branch); `widthUnits`
  // is fixed at collection construction (no setter — BufferPolylineCollection
  // .js has no `set widthUnits`), so this is derived once per update and
  // hoisted out of the per-primitive loop below, mirroring the WebGL
  // reference's hoist at renderBufferPolylineCollection.js:174.
  const widthInMeters = collection.widthUnits === "meters";
  for (let i = dirtyOffset; i < dirtyOffset + dirtyCount; i++) {
    collection.get(i, scratchPolyline);
    if (!scratchPolyline._dirty && !force) {
      continue;
    }

    if (allowPicking && scratchPolyline._pickId === 0) {
      const pickId = context.createPickId(
        {
          collection,
          index: i,
          get primitive() {
            return collection.get(i, new BufferPolyline());
          },
        },
        "buffer-primitive",
      );
      scratchPolyline._pickId = pickId.key;
      cache.pickIds.push(pickId);
    }

    const positions = scratchPolyline.getPositions();
    scratchPolyline.getMaterial(scratchPolylineMat);
    const encodedColor = AttributeCompression.encodeRGB8(
      scratchPolylineMat.color,
    );
    // Material color.alpha [0,1] → dedicated alpha lane. The shader folds it
    // into v_color.a so the `outColor.a < 0.005` discard is live for
    // translucent lines. Mirrors WebGL's `alpha` attribute.
    const colorAlpha = scratchPolylineMat.color.alpha;
    Color.fromRgba(scratchPolyline._pickId, scratchColor);
    const show = scratchPolyline.show;
    // A negative magnitude is the ground-metres convention BufferPolylineMaterial
    // .wgsl's sign test reads (csm_metersPerPixel converts it to device pixels
    // at each vertex's depth); a positive one stays a CSS-pixel width, which
    // that shader scales to device pixels by `params.pixelRatio` as before.
    // Mirrors renderBufferPolylineCollection.js:225's `signedWidth`. The CPU
    // sign and the shader branch are one convention — both must land together.
    const signedWidth = widthInMeters
      ? -scratchPolylineMat.width
      : scratchPolylineMat.width;

    let vOffset = scratchPolyline.vertexOffset * 2;
    let iOffset = (scratchPolyline.vertexOffset - i) * 6;

    for (let j = 0, jl = scratchPolyline.vertexCount; j < jl; j++) {
      const isFirst = j === 0;
      const isLast = j === jl - 1;
      Cartesian3.fromArray(numericArray(positions), j * 3, scratchCart);
      if (normDivisor !== 0) {
        normalizeBufferPositionInPlace(scratchCart, normDivisor);
      }
      if (reproject) {
        projectBufferPositionForMode(
          scratchCart,
          frameState,
          modelMatrix,
          scratchCart,
        );
      }
      if (isFirst) {
        Cartesian3.fromArray(numericArray(positions), (j + 1) * 3, scratchNext);
        if (normDivisor !== 0) {
          normalizeBufferPositionInPlace(scratchNext, normDivisor);
        }
        if (reproject) {
          projectBufferPositionForMode(
            scratchNext,
            frameState,
            modelMatrix,
            scratchNext,
          );
        }
        Cartesian3.subtract(scratchCart, scratchNext, scratchPrev);
        Cartesian3.add(scratchCart, scratchPrev, scratchPrev);
      } else if (isLast) {
        Cartesian3.fromArray(numericArray(positions), (j - 1) * 3, scratchPrev);
        if (normDivisor !== 0) {
          normalizeBufferPositionInPlace(scratchPrev, normDivisor);
        }
        if (reproject) {
          projectBufferPositionForMode(
            scratchPrev,
            frameState,
            modelMatrix,
            scratchPrev,
          );
        }
        Cartesian3.subtract(scratchCart, scratchPrev, scratchNext);
        Cartesian3.add(scratchCart, scratchNext, scratchNext);
      } else {
        Cartesian3.fromArray(numericArray(positions), (j - 1) * 3, scratchPrev);
        Cartesian3.fromArray(numericArray(positions), (j + 1) * 3, scratchNext);
        if (normDivisor !== 0) {
          normalizeBufferPositionInPlace(scratchPrev, normDivisor);
          normalizeBufferPositionInPlace(scratchNext, normDivisor);
        }
        if (reproject) {
          projectBufferPositionForMode(
            scratchPrev,
            frameState,
            modelMatrix,
            scratchPrev,
          );
          projectBufferPositionForMode(
            scratchNext,
            frameState,
            modelMatrix,
            scratchNext,
          );
        }
      }

      if (!isLast) {
        cache.indexArr[iOffset] = vOffset;
        cache.indexArr[iOffset + 1] = vOffset + 1;
        cache.indexArr[iOffset + 2] = vOffset + 2;
        cache.indexArr[iOffset + 3] = vOffset + 2;
        cache.indexArr[iOffset + 4] = vOffset + 1;
        cache.indexArr[iOffset + 5] = vOffset + 3;
        iOffset += 6;
      }

      EncodedCartesian3.fromCartesian(scratchCart, scratchEnc);
      EncodedCartesian3.fromCartesian(scratchPrev, scratchPrevEnc);
      EncodedCartesian3.fromCartesian(scratchNext, scratchNextEnc);

      // WebGL's texCoord (renderBufferPolylineCollection.js packs j / (jl - 1)),
      // stored unaltered: BufferPolylineMaterialVS.glsl takes usePrevious from
      // texCoord == 1.0, which holds at the last vertex only.
      const texCoordS = jl > 1 ? j / (jl - 1) : 0;
      for (let k = 0; k < 2; k++) {
        const v3 = vOffset * 3;
        const v4 = vOffset * 4;
        // The interleaved record (vec4, alpha, expand direction) shares the
        // loc7 buffer, which keeps the pipeline at eight vertex buffers.
        // pickColor stays width 4 (`v4`).
        const vRecord = vOffset * POLYLINE_RECORD_FLOATS;
        cache.positionHighArr[v3] = scratchEnc.high.x;
        cache.positionHighArr[v3 + 1] = scratchEnc.high.y;
        cache.positionHighArr[v3 + 2] = scratchEnc.high.z;
        cache.positionLowArr[v3] = scratchEnc.low.x;
        cache.positionLowArr[v3 + 1] = scratchEnc.low.y;
        cache.positionLowArr[v3 + 2] = scratchEnc.low.z;
        cache.prevPositionHighArr[v3] = scratchPrevEnc.high.x;
        cache.prevPositionHighArr[v3 + 1] = scratchPrevEnc.high.y;
        cache.prevPositionHighArr[v3 + 2] = scratchPrevEnc.high.z;
        cache.prevPositionLowArr[v3] = scratchPrevEnc.low.x;
        cache.prevPositionLowArr[v3 + 1] = scratchPrevEnc.low.y;
        cache.prevPositionLowArr[v3 + 2] = scratchPrevEnc.low.z;
        cache.nextPositionHighArr[v3] = scratchNextEnc.high.x;
        cache.nextPositionHighArr[v3 + 1] = scratchNextEnc.high.y;
        cache.nextPositionHighArr[v3 + 2] = scratchNextEnc.high.z;
        cache.nextPositionLowArr[v3] = scratchNextEnc.low.x;
        cache.nextPositionLowArr[v3 + 1] = scratchNextEnc.low.y;
        cache.nextPositionLowArr[v3 + 2] = scratchNextEnc.low.z;
        cache.pickColorArr[v4] = Color.floatToByte(scratchColor.red);
        cache.pickColorArr[v4 + 1] = Color.floatToByte(scratchColor.green);
        cache.pickColorArr[v4 + 2] = Color.floatToByte(scratchColor.blue);
        cache.pickColorArr[v4 + 3] = Color.floatToByte(scratchColor.alpha);
        cache.showColorWidthAndTexCoordArr[vRecord] = show ? 1 : 0;
        cache.showColorWidthAndTexCoordArr[vRecord + 1] = encodedColor;
        cache.showColorWidthAndTexCoordArr[vRecord + 2] = signedWidth;
        cache.showColorWidthAndTexCoordArr[vRecord + 3] = texCoordS;
        cache.showColorWidthAndTexCoordArr[vRecord + 4] = colorAlpha;
        // The side of the line this copy is extruded to, in its own lane so
        // both it and texCoord round-trip exactly: WebGL's expandDir,
        // gl_VertexID % 2 == 1 ? 1.0 : -1.0, and every polyline starts on an
        // even vertex, so the first copy is -1.0 and the second +1.0.
        cache.showColorWidthAndTexCoordArr[vRecord + 5] = k === 0 ? -1.0 : 1.0;
        vOffset++;
      }
    }

    scratchPolyline._dirty = false;
  }
}

function uploadPolylineBuffers(device: GPUDevice, cache: PolylineCache): void {
  device.queue.writeBuffer(
    cache.positionHigh,
    0,
    gpuData(cache.positionHighArr),
  );
  device.queue.writeBuffer(cache.positionLow, 0, gpuData(cache.positionLowArr));
  device.queue.writeBuffer(
    cache.prevPositionHigh,
    0,
    gpuData(cache.prevPositionHighArr),
  );
  device.queue.writeBuffer(
    cache.prevPositionLow,
    0,
    gpuData(cache.prevPositionLowArr),
  );
  device.queue.writeBuffer(
    cache.nextPositionHigh,
    0,
    gpuData(cache.nextPositionHighArr),
  );
  device.queue.writeBuffer(
    cache.nextPositionLow,
    0,
    gpuData(cache.nextPositionLowArr),
  );
  device.queue.writeBuffer(cache.pickColor, 0, gpuData(cache.pickColorArr));
  device.queue.writeBuffer(
    cache.showColorWidthAndTexCoord,
    0,
    gpuData(cache.showColorWidthAndTexCoordArr),
  );
  device.queue.writeBuffer(cache.indexBuffer, 0, gpuData(cache.indexArr));
}

const polylineParamsScratch = new Float32Array(40);
const polylineParamsViewport = { x: 0, y: 0, width: 1, height: 1 };
const scratchViewportTransformation = new Matrix4();
const scratchViewportOrthographic = new Matrix4();

export function updateWebGPUBufferPolylineCollection(
  collection: BufferPrimitiveCollection,
  frameState: CesiumFrameState,
): void {
  if (!collection.show) {
    return;
  }
  const context = frameState.context;
  const device: GPUDevice = context.device;
  // Buffer primitives draw into the scene framebuffer, whose format may differ
  // from the preferred canvas format.
  const format: GPUTextureFormat =
    (
      context as unknown as {
        scenePipelineFormat?: GPUTextureFormat;
      }
    ).scenePipelineFormat ??
    (navigator.gpu.getPreferredCanvasFormat() as GPUTextureFormat);

  // A scene log-depth state change invalidates the cache so the shader module
  // and pipeline rebuild together.
  const logDepthActive = isWebGPULogDepthActive(context, frameState);
  const defines = logDepthActive ? ShaderDefine.LOG_DEPTH : 0;
  // Track the independent pick-log switch alongside the scene format and
  // color-log state because a change requires a new pick module and pipeline.
  const pickLogActive = isWebGPUPickLogDepthActive(context, frameState);

  let cache = collection._webgpuCache as PolylineCache | undefined;
  // Invalidate pipelines when the scene format generation changes.
  const sceneGen =
    (context as unknown as { _scenePipelineFormatGeneration?: number })
      ._scenePipelineFormatGeneration ?? 0;
  if (
    cache &&
    ((cache as unknown as { _pipelineFormatGeneration?: number })
      ._pipelineFormatGeneration !== sceneGen ||
      (cache as unknown as { _logDepthEnabled?: boolean })._logDepthEnabled !==
        logDepthActive ||
      (cache as unknown as { _pickLogDepthEnabled?: boolean })
        ._pickLogDepthEnabled !== pickLogActive)
  ) {
    cache = undefined;
    collection._webgpuCache = undefined;
  }
  if (!cache) {
    cache = initPolylineCache(
      collection,
      context,
      format,
      defines,
      pickLogActive,
    );
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
    (cache as unknown as { _logDepthEnabled?: boolean })._logDepthEnabled =
      logDepthActive;
    (
      cache as unknown as { _pickLogDepthEnabled?: boolean }
    )._pickLogDepthEnabled = pickLogActive;
    collection._webgpuCache = cache;
    collection._dirtyOffset = 0;
    collection._dirtyCount = collection.primitiveCount;
  }

  // Force a full repack when the scene-mode projection
  // frame changed (no-op in the SCENE3D steady state).
  const modeRepack = bufferModeNeedsRepack(cache, frameState);
  if (modeRepack) {
    collection._dirtyOffset = 0;
    collection._dirtyCount = collection.primitiveCount;
  }

  if (collection._dirtyCount > 0) {
    repackPolylineDirty(collection, cache, context, frameState, modeRepack);
    uploadPolylineBuffers(device, cache);
    cache.command = null;
    cache.pickCommand = null;
  }

  packCameraUniforms(
    cache.cameraData,
    context.uniformState,
    collection.modelMatrix ?? Matrix4.IDENTITY,
  );
  device.queue.writeBuffer(cache.cameraUBO, 0, gpuData(cache.cameraData));

  // Params: pixelRatio + viewport + viewport matrices
  const pixelRatio = frameState.pixelRatio ?? 1.0;
  const vw = context.drawingBufferWidth || 1;
  const vh = context.drawingBufferHeight || 1;
  polylineParamsScratch[0] = pixelRatio;
  polylineParamsScratch[1] = 0;
  polylineParamsScratch[2] = 0;
  polylineParamsScratch[3] = 0;
  polylineParamsScratch[4] = 0;
  polylineParamsScratch[5] = 0;
  polylineParamsScratch[6] = vw;
  polylineParamsScratch[7] = vh;
  // The window-coordinate law's two viewport matrices over the drawing
  // buffer, derived as the primitive polyline path derives them: NDC to window
  // pixels (depth range 0 to 1), and window pixels back to clip space in this
  // context's clip-space convention.
  polylineParamsViewport.width = vw;
  polylineParamsViewport.height = vh;
  Matrix4.computeViewportTransformation(
    polylineParamsViewport,
    0.0,
    1.0,
    scratchViewportTransformation,
  );
  Matrix4.computeOrthographicOffCenter(
    0.0,
    vw,
    0.0,
    vh,
    0.0,
    1.0,
    scratchViewportOrthographic,
    context.clipSpaceConvention,
  );
  Matrix4.pack(scratchViewportTransformation, polylineParamsScratch, 8);
  Matrix4.pack(scratchViewportOrthographic, polylineParamsScratch, 24);
  device.queue.writeBuffer(cache.paramsUBO, 0, gpuData(polylineParamsScratch));

  const segmentCount: number =
    collection.vertexCount - collection.primitiveCount;
  if (segmentCount <= 0) {
    collection._dirtyCount = 0;
    collection._dirtyOffset = 0;
    return;
  }

  const indexCount = segmentCount * 6;
  const vbs = [
    cache.positionHigh,
    cache.positionLow,
    cache.prevPositionHigh,
    cache.prevPositionLow,
    cache.nextPositionHigh,
    cache.nextPositionLow,
    cache.pickColor,
    // Slot 7 carries loc7 (showColorWidthAndTexCoord vec4), loc8 (alpha f32)
    // and loc9 (expand direction f32) interleaved, for eight vertex buffers
    // total.
    cache.showColorWidthAndTexCoord,
  ];
  const bgs = [cache.bindGroup, cache.paramsBindGroup];

  // The blend option selects opaque overwrite or translucent blending.
  const isOpaque = collection._blendOption === BlendOption.OPAQUE;
  // Settled 2D and Columbus View use the coplanar-depth variant.
  const noDepthTest = computeNoDepthTest(frameState);
  // Cull against a bounding volume in the same render frame as the packed
  // positions; Scene 3D retains the collection's reference volume.
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
            cache.noDepthTestOpaquePipeline = buildPolylinePipeline(
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
            cache.noDepthTestPipeline = buildPolylinePipeline(
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
          cache.opaquePipeline = buildPolylinePipeline(
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
        indexBuffer: cache.indexBuffer,
        indexFormat: cache.indexFormat,
        indexCount,
        pass: isOpaque ? Pass.OPAQUE : Pass.TRANSLUCENT,
        boundingVolume: modeBV,
        debugShowBoundingVolume: collection.debugShowBoundingVolume,
      });
      cache.commandBlendOption = collection._blendOption;
      cache.commandNoDepthTest = noDepthTest;
    } else {
      cache.command.indexCount = indexCount;
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
        indexBuffer: cache.indexBuffer,
        indexFormat: cache.indexFormat,
        indexCount,
        pass: Pass.TRANSLUCENT,
        // This command is submitted only during the pick pass.
        pickOnly: true,
      });
    } else {
      cache.pickCommand.indexCount = indexCount;
    }
    frameState.commandList.push(cache.pickCommand);
  }

  collection._dirtyCount = 0;
  collection._dirtyOffset = 0;
}

export function destroyWebGPUBufferPolylineCollection(
  collection: BufferPrimitiveCollection,
): void {
  const cache = collection._webgpuCache as PolylineCache | undefined;
  if (!cache) {
    return;
  }
  destroyPickIds(cache);
  cache.cameraUBO.destroy();
  cache.paramsUBO.destroy();
  cache.positionHigh.destroy();
  cache.positionLow.destroy();
  cache.prevPositionHigh.destroy();
  cache.prevPositionLow.destroy();
  cache.nextPositionHigh.destroy();
  cache.nextPositionLow.destroy();
  cache.pickColor.destroy();
  cache.showColorWidthAndTexCoord.destroy();
  cache.indexBuffer.destroy();
  collection._webgpuCache = undefined;
}
