/// <reference types="@webgpu/types" />
/**
 * WebGPU AerialPerspectiveEffect
 *
 * Track V-A2 (NEW-ATMO-AERIAL-PERSPECTIVE-POSTPROCESS) — a fullscreen
 * post-process pass that applies ONE depth-correct atmosphere over the
 * whole composited scene (terrain, 3D tiles, glTF models, geometry),
 * unifying the per-tile ground-atmosphere drape into a single consistent
 * look. This is the "post-process lighting for the terrain" headline of the
 * Takram `three-geospatial` talk (RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md).
 *
 * Per pixel (see AerialPerspective.wgsl for the math):
 *   - EXTINCTION: scene colour × transmittance(camera→fragment), sampled
 *     from the Bruneton TRANSMITTANCE LUT (Batch 306 — sound, sun-
 *     independent). Distant terrain dims + reddens.
 *   - INSCATTER: + analytic single-scatter sky radiance along the
 *     camera→fragment ray (Rayleigh + Mie, HG phase vs the sun). Computed
 *     in-shader rather than from the single-inscatter LUT, whose Y-up
 *     baked-sun parameterization can't represent the view–sun azimuth
 *     (WebGPUSkyAtmosphereRenderer ENABLE_SKY_INSCATTER_LUT = false).
 *
 * ── Composition with the in-globe ground atmosphere (DECISION) ──
 * This pass is the SINGLE owner of distance haze when active. The in-globe
 * GlobeTerrain.wgsl ground-atmosphere/fog drape would DOUBLE-APPLY if both
 * ran, so the scene gates the in-globe path off while aerial perspective is
 * enabled (`scene.aerialPerspective`). The sky/atmosphere shell + sky pixels
 * are left untouched (the shader skips depth≈far pixels), so the limb and
 * sky colour still come from WebGPUSkyAtmosphereRenderer. Enabling aerial
 * perspective is opt-in via `scene.aerialPerspective = true`; default off
 * keeps the existing per-tile drape and full backwards compatibility.
 *
 * The per-frame camera/sun/atmosphere uniforms + the transmittance LUT view
 * are pushed by the configure pass (WebGPUPostProcessStageCollection) via
 * `setFrameData`, mirroring GodRay's `setSunScreenUV` / `setFrustum`.
 *
 * @module WebGPUAerialPerspectiveEffect
 */

import AerialPerspectiveWGSL from "../../Shaders/WebGPU/PostProcess/AerialPerspective.js";
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

/**
 * Per-frame data the effect needs from the scene, packed into the WGSL
 * `AerialUniforms` block. All matrices are column-major (Cesium convention).
 */
export interface AerialPerspectiveFrameData {
  /** Camera world position (ECEF, relative to ellipsoid centre). */
  cameraPositionWC: [number, number, number];
  /** Ellipsoid inner radius (metres) — max ellipsoid radius. */
  innerRadius: number;
  /** Sun direction in world coordinates (normalized). */
  sunDirectionWC: [number, number, number];
  /** Atmosphere light intensity (matches SkyAtmosphere.atmosphereLightIntensity). */
  lightIntensity: number;
  /** Rayleigh scattering coefficient (per-metre RGB). */
  rayleighCoefficient: [number, number, number];
  /** Rayleigh scale height (metres). */
  rayleighScaleHeight: number;
  /** Mie scattering coefficient (per-metre RGB). */
  mieCoefficient: [number, number, number];
  /** Mie scale height (metres). */
  mieScaleHeight: number;
  /** Mie Henyey-Greenstein anisotropy g. */
  mieAnisotropy: number;
  /** Camera frustum near (metres). */
  near: number;
  /** Camera frustum far (metres). */
  far: number;
  /** Atmosphere shell thickness (metres). */
  atmosphereThickness: number;
  /** Inverse projection (column-major mat4, 16 floats) — recovers eye-space ray. */
  inverseProjection: ArrayLike<number>;
  /**
   * Inverse view (column-major mat4, 16 floats). Only the upper-left 3×3
   * rotation is used (eye→world); the translation column is ignored.
   */
  inverseView: ArrayLike<number>;
}

export interface AerialPerspectiveConfig {
  /** Master haze intensity (0 = off, 1 = full physical). Default 1. */
  intensity?: number;
  /** Inscatter brightness scale. Default 1. */
  inscatterScale?: number;
  /**
   * Sky-depth cutoff fraction: raw depths >= this are treated as sky and
   * skipped (no ground haze on the sky/limb). Default 0.999999 — the
   * log-depth sky sits at the very top of the [0,1] range.
   */
  skyCutoff?: number;
  /**
   * Item 2.2 (ENV-AERIAL-MS, Batch 430). When true, the in-scatter term is
   * sourced from the sun-relative sky-view + multiple-scattering LUTs (the
   * same tables the visible SkyAtmosphere samples) instead of the analytic
   * single-scatter march, so the distance haze matches the visible MS sky.
   * Default false → analytic march (byte-identical parity). Set per-frame by
   * the configure pass from `contextOptions.webgpu.envMapMultiScatter`.
   */
  useMultiScatterLut?: boolean;
}

// Float layout of the WGSL `AerialUniforms` struct (std140-ish, all vec4 +
// two mat4). 6 vec4 (24 floats) + 2×16 mat4 = 56 floats = 224 bytes. WebGPU
// pads the UBO binding up to 256 internally.
const UNIFORM_FLOATS = 56;

export class AerialPerspectiveEffect implements PostProcessEffect {
  readonly name = "AerialPerspective";
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
  private _uniformData = new Float32Array(UNIFORM_FLOATS);

  // The transmittance LUT view (group 0, binding 2). Pushed per-frame by the
  // configure pass. Null until the atmosphere LUTs are first allocated — the
  // effect binds a placeholder so the layout is stable, and `execute` no-ops
  // the haze (passthrough) until a real LUT arrives.
  private _transmittanceView: GPUTextureView | null = null;
  // Item 2.2 (ENV-AERIAL-MS, Batch 430). Sun-relative sky-view + MS LUT views
  // (group 0, bindings 5/6). Pushed per-frame; null until baked → the white
  // placeholder is bound so the layout is stable and (with the flag off) they
  // are never sampled.
  private _skyViewView: GPUTextureView | null = null;
  private _multipleScatterView: GPUTextureView | null = null;
  private _placeholderTex: GPUTexture | null = null;
  private _placeholderView: GPUTextureView | null = null;

  // Cached bind group; invalidated when the source view, depth view, or LUT
  // view changes (per-frame ping/pong rotates the source).
  private _cachedBindGroup: GPUBindGroup | null = null;
  private _cachedSourceView: GPUTextureView | null = null;
  private _cachedDepthView: GPUTextureView | null = null;
  private _cachedLutView: GPUTextureView | null = null;
  private _cachedSkyViewView: GPUTextureView | null = null;
  private _cachedMsView: GPUTextureView | null = null;

  private _config: Required<AerialPerspectiveConfig>;

  constructor(config: AerialPerspectiveConfig = {}) {
    this._config = {
      intensity: config.intensity ?? 1.0,
      inscatterScale: config.inscatterScale ?? 1.0,
      skyCutoff: config.skyCutoff ?? 0.999999,
      useMultiScatterLut: config.useMultiScatterLut ?? false,
    };
  }

  /** Update the master haze intensity at runtime (cheap — next frame's pack). */
  setIntensity(intensity: number): void {
    this._config.intensity = intensity;
  }

  /** Update inscatter brightness scale at runtime. */
  setInscatterScale(scale: number): void {
    this._config.inscatterScale = scale;
  }

  /**
   * Push the transmittance LUT view the effect samples for extinction. The
   * view comes from `WebGPUAtmosphereLUT` (perf manager). Stable for the
   * device lifetime, so the bind-group cache invalidates at most once.
   */
  setTransmittanceView(view: GPUTextureView | null): void {
    this._transmittanceView = view;
  }

  /**
   * Item 2.2 (ENV-AERIAL-MS, Batch 430). Push the sun-relative sky-view + MS
   * LUT views the effect samples for in-scatter when `useMultiScatterLut` is
   * on. Both come from `WebGPUAtmosphereLUT` (perf manager) and are stable for
   * the device lifetime, so the bind-group cache invalidates at most once.
   * Null until the LUTs are baked → the white placeholder is bound.
   */
  setSkyViewView(view: GPUTextureView | null): void {
    this._skyViewView = view;
  }

  setMultipleScatterView(view: GPUTextureView | null): void {
    this._multipleScatterView = view;
  }

  /**
   * Item 2.2. Enable/disable the sky-view-LUT in-scatter source at runtime
   * (cheap — next frame's pack flips `params1.z`). Default false (analytic
   * march, byte-identical parity).
   */
  setUseMultiScatterLut(enabled: boolean): void {
    this._config.useMultiScatterLut = enabled;
  }

  /**
   * Pack the per-frame camera / sun / atmosphere uniforms. Call each frame
   * before `execute`. Mirrors GodRay's per-frame setter — one GPU buffer
   * write.
   */
  setFrameData(d: AerialPerspectiveFrameData): void {
    if (!this._device || !this._uniforms) return;
    const f = this._uniformData;
    let o = 0;
    // cameraPositionWC.xyz + innerRadius
    f[o++] = d.cameraPositionWC[0];
    f[o++] = d.cameraPositionWC[1];
    f[o++] = d.cameraPositionWC[2];
    f[o++] = d.innerRadius;
    // sunDirectionWC.xyz + lightIntensity
    f[o++] = d.sunDirectionWC[0];
    f[o++] = d.sunDirectionWC[1];
    f[o++] = d.sunDirectionWC[2];
    f[o++] = d.lightIntensity;
    // rayleighCoefficient.xyz + rayleighScaleHeight
    f[o++] = d.rayleighCoefficient[0];
    f[o++] = d.rayleighCoefficient[1];
    f[o++] = d.rayleighCoefficient[2];
    f[o++] = d.rayleighScaleHeight;
    // mieCoefficient.xyz + mieScaleHeight
    f[o++] = d.mieCoefficient[0];
    f[o++] = d.mieCoefficient[1];
    f[o++] = d.mieCoefficient[2];
    f[o++] = d.mieScaleHeight;
    // params0: mieAnisotropy, near, far, atmosphereThickness
    f[o++] = d.mieAnisotropy;
    f[o++] = d.near;
    f[o++] = d.far;
    f[o++] = d.atmosphereThickness;
    // params1: intensity, inscatterScale, useMultiScatterLut flag, skyCutoff.
    // Item 2.2 (ENV-AERIAL-MS, Batch 430) — params1.z is the LUT-inscatter
    // gate (replaces the prior unused-reserve=1 slot). 0 (default) → analytic
    // march (byte-identical parity); 1 → sky-view + MS LUT in-scatter.
    f[o++] = this._config.intensity;
    f[o++] = this._config.inscatterScale;
    f[o++] = this._config.useMultiScatterLut ? 1.0 : 0.0;
    f[o++] = this._config.skyCutoff;
    // inverseProjection mat4 (column-major, 16 floats)
    const ip = d.inverseProjection;
    for (let i = 0; i < 16; i++) {
      f[o++] = ip[i];
    }
    // inverseView mat4 (column-major, 16 floats — only the 3×3 rotation used)
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
      "AerialPerspective-Output",
      width,
      height,
      format,
    );
    this._outputView = this._outputTex.createView();

    // 1×1 placeholder transmittance LUT — bound until the real LUT view is
    // pushed. White (1,1,1) so the extinction ratio is 1 (passthrough),
    // never darkening the scene before the atmosphere is ready.
    if (!this._placeholderTex) {
      this._placeholderTex = device.createTexture({
        label: "AerialPerspective-LUT-Placeholder",
        size: { width: 1, height: 1 },
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      // rgba16float white = 0x3C00 per channel (1.0 in half-float).
      const white = new Uint16Array([0x3c00, 0x3c00, 0x3c00, 0x3c00]);
      device.queue.writeTexture(
        { texture: this._placeholderTex },
        white,
        { bytesPerRow: 8 },
        { width: 1, height: 1 },
      );
      this._placeholderView = this._placeholderTex.createView();
    }

    this._layout = makeBindGroupLayout(device, "AerialPerspective-BGL", [
      texture(0, Stage.FRAGMENT), // scene color
      texture(1, Stage.FRAGMENT), // scene depth
      texture(2, Stage.FRAGMENT), // transmittance LUT
      samplerEntry(3, Stage.FRAGMENT),
      uniformBuffer(4, Stage.FRAGMENT),
      // Item 2.2 (ENV-AERIAL-MS, Batch 430) — sun-relative sky-view + MS LUTs.
      // Bound unconditionally (placeholder until baked) so the layout is
      // constant; only sampled when params1.z (useMultiScatterLut) is on.
      texture(5, Stage.FRAGMENT), // sky-view LUT
      texture(6, Stage.FRAGMENT), // multiple-scattering LUT
    ]);

    this._pipeline = createFullscreenPipeline(
      device,
      "AerialPerspective",
      AerialPerspectiveWGSL,
      format,
      this._layout,
    );

    this._uniforms = createUniformBuffer(
      device,
      "AerialPerspective-Uniforms",
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
    this._cachedLutView = null;
    this._cachedSkyViewView = null;
    this._cachedMsView = null;
    this.initialize(this._device, width, height, this._format);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView | null,
    sampler: GPUSampler,
  ): GPUTextureView {
    if (!this._device || !depthView || !this._pipeline || !this._layout) {
      // No depth → can't recover distance; pass through unmodified.
      return sourceView;
    }

    const lutView = this._transmittanceView ?? this._placeholderView;
    if (!lutView) {
      return sourceView;
    }
    // Item 2.2 (ENV-AERIAL-MS) — sky-view + MS LUT views, white placeholder
    // until baked. With params1.z off they are never sampled (parity).
    const skyViewView = this._skyViewView ?? this._placeholderView!;
    const msView = this._multipleScatterView ?? this._placeholderView!;

    if (
      !this._cachedBindGroup ||
      this._cachedSourceView !== sourceView ||
      this._cachedDepthView !== depthView ||
      this._cachedLutView !== lutView ||
      this._cachedSkyViewView !== skyViewView ||
      this._cachedMsView !== msView
    ) {
      this._cachedBindGroup = this._device.createBindGroup({
        label: "AerialPerspective-BG",
        layout: this._layout,
        entries: [
          { binding: 0, resource: sourceView },
          { binding: 1, resource: depthView },
          { binding: 2, resource: lutView },
          { binding: 3, resource: sampler },
          { binding: 4, resource: { buffer: this._uniforms! } },
          { binding: 5, resource: skyViewView },
          { binding: 6, resource: msView },
        ],
      });
      this._cachedSourceView = sourceView;
      this._cachedDepthView = depthView;
      this._cachedLutView = lutView;
      this._cachedSkyViewView = skyViewView;
      this._cachedMsView = msView;
    }

    executePass(
      encoder,
      "AerialPerspective",
      this._pipeline,
      this._cachedBindGroup,
      this._outputView!,
    );

    return this._outputView!;
  }

  destroy(): void {
    this._outputTex?.destroy();
    this._uniforms?.destroy();
    this._placeholderTex?.destroy();
    this._outputTex = null;
    this._outputView = null;
    this._uniforms = null;
    this._placeholderTex = null;
    this._placeholderView = null;
    this._transmittanceView = null;
    this._skyViewView = null;
    this._multipleScatterView = null;
    this._cachedBindGroup = null;
    this._cachedSourceView = null;
    this._cachedDepthView = null;
    this._cachedLutView = null;
    this._cachedSkyViewView = null;
    this._cachedMsView = null;
    this._device = null;
  }
}
