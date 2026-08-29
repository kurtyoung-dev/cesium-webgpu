/**
 * WebGPU command creation and per-frame uniform update logic for the Primitive
 * rendering pipeline. Extracted from Primitive.js for better organization and
 * maintainability.
 *
 * Contains:
 * - createWebGPUCommands() — builds GPU pipelines, buffers, bind groups, and draw commands
 * - updateWebGPUCommandUniforms() — per-frame camera matrix updates for GPU uniform buffers
 *
 * Rendering uses RTE (Relative-To-Eye) emulated 64-bit precision:
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
import DeveloperError from "../../Core/DeveloperError.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import GeometryAttribute from "../../Core/GeometryAttribute.js";
import Matrix3 from "../../Core/Matrix3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Pass from "../Pass.js";
import PrimitiveType from "../../Core/PrimitiveType.js";
import SceneMode from "../../Scene/SceneMode.js";
import ShadowMode from "../../Scene/ShadowMode.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import type { WebGPUCommandOwner } from "./WebGPUDrawCommand.js";
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
import {
  isWebGPULogDepthActive,
  isWebGPUPickLogDepthActive,
} from "./WebGPULogDepth.js";
import {
  createMaterialUploadState,
  uploadMaterialUniformBuffer,
} from "./WebGPUMaterialUploadState.js";
import {
  getEffectsBindGroupLayout,
  getPlaceholderEffects,
  createEffectsBindGroup,
} from "./WebGPUEffectsBindGroup.js";
// Forward+ clustered-lighting fragment chunk with a substitutable group token.
// Lit material shaders declare
// cluster bindings (18-22) at whichever group their effects BGL occupies
// (2 = no texture, 3 = textured) and gain evalClusteredLights().
import ClusteredLightingChunk from "../../Shaders/WebGPU/chunks/structs/ClusteredLighting.js";
import { substituteClusteredLightingGroup } from "./WebGPUClusteredLightingBGL.js";
// The depth-fail appearance uses a flat RTE twin whose fragment stage returns
// the per-instance depth-fail color. Paired with a
// depthCompare:'greater' / depthWriteEnabled:false pipeline in
// createWebGPUCommands so it shades only fragments that fail the normal depth
// test. Mirrors the WebGL twin in PrimitiveCommandHelpers.js.
import PrimitiveDepthFailColorSource from "../../Shaders/WebGPU/Primitive/PrimitiveDepthFailColor.js";
// Scene-framebuffer targets are built centrally so primitive pipelines match the
// active render-pass topology. Centralizing slot zero, normal-roughness, blend,
// and write-mask options keeps descriptors and cache keys consistent.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import {
  renderStateToBlendState,
  type CesiumRenderStateLike,
} from "./RenderStateToPipelineVariant.js";
import { writeNormalizedInverseViewQuaternion } from "./WebGPUPrimitiveCameraQuaternion.js";
import {
  configurePrimitiveShadowCastCommand,
  updatePrimitiveShadowCastCommand,
} from "./WebGPUPrimitiveShadowCast.js";
import type { PrimitiveShadowCastHost } from "./WebGPUPrimitiveShadowCast.js";

// ─── JS-interop type façades (type-only; erase at compile) ──────────────────
// Minimal structural shapes over the untyped-JS objects this module consumes
// (Primitive / Appearance / Material / Geometry) plus the per-primitive GPU
// resource caches it owns. They carry no runtime code — the TS conversion emits
// byte-identical JavaScript. `declare global` augmentations add the WebGPU-only
// fields the ambient CesiumFrameState / CesiumUniformState / CesiumGraphicsContext
// interfaces (cesium-js-types.d.ts) don't yet expose.

type NumArray =
  | Float32Array
  | Float64Array
  | Uint32Array
  | Uint16Array
  | Uint8Array
  | Int32Array
  | Int16Array
  | Int8Array
  | number[];

type BufferLike = GPUBuffer | WebGPUBuffer;
type IndexFormatLike = "uint16" | "uint32";

interface AttributeLike {
  values?: NumArray;
  componentsPerAttribute?: number;
  componentDatatype?: GeometryAttribute["componentDatatype"];
  normalize?: boolean;
}

const FLOAT_COMPONENT_DATATYPE =
  ComponentDatatype.FLOAT as unknown as GeometryAttribute["componentDatatype"];

interface GeometryAttributesLike {
  position?: AttributeLike;
  position3DHigh?: AttributeLike;
  position3DLow?: AttributeLike;
  position2DHigh?: AttributeLike;
  position2DLow?: AttributeLike;
  normal?: AttributeLike;
  st?: AttributeLike;
  tangent?: AttributeLike;
  bitangent?: AttributeLike;
  color?: AttributeLike;
  batchId?: AttributeLike;
  compressedAttributes?: AttributeLike;
  expandAndWidth?: AttributeLike;
  prevPosition3DHigh?: AttributeLike;
  prevPosition3DLow?: AttributeLike;
  nextPosition3DHigh?: AttributeLike;
  nextPosition3DLow?: AttributeLike;
  prevPosition2DHigh?: AttributeLike;
  prevPosition2DLow?: AttributeLike;
  nextPosition2DHigh?: AttributeLike;
  nextPosition2DLow?: AttributeLike;
  [key: string]: AttributeLike | undefined;
}

interface CompressedAttributesMeta {
  hasSt?: boolean;
  hasNormal?: boolean;
  hasTangent?: boolean;
  hasBitangent?: boolean;
  isExtrude?: boolean;
}

interface GeometryLike {
  attributes?: GeometryAttributesLike;
  indices?: NumArray;
  primitiveType?: number;
  _compressedAttributesMeta?: CompressedAttributesMeta;
}

interface AttributePresenceHint {
  hasSt?: boolean;
  hasNormal?: boolean;
  hasTangent?: boolean;
  hasBitangent?: boolean;
}

interface RTEMatrices {
  mvpRTE: Matrix4;
  modelViewRTE: Matrix4;
  modelView: Matrix4;
  camHigh: Cartesian3;
  camLow: Cartesian3;
  modelMatrix3: Matrix3;
  camWorldHigh: Cartesian3;
  camWorldLow: Cartesian3;
}

interface ShaderInfoLike {
  type: string;
  code: string;
  needsTexture?: boolean;
}

interface ShaderModuleLike {
  module: GPUShaderModule;
}

interface VertexLayoutLike {
  floatsPerVertex?: number;
  stride?: number;
  layout: GPUVertexBufferLayout;
}

interface MaterialUniformsLike {
  repeat?: { x?: number | boolean; y?: number | boolean };
  [key: string]: unknown;
}

interface MaterialUniformBufferLike {
  isDirty?: boolean;
  gpuData?: ArrayBufferView;
  version?: number;
  clearDirty?(): void;
}

interface MaterialUploadStateLike {
  source: object | undefined;
  version: number | undefined;
  initialized: boolean;
}

interface MaterialLike {
  _imageSources?: { [key: string]: unknown };
  _uniformBuffer?: MaterialUniformBufferLike;
  uniforms?: MaterialUniformsLike;
}

interface AppearanceVertexFormatLike {
  st?: boolean;
  normal?: boolean;
  tangent?: boolean;
  bitangent?: boolean;
  position?: boolean;
  [key: string]: boolean | undefined;
}

interface ColorLike {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

// Per-instance BatchTable attribute values are either a Color (red/green/
// blue/alpha) or a packed Cartesian (x/y/z/w) depending on the source; the
// reader sniffs which shape it got.
interface BatchedAttributeValue {
  red?: number;
  green?: number;
  blue?: number;
  alpha?: number;
  x?: number;
  y?: number;
  z?: number;
  w?: number;
}

interface BatchTableLike {
  getBatchedAttribute(
    instanceIndex: number,
    attributeIndex: number,
    result?: unknown,
  ): BatchedAttributeValue | undefined;
}

interface AppearanceLike {
  flat?: boolean;
  closed?: boolean;
  renderState?: CesiumRenderStateLike;
  vertexFormat?: AppearanceVertexFormatLike;
  material?: MaterialLike;
}

interface PrimitiveLike {
  appearance?: AppearanceLike;
  modelMatrix?: Matrix4;
  shadows?: number;
  _geometries?: GeometryLike[];
  _webgpuGeometryData?: GeometryLike[];
  _numberOfInstances?: number;
  _allowPicking?: boolean;
  _pickIds?: Array<{ color?: ColorLike }>;
  _batchTable?: BatchTableLike;
  _batchTableAttributeIndices?: {
    color?: number;
    depthFailColor?: number;
  };
  _depthFailAppearance?: AppearanceLike;
  _depthFailMaterial?: MaterialLike;
  _webgpuCache?: CacheLike;
  _webgpuPolylineCache?: CacheLike;
  _webgpuPolylineMatCache?: CacheLike;
}

// Per-primitive GPU resource cache. Declared fields are read with concrete
// types; the `[key: string]: unknown` index signature absorbs the many
// write-only literal fields plus the dynamic `cache[k.<slot>]` accesses in
// ensureMaterialTextureBindGroup (which cast at the member-access sites).
interface CacheLike extends PrimitiveShadowCastHost {
  shaderType?: string;
  shaderModule?: ShaderModuleLike;
  pipeline?: GPURenderPipeline;
  pipelineFrontCull?: GPURenderPipeline;
  pipelineBackCull?: GPURenderPipeline;
  // Weighted-blended OIT inputs for translucent primitives. Cached per pipeline
  // build and attached to each
  // Pass.TRANSLUCENT color command via `_shaderCode` + `_pipelineConfig` so
  // `executeTranslucentPass` auto-builds the MRT accumulation variant when the
  // OIT switch is enabled. These fields are deliberately dormant when OIT is
  // disabled. `oitShaderCode` omits log-depth output because accumulation uses
  // read-only depth. `oitPipelineLayout` is the shared base layout, keeping
  // existing bind groups compatible.
  oitPipelineLayout?: GPUPipelineLayout;
  oitShaderCode?: string;
  oitDefaultCullMode?: GPUCullMode;
  translucent?: boolean;
  // Serialized form of the color blend the material pipeline was built with,
  // so an appearance that changes its blending rebuilds instead of serving a
  // pipeline whose blend is baked from the previous state.
  materialBlendKey?: string;
  dfMaterialBlendKey?: string;
  twoPasses?: boolean;
  primitiveTopology?: string;
  appearanceClosed?: boolean;
  logDepthEnabled?: boolean;
  pipelineFormatGeneration?: number;
  cameraBindGroupLayout?: GPUBindGroupLayout;
  cameraBindGroups?: GPUBindGroup[];
  cameraBuffers?: GPUBuffer[];
  materialBindGroupLayout?: GPUBindGroupLayout;
  materialBindGroup?: GPUBindGroup;
  materialBuffer?: GPUBuffer;
  materialUploadState?: MaterialUploadStateLike;
  _materialBufferSize?: number;
  effectsBGL?: GPUBindGroupLayout;
  textureBindGroup?: GPUBindGroup;
  textureBindGroupLayout?: GPUBindGroupLayout;
  defaultTexture?: WebGPUTexture;
  defaultSampler?: GPUSampler;
  vertexBuffers?: BufferLike[];
  vertexCounts?: number[];
  indexBuffers?: BufferLike[];
  indexCounts?: number[];
  indexFormats?: IndexFormatLike[];
  pickShaderModule?: ShaderModuleLike;
  pickPipeline?: GPURenderPipeline;
  // Log-depth state baked into the cached pick pipeline. It is separate from
  // scene log depth because the shared pick framebuffer switches as one fleet;
  // a state change rebuilds the pick pipeline with the matching module.
  pickLogDepthEnabled?: boolean;
  pickCameraBindGroupLayout?: GPUBindGroupLayout;
  pickCameraBindGroups?: GPUBindGroup[];
  pickCameraBuffers?: GPUBuffer[];
  pickMaterialBindGroupLayout?: GPUBindGroupLayout;
  pickMaterialBindGroups?: GPUBindGroup[];
  pickMaterialBuffers?: GPUBuffer[];
  depthFailShaderModule?: ShaderModuleLike;
  depthFailPipeline?: GPURenderPipeline;
  depthFailMaterialBindGroups?: GPUBindGroup[];
  depthFailMaterialBuffers?: GPUBuffer[];
  dfShaderModule?: ShaderModuleLike;
  dfShaderType?: string;
  dfPipeline?: GPURenderPipeline;
  dfTranslucent?: boolean;
  dfPrimitiveTopology?: string;
  dfLogDepthEnabled?: boolean;
  dfPipelineFormatGeneration?: number;
  dfCullMode?: GPUCullMode;
  dfIsLit?: boolean;
  dfNeedsTexture?: boolean;
  dfEffectsBGL?: GPUBindGroupLayout;
  dfCameraBindGroupLayout?: GPUBindGroupLayout;
  dfCameraBindGroups?: GPUBindGroup[];
  dfCameraBuffers?: GPUBuffer[];
  dfMaterialBindGroup?: GPUBindGroup;
  dfMaterialBindGroupLayout?: GPUBindGroupLayout;
  dfMaterialBuffer?: GPUBuffer;
  dfMaterialUploadState?: MaterialUploadStateLike;
  _dfMaterialBufferSize?: number;
  dfTextureBindGroup?: GPUBindGroup;
  dfTextureBindGroupLayout?: GPUBindGroupLayout;
  dfVertexBuffers?: BufferLike[];
  [key: string]: unknown;
}

// The renderer attaches these extras to each WebGPUDrawCommand instance.
type PrimitiveDrawCommand = WebGPUDrawCommand & {
  _webgpuCameraBuffer?: GPUBuffer;
  _webgpuShaderType?: string;
  _isPolylineAppearance?: boolean;
  _label?: string;
  vertexStride?: number;
  _noEffectsSlot?: boolean;
  _webgpuMatCache?: CacheLike;
  _webgpuMaterial?: MaterialLike;
  _webgpuMatShaderType?: string;
  _webgpuMatTextureSlot?: number;
  _webgpuMatTextureIsDepthFail?: boolean;
  _webgpuMaterialBuffer?: GPUBuffer;
  _webgpuMaterialUB?: MaterialUniformBufferLike;
  _webgpuMaterialUploadState?: MaterialUploadStateLike;
  _shadowCastLayout?: string;
  _shadowCastPrimitiveUB?: WebGPUBuffer;
  _shadowCastBindGroupCacheHost?: object;
  _primitiveShadowCastHost?: PrimitiveShadowCastHost;
  _webgpuPickColor?: unknown;
  _isPickCommand?: boolean;
};

// Minimal shapes for the WebGPU-context sidecars this module reads. The d.ts
// types `csmRenderer` / `performanceManager` opaquely ("cast at the call
// site"); these interfaces narrow them at the two read sites.
interface CsmRendererLike {
  enabled?: boolean;
  cascadeParamsBuffer?: GPUBuffer;
  cascadeArrayView?: GPUTextureView;
  pcfRadius?: number;
}

interface AtmosphereLUTResources {
  transmittanceView?: GPUTextureView;
  inscatterView?: GPUTextureView;
}

interface PerformanceManagerLike {
  ensureAtmosphereLUTResources?(device: GPUDevice): AtmosphereLUTResources;
}

interface CreatedTextureLike {
  view?: GPUTextureView;
  destroy(): void;
}

declare global {
  interface CesiumFrameState {
    useHDR?: boolean;
  }
  interface CesiumUniformState {
    gamma?: number;
    inverseViewRotation?: Matrix3;
    viewportOrthographic?: CesiumMatrix4;
    readonly ellipsoid?: {
      readonly oneOverRadii: Cartesian3;
    };
  }
  interface CesiumGraphicsContext {
    readonly scenePipelineFormat?: GPUTextureFormat;
    _scenePipelineFormatGeneration?: number;
    _clusteredLightingActive?: boolean;
    _clusteredLightingBuffers?: unknown;
    _primitiveEffectsBG?: GPUBindGroup | null;
    _primitiveEffectsBGFrameNumber?: number;
    _primitiveEffectsBGToggleHash?: number;
    enqueueShadowReceiveUniformRefresh?(
      uniformBuffer: GPUBuffer,
      shadowMap: object,
    ): void;
    performanceManager?: PerformanceManagerLike | null;
    createTextureFromImage?(
      source: unknown,
      format: GPUTextureFormat,
      flipY: boolean,
    ): CreatedTextureLike | undefined | null;
  }
}

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
const scratchModelMatrix3 = new Matrix3();
const scratchEncodedCameraWorld = new EncodedCartesian3();
// Scratch for encoding a single vertex position
const scratchEncodedPosition = new EncodedCartesian3();

// Camera-only UBO sizes, without material fields. Every layout carries a
// previous-view-projection matrix for motion-vector reprojection. The flat
// variant adds a 16-byte log-depth tail followed by the elevation-material
// world-position tail, so
// the Flat material shaders (PrimitiveMat*Flat) and the unlit Basic shaders
// can read `camera.logDepth` from their `//>>ifdef LOG_DEPTH` blocks. Packed
// unconditionally by writeRTEUniformsFlat and remains inert until the log-depth
// define is set. Only elevation materials declare the appended fields;
// other layouts leave the appended bytes unread.
const FLAT_CAMERA_BYTES = 288; // 192-byte flat head + modelMatrix3 columns(48) + world camera high/low(32) + pixel-ratio tail(16)
const FLAT_ELLIPSOID_ONE_OVER_RADII_OFFSET = 44;
const FLAT_MODEL_MATRIX_COLUMN_0_OFFSET = 48;
const FLAT_ENCODED_CAMERA_WORLD_HIGH_OFFSET = 60;
const FLAT_ENCODED_CAMERA_WORLD_LOW_OFFSET = 64;
const FLAT_PIXEL_RATIO_OFFSET = 68;
// Lit variants append an always-present normalized inverse-view quaternion
// after prevVP, followed by the 16-byte logDepth vec4 tail (near, far, factor,
// reserved), followed by the elevation-material world-position tail. The quaternion rotates eye-space
// positions back into world-axis camera-relative space for shadow and
// atmosphere effects without carrying a full matrix. Log depth is read only by the
// `//>>ifdef LOG_DEPTH` blocks in PrimitivePhongColor / PrimitivePhongTexturedColor
// and other lit producers. The tail is packed unconditionally by
// writeRTEUniformsLit; fields that a shader does not declare remain unread.
const LIT_CAMERA_BYTES = 448; // 352-byte lit head + modelMatrix3 columns(48) + world camera high/low(32) + pixel-ratio tail(16)
const LIT_PREVIOUS_VIEW_PROJECTION_OFFSET = 60;
const LIT_INVERSE_VIEW_QUATERNION_OFFSET = 76;
const LIT_LOG_DEPTH_OFFSET = 80;
const LIT_ELLIPSOID_ONE_OVER_RADII_OFFSET = 84;
const LIT_MODEL_MATRIX_COLUMN_0_OFFSET = 88;
const LIT_ENCODED_CAMERA_WORLD_HIGH_OFFSET = 100;
const LIT_ENCODED_CAMERA_WORLD_LOW_OFFSET = 104;
const LIT_PIXEL_RATIO_OFFSET = 108;
// The 176-byte pick layout includes floats 40-43 for the flat log-depth tail.
// Both GPU storage and scratch data derive from this constant, so the tail
// cannot fall outside a shorter allocation. Hyperbolic pick shaders leave it
// unread, matching the flat color layout.
const PICK_CAMERA_BYTES = 176; // FLAT head (160) + logDepth vec4 tail (16)

// RTE camera uniform scratch data follows the largest camera-only layout.
const scratchRTEUniformData = new Float32Array(
  LIT_CAMERA_BYTES / Float32Array.BYTES_PER_ELEMENT,
);

// The polyline-appearance camera buffer extends the flat RTE head with the
// matrices needed for screen-space width expansion. Layout
// (floats, byte-locked to CameraUniforms in PolylineColorAppearance.wgsl):
//   0-15  mvpRelativeToEye        (the vertex shader uses the ortho path)
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
// CPU decoding of `compressedAttributes`
// =========================================================================
//
// `GeometryPipeline.compressVertices()` replaces normal, texture-coordinate,
// tangent, and bitangent attributes with `compressedAttributes`. Primitive
// shaders consume unpacked attributes, so this path reconstructs Float32Array
// attributes on the CPU. It restores correctness but forfeits compressed vertex
// memory and bandwidth savings. Direct WGSL decoding has retained rollout
// scaffolding, but runtime packed-buffer emission and general shader
// coverage remain unfinished.
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
// `geometry._compressedAttributesMeta` (written by
// `GeometryPipeline.compressVertices` right before it starts encoding)
// to know which attributes were present so the decode is unambiguous.
// Without metadata, a validated appearance hint is preferred; guarded layout
// inference is the final fallback and emits one warning.
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
 * Per-vertex slot count that `GeometryPipeline.compressVertices` produces for a
 * given set of source attributes. Mirrors its `numCompressedComponents` formula
 * exactly: `(hasSt && hasNormal ? 2 : 1) + (hasTangent || hasBitangent ? 1 : 0)`.
 * This gates the appearance-vertexFormat hint in `ensureUncompressedAttributes`
 * so the hint is trusted only when it is fully consistent with the actual
 * compressed buffer width.
 * @private
 */
function expectedCompressedSlots(hint: AttributePresenceHint) {
  const hasSt = hint.hasSt === true;
  const hasNormal = hint.hasNormal === true;
  const hasTangent = hint.hasTangent === true;
  const hasBitangent = hint.hasBitangent === true;
  if (!hasSt && !hasNormal && !hasTangent && !hasBitangent) {
    return 0;
  }
  return (hasSt && hasNormal ? 2 : 1) + (hasTangent || hasBitangent ? 1 : 0);
}

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
 * @param {object} [attributeHint] Authoritative attribute-presence hint,
 *   normally sourced from the consuming appearance's `vertexFormat`
 *   (`{ hasSt, hasNormal, hasTangent, hasBitangent }`). When the geometry
 *   carries no `_compressedAttributesMeta`, because combination and worker
 *   transfer can lose it. A matching `vertexFormat` prevents packed texture
 *   coordinates in the oct-normal numeric range from being mistaken for
 *   normals. The hint is used only when its slot count matches
 *   `componentsPerAttribute`; otherwise guarded inference remains the fallback.
 * @private
 */
function ensureUncompressedAttributes(
  geometry: GeometryLike,
  attributeHint?: AttributePresenceHint,
) {
  const attrs = geometry.attributes;
  if (!defined(attrs)) {
    return;
  }

  const compressed = attrs.compressedAttributes;
  if (!defined(compressed) || !defined(compressed.values)) {
    return;
  }

  // Reconstructed normal or texture coordinates are the idempotence guard.
  // Tangent and bitangent are written by the same decode pass when present.
  if (defined(attrs.normal) || defined(attrs.st)) {
    return;
  }

  const values = compressed.values;
  const componentsPerAttribute = compressed.componentsPerAttribute || 1;
  const numVertices = Math.floor(values.length / componentsPerAttribute);
  if (numVertices === 0) {
    return;
  }

  // Prefer compression metadata because it identifies the packed source
  // attributes exactly. Otherwise use a validated appearance hint or guarded
  // magnitude inference and emit one warning.
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
  } else if (
    defined(attributeHint) &&
    expectedCompressedSlots(attributeHint) === componentsPerAttribute
  ) {
    // A matching appearance `vertexFormat` is authoritative because
    // metadata can disappear when `Primitive.combineInstances` builds the
    // combined geometry or during worker transfer. Magnitude inference can
    // otherwise mistake packed texture coordinates for a normal and drop `st`.
    // On a slot-count mismatch, use the guarded inference instead.
    hasNormal = attributeHint.hasNormal === true;
    hasSt = attributeHint.hasSt === true;
    hasTangent = attributeHint.hasTangent === true;
    hasBitangent = attributeHint.hasBitangent === true;
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
        // Two slots normally use [st, normal], but tolerate the inverted
        // ordering produced by some inputs by sniffing both
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
  // three into 2 slots; it only fires when all three are present.
  const usesOctPack = hasNormal && hasTangent && hasBitangent;

  const outNormal = hasNormal ? new Float32Array(numVertices * 3) : null;
  const outST = hasSt ? new Float32Array(numVertices * 2) : null;
  // Reconstruct tangent and bitangent in the same CPU pass when present. No
  // active material shader reads them yet, but retaining them is intentional
  // infrastructure for normal-mapped materials and avoids a second decode.
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
      // `octUnpack` already decoded tangent and bitangent into the scratch
      // Cartesians; write them directly.
      outTangent[v * 3] = scratchDecompressedTangent.x;
      outTangent[v * 3 + 1] = scratchDecompressedTangent.y;
      outTangent[v * 3 + 2] = scratchDecompressedTangent.z;
      outBitangent[v * 3] = scratchDecompressedBitangent.x;
      outBitangent[v * 3 + 1] = scratchDecompressedBitangent.y;
      outBitangent[v * 3 + 2] = scratchDecompressedBitangent.z;
    } else {
      if (hasNormal) {
        // Some geometry pipelines drop the metadata across worker boundaries,
        // and fallback inference can pick the wrong attribute (st vs normal) for
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
      // Standalone tangent and bitangent slots each contain one packed float
      // and are decoded independently.
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
      componentDatatype: FLOAT_COMPONENT_DATATYPE,
      componentsPerAttribute: 3,
      values: outNormal,
    });
  }
  if (outST) {
    geometry.attributes.st = new GeometryAttribute({
      componentDatatype: FLOAT_COMPONENT_DATATYPE,
      componentsPerAttribute: 2,
      values: outST,
    });
  }
  if (outTangent) {
    geometry.attributes.tangent = new GeometryAttribute({
      componentDatatype: FLOAT_COMPONENT_DATATYPE,
      componentsPerAttribute: 3,
      values: outTangent,
    });
  }
  if (outBitangent) {
    geometry.attributes.bitangent = new GeometryAttribute({
      componentDatatype: FLOAT_COMPONENT_DATATYPE,
      componentsPerAttribute: 3,
      values: outBitangent,
    });
  }
}

// =========================================================================
// Pipeline color-target builder — opaque vs translucent blend state
// =========================================================================

// All scene-framebuffer target descriptors route through `makeSceneFBTargets`,
// keeping target count and slot shape aligned with the render pass.

// =========================================================================
// Shared Position Extraction — RTE (positionHigh + positionLow)
// =========================================================================

/**
 * Extracts position data from geometry attributes as positionHigh/positionLow
 * pairs for RTE (Relative-To-Eye) rendering. This preserves planetary-scale
 * precision — never use single float32 positions for world-space geometry.
 *
 * For geometry with position3DHigh/Low: uses the raw high/low arrays directly.
 * For geometry with only single position: encodes via EncodedCartesian3.
 *
 * @param {object} geometry - Geometry with attributes
 * @returns {null|{posHighValues: Float32Array, posLowValues: Float32Array, numVertices: number}}
 * @private
 */
function extractPositionData(geometry: GeometryLike) {
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
 * Maps a Cesium `PrimitiveType` to WebGPU topology. `TRIANGLE_FAN` has no
 * WebGPU equivalent and falls back to `triangle-list`, which is approximate.
 * Pipeline topology must match the vertex and index topology; interpreting
 * outline line buffers as triangles produces missing or corrupt geometry.
 * @private
 */
function mapCesiumPrimitiveTypeToWebGPU(primitiveType: number) {
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
      // WebGPU does not support triangle-fan. The caller should convert it to
      // triangle-list while extracting geometry. This fallback avoids a
      // validation error but produces the wrong topology.
      return "triangle-list";
    default:
      return "triangle-list";
  }
}

/**
 * Helper: creates or reuses an index buffer for a geometry.
 * @private
 */
function ensureIndexBuffer(
  device: GPUDevice,
  geometry: GeometryLike,
  cache: CacheLike,
  i: number,
) {
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
 * Computes RTE matrices, the model linear transform, and encoded camera
 * positions for a given model matrix.
 * @private
 */
function computeRTEMatrices(
  uniformState: CesiumUniformState,
  camera: CesiumCamera,
  modelMatrix: Matrix4,
): RTEMatrices {
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
  Matrix4.getMatrix3(modelMatrix, scratchModelMatrix3);
  EncodedCartesian3.fromCartesian(camera.positionWC, scratchEncodedCameraWorld);

  return {
    mvpRTE: scratchMVPRTE,
    modelViewRTE: scratchModelViewRTE,
    modelView: modelView,
    camHigh: scratchEncodedCamera.high,
    camLow: scratchEncodedCamera.low,
    modelMatrix3: scratchModelMatrix3,
    camWorldHigh: scratchEncodedCameraWorld.high,
    camWorldLow: scratchEncodedCameraWorld.low,
  };
}

/**
 * Per-frame `time` value for shaders that animate (currently just Water).
 * Mirrors the GLSL `czm_frameNumber` semantic so the WGSL port
 * matches the wave phase behavior of the WebGL path. Defaults to 0 when
 * UniformState hasn't been seeded yet (first frame).
 * @private
 */
function getFrameTime(uniformState: CesiumUniformState) {
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
 * Returns the HDR sRGB-to-linear decode gamma for per-instance basic and Phong
 * color shaders. Uses `uniformState.gamma`
 * default 2.2) when `scene.highDynamicRange` is on (`frameState.useHDR`), else
 * 0.0. Packed into the flat/lit CameraUniforms `_pad0`/`hdrGamma` lane (flat
 * float 19, lit float 51). The fragment shader mirrors WebGL's
 * PerInstanceColorAppearanceFS `czm_gammaCorrect(v_color)` (`#ifdef HDR`) when
 * this is greater than 0.5. Returns zero on the SDR path.
 * @private
 */
function getHdrGammaLane(uniformState: CesiumUniformState) {
  const fs = defined(uniformState) ? uniformState.frameState : undefined;
  if (defined(fs) && fs.useHDR === true) {
    return typeof uniformState.gamma === "number" ? uniformState.gamma : 2.2;
  }
  return 0.0;
}

/**
 * Verifies that a camera-uniform destination can hold the selected layout.
 * @private
 */
function assertUniformDataCapacity(
  ud: Float32Array,
  requiredBytes: number,
  writerName: string,
) {
  //>>includeStart('debug', pragmas.debug);
  const requiredFloats = requiredBytes / Float32Array.BYTES_PER_ELEMENT;
  if (ud.length < requiredFloats) {
    throw new DeveloperError(
      `${writerName} requires ${requiredFloats} floats; received ${ud.length}.`,
    );
  }
  //>>includeEnd('debug');
}

/**
 * Writes the shared flat RTE head used by pick shaders.
 * Layout: mvpRTE(16) + camHigh(4) + camLow(4) + prevVP(16) +
 * logDepth(4) = 44 floats = 176 bytes.
 * @private
 */
function writeRTEUniformsFlatHead(
  ud: Float32Array,
  rte: RTEMatrices,
  uniformState: CesiumUniformState,
) {
  assertUniformDataCapacity(ud, PICK_CAMERA_BYTES, "writeRTEUniformsFlatHead");
  Matrix4.pack(rte.mvpRTE, ud, 0);
  ud[16] = rte.camHigh.x;
  ud[17] = rte.camHigh.y;
  ud[18] = rte.camHigh.z;
  // Float 19 = CameraUniforms `_pad0`/`hdrGamma` (after camHigh). Carries the
  // HDR sRGB→linear decode gate for the basic per-instance-color FS. 0 on the
  // default SDR path → byte-identical.
  ud[19] = getHdrGammaLane(uniformState);
  ud[20] = rte.camLow.x;
  ud[21] = rte.camLow.y;
  ud[22] = rte.camLow.z;
  // Float 23 is natural vec3 padding after camLow; Water Flat repurposes
  // it as `time` (frame counter) so its animated wave pattern can advance.
  // Other Flat shaders declare `_pad1: f32` here and ignore the value, so
  // the write is harmless for them.
  ud[23] = getFrameTime(uniformState);
  writePreviousViewProjection(ud, 24, uniformState);
  // The log-depth tail occupies floats 40-43 after the previous view-projection
  // matrix. Inert until the LOG_DEPTH define is set on the flat/basic pipeline.
  writeLogDepthTail(ud, 40, uniformState);
}

/**
 * Writes the complete flat camera layout, including elevation-material world
 * reconstruction data.
 * @private
 */
function writeRTEUniformsFlat(
  ud: Float32Array,
  rte: RTEMatrices,
  uniformState: CesiumUniformState,
) {
  assertUniformDataCapacity(ud, FLAT_CAMERA_BYTES, "writeRTEUniformsFlat");
  writeRTEUniformsFlatHead(ud, rte, uniformState);
  writeEllipsoidOneOverRadiiTail(
    ud,
    FLAT_ELLIPSOID_ONE_OVER_RADII_OFFSET,
    uniformState,
  );
  writeModelToWorldPositionTail(
    ud,
    FLAT_MODEL_MATRIX_COLUMN_0_OFFSET,
    FLAT_ENCODED_CAMERA_WORLD_HIGH_OFFSET,
    FLAT_ENCODED_CAMERA_WORLD_LOW_OFFSET,
    rte,
  );
  writePixelRatioTail(ud, FLAT_PIXEL_RATIO_OFFSET, uniformState);
}

/**
 * Writes the renderer-wide log-depth tail (vec4: near, far, factor, reserved)
 * starting at float index `offset`. Mirrors WebGPUGlobeSurfaceCameraUB's
 * tail. Safe to call unconditionally because it fills otherwise unread
 * floats and is inert until the log-depth define is set and the shader's
 * `logDepth` field reads it. See WebGPULogDepth.ts.
 *
 * Prefer the frame-stable `_logDepthEncodeNearFar` range and its paired
 * factor. `currentFrustum` is re-sliced by opaque, translucent, and pick
 * loops, so using the live pair would make primitive depth encoding depend
 * on command timing. The live frustum is only the pre-publication fallback.
 * All primitive camera writers use this helper so their curve matches the
 * globe and other producers. Sibling producers
 * `WebGPUBillboardRenderer.packUniforms`, `WebGPUPointPrimitiveRenderer`, and
 * `WebGPUDepthPlane.update` use the same frame-stable stash-first pattern.
 * @private
 */
function writeLogDepthTail(
  ud: Float32Array,
  offset: number,
  uniformState: CesiumUniformState,
) {
  const usLog = uniformState;
  const frustum =
    defined(usLog) && defined(usLog.currentFrustum)
      ? usLog.currentFrustum
      : undefined;
  let near = defined(frustum) ? frustum.x : 0.0;
  let far = defined(frustum) ? frustum.y : 0.0;
  let factor =
    defined(usLog) &&
    typeof usLog.oneOverLog2FarDepthFromNearPlusOne === "number"
      ? usLog.oneOverLog2FarDepthFromNearPlusOne
      : 0.0;
  const ldEncode = defined(usLog) ? usLog._logDepthEncodeNearFar : undefined;
  if (defined(ldEncode) && ldEncode[1] > ldEncode[0]) {
    near = ldEncode[0];
    far = ldEncode[1];
    const encodeFactor = usLog._logDepthEncodeFactor;
    if (
      typeof encodeFactor === "number" &&
      Number.isFinite(encodeFactor) &&
      encodeFactor > 0.0
    ) {
      factor = encodeFactor;
    } else {
      // Compatibility fallback for early frames and minimal test doubles that
      // publish a near/far pair without its factor.
      const log2Far = Math.log2(far - near + 1.0);
      factor = log2Far > 0.0 ? 1.0 / log2Far : 0.0;
    }
  } else if (!(factor > 0.0) && far > near) {
    const log2Far = Math.log2(far - near + 1.0);
    factor = log2Far > 0.0 ? 1.0 / log2Far : 0.0;
  }
  ud[offset + 0] = near;
  ud[offset + 1] = far;
  ud[offset + 2] = factor;
  ud[offset + 3] = 0.0; // reserved
}

/**
 * Writes inverse ellipsoid radii followed by an explicit supplied flag.
 * A zeroed or incomplete value selects the shader fallback instead of
 * describing a degenerate ellipsoid. Full-layout writers validate capacity
 * before reaching this tail; pick shaders use the separate flat-head writer.
 * @private
 */
function writeEllipsoidOneOverRadiiTail(
  ud: Float32Array,
  offset: number,
  uniformState: CesiumUniformState,
) {
  const ellipsoid = defined(uniformState) ? uniformState.ellipsoid : undefined;
  const oneOverRadii = defined(ellipsoid) ? ellipsoid.oneOverRadii : undefined;
  const supplied =
    defined(oneOverRadii) &&
    Number.isFinite(oneOverRadii.x) &&
    Number.isFinite(oneOverRadii.y) &&
    Number.isFinite(oneOverRadii.z) &&
    oneOverRadii.x > 0.0 &&
    oneOverRadii.y > 0.0 &&
    oneOverRadii.z > 0.0;

  ud[offset + 0] = supplied ? oneOverRadii.x : 0.0;
  ud[offset + 1] = supplied ? oneOverRadii.y : 0.0;
  ud[offset + 2] = supplied ? oneOverRadii.z : 0.0;
  ud[offset + 3] = supplied ? 1.0 : 0.0;
}

/**
 * Writes the affine model matrix's three linear columns and the encoded world
 * camera position. The linear part retains model scale, which is required when
 * transforming a model-space camera-relative vector into world space.
 * @private
 */
function writeModelToWorldPositionTail(
  ud: Float32Array,
  matrixOffset: number,
  cameraHighOffset: number,
  cameraLowOffset: number,
  rte: RTEMatrices,
) {
  // Matrix3 stores its nine elements in numeric index order but its type
  // declares no index signature; ArrayLike is the honest runtime shape.
  const matrix = rte.modelMatrix3 as unknown as ArrayLike<number>;
  for (let column = 0; column < 3; ++column) {
    const sourceOffset = column * 3;
    const destinationOffset = matrixOffset + column * 4;
    ud[destinationOffset + 0] = matrix[sourceOffset + 0];
    ud[destinationOffset + 1] = matrix[sourceOffset + 1];
    ud[destinationOffset + 2] = matrix[sourceOffset + 2];
    ud[destinationOffset + 3] = 0.0;
  }

  ud[cameraHighOffset + 0] = rte.camWorldHigh.x;
  ud[cameraHighOffset + 1] = rte.camWorldHigh.y;
  ud[cameraHighOffset + 2] = rte.camWorldHigh.z;
  ud[cameraHighOffset + 3] = 0.0;
  ud[cameraLowOffset + 0] = rte.camWorldLow.x;
  ud[cameraLowOffset + 1] = rte.camWorldLow.y;
  ud[cameraLowOffset + 2] = rte.camWorldLow.z;
  ud[cameraLowOffset + 3] = 0.0;
}

/**
 * Resolves the device pixel ratio the way `czm_pixelRatio` does for GLSL:
 * from `UniformState` when it carries one, otherwise from the frame state,
 * otherwise 1.0.
 * @private
 */
function resolvePixelRatio(uniformState: CesiumUniformState): number {
  if (defined(uniformState) && typeof uniformState.pixelRatio === "number") {
    return uniformState.pixelRatio;
  }
  if (
    defined(uniformState) &&
    defined(uniformState.frameState) &&
    typeof uniformState.frameState.pixelRatio === "number"
  ) {
    return uniformState.frameState.pixelRatio;
  }
  return 1.0;
}

/**
 * Writes the pixel-ratio tail (vec4: ratio, reserved x3) starting at float
 * index `offset`. Screen-space material widths are authored in CSS pixels,
 * so a material that converts one to device pixels must scale by this the
 * way the GLSL materials scale by `czm_pixelRatio`. Packed unconditionally;
 * layouts whose shaders do not declare the field leave it unread.
 * @private
 */
function writePixelRatioTail(
  ud: Float32Array,
  offset: number,
  uniformState: CesiumUniformState,
) {
  ud[offset + 0] = resolvePixelRatio(uniformState);
  ud[offset + 1] = 0.0;
  ud[offset + 2] = 0.0;
  ud[offset + 3] = 0.0;
}

/**
 * Writes RTE uniform data for a lit (Phong/PBR) shader.
 * Layout: mvpRTE(16) + mvRTE(16) + normalMatrix(16) + camHigh(4) + camLow(4)
 *       + lightDir(4) + prevVP(16) + inverseViewQuaternion(4) + logDepth(4)
 *       + inverseRadii(4) + modelMatrix3 columns(12) + worldCamera(8)
 *       + pixelRatio(4)
 *       = 112 floats = 448 bytes
 * @private
 */
function writeRTEUniformsLit(
  ud: Float32Array,
  rte: RTEMatrices,
  uniformState: CesiumUniformState,
) {
  assertUniformDataCapacity(ud, LIT_CAMERA_BYTES, "writeRTEUniformsLit");
  Matrix4.pack(rte.mvpRTE, ud, 0);
  Matrix4.pack(rte.modelViewRTE, ud, 16);
  const normalMatrix = Matrix4.inverse(rte.modelView, scratchNormalMatrix);
  Matrix4.transpose(normalMatrix, normalMatrix);
  Matrix4.pack(normalMatrix, ud, 32);
  ud[48] = rte.camHigh.x;
  ud[49] = rte.camHigh.y;
  ud[50] = rte.camHigh.z;
  // Float 51 = CameraUniforms `_pad0`/`hdrGamma` (after camHigh). Carries the
  // HDR sRGB→linear decode gate for the phong per-instance-color FS. 0 on the
  // default SDR path → byte-identical.
  ud[51] = getHdrGammaLane(uniformState);
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
  writePreviousViewProjection(
    ud,
    LIT_PREVIOUS_VIEW_PROJECTION_OFFSET,
    uniformState,
  );
  writeNormalizedInverseViewQuaternion(
    ud,
    LIT_INVERSE_VIEW_QUATERNION_OFFSET,
    uniformState.inverseViewRotation,
  );
  // The log-depth tail occupies floats 80-83.
  // Inert until the LOG_DEPTH define is set on the lit pipeline.
  writeLogDepthTail(ud, LIT_LOG_DEPTH_OFFSET, uniformState);
  writeEllipsoidOneOverRadiiTail(
    ud,
    LIT_ELLIPSOID_ONE_OVER_RADII_OFFSET,
    uniformState,
  );
  writeModelToWorldPositionTail(
    ud,
    LIT_MODEL_MATRIX_COLUMN_0_OFFSET,
    LIT_ENCODED_CAMERA_WORLD_HIGH_OFFSET,
    LIT_ENCODED_CAMERA_WORLD_LOW_OFFSET,
    rte,
  );
  writePixelRatioTail(ud, LIT_PIXEL_RATIO_OFFSET, uniformState);
}

/**
 * Writes 16 floats of `uniformState.previousViewProjection` starting at
 * `offset`. Falls back to identity on the first frame before
 * `UniformState.update()` has seeded the slot.
 * @private
 */
function writePreviousViewProjection(
  ud: Float32Array,
  offset: number,
  uniformState: CesiumUniformState,
) {
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
 * Writes the camera buffer for polyline-appearance shaders. Their vertex
 * stage does width expansion in screen space, so it needs the full projection /
 * viewportTransformation / viewportOrthographic / modelViewRTE chain plus
 * pixelRatio + frustum-near, on top of the shared flat-camera head.
 *
 * Layout (float offsets — byte-locked to CameraUniforms in
 * PolylineColorAppearance.wgsl):
 *   0-15  mvpRelativeToEye
 *   16-19 encodedCameraHigh + pad
 *   20-23 encodedCameraLow  + pad
 *   24-39 projection
 *   40-55 viewportTransformation
 *   56-71 viewportOrthographic
 *   72-87 modelViewRelativeToEye
 *   88    pixelRatio
 *   89    currentFrustumNear
 *   90-91 pad
 *
 * The viewport projection receives the context-owned clip-space convention
 * explicitly; no process-global Matrix4 mode is consulted.
 *
 * WebGPU does not populate `uniformState.viewport` through WebGL's
 * `RenderState.applyViewport` path, so its viewport-derived matrices remain
 * identity. Derive both screen-space matrices from the context drawing-buffer
 * dimensions, matching other WebGPU collection renderers. This local derivation
 * is the active polyline path; renderer-wide viewport seeding remains
 * unimplemented for other screen-space shaders.
 * @private
 */
const scratchPolylineViewport = new BoundingRectangle();
const scratchViewportTransform = new Matrix4();
const scratchViewportOrtho = new Matrix4();
function writeRTEUniformsPolyline(
  ud: Float32Array,
  rte: RTEMatrices,
  uniformState: CesiumUniformState,
  context: CesiumGraphicsContext,
) {
  // This head mirrors writeRTEUniformsFlat's first 24 floats so the
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
  // viewportOrthographic: window (pixel) coords -> WebGPU clip space.
  Matrix4.computeOrthographicOffCenter(
    0.0,
    width,
    0.0,
    height,
    0.0,
    1.0,
    scratchViewportOrtho,
    context.clipSpaceConvention,
  );

  // Screen-space expansion matrices.
  Matrix4.pack(uniformState.projection, ud, 24);
  Matrix4.pack(scratchViewportTransform, ud, 40);
  Matrix4.pack(scratchViewportOrtho, ud, 56);
  Matrix4.pack(rte.modelViewRTE, ud, 72);

  const pixelRatio = resolvePixelRatio(uniformState);
  const frustum =
    defined(uniformState) && defined(uniformState.currentFrustum)
      ? uniformState.currentFrustum
      : undefined;
  ud[88] = pixelRatio;
  ud[89] = defined(frustum) ? frustum.x : 0.0;
  ud[90] = 0.0;
  ud[91] = 0.0;
  // The log-depth tail (near, far, factor, reserved) occupies floats 92-95.
  // Inert until the LOG_DEPTH pipeline define is set on the appearance /
  // material polyline pipelines; the shader reads `camera.logDepth` only
  // inside //>>ifdef LOG_DEPTH. 512B UB has room (96 floats = 384 bytes).
  writeLogDepthTail(ud, 92, uniformState);

  // Morph time (the x component of the morph vec4) occupies float 96.
  // It is 1.0 in 3D, 0.0 in 2D/CV, and
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
// Per-frame primitive effects bind group
// =========================================================================
//
// Primitive commands are built once and reused frame-to-frame, while their
// shadow and clustered-light inputs can change each frame. Cache one shared
// effects bind group per frame on the context, rebuild it when those inputs
// change, and swap it into `command.bindGroups[last]` from the update hook.
// Current appearance primitives use the identity model matrix, so one shared
// bind group covers every command.
//
// Primitive commands do not yet thread a ClippingPlaneCollection reference
// into this bind group. Keep the clipping slots on the placeholder until that
// ownership path exists, so clipping remains an intentional no-op here.

function _getOrCreateSharedPrimitiveEffectsBG(frameState: CesiumFrameState) {
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

  const csmCandidate = context.csmRenderer as CsmRendererLike | undefined;
  const hasCsm =
    frameState.useCascadedShadowMaps === true &&
    defined(csmCandidate) &&
    csmCandidate.enabled === true &&
    defined(csmCandidate.cascadeParamsBuffer) &&
    defined(csmCandidate.cascadeArrayView);
  const csmBinding = hasCsm
    ? {
        enabled: true,
        paramsBuffer: csmCandidate.cascadeParamsBuffer,
        cascadeArrayView: csmCandidate.cascadeArrayView,
        // Soft-shadow kernel radius in texels.
        pcfRadius: csmCandidate.pcfRadius,
      }
    : undefined;

  // Read aerial-perspective LUT views from the performance manager. Otherwise
  // primitive shaders receive placeholder LUTs and disable fog contribution;
  // the globe forwards the corresponding real views.
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

  // The clustered-light dispatcher publishes its buffers and active state on
  // the context. Active lit shaders require them at effects bindings 18-22;
  // disabled or empty lighting retains the placeholder fast path.
  const clusteredBuffers = context._clusteredLightingBuffers;
  const hasClustered =
    context._clusteredLightingActive === true && defined(clusteredBuffers);

  // Invalidate the cache when the frame ticks or when the shadow, CSM, LUT, or
  // clustered-lighting state changes. A compact hash makes the same-frame
  // toggle check inexpensive.
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

  // With no shadow, CSM, atmosphere LUT, or clustered-lighting input active,
  // return the placeholder rather than null. Callers must replace a previously
  // active bind group with zero-filled data when a feature turns off, or the
  // shader can retain stale controls and resources from the preceding frame.
  if (!hasShadow && !hasCsm && !hasAtmosphereLut && !hasClustered) {
    const placeholder = getPlaceholderEffects(device);
    context._primitiveEffectsBG = placeholder.bindGroup;
    context._primitiveEffectsBGFrameNumber = frameNumber;
    context._primitiveEffectsBGToggleHash = toggleHash;
    return placeholder.bindGroup;
  }

  const fxRes = createEffectsBindGroup(device, frameState, {
    owner: context,
    shadowMap: receiveShadowMap,
    csm: csmBinding,
    // Primitives have identity modelMatrix, so world camera equals plane-space
    // camera. Clipping data stays on placeholder bindings because this path does
    // not receive a clipping collection reference.
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
    // Pass clustered-lighting bindings 18-22 only while active so the no-effects
    // placeholder fast path is preserved when clustered lighting is off.
    clusteredLighting: hasClustered ? clusteredBuffers : undefined,
  });
  // Primitive command construction runs before ViewportExecutor fits the
  // current directional/spot light camera. Match the model path by queuing the
  // shared receiver UBO for one post-fit 80-byte prefix refresh. Point shadows
  // use camera-relative light metadata instead of the 2D matrix, while CSM
  // owns its fitted cascade-parameter buffer, so neither belongs in this lane.
  const receiveShadowMapIsPointLight =
    (
      receiveShadowMap as
        (CesiumShadowMap & { _isPointLight?: boolean }) | undefined
    )?._isPointLight === true;
  if (defined(receiveShadowMap) && !receiveShadowMapIsPointLight && !hasCsm) {
    context.enqueueShadowReceiveUniformRefresh?.(
      fxRes.uniformBuffer,
      receiveShadowMap,
    );
  }
  context._primitiveEffectsBG = fxRes.bindGroup;
  context._primitiveEffectsBGFrameNumber = frameNumber;
  context._primitiveEffectsBGToggleHash = toggleHash;
  return fxRes.bindGroup;
}

function _refreshPrimitiveEffectsSlot(
  command: PrimitiveDrawCommand,
  frameState: CesiumFrameState,
) {
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
  // The textured polyline Image variant has its texture at the last bind
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

function _refreshPrimitiveShadowCastTransform(
  device: GPUDevice,
  command: PrimitiveDrawCommand,
  frameState: CesiumFrameState,
  modelMatrix: Matrix4,
  rte?: RTEMatrices,
): void {
  if (!defined(command._primitiveShadowCastHost)) {
    return;
  }
  const primitive = command.owner as unknown as PrimitiveLike;
  const shadowMode = primitive?.shadows;
  if (
    (shadowMode !== ShadowMode.ENABLED &&
      shadowMode !== ShadowMode.CAST_ONLY) ||
    frameState.shadowMaps.length === 0 ||
    frameState.passes.pick === true ||
    frameState.passes.pickVoxel === true ||
    frameState.mode !== SceneMode.SCENE3D
  ) {
    return;
  }

  const cameraPositionWC =
    frameState.context.uniformState?.cameraPosition ??
    frameState.camera.positionWC;
  // The color camera pack has already transformed and encoded the camera into
  // model space. Reuse it on the ordinary single-view path so shadow support
  // does not add a second Matrix4.inverse per Primitive while the camera moves.
  // Offscreen/multi-view overrides can publish a different UniformState camera;
  // those keep the independent correctness path.
  const frameCameraPositionWC = frameState.camera.positionWC;
  const canReuseColorRte =
    defined(rte) &&
    cameraPositionWC.x === frameCameraPositionWC.x &&
    cameraPositionWC.y === frameCameraPositionWC.y &&
    cameraPositionWC.z === frameCameraPositionWC.z;
  updatePrimitiveShadowCastCommand(
    device,
    command,
    modelMatrix,
    cameraPositionWC,
    canReuseColorRte ? rte.camHigh : undefined,
    canReuseColorRte ? rte.camLow : undefined,
  );
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
function updateWebGPUCommandUniforms(
  command: PrimitiveDrawCommand,
  frameState: CesiumFrameState,
  modelMatrix: Matrix4,
) {
  if (!command.isWebGPUDrawCommand || !command._webgpuCameraBuffer) {
    return;
  }

  const context = frameState.context;
  const device = context.device;
  if (!device) {
    return;
  }

  // Polyline projection, viewport, and model-view data changes with the camera,
  // so rewrite this buffer every frame. Color and material polyline shaders
  // share the layout. `_isPolylineAppearance` prevents
  // the polyline material types don't fall through to the generic flat/lit
  // camera writers below (their UB layout differs).
  if (command._isPolylineAppearance === true) {
    const rtePoly = computeRTEMatrices(
      context.uniformState,
      frameState.camera,
      modelMatrix,
    );
    _refreshPrimitiveShadowCastTransform(
      device,
      command,
      frameState,
      modelMatrix,
      rtePoly,
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

    // Re-upload the material UBO when the Material's
    // `_uniformBuffer` is dirty (time-varying dash pattern / glow phase).
    // Color-appearance commands have no `_webgpuMaterialUB`, so this is a no-op
    // there.
    const matUB = command._webgpuMaterialUB;
    const matBuffer = command._webgpuMaterialBuffer;
    if (defined(matUB) && defined(matBuffer)) {
      command._webgpuMaterialUploadState ??= createMaterialUploadState();
      uploadMaterialUniformBuffer(
        device,
        matBuffer,
        matUB,
        command._webgpuMaterialUploadState,
      );
    }

    // Refresh the textured Image variant's texture bind group. The
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
  _refreshPrimitiveShadowCastTransform(
    device,
    command,
    frameState,
    modelMatrix,
    rte,
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

  // Swap the effects bind group for this frame so shadow-
  // receive / CSM bindings reach the primitive shader instead of the
  // zero-filled placeholder the command was built with.
  _refreshPrimitiveEffectsSlot(command, frameState);
}

// =========================================================================
// Pick Uniform Update (per frame)
// =========================================================================

// The pick scratch array follows the 176-byte flat camera head exactly, so the
// wider elevation-material tail remains outside layouts that do not declare it.
const scratchPickUniformData = new Float32Array(
  PICK_CAMERA_BYTES / Float32Array.BYTES_PER_ELEMENT,
);

/**
 * Updates the GPU uniform buffer for a WebGPU pick command with current camera matrices.
 * @private
 */
function updateWebGPUPickCommandUniforms(
  command: PrimitiveDrawCommand,
  frameState: CesiumFrameState,
  modelMatrix: Matrix4,
) {
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

  // Pick shaders use only the shared 176-byte flat head. Keeping this call
  // explicit prevents a wider material layout from being silently truncated.
  const ud = scratchPickUniformData;
  writeRTEUniformsFlatHead(ud, rte, context.uniformState);
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
// Polyline color-appearance helpers
// =========================================================================

/**
 * Reads a per-vertex color attribute into RGBA floats in [0,1]. Handles the
 * UNSIGNED_BYTE + normalize:true layout PolylineGeometry emits (values 0-255)
 * as well as already-float color attributes (values 0-1).
 * @private
 */
function readPolylineColor(colorAttr: AttributeLike, v: number, out: number[]) {
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
  device: GPUDevice,
  context: CesiumGraphicsContext,
  cache: CacheLike,
  shaderModule: ShaderModuleLike,
  vertexLayout: VertexLayoutLike,
  translucent: boolean,
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
 * Creates WebGPU draw commands for a `PolylineColorAppearance` primitive.
 * Packs positions, previous and next positions, expansion width, and color
 * expandAndWidth + color) and routes through the polyline appearance shader
 * which expands the coincident quad vertices into a screen-space ribbon.
 *
 * Picking is not implemented for this command
 * family, so `pickCommands` is cleared.
 * @private
 */
function createPolylineAppearanceCommands(
  primitive: PrimitiveLike,
  appearance: AppearanceLike,
  translucent: boolean,
  colorCommands: PrimitiveDrawCommand[],
  pickCommands: PrimitiveDrawCommand[],
  frameState: CesiumFrameState,
  geometries: GeometryLike[],
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
  // Scene log depth selects the corresponding appearance shader and pipeline;
  // a state change requires both to rebuild.
  const logDepthActive = isWebGPULogDepthActive(context, frameState);
  const logDepthChanged = cache.logDepthEnabled !== logDepthActive;

  // Rebuild when the scene-framebuffer format generation changes because the
  // color target format is pipeline state.
  const sceneFormatGen = context._scenePipelineFormatGeneration ?? 0;
  const formatGenChanged = cache.pipelineFormatGeneration !== sceneFormatGen;

  if (
    !defined(cache.pipeline) ||
    translucentChanged ||
    logDepthChanged ||
    formatGenChanged
  ) {
    cache.translucent = translucent;
    cache.logDepthEnabled = logDepthActive;
    cache.pipelineFormatGeneration = sceneFormatGen;

    // Route through the preprocessor so the chunk-injected source is resolved
    // via getShaderSource (prepends csm_polylineCommon) and the //>>ifdef
    // LOG_DEPTH blocks resolve. Zero defines selects the hyperbolic path.
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

    // Projected 2D positions feed the morph blend. They are absent in scene3DOnly
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
      // Projected positions occupy floats 24-41 (locations 8-13)
      // and remain zero when absent.
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

    const cmd: PrimitiveDrawCommand = new WebGPUDrawCommand({
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
      owner: primitive as unknown as WebGPUCommandOwner,
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
  // This command family does not implement picking.
  pickCommands.length = 0;
}

// =========================================================================
// Polyline material-appearance helpers
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
function ensurePolylineST(geometry: GeometryLike) {
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
    componentDatatype: FLOAT_COMPONENT_DATATYPE,
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
  device: GPUDevice,
  context: CesiumGraphicsContext,
  cache: CacheLike,
  shaderModule: ShaderModuleLike,
  vertexLayout: VertexLayoutLike,
  translucent: boolean,
  needsTexture: boolean,
  blend: GPUBlendState | undefined,
) {
  const cameraBGL = makeBindGroupLayout(device, "Polyline Mat Camera BGL", [
    uniformBuffer(0, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),
  ]);
  const materialBGL = makeBindGroupLayout(device, "Polyline Mat Material BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
  ]);
  cache.cameraBindGroupLayout = cameraBGL;
  cache.materialBindGroupLayout = materialBGL;

  // A textured Image material gets a @group(2) texture and sampler (three-binding
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
        blend,
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
 * `PolylineMaterialAppearance`. Packs 22 floats per vertex
 * (posHigh/posLow + prev/next high/low + expandAndWidth + st) and routes
 * through the per-material polyline FS (Color / Dash / Glow / Arrow / Outline).
 * Reuses the color-appearance camera uniform buffer and
 * `writeRTEUniformsPolyline`, and the
 * material-path material-UB upload (material._uniformBuffer.gpuData).
 *
 * Picking is not implemented for this color-only
 * path, so `pickCommands` is cleared.
 * @private
 */
function createPolylineMaterialAppearanceCommands(
  primitive: PrimitiveLike,
  appearance: AppearanceLike,
  material: MaterialLike,
  translucent: boolean,
  colorCommands: PrimitiveDrawCommand[],
  pickCommands: PrimitiveDrawCommand[],
  frameState: CesiumFrameState,
  geometries: GeometryLike[],
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
  const shaderInfo: ShaderInfoLike = selectPolylineMaterialShader(material);

  const shaderChanged = cache.shaderType !== shaderInfo.type;
  const translucentChanged = cache.translucent !== translucent;
  // A polyline material that declares itself opaque still leaves the alpha
  // blend the appearance's constructor installed, exactly as the surface
  // material path does; read the blend from the render state rather than from
  // the translucency flag.
  const polylineBlend = resolveAppearanceBlend(
    appearance?.renderState,
    translucent,
  );
  const polylineBlendKey = blendCacheKey(polylineBlend);
  const blendChanged = cache.materialBlendKey !== polylineBlendKey;
  // Scene log depth is a shader and pipeline axis.
  const logDepthActive = isWebGPULogDepthActive(context, frameState);
  const logDepthChanged = cache.logDepthEnabled !== logDepthActive;

  // Rebuild when the scene-framebuffer format generation changes because the
  // color target format is pipeline state.
  const sceneFormatGen = context._scenePipelineFormatGeneration ?? 0;
  const formatGenChanged = cache.pipelineFormatGeneration !== sceneFormatGen;

  if (
    !defined(cache.pipeline) ||
    shaderChanged ||
    translucentChanged ||
    blendChanged ||
    logDepthChanged ||
    formatGenChanged
  ) {
    cache.shaderType = shaderInfo.type;
    cache.translucent = translucent;
    cache.materialBlendKey = polylineBlendKey;
    cache.logDepthEnabled = logDepthActive;
    cache.pipelineFormatGeneration = sceneFormatGen;

    // Route through the preprocessor so getShaderSource's csm_polylineCommon
    // injection and conditional log-depth blocks resolve. Zero defines
    // selects the hyperbolic path.
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
      polylineBlend,
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
    cache.materialUploadState = createMaterialUploadState();
    cache._materialBufferSize = matByteSize;
    cache.materialBindGroup = null; // force rebind
  }

  if (defined(matGpuData)) {
    cache.materialUploadState ??= createMaterialUploadState();
    if (defined(matUB)) {
      uploadMaterialUniformBuffer(
        device,
        cache.materialBuffer,
        matUB,
        cache.materialUploadState,
      );
    } else {
      device.queue.writeBuffer(cache.materialBuffer, 0, matGpuData);
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

  // For a textured Image material, build or refresh the @group(2) texture bind
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
    // attribute. PolylineMaterialAppearance.VERTEX_FORMAT requests `st`, so it
    // must be reconstructed before packing; otherwise st reads as (0,0) and the
    // st-dependent materials (Glow/Arrow/Outline) collapse (Glow → invisible,
    // since glowPower/abs(0-0.5)-glowPower/0.5 == 0). The polyline-specific
    // decoder is required — the generic ensureUncompressedAttributes mis-sniffs
    // the ST-only slot as a normal for first vertices with st==(0,0).
    // PolylineColorAppearance has no st, so its packer does not need this step.
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

    // Projected 2D positions feed the morph blend, as in the color packer.
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
    // nextHigh(3) nextLow(3) expandAndWidth(2) st(2) + 2D positions(18)
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
      // Projected positions occupy floats 22-39 (locations 8-13)
      // and remain zero when absent.
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

    // The textured Image variant binds the texture group at slot 2 (no
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

    const cmd: PrimitiveDrawCommand = new WebGPUDrawCommand({
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
      owner: primitive as unknown as WebGPUCommandOwner,
      renderState: appearanceRS,
    });
    cmd._webgpuCameraBuffer = cache.cameraBuffers[i];
    cmd._webgpuShaderType = shaderInfo.type;
    cmd._isPolylineAppearance = true;
    // For the textured Image variant, slot 2 is the texture rather than an effects
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
    cmd._webgpuMaterialUploadState = cache.materialUploadState;
    cmd._label = "polyline material appearance";
    cmd.vertexStride = vertexLayout.stride;
    validCommands.push(cmd);
  }

  colorCommands.length = validCommands.length;
  for (let i = 0; i < validCommands.length; i++) {
    colorCommands[i] = validCommands[i];
  }
  // This command family is color-only; picking is not implemented.
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
  primitive: PrimitiveLike,
  appearance: AppearanceLike,
  material: MaterialLike,
  translucent: boolean,
  twoPasses: boolean,
  colorCommands: PrimitiveDrawCommand[],
  pickCommands: PrimitiveDrawCommand[],
  frameState: CesiumFrameState,
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

  // When `depthFailAppearance` is set, each color command gains a greater,
  // no-depth-write twin that shades the per-instance depthFail color where the
  // primitive is hidden behind nearer geometry. Mirrors the WebGL twin
  // (PrimitiveCommandHelpers.js `_spDepthFail` / `_frontFaceDepthFailRS`). The
  // depthFail color is a per-instance batch attribute (`depthFailColor`),
  // read CPU-side like `color`.
  const depthFailAppearance = primitive._depthFailAppearance;
  const hasDepthFail = defined(depthFailAppearance);
  const depthFailColorIndex =
    primitive._batchTableAttributeIndices?.depthFailColor;

  const allowPicking = primitive._allowPicking;
  const pickIds = primitive._pickIds;
  const hasPickIds = allowPicking && defined(pickIds) && pickIds.length > 0;

  // ── Initialize GPU object cache ──
  if (!defined(primitive._webgpuCache)) {
    primitive._webgpuCache = {
      shaderType: null,
      shaderModule: null,
      pipeline: null,
      // Tracks the log-depth state baked into the cached lit pipeline so a
      // scene-switch change rebuilds it.
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
      // Pick-log state baked into the cached pick pipeline.
      pickLogDepthEnabled: false,
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
  // Decode compressed vertex attributes before shader selection. `Primitive`
  // runs `GeometryPipeline.compressVertices`
  // by default, which packs the normal (+ st / tangent / bitangent) into a
  // single `compressedAttributes` slot and RTE-splits position into
  // position3DHigh/Low. Without this decode, `selectWebGPUShader` sees no
  // literal `normal` attribute and would fall back to the unlit `basic` shader,
  // so a flat:false PerInstanceColorAppearance (or any lit non-material
  // appearance) rendered with no lighting. The per-geometry loop below
  // selection. The helper is idempotent.
  ensureUncompressedAttributes(firstGeometry);

  // Detect `PolylineColorAppearance` geometry before generic shader selection.
  // The geometry carries `expandAndWidth` +
  // `prevPosition3DHigh`/`nextPosition3DHigh` attributes that the basic packer
  // does not preserve. Route to a dedicated packer, pipeline, and camera UB
  // that consume those attributes and do the screen-space width expansion.
  // Detected before selectWebGPUShader because that helper only inspects
  // normal/st and would pick "basic".
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

  const shaderInfo: ShaderInfoLike = selectWebGPUShader(
    firstGeometry.attributes,
  );
  const vertexLayout = getVertexLayoutForShader(shaderInfo.type);

  const shaderChanged = cache.shaderType !== shaderInfo.type;
  const translucentChanged = cache.translucent !== translucent;
  // Treat a `twoPasses` change as a pipeline-signature change so
  // front/back cull variants rebuild.
  const twoPassesChanged = cache.twoPasses !== twoPasses;
  // Rebuild when primitive topology changes because topology is pipeline state.
  const primitiveTopology = mapCesiumPrimitiveTypeToWebGPU(
    firstGeometry.primitiveType,
  );
  const topologyChanged = cache.primitiveTopology !== primitiveTopology;
  const needsTexture = isTexturedShader(shaderInfo.type);
  const isLit = isPhongShader(shaderInfo.type);
  const cameraBufferSize = isLit ? LIT_CAMERA_BYTES : FLAT_CAMERA_BYTES;

  // Basic and Phong shaders use conditional logarithmic fragment depth. Lit
  // camera data stores its values at floats 80-83; flat data uses floats 40-43.
  // A scene log-depth change rebuilds the color shader and pipeline, while the
  // pick pipeline follows its independent fleet switch below.
  const logDepthActive = isWebGPULogDepthActive(context, frameState);
  const logDepthChanged = cache.logDepthEnabled !== logDepthActive;
  // The pick fleet writes logarithmic fragment depth under its own shared-
  // framebuffer switch. A change rebuilds the pick module and camera layout;
  // non-pickable primitives ignore it.
  const pickLogActive = isWebGPUPickLogDepthActive(context, frameState);
  const pickLogChanged =
    hasPickIds && cache.pickLogDepthEnabled !== pickLogActive;

  // The pipeline bakes `scenePipelineFormat`; rebuild when its generation
  // changes so an HDR toggle cannot reuse an incompatible color target.
  const sceneFormatGen = context._scenePipelineFormatGeneration ?? 0;
  const formatGenChanged = cache.pipelineFormatGeneration !== sceneFormatGen;

  if (
    shaderChanged ||
    translucentChanged ||
    twoPassesChanged ||
    topologyChanged ||
    logDepthChanged ||
    pickLogChanged ||
    formatGenChanged
  ) {
    cache.shaderType = shaderInfo.type;
    cache.translucent = translucent;
    cache.primitiveTopology = primitiveTopology;
    cache.logDepthEnabled = logDepthActive;
    // Record the pick-log state used for the pipeline rebuilt below.
    cache.pickLogDepthEnabled = pickLogActive;
    cache.pipelineFormatGeneration = sceneFormatGen;

    // Always preprocess so compressed-vertex and log-depth branches resolve.
    // Zero defines selects unpacked hyperbolic input. Direct compressed input
    // remains intentionally unwired: enabling that bit must be paired with a
    // packer that emits `compressedAttributes`; retain the branch as rollout
    // infrastructure until that producer and broader shader coverage exist.
    const shaderDefines = logDepthActive ? ShaderDefine.LOG_DEPTH : 0;
    // Prepend clustered lighting only to Phong shaders that call
    // `evalClusteredLights`; substitute effects group 3 for textured
    // layouts and group 2 otherwise.
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
    // Camera data is visible to both stages because flat fragment shaders use it
    // for aerial fog. Uniform visibility avoids a fragile shader-type allowlist.
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
      // The texture layout carries one sampler and two texture slots.
      // Single-texture shaders ignore the placeholder secondary slot.
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

    // Primitive color pipelines target the scene framebuffer, so the local
    // `canvasFormat` value contains `scenePipelineFormat`.
    const canvasFormat =
      context.scenePipelineFormat || navigator.gpu.getPreferredCanvasFormat();
    // Cull and OIT variants share one immutable pipeline layout. OIT must use
    // the exact layout that created the prebuilt bind groups.
    const primitivePipelineLayout = device.createPipelineLayout({
      label: `Primitive PL ${shaderInfo.type}`,
      bindGroupLayouts: bindGroupLayouts,
    });
    // Build the primitive render pipeline for a given cull mode. Kept
    // as a closure so the `twoPasses` path below can create two extra
    // variants (cullMode: "front" for pass 1, cullMode: "back" for
    // pass 2) without duplicating the full descriptor.
    const makePipeline = (cullMode: GPUCullMode, label: string) =>
      device.createRenderPipeline({
        label,
        layout: primitivePipelineLayout,
        vertex: {
          module: cache.shaderModule.module,
          entryPoint: "vertexMain",
          buffers: [vertexLayout.layout],
        },
        fragment: {
          module: cache.shaderModule.module,
          entryPoint: "fragmentMain",
          // Lit shaders emit normal-roughness at slot 1. Flat shaders declare
          // the slot with a zero write mask because they have no such output.
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
        // Pipeline sample count must match the active scene framebuffer; a
        // single-sample pipeline is incompatible with a multisampled pass.
        multisample:
          (context._msaaSamples ?? 1) > 1
            ? { count: context._msaaSamples }
            : undefined,
      });
    // Closed appearances default to back-face culling, matching
    // `Appearance.getDefaultRenderState(...)` and preventing front/back depth
    // competition on opaque convex geometry. Non-closed appearances render
    // both faces. For the EquirectangularPanorama case (#13369), a closed
    // appearance can explicitly disable culling;
    // `Appearance.getDefaultRenderState(...)` preserves that override through
    // `combine(existing, rs, true)`. Two-pass translucent culling applies only
    // when culling was not explicitly disabled.
    const cullExplicitlyDisabled =
      appearance?.renderState?.cull?.enabled === false;
    const defaultCullMode =
      appearance?.closed && !cullExplicitlyDisabled ? "back" : "none";
    cache.pipeline = makePipeline(
      defaultCullMode,
      `Primitive pipeline (cull=${defaultCullMode})`,
    );

    // Cache inputs for the optional OIT accumulation variant. They are
    // deliberately unused while OIT is disabled. The source omits log depth
    // because accumulation is depth-read-
    // only, so log frag_depth is meaningless there); when the master log switch
    // is off this equals `processedCode`. WebGPUOIT.injectOITOutput transforms
    // both the flat single-`@location(0)` shape and the lit `FragOutput` struct.
    cache.oitPipelineLayout = primitivePipelineLayout;
    cache.oitShaderCode = logDepthActive
      ? preprocessShaderSource(phongCode, 0)
      : processedCode;
    cache.oitDefaultCullMode = defaultCullMode;

    // The depth-fail twin always uses a flat shader with camera, material, and
    // effects groups and no texture, regardless of the
    // main appearance, so its bind-group layout is independent of `needsTexture`.
    // Same vertex layout + targets + MSAA as the main pipeline (reuses the main
    // color command's vertex buffer); differs only in the fragment module (returns
    // the uniform depthFail color) + depthStencil (greater compare, no write).
    if (hasDepthFail) {
      cache.depthFailShaderModule = WebGPUShaderModule.create({
        device: device,
        code: preprocessShaderSource(
          PrimitiveDepthFailColorSource,
          shaderDefines,
        ),
        label: "PrimitiveDepthFailColor Shader",
      });
      const depthFailLayouts = [
        cache.cameraBindGroupLayout,
        cache.materialBindGroupLayout,
        cache.effectsBGL,
      ];
      const makeDepthFailPipeline = (cullMode: GPUCullMode, label: string) =>
        device.createRenderPipeline({
          label,
          layout: device.createPipelineLayout({
            bindGroupLayouts: depthFailLayouts,
          }),
          vertex: {
            module: cache.depthFailShaderModule.module,
            entryPoint: "vertexMain",
            buffers: [vertexLayout.layout],
          },
          fragment: {
            module: cache.depthFailShaderModule.module,
            entryPoint: "fragmentMain",
            targets: makeSceneFBTargets(canvasFormat, {
              translucent,
              emitsGBuffer: false,
            }),
          },
          primitive: {
            topology: primitiveTopology,
            cullMode: primitiveTopology.startsWith("line") ? "none" : cullMode,
            frontFace: "ccw",
          },
          depthStencil: {
            format: "depth24plus-stencil8",
            // Shade only fragments behind existing depth and never overwrite it.
            depthWriteEnabled: false,
            depthCompare: "greater",
          },
          multisample:
            (context._msaaSamples ?? 1) > 1
              ? { count: context._msaaSamples }
              : undefined,
        });
      // Disable face culling so closed-volume back faces can pass the greater
      // test and produce the intended x-ray appearance.
      cache.depthFailPipeline = makeDepthFailPipeline(
        "none",
        `DepthFail pipeline (cull=none)`,
      );
    } else {
      cache.depthFailShaderModule = null;
      cache.depthFailPipeline = null;
    }
    // Closed translucent volumes draw back faces before front faces. Build both
    // cull variants up front; other paths retain the no-cull pipeline.
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
      // Compile the pick module with log depth only while the pick fleet uses
      // it; otherwise preprocessing retains the hyperbolic path.
      cache.pickShaderModule = WebGPUShaderModule.create({
        device: device,
        code: preprocessShaderSource(
          pickShaderCode,
          pickLogActive ? ShaderDefine.LOG_DEPTH : 0,
        ),
        label: `${shaderInfo.type} Pick Shader${pickLogActive ? " [ld]" : ""}`,
      });

      // Pick camera data is visible to both stages because the log-depth
      // fragment path reads the camera factor.
      cache.pickCameraBindGroupLayout = makeBindGroupLayout(
        device,
        "Pick Camera BGL",
        [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
      );

      // Pick material BGL — group(1): pickColor
      cache.pickMaterialBindGroupLayout = makeBindGroupLayout(
        device,
        "Pick Material BGL",
        [uniformBuffer(0, Stage.FRAGMENT)],
      );

      cache.pickPipeline = device.createRenderPipeline({
        // Append `[ld]` to log-depth pick labels for diagnostics.
        label: `${shaderInfo.type} Pick Pipeline${pickLogActive ? " [ld]" : ""}`,
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
              // Use the context's byte-object-ID format so the pipeline matches
              // the pick framebuffer.
              format:
                context.pickPipelineFormat ??
                (navigator.gpu.getPreferredCanvasFormat() as GPUTextureFormat),
            },
          ],
        },
        // Pick topology matches visual topology so outline picking covers the
        // same line fragments.
        primitive: { topology: primitiveTopology, cullMode: "none" },
        depthStencil: {
          format: "depth24plus-stencil8",
          // The shared pick framebuffer keeps depth writes enabled. Without a
          // fragment-depth output, hardware hyperbolic depth is unchanged.
          depthWriteEnabled: true,
          depthCompare: "less-equal",
        },
      });
    }
  }

  const validPickCommands = [];

  // Compute RTE matrices for initial uniform writes
  const rte = computeRTEMatrices(
    context.uniformState,
    frameState.camera,
    primitive.modelMatrix,
  );

  for (let i = 0; i < geometries.length; i++) {
    const geometry = geometries[i];

    // Reconstruct compressed normal and texture-coordinate attributes before
    // any geometry-attribute reads.
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

    // Per-vertex color through batchId.
    // Combined per-instance-color geometry stores colors in the batch table,
    // selected per-vertex by a `batchId` attribute (0 for instance 0's
    // vertices, 1 for instance 1's, …) — exactly what WebGL's
    // PerInstanceColorAppearanceVS resolves by sampling the batch-table
    // texture. The single `instanceColor` above is instance `i`'s batch color,
    // but a combined geometry has fewer geometries (often 1) than instances,
    // so applying instance 0's color to every vertex would inherit instance
    // zero's color. Resolve each vertex through its batch entry, then fall back
    // to explicit vertex color and the per-instance color.
    let instanceColors = null;
    if (hasInstanceColors) {
      const n = primitive._numberOfInstances || 0;
      instanceColors = new Array(n);
      for (let k = 0; k < n; k++) {
        let col = [1.0, 1.0, 1.0, 1.0];
        try {
          const bc = batchTable.getBatchedAttribute(k, colorIndex);
          if (defined(bc)) {
            if (defined(bc.red)) {
              col = [bc.red, bc.green, bc.blue, bc.alpha];
            } else if (defined(bc.x)) {
              const denorm =
                bc.x > 1.0 || bc.y > 1.0 || bc.z > 1.0 || bc.w > 1.0;
              col = denorm
                ? [bc.x / 255.0, bc.y / 255.0, bc.z / 255.0, bc.w / 255.0]
                : [bc.x, bc.y, bc.z, bc.w];
            }
          }
        } catch (e) {
          // keep white fallback
        }
        instanceColors[k] = col;
      }
    }
    const batchIdAttr = geometry.attributes.batchId;
    const batchIds =
      instanceColors !== null &&
      defined(batchIdAttr) &&
      defined(batchIdAttr.values) &&
      batchIdAttr.values.length >= numVertices
        ? batchIdAttr.values
        : null;

    const colorAttr = geometry.attributes.color;
    const perVertexColorCPA = defined(colorAttr)
      ? colorAttr.componentsPerAttribute || 4
      : 4;
    const perVertexColor =
      defined(colorAttr) &&
      defined(colorAttr.values) &&
      perVertexColorCPA >= 3 &&
      colorAttr.values.length >= numVertices * perVertexColorCPA
        ? colorAttr
        : null;
    // UNSIGNED_BYTE normalize:true → /255; FLOAT color is already [0,1].
    const perVertexColorScale =
      perVertexColor !== null && perVertexColor.normalize === true
        ? 1.0 / 255.0
        : 1.0;

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

      // Resolve this vertex's color: batch-table color selected by per-vertex
      // batchId (combined per-instance colors) first, then a per-vertex color
      // attribute, else the single instanceColor.
      let vcr = instanceColor[0];
      let vcg = instanceColor[1];
      let vcb = instanceColor[2];
      let vca = instanceColor[3];
      if (batchIds !== null) {
        const col = instanceColors[batchIds[v] | 0];
        if (defined(col)) {
          vcr = col[0];
          vcg = col[1];
          vcb = col[2];
          vca = col[3];
        }
      } else if (perVertexColor !== null) {
        const cOff = v * perVertexColorCPA;
        vcr = perVertexColor.values[cOff] * perVertexColorScale;
        vcg = perVertexColor.values[cOff + 1] * perVertexColorScale;
        vcb = perVertexColor.values[cOff + 2] * perVertexColorScale;
        vca =
          perVertexColorCPA >= 4
            ? perVertexColor.values[cOff + 3] * perVertexColorScale
            : 1.0;
      }

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
        vertexData[vOff + 11] = vcr;
        vertexData[vOff + 12] = vcg;
        vertexData[vOff + 13] = vcb;
        vertexData[vOff + 14] = vca;
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
        vertexData[vOff + 8] = vcr;
        vertexData[vOff + 9] = vcg;
        vertexData[vOff + 10] = vcb;
        vertexData[vOff + 11] = vca;
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
        vertexData[vOff + 9] = vcr;
        vertexData[vOff + 10] = vcg;
        vertexData[vOff + 11] = vcb;
        vertexData[vOff + 12] = vca;
      } else {
        // basic: posHigh(3)+posLow(3)+color(4) = 10 floats
        vertexData[vOff + 6] = vcr;
        vertexData[vOff + 7] = vcg;
        vertexData[vOff + 8] = vcb;
        vertexData[vOff + 9] = vca;
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

    // The 16-byte per-geometry depth-fail material buffer stores the per-instance
    // color read from the batch table. Like
    // the main `color`; default opaque red when no `depthFailColor` attribute
    // is present (a visible sentinel, not silent).
    if (hasDepthFail) {
      let dfColor = [1.0, 0.0, 0.0, 1.0];
      if (defined(depthFailColorIndex) && i < primitive._numberOfInstances) {
        try {
          const c = batchTable.getBatchedAttribute(i, depthFailColorIndex);
          if (defined(c)) {
            if (defined(c.red)) {
              dfColor = [c.red, c.green, c.blue, c.alpha];
            } else if (defined(c.x)) {
              const over =
                c.x > 1.0 || c.y > 1.0 || c.z > 1.0 || c.w > 1.0 ? 255.0 : 1.0;
              dfColor = [c.x / over, c.y / over, c.z / over, c.w / over];
            }
          }
        } catch (e) {
          // keep the default sentinel color
        }
      }
      if (!defined(cache.depthFailMaterialBuffers)) {
        cache.depthFailMaterialBuffers = [];
        cache.depthFailMaterialBindGroups = [];
      }
      if (!defined(cache.depthFailMaterialBuffers[i])) {
        cache.depthFailMaterialBuffers[i] = device.createBuffer({
          label: `DepthFail Material UB ${i}`,
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      }
      device.queue.writeBuffer(
        cache.depthFailMaterialBuffers[i],
        0,
        new Float32Array(dfColor),
      );
      cache.depthFailMaterialBindGroups[i] = device.createBindGroup({
        layout: cache.materialBindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: { buffer: cache.depthFailMaterialBuffers[i] },
          },
        ],
      });
    }

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

    // Closed translucent volumes emit back faces before front faces so the
    // interior composites before the exterior. Other paths use one no-cull
    // command. Forward `appearance.renderState` because stencil reference,
    // blend constant, viewport, and scissor are dynamic encoder state; depth,
    // cull, blend, and color-mask choices remain pipeline state.
    const appearanceRS = primitive.appearance?.renderState;
    const makeCommand = (
      pipeline: GPURenderPipeline,
      label: string,
      cullMode: GPUCullMode,
    ) => {
      const cmd: PrimitiveDrawCommand = new WebGPUDrawCommand({
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
        owner: primitive as unknown as WebGPUCommandOwner,
        renderState: appearanceRS,
      });
      cmd._webgpuCameraBuffer = cache.cameraBuffers[i];
      cmd._webgpuShaderType = shaderInfo.type;
      cmd._label = label;
      // The interleaved buffer begins with positionHigh + positionLow, but
      // those values are in Primitive/model coordinates. The transform-aware
      // variant shares one stable UBO and bind-group cache on this primitive.
      configurePrimitiveShadowCastCommand(cmd, cache, fpv * 4);
      // Attach OIT inputs only to translucent commands. They are deliberately
      // dormant in the sorted-alpha path and become active when OIT is enabled.
      // The shared layout preserves bind-group compatibility. Accumulation is
      // single-sample; multisampled resolve and composite ordering remains
      // unfinished, so these carrier fields must remain with that distinction.
      if (
        translucent &&
        defined(cache.oitShaderCode) &&
        defined(cache.oitPipelineLayout)
      ) {
        const oitCull: GPUCullMode = primitiveTopology.startsWith("line")
          ? "none"
          : cullMode;
        cmd._shaderCode = cache.oitShaderCode;
        cmd._pipelineConfig = {
          label: `OIT ${shaderInfo.type} (${label})`,
          layout: cache.oitPipelineLayout,
          vertexBuffers: [vertexLayout.layout],
          vertexEntryPoint: "vertexMain",
          fragmentEntryPoint: "fragmentMain",
          primitive: {
            topology: primitiveTopology,
            cullMode: oitCull,
            frontFace: "ccw",
          },
          depthStencil: {
            format: "depth24plus-stencil8",
            depthWriteEnabled: false,
            depthCompare: "less-equal",
          },
          multisample: undefined,
        };
      }
      return cmd;
    };
    if (twoPasses && cache.pipelineFrontCull && cache.pipelineBackCull) {
      validCommands.push(
        makeCommand(cache.pipelineFrontCull, "back-face pass", "front"),
      );
      validCommands.push(
        makeCommand(cache.pipelineBackCull, "front-face pass", "back"),
      );
    } else {
      validCommands.push(
        makeCommand(
          cache.pipeline,
          "single-pass",
          cache.oitDefaultCullMode ?? "none",
        ),
      );
    }

    // Emit the depth-fail twin after the main command so depth exists first;
    // the greater/no-write pipeline then shades only the occluded fragments.
    // Reuses the main vertex buffer; binds [camera, depthFailMaterial, effects]
    // (the depth-fail shader is flat — no texture group). Mirrors the WebGL
    // twin's interleaved emit.
    if (hasDepthFail && defined(cache.depthFailPipeline)) {
      const depthFailBindGroups = [
        cache.cameraBindGroups[i],
        cache.depthFailMaterialBindGroups[i],
        effectsPlaceholder.bindGroup,
      ];
      const dfCmd: PrimitiveDrawCommand = new WebGPUDrawCommand({
        pipeline: cache.depthFailPipeline,
        bindGroups: depthFailBindGroups,
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
        owner: primitive as unknown as WebGPUCommandOwner,
        renderState: appearanceRS,
      });
      dfCmd._webgpuCameraBuffer = cache.cameraBuffers[i];
      dfCmd._webgpuShaderType = "primitiveDepthFailColor";
      dfCmd._label = "depth-fail pass";
      configurePrimitiveShadowCastCommand(dfCmd, cache, fpv * 4);
      validCommands.push(dfCmd);
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
      writeRTEUniformsFlatHead(pickCameraData, rte, context.uniformState);
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

      const pickCommand: PrimitiveDrawCommand = new WebGPUDrawCommand({
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
        owner: primitive as unknown as WebGPUCommandOwner,
        // Forward render state so dynamic stencil, blend-constant, scissor, and
        // viewport state applies during picking; attachment, depth-write, and
        // blend state remain pipeline-baked.
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
 * Multi-texture materials bind a primary and optional secondary texture. Each
 * entry maps the material's shader-type string to the
 * `material._imageSources` keys that feed the primary `@binding(1)` slot and
 * the optional secondary `@binding(2)` slot.
 *
 * Single-texture materials return `{ primary: "image" }`; the
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
function getTextureUniformName(shaderType: string): {
  primary: string;
  secondary?: string;
} {
  if (shaderType.includes("NormalMap")) {
    return { primary: "image", secondary: "normalMap" };
  }
  if (shaderType.includes("BumpMap")) {
    return { primary: "image", secondary: "bumpMap" };
  }
  if (shaderType.includes("Water")) {
    // Water needs both the wave-normal perturbation texture and the
    // water/specular mask. Reversing these slots makes the normal sampler read
    // the mask and destabilizes wave normals.
    return { primary: "normalMap", secondary: "specularMap" };
  }
  if (shaderType.includes("ElevBand")) {
    // Elevation-band materials use heights as primary and the
    // color ramp as secondary.
    return { primary: "heights", secondary: "colors" };
  }
  return { primary: "image" };
}

/**
 * Creates or reuses a WebGPU texture bind group from a
 * Material's loaded image. Falls back to the context's 1×1
 * white default texture if the image hasn't loaded yet.
 *
 * @param {object} context - WebGPU context with createTextureFromImage()
 * @param {GPUDevice} device - The GPU device
 * @param {object} material - CesiumJS Material with _imageSources map
 * @param {string} shaderType - Material shader type (e.g., 'matImageFlat')
 * @param {object} cache - Primitive's _webgpuCache
 * @returns {boolean} true if a valid texture bind group exists
 * @private
 */
// Field-key sets let the texture helper target main or depth-fail cache slots
// without duplicating the binding logic.
const MAIN_MAT_TEX_KEYS = {
  bindGroup: "textureBindGroup",
  layout: "textureBindGroupLayout",
  primarySource: "_matPrimarySource",
  secondarySource: "_matSecondarySource",
  sampler: "_matSampler",
  samplerAddressU: "_matSamplerAddressU",
  samplerAddressV: "_matSamplerAddressV",
  gpuTexturePrimary: "_matGpuTexturePrimary",
  gpuTextureSecondary: "_matGpuTextureSecondary",
};
const DF_MAT_TEX_KEYS = {
  bindGroup: "dfTextureBindGroup",
  layout: "dfTextureBindGroupLayout",
  primarySource: "_dfMatPrimarySource",
  secondarySource: "_dfMatSecondarySource",
  sampler: "_dfMatSampler",
  samplerAddressU: "_dfMatSamplerAddressU",
  samplerAddressV: "_dfMatSamplerAddressV",
  gpuTexturePrimary: "_dfMatGpuTexturePrimary",
  gpuTextureSecondary: "_dfMatGpuTextureSecondary",
};

function ensureMaterialTextureBindGroup(
  context: CesiumGraphicsContext,
  device: GPUDevice,
  material: MaterialLike,
  shaderType: string,
  cache: CacheLike,
  keys?: typeof MAIN_MAT_TEX_KEYS,
) {
  const k = keys ?? MAIN_MAT_TEX_KEYS;
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
    defined(cache[k.bindGroup]) &&
    cache[k.primarySource] === primarySource &&
    cache[k.secondarySource] === secondarySource
  ) {
    return true;
  }

  // Select per-axis wrap mode from material fabric.
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
  // Both shapes are accepted. Without a repeat hint, use `clamp-to-edge`.
  const repeat = material?.uniforms?.repeat;
  let wantsRepeatU = false;
  let wantsRepeatV = false;
  if (defined(repeat)) {
    const rx = repeat.x;
    const ry = repeat.y;
    // Numeric shape: > 1 means tile. === 1 means clamp. < 1 is exotic
    // under-sampling; the shader handles it through fract, so sub-1 also means
    // no tiling at the sampler level.
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

  // Rebuild the sampler only when its address-mode configuration changes
  // because samplers are otherwise immutable and reusable.
  if (
    !defined(cache[k.sampler]) ||
    cache[k.samplerAddressU] !== addressModeU ||
    cache[k.samplerAddressV] !== addressModeV
  ) {
    cache[k.sampler] = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU,
      addressModeV,
    });
    cache[k.samplerAddressU] = addressModeU;
    cache[k.samplerAddressV] = addressModeV;
    // Invalidate the bind group so it picks up the new sampler on
    // the next frame.
    cache[k.bindGroup] = undefined;
  }

  // Resolve the fallback 1×1 placeholder view once — used for either slot
  // that doesn't have a real image. Single-texture materials always use
  // it for slot 2; multi-texture materials use it when the secondary
  // image hasn't loaded yet.
  const getPlaceholderView = () => {
    const defaultTex = context.defaultTexture as { view?: GPUTextureView };
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
      if (defined(cache[k.gpuTexturePrimary])) {
        (cache[k.gpuTexturePrimary] as CreatedTextureLike).destroy();
      }
      cache[k.gpuTexturePrimary] = gpuTex;
      primaryView = gpuTex.view;
    }
  }
  if (!defined(primaryView)) {
    primaryView = getPlaceholderView();
  }
  cache[k.primarySource] = primarySource;

  // Build or rebuild slot 2. Bind the placeholder when a single-texture
  // material has no secondary view, keeping the layout satisfied.
  let secondaryView;
  if (defined(secondarySource) && defined(context.createTextureFromImage)) {
    const gpuTex2 = context.createTextureFromImage(
      secondarySource,
      "rgba8unorm",
      true,
    );
    if (defined(gpuTex2)) {
      if (defined(cache[k.gpuTextureSecondary])) {
        (cache[k.gpuTextureSecondary] as CreatedTextureLike).destroy();
      }
      cache[k.gpuTextureSecondary] = gpuTex2;
      secondaryView = gpuTex2.view;
    }
  }
  if (!defined(secondaryView)) {
    secondaryView = getPlaceholderView();
  }
  cache[k.secondarySource] = secondarySource;

  cache[k.bindGroup] = device.createBindGroup({
    layout: cache[k.layout] as GPUBindGroupLayout,
    entries: [
      { binding: 0, resource: cache[k.sampler] as GPUSampler },
      { binding: 1, resource: primaryView },
      { binding: 2, resource: secondaryView },
    ],
  });

  return true;
}

/**
 * Builds the depth-fail twin's texture bind group in the `df*` cache slots by
 * reusing `ensureMaterialTextureBindGroup` with the DF field-key set.
 * @private
 */
function ensureDepthFailMaterialTextureBindGroup(
  context: CesiumGraphicsContext,
  device: GPUDevice,
  material: MaterialLike,
  shaderType: string,
  cache: CacheLike,
) {
  return ensureMaterialTextureBindGroup(
    context,
    device,
    material,
    shaderType,
    cache,
    DF_MAT_TEX_KEYS,
  );
}

/**
 * Re-adopts a material's image into the texture bind group a live command
 * carries and swaps the refreshed group back into the command's texture slot.
 *
 * A Material queues a decoded image into `_loadedImages` at the tail of
 * `Material.update` and copies it into `_imageSources` only at the head of the
 * NEXT update, so a command built during the primitive's first complete frame
 * is always built before the image is reachable. Command creation is one-shot —
 * `Primitive.update` rebuilds only when the appearance, the material identity,
 * the render-target format, or the device resources change — so without a
 * per-frame refresh the texture bind group keeps its 1x1 placeholder for the
 * life of the primitive and the material renders flat white. Materials whose
 * image is an in-memory canvas (the elevation, slope, and aspect ramps, and the
 * elevation band) always take that path; URL-backed images usually resolve
 * before the geometry completes and so happen to be adopted at creation.
 *
 * The binding helper keys on image identity, so this rebuilds once on adoption
 * and then early-returns, and it also picks up a later reassignment of the
 * material's image uniform. The polyline material path runs the same refresh
 * from its own per-frame updater.
 * @private
 */
function refreshMaterialCommandTextureSlot(
  command: PrimitiveDrawCommand,
  context: CesiumGraphicsContext,
  device: GPUDevice,
) {
  const cache = command._webgpuMatCache;
  const slot = command._webgpuMatTextureSlot;
  if (!defined(cache) || typeof slot !== "number") {
    return;
  }
  const keys =
    command._webgpuMatTextureIsDepthFail === true
      ? DF_MAT_TEX_KEYS
      : MAIN_MAT_TEX_KEYS;
  ensureMaterialTextureBindGroup(
    context,
    device,
    command._webgpuMaterial,
    command._webgpuMatShaderType,
    cache,
    keys,
  );
  const bindGroup = cache[keys.bindGroup] as GPUBindGroup | undefined;
  const bindGroups = command.bindGroups;
  if (
    defined(bindGroup) &&
    defined(bindGroups) &&
    bindGroups[slot] !== bindGroup
  ) {
    bindGroups[slot] = bindGroup;
  }
}

// =========================================================================
// Material Pipeline Creation
// =========================================================================

/**
 * Resolves the color blend a material pipeline must bake so its output matches
 * the render state the WebGL twin builds for the same appearance.
 *
 * `Appearance.isTranslucent` answers with the material's own translucency once
 * a material is present, so an appearance constructed `translucent: true`
 * still answers `false` whenever its material declares itself opaque — every
 * elevation material does. `Appearance.getRenderState` then forces
 * `depthMask` back on but leaves the alpha blend the constructor already put
 * on `Appearance#renderState`, so WebGL blends that draw and honours the
 * material's alpha. Baking the pipeline blend from the flag alone drops the
 * blend, and a material whose "not on a line" answer is alpha 0 fills its
 * whole surface with the line colour instead of disappearing.
 *
 * Returns `undefined` for the translucent case, where the caller's
 * `translucent: true` already selects the standard alpha blend, and for an
 * appearance whose render state does not blend at all.
 *
 * @private
 */
function resolveAppearanceBlend(
  renderState: CesiumRenderStateLike | undefined,
  translucent: boolean,
): GPUBlendState | undefined {
  if (translucent) {
    return undefined;
  }
  return renderStateToBlendState(renderState);
}

/**
 * Serializes a blend descriptor into a pipeline-cache discriminator. `none`
 * and a real blend must not compare equal, or a cached opaque pipeline is
 * served to an appearance that has since started blending.
 *
 * @private
 */
function blendCacheKey(blend: GPUBlendState | undefined): string {
  if (!blend) {
    return "none";
  }
  const { color, alpha } = blend;
  return [
    color.srcFactor,
    color.dstFactor,
    color.operation,
    alpha.srcFactor,
    alpha.dstFactor,
    alpha.operation,
  ].join(",");
}

/**
 * Creates (or reuses) the GPU pipeline for a material shader.
 * @private
 */
function createMaterialPipelineAndCache(
  cache: CacheLike,
  device: GPUDevice,
  shaderInfo: ShaderInfoLike,
  vertexLayout: VertexLayoutLike,
  context: CesiumGraphicsContext,
  isLit: boolean,
  translucent: boolean,
  primitiveTopology: GPUPrimitiveTopology,
  appearanceClosed: boolean,
  logDepthActive: boolean,
  blend: GPUBlendState | undefined,
) {
  const topology = primitiveTopology ?? "triangle-list";
  const closedClosed = appearanceClosed === true;
  // Track the log-depth define baked into the material pipeline so a scene-state
  // change rebuilds the shader module and pipeline.
  const logDepth = logDepthActive === true;
  // Rebuild when the scene-framebuffer format generation changes because the
  // color target is pipeline state.
  const sceneFormatGen = context._scenePipelineFormatGeneration ?? 0;
  const blendKey = blendCacheKey(blend);
  if (
    cache.shaderType === shaderInfo.type &&
    cache.translucent === translucent &&
    cache.materialBlendKey === blendKey &&
    cache.primitiveTopology === topology &&
    cache.appearanceClosed === closedClosed &&
    cache.logDepthEnabled === logDepth &&
    cache.pipelineFormatGeneration === sceneFormatGen
  ) {
    return false;
  }
  cache.shaderType = shaderInfo.type;
  cache.translucent = translucent;
  cache.materialBlendKey = blendKey;
  cache.primitiveTopology = topology;
  cache.appearanceClosed = closedClosed;
  cache.logDepthEnabled = logDepth;
  cache.pipelineFormatGeneration = sceneFormatGen;

  // Prepend clustered lighting only when the material shader calls
  // `evalClusteredLights`. Resolve its group token to 3 for textured
  // pipelines and 2 otherwise; call-site gating avoids incompatible bindings
  // in non-consuming variants.
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
  // Material and PBR shaders preprocess their log-depth branches against scene
  // state; zero defines selects hyperbolic depth.
  // Lit Mat shaders read the tail from the LIT UB (floats 80-83); Flat Mat and
  // PBR read from the FLAT/LIT UB tail respectively — both packed unconditionally.
  const shaderDefines = logDepth ? ShaderDefine.LOG_DEPTH : 0;
  cache.shaderModule = WebGPUShaderModule.create({
    device: device,
    code: preprocessShaderSource(materialCode, shaderDefines),
    label: `${shaderInfo.type} Material Shader`,
  });

  // Camera data is visible to both stages because flat material
  // fragments read encoded camera position for aerial fog. Uniform
  // visibility avoids a shader-type allowlist.
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
    // Material textures use a sampler plus primary and secondary slots.
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

  // Material and PBR pipelines keep effects at the trailing bind group so
  // consuming shaders share one layout. Shaders that do not
  // reference the effects bindings ignore the extra BG — WebGPU allows
  // unused bind groups in a pipeline layout.
  const matEffectsBGL = getEffectsBindGroupLayout(device);
  bindGroupLayouts.push(matEffectsBGL);
  cache.effectsBGL = matEffectsBGL;

  // The color pipeline targets the scene framebuffer and uses its format.
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
      targets: makeSceneFBTargets(canvasFormat, { translucent, blend }),
    },
    primitive: {
      topology,
      // Closed non-line geometry culls back faces, matching the `closed: true`
      // branch of `Appearance.getDefaultRenderState`; lines and non-closed
      // geometry do not cull.
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
    // Material pipeline sample count must match the scene
    // framebuffer's active MSAA count.
    multisample:
      (context._msaaSamples ?? 1) > 1
        ? { count: context._msaaSamples }
        : undefined,
  });

  return true;
}

// =========================================================================
// Depth-fail material pipeline
// =========================================================================

/**
 * Builds the depth-fail material twin and its `df*` bind-group layouts. It uses
 * the material shader selected for the depth-fail appearance, with a greater
 * depth comparison and no depth writes. Cull mode comes from that appearance's
 * closed and explicit-cull state; line topology always disables culling. This
 * keeps genuinely occluded regions distinct from the surviving main pass.
 * `PrimitiveCommandHelpers.createRenderStates` likewise uses the depth-fail
 * appearance's own render state and changes only `depthTest.func` to `GREATER`.
 *
 * Returns `true` when the pipeline (re)built this call (so callers force a
 * vertex-buffer rebuild), `false` when the cached pipeline is still valid.
 * @private
 */
function createMaterialDepthFailPipeline(
  cache: CacheLike,
  device: GPUDevice,
  shaderInfo: ShaderInfoLike,
  vertexLayout: VertexLayoutLike,
  context: CesiumGraphicsContext,
  isLit: boolean,
  translucent: boolean,
  primitiveTopology: GPUPrimitiveTopology,
  logDepthActive: boolean,
  dfCullMode: GPUCullMode,
  blend: GPUBlendState | undefined,
) {
  const topology = primitiveTopology ?? "triangle-list";
  const logDepth = logDepthActive === true;
  const cullMode = topology.startsWith("line") ? "none" : dfCullMode;
  // The depth-fail twin bakes the scene-framebuffer format, so a
  // generation change rebuilds it.
  const sceneFormatGen = context._scenePipelineFormatGeneration ?? 0;
  const blendKey = blendCacheKey(blend);
  if (
    cache.dfShaderType === shaderInfo.type &&
    cache.dfTranslucent === translucent &&
    cache.dfMaterialBlendKey === blendKey &&
    cache.dfPrimitiveTopology === topology &&
    cache.dfLogDepthEnabled === logDepth &&
    cache.dfCullMode === cullMode &&
    cache.dfPipelineFormatGeneration === sceneFormatGen &&
    defined(cache.dfPipeline)
  ) {
    return false;
  }
  cache.dfShaderType = shaderInfo.type;
  cache.dfTranslucent = translucent;
  cache.dfMaterialBlendKey = blendKey;
  cache.dfPrimitiveTopology = topology;
  cache.dfLogDepthEnabled = logDepth;
  cache.dfCullMode = cullMode;
  cache.dfPipelineFormatGeneration = sceneFormatGen;
  cache.dfNeedsTexture = shaderInfo.needsTexture === true;
  cache.dfIsLit = isLit;

  // Same clustered-lighting prepend the main material path applies, so a Lit
  // depthFail material that calls evalClusteredLights compiles identically.
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
  const shaderDefines = logDepth ? ShaderDefine.LOG_DEPTH : 0;
  cache.dfShaderModule = WebGPUShaderModule.create({
    device: device,
    code: preprocessShaderSource(materialCode, shaderDefines),
    label: `${shaderInfo.type} DepthFail Material Shader`,
  });

  cache.dfCameraBindGroupLayout = makeBindGroupLayout(
    device,
    "MatDepthFail Camera BGL",
    [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
  );
  cache.dfMaterialBindGroupLayout = makeBindGroupLayout(
    device,
    "MatDepthFail Material BGL",
    [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
  );

  const bindGroupLayouts = [
    cache.dfCameraBindGroupLayout,
    cache.dfMaterialBindGroupLayout,
  ];

  if (shaderInfo.needsTexture) {
    cache.dfTextureBindGroupLayout = makeBindGroupLayout(
      device,
      "MatDepthFail Texture BGL",
      [
        sampler(0, Stage.FRAGMENT),
        texture(1, Stage.FRAGMENT),
        texture(2, Stage.FRAGMENT),
      ],
    );
    bindGroupLayouts.push(cache.dfTextureBindGroupLayout);
  } else {
    cache.dfTextureBindGroupLayout = null;
  }

  // Trailing effects BGL — matches the main material pipeline layout so the
  // shared placeholder/active effects bind group slots line up.
  const dfEffectsBGL = getEffectsBindGroupLayout(device);
  bindGroupLayouts.push(dfEffectsBGL);
  cache.dfEffectsBGL = dfEffectsBGL;

  const canvasFormat =
    context.scenePipelineFormat || navigator.gpu.getPreferredCanvasFormat();
  cache.dfPipeline = device.createRenderPipeline({
    label: `${shaderInfo.type} DepthFail pipeline (cull=${cullMode})`,
    layout: device.createPipelineLayout({ bindGroupLayouts }),
    vertex: {
      module: cache.dfShaderModule.module,
      entryPoint: "vertexMain",
      buffers: [vertexLayout.layout],
    },
    fragment: {
      module: cache.dfShaderModule.module,
      entryPoint: "fragmentMain",
      targets: makeSceneFBTargets(canvasFormat, { translucent, blend }),
    },
    primitive: {
      topology,
      // Cull derived from the depth-fail appearance: 'back' for a
      // closed depthFail appearance (depthFail only where occluded → un-occluded
      // main pass survives), 'none' otherwise (back face shows through as x-ray).
      // Lines forced to 'none' (no front/back faces).
      cullMode,
      frontFace: "ccw",
    },
    depthStencil: {
      format: "depth24plus-stencil8",
      // Shade only fragments behind existing depth and never overwrite it.
      depthWriteEnabled: false,
      depthCompare: "greater",
    },
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
  posHighValues: NumArray,
  posLowValues: NumArray,
  normals: NumArray | undefined,
  uvs: NumArray | undefined,
  numVertices: number,
  isLit: boolean,
  normalCPA: number,
  stCPA: number,
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
  primitive: PrimitiveLike,
  appearance: AppearanceLike,
  material: MaterialLike,
  translucent: boolean,
  twoPasses: boolean,
  colorCommands: PrimitiveDrawCommand[],
  pickCommands: PrimitiveDrawCommand[],
  frameState: CesiumFrameState,
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
      // Log-depth state baked into the material pipeline.
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
      // Pick-log state baked into the pick pipeline.
      pickLogDepthEnabled: false,
      pickCameraBindGroupLayout: null,
      pickMaterialBindGroupLayout: null,
      pickCameraBuffers: [],
      pickCameraBindGroups: [],
      pickMaterialBuffers: [],
      pickMaterialBindGroups: [],
      // The depth-fail sub-cache mirrors the main material cache with its own
      // shader module, pipeline, material
      // UB + bind group, per-geometry vertex/camera buffers) but the pipeline
      // is built with depthCompare 'greater' + depthWriteEnabled false +
      // cull mode from the depth-fail appearance. It is populated only for a
      // material-based depth-fail appearance; null fields otherwise are intentional.
      dfShaderType: null,
      dfShaderModule: null,
      dfPipeline: null,
      dfCameraBindGroupLayout: null,
      dfMaterialBindGroupLayout: null,
      dfTextureBindGroupLayout: null,
      dfTextureBindGroup: null,
      dfEffectsBGL: null,
      dfMaterialBuffer: null,
      dfMaterialBindGroup: null,
      dfCameraBuffers: [],
      dfCameraBindGroups: [],
      dfVertexBuffers: [],
      dfTranslucent: undefined,
      dfPrimitiveTopology: undefined,
      dfClosed: undefined,
      dfCullMode: undefined,
      dfLogDepthEnabled: false,
      dfNeedsTexture: false,
      dfIsLit: false,
      _dfMaterialBufferSize: 0,
      _dfMatPrimarySource: undefined,
      _dfMatSecondarySource: undefined,
    };
  }
  const cache = primitive._webgpuCache;

  // `PolylineMaterialAppearance` reaches the material path
  // (PolylineMaterialAppearance has a `material`, so PrimitiveCommandHelpers
  // routes here, not to createWebGPUCommands). The geometry carries
  // `expandAndWidth` and previous/next positions. Route to a dedicated packer
  // and per-material FS that does the screen-space width expansion and feeds
  // v_st / v_width / v_polylineAngle to the material shader. Detected before
  // selectMaterialShader because that helper inspects normal/st
  // and would pick a surface material shader whose vertex layout
  // drops the polyline attributes.
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

  // Decode every geometry's `compressedAttributes` before downstream reads.
  // Doing this for all geometries up front (not just `firstGeom`) is
  // important: the shader-variant-selection below inspects the first
  // geometry's attribute presence, but later draw commands iterate the full
  // set and must see the same shape. The helper is idempotent.
  //
  // Pass a matching appearance `vertexFormat` because compression metadata can
  // be lost during combination and worker transfer; the hint prevents numeric
  // inference from dropping packed texture coordinates.
  const vf = defined(appearance) ? appearance.vertexFormat : undefined;
  const attributeHint = defined(vf)
    ? {
        hasSt: vf.st === true,
        hasNormal: vf.normal === true,
        hasTangent: vf.tangent === true,
        hasBitangent: vf.bitangent === true,
      }
    : undefined;
  for (let i = 0; i < geometries.length; i++) {
    ensureUncompressedAttributes(geometries[i], attributeHint);
  }

  const firstGeom = geometries[0];
  const attrs = firstGeom.attributes;
  const hasNormals = defined(attrs.normal) && defined(attrs.normal.values);
  const hasST = defined(attrs.st) && defined(attrs.st.values);
  const isFlat = defined(appearance.flat) ? appearance.flat : false;

  const shaderInfo: ShaderInfoLike = selectMaterialShader(
    material,
    isFlat,
    hasNormals,
    hasST,
  );
  const isLit =
    isMaterialLitShader(shaderInfo.type) || isPBRShader(shaderInfo.type);
  const vertexLayout = getMaterialVertexLayout(shaderInfo.type);
  const cameraBufferSize = isLit ? LIT_CAMERA_BYTES : FLAT_CAMERA_BYTES;

  // Material pipeline topology follows geometry topology; outlines require line
  // topology rather than triangle interpretation.
  const matPrimitiveTopology = mapCesiumPrimitiveTypeToWebGPU(
    firstGeom.primitiveType,
  );

  // Material and PBR shaders select log depth from scene state; their camera
  // writers already populate the matching tail.
  const logDepthActive = isWebGPULogDepthActive(context, frameState);

  // The EquirectangularPanorama cull override (#13369) applies on the
  // material path. A closed appearance can explicitly disable culling through
  // `renderState.cull.enabled: false`; the closed default loses to the user's
  // `false` through `combine(existing, rs, true)` in
  // `Appearance.getDefaultRenderState`.
  // A panorama is `closed: true` (sphere) viewed from inside, so it sets
  // `cull.enabled: false` to keep its inner faces visible. Folding the override
  // into the closed signal makes the pipeline's cull mode `none`, so the
  // interior renders instead of being culled blank, matching WebGL. Closed
  // volumes without the override (Box/Sphere/Ellipsoid/Cylinder defaults) keep
  // `cull.enabled: true` and still back-face cull.
  const cullExplicitlyDisabled =
    appearance?.renderState?.cull?.enabled === false;
  const closedAndCulled =
    appearance?.closed === true && !cullExplicitlyDisabled;

  // An opaque-declared material on a translucent-constructed appearance still
  // blends on WebGL, because `Appearance.getRenderState` never clears the
  // blend its constructor installed. Read that blend rather than inferring one
  // from the translucency flag.
  const appearanceBlend = resolveAppearanceBlend(
    appearance?.renderState,
    translucent,
  );

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
    appearanceBlend,
  );

  // Bind a real material texture or the context's 1×1 white fallback. Check on
  // every command creation so asynchronously loaded
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

  // A material-based depth-fail appearance gets one twin per geometry, using its
  // selected shader and greater/no-write depth state. Per-instance-color depth
  // fail remains handled by the non-material path.
  const depthFailAppearance = primitive._depthFailAppearance;
  const depthFailMaterial = primitive._depthFailMaterial;
  const hasDepthFailMaterial =
    defined(depthFailAppearance) && defined(depthFailMaterial);
  let dfShaderInfo;
  let dfIsLit = false;
  let dfVertexLayout;
  let dfCameraBufferSize = FLAT_CAMERA_BYTES;
  if (hasDepthFailMaterial) {
    // The depthFail appearance picks its own flat/lit + material shader. It
    // shares the geometry's normal/st presence with the main appearance, so
    // its vertex layout uses the same attributes but a dedicated buffer per
    // geometry. The depthFail shader may be flat while the main is lit, or
    // vice versa, giving a different stride; reusing the main VB
    // across a stride mismatch would misread the layout — the safe
    // faithful mirror is its own VB).
    const dfIsFlat = defined(depthFailAppearance.flat)
      ? depthFailAppearance.flat
      : false;
    dfShaderInfo = selectMaterialShader(
      depthFailMaterial,
      dfIsFlat,
      hasNormals,
      hasST,
    );
    dfIsLit =
      isMaterialLitShader(dfShaderInfo.type) || isPBRShader(dfShaderInfo.type);
    dfVertexLayout = getMaterialVertexLayout(dfShaderInfo.type);
    dfCameraBufferSize = dfIsLit ? LIT_CAMERA_BYTES : FLAT_CAMERA_BYTES;

    // Derive the depth-fail cull mode from the depth-fail appearance rather
    // than the main appearance or a hardcoded value. The depth-fail render
    // state IS `_depthFailAppearance.getRenderState()` (with depthTest.func →
    // GREATER), so its cull comes from the depthFail appearance's `closed` flag
    // via Appearance.getDefaultRenderState. Same shape as the main material
    // pipeline's `closedAndCulled`: a `closed:true` depthFail appearance
    // back-face culls (depthFail shows only where genuinely occluded → the
    // un-occluded main pass survives), an explicit `cull.enabled:false`
    // forces 'none' (panorama-style interior), and a non-closed default is
    // 'none' (x-ray back face).
    const dfCullExplicitlyDisabled =
      depthFailAppearance?.renderState?.cull?.enabled === false;
    const dfCullMode =
      depthFailAppearance?.closed === true && !dfCullExplicitlyDisabled
        ? "back"
        : "none";

    // The depth-fail render state IS `_depthFailAppearance.getRenderState()`,
    // so its blend comes from the depth-fail appearance, not the main one.
    const dfBlend = resolveAppearanceBlend(
      depthFailAppearance?.renderState,
      translucent,
    );

    const dfShaderChanged = createMaterialDepthFailPipeline(
      cache,
      device,
      dfShaderInfo,
      dfVertexLayout,
      context,
      dfIsLit,
      translucent,
      matPrimitiveTopology,
      logDepthActive,
      dfCullMode,
      dfBlend,
    );

    // Bind the depthFail material texture (if its shader is textured) into the
    // df texture slot. Called every build so async-loaded textures are picked
    // up; the helper keys on image identity. A thin adapter supplies the
    // depth-fail cache fields without a separate helper implementation.
    if (dfShaderInfo.needsTexture && defined(cache.dfTextureBindGroupLayout)) {
      ensureDepthFailMaterialTextureBindGroup(
        context,
        device,
        depthFailMaterial,
        dfShaderInfo.type,
        cache,
      );
    }

    // Build / upload the depthFail material UB from its packed gpuData.
    const dfMatUB = depthFailMaterial._uniformBuffer;
    const dfMatGpuData = defined(dfMatUB) ? dfMatUB.gpuData : undefined;
    const dfMatByteSize = defined(dfMatGpuData)
      ? Math.max(dfMatGpuData.byteLength, PLACEHOLDER_MATERIAL_BYTES)
      : PLACEHOLDER_MATERIAL_BYTES;
    if (
      !defined(cache.dfMaterialBuffer) ||
      cache._dfMaterialBufferSize !== dfMatByteSize ||
      dfShaderChanged
    ) {
      if (defined(cache.dfMaterialBuffer)) {
        cache.dfMaterialBuffer.destroy();
      }
      cache.dfMaterialBuffer = device.createBuffer({
        size: dfMatByteSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "MatDepthFail Material UB",
      });
      cache.dfMaterialUploadState = createMaterialUploadState();
      cache._dfMaterialBufferSize = dfMatByteSize;
      cache.dfMaterialBindGroup = null;
    }
    if (defined(dfMatGpuData)) {
      cache.dfMaterialUploadState ??= createMaterialUploadState();
      if (defined(dfMatUB)) {
        uploadMaterialUniformBuffer(
          device,
          cache.dfMaterialBuffer,
          dfMatUB,
          cache.dfMaterialUploadState,
        );
      } else {
        device.queue.writeBuffer(cache.dfMaterialBuffer, 0, dfMatGpuData);
      }
    } else {
      device.queue.writeBuffer(
        cache.dfMaterialBuffer,
        0,
        new Float32Array(dfMatByteSize / 4),
      );
    }
    if (!defined(cache.dfMaterialBindGroup)) {
      cache.dfMaterialBindGroup = device.createBindGroup({
        layout: cache.dfMaterialBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: cache.dfMaterialBuffer } }],
      });
    }
  }

  // Pick support (split camera/material bind groups)
  const pickIds = primitive._pickIds;
  const hasPickIds =
    primitive._allowPicking && defined(pickIds) && pickIds.length > 0;
  // Pick-log state is independent of scene-log state, so a pick-only change must
  // rebuild the pick pipeline even when the color pipeline is unchanged.
  const pickLogActive = isWebGPUPickLogDepthActive(context, frameState);
  const pickLogChanged = cache.pickLogDepthEnabled !== pickLogActive;
  if (hasPickIds && (shaderChanged || pickLogChanged)) {
    cache.pickLogDepthEnabled = pickLogActive;
    const pickCode = getMaterialPickShaderForType(shaderInfo.type);
    // Compile with log depth only while the pick fleet uses it; zero defines
    // selects hyperbolic depth.
    cache.pickShaderModule = WebGPUShaderModule.create({
      device,
      code: preprocessShaderSource(
        pickCode,
        pickLogActive ? ShaderDefine.LOG_DEPTH : 0,
      ),
      label: `${shaderInfo.type} MatPick${pickLogActive ? " [ld]" : ""}`,
    });

    // Keep pick camera data visible to both stages so material variants
    // share a compatible layout.
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

    // Pick pipelines target the context's byte-object-ID format so they
    // match the pick framebuffer.
    const fmt =
      context.pickPipelineFormat ??
      (navigator.gpu.getPreferredCanvasFormat() as GPUTextureFormat);
    cache.pickPipeline = device.createRenderPipeline({
      // Append `[ld]` to the log-depth material-pick label.
      label: `${shaderInfo.type} MatPick Pipeline${pickLogActive ? " [ld]" : ""}`,
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
      // Material-pick topology matches visual topology so outlines remain pickable.
      primitive: { topology: matPrimitiveTopology, cullMode: "none" },
      depthStencil: {
        format: "depth24plus-stencil8",
        // The shared pick framebuffer keeps depth writes enabled. Without a
        // fragment-depth output, hardware hyperbolic depth is unchanged.
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    });
  }

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
    cache.materialUploadState = createMaterialUploadState();
    cache._materialBufferSize = matByteSize;
    cache.materialBindGroup = null; // Force rebind
  }

  // Upload material data (only when dirty or first time)
  if (defined(matGpuData)) {
    cache.materialUploadState ??= createMaterialUploadState();
    if (defined(matUB)) {
      uploadMaterialUniformBuffer(
        device,
        cache.materialBuffer,
        matUB,
        cache.materialUploadState,
      );
    } else {
      device.queue.writeBuffer(cache.materialBuffer, 0, matGpuData);
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
    // Record where the texture group landed so the per-frame updater can
    // replace it once the material's image drains into `_imageSources`.
    let matTextureSlot: number | undefined;
    if (shaderInfo.needsTexture && defined(cache.textureBindGroup)) {
      matTextureSlot = cmdBGs.length;
      cmdBGs.push(cache.textureBindGroup);
    }
    // The trailing effects slot matches the pipeline layout
    // added in `createMaterialPipelineAndCache`. Starts on the
    // shared placeholder; `updateWebGPUMaterialCommandUniforms`
    // swaps in the active BG per frame when shadow / CSM is on.
    const matEffectsPlaceholder = getPlaceholderEffects(device);
    cmdBGs.push(matEffectsPlaceholder.bindGroup);

    // Forward appearance render state so dynamic encoder state applies.
    const cmd: PrimitiveDrawCommand = new WebGPUDrawCommand({
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
      owner: primitive as unknown as WebGPUCommandOwner,
      renderState: primitive.appearance?.renderState,
    });
    cmd._webgpuCameraBuffer = cache.cameraBuffers[i];
    cmd._webgpuShaderType = shaderInfo.type;
    // Reference the shared material buffer and wrapper so dirty, time-varying
    // materials are re-uploaded each frame as needed.
    cmd._webgpuMaterialBuffer = cache.materialBuffer;
    cmd._webgpuMaterialUB = matUB;
    cmd._webgpuMaterialUploadState = cache.materialUploadState;
    if (defined(matTextureSlot)) {
      cmd._webgpuMatCache = cache;
      cmd._webgpuMaterial = material;
      cmd._webgpuMatShaderType = shaderInfo.type;
      cmd._webgpuMatTextureSlot = matTextureSlot;
    }
    // Material vertices use the same model-space high/low prefix as color
    // primitives and therefore share the transform-aware cast resource.
    configurePrimitiveShadowCastCommand(cmd, cache, (isLit ? 11 : 8) * 4);
    validCommands.push(cmd);

    // Emit the depth-fail twin after the main material command. It owns the
    // vertex, camera, and material resources required by its selected shader;
    // its material shader tag lets the existing updater refresh
    // uniforms and effects bindings.
    if (hasDepthFailMaterial && defined(cache.dfPipeline)) {
      const dfVertexData = buildMaterialVertexData(
        posHighValues,
        posLowValues,
        normals,
        uvs,
        numVertices,
        dfIsLit,
        nCPA,
        sCPA,
      );
      if (!defined(cache.dfVertexBuffers[i]) || shaderChanged) {
        if (defined(cache.dfVertexBuffers[i])) {
          cache.dfVertexBuffers[i].destroy();
        }
        cache.dfVertexBuffers[i] = WebGPUBuffer.createVertexBuffer(
          device,
          dfVertexData,
          `MatDepthFail VB ${i}`,
        );
      }

      if (!defined(cache.dfCameraBuffers[i])) {
        cache.dfCameraBuffers[i] = device.createBuffer({
          size: dfCameraBufferSize,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: `MatDepthFail Camera UB ${i}`,
        });
      }
      const dfCameraData = new Float32Array(dfCameraBufferSize / 4);
      if (dfIsLit) {
        writeRTEUniformsLit(dfCameraData, rte, context.uniformState);
      } else {
        writeRTEUniformsFlat(dfCameraData, rte, context.uniformState);
      }
      device.queue.writeBuffer(cache.dfCameraBuffers[i], 0, dfCameraData);
      cache.dfCameraBindGroups[i] = device.createBindGroup({
        layout: cache.dfCameraBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: cache.dfCameraBuffers[i] } },
        ],
      });

      const dfBGs = [cache.dfCameraBindGroups[i], cache.dfMaterialBindGroup];
      let dfTextureSlot: number | undefined;
      if (cache.dfNeedsTexture && defined(cache.dfTextureBindGroup)) {
        dfTextureSlot = dfBGs.length;
        dfBGs.push(cache.dfTextureBindGroup);
      }
      const dfEffectsPlaceholder = getPlaceholderEffects(device);
      dfBGs.push(dfEffectsPlaceholder.bindGroup);

      const dfCmd: PrimitiveDrawCommand = new WebGPUDrawCommand({
        pipeline: cache.dfPipeline,
        bindGroups: dfBGs,
        vertexBuffer: cache.dfVertexBuffers[i],
        indexBuffer: cache.indexBuffers[i],
        indexFormat: cache.indexFormats[i],
        vertexCount: defined(cache.indexBuffers[i]) ? undefined : numVertices,
        indexCount: defined(cache.indexBuffers[i])
          ? cache.indexCounts[i]
          : undefined,
        pass,
        owner: primitive as unknown as WebGPUCommandOwner,
        renderState: depthFailAppearance?.renderState,
      });
      dfCmd._webgpuCameraBuffer = cache.dfCameraBuffers[i];
      // Real `mat*`/`pbr*` type → per-frame update dispatch + material re-upload.
      dfCmd._webgpuShaderType = dfShaderInfo.type;
      dfCmd._webgpuMaterialBuffer = cache.dfMaterialBuffer;
      dfCmd._webgpuMaterialUB = depthFailMaterial._uniformBuffer;
      dfCmd._webgpuMaterialUploadState = cache.dfMaterialUploadState;
      // When the depth-fail shader is textured, its texture occupies
      // the last bind-group slot (no effects group is consumed there), so the
      // effects-slot refresh must skip it (else it clobbers the texture).
      dfCmd._noEffectsSlot = cache.dfNeedsTexture === true;
      if (defined(dfTextureSlot)) {
        dfCmd._webgpuMatCache = cache;
        dfCmd._webgpuMaterial = depthFailMaterial;
        dfCmd._webgpuMatShaderType = dfShaderInfo.type;
        dfCmd._webgpuMatTextureSlot = dfTextureSlot;
        dfCmd._webgpuMatTextureIsDepthFail = true;
      }
      dfCmd._label = "depth-fail material pass";
      configurePrimitiveShadowCastCommand(dfCmd, cache, (dfIsLit ? 11 : 8) * 4);
      validCommands.push(dfCmd);
    }

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
      writeRTEUniformsFlatHead(pickCameraData, rte, context.uniformState);
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

      const pickCmd: PrimitiveDrawCommand = new WebGPUDrawCommand({
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
        owner: primitive as unknown as WebGPUCommandOwner,
        // Material-pick commands forward render state for dynamic encoder state;
        // pick format, depth writes, and blending remain pipeline-baked.
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
// 108 floats = 432 bytes for the lit/PBR camera UBO (mvpRTE+mvRTE+normalMatrix
// +camHigh+camLow+lightDir+prevVP+inverseViewQuaternion+logDepth+inverseRadii
// +modelMatrix3+worldCamera; writeRTEUniformsLit writes through float 107).
// Sized for the larger of the two
// layouts; flat/material shaders fit comfortably in the same scratch (flat
// writes through float 67 for its world-camera-low tail).
const scratchMaterialCameraData = new Float32Array(
  LIT_CAMERA_BYTES / Float32Array.BYTES_PER_ELEMENT,
);

/**
 * Updates camera matrices for a material/PBR draw command each frame.
 * Material parameters are in a separate bind group — only camera data needs per-frame update.
 * @private
 */
function updateWebGPUMaterialCommandUniforms(
  command: PrimitiveDrawCommand,
  frameState: CesiumFrameState,
  modelMatrix: Matrix4,
) {
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
  _refreshPrimitiveShadowCastTransform(
    device,
    command,
    frameState,
    modelMatrix,
    rte,
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

  // Re-upload the material UBO when `_uniformBuffer` is dirty.
  // `Material.update()` recomputes time-varying uniforms such as water time,
  // dash pattern, and glow phase after command creation; skipping this upload
  // would freeze those materials at their initial values.
  const matUB = command._webgpuMaterialUB;
  const matBuffer = command._webgpuMaterialBuffer;
  if (defined(matUB) && defined(matBuffer)) {
    command._webgpuMaterialUploadState ??= createMaterialUploadState();
    uploadMaterialUniformBuffer(
      device,
      matBuffer,
      matUB,
      command._webgpuMaterialUploadState,
    );
  }

  // Adopt the material's image the frame after it drains into
  // `_imageSources`. The command was built before that could happen, so
  // without this the texture slot keeps the 1x1 placeholder forever.
  refreshMaterialCommandTextureSlot(command, context, device);

  // Swap the effects bind group for this frame so shadow-
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
  writeRTEUniformsFlat,
  writeRTEUniformsLit,
  FLAT_CAMERA_BYTES,
  FLAT_ELLIPSOID_ONE_OVER_RADII_OFFSET,
  FLAT_MODEL_MATRIX_COLUMN_0_OFFSET,
  FLAT_ENCODED_CAMERA_WORLD_HIGH_OFFSET,
  FLAT_ENCODED_CAMERA_WORLD_LOW_OFFSET,
  FLAT_PIXEL_RATIO_OFFSET,
  PICK_CAMERA_BYTES,
  LIT_CAMERA_BYTES,
  LIT_PREVIOUS_VIEW_PROJECTION_OFFSET,
  LIT_INVERSE_VIEW_QUATERNION_OFFSET,
  LIT_LOG_DEPTH_OFFSET,
  LIT_ELLIPSOID_ONE_OVER_RADII_OFFSET,
  LIT_MODEL_MATRIX_COLUMN_0_OFFSET,
  LIT_ENCODED_CAMERA_WORLD_HIGH_OFFSET,
  LIT_ENCODED_CAMERA_WORLD_LOW_OFFSET,
  LIT_PIXEL_RATIO_OFFSET,
  // Share the per-frame effects resolver with voxel, Gaussian-splat, and
  // point-cloud renderers, centralizing toggle hashing and placeholder fallback.
  _getOrCreateSharedPrimitiveEffectsBG as getOrCreateSharedAdvancedEffectsBG,
};
