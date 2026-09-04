/**
 * Performance subscriber for
 * `AsyncResourceMonitor`. One instance per `GraphicsContext`.
 *
 * The monitor itself is a low-level event bus optimized for wakeup
 * signaling — it must work whether or not perf tracking is enabled.
 * This class is the perf-side consumer that subscribes to the monitor
 * and aggregates per-`AsyncResourceKind` statistics:
 *
 *   - resolved / rejected counts (lifetime)
 *   - mean duration ms
 *   - p50 / p95 / p99 latency over a rolling window of recent samples
 *   - peak inflight per kind (sampled at every event)
 *
 * Why a separate class (vs baking into the monitor):
 *   - Keeps the monitor simple and zero-allocation in the wakeup path.
 *   - Lets a `WebGPUPerformanceManager` (or any consumer) subscribe
 *     without forcing every other consumer to absorb the bookkeeping.
 *   - Telemetry can be detached cleanly (`destroy()`) when the perf
 *     service is disabled at runtime — wakeup signaling is unaffected.
 *
 * What this class does NOT do:
 *   - It does NOT decide to throttle features. That's the perf
 *     manager's job; it reads these stats and makes its own calls.
 *   - It does NOT call `requestRender()`. Wakeup is the monitor's job.
 *   - It does NOT track any metric not derivable from the monitor's
 *     event stream — keep it as a pure aggregation layer.
 *
 * Cost: one subscriber, one Map keyed by 6 kinds, each holding a small
 * rolling window (100 samples by default). Roughly 1 KB resident; per
 * event work is O(1) amortized (push to ring, occasional sort on stats
 * read). Always-on by default — the budget is below noise floor.
 *
 * @internal
 */

import type {
  AsyncResourceEvent,
  AsyncResourceKind,
  AsyncResourceMonitor,
} from "./AsyncResourceMonitor.js";

const ALL_KINDS: ReadonlyArray<AsyncResourceKind> = [
  "render-pipeline",
  "compute-pipeline",
  "shader-module",
  "texture-upload",
  "image-decode",
  "buffer-map",
];

const DEFAULT_WINDOW_SIZE = 100;

interface KindBucket {
  resolvedCount: number;
  rejectedCount: number;
  totalDurationMs: number;
  // Rolling window of recent durations for percentile estimation.
  // Implemented as a simple shift-on-overflow array — N=100, so the
  // cost of `shift()` is negligible vs the cost of a pipeline compile.
  recentDurations: number[];
  peakInflight: number;
  currentInflight: number;
}

export interface AsyncResourceKindStats {
  readonly kind: AsyncResourceKind;
  readonly resolvedCount: number;
  readonly rejectedCount: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly peakInflight: number;
  readonly currentInflight: number;
}

export interface AsyncResourceTelemetrySnapshot {
  readonly perKind: Readonly<Record<AsyncResourceKind, AsyncResourceKindStats>>;
  /** Aggregate across all kinds — useful for "is the device choking?" decisions. */
  readonly aggregate: {
    readonly resolvedCount: number;
    readonly rejectedCount: number;
    readonly currentInflight: number;
    readonly peakInflight: number;
    readonly meanMs: number;
  };
}

export interface AsyncResourceTelemetryOptions {
  /** Rolling window size for percentile estimation. Default 100. */
  readonly windowSize?: number;
}

export class AsyncResourceTelemetry {
  private readonly _monitor: AsyncResourceMonitor;
  private readonly _windowSize: number;
  private readonly _byKind: Map<AsyncResourceKind, KindBucket>;
  private _unsubscribe: (() => void) | null = null;
  private _aggregatePeakInflight = 0;

  constructor(
    monitor: AsyncResourceMonitor,
    options?: AsyncResourceTelemetryOptions,
  ) {
    this._monitor = monitor;
    this._windowSize = Math.max(1, options?.windowSize ?? DEFAULT_WINDOW_SIZE);
    this._byKind = new Map();
    for (const kind of ALL_KINDS) {
      this._byKind.set(kind, {
        resolvedCount: 0,
        rejectedCount: 0,
        totalDurationMs: 0,
        recentDurations: [],
        peakInflight: 0,
        currentInflight: 0,
      });
    }
    this._unsubscribe = monitor.subscribe((event) => this._onEvent(event));
  }

  /**
   * Detach from the monitor. After `destroy()`, the telemetry state is
   * preserved but no new events will land. Calling `destroy()` twice is
   * a no-op.
   */
  destroy(): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  isAttached(): boolean {
    return this._unsubscribe !== null;
  }

  /**
   * Snapshot the per-kind stats. Allocates a fresh object — suitable
   * for debug overlays and on-demand stats dumps; not a hot path.
   */
  snapshot(): AsyncResourceTelemetrySnapshot {
    const perKind: Record<AsyncResourceKind, AsyncResourceKindStats> = {
      "render-pipeline": this._statsForKind("render-pipeline"),
      "compute-pipeline": this._statsForKind("compute-pipeline"),
      "shader-module": this._statsForKind("shader-module"),
      "texture-upload": this._statsForKind("texture-upload"),
      "image-decode": this._statsForKind("image-decode"),
      "buffer-map": this._statsForKind("buffer-map"),
    };

    let aggResolved = 0;
    let aggRejected = 0;
    let aggCurrent = 0;
    let aggTotalMs = 0;
    let aggResolvedForMean = 0;
    for (const kind of ALL_KINDS) {
      const bucket = this._byKind.get(kind);
      if (!bucket) continue;
      aggResolved += bucket.resolvedCount;
      aggRejected += bucket.rejectedCount;
      aggCurrent += bucket.currentInflight;
      aggTotalMs += bucket.totalDurationMs;
      aggResolvedForMean += bucket.resolvedCount;
    }

    return {
      perKind,
      aggregate: {
        resolvedCount: aggResolved,
        rejectedCount: aggRejected,
        currentInflight: aggCurrent,
        peakInflight: this._aggregatePeakInflight,
        meanMs: aggResolvedForMean === 0 ? 0 : aggTotalMs / aggResolvedForMean,
      },
    };
  }

  /**
   * Lightweight one-kind read used by perf-budget deciders. Avoids the
   * full snapshot allocation when the consumer only cares about one
   * resource class (e.g., the perf manager checking render-pipeline
   * latency before deciding to throttle pipeline variants).
   */
  getStatsForKind(kind: AsyncResourceKind): AsyncResourceKindStats {
    return this._statsForKind(kind);
  }

  private _onEvent(event: AsyncResourceEvent): void {
    const bucket = this._byKind.get(event.token.kind);
    if (!bucket) return;

    if (event.kind === "started") {
      bucket.currentInflight++;
      if (bucket.currentInflight > bucket.peakInflight) {
        bucket.peakInflight = bucket.currentInflight;
      }
      const total = this._monitor.pendingCount;
      if (total > this._aggregatePeakInflight) {
        this._aggregatePeakInflight = total;
      }
      return;
    }

    // resolved or rejected — both close the inflight slot.
    if (bucket.currentInflight > 0) {
      bucket.currentInflight--;
    }

    if (event.kind === "resolved") {
      bucket.resolvedCount++;
      const ms = event.durationMs ?? 0;
      bucket.totalDurationMs += ms;
      bucket.recentDurations.push(ms);
      if (bucket.recentDurations.length > this._windowSize) {
        bucket.recentDurations.shift();
      }
    } else {
      bucket.rejectedCount++;
    }
  }

  private _statsForKind(kind: AsyncResourceKind): AsyncResourceKindStats {
    const bucket = this._byKind.get(kind);
    if (!bucket) {
      return EMPTY_STATS_BY_KIND[kind];
    }
    const meanMs =
      bucket.resolvedCount === 0
        ? 0
        : bucket.totalDurationMs / bucket.resolvedCount;
    const sorted =
      bucket.recentDurations.length === 0
        ? []
        : [...bucket.recentDurations].sort((a, b) => a - b);
    const p = (q: number): number => {
      if (sorted.length === 0) return 0;
      const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
      return sorted[idx];
    };
    return {
      kind,
      resolvedCount: bucket.resolvedCount,
      rejectedCount: bucket.rejectedCount,
      meanMs,
      p50Ms: p(0.5),
      p95Ms: p(0.95),
      p99Ms: p(0.99),
      peakInflight: bucket.peakInflight,
      currentInflight: bucket.currentInflight,
    };
  }
}

const EMPTY_STATS_BY_KIND: Record<AsyncResourceKind, AsyncResourceKindStats> = {
  "render-pipeline": emptyStats("render-pipeline"),
  "compute-pipeline": emptyStats("compute-pipeline"),
  "shader-module": emptyStats("shader-module"),
  "texture-upload": emptyStats("texture-upload"),
  "image-decode": emptyStats("image-decode"),
  "buffer-map": emptyStats("buffer-map"),
};

function emptyStats(kind: AsyncResourceKind): AsyncResourceKindStats {
  return {
    kind,
    resolvedCount: 0,
    rejectedCount: 0,
    meanMs: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    peakInflight: 0,
    currentInflight: 0,
  };
}

export default AsyncResourceTelemetry;
