/// <reference types="@webgpu/types" />
/**
 * WebGPU DepthOfFieldEffect
 *
 * Per-effect slice extracted from `WebGPUPostProcessEffects`
 * (Batch 160 of the maintainability sweep).
 *
 * @module WebGPUDepthOfFieldEffect
 */

import DepthOfFieldWGSL from "../../Shaders/WebGPU/PostProcess/DepthOfField.js";
import GaussianBlur1DWGSL from "../../Shaders/WebGPU/PostProcess/GaussianBlur1D.js";
import {
  makeBindGroupLayout,
  sampler,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import WebGPUBindGroupCache from "./WebGPUBindGroupCache.js";
import {
  createFullscreenPipeline,
  createTexture,
  createUniformBuffer,
  executePass,
} from "./WebGPUPostProcessEffects.js";
import type { PostProcessEffect } from "./WebGPUPostProcessEffects.js";

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

  // C-R11 (Batch 32) — bind group cache.
  private _bgCache = new WebGPUBindGroupCache();

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
    // C-R11 (Batch 32) — texture views change on resize.
    this._bgCache.invalidateAll();
    this.initialize(this._device, width, height, this._format);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView | null,
    sampler: GPUSampler,
  ): GPUTextureView {
    if (!this._device || !depthView) return sourceView;

    // C-R11 (Batch 32) — three bind groups cached.

    // Pass 1: Horizontal blur
    const blurHBG = this._bgCache.getOrCreate(
      this._device,
      "DoF-BlurH-BG",
      this._blurLayout!,
      [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: this._blurHUniforms! } },
      ],
    );
    executePass(
      encoder,
      "DoF-BlurH",
      this._blurHPipeline!,
      blurHBG,
      this._blurTempView!,
    );

    // Pass 2: Vertical blur
    const blurVBG = this._bgCache.getOrCreate(
      this._device,
      "DoF-BlurV-BG",
      this._blurLayout!,
      [
        { binding: 0, resource: this._blurTempView! },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: this._blurVUniforms! } },
      ],
    );
    executePass(
      encoder,
      "DoF-BlurV",
      this._blurVPipeline!,
      blurVBG,
      this._blurredView!,
    );

    // Pass 3: DoF composite (sharp + blurred + depth → output)
    const dofBG = this._bgCache.getOrCreate(
      this._device,
      "DoF-Composite-BG",
      this._dofLayout!,
      [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: this._blurredView! },
        { binding: 2, resource: depthView },
        { binding: 3, resource: sampler },
        { binding: 4, resource: { buffer: this._dofUniforms! } },
      ],
    );
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
    this._blurLayout = makeBindGroupLayout(device, "DoF-Blur-BGL", [
      texture(0, Stage.FRAGMENT),
      sampler(1, Stage.FRAGMENT),
      uniformBuffer(2, Stage.FRAGMENT),
    ]);

    // DoF composite layout: scene + blur + depth + sampler + uniforms
    this._dofLayout = makeBindGroupLayout(device, "DoF-Composite-BGL", [
      texture(0, Stage.FRAGMENT),
      texture(1, Stage.FRAGMENT),
      texture(2, Stage.FRAGMENT),
      sampler(3, Stage.FRAGMENT),
      uniformBuffer(4, Stage.FRAGMENT),
    ]);

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
