/// <reference types="@webgpu/types" />
/**
 * WebGPU BloomEffect
 *
 * References:
 *   - Brian Karis, "Tone Mapping" / "Physically Based Shading in Theory and
 *     Practice" (SIGGRAPH 2013) — bloom as a camera-lens response to scene
 *     radiance, which is what the altitude gate below models.
 *
 * @module WebGPUBloomEffect
 */

import BloomCompositeWGSL from "../../Shaders/WebGPU/PostProcess/BloomComposite.js";
import BrightPassWGSL from "../../Shaders/WebGPU/PostProcess/BrightPass.js";
import GaussianBlur1DWGSL from "../../Shaders/WebGPU/PostProcess/GaussianBlur1D.js";
// PARITY-F16-POSTPROCESS — hand-tuned f16 variants, selected when the
// effect's `useShaderF16` flag is set by the pipeline (opt-in + device
// `shader-f16`). Default false → the f32 shaders above are used unchanged.
import BloomCompositeF16WGSL from "../../Shaders/WebGPU/PostProcess/BloomComposite_f16.js";
import BrightPassF16WGSL from "../../Shaders/WebGPU/PostProcess/BrightPass_f16.js";
import GaussianBlur1DF16WGSL from "../../Shaders/WebGPU/PostProcess/GaussianBlur1D_f16.js";
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

export interface BloomConfig {
  // The bright pass is a port of WebGL's ContrastBias.glsl — an HSB
  // brightness shift followed by a contrast curve — not a luminance
  // threshold. These six fields mirror the six uniforms of
  // `scene.postProcessStages.bloom.uniforms` one to one, with defaults from
  // `PostProcessStageLibrary.createBloomStage` and `createBlur`.
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
  // Altitude-gated bloom. When `enableAltitudeGate` is true, the default,
  // per-frame bloom intensity is multiplied by an altitude factor that fades
  // from 1.0 at sea level toward zero above `altitudeGateMaxMeters`. Bloom is
  // a camera-lens effect, and a camera in vacuum has none: real orbital
  // photography shows essentially no bloom on the Earth disk, so matching it
  // means fading the effect as the camera leaves ground altitude. Set false
  // to leave the intensity ungated.
  enableAltitudeGate?: boolean;
  // Altitude curve: bloom is fully active below this height in metres, and
  // gated to `altitudeGateOrbitFloor × baseIntensity` above
  // `altitudeGateMaxMeters`, with a smoothstep between. The defaults keep
  // full bloom for high-altitude aerial photogrammetry views — a city model
  // at ~500 m, a metropolitan area at ~10 km — while orbit views beyond one
  // Earth radius fall to a 15% floor. That floor is not zero because real
  // orbital photography shows a faint atmospheric halo from Rayleigh
  // forward-scatter through the limb, which reads perceptually as a soft
  // bloom; taking it to zero gives a too-sharp disk edge.
  altitudeGateMinMeters?: number;
  altitudeGateMaxMeters?: number;
  // Floor multiplier at fully-gated altitude. 0.0 turns bloom off entirely at
  // orbit; 1.0 is equivalent to `enableAltitudeGate: false`. The default 0.15
  // leaves a subtle residual halo mirroring real-camera limb scattering.
  altitudeGateOrbitFloor?: number;

  // The bright pass runs a single contrast and brightness curve over the
  // composite scene colour. Real bloom is lens light bleed proportional to
  // per-surface radiance, which varies sharply by material: an ocean's
  // specular sun glint is a bright tight source that should bloom even at
  // orbit, cloud tops at albedo 0.7-0.9 give a soft wide bloom, land terrain
  // at 0.15-0.35 blooms only on sun-facing slopes, snow and ice at ~0.85
  // bloom strongly, and Rayleigh haze is wavelength-dependent so blue blooms
  // more than red. Separating those would require the model and globe
  // fragment shaders to export a bloom-contribution channel, the way they
  // already export velocity for TAA, feeding a multi-channel bright pass;
  // the extra-output infrastructure exists, the per-material weight tables
  // do not.
}

export class BloomEffect implements PostProcessEffect {
  readonly name = "Bloom";
  enabled = true;

  // PARITY-F16-POSTPROCESS — when true, `_createPipelines` compiles the
  // `_f16` shader variants. Set by the pipeline before `initialize()`
  // (gated on context.useShaderF16 + device shader-f16). Default false =
  // byte-identical f32 path.
  useShaderF16 = false;

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

  // Bind-group cache. Bloom's four per-frame `createBindGroup` sites burn
  // roughly 240 bind groups per second at 60 Hz; the cache replays the same
  // bind group while the source view, samplers and intermediate views are
  // unchanged. Invalidated on resize, because texture views go stale.
  private _bgCache = new WebGPUBindGroupCache();

  private _config: Required<BloomConfig>;

  // Base intensity captured at config time, so the altitude gate multiplies
  // against it each frame rather than permanently mutating
  // `_config.intensity`, which would lose the user's authored value on every
  // subsequent gate update.
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
   * Read-only snapshot of the bind-group cache counters for
   * `WebGPUContext.getRendererStatistics()` and `CesiumDebug.cacheStats()`.
   * Pure exposure of bookkeeping the cache already maintains.
   */
  getBindGroupCacheStats(): BindGroupCacheStats {
    return this._bgCache.getStats();
  }

  /**
   * Apply the altitude-gated intensity update. Called per frame by the scene
   * renderer with the current camera altitude in metres. Multiplies the base
   * intensity by a smoothstep from 1.0 at `altitudeGateMinMeters` and below
   * to the orbit floor at `altitudeGateMaxMeters` and above. With
   * `enableAltitudeGate` false the base intensity is used unchanged.
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
      // `smoothstep(min, max, h)` blends from 0, ground bloom, to 1, orbit
      // bloom. The final multiplier therefore blends from 1.0 at ground to
      // the floor at orbit; the default 0.15 leaves the subtle residual halo
      // that mirrors real-camera limb scattering. Set
      // `altitudeGateOrbitFloor: 0.0` to remove orbit bloom entirely, or 1.0
      // to disable the gate.
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
    // Texture views change on resize, so the cached bind groups reference
    // stale views. Drop the cache and let the next `execute()` rebuild
    // against the fresh ones.
    this._bgCache.invalidateAll();
    this.initialize(this._device, width, height, this._format);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    _depthView: GPUTextureView | null,
    sampler: GPUSampler,
    timestampProvider?: WebGPUPassTimestampProvider,
  ): GPUTextureView {
    if (!this._device) return sourceView;

    // All four bind groups route through the cache. While the source view,
    // sampler and uniform buffers are stable, which is the typical case after
    // the first frame, the cache hits and the `createBindGroup` call is
    // skipped entirely.

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
      timestampProvider,
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
      timestampProvider,
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
      timestampProvider,
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
      timestampProvider,
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

    const f16 = this.useShaderF16;
    const brightSrc = f16 ? BrightPassF16WGSL : BrightPassWGSL;
    const blurSrc = f16 ? GaussianBlur1DF16WGSL : GaussianBlur1DWGSL;
    const compositeSrc = f16 ? BloomCompositeF16WGSL : BloomCompositeWGSL;
    this._brightPassPipeline = createFullscreenPipeline(
      device,
      "Bloom-BrightPass",
      brightSrc,
      format,
      this._singleTexLayout,
    );
    this._blurHPipeline = createFullscreenPipeline(
      device,
      "Bloom-BlurH",
      blurSrc,
      format,
      this._singleTexLayout,
    );
    this._blurVPipeline = createFullscreenPipeline(
      device,
      "Bloom-BlurV",
      blurSrc,
      format,
      this._singleTexLayout,
    );
    this._compositePipeline = createFullscreenPipeline(
      device,
      "Bloom-Composite",
      compositeSrc,
      format,
      this._compositeLayout,
    );
  }

  // The blur chain runs on half-resolution textures, so one blur texel covers
  // two full-resolution pixels. WebGL's blur samples in full-resolution
  // pixels, as `stepSize * czm_pixelRatio / czm_viewport.zw`, so halving the
  // user's stepSize keeps the screen-space blur footprint identical across
  // backends.
  private static readonly _HALF_RES_STEP_SCALE = 0.5;

  private _createUniforms(device: GPUDevice, hw: number, hh: number): void {
    const cfg = this._config;
    const step = cfg.stepSize * BloomEffect._HALF_RES_STEP_SCALE;
    // BrightPass: contrast and brightness, matching WebGL's ContrastBias.
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
      // Captured as the new base intensity, so the altitude gate's per-frame
      // multiplier uses the user's updated baseline.
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
    // Rewrite both blur uniform buffers — the params half; the texel size at
    // offset 16 is owned by `initialize` and `resize`. Baking delta, sigma
    // and stepSize at init only would make every runtime change to the blur
    // uniforms a silent no-op.
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
