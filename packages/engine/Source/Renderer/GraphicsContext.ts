/**
 * @module GraphicsContext
 *
 * Abstract interface defining the common operations that both WebGL and WebGPU
 * rendering contexts must implement. This allows the rest of CesiumJS to work
 * with either renderer through a unified API.
 *
 * @interface
 */

import RendererType from "./RendererType.js";

/**
 * Abstract base interface for graphics contexts.
 * Both WebGLContext and WebGPUContext implement this interface.
 *
 * @interface GraphicsContext
 */
export interface GraphicsContext {
  /**
   * The renderer type for this context
   * @type {RendererType}
   * @readonly
   */
  readonly rendererType: RendererType;

  /**
   * The canvas element associated with this context
   * @type {HTMLCanvasElement}
   * @readonly
   */
  readonly canvas: HTMLCanvasElement;

  /**
   * The width of the drawing buffer
   * @type {number}
   * @readonly
   */
  readonly drawingBufferWidth: number;

  /**
   * The height of the drawing buffer
   * @type {number}
   * @readonly
   */
  readonly drawingBufferHeight: number;

  /**
   * Whether the context supports depth textures
   * @type {boolean}
   * @readonly
   */
  readonly depthTexture: boolean;

  /**
   * Whether the context supports fragment depth
   * @type {boolean}
   * @readonly
   */
  readonly fragmentDepth: boolean;

  /**
   * Whether the context has been destroyed
   * @type {boolean}
   * @readonly
   */
  readonly isDestroyed: boolean;

  /**
   * Unique context identifier
   * @type {string}
   * @readonly
   */
  readonly id: string;

  /**
   * The shader cache for this context
   * @type {any}
   * @readonly
   */
  readonly shaderCache: any;

  /**
   * The texture cache for this context
   * @type {any}
   * @readonly
   */
  readonly textureCache: any;

  /**
   * Number of stencil bits available
   * @type {number}
   * @readonly
   */
  readonly stencilBits: number;

  /**
   * Whether antialiasing is enabled
   * @type {boolean}
   * @readonly
   */
  readonly antialias: boolean;

  /**
   * Whether the context supports standard derivatives (dFdx, dFdy)
   * @type {boolean}
   * @readonly
   */
  readonly standardDerivatives: boolean;

  /**
   * Whether the context supports element index uint
   * @type {boolean}
   * @readonly
   */
  readonly elementIndexUint: boolean;

  /**
   * Whether the context supports float blending
   * @type {boolean}
   * @readonly
   */
  readonly floatBlend: boolean;

  /**
   * Default 1x1 white texture
   * @type {any}
   * @readonly
   */
  readonly defaultTexture: any;

  /**
   * Begin a new frame
   * @returns {void}
   */
  beginFrame(): void;

  /**
   * End the current frame
   * @returns {void}
   */
  endFrame(): void;

  /**
   * Clear the framebuffer
   * @param {any} clearCommand - Clear command or color components
   * @param {any} [passState] - Optional pass state
   * @returns {void}
   */
  clear(clearCommand: any, passState?: any): void;

  /**
   * Resize the drawing buffer
   * @returns {void}
   */
  resize(): void;

  /**
   * Get a string describing the renderer
   * @returns {string} Renderer description
   */
  getRendererString(): string;

  /**
   * Draw a command
   * @param {any} drawCommand - The draw command to execute
   * @param {any} [passState] - Optional pass state
   * @returns {void}
   */
  draw(drawCommand: any, passState?: any): void;

  /**
   * Read pixels from the framebuffer (synchronous, may return null in WebGPU)
   * @param {any} readState - Read state configuration
   * @returns {any} Pixel data
   */
  readPixels(readState: any): any;

  /**
   * Create a pick ID for an object
   * @param {any} object - The object to create a pick ID for
   * @returns {any} Pick ID
   */
  createPickId(object: any): any;

  /**
   * Get object by pick color
   * @param {any} pickColor - The pick color
   * @returns {any} The picked object
   */
  getObjectByPickColor(pickColor: any): any;

  /**
   * Create a viewport quad command for screen-space effects
   * @param {any} fragmentShader - Fragment shader
   * @param {any} [options] - Additional options
   * @returns {any} Viewport quad command
   */
  createViewportQuadCommand(fragmentShader: any, options?: any): any;

  /**
   * End the currently active render pass without ending the frame.
   * WebGL: no-op (WebGL doesn't have explicit render passes)
   * WebGPU: ends the current GPURenderPassEncoder
   * @returns {void}
   */
  endCurrentRenderPass?(): void;

  /**
   * Begin a new render pass (WebGPU only).
   * WebGL: no-op
   * WebGPU: starts a new GPURenderPassEncoder with the given descriptor
   * @param {any} descriptor - Render pass descriptor
   * @returns {any} The render pass encoder (or null)
   */
  beginRenderPass?(descriptor: any): any;

  /**
   * Resume the default canvas render pass after a custom pass (WebGPU only).
   * WebGL: no-op
   * WebGPU: starts a new render pass targeting the canvas with loadOp: "load"
   * @returns {any} The render pass encoder (or null)
   */
  resumeDefaultRenderPass?(): any;

  /**
   * Check if a render pass is currently active (WebGPU only).
   * WebGL: always true (conceptually)
   * @type {boolean}
   */
  readonly hasActiveRenderPass?: boolean;

  /**
   * Destroy the context and free all resources
   * @returns {void}
   */
  destroy(): void;
}

/**
 * Options for creating a graphics context
 *
 * @interface GraphicsContextOptions
 */
export interface GraphicsContextOptions {
  /**
   * The renderer type to use
   * @type {RendererType}
   */
  renderer?: RendererType | string;

  /**
   * Whether to prefer WebGPU when AUTO is selected
   * @type {boolean}
   */
  preferWebGPU?: boolean;

  /**
   * WebGL-specific options
   * @type {WebGLContextAttributes}
   */
  webgl?: WebGLContextAttributes;

  /**
   * Whether to request a WebGL 1 context instead of WebGL 2
   * @type {boolean}
   */
  requestWebgl1?: boolean;

  /**
   * Whether to allow texture filter anisotropic extension
   * @type {boolean}
   */
  allowTextureFilterAnisotropic?: boolean;

  /**
   * A function stub for testing purposes
   * @type {Function}
   */
  getWebGLStub?: Function;
}

/**
 * Type guard to check if an object implements GraphicsContext
 *
 * @param {any} obj - Object to check
 * @returns {boolean} True if the object implements GraphicsContext
 */
export function isGraphicsContext(obj: any): obj is GraphicsContext {
  return (
    obj &&
    typeof obj === "object" &&
    "rendererType" in obj &&
    "canvas" in obj &&
    "beginFrame" in obj &&
    typeof obj.beginFrame === "function" &&
    "endFrame" in obj &&
    typeof obj.endFrame === "function" &&
    "destroy" in obj &&
    typeof obj.destroy === "function"
  );
}

export default GraphicsContext;
