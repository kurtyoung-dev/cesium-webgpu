/// <reference types="@webgpu/types" />
/**
 * WebGPU AmbientOcclusionEffect
 *
 * @module WebGPUAmbientOcclusionEffect
 */

import AmbientOcclusionGenerateWGSL from "../../Shaders/WebGPU/PostProcess/AmbientOcclusionGenerate.js";
import AmbientOcclusionModulateWGSL from "../../Shaders/WebGPU/PostProcess/AmbientOcclusionModulate.js";
import GTAOGenerateWGSL from "../../Shaders/WebGPU/PostProcess/GTAOGenerate.js";
import GaussianBlur1DWGSL from "../../Shaders/WebGPU/PostProcess/GaussianBlur1D.js";
// The f16 variants are selected when `useShaderF16` is enabled. GTAO keeps its
// f32 generation shader because its horizon search is precision-critical.
import AmbientOcclusionGenerateF16WGSL from "../../Shaders/WebGPU/PostProcess/AmbientOcclusionGenerate_f16.js";
import AmbientOcclusionModulateF16WGSL from "../../Shaders/WebGPU/PostProcess/AmbientOcclusionModulate_f16.js";
import GaussianBlur1DF16WGSL from "../../Shaders/WebGPU/PostProcess/GaussianBlur1D_f16.js";
// Screen-space diffuse global illumination based on the SSILVB visibility
// bitmask. Only the opt-in WebGPU `"ssgi"` pipeline compiles or executes these
// shaders; the HBAO and GTAO pipelines remain separate.
import SSGIGenerateWGSL from "../../Shaders/WebGPU/PostProcess/SSGIGenerate.js";
import BilateralBlur1DWGSL from "../../Shaders/WebGPU/PostProcess/BilateralBlur1D.js";
import SSGICompositeWGSL from "../../Shaders/WebGPU/PostProcess/SSGIComposite.js";
import {
  makeBindGroupLayout,
  sampler,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import WebGPUBindGroupCache from "./WebGPUBindGroupCache.js";
import type { BindGroupCacheStats } from "./WebGPUBindGroupCache.js";
import {
  createFullscreenPipeline,
  createTexture,
  createUniformBuffer,
  executePass,
} from "./WebGPUPostProcessEffects.js";
import type { PostProcessEffect } from "./WebGPUPostProcessEffects.js";
import type { WebGPUPassTimestampProvider } from "./WebGPUPerformanceManager.js";

/**
 * Ambient-occlusion algorithm selector.
 *
 *   "hbao" — Horizon-Based AO (legacy default). Discrete horizon-angle
 *            max over N directions. Fast, slightly over-darkens silhouettes.
 *   "gtao" — Ground-Truth AO (Jimenez 2016). Analytic cos-weighted horizon
 *            integral per direction. Matches the reference integral
 *            exactly; modern standard in AAA engines (UE5, Unity HDRP,
 *            Frostbite). ~10-15% more ALU than HBAO for visibly better
 *            silhouettes and grazing-angle response.
 *   "ssgi" — Screen-Space Global Illumination using the SSILVB visibility
 *            bitmask. This opt-in WebGPU path extends GTAO's horizon scan to
 *            produce both a thin-surface-aware AO term and diffuse indirect
 *            color in one pass. The `rgba16float` result passes through a
 *            depth-aware bilateral blur before an additive composite.
 *            Selecting it replaces the HBAO/GTAO generation-and-modulation
 *            chain.
 *
 * References:
 *   - Therrien, Levesque, and Gilet, "Screen Space Indirect Lighting with
 *     Visibility Bitmask" (The Visual Computer 2023, arXiv:2301.11376) — the
 *     visibility-bitmask technique, reimplemented without copied source.
 */
export type AOAlgorithm = "hbao" | "gtao" | "ssgi";

export interface AmbientOcclusionConfig {
  /** AO algorithm — defaults to "hbao" for backwards compatibility. */
  algorithm?: AOAlgorithm;
  intensity?: number; // AO intensity (default 3.0)
  bias?: number; // Depth bias to avoid self-occlusion (default 0.1)
  lengthCap?: number; // Max sample radius in eye space (default 0.26)
  stepCount?: number; // Radial steps per direction (default 4)
  directionCount?: number; // Number of sample directions (default 4)
  blurSigma?: number; // Blur sigma (default 2.0)
  ambientOcclusionOnly?: boolean; // Debug: show AO only

  // The following fields are consumed only by the `"ssgi"` algorithm.
  /** Indirect-bounce brightness multiplier (default 1.0). */
  giIntensity?: number;
  /** SSGI slice count — overrides directionCount for ssgi (default 2). */
  sliceCount?: number;
  /** SSGI radial step count — overrides stepCount for ssgi (default 8). */
  ssgiStepCount?: number;
  /** Screen-space sample reach in pixels (default 32). */
  radiusPixels?: number;
  /** Eye-space radius cap in metres — orbit-view no-op guard (default 500). */
  maxWorldRadius?: number;
  /** Minimum linear thickness in metres (default 1.0). */
  thicknessMin?: number;
  /** Linear thickness fraction of view distance (default 0.005). */
  thicknessK?: number;
  /** HDR firefly luminance clamp (default 7.0). */
  luminanceClamp?: number;
  /** Exponential step distribution factor (default 2.0). */
  expFactor?: number;
  /** SSGI composite AO weight [0,1] (default 1.0). */
  aoWeight?: number;
  /** SSGI debug: 0 composite / 1 AO-only / 2 GI-only / 3 scene (default 0). */
  ssgiDebugMode?: number;
}

export class AmbientOcclusionEffect implements PostProcessEffect {
  readonly name = "AmbientOcclusion";
  enabled = true;

  // Set by the pipeline before `initialize()`; false retains the f32 path.
  useShaderF16 = false;

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

  // A 1×1 placeholder texture for the G-buffer normal binding when
  // `scene.deferredLighting === false`. Bound so the bind-group layout stays
  // stable across both states of the flag; the shader's `frustum.w` uniform
  // selects between depth reconstruction, where the placeholder is unused,
  // and G-buffer sampling, where the real view is bound.
  private _gBufferPlaceholderTex: GPUTexture | null = null;
  private _gBufferPlaceholderView: GPUTextureView | null = null;

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

  // Bind-group cache: four bind groups per frame drop to about zero after
  // the first. Invalidated on resize, when texture views rotate.
  private _bgCache = new WebGPUBindGroupCache();

  // Most recently supplied camera frustum and renderer log-depth flag. The
  // initial bracket covers an execute that precedes the first `setFrustum`.
  private _near = 0.1;
  private _far = 10000.0;
  private _logActive = 0.0;

  // SSGI uses a depth-aware bilateral-blur layout and a frame counter for
  // temporal slice rotation. Neither is used by the HBAO or GTAO pipelines.
  private _ssgiBlurLayout: GPUBindGroupLayout | null = null;
  private _frameCounter = 0;
  // CPU-computed altitude fade: 1 near the ground and 0 from orbit. A zero
  // makes the generator return `(gi=0, ao=1)`, so the composite is a byte-exact
  // no-op independently of depth reconstruction. Start at 1 for the first
  // enabled frame.
  private _altitudeFade = 1.0;

  private _config: Required<AmbientOcclusionConfig>;

  constructor(config: AmbientOcclusionConfig = {}) {
    this._config = {
      // Default to HBAO for backwards compatibility; callers opt into GTAO.
      algorithm: config.algorithm ?? "hbao",
      intensity: config.intensity ?? 3.0,
      bias: config.bias ?? 0.1,
      lengthCap: config.lengthCap ?? 0.26,
      stepCount: config.stepCount ?? 4,
      directionCount: config.directionCount ?? 4,
      blurSigma: config.blurSigma ?? 2.0,
      ambientOcclusionOnly: config.ambientOcclusionOnly ?? false,
      // SSGI-specific defaults.
      giIntensity: config.giIntensity ?? 1.0,
      sliceCount: config.sliceCount ?? 2,
      ssgiStepCount: config.ssgiStepCount ?? 8,
      radiusPixels: config.radiusPixels ?? 32.0,
      maxWorldRadius: config.maxWorldRadius ?? 500.0,
      thicknessMin: config.thicknessMin ?? 1.0,
      thicknessK: config.thicknessK ?? 0.005,
      luminanceClamp: config.luminanceClamp ?? 7.0,
      expFactor: config.expFactor ?? 2.0,
      aoWeight: config.aoWeight ?? 1.0,
      ssgiDebugMode: config.ssgiDebugMode ?? 0,
    };
  }

  /**
   * Read-only snapshot of the bind-group cache counters for
   * `WebGPUContext.getRendererStatistics()` and `CesiumDebug.cacheStats()`.
   * Pure exposure of bookkeeping the cache already maintains.
   */
  getBindGroupCacheStats(): BindGroupCacheStats {
    return this._bgCache.getStats();
  }

  /** True when the SSGI (SSILVB) path is selected. */
  private get _isSSGI(): boolean {
    return this._config.algorithm === "ssgi";
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
    this._createGBufferPlaceholder(device);
    this._createPipelines(device, format);
    this._createUniforms(device);
  }

  resize(width: number, height: number): void {
    if (!this._device || (width === this._width && height === this._height))
      return;
    this._destroyTextures();
    // Texture views change on resize.
    this._bgCache.invalidateAll();
    this.initialize(this._device, width, height, this._format);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView | null,
    sampler: GPUSampler,
    // When non-null, the SSAO path reads surface normals from this G-buffer
    // view. The post-process pipeline forwards
    // `view.gBufferFramebuffer.normalRoughnessTexture` only while
    // `scene.deferredLighting` is enabled; otherwise it passes null and SSAO
    // reconstructs normals from depth.
    gBufferNormalView?: GPUTextureView | null,
    timestampProvider?: WebGPUPassTimestampProvider,
  ): GPUTextureView {
    if (!this._device || !depthView) return sourceView;

    // SSGI has a separate generation, bilateral-blur, and additive-composite
    // chain; HBAO and GTAO use the AO modulation chain below.
    if (this._isSSGI) {
      return this._executeSSGI(
        encoder,
        sourceView,
        depthView,
        sampler,
        timestampProvider,
      );
    }

    // Select the normal source. A real G-buffer view sets `frustum.w` to 1;
    // otherwise the placeholder is bound and the shader reconstructs normals
    // from depth.
    const useGBuffer =
      gBufferNormalView !== undefined && gBufferNormalView !== null;
    const normalView = useGBuffer
      ? (gBufferNormalView as GPUTextureView)
      : this._gBufferPlaceholderView!;
    this._writeGenerateUniforms(useGBuffer);

    // All four bind groups are cached. The depth view is stable within a
    // frame, and the source view's stability depends on whether an upstream
    // post-process stage recreated the framebuffer, which happens only on
    // resize, so the cache steady-states at four entries.

    // Pass 1: Generate raw AO from depth. The cache key includes the normal
    // source, producing one bind group for the placeholder and one for the real
    // G-buffer view. Binding-list identity invalidates the entry when the view
    // changes.
    const genBG = this._bgCache.getOrCreate(
      this._device,
      useGBuffer ? "AO-Generate-BG-GB" : "AO-Generate-BG-Placeholder",
      this._generateLayout!,
      [
        { binding: 0, resource: depthView },
        { binding: 1, resource: this._randomView! },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: this._generateUniforms! } },
        { binding: 4, resource: normalView },
      ],
    );
    executePass(
      encoder,
      "AO-Generate",
      this._generatePipeline!,
      genBG,
      this._aoRawView!,
      timestampProvider,
    );

    // Pass 2: Horizontal blur on AO
    const blurHBG = this._bgCache.getOrCreate(
      this._device,
      "AO-BlurH-BG",
      this._blurLayout!,
      [
        { binding: 0, resource: this._aoRawView! },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: this._blurHUniforms! } },
      ],
    );
    executePass(
      encoder,
      "AO-BlurH",
      this._blurHPipeline!,
      blurHBG,
      this._aoBlurTempView!,
      timestampProvider,
    );

    // Pass 3: Vertical blur on AO
    const blurVBG = this._bgCache.getOrCreate(
      this._device,
      "AO-BlurV-BG",
      this._blurLayout!,
      [
        { binding: 0, resource: this._aoBlurTempView! },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: this._blurVUniforms! } },
      ],
    );
    executePass(
      encoder,
      "AO-BlurV",
      this._blurVPipeline!,
      blurVBG,
      this._aoBlurredView!,
      timestampProvider,
    );

    // Pass 4: Modulate scene color with blurred AO
    const modBG = this._bgCache.getOrCreate(
      this._device,
      "AO-Modulate-BG",
      this._modulateLayout!,
      [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: this._aoBlurredView! },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: this._modulateUniforms! } },
      ],
    );
    executePass(
      encoder,
      "AO-Modulate",
      this._modulatePipeline!,
      modBG,
      this._outputView!,
      timestampProvider,
    );

    return this._outputView!;
  }

  /**
   * Executes the SSILVB screen-space GI chain.
   *
   * The generation pass reads depth, noise, and scene color and writes
   * `(gi.rgb, ao)` to an `rgba16float` target. Horizontal and vertical
   * bilateral passes denoise it against depth, then the composite writes
   * `scene * ao + gi` to the configured output format.
   */
  private _executeSSGI(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView,
    sampler: GPUSampler,
    timestampProvider?: WebGPUPassTimestampProvider,
  ): GPUTextureView {
    const device = this._device!;

    // Pass 1 — generate. Binding 4 = scene-color source (the ping-pong input).
    const genBG = this._bgCache.getOrCreate(
      device,
      "SSGI-Generate-BG",
      this._generateLayout!,
      [
        { binding: 0, resource: depthView },
        { binding: 1, resource: this._randomView! },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: this._generateUniforms! } },
        { binding: 4, resource: sourceView },
      ],
    );
    executePass(
      encoder,
      "SSGI-Generate",
      this._generatePipeline!,
      genBG,
      this._aoRawView!,
      timestampProvider,
    );

    // Pass 2 — bilateral horizontal.
    const blurHBG = this._bgCache.getOrCreate(
      device,
      "SSGI-BlurH-BG",
      this._ssgiBlurLayout!,
      [
        { binding: 0, resource: this._aoRawView! },
        { binding: 1, resource: depthView },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: this._blurHUniforms! } },
      ],
    );
    executePass(
      encoder,
      "SSGI-BlurH",
      this._blurHPipeline!,
      blurHBG,
      this._aoBlurTempView!,
      timestampProvider,
    );

    // Pass 3 — bilateral vertical.
    const blurVBG = this._bgCache.getOrCreate(
      device,
      "SSGI-BlurV-BG",
      this._ssgiBlurLayout!,
      [
        { binding: 0, resource: this._aoBlurTempView! },
        { binding: 1, resource: depthView },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: this._blurVUniforms! } },
      ],
    );
    executePass(
      encoder,
      "SSGI-BlurV",
      this._blurVPipeline!,
      blurVBG,
      this._aoBlurredView!,
      timestampProvider,
    );

    // Pass 4 — additive composite.
    const compBG = this._bgCache.getOrCreate(
      device,
      "SSGI-Composite-BG",
      this._modulateLayout!,
      [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: this._aoBlurredView! },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: this._modulateUniforms! } },
      ],
    );
    executePass(
      encoder,
      "SSGI-Composite",
      this._modulatePipeline!,
      compBG,
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
    // SSGI stores HDR indirect radiance in `.rgb` and AO visibility in `.a`, so
    // its generation and blur targets use `rgba16float` independently of the
    // chain format. The final composite writes `format`; HBAO and GTAO keep
    // single-channel data in chain-format targets.
    const interFormat: GPUTextureFormat = this._isSSGI ? "rgba16float" : format;
    this._aoRawTex = createTexture(device, "AO-Raw", w, h, interFormat);
    this._aoRawView = this._aoRawTex.createView();
    this._aoBlurTempTex = createTexture(
      device,
      "AO-BlurTemp",
      w,
      h,
      interFormat,
    );
    this._aoBlurTempView = this._aoBlurTempTex.createView();
    this._aoBlurredTex = createTexture(device, "AO-Blurred", w, h, interFormat);
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

  /**
   * A 1×1 placeholder texture for the G-buffer normal binding when the
   * producer is off. Its format matches the producer's `rgba16float`, so the
   * bind-group layout stays compatible whether the real G-buffer view or this
   * placeholder is bound. Cleared to zero, so the WGSL sentinel check —
   * `lenSq > 0.01` means a real normal — treats it correctly should anything
   * ever sample through it.
   */
  private _createGBufferPlaceholder(device: GPUDevice): void {
    this._gBufferPlaceholderTex = device.createTexture({
      label: "AO-GBufferPlaceholder",
      size: { width: 1, height: 1 },
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Write a zeroed RGBA16F texel (8 bytes — 4 channels × 2 bytes
    // each). Float16 zero is the 16-bit pattern 0x0000.
    device.queue.writeTexture(
      { texture: this._gBufferPlaceholderTex },
      new Uint8Array(8),
      { bytesPerRow: 8 },
      { width: 1, height: 1 },
    );
    this._gBufferPlaceholderView = this._gBufferPlaceholderTex.createView();
  }

  private _createPipelines(device: GPUDevice, format: GPUTextureFormat): void {
    // SSAO generate layout: depth texture, random texture, sampler, uniforms,
    // and the G-buffer normal texture. The screen-space global-illumination
    // path reuses the same layout shape — binding 4 is the G-buffer normal
    // for HBAO and GTAO, and the scene-colour source for SSGI.
    this._generateLayout = makeBindGroupLayout(device, "AO-Generate-BGL", [
      texture(0, Stage.FRAGMENT),
      texture(1, Stage.FRAGMENT),
      sampler(2, Stage.FRAGMENT),
      uniformBuffer(3, Stage.FRAGMENT),
      texture(4, Stage.FRAGMENT),
    ]);

    // Blur layout: single texture + sampler + uniforms
    this._blurLayout = makeBindGroupLayout(device, "AO-Blur-BGL", [
      texture(0, Stage.FRAGMENT),
      sampler(1, Stage.FRAGMENT),
      uniformBuffer(2, Stage.FRAGMENT),
    ]);

    // Modulate layout: scene + AO + sampler + uniforms (also the SSGI composite)
    this._modulateLayout = makeBindGroupLayout(device, "AO-Modulate-BGL", [
      texture(0, Stage.FRAGMENT),
      texture(1, Stage.FRAGMENT),
      sampler(2, Stage.FRAGMENT),
      uniformBuffer(3, Stage.FRAGMENT),
    ]);

    // The SSGI pipeline uses `rgba16float` generation, a separate depth-aware
    // blur layout, and an additive composite. HBAO and GTAO build the pipeline
    // variants below.
    if (this._isSSGI) {
      const interFormat: GPUTextureFormat = "rgba16float";
      // Bilateral blur layout: giao(0) + depth(1) + sampler(2) + uniforms(3).
      this._ssgiBlurLayout = makeBindGroupLayout(device, "SSGI-Blur-BGL", [
        texture(0, Stage.FRAGMENT),
        texture(1, Stage.FRAGMENT),
        sampler(2, Stage.FRAGMENT),
        uniformBuffer(3, Stage.FRAGMENT),
      ]);
      this._generatePipeline = createFullscreenPipeline(
        device,
        "SSGI-Generate",
        SSGIGenerateWGSL,
        interFormat,
        this._generateLayout,
      );
      this._blurHPipeline = createFullscreenPipeline(
        device,
        "SSGI-BlurH",
        BilateralBlur1DWGSL,
        interFormat,
        this._ssgiBlurLayout,
      );
      this._blurVPipeline = createFullscreenPipeline(
        device,
        "SSGI-BlurV",
        BilateralBlur1DWGSL,
        interFormat,
        this._ssgiBlurLayout,
      );
      this._modulatePipeline = createFullscreenPipeline(
        device,
        "SSGI-Composite",
        SSGICompositeWGSL,
        format,
        this._modulateLayout,
      );
      return;
    }

    // Select generation shader by algorithm. Both variants share the
    // same bind group layout + output format, so swapping the shader is
    // all it takes — no plumbing changes downstream.
    const f16 = this.useShaderF16;
    // GTAO stays f32 (no f16 variant); the HBAO generate has a
    // conservative f16 variant (geometry stays f32, only the AO scalar
    // narrows).
    const generateShader =
      this._config.algorithm === "gtao"
        ? GTAOGenerateWGSL
        : f16
          ? AmbientOcclusionGenerateF16WGSL
          : AmbientOcclusionGenerateWGSL;
    const blurSrc = f16 ? GaussianBlur1DF16WGSL : GaussianBlur1DWGSL;
    const modulateSrc = f16
      ? AmbientOcclusionModulateF16WGSL
      : AmbientOcclusionModulateWGSL;
    this._generatePipeline = createFullscreenPipeline(
      device,
      `AO-Generate-${this._config.algorithm}`,
      generateShader,
      format,
      this._generateLayout,
    );
    this._blurHPipeline = createFullscreenPipeline(
      device,
      "AO-BlurH",
      blurSrc,
      format,
      this._blurLayout,
    );
    this._blurVPipeline = createFullscreenPipeline(
      device,
      "AO-BlurV",
      blurSrc,
      format,
      this._blurLayout,
    );
    this._modulatePipeline = createFullscreenPipeline(
      device,
      "AO-Modulate",
      modulateSrc,
      format,
      this._modulateLayout,
    );
  }

  /**
   * Push the live per-frame camera frustum near and far, plus the `logActive`
   * flag, into the generate uniform buffer. Baking a placeholder `0.1 / 10000`
   * near/far at init instead makes the depth linearization the SSAO march
   * performs correct only for scenes whose real frustum happens to match that
   * bracket. This writes the three scalars in place each frame, as
   * `frustum.xyz` = near, far, logActive, at the `frustum` vec4 offset of 32
   * bytes, leaving `frustum.w` — the `useGBufferNormal` flag written by
   * {@link _writeGenerateUniforms} — untouched.
   *
   * `logActive` is 1.0 when renderer-wide log depth is active this frame. The
   * AmbientOcclusionGenerate and GTAOGenerate fragment stages read `frustum.z`
   * and reverse the log-depth sample before linearizing, matching WebGL's
   * `czm_readDepth` into `czm_reverseLogDepth`; a zero leaves the linear path
   * untouched. AO is opt-in and off by default, so this setter is only
   * reached when the effect is enabled.
   */
  setFrustum(near: number, far: number, logActive: boolean): void {
    this._near = near;
    this._far = far;
    this._logActive = logActive ? 1.0 : 0.0;
    if (!this._device || !this._generateUniforms) return;
    const data = new Float32Array([near, far, this._logActive]);
    // frustum vec4 begins at byte offset 32 (params0 vec4 → 0, params1 vec4
    // → 16, frustum vec4 → 32). frustum.x=near, .y=far, .z=logActive.
    // Shared offset for both the hbao/gtao generate UB and the ssgi generate UB.
    this._device.queue.writeBuffer(
      this._generateUniforms,
      32,
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );

    // SSGI's bilateral blur also linearizes depth, so it receives the same
    // frustum data. Advance the 24-frame temporal slice rotation in `params3.z`.
    if (this._isSSGI) {
      if (this._blurHUniforms) {
        this._device.queue.writeBuffer(
          this._blurHUniforms,
          32,
          data.buffer,
          data.byteOffset,
          data.byteLength,
        );
      }
      if (this._blurVUniforms) {
        this._device.queue.writeBuffer(
          this._blurVUniforms,
          32,
          data.buffer,
          data.byteOffset,
          data.byteLength,
        );
      }
      this._frameCounter = (this._frameCounter + 1) % 24;
      const frameData = new Float32Array([this._frameCounter]);
      // params3 is the 5th vec4 → byte offset 64; .z (frameIndex) → offset 72.
      this._device.queue.writeBuffer(
        this._generateUniforms,
        72,
        frameData.buffer,
        frameData.byteOffset,
        frameData.byteLength,
      );
    }
  }

  /**
   * Writes the CPU-computed altitude fade to SSGI `params0.z` at byte offset 8.
   *
   * HBAO and GTAO use that lane for `lengthCap`, so this is a no-op unless SSGI
   * is selected.
   */
  setAltitudeFade(fade: number): void {
    this._altitudeFade = Math.max(0.0, Math.min(1.0, fade));
    if (!this._isSSGI || !this._device || !this._generateUniforms) return;
    const data = new Float32Array([this._altitudeFade]);
    this._device.queue.writeBuffer(
      this._generateUniforms,
      8,
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
  }

  /**
   * Writes the `useGBufferNormal` flag to `frustum.w` at byte offset 44 without
   * disturbing the near, far, and log-depth values in `frustum.xyz`.
   */
  private _writeGenerateUniforms(useGBuffer: boolean): void {
    if (!this._device || !this._generateUniforms) return;
    const flag = new Float32Array([useGBuffer ? 1.0 : 0.0]);
    // Offset of `frustum.w` within the uniform struct:
    //   params0 (vec4)  → 0
    //   params1 (vec4)  → 16
    //   frustum (vec4)  → 32, .w is at offset 44
    this._device.queue.writeBuffer(
      this._generateUniforms,
      44,
      flag.buffer,
      flag.byteOffset,
      flag.byteLength,
    );
  }

  private _createUniforms(device: GPUDevice): void {
    const cfg = this._config;
    const w = this._width;
    const h = this._height;

    // SSGI uses five vec4s for generation, three for blur, and one for
    // composite. The packing is independent of HBAO and GTAO.
    if (this._isSSGI) {
      // generate: params0(aoIntensity,bias,-,stepCount) | params1(sliceCount,
      // 1/w,1/h,randomTexSize) | frustum(near,far,logActive,-) |
      // params2(giIntensity,lumClamp,thicknessMin,thicknessK) |
      // params3(radiusPixels,maxWorldRadius,frameIndex,expFactor)
      this._generateUniforms = createUniformBuffer(
        device,
        "SSGI-Generate-UB",
        new Float32Array([
          cfg.intensity,
          cfg.bias,
          this._altitudeFade,
          cfg.ssgiStepCount,
          cfg.sliceCount,
          1.0 / w,
          1.0 / h,
          4.0,
          this._near,
          this._far,
          this._logActive,
          0.0,
          cfg.giIntensity,
          cfg.luminanceClamp,
          cfg.thicknessMin,
          cfg.thicknessK,
          cfg.radiusPixels,
          cfg.maxWorldRadius,
          this._frameCounter,
          cfg.expFactor,
        ]),
      );
      // blur: params(dirX,dirY,sigma,taps) | texel(1/w,1/h,depthTol,-) |
      // frustum(near,far,logActive,-)
      const depthTol = 0.01; // One-percent relative eye-depth tolerance.
      this._blurHUniforms = createUniformBuffer(
        device,
        "SSGI-BlurH-UB",
        new Float32Array([
          1.0,
          0.0,
          cfg.blurSigma,
          2.0,
          1.0 / w,
          1.0 / h,
          depthTol,
          0.0,
          this._near,
          this._far,
          this._logActive,
          0.0,
        ]),
      );
      this._blurVUniforms = createUniformBuffer(
        device,
        "SSGI-BlurV-UB",
        new Float32Array([
          0.0,
          1.0,
          cfg.blurSigma,
          2.0,
          1.0 / w,
          1.0 / h,
          depthTol,
          0.0,
          this._near,
          this._far,
          this._logActive,
          0.0,
        ]),
      );
      // composite: params(debugMode,aoWeight,-,-)
      this._modulateUniforms = createUniformBuffer(
        device,
        "SSGI-Composite-UB",
        new Float32Array([cfg.ssgiDebugMode, cfg.aoWeight, 0.0, 0.0]),
      );
      return;
    }

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
    this._gBufferPlaceholderTex?.destroy();
    this._aoRawTex = null;
    this._aoBlurTempTex = null;
    this._aoBlurredTex = null;
    this._outputTex = null;
    this._randomTex = null;
    this._gBufferPlaceholderTex = null;
    this._gBufferPlaceholderView = null;
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
