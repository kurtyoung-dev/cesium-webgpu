/// <reference types="@webgpu/types" />
/**
 * WebGPU GodRayEffect
 *
 * References:
 *   - Kenny Mitchell, "Volumetric Light Scattering as a Post-Process"
 *     (GPU Gems 3) — the radial-blur formulation the generate pass uses.
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

export interface GodRayConfig {
  /**
   * Sun position in normalized screen UV space (0..1, y DOWN). The caller
   * updates this per frame via `setSunScreenUV(u, v, usable)` — project the
   * world-space sun position through the current `viewProjection` matrix and
   * convert NDC → UV. Values outside [0,1] are allowed for off-screen suns.
   */
  sunScreenU?: number;
  sunScreenV?: number;
  /** Step-size multiplier along the pixel→sun ray. Default 0.96. */
  density?: number;
  /** Per-sample decay factor (0..1). Default 0.95. */
  decay?: number;
  /** Per-sample brightness weight. Default 0.5. */
  weight?: number;
  /** Final output gain. Default 0.15. Tune with the sun disk's HDR level. */
  exposure?: number;
  /** Number of radial samples toward the sun (1..128). Default 64. */
  sampleCount?: number;
  /**
   * Depth fraction above which a sample is considered "sky" and its color
   * leaks through to the ray. Default 0.99 — sample depths > far*0.99
   * contribute; anything closer occludes.
   */
  occlusionFarCutoff?: number;
}

type GodRayAppearanceConfig = Omit<GodRayConfig, "sunScreenU" | "sunScreenV">;

const DEFAULT_APPEARANCE: Required<GodRayAppearanceConfig> = Object.freeze({
  density: 0.96,
  decay: 0.95,
  weight: 0.5,
  exposure: 0.15,
  sampleCount: 64,
  occlusionFarCutoff: 0.99,
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
 * Bytes 48-64 (`params2`: sunRadiance.rgb + sunGlowRadius) and byte 64
 * (`params3.x`: aspect) are RESERVED. They are shader-side fields whose config
 * wiring is not in this batch; they are written at init from the placeholders
 * below, and `aspect` is therefore already correct across a resize. Whoever
 * wires them to `GodRayConfig` MUST also give them a per-frame range here, or
 * they freeze in exactly the way this table exists to prevent.
 */
export const GOD_RAY_UNIFORM_RANGES = Object.freeze({
  /** `params0.xy` — sun screen UV. Written by `setSunScreenUV`. */
  sunUV: Object.freeze({ offset: 0, size: 8 }),
  /** `params0.zw` + `params1` — appearance. Written by `updateConfig`. */
  appearance: Object.freeze({ offset: 8, size: 24 }),
  /** `frustum.xyz` — near, far, logActive. Written by `setFrustum`. */
  frustum: Object.freeze({ offset: 32, size: 12 }),
  /** `params3.y` — the sun-unusable flag. Written by `setSunScreenUV`. */
  sunUnusable: Object.freeze({ offset: 68, size: 4 }),
});

/** Size of the packed struct, in bytes. Five `vec4<f32>`. */
export const GOD_RAY_UNIFORM_BYTE_LENGTH = 80;

// Placeholders for the reserved `params2` slots, matching the defaults the
// shader's own struct documents, so a shader reading them before its config
// wiring lands sees a sane emitter rather than black.
const RESERVED_SUN_RADIANCE = Object.freeze([1.0, 1.0, 1.0]);
const RESERVED_SUN_GLOW_RADIUS = 0.1;

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
 *   1. `GodRayGenerate` radial-blurs the scene color toward a caller-
 *      provided sun screen UV, gated by scene depth (only "sky" samples
 *      contribute so geometry cleanly blocks the shaft).
 *   2. `GodRayComposite` additively blends the ray buffer onto the
 *      original scene color and returns the composited view.
 *
 * Insert after the opaque scene pass but before bloom if you want the
 * shaft to bloom; after bloom if you want crisp rays.
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

  // Intermediate textures — half-res for the generate pass (cheap radial
  // blur) then full-res for the composite that writes the final result.
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
        this._config[key] = value;
        changed = true;
      }
    }
    if (changed && this._device && this._generateUniforms) {
      const range = GOD_RAY_UNIFORM_RANGES.appearance;
      const data = this._buildUniformData();
      this._device.queue.writeBuffer(
        this._generateUniforms,
        range.offset,
        data.buffer,
        range.offset,
        range.size,
      );
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

    // Half-res ray buffer for perf — radial blur at full-res is needlessly
    // expensive and the artefacts are invisible after the composite blur.
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
    // uniform buffer binding up to 256 bytes internally. A binding larger
    // than the struct a shader declares is legal, so the last two vec4s are
    // inert for a shader that stops at `frustum`.
    // Byte offsets are the contract in `GOD_RAY_UNIFORM_RANGES`; the setters
    // slice this same array by those offsets, so the order here is
    // load-bearing.
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
      // params2: sunRadiance.rgb, sunGlowRadius — RESERVED, init-only.
      RESERVED_SUN_RADIANCE[0],
      RESERVED_SUN_RADIANCE[1],
      RESERVED_SUN_RADIANCE[2],
      RESERVED_SUN_GLOW_RADIUS,
      // params3: aspect, sunUnusable, _, _. `aspect` is init-only and stays
      // correct because `resize()` re-enters `initialize()`; `sunUnusable` is
      // per-frame and owns bytes 68-72.
      this._height > 0 ? this._width / this._height : 1.0,
      this._sunUnusable,
      0.0,
      0.0,
    ]);
  }
}
