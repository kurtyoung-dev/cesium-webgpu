// landing-residency-floor.spec.mjs - the provisional same-build allowance floor PF-4's liveBytes reads, and what its record and verdict say about it.
//
// @purpose Asserts, through compareArms and landingVerdicts (the probe's own comparison and verdict path, with the {} band overrides the probe passes for a wave that registers none), that two same-build E-W HDR WebGPU arms whose live bytes differ by tens of KB read PF-4 `within` under the 40 000 B provisional floor where an allowance of 0 B read `over`, that the residency record names the floor (flag, source, floor, declared allocation, whether it was the larger term), that the PF-4 verdict and its entry in the verdict list carry the provisional-floor mark with `decided` true exactly where the declared allocation alone would read the tip `over`, that a tip past the floor still reads `over` with a reason naming the allowance used, that the growth rule is untouched, and that a pre-registered allocation above the floor wins and leaves no mark.
// @status ACTIVE
//
// Written from the observable contract (row DX-KIT-PF4-RESIDENCY-ALLOWANCE-ZERO): the liveBytes verdict
// reads base + max(declared allocation, 40 000 B). The census windows are the two E-W HDR WebGPU arms of a
// banked Edge report pair (fixtures/landing-residency-floor), served from one build, two repeats per arm;
// `banked` holds what the same windows read before the floor existed, the independent source for "the
// growth statistic is unchanged".
//
// RUN: node --test Tools/visual-regression/landing-residency-floor.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compareArms, landingVerdicts } from "./lib/landing-verdicts.mjs";
import {
  RESIDENCY_ALLOWANCE_FLOOR_BYTES,
  RESIDENCY_PROVISIONAL_FLOOR,
} from "./lib/metrics/gpu-memory-residency.mjs";

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "landing-residency-floor",
      "e-w-hdr-webgpu-pf4.json",
    ),
    "utf8",
  ),
);

const GROUND = "E-W-ground-hdr|webgpu|scene";
const FAR = "E-W-30km-hdr|webgpu|scene";

const BASE_MEDIAN = 346649263;
const TIP_MEDIAN = 346667833;

const clone = (value) => structuredClone(value);

/** Compare a (possibly edited) tip against the banked base; returns the PF-4 verdict and the verdict list. */
function read(tipArms = FIXTURE.tip, bands = {}, key = GROUND) {
  const comparison = compareArms(clone(tipArms), clone(FIXTURE.base), bands);
  const verdicts = landingVerdicts([], comparison);
  return {
    pf4: comparison[key].pf4,
    entry: verdicts.find((v) => v.id === `${key}:PF-4`),
    verdicts,
  };
}

/** A copy of the tip arms whose census windows of `key` are edited by `edit(window, index)`. */
function withTipWindows(key, edit) {
  const arms = clone(FIXTURE.tip);
  arms[key].inputs.pf4.forEach((window, index) => edit(window, index));
  return arms;
}

const shift = (window, bytes) => {
  window.start.textures.liveBytes += bytes;
  window.end.textures.liveBytes += bytes;
};

test("R1: the banked pair PF-4 read over under an allowance of 0 B now reads within, the floor flagged and both figures visible", () => {
  const banked = FIXTURE.banked[GROUND];
  assert.equal(banked.verdict, "over", "the pair was a red");
  assert.equal(banked.residency.allocationBytes, 0);

  const { pf4 } = read();
  assert.equal(pf4.verdict, "within");
  assert.equal(pf4.residency.verdict, "within");
  assert.equal(pf4.residency.base, BASE_MEDIAN);
  assert.equal(pf4.residency.tip, TIP_MEDIAN);
  assert.equal(pf4.residency.base, banked.residency.base);
  assert.equal(pf4.residency.tip, banked.residency.tip);
  assert.equal(pf4.residency.limit, 346689263);
  assert.equal(pf4.residency.allocationBytes, 40000);
  assert.deepEqual(pf4.residency.provisionalFloor, {
    flag: "provisional-floor",
    floorBytes: 40000,
    source: RESIDENCY_PROVISIONAL_FLOOR.source,
    registeredAllocationBytes: 0,
    applied: true,
  });
  assert.match(
    pf4.residency.provisionalFloor.source,
    /KIT6 phase-2 item-6.*E-W-ground-hdr\|webgpu.*37,140 B.*two repeats, one arm/,
  );
  assert.equal(RESIDENCY_ALLOWANCE_FLOOR_BYTES, 40000);
  assert.ok(Object.isFrozen(RESIDENCY_PROVISIONAL_FLOOR));
});

test("R2: the verdict and its entry in the verdict list carry the mark, decided true because a declared 0 B alone read the tip over", () => {
  const { pf4, entry } = read();
  const mark = {
    flag: "provisional-floor",
    floorBytes: 40000,
    registeredAllocationBytes: 0,
    decided: true,
  };
  assert.deepEqual(pf4.provisionalFloor, mark);
  assert.equal(entry.verdict, "within");
  assert.equal(entry.pass, true);
  assert.deepEqual(entry.provisionalFloor, mark);
  // The other PF entries of the arm do not carry a PF-4 mark.
  for (const other of read().verdicts.filter(
    (v) => v.id.startsWith(`${GROUND}:PF-`) && v.id !== `${GROUND}:PF-4`,
  )) {
    assert.equal(other.provisionalFloor, undefined, other.id);
  }
});

test("R3: the other arm, whose tip median equals its base median, carries the mark with decided false", () => {
  const { pf4, entry } = read(FIXTURE.tip, {}, FAR);
  assert.equal(FIXTURE.banked[FAR].verdict, "within");
  assert.equal(pf4.verdict, "within");
  assert.equal(pf4.residency.tip, pf4.residency.base);
  assert.equal(pf4.provisionalFloor.decided, false);
  assert.equal(pf4.provisionalFloor.floorBytes, 40000);
  assert.deepEqual(entry.provisionalFloor, pf4.provisionalFloor);
  assert.equal(entry.pass, true);
});

test("R4: a tip 50 000 B over the base median reads over, the reason names the floor as the allowance used, the mark says decided", () => {
  const tip = withTipWindows(GROUND, (window) =>
    shift(window, BASE_MEDIAN + 50000 - TIP_MEDIAN),
  );
  const { pf4, entry } = read(tip);
  assert.equal(pf4.residency.tip, BASE_MEDIAN + 50000);
  assert.equal(pf4.residency.limit, BASE_MEDIAN + 40000);
  assert.equal(pf4.residency.verdict, "over");
  assert.equal(pf4.verdict, "over");
  assert.match(pf4.residency.reasons[0], /provisional floor 40000 B/);
  assert.match(pf4.residency.reasons[0], new RegExp(`base ${BASE_MEDIAN} B`));
  // decided is "the declared allocation alone would read over": a tip that
  // is over even with the floor is over without it, so true.
  assert.equal(pf4.provisionalFloor.decided, true);
  assert.equal(entry.pass, false);
  assert.equal(entry.verdict, "over");
  assert.equal(entry.provisionalFloor.decided, true);
});

test("R5: the limit is inclusive, one byte past it reads over", () => {
  const atLimit = withTipWindows(GROUND, (window) =>
    shift(window, BASE_MEDIAN + 40000 - TIP_MEDIAN),
  );
  assert.equal(read(atLimit).pf4.residency.verdict, "within");
  const past = withTipWindows(GROUND, (window) =>
    shift(window, BASE_MEDIAN + 40001 - TIP_MEDIAN),
  );
  assert.equal(read(past).pf4.residency.verdict, "over");
});

test("R6: a tip window that grows still reads PF-4 over by the growth rule while liveBytes is within, and the growth statistic is what it was", () => {
  const banked = FIXTURE.banked[GROUND];
  assert.deepEqual(read().pf4.growth.tip, banked.growth.tip);
  assert.equal(read().pf4.growth.allowance, banked.growth.allowance);
  assert.equal(read().pf4.growth.verdict, banked.growth.verdict);

  const tip = withTipWindows(GROUND, (window, index) => {
    if (index === 0) {
      window.start.textures.liveBytes -= 1000;
    }
  });
  const { pf4, entry } = read(tip);
  assert.equal(pf4.residency.verdict, "within");
  assert.deepEqual(pf4.growth.tip, [1000, 0]);
  assert.equal(pf4.growth.allowance, 0);
  assert.equal(pf4.growth.verdict, "over");
  assert.match(pf4.growth.reasons[0], /grew 1000 B, over the allowance 0 B/);
  assert.equal(pf4.verdict, "over");
  assert.equal(entry.pass, false);
  assert.equal(entry.verdict, "over");
  assert.equal(pf4.growth.provisionalFloor, undefined);
});

test("R7: a tip that grows by what a growing base grows is within, the floor adding nothing to the growth allowance", () => {
  const base = clone(FIXTURE.base);
  base[GROUND].inputs.pf4.forEach((window) => {
    window.start.textures.liveBytes -= 5000;
  });
  const tip = withTipWindows(GROUND, (window) => {
    window.start.textures.liveBytes -= 5000;
  });
  const grown = compareArms(clone(tip), base, {})[GROUND].pf4;
  assert.deepEqual(grown.growth.base, [5000, 5000]);
  assert.deepEqual(grown.growth.tip, [5000, 5000]);
  assert.equal(grown.growth.verdict, "within");
  assert.equal(grown.verdict, "within");
});

test("R8: a declared allocation above the floor wins, with no mark on the verdict or its entry", () => {
  const { pf4, entry } = read(FIXTURE.tip, { allocationBytes: 100000 });
  assert.equal(pf4.verdict, "within");
  assert.equal(pf4.residency.allocationBytes, 100000);
  assert.equal(pf4.residency.limit, BASE_MEDIAN + 100000);
  assert.equal(pf4.residency.provisionalFloor.applied, false);
  assert.equal(
    pf4.residency.provisionalFloor.registeredAllocationBytes,
    100000,
  );
  assert.equal("provisionalFloor" in pf4, false);
  assert.equal("provisionalFloor" in entry, false);
  assert.equal(entry.pass, true);

  const past = withTipWindows(GROUND, (window) =>
    shift(window, BASE_MEDIAN + 100001 - TIP_MEDIAN),
  );
  const over = read(past, { allocationBytes: 100000 });
  assert.equal(over.pf4.residency.verdict, "over");
  assert.match(over.pf4.residency.reasons[0], /declared 100000 B/);
  assert.equal("provisionalFloor" in over.pf4, false);
});

test("R9: a declared allocation below the floor is raised to it, and decided is judged against the declared figure, not 0", () => {
  // tip is 18 570 B above the base median: over a declared 0 B, within a declared 20 000 B.
  const { pf4, entry } = read(FIXTURE.tip, { allocationBytes: 20000 });
  assert.equal(pf4.residency.allocationBytes, 40000);
  assert.equal(pf4.residency.provisionalFloor.applied, true);
  assert.equal(pf4.residency.provisionalFloor.registeredAllocationBytes, 20000);
  assert.equal(pf4.verdict, "within");
  assert.deepEqual(pf4.provisionalFloor, {
    flag: "provisional-floor",
    floorBytes: 40000,
    registeredAllocationBytes: 20000,
    decided: false,
  });
  assert.deepEqual(entry.provisionalFloor, pf4.provisionalFloor);
});

test("R10: an arm with no census read has no limit and no mark, and reads unmeasured", () => {
  const tip = withTipWindows(GROUND, (window) => {
    window.start = { installed: false };
    window.end = { installed: false };
  });
  const { pf4, entry } = read(tip);
  assert.equal(pf4.residency.limit, null);
  assert.equal(pf4.residency.provisionalFloor, undefined);
  assert.equal("provisionalFloor" in pf4, false);
  assert.equal(pf4.verdict, "unmeasured");
  assert.equal(entry.pass, false);
  assert.equal(entry.notRun, true);
  assert.equal("provisionalFloor" in entry, false);
});

test("R11: an arm pair whose census counted no live bytes (a WebGL page) reads the declared allocation, no mark, the record saying why", () => {
  const zero = (arms) => {
    for (const window of arms[GROUND].inputs.pf4) {
      for (const snapshot of [window.start, window.end]) {
        snapshot.textures.liveBytes = 0;
        snapshot.buffers.liveBytes = 0;
      }
    }
    return arms;
  };
  const comparison = compareArms(
    zero(clone(FIXTURE.tip)),
    zero(clone(FIXTURE.base)),
    {},
  );
  const pf4 = comparison[GROUND].pf4;
  assert.equal(pf4.residency.verdict, "within");
  assert.equal(pf4.residency.limit, 0);
  assert.equal(pf4.residency.provisionalFloor.applied, false);
  assert.equal(
    pf4.residency.provisionalFloor.notApplicable,
    "no live bytes measured on both arms",
  );
  assert.equal("provisionalFloor" in pf4, false);
  const entry = landingVerdicts([], comparison).find(
    (v) => v.id === `${GROUND}:PF-4`,
  );
  assert.equal("provisionalFloor" in entry, false);
});
