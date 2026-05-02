/**
 * WebGPU Buffer Polygon Renderer
 *
 * Per-collection slice extracted from `WebGPUBufferPrimitiveRenderer`
 * (Batch 155 of the maintainability sweep).
 *
 * Owns the BufferPolygonCollection rendering path: cache type,
 * pipeline builder, init / repack / upload / update / destroy
 * functions. Shared infrastructure (camera UBO packing, shader
 * preprocessing, bind-group-layout helper, shared scratch objects,
 * cache-base + buffer-creation helpers, `destroyPickIds`) is imported
 * from the parent module.
 *
 * The two public-API symbols (`updateWebGPUBufferPolygonCollection`,
 * `destroyWebGPUBufferPolygonCollection`) are re-exported from the
 * parent module so external callers (`WebGPUFeatureRenderers.ts`)
 * keep their existing import path.
 *
 * @module WebGPUBufferPolygonRenderer
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
import BufferPolygon from "../../Scene/BufferPolygon.js";
import BufferPolygonMaterial from "../../Scene/BufferPolygonMaterial.js";
import BufferPolygonMaterialWGSL from "../../Shaders/WebGPU/Collections/BufferPolygonMaterial.js";

import {
  packCameraUniforms,
  preprocessShader,
  makeCameraBindGroupLayout,
  createSharedCacheBase,
  createVB,
  createIB,
  destroyPickIds,
  getBufferPrimitiveShaderCache,
  scratchColor,
  scratchCart,
  scratchEnc,
} from "./WebGPUBufferPrimitiveRenderer.js";
import { ShaderSourceId } from "./WebGPUShaderDefines.js";
import type {
  BufferPrimitiveCollection,
  CesiumPickIdRef,
  SharedCache,
  IndexDatatypeStatics,
} from "./WebGPUBufferPrimitiveRenderer.js";

// ─── Polygon-specific scratch ────────────────────────────────────────────────
const scratchPolygon = new BufferPolygon();
const scratchPolygonMat = new BufferPolygonMaterial();

// ─── PolygonCache type ───────────────────────────────────────────────────────
export interface PolygonCache extends SharedCache {
  positionHigh: GPUBuffer;
  positionLow: GPUBuffer;
  pickColor: GPUBuffer;
  showAndColor: GPUBuffer;
  indexBuffer: GPUBuffer;
  positionHighArr: Float32Array;
  positionLowArr: Float32Array;
  pickColorArr: Uint8Array;
  showAndColorArr: Float32Array;
  indexArr: Uint16Array | Uint32Array;
  indexFormat: GPUIndexFormat;
  vertexCountMax: number;
  triangleCountMax: number;
  pipeline: GPURenderPipeline;
  pickPipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  command: WebGPUDrawCommand | null;
  pickCommand: WebGPUDrawCommand | null;
  pickIds: CesiumPickIdRef[];
}

// ─── Pipeline builder ────────────────────────────────────────────────────────
function buildPolygonPipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  format: GPUTextureFormat,
  bgls: GPUBindGroupLayout[],
  fragmentEntryPoint: string = "fragmentMain",
): GPURenderPipeline {
  // Pick-path entry points emit opaque pick IDs and must NOT alpha-blend
  // (blending pick IDs produces invalid intermediate values that map to
  // wrong entity IDs at readback). Everything else is a color pipeline
  // that needs standard src-alpha / one-minus-src-alpha blending so a
  // polygon with a `color.alpha < 1` actually composites against the
  // frame instead of overwriting it — the DP-H16 fix extended to the
  // buffer-primitive polygon path (polyline / point already had blend).
  const isPick = fragmentEntryPoint === "fragmentPickMain";
  const colorTarget: GPUColorTargetState = isPick
    ? { format }
    : {
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
      };
  return device.createRenderPipeline({
    label: `BufferPolygon pipeline (${fragmentEntryPoint})`,
    layout: device.createPipelineLayout({ bindGroupLayouts: bgls }),
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        },
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }],
        },
        {
          arrayStride: 4,
          attributes: [{ shaderLocation: 2, offset: 0, format: "unorm8x4" }],
        },
        {
          arrayStride: 8,
          attributes: [{ shaderLocation: 3, offset: 0, format: "float32x2" }],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: fragmentEntryPoint,
      targets: [colorTarget],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      // Pick path always writes depth so per-pixel pick IDs are
      // deterministic. Color path keeps depth write off when blending
      // translucent fragments — matches the WebGL convention and
      // prevents alpha-blended polygons from occluding geometry
      // behind them.
      depthWriteEnabled: isPick,
      // less-equal (not less) — lets primitives that project exactly
      // onto the far plane due to FP32 rounding still pass the depth
      // test. Safe at planetary scale where the Z range is huge and
      // precision collapses near z=1.
      depthCompare: "less-equal",
    },
  });
}

// ─── BufferPolygonCollection ─────────────────────────────────────────────────

function initPolygonCache(
  collection: BufferPrimitiveCollection,
  context: CesiumGraphicsContext,
  format: GPUTextureFormat,
): PolygonCache {
  const device: GPUDevice = context.device;
  const vertexCountMax: number = collection.vertexCountMax;
  const triangleCountMax: number = collection.triangleCountMax;

  const positionHighArr = new Float32Array(vertexCountMax * 3);
  const positionLowArr = new Float32Array(vertexCountMax * 3);
  const pickColorArr = new Uint8Array(vertexCountMax * 4);
  const showAndColorArr = new Float32Array(vertexCountMax * 2);
  const indexArr = jsModule<IndexDatatypeStatics>(
    IndexDatatype,
  ).createTypedArray(vertexCountMax, triangleCountMax * 3);
  const indexFormat: GPUIndexFormat =
    indexArr instanceof Uint32Array ? "uint32" : "uint16";

  const shaderSource = preprocessShader(
    context,
    "BufferPolygonMaterial",
    BufferPolygonMaterialWGSL,
  );
  const shaderModule = getBufferPrimitiveShaderCache(device).getOrCreate(
    ShaderSourceId.BUFFER_POLYGON_MATERIAL,
    shaderSource,
    0,
    "BufferPolygonMaterial",
  );

  const bgls = makeCameraBindGroupLayout(device, false);
  const pipeline = buildPolygonPipeline(device, shaderModule, format, bgls);
  const pickPipeline = buildPolygonPipeline(
    device,
    shaderModule,
    format,
    bgls,
    "fragmentPickMain",
  );

  const base = createSharedCacheBase(device);
  const cache: PolygonCache = {
    ...base,
    positionHigh: createVB(device, positionHighArr.byteLength, "polyHigh"),
    positionLow: createVB(device, positionLowArr.byteLength, "polyLow"),
    pickColor: createVB(device, pickColorArr.byteLength, "polyPick"),
    showAndColor: createVB(device, showAndColorArr.byteLength, "polyShow"),
    indexBuffer: createIB(device, indexArr.byteLength, "polyIdx"),
    positionHighArr,
    positionLowArr,
    pickColorArr,
    showAndColorArr,
    indexArr,
    indexFormat,
    vertexCountMax,
    triangleCountMax,
    pipeline,
    pickPipeline,
    bindGroup: device.createBindGroup({
      label: "BufferPolygon BG",
      layout: bgls[0],
      entries: [{ binding: 0, resource: { buffer: base.cameraUBO } }],
    }),
    command: null,
    pickCommand: null,
    pickIds: [],
  };
  return cache;
}

function repackPolygonDirty(
  collection: BufferPrimitiveCollection,
  cache: PolygonCache,
  context: CesiumGraphicsContext,
): void {
  const dirtyOffset: number = collection._dirtyOffset;
  const dirtyCount: number = collection._dirtyCount;
  if (dirtyCount === 0) {
    return;
  }
  const allowPicking: boolean = collection._allowPicking;
  for (let i = dirtyOffset; i < dirtyOffset + dirtyCount; i++) {
    collection.get(i, scratchPolygon);
    if (!scratchPolygon._dirty) {
      continue;
    }

    if (allowPicking && scratchPolygon._pickId === 0) {
      const pickId = context.createPickId(
        {
          collection,
          index: i,
          get primitive() {
            return collection.get(i, new BufferPolygon());
          },
        },
        "buffer-primitive",
      );
      scratchPolygon._pickId = pickId.key;
      cache.pickIds.push(pickId);
    }

    let tOffset = scratchPolygon.triangleOffset;
    let vOffset = scratchPolygon.vertexOffset;
    const triangles = scratchPolygon.getTriangles();
    for (let j = 0, jl = scratchPolygon.triangleCount; j < jl; j++) {
      cache.indexArr[tOffset * 3] = vOffset + triangles[j * 3];
      cache.indexArr[tOffset * 3 + 1] = vOffset + triangles[j * 3 + 1];
      cache.indexArr[tOffset * 3 + 2] = vOffset + triangles[j * 3 + 2];
      tOffset++;
    }

    const positions = scratchPolygon.getPositions();
    scratchPolygon.getMaterial(scratchPolygonMat);
    const encodedColor = AttributeCompression.encodeRGB8(
      scratchPolygonMat.color,
    );
    Color.fromRgba(scratchPolygon._pickId, scratchColor);
    const show = scratchPolygon.show;

    for (let j = 0, jl = scratchPolygon.vertexCount; j < jl; j++) {
      Cartesian3.fromArray(numericArray(positions), j * 3, scratchCart);
      EncodedCartesian3.fromCartesian(scratchCart, scratchEnc);
      const v3 = vOffset * 3;
      const v4 = vOffset * 4;
      const v2 = vOffset * 2;
      cache.positionHighArr[v3] = scratchEnc.high.x;
      cache.positionHighArr[v3 + 1] = scratchEnc.high.y;
      cache.positionHighArr[v3 + 2] = scratchEnc.high.z;
      cache.positionLowArr[v3] = scratchEnc.low.x;
      cache.positionLowArr[v3 + 1] = scratchEnc.low.y;
      cache.positionLowArr[v3 + 2] = scratchEnc.low.z;
      cache.pickColorArr[v4] = Color.floatToByte(scratchColor.red);
      cache.pickColorArr[v4 + 1] = Color.floatToByte(scratchColor.green);
      cache.pickColorArr[v4 + 2] = Color.floatToByte(scratchColor.blue);
      cache.pickColorArr[v4 + 3] = Color.floatToByte(scratchColor.alpha);
      cache.showAndColorArr[v2] = show ? 1 : 0;
      cache.showAndColorArr[v2 + 1] = encodedColor;
      vOffset++;
    }

    scratchPolygon._dirty = false;
  }
}

function uploadPolygonBuffers(device: GPUDevice, cache: PolygonCache): void {
  device.queue.writeBuffer(
    cache.positionHigh,
    0,
    gpuData(cache.positionHighArr),
  );
  device.queue.writeBuffer(cache.positionLow, 0, gpuData(cache.positionLowArr));
  device.queue.writeBuffer(cache.pickColor, 0, gpuData(cache.pickColorArr));
  device.queue.writeBuffer(
    cache.showAndColor,
    0,
    gpuData(cache.showAndColorArr),
  );
  device.queue.writeBuffer(cache.indexBuffer, 0, gpuData(cache.indexArr));
}

export function updateWebGPUBufferPolygonCollection(
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

  let cache = collection._webgpuCache as PolygonCache | undefined;
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
    cache = initPolygonCache(collection, context, format);
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
    collection._webgpuCache = cache;
    // First-time: pack everything as dirty.
    collection._dirtyOffset = 0;
    collection._dirtyCount = collection.primitiveCount;
  }

  if (collection._dirtyCount > 0) {
    repackPolygonDirty(collection, cache, context);
    uploadPolygonBuffers(device, cache);
    cache.command = null;
    cache.pickCommand = null;
  }

  // Camera UBO
  packCameraUniforms(
    cache.cameraData,
    context.uniformState,
    collection.modelMatrix ?? Matrix4.IDENTITY,
  );
  device.queue.writeBuffer(cache.cameraUBO, 0, gpuData(cache.cameraData));

  const triangleCount: number = collection.triangleCount;
  if (triangleCount === 0) {
    collection._dirtyCount = 0;
    collection._dirtyOffset = 0;
    return;
  }

  const indexCount = triangleCount * 3;
  const vbs = [
    cache.positionHigh,
    cache.positionLow,
    cache.pickColor,
    cache.showAndColor,
  ];

  if (frameState.passes.render) {
    if (!cache.command) {
      // Buffer primitives carry per-vertex alpha in the `showAndColor`
      // stream, so they're effectively always alpha-blended. Route to the
      // TRANSLUCENT pass so they composite correctly against the rest of
      // the scene (back-to-front order). Pick path stays OPAQUE because
      // pick-ID color is discrete, not alpha-blended.
      cache.command = new WebGPUDrawCommand({
        pipeline: cache.pipeline,
        bindGroups: [cache.bindGroup],
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
        bindGroups: [cache.bindGroup],
        vertexBuffers: vbs,
        indexBuffer: cache.indexBuffer,
        indexFormat: cache.indexFormat,
        indexCount,
        pass: Pass.OPAQUE,
      });
    } else {
      cache.pickCommand.indexCount = indexCount;
    }
    frameState.commandList.push(cache.pickCommand);
  }

  collection._dirtyCount = 0;
  collection._dirtyOffset = 0;
}

export function destroyWebGPUBufferPolygonCollection(
  collection: BufferPrimitiveCollection,
): void {
  const cache = collection._webgpuCache as PolygonCache | undefined;
  if (!cache) {
    return;
  }
  destroyPickIds(cache);
  cache.cameraUBO.destroy();
  cache.positionHigh.destroy();
  cache.positionLow.destroy();
  cache.pickColor.destroy();
  cache.showAndColor.destroy();
  cache.indexBuffer.destroy();
  collection._webgpuCache = undefined;
}
