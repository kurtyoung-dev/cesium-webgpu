/**
 * Comprehensive WebGPU rendering of glTF Model instances with full PBR support.
 *
 * Architecture:
 * - Model.update() runs the WebGL pipeline stages → populates renderResources
 * - Model.submitDrawCommands() delegates to this renderer via feature renderer
 * - Shared extractors (ModelMaterialInfo, ModelPrimitiveGeometry,
 *   ModelSkinData) supply renderer-agnostic data, from which WebGPU GPU
 *   resources are created
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
import { getWebGPUTextureForDevice } from "./Stubs/WebGLStubTexture.js";
import type { StubTextureWrapper } from "./Stubs/WebGLStubTypes.js";
// The glTF-mode → WebGPU-topology decision lives in a single module. This
// renderer does not know which modes map where; it stores what it is handed.
import { realizeModelPrimitiveTopology } from "./WebGPUModelTopology.js";
import {
  createMaterialInfoView,
  getOrCreateMaterialInfo,
  resetMaterialInfoView,
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
  destroyPerFeaturePickResources,
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
// Native-WGSL customShader codegen, uniform packing, and the shared binding
// numbers both sides agree on.
import {
  generateCustomShaderWGSL,
  packUniformBuffer,
  CUSTOM_SHADER_UBO_BINDING,
  CUSTOM_SHADER_TEXTURE_BINDING_BASE,
  CUSTOM_SHADER_SAMPLER_BINDING,
  MAX_CUSTOM_TEXTURES,
} from "../../Scene/Model/CustomShaderWGSLPipelineStage.js";
// The CustomShader translucency knob that WebGL's CustomShaderPipelineStage
// applies via alphaOptions.pass. Values: INHERIT (0) / OPAQUE (1) /
// TRANSLUCENT (2).
import CustomShaderTranslucencyMode from "../../Scene/Model/CustomShaderTranslucencyMode.js";
// The enum the WebGL model feature renderer consults
// (ModelDrawCommand.pushCommands) to decide whether the per-feature translucent
// twin is needed. Values: ALL_OPAQUE (0) / ALL_TRANSLUCENT (1) /
// OPAQUE_AND_TRANSLUCENT (2).
import StyleCommandsNeeded from "../../Scene/Model/StyleCommandsNeeded.js";
import Pass from "../Pass.js";
import ColorBlendMode from "../../Scene/ColorBlendMode.js";
import SceneMode from "../../Scene/SceneMode.js";
import ShadowMode from "../../Scene/ShadowMode.js";
// Eclipse dimming of model direct lighting is gated on the frame's light being
// the scene sun, exactly as `UniformState` gates its own multiply. `SunLight`
// is a two-import leaf (Color, Frozen), so this cannot introduce a cycle.
import SunLight from "../../Scene/SunLight.js";
// Shared silhouette-ID counter. WebGL's ModelSilhouettePipelineStage assigns
// `model._silhouetteId` from this static counter; on WebGPU the same stage runs
// during the shared scene-graph draw-command build, so the assignment here is
// only a fallback for when the stage has not run yet. Sharing the counter keeps
// stencil references unique across both backends.
import ModelSilhouettePipelineStage from "../../Scene/Model/ModelSilhouettePipelineStage.js";
import EdgeDisplayMode from "../../Scene/EdgeDisplayMode.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import { WebGPUMipmapGenerator } from "./WebGPUMipmapGenerator.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import type { WebGPUPipelineConfig } from "./WebGPUDrawCommand.js";
// Every group-0 block — the camera for the main view, a transformed node, the
// SCENE2D IDL duplicate or an env-capture face, plus the single
// model-and-view-wide light block those cameras pair with — is acquired here.
// Both `cameraBGL` bindings declare `hasDynamicOffset`, so this is the only
// sanctioned producer of a group-0 bind group for the model path.
import {
  MODEL_CAMERA_UNIFORM_BYTES,
  MODEL_LIGHT_UNIFORM_BYTES,
  type ModelCameraArenaAllocator,
  type ModelCameraBinding,
  type ModelViewLightSlice,
  type WebGPUModelCameraArena,
} from "./WebGPUModelCameraArena.js";
import WebGPUModelPipelineCache from "./WebGPUModelPipelineCache.js";
import { createEffectsBindGroup } from "./WebGPUEffectsBindGroup.js";
import { ShaderDefine } from "./WebGPUShaderDefines.js";
import {
  WebGPUModelPreparationDemand,
  classifyWebGPUModelPreparationDemand,
  consumeWebGPUModelPreparationAdmissionGap,
  getWebGPUModelPreparationStatistics,
  markWebGPUModelPreparationRejected,
  recordWebGPUModelPreparationDecision,
} from "./WebGPUModelPreparationAdmission.js";
import {
  CAMERA_LOG_FACTOR_FLOAT,
  CAMERA_LOG_NEAR_FLOAT,
  isWebGPULogDepthActive,
  isWebGPUPickLogDepthActive,
  packCameraLogDepthLanes,
} from "./WebGPULogDepth.js";
import {
  attachPickToColorCommand,
  attachPickVariantsToColorCommand,
  attachSnapToColorCommand,
  attachPickMetadataToColorCommand,
  destroyPickIds,
  ensurePickId,
} from "./WebGPUPickCommandHelpers.js";
import {
  extractEdgeGeometry,
  createEdgeEmitterCache,
  destroyEdgeEmitterCache,
  ensureEdgeEmitterPipeline,
  ensureEdgeEmitterSnapPipeline,
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

// JS-interop typed façades.
// Type-only shapes over the untyped-JS extractor output (ModelMaterialInfo /
// extractPrimitiveGeometry / extractSkinData) and the per-model / per-primitive
// GPU-resource caches this renderer owns. They carry no runtime code, so the
// emitted JavaScript is unaffected by them.

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
    _texture?: StubTextureWrapper | null;
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
  // Byte width of the original glTF index accessor (1 / 2 / 4). Only `1`
  // changes behavior: it tells the topology realization that `0x00FF` entries
  // in `indexData` were `0xFF` primitive-restart sentinels before the
  // extractor's mandatory uint8 → uint16 upcast.
  indexSourceComponentBytes?: number;
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
  materialData?: Float32Array | null;
  materialDataSilhouette?: Float32Array | null;
  materialDataTranslucent?: Float32Array | null;
  materialUploadState?: PackedMaterialUploadState | null;
  materialUploadStateSilhouette?: PackedMaterialUploadState | null;
  materialUploadStateTranslucent?: PackedMaterialUploadState | null;
  _metadataMatTransport: boolean;
  _propertyTextureResources: unknown;
  propertyTextureEntries: GPUBindGroupEntry[] | null;
  _propertyTableResources: unknown;
  propertyTableEntries: GPUBindGroupEntry[] | null;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  vertexCount: number;
  topology: GPUPrimitiveTopology;
  // The strip index format is half the topology axis and travels with it
  // everywhere: pipeline descriptor, pipeline cache key, shadow cast key.
  // `undefined` for every non-strip topology.
  stripIndexFormat: GPUIndexFormat | undefined;
  materialBindGroup: GPUBindGroup | null;
  textureBindGroup: GPUBindGroup | null;
  pipeline: GPUPipelineOrNull;
  depthWritePipeline?: GPUPipelineOrNull;
  pickPipeline?: GPUPipelineOrNull;
  // RGBA32F snap-payload pipeline, allocated only for scenes whose app has
  // called `Scene.snap`.
  snapPipeline?: GPUPipelineOrNull;
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
  _materialBase?: MaterialInfo;
  _materialView?: MaterialInfo;
  _effectiveAlphaMode?: number;
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
  // Merged group-1 (material) bind-group cache, one slot per material-buffer
  // variant so silhouette/translucent never alias the primary.
  _mergedMaterialBindGroupCache?: MergedMaterialBindGroupCache;
  _mergedMaterialBindGroupCacheSilhouette?: MergedMaterialBindGroupCache;
  _mergedMaterialBindGroupCacheTranslucent?: MergedMaterialBindGroupCache;
  // Stable owner for shadow bind groups. Model draw commands are rebuilt each
  // frame, so command-local caches would allocate again every frame.
  _shadowCastBindGroupCacheHost?: Record<string, unknown>;
}

interface MergedMaterialBindGroupCache {
  device: GPUDevice;
  layout: GPUBindGroupLayout;
  materialBuffer: WebGPUBuffer | null;
  textureEntries: GPUBindGroupEntry[] | null | undefined;
  featureIdEntries: GPUBindGroupEntry[] | null | undefined;
  iblEntries: GPUBindGroupEntry[] | null | undefined;
  bindGroup: GPUBindGroup;
}

interface PackedMaterialUploadState {
  currentWords: Uint32Array;
  uploadedWords: Uint32Array;
  uploaded: boolean;
}

interface ModelShadowCastUniformHost {
  shadowCastData?: Float32Array | null;
  shadowCastUB?: WebGPUBuffer | null;
  shadowCastUploadState?: PackedMaterialUploadState;
  shadowCastDevice?: GPUDevice;
}

interface ModelCommandShadowFlags {
  readonly castShadows: boolean;
  readonly receiveShadows: boolean;
}

const disabledModelCommandShadowFlags: ModelCommandShadowFlags = Object.freeze({
  castShadows: false,
  receiveShadows: false,
});
const modelCommandShadowFlagsByMode: readonly ModelCommandShadowFlags[] =
  Object.freeze([
    disabledModelCommandShadowFlags,
    Object.freeze({ castShadows: true, receiveShadows: true }),
    Object.freeze({ castShadows: true, receiveShadows: false }),
    Object.freeze({ castShadows: false, receiveShadows: true }),
  ]);

function getModelCommandShadowFlags(
  shadowMode: number | undefined,
  isClassifier: boolean,
  isColorCommand: boolean,
): ModelCommandShadowFlags {
  if (isClassifier || !isColorCommand) {
    return disabledModelCommandShadowFlags;
  }

  const resolvedMode = shadowMode ?? ShadowMode.ENABLED;
  return (
    modelCommandShadowFlagsByMode[resolvedMode] ??
    disabledModelCommandShadowFlags
  );
}

function getStyledTranslucentModelShadowFlags(
  colorShadowFlags: ModelCommandShadowFlags,
): ModelCommandShadowFlags {
  return colorShadowFlags.receiveShadows
    ? modelCommandShadowFlagsByMode[ShadowMode.RECEIVE_ONLY]
    : disabledModelCommandShadowFlags;
}

function getModelShadowCastLayout(
  primHasSkinning: boolean,
  instanceCount: number,
  hasJointBuffer: boolean,
  hasInstancingBuffer: boolean,
): string | undefined {
  if (primHasSkinning) {
    // A combined skinning + instancing shader does not exist yet. Selecting the
    // skinned-only layout would cast every instance at the same transform.
    return instanceCount === 1 && hasJointBuffer ? "modelSkinned" : undefined;
  }
  if (instanceCount === 1) {
    return "modelP12";
  }
  return instanceCount > 1 && hasInstancingBuffer
    ? "modelInstancedSB"
    : undefined;
}

function isModelShadowPassActive(frameState: CesiumFrameState): boolean {
  return (
    frameState.shadowMaps.length > 0 &&
    frameState.passes.pick !== true &&
    frameState.passes.pickVoxel !== true &&
    frameState.mode === SceneMode.SCENE3D
  );
}

function isModelShadowCastingActive(
  castShadows: boolean,
  frameState: CesiumFrameState,
): boolean {
  return castShadows && isModelShadowPassActive(frameState);
}

function isModelShadowReceivingActive(
  receiveShadows: boolean,
  shadowPassActive: boolean,
  hasCurrentLightShadowMap: boolean,
): boolean {
  return receiveShadows && shadowPassActive && hasCurrentLightShadowMap;
}

function getCurrentModelLightShadowMap(
  frameState: CesiumFrameState,
  shadowPassActive: boolean,
): CesiumShadowMap | undefined {
  if (!shadowPassActive) {
    return undefined;
  }

  const shadowMaps = frameState.shadowMaps;
  for (let i = 0; i < shadowMaps.length; i++) {
    const shadowMap = shadowMaps[i] as CesiumShadowMap & {
      fromLightSource?: boolean;
    };
    if (shadowMap.fromLightSource === true) {
      return shadowMap;
    }
  }
  return undefined;
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
  // CPU staging only. The IDL duplicate's camera block rides the per-frame
  // arena exactly like the primary view's; only the pack target is retained
  // here so the y-shifted matrix does not re-allocate per frame.
  cameraData2DIdl?: Float32Array | null;
  idlModelMatrix2D?: Matrix4 | null;
  idlBoundingSphere2D?: BoundingSphere | null;
}

interface NodeCache extends Idl2DHost, ModelShadowCastUniformHost {
  jointBuffer?: GPUBufferOrNull;
  prevJointBuffer?: GPUBufferOrNull;
  instancingBuffer?: GPUBufferOrNull;
  jointBufferSize?: number;
  packedJointMatrices?: Float32Array | null;
  prevPackedJointMatrices?: Float32Array | null;
  // CPU staging for this node's packed camera block. Retained because the
  // shadow-cast UB reads the model-space RTE eye back out of it; the GPU bytes
  // live in the per-frame arena, never in a per-node buffer.
  cameraData?: Float32Array | null;
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
  getDefaultTextureView(texture: GPUTexture): GPUTextureView;
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
  _pendingColorPipelines: Map<string | number, Promise<GPURenderPipeline>>;
  // The on-screen color pipeline resolves asynchronously through the central
  // cache and returns null while the variant is still compiling.
  getPipeline(...args: unknown[]): GPURenderPipeline | null;
  // OIT accumulation variant inputs for a translucent model color/twin command
  // (non-LOG_DEPTH source plus shared-layout pipeline config).
  getOITColorConfig(
    alphaMode: number,
    doubleSided: boolean,
    materialDefines: number,
  ): { shaderCode: string; pipelineConfig: WebGPUPipelineConfig } | null;
  getDepthWritePipeline(...args: unknown[]): GPURenderPipeline;
  getClassificationPipeline(...args: unknown[]): GPURenderPipeline;
  getCapturePipeline(...args: unknown[]): GPURenderPipeline;
  getPickPipeline(...args: unknown[]): GPURenderPipeline;
  // RGBA32F snap-payload pipeline.
  getSnapPipeline(...args: unknown[]): GPURenderPipeline;
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
  maybeUpdateForPickLogDepth(...args: unknown[]): boolean;
  maybeUpdateForModelColor(...args: unknown[]): boolean;
  maybeUpdateForSceneFormat(...args: unknown[]): boolean;
  maybeUpdateForSilhouette(...args: unknown[]): boolean;
  maybeUpdateForSplit(...args: unknown[]): boolean;
  destroy(...args: unknown[]): void;
}

interface ModelWebGPUCache extends Idl2DHost, ModelShadowCastUniformHost {
  // Exact native-resource ownership. A GPUDevice may be reused across a
  // context recovery, so both values participate in validity.
  device: GPUDevice;
  resourceGeneration: number;
  _deviceInvalidationUnsub?: (() => void) | null;
  _disposeInProgress?: boolean;
  _enqueueTextureMipGeneration?: EnqueueMipFn;
  // Cancels frame-owned mip work before a model-owned fallback texture is
  // destroyed during replacement, invalidation, or final teardown.
  _cancelTextureMipGeneration?: CancelMipFn;
  // Model-wide tile-feature picking resources. They are distinct from the
  // per-primitive `pickIds` record owned by WebGPUPickCommandHelpers.
  _featurePickIds?: Map<number, { destroy(): void }>;
  _featurePickGPUTexture?: GPUTexture | null;
  _featurePickFeaturesLength?: number;
  primitives: { [key: string]: PrimitiveRenderData };
  geometryViews?: { [key: string]: PrimitiveGeometryViewRecord };
  nodes: { [key: string]: NodeCache };
  pipelineCache: PipelineCacheLike;
  // CPU staging for the model-level (identity-transform) camera block. See
  // NodeCache.cameraData; the GPU bytes live in the arena.
  cameraData?: Float32Array | null;
  // CPU staging for the model-and-view-wide light block, packed at most once
  // per update. It is model-level because the block itself is: the same bytes
  // would otherwise be duplicated into one uniform buffer per primitive.
  lightData?: Float32Array | null;
  effectsBG?: GPUBindGroup | null;
  edgeEmitterCache?: EdgeEmitterCache | null;
  hasEdgeFeatureIds?: boolean;
  prevModelMatrix?: Matrix4 | null;
  // Set once `updateWebGPUModel` has walked the whole scene graph (i.e.
  // reached its tail rather than bailing at the missing-`_sceneGraph` guard).
  // Distinguishes "this model genuinely caches no primitives" from "the
  // primitive map is not populated yet" for the readiness check.
  _warmupTraversalComplete?: boolean;
  _project2DActive?: boolean;
  _project2DBoundingSphere?: BoundingSphere | null;
  _project2DMatrix?: Matrix4 | null;
  _project2DRefKey?: string | number | null;
  _project2DReference?: Cartesian3 | null;
  _customShader?: CustomShaderResourcesLike | null;
  // Memoized per-model IBL entries array plus the five resolved identities
  // that produced it (see getOrCreateModelIBLEntries).
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
      _texture?: StubTextureWrapper | null;
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
  backendNeutralDescriptor?: {
    renderState?: Record<string, unknown>;
  } | null;
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
  _content?: unknown;
  _webgpuPreparationAdmissionGap?: boolean;
  customShader?: CustomShaderLike;
  color?: ColorLike;
  _webgpuCache?: ModelWebGPUCache;
  _silhouetteId?: number;
  splitDirection?: number;
  silhouetteSize?: number;
  silhouetteColor?: ColorLike;
  opaquePass?: number;
  // StyleCommandsNeeded enum (0 ALL_OPAQUE / 1 ALL_TRANSLUCENT /
  // 2 OPAQUE_AND_TRANSLUCENT), or undefined before the feature table realizes.
  styleCommandsNeeded?: number;
  structuralMetadata?: unknown;
  shadows?: number;
  isDestroyed?: () => boolean;
  depthWriteForTranslucentPicking?: boolean;
  clippingPolygons?: ClippingCollectionLike | null;
  clippingPlanes?: ClippingCollectionLike | null;
  _clippingPolygons?: ClippingCollectionLike | null;
  _clippingPlanes?: ClippingCollectionLike | null;
  _boundingSphere?: BoundingSphere | null;
  boundingSphere?: BoundingSphere;
  show?: boolean;
  ready?: boolean;
  lightsFromGltf?: PunctualLightLike[] | boolean;
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
  _shadowCastTopology?: GPUPrimitiveTopology;
  // The shadow cast pipeline bakes the same topology axis as the color
  // pipeline, so it needs the same second field. Without it a uint16 and a
  // uint32 strip caster would share one cast pipeline entry.
  _shadowCastStripIndexFormat?: GPUIndexFormat;
  _shadowCastModelUB?: unknown;
  _shadowCastJointMatricesSB?: unknown;
  _shadowCastInstancingSB?: unknown;
  _shadowCastBindGroupCacheHost?: Record<string, unknown>;
  velocityCommand?: unknown;
  derivedCommands?: DrawCommandWithDerivedSlot["derivedCommands"];
};

/**
 * Packs and uploads one model-shadow transform only when its exact bytes changed.
 * The host owns both the buffer and the comparison state, so identity nodes can
 * share the model host while articulated nodes retain independent transforms.
 */
function updateModelShadowCastUniform(
  device: GPUDevice,
  host: ModelShadowCastUniformHost,
  nodeModelMatrix: Matrix4,
  label: string,
  cameraPositionWC: Cartesian3 = Cartesian3.ZERO,
  packedCameraData?: Float32Array,
): WebGPUBuffer {
  let bufferCreated = false;
  if (
    !defined(host.shadowCastUB) ||
    host.shadowCastUB.isDestroyed ||
    host.shadowCastDevice !== device
  ) {
    if (defined(host.shadowCastUB) && !host.shadowCastUB.isDestroyed) {
      host.shadowCastUB.destroy();
    }
    host.shadowCastUB = WebGPUBuffer.createUniformBuffer(
      device,
      96, // linear model matrix + encoded camera position in model coordinates
      undefined,
      label,
    );
    host.shadowCastDevice = device;
    bufferCreated = true;
  }
  if (!defined(host.shadowCastData)) {
    host.shadowCastData = new Float32Array(24);
  }
  // A replacement GPU buffer has no contents even when a stale host-side
  // comparison state says the packed matrix was already uploaded.
  if (bufferCreated || !defined(host.shadowCastUploadState)) {
    host.shadowCastUploadState = createPackedMaterialUploadState(
      host.shadowCastData,
    );
  }

  // Keep world-scale translation out of f32 entirely. The cast shaders work
  // in model-space relative-to-eye coordinates, then rotate/scale that small
  // vector into camera-relative world coordinates with this translation-free
  // matrix. This is the same precision architecture as the color path.
  Matrix4.clone(nodeModelMatrix, scratchShadowModelLinear);
  scratchShadowModelLinear[12] = 0.0;
  scratchShadowModelLinear[13] = 0.0;
  scratchShadowModelLinear[14] = 0.0;
  Matrix4.pack(scratchShadowModelLinear, host.shadowCastData, 0);

  // The color camera UBO is packed before commands are emitted and already
  // contains this exact model-space encoded eye at floats 48..54. Reuse it so
  // enabling shadow casting does not add a second Matrix4.inverse for every
  // model node on every moving-camera frame. Direct/spec callers retain the
  // standalone calculation path.
  if (defined(packedCameraData)) {
    host.shadowCastData[16] = packedCameraData[48];
    host.shadowCastData[17] = packedCameraData[49];
    host.shadowCastData[18] = packedCameraData[50];
    host.shadowCastData[20] = packedCameraData[52];
    host.shadowCastData[21] = packedCameraData[53];
    host.shadowCastData[22] = packedCameraData[54];
  } else {
    Matrix4.inverse(nodeModelMatrix, scratchInverseModel);
    Matrix4.multiplyByPoint(
      scratchInverseModel,
      cameraPositionWC,
      scratchCameraMC,
    );
    EncodedCartesian3.fromCartesian(scratchCameraMC, scratchEncodedCamera);
    host.shadowCastData[16] = scratchEncodedCamera.high.x;
    host.shadowCastData[17] = scratchEncodedCamera.high.y;
    host.shadowCastData[18] = scratchEncodedCamera.high.z;
    host.shadowCastData[20] = scratchEncodedCamera.low.x;
    host.shadowCastData[21] = scratchEncodedCamera.low.y;
    host.shadowCastData[22] = scratchEncodedCamera.low.z;
  }
  host.shadowCastData[19] = 0.0;
  host.shadowCastData[23] = 0.0;
  uploadPackedMaterialUniformsIfChanged(
    device,
    host.shadowCastUB.buffer,
    host.shadowCastData,
    host.shadowCastUploadState,
  );
  return host.shadowCastUB;
}

// Return shapes of the untyped-JS resource helpers (declared `@returns {object}`).
declare global {
  interface CesiumFrameState {
    useHDR?: boolean;
    atmosphereSkyIrradiance?: { x: number; y: number; z: number } | null;
    // The per-frame eclipse dimming multiplier published by `Scene.render`.
    // Exactly 1.0 outside a solar eclipse.
    eclipseSceneLightFactor?: number;
    scene?: {
      _webgpuPickHoverEnabled?: boolean;
      [key: string]: unknown;
    } | null;
    pickedMetadataInfo?: { propertyName?: string } | null;
  }
  interface CesiumUniformState {
    view3D?: Matrix4;
    inverseViewRotation?: Matrix3;
    inverseViewRotation3D?: Matrix3;
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
  textureEntries?: GPUBindGroupEntry[] | null;
  featureIdEntries?: GPUBindGroupEntry[] | null;
  materialDefines?: number;
  metadataWGSL?: string | null;
  metadataClassHash?: number;
  metadataMatTransport?: boolean;
  topology?: GPUPrimitiveTopology;
  stripIndexFormat?: GPUIndexFormat;
  mergedInstanceBG?: GPUBindGroup;
  effectsBG?: GPUBindGroup;
  [key: string]: unknown;
}

interface CapturePointEffectsConfig {
  options: Record<string, unknown>;
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
    capturePointEffects?: CapturePointEffectsConfig;
  }>;
  buildCaptureCommands: unknown;
}

/**
 * Frame-owned mip-generation sink (`WebGPUContext.enqueueTextureMipGeneration`).
 * A texture upgraded to a real mip chain in the `createGPUTextureFromReader`
 * fallback registers its blit here so the mips are generated in the shared
 * pre-frame `"TextureMipPreparation"` submit, never in a private
 * `queue.submit` issued from draw emission.
 */
type EnqueueMipFn = (
  texture: GPUTexture,
  format: GPUTextureFormat,
  mipLevelCount: number,
) => boolean | void;

type CancelMipFn = (texture: GPUTexture) => void;

interface ModelRenderContext {
  device: GPUDevice;
  resourceGeneration?: number;
  onDeviceInvalidated?: (callback: () => void) => () => void;
  enqueueTextureMipGeneration?: EnqueueMipFn;
  cancelTextureMipGeneration?: CancelMipFn;
  enqueueShadowReceiveUniformRefresh?: (
    uniformBuffer: GPUBuffer,
    shadowMap: object,
  ) => void;
  uniformState: CesiumUniformState;
  /**
   * The context's shared per-frame uniform ring. Null while the device is
   * unavailable; the camera arena degrades to private buffers then.
   */
  uniformAllocator?: ModelCameraArenaAllocator | null;
  /**
   * Mutable model camera/light arena paired with this context's allocator.
   * Immutable cameraBGL identity remains device-generation shared.
   *
   * Null carries the same meaning as a null `uniformAllocator`: the getter on
   * `WebGPUContext` returns null exactly while the device is unavailable
   * (destroyed / terminally lost / torn down). Model draws must degrade by
   * skipping rather than throwing — see {@link resolveModelCameraArenaOwner}.
   */
  modelCameraArena?: WebGPUModelCameraArena | null;
  /**
   * Dead-device markers mirrored from `WebGPUContext` (public-underscore
   * fields there). `resolveModelCameraArenaOwner` reads them to distinguish
   * the documented null-arena degradation above from a structural wiring
   * failure on a healthy device, which must stay loud.
   */
  _isDestroyed?: boolean;
  _isTerminallyLost?: boolean;
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  depthFormat?: GPUTextureFormat;
  scenePipelineFormat?: GPUTextureFormat;
  _sceneColorFormat?: GPUTextureFormat;
  sceneCaptureReflections?: boolean;
  supportsStereoViewport?: boolean;
  _webgpuModelPreparationDiagnosticsEnabled?: boolean;
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
  // Central async render-pipeline cache, threaded into the model pipeline
  // cache so the on-screen color pipeline compiles via
  // `createRenderPipelineAsync`.
  webgpuPipelineCache?:
    import("./WebGPURenderPipelineCache.js").WebGPURenderPipelineCache | null;
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
interface PunctualLightLike {
  enabled?: boolean;
  lightType?: number;
  type?: number;
  position?: Cartesian3;
  direction?: Cartesian3;
  color?: ColorLike;
  intensity?: number;
  range?: number;
  constantAttenuation?: number;
  linearAttenuation?: number;
  quadraticAttenuation?: number;
  innerConeAngle?: number;
  outerConeAngle?: number;
}
interface SceneLightsLike {
  length: number;
  get?(index: number): PunctualLightLike;
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

// Constants.

// Camera uniform buffer: mat4(mvpRTE) + mat4(mvRTE) + mat4(normal) +
//   vec3+pad(camHighMC) + vec3+pad(camLowMC) + vec3+pad(camWC) +
//   mat4(previousViewProjection)  = 320 bytes.
// `previousViewProjection` sits at the tail for TAA / motion-vector
// reprojection; 16-byte alignment is preserved (20 vec4s).
// The width also drives the layout's `minBindingSize`, so it lives with the
// arena that owns the layout and is re-exported here for the existing call
// sites.
const CAMERA_UNIFORM_SIZE = MODEL_CAMERA_UNIFORM_BYTES;
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
//   floats  38-39 : padding — carries the splitter lanes: 38 =
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
//   floats 105-107: padding — carries the silhouette lanes in the
//                   silhouette-variant buffer: 105 = expandX, 106 = expandY,
//                   107 = silhouette-pass flag. Zero in the primary buffer.
//
// Each KHR extension occupies a contiguous 8-float (32-byte) slot at a
// 16-byte boundary so the WGSL std140 layout matches without internal
// padding. Factors only — texture readers are resolved through the existing
// texture binding path, since adding the per-extension sampled textures
// requires a bind-group restructure.
//
//   floats 108-115: clearcoat   (factor, roughness, normalScale, _, _, _, _, _)
//                   The trailing four (112-115) carry silhouetteColor RGBA in
//                   the silhouette-variant buffer; zero in the primary buffer.
//   floats 116-123: specular    (factor, colorR, colorG, colorB, _, _, _, _)
//   floats 124-131: anisotropy  (strength, rotation, _, _, _, _, _, _)
//   floats 132-139: iridescence (factor, ior, thickMin, thickMax, _, _, _, _)
//   floats 140-147: sheen       (colorR, colorG, colorB, roughness, _, _, _, _)
//   floats 148-155: volume      (thickness, attenDistance, attColorR, attColorG, attColorB, _, _, _)
//   floats 156-171: previousModelMatrix (mat4x4), for TAA reprojection
//   floats 172-175: motionFlags         (vec4: enabled, scale, _, _)
//   floats 176-179: tileBatchFlags      (vec4: passClass, opaqueThreshold, _, _)
//   floats 180-183: transmissionFactors  (vec4: factor, ior, _, _)
//   floats 184-187: reserved (_pad_reserved8) — carries model.color RGBA.
//                   The blend scalar rides motionFlags.w (float 175). Read
//                   only by the `//>>ifdef MODEL_HAS_COLOR` FS blocks;
//                   zero-filled otherwise.
//   floats 188-191: reserved (texture transform extensions for KHR slots,
//                             KHR_materials_pbrSpecularGlossiness lookups, etc.)
const MATERIAL_UNIFORM_SIZE = 768;
// Light uniform buffer layout. Each per-light record is 20 floats; the four
// beyond the base 16 carry the spot direction:
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
//                  - +0..2  world direction OR camera-relative position xyz
//                  - +3     lightType (0=DIR, 1=POINT, 2=SPOT)
//                  - +4..6  color rgb
//                  - +7     intensity
//                  - +8     range
//                  - +9..11 const/linear/quadratic attenuation
//                  - +12..13 inner/outer cone angles (radians)
//                  - +14..15 padding
//                  - +16..18 spotDirection xyz (spot lights only)
//                  - +19    padding
//   bytes 720-767: iblReferenceFrameMatrix (mat3x3). 3 vec4-padded columns:
//                  col0 @ floats 180-182, col1 @ 184-186, col2 @ 188-190.
//   bytes 768-863: reflection proxy block for environment parallax.
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
//
// The width itself lives with the arena that binds it (group 0 binding 1
// declares it as `minBindingSize`), so there is exactly one number to keep in
// lockstep with the WGSL struct.
const LIGHT_UNIFORM_SIZE = MODEL_LIGHT_UNIFORM_BYTES;

// materialFlags bit for skinning (bit 13 = 8192)
const FLAG_HAS_SKINNING = 8192;
// materialFlags bit for instancing (bit 15 = 32768)
const FLAG_HAS_INSTANCING = 32768;

// Aggregate mask of all KHR-extension bits the FS gates on. Mirrors the
// FLAG_HAS_* constants in ModelPBRComplete.wgsl (bits 19-25). When the
// material's flags AND this mask is zero, the renderer routes through the
// basic shader/BGL/pipeline-layout variant — bindings 12-25 of the
// materialBGL are stripped, dropping the sampled-texture count from 23 to 10
// so the pipeline fits within the WebGPU spec floor
// `maxSampledTexturesPerShaderStage = 16`.
//
// Scalability note: this is a coarse OR — any KHR bit set routes through the
// full variant. The architecture (manifest-driven BGL builder + per-variant
// pipeline cache + per-variant shader-module cache, all keyed on
// `materialDefines: number`) supports per-extension granular splits without
// further refactoring. Once the WGSL ifdefs are split per-extension, this
// helper can return a granular `materialDefines` such as
// `MODEL_HAS_KHR_SPECULAR | MODEL_HAS_KHR_CLEARCOAT`, and the cache will build
// a minimal layout for that exact subset that fits a 16-texture device even
// when the asset uses some KHR extensions.
const FLAG_HAS_KHR_MASK =
  524288 | // FLAG_HAS_CLEARCOAT (bit 19)
  1048576 | // FLAG_HAS_SPECULAR_EXT (bit 20)
  2097152 | // FLAG_HAS_ANISOTROPY (bit 21)
  4194304 | // FLAG_HAS_IRIDESCENCE (bit 22)
  8388608 | // FLAG_HAS_SHEEN (bit 23)
  16777216 | // FLAG_HAS_VOLUME (bit 24)
  33554432; // FLAG_HAS_TRANSMISSION (bit 25)

/**
 * Computes the `materialDefines` bitmask for a primitive given its material
 * flags. The pipeline cache, BGL builder and shader-module cache all key on
 * this value.
 *
 * The result is binary: `0` (basic, no KHR — fits the 16-sampled-texture spec
 * floor) or `MODEL_HAS_KHR_TEXTURES` (full, all KHR bindings present — needs
 * the device to opt `maxSampledTexturesPerShaderStage` up past the spec
 * floor).
 *
 * Once the WGSL ifdefs are split per-KHR-extension and a
 * `MODEL_HAS_KHR_SPECULAR` / `MODEL_HAS_KHR_CLEARCOAT` set of `ShaderDefine`
 * bits exists, this function can return the exact OR of the bits the
 * primitive's flags activate, and the cache can build a minimal layout fitting
 * within `device.limits.maxSampledTexturesPerShaderStage`.
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

// Scratch variables.

const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchNormal = new Matrix4();
const scratchInverseModel = new Matrix4();
const scratchCameraMC = new Cartesian3();
const scratchEncodedCamera = new EncodedCartesian3();
const scratchShadowModelLinear = new Matrix4();
// Scratch for the accurate-2D 3D normal matrix override (see
// overrideProject2DNormalMatrix).
const scratchModelView3D = new Matrix4();
const scratchNormal3D = new Matrix4();
// Per-runtime-node modelMatrix scratch for
// `modelMatrix * runtimeNode.computedTransform`. Reused per node per frame.
// `transformToRoot` is not the correct factor here: per `ModelRuntimeNode` it
// excludes the node's own transform. WebGL's
// `ModelMatrixUpdateStage.updateRuntimeNode` multiplies in
// `runtimeNode.transform` before consuming, which is equivalent to using
// `runtimeNode.computedTransform`.
const scratchNodeModelMatrix = new Matrix4();

// Reused per-frame scratch for the accurate-2D (`projectTo2D:true`) path: the
// model's ECEF world origin, the per-node 3D world matrix used to reproject
// positions, and a corner-point accumulator for the morphed 2D bounding
// volume.
const scratchProject2DWorldOrigin = new Cartesian3();
const scratchProject2DNodeWorld = new Matrix4();

// Reused scratch for the SCENE2D IDL-crossing duplicate command (mirrors
// WebGL `ModelDrawCommand.updateModelMatrix2D` / `derive2DCommand`). Only
// touched when `idlDuplicateActive` is armed.
const scratchIdl2DModelMatrix = new Matrix4();

// Union the per-primitive accurate 2D bounding spheres (computed by
// SceneMode2DPipelineStage into `runtimePrimitive.boundingSphere2D`) into a
// single model-level 2D volume.
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

// Reused per-primitive-per-face capture camera UB staging buffer. The pack
// writes into this and the ring allocator copies the bytes to a per-frame
// slice, so a single module-scope scratch suffices for all 6 faces × N
// primitives.
const captureCameraData = new Float32Array(CAMERA_UNIFORM_SIZE / 4);
// Capture faces cannot bind the primitive's persistent on-screen light UB.
// Punctual positions and the eye-to-world rotation are view-owned, and capture
// is recorded before the main view in the same submission. Pack one immutable
// ring slice per model/face so neither view can overwrite bytes that an
// already-recorded draw will consume later.
const captureLightData = new Float32Array(LIGHT_UNIFORM_SIZE / 4);

// Cheap "is identity" check used to skip per-node camera resource allocation
// when the node has no parent-chain transform
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

// Camera uniform packing.

/**
 * Resolves the exact context that owns both the mutable model arena and its
 * uniform ring. A pooled GPUDevice can back multiple contexts, so neither
 * mutable owner may come from the device-shared pipeline cache.
 *
 * Returns null — the documented degradation, where callers skip the draw —
 * when the arena getter reports a dead device (`WebGPUContext.modelCameraArena`
 * is null exactly while the context is destroyed or terminally lost, and
 * nothing can render there anyway). A null arena on a context whose device
 * still claims to be healthy, or a context that has no arena property at all,
 * remains a loud structural error: that is a wiring failure feeding an active
 * model draw, not a device lifecycle state.
 */
function resolveModelCameraArenaOwner(
  frameState: CesiumFrameState,
): ModelRenderContext | null {
  const context = frameState?.context as unknown as
    ModelRenderContext | undefined;
  if (context?.modelCameraArena) {
    return context;
  }
  if (
    context !== undefined &&
    context.modelCameraArena === null &&
    (context._isDestroyed === true || context._isTerminallyLost === true)
  ) {
    return null;
  }
  throw new Error(
    "[CesiumJS:webgpu] Model camera arena is unavailable for an active model draw.",
  );
}

/**
 * Acquires one group-0 binding pair for `data` + `lightSlice` from the device
 * arena. Ticks the arena on the current frame first, which is idempotent
 * within a frame and clears the bind-group cache when the context has rebuilt
 * its ring (device recovery on the same `GPUDevice`).
 *
 * `lightSlice` is the caller's single light block for this model and view (see
 * {@link acquireModelLightSlice}). It is not re-staged here: several camera
 * blocks (root, each transformed node, the IDL duplicate) address the same
 * light bytes, which is the entire point of hoisting the pack out of the
 * per-primitive loop.
 *
 * Returns null on the dead-device degradation (see
 * {@link resolveModelCameraArenaOwner}); the caller skips the draw.
 */
function acquireModelCameraBinding(
  device: GPUDevice,
  frameState: CesiumFrameState,
  pipelineCache: PipelineCacheLike,
  data: Float32Array,
  label: string,
  lightSlice: ModelViewLightSlice,
): ModelCameraBinding | null {
  const context = resolveModelCameraArenaOwner(frameState);
  if (context === null) {
    return null;
  }
  const allocator = context.uniformAllocator ?? null;
  const arena = context.modelCameraArena!;
  arena.beginFrame(frameState?.frameNumber ?? 0, allocator);
  return arena.acquire(
    device,
    allocator,
    pipelineCache.cameraBGL,
    data,
    CAMERA_UNIFORM_SIZE,
    label,
    lightSlice,
    LIGHT_UNIFORM_SIZE,
  );
}

/**
 * Packs and stages the single light block this model and view share.
 *
 * The block depends only on `frameState` (scene light, eclipse factor, sky
 * irradiance, punctual lights, active RTE eye) and `model` (IBL factors,
 * asset lights, reflection proxy) — never on the primitive — so packing it
 * per primitive would produce `N` byte-identical copies for an `N`-primitive
 * model. A byte-comparison guard cannot recover that cost either, because
 * camera-relative punctual positions change on every moving-camera frame and
 * only suppress an upload while the camera stands perfectly still.
 *
 * Callers memoize the result in an update-scoped local, never on the model
 * cache: the slice belongs to one allocation epoch, so a later frame would
 * bind bytes the ring has already handed to someone else.
 */
function acquireModelLightSlice(
  device: GPUDevice,
  frameState: CesiumFrameState,
  data: Float32Array,
  label: string,
): ModelViewLightSlice | null {
  const context = resolveModelCameraArenaOwner(frameState);
  if (context === null) {
    return null;
  }
  const allocator = context.uniformAllocator ?? null;
  const arena = context.modelCameraArena!;
  arena.beginFrame(frameState?.frameNumber ?? 0, allocator);
  return arena.acquireLightSlice(
    device,
    allocator,
    data,
    LIGHT_UNIFORM_SIZE,
    label,
  );
}

/** The two work counters {@link prepareModelViewLightSlice} touches. */
interface ModelLightWorkCounters {
  lightPacks: number;
  lightWrites: number;
}

/**
 * Realizes this update's single light slice: allocates the model-level staging
 * array on first use, packs it, and stages it into the frame arena.
 *
 * Called at most once per model per update through the callers' update-scoped
 * memo. `lightPacks` therefore counts models, not primitives, and `lightWrites`
 * counts light blocks that reached the GPU — staged into the ring page the
 * context flushes once before submit — rather than individual `writeBuffer`
 * calls, which this path does not make.
 *
 * Returns null on the dead-device degradation (see
 * {@link resolveModelCameraArenaOwner}): nothing was staged, `lightWrites`
 * does not advance, and the caller skips the draw that wanted the slice.
 *
 * @private
 */
function prepareModelViewLightSlice(
  device: GPUDevice,
  frameState: CesiumFrameState,
  cache: ModelWebGPUCache,
  model: ModelLike,
  preparationWork: ModelLightWorkCounters | undefined,
): ModelViewLightSlice | null {
  if (!defined(cache.lightData)) {
    cache.lightData = new Float32Array(LIGHT_UNIFORM_SIZE / 4);
  }
  if (defined(preparationWork)) {
    preparationWork.lightPacks++;
  }
  packLightUniforms(cache.lightData, frameState, model);
  const slice = acquireModelLightSlice(
    device,
    frameState,
    cache.lightData,
    "Model light",
  );
  if (slice === null) {
    return null;
  }
  if (defined(preparationWork)) {
    preparationWork.lightWrites++;
  }
  return slice;
}

type PreviousMatrixHost = {
  prevModelMatrix?: Matrix4 | null;
  prevNodeModelMatrix?: Matrix4 | null;
};

/**
 * Resolve a previous-frame transform, resetting it to the current transform on
 * the first frame after an admission gap. This prevents an offscreen interval
 * from becoming one giant TAA motion vector when the model re-enters view.
 *
 * @private
 */
function resolvePreviousMatrixForFrame(
  host: PreviousMatrixHost,
  property: "prevModelMatrix" | "prevNodeModelMatrix",
  currentMatrix: Matrix4,
  resetToCurrent: boolean,
): Matrix4 {
  let previousMatrix = host[property];
  if (!defined(previousMatrix)) {
    previousMatrix = Matrix4.clone(currentMatrix);
    host[property] = previousMatrix;
  } else if (resetToCurrent) {
    Matrix4.clone(currentMatrix, previousMatrix);
  }
  return previousMatrix;
}

/**
 * Advance packed joint history without allowing an admission gap to span
 * multiple animation frames. The caller uploads both returned arrays only on
 * an admitted frame; rejected frames never enter this helper or touch the GPU.
 *
 * @private
 */
function preparePackedJointHistoryForFrame(
  runtimeNode: RuntimeNodeLike,
  nodeCache: NodeCache,
  resetToCurrent: boolean,
): void {
  const current = nodeCache.packedJointMatrices;
  if (!defined(current)) {
    return;
  }
  if (
    !defined(nodeCache.prevPackedJointMatrices) ||
    nodeCache.prevPackedJointMatrices.length !== current.length
  ) {
    nodeCache.prevPackedJointMatrices = new Float32Array(current.length);
  }

  if (resetToCurrent) {
    updatePackedJointMatrices(runtimeNode, current);
    nodeCache.prevPackedJointMatrices.set(current);
  } else {
    nodeCache.prevPackedJointMatrices.set(current);
    updatePackedJointMatrices(runtimeNode, current);
  }
}

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

  // Camera position in model coordinates, which is what the RTE encode needs:
  // inverse(model) * cameraPositionWC → camera in model space.
  //
  // The eye comes from `uniformState.cameraPosition` rather than
  // `frameState.camera.positionWC` so the model eye is fully
  // `uniformState`-driven, like the globe. The two are parity-neutral
  // on-screen: `UniformState.update` calls `updateCamera(frameState.camera)`
  // every frame, which clones `camera.positionWC` into `_cameraPosition`, so
  // they are bit-for-bit identical in every scene mode. The payoff is that the
  // env scene-capture pass's per-face `uniformState.updateCamera(faceCamera)`
  // and its finally-restore repoint the model eye for free, exactly as they
  // already do for the globe.
  // Keep the `inverse(model) * eyeWC` math; `encodedCameraPositionMC` is not a
  // substitute, because it is the ellipsoid-ENU encode and so the wrong frame.
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
  // eye as the model-coordinate encode above: parity-neutral on-screen, and
  // face-camera-aware during env scene capture.
  const camWC = eyeWC;
  data[56] = camWC.x;
  data[57] = camWC.y;
  data[58] = camWC.z;
  data[59] = 0.0;

  // Renderer-wide log depth — floats 51/55/59 carry (factor, near, far)
  // per the WebGPULogDepth.ts lane convention. These are otherwise-zero pad
  // lanes; only the LOG_DEPTH module variant reads them.
  packCameraLogDepthLanes(data, 0, uniformState);

  // previousViewProjection at offset 60..75 (16 floats).
  // `UniformState.update()` clones the current viewProjection into
  // `_previousViewProjection` before overwriting it with the new camera
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

  // HDR gate at float 76 (camera.hdrControl.x), packed into trailing padding
  // of the 320-byte camera UB. Mirrors WebGL's `#ifdef HDR` in
  // LightingStageFS: when `scene.highDynamicRange` is on
  // (`frameState.useHDR`) the model shader's `tonemapAndGamma` skips the
  // inline tonemap and gamma encode so the post-process Tonemap stage does it
  // once. Zero on the default SDR path, which leaves that path byte-identical.
  data[76] = frameState.useHDR === true ? 1.0 : 0.0;
}

// Overrides the normal matrix (slots 32-47) with the 3D normal matrix for the
// accurate-2D path. `packCameraUniforms` derives the normal matrix from the
// translate(reference) 2D clip matrix, which carries no model orientation, so
// `normalEC` would lose the model's world rotation and diffuse lighting would
// be wrong. WebGL shades projectTo2D models entirely in the 3D eye frame
// (`czm_normal3D` in ModelVS.glsl) while only the clip position is remapped to
// 2D; the light direction the renderer packs
// (`uniformState.lightDirectionEC`) is always in the view3D frame
// (`viewRotation3D` in UniformState.js), so `normalEC` must match it. This
// recomputes `transpose(inverse(view3D × model3DWorld))` from the model-level
// 3D world matrix; per-node rotation for normals is a known residual. The clip
// position, RTE camera encode, and mvp remain the 2D values.
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

// Model capture command builder.

/**
 * Turns one published model entry's per-primitive draw records into
 * single-target capture draw descriptors for the current cube face. Invoked by
 * `WebGPUDynamicEnvironmentMapCapture.runSceneCapture` (via the published
 * `buildCaptureCommands` slot) after it has repointed `uniformState` to the
 * face camera, so the per-primitive camera UB packed here bakes the face-camera
 * RTE eye.
 *
 * Per record:
 *   - acquire a fresh per-frame arena slice for the face-camera UB. The slice
 *     must be its own: `captureCameraData` is a shared staging array the next
 *     record overwrites, and the main pass renders later in this same frame
 *     from its own slices.
 *   - reuse the arena's shared group-0 bind group and address this record's
 *     camera block and the face light block by dynamic offset
 *     (`bindGroup0DynamicOffsets`, ordered `[camera, light]`).
 *   - pack one face-view light UB into another ring slice before the first
 *     record and pair it with every camera slice of this model replay. The
 *     on-screen light block must never be reused, because its camera-relative
 *     positions and rotation belong to another view.
 *   - rebuild the material bind group with a neutral IBL (`iblEntries = null` →
 *     `defaultIBLEntries`) to avoid a one-frame recursive self-reflection,
 *     where the model samples the env cube it is being captured into.
 *   - fetch the single-target `CAPTURE_MODE` pipeline (`getCapturePipeline`).
 *   - reuse the record's already-built merged instance bind group and
 *     vertex/index buffers. Ordinary effects reuse the on-screen group;
 *     point-shadow effects acquire a stable per-face group because their
 *     light position is camera-relative.
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
    capturePointEffects?: CapturePointEffectsConfig;
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
  // The normal record reuses its on-screen Effects bind group because those
  // resources are camera-independent for ordinary effects. Point shadows are
  // the exception: their light position is packed relative to the active RTE
  // camera. Rebuild after capture has repointed UniformState while retaining
  // the model's normal stable Effects owner. All six cube faces share one eye,
  // so they reuse one exact-byte slot; a distinct main/capture eye resolves to
  // another slot in the same bounded resource group without overwriting
  // in-flight contents.
  let captureEffectsBG: GPUBindGroup | null = null;
  const capturePointEffects = entry.capturePointEffects;
  if (capturePointEffects) {
    const activeCameraPosition = (
      frameState.context as unknown as ModelRenderContext
    ).uniformState?.cameraPosition;
    captureEffectsBG = createEffectsBindGroup(device, frameState, {
      ...capturePointEffects.options,
      cameraInPlaneSpace: activeCameraPosition,
    }).bindGroup;
  }
  const commands = [];
  // One face-view light block per model replay, shared by every record of this
  // face. It is never the on-screen light: those camera-relative positions and
  // the eye→world rotation belong to another view.
  let captureLightSlice: ModelViewLightSlice | null = null;
  for (let r = 0; r < records.length; r++) {
    const rec = records[r];
    if (!rec.indexBuffer || rec.indexCount === 0) {
      continue;
    }
    // Pack the face-camera UB against the record's snapshot model matrix. The
    // eye-swap (uniformState.cameraPosition) means the repointed face camera
    // reaches the model eye automatically.
    //
    // One fresh arena slice per record per face. The slice must be distinct
    // because `captureCameraData` is a single shared staging array that the
    // next record immediately overwrites, and because the main pass renders
    // later in this same frame from its own slices. The bind group, by
    // contrast, is shared: it addresses the whole ring page, and the dynamic
    // offset selects this record's block. That keeps the bind-group count at
    // roughly one per ring page for the entire refresh instead of one per
    // primitive per cube face.
    if (!captureLightSlice) {
      packLightUniforms(captureLightData, frameState, model);
      captureLightSlice = acquireModelLightSlice(
        device,
        frameState,
        captureLightData,
        "Model capture light",
      );
      if (captureLightSlice === null) {
        // Dead-device degradation (resolveModelCameraArenaOwner): the face
        // replay is skipped; capture on a dead device draws nothing anyway.
        return commands;
      }
    }
    packCameraUniforms(captureCameraData, frameState, rec.nodeModelMatrix);
    const cameraBinding = acquireModelCameraBinding(
      device,
      frameState,
      pipelineCache,
      captureCameraData,
      "Model capture camera",
      captureLightSlice,
    );
    if (cameraBinding === null) {
      return commands;
    }
    const materialBG = buildMergedMaterialBindGroup(
      device,
      pipelineCache,
      rec.materialBuffer,
      rec.textureEntries,
      rec.featureIdEntries,
      null, // neutral IBL — no recursive self-reflection
      rec.materialDefines,
      frameState,
    );
    // Feed the published metadata chunk before building the capture pipeline
    // so a MODEL_HAS_METADATA capture variant compiles with its generated
    // `struct Metadata`. Clears for non-metadata records.
    if (defined(rec.metadataWGSL)) {
      pipelineCache.setMetadataWGSL(
        rec.metadataWGSL,
        rec.metadataClassHash | 0,
        rec.metadataMatTransport === true,
      );
    } else {
      pipelineCache.clearMetadataWGSL();
    }
    // Sticky-topology contract: set per record before the capture pipeline
    // build, since records from older publishes default to triangle. Both
    // halves of the axis travel on the record.
    pipelineCache.setPrimitiveTopology(
      rec.topology ?? "triangle-list",
      rec.stripIndexFormat,
    );
    const pipeline = pipelineCache.getCapturePipeline(
      rec.alphaMode,
      rec.doubleSided,
      rec.materialDefines,
      faceFormat,
    );
    commands.push({
      pipeline,
      bindGroups: [
        cameraBinding.bindGroup,
        materialBG,
        rec.mergedInstanceBG,
        captureEffectsBG ?? rec.effectsBG,
      ],
      // `cameraBGL` is a dynamic-offset layout, so the capture replay loop in
      // `WebGPUDynamicEnvironmentMapCapture` must forward this.
      bindGroup0DynamicOffsets: cameraBinding.dynamicOffsets,
      vertexBuffers: rec.vertexBuffers,
      indexBuffer: rec.indexBuffer,
      indexCount: rec.indexCount,
      indexFormat: rec.indexFormat,
      instanceCount: rec.instanceCount || 1,
    });
  }
  return commands;
}

// Material uniform packing.

/**
 * Creates the byte-comparison state for one concrete material uniform buffer.
 * Both views are allocated once with the primitive; steady-state comparisons
 * do not allocate temporary typed-array views.
 */
function createPackedMaterialUploadState(
  data: Float32Array,
): PackedMaterialUploadState {
  return {
    currentWords: new Uint32Array(
      data.buffer,
      data.byteOffset,
      data.byteLength / Uint32Array.BYTES_PER_ELEMENT,
    ),
    uploadedWords: new Uint32Array(
      data.byteLength / Uint32Array.BYTES_PER_ELEMENT,
    ),
    uploaded: false,
  };
}

/**
 * Uploads a packed material block only when its exact bytes differ from the
 * bytes last submitted to this GPU buffer. The first upload is unconditional,
 * including for an all-zero block.
 *
 * A byte-level comparison is intentionally used instead of material-descriptor
 * identity: the cached descriptor covers authored material semantics, while
 * this block also carries model transforms, pick state, splitter state, motion
 * history, and feature flags that can change independently. Uint32 comparison
 * preserves NaN payloads and signed zero exactly.
 */
function uploadPackedMaterialUniformsIfChanged(
  device: GPUDevice,
  buffer: GPUBuffer,
  data: Float32Array,
  state: PackedMaterialUploadState,
): boolean {
  const currentWords = state.currentWords;
  const uploadedWords = state.uploadedWords;
  let changed = !state.uploaded;

  if (!changed) {
    for (let i = 0; i < currentWords.length; i++) {
      if (currentWords[i] !== uploadedWords[i]) {
        changed = true;
        break;
      }
    }
  }

  if (!changed) {
    return false;
  }

  device.queue.writeBuffer(
    buffer,
    0,
    data.buffer,
    data.byteOffset,
    data.byteLength,
  );
  uploadedWords.set(currentWords);
  state.uploaded = true;
  return true;
}

function packMaterialUniforms(
  data: Float32Array,
  dataWords: Uint32Array,
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
  dataWords[28] = flags;

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
  dataWords[37] = tcFlags;

  // Padding to maintain vec4 alignment for the next field (pickColor).
  // texCoordFlags lives at slot 37; slots 38-39 pad up to the 16-byte
  // boundary at slot 40 where pickColor (vec4) starts.
  data[38] = 0;
  data[39] = 0;

  // pickColor slot (floats 40-43). Zero when no pick ID has been
  // registered yet (e.g. a non-pick render pass before the model first
  // enters a pick pass). The pick command itself is only attached to
  // derivedCommands.picking when a pick color is available, so the
  // zeros never reach the pick FBO.
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

  // KHR_texture_transform per-texture 3x3.
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
  dataWords[104] = ttFlags;
  // Padding to 16-byte boundary.
  data[105] = 0;
  data[106] = 0;
  data[107] = 0;

  // KHR material extension factors.
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

  // previousModelMatrix (slots 156-171). Pack
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
  //   z, w: reserved (sky reprojection / disocclusion params)
  data[172] = motionEnabled ? 1.0 : 0.0;
  data[173] = 1.0;
  // motionFlags.z doubles as the metadata-debug toggle. When the test hook
  // `globalThis.CesiumWebGPUMetadataDebug` is set, flip it to 1.0 so the
  // `MODEL_HAS_METADATA` fragment branch paints the scalar metadata value to
  // the fragment color, which shows that the property-attribute value reached
  // the shader. The WGSL branch is stripped for non-metadata models, so
  // setting this globally is safe — only metadata models react. Reusing the
  // reserved slot avoids growing the material UBO, which would break
  // non-metadata byte-identity.
  data[174] =
    (globalThis as { CesiumWebGPUMetadataDebug?: boolean })
      .CesiumWebGPUMetadataDebug === true
      ? 1.0
      : 0.0;
  data[175] = 0;

  // tileBatchFlags (slot 176-179):
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

  // transmissionFactors (slot 180-183):
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
  // slot's "has transform" bit is unset, so these slots are never read,
  // but writing the identity keeps the buffer self-consistent and makes
  // the dump readable in PIX/RenderDoc.
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

// Light uniform packing.

function resolveActiveModelCameraPosition(
  frameState: CesiumFrameState,
): Cartesian3 {
  return (
    frameState.context?.uniformState?.cameraPosition ??
    frameState.camera?.positionWC ??
    Cartesian3.ZERO
  );
}

function packLightUniforms(
  data: Float32Array,
  frameState: CesiumFrameState,
  model: ModelLike,
) {
  // Pack `lightDirectionEC` (the scene-light direction) rather than
  // `sunDirectionEC`. When the scene uses a `SunLight` the two are
  // identical, as `UniformState.update` shows. When the scene overrides
  // `scene.light` with a custom `DirectionalLight` (a hillshade
  // direction, or an artist-controlled key light), only
  // `lightDirectionEC` reflects the user-set value; packing the sun
  // direction would light custom-lit models from the sun regardless of
  // `scene.light`. This mirrors the upstream PBR shaders, which
  // reference `czm_lightDirectionEC` rather than `czm_sunDirectionEC`.
  // The local is still named `sunDir` to match the WGSL uniform field;
  // renaming both is a separate refactor.
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

  // Eclipse dimming of WebGPU model direct lighting.
  //
  // The other eclipse dimming sites route through a shared JS uniform source,
  // so one multiply there serves both backends. This one cannot: WebGL models
  // read `czm_lightColorHdr` (`Model/LightingStageFS.glsl`), which
  // `UniformState` already dims, but `ModelPBRComplete.wgsl` never reads
  // `csm_lightColor*` — its direct term is `light.sunColor *
  // light.sunIntensity * NdotL`, fed raw from `frameState.light` right here.
  // Without this multiply a solar eclipse would dim the WebGL scene and the
  // WebGPU globe/sky while leaving WebGPU glTF and 3D-Tiles models at full
  // brightness on top of a darkened world, which is exactly the cross-backend
  // divergence a default-on multiplier must not introduce.
  //
  // The colour is scaled rather than the intensity: the shader's product is
  // `sunColor * sunIntensity`, so the two are algebraically identical, and
  // scaling the colour leaves `data[7]` carrying the user's own
  // `light.intensity` unmodified. One multiply here covers all four direct
  // terms in the WGSL (base, anisotropy, clearcoat, sheen).
  //
  // The gate matches the one `UniformState` applies: dim only when the frame's
  // light is the scene sun. A user-supplied `DirectionalLight` is never
  // touched. The aerial-perspective derived light takes the dimming too,
  // because `Scene._atmosphereDerivedLight` is itself a `SunLight`, which is
  // what keeps the WebGPU aerial-perspective sub-case in step with the plain
  // one.
  const eclipseFactorRaw = frameState.eclipseSceneLightFactor;
  const eclipseFactor =
    light instanceof SunLight && typeof eclipseFactorRaw === "number"
      ? eclipseFactorRaw
      : 1.0;

  if (lightColor) {
    data[4] = lightColor.red * eclipseFactor;
    data[5] = lightColor.green * eclipseFactor;
    data[6] = lightColor.blue * eclipseFactor;
  } else {
    data[4] = eclipseFactor;
    data[5] = eclipseFactor;
    data[6] = eclipseFactor;
  }
  data[7] = light?.intensity ?? 2.0;

  // ambientColor — small floor so unlit faces aren't pitch black. When the
  // unified aerial-perspective atmosphere is active, Scene publishes a
  // sky-irradiance ambient (`frameState.atmosphereSkyIrradiance`) derived from
  // the same atmosphere that lights the sun (`frameState.light`) and produces
  // the post-process haze, so the model's ambient is a plausible
  // day/night-aware blue-tinted sky term consistent with its direct sun rather
  // than a flat grey. Falls back to the neutral 0.2 floor when aerial
  // perspective is off, and on WebGL.
  //
  // The sky-irradiance branch takes the eclipse factor too. It is a genuinely
  // sun-driven quantity — `Scene.updateFrameState` derives it from the same
  // atmosphere that produces `frameState.light`, and only publishes it when
  // the scene light is a `SunLight` — and it is computed before the eclipse
  // state is published, so this is its single dimming site. Leaving it undimmed
  // would keep a full-brightness blue sky bounce on models through totality.
  //
  // The 0.2 neutral fallback is deliberately left alone: it is a non-physical
  // "unlit faces aren't pitch black" floor, not a sun term, and dimming it
  // would drive models to black at totality, which is the one outcome the
  // twilight floor exists to prevent.
  const skyIrradiance = frameState.atmosphereSkyIrradiance;
  if (skyIrradiance) {
    data[8] = skyIrradiance.x * eclipseFactor;
    data[9] = skyIrradiance.y * eclipseFactor;
    data[10] = skyIrradiance.z * eclipseFactor;
  } else {
    data[8] = 0.2;
    data[9] = 0.2;
    data[10] = 0.2;
  }
  data[11] = 0.0;

  // IBL factors — consumed by ModelPBRComplete.wgsl for split-sum ambient.
  // When the model's ImageBasedLighting is disabled or absent a sensible
  // default is still written so the ambient term isn't silently zeroed: the
  // shader multiplies ambientColor * iblDiffuseFactor, and a zero factor drops
  // the term.
  const ibl = model?._imageBasedLighting;
  const iblFactor = ibl?._imageBasedLightingFactor; // Cartesian2 (x=diffuse, y=specular)
  data[12] = iblFactor?.x ?? 1.0;
  data[13] = iblFactor?.y ?? 1.0;
  // Max mip level of the prefiltered specular
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

  // Punctual lights.
  // Merges `frameState.lights` (scene-level, world-space) with
  // `model.lightsFromGltf` (KHR_lights_punctual asset lights, model
  // space transformed through `model.modelMatrix` here). Caps at 8
  // total -- scene lights win when the union exceeds the cap so
  // user-added lights aren't silently dropped by a noisy asset.
  const activeCameraPosition = resolveActiveModelCameraPosition(frameState);
  packPunctualLights(
    data,
    16,
    frameState.lights as unknown as SceneLightsLike | null | undefined,
    model,
    activeCameraPosition,
  );

  // Eye→IBL-frame rotation
  // (`model._iblReferenceFrameMatrix`, a column-major Cesium Matrix3 set
  // by `updateReferenceMatrices` every frame). Mirrors WebGL's
  // `model_iblReferenceFrameMatrix` mat3 uniform. Packed at the tail of
  // LightUniforms (byte 720 / float 180) as a WGSL mat3x3<f32>: three
  // vec4-padded columns (each column's xyz at floats 0/1/2, pad at 3).
  // Defaults to identity (Matrix3.IDENTITY clone) so a model without IBL
  // configured samples the placeholder cubemap unrotated.
  packIBLReferenceFrame(data, 180, model);

  // Reflection proxy block (floats 192-215).
  // Always writes mode (float 192); defaults to 0 (raw reflection vector) so
  // stale proxy data cannot leak when the proxy is cleared. The eye-to-world
  // rotation remains populated whenever punctual-light vectors consume it.
  packReflectionProxy(data, 192, frameState, model, activeCameraPosition);
}

// Packs the per-manager reflection proxy into the LightUniforms tail. Reads
// `model.environmentMapManager.reflectionProxy` (the opt-in box/sphere proxy).
// Center and half-extents are converted to camera-relative world space
// (proxy minus camera position) so the WGSL box
// intersection runs in the same frame as the fragment's camera-relative world
// position, preserving f32 precision at Earth scale. Also packs the eye→world
// rotation (`uniformState.inverseViewRotation`) the shader uses to lift the
// eye-space reflection into world space. Punctual lighting shares that rotation
// to keep its camera-relative world vectors coherent with eye-space N/V, so the
// matrix remains valid even when no proxy is configured (mode stays 0).
const scratchProxyCenterRel = new Cartesian3();
function packReflectionProxy(
  data: Float32Array,
  floatOffset: number,
  frameState: CesiumFrameState,
  model: ModelLike,
  cameraPositionWC: Cartesian3,
) {
  // Zero the whole 24-float block first (mode 0 + clean slate).
  for (let i = 0; i < 24; i++) {
    data[floatOffset + i] = 0.0;
  }

  const uniformState = frameState.context.uniformState;

  const proxy = model?.environmentMapManager?.reflectionProxy;
  const hasProxy = defined(proxy) && defined(proxy.center);
  const hasPunctualLights = data[16] > 0.0;
  if (!hasProxy && !hasPunctualLights) {
    return;
  }

  // Punctual-light vectors are evaluated in camera-relative world space. The
  // model normal/view vectors arrive in eye space, so this rotation is required
  // whenever punctual lights or reflection-proxy parallax are active. Keeping
  // the no-light/no-proxy block zero avoids a camera-driven upload tax for the
  // overwhelmingly common sun-only model path.
  const useProjected3DFrame =
    frameState.mode !== SceneMode.SCENE3D && model._projectTo2D === true;
  const m =
    (useProjected3DFrame
      ? uniformState.inverseViewRotation3D
      : uniformState.inverseViewRotation) ??
    uniformState.inverseViewRotation ??
    Matrix3.IDENTITY;
  data[floatOffset + 12] = m[0];
  data[floatOffset + 13] = m[1];
  data[floatOffset + 14] = m[2];
  data[floatOffset + 16] = m[3];
  data[floatOffset + 17] = m[4];
  data[floatOffset + 18] = m[5];
  data[floatOffset + 20] = m[6];
  data[floatOffset + 21] = m[7];
  data[floatOffset + 22] = m[8];

  if (!hasProxy) {
    return;
  }

  const mode = proxy.type === "sphere" ? 2.0 : 1.0;
  data[floatOffset + 0] = mode; // control.x = mode
  data[floatOffset + 1] = mode === 2.0 ? (proxy.radius ?? 0.0) : 0.0; // control.y = radius
  // control.z / control.w stay 0.

  // Camera-relative world center (centerWC - cameraWC).
  Cartesian3.subtract(proxy.center, cameraPositionWC, scratchProxyCenterRel);
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
}

// Writes the model's `_iblReferenceFrameMatrix` (column-major Matrix3) into a
// WGSL std140 mat3x3 slot (3 vec4-padded columns).
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

// Pre-allocated scratch matching `LightCollection.pack()`'s output (164 floats
// = 656 bytes; 4-float header + 8 lights × 20 floats). Reused per call to
// avoid GC pressure on every model draw.
const scratchLightPack = new Float32Array(164);

// Packs scene-level `LightCollection` lights together with glTF
// KHR_lights_punctual lights (model-space, transformed by model.modelMatrix
// here) into the per-model UBO's punctual region starting at `floatOffset`.
// Scene lights take priority when the combined count exceeds MAX_LIGHTS=8.
// Point and spot positions are packed camera-relative after f64 CPU
// subtraction; light directions remain in world space.
const MAX_PUNCTUAL_LIGHTS = 8;
const FLOATS_PER_PUNCTUAL_LIGHT = 20;
function packPunctualLights(
  data: Float32Array,
  floatOffset: number,
  sceneLights: SceneLightsLike | null | undefined,
  model: ModelLike,
  cameraPositionWC: Cartesian3,
) {
  // Header (4 floats: lightCount + 3 pad) followed by 8 light slots.
  // Total region = 4 + 8 * 20 = 164 floats. Always zero the entire
  // region first so previous frame's data doesn't leak when light
  // counts shrink.
  const regionEnd =
    floatOffset + 4 + MAX_PUNCTUAL_LIGHTS * FLOATS_PER_PUNCTUAL_LIGHT;
  data.fill(0, floatOffset, regionEnd);

  let writeIndex = 0;

  // 1. Scene lights. Read the concrete light objects when available so point
  // and spot positions stay f64 until after subtracting the active camera.
  // Packing absolute ECEF into LightCollection's Float32Array first loses
  // sub-meter deltas before the renderer has a chance to make them relative.
  if (sceneLights && sceneLights.length > 0) {
    if (sceneLights.get) {
      for (
        let i = 0;
        i < sceneLights.length && writeIndex < MAX_PUNCTUAL_LIGHTS;
        i++
      ) {
        const lt = sceneLights.get(i);
        const type = lt?.lightType ?? lt?.type ?? 0;
        if (!lt || lt.enabled === false || type < 0 || type > 2) {
          continue;
        }
        const dst = floatOffset + 4 + writeIndex * FLOATS_PER_PUNCTUAL_LIGHT;
        packPunctualLightRecord(data, dst, lt, type, cameraPositionWC);
        writeIndex++;
      }
    } else {
      // Compatibility for collection-like integrations that expose only
      // pack(). Real LightCollection provides get(), so production positions
      // always take the f64-before-f32 path above.
      const packed = sceneLights.pack(scratchLightPack);
      const sceneCount = packed[0] | 0;
      const sceneSlots = Math.min(sceneCount, MAX_PUNCTUAL_LIGHTS);
      for (let i = 0; i < sceneSlots; i++) {
        const src = 4 + i * FLOATS_PER_PUNCTUAL_LIGHT;
        const dst = floatOffset + 4 + writeIndex * FLOATS_PER_PUNCTUAL_LIGHT;
        for (let f = 0; f < FLOATS_PER_PUNCTUAL_LIGHT; f++) {
          data[dst + f] = packed[src + f];
        }
        const type = packed[src + 3] | 0;
        if (type === 1 || type === 2) {
          data[dst + 0] = packed[src + 0] - cameraPositionWC.x;
          data[dst + 1] = packed[src + 1] - cameraPositionWC.y;
          data[dst + 2] = packed[src + 2] - cameraPositionWC.z;
        }
        writeIndex++;
      }
    }
  }

  // 2. glTF KHR_lights_punctual lights -- model space, transformed with
  // model.modelMatrix to get world space. Each entry's
  // position/direction is already model-space (node hierarchy applied
  // at parse time), so multiplying by the model matrix is all that is
  // needed to lift it to world coords.
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
      const type = lt.type ?? lt.lightType ?? 0;
      // Resolve world position / direction. Directional: posOrDir
      // holds a world direction; point/spot: posOrDir holds an RTE world
      // position. Matrix4 and Cartesian3 operate on JS doubles, so subtraction
      // happens before assignment quantizes the small delta to f32.
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
      if (type === 0 /* DIR */) {
        data[dst + 0] = wd?.x ?? 0;
        data[dst + 1] = wd?.y ?? 0;
        data[dst + 2] = wd?.z ?? 0;
      } else {
        data[dst + 0] = (wp?.x ?? 0) - cameraPositionWC.x;
        data[dst + 1] = (wp?.y ?? 0) - cameraPositionWC.y;
        data[dst + 2] = (wp?.z ?? 0) - cameraPositionWC.z;
      }
      data[dst + 3] = type;
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
      if (type === 2 /* SPOT */ && wd) {
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

function packPunctualLightRecord(
  data: Float32Array,
  dst: number,
  light: PunctualLightLike,
  type: number,
  cameraPositionWC: Cartesian3,
) {
  if (type === 0) {
    data[dst + 0] = light.direction?.x ?? 0;
    data[dst + 1] = light.direction?.y ?? 0;
    data[dst + 2] = light.direction?.z ?? 0;
  } else {
    const position = light.position ?? Cartesian3.ZERO;
    data[dst + 0] = position.x - cameraPositionWC.x;
    data[dst + 1] = position.y - cameraPositionWC.y;
    data[dst + 2] = position.z - cameraPositionWC.z;
  }
  data[dst + 3] = type;
  data[dst + 4] = light.color?.red ?? 1;
  data[dst + 5] = light.color?.green ?? 1;
  data[dst + 6] = light.color?.blue ?? 1;
  data[dst + 7] = light.intensity ?? 1;
  data[dst + 8] = light.range ?? 0;
  data[dst + 9] = light.constantAttenuation ?? 0;
  data[dst + 10] = light.linearAttenuation ?? 0;
  data[dst + 11] = light.quadraticAttenuation ?? 0;
  data[dst + 12] = light.innerConeAngle ?? 0;
  data[dst + 13] = light.outerConeAngle ?? 0;
  if (type === 2) {
    data[dst + 16] = light.direction?.x ?? 0;
    data[dst + 17] = light.direction?.y ?? 0;
    data[dst + 18] = light.direction?.z ?? 0;
  }
}

// Scratch Cartesians for the matrix-multiply in `packPunctualLights`
// (avoid per-frame allocation).
const scratchLightVec3a = new Cartesian3();
const scratchLightVec3b = new Cartesian3();

// GPU texture creation from a glTF TextureReader.

/**
 * True when the reader's glTF/CesiumJS sampler requests a mipmapped
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
  resourceGeneration: number,
  textureReader: ReaderOrNull,
  colorSpace: string,
  enqueueMip?: EnqueueMipFn,
  cancelMip?: CancelMipFn,
): GPUTexture | null {
  if (!defined(textureReader)) {
    return null;
  }

  // Try to get the image source from the CesiumJS Texture
  const cesiumTexture = textureReader.texture;
  if (!defined(cesiumTexture)) {
    return null;
  }

  // In WebGPU mode the CesiumJS Texture is backed by WebGLStubTexture, which
  // uploads the image to a real `GPUTexture` and stashes it on
  // `texture._texture._webgpuTexture.texture`. That upload must be consulted
  // first: `cesiumTexture._source` (the original ImageBitmap) is not retained
  // after upload, so reading only that slot leaves every glTF / 3D Tiles
  // texture on the white placeholder.
  const stubWrapper = cesiumTexture._texture;
  const stubGPU = getWebGPUTextureForDevice(
    stubWrapper,
    device,
    resourceGeneration,
  );
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

  // Secondary allocation path, reached only when the CesiumJS Texture has no
  // stub-owned `_webgpuTexture`; the stub path above already allocates and
  // generates a real chain for mipmap-sampler textures. This branch gets a real
  // mip chain too when the source sampler requests mipmaps, so distant tiles
  // trilinear-filter instead of aliasing mip 0, matching the stub path and
  // WebGL. The source here is always an uncompressed ImageBitmap — compressed
  // KTX2 arrives with `internalFormat` and takes `Texture.create` with its own
  // transcoded chain, never this branch — so `rgba8unorm[-srgb]` is
  // RENDER_ATTACHMENT-capable for the blit. Mip generation is routed through
  // the frame-owned `enqueueTextureMipGeneration`, never a private submit from
  // draw emission. Falls back to a single level when no sink is provided or
  // mipmaps are not requested.
  const wantsMips = defined(enqueueMip) && readerRequestsMipmap(textureReader);
  const mipLevelCount = wantsMips
    ? WebGPUMipmapGenerator.calculateMipLevelCount(width, height)
    : 1;

  let gpuTexture: GPUTexture | undefined;
  try {
    gpuTexture = device.createTexture({
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
      const accepted = enqueueMip(gpuTexture, format, mipLevelCount);
      if (accepted === false) {
        try {
          gpuTexture.destroy();
        } catch {
          // Rejected work is unpublished; retirement is cleanup-only.
        }
        return null;
      }
    }

    return gpuTexture;
  } catch (_e) {
    if (defined(gpuTexture) && defined(cancelMip)) {
      try {
        cancelMip(gpuTexture);
      } catch {
        // Cancellation is bookkeeping; candidate destruction remains owned.
      }
    }
    try {
      gpuTexture?.destroy();
    } catch {
      // Preserve the upload failure contract. The candidate has never been
      // published, so a lost-device destroy error is cleanup-only.
    }
    // Image source may not be usable (e.g., already transferred)
    return null;
  }
}

function isTextureOwnedByCompatibilityStub(
  device: GPUDevice,
  resourceGeneration: number,
  textureReader: ReaderOrNull,
  texture: GPUTexture,
): boolean {
  return (
    getWebGPUTextureForDevice(
      textureReader?.texture?._texture,
      device,
      resourceGeneration,
    )?.texture === texture
  );
}

// Vertex buffer creation.

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
  try {
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  } catch (error) {
    try {
      buffer.destroy();
    } catch {
      // Preserve the upload failure; the buffer was never published.
    }
    throw error;
  }
}

/**
 * Expands a flat per-vertex color array to dense RGBA (4 floats per vertex).
 * glTF COLOR_0 may be VEC3 (RGB,
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

// Joint matrix buffer.

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
    // There is no standalone skinning bind group: the renderer composes the
    // merged group 2 bind group per frame from `nodeCache.jointBuffer`
    // directly.
  }

  // Upload joint matrices
  device.queue.writeBuffer(
    nodeCache.jointBuffer,
    0,
    skinData.packedJointMatrices,
  );
}

/**
 * Lazily allocates the per-node prev-frame
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

// Per-primitive cache.

/**
 * Pushes a primitive's generated metadata WGSL chunk and class hash into the
 * per-Model pipeline cache immediately before any `getPipeline*` build, so the
 * compiled module prepends the right `struct Metadata` and is keyed by the
 * right class. For non-metadata primitives this clears the cache's metadata
 * state so a stale chunk from a sibling metadata primitive cannot leak in. It
 * costs two field writes, and must run before every pipeline (re)build that
 * could compile a fresh module for this primitive.
 *
 * @param {WebGPUModelPipelineCache} pipelineCache
 * @param {object} primCache per-primitive cache slot
 * @private
 */
function applyPrimitiveMetadataToPipelineCache(
  pipelineCache: PipelineCacheLike,
  primCache: PrimitiveRenderData,
) {
  // Sticky topology rides the same "set before every getPipeline* build"
  // contract as the metadata/customShader chunks below. Both halves of the axis
  // are replayed together; the decision itself is made once in preparation by
  // `realizeModelPrimitiveTopology`. Defaults to triangle-list for records that
  // carry no topology field.
  pipelineCache.setPrimitiveTopology(
    primCache?.topology ?? "triangle-list",
    primCache?.stripIndexFormat,
  );
  if (defined(primCache?._metadataWGSL)) {
    pipelineCache.setMetadataWGSL(
      primCache._metadataWGSL,
      primCache._metadataClassHash | 0,
      primCache._metadataMatTransport === true,
    );
  } else {
    pipelineCache.clearMetadataWGSL();
  }
  // Set/clear the customShader chunk the same way, so
  // `_getOrCreateShaderModule` prepends it and keys the module by the
  // customShader class for every pipeline (re)build of this primitive.
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
 * (Re)builds the model-level native-WGSL customShader resources onto
 * `cache._customShader`:
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
 * A model's {@link CustomShader#translucencyMode} overrides the primitive's
 * effective alpha mode, matching WebGL's {@link CustomShaderPipelineStage}
 * (which sets `alphaOptions.pass`). TRANSLUCENT forces the primitive into the
 * blended translucent pass; OPAQUE forces the opaque pass; INHERIT (the
 * default) leaves the glTF material's alpha mode untouched.
 *
 * `baseInfo` is an immutable renderer-neutral descriptor. `matInfo` is a
 * renderer-owned view for exactly one model primitive generation. Resetting its
 * effective alpha from the base on every update makes a dynamic transition from
 * TRANSLUCENT/OPAQUE back to INHERIT correct without rebuilding the base or
 * leaking mutable state into another view. The effective alpha cascades to every
 * downstream consumer: pipeline blend state, tile-batch passClass, draw-pass
 * selection, and the BLEND depth-write variant.
 *
 * A model with no customShader, or one whose translucencyMode is INHERIT, takes
 * the early return, so matInfo is unchanged and the primitive keeps its
 * authored alpha mode.
 *
 * @param {object} matInfo renderer-owned effective view
 * @param {object} baseInfo immutable authored material descriptor
 * @param {import("../../Scene/Model/Model.js").default} model
 * @private
 */
function resolveCustomShaderAlphaMode(
  authoredAlphaMode: number,
  model: ModelLike,
): number {
  const customShader = model.customShader;
  if (!defined(customShader)) {
    return authoredAlphaMode;
  }
  const mode = customShader.translucencyMode;
  if (mode === CustomShaderTranslucencyMode.TRANSLUCENT) {
    return AlphaModes.BLEND;
  }
  if (mode === CustomShaderTranslucencyMode.OPAQUE) {
    return AlphaModes.OPAQUE;
  }
  return authoredAlphaMode;
}

function applyCustomShaderTranslucency(
  matInfo: MaterialInfo,
  baseInfo: MaterialInfo,
  model: ModelLike,
  effectiveAlphaMode = resolveCustomShaderAlphaMode(baseInfo.alphaMode, model),
) {
  resetMaterialInfoView(matInfo, baseInfo);
  matInfo.alphaMode = effectiveAlphaMode;
  // Alpha mode is represented twice: the CPU pass/pipeline classification
  // reads `alphaMode`, while every WGSL variant reads these material flag
  // bits. Keep the renderer-owned view coherent without mutating the cached
  // authored base. Otherwise a forced BLEND pipeline would still shade with
  // authored OPAQUE/MASK alpha semantics (and INHERIT could retain a stale
  // override from the previous frame).
  matInfo.materialFlags =
    baseInfo.materialFlags &
    ~(MaterialFlags.ALPHA_MODE_MASK | MaterialFlags.ALPHA_MODE_BLEND);
  if (effectiveAlphaMode === AlphaModes.MASK) {
    matInfo.materialFlags |= MaterialFlags.ALPHA_MODE_MASK;
  } else if (effectiveAlphaMode === AlphaModes.BLEND) {
    matInfo.materialFlags |= MaterialFlags.ALPHA_MODE_BLEND;
  }
}

/**
 * Native pipelines and every lazy derived variant are keyed by effective alpha
 * semantics. A same-object CustomShader can change translucencyMode without
 * changing either immutable descriptor identity, so the effective value is an
 * explicit primitive-generation signature.
 *
 * @private
 */
function hasMaterialGenerationChanged(
  primCache: PrimitiveRenderData,
  baseInfo: MaterialInfo,
  effectiveAlphaMode: number,
): boolean {
  return (
    primCache._materialBase !== baseInfo ||
    primCache._effectiveAlphaMode !== effectiveAlphaMode
  );
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
    // Keep the common no-custom-shader path write-free. `undefined` and null
    // are both absence states throughout this renderer; only stamp null when
    // a live native resource was actually retired.
    if (defined(cache._customShader)) {
      cache._customShader = null;
    }
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
 * Returns true only when native custom-shader resources can exist or need to
 * be retired. The default representative-content path has neither a custom
 * shader nor a cached native realization, so it can skip the function call
 * and all of its feature checks. Native WGSL text always enters, including an
 * in-place GLSL-to-WGSL mutation, and a cached realization always enters so
 * runtime removal or a WGSL-to-GLSL mutation still destroys its GPU buffer.
 */
function shouldPrepareModelCustomShaderResources(
  model: ModelLike,
  cache: ModelWebGPUCache,
): boolean {
  const customShader = model.customShader;
  return (
    defined(cache._customShader) ||
    defined(customShader?.wgslFragmentShaderText) ||
    defined(customShader?.wgslVertexShaderText)
  );
}

/**
 * Builds the customShader group-1 bind-group entries
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
  const placeholderView = pipelineCache.getDefaultTextureView(
    pipelineCache.defaultWhiteTexture,
  );
  const textureFields = cs.textureFields ?? [];
  for (let k = 0; k < MAX_CUSTOM_TEXTURES; k++) {
    let view = placeholderView;
    if (k < textureFields.length) {
      const tex = cs.customShader._textureManager?.getTexture(
        textureFields[k].uniformName,
      );
      const stubTexture = getWebGPUTextureForDevice(
        tex?._texture ?? (tex as unknown as StubTextureWrapper),
        cache.device,
        cache.resourceGeneration,
      );
      const wgpuView = stubTexture?.view;
      if (defined(wgpuView)) {
        view = wgpuView;
      }
    }
    entries.push({
      binding: CUSTOM_SHADER_TEXTURE_BINDING_BASE + k,
      resource: view,
    });
  }
  // A single shared sampler serves all custom textures.
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
  cancelMip?: CancelMipFn,
): PrimitiveRenderData {
  if (defined(cache.primitives[primKey])) {
    return cache.primitives[primKey];
  }

  // The topology realization, computed once per primitive here in preparation
  // and never revisited at draw time. It resolves the glTF draw mode to a
  // WebGPU topology, decides the strip index format, repairs uint8
  // primitive-restart sentinels for the restart-capable modes, closes
  // LINE_LOOPs, expands TRIANGLE_FANs, and synthesizes indices for the
  // non-indexed modes that need them. Everything downstream — the index
  // buffer, every pipeline descriptor, every pipeline cache key, and the
  // shadow cast key — reads this record rather than re-deriving any of it.
  const topologyRealization = realizeModelPrimitiveTopology({
    primitiveType: geometry.primitiveType,
    indexData: geometry.indexData,
    vertexCount: geometry.vertexCount,
    indexSourceComponentBytes: geometry.indexSourceComponentBytes,
  });

  const primCache: PrimitiveRenderData = {
    positionBuffer: null,
    normalBuffer: null,
    tangentBuffer: null,
    uvBuffer: null,
    colorBuffer: null,
    jointsBuffer: null,
    weightsBuffer: null,
    featureIdBuffer: null,
    // Per-vertex scalar metadata buffer (EXT_structural_metadata property
    // attribute), bound at vertex slot 9 when MODEL_HAS_METADATA is set.
    // Created from `geometry.metadataData` below; owned by
    // `WebGPUModelMetadata.ensureMetadataResources` for the GPU upload.
    _metadataBuffer: null,
    // True when the slot-9 buffer carries the widened 16-float MAT3/MAT4
    // transport (stride 64, locations 9-12). Persisted from
    // `geometry.metadataMatTransport` below and fed to the pipeline cache's
    // sticky state on every pipeline (re)build.
    _metadataMatTransport: false,
    // Property-texture bind-group entries (bindings 39..), resolved and
    // uploaded by `ensurePropertyTextureResources`. Spliced into the merged
    // group-1 bind group when MODEL_HAS_PROPERTY_TEXTURES is set.
    _propertyTextureResources: null,
    propertyTextureEntries: null,
    // Property-table bind-group entries (bindings 44-45), resolved and
    // uploaded by `ensurePropertyTableResources`. Spliced into the merged
    // group-1 bind group when MODEL_HAS_PROPERTY_TABLES is set.
    _propertyTableResources: null,
    propertyTableEntries: null,
    indexBuffer: null,
    indexCount: 0,
    indexFormat: "uint16",
    vertexCount: geometry.vertexCount,
    // The realized topology axis. Every pipeline (re)build for this primitive
    // feeds both fields to the pipeline cache via
    // `applyPrimitiveMetadataToPipelineCache`.
    topology: topologyRealization.topology,
    stripIndexFormat: topologyRealization.stripIndexFormat,
    materialBindGroup: null,
    textureBindGroup: null,
    pipeline: null,
    gpuTextures: [],
    hasSkinningAttributes: false,
  };

  try {
    // Position buffer (model-space, 3 floats per vertex, not a high/low split)
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
      // The slot-4 vertex layout is float32x4 (16-byte stride), but a glTF
      // COLOR_0 accessor may be VEC3 (12-byte stride). `normalizeColorData`
      // converts the component type but preserves the component count, so a
      // VEC3 source produces a 12-byte-stride buffer that the GPU reads at a
      // 16-byte stride, giving progressively shifted, corrupted vertex colors.
      // Widen RGB→RGBA (alpha = 1.0) so the stride matches the layout,
      // mirroring the edge emitter's path; `expandColorsToRGBA` is a no-op for
      // VEC4 sources.
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

    // `_FEATURE_ID_0` (b3dm `_BATCHID`) vertex
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

    // EXT_structural_metadata property-attribute vertex buffer (slot 9).
    // `geometry.metadataData` is the per-vertex scalar resolved at the
    // extractPrimitiveGeometry call site; the GPU upload is owned by
    // `WebGPUModelMetadata.ensureMetadataResources`, parallel to how the
    // featureId path splits buffer ownership. Only present when the model
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
    // Property-texture GPU resources. Upload each unique physical property
    // texture (sourced from the glTF texture reader, like PBR textures) plus
    // the shared property sampler, producing the bind-group entries spliced
    // into group 1 below. Only when the primitive maps at least one property
    // texture; non-property-texture models leave `propertyTextureEntries` null
    // and stay byte-identical.
    if (
      geometry.hasPropertyTextures &&
      defined(geometry.propertyTextureLayout)
    ) {
      const ptResources = ensurePropertyTextureResources(
        device,
        primCache,
        geometry.propertyTextureLayout,
        (reader) => {
          const texture = createGPUTextureFromReader(
            device,
            cache.resourceGeneration,
            reader,
            "linear",
            enqueueMip,
            cancelMip,
          );
          const owned =
            defined(texture) &&
            !isTextureOwnedByCompatibilityStub(
              device,
              cache.resourceGeneration,
              reader,
              texture,
            );
          return {
            texture,
            owned,
            release:
              owned && defined(texture)
                ? () => destroyOwnedModelTextureBestEffort(texture, cancelMip)
                : undefined,
          };
        },
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
    // Property-table GPU resources. Re-upload the loader's retained packed
    // RGBA8 bytes into a single rgba8unorm GPUTexture (rows = properties,
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
    // Persist the generated WGSL chunk and class hash on the primitive cache so
    // every pipeline (re)build for this primitive (color / pick / depth-write /
    // velocity / classification) prepends the same chunk and keys its module by
    // the same class. The renderer feeds them to the pipeline cache via
    // `setMetadataWGSL` immediately before each `getPipeline*` call below.
    // Persisted when the primitive has either attributes or textures.
    if (
      (geometry.hasMetadata ||
        geometry.hasPropertyTextures ||
        geometry.hasPropertyTables) &&
      defined(geometry.metadataWGSL)
    ) {
      primCache._metadataWGSL = geometry.metadataWGSL;
      primCache._metadataClassHash = geometry.metadataClassHash | 0;
      // Persist the widened-transport flag so every pipeline (re)build for this
      // primitive feeds the pipeline cache's sticky `metadataMatTransport`
      // state alongside the chunk.
      primCache._metadataMatTransport = geometry.metadataMatTransport === true;
    }

    // The realized index list. `realizedIndexData` is the source array by
    // reference whenever nothing had to change, so the TRIANGLES and
    // already-native paths allocate nothing here.
    //
    // Index synthesis covers every non-indexed mode except TRIANGLES, because
    // WebGPU validates a non-indexed `draw(vertexCount)` CPU-side against every
    // vertex-step buffer's bound size, and the missing-attribute slots
    // (normal/tangent/uv/joints/weights on a typical point cloud) bind the
    // pipeline cache's 1-element default buffers. That is fine for
    // `drawIndexed`, whose out-of-range vertex fetches clamp to zero via robust
    // access, but a hard validation error for `draw()` ("Vertex range requires
    // a larger buffer"). Sequential indices are GPU-equivalent for every
    // topology. Non-indexed TRIANGLES primitives keep the plain draw() path and
    // share the same validation gap when attributes are missing.
    //
    // The realized list is written to the geometry view, never to the cached
    // base descriptor — `resetPrimitiveGeometryView` restores these three
    // fields from the base on every reuse — so downstream readers see the list
    // that was actually uploaded.
    const realizedIndexData = topologyRealization.indexData;
    if (defined(realizedIndexData)) {
      geometry.indexData = realizedIndexData;
      geometry.indexCount = topologyRealization.indexCount;
      geometry.indexType =
        topologyRealization.indexFormat === "uint32"
          ? "UNSIGNED_INT"
          : "UNSIGNED_SHORT";

      primCache.indexFormat = topologyRealization.indexFormat;
      primCache.indexCount = topologyRealization.indexCount;
      // WebGPU requires the `writeBuffer` source byteLength to be a
      // multiple of 4. Uint16 index buffers with an odd index count
      // produce `byteLength % 4 === 2`, which `writeBuffer` rejects, and
      // real glTF assets have them — CZML Model Articulations is one.
      // Pad both the buffer and the source to the nearest 4 bytes; the
      // extra slot is never read, because `indexCount` stays at the
      // geometry's authoritative value.
      const indexByteLength = realizedIndexData.byteLength;
      const alignedIndexByteLength = (indexByteLength + 3) & ~3;
      primCache.indexBuffer = device.createBuffer({
        label: `Prim index`,
        size: Math.max(alignedIndexByteLength, 4),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      if (alignedIndexByteLength === indexByteLength) {
        device.queue.writeBuffer(primCache.indexBuffer, 0, realizedIndexData);
      } else {
        const padded = new Uint8Array(alignedIndexByteLength);
        padded.set(
          new Uint8Array(
            realizedIndexData.buffer,
            realizedIndexData.byteOffset,
            indexByteLength,
          ),
        );
        device.queue.writeBuffer(primCache.indexBuffer, 0, padded);
      }
    }

    // Pipeline (varies by alpha mode and double-sided).
    // Select the materialDefines bitmask from the primitive's material
    // flags. The value is tracked on primCache so subsequent pipeline
    // lookups (pick, velocity, classification, depth-write) stay
    // consistent across passes for this primitive. It also filters the
    // texture-entries array and selects the matching per-variant
    // materialBGL when building the merged group 1 bind group below.
    //
    // The primitive's TEXCOORD_1 attribute presence drives
    // MODEL_HAS_TEXCOORD_1. When unset, the pipeline omits vertex buffer
    // slot 7 (an 8-slot layout, fitting Edge's adapter cap of
    // `maxVertexBuffers = 8`); when set, the layout includes slot 7
    // (9 slots, requiring an adapter with 9 or more).
    //
    // Slot 8 (featureId0) works the same way. With both flags off — the
    // common case for standard glTF models without multi-UV or batched
    // feature IDs — the pipeline lands at 7 slots, leaving headroom on
    // Edge's adapter. The implicit-range synthesis above sets
    // `geometry.hasFeatureId0 = true` when a batched 3D Tile expects
    // feature IDs but the glTF accessor is missing, so this read sees the
    // final, post-synthesis value.
    let materialDefines = computeMaterialDefines(matInfo.materialFlags);
    if (geometry.hasTexCoord1) {
      materialDefines |= ShaderDefine.MODEL_HAS_TEXCOORD_1;
    }
    if (geometry.hasFeatureId0) {
      materialDefines |= ShaderDefine.MODEL_HAS_FEATURE_ID_0;
    }
    // Presence gate. Flip MODEL_HAS_METADATA only when the primitive
    // actually carries a property-attribute scalar (resolved into
    // `geometry.metadataData` upstream and uploaded above). That adds vertex
    // slot 9 to the layout and activates the WGSL metadata ifdef blocks. When
    // unset (the common case), the bit is absent, the layout omits slot 9,
    // the WGSL preprocessor strips every metadata block, and the model is
    // byte-identical to a build without metadata support.
    if (geometry.hasMetadata && defined(primCache._metadataBuffer)) {
      materialDefines |= ShaderDefine.MODEL_HAS_METADATA;
    }
    // Presence gate. Flip MODEL_HAS_PROPERTY_TEXTURES only when the primitive
    // maps at least one GPU-compatible property texture and its bind-group
    // entries resolved. That selects the property-texture materialBGL variant
    // (extra sampled-texture bindings 39..) and activates the generated chunk's
    // binding/sampling code. It is independent of MODEL_HAS_METADATA: a model
    // can have property textures without property attributes, and vice versa.
    // When unset (the common case), the bit is absent, the minimal materialBGL
    // is used, and the model is byte-identical to a build without property
    // textures.
    if (
      geometry.hasPropertyTextures &&
      defined(primCache.propertyTextureEntries)
    ) {
      materialDefines |= ShaderDefine.MODEL_HAS_PROPERTY_TEXTURES;
    }
    // Presence gate. Flip MODEL_HAS_PROPERTY_TABLES only when the primitive
    // maps a GPU-compatible property table and its bind-group entries
    // resolved. That selects the property-table materialBGL variant (extra
    // sampled-texture binding 44 and sampler 45) and activates the generated
    // chunk's textureLoad code. It is independent of the attribute and texture
    // metadata bits. When unset (the common case), the bit is absent, the
    // minimal materialBGL is used, and the model is byte-identical to a build
    // without property tables.
    if (geometry.hasPropertyTables && defined(primCache.propertyTableEntries)) {
      materialDefines |= ShaderDefine.MODEL_HAS_PROPERTY_TABLES;
    }
    // OR in the model-level customShader defines (MODEL_HAS_WGSL_CUSTOM_SHADER
    // plus an optional _VERTEX) and stash the generated chunk and hash on the
    // primitive, so every pipeline (re)build for this primitive prepends it and
    // keys its module by the customShader class. When the model has no
    // native-WGSL customShader, `cache._customShader` is null: no bits, no
    // chunk, byte-identical.
    if (defined(cache._customShader)) {
      materialDefines |= cache._customShader.defines;
      primCache._customShaderWGSL = cache._customShader.chunk;
      primCache._customShaderClassHash = cache._customShader.classHash | 0;
    }
    primCache.materialDefines = materialDefines;
    // Feed the generated metadata chunk and class hash to the pipeline cache
    // before the build; this is a no-op clear for non-metadata primitives.
    applyPrimitiveMetadataToPipelineCache(pipelineCache, primCache);
    primCache.pipeline = pipelineCache.getPipeline(
      matInfo.alphaMode,
      matInfo.isDoubleSided,
      materialDefines,
    );

    // Translucent BLEND primitives eagerly cache the depth-write variant
    // too. A 3D-tile model whose content carries this primitive may set
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
      cache.resourceGeneration,
      pipelineCache,
      matInfo,
      enqueueMip,
      cancelMip,
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
    // Cache per-binding views and samplers on the prim cache so the
    // texture bind group can be rebuilt cheaply when the SceneRenderer's
    // refraction capture publishes a new `_refractionSceneView`. Without
    // this cache the rebuild would have to re-create the views every
    // frame from `textures.*`.
    primCache.textureViews = {
      baseColor: pipelineCache.getDefaultTextureView(textures.baseColor),
      normal: pipelineCache.getDefaultTextureView(textures.normal),
      metallicRoughness: pipelineCache.getDefaultTextureView(
        textures.metallicRoughness,
      ),
      emissive: pipelineCache.getDefaultTextureView(textures.emissive),
      occlusion: pipelineCache.getDefaultTextureView(textures.occlusion),
      clearcoat: pipelineCache.getDefaultTextureView(textures.clearcoat),
      specularColor: pipelineCache.getDefaultTextureView(
        textures.specularColor,
      ),
      anisotropy: pipelineCache.getDefaultTextureView(textures.anisotropy),
      iridescence: pipelineCache.getDefaultTextureView(textures.iridescence),
      sheenColor: pipelineCache.getDefaultTextureView(textures.sheenColor),
      thickness: pipelineCache.getDefaultTextureView(textures.thickness),
      clearcoatRoughness: pipelineCache.getDefaultTextureView(
        textures.clearcoatRoughness,
      ),
      clearcoatNormal: pipelineCache.getDefaultTextureView(
        textures.clearcoatNormal,
      ),
      sheenRoughness: pipelineCache.getDefaultTextureView(
        textures.sheenRoughness,
      ),
      specularFactor: pipelineCache.getDefaultTextureView(
        textures.specularFactor,
      ),
      iridescenceThickness: pipelineCache.getDefaultTextureView(
        textures.iridescenceThickness,
      ),
      transmission: pipelineCache.getDefaultTextureView(textures.transmission),
      refractionPlaceholder: pipelineCache.getDefaultTextureView(
        textures.refractionScene,
      ),
    };
    primCache.textureSamplers = {
      base: baseSampler || defSampler,
      normal: normalSampler || defSampler,
      mr: mrSampler || defSampler,
      emissive: emissiveSampler || defSampler,
      occlusion: occlusionSampler || defSampler,
      def: defSampler,
    };
    // Track texture entries on the primCache. The full merged group 1
    // bind group is built per frame at the draw command emission site;
    // this is just the cached texture portion.
    // Entries are filtered by `primCache.materialDefines`: the basic
    // variant emits bindings 2-11 only, the full variant emits 2-25.
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
  } catch (error) {
    // Primitive realization is one ownership transaction. Nothing is visible
    // through cache.primitives until every buffer, texture view and bind-group
    // entry has been built. If any later allocation/publication step fails,
    // drain everything already attached to the unpublished cache while
    // preserving the construction error that triggered rollback.
    try {
      destroyPrimitiveCacheResources(primCache, cancelMip);
    } catch {
      // Best-effort rollback: the primary realization failure is authoritative.
    }
    throw error;
  }
}

/**
 * Returns the texture portion of the merged group 1 bind group as an
 * `entries[]` array. Bindings 0-1 (material+light UBOs) and 26-32 (featureId)
 * are spliced in at the renderer's per-frame draw-command emission site.
 * Texture binding numbers start at 2 because slots 0-1 are occupied by the
 * merged material/light UBOs.
 *
 * The texture entries for bindings 12-25 are gated on the variant's
 * `materialDefines` mask: the basic variant (`materialDefines = 0`) emits PBR
 * bindings 2-11 only, while the full variant (`MODEL_HAS_KHR_TEXTURES` set)
 * emits 2-25. The returned array must match the layout of the per-variant
 * `materialBGL` fetched via
 * `pipelineCache.getOrCreateMaterialBGL(materialDefines)`, or
 * `device.createBindGroup` will reject the entry list.
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
  // matching gate define is set. Every KHR slot shares a single gate
  // (`MODEL_HAS_KHR_TEXTURES`); once the WGSL ifdefs are split
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

  // 39..: property-texture block. The renderer resolved and padded these to
  // the full MAX_PROPERTY_TEXTURES slot count (real textures plus 1×1
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

  // 44-45: property-table block (texture + sampler). Emitted only when
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

  // 50+: customShader UBO plus custom texture pairs.
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
 * Builds the merged group 1 bind group. Per-frame allocation; cheap because the
 * entry objects are small and the underlying GPU resources are reused.
 *
 * The layout is per-variant. The caller passes the primitive's
 * `materialDefines` mask, and this function fetches (or builds, on first use)
 * the matching `GPUBindGroupLayout` via
 * `pipelineCache.getOrCreateMaterialBGL(materialDefines)`. The `textureEntries`
 * array must already be filtered to match the layout;
 * `getModelTextureEntries` honors the same mask.
 *
 * @private
 */
function buildMergedMaterialBindGroup(
  device: GPUDevice,
  pipelineCache: PipelineCacheLike,
  materialBuffer: WebGPUBuffer | null,
  textureEntries: GPUBindGroupEntry[] | null | undefined,
  featureIdEntries: GPUBindGroupEntry[] | null | undefined,
  iblEntries: GPUBindGroupEntry[] | null | undefined,
  materialDefines: number,
  frameState: CesiumFrameState,
) {
  return device.createBindGroup({
    // Label group 1 so the settled-frame bind-group probe, and the
    // API-instrumentation lane, can attribute merged-material creates by
    // label, exactly like the group-2 instance cache.
    label: "Model merged material bind group",
    layout: pipelineCache.getOrCreateMaterialBGL(materialDefines | 0),
    entries: [
      // Binding 1 (light) does not belong to this group: it is a per
      // (model, view) block bound from the group-0 arena. Every resource left
      // here is per-primitive, which is what keeps this bind group's identity
      // stable across frames and its cache at a 100% hit rate.
      { binding: 0, resource: { buffer: materialBuffer.buffer } },
      ...textureEntries,
      ...(featureIdEntries ?? pipelineCache.defaultFeatureIdEntries()),
      ...(iblEntries ?? defaultIBLEntries(pipelineCache, frameState)),
    ],
  });
}

/**
 * Placeholder IBL bind-group entries (33-36).
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
 * Bindings 37/38 (split-sum
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
 * Resolved per-model IBL identities. These five identities fully determine the
 * group-1 IBL bind-group entries (bindings 33-38). A stable identity tuple lets
 * {@link getOrCreateModelIBLEntries} hand back a byte-identical entries array
 * whose object identity is stable across settled frames, which in turn lets the
 * merged-material bind-group cache key on a single array reference.
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
 * Resolves the per-model IBL identities from the model's `imageBasedLighting`
 * cache and environment-map manager, falling back to the pipeline cache's
 * neutral placeholders when the prefilter has not run yet.
 * `WebGPUImageBasedLighting.update` populates `_webgpuSpecularView`,
 * `_webgpuDiffuseView`, `_webgpuSampler`, `_webgpuSHBuffer` on the model's IBL
 * instance once the radiance and irradiance prefilter has generated mips.
 *
 * Returning the resolved identities rather than a freshly built entries array
 * is what lets the memoizing wrapper compare them and keep the entries-array
 * identity stable. The neutral-placeholder path returns the same bindings
 * `defaultIBLEntries` produces (bindings 33/34 both point at
 * `defaultIBLCubemapView`).
 * @private
 */
function resolveModelIBL(
  model: ModelLike,
  pipelineCache: PipelineCacheLike,
  frameState: CesiumFrameState,
): ResolvedModelIBL {
  // Binding 37 is the split-sum environment BRDF LUT. It flips exactly once,
  // from the 1x1 placeholder to the generated table, so any memo keyed on the
  // IBL identities has to include it or that upgrade is never observed.
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

  // Source precedence, mirroring WebGL's ImageBasedLightingPipelineStage:
  //   specular = explicit specularEnvironmentMaps if configured,
  //              else environmentMapManager.radianceCubeMap,
  //              else the (black) default.
  //   diffuse  = explicit SH if the user supplied coefficients,
  //              else environmentMapManager irradiance / SH,
  //              else the (low-gray) default.
  //
  // Presence of `_webgpuSpecularView` / `_webgpuDiffuseView` is not a usable
  // test for "an explicit source is configured".
  // `WebGPUImageBasedLighting.update` always resolves those to its 1x1 black
  // specular and 30/255 gray diffuse placeholders when no explicit
  // `specularEnvironmentMaps` is configured, so keying on definedness would
  // let the placeholder shadow the env-manager's real atmosphere-derived IBL,
  // leaving at-rest models with a flat gray ambient and no sky reflection.
  // The placeholder must therefore count as "no explicit source", so that the
  // env-manager wins exactly as it does on WebGL.
  const hasExplicitSpecular =
    defined(ibl?._specularEnvironmentCubeMap) &&
    (ibl._webgpuMaxMipLevel ?? 0) > 0;
  const hasExplicitDiffuse = ibl?._webgpuHasSH === true;

  const envManager = model?.environmentMapManager;
  if (defined(envManager)) {
    if (!hasExplicitDiffuse && defined(envManager._webgpuIBLDiffuseView)) {
      diffuseView = envManager._webgpuIBLDiffuseView;
      // Prefer the env-manager's atmosphere-derived SH-L2 coefficients,
      // matching WebGL's czm_sphericalHarmonics diffuse-IBL path. The SH
      // buffer's own `control.w` gate makes the shader evaluate SH instead
      // of sampling the irradiance cubemap, which over-brightens the diffuse
      // by roughly 20-30%, worst in blue. The irradiance cubemap above stays
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
    // `defaultIBLEntries`, where bindings 33 and 34 both point at
    // `defaultIBLCubemapView`.
    return {
      diffuseView: pipelineCache.defaultIBLCubemapView,
      specularView: pipelineCache.defaultIBLCubemapView,
      sampler: pipelineCache.defaultIBLSampler,
      shBuffer: pipelineCache.defaultSHBuffer,
      brdfLutView,
    };
  }
  // SH falls back to the cache's default (zeros plus an inactive flag) when
  // neither the explicit IBL nor the env manager publishes one. The shader
  // gates on `sh.control.w`, so the default simply makes the diffuse path use
  // the irradiance cubemap, which is the correct source when the env manager
  // is driving.
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
 * identities. Binding order and resources match what `defaultIBLEntries` plus
 * `brdfLutEntries` produce.
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
 * Memoized per-model IBL entries. Resolves the five IBL identities every frame
 * (cheap object reads) but returns the same entries array while they are
 * unchanged, so the merged-material bind-group cache can treat the array
 * reference as a single revision token. Without the memo that cache would miss
 * on a fresh array every settled frame and appear to work while still creating
 * just as many bind groups. The memo also carries the brdf-LUT and env-manager
 * view flips, so a placeholder-to-real upgrade rebuilds exactly once.
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
 * Builds the merged group 2 bind group (7 entries: current joint/morph/instance
 * data plus their previous-frame counterparts). Falls through to default
 * placeholder buffers when a primitive has no skinning, no morph targets or no
 * instancing — the shader gates on FLAG_HAS_SKINNING / FLAG_HAS_MORPH_TARGETS /
 * FLAG_HAS_INSTANCING, so placeholder contents are never sampled.
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
        // Previous-frame joint matrices for TAA velocity. Falls back to
        // the identity buffer (the same default as binding 0) so
        // non-skinned primitives produce no skinning velocity
        // contribution. Skinned primitives that have not yet captured a
        // previous frame fall back to the current joint buffer, so
        // velocity is zero on the first frame of an animation rather
        // than wildly wrong from the identity.
        binding: 4,
        resource: { buffer: resolvedPrevJointBuffer },
      },
      {
        // Previous-frame morph weights uniform. Falls back to the
        // current weights when no prev mirror exists yet (the first
        // morphed frame), and to the zero-weights default when there is
        // no morph at all.
        binding: 5,
        resource: { buffer: resolvedPrevMorphWeightBuffer },
      },
      {
        // Previous-frame instance transforms. Static GPU instancing, the
        // only case currently produced, aliases the current buffer for a
        // zero velocity contribution. Animated EXT_mesh_gpu_instancing
        // assets would override it.
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

// The three merged-material variants share one builder but must not alias each
// other's cache: they differ only by material buffer (primary / silhouette /
// translucent). Each variant gets its own per-primitive cache slot.
const MERGED_MATERIAL_SLOT_PRIMARY = 0;
const MERGED_MATERIAL_SLOT_SILHOUETTE = 1;
const MERGED_MATERIAL_SLOT_TRANSLUCENT = 2;

/**
 * Per-primitive merged group-1 (material + textures + featureId + IBL)
 * bind-group cache, mirroring the group-2 instance cache. Bind groups are
 * immutable but the buffers and textures they reference are updated in place
 * every frame (material UBO writeBuffer and similar), so rebuilding this group
 * every frame provides no freshness benefit. Exact resource identity catches
 * every real replacement:
 *   - `layout`          — per-`materialDefines` variant BGL
 *   - `materialBuffer`  — primary / silhouette / translucent UB (slot-keyed)
 *   - `textureEntries`  — rebuilt only on a deferred-placeholder upgrade or a
 *                         refraction-view change, so its array identity is the
 *                         invalidation token; it must never be cloned
 *   - `featureIdEntries`— stable `primCache._featureIdEntries` array or null;
 *                         null (default entries spliced by the builder) is its
 *                         own cache state
 *   - `iblEntries`      — the memoized array from {@link getOrCreateModelIBLEntries},
 *                         one reference summarising the five IBL identities
 * A cache hit performs zero `createBindGroup` calls; any identity change costs
 * exactly one rebuild.
 *
 * The light UB is deliberately absent from this key, because it is bound from
 * the group-0 arena. Were it a ring slice in this group instead, the cache
 * would have to key on the ring page, which rotates every frame, multiplying
 * every loaded primitive's resident group-1 bind groups by the ring's page
 * count.
 * @private
 */
function getOrCreateMergedMaterialBindGroup(
  primCache: PrimitiveRenderData,
  slot: number,
  device: GPUDevice,
  pipelineCache: PipelineCacheLike,
  materialBuffer: WebGPUBuffer | null,
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
function destroyOwnedModelTextureBestEffort(
  texture: GPUTexture,
  cancelMip?: CancelMipFn,
): void {
  try {
    cancelMip?.(texture);
  } catch {
    // Cancellation is advisory bookkeeping; native ownership still drains.
  }
  try {
    texture.destroy();
  } catch {
    // Rollback callers preserve the allocation/publication error.
  }
}

function createMaterialTextures(
  device: GPUDevice,
  resourceGeneration: number,
  pipelineCache: PipelineCacheLike,
  matInfo: MaterialInfo,
  enqueueMip?: EnqueueMipFn,
  cancelMip?: CancelMipFn,
) {
  const created: GPUTexture[] = [];
  const defWhite = pipelineCache.defaultWhiteTexture;
  const defNormal = pipelineCache.defaultNormalTexture;
  const defBlack = pipelineCache.defaultBlackTexture;
  // Track which slots fell back to the default placeholder texture
  // because the matching reader had not resolved its image source yet.
  // The per-frame `refreshDeferredTextures` helper polls these slots
  // and swaps in the real GPUTexture as soon as the reader is ready.
  // Without this, models whose textures load after the first
  // `ensurePrimitiveCache` call render with white-fallback bind groups
  // for their entire lifetime.
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
      resourceGeneration,
      reader,
      colorSpace,
      enqueueMip,
      cancelMip,
    );
    if (defined(tex)) {
      // Only push to `created` (which the primCache destroys later) if
      // this WebGPU texture was allocated *here* via copyExternalImageToTexture.
      // When the CesiumJS Texture is backed by a WebGLStubTexture, the GPU
      // texture is owned by that stub and reused by reference; pushing it to
      // `created` would cause a double-destroy. The stub-owned check uses
      // the same path createGPUTextureFromReader took for ownership detection.
      const reusedFromStub = isTextureOwnedByCompatibilityStub(
        device,
        resourceGeneration,
        reader,
        tex,
      );
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
  // gamma, which is both perceptually correct for linear filtering and
  // removes the need for an in-shader pow(2.2) approximation.
  //
  // KHR extension texture color-space defaults, per the relevant Khronos
  // extension specs:
  //   srgb: specularColor (chromatic F0 tint), sheenColor.
  //   linear: clearcoat (intensity scalar), anisotropy (RG = direction
  //           encoded as f32 trig), iridescence (R = factor scalar),
  //           thickness (G = volume thickness scalar).
  try {
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
        matInfo.metallicRoughnessTextureReader ||
          matInfo.specGlossTextureReader,
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
      // KHR secondary maps. Each
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
      // Transmission texture (R = factor scalar) plus the refraction
      // scene-color sample source. The refractionScene fallback is the
      // white placeholder; the actual refraction MRT populated by the
      // SceneRenderer is bound through a separate per-frame rebuild in
      // update(). Stamping the placeholder here keeps the bind group
      // valid at all times.
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
  } catch (error) {
    // A later material slot can fail after earlier slots already allocated
    // textures and queued their mip jobs. Roll back the unpublished set as a
    // unit; do not replace the originating upload/allocation failure with a
    // cleanup error from a lost device.
    for (let i = 0; i < created.length; ++i) {
      destroyOwnedModelTextureBestEffort(created[i], cancelMip);
    }
    created.length = 0;
    throw error;
  }
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
 * Without this poll the bind group would be built once from whatever
 * textures had loaded by the first frame and never refreshed, leaving
 * late-loading assets solid white.
 *
 * @private
 */
function refreshDeferredModelTextures(
  device: GPUDevice,
  resourceGeneration: number,
  primCache: PrimitiveRenderData,
  matInfo: MaterialInfo,
  enqueueMip?: EnqueueMipFn,
  cancelMip?: CancelMipFn,
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
      resourceGeneration,
      reader,
      schema.colorSpace,
      enqueueMip,
      cancelMip,
    );
    if (!defined(tex)) {
      continue;
    }
    // Only track in gpuTextures when this renderer owns the lifetime —
    // see tryCreate for the same stub-ownership check. Stub-owned
    // GPUTextures are shared with the CesiumJS Texture wrapper and would
    // double-destroy.
    const reusedFromStub = isTextureOwnedByCompatibilityStub(
      device,
      resourceGeneration,
      reader,
      tex,
    );
    let view: GPUTextureView;
    try {
      // The view is part of publication. Do not append an owned texture or
      // retire its placeholder until this succeeds: createView can throw on a
      // lost device or invalid descriptor after the upload/mip job exists.
      view = tex.createView();
    } catch (error) {
      if (!reusedFromStub) {
        destroyOwnedModelTextureBestEffort(tex, cancelMip);
      }
      throw error;
    }
    if (!reusedFromStub) {
      primCache.gpuTextures.push(tex);
    }
    primCache.textureViews[schema.slot] = view;
    placeholders.delete(schema.slot);
    changed = true;
  }
  return changed;
}

// Main entry points.

/**
 * Drop a cache whose native ownership tuple no longer matches the context.
 * This is the polling fallback for contexts that predate the invalidation bus
 * and also closes the interval before/after a recovery notification.
 *
 * Callers must run their admission gate before invoking this helper: reading
 * `context.device` is deliberately not part of rejected-model preparation.
 */
function disposeStaleWebGPUModelCache(
  model: ModelLike,
  device: GPUDevice,
  resourceGeneration: number,
): void {
  const cache = model._webgpuCache;
  if (
    !defined(cache) ||
    (cache.device === device && cache.resourceGeneration === resourceGeneration)
  ) {
    return;
  }
  disposeWebGPUModelCache(model, cache);
}

/** Install the exact-cache invalidation subscription after construction. */
function subscribeWebGPUModelCacheInvalidation(
  model: ModelLike,
  cache: ModelWebGPUCache,
  context: ModelRenderContext,
): void {
  if (typeof context.onDeviceInvalidated !== "function") {
    return;
  }

  const ownedDevice = cache.device;
  const ownedGeneration = cache.resourceGeneration;
  cache._deviceInvalidationUnsub = context.onDeviceInvalidated(() => {
    // The scene-level recovery walk can clear the public slot before this
    // subscriber runs. Undefined therefore still means this captured cache
    // must be drained; a different live cache is the identity that must never
    // be destroyed by a delayed old-generation callback.
    const activeCache = model._webgpuCache;
    if (
      (defined(activeCache) && activeCache !== cache) ||
      cache.device !== ownedDevice ||
      cache.resourceGeneration !== ownedGeneration
    ) {
      return;
    }
    disposeWebGPUModelCache(model, cache);
  });
}

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
function updateWebGPUModel(
  model: ModelLike,
  frameState: CesiumFrameState,
  pipelineWarmupOnly = false,
) {
  if (!model.show || (!model.ready && !pipelineWarmupOnly)) {
    return;
  }

  // Surface silent feature gaps that the WebGPU model path does not yet
  // honor. Each warning fires once per process to alert users instead of
  // letting the feature appear to work when it silently no-ops.
  //>>includeStart('debug', pragmas.debug);
  // A customShader with native WGSL text runs the real native-WGSL path
  // below. Only a GLSL-only customShader (no `wgslFragmentShaderText`)
  // warns and no-ops on WebGPU; the GLSL-to-WGSL transpile is deferred by
  // design.
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

  // Reject only a provably camera-outside standalone model during an ordinary
  // SCENE3D render. The classifier is intentionally
  // conservative: shadow casters, scene capture, tiles, classifiers, pick,
  // offscreen, non-3D, stereo-capable, and malformed/unknown state all retain
  // the existing renderer unchanged. This gate precedes the first device read,
  // cache allocation, upload, effects preparation, or command construction.
  const context = frameState.context as unknown as ModelRenderContext;
  // Diagnostics are opt-in so the normal hot path pays only one boolean read;
  // no statistics object is allocated and no counter work runs by default.
  const preparationStatistics =
    context._webgpuModelPreparationDiagnosticsEnabled === true
      ? getWebGPUModelPreparationStatistics(frameState, context)
      : undefined;
  const preparationDecision = classifyWebGPUModelPreparationDemand(
    model,
    frameState,
    context,
  );
  if (defined(preparationStatistics)) {
    recordWebGPUModelPreparationDecision(
      preparationStatistics,
      preparationDecision,
    );
  }
  if (preparationDecision.demand === WebGPUModelPreparationDemand.REJECTED) {
    markWebGPUModelPreparationRejected(model);
    return;
  }

  const resetTemporalHistory = consumeWebGPUModelPreparationAdmissionGap(model);
  const preparationWork = preparationStatistics?.work;
  if (defined(preparationWork)) {
    preparationWork.preparationRuns++;
    if (resetTemporalHistory) {
      preparationWork.temporalHistoryResets++;
    }
  }
  const commandListStart = defined(preparationWork)
    ? frameState.commandList.length
    : 0;

  // Compute (or refresh) the model-level native-WGSL customShader resources:
  // the generated WGSL chunk and class hash, the packed uniforms UBO, and the
  // resolved custom-texture bind-group entries. Stored on the model cache below
  // so every primitive of this model prepends the same chunk and binds the same
  // UBO and textures. Rebuilt when the customShader reference changes; the UBO
  // contents are refreshed every frame, which is cheap, so `setUniform` updates
  // take effect.
  //>>includeStart('debug', pragmas.debug);
  // model.classificationType routes through
  // `pipelineCache.getClassificationPipeline` and emits at the matching
  // TERRAIN/3D-Tile classification pass. The depth-sample classifier
  // FS samples the same `globeDepthTex` (group 3 binding 15) the four
  // classifier renderers use, so model classifiers participate in the
  // shared depth-sample architecture without per-renderer plumbing.
  //>>includeEnd('debug');

  const commandList = frameState.commandList;
  const device = context.device;
  const resourceGeneration = context.resourceGeneration ?? 0;
  disposeStaleWebGPUModelCache(model, device, resourceGeneration);
  const isClassifier = defined(model.classificationType);
  const colorShadowFlags = getModelCommandShadowFlags(
    model.shadows,
    isClassifier,
    true,
  );
  const nonColorShadowFlags = getModelCommandShadowFlags(
    model.shadows,
    isClassifier,
    false,
  );
  const styledTranslucentShadowFlags =
    getStyledTranslucentModelShadowFlags(colorShadowFlags);
  const castShadows = colorShadowFlags.castShadows;
  const receiveShadows = colorShadowFlags.receiveShadows;
  const shadowPassActive = isModelShadowPassActive(frameState);
  const shadowCastingActive = isModelShadowCastingActive(
    castShadows,
    frameState,
  );
  const shadowCameraPositionWC =
    context.uniformState?.cameraPosition ??
    frameState.camera?.positionWC ??
    Cartesian3.ZERO;

  // Frame-owned mip-generation sink for the fallback texture path
  // (createGPUTextureFromReader when a model texture is not stub-backed). The
  // stub path already generates its own chain at upload, so this only covers
  // the secondary branch. Undefined on a context that exposes no sink, in
  // which case the fallback stays single-level.
  // Initialize model cache
  if (!defined(model._webgpuCache)) {
    const fmt = context.scenePipelineFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const pipelineCache = new WebGPUModelPipelineCache(
      device,
      fmt,
      depthFmt,
      // Central async pipeline cache, so the color pipeline resolves through
      // `createRenderPipelineAsync` instead of a synchronous mid-draw
      // `device.createRenderPipeline`. Null (a WebGL stub, or a context that
      // exposes no cache) keeps the synchronous fallback.
      context.webgpuPipelineCache ?? null,
      resourceGeneration,
    ) as unknown as PipelineCacheLike;
    const newCache: ModelWebGPUCache = {
      device,
      resourceGeneration,
      pipelineCache,
      // Bind the context sinks once per exact model-cache generation. Binding
      // them in every update would allocate two fresh functions on the render
      // hot path even after every texture had reached steady state.
      _enqueueTextureMipGeneration:
        typeof context.enqueueTextureMipGeneration === "function"
          ? context.enqueueTextureMipGeneration.bind(context)
          : undefined,
      _cancelTextureMipGeneration:
        typeof context.cancelTextureMipGeneration === "function"
          ? context.cancelTextureMipGeneration.bind(context)
          : undefined,
      // CPU staging only; the camera and light GPU bytes live in the
      // context-owned per-frame arena. `lightData` is model-level because the
      // block it stages is model-level: one byte-identical copy serves every
      // primitive.
      cameraData: null,
      lightData: null,
      primitives: {}, // keyed by "nodeIdx_primIdx"
      geometryViews: {}, // mutable annotation views, keyed like primitives
      nodes: {}, // per-node skinning data, keyed by nodeIdx
    };
    model._webgpuCache = newCache;
    try {
      subscribeWebGPUModelCacheInvalidation(model, newCache, context);
    } catch (error) {
      // Subscription is part of cache construction: never publish a half-cache
      // or retain its shared generation lease when registration fails.
      disposeWebGPUModelCache(model, newCache);
      throw error;
    }
  }
  const cache = model._webgpuCache;
  const enqueueMip = cache._enqueueTextureMipGeneration;
  const pipelineCache = cache.pipelineCache;

  // (Re)build the model-level native-WGSL customShader resources.
  if (shouldPrepareModelCustomShaderResources(model, cache)) {
    if (defined(preparationWork)) {
      preparationWork.customShaderPreparations++;
    }
    ensureModelCustomShaderResources(device, model, cache, pipelineCache);
  }

  // Publish this model's camera-independent draw records so the
  // dynamic-environment-map capture pass can replay it into the 6 cube faces
  // next frame. Gated on the context flag `context.sceneCaptureReflections`;
  // when it is off nothing is published, `_webgpuSceneCaptureModels` stays
  // null, and the capture pass's model replay is a no-op that leaves the
  // globe-only capture byte-identical. The publish object is reset once per
  // frame (frameNumber guard) and appended to for every model the feature
  // renderer processes this frame. `buildCaptureCommands` is a stable function
  // reference so the capture pass can build per-face descriptors without a
  // static import of this renderer, which would be a circular import.
  const wantCapturePublish =
    !pipelineWarmupOnly && context.sceneCaptureReflections === true;
  let captureRecords: CaptureRecord[] | null = null;
  let capturePublishEntry: SceneCaptureModelsLike["models"][number] | null =
    null;
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
    capturePublishEntry = {
      model,
      pipelineCache,
      records: captureRecords,
    };
    pub.models.push(capturePublishEntry);
  }

  // Drop per-primitive pipeline refs when the scene pipeline format
  // generation bumps (an HDR or MSAA toggle). The pipelineCache wipes
  // its own cache via maybeUpdateForSceneFormat, but the per-primitive
  // cache holds direct references that still point at the old pipeline
  // objects, so they are re-fetched from the now-empty pipelineCache
  // per primitive in the per-frame loop below, where each primitive
  // re-fires `pc.pipeline = pipelineCache.getPipeline(...)`.
  // Lazy-allocated variants (pick/velocity/translucent/depth-write)
  // drop to undefined and are re-fetched on next use.
  const previousGen = pipelineCache._sceneFormatGeneration;
  pipelineCache.maybeUpdateForSceneFormat(context);
  // Renderer-wide log depth: mirror the master switch into the pipeline
  // cache. A flip wipes pipelines so modules recompile with or without the
  // LOG_DEPTH define.
  const logDepthFlipped = pipelineCache.maybeUpdateForLogDepth(
    isWebGPULogDepthActive(
      context as unknown as Parameters<typeof isWebGPULogDepthActive>[0],
      frameState,
    ),
  );
  // Mirror the separate pick-fleet master switch into the pipeline cache. A
  // flip wipes only the pick pipeline maps, so the 3 pick fragment entries and
  // the 2 BLEND precise-pass pipelines recompile their module with or without
  // the LOG_DEPTH define. It defaults to false, leaving pick modules without a
  // LOG_DEPTH define and the hyperbolic pick byte-identical.
  const pickLogDepthFlipped = pipelineCache.maybeUpdateForPickLogDepth(
    isWebGPUPickLogDepthActive(
      context as unknown as Parameters<typeof isWebGPUPickLogDepthActive>[0],
      frameState,
    ),
  );
  // Mirror model.splitDirection into the per-model pipeline cache. A flip
  // wipes pipelines so modules recompile with or without
  // MODEL_SPLIT_ENABLED, matching WebGL's ModelSplitterPipelineStage.
  // splitDirection: -1 LEFT / 0 NONE / +1 RIGHT.
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
  // Mirror `defined(model.color)` into the per-model pipeline cache. A flip
  // wipes pipelines so modules recompile with or without MODEL_HAS_COLOR,
  // matching WebGL's ModelColorPipelineStage.
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
  // Mirror WebGL's `Model.hasSilhouette()` predicate (silhouetteSize > 0 &&
  // silhouetteColor.alpha > 0 && !classificationType && stencil support) into
  // the per-model pipeline cache. A flip wipes pipelines so modules recompile
  // with or without MODEL_SILHOUETTE. The scene depth format is
  // `depth24plus-stencil8` by construction, but the guard stays so a
  // depth-only format cannot request stencil-state pipelines.
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
  // Uses `context.drawingBufferWidth` directly rather than
  // `uniformState.viewportCartesian4`, which is zero-initialized at
  // feature-renderer update time.
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
  // pushed after every base command of this model, matching WebGL
  // `ModelSceneGraph.pushDrawCommands` ordering, so the rim does not
  // draw on top of the model's own later primitives.
  const silhouetteColorCommands = [];
  // A log-depth flip needs the same per-primitive direct-reference drop as
  // a scene-format change: `pc.pipeline` and its siblings point at wiped
  // pipelines.
  const sceneFormatChanged =
    previousGen !== pipelineCache._sceneFormatGeneration ||
    logDepthFlipped ||
    // A pick-log flip wipes the pick pipeline maps, so the per-primitive
    // `pc.pickPipeline` direct refs must be dropped and re-fetched, the same
    // as for a scene-format or scene-log flip.
    pickLogDepthFlipped ||
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
        // Silhouette variants are direct refs into the wiped maps too.
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

  // Use the scene graph's _computedModelMatrix which folds in:
  //   model.modelMatrix * components.transform * _axisCorrectionMatrix
  //     * scale(model.computedScale)
  // Falling back to model.modelMatrix omits glTF root transform, axis
  // correction (Z-up → Y-up), and the user-supplied scale — which made
  // models render at the wrong scale (typically 1× instead of computedScale,
  // e.g. CesiumAir.glb collapsing to a few pixels at scale=4) and with the
  // wrong axis orientation. The same field is what the upstream WebGL
  // ModelDrawCommand uses (see ModelSceneGraph).
  // In SCENE2D / COLUMBUS_VIEW / MORPHING the scene graph's projected-frame
  // matrix is used instead. WebGL's ModelMatrixUpdateStage swaps to
  // `_computedModelMatrix2D` (Transforms.basisTo2D over the 3D matrix,
  // computed by ModelSceneGraph.updateModelMatrix whenever the mode or
  // model matrix changes; Model.updateSceneMode sets
  // `_updateModelMatrix = true` on every mode flip, so it is never stale
  // here). All downstream consumers — the packCameraUniforms RTE encode,
  // per-node matrices, shadow-cast UB, edge-emitter MVP, TAA prev-matrix —
  // derive from this one local, so the substitution is complete.
  // `uniformState.view/projection/cameraPosition` are already in the same
  // projected frame in these modes, keeping the RTE chain consistent.
  //
  // The `projectTo2D:true` accurate-2D path is different again. When the model
  // opts into accurate 2D projection, WebGL bakes a per-vertex
  // ellipsoid-to-projected reprojection into a dedicated position buffer and
  // morphs the 3D bounding volume into a flat 2D box
  // (SceneMode2DPipelineStage). Critically, with `projectTo2D` set the scene
  // graph does not compute `_computedModelMatrix2D` at all — Model resets draw
  // commands on a mode flip instead of arming `_updateModelMatrix` — so the
  // affine 2D path below has no matrix to use and the model would fall back to
  // its ECEF 3D matrix under a 2D/CV camera and be culled to nothing. Instead
  // each primitive's positions are reprojected on the CPU relative to a single
  // model-level reference point, and the camera UB is driven with a pure
  // translate(reference) matrix; the existing model-space RTE chain then
  // resolves clip space correctly (`rte = projAbs - eyeProj`). Per-primitive
  // reference frames and the IDL-crossing duplicate command remain open.
  const projectTo2DActive =
    model._projectTo2D === true &&
    frameState.mode !== SceneMode.SCENE3D &&
    defined(model._sceneGraph?._computedModelMatrix);

  let modelMatrix;
  let commandBoundingVolume;
  // The backend-neutral scene-graph build computes `_boundingSphere` before
  // native preparation. The public getter intentionally throws until
  // Model.ready, so the pre-ready pipeline lane must consume the internal
  // shared bound. Normal ready-state rendering retains the getter fallback for
  // structural test hosts that do not expose Cesium's private field.
  const modelBoundingSphere =
    model._boundingSphere ?? (model.ready ? model.boundingSphere : undefined);
  // Armed only for a non-projectTo2D model that crosses the antimeridian in
  // SCENE2D, mirroring WebGL's `shouldUse2DCommands`. When set, the emission
  // loop pushes a second,
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
      computeModel2DBoundingVolume(model, cache) ?? modelBoundingSphere;
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
        : modelBoundingSphere;

    // Decide whether the model straddles the IDL in SCENE2D. This mirrors
    // WebGL `shouldUse2DCommands`
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
  // A rejected interval must not become a multi-frame velocity jump on
  // readmission. Initialize/reset the model-level previous transform before
  // any primitive material pack reads it.
  if (!pipelineWarmupOnly) {
    resolvePreviousMatrixForFrame(
      cache,
      "prevModelMatrix",
      modelMatrix,
      resetTemporalHistory,
    );
  }

  // Effects bind group (shadow receive + clipping + CSM).
  //
  // The model pipeline layout includes the effects BGL at @group(7). Rebuild
  // the bind group each frame so the effects UBO (shadow darkness, csmControl
  // flag, clipping plane count, atmosphere LUT control, and so on) reflects the
  // current scene state. Mirrors the pattern in WebGPUGlobeSurfaceRenderer.
  //
  // Scope note: called per-model per-frame. The UB write is 272 bytes
  // and the bind group is a thin metadata wrapper, so the cost is
  // linear in model count × 1 small write. If this becomes a hotspot
  // with many models, cache a scene-wide effects bind group on the
  // frame context and share across all models in the scene.
  // Model updates run before ViewportExecutor.updateShadowMaps refreshes
  // shadowState. Resolve the same-frame light map from frameState.shadowMaps,
  // which Scene populates from the current global toggle before primitives.
  // This prevents prior-frame off/on state from leaking into receive bindings.
  const currentLightShadowMap = getCurrentModelLightShadowMap(
    frameState,
    shadowPassActive,
  );
  const receiveShadowsActive = isModelShadowReceivingActive(
    receiveShadows,
    shadowPassActive,
    defined(currentLightShadowMap),
  );
  const receiveShadowMap = receiveShadowsActive
    ? currentLightShadowMap
    : undefined;
  const csmCandidate = (frameState.context as unknown as ModelRenderContext)
    ?.csmRenderer;
  const csmBinding =
    receiveShadowsActive &&
    frameState.useCascadedShadowMaps === true &&
    defined(csmCandidate) &&
    csmCandidate.enabled === true &&
    defined(csmCandidate.cascadeParamsBuffer) &&
    defined(csmCandidate.cascadeArrayView)
      ? {
          enabled: true,
          paramsBuffer: csmCandidate.cascadeParamsBuffer,
          cascadeArrayView: csmCandidate.cascadeArrayView,
          // Soft-shadow kernel radius, in texels.
          pcfRadius: csmCandidate.pcfRadius,
        }
      : undefined;
  // Gather edge-detection inputs for the inline stage in
  // `ModelPBRComplete.wgsl`. The scene renderer publishes resolved edge
  // MRT views (the CESIUM_3D_TILE_EDGES pass) and the globe packed-depth
  // view (`executeCopyDepth`) on the context each frame. Both must be
  // populated for the gate to flip; when either is missing the code
  // falls through to the placeholder bind group, and the shader's
  // `edgeControl.x <= 0.5` early-out keeps the stage benign.
  const ctx = frameState.context as unknown as ModelRenderContext;
  const edgeColorView = ctx?._edgeColorView ?? null;
  const edgeIdView = ctx?._edgeIdView ?? null;
  const edgeDepthView = ctx?._edgeDepthView ?? null;
  const globeDepthView = ctx?._globeDepthView ?? null;
  const uniformState = ctx?.uniformState;
  const currentFrustum = uniformState?.currentFrustum;
  // Viewport — sourced from context.drawingBufferWidth/Height directly.
  // `uniformState.viewportCartesian4` is zero-initialized at
  // feature-renderer update time, because the feature renderer runs
  // during Scene primitive update, before the per-frame viewport is
  // established. Reading it here would break edge-overlay readiness
  // gating: `!!viewportPx` is truthy on a zero-init Cartesian4 because
  // the object exists, so edges would ship with zw=0, giving a NaN
  // screenUV and a broken edge overlay. Match the canvas dimensions
  // instead.
  const dbw = ctx?.drawingBufferWidth || 1;
  const dbh = ctx?.drawingBufferHeight || 1;
  const edgesReady =
    !!edgeColorView && !!edgeDepthView && !!globeDepthView && !!currentFrustum;
  // The inline stage gates on the same flag the emitter side toggles
  // when feature IDs are populated. The flag
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

  // Wire model.clippingPlanes / model.clippingPolygons through to the
  // effects bind group. `Model` supports both APIs, and without this
  // wiring `model.clippingPlanes = …` produces no visual change, because
  // the scene-wide clipping never applies to models, and
  // `model.clippingPolygons = …` is a complete no-op. The model's
  // collections also need their per-frame `update(frameState)` to run so
  // `_webgpuCache` is populated; `Model.update()` already does that.
  const modelClippingPlanes = model._clippingPlanes;
  const modelClippingPolygons = model._clippingPolygons;
  const effectsOptions = {
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
    // Forward+ clustered lighting. SceneRenderer's
    // _dispatchClusteredLighting hook stashes the dispatcher's per-
    // frame buffers on context._clusteredLightingBuffers each frame.
    // When omitted — for instance in a scene without WebGPUSceneRenderer
    // hooked up — the effects bind group falls back to per-device
    // placeholders and the FS chunk early-outs via activeLightCount=0.
    clusteredLighting: (frameState.context as unknown as ModelRenderContext)
      ._clusteredLightingBuffers,
  };
  if (defined(preparationWork)) {
    preparationWork.effectsPreparations++;
  }
  const fxRes = createEffectsBindGroup(device, frameState, effectsOptions);
  cache.effectsBG = fxRes.bindGroup;
  const receiveShadowMapIsPointLight =
    (
      receiveShadowMap as
        (CesiumShadowMap & { _isPointLight?: boolean }) | undefined
    )?._isPointLight === true;
  if (capturePublishEntry && receiveShadowMapIsPointLight) {
    capturePublishEntry.capturePointEffects = {
      options: effectsOptions,
    };
  }
  if (
    defined(receiveShadowMap) &&
    !receiveShadowMapIsPointLight &&
    !defined(csmBinding) &&
    defined(fxRes.uniformBuffer)
  ) {
    context.enqueueShadowReceiveUniformRefresh?.(
      fxRes.uniformBuffer,
      receiveShadowMap,
    );
  }

  // Process the model by iterating nodes → primitives. This traversal is what
  // exposes each node's skinning data (computedJointMatrices) alongside its
  // primitives.
  const sceneGraph = model._sceneGraph;
  if (!defined(sceneGraph) || !defined(sceneGraph._runtimeNodes)) {
    if (defined(preparationWork)) {
      preparationWork.commandsEmitted += commandList.length - commandListStart;
    }
    return;
  }

  const runtimeNodes = sceneGraph._runtimeNodes;
  // This memo is set only at the first emitted identity-node command.
  // Transformed tile-owned nodes bind their own node camera block and never
  // realize or pack the unused model-level block.
  let rootCameraPreparedThisFrame = false;
  // The model-level camera binding for this update. Deliberately an
  // update-scoped local rather than a cache field: an arena slice belongs to
  // one allocation epoch, so persisting it would let a later frame bind bytes
  // the ring has already handed to someone else.
  let rootCameraBinding: ModelCameraBinding | undefined;
  // The single light block this model and view share, under the same
  // update-scoped-local rule and the same lazy realization as the camera
  // above: a model whose primitives all skip — pipelines still cooking, or a
  // warmup-only pass — never packs or stages it. Every camera acquisition of
  // this update pairs with this exact slice.
  let modelLightSlice: ModelViewLightSlice | undefined;
  // Shadow transform buffers are demand-created at the first emitted caster.
  // Identity-transform nodes share the model host; this per-update memo avoids
  // even repacking/comparing that host when a model has several identity nodes.
  let rootShadowCastUniformReady = false;
  let rootShadowCastModelUB: WebGPUBuffer | undefined;

  for (let nodeIdx = 0; nodeIdx < runtimeNodes.length; nodeIdx++) {
    const runtimeNode = runtimeNodes[nodeIdx];
    if (!defined(runtimeNode)) {
      continue;
    }

    const prims = runtimeNode.runtimePrimitives;
    if (!defined(prims) || prims.length === 0) {
      continue;
    }

    // Apply the per-runtime-node
    // `computedTransform = transformToRoot × transform` to the model
    // matrix so multi-node hierarchies and AGI_articulations /
    // non-skinned animated rigs render at their correct world position.
    // Mirrors WebGL's `ModelMatrixUpdateStage.updateRuntimeNode`, which
    // multiplies `runtimeNode.transform` into the inherited
    // `transformToRoot` before forwarding to `updateDrawCommand`; the
    // result it forwards is `transformToRoot × transform`, exactly what
    // `runtimeNode.computedTransform` returns.
    //
    // `runtimeNode.transformToRoot` is not a substitute: it excludes the
    // node's own transform, which is wrong for any rig with a
    // non-identity local transform — the entire point of articulations.
    //
    // Skinning depends on the same factor. `runtimeNode.computedJointMatrices`
    // (the TAA velocity input) is built with `inverseNodeWorldTransform =
    // inverse(transformToRoot × transform)` baked in, and the cancellation
    // only works when the per-primitive modelMatrix carries the matching
    // `(transformToRoot × transform) = computedTransform`. Skinned rigs whose
    // skin root has any non-identity local or ancestor transform therefore
    // depend on this too.
    const computedTransform = runtimeNode.computedTransform;
    const computedTransformIsIdentity =
      !defined(computedTransform) || isIdentityMatrix4(computedTransform);
    // In the accurate-2D path the node
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
    // Lazily resolved at the first emitted caster for this node. A transformed
    // node owns a distinct UB; identity nodes reuse the root-host memo above.
    let nodeShadowCastUniformReady = false;
    let nodeShadowCastModelUB: WebGPUBuffer | undefined;
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

    // Allocate the per-node cache slot unconditionally for any node with a
    // non-identity computedTransform, so the camera buffer and bind group
    // below can be lazily attached to it even when the node has neither
    // skinning nor instancing. Skinning and instancing branches further down
    // extend the same nodeCache shape.
    if (!transformIsIdentity && !defined(cache.nodes[nodeIdx])) {
      cache.nodes[nodeIdx] = {
        jointBuffer: null,
        jointBufferSize: 0,
        skinningBG: null,
        packedJointMatrices: null,
        prevJointBuffer: null,
        prevPackedJointMatrices: null,
        // Per-node camera staging; the GPU bytes live in the per-frame
        // arena.
        cameraData: null,
        // The per-node previous frame's `nodeModelMatrix`. The
        // model-level `cache.prevModelMatrix` is not a substitute: it is
        // correct for static articulations, which are set once and then
        // locked, but produces ghosting under TAA when articulation
        // animations mutate `runtimeNode.transform` per frame. The
        // per-node slot is captured at the end of each node iteration so
        // the next frame's pack reads this frame's value as `prev`.
        prevNodeModelMatrix: null,
      };
    }

    // Per-node skinning: create/update joint matrices GPU buffer
    if (hasSkinning && !pipelineWarmupOnly) {
      if (!defined(cache.nodes[nodeIdx])) {
        cache.nodes[nodeIdx] = {
          jointBuffer: null,
          jointBufferSize: 0,
          skinningBG: null,
          packedJointMatrices: null,
          // Prev-frame mirrors for TAA velocity.
          prevJointBuffer: null,
          prevPackedJointMatrices: null,
          // Per-node previous `nodeModelMatrix`. See above.
          prevNodeModelMatrix: null,
        };
      }
      const nodeCache = cache.nodes[nodeIdx];

      // First frame: full extraction. Subsequent: incremental update.
      if (!defined(nodeCache.packedJointMatrices)) {
        nodeCache.packedJointMatrices = skinData.packedJointMatrices;
        ensureJointMatricesBuffer(device, pipelineCache, nodeCache, skinData);
      } else {
        // Capture the about-to-be-overwritten current matrices as
        // "previous" before applying this frame's pose. Reuses a
        // persistent Float32Array to avoid per-frame
        // allocation. The first capture (no prevPackedJointMatrices
        // yet) lazily allocates a same-size buffer + GPU storage so
        // the velocity pass has a real `t-1` pose to skin against;
        // the FS would otherwise see prev == current and emit zero
        // velocity for the first animated frame.
        preparePackedJointHistoryForFrame(
          runtimeNode,
          nodeCache,
          resetTemporalHistory,
        );
        ensurePrevJointMatricesBuffer(device, nodeCache);
        device.queue.writeBuffer(
          nodeCache.prevJointBuffer,
          0,
          nodeCache.prevPackedJointMatrices,
        );
        device.queue.writeBuffer(
          nodeCache.jointBuffer,
          0,
          nodeCache.packedJointMatrices,
        );
      }
    }

    // Track raw GPU buffers instead of standalone bind groups. The
    // merged group 2 bind group is built per frame at the draw command
    // emission site.
    const nodeJointBuffer =
      hasSkinning && !pipelineWarmupOnly
        ? cache.nodes[nodeIdx].jointBuffer
        : null;
    // Prev-frame joint matrices for TAA velocity. Falls through to null
    // on the first frame so the bind-group builder can substitute the
    // current buffer, which contributes zero skinning velocity — never
    // the identity, which would explode.
    const nodePrevJointBuffer =
      hasSkinning && !pipelineWarmupOnly
        ? cache.nodes[nodeIdx].prevJointBuffer
        : null;

    // GPU Instancing: detect from node.instances and create resources
    const nodeForInst = runtimeNode.node || runtimeNode._node;
    const hasInstancing =
      defined(nodeForInst) && defined(nodeForInst.instances);
    let instanceBuffer = null;
    let instanceCount = 1;

    if (hasInstancing && !pipelineWarmupOnly) {
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

    // Camera resources are realized only after the first pipeline-backed draw
    // below. This remains undefined for nodes whose pipelines are still
    // cooking or whose primitives never emit a command.
    let nodeCameraBG: GPUBindGroup | null | undefined;
    // The group-0 dynamic offset that pairs with `nodeCameraBG`. Every command
    // variant built for this node (color, IDL duplicate, classifier second
    // pass, pick and its variants, velocity, silhouette, translucent twin)
    // shares this one array; it is never mutated after the arena returns it,
    // so sharing the reference is allocation-free and safe.
    let nodeCameraOffsets: number[] | undefined;

    // Build the y-shifted camera bind group for the IDL-crossing duplicate.
    // Mirrors WebGL `updateModelMatrix2D`: clone the matrix the primary
    // command's camera UB was packed against (`nodeModelMatrix`) and move its
    // translation to the opposite side of the map (`ty -= sign(ty)·2πR`), then
    // pack an RTE camera UB from it. The duplicate takes its own slice from the
    // same per-frame arena as the primary view, so it usually shares the
    // primary command's @group(0) bind group and differs only in the dynamic
    // offset; no pipeline change either way. The CPU staging array is
    // lazy-allocated on the same cache object that hosts the primary view's
    // (`cache` for identity nodes, `cache.nodes[nodeIdx]` otherwise) and only
    // when `idlDuplicateActive` — off-IDL, 3D and CV never allocate or write
    // anything here.
    let nodeIdlCameraBG: GPUBindGroup | null = null;
    let nodeIdlCameraOffsets: number[] | null = null;
    let nodeIdlModelMatrix2D = null;
    let nodeIdlBoundingSphere2D = null;
    if (idlDuplicateActive && !pipelineWarmupOnly) {
      const idlHost = transformIsIdentity ? cache : cache.nodes[nodeIdx];
      const idlMat = Matrix4.clone(nodeModelMatrix, scratchIdl2DModelMatrix);
      idlMat[13] -= Math.sign(nodeModelMatrix[13]) * idlShiftAmount2D;
      if (!defined(idlHost.cameraData2DIdl)) {
        idlHost.cameraData2DIdl = new Float32Array(CAMERA_UNIFORM_SIZE / 4);
      }
      if (defined(preparationWork)) {
        preparationWork.cameraPacks++;
      }
      packCameraUniforms(idlHost.cameraData2DIdl, frameState, idlMat);
      if (defined(preparationWork)) {
        preparationWork.cameraWrites++;
      }
      // The IDL duplicate is a second view of the same node in the same frame.
      // It takes its own arena slice, so its dynamic offset is necessarily
      // distinct from the primary view's while both share one group-0 bind
      // group over the ring page. The light offset is deliberately the same:
      // the wrapped copy shifts the model matrix, not the eye, so the
      // camera-relative light block is byte-identical for both halves of the
      // IDL.
      if (!defined(modelLightSlice)) {
        modelLightSlice =
          prepareModelViewLightSlice(
            device,
            frameState,
            cache,
            model,
            preparationWork,
          ) ?? undefined;
      }
      // A still-undefined slice here is the dead-device degradation described
      // in `resolveModelCameraArenaOwner`: leave `nodeIdlCameraBG` null so the
      // duplicate is never emitted. The primary draw skips below for the same
      // reason.
      const idlBinding = !defined(modelLightSlice)
        ? null
        : acquireModelCameraBinding(
            device,
            frameState,
            pipelineCache,
            idlHost.cameraData2DIdl,
            "Model camera 2D-IDL",
            modelLightSlice,
          );
      if (idlBinding !== null) {
        nodeIdlCameraBG = idlBinding.bindGroup;
        nodeIdlCameraOffsets = idlBinding.dynamicOffsets;
        // Persist the shifted matrix + bounding volume so the per-primitive
        // duplicate command (emitted below) holds stable references — the
        // `scratchIdl2DModelMatrix` is reused across nodes. The bounding
        // volume is the same model-level `_boundingSphere2D` the primary
        // command uses, translated by the identical y offset so Scene culling
        // keeps the wrapped copy (WebGL transforms the per-primitive sphere
        // by `_modelMatrix2D`; the model-level sphere is the conservative
        // match).
        if (!defined(idlHost.idlModelMatrix2D)) {
          idlHost.idlModelMatrix2D = new Matrix4();
          idlHost.idlBoundingSphere2D = new BoundingSphere();
        }
        Matrix4.clone(idlMat, idlHost.idlModelMatrix2D);
        BoundingSphere.clone(
          commandBoundingVolume,
          idlHost.idlBoundingSphere2D,
        );
        idlHost.idlBoundingSphere2D.center.y -=
          Math.sign(nodeModelMatrix[13]) * idlShiftAmount2D;
        nodeIdlModelMatrix2D = idlHost.idlModelMatrix2D;
        nodeIdlBoundingSphere2D = idlHost.idlBoundingSphere2D;
      }
    }

    // Resolve the per-node previous-frame nodeModelMatrix for the
    // velocity pack. The model-level `cache.prevModelMatrix` is correct
    // for static articulations, which are set once and then locked, but
    // produces ghosting under TAA when articulation animations mutate
    // `runtimeNode.transform` per frame. Satellite solar-panel deploy
    // animations, robot-arm articulations and AGI_articulations rigs
    // whose nodes animate while TAA is on all hit this path.
    //
    // For identity-transform nodes the per-node `nodeModelMatrix` equals
    // the model-level `modelMatrix`, so `cache.prevModelMatrix` is also
    // the correct prev; falling back to it costs no per-node storage in
    // the common single-node or static-articulation case.
    //
    // For non-identity nodes, read the per-node slot. First frame
    // (`prevNodeModelMatrix === null`) initializes from this frame's
    // `nodeModelMatrix` so velocity is exactly zero, which is what "no
    // history yet" means and matches TAA's first-frame fallback.
    let prevNodeModelMatrixForPack = nodeModelMatrix;
    if (!pipelineWarmupOnly) {
      const nodeCacheForPrev = cache.nodes[nodeIdx];
      if (transformIsIdentity || !defined(nodeCacheForPrev)) {
        prevNodeModelMatrixForPack = resolvePreviousMatrixForFrame(
          cache,
          "prevModelMatrix",
          modelMatrix,
          resetTemporalHistory,
        );
      } else {
        prevNodeModelMatrixForPack = resolvePreviousMatrixForFrame(
          nodeCacheForPrev,
          "prevNodeModelMatrix",
          nodeModelMatrix,
          resetTemporalHistory,
        );
      }
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
          destroyPrimitiveCacheResources(
            stalePrimitive,
            cache._cancelTextureMipGeneration,
          );
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
      // `FeatureIdImplicitRange` primitives have no `_FEATURE_ID_0`
      // accessor, so `extractPrimitiveGeometry` leaves `featureId0Data`
      // null. Synthesize the per-vertex array here
      // (`offset + floor(v / repeat)`) when the model's selected feature
      // ID is implicit; the existing slot-8 upload path then carries it
      // like a regular vertex attribute, and the FS lights up the same
      // `FLAG_HAS_FEATURE_ID_ATTRIBUTE` branch.
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

      // Material extraction is source-generation work. The shared cache keys
      // the immutable base by runtime primitive + material identity + the two
      // geometry capabilities that affect its semantics. Async texture readers
      // remain live handles inside the base and do not invalidate it merely
      // because their image becomes ready.
      const material = glTFPrimitive?.material;
      const baseMaterialInfo = getOrCreateMaterialInfo(
        rp,
        material,
        geometry.hasColor0,
        geometry.hasNormals,
      ) as MaterialInfo;
      const effectiveAlphaMode = resolveCustomShaderAlphaMode(
        baseMaterialInfo.alphaMode,
        model,
      );

      // Source replacement/revision invalidates the immutable geometry base.
      // Material identity/capability replacement likewise rebuilds native
      // textures and pipelines exactly once. Device loss remains independent:
      // it clears native resources but can reuse both immutable CPU bases.
      const geometryAnnotationMask = getGeometryAnnotationMask(geometry);
      const cachedPrim = cache.primitives[primKey];
      if (
        defined(cachedPrim) &&
        (cachedPrim._geometryBase !== baseGeometry ||
          hasMaterialGenerationChanged(
            cachedPrim,
            baseMaterialInfo,
            effectiveAlphaMode,
          ) ||
          cachedPrim._geometryAnnotationMask !== geometryAnnotationMask ||
          cachedPrim._featureIdData !== geometry.featureId0Data ||
          cachedPrim._metadataDescriptor !== metadataDescriptor ||
          ((cachedPrim._metadataClassHash ?? 0) | 0) !==
            ((geometry.metadataClassHash ?? 0) | 0))
      ) {
        destroyPrimitiveCacheResources(
          cachedPrim,
          cache._cancelTextureMipGeneration,
        );
        delete cache.primitives[primKey];
      }

      // One mutable effective-state view belongs to exactly one native
      // primitive generation. It is never attached to a draw command. Factor
      // arrays remain the frozen arrays owned by baseMaterialInfo, so a dynamic
      // alpha override cannot alias mutable data across views or captures.
      const retainedPrim = cache.primitives[primKey];
      const matInfo = defined(retainedPrim?._materialView)
        ? retainedPrim._materialView
        : (createMaterialInfoView(baseMaterialInfo) as MaterialInfo);

      // Apply the per-update reset and customShader override before the
      // primitive cache and pipeline are built, so the forced alpha mode
      // cascades to the pipeline blend state, passClass, and draw-pass
      // selection. Resetting from the immutable authored value makes
      // TRANSLUCENT/OPAQUE -> INHERIT dynamic transitions correct without
      // mutating or rebuilding the shared base.
      applyCustomShaderTranslucency(
        matInfo,
        baseMaterialInfo,
        model,
        effectiveAlphaMode,
      );

      // Get or create cached GPU resources for this primitive
      const primCache = ensurePrimitiveCache(
        device,
        cache,
        pipelineCache,
        primKey,
        geometry,
        matInfo,
        enqueueMip,
        cache._cancelTextureMipGeneration,
      );
      primCache._geometryBase = baseGeometry;
      primCache._materialBase = baseMaterialInfo;
      primCache._materialView = matInfo;
      primCache._effectiveAlphaMode = effectiveAlphaMode;
      // Deferred texture polling needs only immutable texture-reader handles;
      // retain the base, not the mutable effective-alpha view.
      primCache.matInfo = baseMaterialInfo;
      primCache._geometryAnnotationMask = geometryAnnotationMask;
      primCache._featureIdData = geometry.featureId0Data;
      primCache._metadataDescriptor = metadataDescriptor;

      // Lazily build (and cache) the accurate-2D position buffer for this
      // primitive: reproject every vertex from model space through the 3D node
      // world matrix into the projected frame, relative to the shared
      // model-level reference. Keyed by the reference so a reference shift
      // rebuilds it, which is rare because projectTo2D locks the matrix in
      // 2D/CV. The 3D `positionBuffer` is retained untouched, so returning to
      // SCENE3D is byte-identical.
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

      // Set the pipeline cache's metadata chunk for this primitive before any
      // subsequent pipeline (re)build in this loop iteration; the refetch,
      // depth-write, pick, velocity, classification and translucent paths all
      // reuse this primCache. This is a no-op clear for non-metadata
      // primitives.
      applyPrimitiveMetadataToPipelineCache(pipelineCache, primCache);

      // Re-fetch the primary color pipeline when the scene pipeline
      // format generation has bumped since this primitive was first set
      // up. The pipelineCache was already cleared by
      // `maybeUpdateForSceneFormat` above, so the getPipeline call below
      // builds a fresh pipeline against the current
      // `_presentationFormat`, which mirrors the scene framebuffer color
      // format (rgba16float in HDR, for example). Lazy variants (pick /
      // velocity / translucent / depth-write) refresh themselves at
      // their next-use sites: they are already undefined-tagged for
      // re-fetch, and the existing `if (!defined(primCache.X))` gates
      // handle them.
      // Also re-fetch when the cache swapped a color pipeline to its
      // magenta error fallback, which async failure detection signals by
      // bumping the cache's `_errorSwapGeneration`. primCache caches the
      // pipeline reference, so without this the swap never reaches the
      // built command and the render hole persists.
      const errorSwapped =
        primCache._fetchedErrorGen !== pipelineCache._errorSwapGeneration;
      if (
        primCache._pipelineNeedsRefetch ||
        primCache.pipeline === null ||
        errorSwapped
      ) {
        // Preserve the materialDefines variant across the format-change
        // refetch.
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

      // Initial standalone-model preparation starts native async pipeline
      // compilation before Model publishes its ready event. Resource
      // extraction/cache creation above is the shared preparation boundary;
      // camera/light/material uploads and command realization below remain on
      // the first renderable frame. In particular this path emits no command,
      // performs no private submission, and does not advance TAA history.
      if (pipelineWarmupOnly) {
        continue;
      }

      // Per-frame poll: any slot that fell back to a default
      // placeholder texture during the initial ensurePrimitiveCache
      // call gets re-checked here. As soon as the matching glTF
      // texture reader resolves its image source, the real GPU texture
      // is uploaded and a textureEntries rebuild is forced below so the
      // bind group picks up the new view.
      // Cheap when nothing is pending (a single Set.size check); the
      // upload cost only fires once per slot per primitive.
      const texturesUpgraded = refreshDeferredModelTextures(
        device,
        cache.resourceGeneration,
        primCache,
        matInfo,
        enqueueMip,
        cache._cancelTextureMipGeneration,
      );

      // When the primitive declares transmission and the SceneRenderer
      // has published a refraction view this frame, ensure the texture
      // bind group points at the latest view. This costs a reference
      // compare against the last-bound view; the rebuild happens only on
      // first use, or when the scene framebuffer reallocates the
      // refraction texture (a resize or HDR toggle). It also publishes
      // the per-frame "scene has transmission" flag so the
      // SceneRenderer's capture pass fires. Texture entries are tracked
      // instead of a standalone bind group.
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
      // keeps the white fallback even after the real texture loads.
      if (!defined(primCache.textureEntries) || texturesUpgraded) {
        primCache.textureEntries = getModelTextureEntries(
          primCache,
          primCache.refractionViewBound ?? null,
          primCache.materialDefines | 0,
          getCustomShaderEntries(cache, pipelineCache),
        );
      }

      // Create the per-primitive material uniform buffer (once). The merged
      // group 1 bind group is built per-frame at the draw command emission
      // site (material UBO + texture entries + featureId entries in one BG).
      //
      // There is deliberately no per-primitive light buffer here. The light
      // block is a property of the (model, view) pair, so a per-primitive copy
      // would be byte-identical across the model and would pay its own pack
      // and upload; it rides one arena slice on group 0 instead.
      if (!defined(primCache.materialBuffer)) {
        primCache.materialBuffer = WebGPUBuffer.createUniformBuffer(
          device,
          MATERIAL_UNIFORM_SIZE,
          `Prim material`,
        );
        primCache.materialData = new Float32Array(MATERIAL_UNIFORM_SIZE / 4);
        primCache.materialUploadState = createPackedMaterialUploadState(
          primCache.materialData,
        );
      }
      // Determine if this specific primitive has skinning: the node has a skin
      // and the primitive has joints/weights attributes.
      const primHasSkinning = hasSkinning && primCache.hasSkinningAttributes;

      // Morph targets: create/update GPU resources per-primitive
      const morphWeights =
        runtimeNode.morphWeights ?? runtimeNode._morphWeights;
      const primHasMorphTargets =
        geometry.morphTargetCount > 0 &&
        defined(morphWeights) &&
        morphWeights.length > 0;
      // Track morph target buffers instead of a standalone bind group.
      // The merged group 2 bind group at the draw command emission site
      // composes them with skinning and instancing into one bind group.
      let morphDeltaBuffer = null;
      let morphWeightBuffer = null;
      // Prev-frame mirror for TAA velocity. Same swap pattern as
      // `prevPackedJointMatrices`.
      let prevMorphWeightBuffer = null;
      if (primHasMorphTargets) {
        const morphRes = ensureMorphTargetResources(
          device,
          primCache,
          geometry,
          morphWeights as unknown as Parameters<
            typeof ensureMorphTargetResources
          >[3],
          resetTemporalHistory,
        ) as MorphTargetResourcesLike | undefined;
        if (defined(morphRes)) {
          morphDeltaBuffer = morphRes.storageBuffer;
          morphWeightBuffer = morphRes.weightBuffer;
          prevMorphWeightBuffer = morphRes.weightBufferPrev;
        }
      }

      // Per-glTF-primitive pick ID allocation, delegated to
      // {@link ensurePickId} in multi-id mode (`idKey = primKey`). Each
      // glTF primitive of a model gets its own pick color so
      // `scene.pick()` can resolve back to
      // `{primitive: model, id: primKey}`. Per-feature pick, mapping each
      // EXT_mesh_features feature to its own pick target, is a separate
      // and larger workstream. The cache key `nodeIdx_primIdx` matches
      // `primKey` so pick IDs follow primitive identity stably across
      // re-extractions.
      const passes = frameState.passes;
      const allowAllocate = !!(passes && (passes.pick || passes.render));
      const modelPickId = ensurePickId(
        model as unknown as Parameters<typeof ensurePickId>[0],
        context as unknown as Parameters<typeof ensurePickId>[1],
        cache as unknown as Parameters<typeof ensurePickId>[2],
        {
          idKey: primKey,
          allowAllocate,
          // Fold a `detail.model` into the pick object so the
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

      // Track per-model previousModelMatrix on the model's WebGPU cache:
      // one slot for the whole model, because every primitive shares the
      // same matrix per frame. The motion-vector output gates on
      // `frameState.taaEnabled` so static scenes do not pay the
      // per-fragment velocity cost. Capturing the matrix on the model
      // rather than the primitive avoids storing it once per primitive of
      // a multi-mesh asset.
      if (!defined(cache.prevModelMatrix)) {
        cache.prevModelMatrix = Matrix4.clone(modelMatrix);
      }
      const motionEnabled = frameState?.taaEnabled === true;

      // Primary command class. The model emits the OPAQUE-class command
      // first (passClass=0). When the model carries a
      // Cesium3DTileBatchTable and its alphaMode is OPAQUE or MASK, the
      // renderer emits a second translucent-class command (passClass=1,
      // pass=Pass.TRANSLUCENT) so per-feature styling can flip individual
      // features to translucent without pipeline state changes; see the
      // dual-command emission block below. Models whose alphaMode is
      // BLEND already land in the TRANSLUCENT pass, so their primary
      // command is the translucent-class one and no derivation is needed.
      const passClass = matInfo.alphaMode === AlphaModes.BLEND ? 1 : 0;

      // Update material uniforms: skinning and morph flags, the pick
      // color slot, TAA per-model motion, and the tile-batch passClass.
      // The per-runtime-node modelMatrix
      // (`modelMatrix * runtimeNode.computedTransform`, where
      // `computedTransform = transformToRoot × transform`) is what gets
      // passed, so the FS world-space reconstructions
      // (`material.modelMatrix * input.rteMC` in ModelPBRComplete.wgsl)
      // compose with the correct parent-chain and local transform for
      // articulated rigs.
      if (defined(preparationWork)) {
        preparationWork.materialPacks++;
      }
      const primaryMaterialUploadState =
        primCache.materialUploadState ??
        (primCache.materialUploadState = createPackedMaterialUploadState(
          primCache.materialData,
        ));
      packMaterialUniforms(
        primCache.materialData,
        primaryMaterialUploadState.currentWords,
        nodeModelMatrix,
        matInfo,
        primHasSkinning,
        primHasMorphTargets,
        pickColor,
        // Per-node previous transform.
        prevNodeModelMatrixForPack,
        motionEnabled,
        passClass,
      );

      // The split scalars ride the material UB's pad lanes (floats 38/39,
      // `_pad_end2`/`_pad_end3` in ModelPBRComplete.wgsl, which
      // packMaterialUniforms zeroes just above). They are packed
      // unconditionally, like the log-depth lanes; only the
      // `//>>ifdef MODEL_SPLIT_ENABLED` FS blocks read them.
      primCache.materialData[38] = modelSplitDirection;
      primCache.materialData[39] = modelSplitPositionPx;

      // model.color rides the material UB's reserved tail lane (floats
      // 184-187, `_pad_reserved8`) and the blend scalar rides
      // `motionFlags.w` (float 175). packMaterialUniforms zero-fills both
      // just above, so the undefined-color default stays byte-identical;
      // only the `//>>ifdef MODEL_HAS_COLOR` FS blocks read them.
      if (modelHasColor) {
        primCache.materialData[175] = modelColorBlend;
        primCache.materialData[184] = modelColor.red;
        primCache.materialData[185] = modelColor.green;
        primCache.materialData[186] = modelColor.blue;
        primCache.materialData[187] = modelColor.alpha;
      }

      // Feature ID textures and batch texture, for per-feature styling.
      // `context`, the per-model `cache`, and a `pickPassActive` hint are
      // threaded through so `ensurePerFeaturePickIds` can allocate
      // per-feature pickIds. `featureIdRes.featureIdEntries` are entries
      // (bindings 26-32) spliced into the merged group 1.
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

      // Set instancing and feature ID flags after packMaterialUniforms.
      {
        let currentFlags = primaryMaterialUploadState.currentWords[28];
        if (hasInstancing && instanceCount > 1) {
          currentFlags |= FLAG_HAS_INSTANCING;
        }
        if (defined(featureIdRes)) {
          currentFlags |= featureIdRes.flags;
          featureIdEntries = featureIdRes.featureIdEntries;
        }
        primaryMaterialUploadState.currentWords[28] = currentFlags;
      }

      if (
        uploadPackedMaterialUniformsIfChanged(
          device,
          primCache.materialBuffer.buffer,
          primCache.materialData,
          primaryMaterialUploadState,
        )
      ) {
        if (defined(preparationWork)) {
          preparationWork.materialUploads++;
        }
      }

      // There is deliberately no per-primitive light pack, byte-compare and
      // upload here. It would run once per primitive for a block that depends
      // only on `frameState` and `model`, and its unchanged-write suppression
      // could only ever fire while the camera was perfectly still, because the
      // block's punctual positions and eye→world rotation are relative to the
      // live RTE eye. `prepareModelViewLightSlice` packs it once per model per
      // view instead, ahead of the first group-0 acquisition.

      // Variant-aware vertex buffer slots. When MODEL_HAS_TEXCOORD_1
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
      // (*) When tex1 is unset but feat0 is set, featureId0 still has to
      // be pushed, at the same `shaderLocation = 8` per the
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
      // Slot 9 (metadata scalar) is present only on metadata models. The
      // vertexBuffers array must match the pipeline layout's slot count
      // exactly or `setVertexBuffer` errors.
      const hasMetadata =
        (primCache.materialDefines & ShaderDefine.MODEL_HAS_METADATA) !== 0;
      // Bind the reprojected accurate-2D position buffer when the model is
      // projectTo2D-active and the buffer has been built; otherwise the
      // untouched 3D position buffer, which keeps the off case
      // byte-identical.
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
      // Metadata scalar at slot 9. Pushed last so the array index
      // matches the layout's final buffer slot. The
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
      // Alpha blend primitives override to TRANSLUCENT.
      // When `model.classificationType` is set, the model becomes a
      // classification volume: the command routes into the appropriate
      // classifier pass and uses the depth-sample classifier pipeline
      // instead of the lit PBR pipeline. Mirrors WebGL's
      // `ClassificationModelDrawCommand` pass routing
      // (`Source/Scene/Model/ClassificationModelDrawCommand.js`).
      // `classificationType: BOTH` emits two commands per primitive, one
      // for TERRAIN and one for 3D Tile, rather than collapsing to a
      // single 3D Tile pass. The non-classifier path emits a single
      // command. Both paths run through the same `passes` loop below.
      //
      // Resolve the model's EdgeDisplayMode for this edge-bearing
      // primitive. Mirrors WebGL's `ModelDrawCommand.pushCommands` /
      // `pushEdgeCommands`:
      //   - SURFACES_ONLY (default): surface renders, edges suppressed.
      //   - SURFACES_AND_EDGES: surface renders, edges go to the MRT
      //     (`CESIUM_3D_TILE_EDGES`) for the composite pass.
      //   - EDGES_ONLY: surface suppressed for edge-bearing primitives,
      //     edges go to `CESIUM_3D_TILE_EDGES_DIRECT`, which renders
      //     straight onto the scene framebuffer as a CAD wireframe.
      // WebGL's `_needsEdgeCommands` means "this primitive actually
      // produced edge geometry": it gates on
      // `defined(renderResources.edgeGeometry)`, not merely on the
      // extension's presence, so a primitive that declares
      // `EXT_mesh_primitive_edge_visibility` but yields no extractable
      // edges keeps its surface. The same rule holds here: the edge
      // emitter below sets `primCache.edgeResources = false` — a sentinel
      // distinct from `undefined`, which means "not yet checked" — once it
      // confirms a primitive has no edges. Suppress the surface only when
      // edges are present or not yet determined (`!== false`), so that on
      // the steady-state frame after the first, a degenerate edge-less
      // primitive falls back to rendering its surface exactly like WebGL.
      // Classifiers never run the edge stage, so the suppression skips
      // them.
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

      // Forward the source JS-side renderState so the
      // `applyPerEncoderState` hook fires per-draw stencilRef /
      // blendConstant / viewport / scissor. Model primitives set distinct
      // renderStates for silhouette, shadow, backface and classification
      // variants in `ModelDrawCommand.js`; forwarding the base-color
      // renderState covers the primary draw. Derived-variant coverage
      // (silhouette / shadow-receive / depth-fail) is still open in the
      // `selectCommandVariant` dispatcher: once populators exist they
      // will pull renderState from their corresponding derived
      // ModelDrawCommand slot.
      // A native model feature renderer receives the same shared
      // pipeline-stage semantics through the backend-neutral descriptor and
      // does not realize an unused WebGL ShaderProgram/VertexArray/DrawCommand.
      // The fallback covers a model built without that descriptor path, and
      // isolated renderer specs.
      const modelRenderState =
        rp.backendNeutralDescriptor?.renderState ??
        rp.drawCommand?._command?.renderState;

      // Four merged bind groups. `materialDefines` selects the per-variant
      // materialBGL, and the memoized IBL entries keep a stable array identity
      // while the five resolved IBL identities are unchanged, so the group-1
      // cache below keys on one array reference.
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
        // Static GPU instancing, the only case currently produced,
        // aliases the current buffer for a zero velocity contribution.
        // Animated instancing would give the node cache a separate
        // `prevInstancingBuffer`.
        instanceBuffer,
      );

      // Route through the classification pipeline when the model is a
      // classifier. Same vertex stage, bind groups, vertex buffers and
      // index buffer; only the fragment entry differs, sampling globe
      // depth, discarding on sky, and emitting `material.baseColorFactor`.
      // When the silhouette is active, the base draw swaps to the
      // stencil-write variant, matching WebGL
      // `deriveSilhouetteModelCommand`: same shading, stencil ALWAYS and
      // zPass REPLACE stamp `model._silhouetteId % 255`, and invisible
      // models zero the colour writeMask. The derived colour command is
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
            // Preserve the materialDefines variant for the
            // classification pipeline so it pairs with the matching
            // per-variant materialBGL the bind group above was
            // constructed against.
            primCache.materialDefines | 0,
          )
        : modelHasSilhouette
          ? primCache.silhouettePipeline
          : primCache.pipeline;

      // Ready gate. The on-screen color pipeline (`primCache.pipeline`) is
      // compiled via `createRenderPipelineAsync` and is null while the variant
      // is still cooking. Skip this primitive's draw for the cooking frame; a
      // null pipeline must never be bound, since `WebGPUDrawCommand` requires
      // one and a null `setPipeline` is a validation error. The per-frame
      // refetch guard above re-polls `primCache.pipeline`, so the draw appears
      // within one frame of the async compile landing, matching the globe's
      // `resolveGlobePipelineEntry` skip-a-frame behavior. The classifier and
      // silhouette paths build their pipelines synchronously, so only the
      // normal color path can be null here.
      if (!defined(activePipeline)) {
        continue;
      }

      // Prepare the exact RTE camera block at the first command that consumes
      // it. Identity nodes share one model-level block per update; transformed
      // nodes own one node block.
      if (!defined(nodeCameraBG)) {
        // Realize this model's single light block at the first command that
        // will bind it, mirroring the camera's lazy realization. Both branches
        // below pair their camera slice with this exact slice.
        if (!defined(modelLightSlice)) {
          modelLightSlice =
            prepareModelViewLightSlice(
              device,
              frameState,
              cache,
              model,
              preparationWork,
            ) ?? undefined;
        }
        if (!defined(modelLightSlice)) {
          // Dead-device degradation, per `resolveModelCameraArenaOwner`: skip
          // this primitive's draw. Nothing can render on a dead device, and
          // the arena helpers stay loud for every non-lifecycle null.
          continue;
        }
        if (transformIsIdentity) {
          if (!rootCameraPreparedThisFrame) {
            if (!defined(cache.cameraData)) {
              cache.cameraData = new Float32Array(CAMERA_UNIFORM_SIZE / 4);
            }
            if (defined(preparationWork)) {
              preparationWork.cameraPacks++;
            }
            packCameraUniforms(cache.cameraData, frameState, modelMatrix);
            if (projectTo2DActive) {
              // Restore the 3D-frame normal matrix so diffuse lighting keeps
              // the model's world orientation (translate(reference) has none).
              overrideProject2DNormalMatrix(
                cache.cameraData,
                frameState,
                model._sceneGraph._computedModelMatrix,
              );
            }
            if (defined(preparationWork)) {
              preparationWork.cameraWrites++;
            }
            // One arena slice per model per update, rather than one persistent
            // buffer plus one `queue.writeBuffer` per frame. The staged bytes
            // reach the queue in the ring's single per-page flush, which the
            // context runs before the frame is submitted.
            rootCameraBinding =
              acquireModelCameraBinding(
                device,
                frameState,
                pipelineCache,
                cache.cameraData,
                "Model camera",
                modelLightSlice,
              ) ?? undefined;
            if (!defined(rootCameraBinding)) {
              // Dead-device skip. Deliberately not marked prepared, so a
              // later primitive re-attempts instead of binding undefined.
              continue;
            }
            rootCameraPreparedThisFrame = true;
          }
          nodeCameraBG = rootCameraBinding!.bindGroup;
          nodeCameraOffsets = rootCameraBinding!.dynamicOffsets;
        } else {
          const nc = cache.nodes[nodeIdx];
          if (!defined(nc.cameraData)) {
            nc.cameraData = new Float32Array(CAMERA_UNIFORM_SIZE / 4);
          }
          if (defined(preparationWork)) {
            preparationWork.cameraPacks++;
          }
          packCameraUniforms(nc.cameraData, frameState, nodeModelMatrix);
          if (defined(preparationWork)) {
            preparationWork.cameraWrites++;
          }
          const nodeBinding = acquireModelCameraBinding(
            device,
            frameState,
            pipelineCache,
            nc.cameraData,
            `Model camera node[${nodeIdx}]`,
            modelLightSlice,
          );
          if (nodeBinding === null) {
            // Dead-device skip, same posture as the identity branch above.
            continue;
          }
          nodeCameraBG = nodeBinding.bindGroup;
          nodeCameraOffsets = nodeBinding.dynamicOffsets;
        }
      }

      // The stencil-write pipeline needs the model's stencil reference
      // set per-draw (`applyPerEncoderState`
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

      // `passes[0]` is the primary pass. The non-classifier path always
      // has length 1, so the pick, velocity, dual, translucent and edge
      // code below operates on `webgpuCmd`, the primary command. The
      // classifier path may have length 2 for BOTH; the second command is
      // built from the same args after the primary push and goes straight
      // onto the commandList without pick or velocity attachments,
      // because a classifier neither picks nor emits velocity.
      const primaryPass = drawPasses[0];
      const webgpuCmdArgs = {
        pipeline: activePipeline,
        bindGroups: [
          nodeCameraBG, // group 0 — per-runtime-node when computedTransform != I
          mergedMaterialBG, // group 1 (material + light + textures + featureId)
          mergedInstanceBG, // group 2 (skinning + morph + instancing)
          cache.effectsBG, // group 3
        ],
        // Group 0 is a dynamic-offset layout; groups 1-3 are not.
        bindGroupDynamicOffsets: [
          nodeCameraOffsets,
          undefined,
          undefined,
          undefined,
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
        ...colorShadowFlags,
        // Depth-write variant pipeline for BLEND primitives. Only
        // consumed when the command's
        // `depthForTranslucentClassification` flag is set (forwarded by
        // `Cesium3DTile.update` for translucent tile content). Undefined
        // for OPAQUE/MASK because they already write depth.
        classificationDepthPipeline: primCache.depthWritePipeline,
      };
      const webgpuCmd: ModelDrawCommand = new WebGPUDrawCommand(webgpuCmdArgs);

      // OIT reachability for a natively-translucent (BLEND alphaMode) model
      // primary command. Attach the OIT variant inputs so
      // `executeTranslucentPass` auto-builds the MRT accumulation pipeline
      // under the containment gate. Classifiers are skipped because they draw
      // via globe depth rather than as a reflective or translucent surface, and
      // silhouetted models are skipped because the silhouette OIT body wash is
      // not implemented. The command is only reached once `activePipeline` is
      // ready, since the async ready gate above continues otherwise, and the
      // OIT variant is built synchronously on demand in the translucent pass,
      // so it never renders during pipeline warmup. It is inert when the gate
      // is off, leaving that path byte-identical.
      if (
        primaryPass === Pass.TRANSLUCENT &&
        !isClassifier &&
        !modelHasSilhouette
      ) {
        const oit = pipelineCache.getOITColorConfig(
          matInfo.alphaMode,
          matInfo.isDoubleSided,
          primCache.materialDefines | 0,
        );
        if (oit) {
          webgpuCmd._shaderCode = oit.shaderCode;
          webgpuCmd._pipelineConfig = oit.pipelineConfig;
        }
      }

      // Collect this primitive's camera-independent draw resources so the
      // env-map capture pass can replay it per cube face. Skips:
      //   - classifiers (`isClassifier`): they draw via globe-depth sampling,
      //     not as reflective surfaces.
      //   - edge-only suppressed surfaces (`suppressSurfaceForEdgesOnly`): the
      //     surface command exists only to seed edges, not to be reflected.
      //   - translucent (BLEND) primitives: the capture pipeline is opaque,
      //     with no blend state, and writes depth, so a translucent surface
      //     captured opaquely would write a wrong, fully-opaque reflection and
      //     occlude geometry behind it. Reflecting translucency correctly needs
      //     a blended capture variant, which does not exist.
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
          // Capture replay builds its pipeline next frame from the record
          // alone, so both halves of the topology axis travel with it. A
          // strip record without its index format would build an invalid
          // pipeline.
          topology: primCache.topology,
          stripIndexFormat: primCache.stripIndexFormat,
          // Carry the generated metadata chunk and class hash so the capture
          // replay (`getOrCreateModelCaptureCommands`) can prepend the same
          // `struct Metadata` before building the capture pipeline. Otherwise
          // a metadata model in the env-capture set would compile a
          // MODEL_HAS_METADATA module with no `initializeMetadata` declared.
          // Undefined for non-metadata primitives, where the capture build
          // clears it.
          metadataWGSL: primCache._metadataWGSL,
          metadataClassHash: primCache._metadataClassHash | 0,
          // The capture replay must rebuild its pipeline with the same
          // widened-transport variant.
          metadataMatTransport: primCache._metadataMatTransport === true,
          materialBuffer: primCache.materialBuffer,
          // No light buffer travels with the record: the replay packs its own
          // face-view light block, which it must, because the block is
          // relative to the face eye.
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
          // The clone is required: for non-identity nodes `nodeModelMatrix`
          // aliases the shared `scratchNodeModelMatrix`, which the next node
          // iteration overwrites, and capture runs the following frame from
          // last frame's published refs, so a live reference would be stale.
          nodeModelMatrix: Matrix4.clone(nodeModelMatrix),
        });
      }

      // Shadow cast tagging.
      //
      // Three variants cover the model path:
      //
      //   primHasSkinning          → `modelSkinned`
      //       Binding 1 = root-shared or per-node modelMatrix UB
      //       Binding 2 = joint matrices storage buffer (same buffer
      //       the color pass binds at @group(3))
      //       VBs pulled from slots 0/5/6 of the command's full
      //       7-buffer layout (pos, joints0, weights0).
      //
      //   instanceCount === 1      → `modelP12`
      //       Single-instance non-skinned case. Binding 1 = root/node UB.
      //
      //   instanceCount > 1        → `modelInstancedSB`
      //       GPU-instanced non-skinned case. Binding 1 = root/node UB,
      //       Binding 2 = per-instance transforms storage buffer
      //       (same buffer the color pass binds at @group(5)).
      //
      // Skinning + instancing together is uncommon (animated crowds) and not
      // covered by a combined variant yet. It fails closed below rather than
      // selecting a shader that casts undeformed or uninstanced geometry.
      if (shadowCastingActive && !suppressSurfaceForEdgesOnly) {
        const nodeCache = cache.nodes[nodeIdx];
        const shadowCastLayout = getModelShadowCastLayout(
          primHasSkinning,
          instanceCount,
          defined(nodeCache?.jointBuffer),
          defined(nodeCache?.instancingBuffer),
        );
        if (!defined(shadowCastLayout)) {
          // Never leave castShadows=true without a complete explicit model
          // variant. The stride fallback would reinterpret model-space P12 as
          // RTE/world-space data and corrupt the shadow map.
          webgpuCmd.castShadows = false;
          oneTimeWarning(
            "WebGPUModel.shadowCastUnsupportedLayout",
            "A WebGPU model shadow caster has an unsupported or incomplete " +
              "skinning/instancing resource layout. Shadow casting is disabled " +
              "for that command until a matching native cast variant exists. " +
              "Track NEW-WEBGPU-MODEL-SKINNED-INSTANCED-SHADOW.",
          );
        } else {
          if (!nodeShadowCastUniformReady) {
            if (transformIsIdentity) {
              if (!rootShadowCastUniformReady) {
                rootShadowCastModelUB = updateModelShadowCastUniform(
                  device,
                  cache,
                  nodeModelMatrix,
                  "Model shadow cast UB",
                  shadowCameraPositionWC,
                  cache.cameraData,
                );
                rootShadowCastUniformReady = true;
              }
              nodeShadowCastModelUB = rootShadowCastModelUB;
            } else {
              nodeShadowCastModelUB = updateModelShadowCastUniform(
                device,
                cache.nodes[nodeIdx],
                nodeModelMatrix,
                `Model shadow cast UB node[${nodeIdx}]`,
                shadowCameraPositionWC,
                cache.nodes[nodeIdx].cameraData,
              );
            }
            nodeShadowCastUniformReady = true;
          }

          webgpuCmd._shadowCastBindGroupCacheHost =
            primCache._shadowCastBindGroupCacheHost ??
            (primCache._shadowCastBindGroupCacheHost = {});
          webgpuCmd._shadowCastLayout = shadowCastLayout;
          // The shadow caster rasterizes the same realized topology as the
          // color pass. Both halves travel together so a strip caster gets its
          // own pipeline per index format instead of aliasing.
          webgpuCmd._shadowCastTopology = primCache.topology;
          webgpuCmd._shadowCastStripIndexFormat = primCache.stripIndexFormat;
          webgpuCmd._shadowCastModelUB = nodeShadowCastModelUB;
          if (shadowCastLayout === "modelSkinned") {
            webgpuCmd._shadowCastJointMatricesSB = nodeCache.jointBuffer;
          } else if (shadowCastLayout === "modelInstancedSB") {
            webgpuCmd._shadowCastInstancingSB = nodeCache.instancingBuffer;
          }
        }
      }

      // Pick command. Same layout, vertex stage, vertex buffers, bind
      // groups, and index buffer as the color command; only the pipeline
      // differs, with a pick fragment entry, no blend, and depth write
      // forced on. Wired onto the color command's
      // `derivedCommands.picking.pickCommand` so the dispatcher
      // (`selectCommandVariant` in `WebGPUSceneRenderer.ts`) routes here
      // during pick passes. Only materialized when a pick ID exists:
      // models in non-pick render passes (frameState.passes.pick=false
      // and passes.render=false) skip pick-id allocation, so `pickColor`
      // can be undefined here on an offscreen or update-only frame.
      // Classifiers do not pick. WebGL's
      // `ClassificationModelDrawCommand` allocates no pick command
      // either; a classifier draws into the TERRAIN or 3D-Tile pass on
      // the scene framebuffer, not the pick FBO.
      if (pickColor && !isClassifier) {
        if (!defined(primCache.pickPipeline)) {
          primCache.pickPipeline = pipelineCache.getPickPipeline(
            matInfo.alphaMode,
            matInfo.isDoubleSided,
            // The pick pipeline must use the same per-variant pipeline
            // layout as the color pipeline so it pairs with the same
            // merged group-1 bind group at draw time.
            primCache.materialDefines | 0,
          );
        }
        // Shared draw args reused across all pick variants (default,
        // hover, precise pass 1, precise pass 2). Only the pipeline
        // differs between them; same vertex buffers, bind groups, and
        // index buffer apply to every variant.
        const sharedPickDrawArgs = {
          bindGroups: [
            nodeCameraBG, // per-runtime-node camera bind group
            mergedMaterialBG,
            mergedInstanceBG,
            cache.effectsBG,
          ],
          // Pick renders the same view as the color command, so it binds the
          // same group-0 slice.
          bindGroupDynamicOffsets: webgpuCmdArgs.bindGroupDynamicOffsets,
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
          ...nonColorShadowFlags,
        };
        const pickCmd = new WebGPUDrawCommand({
          ...sharedPickDrawArgs,
          pipeline: primCache.pickPipeline,
        });
        attachPickToColorCommand(webgpuCmd, pickCmd);

        // Snapping-pass variant. Same draw args as every pick variant, with
        // only the pipeline differing, so the snap draw rasterizes exactly the
        // geometry the pick draw does; the pipeline swaps the fragment entry
        // to `fragmentSnapMain` and the color target to the RGBA32F
        // snap-payload format.
        //
        // Materialize the derived draw only for the current snap mini-frame.
        // `pickBegin` sets `passes.snap` before updating model commands, so the
        // first snap remains synchronous on the command-production side. The
        // context's ever-used diagnostic latch must not make every later color
        // frame allocate a snap command after a single earlier Scene.snap call.
        if (frameState?.passes?.snap === true) {
          if (!defined(primCache.snapPipeline)) {
            primCache.snapPipeline = pipelineCache.getSnapPipeline(
              matInfo.alphaMode,
              matInfo.isDoubleSided,
              primCache.materialDefines | 0,
            );
          }
          const snapCmd = new WebGPUDrawCommand({
            ...sharedPickDrawArgs,
            pipeline: primCache.snapPipeline,
          });
          attachSnapToColorCommand(webgpuCmd, snapCmd);
        }

        // Hover pick variant. The pipeline is built lazily on the first
        // frame the scene requests hover-mode pick. For BLEND alphaMode
        // it is built unconditionally here so the cost is one pipeline
        // allocation paid up front; for OPAQUE/MASK the factory delegates
        // to the regular pick pipeline, so the lookup is a cache hit and
        // no extra allocation happens.
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

        // Precise pick variant. For OPAQUE/MASK, pass 1 is the regular
        // pick pipeline, because the factory delegates, and pass 2 is
        // null; the dispatcher handles the null fall-through by skipping
        // pass 2. For BLEND, both passes are real, with a depth-only
        // pass 1 and a depth-EQUAL color pass 2 sharing the pick FBO
        // depth attachment within a single render pass.
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
          // Both precise passes need stencilReference=1 set on the
          // render pass encoder before their draw. Pass 1's
          // `passOp: replace` writes 1, replacing the cleared 0, and
          // pass 2's `compare: equal` matches stencil == 1, so only
          // pass-1-covered pixels survive. Without the reference the
          // stencil mechanism is non-functional: pass 1 writes 0 (the
          // default ref), which is identical to the FBO clear value, so
          // pass 2 fires on every pixel rather than only pass-1 winners.
          // `applyPerEncoderState` reads `renderState.stencilTest.reference`
          // and calls `passEncoder.setStencilReference()` when nonzero.
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

      // Metadata-pick command, the producer behind scene.pickMetadata. Built
      // only during a metadata-pick pass (`frameState.pickingMetadata`) and
      // only for a metadata-bearing, non-classifier primitive. The
      // `selectCommandVariant` dispatcher returns this command from
      // `derivedCommands.pickingMetadata.pickMetadataCommand` when
      // `frameState.pickingMetadata` is set. It reuses the same bind groups,
      // vertex buffers and index buffer as the color and pick commands, so no
      // new pipeline layout is needed; only the pipeline, whose fragment writes
      // the metadata RGBA, and the prepended generated metadata-pick chunk
      // differ. The gate is tight so a normal render or regular pick pass is
      // byte-identical: the block is never entered unless pickMetadata is
      // actively running.
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
          // Publish the pick chunk and its property-folded hash so the pipeline
          // cache prepends it and keys the pick module per picked property.
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
            bindGroupDynamicOffsets: webgpuCmdArgs.bindGroupDynamicOffsets,
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
            ...nonColorShadowFlags,
          });
          attachPickMetadataToColorCommand(webgpuCmd, pickMetadataCmd);
        }
      }

      // Velocity command derivation. When TAA is on
      // (frameState.taaEnabled), attach a velocity-only draw command
      // alongside the color command. The SceneRenderer's velocity pass
      // (`_runVelocityPass`) walks the frustum command lists, picks any
      // command carrying a `.velocityCommand` slot, and dispatches it
      // into a single-target rg16float render pass sharing scene depth
      // read-only. It reuses the color command's bind groups, vertex
      // buffers, index buffer and instance count; the only differences
      // are the velocity-variant pipeline and the absence of blend and
      // depth-write state. Materialized once per primitive per frame.
      //
      // Translucent (BLEND) primitives emit no velocity: they do not
      // write scene depth in the color pass, so the velocity pass's
      // read-only depth attachment cannot establish visibility for them.
      // Routing translucent velocity through OIT-style accumulation
      // needs more architectural work, because the rg16float resolve
      // target does not accumulate cleanly with src-alpha blending.
      if (
        motionEnabled &&
        matInfo.alphaMode !== AlphaModes.BLEND &&
        !isClassifier
      ) {
        if (!defined(primCache.velocityPipeline)) {
          primCache.velocityPipeline = pipelineCache.getVelocityPipeline(
            matInfo.alphaMode,
            matInfo.isDoubleSided,
            // The velocity pipeline must use the same per-variant
            // pipeline layout as the color pipeline so it pairs with the
            // same merged group-1 bind group at draw time.
            primCache.materialDefines | 0,
          );
        }
        const velocityCmd = new WebGPUDrawCommand({
          pipeline: primCache.velocityPipeline,
          bindGroups: [
            nodeCameraBG, // per-runtime-node camera bind group
            mergedMaterialBG,
            mergedInstanceBG,
            cache.effectsBG,
          ],
          // Motion vectors are derived from the same camera block, including
          // its `previousViewProjection` tail, so they bind the same slice.
          bindGroupDynamicOffsets: webgpuCmdArgs.bindGroupDynamicOffsets,
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
          ...nonColorShadowFlags,
        });
        webgpuCmd.velocityCommand = velocityCmd;
      }

      // EDGES_ONLY suppresses the surface command for edge-bearing
      // primitives so only the edge pass renders, giving a CAD
      // wireframe. Mirrors WebGL's early return in
      // `ModelDrawCommand.pushCommands`, which skips `_originalCommand`
      // while still pushing the edge command via `pushEdgeCommands`. The
      // edge emitter below is still reached, since it gates separately on
      // the same mode. Velocity and pick variants attached to
      // `webgpuCmd` ride along on the un-pushed command and are
      // harmless. The `isClassifier` second-pass block below never
      // coincides with this, because classifiers emit no edges.
      if (!suppressSurfaceForEdgesOnly) {
        commandList.push(webgpuCmd);
      }

      // Emit the wrapped copy of the surface command, mirroring WebGL's
      // `derive2DCommand`. Same pipeline / material / instance / effects
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
        // Under the arena the duplicate usually shares the primary command's
        // group-0 bind group, because both sit on the same ring page, and
        // differs only in its dynamic offsets. Swap both so the wrapped copy
        // can never read the primary view's camera slice. The light offset
        // inside that array is deliberately identical: the duplicate shifts the
        // model matrix, not the eye, so it reads the same camera-relative light
        // block.
        const idlDynamicOffsets = webgpuCmdArgs.bindGroupDynamicOffsets.slice();
        idlDynamicOffsets[0] = nodeIdlCameraOffsets ?? undefined;
        const idlCmd = new WebGPUDrawCommand({
          ...webgpuCmdArgs,
          bindGroups: idlBindGroups,
          bindGroupDynamicOffsets: idlDynamicOffsets,
          boundingVolume: nodeIdlBoundingSphere2D,
          modelMatrix: nodeIdlModelMatrix2D,
          ...nonColorShadowFlags,
        });
        commandList.push(idlCmd);
      }

      // For `classificationType: BOTH`, emit a second command targeting
      // the second pass. Same args as the primary command except the
      // `pass` field. Both commands share the same pipeline, bind groups
      // and vertex buffers: the renderer already computed those for the
      // primary command and they are identical for the second pass,
      // because the depth-sample classifier does not distinguish TERRAIN
      // from 3D Tile in its pipeline state, only in the pass enum the
      // dispatcher routes through.
      if (isClassifier && drawPasses.length > 1) {
        for (let p = 1; p < drawPasses.length; p++) {
          const extraCmd = new WebGPUDrawCommand({
            ...webgpuCmdArgs,
            pass: drawPasses[p],
          });
          commandList.push(extraCmd);
        }
      }

      // When the model is a classifier the classification commands have
      // already been pushed. The remaining variants — the tile-batch dual
      // command, translucent depth-write, and the edge emitter — do not
      // apply: classifiers do not pick, so no pick FBO entry is needed
      // and WebGL's ClassificationModelDrawCommand also skips pick; they
      // emit no velocity, since classified content has no TAA; and they
      // do not run the edge stage, because the classifier FS is a
      // depth-sample emit rather than the lit PBR FS that hosts the edge
      // overlay. Skip the rest of this primitive's emission.
      if (isClassifier) {
        continue;
      }

      // Derived silhouette-colour command, matching WebGL's
      // `deriveSilhouetteColorCommand`. It uses a separate material UB so
      // the base command keeps `_pad_tt2 = 0` (normal shading, stencil
      // write) while this one carries `_pad_tt2 = 1`, where the VS
      // inflates clip xy along the eye-space normal and the FS emits
      // silhouetteColor. This is the same one-shader-two-uniform-states
      // approach WebGL takes via its `model_silhouettePass` uniform
      // clone. The pipeline's stencil NOT-EQUAL test, against the same
      // per-draw reference the base command stamped, cuts the model body
      // out of the inflated draw so only the rim survives. It follows the
      // batch-table translucent-class second-UB pattern below. EDGES_ONLY
      // suppresses the surface, and therefore its rim. During pick passes
      // the command is skipped because it has no pick variant and is not
      // pickOnly, matching WebGL's `hasSilhouette && !passes.pick`.
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
          primCache.materialUploadStateSilhouette =
            createPackedMaterialUploadState(primCache.materialDataSilhouette);
        }
        const silData = primCache.materialDataSilhouette;
        // Mirror the primary UB byte-for-byte (it already carries this
        // frame's flags / split / model-color lanes), then stamp the
        // silhouette lanes on top.
        silData.set(primCache.materialData);
        // Without a real NORMAL attribute there is no inflation; WebGL
        // strips the stage via `#ifndef HAS_NORMALS`, and a zero expand
        // keeps the WGSL helper's early-return path NaN-free.
        const silhouetteHasNormals = defined(primCache.normalBuffer);
        silData[105] = silhouetteHasNormals ? silhouetteExpandX : 0.0;
        silData[106] = silhouetteHasNormals ? silhouetteExpandY : 0.0;
        silData[107] = 1.0; // silhouette-pass flag
        const silColor = model.silhouetteColor;
        silData[112] = silColor.red;
        silData[113] = silColor.green;
        silData[114] = silColor.blue;
        silData[115] = silColor.alpha;
        if (
          uploadPackedMaterialUniformsIfChanged(
            device,
            primCache.materialBufferSilhouette.buffer,
            silData,
            primCache.materialUploadStateSilhouette ??
              (primCache.materialUploadStateSilhouette =
                createPackedMaterialUploadState(silData)),
          )
        ) {
          if (defined(preparationWork)) {
            preparationWork.materialUploads++;
          }
        }

        // Render the rim in the translucent pass if either the base
        // command or the silhouette colour is translucent, matching WebGL.
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
          bindGroupDynamicOffsets: webgpuCmdArgs.bindGroupDynamicOffsets,
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
          ...nonColorShadowFlags,
        });
        silhouetteColorCommands.push(silhouetteCmd);
      }

      // Dual-command emission. When the primary command class is opaque
      // (passClass === 0) and the primitive has a batch table active,
      // also emit a translucent-class derived command so per-feature
      // styling can flip individual features to translucent without
      // pipeline state changes. Mirrors WebGL's
      // `deriveTranslucentCommand` in `Cesium3DTileBatchTable.js`. The FS
      // uses `material.tileBatchFlags.x` (passClass) to discard the
      // wrong-class features at each pass. A separate material UB lets
      // the two commands hold passClass = 0 and passClass = 1
      // independently without a per-frame second writeBuffer collision.
      const hasBatchTable =
        defined(featureIdRes) &&
        (featureIdRes.flags & MaterialFlags.HAS_BATCH_TABLE) !== 0;
      // Mirror WebGL's ModelDrawCommand.pushCommands economics: only emit the
      // translucent-class twin when the applied style actually mixes
      // per-feature opacity. `model.styleCommandsNeeded` must be read fresh
      // every frame. It is a cheap field read that Model.updateFeatureTables
      // keeps current on style mutation, and caching it would go stale across a
      // style change. For an unstyled batch-table tile it is ALL_OPAQUE(0) at
      // steady state, because Model.applyStyle sets it defined on the first
      // feature-table realization, which suppresses an all-discard phantom twin
      // that would re-run the full VS, rasterization and per-fragment batch
      // fetch only to `discard` every fragment. An `undefined` signal, meaning
      // the feature table is not yet realized, still emits the twin, matching
      // WebGL's `defined()` guard: never skip on an unknown signal.
      //
      // The opaque primary is deliberately not suppressed under
      // ALL_TRANSLUCENT. The primary command carries this primitive's pick
      // derivative (`attachPickToColorCommand`) while the twin carries none,
      // and pick dispatch is per-command from the command list
      // (`WebGPUSceneRenderer.executeWebGPUCommand`), so suppressing the
      // primary would drop feature pick on all-translucent tiles. Under
      // ALL_TRANSLUCENT the primary's passClass=0 shader discards every
      // fragment, so the residual opaque draw is visually correct — the twin
      // renders the geometry — and costs only a small redundant draw in a rare
      // case. Suppressing it would first require the twin to carry a pick
      // derivative.
      const scn = model.styleCommandsNeeded;
      const emitTranslucentTwin =
        !defined(scn) || scn !== StyleCommandsNeeded.ALL_OPAQUE;
      // The dual translucent-class command is a surface derivative —
      // per-feature styling of the same geometry — so EDGES_ONLY must
      // suppress it alongside the primary surface command above;
      // otherwise the surface would still render through the batch-table
      // styling path in wireframe mode.
      if (
        passClass === 0 &&
        hasBatchTable &&
        !suppressSurfaceForEdgesOnly &&
        emitTranslucentTwin
      ) {
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
          primCache.materialUploadStateTranslucent =
            createPackedMaterialUploadState(primCache.materialDataTranslucent);
          // The translucent-class material UB is an alternate buffer;
          // the merged group 1 bind group for this pass is built per
          // frame at the draw command site below using
          // `materialBufferTranslucent` instead of the primary
          // `materialBuffer`.
        }
        // Pack with passClass=1, the only field that differs from the
        // primary. Re-running the full packer costs about 768 extra
        // bytes of writeBuffer per batch-table primitive per frame,
        // which is negligible against the per-fragment savings of
        // correct classification.
        if (defined(preparationWork)) {
          preparationWork.materialPacks++;
        }
        const translucentMaterialUploadState =
          primCache.materialUploadStateTranslucent ??
          (primCache.materialUploadStateTranslucent =
            createPackedMaterialUploadState(primCache.materialDataTranslucent));
        packMaterialUniforms(
          primCache.materialDataTranslucent,
          translucentMaterialUploadState.currentWords,
          modelMatrix,
          matInfo,
          primHasSkinning,
          primHasMorphTargets,
          pickColor,
          cache.prevModelMatrix,
          motionEnabled,
          1, // passClass = translucent
        );
        // Mirror the primary UB's split-scalar pad lanes (floats 38/39 =
        // _pad_end2/_pad_end3). packMaterialUniforms just zeroed them, so
        // without this the derived translucent-class command of a split
        // batch-table model would render unsplit.
        primCache.materialDataTranslucent[38] = modelSplitDirection;
        primCache.materialDataTranslucent[39] = modelSplitPositionPx;
        // Mirror the primary UB's model-colour lanes (floats 184-187 =
        // _pad_reserved8, float 175 = motionFlags.w). packMaterialUniforms
        // just zeroed them, so without this the derived translucent-class
        // command of a coloured batch-table model would render untinted.
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
          let currentFlags = translucentMaterialUploadState.currentWords[28];
          if (hasInstancing && instanceCount > 1) {
            currentFlags |= FLAG_HAS_INSTANCING;
          }
          if (defined(featureIdRes)) {
            currentFlags |= featureIdRes.flags;
          }
          translucentMaterialUploadState.currentWords[28] = currentFlags;
        }
        if (
          uploadPackedMaterialUniformsIfChanged(
            device,
            primCache.materialBufferTranslucent.buffer,
            primCache.materialDataTranslucent,
            translucentMaterialUploadState,
          )
        ) {
          if (defined(preparationWork)) {
            preparationWork.materialUploads++;
          }
        }

        // Translucent-pass pipeline: BLEND alphaMode regardless of the
        // primary's mode so the second draw composites properly.
        if (!defined(primCache.translucentPipeline)) {
          primCache.translucentPipeline = pipelineCache.getPipeline(
            AlphaModes.BLEND,
            matInfo.isDoubleSided,
            // The translucent dual-command pipeline shares the same
            // per-variant materialBGL as the primary so the
            // mergedMaterialBGTranslucent below validates against it.
            primCache.materialDefines | 0,
          );
        }
        // Translucent-class merged group 1 bind group. Same shape as the
        // primary `mergedMaterialBG` but with the alternate
        // `materialBufferTranslucent` instead.
        const mergedMaterialBGTranslucent = getOrCreateMergedMaterialBindGroup(
          primCache,
          MERGED_MATERIAL_SLOT_TRANSLUCENT,
          device,
          pipelineCache,
          primCache.materialBufferTranslucent,
          primCache.textureEntries,
          featureIdEntries,
          iblEntries,
          primCache.materialDefines | 0,
          frameState,
        );
        // Translucent-twin ready gate. The twin's color pipeline
        // (`getPipeline(BLEND,...)` above) is compiled via
        // `createRenderPipelineAsync` and is null while cooking. Build and push
        // the twin only once its pipeline is ready; a null pipeline must never
        // be bound into `WebGPUDrawCommand`, which requires one. The
        // `if (!defined(...translucentPipeline))` block above re-polls each
        // frame, so the twin appears within one frame of the compile landing.
        if (defined(primCache.translucentPipeline)) {
          const translucentCmd: ModelDrawCommand = new WebGPUDrawCommand({
            pipeline: primCache.translucentPipeline,
            bindGroups: [
              nodeCameraBG, // per-runtime-node camera bind group
              mergedMaterialBGTranslucent,
              mergedInstanceBG,
              cache.effectsBG,
            ],
            bindGroupDynamicOffsets: webgpuCmdArgs.bindGroupDynamicOffsets,
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
            ...styledTranslucentShadowFlags,
          });
          // The native cast pass is geometry-only today: it cannot consume the
          // twin's feature-style alpha/discard state. The primary command is
          // retained even for ALL_TRANSLUCENT styling, so it is the single
          // geometric caster and the visible twin only receives shadows. This
          // avoids a second identical depth raster without removing coverage.
          // A dedicated style-aware cast command that binds feature
          // visibility, alpha and clipping inputs would replace both.
          // OIT reachability for the per-feature-styled translucent twin,
          // which is the real translucent-model case: an opaque primary plus
          // this BLEND-class twin, gated on `styleCommandsNeeded` mixing
          // opacity. The twin is always Pass.TRANSLUCENT and is only built
          // inside the `defined(primCache.translucentPipeline)` async ready
          // gate, so attaching the OIT variant here respects that gate. The
          // BLEND-alphaMode config matches the twin's own pipeline. It is
          // inert when the containment gate is off, leaving that path
          // byte-identical.
          const twinOIT = pipelineCache.getOITColorConfig(
            AlphaModes.BLEND,
            matInfo.isDoubleSided,
            primCache.materialDefines | 0,
          );
          if (twinOIT) {
            translucentCmd._shaderCode = twinOIT.shaderCode;
            translucentCmd._pipelineConfig = twinOIT.pipelineConfig;
          }
          // The selective depth-write variant is not only for tile-owned
          // models, where Cesium3DTile sets
          // `depthForTranslucentClassification = true`. Standalone Models —
          // including any glTF added via `viewer.scene.primitives.add(...)`
          // and any Model used as a classifier — need it too, so that
          // `pickPosition` and ground/Vector3DTile classifiers do not see
          // through them. It is opt-in via
          // `model.depthWriteForTranslucentPicking`, which defaults to false
          // to preserve performance, and automatic when
          // `model.classificationType !== undefined`.
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
      }

      // Emit edge visibility commands for primitives that carry
      // `EXT_mesh_primitive_edge_visibility` data. The edges render into
      // the WebGPUEdgeFramebuffer MRT via the redirect in
      // `WebGPUSceneRenderer._execute3DTilePasses`, and the composite
      // pass overlays them onto scene color.
      //
      // Resources are built once per primitive and reused across
      // frames; the per-frame cost is two `writeBuffer` calls for the
      // camera and edge uniform UBs. Primitives without edge data skip
      // the whole block, because `extractEdgeGeometry` early-returns.
      //
      // The whole emitter is gated on
      // `edgeDisplayMode !== SURFACES_ONLY`. SURFACES_ONLY is the
      // default, so until the host app opts into SURFACES_AND_EDGES or
      // EDGES_ONLY, extension edges are fully suppressed, matching
      // WebGL's early return in `ModelDrawCommand.pushEdgeCommands`.
      // Gating only on `defined(edgeVisibility)` would draw edges
      // regardless of the mode.
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
          // Pull per-vertex feature IDs from the glTF FEATURE_ID_0
          // attribute when present. Mirrors the WebGL edge stage in
          // `EdgeVisibilityPipelineStage`: look up by
          // `featureIds[0].setIndex`, find the matching `attributes`
          // entry, then read its `typedArray`. When absent, the emitter
          // falls back to writing 0 in id.g and the consumer's gate
          // stays off.
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
          // Pass per-vertex COLOR_0 as normalized RGBA so the emitter can
          // resolve per-edge colors the same way WebGL does: override,
          // then vertex color, then the no-override sentinel. The
          // primitive-level and per-lineString `materialColor` overrides
          // are read inside `extractEdgeGeometry` directly off the
          // edgeVisibility object.
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
            // Mark this primitive as having no edges so the extraction
            // does not repeat every frame. `false` is a sentinel
            // distinct from `undefined`, which means "not yet checked".
            primCache.edgeResources = false;
          }
        }

        if (primCache.edgeResources) {
          // Compute MVP = projection * view * nodeModelMatrix and
          // MV = view * nodeModelMatrix. This must use the node-level
          // matrix, the same one the surface packs via
          // packCameraUniforms, rather than the model-level
          // `modelMatrix`. Edge positions are model-space, so for a glTF
          // whose node carries a scale — the
          // EXT_mesh_primitive_edge_visibility sample's ~1e4 model-space
          // coords scale by ~0.0012 to reach world — the model-level
          // matrix omits that scale and projects every edge roughly
          // 1e4 m off-screen. RTE is not applied here, which is
          // acceptable at typical distances.
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

          // Edge color: this uniform is the fallback surface color, used
          // only when an edge writes the `a_edgeColor.a < 0` "no override"
          // sentinel. The per-primitive `materialColor`, per-lineString
          // `materialColor`, and per-vertex COLOR_0 overrides are carried
          // per-edge in the @location(7) vertex attribute, matching WebGL's
          // `a_edgeColor`. The fallback is therefore the model's base color,
          // not black, because WebGL's EdgeVisibilityStageFS keeps the
          // surface fragment color when no per-edge override is authored.
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

          // Snap lanes. The pick color is the same per-glTF-primitive ID the
          // surface's pick and snap draws emit — `ensurePickId` keyed on
          // nodeIdx_primIdx, resolved above as `pickColor`. The log-depth
          // encode pair is derived by `packCameraLogDepthLanes`, the single
          // home for that math, from the same uniformState the model's camera
          // UB lanes read at this exact update moment, so the edge snap
          // frag_depth compares coherently against the occluder-phase depth
          // the pick fleet wrote.
          packCameraLogDepthLanes(scratchEdgeLogLanes, 0, us);
          const snapLogFactor = scratchEdgeLogLanes[CAMERA_LOG_FACTOR_FLOAT];
          const snapLogNear = scratchEdgeLogLanes[CAMERA_LOG_NEAR_FLOAT];

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
            pickColor ?? null,
            snapLogFactor,
            snapLogNear,
          );

          // Pick the MRT pipeline when the scene's edge framebuffer
          // redirect is active, otherwise the single-target variant so
          // edges draw safely onto the regular one-attachment scene
          // framebuffer. This tracks `scene._enableEdgeVisibility`, the
          // same flag that gates `_edgeFramebuffer` allocation in
          // `WebGPUSceneRendererEnsureResources`. The transient case
          // where `_enableEdgeVisibility` flips on this frame but the
          // FBO has not finished allocating resolves naturally: the
          // 3D-tile dispatcher falls back to the scene FB pass when
          // `edgeFB.isReady` is false, and because the pipeline was
          // selected for the MRT layout, validation catches it. One
          // frame of clipped edges on toggle is not visually critical;
          // the mismatch that matters is the steady-state case where
          // edge visibility is off entirely.
          const sceneForEdge = frameState?.scene;
          const edgeVisibilityOn = sceneForEdge?._enableEdgeVisibility === true;

          // Pick the destination pass and pipeline by mode, mirroring
          // WebGL's `ModelDrawCommand.pushEdgeCommands`:
          //   - EDGES_ONLY → `CESIUM_3D_TILE_EDGES_DIRECT` (Pass slot 12).
          //     The direct pass renders straight onto the scene
          //     framebuffer, which has one color attachment, so it always
          //     uses the single-target pipeline regardless of
          //     `_enableEdgeVisibility`; the MRT pipeline's 3 color
          //     targets would mismatch that single attachment and fail
          //     validation.
          //   - SURFACES_AND_EDGES → `CESIUM_3D_TILE_EDGES` (Pass slot 4):
          //     keep the MRT-versus-single selection, using MRT when the
          //     edge FBO is allocated and single-target as the fallback
          //     the 3D-tile dispatcher runs on the scene FB.
          // SURFACES_ONLY never reaches here, because the emitter is
          // gated off above.
          const edgesOnly = edgeDisplayMode === EdgeDisplayMode.EDGES_ONLY;
          const edgePass = edgesOnly
            ? Pass.CESIUM_3D_TILE_EDGES_DIRECT
            : Pass.CESIUM_3D_TILE_EDGES;
          const edgePipeline =
            edgeVisibilityOn && !edgesOnly
              ? cache.edgeEmitterCache.pipeline
              : cache.edgeEmitterCache.pipelineSingleTarget;
          const edgeCmd: ModelDrawCommand = new WebGPUDrawCommand({
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
            ...nonColorShadowFlags,
          });
          commandList.push(edgeCmd);

          // Snapping-pass edge variant. Same draw args as the edge color
          // command — same quads, same bind groups — with only the
          // pipeline differing: `fragmentSnapMain` targets the RG32Uint
          // payload attachment and writes the pick key with the edge flag
          // set. Riding `derivedCommands.snapping.snapCommand` means
          // `executeSnapPayloadBatch`'s strict resolved-snap-variant
          // admission accepts it without loosening, which makes
          // `Snapping.selectBestHit`'s edge-over-surface preference live
          // on WebGPU. Materialized only for the current snap
          // mini-frame, exactly like the surface snap command above.
          if (frameState?.passes?.snap === true && pickColor) {
            const edgeSnapPipeline = ensureEdgeEmitterSnapPipeline(
              cache.edgeEmitterCache,
              device,
              isWebGPUPickLogDepthActive(
                context as unknown as Parameters<
                  typeof isWebGPUPickLogDepthActive
                >[0],
                frameState,
              ),
            );
            if (edgeSnapPipeline) {
              const edgeSnapCmd = new WebGPUDrawCommand({
                pipeline: edgeSnapPipeline,
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
                pickOnly: true,
                ...nonColorShadowFlags,
              });
              attachSnapToColorCommand(edgeCmd, edgeSnapCmd);
            }
          }
        }
      }
    }

    // Capture this frame's `nodeModelMatrix` into the per-node cache
    // slot so the next frame's pack reads it as `prev`. Mirrors the
    // model-level capture at the end of `update()`. Only fires for
    // non-identity nodes, since identity nodes share
    // `cache.prevModelMatrix`; the slot lives on the already-allocated
    // `cache.nodes[nodeIdx]`. The scratch matrix is cloned because
    // `scratchNodeModelMatrix` is reused across nodes per frame.
    if (
      !pipelineWarmupOnly &&
      !transformIsIdentity &&
      defined(cache.nodes[nodeIdx])
    ) {
      const ncForPrev = cache.nodes[nodeIdx];
      if (!defined(ncForPrev.prevNodeModelMatrix)) {
        ncForPrev.prevNodeModelMatrix = Matrix4.clone(nodeModelMatrix);
      } else {
        Matrix4.clone(nodeModelMatrix, ncForPrev.prevNodeModelMatrix);
      }
    }
  }

  // Push the derived silhouette-colour commands after every base command
  // of this model. WebGL's `ModelSceneGraph.pushDrawCommands` gathers
  // them separately and appends for the same reason: the rim must not
  // draw on top of the model's own later primitives before those have
  // stamped stencil.
  for (let i = 0; i < silhouetteColorCommands.length; i++) {
    commandList.push(silhouetteColorCommands[i]);
  }

  // Capture this frame's modelMatrix as `prevModelMatrix` so the next
  // frame's primitive pack reads the correct previous value. This runs
  // at the end of update so every primitive saw the same prev-frame
  // value during its pack call. For static models the value never
  // changes; for animated entities, whose transforms the host app
  // updates each frame, the per-frame delta drives the per-pixel
  // velocity output gated on `frameState.taaEnabled`.
  if (!pipelineWarmupOnly) {
    if (!defined(cache.prevModelMatrix)) {
      cache.prevModelMatrix = Matrix4.clone(modelMatrix);
    } else {
      Matrix4.clone(modelMatrix, cache.prevModelMatrix);
    }
  }
  // The node→primitive traversal above ran to completion, so
  // `cache.primitives` now holds every primitive this model will ever cache
  // for the current scene graph. This is recorded here, at the single tail
  // shared by the warmup and normal paths, rather than at the call site,
  // because the `_sceneGraph`/`_runtimeNodes` guard returns early without
  // visiting a node.
  cache._warmupTraversalComplete = true;
  if (defined(preparationWork)) {
    preparationWork.commandsEmitted += commandList.length - commandListStart;
  }
}

function areWebGPUModelColorPipelinesReady(model: ModelLike): boolean {
  const cache = model._webgpuCache;
  const pipelineCache = cache?.pipelineCache;
  if (!defined(cache) || !defined(pipelineCache)) {
    return false;
  }
  if (pipelineCache._pendingColorPipelines.size > 0) {
    return false;
  }
  const primitiveKeys = Object.keys(cache.primitives);
  if (primitiveKeys.length === 0) {
    // An empty primitive map is only "still preparing" until the warmup
    // traversal has walked the scene graph. A mesh-less glTF (a camera, light
    // or empty-node document) and one whose every primitive was dropped
    // because `extractPrimitiveGeometry` returned null — no POSITION or zero
    // vertices, a structural property of the loaded source rather than a
    // pending async fetch — both legitimately cache nothing, and nothing can
    // appear later without a scene-graph rebuild, which drops the whole cache.
    // Such a model has no pipeline left to wait on, so treating it as
    // never-ready would stall `Model._ready` and re-run a full warmup pass
    // forever.
    return cache._warmupTraversalComplete === true;
  }
  for (let i = 0; i < primitiveKeys.length; i++) {
    if (!defined(cache.primitives[primitiveKeys[i]]?.pipeline)) {
      return false;
    }
  }
  return true;
}

/**
 * Start or poll renderer-native preparation for a newly loaded standalone
 * model. Tile-owned and hidden models keep the plain resource-ready
 * contract: their visibility scheduler starts native work only on demand.
 *
 * The first call realizes immutable native geometry resources and kicks the
 * central asynchronous color-pipeline compile. While that promise is pending,
 * later calls are a constant-time poll. Once it resolves, one final warmup
 * call transfers the shared-cache result into each primitive cache. No draw
 * commands are emitted and no queue submission is performed here.
 */
function prepareWebGPUModel(
  model: ModelLike,
  frameState: CesiumFrameState,
): boolean {
  if (!model.show || defined(model._content)) {
    return true;
  }

  const context = frameState.context as unknown as ModelRenderContext;
  const decision = classifyWebGPUModelPreparationDemand(
    model,
    frameState,
    context,
  );
  if (decision.demand === WebGPUModelPreparationDemand.REJECTED) {
    return true;
  }

  // Standalone readiness polling can otherwise return `true` from an old
  // cache without ever entering updateWebGPUModel. Keep this after both the
  // hidden/tile fast return and the admission decision so rejected work still
  // performs no device read or cache teardown.
  disposeStaleWebGPUModelCache(
    model,
    context.device,
    context.resourceGeneration ?? 0,
  );

  if (areWebGPUModelColorPipelinesReady(model)) {
    return true;
  }
  const pending = model._webgpuCache?.pipelineCache?._pendingColorPipelines;
  if (defined(pending) && pending.size > 0) {
    return false;
  }

  updateWebGPUModel(model, frameState, true);
  return areWebGPUModelColorPipelinesReady(model);
}

// Scratch matrices for the edge-emitter MVP/MV build (avoids per-
// primitive allocation inside the hot loop).
const scratchEdgeMVP = new Matrix4();
const scratchEdgeMVPArray = new Float32Array(16);
const scratchEdgeMV = new Matrix4();
const scratchEdgeMVArray = new Float32Array(16);
// Scratch CameraUniforms-shaped lane carrier, so the edge UB's snap
// log-depth pair is derived by `packCameraLogDepthLanes` rather than a
// re-implementation. Sized to reach the highest lane the packer writes
// (CAMERA_LOG_FAR_FLOAT = 59).
const scratchEdgeLogLanes = new Float32Array(60);

/**
 * Destroys cached WebGPU resources for a Model.
 */
/**
 * Destroys one primitive cache slot's GPU resources (vertex/index/material
 * buffers, created textures, morph/featureId/metadata/edge resources).
 * Shared by full-model teardown ({@link destroyWebGPUModelResources}) and the
 * late-metadata rebuild path, where a primitive whose structural-metadata
 * resolution materializes after its cache froze a metadata-less pipeline
 * variant is destroyed and rebuilt in place.
 *
 * @param {object|undefined} pc per-primitive cache slot
 * @private
 */
function destroyPrimitiveCacheResources(
  pc: PrimitiveRenderData | undefined,
  cancelMip?: CancelMipFn,
) {
  if (!defined(pc)) {
    return;
  }

  let firstDestroyError: unknown;
  let hasDestroyError = false;
  const destroyBestEffort = (destroy: () => void): void => {
    try {
      destroy();
    } catch (error) {
      if (!hasDestroyError) {
        firstDestroyError = error;
        hasDestroyError = true;
      }
    }
  };

  // Bind groups do not have an explicit destroy operation. Release the cache
  // record before destroying any of the buffers it references.
  pc._mergedInstanceBindGroupCache = undefined;
  // Release the merged group-1 records too: a late-metadata rebuild destroys
  // and recreates the material buffers, so the cached bind groups must drop
  // their now-dangling buffer references.
  pc._mergedMaterialBindGroupCache = undefined;
  pc._mergedMaterialBindGroupCacheSilhouette = undefined;
  pc._mergedMaterialBindGroupCacheTranslucent = undefined;
  pc.materialBindGroup = null;
  pc.textureBindGroup = null;
  pc.textureViews = null;
  pc.textureSamplers = null;
  pc.textureEntries = null;

  const buffers = [
    pc.positionBuffer,
    pc.positionBuffer2D,
    pc.normalBuffer,
    pc.tangentBuffer,
    pc.uvBuffer,
    pc.uv1Buffer,
    pc.colorBuffer,
    pc.jointsBuffer,
    pc.weightsBuffer,
    pc.featureIdBuffer,
    pc.indexBuffer,
    pc.materialBuffer,
    // Translucent-class alternate material UB.
    pc.materialBufferTranslucent,
    // Silhouette-pass alternate material UB.
    pc.materialBufferSilhouette,
  ];
  pc.positionBuffer = null;
  pc.positionBuffer2D = null;
  pc.normalBuffer = null;
  pc.tangentBuffer = null;
  pc.uvBuffer = null;
  pc.uv1Buffer = null;
  pc.colorBuffer = null;
  pc.jointsBuffer = null;
  pc.weightsBuffer = null;
  pc.featureIdBuffer = null;
  pc.indexBuffer = null;
  pc.materialBuffer = null;
  pc.materialBufferTranslucent = null;
  pc.materialBufferSilhouette = null;
  for (let i = 0; i < buffers.length; i++) {
    const buffer = buffers[i];
    if (defined(buffer)) {
      destroyBestEffort(() => buffer.destroy());
    }
  }
  // There is no per-primitive light UB to destroy: the light block rides the
  // context-owned per-frame ring, which no model owns or frees.

  // Destroy created GPU textures (not default ones)
  const gpuTextures = pc.gpuTextures;
  pc.gpuTextures = [];
  for (const tex of gpuTextures) {
    if (defined(tex)) {
      if (defined(cancelMip)) {
        destroyBestEffort(() => cancelMip(tex));
      }
      destroyBestEffort(() => tex.destroy());
    }
  }

  // Destroy morph target resources
  destroyBestEffort(() => destroyMorphTargetResources(pc));

  // Destroy feature ID resources
  destroyBestEffort(() => destroyFeatureIdResources(pc));

  // Destroy metadata GPU resources (the slot-9 vertex buffer).
  destroyBestEffort(() => destroyMetadataResources(pc));

  // Destroy per-primitive edge buffers. `edgeResources === false` is
  // the sentinel for "primitive had no edges"; skip in that case.
  const edgeResources = pc.edgeResources;
  pc.edgeResources = null;
  if (edgeResources && (edgeResources as unknown) !== false) {
    destroyBestEffort(() => destroyEdgePrimitiveResources(edgeResources));
  }

  if (hasDestroyError) {
    throw firstDestroyError;
  }
}

/**
 * Reentrancy-safe common disposer for explicit Model teardown, ownership-tuple
 * mismatch, and device-invalidation callbacks.
 *
 * `model._webgpuCache` may already be undefined when the scene-level recovery
 * walk ran first. The captured cache is still safe to drain; only a different
 * live cache blocks disposal so an old callback cannot tear down a replacement.
 */
function disposeWebGPUModelCache(
  model: ModelLike,
  cache: ModelWebGPUCache,
): void {
  const activeCache = model._webgpuCache;
  if (
    cache._disposeInProgress === true ||
    (defined(activeCache) && activeCache !== cache)
  ) {
    return;
  }
  cache._disposeInProgress = true;
  if (activeCache === cache) {
    // Detach first. Any nested destroy path now sees no active cache instead
    // of releasing the shared lease or native buffers a second time.
    model._webgpuCache = undefined;
  }

  const unsubscribe = cache._deviceInvalidationUnsub;
  cache._deviceInvalidationUnsub = null;
  try {
    unsubscribe?.();
  } catch {
    // The context may already have cleared its subscriber bus during full
    // teardown. Native resource disposal remains mandatory in that case.
  }

  let firstDestroyError: unknown;
  let hasDestroyError = false;
  const destroyBestEffort = (destroy: () => void): void => {
    try {
      destroy();
    } catch (error) {
      if (!hasDestroyError) {
        firstDestroyError = error;
        hasDestroyError = true;
      }
    }
  };

  // There are no model-level or 2D/IDL camera GPU buffers to release: their
  // bytes come from the context-owned per-frame arena, which is torn down
  // before that context's ring allocator. Only the CPU staging arrays live on
  // this cache, and those are plain GC.
  const modelShadowCastUB = cache.shadowCastUB;
  cache.shadowCastUB = undefined;
  if (defined(modelShadowCastUB)) {
    destroyBestEffort(() => modelShadowCastUB.destroy());
  }

  // Release every per-primitive pick ID back to the registry so its slot can
  // be reused. This is a no-op if the model never entered a render or pick
  // pass.
  destroyBestEffort(() =>
    destroyPickIds(cache as unknown as Parameters<typeof destroyPickIds>[0]),
  );

  // Every primitive is an independent owner. A lost-device implementation is
  // allowed to throw from destroy(), but that must not strand later owners.
  const primKeys = Object.keys(cache.primitives);
  for (let i = 0; i < primKeys.length; i++) {
    const primitive = cache.primitives[primKeys[i]];
    destroyBestEffort(() =>
      destroyPrimitiveCacheResources(
        primitive,
        cache._cancelTextureMipGeneration,
      ),
    );
  }

  // Per-feature pick IDs and their lookup texture are model-wide owners, not
  // part of the generic per-primitive pick-ID record. Primitive teardown above
  // first drops every alias to the shared texture; now release it exactly once
  // and drain every registry ID even if an earlier one throws.
  destroyBestEffort(() => destroyPerFeaturePickResources(cache));

  // Destroy the shared edge pipeline cache.
  const edgeEmitterCache = cache.edgeEmitterCache;
  cache.edgeEmitterCache = null;
  if (defined(edgeEmitterCache)) {
    destroyBestEffort(() => destroyEdgeEmitterCache(edgeEmitterCache));
  }

  // Destroy per-node skinning + instancing resources. Clear each identity
  // before invoking foreign/native destruction so reentrancy cannot see it.
  const nodeKeys = Object.keys(cache.nodes);
  for (let i = 0; i < nodeKeys.length; i++) {
    const nc = cache.nodes[nodeKeys[i]];
    if (!defined(nc)) {
      continue;
    }
    const jointBuffer = nc.jointBuffer;
    nc.jointBuffer = undefined;
    if (defined(jointBuffer)) {
      destroyBestEffort(() => jointBuffer.destroy());
    }
    const prevJointBuffer = nc.prevJointBuffer;
    nc.prevJointBuffer = undefined;
    if (defined(prevJointBuffer)) {
      destroyBestEffort(() => prevJointBuffer.destroy());
    }
    const nodeShadowCastUB = nc.shadowCastUB;
    nc.shadowCastUB = undefined;
    if (defined(nodeShadowCastUB)) {
      destroyBestEffort(() => nodeShadowCastUB.destroy());
    }
    // There are no per-node camera buffers either; see the model-level note
    // above. Nothing per-node to release for the camera block.
    destroyBestEffort(() => destroyInstancingResources(nc));
  }

  const customShaderUB = cache._customShader?.uboBuffer;
  if (defined(cache._customShader)) {
    cache._customShader.uboBuffer = null;
  }
  if (defined(customShaderUB)) {
    destroyBestEffort(() => customShaderUB.destroy());
  }

  // Pipeline teardown returns the generation-partitioned shared-resource
  // lease. It must run even when any model-owned destroy above failed.
  destroyBestEffort(() => cache.pipelineCache.destroy());

  // Release every model-local identity map/reference even if a lost-device
  // destroy implementation threw.
  cache.primitives = {};
  cache.geometryViews = {};
  cache.nodes = {};
  cache.effectsBG = null;
  cache.edgeEmitterCache = null;
  cache._iblEntriesMemo = undefined;
  cache._customShader = null;
  cache.cameraData = null;
  cache.lightData = null;
  cache.prevModelMatrix = null;
  cache._enqueueTextureMipGeneration = undefined;
  cache._cancelTextureMipGeneration = undefined;

  if (hasDestroyError) {
    throw firstDestroyError;
  }
}

function destroyWebGPUModelResources(model: ModelLike): void {
  const cache = model._webgpuCache;
  if (defined(cache)) {
    disposeWebGPUModelCache(model, cache);
  }
}

export {
  applyCustomShaderTranslucency,
  areWebGPUModelColorPipelinesReady,
  createPackedMaterialUploadState,
  createGPUTextureFromReader,
  createMaterialTextures,
  ensurePrimitiveCache,
  getCurrentModelLightShadowMap,
  getModelCommandShadowFlags,
  getModelShadowCastLayout,
  getOrCreateModelCaptureCommands,
  getStyledTranslucentModelShadowFlags,
  hasMaterialGenerationChanged,
  getOrCreateMergedInstanceBindGroup,
  getOrCreateMergedMaterialBindGroup,
  getOrCreateModelIBLEntries,
  isModelShadowCastingActive,
  isModelShadowReceivingActive,
  packLightUniforms,
  packPunctualLights,
  preparePackedJointHistoryForFrame,
  resolvePreviousMatrixForFrame,
  resolveCustomShaderAlphaMode,
  refreshDeferredModelTextures,
  shouldPrepareModelCustomShaderResources,
  uploadPackedMaterialUniformsIfChanged,
  updateModelShadowCastUniform,
  prepareWebGPUModel,
  updateWebGPUModel,
  destroyWebGPUModelResources,
};
export default {
  prepareWebGPUModel,
  updateWebGPUModel,
  destroyWebGPUModelResources,
};
