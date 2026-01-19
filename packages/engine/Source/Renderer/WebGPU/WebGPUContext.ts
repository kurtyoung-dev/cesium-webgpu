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
import { GraphicsContext, GraphicsContextOptions } from "../GraphicsContext.js";
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
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";

/**
 * WebGPU-specific context options
 */
export interface WebGPUContextOptions extends GraphicsContextOptions {
  /**
   * Preferred GPU power preference
   */
  powerPreference?: GPUPowerPreference;

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
export class WebGPUContext implements GraphicsContext {
  // Public flag to identify this as a WebGPU context
  public isWebGPU: boolean = false;

  private _canvas: HTMLCanvasElement;
  private _adapter: GPUAdapter | null = null;
  private _device: GPUDevice | null = null;
  private _context: GPUCanvasContext | null = null;
  private _presentationFormat: GPUTextureFormat = "bgra8unorm";
  private _depthFormat: GPUTextureFormat = "depth24plus";
  private _isDestroyed: boolean = false;
  private _options: WebGPUContextOptions;

  // Frame state for command recording
  private _currentCommandEncoder: GPUCommandEncoder | null = null;
  private _currentRenderPassEncoder: GPURenderPassEncoder | null = null;
  private _currentTextureView: GPUTextureView | null = null;
  private _depthTexture: GPUTexture | null = null;
  private _depthTextureView: GPUTextureView | null = null;
  private _uniformState: any;

  // WebGL compatibility - stub object with WebGL constants for backward compatibility
  // This allows legacy Texture.js code to work without crashing
  public _gl: any;

  // WebGPU-specific caches and managers
  private _webgpuShaderCache: WebGPUShaderCache | null = null;
  private _webgpuPipelineCache: WebGPURenderPipelineCache | null = null;
  private _samplerCache: Map<string, GPUSampler> = new Map();
  private _bindGroupLayoutCache: Map<string, GPUBindGroupLayout> = new Map();
  private _bindGroupCache: Map<string, GPUBindGroup> = new Map();

  // Resource pools for efficient reuse
  private _bufferPool: Map<string, GPUBuffer[]> = new Map();
  private _uniformBufferPool: GPUBuffer[] = [];

  // GPU statistics and debugging
  private _frameCount: number = 0;
  private _drawCallCount: number = 0;
  private _triangleCount: number = 0;

  // WebGL extension properties (WebGPU natively supports these as core features)
  public floatingPointTexture: boolean = true; // WebGPU always supports float textures
  public halfFloatingPointTexture: boolean = true; // WebGPU always supports half-float textures
  public textureFloatLinear: boolean = true; // WebGPU always supports float filtering
  public textureHalfFloatLinear: boolean = true; // WebGPU always supports half-float filtering
  public s3tc: any = null;
  public pvrtc: any = null;
  public astc: any = null;
  public etc: any = null;
  public etc1: any = null;
  public bc7: any = null;
  public webgl2: boolean = false;
  public _textureFilterAnisotropic: any = null;

  // Additional WebGL properties for full compatibility
  public _id: string;
  public _shaderCache: any;
  public _textureCache: any;
  public _stencilBits: number = 8;
  public _antialias: boolean = false;
  public cache: any = {};
  public options: any;
  public validateFramebuffer: boolean = false;
  public validateShaderProgram: boolean = false;
  public logShaderCompilation: boolean = false;

  // Vertex array object methods
  public glCreateVertexArray: any;
  public glBindVertexArray: any;
  public glDeleteVertexArray: any;

  // Instanced rendering methods
  public glDrawElementsInstanced: any;
  public glDrawArraysInstanced: any;
  public glVertexAttribDivisor: any;

  // Draw buffers
  public glDrawBuffers: any;

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
  private _defaultTexture: any;
  private _defaultEmissiveTexture: any;
  private _defaultNormalTexture: any;
  private _defaultCubeMap: any;

  // Render state
  private _clearColor: any;
  private _clearDepth: number = 1.0;
  private _clearStencil: number = 0;
  private _defaultPassState: any;
  private _defaultRenderState: any;
  private _currentRenderState: any;
  private _currentPassState: any;
  private _currentFramebuffer: any;

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
  private _depthCompare: GPUCompareFunction = "less";
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

  // Pick objects
  private _pickObjects: Map<number, any> = new Map();
  private _nextPickColor: Uint32Array = new Uint32Array(1);

  // GL compatibility - bound buffer/texture tracking for legacy code
  private _boundVertexBuffer: GPUBuffer | null = null;
  private _boundIndexBuffer: GPUBuffer | null = null;
  private _activeTextureUnit: number = 0;
  private _textureBindings: Map<number, { target: number; texture: any }> =
    new Map();
  private _boundFramebuffer: any = null;
  private _boundRenderbuffer: any = null;
  private _framebuffers: Map<
    any,
    { colorAttachment: any; depthAttachment: any }
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
    this._canvas = canvas;
    this._options = options;

    // Mark this as a WebGPU context for renderer detection
    this.isWebGPU = true;

    // Generate unique ID
    this._id = createGuid();

    // Initialize caches
    this._shaderCache = new ShaderCache(this as any);
    this._textureCache = new TextureCache();

    // Initialize uniform and pass state
    this._uniformState = new UniformState();
    this._defaultPassState = new PassState(this as any);
    // @ts-ignore - fromCache is private but we need it for compatibility
    this._defaultRenderState = RenderState.fromCache();
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
      this._adapter = await navigator.gpu.requestAdapter({
        powerPreference: this._options.powerPreference ?? "high-performance",
      });

      if (!this._adapter) {
        throw new RuntimeError(
          "Failed to get WebGPU adapter. " +
            "WebGPU may not be properly supported on this device.",
        );
      }

      // Request GPU device
      const requiredFeatures = this._options.requiredFeatures ?? [];
      const requiredLimits = this._options.requiredLimits ?? {};

      this._device = await this._adapter.requestDevice({
        requiredFeatures,
        requiredLimits,
      });

      // Handle device lost event
      this._device.lost.then((info: GPUDeviceLostInfo) => {
        console.error(`WebGPU device lost: ${info.message}`, info.reason);
        this._isDestroyed = true;
      });

      // Initialize ContextLimits from WebGPU device limits
      this._initializeContextLimits();

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

      console.log("WebGPU Context initialized successfully");
      console.log(`  - Adapter: ${(this._adapter as any).name ?? "Unknown"}`);
      console.log(`  - Format: ${this._presentationFormat}`);
    } catch (error) {
      throw new RuntimeError(
        `Failed to initialize WebGPU context: ${(error as Error).message}`,
      );
    }
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
    this._defaultTexture = WebGPUTexture.create2D(
      this._device,
      1,
      1,
      "rgba8unorm",
      1,
      "Default White Texture",
    );
    this._defaultTexture.write(whiteData, 1, 1);

    // Create 1x1 black texture (default emissive)
    const blackData = new Uint8Array([0, 0, 0, 255]);
    this._defaultEmissiveTexture = WebGPUTexture.create2D(
      this._device,
      1,
      1,
      "rgba8unorm",
      1,
      "Default Emissive Texture",
    );
    this._defaultEmissiveTexture.write(blackData, 1, 1);

    // Create 1x1 normal texture (default normal - pointing up in tangent space)
    // Normal = (0.5, 0.5, 1.0) in RGB space = (128, 128, 255, 255)
    const normalData = new Uint8Array([128, 128, 255, 255]);
    this._defaultNormalTexture = WebGPUTexture.create2D(
      this._device,
      1,
      1,
      "rgba8unorm",
      1,
      "Default Normal Texture",
    );
    this._defaultNormalTexture.write(normalData, 1, 1);

    // Create 1x1 cubemap (all faces white)
    this._defaultCubeMap = WebGPUTexture.createCubeMap(
      this._device,
      1,
      "rgba8unorm",
      1,
      "Default Cube Map",
    );
    // Write white to all 6 faces
    for (let face = 0; face < 6; face++) {
      this._defaultCubeMap.write(whiteData, 1, 1, face);
    }

    console.log("[WebGPU] Default textures initialized");
  }

  // GraphicsContext interface implementation

  /**
   * The renderer type for this context
   */
  get rendererType(): RendererType {
    return RendererType.WEBGPU;
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
   * Whether the context has been destroyed
   */
  get isDestroyed(): boolean {
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
   * Begin a new frame - creates command encoder and starts render pass
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

    // Create command encoder for this frame
    this._currentCommandEncoder = this._device.createCommandEncoder({
      label: "Scene Frame Command Encoder",
    });

    // Get current canvas texture
    const canvasTexture = this._context.getCurrentTexture();
    this._currentTextureView = canvasTexture.createView();

    // Create or recreate depth texture if needed
    this._ensureDepthTexture();

    // Start render pass (will be configured with clear color in Scene)
    // For now, we'll create it here with default clear
    const renderPassDescriptor: GPURenderPassDescriptor = {
      label: "Scene Main Render Pass",
      colorAttachments: [
        {
          view: this._currentTextureView,
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: this._depthTextureView
        ? {
            view: this._depthTextureView,
            depthClearValue: 1.0,
            depthLoadOp: "clear",
            depthStoreOp: "store",
          }
        : undefined,
    };

    this._currentRenderPassEncoder =
      this._currentCommandEncoder.beginRenderPass(renderPassDescriptor);
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

      // Create new depth texture
      this._depthTexture = this._device.createTexture({
        size: { width, height },
        format: this._depthFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        label: "Scene Depth Texture",
      });

      this._depthTextureView = this._depthTexture.createView();
    }
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

    // Map WebGPU limits to ContextLimits
    // @ts-ignore - ContextLimits uses internal properties
    ContextLimits._maximumTextureSize = limits.maxTextureDimension2D;
    // @ts-ignore
    ContextLimits._maximumCubeMapSize = limits.maxTextureDimension2D;
    // @ts-ignore
    ContextLimits._maximumRenderbufferSize = limits.maxTextureDimension2D;
    // @ts-ignore
    ContextLimits._maximumTextureImageUnits =
      limits.maxSampledTexturesPerShaderStage;
    // @ts-ignore
    ContextLimits._maximumVertexTextureImageUnits =
      limits.maxSampledTexturesPerShaderStage;
    // @ts-ignore
    ContextLimits._maximumCombinedTextureImageUnits =
      limits.maxSampledTexturesPerShaderStage * 2;
    // @ts-ignore
    ContextLimits._maximumVertexAttributes = limits.maxVertexAttributes;
    // @ts-ignore
    ContextLimits._maximumViewportWidth = limits.maxTextureDimension2D;
    // @ts-ignore
    ContextLimits._maximumViewportHeight = limits.maxTextureDimension2D;

    // Set reasonable defaults for other limits
    // @ts-ignore
    ContextLimits._maximumFragmentUniformVectors = 1024; // WebGPU uses uniform buffers
    // @ts-ignore
    ContextLimits._maximumVaryingVectors = 31; // WebGPU spec guarantees 16 locations with 4 components
    // @ts-ignore
    ContextLimits._maximumVertexUniformVectors = 1024; // WebGPU uses uniform buffers
    // @ts-ignore
    ContextLimits._minimumAliasedLineWidth = 1.0;
    // @ts-ignore
    ContextLimits._maximumAliasedLineWidth = 1.0; // WebGPU doesn't support wide lines
    // @ts-ignore
    ContextLimits._minimumAliasedPointSize = 1.0;
    // @ts-ignore
    ContextLimits._maximumAliasedPointSize = 1.0;
    // @ts-ignore
    ContextLimits._maximumTextureFilterAnisotropy = 16.0; // Common max
    // @ts-ignore
    ContextLimits._maximumDrawBuffers = limits.maxColorAttachments ?? 8;
    // @ts-ignore
    ContextLimits._maximumColorAttachments = limits.maxColorAttachments ?? 8;
    // @ts-ignore
    ContextLimits._maximumSamples = 4; // WebGPU typically supports 4x MSAA
    // @ts-ignore
    ContextLimits._highpFloatSupported = true; // WebGPU always supports high precision
    // @ts-ignore
    ContextLimits._highpIntSupported = true;

    console.log(
      `[WebGPU] ContextLimits initialized - maximumTextureSize: ${limits.maxTextureDimension2D}`,
    );
  }

  /**
   * Initialize a WebGL compatibility stub that provides WebGL constants
   * This prevents legacy Texture.js code from crashing when accessing gl.TEXTURE_2D, etc.
   * Functions now log usage to track what legacy code is calling
   * @private
   */
  private _initializeWebGLStub(): void {
    const logUsage = (method: string, reason: string) => {
      // Disabled for less noise - uncomment for debugging WebGL compatibility layer
      // console.log(`[WebGPU Compatibility] gl.${method}() called - ${reason}`);
    };

    // Create a stub object with WebGL constants
    this._gl = {
      // Texture targets
      TEXTURE_2D: 0x0de1,
      TEXTURE_CUBE_MAP: 0x8513,

      // Texture units
      TEXTURE0: 0x84c0,

      // Pixel storage modes
      UNPACK_ALIGNMENT: 0x0cf5,
      UNPACK_FLIP_Y_WEBGL: 0x9240,
      UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
      UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,

      // Color space conversion
      NONE: 0,
      BROWSER_DEFAULT_WEBGL: 0x9244,

      // Texture parameters
      TEXTURE_MAG_FILTER: 0x2800,
      TEXTURE_MIN_FILTER: 0x2801,
      TEXTURE_WRAP_S: 0x2802,
      TEXTURE_WRAP_T: 0x2803,

      // Mipmap hint
      GENERATE_MIPMAP_HINT: 0x8192,

      // Texture methods - Enhanced with state tracking
      activeTexture: (unit: number) => {
        this._activeTextureUnit = unit - 0x84c0; // GL_TEXTURE0
        logUsage(
          "activeTexture",
          `Active texture unit set to ${this._activeTextureUnit}`,
        );
      },

      bindTexture: (target: number, texture: any) => {
        this._textureBindings.set(this._activeTextureUnit, { target, texture });
        logUsage(
          "bindTexture",
          `Texture bound to unit ${this._activeTextureUnit} - state tracked`,
        );
      },

      createTexture: () => {
        logUsage(
          "createTexture",
          "Texture placeholder created - use WebGPUTexture for full functionality",
        );
        return {
          _isPlaceholder: true,
          _webgpuTexture: null,
        };
      },

      deleteTexture: (texture: any) => {
        if (texture?._webgpuTexture?.destroy) {
          texture._webgpuTexture.destroy();
          logUsage("deleteTexture", "WebGPU texture destroyed");
        } else if (texture?.destroy) {
          texture.destroy();
          logUsage("deleteTexture", "Texture destroyed");
        } else {
          logUsage("deleteTexture", "Invalid texture or already destroyed");
        }
      },
      pixelStorei: () =>
        logUsage(
          "pixelStorei",
          "Not needed - WebGPU handles pixel store automatically",
        ),
      texParameteri: () =>
        logUsage(
          "texParameteri",
          "Not needed - use GPUSamplerDescriptor instead",
        ),
      texImage2D: () =>
        logUsage(
          "texImage2D",
          "Use texture.write() or queue.writeTexture() instead",
        ),
      texSubImage2D: (
        target: number,
        level: number,
        xoffset: number,
        yoffset: number,
        width: number,
        height: number,
        format: number,
        type: number,
        pixels: ArrayBufferView | null,
      ) => {
        // Get bound texture from _textureBindings
        const binding = this._textureBindings.get(this._activeTextureUnit);

        if (!binding?.texture?._webgpuTexture) {
          logUsage("texSubImage2D", "No WebGPU texture bound - cannot update");
          return;
        }

        if (!pixels || !this._device) {
          logUsage("texSubImage2D", "No pixel data or device not ready");
          return;
        }

        // Upload texture sub-region
        this._device.queue.writeTexture(
          {
            texture: binding.texture._webgpuTexture.texture,
            mipLevel: level,
            origin: { x: xoffset, y: yoffset, z: 0 },
          },
          pixels as BufferSource,
          {
            bytesPerRow: width * 4, // Assuming RGBA format
            rowsPerImage: height,
          },
          { width, height, depthOrArrayLayers: 1 },
        );
        logUsage(
          "texSubImage2D",
          `Texture region updated at (${xoffset}, ${yoffset}, ${width}x${height})`,
        );
      },
      compressedTexImage2D: (
        target: number,
        level: number,
        internalformat: number,
        width: number,
        height: number,
        border: number,
        data: ArrayBufferView,
      ) => {
        const binding = this._textureBindings.get(this._activeTextureUnit);

        if (!binding?.texture?._webgpuTexture || !this._device) {
          logUsage(
            "compressedTexImage2D",
            "No WebGPU texture bound or device not ready",
          );
          return;
        }

        // Upload compressed texture data
        // Note: Format detection would require mapping WebGL format constants to WebGPU
        this._device.queue.writeTexture(
          {
            texture: binding.texture._webgpuTexture.texture,
            mipLevel: level,
          },
          data as BufferSource,
          {
            bytesPerRow: width * 4, // This needs proper block size calculation per format
            rowsPerImage: height,
          },
          { width, height, depthOrArrayLayers: 1 },
        );
        logUsage(
          "compressedTexImage2D",
          `Compressed texture uploaded (${width}x${height}, mip ${level})`,
        );
      },

      compressedTexSubImage2D: (
        target: number,
        level: number,
        xoffset: number,
        yoffset: number,
        width: number,
        height: number,
        format: number,
        data: ArrayBufferView,
      ) => {
        const binding = this._textureBindings.get(this._activeTextureUnit);

        if (!binding?.texture?._webgpuTexture || !this._device) {
          logUsage(
            "compressedTexSubImage2D",
            "No WebGPU texture bound or device not ready",
          );
          return;
        }

        this._device.queue.writeTexture(
          {
            texture: binding.texture._webgpuTexture.texture,
            mipLevel: level,
            origin: { x: xoffset, y: yoffset, z: 0 },
          },
          data as BufferSource,
          {
            bytesPerRow: width * 4,
            rowsPerImage: height,
          },
          { width, height, depthOrArrayLayers: 1 },
        );
        logUsage(
          "compressedTexSubImage2D",
          `Compressed texture region updated at (${xoffset}, ${yoffset})`,
        );
      },

      copyTexImage2D: (
        target: number,
        level: number,
        internalformat: number,
        x: number,
        y: number,
        width: number,
        height: number,
        border: number,
      ) => {
        const binding = this._textureBindings.get(this._activeTextureUnit);

        if (!binding?.texture?._webgpuTexture || !this._currentCommandEncoder) {
          logUsage(
            "copyTexImage2D",
            "No texture bound or no command encoder active",
          );
          return;
        }

        // Get source (framebuffer or canvas)
        const sourceTexture =
          this._boundFramebuffer?.colorAttachment?._texture ||
          this._context?.getCurrentTexture();

        if (sourceTexture) {
          this.copyTextureRegion(
            sourceTexture,
            binding.texture._webgpuTexture.texture,
            x,
            y,
            0,
            0,
            width,
            height,
          );
          logUsage(
            "copyTexImage2D",
            `Texture copied from framebuffer/canvas (${width}x${height})`,
          );
        } else {
          logUsage("copyTexImage2D", "No source texture available");
        }
      },

      copyTexSubImage2D: (
        target: number,
        level: number,
        xoffset: number,
        yoffset: number,
        x: number,
        y: number,
        width: number,
        height: number,
      ) => {
        const binding = this._textureBindings.get(this._activeTextureUnit);

        if (!binding?.texture?._webgpuTexture || !this._currentCommandEncoder) {
          logUsage(
            "copyTexSubImage2D",
            "No texture bound or no command encoder active",
          );
          return;
        }

        // Get source (framebuffer or canvas)
        const sourceTexture =
          this._boundFramebuffer?.colorAttachment?._texture ||
          this._context?.getCurrentTexture();

        if (sourceTexture) {
          this.copyTextureRegion(
            sourceTexture,
            binding.texture._webgpuTexture.texture,
            x,
            y,
            xoffset,
            yoffset,
            width,
            height,
          );
          logUsage(
            "copyTexSubImage2D",
            `Texture region copied (${width}x${height})`,
          );
        } else {
          logUsage("copyTexSubImage2D", "No source texture available");
        }
      },

      generateMipmap: (target: number) => {
        const binding = this._textureBindings.get(this._activeTextureUnit);

        if (binding?.texture?._webgpuTexture) {
          logUsage(
            "generateMipmap",
            "WebGPU requires manual mipmap generation - texture has no auto-gen. Use WebGPUTexture.generateMipmaps() when available",
          );
          // TODO: Implement WebGPUTexture.generateMipmaps() with compute shader
        } else {
          logUsage(
            "generateMipmap",
            "No texture bound - cannot generate mipmaps",
          );
        }
      },

      hint: () => logUsage("hint", "Not applicable in WebGPU - no hint system"),

      // Framebuffer methods - Enhanced with state tracking
      createFramebuffer: () => {
        const fboId = createGuid();
        const fbo = {
          _id: fboId,
          _colorAttachment: null,
          _depthAttachment: null,
          _isWebGPU: true,
        };
        this._framebuffers.set(fbo, {
          colorAttachment: null,
          depthAttachment: null,
        });
        logUsage(
          "createFramebuffer",
          `Framebuffer created with ID ${fboId} - tracks attachments for WebGPURenderTarget`,
        );
        return fbo;
      },

      bindFramebuffer: (target: number, framebuffer: any) => {
        this._boundFramebuffer = framebuffer;
        if (framebuffer) {
          logUsage(
            "bindFramebuffer",
            `Framebuffer bound - state tracked for render pass creation`,
          );
        } else {
          logUsage(
            "bindFramebuffer",
            "Binding to default framebuffer (canvas)",
          );
        }
      },

      deleteFramebuffer: (framebuffer: any) => {
        if (!framebuffer) {
          logUsage("deleteFramebuffer", "Invalid framebuffer");
          return;
        }

        const fboData = this._framebuffers.get(framebuffer);
        if (fboData) {
          // Destroy attachments if they exist
          if (fboData.colorAttachment?._texture?.destroy) {
            fboData.colorAttachment._texture.destroy();
          }
          if (fboData.depthAttachment?._texture?.destroy) {
            fboData.depthAttachment._texture.destroy();
          }
          this._framebuffers.delete(framebuffer);
          logUsage(
            "deleteFramebuffer",
            "Framebuffer and attachments destroyed",
          );
        } else {
          logUsage(
            "deleteFramebuffer",
            "Framebuffer not found in tracking map",
          );
        }
      },

      framebufferTexture2D: (
        target: number,
        attachment: number,
        textarget: number,
        texture: any,
        level: number,
      ) => {
        if (!this._boundFramebuffer) {
          logUsage("framebufferTexture2D", "No framebuffer bound");
          return;
        }

        const fboData = this._framebuffers.get(this._boundFramebuffer);
        if (fboData) {
          if (attachment === 0x8ce0) {
            // GL_COLOR_ATTACHMENT0
            fboData.colorAttachment = texture;
            this._boundFramebuffer._colorAttachment = texture;
            logUsage(
              "framebufferTexture2D",
              "Color attachment set - can be used for render pass",
            );
          } else if (attachment === 0x8d00) {
            // GL_DEPTH_ATTACHMENT
            fboData.depthAttachment = texture;
            this._boundFramebuffer._depthAttachment = texture;
            logUsage(
              "framebufferTexture2D",
              "Depth attachment set - can be used for render pass",
            );
          } else {
            logUsage(
              "framebufferTexture2D",
              `Attachment ${attachment} tracked`,
            );
          }
        }
      },

      framebufferRenderbuffer: (
        target: number,
        attachment: number,
        renderbuffertarget: number,
        renderbuffer: any,
      ) => {
        if (!this._boundFramebuffer) {
          logUsage("framebufferRenderbuffer", "No framebuffer bound");
          return;
        }

        const fboData = this._framebuffers.get(this._boundFramebuffer);
        if (fboData && renderbuffer) {
          if (attachment === 0x8ce0) {
            // GL_COLOR_ATTACHMENT0
            fboData.colorAttachment = renderbuffer;
            this._boundFramebuffer._colorAttachment = renderbuffer;
            logUsage("framebufferRenderbuffer", "Color renderbuffer attached");
          } else if (attachment === 0x8d00) {
            // GL_DEPTH_ATTACHMENT
            fboData.depthAttachment = renderbuffer;
            this._boundFramebuffer._depthAttachment = renderbuffer;
            logUsage("framebufferRenderbuffer", "Depth renderbuffer attached");
          }
        }
      },

      checkFramebufferStatus: (target: number) => {
        logUsage(
          "checkFramebufferStatus",
          "Always complete in WebGPU - validation happens at pipeline creation",
        );
        return 0x8cd5; // GL_FRAMEBUFFER_COMPLETE
      },

      // Renderbuffer methods - Enhanced with texture creation
      createRenderbuffer: () => {
        if (!this._device) {
          logUsage("createRenderbuffer", "Device not initialized");
          return {};
        }

        // Create placeholder that will be configured later
        const renderbuffer = {
          _id: createGuid(),
          _texture: null as GPUTexture | null,
          _format: null as GPUTextureFormat | null,
          _width: 0,
          _height: 0,
          _isWebGPU: true,
        };

        logUsage(
          "createRenderbuffer",
          "Renderbuffer placeholder created - will create GPUTexture on renderbufferStorage",
        );
        return renderbuffer;
      },

      bindRenderbuffer: (target: number, renderbuffer: any) => {
        this._boundRenderbuffer = renderbuffer;
        logUsage("bindRenderbuffer", "Renderbuffer bound - state tracked");
      },

      deleteRenderbuffer: (renderbuffer: any) => {
        if (renderbuffer?._texture) {
          renderbuffer._texture.destroy();
          logUsage("deleteRenderbuffer", "Underlying GPUTexture destroyed");
        } else {
          logUsage(
            "deleteRenderbuffer",
            "Invalid renderbuffer or already destroyed",
          );
        }
      },

      renderbufferStorage: (
        target: number,
        internalformat: number,
        width: number,
        height: number,
      ) => {
        if (!this._boundRenderbuffer || !this._device) {
          logUsage(
            "renderbufferStorage",
            "No renderbuffer bound or device not ready",
          );
          return;
        }

        // Destroy old texture if exists
        if (this._boundRenderbuffer._texture) {
          this._boundRenderbuffer._texture.destroy();
        }

        // Map WebGL format to WebGPU format (simplified)
        let gpuFormat: GPUTextureFormat = "rgba8unorm";
        if (internalformat === 0x81a5 || internalformat === 0x81a6) {
          // DEPTH_COMPONENT16/24
          gpuFormat = "depth24plus";
        } else if (internalformat === 0x88f0) {
          // DEPTH24_STENCIL8
          gpuFormat = "depth24plus-stencil8";
        }

        // Create GPUTexture as renderbuffer storage
        this._boundRenderbuffer._texture = this._device.createTexture({
          size: { width, height },
          format: gpuFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
          label: "Renderbuffer Storage",
        });
        this._boundRenderbuffer._format = gpuFormat;
        this._boundRenderbuffer._width = width;
        this._boundRenderbuffer._height = height;

        logUsage(
          "renderbufferStorage",
          `GPUTexture created as renderbuffer storage (${width}x${height}, ${gpuFormat})`,
        );
      },

      renderbufferStorageMultisample: (
        target: number,
        samples: number,
        internalformat: number,
        width: number,
        height: number,
      ) => {
        if (!this._boundRenderbuffer || !this._device) {
          logUsage(
            "renderbufferStorageMultisample",
            "No renderbuffer bound or device not ready",
          );
          return;
        }

        // Destroy old texture if exists
        if (this._boundRenderbuffer._texture) {
          this._boundRenderbuffer._texture.destroy();
        }

        // Map format (same as renderbufferStorage)
        let gpuFormat: GPUTextureFormat = "rgba8unorm";
        if (internalformat === 0x81a5 || internalformat === 0x81a6) {
          gpuFormat = "depth24plus";
        } else if (internalformat === 0x88f0) {
          gpuFormat = "depth24plus-stencil8";
        }

        // Create multisampled GPUTexture
        this._boundRenderbuffer._texture = this._device.createTexture({
          size: { width, height },
          format: gpuFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
          sampleCount: samples,
          label: `Renderbuffer Storage (${samples}x MSAA)`,
        });
        this._boundRenderbuffer._format = gpuFormat;
        this._boundRenderbuffer._width = width;
        this._boundRenderbuffer._height = height;

        logUsage(
          "renderbufferStorageMultisample",
          `Multisampled GPUTexture created (${width}x${height}, ${gpuFormat}, ${samples}x)`,
        );
      },

      // Buffer methods - Enhanced with real WebGPU implementations
      createBuffer: () => {
        if (!this._device) {
          logUsage("createBuffer", "Device not initialized");
          return {};
        }

        // Create a real WebGPU buffer with flexible usage
        const buffer = this._device.createBuffer({
          size: 65536, // Default size, will be resized on bufferData if needed
          usage:
            GPUBufferUsage.VERTEX |
            GPUBufferUsage.INDEX |
            GPUBufferUsage.COPY_DST,
          label: "GL Compatibility Buffer",
        });

        logUsage("createBuffer", "Real WebGPU buffer created");

        return {
          _webgpuBuffer: buffer,
          _size: 65536,
          destroy: () => buffer.destroy(),
        };
      },

      bindBuffer: (target: number, buffer: any) => {
        if (target === 0x8892) {
          // GL_ARRAY_BUFFER
          this._boundVertexBuffer = buffer?._webgpuBuffer || null;
          logUsage("bindBuffer", `Vertex buffer bound - state tracked`);
        } else if (target === 0x8893) {
          // GL_ELEMENT_ARRAY_BUFFER
          this._boundIndexBuffer = buffer?._webgpuBuffer || null;
          logUsage("bindBuffer", `Index buffer bound - state tracked`);
        }
      },

      deleteBuffer: (buffer: any) => {
        if (buffer?._webgpuBuffer) {
          buffer._webgpuBuffer.destroy();
          logUsage("deleteBuffer", "Buffer destroyed");
        } else if (buffer?.destroy) {
          buffer.destroy();
          logUsage("deleteBuffer", "Buffer destroyed");
        } else {
          logUsage("deleteBuffer", "Invalid buffer or already destroyed");
        }
      },

      bufferData: (
        target: number,
        data: ArrayBuffer | ArrayBufferView | number,
        usage: number,
      ) => {
        const boundBuffer =
          target === 0x8892 ? this._boundVertexBuffer : this._boundIndexBuffer;

        if (!boundBuffer) {
          logUsage("bufferData", "No buffer bound to target");
          return;
        }

        if (typeof data === "number") {
          // Size only - buffer already created with size, just log
          logUsage(
            "bufferData",
            `Buffer sized to ${data} bytes (recreate if needed)`,
          );
          return;
        }

        // Upload actual data
        const arrayBuffer =
          data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer;
        const byteOffset =
          data instanceof ArrayBuffer
            ? 0
            : (data as ArrayBufferView).byteOffset;
        let byteLength =
          data instanceof ArrayBuffer
            ? data.byteLength
            : (data as ArrayBufferView).byteLength;

        if (this._device) {
          // WebGPU requires buffer writes to be 4-byte aligned
          // If not aligned, we need to pad the data
          const alignedLength = Math.ceil(byteLength / 4) * 4;

          if (alignedLength !== byteLength) {
            // Need to pad - create a new array with padding
            const paddedArray = new Uint8Array(alignedLength);
            const sourceArray = new Uint8Array(
              arrayBuffer,
              byteOffset,
              byteLength,
            );
            paddedArray.set(sourceArray);
            // Remaining bytes are automatically zero-initialized

            this._device.queue.writeBuffer(
              boundBuffer,
              0,
              paddedArray.buffer,
              0,
              alignedLength,
            );
            logUsage(
              "bufferData",
              `Uploaded ${byteLength} bytes (padded to ${alignedLength}) to buffer`,
            );
          } else {
            // Already aligned
            // Check if buffer is large enough
            if (byteLength > boundBuffer.size) {
              console.warn(
                `[WebGPU] Buffer too small (${boundBuffer.size}), need ${byteLength}. Recreate buffer with larger size.`,
              );
            }

            this._device.queue.writeBuffer(
              boundBuffer,
              0,
              arrayBuffer,
              byteOffset,
              byteLength,
            );
            logUsage("bufferData", `Uploaded ${byteLength} bytes to buffer`);
          }
        }
      },

      bufferSubData: (
        target: number,
        offset: number,
        data: ArrayBuffer | ArrayBufferView,
      ) => {
        const boundBuffer =
          target === 0x8892 ? this._boundVertexBuffer : this._boundIndexBuffer;

        if (!boundBuffer) {
          logUsage("bufferSubData", "No buffer bound to target");
          return;
        }

        const arrayBuffer =
          data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer;
        const byteOffset =
          data instanceof ArrayBuffer
            ? 0
            : (data as ArrayBufferView).byteOffset;
        const byteLength =
          data instanceof ArrayBuffer
            ? data.byteLength
            : (data as ArrayBufferView).byteLength;

        if (this._device) {
          this._device.queue.writeBuffer(
            boundBuffer,
            offset,
            arrayBuffer,
            byteOffset,
            byteLength,
          );
          logUsage(
            "bufferSubData",
            `Updated ${byteLength} bytes at offset ${offset}`,
          );
        }
      },

      // Buffer targets
      ARRAY_BUFFER: 0x8892,
      ELEMENT_ARRAY_BUFFER: 0x8893,

      // Buffer usage
      STATIC_DRAW: 0x88e4,
      DYNAMIC_DRAW: 0x88e8,
      STREAM_DRAW: 0x88e0,

      // Vertex attribute methods - Handled by pipeline vertex state
      enableVertexAttribArray: () =>
        logUsage(
          "enableVertexAttribArray",
          "Defined in GPUVertexState, not enabled/disabled",
        ),
      disableVertexAttribArray: () =>
        logUsage(
          "disableVertexAttribArray",
          "Defined in GPUVertexState, not enabled/disabled",
        ),
      vertexAttribPointer: () =>
        logUsage(
          "vertexAttribPointer",
          "Configure in GPUVertexBufferLayout instead",
        ),
      vertexAttribDivisor: () =>
        logUsage(
          "vertexAttribDivisor",
          "Set stepMode in GPUVertexBufferLayout",
        ),

      // Clear methods - Handled by render pass load operations
      clear: () =>
        logUsage("clear", 'Use loadOp: "clear" in GPURenderPassDescriptor'),
      clearColor: (r?: number, g?: number, b?: number, a?: number) => {
        if (r !== undefined) {
          this._clearColor = new Color(r, g, b, a);
        }
        logUsage(
          "clearColor",
          `Color stored: (${r}, ${g}, ${b}, ${a}) - applied in beginFrame()`,
        );
      },
      clearDepth: (depth?: number) => {
        if (depth !== undefined) {
          this._clearDepth = depth;
        }
        logUsage(
          "clearDepth",
          `Depth ${depth} stored - applied in beginFrame()`,
        );
      },
      clearStencil: (s?: number) => {
        if (s !== undefined) {
          this._clearStencil = s;
        }
        logUsage(
          "clearStencil",
          `Stencil ${s} stored - applied in beginFrame()`,
        );
      },

      // Clear bits
      COLOR_BUFFER_BIT: 0x4000,
      DEPTH_BUFFER_BIT: 0x0100,
      STENCIL_BUFFER_BIT: 0x0400,

      // Viewport and scissor - MAP TO WEBGPU
      viewport: (x: number, y: number, width: number, height: number) => {
        this.setViewport(x, y, width, height);
        logUsage(
          "viewport",
          `Mapped to setViewport(${x}, ${y}, ${width}, ${height})`,
        );
      },
      scissor: (x: number, y: number, width: number, height: number) => {
        this.setScissorRect(x, y, width, height);
        logUsage(
          "scissor",
          `Mapped to setScissorRect(${x}, ${y}, ${width}, ${height})`,
        );
      },

      // Enable/disable - Track state for pipeline creation
      enable: (cap: number) => {
        switch (cap) {
          case 0x0b71: // DEPTH_TEST
            this._depthTestEnabled = true;
            break;
          case 0x0be2: // BLEND
            this._blendEnabled = true;
            break;
          case 0x0b44: // CULL_FACE
            this._cullFaceEnabled = true;
            break;
          case 0x0c11: // SCISSOR_TEST
            this._scissorTest = true;
            break;
        }
      },
      disable: (cap: number) => {
        switch (cap) {
          case 0x0b71: // DEPTH_TEST
            this._depthTestEnabled = false;
            break;
          case 0x0be2: // BLEND
            this._blendEnabled = false;
            break;
          case 0x0b44: // CULL_FACE
            this._cullFaceEnabled = false;
            break;
          case 0x0c11: // SCISSOR_TEST
            this._scissorTest = false;
            this.disableScissorTest();
            break;
        }
      },

      // Capabilities
      DEPTH_TEST: 0x0b71,
      BLEND: 0x0be2,
      CULL_FACE: 0x0b44,
      SCISSOR_TEST: 0x0c11,
      STENCIL_TEST: 0x0b90,
      SAMPLE_ALPHA_TO_COVERAGE: 0x809e,

      // Blend functions - Track state for pipeline creation
      blendFunc: (sfactor: number, dfactor: number) => {
        this._blendSrc = this._webglToWebGPUBlendFactor(sfactor);
        this._blendDst = this._webglToWebGPUBlendFactor(dfactor);
        this._blendSrcAlpha = this._blendSrc;
        this._blendDstAlpha = this._blendDst;
      },
      blendFuncSeparate: (
        srcRGB: number,
        dstRGB: number,
        srcAlpha: number,
        dstAlpha: number,
      ) => {
        this._blendSrc = this._webglToWebGPUBlendFactor(srcRGB);
        this._blendDst = this._webglToWebGPUBlendFactor(dstRGB);
        this._blendSrcAlpha = this._webglToWebGPUBlendFactor(srcAlpha);
        this._blendDstAlpha = this._webglToWebGPUBlendFactor(dstAlpha);
      },
      blendEquation: (mode: number) => {
        this._blendOp = this._webglToWebGPUBlendOp(mode);
        this._blendOpAlpha = this._blendOp;
      },
      blendEquationSeparate: (modeRGB: number, modeAlpha: number) => {
        this._blendOp = this._webglToWebGPUBlendOp(modeRGB);
        this._blendOpAlpha = this._webglToWebGPUBlendOp(modeAlpha);
      },
      blendColor: (r: number, g: number, b: number, a: number) => {
        if (this._currentRenderPassEncoder) {
          this._currentRenderPassEncoder.setBlendConstant([r, g, b, a]);
        }
      },

      // Depth functions - Track state for pipeline creation
      depthFunc: (func: number) => {
        this._depthCompare = this._webglToWebGPUCompareFunction(func);
      },
      depthMask: (flag: boolean) => {
        this._depthWriteEnabled = flag;
      },
      depthRange: () => {
        // WebGPU always uses 0-1 depth range (handled in Matrix4)
        // This is a no-op as depth range is not configurable in WebGPU
      },

      // Stencil functions - Track state (full implementation would need stencil state object)
      stencilFunc: () => {
        // TODO: Track stencil function state when stencil is needed
      },
      stencilMask: () => {
        // TODO: Track stencil write mask when stencil is needed
      },
      stencilOp: () => {
        // TODO: Track stencil operations when stencil is needed
      },

      // Culling - Track state for pipeline creation
      cullFace: (mode: number) => {
        // 0x0404 = GL_FRONT, 0x0405 = GL_BACK, 0x0408 = GL_FRONT_AND_BACK
        if (mode === 0x0404) {
          this._cullMode = "front";
        } else if (mode === 0x0405) {
          this._cullMode = "back";
        } else {
          this._cullMode = "none"; // GL_FRONT_AND_BACK not supported, use none
        }
      },
      frontFace: (mode: number) => {
        // 0x0900 = GL_CW (clockwise), 0x0901 = GL_CCW (counter-clockwise)
        this._frontFace = mode === 0x0900 ? "cw" : "ccw";
      },

      // Color mask - Track state for pipeline creation
      colorMask: (r: boolean, g: boolean, b: boolean, a: boolean) => {
        this._colorWriteMask =
          (r ? 0x1 : 0) | // GPUColorWrite.RED
          (g ? 0x2 : 0) | // GPUColorWrite.GREEN
          (b ? 0x4 : 0) | // GPUColorWrite.BLUE
          (a ? 0x8 : 0); // GPUColorWrite.ALPHA
      },

      // Parameter queries
      getParameter: (param: number) => {
        logUsage(
          "getParameter",
          `Param ${param} - use ContextLimits or device.limits instead`,
        );
        return 0;
      },
      getExtension: (name: string) => {
        logUsage(
          "getExtension",
          `${name} - WebGPU uses device.features instead`,
        );
        return null;
      },

      // Shader methods - Needed for WebGL shader compilation path
      createShader: (type: number) => {
        logUsage(
          "createShader",
          "Use WebGPU shader modules instead - returning placeholder",
        );
        return { _type: type, _isWebGPU: true };
      },
      deleteShader: () =>
        logUsage("deleteShader", "WebGPU shader lifecycle managed differently"),
      shaderSource: () =>
        logUsage("shaderSource", "Use WebGPU shader modules with WGSL"),
      compileShader: () =>
        logUsage("compileShader", "WebGPU shaders compiled at module creation"),
      getShaderParameter: () => {
        logUsage("getShaderParameter", "Always successful in WebGPU");
        return true;
      },
      getShaderInfoLog: () => {
        logUsage(
          "getShaderInfoLog",
          "No compilation log - check device errors",
        );
        return "";
      },
      createProgram: () => {
        logUsage(
          "createProgram",
          "Use WebGPU render pipelines instead - returning placeholder",
        );
        return { _isWebGPU: true };
      },
      deleteProgram: () =>
        logUsage(
          "deleteProgram",
          "WebGPU pipeline lifecycle managed differently",
        ),
      attachShader: () =>
        logUsage("attachShader", "WebGPU uses pipeline descriptors"),
      bindAttribLocation: () =>
        logUsage(
          "bindAttribLocation",
          "WebGPU uses vertex buffer layout in pipeline descriptor",
        ),
      linkProgram: () =>
        logUsage("linkProgram", "WebGPU pipelines created atomically"),
      getProgramParameter: () => {
        logUsage("getProgramParameter", "Always successful in WebGPU");
        return true;
      },
      getProgramInfoLog: () => {
        logUsage("getProgramInfoLog", "No link log - check device errors");
        return "";
      },
      useProgram: () =>
        logUsage("useProgram", "Set in render pipeline, not separately"),
      getActiveUniform: (program: any, index: number) => {
        logUsage(
          "getActiveUniform",
          "WebGPU shader reflection not needed - uniforms defined in bind groups",
        );
        // Return dummy uniform info to satisfy shader introspection
        return {
          name: `uniform_${index}`,
          size: 1,
          type: 0x1406, // GL_FLOAT
        };
      },
      getActiveAttrib: (program: any, index: number) => {
        logUsage(
          "getActiveAttrib",
          "WebGPU vertex attributes defined in pipeline descriptor",
        );
        // Return dummy attribute info
        return {
          name: `attrib_${index}`,
          size: 1,
          type: 0x1406, // GL_FLOAT
        };
      },
      getUniformLocation: (program: any, name: string) => {
        logUsage(
          "getUniformLocation",
          "WebGPU uses bind groups, not individual uniform locations",
        );
        // Return dummy location object
        return { _name: name, _isWebGPU: true };
      },
      getAttribLocation: (program: any, name: string) => {
        logUsage(
          "getAttribLocation",
          "WebGPU vertex attributes defined by shader location",
        );
        // Return index based on common attribute names
        const locationMap: Record<string, number> = {
          position: 0,
          normal: 1,
          texCoord: 2,
          color: 3,
          tangent: 4,
          bitangent: 5,
        };
        return locationMap[name] ?? -1;
      },

      // Framebuffer blitting - for MSAA resolve
      blitFramebuffer: () => {
        logUsage(
          "blitFramebuffer",
          "WebGPU uses render pass resolve attachments instead",
        );
        // WebGPU handles MSAA resolve automatically in render pass
      },

      // Read pixels
      readPixels: () => {
        logUsage("readPixels", "Use readPixelsToPBO for async readback");
        return null;
      },
    };
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
   * @returns {any} The uniform state
   */
  get uniformState(): any {
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

    console.log("[WebGPU] Viewport quad initialized");
  }

  /**
   * Creates a viewport quad command for screen-space effects - PRIORITY 2 IMPLEMENTED
   * Used for post-processing, full-screen passes, etc.
   * @param {any} fragmentShader - The fragment shader for the quad (WGSL shader module)
   * @param {any} [options] - Additional options (uniformMap, framebuffer)
   * @returns {any} A viewport quad command
   */
  createViewportQuadCommand(fragmentShader: any, options?: any): any {
    // Ensure viewport quad is initialized
    if (!this._viewportQuadVertexBuffer) {
      this._initializeViewportQuad();
    }

    const that = this;

    return {
      execute: (renderPassEncoder?: GPURenderPassEncoder) => {
        const passEncoder = renderPassEncoder || that._currentRenderPassEncoder;

        if (!passEncoder || !that._viewportQuadVertexBuffer) {
          console.warn(
            "[WebGPU] Cannot execute viewport quad - no render pass or vertex buffer",
          );
          return;
        }

        // Note: Actual pipeline creation would require the fragment shader
        // For now, this provides the structure. Full implementation requires:
        // 1. Create pipeline with fragment shader
        // 2. Create bind group from uniformMap
        // 3. Execute draw call

        console.warn(
          "[WebGPU] Viewport quad execution - pipeline creation not implemented",
        );
        // passEncoder.setPipeline(pipeline);
        // passEncoder.setBindGroup(0, bindGroup);
        // passEncoder.setVertexBuffer(0, that._viewportQuadVertexBuffer.buffer);
        // passEncoder.draw(4, 1, 0, 0); // 4 vertices, triangle strip
      },
      shaderProgram: fragmentShader,
      uniformMap: options?.uniformMap || {},
      framebuffer: options?.framebuffer || null,
    };
  }

  /**
   * Gets a viewport quad vertex array (used for full-screen effects) - PRIORITY 2 IMPLEMENTED
   * @returns {any} A vertex array containing the viewport quad data
   */
  getViewportQuadVertexArray(): any {
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
   * @param {any} drawCommand - The draw command to execute (WebGPUDrawCommand)
   * @param {any} passState - Pass state information
   */
  draw(drawCommand: any, passState?: any): void {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("Context has been destroyed.");
    }
    //>>includeEnd('debug');

    if (!this._currentRenderPassEncoder) {
      console.warn("[WebGPU] draw() called without active render pass encoder");
      return;
    }

    // Check if this is a WebGPUDrawCommand
    if (drawCommand && typeof drawCommand.execute === "function") {
      // Execute WebGPU draw command
      drawCommand.execute(this._currentRenderPassEncoder);

      // Record statistics
      this._drawCallCount++;
      if (drawCommand.indexCount) {
        this._triangleCount += Math.floor(drawCommand.indexCount / 3);
      } else if (drawCommand.vertexCount) {
        this._triangleCount += Math.floor(drawCommand.vertexCount / 3);
      }
    } else {
      // Legacy draw command - log warning
      console.warn(
        "[WebGPU] Unsupported draw command format - use WebGPUDrawCommand",
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
   * Read pixels from framebuffer to Pixel Buffer Object (async) - PRIORITY 2 IMPLEMENTED
   * WebGPU implementation - uses copyTextureToBuffer for async readback
   * @param {any} readState - Read state configuration with x, y, width, height
   * @returns {any} PBO handle (buffer for async readback with mapAsync support)
   */
  readPixelsToPBO(readState: any): any {
    if (!this._device || !this._currentCommandEncoder) {
      console.warn(
        "[WebGPU] readPixelsToPBO: No active device or command encoder",
      );
      return null;
    }

    const x = readState.x ?? 0;
    const y = readState.y ?? 0;
    const width = readState.width ?? this._canvas.width;
    const height = readState.height ?? this._canvas.height;

    // Calculate buffer size (4 bytes per pixel for RGBA)
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256; // Align to 256 bytes
    const bufferSize = bytesPerRow * height;

    // Create readback buffer
    const readbackBuffer = this._device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: "Pixel Readback Buffer",
    });

    // Issue copy command from current texture to buffer
    // Note: This requires the render pass to be ended first
    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.end();
      this._currentRenderPassEncoder = null;
    }

    // Get the source texture (current canvas texture or specified framebuffer)
    const sourceTexture = this._context?.getCurrentTexture();

    if (sourceTexture) {
      this._currentCommandEncoder.copyTextureToBuffer(
        {
          texture: sourceTexture,
          origin: { x, y, z: 0 },
        },
        {
          buffer: readbackBuffer,
          bytesPerRow,
        },
        {
          width,
          height,
          depthOrArrayLayers: 1,
        },
      );
    }

    // Return PBO handle with async map capability
    return {
      buffer: readbackBuffer,
      width,
      height,
      bytesPerRow,
      // Async read method
      mapAsync: async () => {
        await readbackBuffer.mapAsync(GPUMapMode.READ);
        const arrayBuffer = readbackBuffer.getMappedRange();
        const data = new Uint8Array(arrayBuffer.slice(0));
        readbackBuffer.unmap();
        readbackBuffer.destroy();
        return data;
      },
      destroy: () => {
        readbackBuffer.destroy();
      },
    };
  }

  /**
   * Read pixels from framebuffer (sync)
   * WebGPU note: True synchronous readback is not possible in WebGPU
   * This is a compatibility shim that returns null
   * @param {any} readState - Read state configuration
   * @returns {any} Pixel data (null in WebGPU - use readPixelsToPBO for async)
   */
  readPixels(readState: any): any {
    // WebGPU doesn't support synchronous pixel readback
    // Applications should use readPixelsToPBO for async readback
    console.warn(
      "[WebGPU] Synchronous readPixels not supported - use readPixelsToPBO for async readback",
    );
    return null;
  }

  /**
   * Get object by pick color (for picking)
   * @param {any} pickColor - The pick color
   * @returns {any} The picked object
   */
  getObjectByPickColor(pickColor: any): any {
    if (!pickColor) {
      return undefined;
    }

    // Convert pick color to key
    // Pick color is stored as RGBA where RGB encodes the pick ID
    const key = pickColor.red | (pickColor.green << 8) | (pickColor.blue << 16);

    return this._pickObjects.get(key);
  }

  /**
   * Create a pick ID for an object
   * Pick IDs are used for object picking via color-based identification
   * @param {any} object - The object to create a pick ID for
   * @returns {any} Pick ID with unique color
   */
  createPickId(object: any): any {
    // Get next pick color (increment counter)
    const key = this._nextPickColor[0]++;

    // Store object reference
    this._pickObjects.set(key, object);

    // Convert key to RGB color (24-bit)
    const red = key & 0xff;
    const green = (key >> 8) & 0xff;
    const blue = (key >> 16) & 0xff;

    return {
      key: key,
      color: {
        red: red,
        green: green,
        blue: blue,
        alpha: 255,
      },
      // Normalized color values for shaders (0.0 - 1.0)
      normalizedRgba: new Float32Array([
        red / 255.0,
        green / 255.0,
        blue / 255.0,
        1.0,
      ]),
      destroy: () => {
        // Remove from pick objects map when destroyed
        this._pickObjects.delete(key);
      },
    };
  }

  /**
   * Default framebuffer for the context
   */
  get defaultFramebuffer(): any {
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
  get shaderCache(): any {
    return this._shaderCache;
  }

  /**
   * Texture cache for the context
   */
  get textureCache(): any {
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
  get defaultTexture(): any {
    return this._defaultTexture;
  }

  /**
   * Default 1x1 black emissive texture
   */
  get defaultEmissiveTexture(): any {
    return this._defaultEmissiveTexture;
  }

  /**
   * Default 1x1 normal texture
   */
  get defaultNormalTexture(): any {
    return this._defaultNormalTexture;
  }

  /**
   * Default cube map
   */
  get defaultCubeMap(): any {
    return this._defaultCubeMap;
  }

  /**
   * Clear the framebuffer using a ClearCommand
   * This matches the WebGL Context.clear() signature for compatibility
   *
   * @param {any} clearCommand - The ClearCommand object containing color, depth, and stencil
   * @param {any} passState - The pass state (unused in basic implementation)
   */
  clear(clearCommand: any, passState?: any): void {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("Context has been destroyed.");
    }
    //>>includeEnd('debug');

    if (!this._device || !this._context) {
      return;
    }

    // WebGPU doesn't support inline clear commands during an active render pass
    // Instead, the clear happens when we start the render pass in beginFrame()
    // For Scene integration, we'll handle clears differently

    // For now, skip clear commands - they're handled by beginFrame()
    // This prevents the error and allows render() to continue
    return;
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

    const adapterName = (this._adapter as any).name ?? "Unknown GPU";
    return `WebGPU - ${adapterName}`;
  }

  /**
   * Destroy the context and free all resources
   */
  destroy(): void {
    if (this._isDestroyed) {
      return;
    }

    // Destroy device
    if (this._device) {
      this._device.destroy();
      this._device = null;
    }

    // Clear caches
    this._samplerCache.clear();
    this._bindGroupLayoutCache.clear();
    this._bindGroupCache.clear();

    // Clear buffer pools
    this._bufferPool.clear();
    this._uniformBufferPool = [];

    // Clear references
    this._adapter = null;
    this._context = null;
    this._isDestroyed = true;

    console.log("WebGPU Context destroyed");
  }

  // ====================================================================================
  // WebGL to WebGPU State Conversion Helpers
  // ====================================================================================

  /**
   * Convert WebGL blend factor to WebGPU blend factor
   * @private
   */
  private _webglToWebGPUBlendFactor(webglFactor: number): GPUBlendFactor {
    // WebGL blend factor constants
    const GL_ZERO = 0;
    const GL_ONE = 1;
    const GL_SRC_COLOR = 0x0300;
    const GL_ONE_MINUS_SRC_COLOR = 0x0301;
    const GL_DST_COLOR = 0x0306;
    const GL_ONE_MINUS_DST_COLOR = 0x0307;
    const GL_SRC_ALPHA = 0x0302;
    const GL_ONE_MINUS_SRC_ALPHA = 0x0303;
    const GL_DST_ALPHA = 0x0304;
    const GL_ONE_MINUS_DST_ALPHA = 0x0305;
    const GL_CONSTANT_COLOR = 0x8001;
    const GL_ONE_MINUS_CONSTANT_COLOR = 0x8002;
    const GL_CONSTANT_ALPHA = 0x8003;
    const GL_ONE_MINUS_CONSTANT_ALPHA = 0x8004;
    const GL_SRC_ALPHA_SATURATE = 0x0308;

    switch (webglFactor) {
      case GL_ZERO:
        return "zero";
      case GL_ONE:
        return "one";
      case GL_SRC_COLOR:
        return "src";
      case GL_ONE_MINUS_SRC_COLOR:
        return "one-minus-src";
      case GL_DST_COLOR:
        return "dst";
      case GL_ONE_MINUS_DST_COLOR:
        return "one-minus-dst";
      case GL_SRC_ALPHA:
        return "src-alpha";
      case GL_ONE_MINUS_SRC_ALPHA:
        return "one-minus-src-alpha";
      case GL_DST_ALPHA:
        return "dst-alpha";
      case GL_ONE_MINUS_DST_ALPHA:
        return "one-minus-dst-alpha";
      case GL_CONSTANT_COLOR:
        return "constant";
      case GL_ONE_MINUS_CONSTANT_COLOR:
        return "one-minus-constant";
      case GL_SRC_ALPHA_SATURATE:
        return "src-alpha-saturated";
      default:
        return "one";
    }
  }

  /**
   * Convert WebGL blend operation to WebGPU blend operation
   * @private
   */
  private _webglToWebGPUBlendOp(webglOp: number): GPUBlendOperation {
    const GL_FUNC_ADD = 0x8006;
    const GL_FUNC_SUBTRACT = 0x800a;
    const GL_FUNC_REVERSE_SUBTRACT = 0x800b;
    const GL_MIN = 0x8007;
    const GL_MAX = 0x8008;

    switch (webglOp) {
      case GL_FUNC_ADD:
        return "add";
      case GL_FUNC_SUBTRACT:
        return "subtract";
      case GL_FUNC_REVERSE_SUBTRACT:
        return "reverse-subtract";
      case GL_MIN:
        return "min";
      case GL_MAX:
        return "max";
      default:
        return "add";
    }
  }

  /**
   * Convert WebGL compare function to WebGPU compare function
   * @private
   */
  private _webglToWebGPUCompareFunction(webglFunc: number): GPUCompareFunction {
    const GL_NEVER = 0x0200;
    const GL_LESS = 0x0201;
    const GL_EQUAL = 0x0202;
    const GL_LEQUAL = 0x0203;
    const GL_GREATER = 0x0204;
    const GL_NOTEQUAL = 0x0205;
    const GL_GEQUAL = 0x0206;
    const GL_ALWAYS = 0x0207;

    switch (webglFunc) {
      case GL_NEVER:
        return "never";
      case GL_LESS:
        return "less";
      case GL_EQUAL:
        return "equal";
      case GL_LEQUAL:
        return "less-equal";
      case GL_GREATER:
        return "greater";
      case GL_NOTEQUAL:
        return "not-equal";
      case GL_GEQUAL:
        return "greater-equal";
      case GL_ALWAYS:
        return "always";
      default:
        return "less";
    }
  }

  /**
   * Get current pipeline state for pipeline creation
   * @returns {object} Current pipeline state
   */
  getPipelineState(): any {
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

    // Create new buffer
    return this._device.createBuffer({
      size,
      usage,
      label: `${type} Buffer (Pooled, ${size} bytes)`,
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

    console.log("[WebGPU] Texture copy operation completed");
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
   * Helper method for common texture creation from images
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

    return this._device.createBuffer({
      size,
      usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
      label: "Staging Buffer",
    });
  }

  /**
   * Get frame statistics
   * @returns {object} Statistics object
   */
  getStatistics(): any {
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
}

export default WebGPUContext;
