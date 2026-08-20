/**
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
 * @module ContextFactory
 */

import RendererType, {
  type ConcreteRendererType,
  type RendererAttemptPlan,
  RendererInitializationError,
  type RendererInitializationStage,
  getDefaultRendererType,
  getRendererAttemptPlan,
  isWebGPUSupported,
  isValidRendererType,
} from "./RendererType.js";
import rendererBuildCapabilities, {
  type RendererBuildCapabilities,
} from "./RendererBuildCapabilities.js";
import GraphicsContext, { GraphicsContextOptions } from "./GraphicsContext.js";
import Context from "./Context.js";
import DeveloperError from "../Core/DeveloperError.js";
import defined from "../Core/defined.js";

export { RendererInitializationError };
export type { RendererInitializationStage };

export interface RendererAttemptDiagnostic {
  readonly renderer: ConcreteRendererType;
  readonly status: "succeeded" | "failed";
  readonly stage?: RendererInitializationStage;
  readonly message?: string;
}

export interface RendererFallbackDiagnostic {
  readonly fromRenderer: RendererType.WEBGPU | RendererType.WEBGPU_COMPAT;
  readonly stage: RendererInitializationStage;
  readonly message: string;
}

/**
 * Mirrored as JSDoc typedefs in `Scene/Scene.js` so the published `.d.ts` can
 * type `Scene#contextCreationDiagnostics` — the declaration generator cannot
 * resolve a TypeScript interface from a JavaScript doclet. Nothing enforces the
 * two in lockstep, so a member added here (or to `selectionReason` /
 * `RendererInitializationStage` in `RendererType.ts`) must be added there in the
 * same change, or the public typings silently drift from the runtime shape.
 */
export interface ContextCreationDiagnostics {
  readonly requestedRenderer: RendererType;
  readonly resolvedRenderer: ConcreteRendererType | null;
  readonly selectionReason: RendererAttemptPlan["selectionReason"];
  readonly attempts: readonly RendererAttemptDiagnostic[];
  readonly fallback: RendererFallbackDiagnostic | null;
}

export interface ContextCreationResult {
  readonly context: GraphicsContext;
  readonly diagnostics: ContextCreationDiagnostics;
}

export interface ContextCreationHooks {
  readonly buildCapabilities: RendererBuildCapabilities;
  isWebGPUSupported(): boolean;
  createWebGL(
    canvas: HTMLCanvasElement,
    options: GraphicsContextOptions,
  ): GraphicsContext | Promise<GraphicsContext>;
  createWebGPU(
    canvas: HTMLCanvasElement,
    options: GraphicsContextOptions,
  ): Promise<GraphicsContext>;
}

export class ContextCreationError extends Error {
  readonly diagnostics: ContextCreationDiagnostics;
  readonly cause: unknown;

  constructor(
    message: string,
    diagnostics: ContextCreationDiagnostics,
    cause: unknown,
  ) {
    super(message);
    this.name = "ContextCreationError";
    this.diagnostics = diagnostics;
    this.cause = cause;
  }
}

const defaultCreationHooks: ContextCreationHooks = {
  buildCapabilities: rendererBuildCapabilities,
  isWebGPUSupported,
  createWebGL(canvas, options) {
    return new Context(canvas, options);
  },
  async createWebGPU(canvas, options) {
    // Kick GPU-process adapter negotiation before awaiting the WebGPU chunk
    // import, so the two slow lanes overlap instead of running serially.
    // `WebGPUDevicePool.acquireDevice` consumes this in-flight promise and
    // falls back to its own `requestAdapter` on any mismatch or rejection.
    // Only reached on the WebGPU path, so it never spuriously wakes the GPU
    // process on a WebGL-only page.
    let prefetchedAdapter: Promise<GPUAdapter | null> | undefined;
    try {
      const powerPreference: GPUPowerPreference =
        (options as { powerPreference?: GPUPowerPreference }).powerPreference ??
        "high-performance";
      prefetchedAdapter = navigator.gpu?.requestAdapter?.({ powerPreference });
      // Neutralize rejection at the source: on the device-sharing or
      // compatibility path the pool never awaits this promise, so a rejection
      // would otherwise surface as an unhandled rejection. Resolving to null
      // instead makes an unconsumed prefetch harmless AND makes the pool fall
      // back to its own `requestAdapter` when it IS consumed.
      if (prefetchedAdapter) {
        prefetchedAdapter = prefetchedAdapter.catch(
          (): GPUAdapter | null => null,
        );
      }
    } catch (e) {
      prefetchedAdapter = undefined;
    }
    const { WebGPUContext } = await import("./WebGPU/WebGPUContext.js");
    return await WebGPUContext.create(canvas, {
      ...options,
      prefetchedAdapter,
    });
  },
};

function optionsForAttempt(
  options: GraphicsContextOptions,
  renderer: ConcreteRendererType,
): GraphicsContextOptions {
  if (renderer === RendererType.WEBGPU_COMPAT) {
    return {
      ...options,
      renderer,
      featureLevel: "compatibility",
    };
  }
  return { ...options, renderer };
}

function getFailureDetails(error: unknown): {
  stage: RendererInitializationStage;
  message: string;
} {
  return {
    stage:
      error instanceof RendererInitializationError ? error.stage : "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}

function freezeDiagnostics(
  plan: RendererAttemptPlan,
  resolvedRenderer: ConcreteRendererType | null,
  attempts: readonly RendererAttemptDiagnostic[],
  fallback: RendererFallbackDiagnostic | null,
): ContextCreationDiagnostics {
  const frozenAttempts = Object.freeze(
    attempts.map((attempt) => Object.freeze({ ...attempt })),
  );
  const frozenFallback = fallback ? Object.freeze({ ...fallback }) : null;
  return Object.freeze({
    requestedRenderer: plan.requestedRenderer,
    resolvedRenderer,
    selectionReason: plan.selectionReason,
    attempts: frozenAttempts,
    fallback: frozenFallback,
  });
}

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
    const result = await this.createContextWithDiagnostics(canvas, options);
    return result.context;
  }

  static async createContextWithDiagnostics(
    canvas: HTMLCanvasElement,
    options: GraphicsContextOptions = {},
    hooks: ContextCreationHooks = defaultCreationHooks,
  ): Promise<ContextCreationResult> {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(canvas)) {
      throw new DeveloperError("canvas is required.");
    }
    //>>includeEnd('debug');

    const plan = getRendererAttemptPlan(options, hooks.buildCapabilities);
    const attempts: RendererAttemptDiagnostic[] = [];
    let fallback: RendererFallbackDiagnostic | null = null;
    let lastError: unknown;

    for (let i = 0; i < plan.attempts.length; i++) {
      const renderer = plan.attempts[i];
      try {
        const availableInBuild =
          renderer === RendererType.WEBGL
            ? hooks.buildCapabilities.webgl
            : hooks.buildCapabilities.webgpu;
        if (!availableInBuild) {
          throw new RendererInitializationError(
            "availability",
            `${renderer} is not available in this build.`,
          );
        }

        let context: GraphicsContext;
        const attemptOptions = optionsForAttempt(options, renderer);
        if (renderer === RendererType.WEBGL) {
          context = await hooks.createWebGL(canvas, attemptOptions);
        } else {
          if (!hooks.isWebGPUSupported()) {
            throw new RendererInitializationError(
              "availability",
              `${renderer} is not supported in this environment.`,
            );
          }
          context = await hooks.createWebGPU(canvas, attemptOptions);
        }

        attempts.push({ renderer, status: "succeeded" });
        return {
          context,
          diagnostics: freezeDiagnostics(plan, renderer, attempts, fallback),
        };
      } catch (error) {
        lastError = error;
        const failure = getFailureDetails(error);
        attempts.push({
          renderer,
          status: "failed",
          stage: failure.stage,
          message: failure.message,
        });
        if (
          i + 1 < plan.attempts.length &&
          (renderer === RendererType.WEBGPU ||
            renderer === RendererType.WEBGPU_COMPAT)
        ) {
          fallback = {
            fromRenderer: renderer,
            stage: failure.stage,
            message: failure.message,
          };
          if (plan.selectionReason === "explicit") {
            // Charter behavior: an explicitly-requested WebGPU backend that
            // cannot initialize gracefully falls back to WebGL with a
            // visible warning (permanent, not pragma'd — the caller asked
            // for "webgpu" and needs to know they are rendering on WebGL).
            // `strictRenderer: true` removes the fallback attempt from the
            // plan, so this branch is never reached in strict mode.
            console.warn(
              `[CesiumJS] Explicitly requested renderer "${renderer}" failed ` +
                `to initialize (${failure.stage}: ${failure.message}). ` +
                `Falling back to WebGL. Pass strictRenderer: true in ` +
                `contextOptions to fail instead of falling back.`,
            );
          }
        }
      }
    }

    const diagnostics = freezeDiagnostics(plan, null, attempts, fallback);
    const failure = getFailureDetails(lastError);
    throw new ContextCreationError(
      `Failed to create a graphics context: ${failure.message}`,
      diagnostics,
      lastError,
    );
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
  static isRendererSupported(
    rendererType: RendererType | string,
    buildCapabilities: RendererBuildCapabilities = rendererBuildCapabilities,
  ): boolean {
    if (typeof rendererType === "string") {
      if (!isValidRendererType(rendererType)) {
        return false;
      }
      rendererType = rendererType as RendererType;
    }

    switch (rendererType) {
      case RendererType.WEBGPU:
      case RendererType.WEBGPU_COMPAT:
        return buildCapabilities.webgpu && isWebGPUSupported();

      case RendererType.WEBGL:
        return (
          buildCapabilities.webgl &&
          typeof WebGLRenderingContext !== "undefined"
        );

      case RendererType.AUTO:
        return (
          (buildCapabilities.webgpu && isWebGPUSupported()) ||
          (buildCapabilities.webgl &&
            typeof WebGLRenderingContext !== "undefined")
        );

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
  static getRendererInfo(
    buildCapabilities: RendererBuildCapabilities = rendererBuildCapabilities,
  ): {
    webgl: boolean;
    webgpu: boolean;
    webgpuCompat: boolean;
    recommended: RendererType;
  } {
    return {
      webgl: this.isRendererSupported(RendererType.WEBGL, buildCapabilities),
      webgpu: this.isRendererSupported(RendererType.WEBGPU, buildCapabilities),
      webgpuCompat: this.isRendererSupported(
        RendererType.WEBGPU_COMPAT,
        buildCapabilities,
      ),
      recommended: getDefaultRendererType(true, buildCapabilities),
    };
  }
}

export default ContextFactory;
