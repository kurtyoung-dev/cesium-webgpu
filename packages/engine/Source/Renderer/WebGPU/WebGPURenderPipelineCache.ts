/**
 * WebGPU Render Pipeline Cache
 *
 * Manages creation and caching of GPURenderPipeline objects with support for:
 * - Pipeline variants (depth, blend, cull states)
 * - Async pipeline creation
 * - Cache statistics and management
 * - Hot-reloading support
 *
 * @module WebGPURenderPipelineCache
 */

/**
 * Pipeline descriptor for creating render pipelines
 */
export interface WebGPURenderPipelineDescriptor {
  /**
   * Unique name/identifier for this pipeline
   */
  name: string;

  /**
   * Vertex shader module and entry point
   */
  vertex: {
    module: GPUShaderModule;
    entryPoint: string;
    buffers?: GPUVertexBufferLayout[];
  };

  /**
   * Fragment shader module and entry point (optional for depth-only passes)
   */
  fragment?: {
    module: GPUShaderModule;
    entryPoint: string;
    targets: GPUColorTargetState[];
  };

  /**
   * Pipeline layout (bind group layouts)
   */
  layout?: GPUPipelineLayout | "auto";

  /**
   * Primitive topology and culling
   */
  primitive?: GPUPrimitiveState;

  /**
   * Depth and stencil state
   */
  depthStencil?: GPUDepthStencilState;

  /**
   * Multisample state
   */
  multisample?: GPUMultisampleState;
}

/**
 * Pipeline variant configuration
 */
export interface PipelineVariant {
  /**
   * Depth test enabled
   */
  depthTest?: boolean;

  /**
   * Depth write enabled
   */
  depthWrite?: boolean;

  /**
   * Depth compare function
   */
  depthCompare?: GPUCompareFunction;

  /**
   * Cull mode
   */
  cullMode?: GPUCullMode;

  /**
   * Front face winding
   */
  frontFace?: GPUFrontFace;

  /**
   * Blend mode
   */
  blend?: GPUBlendState;

  /**
   * Topology
   */
  topology?: GPUPrimitiveTopology;
}

/**
 * Cache statistics
 */
export interface PipelineCacheStats {
  /**
   * Number of cache hits
   */
  hits: number;

  /**
   * Number of cache misses
   */
  misses: number;

  /**
   * Number of pipelines created
   */
  created: number;

  /**
   * Number of async pipelines pending
   */
  pending: number;

  /**
   * Total pipelines in cache
   */
  size: number;

  /**
   * Cache hit rate (0-1)
   */
  hitRate: number;
}

/**
 * Pipeline cache entry
 */
interface PipelineCacheEntry {
  pipeline: GPURenderPipeline;
  descriptor: WebGPURenderPipelineDescriptor;
  variant: PipelineVariant;
  created: number; // timestamp
}

/**
 * WebGPU Render Pipeline Cache
 *
 * Manages render pipeline creation and caching with support for variants
 */
export class WebGPURenderPipelineCache {
  private device: GPUDevice;
  private cache: Map<string, PipelineCacheEntry>;
  private pendingPipelines: Map<string, Promise<GPURenderPipeline>>;

  // Statistics
  private stats = {
    hits: 0,
    misses: 0,
    created: 0,
    pending: 0,
  };

  /**
   * Create a new pipeline cache
   *
   * @param device - GPUDevice for creating pipelines
   */
  constructor(device: GPUDevice) {
    this.device = device;
    this.cache = new Map();
    this.pendingPipelines = new Map();
  }

  /**
   * Get or create a render pipeline
   *
   * @param descriptor - Pipeline descriptor
   * @param variant - Pipeline variant configuration (optional)
   * @returns Render pipeline (sync if cached, async if needs creation)
   */
  async getPipeline(
    descriptor: WebGPURenderPipelineDescriptor,
    variant?: PipelineVariant,
  ): Promise<GPURenderPipeline> {
    const key = this.generateCacheKey(descriptor, variant);

    // Check cache
    const cached = this.cache.get(key);
    if (cached) {
      this.stats.hits++;
      return cached.pipeline;
    }

    // Check pending
    const pending = this.pendingPipelines.get(key);
    if (pending) {
      return pending;
    }

    // Create new pipeline
    this.stats.misses++;
    const pipelinePromise = this.createPipelineAsync(descriptor, variant);
    this.pendingPipelines.set(key, pipelinePromise);
    this.stats.pending++;

    try {
      const pipeline = await pipelinePromise;

      // Cache it
      this.cache.set(key, {
        pipeline,
        descriptor,
        variant: variant || {},
        created: Date.now(),
      });

      this.stats.created++;
      return pipeline;
    } finally {
      this.pendingPipelines.delete(key);
      this.stats.pending--;
    }
  }

  /**
   * Get a pipeline synchronously (must already be cached)
   *
   * @param descriptor - Pipeline descriptor
   * @param variant - Pipeline variant configuration
   * @returns Render pipeline or undefined if not cached
   */
  getPipelineSync(
    descriptor: WebGPURenderPipelineDescriptor,
    variant?: PipelineVariant,
  ): GPURenderPipeline | undefined {
    const key = this.generateCacheKey(descriptor, variant);
    const cached = this.cache.get(key);

    if (cached) {
      this.stats.hits++;
      return cached.pipeline;
    }

    this.stats.misses++;
    return undefined;
  }

  /**
   * Create a pipeline asynchronously
   *
   * @param descriptor - Pipeline descriptor
   * @param variant - Pipeline variant configuration
   * @returns Promise resolving to render pipeline
   */
  private async createPipelineAsync(
    descriptor: WebGPURenderPipelineDescriptor,
    variant?: PipelineVariant,
  ): Promise<GPURenderPipeline> {
    const pipelineDescriptor = this.buildPipelineDescriptor(
      descriptor,
      variant,
    );

    try {
      // Use async pipeline creation for better performance
      const pipeline =
        await this.device.createRenderPipelineAsync(pipelineDescriptor);
      return pipeline;
    } catch (error) {
      console.error(`Failed to create pipeline "${descriptor.name}":`, error);
      throw error;
    }
  }

  /**
   * Build GPURenderPipelineDescriptor with variants applied
   *
   * @param descriptor - Base pipeline descriptor
   * @param variant - Variant configuration to apply
   * @returns Complete GPURenderPipelineDescriptor
   */
  private buildPipelineDescriptor(
    descriptor: WebGPURenderPipelineDescriptor,
    variant?: PipelineVariant,
  ): GPURenderPipelineDescriptor {
    const result: GPURenderPipelineDescriptor = {
      label: descriptor.name,
      layout: descriptor.layout || "auto",
      vertex: {
        module: descriptor.vertex.module,
        entryPoint: descriptor.vertex.entryPoint,
        buffers: descriptor.vertex.buffers,
      },
    };

    // Fragment shader (optional)
    if (descriptor.fragment) {
      result.fragment = {
        module: descriptor.fragment.module,
        entryPoint: descriptor.fragment.entryPoint,
        targets: descriptor.fragment.targets,
      };
    }

    // Primitive state with variant overrides
    result.primitive = {
      topology:
        variant?.topology || descriptor.primitive?.topology || "triangle-list",
      cullMode:
        variant?.cullMode !== undefined
          ? variant.cullMode
          : descriptor.primitive?.cullMode || "back",
      frontFace: variant?.frontFace || descriptor.primitive?.frontFace || "ccw",
      stripIndexFormat: descriptor.primitive?.stripIndexFormat,
      unclippedDepth: descriptor.primitive?.unclippedDepth,
    };

    // Depth stencil state with variant overrides
    if (descriptor.depthStencil || variant?.depthTest !== undefined) {
      result.depthStencil = {
        format: descriptor.depthStencil?.format || "depth24plus",
        depthWriteEnabled:
          variant?.depthWrite !== undefined
            ? variant.depthWrite
            : (descriptor.depthStencil?.depthWriteEnabled ?? true),
        depthCompare:
          variant?.depthCompare ||
          descriptor.depthStencil?.depthCompare ||
          "less",
        stencilFront: descriptor.depthStencil?.stencilFront,
        stencilBack: descriptor.depthStencil?.stencilBack,
        stencilReadMask: descriptor.depthStencil?.stencilReadMask,
        stencilWriteMask: descriptor.depthStencil?.stencilWriteMask,
        depthBias: descriptor.depthStencil?.depthBias,
        depthBiasSlopeScale: descriptor.depthStencil?.depthBiasSlopeScale,
        depthBiasClamp: descriptor.depthStencil?.depthBiasClamp,
      };
    }

    // Multisample state
    if (descriptor.multisample) {
      result.multisample = descriptor.multisample;
    }

    return result;
  }

  /**
   * Generate cache key from descriptor and variant
   *
   * @param descriptor - Pipeline descriptor
   * @param variant - Variant configuration
   * @returns Cache key string
   */
  private generateCacheKey(
    descriptor: WebGPURenderPipelineDescriptor,
    variant?: PipelineVariant,
  ): string {
    const parts = [descriptor.name];

    if (variant) {
      if (variant.depthTest !== undefined)
        parts.push(`dt:${variant.depthTest}`);
      if (variant.depthWrite !== undefined)
        parts.push(`dw:${variant.depthWrite}`);
      if (variant.depthCompare) parts.push(`dc:${variant.depthCompare}`);
      if (variant.cullMode !== undefined) parts.push(`cm:${variant.cullMode}`);
      if (variant.frontFace) parts.push(`ff:${variant.frontFace}`);
      if (variant.topology) parts.push(`tp:${variant.topology}`);
      if (variant.blend) parts.push(`bl:${JSON.stringify(variant.blend)}`);
    }

    return parts.join("|");
  }

  /**
   * Preload pipelines in batch
   *
   * @param descriptors - Array of pipeline descriptors to preload
   * @param variants - Optional array of variants for each descriptor
   * @returns Promise resolving when all pipelines are created
   */
  async preloadBatch(
    descriptors: WebGPURenderPipelineDescriptor[],
    variants?: PipelineVariant[],
  ): Promise<void> {
    const promises = descriptors.map((desc, i) =>
      this.getPipeline(desc, variants?.[i]),
    );

    await Promise.all(promises);
  }

  /**
   * Get cache statistics
   *
   * @returns Cache statistics
   */
  getStats(): PipelineCacheStats {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? this.stats.hits / total : 0;

    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      created: this.stats.created,
      pending: this.stats.pending,
      size: this.cache.size,
      hitRate,
    };
  }

  /**
   * Clear all cached pipelines
   */
  clear(): void {
    this.cache.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.created = 0;
  }

  /**
   * Remove a specific pipeline from cache
   *
   * @param descriptor - Pipeline descriptor
   * @param variant - Variant configuration
   * @returns True if pipeline was removed
   */
  remove(
    descriptor: WebGPURenderPipelineDescriptor,
    variant?: PipelineVariant,
  ): boolean {
    const key = this.generateCacheKey(descriptor, variant);
    return this.cache.delete(key);
  }

  /**
   * Destroy the cache and release resources
   */
  destroy(): void {
    this.cache.clear();
    this.pendingPipelines.clear();
  }

  /**
   * Get all cached pipeline names
   *
   * @returns Array of pipeline names
   */
  getCachedPipelineNames(): string[] {
    return Array.from(this.cache.values()).map(
      (entry) => entry.descriptor.name,
    );
  }

  /**
   * Check if a pipeline is cached
   *
   * @param descriptor - Pipeline descriptor
   * @param variant - Variant configuration
   * @returns True if pipeline is cached
   */
  has(
    descriptor: WebGPURenderPipelineDescriptor,
    variant?: PipelineVariant,
  ): boolean {
    const key = this.generateCacheKey(descriptor, variant);
    return this.cache.has(key);
  }
}

export default WebGPURenderPipelineCache;
