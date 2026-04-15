/**
 * @module WebGPUContext
 *
 * WebGPU implementation of the GraphicsContext interface.
 * Provides a WebGPU-based rendering backend for CesiumJS with modern GPU features.
 *
 * @example
 * const context = await WebGPUContext.create(canvas, options);
 * context.beginFrame();
 * // ... render commands ...
 * context.endFrame();
 */

/// <reference types="@webgpu/types" />

import RendererType from "../RendererType.js";
import {
  GraphicsContext,
  GraphicsContextOptions,
  DebugStatsObject,
  DebugStatsValue,
} from "../GraphicsContext.js";
import DeveloperError from "../../Core/DeveloperError.js";
import defined from "../../Core/defined.js";
import RuntimeError from "../../Core/RuntimeError.js";
import createGuid from "../../Core/createGuid.js";
import Color from "../../Core/Color.js";
import UniformState from "../UniformState.js";
import ContextLimits from "../ContextLimits.js";
import PassState from "../PassState.js";
import RenderState from "../RenderState.js";
import ShaderCache from "../ShaderCache.js";
import TextureCache from "../TextureCache.js";
import { WebGPUShaderCache } from "./WebGPUShaderCache.js";
import { WebGPURenderPipelineCache } from "./WebGPURenderPipelineCache.js";
import { WebGPUBuffer } from "./WebGPUBuffer.js";
import { WebGPUTexture } from "./WebGPUTexture.js";
import { WebGPUMipmapGenerator } from "./WebGPUMipmapGenerator.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { WebGPUPickFramebuffer } from "./WebGPUPickFramebuffer.js";
import {
  WebGPUViewportQuad,
  type ViewportQuadCommand,
  type ViewportQuadCommandOptions,
} from "./WebGPUViewportQuad.js";
import {
  createWebGLCompatibilityStub,
  type WebGLStubState,
} from "./WebGLCompatibilityStub.js";
import type {
  StubTextureWrapper,
  StubFramebuffer,
  StubRenderbuffer,
  StubAttachment,
} from "./Stubs/WebGLStubTypes.js";
import {
  webglToWebGPUBlendFactor,
  webglToWebGPUBlendOp,
  webglToWebGPUCompareFunction,
} from "./WebGLStateConverters.js";
import {
  DeviceLossState,
  WebGPUDeviceLossRecovery,
  type DeviceLostCallback,
  type DeviceLossRecoveryHost,
} from "./WebGPUDeviceLossRecovery.js";
// FORK-2 fix: WebGPUResourceManager and WebGPUPickManager were unused imports — removed.
// They can be re-added when their intended usage is implemented.
import { WebGPURenderBundleManager } from "./WebGPURenderBundleManager.js";
import { WebGPUTimestampProfiler } from "./WebGPUTimestampProfiler.js";
import { WebGPUStorageBufferPool } from "./WebGPUStorageBufferPool.js";
import { WebGPUIndirectDrawManager } from "./WebGPUIndirectDrawManager.js";
import { WebGPUCSMRenderer } from "./WebGPUCSMRenderer.js";
import { WebGPUBufferMapper } from "./WebGPUBufferMapper.js";
import { WebGPURingBufferAllocator } from "./WebGPURingBufferAllocator.js";
import {
  createDefaultTextures,
  copyTexture as copyTextureUtil,
  copyTextureRegion as copyTextureRegionUtil,
  createTextureFromImage as createTextureFromImageUtil,
  createPixelReadbackPBO,
  type DefaultTextures,
} from "./WebGPUTextureUtilities.js";
import { registerWebGPUFeatureRenderers } from "./WebGPUFeatureRenderers.js";
import FeatureRendererKey from "../FeatureRendererKey.js";
import {
  WebGPUPerformanceManager,
  type PerformanceConfig,
} from "./WebGPUPerformanceManager.js";
import { jsModule } from "./webgpuTypeHelpers.js";

/** Type-shape for the JS-only RenderState.fromCache() static. */
interface RenderStateStatics {
  fromCache: (renderState?: CesiumOpaqueObject) => CesiumOpaqueRenderState;
}

// ViewportQuadCommand and ViewportQuadCommandOptions are imported from
// WebGPUViewportQuad so the single source of truth lives next to the
// implementation. See below.

/** Return type for getPipelineState(). */
interface WebGPUPipelineStateSnapshot {
  depthStencil?: {
    format: GPUTextureFormat;
    depthWriteEnabled: boolean;
    depthCompare: GPUCompareFunction;
  };
  blend?: {
    color: {
      srcFactor: GPUBlendFactor;
      dstFactor: GPUBlendFactor;
      operation: GPUBlendOperation;
    };
    alpha: {
      srcFactor: GPUBlendFactor;
      dstFactor: GPUBlendFactor;
      operation: GPUBlendOperation;
    };
  };
  primitive: {
    cullMode: GPUCullMode;
    frontFace: GPUFrontFace;
  };
  colorWriteMask: number;
}

/** Return type for readPixelsToPBO(). */
interface PixelReadbackPBO {
  buffer: GPUBuffer;
  width: number;
  height: number;
  bytesPerRow: number;
  mapAsync: () => Promise<Uint8Array>;
  getBufferData: (dst: Uint8Array | Uint16Array | Float32Array) => void;
  destroy: () => void;
}

/** Return type for getStatistics(). */
interface WebGPUFrameStatistics {
  frameCount: number;
  drawCallCount: number;
  triangleCount: number;
  samplerCacheSize: number;
  bindGroupLayoutCacheSize: number;
  uniformBufferPoolSize: number;
}

// (ViewportQuadCommandOptions shape lives in WebGPUViewportQuad.ts and is
// imported at the top of the file.)

/** Shader source that can be a string or an object with _wgslCode. */
type ShaderSource =
  | string
  | { _wgslCode?: string; sources?: string[]; defines?: string[] };

/** Minimal interface for the GPU culler (lazy-loaded). */
interface GPUCullerInstance {
  initialized: boolean;
  destroy(): void;
  uploadBoundingSpheres(data: Float32Array): void;
  uploadFrustumPlanes(data: Float32Array): void;
  dispatch(encoder: GPUCommandEncoder, count: number, mode: number): void;
  prepareReadback(encoder: GPUCommandEncoder, count: number): void;
  readResults(count: number): Promise<GPUCullResults>;
  initialize(code: string): Promise<void>;
}

/** Minimal ClearCommand shape accessed by the clear() method. */
interface CesiumClearCommand {
  color?: CesiumColor | false;
  depth?: number | false;
  stencil?: number | false;
  framebuffer?: CesiumOpaqueFramebuffer;
  execute?: (
    context: CesiumGraphicsContext,
    passState?: CesiumPassState,
  ) => void;
}

/**
 * Type-shape for the JS-only ContextLimits module's writable internal
 * fields. Cesium intentionally exposes ContextLimits as a const-like
 * object whose `_xxx` fields are written by the active context during
 * device initialization. The TypeScript compiler can't see those fields
 * because ContextLimits.js declares them via Object.defineProperties.
 */
interface ContextLimitsInternals {
  _maximumTextureSize: number;
  _maximumCubeMapSize: number;
  _maximumRenderbufferSize: number;
  _maximumTextureImageUnits: number;
  _maximumVertexTextureImageUnits: number;
  _maximumCombinedTextureImageUnits: number;
  _maximumVertexAttributes: number;
  _maximumViewportWidth: number;
  _maximumViewportHeight: number;
  _maximumFragmentUniformVectors: number;
  _maximumVaryingVectors: number;
  _maximumVertexUniformVectors: number;
  _minimumAliasedLineWidth: number;
  _maximumAliasedLineWidth: number;
  _minimumAliasedPointSize: number;
  _maximumAliasedPointSize: number;
  _maximumTextureFilterAnisotropy: number;
  _maximumDrawBuffers: number;
  _maximumColorAttachments: number;
  _maximumSamples: number;
  _highpFloatSupported: boolean;
  _highpIntSupported: boolean;
}

// Re-export types that external code may depend on
export { DeviceLossState, type DeviceLostCallback };

/**
 * WebGPU-specific context options
 */
export interface WebGPUContextOptions extends GraphicsContextOptions {
  /**
   * Preferred GPU power preference
   */
  powerPreference?: GPUPowerPreference;

  /**
   * WebGPU feature level: "core" (default) or "compatibility".
   * Compatibility mode runs on WebGL2 hardware via a restricted WebGPU feature set.
   * This enables WebGPU API benefits (modern shader compilation, pipeline caching)
   * on hardware that doesn't support full WebGPU.
   */
  featureLevel?: "core" | "compatibility";

  /**
   * Required features for the device
   */
  requiredFeatures?: GPUFeatureName[];

  /**
   * Required limits for the device
   */
  requiredLimits?: Record<string, number>;
}

/**
 * WebGPU implementation of GraphicsContext.
 * Manages the WebGPU device, adapter, and rendering pipeline.
 */
export class WebGPUContext extends GraphicsContext {
  // Public underscore fields: these have public getters but renderers also
  // access the fields directly for performance. Marking public is honest
  // about the actual access pattern across the WebGPU renderer module.
  public _canvas: HTMLCanvasElement;
  private _adapter: GPUAdapter | null = null;
  public _device: GPUDevice | null = null;
  private _context: GPUCanvasContext | null = null;
  public _presentationFormat: GPUTextureFormat = "bgra8unorm";
  private _depthFormat: GPUTextureFormat = "depth24plus-stencil8";
  private _isDestroyed: boolean = false;
  private _options: WebGPUContextOptions;

  // Frame state for command recording — public for cross-renderer access
  public _currentCommandEncoder: GPUCommandEncoder | null = null;
  public _currentRenderPassEncoder: GPURenderPassEncoder | null = null;
  private _currentTextureView: GPUTextureView | null = null;
  private _depthTexture: GPUTexture | null = null;
  private _depthTextureView: GPUTextureView | null = null;
  private _depthOnlyTextureView: GPUTextureView | null = null;
  private _uniformState: CesiumUniformState;

  // WebGL compatibility — stub object that masquerades as a
  // WebGLRenderingContext for legacy JS resources (Texture.js, CubeMap.js,
  // Framebuffer.js, etc.) that read `context._gl.FLOAT`, `context._gl.RGBA`,
  // etc. Typed via `ReturnType<typeof createWebGLCompatibilityStub>` so
  // the shape is inferred from the stub builder instead of declared as
  // `Record<string, unknown>`. TS callers get access to the full method
  // and constant list; JS callers are unaffected.
  public _gl!: ReturnType<typeof createWebGLCompatibilityStub>;

  // WGF-6: Cached reference to WebGPUPrimitiveIndexUtils so Scene.js can probe
  // `@builtin(primitive_index)` support without importing from Renderer/WebGPU.
  // Populated lazily by initialize() — Scene reads it via the public
  // `triangulationDebugSupported` getter.
  public _primitiveIndexUtilsCache: CesiumOpaqueObject | null = null;

  // WebGPU-specific caches and managers
  private _webgpuShaderCache: WebGPUShaderCache | null = null;
  private _webgpuPipelineCache: WebGPURenderPipelineCache | null = null;
  private _samplerCache: Map<string, GPUSampler> = new Map();
  private _bindGroupLayoutCache: Map<string, GPUBindGroupLayout> = new Map();
  private _bindGroupCache: Map<string, GPUBindGroup> = new Map();

  // Resource pools for efficient reuse
  private _bufferPool: Map<string, GPUBuffer[]> = new Map();
  private _uniformBufferPool: GPUBuffer[] = [];
  private _mipmapGenerator: WebGPUMipmapGenerator | null = null;

  // GPU statistics and debugging
  public _frameCount: number = 0;
  private _drawCallCount: number = 0;
  private _triangleCount: number = 0;

  // WebGPU optional features that were successfully enabled
  private _enabledFeatures: Set<string> = new Set();

  // Dynamic rendering state set by WebGPUSceneRenderer during frame execution
  public _depthStencilView: GPUTextureView | null = null;
  public _sceneColorView: GPUTextureView | null = null;
  public _sceneColorFormat: GPUTextureFormat = "bgra8unorm";
  public _msaaSamples: number = 1;
  public useIndirectDrawForTiles: boolean = false;

  // WebGL extension properties (WebGPU natively supports these as core features)
  public floatingPointTexture: boolean = true; // WebGPU always supports float textures
  public halfFloatingPointTexture: boolean = true; // WebGPU always supports half-float textures
  public textureFloatLinear: boolean = true; // WebGPU always supports float filtering
  public textureHalfFloatLinear: boolean = true; // WebGPU always supports half-float filtering

  /**
   * Phase 5 WGF-1: when `true`, render pipelines that participate in the
   * ClippingPlaneCollection use a `@builtin(clip_distances)` vertex output
   * instead of the legacy fragment-discard path. Auto-set to `true` by
   * `_updateFeatureFlags()` when the device grants the `clip-distances`
   * feature; consumers can flip it back off for visual diffing against
   * the legacy path. Currently consumed only by the globe terrain
   * pipeline; the model pipeline doesn't yet have clipping plane support
   * to migrate.
   */
  public useHardwareClipDistances: boolean = false;

  /**
   * Phase 5 WGF-3: when `true`, post-process pipeline stages that have
   * a hand-tuned f16 variant compile and use the half-precision source
   * instead of the f32 source. Auto-set to `true` by
   * `_updateFeatureFlags()` when the device grants the `shader-f16`
   * feature; consumers can flip it off for visual diffing against the
   * f32 reference. Today only the Tonemapping stage has an f16 variant
   * shipped — additional post-process stages (color grading, FXAA, bloom
   * helpers) are queued as incremental follow-ups gated on visual
   * validation. The flag also gates any future scene-side f16 use, but
   * RTE / depth / globe-UV math must always stay f32 (see CLAUDE.md).
   */
  public useShaderF16: boolean = false;
  public s3tc: CesiumCompressedTextureExtension = null;
  public pvrtc: CesiumCompressedTextureExtension = null;
  public astc: CesiumCompressedTextureExtension = null;
  public etc: CesiumCompressedTextureExtension = null;
  public etc1: CesiumCompressedTextureExtension = null;
  public bc7: CesiumCompressedTextureExtension = null;
  public webgl2: boolean = false;
  public _textureFilterAnisotropic: CesiumCompressedTextureExtension = null;

  // Additional WebGL properties for full compatibility
  public _id: string;
  public _shaderCache: CesiumShaderCache;
  public _textureCache: CesiumOpaqueObject;
  public _stencilBits: number = 8;
  public _antialias: boolean = false;
  // Cross-subsystem cache (see SceneGlobalCache in cesium-js-types.d.ts).
  // Known keys are typed; new keys land in the opaque-object index
  // signature fallback. No `Record<string, unknown>` here.
  public cache: SceneGlobalCache = {};
  public options: WebGPUContextOptions;
  public validateFramebuffer: boolean = false;
  public validateShaderProgram: boolean = false;
  public logShaderCompilation: boolean = false;

  // Vertex array object methods (WebGL compat stubs — noop functions)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WebGL compat noop stubs with varied signatures
  public glCreateVertexArray: (() => object) | null = null;
  public glBindVertexArray: ((...args: unknown[]) => void) | null = null;
  public glDeleteVertexArray: ((...args: unknown[]) => void) | null = null;

  // Instanced rendering methods (WebGL compat stubs)
  public glDrawElementsInstanced: ((...args: unknown[]) => void) | null = null;
  public glDrawArraysInstanced: ((...args: unknown[]) => void) | null = null;
  public glVertexAttribDivisor: ((...args: unknown[]) => void) | null = null;

  // Draw buffers (WebGL compat stubs)
  public glDrawBuffers: ((...args: unknown[]) => void) | null = null;

  // Extension support flags
  private _standardDerivatives: boolean = true;
  private _blendMinmax: boolean = true;
  private _elementIndexUint: boolean = true;
  private _fragDepth: boolean = true;
  private _textureFloat: boolean = true;
  private _textureHalfFloat: boolean = true;
  private _textureFloatLinear: boolean = true;
  private _textureHalfFloatLinear: boolean = true;
  private _supportsTextureLod: boolean = true;
  private _colorBufferFloat: boolean = true;
  private _floatBlend: boolean = true;
  private _colorBufferHalfFloat: boolean = true;
  private _s3tc: boolean = false;
  private _pvrtc: boolean = false;
  private _astc: boolean = false;
  private _etc: boolean = false;
  private _etc1: boolean = false;
  private _bc7: boolean = false;
  private _vertexArrayObject: boolean = true;
  private _instancedArrays: boolean = true;
  private _drawBuffers: boolean = true;

  // Default textures
  private _defaultTexture: CesiumOpaqueTexture | undefined;
  private _defaultEmissiveTexture: CesiumOpaqueTexture | undefined;
  private _defaultNormalTexture: CesiumOpaqueTexture | undefined;
  private _defaultCubeMap: CesiumOpaqueTexture | undefined;

  // Render state
  private _clearColor: CesiumColor;
  private _clearDepth: number = 1.0;
  private _clearStencil: number = 0;
  private _defaultPassState: CesiumPassState | undefined;
  private _defaultRenderState: CesiumOpaqueRenderState | undefined;
  private _currentRenderState: CesiumOpaqueRenderState | undefined;
  private _currentPassState: CesiumPassState | undefined;
  private _currentFramebuffer: CesiumOpaqueFramebuffer | undefined;

  // Viewport and scissor state
  private _viewport: { x: number; y: number; width: number; height: number } = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  };
  private _scissorTest: boolean = false;
  private _scissorRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  } = { x: 0, y: 0, width: 0, height: 0 };

  // WebGPU pipeline state tracking (for creating pipelines with correct state)
  private _depthTestEnabled: boolean = true;
  private _depthWriteEnabled: boolean = true;
  // Default depthCompare is `less-equal`, not `less`. At planetary scale
  // the projected clip-space Z can round up to exactly the far plane,
  // and `less` would discard those fragments. `less-equal` is the safe
  // default; pipelines that genuinely need strict-less can override.
  private _depthCompare: GPUCompareFunction = "less-equal";
  private _blendEnabled: boolean = false;
  private _cullFaceEnabled: boolean = true;
  private _cullMode: GPUCullMode = "back";
  private _frontFace: GPUFrontFace = "ccw";
  private _colorWriteMask: number = 0xf; // RGBA
  private _blendSrc: GPUBlendFactor = "one";
  private _blendDst: GPUBlendFactor = "zero";
  private _blendSrcAlpha: GPUBlendFactor = "one";
  private _blendDstAlpha: GPUBlendFactor = "zero";
  private _blendOp: GPUBlendOperation = "add";
  private _blendOpAlpha: GPUBlendOperation = "add";

  // Viewport quad for full-screen effects
  private _viewportQuadVertexBuffer: WebGPUBuffer | null = null;
  private _viewportQuadPipeline: GPURenderPipeline | null = null;
  private _viewportQuad: WebGPUViewportQuad | null = null;

  // Pick objects — managed by GraphicsContext base class
  // (_pickObjects Map and _nextPickColor counter are inherited)

  // Device loss recovery — delegated to WebGPUDeviceLossRecovery (FORK-1 fix)
  private _deviceLossRecovery: WebGPUDeviceLossRecovery | null = null;

  // GL compatibility - bound buffer/texture tracking for legacy code
  private _boundVertexBuffer: GPUBuffer | null = null;
  private _boundIndexBuffer: GPUBuffer | null = null;
  private _activeTextureUnit: number = 0;
  private _textureBindings: Map<
    number,
    { target: number; texture: StubTextureWrapper | null }
  > = new Map();
  private _boundFramebuffer: StubFramebuffer | null = null;
  private _boundRenderbuffer: StubRenderbuffer | null = null;
  private _framebuffers: Map<
    StubFramebuffer,
    { colorAttachment: StubAttachment; depthAttachment: StubAttachment }
  > = new Map();

  /**
   * Private constructor. Use WebGPUContext.create() instead.
   *
   * @private
   * @param {HTMLCanvasElement} canvas - The canvas element
   * @param {WebGPUContextOptions} options - Configuration options
   */
  private constructor(
    canvas: HTMLCanvasElement,
    options: WebGPUContextOptions,
  ) {
    super(); // Initialize GraphicsContext base (registry, logging, feature renderers)

    this._canvas = canvas;
    this._options = options;

    // Generate unique ID
    this._id = createGuid();

    // Initialize caches
    this._shaderCache = new ShaderCache(this);
    this._textureCache = new TextureCache();

    // Initialize uniform and pass state
    this._uniformState = new UniformState();
    this._defaultPassState = new PassState(this);
    this._defaultRenderState =
      jsModule<RenderStateStatics>(RenderState).fromCache();
    this._currentRenderState = this._defaultRenderState;
    this._currentPassState = this._defaultPassState;

    // Initialize clear values
    this._clearColor = new Color(0.0, 0.0, 0.0, 0.0);

    // Initialize vertex array object methods (no-op for WebGPU)
    this.glCreateVertexArray = () => ({});
    this.glBindVertexArray = () => {};
    this.glDeleteVertexArray = () => {};

    // Initialize instanced rendering methods (no-op for WebGPU)
    this.glDrawElementsInstanced = () => {};
    this.glDrawArraysInstanced = () => {};
    this.glVertexAttribDivisor = () => {};

    // Initialize draw buffers (no-op for WebGPU)
    this.glDrawBuffers = () => {};

    // Store options
    this.options = options;

    // Initialize WebGL compatibility stub
    // This provides WebGL constants that legacy code expects
    this._initializeWebGLStub();

    // Register with the global ContextRegistry (Phase B)
    this._registerWithRegistry();
  }

  /**
   * Creates and initializes a new WebGPUContext.
   * This is an async factory method because WebGPU initialization is asynchronous.
   *
   * @param {HTMLCanvasElement} canvas - The canvas element for rendering
   * @param {WebGPUContextOptions} [options] - Configuration options
   * @returns {Promise<WebGPUContext>} The initialized WebGPU context
   * @throws {RuntimeError} If WebGPU is not supported or initialization fails
   *
   * @example
   * const context = await WebGPUContext.create(canvas, {
   *   powerPreference: 'high-performance'
   * });
   */
  static async create(
    canvas: HTMLCanvasElement,
    options: WebGPUContextOptions = {},
  ): Promise<WebGPUContext> {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(canvas)) {
      throw new DeveloperError("canvas is required.");
    }

    if (!("gpu" in navigator)) {
      throw new RuntimeError(
        "WebGPU is not supported in this browser. " +
          "Please use a browser with WebGPU support (Chrome 113+, Edge 113+) " +
          'or set renderer to "webgl" or "auto".',
      );
    }
    //>>includeEnd('debug');

    const context = new WebGPUContext(canvas, options);
    await context._initialize();
    return context;
  }

  /**
   * Initializes the WebGPU device and canvas context.
   *
   * @private
   * @returns {Promise<void>}
   * @throws {RuntimeError} If initialization fails
   */
  private async _initialize(): Promise<void> {
    try {
      // Request GPU adapter
      // featureLevel "compatibility" runs WebGPU on WebGL2 hardware
      const adapterOptions: GPURequestAdapterOptions = {
        powerPreference: this._options.powerPreference ?? "high-performance",
      };
      if (this._options.featureLevel === "compatibility") {
        (
          adapterOptions as GPURequestAdapterOptions & { featureLevel?: string }
        ).featureLevel = "compatibility";
      }
      this._adapter = await navigator.gpu.requestAdapter(adapterOptions);

      if (!this._adapter) {
        throw new RuntimeError(
          "Failed to get WebGPU adapter. " +
            "WebGPU may not be properly supported on this device.",
        );
      }

      // Request GPU device with auto-detected optional features
      const requestedFeatures = this._buildFeatureList(this._adapter);
      const requiredLimits = this._options.requiredLimits ?? {};

      this._device = await this._adapter.requestDevice({
        requiredFeatures: requestedFeatures,
        requiredLimits,
      });

      // Record which features were actually enabled
      this._enabledFeatures = new Set(this._device.features);

      // Log enabled optional features for debugging
      const optionalEnabled = requestedFeatures.filter((f) =>
        this._enabledFeatures.has(f),
      );
      //>>includeStart('debug', pragmas.debug);
      if (optionalEnabled.length > 0) {
        console.log(
          `[WebGPU] Enabled optional features: ${optionalEnabled.join(", ")}`,
        );
      }
      //>>includeEnd('debug');

      // Wrap createShaderModule to automatically validate compilation.
      // Every shader across the entire renderer gets async error logging
      // without modifying individual call sites. Compilation errors are
      // logged to the console immediately instead of silently poisoning
      // downstream pipelines and command buffers.
      this._installShaderValidation(this._device);

      // Handle device lost event with recovery strategy
      this._setupDeviceLostHandler();

      // Initialize ContextLimits from WebGPU device limits
      this._initializeContextLimits();

      // Update capability flags based on enabled features
      this._updateFeatureFlags();

      // WGF-6: Cache the primitive_index utility module so backend-agnostic
      // Scene code can probe support without importing from Renderer/WebGPU.
      try {
        const primIdxMod = await import("./WebGPUPrimitiveIndexUtils.js");
        this._primitiveIndexUtilsCache = primIdxMod.WebGPUPrimitiveIndexUtils;
      } catch (e) {
        this._primitiveIndexUtilsCache = null;
      }

      // Configure canvas context
      this._context = this._canvas.getContext("webgpu") as GPUCanvasContext;

      if (!this._context) {
        throw new RuntimeError("Failed to get WebGPU canvas context.");
      }

      // Get preferred format
      this._presentationFormat = navigator.gpu.getPreferredCanvasFormat();

      // Configure the canvas
      this._context.configure({
        device: this._device,
        format: this._presentationFormat,
        alphaMode: "opaque",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });

      // Initialize default textures
      this._initializeDefaultTextures();

      // Initialization complete — adapter and format selected
      const level = this._options.featureLevel ?? "core";
      this.log(
        "info",
        `Initialized (featureLevel: ${level}, adapter: ${this._adapter?.info?.vendor ?? "unknown"})`,
      );

      // Register all WebGPU feature renderers so scene files can access them
      // via context.getFeatureRenderer('name') instead of importing directly
      registerWebGPUFeatureRenderers(this);

      // Load WGSL shaders during context initialization (not in Scene.createAsync).
      // This keeps shader loading as part of the context's own async init lifecycle.
      const sceneRendererFR = this.getFeatureRenderer(
        FeatureRendererKey.SCENE_RENDERER,
      ) as import("../GraphicsContext.js").SystemRenderer | undefined;
      if (sceneRendererFR) {
        if (sceneRendererFR.initPrimitiveShaders) {
          await sceneRendererFR.initPrimitiveShaders();
        }
        if (sceneRendererFR.initCollectionShaders) {
          await sceneRendererFR.initCollectionShaders();
        }
      }

      // Pipeline warm-up: proactively initialize common renderers to avoid
      // first-frame stutter from synchronous pipeline compilation.
      this._warmUpPipelines();
    } catch (error) {
      throw new RuntimeError(
        `Failed to initialize WebGPU context: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Proactively initialize common renderers to avoid first-frame pipeline stutter.
   * Fires-and-forgets — initialization happens in background.
   * @private
   */
  private _warmUpPipelines(): void {
    // Touch the globe surface FR to trigger its RendererClass instantiation.
    // The constructor compiles the terrain shader module and creates pipeline layout.
    const globeFR = this.getFeatureRenderer(FeatureRendererKey.GLOBE_SURFACE);
    if (globeFR?.RendererClass && !globeFR._instance) {
      try {
        globeFR._instance = new globeFR.RendererClass(this);
      } catch (e) {
        // Non-fatal — will be created lazily on first use
      }
    }

    // Trigger async GPU culler initialization (loads FrustumCull.wgsl + compiles compute pipeline)
    void this.gpuCuller;
  }

  /**
   * Initialize default textures (white, black, normal, cubemap)
   * @private
   */
  private _initializeDefaultTextures(): void {
    if (!this._device) {
      return;
    }

    // Create 1x1 white texture (default texture)
    const whiteData = new Uint8Array([255, 255, 255, 255]);
    const whiteTex = WebGPUTexture.create2D(
      this._device,
      1,
      1,
      "rgba8unorm",
      1,
      "Default White Texture",
    );
    whiteTex.write(whiteData, 1, 1);
    this._defaultTexture = whiteTex;

    // Create 1x1 black texture (default emissive)
    const blackData = new Uint8Array([0, 0, 0, 255]);
    const blackTex = WebGPUTexture.create2D(
      this._device,
      1,
      1,
      "rgba8unorm",
      1,
      "Default Emissive Texture",
    );
    blackTex.write(blackData, 1, 1);
    this._defaultEmissiveTexture = blackTex;

    // Create 1x1 normal texture (default normal - pointing up in tangent space)
    // Normal = (0.5, 0.5, 1.0) in RGB space = (128, 128, 255, 255)
    const normalData = new Uint8Array([128, 128, 255, 255]);
    const normalTex = WebGPUTexture.create2D(
      this._device,
      1,
      1,
      "rgba8unorm",
      1,
      "Default Normal Texture",
    );
    normalTex.write(normalData, 1, 1);
    this._defaultNormalTexture = normalTex;

    // Create 1x1 cubemap (all faces white)
    const cubeTex = WebGPUTexture.createCubeMap(
      this._device,
      1,
      "rgba8unorm",
      1,
      "Default Cube Map",
    );
    // Write white to all 6 faces
    for (let face = 0; face < 6; face++) {
      cubeTex.write(whiteData, 1, 1, face);
    }
    this._defaultCubeMap = cubeTex;
  }

  // GraphicsContext interface implementation

  /**
   * The renderer type for this context
   */
  get rendererType(): RendererType {
    return this._options.featureLevel === "compatibility"
      ? RendererType.WEBGPU_COMPAT
      : RendererType.WEBGPU;
  }

  /**
   * The WebGPU feature level: "core" or "compatibility"
   */
  get featureLevel(): string {
    return this._options.featureLevel ?? "core";
  }

  /**
   * The canvas element associated with this context
   */
  get canvas(): HTMLCanvasElement {
    return this._canvas;
  }

  /**
   * The width of the drawing buffer
   */
  get drawingBufferWidth(): number {
    return this._canvas.width;
  }

  /**
   * The height of the drawing buffer
   */
  get drawingBufferHeight(): number {
    return this._canvas.height;
  }

  /**
   * Whether the context supports depth textures (always true for WebGPU)
   */
  get depthTexture(): boolean {
    return true;
  }

  /**
   * Whether the context supports fragment depth (always true for WebGPU)
   */
  get fragmentDepth(): boolean {
    return true;
  }

  /**
   * WebGPU uses 0-to-1 depth range (unlike WebGL's -1 to 1).
   * Scene code uses this to set Matrix4 depth range type.
   */
  override get depthRangeZeroToOne(): boolean {
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // COMPUTE SHADER CAPABILITY OVERRIDES
  //
  // WebGPU has full native compute shader support. These overrides
  // report the actual device limits so scene code can make informed
  // decisions about dispatch sizes, workgroup counts, and whether
  // to use GPU compute vs CPU/WASM fallbacks.
  // ═══════════════════════════════════════════════════════════

  /**
   * WebGPU natively supports real GPU compute shaders.
   * Always true when a valid device exists.
   */
  override get supportsComputeShaders(): boolean {
    return this._device !== null;
  }

  /**
   * WebGPU supports indirect compute dispatch via `dispatchWorkgroupsIndirect()`.
   * This enables fully GPU-driven pipelines where workgroup counts come from
   * a GPU buffer rather than CPU-specified values.
   */
  override get supportsIndirectCompute(): boolean {
    return this._device !== null;
  }

  /**
   * WebGPU natively supports storage buffers (`storage` binding type).
   * Storage buffers allow compute/vertex/fragment shaders to read/write
   * large structured data (up to `maxStorageBufferBindingSize`, typically 128+ MB).
   */
  override get supportsStorageBuffers(): boolean {
    return this._device !== null;
  }

  /**
   * Maximum workgroups per dispatch dimension from the GPUDevice limits.
   * Typically 65535 on most GPUs.
   */
  override get maxComputeWorkgroupsPerDimension(): number {
    return this._device?.limits?.maxComputeWorkgroupsPerDimension ?? 0;
  }

  /**
   * Maximum total invocations per workgroup from the GPUDevice limits.
   * Typically 256 on most GPUs.
   */
  override get maxComputeInvocationsPerWorkgroup(): number {
    return this._device?.limits?.maxComputeInvocationsPerWorkgroup ?? 0;
  }

  /**
   * Maximum shared (workgroup) memory in bytes from the GPUDevice limits.
   * Typically 16384 bytes on most GPUs.
   */
  override get maxComputeWorkgroupStorageSize(): number {
    return this._device?.limits?.maxComputeWorkgroupStorageSize ?? 0;
  }

  /**
   * Whether the context has been destroyed. Method (not getter) form to
   * match the upstream CesiumJS convention used everywhere else — also
   * compatible with `destroyObject.js`, which overwrites `.isDestroyed`
   * with a `returnTrue` function on destroyed objects.
   */
  isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /**
   * Gets the WebGPU device
   * @returns {GPUDevice | null} The GPU device
   */
  get device(): GPUDevice | null {
    return this._device;
  }

  /**
   * Gets the WebGPU adapter
   * @returns {GPUAdapter | null} The GPU adapter
   */
  get adapter(): GPUAdapter | null {
    return this._adapter;
  }

  /**
   * Gets the presentation format
   * @returns {GPUTextureFormat} The texture format
   */
  get presentationFormat(): GPUTextureFormat {
    return this._presentationFormat;
  }

  /**
   * Begin a new frame - creates command encoder and starts the default render pass.
   *
   * The default render pass renders to the canvas with depth/stencil.
   * Use `beginRenderPass()` to start additional render passes within the frame
   * (e.g., for shadow maps, pick framebuffers, post-processing).
   *
   * Frame lifecycle:
   * ```
   * beginFrame()          — creates command encoder + default canvas render pass
   *   draw commands...    — execute against current render pass
   *   endCurrentRenderPass()   — (optional) end current pass
   *   beginRenderPass(desc)    — start a new pass (e.g., shadow, pick)
   *   draw commands...
   *   endCurrentRenderPass()
   *   beginRenderPass(desc)    — start another pass
   *   ...
   * endFrame()            — ends any active pass + submits command buffer
   * ```
   */
  beginFrame(): void {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("Context has been destroyed.");
    }
    //>>includeEnd('debug');

    if (!this._device || !this._context) {
      return;
    }

    // Reset frame statistics
    this._drawCallCount = 0;
    this._triangleCount = 0;
    this._frameCount++;
    this._clearCallsThisFrame = 0;
    this._clearOverflowWarned = false;

    // Advance ring buffer allocator to next page
    if (this._uniformAllocator) {
      this._uniformAllocator.beginFrame();
    }

    // Create command encoder for this frame
    this._currentCommandEncoder = this._device.createCommandEncoder({
      label: "Scene Frame Command Encoder",
    });

    // Get current canvas texture
    const canvasTexture = this._context.getCurrentTexture();
    this._currentTextureView = canvasTexture.createView();

    // Create or recreate depth texture if needed
    this._ensureDepthTexture();

    // Start the default (canvas) render pass
    this._beginDefaultRenderPass();
  }

  /**
   * Starts the default render pass targeting the canvas surface.
   * This is called automatically by `beginFrame()` and can also be called
   * after `endCurrentRenderPass()` to resume rendering to the canvas.
   *
   * @param {boolean} [clear=true] - Whether to clear the canvas (loadOp: "clear" vs "load")
   */
  private _beginDefaultRenderPass(clear: boolean = true): void {
    if (!this._currentCommandEncoder || !this._currentTextureView) {
      return;
    }

    const renderPassDescriptor: GPURenderPassDescriptor = {
      label: "Scene Main Render Pass",
      colorAttachments: [
        {
          view: this._currentTextureView,
          clearValue: {
            r: this._clearColor.red ?? 0.0,
            g: this._clearColor.green ?? 0.0,
            b: this._clearColor.blue ?? 0.0,
            a: this._clearColor.alpha ?? 1.0,
          },
          loadOp: clear ? "clear" : "load",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: this._depthTextureView
        ? {
            view: this._depthTextureView,
            depthClearValue: this._clearDepth,
            depthLoadOp: clear ? "clear" : "load",
            depthStoreOp: "store",
            stencilClearValue: this._clearStencil,
            stencilLoadOp: clear ? "clear" : "load",
            stencilStoreOp: "store",
          }
        : undefined,
    };

    this._currentRenderPassEncoder =
      this._currentCommandEncoder.beginRenderPass(renderPassDescriptor);

    // Set default viewport to full canvas size
    this._currentRenderPassEncoder.setViewport(
      0,
      0,
      this._canvas.width,
      this._canvas.height,
      0,
      1,
    );
    this._currentRenderPassEncoder.setScissorRect(
      0,
      0,
      this._canvas.width,
      this._canvas.height,
    );
  }

  /**
   * Begin a new render pass with a custom descriptor.
   *
   * If a render pass is currently active, it will be ended first.
   * This enables multi-pass rendering for:
   * - Shadow map rendering (depth-only pass to shadow texture)
   * - Pick framebuffer rendering (color pass to pick texture)
   * - Post-processing (full-screen quad to intermediate texture)
   * - Translucent rendering (separate pass with different blend state)
   *
   * @param {GPURenderPassDescriptor} descriptor - The render pass descriptor
   * @returns {GPURenderPassEncoder | null} The new render pass encoder, or null if no command encoder
   *
   * @example
   * // Shadow map pass
   * const shadowPass = context.beginRenderPass({
   *   colorAttachments: [],
   *   depthStencilAttachment: {
   *     view: shadowDepthTextureView,
   *     depthClearValue: 1.0,
   *     depthLoadOp: "clear",
   *     depthStoreOp: "store",
   *   }
   * });
   *
   * // Render shadow casters...
   * context.endCurrentRenderPass();
   *
   * // Resume canvas rendering
   * context.resumeDefaultRenderPass();
   */
  beginRenderPass(
    descriptor: GPURenderPassDescriptor,
  ): GPURenderPassEncoder | null {
    if (!this._currentCommandEncoder) {
      this.log(
        "warn",
        "beginRenderPass: No command encoder — call beginFrame() first",
      );
      return null;
    }

    // End current render pass if one is active
    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.end();
      this._currentRenderPassEncoder = null;
    }

    // Begin the new render pass
    this._currentRenderPassEncoder =
      this._currentCommandEncoder.beginRenderPass(descriptor);

    return this._currentRenderPassEncoder;
  }

  /**
   * End the currently active render pass without submitting the command buffer.
   *
   * After calling this, you can:
   * - Start a new render pass with `beginRenderPass(descriptor)`
   * - Resume the default canvas pass with `resumeDefaultRenderPass()`
   * - End the frame with `endFrame()`
   *
   * This is safe to call even if no render pass is active (no-op).
   */
  endCurrentRenderPass(): void {
    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.end();
      this._currentRenderPassEncoder = null;
    }
  }

  /**
   * Resume rendering to the default canvas render pass.
   *
   * This starts a new render pass targeting the canvas surface with loadOp: "load"
   * (preserving what was already rendered). Use this after completing a non-default
   * render pass (e.g., shadow map, pick buffer) to continue rendering to the screen.
   *
   * @returns {GPURenderPassEncoder | null} The render pass encoder, or null
   */
  resumeDefaultRenderPass(): GPURenderPassEncoder | null {
    if (!this._currentCommandEncoder || !this._currentTextureView) {
      this.log(
        "warn",
        "resumeDefaultRenderPass: No command encoder or texture view",
      );
      return null;
    }

    // End current pass if active
    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.end();
      this._currentRenderPassEncoder = null;
    }

    // Start a new default pass with loadOp: "load" (preserve existing content)
    this._beginDefaultRenderPass(false);

    return this._currentRenderPassEncoder;
  }

  /**
   * Get the current command encoder for advanced operations.
   * Available between beginFrame() and endFrame().
   *
   * @returns {GPUCommandEncoder | null} The active command encoder
   */
  get currentCommandEncoder(): GPUCommandEncoder | null {
    return this._currentCommandEncoder;
  }

  /**
   * Get the current canvas texture view (the render target for the default pass).
   * Available between beginFrame() and endFrame().
   *
   * @returns {GPUTextureView | null} The current canvas texture view
   */
  get currentTextureView(): GPUTextureView | null {
    return this._currentTextureView;
  }

  /**
   * Get the depth texture view for the default render pass.
   *
   * @returns {GPUTextureView | null} The depth/stencil texture view
   */
  get depthTextureView(): GPUTextureView | null {
    return this._depthTextureView;
  }

  /**
   * Depth-only view suitable for sampling in compute shaders.
   * Strips the stencil aspect so the view matches `texture_depth_2d`
   * in WGSL and `sampleType: "depth"` in bind group layouts.
   */
  get depthOnlyTextureView(): GPUTextureView | null {
    return this._depthOnlyTextureView;
  }

  /**
   * Get the depth format used by this context.
   *
   * @returns {GPUTextureFormat} The depth texture format
   */
  get depthFormat(): GPUTextureFormat {
    return this._depthFormat;
  }

  /**
   * Check if a render pass is currently active.
   *
   * @returns {boolean} True if a render pass encoder is active
   */
  get hasActiveRenderPass(): boolean {
    return this._currentRenderPassEncoder !== null;
  }

  /**
   * End the current frame - ends render pass and submits commands
   */
  endFrame(): void {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("Context has been destroyed.");
    }
    //>>includeEnd('debug');

    if (!this._device || !this._currentCommandEncoder) {
      return;
    }

    // End render pass if active
    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.end();
      this._currentRenderPassEncoder = null;
    }

    // Submit command buffer
    const commandBuffer = this._currentCommandEncoder.finish();
    this._device.queue.submit([commandBuffer]);

    // Finalize ring buffer frame
    if (this._uniformAllocator) {
      this._uniformAllocator.endFrame();
    }

    // Clear frame state
    this._currentCommandEncoder = null;
    this._currentTextureView = null;
  }

  /**
   * Ensures depth texture exists and matches canvas size
   * @private
   */
  private _ensureDepthTexture(): void {
    if (!this._device) {
      return;
    }

    const width = this._canvas.width;
    const height = this._canvas.height;

    // Recreate if size changed or doesn't exist
    if (
      !this._depthTexture ||
      this._depthTexture.width !== width ||
      this._depthTexture.height !== height
    ) {
      // Destroy old texture
      if (this._depthTexture) {
        this._depthTexture.destroy();
      }

      // Create new depth texture. TEXTURE_BINDING is added so compute
      // shaders (Hi-Z pyramid, occlusion test) can sample the depth
      // after the render pass stores it. Guarded so the feature is
      // only requested when a consumer opts in (default: off).
      const depthUsage = GPUTextureUsage.RENDER_ATTACHMENT;
      this._depthTexture = this._device.createTexture({
        size: { width, height },
        format: this._depthFormat,
        usage: depthUsage,
        label: "Scene Depth Texture",
      });

      this._depthTextureView = this._depthTexture.createView();
      this._depthOnlyTextureView = null;
    }
  }

  // ====================================================================================
  // Feature Detection & Auto-Request (C1/C3/C4)
  /**
   * Wrap `device.createShaderModule` so every shader module created by
   * ANY renderer component automatically gets async compilation
   * validation. Errors are logged with file/line info from the WGSL
   * source instead of surfacing as cryptic "invalid pipeline" errors
   * that cascade through render bundles and kill the entire frame.
   */
  private _installShaderValidation(device: GPUDevice): void {
    const origCreateShaderModule = device.createShaderModule.bind(device);
    const contextId = this._id;
    device.createShaderModule = function (
      descriptor: GPUShaderModuleDescriptor,
    ): GPUShaderModule {
      const mod = origCreateShaderModule(descriptor);
      // Fire-and-forget async validation — doesn't block pipeline
      // creation but surfaces errors in the console immediately.
      mod.getCompilationInfo().then((info: GPUCompilationInfo) => {
        for (const msg of info.messages) {
          if (msg.type === "error") {
            console.error(
              `[CesiumJS:webgpu:${contextId}] Shader "${descriptor.label ?? "unlabeled"}" ` +
                `compilation ERROR at line ${msg.lineNum}:${msg.linePos}: ${msg.message}`,
            );
          } else if (msg.type === "warning") {
            //>>includeStart('debug', pragmas.debug);
            console.warn(
              `[CesiumJS:webgpu:${contextId}] Shader "${descriptor.label ?? "unlabeled"}" ` +
                `warning at line ${msg.lineNum}: ${msg.message}`,
            );
            //>>includeEnd('debug');
          }
        }
      });
      return mod;
    };
  }

  /**
   * Lazy-initialize the cascaded shadow map renderer. Called on the
   * first frame where `scene.useCascadedShadowMaps` is true.
   */
  private _initCSMRenderer(): void {
    if (this._csmRenderer || !this._device) {
      return;
    }
    this._csmRenderer = new WebGPUCSMRenderer({ enabled: true });
    this._csmRenderer.initialize(this._device);
  }

  // ====================================================================================

  /**
   * Optional WebGPU features that CesiumJS benefits from.
   * Listed in priority order. Each is only requested if the adapter supports it.
   * @private
   */
  private static readonly DESIRED_FEATURES: GPUFeatureName[] = [
    // C1: Terrain heightmaps use float32 textures — enables HW bilinear filtering
    "float32-filterable" as GPUFeatureName,
    // C3: Native GPU clip planes for ClippingPlaneCollection (Chrome 128+)
    "clip-distances" as GPUFeatureName,
    // C4: Weighted-average OIT in single render pass (Chrome 128+)
    "dual-source-blending" as GPUFeatureName,
    // I4: HDR render targets for post-processing (Chrome 121+)
    "rg11b10ufloat-renderable" as GPUFeatureName,
    // I6: GPU-side performance profiling (Chrome 121+)
    "timestamp-query" as GPUFeatureName,
    // I5: Half-precision floats in shaders — reduce memory, faster math
    "shader-f16" as GPUFeatureName,
    // I1: GPU-driven rendering with indirect draw calls (Chrome 128+)
    "indirect-first-instance" as GPUFeatureName,
    // S4: SIMD-like subgroup operations for compute shaders (Chrome 132+)
    "subgroups" as GPUFeatureName,
    // BGRA8 storage textures for compute-based post-processing
    "bgra8unorm-storage" as GPUFeatureName,
    // Texture compression formats (requested if adapter supports them)
    "texture-compression-bc" as GPUFeatureName,
    "texture-compression-etc2" as GPUFeatureName,
    "texture-compression-astc" as GPUFeatureName,
  ];

  /**
   * Builds the list of features to request from the device.
   * Merges user-requested features with auto-detected optional features
   * that the adapter supports.
   *
   * @private
   * @param {GPUAdapter} adapter - The GPU adapter to query
   * @returns {GPUFeatureName[]} Features to request
   */
  private _buildFeatureList(adapter: GPUAdapter): GPUFeatureName[] {
    // Start with any explicitly requested features from the user
    const features = new Set<GPUFeatureName>(
      this._options.requiredFeatures ?? [],
    );

    // Auto-detect and add optional features the adapter supports
    for (const feature of WebGPUContext.DESIRED_FEATURES) {
      if (adapter.features.has(feature)) {
        features.add(feature);
      }
    }

    return Array.from(features);
  }

  /**
   * Updates internal capability flags based on which features were
   * successfully enabled on the device. Called after device creation.
   *
   * @private
   */
  private _updateFeatureFlags(): void {
    // C1: float32-filterable — update the textureFloatLinear flag
    // Without this feature, float32 textures require nearest-only sampling
    if (this._enabledFeatures.has("float32-filterable")) {
      this.textureFloatLinear = true;
      this._textureFloatLinear = true;
    }

    // C3 (Phase 5 WGF-1) + I5 (Phase 5 WGF-3): both flags stay OPT-IN
    // even when the device grants the underlying feature. Reasons:
    //
    // - WGF-1 (`clip-distances`): the hardware path requires SCENE3D mode
    //   AND union-mode clipping; the gating in WebGPUGlobeSurfaceRenderer
    //   covers correctness, but until the visual-regression harness is
    //   wired we don't want to silently change rendering on every fork
    //   user that happens to enable clipping planes.
    //
    // - WGF-3 (`shader-f16`): a small fraction of adapters report
    //   shader-f16 support but trip on specific operators. The fallback
    //   path is async-only (popErrorScope is a promise) so a failed
    //   compile produces a black post-process output until the user
    //   manually disables the flag. Opt-in until the validation harness
    //   can probe per-shader-variant compilation at init.
    //
    // Consumers enable either flag with:
    //   scene.context.useHardwareClipDistances = true;
    //   scene.context.useShaderF16 = true;
    // The capability flags `hasClipDistances` / `hasShaderF16` on the
    // debug snapshot expose what the adapter actually granted.

    // Texture compression formats
    if (this._enabledFeatures.has("texture-compression-bc")) {
      this._s3tc = true;
      this._bc7 = true;
      this.s3tc = true;
      this.bc7 = true;
    }
    if (this._enabledFeatures.has("texture-compression-etc2")) {
      this._etc = true;
      this.etc = true;
    }
    if (this._enabledFeatures.has("texture-compression-astc")) {
      this._astc = true;
      this.astc = true;
    }
  }

  /**
   * Check if a specific WebGPU feature is enabled on the device.
   *
   * @param {string} featureName - Feature name (e.g., 'float32-filterable',
   *   'clip-distances', 'dual-source-blending', 'timestamp-query', 'shader-f16')
   * @returns {boolean} True if the feature is enabled
   *
   * @example
   * if (context.hasFeature('clip-distances')) {
   *   // Use native clip planes instead of stencil-based clipping
   * }
   * if (context.hasFeature('dual-source-blending')) {
   *   // Use single-pass weighted-average OIT
   * }
   */
  hasFeature(featureName: string): boolean {
    return this._enabledFeatures.has(featureName);
  }

  /**
   * Get all enabled optional features.
   * @returns {string[]} Array of enabled feature names
   */
  get enabledFeatures(): string[] {
    return Array.from(this._enabledFeatures);
  }

  /**
   * Initializes the global ContextLimits with values from WebGPU device limits
   * @private
   */
  private _initializeContextLimits(): void {
    if (!this._device) {
      return;
    }

    const limits = this._device.limits;
    // ContextLimits is a JS module that exposes its internal `_xxx`
    // fields via Object.defineProperties. The host context is expected
    // to write these on init. See ContextLimitsInternals at the top of
    // this file for the full shape.
    const cl = jsModule<ContextLimitsInternals>(ContextLimits);

    // Map WebGPU limits to ContextLimits internals.
    cl._maximumTextureSize = limits.maxTextureDimension2D;
    cl._maximumCubeMapSize = limits.maxTextureDimension2D;
    cl._maximumRenderbufferSize = limits.maxTextureDimension2D;
    cl._maximumTextureImageUnits = limits.maxSampledTexturesPerShaderStage;
    cl._maximumVertexTextureImageUnits =
      limits.maxSampledTexturesPerShaderStage;
    cl._maximumCombinedTextureImageUnits =
      limits.maxSampledTexturesPerShaderStage * 2;
    cl._maximumVertexAttributes = limits.maxVertexAttributes;
    cl._maximumViewportWidth = limits.maxTextureDimension2D;
    cl._maximumViewportHeight = limits.maxTextureDimension2D;

    // Set reasonable defaults for other limits
    cl._maximumFragmentUniformVectors = 1024;
    cl._maximumVaryingVectors = 31;
    cl._maximumVertexUniformVectors = 1024;
    cl._minimumAliasedLineWidth = 1.0;
    cl._maximumAliasedLineWidth = 1.0;
    cl._minimumAliasedPointSize = 1.0;
    cl._maximumAliasedPointSize = 1.0;
    cl._maximumTextureFilterAnisotropy = 16.0;
    cl._maximumDrawBuffers = limits.maxColorAttachments ?? 8;
    cl._maximumColorAttachments = limits.maxColorAttachments ?? 8;
    cl._maximumSamples = 4;
    cl._highpFloatSupported = true;
    cl._highpIntSupported = true;
  }

  /**
   * Initialize a WebGL compatibility stub that provides WebGL constants.
   * Uses the extracted WebGLCompatibilityStub module with a state proxy that
   * delegates reads/writes to this context's private fields.
   *
   * This prevents legacy Texture.js code from crashing when accessing gl.TEXTURE_2D, etc.
   * @private
   */
  private _initializeWebGLStub(): void {
    // Create a state proxy that provides live access to this context's private fields.
    // The extracted stub reads/writes through this proxy instead of using inline closures.
    const ctx = this;
    const state: WebGLStubState = {
      get device() {
        return ctx._device;
      },
      get context() {
        return ctx._context;
      },
      get currentCommandEncoder() {
        return ctx._currentCommandEncoder;
      },
      get currentRenderPassEncoder() {
        return ctx._currentRenderPassEncoder;
      },

      get activeTextureUnit() {
        return ctx._activeTextureUnit;
      },
      set activeTextureUnit(v) {
        ctx._activeTextureUnit = v;
      },
      get textureBindings() {
        return ctx._textureBindings;
      },
      get boundVertexBuffer() {
        return ctx._boundVertexBuffer;
      },
      set boundVertexBuffer(v) {
        ctx._boundVertexBuffer = v;
      },
      get boundIndexBuffer() {
        return ctx._boundIndexBuffer;
      },
      set boundIndexBuffer(v) {
        ctx._boundIndexBuffer = v;
      },
      get boundFramebuffer() {
        return ctx._boundFramebuffer;
      },
      set boundFramebuffer(v) {
        ctx._boundFramebuffer = v;
      },
      get boundRenderbuffer() {
        return ctx._boundRenderbuffer;
      },
      set boundRenderbuffer(v) {
        ctx._boundRenderbuffer = v;
      },
      get framebuffers() {
        return ctx._framebuffers;
      },

      get clearColor() {
        return ctx._clearColor;
      },
      set clearColor(v) {
        ctx._clearColor = v;
      },
      get clearDepth() {
        return ctx._clearDepth;
      },
      set clearDepth(v) {
        ctx._clearDepth = v;
      },
      get clearStencil() {
        return ctx._clearStencil;
      },
      set clearStencil(v) {
        ctx._clearStencil = v;
      },

      get depthTestEnabled() {
        return ctx._depthTestEnabled;
      },
      set depthTestEnabled(v) {
        ctx._depthTestEnabled = v;
      },
      get depthWriteEnabled() {
        return ctx._depthWriteEnabled;
      },
      set depthWriteEnabled(v) {
        ctx._depthWriteEnabled = v;
      },
      get depthCompare() {
        return ctx._depthCompare;
      },
      set depthCompare(v) {
        ctx._depthCompare = v;
      },

      get blendEnabled() {
        return ctx._blendEnabled;
      },
      set blendEnabled(v) {
        ctx._blendEnabled = v;
      },
      get cullFaceEnabled() {
        return ctx._cullFaceEnabled;
      },
      set cullFaceEnabled(v) {
        ctx._cullFaceEnabled = v;
      },
      get cullMode() {
        return ctx._cullMode;
      },
      set cullMode(v) {
        ctx._cullMode = v;
      },
      get frontFace() {
        return ctx._frontFace;
      },
      set frontFace(v) {
        ctx._frontFace = v;
      },
      get colorWriteMask() {
        return ctx._colorWriteMask;
      },
      set colorWriteMask(v) {
        ctx._colorWriteMask = v;
      },

      get blendSrc() {
        return ctx._blendSrc;
      },
      set blendSrc(v) {
        ctx._blendSrc = v;
      },
      get blendDst() {
        return ctx._blendDst;
      },
      set blendDst(v) {
        ctx._blendDst = v;
      },
      get blendSrcAlpha() {
        return ctx._blendSrcAlpha;
      },
      set blendSrcAlpha(v) {
        ctx._blendSrcAlpha = v;
      },
      get blendDstAlpha() {
        return ctx._blendDstAlpha;
      },
      set blendDstAlpha(v) {
        ctx._blendDstAlpha = v;
      },
      get blendOp() {
        return ctx._blendOp;
      },
      set blendOp(v) {
        ctx._blendOp = v;
      },
      get blendOpAlpha() {
        return ctx._blendOpAlpha;
      },
      set blendOpAlpha(v) {
        ctx._blendOpAlpha = v;
      },

      get scissorTest() {
        return ctx._scissorTest;
      },
      set scissorTest(v) {
        ctx._scissorTest = v;
      },

      // ── Stub-local state (not mirrored on the context) ──
      // Pixel-store flags consumed by the texture stub when uploading
      // CPU pixel data via texImage2D / texSubImage2D.
      pixelStore: {
        unpackFlipY: false,
        unpackPremultiplyAlpha: false,
        unpackAlignment: 4,
      },
      // Stencil state mirrors WebGL defaults; tracked for future
      // pipeline creation that needs stencil ops.
      stencilTestEnabled: false,
      stencilFrontCompare: "always" as GPUCompareFunction,
      stencilBackCompare: "always" as GPUCompareFunction,
      stencilReadMask: 0xff,
      stencilWriteMask: 0xff,
      stencilReference: 0,
      stencilFailOp: "keep" as GPUStencilOperation,
      stencilDepthFailOp: "keep" as GPUStencilOperation,
      stencilPassOp: "keep" as GPUStencilOperation,
      // Lazy mipmap generator — created the first time generateMipmap is
      // called. Stored on `state` so the texture stub can dispatch a real
      // blit-down compute pass instead of falling back to a no-op.
      mipmapGenerator: null,

      // Methods that delegate to WebGPUContext methods
      setViewport: (x: number, y: number, w: number, h: number) =>
        ctx.setViewport(x, y, w, h),
      setScissorRect: (x: number, y: number, w: number, h: number) =>
        ctx.setScissorRect(x, y, w, h),
      disableScissorTest: () => ctx.disableScissorTest(),
      copyTextureRegion: (
        src: GPUTexture,
        dst: GPUTexture,
        sx: number,
        sy: number,
        dx: number,
        dy: number,
        w: number,
        h: number,
      ) => ctx.copyTextureRegion(src, dst, sx, sy, dx, dy, w, h),
      webglToWebGPUBlendFactor: (f: number) => ctx._webglToWebGPUBlendFactor(f),
      webglToWebGPUBlendOp: (o: number) => ctx._webglToWebGPUBlendOp(o),
      webglToWebGPUCompareFunction: (f: number) =>
        ctx._webglToWebGPUCompareFunction(f),
    };

    this._gl = createWebGLCompatibilityStub(state);
  }

  /**
   * Gets the current render pass encoder (for command recording)
   * @returns {GPURenderPassEncoder | null} The active render pass encoder
   */
  get currentRenderPassEncoder(): GPURenderPassEncoder | null {
    return this._currentRenderPassEncoder;
  }

  /**
   * Gets the uniform state for managing shader uniforms
   * @returns {CesiumUniformState} The uniform state
   */
  get uniformState(): CesiumUniformState {
    return this._uniformState;
  }

  /**
   * Initialize viewport quad vertex buffer - PRIORITY 2
   * Creates a full-screen quad for post-processing effects
   * @private
   */
  private _initializeViewportQuad(): void {
    if (!this._device || this._viewportQuadVertexBuffer) {
      return;
    }

    // Full-screen quad vertices (2 triangles covering NDC -1 to 1)
    // Format: [x, y] positions
    const quadVertices = new Float32Array([
      -1.0,
      -1.0, // Bottom-left
      1.0,
      -1.0, // Bottom-right
      -1.0,
      1.0, // Top-left
      1.0,
      1.0, // Top-right
    ]);

    this._viewportQuadVertexBuffer = WebGPUBuffer.createVertexBuffer(
      this._device,
      quadVertices,
      "Viewport Quad Vertex Buffer",
    );
  }

  /**
   * Creates a viewport quad command for screen-space effects.
   *
   * Accepts WGSL shader code (string with @vertex/@fragment, or object with
   * `_wgslCode` property). GLSL shaders return a noop command — callers that
   * need WebGPU support must provide WGSL equivalents.
   *
   * Delegates to {@link WebGPUViewportQuad} for pipeline caching, bind group
   * creation, and fullscreen triangle rendering.
   *
   * @see WebGPUViewportQuad for shader conventions and binding layout
   * @param {unknown} fragmentShader - WGSL shader code or GLSL source
   * @param {ViewportQuadCommandOptions} [options] - uniformMap, framebuffer, owner, renderState, pass,
   *   pipelineConfig (blend/depth/stencil)
   * @returns {ViewportQuadCommand} A command object with execute(passEncoder?, context?)
   */
  createViewportQuadCommand(
    fragmentShader: string | CesiumOpaqueShaderSource | { _wgslCode?: string },
    options?: ViewportQuadCommandOptions,
  ): ViewportQuadCommand {
    const device = this._device;
    const opts = (options ?? {}) as ViewportQuadCommandOptions;

    // Determine WGSL code from various input types
    let wgslCode: string | null = null;
    if (typeof fragmentShader === "string") {
      if (
        fragmentShader.includes("@vertex") ||
        fragmentShader.includes("@fragment")
      ) {
        wgslCode = fragmentShader;
      }
    } else if (
      typeof fragmentShader === "object" &&
      fragmentShader !== null &&
      "_wgslCode" in fragmentShader
    ) {
      wgslCode = (fragmentShader as { _wgslCode?: string })._wgslCode as string;
    }

    if (!wgslCode || !device) {
      // GLSL or no device — return noop command
      return {
        execute: () => {},
        shaderProgram: fragmentShader,
        uniformMap: opts.uniformMap || {},
        framebuffer: opts.framebuffer || null,
        owner: opts.owner,
        renderState: opts.renderState,
        pass: opts.pass,
        _isViewportQuadCommand: true,
        destroy: () => {},
      };
    }

    // Lazy-init the viewport quad utility
    if (!this._viewportQuad) {
      this._viewportQuad = new WebGPUViewportQuad(device);
    }

    const targetFormat: GPUTextureFormat =
      this._presentationFormat || "bgra8unorm";

    return this._viewportQuad.createCommand(wgslCode, targetFormat, {
      uniformMap: opts.uniformMap,
      framebuffer: opts.framebuffer,
      owner: opts.owner,
      renderState: opts.renderState,
      pass: opts.pass,
      pipelineConfig: opts.pipelineConfig,
      bindGroupEntries: opts.bindGroupEntries,
    });
  }

  /**
   * Direct access to the WebGPUViewportQuad utility for advanced use cases
   * (targeted render passes, explicit bind groups, etc.).
   */
  get viewportQuad(): WebGPUViewportQuad | null {
    if (!this._viewportQuad && this._device) {
      this._viewportQuad = new WebGPUViewportQuad(this._device);
    }
    return this._viewportQuad;
  }

  /**
   * Gets a viewport quad vertex array (used for full-screen effects) - PRIORITY 2 IMPLEMENTED
   * @returns {CesiumOpaqueVertexArray} A vertex array containing the viewport quad data
   */
  getViewportQuadVertexArray(): CesiumOpaqueVertexArray {
    // Ensure viewport quad is initialized
    if (!this._viewportQuadVertexBuffer) {
      this._initializeViewportQuad();
    }

    return {
      _attributes: [
        {
          index: 0,
          enabled: true,
          vertexBuffer: this._viewportQuadVertexBuffer,
          componentsPerAttribute: 2,
          componentDatatype: 5126, // FLOAT
          normalize: false,
          offsetInBytes: 0,
          strideInBytes: 8, // 2 floats * 4 bytes
        },
      ],
      numberOfVertices: 4,
      // WebGPU-specific: actual buffer for direct access
      _webgpuVertexBuffer: this._viewportQuadVertexBuffer,
    };
  }

  /**
   * Draw command execution - PRIORITY 1 IMPLEMENTED
   * Executes WebGPU draw commands using the current render pass encoder
   * @param {CesiumDrawCommand} drawCommand - The draw command to execute (WebGPUDrawCommand)
   * @param {CesiumPassState} passState - Pass state information
   */
  draw(drawCommand: CesiumDrawCommand, passState?: CesiumPassState): void {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("Context has been destroyed.");
    }
    //>>includeEnd('debug');

    if (!this._currentRenderPassEncoder) {
      this.log("warn", "draw() called without active render pass encoder");
      return;
    }

    // Check if this is a WebGPUDrawCommand
    if (drawCommand && typeof drawCommand.execute === "function") {
      // Execute WebGPU draw command — pass the render pass encoder directly
      // (CesiumDrawCommand.execute has a WebGPU overload accepting
      // GPURenderPassEncoder; see cesium-js-types.d.ts).
      drawCommand.execute(this._currentRenderPassEncoder);

      // Record statistics
      this._drawCallCount++;
      const cmd = drawCommand as CesiumAnyDrawCommand;
      if (cmd.indexCount) {
        this._triangleCount += Math.floor(cmd.indexCount / 3);
      } else if (cmd.vertexCount) {
        this._triangleCount += Math.floor(cmd.vertexCount / 3);
      }
    } else {
      // Legacy draw command - log warning
      this.log(
        "warn",
        "Unsupported draw command format - use WebGPUDrawCommand",
      );
    }
  }

  /**
   * Set viewport - PRIORITY 1 IMPLEMENTED
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {number} width - Width
   * @param {number} height - Height
   */
  setViewport(x: number, y: number, width: number, height: number): void {
    this._viewport = { x, y, width, height };

    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.setViewport(x, y, width, height, 0, 1);
    }
  }

  /**
   * Set scissor rectangle - PRIORITY 1 IMPLEMENTED
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {number} width - Width
   * @param {number} height - Height
   */
  setScissorRect(x: number, y: number, width: number, height: number): void {
    this._scissorRect = { x, y, width, height };
    this._scissorTest = true;

    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.setScissorRect(x, y, width, height);
    }
  }

  /**
   * Disable scissor test - PRIORITY 1 IMPLEMENTED
   */
  disableScissorTest(): void {
    this._scissorTest = false;
    // WebGPU doesn't have a "disable" - set to full viewport
    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.setScissorRect(
        0,
        0,
        this._canvas.width,
        this._canvas.height,
      );
    }
  }

  /**
   * Read pixels from a framebuffer (or the canvas) into a Pixel Buffer Object.
   *
   * This is the primary GPU readback path for WebGPU picking.  The returned
   * PBO handle exposes an async `mapAsync()` that yields a `Uint8Array` of
   * the requested pixel rectangle, and a synchronous `getBufferData(dst)`
   * that copies the (already mapped) data into a caller-supplied typed array
   * — matching the API that `PickFramebuffer.endAsync` expects.
   *
   * @param {object} readState - `{ x, y, width, height, framebuffer }`
   * @returns {object|null} PBO handle with `mapAsync`, `getBufferData`, `destroy`
   */
  readPixelsToPBO(readState: CesiumReadState): PixelReadbackPBO | null {
    if (!this._device || !this._currentCommandEncoder) {
      this.log("warn", "readPixelsToPBO: No active device or command encoder");
      return null;
    }

    const x = readState.x ?? 0;
    const y = readState.y ?? 0;
    const width = readState.width ?? this._canvas.width;
    const height = readState.height ?? this._canvas.height;

    // 256-byte row alignment required by copyTextureToBuffer
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const bufferSize = Math.max(bytesPerRow * height, 4);

    const readbackBuffer = this._device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: "Pixel Readback Buffer",
    });

    // Must end the active render pass before any copy operations
    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.end();
      this._currentRenderPassEncoder = null;
    }

    // Resolve the source GPU texture -----------------------------------------------
    let sourceTexture: GPUTexture | null = null;
    const fb = readState.framebuffer;

    if (fb) {
      // WebGPU FramebufferManager / RenderTarget path
      if (typeof fb.getColorTexture === "function") {
        sourceTexture = fb.getColorTexture(0) ?? null;
      }
      // Legacy WebGL Framebuffer with _colorTextures array
      const colorTextures = fb._colorTextures;
      if (!sourceTexture && colorTextures && colorTextures.length > 0) {
        const ct = colorTextures[0];
        sourceTexture = ct?.texture ?? ct?._texture ?? null;
      }
      // Fallback: object might directly be a GPUTexture
      if (!sourceTexture && fb instanceof GPUTexture) {
        sourceTexture = fb;
      }
    }

    // Default: read from the current canvas texture
    if (!sourceTexture) {
      sourceTexture = this._context?.getCurrentTexture() ?? null;
    }

    if (!sourceTexture) {
      this.log("warn", "readPixelsToPBO: No source texture available");
      readbackBuffer.destroy();
      return null;
    }

    // Issue the texture → buffer copy
    this._currentCommandEncoder.copyTextureToBuffer(
      { texture: sourceTexture, origin: { x, y, z: 0 } },
      { buffer: readbackBuffer, bytesPerRow },
      { width, height, depthOrArrayLayers: 1 },
    );

    // The PBO handle -----------------------------------------------------------------
    let mappedData: Uint8Array | null = null;

    return {
      buffer: readbackBuffer,
      width,
      height,
      bytesPerRow,

      /**
       * Async map — call after the command buffer has been submitted.
       * Returns the raw pixel data as a Uint8Array (with row padding).
       */
      mapAsync: async (): Promise<Uint8Array> => {
        await readbackBuffer.mapAsync(GPUMapMode.READ);
        const arrayBuffer = readbackBuffer.getMappedRange();
        mappedData = new Uint8Array(arrayBuffer.slice(0));
        readbackBuffer.unmap();
        return mappedData;
      },

      /**
       * Synchronous copy of the already-mapped data into a caller-supplied
       * typed array. This is the API PickFramebuffer.endAsync uses via
       * `pbo.getBufferData(pixels)`.  Must call `mapAsync()` first.
       */
      getBufferData: (dst: Uint8Array | Uint16Array | Float32Array): void => {
        if (!mappedData) {
          // Can't use this.log() in closure — use console.warn with prefix
          console.warn(
            "[CesiumJS:webgpu] getBufferData called before mapAsync completed",
          );
          return;
        }
        // Strip row-padding: copy only `width * 4` bytes per row
        const rowBytes = width * 4;
        for (let row = 0; row < height; row++) {
          const srcOff = row * bytesPerRow;
          const dstOff = row * rowBytes;
          dst.set(mappedData.subarray(srcOff, srcOff + rowBytes), dstOff);
        }
      },

      destroy: (): void => {
        mappedData = null;
        readbackBuffer.destroy();
      },
    };
  }

  /**
   * Async convenience wrapper around readPixelsToPBO for one-shot readback.
   *
   * Reads pixels from the specified framebuffer (or canvas), submits the
   * pending commands, maps the readback buffer, and returns the pixel data
   * as a tightly-packed `Uint8Array` (width × height × 4, RGBA).
   *
   * @param {object} readState - `{ x, y, width, height, framebuffer }`
   * @returns {Promise<Uint8Array|null>} RGBA pixel data or null on failure
   */
  async readPixelsAsync(
    readState: CesiumReadState,
  ): Promise<Uint8Array | null> {
    const pbo = this.readPixelsToPBO(readState);
    if (!pbo) {
      return null;
    }

    // Submit the command buffer so the copy actually executes on the GPU
    if (this._currentCommandEncoder) {
      const commandBuffer = this._currentCommandEncoder.finish();
      this._device!.queue.submit([commandBuffer]);
      // Create a fresh encoder for any subsequent operations this frame
      this._currentCommandEncoder = this._device!.createCommandEncoder({
        label: "Post-Readback Command Encoder",
      });
    }

    try {
      const rawData = await pbo.mapAsync();
      // Strip row-alignment padding into a tight RGBA array
      const width = pbo.width;
      const height = pbo.height;
      const result = new Uint8Array(width * height * 4);
      const rowBytes = width * 4;
      for (let row = 0; row < height; row++) {
        const srcOff = row * pbo.bytesPerRow;
        const dstOff = row * rowBytes;
        result.set(rawData.subarray(srcOff, srcOff + rowBytes), dstOff);
      }
      return result;
    } catch (err) {
      this.log("error", `readPixelsAsync failed: ${err}`);
      return null;
    } finally {
      pbo.destroy();
    }
  }

  /**
   * Read pixels from framebuffer (sync).
   *
   * True synchronous readback is impossible in WebGPU.  This shim returns
   * `null` — callers should use `readPixelsToPBO()` + `mapAsync()` for the
   * async path (which is what `PickFramebuffer.endAsync` already does).
   *
   * @param {unknown} readState - Read state configuration
   * @returns {unknown} Always null in WebGPU
   */
  readPixels(_readState: CesiumReadState): Uint8Array | null {
    // Suppress noisy warnings — picking code already has an async path
    return null;
  }

  // createPickId() and getObjectByPickColor() are inherited from GraphicsContext.
  // The shared PickId class provides both `.color` (WebGL) and `.normalizedRgba`
  // (WebGPU) encodings. getObjectByPickColor handles both uint32 and {red,green,blue}
  // calling conventions. No override needed. (FORK-35 fix)

  /**
   * Default framebuffer for the context
   */
  get defaultFramebuffer(): CesiumOpaqueFramebuffer | null {
    return null; // WebGPU doesn't use framebuffer objects like WebGL
  }

  /**
   * WebGPU Context ID
   */
  get id(): string {
    return this._id;
  }

  /**
   * Shader cache for the context
   */
  get shaderCache(): CesiumShaderCache {
    return this._shaderCache;
  }

  /**
   * Texture cache for the context
   */
  get textureCache(): CesiumOpaqueObject {
    return this._textureCache;
  }

  /**
   * Stencil bits available
   */
  get stencilBits(): number {
    return this._stencilBits;
  }

  /**
   * Whether stencil buffer is supported
   */
  get stencilBuffer(): boolean {
    return this._stencilBits >= 8;
  }

  /**
   * Whether antialiasing is enabled
   */
  get antialias(): boolean {
    return this._antialias;
  }

  /**
   * Whether MSAA is supported (always true for WebGPU)
   */
  get msaa(): boolean {
    return true;
  }

  /**
   * Standard derivatives support
   */
  get standardDerivatives(): boolean {
    return this._standardDerivatives;
  }

  /**
   * Float blend support
   */
  get floatBlend(): boolean {
    return this._floatBlend;
  }

  /**
   * Blend minmax support
   */
  get blendMinmax(): boolean {
    return this._blendMinmax;
  }

  /**
   * Element index uint support
   */
  get elementIndexUint(): boolean {
    return this._elementIndexUint;
  }

  /**
   * Color buffer float support
   */
  get colorBufferFloat(): boolean {
    return this._colorBufferFloat;
  }

  /**
   * Color buffer half float support
   */
  get colorBufferHalfFloat(): boolean {
    return this._colorBufferHalfFloat;
  }

  /**
   * Texture filter anisotropic support
   */
  get textureFilterAnisotropic(): boolean {
    return false; // WebGPU doesn't expose this yet
  }

  /**
   * Vertex array object support
   */
  get vertexArrayObject(): boolean {
    return this._vertexArrayObject;
  }

  /**
   * Instanced arrays support
   */
  get instancedArrays(): boolean {
    return this._instancedArrays;
  }

  /**
   * Draw buffers support
   */
  get drawBuffers(): boolean {
    return this._drawBuffers;
  }

  /**
   * Texture LOD support
   */
  get supportsTextureLod(): boolean {
    return this._supportsTextureLod;
  }

  /**
   * Basis texture compression support
   */
  get supportsBasis(): boolean {
    return (
      this._s3tc ||
      this._pvrtc ||
      this._astc ||
      this._etc ||
      this._etc1 ||
      this._bc7
    );
  }

  /**
   * Default 1x1 white texture
   */
  get defaultTexture(): CesiumOpaqueTexture {
    return this._defaultTexture!;
  }

  /**
   * Default 1x1 black emissive texture
   */
  get defaultEmissiveTexture(): CesiumOpaqueTexture | undefined {
    return this._defaultEmissiveTexture;
  }

  /**
   * Default 1x1 normal texture
   */
  get defaultNormalTexture(): CesiumOpaqueTexture | undefined {
    return this._defaultNormalTexture;
  }

  /**
   * Default cube map
   */
  get defaultCubeMap(): CesiumOpaqueTexture | undefined {
    return this._defaultCubeMap;
  }

  /**
   * Clear the framebuffer using a ClearCommand.
   *
   * In WebGPU, clears cannot happen inside an active render pass.
   * To honour a mid-frame clear (e.g., depth-only clear between frustums in
   * multi-frustum rendering) we:
   *   1. End the current render pass.
   *   2. Begin a new render pass where the requested channels use
   *      loadOp:"clear" with the supplied values and all other channels
   *      use loadOp:"load" to preserve existing content.
   *
   * @param {unknown} clearCommand - ClearCommand with optional color, depth, stencil
   * @param {CesiumPassState} passState - PassState (may contain a custom framebuffer)
   */
  // Tracks clear() calls per frame for infinite-loop detection.
  // Reset in beginFrame(). If this exceeds 50, something is re-entering
  // clear recursively — log once and bail to prevent the tab from freezing.
  private _clearCallsThisFrame: number = 0;
  private _clearOverflowWarned: boolean = false;

  clear(clearCommand: CesiumClearCommand, passState?: CesiumPassState): void {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("Context has been destroyed.");
    }
    //>>includeEnd('debug');

    if (!this._device || !this._context || !this._currentCommandEncoder) {
      return;
    }

    const cmd = clearCommand as CesiumClearCommand;
    const ps = passState as CesiumPassState | undefined;

    // ── Infinite-loop guard (permanent, not debug-only) ──
    // BUG-12 proved that a mis-ordered guard can cause clear() to be
    // called hundreds of times per frame, freezing the tab. This counter
    // is cheap (one increment + comparison) and catches the failure mode
    // immediately with a clear error message.
    this._clearCallsThisFrame++;
    if (this._clearCallsThisFrame > 50) {
      if (!this._clearOverflowWarned) {
        this._clearOverflowWarned = true;
        console.error(
          `[CesiumJS:webgpu] clear() called ${this._clearCallsThisFrame}+ ` +
            `times in one frame — likely infinite loop. Breaking. ` +
            `Active pass: "${this._currentRenderPassEncoder?.label ?? "(none)"}". ` +
            `Check FramebufferOrchestrator clear sequence.`,
        );
      }
      return;
    }

    // Nothing to clear
    // Guard against boolean `false` — callers pass { color: false } to mean "don't clear color"
    const wantColor = cmd.color !== undefined && cmd.color !== false;
    const wantDepth = cmd.depth !== undefined && cmd.depth !== false;
    const wantStencil = cmd.stencil !== undefined && cmd.stencil !== false;
    if (!wantColor && !wantDepth && !wantStencil) {
      return;
    }

    // ── Scene framebuffer guard (MUST run BEFORE ending the pass) ──
    //
    // When the WebGPU scene renderer's "Scene Framebuffer" pass is
    // active, ClearCommands must NOT tear it down and replace it with a
    // canvas-targeting clear pass. The scene FB pass was opened with
    // loadOp: "clear", so these clears are redundant.
    //
    // IMPORTANT: this check reads `_currentRenderPassEncoder.label`
    // which is destroyed on the next line. Moving this guard below the
    // `.end()` call made the check always see `null` — which is what
    // caused the original all-black WebGPU output and the recent
    // infinite clear loop (the guard silently became a no-op).
    const activePassLabel = this._currentRenderPassEncoder?.label ?? "";
    if (activePassLabel.startsWith("Scene")) {
      // Scene-owned pass is active — its loadOp already handles the
      // clear. Don't tear it down and replace it with a canvas pass.
      return;
    }

    // End the active render pass so we can start a fresh one with clear ops
    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.end();
      this._currentRenderPassEncoder = null;
    }

    // Build a render pass descriptor that clears only the requested channels
    // and loads (preserves) everything else.
    const colorLoadOp: GPULoadOp = wantColor ? "clear" : "load";
    const depthLoadOp: GPULoadOp = wantDepth ? "clear" : "load";
    const stencilLoadOp: GPULoadOp = wantStencil ? "clear" : "load";

    let colorView = this._currentTextureView;
    let depthStencilView = this._depthTextureView;

    // If the passState or clearCommand specifies a framebuffer, use it
    const fb = ps?.framebuffer ?? cmd.framebuffer;
    if (fb) {
      // Support WebGPURenderTarget / WebGPUFramebufferManager style objects
      if (typeof fb.getColorTextureView === "function") {
        colorView = fb.getColorTextureView(0) ?? colorView;
      }
      if (typeof fb.getDepthStencilTextureView === "function") {
        depthStencilView = fb.getDepthStencilTextureView() ?? depthStencilView;
      } else if (typeof fb.getDepthTextureView === "function") {
        depthStencilView = fb.getDepthTextureView() ?? depthStencilView;
      }
    }

    if (!colorView) {
      return;
    }

    const cc = cmd.color as CesiumColor | undefined;
    const clearColor =
      wantColor && cc
        ? {
            r: cc.red ?? 0.0,
            g: cc.green ?? 0.0,
            b: cc.blue ?? 0.0,
            a: cc.alpha ?? 1.0,
          }
        : { r: 0, g: 0, b: 0, a: 0 };

    const renderPassDescriptor: GPURenderPassDescriptor = {
      label: "ClearCommand Render Pass",
      colorAttachments: [
        {
          view: colorView,
          clearValue: clearColor,
          loadOp: colorLoadOp,
          storeOp: "store",
        },
      ],
      depthStencilAttachment: depthStencilView
        ? {
            view: depthStencilView,
            depthClearValue: wantDepth ? (cmd.depth as number) : 1.0,
            depthLoadOp: depthLoadOp,
            depthStoreOp: "store",
            stencilClearValue: wantStencil ? (cmd.stencil as number) : 0,
            stencilLoadOp: stencilLoadOp,
            stencilStoreOp: "store",
          }
        : undefined,
    };

    // Begin a new pass with the clear ops, then immediately make it the
    // active pass so subsequent draw commands render into it.
    this._currentRenderPassEncoder =
      this._currentCommandEncoder.beginRenderPass(renderPassDescriptor);

    // Restore default viewport / scissor
    this._currentRenderPassEncoder.setViewport(
      0,
      0,
      this._canvas.width,
      this._canvas.height,
      0,
      1,
    );
    this._currentRenderPassEncoder.setScissorRect(
      0,
      0,
      this._canvas.width,
      this._canvas.height,
    );
  }

  /**
   * Resize the drawing buffer
   */
  resize(): void {
    // Canvas resizing is handled automatically by the browser
    // Just need to reconfigure if needed
    if (this._context && this._device && !this._isDestroyed) {
      this._context.configure({
        device: this._device,
        format: this._presentationFormat,
        alphaMode: "opaque",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
    }
  }

  /**
   * Get a string describing the renderer
   *
   * @returns {string} Renderer description
   */
  getRendererString(): string {
    if (!this._adapter) {
      return "WebGPU (Not initialized)";
    }

    const adapterName =
      (this._adapter as GPUAdapter & { name?: string }).name ?? "Unknown GPU";
    return `WebGPU - ${adapterName}`;
  }

  // ====================================================================================
  // GraphicsContext Command Execution Overrides
  // These override the default (WebGL) implementations so Scene.js
  // can dispatch commands without any `isWebGPU` checks.
  // ====================================================================================

  /**
   * WebGPU override: dispatch draw commands through the active render pass encoder.
   * Silently skips non-WebGPU commands (expected during transition).
   */
  override executeDrawCommand(
    command: CesiumAnyDrawCommand,
    _scene: CesiumScene,
    _passState: CesiumPassState,
    _debugFramebuffer?: CesiumOpaqueFramebuffer,
  ): void {
    const renderPass = this._currentRenderPassEncoder;
    if (!renderPass) {
      return;
    }
    if (command.isWebGPUDrawCommand === true) {
      command.execute(renderPass);
    }
    // Non-WebGPU commands are silently skipped (expected during transition)
  }

  /**
   * WebGPU override: execute compute commands that have the WebGPU compute flag.
   * Sun compute is handled procedurally in WebGPUEnvironmentRenderer, so
   * sunComputeCommand is skipped.
   */
  override executeComputeCommands(
    computeCommandList: CesiumComputeCommand[],
    _sunComputeCommand: CesiumComputeCommand | undefined,
    _computeEngine: CesiumOpaqueObject | undefined,
  ): void {
    for (let i = 0; i < computeCommandList.length; ++i) {
      const cmd = computeCommandList[i];
      if (cmd.isWebGPUComputeCommand) {
        cmd.execute(this);
      }
    }
  }

  /**
   * WebGPU override: delegate shadow casting to the SHADOW_MAP feature renderer.
   * Returns true to signal Scene.js that shadow casting was handled.
   */
  override executeShadowMapCastCommands(scene: CesiumScene): boolean {
    const shadowFR = this.getFeatureRenderer(FeatureRendererKey.SHADOW_MAP) as
      | import("../GraphicsContext.js").SystemRenderer
      | undefined;
    if (!shadowFR?.renderCastPass) {
      return true; // Handled (no-op if no shadow renderer registered)
    }
    const { shadowState } = scene.frameState;
    const { shadowMaps } = shadowState;
    const encoder = this._currentCommandEncoder;
    if (!encoder) {
      return true;
    }

    // CSM path: when cascaded shadow maps are enabled, compute splits
    // and render each cascade layer. Lazy-init the CSM renderer.
    const useCSM = scene.useCascadedShadowMaps === true;
    if (useCSM) {
      if (!this._csmRenderer) {
        this._initCSMRenderer();
      }
      const csm = this._csmRenderer;
      const camera = scene.frameState.camera;
      const frustum = camera.frustum;
      csm.computeSplits(frustum.near, frustum.far);
      csm.computeCascadeVPs(
        camera.viewMatrix,
        frustum.projectionMatrix,
        scene.frameState.shadowState?.lightShadowMaps?.[0]?._lightDirectionEC ??
          scene._context?.uniformState?.sunDirectionWC,
      );
    }

    for (let i = 0; i < shadowMaps.length; ++i) {
      const shadowMap = shadowMaps[i];
      if (shadowMap.outOfView) {
        continue;
      }
      // Collect cast commands from all shadow passes.
      const { passes } = shadowMap;
      const castCommands: CesiumAnyDrawCommand[] = [];
      for (let j = 0; j < passes.length; ++j) {
        for (let k = 0; k < passes[j].commandList.length; ++k) {
          castCommands.push(passes[j].commandList[k]);
        }
      }
      for (let j = 0; j < passes.length; ++j) {
        passes[j].commandList.length = 0;
      }
      if (castCommands.length > 0) {
        this.endCurrentRenderPass();

        if (useCSM && this._csmRenderer) {
          // Render into each cascade layer with the cascade's VP matrix.
          const csm = this._csmRenderer;
          const cascadeViews = csm.cascadeViews;
          for (let c = 0; c < cascadeViews.length; c++) {
            // Override the shadow map's VP with the cascade's VP.
            // The existing renderCastPass uses the shadow map's matrix,
            // so we temporarily swap it for each cascade.
            const origMatrix = shadowMap._shadowMapMatrix;
            const cascadeVP = csm.cascades[c].viewProjection;
            shadowMap._shadowMapMatrix = cascadeVP;
            // Point the shadow map's depth texture view to the cascade
            // layer for this pass.
            const origView = shadowMap._webgpuCache?.depthTextureView;
            if (shadowMap._webgpuCache) {
              shadowMap._webgpuCache.depthTextureView = cascadeViews[c];
            }
            shadowFR.renderCastPass(
              encoder,
              shadowMap,
              scene._frameState,
              castCommands,
            );
            // Restore originals.
            shadowMap._shadowMapMatrix = origMatrix;
            if (shadowMap._webgpuCache) {
              shadowMap._webgpuCache.depthTextureView = origView;
            }
          }
        } else {
          // Single shadow map path (default).
          shadowFR.renderCastPass(
            encoder,
            shadowMap,
            scene._frameState,
            castCommands,
          );
        }

        this.resumeDefaultRenderPass();
      }
    }
    return true;
  }

  /**
   * WebGPU override: set environment state flags and clear with background color.
   * Returns true to signal Scene.js that framebuffer setup was handled.
   */
  override updateAndClearFramebuffers(
    scene: CesiumScene,
    passState: CesiumPassState,
    clearColor: CesiumColor,
  ): boolean {
    const frameState = scene._frameState;
    const environmentState = scene._environmentState;
    const passes = frameState.passes;
    const picking = passes.pick || passes.pickVoxel;

    environmentState.originalFramebuffer = passState.framebuffer;

    const globe = scene._globe;
    environmentState.clearGlobeDepth =
      defined(globe) &&
      globe.show &&
      (!globe.depthTestAgainstTerrain ||
        scene.mode === 1) /* SceneMode.SCENE2D */;
    environmentState.useDepthPlane =
      environmentState.clearGlobeDepth &&
      scene.mode === 3 /* SceneMode.SCENE3D */ &&
      scene._globeTranslucencyState.useDepthPlane;
    environmentState.useGlobeDepthFramebuffer = false;

    environmentState.useOIT =
      !picking && scene._useOIT && defined(scene._alternateSceneRenderer);

    const postProcess = scene.postProcessStages;
    // WebGPU always needs the post-process pipeline active because the
    // scene renders to an offscreen framebuffer — the post-process
    // tonemapping/blit pass is the ONLY path that composites the scene
    // color to the canvas surface texture. Without it the canvas stays
    // black. The WebGL path can render directly to the canvas when
    // post-processing is off, but WebGPU cannot.
    environmentState.usePostProcess = !picking;
    environmentState.usePostProcessSelected = false;

    environmentState.useInvertClassification =
      !picking && scene.invertClassification;
    environmentState.renderTranslucentDepthForPick = false;
    environmentState.useWebVR =
      scene._useWebVR &&
      scene.mode !== 1 /* SceneMode.SCENE2D */ &&
      !passes.offscreen;

    const clear = scene._clearColorCommand;
    Color.clone(clearColor, clear.color);
    clear.execute(this, passState);
    return true;
  }

  /**
   * WebGPU override: no-op for now (OIT composite and post-processing
   * are not yet wired for WebGPU). Returns true to skip WebGL path.
   */
  /**
   * WebGPU override: create a WebGPUPickFramebuffer for GPU-based picking.
   * View.js calls this factory instead of directly importing WebGPUPickFramebuffer.
   */
  override createPickFramebuffer(): WebGPUPickFramebuffer {
    return new WebGPUPickFramebuffer(this);
  }

  override resolveFramebuffers(
    _scene: CesiumScene,
    _passState: CesiumPassState,
  ): boolean {
    return true;
  }

  /**
   * Destroy the context and free all resources
   */
  destroy(): void {
    if (this._isDestroyed) {
      return;
    }

    // Unregister from the global ContextRegistry before destroying resources
    this._unregisterFromRegistry();
    this._destroyFeatureRenderers();

    // Destroy device
    if (this._device) {
      this._device.destroy();
      this._device = null;
    }

    // Clear caches
    this._samplerCache.clear();
    this._bindGroupLayoutCache.clear();
    this._bindGroupCache.clear();

    // Destroy viewport quad utility
    if (this._viewportQuad) {
      this._viewportQuad.destroy();
      this._viewportQuad = null;
    }

    // Clear buffer pools
    this._bufferPool.clear();
    this._uniformBufferPool = [];

    // Destroy mipmap generator
    if (this._mipmapGenerator) {
      this._mipmapGenerator.destroy();
      this._mipmapGenerator = null;
    }

    // Destroy advanced infrastructure singletons
    if (this._renderBundleManager) {
      this._renderBundleManager.destroy();
      this._renderBundleManager = null;
    }
    if (this._timestampProfiler) {
      this._timestampProfiler.destroy();
      this._timestampProfiler = null;
    }
    if (this._storageBufferPool) {
      this._storageBufferPool.destroy();
      this._storageBufferPool = null;
    }
    if (this._indirectDrawManager) {
      this._indirectDrawManager.destroy();
      this._indirectDrawManager = null;
    }
    if (this._gpuCuller) {
      this._gpuCuller.destroy();
      this._gpuCuller = null;
    }
    if (this._bufferMapper) {
      this._bufferMapper.destroy();
      this._bufferMapper = null;
    }

    // Clear references
    this._adapter = null;
    this._context = null;
    this._isDestroyed = true;
  }

  // ====================================================================================
  // WebGL to WebGPU State Conversion Helpers
  // Delegates to standalone functions in WebGLStateConverters.ts
  // ====================================================================================

  /** Convert WebGL blend factor to WebGPU blend factor. @private */
  private _webglToWebGPUBlendFactor(f: number): GPUBlendFactor {
    return webglToWebGPUBlendFactor(f);
  }

  /** Convert WebGL blend operation to WebGPU blend operation. @private */
  private _webglToWebGPUBlendOp(o: number): GPUBlendOperation {
    return webglToWebGPUBlendOp(o);
  }

  /** Convert WebGL compare function to WebGPU compare function. @private */
  private _webglToWebGPUCompareFunction(f: number): GPUCompareFunction {
    return webglToWebGPUCompareFunction(f);
  }

  /**
   * Get current pipeline state for pipeline creation
   * @returns {object} Current pipeline state
   */
  getPipelineState(): WebGPUPipelineStateSnapshot {
    return {
      depthStencil: this._depthTestEnabled
        ? {
            format: this._depthFormat,
            depthWriteEnabled: this._depthWriteEnabled,
            depthCompare: this._depthCompare,
          }
        : undefined,
      blend: this._blendEnabled
        ? {
            color: {
              srcFactor: this._blendSrc,
              dstFactor: this._blendDst,
              operation: this._blendOp,
            },
            alpha: {
              srcFactor: this._blendSrcAlpha,
              dstFactor: this._blendDstAlpha,
              operation: this._blendOpAlpha,
            },
          }
        : undefined,
      primitive: {
        cullMode: this._cullFaceEnabled ? this._cullMode : "none",
        frontFace: this._frontFace,
      },
      colorWriteMask: this._colorWriteMask,
    };
  }

  // ====================================================================================
  // WebGPU-Specific Utility Methods (for actual WebGPU rendering)
  // ====================================================================================

  /**
   * Get or create a cached sampler
   * @param {GPUSamplerDescriptor} descriptor - Sampler descriptor
   * @returns {GPUSampler} The sampler
   */
  getOrCreateSampler(descriptor: GPUSamplerDescriptor): GPUSampler | null {
    if (!this._device) {
      return null;
    }

    const key = JSON.stringify(descriptor);
    let sampler = this._samplerCache.get(key);

    if (!sampler) {
      sampler = this._device.createSampler(descriptor);
      this._samplerCache.set(key, sampler);
    }

    return sampler;
  }

  /**
   * Get or create a cached bind group layout
   * @param {GPUBindGroupLayoutDescriptor} descriptor - Bind group layout descriptor
   * @returns {GPUBindGroupLayout} The bind group layout
   */
  getOrCreateBindGroupLayout(
    descriptor: GPUBindGroupLayoutDescriptor,
  ): GPUBindGroupLayout | null {
    if (!this._device) {
      return null;
    }

    const key = JSON.stringify(descriptor);
    let layout = this._bindGroupLayoutCache.get(key);

    if (!layout) {
      layout = this._device.createBindGroupLayout(descriptor);
      this._bindGroupLayoutCache.set(key, layout);
    }

    return layout;
  }

  /**
   * Create a bind group (not cached, as they contain buffer references that change)
   * @param {GPUBindGroupDescriptor} descriptor - Bind group descriptor
   * @returns {GPUBindGroup} The bind group
   */
  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup | null {
    if (!this._device) {
      return null;
    }

    return this._device.createBindGroup(descriptor);
  }

  /**
   * Get a uniform buffer from the pool or create a new one - PRIORITY 3 ENHANCED
   * @param {number} size - Size in bytes
   * @returns {GPUBuffer | null} A uniform buffer
   */
  getUniformBuffer(size: number): GPUBuffer | null {
    if (!this._device) {
      return null;
    }

    // Guard against zero or negative sizes
    size = Math.max(size, 4);
    // Align size to 256 bytes (uniform buffer alignment requirement)
    const alignedSize = Math.ceil(size / 256) * 256;

    // Try to reuse from pool - find best fit
    const availableBuffer = this._uniformBufferPool.find(
      (buf) => buf.size >= alignedSize && buf.size < alignedSize * 2, // Don't waste too much memory
    );

    if (availableBuffer) {
      const index = this._uniformBufferPool.indexOf(availableBuffer);
      this._uniformBufferPool.splice(index, 1);
      return availableBuffer;
    }

    // Create new buffer
    return this._device.createBuffer({
      size: alignedSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: `Uniform Buffer (Pooled, ${alignedSize} bytes)`,
    });
  }

  /**
   * Return a uniform buffer to the pool for reuse - PRIORITY 3 ENHANCED
   * @param {GPUBuffer} buffer - The buffer to return
   */
  returnUniformBuffer(buffer: GPUBuffer): void {
    if (buffer && this._uniformBufferPool.length < 100) {
      // Limit pool size
      this._uniformBufferPool.push(buffer);
    } else if (buffer && this._uniformBufferPool.length >= 100) {
      // Pool is full - destroy the buffer
      buffer.destroy();
    }
  }

  /**
   * Get a buffer from the general buffer pool - PRIORITY 3 NEW
   * @param {string} type - Buffer type ('vertex', 'index', 'storage')
   * @param {number} size - Size in bytes
   * @param {GPUBufferUsageFlags} usage - Buffer usage flags
   * @returns {GPUBuffer | null} A buffer from the pool or newly created
   */
  getPooledBuffer(
    type: string,
    size: number,
    usage: GPUBufferUsageFlags,
  ): GPUBuffer | null {
    if (!this._device) {
      return null;
    }

    const pool = this._bufferPool.get(type) || [];
    const availableBuffer = pool.find(
      (buf) => buf.size >= size && buf.size < size * 2,
    );

    if (availableBuffer) {
      const index = pool.indexOf(availableBuffer);
      pool.splice(index, 1);
      this._bufferPool.set(type, pool);
      return availableBuffer;
    }

    // Create new buffer — guard against zero size
    const safeSize = Math.max(size, 4);
    return this._device.createBuffer({
      size: safeSize,
      usage,
      label: `${type} Buffer (Pooled, ${safeSize} bytes)`,
    });
  }

  /**
   * Return a buffer to the general buffer pool - PRIORITY 3 NEW
   * @param {string} type - Buffer type ('vertex', 'index', 'storage')
   * @param {GPUBuffer} buffer - The buffer to return
   */
  returnPooledBuffer(type: string, buffer: GPUBuffer): void {
    if (!buffer) {
      return;
    }

    const pool = this._bufferPool.get(type) || [];

    if (pool.length < 50) {
      // Limit per-type pool size
      pool.push(buffer);
      this._bufferPool.set(type, pool);
    } else {
      // Pool full - destroy buffer
      buffer.destroy();
    }
  }

  /**
   * Check if texture compression format is supported - PRIORITY 3 NEW
   * @param {string} format - Compression format name ('bc7', 'astc', 'etc2')
   * @returns {boolean} Whether the format is supported
   */
  supportsTextureCompression(format: string): boolean {
    if (!this._device) {
      return false;
    }

    // Map format names to WebGPU texture compression features
    const featureMap: Record<string, GPUFeatureName> = {
      bc7: "texture-compression-bc",
      astc: "texture-compression-astc",
      etc2: "texture-compression-etc2",
    };

    const feature = featureMap[format.toLowerCase()];
    if (!feature) {
      return false;
    }

    return this._device.features.has(feature);
  }

  /**
   * Get supported texture compression formats - PRIORITY 3 NEW
   * @returns {string[]} Array of supported compression format names
   */
  getSupportedCompressionFormats(): string[] {
    if (!this._device) {
      return [];
    }

    const formats: string[] = [];

    if (this._device.features.has("texture-compression-bc")) {
      formats.push("bc7", "s3tc");
      this._s3tc = true;
      this._bc7 = true;
    }

    if (this._device.features.has("texture-compression-astc")) {
      formats.push("astc");
      this._astc = true;
    }

    if (this._device.features.has("texture-compression-etc2")) {
      formats.push("etc2", "etc");
      this._etc = true;
    }

    return formats;
  }

  /**
   * Copy texture to texture (texture copy operation) - PRIORITY 1 NEW
   * Equivalent to WebGL's copyTexImage2D / copyTexSubImage2D
   * @param {GPUTexture} source - Source texture
   * @param {GPUTexture} destination - Destination texture
   * @param {GPUOrigin3D} [sourceOrigin] - Source origin (default: {x: 0, y: 0, z: 0})
   * @param {GPUOrigin3D} [destinationOrigin] - Destination origin (default: {x: 0, y: 0, z: 0})
   * @param {GPUExtent3D} [copySize] - Copy size (default: source texture size)
   *
   * @example
   * // Copy entire texture
   * context.copyTexture(sourceTexture, destTexture);
   *
   * // Copy region
   * context.copyTexture(
   *   sourceTexture, destTexture,
   *   { x: 64, y: 64, z: 0 },
   *   { x: 0, y: 0, z: 0 },
   *   { width: 128, height: 128 }
   * );
   */
  copyTexture(
    source: GPUTexture,
    destination: GPUTexture,
    sourceOrigin?: GPUOrigin3D,
    destinationOrigin?: GPUOrigin3D,
    copySize?: GPUExtent3D,
  ): void {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("Context has been destroyed.");
    }
    if (!this._currentCommandEncoder) {
      throw new DeveloperError(
        "No active command encoder. Call beginFrame() first.",
      );
    }
    //>>includeEnd('debug');

    // Default values
    const srcOrigin = sourceOrigin ?? { x: 0, y: 0, z: 0 };
    const dstOrigin = destinationOrigin ?? { x: 0, y: 0, z: 0 };
    const size = copySize ?? {
      width: source.width,
      height: source.height,
      depthOrArrayLayers: 1,
    };

    // Perform copy
    this._currentCommandEncoder.copyTextureToTexture(
      {
        texture: source,
        origin: srcOrigin,
      },
      {
        texture: destination,
        origin: dstOrigin,
      },
      size,
    );
  }

  /**
   * Copy texture region with convenience wrapper - PRIORITY 1 NEW
   * Simplified version of copyTexture for common use cases
   * @param {GPUTexture} source - Source texture
   * @param {GPUTexture} destination - Destination texture
   * @param {number} srcX - Source X coordinate
   * @param {number} srcY - Source Y coordinate
   * @param {number} dstX - Destination X coordinate
   * @param {number} dstY - Destination Y coordinate
   * @param {number} width - Copy width
   * @param {number} height - Copy height
   *
   * @example
   * context.copyTextureRegion(sourceTexture, destTexture, 64, 64, 0, 0, 128, 128);
   */
  copyTextureRegion(
    source: GPUTexture,
    destination: GPUTexture,
    srcX: number,
    srcY: number,
    dstX: number,
    dstY: number,
    width: number,
    height: number,
  ): void {
    this.copyTexture(
      source,
      destination,
      { x: srcX, y: srcY, z: 0 },
      { x: dstX, y: dstY, z: 0 },
      { width, height, depthOrArrayLayers: 1 },
    );
  }

  /**
   * Create a texture from image data - PRIORITY 3 NEW
   * Helper method for common texture creation from images.
   *
   * Synchronous fast path: copies the source as-is via
   * `queue.copyExternalImageToTexture`. This does NOT respect EXIF orientation
   * — for `HTMLImageElement` decoded from a JPEG with a non-trivial Orientation
   * tag, the GPU sees pixels in their unrotated layout. If the caller needs
   * orientation handling, route through {@link createTextureFromImageAsync}
   * which uses the WGF-8 `WebGPUImageUpload` helper to bake EXIF rotation in
   * via `createImageBitmap`.
   *
   * @param {ImageBitmap | HTMLImageElement | HTMLCanvasElement} source - Image source
   * @param {GPUTextureFormat} [format='rgba8unorm'] - Texture format
   * @param {boolean} [generateMipmaps=false] - Whether to generate mipmaps
   * @returns {WebGPUTexture | null} The created texture
   */
  createTextureFromImage(
    source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
    format: GPUTextureFormat = "rgba8unorm",
    generateMipmaps: boolean = false,
  ): WebGPUTexture | null {
    if (!this._device) {
      return null;
    }

    const width =
      "width" in source ? source.width : (source as HTMLCanvasElement).width;
    const height =
      "height" in source ? source.height : (source as HTMLCanvasElement).height;
    const mipLevelCount = generateMipmaps
      ? Math.floor(Math.log2(Math.max(width, height))) + 1
      : 1;

    const texture = WebGPUTexture.create2D(
      this._device,
      width,
      height,
      format,
      mipLevelCount,
      "Texture from Image",
    );

    // Copy image to texture using queue.copyExternalImageToTexture
    if (this._device.queue) {
      this._device.queue.copyExternalImageToTexture(
        { source: source as ImageBitmap },
        { texture: texture.texture },
        { width, height },
      );
    }

    // Generate mipmaps if requested and texture has multiple mip levels
    if (generateMipmaps && mipLevelCount > 1) {
      texture.generateMipmaps(this.mipmapGenerator);
    }

    return texture;
  }

  /**
   * Async variant of {@link createTextureFromImage} that routes through the
   * WGF-8 {@link WebGPUImageUpload} helper. Use this when the source is an
   * `HTMLImageElement` or `Blob` that may carry EXIF orientation metadata
   * (rotated phone photos, scanned documents) — the helper decodes through
   * `createImageBitmap({ imageOrientation: "from-image" })` so the resulting
   * texture pixels are upright.
   *
   * Allocates the destination texture *before* awaiting the decode so callers
   * that need a placeholder ID immediately can chain off the returned promise
   * without an extra round trip.
   */
  async createTextureFromImageAsync(
    source:
      | ImageBitmap
      | HTMLImageElement
      | HTMLCanvasElement
      | OffscreenCanvas
      | Blob,
    format: GPUTextureFormat = "rgba8unorm",
    generateMipmaps: boolean = false,
    options: {
      flipY?: boolean;
      premultipliedAlpha?: boolean;
      respectEXIF?: boolean;
    } = {},
  ): Promise<WebGPUTexture | null> {
    if (!this._device) {
      return null;
    }

    const { WebGPUImageUpload } = await import("./WebGPUImageUpload.js");
    const decoded = await WebGPUImageUpload.decodeWithOrientation(source);

    // After EXIF rotation the bitmap dimensions can be swapped (90°/270°), so
    // pull width/height from the decoded surface, not the original source.
    const width = (decoded as { width: number }).width;
    const height = (decoded as { height: number }).height;
    const mipLevelCount = generateMipmaps
      ? Math.floor(Math.log2(Math.max(width, height))) + 1
      : 1;

    const texture = WebGPUTexture.create2D(
      this._device,
      width,
      height,
      format,
      mipLevelCount,
      "Texture from Image (async)",
    );

    await WebGPUImageUpload.uploadImageToTexture(
      this._device,
      decoded,
      texture.texture,
      {
        respectEXIF: false, // already decoded above
        flipY: options.flipY,
        premultipliedAlpha: options.premultipliedAlpha,
      },
    );

    if (generateMipmaps && mipLevelCount > 1) {
      texture.generateMipmaps(this.mipmapGenerator);
    }

    return texture;
  }

  /**
   * Create a staging buffer for data upload - PRIORITY 3 NEW
   * @param {number} size - Size in bytes
   * @returns {GPUBuffer | null} A staging buffer
   */
  createStagingBuffer(size: number): GPUBuffer | null {
    if (!this._device) {
      return null;
    }

    // Guard against zero size
    const safeSize = Math.max(size, 4);
    return this._device.createBuffer({
      size: safeSize,
      usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
      label: "Staging Buffer",
    });
  }

  /**
   * Gets or lazily creates the shared mipmap generator for this context.
   * The generator caches its shader module and pipelines per texture format
   * so repeated mipmap generation is efficient.
   *
   * @returns {WebGPUMipmapGenerator} The mipmap generator
   */
  get mipmapGenerator(): WebGPUMipmapGenerator {
    if (!this._mipmapGenerator && this._device) {
      this._mipmapGenerator = new WebGPUMipmapGenerator(this._device);
    }
    return this._mipmapGenerator!;
  }

  // ====================================================================================
  // Advanced Infrastructure — Lazy-Initialized Singletons
  // These are exposed via getters and created on first access.
  // ====================================================================================

  private _renderBundleManager: WebGPURenderBundleManager | null = null;
  private _timestampProfiler: WebGPUTimestampProfiler | null = null;
  private _storageBufferPool: WebGPUStorageBufferPool | null = null;
  private _indirectDrawManager: WebGPUIndirectDrawManager | null = null;
  private _bufferMapper: WebGPUBufferMapper | null = null;
  private _performanceManager: WebGPUPerformanceManager | null = null;
  private _uniformAllocator: WebGPURingBufferAllocator | null = null;
  private _gpuCuller: GPUCullerInstance | null = null;
  private _gpuCullerInitializing: boolean = false;
  private _csmRenderer: WebGPUCSMRenderer | null = null;

  /**
   * Ring buffer allocator for per-frame uniform buffer suballocation.
   * Reduces GPU memory fragmentation by suballocating from pre-created pages
   * instead of creating new buffers each frame. Triple-buffered (3 pages).
   * Lazy-initialized on first access.
   */
  get uniformAllocator(): WebGPURingBufferAllocator | null {
    if (!this._uniformAllocator && this._device) {
      this._uniformAllocator = new WebGPURingBufferAllocator(this._device, {
        pageSize: 4 * 1024 * 1024, // 4MB per page
        pageCount: 3, // Triple-buffered
        minAlignment: 256, // WebGPU uniform buffer offset alignment
        label: "Uniform ring buffer",
      });
    }
    return this._uniformAllocator;
  }

  /**
   * Performance manager that orchestrates all WebGPU performance infrastructure:
   * render bundles, indirect drawing, GPU culling, timestamp profiling, buffer mapping.
   * Lazy-initialized on first access. Configure via `performanceManager.config`.
   */
  get performanceManager(): WebGPUPerformanceManager {
    if (!this._performanceManager) {
      // WebGPUPerformanceManager is partially implemented: its
      // PerformanceManagerContext interface declares the full intended
      // API (appendDraw, buildAndSubmit, beginPass/endPass, etc.) that
      // WebGPUContext will satisfy once IndirectDrawManager and
      // TimestampProfiler are completed. Until then, the structural
      // mismatch is real and the cast bridges the in-progress gap.
      this._performanceManager = new WebGPUPerformanceManager(
        this as unknown as ConstructorParameters<
          typeof WebGPUPerformanceManager
        >[0],
      );
    }
    return this._performanceManager;
  }

  /**
   * Render bundle manager for caching static geometry draw calls.
   * Pre-encodes draw commands for terrain tiles, buildings, etc.
   * Gives 50-80% CPU reduction for static geometry.
   */
  get renderBundleManager(): WebGPURenderBundleManager | null {
    if (!this._renderBundleManager && this._device) {
      this._renderBundleManager = new WebGPURenderBundleManager(this._device);
    }
    return this._renderBundleManager;
  }

  /**
   * Phase 6 debug surface — overrides {@link GraphicsContext#getRendererStatistics}
   * to expose WebGPU-specific introspection: bundle cache state, fog
   * froxel grid state, GPU memory pool usage, indirect draw counters,
   * etc. Pure read; safe to call from `Scene.getDebugSnapshot()` even
   * when Scene code can't import from `Renderer/WebGPU/`.
   *
   * Most fields are populated lazily — they only return non-empty data
   * once the corresponding subsystem has been touched at least once
   * during a frame. Callers should treat every field as optional.
   */
  override getRendererStatistics(): DebugStatsObject {
    const stats: { [k: string]: DebugStatsValue | undefined } = {
      backend: "webgpu",
      contextId: this._id,
      hasDevice: !!this._device,
      isDestroyed: this.isDestroyed(),
    };
    if (this._renderBundleManager) {
      try {
        stats.bundleManager = this._renderBundleManager.statistics;
      } catch (e) {
        stats.bundleManager = { error: String((e as Error)?.message ?? e) };
      }
    }
    if (this._performanceManager) {
      // The perf manager exposes a `getFrameTimings()` method that
      // returns the per-pass GPU timing snapshot. Call it defensively
      // because it may not be wired in every code path.
      try {
        const pm = this._performanceManager as unknown as {
          getFrameTimings?: () => DebugStatsObject;
        };
        if (typeof pm.getFrameTimings === "function") {
          stats.performance = pm.getFrameTimings();
        }
      } catch (e) {
        stats.performance = { error: String((e as Error)?.message ?? e) };
      }
    }
    if (this._timestampProfiler) {
      try {
        const tp = this._timestampProfiler;
        if (tp && typeof tp.getResults === "function") {
          // ProfilingResults extends DebugStatsObject at source, so this
          // assigns directly with no cast.
          stats.timestamps = tp.getResults();
        }
      } catch (e) {
        stats.timestamps = { error: String((e as Error)?.message ?? e) };
      }
    }
    if (this._indirectDrawManager) {
      stats.indirectDraw = {
        drawCount: this._indirectDrawManager.drawCount ?? 0,
      };
    }
    // Volumetric fog renderer is wired through the feature renderer
    // registry, not a direct context field. Pull it via the standard
    // dispatch path so the lookup respects the lazy load contract.
    try {
      const fogFR = this.getFeatureRenderer(
        FeatureRendererKey.VOLUMETRIC_FOG,
      ) as
        | (CesiumFeatureRenderer & { getStatistics?: () => DebugStatsObject })
        | undefined;
      if (fogFR && typeof fogFR.getStatistics === "function") {
        stats.volumetricFog = fogFR.getStatistics();
      }
    } catch (e) {
      stats.volumetricFog = { error: String((e as Error)?.message ?? e) };
    }
    // Phase 3 — Hi-Z occlusion + GPU sort keys diagnostic snapshots.
    try {
      const hiZFR = this.getFeatureRenderer(
        FeatureRendererKey.HI_Z_OCCLUSION,
      ) as
        | (CesiumFeatureRenderer & { getStatistics?: () => DebugStatsObject })
        | undefined;
      if (hiZFR && typeof hiZFR.getStatistics === "function") {
        stats.hiZOcclusion = hiZFR.getStatistics();
      }
    } catch (e) {
      stats.hiZOcclusion = { error: String((e as Error)?.message ?? e) };
    }
    try {
      const sortFR = this.getFeatureRenderer(
        FeatureRendererKey.GPU_SORT_KEYS,
      ) as
        | (CesiumFeatureRenderer & { getStatistics?: () => DebugStatsObject })
        | undefined;
      if (sortFR && typeof sortFR.getStatistics === "function") {
        stats.gpuSortKeys = sortFR.getStatistics();
      }
    } catch (e) {
      stats.gpuSortKeys = { error: String((e as Error)?.message ?? e) };
    }
    // Point cloud sort dispatcher stats.
    try {
      const pcSortFR = this.getFeatureRenderer(
        FeatureRendererKey.POINT_CLOUD_SORT,
      ) as
        | (CesiumFeatureRenderer & { getStatistics?: () => DebugStatsObject })
        | undefined;
      if (pcSortFR && typeof pcSortFR.getStatistics === "function") {
        stats.pointCloudSort = pcSortFR.getStatistics();
      }
    } catch (e) {
      stats.pointCloudSort = { error: String((e as Error)?.message ?? e) };
    }
    // CSM renderer stats.
    if (this._csmRenderer) {
      try {
        stats.csmShadows = this._csmRenderer.getStatistics();
      } catch (e) {
        stats.csmShadows = { error: String((e as Error)?.message ?? e) };
      }
    }
    // Phase 5 — capability snapshot. Lists every WebGPU optional
    // feature the device negotiated successfully so an operator can
    // confirm at a glance what's available on this adapter. The list
    // is the source of truth for "can I wire shader-f16 yet" decisions.
    stats.capabilities = {
      enabledFeatures: this.enabledFeatures,
      hasShaderF16: this.hasFeature("shader-f16"),
      hasDualSourceBlending: this.hasFeature("dual-source-blending"),
      hasClipDistances: this.hasFeature("clip-distances"),
      useHardwareClipDistances: this.useHardwareClipDistances,
      useShaderF16: this.useShaderF16,
      hasTimestampQuery: this.hasFeature("timestamp-query"),
      hasIndirectFirstInstance: this.hasFeature("indirect-first-instance"),
      hasFloat32Filterable: this.hasFeature("float32-filterable"),
      hasSubgroups: this.hasFeature("subgroups"),
      hasBgra8UnormStorage: this.hasFeature("bgra8unorm-storage"),
    };
    return stats;
  }

  /**
   * GPU timestamp profiler for measuring render pass durations.
   * Requires 'timestamp-query' feature to be enabled.
   */
  get timestampProfiler(): WebGPUTimestampProfiler | null {
    if (
      !this._timestampProfiler &&
      this._device &&
      this.hasFeature("timestamp-query")
    ) {
      this._timestampProfiler = new WebGPUTimestampProfiler(this._device);
    }
    return this._timestampProfiler;
  }

  /**
   * Storage buffer pool for compute shader inputs/outputs and large datasets.
   * Pre-allocates and reuses GPU storage buffers.
   */
  get storageBufferPool(): WebGPUStorageBufferPool | null {
    if (!this._storageBufferPool && this._device) {
      this._storageBufferPool = new WebGPUStorageBufferPool(this._device);
    }
    return this._storageBufferPool;
  }

  /**
   * Indirect draw manager for GPU-driven rendering.
   * Writes draw parameters from compute shaders for drawIndirect/drawIndexedIndirect.
   */
  get indirectDrawManager(): WebGPUIndirectDrawManager | null {
    if (!this._indirectDrawManager && this._device) {
      this._indirectDrawManager = new WebGPUIndirectDrawManager(this._device);
    }
    return this._indirectDrawManager;
  }

  /**
   * Buffer mapper for async CPU↔GPU buffer access.
   * Manages mapAsync/getMappedRange for readback and upload.
   */
  get bufferMapper(): WebGPUBufferMapper | null {
    if (!this._bufferMapper && this._device) {
      this._bufferMapper = new WebGPUBufferMapper(this._device);
    }
    return this._bufferMapper;
  }

  /**
   * GPU frustum culler for compute-shader-based visibility testing.
   * Lazy-initialized on first access. Async init loads the FrustumCull.wgsl shader.
   * @returns The culler instance (may not be initialized yet — check .initialized)
   */
  get gpuCuller(): GPUCullerInstance | null {
    if (!this._gpuCuller && this._device && !this._gpuCullerInitializing) {
      this._gpuCullerInitializing = true;
      import("./WebGPUGPUCuller.js").then(({ WebGPUGPUCuller }) => {
        const culler = new WebGPUGPUCuller(this._device!, {
          maxObjects: 65536,
          label: `ctx-${this._id}`,
        });
        import("../../Shaders/WebGPU/Compute/FrustumCull.js")
          .then((mod: { default?: string | object }) => {
            const code = mod.default || mod;
            return culler.initialize(typeof code === "string" ? code : "");
          })
          .then(() => {
            this._gpuCuller = culler;
            this._gpuCullerInitializing = false;
          })
          .catch((e: unknown) => {
            console.warn(
              `[CesiumJS:webgpu:ctx-${this._id}] GPU culler init failed:`,
              e,
            );
            this._gpuCullerInitializing = false;
          });
      });
    }
    return this._gpuCuller;
  }

  /**
   * Get frame statistics
   * @returns {object} Statistics object
   */
  getStatistics(): WebGPUFrameStatistics {
    return {
      frameCount: this._frameCount,
      drawCallCount: this._drawCallCount,
      triangleCount: this._triangleCount,
      samplerCacheSize: this._samplerCache.size,
      bindGroupLayoutCacheSize: this._bindGroupLayoutCache.size,
      uniformBufferPoolSize: this._uniformBufferPool.length,
    };
  }

  /**
   * Reset frame statistics
   */
  resetStatistics(): void {
    this._frameCount = 0;
    this._drawCallCount = 0;
    this._triangleCount = 0;
  }

  /**
   * Increment draw call counter
   * @param {number} triangles - Number of triangles drawn
   */
  recordDrawCall(triangles: number = 0): void {
    this._drawCallCount++;
    this._triangleCount += triangles;
  }

  // ====================================================================================
  // Device Loss Recovery — FORK-1 fix: delegated to WebGPUDeviceLossRecovery
  // Previously ~150 lines of duplicated inline logic. Now uses the standalone
  // recovery module with the DeviceLossRecoveryHost interface pattern.
  // ====================================================================================

  /**
   * Set up device loss handler by creating and configuring a
   * WebGPUDeviceLossRecovery instance that implements all recovery logic.
   * @private
   */
  private _setupDeviceLostHandler(): void {
    if (!this._device) return;

    // Create the recovery host adapter that maps host interface to our methods
    const host: DeviceLossRecoveryHost = {
      get _adapter() {
        return self._adapter;
      },
      get _device() {
        return self._device;
      },
      get _isDestroyed() {
        return self._isDestroyed;
      },
      set _isDestroyed(v: boolean) {
        self._isDestroyed = v;
      },
      get _options() {
        return self._options;
      },
      get _context() {
        return self._context;
      },
      _setAdapter: (adapter: GPUAdapter) => {
        this._adapter = adapter;
      },
      _setDevice: (device: GPUDevice) => {
        this._device = device;
      },
      _initializeContextLimits: () => this._initializeContextLimits(),
      _reconfigureCanvas: () => this._reconfigureCanvas(),
      _initializeDefaultTextures: () => this._initializeDefaultTextures(),
      _clearAllCaches: () => this._clearAllCaches(),
    };
    const self = this;

    this._deviceLossRecovery = new WebGPUDeviceLossRecovery(host, 3);
    this._deviceLossRecovery.setupHandler(this._device);
  }

  /**
   * Re-configure the canvas context after device loss recovery.
   * Called by WebGPUDeviceLossRecovery via the DeviceLossRecoveryHost interface.
   * @private
   */
  private _reconfigureCanvas(): void {
    if (this._context && this._device) {
      this._presentationFormat = navigator.gpu.getPreferredCanvasFormat();
      this._context.configure({
        device: this._device,
        format: this._presentationFormat,
        alphaMode: "opaque",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
    }
  }

  /**
   * Clear all stale GPU caches after device loss recovery.
   * Called by WebGPUDeviceLossRecovery via the DeviceLossRecoveryHost interface.
   * @private
   */
  private _clearAllCaches(): void {
    this._samplerCache.clear();
    this._bindGroupLayoutCache.clear();
    this._bindGroupCache.clear();
    this._bufferPool.clear();
    this._uniformBufferPool = [];
    this._depthTexture = null;
    this._depthTextureView = null;
    this._viewportQuadVertexBuffer = null;
    this._viewportQuadPipeline = null;

    if (this._webgpuShaderCache) {
      this._webgpuShaderCache.clear();
    }
    if (this._webgpuPipelineCache) {
      this._webgpuPipelineCache.clear();
    }
  }

  /**
   * Register a callback for device loss events.
   * Delegates to the WebGPUDeviceLossRecovery instance.
   *
   * @param {DeviceLostCallback} callback - Callback to invoke on device loss
   * @returns {() => void} A function to unregister the callback
   */
  onDeviceLost(callback: DeviceLostCallback): () => void {
    if (this._deviceLossRecovery) {
      return this._deviceLossRecovery.onDeviceLost(callback);
    }
    // Fallback: no-op unsubscribe if recovery not yet initialized
    return () => {};
  }

  /**
   * Get the current device loss state.
   * @returns {DeviceLossState} Current device state
   */
  get deviceLossState(): DeviceLossState {
    return this._deviceLossRecovery?.state ?? DeviceLossState.HEALTHY;
  }

  /**
   * Get the number of recovery attempts that have been made.
   * @returns {number} Number of recovery attempts
   */
  get recoveryAttempts(): number {
    return this._deviceLossRecovery?.attempts ?? 0;
  }
}

export default WebGPUContext;
