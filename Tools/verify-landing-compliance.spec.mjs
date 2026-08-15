// verify-landing-compliance.spec.mjs — contract for the bypass detector.
//
// Run: node --test Tools/verify-landing-compliance.spec.mjs
//
// The detector's whole value is that it produces a RED where the pre-commit
// and pre-push hooks produced silence. So it is driven against two ranges of
// this repository's own immutable history:
//
//   KNOWN-BAD  the C12-37 landing that finding S9 reconstructed by hand. It
//              must report the eight clean-listed marker errors and the
//              missing prefixes/bodies/trailers.
//   KNOWN-GOOD the Batch 1041-1043 landing, which complies. It must report
//              nothing.
//
// One without the other proves nothing: a detector that always fails and a
// detector that never fails are equally useless, and the pair separates them.
//
// The commits are landed, pushed and immutable — ruling R-2026-08-14-4 closed
// OPS-01b as REJECTED, so no history rewrite can move them. If they are
// nevertheless unreachable (a shallow clone), the tests skip STRUCTURAL rather
// than reporting a pass.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./verify-landing-compliance.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const VERIFIER = fileURLToPath(
  new URL("./verify-landing-compliance.mjs", import.meta.url),
);
const TIMEOUT_MS = 120_000;

/** The C12-37 landing finding S9 named: 8 clean-listed marker errors. */
const KNOWN_BAD_RANGE = "6d4a2376fc~1..4d43ee6015";

/** Batches 1041-1043: prefixed, bodied, trailered, marker-clean. */
const KNOWN_GOOD_RANGE = "4c9b559411~3..4c9b559411";

/**
 * Whether every revision in a range is present in this clone.
 *
 * @param {string} range Two-dot range.
 * @returns {boolean} True when both endpoints resolve.
 */
function rangeAvailable(range) {
  return range.split("..").every((rev) => {
    const result = spawnSync(
      "git",
      ["rev-parse", "--verify", `${rev}^{commit}`],
      {
        cwd: ROOT,
        stdio: "ignore",
        timeout: TIMEOUT_MS,
      },
    );
    return result.status === 0;
  });
}

/**
 * Run the verifier.
 *
 * @param {string[]} args Arguments.
 * @returns {{status: number, output: string}} Result.
 */
function verify(args) {
  const result = spawnSync(process.execPath, [VERIFIER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined && result.error !== null) {
    throw result.error;
  }
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

test("parseArgs accepts the documented forms", () => {
  assert.deepEqual(parseArgs(["--range", "a..b"]).range, "a..b");
  assert.deepEqual(parseArgs(["--range=a..b"]).range, "a..b");
  assert.equal(parseArgs(["--last", "30"]).last, 30);
  assert.equal(parseArgs(["--last=30"]).last, 30);
  assert.equal(parseArgs(["--json"]).json, true);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs([]).range, null);
});

test("parseArgs rejects malformed input rather than guessing a range", () => {
  assert.throws(() => parseArgs(["--range", "HEAD"]), /two-dot/);
  assert.throws(() => parseArgs(["--last", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--last", "x"]), /positive integer/);
  assert.throws(() => parseArgs(["--wat"]), /unknown argument/);
});

test("an empty range is STRUCTURAL, not a pass", () => {
  const result = verify(["--range", "HEAD..HEAD"]);
  assert.equal(result.status, 3);
  assert.match(result.output, /STRUCTURAL/);
  assert.match(result.output, /nothing was verified/);
});

test(
  "KNOWN-BAD: the S9 range reports its marker errors and commit violations",
  { skip: rangeAvailable(KNOWN_BAD_RANGE) ? false : "range not in this clone" },
  () => {
    const result = verify(["--range", KNOWN_BAD_RANGE]);
    assert.equal(result.status, 1);
    // The three files the audit named, and the count it measured.
    assert.match(result.output, /8 marker-guard error\(s\)/);
    assert.match(result.output, /Scene\/Moon\.js:\d+ \[campaign-row-id\]/);
    assert.match(
      result.output,
      /Environment\/Moon\.wgsl:\d+ \[campaign-row-id\]/,
    );
    assert.match(
      result.output,
      /WebGPUEnvironmentRenderer\.js:\d+ \[campaign-row-id\]/,
    );
    // And the landing-discipline half of the same range.
    assert.match(result.output, /FAIL batch-prefix/);
    assert.match(result.output, /FAIL co-author-trailer/);
    assert.match(result.output, /history is not rewritten/);
  },
);

test(
  "KNOWN-GOOD: the compliant range reports nothing",
  {
    skip: rangeAvailable(KNOWN_GOOD_RANGE) ? false : "range not in this clone",
  },
  () => {
    const result = verify(["--range", KNOWN_GOOD_RANGE]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /verify-landing: PASS/);
    // It must have actually looked at something — a scan of zero files that
    // reports PASS is the failure mode the STRUCTURAL exit exists for.
    assert.match(result.output, /3 commit\(s\), 3 governed/);
    assert.match(result.output, /marker guard: [1-9]\d* in-scope file\(s\)/);
  },
);

test(
  "the JSON report carries the same verdict as the text report",
  { skip: rangeAvailable(KNOWN_BAD_RANGE) ? false : "range not in this clone" },
  () => {
    const result = verify(["--range", KNOWN_BAD_RANGE, "--json"]);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.output);
    assert.equal(report.ok, false);
    assert.equal(report.markerGuard.errors.length, 8);
    assert.equal(report.commits.length, 4);
    assert.ok(report.violations >= 12);
  },
);
