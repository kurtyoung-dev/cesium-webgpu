// refresh-cost-multi-metric.spec.mjs — Node-side coverage of the Q-80
// refresh-cost multi-metric aggregation formulas in
// probe-eclipse-cloud-response.mjs, with a canonicity pin against the
// probe's real source text.
//
// @purpose Independent behavioural + canonicity coverage of Q-80's deltaOrNull/sumLegMultiMetric/available-guard formulas, which live inside a page.evaluate callback and cannot be imported.
// @status ACTIVE
//
// WHY A REIMPLEMENTATION, NOT AN IMPORT. `deltaOrNull`, `sumLegMultiMetric`
// and the `memory`/`allocations` `available` guards are defined inside the
// `RUN_IBL_SWEEP` page.evaluate callback in probe-eclipse-cloud-response.mjs
// — per that file's own documented convention ("EVERY helper used inside a
// page.evaluate callback is defined INSIDE that callback — module-scope
// bindings do not cross the serialization boundary"), they cannot be
// imported into a bare Node module the way `collectC1229S5ReplacementSourceBoundary`
// (a genuine module-level export in the C12-29 S5 replacement-device family)
// can be.
//
// SO THIS FILE MIRRORS THE FORMULAS AND PINS THE MIRROR AGAINST THE REAL
// SOURCE TEXT. Section A asserts each mirrored snippet appears byte-for-byte
// (after CRLF normalisation) in the probe, exactly once. If the real formula
// changes, either this mirror is updated in the same commit or section A
// reds — the mirror cannot silently drift the way an unpinned duplicate
// would. Section B exercises the mirror's BEHAVIOUR against synthetic
// segment data. Section C proves section B's assertions are load-bearing by
// mutating the mirror itself and showing the tests catch it (this file's own
// `node --test` run is the evidence; see the landing packet for the
// mutate-and-restore transcript, since a mutant inside this same file cannot
// self-report without an external harness).
//
// station-3 review pass 1 (Q-80): the packet's original arithmetic proof was
// a throwaway scratchpad script, discarded after use — "216 new probe lines
// with no landed test". This file is that test, landed. It also covers the
// review's second finding: `costSegments.every(...)` on an EMPTY array is
// vacuously `true`, so an empty run previously reported `available: true`
// alongside null totals; the probe's guard was fixed to
// `costSegments.length > 0 && costSegments.every(...)`, and section B pins
// that the empty case is now `false`.
//
// Run: node --test Tools/visual-regression/refresh-cost-multi-metric.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const probeSource = fs
  .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
  .replace(/\r\n/g, "\n");

// ─── A. canonicity: each mirrored snippet exists verbatim in the probe ──────

const CANONICAL_SNIPPETS = {
  deltaOrNull:
    "  const deltaOrNull = (before, after, field) =>\n" +
    "    before?.available && after?.available ? after[field] - before[field] : null;\n",
  sumLegMultiMetric:
    "  const sumLegMultiMetric = (leg, group, deltaField) => {\n" +
    "    const legSegments = costSegments.filter((segment) => segment.leg === leg);\n" +
    "    if (\n" +
    "      legSegments.length === 0 ||\n" +
    "      legSegments.some((segment) => segment[group][deltaField] === null)\n" +
    "    ) {\n" +
    "      return null;\n" +
    "    }\n" +
    "    return legSegments.reduce(\n" +
    "      (total, segment) => total + segment[group][deltaField],\n" +
    "      0,\n" +
    "    );\n" +
    "  };\n",
  memoryAvailableGuard:
    "      available:\n" +
    "        costSegments.length > 0 &&\n" +
    "        costSegments.every((segment) => segment.memory.heapDeltaBytes !== null),\n",
  allocationsAvailableGuard:
    "      available:\n" +
    "        costSegments.length > 0 &&\n" +
    "        costSegments.every(\n" +
    "          (segment) => segment.allocations.bufferCreatesDelta !== null,\n" +
    "        ),\n",
  // station-3 review pass 2 (B2): section A above pins the FORMULAS' text —
  // it has zero power over whether they are actually CALLED, or called with
  // the right leg. Two probe mutants proved this: deleting both
  // `...finishCostMultiMetric(multiMetricBefore),` call sites (the whole
  // Q-80 feature made inert — no segment ever carries `.memory`/`.allocations`)
  // and rewiring `eclipseHeapDeltaBytes` to read the `"control"` leg both
  // left every test in this file GREEN. These five entries close that
  // reachability/wiring gap the same way section A closes the drift gap.
  multiMetricBeforeSample:
    "    const multiMetricBefore = sampleCostMultiMetric();\n",
  eclipseMemoryLegWiring:
    "      eclipseHeapDeltaBytes: sumLegMultiMetric(\n" +
    '        "eclipse",\n' +
    '        "memory",\n' +
    '        "heapDeltaBytes",\n' +
    "      ),\n",
  controlMemoryLegWiring:
    "      controlHeapDeltaBytes: sumLegMultiMetric(\n" +
    '        "control",\n' +
    '        "memory",\n' +
    '        "heapDeltaBytes",\n' +
    "      ),\n",
  eclipseAllocationsLegWiring:
    "      eclipseBufferCreatesDelta: sumLegMultiMetric(\n" +
    '        "eclipse",\n' +
    '        "allocations",\n' +
    '        "bufferCreatesDelta",\n' +
    "      ),\n",
  controlAllocationsLegWiring:
    "      controlBufferCreatesDelta: sumLegMultiMetric(\n" +
    '        "control",\n' +
    '        "allocations",\n' +
    '        "bufferCreatesDelta",\n' +
    "      ),\n",
};

// The one canonical snippet whose PRISTINE count is not 1: the two
// `...finishCostMultiMetric(multiMetricBefore),` call sites live at
// different indentation depths in the probe's two return branches (the
// no-GPU-capture fallback nests one level deeper than the full GPU path),
// so this 6-space-indented form is a substring of both — deleting EITHER
// or BOTH call sites (the P3 mutant deletes both) changes this count away
// from 2, which a per-entry expected-count of 1 could not detect.
const CALL_SITE_SNIPPET =
  "      ...finishCostMultiMetric(multiMetricBefore),\n";
const CALL_SITE_EXPECTED_COUNT = 2;

for (const [name, snippet] of Object.entries(CANONICAL_SNIPPETS)) {
  test(`A: the probe's real "${name}" text matches this file's mirror, exactly once`, () => {
    const occurrences = probeSource.split(snippet).length - 1;
    assert.equal(
      occurrences,
      1,
      `expected exactly one occurrence of the canonical "${name}" snippet in ` +
        `probe-eclipse-cloud-response.mjs — 0 means the probe's real formula ` +
        `changed and this mirror is stale; >1 is unexpected duplication`,
    );
  });
}

test("A2: both finishCostMultiMetric call sites are present — reds if either return branch stops carrying memory/allocations", () => {
  const occurrences = probeSource.split(CALL_SITE_SNIPPET).length - 1;
  assert.equal(
    occurrences,
    CALL_SITE_EXPECTED_COUNT,
    `expected ${CALL_SITE_EXPECTED_COUNT} occurrences of the ` +
      `finishCostMultiMetric call-site snippet (one per runCostSegment ` +
      `return branch) — fewer means at least one branch stopped attaching ` +
      `memory/allocations to its segments (this is what deleting both call ` +
      `sites, station-3 review pass 2's mutant P3, does: 0 occurrences, and ` +
      `every OTHER test in this file stayed green)`,
  );
});

// ─── B. the mirror's behaviour, exercised against synthetic segment data ────

/** Verbatim mirror of the probe's `deltaOrNull`. */
function deltaOrNull(before, after, field) {
  return before?.available && after?.available
    ? after[field] - before[field]
    : null;
}

/** Verbatim mirror of the probe's `sumLegMultiMetric`. */
function sumLegMultiMetric(costSegments, leg, group, deltaField) {
  const legSegments = costSegments.filter((segment) => segment.leg === leg);
  if (
    legSegments.length === 0 ||
    legSegments.some((segment) => segment[group][deltaField] === null)
  ) {
    return null;
  }
  return legSegments.reduce(
    (total, segment) => total + segment[group][deltaField],
    0,
  );
}

/** Verbatim mirror of `refreshCost.memory.available` / `.allocations.available`. */
function multiMetricAvailable(costSegments, group, deltaField) {
  return (
    costSegments.length > 0 &&
    costSegments.every((segment) => segment[group][deltaField] !== null)
  );
}

test("B1: deltaOrNull returns the real delta when both samples are available", () => {
  assert.equal(
    deltaOrNull({ available: true, x: 100 }, { available: true, x: 140 }, "x"),
    40,
  );
});

test("B2: deltaOrNull returns null (never a fabricated number) when either sample is unavailable", () => {
  assert.equal(
    deltaOrNull({ available: false, x: 100 }, { available: true, x: 140 }, "x"),
    null,
  );
  assert.equal(
    deltaOrNull({ available: true, x: 100 }, { available: false, x: 140 }, "x"),
    null,
  );
});

test("B3: deltaOrNull lets a negative delta survive unclamped (GC noise can shrink heap usage)", () => {
  assert.equal(
    deltaOrNull({ available: true, x: 500 }, { available: true, x: 300 }, "x"),
    -200,
  );
});

const SEGMENTS = [
  { leg: "eclipse", memory: { heapDeltaBytes: 1000 } },
  { leg: "control", memory: { heapDeltaBytes: 10 } },
  { leg: "eclipse", memory: { heapDeltaBytes: 2000 } },
  { leg: "control", memory: { heapDeltaBytes: 20 } },
];

test("B4: sumLegMultiMetric sums only the named leg's segments", () => {
  assert.equal(
    sumLegMultiMetric(SEGMENTS, "eclipse", "memory", "heapDeltaBytes"),
    3000,
  );
  assert.equal(
    sumLegMultiMetric(SEGMENTS, "control", "memory", "heapDeltaBytes"),
    30,
  );
});

test("B5: sumLegMultiMetric nulls the WHOLE leg total the instant one segment is unavailable", () => {
  const withOneHole = [
    { leg: "eclipse", memory: { heapDeltaBytes: 1000 } },
    { leg: "eclipse", memory: { heapDeltaBytes: null } },
  ];
  assert.equal(
    sumLegMultiMetric(withOneHole, "eclipse", "memory", "heapDeltaBytes"),
    null,
    "a partial sum next to a full-looking field name would be worse than an explicit null",
  );
});

test("B6: sumLegMultiMetric returns null (never 0) for an empty/absent leg", () => {
  assert.equal(
    sumLegMultiMetric(SEGMENTS, "nonexistent-leg", "memory", "heapDeltaBytes"),
    null,
    "0 would falsely claim the leg was measured and net zero",
  );
});

test("B7: multiMetricAvailable is true only when every segment has a non-null sample", () => {
  assert.equal(
    multiMetricAvailable(SEGMENTS, "memory", "heapDeltaBytes"),
    true,
  );
  const withOneHole = [
    { leg: "eclipse", memory: { heapDeltaBytes: 1000 } },
    { leg: "eclipse", memory: { heapDeltaBytes: null } },
  ];
  assert.equal(
    multiMetricAvailable(withOneHole, "memory", "heapDeltaBytes"),
    false,
  );
});

test("B8: multiMetricAvailable is false — not vacuously true — for an empty costSegments array", () => {
  // The fix this file lands (station-3 review pass 1): `[].every(...)` is
  // vacuously `true` in plain JS, which is exactly why the probe's ORIGINAL
  // guard (`costSegments.every(...)` with no length check) reported
  // `available: true` alongside null totals for a run that measured nothing.
  assert.equal(
    multiMetricAvailable([], "memory", "heapDeltaBytes"),
    false,
    "an empty run must report available:false, not true-with-null-totals",
  );
});

// ─── C. the empty-array fix is load-bearing, demonstrated in-process ───────

test("C1: the naive (unfixed) guard — every() with no length check — is vacuously true on empty input, confirming the defect this file's B8 guards against", () => {
  const naiveAvailable = (costSegments) =>
    costSegments.every((segment) => segment.memory.heapDeltaBytes !== null);
  assert.equal(
    naiveAvailable([]),
    true,
    "this documents the PRE-fix behaviour — the naive guard IS vacuously true, which is why the length check in multiMetricAvailable (B8) and in the probe's real guard (section A) is necessary, not decorative",
  );
});
