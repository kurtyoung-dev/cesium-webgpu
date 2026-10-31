/**
 * The landing probe's base-vs-tip comparison and its verdicts, pure over the
 * page records.
 * @purpose Verdict piece for probe-landing-cells.mjs: the PF-1..PF-4 and first-capture pixel comparison of every arm a base report shares (compareArms), the per-page verdicts (stage, onmessage sentinel and its positive control, device loss, the weather-state identity claim of a weather-state cell, uncaught errors, teardown owners, the named GPU pass a cell expects in its PF-2 window) and the per-arm PF and terminal verdicts (landingVerdicts) and the uncapped non-sentinel console error count (otherConsoleErrorCount), all pure except compareArms' PNG reads.
 * @status ACTIVE
 *
 * WHY A PIECE. Lane TAR-ALDARION moved these out of `probe-landing-cells.mjs`
 * when the sentinel's positive control, the evolved-epoch readback and the
 * ocean compute-pass timing would have taken the probe past 1,000 lines; the
 * probe re-exports every name, so its importers are unchanged.
 *
 * @module Tools/visual-regression/lib/landing-verdicts
 */

import { sameTerminal, terminalShape } from "./device-loss-steps.mjs";
import { PIPELINE_ROW_KINDS } from "./gpu-device-census.mjs";
import { frameTimeVerdict } from "./metrics/frame-time-distribution.mjs";
import { residencyVerdict } from "./metrics/gpu-memory-residency.mjs";
import {
  passCostVerdict,
  summarizePassCost,
} from "./metrics/gpu-pass-cost.mjs";
import {
  PIXEL_PAIR_TOLERANCE,
  pixelBand,
  pixelDiff,
} from "./metrics/landing-pixel-band.mjs";
import { PERF_VERDICTS, contentionGuard } from "./metrics/perf-band.mjs";
import { startupVerdict } from "./metrics/startup-compile.mjs";
import {
  onmessagePositiveControlVerdict,
  onmessageVerdict,
} from "./onmessage-sentinel.mjs";
import { LANDING_CELLS } from "./landing-cell-table.mjs";
import { UNMEASURED_REASONS } from "./probe-refusal.mjs";
import { weatherStateVerdict } from "./weather-state-steps.mjs";

/**
 * A PF reading that does not exist on this renderer on either arm (the per-pass
 * profiler on WebGL, or on an adapter without `timestamp-query`). It is
 * reported and carries no verdict; an arm where only ONE side lacks it is
 * `unmeasured`, which fails.
 */
export const NOT_APPLICABLE = "not-applicable";

/**
 * How many non-sentinel `error` console lines a page recorded. `other` is a
 * sample of at most five lines, so its length caps the count at five and hides
 * a page that logged ninety-one; the uncapped `otherCount` is read first, then
 * `errors - sentinel` (a report written before `otherCount` existed), and only
 * then the sample's length. Pure.
 *
 * @param {{otherCount?: number, errors?: number, sentinel?: number, other?: string[]}|null|undefined} consoleErrors A page's classified console lines.
 * @returns {number} The non-sentinel error count.
 */
export function otherConsoleErrorCount(consoleErrors) {
  if (Number.isFinite(consoleErrors?.otherCount)) {
    return consoleErrors.otherCount;
  }
  if (
    Number.isFinite(consoleErrors?.errors) &&
    Number.isFinite(consoleErrors?.sentinel)
  ) {
    return Math.max(0, consoleErrors.errors - consoleErrors.sentinel);
  }
  return consoleErrors?.other?.length ?? 0;
}

/**
 * The PF verdicts and the first-capture pixel diff of every arm the base
 * report also has. Reads the base PNGs from the paths the base report records.
 *
 * @param {Record<string, object>} tipArms {@link groupArms} of this run set.
 * @param {Record<string, object>} baseArms The base report's `arms`.
 * @param {object} bands Resolved bands.
 * @param {{startupField?: string}} [options]
 * @returns {Record<string, object>} Per arm key.
 */
export function compareArms(tipArms, baseArms, bands, options = {}) {
  const out = {};
  for (const [key, tip] of Object.entries(tipArms)) {
    const base = baseArms?.[key];
    if (!base) {
      out[key] = { base: "absent" };
      continue;
    }
    const comparison = {};
    // The pre-registered contention guard over this arm pair's runs (F3).
    const contention = contentionGuard({
      baseCpu: base.inputs.cpu,
      tipCpu: tip.inputs.cpu,
      baseSamples: base.inputs.cpuSamples ?? [],
      tipSamples: tip.inputs.cpuSamples ?? [],
      bands,
    });
    if (tip.inputs.pf3.length > 0 || base.inputs.pf3.length > 0) {
      comparison.contention = contention;
      comparison.pf3 = startupVerdict({
        baseRuns: base.inputs.pf3,
        tipRuns: tip.inputs.pf3,
        bands,
        field: options.startupField || undefined,
        renderer: tip.renderer ?? key.split("|")[1],
        contention,
      });
    }
    if (tip.inputs.pf1.length > 0 || base.inputs.pf1.length > 0) {
      comparison.contention = contention;
      comparison.pf1 = frameTimeVerdict({
        baseRuns: base.inputs.pf1,
        tipRuns: tip.inputs.pf1,
        bands,
        contention,
      });
      const unavailable = (runs) =>
        runs.length > 0 && runs.every((run) => run?.available === false);
      comparison.pf2 =
        unavailable(base.inputs.pf2) && unavailable(tip.inputs.pf2)
          ? {
              metric: "PF-2",
              verdict: NOT_APPLICABLE,
              reason: `the per-pass profiler is unavailable on both arms (${tip.inputs.pf2[0].reason})`,
            }
          : passCostVerdict({
              baseRuns: base.inputs.pf2,
              tipRuns: tip.inputs.pf2,
              bands,
              contention,
            });
      comparison.pf4 = residencyVerdict({
        baseRuns: base.inputs.pf4,
        tipRuns: tip.inputs.pf4,
        bands,
      });
    }
    const baseShot = base.captures?.[0];
    const tipShot = tip.captures?.[0];
    if (baseShot && tipShot) {
      const diff = pixelDiff(baseShot, tipShot);
      if (!diff.measured) {
        comparison.pixels = diff;
      } else {
        const renderer = tip.renderer ?? key.split("|")[1];
        const band = pixelBand({
          renderer,
          changedPx: diff.changedPx,
          baseArm: base,
          tipArm: tip,
        });
        comparison.pixels = {
          measured: true,
          base: baseShot.name,
          tip: tipShot.name,
          tolerance: PIXEL_PAIR_TOLERANCE,
          changedPx: diff.changedPx,
          mismatchPct: diff.mismatchPct,
          bbox: diff.bbox,
          verdict: band.verdict,
          band,
        };
      }
    }
    if (tip.deviceLoss.length > 0 && base.deviceLoss.length > 0) {
      // One reader of the terminal record, any mode (F1).
      const shape = (entry) => terminalShape(entry.terminal);
      comparison.terminal = {
        base: base.deviceLoss.map(shape),
        tip: tip.deviceLoss.map(shape),
        same: sameTerminal(shape(base.deviceLoss[0]), shape(tip.deviceLoss[0])),
        baseOtherConsoleErrors: Math.max(
          ...base.deviceLoss.map((e) =>
            otherConsoleErrorCount(e.consoleErrors),
          ),
        ),
        tipOtherConsoleErrors: Math.max(
          ...tip.deviceLoss.map((e) => otherConsoleErrorCount(e.consoleErrors)),
        ),
      };
    }
    out[key] = comparison;
  }
  return out;
}

/**
 * The run's verdicts. Pure over the page records and the comparison.
 *
 * @param {object[]} records
 * @param {Record<string, object>|null} comparison
 * @returns {Array<{id: string, pass: boolean}>}
 */
export function landingVerdicts(records, comparison) {
  const verdicts = [];
  for (const record of records) {
    const id = `${record.cell}:${record.renderer}:${record.page}:run${record.run}`;
    verdicts.push({
      id: `${id}:stage`,
      pass: record.notRun === null,
      notRun: record.notRun !== null,
      reason: record.notRun ?? undefined,
    });
    // Read before the stage, so judged whether or not the stage applied.
    if (record.onmessage !== undefined) {
      verdicts.push(onmessageVerdict(id, record.onmessage));
    }
    // --sentinel-positive-control: the second reading must show the change.
    if (record.onmessageControl !== undefined) {
      verdicts.push(
        onmessagePositiveControlVerdict(id, record.onmessageControl),
      );
    }
    if (record.notRun !== null) {
      continue;
    }
    const lost = record.deviceLoss
      ? record.deviceLoss.deviceLost
      : record.gate?.deviceLost;
    verdicts.push({
      id: `${id}:no-unexpected-device-loss`,
      pass: !lost,
      deviceLost: lost ?? null,
    });
    if (record.kind === "weather-state") {
      verdicts.push(weatherStateVerdict(id, record));
    }
    const timed = perfPassTiming(record);
    if (timed?.available === true) {
      verdicts.push({
        id: `${id}:perf-pass-timed`,
        pass: timed.timed,
        passName: timed.passName,
        avgMs: timed.avgMs,
      });
    }
    if (record.deviceLoss) {
      const owners = record.deviceLoss.owners?.after ?? [];
      const pageErrors = record.deviceLoss.consoleErrors?.pageErrors ?? [];
      verdicts.push({
        id: `${id}:no-uncaught-error`,
        pass: pageErrors.length === 0,
        pageErrors,
      });
      if (record.page === "teardown") {
        // Released means live 0, by an explicit destroy() or with the device;
        // each seen row says which, so the sheet can tell them apart.
        const seen = owners.filter((row) => row.seen);
        // A pipeline has no destroy(): reported, never a failure (K5-3).
        const live = seen.filter(
          (row) => row.live > 0 && !PIPELINE_ROW_KINDS.includes(row.kind),
        );
        verdicts.push({
          id: `${id}:owners-destroyed`,
          pass: live.length === 0,
          live,
          owners: seen.map((row) => ({
            label: row.label,
            kind: row.kind,
            created: row.created,
            destroyed: row.destroyed,
            freedByDevice: row.freedByDevice ?? 0,
            live: row.live,
          })),
        });
      }
    }
  }
  for (const [key, arm] of Object.entries(comparison ?? {})) {
    for (const pf of ["pf1", "pf2", "pf3", "pf4"]) {
      if (arm[pf] && arm[pf].verdict !== NOT_APPLICABLE) {
        const unmeasured =
          arm[pf].verdict === PERF_VERDICTS.UNMEASURED ||
          arm[pf].verdict === PERF_VERDICTS.UNMEASURED_CONTENDED;
        verdicts.push({
          id: `${key}:${arm[pf].metric}`,
          pass: arm[pf].verdict === PERF_VERDICTS.WITHIN,
          verdict: arm[pf].verdict,
          // An unmeasured statistic is NOT RUN, never a pass (D4). A
          // contended one is also marked: the machine, not the tree, kept it
          // from being read, so it is recorded without failing the run. A
          // plain unmeasured one (a number the arm never produced) still fails.
          ...(unmeasured ? { notRun: true } : {}),
          ...(arm[pf].verdict === PERF_VERDICTS.UNMEASURED_CONTENDED
            ? { unmeasured: UNMEASURED_REASONS.CONTENDED }
            : {}),
        });
      }
    }
    if (arm.terminal) {
      verdicts.push({
        id: `${key}:terminal-as-base`,
        pass:
          arm.terminal.same &&
          arm.terminal.tipOtherConsoleErrors <=
            arm.terminal.baseOtherConsoleErrors,
        terminal: arm.terminal,
      });
    }
  }
  return verdicts;
}

/**
 * The named GPU pass a cell expects in its PF-2 window (`perfPass` in the cell
 * table; E-FFT-ifft names the FFT ocean's compute chain), read from a page
 * record. `null` when the cell names none or the page ran no PF window;
 * `available: false` when the per-pass profiler gave no result (WebGL, an
 * adapter without `timestamp-query`), which is reported and judged by nobody.
 * Pure.
 *
 * WHY. Batch 1622 claimed two Stockham dispatches cost less than 32 ping-pong
 * passes, and the first PF-2 window listed no ocean pass at all (the kit-PF
 * receipt, finding 1): the chain ran untimed. The engine now opens it through
 * `withComputePassTimestamps`; this reading proves the slot reaches PF-2.
 *
 * @param {object} record A page record.
 * @returns {{passName: string, available: boolean, reason?: string,
 *   timed: boolean, avgMs: number|null}|null}
 */
export function perfPassTiming(record) {
  const passName = LANDING_CELLS[record?.cell]?.perfPass;
  if (typeof passName !== "string" || !record?.perf) {
    return null;
  }
  const summary = summarizePassCost(record.perf.passCost);
  if (!summary.available) {
    return {
      passName,
      available: false,
      reason: summary.reason,
      timed: false,
      avgMs: null,
    };
  }
  const avgMs = summary.passes[passName];
  return {
    passName,
    available: true,
    timed: Number.isFinite(avgMs),
    avgMs: Number.isFinite(avgMs) ? avgMs : null,
  };
}

/**
 * Per page that names a PF-2 pass, its {@link perfPassTiming}, for the
 * receipt. Pure.
 *
 * @param {object[]} pages
 * @returns {Array<object>}
 */
export function perfPassTimings(pages) {
  return (pages ?? []).flatMap((record) => {
    const timing = perfPassTiming(record);
    return timing
      ? [
          {
            cell: record.cell,
            renderer: record.renderer,
            page: record.page,
            run: record.run,
            ...timing,
          },
        ]
      : [];
  });
}

/**
 * With `--sentinel-positive-control`, the run-level verdict that some identity
 * page of each run of THIS invocation reached the control: a run whose control
 * page stopped before it would otherwise leave no control verdict at all, and
 * a missing verdict reads as nothing wrong. Pure.
 *
 * @param {object[]} records This invocation's page records (not merged ones).
 * @param {boolean} enabled Whether the switch was given.
 * @returns {Array<{id: string, pass: boolean, notRun: true, reason: string}>}
 */
export function positiveControlCoverage(records, enabled) {
  if (enabled !== true) {
    return [];
  }
  const runs = [...new Set((records ?? []).map((record) => record.run))];
  return runs
    .filter(
      (run) =>
        !records.some(
          (record) =>
            record.run === run && record.onmessageControl !== undefined,
        ),
    )
    .map((run) => ({
      id: `onmessage-positive-control:run${run}`,
      pass: false,
      notRun: true,
      reason: "no identity page of this run reached the positive control",
    }));
}
