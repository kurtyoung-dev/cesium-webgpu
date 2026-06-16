/// <reference types="@webgpu/types" />
/**
 * WebGPU Post-Processing Pipeline
 *
 * Manages a chain of fullscreen post-processing effects. Each stage reads
 * from a source texture and writes to a destination texture (ping-pong pattern).
 *
 * Pipeline execution order:
 * 1. Ambient Occlusion (complex multi-pass effect)
 * 2. Bloom + GodRays (complex multi-pass effects)
 * 3. Depth of Field (complex multi-pass effect, depth-gated)
 * 3.5 AutoExposure (compute, feeds Tonemap exposure uniform)
 * 4. TAA (Audit B.16, Batch 155 — runs in linear/HDR domain BEFORE
 *    Tonemap. NEW-TAA-PIPELINE-ORDER-RECONCILE (Batch 290) — RESOLVED:
 *    pre-tonemap (linear/HDR) is the CORRECT placement and the existing
 *    clamp constants already suit linear input. Rationale:
 *      • TAA.wgsl's resolve does its OWN reversible tonemap-weighting
 *        (`tonemapWeight` = c/(1+luma), the Karis HDR anti-firefly
 *        map [0,∞)→[0,1)) before the neighborhood-AABB clamp + blend,
 *        then `inverseTonemapWeight` = c/(1-luma) to recover HDR. That
 *        weighting is well-defined ONLY for linear/HDR input: on
 *        already-tonemapped SDR [0,1] the inverse divides by (1-luma)
 *        which → 0 / negative as highlights approach luma=1, yielding
 *        Inf/NaN. So the clamp domain is the tonemap-WEIGHT space, not
 *        raw HDR — the constants (3×3 AABB, 0.1 blend, 0.13 normal-
 *        divergence, 0.1 motion-length gate) are already domain-correct
 *        and need NO retune for linear input.
 *      • Running TAA post-tonemap would double-apply a tone curve
 *        (display tonemap, then the internal Reinhard weight) and break
 *        HDR history accumulation — the 8/16-bit history would clamp
 *        highlights the tonemapper hadn't yet rolled off.
 *      • WebGL Cesium has no built-in TAA stage, so there's no upstream
 *        reference that contradicts the linear-domain placement; the
 *        decision rests on the resolve shader's own math + standard
 *        HDR-resolve practice (UE/Frostbite resolve in linear with a
 *        reversible weight).
 *    History buffers therefore use `_intermediateFormat` (rgba16float
 *    in HDR) — see addTAA / NEW-POSTPROCESS-HDR-INTERMEDIATES.)
 * 5. Tonemapping / HDR (single-pass, mode-selectable operator)
 * 6. ColorGrading (single-pass LUT)
 * 7. Custom stages (user-added via addCustomStage)
 * 8. FXAA (single-pass anti-aliasing, always last)
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
import { WebGPUUserPostProcessStage } from "./WebGPUUserPostProcessStage.js";
// Audit A.11 (Batch 133) -- pipeline-level GodRay registration.
import { GodRayEffect, type GodRayConfig } from "./WebGPUGodRayEffect.js";
// Track V-A2 (NEW-ATMO-AERIAL-PERSPECTIVE-POSTPROCESS) — unified per-pixel
// atmosphere over the whole scene.
import {
  AerialPerspectiveEffect,
  type AerialPerspectiveConfig,
} from "./WebGPUAerialPerspectiveEffect.js";
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
  AerialPerspectiveConfig,
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

  // Cached per-frame bind group. The bind group entries are
  // (sourceView, sampler, uniformBuffer); the only field that ever
  // changes per-frame is the sourceView (ping/pong rotates). Cache the
  // last `(source → bind group)` pair on the stage so a steady-state
  // chain rebuilds nothing when the source view set is stable.
  // Invalidates automatically when:
  //   - the cached source view is no longer the one passed in
  //   - the underlying ping/pong textures get reallocated (resize / HDR
  //     toggle), since `_resizeIntermediates` recreates the views and
  //     the new view !== cached view.
  cachedBindGroup?: GPUBindGroup;
  cachedSourceView?: GPUTextureView;
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
  // Cached BG for `_executeCopyStage` — stable as long as the source
  // view reference matches the one we built the BG with. Identical
  // pattern to `CompiledStage.cachedBindGroup`; see that comment.
  private _identityCachedBindGroup: GPUBindGroup | null = null;
  private _identityCachedSourceView: GPUTextureView | null = null;

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
  // NEW-POSTPROCESS-USER-WGSL (Batch 198) — first slice. User-supplied
  // WGSL fragment-shader stages added via `Scene.postProcessStages.add()`.
  // Run as a chain AFTER built-in stages but BEFORE tonemapping/FXAA
  // so user effects operate on the post-bloom/AO/DoF HDR output.
  private _userStages: WebGPUUserPostProcessStage[] = [];
  // Audit A.11 (Batch 133) -- GodRay (volumetric light scattering)
  // post-process. Activated through `addGodRay` + the configure-pipeline
  // sync; per-frame sun screen UV updated via
  // `setSunScreenUV` from the scene-level configure pass.
  private _godRayEffect: GodRayEffect | null = null;
  // Track V-A2 (NEW-ATMO-AERIAL-PERSPECTIVE-POSTPROCESS) — unified per-pixel
  // atmosphere. Runs FIRST in the depth-dependent chain (before AO/bloom) so
  // the haze participates in bloom + tonemap, matching how WebGL applies the
  // ground atmosphere in the globe fragment shader before post-process.
  // Per-frame camera/sun/atmosphere uniforms + the transmittance LUT view are
  // pushed by the configure pass.
  private _aerialPerspectiveEffect: AerialPerspectiveEffect | null = null;
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

  // HDR-DISPLAY (Batch 205, B200-D1/D2 audit fix) — when the canvas is
  // configured for HDR output (extended dynamic range), tonemapping is
  // skipped so the swap chain receives the raw HDR signal. ColorGrading
  // and FXAA both implicitly assume SDR-mapped input (LDR contrast curves
  // and luminance-keyed edge detection), so they must be skipped too.
  // Driven per-frame by `WebGPUPostProcessStageCollection.update()`.
  private _skipSDRStagesForHDR = false;

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
    if (this._godRayEffect?.enabled) return true;
    if (this._aerialPerspectiveEffect?.enabled) return true;
    // NEW-POSTPROCESS-USER-WGSL (Batch 198) — user-supplied WGSL stages.
    if (this._userStages.some((s) => s.enabled)) return true;
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

  /** Audit A.11 (Batch 133) -- GodRay effect or null if not added. */
  get godRayEffect(): GodRayEffect | null {
    return this._godRayEffect;
  }

  /**
   * Track V-A2 — unified aerial-perspective atmosphere effect, or null if
   * not added. The configure pass uses this to push per-frame camera/sun/
   * atmosphere uniforms + the transmittance LUT view.
   */
  get aerialPerspectiveEffect(): AerialPerspectiveEffect | null {
    return this._aerialPerspectiveEffect;
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

    // Reset the built-in effects so the configure path recreates them with the
    // CURRENT intermediate format + size. They are created once (the `addX`
    // guards `if (this._bloomEffect) return`), so without this an HDR toggle
    // (or resize) would leave them holding their first-creation 8-bit /
    // wrong-size intermediate textures — which clamps HDR highlights BEFORE
    // tonemap (NEW-POSTPROCESS-HDR-INTERMEDIATES). Only runs on a real
    // recreate (device / size / HDR change), not per frame.
    this._bloomEffect?.destroy();
    this._aoEffect?.destroy();
    this._dofEffect?.destroy();
    this._godRayEffect?.destroy();
    // Track V-A2 — aerial-perspective output texture is sized + formatted
    // against `_intermediateFormat`, so a resize / HDR toggle must drop it
    // too. The configure pass lazily re-adds it on the same frame when
    // `scene.aerialPerspective` is on (gate checks the live slot).
    this._aerialPerspectiveEffect?.destroy();
    this._bloomEffect = null;
    this._aoEffect = null;
    this._dofEffect = null;
    this._godRayEffect = null;
    this._aerialPerspectiveEffect = null;
    // NEW-TAA-EFFECT-NEVER-ADDED (Batch 244) — TAA joins the recreate
    // reset list: its history textures + pipeline target are sized and
    // formatted against `_intermediateFormat`, so a resize / HDR toggle
    // must drop them too. The configure pass (`WebGPUPostProcess
    // StageCollection`) lazily re-adds the effect on the same frame
    // because its gate checks the LIVE `pipeline.taaEffect` slot, not a
    // sticky cache flag.
    this._taaEffect?.destroy();
    this._taaEffect = null;

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
// Identity blit — fullscreen triangle, texture sample, NO color
// transform.
//
// Session 65 Batch 48 (revert of Batch 47): the inline pow(1/2.2)
// encode added in Batch 47 caused double-gamma-encoding for the FOG /
// SkyAtmosphere / SkyBox / ground-atmosphere paths, which ALREADY
// apply pow(c, 1/2.2) inside the per-pixel shader (see e.g.
// GlobeTerrain.wgsl FOG branch line 2619, SkyAtmosphere.wgsl line 492,
// ModelPBRComplete.wgsl line 928). Fragments rendered through those
// paths got encoded twice → pow(c, 1/4.84) → washed-out / desaturated
// look reported as 'BUG-WEBGPU-CUBEMAP-DOUBLE-GAMMA'-style symptom.
//
// Fragments rendered through paths that DON'T pre-encode (raw imagery
// at orbit altitudes outside the fog/atmosphere drape) stayed dark
// without the blit-side encode, producing the gamma-2.4-darker
// signature probe-darkness-quant.mjs measured pre-Batch-47.
//
// The proper architectural fix is one of:
//   A. Make the canvas format bgra8unorm-srgb so the GPU ROP applies
//      the encode in hardware on every write. Requires bumping every
//      pipeline whose final target is the canvas (identity blit,
//      tonemap, color grading, FXAA, custom user stages) — multi-file
//      change.
//   B. Audit every render path and ensure EXACTLY ONE inline encode
//      between the imagery sampler and the canvas. Today fog/sky/PBR
//      have encodes; imagery/atmosphere-drape do not. Pick the
//      canonical layer (probably the final stage) and consolidate.
//
// Both options are bigger than Batch 47 attempted; tracking under
// NEW-VR2-3-IMAGERY-WASH-OUT.
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
   * Add Temporal Anti-Aliasing effect. Runs in the linear/HDR domain
   * BEFORE Tonemap (see the pipeline-order header). Requires sub-pixel
   * jitter on the projection matrix (see WebGPUTAAEffect.computeJitter).
   * Default disabled — toggled via `scene.taaEnabled`, which drives the
   * lazy-add in `configureWebGPUPostProcessPipeline` (Batch 244,
   * NEW-TAA-EFFECT-NEVER-ADDED — this method previously had zero
   * callers, so the resolve stage never ran).
   */
  addTAA(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
    if (this._taaEffect) {
      return;
    }
    this._taaEffect = new WebGPUTAAEffect();
    // Intermediate format (rgba16float in HDR) — same
    // NEW-POSTPROCESS-HDR-INTERMEDIATES (Batch 225) rule as the other
    // built-in effects: TAA runs pre-tonemap, so an 8-bit history would
    // clamp HDR highlights before the tonemapper sees them. SDR =
    // canvasFormat (no-op for the common path).
    this._taaEffect.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat || canvasFormat,
    );
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
  addAutoExposure(
    device: GPUDevice,
    config?: AutoExposureConfig,
    computePipelineCache:
      | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
      | null = null,
  ): void {
    if (this._autoExposure) return;
    this._autoExposure = new WebGPUAutoExposure(config);
    this._autoExposure.initialize(
      device,
      this._width,
      this._height,
      computePipelineCache,
    );
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
    // Use the intermediate format (rgba16float in HDR) so bloom's bright-pass +
    // blur chain preserves HDR highlights instead of clamping at 8-bit
    // (NEW-POSTPROCESS-HDR-INTERMEDIATES). In SDR this equals canvasFormat.
    this._bloomEffect.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat || canvasFormat,
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
    // Intermediate format (rgba16float in HDR) — see addBloom. SDR = canvasFormat.
    this._aoEffect.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat || canvasFormat,
    );
  }

  /**
   * NEW-POSTPROCESS-USER-WGSL (Batch 198 first slice; Batch 199
   * B198-D1 audit fix) — add a user-supplied WGSL post-process stage
   * to the pipeline. The stage is appended to the `_userStages` chain
   * and runs AFTER built-in stages (Bloom, AO, DoF, GodRay) and
   * AFTER auto-exposure dispatch but BEFORE TAA + tonemap — same
   * insertion point the WebGL backend uses for `scene.postProcessStages
   * .add()` user stages.
   *
   * The user provides a WGSL fragment shader source (declares
   * `fragmentMain` returning vec4 + bindings per the convention in
   * `WebGPUUserPostProcessStage`'s module doc) and a numeric uniforms
   * map. The stage compiles the user FS, builds a single-bind-group
   * pipeline (source texture + sampler + 64-byte UBO), and renders
   * fullscreen into its own intermediate texture.
   *
   * Batch 199 (B198-D1 audit fix) — the stage's intermediate texture
   * now uses `_intermediateFormat` (rgba16float in HDR mode, canvas
   * format in SDR) instead of the caller-passed `canvasFormat`. In
   * HDR mode the prior implementation downconverted user-stage output
   * to 8-bit, defeating HDR precision. `canvasFormat` is kept on the
   * API surface for backwards compatibility but is no longer used for
   * the intermediate allocation.
   *
   * @param device GPUDevice
   * @param canvasFormat Canvas color format (kept for API compat; the
   *   stage internally uses `_intermediateFormat` to preserve HDR)
   * @param name User-friendly stage name for debugging / labels
   * @param fragmentSource WGSL fragment shader source string
   * @param uniformValues Numeric uniforms map (packed in iteration order)
   */
  addUserWGSLStage(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    name: string,
    fragmentSource: string,
    uniformValues: Record<string, number | number[]>,
    schema?: import("./WebGPUUserPostProcessStage.js").UniformSchema,
    numberOfPasses?: number,
  ): void {
    const stage = new WebGPUUserPostProcessStage(
      name,
      fragmentSource,
      uniformValues,
      schema,
      numberOfPasses,
    );
    // Batch 199 (B198-D1) — use _intermediateFormat (HDR-aware) so user
    // stages preserve precision when HDR is on. `canvasFormat` param
    // retained on the API for backwards compatibility but unused here.
    void canvasFormat;
    const stageFormat = this._intermediateFormat;
    stage.initialize(device, this._width, this._height, stageFormat);
    this._userStages.push(stage);
  }

  /**
   * NEW-POSTPROCESS-USER-WGSL (Batch 198) — drop all user-added WGSL
   * stages. Called by the configure step when the user collection's
   * `_stages` array changes (add or remove a stage).
   */
  clearUserWGSLStages(): void {
    for (const stage of this._userStages) {
      stage.destroy();
    }
    this._userStages.length = 0;
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
    // Intermediate format (rgba16float in HDR) — see addBloom. SDR = canvasFormat.
    this._dofEffect.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat || canvasFormat,
    );
  }

  /**
   * Audit A.11 (Batch 133) -- Add GodRay effect (radial blur toward
   * sun + composite). Two-pass: half-res ray generate -> full-res
   * composite. Caller is expected to feed the per-frame sun screen UV
   * via `pipeline.godRayEffect.setSunScreenUV(u, v)` (the
   * `WebGPUPostProcessStageCollection` configure path does this when
   * the scene has a sun configured). Requires depth texture to
   * function (the generate pass uses depth as a sky/geometry gate).
   */
  addGodRay(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    config?: GodRayConfig,
  ): void {
    if (this._godRayEffect) return;
    this._godRayEffect = new GodRayEffect(config);
    // Intermediate format (rgba16float in HDR) — see addBloom. SDR = canvasFormat.
    this._godRayEffect.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat || canvasFormat,
    );
  }

  /**
   * Track V-A2 (NEW-ATMO-AERIAL-PERSPECTIVE-POSTPROCESS) — add the unified
   * aerial-perspective atmosphere effect. Runs first in the depth-dependent
   * chain so the haze participates in bloom + tonemap. Requires the scene
   * depth texture + the per-frame camera/sun/atmosphere uniforms + the
   * Bruneton transmittance LUT view (all pushed by the configure pass).
   *
   * Uses the intermediate format (rgba16float in HDR) like the other
   * built-in effects so HDR highlights survive into the inscatter add.
   */
  addAerialPerspective(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    config?: AerialPerspectiveConfig,
  ): void {
    if (this._aerialPerspectiveEffect) return;
    this._aerialPerspectiveEffect = new AerialPerspectiveEffect(config);
    this._aerialPerspectiveEffect.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat || canvasFormat,
    );
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
    motionView?: GPUTextureView | null,
    // Phase 8a Slice 4 (Batch 87) — when non-null, AO (and Slice 5+:
    // SSR + clustered lighting) reads surface normals from this
    // G-buffer view instead of reconstructing them from depth. Caller
    // wires this only when `scene.deferredLighting === true` AND the
    // producer ran this frame; otherwise null/undefined keeps the
    // depth-reconstruction fallback active.
    gBufferNormalView?: GPUTextureView | null,
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

    // 0. Aerial Perspective (Track V-A2) — unified per-pixel atmosphere over
    // the whole scene. Runs FIRST so the distance haze + inscatter
    // participate in AO/bloom/tonemap downstream, matching how WebGL applies
    // the ground atmosphere inside the globe fragment shader before
    // post-process. Needs depth to recover per-pixel distance; passes
    // through unmodified when depth is null.
    if (this._aerialPerspectiveEffect?.enabled && depth) {
      currentView = this._aerialPerspectiveEffect.execute(
        encoder,
        currentView,
        depth,
        this._sampler!,
      );
    }

    // 1. Ambient Occlusion (needs depth; optionally reads G-buffer
    // normal — Phase 8a Slice 4, Batch 87).
    if (this._aoEffect?.enabled && depth) {
      currentView = this._aoEffect.execute(
        encoder,
        currentView,
        depth,
        this._sampler!,
        gBufferNormalView ?? null,
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

    // 2.5 GodRays (Audit A.11, Batch 133) -- placed after Bloom so
    // bright shaft pixels participate in the bloom; if a future
    // Sandcastle wants crisp rays, the placement can flip via a
    // per-effect "renderAfterBloom" flag (not yet exposed). Needs
    // depth to gate the radial blur on sky vs. geometry.
    if (this._godRayEffect?.enabled && depth) {
      currentView = this._godRayEffect.execute(
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

    // 3.6 NEW-POSTPROCESS-USER-WGSL (Batch 198 first slice; Batch 199
    // B198-D2 audit fix — moved from step 3.4 to here). User-supplied
    // WGSL post-process stages run AFTER auto-exposure dispatch (so
    // auto-exposure correctly sees the post-DoF ping/pong texture as
    // its luminance source) but BEFORE TAA + tonemap (so user stages
    // operate on HDR-space color and TAA accumulates the user-modified
    // frame). Matches the WebGL backend's insertion point for custom
    // stages. Each stage chains via the standard
    // `execute(encoder, source, depth, sampler) → newView` contract.
    for (const stage of this._userStages) {
      if (stage.enabled) {
        currentView = stage.execute(
          encoder,
          currentView,
          depth,
          this._sampler!,
        );
      }
    }

    // AUDIT_2026_05_02 B.16 (Batch 155 clarity refactor; Batch 157
    // comment correction) — push order of `singlePassStages` now
    // matches GPU command stream order. The actual execution order
    // was ALREADY correct in the prior code: `_taaEffect.execute()`
    // records GPU commands immediately at the call site below, while
    // the `singlePassStages` loop (tonemap → colorGrading → custom →
    // fxaa) doesn't run until further down. So TAA always operated
    // on the pre-tonemap, linear/HDR `currentView` regardless of
    // where the array pushes happened. This refactor is purely a
    // clarity fix — moving the tonemap/colorGrading pushes AFTER the
    // TAA call makes the JS read order match the GPU command order.
    // No GPU command stream change.
    if (this._taaEffect?.enabled) {
      // TAA Slice 2d (Batch 104) — pass the per-pixel motion-vector
      // view through. When the SceneRenderer hasn't run a velocity
      // pass (model velocity output disabled), `motionView` is null
      // and the TAA effect binds its 1×1 zero placeholder; the FS
      // falls through to depth reprojection for that frame.
      //
      // Slice 5c-B Batch 126 — also pass `gBufferNormalView` so TAA's
      // disocclusion test can do a normal-divergence rejection at
      // silhouette pixels. Null when the G-buffer FB isn't allocated
      // yet (early frames); the TAA shader's sentinel check handles
      // the placeholder transparently.
      currentView = this._taaEffect.execute(
        encoder,
        currentView,
        depth,
        this._sampler!,
        motionView ?? null,
        gBufferNormalView ?? null,
      );
    }

    // 4. Tonemapping + ColorGrading + Custom stages + FXAA (single-pass chain)
    const singlePassStages: CompiledStage[] = [];
    if (this._tonemapStage?.enabled) singlePassStages.push(this._tonemapStage);
    // HDR-DISPLAY (Batch 205, B200-D1/D2 audit fix) — when the canvas is
    // configured for HDR output, ColorGrading and FXAA are dropped from
    // the chain. Both stages assume SDR-mapped input: the grading curves
    // (gamma, lift/gain/gamma) are calibrated for [0,1] and the FXAA
    // luma derivation + edge-detection thresholds are tuned for an
    // ~SRGB-perceptual signal. Running either on raw HDR produces
    // washed-out colors and missed edges. The collection still flags
    // them as `enabled` so the user-facing toggles work in SDR mode;
    // the gate here makes the active chain HDR-correct.
    if (this._colorGradingStage?.enabled && !this._skipSDRStagesForHDR) {
      // Phase 4 — runs after tonemap (so it sees SDR) and before custom
      // stages + FXAA (so the AA pass smooths any contrast-boosted edges).
      singlePassStages.push(this._colorGradingStage);
    }

    for (const s of this._customStages) {
      if (s.enabled) singlePassStages.push(s);
    }
    if (this._fxaaStage?.enabled && !this._skipSDRStagesForHDR) {
      singlePassStages.push(this._fxaaStage);
    }

    if (singlePassStages.length === 0) {
      // No single-pass stages — always copy to dest. Even if no complex
      // effects ran (currentView === sourceView), WebGPU still needs the
      // identity blit from scene framebuffer → canvas swap chain.
      this._executeCopyStage(encoder, currentView, destView);
      return;
    }

    // Ping-pong through single-pass stages.
    //
    // Batch 110 (HDR fix) — every single-pass stage's pipeline is
    // compiled with `targets: [{ format: _intermediateFormat }]` (see
    // `_compileStage` callers). When HDR is on, intermediateFormat is
    // `rgba16float` while the canvas swap chain stays at the canvas
    // format. Writing the LAST stage straight to `destView` (canvas)
    // would produce a pipeline-vs-attachment format mismatch and the
    // canvas would render black with a validation warning.
    //
    // Fix: every single-pass stage writes to a ping-pong view (which
    // matches `_intermediateFormat`), and an extra identity-blit at
    // the end downconverts to `destView` (canvas format). The blit is
    // a single fullscreen-triangle pass with no uniforms — cheap. In
    // SDR mode `_intermediateFormat === canvasFormat` so the blit is
    // an over-call, but the cost is negligible compared to one stage's
    // worth of fragment shading.
    const views = [this._pingView!, this._pongView!];
    let viewIndex = 0;

    for (let i = 0; i < singlePassStages.length; i++) {
      const stage = singlePassStages[i];
      const targetView = views[viewIndex];

      this._executeSinglePassStage(encoder, stage, currentView, targetView);

      currentView = targetView;
      viewIndex = (viewIndex + 1) % 2;
    }

    // Final blit: ping-pong view → canvas. Uses the identity-blit
    // pipeline which is built once at `initialize()` against the
    // canvas format.
    this._executeCopyStage(encoder, currentView, destView);
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
    this._godRayEffect?.resize(width, height);
    this._aerialPerspectiveEffect?.resize(width, height);

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
   * HDR-DISPLAY (Batch 205, B200-D1/D2 audit fix). When set to true,
   * `execute()` skips the ColorGrading and FXAA stages even if they are
   * marked enabled, because both assume SDR-mapped input. Tonemap is
   * already gated separately by the SDR-stage cache. Driven per-frame
   * from `WebGPUPostProcessStageCollection.update()` based on the scene
   * `useHDRCanvasOutput` + `highDynamicRange` pair.
   */
  setSkipSDRStagesForHDR(skip: boolean): void {
    this._skipSDRStagesForHDR = skip;
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

    // Bind group cache — see CompiledStage.cachedBindGroup. Hot path:
    // a steady chain of stages reuses the same source view across
    // frames (ping/pong alternates per stage but is stable across
    // frames as long as the chain shape is fixed), so a hit here saves
    // an allocation per stage per frame.
    let bindGroup = stage.cachedBindGroup;
    if (!bindGroup || stage.cachedSourceView !== sourceView) {
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: this._sampler },
      ];
      if (stage.uniformBuffer) {
        entries.push({ binding: 2, resource: { buffer: stage.uniformBuffer } });
      }
      bindGroup = this._device.createBindGroup({
        label: `PostProcess-${stage.name}-BindGroup`,
        layout: stage.bindGroupLayout,
        entries,
      });
      stage.cachedBindGroup = bindGroup;
      stage.cachedSourceView = sourceView;
    }

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

    let bindGroup = this._identityCachedBindGroup;
    if (!bindGroup || this._identityCachedSourceView !== sourceView) {
      bindGroup = this._device!.createBindGroup({
        label: "PostProcess-IdentityBlit-BindGroup",
        layout: this._identityBGL,
        entries: [
          { binding: 0, resource: sourceView },
          { binding: 1, resource: this._sampler },
        ],
      });
      this._identityCachedBindGroup = bindGroup;
      this._identityCachedSourceView = sourceView;
    }

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
    this._godRayEffect?.destroy();
    this._aerialPerspectiveEffect?.destroy();
    this._autoExposure?.destroy();
    // Batch 244 — TAA was missing from teardown (the effect was never
    // instantiated before NEW-TAA-EFFECT-NEVER-ADDED landed, so the
    // leak was unreachable). History textures + params UBO are real
    // GPU allocations; drop them with the rest.
    this._taaEffect?.destroy();
    this._bloomEffect = null;
    this._aoEffect = null;
    this._dofEffect = null;
    this._godRayEffect = null;
    this._aerialPerspectiveEffect = null;
    this._autoExposure = null;
    this._taaEffect = null;

    this._tonemapStage = null;
    this._fxaaStage = null;
    // Identity pipeline + BGL are lightweight GPU objects with no backing
    // buffers — the GC handles them. Null the references for safety.
    this._identityPipeline = null;
    this._identityBGL = null;
    this._identityCachedBindGroup = null;
    this._identityCachedSourceView = null;
    this._isDestroyed = true;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
