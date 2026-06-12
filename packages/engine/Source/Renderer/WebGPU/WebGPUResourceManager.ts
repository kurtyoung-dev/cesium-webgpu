/**
 * Centralized GPU resource management: sampler caching, bind group layout
 * caching, bind group creation, uniform buffer pooling, general buffer
 * pooling, and texture compression format queries.
 *
 * Extracted from WebGPUContext to keep the main context file focused on
 * frame lifecycle and rendering.
 *
 * @see WebGPUContext
 * @module WebGPUResourceManager
 */

/// <reference types="@webgpu/types" />

// ============================================================================
// Resource Manager
// ============================================================================

/**
 * Manages cached and pooled GPU resources for a WebGPU rendering context.
 *
 * Features:
 * - **Sampler cache**: Deduplicates GPUSampler objects by descriptor
 * - **Bind group layout cache**: Deduplicates GPUBindGroupLayout objects
 * - **Uniform buffer pool**: Reuses 256-byte-aligned uniform buffers
 * - **General buffer pool**: Reuses vertex, index, and storage buffers
 * - **Texture compression queries**: Feature detection for BC, ASTC, ETC2
 *
 * @example
 * const mgr = new WebGPUResourceManager(device);
 * const sampler = mgr.getOrCreateSampler({ magFilter: 'linear' });
 * const ubo = mgr.getUniformBuffer(256);
 * // ... use ubo ...
 * mgr.returnUniformBuffer(ubo);
 */
export class WebGPUResourceManager {
  private _device: GPUDevice | null;

  // Caches
  private _samplerCache: Map<string, GPUSampler> = new Map();
  private _bindGroupLayoutCache: Map<string, GPUBindGroupLayout> = new Map();

  // Pools
  private _uniformBufferPool: GPUBuffer[] = [];
  private _bufferPool: Map<string, GPUBuffer[]> = new Map();

  // Pool limits
  private _maxUniformPoolSize: number;
  private _maxBufferPoolSizePerType: number;

  /**
   * @param device - The GPU device (can be null initially, set later via setDevice)
   * @param maxUniformPoolSize - Maximum number of uniform buffers to keep in pool
   * @param maxBufferPoolSizePerType - Maximum number of general buffers per type
   */
  constructor(
    device: GPUDevice | null = null,
    maxUniformPoolSize: number = 100,
    maxBufferPoolSizePerType: number = 50,
  ) {
    this._device = device;
    this._maxUniformPoolSize = maxUniformPoolSize;
    this._maxBufferPoolSizePerType = maxBufferPoolSizePerType;
  }

  /** Update the device reference (e.g., after device loss recovery) */
  setDevice(device: GPUDevice | null): void {
    this._device = device;
  }

  // ==========================================================================
  // Sampler Cache
  // ==========================================================================

  /**
   * Get or create a cached sampler.
   * @param descriptor - Sampler descriptor
   * @returns The sampler, or null if no device
   */
  getOrCreateSampler(descriptor: GPUSamplerDescriptor): GPUSampler | null {
    if (!this._device) return null;
    const key = JSON.stringify(descriptor);
    let sampler = this._samplerCache.get(key);
    if (!sampler) {
      sampler = this._device.createSampler(descriptor);
      this._samplerCache.set(key, sampler);
    }
    return sampler;
  }

  // ==========================================================================
  // Bind Group Layout Cache
  // ==========================================================================

  /**
   * Get or create a cached bind group layout.
   * @param descriptor - Bind group layout descriptor
   * @returns The layout, or null if no device
   */
  getOrCreateBindGroupLayout(
    descriptor: GPUBindGroupLayoutDescriptor,
  ): GPUBindGroupLayout | null {
    if (!this._device) return null;
    const key = JSON.stringify(descriptor);
    let layout = this._bindGroupLayoutCache.get(key);
    if (!layout) {
      layout = this._device.createBindGroupLayout(descriptor);
      this._bindGroupLayoutCache.set(key, layout);
    }
    return layout;
  }

  // ==========================================================================
  // Bind Group Creation (not cached — they reference mutable buffers)
  // ==========================================================================

  /**
   * Create a bind group.
   * @param descriptor - Bind group descriptor
   * @returns The bind group, or null if no device
   */
  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup | null {
    if (!this._device) return null;
    return this._device.createBindGroup(descriptor);
  }

  // ==========================================================================
  // Uniform Buffer Pool
  // ==========================================================================

  /**
   * Get a uniform buffer from the pool or create a new one.
   * Size is aligned to 256 bytes (WebGPU uniform buffer alignment requirement).
   * @param size - Minimum size in bytes
   * @returns A uniform buffer, or null if no device
   */
  getUniformBuffer(size: number): GPUBuffer | null {
    if (!this._device) return null;
    const alignedSize = Math.ceil(size / 256) * 256;

    // Best-fit search: find smallest buffer that fits without wasting >2x
    const idx = this._uniformBufferPool.findIndex(
      (buf) => buf.size >= alignedSize && buf.size < alignedSize * 2,
    );

    if (idx >= 0) {
      return this._uniformBufferPool.splice(idx, 1)[0];
    }

    return this._device.createBuffer({
      size: alignedSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: `Uniform Buffer (Pooled, ${alignedSize}B)`,
    });
  }

  /**
   * Return a uniform buffer to the pool for reuse.
   * @param buffer - The buffer to return
   */
  returnUniformBuffer(buffer: GPUBuffer): void {
    if (!buffer) return;
    if (this._uniformBufferPool.length < this._maxUniformPoolSize) {
      this._uniformBufferPool.push(buffer);
    } else {
      buffer.destroy();
    }
  }

  // ==========================================================================
  // General Buffer Pool
  // ==========================================================================

  /**
   * Get a buffer from a typed pool or create a new one.
   * @param type - Pool key (e.g. 'vertex', 'index', 'storage')
   * @param size - Minimum size in bytes
   * @param usage - GPUBufferUsage flags
   * @returns A buffer, or null if no device
   */
  getPooledBuffer(
    type: string,
    size: number,
    usage: GPUBufferUsageFlags,
  ): GPUBuffer | null {
    if (!this._device) return null;
    const pool = this._bufferPool.get(type) || [];
    const idx = pool.findIndex(
      (buf) => buf.size >= size && buf.size < size * 2,
    );

    if (idx >= 0) {
      const buf = pool.splice(idx, 1)[0];
      this._bufferPool.set(type, pool);
      return buf;
    }

    return this._device.createBuffer({
      size,
      usage,
      label: `${type} Buffer (Pooled, ${size}B)`,
    });
  }

  /**
   * Return a buffer to a typed pool.
   * @param type - Pool key
   * @param buffer - The buffer to return
   */
  returnPooledBuffer(type: string, buffer: GPUBuffer): void {
    if (!buffer) return;
    const pool = this._bufferPool.get(type) || [];
    if (pool.length < this._maxBufferPoolSizePerType) {
      pool.push(buffer);
      this._bufferPool.set(type, pool);
    } else {
      buffer.destroy();
    }
  }

  // ==========================================================================
  // Staging Buffers
  // ==========================================================================

  /**
   * Create a staging buffer for data upload.
   * @param size - Size in bytes
   * @returns A MAP_WRITE | COPY_SRC buffer, or null if no device
   */
  createStagingBuffer(size: number): GPUBuffer | null {
    if (!this._device) return null;
    return this._device.createBuffer({
      size,
      usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
      label: "Staging Buffer",
    });
  }

  // ==========================================================================
  // Texture Compression Queries
  // ==========================================================================

  /**
   * Check if a texture compression format is supported.
   * @param format - Format name: 'bc7', 'astc', 'etc2'
   * @returns Whether the format is supported
   */
  supportsTextureCompression(format: string): boolean {
    if (!this._device) return false;
    const featureMap: Record<string, GPUFeatureName> = {
      bc7: "texture-compression-bc",
      astc: "texture-compression-astc",
      etc2: "texture-compression-etc2",
    };
    const feature = featureMap[format.toLowerCase()];
    return feature ? this._device.features.has(feature) : false;
  }

  /**
   * Get all supported texture compression format names.
   * @returns Array of format names (e.g. ['bc7', 's3tc', 'astc'])
   */
  getSupportedCompressionFormats(): string[] {
    if (!this._device) return [];
    const formats: string[] = [];
    if (this._device.features.has("texture-compression-bc"))
      formats.push("bc7", "s3tc");
    if (this._device.features.has("texture-compression-astc"))
      formats.push("astc");
    if (this._device.features.has("texture-compression-etc2"))
      formats.push("etc2", "etc");
    return formats;
  }

  // ==========================================================================
  // Cache Statistics
  // ==========================================================================

  /**
   * Get cache/pool size statistics.
   */
  getStatistics(): {
    samplerCacheSize: number;
    bindGroupLayoutCacheSize: number;
    uniformBufferPoolSize: number;
    bufferPoolSizes: Record<string, number>;
  } {
    const bufferPoolSizes: Record<string, number> = {};
    for (const [type, pool] of this._bufferPool) {
      bufferPoolSizes[type] = pool.length;
    }
    return {
      samplerCacheSize: this._samplerCache.size,
      bindGroupLayoutCacheSize: this._bindGroupLayoutCache.size,
      uniformBufferPoolSize: this._uniformBufferPool.length,
      bufferPoolSizes,
    };
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /**
   * Clear all caches and destroy all pooled buffers.
   * Call after device loss recovery or context destruction.
   */
  clearAll(): void {
    this._samplerCache.clear();
    this._bindGroupLayoutCache.clear();

    // Destroy pooled uniform buffers
    for (const buf of this._uniformBufferPool) {
      try {
        buf.destroy();
      } catch {
        /* already destroyed */
      }
    }
    this._uniformBufferPool = [];

    // Destroy pooled general buffers
    for (const [, pool] of this._bufferPool) {
      for (const buf of pool) {
        try {
          buf.destroy();
        } catch {
          /* already destroyed */
        }
      }
    }
    this._bufferPool.clear();
  }
}

export default WebGPUResourceManager;
