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
import {
  clearDeviceSuspect,
  isDeviceFailureSignal,
  isDeviceLost,
  isDeviceSuspect,
  markDeviceSuspect,
} from "./WebGPUDeviceInvalidationBus.js";

/**
 * Stable integer identity for GPU objects that participate in pipeline
 * identity but expose no structural introspection API.
 *
 * `GPUShaderModule` has no readable source, no define mask and no comparable
 * primitive form: the ONLY thing a key generator can observe about it is
 * object identity. A `WeakMap` turns that identity into a small integer the
 * key can carry, without retaining the module (entries vanish when the module
 * is collected, which matters because `WebGPUShaderModuleCache` is dropped on
 * device loss).
 *
 * Deliberately module-scoped rather than per-cache instance: multi-context
 * scenes run several caches over several devices, and one shared counter keeps
 * ids globally unique so a key can never mean two different modules. It also
 * means the render and compute caches agree on what "module 7" is.
 *
 * Ids start at 1 so `0` can mean "absent" (no fragment stage, or a JS caller
 * that omitted the module) without colliding with a real module.
 */
const gpuObjectIdentity = new WeakMap<object, number>();
let nextGpuObjectId = 1;

/**
 * Resolve (and memoize) the identity integer for a GPU object.
 *
 * Hot path: one `WeakMap.get` — an identity-hash lookup with no allocation.
 * The `set` runs once per object, ever.
 *
 * @param obj the object to identify, or null/undefined for "absent"
 * @returns a stable positive integer, or 0 when the object is absent
 */
export function webgpuObjectIdentity(obj: object | undefined | null): number {
  if (obj === undefined || obj === null) {
    return 0;
  }
  let id = gpuObjectIdentity.get(obj);
  if (id === undefined) {
    id = nextGpuObjectId++;
    gpuObjectIdentity.set(obj, id);
  }
  return id;
}

/**
 * Compact signature for one stencil face state. Hand-serialized instead of
 * `JSON.stringify` because `generateCacheKey` runs on every cache lookup and
 * a four-field template beats a serializer walk; the four fields are the
 * complete `GPUStencilFaceState` surface.
 *
 * @param face the stencil face state, or undefined
 * @returns the signature, or the empty string when absent
 */
function stencilFaceSignature(face: GPUStencilFaceState | undefined): string {
  if (face === undefined) {
    return "";
  }
  return `${face.compare ?? ""}.${face.failOp ?? ""}.${face.depthFailOp ?? ""}.${face.passOp ?? ""}`;
}

/**
 * Compact, default-normalized signature for one blend component. WebGPU's
 * dictionary defaults are part of pipeline identity even when a caller omits
 * them, so `{}` and the explicitly-spelled replacement component deliberately
 * produce the same signature.
 */
function blendComponentSignature(component: GPUBlendComponent): string {
  return `${component.operation ?? "add"}.${component.srcFactor ?? "one"}.${component.dstFactor ?? "zero"}`;
}

/**
 * Complete signature for a color target's blend state. An absent blend block
 * stays distinct from an explicitly enabled replacement blend: the latter is
 * still a blend-enabled pipeline state and is invalid for non-blendable target
 * formats even though its arithmetic happens to replace the destination.
 */
function blendStateSignature(blend: GPUBlendState | undefined): string {
  if (blend === undefined) {
    return "-";
  }
  return `${blendComponentSignature(blend.color)}/${blendComponentSignature(blend.alpha)}`;
}

/**
 * Resolve the target state the pipeline builder will actually submit. A
 * descriptor target is the explicit contract, so variant blend/write-mask
 * fields only fill omitted target fields. The input descriptor is never
 * mutated, and the original array is retained when the variant changes
 * nothing.
 */
function resolveColorTargets(
  targets: Array<GPUColorTargetState | null>,
  variant?: PipelineVariant,
): Array<GPUColorTargetState | null> {
  const variantBlend = variant?.blend;
  const variantWriteMask =
    variant?.colorWriteMask === undefined
      ? undefined
      : variant.colorWriteMask & 0xf;
  if (variantBlend === undefined && variantWriteMask === undefined) {
    return targets;
  }

  let changed = false;
  const resolved = targets.map((target) => {
    if (target === null) {
      return target;
    }
    const blend = target.blend ?? variantBlend;
    const writeMask = target.writeMask ?? variantWriteMask;
    if (blend === target.blend && writeMask === target.writeMask) {
      return target;
    }
    changed = true;
    return {
      ...target,
      ...(blend === undefined ? {} : { blend }),
      ...(writeMask === undefined ? {} : { writeMask }),
    };
  });
  return changed ? resolved : targets;
}

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
    targets: Array<GPUColorTargetState | null>;
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

  /**
   * Optional explicit `ShaderDefine` bitmask (lo word) the shader modules were
   * compiled with.
   *
   * Folding it into the cache key is defence in depth, not the primary
   * mechanism: `generateCacheKey` already folds shader-module identity, and
   * `WebGPUShaderModuleCache` hands out a distinct `GPUShaderModule` per
   * `(sourceId, defines, definesHi, keySalt)`, so a define flip moves the key
   * with or without this field.
   *
   * Set it when the producer has the mask to hand and wants the key to say so,
   * as the globe does: it makes the axis legible in `describeCacheKey()`
   * output and in `listPipelineVariants()` rows, and it keeps the key honest
   * for a producer that composes a module from define-dependent source text
   * outside the module cache, where two logically different variants could in
   * principle be handed to one `createShaderModule` call.
   */
  defines?: number;

  /**
   * Companion hi word for {@link WebGPURenderPipelineDescriptor.defines}
   * (`ShaderDefineHi`). Same optional, defence-in-depth status.
   */
  definesHi?: number;
}

/**
 * Pipeline variant configuration
 */
export interface PipelineVariant {
  /**
   * Depth test enabled. `false` removes depth state unless effective stencil
   * operations require the attachment; that stencil-only form forces
   * `depthCompare = "always"` and disables depth writes.
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
   * Blend mode used for fragment targets that do not declare their own
   * `blend` block. An explicit per-target descriptor block wins.
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
   * Cache hits whose CACHED pipeline was built from a DIFFERENT shader
   * module than the one the caller is requesting now. Aliasing RAISES the
   * plain hit rate (the collision is served as a hit), so hits/misses can
   * never reveal it — this counter is the cache's only self-diagnostic for
   * key collisions. Any nonzero value is a key-construction defect; see
   * `WebGPUGlobeSurfacePipelineKey.ts`. Observe-only: the aliased pipeline is
   * still returned.
   *
   * Because `generateCacheKey` folds shader-module identity, a served hit
   * implies identical modules, so this counter is expected to read 0
   * permanently. It is retained deliberately: it is the runtime canary that
   * the fold is still present and still reached. A nonzero reading means the
   * `sh:` segment has been dropped, bypassed or broken — the structural
   * guarantee is gone, not merely one producer's name marker.
   */
  wrongModuleHits: number;

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
   * `name` are distinguished by the descriptor and variant markers that follow
   * it, and by the trailing `sh:<vsId>.<vsEntry>/<fsId>.<fsEntry>`
   * shader-identity segment. Two rows with the same name and different `sh:`
   * ids are the normal, correct shape for a shader-variant pair whose producer
   * did not spell the axis into its name.
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
  // Optional reference to the owning context's `AsyncResourceMonitor`. When
  // set, every async
  // pipeline creation publishes `begin/resolve/reject` events so the
  // attached Scene wakes up exactly when the pipeline lands. When
  // null (e.g., test harnesses that construct the cache standalone),
  // the cache still works — just without the wakeup signal.
  private monitor: AsyncResourceMonitor | null;
  // One line per cache is enough to attribute a dead-device refusal. The
  // scene keeps requesting pipelines every frame for as long as recovery
  // takes, so an unthrottled report would bury the loss itself.
  private lostDeviceRefusalReported = false;

  // Statistics
  private stats = {
    hits: 0,
    misses: 0,
    created: 0,
    pending: 0,
    evicted: 0,
    wrongModuleHits: 0,
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
      this.noteWrongModuleHit(cached, descriptor);
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
    // Set `pendingPipelines` and bump `stats.pending` before calling
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
   * Speculative pre-cook.
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
    // Speculative work is the one thing that can be dropped on a suspicion
    // rather than a fact: nothing on screen is waiting for it, and the next
    // frame asks again. A device that is known lost, or that just failed the
    // way a dying device fails, gets no pre-cooking.
    if (isDeviceLost(this.device) || isDeviceSuspect(this.device)) {
      return;
    }
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
      this.noteWrongModuleHit(cached, descriptor);
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
    // A lost device still accepts creation calls and still rejects them, one
    // per request, for as long as the scene keeps drawing - which is until
    // recovery publishes a replacement, not until the loss is noticed. Refuse
    // here instead: callers already handle a rejection from this path, and the
    // work they skip is work that could not have succeeded.
    if (isDeviceLost(this.device)) {
      if (!this.lostDeviceRefusalReported) {
        this.lostDeviceRefusalReported = true;
        console.error(
          `${this.logPrefix} Device lost - refusing pipeline creation ` +
            `(first refusal: "${descriptor.name}"). Pipelines resume on the ` +
            `replacement device.`,
        );
      }
      throw new Error(
        `Cannot create pipeline "${descriptor.name}": the GPUDevice is lost.`,
      );
    }

    const pipelineDescriptor = this.buildPipelineDescriptor(
      descriptor,
      variant,
    );

    try {
      // Use async pipeline creation for better performance
      const pipeline =
        await this.device.createRenderPipelineAsync(pipelineDescriptor);
      // A completed creation is proof the device is answering, which is the
      // only evidence that withdraws an earlier suspicion.
      clearDeviceSuspect(this.device);
      return pipeline;
    } catch (error) {
      // A validation rejection describes the descriptor or the shader and
      // would happen on any device. Anything else is the device answering
      // badly, and on a GPU-process termination it is the first thing the page
      // sees - well before the lost promise settles.
      if (isDeviceFailureSignal(error)) {
        markDeviceSuspect(this.device);
      }
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

    // Fragment shader (optional). Variant blend and colorWriteMask state fills
    // only fields omitted by an individual target. Targets that spell either
    // field explicitly keep it: pipeline descriptors are the explicit
    // contract, while variants carry compatibility state for otherwise-bare
    // descriptors. resolveColorTargets shallow-clones only changed targets and
    // never mutates the caller's descriptor.
    if (descriptor.fragment) {
      result.fragment = {
        module: descriptor.fragment.module,
        entryPoint: descriptor.fragment.entryPoint,
        targets: resolveColorTargets(descriptor.fragment.targets, variant),
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

    // Depth stencil state with variant overrides. A false depthTest disables
    // depth COMPARISON and depth WRITES — comparison becomes `always` and
    // writes are off, because retaining the descriptor's compare or write flag
    // would silently leave depth testing active. It does not remove the
    // attachment: a descriptor that declares a depthStencil block is rendering
    // into a pass that has a depth attachment, and a pipeline built without the
    // block is incompatible with that pass ("Attachment state is not
    // compatible"), so the depth-disabled pipeline keeps the block with the
    // descriptor's own format. Only a color-only descriptor — no depthStencil
    // and no stencil ops — still produces no depth state.
    //
    // When the variant
    // introduces stencil ops and the descriptor's format is
    // depth-only, auto-upgrade to `depth24plus-stencil8` — otherwise
    // WebGPU validation errors on "stencil ops present but format has
    // no stencil aspect". Matches the behavior of
    // WebGPUPipelineDescriptorBuilder._ensureDepthStencil.
    const stencilFront =
      variant?.stencilFront ?? descriptor.depthStencil?.stencilFront;
    const stencilBack =
      variant?.stencilBack ?? descriptor.depthStencil?.stencilBack;
    const hasStencilOps =
      stencilFront !== undefined || stencilBack !== undefined;
    const depthDisabled = variant?.depthTest === false;

    // Write/compare/bias fields modify a selected depth state; they do not
    // independently require a depth attachment on a color-only pipeline.
    const needsDepthStencil =
      descriptor.depthStencil !== undefined ||
      variant?.depthTest === true ||
      hasStencilOps;
    if (needsDepthStencil) {
      let format = descriptor.depthStencil?.format || "depth24plus";
      if (
        hasStencilOps &&
        (format === "depth24plus" || format === "depth32float")
      ) {
        format = "depth24plus-stencil8";
      }
      result.depthStencil = {
        format,
        depthWriteEnabled: depthDisabled
          ? false
          : variant?.depthWrite !== undefined
            ? variant.depthWrite
            : (descriptor.depthStencil?.depthWriteEnabled ?? true),
        depthCompare: depthDisabled
          ? "always"
          : variant?.depthCompare ||
            descriptor.depthStencil?.depthCompare ||
            // Default to `less-equal` (not `less`) — at planetary scale,
            // FP32 can project Z to exactly the far plane and `less`
            // would discard those fragments. See WebGPUContext.
            "less-equal",
        stencilFront,
        stencilBack,
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
   * # Shader identity is folded structurally
   *
   * A key built from `descriptor.name` plus structural fields alone, reading
   * neither `vertex.module`, `fragment.module` nor `entryPoint` nor any define
   * bitmask, aliases silently on any shader define that changes neither the
   * descriptor name nor the vertex layout: the producer rebuilds its
   * descriptor around a correctly recompiled module, looks it up under an
   * unchanged name, and is handed the pipeline compiled from the previous
   * module.
   *
   * The `sh:` segment closes that class at its root. `WebGPUShaderModuleCache`
   * returns a distinct `GPUShaderModule` object per
   * `(sourceId, defines, definesHi, keySalt)`, so folding module identity is
   * strictly stronger than folding the define mask: it also separates two
   * producers that compiled different source text under the same mask, and it
   * works for a producer that calls `device.createShaderModule` directly and
   * never touches the define registry. A new define bit therefore cannot
   * alias whether or not its author remembers a name marker.
   *
   * The existing per-axis name markers (`, ld=1`, `, imagery4`, `, noCull`,
   * `defines=0x…`, `[sf=…]`) are retained as defense-in-depth and as
   * human-readable provenance in `describeCacheKey()` / `listPipelineVariants()`
   * output — they are now redundant for correctness, not load-bearing.
   *
   * # Hit-rate and allocation
   *
   * Producers hold their descriptors (and therefore their modules) on
   * long-lived `resources`/`entry`/`host` objects and rebuild them only on a
   * real state flip, so identity is stable across frames and genuinely
   * identical pipelines still share one key. Cost is two `WeakMap.get`s plus
   * one extra `parts.push` per call — no new allocation beyond the single
   * segment string. Blend state is hand-serialized with its WebGPU defaults,
   * avoiding the serializer walk and object-key-order sensitivity of
   * `JSON.stringify`.
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
      if (variant.stencilFront)
        parts.push(`sf:${JSON.stringify(variant.stencilFront)}`);
      if (variant.stencilBack)
        parts.push(`sb:${JSON.stringify(variant.stencilBack)}`);
      if (variant.stencilReadMask !== undefined)
        parts.push(`srm:${variant.stencilReadMask}`);
      if (variant.stencilWriteMask !== undefined)
        parts.push(`swm:${variant.stencilWriteMask}`);
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

    // Descriptor-side fields that affect pipeline identity but are not part
    // of the variant. Without these, two
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
    // Per-target color format + effective writeMask + exact normalized blend
    // state. Two pipelines writing to
    // `bgra8unorm` vs `rgba16float` must materialize separately; same
    // for different writeMasks across targets (MRT pick + color writing
    // to one attachment but not the other). A descriptor target wins over a
    // variant field, exactly as buildPipelineDescriptor resolves it, so an
    // ignored compatibility variant neither aliases nor needlessly splits a
    // cache entry.
    const targets = descriptor.fragment?.targets;
    const variantWriteMask =
      variant?.colorWriteMask === undefined
        ? undefined
        : variant.colorWriteMask & 0xf;
    if (targets && targets.length > 0) {
      const targetSig = targets
        .map((t, i) => {
          if (t === null) {
            return `${i}:null`;
          }
          const fmt = t.format;
          const wm = t.writeMask ?? variantWriteMask ?? 0xf;
          const blend = blendStateSignature(t.blend ?? variant?.blend);
          return `${i}:${fmt}:${wm}:${blend}`;
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

    // The remaining descriptor-side fields `buildPipelineDescriptor` feeds to
    // `createRenderPipeline`. Hashing only `multisample.count`,
    // `depthStencil.format`, `fragment.targets` and `vertex.buffers` leaves
    // `primitive.cullMode`, `depthStencil.depthWriteEnabled`, the shader
    // modules and the pipeline layout reachable only through the `variant`
    // argument, which no in-tree caller passes — so they are invisible to the
    // key, and the `noCull` and `ld=` name markers are hand-written stand-ins
    // for exactly that omission. Hashing a field on both sides can only split
    // two keys a variant override would have merged, which is the safe
    // direction and unreachable while no caller passes a variant.

    // Pipeline layout identity. `"auto"` and `undefined` are the same request
    // ("derive it"), so both are omitted and keep their historical key shape.
    const layout = descriptor.layout;
    if (layout !== undefined && layout !== "auto") {
      parts.push(`pl:${webgpuObjectIdentity(layout)}`);
    }
    // Primitive state. Hand-serialized rather than `JSON.stringify`d: five
    // field reads and one template, no serializer machinery.
    const primitive = descriptor.primitive;
    if (primitive) {
      parts.push(
        `pr:${primitive.topology ?? ""}/${primitive.cullMode ?? ""}/` +
          `${primitive.frontFace ?? ""}/${primitive.stripIndexFormat ?? ""}/` +
          `${primitive.unclippedDepth ? 1 : 0}`,
      );
    }
    // Depth/stencil state beyond the `df:` format already pushed above.
    const ds = descriptor.depthStencil;
    if (ds) {
      parts.push(
        `dz:${ds.depthWriteEnabled ? 1 : 0}/${ds.depthCompare ?? ""}/` +
          `${ds.depthBias ?? 0}/${ds.depthBiasSlopeScale ?? 0}/${ds.depthBiasClamp ?? 0}/` +
          `${ds.stencilReadMask ?? ""}/${ds.stencilWriteMask ?? ""}/` +
          `${stencilFaceSignature(ds.stencilFront)}/${stencilFaceSignature(ds.stencilBack)}`,
      );
    }
    // Multisample mask + alpha-to-coverage (the `count` is already pushed).
    const multisample = descriptor.multisample;
    if (multisample) {
      parts.push(
        `mx:${multisample.mask ?? ""}/${multisample.alphaToCoverageEnabled ? 1 : 0}`,
      );
    }

    // SHADER IDENTITY. Unconditional and last, so every key ends in the
    // segment that makes define aliasing structurally impossible (see this
    // method's docstring). One segment rather than four: the module ids and
    // entry points are concatenated so the path pays a single allocation.
    const vertex = descriptor.vertex;
    const fragment = descriptor.fragment;
    parts.push(
      `sh:${webgpuObjectIdentity(vertex?.module)}.${vertex?.entryPoint ?? ""}` +
        `/${webgpuObjectIdentity(fragment?.module)}.${fragment?.entryPoint ?? ""}`,
    );
    // Optional producer-declared define mask. Redundant with `sh:` whenever
    // the modules came from `WebGPUShaderModuleCache`, and emitted only when
    // supplied, so keys for the (majority) producers that omit it are
    // byte-identical to what they would be without this field.
    if (
      descriptor.defines !== undefined ||
      descriptor.definesHi !== undefined
    ) {
      parts.push(
        `dfn:${(descriptor.defines ?? 0) >>> 0}.${(descriptor.definesHi ?? 0) >>> 0}`,
      );
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
      wrongModuleHits: this.stats.wrongModuleHits,
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
  /**
   * Detect a served aliased hit: the cached entry's shader modules differ
   * from the requested descriptor's. Counts only — the collision class this
   * catches is a key-construction defect, and the caller still receives the
   * cached pipeline exactly as before.
   *
   * This can only fire if
   * the `sh:` module-identity segment stopped reaching the key, because a key
   * match now implies a module match by construction. Keep it: an instrument
   * that is expected to read 0 is exactly what proves the invariant holds at
   * runtime, and `probe-pipeline-key-aliasing.mjs` cross-checks against it.
   */
  private noteWrongModuleHit(
    cached: PipelineCacheEntry,
    requested: WebGPURenderPipelineDescriptor,
  ): void {
    const vertexDiffers =
      cached.descriptor.vertex?.module !== requested.vertex?.module;
    const fragmentDiffers =
      cached.descriptor.fragment?.module !== requested.fragment?.module;
    if (vertexDiffers || fragmentDiffers) {
      this.stats.wrongModuleHits++;
    }
  }

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
