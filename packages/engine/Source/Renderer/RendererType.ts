/**
 * @module RendererType
 *
 * Enum defining the available renderer backends for CesiumJS.
 * This allows users to explicitly choose between WebGL and WebGPU rendering,
 * or let the system automatically select the best available option.
 *
 * @example
 * // Explicitly use WebGPU
 * const viewer = new Cesium.Viewer('container', {
 *   contextOptions: {
 *     renderer: RendererType.WEBGPU
 *   }
 * });
 *
 * @example
 * // Auto-detect with fallback
 * const viewer = new Cesium.Viewer('container', {
 *   contextOptions: {
 *     renderer: RendererType.AUTO
 *   }
 * });
 */

/**
 * Enum for available renderer types.
 *
 * @enum {string}
 * @readonly
 */
export enum RendererType {
  /**
   * Use the WebGL rendering backend (legacy, widely supported)
   * @type {string}
   */
  WEBGL = "webgl",

  /**
   * Use the WebGPU rendering backend (modern, high-performance)
   * @type {string}
   */
  WEBGPU = "webgpu",

  /**
   * Automatically detect and use the best available renderer.
   * Prefers WebGPU if available, falls back to WebGL.
   * @type {string}
   */
  AUTO = "auto",
}

/**
 * Checks if a string is a valid RendererType value.
 *
 * @param {string} value - The value to check
 * @returns {boolean} True if the value is a valid RendererType
 */
export function isValidRendererType(value: string): value is RendererType {
  return Object.values(RendererType).includes(value as RendererType);
}

/**
 * Checks if WebGPU is supported in the current browser.
 *
 * @returns {boolean} True if WebGPU is supported
 */
export function isWebGPUSupported(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/**
 * Gets the default renderer type based on browser capabilities.
 *
 * @param {boolean} [preferWebGPU=false] - Whether to prefer WebGPU when both are available
 * @returns {RendererType} The recommended renderer type
 */
export function getDefaultRendererType(
  preferWebGPU: boolean = false,
): RendererType {
  if (preferWebGPU && isWebGPUSupported()) {
    return RendererType.WEBGPU;
  }
  return RendererType.WEBGL;
}

export default RendererType;
