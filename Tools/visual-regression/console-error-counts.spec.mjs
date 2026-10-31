// console-error-counts.spec.mjs - classifyConsoleErrors counts every console line and keeps only a sample of the text.
// @purpose Row DX-KIT-CONSOLE-ERROR-LIST-CAP: over more than five lines classifyConsoleErrors returns the full non-sentinel error count (otherCount) and the full page-error count (pageErrorCount) beside samples of at most five (other, pageErrors), so a receipt never reads the sample's length as the count; with an inertness mutant that counts only what the sample keeps.
// @status ACTIVE

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importMutated } from "./lib/import-mutated.mjs";
import * as steps from "./lib/device-loss-steps.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const STEPS_FILE = path.join(here, "lib/device-loss-steps.mjs");

/** The W2 forced-loss page's shape: 92 console errors, one the device-lost sentinel. */
function forcedLossLines() {
  const lines = [
    { type: "error", text: "[WebGPU] Device lost (reason: destroyed): forced" },
  ];
  for (let i = 1; i <= 91; i++) {
    lines.push({ type: "error", text: `Failed to load resource ${i}` });
  }
  for (let i = 1; i <= 9; i++) {
    lines.push({ type: "pageerror", text: `Uncaught ${i}` });
  }
  lines.push({ type: "warning", text: "not an error" });
  return lines;
}

function assertCounts(mod) {
  const result = mod.classifyConsoleErrors(forcedLossLines());
  assert.equal(result.errors, 92);
  assert.equal(result.sentinel, 1);
  assert.equal(
    result.otherCount,
    91,
    "the non-sentinel count is not the sample",
  );
  assert.equal(result.other.length, 5);
  assert.equal(result.other[0], "Failed to load resource 1");
  assert.equal(result.pageErrorCount, 9);
  assert.equal(result.pageErrors.length, 5);
}

test("92 errors with one sentinel read otherCount 91 beside a five-line sample, and page errors count in full", () => {
  assertCounts(steps);
});

test("otherCount equals errors - sentinel for any mix, and is 0 without lines", () => {
  for (const lines of [[], null, undefined]) {
    const empty = steps.classifyConsoleErrors(lines);
    assert.equal(empty.otherCount, 0);
    assert.equal(empty.pageErrorCount, 0);
  }
  const mixed = steps.classifyConsoleErrors(forcedLossLines().slice(0, 4));
  assert.equal(mixed.otherCount, mixed.errors - mixed.sentinel);
});

test("inertness mutants: counting only what the sample keeps, for the errors or the page errors, turns the count checks red", async () => {
  assertCounts(steps);
  for (const mutation of [
    [
      "      otherCount++;\n      if (other.length < 5) {",
      "      if (other.length < 5) {\n        otherCount++;",
    ],
    [
      "      pageErrorCount++;\n      if (pageErrors.length < 5) {",
      "      if (pageErrors.length < 5) {\n        pageErrorCount++;",
    ],
  ]) {
    const mutated = await importMutated(STEPS_FILE, [mutation]);
    assert.throws(
      () => assertCounts(mutated),
      (error) => error instanceof assert.AssertionError,
    );
  }
});
