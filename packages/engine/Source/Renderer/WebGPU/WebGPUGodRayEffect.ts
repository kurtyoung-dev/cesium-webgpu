/// <reference types="@webgpu/types" />
/**
 * WebGPU GodRayEffect
 *
 * Per-effect slice extracted from `WebGPUPostProcessEffects`
 * (Batch 160 of the maintainability sweep).
 *
 * @module WebGPUGodRayEffect
 */

import GodRayCompositeWGSL from "../../Shaders/WebGPU/PostProcess/GodRayComposite.js";
import GodRayGenerateWGSL from "../../Shaders/WebGPU/PostProcess/GodRayGenerate.js";
// PARITY-F16-POSTPROCESS — f16 variants, selected when `useShaderF16`.
import GodRayCompositeF16WGSL from "../../Shaders/WebGPU/PostProcess/GodRayComposite_f16.js";
import GodRayGenerateF16WGSL from "../../Shaders/WebGPU/PostProcess/GodRayGenerate_f16.js";
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

export interface GodRayConfig {
  /**
   * Sun position in normalized screen UV space (0..1, y DOWN). The caller
   * updates this per frame via `setSunScreenUV(u, v)` — project the world-
   * space sun position through the current `viewProjection` matrix and
   * convert NDC → UV. Values outside [0,1] are allowed for off-screen suns.
   */
  sunScreenU?: number;
  sunScreenV?: number;
  /** Step-size multiplier along the pixel→sun ray. Default 0.96. */
  density?: number;
  /** Per-sample decay factor (0..1). Default 0.95. */
  decay?: number;
  /** Per-sample brightness weight. Default 0.5. */
  weight?: number;
  /** Final output gain. Default 0.15. Tune with the sun disk's HDR level. */
  exposure?: number;
  /** Number of radial samples toward the sun (1..128). Default 64. */
  sampleCount?: number;
  /**
   * Depth fraction above which a sample is considered "sky" and its color
   * leaks through to the ray. Default 0.99 — sample depths > far*0.99
   * contribute; anything closer occludes.
   */
  occlusionFarCutoff?: number;
}

/**
 * Screen-space "god rays" (volumetric light scattering post-process).
 *
 * Two-pass:
 *   1. `GodRayGenerate` radial-blurs the scene color toward a caller-
 *      provided sun screen UV, gated by scene depth (only "sky" samples
 *      contribute so geometry cleanly blocks the shaft).
 *   2. `GodRayComposite` additively blends the ray buffer onto the
 *      original scene color and returns the composited view.
 *
 * Insert after the opaque scene pass but before bloom if you want the
 * shaft to bloom; after bloom if you want crisp rays.
 *
 * @example
 *   const godrays = new GodRayEffect({ exposure: 0.2 });
 *   // each frame, after projecting sunPositionWC through viewProjection:
 *   godrays.setSunScreenUV(uvX, uvY);
 *   pipeline.addEffect(godrays);
 */
export class GodRayEffect implements PostProcessEffect {
  readonly name = "GodRay";
  enabled = true;

  // PARITY-F16-POSTPROCESS — set by the pipeline before initialize().
  // Default false = byte-identical f32 path.
  useShaderF16 = false;

  private _device: GPUDevice | null = null;
  private _width = 0;
  private _height = 0;
  private _format: GPUTextureFormat = "bgra8unorm";

  // Intermediate textures — half-res for the generate pass (cheap radial
  // blur) then full-res for the composite that writes the final result.
  private _rayTex: GPUTexture | null = null;
  private _rayView: GPUTextureView | null = null;
  private _outputTex: GPUTexture | null = null;
  private _outputView: GPUTextureView | null = null;

  private _generatePipeline: GPURenderPipeline | null = null;
  private _compositePipeline: GPURenderPipeline | null = null;
  private _generateLayout: GPUBindGroupLayout | null = null;
  private _compositeLayout: GPUBindGroupLayout | null = null;

  private _generateUniforms: GPUBuffer | null = null;

  // TAKRAM-9 (cloud-aware god rays) — screen-space cloud TRANSMITTANCE.
  // `_cloudTransView` is pushed each frame by the pipeline when both
  // procedural clouds and cloud-aware god rays are enabled; otherwise the
  // generate pass binds `_whiteFallbackView` (1×1 r8unorm = 1.0), which
  // makes the cloud multiply a byte-identical no-op (default OFF).
  private _cloudTransView: GPUTextureView | null = null;
  private _whiteFallbackTex: GPUTexture | null = null;
  private _whiteFallbackView: GPUTextureView | null = null;

  // C-R11 (Batch 32) — bind group cache for the two per-frame sites.
  private _bgCache = new WebGPUBindGroupCache();

  // C4-LOGDEPTH-PP-FRUSTUM-SLICEA — renderer-wide log-depth flag threaded
  // per-frame alongside near/far. Slice-B scaffolding: GodRayGenerate does not
  // yet reverse log depth, so `frustum.z` is inert until that lands.
  private _logActive = 0.0;

  private _config: Required<GodRayConfig>;

  constructor(config: GodRayConfig = {}) {
    this._config = {
      sunScreenU: config.sunScreenU ?? 0.5,
      sunScreenV: config.sunScreenV ?? 0.3,
      density: config.density ?? 0.96,
      decay: config.decay ?? 0.95,
      weight: config.weight ?? 0.5,
      exposure: config.exposure ?? 0.15,
      sampleCount: config.sampleCount ?? 64,
      occlusionFarCutoff: config.occlusionFarCutoff ?? 0.99,
    };
  }

  /**
   * Update the sun's screen-space UV. Call each frame before the effect
   * executes — cheap (one GPU buffer write). When the sun is off-screen,
   * pass the UV even if outside [0,1]; the shader still produces a
   * directional glow across the visible region.
   */
  setSunScreenUV(u: number, v: number): void {
    this._config.sunScreenU = u;
    this._config.sunScreenV = v;
    if (this._device && this._generateUniforms) {
      const data = this._buildUniformData();
      this._device.queue.writeBuffer(this._generateUniforms, 0, data);
    }
  }

  /**
   * TAKRAM-9 — push the per-frame screen-space cloud transmittance view
   * (1 = clear, 0 = opaque cloud) produced by the procedural cloud
   * renderer's mask pass. Pass `null` to fall back to the white 1×1
   * texture (byte-identical depth-only path). Cheap — just swaps the view
   * bound at generate-binding 4; the bind-group cache re-keys on identity.
   */
  setCloudTransmittanceView(view: GPUTextureView | null): void {
    this._cloudTransView = view;
  }

  /** Whether cloud-aware attenuation is currently active (a view is set). */
  get cloudAware(): boolean {
    return this._cloudTransView !== null;
  }

  /**
   * Update frustum near/far so depth linearization stays correct. C4-LOGDEPTH-
   * PP-FRUSTUM-SLICEA adds the optional `logActive` flag (packed into
   * `frustum.z`); when omitted the previous value is retained so existing
   * callers stay byte-identical.
   */
  setFrustum(near: number, far: number, logActive?: boolean): void {
    if (typeof logActive === "boolean") {
      this._logActive = logActive ? 1.0 : 0.0;
    }
    if (!this._device || !this._generateUniforms) return;
    const data = this._buildUniformData(near, far);
    this._device.queue.writeBuffer(this._generateUniforms, 0, data);
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

    // Half-res ray buffer for perf — radial blur at full-res is needlessly
    // expensive and the artefacts are invisible after the composite blur.
    const hw = Math.max(1, Math.floor(width / 2));
    const hh = Math.max(1, Math.floor(height / 2));

    this._rayTex = createTexture(device, "GodRay-Ray", hw, hh, format);
    this._rayView = this._rayTex.createView();
    this._outputTex = createTexture(
      device,
      "GodRay-Output",
      width,
      height,
      format,
    );
    this._outputView = this._outputTex.createView();

    this._generateLayout = makeBindGroupLayout(device, "GodRay-Gen-BGL", [
      texture(0, Stage.FRAGMENT),
      texture(1, Stage.FRAGMENT),
      sampler(2, Stage.FRAGMENT),
      uniformBuffer(3, Stage.FRAGMENT),
      // TAKRAM-9 — cloud transmittance (bound to the white fallback when
      // cloud-aware god rays are off → byte-identical multiply by 1.0).
      texture(4, Stage.FRAGMENT),
    ]);

    // TAKRAM-9 — 1×1 white (r8unorm 255 → exactly 1.0) transmittance fallback.
    if (!this._whiteFallbackTex) {
      this._whiteFallbackTex = device.createTexture({
        label: "GodRay-CloudTrans-WhiteFallback",
        size: [1, 1, 1],
        format: "r8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture: this._whiteFallbackTex },
        new Uint8Array([255]),
        { bytesPerRow: 1, rowsPerImage: 1 },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      );
      this._whiteFallbackView = this._whiteFallbackTex.createView();
    }
    this._compositeLayout = makeBindGroupLayout(
      device,
      "GodRay-Composite-BGL",
      [
        texture(0, Stage.FRAGMENT),
        texture(1, Stage.FRAGMENT),
        sampler(2, Stage.FRAGMENT),
      ],
    );

    const f16 = this.useShaderF16;
    const generateSrc = f16 ? GodRayGenerateF16WGSL : GodRayGenerateWGSL;
    const compositeSrc = f16 ? GodRayCompositeF16WGSL : GodRayCompositeWGSL;
    this._generatePipeline = createFullscreenPipeline(
      device,
      "GodRay-Generate",
      generateSrc,
      format,
      this._generateLayout,
    );
    this._compositePipeline = createFullscreenPipeline(
      device,
      "GodRay-Composite",
      compositeSrc,
      format,
      this._compositeLayout,
    );

    this._generateUniforms = createUniformBuffer(
      device,
      "GodRay-GenUniforms",
      this._buildUniformData(),
    );
  }

  resize(width: number, height: number): void {
    if (!this._device || (width === this._width && height === this._height))
      return;
    this._rayTex?.destroy();
    this._outputTex?.destroy();
    this._rayTex = null;
    this._outputTex = null;
    this._rayView = null;
    this._outputView = null;
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
    if (!this._device || !depthView) {
      // No depth texture → can't gate the rays, fall back to passthrough.
      return sourceView;
    }

    // C-R11 (Batch 32) — both bind groups cached.

    // Pass 1: generate rays at half-res into _rayView.
    const genBG = this._bgCache.getOrCreate(
      this._device,
      "GodRay-Generate-BG",
      this._generateLayout!,
      [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: depthView },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: this._generateUniforms! } },
        // TAKRAM-9 — real cloud transmittance when set, else white fallback.
        {
          binding: 4,
          resource: this._cloudTransView ?? this._whiteFallbackView!,
        },
      ],
    );
    executePass(
      encoder,
      "GodRay-Generate",
      this._generatePipeline!,
      genBG,
      this._rayView!,
    );

    // Pass 2: additive composite scene + rays → full-res output.
    const compBG = this._bgCache.getOrCreate(
      this._device,
      "GodRay-Composite-BG",
      this._compositeLayout!,
      [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: this._rayView! },
        { binding: 2, resource: sampler },
      ],
    );
    executePass(
      encoder,
      "GodRay-Composite",
      this._compositePipeline!,
      compBG,
      this._outputView!,
    );

    return this._outputView!;
  }

  destroy(): void {
    this._rayTex?.destroy();
    this._outputTex?.destroy();
    this._generateUniforms?.destroy();
    this._whiteFallbackTex?.destroy();
    this._rayTex = null;
    this._outputTex = null;
    this._rayView = null;
    this._outputView = null;
    this._whiteFallbackTex = null;
    this._whiteFallbackView = null;
    this._cloudTransView = null;
    this._device = null;
  }

  /**
   * Pack uniforms matching the GodRayGenerate.wgsl `GodRayUniforms` layout.
   * Caller may supply a fresh near/far pair when the camera frustum
   * changes; otherwise a sentinel default (1, 1e8) is used — the
   * frustum values only affect depth-linearization precision, so a
   * wide-open default is safe until `setFrustum()` is called.
   */
  private _buildUniformData(near?: number, far?: number): Float32Array {
    // Must match the `GodRayUniforms` struct in GodRayGenerate.wgsl —
    // three vec4s (12 floats / 48 bytes). No trailing pad needed; WebGPU
    // pads the uniform buffer binding up to 256 bytes internally.
    return new Float32Array([
      // params0: sunUV.xy, density, decay
      this._config.sunScreenU,
      this._config.sunScreenV,
      this._config.density,
      this._config.decay,
      // params1: weight, exposure, sampleCount, occlusionFarCutoff
      this._config.weight,
      this._config.exposure,
      this._config.sampleCount,
      this._config.occlusionFarCutoff,
      // frustum: near, far, logActive (Slice-A scaffolding), _
      near ?? 1.0,
      far ?? 1e8,
      this._logActive,
      0.0,
    ]);
  }
}
