/**
 * PF-3, startup to the first useful frame and the shader and pipeline compile
 * time, read against the startup ceiling and a pre-registered band.
 * @purpose PF-3 for the R-2026-10-22-3 performance leg: reduces one run's startup record (page timestamps from lib/frame-timing-steps.mjs, relative to navigation start, and the compile tallies of lib/gpu-device-census.mjs) to named intervals and compile totals, and reads base vs tip with the ceiling rule of lib/metrics/perf-band.mjs (every tip repeat under the 2.5 s ceiling and within the band, whose floor for PF-3 is 10 %; a base already at or over the ceiling reads the banded compare alone and is reported) for the startup interval and the band rule for the compile total.
 * @status ACTIVE
 *
 * THE CLOCK. Every page timestamp is `performance.now()` in the page, whose
 * origin is the navigation start of that document. So `firstCloudFrameAtMs`
 * IS the time from navigation to the first frame with clouds drawn, the
 * brief's definition, with no subtraction; the other intervals subtract one
 * page timestamp from another.
 *
 * WHICH INTERVAL THE 2-SECOND REQUIREMENT READS IS A SEAT DECISION, recorded
 * in each verdict as `field`. The brief defines it as navigation to the first
 * frame with clouds drawn (`navigationToFirstCloudFrameMs`, the default); the
 * plan's §2.2 says from viewer construction (`viewerToFirstCloudFrameMs` is
 * the closest observable: from the moment the probe first saw the viewer); a
 * cell with no clouds on either arm has no cloud frame, and its default falls
 * back to `navigationToFirstFrameMs`, which the record says. Navigation
 * includes downloading and parsing the unminified bundle, so on a served
 * development build the navigation intervals can exceed 2 s on both arms; the
 * ceiling rule then admits only tip <= base, and the record flags it.
 *
 * A REPEAT IS NEVER DROPPED. A repeat with no value for the interval the
 * verdict reads is not left out of the median: a tip repeat that ended
 * `deadline`, `frame-cap` or `render-error` without it never reached the
 * first useful frame, which is a failed startup, so the verdict is `over`;
 * a tip repeat missing it for any other reason, or a base repeat missing it,
 * makes the verdict `unmeasured` (Ettenmoors pass 1, D4).
 *
 * COMPILE TIME is what the in-page census measured around the device's own
 * calls: the synchronous time inside `createShaderModule`,
 * `createRenderPipeline` and `createComputePipeline`, plus the time each
 * `create*PipelineAsync` took to settle. Asynchronous compiles overlap, so the
 * summed async time is work, not wall time; `compileSpanMs` (first creation to
 * last settle) is the wall-clock bound and is reported beside it.
 *
 * @module Tools/visual-regression/lib/metrics/startup-compile
 */

import {
  PERF_VERDICTS,
  ceilingVerdict,
  compareToBase,
  guardStatistic,
  worstVerdict,
} from "./perf-band.mjs";

/** The startup intervals a summary carries, in milliseconds. */
export const STARTUP_FIELDS = Object.freeze([
  "navigationToViewerMs",
  "navigationToFirstFrameMs",
  "navigationToFirstCloudFrameMs",
  "viewerToFirstCloudFrameMs",
  "stageToFirstCloudFrameMs",
  "navigationToTilesLoadedMs",
]);

/** The interval the ceiling reads unless the seat names another. */
export const DEFAULT_STARTUP_FIELD = "navigationToFirstCloudFrameMs";

/** The cloudless fallback for {@link DEFAULT_STARTUP_FIELD}. */
export const CLOUDLESS_STARTUP_FIELD = "navigationToFirstFrameMs";

/** The outcomes of a startup run that ended without reaching its goal. */
export const FAILED_STARTUP_OUTCOMES = Object.freeze([
  "deadline",
  "frame-cap",
  "render-error",
]);

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const num = (value) => (isFiniteNumber(value) ? value : null);

const difference = (later, earlier) =>
  isFiniteNumber(later) && isFiniteNumber(earlier) ? later - earlier : null;

const sumOf = (...values) => {
  const finite = values.filter(isFiniteNumber);
  return finite.length === 0 ? null : finite.reduce((a, b) => a + b, 0);
};

/**
 * One run's startup and compile summary.
 *
 * @param {object} raw `{startup: {viewerReadyAtMs, stagedAtMs, firstFrameAtMs,
 *   firstCloudFrameAtMs, tilesLoadedAtMs, outcome}, compile: census.compile}`.
 * @returns {object} The {@link STARTUP_FIELDS} intervals (null when a
 *   timestamp is absent), `outcome`, and `compile`: `{syncMs, asyncMs,
 *   spanMs, totalMs, shaderModules, renderPipelines, computePipelines}`.
 */
export function summarizeStartup(raw) {
  const startup = raw?.startup ?? {};
  const compile = raw?.compile ?? {};
  const viewer = num(startup.viewerReadyAtMs);
  const staged = num(startup.stagedAtMs);
  const firstFrame = num(startup.firstFrameAtMs);
  const firstCloud = num(startup.firstCloudFrameAtMs);
  const tiles = num(startup.tilesLoadedAtMs);
  const syncMs = sumOf(
    compile.shaderModules?.syncMs,
    compile.renderPipelines?.syncMs,
    compile.computePipelines?.syncMs,
  );
  const asyncMs = sumOf(
    compile.renderPipelinesAsync?.totalSettleMs,
    compile.computePipelinesAsync?.totalSettleMs,
  );
  const firstCreate = num(compile.firstCreateAtMs);
  const lastSettle = num(compile.lastSettleAtMs);
  return {
    navigationToViewerMs: viewer,
    navigationToFirstFrameMs: firstFrame,
    navigationToFirstCloudFrameMs: firstCloud,
    viewerToFirstCloudFrameMs: difference(firstCloud, viewer),
    stageToFirstCloudFrameMs: difference(firstCloud, staged),
    navigationToTilesLoadedMs: tiles,
    outcome: startup.outcome ?? null,
    compile: {
      syncMs,
      asyncMs,
      spanMs: difference(lastSettle, firstCreate),
      totalMs: sumOf(syncMs, asyncMs),
      shaderModules: num(compile.shaderModules?.count),
      renderPipelines: sumOf(
        compile.renderPipelines?.count,
        compile.renderPipelinesAsync?.count,
      ),
      computePipelines: sumOf(
        compile.computePipelines?.count,
        compile.computePipelinesAsync?.count,
      ),
    },
  };
}

/**
 * PF-3, base arm against tip arm.
 *
 * @param {object} input
 * @param {object[]} input.baseRuns One raw startup record per base repeat.
 * @param {object[]} input.tipRuns One per tip repeat.
 * @param {object} [input.bands] Pre-registered band overrides (the ceiling is
 *   `startupCeilingMs`).
 * @param {string} [input.field] The interval the ceiling reads; see the module
 *   header. Omitted: {@link DEFAULT_STARTUP_FIELD}, falling back to
 *   {@link CLOUDLESS_STARTUP_FIELD} when no run on either arm drew clouds.
 * @param {object} [input.contention] A `contentionGuard` result for this arm
 *   pair (`lib/metrics/perf-band.mjs`); applied to both statistics after
 *   every other rule, so a contended run never reads `over` either.
 * @returns {{metric: "PF-3", verdict: string, field: string,
 *   fieldFallback: boolean, startup: object, compile: object,
 *   runs: {base: object[], tip: object[]}}}
 */
export function startupVerdict({
  baseRuns,
  tipRuns,
  bands,
  field,
  contention,
}) {
  const base = (Array.isArray(baseRuns) ? baseRuns : []).map(summarizeStartup);
  const tip = (Array.isArray(tipRuns) ? tipRuns : []).map(summarizeStartup);
  let chosen = field ?? DEFAULT_STARTUP_FIELD;
  let fieldFallback = false;
  if (!STARTUP_FIELDS.includes(chosen)) {
    throw new TypeError(
      `PF-3 field ${chosen} is not one of ${STARTUP_FIELDS.join(", ")}`,
    );
  }
  if (
    field === undefined &&
    [...base, ...tip].every((run) => run[DEFAULT_STARTUP_FIELD] === null)
  ) {
    chosen = CLOUDLESS_STARTUP_FIELD;
    fieldFallback = true;
  }
  const startup = ceilingVerdict({
    metric: "PF-3",
    statistic: chosen,
    baseRepeats: base.map((run) => run[chosen]),
    tipRepeats: tip.map((run) => run[chosen]),
    bands,
  });
  const missing = (runs) =>
    runs
      .map((run, index) => ({
        index,
        outcome: run.outcome,
        value: run[chosen],
      }))
      .filter((run) => run.value === null);
  const tipMissing = missing(tip);
  const baseMissing = missing(base);
  const tipFailed = tipMissing.filter((run) =>
    FAILED_STARTUP_OUTCOMES.includes(run.outcome),
  );
  if (tipFailed.length > 0) {
    startup.verdict = PERF_VERDICTS.OVER;
    for (const run of tipFailed) {
      startup.reasons.push(
        `tip repeat ${run.index} ended ${run.outcome} without ${chosen}`,
      );
    }
  }
  const unread = [
    ...tipMissing
      .filter((run) => !FAILED_STARTUP_OUTCOMES.includes(run.outcome))
      .map((run) => `tip repeat ${run.index}`),
    ...baseMissing.map((run) => `base repeat ${run.index}`),
  ];
  if (unread.length > 0 && startup.verdict !== PERF_VERDICTS.OVER) {
    startup.verdict = PERF_VERDICTS.UNMEASURED;
  }
  for (const label of unread) {
    startup.reasons.push(`${label} has no ${chosen}`);
  }
  startup.missingRepeats = { base: baseMissing, tip: tipMissing };
  const compile = compareToBase({
    metric: "PF-3",
    statistic: "compileTotalMs",
    baseRepeats: base.map((run) => run.compile.totalMs),
    tipRepeats: tip.map((run) => run.compile.totalMs),
    bands,
  });
  guardStatistic(startup, contention);
  guardStatistic(compile, contention);
  return {
    metric: "PF-3",
    verdict: worstVerdict([startup, compile]),
    field: chosen,
    fieldFallback,
    startup,
    compile,
    runs: { base, tip },
  };
}
