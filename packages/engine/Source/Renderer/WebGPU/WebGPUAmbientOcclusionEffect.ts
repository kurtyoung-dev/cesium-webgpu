/// <reference types="@webgpu/types" />
/**
 * WebGPU AmbientOcclusionEffect
 *
 * Per-effect slice extracted from `WebGPUPostProcessEffects`
 * (Batch 160 of the maintainability sweep).
 *
 * @module WebGPUAmbientOcclusionEffect
 */

import AmbientOcclusionGenerateWGSL from "../../Shaders/WebGPU/PostProcess/AmbientOcclusionGenerate.js";
import AmbientOcclusionModulateWGSL from "../../Shaders/WebGPU/PostProcess/AmbientOcclusionModulate.js";
import GTAOGenerateWGSL from "../../Shaders/WebGPU/PostProcess/GTAOGenerate.js";
import GaussianBlur1DWGSL from "../../Shaders/WebGPU/PostProcess/GaussianBlur1D.js";
// PARITY-F16-POSTPROCESS — f16 variants, selected when `useShaderF16`.
// Note: GTAO has no f16 variant (its horizon-search is precision-critical);
// the "gtao" algorithm keeps the f32 generate shader even when f16 is on.
import AmbientOcclusionGenerateF16WGSL from "../../Shaders/WebGPU/PostProcess/AmbientOcclusionGenerate_f16.js";
import AmbientOcclusionModulateF16WGSL from "../../Shaders/WebGPU/PostProcess/AmbientOcclusionModulate_f16.js";
import GaussianBlur1DF16WGSL from "../../Shaders/WebGPU/PostProcess/GaussianBlur1D_f16.js";
// C6-SSGI-DIFFUSE — screen-space diffuse global illumination (SSILVB visibility
// bitmask). Opt-in, default-off, WebGPU-only. Reachable only via the "ssgi"
// AOAlgorithm; the "hbao"/"gtao" paths never import these at runtime.
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
import {
  createFullscreenPipeline,
  createTexture,
  createUniformBuffer,
  executePass,
} from "./WebGPUPostProcessEffects.js";
import type { PostProcessEffect } from "./WebGPUPostProcessEffects.js";

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
 *   "ssgi" — Screen-Space Global Illumination (SSILVB visibility bitmask,
 *            Therrien et al. 2023). Fork-added Campaign-6 enhancement,
 *            WebGPU-only, opt-in. A structural superset of GTAO: one pass
 *            produces BOTH an improved AO term (thin-surface fix) and a
 *            diffuse indirect-bounce color that bleeds neighbouring surface
 *            color. Runs at rgba16float through a depth-aware bilateral blur
 *            and an additive composite. See SSGIGenerate.wgsl. Selecting this
 *            replaces the GTAO/HBAO generate+modulate chain; it is never
 *            reached unless explicitly requested, so the default paths stay
 *            byte-identical.
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

  // ── C6-SSGI-DIFFUSE — only consumed when algorithm === "ssgi" ──
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

  // PARITY-F16-POSTPROCESS — set by the pipeline before initialize().
  // Default false = byte-identical f32 path.
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

  // Phase 8a Slice 4 (Batch 87) — 1×1 placeholder texture for the
  // G-buffer normal binding when `scene.deferredLighting === false`.
  // Bound to keep the bind-group layout stable across the flag's two
  // states; the shader's `frustum.w` uniform selects between
  // depth-reconstruction (placeholder unused) and G-buffer sampling
  // (real view bound).
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

  // C-R11 (Batch 32) — bind group cache. 4 BGs per frame → ~0 after
  // frame 1. Invalidated on resize when texture views rotate.
  private _bgCache = new WebGPUBindGroupCache();

  // C4-LOGDEPTH-PP-FRUSTUM-SLICEA — last per-frame frustum near/far + log flag
  // pushed by setFrustum(). Seed with the historical placeholder bracket so the
  // pre-setFrustum first frame is unchanged; also serves as an observable
  // signal for the acceptance probe.
  private _near = 0.1;
  private _far = 10000.0;
  private _logActive = 0.0;

  // C6-SSGI-DIFFUSE — dedicated bilateral-blur layout (adds a depth binding
  // vs the algorithm-agnostic Gaussian blur layout) and a per-frame counter
  // driving the temporal slice rotation. Only allocated on the "ssgi" path.
  private _ssgiBlurLayout: GPUBindGroupLayout | null = null;
  private _frameCounter = 0;
  // C6-SSGI-DIFFUSE — CPU-computed altitude fade [0,1]. 1 near the ground,
  // 0 from orbit (guarantees the SSGI no-op independent of depth
  // reconstruction). Seeded 1.0 so the first enabled frame is not a no-op.
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
      // C6-SSGI-DIFFUSE defaults (RESEARCH_R-SSGI §9).
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
    // C-R11 (Batch 32) — texture views change on resize.
    this._bgCache.invalidateAll();
    this.initialize(this._device, width, height, this._format);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView | null,
    sampler: GPUSampler,
    // Phase 8a Slice 4 (Batch 87) — when non-null, the SSAO compute
    // path reads its surface normals from this G-buffer view instead of
    // reconstructing them from depth. Caller (the post-process
    // pipeline) wires the view through from
    // `view.gBufferFramebuffer.normalRoughnessTexture` only when
    // `scene.deferredLighting === true` AND the producer ran this
    // frame; otherwise pass null and the SSAO falls back to depth
    // reconstruction.
    gBufferNormalView?: GPUTextureView | null,
  ): GPUTextureView {
    if (!this._device || !depthView) return sourceView;

    // ── C6-SSGI-DIFFUSE — SSILVB path (generate radiance+AO → bilateral blur
    // H/V → additive composite). Kept separate from the hbao/gtao chain. ──
    if (this._isSSGI) {
      return this._executeSSGI(encoder, sourceView, depthView, sampler);
    }

    // Pick the normal source. When the caller provides a real
    // G-buffer view, the WGSL's `frustum.w` uniform flag is also set
    // to 1.0 (see _updateUniforms below); otherwise we bind the 1×1
    // placeholder and leave the flag at 0.0 so the shader takes the
    // depth-reconstruction path.
    const useGBuffer =
      gBufferNormalView !== undefined && gBufferNormalView !== null;
    const normalView = useGBuffer
      ? (gBufferNormalView as GPUTextureView)
      : this._gBufferPlaceholderView!;
    this._writeGenerateUniforms(useGBuffer);

    // C-R11 (Batch 32) — all four bind groups cached. Depth view is
    // stable within a frame; sourceView stability depends on whether
    // post-process stages upstream recreated the framebuffer (rare —
    // only on resize), so the cache steady-states at 4 entries.

    // Pass 1: Generate raw AO from depth. Bind-group cache key now
    // includes the normal source (placeholder vs real G-buffer) so we
    // get one BG per state. With the cache keyed on the binding-list
    // identity, swapping the view automatically invalidates.
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
    );

    return this._outputView!;
  }

  /**
   * C6-SSGI-DIFFUSE — execute the SSILVB screen-space GI chain.
   *
   * Pass 1 (generate): SSGIGenerate reads depth + random + the scene-color
   * source (binding 4) and writes rgba16float (GI.rgb, AO.a) into the raw
   * target. Pass 2/3 (bilateral H/V): depth-aware denoise. Pass 4 (composite):
   * additive `scene * ao + gi` into the `format` output.
   */
  private _executeSSGI(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView,
    sampler: GPUSampler,
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
    );

    return this._outputView!;
  }

  private _createTextures(
    device: GPUDevice,
    w: number,
    h: number,
    format: GPUTextureFormat,
  ): void {
    // C6-SSGI-DIFFUSE — the SSGI generate/blur targets carry HDR indirect
    // radiance in .rgb and AO visibility in .a, so they must be rgba16float
    // regardless of the (possibly 8-bit) chain format. The final composite
    // still writes `format` so the downstream chain is unchanged. The
    // hbao/gtao paths keep the historical single-channel-in-`format` targets.
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
   * Phase 8a Slice 4 (Batch 87) — 1×1 placeholder texture for the
   * G-buffer normal binding when the producer is off. Format matches
   * the producer's `rgba16float` so the bind-group layout stays
   * compatible whether the real G-buffer view or this placeholder is
   * bound. Cleared to zero so the WGSL sentinel check
   * (`lenSq > 0.01 → real normal`) treats it correctly if anything
   * ever samples through it accidentally.
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
    // SSAO Generate layout: depthTex + randomTex + sampler + uniforms
    //   + gBufferNormalTex (Phase 8a Slice 4, Batch 87).
    // C6-SSGI-DIFFUSE reuses the SAME layout shape — binding 4 (a texture) is
    // the G-buffer normal for hbao/gtao and the scene-color source for ssgi.
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

    // ── C6-SSGI-DIFFUSE — SSILVB path. Distinct pipelines: HDR rgba16float
    // generate + a depth-aware bilateral blur (its own layout with a depth
    // binding) + an additive composite. Kept fully separate from the
    // hbao/gtao pipelines below so those stay byte-identical. ──
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
   * Phase 8a Slice 4 (Batch 87) — write the `useGBufferNormal` flag
   * into the generate uniform buffer. The flag occupies the .w slot of
   * `frustum` (offset 11 floats × 4 bytes = 44 bytes). All other
   * uniform slots are baked once in `_createUniforms` and never change
   * after init — we only need to flip this one float per frame.
   *
   * Cheap: 4-byte queue.writeBuffer() per frame, dwarfed by the SSAO
   * compute pass itself.
   */
  /**
   * C4-LOGDEPTH-PP-FRUSTUM-SLICEA — push the live per-frame camera frustum
   * near/far plus the `logActive` flag into the generate UB. Previously the
   * generate UB baked a placeholder `0.1 / 10000` near/far at init, so the
   * depth-linearization the SSAO march performs was correct only for scenes
   * whose real frustum happened to match that bracket. This writes the three
   * scalars in place each frame (`frustum.xyz` = near, far, logActive) at the
   * `frustum` vec4 offset (32 bytes), leaving `frustum.w` (the useGBuffer flag
   * written by {@link _writeGenerateUniforms}) untouched.
   *
   * `logActive` is 1.0 when renderer-wide log depth is active this frame. Since
   * C4-LOGDEPTH-PP-SLICEB the AmbientOcclusionGenerate / GTAOGenerate FS reads
   * `frustum.z` and reverses the log-depth sample before linearizing (matching
   * WebGL czm_readDepth → czm_reverseLogDepth); logActive=0 is byte-identical.
   * Off-gate: AO is opt-in default-off, so this setter is only reached when the
   * effect is enabled.
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

    // ── C6-SSGI-DIFFUSE — also push the frustum into the two bilateral-blur
    // UBs (they linearize depth for edge-stopping) and advance the temporal
    // slice-rotation frame index in params3.z (generate UB, byte offset 72). ──
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
   * C6-SSGI-DIFFUSE — push the CPU-computed altitude fade [0,1] into the SSGI
   * generate UB (params0.z, byte offset 8). No-op for the hbao/gtao paths,
   * where params0.z is `lengthCap` and must not be overwritten. Called
   * per-frame from the post-process collection's frame-data update.
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

    // ── C6-SSGI-DIFFUSE — SSILVB uniform layout (5 vec4 generate, 3 vec4 blur,
    // 1 vec4 composite). Separate from the hbao/gtao packing below. ──
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
      const depthTol = 0.01; // 1% relative eye-depth tolerance (§5)
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
