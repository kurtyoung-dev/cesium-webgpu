/**
 * PF-2, per-pass GPU cost as `CesiumDebug.gpuPassCost()` reports it, and its
 * base-against-tip reading under a pre-registered band.
 * @purpose PF-2 for the R-2026-10-22-3 performance leg: reduces one CesiumDebug.gpuPassCost() result to per-pass average milliseconds, the frame total and the cloud-pass total (passes whose name matches /cloud/i), with the profiler's own accounting (sample ledger, coverage) kept beside it, and reads base vs tip per pass, for the total and for the cloud total.
 * @status ACTIVE
 *
 * WHAT THE PROFILER RETURNS. `CesiumDebug.gpuPassCost()` (engine
 * `Scene/CesiumDebug.js`) returns the timestamp profiler's results: `enabled`,
 * `passes` keyed by pass name with `avgMs`/`lastMs`/`minMs`/`maxMs`,
 * `frameAvgMs`, `frameCount`, and the accounting fields
 * `sampleLedgerBalanced` and `coverageRatio`. It returns nothing when the
 * backend is WebGL or the adapter has no `timestamp-query`; that reduces here
 * to `available: false` with the reason, never to a zero cost.
 *
 * WHAT IS BANDED. The frame total (`frameAvgMs`) and the cloud total are
 * banded; each pass present on both arms is banded too. A pass present on only
 * one arm is listed under `onlyBase` / `onlyTip` and not banded on its own: a
 * new pass's cost is already inside the tip's frame total. The verdict is the
 * worst of the frame total and the cloud total; per-pass verdicts are reported
 * for the reader.
 *
 * A RESULT WHOSE LEDGER DOES NOT CLOSE is still reduced, and its record says
 * `ledgerBalanced: false`: the profiler itself says those timings under-report,
 * and a reader must see that beside the numbers.
 *
 * @module Tools/visual-regression/lib/metrics/gpu-pass-cost
 */

import { compareToBase, guardStatistic, worstVerdict } from "./perf-band.mjs";

/** A pass whose name matches this is a cloud pass. */
export const CLOUD_PASS_RE = /cloud/i;

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Reduce one `gpuPassCost()` result.
 *
 * @param {unknown} results What `CesiumDebug.gpuPassCost()` returned (or what
 *   the sampler recorded when it could not call it: `{available: false,
 *   reason}`).
 * @returns {{available: boolean, reason?: string, frameAvgMs: number|null,
 *   frameCount: number|null, passes: Record<string, number>,
 *   cloudPasses: Record<string, number>, cloudTotalMs: number|null,
 *   ledgerBalanced: boolean|null, coverageRatio: number|null}}
 */
export function summarizePassCost(results) {
  const empty = (reason) => ({
    available: false,
    reason,
    frameAvgMs: null,
    frameCount: null,
    passes: {},
    cloudPasses: {},
    cloudTotalMs: null,
    ledgerBalanced: null,
    coverageRatio: null,
  });
  if (results === null || typeof results !== "object") {
    return empty("the profiler returned no result");
  }
  if (results.available === false) {
    return empty(String(results.reason ?? "the profiler was not available"));
  }
  if (results.enabled !== true) {
    return empty("the profiler reports it is not enabled");
  }
  const passes = {};
  const cloudPasses = {};
  for (const [name, pass] of Object.entries(results.passes ?? {})) {
    if (!isFiniteNumber(pass?.avgMs)) {
      continue;
    }
    passes[name] = pass.avgMs;
    if (CLOUD_PASS_RE.test(name)) {
      cloudPasses[name] = pass.avgMs;
    }
  }
  const cloudNames = Object.keys(cloudPasses);
  return {
    available: true,
    frameAvgMs: isFiniteNumber(results.frameAvgMs) ? results.frameAvgMs : null,
    frameCount: isFiniteNumber(results.frameCount) ? results.frameCount : null,
    passes,
    cloudPasses,
    cloudTotalMs:
      cloudNames.length === 0
        ? null
        : cloudNames.reduce((sum, name) => sum + cloudPasses[name], 0),
    ledgerBalanced:
      typeof results.sampleLedgerBalanced === "boolean"
        ? results.sampleLedgerBalanced
        : null,
    coverageRatio: isFiniteNumber(results.coverageRatio)
      ? results.coverageRatio
      : null,
  };
}

/**
 * PF-2, base arm against tip arm.
 *
 * @param {object} input
 * @param {unknown[]} input.baseRuns One `gpuPassCost()` result per base repeat.
 * @param {unknown[]} input.tipRuns One per tip repeat.
 * @param {object} [input.bands] Pre-registered band overrides.
 * @param {object} [input.contention] A `contentionGuard` result for this arm
 *   pair (`lib/metrics/perf-band.mjs`); applied to every statistic.
 * @returns {{metric: "PF-2", verdict: string, total: object, cloudTotal: object,
 *   passes: Record<string, object>, onlyBase: string[], onlyTip: string[],
 *   unbalancedLedgers: {base: number, tip: number},
 *   runs: {base: object[], tip: object[]}}}
 */
export function passCostVerdict({ baseRuns, tipRuns, bands, contention }) {
  const base = (Array.isArray(baseRuns) ? baseRuns : []).map(summarizePassCost);
  const tip = (Array.isArray(tipRuns) ? tipRuns : []).map(summarizePassCost);
  const usable = (runs) => runs.filter((run) => run.available);
  const total = compareToBase({
    metric: "PF-2",
    statistic: "frameAvgMs",
    baseRepeats: usable(base).map((run) => run.frameAvgMs),
    tipRepeats: usable(tip).map((run) => run.frameAvgMs),
    bands,
  });
  const cloudTotal = compareToBase({
    metric: "PF-2",
    statistic: "cloudTotalMs",
    baseRepeats: usable(base).map((run) => run.cloudTotalMs),
    tipRepeats: usable(tip).map((run) => run.cloudTotalMs),
    bands,
  });
  const names = (runs) =>
    new Set(usable(runs).flatMap((run) => Object.keys(run.passes)));
  const baseNames = names(base);
  const tipNames = names(tip);
  const passes = {};
  for (const name of [...baseNames].filter((n) => tipNames.has(n)).sort()) {
    passes[name] = compareToBase({
      metric: "PF-2",
      statistic: name,
      baseRepeats: usable(base).map((run) => run.passes[name]),
      tipRepeats: usable(tip).map((run) => run.passes[name]),
      bands,
    });
  }
  // A scene with no cloud pass on either arm has nothing to band there; only
  // the frame total decides it.
  guardStatistic(total, contention);
  guardStatistic(cloudTotal, contention);
  for (const record of Object.values(passes)) {
    guardStatistic(record, contention);
  }
  const cloudless =
    cloudTotal.base === null &&
    cloudTotal.tip === null &&
    usable(base).length > 0 &&
    usable(tip).length > 0;
  return {
    metric: "PF-2",
    verdict: worstVerdict(cloudless ? [total] : [total, cloudTotal]),
    total,
    cloudTotal,
    cloudless,
    passes,
    onlyBase: [...baseNames].filter((n) => !tipNames.has(n)).sort(),
    onlyTip: [...tipNames].filter((n) => !baseNames.has(n)).sort(),
    unbalancedLedgers: {
      base: base.filter((run) => run.ledgerBalanced === false).length,
      tip: tip.filter((run) => run.ledgerBalanced === false).length,
    },
    runs: { base, tip },
  };
}
