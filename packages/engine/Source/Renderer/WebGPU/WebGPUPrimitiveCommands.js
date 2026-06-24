/**
 * WebGPU command creation and per-frame uniform update logic for the Primitive
 * rendering pipeline. Extracted from Primitive.js for better organization and
 * maintainability.
 *
 * Contains:
 * - createWebGPUCommands() — builds GPU pipelines, buffers, bind groups, and draw commands
 * - updateWebGPUCommandUniforms() — per-frame camera matrix updates for GPU uniform buffers
 *
 * ALL rendering uses RTE (Relative-To-Eye) emulated 64-bit precision:
 * - Vertex buffers carry positionHigh(3) + positionLow(3) for each vertex
 * - Uniform buffers carry mvpRelativeToEye + encodedCameraHigh/Low
 * - Shaders use translateRelativeToEye() for sub-meter precision at planetary scale
 *
 * @private
 * @module WebGPUPrimitiveCommands
 */
import AttributeCompression from "../../Core/AttributeCompression.js";
import BoundingRectangle from "../../Core/BoundingRectangle.js";
import Cartesian2 from "../../Core/Cartesian2.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import ComponentDatatype from "../../Core/ComponentDatatype.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import GeometryAttribute from "../../Core/GeometryAttribute.js";
import Matrix4 from "../../Core/Matrix4.js";
import Pass from "../Pass.js";
import PrimitiveType from "../../Core/PrimitiveType.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import WebGPUShaderModule from "./WebGPUShaderModule.js";
import {
  makeBindGroupLayout,
  sampler,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { WebGPUTexture } from "./WebGPUTexture.js";
import {
  selectWebGPUShader,
  getVertexLayoutForShader,
  getPolylineAppearanceVertexLayout,
  selectPolylineMaterialShader,
  getPolylineMaterialVertexLayout,
  getShaderSource,
  getPickShaderForType,
  getMaterialPickShaderForType,
  isPhongShader,
  isTexturedShader,
  selectMaterialShader,
  getMaterialVertexLayout,
  isMaterialLitShader,
  isPBRShader,
} from "./WebGPUPrimitiveShaders.js";
import { preprocess as preprocessShaderSource } from "./WebGPUShaderPreprocessor.js";
import { ShaderDefine } from "./WebGPUShaderDefines.js";
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";
import {
  getEffectsBindGroupLayout,
  getPlaceholderEffects,
  createEffectsBindGroup,
} from "./WebGPUEffectsBindGroup.js";
// Slice 5d Batch 154 — Forward+ clustered lighting FS chunk + group-token
// substitution. Prepended to Mat*Lit shader sources so they declare the
// cluster bindings (18-22) at whichever group their effects BGL occupies
// (2 = no texture, 3 = textured) and gain evalClusteredLights().
import ClusteredLightingChunk from "../../Shaders/WebGPU/chunks/structs/ClusteredLighting.js";
import { substituteClusteredLightingGroup } from "./WebGPUClusteredLightingBGL.js";
// Slice 5c-B Phase 1 (Batch 105) — centralized scene-FB fragment-target
// builder. Returns a 1-target array today (mrtMode default off); when
// the Phase 2 atomic batch flips `setSceneFBMrtMode(true)`, every
// pipeline that uses this helper automatically produces 2-target
// arrays without per-renderer edits. The local `makeFragmentTarget`
// below is kept as a thin wrapper around `_buildSlot0`-equivalent
// behavior so the existing call sites can route through the helper
// without descriptor-shape drift (and so the pipeline cache hashes
// stay stable across the conversion).
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";

// =========================================================================
// Scratch variables for per-frame uniform updates (avoid per-frame allocations)
// =========================================================================
const scratchModelViewMatrix = new Matrix4();
const scratchModelViewRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchNormalMatrix = new Matrix4();
const scratchInverseModel = new Matrix4();
const scratchCameraPositionMC = new Cartesian3();
const scratchEncodedCamera = new EncodedCartesian3();
// Scratch for encoding a single vertex position
const scratchEncodedPosition = new EncodedCartesian3();
// RTE camera uniform scratch buffers (80 floats = 320 bytes max for lit with
// prevVP + the renderer-wide log-depth tail, see LIT_CAMERA_BYTES below).
const scratchRTEUniformData = new Float32Array(80);

// Camera-only UBO sizes (no material fields)
// DP-H41 (Batch 27) — each variant now carries previousViewProjection (mat4x4,
// 64 bytes) at the tail for TAA / motion-vector reprojection.
// Log-depth epic Slice 5 (Mat/PBR/Basic) — the flat variant ALSO gains a
// 16-byte logDepth vec4 tail (near, far, factor, reserved) AFTER prevVP, so
// the Flat material shaders (PrimitiveMat*Flat) and the unlit Basic shaders
// can read `camera.logDepth` from their `//>>ifdef LOG_DEPTH` blocks. Packed
// unconditionally by writeRTEUniformsFlat — inert until the LOG_DEPTH pipeline
// define is set (no shader struct declares the tail field otherwise and the
// extra 16 bytes are simply unread). 160 -> 176.
const FLAT_CAMERA_BYTES = 176; // mvpRTE(64) + camHigh(16) + camLow(16) + prevVP(64) + logDepth(16)
// Log-depth epic Slice 2b — lit variant gains a 16-byte logDepth vec4 tail
// (near, far, factor, reserved) AFTER prevVP. Read only by the
// `//>>ifdef LOG_DEPTH` blocks in PrimitivePhongColor / PrimitivePhongTexturedColor
// (and any future lit producer). The tail is packed unconditionally by
// writeRTEUniformsLit — it is inert until the LOG_DEPTH pipeline define is set
// (Slice 4 flip), because no shader struct declares the tail field otherwise
// and the extra 16 bytes are simply unread. Mat*Lit material shaders keep their
// 304-byte CameraUniforms struct and read only the first 304 bytes of this
// 320-byte buffer — valid WebGPU, byte-identical behavior.
const LIT_CAMERA_BYTES = 320; // ...prevVP(64) + logDepth(16)
const PICK_CAMERA_BYTES = 160; // same as flat

// NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU (COLOR slice) — the polyline
// appearance camera UB extends the flat parity head (mvpRTE + camHigh/Low)
// with the matrices the screen-space width-expansion math needs. Layout
// (floats, byte-locked to CameraUniforms in PolylineColorAppearance.wgsl):
//   0-15  mvpRelativeToEye        (parity; VS uses the ortho path)
//   16-19 encodedCameraHigh + pad
//   20-23 encodedCameraLow  + pad
//   24-39 projection
//   40-55 viewportTransformation
//   56-71 viewportOrthographic
//   72-87 modelViewRelativeToEye
//   88    pixelRatio
//   89    currentFrustumNear
//   90-91 pad
// 92 floats = 368 bytes; 256-aligned -> 512.
const POLYLINE_CAMERA_BYTES = 512;
const scratchPolylineUniformData = new Float32Array(POLYLINE_CAMERA_BYTES / 4);

// Placeholder material UBO for shaders that don't use material uniforms
// Must be at least 16 bytes (vec4) for WebGPU minimum binding size
const PLACEHOLDER_MATERIAL_BYTES = 16;
// Pick material: pickColor(vec4) = 16 bytes
const PICK_MATERIAL_BYTES = 16;

// =========================================================================
// DP-H19 — CPU decompression of `compressedAttributes`
// =========================================================================
//
// `GeometryPipeline.compressVertices()` (invoked when the Primitive has
// `compressVertices: true`, which is the DEFAULT) deletes the
// `normal` / `st` / `tangent` / `bitangent` attributes and replaces them
// with a single `compressedAttributes` Float32Array containing oct-packed
// normals and bit-packed UVs. The WebGPU primitive rendering path reads
// `geometry.attributes.normal` and `geometry.attributes.st` directly —
// which are deleted — so every default-configured Primitive rendered
// flat-shaded with black textures.
//
// The WebGL path handles this via `#ifdef COMPRESSED_VERTICES` in the
// vertex shader, decoding `compressedAttributes` on the GPU. We could
// mirror that in WGSL, but the shader-variant explosion across
// material-type × compressed-input × pick is substantial. For a simpler
// correctness fix we decode on the CPU here, reconstructing the original
// `normal` / `st` attributes as Float32Arrays. This loses the VRAM /
// bandwidth savings that compression is meant to provide, but makes
// every `compressVertices: true` primitive render correctly on WebGPU.
// Shader-side decode is tracked as **FOLLOW-UP DP-H19-SHADER-DECODE**.
//
// `compressVertices()` layout per-vertex (see `GeometryPipeline.js:1558-1615`):
//
//     components = (hasSt && hasNormal ? 2 : 1) + (hasTangent||hasBitangent ? 1 : 0)
//     slot[0]: if hasSt           → packedST (via `compressTextureCoordinates`)
//     slot[1]: if hasNormal AND hasTangent AND hasBitangent
//              → octPack(normal, tangent, bitangent) occupies 2 slots
//              else → one octEncodeFloat per (normal, tangent, bitangent)
//                    independently, in that order
//
// We consult `geometry._compressedAttributesMeta` (written by
// `GeometryPipeline.compressVertices` right before it starts encoding)
// to know which attributes were present so the decode is unambiguous.
// If the meta isn't attached (geometry came from a non-upstream code
// path), we fall back to inferring from `componentsPerAttribute` and
// log a one-time warning.
//
// Scratch Cartesians are reused across decode calls to avoid per-vertex
// allocations.

const scratchDecompressedNormal = new Cartesian3();
const scratchDecompressedTangent = new Cartesian3();
const scratchDecompressedBitangent = new Cartesian3();
const scratchDecompressedPacked = new Cartesian2();
const scratchDecompressedST = new Cartesian2();

let _decompressMissingMetaWarned = false;

/**
 * Reconstruct `normal` + `st` attributes on a geometry whose
 * `GeometryPipeline.compressVertices()` stripped them into
 * `compressedAttributes`. Idempotent: if the geometry already has
 * `normal` / `st` (or never had them), returns without side-effect.
 *
 * Writes the decoded attributes back onto `geometry.attributes` as
 * Float32Arrays so the rest of the WebGPU primitive command path can
 * read them through the normal `attrs.normal.values` / `attrs.st.values`
 * route. The compression metadata on the geometry is left untouched —
 * WebGL still sees it the same way.
 *
 * The one-time work per geometry is cached via the presence of the
 * decoded attributes; subsequent calls short-circuit.
 *
 * @param {object} geometry The geometry to inspect.
 * @private
 */
function ensureUncompressedAttributes(geometry) {
  const attrs = geometry.attributes;
  if (!defined(attrs)) {
    return;
  }

  const compressed = attrs.compressedAttributes;
  if (!defined(compressed) || !defined(compressed.values)) {
    return;
  }

  // Idempotence guard — if the primary targets (normal / st) are
  // already reconstructed, skip. Tangent / bitangent are write-once
  // side-products of the same decode pass, so they're either all
  // present together (post-Batch 27) or never attempted. The normal /
  // st presence check is the source of truth for "have we decoded
  // this geometry before."
  if (defined(attrs.normal) || defined(attrs.st)) {
    return;
  }

  const values = compressed.values;
  const componentsPerAttribute = compressed.componentsPerAttribute || 1;
  const numVertices = Math.floor(values.length / componentsPerAttribute);
  if (numVertices === 0) {
    return;
  }

  // Prefer the metadata snapshot written by `GeometryPipeline.compressVertices`
  // (see Batch 23 edit in Core/GeometryPipeline.js) — it tells us exactly
  // which source attributes were compressed. Falling back to inferring
  // from `componentsPerAttribute` is ambiguous for some combinations, so
  // we warn and skip to avoid producing wrong data.
  const meta = geometry._compressedAttributesMeta;
  let hasNormal;
  let hasSt;
  let hasTangent;
  let hasBitangent;
  if (defined(meta)) {
    // Shadow-volume extrude compression: no normal / st to reconstruct.
    if (meta.isExtrude === true) {
      return;
    }
    hasNormal = meta.hasNormal === true;
    hasSt = meta.hasSt === true;
    hasTangent = meta.hasTangent === true;
    hasBitangent = meta.hasBitangent === true;
  } else {
    // Fallback for geometries produced without the metadata stash. The
    // metadata is dropped when `Primitive` ships the compressed geometry
    // through its background worker (`PrimitivePipeline.packCreateGeometryResults`
    // packs `attributes` + `indices` only; `_compressedAttributesMeta`
    // doesn't survive the postMessage round-trip), so this branch is the
    // common case for app-level geometry, not an edge.
    //
    // `componentsPerAttribute` tells us the per-vertex slot count but
    // doesn't disambiguate single-slot geometries (1 = either normal-only
    // OR st-only). Sniff the first value's magnitude:
    //   - `compressTextureCoordinates`: 12-bit pair packed as `xHi*4096 + yLo`,
    //     range [0, 16777215]. Most real ST samples land > 65535.
    //   - `octEncodeFloat`: 8-bit pair packed as `xHi*256 + yLo`,
    //     range [0, 65535]. Always ≤ 65535.
    // A first value > 65535 ⇒ ST. Otherwise default to normal (the
    // historical inference). For 2-component compressedAttributes the
    // canonical layout is [st, normal] from `GeometryPipeline.compressVertices`.
    // Probe each slot of the first vertex. Slot values > 65535 cannot have
    // come from `octEncodeFloat` (which packs 8-bit pairs, max 65535) and
    // must be `compressTextureCoordinates` output (which packs 12-bit pairs,
    // max 16777215). The 2-component canonical layout is [st, normal] but
    // some pipelines produce [normal] only or [st] only and report
    // componentsPerAttribute=2 due to padding — sniff per-slot to avoid
    // mis-identifying a single-attribute geometry.
    if (componentsPerAttribute >= 1) {
      const probe0 = values[0];
      const slot0IsSt = probe0 > 65535;
      if (componentsPerAttribute >= 2) {
        const probe1 = values[1];
        const slot1IsSt = probe1 > 65535;
        // Two slots — canonical case is [st, normal], but tolerate the
        // inverted ordering some legacy paths produce by sniffing both
        // slots' magnitudes.
        hasSt = slot0IsSt || slot1IsSt;
        hasNormal = !slot0IsSt || !slot1IsSt;
      } else {
        hasNormal = !slot0IsSt;
        hasSt = slot0IsSt;
      }
    } else {
      hasNormal = false;
      hasSt = false;
    }
    hasTangent = false;
    hasBitangent = false;
    if (!_decompressMissingMetaWarned) {
      _decompressMissingMetaWarned = true;
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        "[WebGPUPrimitiveCommands] compressedAttributes without " +
          "`_compressedAttributesMeta` — falling back to inference. " +
          "Verify geometry source calls GeometryPipeline.compressVertices.",
      );
      //>>includeEnd('debug');
    }
  }

  // The octPack(normal, tangent, bitangent) special case squeezes all
  // three into 2 slots; it only fires when ALL THREE are present.
  const usesOctPack = hasNormal && hasTangent && hasBitangent;

  const outNormal = hasNormal ? new Float32Array(numVertices * 3) : null;
  const outST = hasSt ? new Float32Array(numVertices * 2) : null;
  // DP-H19-TANGENT-DECODE (Batch 27) — also reconstruct tangent /
  // bitangent when they were originally present. No current WebGPU
  // material shader reads these, but having them on the geometry lets
  // any future normal-mapping surface material (DP-H20 + Batch 25 BGL
  // v2 is a ready consumer) light correctly without a second CPU pass.
  // Cost per vertex: +3 floats for each of tangent / bitangent when
  // present — ~24 extra bytes per vertex on fully-tangent-ed geometry.
  const outTangent = hasTangent ? new Float32Array(numVertices * 3) : null;
  const outBitangent = hasBitangent ? new Float32Array(numVertices * 3) : null;

  for (let v = 0; v < numVertices; v++) {
    let slot = v * componentsPerAttribute;
    if (hasSt) {
      const st = AttributeCompression.decompressTextureCoordinates(
        values[slot++],
        scratchDecompressedST,
      );
      outST[v * 2] = st.x;
      outST[v * 2 + 1] = st.y;
    }
    if (usesOctPack) {
      scratchDecompressedPacked.x = values[slot++];
      scratchDecompressedPacked.y = values[slot++];
      AttributeCompression.octUnpack(
        scratchDecompressedPacked,
        scratchDecompressedNormal,
        scratchDecompressedTangent,
        scratchDecompressedBitangent,
      );
      outNormal[v * 3] = scratchDecompressedNormal.x;
      outNormal[v * 3 + 1] = scratchDecompressedNormal.y;
      outNormal[v * 3 + 2] = scratchDecompressedNormal.z;
      // DP-H19-TANGENT-DECODE — octUnpack already decoded tangent +
      // bitangent into the scratch Cartesians; just write them out.
      outTangent[v * 3] = scratchDecompressedTangent.x;
      outTangent[v * 3 + 1] = scratchDecompressedTangent.y;
      outTangent[v * 3 + 2] = scratchDecompressedTangent.z;
      outBitangent[v * 3] = scratchDecompressedBitangent.x;
      outBitangent[v * 3 + 1] = scratchDecompressedBitangent.y;
      outBitangent[v * 3 + 2] = scratchDecompressedBitangent.z;
    } else {
      if (hasNormal) {
        // Some geometry pipelines drop the metadata across worker boundaries
        // and our inference can pick the wrong attribute (st vs normal) for
        // single-component compressed buffers — guard against the resulting
        // out-of-range bytes so a misclassified ST value doesn't take down
        // the entire render loop with `DeveloperError: x and y must be
        // unsigned normalized integers between 0 and 255`. The fallback
        // produces a default up-axis normal which is still better than
        // killing the frame.
        try {
          AttributeCompression.octDecodeFloat(
            values[slot++],
            scratchDecompressedNormal,
          );
          outNormal[v * 3] = scratchDecompressedNormal.x;
          outNormal[v * 3 + 1] = scratchDecompressedNormal.y;
          outNormal[v * 3 + 2] = scratchDecompressedNormal.z;
        } catch {
          outNormal[v * 3] = 0;
          outNormal[v * 3 + 1] = 0;
          outNormal[v * 3 + 2] = 1;
        }
      }
      // DP-H19-TANGENT-DECODE — standalone tangent / bitangent slots
      // are each a single packed float; decode independently.
      if (hasTangent) {
        AttributeCompression.octDecodeFloat(
          values[slot++],
          scratchDecompressedTangent,
        );
        outTangent[v * 3] = scratchDecompressedTangent.x;
        outTangent[v * 3 + 1] = scratchDecompressedTangent.y;
        outTangent[v * 3 + 2] = scratchDecompressedTangent.z;
      }
      if (hasBitangent) {
        AttributeCompression.octDecodeFloat(
          values[slot++],
          scratchDecompressedBitangent,
        );
        outBitangent[v * 3] = scratchDecompressedBitangent.x;
        outBitangent[v * 3 + 1] = scratchDecompressedBitangent.y;
        outBitangent[v * 3 + 2] = scratchDecompressedBitangent.z;
      }
    }
  }

  if (outNormal) {
    geometry.attributes.normal = new GeometryAttribute({
      componentDatatype: ComponentDatatype.FLOAT,
      componentsPerAttribute: 3,
      values: outNormal,
    });
  }
  if (outST) {
    geometry.attributes.st = new GeometryAttribute({
      componentDatatype: ComponentDatatype.FLOAT,
      componentsPerAttribute: 2,
      values: outST,
    });
  }
  if (outTangent) {
    geometry.attributes.tangent = new GeometryAttribute({
      componentDatatype: ComponentDatatype.FLOAT,
      componentsPerAttribute: 3,
      values: outTangent,
    });
  }
  if (outBitangent) {
    geometry.attributes.bitangent = new GeometryAttribute({
      componentDatatype: ComponentDatatype.FLOAT,
      componentsPerAttribute: 3,
      values: outBitangent,
    });
  }
}

// =========================================================================
// Pipeline color-target builder — opaque vs translucent blend state
// =========================================================================

// `makeFragmentTarget` helper removed in Batch 105 (Slice 5c-B Phase 1).
// All call sites now route through `makeSceneFBTargets` from
// `WebGPUSceneFBTargetHelpers.js` so the Phase 2 atomic batch can flip
// the global MRT mode and every scene-FB pipeline picks up the 2nd
// (null) target slot without per-file edits.

// =========================================================================
// Shared Position Extraction — RTE (positionHigh + positionLow)
// =========================================================================

/**
 * Extracts position data from geometry attributes as positionHigh/positionLow
 * pairs for RTE (Relative-To-Eye) rendering. This is CRITICAL for planetary-scale
 * precision — never use single float32 positions for world-space geometry.
 *
 * For geometry with position3DHigh/Low: uses the raw high/low arrays directly.
 * For geometry with only single position: encodes via EncodedCartesian3.
 *
 * @param {object} geometry - Geometry with attributes
 * @returns {null|{posHighValues: Float32Array, posLowValues: Float32Array, numVertices: number}}
 * @private
 */
function extractPositionData(geometry) {
  const posHighAttr = geometry.attributes.position3DHigh;
  const posLowAttr = geometry.attributes.position3DLow;
  const posAttr = geometry.attributes.position;
  const hasHL =
    defined(posHighAttr) &&
    defined(posHighAttr.values) &&
    defined(posLowAttr) &&
    defined(posLowAttr.values);

  if (hasHL) {
    // Direct high/low split from CesiumJS geometry pipeline
    const cpa = posHighAttr.componentsPerAttribute;
    const nv = posHighAttr.values.length / cpa;
    return {
      posHighValues: posHighAttr.values,
      posLowValues: posLowAttr.values,
      numVertices: nv,
    };
  }

  if (defined(posAttr) && defined(posAttr.values)) {
    // Single position — encode each position into high/low via EncodedCartesian3
    const values = posAttr.values;
    const cpa = posAttr.componentsPerAttribute;
    const nv = values.length / cpa;
    const highVals = new Float32Array(nv * 3);
    const lowVals = new Float32Array(nv * 3);
    const scratchCart = new Cartesian3();

    for (let v = 0; v < nv; v++) {
      const off = v * cpa;
      scratchCart.x = values[off];
      scratchCart.y = values[off + 1];
      scratchCart.z = values[off + 2];
      EncodedCartesian3.fromCartesian(scratchCart, scratchEncodedPosition);
      const h = scratchEncodedPosition.high;
      const l = scratchEncodedPosition.low;
      highVals[v * 3] = h.x;
      highVals[v * 3 + 1] = h.y;
      highVals[v * 3 + 2] = h.z;
      lowVals[v * 3] = l.x;
      lowVals[v * 3 + 1] = l.y;
      lowVals[v * 3 + 2] = l.z;
    }
    return {
      posHighValues: highVals,
      posLowValues: lowVals,
      numVertices: nv,
    };
  }

  return null;
}

/**
 * Map a Cesium `PrimitiveType` (GL enum) to a WebGPU primitive topology
 * string. Returns null for `TRIANGLE_FAN` (WebGPU doesn't support it —
 * caller falls back to `triangle-list`, which is wrong but harmless for
 * the rare TRIANGLE_FAN consumer; mainstream Cesium geometry uses
 * triangle-list or line-list).
 *
 * Session 65 Batch 2 (2026-05-11): without this mapping the primitive
 * pipeline factory hardcoded `triangle-list`, so outline geometries
 * (`BoxOutlineGeometry`, `CylinderOutlineGeometry`, every
 * `*OutlineGeometry.primitiveType = PrimitiveType.LINES`) rendered as
 * triangles. The vertex buffer carried line endpoints, the index buffer
 * carried line indices, the rasterizer interpreted them as triangle
 * strips of garbage — visible as missing outlines on every CZML box
 * with `outline: true`, every CZML cylinder, etc. (~12 CZML demos).
 * @private
 */
function mapCesiumPrimitiveTypeToWebGPU(primitiveType) {
  if (!defined(primitiveType)) {
    return "triangle-list"; // default for geometries that don't set it
  }
  switch (primitiveType) {
    case PrimitiveType.POINTS:
      return "point-list";
    case PrimitiveType.LINES:
      return "line-list";
    case PrimitiveType.LINE_STRIP:
    case PrimitiveType.LINE_LOOP:
      // WebGPU has no LINE_LOOP; closest is line-strip. CesiumJS
      // outline geometries don't use LINE_LOOP (they wrap manually via
      // duplicate indices), so this fallback is safe in practice.
      return "line-strip";
    case PrimitiveType.TRIANGLES:
      return "triangle-list";
    case PrimitiveType.TRIANGLE_STRIP:
      return "triangle-strip";
    case PrimitiveType.TRIANGLE_FAN:
      // WebGPU doesn't support triangle-fan. The caller should ideally
      // convert to triangle-list at geometry-extract time; without that
      // we fall back to triangle-list which produces wrong topology but
      // no validation error.
      return "triangle-list";
    default:
      return "triangle-list";
  }
}

/**
 * Helper: creates or reuses an index buffer for a geometry.
 * @private
 */
function ensureIndexBuffer(device, geometry, cache, i) {
  if (!defined(geometry.indices) || defined(cache.indexBuffers[i])) {
    return;
  }
  const indices = geometry.indices;
  cache.indexCounts[i] = indices.length;
  let u32 = false;
  for (let idx = 0; idx < indices.length; idx++) {
    if (indices[idx] > 65535) {
      u32 = true;
      break;
    }
  }
  const data = u32 ? new Uint32Array(indices) : new Uint16Array(indices);
  cache.indexFormats[i] = u32 ? "uint32" : "uint16";
  cache.indexBuffers[i] = WebGPUBuffer.createIndexBuffer(
    device,
    data,
    `IB ${i}`,
  );
}

/**
 * Computes RTE matrices and encoded camera for a given model matrix.
 * Returns { mvpRTE, modelViewRTE, modelView, camHigh, camLow }.
 * @private
 */
function computeRTEMatrices(uniformState, camera, modelMatrix) {
  const modelView = Matrix4.multiply(
    uniformState.view,
    modelMatrix,
    scratchModelViewMatrix,
  );
  Matrix4.clone(modelView, scratchModelViewRTE);
  scratchModelViewRTE[12] = 0.0;
  scratchModelViewRTE[13] = 0.0;
  scratchModelViewRTE[14] = 0.0;
  Matrix4.multiply(uniformState.projection, scratchModelViewRTE, scratchMVPRTE);

  // Encoded camera position in model coordinates
  Matrix4.inverse(modelMatrix, scratchInverseModel);
  Matrix4.multiplyByPoint(
    scratchInverseModel,
    camera.positionWC,
    scratchCameraPositionMC,
  );
  EncodedCartesian3.fromCartesian(
    scratchCameraPositionMC,
    scratchEncodedCamera,
  );

  return {
    mvpRTE: scratchMVPRTE,
    modelViewRTE: scratchModelViewRTE,
    modelView: modelView,
    camHigh: scratchEncodedCamera.high,
    camLow: scratchEncodedCamera.low,
  };
}

/**
 * Per-frame `time` value for shaders that animate (currently just Water).
 * Mirrors upstream GLSL's `czm_frameNumber` semantic so the WGSL port
 * matches the wave phase behavior of the WebGL path. Defaults to 0 when
 * UniformState hasn't been seeded yet (first frame).
 * @private
 */
function getFrameTime(uniformState) {
  if (
    defined(uniformState) &&
    defined(uniformState.frameState) &&
    typeof uniformState.frameState.frameNumber === "number"
  ) {
    return uniformState.frameState.frameNumber;
  }
  return 0.0;
}

/**
 * Writes RTE uniform data for a flat (unlit) shader.
 * Layout: mvpRTE(16) + camHigh(3+1pad) + camLow(3+1pad) + prevVP(16)
 *       + logDepth(4) = 44 floats = 176 bytes (DP-H41 prevVP, Batch 27;
 *       logDepth tail log-depth epic Slice 5 — Mat/PBR/Basic)
 * @private
 */
function writeRTEUniformsFlat(ud, rte, uniformState) {
  Matrix4.pack(rte.mvpRTE, ud, 0);
  ud[16] = rte.camHigh.x;
  ud[17] = rte.camHigh.y;
  ud[18] = rte.camHigh.z;
  ud[19] = 0.0;
  ud[20] = rte.camLow.x;
  ud[21] = rte.camLow.y;
  ud[22] = rte.camLow.z;
  // Float 23 is natural vec3 padding after camLow; Water Flat repurposes
  // it as `time` (frame counter) so its animated wave pattern can advance.
  // Other Flat shaders declare `_pad1: f32` here and ignore the value, so
  // the write is harmless for them.
  ud[23] = getFrameTime(uniformState);
  writePreviousViewProjection(ud, 24, uniformState);
  // Log-depth epic Slice 5 — logDepth tail at floats 40-43 (after prevVP).
  // Inert until the LOG_DEPTH define is set on the flat/basic pipeline.
  writeLogDepthTail(ud, 40, uniformState);
}

/**
 * Writes the renderer-wide log-depth tail (vec4: near, far, factor, reserved)
 * starting at float index `offset`. Mirrors WebGPUGlobeSurfaceCameraUB's tail.
 * Safe to call unconditionally — it only fills previously-unread floats, so it
 * is inert until the LOG_DEPTH pipeline define is set (Slice 4 flip) and the
 * shader's `logDepth` field reads it. See WebGPULogDepth.ts.
 * @private
 */
function writeLogDepthTail(ud, offset, uniformState) {
  const usLog = uniformState;
  const frustum =
    defined(usLog) && defined(usLog.currentFrustum)
      ? usLog.currentFrustum
      : undefined;
  const near = defined(frustum) ? frustum.x : 0.0;
  const far = defined(frustum) ? frustum.y : 0.0;
  let factor =
    defined(usLog) &&
    typeof usLog.oneOverLog2FarDepthFromNearPlusOne === "number"
      ? usLog.oneOverLog2FarDepthFromNearPlusOne
      : 0.0;
  if (!(factor > 0.0) && far > near) {
    const log2Far = Math.log2(far - near + 1.0);
    factor = log2Far > 0.0 ? 1.0 / log2Far : 0.0;
  }
  ud[offset + 0] = near;
  ud[offset + 1] = far;
  ud[offset + 2] = factor;
  ud[offset + 3] = 0.0; // reserved
}

/**
 * Writes RTE uniform data for a lit (Phong/PBR) shader.
 * Layout: mvpRTE(16) + mvRTE(16) + normalMatrix(16) + camHigh(4) + camLow(4)
 *       + lightDir(4) + prevVP(16) + logDepth(4) = 80 floats = 320 bytes
 *       (DP-H41 prevVP, Batch 27; logDepth tail log-depth epic Slice 2b)
 * @private
 */
function writeRTEUniformsLit(ud, rte, uniformState) {
  Matrix4.pack(rte.mvpRTE, ud, 0);
  Matrix4.pack(rte.modelViewRTE, ud, 16);
  const normalMatrix = Matrix4.inverse(rte.modelView, scratchNormalMatrix);
  Matrix4.transpose(normalMatrix, normalMatrix);
  Matrix4.pack(normalMatrix, ud, 32);
  ud[48] = rte.camHigh.x;
  ud[49] = rte.camHigh.y;
  ud[50] = rte.camHigh.z;
  ud[51] = 0.0;
  ud[52] = rte.camLow.x;
  ud[53] = rte.camLow.y;
  ud[54] = rte.camLow.z;
  // Float 55 is vec3 padding after camLow; Water Lit repurposes it as
  // `time` (frame counter) so its waves animate. Other Lit shaders
  // declare `_pad1: f32` here and ignore the value.
  ud[55] = getFrameTime(uniformState);
  if (defined(uniformState) && defined(uniformState.sunDirectionEC)) {
    ud[56] = uniformState.sunDirectionEC.x;
    ud[57] = uniformState.sunDirectionEC.y;
    ud[58] = uniformState.sunDirectionEC.z;
  } else {
    ud[56] = 0.5;
    ud[57] = 0.7;
    ud[58] = 0.5;
  }
  ud[59] = 0.0;
  writePreviousViewProjection(ud, 60, uniformState);
  // Log-depth epic Slice 2b — logDepth tail at floats 76-79 (after prevVP).
  // Inert until the LOG_DEPTH define is set on the lit pipeline.
  writeLogDepthTail(ud, 76, uniformState);
}

/**
 * DP-H41 (Batch 27) — writes 16 floats of `uniformState.previousViewProjection`
 * starting at `offset`. Falls back to identity on the first frame before
 * `UniformState.update()` has seeded the slot.
 * @private
 */
function writePreviousViewProjection(ud, offset, uniformState) {
  const prevVP = defined(uniformState)
    ? uniformState.previousViewProjection
    : undefined;
  if (defined(prevVP)) {
    Matrix4.pack(prevVP, ud, offset);
    return;
  }
  // Column-major identity
  ud[offset + 0] = 1;
  ud[offset + 1] = 0;
  ud[offset + 2] = 0;
  ud[offset + 3] = 0;
  ud[offset + 4] = 0;
  ud[offset + 5] = 1;
  ud[offset + 6] = 0;
  ud[offset + 7] = 0;
  ud[offset + 8] = 0;
  ud[offset + 9] = 0;
  ud[offset + 10] = 1;
  ud[offset + 11] = 0;
  ud[offset + 12] = 0;
  ud[offset + 13] = 0;
  ud[offset + 14] = 0;
  ud[offset + 15] = 1;
}

// writeRTEUniformsPick removed — pick shaders now use split camera/material
// bind groups. Camera data uses writeRTEUniformsFlat; pick color goes in
// a separate material UBO.

/**
 * NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU (COLOR slice) — writes the camera
 * UB for the polyline appearance shader. The polyline VS does its width
 * expansion in screen space, so it needs the full projection /
 * viewportTransformation / viewportOrthographic / modelViewRTE chain plus
 * pixelRatio + frustum-near, on top of the flat-parity head.
 *
 * Layout (float offsets — byte-locked to CameraUniforms in
 * PolylineColorAppearance.wgsl):
 *   0-15  mvpRelativeToEye        (parity)
 *   16-19 encodedCameraHigh + pad (parity)
 *   20-23 encodedCameraLow  + pad (parity)
 *   24-39 projection
 *   40-55 viewportTransformation
 *   56-71 viewportOrthographic
 *   72-87 modelViewRelativeToEye
 *   88    pixelRatio
 *   89    currentFrustumNear
 *   90-91 pad
 *
 * MUST be called after `Matrix4.setDepthRangeType("webgpu")` so the
 * viewportOrthographic we build here uses the WebGPU-correct z mapping
 * (computeOrthographicOffCenter's webgpu branch). The projection getter
 * likewise reflects the active depth-range type.
 *
 * MISSING-FUNCTIONALITY NOTE (Principle 9): `uniformState.viewport` is only
 * ever set by the WebGL `RenderState.applyViewport` path (it calls
 * `gl.viewport`). The WebGPU render path never seeds it, so
 * `uniformState.viewportOrthographic` / `.viewportTransformation` stay at
 * IDENTITY on WebGPU — which collapsed every polyline-appearance vertex to
 * one clip point (the original 0px symptom, take two). We therefore build
 * both screen-space matrices from `context.drawingBufferWidth/Height` here,
 * matching the established WebGPU collection-renderer pattern (Billboard /
 * BufferPolyline read `context.drawingBufferWidth` directly rather than the
 * GL-only `uniformState.viewport`). Seeding `uniformState.viewport` in the
 * WebGPU render pass setup is the broader fix that would let the getters
 * work for all future screen-space WebGPU shaders — tracked as follow-up.
 * @private
 */
const scratchPolylineViewport = new BoundingRectangle();
const scratchViewportTransform = new Matrix4();
const scratchViewportOrtho = new Matrix4();
function writeRTEUniformsPolyline(ud, rte, uniformState, context) {
  // Parity head — mirrors writeRTEUniformsFlat's first 24 floats so the
  // shared RTE conventions stay aligned across shader families.
  Matrix4.pack(rte.mvpRTE, ud, 0);
  ud[16] = rte.camHigh.x;
  ud[17] = rte.camHigh.y;
  ud[18] = rte.camHigh.z;
  ud[19] = 0.0;
  ud[20] = rte.camLow.x;
  ud[21] = rte.camLow.y;
  ud[22] = rte.camLow.z;
  ud[23] = 0.0;

  // Drawing-buffer dimensions for the WebGPU-correct viewport transforms.
  const width =
    (defined(context) ? context.drawingBufferWidth : 0) ||
    (defined(uniformState) && defined(uniformState.viewport)
      ? uniformState.viewport.width
      : 0) ||
    1;
  const height =
    (defined(context) ? context.drawingBufferHeight : 0) ||
    (defined(uniformState) && defined(uniformState.viewport)
      ? uniformState.viewport.height
      : 0) ||
    1;
  scratchPolylineViewport.x = 0;
  scratchPolylineViewport.y = 0;
  scratchPolylineViewport.width = width;
  scratchPolylineViewport.height = height;

  // viewportTransformation: NDC -> window (pixel) coords. Depth-range
  // agnostic (always near=0,far=1). Mirrors UniformState.cleanViewport.
  Matrix4.computeViewportTransformation(
    scratchPolylineViewport,
    0.0,
    1.0,
    scratchViewportTransform,
  );
  // viewportOrthographic: window (pixel) coords -> clip. WebGPU z mapping
  // when Matrix4._depthRangeType === "webgpu" (set by the caller).
  Matrix4.computeOrthographicOffCenter(
    0.0,
    width,
    0.0,
    height,
    0.0,
    1.0,
    scratchViewportOrtho,
  );

  // Screen-space expansion matrices.
  Matrix4.pack(uniformState.projection, ud, 24);
  Matrix4.pack(scratchViewportTransform, ud, 40);
  Matrix4.pack(scratchViewportOrtho, ud, 56);
  Matrix4.pack(rte.modelViewRTE, ud, 72);

  const pixelRatio =
    defined(uniformState) && typeof uniformState.pixelRatio === "number"
      ? uniformState.pixelRatio
      : defined(uniformState.frameState) &&
          typeof uniformState.frameState.pixelRatio === "number"
        ? uniformState.frameState.pixelRatio
        : 1.0;
  const frustum =
    defined(uniformState) && defined(uniformState.currentFrustum)
      ? uniformState.currentFrustum
      : undefined;
  ud[88] = pixelRatio;
  ud[89] = defined(frustum) ? frustum.x : 0.0;
  ud[90] = 0.0;
  ud[91] = 0.0;
  // 376c — log-depth tail (near, far, factor, reserved) at floats 92-95.
  // Inert until the LOG_DEPTH pipeline define is set on the appearance /
  // material polyline pipelines; the shader reads `camera.logDepth` only
  // inside //>>ifdef LOG_DEPTH. 512B UB has room (96 floats = 384 bytes).
  writeLogDepthTail(ud, 92, uniformState);

  // 376b — morphTime (vec4 morph, .x) at float 96. 3D=1.0, 2D/CV=0.0,
  // 0..1 while morphing. The VS blends position3D↔position2D by this. Default
  // 1.0 (3D) so a missing frameState is the safe 3D path.
  const fsMorph = defined(uniformState) ? uniformState.frameState : undefined;
  ud[96] =
    defined(fsMorph) && typeof fsMorph.morphTime === "number"
      ? fsMorph.morphTime
      : 1.0;
  ud[97] = 0.0;
  ud[98] = 0.0;
  ud[99] = 0.0;
}

// =========================================================================
// Per-Frame Primitive Effects Bind Group (Slice 2d)
// =========================================================================
//
// Primitive commands are built once and reused frame-to-frame. Before
// Slice 2d they always bound the shared `getPlaceholderEffects` BG for
// the effects slot — which zeroes `effects.csmControl.x` — so shadow
// receive (single-map AND CSM) was effectively dead on the primitive
// path. The globe terrain path builds a fresh effects BG per frame via
// `createEffectsBindGroup`; primitives lagged.
//
// Fix: cache one shared effects BG per frame on the context, rebuild
// when shadowState / csmRenderer toggles or a new frameNumber ticks,
// and swap it into `command.bindGroups[last]` from the update hook.
// Identity modelMatrix is assumed for primitives (true for all current
// appearance primitives), so one shared BG covers every command.
//
// Clipping planes on primitives are a separate gap — the primitive
// pipeline doesn't currently thread a ClippingPlaneCollection reference
// through to the effects BG. Tracked as follow-up; this helper leaves
// the clipping slots on the placeholder so clipping stays no-op.

function _getOrCreateSharedPrimitiveEffectsBG(frameState) {
  const context = frameState?.context;
  const device = context?.device;
  if (!defined(device)) {
    return null;
  }

  const shadowState = frameState.shadowState;
  const receiveShadowMap =
    shadowState?.lightShadowsEnabled && shadowState?.lightShadowMaps?.[0]
      ? shadowState.lightShadowMaps[0]
      : undefined;

  const csmCandidate = context.csmRenderer;
  const hasCsm =
    defined(csmCandidate) &&
    csmCandidate.enabled === true &&
    defined(csmCandidate.cascadeParamsBuffer) &&
    defined(csmCandidate.cascadeArrayView);
  const csmBinding = hasCsm
    ? {
        enabled: true,
        paramsBuffer: csmCandidate.cascadeParamsBuffer,
        cascadeArrayView: csmCandidate.cascadeArrayView,
        // NEW-CSM-SOFT-SHADOW-PCF — soft-shadow kernel radius (texels).
        pcfRadius: csmCandidate.pcfRadius,
      }
    : undefined;

  // Batch 96 (FEAT-GAP-09 fix) — read the aerial-perspective LUT views
  // from the performance manager and forward them into the primitive
  // effects bind group. Without this, every primitive shader that
  // declared the aerial-LUT bindings (PrimitiveBasicColor + all
  // Mat*Lit / Phong* variants — see SHADER_PAIRS_LOCKSTEP.md) sampled
  // 1×1 placeholder textures every frame and `effects.atmosphereLutControl.x`
  // stayed at 0.0, so the fog block was dead code on non-globe geometry.
  // The globe path forwards these views from `WebGPUGlobeSurfaceRenderer.ts`
  // (~L1015); this mirrors that wiring for primitives.
  const perfMgr = context.performanceManager;
  let atmosphereLutViews = null;
  if (perfMgr && typeof perfMgr.ensureAtmosphereLUTResources === "function") {
    const res = perfMgr.ensureAtmosphereLUTResources(device);
    if (res && res.transmittanceView && res.inscatterView) {
      atmosphereLutViews = {
        transmittance: res.transmittanceView,
        inscatter: res.inscatterView,
      };
    }
  }
  const hasAtmosphereLut = atmosphereLutViews !== null;

  const frameNumber = frameState.frameNumber;
  const hasShadow = defined(receiveShadowMap);

  // Slice 5d Batch 154 — Forward+ clustered lighting. The SceneRenderer's
  // _dispatchClusteredLighting hook stashes the dispatcher's buffers +
  // a CPU-side "active this frame" flag on the context each frame. When
  // active, the Mat*Lit fragment shaders read the cluster bindings on the
  // (shared) effects bind group at @group(2|3) bindings 18-22, so we must
  // build the ACTIVE effects bind group (not the cheap placeholder) and
  // bind the dispatcher's real buffers. When inactive (toggle off OR zero
  // lights) the placeholder fast path is preserved.
  const clusteredBuffers = context._clusteredLightingBuffers;
  const hasClustered =
    context._clusteredLightingActive === true && defined(clusteredBuffers);

  // Invalidate cache when frame ticks OR when the (shadow, csm, LUT,
  // clustered) toggles. We hash all four into a small int so a cheap
  // compare catches on/off changes within the same frame (rare —
  // frameState normally increments frameNumber every tick — but the
  // guard is nearly free).
  const toggleHash =
    (hasShadow ? 1 : 0) |
    (hasCsm ? 2 : 0) |
    (hasAtmosphereLut ? 4 : 0) |
    (hasClustered ? 8 : 0);
  if (
    context._primitiveEffectsBGFrameNumber === frameNumber &&
    context._primitiveEffectsBGToggleHash === toggleHash &&
    defined(context._primitiveEffectsBG)
  ) {
    return context._primitiveEffectsBG;
  }

  // When none of (shadow, csm, atmosphereLut, clustered) is active we MUST
  // return the placeholder explicitly (not null) so callers swap stale
  // active-state BGs back to zero-filled placeholder data on toggle-off
  // transitions. Example: CSM toggled ON at frame N plants a real BG in
  // cmd.bindGroups[last]; CSM toggled OFF at frame N+1 must overwrite
  // that slot — otherwise the shader reads last frame's csmControl=1.0
  // and samples stale cascade VPs. Same logic for the LUT + clustered control.
  if (!hasShadow && !hasCsm && !hasAtmosphereLut && !hasClustered) {
    const placeholder = getPlaceholderEffects(device);
    context._primitiveEffectsBG = placeholder.bindGroup;
    context._primitiveEffectsBGFrameNumber = frameNumber;
    context._primitiveEffectsBGToggleHash = toggleHash;
    return placeholder.bindGroup;
  }

  const fxRes = createEffectsBindGroup(device, frameState, {
    shadowMap: receiveShadowMap,
    csm: csmBinding,
    // Primitives have identity modelMatrix, so world camera == plane-space
    // camera. Clipping wiring for primitives is a separate follow-up.
    cameraInPlaneSpace: context.uniformState?.cameraPosition,
    atmosphereLutTransmittanceView: atmosphereLutViews?.transmittance,
    atmosphereLutInscatterView: atmosphereLutViews?.inscatter,
    // Use the SkyAtmosphere convention — WGS84 inner radius + 2.5%
    // atmosphere thickness — matching the default the LUT compute
    // dispatcher uses unless `SkyAtmosphere.atmosphereLightIntensity`
    // has been customized. Mirrors the globe-renderer wiring at
    // `WebGPUGlobeSurfaceRenderer.ts:1022-1025`.
    atmosphereLutPlanetRadii: hasAtmosphereLut
      ? { inner: 6378137.0, outer: 6378137.0 * 1.025 }
      : undefined,
    // Slice 5d Batch 154 — Forward+ clustered lighting buffers (bindings
    // 18-22 on the effects BGL). Passed only when active so the no-effects
    // placeholder fast path is preserved when clustered lighting is off.
    clusteredLighting: hasClustered ? clusteredBuffers : undefined,
  });
  context._primitiveEffectsBG = fxRes.bindGroup;
  context._primitiveEffectsBGFrameNumber = frameNumber;
  context._primitiveEffectsBGToggleHash = toggleHash;
  return fxRes.bindGroup;
}

function _refreshPrimitiveEffectsSlot(command, frameState) {
  if (!command.isWebGPUDrawCommand) {
    return;
  }
  const bgArray = command.bindGroups;
  if (!defined(bgArray) || bgArray.length === 0) {
    return;
  }
  // Pick commands don't receive shadows — skip to avoid needless BG churn
  // and to leave their placeholder layout untouched.
  if (command._isPickCommand === true) {
    return;
  }
  // 376d — the textured polyline Image variant has its TEXTURE at the last bind
  // group slot (no effects group on that pipeline). Swapping the shared effects
  // BG into the last slot would clobber the texture → blank line. Skip it.
  if (command._noEffectsSlot === true) {
    return;
  }
  const activeBG = _getOrCreateSharedPrimitiveEffectsBG(frameState);
  if (!defined(activeBG)) {
    // Keep whatever the command was built with (the shared placeholder).
    return;
  }
  const idx = bgArray.length - 1;
  if (bgArray[idx] !== activeBG) {
    bgArray[idx] = activeBG;
  }
}

// =========================================================================
// Per-Frame Uniform Update
// =========================================================================

/**
 * Updates the GPU uniform buffer for a WebGPU draw command with current camera matrices.
 * Called every frame from updateAndQueueCommands() to keep the MVP matrix
 * in sync with the camera as it moves.
 *
 * @param {WebGPUDrawCommand} command - The WebGPU draw command to update
 * @param {FrameState} frameState - Current frame state (contains context, uniformState)
 * @param {Matrix4} modelMatrix - The primitive's model-to-world matrix
 * @private
 */
function updateWebGPUCommandUniforms(command, frameState, modelMatrix) {
  if (!command.isWebGPUDrawCommand || !command._webgpuCameraBuffer) {
    return;
  }

  const context = frameState.context;
  const device = context.device;
  if (!device) {
    return;
  }

  // NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU — the polyline appearance camera
  // UB carries projection / viewport / modelViewRTE which all change per frame
  // as the camera moves, so it MUST be re-written every frame (not just on
  // geometry change). Depth-range type is set to webgpu by the command
  // builders; the viewportOrthographic getter respects it. Shared by both the
  // COLOR slice (polylineColor) and the MATERIAL slice (polylineMat*), which
  // use the identical camera UB layout — gated on `_isPolylineAppearance` so
  // the polyline material types don't fall through to the generic flat/lit
  // camera writers below (their UB layout differs).
  if (command._isPolylineAppearance === true) {
    Matrix4.setDepthRangeType("webgpu");
    const rtePoly = computeRTEMatrices(
      context.uniformState,
      frameState.camera,
      modelMatrix,
    );
    const udPoly = scratchPolylineUniformData;
    writeRTEUniformsPolyline(udPoly, rtePoly, context.uniformState, context);
    device.queue.writeBuffer(
      command._webgpuCameraBuffer,
      0,
      udPoly.buffer,
      0,
      POLYLINE_CAMERA_BYTES,
    );

    // MATERIAL slice — re-upload the material UBO when the Material's
    // `_uniformBuffer` is dirty (time-varying dash pattern / glow phase).
    // COLOR-slice commands have no `_webgpuMaterialUB`, so this is a no-op
    // there.
    const matUB = command._webgpuMaterialUB;
    const matBuffer = command._webgpuMaterialBuffer;
    if (defined(matUB) && defined(matBuffer) && matUB.isDirty) {
      const matData = matUB.gpuData;
      if (defined(matData)) {
        device.queue.writeBuffer(matBuffer, 0, matData);
      }
      matUB.clearDirty();
    }

    // 376d — refresh the textured Image variant's texture bind group. The
    // command is built once (usually before the async Image material decodes),
    // so ensureMaterialTextureBindGroup must re-run until the real image is
    // bound. It keys on `_imageSources.image` identity (undefined → image when
    // loaded), so it rebuilds exactly once on decode, then early-returns.
    if (command._noEffectsSlot === true && defined(command._webgpuMatCache)) {
      ensureMaterialTextureBindGroup(
        context,
        device,
        command._webgpuMaterial,
        command._webgpuMatShaderType,
        command._webgpuMatCache,
      );
      const texBG = command._webgpuMatCache.textureBindGroup;
      if (defined(texBG) && command.bindGroups[2] !== texBG) {
        command.bindGroups[2] = texBG;
      }
    }

    _refreshPrimitiveEffectsSlot(command, frameState);
    return;
  }

  const rte = computeRTEMatrices(
    context.uniformState,
    frameState.camera,
    modelMatrix,
  );
  const ud = scratchRTEUniformData;

  if (isPhongShader(command._webgpuShaderType)) {
    writeRTEUniformsLit(ud, rte, context.uniformState);
    device.queue.writeBuffer(
      command._webgpuCameraBuffer,
      0,
      ud.buffer,
      0,
      LIT_CAMERA_BYTES,
    );
  } else {
    writeRTEUniformsFlat(ud, rte, context.uniformState);
    device.queue.writeBuffer(
      command._webgpuCameraBuffer,
      0,
      ud.buffer,
      0,
      FLAT_CAMERA_BYTES,
    );
  }

  // Slice 2d — swap the effects bind group for this frame so shadow-
  // receive / CSM bindings reach the primitive shader instead of the
  // zero-filled placeholder the command was built with.
  _refreshPrimitiveEffectsSlot(command, frameState);
}

// =========================================================================
// Pick Uniform Update (per frame)
// =========================================================================

// DP-H41 (Batch 27) — pick buffer now carries previousViewProjection too
// (40 floats = 160 bytes). Scratch kept at 64 floats for zero-risk headroom.
const scratchPickUniformData = new Float32Array(64);

/**
 * Updates the GPU uniform buffer for a WebGPU pick command with current camera matrices.
 * @private
 */
function updateWebGPUPickCommandUniforms(command, frameState, modelMatrix) {
  if (
    !command.isWebGPUDrawCommand ||
    !command._webgpuCameraBuffer ||
    !command._isPickCommand
  ) {
    return;
  }

  const context = frameState.context;
  const device = context.device;
  if (!device) {
    return;
  }

  const rte = computeRTEMatrices(
    context.uniformState,
    frameState.camera,
    modelMatrix,
  );

  // Write camera uniforms (flat layout for pick shaders)
  const ud = scratchPickUniformData;
  writeRTEUniformsFlat(ud, rte, context.uniformState);
  device.queue.writeBuffer(
    command._webgpuCameraBuffer,
    0,
    ud.buffer,
    0,
    PICK_CAMERA_BYTES,
  );

  // Pick color is in the material buffer — only update if color changed
  // (pick colors are assigned once and don't change per frame)
}

// =========================================================================
// NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU (COLOR slice)
// =========================================================================

/**
 * Reads a per-vertex color attribute into RGBA floats in [0,1]. Handles the
 * UNSIGNED_BYTE + normalize:true layout PolylineGeometry emits (values 0-255)
 * as well as already-float color attributes (values 0-1).
 * @private
 */
function readPolylineColor(colorAttr, v, out) {
  if (!defined(colorAttr) || !defined(colorAttr.values)) {
    out[0] = 1.0;
    out[1] = 1.0;
    out[2] = 1.0;
    out[3] = 1.0;
    return;
  }
  const values = colorAttr.values;
  const cpa = colorAttr.componentsPerAttribute || 4;
  const off = v * cpa;
  // UNSIGNED_BYTE normalize:true -> divide by 255. A FLOAT color is already
  // in [0,1]; the `normalize` flag distinguishes them.
  const scale = colorAttr.normalize === true ? 1.0 / 255.0 : 1.0;
  out[0] = values[off] * scale;
  out[1] = values[off + 1] * scale;
  out[2] = values[off + 2] * scale;
  out[3] = cpa >= 4 ? values[off + 3] * scale : 1.0;
}

const scratchPolylineColor = [1.0, 1.0, 1.0, 1.0];

/**
 * Builds (and caches) the polyline appearance render pipeline. Topology is
 * triangle-list (the geometry's index buffer triangulates the ribbon),
 * cullMode "none" (a ribbon has no meaningful back face), MSAA matches the
 * scene FB, targets via makeSceneFBTargets (no G-buffer emit — flat color).
 * @private
 */
function createPolylineAppearancePipeline(
  device,
  context,
  cache,
  shaderModule,
  vertexLayout,
  translucent,
) {
  const cameraBGL = makeBindGroupLayout(device, "Polyline Camera BGL", [
    uniformBuffer(0, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),
  ]);
  const materialBGL = makeBindGroupLayout(device, "Polyline Material BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
  ]);
  const effectsBGL = getEffectsBindGroupLayout(device);
  cache.cameraBindGroupLayout = cameraBGL;
  cache.materialBindGroupLayout = materialBGL;
  cache.effectsBGL = effectsBGL;

  const canvasFormat =
    context.scenePipelineFormat || navigator.gpu.getPreferredCanvasFormat();

  return device.createRenderPipeline({
    label: "Polyline appearance pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [cameraBGL, materialBGL, effectsBGL],
    }),
    vertex: {
      module: shaderModule.module,
      entryPoint: "vertexMain",
      buffers: [vertexLayout.layout],
    },
    fragment: {
      module: shaderModule.module,
      entryPoint: "fragmentMain",
      targets: makeSceneFBTargets(canvasFormat, {
        translucent,
        emitsGBuffer: false,
      }),
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "none",
      frontFace: "ccw",
    },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: !translucent,
      depthCompare: "less-equal",
    },
    multisample:
      (context._msaaSamples ?? 1) > 1
        ? { count: context._msaaSamples }
        : undefined,
  });
}

/**
 * Creates WebGPU draw commands for a polyline `Primitive` with
 * `PolylineColorAppearance` (NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU, COLOR
 * slice). Packs 24 floats/vertex (posHigh/posLow + prev/next high/low +
 * expandAndWidth + color) and routes through the polyline appearance shader
 * which expands the coincident quad vertices into a screen-space ribbon.
 *
 * Pick is not wired in this slice (color-only) — pickCommands is cleared.
 * @private
 */
function createPolylineAppearanceCommands(
  primitive,
  appearance,
  translucent,
  colorCommands,
  pickCommands,
  frameState,
  geometries,
) {
  const context = frameState.context;
  const device = context.device;

  if (!defined(primitive._webgpuPolylineCache)) {
    primitive._webgpuPolylineCache = {
      shaderModule: null,
      pipeline: null,
      translucent: null,
      cameraBindGroupLayout: null,
      materialBindGroupLayout: null,
      effectsBGL: null,
      materialBuffer: null,
      materialBindGroup: null,
      cameraBuffers: [],
      cameraBindGroups: [],
      vertexBuffers: [],
      indexBuffers: [],
      indexFormats: [],
      indexCounts: [],
      vertexCounts: [],
    };
  }
  const cache = primitive._webgpuPolylineCache;

  const vertexLayout = getPolylineAppearanceVertexLayout();
  const translucentChanged = cache.translucent !== translucent;
  // 376c — renderer-wide log depth. Flip the LOG_DEPTH define on the
  // appearance pipeline when the master switch + per-frame flag are on, so
  // the polyline writes hyperbolic @builtin(frag_depth) and z-fights terrain
  // correctly. Defaults FALSE → defines=0 → byte-identical historical path.
  // `logDepthChanged` forces a shader-module + pipeline rebuild on toggle.
  const logDepthActive = isWebGPULogDepthActive(context, frameState);
  const logDepthChanged = cache.logDepthEnabled !== logDepthActive;

  if (!defined(cache.pipeline) || translucentChanged || logDepthChanged) {
    cache.translucent = translucent;
    cache.logDepthEnabled = logDepthActive;

    // Route through the preprocessor so the chunk-injected source is resolved
    // via getShaderSource (prepends csm_polylineCommon) and the //>>ifdef
    // LOG_DEPTH blocks resolve. defines=0 reproduces the pre-376c path.
    const code = preprocessShaderSource(
      getShaderSource("polylineColor"),
      logDepthActive ? ShaderDefine.LOG_DEPTH : 0,
    );
    cache.shaderModule = WebGPUShaderModule.create({
      device: device,
      code: code,
      label: "PolylineColorAppearance Shader",
    });

    cache.pipeline = createPolylineAppearancePipeline(
      device,
      context,
      cache,
      cache.shaderModule,
      vertexLayout,
      translucent,
    );

    // Placeholder material UB (the polyline FS reads no material uniforms).
    cache.materialBuffer = device.createBuffer({
      size: PLACEHOLDER_MATERIAL_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Polyline Placeholder Material UB",
    });
    device.queue.writeBuffer(
      cache.materialBuffer,
      0,
      new Float32Array([0, 0, 0, 0]),
    );
    cache.materialBindGroup = device.createBindGroup({
      layout: cache.materialBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cache.materialBuffer } }],
    });
  }

  // Depth-range type MUST be webgpu before the viewportOrthographic /
  // projection getters are read so they produce z in [0,1] (see
  // writeRTEUniformsPolyline + the depth-range note in csm_polylineCommon.wgsl).
  Matrix4.setDepthRangeType("webgpu");
  const rte = computeRTEMatrices(
    context.uniformState,
    frameState.camera,
    primitive.modelMatrix,
  );

  const validCommands = [];
  const pass = translucent ? Pass.TRANSLUCENT : Pass.OPAQUE;
  const appearanceRS = appearance?.renderState;
  const effectsPlaceholder = getPlaceholderEffects(device);

  // Per-instance color for PolylineColorAppearance lives in the batch table
  // (keyed by colorIndex), not on a per-vertex `color` geometry attribute —
  // PolylineGeometry only emits a `color` attribute when constructed with
  // explicit `colors`. Resolve the same way the basic packer does, then fall
  // back to the geometry `color` attribute, then white.
  const batchTable = primitive._batchTable;
  const colorIndex = primitive._batchTableAttributeIndices?.color;
  const hasInstanceColors = defined(batchTable) && defined(colorIndex);

  for (let i = 0; i < geometries.length; i++) {
    const geometry = geometries[i];
    const attrs = geometry.attributes;

    const posHigh = attrs.position3DHigh;
    const posLow = attrs.position3DLow;
    const prevHigh = attrs.prevPosition3DHigh;
    const prevLow = attrs.prevPosition3DLow;
    const nextHigh = attrs.nextPosition3DHigh;
    const nextLow = attrs.nextPosition3DLow;
    const expandAndWidth = attrs.expandAndWidth;
    if (
      !defined(posHigh) ||
      !defined(posHigh.values) ||
      !defined(prevHigh) ||
      !defined(nextHigh) ||
      !defined(expandAndWidth)
    ) {
      continue;
    }

    const posHighVals = posHigh.values;
    const posLowVals = posLow.values;
    const prevHighVals = prevHigh.values;
    const prevLowVals = prevLow.values;
    const nextHighVals = nextHigh.values;
    const nextLowVals = nextLow.values;
    const ewVals = expandAndWidth.values;
    const ewCPA = expandAndWidth.componentsPerAttribute || 2;
    const colorAttr = attrs.color;

    // 376b — projected 2D positions for the morph blend. Absent in scene3DOnly
    // viewers → zero-fill; morphTime stays 1.0 so the VS uses the 3D path.
    const p2dH = attrs.position2DHigh;
    const p2dL = attrs.position2DLow;
    const pv2dH = attrs.prevPosition2DHigh;
    const pv2dL = attrs.prevPosition2DLow;
    const nx2dH = attrs.nextPosition2DHigh;
    const nx2dL = attrs.nextPosition2DLow;
    const has2D =
      defined(p2dH) && defined(p2dH.values) && defined(pv2dH) && defined(nx2dH);

    // Resolve the per-instance color (whole-geometry) from the batch table.
    // `null` => use the per-vertex `color` attribute (or white) instead.
    let instanceColor = null;
    if (hasInstanceColors && i < primitive._numberOfInstances) {
      try {
        const batchColor = batchTable.getBatchedAttribute(i, colorIndex);
        if (defined(batchColor)) {
          if (defined(batchColor.red)) {
            instanceColor = [
              batchColor.red,
              batchColor.green,
              batchColor.blue,
              batchColor.alpha,
            ];
          } else if (defined(batchColor.x)) {
            const r = batchColor.x;
            const g = batchColor.y;
            const b = batchColor.z;
            const a = batchColor.w;
            instanceColor =
              r > 1.0 || g > 1.0 || b > 1.0 || a > 1.0
                ? [r / 255.0, g / 255.0, b / 255.0, a / 255.0]
                : [r, g, b, a];
          }
        }
      } catch (e) {
        // Silently fall through to the per-vertex color attribute.
      }
    }

    const numVertices =
      posHighVals.length / (posHigh.componentsPerAttribute || 3);

    // 24 floats/vertex: posHigh(3) posLow(3) prevHigh(3) prevLow(3)
    // nextHigh(3) nextLow(3) expandAndWidth(2) color(4)
    const fpv = vertexLayout.floatsPerVertex;
    const vertexData = new Float32Array(numVertices * fpv);
    for (let v = 0; v < numVertices; v++) {
      const p3 = v * 3;
      const vOff = v * fpv;
      vertexData[vOff] = posHighVals[p3];
      vertexData[vOff + 1] = posHighVals[p3 + 1];
      vertexData[vOff + 2] = posHighVals[p3 + 2];
      vertexData[vOff + 3] = posLowVals[p3];
      vertexData[vOff + 4] = posLowVals[p3 + 1];
      vertexData[vOff + 5] = posLowVals[p3 + 2];
      vertexData[vOff + 6] = prevHighVals[p3];
      vertexData[vOff + 7] = prevHighVals[p3 + 1];
      vertexData[vOff + 8] = prevHighVals[p3 + 2];
      vertexData[vOff + 9] = prevLowVals[p3];
      vertexData[vOff + 10] = prevLowVals[p3 + 1];
      vertexData[vOff + 11] = prevLowVals[p3 + 2];
      vertexData[vOff + 12] = nextHighVals[p3];
      vertexData[vOff + 13] = nextHighVals[p3 + 1];
      vertexData[vOff + 14] = nextHighVals[p3 + 2];
      vertexData[vOff + 15] = nextLowVals[p3];
      vertexData[vOff + 16] = nextLowVals[p3 + 1];
      vertexData[vOff + 17] = nextLowVals[p3 + 2];
      const ewOff = v * ewCPA;
      vertexData[vOff + 18] = ewVals[ewOff];
      vertexData[vOff + 19] = ewVals[ewOff + 1];
      if (instanceColor !== null) {
        vertexData[vOff + 20] = instanceColor[0];
        vertexData[vOff + 21] = instanceColor[1];
        vertexData[vOff + 22] = instanceColor[2];
        vertexData[vOff + 23] = instanceColor[3];
      } else {
        readPolylineColor(colorAttr, v, scratchPolylineColor);
        vertexData[vOff + 20] = scratchPolylineColor[0];
        vertexData[vOff + 21] = scratchPolylineColor[1];
        vertexData[vOff + 22] = scratchPolylineColor[2];
        vertexData[vOff + 23] = scratchPolylineColor[3];
      }
      // 376b — 2D positions @ floats 24-41 (loc8-13). Zero when absent.
      if (has2D) {
        for (let c = 0; c < 3; c++) {
          vertexData[vOff + 24 + c] = p2dH.values[p3 + c];
          vertexData[vOff + 27 + c] = p2dL.values[p3 + c];
          vertexData[vOff + 30 + c] = pv2dH.values[p3 + c];
          vertexData[vOff + 33 + c] = pv2dL.values[p3 + c];
          vertexData[vOff + 36 + c] = nx2dH.values[p3 + c];
          vertexData[vOff + 39 + c] = nx2dL.values[p3 + c];
        }
      }
    }

    if (defined(cache.vertexBuffers[i])) {
      cache.vertexBuffers[i].destroy();
    }
    cache.vertexBuffers[i] = WebGPUBuffer.createVertexBuffer(
      device,
      vertexData,
      `Polyline VB ${i}`,
    );

    ensureIndexBuffer(device, geometry, cache, i);
    cache.vertexCounts[i] = numVertices;

    if (!defined(cache.cameraBuffers[i])) {
      cache.cameraBuffers[i] = device.createBuffer({
        size: POLYLINE_CAMERA_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: `Polyline Camera UB ${i}`,
      });
    }
    const cameraData = scratchPolylineUniformData;
    writeRTEUniformsPolyline(cameraData, rte, context.uniformState, context);
    device.queue.writeBuffer(
      cache.cameraBuffers[i],
      0,
      cameraData.buffer,
      0,
      POLYLINE_CAMERA_BYTES,
    );

    cache.cameraBindGroups[i] = device.createBindGroup({
      layout: cache.cameraBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cache.cameraBuffers[i] } }],
    });

    const commandBindGroups = [
      cache.cameraBindGroups[i],
      cache.materialBindGroup,
      effectsPlaceholder.bindGroup,
    ];

    const cmd = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: commandBindGroups,
      vertexBuffer: cache.vertexBuffers[i],
      indexBuffer: cache.indexBuffers[i],
      indexFormat: cache.indexFormats[i],
      vertexCount: defined(cache.indexBuffers[i])
        ? undefined
        : cache.vertexCounts[i],
      indexCount: defined(cache.indexBuffers[i])
        ? cache.indexCounts[i]
        : undefined,
      pass: pass,
      owner: primitive,
      renderState: appearanceRS,
    });
    cmd._webgpuCameraBuffer = cache.cameraBuffers[i];
    cmd._webgpuShaderType = "polylineColor";
    cmd._isPolylineAppearance = true;
    cmd._label = "polyline appearance";
    cmd.vertexStride = vertexLayout.stride;
    validCommands.push(cmd);
  }

  colorCommands.length = validCommands.length;
  for (let i = 0; i < validCommands.length; i++) {
    colorCommands[i] = validCommands[i];
  }
  // Pick is color-only in this slice.
  pickCommands.length = 0;
}

// =========================================================================
// NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU (MATERIAL slice)
// =========================================================================

const scratchPolylineST = new Cartesian2();

/**
 * Reconstruct the `st` attribute for a polyline-material geometry whose
 * `Primitive` ran GeometryPipeline.compressVertices() and packed `st` into
 * `compressedAttributes`.
 *
 * The generic `ensureUncompressedAttributes` decoder CANNOT be used here: it
 * infers attribute identity from `compressedAttributes` magnitudes, and a
 * polyline's first vertex has st == (0,0) which packs to 0 — failing the
 * "> 65535 ⇒ ST" sniff, so it mis-decodes the ST slot as a `normal` and never
 * produces `st` (Glow/Arrow/Outline then read st == (0,0) and collapse).
 *
 * PolylineMaterialAppearance.VERTEX_FORMAT is POSITION_AND_ST — no normal — so
 * the polyline `compressedAttributes` is unambiguously ST-only (one packed
 * float per vertex). Decode it directly. Idempotent: returns early if `st`
 * already exists (uncompressed path) or there's nothing to decode.
 * @private
 */
function ensurePolylineST(geometry) {
  const attrs = geometry.attributes;
  if (!defined(attrs)) {
    return;
  }
  if (defined(attrs.st) && defined(attrs.st.values)) {
    return;
  }
  const compressed = attrs.compressedAttributes;
  if (!defined(compressed) || !defined(compressed.values)) {
    return;
  }
  const values = compressed.values;
  const cpa = compressed.componentsPerAttribute || 1;
  const numVertices = Math.floor(values.length / cpa);
  if (numVertices === 0) {
    return;
  }
  const outST = new Float32Array(numVertices * 2);
  for (let v = 0; v < numVertices; v++) {
    // ST occupies the first slot of each vertex (the only slot for a
    // POSITION_AND_ST polyline).
    const st = AttributeCompression.decompressTextureCoordinates(
      values[v * cpa],
      scratchPolylineST,
    );
    outST[v * 2] = st.x;
    outST[v * 2 + 1] = st.y;
  }
  geometry.attributes.st = new GeometryAttribute({
    componentDatatype: ComponentDatatype.FLOAT,
    componentsPerAttribute: 2,
    values: outST,
  });
}

/**
 * Builds the polyline-material render pipeline. Identical structure to
 * createPolylineAppearancePipeline (camera + material + effects bind groups,
 * triangle-list, cull none, scene-FB targets) but parametrized by the
 * per-material shader module and translucent flag, and the material BGL sized
 * for the (variable) MaterialUniforms struct.
 * @private
 */
function createPolylineMaterialPipeline(
  device,
  context,
  cache,
  shaderModule,
  vertexLayout,
  translucent,
  needsTexture,
) {
  const cameraBGL = makeBindGroupLayout(device, "Polyline Mat Camera BGL", [
    uniformBuffer(0, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),
  ]);
  const materialBGL = makeBindGroupLayout(device, "Polyline Mat Material BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
  ]);
  cache.cameraBindGroupLayout = cameraBGL;
  cache.materialBindGroupLayout = materialBGL;

  // 376d — textured Image material gets a @group(2) texture+sampler (3-binding
  // layout matching the surface path so ensureMaterialTextureBindGroup reuses).
  // The polyline material FS never consumes the effects group, so the textured
  // variant has NO effects group (texture takes slot 2). Non-textured variants
  // keep the effects placeholder at slot 2 as before.
  let bindGroupLayouts;
  if (needsTexture === true) {
    cache.textureBindGroupLayout = makeBindGroupLayout(
      device,
      "Polyline Mat Texture BGL",
      [
        sampler(0, Stage.FRAGMENT),
        texture(1, Stage.FRAGMENT),
        texture(2, Stage.FRAGMENT),
      ],
    );
    cache.effectsBGL = null;
    bindGroupLayouts = [cameraBGL, materialBGL, cache.textureBindGroupLayout];
  } else {
    cache.textureBindGroupLayout = null;
    cache.effectsBGL = getEffectsBindGroupLayout(device);
    bindGroupLayouts = [cameraBGL, materialBGL, cache.effectsBGL];
  }

  const canvasFormat =
    context.scenePipelineFormat || navigator.gpu.getPreferredCanvasFormat();

  return device.createRenderPipeline({
    label: "Polyline material appearance pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: bindGroupLayouts,
    }),
    vertex: {
      module: shaderModule.module,
      entryPoint: "vertexMain",
      buffers: [vertexLayout.layout],
    },
    fragment: {
      module: shaderModule.module,
      entryPoint: "fragmentMain",
      targets: makeSceneFBTargets(canvasFormat, {
        translucent,
        emitsGBuffer: false,
      }),
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "none",
      frontFace: "ccw",
    },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: !translucent,
      depthCompare: "less-equal",
    },
    multisample:
      (context._msaaSamples ?? 1) > 1
        ? { count: context._msaaSamples }
        : undefined,
  });
}

/**
 * Creates WebGPU draw commands for a polyline `Primitive` with
 * `PolylineMaterialAppearance` (MATERIAL slice). Packs 22 floats/vertex
 * (posHigh/posLow + prev/next high/low + expandAndWidth + st) and routes
 * through the per-material polyline FS (Color / Dash / Glow / Arrow / Outline).
 * Reuses the COLOR-slice camera UB + writeRTEUniformsPolyline, and the
 * material-path material-UB upload (material._uniformBuffer.gpuData).
 *
 * Pick is not wired in this slice (color-only) — pickCommands is cleared.
 * @private
 */
function createPolylineMaterialAppearanceCommands(
  primitive,
  appearance,
  material,
  translucent,
  colorCommands,
  pickCommands,
  frameState,
  geometries,
) {
  const context = frameState.context;
  const device = context.device;

  if (!defined(primitive._webgpuPolylineMatCache)) {
    primitive._webgpuPolylineMatCache = {
      shaderType: null,
      shaderModule: null,
      pipeline: null,
      translucent: null,
      cameraBindGroupLayout: null,
      materialBindGroupLayout: null,
      effectsBGL: null,
      materialBuffer: null,
      materialBindGroup: null,
      _materialBufferSize: 0,
      cameraBuffers: [],
      cameraBindGroups: [],
      vertexBuffers: [],
      indexBuffers: [],
      indexFormats: [],
      indexCounts: [],
      vertexCounts: [],
    };
  }
  const cache = primitive._webgpuPolylineMatCache;

  const vertexLayout = getPolylineMaterialVertexLayout();
  const shaderInfo = selectPolylineMaterialShader(material);

  const shaderChanged = cache.shaderType !== shaderInfo.type;
  const translucentChanged = cache.translucent !== translucent;
  // 376c — log-depth define-flip (see the COLOR builder for the rationale).
  const logDepthActive = isWebGPULogDepthActive(context, frameState);
  const logDepthChanged = cache.logDepthEnabled !== logDepthActive;

  if (
    !defined(cache.pipeline) ||
    shaderChanged ||
    translucentChanged ||
    logDepthChanged
  ) {
    cache.shaderType = shaderInfo.type;
    cache.translucent = translucent;
    cache.logDepthEnabled = logDepthActive;

    // Route through the preprocessor so getShaderSource's csm_polylineCommon
    // injection + the //>>ifdef LOG_DEPTH blocks resolve. defines=0 reproduces
    // the pre-376c byte-identical path.
    const code = preprocessShaderSource(
      shaderInfo.code,
      logDepthActive ? ShaderDefine.LOG_DEPTH : 0,
    );
    cache.shaderModule = WebGPUShaderModule.create({
      device: device,
      code: code,
      label: `${shaderInfo.type} Shader`,
    });

    cache.pipeline = createPolylineMaterialPipeline(
      device,
      context,
      cache,
      cache.shaderModule,
      vertexLayout,
      translucent,
      shaderInfo.needsTexture === true,
    );
    // Force the texture bind group to rebuild against the new layout.
    cache.textureBindGroup = undefined;
  }

  // Material UBO — shared across all geometries of this primitive. Sized to
  // the Material's packed uniform buffer (gpuData), min PLACEHOLDER_MATERIAL_BYTES.
  const matUB = defined(material) ? material._uniformBuffer : undefined;
  const matGpuData = defined(matUB) ? matUB.gpuData : undefined;
  const matByteSize = defined(matGpuData)
    ? Math.max(matGpuData.byteLength, PLACEHOLDER_MATERIAL_BYTES)
    : PLACEHOLDER_MATERIAL_BYTES;

  if (
    !defined(cache.materialBuffer) ||
    cache._materialBufferSize !== matByteSize
  ) {
    if (defined(cache.materialBuffer)) {
      cache.materialBuffer.destroy();
    }
    cache.materialBuffer = device.createBuffer({
      size: matByteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Polyline Mat Material UB",
    });
    cache._materialBufferSize = matByteSize;
    cache.materialBindGroup = null; // force rebind
  }

  if (defined(matGpuData)) {
    if (!defined(matUB) || matUB.isDirty || !defined(cache.materialBindGroup)) {
      device.queue.writeBuffer(cache.materialBuffer, 0, matGpuData);
      if (defined(matUB)) {
        matUB.clearDirty();
      }
    }
  } else {
    device.queue.writeBuffer(
      cache.materialBuffer,
      0,
      new Float32Array(matByteSize / 4),
    );
  }

  if (!defined(cache.materialBindGroup)) {
    cache.materialBindGroup = device.createBindGroup({
      layout: cache.materialBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cache.materialBuffer } }],
    });
  }

  // 376d — textured Image material: build/refresh the @group(2) texture bind
  // group from the material's loaded image (reuses the surface-material helper;
  // falls back to a 1×1 white texture until the image readies).
  if (shaderInfo.needsTexture === true) {
    ensureMaterialTextureBindGroup(
      context,
      device,
      material,
      shaderInfo.type,
      cache,
    );
  }

  // Depth-range type MUST be webgpu before the viewportOrthographic /
  // projection getters are read (see csm_polylineCommon.wgsl depth note).
  Matrix4.setDepthRangeType("webgpu");
  const rte = computeRTEMatrices(
    context.uniformState,
    frameState.camera,
    primitive.modelMatrix,
  );

  const validCommands = [];
  const pass = translucent ? Pass.TRANSLUCENT : Pass.OPAQUE;
  const appearanceRS = appearance?.renderState;
  const effectsPlaceholder = getPlaceholderEffects(device);

  const fpv = vertexLayout.floatsPerVertex;

  for (let i = 0; i < geometries.length; i++) {
    const geometry = geometries[i];
    // `Primitive` runs GeometryPipeline.compressVertices() by default, which
    // packs `st` into `compressedAttributes` and deletes the literal `st`
    // attribute. PolylineMaterialAppearance.VERTEX_FORMAT requests `st`, so we
    // must reconstruct it before packing — otherwise st reads as (0,0) and the
    // st-dependent materials (Glow/Arrow/Outline) collapse (Glow → invisible,
    // since glowPower/abs(0-0.5)-glowPower/0.5 == 0). The polyline-specific
    // decoder is required — the generic ensureUncompressedAttributes mis-sniffs
    // the ST-only slot as a normal for st==(0,0) first vertices. (The COLOR
    // slice didn't need this — PolylineColorAppearance has no st.)
    ensurePolylineST(geometry);
    const attrs = geometry.attributes;

    const posHigh = attrs.position3DHigh;
    const posLow = attrs.position3DLow;
    const prevHigh = attrs.prevPosition3DHigh;
    const prevLow = attrs.prevPosition3DLow;
    const nextHigh = attrs.nextPosition3DHigh;
    const nextLow = attrs.nextPosition3DLow;
    const expandAndWidth = attrs.expandAndWidth;
    const stAttr = attrs.st;
    if (
      !defined(posHigh) ||
      !defined(posHigh.values) ||
      !defined(prevHigh) ||
      !defined(nextHigh) ||
      !defined(expandAndWidth)
    ) {
      continue;
    }

    const posHighVals = posHigh.values;
    const posLowVals = posLow.values;
    const prevHighVals = prevHigh.values;
    const prevLowVals = prevLow.values;
    const nextHighVals = nextHigh.values;
    const nextLowVals = nextLow.values;
    const ewVals = expandAndWidth.values;
    const ewCPA = expandAndWidth.componentsPerAttribute || 2;
    const stVals =
      defined(stAttr) && defined(stAttr.values) ? stAttr.values : null;
    const stCPA = defined(stAttr) ? stAttr.componentsPerAttribute || 2 : 2;

    // 376b — projected 2D positions for the morph blend (see the COLOR packer).
    const p2dH = attrs.position2DHigh;
    const p2dL = attrs.position2DLow;
    const pv2dH = attrs.prevPosition2DHigh;
    const pv2dL = attrs.prevPosition2DLow;
    const nx2dH = attrs.nextPosition2DHigh;
    const nx2dL = attrs.nextPosition2DLow;
    const has2D =
      defined(p2dH) && defined(p2dH.values) && defined(pv2dH) && defined(nx2dH);

    const numVertices =
      posHighVals.length / (posHigh.componentsPerAttribute || 3);

    // 40 floats/vertex: posHigh(3) posLow(3) prevHigh(3) prevLow(3)
    // nextHigh(3) nextLow(3) expandAndWidth(2) st(2) + 2D positions(18) [376b]
    const vertexData = new Float32Array(numVertices * fpv);
    for (let v = 0; v < numVertices; v++) {
      const p3 = v * 3;
      const vOff = v * fpv;
      vertexData[vOff] = posHighVals[p3];
      vertexData[vOff + 1] = posHighVals[p3 + 1];
      vertexData[vOff + 2] = posHighVals[p3 + 2];
      vertexData[vOff + 3] = posLowVals[p3];
      vertexData[vOff + 4] = posLowVals[p3 + 1];
      vertexData[vOff + 5] = posLowVals[p3 + 2];
      vertexData[vOff + 6] = prevHighVals[p3];
      vertexData[vOff + 7] = prevHighVals[p3 + 1];
      vertexData[vOff + 8] = prevHighVals[p3 + 2];
      vertexData[vOff + 9] = prevLowVals[p3];
      vertexData[vOff + 10] = prevLowVals[p3 + 1];
      vertexData[vOff + 11] = prevLowVals[p3 + 2];
      vertexData[vOff + 12] = nextHighVals[p3];
      vertexData[vOff + 13] = nextHighVals[p3 + 1];
      vertexData[vOff + 14] = nextHighVals[p3 + 2];
      vertexData[vOff + 15] = nextLowVals[p3];
      vertexData[vOff + 16] = nextLowVals[p3 + 1];
      vertexData[vOff + 17] = nextLowVals[p3 + 2];
      const ewOff = v * ewCPA;
      vertexData[vOff + 18] = ewVals[ewOff];
      vertexData[vOff + 19] = ewVals[ewOff + 1];
      if (stVals !== null) {
        const stOff = v * stCPA;
        vertexData[vOff + 20] = stVals[stOff];
        vertexData[vOff + 21] = stVals[stOff + 1];
      } else {
        vertexData[vOff + 20] = 0.0;
        vertexData[vOff + 21] = 0.0;
      }
      // 376b — 2D positions @ floats 22-39 (loc8-13). Zero when absent.
      if (has2D) {
        for (let c = 0; c < 3; c++) {
          vertexData[vOff + 22 + c] = p2dH.values[p3 + c];
          vertexData[vOff + 25 + c] = p2dL.values[p3 + c];
          vertexData[vOff + 28 + c] = pv2dH.values[p3 + c];
          vertexData[vOff + 31 + c] = pv2dL.values[p3 + c];
          vertexData[vOff + 34 + c] = nx2dH.values[p3 + c];
          vertexData[vOff + 37 + c] = nx2dL.values[p3 + c];
        }
      }
    }

    if (defined(cache.vertexBuffers[i])) {
      cache.vertexBuffers[i].destroy();
    }
    cache.vertexBuffers[i] = WebGPUBuffer.createVertexBuffer(
      device,
      vertexData,
      `Polyline Mat VB ${i}`,
    );

    ensureIndexBuffer(device, geometry, cache, i);
    cache.vertexCounts[i] = numVertices;

    if (!defined(cache.cameraBuffers[i])) {
      cache.cameraBuffers[i] = device.createBuffer({
        size: POLYLINE_CAMERA_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: `Polyline Mat Camera UB ${i}`,
      });
    }
    const cameraData = scratchPolylineUniformData;
    writeRTEUniformsPolyline(cameraData, rte, context.uniformState, context);
    device.queue.writeBuffer(
      cache.cameraBuffers[i],
      0,
      cameraData.buffer,
      0,
      POLYLINE_CAMERA_BYTES,
    );

    cache.cameraBindGroups[i] = device.createBindGroup({
      layout: cache.cameraBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cache.cameraBuffers[i] } }],
    });

    // 376d — textured Image variant binds the texture group at slot 2 (no
    // effects group on that pipeline); all other materials keep the effects
    // placeholder at slot 2.
    const slot2 =
      shaderInfo.needsTexture === true && defined(cache.textureBindGroup)
        ? cache.textureBindGroup
        : effectsPlaceholder.bindGroup;
    const commandBindGroups = [
      cache.cameraBindGroups[i],
      cache.materialBindGroup,
      slot2,
    ];

    const cmd = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: commandBindGroups,
      vertexBuffer: cache.vertexBuffers[i],
      indexBuffer: cache.indexBuffers[i],
      indexFormat: cache.indexFormats[i],
      vertexCount: defined(cache.indexBuffers[i])
        ? undefined
        : cache.vertexCounts[i],
      indexCount: defined(cache.indexBuffers[i])
        ? cache.indexCounts[i]
        : undefined,
      pass: pass,
      owner: primitive,
      renderState: appearanceRS,
    });
    cmd._webgpuCameraBuffer = cache.cameraBuffers[i];
    cmd._webgpuShaderType = shaderInfo.type;
    cmd._isPolylineAppearance = true;
    // 376d — textured Image variant: slot 2 is the texture, NOT an effects
    // placeholder. Flag so _refreshPrimitiveEffectsSlot doesn't clobber it,
    // and carry the material + cache so the per-frame hook can refresh the
    // texture bind group once the async image decodes (commands are built once,
    // typically BEFORE the Image material's image finishes loading).
    cmd._noEffectsSlot = shaderInfo.needsTexture === true;
    if (shaderInfo.needsTexture === true) {
      cmd._webgpuMatCache = cache;
      cmd._webgpuMaterial = material;
      cmd._webgpuMatShaderType = shaderInfo.type;
    }
    // Reference the shared material UBO + wrapper so the per-frame update can
    // re-upload when a time-varying material (flowing dash, glow phase) marks
    // itself dirty.
    cmd._webgpuMaterialBuffer = cache.materialBuffer;
    cmd._webgpuMaterialUB = matUB;
    cmd._label = "polyline material appearance";
    cmd.vertexStride = vertexLayout.stride;
    validCommands.push(cmd);
  }

  colorCommands.length = validCommands.length;
  for (let i = 0; i < validCommands.length; i++) {
    colorCommands[i] = validCommands[i];
  }
  // Pick is color-only in this slice.
  pickCommands.length = 0;
}

// =========================================================================
// WebGPU Command Creation — Per-Instance-Color Path
// =========================================================================

/**
 * Creates WebGPU draw commands for a Primitive's geometries (PerInstanceColorAppearance).
 * Vertex buffers carry positionHigh(3) + positionLow(3) for RTE precision.
 * @private
 */
function createWebGPUCommands(
  primitive,
  appearance,
  material,
  translucent,
  twoPasses,
  colorCommands,
  pickCommands,
  frameState,
) {
  const context = frameState.context;
  const device = context.device;

  const webgpuGeomData = primitive._webgpuGeometryData;
  const rawGeometries = primitive._geometries;

  if (!defined(device)) {
    colorCommands.length = 0;
    return;
  }

  const useWebGPUData = defined(webgpuGeomData) && webgpuGeomData.length > 0;
  const useRawGeom = defined(rawGeometries) && rawGeometries.length > 0;

  if (!useWebGPUData && !useRawGeom) {
    colorCommands.length = 0;
    return;
  }

  const geometries = useWebGPUData ? webgpuGeomData : rawGeometries;
  const validCommands = [];

  const batchTable = primitive._batchTable;
  const colorIndex = primitive._batchTableAttributeIndices?.color;
  const hasInstanceColors = defined(batchTable) && defined(colorIndex);

  const allowPicking = primitive._allowPicking;
  const pickIds = primitive._pickIds;
  const hasPickIds = allowPicking && defined(pickIds) && pickIds.length > 0;

  // ── Initialize GPU object cache ──
  if (!defined(primitive._webgpuCache)) {
    primitive._webgpuCache = {
      shaderType: null,
      shaderModule: null,
      pipeline: null,
      // Log-depth epic Slice 2b — tracks the LOG_DEPTH define state baked into
      // the cached lit pipeline so the Slice 4 master-switch flip rebuilds it.
      logDepthEnabled: false,
      cameraBindGroupLayout: null,
      materialBindGroupLayout: null,
      cameraBuffers: [],
      cameraBindGroups: [],
      materialBuffer: null,
      materialBindGroup: null,
      vertexBuffers: [],
      indexBuffers: [],
      indexFormats: [],
      indexCounts: [],
      vertexCounts: [],
      pickShaderModule: null,
      pickPipeline: null,
      pickCameraBindGroupLayout: null,
      pickMaterialBindGroupLayout: null,
      pickCameraBuffers: [],
      pickCameraBindGroups: [],
      pickMaterialBuffers: [],
      pickMaterialBindGroups: [],
    };
  }
  const cache = primitive._webgpuCache;

  // ── Shader selection ──
  const firstGeometry = geometries[0];
  // Slice 5d Batch 157 — decode oct-encoded vertex attributes BEFORE
  // selecting the shader. `Primitive` runs `GeometryPipeline.compressVertices`
  // by default, which packs the normal (+ st / tangent / bitangent) into a
  // single `compressedAttributes` slot and RTE-splits position into
  // position3DHigh/Low. Without this decode, `selectWebGPUShader` sees no
  // literal `normal` attribute and falls back to the UNLIT `basic` shader —
  // so a flat:false PerInstanceColorAppearance (or any lit non-material
  // appearance) rendered with no lighting. The per-geometry loop below
  // already calls this, but that runs AFTER shader selection; the material
  // path (createMaterialAndQueueCommands) decodes before its selection, so
  // it was unaffected. ensureUncompressedAttributes is idempotent.
  ensureUncompressedAttributes(firstGeometry);

  // NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU (COLOR slice) — a polyline
  // `Primitive` with `PolylineColorAppearance` over a `PolylineGeometry`.
  // The geometry carries `expandAndWidth` + `prevPosition3DHigh`/`nextPosition3DHigh`
  // attributes that the basic packer drops, collapsing the 4 coincident quad
  // vertices to one clip point (0px). Route to a dedicated packer + pipeline +
  // camera UB that consume those attributes and do the screen-space width
  // expansion. Detected before selectWebGPUShader because that helper only
  // inspects normal/st and would pick "basic".
  const firstAttrs = firstGeometry.attributes;
  const isPolylineAppearanceGeometry =
    defined(firstAttrs.expandAndWidth) &&
    defined(firstAttrs.expandAndWidth.values) &&
    defined(firstAttrs.prevPosition3DHigh) &&
    defined(firstAttrs.prevPosition3DHigh.values);
  if (isPolylineAppearanceGeometry) {
    createPolylineAppearanceCommands(
      primitive,
      appearance,
      translucent,
      colorCommands,
      pickCommands,
      frameState,
      geometries,
    );
    return;
  }

  const shaderInfo = selectWebGPUShader(firstGeometry.attributes);
  const vertexLayout = getVertexLayoutForShader(shaderInfo.type);

  const shaderChanged = cache.shaderType !== shaderInfo.type;
  const translucentChanged = cache.translucent !== translucent;
  // DP-H17 — treat a twoPasses flip like a shader / translucent flip
  // so the back-face + front-face pipeline variants get rebuilt.
  const twoPassesChanged = cache.twoPasses !== twoPasses;
  // Session 65 Batch 2 — detect topology change so outline geometries
  // (line-list / line-strip) get their own pipeline. The cached
  // pipeline's topology is baked at create time; we must rebuild on
  // change.
  const primitiveTopology = mapCesiumPrimitiveTypeToWebGPU(
    firstGeometry.primitiveType,
  );
  const topologyChanged = cache.primitiveTopology !== primitiveTopology;
  const needsTexture = isTexturedShader(shaderInfo.type);
  const isLit = isPhongShader(shaderInfo.type);
  const cameraBufferSize = isLit ? LIT_CAMERA_BYTES : FLAT_CAMERA_BYTES;

  // Log-depth epic Slice 2b / Slice 5 — the Phong producers (PrimitivePhongColor
  // / PrimitivePhongTexturedColor) AND the unlit Basic producers
  // (PrimitiveBasicColor / PrimitiveBasicTexturedColor) gain `//>>ifdef LOG_DEPTH`
  // blocks that emit logarithmic @builtin(frag_depth). Both shader families now
  // carry the gated blocks (the lit ones read camera.logDepth from the LIT UB
  // tail at floats 76-79; the basic ones read it from the FLAT UB tail at floats
  // 40-43, added by writeRTEUniformsFlat). Activate the define whenever the
  // master switch + per-frame flag are on. Defaults FALSE, so this is inert
  // (defines=0 → historical else-branch, byte-identical). `logDepthChanged`
  // forces a shader-module + pipeline rebuild when the master switch flips,
  // mirroring the topologyChanged invalidation guard. Pick variants stay
  // hyperbolic (handled by the pick pipeline path, never given LOG_DEPTH).
  const logDepthActive = isWebGPULogDepthActive(context, frameState);
  const logDepthChanged = cache.logDepthEnabled !== logDepthActive;

  if (
    shaderChanged ||
    translucentChanged ||
    twoPassesChanged ||
    topologyChanged ||
    logDepthChanged
  ) {
    cache.shaderType = shaderInfo.type;
    cache.translucent = translucent;
    cache.primitiveTopology = primitiveTopology;
    cache.logDepthEnabled = logDepthActive;

    // DP-H19-SHADER-DECODE (Batch 27) — always route through the
    // preprocessor so `//>>ifdef COMPRESSED_VERTICES` / `//>>else`
    // blocks in material shaders resolve to concrete WGSL. `defines=0`
    // produces the historical code path (the `//>>else` branch carries
    // the original VertexInput + logic), so this is a no-op for
    // uncompressed-path shaders. The compressed opt-in flips the bit
    // in a follow-up wire-up step that also swaps the vertex buffer
    // packer to emit `compressedAttributes` directly.
    //
    // Log-depth epic Slice 2b — OR in LOG_DEPTH for lit Phong producers when
    // active (see logDepthActive above). The preprocessor resolves the
    // `//>>ifdef LOG_DEPTH` blocks; with the master switch off this is 0 and
    // the else-branch (no frag_depth, no varying) is byte-identical.
    const shaderDefines = logDepthActive ? ShaderDefine.LOG_DEPTH : 0;
    // Slice 5d Batch 156 — prepend the Forward+ clustered lighting chunk to
    // the lit Phong primitive shaders (phong / phongTextured), same as the
    // Mat*Lit path in createMaterialPipelineAndCache. Gated on the shader
    // actually calling evalClusteredLights( so the chunk only lands where
    // it's used (not on basic / pick / flat shaders). Effects BGL is at
    // group 3 when a texture group occupies group 2, else group 2.
    let phongCode = shaderInfo.code;
    if (
      isPhongShader(shaderInfo.type) &&
      phongCode.includes("evalClusteredLights(")
    ) {
      const clGroup = needsTexture ? 3 : 2;
      phongCode = `${substituteClusteredLightingGroup(
        ClusteredLightingChunk,
        clGroup,
      )}\n${phongCode}`;
    }
    const processedCode = preprocessShaderSource(phongCode, shaderDefines);
    cache.shaderModule = WebGPUShaderModule.create({
      device: device,
      code: processedCode,
      label: `${shaderInfo.type} Shader`,
    });

    // Camera BGL — group(0): camera uniforms.
    //
    // Slice 5c-B Batch 124 — promoted to always VERTEX_FRAGMENT.
    // Batch 121 conditionally added FRAGMENT for
    // `isLit || isMaterialLitShader(shaderInfo.type)`, but Batch 124
    // discovered that Flat shaders also read camera in fragment for
    // the aerial-LUT fog block (FEAT-GAP-09). Rather than maintain a
    // shader-type-list of "needs fragment camera" that grows over
    // time, just declare VERTEX_FRAGMENT once — the visibility flag is
    // free at runtime and protects every present + future shader.
    cache.cameraBindGroupLayout = makeBindGroupLayout(device, "Camera BGL", [
      uniformBuffer(0, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),
    ]);

    // Material BGL — group(1): placeholder material uniforms
    cache.materialBindGroupLayout = makeBindGroupLayout(
      device,
      "Material BGL",
      [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
    );

    const bindGroupLayouts = [
      cache.cameraBindGroupLayout,
      cache.materialBindGroupLayout,
    ];

    if (needsTexture) {
      // Batch 25 — material texture bind group v2: one shared sampler +
      // TWO texture slots so multi-texture materials (NormalMap /
      // BumpMap / Water / ElevationBand) can bind both at once. Single-
      // texture shaders only declare @binding(1); the @binding(2) slot
      // is filled with a 1×1 placeholder and the shader ignores it
      // (WGSL allows bind group layouts to carry unused bindings).
      cache.textureBindGroupLayout = makeBindGroupLayout(
        device,
        "Texture BGL",
        [
          sampler(0, Stage.FRAGMENT),
          texture(1, Stage.FRAGMENT),
          texture(2, Stage.FRAGMENT),
        ],
      );
      bindGroupLayouts.push(cache.textureBindGroupLayout);
    } else {
      cache.textureBindGroupLayout = null;
    }

    // Effects BGL (shadow receive + clipping) — always present via placeholder
    const effectsBGL = getEffectsBindGroupLayout(device);
    bindGroupLayouts.push(effectsBGL);
    cache.effectsBGL = effectsBGL;

    // Batch 110 — primitive pipelines target the scene FB, so use
    // `scenePipelineFormat` (mirrors scene FB color format, not canvas
    // swap chain format). The legacy variable name `canvasFormat` is
    // kept for diff hygiene but the value is now scene-pipeline-correct.
    const canvasFormat =
      context.scenePipelineFormat || navigator.gpu.getPreferredCanvasFormat();
    // Build the primitive render pipeline for a given cull mode. Kept
    // as a closure so the `twoPasses` path below can create two extra
    // variants (cullMode: "front" for pass 1, cullMode: "back" for
    // pass 2) without duplicating the full descriptor.
    const makePipeline = (cullMode, label) =>
      device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({
          bindGroupLayouts: bindGroupLayouts,
        }),
        vertex: {
          module: cache.shaderModule.module,
          entryPoint: "vertexMain",
          buffers: [vertexLayout.layout],
        },
        fragment: {
          module: cache.shaderModule.module,
          entryPoint: "fragmentMain",
          // Slice 5c-B Batch 121 — Lit shaders (Phong + every Mat*Lit
          // variant) now emit FragOutput { color, normalRoughness } so
          // the pipeline declares slot 1 as writable. Flat shaders keep
          // the placeholder slot 1 (writeMask=0) because their fragment
          // returns @location(0) only — there's no geometric meaning to
          // a "normal" for flat-shaded primitives. `isLit` here is the
          // `isPhongShader` predicate (Phong + PhongTextured);
          // `isMaterialLitShader` (every Mat*Lit) is the parallel for
          // material-shader pipelines.
          targets: makeSceneFBTargets(canvasFormat, {
            translucent,
            emitsGBuffer: isLit || isMaterialLitShader(shaderInfo.type),
          }),
        },
        primitive: {
          topology: primitiveTopology,
          // Line topologies have no concept of "front" or "back" faces,
          // so `cullMode` must be "none" for them. The WebGPU spec
          // permits setting it but ignores the value for non-triangle
          // topologies; Cesium's twoPasses + cull-based depth handling
          // is meaningless for outlines anyway.
          cullMode: primitiveTopology.startsWith("line") ? "none" : cullMode,
          frontFace: "ccw",
        },
        depthStencil: {
          format: "depth24plus-stencil8",
          depthWriteEnabled: !translucent,
          depthCompare: "less-equal",
        },
        // Slice 5d Batch 156 — match the scene FB MSAA sample count, same
        // fix the material pipeline site got in Batch 132. Without it this
        // first-site pipeline (phong / phongTextured / basic / basicTextured
        // — i.e. PerInstanceColorAppearance + basic ColorAppearance) defaults
        // to sampleCount=1 against the MSAA=4 scene FB pass, so WebGPU
        // rejects it with "Attachment state not compatible with Scene
        // Framebuffer Render Pass" and the primitive renders black. The
        // Batch 132 fix only covered createMaterialPipelineAndCache (Mat*);
        // this site (selectWebGPUShader-based shaders) was missed.
        multisample:
          (context._msaaSamples ?? 1) > 1
            ? { count: context._msaaSamples }
            : undefined,
      });
    // Session 65 Batch 3 (2026-05-11): use BACK-face culling when the
    // appearance is closed (Box, Sphere, Ellipsoid, Cylinder — every
    // closed convex volume). Mirrors WebGL's
    // `Appearance.getDefaultRenderState(...)` which sets
    // `cull: { enabled: true, face: BACK }` when `closed: true`.
    //
    // The previous hardcoded `cullMode: "none"` left BOTH front and
    // back face triangles in the rasterizer. With `depthWriteEnabled =
    // true` (opaque path) the two faces fight depth-test at triangle
    // edges where their Z values nearly match — back-face fragments
    // win some pixels, creating visible "see-through" gridlines along
    // every triangulation seam. The user-reported symptom: single
    // opaque red sphere shows lat/long grid + imagery bleeding through
    // (Show or Hide Entities, single ellipsoid test, every closed-
    // shape entity demo).
    //
    // For non-closed appearances (Polyline, polygon outline, etc.)
    // we still pass `none` so both faces continue to render — those
    // primitives don't have a meaningful "back" face.
    //
    // EquirectangularPanorama cull-override (#13369): a closed appearance
    // can still explicitly DISABLE culling via
    // `renderState.cull.enabled: false`. WebGL honors this — its
    // `Appearance.getDefaultRenderState(...)` runs the `closed` branch
    // through `combine(existing, rs, true)` where the user's
    // `cull.enabled: false` wins over the closed-default `enabled: true`.
    // A panorama is `closed: true` (sphere) viewed from the inside, so it
    // sets `cull.enabled: false` to keep the inner faces visible. Without
    // this check WebGPU would back-face cull the interior and render the
    // panorama blank. When cull is explicitly disabled we force `none`
    // regardless of `closed`; the closed-volume two-pass cull behavior
    // (DP-H17) below only applies on the `cull.enabled !== false` path.
    const cullExplicitlyDisabled =
      appearance?.renderState?.cull?.enabled === false;
    const defaultCullMode =
      appearance?.closed && !cullExplicitlyDisabled ? "back" : "none";
    cache.pipeline = makePipeline(
      defaultCullMode,
      `Primitive pipeline (cull=${defaultCullMode})`,
    );
    // DP-H17 — closed translucent volumes need two draw calls with
    // opposite cull modes so back faces composite before front faces.
    // Build both variants up-front (they share everything except
    // cullMode) so the draw-emit code can pick them per twoPasses
    // pass. Non-twoPasses paths reuse the noCull pipeline as before.
    if (twoPasses) {
      cache.pipelineFrontCull = makePipeline(
        "front",
        "Primitive pipeline (cullFront → render back faces)",
      );
      cache.pipelineBackCull = makePipeline(
        "back",
        "Primitive pipeline (cullBack → render front faces)",
      );
    } else {
      cache.pipelineFrontCull = null;
      cache.pipelineBackCull = null;
    }
    cache.twoPasses = twoPasses;

    // Shared placeholder material buffer for per-instance-color shaders
    // (these shaders don't use material uniforms — just a placeholder vec4)
    cache.materialBuffer = device.createBuffer({
      size: PLACEHOLDER_MATERIAL_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Placeholder Material UB",
    });
    device.queue.writeBuffer(
      cache.materialBuffer,
      0,
      new Float32Array([0, 0, 0, 0]),
    );
    cache.materialBindGroup = device.createBindGroup({
      layout: cache.materialBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cache.materialBuffer } }],
    });

    // Default placeholder texture for textured shaders
    if (needsTexture && !defined(cache.defaultTexture)) {
      const texSize = 64;
      const checkerboard = new Uint8Array(texSize * texSize * 4);
      const tileSize = 8;
      for (let y = 0; y < texSize; y++) {
        for (let x = 0; x < texSize; x++) {
          const idx = (y * texSize + x) * 4;
          const isLight2 =
            (Math.floor(x / tileSize) + Math.floor(y / tileSize)) % 2 === 0;
          const val = isLight2 ? 230 : 80;
          checkerboard[idx] = val;
          checkerboard[idx + 1] = val;
          checkerboard[idx + 2] = val;
          checkerboard[idx + 3] = 255;
        }
      }
      cache.defaultTexture = WebGPUTexture.create2D(
        device,
        texSize,
        texSize,
        "rgba8unorm",
        1,
        "DefaultCheckerboard",
      );
      cache.defaultTexture.write(checkerboard);
      cache.defaultSampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        // Match WebGL Sampler.js default (CLAMP_TO_EDGE). Materials that need
        // tiling handle it in the shader via fract(repeat * st), so the sampler
        // wrap mode is almost always moot — but clamp is a safer default for
        // single-tile images (avoids edge bleeding between repeats).
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });
      cache.textureBindGroup = device.createBindGroup({
        layout: cache.textureBindGroupLayout,
        entries: [
          { binding: 0, resource: cache.defaultSampler },
          { binding: 1, resource: cache.defaultTexture.view },
        ],
      });
    }

    // ── Pick pipeline (split camera/material bind groups) ──
    if (hasPickIds) {
      const pickShaderCode = getPickShaderForType(shaderInfo.type);
      cache.pickShaderModule = WebGPUShaderModule.create({
        device: device,
        code: preprocessShaderSource(pickShaderCode, 0),
        label: `${shaderInfo.type} Pick Shader`,
      });

      // Pick camera BGL — group(0)
      cache.pickCameraBindGroupLayout = makeBindGroupLayout(
        device,
        "Pick Camera BGL",
        [uniformBuffer(0, Stage.VERTEX)],
      );

      // Pick material BGL — group(1): pickColor
      cache.pickMaterialBindGroupLayout = makeBindGroupLayout(
        device,
        "Pick Material BGL",
        [uniformBuffer(0, Stage.FRAGMENT)],
      );

      cache.pickPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [
            cache.pickCameraBindGroupLayout,
            cache.pickMaterialBindGroupLayout,
          ],
        }),
        vertex: {
          module: cache.pickShaderModule.module,
          entryPoint: "vertexMain",
          buffers: [vertexLayout.layout],
        },
        fragment: {
          module: cache.pickShaderModule.module,
          entryPoint: "fragmentMain",
          targets: [
            {
              format:
                context.presentationFormat ||
                navigator.gpu.getPreferredCanvasFormat(),
            },
          ],
        },
        // Pick pipeline mirrors the main primitive's topology so
        // outline geometry picking returns the same fragments as the
        // visual render (line-list vs triangle-list). Same Batch 2 fix.
        primitive: { topology: primitiveTopology, cullMode: "none" },
        depthStencil: {
          format: "depth24plus-stencil8",
          depthWriteEnabled: true,
          depthCompare: "less-equal",
        },
      });
    }
  }

  const validPickCommands = [];

  // Compute RTE matrices for initial uniform writes
  Matrix4.setDepthRangeType("webgpu");
  const rte = computeRTEMatrices(
    context.uniformState,
    frameState.camera,
    primitive.modelMatrix,
  );

  for (let i = 0; i < geometries.length; i++) {
    const geometry = geometries[i];

    // DP-H19 — reconstruct normal / st from `compressedAttributes` when
    // the primitive was built with `compressVertices: true` (the
    // default). Must run before any `geometry.attributes.*` reads below.
    ensureUncompressedAttributes(geometry);

    // ── Extract RTE position data (positionHigh + positionLow) ──
    const posData = extractPositionData(geometry);
    if (!posData) {
      continue;
    }
    const { posHighValues, posLowValues, numVertices } = posData;

    // ── Extract normals ──
    const normalAttr = geometry.attributes.normal;
    const hasNormals = defined(normalAttr) && defined(normalAttr.values);
    const normals = hasNormals ? normalAttr.values : null;
    const normalCPA = hasNormals ? normalAttr.componentsPerAttribute || 3 : 3;

    // ── Extract UVs ──
    const stAttr = geometry.attributes.st;
    const hasUV = defined(stAttr) && defined(stAttr.values);
    const uvs = hasUV ? stAttr.values : null;
    const stCPA = hasUV ? stAttr.componentsPerAttribute || 2 : 2;

    // ── Per-instance color ──
    let instanceColor = [1.0, 1.0, 1.0, 1.0];
    let gotInstanceColor = false;

    if (hasInstanceColors && i < primitive._numberOfInstances) {
      try {
        const batchColor = batchTable.getBatchedAttribute(i, colorIndex);
        if (defined(batchColor)) {
          if (defined(batchColor.red)) {
            instanceColor = [
              batchColor.red,
              batchColor.green,
              batchColor.blue,
              batchColor.alpha,
            ];
            gotInstanceColor = true;
          } else if (defined(batchColor.x)) {
            const r = batchColor.x;
            const g = batchColor.y;
            const b = batchColor.z;
            const a = batchColor.w;
            if (r > 1.0 || g > 1.0 || b > 1.0 || a > 1.0) {
              instanceColor = [r / 255.0, g / 255.0, b / 255.0, a / 255.0];
            } else {
              instanceColor = [r, g, b, a];
            }
            gotInstanceColor = true;
          }
        }
      } catch (e) {
        // Silently fall through
      }
    }

    if (!gotInstanceColor) {
      const colorAttr = geometry.attributes.color;
      if (
        defined(colorAttr) &&
        defined(colorAttr.values) &&
        colorAttr.values.length >= 4
      ) {
        instanceColor = [
          colorAttr.values[0],
          colorAttr.values[1],
          colorAttr.values[2],
          colorAttr.values[3],
        ];
      }
    }

    // ── Build RTE vertex data: posHigh(3) + posLow(3) + other attributes ──
    const fpv = vertexLayout.floatsPerVertex;
    const vertexData = new Float32Array(numVertices * fpv);

    for (let v = 0; v < numVertices; v++) {
      const posOff = v * 3;
      const vOff = v * fpv;

      // positionHigh (3 floats)
      vertexData[vOff] = posHighValues[posOff];
      vertexData[vOff + 1] = posHighValues[posOff + 1];
      vertexData[vOff + 2] = posHighValues[posOff + 2];
      // positionLow (3 floats)
      vertexData[vOff + 3] = posLowValues[posOff];
      vertexData[vOff + 4] = posLowValues[posOff + 1];
      vertexData[vOff + 5] = posLowValues[posOff + 2];

      if (shaderInfo.type === "phongTextured") {
        // posHigh(3)+posLow(3)+normal(3)+uv(2)+color(4) = 15 floats
        if (hasNormals) {
          const nOff = v * normalCPA;
          vertexData[vOff + 6] = normals[nOff];
          vertexData[vOff + 7] = normals[nOff + 1];
          vertexData[vOff + 8] = normals[nOff + 2];
        } else {
          vertexData[vOff + 6] = 0.0;
          vertexData[vOff + 7] = 1.0;
          vertexData[vOff + 8] = 0.0;
        }
        if (hasUV) {
          const uOff = v * stCPA;
          vertexData[vOff + 9] = uvs[uOff];
          vertexData[vOff + 10] = uvs[uOff + 1];
        } else {
          vertexData[vOff + 9] = 0.0;
          vertexData[vOff + 10] = 0.0;
        }
        vertexData[vOff + 11] = instanceColor[0];
        vertexData[vOff + 12] = instanceColor[1];
        vertexData[vOff + 13] = instanceColor[2];
        vertexData[vOff + 14] = instanceColor[3];
      } else if (shaderInfo.type === "basicTextured") {
        // posHigh(3)+posLow(3)+uv(2)+color(4) = 12 floats
        if (hasUV) {
          const uOff = v * stCPA;
          vertexData[vOff + 6] = uvs[uOff];
          vertexData[vOff + 7] = uvs[uOff + 1];
        } else {
          vertexData[vOff + 6] = 0.0;
          vertexData[vOff + 7] = 0.0;
        }
        vertexData[vOff + 8] = instanceColor[0];
        vertexData[vOff + 9] = instanceColor[1];
        vertexData[vOff + 10] = instanceColor[2];
        vertexData[vOff + 11] = instanceColor[3];
      } else if (shaderInfo.type === "phong") {
        // posHigh(3)+posLow(3)+normal(3)+color(4) = 13 floats
        if (hasNormals) {
          const nOff = v * normalCPA;
          vertexData[vOff + 6] = normals[nOff];
          vertexData[vOff + 7] = normals[nOff + 1];
          vertexData[vOff + 8] = normals[nOff + 2];
        } else {
          vertexData[vOff + 6] = 0.0;
          vertexData[vOff + 7] = 1.0;
          vertexData[vOff + 8] = 0.0;
        }
        vertexData[vOff + 9] = instanceColor[0];
        vertexData[vOff + 10] = instanceColor[1];
        vertexData[vOff + 11] = instanceColor[2];
        vertexData[vOff + 12] = instanceColor[3];
      } else {
        // basic: posHigh(3)+posLow(3)+color(4) = 10 floats
        vertexData[vOff + 6] = instanceColor[0];
        vertexData[vOff + 7] = instanceColor[1];
        vertexData[vOff + 8] = instanceColor[2];
        vertexData[vOff + 9] = instanceColor[3];
      }
    }

    // ── Vertex buffer ──
    if (!defined(cache.vertexBuffers[i]) || shaderChanged) {
      if (defined(cache.vertexBuffers[i])) {
        cache.vertexBuffers[i].destroy();
      }
      cache.vertexBuffers[i] = WebGPUBuffer.createVertexBuffer(
        device,
        vertexData,
        `Primitive VB ${i}`,
      );
    }

    // ── Index buffer ──
    ensureIndexBuffer(device, geometry, cache, i);
    cache.vertexCounts[i] = numVertices;

    // ── Camera uniform buffer (RTE layout) ──
    if (!defined(cache.cameraBuffers[i])) {
      cache.cameraBuffers[i] = device.createBuffer({
        size: cameraBufferSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: `Primitive Camera UB ${i}`,
      });
    }

    // Write initial camera RTE uniform data
    const cameraData = new Float32Array(cameraBufferSize / 4);
    if (isLit) {
      writeRTEUniformsLit(cameraData, rte, context.uniformState);
    } else {
      writeRTEUniformsFlat(cameraData, rte, context.uniformState);
    }
    device.queue.writeBuffer(cache.cameraBuffers[i], 0, cameraData);

    // ── Camera bind group — group(0) ──
    cache.cameraBindGroups[i] = device.createBindGroup({
      layout: cache.cameraBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cache.cameraBuffers[i] } }],
    });

    const pass = translucent ? Pass.TRANSLUCENT : Pass.OPAQUE;

    // Build bind group array: [camera, material, texture?, effects]
    const commandBindGroups = [
      cache.cameraBindGroups[i],
      cache.materialBindGroup,
    ];
    if (needsTexture && defined(cache.textureBindGroup)) {
      commandBindGroups.push(cache.textureBindGroup);
    }
    // Effects bind group (shadow + clipping) — placeholder when inactive
    const effectsPlaceholder = getPlaceholderEffects(device);
    commandBindGroups.push(effectsPlaceholder.bindGroup);

    // DP-H17 — closed translucent volumes: emit two draw commands per
    // geometry, back faces first then front faces. Matches the
    // canonical WebGL "twoPasses" behavior for semi-transparent boxes,
    // ellipsoids, cones, etc. — ensures correct compositing of the
    // volume's interior against its exterior.
    //
    // The back-face pipeline (cullMode: "front") runs first; the
    // front-face pipeline (cullMode: "back") runs second. Scene pass
    // ordering (both land in Pass.TRANSLUCENT) means they execute in
    // emission order within the translucent queue.
    //
    // Non-twoPasses path keeps the single cullMode: "none" pipeline
    // — unchanged from before DP-H17.
    // C-R1 (Batch 36) — forward the primitive's appearance renderState
    // onto emitted commands so `applyPerEncoderState` (Batch 30) runs
    // stencilRef / blendConstant / viewport / scissor per-draw. The
    // pipeline-baked fields (depthTest, depthMask, cull, blend, colorMask)
    // are still controlled by the Material + appearance.flat/closed
    // signals above; the renderState passthrough is purely for the
    // dynamic per-encoder state. Material-BLEND pipelines (DP-H16) and
    // twoPasses front/back-cull pipelines (DP-H17) continue to drive
    // pipeline identity.
    const appearanceRS = primitive.appearance?.renderState;
    const makeCommand = (pipeline, label) => {
      const cmd = new WebGPUDrawCommand({
        pipeline,
        bindGroups: commandBindGroups,
        vertexBuffer: cache.vertexBuffers[i],
        indexBuffer: cache.indexBuffers[i],
        indexFormat: cache.indexFormats[i],
        vertexCount: defined(cache.indexBuffers[i])
          ? undefined
          : cache.vertexCounts[i],
        indexCount: defined(cache.indexBuffers[i])
          ? cache.indexCounts[i]
          : undefined,
        pass: pass,
        owner: primitive,
        renderState: appearanceRS,
      });
      cmd._webgpuCameraBuffer = cache.cameraBuffers[i];
      cmd._webgpuShaderType = shaderInfo.type;
      cmd._label = label;
      // NEW-CSM-CAST-NO-DISPATCH-VIEWER (Batch 296) — shadow-cast metadata.
      // The interleaved primitive vertex buffer always begins with
      // positionHigh(3) + positionLow(3) (the first 24 bytes; see the
      // vertexData packing above), so the canonical `rte24` cast variant
      // reads it correctly — its declared stride of 24 just needs to be
      // overridden to this primitive's real interleaved stride
      // (`fpv * 4` bytes). `_inferShadowLayoutKey` can't sniff this from
      // the stride alone (it isn't 24), so we set the layout explicitly
      // and expose the stride for the cast pass's pipeline override.
      cmd._shadowCastLayout = "rte24";
      cmd.vertexStride = fpv * 4;
      return cmd;
    };
    if (twoPasses && cache.pipelineFrontCull && cache.pipelineBackCull) {
      validCommands.push(
        makeCommand(cache.pipelineFrontCull, "back-face pass"),
      );
      validCommands.push(
        makeCommand(cache.pipelineBackCull, "front-face pass"),
      );
    } else {
      validCommands.push(makeCommand(cache.pipeline, "single-pass"));
    }

    // ── Pick command (split camera/material bind groups) ──
    if (hasPickIds && i < pickIds.length && defined(cache.pickPipeline)) {
      const pickColor = pickIds[i].color;

      // Pick camera buffer — same flat layout as basic camera
      if (!defined(cache.pickCameraBuffers[i])) {
        cache.pickCameraBuffers[i] = device.createBuffer({
          size: PICK_CAMERA_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: `Pick Camera UB ${i}`,
        });
      }

      const pickCameraData = new Float32Array(PICK_CAMERA_BYTES / 4);
      writeRTEUniformsFlat(pickCameraData, rte, context.uniformState);
      device.queue.writeBuffer(cache.pickCameraBuffers[i], 0, pickCameraData);

      cache.pickCameraBindGroups[i] = device.createBindGroup({
        layout: cache.pickCameraBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: cache.pickCameraBuffers[i] } },
        ],
      });

      // Pick material buffer — pickColor(vec4)
      if (!defined(cache.pickMaterialBuffers[i])) {
        cache.pickMaterialBuffers[i] = device.createBuffer({
          size: PICK_MATERIAL_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: `Pick Material UB ${i}`,
        });
      }

      const pickMatData = new Float32Array(PICK_MATERIAL_BYTES / 4);
      if (defined(pickColor)) {
        pickMatData[0] = pickColor.red;
        pickMatData[1] = pickColor.green;
        pickMatData[2] = pickColor.blue;
        pickMatData[3] = pickColor.alpha;
      }
      device.queue.writeBuffer(cache.pickMaterialBuffers[i], 0, pickMatData);

      cache.pickMaterialBindGroups[i] = device.createBindGroup({
        layout: cache.pickMaterialBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: cache.pickMaterialBuffers[i] } },
        ],
      });

      const pickCommand = new WebGPUDrawCommand({
        pipeline: cache.pickPipeline,
        bindGroups: [
          cache.pickCameraBindGroups[i],
          cache.pickMaterialBindGroups[i],
        ],
        vertexBuffer: cache.vertexBuffers[i],
        indexBuffer: cache.indexBuffers[i],
        indexFormat: cache.indexFormats[i],
        vertexCount: defined(cache.indexBuffers[i])
          ? undefined
          : cache.vertexCounts[i],
        indexCount: defined(cache.indexBuffers[i])
          ? cache.indexCounts[i]
          : undefined,
        pass: pass,
        owner: primitive,
        // C-R1-PRIMITIVE-DERIVED (Batch 98) — forward `appearance.renderState`
        // onto the pick command too so `applyPerEncoderState` runs the
        // dynamic stencilRef / blendConstant / scissor / viewport ops in
        // pick passes. Pipeline-baked state (depthWrite-on, blend-off,
        // pick-color attachment format) stays in `cache.pickPipeline`;
        // this passthrough is purely for the per-encoder commands that
        // can't be baked into the pipeline. Without it, primitives that
        // declared a stencil-write or scissor in their appearance would
        // pick incorrectly even though they render correctly.
        renderState: appearanceRS,
      });

      pickCommand._webgpuCameraBuffer = cache.pickCameraBuffers[i];
      pickCommand._webgpuShaderType = "pick";
      pickCommand._webgpuPickColor = pickColor;
      pickCommand._isPickCommand = true;
      validPickCommands.push(pickCommand);
    }
  }

  colorCommands.length = validCommands.length;
  for (let i = 0; i < validCommands.length; i++) {
    colorCommands[i] = validCommands[i];
  }
  pickCommands.length = validPickCommands.length;
  for (let i = 0; i < validPickCommands.length; i++) {
    pickCommands[i] = validPickCommands[i];
  }
}

// =========================================================================
// Material Texture Binding — Real textures from Material._imageSources
// =========================================================================

/**
 * Returns the texture-slot mapping for a material shader type.
 *
 * Batch 25 — DP-H20 multi-texture materials (NormalMap, BumpMap, Water,
 * ElevationBand) need two textures bound at once. Each entry maps the
 * material's shader-type string to the `material._imageSources` keys
 * that feed the primary `@binding(1)` slot and the optional secondary
 * `@binding(2)` slot.
 *
 * Single-texture materials return `{ primary: "image" }` — the
 * secondary slot binds a placeholder at bind-group build time and the
 * shader's lack of a `@binding(2)` declaration leaves it unused.
 *
 * The return type is deliberately a plain object (not a class) so the
 * fast-path comparison in `ensureMaterialTextureBindGroup` is a pair of
 * `===` checks on `_matPrimarySource` / `_matSecondarySource`.
 *
 * @param {string} shaderType
 * @returns {{primary: string, secondary: (string|undefined)}}
 * @private
 */
function getTextureUniformName(shaderType) {
  if (shaderType.includes("NormalMap")) {
    return { primary: "image", secondary: "normalMap" };
  }
  if (shaderType.includes("BumpMap")) {
    return { primary: "image", secondary: "bumpMap" };
  }
  if (shaderType.includes("Water")) {
    // Water needs both the wave-normal perturbation texture and the
    // "where water is" specular mask. Pre-Batch-25 WebGPU only bound
    // `specularMap` at @binding(1) but the shader read it as if it
    // were the normal map — a subtle mislabel that produced chaotic
    // wave behavior on ocean tiles.
    return { primary: "normalMap", secondary: "specularMap" };
  }
  if (shaderType.includes("ElevBand")) {
    // ElevationBand — DP-H22 (Batch 25). Primary is the heights lookup
    // texture; secondary is the color ramp.
    return { primary: "heights", secondary: "colors" };
  }
  return { primary: "image" };
}

/**
 * Creates or reuses a WebGPU texture bind group from a Material's loaded image.
 * Falls back to the context's 1×1 white default texture if the image hasn't
 * loaded yet. Replaces the old checkerboard placeholder approach (MAT-1 fix).
 *
 * @param {object} context - WebGPU context with createTextureFromImage()
 * @param {GPUDevice} device - The GPU device
 * @param {object} material - CesiumJS Material with _imageSources map
 * @param {string} shaderType - Material shader type (e.g., 'matImageFlat')
 * @param {object} cache - Primitive's _webgpuCache
 * @returns {boolean} true if a valid texture bind group exists
 * @private
 */
function ensureMaterialTextureBindGroup(
  context,
  device,
  material,
  shaderType,
  cache,
) {
  const slots = getTextureUniformName(shaderType);
  const imageSources = defined(material) ? material._imageSources : undefined;
  const primarySource = defined(imageSources)
    ? imageSources[slots.primary]
    : undefined;
  const secondarySource =
    defined(imageSources) && defined(slots.secondary)
      ? imageSources[slots.secondary]
      : undefined;

  // Check if cached texture is still current (both slots unchanged)
  if (
    defined(cache.textureBindGroup) &&
    cache._matPrimarySource === primarySource &&
    cache._matSecondarySource === secondarySource
  ) {
    return true;
  }

  // DP-H21 — per-axis wrap mode from material fabric.
  //
  // Material fabrics expose tiling via `material.uniforms.repeat`,
  // which may be:
  //   - a Cartesian2 with numeric multipliers (common for Image,
  //     Checkerboard, Stripe, Water): x/y values > 1 indicate tiling.
  //     The fabric's fragment shader does
  //     `fract(repeat * materialInput.st)` so the sampler wrap mode
  //     only affects out-of-[0,1] UVs — repeat is still the correct
  //     wrap because atlas'd fabrics sometimes feed raw non-fract UVs.
  //   - a plain object `{ x: boolean, y: boolean }` — per-axis
  //     "should this axis tile?" flags. Used by some fabric dialects.
  //
  // Both shapes are honored. When no hint exists we keep the historical
  // `clamp-to-edge` default (safe for single-tile materials).
  const repeat = material?.uniforms?.repeat;
  let wantsRepeatU = false;
  let wantsRepeatV = false;
  if (defined(repeat)) {
    const rx = repeat.x;
    const ry = repeat.y;
    // Numeric shape: > 1 means tile. === 1 means clamp. < 1 is exotic
    // (under-sampling); caller's shader handles it via fract so we
    // treat sub-1 as "no tiling at sampler level" too.
    if (typeof rx === "number") {
      wantsRepeatU = rx > 1;
    } else if (typeof rx === "boolean") {
      wantsRepeatU = rx;
    }
    if (typeof ry === "number") {
      wantsRepeatV = ry > 1;
    } else if (typeof ry === "boolean") {
      wantsRepeatV = ry;
    }
  }
  const addressModeU = wantsRepeatU ? "repeat" : "clamp-to-edge";
  const addressModeV = wantsRepeatV ? "repeat" : "clamp-to-edge";

  // Rebuild the sampler when its address-mode configuration changes
  // (material fabric swapped, or repeat uniform mutated). Cheap —
  // samplers are lightweight and we only rebuild on the actual
  // change path.
  if (
    !defined(cache._matSampler) ||
    cache._matSamplerAddressU !== addressModeU ||
    cache._matSamplerAddressV !== addressModeV
  ) {
    cache._matSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU,
      addressModeV,
    });
    cache._matSamplerAddressU = addressModeU;
    cache._matSamplerAddressV = addressModeV;
    // Invalidate the bind group so it picks up the new sampler on
    // the next frame.
    cache.textureBindGroup = undefined;
  }

  // Resolve the fallback 1×1 placeholder view once — used for either slot
  // that doesn't have a real image. Single-texture materials always use
  // it for slot 2; multi-texture materials use it when the secondary
  // image hasn't loaded yet.
  const getPlaceholderView = () => {
    const defaultTex = context.defaultTexture;
    if (defined(defaultTex) && defined(defaultTex.view)) {
      return defaultTex.view;
    }
    if (!defined(cache.defaultTexture)) {
      cache.defaultTexture = WebGPUTexture.create2D(
        device,
        1,
        1,
        "rgba8unorm",
        1,
        "FallbackWhite",
      );
      cache.defaultTexture.write(new Uint8Array([255, 255, 255, 255]));
    }
    return cache.defaultTexture.view;
  };

  // Build / rebuild slot 1 (primary)
  let primaryView;
  if (defined(primarySource) && defined(context.createTextureFromImage)) {
    const gpuTex = context.createTextureFromImage(
      primarySource,
      "rgba8unorm",
      true,
    );
    if (defined(gpuTex)) {
      if (defined(cache._matGpuTexturePrimary)) {
        cache._matGpuTexturePrimary.destroy();
      }
      cache._matGpuTexturePrimary = gpuTex;
      primaryView = gpuTex.view;
    }
  }
  if (!defined(primaryView)) {
    primaryView = getPlaceholderView();
  }
  cache._matPrimarySource = primarySource;

  // Build / rebuild slot 2 (secondary). Always bind SOMETHING so the
  // bind group layout stays satisfied; when the material has no
  // secondary texture (single-texture material) we bind the placeholder.
  let secondaryView;
  if (defined(secondarySource) && defined(context.createTextureFromImage)) {
    const gpuTex2 = context.createTextureFromImage(
      secondarySource,
      "rgba8unorm",
      true,
    );
    if (defined(gpuTex2)) {
      if (defined(cache._matGpuTextureSecondary)) {
        cache._matGpuTextureSecondary.destroy();
      }
      cache._matGpuTextureSecondary = gpuTex2;
      secondaryView = gpuTex2.view;
    }
  }
  if (!defined(secondaryView)) {
    secondaryView = getPlaceholderView();
  }
  cache._matSecondarySource = secondarySource;

  cache.textureBindGroup = device.createBindGroup({
    layout: cache.textureBindGroupLayout,
    entries: [
      { binding: 0, resource: cache._matSampler },
      { binding: 1, resource: primaryView },
      { binding: 2, resource: secondaryView },
    ],
  });

  return true;
}

// =========================================================================
// Material Pipeline Creation
// =========================================================================

/**
 * Creates (or reuses) the GPU pipeline for a material shader.
 * @private
 */
function createMaterialPipelineAndCache(
  cache,
  device,
  shaderInfo,
  vertexLayout,
  context,
  isLit,
  translucent,
  primitiveTopology,
  appearanceClosed,
  logDepthActive,
) {
  const topology = primitiveTopology ?? "triangle-list";
  const closedClosed = appearanceClosed === true;
  // Log-depth epic Slice 5 — track the LOG_DEPTH define baked into the cached
  // material pipeline so the master switch flip (or a frame that toggles
  // frameState.useLogDepth) rebuilds the shader module + pipeline. Mirrors the
  // logDepthChanged invalidation guard on the Phong/Basic path.
  const logDepth = logDepthActive === true;
  if (
    cache.shaderType === shaderInfo.type &&
    cache.translucent === translucent &&
    cache.primitiveTopology === topology &&
    cache.appearanceClosed === closedClosed &&
    cache.logDepthEnabled === logDepth
  ) {
    return false;
  }
  cache.shaderType = shaderInfo.type;
  cache.translucent = translucent;
  cache.primitiveTopology = topology;
  cache.appearanceClosed = closedClosed;
  cache.logDepthEnabled = logDepth;

  // Slice 5d Batch 154 — prepend the Forward+ clustered lighting chunk to
  // Mat*Lit shaders so they can additively sample scene PointLights/Spots/
  // Directionals beyond the single sun. The chunk's `@group(__CL_GROUP__)`
  // token is substituted to wherever the effects BGL landed for this
  // pipeline: group 3 when a texture group occupies group 2, else group 2.
  //
  // Gate on the shader actually CALLING `evalClusteredLights(` (not just
  // being a Mat*Lit) so the chunk isn't prepended as dead code to shaders
  // that haven't been wired yet OR to pipeline variants (e.g. pick) whose
  // bind-group layout doesn't carry the effects BGL at the expected group.
  // As each Mat*Lit shader gains the call site, it automatically opts in.
  let materialCode = shaderInfo.code;
  if (
    isMaterialLitShader(shaderInfo.type) &&
    materialCode.includes("evalClusteredLights(")
  ) {
    const clGroup = shaderInfo.needsTexture ? 3 : 2;
    const clChunk = substituteClusteredLightingGroup(
      ClusteredLightingChunk,
      clGroup,
    );
    materialCode = `${clChunk}\n${materialCode}`;
  }
  // Log-depth epic Slice 5 — OR in LOG_DEPTH for the Mat*/PBR material shaders
  // when active. The preprocessor resolves the `//>>ifdef LOG_DEPTH` blocks
  // (logDepth UB tail read + csm_vertexLogDepth varying + csm_updatePositionDepth
  // clip-z clamp + csm_writeLogDepth frag_depth). With the master switch off this
  // is 0 and the else-branch (no frag_depth, hyperbolic) is byte-identical.
  // Lit Mat shaders read the tail from the LIT UB (floats 76-79); Flat Mat and
  // PBR read from the FLAT/LIT UB tail respectively — both packed unconditionally.
  const shaderDefines = logDepth ? ShaderDefine.LOG_DEPTH : 0;
  cache.shaderModule = WebGPUShaderModule.create({
    device: device,
    code: preprocessShaderSource(materialCode, shaderDefines),
    label: `${shaderInfo.type} Material Shader`,
  });

  // Camera BGL — group(0).
  //
  // Slice 5c-B Batch 124 — bug fix surfaced by the litmat polygon probe
  // (probe-litmat-mrt). Pre-fix: `isLit ? VERTEX_FRAGMENT : VERTEX`.
  // The Flat material shaders (e.g. PrimitiveMatColorFlat) read
  // `camera.encodedCameraHigh` + `camera.encodedCameraLow` in fragment
  // for the FEAT-GAP-09 aerial-perspective fog block at L99. With the
  // pre-fix gate, Flat pipelines built camera BGL with VERTEX-only
  // visibility and the shader's fragment read tripped "Entry point's
  // stage (ShaderStage::Fragment) is not in the binding visibility in
  // the layout (ShaderStage::Vertex)" the first time a Flat material
  // primitive rendered in a scene with the LUT active. Default scenes
  // had the LUT placeholder off so this stayed latent.
  //
  // Always VERTEX_FRAGMENT — the visibility flag is free at runtime
  // and protects against any future shader (Lit or Flat) adding a
  // fragment-side camera read.
  cache.cameraBindGroupLayout = makeBindGroupLayout(device, "Mat Camera BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
  ]);

  // Material BGL — group(1): material uniforms from MaterialUniformBuffer
  cache.materialBindGroupLayout = makeBindGroupLayout(
    device,
    "Mat Material BGL",
    [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
  );

  const bindGroupLayouts = [
    cache.cameraBindGroupLayout,
    cache.materialBindGroupLayout,
  ];

  if (shaderInfo.needsTexture) {
    // Batch 25 — two texture slots (see the matching BGL in
    // `createMaterialPipelineAndCache` ~line 720 for the rationale).
    cache.textureBindGroupLayout = makeBindGroupLayout(
      device,
      "Material Texture BGL",
      [
        sampler(0, Stage.FRAGMENT),
        texture(1, Stage.FRAGMENT),
        texture(2, Stage.FRAGMENT),
      ],
    );
    bindGroupLayouts.push(cache.textureBindGroupLayout);
  } else {
    cache.textureBindGroupLayout = null;
  }

  // Slice 2d — material + PBR pipelines gain the effects BGL as the
  // last bind group so shaders that opt in to CSM receive (PBR simple/
  // textured today; material Lit variants to follow) can declare
  // `@group(N)` for effects at the trailing slot. Shaders that don't
  // reference the effects bindings ignore the extra BG — WebGPU allows
  // unused bind groups in a pipeline layout.
  const matEffectsBGL = getEffectsBindGroupLayout(device);
  bindGroupLayouts.push(matEffectsBGL);
  cache.effectsBGL = matEffectsBGL;

  // Batch 110 — color pipeline targets scene FB; use scenePipelineFormat.
  const canvasFormat =
    context.scenePipelineFormat || navigator.gpu.getPreferredCanvasFormat();
  cache.pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts }),
    vertex: {
      module: cache.shaderModule.module,
      entryPoint: "vertexMain",
      buffers: [vertexLayout.layout],
    },
    fragment: {
      module: cache.shaderModule.module,
      entryPoint: "fragmentMain",
      targets: makeSceneFBTargets(canvasFormat, { translucent }),
    },
    primitive: {
      topology,
      // Session 65 Batch 3 — cull back faces for closed convex shapes
      // (matching `Appearance.getDefaultRenderState` `closed: true`
      // branch in WebGL). Prevents back-face z-fighting that produces
      // visible mesh gridlines on opaque ellipsoid/sphere/cylinder
      // entities (the user-reported gridline bug). Non-closed
      // appearances stay with `cullMode: "none"`.
      cullMode: topology.startsWith("line")
        ? "none"
        : closedClosed
          ? "back"
          : "none",
      frontFace: "ccw",
    },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: !translucent,
      depthCompare: "less-equal",
    },
    // Slice 5c-B Batch 132 — match scene FB MSAA. Pre-fix this pipeline
    // defaulted to sampleCount=1 against the default scene FB MSAA=4
    // → "Attachment state not compatible" fires the moment any
    // MaterialAppearance primitive (Polygon, Wall, Corridor, etc.)
    // renders in a default scene. Same family as the Batch 118
    // EllipsoidPrimitive MSAA bug. Pulled from `context._msaaSamples`
    // (defaulted by SceneFramebuffer to the active scene MSAA count).
    multisample:
      (context._msaaSamples ?? 1) > 1
        ? { count: context._msaaSamples }
        : undefined,
  });

  return true;
}

// =========================================================================
// Material Vertex Data Builder — RTE (posHigh + posLow)
// =========================================================================

/**
 * Builds interleaved vertex data for material shaders with RTE positions.
 * Flat layout:  posHigh(3) + posLow(3) + st(2) = 8 floats/vertex
 * Lit layout:   posHigh(3) + posLow(3) + normal(3) + st(2) = 11 floats/vertex
 * @private
 */
function buildMaterialVertexData(
  posHighValues,
  posLowValues,
  normals,
  uvs,
  numVertices,
  isLit,
  normalCPA,
  stCPA,
) {
  const fpv = isLit ? 11 : 8;
  const vertexData = new Float32Array(numVertices * fpv);

  for (let v = 0; v < numVertices; v++) {
    const posOff = v * 3;
    const vOff = v * fpv;

    // positionHigh (3 floats)
    vertexData[vOff] = posHighValues[posOff];
    vertexData[vOff + 1] = posHighValues[posOff + 1];
    vertexData[vOff + 2] = posHighValues[posOff + 2];
    // positionLow (3 floats)
    vertexData[vOff + 3] = posLowValues[posOff];
    vertexData[vOff + 4] = posLowValues[posOff + 1];
    vertexData[vOff + 5] = posLowValues[posOff + 2];

    if (isLit) {
      // Normal (3 floats) at offset 6
      if (normals) {
        const nOff = v * normalCPA;
        vertexData[vOff + 6] = normals[nOff];
        vertexData[vOff + 7] = normals[nOff + 1];
        vertexData[vOff + 8] = normals[nOff + 2];
      } else {
        vertexData[vOff + 6] = 0.0;
        vertexData[vOff + 7] = 1.0;
        vertexData[vOff + 8] = 0.0;
      }
      // ST (2 floats) at offset 9
      if (uvs) {
        const uOff = v * stCPA;
        vertexData[vOff + 9] = uvs[uOff];
        vertexData[vOff + 10] = uvs[uOff + 1];
      }
    } else if (uvs) {
      // Flat: ST (2 floats) at offset 6
      const uOff = v * stCPA;
      vertexData[vOff + 6] = uvs[uOff];
      vertexData[vOff + 7] = uvs[uOff + 1];
    }
  }
  return vertexData;
}

// =========================================================================
// Material Command Creation — MaterialAppearance Path
// =========================================================================

/**
 * Creates WebGPU draw commands for a Primitive using MaterialAppearance.
 * Vertex buffers carry positionHigh(3) + positionLow(3) for RTE precision.
 * @private
 */
function createWebGPUMaterialCommands(
  primitive,
  appearance,
  material,
  translucent,
  twoPasses,
  colorCommands,
  pickCommands,
  frameState,
) {
  const context = frameState.context;
  const device = context.device;
  if (!defined(device)) {
    colorCommands.length = 0;
    return;
  }

  const webgpuGeomData = primitive._webgpuGeometryData;
  const rawGeometries = primitive._geometries;
  const useW = defined(webgpuGeomData) && webgpuGeomData.length > 0;
  const useR = defined(rawGeometries) && rawGeometries.length > 0;
  if (!useW && !useR) {
    colorCommands.length = 0;
    return;
  }
  const geometries = useW ? webgpuGeomData : rawGeometries;

  if (!defined(primitive._webgpuCache)) {
    primitive._webgpuCache = {
      shaderType: null,
      shaderModule: null,
      pipeline: null,
      // Log-depth epic Slice 2b — kept in the shape for symmetry with the
      // phong-path cache; the material path does not yet convert its Mat*Lit
      // shaders (deferred), so it stays false here.
      logDepthEnabled: false,
      cameraBindGroupLayout: null,
      materialBindGroupLayout: null,
      textureBindGroupLayout: null,
      cameraBuffers: [],
      cameraBindGroups: [],
      materialBuffer: null,
      materialBindGroup: null,
      vertexBuffers: [],
      indexBuffers: [],
      indexFormats: [],
      indexCounts: [],
      vertexCounts: [],
      pickShaderModule: null,
      pickPipeline: null,
      pickCameraBindGroupLayout: null,
      pickMaterialBindGroupLayout: null,
      pickCameraBuffers: [],
      pickCameraBindGroups: [],
      pickMaterialBuffers: [],
      pickMaterialBindGroups: [],
    };
  }
  const cache = primitive._webgpuCache;

  // NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU (MATERIAL slice) — a polyline
  // `Primitive` with `PolylineMaterialAppearance` reaches the material path
  // (PolylineMaterialAppearance has a `material`, so PrimitiveCommandHelpers
  // routes here, not to createWebGPUCommands). The geometry carries
  // `expandAndWidth` + `prevPosition3DHigh`/`nextPosition3DHigh` — the same
  // detection the COLOR slice uses. Route to a dedicated packer + per-material
  // FS that does the screen-space width expansion and feeds v_st / v_width /
  // v_polylineAngle to the material shader. Detected before selectMaterialShader
  // because that helper inspects normal/st and would pick a surface material
  // shader whose vertex layout drops the polyline attributes (collapsing the
  // ribbon to 0px — the COLOR-slice symptom, material edition).
  const polyAttrs = geometries[0].attributes;
  const isPolylineMaterialGeometry =
    defined(polyAttrs.expandAndWidth) &&
    defined(polyAttrs.expandAndWidth.values) &&
    defined(polyAttrs.prevPosition3DHigh) &&
    defined(polyAttrs.prevPosition3DHigh.values);
  if (isPolylineMaterialGeometry) {
    createPolylineMaterialAppearanceCommands(
      primitive,
      appearance,
      material,
      translucent,
      colorCommands,
      pickCommands,
      frameState,
      geometries,
    );
    return;
  }

  // DP-H19 — decompress every geometry's `compressedAttributes` back into
  // `normal` / `st` before any downstream read. Doing this for all
  // geometries up front (not just `firstGeom`) is important: the
  // shader-variant-selection below inspects the first geometry's
  // attribute presence, but later draw commands iterate the full set
  // and must see the same shape. This helper is idempotent so it's
  // cheap to call repeatedly (no double-decode on subsequent frames).
  for (let i = 0; i < geometries.length; i++) {
    ensureUncompressedAttributes(geometries[i]);
  }

  const firstGeom = geometries[0];
  const attrs = firstGeom.attributes;
  const hasNormals = defined(attrs.normal) && defined(attrs.normal.values);
  const hasST = defined(attrs.st) && defined(attrs.st.values);
  const isFlat = defined(appearance.flat) ? appearance.flat : false;

  const shaderInfo = selectMaterialShader(material, isFlat, hasNormals, hasST);
  const isLit =
    isMaterialLitShader(shaderInfo.type) || isPBRShader(shaderInfo.type);
  const vertexLayout = getMaterialVertexLayout(shaderInfo.type);
  const cameraBufferSize = isLit ? LIT_CAMERA_BYTES : FLAT_CAMERA_BYTES;

  // Session 65 Batch 2 — topology-aware material pipeline. Outline
  // geometries (PrimitiveType.LINES, etc.) need `line-list` instead of
  // `triangle-list`. See `mapCesiumPrimitiveTypeToWebGPU` for the
  // mapping. Without this, outlined materials in entity-emitted
  // primitives (CZML Box outlines, ground-polylines styled as
  // materials) rasterize garbage.
  const matPrimitiveTopology = mapCesiumPrimitiveTypeToWebGPU(
    firstGeom.primitiveType,
  );

  // Log-depth epic Slice 5 — Mat*/PBR shaders now carry `//>>ifdef LOG_DEPTH`
  // blocks. Activate the define whenever the master switch + per-frame flag are
  // on; the logDepth UB tail is already packed by writeRTEUniformsLit (Mat*Lit/
  // PBR) and writeRTEUniformsFlat (Mat*Flat). Inert when off (defines=0,
  // byte-identical hyperbolic path).
  const logDepthActive = isWebGPULogDepthActive(context, frameState);

  // EquirectangularPanorama cull-override (#13369): the material path
  // (MaterialAppearance + a Material — e.g. a panorama's Image material)
  // is what actually drives back-face culling for closed material
  // primitives. A closed appearance can explicitly DISABLE culling via
  // `renderState.cull.enabled: false` (WebGL honors this — the closed
  // default `cull.enabled: true` loses to the user's `false` through
  // `combine(existing, rs, true)` in `Appearance.getDefaultRenderState`).
  // A panorama is `closed: true` (sphere) viewed from inside, so it sets
  // `cull.enabled: false` to keep its inner faces visible. We fold the
  // override into the closed signal here so the pipeline's cullMode
  // becomes `none` and the interior renders instead of being culled blank,
  // matching WebGL. Closed volumes WITHOUT the override (Box/Sphere/
  // Ellipsoid/Cylinder defaults) keep `cull.enabled: true` and still
  // back-face cull.
  const cullExplicitlyDisabled =
    appearance?.renderState?.cull?.enabled === false;
  const closedAndCulled =
    appearance?.closed === true && !cullExplicitlyDisabled;

  const shaderChanged = createMaterialPipelineAndCache(
    cache,
    device,
    shaderInfo,
    vertexLayout,
    context,
    isLit,
    translucent,
    matPrimitiveTopology,
    closedAndCulled,
    logDepthActive,
  );

  // Bind real material texture (from Material._imageSources) or fall back to
  // context.defaultTexture (1×1 white). This replaces the old checkerboard
  // placeholder (MAT-1 fix). Called every command creation so async-loaded
  // textures are picked up as soon as they arrive.
  if (shaderInfo.needsTexture && defined(cache.textureBindGroupLayout)) {
    ensureMaterialTextureBindGroup(
      context,
      device,
      material,
      shaderInfo.type,
      cache,
    );
  }

  // Pick support (split camera/material bind groups)
  const pickIds = primitive._pickIds;
  const hasPickIds =
    primitive._allowPicking && defined(pickIds) && pickIds.length > 0;
  if (hasPickIds && shaderChanged) {
    const pickCode = getMaterialPickShaderForType(shaderInfo.type);
    cache.pickShaderModule = WebGPUShaderModule.create({
      device,
      code: preprocessShaderSource(pickCode, 0),
      label: `${shaderInfo.type} MatPick`,
    });

    // Pick camera BGL — group(0).
    //
    // Slice 5c-B Batch 124 — promoted to VERTEX_FRAGMENT to match the
    // color BGL fix above. Pick shaders today only read camera in
    // vertex, but the alpha-mask discard path in some Mat pick shaders
    // reads material in fragment, and any future migration that
    // shares the color shader's camera struct (e.g. position-from-eye-
    // space for selective masking) would trip the same Vertex-only
    // bug. Visibility flag is free at runtime.
    cache.pickCameraBindGroupLayout = makeBindGroupLayout(
      device,
      "MatPick Camera BGL",
      [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
    );

    // Pick material BGL — group(1): pickColor
    cache.pickMaterialBindGroupLayout = makeBindGroupLayout(
      device,
      "MatPick Material BGL",
      [uniformBuffer(0, Stage.FRAGMENT)],
    );

    const fmt =
      context.presentationFormat || navigator.gpu.getPreferredCanvasFormat();
    cache.pickPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [
          cache.pickCameraBindGroupLayout,
          cache.pickMaterialBindGroupLayout,
        ],
      }),
      vertex: {
        module: cache.pickShaderModule.module,
        entryPoint: "vertexMain",
        buffers: [vertexLayout.layout],
      },
      fragment: {
        module: cache.pickShaderModule.module,
        entryPoint: "fragmentMain",
        targets: [{ format: fmt }],
      },
      // Material pick pipeline matches the visual render topology so
      // outline-styled materials get pickable lines (Batch 2 fix).
      primitive: { topology: matPrimitiveTopology, cullMode: "none" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    });
  }

  Matrix4.setDepthRangeType("webgpu");
  const rte = computeRTEMatrices(
    context.uniformState,
    frameState.camera,
    primitive.modelMatrix,
  );
  const pass = translucent ? Pass.TRANSLUCENT : Pass.OPAQUE;

  // Create or update shared material GPU buffer from MaterialUniformBuffer
  const matUB = defined(material) ? material._uniformBuffer : undefined;
  const matGpuData = defined(matUB) ? matUB.gpuData : undefined;
  const matByteSize = defined(matGpuData)
    ? Math.max(matGpuData.byteLength, PLACEHOLDER_MATERIAL_BYTES)
    : PLACEHOLDER_MATERIAL_BYTES;

  if (
    !defined(cache.materialBuffer) ||
    cache._materialBufferSize !== matByteSize
  ) {
    if (defined(cache.materialBuffer)) {
      cache.materialBuffer.destroy();
    }
    cache.materialBuffer = device.createBuffer({
      size: matByteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Mat Material UB",
    });
    cache._materialBufferSize = matByteSize;
    cache.materialBindGroup = null; // Force rebind
  }

  // Upload material data (only when dirty or first time)
  if (defined(matGpuData)) {
    if (!defined(matUB) || matUB.isDirty || !defined(cache.materialBindGroup)) {
      device.queue.writeBuffer(cache.materialBuffer, 0, matGpuData);
      if (defined(matUB)) {
        matUB.clearDirty();
      }
    }
  } else {
    // No material uniform buffer — write placeholder zeros
    device.queue.writeBuffer(
      cache.materialBuffer,
      0,
      new Float32Array(matByteSize / 4),
    );
  }

  // Create material bind group if needed
  if (!defined(cache.materialBindGroup)) {
    cache.materialBindGroup = device.createBindGroup({
      layout: cache.materialBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cache.materialBuffer } }],
    });
  }

  const validCommands = [];
  const validPickCommands = [];

  for (let i = 0; i < geometries.length; i++) {
    const geometry = geometries[i];
    const posData = extractPositionData(geometry);
    if (!posData) {
      continue;
    }

    const { posHighValues, posLowValues, numVertices } = posData;
    const normalAttr = geometry.attributes.normal;
    const stAttr = geometry.attributes.st;
    const normals =
      defined(normalAttr) && defined(normalAttr.values)
        ? normalAttr.values
        : null;
    const uvs =
      defined(stAttr) && defined(stAttr.values) ? stAttr.values : null;
    const nCPA = normalAttr ? normalAttr.componentsPerAttribute || 3 : 3;
    const sCPA = stAttr ? stAttr.componentsPerAttribute || 2 : 2;

    // Build RTE material vertex buffer
    const vertexData = buildMaterialVertexData(
      posHighValues,
      posLowValues,
      normals,
      uvs,
      numVertices,
      isLit,
      nCPA,
      sCPA,
    );
    if (!defined(cache.vertexBuffers[i]) || shaderChanged) {
      if (defined(cache.vertexBuffers[i])) {
        cache.vertexBuffers[i].destroy();
      }
      cache.vertexBuffers[i] = WebGPUBuffer.createVertexBuffer(
        device,
        vertexData,
        `Mat VB ${i}`,
      );
    }

    ensureIndexBuffer(device, geometry, cache, i);
    cache.vertexCounts[i] = numVertices;

    // Camera uniform buffer — per geometry instance
    if (!defined(cache.cameraBuffers[i])) {
      cache.cameraBuffers[i] = device.createBuffer({
        size: cameraBufferSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: `Mat Camera UB ${i}`,
      });
    }

    // Write camera RTE data
    const cameraData = new Float32Array(cameraBufferSize / 4);
    if (isLit) {
      writeRTEUniformsLit(cameraData, rte, context.uniformState);
    } else {
      writeRTEUniformsFlat(cameraData, rte, context.uniformState);
    }
    device.queue.writeBuffer(cache.cameraBuffers[i], 0, cameraData);

    // Camera bind group — group(0)
    cache.cameraBindGroups[i] = device.createBindGroup({
      layout: cache.cameraBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cache.cameraBuffers[i] } }],
    });

    // Build bind group array: [camera, material, texture?, effects]
    const cmdBGs = [cache.cameraBindGroups[i], cache.materialBindGroup];
    if (shaderInfo.needsTexture && defined(cache.textureBindGroup)) {
      cmdBGs.push(cache.textureBindGroup);
    }
    // Slice 2d — trailing effects slot matches the pipeline layout
    // added in `createMaterialPipelineAndCache`. Starts on the
    // shared placeholder; `updateWebGPUMaterialCommandUniforms`
    // swaps in the active BG per frame when shadow / CSM is on.
    const matEffectsPlaceholder = getPlaceholderEffects(device);
    cmdBGs.push(matEffectsPlaceholder.bindGroup);

    // C-R1 (Batch 36) — forward appearance.renderState for material path too.
    const cmd = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: cmdBGs,
      vertexBuffer: cache.vertexBuffers[i],
      indexBuffer: cache.indexBuffers[i],
      indexFormat: cache.indexFormats[i],
      vertexCount: defined(cache.indexBuffers[i]) ? undefined : numVertices,
      indexCount: defined(cache.indexBuffers[i])
        ? cache.indexCounts[i]
        : undefined,
      pass,
      owner: primitive,
      renderState: primitive.appearance?.renderState,
    });
    cmd._webgpuCameraBuffer = cache.cameraBuffers[i];
    cmd._webgpuShaderType = shaderInfo.type;
    // Reference the shared material UBO + wrapper so per-frame updates can
    // re-upload when the material is dirty. Previously the material UBO was
    // only uploaded at command-creation time, so time-varying materials
    // (animated water, flowing dash, glowing polyline) froze after frame 1.
    cmd._webgpuMaterialBuffer = cache.materialBuffer;
    cmd._webgpuMaterialUB = matUB;
    // NEW-CSM-CAST-NO-DISPATCH-VIEWER (Batch 296) — shadow-cast metadata.
    // The material vertex buffer (buildMaterialVertexData) is interleaved
    // posHigh(3) + posLow(3) + ... so the first 24 bytes match the `rte24`
    // cast variant; only the stride differs (8 floats flat / 11 floats lit).
    // See the matching block in the PerInstanceColor path above.
    cmd._shadowCastLayout = "rte24";
    cmd.vertexStride = (isLit ? 11 : 8) * 4;
    validCommands.push(cmd);

    // Pick command (split camera/material bind groups)
    if (hasPickIds && i < pickIds.length && defined(cache.pickPipeline)) {
      const pc = pickIds[i].color;

      // Pick camera buffer
      if (!defined(cache.pickCameraBuffers[i])) {
        cache.pickCameraBuffers[i] = device.createBuffer({
          size: PICK_CAMERA_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: `MatPick Camera UB ${i}`,
        });
      }

      const pickCameraData = new Float32Array(PICK_CAMERA_BYTES / 4);
      writeRTEUniformsFlat(pickCameraData, rte, context.uniformState);
      device.queue.writeBuffer(cache.pickCameraBuffers[i], 0, pickCameraData);

      cache.pickCameraBindGroups[i] = device.createBindGroup({
        layout: cache.pickCameraBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: cache.pickCameraBuffers[i] } },
        ],
      });

      // Pick material buffer — pickColor(vec4)
      if (!defined(cache.pickMaterialBuffers[i])) {
        cache.pickMaterialBuffers[i] = device.createBuffer({
          size: PICK_MATERIAL_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: `MatPick Material UB ${i}`,
        });
      }

      const pickMatData = new Float32Array(PICK_MATERIAL_BYTES / 4);
      if (defined(pc)) {
        pickMatData[0] = pc.red;
        pickMatData[1] = pc.green;
        pickMatData[2] = pc.blue;
        pickMatData[3] = pc.alpha;
      }
      device.queue.writeBuffer(cache.pickMaterialBuffers[i], 0, pickMatData);

      cache.pickMaterialBindGroups[i] = device.createBindGroup({
        layout: cache.pickMaterialBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: cache.pickMaterialBuffers[i] } },
        ],
      });

      const pickCmd = new WebGPUDrawCommand({
        pipeline: cache.pickPipeline,
        bindGroups: [
          cache.pickCameraBindGroups[i],
          cache.pickMaterialBindGroups[i],
        ],
        vertexBuffer: cache.vertexBuffers[i],
        indexBuffer: cache.indexBuffers[i],
        indexFormat: cache.indexFormats[i],
        vertexCount: defined(cache.indexBuffers[i]) ? undefined : numVertices,
        indexCount: defined(cache.indexBuffers[i])
          ? cache.indexCounts[i]
          : undefined,
        pass,
        owner: primitive,
        // C-R1-PRIMITIVE-DERIVED (Batch 98) — material-path pickCommand
        // also forwards `appearance.renderState`. Same rationale as the
        // shader-path pickCommand above (line 1498-ish): per-encoder
        // dynamic state needs to flow even though pipeline-baked state
        // (pick attachment format, depth-write on, no blend) lives in
        // `cache.pickPipeline`.
        renderState: primitive.appearance?.renderState,
      });
      pickCmd._webgpuCameraBuffer = cache.pickCameraBuffers[i];
      pickCmd._webgpuShaderType = "pick";
      pickCmd._webgpuPickColor = pc;
      pickCmd._isPickCommand = true;
      validPickCommands.push(pickCmd);
    }
  }

  colorCommands.length = validCommands.length;
  for (let i = 0; i < validCommands.length; i++) {
    colorCommands[i] = validCommands[i];
  }
  pickCommands.length = validPickCommands.length;
  for (let i = 0; i < validPickCommands.length; i++) {
    pickCommands[i] = validPickCommands[i];
  }
}

// =========================================================================
// Material Per-Frame Uniform Update
// =========================================================================

// Scratch buffer for per-frame material camera uniform updates
// 80 floats = 320 bytes for the lit/PBR camera UBO (mvpRTE+mvRTE+normalMatrix
// +camHigh+camLow+lightDir+prevVP + the log-depth logDepth tail;
// writeRTEUniformsLit writes through float 79). Sized for the larger of the two
// layouts; flat/material shaders fit comfortably in the same scratch (flat now
// writes through float 43 for its own logDepth tail). Log-depth epic Slice 5 —
// Mat*Lit/PBR read the LIT tail (floats 76-79), Mat*Flat read the FLAT tail
// (floats 40-43); both inert until the LOG_DEPTH pipeline define is set.
const scratchMaterialCameraData = new Float32Array(80);

/**
 * Updates camera matrices for a material/PBR draw command each frame.
 * Material parameters are in a separate bind group — only camera data needs per-frame update.
 * @private
 */
function updateWebGPUMaterialCommandUniforms(command, frameState, modelMatrix) {
  if (!command.isWebGPUDrawCommand || !command._webgpuCameraBuffer) {
    return;
  }
  const context = frameState.context;
  const device = context.device;
  if (!device) {
    return;
  }

  const rte = computeRTEMatrices(
    context.uniformState,
    frameState.camera,
    modelMatrix,
  );
  const shaderType = command._webgpuShaderType;
  const isLit2 = isMaterialLitShader(shaderType) || isPBRShader(shaderType);

  const ud = scratchMaterialCameraData;

  if (isLit2) {
    writeRTEUniformsLit(ud, rte, context.uniformState);
    device.queue.writeBuffer(
      command._webgpuCameraBuffer,
      0,
      ud.buffer,
      0,
      LIT_CAMERA_BYTES,
    );
  } else {
    writeRTEUniformsFlat(ud, rte, context.uniformState);
    device.queue.writeBuffer(
      command._webgpuCameraBuffer,
      0,
      ud.buffer,
      0,
      FLAT_CAMERA_BYTES,
    );
  }

  // Re-upload the material UBO if the Material's `_uniformBuffer` marked
  // itself dirty since the last frame. MaterialUniformBuffer flips `isDirty`
  // whenever a time-varying uniform (water clock, dash pattern, glow phase)
  // gets recomputed in `Material.update()`. Previously the re-upload only
  // happened at command-creation time \u2014 which only runs once per appearance
  // change \u2014 so every time-varying material froze after frame 1.
  const matUB = command._webgpuMaterialUB;
  const matBuffer = command._webgpuMaterialBuffer;
  if (defined(matUB) && defined(matBuffer) && matUB.isDirty) {
    const matData = matUB.gpuData;
    if (defined(matData)) {
      device.queue.writeBuffer(matBuffer, 0, matData);
    }
    matUB.clearDirty();
  }

  // Slice 2d — swap the effects bind group for this frame so shadow-
  // receive / CSM bindings reach lit material + PBR shaders instead of
  // the zero-filled placeholder the command was built with.
  _refreshPrimitiveEffectsSlot(command, frameState);
}

const WebGPUPrimitiveCommands = {
  createWebGPUCommands,
  createWebGPUMaterialCommands,
  updateWebGPUCommandUniforms,
  updateWebGPUMaterialCommandUniforms,
  updateWebGPUPickCommandUniforms,
};

export default WebGPUPrimitiveCommands;
export {
  createWebGPUCommands,
  createWebGPUMaterialCommands,
  updateWebGPUCommandUniforms,
  updateWebGPUMaterialCommandUniforms,
  updateWebGPUPickCommandUniforms,
  // FEAT-GAP-09 (Batch 100) — exported so Advanced renderers (Voxel,
  // GaussianSplat, PointCloud) can reuse the per-frame effects-BG
  // resolver. Keeps the (shadow, csm, atmosphereLut) toggle hash +
  // placeholder fallback logic centralized — no point in duplicating
  // it once per Advanced shader renderer.
  _getOrCreateSharedPrimitiveEffectsBG as getOrCreateSharedAdvancedEffectsBG,
};
