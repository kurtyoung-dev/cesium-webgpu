// verdict-exit-fold.spec.mjs — the probe fleet's exit fold over unmeasured verdicts.
//
// @purpose Asserts how a run's exit code and summary treat a verdict that was unmeasured by a condition outside the subject (a contended PF statistic, a one-run 2g) against a measured fail and a plain NOT RUN, the console-error count the landing terminal comparison reads, and that two per-run spec temp roots do not collide.
// @status ACTIVE
//
// Written from the observable contract (exit code and summary text), not from
// the fold's source: the landing verdicts come from the real
// `landingVerdicts`, the water 2g verdicts from the real `waterVerdicts` over
// page records, and the exit and summary through the real
// `exitCodeForOutcome` and `buildMarkdownSummary`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import {
  compareArms,
  landingVerdicts,
  otherConsoleErrorCount,
} from "./lib/landing-verdicts.mjs";
import {
  PROBE_EXIT_CODES,
  exitCodeForOutcome,
  isMarkedUnmeasured,
} from "./lib/probe-refusal.mjs";
import { buildMarkdownSummary } from "./lib/probe-runtime-receipts.mjs";
import {
  summarizeWaterRecords,
  waterVerdicts,
} from "./lib/water-cell-verdicts.mjs";
import { WATER_CELLS } from "./lib/water-cell-table.mjs";

const exitOf = (verdicts) =>
  exitCodeForOutcome({ refusal: null, errored: false, verdicts });

/** The summary's verdict table as {id: result}. */
function summaryRows(verdicts) {
  const text = buildMarkdownSummary(
    {},
    {
      generatedAt: "t",
      origin: "o",
      servedBuildAssertion: "a",
      exitCode: exitOf(verdicts),
      verdicts,
    },
    "title",
  );
  const rows = {};
  for (const line of text.split("\n")) {
    const match = /^\| (.+) \| ([^|]+) \|$/.exec(line);
    if (match && match[1] !== "Verdict" && match[1] !== "---") {
      // The summary escapes a pipe inside an id.
      rows[match[1].replaceAll("\\|", "|")] = match[2];
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Landing: PF verdicts read off a comparison
// ---------------------------------------------------------------------------

const ARM = "E-X|webgl|scene";
const pf = (metric, verdict, extra = {}) => ({ metric, verdict, ...extra });
const landing = (arm) => landingVerdicts([], { [ARM]: arm });
const contended = pf("PF-3", "unmeasured-contended", {
  verdictIfUncontended: "within",
});

test("X1: a contended PF-3 beside passing measured verdicts exits 0 and reads UNMEASURED (contended), never PASS", () => {
  const verdicts = landing({ pf1: pf("PF-1", "within"), pf3: contended });
  const pf3 = verdicts.find((v) => v.id.endsWith(":PF-3"));
  assert.equal(pf3.pass, false);
  assert.equal(pf3.notRun, true);
  assert.equal(pf3.verdict, "unmeasured-contended");
  assert.equal(exitOf(verdicts), PROBE_EXIT_CODES.OK);
  const rows = summaryRows(verdicts);
  assert.equal(rows[`${ARM}:PF-3`], "UNMEASURED (contended)");
  assert.equal(rows[`${ARM}:PF-1`], "PASS");
});

test("X2: a plain unmeasured PF (a number the arm never produced) still exits 1 and reads NOT RUN", () => {
  const verdicts = landing({
    pf1: pf("PF-1", "within"),
    pf3: pf("PF-3", "unmeasured"),
  });
  assert.equal(exitOf(verdicts), PROBE_EXIT_CODES.FAILURE);
  assert.equal(summaryRows(verdicts)[`${ARM}:PF-3`], "NOT RUN");
});

test("X3: a contended PF-3 beside one measured FAIL exits 1 and the measured one reads FAIL", () => {
  const verdicts = landing({ pf1: pf("PF-1", "over"), pf3: contended });
  assert.equal(exitOf(verdicts), PROBE_EXIT_CODES.FAILURE);
  const rows = summaryRows(verdicts);
  assert.equal(rows[`${ARM}:PF-1`], "FAIL");
  assert.equal(rows[`${ARM}:PF-3`], "UNMEASURED (contended)");
});

test("X4: a run whose only verdicts are unmeasured measured nothing and does not exit 0", () => {
  assert.equal(exitOf(landing({ pf3: contended })), PROBE_EXIT_CODES.FAILURE);
  assert.equal(
    exitOf(
      landing({ pf1: pf("PF-1", "unmeasured-contended"), pf3: contended }),
    ),
    PROBE_EXIT_CODES.FAILURE,
  );
});

test("X5: the marker excuses nothing it should not: refusal and error outrank it, an unknown reason or a missing notRun fails, a passing list stays 0", () => {
  const marked = {
    id: "m",
    pass: false,
    notRun: true,
    unmeasured: "contended",
  };
  const passing = { id: "p", pass: true };
  assert.equal(
    exitCodeForOutcome({
      refusal: { reason: "r" },
      verdicts: [passing, marked],
    }),
    PROBE_EXIT_CODES.REFUSAL,
  );
  assert.equal(
    exitCodeForOutcome({ errored: true, verdicts: [passing, marked] }),
    PROBE_EXIT_CODES.ERROR,
  );
  assert.equal(exitOf([passing, marked]), PROBE_EXIT_CODES.OK);
  assert.equal(exitOf([passing, { ...marked, unmeasured: "because" }]), 1);
  assert.equal(exitOf([passing, { ...marked, notRun: undefined }]), 1);
  assert.equal(isMarkedUnmeasured({ ...marked, pass: true }), false);
  assert.equal(exitOf([passing, passing]), PROBE_EXIT_CODES.OK);
  assert.equal(exitOf([]), PROBE_EXIT_CODES.OK);
  assert.equal(exitOf([passing, { id: "n", pass: false, notRun: true }]), 1);
});

// ---------------------------------------------------------------------------
// Water: 2g from real page records
// ---------------------------------------------------------------------------

const CELL = "coast-50km";
const SIZE = 10;
const EPOCH = { requested: "t", observed: "t", applied: true };
const GATE = {
  deviceLost: null,
  errorCount: 0,
  errors: [],
  armedDevices: 1,
  pageErrorCount: 0,
};

/** Page records and the arm's verdicts for `captured` runs of `requested`. */
function judgeWater({ requested, captured }) {
  const files = new Map();
  // ON differs from OFF on half the pixels, identically on every run and
  // renderer, so the effect bands and the 2g repeat all pass.
  const frame = (shift) => {
    const data = new Uint8ClampedArray(SIZE * SIZE * 4).fill(100);
    for (let px = 0; px < 50; px += 1) {
      data[px * 4] += shift;
    }
    return { width: SIZE, height: SIZE, data };
  };
  const page = (variant, renderer, run) => {
    const name = `${CELL}/${variant}/${renderer}/${run}`;
    files.set(name, frame(variant === "on" ? 60 : 0));
    return {
      run,
      cell: CELL,
      kind: WATER_CELLS[CELL].kind,
      variant,
      rig: `${CELL}-${variant}`,
      renderer,
      notRun: null,
      capture: { path: name, sha256: name },
      gate: GATE,
      waterDialsAbsent: [],
      waveEpoch: EPOCH,
    };
  };
  const records = [];
  for (const renderer of ["webgl", "webgpu"]) {
    for (let run = 0; run < captured; run += 1) {
      records.push(page("off", renderer, run), page("on", renderer, run));
    }
  }
  const loadImage = (file) => files.get(file);
  const summary = summarizeWaterRecords(records, { loadImage });
  return waterVerdicts(records, summary, null, {
    arm: "after",
    runs: requested,
    loadImage,
  });
}

const is2g = (v) => v.id.includes(":2g-wave-epoch-repeat:");

test("X6: --runs 1 makes 2g unmeasured (runs): never a pass, not failing the run when every other verdict passes, summary UNMEASURED (runs)", () => {
  const verdicts = judgeWater({ requested: 1, captured: 1 });
  const g = verdicts.filter(is2g);
  assert.equal(g.length, 2);
  for (const v of g) {
    assert.equal(v.pass, false);
    assert.equal(v.notRun, true);
    assert.equal(v.reason, "2g needs --runs 2 or more (this arm ran 1)");
  }
  assert.deepEqual(
    verdicts.filter((v) => !is2g(v) && v.pass !== true),
    [],
    "the control: every measured verdict passes",
  );
  assert.equal(exitOf(verdicts), PROBE_EXIT_CODES.OK);
  const rows = summaryRows(verdicts);
  for (const v of g) {
    assert.equal(rows[v.id], "UNMEASURED (runs)");
  }
});

test("X7: two runs requested but one captured keeps 2g failing: exit 1, summary NOT RUN", () => {
  const verdicts = judgeWater({ requested: 2, captured: 1 });
  const g = verdicts.filter(is2g);
  assert.equal(g.length, 2);
  for (const v of g) {
    assert.equal(v.notRun, true);
    assert.match(v.reason, /two captured ON runs/);
  }
  assert.equal(exitOf(verdicts), PROBE_EXIT_CODES.FAILURE);
  const rows = summaryRows(verdicts);
  for (const v of g) {
    assert.equal(rows[v.id], "NOT RUN");
  }
});

test("X8: two runs requested and captured measures 2g and exits 0", () => {
  const verdicts = judgeWater({ requested: 2, captured: 2 });
  const g = verdicts.filter(is2g);
  assert.equal(g.length, 2);
  assert.ok(g.every((v) => v.pass === true && v.notRun === undefined));
  assert.equal(exitOf(verdicts), PROBE_EXIT_CODES.OK);
});

// ---------------------------------------------------------------------------
// Landing terminal: the non-sentinel console error count
// ---------------------------------------------------------------------------

function teardownArm(consoleErrors) {
  return {
    renderer: "webgl",
    captures: [],
    inputs: { pf1: [], pf2: [], pf3: [], pf4: [], cpu: [] },
    deviceLoss: [
      {
        terminal: { action: "viewer.destroy", destroyed: true, threw: false },
        consoleErrors,
        deviceLost: null,
      },
    ],
  };
}

function terminalCounts(base, tip) {
  const key = "E-T-water|webgl|teardown";
  const { terminal } = compareArms(
    { [key]: teardownArm(tip) },
    { [key]: teardownArm(base) },
    {},
  )[key];
  return [terminal.baseOtherConsoleErrors, terminal.tipOtherConsoleErrors];
}

const sample = ["a", "b", "c", "d", "e"];

test("X9: the terminal comparison counts every non-sentinel error, not the five-line sample, on each fallback path", () => {
  // Newest reports carry the uncapped count.
  assert.deepEqual(
    terminalCounts(
      { errors: 92, sentinel: 1, otherCount: 91, other: sample },
      { errors: 7, sentinel: 1, otherCount: 6, other: sample },
    ),
    [91, 6],
  );
  // A report written before otherCount: errors minus sentinel.
  assert.deepEqual(
    terminalCounts(
      { errors: 92, sentinel: 1, other: sample },
      { errors: 7, sentinel: 1, other: sample },
    ),
    [91, 6],
  );
  // Neither: the sample is all there is.
  assert.deepEqual(
    terminalCounts({ other: sample }, { other: sample.slice(0, 2) }),
    [5, 2],
  );
  assert.deepEqual(terminalCounts({}, undefined), [0, 0]);
});

test("X10: otherCount wins over errors minus sentinel, and a zero count is read as zero", () => {
  assert.equal(
    otherConsoleErrorCount({
      errors: 10,
      sentinel: 1,
      otherCount: 3,
      other: [],
    }),
    3,
  );
  assert.equal(
    otherConsoleErrorCount({
      errors: 1,
      sentinel: 1,
      otherCount: 0,
      other: sample,
    }),
    0,
  );
});

// ---------------------------------------------------------------------------
// Spec temp roots
// ---------------------------------------------------------------------------

test("X11: two concurrent per-run roots under one lane do not collide, and removing one leaves the other", () => {
  const first = mkLaneTmp("probe-landing-cells-");
  const second = mkLaneTmp("probe-landing-cells-");
  try {
    assert.notEqual(first, second);
    fs.writeFileSync(path.join(first, "a.txt"), "a");
    fs.writeFileSync(path.join(second, "b.txt"), "b");
    removeLaneTmp(first);
    assert.equal(fs.existsSync(first), false);
    assert.equal(fs.readFileSync(path.join(second, "b.txt"), "utf8"), "b");
  } finally {
    removeLaneTmp(first);
    removeLaneTmp(second);
  }
});
