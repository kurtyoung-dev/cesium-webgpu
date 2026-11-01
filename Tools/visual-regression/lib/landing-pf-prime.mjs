/**
 * The unmeasured prime page a landing PF run loads before its first measured page, and the contention basis a paired run records.
 * @purpose Loads the first PF page of a landing run unmeasured, repeating until the machine is quiet or a page budget is spent, through the run's own page runner (so the browser, disk and shader caches are warm before the first measured arm), records what the prime was and how it ended in one receipt record with a one-line note, and reads from a base report the arm CPU the contention guard will compare the tip against.
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
 * ONE PAGE IS NOT ENOUGH. On a fresh server the first measured page still read
 * hot after a single prime page (71.29 % on the prime, then 83.75 % mean with
 * eleven samples above 60 % in a row on the first measured page), and another
 * run's hot window covered three pages. The load after a server start was seen
 * to span more than one page, so {@link primeBeforeFirstArm} repeats the prime
 * until a page, a short sample after it and (with a base report) the base
 * arm's own mean all say the machine is quiet, bounded by
 * {@link PRIME_MAX_PAGES}; the record lists every page's CPU and why it
 * stopped, and the note the summary prints names both.
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

import { isPfEntry, readMachineCpu, WARM_UP_DEFAULTS } from "./cpu-warm-up.mjs";
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
    stoppedBecause: status,
    cell: entry?.cell ?? null,
    renderer: entry?.renderer ?? null,
    page: entry?.page ?? null,
    durationMs: 0,
    cpuMean: null,
    pages: [],
    note,
    ...extra,
  };
}

/**
 * The most prime pages a run loads. The load after a server start was seen to
 * span more than one page: the prime and the first measured page both read hot
 * on one fresh server, and three pages did on another; four is one past the
 * longest seen, so a machine that does settle is released and one that never
 * does costs the run a bounded number of unmeasured pages.
 */
export const PRIME_MAX_PAGES = 4;

/**
 * Samples taken after a prime page that read quiet. Every one of them must be
 * quiet (not their mean): a spike in the stretch right after the page is the
 * machine still busy, which a mean over three samples would hide.
 */
export const POST_PRIME_SAMPLES = 3;

/** The key a base report's arm is grouped under, as `contentionBasisOf` keys it. */
function armKeyOf(entry) {
  return `${entry.cell}|${entry.renderer}|${entry.page}`;
}

/** Every reason a prime page is not quiet; none means quiet. */
function whyNotQuiet({ pageCpu, post, thresholdPct, basis, armKey }) {
  const why = [];
  if (!Number.isFinite(pageCpu)) {
    why.push("page CPU not read");
  } else if (pageCpu > thresholdPct) {
    why.push(`page CPU ${printed(pageCpu)} % above ${thresholdPct} %`);
  }
  const baseMean = basis?.arms?.[armKey]?.baseMeanCpu;
  if (Number.isFinite(pageCpu) && Number.isFinite(baseMean)) {
    const delta = Math.abs(pageCpu - baseMean);
    if (delta > basis.cpuArmDeltaPct) {
      why.push(
        `page CPU ${printed(pageCpu)} % is ${printed(delta)} points from the base arm's ${printed(baseMean)} %, more than ${basis.cpuArmDeltaPct}`,
      );
    }
  }
  for (const [index, pct] of post.entries()) {
    if (!Number.isFinite(pct)) {
      why.push(`post-prime sample ${index} not read`);
    } else if (pct > thresholdPct) {
      why.push(
        `post-prime sample ${index} ${printed(pct)} % above ${thresholdPct} %`,
      );
    }
  }
  return why;
}

/**
 * Loads the first PF page, unmeasured, again and again until the machine is
 * quiet or {@link PRIME_MAX_PAGES} are spent, and records how that ended.
 *
 * A page is quiet when its CPU is not above the guard's `contendedCpuPct`, a
 * short post-page sample ({@link POST_PRIME_SAMPLES} readings, each not above
 * it) agrees, and, with a base report that read this arm, the page's CPU is
 * within the guard's `cpuArmDeltaPct` of the base arm's mean. Both thresholds
 * come from `resolveBands`. A CPU that was not read is not quiet. The post
 * sample is only taken after a page whose own CPU is quiet; a hot page is
 * followed straight by the next load.
 *
 * @param {object} input
 * @param {{perf?: boolean, noCellPerf?: boolean, noWarmUp?: boolean}} input.options
 * @param {Array<{cell: string, renderer: string, page: string}>} input.plan
 * @param {(entry: object) => Promise<{cpu?: {mean?: number}|null, notRun?: string|null}>} input.runPage
 *   Loads one planned page in its prime mode (captures nothing) and returns
 *   that page's record.
 * @param {() => number} [input.now] A clock, for the durations; defaults to
 *   `deps.now`, then `Date.now`.
 * @param {object} [input.base] The base report, for the arm CPU the tip is held to.
 * @param {object} [input.bands] The wave's `--bands` overrides.
 * @param {{sampleCpu?: () => Promise<number|null>,
 *   pageCpu?: (record: object, entry: object, index: number) => number|null,
 *   intervalMs?: number, now?: () => number}} [input.deps]
 *   Test seams; production passes none. `pageCpu` replaces the page record's
 *   own CPU reading (a live machine value even on a fake browser).
 * @returns {Promise<{status: "primed"|"skipped"|"not-a-pf-run"|"failed",
 *   stoppedBecause: "quiet"|"budget"|"not-a-pf-run"|"skipped"|"failed",
 *   cell: string|null, renderer: string|null, page: string|null,
 *   durationMs: number, cpuMean: number|null, sampler: "live"|"injected",
 *   cpuSource: "page"|"injected",
 *   pages: Array<{index: number, durationMs: number, cpuMean: number|null,
 *   postSample: Array<number|null>, quiet: boolean, why: string[]}>,
 *   note: string}>} Never rejects. `durationMs` is the whole prime including
 *   the post samples, `cpuMean` the last page's CPU, each page's `why` the
 *   reasons it was not quiet (empty when quiet).
 */
export async function primeBeforeFirstArm({
  options,
  plan,
  runPage,
  now,
  base = null,
  bands = {},
  deps,
}) {
  const sampler = typeof deps?.sampleCpu === "function" ? "injected" : "live";
  const cpuSource = typeof deps?.pageCpu === "function" ? "injected" : "page";
  const clock = now ?? deps?.now ?? Date.now;
  const entry = firstPfEntry(options, plan);
  if (!entry) {
    return primeRecord("not-a-pf-run", null, "prime: not a PF run", {
      sampler,
      cpuSource,
    });
  }
  if (options?.noWarmUp === true) {
    return primeRecord("skipped", entry, "prime: skipped (--no-warm-up)", {
      sampler,
      cpuSource,
    });
  }
  const name = `${entry.cell} ${entry.renderer} ${entry.page}`;
  const thresholdPct = resolveBands(bands).contendedCpuPct;
  const basis = contentionBasisOf(base, bands);
  const intervalMs =
    Number.isFinite(deps?.intervalMs) && deps.intervalMs > 0
      ? deps.intervalMs
      : WARM_UP_DEFAULTS.intervalMs;
  const sampleCpu = deps?.sampleCpu ?? (() => readMachineCpu(intervalMs));
  const pageCpuOf = deps?.pageCpu ?? ((record) => record?.cpu?.mean);
  const startedAt = clock();
  const pages = [];
  const finish = (status, stoppedBecause, noteOf) => {
    const durationMs = clock() - startedAt;
    return primeRecord(status, entry, noteOf(durationMs), {
      stoppedBecause,
      durationMs,
      cpuMean: pages.length > 0 ? pages[pages.length - 1].cpuMean : null,
      sampler,
      cpuSource,
      pages,
    });
  };
  try {
    for (let index = 0; ; index++) {
      const pageStart = clock();
      const record = await runPage(entry);
      const durationMs = clock() - pageStart;
      if (record?.notRun) {
        return finish(
          "failed",
          "failed",
          (ms) => `prime: ${name} failed after ${ms} ms: ${record.notRun}`,
        );
      }
      const read = pageCpuOf(record, entry, index);
      const cpuMean = Number.isFinite(read) ? read : null;
      // A hot page is followed by the next load, not by a wait.
      const pageOnly = whyNotQuiet({
        pageCpu: cpuMean,
        post: [],
        thresholdPct,
        basis,
        armKey: armKeyOf(entry),
      });
      const postSample = [];
      if (pageOnly.length === 0) {
        for (let taken = 0; taken < POST_PRIME_SAMPLES; taken++) {
          const pct = await sampleCpu();
          postSample.push(Number.isFinite(pct) ? pct : null);
        }
      }
      const why =
        pageOnly.length > 0
          ? pageOnly
          : whyNotQuiet({
              pageCpu: cpuMean,
              post: postSample,
              thresholdPct,
              basis,
              armKey: armKeyOf(entry),
            });
      const quiet = why.length === 0;
      pages.push({ index, durationMs, cpuMean, postSample, quiet, why });
      if (quiet || index === PRIME_MAX_PAGES - 1) {
        const cpu =
          cpuMean === null ? "(CPU not read)" : `at ${printed(cpuMean)} % CPU`;
        const peak = postSample.length > 0 ? Math.max(...postSample) : null;
        const post =
          peak === null || !Number.isFinite(peak)
            ? ""
            : ` (post-prime peak ${printed(peak)} %)`;
        const because = quiet ? "quiet" : "budget";
        return finish(
          "primed",
          because,
          () =>
            `prime: ${pages.length} page${pages.length === 1 ? "" : "s"} of ${name}, stopped ${because}, last ${cpu}${post}`,
        );
      }
    }
  } catch (error) {
    return finish(
      "failed",
      "failed",
      (ms) =>
        `prime: ${name} failed after ${ms} ms: ${error?.message ?? error}`,
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
