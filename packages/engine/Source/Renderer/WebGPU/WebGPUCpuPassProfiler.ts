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
 * // Renderer-local frame (for example, a standalone pick):
 * profiler.beginFrame();
 * profiler.time("globe", () => host._executeGlobePass(...));
 * profiler.endFrame();
 *
 * // Normal Scene frame: Scene owns the token and full-call duration.
 * profiler.beginFrame(frameNumber);
 * profiler.time("translucent", () => host._executeTranslucentPass(...));
 * profiler.recordSceneFrameCpu(frameNumber, sceneRenderMs);
 * const stats = profiler.getStats(); // rolling-window per-pass ms
 * ```
 *
 * Pass timings accumulate across all frustums in a single frame
 * (`time(name, fn)` adds to the per-frame bucket). `endFrame()` rolls
 * the per-frame totals into the rolling window and resets the buckets.
 *
 * Clock-, allocation-, and ledger-mutation-free when disabled — `time()`
 * short-circuits without touching `performance.now()`. Marker sites still pay
 * one cheap call/branch. Hot render-pass call sites use the
 * closure-free {@link WebGPUCpuPassProfiler.beginPass} /
 * {@link WebGPUCpuPassProfiler.endPass} pair instead, so a disabled
 * profiler costs a single boolean test per pass with **no** `() => …`
 * wrapper allocated every frame.
 *
 * @module WebGPUCpuPassProfiler
 */

const ROLLING_WINDOW = 60;

/**
 * Stable coarse phases for whole-Scene CPU attribution. These are deliberately
 * separate from renderer pass names: a named pass suspends the active coarse
 * phase and resumes it at the same clock sample, so the ledgers never overlap.
 */
export const CPU_SCENE_PHASE_NAMES = Object.freeze([
  "sceneUpdate",
  "frameState",
  "contextBegin",
  "sceneEnvironmentUpdate",
  "visibilityCommandPrep",
  "primitiveTraversal",
  "computeShadows",
  "rendererOverhead",
  "frameFinalize",
  "contextEndSubmit",
  "afterRenderCreditTrace",
] as const);

export type CpuScenePhaseName = (typeof CPU_SCENE_PHASE_NAMES)[number];
export type CpuScenePhaseMs = Readonly<Record<CpuScenePhaseName, number>>;

function isCpuScenePhaseName(value: unknown): value is CpuScenePhaseName {
  return (CPU_SCENE_PHASE_NAMES as readonly unknown[]).includes(value);
}

function createEmptyPhaseMs(): Record<CpuScenePhaseName, number> {
  return {
    sceneUpdate: 0,
    frameState: 0,
    contextBegin: 0,
    sceneEnvironmentUpdate: 0,
    visibilityCommandPrep: 0,
    primitiveTraversal: 0,
    computeShadows: 0,
    rendererOverhead: 0,
    frameFinalize: 0,
    contextEndSubmit: 0,
    afterRenderCreditTrace: 0,
  };
}

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
  readonly frameAccounting: CpuFrameAccountingStat | null;
  readonly lastFrame: CpuFrameAccountingSample | null;
}

/** Whole-frame CPU accounting derived from matching Scene and pass samples. */
export interface CpuFrameAccountingStat {
  /** Total normal Scene frames recorded since the profiler was reset. */
  readonly totalFrames: number;
  /** Number of normal Scene frames retained in the rolling window. */
  readonly samples: number;
  readonly validSamples: number;
  readonly invalidSamples: number;
  readonly lastSceneRenderMs: number;
  readonly lastProfiledPassMs: number;
  readonly lastUnaccountedMs: number;
  readonly lastOverlapMs: number;
  readonly lastPhaseTotalMs: number;
  readonly lastUnattributedMs: number;
  readonly lastAttributionOverlapMs: number;
  readonly lastAttributionValid: boolean;
  readonly lastCoverageRatio: number;
  readonly lastValid: boolean;
  readonly avgSceneRenderMs: number;
  readonly avgProfiledPassMs: number;
  readonly avgUnaccountedMs: number;
  readonly avgOverlapMs: number;
  readonly avgPhaseTotalMs: number;
  readonly avgUnattributedMs: number;
  readonly avgAttributionOverlapMs: number;
  readonly avgCoverageRatio: number;
}

export interface CpuFrameAccountingSample {
  readonly sequence: number;
  readonly sceneFrameNumber: number;
  readonly kind: "scene";
  readonly totalMs: number;
  readonly profiledPassMs: number;
  readonly unaccountedMs: number;
  readonly overlapMs: number;
  /** Profiled time divided by total time; overlap can make this exceed one. */
  readonly coverageRatio: number;
  readonly valid: boolean;
  readonly passMs: { readonly [name: string]: number };
  /** Whether this sample opted into the Scene-owned coarse phase cursor. */
  readonly phaseAttributionEnabled: boolean;
  /** Fixed-key, mutually exclusive coarse phase ledger. */
  readonly phaseMs: CpuScenePhaseMs;
  readonly phaseTotalMs: number;
  /** Time covered by neither a named pass nor a coarse phase. */
  readonly unattributedMs: number;
  /** Explicit excess when pass + phase attribution exceeds total time. */
  readonly attributionOverlapMs: number;
  /** Structural and numerical validity of the opt-in attribution ledger. */
  readonly attributionValid: boolean;
}

interface CpuFrameAccountingWindow {
  samples: CpuFrameAccountingSample[];
  head: number;
  filled: boolean;
}

export class WebGPUCpuPassProfiler {
  private _enabled: boolean;
  private _frameCount = 0;
  private _frameBuckets = new Map<string, number>();
  private _windows = new Map<string, PassWindow>();
  private _passStart = new Map<string, number>();
  private _activePassName: string | undefined;
  private _activeSceneFrameNumber: number | undefined;
  private _sceneFrameInvalid = false;
  private _phaseAttributionEnabled = false;
  private _sceneFrameStart: number | undefined;
  private _phaseBuckets: Map<CpuScenePhaseName, number> | undefined;
  private _activePhaseName: CpuScenePhaseName | undefined;
  private _activePhaseStart: number | undefined;
  private _suspendedPhaseName: CpuScenePhaseName | undefined;
  private _isolatedFrameBuckets = new Map<string, number>();
  private _isolatedPassStart = new Map<string, number>();
  private _isolatedFrameActive = false;
  private _frameAccountingWindow: CpuFrameAccountingWindow | undefined;
  private _lastFrame: CpuFrameAccountingSample | null = null;
  private _frameSequence = 0;

  constructor(enabled = false) {
    this._enabled = enabled;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    if (!enabled) {
      this._clearSceneFrameState();
      this._isolatedFrameActive = false;
      this._isolatedFrameBuckets.clear();
      this._isolatedPassStart.clear();
    }
  }

  beginFrame(sceneFrameNumber?: number): void {
    if (!this._enabled) return;
    if (sceneFrameNumber === undefined) {
      // Pick and other renderer-local frames use an isolated ledger. They may
      // run from an afterRender callback while a normal Scene frame is still
      // open, so they must never clear or publish that outer frame's buckets.
      if (
        this._activeSceneFrameNumber !== undefined &&
        (this._activePassName !== undefined || this._passStart.size !== 0)
      ) {
        this._sceneFrameInvalid = true;
      }
      this._isolatedFrameActive = true;
      this._isolatedFrameBuckets.clear();
      this._isolatedPassStart.clear();
    } else {
      // Recover if an exceptional isolated pass did not reach endFrame. A
      // stale pick must never redirect normal Scene passes into its ledger.
      this._clearSceneFrameState();
      this._isolatedFrameActive = false;
      this._isolatedFrameBuckets.clear();
      this._isolatedPassStart.clear();
      this._activeSceneFrameNumber = sceneFrameNumber;
    }
  }

  /**
   * Open an attributed normal Scene frame and return the exact outer start
   * timestamp. Ledger setup completes before the clock is sampled, so the
   * caller can reuse this value for its whole-frame duration without charging
   * profiler initialization to the Scene.
   */
  beginSceneFrame(
    sceneFrameNumber: number,
    initialPhase: CpuScenePhaseName,
  ): number | undefined {
    if (!this._enabled) return undefined;
    this.beginFrame(sceneFrameNumber);
    if (!isCpuScenePhaseName(initialPhase)) {
      this._sceneFrameInvalid = true;
      return undefined;
    }
    this._phaseAttributionEnabled = true;
    let phaseBuckets = this._phaseBuckets;
    if (phaseBuckets === undefined) {
      phaseBuckets = new Map<CpuScenePhaseName, number>();
      this._phaseBuckets = phaseBuckets;
    } else {
      phaseBuckets.clear();
    }
    const start = performance.now();
    this._sceneFrameStart = start;
    this._activePhaseName = initialPhase;
    this._activePhaseStart = start;
    if (!Number.isFinite(start)) {
      this._sceneFrameInvalid = true;
    }
    return start;
  }

  /** Advance the exclusive coarse Scene cursor for the exact active token. */
  markScenePhase(sceneFrameNumber: number, phase: CpuScenePhaseName): boolean {
    if (
      !this._enabled ||
      !this._phaseAttributionEnabled ||
      this._isolatedFrameActive ||
      this._activeSceneFrameNumber !== sceneFrameNumber
    ) {
      return false;
    }
    if (!isCpuScenePhaseName(phase)) {
      this._sceneFrameInvalid = true;
      return false;
    }
    if (this._activePassName !== undefined || this._passStart.size !== 0) {
      this._sceneFrameInvalid = true;
      return false;
    }
    const now = performance.now();
    if (!this._closeActivePhase(now)) {
      this._sceneFrameInvalid = true;
    }
    this._activePhaseName = phase;
    this._activePhaseStart = now;
    return !this._sceneFrameInvalid;
  }

  /**
   * Time `fn` and accumulate the elapsed ms into the named per-frame
   * bucket. Multiple calls with the same name within one frame add up
   * (so per-frustum sub-passes accumulate into a single per-frame
   * total).
   */
  time<T>(name: string, fn: () => T): T {
    if (!this._enabled) return fn();
    const isolated = this._isolatedFrameActive;
    if (!isolated && this._activePassName !== undefined) {
      this._sceneFrameInvalid = true;
      return fn();
    }
    this.beginPass(name);
    const started = isolated
      ? this._isolatedPassStart.has(name)
      : this._activePassName === name;
    try {
      return fn();
    } finally {
      if (started) {
        this.endPass(name);
      }
    }
  }

  /**
   * Closure-free equivalent of {@link time}, for hot render-pass call
   * sites that must not allocate a `() => …` wrapper every frame while
   * profiling is disabled. Pair with {@link endPass}:
   *
   * ```ts
   * profiler.beginPass("globe");
   * try {
   *   host._executeGlobePass(...);
   * } finally {
   *   profiler.endPass("globe");
   * }
   * ```
   *
   * Both calls early-return with a single boolean test when disabled —
   * no Map touch, no `performance.now()`, no allocation. When enabled,
   * `endPass` accumulates elapsed ms into the named per-frame bucket
   * with `+=` semantics identical to {@link time}, so multiple
   * begin/end pairs with the same name in one frame (per-frustum
   * sub-passes) add into a single per-frame total.
   */
  beginPass(name: string): void {
    if (!this._enabled) return;
    if (this._isolatedFrameActive) {
      this._isolatedPassStart.set(name, performance.now());
      return;
    }
    if (this._activePassName !== undefined || this._passStart.size !== 0) {
      this._sceneFrameInvalid = true;
      return;
    }
    const now = performance.now();
    if (this._phaseAttributionEnabled) {
      if (!this._closeActivePhase(now)) {
        this._sceneFrameInvalid = true;
      }
      this._suspendedPhaseName = this._activePhaseName;
      this._activePhaseName = undefined;
      this._activePhaseStart = undefined;
    }
    this._activePassName = name;
    this._passStart.set(name, now);
  }

  /**
   * Close a pass opened by {@link beginPass}. Early-returns when
   * disabled or when there is no matching open `beginPass` (defensive:
   * an unmatched `endPass` never fabricates a sample). Accumulates the
   * elapsed ms into the per-frame bucket and clears the start marker.
   */
  endPass(name: string): void {
    if (!this._enabled) return;
    const isolated = this._isolatedFrameActive;
    if (isolated) {
      const t0 = this._isolatedPassStart.get(name);
      if (t0 === undefined) return;
      const now = performance.now();
      const dt = now - t0;
      this._isolatedFrameBuckets.set(
        name,
        (this._isolatedFrameBuckets.get(name) ?? 0) + dt,
      );
      this._isolatedPassStart.delete(name);
      return;
    }
    const t0 = this._passStart.get(name);
    if (t0 === undefined || this._activePassName !== name) {
      if (this._activeSceneFrameNumber !== undefined) {
        this._sceneFrameInvalid = true;
      }
      return;
    }
    const now = performance.now();
    const dt = now - t0;
    this._frameBuckets.set(name, (this._frameBuckets.get(name) ?? 0) + dt);
    this._passStart.delete(name);
    this._activePassName = undefined;
    if (this._phaseAttributionEnabled) {
      this._activePhaseName = this._suspendedPhaseName;
      this._activePhaseStart = now;
      this._suspendedPhaseName = undefined;
    }
  }

  endFrame(): void {
    if (!this._enabled) return;
    if (!this._isolatedFrameActive) return;
    this._isolatedFrameActive = false;
    this._isolatedPassStart.clear();
    this._commitPassBuckets(this._isolatedFrameBuckets);
    this._isolatedFrameBuckets.clear();
  }

  /**
   * Pair a complete Scene.render CPU duration with the pass buckets collected
   * for that exact logical frame. Returns false when no matching normal-frame
   * token exists, so a pick or interrupted frame cannot be consumed later.
   */
  recordSceneFrameCpu(
    sceneFrameNumber: number,
    sceneRenderMs: number,
    sceneFrameEnd?: number,
  ): boolean {
    if (!this._enabled) return false;
    if (this._activeSceneFrameNumber !== sceneFrameNumber) {
      this._clearSceneFrameState();
      return false;
    }
    if (
      this._sceneFrameInvalid ||
      this._activePassName !== undefined ||
      this._passStart.size !== 0 ||
      this._isolatedFrameActive
    ) {
      this._clearSceneFrameState();
      return false;
    }

    if (this._phaseAttributionEnabled) {
      if (
        sceneFrameEnd === undefined ||
        !Number.isFinite(sceneFrameEnd) ||
        this._sceneFrameStart === undefined ||
        !Number.isFinite(this._sceneFrameStart) ||
        sceneFrameEnd < this._sceneFrameStart ||
        !this._closeActivePhase(sceneFrameEnd)
      ) {
        this._clearSceneFrameState();
        return false;
      }
      const exactDuration = sceneFrameEnd - this._sceneFrameStart;
      const exactTolerance =
        Number.EPSILON * 32 * Math.max(1, exactDuration, sceneRenderMs);
      if (Math.abs(sceneRenderMs - exactDuration) > exactTolerance) {
        this._clearSceneFrameState();
        return false;
      }
    }

    let profiledPassMs = 0;
    let passBucketsValid = true;
    const passMs: { [name: string]: number } = {};
    for (const [name, ms] of this._frameBuckets) {
      if (!Number.isFinite(ms) || ms < 0) {
        passBucketsValid = false;
      }
      profiledPassMs += ms;
      passMs[name] = ms;
    }

    if (
      !Number.isFinite(sceneRenderMs) ||
      sceneRenderMs < 0 ||
      !passBucketsValid ||
      !Number.isFinite(profiledPassMs) ||
      profiledPassMs < 0
    ) {
      this._clearSceneFrameState();
      return false;
    }

    const phaseMs = createEmptyPhaseMs();
    let phaseTotalMs = 0;
    let phaseBucketsValid = true;
    if (this._phaseAttributionEnabled) {
      for (const [name, ms] of this._phaseBuckets ?? []) {
        if (!Number.isFinite(ms) || ms < 0) {
          phaseBucketsValid = false;
        }
        phaseMs[name] = ms;
        phaseTotalMs += ms;
      }
    }
    if (
      !phaseBucketsValid ||
      !Number.isFinite(phaseTotalMs) ||
      phaseTotalMs < 0
    ) {
      this._clearSceneFrameState();
      return false;
    }

    const rawRemainderMs = sceneRenderMs - profiledPassMs;
    const unaccountedMs = Math.max(0, rawRemainderMs);
    const overlapMs = Math.max(0, -rawRemainderMs);
    const rawAttributionRemainderMs = rawRemainderMs - phaseTotalMs;
    const unattributedMs = Math.max(0, rawAttributionRemainderMs);
    const attributionOverlapMs = Math.max(0, -rawAttributionRemainderMs);
    const coverageRatio =
      sceneRenderMs > 0
        ? profiledPassMs / sceneRenderMs
        : profiledPassMs === 0
          ? 1
          : 0;
    const toleranceMs =
      Number.EPSILON *
      32 *
      Math.max(1, sceneRenderMs, profiledPassMs, phaseTotalMs);
    const attributionValid = this._phaseAttributionEnabled
      ? unattributedMs <= toleranceMs && attributionOverlapMs <= toleranceMs
      : overlapMs <= toleranceMs;
    const valid = overlapMs <= toleranceMs && attributionValid;

    const sample: CpuFrameAccountingSample = Object.freeze({
      sequence: ++this._frameSequence,
      sceneFrameNumber,
      kind: "scene",
      totalMs: sceneRenderMs,
      profiledPassMs,
      unaccountedMs,
      overlapMs,
      coverageRatio,
      valid,
      passMs: Object.freeze(passMs),
      phaseAttributionEnabled: this._phaseAttributionEnabled,
      phaseMs: Object.freeze(phaseMs),
      phaseTotalMs,
      unattributedMs,
      attributionOverlapMs,
      attributionValid,
    });
    this._commitPassBuckets(this._frameBuckets);
    this._recordFrameAccounting(sample);
    this._lastFrame = sample;
    this._clearSceneFrameState();
    return true;
  }

  /** Discard an interrupted logical Scene frame without publishing it. */
  cancelSceneFrame(sceneFrameNumber: number): boolean {
    if (!this._enabled) return false;
    if (this._activeSceneFrameNumber !== sceneFrameNumber) return false;
    this._clearSceneFrameState();
    return true;
  }

  private _closeActivePhase(end: number): boolean {
    if (!this._phaseAttributionEnabled) return true;
    const name = this._activePhaseName;
    const start = this._activePhaseStart;
    const buckets = this._phaseBuckets;
    if (
      name === undefined ||
      start === undefined ||
      buckets === undefined ||
      !Number.isFinite(end) ||
      !Number.isFinite(start) ||
      end < start
    ) {
      return false;
    }
    const elapsed = end - start;
    buckets.set(name, (buckets.get(name) ?? 0) + elapsed);
    return true;
  }

  private _clearSceneFrameState(): void {
    this._activeSceneFrameNumber = undefined;
    this._sceneFrameInvalid = false;
    this._phaseAttributionEnabled = false;
    this._sceneFrameStart = undefined;
    this._phaseBuckets?.clear();
    this._activePhaseName = undefined;
    this._activePhaseStart = undefined;
    this._suspendedPhaseName = undefined;
    this._activePassName = undefined;
    this._frameBuckets.clear();
    this._passStart.clear();
  }

  private _commitPassBuckets(buckets: Map<string, number>): void {
    this._frameCount++;
    for (const [name, ms] of buckets) {
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

  private _recordFrameAccounting(sample: CpuFrameAccountingSample): void {
    let window = this._frameAccountingWindow;
    if (!window) {
      window = {
        samples: new Array<CpuFrameAccountingSample>(ROLLING_WINDOW),
        head: 0,
        filled: false,
      };
      this._frameAccountingWindow = window;
    }
    window.samples[window.head] = sample;
    window.head = (window.head + 1) % ROLLING_WINDOW;
    if (window.head === 0) window.filled = true;
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
      frameAccounting: this._getFrameAccountingStats(),
      lastFrame: this._lastFrame,
    };
  }

  private _getFrameAccountingStats(): CpuFrameAccountingStat | null {
    const window = this._frameAccountingWindow;
    if (!window) return null;
    const count = window.filled ? ROLLING_WINDOW : window.head;
    if (count === 0) return null;

    let passSum = 0;
    let unaccountedSum = 0;
    let overlapSum = 0;
    let phaseTotalSum = 0;
    let unattributedSum = 0;
    let attributionOverlapSum = 0;
    let coverageSum = 0;
    let validSamples = 0;
    for (let i = 0; i < count; i++) {
      const sample = window.samples[i];
      passSum += sample.profiledPassMs;
      unaccountedSum += sample.unaccountedMs;
      overlapSum += sample.overlapMs;
      phaseTotalSum += sample.phaseTotalMs;
      unattributedSum += sample.unattributedMs;
      attributionOverlapSum += sample.attributionOverlapMs;
      coverageSum += sample.coverageRatio;
      if (sample.valid) validSamples++;
    }

    const lastIndex = (window.head - 1 + ROLLING_WINDOW) % ROLLING_WINDOW;
    const last = window.samples[lastIndex];
    const avgProfiledPassMs = passSum / count;
    const avgUnaccountedMs = unaccountedSum / count;
    const avgOverlapMs = overlapSum / count;
    const avgPhaseTotalMs = phaseTotalSum / count;
    const avgUnattributedMs = unattributedSum / count;
    const avgAttributionOverlapMs = attributionOverlapSum / count;
    return {
      totalFrames: this._frameSequence,
      samples: count,
      validSamples,
      invalidSamples: count - validSamples,
      lastSceneRenderMs: last.totalMs,
      lastProfiledPassMs: last.profiledPassMs,
      lastUnaccountedMs: last.unaccountedMs,
      lastOverlapMs: last.overlapMs,
      lastPhaseTotalMs: last.phaseTotalMs,
      lastUnattributedMs: last.unattributedMs,
      lastAttributionOverlapMs: last.attributionOverlapMs,
      lastAttributionValid: last.attributionValid,
      lastCoverageRatio: last.coverageRatio,
      lastValid: last.valid,
      // Derive the published average total from the same conservation
      // identity as the component averages.
      avgSceneRenderMs: avgProfiledPassMs + avgUnaccountedMs - avgOverlapMs,
      avgProfiledPassMs,
      avgUnaccountedMs,
      avgOverlapMs,
      avgPhaseTotalMs,
      avgUnattributedMs,
      avgAttributionOverlapMs,
      avgCoverageRatio: coverageSum / count,
    };
  }

  reset(): void {
    this._frameCount = 0;
    this._frameBuckets.clear();
    this._windows.clear();
    this._passStart.clear();
    this._clearSceneFrameState();
    this._isolatedFrameActive = false;
    this._isolatedFrameBuckets.clear();
    this._isolatedPassStart.clear();
    this._frameAccountingWindow = undefined;
    this._lastFrame = null;
    this._frameSequence = 0;
  }
}
