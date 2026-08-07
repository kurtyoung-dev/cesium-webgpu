/**
 * Unique-sample accounting for GPU timestamp profiling — C11-140
 * (NEW-GPU-TIMESTAMP-UNIQUE-SAMPLE-ACCOUNTING).
 *
 * Two accounting invariants have to hold before any GPU-lane performance claim
 * is falsifiable, and both live here as pure functions so they can be proven
 * without a GPU:
 *
 * 1. **Every GPU nanosecond is counted once.** The frame span is either
 *    attributed to a named pass or explicitly left in the unprofiled
 *    remainder — never both, never neither. Summing per-pass durations does
 *    NOT satisfy this: two passes that overlap in GPU time contribute their
 *    intersection twice, so the sum can exceed the span it is a fraction of.
 *    Clamping that ratio to 1 (what the profiler used to do) hides the
 *    double-count instead of reporting it. The union of the pass intervals is
 *    the unique-sample measure; `summed − covered` is the overlap, and a
 *    non-zero overlap is a finding to surface, not a rounding detail.
 *
 * 2. **Every frame reaches exactly one terminal outcome.** A profiling attempt
 *    is sampled, skipped, empty, failed, lost, or still pending — and those
 *    six must add up to the attempts. A frame that silently falls out of the
 *    ledger is a lost sample, which is precisely what makes an under-reporting
 *    timer look like a fast one.
 *
 * Times arrive as nanoseconds relative to a per-frame origin (the first
 * timestamp of the frame), never as absolute device timestamps: the relative
 * values are small enough to be exact in a `number`, while absolute device
 * uptimes are not.
 */

/** One timed pass, in nanoseconds relative to the frame origin. */
export interface TimedPassSample {
  readonly name: string;
  readonly beginNs: number;
  readonly endNs: number;
}

/** Result of folding a frame's timed passes into unique-sample measures. */
export interface FrameCoverage {
  /** GPU span from the first timed pass begin to the last timed pass end. */
  readonly frameSpanMs: number;
  /** Union of the timed pass intervals — each GPU nanosecond counted once. */
  readonly coveredMs: number;
  /** Naive sum of pass durations; exceeds `coveredMs` when passes overlap. */
  readonly summedPassMs: number;
  /** `summedPassMs − coveredMs`. Non-zero means passes overlapped in GPU time. */
  readonly overlapMs: number;
  /** Frame span not attributed to any named pass. */
  readonly unprofiledMs: number;
  /** `coveredMs / frameSpanMs`, or null for a degenerate (zero-length) span. */
  readonly coverageRatio: number | null;
  /** `unprofiledMs / frameSpanMs`, or null for a degenerate span. */
  readonly unprofiledRatio: number | null;
  /** True when covered + unprofiled reconstructs the span within tolerance. */
  readonly balanced: boolean;
  /** Passes whose end timestamp preceded their begin (driver residue). */
  readonly invertedSampleCount: number;
  /** Passes that contributed to the fold. */
  readonly sampleCount: number;
}

/**
 * Timestamp subtraction on real adapters produces sub-nanosecond residue, and
 * the span/union fold performs several of them. A tolerance one microsecond
 * wide is far below any pass worth profiling yet far above the residue.
 */
const DEFAULT_BALANCE_TOLERANCE_MS = 1e-3;

const NS_PER_MS = 1_000_000;

/**
 * Merges timed pass intervals into disjoint spans. Pure, allocation-bounded by
 * the input length, and total: inverted or zero-length samples are dropped
 * rather than allowed to produce a negative covered span.
 *
 * @param samples Timed passes in nanoseconds relative to the frame origin.
 * @returns Disjoint, ascending `[beginNs, endNs]` spans.
 */
export function mergeTimedIntervals(
  samples: readonly TimedPassSample[],
): Array<[number, number]> {
  const ordered = samples
    .filter((sample) => sample.endNs > sample.beginNs)
    .map((sample): [number, number] => [sample.beginNs, sample.endNs])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged: Array<[number, number]> = [];
  for (const span of ordered) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) {
      if (span[1] > last[1]) {
        last[1] = span[1];
      }
      continue;
    }
    merged.push([span[0], span[1]]);
  }
  return merged;
}

/**
 * Folds one frame's timed passes into the unique-sample coverage measures.
 *
 * @param samples Timed passes in nanoseconds relative to the frame origin.
 * @param options.toleranceMs Balance tolerance for the covered + unprofiled
 *   reconstruction of the frame span.
 */
export function summarizeFrameCoverage(
  samples: readonly TimedPassSample[],
  options: { toleranceMs?: number } = {},
): FrameCoverage {
  const tolerance = options.toleranceMs ?? DEFAULT_BALANCE_TOLERANCE_MS;

  let invertedSampleCount = 0;
  let summedNs = 0;
  let minBeginNs = Number.POSITIVE_INFINITY;
  let maxEndNs = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    if (sample.endNs < sample.beginNs) {
      invertedSampleCount++;
      continue;
    }
    summedNs += sample.endNs - sample.beginNs;
    minBeginNs = Math.min(minBeginNs, sample.beginNs);
    maxEndNs = Math.max(maxEndNs, sample.endNs);
  }

  if (!Number.isFinite(minBeginNs) || !Number.isFinite(maxEndNs)) {
    return {
      frameSpanMs: 0,
      coveredMs: 0,
      summedPassMs: 0,
      overlapMs: 0,
      unprofiledMs: 0,
      coverageRatio: null,
      unprofiledRatio: null,
      balanced: true,
      invertedSampleCount,
      sampleCount: 0,
    };
  }

  let coveredNs = 0;
  for (const [beginNs, endNs] of mergeTimedIntervals(samples)) {
    coveredNs += endNs - beginNs;
  }

  const frameSpanMs = (maxEndNs - minBeginNs) / NS_PER_MS;
  const coveredMs = coveredNs / NS_PER_MS;
  const summedPassMs = summedNs / NS_PER_MS;
  // The union can never exceed the span it was measured inside, so the
  // remainder is non-negative by construction rather than by clamping.
  const unprofiledMs = frameSpanMs - coveredMs;
  const degenerate = frameSpanMs <= 0;

  return {
    frameSpanMs,
    coveredMs,
    summedPassMs,
    overlapMs: summedPassMs - coveredMs,
    unprofiledMs,
    coverageRatio: degenerate ? null : coveredMs / frameSpanMs,
    unprofiledRatio: degenerate ? null : unprofiledMs / frameSpanMs,
    balanced: Math.abs(coveredMs + unprofiledMs - frameSpanMs) <= tolerance,
    invertedSampleCount,
    sampleCount: samples.length - invertedSampleCount,
  };
}

/**
 * Terminal outcomes of the profiler's frame attempts. Exactly one applies to
 * each attempt, so they must sum to `attempted`.
 */
export interface SampleLedger {
  /** Frames the profiler tried to profile. */
  readonly attempted: number;
  /** Frames whose timestamps were read back and folded into the statistics. */
  readonly sampled: number;
  /** Frames never armed because a readback slot was still in use. */
  readonly skipped: number;
  /** Frames armed but that wrote no timestamps (no timed passes ran). */
  readonly empty: number;
  /** Frames whose readback rejected or could not be mapped. */
  readonly failed: number;
  /** Frames abandoned before their readback could be read. */
  readonly lost: number;
  /** Frames whose readback was still in flight when the report was taken. */
  readonly pending: number;
}

/** Whether a {@link SampleLedger} accounts for every attempt. */
export interface SampleLedgerBalance {
  readonly balanced: boolean;
  /** Attempts with a recorded terminal outcome. */
  readonly accounted: number;
  /** `attempted − accounted`. Positive means samples vanished silently. */
  readonly unaccounted: number;
}

/**
 * Checks the "no sample silently lost" invariant.
 *
 * @param ledger The profiler's frame-outcome counters.
 */
export function balanceSampleLedger(ledger: SampleLedger): SampleLedgerBalance {
  const accounted =
    ledger.sampled +
    ledger.skipped +
    ledger.empty +
    ledger.failed +
    ledger.lost +
    ledger.pending;
  return {
    balanced: accounted === ledger.attempted,
    accounted,
    unaccounted: ledger.attempted - accounted,
  };
}
