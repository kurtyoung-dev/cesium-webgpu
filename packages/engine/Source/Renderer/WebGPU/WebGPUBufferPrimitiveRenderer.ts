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
// NEW-WEBGPU-BUFFERPOLYGON-WGSL-IMPORT (Batch 180) — the Buffer* material
// WGSL uses bare `#import Name;` directives. The runtime preprocessor that
// was supposed to resolve them (`context.shaderCache.preprocessOnly`) is
// never wired — `context.shaderCache` is the WebGL `ShaderCache` (no
// `preprocessOnly`), the `WebGPUShaderCache` is never instantiated, AND its
// `WGSLShaderPreprocessor` only matches the quoted `// #import "path"` form,
// not the bare `#import Name;` form — so the directives reached the WGSL
// compiler verbatim and `#` failed as an invalid token. Resolve them
// deterministically by inlining the chunk source from this map, matching the
// JS-string-interpolation pattern every other WebGPU renderer uses (e.g.
// GroundPrimitive's `${csm_depthClamp}`). All five chunks are leaf (no
// nested `#import`), so a single in-place pass suffices.
import CameraUniformsChunk from "../../Shaders/WebGPU/chunks/structs/CameraUniforms.js";
import csm_translateRelativeToEyeChunk from "../../Shaders/WebGPU/chunks/functions/csm_translateRelativeToEye.js";
import csm_decodeRGB8Chunk from "../../Shaders/WebGPU/chunks/functions/csm_decodeRGB8.js";
import csm_vertexLogDepthChunk from "../../Shaders/WebGPU/chunks/functions/csm_vertexLogDepth.js";
import csm_writeLogDepthChunk from "../../Shaders/WebGPU/chunks/functions/csm_writeLogDepth.js";
import { preprocess } from "./WebGPUShaderPreprocessor.js";
import { packCameraLogDepthLanes } from "./WebGPULogDepth.js";

// NEW-BUFFER-LOG-DEPTH (Batch 263) — the Buffer* material shaders now join the
// renderer-wide logarithmic-depth epic. They use the SAME canonical chunk
// library as the five collection shaders + Model PBR:
//   vertex:   v_logDepth = csm_vertexLogDepth(clipPos, near);
//             out.position = csm_updatePositionDepth(clipPos);
//   fragment: out.depth = csm_writeLogDepth(v_logDepth, factor);  // @builtin(frag_depth)
// The `near` / `factor` (= oneOverLog2FarDepthFromNearPlusOne) scalars ride in
// the reserved `.w` pad lanes of the shared `CameraUniforms` struct
// (encodedCameraPositionMCHigh.w / cameraPosition.w — see WebGPULogDepth.ts +
// chunks/structs/CameraUniforms.wgsl), packed by `packCameraLogDepthLanes`.
//
// Previously these import names resolved to a 1-arg `csm_vertexLogDepth` + an
// empty `csm_writeLogDepth` no-op, so the Buffer family ALWAYS wrote hyperbolic
// NDC depth and never consulted `isWebGPULogDepthActive`. That stub comment was
// actively wrong as of Batch 251: the WebGPU globe writes LOG depth now, so the
// Buffer fill geometry sank behind terrain at far cameras whenever the master
// switch was on. The `//>>else` branch of each shader keeps the historical
// hyperbolic path so LOG_DEPTH-off is byte-identical. `csm_updatePositionDepth`
// ships inside the `csm_vertexLogDepth` chunk; both chunks are leaf (no nested
// `#import`).
const BUFFER_WGSL_CHUNKS: Record<string, string> = {
  CameraUniforms: CameraUniformsChunk,
  csm_translateRelativeToEye: csm_translateRelativeToEyeChunk,
  csm_vertexLogDepth: csm_vertexLogDepthChunk,
  csm_writeLogDepth: csm_writeLogDepthChunk,
  csm_decodeRGB8: csm_decodeRGB8Chunk,
};
const _warnedUnknownImports = new Set<string>();

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
  // World-space bounding sphere for the whole collection (shown + hidden
  // primitives). Scene-side `_updateBoundingVolume` keeps it current when the
  // collection opts into auto-update, so the renderer re-reads it onto the draw
  // command every frame. Mirrors `collection.boundingVolume` consumed by the
  // WebGL render*Collection.js paths — drives per-frustum culling + the
  // debugShowBoundingVolume overlay.
  boundingVolume?: CesiumBoundingSphere;
  // Debug-only: draw the collection bounding sphere as an overlay. Public
  // mutable field on the collection (can flip at runtime), so the renderer
  // refreshes it onto the command each frame rather than only at build time.
  debugShowBoundingVolume?: boolean;
  // Blend option (BlendOption enum value): OPAQUE (0) vs TRANSLUCENT (1).
  // Defaults to TRANSLUCENT when absent. Selects the OPAQUE pipeline variant
  // (blend off, depth write on) + routes the command to Pass.OPAQUE. Mirrors
  // `collection._blendOption` read by the WebGL paths.
  _blendOption?: number;
  // Flat interleaved [x,y,z,...] position store. DOUBLE (Float64Array) by
  // default; FLOAT (Float32Array) when the collection opts into low-precision
  // positions. For points, position index i maps to _positionView[i*3..i*3+2]
  // (vertexOffset == index), so a dirty [offset,count) slice is contiguous —
  // consumed directly by the WASM batch RTE encode (NEW-BUFFERCOLL-WASM-ENCODE-WIRE).
  _positionView: Float64Array | Float32Array;
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

  // NEW-BUFFER-LOG-DEPTH (Batch 263) — fill the reserved `.w` pad lanes of the
  // CameraUniforms struct with the per-frustum log-depth scalars (factor at
  // float 51, near at 55, far at 59). Safe to call unconditionally: it only
  // writes previously-zero pads, so it is inert until a shader reads them and
  // a pipeline activates the LOG_DEPTH define. Cast to the LogDepthUniformState
  // shape the helper expects (currentFrustum + the precomputed reciprocal).
  packCameraLogDepthLanes(
    out,
    0,
    uniformState as unknown as Parameters<typeof packCameraLogDepthLanes>[2],
  );
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
  // NEW-BUFFER-LOG-DEPTH (Batch 263) — active-defines bitmask. The Buffer*
  // shaders now carry `//>>ifdef LOG_DEPTH` blocks; resolving them depends on
  // the bitmask, so the processed-source cache keys by (name, defines).
  defines: number = 0,
): string {
  const cacheKey = `${name}|${defines}`;
  let processed = _processedShaderCache.get(cacheKey);
  if (processed) {
    return processed;
  }
  // NEW-WEBGPU-BUFFERPOLYGON-WGSL-IMPORT (Batch 180) — resolve the bare
  // `#import Name;` directives by inlining the chunk source. This replaces
  // the previously-dead `context.shaderCache.preprocessOnly` branch (that
  // method never existed on the WebGL `ShaderCache` that `context.shaderCache`
  // actually returns, so `#import` lines reached the WGSL compiler verbatim →
  // "invalid character" on `#`). De-dupe so a chunk imported by both the VS
  // and FS isn't emitted twice (redeclaration error); strip + warn-once on an
  // unknown name so a stray directive can never break compilation again.
  const emitted = new Set<string>();
  processed = source.replace(
    /^[ \t]*#import\s+([A-Za-z_]\w*)\s*;?[ \t]*\r?\n?/gm,
    (_full: string, importName: string): string => {
      const chunk = BUFFER_WGSL_CHUNKS[importName];
      if (chunk === undefined) {
        //>>includeStart('debug', pragmas.debug);
        if (!_warnedUnknownImports.has(importName)) {
          _warnedUnknownImports.add(importName);
          console.warn(
            `[WebGPU:BufferPrimitive] shader "${name}" has unresolved WGSL ` +
              `#import "${importName}" (not in BUFFER_WGSL_CHUNKS) — stripped. ` +
              `Add the chunk to the map if the shader needs it.`,
          );
        }
        //>>includeEnd('debug');
        return "";
      }
      if (emitted.has(importName)) {
        return ""; // already inlined (dedupe across VS/FS import blocks)
      }
      emitted.add(importName);
      return `${chunk}\n`;
    },
  );
  // `context.shaderCache` is intentionally unused for import resolution — it
  // is the WebGL `ShaderCache` (no `preprocessOnly`); kept in the signature
  // for API stability with other callers.
  void context;
  // NEW-BUFFER-LOG-DEPTH (Batch 263) — resolve the `//>>ifdef LOG_DEPTH`
  // conditional blocks against the active-defines bitmask AFTER `#import`
  // inlining (the chunks themselves carry no directives, so order is safe).
  // `defines=0` emits the `//>>else` branch of every block byte-identically to
  // the historical hyperbolic path. Done BEFORE the pick suffix is appended so
  // the pick FS never sees a frag_depth write (pick stays hyperbolic).
  processed = preprocess(processed!, defines);
  // Append the pick fragment entry. Done after preprocessing so the pick
  // function references the already-resolved VertexOutput struct definition.
  processed = processed + PICK_FRAGMENT_SUFFIX;
  _processedShaderCache.set(cacheKey, processed!);
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
