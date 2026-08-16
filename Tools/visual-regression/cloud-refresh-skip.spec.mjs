// cloud-refresh-skip.spec.mjs — the shared repair for ONE class defect that
// made both cloud-reconstruction probes lie on the same build.
// @purpose Pins the repair of the requestRenderMode frozen-frame defect that made both cloud-reconstruction probes count render calls as frames; mutant-checked.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, no build, no adapter.
//
// THE DEFECT. `?offline=true` forces `requestRenderMode: true`,
// `maximumRenderTimeChange` keeps its 0.0 default, and every probe in this lane
// pins the clock — so once Batch 942 restored the temporal resolve and the
// cloud lane started converging, `scene.render(t)` began executing NOTHING.
// Both probes counted RENDER CALLS. Render calls had stopped being frames:
//
//   * `probe-cloud-reconstruction-attachments.mjs` — the 4-call publish-lag
//     window and the 8-call release window expired against a FROZEN snapshot
//     (`bLiveBytesExact`, `selfHealingReleaseOnDisable`,
//     `aLiveBytesZeroBeforeToggle` red), and `c1 === c2 === c3` was green
//     VACUOUSLY because nothing rendered between the captures.
//   * `probe-cloud-reconstruction-consume.mjs` — every leg-D window reported
//     `attemptedFrameCount: 0`, exactly the five A-windows "held their arm"
//     (the frozen snapshot was an A-state snapshot), the `off` capture was
//     taken mid-convergence, and the resize legs returned pre-resize numbers
//     because `until: "consumed"` was ALREADY TRUE before the viewport moved.
//
// This file executes the repair's rules against their own mutants, and pins
// them in BOTH probe sources — because a rule that lives only inside a
// `page.evaluate` closure is shipped to the browser as text and can never be
// run against a mutant.
//
// CRLF: this repo checks out with `core.autocrlf=true`. Every source read here
// is LF-normalized before any anchor is applied.
//
// Run: node --test Tools/visual-regression/cloud-refresh-skip.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BAND_BOUNDS,
  COARSE_DELTA_LEVELS,
  CONTROL_LADDER,
  EXECUTE_COUNTER_FIELD,
  PIXEL_STATISTICS,
  PIXEL_STAT_FLOORS,
  REFRESH_SKIP_BOUNDS,
  TIER_BAND,
  TIER_NONE,
  TIER_STATIONARY,
  WINDOW_ARRIVED,
  WINDOW_EXPIRED,
  WINDOW_STARVED,
  classifyAgainstBand,
  classifyExecuteWindow,
  deriveFluctuationBand,
  describeBand,
  describeDetection,
  describeInertness,
  diffInterpretable,
  foldDetectionLimit,
  foldPixelInertness,
  foldStationarity,
  ladderBlock,
  nominalMeanDelta,
  pixelInertnessReasons,
  renderCallBudget,
  starvedWindowReasons,
  unlivenedRenderSites,
} from "./lib/cloud-refresh-skip.mjs";
import {
  analyzeProbeSource,
  blankNonCode,
} from "./lib/probe-fleet-contract.mjs";
import { PROBE_CONTRACT_ALLOWLIST } from "./lib/probe-fleet-contract-allowlist.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const readLf = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const CONSUME_PROBE = "probe-cloud-reconstruction-consume.mjs";
const SURVIVAL_PROBE = "probe-cloud-reconstruction-attachments.mjs";
const consumeSource = readLf(path.join(here, CONSUME_PROBE));
const survivalSource = readLf(path.join(here, SURVIVAL_PROBE));
const libSource = readLf(path.join(here, "lib", "cloud-refresh-skip.mjs"));
const flatConsume = consumeSource.replace(/\s+/g, " ");
const flatSurvival = survivalSource.replace(/\s+/g, " ");
const PROBES = [
  [CONSUME_PROBE, consumeSource, flatConsume],
  [SURVIVAL_PROBE, survivalSource, flatSurvival],
];

/** Assert `re` matches, and that it STOPS matching a mutated copy. */
function pinWithMutant(source, re, mutate, label) {
  assert.match(source, re, `missing: ${label}`);
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutation was a no-op for: ${label}`);
  assert.doesNotMatch(
    mutated,
    re,
    `the check for "${label}" does not detect its own mutant`,
  );
}

/** Every `for`/`while` header in comment- and string-blanked source. */
function loopHeaders(code) {
  const headers = [];
  const re = /\b(for|while)\s*\(/g;
  let m;
  let guard = 0;
  while ((m = re.exec(code)) !== null && guard++ < 10000) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let j = open;
    let inner = 0;
    while (j < code.length && inner++ < 100000) {
      if (code[j] === "(") depth += 1;
      else if (code[j] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      j += 1;
    }
    headers.push({ kind: m[1], text: code.slice(open + 1, j) });
  }
  return headers;
}

function unboundedLoops(code) {
  return loopHeaders(code).filter((h) => {
    const t = h.text.trim();
    if (t === "" || t === ";;") return true;
    if (/^true$/.test(t)) return true;
    return !/[<>]|\bof\b|\bin\b/.test(t);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// A. The pure repair — executed, and against its mutants
// ─────────────────────────────────────────────────────────────────────────────

test("A1 the execute counter is the engine's own per-execute field", () => {
  assert.equal(EXECUTE_COUNTER_FIELD, "frames");
  // `resetCloudFrameCounters` bumps it at the top of EVERY
  // `executeProceduralClouds`, ahead of the frustum-cull early return, so it
  // advances on exactly the frames the cloud lane ran.
  const observability = readLf(
    path.join(
      here,
      "..",
      "..",
      "packages/engine/Source/Renderer/WebGPU/WebGPUCloudObservability.ts",
    ),
  );
  assert.match(
    observability,
    /counters\.frames\+\+;/,
    "the reset no longer increments the execute counter this repair reads",
  );
  assert.match(
    observability,
    /frames: c\.frames,/,
    "the execute counter is no longer published in the cloud snapshot",
  );
});

test("A2 the render-call budget is a LOOP BOUND, never the semantic budget", () => {
  const b = REFRESH_SKIP_BOUNDS;
  assert.equal(b.renderCallsPerExecute, 4);
  assert.equal(b.minRenderCalls, 8);
  // Always at least the execute budget, so the loop can never stop a window
  // short of its own semantics under keep-live.
  for (const executes of [1, 2, 8, 12, 30, 60, 90]) {
    assert.ok(renderCallBudget(executes) >= executes, `${executes}`);
  }
  assert.equal(renderCallBudget(1), 8, "the floor covers the resize frame");
  assert.equal(renderCallBudget(30), 120);
  // Degenerate input cannot produce an unbounded loop.
  assert.equal(renderCallBudget(0), 8);
  assert.equal(renderCallBudget(-5), 8);
  assert.equal(renderCallBudget(Number.NaN), 8);
});

test("A3 STARVED and EXPIRED are DISTINCT — absence of evidence is not evidence", () => {
  const arrived = classifyExecuteWindow({
    conditionMet: true,
    executesRun: 3,
    renderCalls: 3,
    executeBudget: 90,
    renderCallBudget: 360,
  });
  assert.equal(arrived.outcome, WINDOW_ARRIVED);
  assert.equal(arrived.starved, false);

  // The lane ran its WHOLE budget and the condition never held. That is a real
  // negative and belongs to a predicate.
  const expired = classifyExecuteWindow({
    conditionMet: false,
    executesRun: 90,
    renderCalls: 90,
    executeBudget: 90,
    renderCallBudget: 360,
  });
  assert.equal(expired.outcome, WINDOW_EXPIRED);
  assert.equal(expired.starved, false);

  // The lane never ran. NOTHING was observed either way — this is exactly the
  // shape the Batch-944 tier round-trip "finding" had.
  const starved = classifyExecuteWindow({
    conditionMet: false,
    executesRun: 0,
    renderCalls: 360,
    executeBudget: 90,
    renderCallBudget: 360,
  });
  assert.equal(starved.outcome, WINDOW_STARVED);
  assert.equal(starved.starved, true);

  // MUTANT: a classifier that collapses the two would report the starved
  // window as expired, i.e. would manufacture a finding.
  assert.notEqual(starved.outcome, expired.outcome);
});

test("A4 only STARVED windows produce a structural reason", () => {
  const reasons = starvedWindowReasons([
    { label: "arrived", outcome: WINDOW_ARRIVED },
    {
      label: "tier-low",
      outcome: WINDOW_EXPIRED,
      executesRun: 90,
      executeBudget: 90,
      renderCalls: 90,
      renderCallBudget: 360,
    },
    {
      label: "resize-up",
      outcome: WINDOW_STARVED,
      executesRun: 0,
      executeBudget: 30,
      renderCalls: 120,
      renderCallBudget: 120,
    },
  ]);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /resize-up/);
  assert.match(reasons[0], /0 of 30 engine executes/);
  assert.ok(
    !reasons.some((r) => /tier-low/.test(r)),
    "an EXPIRED window must not be laundered into a structural reason — that is how a real negative disappears",
  );
  assert.deepEqual(starvedWindowReasons(null), []);
});

test("A5 stationarity is per state, and byte-equality across ZERO executes is not evidence", () => {
  const fold = foldStationarity([
    { label: "off", stationary: true, rounds: [{}], executesObserved: 8 },
    {
      label: "attachments-only",
      stationary: false,
      rounds: [{}, {}, {}],
      executesObserved: 8,
    },
    // ★ ANTI-VACUITY: "stationary" with no executes between the captures is the
    // exact shape `c1 === c2 === c3` had on the resolve-alive build.
    { label: "vacuous", stationary: true, rounds: [{}], executesObserved: 0 },
  ]);
  assert.equal(fold.ok, false);
  assert.equal(fold.stationary.off, true);
  assert.equal(fold.stationary["attachments-only"], false);
  assert.equal(
    fold.stationary.vacuous,
    false,
    "a vacuous capture must not read as stationary",
  );
  assert.ok(fold.reasons.some((r) => /VACUOUS "vacuous"/.test(r)));
  assert.ok(fold.reasons.some((r) => /NOT REACHED "attachments-only"/.test(r)));
  const clean = foldStationarity([
    { label: "a", stationary: true, rounds: [{}], executesObserved: 8 },
  ]);
  assert.deepEqual(clean, { ok: true, reasons: [], stationary: { a: true } });
});

test("A6 a diff is interpretable only when BOTH endpoints converged", () => {
  const stationary = { off: false, "attachments-only": true, consume: true };
  assert.equal(
    diffInterpretable(stationary, "off", "attachments-only"),
    false,
    "the Batch-944 34.5% was a converged capture minus a mid-convergence one",
  );
  assert.equal(
    diffInterpretable(stationary, "attachments-only", "consume"),
    true,
  );
  assert.equal(diffInterpretable(stationary, "consume", "absent"), false);
  assert.equal(diffInterpretable(undefined, "a", "b"), false);
});

test("A7 the keep-live detector detects a BARE render", () => {
  const live = "scene.requestRender();\n  scene.render(frameTime);";
  assert.deepEqual(unlivenedRenderSites(live), []);
  const bare = "scene.render(frameTime);";
  assert.equal(unlivenedRenderSites(bare).length, 1);
  // A `requestRender()` that is not the IMMEDIATELY preceding statement does
  // not count — otherwise one call at the top of a function would launder a
  // whole loop of unlivened renders.
  const distant = `scene.requestRender();\n${"x".repeat(200)}\nscene.render(frameTime);`;
  assert.equal(unlivenedRenderSites(distant).length, 1);
  assert.deepEqual(unlivenedRenderSites(""), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Both probes keep their lane live
// ─────────────────────────────────────────────────────────────────────────────

test("B1 EVERY scene.render in BOTH probes is kept live", () => {
  for (const [name, source] of PROBES) {
    const offenders = unlivenedRenderSites(blankNonCode(source));
    assert.deepEqual(
      offenders.map((o) => o.before),
      [],
      `${name} renders without requesting a frame — under requestRenderMode that call executes NOTHING`,
    );
    // MUTANT: dropping the keep-live must be caught.
    const mutated = blankNonCode(source).replaceAll(
      "scene.requestRender();",
      "                      ",
    );
    assert.ok(
      unlivenedRenderSites(mutated).length > 0,
      `${name}: the keep-live scan does not detect its own mutant`,
    );
  }
});

test("B2 the keep-live premise is READ BACK, not assumed", () => {
  for (const [name, source, flat] of PROBES) {
    assert.ok(
      flat.includes("requestRenderMode: scene.requestRenderMode === true"),
      `${name} does not record whether the page is actually in requestRenderMode`,
    );
    // `requestRender()`'s only effect beyond the gate flag is `markDirty` on a
    // FROZEN snapshot; the probes must prove that branch unreachable rather
    // than assert it.
    assert.ok(
      flat.includes(
        "snapshotModeEnabled: scene.snapshotMode?.enabled === true",
      ),
      `${name} does not read back the snapshot-mode state`,
    );
    assert.ok(
      source.includes("KEEP-LIVE PREMISE BROKEN"),
      `${name} does not name the case where the derivation stops holding`,
    );
  }
});

test("B3 every window budget is denominated in EXECUTES, not render calls", () => {
  for (const [name, source, flat] of PROBES) {
    // The loop bound reads BOTH terms: the render-call budget is the loop
    // bound, the execute budget is the semantics.
    pinWithMutant(
      flat,
      /for \(; renderCalls < callBudget && executesRun < executeBudget;\)/,
      (s) =>
        s.replace(
          "for (; renderCalls < callBudget && executesRun < executeBudget;)",
          "for (; renderCalls < callBudget;)",
        ),
      `${name}: the phase loop is bounded by executes as well as calls`,
    );
    assert.ok(
      flat.includes(
        "executesRun = (snap?.frames ?? executesAtStart) - executesAtStart;",
      ),
      `${name} does not derive its execute count from the engine's own counter`,
    );
    // A fixed-execute phase that never ran must not read as "arrived".
    assert.ok(
      flat.includes("conditionMet = executesRun >= executeBudget;"),
      `${name}: a starved fixed-execute phase would read green`,
    );
    assert.ok(
      source.includes("classifyExecuteWindow({"),
      `${name} does not classify its windows`,
    );
    assert.ok(
      source.includes("starvedWindowReasons(windowLedger)"),
      `${name} does not surface starved windows as structural`,
    );
  }
});

test("B4 the publish-lag window is bounded in EXECUTES and reports its latency", () => {
  for (const [name, source, flat] of PROBES) {
    pinWithMutant(
      flat,
      /for \(; publishLagExecutes < publishLagMax; publishLagExecutes\+\+\)/,
      (s) =>
        s.replace(
          "for (; publishLagExecutes < publishLagMax; publishLagExecutes++)",
          "while (true)",
        ),
      `${name}: the publish-lag window is bounded`,
    );
    assert.ok(
      flat.includes("publishLagExecutes,"),
      `${name}: the observed latency must be REPORTED, not just waited out`,
    );
    assert.ok(
      source.includes(
        "PUBLISH_LAG_MAX = REFRESH_SKIP_BOUNDS.publishLagExecutes",
      ),
      `${name}: the lag bound must come from the shared derivation`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Per-phase stationarity gates (consume probe fix 1, survival probe fix 4)
// ─────────────────────────────────────────────────────────────────────────────

test("C1 EVERY captured state gets its OWN stationarity gate", () => {
  // The consume probe captures four states; three of them are converged
  // through `captureStationary` and the fourth is the self-floor taken from
  // the converged one.
  for (const label of ["off", "attachments-only", "consume"]) {
    assert.ok(
      flatConsume.includes(`captureStationary(main.page, "${label}")`) ||
        flatConsume.includes(`captureStationary( main.page, "${label}", )`),
      `the consume probe does not converge the "${label}" state before capturing it`,
    );
  }
  assert.ok(
    flatConsume.includes("const stationarity = foldStationarity(["),
    "the consume probe does not fold its stationarity verdicts",
  );
  // The survival probe converges its flag-off capture the same way.
  assert.ok(
    flatSurvival.includes('captureStationary(main.page, "flag-off")'),
    "the survival probe no longer converges its byte-identity endpoint",
  );
  assert.ok(
    flatSurvival.includes("foldStationarity(["),
    "the survival probe does not run the anti-vacuity fold",
  );
});

test("C2 a pixel diff carries an INTERPRETABLE flag derived from both endpoints", () => {
  pinWithMutant(
    flatConsume,
    /diffs\.offVsAttachments\.interpretable = diffInterpretable\( interpretable, "off", "attachments-only", \);/,
    (s) =>
      s.replace(
        'diffs.offVsAttachments.interpretable = diffInterpretable( interpretable, "off", "attachments-only", );',
        "diffs.offVsAttachments.interpretable = true;",
      ),
    "the off→attachments diff declares whether it is interpretable",
  );
  for (const key of [
    "attachmentsVsConsume",
    "offVsConsume",
    "consumeSelfFloor",
  ]) {
    assert.ok(
      flatConsume.includes(`diffs.${key}.interpretable = diffInterpretable(`),
      `${key} carries no interpretability flag`,
    );
  }
  // The flag is REPORTED, not merely computed.
  assert.match(consumeSource, /interpretable=\$\{diffs\./);
});

test("C3 the survival probe's byte identity cannot be VACUOUS again", () => {
  // Its `c1 === c2 === c3` was green on the resolve-alive build because nothing
  // rendered between the captures. The fold rejects a capture whose rounds are
  // separated by zero executes, and the C2/C3 windows are execute-counted.
  assert.ok(
    flatSurvival.includes(
      'const stationary = stationarityFold.stationary["flag-off"] === true;',
    ),
    "the survival probe's stationarity verdict must come from the anti-vacuity fold",
  );
  for (const anchor of [
    'label: "on-settled", toggle: true, executes: PHASE_EXECUTES,',
    'label: "off-settled", toggle: false, executes: PHASE_EXECUTES,',
  ]) {
    assert.ok(
      flatSurvival.includes(anchor),
      `the C2/C3 capture windows are not execute-counted: ${anchor}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// D. The resize legs wait on something the PRE-resize state cannot satisfy
// ─────────────────────────────────────────────────────────────────────────────

test("D1 the resize arrival condition is NOT satisfiable by the pre-resize state", () => {
  for (const [name, source, flat] of PROBES) {
    // The condition requires BOTH a dimension change AND a generation advance
    // past the value measured before the viewport moved.
    assert.ok(
      flat.includes("attNow.width !== expect?.previousWidth") ||
        flat.includes("att.width !== expect?.previousWidth"),
      `${name}: the resize condition does not compare against the PRE-resize dims`,
    );
    assert.ok(
      flat.includes("generation > (expect?.previousGeneration ?? -1)"),
      `${name}: the resize condition does not require a generation advance`,
    );
    assert.ok(
      source.includes('until: "resized"'),
      `${name}: the resize legs still wait on a condition the stale state satisfies`,
    );
    // MUTANT: reverting to the old condition must be visible.
    const mutated = flat.replaceAll('until: "resized"', 'until: "produced"');
    assert.ok(
      !mutated.includes('until: "resized"'),
      `${name}: the mutant did not apply`,
    );
    assert.match(source, /resized: \d+,/, `${name}: "resized" has no bound`);
  }
});

test("D2 the canvas backing store is waited for BEFORE the resize window opens", () => {
  for (const [name, source, flat] of PROBES) {
    assert.ok(
      source.includes("async function awaitCanvasChange(page, previous)"),
      `${name} has no canvas-change wait`,
    );
    assert.ok(
      flat.includes(
        "scene.canvas.width !== previous.width || scene.canvas.height !== previous.height",
      ),
      `${name}: the wait does not compare against the PREVIOUS canvas size`,
    );
    assert.ok(
      source.includes("RESIZE PLUMBING"),
      `${name}: a canvas that never resizes must be NAMED, not silently measured`,
    );
    // Ordering: EVERY `setViewportSize` is followed by a canvas wait before the
    // window that reads the new size. (Searching from the call site, not from
    // the file start — the helper's own DEFINITION precedes every call.)
    const setSites = [...flat.matchAll(/setViewportSize\(/g)].map(
      (m) => m.index,
    );
    assert.ok(setSites.length >= 2, `${name}: the resize legs are gone`);
    for (const at of setSites) {
      const waitAt = flat.indexOf("await awaitCanvasChange(", at);
      const windowAt = flat.indexOf('until: "resized"', at);
      assert.ok(
        waitAt > at && (windowAt < 0 || waitAt < windowAt),
        `${name}: a viewport change at ${at} is not followed by a canvas wait before its resize window`,
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Leg D — the timing arm is armed, re-verified, and discarded when it drops
// ─────────────────────────────────────────────────────────────────────────────

test("E1 the timestamp surface is ARMED per window, before AND after the warm span", () => {
  assert.ok(
    flatConsume.includes("dbg.gpuPassCost(true);"),
    "the perf window never arms the timing surface",
  );
  // Armed once at window start (so query sets are allocated during WARM) and
  // again immediately before MEASURE (which also resets the profiler).
  const measure = consumeSource.slice(
    consumeSource.indexOf("async function measurePerfWindow"),
    consumeSource.indexOf("function timingArmHeld"),
  );
  assert.ok(measure.length > 500, "the perf window moved");
  const arms = [...measure.matchAll(/dbg\.gpuPassCost\(true\);/g)];
  assert.equal(
    arms.length,
    2,
    "the arm must be issued at window start AND immediately before the measured span",
  );
  const measureLoop = measure.indexOf(
    "for (let i = 0; i < measureFrames; i++)",
  );
  assert.ok(
    arms[1].index < measureLoop,
    "the re-arm must precede the measured span",
  );
  assert.ok(
    measure.includes(
      "const reArmed = profiler?.getResults?.()?.enabled === true;",
    ),
    "the re-arm is not verified",
  );
});

test("E2 a window whose TIMING arm dropped is DISCARDED-AND-NAMED, never counted", () => {
  const holder = consumeSource.slice(
    consumeSource.indexOf("function timingArmHeld"),
    consumeSource.indexOf("const browser = await chromium.launch("),
  );
  assert.ok(holder.length > 200, "the timing-arm verdict moved");
  for (const anchor of [
    "results.enabled !== true",
    "results.attemptedFrameCount >= PERF_MEASURE_FRAMES",
    "results.sampleLedgerBalanced !== true",
    "results.frameCount > 0",
  ]) {
    assert.ok(holder.includes(anchor), `the arm verdict ignores ${anchor}`);
  }
  // `attemptedFrameCount` is the discriminator the Batch-944 run needed: the
  // profiler was armed and reported 0 armed frames.
  assert.ok(
    consumeSource.includes("PERF WINDOW DISCARDED"),
    "a dropped arm must be NAMED",
  );
  pinWithMutant(
    flatConsume,
    /const timedWindows = windows\.filter\(\(w, index\) => armVerdicts\[index\]\.ok\);/,
    (s) =>
      s.replace(
        "const timedWindows = windows.filter((w, index) => armVerdicts[index].ok);",
        "const timedWindows = windows;",
      ),
    "the medians are built ONLY from windows whose timing arm held",
  );
  assert.ok(
    consumeSource.includes("PERF ARM BLIND"),
    "a run in which no window held its arm must say so rather than print an empty table",
  );
});

test("E3 every perf span is kept live — the Batch-944 windows saw ZERO frames", () => {
  const measure = consumeSource.slice(
    consumeSource.indexOf("async function measurePerfWindow"),
    consumeSource.indexOf("function timingArmHeld"),
  );
  const flatMeasure = measure.replace(/\s+/g, " ");
  assert.ok(
    flatMeasure.includes(
      "const renderLive = () => { scene.requestRender(); scene.render(frameTime); };",
    ),
    "the perf window's render helper does not keep the lane live",
  );
  // All three spans use it.
  assert.equal(
    (measure.match(/renderLive\(\);/g) ?? []).length,
    4,
    "warm, verify, measure and the same-task final read must all keep the lane live",
  );
  // ...and the MEASURED span still reads no statistics.
  const measured = measure.slice(
    measure.indexOf("for (let i = 0; i < measureFrames; i++)"),
    measure.indexOf("// Same-task read"),
  );
  assert.ok(
    !measured.includes("snapNow()"),
    "a snapshot read inside the timing window times the instrument, not the pass",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Nothing weakened, and the fleet contract still holds
// ─────────────────────────────────────────────────────────────────────────────

test("F1 the survival probe's three re-derived predicates demand what they demanded", () => {
  // The windows changed unit. The PREDICATES did not: a counter that never
  // publishes still fails.
  for (const anchor of [
    "p.aLiveBytesZeroBeforeToggle = report.mainReadiness.ready && attHeal !== null && attHeal.liveBytes === 0 && heal.passCount === 0;",
    "p.selfHealingReleaseOnDisable = attHeal !== null && attHeal.liveBytes === 0 && heal.passCount === 0;",
    "p.bLiveBytesExact = attActive !== null && attActive.liveBytes === attActive.width * attActive.height * BYTES_PER_TEXEL_OWNED;",
  ]) {
    assert.ok(
      flatSurvival.includes(anchor.replace(/\s+/g, " ")),
      `a predicate was weakened or renamed: ${anchor}`,
    );
  }
  // The bound moved from 8 render calls to 12 EXECUTES, and the derivation is
  // written down beside it.
  assert.match(survivalSource, /released: 12,/);
  assert.match(
    survivalSource,
    /4\s*\n?\s*\/\/\s*executes suffice, 12 is 3x that|executes suffice, 12 is 3x that/,
    "the released bound has no recorded derivation",
  );
});

test("F2 both probes still satisfy the fleet contract, unallowlisted", () => {
  for (const [name, source] of PROBES) {
    const analysis = analyzeProbeSource(source);
    assert.deepEqual(analysis.violations, [], name);
    assert.equal(analysis.hasWatchdog, true, name);
    assert.equal(analysis.closeInFinally, true, name);
    assert.ok(
      !Object.hasOwn(PROBE_CONTRACT_ALLOWLIST, name),
      `${name} must not need an allowlist entry`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// G. TOLERANCE BANDS — pixel-inertness for a frame that never stops moving
//
// The Batch-953 runs are the reason this section exists. With keep-live in
// place and the lane really executing, NONE of the six captured states across
// the two probes reached a byte-stationary fixed point in 8 rounds of 8 real
// executes; the consume probe's own SAME-STATE floor read 30.379% of pixels
// differing, against cross-state figures of 33.403 / 38.559 / 37.764%, and the
// survival probe's two byte-identity predicates fired RED on a precondition
// that the same output declared broken.
//
// Byte identity tests for a fixed point that a jittered march feeding a
// temporal resolve does not have. The band is what replaces it, and everything
// below runs the replacement against its own mutants — INCLUDING the two the
// brief demands: a within-band fluctuation must NOT fail, and an injected real
// change beyond the band MUST.
// ─────────────────────────────────────────────────────────────────────────────

/** A same-state fluctuation sample, in the shape the band consumes. */
function sample(mismatch, coarse, mean, executes = 8) {
  return {
    label: `s${mismatch}`,
    executes,
    stats: {
      mismatchFraction: mismatch,
      coarseFraction: coarse,
      meanNormalizedDelta: mean,
      sizeMismatch: false,
    },
  };
}

/**
 * Five same-state samples with the SHAPE the Batch-953 run measured: a
 * saturated any-difference footprint around 30%, a small coarse footprint, and
 * a small mean magnitude.
 */
const LIVE_SAMPLES = [
  sample(0.3, 0.04, 0.0102),
  sample(0.305, 0.042, 0.0104),
  sample(0.298, 0.039, 0.0101),
  sample(0.31, 0.045, 0.0106),
  sample(0.302, 0.041, 0.0103),
];

test("G1 the profile is THREE statistics that fail differently", () => {
  assert.deepEqual(PIXEL_STATISTICS, [
    "mismatchFraction",
    "coarseFraction",
    "meanNormalizedDelta",
  ]);
  // A single saturated footprint statistic is what the old arm had; at a 30%
  // dither floor a band on it alone admits almost anything.
  assert.equal(COARSE_DELTA_LEVELS, 7);
  // Floors are DERIVED, not chosen: 0.1% of pixels is the survival probe's own
  // long-standing cross-build absolute floor, and 1/255 is the 8-bit quantum of
  // the captures being compared.
  assert.equal(PIXEL_STAT_FLOORS.mismatchFraction, 0.001);
  assert.equal(PIXEL_STAT_FLOORS.coarseFraction, 0.001);
  assert.equal(PIXEL_STAT_FLOORS.meanNormalizedDelta, 1 / 255);
  for (const key of PIXEL_STATISTICS) {
    assert.ok(
      Number.isFinite(PIXEL_STAT_FLOORS[key]),
      `${key} has no absolute floor`,
    );
  }
});

test("G2 the band is max + range + floor, and it is not any of the rejected rules", () => {
  const band = deriveFluctuationBand(LIVE_SAMPLES, { label: "live" });
  assert.equal(band.ok, true, band.reasons.join("; "));
  assert.equal(band.n, 5);
  const m = band.stats.mismatchFraction;
  assert.equal(m.min, 0.298);
  assert.equal(m.max, 0.31);
  assert.ok(Math.abs(m.range - 0.012) < 1e-12);
  // upper = max + 1 x range + floor
  assert.ok(Math.abs(m.upper - (0.31 + 0.012 + 0.001)) < 1e-12);
  assert.equal(BAND_BOUNDS.rangeHeadroomMultiple, 1);
  // REJECTED RULE 1 — "max alone" has zero headroom, so the subject's own next
  // frame refutes it. The real rule must be strictly looser than max.
  assert.ok(m.upper > m.max, "the band has no headroom above the observed max");
  // REJECTED RULE 2 — a fixed percentage. At this floor a 1% bound is BELOW the
  // state's own fluctuation, i.e. it would fail on nothing but noise.
  assert.ok(
    m.upper > 0.01,
    "a fixed 1% bound would sit below the measured floor",
  );
  // The band stays a FUNCTION OF THE SAMPLES: widen the spread, widen the band.
  const wider = deriveFluctuationBand(
    [...LIVE_SAMPLES, sample(0.36, 0.05, 0.012)],
    { label: "wider" },
  );
  assert.ok(wider.stats.mismatchFraction.upper > m.upper);
});

test("G3 ANTI-VACUITY — a band built on nothing is not a band", () => {
  // A capture pair separated by ZERO executes is two screenshots of one frozen
  // frame. Its diff is 0, which drags the MINIMUM down, which WIDENS the range,
  // which widens the band — the failure is not "uninformative", it is
  // actively permissive. So it poisons the whole band, by name.
  const frozen = deriveFluctuationBand([...LIVE_SAMPLES, sample(0, 0, 0, 0)], {
    label: "frozen",
  });
  assert.equal(frozen.ok, false);
  assert.ok(frozen.reasons.some((r) => /BAND VACUOUS "frozen"/.test(r)));
  // MUTANT: a derivation that merely dropped the zero-execute sample would
  // still be `ok`, and would report a band. Prove the real one does not.
  assert.equal(
    Object.keys(frozen.stats).length,
    0,
    "a poisoned band has no numbers to quote",
  );

  const thin = deriveFluctuationBand(LIVE_SAMPLES.slice(0, 2), {
    label: "thin",
  });
  assert.equal(thin.ok, false);
  assert.ok(thin.reasons.some((r) => /BAND UNDERSAMPLED "thin"/.test(r)));
  assert.equal(BAND_BOUNDS.minSamples, 3);

  const mismatched = deriveFluctuationBand(
    [
      ...LIVE_SAMPLES,
      {
        label: "resized",
        executes: 8,
        stats: { sizeMismatch: true },
      },
    ],
    { label: "sized" },
  );
  assert.equal(mismatched.ok, false);
  assert.ok(mismatched.reasons.some((r) => /BAND SIZE MISMATCH/.test(r)));

  assert.equal(deriveFluctuationBand(null, { label: "empty" }).ok, false);
  const malformed = deriveFluctuationBand(
    [
      sample(0.3, 0.04, 0.01),
      sample(0.3, 0.04, 0.01),
      {
        label: "partial",
        executes: 8,
        stats: { mismatchFraction: 0.3, sizeMismatch: false },
      },
    ],
    { label: "malformed" },
  );
  assert.equal(malformed.ok, false);
  assert.ok(malformed.reasons.some((r) => /BAND MALFORMED/.test(r)));
});

test("G4 EVERY statistic must be inside, and an exceedance is NAMED", () => {
  const band = deriveFluctuationBand(LIVE_SAMPLES, { label: "live" });
  // Inside on the saturated footprint, OUTSIDE on magnitude: a change that
  // moves the same pixels much harder. A footprint-only test would miss it.
  const magnitudeOnly = classifyAgainstBand(band, {
    mismatchFraction: 0.3,
    coarseFraction: 0.04,
    meanNormalizedDelta: 0.2,
    sizeMismatch: false,
  });
  assert.equal(magnitudeOnly.inside, false);
  assert.deepEqual(
    magnitudeOnly.exceeded.map((e) => e.key),
    ["meanNormalizedDelta"],
  );
  // ...and the reverse: a wide, faint change that magnitude barely notices.
  const footprintOnly = classifyAgainstBand(band, {
    mismatchFraction: 0.9,
    coarseFraction: 0.04,
    meanNormalizedDelta: 0.0104,
    sizeMismatch: false,
  });
  assert.equal(footprintOnly.inside, false);
  assert.deepEqual(
    footprintOnly.exceeded.map((e) => e.key),
    ["mismatchFraction"],
  );
  // A comparison that cannot be classified is NOT "inside".
  assert.equal(classifyAgainstBand(band, { sizeMismatch: true }).inside, null);
  assert.equal(classifyAgainstBand({ ok: false }, {}).inside, null);
  assert.equal(
    classifyAgainstBand(band, { mismatchFraction: 0.3 }).inside,
    null,
    "a missing statistic must blind the verdict, never pass it",
  );
});

test("G5 MUTANTS BOTH WAYS — fluctuation passes, an injected real change fails", () => {
  const band = deriveFluctuationBand(LIVE_SAMPLES, { label: "live" });
  const detection = foldDetectionLimit(
    band,
    [
      { ...CONTROL_LADDER[0], stats: sample(0.301, 0.041, 0.0103).stats },
      { ...CONTROL_LADDER[4], stats: sample(0.34, 0.28, 0.07).stats },
    ],
    { label: "live" },
  );
  assert.equal(detection.discriminating, true);

  // ── DIRECTION 1: a within-band fluctuation must NOT fail. This is the draw
  // the old byte-identity arm turned RED on every single time.
  const fluctuation = foldPixelInertness({
    label: "same state, one more orbit",
    bothEndpointsStationary: false,
    identical: false,
    band,
    detection,
    stats: sample(0.3035, 0.0425, 0.01045).stats,
  });
  assert.equal(fluctuation.tier, TIER_BAND);
  assert.equal(
    fluctuation.verdict,
    true,
    "fluctuation must not read as change",
  );

  // ── DIRECTION 2: an injected REAL change beyond the band MUST fail. Modelled
  // on the ladder's own top rung: a quarter of the frame moved 64 levels.
  const injected = foldPixelInertness({
    label: "same state + a real change",
    bothEndpointsStationary: false,
    identical: false,
    band,
    detection,
    stats: sample(0.34, 0.28, 0.07).stats,
  });
  assert.equal(injected.tier, TIER_BAND);
  assert.equal(injected.verdict, false, "a real change must not read as noise");
  assert.ok(injected.classification.exceeded.length >= 1);

  // ── AND THE MUTANT ON THE INSTRUMENT ITSELF: a band that rejects NOTHING
  // must not be allowed to return "inside". Same fluctuation input, ladder
  // whose every rung lands inside.
  const blindDetection = foldDetectionLimit(
    band,
    CONTROL_LADDER.map((rung) => ({
      ...rung,
      stats: sample(0.301, 0.041, 0.0103).stats,
    })),
    { label: "live" },
  );
  assert.equal(blindDetection.discriminating, false);
  assert.ok(
    blindDetection.reasons.some((r) => /BAND NOT DISCRIMINATING/.test(r)),
  );
  const blind = foldPixelInertness({
    label: "uncalibrated",
    bothEndpointsStationary: false,
    identical: false,
    band,
    detection: blindDetection,
    stats: sample(0.3035, 0.0425, 0.01045).stats,
  });
  assert.equal(blind.tier, TIER_NONE);
  assert.equal(
    blind.verdict,
    null,
    "an uncalibrated band must not manufacture a green",
  );
});

test("G5b a MARGINAL exceedance is labelled — the verdict stands, its weight does not", () => {
  const band = deriveFluctuationBand(LIVE_SAMPLES, { label: "live" });
  // The band's own mismatch bound; a small perturbation lands just above it,
  // and the demonstrated rung lands well above that.
  const upper = band.stats.mismatchFraction.upper;
  const detection = foldDetectionLimit(
    band,
    [
      {
        ...CONTROL_LADDER[2],
        stats: sample(upper + 0.05, 0.042, 0.0104).stats,
      },
    ],
    { label: "live" },
  );
  assert.equal(detection.discriminating, true);
  // A cross-state value 2% over the bound, when the smallest change the band
  // was DEMONSTRATED to reject is 5 points over it: OUTSIDE, and marginal.
  const marginal = foldPixelInertness({
    label: "hairline",
    bothEndpointsStationary: false,
    identical: false,
    band,
    detection,
    stats: sample(upper + 0.002, 0.042, 0.0104).stats,
  });
  assert.equal(marginal.verdict, false, "the verdict must NOT be softened");
  assert.equal(marginal.belowDemonstratedLimit, true);
  assert.match(describeInertness(marginal), /★ MARGINAL/);
  // A change larger than the demonstrated rung is not marginal.
  const large = foldPixelInertness({
    label: "large",
    bothEndpointsStationary: false,
    identical: false,
    band,
    detection,
    stats: sample(upper + 0.2, 0.042, 0.0104).stats,
  });
  assert.equal(large.verdict, false);
  assert.equal(large.belowDemonstratedLimit, false);
  assert.ok(!/★ MARGINAL/.test(describeInertness(large)));
  // An INSIDE verdict has no margin to report.
  const inside = foldPixelInertness({
    label: "inside",
    bothEndpointsStationary: false,
    identical: false,
    band,
    detection,
    stats: sample(0.3035, 0.0425, 0.01045).stats,
  });
  assert.equal(inside.verdict, true);
  assert.equal(inside.belowDemonstratedLimit, null);
});

test("G6 the control ladder is ordered, declared, and lands real pixels", () => {
  assert.ok(CONTROL_LADDER.length >= 3);
  const nominal = CONTROL_LADDER.map(nominalMeanDelta);
  for (let i = 1; i < nominal.length; i++) {
    assert.ok(
      nominal[i] > nominal[i - 1],
      `the ladder is not ascending at rung ${i}: ${nominal[i - 1]} -> ${nominal[i]}`,
    );
  }
  // The ladder trades AREA against AMPLITUDE deliberately — a ladder of one
  // shape measures sensitivity to that shape and calls it sensitivity.
  const areas = new Set(CONTROL_LADDER.map((r) => r.areaFraction));
  const amps = new Set(CONTROL_LADDER.map((r) => r.amplitudeLevels));
  assert.ok(areas.size >= 3, "every rung has the same area");
  assert.ok(amps.size >= 2, "every rung has the same amplitude");
  // Amplitudes must stay inside the range the away-from-clamp perturbation can
  // apply without saturating (|delta| <= 127 from either side of the midpoint).
  for (const rung of CONTROL_LADDER) {
    assert.ok(rung.amplitudeLevels <= 127, `${rung.name} would clamp`);
  }
  // Geometry: exact for the perfect-square area fractions, centred, clamped to
  // at least one pixel, and never larger than the capture.
  const block = ladderBlock({ areaFraction: 1 / 16 }, 800, 400);
  assert.deepEqual(block, { x: 300, y: 150, w: 200, h: 100 });
  assert.deepEqual(ladderBlock({ areaFraction: 1 }, 8, 4), {
    x: 0,
    y: 0,
    w: 8,
    h: 4,
  });
  const tiny = ladderBlock({ areaFraction: 1 / 64 }, 4, 4);
  assert.ok(tiny.w >= 1 && tiny.h >= 1, "a rung must touch at least one pixel");
  assert.deepEqual(ladderBlock({ areaFraction: 0 }, 100, 100).w, 1);
});

test("G7 the DETECTION LIMIT is the lowest rung the band rejects", () => {
  const band = deriveFluctuationBand(LIVE_SAMPLES, { label: "live" });
  const inside = sample(0.301, 0.041, 0.0103).stats;
  const outside = sample(0.34, 0.28, 0.07).stats;
  const detection = foldDetectionLimit(
    band,
    [
      { ...CONTROL_LADDER[0], stats: inside },
      { ...CONTROL_LADDER[1], stats: inside },
      { ...CONTROL_LADDER[2], stats: outside },
      { ...CONTROL_LADDER[3], stats: outside },
      { ...CONTROL_LADDER[4], stats: outside },
    ],
    { label: "live" },
  );
  assert.equal(detection.discriminating, true);
  assert.equal(detection.limit.name, CONTROL_LADDER[2].name);
  assert.deepEqual(detection.limit.exceeded, [
    "mismatchFraction",
    "coarseFraction",
    "meanNormalizedDelta",
  ]);
  assert.equal(detection.rungs.length, 5);
  // No ladder at all is NOT the same as a ladder that all passed, and neither
  // is a pass.
  const uncalibrated = foldDetectionLimit(band, [], { label: "live" });
  assert.equal(uncalibrated.discriminating, false);
  assert.ok(uncalibrated.reasons.some((r) => /BAND NOT CALIBRATED/.test(r)));
  const noBand = foldDetectionLimit({ ok: false }, [], { label: "live" });
  assert.equal(noBand.discriminating, false);
});

test("G8 TIERS — byte identity is demoted, not abandoned", () => {
  const band = deriveFluctuationBand(LIVE_SAMPLES, { label: "live" });
  const detection = foldDetectionLimit(
    band,
    [{ ...CONTROL_LADDER[4], stats: sample(0.34, 0.28, 0.07).stats }],
    { label: "live" },
  );
  // TIER 1 — when the state DOES settle, byte identity is still the test, and
  // it still fails on a difference.
  const settledSame = foldPixelInertness({
    label: "settled",
    bothEndpointsStationary: true,
    identical: true,
    band,
    detection,
    stats: sample(0, 0, 0).stats,
  });
  assert.equal(settledSame.tier, TIER_STATIONARY);
  assert.equal(settledSame.verdict, true);
  const settledDiff = foldPixelInertness({
    label: "settled",
    bothEndpointsStationary: true,
    identical: false,
    band,
    detection,
    stats: sample(0.0001, 0, 0).stats,
  });
  assert.equal(settledDiff.tier, TIER_STATIONARY);
  assert.equal(
    settledDiff.verdict,
    false,
    "two settled fixed points that differ is a real difference",
  );
  // TIER 3 — neither. NULL, and every reason quoted: the stationarity reason,
  // the band's reason, and the detection reason.
  const none = foldPixelInertness({
    label: "live",
    bothEndpointsStationary: false,
    identical: false,
    band: deriveFluctuationBand([], { label: "live" }),
    detection: foldDetectionLimit({ ok: false }, [], { label: "live" }),
    stats: sample(0.3, 0.04, 0.01).stats,
    stationarityReasons: ['STATIONARITY NOT REACHED "off"'],
  });
  assert.equal(none.tier, TIER_NONE);
  assert.equal(none.verdict, null);
  assert.ok(none.reasons.some((r) => /PIXEL-INERTNESS NOT MEASURED/.test(r)));
  assert.ok(none.reasons.some((r) => /STATIONARITY NOT REACHED/.test(r)));
  assert.ok(none.reasons.some((r) => /BAND UNDERSAMPLED/.test(r)));
});

test("G9 a RED band verdict is a finding, never laundered into structural", () => {
  const band = deriveFluctuationBand(LIVE_SAMPLES, { label: "live" });
  const detection = foldDetectionLimit(
    band,
    [{ ...CONTROL_LADDER[4], stats: sample(0.34, 0.28, 0.07).stats }],
    { label: "live" },
  );
  const red = foldPixelInertness({
    label: "outside",
    bothEndpointsStationary: false,
    identical: false,
    band,
    detection,
    stats: sample(0.34, 0.28, 0.07).stats,
  });
  assert.equal(red.verdict, false);
  assert.deepEqual(
    pixelInertnessReasons([red]),
    [],
    "an OUTSIDE verdict is evidence — turning it into a structural note is how a finding disappears",
  );
  const notMeasured = foldPixelInertness({
    label: "blind",
    bothEndpointsStationary: false,
    identical: false,
    band: deriveFluctuationBand([], { label: "blind" }),
    detection: foldDetectionLimit({ ok: false }, [], { label: "blind" }),
    stats: sample(0.3, 0.04, 0.01).stats,
  });
  assert.ok(pixelInertnessReasons([notMeasured]).length > 0);
  assert.deepEqual(pixelInertnessReasons(null), []);
});

test("G10 every printed bound carries its own derivation", () => {
  const band = deriveFluctuationBand(LIVE_SAMPLES, { label: "live" });
  const line = describeBand(band);
  assert.match(line, /FIRST-PASS DERIVED/);
  // max + range + floor must all be VISIBLE — a bound printed without its terms
  // is the shape this redesign exists to remove.
  assert.match(line, /max .* \+ range .* \+ floor/);
  for (const key of PIXEL_STATISTICS) {
    assert.ok(line.includes(key), `${key} is not printed`);
  }
  assert.match(describeBand({ ok: false, label: "x" }), /NOT DERIVABLE/);
  const detection = foldDetectionLimit(
    band,
    [{ ...CONTROL_LADDER[4], stats: sample(0.34, 0.28, 0.07).stats }],
    { label: "live" },
  );
  assert.match(describeDetection(detection), /detection limit: r5/);
  assert.match(
    describeDetection({ discriminating: false }),
    /NONE — this band rejected no injected control/,
  );
  const fold = foldPixelInertness({
    label: "live",
    bothEndpointsStationary: false,
    identical: false,
    band,
    detection,
    stats: sample(0.34, 0.28, 0.07).stats,
  });
  assert.match(describeInertness(fold), /tier=band verdict=OUTSIDE/);
  assert.match(describeInertness(fold), /EXCEEDED:/);
  assert.match(
    describeInertness({ label: "x", tier: TIER_NONE }),
    /NOT MEASURED/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// H. The redesign, pinned in BOTH probe sources
// ─────────────────────────────────────────────────────────────────────────────

const KERNEL_START = "// ── PIXEL COMPARISON KERNEL";
const KERNEL_END = "// ── END PIXEL COMPARISON KERNEL";

/** The marker-delimited comparison kernel, or null when the markers are gone. */
function extractKernel(source) {
  const a = source.indexOf(KERNEL_START);
  const b = source.indexOf(KERNEL_END);
  if (a < 0 || b < 0 || b < a) {
    return null;
  }
  const end = source.indexOf("\n", b);
  return source.slice(a, end < 0 ? source.length : end + 1);
}

test("H1 the comparison kernel is BYTE-IDENTICAL in both probes", () => {
  const a = extractKernel(consumeSource);
  const b = extractKernel(survivalSource);
  assert.ok(a && a.length > 2000, "the consume probe has no comparison kernel");
  assert.ok(
    b && b.length > 2000,
    "the survival probe has no comparison kernel",
  );
  assert.equal(
    a,
    b,
    "the two probes' pixel kernels have diverged — their bands would be silently incomparable while every printed number still looked plausible",
  );
  // The kernel is what makes the three statistics exist at all.
  for (const key of PIXEL_STATISTICS) {
    assert.ok(a.includes(key), `the kernel does not compute ${key}`);
  }
  // The control perturbation lives INSIDE the kernel and moves AWAY FROM THE
  // CLAMP, so a rung really applies its declared amplitude instead of
  // saturating against 0 or 255 and silently shrinking.
  //
  // MUTANT: a kernel that saturated (or ignored the perturbation entirely)
  // would make every ladder rung read as pure fluctuation, i.e. would report
  // every band as non-discriminating forever.
  pinWithMutant(
    a.replace(/\s+/g, " "),
    /db\[at \+ c\] = v > 127 \? v - perturb\.amplitude : v \+ perturb\.amplitude;/,
    (s) =>
      s.replace(
        "db[at + c] = v > 127 ? v - perturb.amplitude : v + perturb.amplitude;",
        "db[at + c] = v + perturb.amplitude;",
      ),
    "the control perturbation moves away from the clamp",
  );
  assert.match(
    a,
    /if \(perturb\) \{/,
    "the kernel has no control-perturbation branch at all",
  );
});

test("H2 both probes SAMPLE their captures and CAP the retained tail", () => {
  for (const [name, source, flat] of PROBES) {
    assert.ok(
      flat.includes(
        "const samples = [{ png: previousPng, sha: previousSha, executesRun: 0 }];",
      ),
      `${name}: the stationarity gate does not retain its rounds as band samples`,
    );
    pinWithMutant(
      flat,
      /if \(samples\.length > BAND_SAMPLE_CAP\) \{ samples\.shift\(\); \}/,
      (s) =>
        s.replace(
          "if (samples.length > BAND_SAMPLE_CAP) { samples.shift(); }",
          "",
        ),
      `${name}: the retained sample tail is capped`,
    );
    assert.ok(
      source.includes("const BAND_SAMPLE_CAP = BAND_BOUNDS.sampleCap;"),
      `${name}: the cap must come from the shared derivation`,
    );
    // The pair's separation is the LATER sample's executes — that is what makes
    // the anti-vacuity check able to see a frozen window at all.
    assert.ok(
      flat.includes("executes: samples[i].executesRun,"),
      `${name}: a fluctuation sample does not record its execute separation`,
    );
  }
});

test("H3 both probes DERIVE a band, CALIBRATE it, and surface what it could not measure", () => {
  for (const [name, source] of PROBES) {
    for (const anchor of [
      "deriveFluctuationBand(",
      "foldDetectionLimit(",
      "foldPixelInertness(",
      "pixelInertnessReasons(",
      "ladderFor(",
      "sampleFluctuation(",
    ]) {
      assert.ok(source.includes(anchor), `${name} does not call ${anchor}`);
    }
    // Every band is POOLED from both endpoint states — a comparison with one
    // endpoint in each state cannot be judged by one endpoint's fluctuation.
    assert.match(
      source,
      /\.\.\.fluctuation\.\w+, \.\.\.fluctuation\.\w+/,
      `${name}: no cross-state band pools its two endpoints`,
    );
    // A comparison that could not be measured must reach the structural list.
    assert.match(
      source,
      /for \(const reason of pixelInertnessReasons\(/,
      `${name}: an unmeasurable comparison would vanish`,
    );
  }
});

test("H4 the survival probe's identity predicates are TRI-STATE, and the band arm is new", () => {
  // ★ THE MEANING CHANGED, DELIBERATELY. Byte identity keeps its meaning WHERE
  // IT APPLIES and reads NULL — structural, never green — where its own
  // precondition failed. That is the Batch-953 instrument gap.
  pinWithMutant(
    flatSurvival,
    /p\.settledByteIdentityOffOn = inertOffOn\.tier === TIER_STATIONARY \? inertOffOn\.verdict : null;/,
    (s) =>
      s.replace(
        "p.settledByteIdentityOffOn = inertOffOn.tier === TIER_STATIONARY ? inertOffOn.verdict : null;",
        "p.settledByteIdentityOffOn = report.hashes.c1 === report.hashes.c2;",
      ),
    "settledByteIdentityOffOn is gated on the stationary tier",
  );
  assert.ok(
    flatSurvival.includes(
      "p.settledByteIdentityOnOff = inertOnOff.tier === TIER_STATIONARY ? inertOnOff.verdict : null;",
    ),
    "settledByteIdentityOnOff is not gated on the stationary tier",
  );
  // The live-frame form, which is what actually gets measured under keep-live.
  for (const key of [
    "p.pixelInertOffOnWithinBand = inertOffOn.tier === TIER_BAND ? inertOffOn.verdict : null;",
    "p.pixelInertOnOffWithinBand = inertOnOff.tier === TIER_BAND ? inertOnOff.verdict : null;",
  ]) {
    assert.ok(flatSurvival.includes(key), `missing band predicate: ${key}`);
  }
  // A null must route to STRUCTURAL rather than being ignored by the fold.
  assert.ok(
    flatSurvival.includes(
      "const notRun = Object.entries(p) .filter(([, v]) => v === null) .map(([k]) => k);",
    ),
    "the survival probe's fold does not collect NOT-RUN predicates",
  );
  assert.ok(
    flatSurvival.includes(
      "const structural = pre.length > 0 || notRun.length > 0;",
    ),
    "a NOT-RUN predicate must make the run structural",
  );
  // ALL THREE captures are converged and sampled, not just C1 — a bare
  // screenshot endpoint has no fluctuation samples and cannot be banded.
  for (const label of ["flag-off", "flag-on", "flag-off-again"]) {
    assert.ok(
      flatSurvival.includes(`captureStationary(main.page, "${label}")`),
      `the survival probe does not converge-and-sample "${label}"`,
    );
  }
});

test("H5 the survival probe's cross-build bound is no longer a doubled single reading", () => {
  // The old bound was `max(2 x floor, 0.1%)` over ONE cross-page reading. On
  // the Batch-953 run that floor read 29.2%, i.e. a 58% bound — a number no
  // build difference could have exceeded.
  assert.ok(
    !survivalSource.includes("2 * noiseFloor.mismatchFraction"),
    "the doubled-single-reading bound is still in place",
  );
  assert.ok(
    flatSurvival.includes("const crossPageBand = deriveFluctuationBand("),
    "the cross-build arm has no cross-page band",
  );
  assert.ok(
    flatSurvival.includes("const crossPageDetection = foldDetectionLimit("),
    "the cross-page band is not calibrated",
  );
  // The floor is still REPORTED — it is the reader's orientation number — it
  // just no longer IS the bound.
  assert.ok(survivalSource.includes("report.noiseFloor = noiseFloor;"));
  // ★ AND THE STATIONARY TIER IS FORCED OFF FOR THAT ARM. Cross-page byte
  // identity is physically impossible on this subject (each page freezes its
  // own initialization variance into a different fixed point — two same-build
  // pages measured 37.26% apart at the C13-09 certified run), so routing a
  // converged cross-page pair to byte identity would manufacture a guaranteed
  // red out of a test the subject cannot pass.
  const crossBuildFold = survivalSource.slice(
    survivalSource.indexOf("crossBuild = foldPixelInertness({"),
    survivalSource.indexOf("report.preDiff = preDiff;"),
  );
  assert.ok(crossBuildFold.length > 200, "the cross-build fold moved");
  assert.match(
    crossBuildFold,
    /bothEndpointsStationary: false,/,
    "the cross-build arm can still route to the byte-identity tier",
  );
  assert.ok(
    !/bothEndpointsStationary:\s*\n?\s*c1Capture\.stationary/.test(
      crossBuildFold,
    ),
    "the cross-build arm derives its tier from per-page stationarity again",
  );
});

test("H6 the consume probe grew NO visual bar — the row says the composite MAY differ", () => {
  const predicates = consumeSource.slice(
    consumeSource.indexOf("── Predicates ──"),
    consumeSource.indexOf("── Output ──"),
  );
  assert.ok(predicates.length > 500, "the predicate block moved");
  for (const forbidden of [
    "mismatchFraction",
    "diffs.",
    "sizeMismatch",
    "visual",
    "Band",
    "band",
    "inert",
  ]) {
    assert.ok(
      !predicates.includes(forbidden),
      `a visual bound crept into the consume probe's predicate block via "${forbidden}"`,
    );
  }
  // ...but the bands ARE derived, recorded and printed, or the run says nothing.
  assert.ok(
    consumeSource.includes(
      "report.visual = { fluctuation, ladders, comparisons: visual };",
    ),
  );
  assert.ok(consumeSource.includes("describeBand(entry.band)"));
  assert.ok(consumeSource.includes("describeDetection(entry.detection)"));
  assert.ok(consumeSource.includes("describeInertness(entry.fold)"));
});

test("H7 a non-stationary state is no longer structural ON ITS OWN", () => {
  // Under keep-live it is the EXPECTED regime. It becomes structural only via a
  // comparison that ends with no usable tier — which quotes it.
  assert.ok(
    !flatConsume.includes(
      "for (const reason of stationarity.reasons) { structuralReasons.push(reason); }",
    ),
    "the consume probe still routes every non-stationary state straight to structural",
  );
  assert.ok(
    flatConsume.includes("reasons: stationarity.reasons,"),
    "the consume probe no longer RECORDS its stationarity reasons",
  );
  assert.ok(
    flatConsume.includes("stationarityReasons: stationarity.reasons,"),
    "the consume probe does not quote the stationarity reasons into its folds",
  );
  assert.ok(
    !flatSurvival.includes(
      "stationarity precondition failed — two flag-off captures 8 EXECUTES apart never became byte-equal",
    ),
    "the survival probe still fires its old unconditional precondition reason",
  );
  assert.ok(
    flatSurvival.includes("stationarityReasons: stationarityFold.reasons,"),
    "the survival probe does not quote the stationarity reasons into its folds",
  );
});

test("F3 every loop in the shared lib and in both probes is bounded", () => {
  for (const [label, source] of [
    ["lib/cloud-refresh-skip.mjs", libSource],
    [CONSUME_PROBE, consumeSource],
    [SURVIVAL_PROBE, survivalSource],
  ]) {
    const offenders = unboundedLoops(blankNonCode(source));
    assert.deepEqual(
      offenders.map((o) => `${o.kind}(${o.text.trim()})`),
      [],
      `${label} has an unbounded loop`,
    );
  }
  assert.equal(unboundedLoops(blankNonCode("while (true) { f(); }")).length, 1);
});
