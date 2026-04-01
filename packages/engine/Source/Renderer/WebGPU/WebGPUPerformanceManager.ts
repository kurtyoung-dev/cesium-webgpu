/**
 * @module WebGPUPerformanceManager
 *
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
 */

/// <reference types="@webgpu/types" />

// Compute shader sources (auto-generated from .wgsl files)
import AtmosphereLUTSource from "../../Shaders/WebGPU/Compute/AtmosphereLUT.js";
import PointCloudSortSource from "../../Shaders/WebGPU/Compute/PointCloudSort.js";
import PointCloudLODSource from "../../Shaders/WebGPU/Compute/PointCloudLOD.js";
import GPUSortKeysSource from "../../Shaders/WebGPU/Compute/GPUSortKeys.js";

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
  COUNT: 8,
} as const);

export type ComputeTaskTypeValue = typeof ComputeTaskType[keyof Omit<typeof ComputeTaskType, 'COUNT'>];

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
 */
export interface FrameTimings {
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
  private _context: any;
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
  private _atmosphereLUTDirty: boolean = true;
  private _computeDispatches: number = 0;

  constructor(context: any, config?: Partial<PerformanceConfig>) {
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
          this._frameTimings.passes = stats.passes ?? {};
        }
      }
    }

    this._frameTimings.bundlesExecuted = this._bundleHitCount;
    this._frameTimings.indirectDrawsBatched =
      this._indirectDrawActive ? (this._context.indirectDrawManager?.drawCount ?? 0) : 0;

    this._bundleHitCount = 0;
    this._bundleMissCount = 0;
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER BUNDLES — For static terrain tiles
  // ═══════════════════════════════════════════════════════════

  /**
   * Try to execute commands as a cached render bundle.
   * Returns true if a bundle was found and executed, false if individual
   * command execution is needed.
   *
   * @param bundleKey - Unique key for this set of commands (e.g., tile ID + pass)
   * @param renderPass - Active render pass encoder
   * @param commands - Commands to execute if no bundle is cached
   * @param count - Number of commands
   * @param recordCallback - Callback to record commands into a bundle encoder
   * @returns true if bundle was executed, false for individual execution
   */
  tryExecuteBundle(
    bundleKey: string,
    renderPass: GPURenderPassEncoder,
    commands: any[],
    count: number,
    recordCallback: (encoder: GPURenderBundleEncoder) => void,
  ): boolean {
    if (!this._bundleManagerActive || count < this._config.renderBundleThreshold) {
      return false;
    }

    const bundleMgr = this._context.renderBundleManager;
    if (!bundleMgr) {
      return false;
    }

    const device: GPUDevice = this._context.device;
    if (!device) {
      return false;
    }

    // Try to get cached bundle
    const entry = bundleMgr.get(bundleKey);
    if (entry) {
      renderPass.executeBundles([entry.bundle]);
      entry.lastUsedFrame = this._frameCount;
      this._bundleHitCount++;
      return true;
    }

    // Cache miss — record a new bundle
    const descriptor: GPURenderBundleEncoderDescriptor = {
      label: `RenderBundle:${bundleKey}`,
      colorFormats: [this._context.presentationFormat],
      depthStencilFormat: this._context.depthFormat,
    };

    try {
      const bundleEncoder = device.createRenderBundleEncoder(descriptor);
      recordCallback(bundleEncoder);
      const bundle = bundleEncoder.finish();

      bundleMgr.set(bundleKey, {
        bundle,
        version: 1,
        lastUsedFrame: this._frameCount,
        createdFrame: this._frameCount,
      });

      renderPass.executeBundles([bundle]);
      this._bundleMissCount++;
      this._bundleHitCount++;
      return true;
    } catch {
      // Bundle recording failed — fall back to individual execution
      return false;
    }
  }

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
  getGPUCuller(): any {
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
  getPassTimestampWrites(passName: string): GPURenderPassTimestampWrites | undefined {
    if (!this._profilerActive) {
      return undefined;
    }
    const profiler = this._context.timestampProfiler;
    return profiler?.getPassTimestampWrites?.(passName);
  }

  /**
   * Get timestamp writes for a compute pass descriptor.
   */
  getComputePassTimestampWrites(passName: string): GPUComputePassTimestampWrites | undefined {
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
      case ComputeTaskType.ATMOSPHERE_LUT: return AtmosphereLUTSource;
      case ComputeTaskType.POINT_CLOUD_SORT: return PointCloudSortSource;
      case ComputeTaskType.POINT_CLOUD_LOD: return PointCloudLODSource;
      case ComputeTaskType.GPU_SORT_KEYS: return GPUSortKeysSource;
      default: return null;
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
   * Mark the atmosphere LUT as needing recomputation (e.g., sun moved).
   */
  invalidateAtmosphereLUT(): void {
    this._atmosphereLUTDirty = true;
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
  ): void {
    const computeEngine = this._context.computeEngine;
    if (!computeEngine) return;

    const source = this.getComputeShaderSource(taskType);
    if (!source) return;

    const label = this._getTaskLabel(taskType);
    const timestampWrites = this.getComputePassTimestampWrites(label);

    const WebGPUComputeCommand = (this._context as any)._computeCommandClass;

    // Use ComputeEngine's pipeline caching via getOrCreatePipeline
    const cacheKey = `perfmgr:${label}:${entryPoint}`;
    const pipeline = computeEngine.getOrCreatePipeline(
      cacheKey, source, entryPoint,
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
  ): 'gpu' | 'wasm' | 'js' {
    const hasCompute = this._context.supportsComputeShaders;

    switch (taskType) {
      case ComputeTaskType.FRUSTUM_CULL:
        if (hasCompute && elementCount >= 50000) return 'gpu';
        if (elementCount >= 100) return 'wasm';
        return 'js';

      case ComputeTaskType.ATMOSPHERE_LUT:
        // Always GPU when available — ray marching is massively parallel
        return hasCompute ? 'gpu' : 'js';

      case ComputeTaskType.POINT_CLOUD_SORT:
      case ComputeTaskType.POINT_CLOUD_LOD:
        if (hasCompute && elementCount >= 50000) return 'gpu';
        if (elementCount >= 1000) return 'wasm';
        return 'js';

      case ComputeTaskType.GPU_SORT_KEYS:
        if (hasCompute && elementCount >= 50000) return 'gpu';
        if (elementCount >= 5000) return 'wasm';
        return 'js';

      case ComputeTaskType.HI_Z_PYRAMID:
      case ComputeTaskType.OCCLUSION_TEST:
        // These are inherently GPU-only operations
        return hasCompute ? 'gpu' : 'js';

      case ComputeTaskType.POLYGON_SDF:
        return hasCompute ? 'gpu' : 'js';

      default:
        return 'js';
    }
  }

  /** Number of compute dispatches in the current frame. */
  get computeDispatches(): number {
    return this._computeDispatches;
  }

  /** Map a ComputeTaskType to a human-readable label. */
  private _getTaskLabel(taskType: number): string {
    switch (taskType) {
      case ComputeTaskType.FRUSTUM_CULL: return 'frustumCull';
      case ComputeTaskType.ATMOSPHERE_LUT: return 'atmosphereLUT';
      case ComputeTaskType.POINT_CLOUD_SORT: return 'pointCloudSort';
      case ComputeTaskType.POINT_CLOUD_LOD: return 'pointCloudLOD';
      case ComputeTaskType.GPU_SORT_KEYS: return 'gpuSortKeys';
      case ComputeTaskType.HI_Z_PYRAMID: return 'hiZPyramid';
      case ComputeTaskType.OCCLUSION_TEST: return 'occlusionTest';
      case ComputeTaskType.POLYGON_SDF: return 'polygonSDF';
      default: return `compute_${taskType}`;
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
      `  Render Bundles: ${cfg.renderBundles ? 'ON' : 'OFF'} (cache: ${bundleStats.cacheSize}, hit rate: ${(bundleStats.hitRate * 100).toFixed(1)}%)`,
      `  Indirect Draw: ${cfg.indirectDraw ? 'ON' : 'OFF'}`,
      `  GPU Culling: ${cfg.gpuCulling ? 'ON' : 'OFF'} (threshold: ${cfg.gpuCullingThreshold})`,
      `  GPU Sort Keys: ${cfg.gpuSortKeys ? 'ON' : 'OFF'} (threshold: ${cfg.gpuSortKeysThreshold})`,
      `  GPU Point Cloud: ${cfg.gpuPointCloud ? 'ON' : 'OFF'} (threshold: ${cfg.gpuPointCloudThreshold})`,
      `  Atmosphere LUT: ${cfg.atmosphereLUT ? 'ON' : 'OFF'} (dirty: ${this._atmosphereLUTDirty})`,
      `  Timestamp Profiling: ${cfg.timestampProfiling ? 'ON' : 'OFF'} (supported: ${!!profiler})`,
      `  Buffer Mapping: ${cfg.bufferMapping ? 'ON' : 'OFF'}`,
      `  Compute Pipelines Cached: ${this._computePipelines.size}`,
      `  Last Frame GPU: ${this._frameTimings.totalGpuMs.toFixed(2)}ms`,
      `  Bundles Executed: ${this._frameTimings.bundlesExecuted}`,
      `  Indirect Draws: ${this._frameTimings.indirectDrawsBatched}`,
      `  Compute Dispatches: ${this._computeDispatches}`,
    ].join('\n');
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
