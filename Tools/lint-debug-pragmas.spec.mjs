// lint-debug-pragmas.spec.mjs — synthetic-source contract for permanent diagnostics.
// @purpose Proves debug-console calls stay removable unless a narrowly marked warning must remain visible.
// @status ACTIVE
//
// Run: node --test Tools/lint-debug-pragmas.spec.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { findOffenders } from "./lint-debug-pragmas.mjs";

const FIXTURE_PATH = "synthetic/fixture.ts";

function offendersFor(...lines) {
  return findOffenders(`${lines.join("\n")}\n`, FIXTURE_PATH);
}

function assertSingleOffender(offenders, expectedMethod) {
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].file, FIXTURE_PATH);
  assert.match(offenders[0].text, new RegExp(`console\\.${expectedMethod}`));
}

test("an unmarked interpolated console.warn is reported", () => {
  const offenders = offendersFor(
    "console.warn(`cold pick returned ${result}`);",
  );
  assertSingleOffender(offenders, "warn");
});

test("a marked interpolated console.warn is allowed", () => {
  const offenders = offendersFor(
    "// lint-debug-pragmas-allow: this warning explains a production fallback",
    "console.warn(`fallback selected for ${reason}`);",
  );
  assert.deepEqual(offenders, []);
});

test("the marker does not exempt an interpolated console.log", () => {
  const offenders = offendersFor(
    "// lint-debug-pragmas-allow: copied onto the wrong console method",
    "console.log(`frame ${frameNumber}`);",
  );
  assertSingleOffender(offenders, "log");
});

test("an unmarked interpolated console.log is reported", () => {
  const offenders = offendersFor("console.log(`frame ${frameNumber}`);");
  assertSingleOffender(offenders, "log");
});

test("a debug-pragma-wrapped call is not reported", () => {
  const offenders = offendersFor(
    "//>>includeStart('debug', pragmas.debug)",
    "console.log(`frame ${frameNumber}`);",
    "//>>includeEnd('debug')",
  );
  assert.deepEqual(offenders, []);
});

test("console.error is never reported, with or without a marker", () => {
  const offenders = offendersFor(
    "console.error(`pipeline failed: ${error.message}`);",
    "// lint-debug-pragmas-allow: redundant marker must not change error policy",
    "console.error(`device lost: ${reason}`);",
  );
  assert.deepEqual(offenders, []);
});

test("a console.log inside a JSDoc example is not reported", () => {
  const offenders = offendersFor(
    "/**",
    " * @example",
    " * console.log(`picked ${feature.id}`);",
    " */",
  );
  assert.deepEqual(offenders, []);
});

test("marker text inside a warning message cannot exempt the call", () => {
  const offenders = offendersFor(
    "console.warn(`lint-debug-pragmas-allow: ${detail}`);",
  );
  assertSingleOffender(offenders, "warn");
});
