/**
 * @module WebGPUPrimitiveCommands
 *
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
 */
import AttributeCompression from "../../Core/AttributeCompression.js";
import Cartesian2 from "../../Core/Cartesian2.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import ComponentDatatype from "../../Core/ComponentDatatype.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import GeometryAttribute from "../../Core/GeometryAttribute.js";
import Matrix4 from "../../Core/Matrix4.js";
import Pass from "../Pass.js";
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
import {
  getEffectsBindGroupLayout,
  getPlaceholderEffects,
  createEffectsBindGroup,
} from "./WebGPUEffectsBindGroup.js";

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
// RTE camera uniform scratch buffers (76 floats = 304 bytes max for lit with prevVP)
const scratchRTEUniformData = new Float32Array(80);

// Camera-only UBO sizes (no material fields)
// DP-H41 (Batch 27) — each variant now carries previousViewProjection (mat4x4,
// 64 bytes) at the tail for TAA / motion-vector reprojection.
const FLAT_CAMERA_BYTES = 160; // mvpRTE(64) + camHigh(16) + camLow(16) + prevVP(64)
const LIT_CAMERA_BYTES = 304; // mvpRTE(64) + mvRTE(64) + normalMatrix(64) + camHigh(16) + camLow(16) + lightDir(16) + prevVP(64)
const PICK_CAMERA_BYTES = 160; // same as flat

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
    // Fallback for geometries produced without the metadata stash.
    // Best-effort inference: `componentsPerAttribute` tells us the
    // per-vertex slot count; we assume `hasSt` first (matches the most
    // common Primitive vertex format), then `hasNormal`.
    hasNormal = componentsPerAttribute >= 1;
    hasSt = componentsPerAttribute >= 2;
    hasTangent = false;
    hasBitangent = false;
    if (!_decompressMissingMetaWarned) {
      _decompressMissingMetaWarned = true;
      console.warn(
        "[WebGPUPrimitiveCommands] compressedAttributes without " +
          "`_compressedAttributesMeta` — falling back to inference. " +
          "Verify geometry source calls GeometryPipeline.compressVertices.",
      );
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
        AttributeCompression.octDecodeFloat(
          values[slot++],
          scratchDecompressedNormal,
        );
        outNormal[v * 3] = scratchDecompressedNormal.x;
        outNormal[v * 3 + 1] = scratchDecompressedNormal.y;
        outNormal[v * 3 + 2] = scratchDecompressedNormal.z;
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

/**
 * Builds a GPUColorTargetState descriptor for a render pipeline.
 * Translucent primitives get standard pre-multiplied alpha blending
 * (src = src.a, dst = 1 - src.a). Opaque primitives get no blend state
 * so the fragment overwrites the destination.
 *
 * @param {GPUTextureFormat} format
 * @param {boolean} translucent
 * @returns {GPUColorTargetState}
 * @private
 */
function makeFragmentTarget(format, translucent) {
  if (!translucent) {
    return { format: format };
  }
  return {
    format: format,
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
}

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
 *       = 40 floats = 160 bytes (DP-H41, Batch 27)
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
}

/**
 * Writes RTE uniform data for a lit (Phong/PBR) shader.
 * Layout: mvpRTE(16) + mvRTE(16) + normalMatrix(16) + camHigh(4) + camLow(4)
 *       + lightDir(4) + prevVP(16) = 76 floats = 304 bytes (DP-H41, Batch 27)
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
      }
    : undefined;

  const frameNumber = frameState.frameNumber;
  const hasShadow = defined(receiveShadowMap);

  // Invalidate cache when frame ticks OR when the (shadow, csm) pair
  // toggles. We hash the toggle pair into a small int so a cheap
  // compare catches on/off changes within the same frame (rare —
  // frameState normally increments frameNumber every tick — but the
  // guard is nearly free).
  const toggleHash = (hasShadow ? 1 : 0) | (hasCsm ? 2 : 0);
  if (
    context._primitiveEffectsBGFrameNumber === frameNumber &&
    context._primitiveEffectsBGToggleHash === toggleHash &&
    defined(context._primitiveEffectsBG)
  ) {
    return context._primitiveEffectsBG;
  }

  // When neither feature is active we MUST return the placeholder
  // explicitly (not null) so callers swap stale active-state BGs back
  // to zero-filled placeholder data on toggle-off transitions. Example:
  // CSM toggled ON at frame N plants a real BG in cmd.bindGroups[last];
  // CSM toggled OFF at frame N+1 must overwrite that slot — otherwise
  // the shader reads last frame's csmControl=1.0 and samples stale
  // cascade VPs.
  if (!hasShadow && !hasCsm) {
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
  const shaderInfo = selectWebGPUShader(firstGeometry.attributes);
  const vertexLayout = getVertexLayoutForShader(shaderInfo.type);

  const shaderChanged = cache.shaderType !== shaderInfo.type;
  const translucentChanged = cache.translucent !== translucent;
  // DP-H17 — treat a twoPasses flip like a shader / translucent flip
  // so the back-face + front-face pipeline variants get rebuilt.
  const twoPassesChanged = cache.twoPasses !== twoPasses;
  const needsTexture = isTexturedShader(shaderInfo.type);
  const isLit = isPhongShader(shaderInfo.type);
  const cameraBufferSize = isLit ? LIT_CAMERA_BYTES : FLAT_CAMERA_BYTES;

  if (shaderChanged || translucentChanged || twoPassesChanged) {
    cache.shaderType = shaderInfo.type;
    cache.translucent = translucent;

    // DP-H19-SHADER-DECODE (Batch 27) — always route through the
    // preprocessor so `//>>ifdef COMPRESSED_VERTICES` / `//>>else`
    // blocks in material shaders resolve to concrete WGSL. `defines=0`
    // produces the historical code path (the `//>>else` branch carries
    // the original VertexInput + logic), so this is a no-op for
    // uncompressed-path shaders. The compressed opt-in flips the bit
    // in a follow-up wire-up step that also swaps the vertex buffer
    // packer to emit `compressedAttributes` directly.
    const shaderDefines = 0;
    const processedCode = preprocessShaderSource(
      shaderInfo.code,
      shaderDefines,
    );
    cache.shaderModule = WebGPUShaderModule.create({
      device: device,
      code: processedCode,
      label: `${shaderInfo.type} Shader`,
    });

    // Camera BGL — group(0): camera uniforms
    const cameraVisibility = isLit
      ? GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
      : GPUShaderStage.VERTEX;

    cache.cameraBindGroupLayout = makeBindGroupLayout(device, "Camera BGL", [
      uniformBuffer(0, cameraVisibility),
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

    const canvasFormat =
      context.presentationFormat || navigator.gpu.getPreferredCanvasFormat();
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
          targets: [makeFragmentTarget(canvasFormat, translucent)],
        },
        primitive: {
          topology: "triangle-list",
          cullMode,
          frontFace: "ccw",
        },
        depthStencil: {
          format: "depth24plus-stencil8",
          depthWriteEnabled: !translucent,
          depthCompare: "less-equal",
        },
      });
    cache.pipeline = makePipeline("none", "Primitive pipeline (noCull)");
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
        primitive: { topology: "triangle-list", cullMode: "none" },
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
 * @returns {{primary: string, secondary?: string}}
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
) {
  if (
    cache.shaderType === shaderInfo.type &&
    cache.translucent === translucent
  ) {
    return false;
  }
  cache.shaderType = shaderInfo.type;
  cache.translucent = translucent;

  cache.shaderModule = WebGPUShaderModule.create({
    device: device,
    code: preprocessShaderSource(shaderInfo.code, 0),
    label: `${shaderInfo.type} Material Shader`,
  });

  // Camera BGL — group(0)
  const matCameraVisibility = isLit ? Stage.VERTEX_FRAGMENT : Stage.VERTEX;
  cache.cameraBindGroupLayout = makeBindGroupLayout(device, "Mat Camera BGL", [
    uniformBuffer(0, matCameraVisibility),
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

  const canvasFormat =
    context.presentationFormat || navigator.gpu.getPreferredCanvasFormat();
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
      targets: [makeFragmentTarget(canvasFormat, translucent)],
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

  const shaderChanged = createMaterialPipelineAndCache(
    cache,
    device,
    shaderInfo,
    vertexLayout,
    context,
    isLit,
    translucent,
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

    // Pick camera BGL — group(0)
    cache.pickCameraBindGroupLayout = makeBindGroupLayout(
      device,
      "MatPick Camera BGL",
      [uniformBuffer(0, Stage.VERTEX)],
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
      primitive: { topology: "triangle-list", cullMode: "none" },
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
const scratchMaterialCameraData = new Float32Array(64);

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
};
