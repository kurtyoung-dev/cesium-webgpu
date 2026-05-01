/**
 * WebGPU Buffer Polyline Renderer
 *
 * Per-collection slice extracted from `WebGPUBufferPrimitiveRenderer`
 * (Batch 156 of the maintainability sweep).
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
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { gpuData, jsModule, numericArray } from "./webgpuTypeHelpers.js";
import BufferPolyline from "../../Scene/BufferPolyline.js";
import BufferPolylineMaterial from "../../Scene/BufferPolylineMaterial.js";
import BufferPolylineMaterialWGSL from "../../Shaders/WebGPU/Collections/BufferPolylineMaterial.js";

import {
  packCameraUniforms,
  preprocessShader,
  makeCameraBindGroupLayout,
  createSharedCacheBase,
  createVB,
  createIB,
  destroyPickIds,
  scratchColor,
  scratchCart,
  scratchEnc,
} from "./WebGPUBufferPrimitiveRenderer.js";
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
  bindGroup: GPUBindGroup;
  command: WebGPUDrawCommand | null;
  pickCommand: WebGPUDrawCommand | null;
  pickIds: CesiumPickIdRef[];
}

// ─── Pipeline builder ────────────────────────────────────────────────────────
function buildPolylinePipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  format: GPUTextureFormat,
  bgls: GPUBindGroupLayout[],
  fragmentEntryPoint: string = "fragmentMain",
): GPURenderPipeline {
  const float3 = (loc: number): GPUVertexBufferLayout => ({
    arrayStride: 12,
    attributes: [{ shaderLocation: loc, offset: 0, format: "float32x3" }],
  });
  return device.createRenderPipeline({
    label: `BufferPolyline pipeline (${fragmentEntryPoint})`,
    layout: device.createPipelineLayout({ bindGroupLayouts: bgls }),
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
        {
          arrayStride: 16,
          attributes: [{ shaderLocation: 7, offset: 0, format: "float32x4" }],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: fragmentEntryPoint,
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
            },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      // less-equal (not less) — lets primitives that project exactly
      // onto the far plane due to FP32 rounding still pass the depth
      // test. Safe at planetary scale where the Z range is huge and
      // precision collapses near z=1.
      depthCompare: "less-equal",
    },
  });
}

// ─── BufferPolylineCollection ────────────────────────────────────────────────

function initPolylineCache(
  collection: BufferPrimitiveCollection,
  context: CesiumGraphicsContext,
  format: GPUTextureFormat,
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
  const showColorWidthAndTexCoordArr = new Float32Array(vertexCountMax * 4);
  const indexArr = jsModule<IndexDatatypeStatics>(
    IndexDatatype,
  ).createTypedArray(vertexCountMax, segmentCountMax * 6);
  const indexFormat: GPUIndexFormat =
    indexArr instanceof Uint32Array ? "uint32" : "uint16";

  const shaderSource = preprocessShader(
    context,
    "BufferPolylineMaterial",
    BufferPolylineMaterialWGSL,
  );
  const shaderModule = device.createShaderModule({
    label: "BufferPolylineMaterial",
    code: shaderSource,
  });
  const bgls = makeCameraBindGroupLayout(device, true);
  const pipeline = buildPolylinePipeline(device, shaderModule, format, bgls);
  const pickPipeline = buildPolylinePipeline(
    device,
    shaderModule,
    format,
    bgls,
    "fragmentPickMain",
  );

  const base = createSharedCacheBase(device);
  const paramsUBO = device.createBuffer({
    label: "BufferPolyline params UBO",
    size: 32, // pixelRatio + 3 pad + viewport vec4
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
): void {
  const dirtyOffset: number = collection._dirtyOffset;
  const dirtyCount: number = collection._dirtyCount;
  if (dirtyCount === 0) {
    return;
  }
  const allowPicking: boolean = collection._allowPicking;
  for (let i = dirtyOffset; i < dirtyOffset + dirtyCount; i++) {
    collection.get(i, scratchPolyline);
    if (!scratchPolyline._dirty) {
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
    Color.fromRgba(scratchPolyline._pickId, scratchColor);
    const show = scratchPolyline.show;
    const width = scratchPolylineMat.width;

    let vOffset = scratchPolyline.vertexOffset * 2;
    let iOffset = (scratchPolyline.vertexOffset - i) * 6;

    for (let j = 0, jl = scratchPolyline.vertexCount; j < jl; j++) {
      const isFirst = j === 0;
      const isLast = j === jl - 1;
      Cartesian3.fromArray(numericArray(positions), j * 3, scratchCart);
      if (isFirst) {
        Cartesian3.fromArray(numericArray(positions), (j + 1) * 3, scratchNext);
        Cartesian3.subtract(scratchCart, scratchNext, scratchPrev);
        Cartesian3.add(scratchCart, scratchPrev, scratchPrev);
      } else if (isLast) {
        Cartesian3.fromArray(numericArray(positions), (j - 1) * 3, scratchPrev);
        Cartesian3.subtract(scratchCart, scratchPrev, scratchNext);
        Cartesian3.add(scratchCart, scratchNext, scratchNext);
      } else {
        Cartesian3.fromArray(numericArray(positions), (j - 1) * 3, scratchPrev);
        Cartesian3.fromArray(numericArray(positions), (j + 1) * 3, scratchNext);
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

      const texCoordS = jl > 1 ? j / (jl - 1) : 0;
      for (let k = 0; k < 2; k++) {
        const v3 = vOffset * 3;
        const v4 = vOffset * 4;
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
        // Pack texCoord with direction in fractional bits: integer = s, fractional = direction
        // The shader unpacks: floor() = s, sign(fract() - 0.5) = direction
        const directionFrac = k === 0 ? 0.25 : 0.75; // -1 / +1 after sign(fract-0.5)
        cache.showColorWidthAndTexCoordArr[v4] = show ? 1 : 0;
        cache.showColorWidthAndTexCoordArr[v4 + 1] = encodedColor;
        cache.showColorWidthAndTexCoordArr[v4 + 2] = width;
        cache.showColorWidthAndTexCoordArr[v4 + 3] = texCoordS + directionFrac;
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

const polylineParamsScratch = new Float32Array(8);

export function updateWebGPUBufferPolylineCollection(
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

  let cache = collection._webgpuCache as PolylineCache | undefined;
  // Batch 110 — invalidate on scene format change (HDR toggle).
  const sceneGen =
    (context as unknown as { _scenePipelineFormatGeneration?: number })
      ._scenePipelineFormatGeneration ?? 0;
  if (
    cache &&
    (cache as unknown as { _pipelineFormatGeneration?: number })
      ._pipelineFormatGeneration !== sceneGen
  ) {
    cache = undefined;
    collection._webgpuCache = undefined;
  }
  if (!cache) {
    cache = initPolylineCache(collection, context, format);
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
    collection._webgpuCache = cache;
    collection._dirtyOffset = 0;
    collection._dirtyCount = collection.primitiveCount;
  }

  if (collection._dirtyCount > 0) {
    repackPolylineDirty(collection, cache, context);
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

  // Params: pixelRatio + viewport
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
    cache.showColorWidthAndTexCoord,
  ];
  const bgs = [cache.bindGroup, cache.paramsBindGroup];

  if (frameState.passes.render) {
    if (!cache.command) {
      cache.command = new WebGPUDrawCommand({
        pipeline: cache.pipeline,
        bindGroups: bgs,
        vertexBuffers: vbs,
        indexBuffer: cache.indexBuffer,
        indexFormat: cache.indexFormat,
        indexCount,
        pass: Pass.TRANSLUCENT,
      });
    } else {
      cache.command.indexCount = indexCount;
    }
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
