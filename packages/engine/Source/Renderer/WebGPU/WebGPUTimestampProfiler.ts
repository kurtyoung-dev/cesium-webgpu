/// <reference types="@webgpu/types" />
import type { DebugStatsObject } from "../GraphicsContext.js";
/**
 * GPU-side performance profiling using WebGPU timestamp queries.
 * Requires the 'timestamp-query' device feature to be enabled.
 *
 * Uses the modern WebGPU `timestampWrites` API on render/compute passes
 * (the deprecated `GPUCommandEncoder.writeTimestamp()` was removed from the spec).
 *
 * Provides frame-level and pass-level GPU timing with automatic
 * query set management, readback buffering, and statistics computation.
 *
 * @example
 * const profiler = new WebGPUTimestampProfiler(device, true);
 *
 * // Each frame:
 * profiler.beginFrame();
 *
 * // Get timestampWrites config for a render pass:
 * const tsWrites = profiler.getPassTimestampWrites('terrain');
 * const renderPass = encoder.beginRenderPass({ ...passDesc, timestampWrites: tsWrites });
 * // ... terrain rendering ...
 * renderPass.end();
 *
 * // End frame (resolves queries, issues readback):
 * profiler.endFrame(commandEncoder);
 *
 * // Read results (async — results are from N frames ago):
 * const results = profiler.getResults();
 * console.log(results.passes.terrain?.avgMs);
 * @module WebGPUTimestampProfiler
 */

/**
 * Timing result for a single named pass. All fields are JSON-safe so the
 * interface is directly compatible with {@link DebugStatsObject} for
 * assignment into scene debug snapshots.
 */
export interface PassTimingResult extends DebugStatsObject {
  /** Pass name */
  readonly name: string;
  /** Duration in milliseconds (most recent) */
  readonly lastMs: number;
  /** Average duration in milliseconds (rolling window) */
  readonly avgMs: number;
  /** Min duration in milliseconds (rolling window) */
  readonly minMs: number;
  /** Max duration in milliseconds (rolling window) */
  readonly maxMs: number;
}

/**
 * Full frame profiling results. Extends {@link DebugStatsObject} so the
 * value assigns directly into `getRendererStatistics()` without a cast.
 */
export interface ProfilingResults extends DebugStatsObject {
  /** Whether profiling is active (timestamp-query feature enabled) */
  readonly enabled: boolean;
  /** Total frame GPU time in milliseconds (sum of all passes) */
  readonly frameMs: number;
  /** Average frame GPU time (rolling window) */
  readonly frameAvgMs: number;
  /** Per-pass timing results, keyed by pass name. */
  readonly passes: { readonly [passName: string]: PassTimingResult };
  /** Number of frames profiled */
  readonly frameCount: number;
}

/**
 * Internal state for a single profiling frame.
 */
interface FrameQueryState {
  querySet: GPUQuerySet;
  resolveBuffer: GPUBuffer;
  readbackBuffer: GPUBuffer;
  /** Number of queries actually written this frame */
  queryCount: number;
  /** Maps pass name → [beginQueryIndex, endQueryIndex] */
  passIndices: Map<string, [number, number]>;
}

/** Rolling window size for average computation */
const ROLLING_WINDOW = 60;

/** Maximum number of passes per frame */
const MAX_PASSES_PER_FRAME = 32;

/** Queries per frame: 2 per pass (begin + end) */
const MAX_QUERIES = MAX_PASSES_PER_FRAME * 2;

/**
 * GPU timestamp profiler using WebGPU's timestamp-query feature.
 *
 * This profiler uses `timestampWrites` on render/compute passes (the modern API)
 * instead of the deprecated `GPUCommandEncoder.writeTimestamp()`.
 *
 * Uses triple-buffering to avoid GPU stalls:
 * - Frame N writes timestamps via timestampWrites
 * - Frame N+2 reads back results from frame N
 */
export class WebGPUTimestampProfiler {
  private _device: GPUDevice;
  private _enabled: boolean = false;

  // Triple-buffered frame states
  private _frameStates: FrameQueryState[] = [];
  private _currentFrameIndex: number = 0;
  private _bufferCount: number = 3;

  // Current frame tracking
  private _nextQueryIndex: number = 0;
  private _currentPassIndices: Map<string, [number, number]> = new Map();

  // Results storage
  private _latestResults: Map<string, number[]> = new Map();
  private _frameTimings: number[] = [];
  private _totalFrames: number = 0;

  private _isDestroyed: boolean = false;

  /**
   * Creates a new timestamp profiler.
   *
   * @param device - The GPU device (must have 'timestamp-query' feature)
   * @param hasTimestampFeature - Whether the device supports timestamp queries
   */
  constructor(device: GPUDevice, hasTimestampFeature: boolean = false) {
    this._device = device;
    this._enabled =
      hasTimestampFeature && device.features.has("timestamp-query");

    if (!this._enabled) {
      return;
    }

    // Create frame states (triple-buffered)
    for (let i = 0; i < this._bufferCount; i++) {
      this._frameStates.push(this._createFrameState(i));
    }
  }

  /**
   * Creates a query set and associated buffers for one frame.
   */
  private _createFrameState(index: number): FrameQueryState {
    const querySet = this._device.createQuerySet({
      type: "timestamp",
      count: MAX_QUERIES,
      label: `Timestamp QuerySet Frame ${index}`,
    });

    // Resolve buffer: GPU writes query results here
    const resolveBuffer = this._device.createBuffer({
      size: MAX_QUERIES * 8, // 8 bytes per timestamp (u64)
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      label: `Timestamp Resolve Buffer Frame ${index}`,
    });

    // Readback buffer: CPU reads results from here
    const readbackBuffer = this._device.createBuffer({
      size: MAX_QUERIES * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: `Timestamp Readback Buffer Frame ${index}`,
    });

    return {
      querySet,
      resolveBuffer,
      readbackBuffer,
      queryCount: 0,
      passIndices: new Map(),
    };
  }

  /**
   * Begin profiling a frame. Call before any render passes.
   * Resets per-frame tracking state.
   */
  beginFrame(): void {
    if (!this._enabled) {
      return;
    }
    this._nextQueryIndex = 0;
    this._currentPassIndices = new Map();
  }

  /**
   * Get a `GPURenderPassTimestampWrites` configuration for a named pass.
   * The caller should include this in the render pass descriptor:
   *
   * ```typescript
   * const tsWrites = profiler.getPassTimestampWrites('terrain');
   * encoder.beginRenderPass({ ...passDesc, timestampWrites: tsWrites });
   * ```
   *
   * @param name - Pass name (e.g., 'terrain', 'models', 'postprocess')
   * @returns The timestampWrites config, or undefined if profiling is disabled
   */
  getPassTimestampWrites(
    name: string,
  ): GPURenderPassTimestampWrites | undefined {
    if (!this._enabled) {
      return undefined;
    }
    if (this._nextQueryIndex + 2 > MAX_QUERIES) {
      return undefined; // Out of query slots
    }

    const state = this._frameStates[this._currentFrameIndex];
    const beginIndex = this._nextQueryIndex++;
    const endIndex = this._nextQueryIndex++;

    this._currentPassIndices.set(name, [beginIndex, endIndex]);

    return {
      querySet: state.querySet,
      beginningOfPassWriteIndex: beginIndex,
      endOfPassWriteIndex: endIndex,
    };
  }

  /**
   * Get a `GPUComputePassTimestampWrites` configuration for a named compute pass.
   *
   * @param name - Pass name
   * @returns The timestampWrites config, or undefined if profiling is disabled
   */
  getComputePassTimestampWrites(
    name: string,
  ): GPUComputePassTimestampWrites | undefined {
    if (!this._enabled) {
      return undefined;
    }
    if (this._nextQueryIndex + 2 > MAX_QUERIES) {
      return undefined;
    }

    const state = this._frameStates[this._currentFrameIndex];
    const beginIndex = this._nextQueryIndex++;
    const endIndex = this._nextQueryIndex++;

    this._currentPassIndices.set(name, [beginIndex, endIndex]);

    return {
      querySet: state.querySet,
      beginningOfPassWriteIndex: beginIndex,
      endOfPassWriteIndex: endIndex,
    };
  }

  /**
   * End profiling the frame. Resolves queries and issues readback copy.
   *
   * @param encoder - The command encoder for this frame
   */
  endFrame(encoder: GPUCommandEncoder): void {
    if (!this._enabled) {
      return;
    }

    const state = this._frameStates[this._currentFrameIndex];

    // Store pass info for this frame
    state.queryCount = this._nextQueryIndex;
    state.passIndices = new Map(this._currentPassIndices);

    if (state.queryCount === 0) {
      this._currentFrameIndex =
        (this._currentFrameIndex + 1) % this._bufferCount;
      this._totalFrames++;
      return;
    }

    // Resolve timestamps into the resolve buffer
    encoder.resolveQuerySet(
      state.querySet,
      0,
      state.queryCount,
      state.resolveBuffer,
      0,
    );

    // Copy resolve buffer → readback buffer
    encoder.copyBufferToBuffer(
      state.resolveBuffer,
      0,
      state.readbackBuffer,
      0,
      state.queryCount * 8,
    );

    // Advance to next frame state
    this._currentFrameIndex = (this._currentFrameIndex + 1) % this._bufferCount;
    this._totalFrames++;

    // Attempt to read results from the oldest frame (N frames ago)
    this._readOldestFrame();
  }

  /**
   * Asynchronously reads results from the oldest completed frame.
   */
  private async _readOldestFrame(): Promise<void> {
    const readIndex = (this._currentFrameIndex + 1) % this._bufferCount;
    const state = this._frameStates[readIndex];

    if (state.queryCount === 0) {
      return;
    }

    try {
      const readbackBuffer = state.readbackBuffer;

      if (readbackBuffer.mapState === "unmapped") {
        await readbackBuffer.mapAsync(GPUMapMode.READ);
        const data = new BigUint64Array(readbackBuffer.getMappedRange());

        let frameTotalMs = 0;

        // Extract per-pass timings
        for (const [name, [startIdx, endIdx]] of state.passIndices) {
          const startNs = data[startIdx];
          const endNs = data[endIdx];
          const passMs = Number(endNs - startNs) / 1_000_000;

          if (!this._latestResults.has(name)) {
            this._latestResults.set(name, []);
          }
          this._addToRollingWindow(this._latestResults.get(name)!, passMs);
          frameTotalMs += passMs;
        }

        this._addToRollingWindow(this._frameTimings, frameTotalMs);
        readbackBuffer.unmap();
      }
    } catch {
      // Readback may fail if GPU is busy — silently skip
    }
  }

  /**
   * Add a value to a rolling window array.
   */
  private _addToRollingWindow(arr: number[], value: number): void {
    arr.push(value);
    if (arr.length > ROLLING_WINDOW) {
      arr.shift();
    }
  }

  /**
   * Compute statistics from a rolling window.
   */
  private _computeStats(arr: number[]): {
    last: number;
    avg: number;
    min: number;
    max: number;
  } {
    if (arr.length === 0) {
      return { last: 0, avg: 0, min: 0, max: 0 };
    }
    const last = arr[arr.length - 1];
    const sum = arr.reduce((a, b) => a + b, 0);
    const avg = sum / arr.length;
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    return { last, avg, min, max };
  }

  /**
   * Get the latest profiling results.
   * Results are from N frames ago (where N = bufferCount) to avoid GPU stalls.
   */
  getResults(): ProfilingResults {
    if (!this._enabled) {
      return {
        enabled: false,
        frameMs: 0,
        frameAvgMs: 0,
        passes: {},
        frameCount: this._totalFrames,
      };
    }

    const frameStats = this._computeStats(this._frameTimings);
    const passes: Record<string, PassTimingResult> = {};

    for (const [name, timings] of this._latestResults) {
      const stats = this._computeStats(timings);
      passes[name] = {
        name,
        lastMs: stats.last,
        avgMs: stats.avg,
        minMs: stats.min,
        maxMs: stats.max,
      };
    }

    return {
      enabled: true,
      frameMs: frameStats.last,
      frameAvgMs: frameStats.avg,
      passes,
      frameCount: this._totalFrames,
    };
  }

  /** Whether profiling is enabled. */
  get enabled(): boolean {
    return this._enabled;
  }

  /** Whether the profiler has been destroyed. */
  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /** Destroy all GPU resources. */
  destroy(): void {
    if (this._isDestroyed) {
      return;
    }
    for (const state of this._frameStates) {
      state.querySet.destroy();
      state.resolveBuffer.destroy();
      state.readbackBuffer.destroy();
    }
    this._frameStates = [];
    this._latestResults.clear();
    this._frameTimings = [];
    this._isDestroyed = true;
  }
}

export default WebGPUTimestampProfiler;
