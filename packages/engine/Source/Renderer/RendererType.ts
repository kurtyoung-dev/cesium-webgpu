/**
 * Enum defining the available renderer backends for CesiumJS.
 * This allows users to explicitly choose between WebGL and WebGPU rendering,
 * or let the system automatically select the best available option.
 *
 * @example
 * // Explicitly use WebGPU
 * const viewer = await Cesium.Viewer.createAsync('container', {
 *   contextOptions: {
 *     renderer: RendererType.WEBGPU
 *   }
 * });
 *
 * @example
 * // Auto-detect with fallback
 * const viewer = await Cesium.Viewer.createAsync('container', {
 *   contextOptions: {
 *     renderer: RendererType.AUTO
 *   }
 * });
 * @module RendererType
 */

import DeveloperError from "../Core/DeveloperError.js";
import rendererBuildCapabilities, {
  type RendererBuildCapabilities,
} from "./RendererBuildCapabilities.js";

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

export type ConcreteRendererType =
  RendererType.WEBGL | RendererType.WEBGPU | RendererType.WEBGPU_COMPAT;

export interface RendererSelectionOptions {
  renderer?: RendererType | string;
  preferWebGPU?: boolean;
  /**
   * When true, an explicit concrete renderer request (e.g. "webgpu" or
   * "webgpu-compat") hard-fails instead of gracefully falling back to WebGL:
   * the request is attempted exactly once and an initialization failure
   * surfaces to the caller. Default false — the charter behavior is
   * fallback-to-WebGL with a console warning.
   */
  strictRenderer?: boolean;
}

export interface RendererAttemptPlan {
  requestedRenderer: RendererType;
  attempts: readonly ConcreteRendererType[];
  selectionReason:
    | "explicit"
    | "auto-webgpu-first"
    | "auto-webgl-only"
    | "auto-build-webgl-only"
    | "auto-build-webgpu-only";
}

export type RendererInitializationStage =
  "availability" | "adapter" | "device" | "context" | "unknown";

/**
 * Identifies which renderer-initialization boundary failed. Keeping this
 * error beside the renderer policy lets the real WebGPU implementation and
 * the context factory share diagnostics without importing each other.
 */
export class RendererInitializationError extends Error {
  readonly stage: RendererInitializationStage;
  readonly cause: unknown;

  constructor(
    stage: RendererInitializationStage,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "RendererInitializationError";
    this.stage = stage;
    this.cause = cause;
  }
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

export function getRendererAttemptPlan(
  options: RendererSelectionOptions = {},
  buildCapabilities: RendererBuildCapabilities = rendererBuildCapabilities,
): RendererAttemptPlan {
  const requestedOption = options.renderer ?? RendererType.AUTO;
  let requested: RendererType;
  if (
    typeof requestedOption !== "string" ||
    !isValidRendererType(requestedOption)
  ) {
    //>>includeStart('debug', pragmas.debug);
    throw new DeveloperError(
      `Invalid renderer type "${String(requestedOption)}".`,
    );
    //>>includeEnd('debug');
    // Release builds warn and fall back to AUTO selection instead of
    // throwing; the throw above is debug-only per the fork logging rules.
    console.warn(
      `[CesiumJS] Invalid renderer type "${String(requestedOption)}" — ` +
        `falling back to "${RendererType.AUTO}" renderer selection.`,
    );
    requested = RendererType.AUTO;
  } else {
    requested = requestedOption;
  }

  switch (requested) {
    case RendererType.AUTO:
      if (options.preferWebGPU === false) {
        return {
          requestedRenderer: RendererType.AUTO,
          attempts: Object.freeze([RendererType.WEBGL]),
          selectionReason: "auto-webgl-only",
        };
      }
      if (buildCapabilities.webgpu && buildCapabilities.webgl) {
        return {
          requestedRenderer: RendererType.AUTO,
          attempts: Object.freeze([RendererType.WEBGPU, RendererType.WEBGL]),
          selectionReason: "auto-webgpu-first",
        };
      }
      if (buildCapabilities.webgpu) {
        return {
          requestedRenderer: RendererType.AUTO,
          attempts: Object.freeze([RendererType.WEBGPU]),
          selectionReason: "auto-build-webgpu-only",
        };
      }
      if (buildCapabilities.webgl) {
        return {
          requestedRenderer: RendererType.AUTO,
          attempts: Object.freeze([RendererType.WEBGL]),
          selectionReason: "auto-build-webgl-only",
        };
      }
      throw new DeveloperError(
        "No renderer backend is available in this build.",
      );
    case RendererType.WEBGPU_COMPAT:
      return {
        requestedRenderer: requested,
        attempts:
          options.strictRenderer !== true && buildCapabilities.webgl
            ? Object.freeze([RendererType.WEBGPU_COMPAT, RendererType.WEBGL])
            : Object.freeze([RendererType.WEBGPU_COMPAT]),
        selectionReason: "explicit",
      };
    case RendererType.WEBGPU:
      // Charter default: an explicit "webgpu" request gracefully falls back
      // to WebGL when WebGPU is unavailable (ContextFactory logs a console
      // warning when the fallback engages). `strictRenderer: true` opts into
      // the hard-fail machinery — the request is attempted exactly once and
      // an initialization failure surfaces as ContextCreationError.
      if (options.strictRenderer !== true && buildCapabilities.webgl) {
        return {
          requestedRenderer: requested,
          attempts: Object.freeze([RendererType.WEBGPU, RendererType.WEBGL]),
          selectionReason: "explicit",
        };
      }
      return {
        requestedRenderer: requested,
        attempts: Object.freeze([requested]),
        selectionReason: "explicit",
      };
    case RendererType.WEBGL:
      return {
        requestedRenderer: requested,
        attempts: Object.freeze([requested]),
        selectionReason: "explicit",
      };
  }
}

/**
 * Resolves the renderer allowed by Cesium's legacy synchronous constructors.
 * WebGPU and fallback-capable policies require asynchronous initialization, so
 * synchronous construction deliberately supports WebGL only.
 */
export function getSynchronousRendererType(
  options: RendererSelectionOptions = {},
  buildCapabilities: RendererBuildCapabilities = rendererBuildCapabilities,
): RendererType.WEBGL {
  const requested = options.renderer ?? RendererType.WEBGL;
  if (typeof requested !== "string" || !isValidRendererType(requested)) {
    throw new DeveloperError(`Invalid renderer type "${String(requested)}".`);
  }

  if (requested !== RendererType.WEBGL) {
    throw new DeveloperError(
      `Renderer "${requested}" requires asynchronous initialization. Use createAsync instead.`,
    );
  }
  if (!buildCapabilities.webgl) {
    throw new DeveloperError("WebGL is not available in this build.");
  }
  return RendererType.WEBGL;
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
 * Legacy module-level build hint retained for entry-point compatibility.
 * Runtime AUTO policy is defined by getRendererAttemptPlan and does not read
 * this mutable value.
 *
 * Defaults to WEBGPU for existing callers of getGlobalDefaultRenderer.
 */
let _globalDefaultRenderer: RendererType = RendererType.WEBGPU;

/**
 * Set the legacy module-level build hint. This has no effect on the runtime
 * AUTO attempt policy.
 */
export function setGlobalDefaultRenderer(rendererType: RendererType): void {
  _globalDefaultRenderer = rendererType;
}

/**
 * Read the legacy module-level build hint.
 */
export function getGlobalDefaultRenderer(): RendererType {
  return _globalDefaultRenderer;
}

/**
 * Gets the recommended renderer type based on browser capabilities.
 *
 * @param {boolean} [preferWebGPU] - Whether to prefer WebGPU when both
 *   are available. Only an explicit false disables WebGPU preference.
 * @param {RendererBuildCapabilities} [buildCapabilities] - Backends compiled
 *   into this build variant.
 * @returns {RendererType} The recommended renderer type
 */
export function getDefaultRendererType(
  preferWebGPU?: boolean,
  buildCapabilities: RendererBuildCapabilities = rendererBuildCapabilities,
): RendererType {
  if (
    preferWebGPU !== false &&
    buildCapabilities.webgpu &&
    isWebGPUSupported()
  ) {
    return RendererType.WEBGPU;
  }
  if (buildCapabilities.webgl) {
    return RendererType.WEBGL;
  }
  if (buildCapabilities.webgpu) {
    return RendererType.WEBGPU;
  }
  throw new DeveloperError("No renderer backend is available in this build.");
}

export default RendererType;
