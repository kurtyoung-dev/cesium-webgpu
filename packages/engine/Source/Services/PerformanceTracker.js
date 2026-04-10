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
          if (s.indexOf(",") >= 0 || s.indexOf('"') >= 0) {
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
