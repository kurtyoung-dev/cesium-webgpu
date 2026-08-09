/// <reference types="@webgpu/types" />
/**
 * WebGPU ColdOpticsEffect
 *
 * Screen-space sky overlay drawing the 22-degree ice-crystal halo and the
 * sun dogs, or parhelia, around the sun. The cold-optics analogue of the
 * heat-shimmer post-process: the same single-pass shape, one output texture,
 * one pipeline and one bind-group layout, but instead of an animated UV warp
 * it additively draws the halo and parhelia where the per-pixel view ray sits
 * about 22 degrees from the sun, on sky pixels only, faded out when the sun
 * is below the horizon.
 *
 * Mirrors HeatShimmer's bindings — scene colour, depth, sampler, uniforms —
 * and AerialPerspective's per-frame `setFrameData`, carrying the camera world
 * position, sun direction, inverse projection and inverse-view rotation, so
 * the view-ray reconstruction takes the same f32-safe path: rotate an
 * eye-space unit direction to world, and never subtract two Earth-scale world
 * positions.
 *
 * The effect consumes the `scene.coldOpticsEnabled` and
 * `scene.coldOpticsIntensity` flags pushed upstream, which the atmospheric
 * auto-master gates from a sub-freezing temperature; there is no temperature
 * logic in this file.
 *
 * An opt-in `advanced` config flag, carried in `ColdOpticsUniforms.params1.w`
 * and 0 by default, selects the shader's advanced branch, which also draws
 * physically parameterized 22 and 46 degree dispersed halos, an upper tangent
 * arc, and light pillars. It is pushed from `effects.optics.advanced` through
 * the `scene.coldOpticsAdvanced` scene flag, mirroring the intensity path.
 *
 * @module WebGPUColdOpticsEffect
 */

import ColdOpticsWGSL from "../../Shaders/WebGPU/PostProcess/ColdOptics.js";
import {
  makeBindGroupLayout,
  sampler as samplerEntry,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import {
  createFullscreenPipeline,
  createTexture,
  createUniformBuffer,
  executePass,
} from "./WebGPUPostProcessEffects.js";
import type { PostProcessEffect } from "./WebGPUPostProcessEffects.js";

const DEG2RAD = Math.PI / 180.0;

export interface ColdOpticsConfig {
  /** Master halo/parhelia amount (0..N). <=0 -> passthrough. Default 1. */
  intensity?: number;
  /** Halo ring radius in DEGREES. Default 22 (the classic 22 halo). */
  haloRadiusDeg?: number;
  /** Halo ring gaussian width (sigma) in DEGREES. Default 0.8. */
  haloWidthDeg?: number;
  /** Sun-dog horizontal offset in DEGREES. Default 22 (matches the halo). */
  dogRadiusDeg?: number;
  /** Sun-dog angular spread (sigma) in DEGREES. Default 1.6. */
  dogSigmaDeg?: number;
  /**
   * Sky-depth cutoff fraction: raw depths >= this are treated as sky and the
   * optics are drawn there; geometry (depth < cutoff) passes through. Default
   * 0.999999 — the log-depth sky sits at the very top of [0,1].
   */
  skyCutoff?: number;
  /**
   * When false, the default, only the 22-degree halo and the sun dogs render.
   * When true, the shader's advanced branch also draws the physically
   * parameterized 22 and 46 degree dispersed halos, the upper tangent arc,
   * and light pillars. Carried in `ColdOpticsUniforms.params1.w` as 0 or 1.
   */
  advanced?: boolean;
}

/**
 * Per-frame camera / sun data the effect needs from the scene, packed into
 * the WGSL `ColdOpticsUniforms` block. All matrices are column-major (Cesium
 * convention).
 */
export interface ColdOpticsFrameData {
  /** Camera world position (ECEF, relative to ellipsoid centre). */
  cameraPositionWC: [number, number, number];
  /** Ellipsoid inner radius (metres) — kept for parity / future use. */
  innerRadius: number;
  /** Sun direction in world coordinates (normalized). */
  sunDirectionWC: [number, number, number];
  /** Camera frustum near (metres). */
  near: number;
  /** Camera frustum far (metres). */
  far: number;
  /** Inverse projection (column-major mat4, 16 floats) — recovers eye ray. */
  inverseProjection: ArrayLike<number>;
  /** Inverse view (column-major mat4, 16 floats — only the 3x3 rotation used). */
  inverseView: ArrayLike<number>;
}

// Float layout of the WGSL `ColdOpticsUniforms` struct: 4 vec4 (16 floats) +
// 2 mat4 (32 floats) = 48 floats = 192 bytes. WebGPU pads the UBO binding up
// to 256 internally.
const UNIFORM_FLOATS = 48;

/**
 * Screen-space cold-optics (22 halo + sun-dogs). Single fullscreen pass:
 * additively draws the halo/parhelia onto SKY pixels around the sun.
 *
 * Insert in the HDR scene-color chain near the other sky/atmosphere overlays
 * (BEFORE tonemap) so the halo participates in the tone curve.
 *
 * @example
 *   const optics = new ColdOpticsEffect({ intensity: 1.0 });
 *   pipeline.addEffect(optics);
 *   // each frame the configure pass pushes the camera + sun:
 *   optics.setFrameData({ ... });
 */
export class ColdOpticsEffect implements PostProcessEffect {
  readonly name = "ColdOptics";
  enabled = true;

  private _device: GPUDevice | null = null;
  private _width = 0;
  private _height = 0;
  private _format: GPUTextureFormat = "bgra8unorm";

  // Single full-res output texture (no half-res pass).
  private _outputTex: GPUTexture | null = null;
  private _outputView: GPUTextureView | null = null;

  private _pipeline: GPURenderPipeline | null = null;
  private _layout: GPUBindGroupLayout | null = null;
  private _uniforms: GPUBuffer | null = null;
  private _uniformData = new Float32Array(UNIFORM_FLOATS);

  // Cached bind group; invalidated when the source or depth view changes
  // (per-frame ping/pong rotates the source).
  private _cachedBindGroup: GPUBindGroup | null = null;
  private _cachedSourceView: GPUTextureView | null = null;
  private _cachedDepthView: GPUTextureView | null = null;

  private _config: Required<ColdOpticsConfig>;

  constructor(config: ColdOpticsConfig = {}) {
    this._config = {
      intensity: config.intensity ?? 1.0,
      haloRadiusDeg: config.haloRadiusDeg ?? 22.0,
      haloWidthDeg: config.haloWidthDeg ?? 0.8,
      dogRadiusDeg: config.dogRadiusDeg ?? 22.0,
      dogSigmaDeg: config.dogSigmaDeg ?? 1.6,
      skyCutoff: config.skyCutoff ?? 0.999999,
      advanced: config.advanced ?? false,
    };
  }

  /** Update the master halo/parhelia amount at runtime (cheap — next pack). */
  setIntensity(intensity: number): void {
    this._config.intensity = intensity;
  }

  /** Update the look/shape dials at runtime (folded in on the next pack). */
  setConfig(config: ColdOpticsConfig): void {
    if (config.intensity !== undefined)
      this._config.intensity = config.intensity;
    if (config.haloRadiusDeg !== undefined)
      this._config.haloRadiusDeg = config.haloRadiusDeg;
    if (config.haloWidthDeg !== undefined)
      this._config.haloWidthDeg = config.haloWidthDeg;
    if (config.dogRadiusDeg !== undefined)
      this._config.dogRadiusDeg = config.dogRadiusDeg;
    if (config.dogSigmaDeg !== undefined)
      this._config.dogSigmaDeg = config.dogSigmaDeg;
    if (config.skyCutoff !== undefined)
      this._config.skyCutoff = config.skyCutoff;
    if (config.advanced !== undefined) this._config.advanced = config.advanced;
  }

  /**
   * Toggle the COLD-OPTICS-HQ advanced branch at runtime (folded into the next
   * pack). `false` (default) keeps the byte-identical legacy halo + sun-dogs.
   */
  setAdvanced(advanced: boolean): void {
    this._config.advanced = advanced;
  }

  /**
   * Pack the per-frame camera / sun uniforms. Call each frame before
   * `execute`. Mirrors AerialPerspective's `setFrameData` — one GPU buffer
   * write. The intensity + shape dials live in `_config` and are folded in
   * here so a runtime `setIntensity` takes effect on the next frame.
   */
  setFrameData(d: ColdOpticsFrameData): void {
    if (!this._device || !this._uniforms) return;
    const f = this._uniformData;
    let o = 0;
    // cameraPositionWC.xyz + innerRadius
    f[o++] = d.cameraPositionWC[0];
    f[o++] = d.cameraPositionWC[1];
    f[o++] = d.cameraPositionWC[2];
    f[o++] = d.innerRadius;
    // sunDirectionWC.xyz + intensity
    f[o++] = d.sunDirectionWC[0];
    f[o++] = d.sunDirectionWC[1];
    f[o++] = d.sunDirectionWC[2];
    f[o++] = this._config.intensity;
    // params0: haloRadiusRad, haloWidthRad, near, far
    f[o++] = this._config.haloRadiusDeg * DEG2RAD;
    f[o++] = this._config.haloWidthDeg * DEG2RAD;
    f[o++] = d.near;
    f[o++] = d.far;
    // params1: skyCutoff, dogRadiusRad, dogSigmaRad, advanced flag (0/1).
    // `.w` drives the shader's advanced branch; the WGSL never reads it on
    // the default path, so off is bit-stable.
    f[o++] = this._config.skyCutoff;
    f[o++] = this._config.dogRadiusDeg * DEG2RAD;
    f[o++] = this._config.dogSigmaDeg * DEG2RAD;
    f[o++] = this._config.advanced ? 1.0 : 0.0;
    // inverseProjection mat4 (column-major, 16 floats)
    const ip = d.inverseProjection;
    for (let i = 0; i < 16; i++) {
      f[o++] = ip[i];
    }
    // inverseView mat4 (column-major, 16 floats — only the 3x3 rotation used)
    const iv = d.inverseView;
    for (let i = 0; i < 16; i++) {
      f[o++] = iv[i];
    }
    this._device.queue.writeBuffer(
      this._uniforms,
      0,
      f as Float32Array<ArrayBuffer>,
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

    this._outputTex = createTexture(
      device,
      "ColdOptics-Output",
      width,
      height,
      format,
    );
    this._outputView = this._outputTex.createView();

    this._layout = makeBindGroupLayout(device, "ColdOptics-BGL", [
      texture(0, Stage.FRAGMENT), // scene color
      texture(1, Stage.FRAGMENT), // scene depth
      samplerEntry(2, Stage.FRAGMENT),
      uniformBuffer(3, Stage.FRAGMENT),
    ]);

    this._pipeline = createFullscreenPipeline(
      device,
      "ColdOptics",
      ColdOpticsWGSL,
      format,
      this._layout,
    );

    this._uniforms = createUniformBuffer(
      device,
      "ColdOptics-Uniforms",
      this._uniformData,
    );

    // Force bind-group rebuild against the new views.
    this._cachedBindGroup = null;
  }

  resize(width: number, height: number): void {
    if (!this._device || (width === this._width && height === this._height)) {
      return;
    }
    this._outputTex?.destroy();
    this._outputTex = null;
    this._outputView = null;
    this._cachedBindGroup = null;
    this._cachedSourceView = null;
    this._cachedDepthView = null;
    this.initialize(this._device, width, height, this._format);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView | null,
    sampler: GPUSampler,
  ): GPUTextureView {
    // Passthrough when disabled or effectively inert — no pass recorded.
    if (
      !this._device ||
      !this.enabled ||
      this._config.intensity <= 0.001 ||
      !this._pipeline ||
      !this._layout
    ) {
      return sourceView;
    }

    // depthView gates SKY-ONLY drawing; bind the source view as a benign
    // placeholder when null so the layout stays satisfied. With a placeholder
    // the depth read won't pass the sky cutoff, so the optics simply don't
    // draw — the additive contribution is zero and the pass is a copy.
    const depthBinding = depthView ?? sourceView;

    if (
      !this._cachedBindGroup ||
      this._cachedSourceView !== sourceView ||
      this._cachedDepthView !== depthBinding
    ) {
      this._cachedBindGroup = this._device.createBindGroup({
        label: "ColdOptics-BG",
        layout: this._layout,
        entries: [
          { binding: 0, resource: sourceView },
          { binding: 1, resource: depthBinding },
          { binding: 2, resource: sampler },
          { binding: 3, resource: { buffer: this._uniforms! } },
        ],
      });
      this._cachedSourceView = sourceView;
      this._cachedDepthView = depthBinding;
    }

    executePass(
      encoder,
      "ColdOptics",
      this._pipeline,
      this._cachedBindGroup,
      this._outputView!,
    );

    return this._outputView!;
  }

  destroy(): void {
    this._outputTex?.destroy();
    this._uniforms?.destroy();
    this._outputTex = null;
    this._outputView = null;
    this._uniforms = null;
    this._cachedBindGroup = null;
    this._cachedSourceView = null;
    this._cachedDepthView = null;
    this._device = null;
  }
}
