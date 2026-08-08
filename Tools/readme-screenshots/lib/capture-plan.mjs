// capture-plan.mjs — the pure, browser-free half of a capture run's SCHEDULE:
// which scenes actually run, how long each one is allowed to take, and how long
// the force-exit watchdog waits before it decides the run is wedged.
//
// WHY THE SCHEDULE IS A MODULE AND NOT INLINE ARITHMETIC. The first real run of
// the capture script ended at a fixed 40-minute watchdog with roughly thirty of
// its thirty-nine scenes never attempted, and the force-exit message said only
// that the watchdog had fired — not which scenes had finished, not which were
// still owed. Both defects are arithmetic over the scene list, so both are
// decided here, where `node --test` can check them without a browser:
//
//   - a watchdog sized from a CONSTANT cannot track a manifest that grows, and
//     silently converts "this run needs longer" into "this run failed";
//   - a re-run that repeats the scenes it already captured spends its whole
//     budget re-proving work that is already on disk.
//
// WHAT COUNTS AS "ALREADY DONE". A zero-byte PNG is what a crashed or killed
// writer leaves behind, so mere existence is not enough — the file has to have
// content. Nor is content enough on its own: the capture script writes a PNG on
// every attempt, including the attempts that miss their pixel thresholds, so a
// failing image is on disk too. When the previous run left a report, the scenes
// it recorded as not-OK are re-captured regardless of what is on disk; skipping
// them would pin a known-bad picture in the README permanently.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Wall-clock a single scene may consume before the driver moves on. */
export const DEFAULT_SCENE_BUDGET_MS = 90_000;

/**
 * Per-scene cost the budget does NOT cover: browser-context creation, the
 * navigation itself, PNG encode/decode and the GPU-error flush. Held separate
 * so the budget stays a statement about the SCENE rather than about Playwright.
 */
export const DEFAULT_SCENE_OVERHEAD_MS = 15_000;

/** One-off cost before the first scene: browser launch and the manifest audit. */
export const DEFAULT_STARTUP_MS = 60_000;

/**
 * Ceiling no computed watchdog may exceed. A manifest that grows without bound
 * must not be able to buy itself an unbounded run.
 */
export const DEFAULT_WATCHDOG_CAP_MS = 5_400_000;

/** Floor, so a one-scene run still gets a usable window. */
export const MIN_WATCHDOG_MS = 120_000;

const positive = (value, fallback) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;

/**
 * Size the force-exit watchdog from the work actually scheduled.
 *
 * @param {object} options Sizing inputs.
 * @param {number} options.sceneCount Scenes that will actually run.
 * @param {number} [options.sceneBudgetMs] Per-scene wall-clock allowance.
 * @param {number} [options.sceneOverheadMs] Per-scene cost outside the budget.
 * @param {number} [options.startupMs] One-off cost before the first scene.
 * @param {number} [options.capMs] Hard ceiling.
 * @returns {number} Watchdog delay in milliseconds.
 */
export function computeWatchdogMs({
  sceneCount,
  sceneBudgetMs = DEFAULT_SCENE_BUDGET_MS,
  sceneOverheadMs = DEFAULT_SCENE_OVERHEAD_MS,
  startupMs = DEFAULT_STARTUP_MS,
  capMs = DEFAULT_WATCHDOG_CAP_MS,
} = {}) {
  const count = Math.max(
    0,
    Number.isFinite(sceneCount) ? Math.trunc(sceneCount) : 0,
  );
  const perScene =
    positive(sceneBudgetMs, DEFAULT_SCENE_BUDGET_MS) +
    positive(sceneOverheadMs, DEFAULT_SCENE_OVERHEAD_MS);
  const raw = positive(startupMs, DEFAULT_STARTUP_MS) + count * perScene;
  const cap = positive(capMs, DEFAULT_WATCHDOG_CAP_MS);
  return Math.max(MIN_WATCHDOG_MS, Math.min(cap, raw));
}

/**
 * Byte size of a file, or 0 when it is absent or unreadable.
 *
 * @param {string} path Absolute file path.
 * @returns {number} Size in bytes.
 */
export function fileSize(path) {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Scene ids the previous run's report recorded as anything other than OK.
 *
 * An absent or unparseable report yields an empty set: no evidence is not the
 * same as evidence of success, but it is also not grounds to re-capture a whole
 * manifest, and `--force` covers that case explicitly.
 *
 * @param {string} reportPath Absolute path to the previous run's JSON report.
 * @returns {Set<string>} Ids that must be re-captured despite an existing PNG.
 */
export function readPriorFailures(reportPath) {
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const failures = new Set();
    for (const record of report?.results ?? []) {
      if (typeof record?.id === "string" && record.ok !== true) {
        failures.add(record.id);
      }
    }
    return failures;
  } catch {
    return new Set();
  }
}

/**
 * Decide which scenes run this time.
 *
 * `--only` is an explicit request for one scene, so it always re-captures:
 * asking for a specific image and being told it already exists is not a useful
 * answer. Skipping applies to the unfiltered run, which is the one that has to
 * survive being interrupted.
 *
 * @param {object} options Planning inputs.
 * @param {object[]} options.scenes All validated manifest scenes.
 * @param {string|null} [options.only] Single scene id, or null for all.
 * @param {boolean} [options.skipExisting] Skip scenes whose PNG is already sized.
 * @param {string} [options.outDir] Absolute output directory.
 * @param {Set<string>} [options.priorFailures] Ids a previous run recorded as not OK.
 * @param {(path: string) => number} [options.sizeOf] Size probe, injectable for tests.
 * @returns {{run: object[], skipped: object[], errors: string[]}} The plan.
 */
export function planRun({
  scenes,
  only = null,
  skipExisting = false,
  outDir = "",
  priorFailures = new Set(),
  sizeOf = fileSize,
}) {
  const errors = [];
  const selected =
    only === null ? [...scenes] : scenes.filter((scene) => scene.id === only);
  if (only !== null && selected.length === 0) {
    errors.push(`--only "${only}" matches no scene. Run --list.`);
    return { run: [], skipped: [], errors };
  }
  if (only !== null || !skipExisting) {
    return { run: selected, skipped: [], errors };
  }

  const run = [];
  const skipped = [];
  for (const scene of selected) {
    const bytes = sizeOf(join(outDir, scene.output));
    if (bytes > 0 && !priorFailures.has(scene.id)) {
      skipped.push({ ...scene, existingBytes: bytes });
    } else {
      run.push(scene);
    }
  }
  return { run, skipped, errors };
}

/**
 * Human-readable account of a run at the moment it is cut short.
 *
 * The watchdog's job is not only to end the process; it is to leave behind
 * enough state that the next invocation knows what it still owes. A message
 * that says only "watchdog fired" forces a full re-run to find out.
 *
 * @param {object} options Progress inputs.
 * @param {object[]} options.planned Scenes this run intended to capture.
 * @param {object[]} [options.results] Per-scene records accumulated so far.
 * @param {object[]} [options.skipped] Scenes skipped because their PNG existed.
 * @returns {string[]} Report lines, in print order.
 */
export function describeProgress({ planned, results = [], skipped = [] }) {
  const byId = new Map(results.map((record) => [record.id, record]));
  const done = [];
  const failed = [];
  const remaining = [];
  for (const scene of planned) {
    const record = byId.get(scene.id);
    if (record === undefined) {
      remaining.push(scene.id);
    } else if (record.ok === true) {
      done.push(scene.id);
    } else {
      failed.push(scene.id);
    }
  }
  const lines = [
    `captured ${done.length}/${planned.length}${skipped.length > 0 ? ` (+${skipped.length} skipped as already present)` : ""}`,
  ];
  if (done.length > 0) {
    lines.push(`  captured: ${done.join(", ")}`);
  }
  if (failed.length > 0) {
    lines.push(`  attempted but not OK: ${failed.join(", ")}`);
  }
  if (remaining.length > 0) {
    lines.push(
      `  NEVER ATTEMPTED (${remaining.length}): ${remaining.join(", ")}`,
    );
    lines.push(
      "  re-run the same command — scenes with a PNG already on disk are skipped by default",
    );
  }
  return lines;
}
