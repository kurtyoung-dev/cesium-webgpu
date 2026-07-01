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
 */
export type AOAlgorithm = "hbao" | "gtao";

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
    //   + gBufferNormalTex (Phase 8a Slice 4, Batch 87)
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

    // Modulate layout: scene + AO + sampler + uniforms
    this._modulateLayout = makeBindGroupLayout(device, "AO-Modulate-BGL", [
      texture(0, Stage.FRAGMENT),
      texture(1, Stage.FRAGMENT),
      sampler(2, Stage.FRAGMENT),
      uniformBuffer(3, Stage.FRAGMENT),
    ]);

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
