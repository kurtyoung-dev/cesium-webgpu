/// <reference types="@webgpu/types" />
/**
 * WebGPU HeatShimmerEffect
 *
 * Atmospheric Effects Phase B (Batch 417b). Screen-space animated UV-warp
 * post-process ("heat haze" / mirage). Single-pass — mirrors the structure
 * of `WebGPUGodRayEffect` (config interface, initialize/resize/destroy,
 * execute, set* helpers, _buildUniformData, the shared-helper imports) but
 * with ONE output texture + ONE pipeline + ONE bind-group-layout (the
 * GodRay two-pass generate/composite split is not needed here).
 *
 * The effect CONSUMES the ad-hoc `scene.heatShimmerEnabled` /
 * `scene.heatShimmerIntensity` flags pushed upstream (the atmospheric
 * auto-master gates them); there is no temperature logic in this file.
 *
 * @module WebGPUHeatShimmerEffect
 */

import HeatShimmerWGSL from "../../Shaders/WebGPU/PostProcess/HeatShimmer.js";
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

export interface HeatShimmerConfig {
  /** Master warp amount (0..1). <=0 → passthrough. Default 0.6. */
  intensity?: number;
  /** Spatial scale of the noise field. Default 18. */
  frequency?: number;
  /** Animation speed multiplier. Default 0.6. */
  speed?: number;
  /**
   * UV-space v where the lower-frame band reaches full strength. With the
   * y-DOWN UV convention larger v is LOWER on screen, so a larger value
   * pushes the shimmer further toward the bottom. Default 0.62.
   */
  horizonBandCenterV?: number;
  /** UV-space width of the band ramp below the center. Default 0.4. */
  horizonBandWidth?: number;
  /**
   * Linear distance (metres) where the warp fully fades. <=0 disables the
   * depth fade entirely (depth-independent warp). Default 0 (disabled).
   */
  depthFadeFar?: number;
  /** Max sample offset in PIXELS at full intensity. Default 6. */
  maxOffsetPx?: number;
}

/**
 * Screen-space heat-shimmer (animated UV-warp post-process).
 *
 * Single fullscreen pass: samples the scene color at an animated, hash-based
 * value-noise warped UV, biased vertical and concentrated in the lower frame
 * (hot ground). Optionally fades the warp with scene depth.
 *
 * Insert in the HDR scene-color chain BEFORE TAA + tonemap so the warp
 * participates in anti-aliasing and the tone curve.
 *
 * @example
 *   const shimmer = new HeatShimmerEffect({ intensity: 0.6 });
 *   pipeline.addEffect(shimmer);
 *   // each frame the effect runs:
 *   shimmer.setTime(elapsedSeconds);
 */
export class HeatShimmerEffect implements PostProcessEffect {
  readonly name = "HeatShimmer";
  enabled = true;

  private _device: GPUDevice | null = null;
  private _width = 0;
  private _height = 0;
  private _format: GPUTextureFormat = "bgra8unorm";

  // Single full-res output texture (no half-res generate pass like GodRay).
  private _outputTex: GPUTexture | null = null;
  private _outputView: GPUTextureView | null = null;

  private _pipeline: GPURenderPipeline | null = null;
  private _layout: GPUBindGroupLayout | null = null;
  private _uniforms: GPUBuffer | null = null;

  // Bind group cache for the single per-frame site (mirrors GodRay's cache).
  private _bgCache = new WebGPUBindGroupCache();

  private _config: Required<HeatShimmerConfig>;

  // Frustum near/far, refreshed via setFrustum so depth linearization stays
  // correct when the depth fade is enabled.
  private _near = 1.0;
  private _far = 1e8;
  // Elapsed seconds, refreshed via setTime each frame the effect runs.
  private _time = 0.0;

  constructor(config: HeatShimmerConfig = {}) {
    this._config = {
      intensity: config.intensity ?? 0.6,
      frequency: config.frequency ?? 18,
      speed: config.speed ?? 0.6,
      horizonBandCenterV: config.horizonBandCenterV ?? 0.62,
      horizonBandWidth: config.horizonBandWidth ?? 0.4,
      depthFadeFar: config.depthFadeFar ?? 0,
      maxOffsetPx: config.maxOffsetPx ?? 6,
    };
  }

  /**
   * Update the animation clock. Pass ELAPSED SECONDS (small magnitude) — a
   * raw large value (e.g. a JulianDate) loses f32 precision in the shader and
   * freezes the animation. Cheap (one buffer write at float offset 0).
   */
  setTime(seconds: number): void {
    this._time = seconds;
    if (this._device && this._uniforms) {
      // params0.x is float offset 0.
      this._device.queue.writeBuffer(
        this._uniforms,
        0,
        new Float32Array([seconds]) as Float32Array<ArrayBuffer>,
      );
    }
  }

  /** Update the master warp amount (0..1). Cheap partial write. */
  setIntensity(intensity: number): void {
    this._config.intensity = intensity;
    if (this._device && this._uniforms) {
      // params0.y is float offset 1.
      this._device.queue.writeBuffer(
        this._uniforms,
        1 * 4,
        new Float32Array([intensity]) as Float32Array<ArrayBuffer>,
      );
    }
  }

  /** Update frustum near/far so depth linearization stays correct. */
  setFrustum(near: number, far: number): void {
    this._near = near;
    this._far = far;
    if (this._device && this._uniforms) {
      // frustum.xy are float offsets 8..9.
      this._device.queue.writeBuffer(
        this._uniforms,
        8 * 4,
        new Float32Array([near, far]) as Float32Array<ArrayBuffer>,
      );
    }
  }

  /**
   * Update the look/shape parameters (frequency, speed, band, maxOffsetPx).
   * Rebuilds the full uniform buffer — call only when a config dial changes,
   * not per frame.
   */
  setConfig(config: HeatShimmerConfig): void {
    if (config.intensity !== undefined)
      this._config.intensity = config.intensity;
    if (config.frequency !== undefined)
      this._config.frequency = config.frequency;
    if (config.speed !== undefined) this._config.speed = config.speed;
    if (config.horizonBandCenterV !== undefined) {
      this._config.horizonBandCenterV = config.horizonBandCenterV;
    }
    if (config.horizonBandWidth !== undefined) {
      this._config.horizonBandWidth = config.horizonBandWidth;
    }
    if (config.depthFadeFar !== undefined) {
      this._config.depthFadeFar = config.depthFadeFar;
    }
    if (config.maxOffsetPx !== undefined) {
      this._config.maxOffsetPx = config.maxOffsetPx;
    }
    if (this._device && this._uniforms) {
      this._device.queue.writeBuffer(
        this._uniforms,
        0,
        this._buildUniformData() as Float32Array<ArrayBuffer>,
      );
    }
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

    this._outputTex = createTexture(
      device,
      "HeatShimmer-Output",
      width,
      height,
      format,
    );
    this._outputView = this._outputTex.createView();

    this._layout = makeBindGroupLayout(device, "HeatShimmer-BGL", [
      texture(0, Stage.FRAGMENT),
      texture(1, Stage.FRAGMENT),
      sampler(2, Stage.FRAGMENT),
      uniformBuffer(3, Stage.FRAGMENT),
    ]);

    this._pipeline = createFullscreenPipeline(
      device,
      "HeatShimmer",
      HeatShimmerWGSL,
      format,
      this._layout,
    );

    this._uniforms = createUniformBuffer(
      device,
      "HeatShimmer-Uniforms",
      this._buildUniformData(),
    );
  }

  resize(width: number, height: number): void {
    if (!this._device || (width === this._width && height === this._height))
      return;
    this._outputTex?.destroy();
    this._outputTex = null;
    this._outputView = null;
    // Texture views change on resize → invalidate the cached bind group.
    this._bgCache.invalidateAll();
    this.initialize(this._device, width, height, this._format);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView | null,
    sampler: GPUSampler,
  ): GPUTextureView {
    // Passthrough when disabled or effectively inert — no pass recorded.
    if (!this._device || !this.enabled || this._config.intensity <= 0.001) {
      return sourceView;
    }

    // depthView may be null (the depth fade is disabled by default); bind the
    // source view as a benign placeholder so the layout stays satisfied. The
    // shader skips the depth sample entirely when depthFadeFar <= 0.
    const depthBinding = depthView ?? sourceView;

    const bg = this._bgCache.getOrCreate(
      this._device,
      "HeatShimmer-BG",
      this._layout!,
      [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: depthBinding },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: this._uniforms! } },
      ],
    );
    executePass(encoder, "HeatShimmer", this._pipeline!, bg, this._outputView!);

    return this._outputView!;
  }

  destroy(): void {
    this._outputTex?.destroy();
    this._uniforms?.destroy();
    this._outputTex = null;
    this._outputView = null;
    this._device = null;
  }

  /**
   * Pack uniforms matching the `HeatShimmerUniforms` struct in
   * HeatShimmer.wgsl — three vec4s (12 floats / 48 bytes). WebGPU pads the
   * uniform buffer binding up to 256 bytes internally.
   */
  private _buildUniformData(): Float32Array {
    const texelW = this._width > 0 ? 1.0 / this._width : 0.0;
    const texelH = this._height > 0 ? 1.0 / this._height : 0.0;
    return new Float32Array([
      // params0: time, intensity, frequency, speed
      this._time,
      this._config.intensity,
      this._config.frequency,
      this._config.speed,
      // params1: horizonBandCenterV, horizonBandWidth, depthFadeFar, maxOffsetPx
      this._config.horizonBandCenterV,
      this._config.horizonBandWidth,
      this._config.depthFadeFar,
      this._config.maxOffsetPx,
      // frustum: near, far, texelW, texelH
      this._near,
      this._far,
      texelW,
      texelH,
    ]);
  }
}
