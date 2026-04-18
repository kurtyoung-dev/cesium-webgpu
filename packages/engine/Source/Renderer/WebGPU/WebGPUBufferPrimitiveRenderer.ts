/**
 * WebGPU Buffer Primitive Renderer
 *
 * Renders the experimental buffer-backed primitive collections under WebGPU:
 *   - BufferPolygonCollection  → triangle-list, indexed
 *   - BufferPolylineCollection → triangle-list, indexed (segment quads)
 *   - BufferPointCollection    → instanced screen-space quad per point
 *
 * The CPU-side attribute packing mirrors the WebGL reference renderers in
 * Scene/renderBuffer{Polygon,Polyline,Point}Collection.js — see those files
 * for the canonical attribute layouts. WGSL shaders live at
 * Shaders/WebGPU/Collections/Buffer{Polygon,Polyline,Point}Material.wgsl and
 * are preprocessed via the context's WebGPUShaderCache (`#import` resolution).
 *
 * Each collection caches its GPU resources on a `_webgpuCache` field. On dirty
 * we re-pack the entire dirty range CPU-side and re-upload the affected slice
 * via `writeBuffer` (no full reupload).
 *
 * @module WebGPUBufferPrimitiveRenderer
 */

import Cartesian3 from "../../Core/Cartesian3.js";
import Color from "../../Core/Color.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import AttributeCompression from "../../Core/AttributeCompression.js";
import IndexDatatype from "../../Core/IndexDatatype.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import {
  gpuData,
  jsModule,
  m4Values,
  numericArray,
} from "./webgpuTypeHelpers.js";
import {
  assertCameraRTERoundTrip,
  assertMVTranslationZeroed,
} from "./WebGPURTEAssertions.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

/** Type-shape we use to call the JS-only IndexDatatype.createTypedArray. */
interface IndexDatatypeStatics {
  createTypedArray: (
    vertexCountMax: number,
    indexCount: number,
  ) => Uint16Array | Uint32Array;
}

import BufferPolygon from "../../Scene/BufferPolygon.js";
import BufferPolyline from "../../Scene/BufferPolyline.js";
import BufferPoint from "../../Scene/BufferPoint.js";
import BufferPolygonMaterial from "../../Scene/BufferPolygonMaterial.js";
import BufferPolylineMaterial from "../../Scene/BufferPolylineMaterial.js";
import BufferPointMaterial from "../../Scene/BufferPointMaterial.js";

import BufferPolygonMaterialWGSL from "../../Shaders/WebGPU/Collections/BufferPolygonMaterial.js";
import BufferPolylineMaterialWGSL from "../../Shaders/WebGPU/Collections/BufferPolylineMaterial.js";
import BufferPointMaterialWGSL from "../../Shaders/WebGPU/Collections/BufferPointMaterial.js";

// ─── Shared types ────────────────────────────────────────────────────────────

/** Minimal interface for the BufferPrimitive collection objects passed from
 *  Scene JS code. Covers properties read by the renderer functions. */
interface BufferPrimitiveCollection {
  show: boolean;
  primitiveCount: number;
  triangleCount: number;
  segmentCount: number;
  pointCount: number;
  vertexCountMax: number;
  triangleCountMax: number;
  vertexCount: number;
  primitiveCountMax: number;
  modelMatrix?: CesiumMatrix4;
  _allowPicking: boolean;
  _dirtyOffset: number;
  _dirtyCount: number;
  _webgpuCache?: PolygonCache | PolylineCache | PointCache;
  get(index: number, result?: CesiumOpaqueObject): CesiumOpaqueObject;
}

/** A pick ID created by context.createPickId(). */
interface CesiumPickIdRef {
  destroy(): void;
}

/** CameraUniforms struct (368 bytes) — see Shaders/WebGPU/chunks/structs/CameraUniforms.wgsl */
const CAMERA_UBO_BYTES = 368;
const CAMERA_UBO_FLOATS = CAMERA_UBO_BYTES / 4;

interface SharedCache {
  cameraUBO: GPUBuffer;
  cameraData: Float32Array;
}

interface PolygonCache extends SharedCache {
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

interface PolylineCache extends SharedCache {
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

interface PointCache extends SharedCache {
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
  bindGroup: GPUBindGroup;
  command: WebGPUDrawCommand | null;
  pickCommand: WebGPUDrawCommand | null;
  pickIds: CesiumPickIdRef[];
}

// ─── Scratch ─────────────────────────────────────────────────────────────────

const scratchPolygon = new BufferPolygon();
const scratchPolyline = new BufferPolyline();
const scratchPoint = new BufferPoint();
const scratchPolygonMat = new BufferPolygonMaterial();
const scratchPolylineMat = new BufferPolylineMaterial();
const scratchPointMat = new BufferPointMaterial();
const scratchColor = new Color();
const scratchCart = new Cartesian3();
const scratchPrev = new Cartesian3();
const scratchNext = new Cartesian3();
const scratchEnc = { high: new Cartesian3(), low: new Cartesian3() };
const scratchPrevEnc = { high: new Cartesian3(), low: new Cartesian3() };
const scratchNextEnc = { high: new Cartesian3(), low: new Cartesian3() };

// ─── Camera UBO packing ──────────────────────────────────────────────────────

function packCameraUniforms(
  out: Float32Array,
  uniformState: CesiumUniformState,
  modelMatrixRaw: CesiumMatrix4 | object,
): void {
  const modelMatrix = modelMatrixRaw as Matrix4;
  const view = uniformState.view;
  const proj = uniformState.projection;
  const viewProj = uniformState.viewProjection;
  const viewIdx = m4Values(view);
  const projIdx = m4Values(proj);
  const vpIdx = m4Values(viewProj);

  for (let i = 0; i < 16; i++) {
    out[i] = viewIdx[i];
    out[16 + i] = projIdx[i];
    out[32 + i] = vpIdx[i];
  }

  const camPos = uniformState.cameraPosition;
  out[48] = camPos.x;
  out[49] = camPos.y;
  out[50] = camPos.z;
  // out[51] is implicit vec3 alignment padding — no write needed.

  // Encoded camera position in model coordinates
  const invModel = Matrix4.inverse(modelMatrix, scratchInvModel);
  const camModel = Matrix4.multiplyByPoint(invModel, camPos, scratchCart);
  EncodedCartesian3.fromCartesian(camModel, scratchEnc);

  out[52] = scratchEnc.high.x;
  out[53] = scratchEnc.high.y;
  out[54] = scratchEnc.high.z;
  // out[55] is implicit vec3 alignment padding — no write needed.
  out[56] = scratchEnc.low.x;
  out[57] = scratchEnc.low.y;
  out[58] = scratchEnc.low.z;
  // out[59] is implicit vec3 alignment padding — no write needed.

  //>>includeStart('debug', pragmas.debug);
  assertCameraRTERoundTrip(
    scratchEnc.high,
    scratchEnc.low,
    camModel,
    "BufferPrimitive camera UB (model-space)",
  );
  //>>includeEnd('debug');

  // modelViewRelativeToEye = (view * model) with translation column zeroed,
  // THEN projection applied. It is CRITICAL to zero the translation column
  // *before* multiplying by projection — zeroing after the fact wipes out
  // projection's P23 depth-mapping term, which lands in the same slot as
  // the translation during the multiply. The resulting MVP would produce
  // incorrect NDC depth and all geometry drawn through this path would
  // fail depth testing at planetary scale.
  //
  // Matches `UniformStateComputations.cleanModelViewRelativeToEye` +
  // `cleanModelViewProjectionRelativeToEye`.
  //
  // Keep both intermediates as Matrix4 (Float64) so rotation columns stay
  // at FP64 precision through the multiply; only downcast to FP32 at the
  // final UBO write.
  Matrix4.multiply(view, modelMatrix, scratchMV);
  // Zero the translation column of MV in place. Column-major indices
  // 12,13,14 are the xyz translation; index 15 (the homogeneous 1)
  // stays untouched.
  scratchMV[12] = 0;
  scratchMV[13] = 0;
  scratchMV[14] = 0;

  //>>includeStart('debug', pragmas.debug);
  assertMVTranslationZeroed(scratchMV, "BufferPrimitive camera UB mv");
  //>>includeEnd('debug');

  // Project the already-zeroed MV. Result col3 = proj × [0,0,0,1] =
  // [0, 0, P23, 0] — depth mapping preserved exactly.
  Matrix4.multiply(proj, scratchMV, scratchMVP);

  const mvIdx = m4Values(scratchMV);
  const mvpIdx = m4Values(scratchMVP);
  for (let i = 0; i < 16; i++) {
    out[60 + i] = mvIdx[i];
    out[76 + i] = mvpIdx[i];
  }
}

const scratchInvModel = new Matrix4();
const scratchMV = new Matrix4();
const scratchMVP = new Matrix4();
const scratchMVCopy = new Float32Array(16);
const scratchMVPCopy = new Float32Array(16);

// ─── Shader preprocessing ────────────────────────────────────────────────────

const _processedShaderCache = new Map<string, string>();

/**
 * Pick fragment entry appended to every Buffer* shader source. The Buffer*
 * vertex stage already writes `v_pickColor` into VertexOutput, so the pick
 * variant only needs an alternate fragment entry that returns it instead of
 * `v_color`. This lets one shader module serve both color and pick pipelines.
 */
const PICK_FRAGMENT_SUFFIX = `

@fragment
fn fragmentPickMain(input : VertexOutput) -> @location(0) vec4<f32> {
  // Match the color path's alpha discard so picks line up exactly with
  // visible pixels (no picking through translucent fringes).
  if (input.v_color.a < 0.005) { discard; }
  return input.v_pickColor;
}
`;

function preprocessShader(
  context: CesiumGraphicsContext,
  name: string,
  source: string,
): string {
  let processed = _processedShaderCache.get(name);
  if (processed) {
    return processed;
  }
  const shaderCache = context.shaderCache;
  if (shaderCache && typeof shaderCache.preprocessOnly === "function") {
    processed = shaderCache.preprocessOnly(source, { label: name });
  } else {
    processed = source;
  }
  // Append the pick fragment entry. Done after preprocessing so the pick
  // function references the already-resolved VertexOutput struct definition.
  processed = processed + PICK_FRAGMENT_SUFFIX;
  _processedShaderCache.set(name, processed!);
  return processed!;
}

// ─── Pipeline builders ───────────────────────────────────────────────────────

function makeCameraBindGroupLayout(
  device: GPUDevice,
  withParams: boolean,
): GPUBindGroupLayout[] {
  const layouts: GPUBindGroupLayout[] = [
    makeBindGroupLayout(device, "BufferPrimitive camera BGL", [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT),
    ]),
  ];
  if (withParams) {
    layouts.push(
      makeBindGroupLayout(device, "BufferPrimitive params BGL", [
        uniformBuffer(0, Stage.VERTEX_FRAGMENT),
      ]),
    );
  }
  return layouts;
}

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

function buildPointPipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  format: GPUTextureFormat,
  bgls: GPUBindGroupLayout[],
  fragmentEntryPoint: string = "fragmentMain",
): GPURenderPipeline {
  return device.createRenderPipeline({
    label: `BufferPoint pipeline (${fragmentEntryPoint})`,
    layout: device.createPipelineLayout({ bindGroupLayouts: bgls }),
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
        {
          arrayStride: 12,
          stepMode: "instance",
          attributes: [{ shaderLocation: 3, offset: 0, format: "float32x3" }],
        },
        {
          arrayStride: 8,
          stepMode: "instance",
          attributes: [{ shaderLocation: 4, offset: 0, format: "float32x2" }],
        },
        // Per-vertex quad corner
        {
          arrayStride: 8,
          stepMode: "vertex",
          attributes: [{ shaderLocation: 5, offset: 0, format: "float32x2" }],
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
      depthWriteEnabled: false,
      // less-equal (not less) — lets primitives that project exactly
      // onto the far plane due to FP32 rounding still pass the depth
      // test. Safe at planetary scale where the Z range is huge and
      // precision collapses near z=1.
      depthCompare: "less-equal",
    },
  });
}

// ─── Common helpers ──────────────────────────────────────────────────────────

function createSharedCacheBase(device: GPUDevice): SharedCache {
  return {
    cameraUBO: device.createBuffer({
      label: "BufferPrimitive camera UBO",
      size: CAMERA_UBO_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    cameraData: new Float32Array(CAMERA_UBO_FLOATS),
  };
}

function createVB(
  device: GPUDevice,
  byteLength: number,
  label: string,
): GPUBuffer {
  return device.createBuffer({
    label,
    size: Math.max(16, byteLength),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
}

function createIB(
  device: GPUDevice,
  byteLength: number,
  label: string,
): GPUBuffer {
  return device.createBuffer({
    label,
    size: Math.max(16, byteLength),
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
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
  const shaderModule = device.createShaderModule({
    label: "BufferPolygonMaterial",
    code: shaderSource,
  });

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

function updateWebGPUBufferPolygonCollection(
  collection: BufferPrimitiveCollection,
  frameState: CesiumFrameState,
): void {
  if (!collection.show) {
    return;
  }
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const format: GPUTextureFormat = navigator.gpu.getPreferredCanvasFormat();

  let cache = collection._webgpuCache as PolygonCache | undefined;
  if (!cache) {
    cache = initPolygonCache(collection, context, format);
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

function destroyPickIds(cache: { pickIds: CesiumPickIdRef[] }): void {
  for (const id of cache.pickIds) {
    if (id && typeof id.destroy === "function") {
      id.destroy();
    }
  }
  cache.pickIds.length = 0;
}

function destroyWebGPUBufferPolygonCollection(
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

function updateWebGPUBufferPolylineCollection(
  collection: BufferPrimitiveCollection,
  frameState: CesiumFrameState,
): void {
  if (!collection.show) {
    return;
  }
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const format: GPUTextureFormat = navigator.gpu.getPreferredCanvasFormat();

  let cache = collection._webgpuCache as PolylineCache | undefined;
  if (!cache) {
    cache = initPolylineCache(collection, context, format);
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

function destroyWebGPUBufferPolylineCollection(
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

// ─── BufferPointCollection ───────────────────────────────────────────────────

function initPointCache(
  collection: BufferPrimitiveCollection,
  context: CesiumGraphicsContext,
  format: GPUTextureFormat,
): PointCache {
  const device: GPUDevice = context.device;
  const primitiveCountMax: number = collection.primitiveCountMax;

  const positionHighArr = new Float32Array(primitiveCountMax * 3);
  const positionLowArr = new Float32Array(primitiveCountMax * 3);
  const pickColorArr = new Uint8Array(primitiveCountMax * 4);
  const showSizeAndColorArr = new Float32Array(primitiveCountMax * 3);
  const outlineWidthAndOutlineColorArr = new Float32Array(
    primitiveCountMax * 2,
  );

  const shaderSource = preprocessShader(
    context,
    "BufferPointMaterial",
    BufferPointMaterialWGSL,
  );
  const shaderModule = device.createShaderModule({
    label: "BufferPointMaterial",
    code: shaderSource,
  });
  const bgls = makeCameraBindGroupLayout(device, true);
  const pipeline = buildPointPipeline(device, shaderModule, format, bgls);
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
    bindGroup: device.createBindGroup({
      label: "BufferPoint camera BG",
      layout: bgls[0],
      entries: [{ binding: 0, resource: { buffer: base.cameraUBO } }],
    }),
    command: null,
    pickCommand: null,
    pickIds: [],
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
): void {
  const dirtyOffset: number = collection._dirtyOffset;
  const dirtyCount: number = collection._dirtyCount;
  if (dirtyCount === 0) {
    return;
  }
  const allowPicking: boolean = collection._allowPicking;
  for (let i = dirtyOffset; i < dirtyOffset + dirtyCount; i++) {
    collection.get(i, scratchPoint);
    if (!scratchPoint._dirty) {
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
    scratchPoint.getPosition(scratchCart);
    EncodedCartesian3.fromCartesian(scratchCart, scratchEnc);
    scratchPoint.getMaterial(scratchPointMat);
    Color.fromRgba(scratchPoint._pickId, scratchColor);

    cache.positionHighArr[i * 3] = scratchEnc.high.x;
    cache.positionHighArr[i * 3 + 1] = scratchEnc.high.y;
    cache.positionHighArr[i * 3 + 2] = scratchEnc.high.z;
    cache.positionLowArr[i * 3] = scratchEnc.low.x;
    cache.positionLowArr[i * 3 + 1] = scratchEnc.low.y;
    cache.positionLowArr[i * 3 + 2] = scratchEnc.low.z;
    cache.pickColorArr[i * 4] = Color.floatToByte(scratchColor.red);
    cache.pickColorArr[i * 4 + 1] = Color.floatToByte(scratchColor.green);
    cache.pickColorArr[i * 4 + 2] = Color.floatToByte(scratchColor.blue);
    cache.pickColorArr[i * 4 + 3] = Color.floatToByte(scratchColor.alpha);
    cache.showSizeAndColorArr[i * 3] = scratchPoint.show ? 1 : 0;
    cache.showSizeAndColorArr[i * 3 + 1] = scratchPointMat.size;
    cache.showSizeAndColorArr[i * 3 + 2] = AttributeCompression.encodeRGB8(
      scratchPointMat.color,
    );
    cache.outlineWidthAndOutlineColorArr[i * 2] = scratchPointMat.outlineWidth;
    cache.outlineWidthAndOutlineColorArr[i * 2 + 1] =
      AttributeCompression.encodeRGB8(scratchPointMat.outlineColor);

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

function updateWebGPUBufferPointCollection(
  collection: BufferPrimitiveCollection,
  frameState: CesiumFrameState,
): void {
  if (!collection.show) {
    return;
  }
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const format: GPUTextureFormat = navigator.gpu.getPreferredCanvasFormat();

  let cache = collection._webgpuCache as PointCache | undefined;
  if (!cache) {
    cache = initPointCache(collection, context, format);
    collection._webgpuCache = cache;
    collection._dirtyOffset = 0;
    collection._dirtyCount = collection.primitiveCount;
  }

  if (collection._dirtyCount > 0) {
    repackPointDirty(collection, cache, context);
    uploadPointBuffers(device, cache);
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

  if (frameState.passes.render) {
    if (!cache.command) {
      cache.command = new WebGPUDrawCommand({
        pipeline: cache.pipeline,
        bindGroups: bgs,
        vertexBuffers: vbs,
        vertexCount: 6,
        instanceCount: primitiveCount,
        pass: Pass.TRANSLUCENT,
      });
    } else {
      cache.command.instanceCount = primitiveCount;
    }
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
      });
    } else {
      cache.pickCommand.instanceCount = primitiveCount;
    }
    frameState.commandList.push(cache.pickCommand);
  }

  collection._dirtyCount = 0;
  collection._dirtyOffset = 0;
}

function destroyWebGPUBufferPointCollection(
  collection: BufferPrimitiveCollection,
): void {
  const cache = collection._webgpuCache as PointCache | undefined;
  if (!cache) {
    return;
  }
  destroyPickIds(cache);
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

// ─── Exports ─────────────────────────────────────────────────────────────────

export {
  updateWebGPUBufferPolygonCollection,
  destroyWebGPUBufferPolygonCollection,
  updateWebGPUBufferPolylineCollection,
  destroyWebGPUBufferPolylineCollection,
  updateWebGPUBufferPointCollection,
  destroyWebGPUBufferPointCollection,
};
