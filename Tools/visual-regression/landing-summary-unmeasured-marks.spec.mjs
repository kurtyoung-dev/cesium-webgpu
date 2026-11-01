// landing-summary-unmeasured-marks.spec.mjs - what the landing summary and verdicts say about a PF verdict that was not measured, and the Prime / Contention basis header lines.
// @purpose Asserts, on the KIT7 sibling-fallback report's four E-W PF-3 arms driven through the probe's own descriptor.verdicts() and descriptor.summary(), that a PF verdict whose statistic was unmeasured carries its provisional-floor mark with decided false and the reason it decided nothing, that its Markdown row is never starred and gets its own Marks line naming the contention reasons and the arm's CPU figures (with the floor footnoted as applied and deciding nothing), that a measured PASS decided by a floor keeps PASS* and its line, that a summary with no marks equals the default summary, and that the receipt's prime and contention-basis notes print as header lines on a PF run only; each clause is shown dead by a mutant of the piece that carries it.
// @status ACTIVE
//
// The fixture (fixtures/landing-kit7-sibling-fallback.json) is the Edge leg KIT7 phase 1 item 2 report
// (2-sibling-fallback/landing-cells-report.json) and the W3-daylight BEFORE/ew report it was compared with,
// trimmed to the page fields the PF-3 comparison reads. Its verdicts are recomputed here through
// descriptor.verdicts() (the base report is written to a lane temp dir, as the probe reads it) and the
// comparison through compareArms, the path the probe takes; `banked` holds what the run wrote, which is the
// independent source for the finding: the E-W-30km|webgpu row carried only the floor line, and the
// E-W-30km-hdr|webgpu row was starred with the floor decided while unmeasured.
// The descriptor is driven whole, so no browser is needed and no fallback to landingVerdicts is taken for the
// fixture cases; the mutant cases of the verdict site call the mutated landingVerdicts with the fixture's
// real comparison, because the descriptor imports the unmutated module.
//
// RUN: CESIUM_LANE=<lane> node --test Tools/visual-regression/landing-summary-unmeasured-marks.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { compareArms, landingVerdicts } from "./lib/landing-verdicts.mjs";
import { buildLandingCellsSummary } from "./lib/landing-cells-summary.mjs";
import { groupArms } from "./lib/metrics/merge-landing-reports.mjs";
import { buildMarkdownSummary } from "./lib/probe-runtime-receipts.mjs";
import { descriptor } from "./probe-landing-cells.mjs";

const FIXTURE = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/landing-kit7-sibling-fallback.json", import.meta.url),
    "utf8",
  ),
);

const VERDICT_FILE = fileURLToPath(
  new URL("./lib/landing-verdicts.mjs", import.meta.url),
);
const SUMMARY_FILE = fileURLToPath(
  new URL("./lib/landing-cells-summary.mjs", import.meta.url),
);

const NEAR = "E-W-30km|webgpu|scene";
const FAR_HDR = "E-W-30km-hdr|webgpu|scene";
const MEASURED = ["E-W-ground|webgpu|scene", "E-W-ground-hdr|webgpu|scene"];
const idOf = (arm) => `${arm}:PF-3`;
const escaped = (id) => id.replaceAll("|", "\\|");

const comparisonOf = () =>
  compareArms(groupArms(FIXTURE.tip.pages), groupArms(FIXTURE.base.pages), {});

/** The probe's own verdicts over the fixture pages, the base report read from a lane temp dir. */
function descriptorVerdicts() {
  return withLaneTmp("landing-summary-unmeasured-", (dir) => {
    const baseReport = `${dir}/base-report.json`;
    fs.writeFileSync(
      baseReport,
      JSON.stringify({ arms: {}, pages: FIXTURE.base.pages }),
    );
    return descriptor.verdicts(structuredClone(FIXTURE.tip.pages), {
      options: { cells: FIXTURE.tip.cells, baseReport },
      origin: "http://localhost:0",
    });
  });
}

/** The receipt the probe writes for those verdicts, over the fixture's own run record. */
function receiptOf(verdicts, extra = {}) {
  return {
    ...FIXTURE.receipt,
    verdicts,
    comparison: comparisonOf(),
    ...extra,
  };
}

const summaryOf = (receipt) => descriptor.summary(receipt, receipt);
const verdictIn = (verdicts, id) => verdicts.find((v) => v.id === id);
const rowOf = (summary, id) =>
  summary.split("\n").find((line) => line.startsWith(`| ${escaped(id)} |`));
const marksOf = (summary) => {
  const lines = summary.split("\n");
  const at = lines.indexOf("## Marks");
  return at < 0
    ? []
    : lines.slice(at + 2, lines.indexOf("", at + 2)).filter(Boolean);
};
const marksFor = (summary, id) =>
  marksOf(summary).filter((line) => line.includes(`\`${id}\``));

// ---- the finding, as the run wrote it ------------------------------------------------------------

test("the finding: the banked run starred an unmeasured row and gave the contended one only a floor line", () => {
  const rows = FIXTURE.banked.summaryRows;
  assert.ok(
    rows.includes(`| ${escaped(idOf(FAR_HDR))} | UNMEASURED (contended)* |`),
  );
  assert.ok(
    rows.includes(`| ${escaped(idOf(NEAR))} | UNMEASURED (contended) |`),
  );
  const banked = FIXTURE.banked.verdicts;
  assert.equal(verdictIn(banked, idOf(FAR_HDR)).provisionalFloor.decided, true);
  assert.equal(verdictIn(banked, idOf(FAR_HDR)).notRun, true);
  const nearMarks = FIXTURE.banked.summaryMarks.filter((l) =>
    l.includes(`\`${idOf(NEAR)}\``),
  );
  assert.equal(nearMarks.length, 1);
  assert.match(nearMarks[0], /did not decide this verdict$/);
  assert.ok(!/contended|machine CPU/.test(nearMarks[0]));
});

// ---- the verdict site ----------------------------------------------------------------------------

/** The assertions the verdict site must satisfy on the fixture's verdicts. */
function assertUnmeasuredFloorsDecideNothing(verdicts) {
  const banked = FIXTURE.banked.verdicts;
  for (const arm of [NEAR, FAR_HDR]) {
    const entry = verdictIn(verdicts, idOf(arm));
    assert.equal(entry.verdict, "unmeasured-contended", arm);
    assert.equal(entry.notRun, true, arm);
    const floor = entry.provisionalFloor;
    assert.equal(
      floor.decided,
      false,
      `${arm}: an unmeasured verdict is decided by nothing`,
    );
    assert.equal(floor.undecidedBecause, "unmeasured-contended", arm);
    // Every other field of the floor is the metric's own.
    const { decided, undecidedBecause, ...rest } = floor;
    const { decided: bankedDecided, ...bankedRest } = verdictIn(
      banked,
      idOf(arm),
    ).provisionalFloor;
    assert.deepEqual(rest, bankedRest, arm);
    assert.equal(typeof decided, "boolean");
    assert.equal(typeof undecidedBecause, "string");
    assert.equal(typeof bankedDecided, "boolean");
  }
}

test("V1: through descriptor.verdicts, the two contended E-W-30km WebGPU PF-3 entries carry the floor undecided and say why", () => {
  assertUnmeasuredFloorsDecideNothing(descriptorVerdicts());
});

test("V2: through descriptor.verdicts, a measured PF-3 entry keeps the floor mark exactly as the metric wrote it", () => {
  const verdicts = descriptorVerdicts();
  for (const arm of MEASURED) {
    const entry = verdictIn(verdicts, idOf(arm));
    assert.equal(entry.verdict, "within", arm);
    assert.deepEqual(
      entry.provisionalFloor,
      verdictIn(FIXTURE.banked.verdicts, idOf(arm)).provisionalFloor,
      arm,
    );
    assert.equal("undecidedBecause" in entry.provisionalFloor, false, arm);
  }
});

test("V3: a measured verdict a floor decided keeps decided true, an unmeasured one never has it, and the comparison record is not rewritten", () => {
  const floor = {
    flag: "provisional-floor",
    fraction: 0.6,
    registeredBandFraction: 0.1,
    decided: true,
  };
  const comparison = {
    "C|webgpu|scene": {
      pf3: { metric: "PF-3", verdict: "within", provisionalFloor: floor },
      pf4: {
        metric: "PF-4",
        verdict: "unmeasured",
        provisionalFloor: { ...floor, floorBytes: 40000 },
      },
    },
  };
  const verdicts = landingVerdicts([], comparison);
  assert.deepEqual(
    verdictIn(verdicts, "C|webgpu|scene:PF-3").provisionalFloor,
    floor,
  );
  const pf4 = verdictIn(verdicts, "C|webgpu|scene:PF-4");
  assert.equal(pf4.notRun, true);
  assert.equal(pf4.provisionalFloor.decided, false);
  assert.equal(pf4.provisionalFloor.undecidedBecause, "unmeasured");
  assert.equal(pf4.provisionalFloor.floorBytes, 40000);
  assert.equal(comparison["C|webgpu|scene"].pf4.provisionalFloor.decided, true);
});

// ---- the summary ---------------------------------------------------------------------------------

/** The assertions the summary must satisfy on the fixture receipt. */
function assertUnmeasuredRowsNamedAndUnstarred(summary) {
  for (const [arm, base, tip, apart] of [
    [NEAR, "57.64", "26.56", "31.07"],
    [FAR_HDR, "53.51", "31.85", "21.65"],
  ]) {
    const id = idOf(arm);
    assert.equal(
      rowOf(summary, id),
      `| ${escaped(id)} | UNMEASURED (contended) |`,
      arm,
    );
    const lines = marksFor(summary, id);
    assert.equal(lines.length, 2, `${arm}: a contended line and a floor line`);
    const [contended, floor] = lines;
    assert.match(contended, /^- UNMEASURED \(contended\) `/, arm);
    assert.match(contended, /more than 20/, `${arm}: the contention reasons`);
    assert.ok(
      contended.includes(
        `machine CPU: base mean ${base} %, tip mean ${tip} %, arms apart by ${apart} points`,
      ),
      `${arm}: the CPU figures in ${contended}`,
    );
    assert.ok(
      contended.includes(
        "(contended at: mean above 60 %, arms apart by more than 20 points)",
      ),
      arm,
    );
    assert.match(floor, /provisional-floor 0\.6 over registered band/, arm);
    assert.match(
      floor,
      /the floor was applied and decided nothing because the verdict was not measured$/,
      arm,
    );
    assert.ok(!floor.includes("*"), arm);
  }
}

test("S1: on the KIT7 report, each contended row has its contended line with the CPU figures, neither is starred, and each floor reads as deciding nothing", () => {
  const verdicts = descriptorVerdicts();
  assertUnmeasuredRowsNamedAndUnstarred(summaryOf(receiptOf(verdicts)));
});

test("S2: the measured E-W ground arms keep their PASS rows and their did-not-decide floor lines", () => {
  const summary = summaryOf(receiptOf(descriptorVerdicts()));
  for (const arm of MEASURED) {
    const id = idOf(arm);
    assert.equal(rowOf(summary, id), `| ${escaped(id)} | PASS |`);
    const lines = marksFor(summary, id);
    assert.equal(lines.length, 1);
    assert.match(
      lines[0],
      /the floor was applied and did not decide this verdict$/,
    );
  }
  assert.ok(!summary.includes("PASS*"));
});

test("S3: an unmeasured row is not starred even when a report written before the verdict site's fix says the floor decided it", () => {
  const verdicts = structuredClone(FIXTURE.banked.verdicts);
  const summary = summaryOf(receiptOf(verdicts));
  assert.equal(
    rowOf(summary, idOf(FAR_HDR)),
    `| ${escaped(idOf(FAR_HDR))} | UNMEASURED (contended) |`,
  );
  assert.ok(!summary.includes("*"));
  assert.match(
    marksFor(summary, idOf(FAR_HDR)).at(-1),
    /decided nothing because the verdict was not measured$/,
  );
});

test("S4: a measured PASS decided by the floor keeps PASS* and its one line exactly", () => {
  const verdicts = descriptorVerdicts();
  const far = verdictIn(verdicts, idOf(FAR_HDR));
  Object.assign(far, {
    pass: true,
    verdict: "within",
    notRun: undefined,
    unmeasured: undefined,
    provisionalFloor: {
      flag: "provisional-floor",
      fraction: 0.6,
      registeredBandFraction: 0.102,
      decided: true,
    },
  });
  const summary = summaryOf(receiptOf(verdicts));
  const id = idOf(FAR_HDR);
  assert.equal(rowOf(summary, id), `| ${escaped(id)} | PASS* |`);
  assert.deepEqual(marksFor(summary, id), [
    `- PASS* \`${id}\`: provisional-floor 0.6 over registered band 0.102; the floor decided this verdict`,
  ]);
});

test("S5: a not-run PF row under a floor gets its reason line (and the CPU figures when its arm was contended) before the footnote; one with a clear arm prints no figures", () => {
  const floor = {
    flag: "provisional-floor",
    floorBytes: 40000,
    registeredAllocationBytes: 0,
    decided: true,
  };
  const row = (arm) => ({
    id: idOf(arm).replace("PF-3", "PF-4"),
    pass: false,
    verdict: "unmeasured",
    notRun: true,
    provisionalFloor: floor,
  });
  const comparison = comparisonOf();
  for (const arm of [NEAR, "E-W-ground|webgpu|scene"]) {
    comparison[arm].pf4 = {
      metric: "PF-4",
      verdict: "unmeasured",
      residency: {
        verdict: "unmeasured",
        reasons: ["no finite tip measurement"],
      },
    };
  }
  const receipt = {
    ...FIXTURE.receipt,
    comparison,
    verdicts: [row(NEAR), row("E-W-ground|webgpu|scene")],
  };
  const summary = summaryOf(receipt);
  const contended = marksFor(summary, "E-W-30km|webgpu|scene:PF-4");
  assert.equal(contended.length, 2);
  assert.match(contended[0], /^- NOT RUN `/);
  assert.match(
    contended[0],
    /mean machine CPU above 60 % on base run 0.*no finite tip measurement; machine CPU: base mean 57.64 %/,
  );
  assert.match(
    contended[0],
    /machine CPU: base mean 57\.64 %, tip mean 26\.56 %/,
  );
  assert.match(
    contended[1],
    /40,000 B over registered allocation 0 B; the floor was applied and decided nothing because the verdict was not measured$/,
  );
  const clear = marksFor(summary, "E-W-ground|webgpu|scene:PF-4");
  assert.equal(clear.length, 2);
  assert.match(clear[0], /no finite tip measurement$/);
  assert.ok(!clear[0].includes("machine CPU"));
  assert.ok(!summary.includes("*"));
});

test("S6: a summary with no marks is the default summary, byte for byte", () => {
  const verdicts = descriptorVerdicts().filter((v) =>
    /^E-W-(ground|30km)(-hdr)?\|webgl\|scene:PF-3$/.test(v.id),
  );
  assert.equal(verdicts.length, 4);
  const receipt = receiptOf(verdicts);
  assert.equal(
    summaryOf(receipt),
    buildMarkdownSummary(receipt, receipt, descriptor.title),
  );
});

// ---- the Prime and Contention basis header lines -------------------------------------------------

const released = {
  status: "released",
  note: "warm-up: released after 4 samples at 20 %",
};
const headerOf = (summary) =>
  summary.split("\n").slice(
    0,
    summary.split("\n").findIndex((l) => l.startsWith("| Verdict")),
  );

test("P1: on a PF run the prime and contention-basis notes print after the Warm-up line with their own labels", () => {
  const receipt = receiptOf(descriptorVerdicts(), {
    warmUp: released,
    prime: { note: "prime: both arms ran one scene page first" },
    contentionBasis: {
      note: "Contention basis: the mean of each run's samples",
    },
  });
  const header = headerOf(summaryOf(receipt));
  const exit = header.findIndex((l) => l.startsWith("Exit code:"));
  assert.deepEqual(header.slice(exit + 2), [
    "Warm-up: released after 4 samples at 20 %",
    "",
    "Prime: both arms ran one scene page first",
    "",
    "Contention basis: the mean of each run's samples",
    "",
  ]);
});

test("P2: a note without its own label prints as written, and each line prints without the others", () => {
  const verdicts = descriptorVerdicts();
  const only = (extra) =>
    headerOf(
      summaryOf(
        receiptOf(verdicts, { warmUp: { status: "settled" }, ...extra }),
      ),
    );
  const lines = only({ prime: { note: "two pages" } }).filter((l) =>
    /^(Warm-up|Prime|Contention basis):/.test(l),
  );
  assert.deepEqual(lines, ["Prime: two pages"]);
  const basis = only({ contentionBasis: { note: "run means" } }).filter((l) =>
    /^(Warm-up|Prime|Contention basis):/.test(l),
  );
  assert.deepEqual(basis, ["Contention basis: run means"]);
});

test("P3: a run that is not a PF run, an empty note and a non-string note print neither line", () => {
  const verdicts = descriptorVerdicts()
    .filter((v) => v.pass === true)
    .slice(0, 2);
  const notes = {
    prime: { note: "prime: x" },
    contentionBasis: { note: "contention basis: y" },
  };
  const notPf = summaryOf(
    receiptOf(verdicts, {
      warmUp: { status: "not-a-pf-run", note: "warm-up: not a PF run" },
      ...notes,
    }),
  );
  assert.ok(!/^(Warm-up|Prime|Contention basis):/m.test(notPf));
  const empty = summaryOf(
    receiptOf(verdicts, {
      warmUp: released,
      prime: { note: "" },
      contentionBasis: { note: 7 },
    }),
  );
  assert.ok(!/^(Prime|Contention basis):/m.test(empty));
  assert.match(empty, /^Warm-up: /m);
});

test("P4: a receipt with only a prime note and nothing else to mark still prints it", () => {
  const verdicts = descriptorVerdicts().filter(
    (v) => v.pass === true && !v.provisionalFloor,
  );
  const receipt = receiptOf(verdicts, {
    warmUp: { status: "settled" },
    prime: { note: "prime: p" },
  });
  const summary = summaryOf(receipt);
  assert.match(summary, /^Prime: p$/m);
  assert.ok(!summary.includes("## Marks"));
});

// ---- mutants: each clause made unreachable turns a case red --------------------------------------

const mutatedSummary = (replacements) =>
  importMutated(SUMMARY_FILE, replacements);
const mutatedVerdicts = (replacements) =>
  importMutated(VERDICT_FILE, replacements);

/** Fails (throws) when the mutant's output satisfies the assertion; returns when it is red. */
const killed = (check) => assert.throws(check, assert.AssertionError);

test("M1: with the verdict-site override of decided unreachable, the unmeasured entries read decided true again", async () => {
  const mutant = await mutatedVerdicts([
    [
      "provisionalFloor: unmeasured\n",
      "provisionalFloor: false && unmeasured\n",
    ],
  ]);
  const verdicts = mutant.landingVerdicts(FIXTURE.tip.pages, comparisonOf());
  killed(() => assertUnmeasuredFloorsDecideNothing(verdicts));
  // The same mutant leaves the real module's behaviour alone: the live path still passes.
  assertUnmeasuredFloorsDecideNothing(
    landingVerdicts(FIXTURE.tip.pages, comparisonOf()),
  );
});

test("M2a: with the contended and not-run line unreachable under a floor, the 30km row has only the floor line", async () => {
  const mutant = await mutatedSummary([
    [
      "if (contended || notRun) {\n    const reasons",
      "if ((contended || notRun) && !hasFloor) {\n    const reasons",
    ],
  ]);
  const receipt = receiptOf(descriptorVerdicts());
  const summary = mutant.buildLandingCellsSummary(
    receipt,
    receipt,
    descriptor.title,
  );
  killed(() => assertUnmeasuredRowsNamedAndUnstarred(summary));
  assert.equal(marksFor(summary, idOf(NEAR)).length, 1);
});

test("M2b: with the unmeasured-floor footnote unreachable, the floor decided on an unmeasured row stars it again", async () => {
  const mutant = await mutatedSummary([
    [
      "if (contended || notRun) {\n      notes.push(",
      "if (false && (contended || notRun)) {\n      notes.push(",
    ],
  ]);
  const receipt = receiptOf(FIXTURE.banked.verdicts);
  const summary = mutant.buildLandingCellsSummary(
    receipt,
    receipt,
    descriptor.title,
  );
  assert.ok(summary.includes("UNMEASURED (contended)* |"));
  killed(() => assert.ok(!summary.includes("*")));
  // Whole-case form: the S3 assertions are red on the mutant.
  killed(() => {
    assert.equal(
      rowOf(summary, idOf(FAR_HDR)),
      `| ${escaped(idOf(FAR_HDR))} | UNMEASURED (contended) |`,
    );
  });
});

test("M2c: with the CPU figures unreachable, the contended line names only the reasons", async () => {
  const mutant = await mutatedSummary([
    ["if (base === null || tip === null) {", "if (true) {"],
  ]);
  const receipt = receiptOf(descriptorVerdicts());
  const summary = mutant.buildLandingCellsSummary(
    receipt,
    receipt,
    descriptor.title,
  );
  killed(() => assertUnmeasuredRowsNamedAndUnstarred(summary));
});

test("M3a: with the Prime line unreachable, P1 is red", async () => {
  const mutant = await mutatedSummary([[`...said("Prime", prime),`, ""]]);
  const receipt = receiptOf(descriptorVerdicts(), {
    warmUp: released,
    prime: { note: "prime: both arms ran one scene page first" },
  });
  const summary = mutant.buildLandingCellsSummary(
    receipt,
    receipt,
    descriptor.title,
  );
  killed(() =>
    assert.match(summary, /^Prime: both arms ran one scene page first$/m),
  );
});

test("M3b: with the Contention basis line unreachable, P1 is red", async () => {
  const mutant = await mutatedSummary([
    [`...said("Contention basis", basis),`, ""],
  ]);
  const receipt = receiptOf(descriptorVerdicts(), {
    warmUp: released,
    contentionBasis: { note: "contention basis: run means" },
  });
  const summary = mutant.buildLandingCellsSummary(
    receipt,
    receipt,
    descriptor.title,
  );
  killed(() => assert.match(summary, /^Contention basis: run means$/m));
});

test("M3c: with the header lines reachable only through the Warm-up note, a prime-only receipt prints nothing", async () => {
  const mutant = await mutatedSummary([
    [
      "const headed = warmUp !== null || prime !== null || basis !== null;",
      "const headed = warmUp !== null;",
    ],
  ]);
  const verdicts = descriptorVerdicts().filter(
    (v) => v.pass === true && !v.provisionalFloor,
  );
  const receipt = receiptOf(verdicts, {
    warmUp: { status: "settled" },
    prime: { note: "prime: p" },
  });
  const summary = mutant.buildLandingCellsSummary(
    receipt,
    receipt,
    descriptor.title,
  );
  killed(() => assert.match(summary, /^Prime: p$/m));
});

test("M3d: with the not-a-pf-run gate unreachable, a run that is not a PF run prints the Prime line", async () => {
  const mutant = await mutatedSummary([
    ["onPfRun && typeof record?.note", "typeof record?.note"],
  ]);
  const receipt = receiptOf(descriptorVerdicts().slice(0, 2), {
    warmUp: { status: "not-a-pf-run", note: "warm-up: not a PF run" },
    prime: { note: "prime: x" },
  });
  const summary = mutant.buildLandingCellsSummary(
    receipt,
    receipt,
    descriptor.title,
  );
  killed(() => assert.ok(!/^Prime:/m.test(summary)));
});

test("the unmutated summary builder is the descriptor's own", () => {
  const receipt = receiptOf(descriptorVerdicts());
  assert.equal(
    buildLandingCellsSummary(receipt, receipt, descriptor.title),
    descriptor.summary(receipt, receipt),
  );
});
