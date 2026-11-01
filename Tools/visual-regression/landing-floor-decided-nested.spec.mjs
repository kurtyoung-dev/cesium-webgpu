// landing-floor-decided-nested.spec.mjs - the receipt's nested provisional-floor mark follows the verdict rule the verdict entry reads.
// @purpose Asserts, on banked Edge data driven through compareArms and landingVerdicts, that the provisional-floor mark a PF-3 or PF-4 record carries in the receipt's comparison (comparison[arm].pf3.provisionalFloor, comparison[arm].pf4.provisionalFloor) reads decided false with the verdict that kept it undecided whenever the record is unmeasured, that a measured record keeps the floor's own arithmetic, and that the nested mark and the verdict entry's mark are the same object by value; each site is shown dead by an inertness mutant.
// @status ACTIVE
//
// The finding (row DX-KIT-NESTED-FLOOR-DECIDED): the verdict entry and the summary said an unmeasured row was decided by
// nothing, while the nested record kept the metric's arithmetic (`decided: true` on E-W-30km-hdr|webgpu in the KIT7
// sibling-fallback report). Two readers of one receipt read two answers. The PF-3 data is that report
// (fixtures/landing-kit7-sibling-fallback.json); the PF-4 data is the banked E-W HDR residency pair
// (fixtures/landing-residency-floor/e-w-hdr-webgpu-pf4.json) with one tip window's start read removed, which leaves the
// residency floor applied and its arithmetic decided while the PF-4 record reads unmeasured.
//
// RUN: CESIUM_LANE=<lane> node --test Tools/visual-regression/landing-floor-decided-nested.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importMutated } from "./lib/import-mutated.mjs";
import { compareArms, landingVerdicts } from "./lib/landing-verdicts.mjs";
import { groupArms } from "./lib/metrics/merge-landing-reports.mjs";
import {
  PERF_VERDICTS,
  contentionGuard,
  floorMarkUnder,
} from "./lib/metrics/perf-band.mjs";
import { provisionalFloorMark } from "./lib/metrics/startup-compile.mjs";

const readFixture = (relative) =>
  JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), "utf8"));

const KIT7 = readFixture("./fixtures/landing-kit7-sibling-fallback.json");
const RESIDENCY = readFixture(
  "./fixtures/landing-residency-floor/e-w-hdr-webgpu-pf4.json",
);

const FAR_HDR = "E-W-30km-hdr|webgpu|scene";
const MEASURED = ["E-W-ground|webgpu|scene", "E-W-ground-hdr|webgpu|scene"];
const GROUND_HDR = "E-W-ground-hdr|webgpu|scene";

const fileOf = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const PERF_BAND_FILE = fileOf("./lib/metrics/perf-band.mjs");
const STARTUP_FILE = fileOf("./lib/metrics/startup-compile.mjs");
const RESIDENCY_FILE = fileOf("./lib/metrics/gpu-memory-residency.mjs");

const entryOf = (comparison, id) =>
  landingVerdicts([], comparison).find((verdict) => verdict.id === id);

const kit7Arms = () => ({
  tip: groupArms(structuredClone(KIT7.tip.pages)),
  base: groupArms(structuredClone(KIT7.base.pages)),
});

/** The PF-4 tip arms with one window's start read gone: PF-4 unmeasured, the floor still applied. */
function residencyTipWithoutOneStart() {
  const arms = structuredClone(RESIDENCY.tip);
  arms[GROUND_HDR].inputs.pf4[0].start = null;
  return arms;
}

/** PF-3 of one KIT7 arm through a startup-compile module (the real one or a mutant), as compareArms calls it. */
function pf3Through(startupModule, key) {
  const { tip, base } = kit7Arms();
  const contention = contentionGuard({
    baseCpu: base[key].inputs.cpu,
    tipCpu: tip[key].inputs.cpu,
    baseSamples: base[key].inputs.cpuSamples ?? [],
    tipSamples: tip[key].inputs.cpuSamples ?? [],
    bands: {},
  });
  return startupModule.startupVerdict({
    baseRuns: base[key].inputs.pf3,
    tipRuns: tip[key].inputs.pf3,
    bands: {},
    renderer: "webgpu",
    contention,
  });
}

/** PF-4 of the edited residency pair through a residency module (the real one or a mutant). */
function pf4Through(residencyModule) {
  const tip = residencyTipWithoutOneStart();
  return residencyModule.residencyVerdict({
    baseRuns: RESIDENCY.base[GROUND_HDR].inputs.pf4,
    tipRuns: tip[GROUND_HDR].inputs.pf4,
    bands: {},
  });
}

// ---- the premise ---------------------------------------------------------------------------------

test("premise: the KIT7 E-W-30km-hdr PF-3 record is unmeasured while the floor's arithmetic alone says decided", () => {
  const { tip, base } = kit7Arms();
  const pf3 = compareArms(tip, base, {})[FAR_HDR].pf3;
  assert.equal(pf3.verdict, PERF_VERDICTS.UNMEASURED_CONTENDED);
  assert.equal(provisionalFloorMark(pf3.compile).decided, true);
});

test("premise: the edited residency pair reads PF-4 unmeasured with the floor applied and its arithmetic decided", () => {
  const pf4 = compareArms(residencyTipWithoutOneStart(), RESIDENCY.base, {})[
    GROUND_HDR
  ].pf4;
  assert.equal(pf4.verdict, PERF_VERDICTS.UNMEASURED);
  assert.equal(pf4.residency.provisionalFloor.applied, true);
  assert.ok(
    pf4.residency.tip > pf4.residency.base,
    "arithmetic: tip over base + 0 B",
  );
});

// ---- the nested mark -----------------------------------------------------------------------------

test("an unmeasured PF-3 record's nested floor mark reads decided false, says why, and equals the verdict entry's", () => {
  const { tip, base } = kit7Arms();
  const comparison = compareArms(tip, base, {});
  const nested = comparison[FAR_HDR].pf3.provisionalFloor;
  assert.equal(nested.decided, false);
  assert.equal(nested.undecidedBecause, PERF_VERDICTS.UNMEASURED_CONTENDED);
  assert.deepEqual(
    entryOf(comparison, `${FAR_HDR}:PF-3`).provisionalFloor,
    nested,
  );
});

test("a measured PF-3 record keeps the floor's own arithmetic, with no undecided reason, and the entry agrees", () => {
  const { tip, base } = kit7Arms();
  const comparison = compareArms(tip, base, {});
  let seen = 0;
  for (const key of MEASURED) {
    const pf3 = comparison[key].pf3;
    if (!pf3?.provisionalFloor) {
      continue;
    }
    seen++;
    assert.equal(
      pf3.verdict === PERF_VERDICTS.WITHIN ||
        pf3.verdict === PERF_VERDICTS.OVER,
      true,
      key,
    );
    assert.deepEqual(
      pf3.provisionalFloor,
      provisionalFloorMark(pf3.compile),
      key,
    );
    assert.equal("undecidedBecause" in pf3.provisionalFloor, false, key);
    assert.deepEqual(
      entryOf(comparison, `${key}:PF-3`).provisionalFloor,
      pf3.provisionalFloor,
      key,
    );
  }
  assert.ok(seen > 0, "at least one measured arm carries a floor mark");
});

test("an unmeasured PF-4 record's nested floor mark reads decided false, says why, and equals the verdict entry's", () => {
  const comparison = compareArms(
    residencyTipWithoutOneStart(),
    RESIDENCY.base,
    {},
  );
  const nested = comparison[GROUND_HDR].pf4.provisionalFloor;
  assert.equal(nested.decided, false);
  assert.equal(nested.undecidedBecause, PERF_VERDICTS.UNMEASURED);
  assert.equal(nested.floorBytes, 40000);
  assert.deepEqual(
    entryOf(comparison, `${GROUND_HDR}:PF-4`).provisionalFloor,
    nested,
  );
});

test("floorMarkUnder: every unmeasured word undecides, a measured word and a missing mark pass through", () => {
  const mark = { flag: "provisional-floor", fraction: 0.6, decided: true };
  for (const word of Object.values(PERF_VERDICTS)) {
    const under = floorMarkUnder(mark, word);
    if (word.startsWith("unmeasured")) {
      assert.deepEqual(
        under,
        { ...mark, decided: false, undecidedBecause: word },
        word,
      );
    } else {
      assert.equal(under, mark, word);
    }
  }
  assert.equal(floorMarkUnder(null, PERF_VERDICTS.UNMEASURED), null);
  assert.equal(floorMarkUnder(undefined, PERF_VERDICTS.UNMEASURED), undefined);
  assert.equal(mark.decided, true, "the input mark is not rewritten");
});

// ---- inertness mutants ---------------------------------------------------------------------------

test("mutant: the rule made unreachable leaves the unmeasured mark decided by its arithmetic", async () => {
  const mutated = await importMutated(PERF_BAND_FILE, [
    [
      "  return isUnmeasuredVerdict(verdict)\n    ? { ...mark, decided: false, undecidedBecause: verdict }",
      "  return false && isUnmeasuredVerdict(verdict)\n    ? { ...mark, decided: false, undecidedBecause: verdict }",
    ],
  ]);
  const under = mutated.floorMarkUnder(
    { decided: true },
    PERF_VERDICTS.UNMEASURED_CONTENDED,
  );
  assert.equal(
    under.decided,
    true,
    "the mutant must leave the arithmetic standing",
  );
});

test("mutant: the PF-3 record's call made unreachable brings the nested arithmetic back", async () => {
  const anchor = "floorMarkUnder(provisionalFloorMark(compile), verdict)";
  const mutated = await importMutated(STARTUP_FILE, [
    [anchor, `(false && ${anchor}) || provisionalFloorMark(compile)`],
  ]);
  const real = pf3Through(
    await import("./lib/metrics/startup-compile.mjs"),
    FAR_HDR,
  );
  const dead = pf3Through(mutated, FAR_HDR);
  assert.equal(real.provisionalFloor.decided, false);
  assert.equal(dead.provisionalFloor.decided, true);
  assert.equal(dead.verdict, PERF_VERDICTS.UNMEASURED_CONTENDED);
});

test("mutant: the PF-4 record's call made unreachable brings the nested arithmetic back", async () => {
  const anchor = "floorMarkUnder(floorMark, verdict)";
  const mutated = await importMutated(RESIDENCY_FILE, [
    [anchor, `(false && ${anchor}) || floorMark`],
  ]);
  const real = pf4Through(
    await import("./lib/metrics/gpu-memory-residency.mjs"),
  );
  const dead = pf4Through(mutated);
  assert.equal(real.provisionalFloor.decided, false);
  assert.equal(dead.provisionalFloor.decided, true);
  assert.equal(dead.verdict, PERF_VERDICTS.UNMEASURED);
});
