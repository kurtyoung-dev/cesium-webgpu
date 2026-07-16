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
  /** GPU span from the first timed pass begin to the last timed pass end. */
  readonly frameMs: number;
  /** Average frame GPU time (rolling window) */
  readonly frameAvgMs: number;
  /** Sum of the latest frame's individually timed pass durations. */
  readonly profiledPassMs: number;
  /** Rolling average of individually timed pass duration sums. */
  readonly profiledPassAvgMs: number;
  /** Latest frame span not attributed to a named timed pass. */
  readonly unprofiledMs: number;
  /** Rolling average of the unprofiled frame-span remainder. */
  readonly unprofiledAvgMs: number;
  /** Fraction of the latest frame span covered by named pass timings. */
  readonly coverageRatio: number | null;
  /** Portable timestamp envelope used for the coverage calculation. */
  readonly coverageScope: "between-first-and-last-timed-pass";
  /** Per-pass timing results, keyed by pass name. */
  readonly passes: { readonly [passName: string]: PassTimingResult };
  /** Number of frames profiled */
  readonly frameCount: number;
  /** Number of frame profiling attempts, including empty or skipped frames. */
  readonly attemptedFrameCount: number;
  /** Passes dropped because the query-set capacity was exhausted. */
  readonly droppedPassCount: number;
  /** Frames not sampled because a readback slot was still in use. */
  readonly readbackSkipCount: number;
  /** Timestamp readbacks that rejected or could not be mapped. */
  readonly failedReadbackCount: number;
}

interface PassQueryRecord {
  name: string;
  beginIndex: number;
  endIndex: number;
}

interface PendingSubmission {
  stateIndex: number;
  generation: number;
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
  passRecords: PassQueryRecord[];
  readbackPending: boolean;
}

/** Rolling window size for average computation */
const ROLLING_WINDOW = 60;

/** Maximum number of passes per frame */
const MAX_PASSES_PER_FRAME = 128;

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
 * - After Frame N is submitted, mapAsync waits for its copy without blocking
 * - Later frames use the other slots while that readback is pending
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
  private _currentPassRecords: PassQueryRecord[] = [];
  private _currentFrameAvailable: boolean = false;
  private _currentFrameGeneration: number = 0;

  // Results storage
  private _latestResults: Map<string, number[]> = new Map();
  private _frameTimings: number[] = [];
  private _profiledPassTimings: number[] = [];
  private _unprofiledTimings: number[] = [];
  private _attemptedFrames: number = 0;
  private _sampledFrames: number = 0;
  private _droppedPassCount: number = 0;
  private _readbackSkipCount: number = 0;
  private _failedReadbackCount: number = 0;
  private _generation: number = 0;
  private _pendingSubmissions: PendingSubmission[] = [];

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
      passRecords: [],
      readbackPending: false,
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
    this._currentPassRecords = [];
    this._currentFrameGeneration = this._generation;
    const state = this._frameStates[this._currentFrameIndex];
    this._currentFrameAvailable =
      !state.readbackPending && state.readbackBuffer.mapState === "unmapped";
    if (!this._currentFrameAvailable) {
      this._readbackSkipCount++;
    }
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
    if (!this._enabled || !this._currentFrameAvailable) {
      return undefined;
    }
    if (this._nextQueryIndex + 2 > MAX_QUERIES) {
      this._droppedPassCount++;
      return undefined;
    }

    const state = this._frameStates[this._currentFrameIndex];
    const beginIndex = this._nextQueryIndex++;
    const endIndex = this._nextQueryIndex++;

    this._currentPassRecords.push({ name, beginIndex, endIndex });

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
    if (!this._enabled || !this._currentFrameAvailable) {
      return undefined;
    }
    if (this._nextQueryIndex + 2 > MAX_QUERIES) {
      this._droppedPassCount++;
      return undefined;
    }

    const state = this._frameStates[this._currentFrameIndex];
    const beginIndex = this._nextQueryIndex++;
    const endIndex = this._nextQueryIndex++;

    this._currentPassRecords.push({ name, beginIndex, endIndex });

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

    if (this._currentFrameAvailable) {
      state.queryCount = this._nextQueryIndex;
      state.passRecords = this._currentPassRecords.slice();
    }

    if (this._currentFrameAvailable && state.queryCount > 0) {
      encoder.resolveQuerySet(
        state.querySet,
        0,
        state.queryCount,
        state.resolveBuffer,
        0,
      );
      encoder.copyBufferToBuffer(
        state.resolveBuffer,
        0,
        state.readbackBuffer,
        0,
        state.queryCount * 8,
      );
      state.readbackPending = true;
      this._pendingSubmissions.push({
        stateIndex: this._currentFrameIndex,
        generation: this._currentFrameGeneration,
      });
    }

    // Advance to next frame state
    this._currentFrameIndex = (this._currentFrameIndex + 1) % this._bufferCount;
    this._attemptedFrames++;
  }

  /**
   * Starts asynchronous readback for work submitted by the most recent queue
   * submission. This must be called after `queue.submit()` so `mapAsync()` is
   * ordered after the copy encoded by {@link endFrame}. It does not wait for
   * the GPU and therefore does not block the render path.
   */
  afterSubmit(): void {
    if (!this._enabled || this._pendingSubmissions.length === 0) {
      return;
    }
    const submissions = this._pendingSubmissions;
    this._pendingSubmissions = [];
    for (const submission of submissions) {
      void this._readSubmittedFrame(submission);
    }
  }

  /** Asynchronously reads results from one submitted frame slot. */
  private async _readSubmittedFrame(
    submission: PendingSubmission,
  ): Promise<void> {
    const state = this._frameStates[submission.stateIndex];

    if (
      !state ||
      state.queryCount === 0 ||
      state.readbackBuffer.mapState !== "unmapped"
    ) {
      return;
    }

    try {
      const readbackBuffer = state.readbackBuffer;
      await readbackBuffer.mapAsync(GPUMapMode.READ);
      if (this._isDestroyed || submission.generation !== this._generation) {
        return;
      }
      const data = new BigUint64Array(readbackBuffer.getMappedRange());
      const passTotals = new Map<string, number>();
      let profiledPassMs = 0;

      for (const record of state.passRecords) {
        const startNs = data[record.beginIndex];
        const endNs = data[record.endIndex];
        const passMs = Number(endNs - startNs) / 1_000_000;
        passTotals.set(
          record.name,
          (passTotals.get(record.name) ?? 0) + passMs,
        );
        profiledPassMs += passMs;
      }
      for (const [name, passMs] of passTotals) {
        let timings = this._latestResults.get(name);
        if (!timings) {
          timings = [];
          this._latestResults.set(name, timings);
        }
        this._addToRollingWindow(timings, passMs);
      }
      const firstRecord = state.passRecords[0];
      const lastRecord = state.passRecords[state.passRecords.length - 1];
      const frameSpanMs =
        firstRecord && lastRecord
          ? Number(data[lastRecord.endIndex] - data[firstRecord.beginIndex]) /
            1_000_000
          : 0;
      // Passes on one command encoder cannot overlap, but timestamp precision
      // and implementations may produce a tiny negative subtraction residue.
      const unprofiledMs = Math.max(0, frameSpanMs - profiledPassMs);
      this._addToRollingWindow(this._frameTimings, frameSpanMs);
      this._addToRollingWindow(this._profiledPassTimings, profiledPassMs);
      this._addToRollingWindow(this._unprofiledTimings, unprofiledMs);
      this._sampledFrames++;
    } catch {
      if (!this._isDestroyed && submission.generation === this._generation) {
        this._failedReadbackCount++;
      }
    } finally {
      // TypeScript retains the pre-await "unmapped" narrowing even though
      // mapAsync mutates this WebGPU state asynchronously. Re-read through a
      // string boundary so the cleanup reflects the actual post-await state.
      const finalMapState = String(state.readbackBuffer.mapState);
      if (!this._isDestroyed && finalMapState === "mapped") {
        state.readbackBuffer.unmap();
      }
      state.queryCount = 0;
      state.passRecords = [];
      state.readbackPending = false;
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
        profiledPassMs: 0,
        profiledPassAvgMs: 0,
        unprofiledMs: 0,
        unprofiledAvgMs: 0,
        coverageRatio: null,
        coverageScope: "between-first-and-last-timed-pass",
        passes: {},
        frameCount: this._sampledFrames,
        attemptedFrameCount: this._attemptedFrames,
        droppedPassCount: this._droppedPassCount,
        readbackSkipCount: this._readbackSkipCount,
        failedReadbackCount: this._failedReadbackCount,
      };
    }

    const frameStats = this._computeStats(this._frameTimings);
    const profiledPassStats = this._computeStats(this._profiledPassTimings);
    const unprofiledStats = this._computeStats(this._unprofiledTimings);
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
      profiledPassMs: profiledPassStats.last,
      profiledPassAvgMs: profiledPassStats.avg,
      unprofiledMs: unprofiledStats.last,
      unprofiledAvgMs: unprofiledStats.avg,
      coverageRatio:
        frameStats.last > 0
          ? Math.min(1, profiledPassStats.last / frameStats.last)
          : null,
      coverageScope: "between-first-and-last-timed-pass",
      passes,
      frameCount: this._sampledFrames,
      attemptedFrameCount: this._attemptedFrames,
      droppedPassCount: this._droppedPassCount,
      readbackSkipCount: this._readbackSkipCount,
      failedReadbackCount: this._failedReadbackCount,
    };
  }

  reset(): void {
    this._generation++;
    this._latestResults.clear();
    this._frameTimings = [];
    this._profiledPassTimings = [];
    this._unprofiledTimings = [];
    this._attemptedFrames = 0;
    this._sampledFrames = 0;
    this._droppedPassCount = 0;
    this._readbackSkipCount = 0;
    this._failedReadbackCount = 0;
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
    this._profiledPassTimings = [];
    this._unprofiledTimings = [];
    this._currentPassRecords = [];
    this._pendingSubmissions = [];
    this._currentFrameAvailable = false;
    this._generation++;
    this._enabled = false;
    this._isDestroyed = true;
  }
}

export default WebGPUTimestampProfiler;
