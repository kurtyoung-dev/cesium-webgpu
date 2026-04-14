/// <reference types="@webgpu/types" />
/**
 * WebGPU Post-Process Effects
 *
 * Complex multi-pass post-processing effects that manage their own
 * intermediate textures and render passes. Each effect implements the
 * same interface for integration with WebGPUPostProcessPipeline.
 *
 * Effects:
 * - BloomEffect: BrightPass → GaussianBlur (H+V) → BloomComposite
 * - AmbientOcclusionEffect: SSAO Generate → GaussianBlur (H+V) → AO Modulate
 * - DepthOfFieldEffect: GaussianBlur (H+V) → DoF Composite
 *
 * @private
 */

import GaussianBlur1DWGSL from "../../Shaders/WebGPU/PostProcess/GaussianBlur1D.js";
import {
  makeBindGroupLayout,
  sampler,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import BrightPassWGSL from "../../Shaders/WebGPU/PostProcess/BrightPass.js";
import BloomCompositeWGSL from "../../Shaders/WebGPU/PostProcess/BloomComposite.js";
import AmbientOcclusionGenerateWGSL from "../../Shaders/WebGPU/PostProcess/AmbientOcclusionGenerate.js";
import AmbientOcclusionModulateWGSL from "../../Shaders/WebGPU/PostProcess/AmbientOcclusionModulate.js";
import DepthOfFieldWGSL from "../../Shaders/WebGPU/PostProcess/DepthOfField.js";

// ======================================================================
//  Shared helpers
// ======================================================================

/** Create a standard fullscreen render pipeline from WGSL source. */
function createFullscreenPipeline(
  device: GPUDevice,
  label: string,
  wgsl: string,
  format: GPUTextureFormat,
  bindGroupLayout: GPUBindGroupLayout,
): GPURenderPipeline {
  const module = device.createShaderModule({
    label: `${label}-Shader`,
    code: wgsl,
  });
  const pipelineLayout = device.createPipelineLayout({
    label: `${label}-PipelineLayout`,
    bindGroupLayouts: [bindGroupLayout],
  });
  return device.createRenderPipeline({
    label: `${label}-Pipeline`,
    layout: pipelineLayout,
    vertex: { module, entryPoint: "vertexMain" },
    fragment: { module, entryPoint: "fragmentMain", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
}

function createTexture(
  device: GPUDevice,
  label: string,
  width: number,
  height: number,
  format: GPUTextureFormat,
): GPUTexture {
  return device.createTexture({
    label,
    size: { width, height },
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
}

function createUniformBuffer(
  device: GPUDevice,
  label: string,
  data: Float32Array,
): GPUBuffer {
  const buf = device.createBuffer({
    label,
    size: Math.max(data.byteLength, 16),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, data as Float32Array<ArrayBuffer>);
  return buf;
}

function executePass(
  encoder: GPUCommandEncoder,
  label: string,
  pipeline: GPURenderPipeline,
  bindGroup: GPUBindGroup,
  targetView: GPUTextureView,
): void {
  const pass = encoder.beginRenderPass({
    label,
    colorAttachments: [
      {
        view: targetView,
        loadOp: "clear" as GPULoadOp,
        storeOp: "store" as GPUStoreOp,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
}

// ======================================================================
//  PostProcessEffect interface
// ======================================================================

export interface PostProcessEffect {
  readonly name: string;
  enabled: boolean;
  initialize(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): void;
  resize(width: number, height: number): void;
  /**
   * Execute the effect. Returns the texture view containing the result.
   * @param encoder - Command encoder
   * @param sourceView - Scene color input
   * @param depthView - Scene depth input (may be null for effects that don't need depth)
   * @param sampler - Shared linear sampler
   */
  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView | null,
    sampler: GPUSampler,
  ): GPUTextureView;
  destroy(): void;
}

// ======================================================================
//  Bloom Effect
// ======================================================================

export interface BloomConfig {
  threshold?: number; // Luminance threshold for bright pass (default 0.8)
  intensity?: number; // Bloom glow intensity (default 0.5)
  sigma?: number; // Gaussian sigma for blur (default 3.5)
  glowOnly?: boolean; // Debug: show only the glow
}

export class BloomEffect implements PostProcessEffect {
  readonly name = "Bloom";
  enabled = true;

  private _device: GPUDevice | null = null;
  private _width = 0;
  private _height = 0;
  private _format: GPUTextureFormat = "bgra8unorm";

  // Intermediate textures (half-res for blur performance)
  private _brightTex: GPUTexture | null = null;
  private _brightView: GPUTextureView | null = null;
  private _blurTempTex: GPUTexture | null = null;
  private _blurTempView: GPUTextureView | null = null;
  private _blurResultTex: GPUTexture | null = null;
  private _blurResultView: GPUTextureView | null = null;
  private _compositeTex: GPUTexture | null = null;
  private _compositeView: GPUTextureView | null = null;

  // Pipelines
  private _brightPassPipeline: GPURenderPipeline | null = null;
  private _blurHPipeline: GPURenderPipeline | null = null;
  private _blurVPipeline: GPURenderPipeline | null = null;
  private _compositePipeline: GPURenderPipeline | null = null;

  // Bind group layouts
  private _singleTexLayout: GPUBindGroupLayout | null = null;
  private _compositeLayout: GPUBindGroupLayout | null = null;

  // Uniforms
  private _brightUniforms: GPUBuffer | null = null;
  private _blurHUniforms: GPUBuffer | null = null;
  private _blurVUniforms: GPUBuffer | null = null;
  private _compositeUniforms: GPUBuffer | null = null;

  private _config: Required<BloomConfig>;

  constructor(config: BloomConfig = {}) {
    this._config = {
      threshold: config.threshold ?? 0.8,
      intensity: config.intensity ?? 0.5,
      sigma: config.sigma ?? 3.5,
      glowOnly: config.glowOnly ?? false,
    };
  }

  initialize(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): void {
    this._device = device;
    this._width = width;
    this._height = height;
    this._format = format;

    const hw = Math.max(1, Math.floor(width / 2));
    const hh = Math.max(1, Math.floor(height / 2));

    this._createTextures(device, hw, hh, format);
    this._createPipelines(device, format, hw, hh);
    this._createUniforms(device, hw, hh);
  }

  resize(width: number, height: number): void {
    if (!this._device || (width === this._width && height === this._height))
      return;
    this._destroyTextures();
    this.initialize(this._device, width, height, this._format);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    _depthView: GPUTextureView | null,
    sampler: GPUSampler,
  ): GPUTextureView {
    if (!this._device) return sourceView;

    // Pass 1: Bright pass (full-res → half-res)
    const brightBG = this._device.createBindGroup({
      label: "Bloom-BrightPass-BG",
      layout: this._singleTexLayout!,
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: this._brightUniforms! } },
      ],
    });
    executePass(
      encoder,
      "Bloom-BrightPass",
      this._brightPassPipeline!,
      brightBG,
      this._brightView!,
    );

    // Pass 2: Horizontal Gaussian blur
    const blurHBG = this._device.createBindGroup({
      label: "Bloom-BlurH-BG",
      layout: this._singleTexLayout!,
      entries: [
        { binding: 0, resource: this._brightView! },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: this._blurHUniforms! } },
      ],
    });
    executePass(
      encoder,
      "Bloom-BlurH",
      this._blurHPipeline!,
      blurHBG,
      this._blurTempView!,
    );

    // Pass 3: Vertical Gaussian blur
    const blurVBG = this._device.createBindGroup({
      label: "Bloom-BlurV-BG",
      layout: this._singleTexLayout!,
      entries: [
        { binding: 0, resource: this._blurTempView! },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: this._blurVUniforms! } },
      ],
    });
    executePass(
      encoder,
      "Bloom-BlurV",
      this._blurVPipeline!,
      blurVBG,
      this._blurResultView!,
    );

    // Pass 4: Composite bloom + original scene
    const compositeBG = this._device.createBindGroup({
      label: "Bloom-Composite-BG",
      layout: this._compositeLayout!,
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: this._blurResultView! },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: this._compositeUniforms! } },
      ],
    });
    executePass(
      encoder,
      "Bloom-Composite",
      this._compositePipeline!,
      compositeBG,
      this._compositeView!,
    );

    return this._compositeView!;
  }

  private _createTextures(
    device: GPUDevice,
    hw: number,
    hh: number,
    format: GPUTextureFormat,
  ): void {
    this._brightTex = createTexture(device, "Bloom-Bright", hw, hh, format);
    this._brightView = this._brightTex.createView();
    this._blurTempTex = createTexture(device, "Bloom-BlurTemp", hw, hh, format);
    this._blurTempView = this._blurTempTex.createView();
    this._blurResultTex = createTexture(
      device,
      "Bloom-BlurResult",
      hw,
      hh,
      format,
    );
    this._blurResultView = this._blurResultTex.createView();
    this._compositeTex = createTexture(
      device,
      "Bloom-Composite",
      this._width,
      this._height,
      format,
    );
    this._compositeView = this._compositeTex.createView();
  }

  private _createPipelines(
    device: GPUDevice,
    format: GPUTextureFormat,
    hw: number,
    hh: number,
  ): void {
    // Single-texture layout: texture + sampler + uniform
    this._singleTexLayout = makeBindGroupLayout(device, "Bloom-SingleTex-BGL", [
      texture(0, Stage.FRAGMENT),
      sampler(1, Stage.FRAGMENT),
      uniformBuffer(2, Stage.FRAGMENT),
    ]);

    // Composite layout: 2 textures + sampler + uniform
    this._compositeLayout = makeBindGroupLayout(device, "Bloom-Composite-BGL", [
      texture(0, Stage.FRAGMENT),
      texture(1, Stage.FRAGMENT),
      sampler(2, Stage.FRAGMENT),
      uniformBuffer(3, Stage.FRAGMENT),
    ]);

    this._brightPassPipeline = createFullscreenPipeline(
      device,
      "Bloom-BrightPass",
      BrightPassWGSL,
      format,
      this._singleTexLayout,
    );
    this._blurHPipeline = createFullscreenPipeline(
      device,
      "Bloom-BlurH",
      GaussianBlur1DWGSL,
      format,
      this._singleTexLayout,
    );
    this._blurVPipeline = createFullscreenPipeline(
      device,
      "Bloom-BlurV",
      GaussianBlur1DWGSL,
      format,
      this._singleTexLayout,
    );
    this._compositePipeline = createFullscreenPipeline(
      device,
      "Bloom-Composite",
      BloomCompositeWGSL,
      format,
      this._compositeLayout,
    );
  }

  private _createUniforms(device: GPUDevice, hw: number, hh: number): void {
    const cfg = this._config;
    // BrightPass: threshold, contrast, bias, averageLuminance
    this._brightUniforms = createUniformBuffer(
      device,
      "Bloom-BrightPass-UB",
      new Float32Array([cfg.threshold, 1.0, 0.0, 0.5]),
    );

    // BlurH: delta, sigma, direction=0, stepSize=1
    this._blurHUniforms = createUniformBuffer(
      device,
      "Bloom-BlurH-UB",
      new Float32Array([
        1.0,
        cfg.sigma,
        0.0,
        1.0,
        1.0 / hw,
        1.0 / hh,
        1.0,
        0.0,
      ]),
    );

    // BlurV: delta, sigma, direction=1, stepSize=1
    this._blurVUniforms = createUniformBuffer(
      device,
      "Bloom-BlurV-UB",
      new Float32Array([
        1.0,
        cfg.sigma,
        1.0,
        1.0,
        1.0 / hw,
        1.0 / hh,
        1.0,
        0.0,
      ]),
    );

    // Composite: glowOnly, intensity
    this._compositeUniforms = createUniformBuffer(
      device,
      "Bloom-Composite-UB",
      new Float32Array([cfg.glowOnly ? 1.0 : 0.0, cfg.intensity, 0.0, 0.0]),
    );
  }

  /** Update bloom parameters at runtime. */
  updateConfig(config: Partial<BloomConfig>): void {
    if (!this._device) return;
    const cfg = this._config;
    if (config.threshold !== undefined) cfg.threshold = config.threshold;
    if (config.intensity !== undefined) cfg.intensity = config.intensity;
    if (config.sigma !== undefined) cfg.sigma = config.sigma;
    if (config.glowOnly !== undefined) cfg.glowOnly = config.glowOnly;

    if (this._brightUniforms) {
      this._device.queue.writeBuffer(
        this._brightUniforms,
        0,
        new Float32Array([
          cfg.threshold,
          1.0,
          0.0,
          0.5,
        ]) as Float32Array<ArrayBuffer>,
      );
    }
    if (this._compositeUniforms) {
      this._device.queue.writeBuffer(
        this._compositeUniforms,
        0,
        new Float32Array([
          cfg.glowOnly ? 1.0 : 0.0,
          cfg.intensity,
          0.0,
          0.0,
        ]) as Float32Array<ArrayBuffer>,
      );
    }
  }

  private _destroyTextures(): void {
    this._brightTex?.destroy();
    this._blurTempTex?.destroy();
    this._blurResultTex?.destroy();
    this._compositeTex?.destroy();
    this._brightTex = null;
    this._blurTempTex = null;
    this._blurResultTex = null;
    this._compositeTex = null;
  }

  destroy(): void {
    this._destroyTextures();
    this._brightUniforms?.destroy();
    this._blurHUniforms?.destroy();
    this._blurVUniforms?.destroy();
    this._compositeUniforms?.destroy();
    this._device = null;
  }
}

// ======================================================================
//  Ambient Occlusion Effect
// ======================================================================

export interface AmbientOcclusionConfig {
  intensity?: number; // AO intensity (default 3.0)
  bias?: number; // Depth bias to avoid self-occlusion (default 0.1)
  lengthCap?: number; // Max sample radius in eye space (default 0.26)
  stepCount?: number; // Radial steps per direction (default 4)
  directionCount?: number; // Number of sample directions (default 4)
  blurSigma?: number; // Blur sigma (default 2.0)
  ambientOcclusionOnly?: boolean; // Debug: show AO only
}

export class AmbientOcclusionEffect implements PostProcessEffect {
  readonly name = "AmbientOcclusion";
  enabled = true;

  private _device: GPUDevice | null = null;
  private _width = 0;
  private _height = 0;
  private _format: GPUTextureFormat = "bgra8unorm";

  // Intermediate textures
  private _aoRawTex: GPUTexture | null = null;
  private _aoRawView: GPUTextureView | null = null;
  private _aoBlurTempTex: GPUTexture | null = null;
  private _aoBlurTempView: GPUTextureView | null = null;
  private _aoBlurredTex: GPUTexture | null = null;
  private _aoBlurredView: GPUTextureView | null = null;
  private _outputTex: GPUTexture | null = null;
  private _outputView: GPUTextureView | null = null;

  // Random noise texture for SSAO sampling
  private _randomTex: GPUTexture | null = null;
  private _randomView: GPUTextureView | null = null;

  // Pipelines
  private _generatePipeline: GPURenderPipeline | null = null;
  private _blurHPipeline: GPURenderPipeline | null = null;
  private _blurVPipeline: GPURenderPipeline | null = null;
  private _modulatePipeline: GPURenderPipeline | null = null;

  // Layouts
  private _generateLayout: GPUBindGroupLayout | null = null;
  private _blurLayout: GPUBindGroupLayout | null = null;
  private _modulateLayout: GPUBindGroupLayout | null = null;

  // Uniforms
  private _generateUniforms: GPUBuffer | null = null;
  private _blurHUniforms: GPUBuffer | null = null;
  private _blurVUniforms: GPUBuffer | null = null;
  private _modulateUniforms: GPUBuffer | null = null;

  private _config: Required<AmbientOcclusionConfig>;

  constructor(config: AmbientOcclusionConfig = {}) {
    this._config = {
      intensity: config.intensity ?? 3.0,
      bias: config.bias ?? 0.1,
      lengthCap: config.lengthCap ?? 0.26,
      stepCount: config.stepCount ?? 4,
      directionCount: config.directionCount ?? 4,
      blurSigma: config.blurSigma ?? 2.0,
      ambientOcclusionOnly: config.ambientOcclusionOnly ?? false,
    };
  }

  initialize(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): void {
    this._device = device;
    this._width = width;
    this._height = height;
    this._format = format;

    this._createTextures(device, width, height, format);
    this._createRandomTexture(device);
    this._createPipelines(device, format);
    this._createUniforms(device);
  }

  resize(width: number, height: number): void {
    if (!this._device || (width === this._width && height === this._height))
      return;
    this._destroyTextures();
    this.initialize(this._device, width, height, this._format);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView | null,
    sampler: GPUSampler,
  ): GPUTextureView {
    if (!this._device || !depthView) return sourceView;

    // Pass 1: Generate raw AO from depth
    const genBG = this._device.createBindGroup({
      label: "AO-Generate-BG",
      layout: this._generateLayout!,
      entries: [
        { binding: 0, resource: depthView },
        { binding: 1, resource: this._randomView! },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: this._generateUniforms! } },
      ],
    });
    executePass(
      encoder,
      "AO-Generate",
      this._generatePipeline!,
      genBG,
      this._aoRawView!,
    );

    // Pass 2: Horizontal blur on AO
    const blurHBG = this._device.createBindGroup({
      label: "AO-BlurH-BG",
      layout: this._blurLayout!,
      entries: [
        { binding: 0, resource: this._aoRawView! },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: this._blurHUniforms! } },
      ],
    });
    executePass(
      encoder,
      "AO-BlurH",
      this._blurHPipeline!,
      blurHBG,
      this._aoBlurTempView!,
    );

    // Pass 3: Vertical blur on AO
    const blurVBG = this._device.createBindGroup({
      label: "AO-BlurV-BG",
      layout: this._blurLayout!,
      entries: [
        { binding: 0, resource: this._aoBlurTempView! },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: this._blurVUniforms! } },
      ],
    });
    executePass(
      encoder,
      "AO-BlurV",
      this._blurVPipeline!,
      blurVBG,
      this._aoBlurredView!,
    );

    // Pass 4: Modulate scene color with blurred AO
    const modBG = this._device.createBindGroup({
      label: "AO-Modulate-BG",
      layout: this._modulateLayout!,
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: this._aoBlurredView! },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: this._modulateUniforms! } },
      ],
    });
    executePass(
      encoder,
      "AO-Modulate",
      this._modulatePipeline!,
      modBG,
      this._outputView!,
    );

    return this._outputView!;
  }

  private _createTextures(
    device: GPUDevice,
    w: number,
    h: number,
    format: GPUTextureFormat,
  ): void {
    this._aoRawTex = createTexture(device, "AO-Raw", w, h, format);
    this._aoRawView = this._aoRawTex.createView();
    this._aoBlurTempTex = createTexture(device, "AO-BlurTemp", w, h, format);
    this._aoBlurTempView = this._aoBlurTempTex.createView();
    this._aoBlurredTex = createTexture(device, "AO-Blurred", w, h, format);
    this._aoBlurredView = this._aoBlurredTex.createView();
    this._outputTex = createTexture(device, "AO-Output", w, h, format);
    this._outputView = this._outputTex.createView();
  }

  private _createRandomTexture(device: GPUDevice): void {
    const size = 4; // 4x4 random texture, tiled across screen
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      data[i * 4 + 0] = Math.floor(Math.random() * 255);
      data[i * 4 + 1] = Math.floor(Math.random() * 255);
      data[i * 4 + 2] = 0;
      data[i * 4 + 3] = 255;
    }
    this._randomTex = device.createTexture({
      label: "AO-RandomNoise",
      size: { width: size, height: size },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this._randomTex },
      data,
      { bytesPerRow: size * 4 },
      { width: size, height: size },
    );
    this._randomView = this._randomTex.createView();
  }

  private _createPipelines(device: GPUDevice, format: GPUTextureFormat): void {
    // SSAO Generate layout: depthTex + randomTex + sampler + uniforms
    this._generateLayout = device.createBindGroupLayout({
      label: "AO-Generate-BGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    // Blur layout: single texture + sampler + uniforms
    this._blurLayout = device.createBindGroupLayout({
      label: "AO-Blur-BGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    // Modulate layout: scene + AO + sampler + uniforms
    this._modulateLayout = device.createBindGroupLayout({
      label: "AO-Modulate-BGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    this._generatePipeline = createFullscreenPipeline(
      device,
      "AO-Generate",
      AmbientOcclusionGenerateWGSL,
      format,
      this._generateLayout,
    );
    this._blurHPipeline = createFullscreenPipeline(
      device,
      "AO-BlurH",
      GaussianBlur1DWGSL,
      format,
      this._blurLayout,
    );
    this._blurVPipeline = createFullscreenPipeline(
      device,
      "AO-BlurV",
      GaussianBlur1DWGSL,
      format,
      this._blurLayout,
    );
    this._modulatePipeline = createFullscreenPipeline(
      device,
      "AO-Modulate",
      AmbientOcclusionModulateWGSL,
      format,
      this._modulateLayout,
    );
  }

  private _createUniforms(device: GPUDevice): void {
    const cfg = this._config;
    const w = this._width;
    const h = this._height;

    // Generate: intensity, bias, lengthCap, stepCount | directionCount, 1/w, 1/h, randomTexSize | near, far, 0, 0 | pad
    this._generateUniforms = createUniformBuffer(
      device,
      "AO-Generate-UB",
      new Float32Array([
        cfg.intensity,
        cfg.bias,
        cfg.lengthCap,
        cfg.stepCount,
        cfg.directionCount,
        1.0 / w,
        1.0 / h,
        4.0,
        0.1,
        10000.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
      ]),
    );

    // BlurH/V: same as bloom blur uniforms
    this._blurHUniforms = createUniformBuffer(
      device,
      "AO-BlurH-UB",
      new Float32Array([
        1.0,
        cfg.blurSigma,
        0.0,
        1.0,
        1.0 / w,
        1.0 / h,
        1.0,
        0.0,
      ]),
    );
    this._blurVUniforms = createUniformBuffer(
      device,
      "AO-BlurV-UB",
      new Float32Array([
        1.0,
        cfg.blurSigma,
        1.0,
        1.0,
        1.0 / w,
        1.0 / h,
        1.0,
        0.0,
      ]),
    );

    // Modulate: aoOnly
    this._modulateUniforms = createUniformBuffer(
      device,
      "AO-Modulate-UB",
      new Float32Array([cfg.ambientOcclusionOnly ? 1.0 : 0.0, 0.0, 0.0, 0.0]),
    );
  }

  /** Update AO parameters at runtime. */
  updateConfig(config: Partial<AmbientOcclusionConfig>): void {
    if (!this._device) return;
    Object.assign(this._config, config);
    // Recreate uniforms with updated values
    this._generateUniforms?.destroy();
    this._modulateUniforms?.destroy();
    this._createUniforms(this._device);
  }

  private _destroyTextures(): void {
    this._aoRawTex?.destroy();
    this._aoBlurTempTex?.destroy();
    this._aoBlurredTex?.destroy();
    this._outputTex?.destroy();
    this._randomTex?.destroy();
    this._aoRawTex = null;
    this._aoBlurTempTex = null;
    this._aoBlurredTex = null;
    this._outputTex = null;
    this._randomTex = null;
  }

  destroy(): void {
    this._destroyTextures();
    this._generateUniforms?.destroy();
    this._blurHUniforms?.destroy();
    this._blurVUniforms?.destroy();
    this._modulateUniforms?.destroy();
    this._device = null;
  }
}

// ======================================================================
//  Depth of Field Effect
// ======================================================================

export interface DepthOfFieldConfig {
  focalDistance?: number; // Distance to focal plane (default 50.0)
  focalRange?: number; // Width of in-focus zone (default 20.0)
  blurSigma?: number; // Gaussian sigma for blur (default 4.0)
}

export class DepthOfFieldEffect implements PostProcessEffect {
  readonly name = "DepthOfField";
  enabled = true;

  private _device: GPUDevice | null = null;
  private _width = 0;
  private _height = 0;
  private _format: GPUTextureFormat = "bgra8unorm";

  // Intermediate textures
  private _blurTempTex: GPUTexture | null = null;
  private _blurTempView: GPUTextureView | null = null;
  private _blurredTex: GPUTexture | null = null;
  private _blurredView: GPUTextureView | null = null;
  private _outputTex: GPUTexture | null = null;
  private _outputView: GPUTextureView | null = null;

  // Pipelines
  private _blurHPipeline: GPURenderPipeline | null = null;
  private _blurVPipeline: GPURenderPipeline | null = null;
  private _dofPipeline: GPURenderPipeline | null = null;

  // Layouts
  private _blurLayout: GPUBindGroupLayout | null = null;
  private _dofLayout: GPUBindGroupLayout | null = null;

  // Uniforms
  private _blurHUniforms: GPUBuffer | null = null;
  private _blurVUniforms: GPUBuffer | null = null;
  private _dofUniforms: GPUBuffer | null = null;

  private _config: Required<DepthOfFieldConfig>;

  constructor(config: DepthOfFieldConfig = {}) {
    this._config = {
      focalDistance: config.focalDistance ?? 50.0,
      focalRange: config.focalRange ?? 20.0,
      blurSigma: config.blurSigma ?? 4.0,
    };
  }

  initialize(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): void {
    this._device = device;
    this._width = width;
    this._height = height;
    this._format = format;

    this._createTextures(device, width, height, format);
    this._createPipelines(device, format);
    this._createUniforms(device);
  }

  resize(width: number, height: number): void {
    if (!this._device || (width === this._width && height === this._height))
      return;
    this._destroyTextures();
    this.initialize(this._device, width, height, this._format);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView | null,
    sampler: GPUSampler,
  ): GPUTextureView {
    if (!this._device || !depthView) return sourceView;

    // Pass 1: Horizontal blur
    const blurHBG = this._device.createBindGroup({
      label: "DoF-BlurH-BG",
      layout: this._blurLayout!,
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: this._blurHUniforms! } },
      ],
    });
    executePass(
      encoder,
      "DoF-BlurH",
      this._blurHPipeline!,
      blurHBG,
      this._blurTempView!,
    );

    // Pass 2: Vertical blur
    const blurVBG = this._device.createBindGroup({
      label: "DoF-BlurV-BG",
      layout: this._blurLayout!,
      entries: [
        { binding: 0, resource: this._blurTempView! },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: this._blurVUniforms! } },
      ],
    });
    executePass(
      encoder,
      "DoF-BlurV",
      this._blurVPipeline!,
      blurVBG,
      this._blurredView!,
    );

    // Pass 3: DoF composite (sharp + blurred + depth → output)
    const dofBG = this._device.createBindGroup({
      label: "DoF-Composite-BG",
      layout: this._dofLayout!,
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: this._blurredView! },
        { binding: 2, resource: depthView },
        { binding: 3, resource: sampler },
        { binding: 4, resource: { buffer: this._dofUniforms! } },
      ],
    });
    executePass(
      encoder,
      "DoF-Composite",
      this._dofPipeline!,
      dofBG,
      this._outputView!,
    );

    return this._outputView!;
  }

  private _createTextures(
    device: GPUDevice,
    w: number,
    h: number,
    format: GPUTextureFormat,
  ): void {
    this._blurTempTex = createTexture(device, "DoF-BlurTemp", w, h, format);
    this._blurTempView = this._blurTempTex.createView();
    this._blurredTex = createTexture(device, "DoF-Blurred", w, h, format);
    this._blurredView = this._blurredTex.createView();
    this._outputTex = createTexture(device, "DoF-Output", w, h, format);
    this._outputView = this._outputTex.createView();
  }

  private _createPipelines(device: GPUDevice, format: GPUTextureFormat): void {
    this._blurLayout = device.createBindGroupLayout({
      label: "DoF-Blur-BGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    // DoF composite layout: scene + blur + depth + sampler + uniforms
    this._dofLayout = device.createBindGroupLayout({
      label: "DoF-Composite-BGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    this._blurHPipeline = createFullscreenPipeline(
      device,
      "DoF-BlurH",
      GaussianBlur1DWGSL,
      format,
      this._blurLayout,
    );
    this._blurVPipeline = createFullscreenPipeline(
      device,
      "DoF-BlurV",
      GaussianBlur1DWGSL,
      format,
      this._blurLayout,
    );
    this._dofPipeline = createFullscreenPipeline(
      device,
      "DoF-Composite",
      DepthOfFieldWGSL,
      format,
      this._dofLayout,
    );
  }

  private _createUniforms(device: GPUDevice): void {
    const cfg = this._config;
    const w = this._width;
    const h = this._height;

    this._blurHUniforms = createUniformBuffer(
      device,
      "DoF-BlurH-UB",
      new Float32Array([
        1.0,
        cfg.blurSigma,
        0.0,
        1.0,
        1.0 / w,
        1.0 / h,
        1.0,
        0.0,
      ]),
    );
    this._blurVUniforms = createUniformBuffer(
      device,
      "DoF-BlurV-UB",
      new Float32Array([
        1.0,
        cfg.blurSigma,
        1.0,
        1.0,
        1.0 / w,
        1.0 / h,
        1.0,
        0.0,
      ]),
    );

    // DoF: focalDistance, focalRange, near, far
    this._dofUniforms = createUniformBuffer(
      device,
      "DoF-Composite-UB",
      new Float32Array([cfg.focalDistance, cfg.focalRange, 0.1, 10000.0]),
    );
  }

  /** Update DoF parameters at runtime. */
  updateConfig(config: Partial<DepthOfFieldConfig>): void {
    if (!this._device) return;
    Object.assign(this._config, config);
    this._dofUniforms?.destroy();
    this._createUniforms(this._device);
  }

  private _destroyTextures(): void {
    this._blurTempTex?.destroy();
    this._blurredTex?.destroy();
    this._outputTex?.destroy();
    this._blurTempTex = null;
    this._blurredTex = null;
    this._outputTex = null;
  }

  destroy(): void {
    this._destroyTextures();
    this._blurHUniforms?.destroy();
    this._blurVUniforms?.destroy();
    this._dofUniforms?.destroy();
    this._device = null;
  }
}
