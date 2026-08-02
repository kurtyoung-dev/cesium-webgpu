/**
 * Shared type definitions for the WebGL compatibility stub modules.
 * The `WebGLStubState` interface defines the mutable state that WebGPUContext
 * provides — all stub domain modules read/write through this interface to
 * avoid circular dependencies with WebGPUContext itself.
 *
 * @see WebGLCompatibilityStub (nexus)
 * @see WebGPUContext
 * @module WebGLStubTypes
 */

/// <reference types="@webgpu/types" />

import type Color from "../../../Core/Color.js";
import type { WebGPUTextureMipGenerationOptions } from "../WebGPUMipmapGenerator.js";

/**
 * A stub-managed texture wrapper produced by `gl.createTexture()`. Holds
 * pending sampler state and (once allocated) the real GPU resources.
 */
export interface StubGPUTexture {
  texture: GPUTexture;
  view: GPUTextureView;
  sampler: GPUSampler;
  width: number;
  height: number;
  format: GPUTextureFormat;
  mipLevelCount: number;
  depthOrArrayLayers?: number;
  destroy(): void;
}

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
  readonly _webgpuTexture: StubGPUTexture | null;
  /**
   * Resolve the wrapper's logical upload for one exact native ownership
   * tuple. Compatibility consumers should prefer this over reading
   * `_webgpuTexture` when they already know their target device/generation.
   */
  _getWebGPUTextureForDevice?(
    device: GPUDevice,
    resourceGeneration: number,
  ): StubGPUTexture | null;
  /** The underlying GPUTexture, if allocated. Mirrors StubRenderbuffer._texture for uniform access via StubAttachment. */
  _texture?: GPUTexture | null;
}

export interface StubTextureDiagnostics {
  readonly registeredHandleCount: number;
  readonly liveTextureCount: number;
}

/** Context-local ownership registry for compatibility texture handles. */
export interface StubTextureRegistry {
  register(handle: StubTextureWrapper): void;
  unregister(handle: StubTextureWrapper): void;
  invalidateDeviceGeneration(): void;
  destroy(): void;
  getDiagnostics(): StubTextureDiagnostics;
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

// Stable compatibility handle that owns at most one live GPUBuffer.
export interface StubBufferHandle {
  _webgpuBuffer: GPUBuffer | null;
  _size: number;
  _device: GPUDevice | null;
  _destroyed: boolean;
  destroy(): void;
}

/** Snapshot of the native allocations owned by one compatibility stub. */
export interface StubBufferDiagnostics {
  readonly registeredHandleCount: number;
  readonly logicalStoreCount: number;
  readonly logicalStoreBytes: number;
  readonly liveBufferCount: number;
  readonly liveBufferBytes: number;
}

/**
 * Context-local ownership registry for WebGL-shaped buffer handles.
 *
 * A pooled GPUDevice may outlive an individual WebGPUContext, so native
 * compatibility allocations cannot rely on device destruction for cleanup.
 * Device-generation invalidation releases only native allocations (the
 * stable WebGL handles remain reusable); final teardown destroys the handles
 * and empties the registry.
 */
export interface StubBufferRegistry {
  register(handle: StubBufferHandle): void;
  unregister(handle: StubBufferHandle): void;
  invalidateDeviceGeneration(): void;
  destroy(): void;
  getDiagnostics(): StubBufferDiagnostics;
}

/** Mipmap generator interface — avoids importing the real class here. */
export interface StubMipmapGenerator {
  generateMipmaps(
    texture: GPUTexture,
    format: GPUTextureFormat,
    mipLevelCount: number,
    commandEncoder?: GPUCommandEncoder,
    options?: WebGPUTextureMipGenerationOptions,
  ): GPUCommandEncoder;
  destroy?(): void;
}

/**
 * State holder that WebGPUContext provides for the stub to read/write.
 * This avoids circular dependencies — the stub doesn't import WebGPUContext.
 */
export interface WebGLStubState {
  // Device & context references
  device: GPUDevice | null;
  resourceGeneration: number;
  context: GPUCanvasContext | null;
  currentCommandEncoder: GPUCommandEncoder | null;
  currentRenderPassEncoder: GPURenderPassEncoder | null;

  // GL compatibility state
  activeTextureUnit: number;
  textureBindings: Map<
    number,
    { target: number; texture: StubTextureWrapper | null }
  >;
  textureRegistry: StubTextureRegistry;
  boundVertexBuffer: StubBufferHandle | null;
  boundIndexBuffer: StubBufferHandle | null;
  bufferRegistry: StubBufferRegistry;
  /**
   * Whether WebGL-shaped buffer stores should be realized as native
   * `GPUBuffer`s. The production WebGPU renderer keeps this false: feature
   * renderers upload their retained CPU payloads into purpose-built buffers,
   * and no production path consumes `StubBufferHandle._webgpuBuffer`.
   */
  readonly allocateCompatibilityBuffers: boolean;
  boundFramebuffer: StubFramebuffer | null;
  /**
   * WebGL2 split read/draw framebuffer targets. `bindFramebuffer` with
   * `GL_FRAMEBUFFER` (0x8D40) sets both; `GL_READ_FRAMEBUFFER` (0x8CA8)
   * sets only the read target; `GL_DRAW_FRAMEBUFFER` (0x8CA9) sets
   * only the draw target. `blitFramebuffer` reads from
   * `boundReadFramebuffer` and writes to `boundDrawFramebuffer`.
   * Rarely diverge — default both to `boundFramebuffer` on legacy
   * `bindFramebuffer(GL_FRAMEBUFFER)` calls.
   */
  boundReadFramebuffer: StubFramebuffer | null;
  boundDrawFramebuffer: StubFramebuffer | null;
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
  ): boolean;
  enqueueMipGeneration(
    texture: GPUTexture,
    format: GPUTextureFormat,
    mipLevelCount: number,
    options?: WebGPUTextureMipGenerationOptions,
  ): boolean;
  /**
   * Ordered compatibility-only path for a base-level texture copy already
   * recorded in currentCommandEncoder. Returns false rather than submitting or
   * moving the work to the earlier frame-preparation encoder.
   */
  encodeMipGenerationInCurrentEncoder(
    texture: GPUTexture,
    format: GPUTextureFormat,
    mipLevelCount: number,
    options?: WebGPUTextureMipGenerationOptions,
  ): boolean;
  cancelMipGeneration(texture: GPUTexture): void;
  webglToWebGPUBlendFactor(f: number): GPUBlendFactor;
  webglToWebGPUBlendOp(o: number): GPUBlendOperation;
  webglToWebGPUCompareFunction(f: number): GPUCompareFunction;
}

/**
 * Logging function signature used by stub modules for optional debug output.
 */
export type LogUsageFn = (method: string, reason: string) => void;
