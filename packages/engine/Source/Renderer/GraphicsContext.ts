/**
 * @module GraphicsContext
 *
 * Abstract interface defining the common operations that both WebGL and WebGPU
 * rendering contexts must implement. This allows the rest of CesiumJS to work
 * with either renderer through a unified API.
 *
 * ## Strengthened Interface (March 11, 2026)
 *
 * This interface now includes ALL shared properties and capabilities that scene
 * code should query through the context, rather than importing backend-specific
 * modules. This reduces:
 * - WebGPU imports in scene files (from 28 to fewer)
 * - WebGLCompatibilityStub surface area
 * - Merge conflicts with upstream CesiumJS
 *
 * @interface
 */

import RendererType from "./RendererType.js";

/**
 * Abstract base interface for graphics contexts.
 * Both Context.js (WebGL) and WebGPUContext.ts implement this interface.
 *
 * @interface GraphicsContext
 */
export interface GraphicsContext {
  // ═══════════════════════════════════════════════════════════
  // IDENTITY & TYPE
  // ═══════════════════════════════════════════════════════════

  /**
   * The renderer type for this context (RendererType.WEBGL or RendererType.WEBGPU)
   * @readonly
   */
  readonly rendererType: RendererType;

  /**
   * Whether this is a WebGPU context. Convenience property to avoid
   * `context.rendererType === RendererType.WEBGPU` checks in scene code.
   *
   * Scene files should use this instead of importing RendererType.
   * @readonly
   */
  readonly isWebGPU: boolean;

  /**
   * Unique context identifier
   * @readonly
   */
  readonly id: string;

  // ═══════════════════════════════════════════════════════════
  // CANVAS & DIMENSIONS
  // ═══════════════════════════════════════════════════════════

  /**
   * The canvas element associated with this context
   * @readonly
   */
  readonly canvas: HTMLCanvasElement;

  /**
   * The width of the drawing buffer
   * @readonly
   */
  readonly drawingBufferWidth: number;

  /**
   * The height of the drawing buffer
   * @readonly
   */
  readonly drawingBufferHeight: number;

  // ═══════════════════════════════════════════════════════════
  // CAPABILITIES — Shared GPU Feature Queries
  //
  // Scene code should query capabilities through the context,
  // never through backend-specific APIs.
  // ═══════════════════════════════════════════════════════════

  /**
   * Whether the context supports depth textures
   * @readonly
   */
  readonly depthTexture: boolean;

  /**
   * Whether the context supports fragment depth writes
   * @readonly
   */
  readonly fragmentDepth: boolean;

  /**
   * Whether a stencil buffer is available (stencilBits >= 8)
   * WebGL: checks stencil bit count
   * WebGPU: always true (depth24plus-stencil8)
   * @readonly
   */
  readonly stencilBuffer: boolean;

  /**
   * Number of stencil bits available
   * @readonly
   */
  readonly stencilBits: number;

  /**
   * Whether MSAA (multisample anti-aliasing) is supported
   * WebGL: true if WebGL2
   * WebGPU: always true (native MSAA support)
   * @readonly
   */
  readonly msaa: boolean;

  /**
   * Whether the context supports rendering to float32 color buffers
   * WebGL: requires EXT_color_buffer_float
   * WebGPU: always true
   * @readonly
   */
  readonly colorBufferFloat: boolean;

  /**
   * Whether antialiasing is enabled
   * @readonly
   */
  readonly antialias: boolean;

  /**
   * Whether the context supports standard derivatives (dFdx, dFdy / dpdx, dpdy)
   * @readonly
   */
  readonly standardDerivatives: boolean;

  /**
   * Whether the context supports 32-bit element indices
   * @readonly
   */
  readonly elementIndexUint: boolean;

  /**
   * Whether the context supports float blending
   * @readonly
   */
  readonly floatBlend: boolean;

  /**
   * Whether instanced rendering is supported.
   * WebGL: requires ANGLE_instanced_arrays or WebGL2
   * WebGPU: always true
   * @readonly
   */
  readonly instancedArrays: boolean;

  // ═══════════════════════════════════════════════════════════
  // SHARED STATE & CACHES
  //
  // These are renderer-agnostic state objects used by scene
  // code. Both WebGL and WebGPU contexts provide them.
  // ═══════════════════════════════════════════════════════════

  /**
   * Per-frame uniform state (camera matrices, light direction, etc.)
   * This is renderer-agnostic — both WebGL and WebGPU read from it.
   * @readonly
   */
  readonly uniformState: any;

  /**
   * The shader cache for this context
   * @readonly
   */
  readonly shaderCache: any;

  /**
   * The texture cache for this context
   * @readonly
   */
  readonly textureCache: any;

  /**
   * General-purpose resource cache for shared objects (index buffers,
   * vertex buffers, etc.) keyed by name.
   * WebGL: context.cache object
   * WebGPU: context.cache object
   * @readonly
   */
  readonly cache: any;

  /**
   * Default 1x1 white texture. Used as placeholder when actual textures
   * are not yet loaded. Both contexts create this lazily.
   * @readonly
   */
  readonly defaultTexture: any;

  /**
   * Whether the context has been destroyed
   * @readonly
   */
  readonly isDestroyed: boolean;

  // ═══════════════════════════════════════════════════════════
  // FRAME LIFECYCLE
  // ═══════════════════════════════════════════════════════════

  /**
   * Begin a new frame
   */
  beginFrame(): void;

  /**
   * End the current frame
   */
  endFrame(): void;

  /**
   * Clear the framebuffer
   * @param clearCommand - Clear command or color components
   * @param passState - Optional pass state
   */
  clear(clearCommand: any, passState?: any): void;

  /**
   * Resize the drawing buffer
   */
  resize(): void;

  // ═══════════════════════════════════════════════════════════
  // DRAWING
  // ═══════════════════════════════════════════════════════════

  /**
   * Draw a command
   * @param drawCommand - The draw command to execute
   * @param passState - Optional pass state
   */
  draw(drawCommand: any, passState?: any): void;

  /**
   * Get a string describing the renderer
   */
  getRendererString(): string;

  // ═══════════════════════════════════════════════════════════
  // PICKING — Factory Methods
  //
  // Scene code should use these instead of importing
  // backend-specific pick managers.
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a pick ID for an object. Returns an object with
   * a `color` property (Color) used for pick rendering.
   * @param object - The object to create a pick ID for
   */
  createPickId(object: any): any;

  /**
   * Get object by pick color (reverse lookup from pick render)
   * @param pickColor - The pick color
   */
  getObjectByPickColor(pickColor: any): any;

  // ═══════════════════════════════════════════════════════════
  // PIXEL READBACK
  // ═══════════════════════════════════════════════════════════

  /**
   * Read pixels from the framebuffer (synchronous for WebGL,
   * may return null in WebGPU)
   * @param readState - Read state configuration
   */
  readPixels(readState: any): any;

  // ═══════════════════════════════════════════════════════════
  // VIEWPORT COMMANDS
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a viewport quad command for screen-space effects
   * @param fragmentShader - Fragment shader
   * @param options - Additional options
   */
  createViewportQuadCommand(fragmentShader: any, options?: any): any;

  // ═══════════════════════════════════════════════════════════
  // RENDER PASS MANAGEMENT (WebGPU-specific, optional)
  //
  // These are optional methods that only WebGPU implements.
  // WebGL conceptually always has one render pass.
  // ═══════════════════════════════════════════════════════════

  /**
   * End the currently active render pass without ending the frame.
   * WebGL: no-op (WebGL doesn't have explicit render passes)
   * WebGPU: ends the current GPURenderPassEncoder
   */
  endCurrentRenderPass?(): void;

  /**
   * Begin a new render pass (WebGPU only).
   * WebGL: no-op
   * WebGPU: starts a new GPURenderPassEncoder with the given descriptor
   */
  beginRenderPass?(descriptor: any): any;

  /**
   * Resume the default canvas render pass after a custom pass (WebGPU only).
   * WebGL: no-op
   * WebGPU: starts a new render pass targeting the canvas with loadOp: "load"
   */
  resumeDefaultRenderPass?(): any;

  /**
   * Check if a render pass is currently active (WebGPU only).
   * WebGL: always true (conceptually)
   */
  readonly hasActiveRenderPass?: boolean;

  // ═══════════════════════════════════════════════════════════
  // RESOURCE FACTORY METHODS (Simplification #4)
  //
  // Scene code should use these factory methods instead of
  // importing backend-specific resource classes (WebGPUTexture,
  // WebGPUBuffer, etc.). Each context returns its native type.
  //
  // This reduces:
  // - Backend-specific imports in scene files (~30%)
  // - WebGLCompatibilityStub surface area
  // - Need for scene files to know which backend is active
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a texture using the context's native texture type.
   * WebGL: returns Texture (WebGL Texture wrapper)
   * WebGPU: returns WebGPUTexture
   *
   * @param options - Texture creation options
   * @param options.width - Texture width
   * @param options.height - Texture height
   * @param [options.source] - Image source (ImageBitmap, HTMLImageElement, etc.)
   * @param [options.pixelFormat] - Pixel format enum
   * @param [options.pixelDatatype] - Pixel datatype enum
   * @param [options.sampler] - Sampler state
   * @param [options.flipY] - Whether to flip Y axis on upload
   * @returns A backend-native texture object
   */
  createTexture?(options: {
    width: number;
    height: number;
    source?: any;
    pixelFormat?: any;
    pixelDatatype?: any;
    sampler?: any;
    flipY?: boolean;
  }): any;

  /**
   * Create a GPU buffer using the context's native buffer type.
   * WebGL: returns Buffer (WebGL Buffer wrapper)
   * WebGPU: returns WebGPUBuffer
   *
   * @param options - Buffer creation options
   * @param options.typedArray - Data to upload
   * @param options.sizeInBytes - Buffer size (if no typedArray)
   * @param options.usage - Buffer usage flags (BufferUsage enum)
   * @returns A backend-native buffer object
   */
  createBuffer?(options: {
    typedArray?: ArrayBufferView;
    sizeInBytes?: number;
    usage: any;
  }): any;

  /**
   * Build a native draw command from an abstract RenderCommand.
   * This is the key integration point for Simplification #2.
   *
   * WebGL: Builds DrawCommand with appropriate ShaderProgram + RenderState
   * WebGPU: Builds WebGPUDrawCommand with pipeline + bind groups
   *
   * @param renderCommand - The abstract RenderCommand to build
   * @returns A backend-native draw command
   */
  buildRenderCommand?(renderCommand: any): any;

  // ═══════════════════════════════════════════════════════════
  // RESOURCE LIFECYCLE
  // ═══════════════════════════════════════════════════════════

  /**
   * Destroy the context and free all resources
   */
  destroy(): void;
}

/**
 * Options for creating a graphics context
 */
export interface GraphicsContextOptions {
  /**
   * The renderer type to use ('webgl', 'webgpu', or 'auto')
   */
  renderer?: RendererType | string;

  /**
   * Whether to prefer WebGPU when AUTO is selected
   */
  preferWebGPU?: boolean;

  /**
   * WebGL-specific options
   */
  webgl?: WebGLContextAttributes;

  /**
   * Whether to request a WebGL 1 context instead of WebGL 2
   */
  requestWebgl1?: boolean;

  /**
   * Whether to allow texture filter anisotropic extension
   */
  allowTextureFilterAnisotropic?: boolean;

  /**
   * A function stub for testing purposes
   */
  getWebGLStub?: Function;
}

/**
 * Type guard to check if an object implements GraphicsContext
 *
 * @param obj - Object to check
 * @returns True if the object implements GraphicsContext
 */
export function isGraphicsContext(obj: any): obj is GraphicsContext {
  return (
    obj &&
    typeof obj === "object" &&
    "rendererType" in obj &&
    "canvas" in obj &&
    "isWebGPU" in obj &&
    "uniformState" in obj &&
    "beginFrame" in obj &&
    typeof obj.beginFrame === "function" &&
    "endFrame" in obj &&
    typeof obj.endFrame === "function" &&
    "destroy" in obj &&
    typeof obj.destroy === "function"
  );
}

export default GraphicsContext;
