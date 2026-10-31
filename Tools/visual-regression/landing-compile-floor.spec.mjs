// landing-compile-floor.spec.mjs - the provisional same-build floor PF-3's compile total reads, and what its record says about it.
//
// @purpose Asserts, through compareArms (the probe's own comparison path, with the {} band overrides the probe passes for a wave that registers none), that two same-build E-W HDR WebGPU arms whose compile total moved +17.2 % and +56.0 % read PF-3 compile `within`, that the compile record names the floor (flag, source, fraction), the registered band and whether the floor was the larger term, that a tip more than 60 % over base still reads `over`, that a registered repeat band above 60 % is kept, that the startup statistic and every other PF verdict read as they did, that the PF-3 verdict and its entry in the probe's own descriptor.verdicts() carry the provisional-floor mark with `decided` true exactly where the registered band alone would read `over`, and that an arm with no compile total measured (a WebGL arm) records the floor as not applicable.
// @status ACTIVE
//
// Written from the observable contract (row DX-KIT-COMPILE-TOTAL-BAND-SAME-BUILD-SPREAD): the compile
// verdict reads max(registered band, 0.60). The pages are the two HDR WebGPU arms of a banked Edge report
// pair (fixtures/landing-compile-floor), served from one build; `banked` holds what the same pages read
// before the floor existed, which is the independent source for "the startup verdict is unchanged".
//
// RUN: node --test Tools/visual-regression/landing-compile-floor.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { compareArms } from "./lib/landing-verdicts.mjs";
import { descriptor } from "./probe-landing-cells.mjs";
import { groupArms } from "./lib/metrics/merge-landing-reports.mjs";
import {
  COMPILE_PROVISIONAL_FLOOR,
  compareToBase,
} from "./lib/metrics/perf-band.mjs";

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "landing-compile-floor",
      "e-w-hdr-webgpu.json",
    ),
    "utf8",
  ),
);

const GROUND = "E-W-ground-hdr|webgpu|scene";
const FAR = "E-W-30km-hdr|webgpu|scene";
const CELL_OF = { [GROUND]: "E-W-ground-hdr", [FAR]: "E-W-30km-hdr" };

const syncMsOf = (page) =>
  page.compileAtStartup.shaderModules.syncMs +
  page.compileAtStartup.renderPipelines.syncMs +
  page.compileAtStartup.computePipelines.syncMs;

const totalOf = (page) =>
  syncMsOf(page) +
  page.compileAtStartup.renderPipelinesAsync.totalSettleMs +
  page.compileAtStartup.computePipelinesAsync.totalSettleMs;

/** A copy of `pages` whose repeats of `cell` carry the given compile totals, in order. */
function withCompileTotals(pages, cell, totals) {
  const out = structuredClone(pages);
  let index = 0;
  for (const page of out.filter((p) => p.cell === cell)) {
    const compile = page.compileAtStartup;
    compile.computePipelinesAsync.totalSettleMs = 0;
    compile.renderPipelinesAsync.totalSettleMs = totals[index] - syncMsOf(page);
    index += 1;
  }
  return out;
}

const compare = (tipPages, basePages = FIXTURE.base.pages) =>
  compareArms(groupArms(tipPages), groupArms(basePages), {});

const median2 = (a, b) => (a + b) / 2;

const baseMedian = (cell, pages = FIXTURE.base.pages) => {
  const totals = pages.filter((p) => p.cell === cell).map(totalOf);
  return median2(...totals);
};

test("C1: the two same-build HDR arms the unchanged build read over now read within, floor flagged, both figures visible", () => {
  const comparison = compare(FIXTURE.tip.pages);
  for (const key of [GROUND, FAR]) {
    const banked = FIXTURE.banked[key];
    assert.equal(banked.compile.verdict, "over", `${key} was a red`);
    const { pf3 } = comparison[key];
    assert.equal(pf3.compile.verdict, "within", key);
    assert.equal(pf3.verdict, "within", `${key} PF-3`);
    const floor = pf3.compile.provisionalFloor;
    assert.equal(floor.flag, "provisional-floor");
    assert.equal(floor.fraction, 0.6);
    assert.match(floor.source, /KIT5 phase-2 item-6 arm-B same-build spread/);
    assert.equal(floor.applied, true);
    assert.equal(floor.registeredBandFraction, banked.compile.bandFraction);
    assert.equal(pf3.compile.bandFraction, 0.6);
    assert.equal(pf3.compile.bandSource, "provisional-floor");
    assert.equal(pf3.compile.base, banked.compile.base);
    assert.equal(pf3.compile.tip, banked.compile.tip);
    assert.ok(Math.abs(pf3.compile.limit - banked.compile.base * 1.6) < 1e-6);
  }
});

test("C2: the startup statistic on those arms reads exactly what it read before, with no floor record on it", () => {
  const comparison = compare(FIXTURE.tip.pages);
  for (const key of [GROUND, FAR]) {
    const banked = FIXTURE.banked[key].startup;
    const startup = comparison[key].pf3.startup;
    for (const field of Object.keys(banked)) {
      assert.deepEqual(startup[field], banked[field], `${key} ${field}`);
    }
    assert.equal(startup.provisionalFloor, undefined);
    assert.deepEqual(startup.startupFloor, {
      fraction: 0.1,
      origin: "registered",
    });
  }
});

test("C3: a tip whose compile total exceeds base by more than 60 % still reads over, and one just under still reads within", () => {
  for (const key of [GROUND, FAR]) {
    const cell = CELL_OF[key];
    const base = baseMedian(cell);
    // median of two equal repeats is that repeat
    const at = (ratio) =>
      compare(
        withCompileTotals(FIXTURE.tip.pages, cell, [
          base * ratio,
          base * ratio,
        ]),
      )[key].pf3;
    const over = at(1.61);
    assert.equal(over.compile.verdict, "over", key);
    assert.equal(over.verdict, "over", key);
    assert.equal(over.compile.provisionalFloor.applied, true);
    assert.equal(over.compile.bandFraction, 0.6);
    assert.equal(at(1.59).compile.verdict, "within", key);
  }
});

test("C4: a registered repeat band above 60 % is kept, the floor recorded as not applied", () => {
  const cell = CELL_OF[FAR];
  // base repeats 8000 and 14000: spread 0.75, band 2 x 0.75 = 1.5, median 11000
  const basePages = withCompileTotals(FIXTURE.base.pages, cell, [8000, 14000]);
  const pf3At = (tipTotal) =>
    compare(
      withCompileTotals(FIXTURE.tip.pages, cell, [tipTotal, tipTotal]),
      basePages,
    )[FAR].pf3;
  // 1.7 x the base median is over the 60 % floor but inside the 150 % band
  const kept = pf3At(11000 * 1.7);
  assert.equal(kept.compile.verdict, "within");
  assert.equal(kept.compile.bandSource, "repeat");
  assert.ok(Math.abs(kept.compile.bandFraction - 1.5) < 1e-9);
  assert.equal(kept.compile.provisionalFloor.applied, false);
  assert.equal(kept.compile.provisionalFloor.fraction, 0.6);
  assert.ok(
    Math.abs(kept.compile.provisionalFloor.registeredBandFraction - 1.5) < 1e-9,
  );
  assert.ok(Math.abs(kept.compile.limit - 11000 * 2.5) < 1e-6);
  assert.equal(pf3At(11000 * 2.6).compile.verdict, "over");
});

test("C5: the floor is a property of the compile total only: a PF-1 statistic keeps its 3 % band and carries no floor record", () => {
  const record = compareToBase({
    metric: "PF-1",
    statistic: "p95",
    baseRepeats: [10, 10.1],
    tipRepeats: [15, 15],
  });
  assert.equal(record.provisionalFloor, undefined);
  assert.equal(record.bandSource, "floor");
  assert.equal(record.bandFraction, 0.03);
  assert.equal(record.verdict, "over");
  assert.equal(COMPILE_PROVISIONAL_FLOOR.fraction, 0.6);
  assert.equal(Object.isFrozen(COMPILE_PROVISIONAL_FLOOR), true);
});

test("C6: a contended pair still reads unmeasured-contended on the compile total with the floor in place", () => {
  const tip = structuredClone(FIXTURE.tip.pages);
  for (const page of tip.filter((p) => p.cell === CELL_OF[GROUND])) {
    page.cpu.mean = 90;
  }
  const { pf3 } = compare(tip)[GROUND];
  assert.equal(pf3.compile.verdict, "unmeasured-contended");
  assert.equal(pf3.compile.provisionalFloor.applied, true);
});

/** The probe's own verdicts for `tipPages` against the fixture's base pages, written as a base report. */
function probeVerdicts(tipPages) {
  const dir = mkLaneTmp("landing-compile-floor-verdicts-");
  try {
    const baseReport = `${dir}/base-report.json`;
    fs.writeFileSync(
      baseReport,
      JSON.stringify({ arms: {}, pages: FIXTURE.base.pages }),
    );
    return descriptor.verdicts(tipPages, {
      options: { cells: "E-W-ground-hdr,E-W-30km-hdr", baseReport },
      origin: "http://localhost:0",
    });
  } finally {
    removeLaneTmp(dir);
  }
}

const pf3EntryOf = (verdicts, key) =>
  verdicts.find((verdict) => verdict.id === `${key}:PF-3`);

test("C7: the probe's PF-3 verdict entries for the two same-build HDR arms carry the floor mark, decided, where the summary's verdicts are read", () => {
  const verdicts = probeVerdicts(FIXTURE.tip.pages);
  for (const key of [GROUND, FAR]) {
    const entry = pf3EntryOf(verdicts, key);
    assert.ok(entry, `${key}: a PF-3 verdict entry`);
    assert.equal(entry.pass, true, key);
    assert.equal(entry.verdict, "within", key);
    assert.ok(entry.provisionalFloor, `${key}: the entry carries the floor`);
    assert.equal(entry.provisionalFloor.flag, "provisional-floor");
    assert.equal(entry.provisionalFloor.fraction, 0.6);
    assert.ok(entry.provisionalFloor.registeredBandFraction < 0.6);
    assert.equal(entry.provisionalFloor.decided, true, key);
  }
  // The same mark on the comparison's PF-3 record itself.
  const { pf3 } = compare(FIXTURE.tip.pages)[GROUND];
  assert.equal(pf3.provisionalFloor.flag, "provisional-floor");
  assert.equal(pf3.provisionalFloor.decided, true);
});

test("C8: an arm the floor bands but did not turn carries the mark with decided false", () => {
  const cell = CELL_OF[GROUND];
  const base = baseMedian(cell);
  // Tip equal to the base median: within under the registered band alone.
  const tip = withCompileTotals(FIXTURE.tip.pages, cell, [base, base]);
  const entry = pf3EntryOf(probeVerdicts(tip), GROUND);
  assert.equal(entry.verdict, "within");
  assert.equal(entry.provisionalFloor.flag, "provisional-floor");
  assert.equal(entry.provisionalFloor.decided, false);
});

test("C9: an arm with no compile total measured (0 ms on both arms, a WebGL arm) records the floor as not applicable and carries no mark", () => {
  const cell = CELL_OF[GROUND];
  const zero = (pages) => withCompileTotals(pages, cell, [0, 0]);
  const zeroed = (pages) =>
    zero(pages).map((page) => {
      if (page.cell === cell) {
        for (const part of [
          "shaderModules",
          "renderPipelines",
          "computePipelines",
        ]) {
          page.compileAtStartup[part].syncMs = 0;
        }
        page.compileAtStartup.renderPipelinesAsync.totalSettleMs = 0;
      }
      return page;
    });
  const { pf3 } = compare(
    zeroed(FIXTURE.tip.pages),
    zeroed(FIXTURE.base.pages),
  )[GROUND];
  assert.equal(pf3.compile.provisionalFloor.applied, false);
  assert.ok(pf3.compile.provisionalFloor.notApplicable);
  assert.notEqual(pf3.compile.bandSource, "provisional-floor");
  assert.equal(pf3.provisionalFloor, undefined);
});
