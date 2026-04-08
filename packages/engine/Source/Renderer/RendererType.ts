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
   * Use WebGPU API in compatibility mode (featureLevel: "compatibility").
   * Runs on WebGL2 hardware via the browser's WebGPU backend.
   * Provides WebGPU API benefits (modern pipeline caching, compute shaders)
   * on hardware that doesn't support full WebGPU core features.
   * Falls back to WebGL if WebGPU is not available at all.
   * @type {string}
   */
  WEBGPU_COMPAT = "webgpu-compat",

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
 * Module-level default for which renderer to pick when none is explicitly
 * requested. Set by entry-point files at module init time so each build
 * variant can ship a different default without forking the runtime code.
 *
 *   - "webgl-only" build → ships an entry that calls
 *      `setGlobalDefaultRenderer(RendererType.WEBGL)`
 *   - "webgpu-only" build → ships an entry that calls
 *      `setGlobalDefaultRenderer(RendererType.WEBGPU)`
 *   - dual build, webgpu-first entry → sets WEBGPU
 *   - dual build, webgl-first entry → sets WEBGL
 *
 * Defaults to WEBGPU so that fresh installs (and CDN consumers who don't
 * customise) get the modern backend by default. Code that wants the
 * historical WebGL-default behaviour calls `setGlobalDefaultRenderer` from
 * its bootstrap.
 */
let _globalDefaultRenderer: RendererType = RendererType.WEBGPU;

/**
 * Set the module-level default renderer. Called from build-variant entry
 * points. Has no effect on contexts that explicitly pass a `renderer`
 * option to `ContextFactory.createContext()`.
 */
export function setGlobalDefaultRenderer(rendererType: RendererType): void {
  _globalDefaultRenderer = rendererType;
}

/**
 * Read the module-level default renderer. Used by `ContextFactory` when
 * the caller picked `RendererType.AUTO` (the default) and didn't pass
 * `preferWebGPU` explicitly.
 */
export function getGlobalDefaultRenderer(): RendererType {
  return _globalDefaultRenderer;
}

/**
 * Gets the default renderer type based on browser capabilities and the
 * current global default. Honors the explicit `preferWebGPU` argument
 * when provided; otherwise falls back to the value set via
 * `setGlobalDefaultRenderer()` (default WEBGPU).
 *
 * @param {boolean} [preferWebGPU] - Whether to prefer WebGPU when both
 *   are available. When omitted, the module-level default is used.
 * @returns {RendererType} The recommended renderer type
 */
export function getDefaultRendererType(preferWebGPU?: boolean): RendererType {
  // Determine the *preference* — explicit arg wins over module default.
  const wantsWebGPU =
    preferWebGPU ?? _globalDefaultRenderer === RendererType.WEBGPU;

  if (wantsWebGPU && isWebGPUSupported()) {
    return RendererType.WEBGPU;
  }
  return RendererType.WEBGL;
}

export default RendererType;
