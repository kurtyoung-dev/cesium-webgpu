// landing-cells-summary.spec.mjs - the landing-cells Markdown summary hook. Pure Node: no browser, no GPU.
// @purpose Asserts the landing-cells summary by what a reader sees through the probe's own descriptor.summary: a PASS a provisional floor decided reads PASS* with the flag and figures under the table, a floor that did not decide is a plain note, a contended or not-run verdict names why, a warm-up note and a sibling-fallback base frame are printed, and a receipt with no mark prints exactly the default summary.
// @status ACTIVE
//
// The positive fixture is the KIT6 compile-floor B report trimmed to the fields the summary reads
// (fixtures/landing-cells-summary/); each test sets the marks it is about on a deep clone.

import assert from "node:assert/strict";
import fs from "node:fs";
import test, { after, before } from "node:test";
import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { landingRunners } from "./fixtures/probe-landing-cells-support.mjs";
import { buildMarkdownSummary } from "./lib/probe-runtime-receipts.mjs";
import { descriptor } from "./probe-landing-cells.mjs";

const BANKED = JSON.parse(
  fs.readFileSync(
    new URL(
      "./fixtures/landing-cells-summary/kit6-compile-b-trimmed.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const ARM = "E-W-ground-hdr|webgpu|scene";
const PF1 = `${ARM}:PF-1`;
const PF3 = `${ARM}:PF-3`;
const PF4 = `${ARM}:PF-4`;
const STAGE = "E-W-ground-hdr:webgl:scene:run0:stage";

const fresh = () => structuredClone(BANKED);
const summaryOf = (receipt) => descriptor.summary(receipt, receipt);
const defaultOf = (receipt) =>
  buildMarkdownSummary(receipt, receipt, descriptor.title);
const verdictOf = (receipt, id) => receipt.verdicts.find((v) => v.id === id);
/** The table row a reader sees for a verdict id (the `|` of an id is escaped in a table). */
const rowOf = (summary, id) =>
  summary
    .split("\n")
    .find((line) => line.startsWith(`| ${id.replaceAll("|", "\\|")} |`));
const marksOf = (summary) => {
  const lines = summary.split("\n");
  const at = lines.indexOf("## Marks");
  return at < 0
    ? []
    : lines.slice(at + 2, lines.indexOf("", at + 2)).filter(Boolean);
};

const PF3_MARK = {
  flag: "provisional-floor",
  fraction: 0.6,
  registeredBandFraction: 0.0758,
  decided: true,
};
const PF4_MARK = {
  flag: "provisional-floor",
  floorBytes: 40000,
  registeredAllocationBytes: 0,
  decided: true,
};

test("the fixture is the banked report: a FAIL row is in it and an unmarked receipt prints exactly the default summary", () => {
  const receipt = fresh();
  assert.equal(verdictOf(receipt, PF4).pass, false);
  assert.equal(summaryOf(receipt), defaultOf(receipt));
  assert.match(
    defaultOf(receipt),
    /\| E-W-ground-hdr\\\|webgpu\\\|scene:PF-4 \| FAIL \|/,
  );
});

test("a PF-4 floor that decided reads PASS* with the flag and both byte figures under the table; a PF-3 floor likewise with fraction and registered band", () => {
  const receipt = fresh();
  Object.assign(verdictOf(receipt, PF4), {
    pass: true,
    verdict: "within",
    provisionalFloor: PF4_MARK,
  });
  Object.assign(verdictOf(receipt, PF3), { provisionalFloor: PF3_MARK });
  const summary = summaryOf(receipt);

  assert.equal(
    rowOf(summary, PF4),
    `| ${PF4.replaceAll("|", "\\|")} | PASS* |`,
  );
  assert.equal(
    rowOf(summary, PF3),
    `| ${PF3.replaceAll("|", "\\|")} | PASS* |`,
  );
  const marks = marksOf(summary);
  assert.equal(marks.length, 2);
  const pf3Note = marks.find((line) => line.includes(PF3));
  const pf4Note = marks.find((line) => line.includes(PF4));
  assert.match(pf3Note, /provisional-floor 0\.6 over registered band 0\.0758/);
  assert.match(
    pf4Note,
    /provisional-floor 40,000 B over registered allocation 0 B/,
  );
  // The notes sit under the table, before the receipt fields.
  const lines = summary.split("\n");
  assert.ok(lines.indexOf("## Marks") > lines.indexOf(rowOf(summary, PF4)));
  assert.ok(
    lines.indexOf("## Marks") <
      lines.findIndex((l) => l.startsWith("Receipt fields:")),
  );
});

test("only the marked rows and the added Marks block differ from the default summary", () => {
  const receipt = fresh();
  Object.assign(verdictOf(receipt, PF3), { provisionalFloor: PF3_MARK });
  const before = defaultOf(receipt).split("\n");
  const after = summaryOf(receipt).split("\n");
  const marksAt = after.indexOf("## Marks");
  const withoutMarks = [
    ...after.slice(0, marksAt),
    ...after.slice(after.indexOf("", marksAt + 2) + 1),
  ];
  assert.equal(withoutMarks.length, before.length);
  const changed = withoutMarks.filter((line, i) => line !== before[i]);
  assert.deepEqual(changed, [`| ${PF3.replaceAll("|", "\\|")} | PASS* |`]);
});

test("a decided floor on a verdict that did not pass keeps its label and adds the star", () => {
  const receipt = fresh();
  Object.assign(verdictOf(receipt, PF4), { provisionalFloor: PF4_MARK });
  const summary = summaryOf(receipt);
  assert.equal(
    rowOf(summary, PF4),
    `| ${PF4.replaceAll("|", "\\|")} | FAIL* |`,
  );
});

test("a floor that was applied and did not decide leaves the row PASS and says so in a note with no asterisk", () => {
  const receipt = fresh();
  Object.assign(verdictOf(receipt, PF3), {
    provisionalFloor: { ...PF3_MARK, decided: false },
  });
  const summary = summaryOf(receipt);
  assert.equal(rowOf(summary, PF3), `| ${PF3.replaceAll("|", "\\|")} | PASS |`);
  const marks = marksOf(summary);
  assert.equal(marks.length, 1);
  assert.match(marks[0], /did not decide/);
  assert.match(marks[0], /provisional-floor 0\.6 over registered band 0\.0758/);
  assert.ok(!marks[0].includes("*"));
});

test("a floor mark with an unknown extra field, long floats or an unknown shape still prints", () => {
  const receipt = fresh();
  Object.assign(verdictOf(receipt, PF3), {
    provisionalFloor: {
      ...PF3_MARK,
      fraction: 0.6000000001,
      registeredBandFraction: 0.07583333333,
      novel: { nested: true },
    },
  });
  Object.assign(verdictOf(receipt, PF4), {
    provisionalFloor: { flag: "some-new-floor", ratio: 3, decided: true },
  });
  const marks = marksOf(summaryOf(receipt));
  assert.match(
    marks.find((line) => line.includes(PF3)),
    /provisional-floor 0\.6 over registered band 0\.07583\b/,
  );
  assert.match(
    marks.find((line) => line.includes(PF4)),
    /some-new-floor ratio 3/,
  );
});

test("a contended verdict names the contention reasons of its arm", () => {
  const receipt = fresh();
  Object.assign(verdictOf(receipt, PF1), {
    pass: false,
    verdict: "unmeasured-contended",
    notRun: true,
    unmeasured: "contended",
  });
  receipt.comparison[ARM].contention = {
    status: "contended",
    reasons: [
      "machine CPU averaged 71 % on tip, above 60 %",
      "3 or more consecutive machine CPU samples above 60 % on base",
    ],
  };
  const summary = summaryOf(receipt);
  assert.equal(
    rowOf(summary, PF1),
    `| ${PF1.replaceAll("|", "\\|")} | UNMEASURED (contended) |`,
  );
  const marks = marksOf(summary);
  assert.equal(marks.length, 1);
  assert.match(marks[0], /machine CPU averaged 71 % on tip, above 60 %/);
  assert.match(
    marks[0],
    /3 or more consecutive machine CPU samples above 60 % on base/,
  );
});

test("a contended verdict whose reasons are not recorded says so", () => {
  const receipt = fresh();
  Object.assign(verdictOf(receipt, PF1), {
    pass: false,
    notRun: true,
    unmeasured: "contended",
  });
  const marks = marksOf(summaryOf(receipt));
  assert.equal(marks.length, 1);
  assert.match(marks[0], /reason not recorded$/);
});

test("a not-run stage verdict prints its reason; a PF one prints the unmeasured statistic's reasons; one with neither says not recorded", () => {
  const receipt = fresh();
  Object.assign(verdictOf(receipt, STAGE), {
    pass: false,
    notRun: true,
    reason: "the scene never reached its ready state",
  });
  Object.assign(verdictOf(receipt, PF4), { pass: false, notRun: true });
  receipt.comparison[ARM].pf4 = {
    metric: "PF-4",
    verdict: "unmeasured",
    residency: {
      verdict: "unmeasured",
      reasons: ["no finite tip measurement"],
    },
  };
  Object.assign(verdictOf(receipt, PF3), { pass: false, notRun: true });
  const summary = summaryOf(receipt);
  assert.equal(rowOf(summary, STAGE), `| ${STAGE} | NOT RUN |`);
  const marks = marksOf(summary);
  assert.equal(marks.length, 3);
  assert.match(
    marks.find((line) => line.includes(STAGE)),
    /the scene never reached its ready state$/,
  );
  assert.match(
    marks.find((line) => line.includes(PF4)),
    /no finite tip measurement$/,
  );
  assert.match(
    marks.find((line) => line.includes(PF3)),
    /reason not recorded$/,
  );
});

test("a receipt warm-up note prints as one Warm-up line after the header block, and nothing else changes", () => {
  const receipt = fresh();
  receipt.warmUp = {
    status: "released",
    note: "warm-up: released after 4 samples (4000 ms) at 20 %",
  };
  const summary = summaryOf(receipt);
  const lines = summary.split("\n");
  const exit = lines.findIndex((line) => line.startsWith("Exit code:"));
  assert.equal(
    lines[exit + 2],
    "Warm-up: released after 4 samples (4000 ms) at 20 %",
  );
  assert.equal(lines[exit + 3], "");
  assert.ok(lines.indexOf("| Verdict | Result |") > exit + 3);
  assert.ok(!summary.includes("## Marks"));
  const stripped = [...lines.slice(0, exit + 2), ...lines.slice(exit + 4)];
  const plain = defaultOf(receipt).split("\n");
  assert.deepEqual(stripped, plain);
});

test("an arm whose base frame was found beside the report is named with the path it was recorded at", () => {
  const receipt = fresh();
  receipt.comparison[ARM].pixels = {
    frameSource: "sibling-fallback",
    baseRecordedPath: "D:/old-run/frames/E-W-ground-hdr-webgpu-run0.png",
  };
  receipt.comparison["E-W-30km-hdr|webgl|scene"].pixels = {
    frameSource: "recorded",
  };
  const marks = marksOf(summaryOf(receipt));
  assert.equal(marks.length, 1);
  assert.match(marks[0], /sibling-fallback/);
  assert.ok(marks[0].includes(ARM));
  assert.ok(
    marks[0].includes("D:/old-run/frames/E-W-ground-hdr-webgpu-run0.png"),
  );
});

let TEMP_ROOT = "";
before(() => {
  TEMP_ROOT = mkLaneTmp("landing-cells-summary-");
});
after(() => {
  removeLaneTmp(TEMP_ROOT);
});
const { p14Run } = landingRunners(() => TEMP_ROOT);

test("through runProbe: the written landing-cells-summary.md is the hook's text over the written report", async () => {
  const { report } = await p14Run("summary-hook", ["--cells", "E-O"]);
  const written = fs.readFileSync(
    `${TEMP_ROOT}/summary-hook/out/landing-cells-summary.md`,
    "utf8",
  );
  assert.equal(written, descriptor.summary(report, report));
  // A run with no PF window waits for nothing, and its summary says nothing
  // about a wait.
  assert.equal(report.warmUp?.status, "not-a-pf-run");
  assert.equal(written.includes("Warm-up:"), false);
});

test("through runProbe --perf: the written summary carries the run's Warm-up line", async () => {
  const { report } = await p14Run("summary-hook-perf", [
    "--cells",
    "E-O",
    "--perf",
  ]);
  const written = fs.readFileSync(
    `${TEMP_ROOT}/summary-hook-perf/out/landing-cells-summary.md`,
    "utf8",
  );
  assert.equal(written, descriptor.summary(report, report));
  assert.equal(report.warmUp?.status, "released");
  assert.ok(
    written.includes(
      `Warm-up: ${report.warmUp.note.replace(/^warm-up:\s*/u, "")}`,
    ),
  );
});

test("a receipt whose warm-up says not-a-pf-run prints no Warm-up line", () => {
  const receipt = fresh();
  receipt.warmUp = { status: "not-a-pf-run", note: "warm-up: not a PF run" };
  const summary = summaryOf(receipt);
  assert.equal(summary.includes("Warm-up:"), false);
  // Nothing else marks this receipt, so it is the default summary's text.
  assert.equal(
    summary,
    buildMarkdownSummary(receipt, receipt, descriptor.title),
  );
});
