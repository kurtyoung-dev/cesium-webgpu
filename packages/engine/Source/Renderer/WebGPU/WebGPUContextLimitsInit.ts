/**
 * Initializes the global `ContextLimits` JS module from a WebGPU
 * `GPUDevice`'s reported limits. Extracted from `WebGPUContext.ts` as
 * the first step of the audit-recommended decomposition (4427-line
 * file → smaller, single-responsibility helpers).
 *
 * `ContextLimits.js` exposes its writable internals via
 * `Object.defineProperties` so the TS compiler doesn't see them; we
 * type-erase via the `ContextLimitsInternals` shape and assign through
 * that. Functionally identical to the inline body that previously
 * lived in `WebGPUContext._initializeContextLimits`.
 *
 * @module WebGPUContextLimitsInit
 */

import ContextLimits from "../ContextLimits.js";
import { jsModule } from "./webgpuTypeHelpers.js";

/**
 * Type-shape for the JS-only ContextLimits module's writable internal
 * fields. Cesium exposes ContextLimits as a const-like object whose
 * `_xxx` fields are written by the active context during device
 * initialization. The TS compiler can't see those fields because
 * `ContextLimits.js` declares them via `Object.defineProperties`.
 */
export interface ContextLimitsInternals {
  _maximumTextureSize: number;
  _maximumCubeMapSize: number;
  _maximumRenderbufferSize: number;
  _maximumTextureImageUnits: number;
  _maximumVertexTextureImageUnits: number;
  _maximumCombinedTextureImageUnits: number;
  _maximumVertexAttributes: number;
  _maximumViewportWidth: number;
  _maximumViewportHeight: number;
  _maximumFragmentUniformVectors: number;
  _maximumVaryingVectors: number;
  _maximumVertexUniformVectors: number;
  _minimumAliasedLineWidth: number;
  _maximumAliasedLineWidth: number;
  _minimumAliasedPointSize: number;
  _maximumAliasedPointSize: number;
  _maximumTextureFilterAnisotropy: number;
  _maximumDrawBuffers: number;
  _maximumColorAttachments: number;
  _maximumSamples: number;
  _highpFloatSupported: boolean;
  _highpIntSupported: boolean;
  _maximum3DTextureSize: number;
  _maximumArrayTextureLayers: number;
}

/**
 * Map a WebGPU device's limits onto the global ContextLimits module.
 * Idempotent: callers re-invoke after device-loss recovery to refresh
 * limits from the new adapter.
 *
 * @param device - the active GPUDevice (post-`requestDevice`). No-op
 *   if undefined / null.
 */
export function initializeContextLimitsFromDevice(
  device: GPUDevice | null | undefined,
): void {
  if (!device) {
    return;
  }

  const limits = device.limits;
  const cl = jsModule<ContextLimitsInternals>(ContextLimits);

  // Map WebGPU limits to ContextLimits internals.
  cl._maximumTextureSize = limits.maxTextureDimension2D;
  cl._maximumCubeMapSize = limits.maxTextureDimension2D;
  cl._maximumRenderbufferSize = limits.maxTextureDimension2D;
  cl._maximumTextureImageUnits = limits.maxSampledTexturesPerShaderStage;
  cl._maximumVertexTextureImageUnits = limits.maxSampledTexturesPerShaderStage;
  cl._maximumCombinedTextureImageUnits =
    limits.maxSampledTexturesPerShaderStage * 2;
  cl._maximumVertexAttributes = limits.maxVertexAttributes;
  cl._maximumViewportWidth = limits.maxTextureDimension2D;
  cl._maximumViewportHeight = limits.maxTextureDimension2D;

  // Set reasonable defaults for other limits
  cl._maximumFragmentUniformVectors = 1024;
  cl._maximumVaryingVectors = 31;
  cl._maximumVertexUniformVectors = 1024;
  cl._minimumAliasedLineWidth = 1.0;
  cl._maximumAliasedLineWidth = 1.0;
  cl._minimumAliasedPointSize = 1.0;
  cl._maximumAliasedPointSize = 1.0;
  cl._maximumTextureFilterAnisotropy = 16.0;
  cl._maximumDrawBuffers = limits.maxColorAttachments ?? 8;
  cl._maximumColorAttachments = limits.maxColorAttachments ?? 8;
  cl._maximumSamples = 4;
  // NEW-3-C (Batch 66) — Voxel Megatexture path reads
  // ContextLimits.maximum3DTextureSize via `Megatexture.get3DTextureDimension`.
  // WebGPU exposes this as `maxTextureDimension3D` (default 2048 per spec).
  // Without this write the limit stays at 0 and Megatexture allocation
  // fails the size check before it even attempts a texture allocation.
  cl._maximum3DTextureSize = limits.maxTextureDimension3D ?? 2048;
  cl._maximumArrayTextureLayers = limits.maxTextureArrayLayers ?? 256;
  cl._highpFloatSupported = true;
  cl._highpIntSupported = true;
}
