/// <reference types="@webgpu/types" />
/**
 * CPU-side per-pass recording cost profiler.
 *
 * Distinct from {@link WebGPUTimestampProfiler}, which measures GPU
 * execution time via timestamp queries. This profiler measures the
 * **CPU cost of recording** a pass — i.e., how long the JS-side walk
 * of the command list (set pipeline / set bind group / draw / etc.)
 * takes before the encoder is submitted.
 *
 * Used by R-7a (Future Research, 2026-05-01) to determine which passes
 * are bundle-expansion candidates. A pass under ~1 ms of recording cost
 * is not worth bundling; a pass over ~5 ms generally is.
 *
 * Usage:
 * ```ts
 * profiler.beginFrame();
 * profiler.time("globe", () => host._executeGlobePass(...));
 * profiler.time("translucent", () => host._executeTranslucentPass(...));
 * profiler.endFrame();
 * const stats = profiler.getStats(); // rolling-window per-pass ms
 * ```
 *
 * Pass timings accumulate across all frustums in a single frame
 * (`time(name, fn)` adds to the per-frame bucket). `endFrame()` rolls
 * the per-frame totals into the rolling window and resets the buckets.
 *
 * Zero overhead when disabled — `time()` short-circuits without
 * touching `performance.now()`.
 *
 * @module WebGPUCpuPassProfiler
 */

const ROLLING_WINDOW = 60;

interface PassWindow {
  samples: number[];
  head: number;
  filled: boolean;
}

export interface CpuPassStat {
  readonly name: string;
  readonly lastMs: number;
  readonly avgMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly samples: number;
}

export interface CpuPassProfile {
  readonly enabled: boolean;
  readonly frameCount: number;
  readonly passes: { readonly [name: string]: CpuPassStat };
}

export class WebGPUCpuPassProfiler {
  private _enabled: boolean;
  private _frameCount = 0;
  private _frameBuckets = new Map<string, number>();
  private _windows = new Map<string, PassWindow>();

  constructor(enabled = false) {
    this._enabled = enabled;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  beginFrame(): void {
    if (!this._enabled) return;
    this._frameBuckets.clear();
  }

  /**
   * Time `fn` and accumulate the elapsed ms into the named per-frame
   * bucket. Multiple calls with the same name within one frame add up
   * (so per-frustum sub-passes accumulate into a single per-frame
   * total).
   */
  time<T>(name: string, fn: () => T): T {
    if (!this._enabled) return fn();
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      const dt = performance.now() - t0;
      this._frameBuckets.set(name, (this._frameBuckets.get(name) ?? 0) + dt);
    }
  }

  endFrame(): void {
    if (!this._enabled) return;
    this._frameCount++;
    for (const [name, ms] of this._frameBuckets) {
      let win = this._windows.get(name);
      if (!win) {
        win = {
          samples: new Array<number>(ROLLING_WINDOW).fill(0),
          head: 0,
          filled: false,
        };
        this._windows.set(name, win);
      }
      win.samples[win.head] = ms;
      win.head = (win.head + 1) % ROLLING_WINDOW;
      if (win.head === 0) win.filled = true;
    }
  }

  getStats(): CpuPassProfile {
    const passes: { [name: string]: CpuPassStat } = {};
    for (const [name, win] of this._windows) {
      const count = win.filled ? ROLLING_WINDOW : win.head;
      if (count === 0) continue;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < count; i++) {
        const v = win.samples[i];
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const lastIndex = (win.head - 1 + ROLLING_WINDOW) % ROLLING_WINDOW;
      passes[name] = {
        name,
        lastMs: win.samples[lastIndex],
        avgMs: sum / count,
        minMs: min,
        maxMs: max,
        samples: count,
      };
    }
    return {
      enabled: this._enabled,
      frameCount: this._frameCount,
      passes,
    };
  }

  reset(): void {
    this._frameCount = 0;
    this._frameBuckets.clear();
    this._windows.clear();
  }
}
