/**
 * @module WebGLStubTypes
 *
 * Shared type definitions for the WebGL compatibility stub modules.
 * The `WebGLStubState` interface defines the mutable state that WebGPUContext
 * provides — all stub domain modules read/write through this interface to
 * avoid circular dependencies with WebGPUContext itself.
 *
 * @see WebGLCompatibilityStub (nexus)
 * @see WebGPUContext
 */

/// <reference types="@webgpu/types" />

import type Color from "../../../Core/Color.js";

/**
 * A stub-managed texture wrapper produced by `gl.createTexture()`. Holds
 * pending sampler state and (once allocated) the real GPU resources.
 */
export interface StubTextureWrapper {
  _isPlaceholder: boolean;
  _samplerDesc?: {
    magFilter: GPUFilterMode;
    minFilter: GPUFilterMode;
    mipmapFilter: GPUMipmapFilterMode;
    addressModeU: GPUAddressMode;
    addressModeV: GPUAddressMode;
    addressModeW: GPUAddressMode;
    wantsMipmaps: boolean;
  };
  _webgpuTexture: {
    texture: GPUTexture;
    view: GPUTextureView;
    sampler: GPUSampler;
    width: number;
    height: number;
    format: GPUTextureFormat;
    mipLevelCount: number;
    destroy(): void;
  } | null;
  /** The underlying GPUTexture, if allocated. Mirrors StubRenderbuffer._texture for uniform access via StubAttachment. */
  _texture?: GPUTexture | null;
}

/** A stub-managed framebuffer object. */
export interface StubFramebuffer {
  _id: string;
  _colorAttachment: StubAttachment | null;
  _depthAttachment: StubAttachment | null;
  _isWebGPU: boolean;
  /** Alias for _colorAttachment, used by some code paths. */
  colorAttachment?: StubAttachment | null;
}

/** A stub-managed renderbuffer object. */
export interface StubRenderbuffer {
  _id: string;
  _texture: GPUTexture | null;
  _format: GPUTextureFormat | null;
  _width: number;
  _height: number;
  _isWebGPU: boolean;
}

/** An attachment reference (texture or renderbuffer). */
export type StubAttachment = StubTextureWrapper | StubRenderbuffer | null;

/** Mipmap generator interface — avoids importing the real class here. */
export interface StubMipmapGenerator {
  generateMipmaps(
    texture: GPUTexture,
    format: GPUTextureFormat,
    mipLevelCount: number,
    commandEncoder?: GPUCommandEncoder,
  ): GPUCommandEncoder;
}

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
  textureBindings: Map<
    number,
    { target: number; texture: StubTextureWrapper | null }
  >;
  boundVertexBuffer: GPUBuffer | null;
  boundIndexBuffer: GPUBuffer | null;
  boundFramebuffer: StubFramebuffer | null;
  boundRenderbuffer: StubRenderbuffer | null;
  framebuffers: Map<
    StubFramebuffer,
    { colorAttachment: StubAttachment; depthAttachment: StubAttachment }
  >;

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

  // Pixel-store state set via gl.pixelStorei() — read by texImage2D
  // when uploading data so it can correctly flip rows / premultiply.
  pixelStore: {
    unpackFlipY: boolean;
    unpackPremultiplyAlpha: boolean;
    unpackAlignment: number;
  };

  // Stencil state (tracked for pipeline creation)
  stencilTestEnabled: boolean;
  stencilFrontCompare: GPUCompareFunction;
  stencilBackCompare: GPUCompareFunction;
  stencilReadMask: number;
  stencilWriteMask: number;
  stencilReference: number;
  stencilFailOp: GPUStencilOperation;
  stencilDepthFailOp: GPUStencilOperation;
  stencilPassOp: GPUStencilOperation;

  // Lazy mipmap generator — set on first generateMipmap call.
  mipmapGenerator: StubMipmapGenerator | null;

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

/**
 * Logging function signature used by stub modules for optional debug output.
 */
export type LogUsageFn = (method: string, reason: string) => void;
