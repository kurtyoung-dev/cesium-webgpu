/**
 * The machine-CPU warm-up a PF run waits through before its first page.
 * @purpose Waits, before a landing PF run's first page, until the machine's CPU has stayed at or under the contention guard's own threshold for a run of consecutive samples (or a time-out, which lets the run proceed), records every sample and one note line, and marks each PF verdict with how each arm's warm-up ended, the prime note and the arm CPU its contention guard holds the tip to; the sampler and clock are injectable.
 * @status ACTIVE
 *
 * WHY. The first PF arm after a server start read `unmeasured-contended` (its
 * run 0 at 59.58 %, the arm mean 44.23 %) while the tip arm a minute later read
 * 22.31 %: the machine was still settling from the start, and the contention
 * guard in `lib/metrics/perf-band.mjs` turned PF-1..PF-3 into
 * unmeasured-contended. Waiting for a quiet stretch before the first measured
 * page removes that start-up share without loosening the guard.
 *
 * THE THRESHOLD IS THE GUARD'S. A sample is quiet when it is not above
 * `resolveBands(bands).contendedCpuPct`, the value the guard itself reads as
 * contended when it is `>` the threshold, so a wave's `--bands` override moves
 * the warm-up and the guard together. A sample whose counters did not move
 * (null) is not quiet and resets the streak.
 *
 * A TIME-OUT PROCEEDS. A machine that never settles must not hang the run: the
 * record says `timed-out`, and the guard then judges the arm on its own samples
 * as it always did. Nothing here throws for a busy machine.
 *
 * REUSE. The reading is `lib/cpu-sampler.mjs`' `readCpuTimes` and
 * `busyPercent` (one arithmetic for machine CPU); the timer is `unref`'d so a
 * pending read never holds the process open.
 *
 * A FAKE BROWSER NEVER WAITS. The live sampler reads the machine and waits a
 * second a sample, which a Node spec over a fake browser must never do (its
 * result would depend on the machine and its run would take seconds to
 * minutes). The seam is the launched browser: a browser carrying
 * {@link WARM_UP_SEAM} (a fake marks itself with {@link withInstantWarmUp})
 * hands its sampler to the run, and the record names which sampler it read
 * (`sampler: "live" | "injected"`). {@link liveSamplerReads} counts the live
 * reads of this process, so a spec can prove none happened.
 *
 * @module Tools/visual-regression/lib/cpu-warm-up
 */

import { busyPercent, readCpuTimes } from "./cpu-sampler.mjs";
import { LANDING_CELLS } from "./landing-cell-table.mjs";
import { resolveBands } from "./metrics/perf-band.mjs";

/** The key a launched browser carries its warm-up dependencies under. */
export const WARM_UP_SEAM = Symbol.for("cesium-probe-kit.warmUpDeps");

/** The warm-up a fake browser runs: one quiet sample, no wait, no clock. */
export const INSTANT_WARM_UP = Object.freeze({
  settleSamples: 1,
  sampleCpu: async () => 0,
  now: () => 0,
});

/**
 * Mark a (fake) browser so a run launched on it reads the instant warm-up.
 *
 * @param {object} browser
 * @param {object} [deps] Defaults to {@link INSTANT_WARM_UP}.
 * @returns {object} The same browser.
 */
export function withInstantWarmUp(browser, deps = INSTANT_WARM_UP) {
  browser[WARM_UP_SEAM] = deps;
  return browser;
}

let liveReads = 0;

/** How many live machine-CPU readings this process has taken. */
export function liveSamplerReads() {
  return liveReads;
}

/** The warm-up's dials: quiet samples to release, sample interval, time-out. */
export const WARM_UP_DEFAULTS = Object.freeze({
  settleSamples: 5,
  intervalMs: 1000,
  timeoutMs: 120000,
});

const PF_VERDICT_ID = /:PF-[1-4]$/;
const NOT_RECORDED = "warm-up: not recorded";
const NOT_RECORDED_PRIME = "prime: not recorded";

/** A dial a caller overrode, when it is a usable positive number. */
function dial(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** One machine-CPU reading over one interval; null when the counters stood still. */
function readMachineCpu(intervalMs) {
  liveReads++;
  const before = readCpuTimes();
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve(busyPercent(before, readCpuTimes())),
      intervalMs,
    );
    // A pending read must not keep the process alive.
    timer.unref?.();
  });
}

/** A percentage as the note prints it: two decimals at most, n/a for none. */
function printed(pct) {
  return Number.isFinite(pct) ? `${Number(pct.toFixed(2))}` : "n/a";
}

/** Page kinds the probe never runs a PF window on. */
const NO_PF_KINDS = Object.freeze(["device-loss", "dive-gate"]);

/** Whether this planned page runs a performance window. */
export function isPfEntry(options, entry) {
  return (
    !NO_PF_KINDS.includes(entry?.kind ?? LANDING_CELLS[entry?.cell]?.kind) &&
    (options?.perf === true ||
      (LANDING_CELLS[entry?.cell]?.perf === true &&
        options?.noCellPerf !== true))
  );
}

/** Whether this invocation runs a performance window on any page. */
export function isPfRun(options, plan) {
  return (plan ?? []).some((entry) => isPfEntry(options, entry));
}

/**
 * Waits for the machine to settle before a PF run's first page.
 *
 * @param {object} input
 * @param {{perf?: boolean, noCellPerf?: boolean, noWarmUp?: boolean}} input.options
 *   The probe options.
 * @param {Array<{cell: string}>} input.plan `planLandingCells`' answer.
 * @param {object} [input.bands] The wave's `--bands` overrides.
 * @param {{settleSamples?: number, intervalMs?: number, timeoutMs?: number,
 *   sampleCpu?: () => Promise<number|null>, now?: () => number}} [input.deps]
 *   Test seams; production passes none.
 * @returns {Promise<{status: "released"|"timed-out"|"skipped"|"not-a-pf-run",
 *   thresholdPct: number, settleSamples: number, intervalMs: number,
 *   timeoutMs: number, samples: Array<{atMs: number, pct: number|null}>,
 *   sampleCount: number, durationMs: number, releasedAtPct: number|null,
 *   note: string}>} Never rejects for a busy machine.
 */
export async function warmUpBeforeFirstArm({
  options,
  plan,
  bands = {},
  deps,
} = {}) {
  const thresholdPct = resolveBands(bands).contendedCpuPct;
  const settleSamples = dial(
    deps?.settleSamples,
    WARM_UP_DEFAULTS.settleSamples,
  );
  const intervalMs = dial(deps?.intervalMs, WARM_UP_DEFAULTS.intervalMs);
  const timeoutMs = dial(deps?.timeoutMs, WARM_UP_DEFAULTS.timeoutMs);
  const sampler = typeof deps?.sampleCpu === "function" ? "injected" : "live";
  const sampleCpu = deps?.sampleCpu ?? (() => readMachineCpu(intervalMs));
  const now = deps?.now ?? Date.now;

  const record = (status, note, samples = [], durationMs = 0) => ({
    status,
    thresholdPct,
    settleSamples,
    intervalMs,
    timeoutMs,
    sampler,
    samples,
    sampleCount: samples.length,
    durationMs,
    releasedAtPct: samples.length > 0 ? samples[samples.length - 1].pct : null,
    note,
  });

  if (!isPfRun(options, plan)) {
    return record("not-a-pf-run", "warm-up: not a PF run");
  }
  if (options?.noWarmUp === true) {
    return record("skipped", "warm-up: skipped (--no-warm-up)");
  }

  const startedAt = now();
  const samples = [];
  let streak = 0;
  for (;;) {
    const pct = await sampleCpu();
    const atMs = now() - startedAt;
    samples.push({ atMs, pct: Number.isFinite(pct) ? pct : null });
    // Not above the threshold is quiet: the guard reads contended on `>`.
    streak = Number.isFinite(pct) && pct <= thresholdPct ? streak + 1 : 0;
    if (streak >= settleSamples) {
      return record(
        "released",
        `warm-up: released after ${samples.length} samples (${atMs} ms) at ${printed(pct)} %`,
        samples,
        atMs,
      );
    }
    if (atMs >= timeoutMs) {
      return record(
        "timed-out",
        `warm-up: timed out at ${printed(pct)} %`,
        samples,
        atMs,
      );
    }
  }
}

/**
 * Marks every PF verdict with how each arm's warm-up ended, what the prime
 * page was, and the arm CPU its contention guard holds the tip to. Pure.
 *
 * @param {Array<{id: string}>} verdicts
 * @param {{tip?: {note?: string}|null, base?: {note?: string}|null,
 *   prime?: {note?: string}|null, basis?: {cpuArmDeltaPct: number,
 *   arms: Record<string, {baseMeanCpu: number|null}>}|null}} arms
 *   This invocation's record, and the base report's top-level `warmUp` (null
 *   for a report written before the warm-up existed); the invocation's prime
 *   record and the contention basis of the base report (both left out, the
 *   verdict carries no such field).
 * @returns {object[]} A new array; only `:PF-1`..`:PF-4` verdicts gain a
 *   `warmUp: {tip, base}` of note lines, a `prime` note line and a
 *   `contentionBasis: {baseMeanCpu, cpuArmDeltaPct}` of their own arm, nothing
 *   else about any verdict moves.
 */
export function markPfVerdicts(verdicts, { tip, base, prime, basis } = {}) {
  const warmUp = {
    tip: tip?.note ?? NOT_RECORDED,
    base: base?.note ?? NOT_RECORDED,
  };
  return (verdicts ?? []).map((verdict) => {
    const id = verdict?.id ?? "";
    if (!PF_VERDICT_ID.test(id)) {
      return verdict;
    }
    const marked = { ...verdict, warmUp: { ...warmUp } };
    if (prime !== undefined) {
      marked.prime = prime?.note ?? NOT_RECORDED_PRIME;
    }
    if (basis) {
      marked.contentionBasis = {
        baseMeanCpu:
          basis.arms?.[id.replace(PF_VERDICT_ID, "")]?.baseMeanCpu ?? null,
        cpuArmDeltaPct: basis.cpuArmDeltaPct,
      };
    }
    return marked;
  });
}
