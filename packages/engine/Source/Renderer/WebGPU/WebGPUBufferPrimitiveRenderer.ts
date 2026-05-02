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
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";

// C-R7-SHADER-MODULE-DEDUP (Batch 164) — single per-device cache shared
// across all 3 BufferPrimitive renderers. Each per-device cache keys by
// (sourceId, defines), so one map is enough for Point/Polyline/Polygon —
// the source IDs are distinct.
const _bufferPrimitiveShaderCaches = new WeakMap<
  GPUDevice,
  WebGPUShaderModuleCache
>();

export function getBufferPrimitiveShaderCache(
  device: GPUDevice,
): WebGPUShaderModuleCache {
  let cache = _bufferPrimitiveShaderCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _bufferPrimitiveShaderCaches.set(device, cache);
  }
  return cache;
}

/** Type-shape we use to call the JS-only IndexDatatype.createTypedArray. */
export interface IndexDatatypeStatics {
  createTypedArray: (
    vertexCountMax: number,
    indexCount: number,
  ) => Uint16Array | Uint32Array;
}

// ─── Shared types ────────────────────────────────────────────────────────────

/** Minimal interface for the BufferPrimitive collection objects passed from
 *  Scene JS code. Covers properties read by the renderer functions. */
export interface BufferPrimitiveCollection {
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
  // The narrow shape (`PolygonCache` / `PolylineCache` / `PointCache`)
  // lives in each per-collection module and is recovered there via a
  // type-narrowing cast on the cached value. Storing as `SharedCache`
  // keeps the parent module free of cross-imports while preserving the
  // contract that whatever sits here always extends `SharedCache`.
  _webgpuCache?: SharedCache;
  get(index: number, result?: CesiumOpaqueObject): CesiumOpaqueObject;
}

/** A pick ID created by context.createPickId(). */
export interface CesiumPickIdRef {
  destroy(): void;
}

/** CameraUniforms struct (368 bytes) — see Shaders/WebGPU/chunks/structs/CameraUniforms.wgsl */
export const CAMERA_UBO_BYTES = 368;
export const CAMERA_UBO_FLOATS = CAMERA_UBO_BYTES / 4;

export interface SharedCache {
  cameraUBO: GPUBuffer;
  cameraData: Float32Array;
}

// ─── Scratch ─────────────────────────────────────────────────────────────────

export const scratchColor = new Color();
export const scratchCart = new Cartesian3();
export const scratchEnc = { high: new Cartesian3(), low: new Cartesian3() };

// ─── Camera UBO packing ──────────────────────────────────────────────────────

export function packCameraUniforms(
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

export function preprocessShader(
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

export function makeCameraBindGroupLayout(
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

// ─── Common helpers ──────────────────────────────────────────────────────────

export function createSharedCacheBase(device: GPUDevice): SharedCache {
  return {
    cameraUBO: device.createBuffer({
      label: "BufferPrimitive camera UBO",
      size: CAMERA_UBO_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    cameraData: new Float32Array(CAMERA_UBO_FLOATS),
  };
}

export function createVB(
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

export function createIB(
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

export function destroyPickIds(cache: { pickIds: CesiumPickIdRef[] }): void {
  for (const id of cache.pickIds) {
    if (id && typeof id.destroy === "function") {
      id.destroy();
    }
  }
  cache.pickIds.length = 0;
}

// ─── BufferPolylineCollection ────────────────────────────────────────────────

// ─── BufferPointCollection ───────────────────────────────────────────────────

// ─── Exports ─────────────────────────────────────────────────────────────────

// Polygon path moved to its own module (Batch 155); re-exported here so
// existing import sites continue to resolve through the parent module.
export {
  updateWebGPUBufferPolygonCollection,
  destroyWebGPUBufferPolygonCollection,
} from "./WebGPUBufferPolygonRenderer.js";

// Polyline path moved to its own module (Batch 156); same re-export pattern.
export {
  updateWebGPUBufferPolylineCollection,
  destroyWebGPUBufferPolylineCollection,
} from "./WebGPUBufferPolylineRenderer.js";

// Point path moved to its own module (Batch 157); same re-export pattern.
export {
  updateWebGPUBufferPointCollection,
  destroyWebGPUBufferPointCollection,
} from "./WebGPUBufferPointRenderer.js";
