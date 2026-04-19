
// TypeScript-only WGSL preprocessor exports — for wgsl-import-test.html
export { WGSLShaderPreprocessor, WGSLShaderLibrary } from './Source/Renderer/WebGPU/WGSLShaderPreprocessor.js';
export { createDefaultWGSLLibrary, WGSLBuiltinChunks } from './Source/Renderer/WebGPU/WGSLBuiltins.js';

// WebGL compatibility stub — translator registry + pipeline extractor
export { registerShaderTranslator, getActiveShaderTranslator, subscribeToShaderTranslatorChange, registerShaderPreprocessor, getActiveShaderPreprocessor, parseNagaReflection, buildBindGroupLayoutDescriptors, buildBindGroupLayoutsFromProgram, WGSLPassthroughTranslator, NotSupportedTranslator, NagaShaderTranslator, nagaTranspileGLSL, isNagaReady, isNagaUnavailable, extractPipelineStateFromStub, extractRenderPassStateFromStub, applyStubVariantToBuilder, getCompiledShaderForProgram } from './Source/Renderer/WebGPU/WebGLCompatibilityStub.js';
