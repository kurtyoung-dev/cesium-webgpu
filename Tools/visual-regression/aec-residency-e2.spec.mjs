// aec-residency-e2.spec.mjs — behaviour contract for everything the E-2
// residency instrument computes without a browser.
//
// @purpose Executes the real E-2 trace-clock bridge, GPU-process gap attribution, shader-module census arithmetic, animation-frame gap derivation and control matrix against synthetic and adversarial inputs, with inertness mutants for each refusal.
// @status ACTIVE
//
// WHY THESE PARTS AND NOT OTHERS. The browser half of E-2 cannot be exercised
// here — there is no GPU in this lane and no Edge. What CAN be exercised is
// every decision the receipt's conclusions rest on: whether the trace clock was
// related to the page clock at all, which process's work covered a frame gap
// and for how long, how much WGSL the device had been handed by the time the
// first gap opened, and whether a control differs from the baseline along the
// one dimension it claims. Each of those is a pure function over data, and each
// of them can be wrong in a way that produces a confident, plausible, false
// receipt.
//
// THE ASSERTIONS ARE ABOUT BEHAVIOUR. Nothing below greps the module's source
// for a construct. The refusals are asserted by CONSTRUCTING the situation that
// must be refused — a trace with no clock-sync marker, two markers that
// disagree, a trace with no GPU process — and requiring the refusal to come
// back. The attributions are asserted by building intervals whose overlap with
// a gap is known by arithmetic done here, independently of the module.
//
// THE MUTANTS MAKE THE CODE UNREACHABLE, NOT ABSENT. Deleting a check is the
// easy mutation and most tests survive it because the deletion changes some
// other shape too. Each mutant here leaves the reading computed and reported
// and only stops it reaching the decision, which is the shape a real regression
// takes.
//
// Run: node --test Tools/visual-regression/aec-residency-e2.spec.mjs

import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  E2_CONTROLS,
  E2_CONTROL_ORDER,
  E2_TRACE_CATEGORIES,
  buildControlMatrix,
  buildE2MarkdownSummary,
  buildE2Receipt,
  buildTraceClockBridge,
  deriveAnimationFrameGaps,
  identifyTraceProcesses,
  pidsForRole,
  resolveControl,
  summarizeGapTraceOverlap,
  summarizeShaderModuleCensus,
  traceIntervalsOnPageClock,
} from "./lib/aec-residency-e2.mjs";
import { analyzeReceipt } from "./lib/aec-residency-stall-locus.mjs";
import { mutateOrFail } from "./lib/engine-stub-bundler.mjs";
import { TILESETS, pageModule } from "./probe-aec-residency-e1.mjs";
import {
  closeTraceOnce,
  firstGapStartOf,
  parseE2Args,
  readTraceEvents,
  reportFailure,
  runLegPlan,
  watchdogBudgetMs,
} from "./probe-aec-residency-e2.mjs";
import { E1RefusalError, EXIT_CODES } from "./lib/aec-residency-e1.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(HERE, "lib/aec-residency-e2.mjs");
const SIBLING_PATH = resolve(HERE, "lib/aec-residency-stall-locus.mjs");

// The trace clock runs on its own origin; nothing relates it to the page clock
// but the markers. A large, ugly offset is used deliberately so a bridge that
// silently assumed the two clocks were the same would be off by minutes rather
// than by a rounding error.
const TRACE_ORIGIN_MS = 987654.321;

/**
 * A clock-sync marker as Chrome writes one, at a page time of `pageMs`.
 *
 * @param {string} syncId The marker id.
 * @param {number} pageMs The page timestamp it was requested at.
 * @param {number} [skewMs] Deliberate disagreement with the trace origin.
 * @returns {object} A trace event.
 */
function clockSync(syncId, pageMs, skewMs = 0) {
  return {
    ph: "c",
    name: "clock_sync",
    cat: "__metadata",
    pid: 1,
    tid: 1,
    ts: (TRACE_ORIGIN_MS + pageMs + skewMs) * 1000,
    args: { sync_id: syncId },
  };
}

/**
 * A complete trace event covering `[startMs, startMs + durMs)` on the page
 * clock.
 *
 * @param {object} input The event's fields.
 * @returns {object} A trace event.
 */
function completeEvent({
  name,
  cat = "gpu",
  pid = 2,
  tid = 3,
  startMs,
  durMs,
}) {
  return {
    ph: "X",
    name,
    cat,
    pid,
    tid,
    ts: (TRACE_ORIGIN_MS + startMs) * 1000,
    dur: durMs * 1000,
  };
}

/** Process metadata naming pid 2 the GPU process and pid 1 the browser. */
const PROCESS_METADATA = [
  { ph: "M", name: "process_name", pid: 1, tid: 1, args: { name: "Browser" } },
  {
    ph: "M",
    name: "process_name",
    pid: 2,
    tid: 1,
    args: { name: "GPU Process" },
  },
  { ph: "M", name: "process_name", pid: 3, tid: 1, args: { name: "Renderer" } },
];

const ANCHORS = [
  { syncId: "open", pageMs: 0 },
  { syncId: "close", pageMs: 100000 },
];

/** One gap, ten seconds long, opening at page time 20 s. */
const GAP = { startMs: 20000, endMs: 30000, durationMs: 10000 };

// ── A. the controls ─────────────────────────────────────────────────────────

test("A1: every control but the baseline names its own single dimension", () => {
  const dimensions = [];
  for (const name of E2_CONTROL_ORDER) {
    const control = E2_CONTROLS[name];
    assert.ok(control, `${name} must be defined`);
    if (name === "baseline") {
      assert.equal(control.dimension, null);
      continue;
    }
    assert.equal(typeof control.dimension, "string");
    dimensions.push(control.dimension);
  }
  assert.equal(
    new Set(dimensions).size,
    dimensions.length,
    "two controls sharing a dimension cannot attribute a moved settle time",
  );
});

test("A2: the baseline is E-1's own scene, byte for byte", () => {
  const withoutConfig = pageModule("/e.js", "/b/", "webgpu", TILESETS);
  const asBaseline = pageModule("/e.js", "/b/", "webgpu", TILESETS, {
    ...E2_CONTROLS.baseline.pageConfig,
  });
  assert.equal(
    asBaseline,
    withoutConfig,
    "the baseline must add nothing to the scene E-1 measured, or the two " +
      "measurements are not of the same thing",
  );
  assert.equal(
    resolveControl("baseline", TILESETS).tilesets.length,
    TILESETS.length,
  );
});

test("A3: each control changes the page only along its own dimension", () => {
  const render = (name) => {
    const control = resolveControl(name, TILESETS);
    return pageModule("/e.js", "/b/", "webgpu", control.tilesets, {
      ...control.pageConfig,
    });
  };
  const baseline = render("baseline");
  const aoOff = render("ao-off");
  const noPrewarm = render("no-globe-prewarm");
  const oneTileset = render("one-tileset");

  assert.ok(baseline.includes("ao.enabled = true"));
  assert.ok(
    !aoOff.includes("ao.enabled = true"),
    "the ambient-occlusion control must not enable the stage",
  );
  assert.equal(
    aoOff.includes("prewarmGlobeRenderer"),
    false,
    "the ambient-occlusion control must not also touch the globe warm",
  );

  assert.ok(!baseline.includes("prewarmGlobeRenderer"));
  assert.ok(
    noPrewarm.includes("prewarmGlobeRenderer: false"),
    "the globe-warm control must decline the warm through the context option",
  );
  assert.ok(
    noPrewarm.includes("ao.enabled = true"),
    "the globe-warm control must leave ambient occlusion alone",
  );

  const descriptorsOf = (source) =>
    JSON.parse(source.match(/e1\.descriptors = (\[.*\]);/)[1]);
  assert.equal(descriptorsOf(baseline).length, TILESETS.length);
  assert.equal(descriptorsOf(oneTileset).length, 1);
  assert.deepEqual(
    descriptorsOf(oneTileset)[0].clipPositions,
    descriptorsOf(baseline)[0].clipPositions,
    "the single-tileset control keeps the demo's site clip, which is a " +
      "shader-variant axis and therefore part of the scene",
  );
});

test("A4: an unknown control is refused rather than silently defaulted", () => {
  assert.throws(() => resolveControl("no-such-control", TILESETS), TypeError);
});

test("A5: the control matrix reports deltas, and refuses when it cannot", () => {
  const matrix = buildControlMatrix([
    { control: "baseline", reached: true, readyMs: 90000 },
    { control: "ao-off", reached: true, readyMs: 60000 },
    { control: "one-tileset", reached: false, readyMs: null },
  ]);
  assert.equal(matrix.comparable, true);
  assert.equal(matrix.baselineMs, 90000);
  const byName = Object.fromEntries(
    matrix.rows.map((row) => [row.control, row]),
  );
  assert.equal(byName["ao-off"].deltaMs, -30000);
  assert.equal(
    byName["one-tileset"].deltaMs,
    null,
    "a control that never became ready has no settle time, and the probe's " +
      "deadline must not stand in for one",
  );
  assert.equal(byName["ao-off"].dimension, "ambient-occlusion");

  const noBaseline = buildControlMatrix([
    { control: "ao-off", reached: true, readyMs: 1 },
  ]);
  assert.equal(noBaseline.comparable, false);
  assert.equal(noBaseline.reason, "no-baseline-leg");

  const deadBaseline = buildControlMatrix([
    { control: "baseline", reached: false, readyMs: null },
  ]);
  assert.equal(deadBaseline.comparable, false);
  assert.equal(deadBaseline.reason, "baseline-never-reached-readiness");
});

// ── B. the clock bridge ─────────────────────────────────────────────────────

test("B1: two agreeing markers recover the offset between the clocks", () => {
  const bridge = buildTraceClockBridge(
    [clockSync("open", 0), clockSync("close", 100000)],
    ANCHORS,
  );
  assert.equal(bridge.bridged, true);
  assert.equal(bridge.anchorsFound, 2);
  assert.ok(Math.abs(bridge.traceOriginMs - TRACE_ORIGIN_MS) < 1e-6);
  assert.ok(bridge.maxResidualMs < 1e-6);
});

test("B2: a trace with no marker is not bridged and says which is missing", () => {
  const bridge = buildTraceClockBridge(
    [completeEvent({ name: "x", startMs: 0, durMs: 1 })],
    ANCHORS,
  );
  assert.equal(bridge.bridged, false);
  assert.equal(bridge.reason, "no-clock-sync-marker-in-trace");
  assert.equal(bridge.traceOriginMs, null);
});

test("B3: one marker gives an offset with nothing to check it, and is refused", () => {
  const bridge = buildTraceClockBridge([clockSync("open", 0)], ANCHORS);
  assert.equal(bridge.bridged, false);
  assert.equal(bridge.reason, "too-few-clock-sync-anchors");
  assert.equal(
    bridge.traceOriginMs,
    null,
    "an unchecked offset must not be published; a wrong one attributes gaps " +
      "to whatever happened somewhere else",
  );
});

test("B4: markers that disagree are refused, with the disagreement reported", () => {
  const bridge = buildTraceClockBridge(
    [clockSync("open", 0), clockSync("close", 100000, 4000)],
    ANCHORS,
  );
  assert.equal(bridge.bridged, false);
  assert.equal(bridge.reason, "clock-sync-anchors-disagree");
  assert.ok(bridge.maxResidualMs > 3900 && bridge.maxResidualMs < 4100);
});

test("B5: a marker under either spelling of the sync id is found", () => {
  const events = [
    { ...clockSync("open", 0), args: { syncId: "open" } },
    clockSync("close", 100000),
  ];
  assert.equal(buildTraceClockBridge(events, ANCHORS).bridged, true);
});

// ── C. attributing a gap to the work that covered it ────────────────────────

test("C1: an event spanning a gap is ranked first, with the overlap it had", () => {
  const events = [
    ...PROCESS_METADATA,
    clockSync("open", 0),
    clockSync("close", 100000),
    completeEvent({ name: "LongWait", startMs: 19000, durMs: 12000 }),
    completeEvent({ name: "Blip", startMs: 21000, durMs: 100 }),
  ];
  const summary = summarizeGapTraceOverlap({
    traceEvents: events,
    gaps: [GAP],
    bridge: buildTraceClockBridge(events, ANCHORS),
  });
  assert.equal(summary.attributed, true);
  const [gap] = summary.gaps;
  assert.equal(gap.gapMs, 10000);
  assert.equal(gap.topEvents[0].name, "LongWait");
  assert.equal(
    gap.topEvents[0].overlapMs,
    10000,
    "an event that starts before the gap and ends after it overlaps the whole gap",
  );
  assert.ok(Math.abs(gap.topEvents[0].gapCoverage - 1) < 1e-9);
  assert.equal(gap.topEvents[1].name, "Blip");
  assert.equal(gap.topEvents[1].overlapMs, 100);
});

test("C2: an event only partly inside the gap contributes only that part", () => {
  const events = [
    ...PROCESS_METADATA,
    clockSync("open", 0),
    clockSync("close", 100000),
    completeEvent({ name: "Straddle", startMs: 18000, durMs: 4000 }),
  ];
  const summary = summarizeGapTraceOverlap({
    traceEvents: events,
    gaps: [GAP],
    bridge: buildTraceClockBridge(events, ANCHORS),
  });
  assert.equal(summary.gaps[0].topEvents[0].overlapMs, 2000);
});

test("C3: work in another process is not attributed to a GPU-process gap", () => {
  const events = [
    ...PROCESS_METADATA,
    clockSync("open", 0),
    clockSync("close", 100000),
    completeEvent({
      name: "RendererWork",
      pid: 3,
      startMs: 20000,
      durMs: 9000,
    }),
    completeEvent({ name: "GpuWork", pid: 2, startMs: 20000, durMs: 500 }),
  ];
  const summary = summarizeGapTraceOverlap({
    traceEvents: events,
    gaps: [GAP],
    bridge: buildTraceClockBridge(events, ANCHORS),
  });
  assert.deepEqual(
    summary.gaps[0].topEvents.map((row) => row.name),
    ["GpuWork"],
    "the renderer's own work is exactly what E-1 already showed was healthy; " +
      "attributing it here would re-answer the question this instrument exists to move past",
  );
  assert.deepEqual(summary.pids, [2]);
});

test("C4: an unbridged clock attributes nothing at all", () => {
  const events = [
    ...PROCESS_METADATA,
    completeEvent({ name: "LongWait", startMs: 19000, durMs: 12000 }),
  ];
  const summary = summarizeGapTraceOverlap({
    traceEvents: events,
    gaps: [GAP],
    bridge: buildTraceClockBridge(events, ANCHORS),
  });
  assert.equal(summary.attributed, false);
  assert.equal(summary.reason, "no-clock-sync-marker-in-trace");
  assert.deepEqual(summary.gaps, []);
});

test("C5: a trace with no GPU process refuses instead of falling back to all processes", () => {
  const events = [
    {
      ph: "M",
      name: "process_name",
      pid: 3,
      tid: 1,
      args: { name: "Renderer" },
    },
    clockSync("open", 0),
    clockSync("close", 100000),
    completeEvent({
      name: "RendererWork",
      pid: 3,
      startMs: 20000,
      durMs: 9000,
    }),
  ];
  const summary = summarizeGapTraceOverlap({
    traceEvents: events,
    gaps: [GAP],
    bridge: buildTraceClockBridge(events, ANCHORS),
  });
  assert.equal(summary.attributed, false);
  assert.equal(summary.reason, "process-role-not-identified:gpu");
});

test("C6: nested begin/end pairs are matched per thread", () => {
  const bridge = { bridged: true, traceOriginMs: TRACE_ORIGIN_MS };
  const at = (ms) => (TRACE_ORIGIN_MS + ms) * 1000;
  const { intervals, unpairedEnds, unclosedBegins } = traceIntervalsOnPageClock(
    [
      { ph: "B", name: "Outer", cat: "gpu", pid: 2, tid: 3, ts: at(100) },
      { ph: "B", name: "Inner", cat: "gpu", pid: 2, tid: 3, ts: at(150) },
      { ph: "E", pid: 2, tid: 3, ts: at(180) },
      { ph: "E", pid: 2, tid: 3, ts: at(400) },
      { ph: "E", pid: 2, tid: 9, ts: at(500) },
      { ph: "B", name: "NeverClosed", cat: "gpu", pid: 2, tid: 4, ts: at(600) },
      { ph: "i", name: "Instant", cat: "gpu", pid: 2, tid: 3, ts: at(700) },
    ],
    bridge,
    [2],
  );
  const byName = Object.fromEntries(
    intervals.map((row) => [row.name, row.endMs - row.startMs]),
  );
  assert.equal(byName.Inner, 30);
  assert.equal(byName.Outer, 300);
  assert.equal(unpairedEnds, 1);
  assert.equal(unclosedBegins, 1);
});

test("C7: the ranking is by time occupied, not by how many events there were", () => {
  const events = [
    ...PROCESS_METADATA,
    clockSync("open", 0),
    clockSync("close", 100000),
    completeEvent({ name: "OneLongThing", startMs: 20000, durMs: 8000 }),
  ];
  for (let index = 0; index < 40; index++) {
    events.push(
      completeEvent({
        name: "ManyShortThings",
        startMs: 20000 + index * 10,
        durMs: 5,
      }),
    );
  }
  const summary = summarizeGapTraceOverlap({
    traceEvents: events,
    gaps: [GAP],
    bridge: buildTraceClockBridge(events, ANCHORS),
  });
  const [first, second] = summary.gaps[0].topEvents;
  assert.equal(first.name, "OneLongThing");
  assert.equal(first.count, 1);
  assert.equal(second.name, "ManyShortThings");
  assert.equal(second.count, 40);
  assert.ok(first.overlapMs > second.overlapMs);
});

test("C8: the summary says what fraction of the trace it could interpret", () => {
  const events = [
    ...PROCESS_METADATA,
    clockSync("open", 0),
    clockSync("close", 100000),
    completeEvent({ name: "GpuWork", startMs: 20000, durMs: 1000 }),
    {
      ph: "b",
      name: "AsyncStart",
      cat: "gpu",
      pid: 2,
      tid: 3,
      ts: (TRACE_ORIGIN_MS + 20000) * 1000,
    },
    {
      ph: "e",
      name: "AsyncEnd",
      cat: "gpu",
      pid: 2,
      tid: 3,
      ts: (TRACE_ORIGIN_MS + 21000) * 1000,
    },
  ];
  const summary = summarizeGapTraceOverlap({
    traceEvents: events,
    gaps: [GAP],
    bridge: buildTraceClockBridge(events, ANCHORS),
  });
  assert.equal(summary.coverage.skippedPhases.b, 1);
  assert.equal(summary.coverage.skippedPhases.e, 1);
  assert.equal(summary.intervalCount, 1);
});

test("C9: process roles come from the trace's own metadata", () => {
  const names = identifyTraceProcesses(PROCESS_METADATA);
  assert.equal(names.get(2), "GPU Process");
  assert.deepEqual(pidsForRole(names, "gpu"), [2]);
  assert.deepEqual(pidsForRole(names, "renderer"), [3]);
  assert.deepEqual(pidsForRole(names, "nothing-called-this"), []);
});

// ── D. the shader-module census ─────────────────────────────────────────────

test("D1: 'before the first gap' is decided by time, not by gap size", () => {
  // The decomposition sorts gaps longest-first, so the longest gap is at index
  // 0 while a shorter one opened earlier. A summariser that took gaps[0] would
  // count compiles that happened during a gap as having preceded it.
  const decomposition = {
    gaps: [
      { durationMs: 30000, startMs: 60000, endMs: 90000 },
      { durationMs: 4000, startMs: 10000, endMs: 14000 },
    ],
  };
  assert.equal(firstGapStartOf(decomposition), 10000);

  const census = summarizeShaderModuleCensus({
    deviceCompiles: [
      { atMs: 5000, bytes: 100 },
      { atMs: 9000, bytes: 200 },
      { atMs: 12000, bytes: 400 },
      { atMs: 70000, bytes: 800 },
    ],
    censusAtInstall: null,
    censusFinal: null,
    firstGapStartMs: firstGapStartOf(decomposition),
  });
  assert.equal(census.compilesBeforeFirstGap, 2);
  assert.equal(census.bytesBeforeFirstGap, 300);
  assert.equal(census.compilesObserved, 4);
  assert.equal(census.bytesObserved, 1500);
  assert.equal(census.largestObservedBytes, 800);
});

test("D2: compiles that bypassed the cache are the difference between the two sources", () => {
  const census = summarizeShaderModuleCensus({
    deviceCompiles: [
      { atMs: 1, bytes: 100 },
      { atMs: 2, bytes: 100 },
      { atMs: 3, bytes: 100 },
      { atMs: 4, bytes: 100 },
      { atMs: 5, bytes: 100 },
    ],
    censusAtInstall: { modulesCreated: 7, wgslBytes: 700000 },
    censusFinal: { modulesCreated: 10, wgslBytes: 700300 },
    firstGapStartMs: null,
  });
  assert.equal(census.viaModuleCacheDuringWrap, 3);
  assert.equal(census.directCompilesDuringWrap, 2);
  assert.equal(census.viaModuleCacheBytesDuringWrap, 300);
  assert.equal(census.directBytesDuringWrap, 200);
  assert.equal(
    census.compilesBeforeWrap,
    7,
    "the compiles that happened during context init are the reason the " +
      "engine census is read at all; a page-side wrap cannot see them",
  );
  assert.equal(census.bytesBeforeWrap, 700000);
});

test("D3: a missing census reads null, which is not the same finding as zero", () => {
  const census = summarizeShaderModuleCensus({
    deviceCompiles: [{ atMs: 1, bytes: 10 }],
    censusAtInstall: null,
    censusFinal: null,
    firstGapStartMs: null,
  });
  assert.equal(census.viaModuleCacheDuringWrap, null);
  assert.equal(census.directCompilesDuringWrap, null);
  assert.equal(census.compilesBeforeWrap, null);
  assert.equal(census.compilesBeforeFirstGap, null);
  assert.equal(census.compilesObserved, 1);
});

test("D4: a census claiming more cache compiles than the device saw clamps rather than reporting a negative", () => {
  const census = summarizeShaderModuleCensus({
    deviceCompiles: [{ atMs: 1, bytes: 10 }],
    censusAtInstall: { modulesCreated: 0, wgslBytes: 0 },
    censusFinal: { modulesCreated: 5, wgslBytes: 5000 },
    firstGapStartMs: null,
  });
  assert.equal(census.directCompilesDuringWrap, 0);
  assert.equal(census.directBytesDuringWrap, 0);
});

test("D5: unusable compile records are dropped rather than summed as NaN", () => {
  const census = summarizeShaderModuleCensus({
    deviceCompiles: [
      { atMs: 1, bytes: 10 },
      { atMs: "later", bytes: 10 },
      { atMs: 3, bytes: null },
    ],
    censusAtInstall: null,
    censusFinal: null,
    firstGapStartMs: null,
  });
  assert.equal(census.compilesObserved, 1);
  assert.equal(census.bytesObserved, 10);
});

test("D6: no gaps means no 'before the first gap' reading exists", () => {
  assert.equal(firstGapStartOf({ gaps: [] }), null);
  assert.equal(firstGapStartOf(null), null);
  const census = summarizeShaderModuleCensus({
    deviceCompiles: [{ atMs: 1, bytes: 10 }],
    censusAtInstall: null,
    censusFinal: null,
    firstGapStartMs: null,
  });
  assert.equal(census.compilesBeforeFirstGap, null);
});

// ── E. animation-frame delivery ─────────────────────────────────────────────

test("E1: delivery gaps are found, ranked and reported as a fraction of the log", () => {
  const samples = [0, 16, 32, 48, 10048, 10064, 20064];
  const derived = deriveAnimationFrameGaps(samples);
  assert.equal(derived.count, 7);
  assert.equal(derived.windowMs, 20064);
  assert.deepEqual(
    derived.gaps.map((gap) => gap.durationMs),
    [10000, 10000],
  );
  assert.equal(derived.gapMs, 20000);
  assert.ok(Math.abs(derived.gapFraction - 20000 / 20064) < 1e-9);
  assert.equal(derived.medianDeltaMs, 16);
});

test("E2: a log too short to have an interval reports an empty window", () => {
  const derived = deriveAnimationFrameGaps([1000]);
  assert.equal(derived.windowMs, 0);
  assert.equal(derived.gapFraction, 0);
  assert.deepEqual(derived.gaps, []);
});

test("E3: the log is read whether the page recorded numbers or records", () => {
  const asNumbers = deriveAnimationFrameGaps([0, 2000]);
  const asRecords = deriveAnimationFrameGaps([{ atMs: 0 }, { atMs: 2000 }]);
  assert.deepEqual(asRecords.gaps, asNumbers.gaps);
  assert.equal(asRecords.gapMs, 2000);
});

// ── F. the probe's own argument and budget arithmetic ───────────────────────

test("F1: the control list is validated, and must contain the baseline", () => {
  assert.throws(
    () => parseE2Args(["--controls", "ao-off"]),
    /must include baseline/,
  );
  assert.throws(() => parseE2Args(["--controls", "nope"]), /unknown control/);
  assert.throws(
    () => parseE2Args(["--trace-legs", "sometimes"]),
    /--trace-legs/,
  );
  const parsed = parseE2Args(["--controls", "baseline,ao-off"]);
  assert.deepEqual(parsed.controls, ["baseline", "ao-off"]);
  assert.equal(parsed.traceLegs, "all");
});

test("F2: the core options are E-1's, refusals included", () => {
  const parsed = parseE2Args(["--port", "8094", "--reverse"]);
  assert.equal(parsed.port, 8094);
  assert.equal(parsed.reverse, true);
  assert.equal(parsed.entry, "/Build/CesiumUnminified/index.js");
  assert.deepEqual(parsed.controls, [...E2_CONTROL_ORDER]);
  assert.throws(
    () => parseE2Args(["--port", "8080"]),
    /port 8080/,
    "the reserved port must still be refused through the shared parser",
  );
  assert.throws(() => parseE2Args(["--not-a-flag"]), /unknown argument/);
});

test("F3: the watchdog budget grows with the work the run was asked to do", () => {
  const one = watchdogBudgetMs({
    controls: ["baseline"],
    settleDeadlineMs: 90000,
  });
  const all = watchdogBudgetMs({
    controls: [...E2_CONTROL_ORDER],
    settleDeadlineMs: 90000,
  });
  assert.ok(
    one > 90000,
    "the bound must exceed the settle deadline it contains",
  );
  assert.ok(all > one * 2, "five legs must be given more room than two");
});

test("F4: a refusal leaves with the refusal code, and anything else with the error code", () => {
  // The argument parse runs before the watchdog can be sized, so it sits
  // outside the promise chain. Routed anywhere but through this reporter, a
  // refusal an operator must read as a refusal arrives as an uncaught stack
  // with an exit code that means "the probe broke".
  const realError = console.error;
  console.error = () => {};
  try {
    assert.equal(
      reportFailure(new E1RefusalError("port-8080-forbidden", "reserved", {})),
      EXIT_CODES.REFUSAL,
    );
    assert.equal(
      reportFailure(new TypeError("unknown control")),
      EXIT_CODES.ERROR,
    );
    assert.equal(reportFailure("not even an error"), EXIT_CODES.ERROR);
  } finally {
    console.error = realError;
  }
});

test("F5: the receipt carries the categories and renders without a trace", () => {
  const receipt = buildE2Receipt({
    startedAt: "2026-09-02T00:00:00.000Z",
    origin: "http://localhost:8094",
    entry: "/Build/CesiumUnminified/index.js",
    entryContext: null,
    reverse: false,
    preflight: { ok: true },
    traceCategories: E2_TRACE_CATEGORIES,
    legs: [
      {
        control: "baseline",
        backend: "webgpu",
        readiness: { reached: false },
        settleWindowMs: 95914,
        frameGaps: { gaps: [GAP] },
        animationFrameGaps: { gaps: [] },
        traceOverlap: {
          attributed: false,
          reason: "no-clock-sync-marker-in-trace",
        },
        shaderModules: {
          compilesBeforeWrap: 7,
          compilesObserved: 3,
          bytesObserved: 30,
          compilesBeforeFirstGap: 1,
          bytesBeforeFirstGap: 10,
          directCompilesDuringWrap: 0,
        },
      },
    ],
    controlMatrix: buildControlMatrix([]),
    stallLocus: null,
  });
  const markdown = buildE2MarkdownSummary(receipt);
  assert.ok(markdown.includes("disabled-by-default-gpu.device"));
  assert.ok(
    markdown.includes("No attribution"),
    "an unbridged leg must say so in the summary rather than showing an empty table",
  );
  assert.ok(markdown.includes("Not comparable"));
  assert.deepEqual(receipt.runOrder, ["webgl", "webgpu"]);
});

// ── H. the receipt is readable by the locus analyzer ────────────────────────

test("H1: an E-2 receipt is classified by the stall-locus analyzer unchanged", () => {
  // The E-2 receipt exists partly so this analyzer can be run on it without
  // being taught a second schema, and the probe carries the verdict in the
  // receipt for exactly that reason. If the leg shape drifted, this would go
  // quiet rather than loud: `analyzeReceipt` returns a row either way, and the
  // row would simply read "undetermined" forever.
  const frameSamples = [{ index: 0, atMs: 0, sinceLastFrameMs: 0 }];
  let atMs = 0;
  for (let index = 1; index <= 60; index++) {
    atMs += index === 30 ? 30000 : 100;
    frameSamples.push({
      index,
      atMs,
      sinceLastFrameMs: index === 30 ? 30000 : 100,
      commandListLength: 12,
      pipelineCache: { hits: 0, misses: 4, created: 4, pending: 2 },
    });
  }
  const cacheSamples = [];
  for (let at = 0; at <= atMs; at += 250) {
    cacheSamples.push({
      atMs: at,
      sinceLastSampleMs: 250,
      pipelineCache: { hits: 0, misses: 4, created: 4, pending: 2 },
    });
  }

  const receipt = buildE2Receipt({
    startedAt: "2026-09-02T00:00:00.000Z",
    origin: "http://localhost:8094",
    entry: "/Build/CesiumUnminified/index.js",
    entryContext: null,
    reverse: false,
    preflight: { ok: true },
    traceCategories: E2_TRACE_CATEGORIES,
    legs: [
      {
        control: "baseline",
        backend: "webgpu",
        classification: { verdict: "pipeline-creation-bound" },
        frameSamples,
        cacheSamples,
      },
    ],
    controlMatrix: buildControlMatrix([]),
    stallLocus: null,
  });

  const rows = analyzeReceipt(receipt);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].backend, "webgpu");
  assert.equal(rows[0].e1Verdict, "pipeline-creation-bound");
  assert.equal(
    rows[0].locus,
    "off-main-thread",
    "a poll that kept its cadence across a 30 s frame gap is the shape the " +
      "banked evidence has; the receipt must still present it that way",
  );
  assert.equal(rows[0].pipelineCauseLicensed, false);
});

// ── G. inertness mutants ────────────────────────────────────────────────────

/**
 * Imports a rewritten copy of the module from a temporary directory, with its
 * sibling copied alongside so the relative import still resolves. The
 * checkout is never touched.
 *
 * @param {(source: string) => string} rewrite Source rewrite.
 * @param {string} label Name used in the did-it-change assertion.
 * @returns {Promise<object>} The mutated module namespace.
 */
async function importMutated(rewrite, label) {
  const source = readFileSync(MODULE_PATH, "utf8").split("\r\n").join("\n");
  const mutated = mutateOrFail(source, rewrite, label);
  const scratch = mkdtempSync(join(tmpdir(), "helm-aec-residency-e2-"));
  copyFileSync(SIBLING_PATH, join(scratch, "aec-residency-stall-locus.mjs"));
  const path = join(scratch, "aec-residency-e2.mjs");
  writeFileSync(path, mutated, "utf8");
  return import(pathToFileURL(path).href);
}

test("G1 MUTATION: an unreachable residual check accepts disagreeing clocks", async () => {
  // The residual is still computed and still reported. It just cannot reach
  // the refusal any more, which is exactly how this regresses in practice.
  const mutated = await importMutated(
    (source) =>
      source.replace(
        "  if (worst > maxResidual) {",
        "  if (false && worst > maxResidual) {",
      ),
    "clock-residual-check-inert",
  );
  const bridge = mutated.buildTraceClockBridge(
    [clockSync("open", 0), clockSync("close", 100000, 4000)],
    ANCHORS,
  );
  assert.equal(
    bridge.bridged,
    true,
    "B4 requires this to be refused; with the check unreachable it is accepted",
  );
  assert.ok(
    bridge.maxResidualMs > 3900,
    "the reading itself is still computed",
  );
});

test("G2 MUTATION: an unreachable process filter attributes the renderer's work to the gap", async () => {
  const mutated = await importMutated(
    (source) =>
      source.replace(
        "  const pids = role === null ? null : pidsForRole(processNames, role);",
        "  const pids = null;\n" +
          "  if (false) {\n" +
          "    pidsForRole(processNames, role);\n" +
          "  }",
      ),
    "gpu-process-filter-inert",
  );
  const events = [
    ...PROCESS_METADATA,
    clockSync("open", 0),
    clockSync("close", 100000),
    completeEvent({
      name: "RendererWork",
      pid: 3,
      startMs: 20000,
      durMs: 9000,
    }),
    completeEvent({ name: "GpuWork", pid: 2, startMs: 20000, durMs: 500 }),
  ];
  const summary = mutated.summarizeGapTraceOverlap({
    traceEvents: events,
    gaps: [GAP],
    bridge: mutated.buildTraceClockBridge(events, ANCHORS),
  });
  assert.deepEqual(
    summary.gaps[0].topEvents.map((row) => row.name),
    ["RendererWork", "GpuWork"],
    "C3 requires only GPU-process work; with the filter unreachable the " +
      "renderer's own work is attributed and would be read as the occupant",
  );
});

test("G3 MUTATION: an unreachable bridge gate attributes gaps on an unbridged trace", async () => {
  const mutated = await importMutated(
    (source) =>
      source.replace(
        "  if (!bridge || bridge.bridged !== true) {",
        "  if (false && (!bridge || bridge.bridged !== true)) {",
      ),
    "clock-bridge-gate-inert",
  );
  const events = [
    ...PROCESS_METADATA,
    completeEvent({ name: "LongWait", startMs: 19000, durMs: 12000 }),
  ];
  const summary = mutated.summarizeGapTraceOverlap({
    traceEvents: events,
    gaps: [GAP],
    bridge: mutated.buildTraceClockBridge(events, ANCHORS),
  });
  assert.equal(
    summary.attributed,
    true,
    "C4 requires no attribution without a bridge; with the gate unreachable " +
      "an unrelated clock produces a confident, meaningless table",
  );
});

test("G4 MUTATION: a census that ignores the first-gap boundary loses the reading", async () => {
  const mutated = await importMutated(
    (source) =>
      source.replace(
        "      : compiles.filter((entry) => entry.atMs <= boundaryMs);",
        "      : compiles.filter((entry) => true || entry.atMs <= boundaryMs);",
      ),
    "first-gap-boundary-inert",
  );
  const census = mutated.summarizeShaderModuleCensus({
    deviceCompiles: [
      { atMs: 5000, bytes: 100 },
      { atMs: 9000, bytes: 200 },
      { atMs: 12000, bytes: 400 },
      { atMs: 70000, bytes: 800 },
    ],
    censusAtInstall: null,
    censusFinal: null,
    firstGapStartMs: 10000,
  });
  assert.equal(
    census.compilesBeforeFirstGap,
    4,
    "D1 requires two; with the boundary unreachable every compile in the run " +
      "is reported as having preceded the first gap",
  );
});

// ── I. the group key separates pairs that would otherwise collide ───────────

test("C10: two events whose name and category concatenate alike are ranked apart", () => {
  // Ranking groups by (name, cat). If the separator between the two were ever
  // dropped — by an editor, by a pipeline that normalises control characters,
  // by anything that rewrites the file — these two pairs would fold into one
  // row and the gap's top occupant would be an event that never existed.
  const events = [
    ...PROCESS_METADATA,
    clockSync("open", 0),
    clockSync("close", 100000),
    completeEvent({ name: "ab", cat: "", startMs: 21000, durMs: 4000 }),
    completeEvent({ name: "a", cat: "b", startMs: 25000, durMs: 1000 }),
  ];

  const overlap = summarizeGapTraceOverlap({
    traceEvents: events,
    gaps: [GAP],
    bridge: buildTraceClockBridge(events, ANCHORS),
  });

  assert.equal(overlap.attributed, true);
  const rows = overlap.gaps[0].topEvents;
  assert.equal(rows.length, 2, "the two pairs are distinct occupants");
  const byPair = new Map(rows.map((row) => [`${row.name}|${row.cat}`, row]));
  assert.equal(byPair.get("ab|").overlapMs, 4000);
  assert.equal(byPair.get("a|b").overlapMs, 1000);
});

test("C11: the E-2 modules are text a content search can read", () => {
  // A raw control byte anywhere in these files makes `grep` classify the whole
  // module as binary and skip it silently, while git — which sniffs only the
  // first 8 KB — still renders it as text. The two disagreeing is how a module
  // disappears from a repository-wide search without anyone noticing.
  for (const file of [
    MODULE_PATH,
    resolve(HERE, "probe-aec-residency-e2.mjs"),
    resolve(HERE, "aec-residency-e2.spec.mjs"),
  ]) {
    const bytes = readFileSync(file);
    const offending = [];
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      if (byte < 9 || (byte > 13 && byte < 32)) {
        offending.push({ index, byte });
      }
    }
    assert.deepEqual(
      offending,
      [],
      `${file} carries control bytes, so a content search skips it`,
    );
  }
});

// ── J. the census answers for BOTH windows, not just the wrap's ─────────────

test("D7: the combined reading adds the pre-wrap census to the post-wrap log", () => {
  const summary = summarizeShaderModuleCensus({
    deviceCompiles: [
      { atMs: 7000, bytes: 100 },
      { atMs: 9000, bytes: 250 },
      { atMs: 20000, bytes: 4000 },
    ],
    censusAtInstall: { modulesCreated: 4, wgslBytes: 299718 },
    censusFinal: { modulesCreated: 6, wgslBytes: 300068 },
    firstGapStartMs: 10000,
  });

  // The post-wrap halves stay what they were: two compiles, 350 bytes.
  assert.equal(summary.compilesBeforeFirstGap, 2);
  assert.equal(summary.bytesBeforeFirstGap, 350);
  // The wrap is installed after the viewer resolves, so the init window is in
  // the census-at-install and nowhere else. The combined reading is what the
  // row asks for.
  assert.equal(summary.compilesBeforeFirstGapIncludingPreWrap, 6);
  assert.equal(summary.bytesBeforeFirstGapIncludingPreWrap, 300068);
});

test("D8: the combined reading is absent whenever either half is", () => {
  const noCensus = summarizeShaderModuleCensus({
    deviceCompiles: [{ atMs: 1, bytes: 10 }],
    censusAtInstall: null,
    censusFinal: null,
    firstGapStartMs: 100,
  });
  assert.equal(noCensus.bytesBeforeFirstGap, 10, "the post-wrap half stands");
  assert.equal(noCensus.compilesBeforeFirstGapIncludingPreWrap, null);
  assert.equal(noCensus.bytesBeforeFirstGapIncludingPreWrap, null);

  const noGap = summarizeShaderModuleCensus({
    deviceCompiles: [{ atMs: 1, bytes: 10 }],
    censusAtInstall: { modulesCreated: 2, wgslBytes: 20 },
    censusFinal: { modulesCreated: 2, wgslBytes: 20 },
    firstGapStartMs: null,
  });
  assert.equal(noGap.compilesBeforeFirstGapIncludingPreWrap, null);
  assert.equal(noGap.bytesBeforeFirstGapIncludingPreWrap, null);
});

test("D9: the summary names the window each census column answers for", () => {
  const markdown = buildE2MarkdownSummary(
    buildE2Receipt({
      origin: "http://localhost:8094",
      entry: "unminified",
      legs: [
        {
          control: "baseline",
          backend: "webgpu",
          shaderModules: summarizeShaderModuleCensus({
            deviceCompiles: [{ atMs: 7000, bytes: 350 }],
            censusAtInstall: { modulesCreated: 4, wgslBytes: 299718 },
            censusFinal: { modulesCreated: 5, wgslBytes: 300068 },
            firstGapStartMs: 10000,
          }),
        },
      ],
    }),
  );

  // The reading an executor takes off the table has to be the one that
  // answers the row, and it has to say that it is a lower bound.
  assert.match(markdown, /Before first gap \(post-wrap\)/);
  assert.match(markdown, /incl\. pre-wrap, lower bound/);
  assert.ok(
    markdown.includes("| 300068 |"),
    "the combined figure must appear on the row, not only in the JSON",
  );
});

// ── K. a large trace is refused, not swallowed ──────────────────────────────

test("D10: a trace larger than the cap is refused by name and never parsed", () => {
  const directory = mkdtempSync(join(tmpdir(), "helm-trace-"));
  const filePath = join(directory, "trace.json");
  const body = JSON.stringify([{ name: "x", ph: "X", ts: 0, dur: 1 }]);
  writeFileSync(filePath, body);

  const refused = readTraceEvents(filePath, { capBytes: body.length - 1 });
  assert.equal(refused.traceEvents.length, 0);
  assert.match(refused.error, /^trace-too-large-to-read: /);
  assert.ok(
    refused.error.includes(String(body.length)),
    "the refusal must say how large the trace was",
  );

  // The same file under a cap that admits it parses, so the refusal above is
  // the size gate and not a parse failure wearing its name.
  const admitted = readTraceEvents(filePath, { capBytes: body.length });
  assert.equal(admitted.error, null);
  assert.equal(admitted.traceEvents.length, 1);
});

test("D11: an unreadable trace is reported rather than thrown", () => {
  const directory = mkdtempSync(join(tmpdir(), "helm-trace-"));
  const missing = readTraceEvents(join(directory, "absent.json"));
  assert.equal(missing.traceEvents.length, 0);
  assert.match(missing.error, /^trace-parse-failed: /);

  const filePath = join(directory, "not-a-trace.json");
  writeFileSync(filePath, JSON.stringify({ notEvents: true }));
  assert.equal(
    readTraceEvents(filePath).error,
    "trace-file-has-no-events-array",
  );
});

test("D12: a leg that fails leaves every leg before it in the caller's hands", async () => {
  const legs = [];
  const banked = [];
  const plan = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];

  await assert.rejects(
    runLegPlan({
      plan,
      legs,
      runOne: async (step) => {
        if (step.n === 3) {
          throw new Error("the browser died three legs in");
        }
        return { n: step.n, ok: true };
      },
      onLegComplete: (completed) => banked.push(completed.length),
    }),
    /the browser died three legs in/,
  );

  // Twenty-five minutes of Edge time is in those two legs. A run that throws
  // on the third must not take them with it.
  assert.deepEqual(
    legs.map((leg) => leg.n),
    [1, 2],
  );
  assert.deepEqual(
    banked,
    [1, 2],
    "each completed leg must be offered for banking before the next starts",
  );
});

// ── L. the trace is ended exactly once, on every path ───────────────────────

test("D13: a started trace is ended once, however many times the teardown asks", async () => {
  const state = { started: true, ended: false, result: null, endError: null };
  let ends = 0;
  const end = async () => {
    ends++;
    return { path: "trace.json", bytes: 10 };
  };

  await closeTraceOnce(state, end);
  await closeTraceOnce(state, end);

  assert.equal(ends, 1, "the happy path and the teardown must share one end");
  assert.equal(state.ended, true);
  assert.deepEqual(state.result, { path: "trace.json", bytes: 10 });
});

test("D14: a trace that was never started is never ended", async () => {
  const state = { started: false, ended: false, result: null, endError: null };
  let ends = 0;

  await closeTraceOnce(state, async () => {
    ends++;
  });

  assert.equal(ends, 0);
  assert.equal(state.ended, false);
});

test("D15: an end that fails is recorded as a failure rather than thrown", async () => {
  const state = { started: true, ended: false, result: null, endError: null };

  await closeTraceOnce(state, async () => {
    throw new Error("Tracing.end refused");
  });

  // The receipt has to be able to say "traced and abandoned"; a throw here
  // would leave the leg record silent about it.
  assert.equal(state.ended, false);
  assert.match(state.endError, /Tracing\.end refused/);
});

// ── M. inertness mutants for the fixes above ────────────────────────────────

test("G5 MUTATION: an unreachable pre-wrap term drops the init window from the reading", async () => {
  const mutated = await importMutated(
    (source) =>
      source.replace(
        "        : before.length + preWrapCompiles,",
        "        : before.length + (false ? preWrapCompiles : 0),",
      ),
    "prewrap-term-inert",
  );

  const summary = mutated.summarizeShaderModuleCensus({
    deviceCompiles: [{ atMs: 7000, bytes: 100 }],
    censusAtInstall: { modulesCreated: 4, wgslBytes: 299718 },
    censusFinal: { modulesCreated: 5, wgslBytes: 299818 },
    firstGapStartMs: 10000,
  });

  assert.equal(
    summary.compilesBeforeFirstGapIncludingPreWrap,
    1,
    "D7 asserts the combined count; with the pre-wrap term unreachable it " +
      "collapses onto the post-wrap half",
  );
});
