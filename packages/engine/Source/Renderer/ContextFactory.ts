/**
 * @module ContextFactory
 *
 * Factory for creating graphics contexts (WebGL or WebGPU).
 * This provides a unified entry point for context creation and handles
 * automatic renderer selection based on browser capabilities.
 *
 * @example
 * // Create a WebGPU context with fallback
 * const context = await ContextFactory.createContext(canvas, {
 *   renderer: RendererType.AUTO,
 *   preferWebGPU: true
 * });
 *
 * @example
 * // Explicitly request WebGL
 * const context = await ContextFactory.createContext(canvas, {
 *   renderer: RendererType.WEBGL
 * });
 */

import RendererType, {
  isWebGPUSupported,
  getDefaultRendererType,
  isValidRendererType,
} from "./RendererType.js";
import { GraphicsContext, GraphicsContextOptions } from "./GraphicsContext.js";
import Context from "./Context.js";
import DeveloperError from "../Core/DeveloperError.js";
import defined from "../Core/defined.js";

/**
 * Factory class for creating graphics contexts
 */
export class ContextFactory {
  /**
   * Creates a graphics context based on the provided options.
   *
   * This method handles:
   * - Automatic renderer selection (AUTO mode)
   * - WebGPU feature detection and fallback
   * - Context creation with appropriate options
   *
   * @param {HTMLCanvasElement} canvas - The canvas element for rendering
   * @param {GraphicsContextOptions} [options] - Configuration options
   * @returns {Promise<GraphicsContext>} A promise that resolves to the created context
   * @throws {DeveloperError} If the canvas is undefined or context creation fails
   *
   * @example
   * const context = await ContextFactory.createContext(canvas, {
   *   renderer: 'webgpu',
   *   preferWebGPU: true
   * });
   */
  static async createContext(
    canvas: HTMLCanvasElement,
    options?: GraphicsContextOptions,
  ): Promise<GraphicsContext> {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(canvas)) {
      throw new DeveloperError("canvas is required.");
    }
    //>>includeEnd('debug');

    options = options || {};

    // Determine which renderer to use
    const rendererType = this._determineRendererType(options);

    // Create the appropriate context
    switch (rendererType) {
      case RendererType.WEBGPU:
        return await this._createWebGPUContext(canvas, options);

      case RendererType.WEBGL:
      default:
        return this._createWebGLContext(canvas, options);
    }
  }

  /**
   * Determines which renderer type to use based on options and capabilities.
   *
   * @private
   * @param {GraphicsContextOptions} options - Configuration options
   * @returns {RendererType} The renderer type to use
   */
  private static _determineRendererType(
    options: GraphicsContextOptions,
  ): RendererType {
    let rendererType: RendererType | undefined =
      options.renderer as RendererType;

    // Convert string to enum if needed
    if (typeof options.renderer === "string") {
      if (isValidRendererType(options.renderer)) {
        rendererType = options.renderer as RendererType;
      } else {
        //>>includeStart('debug', pragmas.debug);
        console.warn(
          `Invalid renderer type "${options.renderer}". Falling back to AUTO.`,
        );
        //>>includeEnd('debug');
        rendererType = RendererType.AUTO;
      }
    }

    // Handle AUTO mode
    if (!rendererType || rendererType === RendererType.AUTO) {
      return getDefaultRendererType(options.preferWebGPU);
    }

    // Validate WebGPU is actually available
    if (rendererType === RendererType.WEBGPU && !isWebGPUSupported()) {
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        "WebGPU is not supported in this browser. Falling back to WebGL.",
      );
      //>>includeEnd('debug');
      return RendererType.WEBGL;
    }

    return rendererType;
  }

  /**
   * Creates a WebGL context (wraps existing Context implementation).
   *
   * @private
   * @param {HTMLCanvasElement} canvas - The canvas element
   * @param {GraphicsContextOptions} options - Configuration options
   * @returns {GraphicsContext} The WebGL context
   */
  private static _createWebGLContext(
    canvas: HTMLCanvasElement,
    options: GraphicsContextOptions,
  ): GraphicsContext {
    // For now, wrap the existing Context.js implementation
    // In a future phase, we'll refactor Context.js to be WebGLContext
    return new Context(canvas, options) as any as GraphicsContext;
  }

  /**
   * Creates a WebGPU context.
   *
   * @private
   * @param {HTMLCanvasElement} canvas - The canvas element
   * @param {GraphicsContextOptions} options - Configuration options
   * @returns {Promise<GraphicsContext>} A promise that resolves to the WebGPU context
   * @throws {DeveloperError} If WebGPU initialization fails
   */
  private static async _createWebGPUContext(
    canvas: HTMLCanvasElement,
    options: GraphicsContextOptions,
  ): Promise<GraphicsContext> {
    //>>includeStart('debug', pragmas.debug);
    if (!isWebGPUSupported()) {
      throw new DeveloperError("WebGPU is not supported in this browser.");
    }
    //>>includeEnd('debug');

    // Dynamically import WebGPUContext to avoid loading it when not needed
    const { WebGPUContext } = await import("./WebGPU/WebGPUContext.js");
    return await WebGPUContext.create(canvas, options);
  }

  /**
   * Checks if a specific renderer type is supported in the current environment.
   *
   * @param {RendererType | string} rendererType - The renderer type to check
   * @returns {boolean} True if the renderer is supported
   *
   * @example
   * if (ContextFactory.isRendererSupported('webgpu')) {
   *   console.log('WebGPU is available!');
   * }
   */
  static isRendererSupported(rendererType: RendererType | string): boolean {
    if (typeof rendererType === "string") {
      if (!isValidRendererType(rendererType)) {
        return false;
      }
      rendererType = rendererType as RendererType;
    }

    switch (rendererType) {
      case RendererType.WEBGPU:
        return isWebGPUSupported();

      case RendererType.WEBGL:
        return typeof WebGLRenderingContext !== "undefined";

      case RendererType.AUTO:
        return true; // AUTO always supported (falls back)

      default:
        return false;
    }
  }

  /**
   * Gets information about available renderers in the current environment.
   *
   * @returns {Object} Object containing renderer availability information
   *
   * @example
   * const info = ContextFactory.getRendererInfo();
   * console.log(`WebGL: ${info.webgl}, WebGPU: ${info.webgpu}`);
   */
  static getRendererInfo(): {
    webgl: boolean;
    webgpu: boolean;
    recommended: RendererType;
  } {
    return {
      webgl: this.isRendererSupported(RendererType.WEBGL),
      webgpu: this.isRendererSupported(RendererType.WEBGPU),
      recommended: getDefaultRendererType(true),
    };
  }
}

export default ContextFactory;
