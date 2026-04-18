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

  /**
   * Stencil front face operations
   */
  stencilFront?: GPUStencilFaceState;

  /**
   * Stencil back face operations
   */
  stencilBack?: GPUStencilFaceState;

  /**
   * Stencil read mask (0-255)
   */
  stencilReadMask?: number;

  /**
   * Stencil write mask (0-255)
   */
  stencilWriteMask?: number;

  /**
   * Color write mask applied to every color target in the descriptor's
   * `fragment.targets`. WebGPU places `writeMask` on each
   * `GPUColorTargetState` (not on the overall pipeline), but most
   * callers want the same mask across all targets — the WebGL
   * `gl.colorMask(r,g,b,a)` convention that the Proton-style stub
   * tracks. The cache applies this override at pipeline build time
   * via `Object.assign` onto each target.
   *
   * Valid values are 0 (no writes) through 0xF (RGBA all on). Matches
   * `GPUColorWriteFlags` (RED=0x1, GREEN=0x2, BLUE=0x4, ALPHA=0x8).
   */
  colorWriteMask?: GPUColorWriteFlags;
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
  private logPrefix: string;

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
   * @param contextId - Owning context's id for multi-context error attribution
   */
  constructor(device: GPUDevice, contextId?: string) {
    this.device = device;
    this.cache = new Map();
    this.pendingPipelines = new Map();
    this.logPrefix = contextId
      ? `[CesiumJS:webgpu:${contextId}:pipeline-cache]`
      : `[CesiumJS:webgpu:pipeline-cache]`;
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
      console.error(
        `${this.logPrefix} Failed to create pipeline "${descriptor.name}":`,
        error,
      );
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

    // Fragment shader (optional). When the variant specifies a
    // colorWriteMask override (Proton-style WebGL stub path — it
    // accumulates the current gl.colorMask into the state), apply it
    // to each color target in a shallow-cloned targets array so the
    // caller's descriptor isn't mutated. Targets that already have an
    // explicit writeMask keep their own value since pipeline
    // descriptors are the explicit contract — we only fill in targets
    // that omitted the field.
    if (descriptor.fragment) {
      let targets = descriptor.fragment.targets;
      if (variant?.colorWriteMask !== undefined && targets) {
        const mask = variant.colorWriteMask & 0xf;
        targets = targets.map((t) =>
          t && t.writeMask === undefined ? { ...t, writeMask: mask } : t,
        );
      }
      result.fragment = {
        module: descriptor.fragment.module,
        entryPoint: descriptor.fragment.entryPoint,
        targets,
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

    // Depth stencil state with variant overrides. When the variant
    // introduces stencil ops and the descriptor's format is
    // depth-only, auto-upgrade to `depth24plus-stencil8` — otherwise
    // WebGPU validation errors on "stencil ops present but format has
    // no stencil aspect". Matches the behavior of
    // WebGPUPipelineDescriptorBuilder._ensureDepthStencil.
    if (descriptor.depthStencil || variant?.depthTest !== undefined) {
      const hasStencilOps =
        (variant?.stencilFront ??
          descriptor.depthStencil?.stencilFront) !== undefined ||
        (variant?.stencilBack ??
          descriptor.depthStencil?.stencilBack) !== undefined;
      let format = descriptor.depthStencil?.format || "depth24plus";
      if (
        hasStencilOps &&
        (format === "depth24plus" || format === "depth32float")
      ) {
        format = "depth24plus-stencil8";
      }
      result.depthStencil = {
        format,
        depthWriteEnabled:
          variant?.depthWrite !== undefined
            ? variant.depthWrite
            : (descriptor.depthStencil?.depthWriteEnabled ?? true),
        depthCompare:
          variant?.depthCompare ||
          descriptor.depthStencil?.depthCompare ||
          // Default to `less-equal` (not `less`) — at planetary scale,
          // FP32 can project Z to exactly the far plane and `less`
          // would discard those fragments. See WebGPUContext.
          "less-equal",
        stencilFront:
          variant?.stencilFront || descriptor.depthStencil?.stencilFront,
        stencilBack:
          variant?.stencilBack || descriptor.depthStencil?.stencilBack,
        stencilReadMask:
          variant?.stencilReadMask ?? descriptor.depthStencil?.stencilReadMask,
        stencilWriteMask:
          variant?.stencilWriteMask ??
          descriptor.depthStencil?.stencilWriteMask,
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
      if (variant.stencilFront)
        parts.push(`sf:${JSON.stringify(variant.stencilFront)}`);
      if (variant.stencilBack)
        parts.push(`sb:${JSON.stringify(variant.stencilBack)}`);
      if (variant.stencilReadMask !== undefined)
        parts.push(`srm:${variant.stencilReadMask}`);
      if (variant.stencilWriteMask !== undefined)
        parts.push(`swm:${variant.stencilWriteMask}`);
      if (variant.colorWriteMask !== undefined)
        parts.push(`cwm:${variant.colorWriteMask}`);
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
