/**
 * WebGPU Compute Pipeline Cache
 *
 * Manages creation and caching of `GPUComputePipeline` objects with
 * support for:
 *   - Sync hit-check + async pipeline creation (`createComputePipelineAsync`)
 *   - Cross-renderer dedup of identical (shaderModule, entryPoint, layout)
 *     tuples, mirroring the `WebGPURenderPipelineCache` pattern from
 *     Batches 33-34 / 56 / 62 / 72-75
 *   - Cache statistics
 *   - Device-loss invalidation
 *
 * # Cache key
 *
 * Compute pipelines are identified by `(name, layout signature, entry
 * point)`. Unlike render pipelines, compute pipelines have no fragment
 * targets, vertex layout, multisample count, or depth-stencil — the
 * identity surface is much narrower. We hash:
 *
 *   - `descriptor.name` (caller-supplied label, e.g.
 *     `"VolumetricFog_DensityPipeline"`). Required.
 *   - `descriptor.compute.entryPoint` — different entry points always
 *     get different pipelines.
 *   - `descriptor.layout` identity — two pipelines with the same shader
 *     module + entry point but different `GPUPipelineLayout`s must
 *     materialize separately. We use `Object.is` identity rather than
 *     a structural hash because `GPUPipelineLayout` has no structural
 *     introspection API; the caller is responsible for not creating
 *     redundant layout objects.
 *
 * # Adoption
 *
 * Compute pipeline consumers in CesiumJS WebGPU as of Batch 76:
 *   - WebGPUWeatherRenderer — reset/update/emit (3 pipelines)
 *   - WebGPUVolumetricFogRenderer — density/scattering/integrate (3 pipelines)
 *   - WebGPUAutoExposure — histogram/avgLuminance (2-3 pipelines)
 *   - WebGPUGPUCuller — frustum culling (1 pipeline)
 *   - WebGPUPointCloudLODProcessor — LOD compute (1 pipeline)
 *
 * Each consumer's `device.createComputePipeline()` calls route through
 * `getPipeline()` so identical (label, layout, entryPoint) tuples
 * across renderer instances or context lifetimes share one pipeline.
 *
 * # Lifecycle
 *
 * One cache per `GPUDevice`. Cleared on device loss via
 * `WebGPUContext.onDeviceInvalidated` (see `WebGPUContext.ts`).
 *
 * @module WebGPUComputePipelineCache
 * @private
 */

/**
 * Compute pipeline descriptor (cache-friendly form). Mirrors WebGPU's
 * `GPUComputePipelineDescriptor` minus the auto-layout option, which
 * the cache cannot dedupe correctly because `"auto"` resolves to a
 * unique pipeline layout per pipeline.
 */
export interface WebGPUComputePipelineDescriptor {
  /**
   * Unique name/identifier for this pipeline. Used as the leading part
   * of the cache key, so identical pipelines from different call sites
   * MUST share a name to dedupe.
   */
  name: string;

  /**
   * Pipeline layout. May be `"auto"` for one-off pipelines that don't
   * benefit from cross-renderer dedup; in that case the cache treats
   * each call as a fresh pipeline (no dedup, but still tracked).
   */
  layout: GPUPipelineLayout | "auto";

  /**
   * Compute stage descriptor — module + entry point + optional
   * pipeline constants.
   */
  compute: {
    module: GPUShaderModule;
    entryPoint: string;
    constants?: Record<string, number>;
  };
}

/**
 * Cache statistics surface.
 */
export interface ComputePipelineCacheStats {
  hits: number;
  misses: number;
  created: number;
  pending: number;
  size: number;
  hitRate: number;
}

/**
 * Internal cache entry — owns the pipeline and the descriptor for
 * traceability.
 */
interface ComputePipelineCacheEntry {
  pipeline: GPUComputePipeline;
  descriptor: WebGPUComputePipelineDescriptor;
  created: number;
}

/**
 * WebGPU Compute Pipeline Cache
 *
 * One instance per `GPUDevice`. Routed through
 * `WebGPUContext.webgpuComputePipelineCache` (lazy-instantiated, dropped
 * on device loss).
 */
export class WebGPUComputePipelineCache {
  private device: GPUDevice;
  private cache: Map<string, ComputePipelineCacheEntry>;
  private pendingPipelines: Map<string, Promise<GPUComputePipeline>>;
  private logPrefix: string;

  // Layout-identity table: maps a `GPUPipelineLayout` (or the literal
  // string "auto") to a stable integer the cache key can include. Built
  // lazily as new layouts are observed; cleared on device loss with the
  // rest of the cache.
  private layoutIdentityCounter: number = 0;
  private layoutIdentityMap: Map<GPUPipelineLayout | "auto", number> =
    new Map();

  // Statistics
  private stats = {
    hits: 0,
    misses: 0,
    created: 0,
    pending: 0,
  };

  /**
   * Create a new compute pipeline cache.
   *
   * @param device GPUDevice for creating pipelines
   * @param contextId Owning context's id for multi-context error
   *   attribution. Optional — defaults to a generic prefix.
   */
  constructor(device: GPUDevice, contextId?: string) {
    this.device = device;
    this.cache = new Map();
    this.pendingPipelines = new Map();
    this.logPrefix = contextId
      ? `[CesiumJS:webgpu:${contextId}:compute-pipeline-cache]`
      : `[CesiumJS:webgpu:compute-pipeline-cache]`;
  }

  /**
   * Get or create a compute pipeline. Returns the existing pipeline if
   * cached; otherwise creates one async via
   * `device.createComputePipelineAsync()`.
   *
   * @param descriptor Compute pipeline descriptor
   * @returns Promise resolving to the compute pipeline
   */
  async getPipeline(
    descriptor: WebGPUComputePipelineDescriptor,
  ): Promise<GPUComputePipeline> {
    const key = this.generateCacheKey(descriptor);

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
    const pipelinePromise = this.createPipelineAsync(descriptor);
    this.pendingPipelines.set(key, pipelinePromise);
    this.stats.pending++;

    try {
      const pipeline = await pipelinePromise;

      this.cache.set(key, {
        pipeline,
        descriptor,
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
   * Get a pipeline synchronously. Returns the existing pipeline if
   * cached, undefined otherwise. Callers that hit `undefined` should
   * follow up with `getPipeline()` to kick off async creation, OR
   * use `getOrCreateSync` to create-and-register in one call.
   */
  getPipelineSync(
    descriptor: WebGPUComputePipelineDescriptor,
  ): GPUComputePipeline | undefined {
    const key = this.generateCacheKey(descriptor);
    const cached = this.cache.get(key);

    if (cached) {
      this.stats.hits++;
      return cached.pipeline;
    }

    this.stats.misses++;
    return undefined;
  }

  /**
   * Synchronous get-or-create. Returns the cached pipeline if hit;
   * otherwise creates one synchronously via `device.createComputePipeline()`
   * and registers it for future dedup.
   *
   * Trade-off vs `getPipeline()`: loses async-compile parallelism (the
   * driver compiles on the calling thread), but preserves sync API
   * surfaces. Use this when migrating an existing sync compute-pipeline
   * call site that you don't want to push toward async — the cache
   * still benefits cross-instance dedup, just without the parallelism
   * win.
   *
   * Still tracked in `stats.created` so dashboards correctly show how
   * many pipelines were actually compiled vs cache-hit.
   */
  getOrCreateSync(
    descriptor: WebGPUComputePipelineDescriptor,
  ): GPUComputePipeline {
    const key = this.generateCacheKey(descriptor);
    const cached = this.cache.get(key);
    if (cached) {
      this.stats.hits++;
      return cached.pipeline;
    }

    this.stats.misses++;
    const gpuDesc: GPUComputePipelineDescriptor = {
      label: descriptor.name,
      layout: descriptor.layout,
      compute: {
        module: descriptor.compute.module,
        entryPoint: descriptor.compute.entryPoint,
        constants: descriptor.compute.constants,
      },
    };
    const pipeline = this.device.createComputePipeline(gpuDesc);
    this.cache.set(key, {
      pipeline,
      descriptor,
      created: Date.now(),
    });
    this.stats.created++;
    return pipeline;
  }

  /**
   * Build the underlying GPU descriptor and create the pipeline. Logs
   * + rethrows on validation failure so callers can `.catch()` and
   * decide whether to retry.
   */
  private async createPipelineAsync(
    descriptor: WebGPUComputePipelineDescriptor,
  ): Promise<GPUComputePipeline> {
    const gpuDesc: GPUComputePipelineDescriptor = {
      label: descriptor.name,
      layout: descriptor.layout,
      compute: {
        module: descriptor.compute.module,
        entryPoint: descriptor.compute.entryPoint,
        constants: descriptor.compute.constants,
      },
    };

    try {
      const pipeline = await this.device.createComputePipelineAsync(gpuDesc);
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
   * Resolve a stable integer for a pipeline layout's identity.
   * `"auto"` always gets a fresh integer so two `"auto"` callers never
   * dedupe (they MUST get distinct pipelines because each `"auto"`
   * pipeline has its own derived layout).
   */
  private layoutIdentityFor(layout: GPUPipelineLayout | "auto"): number {
    if (layout === "auto") {
      // `"auto"` cannot be deduped — return a fresh sentinel so the key
      // never collides with another "auto" caller.
      return -1 - this.layoutIdentityCounter++;
    }
    let id = this.layoutIdentityMap.get(layout);
    if (id === undefined) {
      id = this.layoutIdentityCounter++;
      this.layoutIdentityMap.set(layout, id);
    }
    return id;
  }

  /**
   * Generate a stable cache key for the descriptor. Includes the name
   * (callers must keep names stable for dedup), layout identity, and
   * entry point.
   */
  private generateCacheKey(
    descriptor: WebGPUComputePipelineDescriptor,
  ): string {
    const layoutId = this.layoutIdentityFor(descriptor.layout);
    const constantsKey = descriptor.compute.constants
      ? `|c:${JSON.stringify(descriptor.compute.constants)}`
      : "";
    return `${descriptor.name}|l:${layoutId}|e:${descriptor.compute.entryPoint}${constantsKey}`;
  }

  /**
   * Get cache statistics.
   */
  getStats(): ComputePipelineCacheStats {
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
   * Clear all cached pipelines. Stats reset; pending promises stay
   * (they'll resolve into a now-empty cache, which is fine — the next
   * call will see a cache miss and create fresh).
   */
  clear(): void {
    this.cache.clear();
    this.layoutIdentityMap.clear();
    this.layoutIdentityCounter = 0;
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.created = 0;
  }

  /**
   * Destroy the cache and release resources. Called on device loss.
   */
  destroy(): void {
    this.cache.clear();
    this.pendingPipelines.clear();
    this.layoutIdentityMap.clear();
  }

  /**
   * Diagnostic — list of cached pipeline names.
   */
  getCachedPipelineNames(): string[] {
    return Array.from(this.cache.values()).map(
      (entry) => entry.descriptor.name,
    );
  }

  /**
   * Whether a given descriptor is currently cached. Cheap — uses the
   * same key generator as `getPipeline`.
   */
  has(descriptor: WebGPUComputePipelineDescriptor): boolean {
    const key = this.generateCacheKey(descriptor);
    return this.cache.has(key);
  }
}

export default WebGPUComputePipelineCache;
