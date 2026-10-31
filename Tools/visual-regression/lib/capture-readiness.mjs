// capture-readiness.mjs — how a cell decides its page is ready to be photographed.
//
// @purpose Readiness piece of capture.mjs: pollReadiness (the bounded wait for the page's readiness predicates), describeReadiness, decideCellReadinessRefusal (the named refusal when the budget runs out), waitForCellReadiness (the in-page sample, the settle and the poll) and summariseCellReadiness (the record a cell carries).
// @status ACTIVE
//
// WHY A PIECE. The readiness wait moved out of `capture.mjs` when that module
// passed 1,000 lines (DX-KIT-CAPTURE-SEAM-OVER-SIZE). `capture.mjs`
// re-exports every name, so importers are unchanged.

import { acceptedDecision, refusedDecision } from "./probe-refusal.mjs";
import { decideRenderReadyRefusal } from "./probe-runtime.mjs";
import {
  DEFAULT_READINESS_POLL_INTERVAL_MS,
  MAX_READINESS_POLLS,
  READINESS_PREDICATES,
  requireTimingMs,
} from "./capture-vocabulary.mjs";

/**
 * Whether one readiness predicate is satisfied. `null` is "this page has no
 * such subsystem" and satisfies; `undefined` is "the page did not answer" and
 * does not.
 *
 * @param {unknown} value The observed value.
 * @returns {boolean} Whether it counts as ready.
 */
function readinessSatisfied(value) {
  return value === true || value === null;
}

/**
 * One predicate's observed value, preserving the `null`/`undefined`
 * distinction that {@link readinessSatisfied} turns on.
 *
 * @param {object|null|undefined} observed The observation.
 * @param {string} name The predicate.
 * @returns {unknown} The value, or `undefined` when there is no observation.
 */
function readAt(observed, name) {
  if (observed === null || typeof observed !== "object") {
    return undefined;
  }
  return observed[name];
}

/**
 * Re-read the readiness predicates until they all hold, the budget runs out,
 * or the poll count derived from the budget is exhausted.
 *
 * Pure but for its three injected seams, so the whole late-ready behaviour is
 * spec-drivable without a browser: `sample` returns one observation, `now` is
 * the clock, `sleep` is the wait between polls.
 *
 * THE POLL COUNT IS BOUNDED AS WELL AS THE CLOCK, AND BOTH BUDGETS ARE
 * VALIDATED FIRST. A spec (or a stopped debugger) whose clock does not advance
 * must still terminate, and "spin forever against a frozen clock" is not a
 * failure mode worth shipping to find out about. The derived bound is not
 * sufficient on its own: it is arithmetic on `timeoutMs` and `pollIntervalMs`,
 * so `Infinity` derives `Infinity` and `NaN` derives a bound no comparison can
 * ever satisfy. Both arguments therefore go through
 * {@link requireTimingMs} — a named refusal, before the first sample — and the
 * derived bound is additionally capped at {@link MAX_READINESS_POLLS}.
 *
 * `elapsedMs` MAY EXCEED `timeoutMs`, BY UP TO ONE POLL, BY DESIGN. The budget
 * is tested AFTER a sample returns, because a sample in flight cannot be
 * abandoned: one `page.evaluate` round trip against a loaded machine measured
 * ~700 ms on the Edge leg, so a 3,000 ms budget reported 4,289 ms spent. The
 * overshoot is bounded by exactly one sample, and both numbers are reported —
 * see the receipt's `elapsedMsAfterFinalPoll`, whose name says which of the
 * two it is.
 *
 * @param {object} options Options.
 * @param {() => Promise<object>} options.sample Reads one observation.
 * @param {() => number} options.now Clock, in milliseconds.
 * @param {(ms: number) => Promise<void>} options.sleep Waits between polls.
 * @param {number} options.timeoutMs Whole-poll budget.
 * @param {number} options.pollIntervalMs Gap between polls.
 * @param {string[]} [options.predicates] Defaults to {@link READINESS_PREDICATES}.
 * @returns {Promise<{ready: boolean, polls: number, elapsedMs: number,
 *   timeoutMs: number, unmet: string[], lastUnmet: string[],
 *   observed: object|null}>} The outcome. `lastUnmet` is the unmet set from
 *   the last poll that had one — on a cell that became ready it is what the
 *   poll before the successful one was still waiting for, and `[]` when the
 *   first sample already held.
 * @throws {ProbeRefusal} `capture-timing-option-invalid` for a budget or an
 *   interval that is not a positive safe integer within the sane maximum.
 */
export async function pollReadiness({
  sample,
  now,
  sleep,
  timeoutMs,
  pollIntervalMs,
  predicates = READINESS_PREDICATES,
}) {
  requireTimingMs("readinessTimeoutMs", timeoutMs);
  requireTimingMs("readinessPollIntervalMs", pollIntervalMs);
  const started = now();
  const interval = Math.max(1, pollIntervalMs);
  // The DERIVED bound is arithmetic on two caller-supplied numbers, so it is
  // only as sound as they are. `requireTimingMs` above has already refused an
  // unsound pair — this second line is the one that holds if that refusal is
  // ever removed or bypassed, because an unrepresentable derived bound falls
  // back to the STATED one rather than to a comparison nothing satisfies.
  const derived = Math.ceil(timeoutMs / interval) + 1;
  const maxPolls = Number.isSafeInteger(derived)
    ? Math.min(MAX_READINESS_POLLS, Math.max(1, derived))
    : MAX_READINESS_POLLS;
  let polls = 0;
  let lastUnmet = [];

  for (;;) {
    const observed = await sample();
    polls += 1;
    // Read the property, never `?? undefined`: `null` is a MEANINGFUL answer
    // here ("this page has no globe to wait for") and the nullish coalescing
    // that looks harmless collapses it into the absent case.
    const unmet = predicates.filter(
      (name) => !readinessSatisfied(readAt(observed, name)),
    );
    const elapsedMs = now() - started;
    if (unmet.length === 0) {
      return {
        ready: true,
        polls,
        elapsedMs,
        timeoutMs,
        unmet,
        lastUnmet,
        observed,
      };
    }
    lastUnmet = unmet;
    if (elapsedMs >= timeoutMs || polls >= maxPolls) {
      return {
        ready: false,
        polls,
        elapsedMs,
        timeoutMs,
        unmet,
        lastUnmet,
        observed,
      };
    }
    await sleep(Math.min(interval, Math.max(1, timeoutMs - elapsedMs)));
  }
}

/**
 * A one-line diagnosis of a readiness outcome, for the refusal's message.
 *
 * @param {object} readiness A {@link waitForCellReadiness} result.
 * @returns {string} The diagnosis.
 */
export function describeReadiness(readiness) {
  const unmet = (readiness?.unmet ?? []).join(", ") || "none";
  const observed = JSON.stringify(readiness?.observed ?? null);
  return `unmet ${unmet} after ${readiness?.polls ?? 0} polls over ${readiness?.elapsedMs ?? 0} ms of a ${readiness?.timeoutMs ?? 0} ms budget (phase ${readiness?.phase ?? "unknown"}, last observed ${observed})`;
}

/**
 * The refusal a cell that never became ready produces.
 *
 * The runtime's `decideRenderReadyRefusal` still answers the `renderReady`
 * question — this composes it rather than re-implementing it — and the capture
 * layer adds what the runtime has no way to know: WHICH predicate was still
 * false, what was last observed, and how many polls over how long. A timeout
 * is a REFUSAL (exit 3), never a skipped cell: an UNMEASURED cell in the
 * manifest means "this rig declares no page for this renderer", and a scene
 * that simply needed longer must not be recorded as if the renderer were
 * missing.
 *
 * @param {object} readiness A {@link waitForCellReadiness} result.
 * @returns {object} An accepted or refusing decision.
 */
export function decideCellReadinessRefusal(readiness) {
  if (readiness?.ready === true) {
    return acceptedDecision();
  }
  const runtime = decideRenderReadyRefusal({
    renderReady: readiness?.observed?.renderReady,
    elapsedMs: readiness?.elapsedMs,
    timeoutMs: readiness?.timeoutMs,
  });
  return refusedDecision("capture-cell-not-ready", {
    runtimeReason: runtime.refuse === true ? runtime.reason : "predicate-unmet",
    unmet: [...(readiness?.unmet ?? [])],
    observed: readiness?.observed ?? null,
    polls: readiness?.polls ?? 0,
    phase: readiness?.phase ?? "unknown",
    elapsedMs: readiness?.elapsedMs ?? 0,
    timeoutMs: readiness?.timeoutMs ?? 0,
  });
}

function readCellReadiness(page, cell) {
  return page.evaluate((renderer) => {
    const viewer =
      window.viewer ??
      (renderer === "webgl" ? window.webglViewer : window.webgpuViewer);
    const scene = viewer?.scene;
    return {
      viewerPresent: !!scene,
      renderReady: scene?.renderReady,
      // `null` = this page has no globe to wait for, which satisfies the
      // predicate; `undefined` = the page did not answer, which does not.
      tilesLoaded: scene?.globe ? scene.globe.tilesLoaded === true : null,
    };
  }, cell.renderer);
}

/**
 * Wait for a cell to be capturable: poll the readiness predicates, then apply
 * the rig's settle, then re-read them once more.
 *
 * The final re-read is not redundant. The settle exists because a scene that
 * has just become ready is still converging, and a scene that STOPS being
 * ready during it (a new tile request, a pipeline rebuild) would otherwise be
 * captured mid-flight with the poll's stale `true` as the evidence.
 *
 * @param {object} page The page.
 * @param {object} cell The descriptor cell.
 * @param {() => number} [now] Clock.
 * @param {{sleep?: Function, sample?: Function}} [dependencies] Seams; the
 *   defaults read the real page.
 * @returns {Promise<object>} `{ready, renderReady, observed, unmet, polls,
 *   elapsedMs, timeoutMs, phase}`.
 */
export async function waitForCellReadiness(
  page,
  cell,
  now = Date.now,
  dependencies = {},
) {
  const started = now();
  const timeoutMs = cell.readinessTimeoutMs;
  const predicates = cell.readinessPredicates ?? READINESS_PREDICATES;
  const sleep = dependencies.sleep ?? ((ms) => page.waitForTimeout(ms));
  const sample = dependencies.sample ?? (() => readCellReadiness(page, cell));

  if (cell.pageKind === "split-screen") {
    // The split-screen page gates viewer creation behind a button so a human
    // chooses when two WebGPU adapters come up; automation clicks it, exactly
    // as `capture-and-diff.mjs:823-824` does.
    await page.waitForSelector("#btnLaunch", { timeout: timeoutMs });
    await page.click("#btnLaunch");
    await page.waitForFunction(
      () => !!(window.webglViewer && window.webgpuViewer),
      null,
      { timeout: timeoutMs },
    );
    await page.evaluate((renderer) => {
      const viewer =
        renderer === "webgl" ? window.webglViewer : window.webgpuViewer;
      const canvas = viewer?.scene?.canvas;
      if (!canvas) {
        throw new Error(`split-screen ${renderer} viewer exposes no canvas`);
      }
      canvas.setAttribute("data-vr-tag", renderer);
    }, cell.renderer);
  } else {
    await page.waitForFunction(() => !!window.viewer?.scene, null, {
      timeout: timeoutMs,
    });
  }

  const polled = await pollReadiness({
    sample,
    now,
    sleep,
    timeoutMs,
    pollIntervalMs:
      cell.readinessPollIntervalMs ?? DEFAULT_READINESS_POLL_INTERVAL_MS,
    predicates,
  });
  if (!polled.ready) {
    return {
      ...polled,
      renderReady: polled.observed?.renderReady,
      elapsedMs: now() - started,
      phase: "poll",
    };
  }

  await settleCell(page, cell);

  const observed = await sample();
  const unmet = predicates.filter(
    (name) => !readinessSatisfied(readAt(observed, name)),
  );
  return {
    ready: unmet.length === 0,
    renderReady: observed?.renderReady,
    observed,
    unmet,
    // What the poll was still waiting for on its last unsatisfied sample. On
    // the SUCCESS path this is the only record of why readiness took as long
    // as it did, and it is what `summariseCellReadiness` banks.
    lastUnmet: unmet.length === 0 ? polled.lastUnmet : unmet,
    polls: polled.polls + 1,
    elapsedMs: now() - started,
    timeoutMs,
    phase: unmet.length === 0 ? "settled" : "settle",
  };
}

/**
 * The readiness facts a SUCCESSFUL cell banks in the capture receipt.
 *
 * WHY THE SUCCESS PATH NEEDS THIS AT ALL. Until now `polls`, the elapsed time
 * and the last unmet predicate reached a caller only through
 * {@link decideCellReadinessRefusal} — i.e. only when the cell FAILED. A green
 * capture recorded none of it, so the Edge leg of 2026-09-19, asked how long
 * readiness took and on what, had to wrap `dependencies.now` in a recorder and
 * segment its call trace at each cell's `capturedAt`. An executor should be
 * able to quote the number, not infer it. It is banked in the RECEIPT and not
 * in the manifest deliberately: the manifest is the contact sheet's input and
 * its bytes are the sheet's identity, and a timing that differs run to run has
 * no business moving a page's md5.
 *
 * @param {object|null|undefined} readiness A {@link waitForCellReadiness} result.
 * @returns {{polls: number, elapsedMsAfterFinalPoll: number, budgetMs: number,
 *   phase: string, lastUnmet: string}|null} The summary, or `null` when the
 *   cell body reported no readiness at all (an injected `cellWork`).
 */
export function summariseCellReadiness(readiness) {
  if (readiness === null || typeof readiness !== "object") {
    return null;
  }
  const lastUnmet = [...(readiness.lastUnmet ?? readiness.unmet ?? [])];
  return {
    polls: readiness.polls ?? 0,
    // NOT `elapsedMs`. The budget is tested after a sample returns, so this
    // number may exceed `budgetMs` by up to one poll — see `pollReadiness`.
    // The field is named for the instant it is read at so nobody reads an
    // overshoot as a bug.
    elapsedMsAfterFinalPoll: readiness.elapsedMs ?? 0,
    budgetMs: readiness.timeoutMs ?? 0,
    phase: readiness.phase ?? "unknown",
    lastUnmet: lastUnmet.length > 0 ? lastUnmet.join(", ") : "none",
  };
}

async function settleCell(page, cell) {
  if (cell.readiness?.kind === "settleMs") {
    await page.waitForTimeout(cell.readiness.ms);
    return;
  }
  await page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        let count = 0;
        const tick = () => {
          if (count++ >= frames) {
            resolve();
          } else {
            requestAnimationFrame(tick);
          }
        };
        tick();
      }),
    cell.readiness?.frames ?? 1,
  );
}
