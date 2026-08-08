/**
 * REFRESH-SKIP AWARENESS — the shared, enforceable home for one class defect
 * that made THREE cloud-lane probe windows lie on the same day, and (§3) for
 * the redesign the FIX to that defect forced on both probes' visual arms.
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
 * ── 3. THE TOLERANCE-BAND REDESIGN THAT REPAIR #1 FORCED ─────────────────────
 *
 * Keep-live fixed the counters and broke the pixels — honestly, and the honesty
 * is the finding. The Batch-953 runs are the evidence: with the lane really
 * executing, NOT ONE of the six captured states in the two probes ever produced
 * two byte-equal screenshots, at 8 rounds of 8 real executes each. The consume
 * probe's own same-state floor read **30.379%** of pixels differing between two
 * captures of the SAME state 8 executes apart, against cross-state figures of
 * 33.403% / 38.559% / 37.764%. The survival probe's same-build cross-page floor
 * read 29.250%.
 *
 * That is not an instrument fault. A half-resolution march with a per-frame
 * ray-jitter sequence feeding a temporal resolve is a DYNAMICAL SYSTEM, and
 * under live execution at a pinned clock it does not converge to a fixed point —
 * it orbits. Byte identity is a test for a fixed point. There is no fixed point
 * to test while the frame executes, so `c1 === c2` is not a demanding test that
 * happens to fail: it is a test of a property the subject does not have.
 *
 * The prior GREENS are what this makes retroactively alarming. Before Batch 942
 * restored the temporal resolve — and before keep-live — those same predicates
 * read green, because the render calls between the captures executed NOTHING.
 * The identity was of a frozen frame with itself. So the byte-identity arm has
 * been either VACUOUSLY GREEN (frozen) or STRUCTURALLY RED (live), and has never
 * once measured pixel-inertness on an executing frame.
 *
 * ── THE REPLACEMENT: A PAIRED SAME-STATE FLUCTUATION BAND ────────────────────
 *
 * If the state orbits, then measure the ORBIT and ask whether the other state
 * sits inside it:
 *
 *   1. Capture a state repeatedly, each capture separated by real executes.
 *      Diff consecutive captures. That set of diffs IS the state's own
 *      frame-to-frame fluctuation distribution — measured in this run, on this
 *      machine, in this session, on this build.
 *   2. Derive a BAND from that distribution (below).
 *   3. A cross-state diff INSIDE the band is not distinguishable from the
 *      state's own fluctuation. A cross-state diff OUTSIDE it is.
 *
 * The construction is PAIRED in two senses, and both matter. The band is drawn
 * from the same page, the same session and the same convergence phase as the
 * comparison it judges — never from a different page, whose temporal history
 * froze different initialization variance permanently. And a cross-state
 * comparison pools the fluctuation of BOTH its endpoint states, because the
 * diff has one endpoint in each; using only one endpoint's fluctuation would
 * understate the baseline whenever the two states orbit differently.
 *
 * ── THE STATISTIC PROFILE: THREE NUMBERS, NOT ONE ────────────────────────────
 *
 * `mismatchFraction` alone — the fraction of pixels differing by ANY amount —
 * is what both probes used, and at a 30% floor it is nearly saturated by
 * low-amplitude dither: a band on it would admit almost any change that does
 * not restructure the image. So the kernel now returns, from ONE pass over the
 * same pixels, three statistics that fail differently:
 *
 *   * `mismatchFraction`     — the FOOTPRINT of the change (delta >= 1 level).
 *   * `coarseFraction`       — the footprint of the change ABOVE the dither
 *                              amplitude (delta > {@link COARSE_DELTA_LEVELS}).
 *   * `meanNormalizedDelta`  — the MAGNITUDE, mean per-pixel max-channel delta
 *                              in units of full scale.
 *
 * A widespread low-amplitude wobble moves the first and barely moves the other
 * two; a structural change to cloud silhouette moves all three. A comparison is
 * INSIDE only when every statistic is inside its own band, and an OUTSIDE
 * verdict names which statistic exceeded and by how much.
 *
 * ── THE BAND RULE, DERIVED ───────────────────────────────────────────────────
 *
 *     upper = max(samples) + (max(samples) - min(samples)) + floor
 *
 * ONE observed range of headroom above the observed maximum. The derivation is
 * the small-sample regime itself: with n around 5 the sample range is a
 * biased-low estimate of the population range, and the minimal non-parametric
 * extrapolation that does not assume a distribution nobody has evidence for is
 * to allow one more range. `floor` is an absolute term so a state that really
 * IS stationary (all samples 0, range 0) yields a tight rather than a
 * zero-width band — see {@link PIXEL_STAT_FLOORS} for each floor's own lineage.
 * FIRST-PASS DERIVED, and labelled as such everywhere it is printed.
 *
 * REJECTED, AND RECORDED SO THE CHOICE IS AUDITABLE:
 *   - A FIXED PERCENTAGE ("within 1%"). Nobody derived it. That is exactly the
 *     failure `cloud-reconstruction-consume-probe.spec.mjs` D3 exists to
 *     prevent, and it would be worse here than there, because the number would
 *     be sitting on top of a 30% floor.
 *   - MEAN + k·SIGMA. At n around 5 the standard deviation is itself noise, and
 *     the rule imports a normality assumption for which there is no evidence.
 *     The range rule uses only order statistics.
 *   - MAX ALONE (zero headroom). Guaranteed red on the first out-of-sample
 *     draw; a bound that the subject's own next frame violates is not a bound.
 *   - A CROSS-PAGE floor as the band source. Per-page fixed points differ
 *     permanently (temporal history freezes initialization variance), so that
 *     band measures page identity, not the flag. It survives only where the
 *     comparison ITSELF is cross-page — the survival probe's cross-build arm,
 *     which therefore gets its own cross-page band.
 *   - RESTORING STATIONARITY by dropping keep-live. That is the Batch-952
 *     defect deliberately reintroduced: the lane stops executing, every counter
 *     freezes, and byte identity becomes vacuous — the exact history above.
 *   - AVERAGING N frames per state and comparing the means. Tempting, and it
 *     does suppress the wobble; but it discards the per-frame spread the band
 *     needs to calibrate itself, it compares an image no viewer ever sees, and
 *     with an orbit of unknown period the mean of 8 frames estimates nothing
 *     stable.
 *   - A PER-PIXEL MIN/MAX ENVELOPE across N same-state frames, requiring the
 *     cross-state frame to lie inside it. Genuinely stronger, and the named
 *     next step if this pass's detection limit proves too coarse. Rejected FOR
 *     THIS PASS because an n-sample envelope under-covers the true fluctuation
 *     by an unknown amount, so it needs a held-out same-state frame to
 *     calibrate — i.e. it needs this same paired construction anyway — while
 *     multiplying the retained-image budget by the number of states.
 *
 * ── ANTI-VACUITY, IN BOTH DIRECTIONS ─────────────────────────────────────────
 *
 * A band can be worthless by being built on nothing, or by being so wide it
 * cannot reject anything. BOTH are named, and neither reads green:
 *
 *   * ZERO EXECUTES. A sample pair separated by no engine executes is two
 *     screenshots of one frozen frame; its diff is 0 and it drags the band's
 *     minimum down, WIDENING the band. Any such sample makes the band not
 *     derivable ({@link deriveFluctuationBand} rejects, named).
 *   * UNDERSAMPLED. Fewer than {@link BAND_BOUNDS}.minSamples pairwise diffs —
 *     no range exists to extrapolate from.
 *   * NOT DISCRIMINATING. The band is calibrated IN-RUN against an injected
 *     control ladder ({@link CONTROL_LADDER}): a declared perturbation is added
 *     to the second image of a real same-state pair — so the control carries
 *     the same fluctuation baseline a cross-state diff does — and at least one
 *     rung must land OUTSIDE the band. If none does, the band admits every
 *     change tested and an INSIDE verdict is NOT evidence.
 *
 * That last rule is what converts "within noise" into a MEASUREMENT. The lowest
 * rung that lands outside is the run's DETECTION LIMIT, and the inertness claim
 * is scoped to exactly it: *the cross-state difference is not distinguishable
 * from this state's own fluctuation, by an instrument demonstrated in this run
 * to detect a perturbation of at least (area A, amplitude B)*. A claim with a
 * stated sensitivity is a result; "within noise" without one is a shrug.
 *
 * ── TIERS ────────────────────────────────────────────────────────────────────
 *
 * Byte identity is not abandoned — it is DEMOTED to the case where it applies.
 * {@link foldPixelInertness} picks, in order:
 *
 *   TIER_STATIONARY — both endpoints reached a byte-stationary fixed point.
 *                     Byte identity is the strongest available test and is used.
 *   TIER_BAND       — the frame executes and does not settle (the live regime).
 *                     The paired band decides, at its measured detection limit.
 *   TIER_NONE       — neither applies. The verdict is NULL and NAMED. It is
 *                     never green, and it is never red either: nothing was
 *                     measured.
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

// ─────────────────────────────────────────────────────────────────────────────
// TOLERANCE BANDS — pixel-inertness for a frame that never stops moving.
// The derivation, and every rejected alternative, is in §3 of the module
// docstring. Nothing below chooses a number without saying where it came from.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three statistics every pixel comparison in this lane reports, in the
 * order they are printed.
 *
 * They fail differently ON PURPOSE. `mismatchFraction` is the footprint of any
 * change at all and saturates under dither (30% in the Batch-953 runs);
 * `coarseFraction` is the footprint ABOVE the dither amplitude;
 * `meanNormalizedDelta` is magnitude and ignores footprint entirely. A band on
 * a single one of them would be a band on whichever failure mode that statistic
 * happens to be blind to.
 */
export const PIXEL_STATISTICS = Object.freeze([
  "mismatchFraction",
  "coarseFraction",
  "meanNormalizedDelta",
]);

/**
 * The amplitude, in 8-bit levels, above which a per-pixel difference counts as
 * COARSE rather than dither.
 *
 * DERIVED from the capture format, not from the scene: 7 levels is ~2.7% of
 * full scale, the point at which a difference stops being attributable to the
 * quantization of a temporally-jittered accumulation and starts being a
 * different colour. Anything <= 7 is admitted to the fine statistic only.
 */
export const COARSE_DELTA_LEVELS = 7;

/**
 * Absolute floors added to every band's upper bound, one per statistic.
 *
 * `mismatchFraction` / `coarseFraction` — 0.001, i.e. one pixel in a thousand.
 * This is not new: it is the same absolute floor the survival probe's
 * cross-build arm has carried since its certified run (`max(2 x floor, 0.1%)`),
 * i.e. the smallest pixel footprint this lane has ever been willing to treat as
 * signal. Reused rather than reinvented so the two arms cannot drift.
 *
 * `meanNormalizedDelta` — 1/255, ONE quantization level of the 8-bit capture.
 * A mean shift below one level cannot be represented in the images being
 * compared, so a band tighter than that would be a bound on rounding.
 */
export const PIXEL_STAT_FLOORS = Object.freeze({
  mismatchFraction: 0.001,
  coarseFraction: 0.001,
  meanNormalizedDelta: 1 / 255,
});

/**
 * Band construction bounds.
 *
 * `minSamples` — 3 pairwise diffs. Two give a range built from a single
 * interval; three is the smallest set in which the range is not simply the
 * distance between the only two points observed.
 *
 * `sampleCap` — keep at most the LAST 6 captures of a state (5 pairwise diffs).
 * The LAST, because a stationarity gate's early rounds are still on the
 * convergence curve; the tail is the closest thing to the orbit. 6 bounds the
 * retained-image budget at a size that stays in memory for every state in a run.
 *
 * `rangeHeadroomMultiple` — 1. One observed range of headroom above the
 * observed maximum; see §3.
 */
export const BAND_BOUNDS = Object.freeze({
  minSamples: 3,
  sampleCap: 6,
  rangeHeadroomMultiple: 1,
});

/** A comparison whose endpoints both reached a byte-stationary fixed point. */
export const TIER_STATIONARY = "stationary";
/** A comparison judged by the paired same-state fluctuation band. */
export const TIER_BAND = "band";
/** A comparison that could not be judged at all. Never green, never red. */
export const TIER_NONE = "none";

/**
 * The in-run control ladder that calibrates a band's DETECTION LIMIT.
 *
 * Each rung is a declared perturbation applied to the SECOND image of a real
 * same-state pair — never to a pristine copy — so the control carries the same
 * fluctuation baseline the cross-state comparison carries. A perturbation added
 * to a zero baseline would answer a different and much easier question.
 *
 * The rungs are ordered by NOMINAL MEAN DELTA (area x amplitude / 255), which
 * is what the magnitude statistic sees, and they trade area against amplitude
 * deliberately: `r4` is the "everything moved slightly" shape that a footprint
 * statistic catches and a magnitude statistic almost misses, `r2` is the
 * "one small region moved a lot" shape with the opposite profile. A ladder of
 * one shape would measure sensitivity to that shape and call it sensitivity.
 *
 * The blocks are CENTRED: the fixture's camera (39N 95W, 1200 m, pitch 12) puts
 * the cloud deck across the middle of the frame, so a centred block lands on
 * the subject rather than on sky or on the HUD.
 *
 * These magnitudes are DECLARED, not derived from the scene — which is the
 * point. Whichever rung the run rejects becomes the published sensitivity of
 * the inertness claim, so the ladder does not need to be right in advance; it
 * needs to be stated.
 */
export const CONTROL_LADDER = Object.freeze([
  Object.freeze({ name: "r1", areaFraction: 1 / 64, amplitudeLevels: 8 }),
  Object.freeze({ name: "r2", areaFraction: 1 / 64, amplitudeLevels: 32 }),
  Object.freeze({ name: "r3", areaFraction: 1 / 16, amplitudeLevels: 32 }),
  Object.freeze({ name: "r4", areaFraction: 1, amplitudeLevels: 8 }),
  Object.freeze({ name: "r5", areaFraction: 1 / 4, amplitudeLevels: 64 }),
]);

/**
 * The mean per-pixel delta a rung contributes, in units of full scale.
 *
 * @param {{areaFraction: number, amplitudeLevels: number}} rung Ladder rung.
 * @returns {number} Nominal mean normalized delta, or NaN for a malformed rung.
 */
export function nominalMeanDelta(rung) {
  const area = Number(rung?.areaFraction);
  const amplitude = Number(rung?.amplitudeLevels);
  if (!Number.isFinite(area) || !Number.isFinite(amplitude)) {
    return Number.NaN;
  }
  return (area * amplitude) / 255;
}

/**
 * The centred pixel block a ladder rung perturbs.
 *
 * The area fractions are perfect squares (1/64, 1/16, 1/4, 1) so the per-axis
 * fraction is exact; the result is clamped to at least one pixel so a tiny
 * capture cannot silently produce an empty perturbation.
 *
 * @param {{areaFraction: number}} rung Ladder rung.
 * @param {number} width Capture width in pixels.
 * @param {number} height Capture height in pixels.
 * @returns {{x: number, y: number, w: number, h: number}} Block in pixels.
 */
export function ladderBlock(rung, width, height) {
  const w0 = Math.max(0, Math.floor(Number(width) || 0));
  const h0 = Math.max(0, Math.floor(Number(height) || 0));
  const side = Math.sqrt(Math.max(0, Number(rung?.areaFraction) || 0));
  const w = Math.min(w0, Math.max(1, Math.round(w0 * side)));
  const h = Math.min(h0, Math.max(1, Math.round(h0 * side)));
  return {
    x: Math.max(0, Math.floor((w0 - w) / 2)),
    y: Math.max(0, Math.floor((h0 - h) / 2)),
    w,
    h,
  };
}

/** Median of a finite numeric array (even lengths average the two centres). */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return Number.NaN;
  }
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Derive one state's (or one pooled pair of states') fluctuation band.
 *
 * ★ ANTI-VACUITY IS STRUCTURAL, NOT ADVISORY. A sample separated by zero
 * executes is not merely uninformative — it is ACTIVELY HARMFUL, because its
 * diff is 0, which drags the minimum down, which WIDENS the range, which widens
 * the band. The Batch-952 record already contains one instrument that read
 * green off exactly that shape. So a zero-execute sample does not get averaged
 * away; it makes the whole band not derivable, by name.
 *
 * @param {{label: string, executes: number, stats: object,
 *   sizeMismatch: boolean}[]} samples Consecutive same-state pairwise diffs.
 * @param {{label?: string, bounds?: object, floors?: object}} [options] Config.
 * @returns {{ok: boolean, label: string, n: number, reasons: string[],
 *   executesTotal: number, stats: Record<string, object>}} The band.
 */
export function deriveFluctuationBand(samples, options = {}) {
  const label = String(options.label ?? "(unlabelled)");
  const bounds = options.bounds ?? BAND_BOUNDS;
  const floors = options.floors ?? PIXEL_STAT_FLOORS;
  const list = Array.isArray(samples) ? samples : [];
  const reasons = [];
  const stats = {};

  const sized = list.filter((s) => s?.stats?.sizeMismatch === true);
  if (sized.length > 0) {
    reasons.push(
      `BAND SIZE MISMATCH "${label}" — ${sized.length} of ${list.length} same-state captures differ in SIZE from their neighbour; those pixels are not comparable`,
    );
  }
  const vacuous = list.filter((s) => !(Number(s?.executes) > 0));
  if (vacuous.length > 0) {
    reasons.push(
      `BAND VACUOUS "${label}" — ${vacuous.length} of ${list.length} same-state captures are separated by NO engine executes; a frozen frame differs from itself by zero, which would WIDEN the band rather than describe it`,
    );
  }
  const usable =
    reasons.length === 0
      ? list.filter((s) => s?.stats && s.stats.sizeMismatch !== true)
      : [];
  if (reasons.length === 0 && usable.length < bounds.minSamples) {
    reasons.push(
      `BAND UNDERSAMPLED "${label}" — ${usable.length} same-state diffs, fewer than the ${bounds.minSamples} a range can be extrapolated from`,
    );
  }
  if (reasons.length === 0) {
    for (const key of PIXEL_STATISTICS) {
      const values = usable.map((s) => Number(s.stats[key]));
      if (values.some((v) => !Number.isFinite(v))) {
        reasons.push(
          `BAND MALFORMED "${label}" — the statistic "${key}" is missing or non-finite in at least one same-state diff`,
        );
        break;
      }
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = max - min;
      const floor = Number(floors[key]) || 0;
      stats[key] = {
        n: values.length,
        min,
        max,
        median: median(values),
        range,
        floor,
        upper: max + bounds.rangeHeadroomMultiple * range + floor,
      };
    }
  }
  return {
    ok: reasons.length === 0,
    label,
    n: usable.length,
    reasons,
    executesTotal: list.reduce((sum, s) => sum + (Number(s?.executes) || 0), 0),
    stats,
  };
}

/**
 * Is one comparison's statistic profile inside a band?
 *
 * EVERY statistic must be inside. An OUTSIDE verdict names which exceeded, with
 * its value and its bound, so the reader never has to take "outside" on trust.
 *
 * @param {object} band {@link deriveFluctuationBand} output.
 * @param {object} stats One comparison's statistic profile.
 * @returns {{ok: boolean, inside: boolean|null, exceeded: object[],
 *   margins: Record<string, number|null>, reason: string|null}} Verdict.
 */
export function classifyAgainstBand(band, stats) {
  const blind = (reason) => ({
    ok: false,
    inside: null,
    exceeded: [],
    margins: {},
    reason,
  });
  if (band?.ok !== true) {
    return blind("the band is not derivable");
  }
  if (!stats || stats.sizeMismatch === true) {
    return blind("the compared captures are not the same size");
  }
  const exceeded = [];
  const margins = {};
  for (const key of PIXEL_STATISTICS) {
    const value = Number(stats[key]);
    const upper = Number(band.stats?.[key]?.upper);
    if (!Number.isFinite(value) || !Number.isFinite(upper)) {
      return blind(`the statistic "${key}" is missing from the comparison`);
    }
    margins[key] = upper > 0 ? value / upper : null;
    if (value > upper) {
      exceeded.push({ key, value, upper });
    }
  }
  return {
    ok: true,
    inside: exceeded.length === 0,
    exceeded,
    margins,
    reason: null,
  };
}

/**
 * Fold the injected control ladder into a DETECTION LIMIT for this band.
 *
 * The lowest rung that lands OUTSIDE the band is the smallest perturbation this
 * band is demonstrated — in this run, on these pixels — to reject. A band that
 * rejects no rung admits every change tested, so an INSIDE verdict from it is
 * not evidence, and that is named rather than reported as a pass.
 *
 * @param {object} band {@link deriveFluctuationBand} output.
 * @param {{name: string, areaFraction: number, amplitudeLevels: number,
 *   stats: object}[]} rungs Ladder results, ascending in perturbation.
 * @param {{label?: string}} [options] Config.
 * @returns {{ok: boolean, discriminating: boolean, limit: object|null,
 *   rungs: object[], reasons: string[]}} Calibration.
 */
export function foldDetectionLimit(band, rungs, options = {}) {
  const label = String(options.label ?? band?.label ?? "(unlabelled)");
  const list = Array.isArray(rungs) ? rungs : [];
  const reasons = [];
  if (band?.ok !== true) {
    return {
      ok: false,
      discriminating: false,
      limit: null,
      rungs: [],
      reasons: [
        `BAND NOT CALIBRATED "${label}" — the band is not derivable, so it has no detection limit`,
      ],
    };
  }
  const evaluated = list.map((rung) => {
    const verdict = classifyAgainstBand(band, rung?.stats);
    return {
      name: String(rung?.name ?? "(unnamed)"),
      areaFraction: Number(rung?.areaFraction) || null,
      amplitudeLevels: Number(rung?.amplitudeLevels) || null,
      nominalMeanDelta: nominalMeanDelta(rung),
      ok: verdict.ok,
      outside: verdict.ok ? verdict.inside === false : null,
      exceeded: verdict.exceeded.map((e) => e.key),
      // Kept so a cross-state exceedance can be COMPARED against the smallest
      // perturbation this band was demonstrated to reject — see
      // `belowDemonstratedLimit` in {@link foldPixelInertness}.
      stats: rung?.stats ?? null,
      reason: verdict.reason,
    };
  });
  const limit = evaluated.find((r) => r.outside === true) ?? null;
  if (evaluated.length === 0) {
    reasons.push(
      `BAND NOT CALIBRATED "${label}" — no control perturbation was injected, so the band's sensitivity is unknown and an INSIDE verdict is not evidence`,
    );
  } else if (limit === null) {
    const top = evaluated[evaluated.length - 1];
    reasons.push(
      `BAND NOT DISCRIMINATING "${label}" — none of the ${evaluated.length} injected control perturbations landed outside the band (largest: area ${top.areaFraction} at ${top.amplitudeLevels} levels); this band admits every change tested, so an INSIDE verdict is NOT evidence`,
    );
  }
  return {
    ok: limit !== null,
    discriminating: limit !== null,
    limit,
    rungs: evaluated,
    reasons,
  };
}

/**
 * Is an OUTSIDE verdict SMALLER than the smallest perturbation this band was
 * demonstrated to reject?
 *
 * ★ THIS DOES NOT SOFTEN THE VERDICT — it labels it. The band says OUTSIDE and
 * that stands. But a value sitting a couple of percent above `upper`, on one
 * statistic, when the smallest INJECTED change the run actually demonstrated
 * the band rejecting is larger than that, is a difference at the very edge of
 * the instrument's demonstrated resolution. Reporting it with the same weight
 * as a change three times the bound is how a marginal number becomes a
 * "finding" — the failure this lane has already paid for twice (the Batch-944
 * tier round-trip, the Batch-953 identity reds).
 *
 * @param {object} classification {@link classifyAgainstBand} output.
 * @param {object|null} limit The detection-limit rung, with its own stats.
 * @returns {boolean|null} True when every exceedance is below the limit rung's
 *   own value for that statistic; null when it cannot be determined.
 */
function belowDemonstratedLimit(classification, limit) {
  if (classification?.inside !== false) {
    return null;
  }
  const rungStats = limit?.stats ?? null;
  if (!rungStats) {
    return null;
  }
  let determined = false;
  for (const exceedance of classification.exceeded) {
    const rungValue = Number(rungStats[exceedance.key]);
    if (!Number.isFinite(rungValue)) {
      return null;
    }
    determined = true;
    if (exceedance.value >= rungValue) {
      return false;
    }
  }
  return determined ? true : null;
}

/**
 * Decide ONE pixel-inertness comparison, at the strongest tier that applies.
 *
 * TIER_STATIONARY beats TIER_BAND beats TIER_NONE. Byte identity is not
 * abandoned by this redesign — it is demoted to the regime where the subject
 * actually has the property it tests. In the live regime the band decides, at
 * the sensitivity the control ladder measured. When neither applies the verdict
 * is NULL and named: nothing was measured, so nothing is claimed.
 *
 * @param {{label: string, bothEndpointsStationary: boolean, identical: boolean,
 *   band: object, detection: object, stats: object,
 *   stationarityReasons?: string[]}} input Comparison inputs.
 * @returns {{label: string, tier: string, verdict: boolean|null,
 *   reasons: string[], classification: object|null,
 *   detectionLimit: object|null}} The fold.
 */
export function foldPixelInertness(input) {
  const label = String(input?.label ?? "(unlabelled)");
  const stats = input?.stats ?? null;
  if (input?.bothEndpointsStationary === true) {
    return {
      label,
      tier: TIER_STATIONARY,
      verdict: input?.identical === true,
      reasons: [],
      classification: null,
      detectionLimit: null,
      stats,
    };
  }
  const band = input?.band ?? null;
  const detection = input?.detection ?? null;
  const classification = classifyAgainstBand(band, input?.stats);
  if (band?.ok === true && detection?.discriminating === true) {
    if (classification.ok !== true) {
      return {
        label,
        tier: TIER_NONE,
        verdict: null,
        reasons: [
          `PIXEL-INERTNESS NOT MEASURED "${label}" — the band held but the comparison could not be classified: ${classification.reason}`,
        ],
        classification,
        detectionLimit: detection.limit,
        stats,
      };
    }
    return {
      label,
      tier: TIER_BAND,
      verdict: classification.inside,
      reasons: [],
      classification,
      detectionLimit: detection.limit,
      belowDemonstratedLimit: belowDemonstratedLimit(
        classification,
        detection.limit,
      ),
      stats,
    };
  }
  const reasons = [
    `PIXEL-INERTNESS NOT MEASURED "${label}" — neither tier applies: the endpoints never reached a byte-stationary fixed point AND no discriminating fluctuation band could be derived`,
    ...(Array.isArray(input?.stationarityReasons)
      ? input.stationarityReasons
      : []),
    ...(Array.isArray(band?.reasons) ? band.reasons : []),
    ...(Array.isArray(detection?.reasons) ? detection.reasons : []),
  ];
  return {
    label,
    tier: TIER_NONE,
    verdict: null,
    reasons,
    classification: classification.ok ? classification : null,
    detectionLimit: detection?.limit ?? null,
    stats,
  };
}

/**
 * Structural reasons for every comparison that could not be judged — and for no
 * other outcome.
 *
 * A BAND verdict of `false` is a RED PREDICATE, not a structural reason: the
 * lane looked, and saw a difference larger than the state's own fluctuation.
 * Laundering that into a structural note is how a real finding disappears —
 * the same mistake `starvedWindowReasons` exists to prevent one tier up.
 *
 * @param {{label: string, tier: string, reasons: string[]}[]} folds Folds.
 * @returns {string[]} Named reasons, in fold order.
 */
export function pixelInertnessReasons(folds) {
  const list = Array.isArray(folds) ? folds : [];
  const out = [];
  for (const fold of list) {
    if (fold?.tier !== TIER_NONE) {
      continue;
    }
    for (const reason of Array.isArray(fold.reasons) ? fold.reasons : []) {
      out.push(reason);
    }
  }
  return out;
}

/** Six decimals: a band's terms are small fractions and rounding hides them. */
function fixed(value) {
  return Number.isFinite(value) ? value.toFixed(6) : "n/a";
}

/**
 * One line describing a band, including the terms it was built from — a bound
 * printed without its own derivation is the shape this redesign exists to
 * remove.
 *
 * @param {object} band {@link deriveFluctuationBand} output.
 * @returns {string} Human-readable band.
 */
export function describeBand(band) {
  if (band?.ok !== true) {
    return `band "${band?.label ?? "(unlabelled)"}" NOT DERIVABLE (${(band?.reasons ?? ["no reason recorded"]).length} reason(s))`;
  }
  const terms = PIXEL_STATISTICS.map((key) => {
    const s = band.stats[key];
    return `${key} <= ${fixed(s.upper)} (max ${fixed(s.max)} + range ${fixed(s.range)} + floor ${fixed(s.floor)})`;
  }).join(" | ");
  return `band "${band.label}" n=${band.n} FIRST-PASS DERIVED: ${terms}`;
}

/**
 * One line describing what a band was demonstrated to detect IN THIS RUN.
 *
 * @param {object} detection {@link foldDetectionLimit} output.
 * @returns {string} Human-readable sensitivity.
 */
export function describeDetection(detection) {
  if (detection?.discriminating !== true) {
    return "detection limit: NONE — this band rejected no injected control, so an INSIDE verdict is not evidence";
  }
  const limit = detection.limit;
  return `detection limit: ${limit.name} (area ${fixed(limit.areaFraction)} x ${limit.amplitudeLevels} levels, nominal mean ${fixed(limit.nominalMeanDelta)}) via ${limit.exceeded.join("+")} — ${detection.rungs.filter((r) => r.outside === true).length}/${detection.rungs.length} rungs rejected`;
}

/**
 * One line describing a pixel-inertness fold: tier, verdict, the numbers, and
 * the sensitivity the verdict is scoped to.
 *
 * @param {object} fold {@link foldPixelInertness} output.
 * @returns {string} Human-readable verdict.
 */
export function describeInertness(fold) {
  const label = fold?.label ?? "(unlabelled)";
  if (fold?.tier === TIER_STATIONARY) {
    return `${label}: tier=stationary verdict=${fold.verdict} (byte identity at a byte-stationary fixed point)`;
  }
  if (fold?.tier === TIER_NONE) {
    return `${label}: tier=none verdict=NOT MEASURED — neither byte identity nor a discriminating band applies`;
  }
  const values = PIXEL_STATISTICS.map(
    (key) =>
      `${key} ${fixed(Number(fold?.stats?.[key]))}${
        fold?.classification?.margins?.[key] === null ||
        fold?.classification?.margins?.[key] === undefined
          ? ""
          : ` (${(fold.classification.margins[key] * 100).toFixed(1)}% of bound)`
      }`,
  ).join(" | ");
  const exceeded = (fold?.classification?.exceeded ?? [])
    .map((e) => `${e.key} ${fixed(e.value)} > ${fixed(e.upper)}`)
    .join(", ");
  const marginal =
    fold?.belowDemonstratedLimit === true
      ? ` — ★ MARGINAL: every exceedance is SMALLER than rung ${fold.detectionLimit?.name}, the smallest perturbation this band was demonstrated to reject; read it as a difference at the instrument's resolution, not as a large change`
      : "";
  return `${label}: tier=band verdict=${fold.verdict === true ? "INSIDE" : "OUTSIDE"} — ${values}${exceeded ? ` — EXCEEDED: ${exceeded}` : ""}${marginal}`;
}
