// @ts-nocheck
/**
 * @module WebGPUTimestampProfiler
 *
 * GPU-side performance profiling using WebGPU timestamp queries.
 * Requires the 'timestamp-query' device feature to be enabled.
 *
 * Provides frame-level and pass-level GPU timing with automatic
 * query set management, readback buffering, and statistics computation.
 *
 * @example
 * const profiler = new WebGPUTimestampProfiler(device, context);
 *
 * // Each frame:
 * profiler.beginFrame(commandEncoder);
 * profiler.beginPass('terrain');
 * // ... terrain rendering ...
 * profiler.endPass('terrain');
 * profiler.beginPass('models');
 * // ... model rendering ...
 * profiler.endPass('models');
 * profiler.endFrame(commandEncoder);
 *
 * // Read results (async — results are from N frames ago):
 * const results = await profiler.getResults();
 * console.log(results.passes.terrain.avgMs);
 */

/// <reference types="@webgpu/types" />

/**
 * Timing result for a single named pass.
 */
export interface PassTimingResult {
  /** Pass name */
  name: string;
  /** Duration in milliseconds (most recent) */
  lastMs: number;
  /** Average duration in milliseconds (rolling window) */
  avgMs: number;
  /** Min duration in milliseconds (rolling window) */
  minMs: number;
  /** Max duration in milliseconds (rolling window) */
  maxMs: number;
}

/**
 * Full frame profiling results.
 */
export interface ProfilingResults {
  /** Whether profiling is active (timestamp-query feature enabled) */
  enabled: boolean;
  /** Total frame GPU time in milliseconds */
  frameMs: number;
  /** Average frame GPU time (rolling window) */
  frameAvgMs: number;
  /** Per-pass timing results */
  passes: Record<string, PassTimingResult>;
  /** Number of frames profiled */
  frameCount: number;
  /** Timestamp resolution in nanoseconds */
  timestampPeriod: number;
}

/**
 * Internal state for a single profiling frame.
 */
interface FrameQueryState {
  querySet: GPUQuerySet;
  resolveBuffer: GPUBuffer;
  readbackBuffer: GPUBuffer;
  queryCount: number;
  passNames: string[];
  /** Maps pass name → [startQueryIndex, endQueryIndex] */
  passIndices: Map<string, [number, number]>;
  frameStartIndex: number;
  frameEndIndex: number;
}

/** Rolling window size for average computation */
const ROLLING_WINDOW = 60;

/** Maximum number of passes per frame */
const MAX_PASSES_PER_FRAME = 32;

/** Queries per frame: 2 for frame start/end + 2 per pass (start/end) */
const MAX_QUERIES = 2 + MAX_PASSES_PER_FRAME * 2;

/**
 * GPU timestamp profiler using WebGPU's timestamp-query feature.
 *
 * This profiler uses a double-buffered (or N-buffered) approach:
 * - Frame N writes timestamps
 * - Frame N+2 reads back the results from frame N
 * This avoids GPU stalls from immediate readback.
 */
export class WebGPUTimestampProfiler {
  private _device: GPUDevice;
  private _enabled: boolean = false;
  private _timestampPeriod: number = 1; // nanoseconds per tick

  // Double-buffered frame states
  private _frameStates: FrameQueryState[] = [];
  private _currentFrameIndex: number = 0;
  private _bufferCount: number = 3; // triple-buffer for safety

  // Current frame tracking
  private _activePassName: string | null = null;
  private _nextQueryIndex: number = 0;
  private _currentPassNames: string[] = [];
  private _currentPassIndices: Map<string, [number, number]> = new Map();

  // Results storage
  private _latestResults: Map<string, number[]> = new Map(); // pass → rolling window of ms
  private _frameTimings: number[] = []; // rolling window of frame ms
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
      console.log(
        "[WebGPU Profiler] timestamp-query not available — profiling disabled",
      );
      return;
    }

    // Get timestamp period for nanosecond→millisecond conversion
    // Note: some implementations may report 0 or 1
    this._timestampPeriod = 1; // Default: 1 nanosecond per tick

    // Create frame states (triple-buffered)
    for (let i = 0; i < this._bufferCount; i++) {
      this._frameStates.push(this._createFrameState(i));
    }

    console.log("[WebGPU Profiler] GPU timestamp profiling enabled");
  }

  /**
   * Creates a query set and associated buffers for one frame.
   * @private
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
      passNames: [],
      passIndices: new Map(),
      frameStartIndex: 0,
      frameEndIndex: 0,
    };
  }

  /**
   * Begin profiling a frame. Call before any render passes.
   *
   * @param encoder - The command encoder for this frame
   */
  beginFrame(encoder: GPUCommandEncoder): void {
    if (!this._enabled) return;

    this._nextQueryIndex = 0;
    this._currentPassNames = [];
    this._currentPassIndices = new Map();

    // Write frame start timestamp
    const state = this._frameStates[this._currentFrameIndex];
    state.frameStartIndex = this._nextQueryIndex;
    encoder.writeTimestamp(state.querySet, this._nextQueryIndex++);
  }

  /**
   * Begin timing a named pass.
   *
   * @param name - Pass name (e.g., 'terrain', 'models', 'postprocess')
   * @param encoder - The command encoder
   */
  beginPass(name: string, encoder: GPUCommandEncoder): void {
    if (!this._enabled) return;

    if (this._activePassName !== null) {
      console.warn(
        `[WebGPU Profiler] beginPass('${name}') called while '${this._activePassName}' is still active`,
      );
    }

    this._activePassName = name;
    const startIndex = this._nextQueryIndex;
    const state = this._frameStates[this._currentFrameIndex];
    encoder.writeTimestamp(state.querySet, this._nextQueryIndex++);

    this._currentPassIndices.set(name, [startIndex, -1]);
    this._currentPassNames.push(name);
  }

  /**
   * End timing the current named pass.
   *
   * @param name - Pass name (must match the beginPass call)
   * @param encoder - The command encoder
   */
  endPass(name: string, encoder: GPUCommandEncoder): void {
    if (!this._enabled) return;

    if (this._activePassName !== name) {
      console.warn(
        `[WebGPU Profiler] endPass('${name}') doesn't match active pass '${this._activePassName}'`,
      );
    }

    const state = this._frameStates[this._currentFrameIndex];
    const endIndex = this._nextQueryIndex;
    encoder.writeTimestamp(state.querySet, this._nextQueryIndex++);

    const indices = this._currentPassIndices.get(name);
    if (indices) {
      indices[1] = endIndex;
    }

    this._activePassName = null;
  }

  /**
   * End profiling the frame. Resolves queries and issues readback copy.
   *
   * @param encoder - The command encoder for this frame
   */
  endFrame(encoder: GPUCommandEncoder): void {
    if (!this._enabled) return;

    const state = this._frameStates[this._currentFrameIndex];

    // Write frame end timestamp
    state.frameEndIndex = this._nextQueryIndex;
    encoder.writeTimestamp(state.querySet, this._nextQueryIndex++);

    // Store pass info for this frame
    state.queryCount = this._nextQueryIndex;
    state.passNames = [...this._currentPassNames];
    state.passIndices = new Map(this._currentPassIndices);

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
   * @private
   */
  private async _readOldestFrame(): Promise<void> {
    // The frame that should be done by now
    const readIndex = (this._currentFrameIndex + 1) % this._bufferCount;
    const state = this._frameStates[readIndex];

    if (state.queryCount === 0) return; // No data yet

    try {
      const readbackBuffer = state.readbackBuffer;

      // Check if buffer is already mapped
      if (readbackBuffer.mapState === "unmapped") {
        await readbackBuffer.mapAsync(GPUMapMode.READ);
        const data = new BigUint64Array(readbackBuffer.getMappedRange());

        // Extract frame timing
        const frameStartNs = data[state.frameStartIndex];
        const frameEndNs = data[state.frameEndIndex];
        const frameMs =
          (Number(frameEndNs - frameStartNs) * this._timestampPeriod) /
          1_000_000;

        this._addToRollingWindow(this._frameTimings, frameMs);

        // Extract per-pass timings
        for (const [name, [startIdx, endIdx]] of state.passIndices) {
          if (endIdx < 0) continue;
          const startNs = data[startIdx];
          const endNs = data[endIdx];
          const passMs =
            (Number(endNs - startNs) * this._timestampPeriod) / 1_000_000;

          if (!this._latestResults.has(name)) {
            this._latestResults.set(name, []);
          }
          this._addToRollingWindow(this._latestResults.get(name)!, passMs);
        }

        readbackBuffer.unmap();
      }
    } catch {
      // Readback may fail if GPU is busy — silently skip
    }
  }

  /**
   * Add a value to a rolling window array.
   * @private
   */
  private _addToRollingWindow(arr: number[], value: number): void {
    arr.push(value);
    if (arr.length > ROLLING_WINDOW) {
      arr.shift();
    }
  }

  /**
   * Compute statistics from a rolling window.
   * @private
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
   *
   * @returns Profiling results with frame and per-pass timings
   */
  getResults(): ProfilingResults {
    if (!this._enabled) {
      return {
        enabled: false,
        frameMs: 0,
        frameAvgMs: 0,
        passes: {},
        frameCount: this._totalFrames,
        timestampPeriod: this._timestampPeriod,
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
      timestampPeriod: this._timestampPeriod,
    };
  }

  /**
   * Whether profiling is enabled (timestamp-query feature available).
   */
  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Whether the profiler has been destroyed.
   */
  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /**
   * Destroy all GPU resources.
   */
  destroy(): void {
    if (this._isDestroyed) return;

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
