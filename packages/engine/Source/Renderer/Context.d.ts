/**
 * Type declarations for Context.js.
 *
 * Co-located `.d.ts` overrides TypeScript's inference from the JS source.
 * Context is the WebGL implementation of GraphicsContext. It ships as JS
 * for upstream sync reasons; this file gives TS callers proper types
 * without the `as unknown as GraphicsContext` escape hatch at the
 * ContextFactory boundary.
 *
 * Two kinds of overrides apply here:
 *
 * 1. **Visibility correction.** A handful of methods (`readPixels`,
 *    `readPixelsToPBO`) are tagged `@private` in JSDoc but are called
 *    cross-file by Scene-layer code (`PickFramebuffer`, `PickDepth`,
 *    `DynamicEnvironmentMapManager`). Upstream CesiumJS uses `@private`
 *    to mean "not part of the published API" — closer to TS `@internal`
 *    than `private`. Declaring them `public` here restores the runtime
 *    reality.
 *
 * 2. **Concrete types for abstract slots.** GraphicsContext declares
 *    capability getters and resource accessors as abstract; this file
 *    binds them to the concrete types Context actually produces.
 */

import GraphicsContext, {
  type GraphicsContextOptions,
  type RendererType,
} from "./GraphicsContext.js";
import type Texture from "./Texture.js";
import type CubeMap from "./CubeMap.js";

// ContextOptions accepted by the WebGL constructor. Extends the shared
// GraphicsContextOptions with the WebGL-specific escape hatches that
// exist on the JS side.
export interface ContextOptions extends GraphicsContextOptions {
  /** If true and the browser supports it, use a WebGL 1 rendering context. */
  requestWebgl1?: boolean;
  /** If true, use anisotropic filtering during texture sampling. */
  allowTextureFilterAnisotropic?: boolean;
  /** WebGL options passed on to canvas.getContext. */
  webgl?: WebGLContextAttributes;
  /** Test-only hook to inject a WebGL stub context. */
  getWebGLStub?: (
    canvas: HTMLCanvasElement,
    webglOptions: WebGLContextAttributes,
  ) => WebGLRenderingContext | WebGL2RenderingContext;
}

export interface ReadState {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  framebuffer?: object;
}

declare class Context extends GraphicsContext {
  constructor(canvas: HTMLCanvasElement, options?: ContextOptions);

  // ─── Identity / core ─────────────────────────────────────────────────
  readonly rendererType: RendererType;
  readonly id: string;
  readonly canvas: HTMLCanvasElement;
  readonly webgl2: boolean;
  getRendererString(): string;
  resize(): void;

  // ─── Caches and state ────────────────────────────────────────────────
  readonly shaderCache: CesiumShaderCache;
  readonly textureCache: object;
  readonly uniformState: CesiumUniformState;
  readonly cache: Record<string, unknown>;

  // Debug / validation flags that callers toggle at runtime.
  validateFramebuffer: boolean;
  validateShaderProgram: boolean;
  logShaderCompilation: boolean;
  throwOnWebGLError: boolean;
  readonly debugShaders: unknown;

  // ─── Capability / extension flags ────────────────────────────────────
  readonly stencilBits: number;
  readonly stencilBuffer: boolean;
  readonly antialias: boolean;
  readonly msaa: boolean;
  readonly standardDerivatives: boolean;
  readonly floatBlend: boolean;
  readonly blendMinmax: boolean;
  readonly elementIndexUint: boolean;
  readonly depthTexture: boolean;
  readonly floatingPointTexture: boolean;
  readonly halfFloatingPointTexture: boolean;
  readonly textureFloatLinear: boolean;
  readonly textureHalfFloatLinear: boolean;
  readonly supportsTextureLod: boolean;
  readonly textureFilterAnisotropic: boolean;
  readonly s3tc: boolean;
  readonly pvrtc: boolean;
  readonly astc: boolean;
  readonly etc: boolean;
  readonly etc1: boolean;
  readonly bc7: boolean;
  readonly supportsBasis: boolean;
  readonly vertexArrayObject: boolean;
  readonly fragmentDepth: boolean;
  readonly instancedArrays: boolean;
  readonly colorBufferFloat: boolean;
  readonly colorBufferHalfFloat: boolean;
  readonly drawBuffers: boolean;
  readonly supportsComputeShaders: boolean;
  readonly supportsStorageBuffers: boolean;

  // ─── Default resources ───────────────────────────────────────────────
  readonly defaultTexture: Texture;
  readonly defaultEmissiveTexture: Texture;
  readonly defaultNormalTexture: Texture;
  readonly defaultCubeMap: CubeMap;
  /** Opaque marker object for the default (canvas) framebuffer. */
  readonly defaultFramebuffer: object;

  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;

  // ─── Frame + draw path ───────────────────────────────────────────────
  clear(clearCommand?: unknown, passState?: unknown): void;
  draw(
    drawCommand: CesiumDrawCommand,
    passState?: unknown,
    shaderProgram?: unknown,
    uniformMap?: unknown,
  ): void;
  beginFrame(): void;
  endFrame(): void;

  // ─── Pixel readback ──────────────────────────────────────────────────
  // These are tagged @private in the JS source but are genuinely called
  // cross-module — they need to be visible through the GraphicsContext
  // abstract base. Declaring them public here is the visibility fix.
  readPixels(
    readState?: ReadState,
  ): Uint8Array | Uint16Array | Float32Array | Uint32Array;
  readPixelsToPBO(readState?: ReadState): object;

  // ─── Viewport quad helpers ───────────────────────────────────────────
  getViewportQuadVertexArray(): object;
  createViewportQuadCommand(
    fragmentShaderSource: string,
    overrides?: {
      renderState?: unknown;
      uniformMap?: unknown;
      owner?: unknown;
      framebuffer?: unknown;
      pass?: unknown;
    },
  ): CesiumDrawCommand;

  // ─── Lifecycle ───────────────────────────────────────────────────────
  isDestroyed(): boolean;
  destroy(): void;
}

export default Context;
