// mutate-or-fail.spec.mjs — fast contract for the shared mutation-test guard.
//
// @purpose Pins mutateOrFail's contract — a changed rewrite returns the
//   rewritten text, an identity rewrite throws instead of passing
//   vacuously, and the rewrite never reaches the file its caller's text
//   came from — in a runner family that finishes in seconds.
// @status ACTIVE
//
// `mutateOrFail` (Tools/visual-regression/lib/engine-stub-bundler.mjs) used
// to have exactly one behavioural proof, embedded inside
// `webgpu-pick-emission-counters.spec.mjs` — a file whose OTHER tests bundle
// a real WebGPU renderer module through esbuild and are homed in the
// multi-minute test-readiness family. Loading that file at all paid for the
// bundle even when the only thing under test was the small, synchronous
// helper. This file imports nothing but the helper itself, so proving its
// contract costs milliseconds instead of minutes.
//
// The restore-semantics test writes a real fixture file under the OS temp
// directory (never this repo) to demonstrate the property every `bundle`
// caller relies on: `mutateOrFail` hands back a rewritten STRING and never
// writes anything back to the path its caller originally read — so the same
// on-disk file comes back clean for the very next mutation the caller runs
// against it.
//
// Run: node --test Tools/visual-regression/mutate-or-fail.spec.mjs

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mutateOrFail } from "./lib/engine-stub-bundler.mjs";

test("a rewrite that changes the source returns the rewritten text", () => {
  assert.equal(
    mutateOrFail("before", () => "after", "changed"),
    "after",
  );
});

test("a rewrite that changes nothing throws instead of passing vacuously", () => {
  assert.throws(() => mutateOrFail("before", (source) => source, "identity"), {
    name: "AssertionError",
    message:
      "the identity mutation changed nothing — its anchor text has moved, so " +
      "this mutation test would pass vacuously and the result it exists to " +
      "falsify would be unfalsifiable",
  });
});

test("restore semantics: the file a caller read the original text from is never written to", async () => {
  const scratchDir = await mkdtemp(path.join(tmpdir(), "mutate-or-fail-"));
  const fixturePath = path.join(scratchDir, "fixture.txt");
  const original = "const anchor = 1;\n";
  await writeFile(fixturePath, original, "utf8");
  try {
    const sourceFromDisk = await readFile(fixturePath, "utf8");
    const mutated = mutateOrFail(
      sourceFromDisk,
      (source) => source.replace("const anchor = 1;", "const anchor = 2;"),
      "anchor bump",
    );
    assert.notEqual(mutated, sourceFromDisk);
    assert.match(mutated, /const anchor = 2;/u);
    const afterCall = await readFile(fixturePath, "utf8");
    assert.equal(
      afterCall,
      original,
      "mutateOrFail must never write its rewrite back to the file its caller read the original text from",
    );
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
});
