/**
 * @module PerformanceTracker
 *
 * Backend-neutral perf benchmarking + logging service. Records a
 * window of per-frame measurements (CPU time, GPU time, draw count,
 * bundle hit rate, snapshot mode state) and exposes the result as a
 * structured object suitable for `console.table()`, JSON export, or
 * CSV download.
 *
 * Designed to compose with the existing per-context profiling surfaces
 * — `WebGPUTimestampProfiler.getResults()` for GPU time, the bundle
 * manager statistics for cache behavior, the snapshot service for the
 * "is the scene actually idle" question — without forcing the operator
 * to stitch the picture together by hand.
 *
 * ── Typical use ─────────────────────────────────────────────────────
 *
 *     const tracker = new PerformanceTracker();
 *     tracker.beginTrace("idle-orbit-snapshot-on", { frames: 600 });
 *     // ... let the scene render for 600 frames ...
 *     // (called by Scene.render() once per frame; see Scene.beginPerformanceTrace)
 *     const result = tracker.endTrace();
 *     console.log(tracker.toCSV(result));
 *
 * The tracker is intentionally side-effect free until `beginTrace` is
 * called. Production scenes pay zero cost while no trace is active.
 *
 * @private
 */

import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";

// ─── Live FPS histogram constants ─────────────────────────────────────
//
// The continuous live buffer stores a Float32 frame time per slot and
// is sized to hold ~60 seconds at a generous frame rate. We pick 4096
// (≈68 seconds at 60 fps) so the percentile math has plenty of headroom
// even on a 75/120/144 Hz display where the per-frame budget is
// shorter than 16.6 ms. The buffer is allocated once at construction
// and recycled forever — no per-frame allocations, no GC pressure.
const LIVE_BUFFER_CAPACITY = 4096;
// Maximum window the live API will report on. Larger windows fall back
// to the buffer's full content.
const LIVE_DEFAULT_WINDOW_SECONDS = 60;

class PerformanceTracker {
  constructor() {
    /** @type {boolean} */
    this._active = false;
    /** @type {string|null} */
    this._label = null;
    /** @type {number} */
    this._maxFrames = 0;
    /** @type {number|null} */
    this._startFrameNumber = null;
    /** @type {number|null} */
    this._startWallTime = null;
    /** @type {Array<object>} */
    this._samples = [];
    /** @type {number} Last `performance.now()` reading for CPU dt. */
    this._lastSampleWallTime = 0;
    // Diagnostic — total traces completed since construction.
    this._traceCount = 0;

    // ─── Live continuous FPS buffer ───────────────────────────────────
    // Records every frame the Scene draws regardless of trace state.
    // The trace API (begin/end) is for one-shot benchmarking; the live
    // buffer is for the always-on FPS HUD that wants average + 1% lows
    // + 1% highs over a rolling window.
    /** @type {Float32Array} circular buffer of wall-time deltas in ms */
    this._liveDtMs = new Float32Array(LIVE_BUFFER_CAPACITY);
    /** @type {Float64Array} parallel circular buffer of frame timestamps */
    this._liveTimestamps = new Float64Array(LIVE_BUFFER_CAPACITY);
    /** @type {number} write index — bumps modulo capacity */
    this._liveWriteIndex = 0;
    /** @type {number} total frames recorded since reset */
    this._liveFrameCount = 0;
    /** @type {number|null} last live recordFrame timestamp for delta calc */
    this._liveLastRecordTime = null;
    /** @type {object} cached live snapshot (avoids per-poll allocation) */
    this._liveCachedSnapshot = {
      windowSeconds: 0,
      sampleCount: 0,
      avgFps: 0,
      avgFrameMs: 0,
      onePercentLowFps: 0,
      onePercentHighFps: 0,
      minFrameMs: 0,
      maxFrameMs: 0,
      latestFrameMs: 0,
      latestFps: 0,
    };
    // Scratch typed array for percentile sorting — avoids per-poll
    // allocation when getLiveStats() is called once per HUD update.
    /** @type {Float32Array} */
    this._liveScratch = new Float32Array(LIVE_BUFFER_CAPACITY);
  }

  /**
   * Whether a trace is currently active. While false, `sample()` is a
   * no-op and the production render path pays nothing.
   * @type {boolean}
   * @readonly
   */
  get active() {
    return this._active;
  }

  /**
   * The current trace label, or `null` when inactive.
   * @type {string|null}
   * @readonly
   */
  get label() {
    return this._label;
  }

  /**
   * Begin a new performance trace.
   *
   * @param {string} label Diagnostic label that will be carried into
   *   the result and any exported CSV / JSON.
   * @param {object} [options]
   * @param {number} [options.frames=600] Maximum number of frames to
   *   capture before the trace auto-ends. Set to 0 to capture
   *   indefinitely (must call `endTrace()` manually).
   */
  beginTrace(label, options) {
    //>>includeStart('debug', pragmas.debug);
    if (typeof label !== "string" || label.length === 0) {
      throw new DeveloperError("label must be a non-empty string");
    }
    //>>includeEnd('debug');
    if (this._active) {
      // Idempotent overwrite — trace cancellation + restart so
      // operators don't have to remember which trace is open.
      this._reset();
    }
    this._active = true;
    this._label = label;
    this._maxFrames = options?.frames ?? 600;
    this._startFrameNumber = null;
    this._startWallTime =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    this._lastSampleWallTime = this._startWallTime;
    this._samples = [];
  }

  /**
   * Record one per-frame sample. Called from `Scene.render()` once per
   * rendered frame between `beginTrace` and `endTrace`. The shape of
   * the recorded row is intentionally permissive — fields the caller
   * doesn't supply (or fields the backend doesn't expose) are simply
   * absent from the row, not zero-filled, so a CSV export can show
   * "this backend doesn't have GPU timestamps" by missing-cell rather
   * than misleading 0.0 values.
   *
   * @param {object} input
   * @param {number} input.frameNumber Scene frame number for this sample.
   * @param {number} [input.cpuMs] CPU wall time for this frame (ms).
   * @param {number} [input.gpuMs] GPU wall time from timestamp profiler (ms).
   * @param {number} [input.drawCount] Number of draws issued.
   * @param {number} [input.commandCount] Number of commands processed.
   * @param {object} [input.bundleStats] Bundle manager statistics.
   * @param {boolean} [input.snapshotFrozen] Snapshot mode frozen state.
   * @param {object} [input.extra] Caller-supplied extra fields.
   */
  sample(input) {
    if (!this._active) {
      return;
    }
    if (!defined(input)) {
      return;
    }
    if (this._startFrameNumber === null) {
      this._startFrameNumber = input.frameNumber ?? 0;
    }
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const wallDt = now - this._lastSampleWallTime;
    this._lastSampleWallTime = now;
    const row = {
      frameNumber: input.frameNumber ?? -1,
      relFrame: (input.frameNumber ?? 0) - (this._startFrameNumber ?? 0),
      wallDtMs: wallDt,
    };
    if (defined(input.cpuMs)) {
      row.cpuMs = input.cpuMs;
    }
    if (defined(input.gpuMs)) {
      row.gpuMs = input.gpuMs;
    }
    if (defined(input.drawCount)) {
      row.drawCount = input.drawCount;
    }
    if (defined(input.commandCount)) {
      row.commandCount = input.commandCount;
    }
    if (defined(input.snapshotFrozen)) {
      row.snapshotFrozen = input.snapshotFrozen;
    }
    if (defined(input.bundleStats)) {
      const bs = input.bundleStats;
      row.bundleCacheSize = bs.cacheSize;
      row.bundleHits = bs.hits;
      row.bundleMisses = bs.misses;
      row.bundleEphemeral = bs.ephemeralBuilds;
      row.bundleHitRate = bs.hitRate;
      row.bundleFrozen = bs.frozen;
    }
    if (defined(input.extra) && typeof input.extra === "object") {
      for (const k in input.extra) {
        if (Object.prototype.hasOwnProperty.call(input.extra, k)) {
          row[k] = input.extra[k];
        }
      }
    }
    this._samples.push(row);
    if (this._maxFrames > 0 && this._samples.length >= this._maxFrames) {
      // Auto-end when the configured frame count is reached. The
      // result is held until `endTrace()` is called explicitly so the
      // operator can pull it on their schedule.
      this._active = false;
    }
  }

  /**
   * End the current trace and return the structured result. The
   * result is also retained internally as `lastResult` so an operator
   * can keep calling getter methods on the tracker.
   *
   * @returns {object|null} The result, or `null` if no trace was started.
   */
  endTrace() {
    if (this._label === null && this._samples.length === 0) {
      return null;
    }
    const endWallTime =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const result = this._summarize(endWallTime);
    this._lastResult = result;
    this._traceCount++;
    this._reset();
    return result;
  }

  /**
   * The most recent completed trace result, or `null` if no trace has
   * been completed yet. Useful for late-binding inspection from the
   * dev tools console after the trace has auto-ended.
   * @type {object|null}
   * @readonly
   */
  get lastResult() {
    return this._lastResult ?? null;
  }

  /**
   * Number of completed traces since construction.
   * @type {number}
   * @readonly
   */
  get traceCount() {
    return this._traceCount;
  }

  /**
   * Convert a result (or the `lastResult` if no argument) to a CSV
   * string suitable for piping into a file or pasting into a
   * spreadsheet. Column order is stable across runs so two traces of
   * the same scene can be diffed line-by-line.
   *
   * @param {object} [result]
   * @returns {string}
   */
  toCSV(result) {
    const r = result ?? this._lastResult;
    if (!defined(r) || !r.samples || r.samples.length === 0) {
      return "";
    }
    // Build the column union across all rows so a row that omits a
    // field still produces an empty cell, not a column-misalignment.
    const columns = new Set(["frameNumber", "relFrame", "wallDtMs"]);
    for (const row of r.samples) {
      for (const k in row) {
        if (Object.prototype.hasOwnProperty.call(row, k)) {
          columns.add(k);
        }
      }
    }
    const cols = Array.from(columns);
    const header = cols.join(",");
    const lines = [header];
    for (const row of r.samples) {
      const line = cols
        .map((c) => {
          const v = row[c];
          if (v === undefined || v === null) {
            return "";
          }
          if (typeof v === "boolean") {
            return v ? "1" : "0";
          }
          if (typeof v === "number") {
            // Stable 4-decimal formatting for floats; integers stay
            // integer.
            return Number.isInteger(v) ? String(v) : v.toFixed(4);
          }
          // String — escape commas + quotes.
          const s = String(v);
          if (s.includes(",") || s.includes('"')) {
            return `"${s.replace(/"/g, '""')}"`;
          }
          return s;
        })
        .join(",");
      lines.push(line);
    }
    return lines.join("\n");
  }

  /**
   * Convert a result to a JSON string. Equivalent to
   * `JSON.stringify(result, null, 2)` but rounds floats to 4 decimal
   * places to keep the output diff-friendly.
   *
   * @param {object} [result]
   * @returns {string}
   */
  toJSON(result) {
    const r = result ?? this._lastResult;
    if (!defined(r)) {
      return "null";
    }
    return JSON.stringify(
      r,
      function (_k, v) {
        if (typeof v === "number" && !Number.isInteger(v)) {
          return Math.round(v * 10000) / 10000;
        }
        return v;
      },
      2,
    );
  }

  /**
   * Pretty-print the result to the console using `console.table()`
   * for the per-frame samples and `console.log()` for the summary.
   *
   * @param {object} [result]
   */
  logToConsole(result) {
    const r = result ?? this._lastResult;
    if (!defined(r)) {
      console.log("[PerformanceTracker] no result available");
      return;
    }
    console.log(`[PerformanceTracker] ${r.label}`, r.summary);
    if (typeof console.table === "function") {
      console.table(r.samples);
    } else {
      console.log(r.samples);
    }
  }

  // ─── Live FPS API ────────────────────────────────────────────────
  //
  // The live API is independent of the trace API. It's called every
  // rendered frame regardless of whether a trace is active, records
  // wall-time deltas in a fixed-size circular buffer, and computes
  // rolling-window statistics on demand. Designed to feed an FPS HUD
  // that updates 4-10 times per second without paying for percentile
  // computation on frames where nobody is asking.
  //
  // Performance budget: recordFrame() is two array writes + two
  // increments + one delta — well under 100 ns per frame. The buffer
  // is preallocated, so steady-state GC pressure is zero.

  /**
   * Record one frame's wall-time delta into the live circular buffer.
   * Call this from the Scene render loop AFTER the frame has finished
   * (i.e., after `executeCommands` returns) so the recorded delta
   * represents the full per-frame budget.
   *
   * Inputs are optional — if `wallDtMs` is omitted, the tracker
   * computes the delta from the previous call's `performance.now()`.
   * This makes the live API drop-in usable without forcing the caller
   * to thread its own timing state.
   *
   * @param {number} [wallDtMs] Explicit frame delta in ms.
   * @param {number} [timestamp] Explicit timestamp (default: performance.now()).
   */
  recordFrame(wallDtMs, timestamp) {
    const now = defined(timestamp)
      ? timestamp
      : typeof performance !== "undefined"
        ? performance.now()
        : Date.now();
    let dt = wallDtMs;
    if (!defined(dt)) {
      dt =
        this._liveLastRecordTime === null
          ? 16.6
          : now - this._liveLastRecordTime;
    }
    this._liveLastRecordTime = now;
    // Drop pathological deltas (debugger paused, tab backgrounded for
    // a long time, hot reload). >2 seconds is not a real frame; it
    // would skew the percentile math by orders of magnitude.
    if (dt < 0 || dt > 2000) {
      return;
    }
    const idx = this._liveWriteIndex;
    this._liveDtMs[idx] = dt;
    this._liveTimestamps[idx] = now;
    this._liveWriteIndex = (idx + 1) % LIVE_BUFFER_CAPACITY;
    this._liveFrameCount++;
  }

  /**
   * Compute rolling FPS statistics over the last `windowSeconds` of
   * recorded frames. Returns an object with average, min, max, latest,
   * and the 1st / 99th percentile FPS values (the standard "1% lows"
   * and "1% highs" used by game perf overlays).
   *
   * **Percentile interpretation**:
   * - "1% low FPS" = the 99th percentile of frame times, converted to
   *   FPS. This is the FPS you'd see at the worst 1% of frames; it
   *   tells you how janky the worst-case frames feel.
   * - "1% high FPS" = the 1st percentile of frame times, converted to
   *   FPS. The smoothest 1% of frames; useful for showing the
   *   theoretical ceiling.
   *
   * The returned object is the SAME instance every call (writes into
   * a cached struct) — the caller MUST NOT retain a reference across
   * frames if they want a stable snapshot. Copy the fields they need.
   *
   * @param {number} [windowSeconds=60] Rolling window in seconds.
   * @returns {{
   *   windowSeconds: number,
   *   sampleCount: number,
   *   avgFps: number,
   *   avgFrameMs: number,
   *   onePercentLowFps: number,
   *   onePercentHighFps: number,
   *   minFrameMs: number,
   *   maxFrameMs: number,
   *   latestFrameMs: number,
   *   latestFps: number,
   * }}
   */
  getLiveStats(windowSeconds) {
    const window = windowSeconds ?? LIVE_DEFAULT_WINDOW_SECONDS;
    const out = this._liveCachedSnapshot;
    out.windowSeconds = window;
    out.sampleCount = 0;
    out.avgFps = 0;
    out.avgFrameMs = 0;
    out.onePercentLowFps = 0;
    out.onePercentHighFps = 0;
    out.minFrameMs = 0;
    out.maxFrameMs = 0;
    out.latestFrameMs = 0;
    out.latestFps = 0;

    if (this._liveFrameCount === 0) {
      return out;
    }
    const cutoff = (this._liveLastRecordTime ?? 0) - window * 1000;
    // Walk the circular buffer backwards from the latest write position,
    // gathering frame times newer than the cutoff. Stops at the first
    // frame older than the cutoff OR after the buffer is exhausted.
    const cap = LIVE_BUFFER_CAPACITY;
    const newest = (this._liveWriteIndex - 1 + cap) % cap;
    const scratch = this._liveScratch;
    let count = 0;
    let sum = 0;
    let minMs = Infinity;
    let maxMs = -Infinity;
    const totalAvailable = Math.min(this._liveFrameCount, cap);
    for (let i = 0; i < totalAvailable; i++) {
      const idx = (newest - i + cap) % cap;
      const ts = this._liveTimestamps[idx];
      if (ts < cutoff) {
        break;
      }
      const dt = this._liveDtMs[idx];
      scratch[count++] = dt;
      sum += dt;
      if (dt < minMs) {
        minMs = dt;
      }
      if (dt > maxMs) {
        maxMs = dt;
      }
    }
    if (count === 0) {
      return out;
    }
    // Sort the gathered slice in place to compute percentiles. Float32
    // typed-array sort is supported by all modern engines and is
    // ~3x faster than Array.prototype.sort on numeric data because it
    // avoids JS↔number boxing.
    const sliceView = scratch.subarray(0, count);
    sliceView.sort();
    // 1% low FPS: the worst 1% of frames have frame time at the 99th
    // percentile or higher, so the FPS the user sees during those is
    // 1000 / sliceView[p99Index].
    const p1Index = Math.floor(count * 0.01);
    const p99Index = Math.min(count - 1, Math.floor(count * 0.99));
    const p1FrameMs = sliceView[p1Index];
    const p99FrameMs = sliceView[p99Index];
    const latestMs = this._liveDtMs[newest];

    out.sampleCount = count;
    out.avgFrameMs = sum / count;
    out.avgFps = 1000 / out.avgFrameMs;
    out.onePercentLowFps = p99FrameMs > 0 ? 1000 / p99FrameMs : 0;
    out.onePercentHighFps = p1FrameMs > 0 ? 1000 / p1FrameMs : 0;
    out.minFrameMs = minMs;
    out.maxFrameMs = maxMs;
    out.latestFrameMs = latestMs;
    out.latestFps = latestMs > 0 ? 1000 / latestMs : 0;
    return out;
  }

  /**
   * Snapshot the most recent N frame times into a freshly-allocated
   * Float32Array. Used by the FPS graph overlay to render a continuous
   * timeline. The returned array is freshly allocated each call so the
   * caller can hold the reference safely; this is the one place we
   * deliberately allocate, since the HUD draws maybe 4 times a second.
   *
   * @param {number} count Number of frames to snapshot (clamped to buffer capacity).
   * @returns {Float32Array} Newest-last array of frame times in ms.
   */
  getLiveFrameTimeSnapshot(count) {
    const cap = LIVE_BUFFER_CAPACITY;
    const available = Math.min(this._liveFrameCount, cap);
    const n = Math.max(0, Math.min(count ?? available, available));
    const out = new Float32Array(n);
    if (n === 0) {
      return out;
    }
    const newest = (this._liveWriteIndex - 1 + cap) % cap;
    // Fill out[] in chronological order: oldest at index 0, newest at index n-1.
    for (let i = 0; i < n; i++) {
      const srcIdx = (newest - (n - 1 - i) + cap) % cap;
      out[i] = this._liveDtMs[srcIdx];
    }
    return out;
  }

  /**
   * Reset the live circular buffer. Trace state is unaffected. Useful
   * when the operator wants the FPS HUD to forget a stall (e.g. after
   * a tile load storm or a debugger pause).
   */
  resetLiveStats() {
    this._liveWriteIndex = 0;
    this._liveFrameCount = 0;
    this._liveLastRecordTime = null;
    // The buffer contents themselves don't need to be cleared — the
    // window-based readout in `getLiveStats` reads only the last
    // `_liveFrameCount` slots.
  }

  // ─── Private helpers ─────────────────────────────────────────────

  _summarize(endWallTime) {
    const samples = this._samples;
    const summary = {
      label: this._label,
      frameCount: samples.length,
      startWallTime: this._startWallTime,
      endWallTime,
      totalWallMs:
        this._startWallTime !== null ? endWallTime - this._startWallTime : 0,
    };
    // Roll up CPU/GPU stats.
    if (samples.length > 0) {
      const aggregate = (key) => {
        let count = 0;
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        for (const r of samples) {
          const v = r[key];
          if (typeof v !== "number" || !isFinite(v)) {
            continue;
          }
          count++;
          sum += v;
          if (v < min) {
            min = v;
          }
          if (v > max) {
            max = v;
          }
        }
        if (count === 0) {
          return null;
        }
        return {
          count,
          avg: sum / count,
          min,
          max,
          total: sum,
        };
      };
      const cpu = aggregate("cpuMs");
      if (cpu) {
        summary.cpuMs = cpu;
      }
      const gpu = aggregate("gpuMs");
      if (gpu) {
        summary.gpuMs = gpu;
      }
      const wall = aggregate("wallDtMs");
      if (wall) {
        summary.wallDtMs = wall;
      }
      // Average bundle hit rate across the trace, weighted by frame count.
      let hitRateSum = 0;
      let hitRateCount = 0;
      for (const r of samples) {
        if (typeof r.bundleHitRate === "number") {
          hitRateSum += r.bundleHitRate;
          hitRateCount++;
        }
      }
      if (hitRateCount > 0) {
        summary.avgBundleHitRate = hitRateSum / hitRateCount;
      }
      // Frozen frame ratio — how much of the trace was inside snapshot mode.
      let frozenCount = 0;
      let frozenChecked = 0;
      for (const r of samples) {
        if (typeof r.snapshotFrozen === "boolean") {
          frozenChecked++;
          if (r.snapshotFrozen) {
            frozenCount++;
          }
        }
      }
      if (frozenChecked > 0) {
        summary.snapshotFrozenRatio = frozenCount / frozenChecked;
      }
    }
    return {
      label: this._label,
      summary,
      samples: samples.slice(),
    };
  }

  _reset() {
    this._active = false;
    this._label = null;
    this._maxFrames = 0;
    this._startFrameNumber = null;
    this._startWallTime = null;
    this._samples = [];
    this._lastSampleWallTime = 0;
  }
}

export default PerformanceTracker;
