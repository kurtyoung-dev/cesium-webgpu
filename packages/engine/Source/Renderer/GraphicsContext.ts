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
import Check from "../Core/Check.js";
import Color from "../Core/Color.js";
import PickId from "./PickId.js";

// ═══════════════════════════════════════════════════════════
// FEATURE RENDERER INTERFACES (Phase C — Sub-typed)
//
// Feature renderers are split into sub-types based on their
// actual API contract. This replaces the previous catch-all
// interface that had optional `update?()` with variadic args
// and `[key: string]: any` (which defeated type safety).
//
// Sub-types:
//   CollectionRenderer   — 21 of 28 renderers (most common)
//   PrimitiveCommandRenderer — 1 of 28 (PRIMITIVE)
//   SystemRenderer       — 6 of 28 (specialized entry points)
//
// See: FR-UPDATE tech debt item in UPSTREAM_ISSUES_AND_TECH_DEBT.md
// ═══════════════════════════════════════════════════════════

/**
 * Base interface for all backend-specific feature renderers.
 *
 * Scene code calls `context.getFeatureRenderer(FeatureRendererKey.XXX)`
 * instead of importing from `Renderer/WebGPU/` directly. Each backend
 * registers its own implementation of each feature renderer.
 *
 * Feature renderers handle:
 * - GPU resource creation (buffers, pipelines, textures)
 * - Draw command emission
 * - Backend-specific optimizations
 *
 * They do NOT handle:
 * - Entity management, dirty tracking (shared scene logic)
 * - Visibility checks, mode updates (shared pre-branch logic)
 *
 * Use the specific sub-type interfaces for type-safe access:
 * - {@link CollectionRenderer} for renderers with `update()`
 * - {@link PrimitiveCommandRenderer} for the PRIMITIVE command factory
 * - {@link SystemRenderer} for specialized entry points
 */
export interface FeatureRenderer {
  /**
   * Destroy GPU resources owned by this renderer.
   * @param collection - The scene collection being destroyed
   */
  destroy?(collection?: unknown): void;

  /**
   * Optional: name for debugging/diagnostics.
   */
  readonly name?: string;

  // Common lifecycle methods — optional on the base interface because
  // different renderer types implement different subsets. Callers check
  // existence before calling (duck-typed dispatch).
  update?(...args: unknown[]): void;
  execute?(...args: unknown[]): void;
  render?(...args: unknown[]): void;
  composite?(...args: unknown[]): void;
}

/**
 * Feature renderer with a per-frame `update()` entry point.
 * This is the most common pattern (21 of 28 renderers).
 *
 * Used by: Collections (Billboard, Point, Polyline, Cloud),
 * Environment (Sun, Moon, SkyAtmosphere, CubeMapPanorama),
 * Model, Advanced features (Ellipsoid, GaussianSplat, PointCloud,
 * Voxel, InvertClassification), IBL/Lighting (BrdfLut,
 * ImageBasedLighting, DynamicEnvironmentMap), Clipping
 * (Planes, Polygons), and Post-Processing.
 *
 * Scene code pattern:
 * ```javascript
 * const fr = context.getFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION);
 * if (fr) { fr.update(this, frameState, commandList); return; }
 * ```
 */
export interface CollectionRenderer extends FeatureRenderer {
  /**
   * Update and render this feature for the current frame.
   * @param collection - The scene object (BillboardCollection, Sun, etc.)
   * @param frameState - Current frame state (or options object)
   * @param args - Additional arguments (commandList, etc.)
   */
  update(collection: any, frameState: any, ...args: any[]): any;
}

/**
 * Feature renderer for the Primitive command factory.
 * Creates and updates WebGPU draw commands for Primitive geometry.
 *
 * Used by: PRIMITIVE (1 of 28 renderers).
 *
 * Scene code pattern:
 * ```javascript
 * const fr = context.getFeatureRenderer(FeatureRendererKey.PRIMITIVE);
 * if (fr) { fr.createCommands(primitive, appearance, ...); }
 * ```
 */
export interface PrimitiveCommandRenderer extends FeatureRenderer {
  /**
   * Create draw commands for a primitive with per-instance-color appearance.
   */
  createCommands(...args: any[]): void;

  /**
   * Update per-frame uniforms on existing commands.
   */
  updateCommandUniforms(...args: any[]): void;

  /**
   * Create draw commands for a primitive with material appearance.
   */
  createMaterialCommands?(...args: any[]): void;

  /**
   * Update per-frame uniforms on material commands.
   */
  updateMaterialCommandUniforms?(...args: any[]): void;

  /**
   * Update per-frame uniforms on pick commands.
   */
  updatePickCommandUniforms?(...args: any[]): void;
}

/**
 * Feature renderer with specialized entry points.
 * Used for system-level renderers that don't follow the
 * simple `update()` pattern.
 *
 * Used by: FOG (getParameters), SHADOW_MAP (init, renderCastPass),
 * GROUND_PRIMITIVE (destroy only), GLOBE_SURFACE (RendererClass),
 * GLOBE_TRANSLUCENCY (updateDerivedCommands), SCENE_RENDERER
 * (RendererClass, initPrimitiveShaders, initCollectionShaders).
 *
 * The index signature allows type-safe access to specialized methods.
 */
export interface SystemRenderer extends FeatureRenderer {
  /** Allow specialized entry points */
  [key: string]: any;
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

  /**
   * WebGPU feature level: "core" (default) or "compatibility".
   * "compatibility" runs WebGPU on WebGL2 hardware via restricted feature set.
   * Only relevant when renderer is "webgpu" or "webgpu-compat".
   */
  featureLevel?: "core" | "compatibility";
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
  /**
   * Per-key lazy loader: an async function that imports and registers
   * the corresponding feature renderer the first time it's needed.
   * Used for advanced renderers (Voxel, GaussianSplat, PointCloud, etc.)
   * that aren't part of the basic globe view — keeping them out of the
   * eager-imported `WebGPUFeatureRenderers` chunk lets esbuild split
   * them into separate dynamic chunks that only download on demand.
   *
   * Loaders are stored alongside the eager registry. The first call to
   * `getFeatureRenderer(key)` for a key with a pending loader fires the
   * loader and replaces the slot with the resolved renderer once the
   * dynamic import settles. The first call returns undefined (the
   * caller's WebGL fallback runs); the next call after the import
   * settles returns the registered FR.
   */
  private _featureRendererLoaders: ((() => Promise<void>) | undefined)[] =
    new Array(0);
  private _featureRendererLoadingFlags: (boolean | undefined)[] = new Array(0);

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
      // createPickId and getObjectByPickColor are concrete on GraphicsContext
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
  // CONCRETE: COMPUTE SHADER CAPABILITIES
  //
  // These properties advertise the compute capabilities of this context.
  // Scene code should query these before dispatching compute work.
  //
  // Compute tiers:
  //   Tier 0 (GPGPU):  Render-to-texture "compute" via fragment shaders (WebGL 1/2)
  //   Tier 1 (Compute): Real GPU compute shaders (WebGPU, future WebGL 2.0 extension)
  //   Tier 2 (Advanced): Indirect dispatch, shared memory, atomics (WebGPU)
  //
  // WebGL 2.0 is expected to gain compute shader support via a future extension
  // (similar to GL_ARB_compute_shader / GL ES 3.1). These properties provide the
  // scaffolding so that when the extension ships, only Context.js needs updating.
  // ═══════════════════════════════════════════════════════════

  /**
   * Whether this context supports real GPU compute shaders (not GPGPU workarounds).
   *
   * - **WebGL 2.0 (current):** `false` — no compute extension available yet.
   *   When `WEBGL_compute` or equivalent extension ships, `Context.js` will
   *   override this to return `true` after detecting the extension.
   * - **WebGPU:** `true` — native compute shader support.
   *
   * Scene code should check this before dispatching compute work:
   * ```javascript
   * if (context.supportsComputeShaders) {
   *   // Use real GPU compute (WebGPU or future WebGL 2.0 compute)
   * } else if (context.supportsGPGPU) {
   *   // Fall back to render-to-texture GPGPU
   * } else {
   *   // CPU fallback
   * }
   * ```
   */
  get supportsComputeShaders(): boolean {
    return false;
  }

  /**
   * Whether this context supports GPGPU (render-to-texture) compute.
   * This is the legacy compute method using fragment shaders + viewport quads.
   *
   * - **WebGL:** `true` — uses `ComputeEngine` + `ComputeCommand` (fragment shader GPGPU).
   * - **WebGPU:** `true` — can do GPGPU, but prefer real compute shaders.
   *
   * Default: true (all contexts support render-to-texture).
   */
  get supportsGPGPU(): boolean {
    return true;
  }

  /**
   * Whether this context supports indirect compute dispatch.
   * Indirect dispatch reads workgroup counts from a GPU buffer,
   * enabling fully GPU-driven pipelines.
   *
   * - **WebGL:** `false` — no indirect dispatch support.
   * - **WebGPU:** `true` — `dispatchWorkgroupsIndirect()` on `GPUComputePassEncoder`.
   */
  get supportsIndirectCompute(): boolean {
    return false;
  }

  /**
   * Whether this context supports shader storage buffers (SSBOs).
   * Storage buffers allow compute/vertex/fragment shaders to read/write
   * large structured data beyond the size limits of uniform buffers.
   *
   * - **WebGL 2.0 (current):** `false` — no SSBO extension yet.
   *   Future `WEBGL_shader_storage_buffer` extension would enable this.
   * - **WebGPU:** `true` — native storage buffer support via `storage` buffer type.
   */
  get supportsStorageBuffers(): boolean {
    return false;
  }

  /**
   * Maximum number of workgroups per dispatch dimension (X, Y, or Z).
   * Returns 0 if compute shaders are not supported.
   *
   * - **WebGL:** 0 (no compute support yet)
   * - **WebGPU:** Device limit `maxComputeWorkgroupsPerDimension` (typically 65535)
   */
  get maxComputeWorkgroupsPerDimension(): number {
    return 0;
  }

  /**
   * Maximum workgroup size (total invocations per workgroup).
   * Returns 0 if compute shaders are not supported.
   *
   * - **WebGL:** 0 (no compute support yet)
   * - **WebGPU:** Device limit `maxComputeInvocationsPerWorkgroup` (typically 256)
   */
  get maxComputeInvocationsPerWorkgroup(): number {
    return 0;
  }

  /**
   * Maximum size of shared (workgroup) memory in bytes.
   * Returns 0 if compute shaders are not supported.
   *
   * - **WebGL:** 0 (no compute support yet)
   * - **WebGPU:** Device limit `maxComputeWorkgroupStorageSize` (typically 16384)
   */
  get maxComputeWorkgroupStorageSize(): number {
    return 0;
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
  /**
   * Creates a backend-appropriate pick framebuffer.
   * WebGL: returns null (View.js falls back to PickFramebuffer).
   * WebGPU: returns a WebGPUPickFramebuffer instance.
   * @returns A pick framebuffer or null if the default (WebGL) should be used.
   */
  createPickFramebuffer(): any {
    return null;
  }

  resolveFramebuffers(scene: any, passState: any): boolean {
    // Default: not handled by context, Scene.js runs WebGL path
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: PICKING — Shared Pick ID Management
  //
  // Pick ID allocation is identical across both backends: a monotonically
  // incrementing uint32 counter maps to RGBA colors via Color.fromRgba().
  // The logic lives here (not in subclasses) to eliminate duplication.
  // Previously duplicated in Context.js, WebGPUContext.ts, AND
  // WebGPUPickManager.ts (three copies of the same code).
  //
  // Both backends inherit these methods. No override needed.
  // ═══════════════════════════════════════════════════════════

  /**
   * Map from 32-bit pick color key → associated object.
   * Shared across both WebGL and WebGPU backends.
   * @protected
   */
  protected _pickObjects: Map<number, any> = new Map();

  /**
   * Monotonically incrementing counter for pick color allocation.
   * Uses Uint32Array for overflow-safe incrementing.
   * @protected
   */
  protected _nextPickColor: Uint32Array = new Uint32Array(1);

  /**
   * Create a unique pick ID for an object.
   *
   * Allocates a unique 32-bit RGBA color and associates it with the given
   * object. During pick rendering, fragments output this color. Reading
   * back the pixel and calling {@link getObjectByPickColor} returns the object.
   *
   * @param object - The object to associate with this pick ID
   * @returns A {@link PickId} with `key`, `color`, `normalizedRgba`, and `destroy()`
   */
  createPickId(object: any): any {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("object", object);
    //>>includeEnd('debug');

    // Increment with overflow wrapping (Uint32Array handles this)
    this._nextPickColor[0]++;
    const key = this._nextPickColor[0];
    const color = (Color as any).fromRgba(key);

    this._pickObjects.set(key, object);
    return new (PickId as any)(this._pickObjects, key, color);
  }

  /**
   * Get the object associated with a pick color.
   *
   * Accepts two calling conventions:
   * - **uint32** (WebGL path): A 32-bit RGBA value from `Color.byteToRgba(r,g,b,a)`
   * - **object** (WebGPU path): An `{red, green, blue}` object with 0-255 byte values,
   *   which is reconstructed to a key via little-endian RGB encoding.
   *
   * @param pickColor - The pick color key (uint32 or {red,green,blue} object)
   * @returns The object associated with the pick color, or undefined
   */
  getObjectByPickColor(pickColor: any): any {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("pickColor", pickColor);
    //>>includeEnd('debug');

    if (typeof pickColor === "object" && pickColor !== null) {
      // WebGPU path: reconstruct key from RGB bytes (little-endian)
      const key =
        (pickColor.red & 0xff) |
        ((pickColor.green & 0xff) << 8) |
        ((pickColor.blue & 0xff) << 16);
      return this._pickObjects.get(key);
    }
    // WebGL path: pickColor is already the uint32 key
    return this._pickObjects.get(pickColor);
  }

  /**
   * Number of currently registered pick objects.
   * Useful for diagnostics and debugging.
   */
  get pickObjectCount(): number {
    return this._pickObjects.size;
  }

  /**
   * Clear all pick registrations and reset the color counter.
   * Useful during device loss recovery or context reset.
   */
  clearPickObjects(): void {
    this._pickObjects.clear();
    this._nextPickColor[0] = 0;
  }

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
   * The active GPU command encoder, or null on backends without explicit
   * encoders (WebGL). Scene code treats this as an opaque handle — it's
   * only passed through to feature renderers that know the concrete type.
   */
  get currentCommandEncoder(): unknown {
    return null;
  }

  /**
   * A depth-only texture view suitable for sampling in compute shaders,
   * or null on backends without explicit depth textures (WebGL).
   * Scene code treats this as an opaque handle — only feature renderers
   * (Hi-Z occlusion) use the concrete view.
   */
  get depthOnlyTextureView(): unknown {
    return null;
  }

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
  // CONCRETE: DEBUG / DIAGNOSTIC SURFACE
  // Backend-specific introspection routed through the abstract base
  // so Scene code can call this without violating the "no
  // Renderer/WebGPU imports from Scene" rule. Default returns an
  // empty object; backends override to expose what they own.
  // ═══════════════════════════════════════════════════════════

  /**
   * Phase 6 debug surface — returns a snapshot of backend-specific
   * diagnostic state (bundle cache stats, fog froxel state, GPU memory
   * usage, etc.). Default returns an empty object. Backends override
   * to populate the fields they care about. Pure read; safe to call
   * any time, including from `Scene.getDebugSnapshot()`.
   *
   * Stable shape contract: callers should treat any returned field as
   * optional (`stats.bundleManager?.cacheSize`) since the WebGL
   * backend will leave most fields unset.
   */
  getRendererStatistics(): Record<string, unknown> {
    return {};
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
   * Accepts any of the three feature renderer sub-types:
   * - {@link CollectionRenderer} — renderers with `update()` (most common)
   * - {@link PrimitiveCommandRenderer} — the PRIMITIVE command factory
   * - {@link SystemRenderer} — renderers with specialized entry points
   *
   * @param key - A {@link FeatureRendererKey} numeric enum value
   * @param renderer - The backend-specific feature renderer implementation
   *
   * @example
   * import FeatureRendererKey from "./FeatureRendererKey.js";
   * // In WebGPUContext initialization:
   * this.registerFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION, renderer);
   */
  registerFeatureRenderer(
    key: number,
    renderer: CollectionRenderer | PrimitiveCommandRenderer | SystemRenderer,
  ): void {
    this._featureRenderers[key] = renderer;
    // Clear any pending lazy loader for this key — the renderer is
    // now available, no need to lazy-import.
    this._featureRendererLoaders[key] = undefined;
    this._featureRendererLoadingFlags[key] = undefined;
  }

  /**
   * Register an async loader that resolves the renderer for `key` on
   * first access. Used for advanced renderers that should not pull their
   * implementation modules into the main bundle. The loader is invoked
   * exactly once (subsequent calls during the in-flight import are
   * coalesced) and is expected to call `registerFeatureRenderer(key, …)`
   * itself once the dynamic import settles.
   *
   * Until the loader resolves, `getFeatureRenderer(key)` returns
   * `undefined` so callers fall back to their WebGL path. Once the
   * loader registers the renderer, all subsequent calls return it.
   *
   * @param key A FeatureRendererKey numeric enum value
   * @param loader A function returning a Promise that registers the FR
   */
  registerFeatureRendererLoader(
    key: number,
    loader: () => Promise<void>,
  ): void {
    // Don't overwrite an already-resolved entry — the renderer wins.
    if (this._featureRenderers[key] !== undefined) return;
    this._featureRendererLoaders[key] = loader;
  }

  /**
   * Get a feature renderer by key.
   * Returns undefined if no renderer is registered for the given key.
   * Uses direct array-index access — O(1) with no hashing overhead.
   *
   * The returned value is the base {@link FeatureRenderer} type.
   * Callers that need sub-type methods should narrow the type:
   * - `.js` scene files: just call methods directly (no TS checking)
   * - `.ts` files: cast to the appropriate sub-type, e.g.:
   *   `const fr = context.getFeatureRenderer(key) as CollectionRenderer;`
   *
   * @param key - A {@link FeatureRendererKey} numeric enum value
   * @returns The registered feature renderer, or undefined
   *
   * @example
   * import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
   * const fr = context.getFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION);
   * if (fr) { (fr as CollectionRenderer).update(collection, frameState); }
   */
  getFeatureRenderer(key: number): FeatureRenderer | undefined {
    const existing = this._featureRenderers[key];
    if (existing !== undefined) return existing;

    // No registered FR — check for a pending lazy loader. The first call
    // for a lazy key fires the import (fire-and-forget); the call returns
    // undefined so the caller falls back to its WebGL path. After the
    // import settles and `registerFeatureRenderer` is called from the
    // loader, subsequent `getFeatureRenderer` calls return the FR.
    //
    // The loading-flag guard coalesces concurrent calls so the same
    // dynamic import isn't kicked off twice if multiple primitives ask
    // on the same frame.
    const loader = this._featureRendererLoaders[key];
    if (loader && !this._featureRendererLoadingFlags[key]) {
      this._featureRendererLoadingFlags[key] = true;
      // Fire-and-forget — errors are swallowed but logged so the WebGL
      // fallback can continue rendering. The loader is responsible for
      // calling registerFeatureRenderer when done.
      loader().catch((err) => {
        this._featureRendererLoadingFlags[key] = false;
        this.log(
          "warn",
          `Lazy feature renderer load failed for key ${key}: ${err?.message ?? err}`,
        );
      });
    }
    return undefined;
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
    // Feature renderer destroy() functions are designed for scene-side cleanup
    // and expect their owning scene object as the first argument (e.g.,
    // destroyBillboardResources(collection)). During context destruction the
    // GPU device is being torn down, which releases all GPU resources
    // automatically. We just null out references here.
    const renderers = this._featureRenderers;
    for (let i = 0; i < renderers.length; i++) {
      renderers[i] = undefined;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// TYPE GUARDS
// ═══════════════════════════════════════════════════════════

/**
 * Type guard to check if a feature renderer is a {@link CollectionRenderer}.
 * Returns true if the renderer has a callable `update` method.
 *
 * @param renderer - The feature renderer to check
 * @returns True if the renderer has an `update()` method
 *
 * @example
 * const fr = context.getFeatureRenderer(key);
 * if (isCollectionRenderer(fr)) {
 *   fr.update(collection, frameState); // TypeScript knows `update` exists
 * }
 */
export function isCollectionRenderer(
  renderer: FeatureRenderer | undefined,
): renderer is CollectionRenderer {
  return (
    renderer !== undefined &&
    typeof (renderer as CollectionRenderer).update === "function"
  );
}

/**
 * Type guard to check if a feature renderer is a {@link PrimitiveCommandRenderer}.
 * Returns true if the renderer has `createCommands` and `updateCommandUniforms`.
 *
 * @param renderer - The feature renderer to check
 * @returns True if the renderer has command factory methods
 */
export function isPrimitiveCommandRenderer(
  renderer: FeatureRenderer | undefined,
): renderer is PrimitiveCommandRenderer {
  return (
    renderer !== undefined &&
    typeof (renderer as PrimitiveCommandRenderer).createCommands ===
      "function" &&
    typeof (renderer as PrimitiveCommandRenderer).updateCommandUniforms ===
      "function"
  );
}

/**
 * Type guard to check if a feature renderer is a {@link SystemRenderer}.
 * Returns true for any renderer that is NOT a CollectionRenderer or
 * PrimitiveCommandRenderer — i.e., it has specialized entry points.
 *
 * @param renderer - The feature renderer to check
 * @returns True if the renderer is a system renderer
 */
export function isSystemRenderer(
  renderer: FeatureRenderer | undefined,
): renderer is SystemRenderer {
  return (
    renderer !== undefined &&
    !isCollectionRenderer(renderer) &&
    !isPrimitiveCommandRenderer(renderer)
  );
}

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
