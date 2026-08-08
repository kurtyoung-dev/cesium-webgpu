// cloud-reconstruction-consume-probe.spec.mjs — the C13-10 Edge acceptance
// probe's OWN structure, pinned at authoring time.
//
// Pure Node (`node --test`). No browser, no build, no adapter.
//
// WHY A PROBE NEEDS A SPEC. Everything this repo has learned the expensive way
// is about instruments, not subjects: a gate differencing a metric pinned at
// its bound, a reachability assertion naming a variable held at zero, a
// "non-interleaved A/B" whose bidirectional deltas were session drift. The
// probe this file guards is the first instrument to measure a CONSUMER of the
// cloud reconstruction set, and its first run will be read as evidence. So the
// properties that make its numbers meaningful are executed here, against
// mutants, before the probe is ever pointed at Edge:
//
//   - THE INTERLEAVE IS REAL. `buildInterleavedSchedule` must produce a
//     schedule a BLOCKED "all of A then all of B" run cannot impersonate, and
//     `describeInterleave` must REJECT the blocked mutant. C13-39's protocol is
//     mandatory for every GPU-timing A/B in this repo precisely because the
//     blocked form once produced impossible results on untouched shaders.
//
//   - A ZEROED TIMING BLOCK IS NOT A MEASUREMENT (C11-146). `readPassTiming`
//     must return null — never 0 — for a profiler that is absent, disabled,
//     sampled nothing, or has no record of the named pass, and a null must
//     propagate to STRUCTURAL rather than into a median.
//
//   - THE 3-vs-2 COMPARISON EXISTS, IN ONE PAGE. `producerTargets` is the
//     counter that proves ownership of the depth slot MOVED. A probe that read
//     only the consume state's 2 would be asserting a number, not a move.
//
//   - THE VISUAL DELTA HAS NO BAR ON THIS RUN, DELIBERATELY. The row says the
//     composite MAY differ; a probe that quietly grew a pixel bound would be
//     failing (or passing) on a threshold nobody derived.
//
//   - MACHINE SAFETY. Watchdog, bounded loops, close-in-finally, and the 0/1/2/3
//     exit contract with FAIL outranking STRUCTURAL.
//
// CRLF: this repo checks out with `core.autocrlf=true`. Every source read here
// is LF-normalized before any anchor is applied.
//
// Run: node --test Tools/visual-regression/cloud-reconstruction-consume-probe.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ARM_A,
  ARM_B,
  PASS_MARCH,
  PASS_PRODUCER,
  PERF_PASS_NAMES,
  MAX_PERF_ITERATIONS,
  buildInterleavedSchedule,
  describeInterleave,
  foldExit,
  pairedDeltas,
  readPassTiming,
  summarize,
} from "./lib/cloud-reconstruction-consume.mjs";
import {
  analyzeProbeSource,
  blankNonCode,
  matchBrace,
} from "./lib/probe-fleet-contract.mjs";
import { PROBE_CONTRACT_ALLOWLIST } from "./lib/probe-fleet-contract-allowlist.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const PROBE_NAME = "probe-cloud-reconstruction-consume.mjs";

const readLf = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const probeSource = readLf(path.join(here, PROBE_NAME));
const libSource = readLf(
  path.join(here, "lib", "cloud-reconstruction-consume.mjs"),
);
/** Whitespace-flattened source: anchors survive Prettier's line wrapping. */
const flat = probeSource.replace(/\s+/g, " ");

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
    headers.push({ kind: m[1], text: code.slice(open + 1, j), index: m.index });
  }
  return headers;
}

/**
 * A loop is BOUNDED when its header carries a comparison against something, or
 * iterates a finite collection. `for (;;)` and `while (true)` are not.
 */
function unboundedLoops(code) {
  return loopHeaders(code).filter((h) => {
    const t = h.text.trim();
    if (t === "" || t === ";;") return true;
    if (/^true$/.test(t)) return true;
    return !/[<>]|\bof\b|\bin\b/.test(t);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// A. The interleave — the C13-39 protocol, executed rather than remembered
// ─────────────────────────────────────────────────────────────────────────────

test("A1 the schedule pairs the arms and alternates their ORDER", () => {
  const schedule = buildInterleavedSchedule(5);
  assert.equal(schedule.length, 10, "5 iterations must be 5 A and 5 B windows");
  const verdict = describeInterleave(schedule);
  assert.equal(verdict.ok, true, verdict.reasons.join("; "));
  assert.equal(verdict.iterations, 5);
  assert.deepEqual(verdict.ordersSeen.sort(), ["AB", "BA"]);
  // Alternating the order inside each iteration gives a boundary pair, and
  // nothing longer: 2 is the maximum run a real interleave can produce.
  assert.equal(verdict.maxRun, 2);
  for (let i = 0; i < 5; i++) {
    const arms = schedule.filter((w) => w.iteration === i).map((w) => w.arm);
    assert.deepEqual(
      [...arms].sort(),
      [ARM_A, ARM_B].sort(),
      `iteration ${i} is not one A and one B`,
    );
  }
});

test("A2 MUTANT — a BLOCKED all-A-then-all-B schedule is REJECTED", () => {
  // This is the exact shape the 2026-07-24 non-interleaved attempt had, and the
  // one that produced bidirectional deltas on shaders the change never touched.
  const blocked = [];
  for (let i = 0; i < 5; i++) blocked.push({ iteration: i, arm: ARM_A });
  for (let i = 0; i < 5; i++) blocked.push({ iteration: i, arm: ARM_B });
  const verdict = describeInterleave(blocked);
  assert.equal(verdict.ok, false, "a blocked schedule passed as interleaved");
  assert.ok(
    verdict.reasons.some((r) => /BLOCKED/.test(r)),
    `the rejection must name the shape: ${verdict.reasons.join("; ")}`,
  );
  assert.equal(verdict.maxRun, 5);
});

test("A3 MUTANT — a fixed-order interleave has no reverse round", () => {
  const fixed = [];
  for (let i = 0; i < 4; i++) {
    fixed.push({ iteration: i, arm: ARM_A, order: "AB" });
    fixed.push({ iteration: i, arm: ARM_B, order: "AB" });
  }
  const verdict = describeInterleave(fixed);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => /reverse-order/.test(r)));
  // ...and the same shape WITH the orders alternated is accepted, so the rule
  // is about the ordering rather than about the count.
  assert.equal(describeInterleave(buildInterleavedSchedule(4)).ok, true);
});

test("A4 MUTANT — an iteration that runs one arm twice is REJECTED", () => {
  const lopsided = [
    { iteration: 0, arm: ARM_A, order: "AB" },
    { iteration: 0, arm: ARM_A, order: "AB" },
    { iteration: 1, arm: ARM_B, order: "BA" },
    { iteration: 1, arm: ARM_A, order: "BA" },
  ];
  const verdict = describeInterleave(lopsided);
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.reasons.some((r) => /iteration 0 is not one A and one B/.test(r)),
  );
});

test("A5 the iteration count is CLAMPED — no unbounded perf run", () => {
  assert.equal(buildInterleavedSchedule(0).length, 2, "0 clamps up to 1 pair");
  assert.equal(buildInterleavedSchedule(-3).length, 2);
  assert.equal(buildInterleavedSchedule(Number.NaN).length, 2);
  assert.equal(
    buildInterleavedSchedule(9999).length,
    MAX_PERF_ITERATIONS * 2,
    "an env var must not be able to request an unbounded run",
  );
  assert.equal(describeInterleave([]).ok, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// B. The zeroed-timing guard (C11-146)
// ─────────────────────────────────────────────────────────────────────────────

const goodTiming = {
  enabled: true,
  frameCount: 60,
  passes: {
    [PASS_MARCH]: { avgMs: 1.25, minMs: 1.1, maxMs: 1.4, lastMs: 1.2 },
    [PASS_PRODUCER]: { avgMs: 0.08, minMs: 0.07, maxMs: 0.09, lastMs: 0.08 },
  },
};

test("B1 a real window reports the pass, with its window frame count", () => {
  const timing = readPassTiming(goodTiming, PASS_MARCH);
  assert.equal(timing.avgMs, 1.25);
  assert.equal(timing.frameCount, 60);
});

test("B2 EVERY blind case returns NULL — never a zero that reads as free", () => {
  const zeroed = {
    enabled: true,
    frameCount: 60,
    passes: {
      [PASS_MARCH]: { avgMs: 0, minMs: 0, maxMs: 0, lastMs: 0 },
    },
  };
  const cases = {
    "no results at all": [null, PASS_MARCH],
    "profiler disabled": [{ ...goodTiming, enabled: false }, PASS_MARCH],
    "nothing sampled": [{ ...goodTiming, frameCount: 0 }, PASS_MARCH],
    "pass absent from the ledger": [goodTiming, "SomeOther pass"],
    "all-zero timing block": [zeroed, PASS_MARCH],
    "non-finite timing": [
      {
        enabled: true,
        frameCount: 4,
        passes: { [PASS_MARCH]: { avgMs: NaN, minMs: 0, maxMs: 1, lastMs: 1 } },
      },
      PASS_MARCH,
    ],
  };
  for (const [label, [results, name]] of Object.entries(cases)) {
    const value = readPassTiming(results, name);
    assert.equal(value, null, `${label} produced a timing instead of null`);
    assert.notEqual(value, 0, `${label} must not read as 0 ms`);
  }
});

test("B3 a null NEVER enters a median — it is dropped and counted", () => {
  assert.equal(summarize([null, null]), null, "an all-blind arm has no median");
  const partial = summarize([1, null, 3, Number.NaN]);
  assert.equal(partial.n, 2);
  assert.equal(partial.dropped, 2);
  assert.equal(partial.median, 2);
  assert.equal(partial.min, 1);
  assert.equal(partial.max, 3);
  assert.equal(partial.spread, 2);
});

test("B4 the PAIRED delta drops an incomplete pair rather than half-counting", () => {
  const result = pairedDeltas([
    { iteration: 0, a: 1.0, b: 1.4 },
    { iteration: 1, a: 2.0, b: null },
    { iteration: 2, a: 1.0, b: 0.8 },
  ]);
  assert.equal(result.droppedPairs, 1);
  assert.deepEqual(
    result.deltas.map((d) => Number(d.delta.toFixed(6))),
    [0.4, -0.2],
  );
  // The paired median is what survives session drift; assert it is computed
  // over the DELTAS, not over the arms separately.
  assert.equal(Number(result.summary.median.toFixed(6)), 0.1);
  assert.equal(pairedDeltas([]).summary, null);
});

test("B5 the perf lane's pass labels are the ENGINE's registered labels", () => {
  // A renamed pass would otherwise make every window's timing null, and the
  // probe would report STRUCTURAL forever without saying why.
  const observability = readLf(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUCloudObservability.ts",
    ),
  );
  const table = observability.slice(
    observability.indexOf("CLOUD_TIMED_PASS_NAMES"),
    observability.indexOf("CLOUD_ENVIRONMENT_TIMED_PASS_NAMES"),
  );
  assert.ok(table.length > 0);
  for (const name of PERF_PASS_NAMES) {
    assert.ok(
      table.includes(`"${name}"`),
      `${name} is not a registered timed cloud pass`,
    );
  }
  assert.ok(
    PERF_PASS_NAMES.includes(PASS_MARCH) &&
      PERF_PASS_NAMES.includes(PASS_PRODUCER),
    "the row requires the march and the producer reported SEPARATELY",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// C. The fold — FAIL outranks STRUCTURAL, and "did not run" is not green
// ─────────────────────────────────────────────────────────────────────────────

test("C1 all green is exit 0", () => {
  const fold = foldExit({
    predicates: { a: true, b: true },
    structuralReasons: [],
  });
  assert.deepEqual(fold, {
    exitCode: 0,
    failed: [],
    notRun: [],
    structural: false,
  });
});

test("C2 a RED predicate outranks a structural reason", () => {
  const fold = foldExit({
    predicates: { a: true, b: false },
    structuralReasons: ["the perf arm did not run"],
  });
  assert.equal(fold.exitCode, 1);
  assert.deepEqual(fold.failed, ["b"]);
  assert.equal(fold.structural, true, "the structural state is still reported");
});

test("C3 a predicate that DID NOT RUN is structural, not green", () => {
  const fold = foldExit({
    predicates: { a: true, dInterleaveIsRealInterleave: null },
    structuralReasons: [],
  });
  assert.equal(fold.exitCode, 3);
  assert.deepEqual(fold.notRun, ["dInterleaveIsRealInterleave"]);
});

test("C4 structural reasons alone are exit 3", () => {
  assert.equal(
    foldExit({ predicates: { a: true }, structuralReasons: ["no timestamps"] })
      .exitCode,
    3,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// D. The probe's structure — anchored in its source
// ─────────────────────────────────────────────────────────────────────────────

test("D1 BOTH producerTargets states are measured, IN ONE PAGE", () => {
  // The attachments-only window is what makes 2 a MOVE rather than a number.
  pinWithMutant(
    flat,
    /phase\(main\.page, \{ label: "attachments-only", toggle: \{ attachments: true, reconstruction: false \}, until: "produced", \}\)/,
    (s) =>
      s.replace(
        'phase(main.page, { label: "attachments-only", toggle: { attachments: true, reconstruction: false }, until: "produced", })',
        'phase(main.page, { label: "attachments-only", until: "produced", })',
      ),
    "the attachments-only comparison window runs on the main page",
  );
  assert.match(
    flat,
    /phase\(main\.page, \{ label: "consume", toggle: \{ reconstruction: true \}, until: "consumed", \}\)/,
    "the consume window must run on the SAME page — a second page has its own temporal fixed point",
  );
  for (const anchor of [
    "p.attachmentsOnlyProducerTargets3 = emA !== null && emA.producerTargets === 3",
    "p.bProducerTargets2 = emB !== null && emB.producerTargets === 2",
  ]) {
    assert.ok(
      flat.includes(anchor.replace(/\s+/g, " ")),
      `missing predicate: ${anchor}`,
    );
  }
  // ...and the MOVE predicate must read both sides, or it is two separate
  // assertions wearing one name.
  const moved = flat.slice(
    flat.indexOf("p.bProducerTargetsMovedThreeToTwo"),
    flat.indexOf("p.bLiveBytesExact"),
  );
  assert.ok(moved.includes("emA") && moved.includes("emB"), moved);
  assert.ok(moved.includes("=== 3") && moved.includes("=== 2"), moved);
});

test("D2 the counter predicates are the ones the row pre-registered", () => {
  for (const anchor of [
    "p.bRequestedResident",
    "p.bEmitted",
    "p.bConsumed",
    "p.bLiveBytesExact",
    "p.bLiveBytesUnchangedAcrossFlip",
    "p.bPassTopologyUnchanged",
    "p.zeroErrors",
    "p.gateArmed",
    "p.cGenerationMonotonic",
    "p.cLiveBytesTrackSize",
    "p.cResizeReengagesBothWays",
    "p.cFullResTierProducesNothing",
    "p.cReturnToLowReengages",
  ]) {
    assert.ok(probeSource.includes(anchor), `missing predicate: ${anchor}`);
  }
  // The byte figure is the owned 24 B/texel, never the 32 B contract total.
  assert.match(probeSource, /BYTES_PER_TEXEL_OWNED = 24;/);
  assert.ok(
    !/BYTES_PER_TEXEL[A-Z_]* = 32/.test(probeSource),
    "24 B/texel is the row's own footprint; 32 would fold in the shared colour target",
  );
});

test("D3 THE VISUAL DELTA CARRIES NO BAR ON THIS RUN", () => {
  const predicates = probeSource.slice(
    probeSource.indexOf("── Predicates ──"),
    probeSource.indexOf("── Output ──"),
  );
  assert.ok(predicates.length > 500, "the predicate block moved");
  for (const forbidden of ["mismatchFraction", "diffs.", "sizeMismatch"]) {
    assert.ok(
      !predicates.includes(forbidden),
      `a pixel bound crept into the predicate block via "${forbidden}" — the row says the composite MAY differ, and no bound has been derived`,
    );
  }
  // The diffs must still be RECORDED and PRINTED, or the run says nothing about
  // the first consumer's visual effect at all.
  assert.match(probeSource, /report\.diffs = diffs;/);
  assert.match(probeSource, /attachmentsVsConsume: await pixelDiff\(/);
  assert.match(probeSource, /consumeSelfFloor: await pixelDiff\(/);
  // MUTANT: a bar added to the predicate block must be caught by this test.
  const mutated = predicates.replace(
    "p.gateArmed",
    "p.visualWithinBound = diffs.attachmentsVsConsume.mismatchFraction < 0.01;\n  p.gateArmed",
  );
  assert.ok(
    ["mismatchFraction", "diffs."].some((f) => mutated.includes(f)),
    "the mutant did not apply",
  );
});

test("D4 canvas pixels come from ELEMENT SCREENSHOTS, never from the canvas", () => {
  // In-page `drawImage` from a WebGPU canvas copies transparent black even in
  // the same task — the C13-09 run established this the hard way.
  assert.match(
    probeSource,
    /\.locator\("\.cesium-widget canvas"\)\.first\(\)\.screenshot\(/,
  );
  assert.ok(!probeSource.includes("toDataURL"), "no canvas readback");
  const drawImages = [...probeSource.matchAll(/drawImage\(([^)]*)\)/g)].map(
    (m) => m[1].trim(),
  );
  assert.deepEqual(
    drawImages,
    ["bitmap, 0, 0"],
    "the only drawImage may be the PNG decode on the scratch page",
  );
});

test("D5 readiness gates on marchPixels > 0, not on a frame count", () => {
  pinWithMutant(
    flat,
    /snap\?\.raymarch\?\.halfResActive === true && \(snap\?\.raymarch\?\.pixelsDispatched \?\? 0\) > 0/,
    (s) =>
      s.replace(
        "snap?.raymarch?.halfResActive === true && (snap?.raymarch?.pixelsDispatched ?? 0) > 0",
        "snap?.raymarch?.halfResActive === true",
      ),
    "the readiness gate requires the march to be DISPATCHING",
  );
});

test("D6 counters are read through a BOUNDED consistency window", () => {
  // The bound is denominated in ENGINE EXECUTES and comes from the shared
  // refresh-skip derivation — a render call under `requestRenderMode` is not
  // a frame, which is what made this window expire against a frozen snapshot
  // at Batch 944. See `lib/cloud-refresh-skip.mjs`.
  assert.match(
    probeSource,
    /PUBLISH_LAG_MAX = REFRESH_SKIP_BOUNDS\.publishLagExecutes;/,
  );
  pinWithMutant(
    flat,
    /for \(; publishLagExecutes < publishLagMax; publishLagExecutes\+\+\) \{ if \(coherent\(snap\)\) break;/,
    (s) =>
      s.replace(
        "for (; publishLagExecutes < publishLagMax; publishLagExecutes++) { if (coherent(snap)) break;",
        "while (!coherent(snap)) { ",
      ),
    "the publish-lag window is bounded and records its own latency",
  );
  assert.ok(
    flat.includes("publishLagExecutes,"),
    "the observed latency must be REPORTED, not just waited out",
  );
  // Every `until` condition carries its own EXECUTE budget.
  assert.match(probeSource, /UNTIL_LIMITS = Object\.freeze\(\{/);
  for (const key of [
    "produced",
    "consumed",
    "released",
    "notEmitting",
    "resized",
  ]) {
    assert.match(
      probeSource,
      new RegExp(`${key}: \\d+,`),
      `${key} has no bound`,
    );
  }
});

test("D7 the perf window verifies its ARM held, outside the measured span", () => {
  // A window that silently measured the wrong flag state is worse than no
  // measurement: it is a number with the wrong label.
  assert.ok(flat.includes("dbg.cloudReconstruction(arm !== armA)"));
  const measure = probeSource.slice(
    probeSource.indexOf("async function measurePerfWindow"),
    probeSource.indexOf("function timingArmHeld"),
  );
  // Three spans in order: warm (settle), verify (sample), measure (time). The
  // measured span now opens on the RE-ARM (`gpuPassCost(true)`, which resets
  // the profiler) rather than on a bare `profiler.reset()` — the Batch-944 run
  // proved a reset alone cannot tell you the arm survived the window.
  const verifyStart = measure.indexOf("for (let i = 0; i < verifyFrames; i++)");
  const measureStart = measure.indexOf(
    "for (let i = 0; i < measureFrames; i++)",
  );
  const reArmStart = measure.lastIndexOf("dbg.gpuPassCost(true);");
  assert.ok(verifyStart > 0, "the verify span is gone");
  assert.ok(measureStart > 0, "the measured span is gone");
  assert.ok(
    reArmStart > verifyStart && reArmStart < measureStart,
    "the timing surface must be re-armed between the verify and measured spans",
  );
  assert.ok(
    measure.indexOf("emittedFrames++") > verifyStart &&
      measure.indexOf("emittedFrames++") < measureStart,
    "verdict sampling belongs to the VERIFY span: sampling the warm span records the flag transition, sampling the measured span times the instrument",
  );
  // The MEASURED span must contain nothing but KEPT-LIVE renders — `snapNow()`
  // calls `getRendererStatistics()`, which is allocation-bearing by design.
  const measuredLoop = measure.slice(
    measureStart,
    measure.indexOf("// Same-task read"),
  );
  assert.ok(measuredLoop.includes("renderLive();"));
  assert.ok(
    !measuredLoop.includes("snapNow()"),
    "a snapshot read inside the timing window times the instrument, not the pass",
  );
  assert.match(probeSource, /PERF_VERIFY_FRAMES = \d+;/);
  assert.ok(
    measure.slice(measureStart).includes("drainPendingReadbacks"),
    "in-flight readbacks are real samples and must be drained, not dropped",
  );
  assert.ok(
    probeSource.includes("PERF ARM UNVERIFIED"),
    "an unverified arm must be named STRUCTURAL rather than silently reported",
  );
  assert.ok(
    probeSource.includes("PERF ARM SKIPPED-BY-CONFIGURATION"),
    "a run without --perf must SAY that Leg D did not run",
  );
  // The arm check must read the VERIFY counts, not just a single final frame.
  const armCheck = probeSource.slice(
    probeSource.indexOf("const armsHeld = windows.filter("),
    probeSource.indexOf("PERF ARM UNVERIFIED"),
  );
  for (const field of [
    "marchActiveFrames",
    "emittedFrames",
    "consumedFrames",
    "producerTargetsSeen",
    "commandsPresent",
  ]) {
    assert.ok(armCheck.includes(field), `the arm check ignores ${field}`);
  }
});

test("D9 the probe routes through the SHARED refresh-skip repair", () => {
  // The three Batch-944 instrument defects (mid-convergence captures, a resize
  // window the stale state satisfied, a perf lane that never saw a frame) are
  // one mechanism, and it belongs to both cloud reconstruction probes. Its
  // rules and their mutants live in `cloud-refresh-skip.spec.mjs`; this pin
  // exists so removing the import fails HERE too, rather than leaving that
  // spec passing against a probe that no longer uses it.
  assert.match(
    probeSource,
    /from "\.\/lib\/cloud-refresh-skip\.mjs"/,
    "the shared refresh-skip repair is no longer imported",
  );
  for (const symbol of [
    "classifyExecuteWindow",
    "diffInterpretable",
    "foldStationarity",
    "renderCallBudget",
    "starvedWindowReasons",
  ]) {
    assert.ok(probeSource.includes(symbol), `${symbol} is no longer used`);
  }
  assert.ok(
    probeSource.includes("captureStationary(main.page,"),
    "each captured state must converge under its own stationarity gate",
  );
  assert.ok(
    probeSource.includes("PERF WINDOW DISCARDED"),
    "a perf window whose timing arm dropped must be discarded and NAMED",
  );
});

test("D8 device loss is declared OUT OF SCOPE rather than silently omitted", () => {
  assert.match(
    probeSource,
    /DEVICE LOSS IS OUT OF SCOPE/,
    "the row asks for device loss in leg C; the honest form is a written scope note, not an absent arm",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Machine safety — the fleet contract, without an allowlist entry
// ─────────────────────────────────────────────────────────────────────────────

test("E1 the probe satisfies the fleet contract and is NOT allowlisted", () => {
  const analysis = analyzeProbeSource(probeSource);
  assert.deepEqual(analysis.violations, []);
  assert.equal(analysis.hasWatchdog, true);
  assert.equal(analysis.closeInFinally, true);
  assert.equal(analysis.declaresStructuralExit, true);
  assert.deepEqual(analysis.structuralRoutedToTwo, []);
  assert.ok(
    !Object.hasOwn(PROBE_CONTRACT_ALLOWLIST, PROBE_NAME),
    "the allowlist is closed and shrink-only — a new probe must satisfy the contract",
  );
});

test("E2 MUTANT — removing the watchdog is detected", () => {
  const mutated = probeSource.replace(/setTimeout\(/, "queueMicrotask(");
  assert.notEqual(mutated, probeSource);
  const analysis = analyzeProbeSource(mutated);
  assert.equal(analysis.hasWatchdog, false);
  assert.ok(analysis.violations.includes("no watchdog"));
});

test("E3 every loop in the probe AND its lib is bounded", () => {
  for (const [label, source] of [
    ["probe", probeSource],
    ["lib", libSource],
  ]) {
    const offenders = unboundedLoops(blankNonCode(source));
    assert.deepEqual(
      offenders.map((o) => `${o.kind}(${o.text.trim()})`),
      [],
      `${label} has an unbounded loop`,
    );
  }
  // MUTANT: the detector must actually detect.
  assert.equal(
    unboundedLoops(blankNonCode("for (;;) { render(); }")).length,
    1,
    "for(;;) escaped the bounded-loop scan",
  );
  assert.equal(
    unboundedLoops(blankNonCode("while (true) { render(); }")).length,
    1,
    "while(true) escaped the bounded-loop scan",
  );
  assert.equal(
    unboundedLoops(blankNonCode("for (const x of list) { f(x); }")).length,
    0,
  );
});

test("E4 one browser, sequential pages, every page closed", () => {
  assert.equal(
    (probeSource.match(/chromium\.launch\(/g) ?? []).length,
    1,
    "two Edge instances at once is the machine-safety rule this fleet runs under",
  );
  for (const anchor of [
    "main.page.close()",
    "scratch.close()",
    "perfPage.page.close()",
  ]) {
    assert.ok(probeSource.includes(anchor), `${anchor} is missing`);
  }
  assert.match(probeSource, /await browser\.close\(\)\.catch\(\(\) => \{\}\);/);
});

test("E5 the exit contract is 0/1/2/3 with FAIL outranking STRUCTURAL", () => {
  assert.match(
    probeSource,
    /PASS: 0,\s*FAIL: 1,\s*HARNESS: 2,\s*STRUCTURAL: 3,/,
  );
  assert.ok(
    probeSource.includes(
      "const fold = foldExit({ predicates: p, structuralReasons })",
    ),
    "the verdict must come from the tested fold, not from an inline re-derivation",
  );
  // The 0/1/2/3 meanings are asserted on the FOLD in group C; here we only
  // require the probe to route through it and to exit with its code.
  assert.match(probeSource, /process\.exit\(exitCode\);/);
});

test("E6 PROBE_BASE defaults to 8080 and --perf is opt-in", () => {
  assert.match(
    probeSource,
    /process\.env\.PROBE_BASE \|\| "http:\/\/localhost:8080"/,
  );
  assert.match(probeSource, /process\.argv\.includes\("--perf"\)/);
  // A perf run must not be able to request an unbounded number of frames.
  assert.match(
    probeSource,
    /Math\.min\(240, Number\(process\.env\.C13_10_PERF_FRAMES/,
  );
});

test("E7 the report holds no image buffers", () => {
  // Memory discipline: PNGs are written incrementally and only their hashes and
  // diff fractions survive into the JSON.
  const reportWrites = [...probeSource.matchAll(/report\.\w+ = ([^;]+);/g)].map(
    (m) => m[1],
  );
  for (const value of reportWrites) {
    // A PNG may reach the report only through a DIGEST — `sha(pngX)` folds a
    // megabyte to 64 characters; `pngX` itself would base64 the whole buffer
    // into the JSON.
    const withoutDigests = value.replace(/sha\([^)]*\)/g, "sha()");
    assert.ok(
      !/png[A-Z]/.test(withoutDigests),
      `a PNG buffer is being stored in the report: ${value}`,
    );
  }
  // MUTANT: the scan must still catch a raw buffer.
  assert.ok(
    /png[A-Z]/.test("{ raw: pngConsume }".replace(/sha\([^)]*\)/g, "sha()")),
    "the digest exemption swallowed a raw buffer",
  );
  assert.match(probeSource, /report\.hashes = \{/);
  assert.ok(
    matchBrace(probeSource, probeSource.indexOf("report.hashes = {") + 16) > 0,
    "the hash block must be well-formed",
  );
});
