/**
 * @module GraphicsContext
 *
 * Abstract base class that defines the unified API for both WebGL and WebGPU
 * rendering contexts. This is the cornerstone of CesiumJS's backend-agnostic
 * architecture — scene code interacts with this class, never with backend-specific
 * implementations directly.
 *
 * ## Design Philosophy (Three.js + PlayCanvas Hybrid)
 *
 * **From Three.js:** Both `Context.js` (WebGL) and `WebGPUContext.ts` (WebGPU) extend
 * this class and implement the same abstract API. TypeScript enforces parity at compile
 * time — if you add a method to GraphicsContext, both backends must implement it.
 *
 * **From PlayCanvas:** This is a concrete base class (not just an interface) that
 * provides shared default implementations for logging, registry management, feature
 * renderer lookup, and capability queries. Backend-specific logic is in overridden
 * abstract methods only.
 *
 * ## Multi-Context Support
 *
 * Every GraphicsContext instance has a unique ID and is automatically tracked by the
 * static `ContextRegistry`. Multiple contexts can run simultaneously:
 * - Split-screen: WebGL left + WebGPU right (same scene graph)
 * - Multi-monitor: Different canvases, different or same backends
 * - Mixed: WebGL for rendering + WebGPU compute for processing
 *
 * ## Usage
 * ```typescript
 * // Scene code — backend-agnostic:
 * const ctx: GraphicsContext = scene.context;
 * ctx.log('info', 'Rendering frame');
 * ctx.clear(clearCommand);
 * ctx.draw(drawCommand);
 *
 * // External/extension code — can query but should not branch:
 * console.log(ctx.rendererType);  // 'webgl' or 'webgpu'
 * console.log(ctx.isWebGPU);      // true or false
 *
 * // Multi-context scenarios:
 * const registry = GraphicsContext.registry;
 * console.log(registry.count);    // number of active contexts
 * ```
 *
 * @see ContextRegistry
 * @see ContextFactory
 * @see SharedResourcePool
 */

import RendererType from "./RendererType.js";
import { ContextRegistry } from "./ContextRegistry.js";
import FeatureRendererKey from "./FeatureRendererKey.js";

// ═══════════════════════════════════════════════════════════
// FEATURE RENDERER INTERFACE (Phase C)
// ═══════════════════════════════════════════════════════════

/**
 * Interface for backend-specific feature renderers.
 *
 * Scene code calls `context.getFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION)?.update(...)`
 * instead of importing from `Renderer/WebGPU/` directly. Each backend registers its own
 * implementation of each feature renderer.
 *
 * Feature renderers handle:
 * - GPU resource creation (buffers, pipelines, textures)
 * - Draw command emission
 * - Backend-specific optimizations
 *
 * They do NOT handle:
 * - Entity management, dirty tracking (shared scene logic)
 * - Visibility checks, mode updates (shared pre-branch logic)
 */
export interface FeatureRenderer {
  /** Allow additional properties for specialized feature renderers */
  [key: string]: any;
  /**
   * Update and render this feature for the current frame.
   * Optional because some feature renderers use different entry points
   * (e.g., createCommands, getParameters, RendererClass).
   * @param collection - The scene collection (BillboardCollection, etc.)
   * @param frameState - Current frame state
   * @param commandList - Command list to push draw commands to
   */
  update?(collection: any, frameState: any, ...args: any[]): any;

  /**
   * Destroy GPU resources owned by this renderer.
   * @param collection - The scene collection being destroyed
   */
  destroy?(collection?: any): void;

  /**
   * Optional: name for debugging/diagnostics.
   */
  readonly name?: string;
}

// ═══════════════════════════════════════════════════════════
// GRAPHICS CONTEXT OPTIONS
// ═══════════════════════════════════════════════════════════

/**
 * Options for creating a graphics context.
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

  /**
   * Whether to use OffscreenCanvas in a WebWorker for this context.
   * When true, the context renders in a background worker thread.
   * Requires OffscreenCanvas browser support.
   * @default false
   */
  useOffscreenCanvas?: boolean;
}

// ═══════════════════════════════════════════════════════════
// ABSTRACT GRAPHICS CONTEXT CLASS
// ═══════════════════════════════════════════════════════════

/**
 * Abstract base class for graphics contexts.
 *
 * Both `Context.js` (WebGL) and `WebGPUContext.ts` (WebGPU) extend this class.
 * Provides shared concrete implementations for:
 * - Context-aware logging with `[CesiumJS:type:id]` prefix
 * - Automatic registration with `ContextRegistry`
 * - Feature Renderer registry for backend-agnostic scene code
 * - Convenience type-checking getters (`isWebGPU`, `isWebGL`)
 * - Shared resource pool access
 */
export abstract class GraphicsContext {
  // ═══════════════════════════════════════════════════════════
  // STATIC: CONTEXT REGISTRY (singleton)
  // ═══════════════════════════════════════════════════════════

  /**
   * Global registry tracking ALL active GraphicsContext instances.
   * Supports multi-view, split-screen, and mixed-backend scenarios.
   *
   * @example
   * const allContexts = GraphicsContext.registry.all;
   * const webgpuContexts = GraphicsContext.registry.getByType(RendererType.WEBGPU);
   */
  private static _registry: ContextRegistry = new ContextRegistry();

  static get registry(): ContextRegistry {
    return GraphicsContext._registry;
  }

  // ═══════════════════════════════════════════════════════════
  // INSTANCE: Feature Renderer Registry
  // ═══════════════════════════════════════════════════════════

  /**
   * Array of registered feature renderers indexed by {@link FeatureRendererKey}.
   * Uses direct array-index access (O(1)) instead of string-keyed Map lookups.
   * Each backend populates this with its own implementations.
   * @private
   */
  private _featureRenderers: (FeatureRenderer | undefined)[] = new Array(
    FeatureRendererKey.COUNT,
  );

  // ═══════════════════════════════════════════════════════════
  // CONSTRUCTOR — Auto-registers with ContextRegistry
  // ═══════════════════════════════════════════════════════════

  /**
   * Called by subclass constructors. Auto-registers this context
   * with the global ContextRegistry.
   *
   * Subclasses MUST call `super()` in their constructors.
   */
  constructor() {
    // Registration is deferred — subclass must call _registerWithRegistry()
    // after its `id`, `rendererType`, and `canvas` are initialized.
    // This is because abstract getters aren't available in the base constructor.
  }

  /**
   * Register this context with the global registry.
   * Subclasses should call this at the END of their constructor,
   * after `id`, `rendererType`, and `canvas` are all initialized.
   *
   * Also verifies that the subclass implements all required abstract methods
   * at runtime (FORK-27 fix). TypeScript enforces this at compile time for .ts
   * files, but Context.js is plain JavaScript — a missing method would fail
   * silently or with an unhelpful error. This catches it early.
   * @protected
   */
  protected _registerWithRegistry(): void {
    this._verifyAbstractMethods();
    GraphicsContext._registry.register(this);
  }

  /**
   * Verify that the subclass implements all required abstract methods/getters.
   * Called during registration to catch missing implementations early,
   * especially for JavaScript subclasses where TypeScript can't enforce this.
   *
   * Only runs in debug builds (stripped in release via includeStart/includeEnd).
   * @private
   */
  private _verifyAbstractMethods(): void {
    //>>includeStart('debug', pragmas.debug);
    const requiredMethods = [
      "beginFrame",
      "endFrame",
      "clear",
      "resize",
      "draw",
      "getRendererString",
      "createPickId",
      "getObjectByPickColor",
      "readPixels",
      "createViewportQuadCommand",
      "destroy",
    ];

    const requiredGetters = [
      "rendererType",
      "id",
      "canvas",
      "drawingBufferWidth",
      "drawingBufferHeight",
      "uniformState",
      "shaderCache",
      "textureCache",
      "cache",
      "defaultTexture",
      "isDestroyed",
    ];

    const proto = Object.getPrototypeOf(this);
    const className = proto?.constructor?.name ?? "Unknown";

    for (const method of requiredMethods) {
      if (typeof (this as any)[method] !== "function") {
        throw new Error(
          `${className} must implement abstract method '${method}' from GraphicsContext`,
        );
      }
    }

    for (const getter of requiredGetters) {
      // Check both prototype descriptors and own properties
      const descriptor =
        Object.getOwnPropertyDescriptor(proto, getter) ||
        Object.getOwnPropertyDescriptor(this, getter);
      const hasProperty = getter in this;
      if (!descriptor && !hasProperty) {
        throw new Error(
          `${className} must implement abstract getter '${getter}' from GraphicsContext`,
        );
      }
    }
    //>>includeEnd('debug');
  }

  /**
   * Unregister this context from the global registry.
   * Subclasses should call this in their `destroy()` method,
   * BEFORE destroying resources.
   * @protected
   */
  protected _unregisterFromRegistry(): void {
    GraphicsContext._registry.unregister(this.id);
  }

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: IDENTITY & TYPE (must be implemented by subclass)
  // ═══════════════════════════════════════════════════════════

  /**
   * The renderer type for this context.
   * WebGL returns `RendererType.WEBGL`, WebGPU returns `RendererType.WEBGPU`.
   */
  abstract get rendererType(): RendererType;

  /**
   * Unique identifier for this context instance.
   * Used in logging, registry lookups, and multi-context scenarios.
   */
  abstract get id(): string;

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: Convenience Type Getters
  // ═══════════════════════════════════════════════════════════

  /**
   * Whether this is a WebGPU context.
   * Computed from `rendererType` — NOT a stored flag.
   *
   * Note: Scene code should prefer using abstract methods over branching
   * on this property. External/extension code can use it for diagnostics.
   */
  get isWebGPU(): boolean {
    return this.rendererType === RendererType.WEBGPU;
  }

  /**
   * Whether this is a WebGL context.
   * Computed from `rendererType`.
   */
  get isWebGL(): boolean {
    return this.rendererType === RendererType.WEBGL;
  }

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: CANVAS & DIMENSIONS
  // ═══════════════════════════════════════════════════════════

  abstract get canvas(): HTMLCanvasElement;
  abstract get drawingBufferWidth(): number;
  abstract get drawingBufferHeight(): number;

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: CAPABILITIES — Shared GPU Feature Queries
  // ═══════════════════════════════════════════════════════════

  abstract get depthTexture(): boolean;
  abstract get fragmentDepth(): boolean;
  abstract get stencilBuffer(): boolean;
  abstract get stencilBits(): number;
  abstract get msaa(): boolean;
  abstract get colorBufferFloat(): boolean;
  abstract get antialias(): boolean;
  abstract get standardDerivatives(): boolean;
  abstract get elementIndexUint(): boolean;
  abstract get floatBlend(): boolean;
  abstract get instancedArrays(): boolean;

  /**
   * Whether this context uses a 0-to-1 depth range (WebGPU) vs -1-to-1 (WebGL).
   * Scene code should use this instead of checking `rendererType === "webgpu"`.
   * Default: false (WebGL). WebGPU overrides to return true.
   */
  get depthRangeZeroToOne(): boolean {
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: SHARED STATE & CACHES
  // ═══════════════════════════════════════════════════════════

  abstract get uniformState(): any;
  abstract get shaderCache(): any;
  abstract get textureCache(): any;
  abstract get cache(): any;
  abstract get defaultTexture(): any;

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: FRAME LIFECYCLE
  // ═══════════════════════════════════════════════════════════

  abstract beginFrame(): void;
  abstract endFrame(): void;
  abstract clear(clearCommand: any, passState?: any): void;
  abstract resize(): void;

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: DRAWING
  // ═══════════════════════════════════════════════════════════

  abstract draw(drawCommand: any, passState?: any): void;
  abstract getRendererString(): string;

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: BACKEND-AGNOSTIC COMMAND EXECUTION
  // These methods allow Scene.js to dispatch commands without
  // checking isWebGPU. Each backend overrides as needed.
  // Default implementations are the WebGL path (no-ops or pass-through).
  // ═══════════════════════════════════════════════════════════

  /**
   * Execute a single draw command through this context's rendering backend.
   *
   * Scene.js calls this instead of checking `isWebGPU`.
   * - **WebGL (default):** Resolves derived commands (logDepth, HDR, pick,
   *   shadows) and dispatches via `command.execute(context, passState)`.
   * - **WebGPU:** Dispatches WebGPU draw commands through the active
   *   GPURenderPassEncoder. Silently skips non-WebGPU commands.
   *
   * @param command - The draw command to execute
   * @param scene - The scene (for frameState, hdr, debug flags)
   * @param passState - The current render pass state
   * @param debugFramebuffer - Optional debug framebuffer
   */
  executeDrawCommand(
    command: any,
    scene: any,
    passState: any,
    debugFramebuffer?: any,
  ): void {
    // Default (WebGL): simple pass-through dispatch.
    // Context.js inherits this; the full derived-command resolution
    // stays in Scene.js for now (WebGL path unchanged).
    command.execute(this, passState);
  }

  /**
   * Execute compute commands for the current frame.
   *
   * - **WebGL (default):** Executes sun compute + queued compute commands
   *   through ComputeEngine.
   * - **WebGPU:** Executes commands with `isWebGPUComputeCommand` flag;
   *   skips sun compute (handled procedurally).
   *
   * @param computeCommandList - Array of compute commands
   * @param sunComputeCommand - The sun compute command (WebGL only)
   * @param computeEngine - The WebGL ComputeEngine
   */
  executeComputeCommands(
    computeCommandList: any[],
    sunComputeCommand: any,
    computeEngine: any,
  ): void {
    // Default (WebGL): execute sun compute + all queued commands
    if (sunComputeCommand !== undefined && sunComputeCommand !== null) {
      sunComputeCommand.execute(computeEngine);
    }
    for (let i = 0; i < computeCommandList.length; ++i) {
      computeCommandList[i].execute(computeEngine);
    }
  }

  /**
   * Execute shadow map cast commands for the current frame.
   *
   * - **WebGL (default):** Returns false (Scene.js runs its own cast logic).
   * - **WebGPU:** Dispatches through the SHADOW_MAP feature renderer's
   *   `renderCastPass()` and returns true.
   *
   * @param scene - The scene
   * @returns true if the context handled shadow casting, false to fall back
   */
  executeShadowMapCastCommands(scene: any): boolean {
    // Default: not handled by context, Scene.js runs WebGL path
    return false;
  }

  /**
   * Update and clear framebuffers for the current frame.
   *
   * - **WebGL (default):** Returns false (Scene.js runs its own FBO logic).
   * - **WebGPU:** Sets environment state flags, clears via ClearCommand,
   *   returns true.
   *
   * @param scene - The scene
   * @param passState - The current pass state
   * @param clearColor - The background clear color
   * @returns true if the context handled framebuffer setup, false to fall back
   */
  updateAndClearFramebuffers(
    scene: any,
    passState: any,
    clearColor: any,
  ): boolean {
    // Default: not handled by context, Scene.js runs WebGL path
    return false;
  }

  /**
   * Resolve framebuffers after rendering (OIT composite, post-processing).
   *
   * - **WebGL (default):** Returns false (Scene.js runs its own resolve logic).
   * - **WebGPU:** No-op for now (OIT/post-process not yet wired), returns true.
   *
   * @param scene - The scene
   * @param passState - The current pass state
   * @returns true if the context handled resolution, false to fall back
   */
  resolveFramebuffers(scene: any, passState: any): boolean {
    // Default: not handled by context, Scene.js runs WebGL path
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: PICKING
  // ═══════════════════════════════════════════════════════════

  abstract createPickId(object: any): any;
  abstract getObjectByPickColor(pickColor: any): any;

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: PIXEL READBACK
  // ═══════════════════════════════════════════════════════════

  abstract readPixels(readState: any): any;

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: VIEWPORT COMMANDS
  // ═══════════════════════════════════════════════════════════

  abstract createViewportQuadCommand(fragmentShader: any, options?: any): any;

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: DESTROYED STATE
  // ═══════════════════════════════════════════════════════════

  abstract get isDestroyed(): boolean;

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: RESOURCE LIFECYCLE
  // ═══════════════════════════════════════════════════════════

  abstract destroy(): void;

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: RENDER PASS MANAGEMENT
  // Default implementations are no-ops (WebGL doesn't have explicit passes).
  // WebGPU overrides these.
  // ═══════════════════════════════════════════════════════════

  /**
   * End the currently active render pass.
   * WebGL: no-op (no explicit render passes)
   * WebGPU: ends the current GPURenderPassEncoder
   */
  endCurrentRenderPass(): void {
    // No-op for WebGL. WebGPU overrides.
  }

  /**
   * Begin a new render pass.
   * WebGL: no-op
   * WebGPU: starts a new GPURenderPassEncoder
   */
  beginRenderPass(descriptor?: any): any {
    // No-op for WebGL. WebGPU overrides.
    return undefined;
  }

  /**
   * Resume the default canvas render pass after a custom pass.
   * WebGL: no-op
   * WebGPU: starts a new render pass targeting the canvas with loadOp: "load"
   */
  resumeDefaultRenderPass(): any {
    // No-op for WebGL. WebGPU overrides.
    return undefined;
  }

  /**
   * Whether a render pass is currently active.
   * WebGL: conceptually always true
   * WebGPU: depends on encoder state
   */
  get hasActiveRenderPass(): boolean {
    return true; // WebGL always has one. WebGPU overrides.
  }

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: RESOURCE FACTORY METHODS (optional overrides)
  // Default implementations throw — subclasses implement as needed.
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a texture using the context's native texture type.
   * @param options - Texture creation options
   * @returns A backend-native texture object
   */
  createTexture(options: any): any {
    throw new Error(
      `${this._logPrefix()} createTexture not implemented for ${this.rendererType}`,
    );
  }

  /**
   * Create a GPU buffer using the context's native buffer type.
   * @param options - Buffer creation options
   * @returns A backend-native buffer object
   */
  createBuffer(options: any): any {
    throw new Error(
      `${this._logPrefix()} createBuffer not implemented for ${this.rendererType}`,
    );
  }

  /**
   * Build a native draw command from an abstract RenderCommand.
   * @param renderCommand - The abstract RenderCommand
   * @returns A backend-native draw command
   */
  buildRenderCommand(renderCommand: any): any {
    throw new Error(
      `${this._logPrefix()} buildRenderCommand not implemented for ${this.rendererType}`,
    );
  }

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: CONTEXT-AWARE LOGGING
  // All messages automatically include [CesiumJS:type:shortId]
  // ═══════════════════════════════════════════════════════════

  /**
   * Log a message with context-aware prefix.
   * Automatically includes renderer type and context ID.
   *
   * @param level - Log level: 'info', 'warn', or 'error'
   * @param message - The message to log
   *
   * @example
   * context.log('error', 'Pipeline creation failed for terrain shader');
   * // Output: [CesiumJS:webgpu:ctx-a3f7] Pipeline creation failed for terrain shader
   */
  log(level: "info" | "warn" | "error", message: string): void {
    const prefix = this._logPrefix();
    switch (level) {
      case "info":
        console.log(`${prefix} ${message}`);
        break;
      case "warn":
        console.warn(`${prefix} ${message}`);
        break;
      case "error":
        console.error(`${prefix} ${message}`);
        break;
    }
  }

  /**
   * Generate the log prefix string for this context.
   * @private
   */
  private _logPrefix(): string {
    let shortId: string;
    try {
      shortId = this.id ? this.id.substring(0, 8) : "unknown";
    } catch {
      shortId = "init";
    }

    let type: string;
    try {
      type = this.rendererType ?? "unknown";
    } catch {
      type = "unknown";
    }

    return `[CesiumJS:${type}:${shortId}]`;
  }

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: FEATURE RENDERER REGISTRY (Phase C)
  //
  // Scene code calls context.getFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION)
  // instead of importing WebGPUBillboardRenderer directly.
  // Uses array-indexed lookups with FeatureRendererKey enum for O(1) access.
  // ═══════════════════════════════════════════════════════════

  /**
   * Register a feature renderer for this context.
   * Called by each backend during initialization.
   *
   * @param key - A {@link FeatureRendererKey} numeric enum value
   * @param renderer - The backend-specific feature renderer implementation
   *
   * @example
   * import FeatureRendererKey from "./FeatureRendererKey.js";
   * // In WebGPUContext initialization:
   * this.registerFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION, renderer);
   */
  registerFeatureRenderer(key: number, renderer: FeatureRenderer): void {
    this._featureRenderers[key] = renderer;
  }

  /**
   * Get a feature renderer by key.
   * Returns undefined if no renderer is registered for the given key.
   * Uses direct array-index access — O(1) with no hashing overhead.
   *
   * @param key - A {@link FeatureRendererKey} numeric enum value
   * @returns The registered feature renderer, or undefined
   *
   * @example
   * import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
   * const fr = context.getFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION);
   * if (fr) { fr.update(collection, frameState); }
   */
  getFeatureRenderer(key: number): FeatureRenderer | undefined {
    return this._featureRenderers[key];
  }

  /**
   * Check if a feature renderer is registered.
   *
   * @param key - A {@link FeatureRendererKey} numeric enum value
   * @returns True if a renderer is registered for this feature
   */
  hasFeatureRenderer(key: number): boolean {
    return this._featureRenderers[key] !== undefined;
  }

  /**
   * Get count of registered feature renderers.
   * Useful for diagnostics and debugging.
   */
  get registeredFeatureCount(): number {
    let count = 0;
    for (let i = 0; i < this._featureRenderers.length; i++) {
      if (this._featureRenderers[i] !== undefined) {
        count++;
      }
    }
    return count;
  }

  /**
   * Destroy all registered feature renderers.
   * Called during context destruction.
   * @protected
   */
  protected _destroyFeatureRenderers(): void {
    const renderers = this._featureRenderers;
    for (let i = 0; i < renderers.length; i++) {
      const renderer = renderers[i];
      if (renderer !== undefined) {
        try {
          if (renderer.destroy) {
            renderer.destroy();
          }
        } catch (e) {
          this.log("error", `Failed to destroy feature renderer [${i}]: ${e}`);
        }
        renderers[i] = undefined;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// TYPE GUARD
// ═══════════════════════════════════════════════════════════

/**
 * Type guard to check if an object is a GraphicsContext.
 * Works with both instanceof checks and duck-typing for JS interop.
 *
 * @param obj - Object to check
 * @returns True if the object is or behaves like a GraphicsContext
 */
export function isGraphicsContext(obj: any): obj is GraphicsContext {
  if (obj instanceof GraphicsContext) {
    return true;
  }
  // Duck-type fallback for JS interop
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
