/**
 * Builds the WebGL-compatibility stub that masquerades as a
 * WebGLRenderingContext for legacy JS resources (Texture.js, CubeMap.js,
 * Framebuffer.js, etc.) that read `context._gl.FLOAT`, `gl.RGBA`, etc.
 *
 * Lives here rather than on `WebGPUContext`, which delegates to
 * `buildWebGLCompatibilityStubFor`.
 *
 * The state object is a *live* proxy: getters/setters read/write
 * through to the Context's underscore-prefixed public fields. Cesium's
 * stub modules expect to mutate the object's slots directly (e.g.
 * `state.boundVertexBuffer = handle` from bindBuffer), so the proxy
 * stays a literal with bare accessor properties — not a constructor.
 *
 * @module WebGPUContextWebGLStubInit
 */

import type Color from "../../Core/Color.js";
import {
  createWebGLCompatibilityStub,
  type WebGLStubState,
} from "./WebGLCompatibilityStub.js";
import { WebGLStubBufferRegistry } from "./Stubs/WebGLStubBuffer.js";
import { WebGLStubTextureRegistry } from "./Stubs/WebGLStubTexture.js";
import type {
  StubAttachment,
  StubBufferHandle,
  StubFramebuffer,
  StubMipmapGenerator,
  StubRenderbuffer,
  StubTextureWrapper,
} from "./Stubs/WebGLStubTypes.js";
import type { WebGPUTextureMipGenerationOptions } from "./WebGPUMipmapGenerator.js";
import {
  webglToWebGPUBlendFactor,
  webglToWebGPUBlendOp,
  webglToWebGPUCompareFunction,
} from "./WebGLStateConverters.js";

/**
 * The shape the WebGL stub builder needs to reach on `WebGPUContext`.
 * Declared as an interface (rather than importing `WebGPUContext`
 * directly) so the dependency arrow points
 * `Context → WebGLStubInit`, never the other way. Future Context
 * fields don't have to change this file unless the stub starts using
 * them.
 */
export interface WebGLStubInitHost {
  // ── Top-level GPU resources (read-only) ──
  readonly _device: GPUDevice | null;
  readonly resourceGeneration: number;
  readonly _context: GPUCanvasContext | null;
  readonly _currentCommandEncoder: GPUCommandEncoder | null;
  readonly _currentRenderPassEncoder: GPURenderPassEncoder | null;

  // ── GL-compat bound state (read/write proxy targets) ──
  _activeTextureUnit: number;
  _textureBindings: Map<
    number,
    { target: number; texture: StubTextureWrapper | null }
  >;
  _boundVertexBuffer: StubBufferHandle | null;
  _boundIndexBuffer: StubBufferHandle | null;
  _boundFramebuffer: StubFramebuffer | null;
  _boundReadFramebuffer: StubFramebuffer | null;
  _boundDrawFramebuffer: StubFramebuffer | null;
  _boundRenderbuffer: StubRenderbuffer | null;
  readonly _framebuffers: Map<
    StubFramebuffer,
    { colorAttachment: StubAttachment; depthAttachment: StubAttachment }
  >;

  // ── Pipeline-state proxy targets (read/write) ──
  _clearColor: Color;
  _clearDepth: number;
  _clearStencil: number;
  _depthTestEnabled: boolean;
  _depthWriteEnabled: boolean;
  _depthCompare: GPUCompareFunction;
  _blendEnabled: boolean;
  _cullFaceEnabled: boolean;
  _cullMode: GPUCullMode;
  _frontFace: GPUFrontFace;
  _colorWriteMask: number;
  _blendSrc: GPUBlendFactor;
  _blendDst: GPUBlendFactor;
  _blendSrcAlpha: GPUBlendFactor;
  _blendDstAlpha: GPUBlendFactor;
  _blendOp: GPUBlendOperation;
  _blendOpAlpha: GPUBlendOperation;
  _scissorTest: boolean;

  // ── Methods the stub state delegates to ──
  setViewport(x: number, y: number, width: number, height: number): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;
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
  enqueueTextureMipGeneration(
    texture: GPUTexture,
    format: GPUTextureFormat,
    mipLevelCount: number,
    options?: WebGPUTextureMipGenerationOptions,
  ): boolean;
  encodeTextureMipGenerationInCurrentEncoder(
    texture: GPUTexture,
    format: GPUTextureFormat,
    mipLevelCount: number,
    options?: WebGPUTextureMipGenerationOptions,
  ): boolean;
  cancelTextureMipGeneration(texture: GPUTexture): void;
}

/**
 * Build the live state proxy and wrap it in the existing
 * `createWebGLCompatibilityStub` factory. Returns the same shape the
 * caller used to assign to `this._gl` directly.
 *
 * The returned stub holds a long-lived reference to `host` via the
 * accessor closures — no different from the original inline literal,
 * which captured `this` via `const ctx = this;`. Lifetime is tied to
 * the host's; nothing additional to clean up.
 *
 * @param host - The owning WebGPUContext (or any object satisfying
 *   `WebGLStubInitHost`).
 * @returns The WebGL stub object suitable for assignment to
 *   `context._gl`.
 */
export function buildWebGLCompatibilityStubFor(
  host: WebGLStubInitHost,
): ReturnType<typeof createWebGLCompatibilityStub> {
  const state: WebGLStubState = {
    // ── Live read-only getters ──
    get device() {
      return host._device;
    },
    get resourceGeneration() {
      return host.resourceGeneration;
    },
    get context() {
      return host._context;
    },
    get currentCommandEncoder() {
      return host._currentCommandEncoder;
    },
    get currentRenderPassEncoder() {
      return host._currentRenderPassEncoder;
    },

    // ── Live get/set on each promoted public field ──
    get activeTextureUnit() {
      return host._activeTextureUnit;
    },
    set activeTextureUnit(v) {
      host._activeTextureUnit = v;
    },
    get textureBindings() {
      return host._textureBindings;
    },
    textureRegistry: new WebGLStubTextureRegistry(),
    get boundVertexBuffer() {
      return host._boundVertexBuffer;
    },
    set boundVertexBuffer(v) {
      host._boundVertexBuffer = v;
    },
    get boundIndexBuffer() {
      return host._boundIndexBuffer;
    },
    set boundIndexBuffer(v) {
      host._boundIndexBuffer = v;
    },
    bufferRegistry: new WebGLStubBufferRegistry(),
    // Legacy Buffer/VertexArray objects are still built so shared Cesium scene
    // code can inspect their metadata. Native feature renderers consume the
    // retained CPU arrays and own the only GPUBuffer upload; no production
    // path unwraps the compatibility handle's optional native slot.
    allocateCompatibilityBuffers: false,
    get boundFramebuffer() {
      return host._boundFramebuffer;
    },
    set boundFramebuffer(v) {
      host._boundFramebuffer = v;
    },
    get boundReadFramebuffer() {
      return host._boundReadFramebuffer;
    },
    set boundReadFramebuffer(v) {
      host._boundReadFramebuffer = v;
    },
    get boundDrawFramebuffer() {
      return host._boundDrawFramebuffer;
    },
    set boundDrawFramebuffer(v) {
      host._boundDrawFramebuffer = v;
    },
    get boundRenderbuffer() {
      return host._boundRenderbuffer;
    },
    set boundRenderbuffer(v) {
      host._boundRenderbuffer = v;
    },
    get framebuffers() {
      return host._framebuffers;
    },

    get clearColor() {
      return host._clearColor;
    },
    set clearColor(v) {
      host._clearColor = v;
    },
    get clearDepth() {
      return host._clearDepth;
    },
    set clearDepth(v) {
      host._clearDepth = v;
    },
    get clearStencil() {
      return host._clearStencil;
    },
    set clearStencil(v) {
      host._clearStencil = v;
    },

    get depthTestEnabled() {
      return host._depthTestEnabled;
    },
    set depthTestEnabled(v) {
      host._depthTestEnabled = v;
    },
    get depthWriteEnabled() {
      return host._depthWriteEnabled;
    },
    set depthWriteEnabled(v) {
      host._depthWriteEnabled = v;
    },
    get depthCompare() {
      return host._depthCompare;
    },
    set depthCompare(v) {
      host._depthCompare = v;
    },

    get blendEnabled() {
      return host._blendEnabled;
    },
    set blendEnabled(v) {
      host._blendEnabled = v;
    },
    get cullFaceEnabled() {
      return host._cullFaceEnabled;
    },
    set cullFaceEnabled(v) {
      host._cullFaceEnabled = v;
    },
    get cullMode() {
      return host._cullMode;
    },
    set cullMode(v) {
      host._cullMode = v;
    },
    get frontFace() {
      return host._frontFace;
    },
    set frontFace(v) {
      host._frontFace = v;
    },
    get colorWriteMask() {
      return host._colorWriteMask;
    },
    set colorWriteMask(v) {
      host._colorWriteMask = v;
    },

    get blendSrc() {
      return host._blendSrc;
    },
    set blendSrc(v) {
      host._blendSrc = v;
    },
    get blendDst() {
      return host._blendDst;
    },
    set blendDst(v) {
      host._blendDst = v;
    },
    get blendSrcAlpha() {
      return host._blendSrcAlpha;
    },
    set blendSrcAlpha(v) {
      host._blendSrcAlpha = v;
    },
    get blendDstAlpha() {
      return host._blendDstAlpha;
    },
    set blendDstAlpha(v) {
      host._blendDstAlpha = v;
    },
    get blendOp() {
      return host._blendOp;
    },
    set blendOp(v) {
      host._blendOp = v;
    },
    get blendOpAlpha() {
      return host._blendOpAlpha;
    },
    set blendOpAlpha(v) {
      host._blendOpAlpha = v;
    },

    get scissorTest() {
      return host._scissorTest;
    },
    set scissorTest(v) {
      host._scissorTest = v;
    },

    // ── Stub-local state (not mirrored on the host) ──
    // Pixel-store flags consumed by the texture stub when uploading
    // CPU pixel data via texImage2D / texSubImage2D.
    pixelStore: {
      unpackFlipY: false,
      unpackPremultiplyAlpha: false,
      unpackAlignment: 4,
    },
    // Stencil state mirrors WebGL defaults; tracked for future
    // pipeline creation that needs stencil ops.
    stencilTestEnabled: false,
    stencilFrontCompare: "always" as GPUCompareFunction,
    stencilBackCompare: "always" as GPUCompareFunction,
    stencilReadMask: 0xff,
    stencilWriteMask: 0xff,
    stencilReference: 0,
    stencilFailOp: "keep" as GPUStencilOperation,
    stencilDepthFailOp: "keep" as GPUStencilOperation,
    stencilPassOp: "keep" as GPUStencilOperation,
    // Lazy mipmap generator — created the first time generateMipmap is
    // called. Stored on `state` so the texture stub can dispatch a real
    // blit-down compute pass instead of falling back to a no-op.
    mipmapGenerator: null as StubMipmapGenerator | null,

    // ── Methods that delegate to host methods ──
    setViewport: (x: number, y: number, w: number, h: number) =>
      host.setViewport(x, y, w, h),
    setScissorRect: (x: number, y: number, w: number, h: number) =>
      host.setScissorRect(x, y, w, h),
    disableScissorTest: () => host.disableScissorTest(),
    copyTextureRegion: (
      src: GPUTexture,
      dst: GPUTexture,
      sx: number,
      sy: number,
      dx: number,
      dy: number,
      w: number,
      h: number,
    ) => host.copyTextureRegion(src, dst, sx, sy, dx, dy, w, h),
    enqueueMipGeneration: (texture, format, mipLevelCount, options) =>
      host.enqueueTextureMipGeneration(texture, format, mipLevelCount, options),
    encodeMipGenerationInCurrentEncoder: (
      texture,
      format,
      mipLevelCount,
      options,
    ) =>
      host.encodeTextureMipGenerationInCurrentEncoder(
        texture,
        format,
        mipLevelCount,
        options,
      ),
    cancelMipGeneration: (texture) => host.cancelTextureMipGeneration(texture),
    // The previous wrappers `_webglToWebGPUBlendFactor` etc. on the
    // Context only existed to feed this state literal — point straight
    // at the module-level functions instead.
    webglToWebGPUBlendFactor,
    webglToWebGPUBlendOp,
    webglToWebGPUCompareFunction,
  };

  return createWebGLCompatibilityStub(state);
}
