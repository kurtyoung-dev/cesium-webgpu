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
   * Clear the framebuffer with the specified color
   * @param {number} red - Red component (0-1)
   * @param {number} green - Green component (0-1)
   * @param {number} blue - Blue component (0-1)
   * @param {number} alpha - Alpha component (0-1)
   * @returns {void}
   */
  clear(red: number, green: number, blue: number, alpha: number): void;

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
