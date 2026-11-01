/**
 * The unmeasured prime page a landing PF run loads before its first measured page, and the contention basis a paired run records.
 * @purpose Loads the first PF page of a landing run once, unmeasured, through the run's own page runner (so the browser, disk and shader caches are warm before the first measured arm), records what the prime was and how it ended in one receipt record with a one-line note, and reads from a base report the arm CPU the contention guard will compare the tip against.
 * @status ACTIVE
 *
 * WHY. The warm-up in `lib/cpu-warm-up.mjs` waits for the machine to be idle
 * before the first page, and the first WebGPU arm after a server start still
 * read `unmeasured-contended`: its own pages ran at 56 and 47 % machine CPU
 * (mean 51.5) against 26 % on the next arm, over the guard's arm-delta clause.
 * The load was the first arm's own (a cold browser, cold disk and shader
 * caches on the first page after a server start), so idle time before the run
 * cannot remove it; loading that page once, unmeasured, can.
 *
 * THE PRIME IS THE SAME PAGE. {@link primeBeforeFirstArm} does not load a page
 * itself: it hands the first PF entry of the plan to the run's page runner, in
 * its prime mode, so the navigation, stage, startup and settle are the
 * measured page's own. The runner returns after the settle having captured
 * nothing; its record never reaches the pages, arms, comparison or verdicts,
 * only the one summary this module builds from it.
 *
 * WHICH PAGE. The first entry of the plan that runs a PF window on the same
 * rule {@link isPfEntry} states for `warmUpBeforeFirstArm`; a run with none
 * (no `--perf`, only dive-gate and device-loss pages) loads no prime page.
 * `--no-warm-up` skips the prime with the warm-up.
 *
 * A FAILED PRIME NEVER STOPS THE RUN. A page that throws, or whose stage did
 * not apply, is recorded as `failed` with its message; the measured pages run
 * as they would have.
 *
 * THE CONTENTION BASIS. {@link contentionBasisOf} reads, for each arm of a
 * base report, the mean CPU of its runs the way `contentionGuard` reads it
 * (`arms[key].inputs.cpu`, through the guard itself), and the two thresholds
 * from `resolveBands`, so a wave's `--bands` override moves the basis and the
 * guard together and a reader of the receipt sees what the tip arm is held to.
 *
 * @module Tools/visual-regression/lib/landing-pf-prime
 */

import { isPfEntry } from "./cpu-warm-up.mjs";
import { contentionGuard, resolveBands } from "./metrics/perf-band.mjs";

/** A figure as the notes print it: two decimals at most, n/a for none. */
function printed(value) {
  return Number.isFinite(value) ? `${Number(value.toFixed(2))}` : "n/a";
}

/**
 * The first entry of a plan that runs a PF window, or null. Pure.
 *
 * @param {object} options The probe options.
 * @param {Array<{cell: string, kind?: string}>} plan `planLandingCells`' answer.
 * @returns {object|null}
 */
export function firstPfEntry(options, plan) {
  return (plan ?? []).find((entry) => isPfEntry(options, entry)) ?? null;
}

/** The prime record for an entry that was or would have been loaded. */
function primeRecord(status, entry, note, extra = {}) {
  return {
    status,
    cell: entry?.cell ?? null,
    renderer: entry?.renderer ?? null,
    page: entry?.page ?? null,
    durationMs: 0,
    cpuMean: null,
    note,
    ...extra,
  };
}

/**
 * Loads the first PF page once, unmeasured, and records how that ended.
 *
 * @param {object} input
 * @param {{perf?: boolean, noCellPerf?: boolean, noWarmUp?: boolean}} input.options
 * @param {Array<{cell: string, renderer: string, page: string}>} input.plan
 * @param {(entry: object) => Promise<{cpu?: {mean?: number}|null, notRun?: string|null}>} input.runPage
 *   Loads one planned page in its prime mode (captures nothing) and returns
 *   that page's record.
 * @param {() => number} [input.now] A clock, for the duration.
 * @returns {Promise<{status: "primed"|"skipped"|"not-a-pf-run"|"failed",
 *   cell: string|null, renderer: string|null, page: string|null,
 *   durationMs: number, cpuMean: number|null, note: string}>} Never rejects.
 */
export async function primeBeforeFirstArm({
  options,
  plan,
  runPage,
  now = Date.now,
}) {
  const entry = firstPfEntry(options, plan);
  if (!entry) {
    return primeRecord("not-a-pf-run", null, "prime: not a PF run");
  }
  if (options?.noWarmUp === true) {
    return primeRecord("skipped", entry, "prime: skipped (--no-warm-up)");
  }
  const name = `${entry.cell} ${entry.renderer} ${entry.page}`;
  const startedAt = now();
  try {
    const record = await runPage(entry);
    const durationMs = now() - startedAt;
    if (record?.notRun) {
      return primeRecord(
        "failed",
        entry,
        `prime: ${name} failed after ${durationMs} ms: ${record.notRun}`,
        { durationMs },
      );
    }
    const cpuMean = Number.isFinite(record?.cpu?.mean) ? record.cpu.mean : null;
    const cpu =
      cpuMean === null ? "(CPU not read)" : `at ${printed(cpuMean)} % CPU`;
    return primeRecord(
      "primed",
      entry,
      `prime: ${name} in ${durationMs} ms ${cpu}`,
      { durationMs, cpuMean },
    );
  } catch (error) {
    const durationMs = now() - startedAt;
    return primeRecord(
      "failed",
      entry,
      `prime: ${name} failed after ${durationMs} ms: ${error?.message ?? error}`,
      { durationMs },
    );
  }
}

/**
 * What the contention guard holds a tip arm to, read from a base report. Pure.
 *
 * @param {{arms?: Record<string, {inputs?: {cpu?: unknown}}>}|null|undefined} base
 *   The base report, its arms grouped as the guard reads them.
 * @param {object} [overrides] The wave's `--bands` contents.
 * @returns {{cpuArmDeltaPct: number, contendedCpuPct: number,
 *   arms: Record<string, {baseMeanCpu: number|null}>, note: string}|null}
 *   null without a base report.
 */
export function contentionBasisOf(base, overrides = {}) {
  if (!base || typeof base.arms !== "object" || base.arms === null) {
    return null;
  }
  const { cpuArmDeltaPct, contendedCpuPct } = resolveBands(overrides);
  const arms = {};
  for (const [key, arm] of Object.entries(base.arms)) {
    const cpu = arm?.inputs?.cpu;
    if (!Array.isArray(cpu) || cpu.length === 0) {
      continue;
    }
    // The guard's own arithmetic for the base arm's mean.
    arms[key] = {
      baseMeanCpu: contentionGuard({
        baseCpu: cpu,
        tipCpu: cpu,
        bands: overrides,
      }).baseMeanCpu,
    };
  }
  const named = Object.entries(arms)
    .map(([key, arm]) => `${key} ${printed(arm.baseMeanCpu)} %`)
    .join(", ");
  return {
    cpuArmDeltaPct,
    contendedCpuPct,
    arms,
    note: `contention basis: the tip arm's mean CPU must stay within ${cpuArmDeltaPct} points of the base arm's (${named || "no base arm read CPU"}) and under ${contendedCpuPct} %`,
  };
}
