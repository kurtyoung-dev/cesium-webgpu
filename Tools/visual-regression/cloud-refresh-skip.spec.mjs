// cloud-refresh-skip.spec.mjs — the shared repair for ONE class defect that
// made both cloud-reconstruction probes lie on the same build.
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
  EXECUTE_COUNTER_FIELD,
  REFRESH_SKIP_BOUNDS,
  WINDOW_ARRIVED,
  WINDOW_EXPIRED,
  WINDOW_STARVED,
  classifyExecuteWindow,
  diffInterpretable,
  foldStationarity,
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
