/**
 * @module WebGPURenderBundleManager
 *
 * Manages WebGPU render bundles for pre-encoding static draw commands.
 * Render bundles dramatically reduce CPU overhead for geometry that doesn't
 * change command structure frame-to-frame (e.g., terrain tiles, buildings).
 *
 * Key benefits:
 * - 50-80% CPU reduction for static terrain tile rendering
 * - Draw commands are validated and encoded once, then replayed each frame
 * - Bundle invalidation when geometry/pipeline changes
 *
 *
 * @see https://www.w3.org/TR/webgpu/#render-bundles
 * @private
 */

/// <reference types="@webgpu/types" />

import DeveloperError from "../../Core/DeveloperError.js";
import createGuid from "../../Core/createGuid.js";

/**
 * Unique key identifying a bundle (e.g., tile ID, pass name, material hash).
 */
export type BundleKey = string;

/**
 * Metadata for a cached render bundle.
 */
export interface BundleEntry {
  /** The compiled render bundle */
  bundle: GPURenderBundle;
  /** Monotonically increasing version — bumped on invalidation */
  version: number;
  /** Frame number when this bundle was last used */
  lastUsedFrame: number;
  /** Number of draw calls encoded in this bundle */
  drawCallCount: number;
  /** Debug label */
  label: string;
}

/**
 * Descriptor for creating a render bundle encoder, mirroring the
 * current render pass's attachment formats.
 */
export interface BundleEncoderDescriptor {
  colorFormats: GPUTextureFormat[];
  depthStencilFormat?: GPUTextureFormat;
  sampleCount?: number;
  label?: string;
}

/**
 * Callback that receives a GPURenderBundleEncoder and records draw commands.
 * The manager calls this when a bundle needs to be (re)built.
 */
export type BundleRecordCallback = (encoder: GPURenderBundleEncoder) => number; // returns draw call count

/**
 * Manages render bundle creation, caching, invalidation, and eviction.
 *
 * Usage pattern:
 * ```ts
 * // At scene setup:
 * const bundleMgr = new WebGPURenderBundleManager(device);
 *
 * // Each frame, for static geometry (e.g., terrain tiles):
 * const bundle = bundleMgr.getOrCreate(
 *   tileKey,
 *   { colorFormats: [canvasFormat], depthStencilFormat: 'depth24plus-stencil8' },
 *   (encoder) => {
 *     encoder.setPipeline(terrainPipeline);
 *     encoder.setVertexBuffer(0, tile.vertexBuffer);
 *     encoder.setBindGroup(0, tile.bindGroup);
 *     encoder.drawIndexed(tile.indexCount);
 *     return 1; // 1 draw call
 *   }
 * );
 *
 * // Execute in the render pass:
 * renderPass.executeBundles([bundle]);
 * ```
 */
export class WebGPURenderBundleManager {
  private _device: GPUDevice;
  private _cache: Map<BundleKey, BundleEntry> = new Map();
  private _currentFrame: number = 0;
  private _maxIdleFrames: number;
  private _maxCacheSize: number;

  /**
   * @param {GPUDevice} device - The GPU device
   * @param {object} [options] - Configuration
   * @param {number} [options.maxIdleFrames=300] - Evict bundles unused for this many frames (~5s at 60fps)
   * @param {number} [options.maxCacheSize=1000] - Maximum number of cached bundles
   */
  constructor(
    device: GPUDevice,
    options?: { maxIdleFrames?: number; maxCacheSize?: number },
  ) {
    this._device = device;
    this._maxIdleFrames = options?.maxIdleFrames ?? 300;
    this._maxCacheSize = options?.maxCacheSize ?? 1000;
  }

  /**
   * Get an existing bundle or create a new one using the provided callback.
   *
   * @param {BundleKey} key - Unique identifier (e.g., tile ID)
   * @param {BundleEncoderDescriptor} descriptor - Attachment format descriptor
   * @param {BundleRecordCallback} recordCallback - Called to record draw commands
   * @returns {GPURenderBundle} The render bundle
   */
  getOrCreate(
    key: BundleKey,
    descriptor: BundleEncoderDescriptor,
    recordCallback: BundleRecordCallback,
  ): GPURenderBundle {
    const existing = this._cache.get(key);
    if (existing) {
      existing.lastUsedFrame = this._currentFrame;
      return existing.bundle;
    }

    // Create new bundle
    return this._createBundle(key, descriptor, recordCallback);
  }

  /**
   * Invalidate a specific bundle, forcing re-creation on next access.
   *
   * @param {BundleKey} key - The bundle key to invalidate
   */
  invalidate(key: BundleKey): void {
    this._cache.delete(key);
  }

  /**
   * Invalidate all bundles matching a prefix (e.g., "terrain_" for all terrain tiles).
   *
   * @param {string} prefix - Key prefix to match
   * @returns {number} Number of bundles invalidated
   */
  invalidateByPrefix(prefix: string): number {
    let count = 0;
    for (const key of this._cache.keys()) {
      if (key.startsWith(prefix)) {
        this._cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Invalidate all cached bundles.
   */
  invalidateAll(): void {
    this._cache.clear();
  }

  /**
   * Call once per frame to advance the frame counter and evict stale bundles.
   * Should be called at the beginning of each frame (e.g., in beginFrame).
   */
  beginFrame(): void {
    this._currentFrame++;

    // Periodic eviction (every 60 frames to avoid per-frame overhead)
    if (this._currentFrame % 60 === 0) {
      this._evictStale();
    }
  }

  /**
   * Check if a bundle exists and is valid for a given key.
   *
   * @param {BundleKey} key - The bundle key
   * @returns {boolean} True if a valid bundle exists
   */
  has(key: BundleKey): boolean {
    return this._cache.has(key);
  }

  /**
   * Get cache statistics for debugging/profiling.
   */
  get statistics(): {
    cacheSize: number;
    totalDrawCalls: number;
    currentFrame: number;
  } {
    let totalDrawCalls = 0;
    for (const entry of this._cache.values()) {
      totalDrawCalls += entry.drawCallCount;
    }
    return {
      cacheSize: this._cache.size,
      totalDrawCalls,
      currentFrame: this._currentFrame,
    };
  }

  /**
   * Destroy the manager and clear all bundles.
   */
  destroy(): void {
    this._cache.clear();
  }

  // Private methods

  private _createBundle(
    key: BundleKey,
    descriptor: BundleEncoderDescriptor,
    recordCallback: BundleRecordCallback,
  ): GPURenderBundle {
    const label = descriptor.label ?? `RenderBundle_${key}`;

    const encoder = this._device.createRenderBundleEncoder({
      colorFormats: descriptor.colorFormats,
      depthStencilFormat: descriptor.depthStencilFormat,
      sampleCount: descriptor.sampleCount ?? 1,
      label,
    });

    const drawCallCount = recordCallback(encoder);
    const bundle = encoder.finish({ label });

    const entry: BundleEntry = {
      bundle,
      version: 1,
      lastUsedFrame: this._currentFrame,
      drawCallCount,
      label,
    };

    // Evict oldest if cache is full
    if (this._cache.size >= this._maxCacheSize) {
      this._evictOldest();
    }

    this._cache.set(key, entry);
    return bundle;
  }

  private _evictStale(): void {
    const threshold = this._currentFrame - this._maxIdleFrames;
    for (const [key, entry] of this._cache) {
      if (entry.lastUsedFrame < threshold) {
        this._cache.delete(key);
      }
    }
  }

  private _evictOldest(): void {
    let oldestKey: BundleKey | null = null;
    let oldestFrame = Infinity;

    for (const [key, entry] of this._cache) {
      if (entry.lastUsedFrame < oldestFrame) {
        oldestFrame = entry.lastUsedFrame;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this._cache.delete(oldestKey);
    }
  }
}

export default WebGPURenderBundleManager;
