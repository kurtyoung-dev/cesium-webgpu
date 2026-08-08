/**
 * REFRESH-SKIP AWARENESS — the shared, enforceable home for one class defect
 * that made THREE cloud-lane probe windows lie on the same day.
 *
 * ── THE MECHANISM, TRACED ────────────────────────────────────────────────────
 *
 * `Apps/CesiumViewer/index.html?offline=true` resolves through
 * `CesiumViewerStartupOptions.js`, which sets **`requestRenderMode: true`**.
 * `Scene#maximumRenderTimeChange` keeps its `0.0` default, and every probe in
 * this lane pins the clock, so `JulianDate.secondsDifference` is exactly 0 and
 * the time-based wake never fires. `Scene.prototype.render` therefore computes
 *
 *     shouldRender = !requestRenderMode || _renderRequested || cameraChanged
 *                    || _logDepthBufferDirty || _hdrDirty || MORPHING
 *                    || pendingAsyncResources > 0
 *
 * and, once the scene is quiescent, evaluates it FALSE. A `scene.render(t)`
 * call on such a frame returns having executed no command list: no cloud
 * `executeProceduralClouds`, so no `resetCloudFrameCounters`, so **no new
 * published snapshot**. The statistics surface keeps handing back the last
 * frame that really ran.
 *
 * Before Batch 942 the temporal resolve was dead (five cloud shader sites
 * compiled raw ifdef-bearing WGSL), the cloud lane never converged, and
 * something kept asking for frames — so every probe window in this lane was
 * accidentally live and every bound was accidentally sound. Batch 942 restored
 * the resolve. The lane now settles, and every window in both cloud
 * reconstruction probes that counted RENDER CALLS started counting no-ops:
 *
 *   * `probe-cloud-reconstruction-attachments.mjs` — the publish-lag window
 *     (4 calls) and the release window (8 calls) expired without a single
 *     execute, so `bLiveBytesExact`, `selfHealingReleaseOnDisable` and
 *     `aLiveBytesZeroBeforeToggle` went red against a FROZEN snapshot. Worse,
 *     the byte-identity captures `c1 === c2 === c3` were green VACUOUSLY:
 *     nothing rendered between them.
 *   * `probe-cloud-reconstruction-consume.mjs` — leg D's ten windows reported
 *     `attemptedFrameCount: 0` (the profiler was armed and simply never saw a
 *     frame), and exactly the five A-windows "held their arm" because the
 *     frozen snapshot happened to be an A-state snapshot.
 *
 * ── THE TWO REPAIRS THIS MODULE ENCODES ──────────────────────────────────────
 *
 * 1. KEEP-LIVE. Call `scene.requestRender()` immediately before every
 *    `scene.render(t)` inside a measured or verified span. This is the minimal
 *    possible invalidation: `requestRender()` sets `_renderRequested = true`
 *    and, only when snapshot mode is FROZEN, marks that snapshot dirty — and
 *    `SnapshotModeService` is disabled by default, which the probes assert
 *    rather than assume. The flag is read by the `shouldRender` gate and
 *    cleared at the top of the rendered frame; it reaches no uniform, no
 *    pipeline key, and no pass-encode decision. So the SET of GPU passes
 *    encoded on a rendered frame is identical whether that frame was requested
 *    explicitly or by the engine's own dirty state — keep-live changes only
 *    WHETHER the frame renders, never WHAT it renders. It is exactly what the
 *    shipped `CesiumWidget` render loop achieves at 60 Hz outside
 *    `requestRenderMode`, and it is equivalent to `scene.forceRender(t)`
 *    (whose whole body is `_renderRequested = true; this.render(time)`).
 *
 *    Rejected alternatives, recorded so the choice is auditable:
 *      - nudging the camera — changes the view matrix, the motion vectors and
 *        the history reprojection, i.e. precisely what is being timed;
 *      - advancing the clock — `cloud.time` reaches the density field as
 *        `windDirection * windSpeed * time`, so it changes the march itself,
 *        and it breaks the pinned-clock rule the whole fleet runs under;
 *      - `scene.requestRenderMode = false` — gate-equivalent, but a global
 *        fixture change that outlives the span it was needed for. A per-render
 *        call is scoped to exactly the spans that declare it.
 *
 * 2. EXECUTE-COUNTED BOUNDS. A window's budget is denominated in ENGINE
 *    EXECUTES, read from the cloud snapshot's own lifetime counter
 *    (`volumetricClouds.frames`, bumped by `resetCloudFrameCounters` on every
 *    `executeProceduralClouds` including culled ones). A render-call budget
 *    survives alongside it purely as a loop bound, and the two outcomes are
 *    kept DISTINCT: a window that burned its executes and still did not see its
 *    condition EXPIRED (a real negative, which belongs to a predicate), while a
 *    window that burned its render calls without earning its executes was
 *    STARVED (structural — the instrument never got to look).
 *
 * Pure functions only: no Playwright, no fs, no engine import. The spec runs
 * them directly, and against their own mutants.
 */

/**
 * The cloud snapshot field that counts ENGINE EXECUTES.
 *
 * `resetCloudFrameCounters` increments it at the top of every
 * `executeProceduralClouds`, before the frustum-cull early return, so it
 * advances on exactly the frames the cloud lane actually ran and on no others.
 * That makes it the only honest denominator for a cloud-probe window.
 */
export const EXECUTE_COUNTER_FIELD = "frames";

/**
 * Bounds, derived rather than chosen.
 *
 * `renderCallsPerExecute` — with keep-live in place one render call yields one
 * execute, so this multiplier is pure margin. The one observed consumer of a
 * call that does NOT produce an execute is the frame after a viewport change:
 * `Viewer.prototype.resize` runs on `scene.postUpdate` (which fires OUTSIDE the
 * `shouldRender` block), reconfigures the canvas and calls `requestRender()` —
 * so that call lands on the NEXT frame. Observed cost: exactly 1 call per
 * resize. 4x is four times the observed worst case.
 *
 * `minRenderCalls` — a floor so a 1-execute window still has room for that
 * resize frame plus slack.
 *
 * `publishLagExecutes` — the C13-09 certified run (Batch 936) measured the
 * resident-counter publish lag at 1-2 executes (`attachmentLiveBytes` is
 * assigned during pack, before `ensureCloudAttachmentResources` runs, so a
 * newly created set publishes its bytes on the FOLLOWING execute). 4 is 2x the
 * observed maximum, and is the same number the certified run used — what
 * changes here is only its UNIT, from render calls to executes.
 *
 * `stationarityGapExecutes` / `stationarityMaxRounds` — the gap is the 8-frame
 * separation the C13-09 stationarity precondition already used; the rounds
 * bound turns "assume it converged" into "observe that it converged, or say it
 * did not", at a worst case of 64 executes per captured state.
 */
export const REFRESH_SKIP_BOUNDS = Object.freeze({
  renderCallsPerExecute: 4,
  minRenderCalls: 8,
  publishLagExecutes: 4,
  stationarityGapExecutes: 8,
  stationarityMaxRounds: 8,
});

/** A window that saw its condition. */
export const WINDOW_ARRIVED = "arrived";
/** A window that spent its full EXECUTE budget without seeing its condition. */
export const WINDOW_EXPIRED = "expired";
/** A window that ran out of RENDER CALLS before earning its executes. */
export const WINDOW_STARVED = "starved";

/**
 * Loop bound in render calls for a window denominated in executes.
 *
 * @param {number} executeBudget Executes the window is allowed to consume.
 * @param {{renderCallsPerExecute: number, minRenderCalls: number}} [bounds]
 * @returns {number} Render-call bound (always >= the execute budget).
 */
export function renderCallBudget(executeBudget, bounds = REFRESH_SKIP_BOUNDS) {
  const executes = Math.max(1, Math.floor(Number(executeBudget) || 0));
  return Math.max(
    bounds.minRenderCalls,
    executes * bounds.renderCallsPerExecute,
  );
}

/**
 * Classify one bounded window.
 *
 * ★ STARVED IS NOT EXPIRED. An expired window is EVIDENCE — the lane ran its
 * whole budget and the condition never held, which is exactly the shape of a
 * real engine finding. A starved window is the ABSENCE of evidence — the lane
 * never ran, so nothing was observed either way. Collapsing them is how the
 * Batch-944 leg-C tier round-trip acquired a finding it had not earned: its
 * 90-render-call window contained an unknown (possibly zero) number of
 * executes, and the probe reported "did not re-engage within 90 frames".
 *
 * @param {{conditionMet: boolean, executesRun: number, renderCalls: number,
 *   executeBudget: number, renderCallBudget: number}} window Window counts.
 * @returns {{outcome: string, starved: boolean, arrived: boolean,
 *   executesRun: number, executeBudget: number, renderCalls: number}} Verdict.
 */
export function classifyExecuteWindow(window) {
  const executesRun = Number(window?.executesRun);
  const renderCalls = Number(window?.renderCalls);
  const executeBudget = Number(window?.executeBudget);
  const callBudget = Number(window?.renderCallBudget);
  const safe = (v) => (Number.isFinite(v) ? v : 0);
  const base = {
    executesRun: safe(executesRun),
    executeBudget: safe(executeBudget),
    renderCalls: safe(renderCalls),
    renderCallBudget: safe(callBudget),
  };
  if (window?.conditionMet === true) {
    return { ...base, outcome: WINDOW_ARRIVED, starved: false, arrived: true };
  }
  if (safe(executesRun) >= safe(executeBudget) && safe(executeBudget) > 0) {
    return { ...base, outcome: WINDOW_EXPIRED, starved: false, arrived: false };
  }
  return { ...base, outcome: WINDOW_STARVED, starved: true, arrived: false };
}

/**
 * Structural reasons for every STARVED window — and for no other outcome.
 *
 * @param {{label: string, outcome: string, executesRun: number,
 *   executeBudget: number, renderCalls: number,
 *   renderCallBudget: number}[]} windows Classified windows.
 * @returns {string[]} One named reason per starved window.
 */
export function starvedWindowReasons(windows) {
  const list = Array.isArray(windows) ? windows : [];
  return list
    .filter((w) => w?.outcome === WINDOW_STARVED)
    .map(
      (w) =>
        `REFRESH-SKIP STARVED "${w.label}" — only ${w.executesRun} of ${w.executeBudget} engine executes in ${w.renderCalls}/${w.renderCallBudget} render calls; the lane was refresh-skipped and NOTHING was observed either way`,
    );
}

/**
 * Fold a set of stationarity captures.
 *
 * A capture is stationary when two screenshots taken `gapExecutes` REAL
 * executes apart are byte-equal. Until that holds for a given state, that
 * state's screenshot is a point on a convergence curve and every pixel diff
 * taken against it measures convergence phase, not the change under test.
 *
 * ★ ANTI-VACUITY. `executesObserved` must be positive. Two byte-equal captures
 * separated by zero executes prove nothing at all — that is the exact shape the
 * survival probe's `c1 === c2 === c3` had on the resolve-alive build.
 *
 * @param {{label: string, stationary: boolean, rounds: object[],
 *   executesObserved: number}[]} captures Capture records.
 * @returns {{ok: boolean, reasons: string[],
 *   stationary: Record<string, boolean>}} Fold.
 */
export function foldStationarity(captures) {
  const list = Array.isArray(captures) ? captures : [];
  const reasons = [];
  const stationary = {};
  for (const capture of list) {
    const label = String(capture?.label ?? "(unlabelled)");
    const executes = Number(capture?.executesObserved);
    const vacuous = !Number.isFinite(executes) || executes <= 0;
    const ok = capture?.stationary === true && !vacuous;
    stationary[label] = ok;
    if (vacuous) {
      reasons.push(
        `STATIONARITY VACUOUS "${label}" — the captures are separated by ${Number.isFinite(executes) ? executes : "no"} engine executes, so their byte-equality is not evidence`,
      );
      continue;
    }
    if (capture?.stationary !== true) {
      reasons.push(
        `STATIONARITY NOT REACHED "${label}" — ${Array.isArray(capture?.rounds) ? capture.rounds.length : 0} rounds of ${executes} executes never produced two byte-equal captures; this state's pixel diffs are NOT interpretable`,
      );
    }
  }
  return { ok: reasons.length === 0, reasons, stationary };
}

/**
 * Is a diff between two captured states interpretable?
 *
 * Both endpoints must be stationary. A diff with one converged endpoint and one
 * mid-convergence endpoint reads the convergence gap as signal — which is how
 * the Batch-944 run produced an `off -> attachments` figure of 34.5% against a
 * same-state floor of 0.0000%.
 *
 * @param {Record<string, boolean>} stationary Fold output.
 * @param {string} a First state label.
 * @param {string} b Second state label.
 * @returns {boolean} True when both endpoints converged.
 */
export function diffInterpretable(stationary, a, b) {
  return stationary?.[a] === true && stationary?.[b] === true;
}

/**
 * Every `scene.render(` site in probe source that is NOT kept live.
 *
 * The rule cannot live inside the probe: a `page.evaluate` closure is shipped
 * to the browser as text and can never be run against its own mutant. So the
 * rule is a source scan, and the scan is a pure function the spec can mutate.
 *
 * @param {string} code Comment- and string-blanked probe source.
 * @returns {{index: number, before: string}[]} Offending call sites.
 */
export function unlivenedRenderSites(code) {
  const text = String(code ?? "");
  const sites = [];
  const re = /\bscene\s*\.\s*render\s*\(/g;
  let match;
  let guard = 0;
  while ((match = re.exec(text)) !== null && guard++ < 10000) {
    const before = text.slice(Math.max(0, match.index - 120), match.index);
    if (!/requestRender\s*\(\s*\)\s*;\s*$/.test(before)) {
      sites.push({ index: match.index, before: before.slice(-60) });
    }
  }
  return sites;
}
