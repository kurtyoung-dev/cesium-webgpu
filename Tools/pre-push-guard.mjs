#!/usr/bin/env node
// pre-push-guard.mjs — the git-aware driver behind .husky/pre-push.
// @purpose Git-aware driver behind .husky/pre-push: enforces batch-prefix/body/trailer/quiet-hours on every outgoing agent commit, and refuses deletion or non-fast-forward rewrite of main; fail-closed, no bypass flag reachable from a real push (a 5th argv slot lets a direct invocation pin the quiet-hours clock for tests; git's two-argument hook contract keeps it unreachable from `.husky/pre-push`).
// @status ACTIVE
//
// Ruling: migration_doc/MAINTAINER_RULINGS_2026-08-14.md R-2026-08-14-4
// Rules:  Tools/landing-rules.mjs (pure predicates, specs in landing-rules.spec.mjs)
// Commit detector: Tools/verify-landing-compliance.mjs (`npm run verify-landing`)
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
// And per REF UPDATE, regardless of who authored the commits:
//
//   (f) a protected branch (main) is never deleted from the remote and never
//       force-rewritten — a non-fast-forward update is refused, failing closed
//       when the remote tip cannot be seen locally. Other refs are exempt, so
//       safety-branch housekeeping stays possible. The documented upstream
//       sync's `--force-with-lease` push of a merge commit is a fast-forward
//       and passes.
//
// NO BYPASS FLAG EXISTS. There is deliberately no environment variable and no
// argument that turns this off. git's own `--no-verify` still skips the hook.
// `npm run verify-landing` can expose skipped commit-message and timestamp
// rules over a selected range, but cannot reconstruct a bypassed ref deletion
// or rewrite. Server-side branch protection is an independent control.
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
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkQuietHours,
  checkPushedBatchUniqueness,
  checkRefUpdate,
  evaluateCommits,
  formatPushReport,
  highestBatchIn,
  isProtectedRef,
  parseCommitRecords,
} from "./landing-rules.mjs";

/**
 * A valid object ID in a SHA-1 or SHA-256 repository.
 */
const OBJECT_ID_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

const LOG_FORMAT = "%H%n%P%n%an%n%ae%n%aI%n%cI%n%s%n%b";

/**
 * Whether an already validated object ID is Git's all-zero sentinel.
 *
 * @param {string} oid Object ID.
 * @returns {boolean} True for an exact SHA-1 or SHA-256 zero ID.
 */
function isZeroOid(oid) {
  return (oid.length === 40 || oid.length === 64) && /^0+$/.test(oid);
}

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
 * Parse the ref lines git feeds a pre-push hook on stdin.
 *
 * Each line is `<local ref> <local sha> <remote ref> <remote sha>`. When the
 * hook is run by hand there is no stdin, and "nothing to check" is the honest
 * answer — git only ever invokes this hook from `git push`, never from fetch,
 * pull, or clone, so an empty read means a manual invocation.
 *
 * @param {string} raw Complete hook input.
 * @returns {{localRef: string, localSha: string, remoteRef: string, remoteSha: string}[]} Push requests.
 */
export function parsePushRequests(raw) {
  if (typeof raw !== "string") {
    throw new TypeError("landing-guard: hook input must be text.");
  }
  if (raw === "") {
    return [];
  }

  const lines = raw.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  let objectIdWidth;
  return lines.map((line, index) => {
    const lineNumber = index + 1;
    if (line === "" || line !== line.trim()) {
      throw new Error(
        `landing-guard: malformed hook input line ${lineNumber}; expected exactly four nonempty fields.`,
      );
    }
    const fields = line.split(/[ \t]+/);
    if (fields.length !== 4 || fields.some((field) => field === "")) {
      throw new Error(
        `landing-guard: malformed hook input line ${lineNumber}; expected exactly four nonempty fields, got ${fields.length}.`,
      );
    }
    const [localRef, localShaRaw, remoteRef, remoteShaRaw] = fields;
    if (!remoteRef.startsWith("refs/")) {
      throw new Error(
        `landing-guard: malformed destination ref on line ${lineNumber}: ${JSON.stringify(remoteRef)}.`,
      );
    }
    for (const [kind, oid] of [
      ["local", localShaRaw],
      ["remote", remoteShaRaw],
    ]) {
      if (!OBJECT_ID_PATTERN.test(oid)) {
        throw new Error(
          `landing-guard: malformed ${kind} object ID on line ${lineNumber}; expected 40 or 64 hexadecimal characters.`,
        );
      }
    }
    if (localShaRaw.length !== remoteShaRaw.length) {
      throw new Error(
        `landing-guard: mixed object-ID widths on line ${lineNumber}; local and remote IDs must use one repository format.`,
      );
    }
    objectIdWidth ??= localShaRaw.length;
    if (localShaRaw.length !== objectIdWidth) {
      throw new Error(
        `landing-guard: mixed object-ID widths across hook input at line ${lineNumber}.`,
      );
    }
    const localSha = localShaRaw.toLowerCase();
    const remoteSha = remoteShaRaw.toLowerCase();
    const deletion = isZeroOid(localSha);
    if (deletion !== (localRef === "(delete)")) {
      throw new Error(
        `landing-guard: deletion source mismatch on line ${lineNumber}; (delete) and the zero local object ID must appear together.`,
      );
    }
    if (deletion && isZeroOid(remoteSha)) {
      throw new Error(
        `landing-guard: line ${lineNumber} cannot delete a destination that does not exist.`,
      );
    }
    return { localRef, localSha, remoteRef, remoteSha };
  });
}

/**
 * Parse the authoritative branch tips returned by `git ls-remote`.
 *
 * The requested command emits `<object ID><TAB><refs/heads/...>`. Rejecting
 * every other shape keeps remote discovery from silently becoming a partial
 * baseline when output is truncated, decorated, or otherwise unexpected.
 *
 * @param {string} raw Complete `ls-remote --heads --refs` output.
 * @param {number} objectIdWidth Object-ID width established by hook input.
 * @returns {Map<string, string>} Destination ref to canonical object ID.
 */
export function parseAdvertisedRefs(raw, objectIdWidth) {
  if (typeof raw !== "string") {
    throw new TypeError("landing-guard: remote advertisement must be text.");
  }
  if (objectIdWidth !== 40 && objectIdWidth !== 64) {
    throw new TypeError(
      "landing-guard: remote advertisement requires a 40- or 64-character object-ID width.",
    );
  }
  if (raw === "") {
    return new Map();
  }

  const lines = raw.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const refs = new Map();
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const fields = line.split("\t");
    if (
      line === "" ||
      line.includes("\r") ||
      fields.length !== 2 ||
      fields.some((field) => field === "")
    ) {
      throw new Error(
        `landing-guard: malformed remote advertisement line ${lineNumber}; expected exactly one object ID, one tab, and one branch ref.`,
      );
    }
    const [oidRaw, ref] = fields;
    if (
      !OBJECT_ID_PATTERN.test(oidRaw) ||
      isZeroOid(oidRaw) ||
      oidRaw.length !== objectIdWidth
    ) {
      throw new Error(
        `landing-guard: malformed remote object ID on advertisement line ${lineNumber}.`,
      );
    }
    if (!/^refs\/heads\/[^\s]+$/.test(ref)) {
      throw new Error(
        `landing-guard: malformed remote branch ref on advertisement line ${lineNumber}: ${JSON.stringify(ref)}.`,
      );
    }
    if (refs.has(ref)) {
      throw new Error(
        `landing-guard: duplicate remote branch ref on advertisement line ${lineNumber}: ${ref}.`,
      );
    }
    refs.set(ref, oidRaw.toLowerCase());
  }
  return refs;
}

/**
 * Read and parse hook stdin. Read failures are not empty input: they propagate
 * to the top-level fail-closed handler.
 *
 * @param {{stdin?: {isTTY?: boolean}, readFileSync?: Function}} [options] Test seams.
 * @returns {{localRef: string, localSha: string, remoteRef: string, remoteSha: string}[]} Push requests.
 */
export function readPushRequests(options = {}) {
  const stdin = options.stdin ?? process.stdin;
  if (stdin.isTTY === true) {
    return [];
  }
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  return parsePushRequests(readFileSync(0, "utf8"));
}

/**
 * Commits that this ref update would add to the remote, oldest first.
 *
 * @param {{localSha: string, remoteSha: string}} request Push request.
 * @param {string[]} advertisedTips Authoritative remote branch tips.
 * @returns {object[]} Commit records.
 */
function collectCommits(request, advertisedTips) {
  const args = ["log", "-z", "--reverse", `--format=${LOG_FORMAT}`];
  if (isZeroOid(request.remoteSha)) {
    // New remote branch: everything not already on an advertised remote head.
    args.push(request.localSha);
    if (advertisedTips.length > 0) {
      args.push("--not", ...advertisedTips);
    }
  } else {
    args.push(`${request.remoteSha}..${request.localSha}`);
  }
  return parseCommitRecords(git(args));
}

/**
 * Fast-forward state of one ref update, for rule (f).
 *
 * @param {{localSha: string, remoteSha: string}} request Push request.
 * @returns {string} "new-ref" | "fast-forward" | "rewrite" | "unverifiable".
 */
function fastForwardState(request) {
  if (isZeroOid(request.remoteSha)) {
    return "new-ref";
  }
  try {
    git(["merge-base", "--is-ancestor", request.remoteSha, request.localSha]);
    return "fast-forward";
  } catch (error) {
    // Exit 1 is merge-base's defined "not an ancestor"; anything else means
    // the remote tip is not visible locally and the state cannot be proven.
    return error?.status === 1 ? "rewrite" : "unverifiable";
  }
}

/**
 * Require every object needed by commit and ancestry inspection to exist.
 *
 * Every negotiated destination, including a deletion's old tip, must exist.
 * If any request sends commits, every advertised branch tip must also be local
 * so the global Batch baseline and new-ref exclusion are complete. The whole
 * preflight runs before policy evaluation, so mixed pushes fail atomically.
 *
 * @param {object[]} requests Push requests.
 * @param {Map<string, string>} advertisedRefs Authoritative branch tips.
 */
function requireInspectableObjects(requests, advertisedRefs) {
  const required = new Map();
  for (const request of requests) {
    if (!isZeroOid(request.remoteSha)) {
      required.set(request.remoteSha, `destination ${request.remoteRef}`);
    }
  }
  if (requests.some((request) => !isZeroOid(request.localSha))) {
    for (const [ref, oid] of advertisedRefs) {
      if (!required.has(oid)) {
        required.set(oid, `advertised remote branch ${ref}`);
      }
    }
  }
  for (const request of requests) {
    if (!isZeroOid(request.localSha) && !required.has(request.localSha)) {
      required.set(request.localSha, `source ${request.localRef}`);
    }
  }

  for (const [oid, role] of required) {
    try {
      git(["cat-file", "-e", `${oid}^{commit}`]);
    } catch {
      throw new Error(
        `${role} object ${oid} is not an inspectable commit; fetch first or repair the local source before retrying`,
      );
    }
  }
}

/**
 * Discover the remote's current branch tips through the exact push location.
 *
 * @param {string} remoteLocation Location supplied to the pre-push hook.
 * @param {number} objectIdWidth Repository object-ID width.
 * @returns {Map<string, string>} Advertised branch tips.
 */
function discoverRemoteHeads(remoteLocation, objectIdWidth) {
  if (typeof remoteLocation !== "string" || remoteLocation === "") {
    throw new Error(
      "landing-guard: pre-push did not supply the actual remote location.",
    );
  }
  return parseAdvertisedRefs(
    git(["ls-remote", "--heads", "--refs", "--", remoteLocation]),
    objectIdWidth,
  );
}

/**
 * Refuse a negotiation snapshot that no longer matches current remote heads.
 *
 * @param {object[]} requests Push requests.
 * @param {Map<string, string>} advertisedRefs Authoritative branch tips.
 */
function requireCurrentNegotiation(requests, advertisedRefs) {
  for (const request of requests) {
    if (!request.remoteRef.startsWith("refs/heads/")) {
      continue;
    }
    const advertised = advertisedRefs.get(request.remoteRef);
    if (isZeroOid(request.remoteSha)) {
      if (advertised !== undefined) {
        throw new Error(
          `destination ${request.remoteRef} now exists at ${advertised}; retry the push against a fresh negotiation`,
        );
      }
    } else if (advertised === undefined) {
      throw new Error(
        `destination ${request.remoteRef} is no longer advertised; retry the push against a fresh negotiation`,
      );
    } else if (advertised !== request.remoteSha) {
      throw new Error(
        `destination ${request.remoteRef} changed from ${request.remoteSha} to ${advertised}; retry the push against a fresh negotiation`,
      );
    }
  }
}

/**
 * Unique remote tips used both for Batch baselining and new-ref exclusion.
 *
 * Non-branch destinations are absent from `--heads` discovery, so their
 * negotiated nonzero tips are retained explicitly.
 *
 * @param {object[]} requests Push requests.
 * @param {Map<string, string>} advertisedRefs Authoritative branch tips.
 * @returns {string[]} Unique baseline tips.
 */
function remoteBaselineTips(requests, advertisedRefs) {
  const tips = new Set(advertisedRefs.values());
  for (const request of requests) {
    if (!isZeroOid(request.remoteSha)) {
      tips.add(request.remoteSha);
    }
  }
  return [...tips];
}

/**
 * Highest Batch number visible from the authoritative remote baseline.
 *
 * @param {string[]} tips Inspectable remote tips.
 * @returns {number|null} Highest visible landed Batch number.
 */
function highestLandedBatch(tips) {
  if (tips.length === 0) {
    return null;
  }
  return highestBatchIn(
    git(["log", "--format=%s", "--no-merges", ...tips]).split("\n"),
  );
}

/**
 * Resolve the instant quiet hours is evaluated against.
 *
 * git invokes a pre-push hook with exactly two arguments — remote name,
 * remote location — a contract git itself enforces, not the hook. That fixed
 * shape means a real push's argv never reaches index 4, so this override is
 * unreachable from `.husky/pre-push`; only a caller driving the script
 * directly can supply a fifth argv entry to pin both sides of the window.
 *
 * @param {string[]} argv Process argv (or an injected test double).
 * @returns {Date} The instant to evaluate quiet hours against.
 */
function resolveNow(argv) {
  const override = argv[4];
  if (override === undefined) {
    return new Date();
  }
  const parsed = new Date(override);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `landing-guard: malformed now-override argument; expected an ISO-8601 instant, got ${JSON.stringify(override)}.`,
    );
  }
  return parsed;
}

/**
 * Entry point.
 *
 * @returns {number} Process exit code.
 */
export function main(options = {}) {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const stderr = options.stderr ?? process.stderr;
  const explain = env.HOOK_EXPLAIN === "1";
  const requests = readPushRequests(options.readOptions);
  if (requests.length === 0) {
    if (explain) {
      stderr.write(
        "landing-guard: no ref updates to check (manual invocation)\n",
      );
    }
    return 0;
  }

  const advertisedRefs = discoverRemoteHeads(
    argv[3],
    requests[0].localSha.length,
  );
  requireCurrentNegotiation(requests, advertisedRefs);
  requireInspectableObjects(requests, advertisedRefs);
  const baselineTips = remoteBaselineTips(requests, advertisedRefs);
  const quietHours = checkQuietHours(options.now ?? resolveNow(argv));
  const highestPushedBatch = highestLandedBatch(baselineTips);
  const seenCommitShas = new Set();
  const distinctCommits = [];
  const refs = requests.map((request) => {
    const name = request.remoteRef;
    const isDeletion = isZeroOid(request.localSha);
    const refVerdict = checkRefUpdate({
      remoteRef: request.remoteRef,
      isDeletion,
      // merge-base only runs where its answer is judged, so pushing a scratch
      // ref costs no extra git call.
      fastForward:
        isDeletion || !isProtectedRef(name)
          ? undefined
          : fastForwardState(request),
    });
    if (isDeletion) {
      // A deletion sends no commits, so rules (a)-(e) have nothing to look at;
      // rule (f) above is the only judgement on it.
      return {
        name,
        sourceRef: request.localRef,
        destinationRef: request.remoteRef,
        highestPushedBatch: null,
        refVerdict,
        evaluation: evaluateCommits([], { highestPushedBatch: null }),
      };
    }
    const commits = collectCommits(request, baselineTips).filter((commit) => {
      if (seenCommitShas.has(commit.sha)) {
        return false;
      }
      seenCommitShas.add(commit.sha);
      distinctCommits.push(commit);
      return true;
    });
    return {
      name,
      sourceRef: request.localRef,
      destinationRef: request.remoteRef,
      highestPushedBatch,
      refVerdict,
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

  const pushVerdicts = checkPushedBatchUniqueness(distinctCommits);
  const result = { quietHours, pushVerdicts, refs };
  const commitViolations = refs.reduce(
    (total, ref) => total + ref.evaluation.violations,
    0,
  );
  const refViolations = refs.filter(
    (ref) => ref.refVerdict.status === "fail",
  ).length;
  const pushViolations = pushVerdicts.filter(
    (entry) => entry.status === "fail",
  ).length;
  const totalViolations = commitViolations + refViolations + pushViolations;
  const totalChecked = refs.reduce(
    (total, ref) => total + ref.evaluation.checked,
    0,
  );
  const ok = totalViolations === 0 && quietHours.status === "pass";

  const report = formatPushReport(result, { explain });
  const header = ok
    ? `landing-guard: ${totalChecked} governed commit(s) pass — 0 commit rule violation(s), 0 protected-ref violation(s), 0 push rule violation(s) (R-2026-08-14-4)`
    : `landing-guard: PUSH REFUSED — ${commitViolations} commit rule violation(s), ${refViolations} protected-ref violation(s), ${pushViolations} push rule violation(s)${quietHours.status === "fail" ? " + quiet hours" : ""} (R-2026-08-14-4)`;
  stderr.write(`${header}\n`);
  if (report !== "") {
    stderr.write(`${report}\n`);
  }
  if (!ok) {
    stderr.write(
      [
        "",
        "  Rules: migration_doc/EXECUTOR_LANE_CHARTER_2026-08-14.md §2.1/§2.2",
        "  Fix the commits (reword/amend before they are pushed) or wait out the window.",
        "  A hook that blocks incorrectly is a RULING REQUEST, not a --no-verify bypass;",
        "  `npm run verify-landing` can re-check commit rules, but not a bypassed ref event.",
        "  Server-side branch protection is a separate control.",
        "",
      ].join("\n"),
    );
  }
  return ok ? 0 : 1;
}

/**
 * Convert any guard/runtime failure into the documented fail-closed exit.
 *
 * @param {object} [options] Main options plus an optional stderr writer.
 * @returns {number} Exit code 0, 1, or 2.
 */
export function runCli(options = {}) {
  const stderr = options.stderr ?? process.stderr;
  try {
    return main(options);
  } catch (error) {
    stderr.write(
      `landing-guard: FAILED TO RUN — ${error?.message ?? error}\n` +
        "  The guard could not inspect the complete push, so it is refused (fail-closed).\n",
    );
    return 2;
  }
}

const executablePath = process.argv[1];
const modulePath = fileURLToPath(import.meta.url);
const normalizeExecutablePath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
if (
  executablePath !== undefined &&
  normalizeExecutablePath(executablePath) ===
    normalizeExecutablePath(modulePath)
) {
  process.exitCode = runCli();
}
