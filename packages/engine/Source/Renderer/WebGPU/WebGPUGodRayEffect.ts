/// <reference types="@webgpu/types" />
/**
 * WebGPU GodRayEffect
 *
 * References:
 *   - Kenny Mitchell, "Volumetric Light Scattering as a Post-Process"
 *     (GPU Gems 3) — the radial march the generate pass inherits its
 *     `density`/`decay`/`weight`/`exposure` controls from. The pass is NOT a
 *     radial blur of the scene colour: it marches the pixel→sun chord to
 *     measure VISIBILITY and modulates an isolated sun emitter with it. See
 *     `GodRayGenerate.wgsl` for the law.
 *   - Shota Matsuda, Takram — `three-geospatial` (MIT),
 *     https://github.com/takram-design-engineering/three-geospatial — for
 *     resolving cloud occlusion of the shaft from the cloud march's own
 *     transmittance rather than from scene depth, which a cloud pass that
 *     writes no depth cannot supply. Technique only; no source was copied.
 *
 * @module WebGPUGodRayEffect
 */

import GodRayCompositeWGSL from "../../Shaders/WebGPU/PostProcess/GodRayComposite.js";
import GodRayGenerateWGSL from "../../Shaders/WebGPU/PostProcess/GodRayGenerate.js";
// The f16 variants, selected when `useShaderF16` is set.
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

/** Linear RGB radiance of the isolated sun emitter, in the scene buffer's units. */
export type GodRaySunRadiance = readonly [number, number, number];

export interface GodRayConfig {
  /**
   * Sun position in normalized screen UV space (0..1, y DOWN). The caller
   * updates this per frame via `setSunScreenUV(u, v, usable)` — project the
   * world-space sun position through the current `viewProjection` matrix and
   * convert NDC → UV. Values outside [0,1] are allowed for off-screen suns.
   */
  sunScreenU?: number;
  sunScreenV?: number;
  /** Fraction of the pixel→sun chord the march covers. Default 0.96. */
  density?: number;
  /**
   * Chord falloff control, clamped by the shader to [0.07, 0.999]. Default
   * 0.95. The lower clamp is what keeps the chord quadrature from underflowing
   * to zero in f32 at small sample counts — see `GodRayGenerate.wgsl`. Under
   * the energy law it sets
   * the attenuation profile along the chord — `decay ^ (64 * t)` at path
   * fraction `t` — and, through `weight * exposure / (1 - decay)`, the peak
   * amplitude. It no longer multiplies per SAMPLE, so the profile it describes
   * is the same at every `sampleCount`.
   */
  decay?: number;
  /** Scattering strength. Default 0.5. */
  weight?: number;
  /** Final output gain. Default 0.15. */
  exposure?: number;
  /**
   * Radial samples along the chord (1..128). Default 64. This is a QUALITY
   * control: it changes how finely the occlusion along the chord is resolved,
   * not how bright the shaft is. Before the energy law it was a brightness
   * control — the same uniform input was 1.784x brighter at 128 samples than
   * at 16.
   */
  sampleCount?: number;
  /**
   * Linear RGB radiance of the sun emitter, in the same units as the scene
   * colour buffer the composite adds into — which at this point in the chain
   * is pre-tonemap. Default `[1, 1, 1]`. This is the ONLY source of the
   * shaft's colour; the scene colour along the chord is not read. Calibrating
   * it against a real scene belongs to a capture, not to this default.
   */
  sunRadiance?: GodRaySunRadiance;
  /**
   * Screen-space radius, in UV, of the sun's glow profile `1 / (1 + (d/r)^2)`.
   * Default 0.1 — the reach the Mitchell march had with a bright-pass source
   * and the shipped `density` (`r_sun / (1 - density)` is about 0.10 UV for a
   * 0.53-degree sun under a 60-degree vertical field of view). Larger values
   * spread the shaft further from the sun.
   */
  sunGlowRadius?: number;
  /**
   * Depth fraction above which a sample is considered "sky" and its color
   * leaks through to the ray. Default 0.99 — sample depths > far*0.99
   * contribute; anything closer occludes.
   */
  occlusionFarCutoff?: number;
}

type GodRayAppearanceConfig = Omit<GodRayConfig, "sunScreenU" | "sunScreenV">;

// The type argument is on the `freeze` call rather than on the binding:
// `Object.freeze` infers its return from the object literal BEFORE a binding
// annotation can apply, so an annotated binding would see `sunRadiance` as
// `number[]` and reject it against the readonly triple.
const DEFAULT_APPEARANCE = Object.freeze<Required<GodRayAppearanceConfig>>({
  density: 0.96,
  decay: 0.95,
  weight: 0.5,
  exposure: 0.15,
  sampleCount: 64,
  occlusionFarCutoff: 0.99,
  sunRadiance: [1, 1, 1],
  sunGlowRadius: 0.1,
});
const APPEARANCE_KEYS = Object.keys(DEFAULT_APPEARANCE) as Array<
  keyof GodRayAppearanceConfig
>;

/**
 * Byte ranges of the `GodRayUniforms` struct, and which setter owns each one.
 *
 * Every per-frame setter writes ONLY the bytes it owns, so two setters can
 * never clobber each other's fields. The ranges below are the whole of that
 * contract; `initialize()` is the only full-buffer write, and `resize()`
 * re-enters it.
 *
 * A field that no setter's range covers reaches the GPU exactly once, at init,
 * and then silently freezes — with nothing failing to compile and no WebGPU
 * validation error, because the buffer is simply longer than the ranges
 * written into it. `sunUnusable` is per-frame state, so it carries its own
 * range rather than riding the `sunUV` range it sits 60 bytes away from.
 *
 * Bytes 48-64 (`params2`: sunRadiance.rgb + sunGlowRadius) carry the emitter,
 * which is appearance state and therefore per-frame: it is the `emitter` range
 * below, and `updateConfig` writes it alongside `appearance` because the two
 * halves of the appearance snapshot are not contiguous. They must stay two
 * ranges rather than one 8-64 span, because bytes 32-48 in between belong to
 * `setFrustum`.
 *
 * Byte 64 (`params3.x`: aspect) is the one field with no per-frame range. It
 * is a pure function of the viewport, and the only thing that changes the
 * viewport is `resize()`, which re-enters `initialize()` — the full-buffer
 * write. Anything that becomes settable WITHOUT a resize must gain a range
 * here, or it freezes in exactly the way this table exists to prevent.
 */
export const GOD_RAY_UNIFORM_RANGES = Object.freeze({
  /** `params0.xy` — sun screen UV. Written by `setSunScreenUV`. */
  sunUV: Object.freeze({ offset: 0, size: 8 }),
  /** `params0.zw` + `params1` — appearance. Written by `updateConfig`. */
  appearance: Object.freeze({ offset: 8, size: 24 }),
  /**
   * `params2` — sunRadiance.rgb + sunGlowRadius, the emitter half of the
   * appearance snapshot. Also written by `updateConfig`.
   */
  emitter: Object.freeze({ offset: 48, size: 16 }),
  /** `frustum.xyz` — near, far, logActive. Written by `setFrustum`. */
  frustum: Object.freeze({ offset: 32, size: 12 }),
  /** `params3.y` — the sun-unusable flag. Written by `setSunScreenUV`. */
  sunUnusable: Object.freeze({ offset: 68, size: 4 }),
});

/** Size of the packed struct, in bytes. Five `vec4<f32>`. */
export const GOD_RAY_UNIFORM_BYTE_LENGTH = 80;

/**
 * Write one appearance field, keeping the key and the value type tied.
 *
 * `APPEARANCE_KEYS` is a union, and since the snapshot gained an array-valued
 * field the slot type and the value type are both unions — which TypeScript
 * cannot prove agree at a bare `this._config[key] = value`. Inside a generic
 * the key is a single type parameter, so the same assignment checks.
 *
 * @param {object} target The snapshot to write into.
 * @param {string} key The appearance key.
 * @param {*} value Its new value.
 */
function assignAppearance<K extends keyof GodRayAppearanceConfig>(
  target: Required<GodRayConfig>,
  key: K,
  value: Required<GodRayConfig>[K],
): void {
  target[key] = value;
}

/**
 * Value equality for one appearance field, rather than `!==`.
 *
 * `updateConfig` runs every frame and skips the GPU write when nothing
 * changed. `!==` is an identity test for an array-valued field, so a caller
 * passing a fresh literal each frame — the ordinary way to write
 * `scene.godRayConfig` — would mark the snapshot changed every frame and
 * defeat the skip entirely. For scalar fields this is `!==` with the same
 * result.
 */
function appearanceValueEquals(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return a === b;
}

/**
 * Screen-space "god rays" (volumetric light scattering post-process).
 *
 * Two-pass:
 *   1. `GodRayGenerate` marches from each pixel toward a caller-provided sun
 *      screen UV and measures what fraction of that chord is unobstructed,
 *      from scene depth and the cloud transmittance mask. That fraction
 *      modulates an ISOLATED sun emitter (`sunRadiance` x a screen-space glow
 *      profile). The scene colour along the chord is never read, so the sky's
 *      brightness cannot leak into the shaft.
 *   2. `GodRayComposite` additively blends the ray buffer onto the
 *      original scene color and returns the composited view.
 *
 * The energy law: the chord fraction is a ratio of two quadratures of the same
 * attenuation profile, so it is in [0, 1] at any `sampleCount` and the added
 * radiance is bounded by `sunRadiance * weight * exposure / (1 - decay)` —
 * 1.5 x `sunRadiance` at the shipped defaults, which is the limit the
 * predecessor's unnormalised sum converged to. See `GodRayGenerate.wgsl` for
 * the derivation.
 *
 * Placement in `WebGPUPostProcessPipeline.execute` is step 2.5: after Bloom,
 * before Tonemapping. Rays therefore do NOT participate in the bloom, and the
 * buffer the composite adds into is pre-tonemap (HDR when HDR is on), so
 * `sunRadiance` is a radiance in that buffer's units.
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

  // Set by the pipeline before `initialize()`. False, the default, keeps the
  // f32 path.
  useShaderF16 = false;

  private _device: GPUDevice | null = null;
  private _width = 0;
  private _height = 0;
  private _format: GPUTextureFormat = "bgra8unorm";

  // Intermediate textures — half-res for the generate pass (the chord march)
  // then full-res for the composite that writes the final result.
  private _rayTex: GPUTexture | null = null;
  private _rayView: GPUTextureView | null = null;
  private _outputTex: GPUTexture | null = null;
  private _outputView: GPUTextureView | null = null;

  private _generatePipeline: GPURenderPipeline | null = null;
  private _compositePipeline: GPURenderPipeline | null = null;
  private _generateLayout: GPUBindGroupLayout | null = null;
  private _compositeLayout: GPUBindGroupLayout | null = null;

  private _generateUniforms: GPUBuffer | null = null;

  // Screen-space cloud transmittance. `_cloudTransView` is pushed each frame
  // by the pipeline when both procedural clouds and cloud-aware god rays are
  // enabled; otherwise the generate pass binds `_whiteFallbackView`, a 1×1
  // r8unorm texel of exactly 1.0, which makes the cloud multiply a no-op. Off
  // by default.
  private _cloudTransView: GPUTextureView | null = null;
  private _whiteFallbackTex: GPUTexture | null = null;
  private _whiteFallbackView: GPUTextureView | null = null;

  // Bind-group cache for the two per-frame sites.
  private _bgCache = new WebGPUBindGroupCache();

  // The renderer-wide log-depth flag, threaded per frame alongside near and
  // far as `frustum.z`. The GodRayGenerate fragment stage reverses the
  // log-depth sample before linearizing when `frustum.z >= 0.5`; a zero here
  // leaves the linear path untouched.
  private _logActive = 0.0;

  // `params3.y`. 1 marks this frame's sun as one the shaft cannot be built
  // from — behind the camera, non-finite, or grazing the camera plane. Set by
  // `setSunScreenUV`, which owns its byte range; 0, the default, leaves the
  // effect running.
  private _sunUnusable = 0.0;

  private _config: Required<GodRayConfig>;

  constructor(config: GodRayConfig = {}) {
    this._config = {
      sunScreenU: config.sunScreenU ?? 0.5,
      sunScreenV: config.sunScreenV ?? 0.3,
      ...DEFAULT_APPEARANCE,
    };
    this.updateConfig(config);
  }

  // Configuration is a snapshot: removing an override restores its default.
  // Projection and depth belong to the per-frame setters, not this snapshot.
  updateConfig(config: GodRayAppearanceConfig = {}): void {
    let changed = false;
    for (const key of APPEARANCE_KEYS) {
      const value = config[key] ?? DEFAULT_APPEARANCE[key];
      if (!appearanceValueEquals(this._config[key], value)) {
        assignAppearance(this._config, key, value);
        changed = true;
      }
    }
    if (changed && this._device && this._generateUniforms) {
      const data = this._buildUniformData();
      // The appearance snapshot is NOT contiguous: density/decay/weight/
      // exposure/sampleCount/occlusionFarCutoff sit at bytes 8-32, and the
      // emitter (sunRadiance.rgb + sunGlowRadius) at 48-64. Bytes 32-48 in
      // between are `setFrustum`'s, so one span across both would clobber the
      // frustum every time a config knob moved. Two disjoint writes instead.
      for (const range of [
        GOD_RAY_UNIFORM_RANGES.appearance,
        GOD_RAY_UNIFORM_RANGES.emitter,
      ]) {
        this._device.queue.writeBuffer(
          this._generateUniforms,
          range.offset,
          data.buffer,
          range.offset,
          range.size,
        );
      }
    }
  }

  /**
   * Update the sun's screen-space UV. Call each frame before the effect
   * executes — cheap (two small GPU buffer writes). When the sun is
   * off-screen but still in front of the camera, pass the UV even if outside
   * [0,1]; the shader still produces a directional glow across the visible
   * region.
   *
   * `usable` is the caller's single determination of whether this frame's sun
   * is a sun the shaft can be built from. It is false when the sun is behind
   * the camera, when its projection is not finite, and when it grazes the
   * camera plane closely enough that the projected UV has stopped carrying
   * per-pixel information. It reaches the shader as `params3.y`; the caller
   * also uses it to decide whether the two passes run at all, so a false here
   * normally means the effect is disabled for the frame.
   */
  setSunScreenUV(u: number, v: number, usable: boolean = true): void {
    this._config.sunScreenU = u;
    this._config.sunScreenV = v;
    this._sunUnusable = usable ? 0.0 : 1.0;
    if (this._device && this._generateUniforms) {
      const data = this._buildUniformData();
      // Two disjoint ranges, not one span. `sunUV` is `params0.xy` at bytes
      // 0-8 and `sunUnusable` is `params3.y` at bytes 68-72; a single write
      // covering both would also rewrite the appearance and frustum bytes
      // this setter does not own.
      const uvRange = GOD_RAY_UNIFORM_RANGES.sunUV;
      this._device.queue.writeBuffer(
        this._generateUniforms,
        uvRange.offset,
        data.buffer,
        uvRange.offset,
        uvRange.size,
      );
      const flagRange = GOD_RAY_UNIFORM_RANGES.sunUnusable;
      this._device.queue.writeBuffer(
        this._generateUniforms,
        flagRange.offset,
        data.buffer,
        flagRange.offset,
        flagRange.size,
      );
    }
  }

  /**
   * Push the per-frame screen-space cloud transmittance view — 1 is clear, 0
   * is opaque cloud — produced by the procedural cloud renderer's mask pass.
   * Pass `null` to fall back to the white 1×1 texture, which is the depth-only
   * path. This only swaps the view bound at generate-binding 4, and the
   * bind-group cache re-keys on its identity.
   */
  setCloudTransmittanceView(view: GPUTextureView | null): void {
    this._cloudTransView = view;
  }

  /** Whether cloud-aware attenuation is currently active (a view is set). */
  get cloudAware(): boolean {
    return this._cloudTransView !== null;
  }

  /**
   * Update frustum near/far so depth linearization stays correct. The optional
   * `logActive` flag is packed into `frustum.z`; when omitted, the previous value
   * is retained so existing callers stay byte-identical.
   */
  setFrustum(near: number, far: number, logActive?: boolean): void {
    if (typeof logActive === "boolean") {
      this._logActive = logActive ? 1.0 : 0.0;
    }
    if (!this._device || !this._generateUniforms) return;
    const range = GOD_RAY_UNIFORM_RANGES.frustum;
    const data = this._buildUniformData(near, far);
    this._device.queue.writeBuffer(
      this._generateUniforms,
      range.offset,
      data.buffer,
      range.offset,
      range.size,
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

    // Half-res ray buffer for perf — the chord march is a per-pixel loop over
    // `sampleCount` depth taps, so full-res costs four times as much to
    // resolve a shaft whose own radial profile is smooth at this scale.
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
      // Cloud transmittance, bound to the white fallback when cloud-aware god
      // rays are off, so the multiply is by exactly 1.0.
      texture(4, Stage.FRAGMENT),
    ]);

    // The 1×1 white transmittance fallback: r8unorm 255 decodes to exactly 1.0.
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
    // Texture views change on resize.
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
        // The real cloud transmittance when set, else the white fallback.
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
    // Must match the `GodRayUniforms` struct in GodRayGenerate.wgsl — five
    // vec4s (20 floats / 80 bytes). No trailing pad needed; WebGPU pads the
    // uniform buffer binding up to 256 bytes internally.
    // Byte offsets are the contract in `GOD_RAY_UNIFORM_RANGES`; the setters
    // slice this same array by those offsets, so the order here is
    // load-bearing.
    const radiance = this._config.sunRadiance;
    // The glow is a circle in SCREEN space, so the UV offset is stretched by
    // the viewport aspect before its length is taken. Before `initialize()`
    // there is no viewport; 1 leaves the offset untouched.
    const aspect =
      this._width > 0 && this._height > 0 ? this._width / this._height : 1.0;
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
      // frustum: near, far, logActive (reversed by the FS since SLICEB), _
      near ?? 1.0,
      far ?? 1e8,
      this._logActive,
      0.0,
      // params2: sunRadiance.rgb, sunGlowRadius — appearance state, written
      // per-frame through the `emitter` range at bytes 48-64.
      radiance[0],
      radiance[1],
      radiance[2],
      this._config.sunGlowRadius,
      // params3: aspect, sunUnusable, _, _. `aspect` is init-only and stays
      // correct because `resize()` re-enters `initialize()`; `sunUnusable` is
      // per-frame and owns bytes 68-72.
      aspect,
      this._sunUnusable,
      0.0,
      0.0,
    ]);
  }
}
