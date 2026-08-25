#!/usr/bin/env node
// pre-push-guard.mjs — the git-aware driver behind .husky/pre-push.
// @purpose Git-aware driver behind .husky/pre-push: enforces batch-prefix/body/trailer/quiet-hours on every outgoing agent commit; fail-closed, no bypass flag.
// @status ACTIVE
//
// Ruling: migration_doc/MAINTAINER_RULINGS_2026-08-14.md R-2026-08-14-4
// Rules:  Tools/landing-rules.mjs (pure predicates, specs in landing-rules.spec.mjs)
// Detector: Tools/verify-landing-compliance.mjs (`npm run verify-landing`)
//
// WHAT IT ENFORCES, per push, over every commit that is being sent to the
// remote and is authored by `cesium-webgpu-agent`:
//
//   (a) `Batch NNNN: ` subject prefix, monotonic against the highest batch
//       already reachable from the remote ref;
//   (b) a non-empty body (trailers alone are not a body);
//   (c) a `Co-Authored-By:` trailer;
//   (d) the push itself is not happening on a weekday between 07:00 and 19:00
//       US Eastern — offset resolved from the tz database, never hardcoded;
//   (e) merge commits (two or more parents — an upstream sync is one) skip
//       (a)-(c). Rule (d) still applies to them: a merge is as visible as
//       anything else.
//
// NO BYPASS FLAG EXISTS. There is deliberately no environment variable and no
// argument that turns this off. git's own `--no-verify` still works, which is
// the point: `npm run verify-landing` re-checks the same rules over a landed
// range, so using it leaves evidence instead of leaving nothing.
//
// HOOK_EXPLAIN=1 prints a rule-by-rule verdict for every commit, including the
// ones that were skipped and why.
//
// EXIT CODES
//   0  every rule passes (or there is nothing to check)
//   1  at least one rule failed — the push is refused
//   2  the guard itself failed (git unavailable, unreadable refs). Fail-closed:
//      a guard that cannot see the commits must not report a pass.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

import {
  checkQuietHours,
  evaluateCommits,
  formatPushReport,
  highestBatchIn,
  parseCommitRecords,
} from "./landing-rules.mjs";

/**
 * How far back to look for the highest already-landed batch number.
 *
 * The fork carries ~47k commits, nearly all of them upstream history with no
 * batch prefix, so scanning all of them to find a number that is always within
 * the last few hundred commits costs seconds for nothing. The cap is two
 * orders of magnitude above the observed batch cadence.
 */
const REMOTE_LOG_SCAN_CAP = 5000;

const LOG_FORMAT = "%H%n%P%n%an%n%ae%n%aI%n%cI%n%s%n%b";
const ZERO_SHA = /^0+$/;

/**
 * Run git and return stdout.
 *
 * @param {string[]} args Arguments.
 * @returns {string} stdout.
 */
function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Read the ref lines git feeds a pre-push hook on stdin.
 *
 * Each line is `<local ref> <local sha> <remote ref> <remote sha>`. When the
 * hook is run by hand there is no stdin, and "nothing to check" is the honest
 * answer — git only ever invokes this hook from `git push`, never from fetch,
 * pull, or clone, so an empty read means a manual invocation.
 *
 * @returns {{localRef: string, localSha: string, remoteRef: string, remoteSha: string}[]} Push requests.
 */
function readPushRequests() {
  if (process.stdin.isTTY === true) {
    return [];
  }
  let raw;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (error) {
    if (error.code === "EAGAIN" || error.code === "EOF") {
      return [];
    }
    throw error;
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

/**
 * Commits that this ref update would add to the remote, oldest first.
 *
 * @param {{localSha: string, remoteSha: string}} request Push request.
 * @param {string} remoteName Remote being pushed to.
 * @returns {object[]} Commit records.
 */
function collectCommits(request, remoteName) {
  const args = ["log", "-z", "--reverse", `--format=${LOG_FORMAT}`];
  if (ZERO_SHA.test(request.remoteSha)) {
    // New remote branch: everything not already on some ref of this remote.
    args.push(request.localSha, "--not", `--remotes=${remoteName}`);
  } else {
    args.push(`${request.remoteSha}..${request.localSha}`);
  }
  return parseCommitRecords(git(args));
}

/**
 * Highest batch number already landed on the remote.
 *
 * @param {{remoteSha: string}} request Push request.
 * @param {string} remoteName Remote being pushed to.
 * @returns {number|null} Highest landed batch, or null when none is visible.
 */
function highestLandedBatch(request, remoteName) {
  const args = [
    "log",
    "--format=%s",
    `--max-count=${REMOTE_LOG_SCAN_CAP}`,
    "--no-merges",
  ];
  if (ZERO_SHA.test(request.remoteSha)) {
    args.push(`--remotes=${remoteName}`);
  } else {
    args.push(request.remoteSha);
  }
  let raw;
  try {
    raw = git(args);
  } catch {
    // No remote-tracking refs at all (a fresh clone target). The monotonicity
    // rule reports "no pushed baseline" rather than inventing one.
    return null;
  }
  return highestBatchIn(raw.split("\n"));
}

/**
 * Entry point.
 *
 * @returns {number} Process exit code.
 */
function main() {
  const explain = process.env.HOOK_EXPLAIN === "1";
  const remoteName = process.argv[2] ?? "origin";
  const requests = readPushRequests();
  const pushable = requests.filter(
    (request) => !ZERO_SHA.test(request.localSha ?? "0"),
  );
  if (pushable.length === 0) {
    if (explain) {
      process.stderr.write(
        "landing-guard: no ref updates to check (branch deletion or manual invocation)\n",
      );
    }
    return 0;
  }

  const quietHours = checkQuietHours(new Date());
  const refs = pushable.map((request) => {
    const commits = collectCommits(request, remoteName);
    const highestPushedBatch = highestLandedBatch(request, remoteName);
    return {
      name: request.remoteRef ?? request.localRef ?? "(ref)",
      highestPushedBatch,
      // includeCommitQuietHours is what makes checkCommitQuietHours run at all
      // (landing-rules.mjs:428/:460/:476). Without it the only quiet-hours test
      // was checkQuietHours(new Date()) above — the PUSH instant — so a commit
      // stamped 11:00 Monday pushed cleanly at 20:00. The rule exists precisely
      // because commits carry visible timestamps whenever they are pushed, and
      // 24 such commits are already permanent ancestors of main. Ordered by
      // R-2026-08-17-1. Until this landed the charter's own audit row
      // (EXECUTOR_LANE_CHARTER_2026-08-14.md:375) recorded the in-range
      // commit-timestamp check as "not yet landed", with only the after-the-fact
      // `npm run verify-landing` detector covering it.
      evaluation: evaluateCommits(commits, {
        highestPushedBatch,
        includeCommitQuietHours: true,
      }),
    };
  });

  const result = { quietHours, refs };
  const commitViolations = refs.reduce(
    (total, ref) => total + ref.evaluation.violations,
    0,
  );
  const totalChecked = refs.reduce(
    (total, ref) => total + ref.evaluation.checked,
    0,
  );
  const ok = commitViolations === 0 && quietHours.status === "pass";

  const report = formatPushReport(result, { explain });
  const header = ok
    ? `landing-guard: ${totalChecked} governed commit(s) pass (R-2026-08-14-4)`
    : `landing-guard: PUSH REFUSED — ${commitViolations} rule violation(s)${quietHours.status === "fail" ? " + quiet hours" : ""} (R-2026-08-14-4)`;
  process.stderr.write(`${header}\n`);
  if (report !== "") {
    process.stderr.write(`${report}\n`);
  }
  if (!ok) {
    process.stderr.write(
      [
        "",
        "  Rules: migration_doc/EXECUTOR_LANE_CHARTER_2026-08-14.md §2.1/§2.2",
        "  Fix the commits (reword/amend before they are pushed) or wait out the window.",
        "  A hook that blocks incorrectly is a RULING REQUEST, not a --no-verify bypass;",
        "  `npm run verify-landing` re-checks these rules after the fact, so a bypass shows.",
        "",
      ].join("\n"),
    );
  }
  return ok ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(
    `landing-guard: FAILED TO RUN — ${error?.message ?? error}\n` +
      "  The guard could not inspect the commits, so the push is refused (fail-closed).\n",
  );
  process.exitCode = 2;
}
