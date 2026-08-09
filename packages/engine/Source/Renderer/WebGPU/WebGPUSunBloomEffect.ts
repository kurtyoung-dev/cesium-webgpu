/// <reference types="@webgpu/types" />
/**
 * WebGPU SunBloomEffect — the bright-pass glow around the Sun.
 *
 * Mirror of the WebGL `Scene/SunPostProcess.js` chain, stage for stage:
 * a luminance bright pass over the scene, two separable Gaussian passes, and a
 * radially bounded additive composite back over the untouched scene. Both
 * backends read one published tuning (`frameState.sunHalo`) and one set of
 * shape constants (`Scene/SolarDiscModel.js`), so the two glows are the same
 * glow rather than two approximations of one.
 *
 * Three structural points, each of which the arithmetic depends on:
 *
 *  - The bright pass reads the scene without the screen halo, which is why the
 *    halo effect runs after this one: bright-passing the halo would bloom the
 *    glow of the glow, and the two terms would stop being separable.
 *  - The blur runs on a square power-of-two buffer at
 *    `SUN_BLOOM_TEXTURE_SCALE` of the drawing buffer, because the shipped blur
 *    feeds one step to both directions and that only describes an isotropic
 *    kernel while the texels are square. Sizing this buffer by a different rule
 *    is what would make the two backends' glows different sizes.
 *  - The composite fade, not a scissor, is what bounds the glow. The WebGL
 *    chain also scissors its downsampled stages, which saves fill inside a box
 *    the fade has already zeroed the outside of; the visible result is the
 *    fade's.
 *
 * The effect adds nothing and costs no pass while the Sun's projected geometry
 * is unusable — `radiusPx <= 0` makes {@link SunBloomEffect#inert} true, which
 * the pipeline checks before encoding.
 *
 * Everything variable is a runtime uniform, so no ShaderDefine bit is claimed.
 *
 * @module WebGPUSunBloomEffect
 */

import AdditiveBlendWGSL from "../../Shaders/WebGPU/PostProcess/AdditiveBlend.js";
import GaussianBlur1DWGSL from "../../Shaders/WebGPU/PostProcess/GaussianBlur1D.js";
import SunBrightPassWGSL from "../../Shaders/WebGPU/PostProcess/SunBrightPass.js";
import {
  SUN_BLOOM_BLUR_DELTA,
  SUN_BLOOM_BLUR_SIGMA,
  SUN_BRIGHT_PASS_AVG_LUMINANCE,
  SUN_BRIGHT_PASS_OFFSET_LEGACY,
  SUN_BRIGHT_PASS_THRESHOLD_LEGACY,
  solarBloomBlurBufferSize,
} from "../../Scene/SolarDiscModel.js";
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

/**
 * Per-frame glow state. Every field is a straight copy of, or a shared-model
 * function of, `frameState.sunHalo` (`Scene/SunHaloAppearance.js`) — the
 * interface exists so the copy is type-checked, not so the numbers can be
 * re-derived here.
 */
export interface SunBloomFrameState {
  /** Luminance at which extraction starts; derived from the disc radiance. */
  brightPassThreshold: number;
  /** `threshold + offset` is where extraction reaches one half. */
  brightPassOffset: number;
  /** Projected solar centre X, drawing-buffer pixels, GL convention (y up). */
  centerX: number;
  /** Projected solar centre Y, drawing-buffer pixels, GL convention (y up). */
  centerY: number;
  /** Composite fade radius in drawing-buffer pixels; 0 disables the effect. */
  radiusPx: number;
}

export class SunBloomEffect implements PostProcessEffect {
  readonly name = "SunBloom";
  enabled = true;

  private _device: GPUDevice | null = null;
  private _width = 0;
  private _height = 0;
  private _blurSize = 0;
  private _format: GPUTextureFormat = "bgra8unorm";

  private _brightTex: GPUTexture | null = null;
  private _brightView: GPUTextureView | null = null;
  private _blurTempTex: GPUTexture | null = null;
  private _blurTempView: GPUTextureView | null = null;
  private _blurResultTex: GPUTexture | null = null;
  private _blurResultView: GPUTextureView | null = null;
  private _compositeTex: GPUTexture | null = null;
  private _compositeView: GPUTextureView | null = null;

  private _brightPipeline: GPURenderPipeline | null = null;
  private _blurHPipeline: GPURenderPipeline | null = null;
  private _blurVPipeline: GPURenderPipeline | null = null;
  private _compositePipeline: GPURenderPipeline | null = null;

  private _singleTexLayout: GPUBindGroupLayout | null = null;
  private _compositeLayout: GPUBindGroupLayout | null = null;

  private _brightUniforms: GPUBuffer | null = null;
  private _blurHUniforms: GPUBuffer | null = null;
  private _blurVUniforms: GPUBuffer | null = null;
  private _compositeUniforms: GPUBuffer | null = null;

  private _bgCache = new WebGPUBindGroupCache();

  // Mirrors `SunBrightPassUniforms`: avgLuminance, threshold, offset, unused.
  // The legacy pair is the initial value, so a frame that arrives before
  // `setFrameState` extracts at the untuned settings rather than at zero.
  private _brightData = new Float32Array([
    SUN_BRIGHT_PASS_AVG_LUMINANCE,
    SUN_BRIGHT_PASS_THRESHOLD_LEGACY,
    SUN_BRIGHT_PASS_OFFSET_LEGACY,
    0.0,
  ]);
  // Mirrors `Uniforms` in AdditiveBlend.wgsl: centre.xy, radius, height.
  private _compositeData = new Float32Array(4);

  /**
   * Push this frame's resolved glow state. Two uniform-buffer writes; the
   * shape constants are fixed at initialize.
   */
  setFrameState(state: SunBloomFrameState): void {
    const b = this._brightData;
    b[1] = state.brightPassThreshold;
    b[2] = state.brightPassOffset;
    const c = this._compositeData;
    c[0] = state.centerX;
    c[1] = state.centerY;
    c[2] = state.radiusPx > 0.0 ? state.radiusPx : 0.0;
    c[3] = this._height;
    if (!this._device) {
      return;
    }
    if (this._brightUniforms) {
      this._device.queue.writeBuffer(this._brightUniforms, 0, b);
    }
    if (this._compositeUniforms) {
      this._device.queue.writeBuffer(this._compositeUniforms, 0, c);
    }
  }

  /** True when the Sun's projected geometry gives the glow nowhere to go. */
  get inert(): boolean {
    return !(this._compositeData[2] > 0.0);
  }

  /** Edge length of the square blur buffer, in texels. */
  get blurBufferSize(): number {
    return this._blurSize;
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
    const n = solarBloomBlurBufferSize(width, height);
    this._blurSize = n;

    this._brightTex = createTexture(device, "SunBloom-Bright", n, n, format);
    this._brightView = this._brightTex.createView();
    this._blurTempTex = createTexture(
      device,
      "SunBloom-BlurTemp",
      n,
      n,
      format,
    );
    this._blurTempView = this._blurTempTex.createView();
    this._blurResultTex = createTexture(
      device,
      "SunBloom-BlurResult",
      n,
      n,
      format,
    );
    this._blurResultView = this._blurResultTex.createView();
    this._compositeTex = createTexture(
      device,
      "SunBloom-Composite",
      width,
      height,
      format,
    );
    this._compositeView = this._compositeTex.createView();

    this._singleTexLayout = makeBindGroupLayout(
      device,
      "SunBloom-SingleTex-BGL",
      [
        texture(0, Stage.FRAGMENT),
        sampler(1, Stage.FRAGMENT),
        uniformBuffer(2, Stage.FRAGMENT),
      ],
    );
    this._compositeLayout = makeBindGroupLayout(
      device,
      "SunBloom-Composite-BGL",
      [
        texture(0, Stage.FRAGMENT),
        sampler(1, Stage.FRAGMENT),
        texture(2, Stage.FRAGMENT),
        sampler(3, Stage.FRAGMENT),
        uniformBuffer(4, Stage.FRAGMENT),
      ],
    );

    this._brightPipeline = createFullscreenPipeline(
      device,
      "SunBloom-BrightPass",
      SunBrightPassWGSL,
      format,
      this._singleTexLayout,
    );
    this._blurHPipeline = createFullscreenPipeline(
      device,
      "SunBloom-BlurH",
      GaussianBlur1DWGSL,
      format,
      this._singleTexLayout,
    );
    this._blurVPipeline = createFullscreenPipeline(
      device,
      "SunBloom-BlurV",
      GaussianBlur1DWGSL,
      format,
      this._singleTexLayout,
    );
    this._compositePipeline = createFullscreenPipeline(
      device,
      "SunBloom-Composite",
      AdditiveBlendWGSL,
      format,
      this._compositeLayout,
    );

    this._brightUniforms = createUniformBuffer(
      device,
      "SunBloom-BrightPass-UB",
      this._brightData,
    );
    // The blur's `step` is `stepSize * pixelRatio * texelSize`, and the WebGL
    // twin feeds `1 / bufferSize` to both directions. On a square buffer the
    // per-axis form below is that same number, so a step size of one texel and
    // a pixel ratio of one reproduce the shipped kernel exactly.
    const texel = 1.0 / n;
    this._blurHUniforms = createUniformBuffer(
      device,
      "SunBloom-BlurH-UB",
      new Float32Array([
        SUN_BLOOM_BLUR_DELTA,
        SUN_BLOOM_BLUR_SIGMA,
        0.0,
        1.0,
        texel,
        texel,
        1.0,
        0.0,
      ]),
    );
    this._blurVUniforms = createUniformBuffer(
      device,
      "SunBloom-BlurV-UB",
      new Float32Array([
        SUN_BLOOM_BLUR_DELTA,
        SUN_BLOOM_BLUR_SIGMA,
        1.0,
        1.0,
        texel,
        texel,
        1.0,
        0.0,
      ]),
    );
    // Keep whatever `setFrameState` already wrote, but refresh the viewport
    // height, which is the only field this method owns.
    this._compositeData[3] = height;
    this._compositeUniforms = createUniformBuffer(
      device,
      "SunBloom-Composite-UB",
      this._compositeData,
    );
  }

  resize(width: number, height: number): void {
    if (!this._device || (width === this._width && height === this._height)) {
      return;
    }
    this._destroyResources();
    this._bgCache.invalidateAll();
    this.initialize(this._device, width, height, this._format);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    _depthView: GPUTextureView | null,
    sampler_: GPUSampler,
    timestampProvider?: WebGPUPassTimestampProvider,
  ): GPUTextureView {
    // No depth input: the glow is the display's response to supra-white
    // radiance, so it is not occluded by scene geometry. A Sun behind the Earth
    // is handled upstream by the same visibility test that gates the WebGL
    // chain.
    if (!this._device || !this._brightPipeline || this.inert) {
      return sourceView;
    }

    const brightBG = this._bgCache.getOrCreate(
      this._device,
      "SunBloom-BrightPass-BG",
      this._singleTexLayout!,
      [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: sampler_ },
        { binding: 2, resource: { buffer: this._brightUniforms! } },
      ],
    );
    executePass(
      encoder,
      "SunBloom-BrightPass",
      this._brightPipeline,
      brightBG,
      this._brightView!,
      timestampProvider,
    );

    const blurHBG = this._bgCache.getOrCreate(
      this._device,
      "SunBloom-BlurH-BG",
      this._singleTexLayout!,
      [
        { binding: 0, resource: this._brightView! },
        { binding: 1, resource: sampler_ },
        { binding: 2, resource: { buffer: this._blurHUniforms! } },
      ],
    );
    executePass(
      encoder,
      "SunBloom-BlurH",
      this._blurHPipeline!,
      blurHBG,
      this._blurTempView!,
      timestampProvider,
    );

    const blurVBG = this._bgCache.getOrCreate(
      this._device,
      "SunBloom-BlurV-BG",
      this._singleTexLayout!,
      [
        { binding: 0, resource: this._blurTempView! },
        { binding: 1, resource: sampler_ },
        { binding: 2, resource: { buffer: this._blurVUniforms! } },
      ],
    );
    executePass(
      encoder,
      "SunBloom-BlurV",
      this._blurVPipeline!,
      blurVBG,
      this._blurResultView!,
      timestampProvider,
    );

    // Glow first, scene second — the binding order the GLSL twin uses, where
    // `colorTexture2` is the untouched scene the fade mixes back to.
    const compositeBG = this._bgCache.getOrCreate(
      this._device,
      "SunBloom-Composite-BG",
      this._compositeLayout!,
      [
        { binding: 0, resource: this._blurResultView! },
        { binding: 1, resource: sampler_ },
        { binding: 2, resource: sourceView },
        { binding: 3, resource: sampler_ },
        { binding: 4, resource: { buffer: this._compositeUniforms! } },
      ],
    );
    executePass(
      encoder,
      "SunBloom-Composite",
      this._compositePipeline!,
      compositeBG,
      this._compositeView!,
      timestampProvider,
    );

    return this._compositeView!;
  }

  private _destroyResources(): void {
    this._brightTex?.destroy();
    this._blurTempTex?.destroy();
    this._blurResultTex?.destroy();
    this._compositeTex?.destroy();
    this._brightUniforms?.destroy();
    this._blurHUniforms?.destroy();
    this._blurVUniforms?.destroy();
    this._compositeUniforms?.destroy();
    this._brightTex = null;
    this._brightView = null;
    this._blurTempTex = null;
    this._blurTempView = null;
    this._blurResultTex = null;
    this._blurResultView = null;
    this._compositeTex = null;
    this._compositeView = null;
    this._brightUniforms = null;
    this._blurHUniforms = null;
    this._blurVUniforms = null;
    this._compositeUniforms = null;
  }

  destroy(): void {
    this._destroyResources();
    this._brightPipeline = null;
    this._blurHPipeline = null;
    this._blurVPipeline = null;
    this._compositePipeline = null;
    this._singleTexLayout = null;
    this._compositeLayout = null;
    this._device = null;
  }
}

export default SunBloomEffect;
