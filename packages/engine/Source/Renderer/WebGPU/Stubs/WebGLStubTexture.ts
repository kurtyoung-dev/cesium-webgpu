/**
 * @module WebGLStubTexture
 *
 * WebGL texture constants and method stubs for the WebGPU compatibility layer.
 * Handles texture creation, binding, upload, copy, and mipmap operations
 * by mapping them to WebGPU device queue operations.
 *
 * @see WebGLCompatibilityStub (nexus)
 */

/// <reference types="@webgpu/types" />

import type { WebGLStubState, LogUsageFn } from "./WebGLStubTypes.js";

/**
 * WebGL texture-related constants.
 */
export const TEXTURE_CONSTANTS = Object.freeze({
  TEXTURE_2D: 0x0de1,
  TEXTURE_CUBE_MAP: 0x8513,
  TEXTURE0: 0x84c0,
  UNPACK_ALIGNMENT: 0x0cf5,
  UNPACK_FLIP_Y_WEBGL: 0x9240,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,
  NONE: 0,
  BROWSER_DEFAULT_WEBGL: 0x9244,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  GENERATE_MIPMAP_HINT: 0x8192,
});

/**
 * Creates texture-related stub methods.
 *
 * @param state - Shared mutable state from WebGPUContext
 * @param logUsage - Optional debug logging function
 * @returns Object containing all texture stub methods
 */
export function createTextureStubs(
  state: WebGLStubState,
  logUsage: LogUsageFn,
): Record<string, any> {
  return {
    activeTexture: (unit: number) => {
      state.activeTextureUnit = unit - 0x84c0;
      logUsage(
        "activeTexture",
        `Active texture unit set to ${state.activeTextureUnit}`,
      );
    },

    bindTexture: (target: number, texture: any) => {
      state.textureBindings.set(state.activeTextureUnit, { target, texture });
      logUsage(
        "bindTexture",
        `Texture bound to unit ${state.activeTextureUnit}`,
      );
    },

    createTexture: () => {
      logUsage("createTexture", "Texture placeholder created");
      return {
        _isPlaceholder: true,
        _webgpuTexture: null as GPUTexture | null,
      };
    },

    deleteTexture: (texture: any) => {
      if (texture?._webgpuTexture?.destroy) {
        texture._webgpuTexture.destroy();
      } else if (texture?.destroy) {
        texture.destroy();
      }
      logUsage("deleteTexture", "Texture destroyed");
    },

    pixelStorei: () => logUsage("pixelStorei", "Not needed in WebGPU"),
    texParameteri: () => logUsage("texParameteri", "Use GPUSamplerDescriptor"),
    texImage2D: () =>
      logUsage("texImage2D", "Use texture.write() or queue.writeTexture()"),

    texSubImage2D: (
      _target: number,
      level: number,
      xoffset: number,
      yoffset: number,
      width: number,
      height: number,
      _format: number,
      _type: number,
      pixels: ArrayBufferView | null,
    ) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      if (!binding?.texture?._webgpuTexture || !pixels || !state.device) return;
      state.device.queue.writeTexture(
        {
          texture: binding.texture._webgpuTexture.texture,
          mipLevel: level,
          origin: { x: xoffset, y: yoffset, z: 0 },
        },
        pixels as BufferSource,
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
    },

    compressedTexImage2D: (
      _target: number,
      level: number,
      _internalformat: number,
      width: number,
      height: number,
      _border: number,
      data: ArrayBufferView,
    ) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      if (!binding?.texture?._webgpuTexture || !state.device) return;
      state.device.queue.writeTexture(
        {
          texture: binding.texture._webgpuTexture.texture,
          mipLevel: level,
        },
        data as BufferSource,
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
    },

    compressedTexSubImage2D: (
      _target: number,
      level: number,
      xoffset: number,
      yoffset: number,
      width: number,
      height: number,
      _format: number,
      data: ArrayBufferView,
    ) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      if (!binding?.texture?._webgpuTexture || !state.device) return;
      state.device.queue.writeTexture(
        {
          texture: binding.texture._webgpuTexture.texture,
          mipLevel: level,
          origin: { x: xoffset, y: yoffset, z: 0 },
        },
        data as BufferSource,
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
    },

    copyTexImage2D: (
      _target: number,
      _level: number,
      _internalformat: number,
      x: number,
      y: number,
      width: number,
      height: number,
      _border: number,
    ) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      if (!binding?.texture?._webgpuTexture || !state.currentCommandEncoder)
        return;
      const sourceTexture =
        state.boundFramebuffer?.colorAttachment?._texture ||
        state.context?.getCurrentTexture();
      if (sourceTexture) {
        state.copyTextureRegion(
          sourceTexture,
          binding.texture._webgpuTexture.texture,
          x,
          y,
          0,
          0,
          width,
          height,
        );
      }
    },

    copyTexSubImage2D: (
      _target: number,
      _level: number,
      xoffset: number,
      yoffset: number,
      x: number,
      y: number,
      width: number,
      height: number,
    ) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      if (!binding?.texture?._webgpuTexture || !state.currentCommandEncoder)
        return;
      const sourceTexture =
        state.boundFramebuffer?.colorAttachment?._texture ||
        state.context?.getCurrentTexture();
      if (sourceTexture) {
        state.copyTextureRegion(
          sourceTexture,
          binding.texture._webgpuTexture.texture,
          x,
          y,
          xoffset,
          yoffset,
          width,
          height,
        );
      }
    },

    generateMipmap: (_target: number) => {
      logUsage("generateMipmap", "WebGPU requires manual mipmap generation");
      // TODO: Implement WebGPUTexture.generateMipmaps() with compute shader
    },

    hint: () => logUsage("hint", "Not applicable in WebGPU"),
  };
}
