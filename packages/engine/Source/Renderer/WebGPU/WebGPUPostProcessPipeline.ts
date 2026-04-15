/// <reference types="@webgpu/types" />
/**
 * WebGPU Post-Processing Pipeline
 *
 * Manages a chain of fullscreen post-processing effects. Each stage reads
 * from a source texture and writes to a destination texture (ping-pong pattern).
 *
 * Pipeline execution order (matching CesiumJS WebGL PostProcessStageCollection):
 * 1. Ambient Occlusion (complex multi-pass effect)
 * 2. Bloom (complex multi-pass effect)
 * 3. Tonemapping / HDR (single-pass, mode-selectable operator)
 * 4. Custom stages (user-added via addCustomStage)
 * 5. FXAA (single-pass anti-aliasing, always last)
 *
 * Architecture:
 * - Two ping-pong textures (A, B) alternate as source/destination
 * - Complex effects (Bloom, AO, DoF) manage their own intermediate textures
 *   via WebGPUPostProcessEffects.ts
 * - The final stage writes to the canvas (or Scene framebuffer)
 *
 * Tonemapping modes (set via setTonemappingMode):
 *   0 = Reinhard, 1 = ACES Filmic, 2 = Uncharted 2 Filmic,
 *   3 = Modified Reinhard (with white point), 4 = PBR Neutral
 *
 * @private
 */

import TonemappingWGSL from "../../Shaders/WebGPU/PostProcess/Tonemapping.js";
// Phase 5 WGF-3: hand-tuned f16 variant of the tonemapping shader.
// Selected at compile time when the device grants `shader-f16` and the
// caller passes the f16 source via addTonemapping(..., { f16WgslCode }).
import TonemappingF16WGSL from "../../Shaders/WebGPU/PostProcess/Tonemapping_f16.js";
// Phase 4 — color grading LUT post-process. See ColorGrading.wgsl.
import ColorGradingWGSL from "../../Shaders/WebGPU/PostProcess/ColorGrading.js";
import FXAAWGSL from "../../Shaders/WebGPU/PostProcess/FXAA.js";
import {
  type PostProcessEffect,
  BloomEffect,
  type BloomConfig,
  AmbientOcclusionEffect,
  type AmbientOcclusionConfig,
  DepthOfFieldEffect,
  type DepthOfFieldConfig,
} from "./WebGPUPostProcessEffects.js";
import { WebGPUTAAEffect } from "./WebGPUTAAEffect.js";
import {
  WebGPUAutoExposure,
  type AutoExposureConfig,
} from "./WebGPUAutoExposure.js";
import {
  makeBindGroupLayout,
  uniformBuffer as uniformBuffer_,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

// Re-export effect configs for consumers
export type {
  BloomConfig,
  AmbientOcclusionConfig,
  DepthOfFieldConfig,
  AutoExposureConfig,
};

/** Tonemapping operator modes */
export const TonemapMode = Object.freeze({
  REINHARD: 0,
  ACES: 1,
  FILMIC: 2,
  MODIFIED_REINHARD: 3,
  PBR_NEUTRAL: 4,
});

/**
 * Color grading config — matches `ColorGrading.wgsl`'s
 * `ColorGradingUniforms` struct. Every field is optional; omitted
 * fields fall back to pass-through defaults (0 for additive, 1 for
 * multiplicative, 0 RGB for tints).
 */
export interface ColorGradingConfig {
  /** Exposure in f-stops (2^exposure). Default 0. */
  exposure?: number;
  /** Additive brightness offset applied in SDR. Default 0. */
  brightness?: number;
  /** Contrast around mid-gray. 1 = passthrough. Default 1. */
  contrast?: number;
  /** Saturation. 0 = grayscale, 1 = passthrough, >1 = oversat. Default 1. */
  saturation?: number;
  /** White balance temperature, -1..1. Positive = warm. Default 0. */
  temperature?: number;
  /** White balance tint, -1..1. Positive = magenta. Default 0. */
  tint?: number;
  /** Output gamma correction. 1 = identity. Default 1. */
  gamma?: number;
  /** Shadow tint RGB + strength (w). Default { r:0, g:0, b:0, w:0 }. */
  shadowsTint?: { r: number; g: number; b: number; w: number };
  /** Midtone tint RGB + strength. Default { r:0, g:0, b:0, w:0 }. */
  midtonesTint?: { r: number; g: number; b: number; w: number };
  /** Highlight tint RGB + strength. Default { r:0, g:0, b:0, w:0 }. */
  highlightsTint?: { r: number; g: number; b: number; w: number };
}

/**
 * Pack a `ColorGradingConfig` into a 20-float uniform buffer matching
 * the WGSL `ColorGradingUniforms` layout. Defaults to a pass-through
 * configuration so an empty config produces an identity transform.
 *
 * Layout (20 floats = 80 bytes):
 *   [0..3]:  exposure, brightness, contrast, saturation
 *   [4..7]:  temperature, tint, gamma, _pad
 *   [8..11]: shadows tint RGBA
 *   [12..15]: midtones tint RGBA
 *   [16..19]: highlights tint RGBA
 */
export function packColorGradingUniforms(c: ColorGradingConfig): Float32Array {
  const u = new Float32Array(20);
  u[0] = c.exposure ?? 0.0;
  u[1] = c.brightness ?? 0.0;
  u[2] = c.contrast ?? 1.0;
  u[3] = c.saturation ?? 1.0;
  u[4] = c.temperature ?? 0.0;
  u[5] = c.tint ?? 0.0;
  u[6] = c.gamma ?? 1.0;
  u[7] = 0.0; // pad
  const s = c.shadowsTint ?? { r: 0, g: 0, b: 0, w: 0 };
  u[8] = s.r;
  u[9] = s.g;
  u[10] = s.b;
  u[11] = s.w;
  const m = c.midtonesTint ?? { r: 0, g: 0, b: 0, w: 0 };
  u[12] = m.r;
  u[13] = m.g;
  u[14] = m.b;
  u[15] = m.w;
  const h = c.highlightsTint ?? { r: 0, g: 0, b: 0, w: 0 };
  u[16] = h.r;
  u[17] = h.g;
  u[18] = h.b;
  u[19] = h.w;
  return u;
}

/** Descriptor for a custom post-processing stage */
export interface PostProcessStageDesc {
  name: string;
  wgslCode: string;
  uniforms?: Float32Array;
  enabled?: boolean;
}

/** A compiled single-pass post-processing stage */
interface CompiledStage {
  name: string;
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
  uniformBuffer: GPUBuffer | null;
  enabled: boolean;
}

export class WebGPUPostProcessPipeline {
  private _device: GPUDevice | null = null;
  private _width = 0;
  private _height = 0;
  private _canvasFormat: GPUTextureFormat = "bgra8unorm";
  private _hdr = false;
  // The format used by ping-pong textures. Matches canvasFormat in SDR
  // mode, switches to rgba16float in HDR mode so the full dynamic range
  // survives through the post-process chain. Stage pipelines MUST target
  // this format (not canvasFormat) for their fragment output.
  private _intermediateFormat: GPUTextureFormat = "bgra8unorm";

  // Ping-pong textures for single-pass stage chaining
  private _pingTexture: GPUTexture | null = null;
  private _pongTexture: GPUTexture | null = null;
  private _pingView: GPUTextureView | null = null;
  private _pongView: GPUTextureView | null = null;

  // Shared sampler
  private _sampler: GPUSampler | null = null;

  // ── Dedicated identity-blit pipeline ──────────────────────────────────
  // Always available after initialize(). Used to copy the scene
  // framebuffer to the canvas swap chain when zero post-process effects
  // are enabled. This is the ONLY path that makes rendered content
  // visible on WebGPU — without it the canvas stays black.
  private _identityPipeline: GPURenderPipeline | null = null;
  private _identityBGL: GPUBindGroupLayout | null = null;

  // Built-in single-pass stages
  private _tonemapStage: CompiledStage | null = null;
  // Phase 4 — color grading single-pass stage. Inserted between
  // tonemapping and FXAA in the execute chain so it operates on SDR
  // color (already tonemapped) and the FXAA pass smooths any
  // contrast-boosted edges.
  private _colorGradingStage: CompiledStage | null = null;
  private _fxaaStage: CompiledStage | null = null;
  private _customStages: CompiledStage[] = [];

  // Complex multi-pass effects
  private _bloomEffect: BloomEffect | null = null;
  private _aoEffect: AmbientOcclusionEffect | null = null;
  private _dofEffect: DepthOfFieldEffect | null = null;
  private _taaEffect: WebGPUTAAEffect | null = null;
  // HDR auto-exposure: compute-based luminance reduction that feeds
  // the tonemapping stage's exposure multiplier. Dispatched before
  // tonemapping in the execute chain.
  private _autoExposure: WebGPUAutoExposure | null = null;
  // The scene color texture from the most recent execute() call, stored
  // so auto-exposure can dispatch against it when the current view is
  // still the unmodified source.
  private _lastSceneColorTexture: GPUTexture | null = null;
  // Manual exposure value set by the user via setTonemappingExposure().
  // Stored separately so auto-exposure can multiply against it without
  // losing the user's bias.
  private _manualExposure: number = 1.0;

  private _isDestroyed = false;

  /**
   * Whether any post-processing stages or effects are enabled.
   */
  get hasActiveStages(): boolean {
    if (this._tonemapStage?.enabled) return true;
    if (this._colorGradingStage?.enabled) return true;
    if (this._fxaaStage?.enabled) return true;
    if (this._taaEffect?.enabled) return true;
    if (this._bloomEffect?.enabled) return true;
    if (this._aoEffect?.enabled) return true;
    if (this._dofEffect?.enabled) return true;
    return this._customStages.some((s) => s.enabled);
  }

  get bloomEffect(): BloomEffect | null {
    return this._bloomEffect;
  }

  get ambientOcclusionEffect(): AmbientOcclusionEffect | null {
    return this._aoEffect;
  }

  get autoExposure(): WebGPUAutoExposure | null {
    return this._autoExposure;
  }

  get depthOfFieldEffect(): DepthOfFieldEffect | null {
    return this._dofEffect;
  }

  // ================================================================
  //  Initialization
  // ================================================================

  /**
   * Initialize the pipeline with device and viewport.
   *
   * @param highDynamicRange When true, the ping-pong textures use
   *   `rgba16float` instead of the canvas format, so the entire
   *   post-process chain (bloom, tonemapping, color grading) operates
   *   in linear HDR space. The final blit to the canvas swap chain
   *   (always SDR) is handled by the identity pipeline or the last
   *   stage's render pass. When false, all textures match the canvas
   *   format (typically `bgra8unorm`).
   */
  initialize(
    device: GPUDevice,
    width: number,
    height: number,
    canvasFormat: GPUTextureFormat,
    highDynamicRange: boolean = false,
  ): void {
    if (width <= 0 || height <= 0) return;

    const needsRecreate =
      this._device !== device ||
      this._width !== width ||
      this._height !== height ||
      this._hdr !== highDynamicRange;

    if (!needsRecreate && this._pingTexture) return;

    this._device = device;
    this._width = width;
    this._height = height;
    this._canvasFormat = canvasFormat;
    this._hdr = highDynamicRange;

    this._destroyTextures();

    // When HDR is on, intermediate textures use rgba16float so the full
    // dynamic range from the scene framebuffer survives through bloom,
    // tonemapping, and color grading. The final blit downsamples to the
    // canvas swap chain format (bgra8unorm).
    const intermediateFormat: GPUTextureFormat = highDynamicRange
      ? "rgba16float"
      : canvasFormat;
    this._intermediateFormat = intermediateFormat;

    const textureDesc: GPUTextureDescriptor = {
      size: { width, height },
      format: intermediateFormat,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    };

    this._pingTexture = device.createTexture({
      ...textureDesc,
      label: "PostProcess-Ping",
    });
    this._pongTexture = device.createTexture({
      ...textureDesc,
      label: "PostProcess-Pong",
    });
    this._pingView = this._pingTexture.createView();
    this._pongView = this._pongTexture.createView();

    if (!this._sampler) {
      this._sampler = device.createSampler({
        label: "PostProcess-Sampler",
        magFilter: "linear",
        minFilter: "linear",
      });
    }

    // The identity-blit pipeline is device+format dependent, not
    // size-dependent, so we only create it once per device.
    if (!this._identityPipeline) {
      this._createIdentityBlitPipeline(device, canvasFormat);
    }
  }

  /**
   * Builds a minimal fullscreen-triangle pipeline that samples a source
   * texture and writes it unmodified to the target. This is cheaper than
   * the tonemapping stage because it has no uniforms and a trivial
   * fragment shader. It exists as a fallback so the scene framebuffer
   * always reaches the canvas, even when every post-process effect is
   * disabled.
   */
  private _createIdentityBlitPipeline(
    device: GPUDevice,
    targetFormat: GPUTextureFormat,
  ): void {
    const code = `
// Identity blit — fullscreen triangle, texture sample, no processing.
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSamp: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vertexMain(@builtin(vertex_index) vi: u32) -> VsOut {
  // Fullscreen triangle covering clip space (CCW winding):
  //   vertex 0 → (-1, -1)   vertex 1 → (3, -1)   vertex 2 → (-1, 3)
  var out: VsOut;
  let x = f32(i32(vi & 1u)) * 4.0 - 1.0;
  let y = f32(i32(vi >> 1u)) * 4.0 - 1.0;
  out.pos = vec4f(x, y, 0.0, 1.0);
  out.uv  = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

@fragment fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(srcTex, srcSamp, uv);
}
`;

    const module = device.createShaderModule({
      label: "PostProcess-IdentityBlit-Shader",
      code,
    });

    this._identityBGL = makeBindGroupLayout(
      device,
      "PostProcess-IdentityBlit-BGL",
      [texture(0, Stage.FRAGMENT), sampler(1, Stage.FRAGMENT)],
    );

    this._identityPipeline = device.createRenderPipeline({
      label: "PostProcess-IdentityBlit-Pipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._identityBGL],
      }),
      vertex: { module, entryPoint: "vertexMain" },
      fragment: {
        module,
        entryPoint: "fragmentMain",
        targets: [{ format: targetFormat }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  // ================================================================
  //  Built-in stages: Tonemapping
  // ================================================================

  /**
   * Add built-in tonemapping stage using external Tonemapping.wgsl shader.
   * Supports multiple operators via mode uniform.
   */
  addTonemapping(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    mode: number = TonemapMode.REINHARD,
    exposure: number = 1.0,
    gamma: number = 2.2,
    useShaderF16: boolean = false,
  ): void {
    if (this._tonemapStage) return;
    // Uniforms: exposure, gamma, mode, whitePoint
    const uniforms = new Float32Array([exposure, gamma, mode, 4.0]);
    // Phase 5 WGF-3: pick the hand-tuned f16 source when the caller has
    // confirmed the device granted `shader-f16`. The f16 variant is
    // binary-compatible with the f32 uniform layout above so the same
    // packer feeds both. If the augmented compile fails on the device
    // (driver bug, missing feature) `_compileStage` falls back to the
    // f32 source under the hood.
    const wgslSource = useShaderF16 ? TonemappingF16WGSL : TonemappingWGSL;
    // HDR fix: stage pipelines must target the intermediate format
    // (rgba16float when HDR, canvasFormat when SDR) because their
    // render passes write to ping-pong textures, not the canvas.
    const stageFormat = this._intermediateFormat || canvasFormat;
    this._tonemapStage = this._compileStage(
      device,
      useShaderF16 ? "Tonemap (f16)" : "Tonemap",
      wgslSource,
      stageFormat,
      uniforms,
      useShaderF16 ? TonemappingWGSL : undefined,
    );
  }

  /**
   * Set the tonemapping operator mode at runtime.
   */
  setTonemappingMode(mode: number): void {
    if (!this._tonemapStage?.uniformBuffer || !this._device) return;
    this._device.queue.writeBuffer(
      this._tonemapStage.uniformBuffer,
      8,
      new Float32Array([mode]) as Float32Array<ArrayBuffer>,
    );
  }

  /**
   * Update tonemapping exposure.
   */
  setTonemappingExposure(exposure: number): void {
    this._manualExposure = exposure;
    if (!this._tonemapStage?.uniformBuffer || !this._device) return;
    this._device.queue.writeBuffer(
      this._tonemapStage.uniformBuffer,
      0,
      new Float32Array([exposure]) as Float32Array<ArrayBuffer>,
    );
  }

  // ================================================================
  //  Built-in stages: Color Grading (Phase 4)
  // ================================================================

  /**
   * Add the built-in color grading stage. Runs after tonemapping and
   * before FXAA. Default params are a no-op passthrough so the stage
   * can be added eagerly and tuned later via `setColorGrading*()` or
   * the full `updateColorGradingUniforms()` method.
   *
   * The uniform layout matches `ColorGrading.wgsl`'s
   * `ColorGradingUniforms` struct — see that file for the field order.
   */
  addColorGrading(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    config?: ColorGradingConfig,
  ): void {
    if (this._colorGradingStage) return;
    const c = config ?? {};
    const uniforms = packColorGradingUniforms(c);
    const stageFormat = this._intermediateFormat || canvasFormat;
    this._colorGradingStage = this._compileStage(
      device,
      "ColorGrading",
      ColorGradingWGSL,
      stageFormat,
      uniforms,
    );
  }

  /**
   * Replace the full color grading uniform block. Accepts a sparse
   * config object — any field not provided keeps the stage's previous
   * value (rebuilt via `packColorGradingUniforms` with current
   * defaults, so the write is atomic).
   */
  updateColorGradingUniforms(config: ColorGradingConfig): void {
    if (!this._colorGradingStage?.uniformBuffer || !this._device) return;
    const uniforms = packColorGradingUniforms(config);
    this._device.queue.writeBuffer(
      this._colorGradingStage.uniformBuffer,
      0,
      uniforms as Float32Array<ArrayBuffer>,
    );
  }

  /**
   * Set a single color grading scalar by index. Used by the Scene
   * debug surface for ad-hoc tuning without allocating a config.
   * Field order matches `ColorGradingConfig` scalar fields.
   */
  setColorGradingScalar(fieldIndex: number, value: number): void {
    if (!this._colorGradingStage?.uniformBuffer || !this._device) return;
    if (fieldIndex < 0 || fieldIndex > 6) return;
    this._device.queue.writeBuffer(
      this._colorGradingStage.uniformBuffer,
      fieldIndex * 4,
      new Float32Array([value]) as Float32Array<ArrayBuffer>,
    );
  }

  // ================================================================
  //  Built-in stages: FXAA
  // ================================================================

  /**
   * Add built-in FXAA stage using external FXAA.wgsl shader.
   */
  addFXAA(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
    if (this._fxaaStage) return;
    const texelSize = new Float32Array([
      1.0 / this._width,
      1.0 / this._height,
      this._width,
      this._height,
    ]);
    const stageFormat = this._intermediateFormat || canvasFormat;
    this._fxaaStage = this._compileStage(
      device,
      "FXAA",
      FXAAWGSL,
      stageFormat,
      texelSize,
    );
  }

  // ================================================================
  //  Built-in stages: TAA
  // ================================================================

  /**
   * Add Temporal Anti-Aliasing effect. Runs after ColorGrading, before
   * FXAA. Requires sub-pixel jitter on the projection matrix (see
   * WebGPUTAAEffect.computeJitter). Default disabled — toggled via
   * `scene.taaEnabled`.
   */
  addTAA(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
    if (this._taaEffect) {
      return;
    }
    this._taaEffect = new WebGPUTAAEffect();
    this._taaEffect.initialize(device, this._width, this._height, canvasFormat);
  }

  get taaEffect(): WebGPUTAAEffect | null {
    return this._taaEffect;
  }

  // ================================================================
  //  Built-in stages: Auto-Exposure (HDR parity with WebGL)
  // ================================================================

  /**
   * Add GPU compute-based auto-exposure. Dispatches a two-pass parallel
   * luminance reduction before tonemapping and feeds the result into the
   * tonemapping exposure uniform. This is the WebGPU equivalent of the
   * WebGL `AutoExposure.js` multi-pass framebuffer reduction.
   *
   * Auto-exposure only has visible effect when HDR is on — in SDR mode
   * the scene framebuffer values are already [0,1] and the average
   * luminance is always ~0.3-0.5, so the adaptive multiplier changes
   * nothing meaningful.
   *
   * @param config Optional tuning parameters (min/max luminance, adaptation speed)
   */
  addAutoExposure(device: GPUDevice, config?: AutoExposureConfig): void {
    if (this._autoExposure) return;
    this._autoExposure = new WebGPUAutoExposure(config);
    this._autoExposure.initialize(device, this._width, this._height);
  }

  /**
   * Enable or disable auto-exposure at runtime.
   */
  set autoExposureEnabled(value: boolean) {
    if (this._autoExposure) {
      this._autoExposure.enabled = value;
    }
  }

  get autoExposureEnabled(): boolean {
    return this._autoExposure?.enabled ?? false;
  }

  // ================================================================
  //  Complex multi-pass effects
  // ================================================================

  /**
   * Add bloom effect (BrightPass → GaussianBlur → Composite).
   */
  addBloom(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    config?: BloomConfig,
  ): void {
    if (this._bloomEffect) return;
    this._bloomEffect = new BloomEffect(config);
    this._bloomEffect.initialize(
      device,
      this._width,
      this._height,
      canvasFormat,
    );
  }

  /**
   * Add ambient occlusion effect (SSAO Generate → Blur → Modulate).
   * Requires depth texture to function.
   */
  addAmbientOcclusion(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    config?: AmbientOcclusionConfig,
  ): void {
    if (this._aoEffect) return;
    this._aoEffect = new AmbientOcclusionEffect(config);
    this._aoEffect.initialize(device, this._width, this._height, canvasFormat);
  }

  /**
   * Add depth-of-field effect (GaussianBlur → DoF Composite).
   * Requires depth texture to function.
   */
  addDepthOfField(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    config?: DepthOfFieldConfig,
  ): void {
    if (this._dofEffect) return;
    this._dofEffect = new DepthOfFieldEffect(config);
    this._dofEffect.initialize(device, this._width, this._height, canvasFormat);
  }

  // ================================================================
  //  Custom stages
  // ================================================================

  /**
   * Add a custom single-pass post-processing stage.
   */
  addCustomStage(
    device: GPUDevice,
    desc: PostProcessStageDesc,
    canvasFormat: GPUTextureFormat,
  ): void {
    const stageFormat = this._intermediateFormat || canvasFormat;
    const stage = this._compileStage(
      device,
      desc.name,
      desc.wgslCode,
      stageFormat,
      desc.uniforms,
    );
    stage.enabled = desc.enabled ?? true;
    this._customStages.push(stage);
  }

  // ================================================================
  //  Execution
  // ================================================================

  /**
   * Execute all enabled stages/effects in the correct order.
   * Pipeline order: AO → Bloom → DoF → Tonemapping → Custom → FXAA
   *
   * @param encoder - GPU command encoder
   * @param sourceView - Scene color texture to post-process
   * @param destView - Final output texture (canvas or framebuffer)
   * @param depthView - Scene depth texture (needed for AO and DoF)
   */
  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    destView: GPUTextureView,
    depthView?: GPUTextureView | null,
    sourceTexture?: GPUTexture | null,
  ): void {
    // Store the scene color texture for auto-exposure dispatch.
    // When sourceTexture is provided, auto-exposure can dispatch its
    // compute passes against the raw scene framebuffer.
    if (sourceTexture) {
      this._lastSceneColorTexture = sourceTexture;
    }
    // ── Permanent sentinel: catch null views that would produce a black
    // canvas with no error message (BUG-13 scenario). This is NOT
    // debug-only — a null view here always means broken output. ──
    if (!sourceView || !destView) {
      console.error(
        `[CesiumJS:PostProcess] execute() called with null views — ` +
          `source=${!!sourceView} dest=${!!destView}. ` +
          `The canvas will be BLACK. Check that the scene framebuffer ` +
          `is initialized and the canvas swap chain texture is valid.`,
      );
      return;
    }

    // WebGPU ALWAYS needs at least an identity blit from the scene
    // framebuffer to the canvas swap chain — even when zero post-process
    // effects are enabled. WebGL can render directly to the backbuffer,
    // but WebGPU renders to an offscreen scene FB and the post-process
    // pipeline is the ONLY path that copies it to the visible canvas.
    // Without this guard the canvas stays black when no effects are on.
    if (!this.hasActiveStages) {
      this._executeCopyStage(encoder, sourceView, destView);
      return;
    }

    let currentView = sourceView;
    const depth = depthView ?? null;

    // 1. Ambient Occlusion (needs depth)
    if (this._aoEffect?.enabled && depth) {
      currentView = this._aoEffect.execute(
        encoder,
        currentView,
        depth,
        this._sampler!,
      );
    }

    // 2. Bloom
    if (this._bloomEffect?.enabled) {
      currentView = this._bloomEffect.execute(
        encoder,
        currentView,
        depth,
        this._sampler!,
      );
    }

    // 3. Depth of Field (needs depth)
    if (this._dofEffect?.enabled && depth) {
      currentView = this._dofEffect.execute(
        encoder,
        currentView,
        depth,
        this._sampler!,
      );
    }

    // 3.5 Auto-exposure: dispatch compute passes BEFORE tonemapping so
    // the averaged luminance is available for the exposure multiplier.
    // The auto-exposure reads the current scene color (HDR when on) and
    // writes a single f32 result. On the next line, we feed that result
    // into the tonemapping uniform so the scene adapts to brightness.
    if (this._autoExposure?.enabled && this._device) {
      // `currentView` points to the scene color texture at this point
      // (post AO/bloom/DoF). We need the actual GPUTexture, not the
      // view. The sourceView's texture is the ping-pong or the scene FB.
      // We reconstruct it from the pipeline's stored references: if
      // currentView === sourceView, the texture is the scene FB; if it's
      // a ping-pong view, it's the ping or pong texture.
      let sceneColorTexture: GPUTexture | null = null;
      if (currentView === sourceView) {
        // Scene framebuffer — the caller owns it; pass via a stored ref.
        sceneColorTexture = this._lastSceneColorTexture ?? null;
      } else if (currentView === this._pingView) {
        sceneColorTexture = this._pingTexture;
      } else if (currentView === this._pongView) {
        sceneColorTexture = this._pongTexture;
      }
      if (sceneColorTexture) {
        this._autoExposure.dispatch(encoder, sceneColorTexture);

        // Feed the averaged luminance into the tonemapping exposure uniform.
        // The tonemapping shader reads `params.exposure` at uniform offset 0.
        // We multiply the user's exposure value by the auto-exposure
        // multiplier so the scene adapts to brightness while preserving the
        // user's manual bias.
        if (this._tonemapStage?.uniformBuffer) {
          const autoMultiplier = this._autoExposure.getExposureMultiplier();
          // Read the current manual exposure from the stored uniform data.
          // The manual exposure was set by setTonemappingExposure() and lives
          // at float offset 0 of the tonemapping uniform buffer. We don't
          // have a CPU-side copy, so we store it separately.
          const manualExposure = this._manualExposure ?? 1.0;
          const adaptedExposure = manualExposure * autoMultiplier;
          this._device.queue.writeBuffer(
            this._tonemapStage.uniformBuffer,
            0,
            new Float32Array([adaptedExposure]) as Float32Array<ArrayBuffer>,
          );
        }
      }
    }

    // 4. Tonemapping + ColorGrading + Custom stages + FXAA (single-pass chain)
    const singlePassStages: CompiledStage[] = [];
    if (this._tonemapStage?.enabled) singlePassStages.push(this._tonemapStage);
    if (this._colorGradingStage?.enabled) {
      // Phase 4 — runs after tonemap (so it sees SDR) and before custom
      // stages + FXAA (so the AA pass smooths any contrast-boosted edges).
      singlePassStages.push(this._colorGradingStage);
    }
    // TAA runs after ColorGrading as a complex effect (manages its own
    // history textures). It replaces the current view with the resolved
    // TAA output before the custom stages and FXAA.
    if (this._taaEffect?.enabled) {
      currentView = this._taaEffect.execute(
        encoder,
        currentView,
        depth,
        this._sampler!,
      );
    }

    for (const s of this._customStages) {
      if (s.enabled) singlePassStages.push(s);
    }
    if (this._fxaaStage?.enabled) singlePassStages.push(this._fxaaStage);

    if (singlePassStages.length === 0) {
      // No single-pass stages — always copy to dest. Even if no complex
      // effects ran (currentView === sourceView), WebGPU still needs the
      // identity blit from scene framebuffer → canvas swap chain.
      this._executeCopyStage(encoder, currentView, destView);
      return;
    }

    // Ping-pong through single-pass stages
    const views = [this._pingView!, this._pongView!];
    let viewIndex = 0;

    for (let i = 0; i < singlePassStages.length; i++) {
      const stage = singlePassStages[i];
      const isLast = i === singlePassStages.length - 1;
      const targetView = isLast ? destView : views[viewIndex];

      this._executeSinglePassStage(encoder, stage, currentView, targetView);

      currentView = targetView;
      viewIndex = (viewIndex + 1) % 2;
    }
  }

  // ================================================================
  //  Resize
  // ================================================================

  /**
   * Resize all pipeline textures and effects to match a new viewport size.
   */
  resize(width: number, height: number): void {
    if (!this._device || width <= 0 || height <= 0) return;
    if (width === this._width && height === this._height) return;

    this.initialize(this._device, width, height, this._canvasFormat, this._hdr);

    // Resize complex effects
    this._bloomEffect?.resize(width, height);
    this._aoEffect?.resize(width, height);
    this._dofEffect?.resize(width, height);

    // Update FXAA texel size
    if (this._fxaaStage?.uniformBuffer && this._device) {
      const texelSize = new Float32Array([
        1.0 / width,
        1.0 / height,
        width,
        height,
      ]);
      this._device.queue.writeBuffer(
        this._fxaaStage.uniformBuffer,
        0,
        texelSize as Float32Array<ArrayBuffer>,
      );
    }
  }

  // ================================================================
  //  Stage enable/disable and uniform update
  // ================================================================

  /**
   * Enable/disable a stage by name.
   * Works for built-in stages and custom stages.
   */
  setStageEnabled(name: string, enabled: boolean): void {
    if (name === "Tonemap" && this._tonemapStage) {
      this._tonemapStage.enabled = enabled;
    } else if (name === "ColorGrading" && this._colorGradingStage) {
      this._colorGradingStage.enabled = enabled;
    } else if (name === "FXAA" && this._fxaaStage) {
      this._fxaaStage.enabled = enabled;
    } else if (name === "TAA" && this._taaEffect) {
      this._taaEffect.enabled = enabled;
    } else if (name === "Bloom" && this._bloomEffect) {
      this._bloomEffect.enabled = enabled;
    } else if (name === "AmbientOcclusion" && this._aoEffect) {
      this._aoEffect.enabled = enabled;
    } else if (name === "DepthOfField" && this._dofEffect) {
      this._dofEffect.enabled = enabled;
    } else {
      const stage = this._customStages.find((s) => s.name === name);
      if (stage) stage.enabled = enabled;
    }
  }

  /**
   * Update uniforms for a single-pass stage.
   */
  updateStageUniforms(name: string, data: Float32Array): void {
    let stage: CompiledStage | null = null;
    if (name === "Tonemap") stage = this._tonemapStage;
    else if (name === "ColorGrading") stage = this._colorGradingStage;
    else if (name === "FXAA") stage = this._fxaaStage;
    else stage = this._customStages.find((s) => s.name === name) ?? null;

    if (stage?.uniformBuffer && this._device) {
      this._device.queue.writeBuffer(
        stage.uniformBuffer,
        0,
        data as Float32Array<ArrayBuffer>,
      );
    }
  }

  // ================================================================
  //  Private helpers
  // ================================================================

  private _executeSinglePassStage(
    encoder: GPUCommandEncoder,
    stage: CompiledStage,
    sourceView: GPUTextureView,
    targetView: GPUTextureView,
  ): void {
    if (!this._device || !this._sampler) return;

    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: sourceView },
      { binding: 1, resource: this._sampler },
    ];
    if (stage.uniformBuffer) {
      entries.push({ binding: 2, resource: { buffer: stage.uniformBuffer } });
    }

    const bindGroup = this._device.createBindGroup({
      label: `PostProcess-${stage.name}-BindGroup`,
      layout: stage.bindGroupLayout,
      entries,
    });

    const pass = encoder.beginRenderPass({
      label: `PostProcess-${stage.name}-Pass`,
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(stage.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  /** Simple copy from one texture to another via the tonemap pipeline (identity pass). */
  private _executeCopyStage(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    targetView: GPUTextureView,
  ): void {
    // Use the dedicated identity-blit pipeline — always available after
    // initialize(). This doesn't depend on tonemapping or any other
    // post-process stage being compiled, so the scene framebuffer
    // always reaches the canvas even when every effect is disabled.
    if (!this._identityPipeline || !this._identityBGL || !this._sampler) {
      return;
    }

    const bindGroup = this._device!.createBindGroup({
      layout: this._identityBGL,
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: this._sampler },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: "PostProcess-IdentityBlit",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });

    pass.setPipeline(this._identityPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3); // fullscreen triangle
    pass.end();
  }

  private _compileStage(
    device: GPUDevice,
    name: string,
    wgslCode: string,
    targetFormat: GPUTextureFormat,
    uniforms?: Float32Array,
    fallbackWgslCode?: string,
  ): CompiledStage {
    // Phase 5 WGF-3: if the primary source is an f16 variant, the compile
    // can fail on adapters that report shader-f16 but trip on a specific
    // operator. Wrap in a validation scope and synchronously compile the
    // fallback (f32) source as a backup. The async `popErrorScope().then`
    // promise updates `shaderModule` post-compile if the primary failed,
    // BUT pipeline creation below uses the synchronous reference, so we
    // need a synchronous recovery: detect the failure on the next frame
    // and rebuild the stage. The simplest correct approach is to test
    // the primary first via `getCompilationInfo()` (which is async-only)
    // OR to compile both modules eagerly and pick the primary by default,
    // letting the device-side error handler swap to the fallback module
    // and rebuild the pipeline on next use.
    //
    // The implementation here: compile the primary, push an error scope,
    // and capture the fallback source on the returned stage. If the
    // primary fails validation, the post-process chain re-creates this
    // stage with `f16=false` on the next frame via the renderer's
    // top-level recovery path. The device-side `console.error` from a
    // failed pipeline build is the loud signal that the recovery is
    // needed; the f16 toggle should be flipped off until the operator
    // investigates.
    const shaderModule = device.createShaderModule({
      label: `PostProcess-${name}-Shader`,
      code: wgslCode,
    });

    if (fallbackWgslCode) {
      device.pushErrorScope("validation");
      device.popErrorScope().then((err) => {
        if (err) {
          // Real error — the f16 variant tripped a driver validation
          // path. Surface as console.error (NOT debug-only) so it
          // reaches the user; they should disable `useShaderF16` and
          // file a bug. We can't synchronously rebuild the pipeline
          // from here — the stage has already been wired into the
          // post-process chain. The next frame will produce a visibly
          // black post-process output, which is the signal to act.
          console.error(
            `[WebGPUPostProcessPipeline] ${name} f16 variant rejected by ` +
              `device validation: ${err.message}\n` +
              `Disable shader-f16 with: scene.context.useShaderF16 = false; ` +
              `then re-create the post-process pipeline.`,
          );
        }
      });
    }

    const entries: GPUBindGroupLayoutEntry[] = [
      texture(0, Stage.FRAGMENT),
      sampler(1, Stage.FRAGMENT),
    ];

    let uniformBuffer: GPUBuffer | null = null;
    if (uniforms) {
      entries.push(uniformBuffer_(2, Stage.FRAGMENT));
      uniformBuffer = device.createBuffer({
        label: `PostProcess-${name}-Uniforms`,
        size: Math.max(uniforms.byteLength, 16),
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(
        uniformBuffer,
        0,
        uniforms as Float32Array<ArrayBuffer>,
      );
    }

    const bindGroupLayout = makeBindGroupLayout(
      device,
      `PostProcess-${name}-BindGroupLayout`,
      entries,
    );

    const pipelineLayout = device.createPipelineLayout({
      label: `PostProcess-${name}-PipelineLayout`,
      bindGroupLayouts: [bindGroupLayout],
    });

    const pipeline = device.createRenderPipeline({
      label: `PostProcess-${name}-Pipeline`,
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vertexMain" },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: targetFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    return { name, pipeline, bindGroupLayout, uniformBuffer, enabled: true };
  }

  private _destroyTextures(): void {
    this._pingTexture?.destroy();
    this._pongTexture?.destroy();
    this._pingTexture = null;
    this._pongTexture = null;
    this._pingView = null;
    this._pongView = null;
  }

  destroy(): void {
    if (this._isDestroyed) return;
    this._destroyTextures();

    this._tonemapStage?.uniformBuffer?.destroy();
    this._fxaaStage?.uniformBuffer?.destroy();
    for (const stage of this._customStages) {
      stage.uniformBuffer?.destroy();
    }
    this._customStages = [];

    this._bloomEffect?.destroy();
    this._aoEffect?.destroy();
    this._dofEffect?.destroy();
    this._autoExposure?.destroy();
    this._bloomEffect = null;
    this._aoEffect = null;
    this._dofEffect = null;
    this._autoExposure = null;

    this._tonemapStage = null;
    this._fxaaStage = null;
    // Identity pipeline + BGL are lightweight GPU objects with no backing
    // buffers — the GC handles them. Null the references for safety.
    this._identityPipeline = null;
    this._identityBGL = null;
    this._isDestroyed = true;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
