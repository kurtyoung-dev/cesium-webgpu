// landing-rules.spec.mjs — contract for the landing-discipline predicates.
// @purpose Hermetic contract for the landing predicates: control+mutant per rule, DST-straddling quiet-hours pairs, narrow merge exemptions.
// @status ACTIVE
//
// Run: node --test Tools/landing-rules.spec.mjs
//
// THREE THINGS THIS PINS:
//
//   1. EVERY RULE CAN STILL FAIL. A predicate that has stopped discriminating
//      reports a compliant push, and a compliant push is what the pre-push
//      hook exists to establish. Each rule below is driven with a CONTROL that
//      must pass and a MUTANT that differs in exactly the property the rule
//      measures and must fail. A rule with no failing case certifies nothing.
//   2. THE QUIET-HOURS WINDOW IS COMPUTED, NOT ASSUMED. The offset is never
//      hardcoded, so the boundary cases are pinned as fixed UTC instants and
//      the assertions state both the projected Eastern wall clock and the
//      offset that was in force. Two pairs straddle a DST transition with the
//      SAME UTC time of day and OPPOSITE verdicts — that pair cannot pass if
//      anyone reintroduces a constant offset.
//   3. THE EXEMPTIONS ARE NARROW. Merge commits skip (a)-(c) and nothing else;
//      commits by other authors are out of scope entirely. Both are checked
//      against the same commit with the exemption removed.
//
// Hermetic: no git, no filesystem, no ambient clock. Every input is a literal.

import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_AUTHOR_NAME,
  QUIET_HOURS_END_HOUR,
  QUIET_HOURS_START_HOUR,
  checkBatchMonotonic,
  checkBatchPrefix,
  checkBody,
  checkCoAuthorTrailer,
  checkCommitQuietHours,
  checkQuietHours,
  easternWallClock,
  evaluateCommits,
  formatPushReport,
  highestBatchIn,
  isAgentAuthored,
  isExempt,
  isQuietHours,
  parseCommitRecords,
  splitTrailers,
} from "./landing-rules.mjs";

const TRAILER = "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>";

/**
 * A compliant commit record; override one field to build each mutant.
 *
 * @param {object} [overrides] Fields to replace.
 * @returns {object} Commit record.
 */
function commit(overrides = {}) {
  return {
    sha: "a".repeat(40),
    parents: ["b".repeat(40)],
    authorName: AGENT_AUTHOR_NAME,
    authorEmail: `${AGENT_AUTHOR_NAME}@users.noreply.github.com`,
    // Friday 23:15 Eastern — deliberately outside the window so the fixture
    // does not smuggle a quiet-hours failure into unrelated assertions.
    authorDate: "2026-08-14T23:15:30-04:00",
    commitDate: "2026-08-14T23:15:30-04:00",
    subject: "Batch 1044: the hardening landed",
    body: `What landed and what it discharges.\n\n${TRAILER}\n`,
    ...overrides,
  };
}

/**
 * All failing rule ids for one commit.
 *
 * @param {object} record Commit record.
 * @param {object} [options] Options forwarded to evaluateCommits.
 * @returns {string[]} Rule ids whose status is "fail".
 */
function failuresFor(record, options = {}) {
  const evaluation = evaluateCommits([record], options);
  return evaluation.commits[0].verdicts
    .filter((entry) => entry.status === "fail")
    .map((entry) => entry.rule);
}

// ---------------------------------------------------------------------------
// Rule (a) — batch prefix
// ---------------------------------------------------------------------------

test("(a) control: a well-formed batch subject passes", () => {
  assert.equal(checkBatchPrefix(commit()).status, "pass");
  assert.equal(checkBatchPrefix(commit()).batch, 1044);
});

test("(a) mutant: the real S10 subject shape (no prefix) fails", () => {
  // Verbatim from the audited range; this is the shape the rule exists for.
  const verdict = checkBatchPrefix(
    commit({ subject: "Harden custom ellipsoid certification" }),
  );
  assert.equal(verdict.status, "fail");
  assert.equal(verdict.batch, null);
});

test("(a) mutant: lowercase keyword fails", () => {
  assert.equal(
    checkBatchPrefix(commit({ subject: "batch 1044: the thing" })).status,
    "fail",
  );
});

test("(a) mutant: non-numeric batch fails", () => {
  assert.equal(
    checkBatchPrefix(commit({ subject: "Batch ten: the thing" })).status,
    "fail",
  );
});

test("(a) mutant: missing colon fails", () => {
  assert.equal(
    checkBatchPrefix(commit({ subject: "Batch 1044 the thing" })).status,
    "fail",
  );
});

test("(a) mutant: missing space after the colon fails", () => {
  assert.equal(
    checkBatchPrefix(commit({ subject: "Batch 1044:the thing" })).status,
    "fail",
  );
});

test("(a) mutant: a numbered subject that names no work fails", () => {
  assert.equal(
    checkBatchPrefix(commit({ subject: "Batch 1044: " })).status,
    "fail",
  );
  assert.equal(
    checkBatchPrefix(commit({ subject: "Batch 1044:" })).status,
    "fail",
  );
});

test("(a) mutant: the prefix must start the subject, not appear in it", () => {
  assert.equal(
    checkBatchPrefix(commit({ subject: "fixup! Batch 1044: the thing" }))
      .status,
    "fail",
  );
  assert.equal(
    checkBatchPrefix(commit({ subject: " Batch 1044: the thing" })).status,
    "fail",
  );
});

// ---------------------------------------------------------------------------
// Rule (a) — monotonicity
// ---------------------------------------------------------------------------

test("(a) control: a number above the landed baseline passes", () => {
  assert.equal(checkBatchMonotonic(1044, 1043).status, "pass");
});

test("(a) mutant: reusing the landed number fails", () => {
  assert.equal(checkBatchMonotonic(1043, 1043).status, "fail");
});

test("(a) mutant: going backwards fails", () => {
  const verdict = checkBatchMonotonic(1042, 1043);
  assert.equal(verdict.status, "fail");
  assert.match(verdict.detail, /never reused/);
});

test("(a) with no landed baseline the number is accepted, not invented", () => {
  assert.equal(checkBatchMonotonic(1044, null).status, "pass");
});

test("(a) an unparsed subject skips monotonicity (batch-prefix owns that red)", () => {
  assert.equal(checkBatchMonotonic(null, 1043).status, "skip");
});

test("(a) control: an ascending pushed sequence has no monotonicity failure", () => {
  const evaluation = evaluateCommits(
    [1044, 1045, 1046].map((n) =>
      commit({ sha: `${n}`.padEnd(40, "0"), subject: `Batch ${n}: work` }),
    ),
    { highestPushedBatch: 1043 },
  );
  assert.equal(evaluation.violations, 0);
  assert.equal(evaluation.checked, 3);
});

test("(a) mutant: a repeat inside one push fails, and only the repeat", () => {
  const evaluation = evaluateCommits(
    [1044, 1044].map((n, index) =>
      commit({ sha: `${index}`.padEnd(40, "0"), subject: `Batch ${n}: work` }),
    ),
    { highestPushedBatch: 1043 },
  );
  assert.equal(evaluation.violations, 1);
  assert.deepEqual(
    evaluation.commits[1].verdicts
      .filter((entry) => entry.status === "fail")
      .map((entry) => entry.rule),
    ["batch-monotonic"],
  );
});

test("(a) mutant: a descending pair inside one push fails", () => {
  const evaluation = evaluateCommits(
    [1046, 1045].map((n, index) =>
      commit({ sha: `${index}`.padEnd(40, "0"), subject: `Batch ${n}: work` }),
    ),
    { highestPushedBatch: 1043 },
  );
  assert.equal(evaluation.violations, 1);
});

test("(a) a rejected number does not advance the baseline", () => {
  // Otherwise one bad commit would poison every later comparison in the push.
  const evaluation = evaluateCommits(
    [1040, 1045].map((n, index) =>
      commit({ sha: `${index}`.padEnd(40, "0"), subject: `Batch ${n}: work` }),
    ),
    { highestPushedBatch: 1043 },
  );
  assert.equal(evaluation.violations, 1);
  assert.equal(evaluation.commits[1].verdicts[1].status, "pass");
});

// ---------------------------------------------------------------------------
// Rule (b) — body
// ---------------------------------------------------------------------------

test("(b) control: a narrative body passes", () => {
  assert.equal(checkBody(commit()).status, "pass");
});

test("(b) mutant: an empty body fails", () => {
  assert.equal(checkBody(commit({ body: "" })).status, "fail");
});

test("(b) mutant: a whitespace-only body fails", () => {
  assert.equal(checkBody(commit({ body: "\n\n   \n" })).status, "fail");
});

test("(b) mutant: a body that is only the trailer fails", () => {
  // The audited range's shape once the trailer is added but nothing is said.
  assert.equal(checkBody(commit({ body: `${TRAILER}\n` })).status, "fail");
});

test("(b) control for that mutant: one narrative line flips it to pass", () => {
  assert.equal(
    checkBody(commit({ body: `It landed.\n\n${TRAILER}\n` })).status,
    "pass",
  );
});

test("(b) trailer detection does not eat narrative that merely has a colon", () => {
  const verdict = checkBody(
    commit({ body: `Root cause: the cache was frozen.\n\n${TRAILER}\n` }),
  );
  assert.equal(verdict.status, "pass");
});

test("(b) splitTrailers separates the trailing block from the narrative", () => {
  const split = splitTrailers(
    `Line one.\nLine two.\n\nSigned-off-by: A <a@b.c>\n${TRAILER}\n`,
  );
  assert.equal(split.narrative, "Line one.\nLine two.");
  assert.equal(split.trailers.length, 2);
});

// ---------------------------------------------------------------------------
// Rule (c) — co-author trailer
// ---------------------------------------------------------------------------

test("(c) control: the standard trailer passes", () => {
  const verdict = checkCoAuthorTrailer(commit());
  assert.equal(verdict.status, "pass");
  assert.match(verdict.detail, /noreply@anthropic\.com/);
});

test("(c) the key is case-insensitive", () => {
  assert.equal(
    checkCoAuthorTrailer(
      commit({ body: `Body.\n\nco-authored-by: X <x@y.z>\n` }),
    ).status,
    "pass",
  );
});

test("(c) mutant: no trailer at all fails", () => {
  assert.equal(
    checkCoAuthorTrailer(commit({ body: "Body.\n" })).status,
    "fail",
  );
});

test("(c) mutant: a bare key attributing nobody fails", () => {
  assert.equal(
    checkCoAuthorTrailer(commit({ body: "Body.\n\nCo-Authored-By:\n" })).status,
    "fail",
  );
});

test("(c) mutant: a name with no address fails", () => {
  assert.equal(
    checkCoAuthorTrailer(
      commit({ body: "Body.\n\nCo-Authored-By: Claude Fable 5\n" }),
    ).status,
    "fail",
  );
});

test("(c) mutant: a lookalike key fails", () => {
  assert.equal(
    checkCoAuthorTrailer(commit({ body: "Body.\n\nCoAuthoredBy: X <x@y.z>\n" }))
      .status,
    "fail",
  );
});

// ---------------------------------------------------------------------------
// Rule (d) — the quiet-hours window
// ---------------------------------------------------------------------------

/**
 * Assert the Eastern projection of an instant, then its window verdict.
 *
 * @param {string} iso UTC instant.
 * @param {{weekday: string, hour: number, minute: number, offset: string}} expected Projection.
 * @param {boolean} inside Expected window verdict.
 */
function assertWindow(iso, expected, inside) {
  const clock = easternWallClock(new Date(iso));
  assert.equal(clock.weekday, expected.weekday, `${iso} weekday`);
  assert.equal(clock.hour, expected.hour, `${iso} hour`);
  assert.equal(clock.minute, expected.minute, `${iso} minute`);
  assert.equal(clock.utcOffset, expected.offset, `${iso} offset`);
  assert.equal(isQuietHours(new Date(iso)), inside, `${iso} window`);
}

test("(d) the window constants are the ratified ones", () => {
  assert.equal(QUIET_HOURS_START_HOUR, 7);
  assert.equal(QUIET_HOURS_END_HOUR, 19);
});

test("(d) Wednesday boundary set, EDT: 06:59 clear, 07:00 blocked", () => {
  // 2026-08-12 is a Wednesday; EDT is UTC-4.
  assertWindow(
    "2026-08-12T10:59:00Z",
    { weekday: "Wed", hour: 6, minute: 59, offset: "-04:00" },
    false,
  );
  assertWindow(
    "2026-08-12T11:00:00Z",
    { weekday: "Wed", hour: 7, minute: 0, offset: "-04:00" },
    true,
  );
});

test("(d) Wednesday boundary set, EDT: 18:59 blocked, 19:00 clear", () => {
  assertWindow(
    "2026-08-12T22:59:00Z",
    { weekday: "Wed", hour: 18, minute: 59, offset: "-04:00" },
    true,
  );
  assertWindow(
    "2026-08-12T23:00:00Z",
    { weekday: "Wed", hour: 19, minute: 0, offset: "-04:00" },
    false,
  );
});

test("(d) the same four boundaries hold in EST", () => {
  // 2026-01-14 is a Wednesday; EST is UTC-5, so every UTC instant shifts by
  // an hour and the verdicts must not.
  assertWindow(
    "2026-01-14T11:59:00Z",
    { weekday: "Wed", hour: 6, minute: 59, offset: "-05:00" },
    false,
  );
  assertWindow(
    "2026-01-14T12:00:00Z",
    { weekday: "Wed", hour: 7, minute: 0, offset: "-05:00" },
    true,
  );
  assertWindow(
    "2026-01-14T23:59:00Z",
    { weekday: "Wed", hour: 18, minute: 59, offset: "-05:00" },
    true,
  );
  assertWindow(
    "2026-01-15T00:00:00Z",
    { weekday: "Wed", hour: 19, minute: 0, offset: "-05:00" },
    false,
  );
});

test("(d) DST spring transition: identical UTC time of day, opposite verdicts", () => {
  // US DST 2026 begins Sunday 2026-03-08. Both instants are 11:30 UTC on a
  // weekday, three days apart. A hardcoded offset cannot produce both answers.
  assertWindow(
    "2026-03-06T11:30:00Z",
    { weekday: "Fri", hour: 6, minute: 30, offset: "-05:00" },
    false,
  );
  assertWindow(
    "2026-03-09T11:30:00Z",
    { weekday: "Mon", hour: 7, minute: 30, offset: "-04:00" },
    true,
  );
});

test("(d) DST autumn transition: identical UTC time of day, opposite verdicts", () => {
  // US DST 2026 ends Sunday 2026-11-01. Both instants are 23:30 UTC.
  assertWindow(
    "2026-10-30T23:30:00Z",
    { weekday: "Fri", hour: 19, minute: 30, offset: "-04:00" },
    false,
  );
  assertWindow(
    "2026-11-02T23:30:00Z",
    { weekday: "Mon", hour: 18, minute: 30, offset: "-05:00" },
    true,
  );
});

test("(d) weekends are unrestricted at the same wall-clock time", () => {
  assertWindow(
    "2026-08-15T16:00:00Z",
    { weekday: "Sat", hour: 12, minute: 0, offset: "-04:00" },
    false,
  );
  assertWindow(
    "2026-08-16T16:00:00Z",
    { weekday: "Sun", hour: 12, minute: 0, offset: "-04:00" },
    false,
  );
  // Control: the same wall-clock hour on the adjacent Friday IS blocked.
  assertWindow(
    "2026-08-14T16:00:00Z",
    { weekday: "Fri", hour: 12, minute: 0, offset: "-04:00" },
    true,
  );
});

test("(d) checkQuietHours names the window in its refusal", () => {
  const blocked = checkQuietHours(new Date("2026-08-12T15:00:00Z"));
  assert.equal(blocked.status, "fail");
  assert.match(blocked.detail, /07:00-19:00 US Eastern/);
  assert.match(blocked.detail, /America\/New_York/);
  const clear = checkQuietHours(new Date("2026-08-12T23:30:00Z"));
  assert.equal(clear.status, "pass");
});

test("(d) commit timestamps are checked against the same window", () => {
  // Verbatim shape from the audited range: Friday 13:56 Eastern.
  const verdict = checkCommitQuietHours(
    commit({
      authorDate: "2026-08-14T13:56:55-04:00",
      commitDate: "2026-08-14T13:56:55-04:00",
    }),
  );
  assert.equal(verdict.status, "fail");
  assert.match(verdict.detail, /author date Fri 2026-08-14 13:56:55/);
});

test("(d) a committer date inside the window fails even when authored outside", () => {
  const verdict = checkCommitQuietHours(
    commit({
      authorDate: "2026-08-13T23:00:00-04:00",
      commitDate: "2026-08-14T10:00:00-04:00",
    }),
  );
  assert.equal(verdict.status, "fail");
  assert.match(verdict.detail, /committer date/);
});

test("(d) easternWallClock refuses a non-Date", () => {
  assert.throws(() => easternWallClock("2026-08-14"), TypeError);
  assert.throws(() => easternWallClock(new Date("nope")), TypeError);
});

// ---------------------------------------------------------------------------
// Rule (e) — exemptions
// ---------------------------------------------------------------------------

test("(e) control: a merge commit with a generated subject and no body passes", () => {
  const merge = commit({
    parents: ["b".repeat(40), "c".repeat(40)],
    subject: "Merge remote-tracking branch 'upstream/main'",
    body: "",
  });
  assert.equal(isExempt(merge), true);
  assert.deepEqual(failuresFor(merge), []);
});

test("(e) mutant: the identical commit with one parent fails all three rules", () => {
  const single = commit({
    parents: ["b".repeat(40)],
    subject: "Merge remote-tracking branch 'upstream/main'",
    body: "",
  });
  assert.equal(isExempt(single), false);
  assert.deepEqual(failuresFor(single), [
    "batch-prefix",
    "body",
    "co-author-trailer",
  ]);
});

test("(e) the merge exemption does not extend to quiet hours", () => {
  const merge = commit({
    parents: ["b".repeat(40), "c".repeat(40)],
    subject: "Merge remote-tracking branch 'upstream/main'",
    body: "",
    authorDate: "2026-08-12T15:00:00Z",
    commitDate: "2026-08-12T15:00:00Z",
  });
  assert.deepEqual(failuresFor(merge, { includeCommitQuietHours: true }), [
    "commit-quiet-hours",
  ]);
});

test("(e) commits by another author are out of scope entirely", () => {
  const upstream = commit({
    authorName: "Some Upstream Dev",
    authorEmail: "dev@cesium.com",
    subject: "Fix a thing",
    body: "",
  });
  assert.equal(isAgentAuthored(upstream), false);
  assert.deepEqual(failuresFor(upstream), []);
});

test("(e) control for that: the same commit under the agent identity fails", () => {
  const agent = commit({ subject: "Fix a thing", body: "" });
  assert.equal(isAgentAuthored(agent), true);
  assert.equal(failuresFor(agent).length, 3);
});

test("(e) the agent identity is recognized by email local-part too", () => {
  assert.equal(
    isAgentAuthored({
      authorName: "Cesium WebGPU Agent",
      authorEmail: `${AGENT_AUTHOR_NAME}@users.noreply.github.com`,
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// Record parsing and reporting
// ---------------------------------------------------------------------------

test("parseCommitRecords round-trips a multi-line body", () => {
  const raw = [
    "abc123",
    "parent1 parent2",
    AGENT_AUTHOR_NAME,
    "agent@example.com",
    "2026-08-14T23:15:30-04:00",
    "2026-08-14T23:15:30-04:00",
    "Batch 1044: work",
    `Line one.\nLine two.\n\n${TRAILER}\n`,
  ].join("\n");
  const [record] = parseCommitRecords(`${raw}\0`);
  assert.equal(record.sha, "abc123");
  assert.deepEqual(record.parents, ["parent1", "parent2"]);
  assert.equal(record.subject, "Batch 1044: work");
  assert.match(record.body, /Line one\.\nLine two\./);
  assert.match(record.body, /Co-Authored-By/);
});

test("parseCommitRecords handles an empty body and a root commit", () => {
  const raw = [
    "abc123",
    "",
    AGENT_AUTHOR_NAME,
    "agent@example.com",
    "2026-08-14T23:15:30-04:00",
    "2026-08-14T23:15:30-04:00",
    "Batch 1: work",
    "",
  ].join("\n");
  const [record] = parseCommitRecords(`${raw}\0`);
  assert.deepEqual(record.parents, []);
  assert.equal(record.body.trim(), "");
});

test("parseCommitRecords throws on a truncated record rather than guessing", () => {
  assert.throws(() => parseCommitRecords("abc123\nparent\n\0"), /malformed/);
});

test("highestBatchIn takes the maximum and ignores unprefixed subjects", () => {
  assert.equal(
    highestBatchIn([
      "Batch 1040: a",
      "Harden custom ellipsoid certification",
      "Batch 1043: c",
      "Batch 1041: b",
    ]),
    1043,
  );
  assert.equal(highestBatchIn(["no batches here"]), null);
  assert.equal(highestBatchIn([]), null);
});

test("the report prints only failures by default and everything under explain", () => {
  const evaluation = evaluateCommits(
    [commit({ subject: "Harden a thing", body: "" })],
    { highestPushedBatch: 1043 },
  );
  const result = {
    quietHours: checkQuietHours(new Date("2026-08-12T23:30:00Z")),
    refs: [{ name: "refs/heads/main", highestPushedBatch: 1043, evaluation }],
  };
  const terse = formatPushReport(result);
  assert.match(terse, /batch-prefix/);
  assert.doesNotMatch(terse, /quiet-hours/);
  const explained = formatPushReport(result, { explain: true });
  assert.match(explained, /quiet-hours/);
  assert.match(explained, /batch-monotonic/);
  assert.match(explained, /highest landed batch = 1043/);
});

test("the rule-id set is stable", () => {
  // Renaming a rule silently would break every downstream grep and every
  // record of which rule caught what.
  const evaluation = evaluateCommits([commit()], {
    highestPushedBatch: 1043,
    includeCommitQuietHours: true,
  });
  assert.deepEqual(
    evaluation.commits[0].verdicts.map((entry) => entry.rule),
    [
      "batch-prefix",
      "batch-monotonic",
      "body",
      "co-author-trailer",
      "commit-quiet-hours",
    ],
  );
  assert.equal(evaluation.ok, true);
});
