// capture-exports.spec.mjs - export parity of lib/capture.mjs after its decomposition (DX-KIT-CAPTURE-SEAM-OVER-SIZE). Pure Node: no browser, no GPU.
// @purpose Pins that lib/capture.mjs still exports exactly the 38 names it exported before it was split into capture-{vocabulary,urls,descriptor,metrics,manifest,cell-work,readiness}.mjs, that every moved name is the SAME binding as the piece that now owns it, and that the module and each piece stay under the 1,000-line file-size rule.
// @status ACTIVE
//
// WHY A SPEC FOR A PURE MOVE. A decomposition changes no behaviour, so the
// behaviour specs stay green whether or not a re-export was lost: a probe that
// imports one name the seam stopped re-exporting fails at its own import,
// which is a runtime failure in an Edge session, not a spec failure. This spec
// is the one place that fails when the seam's public surface drifts. The list
// below was generated from the \`export\` declarations of lib/capture.mjs at
// 8a07cf972f, before the split; a name added to the seam later is a deliberate
// edit to this list.
//
// INERTNESS. The mutant imports the seam from a copy of its source with one
// re-export dropped and requires the parity check to report exactly that name,
// while the unmutated seam reports nothing.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as capture from "./lib/capture.mjs";
import * as cellWork from "./lib/capture-cell-work.mjs";
import * as descriptor from "./lib/capture-descriptor.mjs";
import * as manifest from "./lib/capture-manifest.mjs";
import * as metrics from "./lib/capture-metrics.mjs";
import * as readiness from "./lib/capture-readiness.mjs";
import * as urls from "./lib/capture-urls.mjs";
import * as vocabulary from "./lib/capture-vocabulary.mjs";
import { importMutated } from "./lib/import-mutated.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "lib");
const CAPTURE_PATH = path.join(LIB, "capture.mjs");

/** The seam's public surface before the split, sorted. */
const BASE_EXPORTS = Object.freeze([
  "CAPTURE_MANIFEST_KIND",
  "CAPTURE_MANIFEST_SCHEMA_VERSION",
  "CAPTURE_RENDERERS",
  "CAPTURE_SLOTS",
  "CELL_METRIC_PROVENANCE",
  "CELL_STATES",
  "DEFAULT_CELL_BUDGET_MS",
  "DEFAULT_CLOSE_DEADLINE_MS",
  "DEFAULT_NAVIGATION_TIMEOUT_MS",
  "DEFAULT_PAIR_TOLERANCE",
  "DEFAULT_READINESS_POLL_INTERVAL_MS",
  "DEFAULT_READINESS_TIMEOUT_MS",
  "FORBIDDEN_MANIFEST_KEYS",
  "FORBIDDEN_MANIFEST_VALUES",
  "MAX_READINESS_POLLS",
  "MAX_TIMING_OPTION_MS",
  "NON_BLACK_CHANNEL_THRESHOLD",
  "READINESS_PREDICATES",
  "SPLIT_SCREEN_PAGE",
  "TIMING_OPTION_REFUSAL",
  "buildCaptureDescriptor",
  "buildCaptureIncident",
  "buildCaptureManifest",
  "capture",
  "captureUrlFor",
  "cellMetrics",
  "decideCaptureRefusal",
  "decideCellReadinessRefusal",
  "defaultCellWork",
  "deriveCaptureDeadline",
  "describeReadiness",
  "pairMetrics",
  "pollReadiness",
  "resolveCaptureOrigins",
  "resolveRigPage",
  "summariseCellReadiness",
  "validateManifest",
  "waitForCellReadiness",
]);

/** Names that stayed in capture.mjs because the run is built from them. */
const STAYED = Object.freeze(["buildCaptureIncident", "capture"]);

/** Which piece owns which re-exported names. */
const OWNERS = Object.freeze([
  [
    "capture-vocabulary.mjs",
    vocabulary,
    [
      "CAPTURE_MANIFEST_KIND",
      "CAPTURE_MANIFEST_SCHEMA_VERSION",
      "CAPTURE_RENDERERS",
      "CAPTURE_SLOTS",
      "CELL_METRIC_PROVENANCE",
      "CELL_STATES",
      "DEFAULT_CELL_BUDGET_MS",
      "DEFAULT_CLOSE_DEADLINE_MS",
      "DEFAULT_NAVIGATION_TIMEOUT_MS",
      "DEFAULT_PAIR_TOLERANCE",
      "DEFAULT_READINESS_POLL_INTERVAL_MS",
      "DEFAULT_READINESS_TIMEOUT_MS",
      "FORBIDDEN_MANIFEST_KEYS",
      "FORBIDDEN_MANIFEST_VALUES",
      "MAX_READINESS_POLLS",
      "MAX_TIMING_OPTION_MS",
      "NON_BLACK_CHANNEL_THRESHOLD",
      "READINESS_PREDICATES",
      "SPLIT_SCREEN_PAGE",
      "TIMING_OPTION_REFUSAL",
    ],
  ],
  [
    "capture-urls.mjs",
    urls,
    ["captureUrlFor", "resolveCaptureOrigins", "resolveRigPage"],
  ],
  [
    "capture-descriptor.mjs",
    descriptor,
    ["buildCaptureDescriptor", "decideCaptureRefusal", "deriveCaptureDeadline"],
  ],
  ["capture-metrics.mjs", metrics, ["cellMetrics", "pairMetrics"]],
  [
    "capture-manifest.mjs",
    manifest,
    ["buildCaptureManifest", "validateManifest"],
  ],
  ["capture-cell-work.mjs", cellWork, ["defaultCellWork"]],
  [
    "capture-readiness.mjs",
    readiness,
    [
      "decideCellReadinessRefusal",
      "describeReadiness",
      "pollReadiness",
      "summariseCellReadiness",
      "waitForCellReadiness",
    ],
  ],
]);

/**
 * Compare a seam namespace with the base surface and the pieces.
 *
 * @param {object} namespace The capture module namespace under test.
 * @returns {{missing: string[], extra: string[], notSame: string[]}} The drift.
 */
function surfaceDrift(namespace) {
  const actual = Object.keys(namespace).sort();
  const missing = BASE_EXPORTS.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !BASE_EXPORTS.includes(name));
  const notSame = [];
  for (const [, owner, names] of OWNERS) {
    for (const name of names) {
      if (namespace[name] !== owner[name]) {
        notSame.push(name);
      }
    }
  }
  return { missing, extra, notSame };
}

function lineCount(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).length - 1;
}

test("the seam exports exactly the 38 names it exported before the split", () => {
  assert.equal(BASE_EXPORTS.length, 38);
  assert.deepEqual([...BASE_EXPORTS].sort(), [...BASE_EXPORTS]);
  assert.deepEqual(Object.keys(capture).sort(), [...BASE_EXPORTS]);
});

test("every moved name is the same binding as its piece's", () => {
  assert.deepEqual(surfaceDrift(capture), {
    missing: [],
    extra: [],
    notSame: [],
  });
  const owned = OWNERS.flatMap(([, , names]) => names);
  assert.deepEqual(
    [...owned, ...STAYED].sort(),
    [...BASE_EXPORTS],
    "every public name has exactly one owner",
  );
});

test("the names that stayed in the seam are functions it defines itself", () => {
  for (const name of STAYED) {
    assert.equal(typeof capture[name], "function", name);
    for (const [, owner] of OWNERS) {
      assert.equal(Object.hasOwn(owner, name), false, name);
    }
  }
});

test("the pieces' file-private helpers are not part of the seam's surface", () => {
  for (const [name, owner] of [
    ["requireTimingMs", vocabulary],
    ["ORIGIN_REFUSAL_MESSAGE", vocabulary],
    ["unmeasuredCell", manifest],
    ["unmeasuredPair", manifest],
  ]) {
    assert.notEqual(
      typeof owner[name],
      "undefined",
      `${name} lives in its piece`,
    );
    assert.equal(Object.hasOwn(capture, name), false, name);
  }
});

test("the seam and each of its pieces are under the 1,000-line file-size rule", () => {
  const files = ["capture.mjs", ...OWNERS.map(([file]) => file)];
  for (const file of files) {
    const lines = lineCount(path.join(LIB, file));
    assert.ok(lines < 1000, `${file} has ${lines} lines`);
  }
});

test("MUTANT (inertness): a seam that drops one re-export is reported by name", async () => {
  const mutated = await importMutated(CAPTURE_PATH, [
    [
      "  cellMetrics,\n  pairMetrics,\n  buildCaptureManifest,\n",
      "  cellMetrics,\n  buildCaptureManifest,\n",
    ],
  ]);
  assert.equal(
    Object.hasOwn(mutated, "pairMetrics"),
    false,
    "the mutant must lose pairMetrics, otherwise the parity check below proves nothing",
  );
  assert.deepEqual(surfaceDrift(mutated), {
    missing: ["pairMetrics"],
    extra: [],
    notSame: ["pairMetrics"],
  });
  assert.deepEqual(surfaceDrift(capture), {
    missing: [],
    extra: [],
    notSame: [],
  });
});
