/// <reference types="@webgpu/types" />
/**
 * WebGPU Post-Processing Pipeline
 *
 * Manages a chain of fullscreen post-processing effects. Each stage reads
 * from a source texture and writes to a destination texture (ping-pong pattern).
 *
 * Pipeline execution order:
 * 0. Aerial Perspective (per-pixel atmosphere, depth-gated)
 * 1. Ambient Occlusion (complex multi-pass effect)
 * 2. Bloom + GodRays (complex multi-pass effects)
 * 3. Depth of Field (complex multi-pass effect, depth-gated)
 * 3.5 AutoExposure (compute, feeds Tonemap exposure uniform)
 * 3.7 HeatShimmer + ColdOptics (single-pass overlays, linear/HDR domain)
 * 4. TAA — runs in the linear/HDR domain, before Tonemap. `TAA.wgsl`'s
 *    resolve applies its own reversible tonemap weighting, `tonemapWeight` =
 *    c/(1+luma), the Karis anti-firefly map from [0,∞) to [0,1), before the
 *    neighbourhood-AABB clamp and blend, then `inverseTonemapWeight` =
 *    c/(1-luma) to recover HDR. That weighting is well defined only for
 *    linear input: on already-tonemapped SDR the inverse divides by (1-luma),
 *    which approaches zero and then goes negative as highlights approach
 *    luma = 1, yielding Inf or NaN. The clamp therefore lives in
 *    tonemap-weight space rather than raw HDR, which is why its constants —
 *    3×3 AABB, 0.1 blend, 0.13 normal divergence, 0.1 motion-length gate —
 *    suit linear input as they stand. Resolving after the tonemap would also
 *    double-apply a tone curve and clamp highlights in the 8/16-bit history
 *    that the tonemapper had not yet rolled off. History buffers accordingly
 *    use `_intermediateFormat`, rgba16float under HDR; see addTAA.
 * 5. Tonemapping / HDR (single-pass, mode-selectable operator)
 * 6. User WGSL stages + intercepted library builtins. These run POST-tonemap
 *    to match WebGL's `PostProcessStageCollection.execute()`, which runs the
 *    stages added through `scene.postProcessStages.add(...)` on the tonemapped
 *    SDR output, before FXAA. Under HDR canvas output the tonemap stage is
 *    bypassed and these stages see linear HDR; that mode has no WebGL
 *    counterpart.
 * 7. ColorGrading (single-pass LUT)
 * 8. Custom stages (user-added via addCustomStage)
 * 9. FXAA (single-pass anti-aliasing, always last)
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
// Hand-tuned f16 variant of the tonemapping shader. Selected at compile time
// when the device grants `shader-f16` and the caller passes the f16 source via
// addTonemapping(..., { f16WgslCode }).
import TonemappingF16WGSL from "../../Shaders/WebGPU/PostProcess/Tonemapping_f16.js";
// Color grading LUT post-process. See ColorGrading.wgsl.
import ColorGradingWGSL from "../../Shaders/WebGPU/PostProcess/ColorGrading.js";
import FXAAWGSL from "../../Shaders/WebGPU/PostProcess/FXAA.js";
// Hand-tuned f16 variants for the two single-pass stages `_compileStage`
// compiles directly; the multi-pass effects select their own f16 variants
// through the effect classes' `useShaderF16` flag. Opt-in through the add*
// methods and gated on device `shader-f16`; f32 by default.
import ColorGradingF16WGSL from "../../Shaders/WebGPU/PostProcess/ColorGrading_f16.js";
import FXAAF16WGSL from "../../Shaders/WebGPU/PostProcess/FXAA_f16.js";
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
import { WebGPUMotionBlurEffect } from "./WebGPUMotionBlurEffect.js";
import { WebGPUUserPostProcessStage } from "./WebGPUUserPostProcessStage.js";
// Named PostProcessStageLibrary built-ins — BlackAndWhite, Brightness,
// NightVision, Silhouette, EdgeDetection, LensFlare, DepthView — substituted
// with their WGSL twins.
import {
  WebGPULibraryPostProcessStage,
  getLibraryStageKey,
} from "./WebGPULibraryPostProcessStage.js";
// Pipeline-level GodRay registration.
import { GodRayEffect, type GodRayConfig } from "./WebGPUGodRayEffect.js";
// Pipeline-level SunHalo registration, the WebGPU consumer of
// `scene.sunBloom`; see WebGPUSunHaloEffect.ts.
import {
  SunHaloEffect,
  type SunHaloFrameState,
} from "./WebGPUSunHaloEffect.js";
// The bright-pass glow half of the same chain. Runs before the halo so the
// halo is never bright-passed; see WebGPUSunBloomEffect.ts.
import {
  SunBloomEffect,
  type SunBloomFrameState,
} from "./WebGPUSunBloomEffect.js";
// Pipeline-level HeatShimmer registration. Single-pass animated UV warp;
// mirrors the GodRay touchpoints.
import {
  HeatShimmerEffect,
  type HeatShimmerConfig,
} from "./WebGPUHeatShimmerEffect.js";
// Pipeline-level ColdOptics registration — the 22-degree ice-crystal halo and
// sun dogs. Single-pass sky overlay; mirrors the HeatShimmer touchpoints.
import {
  ColdOpticsEffect,
  type ColdOpticsConfig,
} from "./WebGPUColdOpticsEffect.js";
// Unified per-pixel atmosphere over the whole scene.
import {
  AerialPerspectiveEffect,
  type AerialPerspectiveConfig,
} from "./WebGPUAerialPerspectiveEffect.js";
import {
  WebGPUAutoExposure,
  type AutoExposureConfig,
} from "./WebGPUAutoExposure.js";
// Bind-group cache stats surfaced through
// `WebGPUContext.getRendererStatistics()` and `CesiumDebug.cacheStats()`.
import type { BindGroupCacheStats } from "./WebGPUBindGroupCache.js";
import {
  makeBindGroupLayout,
  uniformBuffer as uniformBuffer_,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import type { WebGPUPassTimestampProvider } from "./WebGPUPerformanceManager.js";

// Re-export effect configs for consumers
export type {
  BloomConfig,
  AmbientOcclusionConfig,
  DepthOfFieldConfig,
  AutoExposureConfig,
  AerialPerspectiveConfig,
  HeatShimmerConfig,
  ColdOpticsConfig,
};

/** Tonemapping operator modes */
export const TonemapMode = Object.freeze({
  REINHARD: 0,
  ACES: 1,
  FILMIC: 2,
  MODIFIED_REINHARD: 3,
  PBR_NEUTRAL: 4,
});

function normalizeTonemapMode(mode: number): number {
  switch (mode) {
    case TonemapMode.REINHARD:
    case TonemapMode.ACES:
    case TonemapMode.FILMIC:
    case TonemapMode.MODIFIED_REINHARD:
    case TonemapMode.PBR_NEUTRAL:
      return mode;
    default:
      return TonemapMode.REINHARD;
  }
}

function normalizeTonemapDitherStrength(strength: number): number {
  return Number.isFinite(strength) ? Math.fround(strength) : 0.0;
}

function normalizeTonemapExposure(exposure: number): number {
  // Compare the value the f32 uniform will actually observe. This treats two
  // JavaScript numbers that quantize to the same GPU value as unchanged and
  // keeps invalid input from publishing NaN/Infinity into the tone curve.
  return Number.isFinite(exposure) ? Math.fround(exposure) : 1.0;
}

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
 *   [4..7]:  temperature, tint, gamma, hdrMode (pipeline-managed —
 *            always packed 0 here; see setHDROutputMode)
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
  u[7] = 0.0; // hdrMode — pipeline-managed, callers overwrite after packing
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
  private readonly _timestampProvider: WebGPUPassTimestampProvider | null;
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

  // Dedicated identity-blit pipeline
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
  // Screen-space solar veiling glare.
  private _sunHaloEffect: SunHaloEffect | null = null;
  private _sunBloomEffect: SunBloomEffect | null = null;
  private _aoEffect: AmbientOcclusionEffect | null = null;
  private _dofEffect: DepthOfFieldEffect | null = null;
  private _taaEffect: WebGPUTAAEffect | null = null;
  // Velocity-buffer motion blur, opt-in through `scene.motionBlur` and off by
  // default. Runs after TAA, so it blurs the resolved colour, but before
  // tonemap, reusing the same MRT velocity view, depth, and current/previous
  // relative-to-eye view-projection that TAA consumes. Sized and formatted
  // against `_intermediateFormat`, so the recreate-reset block drops it.
  private _motionBlurEffect: WebGPUMotionBlurEffect | null = null;
  // User-supplied WGSL fragment-shader stages added through
  // `Scene.postProcessStages.add()`, run as a chain after the built-in stages
  // so user effects operate on the post-bloom/AO/DoF output.
  private _userStages: WebGPUUserPostProcessStage[] = [];
  // Intercepted PostProcessStageLibrary built-ins: WGSL twins of the named
  // GLSL library stages. Built by the configure pass's user-stage scan
  // alongside `_userStages`; their enabled flag and uniforms are synced each
  // frame through `syncLibraryStage`.
  private _libraryStages: WebGPULibraryPostProcessStage[] = [];
  // GodRay (volumetric light scattering) post-process. Activated through
  // `addGodRay` and the configure-pipeline sync; the per-frame sun screen UV
  // arrives through `setSunScreenUV` from the scene-level configure pass.
  private _godRayEffect: GodRayEffect | null = null;
  // HeatShimmer, an animated screen-space UV warp. Activated through
  // `addHeatShimmer` and the configure-pipeline sync; the per-frame
  // elapsed-seconds clock and intensity are pushed by the scene-level
  // configure pass. Sized and formatted against the HDR-aware intermediate
  // format, so the recreate-reset block drops it.
  private _heatShimmerEffect: HeatShimmerEffect | null = null;
  // ColdOptics, the 22-degree ice-crystal halo and sun-dog sky overlay.
  // Activated through `addColdOptics` and the configure-pipeline sync; the
  // per-frame camera, sun and inverse-matrix uniforms are pushed by the
  // scene-level configure pass. Sized and formatted against the HDR-aware
  // intermediate format, so the recreate-reset block drops it.
  private _coldOpticsEffect: ColdOpticsEffect | null = null;
  // Unified per-pixel atmosphere. Runs first in the depth-dependent chain,
  // ahead of AO and bloom, so the haze participates in bloom and tonemap, the
  // way WebGL applies the ground atmosphere in the globe fragment shader
  // before post-process. The per-frame camera, sun and atmosphere uniforms and
  // the transmittance LUT view are pushed by the configure pass.
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
  // Last value actually resident in the GPU tonemap slot. Auto exposure writes
  // an adapted value into the same slot, so the fixed setter must compare
  // against this value rather than only against the user's manual preference.
  private _tonemapUploadedExposure: number = 1.0;
  // The values actually resident in the tonemap uniform buffer. The configure
  // pass calls the setters every frame, so these guards keep an unchanged mode
  // and a default-off dither at zero allocations and zero queue writes.
  private _tonemapUniformMode: number = TonemapMode.REINHARD;
  private _tonemapDitherStrength: number = 0.0;

  // When the canvas is configured for extended-dynamic-range output,
  // tonemapping is skipped so the swap chain receives the raw HDR signal.
  // ColorGrading and FXAA still run, switched into HDR-aware math by an
  // `hdrMode` uniform that puts them in a Reinhard-compressed working space;
  // see the ColorGrading.wgsl and FXAA.wgsl headers. Their SDR-tuned pivots
  // and thresholds misbehave on an unbounded signal, which is what that
  // working space exists to avoid. False, the default, leaves the SDR path
  // bit-for-bit unchanged. Driven per frame by
  // `WebGPUPostProcessStageCollection.update()`.
  private _hdrOutputMode = false;

  private _isDestroyed = false;

  constructor(timestampProvider?: WebGPUPassTimestampProvider) {
    this._timestampProvider = timestampProvider ?? null;
  }

  /**
   * Whether any post-processing stages or effects are enabled.
   */
  get hasActiveStages(): boolean {
    if (this._tonemapStage?.enabled) return true;
    if (this._colorGradingStage?.enabled) return true;
    if (this._fxaaStage?.enabled) return true;
    if (this._taaEffect?.enabled) return true;
    if (this._motionBlurEffect?.enabled) return true;
    if (this._bloomEffect?.enabled) return true;
    if (this._aoEffect?.enabled) return true;
    if (this._dofEffect?.enabled) return true;
    if (this._godRayEffect?.enabled) return true;
    // The halo alone must be able to keep the chain alive: on a default scene
    // with no other effect enabled it is the only stage between the scene
    // framebuffer and the canvas that draws anything.
    if (this._sunHaloEffect?.enabled) return true;
    if (this._sunBloomEffect?.enabled) return true;
    if (this._heatShimmerEffect?.enabled) return true;
    if (this._coldOpticsEffect?.enabled) return true;
    if (this._aerialPerspectiveEffect?.enabled) return true;
    // User-supplied WGSL stages.
    if (this._userStages.some((s) => s.enabled)) return true;
    // Intercepted library built-ins.
    if (this._libraryStages.some((s) => s.enabled)) return true;
    return this._customStages.some((s) => s.enabled);
  }

  get bloomEffect(): BloomEffect | null {
    return this._bloomEffect;
  }

  get sunHaloEffect(): SunHaloEffect | null {
    return this._sunHaloEffect;
  }

  get sunBloomEffect(): SunBloomEffect | null {
    return this._sunBloomEffect;
  }

  get ambientOcclusionEffect(): AmbientOcclusionEffect | null {
    return this._aoEffect;
  }

  get autoExposure(): WebGPUAutoExposure | null {
    return this._autoExposure;
  }

  /**
   * Aggregate the per-effect `WebGPUBindGroupCache` counters — hits, misses
   * and hit rate — for the context debug surface, with `null` for an effect
   * that has not been added to the pipeline. A pure read: the caches already
   * pay for this bookkeeping on their normal lookup path.
   */
  getBindGroupCacheStats(): {
    bloom: BindGroupCacheStats | null;
    ambientOcclusion: BindGroupCacheStats | null;
    autoExposure: BindGroupCacheStats | null;
  } {
    return {
      bloom: this._bloomEffect?.getBindGroupCacheStats() ?? null,
      ambientOcclusion: this._aoEffect?.getBindGroupCacheStats() ?? null,
      autoExposure: this._autoExposure?.getBindGroupCacheStats() ?? null,
    };
  }

  get depthOfFieldEffect(): DepthOfFieldEffect | null {
    return this._dofEffect;
  }

  /** GodRay effect, or null if it has not been added. */
  get godRayEffect(): GodRayEffect | null {
    return this._godRayEffect;
  }

  /**
   * HeatShimmer effect, or null if it has not been added. The configure pass
   * uses this to push the per-frame elapsed-seconds clock and intensity.
   */
  get heatShimmerEffect(): HeatShimmerEffect | null {
    return this._heatShimmerEffect;
  }

  /**
   * ColdOptics effect, or null if it has not been added. The configure pass
   * uses this to push the per-frame camera, sun and inverse-matrix uniforms.
   */
  get coldOpticsEffect(): ColdOpticsEffect | null {
    return this._coldOpticsEffect;
  }

  /**
   * Unified aerial-perspective atmosphere effect, or null if it has not been
   * added. The configure pass uses this to push the per-frame camera, sun and
   * atmosphere uniforms and the transmittance LUT view.
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

    // Reset the built-in effects so the configure path recreates them at the
    // current intermediate format and size. Each is created once — the `addX`
    // methods guard with `if (this._bloomEffect) return` — so without this an
    // HDR toggle or a resize would leave them holding their first-creation
    // 8-bit or wrong-size intermediate textures, which clamps HDR highlights
    // before the tonemap ever sees them. Only runs on a real recreate, meaning
    // a device, size or HDR change, never per frame.
    this._bloomEffect?.destroy();
    this._aoEffect?.destroy();
    this._dofEffect?.destroy();
    this._godRayEffect?.destroy();
    // The halo's output texture is sized and formatted against
    // `_intermediateFormat`, so a resize or HDR toggle must drop it too. The
    // configure pass lazily re-adds it on the same frame when `scene.sunBloom`
    // is on, because its gate checks the live slot.
    this._sunHaloEffect?.destroy();
    this._sunBloomEffect?.destroy();
    // HeatShimmer's output texture is sized and formatted against
    // `_intermediateFormat`, so a resize or HDR toggle must drop it too. The
    // configure pass lazily re-adds it on the same frame when
    // `scene.heatShimmerEnabled` is on, because its gate checks the live slot.
    this._heatShimmerEffect?.destroy();
    // ColdOptics' output texture is sized and formatted against
    // `_intermediateFormat`, so a resize or HDR toggle must drop it too. The
    // configure pass lazily re-adds it on the same frame when
    // `scene.coldOpticsEnabled` is on, because its gate checks the live slot.
    this._coldOpticsEffect?.destroy();
    // The aerial-perspective output texture is sized and formatted against
    // `_intermediateFormat`, so a resize or HDR toggle must drop it too. The
    // configure pass lazily re-adds it on the same frame when
    // `scene.aerialPerspective` is on, because its gate checks the live slot.
    this._aerialPerspectiveEffect?.destroy();
    this._bloomEffect = null;
    this._aoEffect = null;
    this._dofEffect = null;
    this._godRayEffect = null;
    this._sunHaloEffect = null;
    this._sunBloomEffect = null;
    this._heatShimmerEffect = null;
    this._coldOpticsEffect = null;
    this._aerialPerspectiveEffect = null;
    // TAA belongs on the recreate reset list for the same reason: its history
    // textures and pipeline target are sized and formatted against
    // `_intermediateFormat`, so a resize or HDR toggle must drop them too.
    // `WebGPUPostProcessStageCollection` lazily re-adds the effect on the same
    // frame because its gate checks the live `pipeline.taaEffect` slot rather
    // than a sticky cache flag.
    this._taaEffect?.destroy();
    this._taaEffect = null;
    // The output texture is sized + formatted against
    // `_intermediateFormat`, so a resize / HDR toggle must drop it too. The
    // configure pass lazily re-adds it on the same frame (gate checks the
    // live slot).
    this._motionBlurEffect?.destroy();
    this._motionBlurEffect = null;

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
// The blit's inline pow(1/2.2) encode was reverted because it caused
// double-gamma encoding for the FOG /
// SkyAtmosphere / SkyBox / ground-atmosphere paths, which ALREADY
// apply pow(c, 1/2.2) inside the per-pixel shader (see e.g.
// GlobeTerrain.wgsl FOG branch line 2619, SkyAtmosphere.wgsl line 492,
// ModelPBRComplete.wgsl line 928). Fragments rendered through those
// paths got encoded twice → pow(c, 1/4.84) → washed-out / desaturated
// appearance characteristic of double-gamma encoding.
//
// Fragments rendered through paths that DON'T pre-encode (raw imagery
// at orbit altitudes outside the fog/atmosphere drape) stayed dark
// without the blit-side encode, producing the gamma-2.4-darker
// signature expected when the final encode is missing.
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
// Either option requires a coordinated color-space change across every
// canvas-writing pipeline; this identity blit therefore remains a no-op.
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
    const normalizedMode = normalizeTonemapMode(mode);
    const normalizedExposure = normalizeTonemapExposure(exposure);
    // Uniforms: exposure, gamma, mode, whitePoint
    // `whitePoint` defaults to 1.0 to match WebGL's
    // ModifiedReinhardTonemapping `white` uniform (Color.WHITE → (1,1,1));
    // the operator divides by `white` (not white²).
    // Layout: [exposure, gamma, mode, whitePoint, ditherStrength, pad, pad, pad]
    // `ditherStrength` defaults to 0.0, so the tonemap output is unchanged
    // until the caller opts in via `setTonemapDither()`. The three trailing
    // pads keep the UBO 16-byte aligned (32 bytes total).
    const uniforms = new Float32Array([
      normalizedExposure,
      gamma,
      normalizedMode,
      1.0,
      0.0,
      0.0,
      0.0,
      0.0,
    ]);
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
    this._manualExposure = normalizedExposure;
    this._tonemapUploadedExposure = normalizedExposure;
    this._tonemapUniformMode = normalizedMode;
    this._tonemapDitherStrength = 0.0;
  }

  /**
   * Set the tonemapping operator mode at runtime.
   */
  setTonemappingMode(mode: number): void {
    if (!this._tonemapStage?.uniformBuffer || !this._device) return;
    const normalizedMode = normalizeTonemapMode(mode);
    if (this._tonemapUniformMode === normalizedMode) return;
    this._device.queue.writeBuffer(
      this._tonemapStage.uniformBuffer,
      8,
      new Float32Array([normalizedMode]) as Float32Array<ArrayBuffer>,
    );
    this._tonemapUniformMode = normalizedMode;
  }

  /**
   * Update tonemapping exposure.
   */
  setTonemappingExposure(exposure: number): void {
    const normalizedExposure = normalizeTonemapExposure(exposure);
    this._manualExposure = normalizedExposure;
    if (this._tonemapUploadedExposure === normalizedExposure) return;
    this._writeTonemappingExposure(normalizedExposure);
  }

  /**
   * Publish an exposure without applying the fixed/manual dirty gate.
   * Auto-exposure calls this with its genuinely changing adapted value.
   */
  private _writeTonemappingExposure(exposure: number): void {
    if (!this._tonemapStage?.uniformBuffer || !this._device) return;
    const normalizedExposure = normalizeTonemapExposure(exposure);
    this._device.queue.writeBuffer(
      this._tonemapStage.uniformBuffer,
      0,
      new Float32Array([normalizedExposure]) as Float32Array<ArrayBuffer>,
    );
    this._tonemapUploadedExposure = normalizedExposure;
  }

  /**
   * Set the triangular-PDF dither amplitude on the
   * tonemap stage. `strength` is in units of 8-bit LSBs (0 = off / byte-
   * identical, 1 = ±1 LSB peak triangular noise). Writes to the fifth float
   * (byte offset 16) of TonemapUniforms. No-op if the tonemap stage or device
   * is unavailable. Effective in the HDR post-process pipeline (rgba16float
   * intermediates); a documented no-op benefit in the fully-8-bit SDR chain
   * where the scene framebuffer is already quantized before post-process.
   */
  setTonemapDither(strength: number): void {
    if (!this._tonemapStage?.uniformBuffer || !this._device) return;
    const normalizedStrength = normalizeTonemapDitherStrength(strength);
    if (this._tonemapDitherStrength === normalizedStrength) return;
    this._device.queue.writeBuffer(
      this._tonemapStage.uniformBuffer,
      16,
      new Float32Array([normalizedStrength]) as Float32Array<ArrayBuffer>,
    );
    this._tonemapDitherStrength = normalizedStrength;
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
    useShaderF16: boolean = false,
  ): void {
    if (this._colorGradingStage) return;
    const c = config ?? {};
    const uniforms = packColorGradingUniforms(c);
    // Seed the pipeline-managed hdrMode flag (float
    // index 7; the packer always writes 0 there) so a stage added while
    // HDR canvas output is already active starts in HDR-aware mode.
    uniforms[7] = this._hdrOutputMode ? 1.0 : 0.0;
    const stageFormat = this._intermediateFormat || canvasFormat;
    // Pick the f16 variant when opted in; the
    // f32 source is passed as the _compileStage fallback so a driver
    // that rejects the f16 module recovers gracefully. Byte-identical f32
    // path when useShaderF16 is false (fallback arg is undefined).
    this._colorGradingStage = this._compileStage(
      device,
      useShaderF16 ? "ColorGrading (f16)" : "ColorGrading",
      useShaderF16 ? ColorGradingF16WGSL : ColorGradingWGSL,
      stageFormat,
      uniforms,
      useShaderF16 ? ColorGradingWGSL : undefined,
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
    // Preserve the pipeline-managed hdrMode flag
    // (float index 7); the packer writes 0 there and a full-block write
    // must not silently drop the stage out of HDR-aware mode.
    uniforms[7] = this._hdrOutputMode ? 1.0 : 0.0;
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
  addFXAA(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    useShaderF16: boolean = false,
  ): void {
    if (this._fxaaStage) return;
    // Float index 2 is FXAAUniforms.hdrMode. Index 3 is an unread pad carrying
    // the height.
    const texelSize = new Float32Array([
      1.0 / this._width,
      1.0 / this._height,
      this._hdrOutputMode ? 1.0 : 0.0,
      this._height,
    ]);
    const stageFormat = this._intermediateFormat || canvasFormat;
    // Uses the f16 variant with an f32 fallback; f32 is the default.
    this._fxaaStage = this._compileStage(
      device,
      useShaderF16 ? "FXAA (f16)" : "FXAA",
      useShaderF16 ? FXAAF16WGSL : FXAAWGSL,
      stageFormat,
      texelSize,
      useShaderF16 ? FXAAWGSL : undefined,
    );
  }

  // ================================================================
  //  Built-in stages: TAA
  // ================================================================

  /**
   * Add Temporal Anti-Aliasing effect. Runs in the linear/HDR domain
   * BEFORE Tonemap (see the pipeline-order header). Requires sub-pixel
   * jitter on the projection matrix (see WebGPUTAAEffect.computeJitter).
   * Disabled by default and toggled through `scene.taaEnabled`, which drives
   * the lazy-add in `configureWebGPUPostProcessPipeline`. That lazy-add is the
   * only caller: without it the resolve stage never runs.
   */
  addTAA(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
    if (this._taaEffect) {
      return;
    }
    this._taaEffect = new WebGPUTAAEffect();
    // The intermediate format, rgba16float under HDR, for the same reason as
    // the other built-in effects: TAA runs pre-tonemap, so an 8-bit history
    // would clamp HDR highlights before the tonemapper sees them. In SDR this
    // is the canvas format, so the common path is unaffected.
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
  //  Built-in stages: Motion Blur
  // ================================================================

  /**
   * Add velocity-buffer motion blur. WebGPU-only, opt-in via
   * `scene.motionBlur` (default off). Runs in the linear/HDR domain AFTER
   * TAA and BEFORE tonemap. Lazily added by the configure pass on the first
   * `scene.motionBlur` frame (mirrors the TAA lazy-add), so this method is
   * internally idempotent and re-adds transparently after any pipeline
   * recreate that nulls the slot.
   */
  addMotionBlur(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
    if (this._motionBlurEffect) {
      return;
    }
    this._motionBlurEffect = new WebGPUMotionBlurEffect();
    // The intermediate format, rgba16float under HDR, for the same reason as
    // TAA: the effect runs pre-tonemap, so an 8-bit output would clamp HDR
    // highlights.
    this._motionBlurEffect.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat || canvasFormat,
    );
  }

  get motionBlurEffect(): WebGPUMotionBlurEffect | null {
    return this._motionBlurEffect;
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
    useShaderF16: boolean = false,
  ): void {
    if (this._bloomEffect) return;
    this._bloomEffect = new BloomEffect(config);
    // Set the flag before initialize() so _createPipelines
    // compiles the f16 variants. Default false = byte-identical f32.
    this._bloomEffect.useShaderF16 = useShaderF16;
    // Use the intermediate format, rgba16float under HDR, so bloom's
    // bright-pass and blur chain preserves HDR highlights instead of clamping
    // them at 8 bits. In SDR this equals the canvas format.
    this._bloomEffect.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat || canvasFormat,
    );
  }

  /**
   * Add the screen-space solar halo, a single fullscreen pass.
   *
   * Idempotent like the other `add*` methods, and it uses the intermediate
   * format for the same reason bloom does: the halo is additive HDR energy,
   * and clamping it at 8 bits before tonemap flattens its tail.
   */
  addSunHalo(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
    if (this._sunHaloEffect) return;
    this._sunHaloEffect = new SunHaloEffect();
    this._sunHaloEffect.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat || canvasFormat,
    );
  }

  /**
   * Push this frame's resolved halo state (`frameState.sunHalo`). A no-op when
   * the effect has not been added, so callers need no guard.
   */
  setSunHaloFrameState(state: SunHaloFrameState): void {
    this._sunHaloEffect?.setFrameState(state);
  }

  /**
   * Add the sun bright-pass glow (bright pass, two blurs, additive composite).
   *
   * Idempotent like the other `add*` methods, and it uses the intermediate
   * format for the reason bloom and the halo do: the glow is additive HDR
   * energy, and clamping it at 8 bits before tonemap would flatten it.
   */
  addSunBloom(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
    if (this._sunBloomEffect) return;
    this._sunBloomEffect = new SunBloomEffect();
    this._sunBloomEffect.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat || canvasFormat,
    );
  }

  /**
   * Push this frame's resolved glow state (`frameState.sunHalo`, whose
   * bright-pass pair and screen geometry both stages read). No-op when the
   * effect has not been added, so callers need no guard.
   */
  setSunBloomFrameState(state: SunBloomFrameState): void {
    this._sunBloomEffect?.setFrameState(state);
  }

  /**
   * Add ambient occlusion effect (SSAO Generate → Blur → Modulate).
   * Requires depth texture to function.
   */
  addAmbientOcclusion(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    config?: AmbientOcclusionConfig,
    useShaderF16: boolean = false,
  ): void {
    if (this._aoEffect) return;
    this._aoEffect = new AmbientOcclusionEffect(config);
    // Defaults to false for a byte-identical f32 path.
    this._aoEffect.useShaderF16 = useShaderF16;
    // Intermediate format (rgba16float in HDR) — see addBloom. SDR = canvasFormat.
    this._aoEffect.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat || canvasFormat,
    );
  }

  /**
   * Add a user-supplied WGSL post-process stage to the pipeline. The stage is
   * appended to the `_userStages` chain and runs after the built-in stages —
   * Bloom, AO, DoF, GodRay — and after the auto-exposure dispatch, but before
   * TAA and tonemap: the same insertion point the WebGL backend uses for
   * `scene.postProcessStages.add()` stages.
   *
   * The user provides a WGSL fragment shader source (declares
   * `fragmentMain` returning vec4 + bindings per the convention in
   * `WebGPUUserPostProcessStage`'s module doc) and a numeric uniforms
   * map. The stage compiles the user FS, builds a single-bind-group
   * pipeline (source texture + sampler + 64-byte UBO), and renders
   * fullscreen into its own intermediate texture.
   *
   * The stage's intermediate texture uses `_intermediateFormat` — rgba16float
   * in HDR mode, the canvas format in SDR — rather than the caller-passed
   * `canvasFormat`, because allocating it at the canvas format downconverts
   * user-stage output to 8 bits under HDR. `canvasFormat` remains on the API
   * surface for backwards compatibility but does not size the intermediate.
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
    // The HDR-aware `_intermediateFormat` keeps user-stage precision when HDR
    // is on. The `canvasFormat` parameter stays on the API for backwards
    // compatibility but is unused here.
    void canvasFormat;
    const stageFormat = this._intermediateFormat;
    stage.initialize(device, this._width, this._height, stageFormat);
    this._userStages.push(stage);
  }

  /**
   * Drop all user-added WGSL stages. Called by the configure step when the
   * user collection's `_stages` array changes, on either an add or a remove.
   */
  clearUserWGSLStages(): void {
    for (const stage of this._userStages) {
      stage.destroy();
    }
    this._userStages.length = 0;
  }

  /**
   * Add an intercepted PostProcessStageLibrary built-in by its well-known
   * `czm_*` stage name. Returns the created
   * stage, or null when the name isn't a recognized library built-in.
   * Runs in the same chain slot as user WGSL stages (after the built-in
   * multi-pass effects, before TAA + tonemap) — the same insertion point
   * WebGL uses for `scene.postProcessStages.add(...)` stages.
   *
   * The stage's intermediate textures use `_intermediateFormat`
   * (rgba16float in HDR mode) so HDR precision survives, mirroring
   * `addUserWGSLStage`.
   */
  addLibraryStage(
    device: GPUDevice,
    name: string,
  ): WebGPULibraryPostProcessStage | null {
    const key = getLibraryStageKey(name);
    if (key === null) return null;
    const stage = new WebGPULibraryPostProcessStage(name, key);
    stage.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat,
    );
    this._libraryStages.push(stage);
    return stage;
  }

  /**
   * Synchronize one intercepted library stage each frame, matched by its
   * collection-stage name. Push the live enabled flag, the stage's uniform
   * values, and the frame context
   * (czm_frameNumber / czm_pixelRatio equivalents).
   */
  syncLibraryStage(
    name: string,
    enabled: boolean,
    uniforms: Record<string, unknown>,
    frame: import("./WebGPULibraryPostProcessStage.js").LibraryStageFrameContext,
  ): void {
    for (const stage of this._libraryStages) {
      if (stage.name === name) {
        stage.enabled = enabled;
        stage.setUniformValues(uniforms);
        stage.setFrameContext(frame);
        return;
      }
    }
  }

  /**
   * Drop all intercepted library stages.
   * Called by the configure step alongside `clearUserWGSLStages` when the
   * user collection's `_stages` array changes.
   */
  clearLibraryStages(): void {
    for (const stage of this._libraryStages) {
      stage.destroy();
    }
    this._libraryStages.length = 0;
  }

  /**
   * Add depth-of-field effect (GaussianBlur → DoF Composite).
   * Requires depth texture to function.
   */
  addDepthOfField(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    config?: DepthOfFieldConfig,
    useShaderF16: boolean = false,
  ): void {
    if (this._dofEffect) return;
    this._dofEffect = new DepthOfFieldEffect(config);
    // Defaults to false for a byte-identical f32 path.
    this._dofEffect.useShaderF16 = useShaderF16;
    // Intermediate format (rgba16float in HDR) — see addBloom. SDR = canvasFormat.
    this._dofEffect.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat || canvasFormat,
    );
  }

  /**
   * Add the GodRay effect: a radial blur toward the sun, then a composite.
   * Two passes, a half-resolution ray generate followed by a full-resolution
   * composite. The caller feeds the per-frame sun screen UV through
   * `pipeline.godRayEffect.setSunScreenUV(u, v)`, which the
   * `WebGPUPostProcessStageCollection` configure path does when the scene has
   * a sun configured. A depth texture is required: the generate pass uses
   * depth as its sky-versus-geometry gate.
   */
  addGodRay(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    config?: GodRayConfig,
    useShaderF16: boolean = false,
  ): void {
    if (this._godRayEffect) return;
    this._godRayEffect = new GodRayEffect(config);
    // False, the default, keeps the f32 shader.
    this._godRayEffect.useShaderF16 = useShaderF16;
    // Intermediate format, rgba16float under HDR; see addBloom. In SDR this is
    // the canvas format.
    this._godRayEffect.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat || canvasFormat,
    );
  }

  /**
   * Add the HeatShimmer effect, a single-pass animated UV warp. The configure
   * pass pushes the per-frame elapsed-seconds clock through
   * `pipeline.heatShimmerEffect.setTime(...)` and the intensity through
   * `setIntensity(...)`. Depth is optional, since the warp is depth-independent
   * by default, and the effect tolerates a null depth view.
   */
  addHeatShimmer(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    config?: HeatShimmerConfig,
  ): void {
    if (this._heatShimmerEffect) return;
    this._heatShimmerEffect = new HeatShimmerEffect(config);
    // Intermediate format, rgba16float under HDR; see addBloom. In SDR this is
    // the canvas format.
    this._heatShimmerEffect.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat || canvasFormat,
    );
  }

  /**
   * Add the ColdOptics effect, a single-pass 22-degree halo and sun-dog sky
   * overlay. The configure pass pushes the per-frame camera, sun and
   * inverse-matrix uniforms through
   * `pipeline.coldOpticsEffect.setFrameData(...)`. Depth gates the draw to sky
   * pixels; a null depth view is tolerated and the optics simply do not draw.
   */
  addColdOptics(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    config?: ColdOpticsConfig,
  ): void {
    if (this._coldOpticsEffect) return;
    this._coldOpticsEffect = new ColdOpticsEffect(config);
    // Intermediate format, rgba16float under HDR; see addBloom. In SDR this is
    // the canvas format.
    this._coldOpticsEffect.initialize(
      device,
      this._width,
      this._height,
      this._intermediateFormat || canvasFormat,
    );
  }

  /**
   * Add the unified aerial-perspective atmosphere effect. Runs first in the
   * depth-dependent chain so the haze participates in bloom and tonemap. It
   * needs the scene depth texture, the per-frame camera, sun and atmosphere
   * uniforms, and the Bruneton transmittance LUT view, all pushed by the
   * configure pass.
   *
   * Uses the intermediate format, rgba16float under HDR, like the other
   * built-in effects, so HDR highlights survive into the inscatter add.
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
    // When non-null, AO — and the SSR and clustered-lighting paths that share
    // it — reads surface normals from this G-buffer view instead of
    // reconstructing them from depth. The caller wires it only when
    // `scene.deferredLighting === true` and the producer ran this frame;
    // null or undefined keeps the depth-reconstruction fallback active.
    gBufferNormalView?: GPUTextureView | null,
  ): void {
    // Store the scene color texture for auto-exposure dispatch.
    // When sourceTexture is provided, auto-exposure can dispatch its
    // compute passes against the raw scene framebuffer.
    if (sourceTexture) {
      this._lastSceneColorTexture = sourceTexture;
    }
    // Permanent sentinel: catch null views, which would otherwise produce a
    // black canvas with no error message at all. Deliberately not debug-only,
    // because a null view here always means broken output.
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

    // 0. Aerial Perspective — unified per-pixel atmosphere over the whole
    // scene. Runs first so the distance haze and inscatter participate in AO,
    // bloom and tonemap downstream, matching how WebGL applies the ground
    // atmosphere inside the globe fragment shader before post-process. Needs
    // depth to recover per-pixel distance, and passes through unmodified when
    // depth is null.
    if (this._aerialPerspectiveEffect?.enabled && depth) {
      currentView = this._aerialPerspectiveEffect.execute(
        encoder,
        currentView,
        depth,
        this._sampler!,
      );
    }

    // 0.4 SunBloom — the bright-pass glow around the Sun. Runs BEFORE the
    // halo, mirroring the WebGL chain, where the halo is the last stage of
    // `SunPostProcess` precisely so it is never fed back into the bright pass.
    // The two terms are then separable: the glow is the display's response to
    // the scene's supra-white luminance, the halo is scattering inside the
    // observer's optics, and neither reads the other's output. The effect
    // self-skips (returns `sourceView` untouched) while the Sun's projected
    // geometry is unusable.
    if (this._sunBloomEffect?.enabled) {
      currentView = this._sunBloomEffect.execute(
        encoder,
        currentView,
        depth,
        this._sampler!,
        this._timestampProvider ?? undefined,
      );
    }

    // 0.5 SunHalo — screen-space solar veiling glare.
    // Runs BEFORE AO/bloom/tonemap, mirroring WebGL, where `SunPostProcess`
    // executes during environment rendering and copies into the scene
    // framebuffer, so everything downstream sees the halo. Needs no depth:
    // veiling glare is scattering inside the observer's optics and is
    // deliberately not occluded by scene geometry. The effect self-skips
    // (returns `sourceView` untouched) when its amplitude is exactly 0, so
    // an eclipsed or disabled halo costs one branch, not a pass.
    if (this._sunHaloEffect?.enabled) {
      currentView = this._sunHaloEffect.execute(
        encoder,
        currentView,
        depth,
        this._sampler!,
      );
    }

    // 1. Ambient Occlusion. Needs depth, and optionally reads the G-buffer
    // normal.
    if (this._aoEffect?.enabled && depth) {
      currentView = this._aoEffect.execute(
        encoder,
        currentView,
        depth,
        this._sampler!,
        gBufferNormalView ?? null,
        this._timestampProvider ?? undefined,
      );
    }

    // 2. Bloom
    if (this._bloomEffect?.enabled) {
      currentView = this._bloomEffect.execute(
        encoder,
        currentView,
        depth,
        this._sampler!,
        this._timestampProvider ?? undefined,
      );
    }

    // 2.5 GodRays, placed after Bloom so bright shaft pixels participate in
    // the bloom. Needs depth to gate the radial blur on sky versus geometry.
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
        this._timestampProvider ?? undefined,
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
        this._autoExposure.dispatch(
          encoder,
          sceneColorTexture,
          this._timestampProvider ?? undefined,
        );

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
          this._writeTonemappingExposure(adaptedExposure);
        }
      }
    }

    // 3.7 HeatShimmer, an animated screen-space UV warp. Placed after aerial
    // perspective, AO, bloom, godray and DoF but before TAA and tonemap, so
    // the warp lives in the HDR scene colour and participates in temporal AA
    // and the tone curve. A warp applied post-tonemap would shimmer the SDR
    // signal and miss TAA accumulation entirely. Depth is passed through but
    // tolerated as null: the warp is depth-independent unless the depth fade
    // is configured.
    if (this._heatShimmerEffect?.enabled) {
      currentView = this._heatShimmerEffect.execute(
        encoder,
        currentView,
        depth,
        this._sampler!,
      );
    }

    // 3.8 ColdOptics, the 22-degree ice-crystal halo and sun-dog sky overlay.
    // Placed alongside the other sky and atmosphere overlays, after aerial
    // perspective and heat shimmer but before TAA and tonemap, so the additive
    // halo lives in the HDR scene colour and participates in temporal AA and
    // the tone curve. Reads depth to draw only on sky pixels, letting geometry
    // pass through, and tolerates a null depth view.
    if (this._coldOpticsEffect?.enabled) {
      currentView = this._coldOpticsEffect.execute(
        encoder,
        currentView,
        depth,
        this._sampler!,
      );
    }

    // TAA executes here, before the tonemap at step 4, so it always operates
    // on the pre-tonemap linear `currentView`. TAA's internal reversible Karis
    // tonemap weighting requires linear input; the module docstring carries
    // the full argument.
    if (this._taaEffect?.enabled) {
      // The per-pixel motion-vector view is passed through. When the scene
      // renderer has not run a velocity pass, because model velocity output is
      // disabled, `motionView` is null and the TAA effect binds its 1×1 zero
      // placeholder, so the fragment stage falls through to depth reprojection
      // for that frame.
      //
      // `gBufferNormalView` lets TAA's disocclusion test reject on normal
      // divergence at silhouette pixels. It is null until the G-buffer
      // framebuffer is allocated, and the TAA shader's sentinel check handles
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

    // 3.9 Velocity-buffer motion blur. Runs after TAA so it smears the
    // temporally-resolved colour, and before tonemap so the depth texture's
    // projection stays consistent with the effect's unproject. Needs depth;
    // when depth is null or the effect is inert, with `intensity <= 0`, it
    // passes `currentView` through unchanged and records no pass. Reuses the
    // same `motionView` MRT velocity that TAA consumes.
    if (this._motionBlurEffect?.enabled && depth) {
      currentView = this._motionBlurEffect.execute(
        encoder,
        currentView,
        depth,
        this._sampler!,
        motionView ?? null,
      );
    }

    // 4. Tonemapping → user/library stages → ColorGrading + Custom + FXAA.
    //
    // The tail order matches WebGL's `PostProcessStageCollection.execute()`:
    // ao/bloom, then autoExposure, then tonemap, then the added stages, then
    // FXAA. Tonemap therefore executes first — when it is enabled, meaning an
    // HDR render to an SDR canvas — so user and library stages receive the
    // tonemapped SDR frame exactly as they do on WebGL. Running them ahead of
    // the tonemap instead would hand them unbounded linear colour, which
    // diverges from WebGL under HDR.
    //
    // Ping-pong bookkeeping spans the whole tail: `viewIndex` alternates
    // ping/pong across tonemap + the ColorGrading/custom/FXAA chain.
    // User/library stages own their output textures, so they don't
    // consume a ping-pong slot (no read/write hazard either way).
    //
    // Every single-pass stage's pipeline is compiled with
    // `targets: [{ format: _intermediateFormat }]`; see the `_compileStage`
    // callers. Under HDR that format is `rgba16float` while the canvas swap
    // chain stays at the canvas format, so writing the last stage straight to
    // `destView` would mismatch pipeline against attachment and render a black
    // canvas with a validation warning.
    //
    // Instead every single-pass stage writes to a ping-pong view, which
    // matches `_intermediateFormat`, and a final identity blit downconverts to
    // `destView`. The blit is one fullscreen-triangle pass with no uniforms.
    // In SDR `_intermediateFormat === canvasFormat`, so the blit is redundant
    // there, at a cost far below one stage's worth of fragment shading.
    const views = [this._pingView!, this._pongView!];
    let viewIndex = 0;

    if (this._tonemapStage?.enabled) {
      const targetView = views[viewIndex];
      this._executeSinglePassStage(
        encoder,
        this._tonemapStage,
        currentView,
        targetView,
      );
      currentView = targetView;
      viewIndex = (viewIndex + 1) % 2;
    }

    // 4.1 User-supplied WGSL post-process stages run after tonemap and before
    // ColorGrading and FXAA, matching the WebGL backend's insertion point for
    // `scene.postProcessStages.add(...)` stages, where
    // `PostProcessStageCollection.execute` runs `_stages` on the tonemapped
    // output ahead of FXAA. Each stage chains through the standard
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

    // 4.2 Intercepted PostProcessStageLibrary built-ins: the BlackAndWhite,
    // Brightness, NightVision, Silhouette, EdgeDetection, LensFlare and
    // DepthView WGSL twins. Same chain slot as the user WGSL stages,
    // post-tonemap and pre-FXAA, matching WebGL's insertion point for
    // `scene.postProcessStages.add(...)` stages. The depth-dependent ones —
    // DepthView, EdgeDetection, Silhouette — pass through unchanged when the
    // sampleable depth copy is unavailable.
    for (const stage of this._libraryStages) {
      if (stage.enabled) {
        currentView = stage.execute(
          encoder,
          currentView,
          depth,
          this._sampler!,
        );
      }
    }

    // 4.3 ColorGrading + Custom stages + FXAA (single-pass chain)
    const singlePassStages: CompiledStage[] = [];
    // ColorGrading and FXAA stay in the chain under HDR canvas output:
    // `setHDROutputMode()` flips each stage's `hdrMode` uniform so the shaders
    // switch to a Reinhard-compressed working space, where the grading pivots
    // and the FXAA edge luma operate on [0, 1) again while the output stays
    // linear HDR. Without that switch their SDR-calibrated pivots and
    // thresholds misbehave on a raw HDR signal. Tonemap remains bypassed; that
    // gate lives in the collection's enabled sync.
    if (this._colorGradingStage?.enabled) {
      // Runs after tonemap, so it sees SDR, and before the custom stages and
      // FXAA, so the AA pass smooths any contrast-boosted edges.
      singlePassStages.push(this._colorGradingStage);
    }

    for (const s of this._customStages) {
      if (s.enabled) singlePassStages.push(s);
    }
    if (this._fxaaStage?.enabled) {
      singlePassStages.push(this._fxaaStage);
    }

    for (let i = 0; i < singlePassStages.length; i++) {
      const stage = singlePassStages[i];
      const targetView = views[viewIndex];

      this._executeSinglePassStage(encoder, stage, currentView, targetView);

      currentView = targetView;
      viewIndex = (viewIndex + 1) % 2;
    }

    // Final blit: ping-pong view → canvas. Uses the identity-blit
    // pipeline which is built once at `initialize()` against the
    // canvas format. Runs unconditionally — even when nothing past the
    // `hasActiveStages` guard executed, WebGPU still needs the identity
    // blit from the scene framebuffer to the canvas swap chain.
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
    this._sunHaloEffect?.resize(width, height);
    this._sunBloomEffect?.resize(width, height);
    this._heatShimmerEffect?.resize(width, height);
    this._coldOpticsEffect?.resize(width, height);
    this._aerialPerspectiveEffect?.resize(width, height);
    this._motionBlurEffect?.resize(width, height);
    // Intercepted library built-ins own their
    // output (and silhouette-edge) intermediates; realloc on resize.
    for (const stage of this._libraryStages) {
      stage.resize(width, height);
    }

    // Update FXAA texel size (index 2 = hdrMode — preserve it across the
    // full-block resize write).
    if (this._fxaaStage?.uniformBuffer && this._device) {
      const texelSize = new Float32Array([
        1.0 / width,
        1.0 / height,
        this._hdrOutputMode ? 1.0 : 0.0,
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
    } else if (name === "MotionBlur" && this._motionBlurEffect) {
      this._motionBlurEffect.enabled = enabled;
    } else if (name === "Bloom" && this._bloomEffect) {
      this._bloomEffect.enabled = enabled;
    } else if (name === "AmbientOcclusion" && this._aoEffect) {
      this._aoEffect.enabled = enabled;
    } else if (name === "DepthOfField" && this._dofEffect) {
      this._dofEffect.enabled = enabled;
    } else if (name === "SunHalo" && this._sunHaloEffect) {
      this._sunHaloEffect.enabled = enabled;
    } else if (name === "SunBloom" && this._sunBloomEffect) {
      this._sunBloomEffect.enabled = enabled;
    } else {
      const stage = this._customStages.find((s) => s.name === name);
      if (stage) stage.enabled = enabled;
    }
  }

  /**
   * Switch ColorGrading and FXAA between their SDR and HDR math.
   *
   * When true — HDR canvas output active, tonemap bypassed — both stages keep
   * running but read the `hdrMode` uniform each shader carries, putting them
   * in a Reinhard-compressed working space; see the WGSL headers. When false,
   * the default, the uniform is 0 and both run the SDR path bit-for-bit.
   * Tonemap is gated separately by the collection's enabled sync. Driven per
   * frame from `WebGPUPostProcessStageCollection.update()` off the scene's
   * `useHDRCanvasOutput` and `highDynamicRange` pair.
   */
  setHDROutputMode(enabled: boolean): void {
    if (this._hdrOutputMode === enabled) return;
    this._hdrOutputMode = enabled;
    if (!this._device) return;
    const mode = new Float32Array([enabled ? 1.0 : 0.0]);
    // ColorGradingUniforms.hdrMode — float index 7 (byte offset 28).
    if (this._colorGradingStage?.uniformBuffer) {
      this._device.queue.writeBuffer(
        this._colorGradingStage.uniformBuffer,
        28,
        mode as Float32Array<ArrayBuffer>,
      );
    }
    // FXAAUniforms.hdrMode — float index 2 (byte offset 8).
    if (this._fxaaStage?.uniformBuffer) {
      this._device.queue.writeBuffer(
        this._fxaaStage.uniformBuffer,
        8,
        mode as Float32Array<ArrayBuffer>,
      );
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

    const descriptor: GPURenderPassDescriptor = {
      label: `PostProcess-${stage.name}-Pass`,
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    };
    const pass = encoder.beginRenderPass(
      this._timestampProvider?.withRenderPassTimestamps(descriptor) ??
        descriptor,
    );
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

    const descriptor: GPURenderPassDescriptor = {
      label: "PostProcess-IdentityBlit",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    };
    const pass = encoder.beginRenderPass(
      this._timestampProvider?.withRenderPassTimestamps(descriptor) ??
        descriptor,
    );

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
    this._sunHaloEffect?.destroy();
    this._sunBloomEffect?.destroy();
    this._heatShimmerEffect?.destroy();
    this._coldOpticsEffect?.destroy();
    this._aerialPerspectiveEffect?.destroy();
    this._autoExposure?.destroy();
    // TAA's history textures and params uniform buffer are real GPU
    // allocations, so they are dropped with the rest.
    this._taaEffect?.destroy();
    this._motionBlurEffect?.destroy();
    // Library-stage intermediates and uniform buffers.
    this.clearLibraryStages();
    this._bloomEffect = null;
    this._aoEffect = null;
    this._dofEffect = null;
    this._godRayEffect = null;
    this._sunHaloEffect = null;
    this._sunBloomEffect = null;
    this._heatShimmerEffect = null;
    this._coldOpticsEffect = null;
    this._aerialPerspectiveEffect = null;
    this._autoExposure = null;
    this._taaEffect = null;
    this._motionBlurEffect = null;

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
