// landing-dive-gate-frames-compare.spec.mjs - a gate-only cell's base-vs-tip frame compare and its summary line say the compare was removed.
// @purpose Asserts, through groupArms, compareArms, landingVerdicts and the landing summary hook over real PNG files in a lane temp dir, that an arm whose pages carry a rig's gate-only mark (E-DG-ellipsoid) gets a comparison.pixels record whose verdict is not-applicable, which keeps what the diff read, names the verdict it replaced, the declaration and the reason `not-comparable: gate-only cell` (and the diff's own reason when the base frame was gone), that an unmarked arm's identical pair still reads within with no such fields, and that the summary prints one Marks line per marked dive-gate verdict naming the removed compare; each site is shown dead by an inertness mutant.
// @status ACTIVE
//
// The finding (row DX-KIT-DIVE-GATE-ELLIPSOID-CELL-BLIND): on the KIT8 Edge leg the four E-DG-ellipsoid frames shared one
// md5 although the dive and control cameras ended at 7.91 m and 1.00 m, so any frame compare of that cell reads a
// byte-identical pair. The rig now declares `frames: "gate-only"` and the dive-gate step lays the mark on its page
// record; this spec covers the two places a reader meets that pair besides the verdict entry: the base-vs-tip
// `pixels` record of a paired run, and the Markdown summary.
//
// RUN: CESIUM_LANE=<lane> node --test Tools/visual-regression/landing-dive-gate-frames-compare.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { writePng } from "./fixtures/probe-landing-cells-support.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  GATE_ONLY_FRAMES_REASON,
  diveGateVerdict,
  framesMarkOf,
} from "./lib/globe-dive-gate-steps.mjs";
import { buildLandingCellsSummary } from "./lib/landing-cells-summary.mjs";
import { NOT_APPLICABLE, compareArms } from "./lib/landing-verdicts.mjs";
import { groupArms } from "./lib/metrics/merge-landing-reports.mjs";
import ellipsoidRig from "./rigs/dive-gate-ellipsoid-sea-level.mjs";
import geirangerRig from "./rigs/dive-gate-geiranger-wall.mjs";

let TEMP_ROOT = "";

before(() => {
  TEMP_ROOT = mkLaneTmp("landing-dive-gate-frames-compare-");
});

after(() => {
  removeLaneTmp(TEMP_ROOT);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const VERDICTS_FILE = path.join(here, "lib/landing-verdicts.mjs");
const SUMMARY_FILE = path.join(here, "lib/landing-cells-summary.mjs");

const ELLIPSOID = "E-DG-ellipsoid|webgl|dive";
const GEIRANGER = "E-DG-geiranger|webgl|dive";

/** One dive page record of a cell, its first capture a PNG at `file`, the rig's mark laid on it as the step lays it. */
function pageOf(cell, rig, file) {
  return {
    run: 0,
    cell,
    rig: rig.id,
    kind: "dive-gate",
    renderer: "webgl",
    page: "dive",
    notRun: null,
    capture: { name: path.basename(file, ".png"), path: file },
    diveGate: { frames: framesMarkOf(rig) },
  };
}

/** Base and tip arms of both cells, each pair byte-identical PNGs. */
function armsIn(name, { baseGone = false } = {}) {
  const dir = path.join(TEMP_ROOT, name);
  const png = (file) => writePng(path.join(mkdir(dir), file), 0);
  const baseEllipsoid = baseGone
    ? path.join(dir, "gone-ellipsoid-base.png")
    : png("ellipsoid-base.png");
  return {
    base: groupArms([
      pageOf("E-DG-ellipsoid", ellipsoidRig, baseEllipsoid),
      pageOf("E-DG-geiranger", geirangerRig, png("geiranger-base.png")),
    ]),
    tip: groupArms([
      pageOf("E-DG-ellipsoid", ellipsoidRig, png("ellipsoid-tip.png")),
      pageOf("E-DG-geiranger", geirangerRig, png("geiranger-tip.png")),
    ]),
  };
}

function mkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- the pixels record ---------------------------------------------------------------------------

test("a gate-only arm's identical pair reads not-applicable, keeps the diff, names the verdict it replaced and the declaration", () => {
  const { base, tip } = armsIn("p1");
  assert.deepEqual(tip[ELLIPSOID].frames, framesMarkOf(ellipsoidRig));
  const pixels = compareArms(tip, base, {})[ELLIPSOID].pixels;
  assert.equal(pixels.measured, true);
  assert.equal(pixels.changedPx, 0, "the diff's own reading is kept");
  assert.equal(pixels.verdict, NOT_APPLICABLE);
  assert.equal(pixels.verdictIfComparable, "within");
  assert.equal(pixels.reason, GATE_ONLY_FRAMES_REASON);
  assert.equal(pixels.reason, "not-comparable: gate-only cell");
  assert.deepEqual(pixels.frames, framesMarkOf(ellipsoidRig));
  assert.match(pixels.frames.declaredBy, /dive-gate-ellipsoid-sea-level/);
});

test("an unmarked arm's identical pair still reads within, with no frames, reason or replaced verdict, and its arm has no frames field", () => {
  const { base, tip } = armsIn("p2");
  assert.equal("frames" in tip[GEIRANGER], false);
  const pixels = compareArms(tip, base, {})[GEIRANGER].pixels;
  assert.equal(pixels.verdict, "within");
  for (const field of ["frames", "reason", "verdictIfComparable"]) {
    assert.equal(field in pixels, false, field);
  }
});

test("a gate-only arm whose base frame is gone keeps the diff's own reason beside the gate-only one", () => {
  const { base, tip } = armsIn("p3", { baseGone: true });
  const pixels = compareArms(tip, base, {})[ELLIPSOID].pixels;
  assert.equal(pixels.measured, false);
  assert.equal(pixels.verdict, NOT_APPLICABLE);
  assert.equal(pixels.reason, GATE_ONLY_FRAMES_REASON);
  assert.equal(typeof pixels.diffReason, "string");
  assert.notEqual(pixels.diffReason, GATE_ONLY_FRAMES_REASON);
});

// ---- the summary ---------------------------------------------------------------------------------

const RUNTIME = {
  probe: "landing-cells",
  generatedAt: "2026-11-01T00:00:00.000Z",
  origin: "http://localhost:0",
  servedBuildAssertion: "waived",
  exitCode: 0,
};

/** The dive-gate entries the verdict site builds for one gate-only and one plain page. */
const summaryVerdicts = () => [
  {
    id: "E-DG-ellipsoid:webgl:dive:run0:dive-gate",
    pass: true,
    expected: "allow",
    observed: "allow",
    frames: framesMarkOf(ellipsoidRig),
  },
  {
    id: "E-DG-geiranger:webgl:dive:run0:dive-gate",
    pass: true,
    expected: "allow",
    observed: "allow",
  },
];

const marksOf = (summary) => {
  const lines = summary.split("\n");
  const at = lines.indexOf("## Marks");
  return at < 0
    ? []
    : lines.slice(at + 2, lines.indexOf("", at + 2)).filter(Boolean);
};

test("the summary names the removed frame compare on the gate-only verdict, and only there", () => {
  const verdicts = summaryVerdicts();
  const summary = buildLandingCellsSummary(
    { warmUp: { status: "not-a-pf-run" } },
    { ...RUNTIME, verdicts },
    "Landing cells",
  );
  const marks = marksOf(summary);
  assert.equal(marks.length, 1);
  assert.equal(
    marks[0],
    '- `E-DG-ellipsoid:webgl:dive:run0:dive-gate`: not-comparable: gate-only cell; the frame compare was removed (declared by rig dive-gate-ellipsoid-sea-level frames: "gate-only")',
  );
  assert.ok(
    summary.includes("| E-DG-ellipsoid:webgl:dive:run0:dive-gate | PASS |"),
    "the gate verdict's own row is unchanged",
  );
});

test("a gate verdict built by the step's verdict function hands its mark to the summary beside its own NOT RUN line", () => {
  const entry = diveGateVerdict("E-DG-ellipsoid:webgpu:control:run0", {
    diveGate: {
      expected: "refuse",
      outcome: { readable: false, reason: "globe-height-undefined" },
      frames: framesMarkOf(ellipsoidRig),
    },
  });
  assert.deepEqual(entry.frames, framesMarkOf(ellipsoidRig));
  const summary = buildLandingCellsSummary(
    { warmUp: { status: "not-a-pf-run" } },
    { ...RUNTIME, verdicts: [entry] },
    "Landing cells",
  );
  const marks = marksOf(summary);
  assert.equal(marks.length, 2);
  assert.match(
    marks[0],
    /^- NOT RUN `E-DG-ellipsoid:webgpu:control:run0:dive-gate`: /,
  );
  assert.match(
    marks[1],
    /not-comparable: gate-only cell; the frame compare was removed/,
  );
});

// ---- inertness mutants ---------------------------------------------------------------------------

test("mutant: the pixels mark made unreachable lets the gate-only pair read within", async () => {
  const anchor = "if (comparison.pixels && frames?.comparable === false) {";
  const mutated = await importMutated(VERDICTS_FILE, [
    [anchor, anchor.replace("if (", "if (false && ")],
  ]);
  const { base, tip } = armsIn("m1");
  const pixels = mutated.compareArms(tip, base, {})[ELLIPSOID].pixels;
  assert.equal(pixels.verdict, "within");
  assert.equal("frames" in pixels, false);
});

test("mutant: the summary line made unreachable leaves no mark for the gate-only verdict", async () => {
  const anchor = "frames.comparable === false";
  const mutated = await importMutated(SUMMARY_FILE, [
    [anchor, `false && ${anchor}`],
  ]);
  const summary = mutated.buildLandingCellsSummary(
    { warmUp: { status: "not-a-pf-run" } },
    { ...RUNTIME, verdicts: summaryVerdicts() },
    "Landing cells",
  );
  assert.deepEqual(marksOf(summary), []);
});
