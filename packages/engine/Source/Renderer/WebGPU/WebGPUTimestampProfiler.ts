/// <reference types="@webgpu/types" />
import type { DebugStatsObject } from "../GraphicsContext.js";
import {
  balanceSampleLedger,
  summarizeFrameCoverage,
} from "./WebGPUTimestampAccounting.js";
import type { TimedPassSample } from "./WebGPUTimestampAccounting.js";
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
  /**
   * Sum of the latest frame's individually timed pass durations. Overlapping
   * passes are counted once per pass here — compare against `coveredMs` for
   * the unique-sample measure.
   */
  readonly profiledPassMs: number;
  /** Rolling average of individually timed pass duration sums. */
  readonly profiledPassAvgMs: number;
  /**
   * Union of the latest frame's timed pass intervals: every GPU nanosecond
   * inside the frame span counted exactly once.
   */
  readonly coveredMs: number;
  /** Rolling average of the unique-sample covered span. */
  readonly coveredAvgMs: number;
  /**
   * `profiledPassMs − coveredMs` for the latest frame. Non-zero means timed
   * passes overlapped in GPU time, so any claim built on the naive pass sum
   * would double-count.
   */
  readonly overlapMs: number;
  /** Sampled frames in the rolling window whose passes overlapped at all. */
  readonly overlappingFrameCount: number;
  /** Latest frame span not attributed to a named timed pass. */
  readonly unprofiledMs: number;
  /** Rolling average of the unprofiled frame-span remainder. */
  readonly unprofiledAvgMs: number;
  /** Fraction of the latest frame span covered by named pass timings. */
  readonly coverageRatio: number | null;
  /** Fraction of the latest frame span left in the unprofiled remainder. */
  readonly unprofiledRatio: number | null;
  /** True when covered + unprofiled reconstructs the latest frame span. */
  readonly coverageBalanced: boolean;
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
  /** Depth of the readback ring these results were sampled through. */
  readonly bufferCount: number;
  /**
   * True when at least one frame went unsampled because the ring had no free
   * slot. The retained samples are then drawn from the frames the ring could
   * keep up with, so a mean over them is a mean over a subset selected by the
   * cost it is measuring. Report it; never average past it.
   */
  readonly ringSaturated: boolean;
  /** Timestamp readbacks that rejected or could not be mapped. */
  readonly failedReadbackCount: number;
  /** Armed frames that wrote no timestamps because no timed pass ran. */
  readonly emptyFrameCount: number;
  /** Submitted frames abandoned before their readback could be read. */
  readonly lostSampleCount: number;
  /** Submitted frames whose readback was still in flight at report time. */
  readonly pendingReadbackCount: number;
  /**
   * True when sampled + skipped + empty + failed + lost + pending equals the
   * attempted frame count — that is, no sample vanished silently.
   */
  readonly sampleLedgerBalanced: boolean;
  /** Attempts with no recorded terminal outcome. Must be zero. */
  readonly unaccountedSampleCount: number;
  /** Passes whose end timestamp preceded their begin in the latest frame. */
  readonly invertedSampleCount: number;
}

/** Outcome of {@link WebGPUTimestampProfiler.drainPendingReadbacks}. */
export interface ReadbackDrainResult {
  /** Readbacks that completed (successfully or not) during the drain. */
  readonly drained: number;
  /** Readbacks still in flight when the bounded wait expired. */
  readonly undrained: number;
  /**
   * Submissions that were encoded but never handed to `afterSubmit()`, so no
   * readback was ever started for them. Counted as lost, not silently dropped.
   */
  readonly abandoned: number;
  /** True when the bounded wait expired with readbacks still outstanding. */
  readonly timedOut: boolean;
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
 * Default depth of the readback ring.
 *
 * The ring advances one slot per profiled frame, so a slot is revisited every
 * `bufferCount` frames, while its `mapAsync` holds it for as long as the GPU
 * takes to complete that frame's submission plus the map callback. Three slots
 * therefore cover a readback latency of up to three frames and no more: enough
 * for a workload whose per-frame GPU cost stays well inside the frame period,
 * and not enough for one that does not.
 *
 * Depth is a measurement setting rather than a rendering one, so the default
 * stays at the historical three. A context that arms the profiler for its own
 * reasons allocates exactly what it did before, and a measurement that needs a
 * deeper ring asks for one.
 */
const DEFAULT_BUFFER_COUNT = 3;

/**
 * Shallowest ring worth allocating. At a depth of one the single slot is
 * revisited on the very next frame, so every frame after the first is skipped
 * by construction; an instrument that cannot sample is worse than no
 * instrument, so that depth is rejected rather than allowed to report zeroes.
 */
const MIN_BUFFER_COUNT = 2;

/**
 * Deepest ring allowed. Each slot costs one timestamp query set plus a resolve
 * and a readback buffer of `MAX_QUERIES * 8` bytes each, so the ceiling bounds
 * what a mistyped depth can allocate. It is not a claim that sixteen frames of
 * readback latency are survivable.
 */
const MAX_BUFFER_COUNT = 16;

/**
 * Rejects a ring depth that cannot produce a usable measurement.
 *
 * Loud by design. A clamped depth would let a caller believe it had asked for
 * headroom it did not get, and the sample loss that followed would read as
 * device behaviour rather than as a caller error.
 *
 * @param count - Requested ring depth.
 * @returns The validated depth.
 */
function validateBufferCount(count: number): number {
  if (
    !Number.isInteger(count) ||
    count < MIN_BUFFER_COUNT ||
    count > MAX_BUFFER_COUNT
  ) {
    throw new Error(
      `WebGPUTimestampProfiler buffer count must be an integer in [${MIN_BUFFER_COUNT}, ${MAX_BUFFER_COUNT}]; received ${count}`,
    );
  }
  return count;
}

/**
 * GPU timestamp profiler using WebGPU's timestamp-query feature.
 *
 * This profiler uses `timestampWrites` on render/compute passes (the modern API)
 * instead of the deprecated `GPUCommandEncoder.writeTimestamp()`.
 *
 * Readback runs through a ring of query sets so the render path never blocks:
 * - Frame N writes timestamps via timestampWrites
 * - After Frame N is submitted, mapAsync waits for its copy without blocking
 * - Later frames use the other slots while that readback is pending
 *
 * The ring is `bufferCount` slots deep and advances one slot per profiled
 * frame, so a slot's readback has exactly that many frames to complete before
 * the ring returns to it. A slot still held when its turn arrives costs the
 * whole frame its timing: `beginFrame` leaves the frame unarmed, its passes run
 * without `timestampWrites` at all, and `readbackSkipCount` records it. That is
 * reported as `ringSaturated`, because the frames that survive such a ring are
 * a subset selected by the very cost being measured.
 */
export class WebGPUTimestampProfiler {
  private _device: GPUDevice;
  private _enabled: boolean = false;

  // Readback ring, `_bufferCount` slots deep.
  private _frameStates: FrameQueryState[] = [];
  private _currentFrameIndex: number = 0;
  private _bufferCount: number = DEFAULT_BUFFER_COUNT;
  /**
   * Slots dropped from the ring by a resize while their `mapAsync` was still
   * outstanding. Destroying such a buffer immediately would reject the pending
   * map with an outcome the sample ledger has no bucket for, so the readback's
   * own completion path releases the slot instead; this set exists so
   * `destroy()` can still sweep any that never settle.
   */
  private _retiredStates: Set<FrameQueryState> = new Set();

  // Current frame tracking
  private _nextQueryIndex: number = 0;
  private _currentPassRecords: PassQueryRecord[] = [];
  private _currentFrameAvailable: boolean = false;
  /**
   * Whether `beginFrame` has run without its matching `endFrame` yet.
   * Distinct from `_currentFrameAvailable`, which stays set after
   * `endFrame` and so answers whether the LAST frame was armed rather
   * than whether a frame is open.
   */
  private _frameInProgress: boolean = false;
  private _currentFrameGeneration: number = 0;

  // Results storage
  private _latestResults: Map<string, number[]> = new Map();
  private _frameTimings: number[] = [];
  private _profiledPassTimings: number[] = [];
  private _coveredTimings: number[] = [];
  private _unprofiledTimings: number[] = [];
  private _latestOverlapMs: number = 0;
  private _latestUnprofiledRatio: number | null = null;
  private _latestCoverageBalanced: boolean = true;
  private _latestInvertedSampleCount: number = 0;
  private _overlappingFrameCount: number = 0;
  /**
   * The most recently read frame's raw pass intervals, retained so a
   * consumer can fold a scoped union — only the cloud passes, say — through
   * the same `summarizeFrameCoverage` this class uses for the whole frame.
   *
   * Retention costs nothing: `_readSubmittedFrame` already builds this array
   * per readback and used to drop it after the unscoped fold. Summing the
   * per-pass `lastMs` values from `getResults()` is NOT an alternative — it
   * double-counts every nanosecond two passes share, which is the exact defect
   * `WebGPUTimestampAccounting` was written to remove.
   */
  private _latestFrameSamples: readonly TimedPassSample[] = [];
  private _attemptedFrames: number = 0;
  private _sampledFrames: number = 0;
  private _droppedPassCount: number = 0;
  private _readbackSkipCount: number = 0;
  private _failedReadbackCount: number = 0;
  private _emptyFrameCount: number = 0;
  private _lostSampleCount: number = 0;
  private _generation: number = 0;
  private _pendingSubmissions: PendingSubmission[] = [];
  /**
   * Readbacks started by `afterSubmit()` that have not reached a terminal
   * outcome yet. Held so the capture tail can be drained instead of dropped —
   * the frames in here are real samples that a naive "stop capturing" would
   * lose.
   */
  private _activeReadbacks: Set<Promise<void>> = new Set();

  private _isDestroyed: boolean = false;

  /**
   * Creates a new timestamp profiler.
   *
   * @param device - The GPU device (must have 'timestamp-query' feature)
   * @param hasTimestampFeature - Whether the device supports timestamp queries
   * @param bufferCount - Readback ring depth. Defaults to the historical three;
   *        raise it only for a measurement whose readback latency needs it.
   */
  constructor(
    device: GPUDevice,
    hasTimestampFeature: boolean = false,
    bufferCount: number = DEFAULT_BUFFER_COUNT,
  ) {
    this._device = device;
    // Validated ahead of the feature check on purpose: a device without the
    // feature is exactly where a bad depth would otherwise go unnoticed until
    // it reached a device that has it.
    this._bufferCount = validateBufferCount(bufferCount);
    this._enabled =
      hasTimestampFeature && device.features.has("timestamp-query");

    if (!this._enabled) {
      return;
    }

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
    this._frameInProgress = true;
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
    } else if (this._currentFrameAvailable) {
      // Armed, but no timed pass ran. A terminal outcome all the same — an
      // empty frame that is not counted is an attempt with no outcome, which
      // is exactly the silent loss the ledger exists to catch.
      this._emptyFrameCount++;
    }

    // Advance to next frame state
    this._currentFrameIndex = (this._currentFrameIndex + 1) % this._bufferCount;
    this._attemptedFrames++;
    this._frameInProgress = false;
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
      const readback = this._readSubmittedFrame(submission);
      this._activeReadbacks.add(readback);
      void readback.finally(() => {
        this._activeReadbacks.delete(readback);
      });
    }
  }

  /**
   * Drains the readback tail so a capture's final frames are reported instead
   * of dropped. Readback is asynchronous, so the frames still in flight when a
   * capture stops are real samples whose loss makes the timer under-report.
   *
   * Bounded by construction: a readback that will never complete (device loss,
   * a lost queue submission) resolves the wait anyway and is reported as
   * `undrained` rather than hanging the caller.
   *
   * @param timeoutMs - Upper bound on the wait.
   * @returns What the drain recovered and what it could not.
   */
  async drainPendingReadbacks(
    timeoutMs: number = 1000,
  ): Promise<ReadbackDrainResult> {
    if (!this._enabled) {
      return { drained: 0, undrained: 0, abandoned: 0, timedOut: false };
    }

    // Submissions encoded but never handed to afterSubmit() have no readback
    // to await; they are lost samples and are counted as such.
    const abandoned = this._pendingSubmissions.length;
    if (abandoned > 0) {
      for (const submission of this._pendingSubmissions) {
        const state = this._frameStates[submission.stateIndex];
        if (state) {
          state.readbackPending = false;
        }
      }
      this._pendingSubmissions = [];
      this._lostSampleCount += abandoned;
    }

    const outstanding = [...this._activeReadbacks];
    if (outstanding.length === 0) {
      return { drained: 0, undrained: 0, abandoned, timedOut: false };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
    });
    try {
      const outcome = await Promise.race([
        Promise.allSettled(outstanding).then(() => "drained" as const),
        expiry,
      ]);
      const undrained = outcome === "timeout" ? this._activeReadbacks.size : 0;
      return {
        drained: outstanding.length - undrained,
        undrained,
        abandoned,
        timedOut: outcome === "timeout",
      };
    } finally {
      clearTimeout(timer);
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
      // The slot was recycled or was never armed, so this submission's
      // timestamps can never be read. It is a lost sample — recording it keeps
      // the ledger closed instead of letting the frame vanish. Clearing
      // `readbackPending` matters too: leaving it set would retire the slot
      // permanently and turn every later rotation onto it into a skip.
      this._lostSampleCount++;
      if (state) {
        state.readbackPending = false;
      }
      return;
    }

    try {
      const readbackBuffer = state.readbackBuffer;
      await readbackBuffer.mapAsync(GPUMapMode.READ);
      if (this._isDestroyed || submission.generation !== this._generation) {
        // A reset/destroy raced the readback. The counters this would have
        // fed were cleared with it, so it is neither sampled nor lost against
        // the current generation.
        return;
      }
      const data = new BigUint64Array(readbackBuffer.getMappedRange());
      const passTotals = new Map<string, number>();

      // Timestamps are absolute device values too large to subtract exactly in
      // a `number`, so everything downstream works relative to the frame's
      // first timestamp.
      let originNs = 0n;
      let hasOrigin = false;
      for (const record of state.passRecords) {
        const beginNs = data[record.beginIndex];
        if (!hasOrigin || beginNs < originNs) {
          originNs = beginNs;
          hasOrigin = true;
        }
      }

      const samples: TimedPassSample[] = [];
      for (const record of state.passRecords) {
        const beginNs = Number(data[record.beginIndex] - originNs);
        const endNs = Number(data[record.endIndex] - originNs);
        samples.push({ name: record.name, beginNs, endNs });
        const passMs = (endNs - beginNs) / 1_000_000;
        passTotals.set(
          record.name,
          (passTotals.get(record.name) ?? 0) + passMs,
        );
      }
      for (const [name, passMs] of passTotals) {
        let timings = this._latestResults.get(name);
        if (!timings) {
          timings = [];
          this._latestResults.set(name, timings);
        }
        this._addToRollingWindow(timings, passMs);
      }

      // Unique-sample fold: the union of the pass intervals, not their sum, is
      // what the frame span can be divided into. Any excess of the sum over
      // the union is overlap, reported rather than clamped away.
      const coverage = summarizeFrameCoverage(samples);
      // Retain the intervals the fold consumed so a scoped consumer
      // can re-fold a subset. Assignment only; the array was allocated above.
      this._latestFrameSamples = samples;
      this._addToRollingWindow(this._frameTimings, coverage.frameSpanMs);
      this._addToRollingWindow(
        this._profiledPassTimings,
        coverage.summedPassMs,
      );
      this._addToRollingWindow(this._coveredTimings, coverage.coveredMs);
      this._addToRollingWindow(this._unprofiledTimings, coverage.unprofiledMs);
      this._latestOverlapMs = coverage.overlapMs;
      this._latestUnprofiledRatio = coverage.unprofiledRatio;
      this._latestCoverageBalanced = coverage.balanced;
      this._latestInvertedSampleCount = coverage.invertedSampleCount;
      if (coverage.overlapMs > 0) {
        this._overlappingFrameCount++;
      }
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
      if (this._retiredStates.delete(state) && !this._isDestroyed) {
        // A resize dropped this slot from the ring while its map was still
        // in flight. The map has settled now, so the GPU objects can go.
        state.querySet.destroy();
        state.resolveBuffer.destroy();
        state.readbackBuffer.destroy();
      }
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
   *
   * Values come from the most recent readback to complete, so they lag the
   * current frame by the readback latency rather than by the ring depth: a
   * deeper ring does not make results staler, it leaves fewer frames
   * unsampled. Check `ringSaturated` before averaging — when it is set, the
   * mean is over the frames the ring managed to keep up with.
   */
  getResults(): ProfilingResults {
    const ledger = this._sampleLedger();
    const balance = balanceSampleLedger(ledger);

    if (!this._enabled) {
      return {
        enabled: false,
        frameMs: 0,
        frameAvgMs: 0,
        profiledPassMs: 0,
        profiledPassAvgMs: 0,
        coveredMs: 0,
        coveredAvgMs: 0,
        overlapMs: 0,
        overlappingFrameCount: this._overlappingFrameCount,
        unprofiledMs: 0,
        unprofiledAvgMs: 0,
        coverageRatio: null,
        unprofiledRatio: null,
        coverageBalanced: true,
        coverageScope: "between-first-and-last-timed-pass",
        passes: {},
        frameCount: ledger.sampled,
        attemptedFrameCount: ledger.attempted,
        droppedPassCount: this._droppedPassCount,
        readbackSkipCount: ledger.skipped,
        bufferCount: this._bufferCount,
        ringSaturated: ledger.skipped > 0,
        failedReadbackCount: ledger.failed,
        emptyFrameCount: ledger.empty,
        lostSampleCount: ledger.lost,
        pendingReadbackCount: ledger.pending,
        sampleLedgerBalanced: balance.balanced,
        unaccountedSampleCount: balance.unaccounted,
        invertedSampleCount: this._latestInvertedSampleCount,
      };
    }

    const frameStats = this._computeStats(this._frameTimings);
    const profiledPassStats = this._computeStats(this._profiledPassTimings);
    const coveredStats = this._computeStats(this._coveredTimings);
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
      coveredMs: coveredStats.last,
      coveredAvgMs: coveredStats.avg,
      overlapMs: this._latestOverlapMs,
      overlappingFrameCount: this._overlappingFrameCount,
      unprofiledMs: unprofiledStats.last,
      unprofiledAvgMs: unprofiledStats.avg,
      // Union-derived, so this is a true fraction of the span rather than a
      // sum clamped into range — the clamp used to hide pass overlap.
      coverageRatio:
        frameStats.last > 0 ? coveredStats.last / frameStats.last : null,
      unprofiledRatio: this._latestUnprofiledRatio,
      coverageBalanced: this._latestCoverageBalanced,
      coverageScope: "between-first-and-last-timed-pass",
      passes,
      frameCount: ledger.sampled,
      attemptedFrameCount: ledger.attempted,
      droppedPassCount: this._droppedPassCount,
      readbackSkipCount: ledger.skipped,
      bufferCount: this._bufferCount,
      ringSaturated: ledger.skipped > 0,
      failedReadbackCount: ledger.failed,
      emptyFrameCount: ledger.empty,
      lostSampleCount: ledger.lost,
      pendingReadbackCount: ledger.pending,
      sampleLedgerBalanced: balance.balanced,
      unaccountedSampleCount: balance.unaccounted,
      invertedSampleCount: this._latestInvertedSampleCount,
    };
  }

  /**
   * The six terminal outcomes of every profiling attempt. `pending` counts the
   * readbacks still in flight, which is why a report taken mid-capture still
   * balances — the tail is accounted, not missing.
   */
  private _sampleLedger(): {
    attempted: number;
    sampled: number;
    skipped: number;
    empty: number;
    failed: number;
    lost: number;
    pending: number;
  } {
    return {
      attempted: this._attemptedFrames,
      sampled: this._sampledFrames,
      skipped: this._readbackSkipCount,
      empty: this._emptyFrameCount,
      failed: this._failedReadbackCount,
      lost: this._lostSampleCount,
      pending: this._activeReadbacks.size + this._pendingSubmissions.length,
    };
  }

  reset(): void {
    this._generation++;
    this._frameInProgress = false;
    this._latestResults.clear();
    this._frameTimings = [];
    this._profiledPassTimings = [];
    this._coveredTimings = [];
    this._unprofiledTimings = [];
    this._latestOverlapMs = 0;
    this._latestUnprofiledRatio = null;
    this._latestCoverageBalanced = true;
    this._latestInvertedSampleCount = 0;
    this._overlappingFrameCount = 0;
    // A retained sample set outlives the counters it was folded into unless it
    // is cleared here too — a scoped consumer would otherwise keep reporting
    // the pre-reset frame as current.
    this._latestFrameSamples = [];
    this._attemptedFrames = 0;
    this._sampledFrames = 0;
    this._droppedPassCount = 0;
    this._readbackSkipCount = 0;
    this._failedReadbackCount = 0;
    this._emptyFrameCount = 0;
    this._lostSampleCount = 0;
  }

  /**
   * The most recently read frame's raw pass intervals, in nanoseconds
   * relative to that frame's origin. Empty until a readback completes and
   * after `reset()`.
   *
   * Exposed so a subsystem can fold a SCOPED unique-sample union over its own
   * passes (`WebGPUCloudObservability.summarizeCloudGpuCoverage`) instead of
   * summing `getResults().passes[*].lastMs`, which double-counts overlap.
   */
  get latestFrameSamples(): readonly TimedPassSample[] {
    return this._latestFrameSamples;
  }

  /** Depth of the readback ring, in frames. */
  get bufferCount(): number {
    return this._bufferCount;
  }

  /**
   * Re-sizes the readback ring.
   *
   * The depth a workload needs is its readback latency measured in profiled
   * frames: how long the GPU takes to finish a frame's submission and deliver
   * the map callback, against how often the ring comes back to that slot. A
   * caller that has measured its own worst case can raise the depth to cover
   * it; a caller that has not should leave the default alone.
   *
   * Resizing discards the current measurement. Slot indices do not survive the
   * resize, and pooling samples across two depths would mix two differently
   * instrumented frame populations — a frame the ring cannot arm runs with no
   * `timestampWrites` at all, so changing how often that happens changes what
   * the surviving frames are.
   *
   * Drain first (`drainPendingReadbacks`). As with `reset()`, the counters are
   * cleared while any readback still in flight remains counted as pending, so
   * an undrained resize reads as an unbalanced ledger until it settles.
   *
   * @param count - Requested ring depth.
   */
  setBufferCount(count: number): void {
    const next = validateBufferCount(count);
    if (next === this._bufferCount) {
      return;
    }

    // `beginFrame` may already have armed an OPEN frame against the ring
    // being replaced. Its `endFrame` still counts an attempt, so that attempt
    // needs the terminal outcome the arming would have carried — recorded
    // after `reset()`, which zeroes the counters. A closed frame needs
    // nothing: its outcome is already in the counters being cleared.
    const armedAgainstOldRing =
      this._frameInProgress && this._currentFrameAvailable;

    const retiring = this._frameStates;
    this._frameStates = [];
    // Encoded but never handed to `afterSubmit()`, and their slot indices do
    // not survive the resize, so no readback can ever be started for them.
    this._pendingSubmissions = [];
    this._bufferCount = next;
    this.reset();
    this._currentFrameIndex = 0;
    this._currentFrameAvailable = false;
    this._nextQueryIndex = 0;
    this._currentPassRecords = [];
    if (armedAgainstOldRing) {
      this._readbackSkipCount++;
    }

    for (const state of retiring) {
      if (state.readbackPending) {
        this._retiredStates.add(state);
        continue;
      }
      state.querySet.destroy();
      state.resolveBuffer.destroy();
      state.readbackBuffer.destroy();
    }

    if (!this._enabled) {
      return;
    }
    for (let i = 0; i < this._bufferCount; i++) {
      this._frameStates.push(this._createFrameState(i));
    }
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
    // Slots a resize retired whose readback never settled would otherwise
    // outlive the profiler that allocated them.
    for (const state of this._retiredStates) {
      state.querySet.destroy();
      state.resolveBuffer.destroy();
      state.readbackBuffer.destroy();
    }
    this._retiredStates.clear();
    this._frameStates = [];
    this._latestResults.clear();
    this._frameTimings = [];
    this._profiledPassTimings = [];
    this._coveredTimings = [];
    this._unprofiledTimings = [];
    this._currentPassRecords = [];
    this._pendingSubmissions = [];
    this._activeReadbacks.clear();
    this._currentFrameAvailable = false;
    this._frameInProgress = false;
    this._generation++;
    this._enabled = false;
    this._isDestroyed = true;
  }
}

export default WebGPUTimestampProfiler;
