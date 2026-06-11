// WebGPU cluster renderer + lighting re-exports (Slice 5d, Batches 147–150).
// They reference Source/Renderer/WebGPU/* which the webgl-only variant strips
// to empty stubs, so they live here (webgl-only does NOT import index-wgsl.js).
// Exposed so the cluster probes + the Clustered Lighting Sandcastle can
// construct + dispatch the renderers standalone. (NEW-WEBGL-ONLY-CLUSTER-EXPORT-GATING.)
export {
  WebGPUClusterBoundsRenderer,
  CLUSTER_TILE_COUNT_X,
  CLUSTER_TILE_COUNT_Y,
  CLUSTER_SLICE_COUNT_Z,
  CLUSTER_TOTAL_COUNT,
  CLUSTER_BOUNDS_STORAGE_BYTES,
} from "./Source/Renderer/WebGPU/WebGPUClusterBoundsRenderer.js";
export {
  WebGPUClusterAssignRenderer,
  CLUSTER_MAX_LIGHTS,
  CLUSTER_MAX_LIGHTS_PER_CLUSTER,
  CLUSTER_LIGHT_STORAGE_BYTES,
  CLUSTER_LIGHT_COUNT_STORAGE_BYTES,
  CLUSTER_LIGHT_INDICES_STORAGE_BYTES,
} from "./Source/Renderer/WebGPU/WebGPUClusterAssignRenderer.js";
export { WebGPUClusterDebugRenderer } from "./Source/Renderer/WebGPU/WebGPUClusterDebugRenderer.js";
export { WebGPUClusteredLightingDispatcher } from "./Source/Renderer/WebGPU/WebGPUClusteredLightingDispatcher.js";

// TypeScript-only WGSL preprocessor exports — for wgsl-import-test.html
export {
  WGSLShaderPreprocessor,
  WGSLShaderLibrary,
} from "./Source/Renderer/WebGPU/WGSLShaderPreprocessor.js";
export {
  createDefaultWGSLLibrary,
  WGSLBuiltinChunks,
} from "./Source/Renderer/WebGPU/WGSLBuiltins.js";

// WebGL compatibility stub — translator registry + pipeline extractor
export {
  registerShaderTranslator,
  getActiveShaderTranslator,
  subscribeToShaderTranslatorChange,
  registerShaderPreprocessor,
  getActiveShaderPreprocessor,
  parseNagaReflection,
  buildBindGroupLayoutDescriptors,
  buildBindGroupLayoutsFromProgram,
  WGSLPassthroughTranslator,
  NotSupportedTranslator,
  NagaShaderTranslator,
  nagaTranspileGLSL,
  isNagaReady,
  isNagaUnavailable,
  extractPipelineStateFromStub,
  extractRenderPassStateFromStub,
  applyStubVariantToBuilder,
  getCompiledShaderForProgram,
} from "./Source/Renderer/WebGPU/WebGLCompatibilityStub.js";
