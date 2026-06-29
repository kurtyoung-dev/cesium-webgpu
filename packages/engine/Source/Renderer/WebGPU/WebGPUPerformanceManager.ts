/**
 * Central orchestrator for all WebGPU performance infrastructure activation.
 * Wires the lazy-initialized infrastructure singletons from WebGPUContext into
 * the rendering pipeline:
 *
 * 1. **Render Bundles** → Globe terrain tiles (50-80% CPU reduction for static tiles)
 * 2. **Indirect Drawing** → 3D Tiles batch rendering (GPU-driven draw calls)
 * 3. **Storage Buffers** → Point cloud / large dataset rendering
 * 4. **GPU Frustum Culling** → Compute shader visibility testing (>50K objects)
 * 5. **Timestamp Profiler** → GPU pass timing for performance analysis
 * 6. **Buffer Mapper** → Async CPU↔GPU readback for picking/readback
 * 7. **Uniform Grouping** → Per-frame/material/object bind group management
 *
 * Each feature is opt-in and threshold-gated. When disabled or below threshold,
 * the existing per-command execution path is used (zero overhead).
 *
 * @private
 * @module WebGPUPerformanceManager
 */

/// <reference types="@webgpu/types" />

// Compute shader sources (auto-generated from .wgsl files)
import AtmosphereLUTSource from "../../Shaders/WebGPU/Compute/AtmosphereLUT.js";
import PointCloudSortSource from "../../Shaders/WebGPU/Compute/PointCloudSort.js";
import PointCloudLODSource from "../../Shaders/WebGPU/Compute/PointCloudLOD.js";
import GPUSortKeysSource from "../../Shaders/WebGPU/Compute/GPUSortKeys.js";
import HiZPyramidSource from "../../Shaders/WebGPU/Compute/HiZPyramid.js";
import OcclusionTestSource from "../../Shaders/WebGPU/Compute/OcclusionTest.js";
// Phase 8a Slice 2 (Batch 85) — screen-space normal reconstruction
// from scene depth; writes into `view.gBufferFramebuffer` (Slice 1).
import GBufferNormalsFromDepthSource from "../../Shaders/WebGPU/Compute/GBufferNormalsFromDepth.js";
// Phase 8a Slice 2d (Batch 90) — multisampled-depth variant. Selected
// at execute time when the scene framebuffer is MSAA.
import GBufferNormalsFromDepthMSAASource from "../../Shaders/WebGPU/Compute/GBufferNormalsFromDepthMSAA.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  storageTexture,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import type { DebugStatsObject } from "../GraphicsContext.js";
import {
  ensureAtmosphereLUTResources as ensureAtmosphereLUTResourcesHelper,
  dispatchAtmosphereLUT as dispatchAtmosphereLUTHelper,
  dispatchAtmosphereExtendedLUT as dispatchAtmosphereExtendedLUTHelper,
} from "./WebGPUAtmosphereLUT.js";
import type { AtmosphereLUTResources } from "./WebGPUAtmosphereLUT.js";
import type {
  AsyncResourceTelemetry,
  AsyncResourceTelemetrySnapshot,
} from "./AsyncResourceTelemetry.js";

/**
 * Local interface for the context fields accessed by the performance manager.
 * Avoids importing WebGPUContext (which would cause circular dependency).
 */
interface PerformanceManagerContext {
  readonly device?: GPUDevice | null;
  supportsComputeShaders: boolean;
  computeEngine?: {
    getOrCreatePipeline(
      cacheKey: string,
      source: string,
      entryPoint: string,
      bindGroupLayouts?: GPUBindGroupLayout[],
    ): GPUComputePipeline | null;
    [key: string]: ((...args: unknown[]) => unknown) | null | string;
  } | null;
  renderBundleManager: {
    invalidate(key: string): void;
    invalidateByPrefix(prefix: string): void;
    beginFrame(): void;
    statistics?: { cacheSize: number; hitRate: number };
  } | null;
  indirectDrawManager: {
    drawCount: number;
    appendDraw(params: {
      indexCount: number;
      instanceCount: number;
      firstIndex: number;
      baseVertex: number;
      firstInstance: number;
    }): void;
    buildAndSubmit(encoder: GPUCommandEncoder): void;
    beginFrame(): void;
    flush(): void;
    addIndexedDrawCall(params: {
      indexCount: number;
      instanceCount: number;
      firstIndex: number;
      baseVertex: number;
      firstInstance: number;
    }): number;
    executeDrawIndexedIndirect(renderPass: GPURenderPassEncoder): void;
  } | null;
  timestampProfiler: {
    beginPass(encoder: GPUCommandEncoder, label: string): void;
    endPass(encoder: GPUCommandEncoder, label: string): void;
    resolveTimestamps(encoder: GPUCommandEncoder): void;
    getResults(): Record<string, number>;
    beginFrame(): void;
    endFrame(): void;
    getStatistics?(): { totalMs?: number; passes?: Record<string, number> };
    getPassTimestampWrites?(
      passName: string,
    ): GPURenderPassTimestampWrites | undefined;
    getComputePassTimestampWrites?(
      passName: string,
    ): GPUComputePassTimestampWrites | undefined;
  } | null;
  bufferMapper: {
    scheduleUpload(
      buffer: GPUBuffer,
      offset: number,
      data: ArrayBufferView,
    ): Promise<void>;
    scheduleReadback(
      buffer: GPUBuffer,
      offset: number,
      size: number,
    ): Promise<ArrayBuffer>;
    flush(): Promise<void>;
    uploadViaStagingBuffer(
      buffer: GPUBuffer,
      data: ArrayBufferView,
      offset: number,
    ): Promise<void>;
    readbackViaStagingBuffer(
      buffer: GPUBuffer,
      size: number,
      offset: number,
    ): Promise<Uint8Array | null>;
  } | null;
  /** ComputeCommand class constructor registered by WebGPUContext after
   *  the compute dispatchers are wired up. Optional — present only when
   *  the compute pipeline is active. */
  _computeCommandClass?: new (...args: unknown[]) => object;
  /**
   * NEW-WEBGPU-PERF-MONITOR-SUBSCRIBER — async-resource telemetry
   * surface. Optional because the proxy interface is consumed by both
   * production WebGPUContext (always present) and test harnesses (may
   * stub). Production callers should rely on it always being defined.
   */
  asyncResourceTelemetry?: AsyncResourceTelemetry | null;
}

/**
 * Compute task type identifiers for the dispatch orchestrator.
 */
export const ComputeTaskType = Object.freeze({
  FRUSTUM_CULL: 0,
  ATMOSPHERE_LUT: 1,
  POINT_CLOUD_SORT: 2,
  POINT_CLOUD_LOD: 3,
  GPU_SORT_KEYS: 4,
  HI_Z_PYRAMID: 5,
  OCCLUSION_TEST: 6,
  POLYGON_SDF: 7,
  // Phase 8a Slice 2 (Batch 85) — screen-space normal reconstruction.
  NORMAL_FROM_DEPTH: 8,
  // Phase 8a Slice 2d (Batch 90) — multisampled-depth variant.
  NORMAL_FROM_DEPTH_MSAA: 9,
  COUNT: 10,
} as const);

export type ComputeTaskTypeValue = (typeof ComputeTaskType)[keyof Omit<
  typeof ComputeTaskType,
  "COUNT"
>];

/**
 * Performance feature configuration.
 */
export interface PerformanceConfig {
  /** Enable render bundle caching for static terrain tiles */
  renderBundles: boolean;
  /** Enable indirect draw for batched 3D Tile rendering */
  indirectDraw: boolean;
  /** Enable GPU compute frustum culling */
  gpuCulling: boolean;
  /** Enable GPU timestamp profiling */
  timestampProfiling: boolean;
  /** Enable async buffer mapping for readback */
  bufferMapping: boolean;
  /** Enable atmosphere LUT precomputation via compute */
  atmosphereLUT: boolean;
  /** Enable GPU point cloud sort/LOD */
  gpuPointCloud: boolean;
  /** Enable GPU sort key generation for large command counts */
  gpuSortKeys: boolean;
  /** Minimum command count to activate render bundles */
  renderBundleThreshold: number;
  /** Minimum command count to activate indirect draw */
  indirectDrawThreshold: number;
  /** Minimum object count to activate GPU culling */
  gpuCullingThreshold: number;
  /** Minimum object count to activate GPU sort key generation */
  gpuSortKeysThreshold: number;
  /** Minimum point count for GPU point cloud sort/LOD */
  gpuPointCloudThreshold: number;
  /** Maximum idle frames before evicting cached render bundles */
  bundleMaxIdleFrames: number;
}

const DEFAULT_CONFIG: PerformanceConfig = {
  renderBundles: true,
  indirectDraw: true,
  gpuCulling: true,
  timestampProfiling: false, // Off by default — enable for profiling sessions
  bufferMapping: true,
  atmosphereLUT: true,
  gpuPointCloud: true,
  gpuSortKeys: true,
  renderBundleThreshold: 8,
  indirectDrawThreshold: 100,
  gpuCullingThreshold: 50000,
  gpuSortKeysThreshold: 50000,
  gpuPointCloudThreshold: 50000,
  bundleMaxIdleFrames: 300,
};

/**
 * Cached compute pipeline entry for the orchestrator.
 */
interface CachedComputeTask {
  pipeline: GPUComputePipeline;
  bindGroupLayout: GPUBindGroupLayout;
  label: string;
}

/**
 * Per-frame profiling results from GPU timestamp queries.
 *
 * Extends {@link DebugStatsObject} so instances assign directly into
 * `getRendererStatistics()` without a cast — every field is either a
 * `number` or a `Record<string, number>`, both of which satisfy
 * `DebugStatsValue`.
 */
export interface FrameTimings extends DebugStatsObject {
  /** Total GPU time for all passes (ms) */
  totalGpuMs: number;
  /** Per-pass GPU timings (ms) */
  passes: Record<string, number>;
  /** Number of render bundles executed (vs individual commands) */
  bundlesExecuted: number;
  /** Number of indirect draw calls batched */
  indirectDrawsBatched: number;
  /** Number of objects GPU-culled */
  objectsGpuCulled: number;
}

export class WebGPUPerformanceManager {
  // Public underscore: shared with the atmosphere-LUT helpers (Batch 161).
  public _context: PerformanceManagerContext;
  private _config: PerformanceConfig;
  private _frameTimings: FrameTimings;
  private _frameCount: number = 0;

  // Cached references to context infrastructure (lazy-init proxied through context)
  private _bundleManagerActive: boolean = false;
  private _indirectDrawActive: boolean = false;
  private _gpuCullerActive: boolean = false;
  private _profilerActive: boolean = false;

  // Render bundle tracking
  private _staticTileBundleKeys: Set<string> = new Set();
  private _bundleHitCount: number = 0;
  private _bundleMissCount: number = 0;

  // Compute dispatch orchestration
  private _computePipelines: Map<number, CachedComputeTask> = new Map();
  // Per-light dirty flags. Phase 1.3c adds the moon as a second LUT
  // target so dual-light scattering can run; both flags are tracked
  // independently because the sun and moon angles update at different
  // rates and the LUTs are expensive enough that recomputing both
  // every frame is wasteful.
  private _atmosphereLUTDirty: boolean = true;
  private _moonAtmosphereLUTDirty: boolean = true;
  private _computeDispatches: number = 0;

  // Subgroup-preprocessed compute sources. Lazy-built on first dispatch.
  // The PointCloudLOD shader wraps its accelerated entry point in
  // `// __SUBGROUP_BLOCK_*__` sentinels and ships WITHOUT an `enable
  // subgroups;` directive (WGSL parses `enable` only at the top of the
  // file, so a mid-file directive is a hard error). The host has to
  // either prepend the directive on capable devices or strip the entire
  // sentinel block on non-capable devices, exactly as WebGPUGPUCuller
  // does for FrustumCull.wgsl. Cache once per device — this never
  // changes for the lifetime of the GPUDevice.
  private _pointCloudLODPreparedSource: string | null = null;
  private _pointCloudLODUseSubgroups: boolean = false;

  // Atmosphere LUT GPU resources (lazy-allocated on first dispatch).
  // Phase 1.3c: holds TWO complete LUT pairs — one for the sun and one
  // for the moon — so the dual-light atmosphere fragment shader can
  // sample both with a single bind group. Each light has its own
  // params uniform buffer because the directions differ; the textures
  // are allocated up front whether or not the moon path is ever used
  // (~256 KB total — negligible).
  // Public underscore: shared with the atmosphere-LUT helpers (Batch 161).
  // Type now lives in `WebGPUAtmosphereLUT.ts` as `AtmosphereLUTResources`.
  public _atmosphereLutResources: AtmosphereLUTResources | null = null;

  // Phase 8a Slice 2 (Batch 85) — G-buffer producer compute cache.
  // Mirrors `_atmosphereLutResources` — same host-cached, dispatcher-
  // managed pattern. Allocated lazily on the first dispatch when
  // `frameState.useDeferredLighting === true`; stays null otherwise.
  public _gbufferComputeResources:
    | import("./WebGPUGBufferRenderer.js").GBufferComputeResources
    | null = null;

  constructor(
    context: PerformanceManagerContext,
    config?: Partial<PerformanceConfig>,
  ) {
    this._context = context;
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._frameTimings = this._createEmptyTimings();
  }

  /**
   * Current performance configuration. Can be modified at runtime.
   */
  get config(): PerformanceConfig {
    return this._config;
  }

  set config(value: Partial<PerformanceConfig>) {
    Object.assign(this._config, value);
  }

  // ═══════════════════════════════════════════════════════════
  // FRAME LIFECYCLE — Called by WebGPUSceneRenderer
  // ═══════════════════════════════════════════════════════════

  /**
   * Called at the start of each frame. Resets counters and begins profiling.
   */
  beginFrame(): void {
    this._frameCount++;
    this._frameTimings = this._createEmptyTimings();
    this._computeDispatches = 0;

    // Render bundle manager: begin frame tick for stale eviction
    if (this._config.renderBundles) {
      const bundleMgr = this._context.renderBundleManager;
      if (bundleMgr) {
        bundleMgr.beginFrame();
        this._bundleManagerActive = true;
      }
    }

    // Indirect draw manager: reset for new frame
    if (this._config.indirectDraw) {
      const indirectMgr = this._context.indirectDrawManager;
      if (indirectMgr) {
        indirectMgr.beginFrame();
        this._indirectDrawActive = true;
      }
    }

    // Timestamp profiler: begin frame timing
    if (this._config.timestampProfiling) {
      const profiler = this._context.timestampProfiler;
      if (profiler) {
        profiler.beginFrame();
        this._profilerActive = true;
      }
    }
  }

  /**
   * Called at the end of each frame. Flushes indirect draws and reads profiling.
   */
  endFrame(): void {
    // Flush indirect draw buffer to GPU
    if (this._indirectDrawActive) {
      const indirectMgr = this._context.indirectDrawManager;
      if (indirectMgr) {
        indirectMgr.flush();
      }
    }

    // End profiler frame and collect timings
    if (this._profilerActive) {
      const profiler = this._context.timestampProfiler;
      if (profiler) {
        profiler.endFrame();
        // Async readback — results arrive next frame
        const stats = profiler.getStatistics?.();
        if (stats) {
          this._frameTimings.totalGpuMs = stats.totalMs ?? 0;
          this._frameTimings.passes = (stats.passes ?? {}) as Record<
            string,
            number
          >;
        }
      }
    }

    this._frameTimings.bundlesExecuted = this._bundleHitCount;
    this._frameTimings.indirectDrawsBatched = this._indirectDrawActive
      ? (this._context.indirectDrawManager?.drawCount ?? 0)
      : 0;

    this._bundleHitCount = 0;
    this._bundleMissCount = 0;
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER BUNDLES — For static terrain tiles
  // ═══════════════════════════════════════════════════════════
  //
  // The actual bundle cache lives on `WebGPUContext.renderBundleManager`
  // ({@link WebGPURenderBundleManager}) and is consumed via its
  // `getOrCreate(key, builder)` API directly by the per-feature
  // dispatchers (terrain, primitives). The performance manager only
  // tracks frame-level hit/miss counters and exposes invalidation
  // helpers — it does NOT mediate the cache itself.

  /**
   * Invalidate a cached render bundle (e.g., when tile geometry changes).
   */
  invalidateBundle(bundleKey: string): void {
    if (this._bundleManagerActive) {
      this._context.renderBundleManager?.invalidate(bundleKey);
      this._staticTileBundleKeys.delete(bundleKey);
    }
  }

  /**
   * Invalidate all bundles matching a prefix (e.g., all globe terrain bundles).
   */
  invalidateBundlesByPrefix(prefix: string): void {
    if (this._bundleManagerActive) {
      this._context.renderBundleManager?.invalidateByPrefix(prefix);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // INDIRECT DRAWING — For 3D Tiles batch rendering
  // ═══════════════════════════════════════════════════════════

  /**
   * Queue an indexed draw call for indirect execution.
   * When count exceeds threshold, draws are batched into an indirect buffer.
   *
   * @param indexCount - Number of indices
   * @param instanceCount - Number of instances
   * @param firstIndex - First index offset
   * @param baseVertex - Base vertex offset
   * @param firstInstance - First instance offset
   * @returns Draw call index for potential GPU culling, or -1 if not batched
   */
  queueIndirectDraw(
    indexCount: number,
    instanceCount: number,
    firstIndex: number,
    baseVertex: number,
    firstInstance: number,
  ): number {
    if (!this._indirectDrawActive) {
      return -1;
    }
    const mgr = this._context.indirectDrawManager;
    if (!mgr) {
      return -1;
    }
    return mgr.addIndexedDrawCall({
      indexCount,
      instanceCount,
      firstIndex,
      baseVertex,
      firstInstance,
    });
  }

  /**
   * Execute all queued indirect draw calls.
   * @param renderPass - Active render pass encoder
   */
  executeIndirectDraws(renderPass: GPURenderPassEncoder): void {
    if (!this._indirectDrawActive) {
      return;
    }
    const mgr = this._context.indirectDrawManager;
    if (mgr && mgr.drawCount > 0) {
      mgr.flush();
      mgr.executeDrawIndexedIndirect(renderPass);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // GPU FRUSTUM CULLING — Compute shader visibility
  // ═══════════════════════════════════════════════════════════

  /**
   * Check if GPU culling should be used for the current command count.
   * @param objectCount - Number of objects to cull
   * @returns true if GPU culling should be used
   */
  shouldUseGPUCulling(objectCount: number): boolean {
    return (
      this._config.gpuCulling &&
      objectCount >= this._config.gpuCullingThreshold &&
      this._context.supportsComputeShaders
    );
  }

  /**
   * Get the GPU culler instance for direct use by the scene renderer.
   * Returns null if GPU culling is disabled or unavailable.
   */
  getGPUCuller(): CesiumOpaqueObject | null {
    if (!this._config.gpuCulling || !this._context.supportsComputeShaders) {
      return null;
    }
    // The culler is not lazy-initialized on WebGPUContext, so we'd need
    // to import it directly. For now, return the context's reference if set.
    return null; // GPU culler activation deferred until 3D Tiles phase
  }

  // ═══════════════════════════════════════════════════════════
  // TIMESTAMP PROFILING — GPU pass timing
  // ═══════════════════════════════════════════════════════════

  /**
   * Get timestamp writes for a render pass descriptor.
   * Returns undefined if profiling is disabled, so the pass runs without timing.
   *
   * @param passName - Label for the pass (e.g., "globe", "opaque", "translucent")
   */
  getPassTimestampWrites(
    passName: string,
  ): GPURenderPassTimestampWrites | undefined {
    if (!this._profilerActive) {
      return undefined;
    }
    const profiler = this._context.timestampProfiler;
    return profiler?.getPassTimestampWrites?.(passName);
  }

  /**
   * Get timestamp writes for a compute pass descriptor.
   */
  getComputePassTimestampWrites(
    passName: string,
  ): GPUComputePassTimestampWrites | undefined {
    if (!this._profilerActive) {
      return undefined;
    }
    const profiler = this._context.timestampProfiler;
    return profiler?.getComputePassTimestampWrites?.(passName);
  }

  // ═══════════════════════════════════════════════════════════
  // BUFFER MAPPING — Async CPU↔GPU access
  // ═══════════════════════════════════════════════════════════

  /**
   * Upload data to a GPU buffer via staging buffer (non-blocking).
   * Uses the BufferMapper for efficient mapAsync + copy pipeline.
   *
   * @param targetBuffer - Destination GPU buffer
   * @param data - Source data (TypedArray)
   * @param offset - Byte offset in target buffer
   */
  async uploadViaStaging(
    targetBuffer: GPUBuffer,
    data: ArrayBufferView,
    offset: number = 0,
  ): Promise<void> {
    if (!this._config.bufferMapping) {
      // Fallback: use queue.writeBuffer (synchronous, but simpler)
      this._context.device?.queue.writeBuffer(targetBuffer, offset, data);
      return;
    }
    const mapper = this._context.bufferMapper;
    if (mapper) {
      await mapper.uploadViaStagingBuffer(targetBuffer, data, offset);
    } else {
      this._context.device?.queue.writeBuffer(targetBuffer, offset, data);
    }
  }

  /**
   * Read data from a GPU buffer asynchronously.
   *
   * @param sourceBuffer - Source GPU buffer
   * @param size - Number of bytes to read
   * @param offset - Byte offset in source buffer
   * @returns Typed array with the data, or null on failure
   */
  async readbackBuffer(
    sourceBuffer: GPUBuffer,
    size: number,
    offset: number = 0,
  ): Promise<Uint8Array | null> {
    const mapper = this._context.bufferMapper;
    if (mapper) {
      return mapper.readbackViaStagingBuffer(sourceBuffer, size, offset);
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // COMPUTE DISPATCH ORCHESTRATOR
  // ═══════════════════════════════════════════════════════════

  /**
   * Get the WGSL source for a compute task type.
   * Pipelines are created lazily on first use via WebGPUComputeEngine.
   */
  getComputeShaderSource(taskType: number): string | null {
    switch (taskType) {
      case ComputeTaskType.ATMOSPHERE_LUT:
        return AtmosphereLUTSource;
      case ComputeTaskType.POINT_CLOUD_SORT:
        return PointCloudSortSource;
      case ComputeTaskType.POINT_CLOUD_LOD:
        return PointCloudLODSource;
      case ComputeTaskType.GPU_SORT_KEYS:
        return GPUSortKeysSource;
      case ComputeTaskType.HI_Z_PYRAMID:
        return HiZPyramidSource;
      case ComputeTaskType.OCCLUSION_TEST:
        return OcclusionTestSource;
      case ComputeTaskType.NORMAL_FROM_DEPTH:
        return GBufferNormalsFromDepthSource;
      case ComputeTaskType.NORMAL_FROM_DEPTH_MSAA:
        return GBufferNormalsFromDepthMSAASource;
      default:
        return null;
    }
  }

  /**
   * Check if GPU sort key generation should be used for a command count.
   * Falls back to WASM radix sort (5K-50K) or JS multi-level comparator (<5K).
   */
  shouldUseGPUSortKeys(commandCount: number): boolean {
    return (
      this._config.gpuSortKeys &&
      commandCount >= this._config.gpuSortKeysThreshold &&
      this._context.supportsComputeShaders
    );
  }

  /**
   * Check if GPU point cloud sort/LOD should be used for a point count.
   * Falls back to WASM SIMD point cloud processing for smaller datasets.
   */
  shouldUseGPUPointCloud(pointCount: number): boolean {
    return (
      this._config.gpuPointCloud &&
      pointCount >= this._config.gpuPointCloudThreshold &&
      this._context.supportsComputeShaders
    );
  }

  /**
   * Check if the atmosphere LUT should be recomputed this frame.
   * The LUT only needs regeneration when sun direction changes significantly
   * or on first render. Calling this clears the dirty flag.
   */
  shouldRecomputeAtmosphereLUT(): boolean {
    if (!this._config.atmosphereLUT || !this._context.supportsComputeShaders) {
      return false;
    }
    if (this._atmosphereLUTDirty) {
      this._atmosphereLUTDirty = false;
      return true;
    }
    return false;
  }

  /**
   * Mark the (sun) atmosphere LUT as needing recomputation. Called by the
   * sky atmosphere renderer when the sun direction has moved beyond the
   * stale-tolerance threshold. The moon LUT has its own dirty flag and
   * is invalidated separately via `invalidateMoonAtmosphereLUT()`.
   */
  invalidateAtmosphereLUT(): void {
    this._atmosphereLUTDirty = true;
  }

  /**
   * Phase 1.3c — moon LUT companion to `shouldRecomputeAtmosphereLUT()`.
   * Returns true once when the moon direction (or scattering parameters
   * affecting the moon LUT) have changed since the last dispatch and
   * compute is available; clears the dirty flag on the read path.
   */
  shouldRecomputeMoonAtmosphereLUT(): boolean {
    if (!this._config.atmosphereLUT || !this._context.supportsComputeShaders) {
      return false;
    }
    if (this._moonAtmosphereLUTDirty) {
      this._moonAtmosphereLUTDirty = false;
      return true;
    }
    return false;
  }

  /**
   * Phase 1.3c — flag the moon LUT as needing recomputation. The sky
   * atmosphere renderer calls this when the moon direction crosses the
   * stale-tolerance threshold (analogous to `invalidateAtmosphereLUT`
   * for the sun).
   */
  invalidateMoonAtmosphereLUT(): void {
    this._moonAtmosphereLUTDirty = true;
  }

  /**
   * Lazy-create the GPU resources backing the atmosphere LUT system.
   * Phase 1.3c allocates BOTH the sun and moon LUT pairs in one shot:
   * two storage textures per light (transmittance + inscatter), one
   * AtmosphereParams uniform buffer per light, and a shared bind group
   * layout. Returns the four texture views the sky atmosphere fragment
   * shader binds for dual-light scattering.
   *
   * The textures use rgba16float storage format (WebGPU core, no feature
   * flag required) and are created with TEXTURE_BINDING usage as well so
   * downstream samplers can read them. The moon pair is allocated even
   * when `enableDualLightAtmosphere` is off — it's ~256 KB total and
   * having both up front lets the sky bind group layout stay constant.
   *
   * @param device GPUDevice (passed in to avoid coupling to context shape)
   */
  ensureAtmosphereLUTResources(device: GPUDevice): {
    transmittanceView: GPUTextureView;
    inscatterView: GPUTextureView;
    moonTransmittanceView: GPUTextureView;
    moonInscatterView: GPUTextureView;
    // Batch 427 (SKY-MS) — surfaced so the sky renderer can bind the
    // multiple-scattering LUT at group(1) without a separate accessor call.
    multipleScatterView: GPUTextureView;
  } | null {
    return ensureAtmosphereLUTResourcesHelper(this, device);
  }

  /**
   * Track V-A1 (NEW-ATMO-BRUNETON-FULL-LUTS) — dispatch the multiple-
   * scattering + irradiance extension passes for the SUN LUT pair. Must run
   * after a `dispatchAtmosphereLUT(…, "sun")` in the same frame so the
   * transmittance + single-scattering inputs are populated. Returns false if
   * compute is unavailable or the LUT resources have not been allocated yet.
   */
  dispatchAtmosphereExtendedLUT(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
  ): boolean {
    return dispatchAtmosphereExtendedLUTHelper(this, encoder, device);
  }

  /**
   * Track V-A1 — direct accessor for the extended LUT texture views
   * (multiple-scattering + irradiance), for consumers/probes that read them.
   * Returns null until {@link ensureAtmosphereLUTResources} has run.
   */
  getAtmosphereExtendedLUTViews(): {
    multipleScatterView: GPUTextureView;
    irradianceView: GPUTextureView;
  } | null {
    const lut = this._atmosphereLutResources;
    if (!lut) return null;
    return {
      multipleScatterView: lut.multipleScatterView,
      irradianceView: lut.irradianceView,
    };
  }

  /**
   * Dispatch both LUT compute entry points (computeTransmittance,
   * computeInscatter) into the requested light's LUT pair. Phase 1.3c
   * adds the `target: "sun" | "moon"` parameter so the sky atmosphere
   * renderer can refresh either pair independently. The caller is
   * responsible for tracking direction-change deltas and calling the
   * matching `invalidateAtmosphereLUT()` / `invalidateMoonAtmosphereLUT()`
   * before dispatch.
   *
   * The `params.sunDirection` field is keyed off the param name only —
   * the moon dispatch passes the moon direction here under the same key.
   * The shader still calls its uniform `sunDirection` because renaming
   * it would force a four-shader-file rename of the AtmosphereLUT.wgsl
   * compute kernel; the semantic is "the light direction for THIS LUT."
   *
   * Sample call site:
   *   if (perfMgr.shouldRecomputeAtmosphereLUT()) {
   *     perfMgr.dispatchAtmosphereLUT(encoder, device, {
   *       innerRadius: 6371000, outerRadius: 6471000,
   *       rayleighScaleHeight: 8000, mieScaleHeight: 1200,
   *       mieAnisotropy: 0.76, intensity: 1.0,
   *       rayleighCoefficient: [5.8e-6, 13.5e-6, 33.1e-6],
   *       mieCoefficient: [21e-6, 21e-6, 21e-6],
   *       sunDirection: [sx, sy, sz],
   *     }, "sun");
   *   }
   *
   * @returns true on success, false if compute is unavailable
   */
  dispatchAtmosphereLUT(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
    params: {
      innerRadius: number;
      outerRadius: number;
      rayleighScaleHeight: number;
      mieScaleHeight: number;
      mieAnisotropy: number;
      intensity: number;
      rayleighCoefficient: [number, number, number];
      mieCoefficient: [number, number, number];
      sunDirection: [number, number, number];
    },
    target: "sun" | "moon" = "sun",
  ): boolean {
    return dispatchAtmosphereLUTHelper(this, encoder, device, params, target);
  }

  /**
   * Lazily prepare the PointCloudLOD shader source for the current device's
   * subgroup capability. Returns the preprocessed source string and the
   * entry-point name that should be used at dispatch time.
   *
   * On a subgroup-capable device this prepends `enable subgroups;` and
   * keeps both `computeMain` + `computeMainSubgroups` in the module so
   * the caller can pick one. On a non-capable device the sentinel block
   * around `computeMainSubgroups` is stripped entirely so the parser
   * never sees `subgroupBallot`/`subgroup_invocation_id` calls — those
   * would be a hard validation error without the feature.
   *
   * Mirrors the same preprocessing pattern WebGPUGPUCuller uses for
   * FrustumCull.wgsl. Cached on `this` because the device feature set
   * is fixed for the lifetime of the GPUDevice.
   *
   * @private
   */
  private preparePointCloudLODSource(device: GPUDevice): {
    source: string;
    entryPoint: string;
    useSubgroups: boolean;
  } {
    if (!this._pointCloudLODPreparedSource) {
      const raw = this.getComputeShaderSource(ComputeTaskType.POINT_CLOUD_LOD);
      const useSubgroups = device.features.has("subgroups" as GPUFeatureName);
      let prepared: string;
      if (useSubgroups) {
        prepared = `enable subgroups;\n${raw}`;
      } else {
        prepared = raw.replace(
          /\/\/ __SUBGROUP_BLOCK_START__[\s\S]*?\/\/ __SUBGROUP_BLOCK_END__/,
          "// (subgroup variant stripped — feature not present)",
        );
      }
      this._pointCloudLODPreparedSource = prepared;
      this._pointCloudLODUseSubgroups = useSubgroups;
    }
    return {
      source: this._pointCloudLODPreparedSource,
      entryPoint: this._pointCloudLODUseSubgroups
        ? "computeMainSubgroups"
        : "computeMain",
      useSubgroups: this._pointCloudLODUseSubgroups,
    };
  }

  /**
   * Dispatch the PointCloudLOD compute pass with automatic subgroup
   * variant selection. Caller is responsible for building the bind
   * group(s) per `PointCloudLOD.wgsl`'s @group(0) layout (params UBO,
   * three position storage buffers, the visibleIndices output, and the
   * visibleCount atomic).
   *
   * Returns true on a successful dispatch, false if compute is unavailable
   * or the cached compute engine isn't ready yet — callers should fall
   * back to a CPU LOD path in that case.
   *
   * Workgroup size in the shader is 256, so caller passes
   * `workgroupCount = ceil(pointCount / 256)`.
   *
   * @example
   *   const ok = perfMgr.dispatchPointCloudLOD(
   *     encoder, device, pointBindGroup, Math.ceil(pointCount / 256),
   *   );
   *   if (!ok) { runCpuLodFallback(); }
   */
  dispatchPointCloudLOD(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
    bindGroup: GPUBindGroup,
    workgroupCount: number,
  ): boolean {
    if (!this._context.supportsComputeShaders) return false;
    const computeEngine = this._context.computeEngine;
    if (!computeEngine) return false;
    if (workgroupCount <= 0) return false;

    const prepared = this.preparePointCloudLODSource(device);

    // Cache key includes the entry point so the scalar and subgroup
    // pipelines coexist if a single device ever needs both (it doesn't
    // today, but the cost is one extra map entry).
    const cacheKey = `perfmgr:pointCloudLOD:${prepared.entryPoint}`;
    const pipeline = computeEngine.getOrCreatePipeline(
      cacheKey,
      prepared.source,
      prepared.entryPoint,
    );
    if (!pipeline) return false;

    const label = this._getTaskLabel(ComputeTaskType.POINT_CLOUD_LOD);
    const timestampWrites = this.getComputePassTimestampWrites(label);
    const computePass = encoder.beginComputePass({
      label: `ComputePass_${label}_${prepared.entryPoint}`,
      ...(timestampWrites ? { timestampWrites } : {}),
    });
    computePass.setPipeline(pipeline);
    computePass.setBindGroup(0, bindGroup);
    computePass.dispatchWorkgroups(workgroupCount, 1, 1);
    computePass.end();

    this._computeDispatches++;
    return true;
  }

  /**
   * Reports whether the PointCloudLOD dispatcher will pick the
   * subgroup-accelerated entry point on this device. Useful for diagnostics
   * and for letting callers tag their bind groups / counters accordingly.
   * Calling this lazily prepares the cached source if needed.
   */
  pointCloudLODUsesSubgroups(device: GPUDevice): boolean {
    if (!this._context.supportsComputeShaders) return false;
    return this.preparePointCloudLODSource(device).useSubgroups;
  }

  // ═══════════════════════════════════════════════════════════
  // FORK-41: Hi-Z PYRAMID + OCCLUSION TEST DISPATCHERS
  // ═══════════════════════════════════════════════════════════
  //
  // The Hi-Z pyramid is a hierarchical depth buffer (mip chain of
  // max-Z reductions over previous-frame depth). The occlusion test
  // shader uses it to mark commands whose bounding spheres are fully
  // hidden by previously-drawn geometry, so a CPU-side culler can
  // drop them before the next frame's draw submission.
  //
  // Both shaders ship as compiled .js modules and were already
  // registered in `getComputeShaderSource()`. The host responsibility
  // is twofold: build the per-mip / per-frame bind groups, and call
  // the dispatchers below at the right point in the frame loop. The
  // dispatchers themselves are pure compute-pass orchestration —
  // they don't allocate any GPU resources.
  //
  // Today nothing in the renderer pipeline calls these. They're
  // wired up so that an opt-in occlusion stage can flip on with a
  // ContextOptions flag once the host bind-group plumbing lands. The
  // dispatchers are validated by the spec coverage in
  // packages/engine/Specs/Renderer/WebGPU/WebGPUSubgroupUtilsSpec.js
  // and exercised by the same shader pipeline cache that
  // PointCloudLOD goes through.

  /**
   * Dispatch one mip level of the Hi-Z pyramid build. Caller is
   * responsible for:
   *  - Allocating the source mip texture (`r32float`, must be sampleable)
   *  - Allocating the destination storage texture for THIS mip
   *  - Building a bind group matching `HiZPyramid.wgsl`'s @group(0):
   *      binding 0: depthInput texture_2d
   *      binding 1: hiZOutput texture_storage_2d<r32float, write>
   *      binding 2: HiZParams uniform buffer
   *
   * The dispatch grid covers a 16×16 workgroup tile per output texel,
   * matching the shader's `@workgroup_size(16, 16, 1)`. Round up the
   * grid via `Math.ceil(outputDim / 16)`.
   *
   * Returns true on a successful record, false if compute is
   * unavailable, the compute engine isn't ready, or `outputWidth` /
   * `outputHeight` are zero. Callers should treat false as "skip the
   * Hi-Z pass this frame and reuse the previous one."
   *
   * @example
   *   for (let mip = 1; mip < mipLevels; mip++) {
   *     perfMgr.dispatchHiZPyramid(
   *       encoder,
   *       hiZBindGroups[mip],
   *       outputWidthAtMip,
   *       outputHeightAtMip,
   *     );
   *   }
   */
  dispatchHiZPyramid(
    encoder: GPUCommandEncoder,
    bindGroup: GPUBindGroup,
    outputWidth: number,
    outputHeight: number,
  ): boolean {
    if (!this._context.supportsComputeShaders) return false;
    if (outputWidth <= 0 || outputHeight <= 0) return false;
    const computeEngine = this._context.computeEngine;
    if (!computeEngine) return false;

    const source = this.getComputeShaderSource(ComputeTaskType.HI_Z_PYRAMID);
    if (!source) return false;

    // Hi-Z has a single entry point and the shader source never
    // changes per device, so the cache key can be flat.
    const cacheKey = "perfmgr:hiZPyramid:computeMain";
    const pipeline = computeEngine.getOrCreatePipeline(
      cacheKey,
      source,
      "computeMain",
    );
    if (!pipeline) return false;

    const label = this._getTaskLabel(ComputeTaskType.HI_Z_PYRAMID);
    const timestampWrites = this.getComputePassTimestampWrites(label);

    // Workgroup size is 16×16, so the dispatch grid is the output
    // texel count divided by 16, rounded up. Z is always 1 since
    // each mip level is a 2D image.
    const wgsX = Math.ceil(outputWidth / 16);
    const wgsY = Math.ceil(outputHeight / 16);

    const computePass = encoder.beginComputePass({
      label: `ComputePass_${label}`,
      ...(timestampWrites ? { timestampWrites } : {}),
    });
    computePass.setPipeline(pipeline);
    computePass.setBindGroup(0, bindGroup);
    computePass.dispatchWorkgroups(wgsX, wgsY, 1);
    computePass.end();

    this._computeDispatches++;
    return true;
  }

  /**
   * Dispatch the local bitonic sort phase of `PointCloudSort.wgsl`.
   * This is the first phase: each workgroup independently sorts its
   * 256-element block in shared memory. The host then calls
   * `dispatchPointCloudGlobalMerge` for each (k, j) pair where
   * k > 256 to merge the workgroup-local sorted blocks into a
   * single globally-sorted array.
   *
   * Caller builds a single bind group matching `PointCloudSort.wgsl`'s
   * @group(0) layout (params UBO + sortKeys + indices storage buffers)
   * and the SortParams.elementCount must already be written.
   *
   * @example
   *   const N = elementCount;
   *   perfMgr.dispatchPointCloudLocalSort(encoder, sortBG, N);
   *   for (let k = 512; k <= N; k <<= 1) {
   *     for (let j = k >> 1; j > 0; j >>= 1) {
   *       // host updates SortParams.k / .j on the UBO before each call
   *       perfMgr.dispatchPointCloudGlobalMerge(encoder, sortBG, N);
   *     }
   *   }
   */
  dispatchPointCloudLocalSort(
    encoder: GPUCommandEncoder,
    bindGroup: GPUBindGroup,
    elementCount: number,
  ): boolean {
    return this._dispatchPointCloudSortPhase(
      encoder,
      bindGroup,
      elementCount,
      "localBitonicSort",
    );
  }

  /**
   * Dispatch one global merge step of the bitonic sort across
   * workgroups. Called once per (k, j) pair after the local phase.
   * The caller is responsible for updating the SortParams uniform
   * with the new k/j values *before* this call.
   */
  dispatchPointCloudGlobalMerge(
    encoder: GPUCommandEncoder,
    bindGroup: GPUBindGroup,
    elementCount: number,
  ): boolean {
    return this._dispatchPointCloudSortPhase(
      encoder,
      bindGroup,
      elementCount,
      "globalBitonicMerge",
    );
  }

  /**
   * Shared body for the two PointCloudSort phases. Both entry points
   * use the same bind group and the same workgroup size; only the
   * shader entry point and the cache key differ.
   *
   * @private
   */
  private _dispatchPointCloudSortPhase(
    encoder: GPUCommandEncoder,
    bindGroup: GPUBindGroup,
    elementCount: number,
    entryPoint: string,
  ): boolean {
    if (!this._context.supportsComputeShaders) return false;
    if (elementCount <= 0) return false;
    const computeEngine = this._context.computeEngine;
    if (!computeEngine) return false;

    const source = this.getComputeShaderSource(
      ComputeTaskType.POINT_CLOUD_SORT,
    );
    if (!source) return false;

    const cacheKey = `perfmgr:pointCloudSort:${entryPoint}`;
    const pipeline = computeEngine.getOrCreatePipeline(
      cacheKey,
      source,
      entryPoint,
    );
    if (!pipeline) return false;

    const label = this._getTaskLabel(ComputeTaskType.POINT_CLOUD_SORT);
    const timestampWrites = this.getComputePassTimestampWrites(label);

    // Workgroup size is 256 in both entry points; one thread per element.
    const wgsX = Math.ceil(elementCount / 256);

    const computePass = encoder.beginComputePass({
      label: `ComputePass_${label}_${entryPoint}`,
      ...(timestampWrites ? { timestampWrites } : {}),
    });
    computePass.setPipeline(pipeline);
    computePass.setBindGroup(0, bindGroup);
    computePass.dispatchWorkgroups(wgsX, 1, 1);
    computePass.end();

    this._computeDispatches++;
    return true;
  }

  /**
   * Dispatch the GPU sort key generator. Produces packed 64-bit sort
   * keys (high + low u32) for `commandCount` draw commands so the
   * subsequent sort pass can reorder commands without a CPU comparator.
   *
   * Caller builds a bind group matching `GPUSortKeys.wgsl`'s @group(0)
   * layout (params UBO + 6 SOA input storage buffers + 3 output
   * storage buffers — 10 bindings total). The visibility / threshold
   * decision should already be made via `shouldUseGPUSortKeys()`.
   *
   * @example
   *   if (perfMgr.shouldUseGPUSortKeys(commandCount)) {
   *     perfMgr.dispatchGPUSortKeys(encoder, sortKeysBG, commandCount);
   *   }
   */
  dispatchGPUSortKeys(
    encoder: GPUCommandEncoder,
    bindGroup: GPUBindGroup,
    commandCount: number,
  ): boolean {
    if (!this._context.supportsComputeShaders) return false;
    if (commandCount <= 0) return false;
    const computeEngine = this._context.computeEngine;
    if (!computeEngine) return false;

    const source = this.getComputeShaderSource(ComputeTaskType.GPU_SORT_KEYS);
    if (!source) return false;

    const cacheKey = "perfmgr:gpuSortKeys:computeMain";
    const pipeline = computeEngine.getOrCreatePipeline(
      cacheKey,
      source,
      "computeMain",
    );
    if (!pipeline) return false;

    const label = this._getTaskLabel(ComputeTaskType.GPU_SORT_KEYS);
    const timestampWrites = this.getComputePassTimestampWrites(label);

    // Workgroup size 256, one thread per command.
    const wgsX = Math.ceil(commandCount / 256);

    const computePass = encoder.beginComputePass({
      label: `ComputePass_${label}`,
      ...(timestampWrites ? { timestampWrites } : {}),
    });
    computePass.setPipeline(pipeline);
    computePass.setBindGroup(0, bindGroup);
    computePass.dispatchWorkgroups(wgsX, 1, 1);
    computePass.end();

    this._computeDispatches++;
    return true;
  }

  /**
   * Dispatch the per-command occlusion test against a previously-built
   * Hi-Z pyramid. Caller is responsible for:
   *  - Building the SOA bounding sphere storage buffers
   *  - Allocating the visibility output buffer (`array<u32>`,
   *    `commandCount` elements)
   *  - Building a bind group matching `OcclusionTest.wgsl`'s
   *    @group(0): params UBO + Hi-Z texture + sampler + 4 sphere SOA
   *    storage buffers + visibility output (8 bindings total)
   *
   * The shader's workgroup size is 256, so the dispatch grid is
   * `ceil(commandCount / 256)` in X and 1 in Y/Z.
   *
   * Returns true on success, false if compute is unavailable, the
   * compute engine isn't ready, or `commandCount` is zero. False
   * means the caller should treat all commands as "visible" — the
   * test never produces false positives, only false negatives, so
   * skipping it on failure preserves correctness.
   *
   * @example
   *   const ok = perfMgr.dispatchOcclusionTest(
   *     encoder,
   *     occBindGroup,
   *     commands.length,
   *   );
   *   if (!ok) { allCommandsVisible = true; }
   */
  dispatchOcclusionTest(
    encoder: GPUCommandEncoder,
    bindGroup: GPUBindGroup,
    commandCount: number,
  ): boolean {
    if (!this._context.supportsComputeShaders) return false;
    if (commandCount <= 0) return false;
    const computeEngine = this._context.computeEngine;
    if (!computeEngine) return false;

    const source = this.getComputeShaderSource(ComputeTaskType.OCCLUSION_TEST);
    if (!source) return false;

    const cacheKey = "perfmgr:occlusionTest:computeMain";
    const pipeline = computeEngine.getOrCreatePipeline(
      cacheKey,
      source,
      "computeMain",
    );
    if (!pipeline) return false;

    const label = this._getTaskLabel(ComputeTaskType.OCCLUSION_TEST);
    const timestampWrites = this.getComputePassTimestampWrites(label);

    // Workgroup size 256 along X, one thread per command.
    const wgsX = Math.ceil(commandCount / 256);

    const computePass = encoder.beginComputePass({
      label: `ComputePass_${label}`,
      ...(timestampWrites ? { timestampWrites } : {}),
    });
    computePass.setPipeline(pipeline);
    computePass.setBindGroup(0, bindGroup);
    computePass.dispatchWorkgroups(wgsX, 1, 1);
    computePass.end();

    this._computeDispatches++;
    return true;
  }

  /**
   * Dispatch a compute task on the current frame's command encoder.
   * Uses WebGPUComputeEngine for pipeline caching and execution.
   *
   * @param encoder - GPU command encoder to record the compute pass on
   * @param taskType - ComputeTaskType enum value
   * @param bindGroups - Bind groups for the dispatch
   * @param workgroupsX - Number of workgroups in X
   * @param workgroupsY - Number of workgroups in Y (default 1)
   * @param workgroupsZ - Number of workgroups in Z (default 1)
   * @param entryPoint - Shader entry point name (default "computeMain")
   */
  dispatchCompute(
    encoder: GPUCommandEncoder,
    taskType: number,
    bindGroups: { index: number; bindGroup: GPUBindGroup }[],
    workgroupsX: number,
    workgroupsY: number = 1,
    workgroupsZ: number = 1,
    entryPoint: string = "computeMain",
    bindGroupLayouts?: GPUBindGroupLayout[],
  ): void {
    const computeEngine = this._context.computeEngine;
    if (!computeEngine) return;

    const source = this.getComputeShaderSource(taskType);
    if (!source) return;

    const label = this._getTaskLabel(taskType);
    const timestampWrites = this.getComputePassTimestampWrites(label);

    const WebGPUComputeCommand = this._context._computeCommandClass;

    // Use ComputeEngine's pipeline caching via getOrCreatePipeline. When the
    // caller supplies explicit bindGroupLayouts (V0 — the atmosphere extended
    // passes), the pipeline is built with that explicit layout instead of
    // layout:"auto", so a full bind group with bindings the kernel doesn't
    // statically use stays valid. The layout is keyed by entryPoint, so the two
    // extended kernels (which share a layout) cache independently of the
    // auto-layout LUT kernels.
    const cacheKey = `perfmgr:${label}:${entryPoint}`;
    const pipeline = computeEngine.getOrCreatePipeline(
      cacheKey,
      source,
      entryPoint,
      bindGroupLayouts,
    );

    // Create and dispatch compute pass
    const computePass = encoder.beginComputePass({
      label: `ComputePass_${label}`,
      ...(timestampWrites ? { timestampWrites } : {}),
    });

    computePass.setPipeline(pipeline);
    for (const bg of bindGroups) {
      computePass.setBindGroup(bg.index, bg.bindGroup);
    }
    computePass.dispatchWorkgroups(workgroupsX, workgroupsY, workgroupsZ);
    computePass.end();

    this._computeDispatches++;
  }

  /**
   * Returns the recommended compute approach for a given task and data size.
   * Implements the GPU Compute vs WASM decision matrix from .clinerules.
   *
   * @returns 'gpu' | 'wasm' | 'js' indicating the recommended approach
   */
  getRecommendedApproach(
    taskType: number,
    elementCount: number,
  ): "gpu" | "wasm" | "js" {
    const hasCompute = this._context.supportsComputeShaders;

    switch (taskType) {
      case ComputeTaskType.FRUSTUM_CULL:
        if (hasCompute && elementCount >= 50000) return "gpu";
        if (elementCount >= 100) return "wasm";
        return "js";

      case ComputeTaskType.ATMOSPHERE_LUT:
        // Always GPU when available — ray marching is massively parallel
        return hasCompute ? "gpu" : "js";

      case ComputeTaskType.POINT_CLOUD_SORT:
      case ComputeTaskType.POINT_CLOUD_LOD:
        if (hasCompute && elementCount >= 50000) return "gpu";
        if (elementCount >= 1000) return "wasm";
        return "js";

      case ComputeTaskType.GPU_SORT_KEYS:
        if (hasCompute && elementCount >= 50000) return "gpu";
        if (elementCount >= 5000) return "wasm";
        return "js";

      case ComputeTaskType.HI_Z_PYRAMID:
      case ComputeTaskType.OCCLUSION_TEST:
        // These are inherently GPU-only operations
        return hasCompute ? "gpu" : "js";

      case ComputeTaskType.POLYGON_SDF:
        return hasCompute ? "gpu" : "js";

      case ComputeTaskType.NORMAL_FROM_DEPTH:
      case ComputeTaskType.NORMAL_FROM_DEPTH_MSAA:
        // Screen-space derivative pass — only meaningful with compute +
        // depth-texture sampling. No JS / WASM fallback path; the
        // deferred-lighting flag should already gate the producer
        // upstream when compute is unavailable.
        return hasCompute ? "gpu" : "js";

      default:
        return "js";
    }
  }

  /** Number of compute dispatches in the current frame. */
  get computeDispatches(): number {
    return this._computeDispatches;
  }

  /** Map a ComputeTaskType to a human-readable label. */
  private _getTaskLabel(taskType: number): string {
    switch (taskType) {
      case ComputeTaskType.FRUSTUM_CULL:
        return "frustumCull";
      case ComputeTaskType.ATMOSPHERE_LUT:
        return "atmosphereLUT";
      case ComputeTaskType.POINT_CLOUD_SORT:
        return "pointCloudSort";
      case ComputeTaskType.POINT_CLOUD_LOD:
        return "pointCloudLOD";
      case ComputeTaskType.GPU_SORT_KEYS:
        return "gpuSortKeys";
      case ComputeTaskType.HI_Z_PYRAMID:
        return "hiZPyramid";
      case ComputeTaskType.OCCLUSION_TEST:
        return "occlusionTest";
      case ComputeTaskType.POLYGON_SDF:
        return "polygonSDF";
      case ComputeTaskType.NORMAL_FROM_DEPTH:
        return "normalFromDepth";
      case ComputeTaskType.NORMAL_FROM_DEPTH_MSAA:
        return "normalFromDepthMSAA";
      default:
        return `compute_${taskType}`;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // DIAGNOSTICS
  // ═══════════════════════════════════════════════════════════

  /**
   * Get the most recent frame timing results.
   */
  get frameTimings(): FrameTimings {
    return this._frameTimings;
  }

  /**
   * NEW-WEBGPU-PERF-MONITOR-SUBSCRIBER — snapshot the per-kind
   * async-resource latency / throughput / failure stats. Returns
   * `null` if the context didn't wire telemetry (test harnesses,
   * stripped builds). Production callers can rely on a snapshot.
   *
   * Use cases for the perf manager:
   *   - Decide when to throttle pipeline-variant generation
   *     (e.g., `render-pipeline.p95Ms > budget` ⇒ stop warming
   *     non-essential variants this frame).
   *   - Defer non-critical compute dispatches when
   *     `compute-pipeline.currentInflight` is high.
   *   - Surface failure rates so persistent rejection (driver bug,
   *     bad shader variant) becomes visible without manual log review.
   */
  getAsyncResourceStats(): AsyncResourceTelemetrySnapshot | null {
    const telemetry = this._context.asyncResourceTelemetry;
    if (!telemetry) {
      return null;
    }
    return telemetry.snapshot();
  }

  /**
   * Get a formatted diagnostics string for debugging.
   */
  getDiagnostics(): string {
    const cfg = this._config;
    const bundleMgr = this._context.renderBundleManager;
    const bundleStats = bundleMgr?.statistics ?? { cacheSize: 0, hitRate: 0 };
    const profiler = this._context.timestampProfiler;

    return [
      `[WebGPU Performance Manager]`,
      `  Frame: ${this._frameCount}`,
      `  Render Bundles: ${cfg.renderBundles ? "ON" : "OFF"} (cache: ${bundleStats.cacheSize}, hit rate: ${(bundleStats.hitRate * 100).toFixed(1)}%)`,
      `  Indirect Draw: ${cfg.indirectDraw ? "ON" : "OFF"}`,
      `  GPU Culling: ${cfg.gpuCulling ? "ON" : "OFF"} (threshold: ${cfg.gpuCullingThreshold})`,
      `  GPU Sort Keys: ${cfg.gpuSortKeys ? "ON" : "OFF"} (threshold: ${cfg.gpuSortKeysThreshold})`,
      `  GPU Point Cloud: ${cfg.gpuPointCloud ? "ON" : "OFF"} (threshold: ${cfg.gpuPointCloudThreshold})`,
      `  Atmosphere LUT: ${cfg.atmosphereLUT ? "ON" : "OFF"} (dirty: ${this._atmosphereLUTDirty})`,
      `  Timestamp Profiling: ${cfg.timestampProfiling ? "ON" : "OFF"} (supported: ${!!profiler})`,
      `  Buffer Mapping: ${cfg.bufferMapping ? "ON" : "OFF"}`,
      `  Compute Pipelines Cached: ${this._computePipelines.size}`,
      `  Last Frame GPU: ${this._frameTimings.totalGpuMs.toFixed(2)}ms`,
      `  Bundles Executed: ${this._frameTimings.bundlesExecuted}`,
      `  Indirect Draws: ${this._frameTimings.indirectDrawsBatched}`,
      `  Compute Dispatches: ${this._computeDispatches}`,
      ...this._asyncResourceDiagnosticLines(),
    ].join("\n");
  }

  /** Async-resource section of the perf-manager diagnostics dump. */
  private _asyncResourceDiagnosticLines(): string[] {
    const snap = this.getAsyncResourceStats();
    if (!snap) {
      return [`  Async Resources: <telemetry not wired>`];
    }
    const a = snap.aggregate;
    const rp = snap.perKind["render-pipeline"];
    const cp = snap.perKind["compute-pipeline"];
    return [
      `  Async Resources: inflight=${a.currentInflight} peak=${a.peakInflight} resolved=${a.resolvedCount} rejected=${a.rejectedCount} mean=${a.meanMs.toFixed(1)}ms`,
      `    Render pipelines: p50=${rp.p50Ms.toFixed(1)}ms p95=${rp.p95Ms.toFixed(1)}ms p99=${rp.p99Ms.toFixed(1)}ms (${rp.resolvedCount} resolved, ${rp.rejectedCount} rejected, peak inflight ${rp.peakInflight})`,
      `    Compute pipelines: p50=${cp.p50Ms.toFixed(1)}ms p95=${cp.p95Ms.toFixed(1)}ms p99=${cp.p99Ms.toFixed(1)}ms (${cp.resolvedCount} resolved, ${cp.rejectedCount} rejected, peak inflight ${cp.peakInflight})`,
    ];
  }

  /** @private */
  private _createEmptyTimings(): FrameTimings {
    return {
      totalGpuMs: 0,
      passes: {},
      bundlesExecuted: 0,
      indirectDrawsBatched: 0,
      objectsGpuCulled: 0,
    };
  }

  destroy(): void {
    this._staticTileBundleKeys.clear();
    this._computePipelines.clear();
  }
}

export default WebGPUPerformanceManager;
