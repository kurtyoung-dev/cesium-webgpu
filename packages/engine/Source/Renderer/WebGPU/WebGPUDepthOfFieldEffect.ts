/// <reference types="@webgpu/types" />
/**
 * WebGPU DepthOfFieldEffect
 *
 * @module WebGPUDepthOfFieldEffect
 */

import DepthOfFieldWGSL from "../../Shaders/WebGPU/PostProcess/DepthOfField.js";
import GaussianBlur1DWGSL from "../../Shaders/WebGPU/PostProcess/GaussianBlur1D.js";
// The f16 variants are selected when `useShaderF16` is true.
import DepthOfFieldF16WGSL from "../../Shaders/WebGPU/PostProcess/DepthOfField_f16.js";
import GaussianBlur1DF16WGSL from "../../Shaders/WebGPU/PostProcess/GaussianBlur1D_f16.js";
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
import type { WebGPUPassTimestampProvider } from "./WebGPUPerformanceManager.js";

export interface DepthOfFieldConfig {
  focalDistance?: number; // Distance to focal plane (default 50.0)
  focalRange?: number; // Width of in-focus zone (default 20.0)
  blurSigma?: number; // Gaussian sigma for blur (default 4.0)
}

export class DepthOfFieldEffect implements PostProcessEffect {
  readonly name = "DepthOfField";
  enabled = true;

  // The pipeline sets this before initialize().
  // Defaults to false for a byte-identical f32 path.
  useShaderF16 = false;

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

  // Bind-group cache.
  private _bgCache = new WebGPUBindGroupCache();

  private _config: Required<DepthOfFieldConfig>;

  // Live per-frame frustum near/far + the renderer-wide log-depth flag. The
  // placeholder bracket covers the first frame before setFrustum runs; the
  // per-frame push in the collection overwrites it with the real camera values.
  private _near = 0.1;
  private _far = 10000.0;
  private _logActive = 0.0;

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
    // `initialize` reassigns every uniform buffer; release the previous set.
    this._destroyUniforms();
    // Texture views change on resize.
    this._bgCache.invalidateAll();
    this.initialize(this._device, width, height, this._format);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView | null,
    sampler: GPUSampler,
    timestampProvider?: WebGPUPassTimestampProvider,
  ): GPUTextureView {
    if (!this._device || !depthView) return sourceView;

    // All three bind groups are cached.

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
      timestampProvider,
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
      timestampProvider,
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
      timestampProvider,
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

    const f16 = this.useShaderF16;
    const blurSrc = f16 ? GaussianBlur1DF16WGSL : GaussianBlur1DWGSL;
    const dofSrc = f16 ? DepthOfFieldF16WGSL : DepthOfFieldWGSL;
    this._blurHPipeline = createFullscreenPipeline(
      device,
      "DoF-BlurH",
      blurSrc,
      format,
      this._blurLayout,
    );
    this._blurVPipeline = createFullscreenPipeline(
      device,
      "DoF-BlurV",
      blurSrc,
      format,
      this._blurLayout,
    );
    this._dofPipeline = createFullscreenPipeline(
      device,
      "DoF-Composite",
      dofSrc,
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

    // DoF params vec4: focalDistance, focalRange, near, far. The UB has a second
    // vec4 carrying the log-depth flag (params2.x = logActive). The DepthOfField
    // FS reads params2.x and reverses the log-depth sample before linearizing.
    // Near/far values are seeded from the live-updated fields so a setFrustum()
    // call before a rebuild is preserved.
    this._dofUniforms = createUniformBuffer(
      device,
      "DoF-Composite-UB",
      new Float32Array([
        cfg.focalDistance,
        cfg.focalRange,
        this._near,
        this._far,
        this._logActive,
        0.0,
        0.0,
        0.0,
      ]),
    );
  }

  /**
   * Push the live per-frame camera frustum near/far plus the renderer-wide
   * `logActive` flag into the composite UB. The DoF FS linearizes raw depth with
   * `near * far / (far - z*(far-near))`, so the supplied near/far values must
   * match the live frustum. Writes `params.zw` (near, far) and `params2.x`
   * (`logActive`) in place; the FS reverses log depth when
   * `params2.x >= 0.5`. Off-gate: DoF is opt-in and default-off, so this is only
   * reached when the effect is enabled.
   */
  setFrustum(near: number, far: number, logActive: boolean): void {
    this._near = near;
    this._far = far;
    this._logActive = logActive ? 1.0 : 0.0;
    if (!this._device || !this._dofUniforms) return;
    // params.z=near, params.w=far start at byte offset 8; params2.x=logActive
    // at byte offset 16. Write the contiguous [near, far, logActive] run.
    const data = new Float32Array([this._near, this._far, this._logActive]);
    this._device.queue.writeBuffer(
      this._dofUniforms,
      8,
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
  }

  /**
   * Update DoF parameters at runtime.
   *
   * `_createUniforms` reassigns all three buffers, so releasing only the
   * composite one orphaned the blur pair on every call. The bind-group cache
   * keys on resource identity, so its entries naming the replaced buffers are
   * dropped rather than left to accumulate one dead entry per update.
   */
  updateConfig(config: Partial<DepthOfFieldConfig>): void {
    if (!this._device) return;
    Object.assign(this._config, config);
    this._destroyUniforms();
    this._bgCache.invalidateAll();
    this._createUniforms(this._device);
  }

  /**
   * Releases all three uniform buffers. Every caller of `_createUniforms` after
   * the first reassigns all three, so anything not released here is orphaned.
   */
  private _destroyUniforms(): void {
    this._blurHUniforms?.destroy();
    this._blurVUniforms?.destroy();
    this._dofUniforms?.destroy();
    this._blurHUniforms = null;
    this._blurVUniforms = null;
    this._dofUniforms = null;
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
    this._destroyUniforms();
    this._device = null;
  }
}
