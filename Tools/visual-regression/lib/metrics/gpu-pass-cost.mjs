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
 * TWO MODES. A statistic whose per-run values, base and tip together, fall
 * into two modes ({@link splitTwoModes}) carries `modes` and a reason that
 * names both and which arm drew which. When the base arm itself drew the slow
 * mode, or the band read `within`, the band cannot read the build and the
 * verdict is `unmeasured-bimodal`, the band's own reading kept as
 * `verdictIfUnimodal`. When the band read `over` and only the tip drew the
 * slow mode, that is what a regression looks like: `over` stands, with the
 * modes beside it. The contention guard runs after, so a contended arm still
 * reads `unmeasured-contended` with the modes kept on the record. A set the
 * split cannot read keeps the band verbatim.
 *
 * A RESULT WHOSE LEDGER DOES NOT CLOSE is still reduced, and its record says
 * `ledgerBalanced: false`: the profiler itself says those timings under-report,
 * and a reader must see that beside the numbers.
 *
 * @module Tools/visual-regression/lib/metrics/gpu-pass-cost
 */

import {
  PERF_VERDICTS,
  compareToBase,
  guardStatistic,
  worstVerdict,
} from "./perf-band.mjs";
import { describeModes, splitTwoModes } from "./two-mode-split.mjs";

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

const entriesOf = (arm, runs, pick) =>
  runs.flatMap((run, index) =>
    run.available && isFiniteNumber(pick(run))
      ? [{ arm, run: index + 1, value: pick(run) }]
      : [],
  );

/**
 * Band one statistic and, when its values fall into two modes, replace the
 * band's reading with `unmeasured-bimodal`. Only a statistic the band could
 * read (both arms produced it) is split.
 *
 * @param {{statistic: string, pick: Function, base: object[], tip: object[],
 *   bands?: object}} input `base` and `tip` are the summarized runs; `pick`
 *   reads the statistic from one.
 * @returns {object} The {@link compareToBase} record, with `modes`,
 *   `modesReason` and `verdictIfUnimodal` added when it is bimodal.
 */
function bandStatistic({ statistic, pick, base, tip, bands }) {
  const usable = (runs) => runs.filter((run) => run.available);
  const record = compareToBase({
    metric: "PF-2",
    statistic,
    baseRepeats: usable(base).map(pick),
    tipRepeats: usable(tip).map(pick),
    bands,
  });
  if (
    record.verdict !== PERF_VERDICTS.WITHIN &&
    record.verdict !== PERF_VERDICTS.OVER
  ) {
    return record;
  }
  const modes = splitTwoModes([
    ...entriesOf("base", base, pick),
    ...entriesOf("tip", tip, pick),
  ]);
  if (modes === null) {
    return record;
  }
  record.modes = modes;
  // A slow mode the base arm never drew is not shown to be the page's: it is
  // what a regression looks like, so the band's `over` stands and the modes
  // ride beside it. Only a base arm that drew the slow mode itself (or a band
  // that read `within`) shows the second mode belongs to the page.
  const baseDrewSlow = modes.high.values.some((entry) => entry.arm === "base");
  if (record.verdict === PERF_VERDICTS.OVER && !baseDrewSlow) {
    record.modesReason = `${describeModes(statistic, modes)}; the base arm never drew the slow mode, so the band's over stands`;
    record.reasons = [...record.reasons, record.modesReason];
    return record;
  }
  record.verdictIfUnimodal = record.verdict;
  record.verdict = PERF_VERDICTS.UNMEASURED_BIMODAL;
  record.modesReason = `${describeModes(statistic, modes)}; the band alone read ${record.verdictIfUnimodal}`;
  record.reasons = [...record.reasons, record.modesReason];
  return record;
}

/**
 * What a PF-2 record says about the modes of its deciding statistics, for the
 * verdict that is handed to the summary and the exit fold: on an
 * `unmeasured-bimodal` record the split that replaced the band, on an `over`
 * record the split that rode beside a band reading that stood.
 *
 * @param {object|null|undefined} pf2 A {@link passCostVerdict} result.
 * @returns {{statistic: string, modes: object, verdictIfUnimodal?: string,
 *   reason: string}|null} Null for any other verdict or when no deciding
 *   statistic split. The modes are those of the first deciding statistic (the
 *   frame total, then the cloud total); the reason names every deciding
 *   statistic that split; `verdictIfUnimodal` only on a bimodal record.
 */
export function bimodalDetail(pf2) {
  const bimodal = pf2?.verdict === PERF_VERDICTS.UNMEASURED_BIMODAL;
  if (!bimodal && pf2?.verdict !== PERF_VERDICTS.OVER) {
    return null;
  }
  const deciding = [pf2.total, ...(pf2.cloudless ? [] : [pf2.cloudTotal])];
  const split = deciding.filter((record) =>
    bimodal
      ? record?.verdictIfUnimodal !== undefined && record.modes
      : record?.verdict === PERF_VERDICTS.OVER && record.modes,
  );
  if (split.length === 0) {
    return null;
  }
  return {
    statistic: split[0].statistic,
    modes: split[0].modes,
    ...(bimodal ? { verdictIfUnimodal: split[0].verdictIfUnimodal } : {}),
    reason: split.map((record) => record.modesReason).join("; "),
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
  const total = bandStatistic({
    statistic: "frameAvgMs",
    pick: (run) => run.frameAvgMs,
    base,
    tip,
    bands,
  });
  const cloudTotal = bandStatistic({
    statistic: "cloudTotalMs",
    pick: (run) => run.cloudTotalMs,
    base,
    tip,
    bands,
  });
  const names = (runs) =>
    new Set(usable(runs).flatMap((run) => Object.keys(run.passes)));
  const baseNames = names(base);
  const tipNames = names(tip);
  const passes = {};
  for (const name of [...baseNames].filter((n) => tipNames.has(n)).sort()) {
    passes[name] = bandStatistic({
      statistic: name,
      pick: (run) => run.passes[name],
      base,
      tip,
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
