/**
 * Comprehensive WebGPU rendering of glTF Model instances with full PBR support.
 *
 * Architecture:
 * - Model.update() runs the WebGL pipeline stages → populates renderResources
 * - Model.submitDrawCommands() delegates to this renderer via feature renderer
 * - We use shared extractors (ModelMaterialInfo, ModelPrimitiveGeometry,
 *   ModelSkinData) for renderer-agnostic data, then create WebGPU GPU resources
 *
 * Supports:
 * - Metallic-Roughness PBR (baseColor, normal, MR, emissive, occlusion textures)
 * - Specular-Glossiness PBR (diffuse, specGloss textures)
 * - Unlit materials
 * - Alpha modes (OPAQUE, MASK, BLEND)
 * - Double-sided rendering
 * - Vertex colors
 * - Normal mapping via tangent space
 * - Model-space RTE (camera encoded in model space, NOT per-vertex high/low)
 * - Skeletal animation / Skinning (joint matrices via storage buffer)
 *
 * @private
 * @module WebGPUModelRenderer
 */
import BoundingSphere from "../../Core/BoundingSphere.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix3 from "../../Core/Matrix3.js";
import Matrix4 from "../../Core/Matrix4.js";
import oneTimeWarning from "../../Core/oneTimeWarning.js";
import PrimitiveType from "../../Core/PrimitiveType.js";
import {
  extractMaterialInfo,
  AlphaModes,
  MaterialFlags,
} from "../../Scene/Model/ModelMaterialInfo.js";
import {
  createPrimitiveGeometryView,
  extractPrimitiveGeometry,
  normalizeColorData,
  resetPrimitiveGeometryView,
} from "../../Scene/Model/ModelPrimitiveGeometry.js";
import {
  computeReference2DPosition,
  projectPositionsTo2D,
} from "../../Scene/Model/SceneMode2DPipelineStage.js";
import {
  extractSkinData,
  updatePackedJointMatrices,
} from "../../Scene/Model/ModelSkinData.js";
import {
  ensureMorphTargetResources,
  destroyMorphTargetResources,
} from "./WebGPUModelMorphTargets.js";
import {
  ensureInstancingResources,
  destroyInstancingResources,
} from "./WebGPUModelInstancing.js";
import {
  ensureFeatureIdResources,
  destroyFeatureIdResources,
  getSelectedImplicitFeatureId,
  synthesizeImplicitFeatureIdData,
} from "./WebGPUModelFeatureId.js";
import {
  ensureMetadataResources,
  destroyMetadataResources,
  ensurePropertyTextureResources,
  ensurePropertyTableResources,
} from "./WebGPUModelMetadata.js";
import { resolveWebGPUModelMetadata } from "./WebGPUModelMetadataCache.js";
import { generateMetadataPickWGSL } from "../../Scene/Model/MetadataWGSLPipelineStage.js";
// PARITY-CUSTOM-SHADER-WGSL — native-WGSL customShader codegen + uniform packing
// + shared binding numbers.
import {
  generateCustomShaderWGSL,
  packUniformBuffer,
  CUSTOM_SHADER_UBO_BINDING,
  CUSTOM_SHADER_TEXTURE_BINDING_BASE,
  CUSTOM_SHADER_SAMPLER_BINDING,
  MAX_CUSTOM_TEXTURES,
} from "../../Scene/Model/CustomShaderWGSLPipelineStage.js";
// PARITY-CUSTOM-SHADER-WGSL (translucencyMode slice) — the CustomShader
// translucency knob that WebGL's CustomShaderPipelineStage applies via
// alphaOptions.pass. Values: INHERIT (0) / OPAQUE (1) / TRANSLUCENT (2).
import CustomShaderTranslucencyMode from "../../Scene/Model/CustomShaderTranslucencyMode.js";
import Pass from "../Pass.js";
import ColorBlendMode from "../../Scene/ColorBlendMode.js";
import SceneMode from "../../Scene/SceneMode.js";
// WIRE-MODEL-SILHOUETTE — shared silhouette-ID counter (WebGL's
// ModelSilhouettePipelineStage assigns `model._silhouetteId` from this
// static counter; on WebGPU the same stage runs during the shared
// scene-graph draw-command build, so we only assign here as a fallback
// when the stage hasn't run yet — sharing the counter keeps stencil
// references unique across both backends).
import ModelSilhouettePipelineStage from "../../Scene/Model/ModelSilhouettePipelineStage.js";
import EdgeDisplayMode from "../../Scene/EdgeDisplayMode.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import { WebGPUMipmapGenerator } from "./WebGPUMipmapGenerator.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
// C2-25 ENV-SCENE-CAPTURE (Batch 447) — per-frame uniform ring allocator. The
// capture pass packs a face-camera UB per visible primitive per face; it MUST
// ride the ring (not `cache.cameraBuffer`/`nc.cameraBuffer`, which the main
// pass reads later this same frame) because capture precedes the main render.
import { writeUniformSlice } from "./WebGPUGlobeSurfaceCameraUB.js";
import WebGPUModelPipelineCache from "./WebGPUModelPipelineCache.js";
import { createEffectsBindGroup } from "./WebGPUEffectsBindGroup.js";
import { ShaderDefine } from "./WebGPUShaderDefines.js";
import {
  isWebGPULogDepthActive,
  packCameraLogDepthLanes,
} from "./WebGPULogDepth.js";
import {
  attachPickToColorCommand,
  attachPickVariantsToColorCommand,
  attachPickMetadataToColorCommand,
  destroyPickIds,
  ensurePickId,
} from "./WebGPUPickCommandHelpers.js";
import {
  extractEdgeGeometry,
  createEdgeEmitterCache,
  destroyEdgeEmitterCache,
  ensureEdgeEmitterPipeline,
  createEdgePrimitiveResources,
  destroyEdgePrimitiveResources,
  writeEdgeEmitterUniforms,
  type EdgeEmitterCache,
  type EdgePrimitiveResources,
} from "./WebGPUEdgeVisibilityEmitter.js";
import type { DrawCommandWithDerivedSlot } from "./WebGPUPickCommandHelpers.js";

// Constructor argument type for WebGPUDrawCommand (the options interface is not
// exported); command-arg literals carry renderer-attached extras this façade
// intentionally does not narrow.
type WebGPUDrawArgs = ConstructorParameters<typeof WebGPUDrawCommand>[0];

// ─── JS-interop typed façades ────────────────────────────────────────────────
// Type-only shapes over the untyped-JS extractor output (extractMaterialInfo /
// extractPrimitiveGeometry / extractSkinData) and the per-model / per-primitive
// GPU-resource caches this renderer owns. They carry no runtime code — the TS
// conversion emits byte-identical JavaScript.

type TypedArray =
  | Float32Array
  | Float64Array
  | Uint32Array
  | Uint16Array
  | Uint8Array
  | Int32Array
  | Int16Array
  | Int8Array;
type NumArray = TypedArray | number[];
type Vec = number[] | Float32Array;
type GPUBufferOrNull = GPUBuffer | null;
type GPUPipelineOrNull = GPURenderPipeline | null;

interface ImageSourceLike {
  width?: number;
  naturalWidth?: number;
  height?: number;
  naturalHeight?: number;
}

interface ColorLike {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

interface SamplerLike {
  // Cesium `Sampler` uses `minificationFilter`; a raw glTF sampler uses
  // `minFilter`. Read both (mirrors `getSamplerForReader`).
  minificationFilter?: number;
  minFilter?: number;
}
interface TextureReaderLike {
  texture?: {
    _texture?: {
      _webgpuTexture?: { texture?: GPUTexture | null } | null;
    } | null;
    _source?: ImageSourceLike | null;
    source?: ImageSourceLike | null;
    _image?: ImageSourceLike | null;
    _sampler?: SamplerLike | null;
    sampler?: SamplerLike | null;
  } | null;
  sampler?: SamplerLike | null;
  texCoord?: number;
  transform?: ArrayLike<number> | null;
}
type ReaderOrNull = TextureReaderLike | null | undefined;

interface MaterialInfo {
  materialFlags: number;
  alphaMode: number;
  alphaCutoff: number;
  isDoubleSided: boolean;
  baseColorFactor: Vec;
  metallicFactor: number;
  roughnessFactor: number;
  normalScale: number;
  occlusionStrength: number;
  emissiveFactor: Vec;
  diffuseFactor: Vec;
  specularFactor: Vec;
  glossinessFactor: number;
  hasClearcoat: boolean;
  clearcoatFactor: number;
  clearcoatRoughnessFactor: number;
  clearcoatNormalScale: number;
  hasSpecularExt: boolean;
  specularExtFactor: number;
  specularExtColorFactor: Vec;
  hasAnisotropy: boolean;
  anisotropyStrength: number;
  anisotropyRotation: number;
  hasIridescence: boolean;
  iridescenceFactor: number;
  iridescenceIor: number;
  iridescenceThicknessMinimum: number;
  iridescenceThicknessMaximum: number;
  hasSheen: boolean;
  sheenColorFactor: Vec;
  sheenRoughnessFactor: number;
  hasVolume: boolean;
  thicknessFactor: number;
  attenuationDistance: number;
  attenuationColor: Vec;
  hasTransmission: boolean;
  transmissionFactor: number;
  baseColorTextureReader?: ReaderOrNull;
  diffuseTextureReader?: ReaderOrNull;
  normalTextureReader?: ReaderOrNull;
  metallicRoughnessTextureReader?: ReaderOrNull;
  specGlossTextureReader?: ReaderOrNull;
  emissiveTextureReader?: ReaderOrNull;
  occlusionTextureReader?: ReaderOrNull;
  clearcoatTextureReader?: ReaderOrNull;
  clearcoatRoughnessTextureReader?: ReaderOrNull;
  clearcoatNormalTextureReader?: ReaderOrNull;
  specularExtTextureReader?: ReaderOrNull;
  specularExtColorTextureReader?: ReaderOrNull;
  anisotropyTextureReader?: ReaderOrNull;
  iridescenceTextureReader?: ReaderOrNull;
  iridescenceThicknessTextureReader?: ReaderOrNull;
  sheenColorTextureReader?: ReaderOrNull;
  sheenRoughnessTextureReader?: ReaderOrNull;
  transmissionTextureReader?: ReaderOrNull;
  thicknessTextureReader?: ReaderOrNull;
}

interface PrimitiveGeometry {
  vertexCount: number;
  indexCount: number;
  indexType: string | number;
  indexData?: Uint16Array | Uint32Array | null;
  primitiveType: number;
  morphTargetCount: number;
  positionData?: Float32Array | null;
  normalData?: Float32Array | null;
  tangentData?: Float32Array | null;
  texCoord0Data?: Float32Array | null;
  texCoord1Data?: Float32Array | null;
  color0Data?: TypedArray | null;
  color0ComponentType?: string;
  color0ComponentCount?: number;
  color0Normalized?: boolean;
  joints0Data?: TypedArray | null;
  weights0Data?: Float32Array | null;
  featureId0Data?: Float32Array | null;
  metadataData?: TypedArray | null;
  metadataClassHash?: number;
  metadataWGSL?: string | null;
  metadataMatTransport?: boolean;
  propertyTableLayout?: unknown;
  propertyTextureLayout?: unknown;
  hasNormals: boolean;
  hasTangents: boolean;
  hasTexCoord0: boolean;
  hasTexCoord1: boolean;
  hasColor0: boolean;
  hasJoints: boolean;
  hasFeatureId0: boolean;
  hasMetadata: boolean;
  hasPropertyTables: boolean;
  hasPropertyTextures: boolean;
}

interface PrimitiveGeometryViewRecord {
  base: PrimitiveGeometry;
  view: PrimitiveGeometry;
  implicitFeatureIdSource?: object | null;
  implicitFeatureIdOffset?: number;
  implicitFeatureIdRepeat?: number;
  implicitFeatureIdVertexCount?: number;
  implicitFeatureIdData?: Float32Array | null;
}

interface ModelMetadataDescriptor {
  metadataData?: Float32Array;
  propertyTextureLayout?: unknown;
  propertyTableLayout?: unknown;
  metadataWGSL?: string;
  metadataClassHash: number;
  metadataMatTransport: boolean;
  hasMetadata: boolean;
  hasPropertyTextures: boolean;
  hasPropertyTables: boolean;
}

interface PrimitiveRenderData {
  positionBuffer: GPUBufferOrNull;
  positionBuffer2D?: GPUBufferOrNull;
  normalBuffer: GPUBufferOrNull;
  tangentBuffer: GPUBufferOrNull;
  uvBuffer: GPUBufferOrNull;
  uv1Buffer?: GPUBufferOrNull;
  colorBuffer: GPUBufferOrNull;
  jointsBuffer: GPUBufferOrNull;
  weightsBuffer: GPUBufferOrNull;
  featureIdBuffer: GPUBufferOrNull;
  indexBuffer: GPUBufferOrNull;
  _metadataBuffer: GPUBufferOrNull;
  materialBuffer?: WebGPUBuffer | null;
  materialBufferSilhouette?: WebGPUBuffer | null;
  materialBufferTranslucent?: WebGPUBuffer | null;
  lightBuffer?: WebGPUBuffer | null;
  materialData?: Float32Array | null;
  materialDataSilhouette?: Float32Array | null;
  materialDataTranslucent?: Float32Array | null;
  lightData?: Float32Array | null;
  _metadataMatTransport: boolean;
  _propertyTextureResources: unknown;
  propertyTextureEntries: GPUBindGroupEntry[] | null;
  _propertyTableResources: unknown;
  propertyTableEntries: GPUBindGroupEntry[] | null;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  vertexCount: number;
  topology: GPUPrimitiveTopology;
  materialBindGroup: GPUBindGroup | null;
  textureBindGroup: GPUBindGroup | null;
  pipeline: GPUPipelineOrNull;
  depthWritePipeline?: GPUPipelineOrNull;
  pickPipeline?: GPUPipelineOrNull;
  pickHoverPipeline?: GPUPipelineOrNull;
  pickPrecisePass1Pipeline?: GPUPipelineOrNull;
  pickPrecisePass2Pipeline?: GPUPipelineOrNull;
  silhouettePipeline?: GPUPipelineOrNull;
  silhouetteColorPipeline?: GPUPipelineOrNull;
  translucentPipeline?: GPUPipelineOrNull;
  velocityPipeline?: GPUPipelineOrNull;
  gpuTextures: GPUTexture[];
  textureViews?: Record<string, GPUTextureView | null> | null;
  textureSamplers?: Record<string, GPUSampler | null> | null;
  textureEntries?: GPUBindGroupEntry[] | null;
  placeholderSlots?: Set<string>;
  matInfo?: MaterialInfo;
  materialDefines?: number;
  hasSkinningAttributes: boolean;
  refractionViewBound?: GPUTextureView | null;
  edgeResources?: EdgePrimitiveResources | false | null;
  _customShaderWGSL?: string | null;
  _customShaderClassHash?: number;
  _metadataWGSL?: string | null;
  _metadataClassHash?: number;
  _project2DRefKey?: string | number | null;
  _pipelineNeedsRefetch?: boolean;
  _fetchedErrorGen?: number;
  _geometryBase?: PrimitiveGeometry;
  _geometryAnnotationMask?: number;
  _featureIdData?: Float32Array | null;
  _metadataDescriptor?: ModelMetadataDescriptor;
  _mergedInstanceBindGroupCache?: MergedInstanceBindGroupCache;
  // C9-17 Slice A — merged group-1 (material) bind-group cache, one slot per
  // material-buffer variant so silhouette/translucent never alias the primary.
  _mergedMaterialBindGroupCache?: MergedMaterialBindGroupCache;
  _mergedMaterialBindGroupCacheSilhouette?: MergedMaterialBindGroupCache;
  _mergedMaterialBindGroupCacheTranslucent?: MergedMaterialBindGroupCache;
}

interface MergedMaterialBindGroupCache {
  device: GPUDevice;
  layout: GPUBindGroupLayout;
  materialBuffer: WebGPUBuffer | null;
  lightBuffer: WebGPUBuffer | null;
  textureEntries: GPUBindGroupEntry[] | null | undefined;
  featureIdEntries: GPUBindGroupEntry[] | null | undefined;
  iblEntries: GPUBindGroupEntry[] | null | undefined;
  bindGroup: GPUBindGroup;
}

interface MergedInstanceBindGroupCache {
  device: GPUDevice;
  layout: GPUBindGroupLayout;
  jointBuffer: GPUBuffer;
  morphDeltaBuffer: GPUBuffer;
  morphWeightBuffer: GPUBuffer;
  instanceBuffer: GPUBuffer;
  prevJointBuffer: GPUBuffer;
  prevMorphWeightBuffer: GPUBuffer;
  prevInstanceBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
}

interface SkinData {
  jointCount?: number;
  packedJointMatrices?: Float32Array | null;
  byteLength?: number;
}

// Fields shared by the per-node cache and (for identity-transform models) the
// model-level cache when hosting the SCENE2D IDL-duplicate camera resources.
interface Idl2DHost {
  cameraBuffer2DIdl?: WebGPUBuffer | null;
  cameraData2DIdl?: Float32Array | null;
  cameraBG2DIdl?: GPUBindGroup | null;
  idlModelMatrix2D?: Matrix4 | null;
  idlBoundingSphere2D?: BoundingSphere | null;
}

interface NodeCache extends Idl2DHost {
  jointBuffer?: GPUBufferOrNull;
  prevJointBuffer?: GPUBufferOrNull;
  instancingBuffer?: GPUBufferOrNull;
  jointBufferSize?: number;
  packedJointMatrices?: Float32Array | null;
  prevPackedJointMatrices?: Float32Array | null;
  cameraBuffer?: WebGPUBuffer | null;
  cameraData?: Float32Array | null;
  cameraBG?: GPUBindGroup | null;
  skinningBG?: GPUBindGroup | null;
  prevNodeModelMatrix?: Matrix4 | null;
}

interface PipelineCacheLike {
  cameraBGL: GPUBindGroupLayout;
  instanceBGL: GPUBindGroupLayout;
  defaultInstanceBindGroup: GPUBindGroup;
  defaultSampler: GPUSampler;
  defaultWhiteTexture: GPUTexture;
  defaultBlackTexture: GPUTexture;
  defaultNormalTexture: GPUTexture;
  defaultPropertyTexture: GPUTexture;
  defaultBrdfLutView: GPUTextureView;
  defaultBrdfLutSampler: GPUSampler;
  defaultIBLCubemapView: GPUTextureView;
  defaultIBLSampler: GPUSampler;
  defaultSHBuffer: GPUBuffer;
  defaultColorBuffer: GPUBuffer;
  defaultNormalBuffer: GPUBuffer;
  defaultTangentBuffer: GPUBuffer;
  defaultUVBuffer: GPUBuffer;
  defaultJointBuffer: GPUBuffer;
  defaultJointsBuffer: GPUBuffer;
  defaultWeightsBuffer: GPUBuffer;
  defaultInstancingBuffer: GPUBuffer;
  defaultMorphDeltaBuffer: GPUBuffer;
  defaultMorphWeightBuffer: GPUBuffer;
  defaultFeatureIdBuffer: GPUBuffer;
  defaultFeatureIdEntries(...args: unknown[]): GPUBindGroupEntry[];
  propertyTextureSampler: GPUSampler;
  propertyTextureEntries(...args: unknown[]): GPUBindGroupEntry[];
  propertyTableEntries(...args: unknown[]): GPUBindGroupEntry[];
  clearCustomShaderWGSL(...args: unknown[]): void;
  clearMetadataWGSL(...args: unknown[]): void;
  _errorSwapGeneration: number;
  _sceneFormatGeneration: number;
  getPipeline(...args: unknown[]): GPURenderPipeline;
  getDepthWritePipeline(...args: unknown[]): GPURenderPipeline;
  getClassificationPipeline(...args: unknown[]): GPURenderPipeline;
  getCapturePipeline(...args: unknown[]): GPURenderPipeline;
  getPickPipeline(...args: unknown[]): GPURenderPipeline;
  getPickHoverPipeline(...args: unknown[]): GPURenderPipeline;
  getPickMetadataPipeline(...args: unknown[]): GPURenderPipeline;
  getPickPrecisePass1Pipeline(...args: unknown[]): GPURenderPipeline;
  getPickPrecisePass2Pipeline(...args: unknown[]): GPURenderPipeline;
  getSilhouetteColorPipeline(...args: unknown[]): GPURenderPipeline;
  getSilhouetteModelPipeline(...args: unknown[]): GPURenderPipeline;
  getVelocityPipeline(...args: unknown[]): GPURenderPipeline;
  getOrCreateMaterialBGL(...args: unknown[]): GPUBindGroupLayout;
  getSamplerForReader(...args: unknown[]): GPUSampler;
  setPrimitiveTopology(...args: unknown[]): void;
  setCustomShaderWGSL(...args: unknown[]): void;
  setMetadataWGSL(...args: unknown[]): void;
  setMetadataPickWGSL(...args: unknown[]): void;
  maybeUpdateForLogDepth(...args: unknown[]): boolean;
  maybeUpdateForModelColor(...args: unknown[]): boolean;
  maybeUpdateForSceneFormat(...args: unknown[]): boolean;
  maybeUpdateForSilhouette(...args: unknown[]): boolean;
  maybeUpdateForSplit(...args: unknown[]): boolean;
  destroy(...args: unknown[]): void;
}

interface ModelWebGPUCache extends Idl2DHost {
  primitives: { [key: string]: PrimitiveRenderData };
  geometryViews?: { [key: string]: PrimitiveGeometryViewRecord };
  nodes: { [key: string]: NodeCache };
  pipelineCache: PipelineCacheLike;
  cameraBuffer?: WebGPUBuffer | null;
  cameraBG?: GPUBindGroup | null;
  cameraData?: Float32Array | null;
  effectsBG?: GPUBindGroup | null;
  edgeEmitterCache?: EdgeEmitterCache | null;
  hasEdgeFeatureIds?: boolean;
  prevModelMatrix?: Matrix4 | null;
  shadowCastData?: Float32Array | null;
  shadowCastUB?: WebGPUBuffer | null;
  _project2DActive?: boolean;
  _project2DBoundingSphere?: BoundingSphere | null;
  _project2DMatrix?: Matrix4 | null;
  _project2DRefKey?: string | number | null;
  _project2DReference?: Cartesian3 | null;
  _customShader?: CustomShaderResourcesLike | null;
  // C9-17 Slice A — memoized per-model IBL entries array + the five resolved
  // identities that produced it (see getOrCreateModelIBLEntries).
  _iblEntriesMemo?: IBLEntriesMemo;
}

interface IBLEntriesMemo {
  diffuseView: GPUTextureView;
  specularView: GPUTextureView;
  sampler: GPUSampler;
  shBuffer: GPUBuffer;
  brdfLutView: GPUTextureView;
  entries: GPUBindGroupEntry[];
}

interface CustomShaderLike {
  translucencyMode?: number;
  wgslVertexShaderText?: string;
  wgslFragmentShaderText?: string;
  _textureManager?: {
    getTexture(name: string): {
      _webgpuTexture?: { view?: GPUTextureView | null } | null;
    } | null;
  } | null;
}

interface SceneGraphLike {
  _runtimeNodes?: RuntimeNodeLike[];
  _computedModelMatrix?: Matrix4;
  _computedModelMatrix2D?: Matrix4;
  _boundingSphere2D?: BoundingSphere | null;
}

interface RuntimeNodeLike {
  runtimePrimitives?: RuntimePrimitiveLike[];
  computedTransform?: Matrix4;
  transform?: Matrix4;
  node?: { instances?: unknown } | null;
  _node?: { instances?: unknown } | null;
  morphWeights?: ArrayLike<number> | null;
  _morphWeights?: ArrayLike<number> | null;
}

interface GltfPrimitiveLike {
  attributes?: Array<{ semantic?: string; [key: string]: unknown }>;
  featureIds?: Array<{ setIndex?: number; [key: string]: unknown }>;
  mode?: number;
  [key: string]: unknown;
}

interface RuntimePrimitiveLike {
  boundingSphere2D?: BoundingSphere;
  primitive?: GltfPrimitiveLike | null;
  _primitive?: GltfPrimitiveLike | null;
  drawCommand?: {
    _command?: { renderState?: Record<string, unknown> };
  } | null;
}

interface ModelLike {
  // Declared so ModelLike satisfies the weak `WebGPUCommandOwner` shape when a
  // Model is passed as a draw command's `owner`.
  constructor?: { name?: string };
  _sceneGraph?: SceneGraphLike;
  modelMatrix: Matrix4;
  classificationType?: number;
  _cull?: boolean;
  customShader?: CustomShaderLike;
  color?: ColorLike;
  _webgpuCache?: ModelWebGPUCache;
  _silhouetteId?: number;
  splitDirection?: number;
  silhouetteSize?: number;
  silhouetteColor?: ColorLike;
  opaquePass?: number;
  structuralMetadata?: unknown;
  shadows?: number;
  isDestroyed?: () => boolean;
  depthWriteForTranslucentPicking?: boolean;
  clippingPolygons?: ClippingCollectionLike | null;
  clippingPlanes?: ClippingCollectionLike | null;
  _clippingPolygons?: ClippingCollectionLike | null;
  _clippingPlanes?: ClippingCollectionLike | null;
  boundingSphere?: BoundingSphere;
  show?: boolean;
  ready?: boolean;
  lightsFromGltf?: boolean;
  isInvisible?: () => boolean;
  featureTableId?: number;
  edgeDisplayMode?: number;
  computedScale?: number;
  colorBlendMode?: number;
  colorBlendAmount?: number;
  _projectTo2D?: boolean;
  _iblReferenceFrameMatrix?: ArrayLike<number> | null;
  _edgeLineWidth?: number;
  _edgeLinePattern?: number;
  environmentMapManager?: EnvironmentMapManagerLike | null;
  _imageBasedLighting?: ImageBasedLightingLike | null;
}

// Dynamic slots this renderer attaches onto WebGPUDrawCommand instances (read
// back by the shadow-map / scene / velocity passes). Kept as a type-only
// intersection so the emitted JS is unchanged.
type ModelDrawCommand = WebGPUDrawCommand & {
  _shadowCastLayout?: string;
  _shadowCastModelUB?: unknown;
  _shadowCastJointMatricesSB?: unknown;
  _shadowCastInstancingSB?: unknown;
  velocityCommand?: unknown;
  derivedCommands?: DrawCommandWithDerivedSlot["derivedCommands"];
};

// Return shapes of the untyped-JS resource helpers (declared `@returns {object}`).
declare global {
  interface CesiumFrameState {
    useHDR?: boolean;
    atmosphereSkyIrradiance?: { x: number; y: number; z: number } | null;
    scene?: {
      _webgpuPickHoverEnabled?: boolean;
      [key: string]: unknown;
    } | null;
    pickedMetadataInfo?: { propertyName?: string } | null;
  }
  interface CesiumUniformState {
    view3D?: Matrix4;
    inverseViewRotation?: ArrayLike<number> | null;
  }
}

interface InstancingResourcesLike {
  instanceCount?: number;
  storageBuffer?: GPUBufferOrNull;
}
interface MorphTargetResourcesLike {
  storageBuffer?: GPUBufferOrNull;
  weightBuffer?: GPUBufferOrNull;
  weightBufferPrev?: GPUBufferOrNull;
}
interface FeatureIdResourcesLike {
  flags?: number;
  featureIdEntries?: GPUBindGroupEntry[] | null;
}
interface CaptureRecord {
  indexBuffer?: GPUBufferOrNull;
  indexCount?: number;
  nodeModelMatrix?: Matrix4;
  materialBuffer?: WebGPUBuffer | null;
  lightBuffer?: WebGPUBuffer | null;
  textureEntries?: GPUBindGroupEntry[] | null;
  featureIdEntries?: GPUBindGroupEntry[] | null;
  materialDefines?: number;
  metadataWGSL?: string | null;
  metadataClassHash?: number;
  metadataMatTransport?: boolean;
  topology?: GPUPrimitiveTopology;
  [key: string]: unknown;
}

interface ReflectionProxyLike {
  center?: Cartesian3 | null;
  type?: string;
  radius?: number;
  halfExtents?: Cartesian3 | null;
}
interface EnvironmentMapManagerLike {
  reflectionProxy?: ReflectionProxyLike | null;
  _webgpuIBLDiffuseView?: GPUTextureView | null;
  _webgpuIBLSpecularView?: GPUTextureView | null;
  _webgpuIBLSampler?: GPUSampler | null;
  _webgpuSHBuffer?: GPUBuffer | null;
}

interface ClippingCollectionLike {
  enabled?: boolean;
  length?: number;
}

interface CSMRendererLike {
  enabled?: boolean;
  cascadeParamsBuffer?: GPUBuffer;
  cascadeArrayView?: GPUTextureView;
  pcfRadius?: number;
}

interface SceneCaptureModelsLike {
  frameNumber: number;
  models: Array<{
    model: ModelLike;
    pipelineCache: PipelineCacheLike;
    records: CaptureRecord[];
  }>;
  buildCaptureCommands: unknown;
}

/**
 * C10-05 — frame-owned mip-generation sink (C9-12A `WebGPUContext`
 * `enqueueImageryMipGeneration`). A texture upgraded to a real mip chain in the
 * `createGPUTextureFromReader` fallback registers its blit here so the mips are
 * generated in the shared pre-frame `"ImageryMipPreparation"` submit — never a
 * private `queue.submit` from draw emission.
 */
type EnqueueMipFn = (
  texture: GPUTexture,
  format: GPUTextureFormat,
  mipLevelCount: number,
) => void;

interface ModelRenderContext {
  device: GPUDevice;
  enqueueImageryMipGeneration?: EnqueueMipFn;
  uniformState: CesiumUniformState;
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  depthFormat?: GPUTextureFormat;
  scenePipelineFormat?: GPUTextureFormat;
  _sceneColorFormat?: GPUTextureFormat;
  sceneCaptureReflections?: boolean;
  _webgpuSceneCaptureModels?: SceneCaptureModelsLike | null;
  _clusteredLightingBuffers?: unknown;
  _msaaSamples?: number;
  _refractionSceneView?: GPUTextureView | null;
  _sceneHasTransmission?: boolean;
  csmRenderer?: CSMRendererLike | null;
  _edgeColorView?: GPUTextureView | null;
  _edgeIdView?: GPUTextureView | null;
  _edgeDepthView?: GPUTextureView | null;
  _globeDepthView?: GPUTextureView | null;
}
interface ImageBasedLightingLike {
  _imageBasedLightingFactor?: { x: number; y: number } | null;
  _webgpuMaxMipLevel?: number;
  _specularEnvironmentMapAtlas?: { _maximumMipmapLevel?: number } | null;
  _webgpuSpecularView?: GPUTextureView | null;
  _webgpuDiffuseView?: GPUTextureView | null;
  _webgpuSampler?: GPUSampler | null;
  _webgpuSHBuffer?: GPUBuffer | null;
  _specularEnvironmentCubeMap?: unknown;
  _webgpuHasSH?: boolean;
  [key: string]: unknown;
}
interface SceneLightsLike {
  length: number;
  pack(dst: Float32Array): ArrayLike<number>;
}
interface CustomShaderResourcesLike {
  customShader?: CustomShaderLike | null;
  chunk?: string;
  classHash?: number;
  defines?: number;
  uboFields?: unknown;
  textureFields?: Array<{ uniformName: string; [key: string]: unknown }>;
  uboBuffer?: GPUBuffer | null;
  uboByteLength?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

// Camera uniform buffer: mat4(mvpRTE) + mat4(mvRTE) + mat4(normal) +
//   vec3+pad(camHighMC) + vec3+pad(camLowMC) + vec3+pad(camWC) +
//   mat4(previousViewProjection)  = 320 bytes.
// DP-H41 (Batch 27) — previousViewProjection added at the tail for TAA /
// motion-vector reprojection. 16-byte alignment preserved (20 vec4s).
const CAMERA_UNIFORM_SIZE = 320;
// Material uniform buffer: mat4(model) + vec4(baseColor) + vec3+f(emissive+metallic)
//   + 4f(rough/alpha/normal/occ) + u32(flags) + 3f(specRGB) + f(gloss) +
//   4f(diffuseRGBA) + 3f(padding) + ... = expanded for KHR extensions.
// 768 bytes = 192 floats. Layout:
//   floats   0-15 : modelMatrix          (mat4x4)
//   floats  16-19 : baseColorFactor      (vec4)
//   floats  20-23 : emissiveFactor + metallicFactor
//   floats  24-27 : roughness/alphaCutoff/normalScale/occlusionStrength
//   floats  28    : materialFlags        (u32 stored as float bits)
//   floats  29-31 : specularFactor       (vec3)
//   floats  32    : glossinessFactor
//   floats  33-36 : diffuseFactor        (vec4)
//   floats  37    : texCoordFlags        (u32)
//   floats  38-39 : padding — reused by WIRE-MODEL-SPLITTER: 38 =
//                   model.splitDirection (-1/0/+1), 39 = czm_splitPosition
//                   in framebuffer pixels. Read only by the
//                   `//>>ifdef MODEL_SPLIT_ENABLED` FS blocks.
//   floats  40-43 : pickColor            (vec4)
//   floats  44-55 : baseColor texture transform (3 padded vec4 cols)
//   floats  56-67 : normal texture transform
//   floats  68-79 : metallicRoughness texture transform
//   floats  80-91 : emissive texture transform
//   floats  92-103: occlusion texture transform
//   floats 104    : textureTransformFlags (u32)
//   floats 105-107: padding
//
// C-R4-GLTF-KHR (slices 2-7): each KHR extension occupies a contiguous
// 8-float (32-byte) slot at a 16-byte boundary so the WGSL std140 layout
// matches without internal padding. Factors only — texture readers are
// resolved through the existing texture binding path in a follow-up
// slice (bind-group restructure required to add the per-extension
// sampled textures).
//
//   floats 108-115: clearcoat   (factor, roughness, normalScale, _, _, _, _, _)
//   floats 116-123: specular    (factor, colorR, colorG, colorB, _, _, _, _)
//   floats 124-131: anisotropy  (strength, rotation, _, _, _, _, _, _)
//   floats 132-139: iridescence (factor, ior, thickMin, thickMax, _, _, _, _)
//   floats 140-147: sheen       (colorR, colorG, colorB, roughness, _, _, _, _)
//   floats 148-155: volume      (thickness, attenDistance, attColorR, attColorG, attColorB, _, _, _)
//   floats 156-171: previousModelMatrix (mat4x4) — TAA Slice 2c (Batch 96)
//   floats 172-175: motionFlags         (vec4: enabled, scale, _, _)
//   floats 176-179: tileBatchFlags      (vec4: passClass, opaqueThreshold, _, _) — C-R1-TILE-BATCH (Batch 100)
//   floats 180-183: transmissionFactors  (vec4: factor, ior, _, _)
//   floats 184-187: reserved (_pad_reserved8) — reused by WIRE-MODEL-COLOR:
//                   model.color RGBA. Blend scalar rides motionFlags.w
//                   (float 175). Read only by the `//>>ifdef
//                   MODEL_HAS_COLOR` FS blocks; zero-filled otherwise.
//   floats 188-191: reserved (texture transform extensions for KHR slots,
//                             KHR_materials_pbrSpecularGlossiness lookups, etc.)
const MATERIAL_UNIFORM_SIZE = 768;
// Light uniform buffer layout (Audit B.3 -- Batch 131; Batch 134
// bumped per-light record from 16 to 20 floats for spot direction):
//   bytes 0-63   : sun + ambient + IBL block (16 floats)
//                  - 0-3   sunDirectionEC (vec3+pad)
//                  - 4-7   sunColor (vec3) + sunIntensity
//                  - 8-11  ambientColor (vec3+pad)
//                  - 12-15 iblDiffuseFactor, iblSpecularFactor, iblMaxMipLevel, iblHasSH
//   bytes 64-79  : punctual header (4 floats)
//                  - 16    punctualLightCount (i32 stored as f32)
//                  - 17-19 padding
//   bytes 80-719 : 8 punctual lights * 20 floats = 160 floats
//                  Per-light layout matches `LightCollection.pack()`:
//                  - +0..2  direction OR position xyz
//                  - +3     lightType (0=DIR, 1=POINT, 2=SPOT)
//                  - +4..6  color rgb
//                  - +7     intensity
//                  - +8     range
//                  - +9..11 const/linear/quadratic attenuation
//                  - +12..13 inner/outer cone angles (radians)
//                  - +14..15 padding
//                  - +16..18 spotDirection xyz (spot lights only)
//                  - +19    padding
//   bytes 720-767: iblReferenceFrameMatrix (mat3x3) — NEW-MODEL-IBL-
//                  REFERENCE-FRAME (Batch 287). 3 vec4-padded columns:
//                  col0 @ floats 180-182, col1 @ 184-186, col2 @ 188-190.
//   bytes 768-863: C2-25 ENV-PARALLAX (Batch 451) — reflection proxy block.
//                  - 768-783 (floats 192-195) reflectionProxyControl (vec4):
//                       x=mode (0 off / 1 box / 2 sphere), y=sphere radius, zw pad
//                  - 784-799 (floats 196-198+pad) proxyCenter (vec3) — camera-
//                       relative world (centerWC - cameraWC), meters
//                  - 800-815 (floats 200-202+pad) proxyHalfExtents (vec3) —
//                       world-axis-aligned box half-extents, meters
//                  - 816-863 (floats 204-215) eyeToWorldRotation (mat3x3):
//                       3 vec4-padded columns @ floats 204-206 / 208-210 / 212-214
// Total: 64 + 656 + 48 + 96 = 864 bytes. Keep in sync with struct
// LightUniforms in ModelPBRComplete.wgsl.
const LIGHT_UNIFORM_SIZE = 864;

// materialFlags bit for skinning (bit 13 = 8192)
const FLAG_HAS_SKINNING = 8192;
// materialFlags bit for instancing (bit 15 = 32768)
const FLAG_HAS_INSTANCING = 32768;

// Batch 174 — B.4 KHR materialBGL split. Aggregate mask of all
// KHR-extension bits the FS gates on. Mirrors the FLAG_HAS_*
// constants in ModelPBRComplete.wgsl (bits 19-25). When the
// material's flags AND this mask is zero, the renderer routes
// through the basic shader/BGL/pipeline-layout variant — bindings
// 12-25 of the materialBGL are stripped, dropping the sampled-
// texture count from 23 to 10 so the pipeline fits within the
// WebGPU spec floor `maxSampledTexturesPerShaderStage = 16`.
//
// **Scalability note:** today this is a coarse OR — any KHR bit set
// routes through the full variant. The architecture (manifest-driven
// BGL builder + per-variant pipeline cache + per-variant shader-module
// cache, all keyed on `materialDefines: number`) supports per-extension
// granular splits without further refactoring. When the WGSL ifdefs
// are split per-extension (follow-up to Batch 174), this helper can
// return a granular `materialDefines` like
// `MODEL_HAS_KHR_SPECULAR | MODEL_HAS_KHR_CLEARCOAT` — the cache will
// build a minimal layout for that exact subset that fits a 16-texture
// device even if the asset uses some KHR extensions.
const FLAG_HAS_KHR_MASK =
  524288 | // FLAG_HAS_CLEARCOAT (bit 19)
  1048576 | // FLAG_HAS_SPECULAR_EXT (bit 20)
  2097152 | // FLAG_HAS_ANISOTROPY (bit 21)
  4194304 | // FLAG_HAS_IRIDESCENCE (bit 22)
  8388608 | // FLAG_HAS_SHEEN (bit 23)
  16777216 | // FLAG_HAS_VOLUME (bit 24)
  33554432; // FLAG_HAS_TRANSMISSION (bit 25)

/**
 * Batch 174 — Computes the `materialDefines` bitmask for a primitive
 * given its material flags. The pipeline cache + BGL builder + shader-
 * module cache all key on this value.
 *
 * Today the result is binary: `0` (basic, no KHR — fits the 16-sampled-
 * texture spec floor) or `MODEL_HAS_KHR_TEXTURES` (full, all KHR
 * bindings present — needs the device to opt up
 * `maxSampledTexturesPerShaderStage` past the spec floor).
 *
 * Future: when the WGSL ifdefs are split per-KHR-extension and a new
 * `MODEL_HAS_KHR_SPECULAR` / `MODEL_HAS_KHR_CLEARCOAT` / etc. set of
 * `ShaderDefine` bits is added, this function returns the exact OR of
 * the bits the primitive's flags activate, and the cache builds a
 * minimal layout fitting within `device.limits.maxSampledTexturesPerShaderStage`.
 *
 * @private
 * @param {number} materialFlags
 * @returns {number}
 */
function computeMaterialDefines(materialFlags: number): number {
  if ((materialFlags & FLAG_HAS_KHR_MASK) !== 0) {
    return ShaderDefine.MODEL_HAS_KHR_TEXTURES;
  }
  return 0;
}

// ─── Scratch Variables ───────────────────────────────────────────────────────

const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchNormal = new Matrix4();
const scratchInverseModel = new Matrix4();
const scratchCameraMC = new Cartesian3();
const scratchEncodedCamera = new EncodedCartesian3();
// NEW-MODEL-PROJECT2D-BV-MORPH (B11) — scratch for the accurate-2D 3D normal
// matrix override (see overrideProject2DNormalMatrix).
const scratchModelView3D = new Matrix4();
const scratchNormal3D = new Matrix4();
// AUDIT_2026_05_02 B.8 (Batch 152, fixed Batch 154) — per-runtime-node
// modelMatrix scratch for `modelMatrix * runtimeNode.computedTransform`.
// Reused per node per frame. Originally cited `transformToRoot` here, which
// is wrong: per `ModelRuntimeNode.js:19` `transformToRoot` excludes the
// node's own transform. WebGL's `ModelMatrixUpdateStage.updateRuntimeNode`
// (`ModelMatrixUpdateStage.js:82-86`) multiplies in `runtimeNode.transform`
// before consuming, equivalent to using `runtimeNode.computedTransform`.
const scratchNodeModelMatrix = new Matrix4();

// NEW-MODEL-PROJECT2D-BV-MORPH (B11) — reused per-frame scratch for the
// accurate-2D (`projectTo2D:true`) path: the model's ECEF world origin, the
// per-node 3D world matrix used to reproject positions, and a corner-point
// accumulator for the morphed 2D bounding volume.
const scratchProject2DWorldOrigin = new Cartesian3();
const scratchProject2DNodeWorld = new Matrix4();

// C-MODEL-2DIDL-DUPLICATE — reused scratch for the SCENE2D IDL-crossing
// duplicate command (mirrors WebGL `ModelDrawCommand.updateModelMatrix2D` /
// `derive2DCommand`). Only touched when `idlDuplicateActive` is armed.
const scratchIdl2DModelMatrix = new Matrix4();

// NEW-MODEL-PROJECT2D-BV-MORPH (B11) — union the per-primitive accurate 2D
// bounding spheres (computed by SceneMode2DPipelineStage into
// `runtimePrimitive.boundingSphere2D`) into a single model-level 2D volume.
// This is the "morphed" flat bounding box the accurate-2D command culls
// against, in the same projected frame as the camera. Returns undefined when
// no 2D spheres are available yet (caller falls back to the ECEF sphere).
function computeModel2DBoundingVolume(
  model: ModelLike,
  cache: ModelWebGPUCache,
) {
  const runtimeNodes = model._sceneGraph?._runtimeNodes;
  if (!defined(runtimeNodes)) {
    return undefined;
  }
  if (!defined(cache._project2DBoundingSphere)) {
    cache._project2DBoundingSphere = new BoundingSphere();
  }
  const out = cache._project2DBoundingSphere;
  let started = false;
  for (let i = 0; i < runtimeNodes.length; i++) {
    const node = runtimeNodes[i];
    const prims = node?.runtimePrimitives;
    if (!defined(prims)) {
      continue;
    }
    for (let j = 0; j < prims.length; j++) {
      const bs = prims[j]?.boundingSphere2D;
      if (!defined(bs)) {
        continue;
      }
      if (!started) {
        BoundingSphere.clone(bs, out);
        started = true;
      } else {
        BoundingSphere.union(out, bs, out);
      }
    }
  }
  return started ? out : undefined;
}

// C2-25 ENV-SCENE-CAPTURE (Batch 447) — reused per-primitive-per-face capture
// camera UB staging buffer. The pack writes into this, the ring allocator
// copies the bytes to a per-frame slice, so a single module-scope scratch
// suffices for all 6 faces × N primitives.
const captureCameraData = new Float32Array(CAMERA_UNIFORM_SIZE / 4);

// AUDIT_2026_05_02 B.8 — cheap "is identity" check used to skip per-node
// camera resource allocation when the node has no parent-chain transform
// (the common case for single-node models). Inlined comparison avoids the
// O(16) `Matrix4.equalsEpsilon` and the closure cost of an exact-equals path
// when called per-node per-frame.
function isIdentityMatrix4(m: ArrayLike<number>) {
  return (
    m[0] === 1 &&
    m[5] === 1 &&
    m[10] === 1 &&
    m[15] === 1 &&
    m[1] === 0 &&
    m[2] === 0 &&
    m[3] === 0 &&
    m[4] === 0 &&
    m[6] === 0 &&
    m[7] === 0 &&
    m[8] === 0 &&
    m[9] === 0 &&
    m[11] === 0 &&
    m[12] === 0 &&
    m[13] === 0 &&
    m[14] === 0
  );
}

// ─── Camera Uniform Packing ─────────────────────────────────────────────────

function packCameraUniforms(
  data: Float32Array,
  frameState: CesiumFrameState,
  modelMatrix: Matrix4,
) {
  const uniformState = frameState.context.uniformState;

  // modelView = view * model
  Matrix4.multiply(uniformState.view, modelMatrix, scratchModelView);
  // modelViewRTE = modelView with translation zeroed
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  // mvpRTE = projection * modelViewRTE
  Matrix4.multiply(uniformState.projection, scratchMVRTE, scratchMVPRTE);

  Matrix4.pack(scratchMVPRTE, data, 0); // [0-15]
  Matrix4.pack(scratchMVRTE, data, 16); // [16-31]

  // Normal matrix = transpose(inverse(modelView))
  Matrix4.inverse(scratchModelView, scratchNormal);
  Matrix4.transpose(scratchNormal, scratchNormal);
  Matrix4.pack(scratchNormal, data, 32); // [32-47]

  // Camera position in MODEL coordinates (key RTE fix!)
  // inverse(model) * cameraPositionWC → camera in model space.
  //
  // C2-25 ENV-SCENE-CAPTURE (Batch 447) — read the eye from
  // `uniformState.cameraPosition` instead of `frameState.camera.positionWC`
  // so the model eye is fully `uniformState`-driven (like the globe). This is
  // PARITY-NEUTRAL on-screen: `UniformState.update` calls
  // `updateCamera(frameState.camera)` every frame, which clones
  // `camera.positionWC` into `_cameraPosition`, so the two are bit-for-bit
  // identical in every scene mode. The payoff: the env scene-capture pass's
  // per-face `uniformState.updateCamera(faceCamera)` + finally-restore now
  // repoint the model eye for free, exactly as they already do for the globe.
  // KEEP the `inverse(model) * eyeWC` math — do NOT substitute
  // `encodedCameraPositionMC` (that's the ellipsoid-ENU encode, wrong frame).
  const eyeWC = uniformState.cameraPosition;
  Matrix4.inverse(modelMatrix, scratchInverseModel);
  Matrix4.multiplyByPoint(scratchInverseModel, eyeWC, scratchCameraMC);
  EncodedCartesian3.fromCartesian(scratchCameraMC, scratchEncodedCamera);

  data[48] = scratchEncodedCamera.high.x;
  data[49] = scratchEncodedCamera.high.y;
  data[50] = scratchEncodedCamera.high.z;
  data[51] = 0.0;
  data[52] = scratchEncodedCamera.low.x;
  data[53] = scratchEncodedCamera.low.y;
  data[54] = scratchEncodedCamera.low.z;
  data[55] = 0.0;

  // Camera position WC (for specular/IBL effects). Same `uniformState`-driven
  // eye as the MC encode above (C2-25 Batch 447) — parity-neutral on-screen,
  // and face-camera-aware during env scene capture.
  const camWC = eyeWC;
  data[56] = camWC.x;
  data[57] = camWC.y;
  data[58] = camWC.z;
  data[59] = 0.0;

  // Renderer-wide log depth — floats 51/55/59 carry (factor, near, far)
  // per the WebGPULogDepth.ts lane convention. Fills previously-zero pad
  // lanes; only the LOG_DEPTH module variant reads them.
  packCameraLogDepthLanes(data, 0, uniformState);

  // DP-H41 (Batch 27) — previousViewProjection at offset 60..75 (16 floats).
  // `UniformState.update()` clones the current viewProjection into
  // `_previousViewProjection` BEFORE overwriting it with the new camera
  // state, so on frame N this slot holds frame N-1's viewProjection.
  // TAA / motion-vector shaders consume it via `camera.previousViewProjection`.
  const prevVP = uniformState.previousViewProjection;
  if (prevVP) {
    Matrix4.pack(prevVP, data, 60);
  } else {
    // Column-major identity fallback (frame 0).
    data[60] = 1;
    data[61] = 0;
    data[62] = 0;
    data[63] = 0;
    data[64] = 0;
    data[65] = 1;
    data[66] = 0;
    data[67] = 0;
    data[68] = 0;
    data[69] = 0;
    data[70] = 1;
    data[71] = 0;
    data[72] = 0;
    data[73] = 0;
    data[74] = 0;
    data[75] = 1;
  }

  // Q13-PLAIN-HDR-GAMMA-CORE — HDR gate at float 76 (camera.hdrControl.x),
  // packed into pre-existing trailing padding of the 320-byte camera UB.
  // Mirrors WebGL's `#ifdef HDR` in LightingStageFS: when
  // `scene.highDynamicRange` is on (`frameState.useHDR`) the model shader's
  // `tonemapAndGamma` skips the inline tonemap + gamma encode so the
  // post-process Tonemap stage does it once. Zero on the default SDR path →
  // byte-identical.
  data[76] = frameState.useHDR === true ? 1.0 : 0.0;
}

// NEW-MODEL-PROJECT2D-BV-MORPH (B11) — override the normal matrix (slots
// 32-47) with the 3D normal matrix for the accurate-2D path. `packCameraUniforms`
// derives the normal matrix from the translate(reference) 2D clip matrix, which
// has no model orientation — so `normalEC` loses the model's world rotation and
// diffuse lighting goes wrong. WebGL shades projectTo2D models entirely in the
// 3D eye frame (`czm_normal3D`, ModelVS.glsl:62) while only the CLIP position is
// remapped to 2D; the light direction the renderer packs
// (`uniformState.lightDirectionEC`) is ALWAYS in the view3D frame
// (UniformState.js:850 `viewRotation3D`), so `normalEC` must match it. This
// recomputes `transpose(inverse(view3D × model3DWorld))` — the model-level 3D
// world matrix (per-node rotation for normals is a documented B12 residual).
// The clip position, RTE camera encode, and mvp remain the 2D values.
function overrideProject2DNormalMatrix(
  data: Float32Array,
  frameState: CesiumFrameState,
  model3DWorldMatrix: Matrix4,
) {
  const uniformState = frameState.context.uniformState;
  Matrix4.multiply(uniformState.view3D, model3DWorldMatrix, scratchModelView3D);
  Matrix4.inverse(scratchModelView3D, scratchNormal3D);
  Matrix4.transpose(scratchNormal3D, scratchNormal3D);
  Matrix4.pack(scratchNormal3D, data, 32);
}

// ─── C2-25 ENV-SCENE-CAPTURE (Batch 447) — Model capture command builder ──────

/**
 * C2-25 ENV-SCENE-CAPTURE (Batch 447) — turns one published model entry's
 * per-primitive draw records into single-target capture draw descriptors for
 * the current cube face. Invoked by `WebGPUDynamicEnvironmentMapCapture.run-
 * SceneCapture` (via the published `buildCaptureCommands` slot) AFTER it has
 * repointed `uniformState` to the face camera — so the per-primitive camera UB
 * packed here bakes the FACE-camera RTE eye.
 *
 * Per record:
 *   - pack the face-camera UB into the per-frame ring (`writeUniformSlice`),
 *     NEVER `cache.cameraBuffer`/`nc.cameraBuffer` — the main pass reads those
 *     later this same frame, and capture precedes the main render.
 *   - build a fresh group-0 camera bind group on the ring slice.
 *   - rebuild the material bind group with a NEUTRAL IBL (`iblEntries = null` →
 *     `defaultIBLEntries`) to avoid a 1-frame recursive self-reflection (the
 *     model sampling the env cube it is being captured INTO).
 *   - fetch the single-target `CAPTURE_MODE` pipeline (`getCapturePipeline`).
 *   - reuse the record's already-built merged instance + effects bind groups
 *     and vertex/index buffers (camera-independent).
 *
 * Returns single-target `ModelCaptureCommand`s matching the consumer contract
 * in `WebGPUDynamicEnvironmentMapCapture.ts`. Guarded on `model.isDestroyed()`
 * (the publish carries last-frame refs; the model may have been torn down).
 *
 * @param {object} entry published model entry `{ model, pipelineCache, records }`
 * @param {GPUDevice} device
 * @param {object} frameState
 * @param {GPUTextureFormat} faceFormat env-cube face color attachment format
 * @returns {object[]} single-target capture draw descriptors
 * @private
 */
function getOrCreateModelCaptureCommands(
  entry: {
    model?: ModelLike;
    pipelineCache?: PipelineCacheLike;
    records?: CaptureRecord[];
    [key: string]: unknown;
  },
  device: GPUDevice,
  frameState: CesiumFrameState,
  faceFormat: GPUTextureFormat,
) {
  const model = entry.model;
  if (!model || model.isDestroyed?.() === true) {
    return [];
  }
  const pipelineCache = entry.pipelineCache;
  const records = entry.records;
  if (!pipelineCache || !records || records.length === 0) {
    return [];
  }
  const commands = [];
  for (let r = 0; r < records.length; r++) {
    const rec = records[r];
    if (!rec.indexBuffer || rec.indexCount === 0) {
      continue;
    }
    // Pack the FACE-camera UB against the record's snapshot model matrix. The
    // eye-swap (uniformState.cameraPosition) means the repointed face camera
    // reaches the model eye automatically.
    packCameraUniforms(captureCameraData, frameState, rec.nodeModelMatrix);
    const slice = writeUniformSlice(
      device,
      frameState,
      captureCameraData,
      CAMERA_UNIFORM_SIZE,
      "Model capture camera",
    );
    const cameraBG = device.createBindGroup({
      layout: pipelineCache.cameraBGL,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: slice.buffer,
            offset: slice.offset,
            size: slice.size,
          },
        },
      ],
    });
    const materialBG = buildMergedMaterialBindGroup(
      device,
      pipelineCache,
      rec.materialBuffer,
      rec.lightBuffer,
      rec.textureEntries,
      rec.featureIdEntries,
      null, // neutral IBL — no recursive self-reflection
      rec.materialDefines,
      frameState,
    );
    // DP-H46b — feed the published metadata chunk before building the capture
    // pipeline so a MODEL_HAS_METADATA capture variant compiles with its
    // generated `struct Metadata`. Clears for non-metadata records.
    if (defined(rec.metadataWGSL)) {
      pipelineCache.setMetadataWGSL(
        rec.metadataWGSL,
        rec.metadataClassHash | 0,
        rec.metadataMatTransport === true,
      );
    } else {
      pipelineCache.clearMetadataWGSL();
    }
    // GLTF-POINTS-MODE — sticky-topology contract: set per record before the
    // capture pipeline build (records from older publishes default triangle).
    pipelineCache.setPrimitiveTopology(rec.topology ?? "triangle-list");
    const pipeline = pipelineCache.getCapturePipeline(
      rec.alphaMode,
      rec.doubleSided,
      rec.materialDefines,
      faceFormat,
    );
    commands.push({
      pipeline,
      bindGroups: [cameraBG, materialBG, rec.mergedInstanceBG, rec.effectsBG],
      vertexBuffers: rec.vertexBuffers,
      indexBuffer: rec.indexBuffer,
      indexCount: rec.indexCount,
      indexFormat: rec.indexFormat,
      instanceCount: rec.instanceCount || 1,
    });
  }
  return commands;
}

// ─── Material Uniform Packing ────────────────────────────────────────────────

function packMaterialUniforms(
  data: Float32Array,
  modelMatrix: Matrix4,
  matInfo: MaterialInfo,
  hasSkinning: boolean,
  hasMorphTargets: boolean,
  pickColor: ColorLike | null | undefined,
  previousModelMatrix: Matrix4 | null | undefined,
  motionEnabled: boolean,
  passClass: number,
) {
  Matrix4.pack(modelMatrix, data, 0); // [0-15]

  // baseColorFactor (vec4)
  const bc = matInfo.baseColorFactor;
  data[16] = bc[0];
  data[17] = bc[1];
  data[18] = bc[2];
  data[19] = bc[3];

  // emissiveFactor (vec3) + metallicFactor (f32)
  const ef = matInfo.emissiveFactor;
  data[20] = ef[0];
  data[21] = ef[1];
  data[22] = ef[2];
  data[23] = matInfo.metallicFactor;

  // roughness, alphaCutoff, normalScale, occlusionStrength
  data[24] = matInfo.roughnessFactor;
  data[25] = matInfo.alphaCutoff;
  data[26] = matInfo.normalScale;
  data[27] = matInfo.occlusionStrength;

  // materialFlags (u32 stored as float bits) — add skinning/morph flags
  let flags = matInfo.materialFlags;
  if (hasSkinning) {
    flags |= FLAG_HAS_SKINNING;
  }
  if (hasMorphTargets) {
    flags |= MaterialFlags.HAS_MORPH_TARGETS;
  }
  const flagsView = new DataView(data.buffer, data.byteOffset);
  flagsView.setUint32(28 * 4, flags, true);

  // specularFactor (vec3) for SpecGloss path
  const sf = matInfo.specularFactor;
  data[29] = sf[0];
  data[30] = sf[1];
  data[31] = sf[2];

  // glossinessFactor
  data[32] = matInfo.glossinessFactor;

  // diffuseFactor (vec4) for SpecGloss path
  const df = matInfo.diffuseFactor;
  data[33] = df[0];
  data[34] = df[1];
  data[35] = df[2];
  data[36] = df[3];

  // Per-texture UV-set bitmask (slot 37, u32). glTF textureInfos carry a
  // per-texture `texCoord: 0|1` flag that selects which vertex UV set
  // (TEXCOORD_0 or TEXCOORD_1) a given sampler reads. Occlusion maps
  // commonly use TEXCOORD_1 while the base color stays on TEXCOORD_0;
  // without honoring the flag, occlusion blotches land in the wrong place
  // relative to the diffuse image. The shader reads this bitmask via
  // `material.texCoordFlags` and branches the UV input per sampling site.
  let tcFlags = 0;
  const baseReader =
    matInfo.baseColorTextureReader || matInfo.diffuseTextureReader;
  const normalReader = matInfo.normalTextureReader;
  const mrReader =
    matInfo.metallicRoughnessTextureReader || matInfo.specGlossTextureReader;
  const emissiveReader = matInfo.emissiveTextureReader;
  const occlusionReader = matInfo.occlusionTextureReader;
  if (baseReader && baseReader.texCoord === 1) {
    tcFlags |= 0x01;
  }
  if (normalReader && normalReader.texCoord === 1) {
    tcFlags |= 0x02;
  }
  if (mrReader && mrReader.texCoord === 1) {
    tcFlags |= 0x04;
  }
  if (emissiveReader && emissiveReader.texCoord === 1) {
    tcFlags |= 0x08;
  }
  if (occlusionReader && occlusionReader.texCoord === 1) {
    tcFlags |= 0x10;
  }
  flagsView.setUint32(37 * 4, tcFlags, true);

  // Padding to maintain vec4 alignment for the next field (pickColor).
  // texCoordFlags lives at slot 37; slots 38-39 pad up to the 16-byte
  // boundary at slot 40 where pickColor (vec4) starts.
  data[38] = 0;
  data[39] = 0;

  // C-R9-MODEL-PICK (Batch 54) — pickColor slot (floats 40-43). Zero
  // when no pick ID has been registered yet (e.g., a non-pick render
  // pass before the model first enters a pick pass). The pick command
  // itself is only attached to derivedCommands.picking when a pick
  // color is available, so the zeros never reach the pick FBO.
  if (pickColor) {
    data[40] = pickColor.red;
    data[41] = pickColor.green;
    data[42] = pickColor.blue;
    data[43] = pickColor.alpha;
  } else {
    data[40] = 0;
    data[41] = 0;
    data[42] = 0;
    data[43] = 0;
  }

  // C-R4-GLTF-KHR (slice 1) — KHR_texture_transform per-texture 3x3.
  // GltfLoaderUtil.createModelTextureReader extracts the
  // `KHR_texture_transform` extension into a Matrix3 stored on the
  // reader's `.transform` slot when the asset uses the extension.
  // Pack each (or identity) into 3 padded vec4 columns. Bits in
  // textureTransformFlags indicate which slots have non-identity
  // transforms so the FS can skip the matrix multiply for the common
  // no-extension case.
  let ttFlags = 0;
  ttFlags |= writeTextureTransform(data, 44, baseReader?.transform) ? 0x01 : 0;
  ttFlags |= writeTextureTransform(data, 56, normalReader?.transform)
    ? 0x02
    : 0;
  ttFlags |= writeTextureTransform(data, 68, mrReader?.transform) ? 0x04 : 0;
  ttFlags |= writeTextureTransform(data, 80, emissiveReader?.transform)
    ? 0x08
    : 0;
  ttFlags |= writeTextureTransform(data, 92, occlusionReader?.transform)
    ? 0x10
    : 0;
  flagsView.setUint32(104 * 4, ttFlags, true);
  // Padding to 16-byte boundary.
  data[105] = 0;
  data[106] = 0;
  data[107] = 0;

  // C-R4-GLTF-KHR (slices 2-7) — KHR material extension factors.
  // Each block is 8 floats (32 B); identity values for the inactive
  // case are written so a stale buffer never stamps garbage into a
  // newly-promoted "extension active" frame.

  // Clearcoat (slot 108-115).
  data[108] = matInfo.hasClearcoat ? matInfo.clearcoatFactor : 0.0;
  data[109] = matInfo.hasClearcoat ? matInfo.clearcoatRoughnessFactor : 0.0;
  data[110] = matInfo.hasClearcoat ? matInfo.clearcoatNormalScale : 1.0;
  data[111] = 0;
  data[112] = 0;
  data[113] = 0;
  data[114] = 0;
  data[115] = 0;

  // Specular ext (slot 116-123).
  data[116] = matInfo.hasSpecularExt ? matInfo.specularExtFactor : 1.0;
  if (matInfo.hasSpecularExt) {
    const sec = matInfo.specularExtColorFactor;
    data[117] = sec[0];
    data[118] = sec[1];
    data[119] = sec[2];
  } else {
    data[117] = 1;
    data[118] = 1;
    data[119] = 1;
  }
  data[120] = 0;
  data[121] = 0;
  data[122] = 0;
  data[123] = 0;

  // Anisotropy (slot 124-131).
  data[124] = matInfo.hasAnisotropy ? matInfo.anisotropyStrength : 0.0;
  data[125] = matInfo.hasAnisotropy ? matInfo.anisotropyRotation : 0.0;
  data[126] = 0;
  data[127] = 0;
  data[128] = 0;
  data[129] = 0;
  data[130] = 0;
  data[131] = 0;

  // Iridescence (slot 132-139).
  data[132] = matInfo.hasIridescence ? matInfo.iridescenceFactor : 0.0;
  data[133] = matInfo.hasIridescence ? matInfo.iridescenceIor : 1.3;
  data[134] = matInfo.hasIridescence
    ? matInfo.iridescenceThicknessMinimum
    : 100;
  data[135] = matInfo.hasIridescence
    ? matInfo.iridescenceThicknessMaximum
    : 400;
  data[136] = 0;
  data[137] = 0;
  data[138] = 0;
  data[139] = 0;

  // Sheen (slot 140-147).
  if (matInfo.hasSheen) {
    const sc = matInfo.sheenColorFactor;
    data[140] = sc[0];
    data[141] = sc[1];
    data[142] = sc[2];
    data[143] = matInfo.sheenRoughnessFactor;
  } else {
    data[140] = 0;
    data[141] = 0;
    data[142] = 0;
    data[143] = 0;
  }
  data[144] = 0;
  data[145] = 0;
  data[146] = 0;
  data[147] = 0;

  // Volume (slot 148-155). attenuationDistance defaults to +Infinity in
  // glTF spec; encode as 0 in the shader's "no attenuation" sentinel
  // since dividing by it would NaN the FS — the FS reads `volumeFlags`
  // (HAS_VOLUME bit) before applying Beer-Lambert anyway.
  data[148] = matInfo.hasVolume ? matInfo.thicknessFactor : 0.0;
  if (matInfo.hasVolume) {
    const ad = matInfo.attenuationDistance;
    data[149] = isFinite(ad) ? ad : 0.0;
    const ac = matInfo.attenuationColor;
    data[150] = ac[0];
    data[151] = ac[1];
    data[152] = ac[2];
  } else {
    data[149] = 0;
    data[150] = 1;
    data[151] = 1;
    data[152] = 1;
  }
  data[153] = 0;
  data[154] = 0;
  data[155] = 0;

  // TAA Slice 2c (Batch 96) — previousModelMatrix (slots 156-171). Pack
  // the prev-frame matrix when one is provided; otherwise mirror the
  // current matrix so a model in its first rendered frame produces
  // zero velocity (no spurious motion blur on initial display). The
  // WGSL VS reads this through `material.previousModelMatrix` and
  // multiplies by `camera.previousViewProjection` for the prev clip
  // pos.
  if (previousModelMatrix) {
    Matrix4.pack(previousModelMatrix, data, 156);
  } else {
    Matrix4.pack(modelMatrix, data, 156);
  }

  // motionFlags (slot 172-175):
  //   x: motion-vector output enabled (0 / 1) — the WGSL FS
  //      `computeMotionVectorScreenSpace` early-outs to zero when 0.
  //   y: motion-vector scale (default 1.0)
  //   z, w: reserved (sky reprojection / disocclusion params, slice 2d)
  data[172] = motionEnabled ? 1.0 : 0.0;
  data[173] = 1.0;
  // DP-H46a — motionFlags.z doubles as the metadata-debug toggle. When
  // the test hook `globalThis.CesiumWebGPUMetadataDebug` is set, flip it
  // to 1.0 so the `MODEL_HAS_METADATA` fragment branch paints the scalar
  // metadata value to the fragment color (the de-risking proof that the
  // property-ATTRIBUTE value reached the shader). The WGSL branch is
  // stripped for non-metadata models, so setting this globally is safe —
  // only metadata models react. Reusing the reserved slot avoids growing
  // the material UBO (which would break non-metadata byte-identity).
  data[174] =
    (globalThis as { CesiumWebGPUMetadataDebug?: boolean })
      .CesiumWebGPUMetadataDebug === true
      ? 1.0
      : 0.0;
  data[175] = 0;

  // C-R1-TILE-BATCH (Batch 100) — tileBatchFlags (slot 176-179):
  //   x: passClass (0 = opaque pass, 1 = translucent pass) — only
  //      consumed when the FLAG_HAS_BATCH_TABLE bit is set; otherwise
  //      the FS branch is short-circuited.
  //   y: opaque-alpha threshold (default 0.998) used by the FS branch
  //      to decide which pass a given feature lands in.
  //   z, w: reserved.
  data[176] = passClass ? 1.0 : 0.0;
  data[177] = 0.998;
  data[178] = 0;
  data[179] = 0;

  // C-R4-GLTF-KHR-TRANSMISSION (Batch 105) — transmissionFactors
  // (slot 180-183):
  //   x: transmissionFactor [0, 1]
  //   y: ior (default 1.5 — common dielectric / glass refractive index)
  //   z, w: reserved
  data[180] = matInfo.hasTransmission ? matInfo.transmissionFactor : 0.0;
  data[181] = 1.5;
  data[182] = 0;
  data[183] = 0;

  // Reserved (slot 184-191). Zero-fill for std140 stability.
  for (let i = 184; i < 192; i++) {
    data[i] = 0;
  }
}

/**
 * Pack a Matrix3 into 3 padded vec4 columns starting at `offsetFloats`
 * (12 floats consumed). Returns true when a non-identity matrix was
 * written (signal the caller to set the corresponding "has transform"
 * bit). When `m` is undefined or null, writes an identity matrix and
 * returns false.
 *
 * The caller's UBO layout reserves 12 floats per slot for std140-
 * compatible 3-padded-vec4 storage; the WGSL side reconstructs the
 * mat3x3 with `mat3x3<f32>(col0.xyz, col1.xyz, col2.xyz)`.
 *
 * @param {Float32Array} data
 * @param {number} offsetFloats
 * @param {Matrix3|undefined|null} m  Cesium Matrix3 (column-major: m[0..2]=col0, m[3..5]=col1, m[6..8]=col2)
 * @returns {boolean} true iff `m` was a defined matrix.
 * @private
 */
function writeTextureTransform(
  data: Float32Array,
  offsetFloats: number,
  m: ArrayLike<number> | null | undefined,
) {
  if (defined(m)) {
    // Column 0
    data[offsetFloats + 0] = m[0];
    data[offsetFloats + 1] = m[1];
    data[offsetFloats + 2] = m[2];
    data[offsetFloats + 3] = 0;
    // Column 1
    data[offsetFloats + 4] = m[3];
    data[offsetFloats + 5] = m[4];
    data[offsetFloats + 6] = m[5];
    data[offsetFloats + 7] = 0;
    // Column 2
    data[offsetFloats + 8] = m[6];
    data[offsetFloats + 9] = m[7];
    data[offsetFloats + 10] = m[8];
    data[offsetFloats + 11] = 0;
    return true;
  }
  // Identity (no transform). The FS guard skips the multiply when the
  // slot's "has transform" bit is unset, so these slots are technically
  // never read — but writing the identity keeps the buffer
  // self-consistent and makes the dump readable in PIX/RenderDoc.
  data[offsetFloats + 0] = 1;
  data[offsetFloats + 1] = 0;
  data[offsetFloats + 2] = 0;
  data[offsetFloats + 3] = 0;
  data[offsetFloats + 4] = 0;
  data[offsetFloats + 5] = 1;
  data[offsetFloats + 6] = 0;
  data[offsetFloats + 7] = 0;
  data[offsetFloats + 8] = 0;
  data[offsetFloats + 9] = 0;
  data[offsetFloats + 10] = 1;
  data[offsetFloats + 11] = 0;
  return false;
}

// ─── Light Uniform Packing ───────────────────────────────────────────────────

function packLightUniforms(
  data: Float32Array,
  frameState: CesiumFrameState,
  model: ModelLike,
) {
  // Session 65 Batch 18 — pack `lightDirectionEC` (the SCENE LIGHT
  // direction) instead of `sunDirectionEC`. When the scene uses a
  // SunLight, these are identical (see `UniformState.update` line
  // 836-844). When the scene overrides `scene.light` with a custom
  // `DirectionalLight` (e.g., a hillshade direction or an artist-
  // controlled key light), only `lightDirectionEC` reflects the
  // user-set value. Mirrors upstream PBR shaders which reference
  // `czm_lightDirectionEC`, not `czm_sunDirectionEC`. The previous
  // sun-direction code path caused custom-lit models to receive sun
  // illumination regardless of `scene.light`, identical in shape to
  // the Globe lighting bug fixed in Batch 17. Variable name kept as
  // `sunDir` for back-compat with the WGSL uniform field — renaming
  // is a separate refactor.
  const sunDir =
    frameState.context?.uniformState?.lightDirectionEC ||
    new Cartesian3(0, 0, 1);
  data[0] = sunDir.x;
  data[1] = sunDir.y;
  data[2] = sunDir.z;
  data[3] = 0.0;

  // sunColor — honor scene.light.color (public API, defaults to white sunlight).
  const light = frameState.light;
  const lightColor = light?.color;
  if (lightColor) {
    data[4] = lightColor.red;
    data[5] = lightColor.green;
    data[6] = lightColor.blue;
  } else {
    data[4] = 1.0;
    data[5] = 1.0;
    data[6] = 1.0;
  }
  data[7] = light?.intensity ?? 2.0;

  // ambientColor — small floor so unlit faces aren't pitch black. Track V-A3
  // (NEW-ATMO-DERIVED-LIGHTING): when the unified aerial-perspective
  // atmosphere is active, Scene publishes a sky-irradiance ambient
  // (`frameState.atmosphereSkyIrradiance`) derived from the same atmosphere
  // that lights the sun (`frameState.light`) and produces the post-process
  // haze — so the model's ambient is a plausible day/night-aware blue-tinted
  // sky term, consistent with its direct sun, rather than a flat grey. Falls
  // back to the historical neutral 0.2 floor when aerial perspective is off
  // (or on WebGL).
  const skyIrradiance = frameState.atmosphereSkyIrradiance;
  if (skyIrradiance) {
    data[8] = skyIrradiance.x;
    data[9] = skyIrradiance.y;
    data[10] = skyIrradiance.z;
  } else {
    data[8] = 0.2;
    data[9] = 0.2;
    data[10] = 0.2;
  }
  data[11] = 0.0;

  // IBL factors — consumed by ModelPBRComplete.wgsl for split-sum ambient.
  // When the model's ImageBasedLighting is disabled or absent we still write a
  // sensible default so the ambient term isn't silently zeroed (shader
  // multiplies ambientColor * iblDiffuseFactor; a zero factor drops the term).
  const ibl = model?._imageBasedLighting;
  const iblFactor = ibl?._imageBasedLightingFactor; // Cartesian2 (x=diffuse, y=specular)
  data[12] = iblFactor?.x ?? 1.0;
  data[13] = iblFactor?.y ?? 1.0;
  // Audit A.9 (Batch 130) — max mip level of the prefiltered specular
  // cubemap. The WebGPU IBL pipeline (`WebGPUImageBasedLighting`)
  // exposes `_webgpuMaxMipLevel` after generation; falls back to the
  // upstream `_specularEnvironmentMapAtlas` mip count for compatibility
  // with assets that bypassed the prefilter, and finally to 5 (matches
  // the `RADIANCE_MIP_LEVELS - 1` default in `WebGPUIBLPipeline.ts`).
  data[14] =
    ibl?._webgpuMaxMipLevel ??
    ibl?._specularEnvironmentMapAtlas?._maximumMipmapLevel ??
    5.0;
  data[15] = ibl?._sphericalHarmonicCoefficients ? 1.0 : 0.0;

  // Audit B.3 (Batch 131) + re-review (Batch 134) -- punctual lights.
  // Merges `frameState.lights` (scene-level, world-space) with
  // `model.lightsFromGltf` (KHR_lights_punctual asset lights, model
  // space transformed through `model.modelMatrix` here). Caps at 8
  // total -- scene lights win when the union exceeds the cap so
  // user-added lights aren't silently dropped by a noisy asset.
  packPunctualLights(
    data,
    16,
    frameState.lights as unknown as SceneLightsLike | null | undefined,
    model,
  );

  // NEW-MODEL-IBL-REFERENCE-FRAME (Batch 287) — eye→IBL-frame rotation
  // (`model._iblReferenceFrameMatrix`, a column-major Cesium Matrix3 set
  // by `updateReferenceMatrices` every frame). Mirrors WebGL's
  // `model_iblReferenceFrameMatrix` mat3 uniform. Packed at the tail of
  // LightUniforms (byte 720 / float 180) as a WGSL mat3x3<f32>: three
  // vec4-padded columns (each column's xyz at floats 0/1/2, pad at 3).
  // Defaults to identity (Matrix3.IDENTITY clone) so a model without IBL
  // configured samples the placeholder cubemap unrotated.
  packIBLReferenceFrame(data, 180, model);

  // C2-25 ENV-PARALLAX (Batch 451) — reflection proxy block (floats 192-215).
  // Always writes mode (float 192); defaults to 0 (raw reflection vector) so
  // the shader takes the byte-identical pre-451 path and stale proxy data from
  // a prior frame can't leak when the proxy is cleared.
  packReflectionProxy(data, 192, frameState, model);
}

// C2-25 ENV-PARALLAX (Batch 451) — pack the per-manager reflection proxy into
// the LightUniforms tail. Reads `model.environmentMapManager.reflectionProxy`
// (the opt-in box/sphere proxy). Center + half-extents are converted to
// CAMERA-RELATIVE world space (proxy minus camera position) so the WGSL box
// intersection runs in the same frame as the fragment's camera-relative world
// position, preserving f32 precision at Earth scale. Also packs the eye→world
// rotation (`uniformState.inverseViewRotation`) the shader uses to lift the
// eye-space reflection into world space. When no proxy is configured, writes
// mode 0 and zeroes the block (the shader never reads the rest).
const scratchProxyCenterRel = new Cartesian3();
function packReflectionProxy(
  data: Float32Array,
  floatOffset: number,
  frameState: CesiumFrameState,
  model: ModelLike,
) {
  // Zero the whole 24-float block first (mode 0 + clean slate).
  for (let i = 0; i < 24; i++) {
    data[floatOffset + i] = 0.0;
  }

  const proxy = model?.environmentMapManager?.reflectionProxy;
  if (!defined(proxy) || !defined(proxy.center)) {
    return;
  }

  const mode = proxy.type === "sphere" ? 2.0 : 1.0;
  data[floatOffset + 0] = mode; // control.x = mode
  data[floatOffset + 1] = mode === 2.0 ? (proxy.radius ?? 0.0) : 0.0; // control.y = radius
  // control.z / control.w stay 0.

  // Camera-relative world center (centerWC - cameraWC).
  const uniformState = frameState.context.uniformState;
  const cameraWC = uniformState.cameraPosition;
  Cartesian3.subtract(proxy.center, cameraWC, scratchProxyCenterRel);
  data[floatOffset + 4] = scratchProxyCenterRel.x; // proxyCenter.xyz @ 196-198
  data[floatOffset + 5] = scratchProxyCenterRel.y;
  data[floatOffset + 6] = scratchProxyCenterRel.z;
  // float 199 = pad

  if (mode === 1.0) {
    const he = proxy.halfExtents;
    data[floatOffset + 8] = he?.x ?? 0.0; // proxyHalfExtents.xyz @ 200-202
    data[floatOffset + 9] = he?.y ?? 0.0;
    data[floatOffset + 10] = he?.z ?? 0.0;
  }
  // float 203 = pad

  // eyeToWorldRotation (mat3x3, 3 vec4-padded columns @ floats 204-214).
  // `inverseViewRotation` is the orthonormal eye→world rotation (Matrix3,
  // column-major: m[0..2]=col0, m[3..5]=col1, m[6..8]=col2).
  const m = uniformState.inverseViewRotation ?? Matrix3.IDENTITY;
  data[floatOffset + 12] = m[0];
  data[floatOffset + 13] = m[1];
  data[floatOffset + 14] = m[2];
  // float 207 = pad (col0)
  data[floatOffset + 16] = m[3];
  data[floatOffset + 17] = m[4];
  data[floatOffset + 18] = m[5];
  // float 211 = pad (col1)
  data[floatOffset + 20] = m[6];
  data[floatOffset + 21] = m[7];
  data[floatOffset + 22] = m[8];
  // float 215 = pad (col2)
}

// NEW-MODEL-IBL-REFERENCE-FRAME (Batch 287) — writes the model's
// `_iblReferenceFrameMatrix` (column-major Matrix3) into a WGSL
// std140 mat3x3 slot (3 vec4-padded columns).
function packIBLReferenceFrame(
  data: Float32Array,
  floatOffset: number,
  model: ModelLike,
) {
  const m = model?._iblReferenceFrameMatrix;
  if (!m) {
    // Identity fallback (no IBL frame available yet).
    data[floatOffset + 0] = 1.0;
    data[floatOffset + 1] = 0.0;
    data[floatOffset + 2] = 0.0;
    data[floatOffset + 4] = 0.0;
    data[floatOffset + 5] = 1.0;
    data[floatOffset + 6] = 0.0;
    data[floatOffset + 8] = 0.0;
    data[floatOffset + 9] = 0.0;
    data[floatOffset + 10] = 1.0;
    return;
  }
  // Cesium Matrix3 is column-major: m[0..2]=col0, m[3..5]=col1, m[6..8]=col2.
  // WGSL mat3x3 columns are vec4-padded (stride 4 floats).
  data[floatOffset + 0] = m[0];
  data[floatOffset + 1] = m[1];
  data[floatOffset + 2] = m[2];
  data[floatOffset + 4] = m[3];
  data[floatOffset + 5] = m[4];
  data[floatOffset + 6] = m[5];
  data[floatOffset + 8] = m[6];
  data[floatOffset + 9] = m[7];
  data[floatOffset + 10] = m[8];
}

// Audit B.3 (Batch 131) + re-review (Batch 134) -- pre-allocated
// scratch matching `LightCollection.pack()`'s output (164 floats =
// 656 bytes; 4-float header + 8 lights × 20 floats). Re-used per-
// call to avoid GC pressure on every model draw.
const scratchLightPack = new Float32Array(164);

// NEW-KHR-LIGHTS-PUNCTUAL (Batch 134) -- pack scene-level
// `LightCollection` lights AND glTF KHR_lights_punctual lights
// (model-space, transformed by model.modelMatrix here) into the
// per-model UBO's punctual region starting at `floatOffset`. Scene
// lights take priority when the combined count exceeds MAX_LIGHTS=8.
const MAX_PUNCTUAL_LIGHTS = 8;
const FLOATS_PER_PUNCTUAL_LIGHT = 20;
function packPunctualLights(
  data: Float32Array,
  floatOffset: number,
  sceneLights: SceneLightsLike | null | undefined,
  model: ModelLike,
) {
  // Header (4 floats: lightCount + 3 pad) followed by 8 light slots.
  // Total region = 4 + 8 * 20 = 164 floats. Always zero the entire
  // region first so previous frame's data doesn't leak when light
  // counts shrink.
  const regionEnd =
    floatOffset + 4 + MAX_PUNCTUAL_LIGHTS * FLOATS_PER_PUNCTUAL_LIGHT;
  data.fill(0, floatOffset, regionEnd);

  let writeIndex = 0;

  // 1. Scene lights -- already world-space, use the existing pack().
  if (sceneLights && sceneLights.length > 0) {
    const packed = sceneLights.pack(scratchLightPack);
    const sceneCount = packed[0] | 0;
    const sceneSlots = Math.min(sceneCount, MAX_PUNCTUAL_LIGHTS);
    for (let i = 0; i < sceneSlots; i++) {
      const srcOffset = 4 + i * FLOATS_PER_PUNCTUAL_LIGHT;
      const dstOffset =
        floatOffset + 4 + writeIndex * FLOATS_PER_PUNCTUAL_LIGHT;
      for (let f = 0; f < FLOATS_PER_PUNCTUAL_LIGHT; f++) {
        data[dstOffset + f] = packed[srcOffset + f];
      }
      writeIndex++;
    }
  }

  // 2. glTF KHR_lights_punctual lights -- model space, transform with
  // model.modelMatrix to get world space. Each entry's
  // position/direction is already model-space (node hierarchy applied
  // at parse time); we just multiply by the model matrix to lift to
  // world coords.
  const gltfLights = model?.lightsFromGltf;
  if (
    Array.isArray(gltfLights) &&
    gltfLights.length > 0 &&
    writeIndex < MAX_PUNCTUAL_LIGHTS
  ) {
    const mm = model.modelMatrix;
    const remaining = MAX_PUNCTUAL_LIGHTS - writeIndex;
    const gltfCount = Math.min(gltfLights.length, remaining);
    for (let i = 0; i < gltfCount; i++) {
      const lt = gltfLights[i];
      const dst = floatOffset + 4 + writeIndex * FLOATS_PER_PUNCTUAL_LIGHT;
      // Resolve world position / direction. Directional: posOrDir
      // holds direction; point/spot: posOrDir holds position.
      const wp = lt.position
        ? mm
          ? Matrix4.multiplyByPoint(mm, lt.position, scratchLightVec3a)
          : lt.position
        : null;
      const wd = lt.direction
        ? mm
          ? Matrix4.multiplyByPointAsVector(mm, lt.direction, scratchLightVec3b)
          : lt.direction
        : null;
      // Slots 0-2: posOrDir (directional uses direction; others use position).
      if (lt.type === 0 /* DIR */) {
        data[dst + 0] = wd?.x ?? 0;
        data[dst + 1] = wd?.y ?? 0;
        data[dst + 2] = wd?.z ?? 0;
      } else {
        data[dst + 0] = wp?.x ?? 0;
        data[dst + 1] = wp?.y ?? 0;
        data[dst + 2] = wp?.z ?? 0;
      }
      data[dst + 3] = lt.type;
      data[dst + 4] = lt.color?.red ?? 1;
      data[dst + 5] = lt.color?.green ?? 1;
      data[dst + 6] = lt.color?.blue ?? 1;
      data[dst + 7] = lt.intensity ?? 1;
      data[dst + 8] = lt.range ?? 0;
      // Const/linear/quadratic atten unused for spec-compliant range
      // attenuation; leave zero.
      data[dst + 12] = lt.innerConeAngle ?? 0;
      data[dst + 13] = lt.outerConeAngle ?? 0;
      // Spot direction at slots 16-18 (when applicable).
      if (lt.type === 2 /* SPOT */ && wd) {
        data[dst + 16] = wd.x;
        data[dst + 17] = wd.y;
        data[dst + 18] = wd.z;
      }
      writeIndex++;
    }
  }

  // Header: total lightCount.
  data[floatOffset] = writeIndex;
}

// Scratch Cartesians for the matrix-multiply in `packPunctualLights`
// (avoid per-frame allocation).
const scratchLightVec3a = new Cartesian3();
const scratchLightVec3b = new Cartesian3();

// ─── GPU Texture Creation from glTF TextureReader ────────────────────────────

/**
 * C10-05 — true when the reader's glTF/CesiumJS sampler requests a mipmapped
 * minification filter (the four `*_MIPMAP_*` variants, GL 9984-9987). Mirrors
 * `GltfTextureLoader`'s `samplerRequiresMipmap` / `WebGLStubTexture`'s
 * `wantsMipmaps` gate so the fallback allocation path matches WebGL parity: it
 * only builds a chain for textures WebGL would mipmap, and leaves LINEAR /
 * NEAREST (and all data-lookup) textures single-level.
 */
function readerRequestsMipmap(textureReader: ReaderOrNull): boolean {
  const sampler =
    textureReader?.texture?._sampler ||
    textureReader?.texture?.sampler ||
    textureReader?.sampler;
  const minFilter = sampler?.minificationFilter ?? sampler?.minFilter;
  // 9984 NEAREST_MIPMAP_NEAREST .. 9987 LINEAR_MIPMAP_LINEAR
  return (
    typeof minFilter === "number" && minFilter >= 9984 && minFilter <= 9987
  );
}

function createGPUTextureFromReader(
  device: GPUDevice,
  textureReader: ReaderOrNull,
  colorSpace: string,
  enqueueMip?: EnqueueMipFn,
): GPUTexture | null {
  if (!defined(textureReader)) {
    return null;
  }

  // Try to get the image source from the CesiumJS Texture
  const cesiumTexture = textureReader.texture;
  if (!defined(cesiumTexture)) {
    return null;
  }

  // Session 65 fix for "3D Tiles base color white" (Mars / Moon /
  // Aerometrex SF / BIM photogrammetry): in WebGPU mode the CesiumJS
  // Texture is backed by WebGLStubTexture, which uploads the image to
  // a real `GPUTexture` and stashes it on `texture._texture._webgpuTexture.texture`.
  // The previous implementation only looked at `cesiumTexture._source`
  // (the original ImageBitmap), which CesiumJS Texture does NOT
  // retain after upload — so every glTF / 3D Tiles texture fell back
  // to the white placeholder, which is exactly the symptom reported.
  // Reuse the already-uploaded GPU texture directly when available.
  const stubWrapper = cesiumTexture._texture;
  const stubGPU = stubWrapper && stubWrapper._webgpuTexture;
  if (stubGPU && stubGPU.texture) {
    return stubGPU.texture;
  }

  // The CesiumJS Texture._source holds the original ImageBitmap/HTMLImageElement
  const source =
    cesiumTexture._source || cesiumTexture.source || cesiumTexture._image;
  if (!defined(source)) {
    return null;
  }

  // Determine dimensions
  const width = source.width || source.naturalWidth || 1;
  const height = source.height || source.naturalHeight || 1;
  if (width === 0 || height === 0) {
    return null;
  }

  // Pick the texture format based on the semantic color space of the slot:
  //   "srgb" → rgba8unorm-srgb: GPU sampler auto-decodes sRGB → linear, so
  //            the shader doesn't need pow(x, 2.2) approximation, and
  //            linear filtering is perceptually correct.
  //   else   → rgba8unorm: stays in linear (correct for normal / MR /
  //            occlusion / data textures that must not be gamma-corrected).
  const format = colorSpace === "srgb" ? "rgba8unorm-srgb" : "rgba8unorm";

  // C10-05-MODEL-TEXTURE-MIP-CHAIN — secondary allocation path (only reached
  // when the CesiumJS Texture has no stub-owned `_webgpuTexture`; the stub path
  // above already allocates + generates a real chain for mipmap-sampler
  // textures). Give this branch a real mip chain too when the source sampler
  // requests mipmaps, so distant tiles trilinear-filter instead of aliasing
  // mip 0 — matching the stub path and WebGL. The source here is always an
  // uncompressed ImageBitmap (compressed KTX2 arrives with `internalFormat` and
  // takes `Texture.create` with its own transcoded chain, never this branch),
  // so `rgba8unorm[-srgb]` is RENDER_ATTACHMENT-capable for the blit. Mip
  // generation is routed through the frame-owned `enqueueImageryMipGeneration`
  // (C9-12A) — never a private submit from draw emission. Falls back to a
  // single level when no sink is provided or mipmaps are not requested.
  const wantsMips = defined(enqueueMip) && readerRequestsMipmap(textureReader);
  const mipLevelCount = wantsMips
    ? WebGPUMipmapGenerator.calculateMipLevelCount(width, height)
    : 1;

  try {
    const gpuTexture = device.createTexture({
      label: `Model glTF texture ${width}x${height} (${format})${
        mipLevelCount > 1 ? ` mip${mipLevelCount}` : ""
      }`,
      size: [width, height, 1],
      format,
      mipLevelCount,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    device.queue.copyExternalImageToTexture(
      { source: source as ImageBitmap, flipY: false },
      { texture: gpuTexture },
      { width, height },
    );

    // Enqueue the down-blit of levels 1..N-1 into the shared pre-frame submit.
    // The `copyExternalImageToTexture` of level 0 above is queued first, so it
    // completes before the blit reads it (queue submission order).
    if (mipLevelCount > 1 && defined(enqueueMip)) {
      enqueueMip(gpuTexture, format, mipLevelCount);
    }

    return gpuTexture;
  } catch (_e) {
    // Image source may not be usable (e.g., already transferred)
    return null;
  }
}

// ─── Vertex Buffer Creation ──────────────────────────────────────────────────

function createVertexBuffer(
  device: GPUDevice,
  data: TypedArray,
  label: string,
): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: Math.max(data.byteLength, 4),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

/**
 * NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU — expand a flat per-vertex color
 * array to dense RGBA (4 floats per vertex). glTF COLOR_0 may be VEC3 (RGB,
 * opaque) or VEC4 (RGBA); the edge emitter expects RGBA. RGB sources get an
 * implicit alpha of 1.0 (matching WebGL `collectVertexColors`, which pads
 * 3-component colors to opaque).
 *
 * @param {Float32Array} colorFloat Normalized color data (3 or 4 components per vertex).
 * @param {number} components 3 or 4.
 * @param {number} vertexCount Number of vertices.
 * @returns {Float32Array|null} `vertexCount * 4` RGBA floats, or null if unusable.
 * @private
 */
function expandColorsToRGBA(
  colorFloat: Float32Array | null | undefined,
  components: number,
  vertexCount: number,
): Float32Array | null {
  if (!defined(colorFloat) || !(components === 3 || components === 4)) {
    return null;
  }
  if (!defined(vertexCount) || vertexCount === 0) {
    return null;
  }
  if (colorFloat.length < vertexCount * components) {
    return null;
  }
  if (components === 4) {
    // Already RGBA — return a view sliced to the expected length to drop
    // any trailing padding.
    return colorFloat.length === vertexCount * 4
      ? colorFloat
      : colorFloat.subarray(0, vertexCount * 4);
  }
  const rgba = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    const src = i * 3;
    const dst = i * 4;
    rgba[dst] = colorFloat[src];
    rgba[dst + 1] = colorFloat[src + 1];
    rgba[dst + 2] = colorFloat[src + 2];
    rgba[dst + 3] = 1.0;
  }
  return rgba;
}

// ─── Joint Matrix Buffer ─────────────────────────────────────────────────────

/**
 * Creates or updates GPU storage buffer for joint matrices.
 * @private
 */
function ensureJointMatricesBuffer(
  device: GPUDevice,
  pipelineCache: PipelineCacheLike,
  nodeCache: NodeCache,
  skinData: SkinData,
) {
  const byteLength = skinData.byteLength;

  // Create storage buffer if it doesn't exist or joint count changed
  if (
    !defined(nodeCache.jointBuffer) ||
    nodeCache.jointBufferSize !== byteLength
  ) {
    if (defined(nodeCache.jointBuffer)) {
      nodeCache.jointBuffer.destroy();
    }
    nodeCache.jointBuffer = device.createBuffer({
      label: `Joint matrices (${skinData.jointCount} joints)`,
      size: byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    nodeCache.jointBufferSize = byteLength;
    // NEW-BG-CONSOLIDATION (Batch 122) — no standalone skinning BG
    // anymore. The renderer composes the merged group 2 BG per-frame
    // using `nodeCache.jointBuffer` directly.
  }

  // Upload joint matrices
  device.queue.writeBuffer(
    nodeCache.jointBuffer,
    0,
    skinData.packedJointMatrices,
  );
}

/**
 * Audit A.5 (Batch 130) — lazily allocates the per-node prev-frame
 * joint matrix storage buffer that the WGSL velocity pass binds
 * at group(2) binding(4). Sized to match the current `jointBuffer`
 * (`prevPackedJointMatrices` length × 4 bytes); recreated when the
 * skin's joint count changes (skin swaps are rare but legal in glTF).
 *
 * @private
 */
function ensurePrevJointMatricesBuffer(
  device: GPUDevice,
  nodeCache: NodeCache,
) {
  const byteLength = nodeCache.prevPackedJointMatrices.byteLength;
  if (
    !defined(nodeCache.prevJointBuffer) ||
    nodeCache.prevJointBuffer.size !== byteLength
  ) {
    if (defined(nodeCache.prevJointBuffer)) {
      nodeCache.prevJointBuffer.destroy();
    }
    nodeCache.prevJointBuffer = device.createBuffer({
      label: `Prev joint matrices`,
      size: byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }
}

// ─── Per-Primitive Cache ─────────────────────────────────────────────────────

/**
 * DP-H46b — push a primitive's generated metadata WGSL chunk + class hash
 * into the (per-Model) pipeline cache immediately before any `getPipeline*`
 * build, so the compiled module prepends the right `struct Metadata` and is
 * keyed by the right class. For non-metadata primitives this CLEARS the
 * cache's metadata state so a stale chunk from a sibling metadata primitive
 * can't leak in. Cheap (two field writes); must run before every pipeline
 * (re)build that could compile a fresh module for this primitive.
 *
 * @param {WebGPUModelPipelineCache} pipelineCache
 * @param {object} primCache per-primitive cache slot
 * @private
 */
/**
 * GLTF-POINTS-MODE — map a glTF primitive draw mode (`PrimitiveType` WebGL
 * enum, carried on `geometry.primitiveType` by `extractPrimitiveGeometry`)
 * to the GPUPrimitiveTopology the model pipelines bake in.
 *
 * Only POINTS (mode 0) maps away from the historical triangle-list today —
 * WebGL parity: `GeometryPipelineStage` adds `PRIMITIVE_TYPE_POINTS` and
 * `ModelVS.glsl` emits `gl_PointSize = 1.0` for unstyled POINTS glTFs,
 * which matches WebGPU point-list's fixed 1px rasterization. LINES /
 * LINE_STRIP / TRIANGLE_STRIP stay on the default (strip topologies also
 * need `stripIndexFormat` plumbing) — deferred until an asset needs them.
 * Note POINTS === 0, so compare with the enum, never truthiness.
 *
 * @param {number|undefined} primitiveType `PrimitiveType` value
 * @returns {string} GPUPrimitiveTopology
 * @private
 */
function topologyForPrimitiveType(primitiveType: number): GPUPrimitiveTopology {
  return primitiveType === PrimitiveType.POINTS
    ? "point-list"
    : "triangle-list";
}

function applyPrimitiveMetadataToPipelineCache(
  pipelineCache: PipelineCacheLike,
  primCache: PrimitiveRenderData,
) {
  // GLTF-POINTS-MODE — sticky topology rides the same "set before every
  // getPipeline* build" contract as the metadata/customShader chunks below.
  // Defaults to triangle-list for records that predate the field.
  pipelineCache.setPrimitiveTopology(primCache?.topology ?? "triangle-list");
  if (defined(primCache?._metadataWGSL)) {
    pipelineCache.setMetadataWGSL(
      primCache._metadataWGSL,
      primCache._metadataClassHash | 0,
      primCache._metadataMatTransport === true,
    );
  } else {
    pipelineCache.clearMetadataWGSL();
  }
  // PARITY-CUSTOM-SHADER-WGSL — set/clear the customShader chunk the same way so
  // `_getOrCreateShaderModule` prepends it + keys the module by the customShader
  // class for every pipeline (re)build of this primitive.
  if (defined(primCache?._customShaderWGSL)) {
    pipelineCache.setCustomShaderWGSL(
      primCache._customShaderWGSL,
      primCache._customShaderClassHash | 0,
    );
  } else {
    pipelineCache.clearCustomShaderWGSL();
  }
}

/**
 * PARITY-CUSTOM-SHADER-WGSL — (re)build the model-level native-WGSL customShader
 * resources onto `cache._customShader`:
 *   - `chunk` / `classHash` — the generated WGSL (prepended per-primitive).
 *   - `defines` — MODEL_HAS_WGSL_CUSTOM_SHADER (+ _VERTEX) OR-mask.
 *   - `uboBuffer` — the packed uniforms UBO (refreshed every frame from the
 *     customShader's live uniform values, so `setUniform` takes effect).
 *   - `textureFields` — resolved custom-texture uniform fields.
 *
 * The generated chunk is rebuilt only when the customShader reference (or its
 * WGSL class hash) changes; the UBO contents are re-uploaded every frame (cheap:
 * a handful of vec4s). When the model has no native-WGSL customShader, clears
 * the slot so `defines === 0` and every primitive stays byte-identical.
 *
 * @private
 */
/**
 * PARITY-CUSTOM-SHADER-WGSL (translucencyMode slice) — a model's
 * {@link CustomShader#translucencyMode} overrides the primitive's effective
 * alpha mode, matching WebGL's {@link CustomShaderPipelineStage} (which sets
 * `alphaOptions.pass`). TRANSLUCENT forces the primitive into the blended
 * translucent pass; OPAQUE forces the opaque pass; INHERIT (the default) leaves
 * the glTF material's alpha mode untouched.
 *
 * `matInfo` is a fresh object from `extractMaterialInfo` each frame, so mutating
 * its `alphaMode` in place is safe and cascades to EVERY downstream consumer —
 * the color pipeline's blend state (`getPipeline(matInfo.alphaMode, ...)`), the
 * `passClass` tile-batch scalar, the draw-pass selection (`Pass.TRANSLUCENT` vs
 * `model.opaquePass`), and the BLEND depth-write variant — all of which read
 * `matInfo.alphaMode` as the single source of truth.
 *
 * DEFAULT-OFF byte-identical: a model with no customShader, or one whose
 * translucencyMode is INHERIT, takes the early return so matInfo is unchanged
 * and the primitive keeps its authored alpha mode.
 *
 * @param {object} matInfo
 * @param {import("../../Scene/Model/Model.js").default} model
 * @private
 */
function applyCustomShaderTranslucency(
  matInfo: MaterialInfo,
  model: ModelLike,
) {
  const customShader = model.customShader;
  if (!defined(customShader)) {
    return;
  }
  const mode = customShader.translucencyMode;
  if (mode === CustomShaderTranslucencyMode.TRANSLUCENT) {
    matInfo.alphaMode = AlphaModes.BLEND;
  } else if (mode === CustomShaderTranslucencyMode.OPAQUE) {
    matInfo.alphaMode = AlphaModes.OPAQUE;
  }
  // INHERIT → leave matInfo.alphaMode as extracted (byte-identical off path).
}

function ensureModelCustomShaderResources(
  device: GPUDevice,
  model: ModelLike,
  cache: ModelWebGPUCache,
  pipelineCache: PipelineCacheLike,
) {
  const customShader = model.customShader;
  const hasWgsl =
    defined(customShader) &&
    (defined(customShader.wgslFragmentShaderText) ||
      defined(customShader.wgslVertexShaderText));
  if (!hasWgsl) {
    // Release any prior resources (customShader removed / swapped to GLSL-only).
    if (defined(cache._customShader?.uboBuffer)) {
      cache._customShader.uboBuffer.destroy();
    }
    cache._customShader = null;
    return;
  }

  let cs = cache._customShader;
  // Rebuild the generated chunk when the customShader reference changes.
  if (!defined(cs) || cs.customShader !== customShader) {
    const generated = generateCustomShaderWGSL(customShader);
    if (!defined(generated)) {
      // Native-WGSL vertex-only without a fragment body isn't supported by the
      // generator (needs a fragment body); fall back to no customShader.
      if (defined(cs?.uboBuffer)) {
        cs.uboBuffer.destroy();
      }
      cache._customShader = null;
      return;
    }
    if (defined(cs?.uboBuffer)) {
      cs.uboBuffer.destroy();
    }
    let defines = ShaderDefine.MODEL_HAS_WGSL_CUSTOM_SHADER;
    if (generated.hasVertex) {
      defines |= ShaderDefine.MODEL_HAS_WGSL_CUSTOM_VERTEX;
    }
    cs = {
      customShader,
      chunk: generated.wgsl,
      classHash: generated.classHash | 0,
      defines,
      uboFields: generated.uboFields,
      textureFields: generated.textureFields as Array<{ uniformName: string }>,
      uboBuffer: null,
      uboByteLength: 0,
    };
    cache._customShader = cs;
  }

  // (Re)pack + upload the uniforms UBO from the live uniform values every frame.
  const packed = packUniformBuffer(cs.uboFields as object[], customShader);
  if (!defined(cs.uboBuffer) || cs.uboByteLength !== packed.byteLength) {
    if (defined(cs.uboBuffer)) {
      cs.uboBuffer.destroy();
    }
    cs.uboBuffer = device.createBuffer({
      label: "CustomShader uniforms UBO",
      size: packed.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    cs.uboByteLength = packed.byteLength;
  }
  device.queue.writeBuffer(cs.uboBuffer, 0, packed);
}

/**
 * PARITY-CUSTOM-SHADER-WGSL — build the customShader group-1 bind-group entries
 * (UBO at binding 50 + `MAX_CUSTOM_TEXTURES` texture/sampler pairs at 51+). Real
 * custom textures are resolved from the customShader's TextureManager (WebGPU
 * view); unused / not-yet-loaded slots fall back to the pipeline cache's 1×1
 * white placeholder + default sampler so every BGL entry is satisfied. Returns
 * `[]` when the model has no native-WGSL customShader (so the entry list matches
 * the minimal materialBGL).
 *
 * @private
 */
function getCustomShaderEntries(
  cache: ModelWebGPUCache,
  pipelineCache: PipelineCacheLike,
) {
  const cs = cache._customShader;
  if (!defined(cs) || !defined(cs.uboBuffer)) {
    return [];
  }
  const entries: GPUBindGroupEntry[] = [
    { binding: CUSTOM_SHADER_UBO_BINDING, resource: { buffer: cs.uboBuffer } },
  ];
  const placeholderView = pipelineCache.defaultWhiteTexture.createView();
  const textureFields = cs.textureFields ?? [];
  for (let k = 0; k < MAX_CUSTOM_TEXTURES; k++) {
    let view = placeholderView;
    if (k < textureFields.length) {
      const tex = cs.customShader._textureManager?.getTexture(
        textureFields[k].uniformName,
      );
      const wgpuView = tex?._webgpuTexture?.view;
      if (defined(wgpuView)) {
        view = wgpuView;
      }
    }
    entries.push({
      binding: CUSTOM_SHADER_TEXTURE_BINDING_BASE + k,
      resource: view,
    });
  }
  // ONE shared sampler for all custom textures.
  entries.push({
    binding: CUSTOM_SHADER_SAMPLER_BINDING,
    resource: pipelineCache.defaultSampler,
  });
  return entries;
}

function getPrimitiveGeometryView(
  cache: ModelWebGPUCache,
  primKey: string,
  base: PrimitiveGeometry,
): PrimitiveGeometryViewRecord {
  const geometryViews = (cache.geometryViews ??= {});
  let record = geometryViews[primKey];
  if (!defined(record) || record.base !== base) {
    record = {
      base,
      view: createPrimitiveGeometryView(base) as PrimitiveGeometry,
    };
    geometryViews[primKey] = record;
  } else {
    resetPrimitiveGeometryView(record.view, base);
  }
  return record;
}

function getGeometryAnnotationMask(geometry: PrimitiveGeometry): number {
  return (
    (geometry.hasFeatureId0 ? 1 : 0) |
    (geometry.hasMetadata ? 2 : 0) |
    (geometry.hasPropertyTextures ? 4 : 0) |
    (geometry.hasPropertyTables ? 8 : 0) |
    (geometry.metadataMatTransport ? 16 : 0)
  );
}

/**
 * Creates or retrieves cached GPU resources for a single primitive.
 * @private
 */
function ensurePrimitiveCache(
  device: GPUDevice,
  cache: ModelWebGPUCache,
  pipelineCache: PipelineCacheLike,
  primKey: string | number,
  geometry: PrimitiveGeometry,
  matInfo: MaterialInfo,
  enqueueMip?: EnqueueMipFn,
): PrimitiveRenderData {
  if (defined(cache.primitives[primKey])) {
    return cache.primitives[primKey];
  }

  const primCache: PrimitiveRenderData = {
    positionBuffer: null,
    normalBuffer: null,
    tangentBuffer: null,
    uvBuffer: null,
    colorBuffer: null,
    jointsBuffer: null,
    weightsBuffer: null,
    featureIdBuffer: null,
    // DP-H46a — per-vertex scalar metadata buffer (EXT_structural_metadata
    // property ATTRIBUTE), bound at vertex slot 9 when MODEL_HAS_METADATA
    // is set. Created from `geometry.metadataData` below; owned by
    // `WebGPUModelMetadata.ensureMetadataResources` for the GPU upload.
    _metadataBuffer: null,
    // NEW-MODEL-METADATA-MAT3-MAT4 — true when the slot-9 buffer carries the
    // widened 16-float MAT3/MAT4 transport (stride 64, locations 9-12).
    // Persisted from `geometry.metadataMatTransport` below and fed to the
    // pipeline cache's sticky state on every pipeline (re)build.
    _metadataMatTransport: false,
    // DP-H46c — property-texture bind-group entries (bindings 39..),
    // resolved + uploaded by `ensurePropertyTextureResources`. Spliced into
    // the merged group-1 bind group when MODEL_HAS_PROPERTY_TEXTURES is set.
    _propertyTextureResources: null,
    propertyTextureEntries: null,
    // DP-H46d — property-table bind-group entries (bindings 44-45), resolved +
    // uploaded by `ensurePropertyTableResources`. Spliced into the merged
    // group-1 bind group when MODEL_HAS_PROPERTY_TABLES is set.
    _propertyTableResources: null,
    propertyTableEntries: null,
    indexBuffer: null,
    indexCount: 0,
    indexFormat: "uint16",
    vertexCount: geometry.vertexCount,
    // GLTF-POINTS-MODE — GPUPrimitiveTopology keyed off the glTF
    // primitive.mode. Every pipeline (re)build for this primitive feeds it
    // to the pipeline cache via `applyPrimitiveMetadataToPipelineCache`.
    topology: topologyForPrimitiveType(geometry.primitiveType),
    materialBindGroup: null,
    textureBindGroup: null,
    pipeline: null,
    gpuTextures: [],
    hasSkinningAttributes: false,
  };

  // Position buffer (model-space, 3 floats per vertex — NOT high/low split)
  primCache.positionBuffer = createVertexBuffer(
    device,
    geometry.positionData,
    `Prim position`,
  );

  // Normal buffer
  if (geometry.hasNormals) {
    primCache.normalBuffer = createVertexBuffer(
      device,
      geometry.normalData,
      `Prim normal`,
    );
  }

  // Tangent buffer
  if (geometry.hasTangents) {
    primCache.tangentBuffer = createVertexBuffer(
      device,
      geometry.tangentData,
      `Prim tangent`,
    );
  }

  // TexCoord0 buffer
  if (geometry.hasTexCoord0) {
    primCache.uvBuffer = createVertexBuffer(
      device,
      geometry.texCoord0Data,
      `Prim uv0`,
    );
  }

  // TexCoord1 buffer — glTF textureInfos carry a `texCoord: 0|1` flag,
  // so occlusion + clearcoat-normal frequently want TEXCOORD_1 while the
  // base color stays on TEXCOORD_0. Upload the slot whenever the primitive
  // provided it; the pipeline layout + shader consumer wire it to the
  // binding used by textures whose texCoord == 1 (see
  // WebGPUModelPipelineCache.js vertex-layout slot 7 / TEXCOORD_1).
  if (geometry.hasTexCoord1 && defined(geometry.texCoord1Data)) {
    primCache.uv1Buffer = createVertexBuffer(
      device,
      geometry.texCoord1Data,
      `Prim uv1`,
    );
  }

  // Color0 buffer (normalize to float32)
  if (geometry.hasColor0) {
    const colorFloat = normalizeColorData(
      geometry.color0Data,
      geometry.color0ComponentType,
      geometry.color0Normalized,
    );
    // DP-H37 — the slot-4 vertex layout is float32x4 (16-byte stride), but a
    // glTF COLOR_0 accessor may be VEC3 (12-byte stride). `normalizeColorData`
    // converts the component TYPE but preserves the component COUNT, so a VEC3
    // source produces a 12-byte-stride buffer that the GPU reads at a 16-byte
    // stride → progressively shifted, corrupted vertex colors. Widen RGB→RGBA
    // (alpha = 1.0) so the stride matches the layout, mirroring the edge
    // emitter's path; `expandColorsToRGBA` is a no-op for VEC4 sources.
    // Component count is detected from the buffer length (the geometry's
    // `color0ComponentCount` is not plumbed through the WebGPU path).
    const color0Components =
      defined(colorFloat) && geometry.vertexCount > 0
        ? Math.round(colorFloat.length / geometry.vertexCount)
        : 4;
    const rgba = expandColorsToRGBA(
      colorFloat,
      color0Components,
      geometry.vertexCount,
    );
    primCache.colorBuffer = createVertexBuffer(
      device,
      rgba ?? colorFloat,
      `Prim color`,
    );
  }

  // Joints0 buffer (for skinning)
  if (geometry.hasJoints && defined(geometry.joints0Data)) {
    // JOINTS_0 must be uint32x4 for the shader
    let jointsData = geometry.joints0Data;
    if (!(jointsData instanceof Uint32Array)) {
      // Convert from Uint8Array or Uint16Array to Uint32Array
      jointsData = new Uint32Array(jointsData);
    }
    primCache.jointsBuffer = createVertexBuffer(
      device,
      jointsData,
      `Prim joints`,
    );
    primCache.hasSkinningAttributes = true;
  }

  // Weights0 buffer (for skinning)
  if (defined(geometry.weights0Data)) {
    primCache.weightsBuffer = createVertexBuffer(
      device,
      geometry.weights0Data,
      `Prim weights`,
    );
  }

  // Audit B.2 (Batch 130) — `_FEATURE_ID_0` (b3dm `_BATCHID`) vertex
  // buffer. Required for per-feature pick / per-feature styling on
  // tilesets that encode feature IDs as a vertex attribute (the
  // dominant b3dm case). Without this slot bound, the FS pick path
  // can only resolve features when the source uses the
  // EXT_mesh_features texture variant — almost no production tileset
  // does.
  if (geometry.hasFeatureId0 && defined(geometry.featureId0Data)) {
    primCache.featureIdBuffer = createVertexBuffer(
      device,
      geometry.featureId0Data,
      `Prim featureId`,
    );
  }

  // DP-H46a — EXT_structural_metadata property-ATTRIBUTE vertex buffer
  // (slot 9). `geometry.metadataData` is the per-vertex scalar resolved
  // at the extractPrimitiveGeometry call site; the GPU upload is owned by
  // `WebGPUModelMetadata.ensureMetadataResources` (parallel to how the
  // featureId path splits buffer ownership). Only present when the model
  // has structural metadata mapping to this primitive — otherwise
  // `geometry.metadataData` is undefined and slot 9 is omitted from the
  // layout, keeping non-metadata models byte-identical.
  if (geometry.hasMetadata && defined(geometry.metadataData)) {
    ensureMetadataResources(
      device,
      primCache,
      geometry.metadataData as Float32Array,
    );
  }
  // DP-H46c — property-TEXTURE GPU resources. Upload each unique physical
  // property texture (sourced from the glTF texture reader, like PBR
  // textures) + the shared property sampler, producing the bind-group entries
  // spliced into group 1 below. Only when the primitive maps ≥1 property
  // texture; non-property-texture models leave `propertyTextureEntries` null
  // and stay byte-identical.
  if (geometry.hasPropertyTextures && defined(geometry.propertyTextureLayout)) {
    const ptResources = ensurePropertyTextureResources(
      device,
      primCache,
      geometry.propertyTextureLayout,
      (reader) => createGPUTextureFromReader(device, reader, "linear"),
      pipelineCache.defaultPropertyTexture,
      pipelineCache.propertyTextureSampler,
    );
    if (defined(ptResources)) {
      // Pad to the full MAX_PROPERTY_TEXTURES BGL slot count with placeholders.
      primCache.propertyTextureEntries = pipelineCache.propertyTextureEntries(
        ptResources.entries,
      );
    }
  }
  // DP-H46d — property-TABLE GPU resources. Re-upload the loader's retained
  // packed RGBA8 bytes into ONE rgba8unorm GPUTexture (rows = properties,
  // columns = features), producing the (texture, sampler) bind-group entries
  // spliced into group 1 below. Only when the primitive maps a GPU-compatible
  // property table via an attribute feature-ID set; non-property-table models
  // leave `propertyTableEntries` null and stay byte-identical.
  if (geometry.hasPropertyTables && defined(geometry.propertyTableLayout)) {
    const tblResources = ensurePropertyTableResources(
      device,
      primCache,
      geometry.propertyTableLayout,
      pipelineCache.propertyTextureSampler,
    );
    if (defined(tblResources)) {
      primCache.propertyTableEntries = pipelineCache.propertyTableEntries(
        tblResources.entries,
      );
    }
  }
  // DP-H46b/c — persist the generated WGSL chunk + class hash on the primitive
  // cache so every pipeline (re)build for this primitive (color / pick /
  // depth-write / velocity / classification) prepends the same chunk and keys
  // its module by the same class. The renderer feeds them to the pipeline
  // cache via `setMetadataWGSL` immediately before each `getPipeline*` call
  // below. Persisted when the primitive has EITHER attributes or textures.
  if (
    (geometry.hasMetadata ||
      geometry.hasPropertyTextures ||
      geometry.hasPropertyTables) &&
    defined(geometry.metadataWGSL)
  ) {
    primCache._metadataWGSL = geometry.metadataWGSL;
    primCache._metadataClassHash = geometry.metadataClassHash | 0;
    // NEW-MODEL-METADATA-MAT3-MAT4 — persist the widened-transport flag so
    // every pipeline (re)build for this primitive feeds the pipeline cache's
    // sticky `metadataMatTransport` state alongside the chunk.
    primCache._metadataMatTransport = geometry.metadataMatTransport === true;
  }

  // GLTF-POINTS-MODE — non-indexed POINTS primitives (the common shape for
  // mode-0 glTFs, e.g. PointCloudWithRGBColors) synthesize sequential
  // indices so the command takes the drawIndexed path. Rationale: WebGPU
  // validates a non-indexed `draw(vertexCount)` CPU-side against EVERY
  // vertex-step buffer's bound size, and the missing-attribute slots
  // (normal/tangent/uv/joints/weights on a typical point cloud) bind the
  // pipeline cache's 1-element default buffers — fine for `drawIndexed`,
  // whose out-of-range vertex fetches clamp to zero via robust access
  // (the Batch 245 BoxInstancedNoNormals precedent), but a hard
  // validation error for `draw()` ("Vertex range requires a larger
  // buffer"). Sequential indices are GPU-equivalent for point-list.
  // Non-indexed TRIANGLES primitives keep the historical draw() path
  // untouched (off-gate: topology + this synthesis key strictly off
  // primitive.mode); they share the same validation gap when attributes
  // are missing — tracked as follow-up, not papered over here.
  if (!defined(geometry.indexData) && primCache.topology === "point-list") {
    const n = geometry.vertexCount;
    const seq = n < 65536 ? new Uint16Array(n) : new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      seq[i] = i;
    }
    geometry.indexData = seq;
    geometry.indexCount = n;
    geometry.indexType = n < 65536 ? "UNSIGNED_SHORT" : "UNSIGNED_INT";
  }

  // Index buffer
  if (defined(geometry.indexData)) {
    primCache.indexFormat =
      geometry.indexType === "UNSIGNED_INT" ? "uint32" : "uint16";
    primCache.indexCount = geometry.indexCount;
    // WebGPU requires `writeBuffer` source byteLength to be a multiple
    // of 4. Uint16 index buffers with an odd index count produce
    // `byteLength % 4 === 2`, which the original code passed straight
    // to `writeBuffer` and crashed under glTF models that have one —
    // CZML Model Articulations is one such asset. Pad the buffer +
    // source to the nearest 4 bytes; the extra slot is never read
    // because `indexCount` stays at the geometry's authoritative
    // value (Session 65 Batch 5, 2026-05-11).
    const indexByteLength = geometry.indexData.byteLength;
    const alignedIndexByteLength = (indexByteLength + 3) & ~3;
    primCache.indexBuffer = device.createBuffer({
      label: `Prim index`,
      size: Math.max(alignedIndexByteLength, 4),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    if (alignedIndexByteLength === indexByteLength) {
      device.queue.writeBuffer(primCache.indexBuffer, 0, geometry.indexData);
    } else {
      const padded = new Uint8Array(alignedIndexByteLength);
      padded.set(
        new Uint8Array(
          geometry.indexData.buffer,
          geometry.indexData.byteOffset,
          indexByteLength,
        ),
      );
      device.queue.writeBuffer(primCache.indexBuffer, 0, padded);
    }
  }

  // Pipeline (varies by alpha mode and double-sided)
  // Batch 174 — B.4 select the materialDefines bitmask based on the
  // primitive's material flags. Track the value on primCache so
  // subsequent pipeline lookups (pick, velocity, classification,
  // depth-write) stay consistent across passes for this primitive.
  // This same value is also used to filter the texture-entries array
  // and select the matching per-variant materialBGL when building
  // the merged group 1 bind group below.
  // Session 62 NEW-VR-VERTEX-BUFFER-VARIANT — primitive's TEXCOORD_1
  // attribute presence drives MODEL_HAS_TEXCOORD_1. When unset, the
  // pipeline omits vertex buffer slot 7 (8-slot layout, fitting Edge's
  // adapter cap of `maxVertexBuffers = 8`); when set, the layout
  // includes slot 7 (9 slots, requires adapter ≥ 9).
  //
  // Session 65 follow-up — same treatment for slot 8 (featureId0). With
  // both flags off (the common case for standard glTF models without
  // multi-UV or batched feature IDs) the pipeline lands at 7 slots,
  // leaving headroom on Edge's adapter. The implicit-range synthesis
  // above sets `geometry.hasFeatureId0 = true` when a batched 3D Tile
  // expects feature IDs but the glTF accessor is missing, so this read
  // sees the final, post-synthesis value.
  let materialDefines = computeMaterialDefines(matInfo.materialFlags);
  if (geometry.hasTexCoord1) {
    materialDefines |= ShaderDefine.MODEL_HAS_TEXCOORD_1;
  }
  if (geometry.hasFeatureId0) {
    materialDefines |= ShaderDefine.MODEL_HAS_FEATURE_ID_0;
  }
  // DP-H46a — presence gate. Flip MODEL_HAS_METADATA only when the
  // primitive actually carries a property-ATTRIBUTE scalar (resolved into
  // `geometry.metadataData` upstream + uploaded above). This adds vertex
  // slot 9 to the layout + activates the WGSL metadata ifdef blocks. When
  // unset (the common case), the bit is absent, the layout omits slot 9,
  // the WGSL preprocessor strips every metadata block, and the model is
  // byte-identical to the pre-DP-H46a path.
  if (geometry.hasMetadata && defined(primCache._metadataBuffer)) {
    materialDefines |= ShaderDefine.MODEL_HAS_METADATA;
  }
  // DP-H46c — presence gate. Flip MODEL_HAS_PROPERTY_TEXTURES only when the
  // primitive actually maps ≥1 GPU-compatible property texture AND its
  // bind-group entries resolved. This selects the property-texture materialBGL
  // variant (extra sampled-texture bindings 39..) + activates the generated
  // chunk's binding/sampling code. Independent of MODEL_HAS_METADATA (a model
  // can have property textures without property attributes, and vice versa).
  // When unset (the common case), the bit is absent, the minimal materialBGL
  // is used, and the model is byte-identical to the pre-DP-H46c path.
  if (
    geometry.hasPropertyTextures &&
    defined(primCache.propertyTextureEntries)
  ) {
    materialDefines |= ShaderDefine.MODEL_HAS_PROPERTY_TEXTURES;
  }
  // DP-H46d — presence gate. Flip MODEL_HAS_PROPERTY_TABLES only when the
  // primitive maps a GPU-compatible property table AND its bind-group entries
  // resolved. This selects the property-table materialBGL variant (extra
  // sampled-texture binding 44 + sampler 45) + activates the generated chunk's
  // textureLoad code. Independent of the attribute/texture metadata bits. When
  // unset (the common case), the bit is absent, the minimal materialBGL is
  // used, and the model is byte-identical to the pre-DP-H46d path.
  if (geometry.hasPropertyTables && defined(primCache.propertyTableEntries)) {
    materialDefines |= ShaderDefine.MODEL_HAS_PROPERTY_TABLES;
  }
  // PARITY-CUSTOM-SHADER-WGSL — OR in the model-level customShader defines
  // (MODEL_HAS_WGSL_CUSTOM_SHADER + optional _VERTEX) + stash the generated
  // chunk/hash on the primitive so every pipeline (re)build for this primitive
  // prepends it and keys its module by the customShader class. When the model
  // has no native-WGSL customShader, `cache._customShader` is null → no bits,
  // no chunk, byte-identical.
  if (defined(cache._customShader)) {
    materialDefines |= cache._customShader.defines;
    primCache._customShaderWGSL = cache._customShader.chunk;
    primCache._customShaderClassHash = cache._customShader.classHash | 0;
  }
  primCache.materialDefines = materialDefines;
  // DP-H46b — feed the generated metadata chunk + class hash to the pipeline
  // cache before the build (no-op clear for non-metadata primitives).
  applyPrimitiveMetadataToPipelineCache(pipelineCache, primCache);
  primCache.pipeline = pipelineCache.getPipeline(
    matInfo.alphaMode,
    matInfo.isDoubleSided,
    materialDefines,
  );

  // C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 79) — for translucent BLEND
  // primitives we eagerly cache the depth-write variant too. A 3D-tile
  // model whose content carries this primitive may set
  // `depthForTranslucentClassification = true` on its WebGPUDrawCommand
  // (per `Cesium3DTile.update`); when that flag is set the command will
  // bind this variant in `WebGPUDrawCommand.execute()` so the tile
  // surface populates the scene-FB depth attachment, letting the
  // stencil-based GroundPrimitive classifier clip against the tile.
  // OPAQUE/MASK primitives already write depth, so the variant only
  // matters for BLEND.
  if (matInfo.alphaMode === AlphaModes.BLEND) {
    primCache.depthWritePipeline = pipelineCache.getDepthWritePipeline(
      matInfo.alphaMode,
      matInfo.isDoubleSided,
      materialDefines,
    );
  }

  // Create GPU textures from glTF image sources
  const textures = createMaterialTextures(
    device,
    pipelineCache,
    matInfo,
    enqueueMip,
  );
  primCache.gpuTextures = textures.created;
  // Stash matInfo + placeholderSlots so the per-frame
  // refreshDeferredModelTextures helper can poll the readers and
  // upgrade fallback-textured slots when the real images finish
  // loading. See refreshDeferredModelTextures() comment.
  primCache.matInfo = matInfo;
  primCache.placeholderSlots = textures.placeholderSlots;

  // Texture bind group — one sampler per slot, resolved from the glTF
  // textureInfo's sampler block so per-texture magFilter / wrapS / wrapT
  // actually propagate. Missing samplers fall back to defaultSampler
  // (linear / linear / repeat) which matches the glTF spec default.
  const defSampler = pipelineCache.defaultSampler;
  const baseSampler = pipelineCache.getSamplerForReader(
    matInfo.baseColorTextureReader || matInfo.diffuseTextureReader,
  );
  const normalSampler = pipelineCache.getSamplerForReader(
    matInfo.normalTextureReader,
  );
  const mrSampler = pipelineCache.getSamplerForReader(
    matInfo.metallicRoughnessTextureReader || matInfo.specGlossTextureReader,
  );
  const emissiveSampler = pipelineCache.getSamplerForReader(
    matInfo.emissiveTextureReader,
  );
  const occlusionSampler = pipelineCache.getSamplerForReader(
    matInfo.occlusionTextureReader,
  );
  // Cache per-binding views + samplers on the prim cache so the
  // texture bind group can be rebuilt cheaply when the SceneRenderer's
  // refraction capture (Batch 107) publishes a new
  // `_refractionSceneView`. Without this cache the rebuild would have
  // to re-create the views every frame from `textures.*`.
  primCache.textureViews = {
    baseColor: textures.baseColor.createView(),
    normal: textures.normal.createView(),
    metallicRoughness: textures.metallicRoughness.createView(),
    emissive: textures.emissive.createView(),
    occlusion: textures.occlusion.createView(),
    clearcoat: textures.clearcoat.createView(),
    specularColor: textures.specularColor.createView(),
    anisotropy: textures.anisotropy.createView(),
    iridescence: textures.iridescence.createView(),
    sheenColor: textures.sheenColor.createView(),
    thickness: textures.thickness.createView(),
    clearcoatRoughness: textures.clearcoatRoughness.createView(),
    clearcoatNormal: textures.clearcoatNormal.createView(),
    sheenRoughness: textures.sheenRoughness.createView(),
    specularFactor: textures.specularFactor.createView(),
    iridescenceThickness: textures.iridescenceThickness.createView(),
    transmission: textures.transmission.createView(),
    refractionPlaceholder: textures.refractionScene.createView(),
  };
  primCache.textureSamplers = {
    base: baseSampler || defSampler,
    normal: normalSampler || defSampler,
    mr: mrSampler || defSampler,
    emissive: emissiveSampler || defSampler,
    occlusion: occlusionSampler || defSampler,
    def: defSampler,
  };
  // NEW-BG-CONSOLIDATION (Batch 122) — track texture entries on the
  // primCache. The full merged group 1 bind group is built per-frame
  // at the draw command emission site; this is just the cached
  // texture portion.
  // Batch 174 — entries are now filtered by `primCache.materialDefines`:
  // basic variant emits bindings 2-11 only; full variant emits 2-25.
  // The matching per-variant `materialBGL` is selected at bind-group
  // construction time via `pipelineCache.getOrCreateMaterialBGL(materialDefines)`.
  primCache.textureEntries = getModelTextureEntries(
    primCache,
    null,
    materialDefines,
    getCustomShaderEntries(cache, pipelineCache),
  );
  primCache.refractionViewBound = null;

  cache.primitives[primKey] = primCache;
  return primCache;
}

/**
 * NEW-BG-CONSOLIDATION (Batch 122) — returns the texture portion of the
 * merged group 1 bind group as an `entries[]` array. Bindings 0-1
 * (material+light UBOs) and 26-32 (featureId) are spliced in at the
 * renderer's per-frame draw-command emission site.
 *
 * Was the standalone "texture bind group" prior to NEW-BG-CONSOLIDATION;
 * binding numbers are shifted by +2 because slots 0-1 are now occupied
 * by the merged material/light UBOs.
 *
 * Batch 174 — KHR materialBGL split. The texture entries for bindings
 * 12-25 are gated on the variant's `materialDefines` mask: basic
 * variant (`materialDefines = 0`) emits PBR bindings 2-11 only; full
 * variant (`MODEL_HAS_KHR_TEXTURES` set) emits 2-25. The returned
 * array MUST match the layout of the per-variant `materialBGL`
 * fetched via `pipelineCache.getOrCreateMaterialBGL(materialDefines)`,
 * or `device.createBindGroup` will reject the entry list.
 *
 * @private
 * @param {object} primCache
 * @param {GPUTextureView | null} refractionView - Optional refraction
 *   capture view from the SceneRenderer; bound at slot 25 when the
 *   variant includes it, else falls back to the cached placeholder.
 * @param {number} materialDefines - Variant mask (bitmask of
 *   ShaderDefine bits). When `MODEL_HAS_KHR_TEXTURES` is set, the
 *   KHR slots (12-25) are emitted; when clear they're omitted.
 */
function getModelTextureEntries(
  primCache: PrimitiveRenderData,
  refractionView: GPUTextureView | null,
  materialDefines: number,
  customShaderEntries: GPUBindGroupEntry[] | null | undefined,
) {
  const v = primCache.textureViews;
  const s = primCache.textureSamplers;
  const entries: GPUBindGroupEntry[] = [
    // 2-11: PBR (always, both basic and full variants)
    { binding: 2, resource: v.baseColor },
    { binding: 3, resource: s.base },
    { binding: 4, resource: v.normal },
    { binding: 5, resource: s.normal },
    { binding: 6, resource: v.metallicRoughness },
    { binding: 7, resource: s.mr },
    { binding: 8, resource: v.emissive },
    { binding: 9, resource: s.emissive },
    { binding: 10, resource: v.occlusion },
    { binding: 11, resource: s.occlusion },
  ];

  // 12-25: KHR — gated on materialDefines. Emitted only when the
  // matching gate define is set. Today every KHR slot shares a single
  // gate (`MODEL_HAS_KHR_TEXTURES`); when the WGSL ifdefs are split
  // per-extension this branching mirrors the manifest in the pipeline
  // cache so each KHR group's slots only emit when its specific gate
  // bit is in the variant.
  if ((materialDefines & ShaderDefine.MODEL_HAS_KHR_TEXTURES) !== 0) {
    entries.push(
      { binding: 12, resource: v.clearcoat },
      { binding: 13, resource: v.specularColor },
      { binding: 14, resource: v.anisotropy },
      { binding: 15, resource: v.iridescence },
      { binding: 16, resource: v.sheenColor },
      { binding: 17, resource: v.thickness },
      { binding: 18, resource: v.clearcoatRoughness },
      { binding: 19, resource: v.clearcoatNormal },
      { binding: 20, resource: v.sheenRoughness },
      { binding: 21, resource: v.specularFactor },
      { binding: 22, resource: v.iridescenceThickness },
      { binding: 23, resource: s.def },
      { binding: 24, resource: v.transmission },
      // Binding 25: refractionSceneTexture. When the SceneRenderer's
      // capture pass has published a view, use it. Otherwise fall back
      // to the cached white placeholder (the FS gates this sample on
      // FLAG_HAS_TRANSMISSION).
      {
        binding: 25,
        resource: refractionView ?? v.refractionPlaceholder,
      },
    );
  }

  // 39..: DP-H46c — property-texture block. The renderer resolved + padded
  // these to the full MAX_PROPERTY_TEXTURES slot count (real textures + 1×1
  // placeholders) in `ensurePrimitiveCache`. Emitted only when the variant
  // includes MODEL_HAS_PROPERTY_TEXTURES so non-property-texture models keep
  // the minimal entry list matching their materialBGL.
  if (
    (materialDefines & ShaderDefine.MODEL_HAS_PROPERTY_TEXTURES) !== 0 &&
    defined(primCache.propertyTextureEntries)
  ) {
    for (let i = 0; i < primCache.propertyTextureEntries.length; i++) {
      entries.push(primCache.propertyTextureEntries[i]);
    }
  }

  // 44-45: DP-H46d — property-table block (texture + sampler). Emitted only when
  // the variant includes MODEL_HAS_PROPERTY_TABLES so non-property-table models
  // keep the minimal entry list matching their materialBGL.
  if (
    (materialDefines & ShaderDefine.MODEL_HAS_PROPERTY_TABLES) !== 0 &&
    defined(primCache.propertyTableEntries)
  ) {
    for (let i = 0; i < primCache.propertyTableEntries.length; i++) {
      entries.push(primCache.propertyTableEntries[i]);
    }
  }

  // 50+: PARITY-CUSTOM-SHADER-WGSL — customShader UBO + custom texture pairs.
  // Emitted only when the variant includes MODEL_HAS_WGSL_CUSTOM_SHADER so
  // non-customShader models keep the minimal entry list matching their
  // materialBGL. `customShaderEntries` is built per-frame by
  // `getCustomShaderEntries` (references the live UBO + resolved texture views).
  if (
    (materialDefines & ShaderDefine.MODEL_HAS_WGSL_CUSTOM_SHADER) !== 0 &&
    defined(customShaderEntries)
  ) {
    for (let i = 0; i < customShaderEntries.length; i++) {
      entries.push(customShaderEntries[i]);
    }
  }

  return entries;
}

/**
 * NEW-BG-CONSOLIDATION (Batch 122) — builds the merged group 1 bind
 * group. Per-frame allocation; cheap because the entry objects are
 * small and the underlying GPU resources are reused.
 *
 * Batch 174 (B.4 KHR materialBGL split) — the layout is now per-variant.
 * Caller passes the primitive's `materialDefines` mask; this function
 * fetches (or builds, on first use) the matching `GPUBindGroupLayout`
 * via `pipelineCache.getOrCreateMaterialBGL(materialDefines)`. The
 * `textureEntries` array MUST already be filtered to match the layout
 * — `getModelTextureEntries` honors the same mask.
 *
 * @private
 */
function buildMergedMaterialBindGroup(
  device: GPUDevice,
  pipelineCache: PipelineCacheLike,
  materialBuffer: WebGPUBuffer | null,
  lightBuffer: WebGPUBuffer | null,
  textureEntries: GPUBindGroupEntry[] | null | undefined,
  featureIdEntries: GPUBindGroupEntry[] | null | undefined,
  iblEntries: GPUBindGroupEntry[] | null | undefined,
  materialDefines: number,
  frameState: CesiumFrameState,
) {
  return device.createBindGroup({
    // C9-17 Slice A — label group 1 so the settled-frame bind-group probe
    // (and the API-instrumentation lane) can attribute merged-material creates
    // by label, exactly like the Batch-665 group-2 instance cache.
    label: "Model merged material bind group",
    layout: pipelineCache.getOrCreateMaterialBGL(materialDefines | 0),
    entries: [
      { binding: 0, resource: { buffer: materialBuffer.buffer } },
      { binding: 1, resource: { buffer: lightBuffer.buffer } },
      ...textureEntries,
      ...(featureIdEntries ?? pipelineCache.defaultFeatureIdEntries()),
      ...(iblEntries ?? defaultIBLEntries(pipelineCache, frameState)),
    ],
  });
}

/**
 * Audit A.9 (Batch 130) -- placeholder IBL bind-group entries (33-36).
 * Used when a model has no `imageBasedLighting` configured or its
 * source environment cubemap hasn't generated yet. The defaults
 * produce mid-grey ambient sampling so the FS doesn't have to gate
 * the cubemap sample on an explicit "iblEnabled" flag.
 * @private
 */
function defaultIBLEntries(
  pipelineCache: PipelineCacheLike,
  frameState: CesiumFrameState,
): GPUBindGroupEntry[] {
  return [
    { binding: 33, resource: pipelineCache.defaultIBLCubemapView },
    { binding: 34, resource: pipelineCache.defaultIBLCubemapView },
    { binding: 35, resource: pipelineCache.defaultIBLSampler },
    { binding: 36, resource: { buffer: pipelineCache.defaultSHBuffer } },
    ...brdfLutEntries(pipelineCache, frameState),
  ];
}

/**
 * NEW-MODEL-IBL-BRDF-LUT (Batch 287) — bindings 37/38 (split-sum
 * environment BRDF integration LUT + non-filtering sampler). The LUT is
 * device-global (generated once by `BrdfLutGenerator`); the WebGPU
 * generator stores its view + sampler on `_colorTexture` (see
 * WebGPUBrdfLutGenerator.update). Falls back to the pipeline cache's 1×1
 * (scale=1, bias=0) placeholder until the real table is generated, which
 * collapses the split-sum term to `radiance * F0`.
 * @private
 */
function brdfLutEntries(
  pipelineCache: PipelineCacheLike,
  frameState: CesiumFrameState,
): GPUBindGroupEntry[] {
  const lutTex = (
    frameState?.brdfLutGenerator as
      | { _colorTexture?: { _webgpuTextureView?: GPUTextureView | null } }
      | undefined
  )?._colorTexture;
  const lutView = lutTex?._webgpuTextureView;
  return [
    {
      binding: 37,
      resource: defined(lutView) ? lutView : pipelineCache.defaultBrdfLutView,
    },
    { binding: 38, resource: pipelineCache.defaultBrdfLutSampler },
  ];
}

/**
 * C9-17 Slice A — resolved per-model IBL identities. These five identities
 * fully determine the group-1 IBL bind-group entries (bindings 33-38). A stable
 * identity tuple lets {@link getOrCreateModelIBLEntries} hand back a
 * byte-identical entries array whose OBJECT IDENTITY is stable across settled
 * frames, which in turn lets the merged-material bind-group cache key on a
 * single array reference (invariant 2).
 * @private
 */
interface ResolvedModelIBL {
  diffuseView: GPUTextureView;
  specularView: GPUTextureView;
  sampler: GPUSampler;
  shBuffer: GPUBuffer;
  brdfLutView: GPUTextureView;
}

/**
 * Audit A.9 (Batch 130) -- resolves the per-model IBL identities from the
 * model's `imageBasedLighting` cache + environment-map manager, falling back to
 * the pipeline cache's neutral placeholders when the prefilter hasn't run yet.
 * `WebGPUImageBasedLighting.update` populates `_webgpuSpecularView`,
 * `_webgpuDiffuseView`, `_webgpuSampler`, `_webgpuSHBuffer` on the model's IBL
 * instance once the radiance + irradiance prefilter has generated mips.
 *
 * C9-17 Slice A refactor: this was `buildModelIBLEntries` (which allocated a
 * fresh array every frame and returned null on the placeholder path). It now
 * returns the resolved IDENTITIES so the memoizing wrapper can compare them and
 * keep the entries-array identity stable. The neutral-placeholder path returns
 * the same bindings `defaultIBLEntries` produces (bindings 33/34 both point at
 * `defaultIBLCubemapView`), so the built entries are byte-identical to before.
 * @private
 */
function resolveModelIBL(
  model: ModelLike,
  pipelineCache: PipelineCacheLike,
  frameState: CesiumFrameState,
): ResolvedModelIBL {
  // NEW-MODEL-IBL-BRDF-LUT (Batch 287) — binding 37 split-sum environment BRDF
  // LUT; flips ONCE from the 1x1 placeholder to the generated table (trap #3).
  const lutTex = (
    frameState?.brdfLutGenerator as
      | { _colorTexture?: { _webgpuTextureView?: GPUTextureView | null } }
      | undefined
  )?._colorTexture;
  const lutView = lutTex?._webgpuTextureView;
  const brdfLutView = defined(lutView)
    ? lutView
    : pipelineCache.defaultBrdfLutView;

  const ibl = model?._imageBasedLighting;
  let specularView = ibl?._webgpuSpecularView;
  let diffuseView = ibl?._webgpuDiffuseView;
  let sampler = ibl?._webgpuSampler;
  let shBuffer = ibl?._webgpuSHBuffer;

  // NEW-MODEL-PBR-DIRECT-LIGHT-IBL-PARITY D1 (Batch 346) -- precedence
  // fix mirroring WebGL's ImageBasedLightingPipelineStage:
  //   specular = explicit specularEnvironmentMaps if configured,
  //              else environmentMapManager.radianceCubeMap,
  //              else the (black) default.
  //   diffuse  = explicit SH if the user supplied coefficients,
  //              else environmentMapManager irradiance / SH,
  //              else the (low-gray) default.
  //
  // Previously the env-manager was used ONLY when the explicit
  // `_webgpuSpecularView` / `_webgpuDiffuseView` were *undefined*. But
  // `WebGPUImageBasedLighting.update` always resolves those to its 1x1
  // BLACK specular + 30/255 GRAY diffuse PLACEHOLDERS when no explicit
  // `specularEnvironmentMaps` is configured -- so the env-manager's real
  // atmosphere-derived IBL was being shadowed by the placeholder. That
  // left at-rest models with a flat gray ambient + no sky reflection,
  // the dominant cause of the WebGPU-vs-WebGL ~7.6% luminance / ~9%
  // blue-tint gap. We now treat the placeholder as "no explicit source"
  // and prefer the env-manager exactly like WebGL.
  const hasExplicitSpecular =
    defined(ibl?._specularEnvironmentCubeMap) &&
    (ibl._webgpuMaxMipLevel ?? 0) > 0;
  const hasExplicitDiffuse = ibl?._webgpuHasSH === true;

  const envManager = model?.environmentMapManager;
  if (defined(envManager)) {
    if (!hasExplicitDiffuse && defined(envManager._webgpuIBLDiffuseView)) {
      diffuseView = envManager._webgpuIBLDiffuseView;
      // NEW-WEBGPU-KHR-SPECULAR-IBL-OVERBRIGHT (Batch 354) -- prefer the
      // env-manager's atmosphere-derived SH-L2 coefficients, matching
      // WebGL's czm_sphericalHarmonics diffuse-IBL path. The SH buffer's
      // own `control.w` gate makes the shader evaluate SH instead of
      // sampling the irradiance cubemap (which over-brightened the diffuse
      // by ~20-30%, worst in blue). The irradiance cubemap above stays
      // bound as the fallback for frames before the SH projection has run.
      if (defined(envManager._webgpuSHBuffer)) {
        shBuffer = envManager._webgpuSHBuffer;
      } else {
        // No SH yet -- clear any default SH so the shader samples the
        // irradiance cubemap (control.w stays 0 with the default buffer).
        shBuffer = undefined;
      }
    }
    if (!hasExplicitSpecular && defined(envManager._webgpuIBLSpecularView)) {
      specularView = envManager._webgpuIBLSpecularView;
    }
    if (defined(envManager._webgpuIBLSampler)) {
      sampler = envManager._webgpuIBLSampler;
    }
  }

  if (!defined(specularView) || !defined(diffuseView) || !defined(sampler)) {
    // Neutral placeholder path — mid-grey ambient sampling so the FS doesn't
    // have to gate the cubemap sample on an explicit "iblEnabled" flag. Mirrors
    // `defaultIBLEntries` (bindings 33 AND 34 → defaultIBLCubemapView).
    return {
      diffuseView: pipelineCache.defaultIBLCubemapView,
      specularView: pipelineCache.defaultIBLCubemapView,
      sampler: pipelineCache.defaultIBLSampler,
      shBuffer: pipelineCache.defaultSHBuffer,
      brdfLutView,
    };
  }
  // SH falls back to the cache's default (zeros + inactive flag) when
  // neither the explicit IBL nor the env manager publishes one. The
  // shader gates on `sh.control.w` so the default just makes the
  // diffuse path use the irradiance cubemap (which is what we want
  // when the env manager is the source).
  const shResolved = defined(shBuffer)
    ? shBuffer
    : pipelineCache.defaultSHBuffer;
  return {
    diffuseView,
    specularView,
    sampler,
    shBuffer: shResolved,
    brdfLutView,
  };
}

/**
 * Builds the group-1 IBL bind-group entries (bindings 33-38) from resolved
 * identities. Binding order + resources are byte-identical to the historical
 * `buildModelIBLEntries` / `defaultIBLEntries` + `brdfLutEntries` output.
 * @private
 */
function buildIBLEntriesFromResolved(
  resolved: ResolvedModelIBL,
  pipelineCache: PipelineCacheLike,
): GPUBindGroupEntry[] {
  return [
    { binding: 33, resource: resolved.diffuseView },
    { binding: 34, resource: resolved.specularView },
    { binding: 35, resource: resolved.sampler },
    { binding: 36, resource: { buffer: resolved.shBuffer } },
    { binding: 37, resource: resolved.brdfLutView },
    { binding: 38, resource: pipelineCache.defaultBrdfLutSampler },
  ];
}

/**
 * C9-17 Slice A — memoized per-model IBL entries. Resolves the five IBL
 * identities every frame (cheap object reads) but returns the SAME entries
 * array while they are unchanged, so the merged-material bind-group cache can
 * treat the array reference as a single revision token (invariant 2). Trap
 * #2/#3: without this memo the merged-material cache would miss every settled
 * frame on a fresh array and "work" while still creating just as many bind
 * groups; the memo also carries the brdf-LUT + env-manager view flips so a
 * placeholder→real upgrade rebuilds exactly once.
 * @private
 */
function getOrCreateModelIBLEntries(
  cache: ModelWebGPUCache,
  model: ModelLike,
  pipelineCache: PipelineCacheLike,
  frameState: CesiumFrameState,
): GPUBindGroupEntry[] {
  const resolved = resolveModelIBL(model, pipelineCache, frameState);
  const memo = cache._iblEntriesMemo;
  if (
    defined(memo) &&
    memo.diffuseView === resolved.diffuseView &&
    memo.specularView === resolved.specularView &&
    memo.sampler === resolved.sampler &&
    memo.shBuffer === resolved.shBuffer &&
    memo.brdfLutView === resolved.brdfLutView
  ) {
    return memo.entries;
  }
  const entries = buildIBLEntriesFromResolved(resolved, pipelineCache);
  cache._iblEntriesMemo = {
    diffuseView: resolved.diffuseView,
    specularView: resolved.specularView,
    sampler: resolved.sampler,
    shBuffer: resolved.shBuffer,
    brdfLutView: resolved.brdfLutView,
    entries,
  };
  return entries;
}

/**
 * NEW-BG-CONSOLIDATION (Batch 122) — builds the merged group 2 bind
 * group (7 entries: current joint/morph/instance data plus their previous-
 * frame counterparts). Falls through to default placeholder buffers
 * when a primitive has no skinning / no morph targets / no instancing
 * — the shader gates on FLAG_HAS_SKINNING / FLAG_HAS_MORPH_TARGETS /
 * FLAG_HAS_INSTANCING so placeholder contents are never sampled.
 *
 * @private
 */
function getOrCreateMergedInstanceBindGroup(
  primCache: Pick<PrimitiveRenderData, "_mergedInstanceBindGroupCache">,
  device: GPUDevice,
  pipelineCache: PipelineCacheLike,
  jointBuffer: GPUBufferOrNull,
  morphDeltaBuffer: GPUBufferOrNull,
  morphWeightBuffer: GPUBufferOrNull,
  instanceBuffer: GPUBufferOrNull,
  prevJointBuffer: GPUBufferOrNull,
  prevMorphWeightBuffer: GPUBufferOrNull,
  prevInstanceBuffer: GPUBufferOrNull,
) {
  const layout = pipelineCache.instanceBGL;
  const resolvedJointBuffer = jointBuffer ?? pipelineCache.defaultJointBuffer;
  const resolvedMorphDeltaBuffer =
    morphDeltaBuffer ?? pipelineCache.defaultMorphDeltaBuffer;
  const resolvedMorphWeightBuffer =
    morphWeightBuffer ?? pipelineCache.defaultMorphWeightBuffer;
  const resolvedInstanceBuffer =
    instanceBuffer ?? pipelineCache.defaultInstancingBuffer;
  const resolvedPrevJointBuffer =
    prevJointBuffer ?? jointBuffer ?? pipelineCache.defaultJointBuffer;
  const resolvedPrevMorphWeightBuffer =
    prevMorphWeightBuffer ??
    morphWeightBuffer ??
    pipelineCache.defaultMorphWeightBuffer;
  const resolvedPrevInstanceBuffer =
    prevInstanceBuffer ??
    instanceBuffer ??
    pipelineCache.defaultInstancingBuffer;

  // The pipeline cache already owns the all-placeholder tuple. Most static,
  // unskinned, non-morphed models can use it directly, avoiding even the first
  // primitive-local bind-group creation.
  if (
    resolvedJointBuffer === pipelineCache.defaultJointBuffer &&
    resolvedMorphDeltaBuffer === pipelineCache.defaultMorphDeltaBuffer &&
    resolvedMorphWeightBuffer === pipelineCache.defaultMorphWeightBuffer &&
    resolvedInstanceBuffer === pipelineCache.defaultInstancingBuffer &&
    resolvedPrevJointBuffer === pipelineCache.defaultJointBuffer &&
    resolvedPrevMorphWeightBuffer === pipelineCache.defaultMorphWeightBuffer &&
    resolvedPrevInstanceBuffer === pipelineCache.defaultInstancingBuffer
  ) {
    // Drop references to a formerly-custom tuple if skin/morph/instancing was
    // removed. GPUBindGroup has no destroy method; releasing this owner record
    // lets it and its old resource references be collected.
    primCache._mergedInstanceBindGroupCache = undefined;
    return pipelineCache.defaultInstanceBindGroup;
  }

  const cached = primCache._mergedInstanceBindGroupCache;
  if (
    defined(cached) &&
    cached.device === device &&
    cached.layout === layout &&
    cached.jointBuffer === resolvedJointBuffer &&
    cached.morphDeltaBuffer === resolvedMorphDeltaBuffer &&
    cached.morphWeightBuffer === resolvedMorphWeightBuffer &&
    cached.instanceBuffer === resolvedInstanceBuffer &&
    cached.prevJointBuffer === resolvedPrevJointBuffer &&
    cached.prevMorphWeightBuffer === resolvedPrevMorphWeightBuffer &&
    cached.prevInstanceBuffer === resolvedPrevInstanceBuffer
  ) {
    return cached.bindGroup;
  }

  // Bind groups are immutable, but the buffers they reference are not. Model
  // animation, morphing, and instancing update the contents of stable buffers,
  // so rebuilding this group every frame provides no freshness benefit. Exact
  // resource identity catches every real replacement/growth/device-recovery
  // event while keeping the settled-frame path allocation-free.
  const bindGroup = device.createBindGroup({
    label: "Model merged instance bind group",
    layout,
    entries: [
      {
        binding: 0,
        resource: { buffer: resolvedJointBuffer },
      },
      {
        binding: 1,
        resource: { buffer: resolvedMorphDeltaBuffer },
      },
      {
        binding: 2,
        resource: { buffer: resolvedMorphWeightBuffer },
      },
      {
        binding: 3,
        resource: { buffer: resolvedInstanceBuffer },
      },
      {
        // Audit A.5 (Batch 130) -- previous-frame joint matrices for
        // TAA velocity. Falls back to the identity buffer (same as
        // binding 0's default) so non-skinned primitives produce no
        // skinning velocity contribution. Skinned primitives that
        // haven't yet captured a previous frame fall back to the
        // CURRENT joint buffer so velocity is zero on the first frame
        // of an animation rather than wildly wrong from the identity.
        binding: 4,
        resource: { buffer: resolvedPrevJointBuffer },
      },
      {
        // NEW-TAA-MORPH-PREV (Batch 134) -- previous-frame morph
        // weights uniform. Falls back to the CURRENT weights when no
        // prev mirror exists yet (first morphed frame); zero-weights
        // default when no morph at all.
        binding: 5,
        resource: { buffer: resolvedPrevMorphWeightBuffer },
      },
      {
        // NEW-TAA-INSTANCE-PREV (Batch 134) -- previous-frame instance
        // transforms. Static GPU instancing (today's only case) aliases
        // the current buffer for zero velocity contribution. Animated
        // EXT_mesh_gpu_instancing assets would override.
        binding: 6,
        resource: { buffer: resolvedPrevInstanceBuffer },
      },
    ],
  });
  primCache._mergedInstanceBindGroupCache = {
    device,
    layout,
    jointBuffer: resolvedJointBuffer,
    morphDeltaBuffer: resolvedMorphDeltaBuffer,
    morphWeightBuffer: resolvedMorphWeightBuffer,
    instanceBuffer: resolvedInstanceBuffer,
    prevJointBuffer: resolvedPrevJointBuffer,
    prevMorphWeightBuffer: resolvedPrevMorphWeightBuffer,
    prevInstanceBuffer: resolvedPrevInstanceBuffer,
    bindGroup,
  };
  return bindGroup;
}

// C9-17 Slice A — the three merged-material variants share one builder but must
// NOT alias each other's cache: they differ only by material buffer
// (primary / silhouette / translucent — trap #1). Each variant gets its own
// per-primitive cache slot.
const MERGED_MATERIAL_SLOT_PRIMARY = 0;
const MERGED_MATERIAL_SLOT_SILHOUETTE = 1;
const MERGED_MATERIAL_SLOT_TRANSLUCENT = 2;

/**
 * C9-17 Slice A (FAR-309 / audit #21) — per-primitive merged group-1 (material +
 * light + textures + featureId + IBL) bind-group cache, mirroring the Batch-665
 * group-2 instance cache. Bind groups are immutable but the buffers/textures
 * they reference are updated in place every frame (material UBO writeBuffer, sun
 * direction, etc.), so rebuilding this group every frame provides no freshness
 * benefit. Exact resource identity catches every real replacement:
 *   - `layout`          — per-`materialDefines` variant BGL (Batch 174)
 *   - `materialBuffer`  — primary / silhouette / translucent UB (slot-keyed)
 *   - `lightBuffer`     — per-primitive light UB
 *   - `textureEntries`  — rebuilt only on deferred-placeholder upgrade /
 *                         refraction-view change, so its ARRAY IDENTITY is the
 *                         invalidation token (trap #4 — never clone it)
 *   - `featureIdEntries`— stable `primCache._featureIdEntries` array or null;
 *                         null (default entries spliced by the builder) is its
 *                         own cache state (trap #6)
 *   - `iblEntries`      — the memoized array from {@link getOrCreateModelIBLEntries}
 *                         (invariant 2), one reference summarising the five IBL
 *                         identities
 * Cache hit ⇒ zero `createBindGroup`; any identity change ⇒ exactly one rebuild.
 * @private
 */
function getOrCreateMergedMaterialBindGroup(
  primCache: PrimitiveRenderData,
  slot: number,
  device: GPUDevice,
  pipelineCache: PipelineCacheLike,
  materialBuffer: WebGPUBuffer | null,
  lightBuffer: WebGPUBuffer | null,
  textureEntries: GPUBindGroupEntry[] | null | undefined,
  featureIdEntries: GPUBindGroupEntry[] | null | undefined,
  iblEntries: GPUBindGroupEntry[] | null | undefined,
  materialDefines: number,
  frameState: CesiumFrameState,
): GPUBindGroup {
  const layout = pipelineCache.getOrCreateMaterialBGL(materialDefines | 0);
  let cached: MergedMaterialBindGroupCache | undefined;
  if (slot === MERGED_MATERIAL_SLOT_SILHOUETTE) {
    cached = primCache._mergedMaterialBindGroupCacheSilhouette;
  } else if (slot === MERGED_MATERIAL_SLOT_TRANSLUCENT) {
    cached = primCache._mergedMaterialBindGroupCacheTranslucent;
  } else {
    cached = primCache._mergedMaterialBindGroupCache;
  }

  if (
    defined(cached) &&
    cached.device === device &&
    cached.layout === layout &&
    cached.materialBuffer === materialBuffer &&
    cached.lightBuffer === lightBuffer &&
    cached.textureEntries === textureEntries &&
    cached.featureIdEntries === featureIdEntries &&
    cached.iblEntries === iblEntries
  ) {
    return cached.bindGroup;
  }

  const bindGroup = buildMergedMaterialBindGroup(
    device,
    pipelineCache,
    materialBuffer,
    lightBuffer,
    textureEntries,
    featureIdEntries,
    iblEntries,
    materialDefines,
    frameState,
  );
  const record: MergedMaterialBindGroupCache = {
    device,
    layout,
    materialBuffer,
    lightBuffer,
    textureEntries,
    featureIdEntries,
    iblEntries,
    bindGroup,
  };
  if (slot === MERGED_MATERIAL_SLOT_SILHOUETTE) {
    primCache._mergedMaterialBindGroupCacheSilhouette = record;
  } else if (slot === MERGED_MATERIAL_SLOT_TRANSLUCENT) {
    primCache._mergedMaterialBindGroupCacheTranslucent = record;
  } else {
    primCache._mergedMaterialBindGroupCache = record;
  }
  return bindGroup;
}

/**
 * Creates GPU textures for a material, falling back to defaults.
 * @private
 */
function createMaterialTextures(
  device: GPUDevice,
  pipelineCache: PipelineCacheLike,
  matInfo: MaterialInfo,
  enqueueMip?: EnqueueMipFn,
) {
  const created: GPUTexture[] = [];
  const defWhite = pipelineCache.defaultWhiteTexture;
  const defNormal = pipelineCache.defaultNormalTexture;
  const defBlack = pipelineCache.defaultBlackTexture;
  // Session 65 BUG-WEBGPU-MODEL-TEXTURE-PLACEHOLDER-STUCK fix.
  // Track which slots fell back to the default placeholder texture
  // because the matching reader hadn't resolved its image source yet.
  // The per-frame `refreshDeferredTextures` helper polls these slots
  // and swaps in the real GPUTexture as soon as the reader is ready.
  // Without this, models whose textures load AFTER the first
  // `ensurePrimitiveCache` call (Mars, Moon, Aerometrex SF
  // photogrammetry, BIM base color) render with white-fallback
  // bind groups for their entire lifetime.
  const placeholderSlots = new Set<string>();

  function tryCreate(
    slot: string,
    reader: ReaderOrNull,
    fallback: GPUTexture,
    colorSpace: string,
  ) {
    if (!defined(reader)) {
      return fallback;
    }
    const tex = createGPUTextureFromReader(
      device,
      reader,
      colorSpace,
      enqueueMip,
    );
    if (defined(tex)) {
      // Only push to `created` (which the primCache destroys later) if
      // this WebGPU texture was allocated *here* via copyExternalImageToTexture.
      // When the CesiumJS Texture is backed by a WebGLStubTexture, the GPU
      // texture is owned by that stub and reused by reference; pushing it to
      // `created` would cause a double-destroy. The stub-owned check uses
      // the same path createGPUTextureFromReader took for ownership detection.
      const stubWrapper = reader.texture && reader.texture._texture;
      const reusedFromStub =
        stubWrapper &&
        stubWrapper._webgpuTexture &&
        stubWrapper._webgpuTexture.texture === tex;
      if (!reusedFromStub) {
        created.push(tex);
      }
      return tex;
    }
    placeholderSlots.add(slot);
    return fallback;
  }

  // Slot color-space classification (per glTF spec):
  //   srgb: baseColor (and specGloss diffuse), emissive.
  //   linear: normal, metallic-roughness (and specGloss specular), occlusion.
  // Storing sRGB slots as `rgba8unorm-srgb` makes the GPU sampler auto-decode
  // gamma, which is both perceptually correct for linear filtering AND
  // removes the need for in-shader pow(2.2) approximation.
  //
  // C-R4-GLTF-KHR-TEXTURES (Batch 102) — KHR extension texture
  // color-space defaults per the relevant Khronos extension specs:
  //   srgb: specularColor (chromatic F0 tint), sheenColor.
  //   linear: clearcoat (intensity scalar), anisotropy (RG = direction
  //           encoded as f32 trig), iridescence (R = factor scalar),
  //           thickness (G = volume thickness scalar).
  return {
    baseColor: tryCreate(
      "baseColor",
      matInfo.baseColorTextureReader || matInfo.diffuseTextureReader,
      defWhite,
      "srgb",
    ),
    normal: tryCreate(
      "normal",
      matInfo.normalTextureReader,
      defNormal,
      "linear",
    ),
    metallicRoughness: tryCreate(
      "metallicRoughness",
      matInfo.metallicRoughnessTextureReader || matInfo.specGlossTextureReader,
      defWhite,
      "linear",
    ),
    emissive: tryCreate(
      "emissive",
      matInfo.emissiveTextureReader,
      defBlack,
      "srgb",
    ),
    occlusion: tryCreate(
      "occlusion",
      matInfo.occlusionTextureReader,
      defWhite,
      "linear",
    ),
    clearcoat: tryCreate(
      "clearcoat",
      matInfo.clearcoatTextureReader,
      defWhite,
      "linear",
    ),
    specularColor: tryCreate(
      "specularColor",
      matInfo.specularExtColorTextureReader,
      defWhite,
      "srgb",
    ),
    anisotropy: tryCreate(
      "anisotropy",
      matInfo.anisotropyTextureReader,
      defWhite,
      "linear",
    ),
    iridescence: tryCreate(
      "iridescence",
      matInfo.iridescenceTextureReader,
      defWhite,
      "linear",
    ),
    sheenColor: tryCreate(
      "sheenColor",
      matInfo.sheenColorTextureReader,
      defWhite,
      "srgb",
    ),
    thickness: tryCreate(
      "thickness",
      matInfo.thicknessTextureReader,
      defWhite,
      "linear",
    ),
    // C-R4-GLTF-KHR-TEXTURES (Batch 103) — KHR secondary maps. Each
    // is linear-encoded scalar/normal data per the relevant Khronos
    // extension specs (clearcoat normal uses the standard normal-map
    // default placeholder so the FS perturbNormal call passes through
    // identity when the asset omits the texture).
    clearcoatRoughness: tryCreate(
      "clearcoatRoughness",
      matInfo.clearcoatRoughnessTextureReader,
      defWhite,
      "linear",
    ),
    clearcoatNormal: tryCreate(
      "clearcoatNormal",
      matInfo.clearcoatNormalTextureReader,
      defNormal,
      "linear",
    ),
    sheenRoughness: tryCreate(
      "sheenRoughness",
      matInfo.sheenRoughnessTextureReader,
      defWhite,
      "linear",
    ),
    specularFactor: tryCreate(
      "specularFactor",
      matInfo.specularExtTextureReader,
      defWhite,
      "linear",
    ),
    iridescenceThickness: tryCreate(
      "iridescenceThickness",
      matInfo.iridescenceThicknessTextureReader,
      defWhite,
      "linear",
    ),
    // C-R4-GLTF-KHR-TRANSMISSION (Batch 105) — transmission texture
    // (R = factor scalar) + refraction scene-color sample source. The
    // refractionScene fallback is the white placeholder; the actual
    // refraction MRT populated by the SceneRenderer is bound through
    // a separate per-frame rebuild in update(). Here we just stamp the
    // placeholder so the bind group is always valid.
    transmission: tryCreate(
      "transmission",
      matInfo.transmissionTextureReader,
      defWhite,
      "linear",
    ),
    refractionScene: defWhite,
    created,
    placeholderSlots,
  };
}

// Mapping of slot name → which matInfo reader field + colorSpace.
// Used by `refreshDeferredModelTextures` to refresh slots that were
// initially fallback-textured because the reader hadn't loaded yet.
// Mirrors the schema in createMaterialTextures so the two stay in sync.
const TEXTURE_SLOT_SCHEMA = [
  {
    slot: "baseColor",
    readers: ["baseColorTextureReader", "diffuseTextureReader"],
    colorSpace: "srgb",
  },
  { slot: "normal", readers: ["normalTextureReader"], colorSpace: "linear" },
  {
    slot: "metallicRoughness",
    readers: ["metallicRoughnessTextureReader", "specGlossTextureReader"],
    colorSpace: "linear",
  },
  { slot: "emissive", readers: ["emissiveTextureReader"], colorSpace: "srgb" },
  {
    slot: "occlusion",
    readers: ["occlusionTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "clearcoat",
    readers: ["clearcoatTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "specularColor",
    readers: ["specularExtColorTextureReader"],
    colorSpace: "srgb",
  },
  {
    slot: "anisotropy",
    readers: ["anisotropyTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "iridescence",
    readers: ["iridescenceTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "sheenColor",
    readers: ["sheenColorTextureReader"],
    colorSpace: "srgb",
  },
  {
    slot: "thickness",
    readers: ["thicknessTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "clearcoatRoughness",
    readers: ["clearcoatRoughnessTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "clearcoatNormal",
    readers: ["clearcoatNormalTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "sheenRoughness",
    readers: ["sheenRoughnessTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "specularFactor",
    readers: ["specularExtTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "iridescenceThickness",
    readers: ["iridescenceThicknessTextureReader"],
    colorSpace: "linear",
  },
  {
    slot: "transmission",
    readers: ["transmissionTextureReader"],
    colorSpace: "linear",
  },
];

/**
 * Per-frame poll: for each slot that was filled with a fallback
 * placeholder when this primitive was first set up, check if the
 * matching glTF texture reader has now resolved its image source.
 * If so, upload the real GPU texture and update primCache.textureViews
 * + gpuTextures so the next bind group rebuild picks it up.
 *
 * Returns true if any slot was upgraded, signaling the caller to
 * rebuild `primCache.textureEntries` so the bind group references
 * the new view instead of the white placeholder.
 *
 * Session 65 fix for the "Mars/Moon render solid white" cluster:
 * before this, the bind group was built once with whatever textures
 * had loaded by the first frame, and never refreshed.
 *
 * @private
 */
function refreshDeferredModelTextures(
  device: GPUDevice,
  primCache: PrimitiveRenderData,
  matInfo: MaterialInfo,
  enqueueMip?: EnqueueMipFn,
) {
  const placeholders = primCache.placeholderSlots;
  if (!placeholders || placeholders.size === 0) {
    return false;
  }
  let changed = false;
  for (const schema of TEXTURE_SLOT_SCHEMA) {
    if (!placeholders.has(schema.slot)) {
      continue;
    }
    let reader = null;
    for (const r of schema.readers) {
      if (defined((matInfo as unknown as Record<string, ReaderOrNull>)[r])) {
        reader = (matInfo as unknown as Record<string, ReaderOrNull>)[r];
        break;
      }
    }
    if (!defined(reader)) {
      continue;
    }
    const tex = createGPUTextureFromReader(
      device,
      reader,
      schema.colorSpace,
      enqueueMip,
    );
    if (!defined(tex)) {
      continue;
    }
    // Only track in gpuTextures if we own the lifetime — see tryCreate
    // for the same stub-ownership check. Stub-owned GPUTextures are
    // shared with the CesiumJS Texture wrapper and would double-destroy.
    const stubWrapper = reader.texture && reader.texture._texture;
    const reusedFromStub =
      stubWrapper &&
      stubWrapper._webgpuTexture &&
      stubWrapper._webgpuTexture.texture === tex;
    if (!reusedFromStub) {
      primCache.gpuTextures.push(tex);
    }
    primCache.textureViews[schema.slot] = tex.createView();
    placeholders.delete(schema.slot);
    changed = true;
  }
  return changed;
}

// ─── Main Entry Points ───────────────────────────────────────────────────────

/**
 * Updates or creates WebGPU draw commands for a Model.
 * Called from Model.submitDrawCommands() via the feature renderer.
 * Commands are pushed to frameState.commandList.
 *
 * Iterates sceneGraph._runtimeNodes → runtimeNode.runtimePrimitives
 * to access each node's skinning data alongside its primitives.
 *
 * @param {Model} model - The Model instance
 * @param {FrameState} frameState
 */
function updateWebGPUModel(model: ModelLike, frameState: CesiumFrameState) {
  if (!model.show || !model.ready) {
    return;
  }

  // AUDIT_2026_05_02 A.7 — surface silent feature gaps that the WebGPU
  // model path doesn't yet honor. Each warning fires once per process to
  // alert users instead of letting the feature appear "working" when it
  // silently no-ops.
  //>>includeStart('debug', pragmas.debug);
  // PARITY-CUSTOM-SHADER-WGSL — a customShader with native WGSL text runs the
  // real native-WGSL path below; only a GLSL-only customShader (no
  // `wgslFragmentShaderText`) still warns + no-ops on WebGPU (transpile
  // deferred by design).
  if (
    defined(model.customShader) &&
    !defined(model.customShader.wgslFragmentShaderText) &&
    !defined(model.customShader.wgslVertexShaderText)
  ) {
    oneTimeWarning(
      "WebGPUModel.customShader",
      "Model.customShader with GLSL-only text is not supported on the WebGPU " +
        "backend (GLSL→WGSL transpile is deferred). Supply " +
        "wgslFragmentShaderText / wgslVertexShaderText for a native-WGSL " +
        "customShader. The GLSL is ignored; the model renders with the " +
        "standard PBR pipeline. Track PARITY-CUSTOM-SHADER-WGSL.",
    );
  }
  //>>includeEnd('debug');

  // PARITY-CUSTOM-SHADER-WGSL — compute (or refresh) the model-level native-WGSL
  // customShader resources: the generated WGSL chunk + class hash, the packed
  // uniforms UBO, and the resolved custom-texture bind-group entries. Stored on
  // the model cache below so every primitive of this model prepends the same
  // chunk and binds the same UBO/textures. Rebuilt when the customShader
  // reference changes; the UBO contents are refreshed every frame (cheap) so
  // `setUniform` updates take effect.
  //>>includeStart('debug', pragmas.debug);
  // AUDIT_2026_05_02 A.8 (Batch 142, NEW-MODEL-AS-CLASSIFIER — resolved):
  // model.classificationType now routes through
  // `pipelineCache.getClassificationPipeline` and emits at the matching
  // TERRAIN/3D-Tile classification pass. The depth-sample classifier
  // FS samples the same `globeDepthTex` (group 3 binding 15) the four
  // classifier renderers use, so model classifiers participate in the
  // shared depth-sample architecture without per-renderer plumbing.
  //>>includeEnd('debug');

  const commandList = frameState.commandList;
  const context = frameState.context as unknown as ModelRenderContext;
  const device = context.device;

  // C10-05 — frame-owned mip-generation sink for the fallback texture path
  // (createGPUTextureFromReader when a model texture is NOT stub-backed). The
  // stub path already generates its own chain at upload; this only covers the
  // secondary branch. Undefined if the context predates C9-12A, in which case
  // the fallback keeps its historical single-level behavior.
  const enqueueMip: EnqueueMipFn | undefined =
    typeof context.enqueueImageryMipGeneration === "function"
      ? context.enqueueImageryMipGeneration.bind(context)
      : undefined;

  // Initialize model cache
  if (!defined(model._webgpuCache)) {
    model._webgpuCache = {
      pipelineCache: null,
      cameraBuffer: null,
      cameraData: null,
      cameraBG: null,
      primitives: {}, // keyed by "nodeIdx_primIdx"
      geometryViews: {}, // mutable annotation views, keyed like primitives
      nodes: {}, // per-node skinning data, keyed by nodeIdx
    };
  }
  const cache = model._webgpuCache;

  // Create pipeline cache (shared across all primitives of this model)
  if (!defined(cache.pipelineCache)) {
    const fmt = context.scenePipelineFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    cache.pipelineCache = new WebGPUModelPipelineCache(
      device,
      fmt,
      depthFmt,
    ) as unknown as PipelineCacheLike;
  }
  const pipelineCache = cache.pipelineCache;

  // PARITY-CUSTOM-SHADER-WGSL — (re)build the model-level native-WGSL
  // customShader resources.
  ensureModelCustomShaderResources(device, model, cache, pipelineCache);

  // C2-25 ENV-SCENE-CAPTURE (Batch 447) — publish this model's camera-
  // independent draw records so the dynamic-environment-map capture pass can
  // replay it into the 6 cube faces next frame. GATED on the context flag
  // (`context.sceneCaptureReflections`); when OFF, nothing is published and
  // `_webgpuSceneCaptureModels` stays null → the capture pass's model replay is
  // a no-op (byte-identical to globe-only Batch 446). The publish object is
  // RESET once per frame (frameNumber guard) and APPENDED to for every model
  // the FR processes this frame; `buildCaptureCommands` is a stable function
  // ref so the capture pass can build per-face descriptors without a static
  // import of this renderer (avoids a circular import).
  const wantCapturePublish = context.sceneCaptureReflections === true;
  let captureRecords: CaptureRecord[] | null = null;
  if (wantCapturePublish) {
    const frameNumber = frameState.frameNumber ?? 0;
    let pub = context._webgpuSceneCaptureModels;
    if (!pub || pub.frameNumber !== frameNumber) {
      pub = {
        frameNumber,
        models: [],
        buildCaptureCommands: getOrCreateModelCaptureCommands,
      };
      context._webgpuSceneCaptureModels = pub;
    }
    captureRecords = [];
    pub.models.push({
      model,
      pipelineCache,
      records: captureRecords,
    });
  }

  // Batch 110 — drop per-primitive pipeline refs when the scene
  // pipeline format generation bumps (HDR toggle, MSAA toggle). The
  // pipelineCache wipes its own cache via maybeUpdateForSceneFormat;
  // the per-primitive cache holds direct references that still point
  // at the OLD pipeline objects, so we re-fetch them from the now-
  // empty pipelineCache below per primitive (in the per-frame loop
  // each primitive sees `pc.pipeline = pipelineCache.getPipeline(...)`
  // re-fired). Lazy-allocated variants (pick/velocity/translucent/
  // depth-write) drop to undefined and are re-fetched on next use.
  const previousGen = pipelineCache._sceneFormatGeneration;
  pipelineCache.maybeUpdateForSceneFormat(context);
  // Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH) — mirror the master
  // switch into the pipeline cache; a flip wipes pipelines so modules
  // recompile with/without the LOG_DEPTH define.
  const logDepthFlipped = pipelineCache.maybeUpdateForLogDepth(
    isWebGPULogDepthActive(
      context as unknown as Parameters<typeof isWebGPULogDepthActive>[0],
      frameState,
    ),
  );
  // WIRE-MODEL-SPLITTER — mirror model.splitDirection into the per-model
  // pipeline cache; a flip wipes pipelines so modules recompile
  // with/without MODEL_SPLIT_ENABLED (WebGL ModelSplitterPipelineStage
  // parity). splitDirection: -1 LEFT / 0 NONE / +1 RIGHT.
  const modelSplitDirection =
    typeof model.splitDirection === "number" ? model.splitDirection : 0.0;
  const splitFlipped = pipelineCache.maybeUpdateForSplit(
    modelSplitDirection !== 0.0,
  );
  // The split cutoff in framebuffer pixels — WebGL keeps this in pixel
  // space as `czm_splitPosition` (`frameState.splitPosition *
  // drawingBufferWidth`), and WGSL fragCoord.x is framebuffer pixels too.
  const modelSplitPositionPx =
    (typeof frameState?.splitPosition === "number"
      ? frameState.splitPosition
      : 0.0) * (context?.drawingBufferWidth ?? 0.0);
  // WIRE-MODEL-COLOR — mirror `defined(model.color)` into the per-model
  // pipeline cache; a flip wipes pipelines so modules recompile
  // with/without MODEL_HAS_COLOR (WebGL ModelColorPipelineStage parity).
  // The blend scalar matches WebGL's `ColorBlendMode.getColorBlend`:
  // 0 = HIGHLIGHT, 1 = REPLACE, (0,1] = MIX amount (0 reserved for
  // HIGHLIGHT, so MIX clamps to EPSILON4).
  const modelColor = model.color;
  const modelHasColor = defined(modelColor);
  const modelColorFlipped =
    pipelineCache.maybeUpdateForModelColor(modelHasColor);
  const modelColorBlend = modelHasColor
    ? ((
        ColorBlendMode as unknown as {
          getColorBlend(mode: unknown, amount: number): number;
        }
      ).getColorBlend(model.colorBlendMode, model.colorBlendAmount) ?? 0.0)
    : 0.0;
  // WIRE-MODEL-SILHOUETTE — mirror WebGL's `Model.hasSilhouette()`
  // predicate (silhouetteSize > 0 && silhouetteColor.alpha > 0 &&
  // !classificationType && stencil support) into the per-model pipeline
  // cache; a flip wipes pipelines so modules recompile with/without
  // MODEL_SILHOUETTE. The scene depth format is `depth24plus-stencil8`
  // by construction, but guard anyway so a future depth-only format
  // can't request stencil-state pipelines.
  const silhouetteSupported =
    `${context.depthFormat ?? "depth24plus-stencil8"}`.includes("stencil");
  const modelHasSilhouette =
    silhouetteSupported &&
    typeof model.silhouetteSize === "number" &&
    model.silhouetteSize > 0.0 &&
    (model.silhouetteColor?.alpha ?? 0.0) > 0.0 &&
    !defined(model.classificationType);
  const silhouetteFlipped =
    pipelineCache.maybeUpdateForSilhouette(modelHasSilhouette);
  // Per-frame silhouette scalars (WebGL ModelSilhouetteStageVS.glsl math,
  // pre-folded on the CPU because the WGSL camera UB carries no
  // standalone projection/viewport):
  //   expandX/Y = proj[0][0] / proj[1][1] · silhouetteSize · pixelRatio
  //               / drawingBufferWidth   (czm_viewport.z ≡ buffer width)
  // Uses `context.drawingBufferWidth` directly — NOT
  // `uniformState.viewportCartesian4`, which is zero-initialized at
  // FR-update time (same pitfall the edge-overlay wiring hit).
  let silhouetteStencilRef = 0;
  let silhouetteExpandX = 0.0;
  let silhouetteExpandY = 0.0;
  let silhouetteTranslucent = false;
  if (modelHasSilhouette) {
    if (!defined(model._silhouetteId)) {
      model._silhouetteId = ++(
        ModelSilhouettePipelineStage as unknown as { silhouettesLength: number }
      ).silhouettesLength;
    }
    // Wrap around after the 8-bit stencil limit (WebGL
    // `deriveSilhouetteModelCommand` parity).
    silhouetteStencilRef = model._silhouetteId % 255;
    const silhouetteProj = context.uniformState?.projection;
    const proj00 = defined(silhouetteProj) ? silhouetteProj[0] : 1.0;
    const proj11 = defined(silhouetteProj) ? silhouetteProj[5] : 1.0;
    const silhouettePixelRatio =
      typeof frameState.pixelRatio === "number" ? frameState.pixelRatio : 1.0;
    const silhouetteScale =
      (model.silhouetteSize * silhouettePixelRatio) /
      (context.drawingBufferWidth || 1);
    silhouetteExpandX = proj00 * silhouetteScale;
    silhouetteExpandY = proj11 * silhouetteScale;
    silhouetteTranslucent = model.silhouetteColor.alpha < 1.0;
  }
  // Derived silhouette-colour commands are collected per model and
  // pushed AFTER every base command of this model (WebGL
  // `ModelSceneGraph.pushDrawCommands` ordering — the rim must not draw
  // on top of the model's own later primitives).
  const silhouetteColorCommands = [];
  // A log-depth flip needs the SAME per-primitive direct-reference drop as
  // a scene-format change (pc.pipeline & friends point at wiped pipelines).
  const sceneFormatChanged =
    previousGen !== pipelineCache._sceneFormatGeneration ||
    logDepthFlipped ||
    splitFlipped ||
    modelColorFlipped ||
    silhouetteFlipped;
  if (sceneFormatChanged) {
    const primKeys = Object.keys(cache.primitives);
    for (let i = 0; i < primKeys.length; i++) {
      const pc = cache.primitives[primKeys[i]];
      if (defined(pc)) {
        pc.pipeline = null;
        pc.pickPipeline = undefined;
        pc.depthWritePipeline = undefined;
        pc.velocityPipeline = undefined;
        pc.translucentPipeline = undefined;
        // WIRE-MODEL-SILHOUETTE — direct refs into the wiped maps.
        pc.silhouettePipeline = undefined;
        pc.silhouetteColorPipeline = undefined;
        // Tag for the per-frame loop so it re-fetches pc.pipeline
        // before the command emission below (the initial pipeline
        // assignment lives inside ensurePrimitiveCache which only
        // runs once per primitive lifecycle).
        pc._pipelineNeedsRefetch = true;
      }
    }
  }

  // Camera uniform buffer (updated per frame)
  if (!defined(cache.cameraBuffer)) {
    cache.cameraBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      CAMERA_UNIFORM_SIZE,
      "Model camera",
    );
    cache.cameraData = new Float32Array(CAMERA_UNIFORM_SIZE / 4);
    cache.cameraBG = device.createBindGroup({
      layout: pipelineCache.cameraBGL,
      entries: [
        { binding: 0, resource: { buffer: cache.cameraBuffer.buffer } },
      ],
    });
  }

  // Use the scene graph's _computedModelMatrix which folds in:
  //   model.modelMatrix * components.transform * _axisCorrectionMatrix
  //     * scale(model.computedScale)
  // Falling back to model.modelMatrix omits glTF root transform, axis
  // correction (Z-up → Y-up), and the user-supplied scale — which made
  // models render at the wrong scale (typically 1× instead of computedScale,
  // e.g. CesiumAir.glb collapsing to a few pixels at scale=4) and with the
  // wrong axis orientation. The same field is what the upstream WebGL
  // ModelDrawCommand uses (see ModelSceneGraph.js:823).
  // MODEL-SCENE-MODES — in SCENE2D / COLUMBUS_VIEW / MORPHING use the
  // scene graph's projected-frame matrix instead. WebGL's
  // ModelMatrixUpdateStage (ModelMatrixUpdateStage.js:31-39) swaps to
  // `_computedModelMatrix2D` (Transforms.basisTo2D over the 3D matrix,
  // computed by ModelSceneGraph.updateModelMatrix whenever the mode or
  // model matrix changes — Model.js updateSceneMode sets
  // `_updateModelMatrix = true` on every mode flip, so it is never stale
  // here). All downstream consumers (packCameraUniforms RTE encode,
  // per-node matrices, shadow-cast UB, edge-emitter MVP, TAA prev-matrix)
  // derive from this one local, so the substitution is complete.
  // `uniformState.view/projection/cameraPosition` are already in the same
  // projected frame in these modes, keeping the RTE chain consistent.
  // NEW-MODEL-PROJECT2D-BV-MORPH (B11) — `projectTo2D:true` accurate-2D path.
  // When the model opts into accurate 2D projection, WebGL bakes a per-vertex
  // ellipsoid→projected reprojection into a dedicated position buffer and
  // morphs the 3D bounding volume into a flat 2D box (SceneMode2DPipelineStage);
  // critically, with `projectTo2D` set the scene graph does NOT compute
  // `_computedModelMatrix2D` at all (Model.js:2471 resets draw commands on a
  // mode flip instead of arming `_updateModelMatrix`), so the affine 2D path
  // below has no matrix to use and the model would fall back to its ECEF 3D
  // matrix under a 2D/CV camera — culled to nothing. Instead we reproject each
  // primitive's positions on the CPU (relative to a single model-level
  // reference point) and drive the camera UB with a pure translate(reference)
  // matrix; the existing model-space RTE chain then resolves clip space
  // correctly (`rte = projAbs - eyeProj`). Per-primitive reference frames +
  // the IDL-crossing duplicate command are the B12 follow-up.
  const projectTo2DActive =
    model._projectTo2D === true &&
    frameState.mode !== SceneMode.SCENE3D &&
    defined(model._sceneGraph?._computedModelMatrix);

  let modelMatrix;
  let commandBoundingVolume;
  // C-MODEL-2DIDL-DUPLICATE — armed only for a non-projectTo2D model that
  // crosses the antimeridian in SCENE2D (mirror of WebGL
  // `shouldUse2DCommands`). When set, the emission loop pushes a second,
  // y-shifted copy of each surface command so the half of the model clipped
  // by one viewport is drawn wrapped into the other. Default-off: every other
  // mode/position leaves this false and emits an unchanged command stream.
  let idlDuplicateActive = false;
  let idlShiftAmount2D = 0;
  if (projectTo2DActive) {
    // Reference = accurate CV projection of the model's ECEF world origin.
    // CV-forced (inside computeReference2DPosition) so it keeps its height and
    // stays valid for both SCENE2D and COLUMBUS_VIEW. The per-vertex buffers
    // built in the emission loop subtract this same point.
    const worldOrigin = Matrix4.getTranslation(
      model._sceneGraph._computedModelMatrix,
      scratchProject2DWorldOrigin,
    );
    if (!defined(cache._project2DReference)) {
      cache._project2DReference = new Cartesian3();
      cache._project2DMatrix = new Matrix4();
    }
    const reference = computeReference2DPosition(
      frameState,
      worldOrigin,
      cache._project2DReference,
    );
    modelMatrix = Matrix4.fromTranslation(reference, cache._project2DMatrix);
    // Invalidate cached per-primitive 2D buffers if the reference shifted
    // materially (e.g. the model matrix changed while in 3D, then 2D re-entry)
    // — projectTo2D locks the matrix in 2D/CV so this is normally stable.
    const refKey = `${reference.x.toFixed(3)}_${reference.y.toFixed(3)}_${reference.z.toFixed(3)}`;
    cache._project2DActive = true;
    cache._project2DRefKey = refKey;
    commandBoundingVolume =
      computeModel2DBoundingVolume(model, cache) ?? model.boundingSphere;
  } else {
    cache._project2DActive = false;
    const use2DMatrix =
      frameState.mode !== SceneMode.SCENE3D &&
      defined(model._sceneGraph?._computedModelMatrix2D);
    modelMatrix = use2DMatrix
      ? model._sceneGraph._computedModelMatrix2D
      : model._sceneGraph?._computedModelMatrix ||
        model.modelMatrix ||
        Matrix4.IDENTITY;
    // Command bounding volume must live in the same frame as the camera —
    // Scene's createPotentiallyVisibleSet culls/bins by it, so an ECEF
    // sphere under a 2D/CV culling volume would cull the model outright.
    // WebGL's ModelDrawCommand carries a per-primitive 2D-transformed BV;
    // the model-level `_boundingSphere2D` (computed alongside
    // `_computedModelMatrix2D`) is the conservative equivalent.
    commandBoundingVolume =
      use2DMatrix && defined(model._sceneGraph._boundingSphere2D)
        ? model._sceneGraph._boundingSphere2D
        : model.boundingSphere;

    // C-MODEL-2DIDL-DUPLICATE — decide whether the model straddles the IDL in
    // SCENE2D. Byte-for-byte port of WebGL `shouldUse2DCommands`
    // (ModelDrawCommand.js): SCENE2D only, never for `projectTo2D` models,
    // tested against the scene graph's model-level `_boundingSphere2D` (the
    // per-command sphere is too tight to detect the crossing). `2πR` is the
    // wrap distance the duplicate is shifted by (`updateModelMatrix2D`).
    if (
      frameState.mode === SceneMode.SCENE2D &&
      use2DMatrix &&
      defined(model._sceneGraph._boundingSphere2D) &&
      defined(frameState.mapProjection)
    ) {
      const bs2D = model._sceneGraph._boundingSphere2D;
      const left = bs2D.center.y - bs2D.radius;
      const right = bs2D.center.y + bs2D.radius;
      const idl2D =
        (frameState.mapProjection as { ellipsoid: { maximumRadius: number } })
          .ellipsoid.maximumRadius * Math.PI;
      if (
        (left < idl2D && right > idl2D) ||
        (left < -idl2D && right > -idl2D)
      ) {
        idlDuplicateActive = true;
        idlShiftAmount2D =
          2.0 *
          Math.PI *
          (frameState.mapProjection as { ellipsoid: { maximumRadius: number } })
            .ellipsoid.maximumRadius;
      }
    }
  }
  packCameraUniforms(cache.cameraData, frameState, modelMatrix);
  if (projectTo2DActive) {
    // Restore the 3D-frame normal matrix so diffuse lighting keeps the model's
    // world orientation (the translate(reference) 2D matrix has none).
    overrideProject2DNormalMatrix(
      cache.cameraData,
      frameState,
      model._sceneGraph._computedModelMatrix,
    );
  }
  device.queue.writeBuffer(
    cache.cameraBuffer.buffer,
    0,
    cache.cameraData.buffer,
    0,
    CAMERA_UNIFORM_SIZE,
  );

  // ── Effects bind group (shadow receive + clipping + CSM) ──
  //
  // CSM Slice 2c — the model pipeline layout now includes the effects
  // BGL at @group(7). Rebuild the bind group each frame so the effects
  // UBO (shadow darkness, csmControl flag, clipping plane count,
  // atmosphere LUT control, etc.) reflects the current scene state.
  // Mirrors the pattern in WebGPUGlobeSurfaceRenderer ~line 1554.
  //
  // Scope note: called per-model per-frame. The UB write is 272 bytes
  // and the bind group is a thin metadata wrapper, so the cost is
  // linear in model count × 1 small write. If this becomes a hotspot
  // with many models, cache a scene-wide effects bind group on the
  // frame context and share across all models in the scene.
  const shadowState = frameState.shadowState;
  const receiveShadowMap =
    shadowState?.lightShadowsEnabled && shadowState?.lightShadowMaps?.[0]
      ? shadowState.lightShadowMaps[0]
      : undefined;
  const csmCandidate = (frameState.context as unknown as ModelRenderContext)
    ?.csmRenderer;
  const csmBinding =
    defined(csmCandidate) &&
    csmCandidate.enabled === true &&
    defined(csmCandidate.cascadeParamsBuffer) &&
    defined(csmCandidate.cascadeArrayView)
      ? {
          enabled: true,
          paramsBuffer: csmCandidate.cascadeParamsBuffer,
          cascadeArrayView: csmCandidate.cascadeArrayView,
          // NEW-CSM-SOFT-SHADOW-PCF — soft-shadow kernel radius (texels).
          pcfRadius: csmCandidate.pcfRadius,
        }
      : undefined;
  // C-R8-EDGE-INLINE — gather edge-detection inputs for the inline
  // stage in `ModelPBRComplete.wgsl`. The scene renderer publishes
  // resolved edge MRT views (CESIUM_3D_TILE_EDGES pass) AND the globe
  // packed-depth view (`executeCopyDepth`) on the context each frame.
  // Both need to be populated for the gate to flip — when either is
  // missing we fall through to the placeholder bind group and the
  // shader's `edgeControl.x <= 0.5` early-out keeps the stage benign.
  const ctx = frameState.context as unknown as ModelRenderContext;
  const edgeColorView = ctx?._edgeColorView ?? null;
  const edgeIdView = ctx?._edgeIdView ?? null;
  const edgeDepthView = ctx?._edgeDepthView ?? null;
  const globeDepthView = ctx?._globeDepthView ?? null;
  const uniformState = ctx?.uniformState;
  const currentFrustum = uniformState?.currentFrustum;
  // Viewport — source from context.drawingBufferWidth/Height directly.
  // `uniformState.viewportCartesian4` is zero-initialized at FR-update
  // time (FR runs during Scene primitive update, before per-frame
  // viewport is established). The bug-pattern hunt 2026-04-30 found
  // four other classification renderers reading zero viewports through
  // the same path; here Model uses it for edge-overlay readiness gating
  // — `!!viewportPx` reads truthy on a zero-init Cartesian4 (the object
  // exists), so edges shipped with zw=0 ⇒ NaN screenUV ⇒ broken edge
  // overlay. Match the canvas dimensions instead.
  const dbw = ctx?.drawingBufferWidth || 1;
  const dbh = ctx?.drawingBufferHeight || 1;
  const edgesReady =
    !!edgeColorView && !!edgeDepthView && !!globeDepthView && !!currentFrustum;
  // C-R8-EDGE-FEATURE-ID — the inline stage gates on the same flag the
  // emitter side toggles when feature IDs are populated. The flag
  // is set sticky-true in the per-primitive edge extraction below
  // when at least one primitive in this model emitted a non-zero
  // feature ID, so per-feature gating activates as soon as a model
  // with batch-table-tagged geometry reaches this code path. Models
  // without feature IDs leave the flag false and the inline stage
  // falls back to "always draw on match" (WebGL fail-open).
  const edgesPayload = edgesReady
    ? {
        ready: true,
        edgeColorView,
        edgeIdView,
        edgeDepthView,
        globeDepthView,
        near: currentFrustum.x,
        far: currentFrustum.y,
        viewportWidth: dbw,
        viewportHeight: dbh,
        hasFeatureId: cache.hasEdgeFeatureIds === true,
      }
    : undefined;

  // AUDIT_2026_05_02 A.6 — wire model.clippingPlanes / model.clippingPolygons
  // through to the effects bind group. The previous comment claimed
  // "Models don't carry their own clipping-plane set" but
  // `Model.js:369-388` shows both APIs are supported. Without this
  // wiring, `model.clippingPlanes = …` produced no visual change
  // (the scene-wide clipping never applied to models) and
  // `model.clippingPolygons = …` was a complete no-op. The model's
  // collections also need their per-frame `update(frameState)` to
  // run so `_webgpuCache` is populated; that already happens inside
  // `Model.update()` (lines 2774-2775 / 917-924).
  const modelClippingPlanes = model._clippingPlanes;
  const modelClippingPolygons = model._clippingPolygons;
  const fxRes = createEffectsBindGroup(device, frameState, {
    // Model identity is stable across frames; volatile camera/edge bytes must
    // update its bounded slot instead of becoming permanent cache keys.
    owner: model,
    shadowMap: receiveShadowMap,
    csm: csmBinding,
    clippingPlanes:
      modelClippingPlanes !== undefined &&
      modelClippingPlanes.enabled &&
      modelClippingPlanes.length !== 0
        ? modelClippingPlanes
        : undefined,
    clippingPolygons:
      modelClippingPolygons !== undefined &&
      modelClippingPolygons.enabled &&
      modelClippingPolygons.length !== 0
        ? modelClippingPolygons
        : undefined,
    cameraInPlaneSpace: frameState.context.uniformState.cameraPosition,
    edges: edgesPayload,
    // Slice 5d Batch 153 — Forward+ clustered lighting. SceneRenderer's
    // _dispatchClusteredLighting hook stashes the dispatcher's per-
    // frame buffers on context._clusteredLightingBuffers each frame.
    // When omitted (e.g., scene without WebGPUSceneRenderer hooked up),
    // the effects bind group falls back to per-device placeholders and
    // the FS chunk early-outs via activeLightCount=0.
    clusteredLighting: (frameState.context as unknown as ModelRenderContext)
      ._clusteredLightingBuffers,
  });
  cache.effectsBG = fxRes.bindGroup;

  // ── Shadow cast UB (shared across all primitives of this model) ──
  //
  // The WebGPUShadowMapRenderer's `modelP12` variant needs the model's
  // world-space transform to project vertices into light-space. Every
  // primitive in this model has the same modelMatrix, so we allocate
  // one UB per model and share it across all the command tags below.
  //
  // The UB is written unconditionally each frame — the shadow cast
  // pass is free to ignore it (if the model has castShadows=false)
  // and the cost of a single 64-byte writeBuffer is negligible.
  const castShadows = model.shadows !== undefined ? model.shadows >= 2 : true;
  if (castShadows) {
    if (!defined(cache.shadowCastUB)) {
      cache.shadowCastUB = WebGPUBuffer.createUniformBuffer(
        device,
        64, // mat4x4<f32>
        "Model shadow cast UB",
      );
      cache.shadowCastData = new Float32Array(16);
    }
    Matrix4.pack(modelMatrix, cache.shadowCastData, 0);
    device.queue.writeBuffer(
      cache.shadowCastUB.buffer,
      0,
      cache.shadowCastData.buffer,
      0,
      64,
    );
  }

  // Process model by iterating nodes → primitives
  // This is the correct traversal that gives us access to each node's
  // skinning data (computedJointMatrices) alongside its primitives.
  const sceneGraph = model._sceneGraph;
  if (!defined(sceneGraph) || !defined(sceneGraph._runtimeNodes)) {
    return;
  }

  const runtimeNodes = sceneGraph._runtimeNodes;

  for (let nodeIdx = 0; nodeIdx < runtimeNodes.length; nodeIdx++) {
    const runtimeNode = runtimeNodes[nodeIdx];
    if (!defined(runtimeNode)) {
      continue;
    }

    const prims = runtimeNode.runtimePrimitives;
    if (!defined(prims) || prims.length === 0) {
      continue;
    }

    // AUDIT_2026_05_02 B.8 (Batch 152, fixed Batch 154) — apply per-
    // runtime-node `computedTransform = transformToRoot × transform` to
    // the model matrix so multi-node hierarchies and AGI_articulations /
    // non-skinned animated rigs render at their correct world position.
    // Mirrors WebGL's `ModelMatrixUpdateStage.updateRuntimeNode` which
    // multiplies `runtimeNode.transform` into the inherited
    // `transformToRoot` BEFORE forwarding to `updateDrawCommand`; the
    // result it forwards is `transformToRoot × transform`, exactly what
    // `runtimeNode.computedTransform` returns (`ModelRuntimeNode.js:252-258`).
    //
    // Original Batch 152 used `runtimeNode.transformToRoot` directly,
    // which excludes the node's own transform — wrong for any rig with a
    // non-identity local transform (the entire point of articulations).
    //
    // Skinning compatibility: `runtimeNode.computedJointMatrices` (Batch 130
    // TAA velocity input) is built with `inverseNodeWorldTransform =
    // inverse(transformToRoot × transform)` baked in
    // (`ModelRuntimeNode.js:283-298`); the cancellation only works when
    // the per-primitive modelMatrix carries the matching
    // `(transformToRoot × transform) = computedTransform`, so this fix is
    // also a correctness fix for skinned rigs whose skin root has any
    // non-identity local OR ancestor transform.
    const computedTransform = runtimeNode.computedTransform;
    const computedTransformIsIdentity =
      !defined(computedTransform) || isIdentityMatrix4(computedTransform);
    // NEW-MODEL-PROJECT2D-BV-MORPH (B11) — in the accurate-2D path the node
    // transform is baked per-vertex into the reprojected 2D positions, so the
    // camera UB uses the model-level translate(reference) matrix directly and
    // the per-node transform is collapsed to identity here (the 3D node world
    // matrix that the reprojection consumes is captured separately below).
    const project2DActive = cache._project2DActive === true;
    const transformIsIdentity = project2DActive || computedTransformIsIdentity;
    const nodeModelMatrix = transformIsIdentity
      ? modelMatrix
      : Matrix4.multiplyTransformation(
          modelMatrix,
          computedTransform,
          scratchNodeModelMatrix,
        );
    // 3D node world matrix (model 3D world × node transform), independent of
    // the 2D camera matrix, used to reproject this node's positions into 2D.
    let project2DNodeWorld;
    if (project2DActive) {
      const world3D = model._sceneGraph._computedModelMatrix;
      project2DNodeWorld = computedTransformIsIdentity
        ? world3D
        : Matrix4.multiplyTransformation(
            world3D,
            computedTransform,
            scratchProject2DNodeWorld,
          );
    }

    // Extract skinning data for this node (shared, renderer-agnostic)
    const skinData = extractSkinData(runtimeNode);
    const hasSkinning = defined(skinData);

    // AUDIT_2026_05_02 B.8 (Batch 152, fixed Batch 154) — allocate the
    // per-node cache slot unconditionally for any node with non-identity
    // computedTransform, so the camera buffer + bind group below can be
    // lazily attached to it even when the node has neither skinning nor
    // instancing. Skinning / instancing branches further down extend the
    // same nodeCache shape.
    if (!transformIsIdentity && !defined(cache.nodes[nodeIdx])) {
      cache.nodes[nodeIdx] = {
        jointBuffer: null,
        jointBufferSize: 0,
        skinningBG: null,
        packedJointMatrices: null,
        prevJointBuffer: null,
        prevPackedJointMatrices: null,
        // Per-node camera resources (Batch 152, NEW-MODEL-NODE-TRANSFORMS).
        cameraBuffer: null,
        cameraData: null,
        cameraBG: null,
        // NEW-MODEL-NODE-TRANSFORMS-PREV (Batch 175) — per-node previous
        // frame's `nodeModelMatrix`. Pre-Batch-175 the velocity pack
        // pulled `cache.prevModelMatrix` (the model-level matrix), which
        // was correct for static articulations (set once, then locked)
        // but produced ghosting under TAA when articulation animations
        // mutate `runtimeNode.transform` per-frame. The per-node slot
        // is captured at the END of each node iteration so the next
        // frame's pack reads this frame's value as `prev`.
        prevNodeModelMatrix: null,
      };
    }

    // Per-node skinning: create/update joint matrices GPU buffer
    if (hasSkinning) {
      if (!defined(cache.nodes[nodeIdx])) {
        cache.nodes[nodeIdx] = {
          jointBuffer: null,
          jointBufferSize: 0,
          skinningBG: null,
          packedJointMatrices: null,
          // Audit A.5 (Batch 130) — prev-frame mirrors for TAA velocity.
          prevJointBuffer: null,
          prevPackedJointMatrices: null,
          // NEW-MODEL-NODE-TRANSFORMS-PREV (Batch 175). See above.
          prevNodeModelMatrix: null,
        };
      }
      const nodeCache = cache.nodes[nodeIdx];

      // First frame: full extraction. Subsequent: incremental update.
      if (!defined(nodeCache.packedJointMatrices)) {
        nodeCache.packedJointMatrices = skinData.packedJointMatrices;
        ensureJointMatricesBuffer(device, pipelineCache, nodeCache, skinData);
      } else {
        // Audit A.5 (Batch 130) — capture the about-to-be-overwritten
        // current matrices as "previous" BEFORE applying this frame's
        // pose. Reuses a persistent Float32Array to avoid per-frame
        // allocation. The first capture (no prevPackedJointMatrices
        // yet) lazily allocates a same-size buffer + GPU storage so
        // the velocity pass has a real `t-1` pose to skin against;
        // the FS would otherwise see prev == current and emit zero
        // velocity for the first animated frame.
        if (!defined(nodeCache.prevPackedJointMatrices)) {
          nodeCache.prevPackedJointMatrices = new Float32Array(
            nodeCache.packedJointMatrices.length,
          );
        }
        nodeCache.prevPackedJointMatrices.set(nodeCache.packedJointMatrices);
        ensurePrevJointMatricesBuffer(device, nodeCache);
        device.queue.writeBuffer(
          nodeCache.prevJointBuffer,
          0,
          nodeCache.prevPackedJointMatrices,
        );
        // Update packed matrices in-place (avoids allocation)
        updatePackedJointMatrices(runtimeNode, nodeCache.packedJointMatrices);
        device.queue.writeBuffer(
          nodeCache.jointBuffer,
          0,
          nodeCache.packedJointMatrices,
        );
      }
    }

    // NEW-BG-CONSOLIDATION (Batch 122) — track raw GPU buffers instead
    // of standalone bind groups. The merged group 2 bind group is built
    // per-frame at the draw command emission site.
    const nodeJointBuffer = hasSkinning
      ? cache.nodes[nodeIdx].jointBuffer
      : null;
    // Audit A.5 (Batch 130) — prev-frame joint matrices for TAA
    // velocity. Falls through to null on the first frame so the BG
    // builder can substitute the current buffer (zero skinning
    // velocity contribution, never identity which would explode).
    const nodePrevJointBuffer = hasSkinning
      ? cache.nodes[nodeIdx].prevJointBuffer
      : null;

    // GPU Instancing: detect from node.instances and create resources
    const nodeForInst = runtimeNode.node || runtimeNode._node;
    const hasInstancing =
      defined(nodeForInst) && defined(nodeForInst.instances);
    let instanceBuffer = null;
    let instanceCount = 1;

    if (hasInstancing) {
      if (!defined(cache.nodes[nodeIdx])) {
        cache.nodes[nodeIdx] = {
          jointBuffer: null,
          jointBufferSize: 0,
          skinningBG: null,
          packedJointMatrices: null,
        };
      }
      const nodeCache = cache.nodes[nodeIdx];
      const instRes = ensureInstancingResources(
        device,
        nodeCache,
        runtimeNode,
        model,
      ) as InstancingResourcesLike | undefined;
      if (defined(instRes)) {
        instanceCount = instRes.instanceCount;
        instanceBuffer = instRes.storageBuffer;
      }
    }

    // AUDIT_2026_05_02 B.8 (Batch 152) — per-node camera UBO + bind group.
    // The model-level cache.cameraBG was packed at line ~1681 with the
    // model-level modelMatrix; deeper nodes need their own mvpRTE +
    // encodedCameraPositionMC + normalMatrix (all model-matrix-dependent
    // fields in `packCameraUniforms`). Lazy-allocate a dedicated buffer +
    // bind group on the per-node cache and re-pack each frame so
    // articulation animation re-projects the rig correctly.
    let nodeCameraBG = cache.cameraBG;
    if (!transformIsIdentity) {
      const nc = cache.nodes[nodeIdx];
      if (!defined(nc.cameraBuffer)) {
        nc.cameraBuffer = WebGPUBuffer.createUniformBuffer(
          device,
          CAMERA_UNIFORM_SIZE,
          `Model camera node[${nodeIdx}]`,
        );
        nc.cameraData = new Float32Array(CAMERA_UNIFORM_SIZE / 4);
        nc.cameraBG = device.createBindGroup({
          label: `Model camera BG node[${nodeIdx}]`,
          layout: pipelineCache.cameraBGL,
          entries: [
            { binding: 0, resource: { buffer: nc.cameraBuffer.buffer } },
          ],
        });
      }
      packCameraUniforms(nc.cameraData, frameState, nodeModelMatrix);
      device.queue.writeBuffer(
        nc.cameraBuffer.buffer,
        0,
        nc.cameraData.buffer,
        0,
        CAMERA_UNIFORM_SIZE,
      );
      nodeCameraBG = nc.cameraBG;
    }

    // C-MODEL-2DIDL-DUPLICATE — build the y-shifted camera bind group for the
    // IDL-crossing duplicate. Mirrors WebGL `updateModelMatrix2D`: clone the
    // matrix the primary command's camera UB was packed against
    // (`nodeModelMatrix`) and move its translation to the opposite side of the
    // map (`ty -= sign(ty)·2πR`), then pack an RTE camera UB from it. The bind
    // group reuses the exact `pipelineCache.cameraBGL` the primary command
    // uses, so the shifted copy binds into @group(0) with no pipeline change.
    // Resources are lazy-allocated on the same cache object that owns the
    // primary camera BG (`cache` for identity nodes, `cache.nodes[nodeIdx]`
    // otherwise) and only when `idlDuplicateActive` — off-IDL / 3D / CV never
    // allocate or write anything here.
    let nodeIdlCameraBG = null;
    let nodeIdlModelMatrix2D = null;
    let nodeIdlBoundingSphere2D = null;
    if (idlDuplicateActive) {
      const idlHost = transformIsIdentity ? cache : cache.nodes[nodeIdx];
      const idlMat = Matrix4.clone(nodeModelMatrix, scratchIdl2DModelMatrix);
      idlMat[13] -= Math.sign(nodeModelMatrix[13]) * idlShiftAmount2D;
      if (!defined(idlHost.cameraBuffer2DIdl)) {
        idlHost.cameraBuffer2DIdl = WebGPUBuffer.createUniformBuffer(
          device,
          CAMERA_UNIFORM_SIZE,
          "Model camera 2D-IDL",
        );
        idlHost.cameraData2DIdl = new Float32Array(CAMERA_UNIFORM_SIZE / 4);
        idlHost.cameraBG2DIdl = device.createBindGroup({
          label: "Model camera BG 2D-IDL",
          layout: pipelineCache.cameraBGL,
          entries: [
            {
              binding: 0,
              resource: { buffer: idlHost.cameraBuffer2DIdl.buffer },
            },
          ],
        });
      }
      packCameraUniforms(idlHost.cameraData2DIdl, frameState, idlMat);
      device.queue.writeBuffer(
        idlHost.cameraBuffer2DIdl.buffer,
        0,
        idlHost.cameraData2DIdl.buffer,
        0,
        CAMERA_UNIFORM_SIZE,
      );
      nodeIdlCameraBG = idlHost.cameraBG2DIdl;
      // Persist the shifted matrix + bounding volume so the per-primitive
      // duplicate command (emitted below) holds stable references — the
      // `scratchIdl2DModelMatrix` is reused across nodes. The bounding volume
      // is the same model-level `_boundingSphere2D` the primary command uses,
      // translated by the identical y offset so Scene culling keeps the
      // wrapped copy (WebGL transforms the per-primitive sphere by
      // `_modelMatrix2D`; the model-level sphere is the conservative match).
      if (!defined(idlHost.idlModelMatrix2D)) {
        idlHost.idlModelMatrix2D = new Matrix4();
        idlHost.idlBoundingSphere2D = new BoundingSphere();
      }
      Matrix4.clone(idlMat, idlHost.idlModelMatrix2D);
      BoundingSphere.clone(commandBoundingVolume, idlHost.idlBoundingSphere2D);
      idlHost.idlBoundingSphere2D.center.y -=
        Math.sign(nodeModelMatrix[13]) * idlShiftAmount2D;
      nodeIdlModelMatrix2D = idlHost.idlModelMatrix2D;
      nodeIdlBoundingSphere2D = idlHost.idlBoundingSphere2D;
    }

    // NEW-MODEL-NODE-TRANSFORMS-PREV (Batch 175) — resolve the per-node
    // PREVIOUS-frame nodeModelMatrix for the velocity pack. Pre-Batch-175
    // every primitive's pack pulled `cache.prevModelMatrix` (the model-
    // level matrix), which was correct for static articulations (set
    // once, then locked) but produced ghosting under TAA when articulation
    // animations mutate `runtimeNode.transform` per-frame. Examples that
    // hit this path: satellite solar-panel deploy animations, robot-arm
    // articulations, AGI_articulations rigs whose nodes animate while
    // TAA is on.
    //
    // For identity-transform nodes the per-node `nodeModelMatrix` equals
    // the model-level `modelMatrix`, so `cache.prevModelMatrix` is also
    // the correct prev — fall back to it (no per-node storage cost on
    // the common single-node-or-static-articulation case).
    //
    // For non-identity nodes, read the per-node slot. First frame
    // (`prevNodeModelMatrix === null`) initializes from this frame's
    // `nodeModelMatrix` so velocity is exactly zero — equivalent to
    // "no history yet", matching TAA's first-frame fallback.
    let prevNodeModelMatrixForPack;
    const nodeCacheForPrev = cache.nodes[nodeIdx];
    if (transformIsIdentity || !defined(nodeCacheForPrev)) {
      prevNodeModelMatrixForPack = cache.prevModelMatrix;
    } else {
      if (!defined(nodeCacheForPrev.prevNodeModelMatrix)) {
        nodeCacheForPrev.prevNodeModelMatrix = Matrix4.clone(nodeModelMatrix);
      }
      prevNodeModelMatrixForPack = nodeCacheForPrev.prevNodeModelMatrix;
    }

    // Process each primitive on this node
    for (let primIdx = 0; primIdx < prims.length; primIdx++) {
      const rp = prims[primIdx];
      const primKey = `${nodeIdx}_${primIdx}`;

      // The shared extractor returns an immutable, WeakMap-memoized base.
      // Renderer-only metadata and implicit feature-ID fields live on a
      // reusable mutable view so source conversions and descriptor copies do
      // not recur in this per-frame loop.
      const baseGeometry = extractPrimitiveGeometry(
        rp,
      ) as PrimitiveGeometry | null;
      if (!defined(baseGeometry)) {
        const stalePrimitive = cache.primitives[primKey];
        if (defined(stalePrimitive)) {
          destroyPrimitiveCacheResources(stalePrimitive);
          delete cache.primitives[primKey];
        }
        if (defined(cache.geometryViews)) {
          delete cache.geometryViews[primKey];
        }
        continue;
      }
      const geometryRecord = getPrimitiveGeometryView(
        cache,
        primKey,
        baseGeometry,
      );
      const geometry = geometryRecord.view;

      // Get material from the primitive's glTF data
      const glTFPrimitive = rp.primitive || rp._primitive;
      // NEW-FEATURE-ID-VERTEX-ATTR (Batch 188) — `FeatureIdImplicitRange`
      // primitives have no `_FEATURE_ID_0` accessor, so
      // `extractPrimitiveGeometry` leaves `featureId0Data` null. Synthesize
      // the per-vertex array here (`offset + floor(v / repeat)`) when the
      // model's selected feature ID is implicit; the existing slot-8
      // upload path then carries it like a regular vertex attribute, and
      // the FS lights up the same `FLAG_HAS_FEATURE_ID_ATTRIBUTE` branch.
      // Closes the implicit-range follow-up after Batch 130's audit B.2.
      if (!geometry.hasFeatureId0 && defined(glTFPrimitive)) {
        const implicitSource = getSelectedImplicitFeatureId(
          model,
          runtimeNode,
          glTFPrimitive as unknown as Parameters<
            typeof getSelectedImplicitFeatureId
          >[2],
        ) as unknown as { offset?: number; repeat?: number } | null;
        const implicitOffset = implicitSource?.offset ?? 0;
        const implicitRepeat = Math.max(1, implicitSource?.repeat ?? 1);
        const implicitChanged =
          geometryRecord.implicitFeatureIdSource !== implicitSource ||
          geometryRecord.implicitFeatureIdOffset !== implicitOffset ||
          geometryRecord.implicitFeatureIdRepeat !== implicitRepeat ||
          geometryRecord.implicitFeatureIdVertexCount !== geometry.vertexCount;
        if (implicitChanged) {
          geometryRecord.implicitFeatureIdSource = implicitSource;
          geometryRecord.implicitFeatureIdOffset = implicitOffset;
          geometryRecord.implicitFeatureIdRepeat = implicitRepeat;
          geometryRecord.implicitFeatureIdVertexCount = geometry.vertexCount;
          geometryRecord.implicitFeatureIdData = defined(implicitSource)
            ? synthesizeImplicitFeatureIdData(
                model,
                runtimeNode,
                glTFPrimitive as unknown as Parameters<
                  typeof synthesizeImplicitFeatureIdData
                >[2],
                geometry.vertexCount,
              )
            : null;
        }
        const synthesized = geometryRecord.implicitFeatureIdData;
        if (defined(synthesized)) {
          geometry.featureId0Data = synthesized;
          geometry.hasFeatureId0 = true;
        }
      } else {
        geometryRecord.implicitFeatureIdSource = null;
        geometryRecord.implicitFeatureIdData = null;
      }
      // Structural metadata packing, layout resolution, and WGSL generation
      // are source-generation work. The combined immutable descriptor is
      // WeakMap-memoized by model + primitive + runtime node; this per-frame
      // path only copies references/flags onto the mutable geometry view.
      let metadataDescriptor: ModelMetadataDescriptor | undefined;
      if (defined(glTFPrimitive)) {
        metadataDescriptor = resolveWebGPUModelMetadata(
          model,
          glTFPrimitive as unknown as Parameters<
            typeof resolveWebGPUModelMetadata
          >[1],
          runtimeNode,
        ) as unknown as ModelMetadataDescriptor;
        if (metadataDescriptor.hasMetadata) {
          geometry.metadataData = metadataDescriptor.metadataData;
          geometry.hasMetadata = true;
        }
        if (metadataDescriptor.hasPropertyTextures) {
          geometry.propertyTextureLayout =
            metadataDescriptor.propertyTextureLayout;
          geometry.hasPropertyTextures = true;
        }
        if (metadataDescriptor.hasPropertyTables) {
          geometry.propertyTableLayout = metadataDescriptor.propertyTableLayout;
          geometry.hasPropertyTables = true;
        }
        if (defined(metadataDescriptor.metadataWGSL)) {
          geometry.metadataWGSL = metadataDescriptor.metadataWGSL;
          geometry.metadataClassHash = metadataDescriptor.metadataClassHash;
          geometry.metadataMatTransport =
            metadataDescriptor.metadataMatTransport;
        }
      }

      // Source replacement/revision invalidates the immutable base descriptor.
      // Rebuild the native primitive exactly once when that base changes, and
      // also when renderer annotations change which vertex/pipeline slots are
      // required. Device loss remains independent: it clears native resources
      // but can safely reuse the CPU descriptor cached by runtime primitive.
      const geometryAnnotationMask = getGeometryAnnotationMask(geometry);
      const cachedPrim = cache.primitives[primKey];
      if (
        defined(cachedPrim) &&
        (cachedPrim._geometryBase !== baseGeometry ||
          cachedPrim._geometryAnnotationMask !== geometryAnnotationMask ||
          cachedPrim._featureIdData !== geometry.featureId0Data ||
          cachedPrim._metadataDescriptor !== metadataDescriptor ||
          ((cachedPrim._metadataClassHash ?? 0) | 0) !==
            ((geometry.metadataClassHash ?? 0) | 0))
      ) {
        destroyPrimitiveCacheResources(cachedPrim);
        delete cache.primitives[primKey];
      }

      const material = glTFPrimitive?.material;
      const matInfo = extractMaterialInfo(
        material,
        geometry.hasColor0,
        geometry.hasNormals,
      );

      // PARITY-CUSTOM-SHADER-WGSL (translucencyMode slice) — apply the
      // customShader translucency override BEFORE the primitive cache /
      // pipeline is built so the forced alpha mode cascades to the pipeline
      // blend state, passClass, and draw-pass selection. No-op (byte-identical)
      // when the model has no customShader or translucencyMode is INHERIT.
      applyCustomShaderTranslucency(matInfo, model);

      // Get or create cached GPU resources for this primitive
      const primCache = ensurePrimitiveCache(
        device,
        cache,
        pipelineCache,
        primKey,
        geometry,
        matInfo,
        enqueueMip,
      );
      primCache._geometryBase = baseGeometry;
      primCache._geometryAnnotationMask = geometryAnnotationMask;
      primCache._featureIdData = geometry.featureId0Data;
      primCache._metadataDescriptor = metadataDescriptor;

      // NEW-MODEL-PROJECT2D-BV-MORPH (B11) — lazily build (and cache) the
      // accurate-2D position buffer for this primitive: reproject every vertex
      // from model space through the 3D node world matrix into the projected
      // frame, relative to the shared model-level reference. Keyed by the
      // reference so a reference shift (rare — projectTo2D locks the matrix in
      // 2D/CV) rebuilds it. The 3D `positionBuffer` is retained untouched, so
      // returning to SCENE3D is byte-identical.
      if (project2DActive && defined(project2DNodeWorld)) {
        if (
          !defined(primCache.positionBuffer2D) ||
          primCache._project2DRefKey !== cache._project2DRefKey
        ) {
          const projected = projectPositionsTo2D(
            geometry.positionData,
            project2DNodeWorld,
            cache._project2DReference,
            frameState,
          );
          primCache.positionBuffer2D?.destroy();
          primCache.positionBuffer2D = createVertexBuffer(
            device,
            projected,
            `Prim position 2D`,
          );
          primCache._project2DRefKey = cache._project2DRefKey;
        }
      }

      // DP-H46b — set the pipeline cache's metadata chunk for THIS primitive
      // before any subsequent pipeline (re)build in this loop iteration
      // (refetch / depth-write / pick / velocity / classification / translucent
      // all reuse this primCache). No-op clear for non-metadata primitives.
      applyPrimitiveMetadataToPipelineCache(pipelineCache, primCache);

      // Batch 110 — re-fetch the primary color pipeline when the
      // scene pipeline format generation has bumped since this
      // primitive was first set up. The pipelineCache was already
      // cleared by `maybeUpdateForSceneFormat` above, so the
      // getPipeline call below builds a fresh pipeline against the
      // current `_presentationFormat` (which now mirrors the scene
      // FB color format, e.g., rgba16float in HDR). Lazy variants
      // (pick / velocity / translucent / depth-write) refresh
      // themselves on their next-use sites — they're already
      // undefined-tagged for re-fetch, the existing
      // `if (!defined(primCache.X))` gates handle them.
      // C2-22 — also re-fetch when the cache swapped a color pipeline to its
      // magenta error fallback (async failure detection bumps the cache's
      // _errorSwapGeneration). primCache caches the pipeline reference, so
      // without this the swap never reaches the built command (render-hole stays).
      const errorSwapped =
        primCache._fetchedErrorGen !== pipelineCache._errorSwapGeneration;
      if (
        primCache._pipelineNeedsRefetch ||
        primCache.pipeline === null ||
        errorSwapped
      ) {
        // Batch 174 — preserve the materialDefines variant across the
        // format-change refetch.
        const md = primCache.materialDefines | 0;
        primCache.pipeline = pipelineCache.getPipeline(
          matInfo.alphaMode,
          matInfo.isDoubleSided,
          md,
        );
        if (matInfo.alphaMode === AlphaModes.BLEND) {
          primCache.depthWritePipeline = pipelineCache.getDepthWritePipeline(
            matInfo.alphaMode,
            matInfo.isDoubleSided,
            md,
          );
        }
        primCache._pipelineNeedsRefetch = false;
        primCache._fetchedErrorGen = pipelineCache._errorSwapGeneration;
      }

      // Session 65 BUG-WEBGPU-MODEL-TEXTURE-PLACEHOLDER-STUCK fix.
      // Per-frame poll: any slot that fell back to a default
      // placeholder texture during the initial ensurePrimitiveCache
      // call gets re-checked here. As soon as the matching glTF
      // texture reader resolves its image source we upload the real
      // GPU texture and force a textureEntries rebuild below so the
      // bind group picks up the new view.
      // Cheap when nothing's pending (single Set.size check); the
      // upload cost only fires once per slot per primitive.
      const texturesUpgraded = refreshDeferredModelTextures(
        device,
        primCache,
        matInfo,
        enqueueMip,
      );

      // C-R4-GLTF-KHR-TRANSMISSION (Batch 107) — when the primitive
      // declares transmission AND the SceneRenderer has published a
      // refraction view this frame, ensure the texture bind group
      // points at the latest view. Cheap: a reference compare against
      // the last-bound view; rebuild only on first use OR when the
      // scene framebuffer reallocates the refraction texture (resize,
      // HDR toggle). Also publishes the per-frame "scene has
      // transmission" flag so the SceneRenderer's capture pass fires.
      // NEW-BG-CONSOLIDATION (Batch 122) — track texture entries
      // instead of a standalone bind group. Rebuilt only when the
      // refraction view changes (per-frame ref compare).
      if (matInfo.hasTransmission) {
        context._sceneHasTransmission = true;
        const currentRefractionView = context._refractionSceneView ?? null;
        if (primCache.refractionViewBound !== currentRefractionView) {
          primCache.textureEntries = getModelTextureEntries(
            primCache,
            currentRefractionView,
            primCache.materialDefines | 0,
            getCustomShaderEntries(cache, pipelineCache),
          );
          primCache.refractionViewBound = currentRefractionView;
        }
      }
      // First-frame texture-entries build (no transmission).
      // Also rebuild when refreshDeferredModelTextures upgraded a
      // placeholder slot above — the textureViews map now points at
      // a real GPU texture but textureEntries still references the
      // stale placeholder view. Without this rebuild, the bind group
      // keeps the white fallback even after the real texture loads
      // (root cause of Mars/Moon/Aerometrex/BIM "all-white" cluster).
      if (!defined(primCache.textureEntries) || texturesUpgraded) {
        primCache.textureEntries = getModelTextureEntries(
          primCache,
          primCache.refractionViewBound ?? null,
          primCache.materialDefines | 0,
          getCustomShaderEntries(cache, pipelineCache),
        );
      }

      // Create per-primitive material + light uniform buffers (once).
      // The merged group 1 bind group is built per-frame at the draw
      // command emission site (combines material UBO + light UBO +
      // texture entries + featureId entries into one BG).
      if (!defined(primCache.materialBuffer)) {
        primCache.materialBuffer = WebGPUBuffer.createUniformBuffer(
          device,
          MATERIAL_UNIFORM_SIZE,
          `Prim material`,
        );
        primCache.materialData = new Float32Array(MATERIAL_UNIFORM_SIZE / 4);
        primCache.lightBuffer = WebGPUBuffer.createUniformBuffer(
          device,
          LIGHT_UNIFORM_SIZE,
          `Prim light`,
        );
        primCache.lightData = new Float32Array(LIGHT_UNIFORM_SIZE / 4);
      }

      // Determine if this specific primitive has skinning
      // (node has skin AND primitive has joints/weights attributes)
      const primHasSkinning = hasSkinning && primCache.hasSkinningAttributes;

      // Morph targets: create/update GPU resources per-primitive
      const morphWeights =
        runtimeNode.morphWeights ?? runtimeNode._morphWeights;
      const primHasMorphTargets =
        geometry.morphTargetCount > 0 &&
        defined(morphWeights) &&
        morphWeights.length > 0;
      // NEW-BG-CONSOLIDATION (Batch 122) — track morph target buffers
      // instead of a standalone bind group. The merged group 2 bind
      // group at the draw command emission site composes them with
      // skinning + instancing into one bind group.
      let morphDeltaBuffer = null;
      let morphWeightBuffer = null;
      // NEW-TAA-MORPH-PREV (Batch 134) -- prev-frame mirror for TAA
      // velocity. Same swap pattern as `prevPackedJointMatrices`.
      let prevMorphWeightBuffer = null;
      if (primHasMorphTargets) {
        const morphRes = ensureMorphTargetResources(
          device,
          primCache,
          geometry,
          morphWeights as unknown as Parameters<
            typeof ensureMorphTargetResources
          >[3],
        ) as MorphTargetResourcesLike | undefined;
        if (defined(morphRes)) {
          morphDeltaBuffer = morphRes.storageBuffer;
          morphWeightBuffer = morphRes.weightBuffer;
          prevMorphWeightBuffer = morphRes.weightBufferPrev;
        }
      }

      // C-R9-MODEL-PICK (Batch 54 / refactored Batch 59) — per-glTF-
      // primitive pick ID allocation delegated to {@link ensurePickId} in
      // multi-id mode (`idKey = primKey`). Each glTF primitive of a model
      // gets its own pick color so `scene.pick()` can resolve back to
      // {primitive: model, id: primKey}. Per-feature pick (each
      // EXT_mesh_features feature → one pick target) is the larger
      // workstream tracked as `C-R9-MODEL-FEATURE-PICK`. The cache key
      // `nodeIdx_primIdx` matches `primKey` so pick IDs follow primitive
      // identity stably across re-extractions.
      const passes = frameState.passes;
      const allowAllocate = !!(passes && (passes.pick || passes.render));
      const modelPickId = ensurePickId(
        model as unknown as Parameters<typeof ensurePickId>[0],
        context as unknown as Parameters<typeof ensurePickId>[1],
        cache as unknown as Parameters<typeof ensurePickId>[2],
        {
          idKey: primKey,
          allowAllocate,
          // DP-H46e — fold a `detail.model` into the pick object so the
          // backend-agnostic `Scene.pickMetadata` orchestration (which reads
          // `pickedObject.detail.model.structuralMetadata` — see
          // `Scene.pickMetadata`/`Scene.pickMetadataSchema`) resolves the model's
          // structural metadata on WebGPU exactly as it does for WebGL's
          // `PickingPipelineStage.buildPickObject` (`{ primitive, detail: { model,
          // node, primitive } }`). Without this, `scene.pick` on WebGPU returns
          // `{ primitive: model }` with no `.detail.model`, so `pickMetadata` bails
          // out at the `detail?.model?.structuralMetadata` guard before reaching
          // the WebGPU metadata-pick producer. Only `model` is needed by the
          // metadata path; node/primitive are omitted (no consumer on WebGPU yet).
          detail: { model: model },
        },
      );
      const pickColor = modelPickId?.color;

      // TAA Slice 2c (Batch 96) — track per-model previousModelMatrix on
      // the model's WebGPU cache (one slot for the whole model — every
      // primitive shares the same matrix per frame). The motion-vector
      // output gates on `frameState.taaEnabled` so static scenes don't
      // pay the per-fragment velocity cost. Capturing the matrix on the
      // model rather than the primitive avoids storing it once per
      // primitive of a multi-mesh asset (ECS behavior — per model).
      if (!defined(cache.prevModelMatrix)) {
        cache.prevModelMatrix = Matrix4.clone(modelMatrix);
      }
      const motionEnabled = frameState?.taaEnabled === true;

      // C-R1-TILE-BATCH (Batch 100) — primary command class. The model
      // emits the OPAQUE-class command first (passClass=0). When the
      // model carries a Cesium3DTileBatchTable AND its alphaMode is
      // OPAQUE/MASK, the renderer emits a SECOND translucent-class
      // command (passClass=1, pass=Pass.TRANSLUCENT) so per-feature
      // styling can flip individual features to translucent without
      // pipeline state changes — see the dual-command emission block
      // below for the second command. Models whose alphaMode is BLEND
      // already land in TRANSLUCENT pass; their primary command is the
      // translucent-class one and no derivation is needed.
      const passClass = matInfo.alphaMode === AlphaModes.BLEND ? 1 : 0;

      // Update material uniforms (includes skinning + morph flags +
      // pick color slot + TAA per-model motion + tile-batch passClass).
      // AUDIT_2026_05_02 B.8 (Batch 152, fixed Batch 154) — passes the
      // per-runtime-node modelMatrix (`modelMatrix * runtimeNode.computedTransform`,
      // where `computedTransform = transformToRoot × transform`) so the
      // FS world-space reconstructions (`material.modelMatrix * input.rteMC`
      // — see ModelPBRComplete.wgsl:1600/2016/2029/2072/2233) compose with
      // the correct parent-chain + local transform for articulated rigs.
      packMaterialUniforms(
        primCache.materialData,
        nodeModelMatrix,
        matInfo,
        primHasSkinning,
        primHasMorphTargets,
        pickColor,
        // NEW-MODEL-NODE-TRANSFORMS-PREV (Batch 175) — per-node prev.
        prevNodeModelMatrixForPack,
        motionEnabled,
        passClass,
      );

      // WIRE-MODEL-SPLITTER — the split scalars ride the material UB's
      // historical pad lanes (floats 38/39, `_pad_end2`/`_pad_end3` in
      // ModelPBRComplete.wgsl — packMaterialUniforms zeroes them just
      // above). Packed unconditionally (the log-depth-lane precedent);
      // only the `//>>ifdef MODEL_SPLIT_ENABLED` FS blocks read them.
      primCache.materialData[38] = modelSplitDirection;
      primCache.materialData[39] = modelSplitPositionPx;

      // WIRE-MODEL-COLOR — model.color rides the material UB's reserved
      // tail lane (floats 184-187, `_pad_reserved8`) and the blend scalar
      // rides `motionFlags.w` (float 175). packMaterialUniforms zero-fills
      // both just above, so the undefined-color default stays byte-
      // identical; only the `//>>ifdef MODEL_HAS_COLOR` FS blocks read them.
      if (modelHasColor) {
        primCache.materialData[175] = modelColorBlend;
        primCache.materialData[184] = modelColor.red;
        primCache.materialData[185] = modelColor.green;
        primCache.materialData[186] = modelColor.blue;
        primCache.materialData[187] = modelColor.alpha;
      }

      // Feature ID textures + batch texture (for per-feature styling).
      // C-R9-MODEL-FEATURE-PICK (Batch 101) — threads `context` +
      // `cache` (per-model cache) + a `pickPassActive` hint so
      // `ensurePerFeaturePickIds` can allocate per-feature pickIds.
      // NEW-BG-CONSOLIDATION (Batch 122) — `featureIdRes.featureIdEntries`
      // are entries (bindings 26-32) spliced into the merged group 1.
      let featureIdEntries = null;
      const pickPassActive = !!(passes && passes.pick);
      const featureIdRes = ensureFeatureIdResources(
        device,
        primCache,
        model,
        glTFPrimitive as unknown as Parameters<
          typeof ensureFeatureIdResources
        >[3],
        runtimeNode,
        pipelineCache,
        context,
        cache,
        pickPassActive,
      ) as FeatureIdResourcesLike | undefined;

      // Set instancing + feature ID flags AFTER packMaterialUniforms
      {
        const flagsView = new DataView(
          primCache.materialData.buffer,
          primCache.materialData.byteOffset,
        );
        let currentFlags = flagsView.getUint32(28 * 4, true);
        if (hasInstancing && instanceCount > 1) {
          currentFlags |= FLAG_HAS_INSTANCING;
        }
        if (defined(featureIdRes)) {
          currentFlags |= featureIdRes.flags;
          featureIdEntries = featureIdRes.featureIdEntries;
        }
        flagsView.setUint32(28 * 4, currentFlags, true);
      }

      device.queue.writeBuffer(
        primCache.materialBuffer.buffer,
        0,
        primCache.materialData.buffer,
        0,
        MATERIAL_UNIFORM_SIZE,
      );

      // Update light uniforms (per frame)
      packLightUniforms(primCache.lightData, frameState, model);
      device.queue.writeBuffer(
        primCache.lightBuffer.buffer,
        0,
        primCache.lightData.buffer,
        0,
        LIGHT_UNIFORM_SIZE,
      );

      // Session 62 NEW-VR-VERTEX-BUFFER-VARIANT (+ Session 65 follow-up)
      // — variant-aware vertex buffer slots. When MODEL_HAS_TEXCOORD_1
      // is unset, the pipeline omits slot 7 (texCoord1); when
      // MODEL_HAS_FEATURE_ID_0 is unset, slot 8 (featureId0) is also
      // omitted. The buffers array must match the pipeline layout count
      // or `setVertexBuffer(N, ...)` errors with "slot larger than
      // maximum" on Edge (which caps maxVertexBuffers at 8).
      //
      // Layout permutations:
      //   - both unset   → 7 slots (positions 0-6)            ← common case
      //   - tex1 only    → 8 slots (positions 0-7, no featureId0)
      //   - feat0 only   → 8 slots (positions 0-6, 8; slot 7 = featureId0)*
      //   - both set     → 9 slots (positions 0-8)
      //
      // (*) When tex1 is unset but feat0 is set we still have to push
      // featureId0 — but at the SAME `shaderLocation = 8` per the
      // `createVertexBufferLayout` contract. WebGPU keys buffer slots
      // by their position in the `buffers` array, not by shader
      // location; the binding order here matches the array index, so
      // pushing featureId0 in 8th place (index 7) into a 7+1=8-slot
      // array is correct: it goes to GPU slot 7, which the layout
      // declares to feed `shaderLocation = 8`.
      const hasTexCoord1 =
        (primCache.materialDefines & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0;
      const hasFeatureId0 =
        (primCache.materialDefines & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0;
      // DP-H46a — slot 9 (metadata scalar) is present only on metadata
      // models. The vertexBuffers array must match the pipeline layout's
      // slot count exactly or `setVertexBuffer` errors.
      const hasMetadata =
        (primCache.materialDefines & ShaderDefine.MODEL_HAS_METADATA) !== 0;
      // NEW-MODEL-PROJECT2D-BV-MORPH (B11) — bind the reprojected accurate-2D
      // position buffer when the model is projectTo2D-active and it has been
      // built; otherwise the untouched 3D position buffer (byte-identical off).
      const positionBuffer0 =
        project2DActive && defined(primCache.positionBuffer2D)
          ? primCache.positionBuffer2D
          : primCache.positionBuffer;
      const vertexBuffers = [
        positionBuffer0,
        primCache.normalBuffer || pipelineCache.defaultNormalBuffer,
        primCache.tangentBuffer || pipelineCache.defaultTangentBuffer,
        primCache.uvBuffer || pipelineCache.defaultUVBuffer,
        primCache.colorBuffer || pipelineCache.defaultColorBuffer,
        primCache.jointsBuffer || pipelineCache.defaultJointsBuffer,
        primCache.weightsBuffer || pipelineCache.defaultWeightsBuffer,
      ];
      if (hasTexCoord1) {
        vertexBuffers.push(
          primCache.uv1Buffer ||
            primCache.uvBuffer ||
            pipelineCache.defaultUVBuffer,
        );
      }
      if (hasFeatureId0) {
        vertexBuffers.push(
          primCache.featureIdBuffer || pipelineCache.defaultFeatureIdBuffer,
        );
      }
      // DP-H46a — metadata scalar at slot 9. Pushed LAST so the array
      // index matches the layout's final buffer slot. The
      // `createVertexBufferLayout(... hasMetadata)` declares
      // `shaderLocation = 9` for this slot regardless of the array
      // position (WebGPU keys slots by array index, not shaderLocation),
      // and the renderer keeps the push order in lockstep with the
      // layout's conditional appends. Falls back to the default
      // single-element feature-ID buffer (a 1-vertex f32) only as a
      // never-reached guard — the presence gate guarantees
      // `_metadataBuffer` exists when this bit is set.
      if (hasMetadata) {
        vertexBuffers.push(
          primCache._metadataBuffer || pipelineCache.defaultFeatureIdBuffer,
        );
      }

      // Use model.opaquePass to get the correct pass:
      //   - Pass.CESIUM_3D_TILE for 3D Tiles content (set by Model3DTileContent)
      //   - Pass.OPAQUE for standalone models
      // Alpha blend primitives override to TRANSLUCENT
      // AUDIT_2026_05_02 A.8 (Batch 142, NEW-MODEL-AS-CLASSIFIER) —
      // when `model.classificationType` is set, the model becomes a
      // classification volume: route the command into the appropriate
      // classifier pass and use the depth-sample classifier pipeline
      // instead of the lit PBR pipeline. Mirrors WebGL's
      // `ClassificationModelDrawCommand` pass routing
      // (`Source/Scene/Model/ClassificationModelDrawCommand.js`).
      // AUDIT_2026_05_02 A.3 (Batch 146) — `classificationType: BOTH`
      // now emits TWO commands per primitive (one for TERRAIN, one for
      // 3D Tile) instead of collapsing to a single 3D Tile pass. The
      // non-classifier path still emits a single command. Both paths
      // run through the same `passes` loop below.
      const isClassifier = defined(model.classificationType);

      // C-R8-EDGE-DISPLAY-MODE (§5 P2) — resolve the model's
      // EdgeDisplayMode for this edge-bearing primitive. Mirrors WebGL's
      // `ModelDrawCommand.pushCommands` / `pushEdgeCommands`
      // (`ModelDrawCommand.js:185-265`):
      //   - SURFACES_ONLY (default): surface renders, edges suppressed.
      //   - SURFACES_AND_EDGES: surface renders, edges → MRT
      //     (`CESIUM_3D_TILE_EDGES`) for the Batch 44 composite.
      //   - EDGES_ONLY: surface suppressed for edge-bearing primitives,
      //     edges → `CESIUM_3D_TILE_EDGES_DIRECT` (renders straight onto
      //     the scene framebuffer — CAD wireframe).
      // `_needsEdgeCommands` on WebGL ⇔ this primitive actually produced
      // edge geometry. WebGL gates on `defined(renderResources.edgeGeometry)`
      // (`ModelDrawCommand.js:81`), NOT just the extension's presence — a
      // primitive that declares `EXT_mesh_primitive_edge_visibility` but
      // yields no extractable edges keeps its surface (`_needsEdgeCommands`
      // is false). We mirror that: the edge emitter below sets
      // `primCache.edgeResources = false` (a sentinel distinct from
      // `undefined` = "not yet checked") once it confirms a primitive has
      // no edges. Suppress the surface only when edges are present OR not
      // yet determined (`!== false`) — on the steady-state frame after the
      // first, a degenerate edge-less primitive falls back to rendering its
      // surface exactly like WebGL. Classifiers never run the edge stage
      // (see Batch 142 note below), so the suppression skips them.
      const edgeDisplayMode =
        model.edgeDisplayMode ?? EdgeDisplayMode.SURFACES_ONLY;
      const primitiveHasEdges =
        defined(glTFPrimitive?.edgeVisibility) &&
        primCache.edgeResources !== false;
      const suppressSurfaceForEdgesOnly =
        !isClassifier &&
        primitiveHasEdges &&
        edgeDisplayMode === EdgeDisplayMode.EDGES_ONLY;

      const drawPasses: number[] = [];
      if (isClassifier) {
        const classType = model.classificationType;
        if (classType === 0 /* TERRAIN */ || classType === 2 /* BOTH */) {
          drawPasses.push(Pass.TERRAIN_CLASSIFICATION);
        }
        if (
          classType === 1 /* CESIUM_3D_TILE */ ||
          classType === 2 /* BOTH */
        ) {
          drawPasses.push(Pass.CESIUM_3D_TILE_CLASSIFICATION);
        }
      } else {
        drawPasses.push(
          matInfo.alphaMode === AlphaModes.BLEND
            ? Pass.TRANSLUCENT
            : model.opaquePass,
        );
      }

      // C-R1 (Batch 37) — forward the source JS-side renderState from
      // `runtimePrimitive.drawCommand._command.renderState` so our
      // Batch 30 `applyPerEncoderState` hook fires per-draw
      // stencilRef / blendConstant / viewport / scissor. Model
      // primitives set distinct renderStates for silhouette / shadow /
      // backface / classification variants (`ModelDrawCommand.js` lines
      // 626, 641, 767, 818, 868, 925, 950); forwarding the base-color
      // renderState covers the primary draw. Derived-variant coverage
      // (silhouette / shadow-receive / depth-fail) remains follow-up
      // per the Batch 29 `selectCommandVariant` dispatcher — when
      // populators land they'll pull renderState from their
      // corresponding derived ModelDrawCommand slot.
      const rpDrawCommand = rp.drawCommand;
      const modelRenderState = rpDrawCommand?._command?.renderState;

      // NEW-BG-CONSOLIDATION (Batch 122) — 4 merged bind groups.
      // Batch 174 — `materialDefines` selects the per-variant materialBGL.
      // C9-17 Slice A — memoized IBL entries (stable array identity while the
      // five resolved IBL identities are unchanged) so the group-1 cache below
      // keys on one array reference.
      const iblEntries = getOrCreateModelIBLEntries(
        cache,
        model,
        pipelineCache,
        frameState,
      );
      const mergedMaterialBG = getOrCreateMergedMaterialBindGroup(
        primCache,
        MERGED_MATERIAL_SLOT_PRIMARY,
        device,
        pipelineCache,
        primCache.materialBuffer,
        primCache.lightBuffer,
        primCache.textureEntries,
        featureIdEntries,
        iblEntries,
        primCache.materialDefines | 0,
        frameState,
      );
      const mergedInstanceBG = getOrCreateMergedInstanceBindGroup(
        primCache,
        device,
        pipelineCache,
        nodeJointBuffer,
        morphDeltaBuffer,
        morphWeightBuffer,
        instanceBuffer,
        nodePrevJointBuffer,
        prevMorphWeightBuffer,
        // NEW-TAA-INSTANCE-PREV (Batch 134) -- static GPU instancing
        // (today's only case) aliases the current buffer for zero
        // velocity contribution. When animated instancing lands the
        // node cache will hold a separate `prevInstancingBuffer`.
        instanceBuffer,
      );

      // AUDIT_2026_05_02 A.8 (Batch 142, NEW-MODEL-AS-CLASSIFIER) —
      // route through the classification pipeline when the model is a
      // classifier. Same vertex stage / bind groups / vertex buffers /
      // index buffer; only the fragment entry differs (samples globe
      // depth, discards on sky, emits `material.baseColorFactor`).
      // WIRE-MODEL-SILHOUETTE — when the silhouette is active, the BASE
      // draw swaps to the stencil-write variant (WebGL
      // `deriveSilhouetteModelCommand`: same shading, stencil ALWAYS /
      // zPass REPLACE stamps `model._silhouetteId % 255`; invisible
      // models zero the colour writeMask). The derived colour command is
      // built after the primary push below. hasSilhouette() excludes
      // classifiers, so the two branches never coincide.
      if (modelHasSilhouette && !defined(primCache.silhouettePipeline)) {
        primCache.silhouettePipeline = pipelineCache.getSilhouetteModelPipeline(
          matInfo.alphaMode,
          matInfo.isDoubleSided,
          primCache.materialDefines | 0,
          model.isInvisible(),
        );
      }
      const activePipeline = isClassifier
        ? pipelineCache.getClassificationPipeline(
            matInfo.alphaMode,
            matInfo.isDoubleSided,
            // Batch 174 — preserve materialDefines variant for the
            // classification pipeline so it pairs with the matching
            // per-variant materialBGL the bind group above was
            // constructed against.
            primCache.materialDefines | 0,
          )
        : modelHasSilhouette
          ? primCache.silhouettePipeline
          : primCache.pipeline;

      // WIRE-MODEL-SILHOUETTE — the stencil-write pipeline needs the
      // model's stencil reference set per-draw (`applyPerEncoderState`
      // reads `renderState.stencilTest.reference` →
      // `setStencilReference`). Shallow-merge over the forwarded WebGL
      // renderState so its other dynamic state (viewport / scissor /
      // blend constant) is preserved.
      const activeRenderState = modelHasSilhouette
        ? {
            ...(modelRenderState ?? {}),
            stencilTest: { reference: silhouetteStencilRef },
          }
        : modelRenderState;

      // AUDIT_2026_05_02 A.3 (Batch 146) — `passes[0]` is the primary
      // pass. The non-classifier path always has length 1, so the
      // existing pick/velocity/dual/translucent/edge code below operates
      // on `webgpuCmd` (the primary command). The classifier path may
      // have length 2 for BOTH; the second command is built from the
      // same args after the primary push and goes straight onto the
      // commandList without pick/velocity attachments (classifier
      // doesn't pick or emit velocity).
      const primaryPass = drawPasses[0];
      const webgpuCmdArgs = {
        pipeline: activePipeline,
        bindGroups: [
          nodeCameraBG, // group 0 — per-runtime-node when computedTransform != I (B.8)
          mergedMaterialBG, // group 1 (material + light + textures + featureId)
          mergedInstanceBG, // group 2 (skinning + morph + instancing)
          cache.effectsBG, // group 3 (was group 7)
        ],
        vertexBuffers: vertexBuffers,
        indexBuffer: primCache.indexBuffer || undefined,
        indexCount: primCache.indexCount || 0,
        indexFormat: primCache.indexFormat || "uint16",
        vertexCount: primCache.vertexCount || 0,
        instanceCount: instanceCount,
        pass: primaryPass,
        owner: model,
        boundingVolume: commandBoundingVolume,
        modelMatrix: modelMatrix,
        cull: model._cull ?? true,
        renderState: activeRenderState,
        // C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 79) — depth-write variant
        // pipeline for BLEND primitives. Only consumed when the command's
        // `depthForTranslucentClassification` flag is set (forwarded by
        // `Cesium3DTile.update` for translucent tile content). Undefined
        // for OPAQUE/MASK because they already write depth.
        classificationDepthPipeline: primCache.depthWritePipeline,
      };
      const webgpuCmd: ModelDrawCommand = new WebGPUDrawCommand(webgpuCmdArgs);

      // C2-25 ENV-SCENE-CAPTURE (Batch 447) — collect this primitive's
      // camera-independent draw resources so the env-map capture pass can
      // replay it per cube face. Skips:
      //   - classifiers (`isClassifier`): they draw via globe-depth sampling,
      //     not as reflective surfaces.
      //   - edge-only suppressed surfaces (`suppressSurfaceForEdgesOnly`): the
      //     surface command exists only to seed edges, not to be reflected.
      //   - translucent (BLEND) primitives (audit fix): the capture pipeline is
      //     OPAQUE (no blend state) + depth-write, so a translucent surface
      //     captured opaquely would write a wrong, fully-opaque reflection and
      //     occlude geometry behind it. Reflecting translucency correctly needs
      //     a blended capture variant — deferred.
      if (
        captureRecords !== null &&
        !isClassifier &&
        !suppressSurfaceForEdgesOnly &&
        matInfo.alphaMode !== AlphaModes.BLEND
      ) {
        captureRecords.push({
          alphaMode: matInfo.alphaMode,
          doubleSided: matInfo.isDoubleSided,
          materialDefines: primCache.materialDefines | 0,
          // GLTF-POINTS-MODE — capture replay builds its pipeline next frame
          // from the record alone, so carry the topology with it.
          topology: primCache.topology,
          // DP-H46b — carry the generated metadata chunk + class hash so the
          // capture replay (`getOrCreateModelCaptureCommands`) can prepend the
          // same `struct Metadata` before building the capture pipeline.
          // Otherwise a metadata model in the env-capture set would compile a
          // MODEL_HAS_METADATA module with no `initializeMetadata` declared.
          // undefined for non-metadata primitives (capture build clears).
          metadataWGSL: primCache._metadataWGSL,
          metadataClassHash: primCache._metadataClassHash | 0,
          // NEW-MODEL-METADATA-MAT3-MAT4 — the capture replay must rebuild
          // its pipeline with the same widened-transport variant.
          metadataMatTransport: primCache._metadataMatTransport === true,
          materialBuffer: primCache.materialBuffer,
          lightBuffer: primCache.lightBuffer,
          textureEntries: primCache.textureEntries,
          featureIdEntries,
          mergedInstanceBG,
          effectsBG: cache.effectsBG,
          vertexBuffers,
          indexBuffer: primCache.indexBuffer || undefined,
          indexCount: primCache.indexCount || 0,
          indexFormat: primCache.indexFormat || "uint16",
          vertexCount: primCache.vertexCount || 0,
          instanceCount,
          // The model-matrix this primitive's camera UB was packed against
          // (model-level, or per-runtime-node when computedTransform != I).
          // CLONE: for non-identity nodes `nodeModelMatrix` aliases the shared
          // `scratchNodeModelMatrix`, overwritten on the next node iteration —
          // and capture runs NEXT frame (reads last frame's published refs), so
          // a live reference would be stale. The clone is a stable snapshot.
          nodeModelMatrix: Matrix4.clone(nodeModelMatrix),
        });
      }

      // ── Shadow cast tagging ──
      //
      // Three variants cover the model path:
      //
      //   primHasSkinning          → `modelSkinned`
      //       Binding 1 = per-model modelMatrix UB
      //       Binding 2 = joint matrices storage buffer (same buffer
      //       the color pass binds at @group(3))
      //       VBs pulled from slots 0/5/6 of the command's full
      //       7-buffer layout (pos, joints0, weights0).
      //
      //   instanceCount === 1      → `modelP12`
      //       Single-instance non-skinned case. Binding 1 = per-model UB.
      //
      //   instanceCount > 1        → `modelInstancedSB`
      //       GPU-instanced non-skinned case. Binding 1 = per-model UB,
      //       Binding 2 = per-instance transforms storage buffer
      //       (same buffer the color pass binds at @group(5)).
      //
      // Skinning + instancing together is uncommon (animated crowds)
      // and not covered by a variant yet — those commands currently
      // fall through to modelInstancedSB without applying the skin
      // transform. A `modelSkinnedInstanced` variant could be added
      // following the same pattern if needed.
      if (castShadows) {
        const nodeCache = cache.nodes[nodeIdx];
        if (primHasSkinning && nodeCache && nodeCache.jointBuffer) {
          webgpuCmd._shadowCastLayout = "modelSkinned";
          webgpuCmd._shadowCastModelUB = cache.shadowCastUB;
          webgpuCmd._shadowCastJointMatricesSB = nodeCache.jointBuffer;
        } else if (instanceCount === 1) {
          webgpuCmd._shadowCastLayout = "modelP12";
          webgpuCmd._shadowCastModelUB = cache.shadowCastUB;
        } else if (
          instanceCount > 1 &&
          nodeCache &&
          nodeCache.instancingBuffer
        ) {
          webgpuCmd._shadowCastLayout = "modelInstancedSB";
          webgpuCmd._shadowCastModelUB = cache.shadowCastUB;
          webgpuCmd._shadowCastInstancingSB = nodeCache.instancingBuffer;
        }
      }

      // C-R9-MODEL-PICK (Batch 54) — pick command. Same layout, vertex
      // stage, vertex buffers, bind groups, and index buffer as the
      // color command; only the pipeline differs (pick fragment entry,
      // no blend, depth write forced on). Wired onto the color command's
      // `derivedCommands.picking.pickCommand` so the Batch 29 dispatcher
      // (`selectCommandVariant` in `WebGPUSceneRenderer.ts`) routes here
      // during pick passes. Only materialized when a pick ID exists —
      // models in non-pick render passes (frameState.passes.pick=false
      // and passes.render=false) skip pick-id allocation, so `pickColor`
      // can be undefined here for an OFFSCREEN/UPDATE-only frame.
      // AUDIT_2026_05_02 A.8 (Batch 142) — classifiers don't pick. The
      // WebGL `ClassificationModelDrawCommand` doesn't allocate a pick
      // command either; classifier draws into TERRAIN/3D-Tile pass on
      // the scene FB, not the pick FBO.
      if (pickColor && !isClassifier) {
        if (!defined(primCache.pickPipeline)) {
          primCache.pickPipeline = pipelineCache.getPickPipeline(
            matInfo.alphaMode,
            matInfo.isDoubleSided,
            // Batch 174 — pick pipeline must use the same per-variant
            // pipeline layout as the color pipeline so it pairs with
            // the same merged group-1 bind group at draw time.
            primCache.materialDefines | 0,
          );
        }
        // Shared draw args reused across all pick variants (default,
        // hover, precise pass 1, precise pass 2). Only the pipeline
        // differs between them; same vertex buffers, bind groups, and
        // index buffer apply to every variant.
        const sharedPickDrawArgs = {
          bindGroups: [
            nodeCameraBG, // B.8 (Batch 152) — per-runtime-node camera BG
            mergedMaterialBG,
            mergedInstanceBG,
            cache.effectsBG,
          ],
          vertexBuffers: vertexBuffers,
          indexBuffer: primCache.indexBuffer || undefined,
          indexCount: primCache.indexCount || 0,
          indexFormat: primCache.indexFormat || "uint16",
          vertexCount: primCache.vertexCount || 0,
          instanceCount: instanceCount,
          pass: primaryPass,
          owner: model,
          boundingVolume: commandBoundingVolume,
          modelMatrix: modelMatrix,
          cull: model._cull ?? true,
          renderState: modelRenderState,
          pickOnly: true,
        };
        const pickCmd = new WebGPUDrawCommand({
          ...sharedPickDrawArgs,
          pipeline: primCache.pickPipeline,
        });
        attachPickToColorCommand(webgpuCmd, pickCmd);

        // C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — Option D / hover
        // pick variant. Lazily build pipeline on first frame the scene
        // requests hover-mode pick. Built unconditionally here for
        // BLEND alphaMode so the cost is paid up-front (1 pipeline
        // alloc); for OPAQUE/MASK the factory delegates to the regular
        // pick pipeline so no extra alloc happens (cache hit).
        //
        // Scene flag `_webgpuPickHoverEnabled` is set to true the first
        // time `Scene.pickHoverAsync` is called on the scene; once
        // enabled it stays on for the scene's lifetime (the WGSL
        // module cache dedupes the dither variant across all model
        // instances on the device, so the marginal cost is the FS
        // entry compile + per-(alphaMode, doubleSided, materialDefines)
        // pipeline alloc).
        const scene = frameState?.scene;
        const wantHover = scene?._webgpuPickHoverEnabled === true;
        if (wantHover) {
          if (!defined(primCache.pickHoverPipeline)) {
            primCache.pickHoverPipeline = pipelineCache.getPickHoverPipeline(
              matInfo.alphaMode,
              matInfo.isDoubleSided,
              primCache.materialDefines | 0,
            );
          }
          const pickHoverCmd = new WebGPUDrawCommand({
            ...sharedPickDrawArgs,
            pipeline: primCache.pickHoverPipeline,
          });
          attachPickVariantsToColorCommand(webgpuCmd, {
            hoverPick: pickHoverCmd,
          });
        }

        // C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — Option C precise
        // pick variant. For OPAQUE/MASK, pass 1 IS the regular pick
        // pipeline (factory delegates) and pass 2 is null — dispatcher
        // handles the null fall-through by skipping pass 2. For BLEND,
        // both passes are real with depth-only pass 1 + depth-EQUAL
        // color pass 2, sharing the pick FBO depth attachment within
        // a single render pass.
        //
        // Scene flag `_webgpuPickPreciseEnabled` set on first
        // `Scene.pickPreciseAsync` call. The 2× translucent
        // rasterization cost is paid only when this flag is true, and
        // only for the precise pick path (regular `pick()` and
        // `pickHover()` keep their own pipelines).
        const wantPrecise = scene?._webgpuPickPreciseEnabled === true;
        if (wantPrecise) {
          if (!defined(primCache.pickPrecisePass1Pipeline)) {
            primCache.pickPrecisePass1Pipeline =
              pipelineCache.getPickPrecisePass1Pipeline(
                matInfo.alphaMode,
                matInfo.isDoubleSided,
                primCache.materialDefines | 0,
              );
          }
          if (
            matInfo.alphaMode === AlphaModes.BLEND &&
            !defined(primCache.pickPrecisePass2Pipeline)
          ) {
            primCache.pickPrecisePass2Pipeline =
              pipelineCache.getPickPrecisePass2Pipeline(
                matInfo.alphaMode,
                matInfo.isDoubleSided,
                primCache.materialDefines | 0,
              );
          }
          // Batch 194 (B192-D1 audit fix) — both precise passes need
          // stencilReference=1 set on the render pass encoder before
          // their draw. Pass 1's `passOp: replace` writes 1 (replacing
          // the cleared 0); pass 2's `compare: equal` matches stencil
          // == 1 (only pass-1-covered pixels). Without this, the
          // stencil mechanism is non-functional: pass 1 writes 0 (the
          // default ref) which is identical to the FBO clear value, so
          // pass 2 fires on every pixel rather than only pass-1
          // winners. `applyPerEncoderState` reads `renderState.
          // stencilTest.reference` and calls `passEncoder.
          // setStencilReference()` when nonzero.
          const preciseRenderState = {
            ...modelRenderState,
            stencilTest: { reference: 1 },
          };
          const precisePass1Cmd = new WebGPUDrawCommand({
            ...sharedPickDrawArgs,
            pipeline: primCache.pickPrecisePass1Pipeline,
            renderState: preciseRenderState,
          });
          const precisePass2Cmd = defined(primCache.pickPrecisePass2Pipeline)
            ? new WebGPUDrawCommand({
                ...sharedPickDrawArgs,
                pipeline: primCache.pickPrecisePass2Pipeline,
                renderState: preciseRenderState,
              })
            : undefined;
          attachPickVariantsToColorCommand(webgpuCmd, {
            precisePass1: precisePass1Cmd,
            precisePass2: precisePass2Cmd,
          });
        }
      }

      // DP-H46e — metadata-pick command (scene.pickMetadata producer). Built
      // ONLY during a metadata-pick pass (`frameState.pickingMetadata`) AND only
      // for a metadata-bearing, non-classifier primitive. The
      // `selectCommandVariant` dispatcher returns this command from
      // `derivedCommands.pickingMetadata.pickMetadataCommand` when
      // `frameState.pickingMetadata` is set. It reuses the SAME bind groups +
      // vertex buffers + index buffer as the color/pick command (no new pipeline
      // layout); only the pipeline (its fragment writes the metadata RGBA) and
      // the prepended GENERATED metadata-pick chunk differ. Gated tightly so a
      // normal render / regular pick pass is byte-identical (the block is never
      // entered unless pickMetadata is actively running).
      const pickedMetadataInfo = frameState.pickedMetadataInfo;
      const primitiveHasMetadata =
        (primCache.materialDefines &
          (ShaderDefine.MODEL_HAS_METADATA |
            ShaderDefine.MODEL_HAS_PROPERTY_TEXTURES |
            ShaderDefine.MODEL_HAS_PROPERTY_TABLES)) !==
        0;
      if (
        frameState.pickingMetadata === true &&
        defined(pickedMetadataInfo) &&
        primitiveHasMetadata &&
        !isClassifier &&
        defined(glTFPrimitive) &&
        defined(primCache._metadataWGSL)
      ) {
        const pickWGSL = generateMetadataPickWGSL(
          model,
          glTFPrimitive,
          pickedMetadataInfo.propertyName,
          runtimeNode,
        );
        if (defined(pickWGSL)) {
          // Publish the pick chunk + its (property-folded) hash so the pipeline
          // cache prepends it + keys the pick module per picked property.
          pipelineCache.setMetadataPickWGSL(pickWGSL.wgsl, pickWGSL.classHash);
          const pickMetadataPipeline = pipelineCache.getPickMetadataPipeline(
            matInfo.alphaMode,
            matInfo.isDoubleSided,
            primCache.materialDefines | 0,
          );
          const pickMetadataCmd = new WebGPUDrawCommand({
            bindGroups: [
              nodeCameraBG,
              mergedMaterialBG,
              mergedInstanceBG,
              cache.effectsBG,
            ],
            vertexBuffers: vertexBuffers,
            indexBuffer: primCache.indexBuffer || undefined,
            indexCount: primCache.indexCount || 0,
            indexFormat: primCache.indexFormat || "uint16",
            vertexCount: primCache.vertexCount || 0,
            instanceCount: instanceCount,
            pass: primaryPass,
            owner: model,
            boundingVolume: commandBoundingVolume,
            modelMatrix: modelMatrix,
            cull: model._cull ?? true,
            renderState: modelRenderState,
            pickOnly: true,
            pipeline: pickMetadataPipeline,
          });
          attachPickMetadataToColorCommand(webgpuCmd, pickMetadataCmd);
        }
      }

      // TAA Slice 2e (Batch 106) — velocity command derivation. When
      // TAA is on (frameState.taaEnabled), attach a velocity-only draw
      // command alongside the color command. The SceneRenderer's
      // velocity pass (`_runVelocityPass`) walks the frustum command
      // lists, picks any command carrying a `.velocityCommand` slot,
      // and dispatches it into a single-target rg16float render pass
      // sharing scene depth read-only. Reuses the color command's
      // bind groups, vertex buffers, index buffer, and instance count
      // — the only differences are the pipeline (velocity variant)
      // and the absence of blend / depth-write state. Materialized
      // ONCE per primitive per frame.
      //
      // Translucent (BLEND) primitives skip velocity emission for now —
      // they don't write scene depth in the color pass, so the
      // velocity pass's read-only depth attachment can't establish
      // visibility for them. A future follow-up could route translucent
      // velocity through OIT-style accumulation, but that needs more
      // architectural work (the rg16float resolve target doesn't
      // accumulate cleanly with src-alpha blending).
      if (
        motionEnabled &&
        matInfo.alphaMode !== AlphaModes.BLEND &&
        !isClassifier
      ) {
        if (!defined(primCache.velocityPipeline)) {
          primCache.velocityPipeline = pipelineCache.getVelocityPipeline(
            matInfo.alphaMode,
            matInfo.isDoubleSided,
            // Batch 174 — velocity pipeline must use the same
            // per-variant pipeline layout as the color pipeline so it
            // pairs with the same merged group-1 bind group at draw time.
            primCache.materialDefines | 0,
          );
        }
        const velocityCmd = new WebGPUDrawCommand({
          pipeline: primCache.velocityPipeline,
          bindGroups: [
            nodeCameraBG, // B.8 (Batch 152) — per-runtime-node camera BG
            mergedMaterialBG,
            mergedInstanceBG,
            cache.effectsBG,
          ],
          vertexBuffers: vertexBuffers,
          indexBuffer: primCache.indexBuffer || undefined,
          indexCount: primCache.indexCount || 0,
          indexFormat: primCache.indexFormat || "uint16",
          vertexCount: primCache.vertexCount || 0,
          instanceCount: instanceCount,
          pass: primaryPass,
          owner: model,
          boundingVolume: commandBoundingVolume,
          modelMatrix: modelMatrix,
          cull: model._cull ?? true,
          renderState: modelRenderState,
        });
        webgpuCmd.velocityCommand = velocityCmd;
      }

      // C-R8-EDGE-DISPLAY-MODE (§5 P2) — EDGES_ONLY suppresses the
      // surface command for edge-bearing primitives so only the edge
      // pass renders (CAD wireframe). Mirrors WebGL's early-return in
      // `ModelDrawCommand.pushCommands` (`ModelDrawCommand.js:187-192`)
      // which skips `_originalCommand` while still pushing the edge
      // command via `pushEdgeCommands`. The edge emitter below is still
      // reached (it gates separately on the same mode). Velocity / pick
      // variants attached to `webgpuCmd` ride along on the un-pushed
      // command and are harmless. The `isClassifier` second-pass block
      // below never coincides with this (classifiers don't emit edges).
      if (!suppressSurfaceForEdgesOnly) {
        commandList.push(webgpuCmd);
      }

      // C-MODEL-2DIDL-DUPLICATE — emit the wrapped copy of the surface command
      // (WebGL `derive2DCommand`). Same pipeline / material / instance / effects
      // bind groups and geometry as the primary command; only @group(0) (the
      // camera UB) is swapped for the y-shifted one and the bounding volume is
      // moved to match, so the half of the model clipped by one 2D viewport is
      // drawn in the other. `idlDuplicateActive` is only ever true in SCENE2D
      // for an IDL-crossing non-projectTo2D model, so this block is skipped
      // (and no resources allocated) for every other model/mode.
      if (
        idlDuplicateActive &&
        nodeIdlCameraBG !== null &&
        !suppressSurfaceForEdgesOnly
      ) {
        const idlBindGroups = webgpuCmdArgs.bindGroups.slice();
        idlBindGroups[0] = nodeIdlCameraBG;
        const idlCmd = new WebGPUDrawCommand({
          ...webgpuCmdArgs,
          bindGroups: idlBindGroups,
          boundingVolume: nodeIdlBoundingSphere2D,
          modelMatrix: nodeIdlModelMatrix2D,
        });
        commandList.push(idlCmd);
      }

      // AUDIT_2026_05_02 A.3 (Batch 146) — for `classificationType: BOTH`
      // emit a SECOND command targeting the second pass. Same args as
      // the primary command except the `pass` field. Both commands share
      // the same pipeline / bind groups / vertex buffers — the renderer
      // already computed those for the primary command and they're
      // identical for the second pass (depth-sample classifier doesn't
      // distinguish TERRAIN vs 3D Tile in its pipeline state, only in
      // the pass enum the dispatcher routes through).
      if (isClassifier && drawPasses.length > 1) {
        for (let p = 1; p < drawPasses.length; p++) {
          const extraCmd = new WebGPUDrawCommand({
            ...webgpuCmdArgs,
            pass: drawPasses[p],
          });
          commandList.push(extraCmd);
        }
      }

      // AUDIT_2026_05_02 A.8 (Batch 142, NEW-MODEL-AS-CLASSIFIER) —
      // when the model is a classifier, we've already pushed the
      // classification command(s). The remaining variants (tile-batch
      // dual command, translucent depth-write, edge emitter) don't
      // apply: classifiers don't pick (no pick FBO entry needed —
      // ClassificationModelDrawCommand on WebGL also skips pick),
      // they don't emit velocity (no TAA on classified content),
      // and they don't run the edge stage (the classifier FS is a
      // depth-sample emit, not the lit PBR FS that hosts the edge
      // overlay). Skip the rest of this primitive's emission.
      if (isClassifier) {
        continue;
      }

      // WIRE-MODEL-SILHOUETTE — derived silhouette-colour command (WebGL
      // `deriveSilhouetteColorCommand` parity). Uses a SEPARATE material
      // UB so the base command keeps `_pad_tt2 = 0` (normal shading,
      // stencil write) while this one carries `_pad_tt2 = 1` (VS inflates
      // clip xy along the eye-space normal, FS emits silhouetteColor) —
      // the same one-shader-two-uniform-states trick WebGL uses via its
      // `model_silhouettePass` uniform clone. The pipeline's stencil
      // NOT-EQUAL test (against the same per-draw reference the base
      // command stamped) cuts the model body out of the inflated draw so
      // only the rim survives. Follows the batch-table translucent-class
      // second-UB precedent below. EDGES_ONLY suppresses the surface —
      // and therefore its rim. During pick passes the command is skipped
      // by the FORK-34 gate (no pick variant, not pickOnly), matching
      // WebGL's `hasSilhouette && !passes.pick`.
      if (modelHasSilhouette && !suppressSurfaceForEdgesOnly) {
        if (!defined(primCache.materialBufferSilhouette)) {
          primCache.materialBufferSilhouette = WebGPUBuffer.createUniformBuffer(
            device,
            MATERIAL_UNIFORM_SIZE,
            `Prim material (silhouette)`,
          );
          primCache.materialDataSilhouette = new Float32Array(
            MATERIAL_UNIFORM_SIZE / 4,
          );
        }
        const silData = primCache.materialDataSilhouette;
        // Mirror the primary UB byte-for-byte (it already carries this
        // frame's flags / split / model-color lanes), then stamp the
        // silhouette lanes on top.
        silData.set(primCache.materialData);
        // No real NORMAL attribute → no inflation (WebGL strips the
        // stage via `#ifndef HAS_NORMALS`); zero expand keeps the WGSL
        // helper's early-return path NaN-free.
        const silhouetteHasNormals = defined(primCache.normalBuffer);
        silData[105] = silhouetteHasNormals ? silhouetteExpandX : 0.0;
        silData[106] = silhouetteHasNormals ? silhouetteExpandY : 0.0;
        silData[107] = 1.0; // silhouette-pass flag
        const silColor = model.silhouetteColor;
        silData[112] = silColor.red;
        silData[113] = silColor.green;
        silData[114] = silColor.blue;
        silData[115] = silColor.alpha;
        device.queue.writeBuffer(
          primCache.materialBufferSilhouette.buffer,
          0,
          silData.buffer,
          0,
          MATERIAL_UNIFORM_SIZE,
        );

        // Render the rim in the translucent pass if either the base
        // command or the silhouette colour is translucent (WebGL parity).
        const silhouettePassTranslucent =
          matInfo.alphaMode === AlphaModes.BLEND || silhouetteTranslucent;
        if (!defined(primCache.silhouetteColorPipeline)) {
          primCache.silhouetteColorPipeline =
            pipelineCache.getSilhouetteColorPipeline(
              matInfo.alphaMode,
              matInfo.isDoubleSided,
              primCache.materialDefines | 0,
              silhouettePassTranslucent,
            );
        }
        const mergedMaterialBGSilhouette = getOrCreateMergedMaterialBindGroup(
          primCache,
          MERGED_MATERIAL_SLOT_SILHOUETTE,
          device,
          pipelineCache,
          primCache.materialBufferSilhouette,
          primCache.lightBuffer,
          primCache.textureEntries,
          featureIdEntries,
          iblEntries,
          primCache.materialDefines | 0,
          frameState,
        );
        const silhouetteCmd = new WebGPUDrawCommand({
          pipeline: primCache.silhouetteColorPipeline,
          bindGroups: [
            nodeCameraBG,
            mergedMaterialBGSilhouette,
            mergedInstanceBG,
            cache.effectsBG,
          ],
          vertexBuffers: vertexBuffers,
          indexBuffer: primCache.indexBuffer || undefined,
          indexCount: primCache.indexCount || 0,
          indexFormat: primCache.indexFormat || "uint16",
          vertexCount: primCache.vertexCount || 0,
          instanceCount: instanceCount,
          pass: silhouettePassTranslucent ? Pass.TRANSLUCENT : primaryPass,
          owner: model,
          boundingVolume: commandBoundingVolume,
          modelMatrix: modelMatrix,
          cull: model._cull ?? true,
          // Stencil reference for the NOT-EQUAL cutout — same value the
          // base command stamped. WebGL also drops castShadows /
          // receiveShadows on the derived command; WebGPU shadow-cast
          // tagging is simply not attached here.
          renderState: { stencilTest: { reference: silhouetteStencilRef } },
        });
        silhouetteColorCommands.push(silhouetteCmd);
      }

      // C-R1-TILE-BATCH (Batch 101) — dual-command emission. When the
      // primary command class is opaque (passClass === 0) AND the
      // primitive has a batch table active, also emit a TRANSLUCENT-
      // class derived command so per-feature styling can flip
      // individual features to translucent without pipeline state
      // changes. Mirrors WebGL's `deriveTranslucentCommand` at
      // `Cesium3DTileBatchTable.js:497`. The FS uses
      // `material.tileBatchFlags.x` (passClass) to discard the wrong-
      // class features at each pass — see the WGSL gate added in
      // Batch 100. Uses a SEPARATE material UB so the two commands
      // can hold passClass = 0 / passClass = 1 independently without
      // a per-frame second writeBuffer collision.
      const hasBatchTable =
        defined(featureIdRes) &&
        (featureIdRes.flags & MaterialFlags.HAS_BATCH_TABLE) !== 0;
      // C-R8-EDGE-DISPLAY-MODE (§5 P2) — the dual translucent-class
      // command is a SURFACE derivative (per-feature styling of the same
      // geometry), so EDGES_ONLY must suppress it alongside the primary
      // surface command above; otherwise the surface would still render
      // through the batch-table styling path in wireframe mode.
      if (passClass === 0 && hasBatchTable && !suppressSurfaceForEdgesOnly) {
        if (!defined(primCache.materialBufferTranslucent)) {
          primCache.materialBufferTranslucent =
            WebGPUBuffer.createUniformBuffer(
              device,
              MATERIAL_UNIFORM_SIZE,
              `Prim material (translucent class)`,
            );
          primCache.materialDataTranslucent = new Float32Array(
            MATERIAL_UNIFORM_SIZE / 4,
          );
          // NEW-BG-CONSOLIDATION (Batch 122) — the translucent-class
          // material UB is an alternate buffer; the merged group 1 BG
          // for this pass is built per-frame at the draw command site
          // below using `materialBufferTranslucent` instead of the
          // primary `materialBuffer`.
        }
        // Pack with passClass=1 (the only field that differs from the
        // primary). Re-running the full packer is the simplest path —
        // costs ~768 B/frame extra writeBuffer per batch-table primitive,
        // negligible vs. the per-fragment savings of correct classification.
        packMaterialUniforms(
          primCache.materialDataTranslucent,
          modelMatrix,
          matInfo,
          primHasSkinning,
          primHasMorphTargets,
          pickColor,
          cache.prevModelMatrix,
          motionEnabled,
          1, // passClass = translucent
        );
        // WIRE-MODEL-SPLITTER — mirror the primary UB's split-scalar pad
        // lanes (floats 38/39 = _pad_end2/_pad_end3); packMaterialUniforms
        // just zeroed them, so without this the derived translucent-class
        // command of a split batch-table model would render unsplit.
        primCache.materialDataTranslucent[38] = modelSplitDirection;
        primCache.materialDataTranslucent[39] = modelSplitPositionPx;
        // WIRE-MODEL-COLOR — mirror the primary UB's model-colour lanes
        // (floats 184-187 = _pad_reserved8, float 175 = motionFlags.w);
        // packMaterialUniforms just zeroed them, so without this the
        // derived translucent-class command of a coloured batch-table
        // model would render untinted.
        if (modelHasColor) {
          primCache.materialDataTranslucent[175] = modelColorBlend;
          primCache.materialDataTranslucent[184] = modelColor.red;
          primCache.materialDataTranslucent[185] = modelColor.green;
          primCache.materialDataTranslucent[186] = modelColor.blue;
          primCache.materialDataTranslucent[187] = modelColor.alpha;
        }
        // Mirror the post-pack instancing / featureId flag patch from
        // the primary buffer so the translucent UB observes the same
        // FLAG_HAS_INSTANCING / FLAG_HAS_FEATURE_ID_* / FLAG_HAS_BATCH_TABLE
        // bits the FS gates the dual-discard branch on.
        {
          const flagsView = new DataView(
            primCache.materialDataTranslucent.buffer,
            primCache.materialDataTranslucent.byteOffset,
          );
          let currentFlags = flagsView.getUint32(28 * 4, true);
          if (hasInstancing && instanceCount > 1) {
            currentFlags |= FLAG_HAS_INSTANCING;
          }
          if (defined(featureIdRes)) {
            currentFlags |= featureIdRes.flags;
          }
          flagsView.setUint32(28 * 4, currentFlags, true);
        }
        device.queue.writeBuffer(
          primCache.materialBufferTranslucent.buffer,
          0,
          primCache.materialDataTranslucent.buffer,
          0,
          MATERIAL_UNIFORM_SIZE,
        );

        // Translucent-pass pipeline: BLEND alphaMode regardless of the
        // primary's mode so the second draw composites properly.
        if (!defined(primCache.translucentPipeline)) {
          primCache.translucentPipeline = pipelineCache.getPipeline(
            AlphaModes.BLEND,
            matInfo.isDoubleSided,
            // Batch 174 — translucent dual-command pipeline shares the
            // same per-variant materialBGL as the primary so the
            // mergedMaterialBGTranslucent below validates against it.
            primCache.materialDefines | 0,
          );
        }
        // NEW-BG-CONSOLIDATION (Batch 122) — translucent-class merged
        // group 1 BG. Same shape as the primary `mergedMaterialBG` but
        // with the alternate `materialBufferTranslucent` instead.
        const mergedMaterialBGTranslucent = getOrCreateMergedMaterialBindGroup(
          primCache,
          MERGED_MATERIAL_SLOT_TRANSLUCENT,
          device,
          pipelineCache,
          primCache.materialBufferTranslucent,
          primCache.lightBuffer,
          primCache.textureEntries,
          featureIdEntries,
          iblEntries,
          primCache.materialDefines | 0,
          frameState,
        );
        const translucentCmd = new WebGPUDrawCommand({
          pipeline: primCache.translucentPipeline,
          bindGroups: [
            nodeCameraBG, // B.8 (Batch 152) — per-runtime-node camera BG
            mergedMaterialBGTranslucent,
            mergedInstanceBG,
            cache.effectsBG,
          ],
          vertexBuffers: vertexBuffers,
          indexBuffer: primCache.indexBuffer || undefined,
          indexCount: primCache.indexCount || 0,
          indexFormat: primCache.indexFormat || "uint16",
          vertexCount: primCache.vertexCount || 0,
          instanceCount: instanceCount,
          pass: Pass.TRANSLUCENT,
          owner: model,
          boundingVolume: commandBoundingVolume,
          modelMatrix: modelMatrix,
          cull: model._cull ?? true,
          renderState: modelRenderState,
        });
        // AUDIT_2026_05_02 B.7 — Batch 79's selective depth-write fix
        // previously only fired for tile-owned models (Cesium3DTile.js sets
        // `depthForTranslucentClassification = true`). Standalone Models —
        // including any glTF added via `viewer.scene.primitives.add(...)` and
        // any Model used as a classifier — also need the depth-write variant
        // so `pickPosition` and ground/Vector3DTile classifiers don't see
        // through them. Opt-in via `model.depthWriteForTranslucentPicking`
        // (default false to preserve existing performance), or
        // automatically when `model.classificationType !== undefined`.
        if (
          primCache.depthWritePipeline &&
          (model.depthWriteForTranslucentPicking === true ||
            defined(model.classificationType))
        ) {
          translucentCmd.depthForTranslucentClassification = true;
          translucentCmd.classificationDepthPipeline =
            primCache.depthWritePipeline;
        }
        commandList.push(translucentCmd);
      }

      // C-R8-EDGE-EMITTER (Batch 45) — Emit edge visibility commands
      // for primitives that carry `EXT_mesh_primitive_edge_visibility`
      // data. The edges render into the WebGPUEdgeFramebuffer MRT via
      // the redirect in `WebGPUSceneRenderer._execute3DTilePasses`,
      // and the Batch 44 composite overlays them onto scene color.
      //
      // Resources are built once per primitive and reused across
      // frames; per-frame cost is two `writeBuffer` calls for the
      // camera + edge uniform UBs. Primitives without edge data skip
      // the whole block (the `extractEdgeGeometry` early-returns).
      //
      // C-R8-EDGE-DISPLAY-MODE (§5 P2) — gate the whole emitter on
      // `edgeDisplayMode !== SURFACES_ONLY`. SURFACES_ONLY is the DEFAULT
      // (`EdgeDisplayMode.js:26`, `Model.js:437-438`), so until the host
      // app opts into SURFACES_AND_EDGES / EDGES_ONLY, extension edges
      // are fully suppressed — matching WebGL's early-return in
      // `ModelDrawCommand.pushEdgeCommands` (`ModelDrawCommand.js:245-248`).
      // Previously this gated only on `defined(edgeVisibility)`, so edges
      // always drew regardless of the mode (the SURFACES_ONLY regression
      // this batch fixes).
      const edgeGltfPrimitive = rp.primitive || rp._primitive;
      if (
        defined(edgeGltfPrimitive?.edgeVisibility) &&
        edgeDisplayMode !== EdgeDisplayMode.SURFACES_ONLY
      ) {
        if (!defined(cache.edgeEmitterCache)) {
          cache.edgeEmitterCache = createEdgeEmitterCache();
        }
        const sceneSampleCount = context._msaaSamples ?? 1;
        const sceneColorFormat = context._sceneColorFormat ?? "bgra8unorm";
        ensureEdgeEmitterPipeline(
          cache.edgeEmitterCache,
          device,
          sceneColorFormat,
          sceneSampleCount,
        );

        // Build per-primitive edge buffers lazily. If the primitive's
        // edge data hasn't been extracted yet, do it now; otherwise
        // reuse the cached GPUBuffers.
        if (!defined(primCache.edgeResources)) {
          // C-R8-EDGE-FEATURE-ID — pull per-vertex feature IDs from the
          // glTF FEATURE_ID_0 attribute when present. Mirrors the
          // WebGL edge stage at `EdgeVisibilityPipelineStage.js:1242-
          // 1281` (lookup by `featureIds[0].setIndex` → matching
          // `attributes` entry → `typedArray`). When absent, the
          // emitter falls back to writing 0 in id.g and the consumer's
          // gate stays off.
          let edgeFeatureIdData = null;
          const fidSets = edgeGltfPrimitive.featureIds;
          if (defined(fidSets) && fidSets.length > 0) {
            const fidSet = fidSets[0];
            if (
              defined(fidSet?.setIndex) &&
              defined(edgeGltfPrimitive.attributes)
            ) {
              const fidAttr = edgeGltfPrimitive.attributes.find(
                (attr: {
                  semantic?: string;
                  name?: string;
                  typedArray?:
                    Uint8Array | Uint16Array | Uint32Array | Float32Array;
                  [key: string]: unknown;
                }) =>
                  attr.semantic === "_FEATURE_ID" ||
                  (attr.name && attr.name.startsWith("_FEATURE_ID_")),
              );
              if (defined(fidAttr) && defined(fidAttr.typedArray)) {
                edgeFeatureIdData = fidAttr.typedArray;
              }
            }
          }
          // NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU — pass per-vertex
          // COLOR_0 (as normalized RGBA) so the emitter can resolve
          // per-edge colors the same way WebGL does (override →
          // vertex color → no-override sentinel). The primitive-level
          // and per-lineString `materialColor` overrides are read inside
          // `extractEdgeGeometry` directly off the edgeVisibility object.
          let edgeVertexColors = null;
          if (geometry.hasColor0 && defined(geometry.color0Data)) {
            const colorFloat = normalizeColorData(
              geometry.color0Data,
              geometry.color0ComponentType,
              geometry.color0Normalized,
            );
            const components = geometry.color0ComponentCount ?? 4;
            edgeVertexColors = expandColorsToRGBA(
              colorFloat as Float32Array,
              components,
              geometry.vertexCount,
            );
          }
          const edgeGeom = extractEdgeGeometry(
            edgeGltfPrimitive as unknown as Parameters<
              typeof extractEdgeGeometry
            >[0],
            geometry.positionData,
            edgeFeatureIdData as unknown as Parameters<
              typeof extractEdgeGeometry
            >[2],
            edgeVertexColors,
          );
          if (defined(edgeGeom)) {
            primCache.edgeResources = createEdgePrimitiveResources(
              device,
              cache.edgeEmitterCache,
              edgeGeom,
            );
            // Track per-primitive whether feature IDs were populated;
            // the model-FS effects bind group reads this through the
            // model-level rollup (`cache.hasEdgeFeatureIds`) to flip
            // the inline detection's per-feature gate.
            if (primCache.edgeResources) {
              primCache.edgeResources.hasFeatureIds = !!edgeGeom.hasFeatureIds;
              if (edgeGeom.hasFeatureIds) {
                cache.hasEdgeFeatureIds = true;
              }
            }
          } else {
            // Mark this primitive as having no edges so we don't
            // re-extract every frame. Use `false` as a sentinel
            // distinct from `undefined` (meaning "not yet checked").
            primCache.edgeResources = false;
          }
        }

        if (primCache.edgeResources) {
          // Compute MVP = projection * view * nodeModelMatrix and
          // MV = view * nodeModelMatrix. Use the NODE-level matrix (the SAME
          // one the surface packs via packCameraUniforms) — NOT the model-
          // level `modelMatrix`. Edge positions are model-space, so for a glTF
          // whose node carries a scale (the EXT_mesh_primitive_edge_visibility
          // sample's ~1e4 model-space coords scale ~0.0012 to world) the
          // model-level matrix omits that scale and projects every edge ~1e4 m
          // off-screen — the EDGES_ONLY non-render the 14-batch review
          // surfaced. RTE still isn't applied (fine at typical distances).
          const us = context.uniformState;
          const vp = us?.viewProjection;
          const view = us?.view;
          let mvp;
          if (defined(vp)) {
            mvp = Matrix4.multiply(vp, nodeModelMatrix, scratchEdgeMVP);
          } else {
            mvp = Matrix4.clone(nodeModelMatrix, scratchEdgeMVP);
          }
          const mvpData = Matrix4.toArray(mvp, scratchEdgeMVPArray);

          let mv;
          if (defined(view)) {
            mv = Matrix4.multiply(view, nodeModelMatrix, scratchEdgeMV);
          } else {
            mv = Matrix4.clone(nodeModelMatrix, scratchEdgeMV);
          }
          const mvData = Matrix4.toArray(mv, scratchEdgeMVArray);

          // Edge color: this uniform is now the FALLBACK surface color used
          // only when an edge writes the `a_edgeColor.a < 0` "no override"
          // sentinel. The per-primitive `materialColor`, per-lineString
          // `materialColor`, and per-vertex COLOR_0 overrides are now carried
          // per-edge in the @location(7) vertex attribute
          // (NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU), matching WebGL's
          // `a_edgeColor`. So this fallback is just the model's base color
          // (WebGL's FS keeps the surface/fragment color when no per-edge
          // override is authored — NOT black — see
          // EdgeVisibilityStageFS.glsl:32-36).
          const mc = model.color;
          const edgeColor = {
            r: mc?.red ?? 1.0,
            g: mc?.green ?? 1.0,
            b: mc?.blue ?? 1.0,
            a: mc?.alpha ?? 1.0,
          };

          // Viewport for NDC→pixel offset math in the wide-line VS.
          const vpW = context.drawingBufferWidth ?? 1;
          const vpH = context.drawingBufferHeight ?? 1;
          // Line width: prefer the model's per-edge override if it
          // ever lands on the model object; default to 2 px for a
          // visibly-non-degenerate edge regardless of DPR.
          const lineWidth = model._edgeLineWidth ?? 2.0;
          // Line pattern: 0xffff = solid. Per-model override slot
          // ready for `_edgeLinePattern` to land later.
          const linePattern = (model._edgeLinePattern ?? 0xffff) & 0xffff;

          writeEdgeEmitterUniforms(
            device,
            primCache.edgeResources as EdgePrimitiveResources,
            mvpData as unknown as Float32Array,
            mvData as unknown as Float32Array,
            edgeColor,
            vpW,
            vpH,
            lineWidth,
            linePattern,
          );

          // Session 65 Batch 13 (NEW-VR-DEPTHPLANE-EDGEEMITTER-
          // PIPELINE-FORMAT) — pick the MRT pipeline when the scene's
          // edge framebuffer redirect is active, otherwise the
          // single-target variant so edges draw safely onto the
          // regular 1-attachment scene framebuffer. Tracks
          // `scene._enableEdgeVisibility` (the same flag that gates
          // `_edgeFramebuffer` allocation in
          // `WebGPUSceneRendererEnsureResources`). The transient
          // "_enableEdgeVisibility flipped on this frame but the FBO
          // hasn't finished allocating yet" race resolves naturally:
          // the 3D-tile dispatcher falls back to the scene FB pass
          // when `edgeFB.isReady` is false (see
          // `WebGPUSceneRenderer3DTilePasses.ts:185`), and since the
          // pipeline was selected for the MRT layout, the validation
          // catches it. The fallback isn't visually critical (one
          // frame of clipped edges on toggle); the pipeline mismatch
          // we ARE fixing is the steady-state case where edge
          // visibility is off entirely.
          const sceneForEdge = frameState?.scene;
          const edgeVisibilityOn = sceneForEdge?._enableEdgeVisibility === true;

          // C-R8-EDGE-DISPLAY-MODE (§5 P2) — pick the destination pass +
          // pipeline by mode. Mirrors WebGL's
          // `ModelDrawCommand.pushEdgeCommands` (`ModelDrawCommand.js:250-
          // 257`):
          //   - EDGES_ONLY → `CESIUM_3D_TILE_EDGES_DIRECT` (Pass slot 12).
          //     The DIRECT pass renders straight onto the SCENE
          //     framebuffer (1 color attachment), so it ALWAYS uses the
          //     single-target pipeline regardless of `_enableEdgeVisibility`
          //     — the MRT pipeline's 3 color targets would mismatch the
          //     scene render pass's single attachment and fail validation.
          //   - SURFACES_AND_EDGES → `CESIUM_3D_TILE_EDGES` (Pass slot 4):
          //     keep the existing MRT-vs-single selection (MRT when the
          //     edge FBO is allocated, single-target as the fallback the
          //     3D-tile dispatcher runs on the scene FB).
          // (SURFACES_ONLY never reaches here — the emitter is gated off
          // above.)
          const edgesOnly = edgeDisplayMode === EdgeDisplayMode.EDGES_ONLY;
          const edgePass = edgesOnly
            ? Pass.CESIUM_3D_TILE_EDGES_DIRECT
            : Pass.CESIUM_3D_TILE_EDGES;
          const edgePipeline =
            edgeVisibilityOn && !edgesOnly
              ? cache.edgeEmitterCache.pipeline
              : cache.edgeEmitterCache.pipelineSingleTarget;
          const edgeCmd = new WebGPUDrawCommand({
            pipeline: edgePipeline,
            bindGroups: [
              primCache.edgeResources.cameraBG,
              primCache.edgeResources.edgeBG,
            ],
            vertexBuffers: [primCache.edgeResources.vertexBuffer],
            indexBuffer: primCache.edgeResources.indexBuffer,
            indexCount: primCache.edgeResources.indexCount,
            indexFormat: "uint32",
            instanceCount: 1,
            pass: edgePass,
            owner: model,
            boundingVolume: commandBoundingVolume,
            modelMatrix: modelMatrix,
            cull: model._cull ?? true,
          });
          commandList.push(edgeCmd);
        }
      }
    }

    // NEW-MODEL-NODE-TRANSFORMS-PREV (Batch 175) — capture THIS frame's
    // `nodeModelMatrix` into the per-node cache slot so the NEXT frame's
    // pack reads it as `prev`. Mirrors the model-level capture at the
    // end of `update()`. Only fires for non-identity nodes (identity
    // nodes share `cache.prevModelMatrix`); the slot lives on the
    // already-allocated `cache.nodes[nodeIdx]` (Batch 152 NEW-MODEL-
    // NODE-TRANSFORMS allocation). Clones the scratch matrix because
    // `scratchNodeModelMatrix` is reused across nodes per frame.
    if (!transformIsIdentity && defined(cache.nodes[nodeIdx])) {
      const ncForPrev = cache.nodes[nodeIdx];
      if (!defined(ncForPrev.prevNodeModelMatrix)) {
        ncForPrev.prevNodeModelMatrix = Matrix4.clone(nodeModelMatrix);
      } else {
        Matrix4.clone(nodeModelMatrix, ncForPrev.prevNodeModelMatrix);
      }
    }
  }

  // WIRE-MODEL-SILHOUETTE — push the derived silhouette-colour commands
  // AFTER every base command of this model (WebGL
  // `ModelSceneGraph.pushDrawCommands` gathers them separately and
  // appends for the same reason: the rim must not draw on top of the
  // model's own later primitives before those have stamped stencil).
  for (let i = 0; i < silhouetteColorCommands.length; i++) {
    commandList.push(silhouetteColorCommands[i]);
  }

  // TAA Slice 2c (Batch 96) — capture this frame's modelMatrix as
  // `prevModelMatrix` so the next frame's primitive pack reads the
  // correct previous value. Done at the END of update so every
  // primitive saw the same prev-frame value during its pack call.
  // For static models the value never changes; for animated entities
  // (transforms updated by the host app each frame) the per-frame
  // delta drives the per-pixel velocity output gated on
  // `frameState.taaEnabled`.
  if (!defined(cache.prevModelMatrix)) {
    cache.prevModelMatrix = Matrix4.clone(modelMatrix);
  } else {
    Matrix4.clone(modelMatrix, cache.prevModelMatrix);
  }
}

// Scratch matrices for the edge-emitter MVP/MV build (avoids per-
// primitive allocation inside the hot loop).
const scratchEdgeMVP = new Matrix4();
const scratchEdgeMVPArray = new Float32Array(16);
const scratchEdgeMV = new Matrix4();
const scratchEdgeMVArray = new Float32Array(16);

/**
 * Destroys cached WebGPU resources for a Model.
 */
/**
 * Destroys one primitive cache slot's GPU resources (vertex/index/material
 * buffers, created textures, morph/featureId/metadata/edge resources).
 * Shared by full-model teardown ({@link destroyWebGPUModelResources}) and the
 * METADATA-TABLE-SOURCES late-metadata rebuild path (a primitive whose
 * structural-metadata resolution materializes AFTER its cache froze a
 * metadata-less pipeline variant is destroyed + rebuilt in place).
 *
 * @param {object|undefined} pc per-primitive cache slot
 * @private
 */
function destroyPrimitiveCacheResources(pc: PrimitiveRenderData | undefined) {
  if (!defined(pc)) {
    return;
  }

  // Bind groups do not have an explicit destroy operation. Release the cache
  // record before destroying any of the buffers it references.
  pc._mergedInstanceBindGroupCache = undefined;
  // C9-17 Slice A — release the merged group-1 records too; a late-metadata
  // rebuild (METADATA-TABLE-SOURCES) destroys+recreates the material buffers,
  // so the cached bind groups must drop their now-dangling buffer references.
  pc._mergedMaterialBindGroupCache = undefined;
  pc._mergedMaterialBindGroupCacheSilhouette = undefined;
  pc._mergedMaterialBindGroupCacheTranslucent = undefined;

  pc.positionBuffer?.destroy();
  pc.positionBuffer2D?.destroy();
  pc.normalBuffer?.destroy();
  pc.tangentBuffer?.destroy();
  pc.uvBuffer?.destroy();
  pc.uv1Buffer?.destroy();
  pc.colorBuffer?.destroy();
  pc.jointsBuffer?.destroy();
  pc.weightsBuffer?.destroy();
  pc.featureIdBuffer?.destroy();
  pc.indexBuffer?.destroy();
  pc.materialBuffer?.destroy();
  // C-R1-TILE-BATCH — translucent-class alternate material UB.
  pc.materialBufferTranslucent?.destroy();
  // WIRE-MODEL-SILHOUETTE — silhouette-pass alternate material UB.
  pc.materialBufferSilhouette?.destroy();
  pc.lightBuffer?.destroy();

  // Destroy created GPU textures (not default ones)
  for (const tex of pc.gpuTextures) {
    tex?.destroy();
  }

  // Destroy morph target resources
  destroyMorphTargetResources(pc);

  // Destroy feature ID resources
  destroyFeatureIdResources(pc);

  // DP-H46a — destroy metadata GPU resources (slot-9 vertex buffer).
  destroyMetadataResources(pc);

  // C-R8-EDGE-EMITTER (Batch 45) — destroy per-primitive edge
  // buffers. `edgeResources === false` is the sentinel for
  // "primitive had no edges"; skip in that case.
  if (pc.edgeResources && (pc.edgeResources as unknown) !== false) {
    destroyEdgePrimitiveResources(pc.edgeResources);
  }
}

function destroyWebGPUModelResources(model: ModelLike) {
  const cache = model._webgpuCache;
  if (!defined(cache)) {
    return;
  }

  if (defined(cache.cameraBuffer)) {
    cache.cameraBuffer.destroy();
  }
  if (defined(cache.shadowCastUB)) {
    cache.shadowCastUB.destroy();
    cache.shadowCastUB = undefined;
  }

  // C-R9-MODEL-PICK (Batch 54 / refactored Batch 59) — release every
  // per-primitive pick ID back to the registry so its slot can be reused.
  // No-op if the model never entered a render or pick pass.
  destroyPickIds(cache as unknown as Parameters<typeof destroyPickIds>[0]);

  // Destroy per-primitive resources
  const primKeys = Object.keys(cache.primitives);
  for (let i = 0; i < primKeys.length; i++) {
    destroyPrimitiveCacheResources(cache.primitives[primKeys[i]]);
  }

  // C-R8-EDGE-EMITTER (Batch 45) — destroy the shared edge pipeline
  // cache when the model itself is torn down.
  if (defined(cache.edgeEmitterCache)) {
    destroyEdgeEmitterCache(cache.edgeEmitterCache);
  }

  // Destroy per-node skinning + instancing resources
  const nodeKeys = Object.keys(cache.nodes);
  for (let i = 0; i < nodeKeys.length; i++) {
    const nc = cache.nodes[nodeKeys[i]];
    if (!defined(nc)) {
      continue;
    }
    if (defined(nc.jointBuffer)) {
      nc.jointBuffer.destroy();
    }
    if (defined(nc.prevJointBuffer)) {
      nc.prevJointBuffer.destroy();
    }
    // AUDIT_2026_05_02 B.8 (Batch 152) — release per-node camera buffer.
    if (defined(nc.cameraBuffer)) {
      nc.cameraBuffer.destroy();
    }
    destroyInstancingResources(nc);
  }

  if (defined(cache.pipelineCache)) {
    cache.pipelineCache.destroy();
  }

  model._webgpuCache = undefined;
}

export {
  getOrCreateMergedInstanceBindGroup,
  getOrCreateMergedMaterialBindGroup,
  getOrCreateModelIBLEntries,
  updateWebGPUModel,
  destroyWebGPUModelResources,
};
export default { updateWebGPUModel, destroyWebGPUModelResources };
