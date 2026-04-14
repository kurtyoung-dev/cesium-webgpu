/**
 * @module WebGLStubFramebuffer
 *
 * WebGL framebuffer and renderbuffer method stubs for the WebGPU
 * compatibility layer. Maps framebuffer/renderbuffer lifecycle operations
 * to WebGPU texture creation and state tracking.
 *
 * @see WebGLCompatibilityStub (nexus)
 */

/// <reference types="@webgpu/types" />

import createGuid from "../../../Core/createGuid.js";
import type {
  WebGLStubState,
  LogUsageFn,
  StubFramebuffer,
  StubRenderbuffer,
  StubAttachment,
  StubTextureWrapper,
} from "./WebGLStubTypes.js";

// WebGL attachment constants
const GL_COLOR_ATTACHMENT0 = 0x8ce0;
const GL_DEPTH_ATTACHMENT = 0x8d00;
const GL_FRAMEBUFFER_COMPLETE = 0x8cd5;

// WebGL internal format constants for renderbuffer storage
const GL_DEPTH_COMPONENT16 = 0x81a5;
const GL_DEPTH_COMPONENT24 = 0x81a6;
const GL_DEPTH24_STENCIL8 = 0x88f0;

/**
 * Resolves a WebGL renderbuffer internal format to a GPUTextureFormat.
 */
function resolveRenderbufferFormat(internalformat: number): GPUTextureFormat {
  if (
    internalformat === GL_DEPTH_COMPONENT16 ||
    internalformat === GL_DEPTH_COMPONENT24
  ) {
    return "depth24plus";
  }
  if (internalformat === GL_DEPTH24_STENCIL8) {
    return "depth24plus-stencil8";
  }
  return "rgba8unorm";
}

/**
 * Creates framebuffer and renderbuffer stub methods.
 *
 * @param state - Shared mutable state from WebGPUContext
 * @param _logUsage - Optional debug logging function (unused currently but
 *   available for future debugging)
 * @returns Object containing all framebuffer/renderbuffer stub methods
 */
export function createFramebufferStubs(
  state: WebGLStubState,
  _logUsage: LogUsageFn,
): Record<string, unknown> {
  return {
    // ==== Framebuffer methods ====

    createFramebuffer: (): StubFramebuffer => {
      const fboId = createGuid();
      const fbo: StubFramebuffer = {
        _id: fboId,
        _colorAttachment: null,
        _depthAttachment: null,
        _isWebGPU: true,
      };
      state.framebuffers.set(fbo, {
        colorAttachment: null,
        depthAttachment: null,
      });
      return fbo;
    },

    bindFramebuffer: (_target: number, framebuffer: StubFramebuffer | null) => {
      state.boundFramebuffer = framebuffer;
    },

    deleteFramebuffer: (framebuffer: StubFramebuffer | null) => {
      if (!framebuffer) return;
      const fboData = state.framebuffers.get(framebuffer);
      if (fboData) {
        if (fboData.colorAttachment?._texture?.destroy) {
          fboData.colorAttachment._texture.destroy();
        }
        if (fboData.depthAttachment?._texture?.destroy) {
          fboData.depthAttachment._texture.destroy();
        }
        state.framebuffers.delete(framebuffer);
      }
    },

    framebufferTexture2D: (
      _target: number,
      attachment: number,
      _textarget: number,
      texture: StubTextureWrapper | null,
      _level: number,
    ) => {
      if (!state.boundFramebuffer) return;
      const fboData = state.framebuffers.get(state.boundFramebuffer);
      if (fboData) {
        if (attachment === GL_COLOR_ATTACHMENT0) {
          fboData.colorAttachment = texture;
          state.boundFramebuffer._colorAttachment = texture;
        } else if (attachment === GL_DEPTH_ATTACHMENT) {
          fboData.depthAttachment = texture;
          state.boundFramebuffer._depthAttachment = texture;
        }
      }
    },

    framebufferRenderbuffer: (
      _target: number,
      attachment: number,
      _renderbuffertarget: number,
      renderbuffer: StubRenderbuffer | null,
    ) => {
      if (!state.boundFramebuffer) return;
      const fboData = state.framebuffers.get(state.boundFramebuffer);
      if (fboData && renderbuffer) {
        if (attachment === GL_COLOR_ATTACHMENT0) {
          fboData.colorAttachment = renderbuffer;
          state.boundFramebuffer._colorAttachment = renderbuffer;
        } else if (attachment === GL_DEPTH_ATTACHMENT) {
          fboData.depthAttachment = renderbuffer;
          state.boundFramebuffer._depthAttachment = renderbuffer;
        }
      }
    },

    checkFramebufferStatus: (_target: number) => GL_FRAMEBUFFER_COMPLETE,

    // ==== Renderbuffer methods ====

    createRenderbuffer: () => {
      if (!state.device) return {};
      return {
        _id: createGuid(),
        _texture: null as GPUTexture | null,
        _format: null as GPUTextureFormat | null,
        _width: 0,
        _height: 0,
        _isWebGPU: true,
      };
    },

    bindRenderbuffer: (
      _target: number,
      renderbuffer: StubRenderbuffer | null,
    ) => {
      state.boundRenderbuffer = renderbuffer;
    },

    deleteRenderbuffer: (renderbuffer: StubRenderbuffer | null) => {
      if (renderbuffer?._texture) renderbuffer._texture.destroy();
    },

    renderbufferStorage: (
      _target: number,
      internalformat: number,
      width: number,
      height: number,
    ) => {
      if (!state.boundRenderbuffer || !state.device) return;
      if (state.boundRenderbuffer._texture) {
        state.boundRenderbuffer._texture.destroy();
      }
      const gpuFormat = resolveRenderbufferFormat(internalformat);
      state.boundRenderbuffer._texture = state.device.createTexture({
        size: { width, height },
        format: gpuFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        label: "Renderbuffer Storage",
      });
      state.boundRenderbuffer._format = gpuFormat;
      state.boundRenderbuffer._width = width;
      state.boundRenderbuffer._height = height;
    },

    renderbufferStorageMultisample: (
      _target: number,
      samples: number,
      internalformat: number,
      width: number,
      height: number,
    ) => {
      if (!state.boundRenderbuffer || !state.device) return;
      if (state.boundRenderbuffer._texture) {
        state.boundRenderbuffer._texture.destroy();
      }
      const gpuFormat = resolveRenderbufferFormat(internalformat);
      state.boundRenderbuffer._texture = state.device.createTexture({
        size: { width, height },
        format: gpuFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        sampleCount: samples,
        label: `Renderbuffer Storage (${samples}x MSAA)`,
      });
      state.boundRenderbuffer._format = gpuFormat;
      state.boundRenderbuffer._width = width;
      state.boundRenderbuffer._height = height;
    },
  };
}
