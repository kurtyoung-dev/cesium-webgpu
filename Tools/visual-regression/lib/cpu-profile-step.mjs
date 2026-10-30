/**
 * A V8 CPU profile of a page's startup, taken over CDP from before the
 * navigation to the moment a named page step returns, with a page-clock
 * calibration mark so a metric can crop it to any page-time interval.
 * @purpose Step piece: starts the V8 sampling profiler (CDP `Profiler.enable`/`setSamplingInterval`/`start`) on a page's CDP session before its navigation, stops it after a chosen page step returns (by default the kit's `pageMeasureStartup`), runs one named calibration function in the page so profile time maps to page time (`performance.now()`, navigation-relative), and writes `<name>.cpuprofile` (DevTools-loadable, untouched) plus `<name>.cpuprofile.meta.json`; it can be installed on a runtime-launched browser so an existing runtime probe is profiled without editing it.
 * @status ACTIVE
 *
 * WHY A CALIBRATION MARK. The profile's timestamps are the browser's monotonic
 * clock in microseconds; the startup timeline (`lib/frame-timing-steps.mjs`)
 * is page time, `performance.now()` from the document's navigation start. No
 * CDP call returns both clocks at once, so after the profiled step the page
 * runs `__cpuProfileClockMark`, a function that reads `performance.now()` and
 * then spins for `spinMs`. The samples that land inside it carry monotonic
 * timestamps; their midpoint against the page-time midpoint of the spin gives
 * the offset (error about half a sampling interval). The mark runs AFTER the
 * profiled step, so it never lands inside a measured startup interval.
 *
 * WHY INSTALL ON THE BROWSER. The runtime (`lib/probe-runtime.mjs`) hands a
 * descriptor's `cells` the launched browser. `installStartupCpuProfiles`
 * wraps that browser's `newContext` -> `newContext().newPage` ->
 * `page.evaluate` for the duration of a call, so a probe such as
 * `probe-landing-cells.mjs` runs its own page lifecycle unchanged while every
 * page it opens is profiled from before its `goto`. Nothing in the page is
 * patched; the only page-side work is the calibration mark, after the step.
 *
 * WHAT IT COSTS. The sampling profiler runs on the renderer's main thread at
 * the chosen interval (default 250 us); a profiled startup is slower than an
 * unprofiled one by a roughly constant fraction, the same on both arms. Read
 * attribution from profiles, and the startup interval from unprofiled runs.
 *
 * @module Tools/visual-regression/lib/cpu-profile-step
 */

import fs from "node:fs";
import path from "node:path";

/** The calibration function's name, as it appears in the profile. */
export const CALIBRATION_MARK_FUNCTION = "__cpuProfileClockMark";

/** The default sampling interval in microseconds. */
export const DEFAULT_SAMPLING_INTERVAL_US = 250;

/**
 * The default spin of the calibration mark, in milliseconds. 6 ms was too
 * short on a loaded machine: two of six WebGPU startup profiles sampled at
 * 1000 us (2026-10-23, machine CPU 80-100 %) held no sample inside the mark
 * and could not be cropped. 30 ms holds several samples even when the
 * sampler thread is starved; the mark runs after the profiled step, so its
 * length never enters a measured interval.
 */
export const DEFAULT_CALIBRATION_SPIN_MS = 30;

/**
 * The page-side source of the calibration mark: an expression that defines
 * and calls a function named {@link CALIBRATION_MARK_FUNCTION}, returning the
 * page time at which the spin began and ended.
 *
 * @param {number} spinMs How long to spin.
 * @returns {string} An expression for `page.evaluate`.
 */
export function calibrationMarkSource(spinMs = DEFAULT_CALIBRATION_SPIN_MS) {
  const spin = Number.isFinite(spinMs) && spinMs > 0 ? spinMs : 1;
  return `(() => {
  function ${CALIBRATION_MARK_FUNCTION}(spinMs) {
    const startMs = performance.now();
    let endMs = startMs;
    while (endMs - startMs < spinMs) {
      endMs = performance.now();
    }
    return { startMs, endMs };
  }
  return ${CALIBRATION_MARK_FUNCTION}(${spin});
})()`;
}

/**
 * Start the sampling profiler on a page, before it navigates.
 *
 * @param {import("playwright").Page} page The page (still on about:blank).
 * @param {{samplingIntervalUs?: number}} [options]
 * @returns {Promise<{session: object, samplingIntervalUs: number,
 *   startedAt: string}>} The handle {@link stopPageCpuProfile} takes.
 */
export async function startPageCpuProfile(page, options = {}) {
  const samplingIntervalUs =
    Number.isFinite(options.samplingIntervalUs) &&
    options.samplingIntervalUs > 0
      ? options.samplingIntervalUs
      : DEFAULT_SAMPLING_INTERVAL_US;
  const session = await page.context().newCDPSession(page);
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", {
    interval: samplingIntervalUs,
  });
  await session.send("Profiler.start");
  return { session, samplingIntervalUs, startedAt: new Date().toISOString() };
}

/**
 * Run the calibration mark in the page, then stop the profiler.
 *
 * @param {object} handle {@link startPageCpuProfile}'s answer.
 * @param {{page: import("playwright").Page, spinMs?: number,
 *   evaluate?: Function}} args `evaluate` is the page's original evaluate when
 *   the page's own was wrapped.
 * @returns {Promise<{profile: object, calibration: object|null,
 *   stoppedAt: string, error?: string}>}
 */
export async function stopPageCpuProfile(handle, { page, spinMs, evaluate }) {
  let calibration = null;
  let error;
  try {
    const run = evaluate ?? ((expression) => page.evaluate(expression));
    const mark = await run(calibrationMarkSource(spinMs));
    calibration = {
      functionName: CALIBRATION_MARK_FUNCTION,
      pageStartMs: mark?.startMs ?? null,
      pageEndMs: mark?.endMs ?? null,
    };
  } catch (caught) {
    error = `calibration: ${String(caught?.message ?? caught)}`;
  }
  const { profile } = await handle.session.send("Profiler.stop");
  await handle.session.send("Profiler.disable").catch(() => {});
  await handle.session.detach().catch(() => {});
  const result = { profile, calibration, stoppedAt: new Date().toISOString() };
  if (error) {
    result.error = error;
  }
  return result;
}

/**
 * Write a stopped profile: `<name>.cpuprofile` (the CDP profile as returned,
 * loadable in DevTools) and `<name>.cpuprofile.meta.json` (calibration, step
 * result, sampling interval, page URL).
 *
 * @param {{directory: string, name: string, stopped: object,
 *   meta?: object}} args
 * @returns {{profilePath: string, metaPath: string}}
 */
export function writeCpuProfile({ directory, name, stopped, meta = {} }) {
  fs.mkdirSync(directory, { recursive: true });
  const profilePath = path.join(directory, `${name}.cpuprofile`);
  const metaPath = path.join(directory, `${name}.cpuprofile.meta.json`);
  fs.writeFileSync(profilePath, JSON.stringify(stopped.profile));
  fs.writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        ...meta,
        calibration: stopped.calibration,
        stoppedAt: stopped.stoppedAt,
        error: stopped.error ?? null,
      },
      null,
      1,
    )}\n`,
  );
  return { profilePath, metaPath };
}

/**
 * Profile every page a browser opens while installed: the profiler starts
 * when the page is created (before any navigation) and stops after the first
 * `page.evaluate` whose function `isStopStep` accepts has returned.
 *
 * @param {object} args
 * @param {import("playwright").Browser} args.browser The runtime's browser.
 * @param {(fn: unknown) => boolean} args.isStopStep Which evaluate ends the
 *   profile (e.g. `(fn) => fn === pageMeasureStartup`).
 * @param {(info: {page: object, url: string, index: number,
 *   stepResult: unknown}) => {directory: string, name: string, meta?: object}}
 *   args.destination Where each profile is written.
 * @param {number} [args.samplingIntervalUs]
 * @param {number} [args.spinMs]
 * @returns {{records: object[], restore: () => void}} `records` gains one
 *   entry per profiled page; `restore` puts the browser's `newContext` back.
 */
export function installStartupCpuProfiles({
  browser,
  isStopStep,
  destination,
  samplingIntervalUs,
  spinMs,
}) {
  const records = [];
  const originalNewContext = browser.newContext;
  let index = 0;
  browser.newContext = async function (...contextArgs) {
    const context = await originalNewContext.apply(browser, contextArgs);
    const originalNewPage = context.newPage;
    context.newPage = async function (...pageArgs) {
      const page = await originalNewPage.apply(context, pageArgs);
      const pageIndex = index++;
      const handle = await startPageCpuProfile(page, { samplingIntervalUs });
      const originalEvaluate = page.evaluate;
      let stopped = false;
      page.evaluate = async function (fn, ...rest) {
        const result = await originalEvaluate.call(page, fn, ...rest);
        if (!stopped && isStopStep(fn)) {
          stopped = true;
          const url = page.url();
          const stop = await stopPageCpuProfile(handle, {
            page,
            spinMs,
            evaluate: (expression) => originalEvaluate.call(page, expression),
          });
          const where = destination({
            page,
            url,
            index: pageIndex,
            stepResult: result,
          });
          const written = writeCpuProfile({
            directory: where.directory,
            name: where.name,
            stopped: stop,
            meta: {
              ...(where.meta ?? {}),
              url,
              samplingIntervalUs: handle.samplingIntervalUs,
              startedAt: handle.startedAt,
              stepResult: result,
            },
          });
          records.push({
            index: pageIndex,
            url,
            ...written,
            calibration: stop.calibration,
            error: stop.error ?? null,
            samples: stop.profile?.samples?.length ?? 0,
          });
        }
        return result;
      };
      return page;
    };
    return context;
  };
  return {
    records,
    restore() {
      browser.newContext = originalNewContext;
    },
  };
}
