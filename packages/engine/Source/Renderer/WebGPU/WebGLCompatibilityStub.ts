// @ts-nocheck
/**
 * @module WebGLCompatibilityStub
 *
 * WebGL compatibility shim for the WebGPU rendering context.
 * Provides WebGL constants and stub methods that legacy CesiumJS code expects
 * (e.g., Texture.js, Framebuffer.js) so they can function without crashing
 * when the WebGPU renderer is active.
 *
 * This module is extracted from WebGPUContext to keep the main context file
 * focused on pure WebGPU functionality. The stub is intended as a transitional
 * layer — once all CesiumJS rendering code is fully migrated to the
 * WebGPU abstraction, this stub can be removed.
 *
 * @see WebGPUContext
 */

/// <reference types="@webgpu/types" />

import createGuid from "../../Core/createGuid.js";
import Color from "../../Core/Color.js";

// ============================================================================
// Types
// ============================================================================

/**
 * State holder that WebGPUContext provides for the stub to read/write.
 * This avoids circular dependencies — the stub doesn't import WebGPUContext.
 */
export interface WebGLStubState {
  // Device & context references
  device: GPUDevice | null;
  context: GPUCanvasContext | null;
  currentCommandEncoder: GPUCommandEncoder | null;
  currentRenderPassEncoder: GPURenderPassEncoder | null;

  // GL compatibility state
  activeTextureUnit: number;
  textureBindings: Map<number, { target: number; texture: any }>;
  boundVertexBuffer: GPUBuffer | null;
  boundIndexBuffer: GPUBuffer | null;
  boundFramebuffer: any;
  boundRenderbuffer: any;
  framebuffers: Map<any, { colorAttachment: any; depthAttachment: any }>;

  // Pipeline state
  clearColor: Color;
  clearDepth: number;
  clearStencil: number;
  depthTestEnabled: boolean;
  depthWriteEnabled: boolean;
  depthCompare: GPUCompareFunction;
  blendEnabled: boolean;
  cullFaceEnabled: boolean;
  cullMode: GPUCullMode;
  frontFace: GPUFrontFace;
  colorWriteMask: number;
  blendSrc: GPUBlendFactor;
  blendDst: GPUBlendFactor;
  blendSrcAlpha: GPUBlendFactor;
  blendDstAlpha: GPUBlendFactor;
  blendOp: GPUBlendOperation;
  blendOpAlpha: GPUBlendOperation;
  scissorTest: boolean;

  // Methods provided by WebGPUContext
  setViewport(x: number, y: number, w: number, h: number): void;
  setScissorRect(x: number, y: number, w: number, h: number): void;
  disableScissorTest(): void;
  copyTextureRegion(
    src: GPUTexture,
    dst: GPUTexture,
    sx: number,
    sy: number,
    dx: number,
    dy: number,
    w: number,
    h: number,
  ): void;
  webglToWebGPUBlendFactor(f: number): GPUBlendFactor;
  webglToWebGPUBlendOp(o: number): GPUBlendOperation;
  webglToWebGPUCompareFunction(f: number): GPUCompareFunction;
}

// ============================================================================
// Stub Creation
// ============================================================================

/**
 * Creates the WebGL compatibility stub object.
 *
 * The returned object has the same shape as a WebGLRenderingContext,
 * providing constants and stub method implementations that map to WebGPU
 * state tracking or no-ops.
 *
 * @param state - Shared mutable state from WebGPUContext
 * @returns A WebGL-shaped stub object
 */
export function createWebGLCompatibilityStub(state: WebGLStubState): any {
  const logUsage = (_method: string, _reason: string) => {
    // Disabled for less noise — uncomment for debugging WebGL compatibility layer
    // console.log(`[WebGPU Compatibility] gl.${_method}() called - ${_reason}`);
  };

  return {
    // ========================================================================
    // Texture constants & methods
    // ========================================================================
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
      return { _isPlaceholder: true, _webgpuTexture: null };
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
        { texture: binding.texture._webgpuTexture.texture, mipLevel: level },
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

    // ========================================================================
    // Framebuffer methods
    // ========================================================================
    createFramebuffer: () => {
      const fboId = createGuid();
      const fbo = {
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

    bindFramebuffer: (target: number, framebuffer: any) => {
      state.boundFramebuffer = framebuffer;
    },

    deleteFramebuffer: (framebuffer: any) => {
      if (!framebuffer) return;
      const fboData = state.framebuffers.get(framebuffer);
      if (fboData) {
        if (fboData.colorAttachment?._texture?.destroy)
          fboData.colorAttachment._texture.destroy();
        if (fboData.depthAttachment?._texture?.destroy)
          fboData.depthAttachment._texture.destroy();
        state.framebuffers.delete(framebuffer);
      }
    },

    framebufferTexture2D: (
      _target: number,
      attachment: number,
      _textarget: number,
      texture: any,
      _level: number,
    ) => {
      if (!state.boundFramebuffer) return;
      const fboData = state.framebuffers.get(state.boundFramebuffer);
      if (fboData) {
        if (attachment === 0x8ce0) {
          // GL_COLOR_ATTACHMENT0
          fboData.colorAttachment = texture;
          state.boundFramebuffer._colorAttachment = texture;
        } else if (attachment === 0x8d00) {
          // GL_DEPTH_ATTACHMENT
          fboData.depthAttachment = texture;
          state.boundFramebuffer._depthAttachment = texture;
        }
      }
    },

    framebufferRenderbuffer: (
      _target: number,
      attachment: number,
      _renderbuffertarget: number,
      renderbuffer: any,
    ) => {
      if (!state.boundFramebuffer) return;
      const fboData = state.framebuffers.get(state.boundFramebuffer);
      if (fboData && renderbuffer) {
        if (attachment === 0x8ce0) {
          fboData.colorAttachment = renderbuffer;
          state.boundFramebuffer._colorAttachment = renderbuffer;
        } else if (attachment === 0x8d00) {
          fboData.depthAttachment = renderbuffer;
          state.boundFramebuffer._depthAttachment = renderbuffer;
        }
      }
    },

    checkFramebufferStatus: (_target: number) => 0x8cd5, // GL_FRAMEBUFFER_COMPLETE

    // ========================================================================
    // Renderbuffer methods
    // ========================================================================
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

    bindRenderbuffer: (_target: number, renderbuffer: any) => {
      state.boundRenderbuffer = renderbuffer;
    },

    deleteRenderbuffer: (renderbuffer: any) => {
      if (renderbuffer?._texture) renderbuffer._texture.destroy();
    },

    renderbufferStorage: (
      _target: number,
      internalformat: number,
      width: number,
      height: number,
    ) => {
      if (!state.boundRenderbuffer || !state.device) return;
      if (state.boundRenderbuffer._texture)
        state.boundRenderbuffer._texture.destroy();
      let gpuFormat: GPUTextureFormat = "rgba8unorm";
      if (internalformat === 0x81a5 || internalformat === 0x81a6)
        gpuFormat = "depth24plus";
      else if (internalformat === 0x88f0) gpuFormat = "depth24plus-stencil8";
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
      if (state.boundRenderbuffer._texture)
        state.boundRenderbuffer._texture.destroy();
      let gpuFormat: GPUTextureFormat = "rgba8unorm";
      if (internalformat === 0x81a5 || internalformat === 0x81a6)
        gpuFormat = "depth24plus";
      else if (internalformat === 0x88f0) gpuFormat = "depth24plus-stencil8";
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

    // ========================================================================
    // Buffer methods
    // ========================================================================
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    STREAM_DRAW: 0x88e0,

    createBuffer: () => {
      if (!state.device) return {};
      const defaultSize = 4096;
      const buffer = state.device.createBuffer({
        size: defaultSize,
        usage:
          GPUBufferUsage.VERTEX |
          GPUBufferUsage.INDEX |
          GPUBufferUsage.COPY_DST,
        label: "GL Compatibility Buffer",
      });
      return {
        _webgpuBuffer: buffer,
        _size: defaultSize,
        destroy: () => buffer.destroy(),
      };
    },

    bindBuffer: (target: number, buffer: any) => {
      if (target === 0x8892)
        state.boundVertexBuffer = buffer?._webgpuBuffer || null;
      else if (target === 0x8893)
        state.boundIndexBuffer = buffer?._webgpuBuffer || null;
    },

    deleteBuffer: (buffer: any) => {
      if (buffer?._webgpuBuffer) buffer._webgpuBuffer.destroy();
      else if (buffer?.destroy) buffer.destroy();
    },

    bufferData: (
      target: number,
      data: ArrayBuffer | ArrayBufferView | number,
      _usage: number,
    ) => {
      const boundBuffer =
        target === 0x8892 ? state.boundVertexBuffer : state.boundIndexBuffer;
      if (!boundBuffer) return;
      if (typeof data === "number") return;
      const arrayBuffer =
        data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer;
      const byteOffset =
        data instanceof ArrayBuffer ? 0 : (data as ArrayBufferView).byteOffset;
      const byteLength =
        data instanceof ArrayBuffer
          ? data.byteLength
          : (data as ArrayBufferView).byteLength;
      if (!state.device) return;
      const alignedLength = Math.ceil(byteLength / 4) * 4;
      if (alignedLength !== byteLength) {
        const paddedArray = new Uint8Array(alignedLength);
        paddedArray.set(new Uint8Array(arrayBuffer, byteOffset, byteLength));
        state.device.queue.writeBuffer(
          boundBuffer,
          0,
          paddedArray.buffer,
          0,
          alignedLength,
        );
      } else {
        if (byteLength > boundBuffer.size) {
          console.warn(
            `[WebGPU] Buffer too small (${boundBuffer.size}), need ${byteLength}. Recreate buffer with larger size.`,
          );
        }
        state.device.queue.writeBuffer(
          boundBuffer,
          0,
          arrayBuffer,
          byteOffset,
          byteLength,
        );
      }
    },

    bufferSubData: (
      target: number,
      offset: number,
      data: ArrayBuffer | ArrayBufferView,
    ) => {
      const boundBuffer =
        target === 0x8892 ? state.boundVertexBuffer : state.boundIndexBuffer;
      if (!boundBuffer || !state.device) return;
      const arrayBuffer =
        data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer;
      const byteOffset =
        data instanceof ArrayBuffer ? 0 : (data as ArrayBufferView).byteOffset;
      const byteLength =
        data instanceof ArrayBuffer
          ? data.byteLength
          : (data as ArrayBufferView).byteLength;
      state.device.queue.writeBuffer(
        boundBuffer,
        offset,
        arrayBuffer,
        byteOffset,
        byteLength,
      );
    },

    // ========================================================================
    // Vertex attribute methods (no-ops — handled by pipeline vertex state)
    // ========================================================================
    enableVertexAttribArray: () => {},
    disableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},

    // ========================================================================
    // Clear methods (state tracked for render pass loadOp)
    // ========================================================================
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    STENCIL_BUFFER_BIT: 0x0400,

    clear: () =>
      logUsage("clear", 'Use loadOp: "clear" in GPURenderPassDescriptor'),
    clearColor: (r?: number, g?: number, b?: number, a?: number) => {
      if (r !== undefined) state.clearColor = new Color(r, g, b, a);
    },
    clearDepth: (depth?: number) => {
      if (depth !== undefined) state.clearDepth = depth;
    },
    clearStencil: (s?: number) => {
      if (s !== undefined) state.clearStencil = s;
    },

    // ========================================================================
    // Viewport and scissor
    // ========================================================================
    viewport: (x: number, y: number, width: number, height: number) => {
      state.setViewport(x, y, width, height);
    },
    scissor: (x: number, y: number, width: number, height: number) => {
      state.setScissorRect(x, y, width, height);
    },

    // ========================================================================
    // Enable / disable (state tracked for pipeline creation)
    // ========================================================================
    DEPTH_TEST: 0x0b71,
    BLEND: 0x0be2,
    CULL_FACE: 0x0b44,
    SCISSOR_TEST: 0x0c11,
    STENCIL_TEST: 0x0b90,
    SAMPLE_ALPHA_TO_COVERAGE: 0x809e,

    enable: (cap: number) => {
      switch (cap) {
        case 0x0b71:
          state.depthTestEnabled = true;
          break;
        case 0x0be2:
          state.blendEnabled = true;
          break;
        case 0x0b44:
          state.cullFaceEnabled = true;
          break;
        case 0x0c11:
          state.scissorTest = true;
          break;
      }
    },
    disable: (cap: number) => {
      switch (cap) {
        case 0x0b71:
          state.depthTestEnabled = false;
          break;
        case 0x0be2:
          state.blendEnabled = false;
          break;
        case 0x0b44:
          state.cullFaceEnabled = false;
          break;
        case 0x0c11:
          state.scissorTest = false;
          state.disableScissorTest();
          break;
      }
    },

    // ========================================================================
    // Blend functions (state tracked for pipeline creation)
    // ========================================================================
    blendFunc: (sfactor: number, dfactor: number) => {
      state.blendSrc = state.webglToWebGPUBlendFactor(sfactor);
      state.blendDst = state.webglToWebGPUBlendFactor(dfactor);
      state.blendSrcAlpha = state.blendSrc;
      state.blendDstAlpha = state.blendDst;
    },
    blendFuncSeparate: (
      srcRGB: number,
      dstRGB: number,
      srcAlpha: number,
      dstAlpha: number,
    ) => {
      state.blendSrc = state.webglToWebGPUBlendFactor(srcRGB);
      state.blendDst = state.webglToWebGPUBlendFactor(dstRGB);
      state.blendSrcAlpha = state.webglToWebGPUBlendFactor(srcAlpha);
      state.blendDstAlpha = state.webglToWebGPUBlendFactor(dstAlpha);
    },
    blendEquation: (mode: number) => {
      state.blendOp = state.webglToWebGPUBlendOp(mode);
      state.blendOpAlpha = state.blendOp;
    },
    blendEquationSeparate: (modeRGB: number, modeAlpha: number) => {
      state.blendOp = state.webglToWebGPUBlendOp(modeRGB);
      state.blendOpAlpha = state.webglToWebGPUBlendOp(modeAlpha);
    },
    blendColor: (r: number, g: number, b: number, a: number) => {
      if (state.currentRenderPassEncoder) {
        state.currentRenderPassEncoder.setBlendConstant([r, g, b, a]);
      }
    },

    // ========================================================================
    // Depth functions (state tracked for pipeline creation)
    // ========================================================================
    depthFunc: (func: number) => {
      state.depthCompare = state.webglToWebGPUCompareFunction(func);
    },
    depthMask: (flag: boolean) => {
      state.depthWriteEnabled = flag;
    },
    depthRange: () => {
      // WebGPU always uses 0–1 depth range
    },

    // ========================================================================
    // Stencil functions (tracked — full implementation pending)
    // ========================================================================
    stencilFunc: () => {},
    stencilMask: () => {},
    stencilOp: () => {},

    // ========================================================================
    // Culling (state tracked for pipeline creation)
    // ========================================================================
    cullFace: (mode: number) => {
      if (mode === 0x0404) state.cullMode = "front";
      else if (mode === 0x0405) state.cullMode = "back";
      else state.cullMode = "none";
    },
    frontFace: (mode: number) => {
      state.frontFace = mode === 0x0900 ? "cw" : "ccw";
    },

    // ========================================================================
    // Color mask
    // ========================================================================
    colorMask: (r: boolean, g: boolean, b: boolean, a: boolean) => {
      state.colorWriteMask =
        (r ? 0x1 : 0) | (g ? 0x2 : 0) | (b ? 0x4 : 0) | (a ? 0x8 : 0);
    },

    // ========================================================================
    // Parameter queries
    // ========================================================================
    getParameter: (_param: number) => 0,
    getExtension: (_name: string) => null,

    // ========================================================================
    // Shader methods (placeholders — WebGPU uses shader modules)
    // ========================================================================
    createShader: (type: number) => ({ _type: type, _isWebGPU: true }),
    deleteShader: () => {},
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    createProgram: () => ({ _isWebGPU: true }),
    deleteProgram: () => {},
    attachShader: () => {},
    bindAttribLocation: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    useProgram: () => {},
    getActiveUniform: (_program: any, index: number) => ({
      name: `uniform_${index}`,
      size: 1,
      type: 0x1406,
    }),
    getActiveAttrib: (_program: any, index: number) => ({
      name: `attrib_${index}`,
      size: 1,
      type: 0x1406,
    }),
    getUniformLocation: (_program: any, name: string) => ({
      _name: name,
      _isWebGPU: true,
    }),
    getAttribLocation: (_program: any, name: string) => {
      const locationMap: Record<string, number> = {
        position: 0,
        normal: 1,
        texCoord: 2,
        color: 3,
        tangent: 4,
        bitangent: 5,
      };
      return locationMap[name] ?? -1;
    },

    // ========================================================================
    // Framebuffer blitting & read pixels
    // ========================================================================
    blitFramebuffer: () => {},
    readPixels: () => null,
  };
}

export default createWebGLCompatibilityStub;
