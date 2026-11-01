// landing-summary-figures.spec.mjs - the machine-CPU figures the landing summary prints on a contended or not-run verdict. Pure Node: no browser, no GPU.
// @purpose Asserts, through the landing probe's own descriptor.summary over a receipt shaped like the contended arm of the KIT8 prime leg, that the Marks lines print long float noise (five or more fractional digits) at two decimals with trailing zeros dropped, print the arm's CPU figures at two decimals, leave a figure of four or fewer fractional digits as recorded, and never change the receipt, whose reason strings keep the raw floats.
// @status ACTIVE
//
// The reason strings below are the ones the KIT8 summary printed unrounded (the arm's contention guard and PF-3's
// ceiling clause wrote them); only the fields the Marks line reads are kept.
//
// RUN: node --test Tools/visual-regression/landing-summary-figures.spec.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { descriptor } from "./probe-landing-cells.mjs";

const ARM = "E-ID-cv|webgl|scene";
const PF1 = `${ARM}:PF-1`;
const PF3 = `${ARM}:PF-3`;

const CONTENTION_REASONS = [
  "mean machine CPU above 60 % on base run 0 83.75181818181818 %",
  "base and tip mean machine CPU differ by 29.65413636363636 points (61.75727272727273 % against 32.10313636363637 %), more than 20",
  "10 or more consecutive machine CPU samples above 60 % on base run 0 (11)",
];
const CEILING_REASON =
  "base 2604.2000000178814 ms is at or over the 2500 ms ceiling: the ceiling clause is not applied, the banded compare was applied instead";
const CPU_TAIL =
  "machine CPU: base mean 61.76 %, tip mean 32.1 %, arms apart by 29.65 points (contended at: mean above 60 %, arms apart by more than 20 points)";

const contendedVerdict = (id) => ({
  id,
  pass: false,
  notRun: true,
  unmeasured: "contended",
});

function kit8Receipt() {
  return {
    generatedAt: "2026-11-01T12:00:00.000Z",
    origin: "http://localhost:8094",
    servedBuildAssertion: "enforced",
    exitCode: 0,
    verdicts: [contendedVerdict(PF1), contendedVerdict(PF3)],
    comparison: {
      [ARM]: {
        contention: {
          status: "contended",
          reasons: [...CONTENTION_REASONS],
          baseMeanCpu: 61.75727272727273,
          tipMeanCpu: 32.10313636363637,
          armDeltaPct: 29.65413636363636,
          contendedCpuPct: 60,
          cpuArmDeltaPct: 20,
        },
        pf3: { perRun: { verdict: "unmeasured", reasons: [CEILING_REASON] } },
      },
    },
  };
}

const summaryOf = (receipt) => descriptor.summary(receipt, receipt);
const marksOf = (summary) => {
  const lines = summary.split("\n");
  const at = lines.indexOf("## Marks");
  assert.ok(at >= 0, "the summary has a Marks section");
  return lines.slice(at + 2, lines.indexOf("", at + 2)).filter(Boolean);
};

test("F1: long float noise in a contention reason prints at two decimals in the Marks line", () => {
  const [pf1, pf3] = marksOf(summaryOf(kit8Receipt()));
  assert.equal(
    pf1,
    [
      `- UNMEASURED (contended) \`${PF1}\`: mean machine CPU above 60 % on base run 0 83.75 %`,
      "base and tip mean machine CPU differ by 29.65 points (61.76 % against 32.1 %), more than 20",
      "10 or more consecutive machine CPU samples above 60 % on base run 0 (11)",
      CPU_TAIL,
    ].join("; "),
  );
  assert.ok(
    pf3.includes(
      "base 2604.2 ms is at or over the 2500 ms ceiling: the ceiling clause is not applied",
    ),
    pf3,
  );
  assert.ok(pf3.endsWith(`; ${CPU_TAIL}`), pf3);
  assert.doesNotMatch(
    pf1 + pf3,
    /\d+\.\d{3,}/,
    "no figure keeps three decimals",
  );
});

test("F2: the arm's CPU figures print at two decimals, not four significant digits", () => {
  const receipt = kit8Receipt();
  Object.assign(receipt.comparison[ARM].contention, {
    baseMeanCpu: 5.123456,
    tipMeanCpu: 99.5,
    armDeltaPct: 12.3456,
    contendedCpuPct: 60.004,
    cpuArmDeltaPct: 20,
    reasons: ["held"],
  });
  const [pf1] = marksOf(summaryOf(receipt));
  assert.ok(
    pf1.endsWith(
      "machine CPU: base mean 5.12 %, tip mean 99.5 %, arms apart by 12.35 points (contended at: mean above 60 %, arms apart by more than 20 points)",
    ),
    pf1,
  );
});

test("F3: a figure of four or fewer fractional digits prints as recorded", () => {
  const receipt = kit8Receipt();
  receipt.comparison = {};
  receipt.verdicts = [
    {
      id: PF3,
      pass: false,
      notRun: true,
      reason: "mode 0.458 against 0.4612, then 29.6541 points and 0.46123456",
    },
  ];
  const [line] = marksOf(summaryOf(receipt));
  assert.equal(
    line,
    `- NOT RUN \`${PF3}\`: mode 0.458 against 0.4612, then 29.6541 points and 0.46`,
  );
});

test("F4: the receipt is not changed and its reason strings keep the raw floats", () => {
  const receipt = kit8Receipt();
  const before = structuredClone(receipt);
  summaryOf(receipt);
  assert.deepEqual(receipt, before);
  assert.ok(
    receipt.comparison[ARM].contention.reasons[0].includes("83.75181818181818"),
  );
  assert.ok(
    receipt.comparison[ARM].pf3.perRun.reasons[0].includes(
      "2604.2000000178814",
    ),
  );
});
