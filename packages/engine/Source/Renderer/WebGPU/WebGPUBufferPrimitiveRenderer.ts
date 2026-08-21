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
 * Each collection caches its GPU resources on a `_webgpuCache`
 * field. A dirty range is repacked on the CPU and uploaded through
 * `writeBuffer` without a full reupload.
 *
 * @module WebGPUBufferPrimitiveRenderer
 */

import BoundingSphere from "../../Core/BoundingSphere.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Color from "../../Core/Color.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import AttributeCompression from "../../Core/AttributeCompression.js";
import ComponentDatatype from "../../Core/ComponentDatatype.js";
import IndexDatatype from "../../Core/IndexDatatype.js";
import SceneMode from "../../Scene/SceneMode.js";
import SceneTransforms from "../../Scene/SceneTransforms.js";
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
// Buffer material WGSL uses bare `#import Name;` directives, while the general
// preprocessor recognizes quoted path imports. Resolve the bare names directly
// from this leaf-chunk table before normal WGSL preprocessing.
import CameraUniformsChunk from "../../Shaders/WebGPU/chunks/structs/CameraUniforms.js";
import csm_translateRelativeToEyeChunk from "../../Shaders/WebGPU/chunks/functions/csm_translateRelativeToEye.js";
import csm_decodeRGB8Chunk from "../../Shaders/WebGPU/chunks/functions/csm_decodeRGB8.js";
import csm_vertexLogDepthChunk from "../../Shaders/WebGPU/chunks/functions/csm_vertexLogDepth.js";
import csm_writeLogDepthChunk from "../../Shaders/WebGPU/chunks/functions/csm_writeLogDepth.js";
import { preprocess } from "./WebGPUShaderPreprocessor.js";
import { packCameraLogDepthLanes } from "./WebGPULogDepth.js";

// Buffer material shaders use the canonical logarithmic-depth chunks shared by
// the collection and model pipelines:
//   vertex:   v_logDepth = csm_vertexLogDepth(clipPos, near);
//             out.position = csm_updatePositionDepth(clipPos);
//   fragment: out.depth = csm_writeLogDepth(v_logDepth, factor);  // @builtin(frag_depth)
// The `near` / `factor` (= oneOverLog2FarDepthFromNearPlusOne) scalars ride in
// the reserved `.w` pad lanes of the shared `CameraUniforms` struct
// (encodedCameraPositionMCHigh.w / cameraPosition.w — see WebGPULogDepth.ts +
// chunks/structs/CameraUniforms.wgsl), packed by `packCameraLogDepthLanes`.
//
// The reserved camera padding lanes carry the near and factor values and remain
// inert when the logarithmic-depth define is absent. `csm_updatePositionDepth`
// is included by the vertex-depth chunk; both depth chunks are leaves.
const BUFFER_WGSL_CHUNKS: Record<string, string> = {
  CameraUniforms: CameraUniformsChunk,
  csm_translateRelativeToEye: csm_translateRelativeToEyeChunk,
  csm_vertexLogDepth: csm_vertexLogDepthChunk,
  csm_writeLogDepth: csm_writeLogDepthChunk,
  csm_decodeRGB8: csm_decodeRGB8Chunk,
};
const _warnedUnknownImports = new Set<string>();

// All three buffer-primitive renderers share a per-device module cache keyed by
// source identifier and active defines.
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
  // (vertexOffset == index), so a dirty [offset,count) slice is contiguous and
  // can be consumed directly by a batch relative-to-eye encoder.
  _positionView: Float64Array | Float32Array;
  // Component datatype of `_positionView`.
  // DOUBLE (default) / FLOAT store model-space positions directly; the integer
  // datatypes (BYTE/UNSIGNED_BYTE/SHORT/UNSIGNED_SHORT/INT/UNSIGNED_INT) hold a
  // compressed representation that the encode path treats as raw model-space
  // integers, or — when `_positionNormalized` — dequantizes to [-1,1] / [0,1].
  _positionDatatype?: number;
  // When true, the full integer position range maps to [-1,1] for signed
  // data or [0,1] (unsigned), matching the WebGL vertex-attribute `normalize`
  // flag. Only meaningful for integer position datatypes.
  _positionNormalized?: boolean;
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
  // Scene-mode and morph state consumed by `bufferModeNeedsRepack` to force a
  // repack when the projection frame
  // changes. Optional so cache-construction sites don't have to seed them
  // (undefined → first non-3D frame re-packs, which is the desired behavior).
  _lastPackMode?: number;
  _lastPackMorphTime?: number;
  // Per-cache storage for projected and morph-union bounding spheres computed by
  // `computeBufferModeBoundingVolume`. Per-cache (not module scratch) because
  // the draw command holds the reference across the frame — a shared scratch
  // would alias between collections updated in the same frame.
  _modeBV?: CesiumBoundingSphere;
  _modeBVMorph?: CesiumBoundingSphere;
}

// ─── Scratch ─────────────────────────────────────────────────────────────────

export const scratchColor = new Color();
export const scratchCart = new Cartesian3();
export const scratchEnc = { high: new Cartesian3(), low: new Cartesian3() };

// Integer and normalized position decoding.

/**
 * When a buffer collection stores integer positions with
 * `positionNormalized:true`, the raw values map
 * onto [-1,1] (signed) / [0,1] (unsigned) exactly like the WebGL vertex
 * attribute `normalize` flag (see `renderBuffer*Collection.js`, which sets
 * `normalize: collection._positionNormalized` on the `position` attribute, and
 * the GLSL `#else` branch that feeds `czm_modelView * vec4(position,1)`). The
 * WebGPU renderers have no integer vertex-attribute path — they always RTE-encode
 * the model-space position into positionHigh/positionLow — so they must apply
 * the same normalization the WebGL GPU applies before the encode.
 *
 * Returns the per-component divisor (matching
 * `Core/AttributeCompression.dequantize` and the GL2 signed-normalize
 * convention `max(c / (2^(b-1)-1), -1)`), or 0 when no normalization applies
 * to floating-point positions or when `positionNormalized` is false or unset.
 * A zero return leaves the raw values unchanged because the per-vertex guard
 * `divisor !== 0` skips the decode entirely.
 * @private
 */
export function bufferPositionNormalizeDivisor(
  collection: BufferPrimitiveCollection,
): number {
  if (collection._positionNormalized !== true) {
    return 0;
  }
  switch (collection._positionDatatype) {
    case ComponentDatatype.BYTE:
      return 127.0;
    case ComponentDatatype.UNSIGNED_BYTE:
      return 255.0;
    case ComponentDatatype.SHORT:
      return 32767.0;
    case ComponentDatatype.UNSIGNED_SHORT:
      return 65535.0;
    case ComponentDatatype.INT:
      return 2147483647.0;
    case ComponentDatatype.UNSIGNED_INT:
      return 4294967295.0;
    default:
      // FLOAT / DOUBLE: normalization is meaningless — encode raw (byte-identical).
      return 0;
  }
}

/**
 * Dequantizes a raw integer position in place to its normalized model-space
 * value, matching `Core/AttributeCompression.dequantize` (and the WebGL GPU
 * normalize). `divisor` must come from {@link bufferPositionNormalizeDivisor};
 * callers guard on `divisor !== 0` so the
 * non-normalized path stays branch-free at the encode.
 * @private
 */
export function normalizeBufferPositionInPlace(
  cart: Cartesian3,
  divisor: number,
): void {
  cart.x = Math.max(cart.x / divisor, -1.0);
  cart.y = Math.max(cart.y / divisor, -1.0);
  cart.z = Math.max(cart.z / divisor, -1.0);
}

// Scene-mode position reprojection.

const scratchProjectModelPoint = new Cartesian3();

/**
 * Maps an ECEF world position into the active scene mode's render frame,
 * matching the WebGPU polyline-collection convention.
 *
 *   SCENE3D        — returns the raw ECEF position as a clone.
 *                    The mode-aware `mvpRelativeToEye` built from
 *                    `uniformState.view/projection` already folds in the
 *                    collection modelMatrix, so the un-transformed ECEF position
 *                    is what the 3D encode path requires.
 *   2D / CV / Morph — projects the modelMatrix-applied world position through
 *                    `SceneTransforms.computeActualEllipsoidPosition`, which
 *                    applies the `.zxy` swizzle for Columbus View, the
 *                    `(0, x, y)` collapse for 2D, and the CPU-side per-vertex
 *                    lerp by `frameState.morphTime` for MORPHING.
 *
 * `modelMatrix` is the collection's modelMatrix (identity in the common case,
 * where the multiply is a no-op clone). Returns `result` (a Cartesian3).
 * @private
 */
export function projectBufferPositionForMode(
  position: Cartesian3,
  frameState: CesiumFrameState,
  modelMatrix: CesiumMatrix4,
  result: Cartesian3,
): Cartesian3 {
  if (frameState.mode === SceneMode.SCENE3D) {
    return Cartesian3.clone(position, result);
  }
  // 2D / CV / Morph: project the modelMatrix-applied world position.
  Matrix4.multiplyByPoint(
    modelMatrix as unknown as Matrix4,
    position,
    scratchProjectModelPoint,
  );
  const actual = SceneTransforms.computeActualEllipsoidPosition(
    frameState,
    scratchProjectModelPoint,
    result,
  ) as Cartesian3 | undefined;
  // `computeActualEllipsoidPosition` returns undefined when the point has no
  // valid cartographic (e.g. exactly at the ellipsoid center). Fall back to the
  // world point so the vertex still carries finite data.
  return defined(actual)
    ? actual
    : Cartesian3.clone(scratchProjectModelPoint, result);
}

/**
 * Returns true when cached positions must be fully repacked because the
 * scene-mode projection frame changed since the last
 * pack. In non-3D modes the packed positions depend on `frameState.mode` and
 * (during MORPHING) `frameState.morphTime`; the Buffer* collections use
 * persistent GPU buffers with dirty-range tracking, so a mode/morph change with
 * no primitive edits would otherwise leave stale positions on the GPU. Updates
 * the tracked `_lastPack*` state on the cache as a side effect.
 *
 * SCENE3D is a no-op: it returns false and leaves `_lastPackMode` at 3 without
 * touching morphTime, so a pure-3D collection never triggers a forced re-pack
 * touching morphTime. The first non-3D frame repacks because the tracked mode
 * transitions away from Scene 3D.
 * @private
 */
export function bufferModeNeedsRepack(
  cache: SharedCache,
  frameState: CesiumFrameState,
): boolean {
  const mode = frameState.mode;
  if (mode === SceneMode.SCENE3D) {
    const changed = cache._lastPackMode !== SceneMode.SCENE3D;
    cache._lastPackMode = SceneMode.SCENE3D;
    return changed;
  }
  // Non-3D: morphTime only varies during MORPHING; in settled 2D/CV it is a
  // fixed 0.0, so the comparison naturally stops forcing re-packs once settled.
  const morphTime = frameState.morphTime;
  const changed =
    cache._lastPackMode !== mode || cache._lastPackMorphTime !== morphTime;
  cache._lastPackMode = mode;
  cache._lastPackMorphTime = morphTime;
  return changed;
}

/** Static-side shape of the JS-only BoundingSphere class we call through. */
interface BoundingSphereStatics {
  projectTo2D(
    sphere: CesiumBoundingSphere,
    projection: CesiumOpaqueMapProjection,
    result?: CesiumBoundingSphere,
  ): CesiumBoundingSphere;
  union(
    left: CesiumBoundingSphere,
    right: CesiumBoundingSphere,
    result?: CesiumBoundingSphere,
  ): CesiumBoundingSphere;
}

/**
 * Returns a scene-mode-aware command bounding volume. This mirrors
 * `PrimitiveCommandHelpers.updateAndQueueCommands`: Scene 3D uses the
 * collection's ECEF sphere; 2D and Columbus View use
 * `BoundingSphere.projectTo2D`; morphing unions both spheres so the command
 * stays visible throughout the blend.
 *
 * Storage lives on the cache (`_modeBV` / `_modeBVMorph`) because the command
 * holds the returned reference across the frame.
 * @private
 */
export function computeBufferModeBoundingVolume(
  collection: BufferPrimitiveCollection,
  frameState: CesiumFrameState,
  cache: SharedCache,
): CesiumBoundingSphere | undefined {
  const bv = collection.boundingVolume;
  if (frameState.mode === SceneMode.SCENE3D || !defined(bv)) {
    return bv;
  }
  const bs = jsModule<BoundingSphereStatics>(BoundingSphere);
  cache._modeBV = bs.projectTo2D(bv, frameState.mapProjection, cache._modeBV);
  if (frameState.mode === SceneMode.MORPHING) {
    cache._modeBVMorph = bs.union(bv, cache._modeBV, cache._modeBVMorph);
    return cache._modeBVMorph;
  }
  return cache._modeBV;
}

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

  // Fill reserved camera padding lanes with per-frustum log-depth scalars (factor at
  // float 51, near at 55, far at 59). Safe to call unconditionally: it only
  // writes otherwise-unused pads, so it is inert until a shader reads them and
  // a pipeline activates the log-depth define. Cast to the LogDepthUniformState
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
 *
 * Without the pick-log define, this resolves to a single color output at
 * location zero. With the define, it also writes logarithmic fragment depth
 * from the same varying and camera factor used by the color fragment shader.
 *
 * Pick depth uses an independent switch because every producer sharing the pick
 * framebuffer must use the same depth encoding. The color module preprocesses
 * this unused suffix without pick-log depth; an enabled pick path builds a
 * separate module through `preprocessPickShader`.
 */
const PICK_FRAGMENT_SUFFIX = `

struct PickFragOutput {
  @location(0) color : vec4<f32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth : f32,
  //>>endif
};

@fragment
fn fragmentPickMain(input : VertexOutput) -> PickFragOutput {
  // Match the color path's alpha discard so picks line up exactly with
  // visible pixels (no picking through translucent fringes).
  if (input.v_color.a < 0.005) { discard; }
  var out : PickFragOutput;
  out.color = input.v_pickColor;
  //>>ifdef LOG_DEPTH
  // Same varying + factor field the color FS (fragmentMain) writes. NO
  // near-discard — the color sibling has none, and mirroring it exactly is the
  // parity contract (the color path relies on the VS clip-z clamp).
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.cameraPosition.w);
  //>>endif
  return out;
}
`;

/**
 * Salt for pick-module cache keys. Color and pick modules can share a source
 * identifier and define bits while containing different generated WGSL.
 * The `keySalt` accepted by `WebGPUShaderModuleCache.getOrCreate` prevents the
 * cache from returning the wrong module.
 */
export const BUFFER_PICK_MODULE_KEYSALT = 0x5049434b; // 'PICK'

/**
 * Resolves bare `#import Name;` directives by inlining entries from the buffer
 * chunk table before general preprocessing. Shared by color and pick paths. A
 * chunk imported by both stages is emitted once to avoid redeclaration;
 * unknown names are stripped and reported once so
 * directives cannot reach the WGSL compiler.
 */
function resolveBufferImports(name: string, source: string): string {
  const emitted = new Set<string>();
  return source.replace(
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
}

export function preprocessShader(
  context: CesiumGraphicsContext,
  name: string,
  source: string,
  // Active shader defines are part of the processed-source cache key because
  // conditional blocks depend on
  // the bitmask, so the processed-source cache keys by (name, defines).
  defines: number = 0,
): string {
  const cacheKey = `${name}|${defines}`;
  let processed = _processedShaderCache.get(cacheKey);
  if (processed) {
    return processed;
  }
  // `context.shaderCache` is intentionally unused for import resolution — it is
  // the WebGL `ShaderCache` (no `preprocessOnly`); kept in the signature for
  // API stability with other callers.
  void context;
  const imported = resolveBufferImports(name, source);
  // Preprocess the color body against scene defines. Resolve the appended pick
  // suffix separately without pick-log depth so scene state cannot leak into
  // the shared pick framebuffer. An enabled pick-log path builds its distinct
  // module through `preprocessPickShader`.
  processed =
    preprocess(imported, defines) + preprocess(PICK_FRAGMENT_SUFFIX, 0);
  _processedShaderCache.set(cacheKey, processed);
  return processed;
}

/**
 * Builds the pick-module source variant. The whole source, including the
 * vertex output and appended suffix, is preprocessed against `pickDefines` so
 * logarithmic pick depth is independent of color-pass scene state.
 *
 * When pick-log depth is inactive, renderers reuse the color module returned by
 * `preprocessShader`. The extra `fragmentMain` this module carries is unused by
 * the pick pipeline, which references
 * `fragmentPickMain`) but must still compile — which it does in either state.
 */
export function preprocessPickShader(
  context: CesiumGraphicsContext,
  name: string,
  source: string,
  pickDefines: number,
): string {
  const cacheKey = `${name}|pick|${pickDefines}`;
  let processed = _processedShaderCache.get(cacheKey);
  if (processed) {
    return processed;
  }
  void context;
  const imported = resolveBufferImports(name, source);
  processed =
    preprocess(imported, pickDefines) +
    preprocess(PICK_FRAGMENT_SUFFIX, pickDefines);
  _processedShaderCache.set(cacheKey, processed);
  return processed;
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

// Re-export the focused polygon path so parent-module imports remain valid.
export {
  updateWebGPUBufferPolygonCollection,
  destroyWebGPUBufferPolygonCollection,
} from "./WebGPUBufferPolygonRenderer.js";

// Re-export the focused polyline path through the parent module.
export {
  updateWebGPUBufferPolylineCollection,
  destroyWebGPUBufferPolylineCollection,
} from "./WebGPUBufferPolylineRenderer.js";

// Re-export the focused point path through the parent module.
export {
  updateWebGPUBufferPointCollection,
  destroyWebGPUBufferPointCollection,
} from "./WebGPUBufferPointRenderer.js";
