/// <reference types="@webgpu/types" />
/**
 * WebGPU SunHaloEffect — the screen-space solar veiling glare, and the WebGPU
 * consumer of `scene.sunBloom`. `WebGPUContext.supportsLegacySunBloom` returns
 * `false`, so `FramebufferOrchestrator` skips the WebGL `SunPostProcess`
 * allocation entirely and this effect is the only thing on the WebGPU side
 * that reads the flag.
 *
 * One pass, no blur. The WebGL `SunPostProcess` derives its glow by
 * bright-passing and blurring the framebuffer; this effect synthesises the
 * veiling-glare profile analytically around the projected solar centre,
 * because a blur of a finite source cannot produce a `1/rho^2` tail that
 * survives past the source's own footprint. That non-terminating tail is
 * precisely what a halo baked into the billboard cannot carry — see
 * `SOLAR_GLARE_SUPPORT` in `Scene/SolarDiscModel.js`. The same analytic stage
 * runs on WebGL as `SolarHalo.glsl` inside `SunPostProcess`, so the two
 * backends draw one curve from one set of published numbers rather than two
 * approximations of it.
 *
 * Every parameter is a runtime uniform, so no ShaderDefine bit is claimed.
 *
 * @module WebGPUSunHaloEffect
 */

import SolarHaloWGSL from "../../Shaders/WebGPU/PostProcess/SolarHalo.js";
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
 * Per-frame halo state. Every field is a straight copy of
 * `frameState.sunHalo` (`Scene/SunHaloAppearance.js`) — this interface exists
 * so the copy is type-checked, not so the numbers can be re-derived here.
 */
export interface SunHaloFrameState {
  /** Projected solar centre X, drawing-buffer pixels, GL convention (y up). */
  centerX: number;
  /** Projected solar centre Y, drawing-buffer pixels, GL convention (y up). */
  centerY: number;
  /** Pixels per solar radius at the current distance + field of view. */
  limbPx: number;
  /** Half-amplitude radius of the veil, in solar radii. */
  coreRadii: number;
  /** Amplitude times the eclipse factor. Exactly 0 makes the add a no-op. */
  intensity: number;
  /** Per-channel atmospheric transmittance; (1,1,1) from orbit. */
  colorR: number;
  colorG: number;
  colorB: number;
}

export class SunHaloEffect implements PostProcessEffect {
  readonly name = "SunHalo";
  enabled = true;

  private _device: GPUDevice | null = null;
  private _width = 0;
  private _height = 0;
  private _format: GPUTextureFormat = "bgra8unorm";

  private _outputTex: GPUTexture | null = null;
  private _outputView: GPUTextureView | null = null;
  private _pipeline: GPURenderPipeline | null = null;
  private _layout: GPUBindGroupLayout | null = null;
  private _uniforms: GPUBuffer | null = null;
  private _bgCache = new WebGPUBindGroupCache();

  // Mirrors `SolarHaloUniforms` in SolarHalo.wgsl: three vec4s.
  //   geometry = centre.xy, limbPx, coreRadii
  //   tint     = colour.rgb, intensity
  //   viewport = height, 0, 0, 0
  private _uniformData = new Float32Array(12);

  /**
   * Push this frame's resolved halo state. Cheap — one uniform-buffer write.
   * `intensity === 0` leaves the pass arithmetically inert (`+ 0.0` per
   * channel); the pipeline skips the pass entirely in that case, so a
   * disabled halo costs nothing at all.
   */
  setFrameState(state: SunHaloFrameState): void {
    const d = this._uniformData;
    d[0] = state.centerX;
    d[1] = state.centerY;
    // Guard the two divisors the shader performs. A zero `limbPx` or
    // `coreRadii` would produce Inf/NaN across the whole frame — the
    // classic screen-space-effect wipeout — so clamp to a positive floor
    // here rather than branching per fragment. `SunHaloAppearance` already
    // refuses to publish `visible` unless both are finite and positive; this
    // is the second line of defence, at the only place that writes the GPU.
    d[2] = state.limbPx > 0.0 ? state.limbPx : 1.0;
    d[3] = state.coreRadii > 0.0 ? state.coreRadii : 1.0;
    d[4] = state.colorR;
    d[5] = state.colorG;
    d[6] = state.colorB;
    d[7] = state.intensity;
    d[8] = this._height;
    d[9] = 0.0;
    d[10] = 0.0;
    d[11] = 0.0;
    if (this._device && this._uniforms) {
      this._device.queue.writeBuffer(this._uniforms, 0, d);
    }
  }

  /** True when the current state would add nothing (amplitude exactly 0). */
  get inert(): boolean {
    return !(this._uniformData[7] > 0.0);
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
      "SunHalo-Output",
      width,
      height,
      format,
    );
    this._outputView = this._outputTex.createView();

    this._layout = makeBindGroupLayout(device, "SunHalo-BGL", [
      texture(0, Stage.FRAGMENT),
      sampler(1, Stage.FRAGMENT),
      uniformBuffer(2, Stage.FRAGMENT),
    ]);
    this._pipeline = createFullscreenPipeline(
      device,
      "SunHalo",
      SolarHaloWGSL,
      format,
      this._layout,
    );
    // Keep whatever `setFrameState` already wrote (the pipeline pushes state
    // before the first execute), but refresh the viewport height, which is
    // the only field this method owns.
    this._uniformData[8] = height;
    this._uniforms = createUniformBuffer(
      device,
      "SunHalo-Uniforms",
      this._uniformData,
    );
  }

  resize(width: number, height: number): void {
    if (!this._device || (width === this._width && height === this._height)) {
      return;
    }
    this._outputTex?.destroy();
    this._outputTex = null;
    this._outputView = null;
    this._uniforms?.destroy();
    this._uniforms = null;
    this._bgCache.invalidateAll();
    this.initialize(this._device, width, height, this._format);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    _depthView: GPUTextureView | null,
    sampler_: GPUSampler,
  ): GPUTextureView {
    // No depth input: veiling glare is scattering inside the observer's
    // optics, so it is deliberately not occluded by scene geometry. The Sun
    // going behind the Earth is handled upstream, by the same
    // `environmentState.isSunVisible` test that gates the WebGL stage.
    if (!this._device || !this._pipeline || this.inert) {
      return sourceView;
    }
    const bg = this._bgCache.getOrCreate(
      this._device,
      "SunHalo-BG",
      this._layout!,
      [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: sampler_ },
        { binding: 2, resource: { buffer: this._uniforms! } },
      ],
    );
    executePass(encoder, "SunHalo", this._pipeline, bg, this._outputView!);
    return this._outputView!;
  }

  destroy(): void {
    this._outputTex?.destroy();
    this._uniforms?.destroy();
    this._outputTex = null;
    this._outputView = null;
    this._uniforms = null;
    this._pipeline = null;
    this._layout = null;
    this._device = null;
  }
}

export default SunHaloEffect;
