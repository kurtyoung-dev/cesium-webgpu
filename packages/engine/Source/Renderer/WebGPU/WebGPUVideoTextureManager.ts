/**
 * Zero-copy video texture integration using GPUExternalTexture.
 * Imports video frames directly to GPU without CPU-side pixel copies.
 *
 * **STATUS: ORPHANED (2026-05-02 audit C.6).** This module compiles
 * into the bundle but has no consumer — never instantiated, never
 * registered as a feature renderer, never wired through `Material`
 * uploads. Video imagery on WebGPU today goes through
 * `WebGPUImageUpload.ts:114-167` which DOES handle `HTMLVideoElement`
 * via per-frame `copyExternalImageToTexture` (one CPU→GPU copy per
 * frame). The zero-copy `importExternalTexture` path this module
 * was built for is the perf opportunity left on the table.
 *
 * Wiring this in would replace the per-frame copy with `texture_external`
 * binding in the relevant material shaders. ~80 LOC across Material
 * upload + a new BGL slot in `WebGPUEffectsBindGroup` (or material BGL).
 * Worth doing if an actual user shows up with a perf-bound
 * video-on-terrain workload.
 *
 * CesiumJS has video imagery providers that stream video overlays onto
 * terrain. With WebGL, each video frame requires readPixels + texImage2D.
 * With WebGPU's importExternalTexture(), the browser gives the GPU direct
 * access to the video decoder's output — zero copies.
 *
 * Note: GPUExternalTexture is ephemeral — it must be re-imported every frame
 * because the underlying video frame changes. The bind group must also be
 * recreated each frame.
 *
 * In WGSL, external textures use `texture_external` type:
 *   @group(0) @binding(0) var videoTex: texture_external;
 *   @group(0) @binding(1) var videoSampler: sampler;
 *   // Sample: textureLoad(videoTex, coords) or textureSampleBaseClampToEdge(videoTex, sampler, uv)
 *
 * @example
 * const videoMgr = new WebGPUVideoTextureManager(device);
 * const handle = videoMgr.registerVideo(videoElement);
 *
 * // Each frame:
 * videoMgr.updateAll();
 * const bindGroup = videoMgr.getBindGroup(handle, layout, sampler);
 * @module WebGPUVideoTextureManager
 */

/// <reference types="@webgpu/types" />

import { makeBindGroupLayout, Stage } from "./WebGPUBindGroupLayoutHelpers.js";

/**
 * Handle for a registered video source.
 */
export interface VideoTextureHandle {
  /** Unique identifier */
  id: number;
  /** The video element */
  video: HTMLVideoElement;
  /** Current external texture (refreshed each frame) */
  externalTexture: GPUExternalTexture | null;
  /** Whether the video is currently playing */
  isPlaying: boolean;
  /** Whether the handle is valid */
  isValid: boolean;
  /** Optional label */
  label: string;
}

/**
 * Options for registering a video.
 */
export interface VideoRegistrationOptions {
  /** Label for debug */
  label?: string;
  /** Auto-play on registration (default: false) */
  autoPlay?: boolean;
}

/**
 * Statistics for the video texture manager.
 */
export interface VideoTextureStats {
  /** Number of registered videos */
  registeredCount: number;
  /** Number of actively playing videos */
  playingCount: number;
  /** Number of external texture imports this frame */
  importsThisFrame: number;
  /** Total imports across all frames */
  totalImports: number;
}

/**
 * Manages zero-copy video textures via GPUExternalTexture.
 *
 * Each registered video element is imported every frame using
 * `device.importExternalTexture()`. The resulting GPUExternalTexture
 * is ephemeral and must be used within the same frame.
 */
export class WebGPUVideoTextureManager {
  private _device: GPUDevice;
  private _handles: Map<number, VideoTextureHandle> = new Map();
  private _nextId: number = 0;

  // Per-frame stats
  private _importsThisFrame: number = 0;
  private _totalImports: number = 0;

  private _isDestroyed: boolean = false;

  constructor(device: GPUDevice) {
    this._device = device;
  }

  /**
   * Register a video element for GPU texture import.
   *
   * @param video - The HTML video element
   * @param options - Registration options
   * @returns Handle for subsequent operations
   */
  registerVideo(
    video: HTMLVideoElement,
    options: VideoRegistrationOptions = {},
  ): VideoTextureHandle {
    const id = this._nextId++;
    const handle: VideoTextureHandle = {
      id,
      video,
      externalTexture: null,
      isPlaying: !video.paused,
      isValid: true,
      label: options.label ?? `Video ${id}`,
    };

    this._handles.set(id, handle);

    if (options.autoPlay) {
      video.play().catch(() => {
        // Autoplay may be blocked by browser policy
      });
    }

    return handle;
  }

  /**
   * Unregister a video and free resources.
   *
   * @param handle - The video handle
   */
  unregisterVideo(handle: VideoTextureHandle): void {
    handle.isValid = false;
    handle.externalTexture = null;
    this._handles.delete(handle.id);
  }

  /**
   * Update all registered videos — re-import external textures.
   * Must be called once per frame before using any video textures.
   */
  updateAll(): void {
    this._importsThisFrame = 0;

    for (const handle of this._handles.values()) {
      handle.isPlaying = !handle.video.paused;

      // Only import if the video is playing and has data
      if (
        handle.isPlaying &&
        handle.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        try {
          handle.externalTexture = this._device.importExternalTexture({
            source: handle.video,
            label: handle.label,
          });
          this._importsThisFrame++;
          this._totalImports++;
        } catch {
          handle.externalTexture = null;
        }
      } else {
        handle.externalTexture = null;
      }
    }
  }

  /**
   * Import a single video frame (call instead of updateAll for specific videos).
   *
   * @param handle - The video handle
   * @returns The external texture, or null if not available
   */
  importFrame(handle: VideoTextureHandle): GPUExternalTexture | null {
    if (
      !handle.isValid ||
      handle.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return null;
    }

    try {
      handle.externalTexture = this._device.importExternalTexture({
        source: handle.video,
        label: handle.label,
      });
      this._importsThisFrame++;
      this._totalImports++;
      return handle.externalTexture;
    } catch {
      handle.externalTexture = null;
      return null;
    }
  }

  /**
   * Create a bind group for a video texture.
   *
   * The bind group layout must have:
   *   binding 0: { externalTexture: {} }
   *   binding 1: { sampler: {} }
   *
   * @param handle - The video handle (must have valid externalTexture)
   * @param layout - The bind group layout
   * @param sampler - The sampler to use
   * @returns GPUBindGroup or null if video is not available
   */
  createBindGroup(
    handle: VideoTextureHandle,
    layout: GPUBindGroupLayout,
    sampler: GPUSampler,
  ): GPUBindGroup | null {
    if (!handle.externalTexture) return null;

    return this._device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: handle.externalTexture },
        { binding: 1, resource: sampler },
      ],
      label: `${handle.label} Bind Group`,
    });
  }

  /**
   * Create a bind group layout for video textures.
   *
   * @returns GPUBindGroupLayout with external texture + sampler
   */
  createBindGroupLayout(): GPUBindGroupLayout {
    return makeBindGroupLayout(
      this._device,
      "Video Texture Bind Group Layout",
      [
        {
          binding: 0,
          visibility: Stage.FRAGMENT,
          externalTexture: {},
        },
        {
          binding: 1,
          visibility: Stage.FRAGMENT,
          sampler: {},
        },
      ],
    );
  }

  /**
   * Generate WGSL code for sampling a video texture.
   *
   * @param group - Bind group index (default: 0)
   * @returns WGSL code snippet
   */
  static generateVideoSamplingWGSL(group: number = 0): string {
    return `
@group(${group}) @binding(0) var videoTexture: texture_external;
@group(${group}) @binding(1) var videoSampler: sampler;

fn sampleVideo(uv: vec2<f32>) -> vec4<f32> {
  return textureSampleBaseClampToEdge(videoTexture, videoSampler, uv);
}
`.trim();
  }

  /** Get statistics */
  getStats(): VideoTextureStats {
    let playingCount = 0;
    for (const h of this._handles.values()) {
      if (h.isPlaying) playingCount++;
    }
    return {
      registeredCount: this._handles.size,
      playingCount,
      importsThisFrame: this._importsThisFrame,
      totalImports: this._totalImports,
    };
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  destroy(): void {
    if (this._isDestroyed) return;
    for (const handle of this._handles.values()) {
      handle.isValid = false;
      handle.externalTexture = null;
    }
    this._handles.clear();
    this._isDestroyed = true;
  }
}

export default WebGPUVideoTextureManager;
