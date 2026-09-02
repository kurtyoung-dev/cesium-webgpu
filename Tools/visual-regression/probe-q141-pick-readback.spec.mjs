// probe-q141-pick-readback.spec.mjs — pins the probe's miss-attribution rule.
//
// @purpose Contract spec for the Q-141 readback probe's attribution: a served-but-empty pick must never be reported as a readback decline, and a decline must be named.
// @status ACTIVE
//
// WHY THIS ONE FUNCTION IS WORTH A SPEC. The probe's whole value is the fork it
// takes on a miss: "the readback machinery refused, and here is the gate" versus
// "the readback machinery answered and the answer was empty, so the defect is in
// pick rendering or residency". Getting that backwards would send the row after
// the wrong subsystem with a receipt that looks authoritative. The rest of the
// probe is Playwright driving and has no logic to pin.

import assert from "node:assert/strict";
import test from "node:test";

import {
  attributePick,
  summarizeAttributions,
} from "./probe-q141-pick-readback.mjs";

function counters(overrides = {}) {
  return {
    endCalls: 0,
    servedFresh: 0,
    servedCached: 0,
    cold: 0,
    serveDeclines: {
      "no-cached-readback": 0,
      "center-outside-cached-region": 0,
      "view-provenance-changed": 0,
    },
    armDeclines: { "readback-in-flight": 0, "no-frame-encoder": 0 },
    readbacksArmed: 0,
    readbacksPublished: 0,
    ageMax: 0,
    ...overrides,
  };
}

test("a miss on a readback that WAS served is not blamed on the readback", () => {
  const before = counters();
  const after = counters({ servedFresh: 1 });
  assert.equal(attributePick(before, after, false), "served-but-empty");
});

test("a miss on a reprojected cache serve is also served-but-empty", () => {
  const before = counters();
  const after = counters({ servedCached: 1 });
  assert.equal(attributePick(before, after, false), "served-but-empty");
});

test("a declined serve is reported by its own gate name", () => {
  const before = counters();
  const after = counters({
    cold: 1,
    serveDeclines: {
      "no-cached-readback": 0,
      "center-outside-cached-region": 1,
      "view-provenance-changed": 0,
    },
  });
  assert.equal(
    attributePick(before, after, false),
    "serve-decline:center-outside-cached-region",
  );
});

test("an arm decline is reported when nothing declined the serve", () => {
  const before = counters();
  const after = counters({
    armDeclines: { "readback-in-flight": 1, "no-frame-encoder": 0 },
  });
  assert.equal(
    attributePick(before, after, false),
    "arm-decline:readback-in-flight",
  );
});

test("a miss with no counter movement at all is called out, not silently bucketed", () => {
  assert.equal(attributePick(counters(), counters(), false), "unattributed");
});

test("a backend without pick counters is named rather than reported as zero", () => {
  assert.equal(attributePick(null, null, false), "counters-unavailable");
  assert.equal(attributePick(null, null, true), "counters-unavailable");
});

test("a hit records whether a serve backed it", () => {
  assert.equal(
    attributePick(counters(), counters({ servedCached: 1 }), true),
    "hit-served",
  );
  assert.equal(
    attributePick(counters(), counters(), true),
    "hit-without-serve",
  );
});

test("the summary counts every label", () => {
  assert.deepEqual(
    summarizeAttributions([
      { attribution: "hit-served" },
      { attribution: "hit-served" },
      { attribution: "served-but-empty" },
    ]),
    { "hit-served": 2, "served-but-empty": 1 },
  );
  assert.deepEqual(summarizeAttributions([]), {});
});
