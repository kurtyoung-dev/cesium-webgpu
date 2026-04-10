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

// Re-export effect configs for consumers
export type { BloomConfig, AmbientOcclusionConfig, DepthOfFieldConfig };

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

  // Ping-pong textures for single-pass stage chaining
  private _pingTexture: GPUTexture | null = null;
  private _pongTexture: GPUTexture | null = null;
  private _pingView: GPUTextureView | null = null;
  private _pongView: GPUTextureView | null = null;

  // Shared sampler
  private _sampler: GPUSampler | null = null;

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

  private _isDestroyed = false;

  /**
   * Whether any post-processing stages or effects are enabled.
   */
  get hasActiveStages(): boolean {
    if (this._tonemapStage?.enabled) return true;
    if (this._colorGradingStage?.enabled) return true;
    if (this._fxaaStage?.enabled) return true;
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

  get depthOfFieldEffect(): DepthOfFieldEffect | null {
    return this._dofEffect;
  }

  // ================================================================
  //  Initialization
  // ================================================================

  /**
   * Initialize the pipeline with device and viewport.
   */
  initialize(
    device: GPUDevice,
    width: number,
    height: number,
    canvasFormat: GPUTextureFormat,
  ): void {
    if (width <= 0 || height <= 0) return;

    const needsRecreate =
      this._device !== device ||
      this._width !== width ||
      this._height !== height;

    if (!needsRecreate && this._pingTexture) return;

    this._device = device;
    this._width = width;
    this._height = height;
    this._canvasFormat = canvasFormat;

    this._destroyTextures();

    const textureDesc: GPUTextureDescriptor = {
      size: { width, height },
      format: canvasFormat,
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
  ): void {
    if (this._tonemapStage) return;
    // Uniforms: exposure, gamma, mode, whitePoint
    const uniforms = new Float32Array([exposure, gamma, mode, 4.0]);
    this._tonemapStage = this._compileStage(
      device,
      "Tonemap",
      TonemappingWGSL,
      canvasFormat,
      uniforms,
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
    this._colorGradingStage = this._compileStage(
      device,
      "ColorGrading",
      ColorGradingWGSL,
      canvasFormat,
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
    this._fxaaStage = this._compileStage(
      device,
      "FXAA",
      FXAAWGSL,
      canvasFormat,
      texelSize,
    );
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
    const stage = this._compileStage(
      device,
      desc.name,
      desc.wgslCode,
      canvasFormat,
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
  ): void {
    if (!this.hasActiveStages) return;

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

    // 4. Tonemapping + ColorGrading + Custom stages + FXAA (single-pass chain)
    const singlePassStages: CompiledStage[] = [];
    if (this._tonemapStage?.enabled) singlePassStages.push(this._tonemapStage);
    if (this._colorGradingStage?.enabled) {
      // Phase 4 — runs after tonemap (so it sees SDR) and before custom
      // stages + FXAA (so the AA pass smooths any contrast-boosted edges).
      singlePassStages.push(this._colorGradingStage);
    }
    for (const s of this._customStages) {
      if (s.enabled) singlePassStages.push(s);
    }
    if (this._fxaaStage?.enabled) singlePassStages.push(this._fxaaStage);

    if (singlePassStages.length === 0) {
      // No single-pass stages — if we had complex effects, copy to dest
      if (currentView !== sourceView) {
        this._executeCopyStage(encoder, currentView, destView);
      }
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

    this.initialize(this._device, width, height, this._canvasFormat);

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
    // Use tonemapping with exposure=1, gamma=1 as a passthrough copy
    if (this._tonemapStage) {
      this._executeSinglePassStage(
        encoder,
        this._tonemapStage,
        sourceView,
        targetView,
      );
    }
  }

  private _compileStage(
    device: GPUDevice,
    name: string,
    wgslCode: string,
    targetFormat: GPUTextureFormat,
    uniforms?: Float32Array,
  ): CompiledStage {
    const shaderModule = device.createShaderModule({
      label: `PostProcess-${name}-Shader`,
      code: wgslCode,
    });

    const entries: GPUBindGroupLayoutEntry[] = [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
    ];

    let uniformBuffer: GPUBuffer | null = null;
    if (uniforms) {
      entries.push({
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      });
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

    const bindGroupLayout = device.createBindGroupLayout({
      label: `PostProcess-${name}-BindGroupLayout`,
      entries,
    });

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
    this._bloomEffect = null;
    this._aoEffect = null;
    this._dofEffect = null;

    this._tonemapStage = null;
    this._fxaaStage = null;
    this._isDestroyed = true;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
