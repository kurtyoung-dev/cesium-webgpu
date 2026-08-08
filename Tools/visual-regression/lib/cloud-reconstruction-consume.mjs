/**
 * C13-10 Edge acceptance — the browser-free half of
 * `probe-cloud-reconstruction-consume.mjs`.
 *
 * WHY THESE PIECES LIVE OUTSIDE THE PROBE. Three of the probe's rules are the
 * kind this repo has already been burned by, and a rule that only exists inside
 * a `page.evaluate` closure cannot be tested against its own mutant:
 *
 *   1. THE INTERLEAVE. C13-39's protocol is MANDATORY for every GPU-timing A/B
 *      in this repo: a blocked "measure all of A, then all of B" run reads
 *      session drift (thermal state, driver residency, background load) as
 *      signal. The 2026-07-24 non-interleaved attempt produced bidirectional
 *      deltas on shaders the change never touched. {@link
 *      buildInterleavedSchedule} is therefore a function with a testable
 *      property, and {@link describeInterleave} is the check the probe runs on
 *      its OWN schedule before it reports a single number.
 *
 *   2. THE ZEROED-TIMING GUARD (C11-146). A timing block full of zeros is
 *      indistinguishable from a genuinely idle lane, and the fleet has already
 *      been misled by exactly that shape. {@link readPassTiming} returns NULL —
 *      never a zero — for a profiler that is absent, disabled, sampled nothing,
 *      or has no record of the named pass. A null propagates to STRUCTURAL; a
 *      zero would have propagated to "the pass is free".
 *
 *   3. THE FOLD. FAIL outranks STRUCTURAL, and a predicate that never ran is
 *      `null` (structural), not `false` (red) and not `true` (green).
 *
 * Pure functions only: no Playwright, no fs, no engine import. The spec runs
 * them directly.
 */

/** Attachments-only (C13-09 state): the producer ESTIMATES the depth slot. */
export const ARM_A = "attachments-only";
/** Consume-on (C13-10 state): the MARCH emits slot 1 and the resolve reads it. */
export const ARM_B = "consume-on";

/** The two passes the C13-10 row requires reported SEPARATELY. */
export const PASS_MARCH = "ProceduralClouds half-res pass";
export const PASS_PRODUCER = "CloudReconstructionAttachments pass";
/** Also read: the resolve changes with the flag; the upscale must NOT. */
export const PASS_RESOLVE = "CloudTemporalResolve pass";
export const PASS_UPSCALE = "CloudUpscale composite pass";

/** Every pass the perf lane records, in encode order. */
export const PERF_PASS_NAMES = Object.freeze([
  PASS_MARCH,
  PASS_PRODUCER,
  PASS_RESOLVE,
  PASS_UPSCALE,
]);

/** Upper bound on interleave iterations — every loop in the fleet is bounded. */
export const MAX_PERF_ITERATIONS = 24;

/**
 * The interleaved A/B window schedule (C13-39 protocol).
 *
 * One ITERATION is one A window and one B window, and the ORDER inside the
 * iteration alternates, so a run of two or more iterations contains both the
 * A-first and the B-first ordering. That is the "run at least one round in the
 * reverse order" clause executed rather than remembered: a real effect
 * reproduces in both orderings, drift does not.
 *
 * @param {number} iterations Requested iteration count (clamped to 1..24).
 * @returns {{iteration: number, arm: string, order: string}[]} Flat window list.
 */
export function buildInterleavedSchedule(iterations) {
  const count = Math.max(
    1,
    Math.min(MAX_PERF_ITERATIONS, Math.floor(Number(iterations) || 0)),
  );
  const windows = [];
  for (let i = 0; i < count; i++) {
    const order = i % 2 === 0 ? [ARM_A, ARM_B] : [ARM_B, ARM_A];
    for (const arm of order) {
      windows.push({
        iteration: i,
        arm,
        order: order[0] === ARM_A ? "AB" : "BA",
      });
    }
  }
  return windows;
}

/**
 * Does this window list actually interleave? The probe asks this of its own
 * schedule, and the spec asks it of a BLOCKED mutant, which must fail.
 *
 * @param {{iteration: number, arm: string}[]} windows Window list.
 * @returns {{ok: boolean, reasons: string[], iterations: number,
 *   maxRun: number, ordersSeen: string[]}} Verdict plus the evidence.
 */
export function describeInterleave(windows) {
  const reasons = [];
  const list = Array.isArray(windows) ? windows : [];
  const byIteration = new Map();
  for (const w of list) {
    const bucket = byIteration.get(w.iteration) ?? [];
    bucket.push(w.arm);
    byIteration.set(w.iteration, bucket);
  }
  const iterations = byIteration.size;
  if (list.length === 0) {
    reasons.push("empty schedule");
  }
  for (const [iteration, arms] of byIteration) {
    const a = arms.filter((arm) => arm === ARM_A).length;
    const b = arms.filter((arm) => arm === ARM_B).length;
    if (a !== 1 || b !== 1) {
      reasons.push(
        `iteration ${iteration} is not one A and one B (A=${a}, B=${b})`,
      );
    }
  }
  // The longest run of consecutive identical arms. Strict alternation gives 1;
  // alternating the ORDER inside each iteration gives at most 2 (the boundary
  // pair); a blocked A...A B...B run gives the whole arm length.
  let maxRun = 0;
  let run = 0;
  let previous = null;
  for (const w of list) {
    run = w.arm === previous ? run + 1 : 1;
    previous = w.arm;
    maxRun = Math.max(maxRun, run);
  }
  if (maxRun > 2) {
    reasons.push(
      `${maxRun} consecutive windows on the same arm — that is a BLOCKED schedule, not an interleave`,
    );
  }
  const ordersSeen = [...new Set(list.map((w) => w.order).filter(Boolean))];
  if (iterations >= 2 && ordersSeen.length < 2) {
    reasons.push(
      "every iteration ran the arms in the same order — no reverse-order round",
    );
  }
  return { ok: reasons.length === 0, reasons, iterations, maxRun, ordersSeen };
}

/**
 * One pass's timing from a `WebGPUTimestampProfiler` result, or NULL.
 *
 * ★ NULL IS NOT ZERO. C11-146: a zeroed timing block reads exactly like a lane
 * that ran and cost nothing, and a probe that reports 0 ms for "the profiler
 * was never armed" has manufactured a measurement. Every path that cannot
 * observe the pass returns null, and the probe routes null to STRUCTURAL.
 *
 * @param {object|null} results `profiler.getResults()`.
 * @param {string} passName Render-pass descriptor label.
 * @returns {{avgMs: number, minMs: number, maxMs: number, lastMs: number,
 *   frameCount: number}|null} The timing, or null when nothing was measured.
 */
export function readPassTiming(results, passName) {
  if (!results || results.enabled !== true) {
    return null;
  }
  if (!Number.isFinite(results.frameCount) || results.frameCount <= 0) {
    return null;
  }
  const timing = results.passes?.[passName];
  if (!timing) {
    return null;
  }
  const fields = [timing.avgMs, timing.minMs, timing.maxMs, timing.lastMs];
  if (!fields.every((v) => Number.isFinite(v))) {
    return null;
  }
  // An all-zero window is the absence of a sample, not a free pass: GPU
  // timestamps resolve in nanoseconds, so a pass that actually executed is
  // strictly positive somewhere in the window.
  if (!(timing.maxMs > 0)) {
    return null;
  }
  return {
    avgMs: timing.avgMs,
    minMs: timing.minMs,
    maxMs: timing.maxMs,
    lastMs: timing.lastMs,
    frameCount: results.frameCount,
  };
}

/** Nearest-rank quantile of an ASCENDING array. */
function quantile(sorted, fraction) {
  if (sorted.length === 0) {
    return null;
  }
  if (fraction === 0.5) {
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[rank];
}

/**
 * Median + spread of a sample list, or NULL when there is nothing to summarize.
 * Non-finite entries are DROPPED and counted, never coerced to zero.
 *
 * @param {(number|null)[]} values Per-window samples.
 * @returns {{n: number, dropped: number, median: number, p25: number,
 *   p75: number, min: number, max: number, spread: number}|null} Summary.
 */
export function summarize(values) {
  const list = Array.isArray(values) ? values : [];
  const finite = list.filter((v) => Number.isFinite(v));
  if (finite.length === 0) {
    return null;
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  return {
    n: sorted.length,
    dropped: list.length - sorted.length,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    min,
    max,
    spread: max - min,
  };
}

/**
 * PAIRED per-iteration deltas (B − A). Under session drift the paired form is
 * the honest one: both members of a pair were measured seconds apart, so the
 * drift common to them cancels, which an unpaired difference of medians does
 * not do.
 *
 * A pair with either member missing is DROPPED and counted.
 *
 * @param {{iteration: number, a: (number|null), b: (number|null)}[]} pairs
 * @returns {{summary: object|null, deltas: {iteration: number,
 *   delta: number}[], droppedPairs: number}} Paired result.
 */
export function pairedDeltas(pairs) {
  const list = Array.isArray(pairs) ? pairs : [];
  const deltas = [];
  let droppedPairs = 0;
  for (const pair of list) {
    if (Number.isFinite(pair?.a) && Number.isFinite(pair?.b)) {
      deltas.push({ iteration: pair.iteration, delta: pair.b - pair.a });
    } else {
      droppedPairs++;
    }
  }
  return {
    summary: summarize(deltas.map((d) => d.delta)),
    deltas,
    droppedPairs,
  };
}

/**
 * The process-level fold. FAIL outranks STRUCTURAL (per-lane scoping
 * doctrine), and a predicate held at `null` — "this arm did not run" — is
 * STRUCTURAL rather than green.
 *
 * @param {{predicates: Record<string, (boolean|null)>,
 *   structuralReasons: string[]}} input Verdict inputs.
 * @returns {{exitCode: number, failed: string[], notRun: string[],
 *   structural: boolean}} Fold.
 */
export function foldExit({ predicates, structuralReasons }) {
  const entries = Object.entries(predicates ?? {});
  const failed = entries.filter(([, v]) => v === false).map(([k]) => k);
  const notRun = entries.filter(([, v]) => v === null).map(([k]) => k);
  const reasons = Array.isArray(structuralReasons) ? structuralReasons : [];
  const structural = reasons.length > 0 || notRun.length > 0;
  return {
    exitCode: failed.length > 0 ? 1 : structural ? 3 : 0,
    failed,
    notRun,
    structural,
  };
}
