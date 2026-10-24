/**
 * Machine CPU sampled while a probe runs, so a performance reading can say
 * whether the machine was busy with something else when it was taken.
 * @purpose Node-only machine-CPU sampler for a probe run: reads os.cpus() time counters at 1 Hz (no PowerShell, no child process), turns each interval's busy share across every logical CPU into a percentage, and on stop returns {samples, mean, p95, max, startedAt, endedAt, intervalMs}; plus the pure busy-share arithmetic, the summary and a merge of several series.
 * @status ACTIVE
 *
 * WHAT A SAMPLE IS. `os.cpus()` gives each logical CPU's cumulative time in
 * user, nice, sys, irq and idle. Two readings an interval apart give the
 * machine's busy share over that interval: 100 x (1 - idle delta / total
 * delta), summed over every logical CPU. It is the whole machine, the probe's
 * own browser included, which is the point: it is the reading that tells a
 * quiet machine from one shared with builds, other lanes or a stray scan
 * (the 2026-10-22 water E11 run saw 60-100 % between launches).
 *
 * REUSE. The kit had no CPU reader under `lib/` (the executor's banked
 * `cpuwait.mjs` helper was the same arithmetic, unshipped); the percentile
 * and mean come from `lib/performance-campaign-utils.mjs`'s
 * `summarizeFramePacing`, as `lib/metrics/frame-time-distribution.mjs` reads
 * them, so the kit keeps one percentile.
 *
 * THE TIMER NEVER HOLDS A PROCESS OPEN (`unref`), and `stop()` takes one last
 * reading so a window shorter than the interval still has a sample. A window
 * whose counters did not move reads no sample, never 0 %.
 *
 * @module Tools/visual-regression/lib/cpu-sampler
 */

import os from "node:os";

import { summarizeFramePacing } from "./performance-campaign-utils.mjs";

/** The default sampling interval: 1 Hz. */
export const DEFAULT_CPU_SAMPLE_INTERVAL_MS = 1000;

/**
 * The machine's cumulative busy and total CPU time over every logical CPU,
 * in milliseconds. Pure over its input.
 *
 * @param {Array<{times: Record<string, number>}>} [cpus] `os.cpus()`.
 * @returns {{busy: number, total: number}}
 */
export function readCpuTimes(cpus = os.cpus()) {
  let busy = 0;
  let total = 0;
  for (const cpu of cpus ?? []) {
    const times = cpu?.times ?? {};
    let all = 0;
    for (const value of Object.values(times)) {
      if (Number.isFinite(value)) {
        all += value;
      }
    }
    total += all;
    busy += all - (Number.isFinite(times.idle) ? times.idle : 0);
  }
  return { busy, total };
}

/**
 * The busy share between two {@link readCpuTimes} readings, in percent.
 * Pure.
 *
 * @param {{busy: number, total: number}} before
 * @param {{busy: number, total: number}} after
 * @returns {number|null} null when the total did not advance.
 */
export function busyPercent(before, after) {
  const total = (after?.total ?? 0) - (before?.total ?? 0);
  if (!(total > 0)) {
    return null;
  }
  const busy = (after?.busy ?? 0) - (before?.busy ?? 0);
  return Math.min(100, Math.max(0, (100 * busy) / total));
}

/**
 * The mean, p95 and max of a sample list. Pure.
 *
 * @param {Array<{pct: number}>} samples
 * @returns {{n: number, mean: number|null, p95: number|null,
 *   max: number|null}}
 */
export function summarizeCpuSamples(samples) {
  const values = (samples ?? [])
    .map((sample) => sample?.pct)
    .filter((value) => Number.isFinite(value));
  const wall = summarizeFramePacing(
    values.map((wallDtMs) => ({ wallDtMs })),
  ).wallMs;
  if (!wall) {
    return { n: 0, mean: null, p95: null, max: null };
  }
  return { n: wall.count, mean: wall.avg, p95: wall.p95, max: wall.max };
}

/**
 * Start sampling. Node only.
 *
 * @param {object} [options]
 * @param {number} [options.intervalMs] Default 1000 (1 Hz).
 * @param {() => {busy: number, total: number}} [options.readTimes] Default
 *   {@link readCpuTimes} over `os.cpus()`.
 * @param {() => number} [options.now] Epoch milliseconds; default `Date.now`.
 * @param {{setInterval: Function, clearInterval: Function}} [options.timers]
 * @returns {{stop: () => {samples: Array<{at: string, pct: number}>,
 *   n: number, mean: number|null, p95: number|null, max: number|null,
 *   startedAt: string, endedAt: string, intervalMs: number}}} `stop()` is
 *   idempotent: a second call returns the first result.
 */
export function startCpuSampler({
  intervalMs = DEFAULT_CPU_SAMPLE_INTERVAL_MS,
  readTimes = () => readCpuTimes(),
  now = Date.now,
  timers = { setInterval, clearInterval },
} = {}) {
  const startedAtMs = now();
  const samples = [];
  let previous = readTimes();
  const take = () => {
    const current = readTimes();
    const pct = busyPercent(previous, current);
    previous = current;
    if (pct !== null) {
      samples.push({
        at: new Date(now()).toISOString(),
        pct: Math.round(pct * 100) / 100,
      });
    }
  };
  const handle = timers.setInterval(take, intervalMs);
  if (handle && typeof handle.unref === "function") {
    handle.unref();
  }
  let result = null;
  return {
    stop() {
      if (result) {
        return result;
      }
      timers.clearInterval(handle);
      take();
      result = {
        samples,
        ...summarizeCpuSamples(samples),
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: new Date(now()).toISOString(),
        intervalMs,
      };
      return result;
    },
  };
}

/**
 * One series from several (the pages of one probe run, in any order): the
 * samples in time order, the summary over all of them, the earliest start and
 * the latest end. Pure.
 *
 * @param {Array<object|null|undefined>} series {@link startCpuSampler}
 *   results; absent members are skipped.
 * @returns {object|null} null when no series was given.
 */
export function mergeCpuSeries(series) {
  const present = (series ?? []).filter(
    (member) => member && Array.isArray(member.samples),
  );
  if (present.length === 0) {
    return null;
  }
  const samples = present
    .flatMap((member) => member.samples)
    .slice()
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const starts = present.map((member) => member.startedAt).sort();
  const ends = present.map((member) => member.endedAt).sort();
  return {
    samples,
    ...summarizeCpuSamples(samples),
    startedAt: starts[0] ?? null,
    endedAt: ends[ends.length - 1] ?? null,
    intervalMs: present[0].intervalMs ?? DEFAULT_CPU_SAMPLE_INTERVAL_MS,
  };
}
