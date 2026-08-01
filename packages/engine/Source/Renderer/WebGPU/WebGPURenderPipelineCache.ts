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

import type { AsyncResourceMonitor } from "./AsyncResourceMonitor.js";

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

  /**
   * Polygon-offset / depth-bias state. WebGL sets this via
   * `gl.polygonOffset(factor, units)`; WebGPU bakes it into the
   * pipeline's `depthStencil` descriptor as
   * `depthBias`, `depthBiasSlopeScale`, `depthBiasClamp`. When a
   * variant needs different depthBias (e.g. decals vs. shadow cast),
   * the cache must materialize a separate pipeline — WebGPU has no
   * per-draw override. Missing values default to 0 (no bias).
   *
   * Corresponds to WebGL `renderState.polygonOffset.{factor, units}`.
   */
  depthBias?: number;
  depthBiasSlopeScale?: number;
  depthBiasClamp?: number;

  /**
   * Constant blend color used with `src/dst-factor = constant` or
   * `constant-alpha`. WebGPU exposes this as a per-encoder
   * `setBlendConstant()` call; the pipeline itself doesn't bake the
   * value. This field lives on the variant only so callers can carry
   * the intended value from `command.renderState.blendConstant` through
   * to `WebGPUDrawCommand.execute()` where the per-encoder call fires.
   * Not used by `buildPipeline()`.
   */
  blendConstant?: GPUColor;
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

  /**
   * Number of pipelines evicted by LRU policy since cache creation /
   * last clear(). High eviction rates with healthy hit rates suggest
   * the cap is roughly right; high eviction rates with low hit rates
   * suggest the cap is too small for the working set.
   */
  evicted: number;

  /**
   * Maximum cache size (LRU cap). Pipelines beyond this count are
   * evicted on insertion in least-recently-used order.
   */
  maxSize: number;
}

/**
 * One row of {@link WebGPURenderPipelineCache.listPipelineVariants}.
 */
export interface PipelineCacheVariantInfo {
  /** The full cache key, as produced by the cache's own key generator. */
  key: string;
  /**
   * `descriptor.name` — the leading segment of `key`. Two rows sharing a
   * `name` are distinguished only by the descriptor/variant markers that
   * follow it; a producer that fails to vary the name for a
   * pipeline-identity-affecting change is how two logical variants alias
   * onto one `GPURenderPipeline`.
   */
  name: string;
  pipeline: GPURenderPipeline;
  /** Creation timestamp (`Date.now()`). */
  created: number;
  /** Most recent hit (`Date.now()`). */
  lastAccessed: number;
}

/**
 * Pipeline cache entry
 */
interface PipelineCacheEntry {
  pipeline: GPURenderPipeline;
  descriptor: WebGPURenderPipelineDescriptor;
  variant: PipelineVariant;
  created: number; // creation timestamp (Date.now())
  lastAccessed: number; // most recent get / has hit (Date.now())
}

/**
 * Default LRU cap. Each entry holds one `GPURenderPipeline` plus light
 * metadata; 1024 is generous for the largest workloads we see today
 * (full glTF + globe + post-process pipelines for a single scene
 * typically lands around 200-400 entries) while still bounding the
 * worst case (a misuse pattern that builds variants in a hot loop).
 * Override per-cache via `setMaxSize()`.
 */
const DEFAULT_MAX_SIZE = 1024;

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
  private maxSize: number;
  // NEW-WEBGPU-PIPELINE-READY-SIGNAL (Phase 2) — optional reference to
  // the owning context's `AsyncResourceMonitor`. When set, every async
  // pipeline creation publishes `begin/resolve/reject` events so the
  // attached Scene wakes up exactly when the pipeline lands. When
  // null (e.g., test harnesses that construct the cache standalone),
  // the cache still works — just without the wakeup signal.
  private monitor: AsyncResourceMonitor | null;

  // Statistics
  private stats = {
    hits: 0,
    misses: 0,
    created: 0,
    pending: 0,
    evicted: 0,
  };

  /**
   * Create a new pipeline cache
   *
   * @param device - GPUDevice for creating pipelines
   * @param contextId - Owning context's id for multi-context error attribution
   * @param maxSize - LRU cap (defaults to DEFAULT_MAX_SIZE)
   * @param monitor - Optional async resource monitor for wakeup signaling
   */
  constructor(
    device: GPUDevice,
    contextId?: string,
    maxSize?: number,
    monitor?: AsyncResourceMonitor | null,
  ) {
    this.device = device;
    this.cache = new Map();
    this.pendingPipelines = new Map();
    this.logPrefix = contextId
      ? `[CesiumJS:webgpu:${contextId}:pipeline-cache]`
      : `[CesiumJS:webgpu:pipeline-cache]`;
    this.maxSize = maxSize ?? DEFAULT_MAX_SIZE;
    this.monitor = monitor ?? null;
  }

  /**
   * Phase 2 helper — wire the cache to a monitor after construction.
   * Used when the cache outlives a transient monitor instance (it
   * doesn't today, but device-loss recovery may swap monitors in a
   * future phase). Idempotent.
   */
  setAsyncResourceMonitor(monitor: AsyncResourceMonitor | null): void {
    this.monitor = monitor;
  }

  /**
   * Set the LRU cap. Shrinking below the current size triggers
   * immediate eviction of the oldest entries.
   */
  setMaxSize(maxSize: number): void {
    this.maxSize = Math.max(1, Math.floor(maxSize));
    this.evictIfNeeded();
  }

  /**
   * Mark an entry as most-recently-used by re-inserting it at the end
   * of the Map (Map preserves insertion order, so the first entry is
   * the LRU candidate). Updates `lastAccessed` for diagnostics.
   */
  private touch(key: string, entry: PipelineCacheEntry): void {
    entry.lastAccessed = Date.now();
    // Re-insert: delete + set keeps the entry at the tail of insertion
    // order. O(1) amortized on V8/SpiderMonkey/JSC.
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  /**
   * Evict oldest entries (front of insertion order) until the cache
   * size is within the cap. Called after every insertion and on
   * `setMaxSize` shrinks. GPURenderPipeline objects don't have an
   * explicit `destroy()` in WebGPU — dropping the JS reference is what
   * lets the implementation reclaim them, so we just delete the entry.
   */
  private evictIfNeeded(): void {
    if (this.cache.size <= this.maxSize) {
      return;
    }
    const it = this.cache.keys();
    while (this.cache.size > this.maxSize) {
      const next = it.next();
      if (next.done) break;
      this.cache.delete(next.value);
      this.stats.evicted++;
    }
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
      this.touch(key, cached);
      return cached.pipeline;
    }

    // Check pending
    const pending = this.pendingPipelines.get(key);
    if (pending) {
      return pending;
    }

    // Create new pipeline
    this.stats.misses++;
    // NEW-WEBGPU-PIPELINE-READY-SIGNAL (Phase 2 + audit fix) — set
    // `pendingPipelines` and bump `stats.pending` BEFORE calling
    // `monitor.begin`. `monitor.begin` synchronously fires the
    // "started" subscriber fanout; if a subscriber re-enters
    // `cache.getPipeline(sameDescriptor)` (unusual but defensible)
    // they'll hit the `pendingPipelines.get(key)` path and return the
    // existing promise instead of double-creating. Without this order
    // the re-entrant call would miss the cache AND miss the pending
    // map, kicking off a duplicate `createRenderPipelineAsync`.
    const pipelinePromise = this.createPipelineAsync(descriptor, variant);
    this.pendingPipelines.set(key, pipelinePromise);
    this.stats.pending++;
    const monitorToken = this.monitor?.begin({
      kind: "render-pipeline",
      key,
      label: descriptor.name,
    });

    try {
      const pipeline = await pipelinePromise;

      // Cache it
      const now = Date.now();
      this.cache.set(key, {
        pipeline,
        descriptor,
        variant: variant || {},
        created: now,
        lastAccessed: now,
      });
      this.evictIfNeeded();

      this.stats.created++;
      // Publish "resolved" AFTER the cache write so subscribers that
      // synchronously call `getPipelineSync(descriptor)` from inside
      // the wakeup handler hit the cache. The monitor's pendingCount
      // also decrements here — Scene's `shouldRender` gate sees 0
      // (or near-0 if other pipelines are still cooking) on the next
      // frame and re-hibernates naturally once everything lands.
      if (monitorToken) {
        this.monitor!.resolve(monitorToken);
      }
      return pipeline;
    } catch (error) {
      if (monitorToken) {
        this.monitor!.reject(monitorToken, error);
      }
      throw error;
    } finally {
      this.pendingPipelines.delete(key);
      this.stats.pending--;
    }
  }

  /**
   * NEW-WEBGPU-PIPELINE-READY-SIGNAL (Phase 4) — speculative pre-cook.
   * Kicks off async creation if the pipeline isn't already cached or
   * pending. Registered with the monitor as a `background`-priority
   * token so the scene hibernates normally while warming completes;
   * the resolution wake-up still fires so the warmed pipeline is
   * consumable on the next user-driven frame.
   *
   * Returns immediately. Callers don't need to await — the pipeline
   * lands in the cache when ready and a subsequent `getPipelineSync`
   * (or normal `getPipeline`) hits.
   *
   * Use cases:
   *   - Camera approaching a log-depth threshold → warm the log-depth variant.
   *   - Imagery layer added → warm the alpha-blend variants the layer needs.
   *   - User about to enter a new frustum count → warm the secondary variant.
   *
   * Idempotent — calling for an already-cached or already-pending key
   * is a no-op (the dedup is identical to `getPipeline`).
   */
  warm(
    descriptor: WebGPURenderPipelineDescriptor,
    variant?: PipelineVariant,
  ): void {
    const key = this.generateCacheKey(descriptor, variant);
    if (this.cache.has(key) || this.pendingPipelines.has(key)) {
      return;
    }
    // Reuse the central async-creation path so cache state, monitor
    // events, and stats all stay consistent. The token's priority is
    // background so Scene's `shouldRender` gate ignores this work.
    // Same ordering note as `getPipeline` — pendingPipelines.set
    // BEFORE monitor.begin so a re-entrant subscriber sees consistent
    // cache state.
    this.stats.misses++;
    const pipelinePromise = this.createPipelineAsync(descriptor, variant);
    this.pendingPipelines.set(key, pipelinePromise);
    this.stats.pending++;
    const monitorToken = this.monitor?.begin({
      kind: "render-pipeline",
      key,
      label: descriptor.name,
      priority: "background",
    });

    pipelinePromise
      .then((pipeline) => {
        const now = Date.now();
        this.cache.set(key, {
          pipeline,
          descriptor,
          variant: variant || {},
          created: now,
          lastAccessed: now,
        });
        this.evictIfNeeded();
        this.stats.created++;
        if (monitorToken) this.monitor!.resolve(monitorToken);
      })
      .catch((error) => {
        if (monitorToken) this.monitor!.reject(monitorToken, error);
      })
      .finally(() => {
        this.pendingPipelines.delete(key);
        this.stats.pending--;
      });
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
      this.touch(key, cached);
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
        (variant?.stencilFront ?? descriptor.depthStencil?.stencilFront) !==
          undefined ||
        (variant?.stencilBack ?? descriptor.depthStencil?.stencilBack) !==
          undefined;
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
        depthBias: variant?.depthBias ?? descriptor.depthStencil?.depthBias,
        depthBiasSlopeScale:
          variant?.depthBiasSlopeScale ??
          descriptor.depthStencil?.depthBiasSlopeScale,
        depthBiasClamp:
          variant?.depthBiasClamp ?? descriptor.depthStencil?.depthBiasClamp,
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
      if (variant.depthBias !== undefined)
        parts.push(`db:${variant.depthBias}`);
      if (variant.depthBiasSlopeScale !== undefined)
        parts.push(`dbs:${variant.depthBiasSlopeScale}`);
      if (variant.depthBiasClamp !== undefined)
        parts.push(`dbc:${variant.depthBiasClamp}`);
      // blendConstant intentionally NOT part of the pipeline key — it is
      // a per-encoder dynamic state applied via setBlendConstant(), so
      // two draws with different blend constants still share the pipeline.
    }

    // C-R7 (Batch 34) — descriptor-side fields that affect pipeline
    // identity but are NOT part of the variant. Without these, two
    // pipelines with different MSAA counts / color target formats /
    // depth formats / vertex layouts would collide on the same cache
    // key and the first one would incorrectly serve the second.

    // Multisample count — MSAA pipelines are incompatible with the
    // single-sampled render pass and vice versa.
    if (descriptor.multisample?.count !== undefined) {
      parts.push(`ms:${descriptor.multisample.count}`);
    }
    // Depth/stencil format — `depth24plus-stencil8` vs `depth32float` vs
    // none produce different underlying GPURenderPipeline objects.
    if (descriptor.depthStencil?.format) {
      parts.push(`df:${descriptor.depthStencil.format}`);
    }
    // Per-target color format + writeMask. Two pipelines writing to
    // `bgra8unorm` vs `rgba16float` must materialize separately; same
    // for different writeMasks across targets (MRT pick + color writing
    // to one attachment but not the other).
    const targets = descriptor.fragment?.targets;
    if (targets && targets.length > 0) {
      const targetSig = targets
        .map((t, i) => {
          const fmt = t?.format ?? "";
          const wm = t?.writeMask ?? 0xf;
          const hasBlend = t?.blend ? "+" : "-";
          return `${i}:${fmt}:${wm}:${hasBlend}`;
        })
        .join(",");
      parts.push(`tg:${targetSig}`);
    }
    // Vertex buffer layout signature — stride + attribute shape. Two
    // pipelines fed different vertex buffer arrangements have different
    // bytecode even if every other field matches (e.g. a position-only
    // depth-cast variant vs. the full PBR layout).
    const vtxBuffers = descriptor.vertex?.buffers;
    if (vtxBuffers && vtxBuffers.length > 0) {
      const vtxSig = vtxBuffers
        .map((b, bi) => {
          if (!b) {
            return `${bi}:null`;
          }
          const stride = b.arrayStride;
          const step = b.stepMode ?? "vertex";
          const attrs = (b.attributes ?? [])
            .map((a) => `${a.shaderLocation}@${a.offset}/${a.format}`)
            .join(";");
          return `${bi}:${stride}/${step}/[${attrs}]`;
        })
        .join(",");
      parts.push(`vx:${vtxSig}`);
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
      evicted: this.stats.evicted,
      maxSize: this.maxSize,
    };
  }

  /**
   * Enumerate the cache's actual contents.
   *
   * `getStats()` reports only counters, which is why a cache can look healthy
   * while serving the wrong pipeline: aliasing (two logically distinct
   * pipelines colliding on one key) RAISES the hit rate, so no counter in
   * `getStats()` can expose it. This returns the keys themselves, in LRU order
   * (least-recently-used first, matching the eviction order), so a diagnostic
   * or spec can inspect what is actually stored rather than infer it.
   *
   * @returns one row per cached pipeline
   */
  listPipelineVariants(): PipelineCacheVariantInfo[] {
    const rows: PipelineCacheVariantInfo[] = [];
    for (const [key, entry] of this.cache) {
      rows.push({
        key,
        name: entry.descriptor.name,
        pipeline: entry.pipeline,
        created: entry.created,
        lastAccessed: entry.lastAccessed,
      });
    }
    return rows;
  }

  /**
   * The cache key this cache WOULD use for a descriptor + variant — the same
   * string `getPipeline` / `has` / `remove` compute internally.
   *
   * Exposed so a caller can correlate its own bookkeeping with this cache
   * without re-deriving the key format. Re-deriving it independently is the
   * exact defect that left four globe pipeline accessors returning `null` for
   * ~15 months after the key format grew a marker.
   *
   * @param descriptor pipeline descriptor
   * @param variant variant configuration
   * @returns the cache key
   */
  describeCacheKey(
    descriptor: WebGPURenderPipelineDescriptor,
    variant?: PipelineVariant,
  ): string {
    return this.generateCacheKey(descriptor, variant);
  }

  /**
   * Clear all cached pipelines
   */
  clear(): void {
    this.cache.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.created = 0;
    this.stats.evicted = 0;
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
