/// <reference types="@webgpu/types" />
/**
 * WebGPU BloomEffect
 *
 * Per-effect slice extracted from `WebGPUPostProcessEffects`
 * (Batch 160 of the maintainability sweep).
 *
 * @module WebGPUBloomEffect
 */

import BloomCompositeWGSL from "../../Shaders/WebGPU/PostProcess/BloomComposite.js";
import BrightPassWGSL from "../../Shaders/WebGPU/PostProcess/BrightPass.js";
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

export interface BloomConfig {
  // NEW-BLOOM-UNIFORM-PARITY (Batch 240) — the bright pass is a port of
  // WebGL's ContrastBias.glsl (HSB brightness shift + contrast curve),
  // NOT a luminance threshold. These six fields mirror the six uniforms
  // of `scene.postProcessStages.bloom.uniforms` 1:1 (defaults from
  // PostProcessStageLibrary.createBloomStage / createBlur).
  contrast?: number; // Bright-pass contrast curve, (-255, 259) (default 128)
  brightness?: number; // Bright-pass HSB value offset (default -0.3)
  delta?: number; // Blur incremental-Gaussian delta (default 1.0)
  sigma?: number; // Blur Gaussian sigma (default 2.0)
  stepSize?: number; // Blur sample step in texels (default 1.0)
  glowOnly?: boolean; // Show only the glow (WebGL parity uniform)
  // Fork extra (not a WebGL uniform): composite multiplier on the glow.
  // WebGL's composite is plain `bloom + color`, so 1.0 is parity; the
  // scalar exists as the altitude gate's per-frame lever (below).
  intensity?: number; // Bloom glow intensity (default 1.0)
  // Session 65 Batch 22 — altitude-gated bloom (orbit polish §13.1).
  // When `enableAltitudeGate` is true (default), per-frame bloom
  // intensity is multiplied by an altitude factor that fades from
  // 1.0 at sea level to 0.0 above `altitudeGateMaxMeters`. Mirrors
  // industry convention (Frostbite GDC 2016, Karis 2013) of treating
  // bloom as a CAMERA LENS effect — absent in vacuum-of-space cameras.
  // Real orbital photography (ISS, Earthrise) shows essentially zero
  // bloom on the Earth disk; matching that requires fading the effect
  // as the camera leaves ground altitude. Set to false to disable
  // altitude gating (matches pre-Batch-22 behavior).
  enableAltitudeGate?: boolean;
  // Altitude curve: bloom fully active below this height (meters),
  // gated to `altitudeGateOrbitFloor × baseIntensity` above
  // `altitudeGateMaxMeters`. Smoothstep between.
  // Defaults chosen so high-altitude aerial photogrammetry views
  // (Aerometrex SF at ~500m, NYC at ~10km) keep full bloom; orbit
  // views (>1 Earth radius) get a subtle 15% floor — real orbital
  // photography from ISS/Apollo shows a faint atmospheric halo
  // (Rayleigh forward-scatter through the limb) that reads
  // perceptually as a soft bloom. Going to 0 produces a too-sharp
  // disk edge; the floor restores the subtle haze without the fake
  // ground-level halo of pre-Batch-22 behavior.
  altitudeGateMinMeters?: number;
  altitudeGateMaxMeters?: number;
  // Floor multiplier at fully-gated altitude. 0.0 = pre-Batch-22-tuning
  // fully off; 1.0 = no gate (matches `enableAltitudeGate: false`).
  // Default 0.15 = 15% of base intensity at orbit, giving a subtle
  // residual halo that mirrors real-camera limb scattering.
  altitudeGateOrbitFloor?: number;

  // ─────────────────────────────────────────────────────────────────
  // FUTURE WORK — per-layer reflective bloom (orbit polish §13.x)
  // ─────────────────────────────────────────────────────────────────
  // The bloom bright-pass currently runs a SINGLE contrast/brightness
  // curve over the composite scene color. Real-world bloom is camera-lens
  // light bleed proportional to per-surface RADIANCE, which varies
  // sharply by material type:
  //   - Ocean: high specular at sun-glint angles, low diffuse →
  //     bright tight glint that SHOULD bloom even at orbit.
  //   - Clouds: high diffuse reflectance (albedo ~0.7-0.9) → soft
  //     wide bloom across the cloud band.
  //   - Land terrain: mid diffuse reflectance (~0.15-0.35) → subtle
  //     bloom only on direct sun-facing slopes.
  //   - Snow / ice: very high diffuse (~0.85) → strong bloom.
  //   - Atmosphere haze (Rayleigh): wavelength-dependent → blue
  //     channel blooms more than red (matches dusk sky reads).
  //
  // Implementing this requires the model + globe fragment shaders to
  // export a separate "bloom contribution" channel (similar to how
  // they already export velocity for TAA), feeding a multi-channel
  // bright-pass that integrates contribution-weighted luminance per
  // material type. The infrastructure for additional FS output
  // channels exists (velocity texture) but per-material bloom-weight
  // tables would be a new design.
  //
  // Tracked in `migration_doc/DEFERRED_WORK.md::
  // NEW-ORBIT-PER-LAYER-REFLECTIVE-BLOOM` for the next celestial /
  // atmosphere sprint.
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

  // C-R11 (Batch 31) — bind group cache. Bloom's four per-frame
  // createBindGroup sites burn ~240 bind groups / sec at 60 Hz; the
  // cache replays the same bind group when sourceView / samplers /
  // intermediate views haven't changed. Invalidated on resize because
  // texture views become stale.
  private _bgCache = new WebGPUBindGroupCache();

  private _config: Required<BloomConfig>;

  // Session 65 Batch 22 — base intensity captured at config time so
  // the altitude gate multiplies AGAINST it each frame rather than
  // permanently mutating `_config.intensity` (which would lose the
  // user's authored value on subsequent gate updates).
  private _baseIntensity: number = 1.0;
  // Last value written to the composite UBO. Avoids re-writing the
  // buffer when the gated intensity hasn't changed (e.g., camera
  // hasn't moved).
  private _lastGatedIntensity: number = -1.0;

  constructor(config: BloomConfig = {}) {
    this._config = {
      contrast: config.contrast ?? 128.0,
      brightness: config.brightness ?? -0.3,
      delta: config.delta ?? 1.0,
      sigma: config.sigma ?? 2.0,
      stepSize: config.stepSize ?? 1.0,
      intensity: config.intensity ?? 1.0,
      glowOnly: config.glowOnly ?? false,
      enableAltitudeGate: config.enableAltitudeGate ?? true,
      altitudeGateMinMeters: config.altitudeGateMinMeters ?? 100_000.0,
      altitudeGateMaxMeters: config.altitudeGateMaxMeters ?? 6_378_137.0,
      altitudeGateOrbitFloor: config.altitudeGateOrbitFloor ?? 0.15,
    };
    this._baseIntensity = this._config.intensity;
  }

  /**
   * Session 65 Batch 22 — apply the altitude-gated intensity update.
   * Called per-frame by the SceneRenderer with the current camera
   * altitude in meters. Multiplies the base intensity by a smoothstep
   * curve from 1.0 at `altitudeGateMinMeters` (or below) to 0.0 at
   * `altitudeGateMaxMeters` (or above). Pre-Batch-22 behavior is
   * preserved when `enableAltitudeGate` is false — the base intensity
   * is used unchanged.
   *
   * @param cameraHeightMeters Camera altitude above the WGS84
   *   ellipsoid in meters (`frameState.camera.positionCartographic.height`).
   */
  applyAltitudeGate(cameraHeightMeters: number): void {
    if (!this._device || !this._compositeUniforms) return;
    let gated = this._baseIntensity;
    if (this._config.enableAltitudeGate) {
      const min = this._config.altitudeGateMinMeters;
      const max = this._config.altitudeGateMaxMeters;
      const floor = this._config.altitudeGateOrbitFloor;
      // smoothstep(min, max, h) blends from 0 (ground bloom) to 1
      // (orbit bloom). Final multiplier blends from 1.0 (ground)
      // to `floor` (orbit) — defaulting to 0.15 produces a subtle
      // residual halo at orbit altitudes that mirrors real-camera
      // limb scattering. Set `altitudeGateOrbitFloor: 0.0` to fully
      // disable orbit bloom (matches pre-tuning Batch-22 behavior);
      // set to 1.0 to disable the gate entirely.
      const t = Math.max(
        0,
        Math.min(1, (cameraHeightMeters - min) / Math.max(1e-6, max - min)),
      );
      const smooth = t * t * (3 - 2 * t);
      const altitudeMultiplier = 1 - smooth * (1 - floor);
      gated = this._baseIntensity * altitudeMultiplier;
    }
    // Avoid redundant uploads when the gated value hasn't moved.
    if (Math.abs(gated - this._lastGatedIntensity) < 1e-4) return;
    this._lastGatedIntensity = gated;
    this._config.intensity = gated;
    this._device.queue.writeBuffer(
      this._compositeUniforms,
      0,
      new Float32Array([
        this._config.glowOnly ? 1.0 : 0.0,
        gated,
        0.0,
        0.0,
      ]) as Float32Array<ArrayBuffer>,
    );
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
    // C-R11 (Batch 31) — texture views change on resize, so the cached
    // bind groups reference stale views. Drop the cache so the next
    // execute() rebuilds against the fresh views.
    this._bgCache.invalidateAll();
    this.initialize(this._device, width, height, this._format);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    _depthView: GPUTextureView | null,
    sampler: GPUSampler,
  ): GPUTextureView {
    if (!this._device) return sourceView;

    // C-R11 (Batch 31) — all four bind groups route through the cache.
    // When sourceView / sampler / uniform buffers are stable (the typical
    // case after the first frame), the cache hits and we skip the
    // createBindGroup syscall entirely.

    // Pass 1: Bright pass (full-res → half-res)
    const brightBG = this._bgCache.getOrCreate(
      this._device,
      "Bloom-BrightPass-BG",
      this._singleTexLayout!,
      [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: this._brightUniforms! } },
      ],
    );
    executePass(
      encoder,
      "Bloom-BrightPass",
      this._brightPassPipeline!,
      brightBG,
      this._brightView!,
    );

    // Pass 2: Horizontal Gaussian blur
    const blurHBG = this._bgCache.getOrCreate(
      this._device,
      "Bloom-BlurH-BG",
      this._singleTexLayout!,
      [
        { binding: 0, resource: this._brightView! },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: this._blurHUniforms! } },
      ],
    );
    executePass(
      encoder,
      "Bloom-BlurH",
      this._blurHPipeline!,
      blurHBG,
      this._blurTempView!,
    );

    // Pass 3: Vertical Gaussian blur
    const blurVBG = this._bgCache.getOrCreate(
      this._device,
      "Bloom-BlurV-BG",
      this._singleTexLayout!,
      [
        { binding: 0, resource: this._blurTempView! },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: this._blurVUniforms! } },
      ],
    );
    executePass(
      encoder,
      "Bloom-BlurV",
      this._blurVPipeline!,
      blurVBG,
      this._blurResultView!,
    );

    // Pass 4: Composite bloom + original scene
    const compositeBG = this._bgCache.getOrCreate(
      this._device,
      "Bloom-Composite-BG",
      this._compositeLayout!,
      [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: this._blurResultView! },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: this._compositeUniforms! } },
      ],
    );
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

  // NEW-BLOOM-UNIFORM-PARITY (Batch 240) — the blur chain runs on
  // HALF-resolution textures (perf choice), so one blur texel covers 2
  // full-resolution pixels. WebGL's blur samples in full-res pixels
  // (`stepSize * czm_pixelRatio / czm_viewport.zw`); halving the user's
  // stepSize keeps the screen-space blur footprint identical across
  // backends.
  private static readonly _HALF_RES_STEP_SCALE = 0.5;

  private _createUniforms(device: GPUDevice, hw: number, hh: number): void {
    const cfg = this._config;
    const step = cfg.stepSize * BloomEffect._HALF_RES_STEP_SCALE;
    // BrightPass: contrast, brightness (WebGL ContrastBias parity —
    // NEW-BLOOM-UNIFORM-PARITY, Batch 240)
    this._brightUniforms = createUniformBuffer(
      device,
      "Bloom-BrightPass-UB",
      new Float32Array([cfg.contrast, cfg.brightness, 0.0, 0.0]),
    );

    // BlurH: delta, sigma, direction=0, stepSize
    this._blurHUniforms = createUniformBuffer(
      device,
      "Bloom-BlurH-UB",
      new Float32Array([
        cfg.delta,
        cfg.sigma,
        0.0,
        step,
        1.0 / hw,
        1.0 / hh,
        1.0,
        0.0,
      ]),
    );

    // BlurV: delta, sigma, direction=1, stepSize
    this._blurVUniforms = createUniformBuffer(
      device,
      "Bloom-BlurV-UB",
      new Float32Array([
        cfg.delta,
        cfg.sigma,
        1.0,
        step,
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
    if (config.contrast !== undefined) cfg.contrast = config.contrast;
    if (config.brightness !== undefined) cfg.brightness = config.brightness;
    if (config.delta !== undefined) cfg.delta = config.delta;
    if (config.stepSize !== undefined) cfg.stepSize = config.stepSize;
    if (config.intensity !== undefined) {
      cfg.intensity = config.intensity;
      // Session 65 Batch 22 — capture as new base intensity so the
      // altitude gate's per-frame multiplier uses the user's updated
      // baseline.
      this._baseIntensity = config.intensity;
      this._lastGatedIntensity = -1.0; // force next applyAltitudeGate to write
    }
    if (config.sigma !== undefined) cfg.sigma = config.sigma;
    if (config.glowOnly !== undefined) cfg.glowOnly = config.glowOnly;
    if (config.enableAltitudeGate !== undefined) {
      cfg.enableAltitudeGate = config.enableAltitudeGate;
      this._lastGatedIntensity = -1.0;
    }
    if (config.altitudeGateMinMeters !== undefined) {
      cfg.altitudeGateMinMeters = config.altitudeGateMinMeters;
      this._lastGatedIntensity = -1.0;
    }
    if (config.altitudeGateMaxMeters !== undefined) {
      cfg.altitudeGateMaxMeters = config.altitudeGateMaxMeters;
      this._lastGatedIntensity = -1.0;
    }
    if (config.altitudeGateOrbitFloor !== undefined) {
      cfg.altitudeGateOrbitFloor = config.altitudeGateOrbitFloor;
      this._lastGatedIntensity = -1.0;
    }

    if (this._brightUniforms) {
      this._device.queue.writeBuffer(
        this._brightUniforms,
        0,
        new Float32Array([
          cfg.contrast,
          cfg.brightness,
          0.0,
          0.0,
        ]) as Float32Array<ArrayBuffer>,
      );
    }
    // NEW-BLOOM-UNIFORM-PARITY (Batch 240) — delta/sigma/stepSize were
    // previously baked at init only; runtime changes to the blur
    // uniforms silently no-oped. Rewrite both blur UBOs (params half —
    // texel size at offset 16 is owned by initialize/resize).
    if (this._blurHUniforms && this._blurVUniforms) {
      const step = cfg.stepSize * BloomEffect._HALF_RES_STEP_SCALE;
      this._device.queue.writeBuffer(
        this._blurHUniforms,
        0,
        new Float32Array([
          cfg.delta,
          cfg.sigma,
          0.0,
          step,
        ]) as Float32Array<ArrayBuffer>,
      );
      this._device.queue.writeBuffer(
        this._blurVUniforms,
        0,
        new Float32Array([
          cfg.delta,
          cfg.sigma,
          1.0,
          step,
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
