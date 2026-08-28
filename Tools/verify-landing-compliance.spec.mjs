// verify-landing-compliance.spec.mjs — contract for the bypass detector.
// @purpose Contract for the bypass detector against immutable history: known-bad C12-37 landing must red, known-good B1041-1043 landing must pass.
// @status ACTIVE
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
//   KNOWN-GOOD the Batch 1041-1043 landing, which complies. It may retain
//              pre-ratchet warnings, but must report no enforceable error.
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
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MARKER_RULES } from "./c16/lib/marker-grammar.mjs";
import { parseArgs } from "./verify-landing-compliance.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const VERIFIER = fileURLToPath(
  new URL("./verify-landing-compliance.mjs", import.meta.url),
);
const TIMEOUT_MS = 120_000;
const CLEAN_LIST_PATH = "Tools/c16/comment-marker-cleanlist.txt";
const SOURCE_PATH = "packages/engine/Source/Scene/HistoricalFixture.js";
const MERGE_SOURCE_PATH = "packages/engine/Source/Scene/MergeParentFixture.js";
const ODD_SOURCE_PATH = "packages/engine/Source/Scene/Odd marker fixture.js";
const COLLISION_SLASH_PATH = "packages/engine/Source/Collision/Fixture.js";
const COLLISION_BACKSLASH_PATH = "packages/engine/Source/Collision\\Fixture.js";
const GIT_FAULT_PRELOAD_PATH = ".fixture/git-fault-preload.cjs";
const POLICY_RACE_PRELOAD_PATH = ".fixture/policy-race-preload.cjs";
const HISTORY_RACE_PRELOAD_PATH = ".fixture/history-race-preload.cjs";
const LANDING_RULES_PATH = "Tools/landing-rules.mjs";
const MARKER_GUARD_PATH = "Tools/c16/comment-marker-guard.mjs";
const COMMENT_SCANNER_PATH = "Tools/c16/lib/comment-scanner.mjs";
const MARKER_GRAMMAR_PATH = "Tools/c16/lib/marker-grammar.mjs";
const VERIFIER_FIXTURE_FILES = Object.freeze([
  "Tools/verify-landing-compliance.mjs",
  LANDING_RULES_PATH,
  MARKER_GUARD_PATH,
  COMMENT_SCANNER_PATH,
  MARKER_GRAMMAR_PATH,
]);

/** The C12-37 landing finding S9 named: 8 clean-listed marker errors. */
const KNOWN_BAD_RANGE = "6d4a2376fc~1..4d43ee6015";

/** Batches 1041-1043: prefixed, bodied, trailered, no marker errors. */
const KNOWN_GOOD_RANGE = "4c9b559411~3..4c9b559411";

/** Current verifier-owned private-history temp directory names. */
function historyTempDirectories() {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith("verify-landing-history-"),
    )
    .map((entry) => entry.name)
    .sort();
}

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
 * @param {{repoRoot?: string, gitFaultPhase?: string, policyRacePhase?: "start"|"end"|"end-graph"|"aba", historyRacePhase?: "shallow"|"graft"|"private-shallow"|"private-graft"|"private-config"|"private-ref"}} [options] Fixture options.
 * @returns {{status: number, output: string}} Result.
 */
function verify(args, options = {}) {
  const verifier =
    options.repoRoot === undefined
      ? VERIFIER
      : path.join(options.repoRoot, "Tools", "verify-landing-compliance.mjs");
  const nodeArgs = [];
  if (options.gitFaultPhase !== undefined) {
    nodeArgs.push(
      "--require",
      path.join(options.repoRoot, ...GIT_FAULT_PRELOAD_PATH.split("/")),
    );
  }
  if (options.policyRacePhase !== undefined) {
    nodeArgs.push(
      "--require",
      path.join(options.repoRoot, ...POLICY_RACE_PRELOAD_PATH.split("/")),
    );
  }
  if (options.historyRacePhase !== undefined) {
    nodeArgs.push(
      "--require",
      path.join(options.repoRoot, ...HISTORY_RACE_PRELOAD_PATH.split("/")),
    );
  }
  nodeArgs.push(verifier, ...args);
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: options.repoRoot ?? ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.gitFaultPhase === undefined
        ? {}
        : { VERIFY_LANDING_GIT_FAULT_PHASE: options.gitFaultPhase }),
      ...(options.policyRacePhase === undefined
        ? {}
        : { VERIFY_LANDING_POLICY_RACE_PHASE: options.policyRacePhase }),
      ...(options.historyRacePhase === undefined
        ? {}
        : { VERIFY_LANDING_HISTORY_RACE_PHASE: options.historyRacePhase }),
    },
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

/**
 * Run git only inside a hermetic test repository.
 *
 * @param {string} root Repository root.
 * @param {string[]} args Git arguments.
 * @param {NodeJS.ProcessEnv} [extraEnv] Environment overrides.
 * @param {string|Buffer} [input] Optional stdin.
 * @returns {string} stdout.
 */
function fixtureGit(root, args, extraEnv = {}, input) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    input,
    timeout: TIMEOUT_MS,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error !== undefined && result.error !== null) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `fixture git ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/** Write one blob object directly, without imposing host filesystem syntax. */
function fixtureBlob(root, content) {
  return fixtureGit(root, ["hash-object", "-w", "--stdin"], {}, content);
}

/**
 * Write an exact Git tree, preserving entry names such as a literal backslash.
 * Entries must already be in Git tree order.
 */
function fixtureTree(root, entries) {
  const input = Buffer.concat(
    entries.flatMap((entry) => [
      Buffer.from(`${entry.mode} ${entry.type} ${entry.oid}\t`, "utf8"),
      Buffer.isBuffer(entry.name)
        ? entry.name
        : Buffer.from(entry.name, "utf8"),
      Buffer.from([0]),
    ]),
  );
  return fixtureGit(root, ["mktree", "-z"], {}, input);
}

/**
 * Write one fixture file below the temporary repository.
 *
 * @param {string} root Repository root.
 * @param {string} relative Repo-relative path.
 * @param {string} content File content.
 */
function writeFixture(root, relative, content) {
  const absolute = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

/** Remove one loose object only from a temporary fixture repository. */
function removeFixtureObject(root, oid) {
  const gitDir = fixtureGit(root, ["rev-parse", "--git-dir"]);
  unlinkSync(
    path.resolve(root, gitDir, "objects", oid.slice(0, 2), oid.slice(2)),
  );
}

/**
 * Copy the verifier and its direct runtime dependencies into a fixture repo.
 *
 * Keeping the production verifier root fixed prevents a test seam from
 * becoming a detector-bypass environment variable.
 *
 * @param {string} root Fixture repository root.
 */
function installFixtureVerifier(root) {
  for (const relative of VERIFIER_FIXTURE_FILES) {
    const destination = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(ROOT, ...relative.split("/")), destination);
  }
  writeFixture(
    root,
    GIT_FAULT_PRELOAD_PATH,
    `const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const originalExecFileSync = childProcess.execFileSync;
const phase = process.env.VERIFY_LANDING_GIT_FAULT_PHASE;

function matchesFault(args) {
  if (!Array.isArray(args)) {
    return false;
  }
  switch (phase) {
    case "select-range":
      return args[0] === "rev-parse" && args.includes("--abbrev-ref") && args.includes("@{u}");
    case "endpoint-resolution":
      return args[0] === "rev-parse" && args.includes("--end-of-options") && args.at(-1)?.endsWith("^{commit}");
    case "object-existence":
      return args[0] === "cat-file" && args[1] === "-e" && args[2]?.endsWith("^{commit}");
    case "parent-read":
      return args[0] === "cat-file" && args[1] === "commit";
    case "baseline-log":
      return args[0] === "rev-list" && args.includes("--topo-order");
    case "selected-range-log":
      return args[0] === "rev-list" && args.includes("--date-order");
    default:
      return false;
  }
}

childProcess.execFileSync = function faultInjectedExecFileSync(command, args, options) {
  if (command === "git" && matchesFault(args)) {
    const binary = options?.encoding === null;
    const diagnostic = "fatal: injected ordinary Git failure at " + phase + "\\n";
    const error = new Error(diagnostic.trim());
    error.status = 74;
    error.signal = null;
    error.stdout = binary ? Buffer.alloc(0) : "";
    error.stderr = binary ? Buffer.from(diagnostic, "utf8") : diagnostic;
    throw error;
  }
  return Reflect.apply(originalExecFileSync, childProcess, [command, args, options]);
};

syncBuiltinESMExports();
`,
  );
  writeFixture(
    root,
    POLICY_RACE_PRELOAD_PATH,
    `const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");

const phase = process.env.VERIFY_LANDING_POLICY_RACE_PHASE;
const target = path.join(process.cwd(), "Tools", "landing-rules.mjs");
const lastCaptureTarget = path.join(
  process.cwd(),
  "Tools",
  "c16",
  "lib",
  "marker-grammar.mjs",
);
const originalSource = fs.readFileSync(target, "utf8");
let mutated = false;
let restored = false;

function mutatePolicy() {
  if (mutated) {
    return;
  }
  fs.appendFileSync(target, "\\n// deterministic policy dependency race\\n", "utf8");
  mutated = true;
}

function mutatePolicyGraph() {
  if (mutated) {
    return;
  }
  fs.appendFileSync(target, "\\nimport './unexpected-policy.mjs';\\n", "utf8");
  mutated = true;
}

function mutatePolicyForAba() {
  if (mutated) {
    return;
  }
  const weakened = originalSource.replace(
    /  return highest;\\r?\\n\\}/u,
    "  return null;\\n}",
  );
  if (weakened === originalSource) {
    throw new Error("policy ABA mutant was a no-op");
  }
  fs.writeFileSync(target, weakened, "utf8");
  fs.writeFileSync(
    path.join(process.cwd(), ".fixture", "policy-aba-ran"),
    "highestBatchIn weakened during live-module import window\\n",
    "utf8",
  );
  mutated = true;
}

function restorePolicy() {
  if (!mutated || restored) {
    return;
  }
  fs.writeFileSync(target, originalSource, "utf8");
  restored = true;
}

const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function raceInjectedReadFileSync(file, options) {
  if (
    phase === "aba" &&
    mutated &&
    !restored &&
    typeof file !== "number" &&
    path.resolve(String(file)) === path.resolve(target)
  ) {
    restorePolicy();
  }
  const value = Reflect.apply(originalReadFileSync, fs, [file, options]);
  if (
    phase === "start" &&
    !mutated &&
    typeof file !== "number" &&
    path.resolve(String(file)) === path.resolve(target)
  ) {
    mutatePolicy();
  }
  if (
    phase === "aba" &&
    !mutated &&
    typeof file !== "number" &&
    path.resolve(String(file)) === path.resolve(lastCaptureTarget)
  ) {
    mutatePolicyForAba();
  }
  return value;
};

const originalWriteFileSync = fs.writeFileSync;
fs.writeFileSync = function raceInjectedWriteFileSync(file, data, options) {
  const value = Reflect.apply(originalWriteFileSync, fs, [file, data, options]);
  if (
    phase === "aba" &&
    !mutated &&
    typeof file !== "number" &&
    path.resolve(String(file)) !== path.resolve(target) &&
    path.resolve(String(file)).endsWith(path.join("Tools", "landing-rules.mjs"))
  ) {
    mutatePolicyForAba();
  }
  return value;
};

const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function raceInjectedExecFileSync(command, args, options) {
  const value = Reflect.apply(originalExecFileSync, childProcess, [command, args, options]);
  if (
    (phase === "end" || phase === "end-graph") &&
    !mutated &&
    command === "git" &&
    Array.isArray(args) &&
    args[0] === "rev-parse" &&
    args.includes("--is-shallow-repository")
  ) {
    if (phase === "end-graph") {
      mutatePolicyGraph();
    } else {
      mutatePolicy();
    }
  }
  return value;
};

process.once("exit", restorePolicy);

syncBuiltinESMExports();
`,
  );
  writeFixture(
    root,
    HISTORY_RACE_PRELOAD_PATH,
    `const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");

const phase = process.env.VERIFY_LANDING_HISTORY_RACE_PHASE;
const privateSubject = phase.startsWith("private-");
const stateKind = phase.endsWith("shallow")
  ? "shallow"
  : phase.endsWith("config")
    ? "config"
    : phase.endsWith("ref")
      ? "ref"
      : "graft";
let target;
let active = false;
let originalTarget;

function stateTarget(options) {
  const gitDirectory = privateSubject
    ? options?.env?.GIT_DIR
    : path.join(process.cwd(), ".git");
  if (typeof gitDirectory !== "string") {
    throw new Error("history race could not bind its Git directory");
  }
  if (stateKind === "shallow") {
    return path.join(gitDirectory, "shallow");
  }
  if (stateKind === "config") {
    return path.join(gitDirectory, "config");
  }
  if (stateKind === "ref") {
    return path.join(gitDirectory, "HEAD");
  }
  return path.join(gitDirectory, "info", "grafts");
}

function activate(boundary, options) {
  if (active) {
    return;
  }
  target = stateTarget(options);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  originalTarget = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (stateKind === "config") {
    fs.appendFileSync(target, "\\n[core]\\n\\tabbrev = 4\\n", "utf8");
  } else if (stateKind === "ref") {
    fs.writeFileSync(target, "0000000000000000000000000000000000000000\\n", "ascii");
  } else {
    fs.writeFileSync(target, boundary + "\\n", "utf8");
  }
  fs.writeFileSync(
    path.join(process.cwd(), ".fixture", "history-race-" + phase),
    "baseline " + boundary + "\\n",
    "utf8",
  );
  active = true;
}

function restore() {
  if (!active) {
    return;
  }
  if (originalTarget === null) {
    fs.rmSync(target, { force: true });
  } else {
    fs.writeFileSync(target, originalTarget);
  }
  active = false;
}

const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function historyRaceExecFileSync(command, args, options) {
  const endpointRead =
    stateKind === "ref" &&
    command === "git" &&
    Array.isArray(args) &&
    typeof options?.env?.GIT_DIR === "string" &&
    args[0] === "rev-parse" &&
    args.includes("--end-of-options") &&
    args.at(-1)?.endsWith("^{commit}");
  const baselineLog =
    command === "git" &&
    Array.isArray(args) &&
    args[0] === "rev-list" &&
    args.includes("--topo-order");
  const selectedLog =
    command === "git" &&
    Array.isArray(args) &&
    args[0] === "rev-list" &&
    args.includes("--date-order");
  if (endpointRead) {
    activate(args.at(-1), options);
  } else if (stateKind !== "ref" && baselineLog) {
    activate(args.at(-1), options);
  }
  if (stateKind !== "ref" && selectedLog) {
    const visibleBoundary =
      stateKind === "config"
        ? "config-active"
        : fs.readFileSync(target, "utf8").trim();
    fs.appendFileSync(
      path.join(process.cwd(), ".fixture", "history-race-" + phase),
      "selected " + visibleBoundary + "\\n",
      "utf8",
    );
  }
  try {
    return Reflect.apply(originalExecFileSync, childProcess, [command, args, options]);
  } finally {
    if (endpointRead || (stateKind !== "ref" && selectedLog)) {
      restore();
    }
  }
};

process.once("exit", restore);
syncBuiltinESMExports();
`,
  );
}

/** Bind a stable local remote-tracking upstream to one fixture revision. */
function configureFixtureUpstream(root, revision) {
  const branch = fixtureGit(root, ["branch", "--show-current"]);
  fixtureGit(root, ["remote", "add", "origin", root]);
  fixtureGit(root, ["update-ref", `refs/remotes/origin/${branch}`, revision]);
  fixtureGit(root, ["config", `branch.${branch}.remote`, "origin"]);
  fixtureGit(root, [
    "config",
    `branch.${branch}.merge`,
    `refs/heads/${branch}`,
  ]);
}

/**
 * Commit the fixture index under one compliant governed message.
 *
 * Fixed Sunday timestamps keep the quiet-hours predicate deterministic.
 *
 * @param {string} root Repository root.
 * @param {number} batch Batch number.
 * @param {string} subject Subject after the prefix.
 * @returns {string} Commit SHA.
 */
function commitStagedFixture(root, batch, subject) {
  const date = `2026-08-16T00:${String(batch % 60).padStart(2, "0")}:00-04:00`;
  fixtureGit(
    root,
    [
      "commit",
      "--quiet",
      "-m",
      `Batch ${batch}: ${subject}`,
      "-m",
      "Hermetic verifier history fixture.",
      "-m",
      "Co-Authored-By: Fixture Reviewer <reviewer@example.test>",
    ],
    { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  );
  return fixtureGit(root, ["rev-parse", "HEAD"]);
}

/** Commit staged fixture bytes under a deliberately non-agent identity. */
function commitStagedNonAgentFixture(root, subject) {
  const date = "2026-08-16T01:00:00-04:00";
  fixtureGit(
    root,
    [
      "commit",
      "--quiet",
      "-m",
      subject,
      "-m",
      "External maintainer fixture commit.",
    ],
    {
      GIT_AUTHOR_NAME: "External Maintainer",
      GIT_AUTHOR_EMAIL: "maintainer@example.test",
      GIT_COMMITTER_NAME: "External Maintainer",
      GIT_COMMITTER_EMAIL: "maintainer@example.test",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  );
  return fixtureGit(root, ["rev-parse", "HEAD"]);
}

/** Commit an already-built tree without checking its paths out on the host. */
function commitTreeFixture(root, tree, parent, batch, subject) {
  const date = `2026-08-16T00:${String(batch % 60).padStart(2, "0")}:00-04:00`;
  return fixtureGit(
    root,
    [
      "commit-tree",
      tree,
      "-p",
      parent,
      "-m",
      `Batch ${batch}: ${subject}`,
      "-m",
      "Hermetic verifier history fixture.",
      "-m",
      "Co-Authored-By: Fixture Reviewer <reviewer@example.test>",
    ],
    { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  );
}

/** Stage the whole temp fixture and commit it. */
function commitFixture(root, batch, subject) {
  fixtureGit(root, ["add", "--all"]);
  return commitStagedFixture(root, batch, subject);
}

/**
 * Initialize a temporary history fixture with an optional strict source path.
 *
 * @param {import("node:test").TestContext} t Test context.
 * @param {{cleanListed?: boolean, cleanListEntries?: string[], cleanListPresent?: boolean, source?: string|null}} [options] Baseline shape.
 * @returns {{root: string, base: string}} Fixture identity.
 */
function createHistoryFixture(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "landing-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const relativeToWorkspace = path.relative(ROOT, root);
  assert.ok(
    path.isAbsolute(relativeToWorkspace) ||
      relativeToWorkspace === ".." ||
      relativeToWorkspace.startsWith(`..${path.sep}`),
    `fixture Git repository must be outside the workspace: ${root}`,
  );
  assert.notEqual(path.resolve(root), path.resolve(ROOT, ".git"));
  fixtureGit(root, ["init", "--quiet"]);
  fixtureGit(root, ["config", "user.name", "cesium-webgpu-agent"]);
  fixtureGit(root, [
    "config",
    "user.email",
    "cesium-webgpu-agent@example.test",
  ]);
  fixtureGit(root, ["config", "commit.gpgsign", "false"]);
  fixtureGit(root, ["config", "core.autocrlf", "false"]);
  fixtureGit(root, ["config", "core.hooksPath", ".git/disabled-hooks"]);
  installFixtureVerifier(root);
  if (options.cleanListPresent !== false) {
    writeFixture(
      root,
      CLEAN_LIST_PATH,
      `# fixture clean list\n${(
        options.cleanListEntries ??
        (options.cleanListed === true ? [SOURCE_PATH] : [])
      )
        .map((entry) => `${entry}\n`)
        .join("")}`,
    );
  }
  if (options.source !== null) {
    writeFixture(
      root,
      SOURCE_PATH,
      options.source ?? "export const fixture = 0;\n",
    );
  }
  return { root, base: commitFixture(root, 100, "fixture baseline") };
}

/** Create enough immutable fixture ancestry for the default HEAD~20 range. */
function createLongHistoryFixture(t) {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  createDeepBaselineFixture(root, base, 21);
  return { root, base, head: fixtureGit(root, ["rev-parse", "HEAD"]) };
}

/** Apply one asserted source mutation only to a disposable fixture policy. */
function mutateFixturePolicy(root, relative, mutate) {
  const absolute = path.join(root, ...relative.split("/"));
  const before = readFileSync(absolute, "utf8");
  const after = mutate(before);
  assert.equal(typeof after, "string");
  assert.notEqual(after, before, `policy mutant was a no-op: ${relative}`);
  writeFixture(root, relative, after);
  return { before, after };
}

/** Install a real external ESM module that records if policy loading reaches it. */
function installExternalPolicy(root) {
  const modulePath = path.join(root, ".fixture", "external-policy.mjs");
  const sentinel = path.join(root, ".fixture", "external-policy-executed");
  writeFixture(
    root,
    ".fixture/external-policy.mjs",
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "executed\\n", "utf8");\nexport default true;\n`,
  );
  return { moduleUrl: pathToFileURL(modulePath).href, sentinel };
}

/** Byte span of one MARKER_RULES object, including its trailing separator. */
function markerRuleSpan(source, id) {
  const idToken = `    id: "${id}"`;
  const idOffset = source.indexOf(idToken);
  assert.notEqual(idOffset, -1, `missing marker rule ${id}`);
  const start = source.lastIndexOf("  {", idOffset);
  assert.notEqual(start, -1, `missing marker rule start ${id}`);
  const nextIdOffset = source.indexOf('    id: "', idOffset + idToken.length);
  const end =
    nextIdOffset < 0
      ? source.indexOf("]);", idOffset)
      : source.lastIndexOf("  {", nextIdOffset);
  assert.ok(end > start, `missing marker rule end ${id}`);
  return { start, end, text: source.slice(start, end) };
}

/** Parse one trusted test regex literal without evaluating fixture source. */
function parsePatternLiteral(patternLiteral) {
  const closingSlash = patternLiteral.lastIndexOf("/");
  assert.ok(
    patternLiteral.startsWith("/") && closingSlash > 0,
    `invalid marker pattern literal: ${patternLiteral}`,
  );
  return new RegExp(
    patternLiteral.slice(1, closingSlash),
    patternLiteral.slice(closingSlash + 1),
  );
}

/** Return exact global matches without sharing mutable RegExp.lastIndex state. */
function patternMatches(pattern, text) {
  return Array.from(
    text.matchAll(new RegExp(pattern.source, pattern.flags)),
    (match) => match[0],
  );
}

/** Replace one fixture pattern after proving the mutant changes a real control. */
function replaceMarkerRulePattern(source, id, patternLiteral, control) {
  const span = markerRuleSpan(source, id);
  const patternStart = span.text.indexOf("    pattern:");
  const descriptionStart = span.text.indexOf("    description:", patternStart);
  assert.ok(patternStart >= 0 && descriptionStart > patternStart);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const rewritten =
    span.text.slice(0, patternStart) +
    `    pattern: ${patternLiteral},${newline}` +
    span.text.slice(descriptionStart);
  assert.notEqual(
    rewritten,
    span.text,
    `marker pattern mutant was a no-op: ${id}`,
  );
  const realRule = MARKER_RULES.find((rule) => rule.id === id);
  assert.ok(realRule, `missing real marker rule ${id}`);
  const realMatches = patternMatches(realRule.pattern, control.text);
  const mutantMatches = patternMatches(
    parsePatternLiteral(patternLiteral),
    control.text,
  );
  assert.deepEqual(realMatches, control.expected);
  assert.deepEqual(mutantMatches, control.actual);
  assert.notDeepEqual(
    mutantMatches,
    realMatches,
    `marker pattern mutant was semantically equivalent on its control: ${id}`,
  );
  return source.slice(0, span.start) + rewritten + source.slice(span.end);
}

/** Delete one complete marker rule, including its mutable example. */
function deleteMarkerRule(source, id) {
  const span = markerRuleSpan(source, id);
  return source.slice(0, span.start) + source.slice(span.end);
}

/** Insert a self-tested new marker rule without changing required rule order. */
function addMarkerRule(source) {
  const grammarStart = source.indexOf("export const MARKER_RULES");
  const closing = source.indexOf("]);", grammarStart);
  assert.ok(grammarStart >= 0 && closing > grammarStart);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const addition = [
    "  {",
    '    id: "add-only-control",',
    "    pattern: /\\bADD-ONLY-CONTROL\\b/g,",
    '    description: "A self-tested future rule used by the inverse control.",',
    '    example: "ADD-ONLY-CONTROL",',
    "  },",
    "",
  ].join(newline);
  return source.slice(0, closing) + addition + source.slice(closing);
}

/** Replace the marker-rule array with one valid, non-array export. */
function replaceMarkerRulesWithNonArray(source) {
  const declaration = "export const MARKER_RULES = Object.freeze([";
  const start = source.indexOf(declaration);
  const closing = source.indexOf("]);", start);
  assert.ok(start >= 0 && closing > start);
  return (
    source.slice(0, start) +
    "export const MARKER_RULES = Object.freeze({});" +
    source.slice(closing + 3)
  );
}

/**
 * Add one high Batch subject followed by a deep ordinary baseline in one
 * fast-import transaction. A control ref stops one commit before the exact
 * historical 5,000-entry truncation boundary.
 */
function createDeepBaselineFixture(root, base, ordinaryCount = 5_000) {
  const branch = "deep-baseline";
  const ref = `refs/heads/${branch}`;
  const controlRef = "refs/heads/deep-baseline-control";
  const lines = [];
  let mark = 1;
  const appendCommit = (subject, from) => {
    const message = `${subject}\n`;
    lines.push(
      `commit ${ref}`,
      `mark :${mark}`,
      "author External Baseline <baseline@example.test> 1786852800 -0400",
      "committer External Baseline <baseline@example.test> 1786852800 -0400",
      `data ${Buffer.byteLength(message)}`,
      message,
      `from ${from}`,
      "",
    );
    mark += 1;
  };
  appendCommit("Batch 9000: hidden complete-history baseline", base);
  for (let index = 1; index <= ordinaryCount; index += 1) {
    appendCommit(`ordinary baseline ${index}`, `:${mark - 1}`);
    if (index === ordinaryCount - 1) {
      lines.push(`reset ${controlRef}`, `from :${mark - 1}`, "");
    }
  }
  lines.push("done", "");
  fixtureGit(root, ["fast-import", "--quiet"], {}, lines.join("\n"));
  fixtureGit(root, ["switch", "--quiet", branch]);
  return {
    boundaryBase: fixtureGit(root, ["rev-parse", ref]),
    controlBase: fixtureGit(root, ["rev-parse", controlRef]),
    branch,
    controlBranch: "deep-baseline-control",
  };
}

/** Parse a verifier JSON result after asserting it emitted JSON. */
function reportOf(result) {
  assert.doesNotThrow(() => JSON.parse(result.output), result.output);
  return JSON.parse(result.output);
}

test("parseArgs accepts the documented forms", () => {
  assert.deepEqual(parseArgs(["--range", "a..b"]).range, "a..b");
  assert.deepEqual(parseArgs(["--range=a..b"]).range, "a..b");
  assert.equal(parseArgs(["--last", "30"]).last, 30);
  assert.equal(parseArgs(["--last=30"]).last, 30);
  assert.equal(
    parseArgs(["--trusted-baseline-batch", "1043"]).trustedBaselineBatch,
    1043,
  );
  assert.equal(
    parseArgs(["--trusted-baseline-batch=1043"]).trustedBaselineBatch,
    1043,
  );
  assert.equal(parseArgs(["--json"]).json, true);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs([]).range, null);
});

test("parseArgs rejects malformed input rather than guessing a range", () => {
  assert.throws(() => parseArgs(["--range", "HEAD"]), /two-dot/);
  assert.throws(() => parseArgs(["--range", "a...b"]), /exactly one/);
  assert.throws(() => parseArgs(["--range", "a..b..ignored"]), /exactly one/);
  assert.throws(() => parseArgs(["--range", "..b"]), /non-empty/);
  assert.throws(() => parseArgs(["--range", "a.."]), /non-empty/);
  assert.throws(() => parseArgs(["--range"]), /needs a value/);
  assert.throws(
    () => parseArgs(["--range", "a..b", "--last", "1"]),
    /mutually exclusive/,
  );
  assert.throws(() => parseArgs(["--last", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--last", "x"]), /positive integer/);
  assert.throws(
    () => parseArgs(["--trusted-baseline-batch", "0"]),
    /positive batch integer/,
  );
  assert.throws(
    () => parseArgs(["--trusted-baseline-batch", "1000000"]),
    /six digits/,
  );
  assert.throws(() => parseArgs(["--wat"]), /unknown argument/);
});

test("a third range component is rejected rather than silently ignored", () => {
  const result = verify(["--range", "HEAD~1..HEAD..ignored"]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /exactly one two-dot separator/);
  assert.doesNotMatch(result.output, /verify-landing: PASS/);
});

test("an empty range is STRUCTURAL, not a pass", (t) => {
  // Measured on an own fixture, never on the working checkout. A shallow
  // checkout - the default depth-1 clone a hosted runner produces - resolves
  // the incomplete-ancestry baseline reason before the range is ever counted,
  // so reading this rule off the host repository reports the environment
  // instead of the rule.
  const { root } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  commitFixture(root, 101, "second commit so a depth-1 clone truncates");
  assert.equal(
    fixtureGit(root, ["rev-parse", "--is-shallow-repository"]),
    "false",
  );

  const result = verify(["--range", "HEAD..HEAD"], { repoRoot: root });
  assert.equal(result.status, 3, result.output);
  assert.match(result.output, /STRUCTURAL/);
  assert.match(result.output, /nothing was verified/);
  assert.doesNotMatch(result.output, /verify-landing: PASS/);

  // Same empty range, truncated ancestry: the stated reason moves from
  // emptiness to shallowness, but the verdict must never become a pass.
  const cloneParent = mkdtempSync(path.join(tmpdir(), "landing-empty-range-"));
  t.after(() => rmSync(cloneParent, { recursive: true, force: true }));
  const shallow = path.join(cloneParent, "repo");
  fixtureGit(cloneParent, [
    "clone",
    "--quiet",
    "--no-local",
    "--depth",
    "1",
    root,
    shallow,
  ]);
  assert.equal(
    fixtureGit(shallow, ["rev-parse", "--is-shallow-repository"]),
    "true",
  );
  const shallowResult = verify(["--range", "HEAD..HEAD"], {
    repoRoot: shallow,
  });
  assert.equal(shallowResult.status, 3, shallowResult.output);
  assert.match(shallowResult.output, /STRUCTURAL/);
  assert.match(shallowResult.output, /ancestry is shallow/);
  assert.doesNotMatch(shallowResult.output, /verify-landing: PASS/);
});

test("detached HEAD uses origin/main when that fallback is available", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "detached origin fallback control");
  configureFixtureUpstream(root, base);
  const upstream = fixtureGit(root, ["rev-parse", "--abbrev-ref", "@{u}"]);

  const ordinary = verify(["--json"], { repoRoot: root });
  assert.equal(ordinary.status, 0, ordinary.output);
  assert.equal(reportOf(ordinary).requestedRange, `${upstream}..HEAD`);

  fixtureGit(root, ["update-ref", "refs/remotes/origin/main", base]);
  fixtureGit(root, ["checkout", "--quiet", "--detach"]);
  const detached = verify(["--json"], { repoRoot: root });
  assert.notEqual(detached.status, 2, detached.output);
  assert.equal(detached.status, 0, detached.output);
  const report = reportOf(detached);
  assert.equal(
    report.requestedRange,
    "refs/remotes/origin/main..HEAD (detached HEAD; using origin/main fallback)",
  );
  assert.equal(report.rangeBase, base);
  assert.equal(report.rangeHead, head);
  assert.doesNotMatch(detached.output, /FAILED TO RUN/u);
});

test("detached HEAD names the last-20 fallback when origin/main is absent", (t) => {
  const { root } = createHistoryFixture(t, { cleanListed: true });
  const ordinary = verify(["--json"], { repoRoot: root });
  assert.equal(ordinary.status, 3, ordinary.output);
  assert.equal(
    reportOf(ordinary).requestedRange,
    "last 20 commit(s) (no upstream configured)",
  );

  fixtureGit(root, ["checkout", "--quiet", "--detach"]);
  const detached = verify(["--json"], { repoRoot: root });
  assert.notEqual(detached.status, 2, detached.output);
  assert.equal(detached.status, 3, detached.output);
  const report = reportOf(detached);
  const requested =
    "last 20 commit(s) (detached HEAD; origin/main fallback unavailable)";
  assert.equal(report.requestedRange, requested);
  assert.equal(
    report.reason,
    `${requested} exceeds the locally available commit history`,
  );
  assert.deepEqual(report.unavailableRevisions, ["HEAD~20"]);
  assert.doesNotMatch(detached.output, /FAILED TO RUN/u);
});

test("detached HEAD ignores a local branch named origin/main", (t) => {
  const { root, head } = createLongHistoryFixture(t);
  const localBranchCommit = fixtureGit(root, ["rev-parse", "HEAD~2"]);
  fixtureGit(root, ["branch", "origin/main", localBranchCommit]);
  assert.equal(
    fixtureGit(root, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/remotes/origin/main",
    ]),
    "",
  );

  fixtureGit(root, ["checkout", "--quiet", "--detach"]);
  const fallbackBase = fixtureGit(root, ["rev-parse", "HEAD~20"]);
  const result = verify(["--json"], { repoRoot: root });
  assert.equal(result.status, 0, result.output);
  const report = reportOf(result);
  assert.equal(
    report.requestedRange,
    "last 20 commit(s) (detached HEAD; origin/main fallback unavailable)",
  );
  assert.equal(report.rangeBase, fallbackBase);
  assert.notEqual(report.rangeBase, localBranchCommit);
  assert.equal(report.rangeHead, head);
  assert.doesNotMatch(result.output, /using origin\/main fallback/u);
});

test("detached HEAD ignores a tag named origin/main", (t) => {
  const { root, head } = createLongHistoryFixture(t);
  const tagCommit = fixtureGit(root, ["rev-parse", "HEAD~2"]);
  fixtureGit(root, ["tag", "origin/main", tagCommit]);
  assert.equal(
    fixtureGit(root, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/remotes/origin/main",
    ]),
    "",
  );

  fixtureGit(root, ["checkout", "--quiet", "--detach"]);
  const fallbackBase = fixtureGit(root, ["rev-parse", "HEAD~20"]);
  const result = verify(["--json"], { repoRoot: root });
  assert.equal(result.status, 0, result.output);
  const report = reportOf(result);
  assert.equal(
    report.requestedRange,
    "last 20 commit(s) (detached HEAD; origin/main fallback unavailable)",
  );
  assert.equal(report.rangeBase, fallbackBase);
  assert.notEqual(report.rangeBase, tagCommit);
  assert.equal(report.rangeHead, head);
  assert.doesNotMatch(result.output, /using origin\/main fallback/u);
});

test("symbolic HEAD targeting a non-branch ref surfaces the Git failure", (t) => {
  const { root, head } = createLongHistoryFixture(t);
  fixtureGit(root, ["update-ref", "refs/tags/head-target", head]);
  fixtureGit(root, ["symbolic-ref", "HEAD", "refs/tags/head-target"]);
  assert.equal(
    fixtureGit(root, ["symbolic-ref", "--quiet", "HEAD"]),
    "refs/tags/head-target",
  );

  const result = verify(["--json"], { repoRoot: root });
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /FAILED TO RUN/u);
  assert.match(result.output, /HEAD does not point to a branch/u);
  assert.doesNotMatch(result.output, /detached HEAD/u);
  assert.doesNotMatch(result.output, /verify-landing: PASS/u);
});

test("hermetic ordinary clean and failing marker controls diverge", (t) => {
  const tempBaseline = historyTempDirectories();
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const clean = commitFixture(root, 101, "ordinary clean control");
  const requestedRange = `${base.slice(0, 12)}..HEAD`;
  const cleanResult = verify(["--range", requestedRange, "--json"], {
    repoRoot: root,
  });
  assert.equal(cleanResult.status, 0, cleanResult.output);
  assert.deepEqual(historyTempDirectories(), tempBaseline);
  const cleanReport = reportOf(cleanResult);
  assert.equal(cleanReport.ok, true);
  assert.equal(cleanReport.requestedRange, requestedRange);
  assert.equal(cleanReport.range, `${base}..${clean}`);
  assert.equal(cleanReport.rangeBase, base);
  assert.equal(cleanReport.rangeHead, clean);
  assert.equal(cleanReport.markerGuard.scanned, 1);
  assert.equal(cleanReport.markerGuard.errors.length, 0);
  assert.equal(cleanReport.markerGuard.warnings.length, 0);
  assert.equal(cleanReport.policyDependencies.stableAtLoad, true);
  assert.equal(cleanReport.policyDependencies.stableAtEnd, true);
  assert.match(cleanReport.policyDependencies.closureSha256, /^[A-F0-9]{64}$/u);
  assert.match(
    cleanReport.policyDependencies.canonicalClosureSha256,
    /^[A-F0-9]{64}$/u,
  );
  assert.deepEqual(
    cleanReport.policyDependencies.dependencies.map((entry) => entry.path),
    [
      LANDING_RULES_PATH,
      MARKER_GUARD_PATH,
      COMMENT_SCANNER_PATH,
      MARKER_GRAMMAR_PATH,
    ],
  );
  for (const dependency of cleanReport.policyDependencies.dependencies) {
    assert.ok(dependency.bytes > 0);
    assert.ok(dependency.canonicalBytes > 0);
    assert.match(dependency.sha256, /^[A-F0-9]{64}$/u);
    assert.match(dependency.canonicalSha256, /^[A-F0-9]{64}$/u);
  }
  assert.deepEqual(
    cleanReport.policyDependencies.dependencies[1].localDependencies,
    [COMMENT_SCANNER_PATH, MARKER_GRAMMAR_PATH],
  );
  assert.deepEqual(
    cleanReport.policyDependencies.dependencies[1].builtinDependencies,
    ["node:fs", "node:path", "node:url"],
  );
  assert.equal(cleanReport.policyDependencies.executionClosureEqual, true);
  assert.equal(
    cleanReport.policyDependencies.executionClosureSha256,
    cleanReport.policyDependencies.capturedExecutionClosureSha256,
  );
  assert.deepEqual(cleanReport.policyDependencies.executedModules, [
    LANDING_RULES_PATH,
    MARKER_GUARD_PATH,
    COMMENT_SCANNER_PATH,
    MARKER_GRAMMAR_PATH,
  ]);
  assert.equal(
    cleanReport.policyDependencies.semanticControls.requiredMarkerRules,
    17,
  );
  assert.equal(
    cleanReport.policyDependencies.semanticControls.requiredMarkerPositiveCases,
    45,
  );
  assert.equal(
    cleanReport.policyDependencies.semanticControls.requiredMarkerNegativeCases,
    77,
  );

  writeFixture(
    root,
    SOURCE_PATH,
    "// Batch 999 wired this up.\nexport const fixture = 2;\n",
  );
  const failing = commitFixture(root, 102, "ordinary failing control");
  const failingResult = verify(["--range", `${clean}..${failing}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(failingResult.status, 1, failingResult.output);
  assert.deepEqual(historyTempDirectories(), tempBaseline);
  const failingReport = reportOf(failingResult);
  assert.equal(failingReport.ok, false);
  assert.equal(failingReport.markerGuard.errors.length, 1);
  assert.equal(failingReport.markerGuard.errors[0].commit, failing);
  assert.equal(failingReport.markerGuard.errors[0].cleanListed, true);
});

test("a same-commit clean-list addition enforces that commit's marked source", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: false });
  writeFixture(
    root,
    SOURCE_PATH,
    "// Batch 999 cannot be hidden by the accompanying ratchet.\nexport const fixture = 1;\n",
  );
  writeFixture(root, CLEAN_LIST_PATH, `${SOURCE_PATH}\n`);
  const head = commitFixture(root, 101, "activate and violate clean list");

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 1, result.output);
  const report = reportOf(result);
  assert.equal(report.markerGuard.errors.length, 1);
  assert.equal(report.markerGuard.errors[0].commit, head);
  assert.equal(report.markerGuard.errors[0].file, SOURCE_PATH);
  assert.equal(report.markerGuard.errors[0].ruleId, "batch-id");
  assert.equal(report.markerGuard.errors[0].cleanListed, true);
});

test("a clean-list-only addition scans every newly covered current-tree source", (t) => {
  const { root, base } = createHistoryFixture(t, {
    cleanListed: false,
    source:
      "// Batch 999 already exists before activation.\nexport const fixture = 1;\n",
  });
  writeFixture(root, CLEAN_LIST_PATH, `${SOURCE_PATH}\n`);
  const head = commitFixture(root, 101, "activate existing marked source");

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 1, result.output);
  const report = reportOf(result);
  assert.equal(report.markerGuard.scanned, 1);
  assert.equal(report.markerGuard.pathsConsidered, 1);
  assert.deepEqual(
    report.markerGuard.errors.map((finding) => finding.file),
    [SOURCE_PATH],
  );
  assert.deepEqual(report.markerGuard.errors[0].gitStatuses, [
    "CLEAN_LIST_ADD",
  ]);
});

test("marker enforcement is author-agnostic even when landing rules skip the commit", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(
    root,
    SOURCE_PATH,
    "// Batch 999 arrived from a non-agent author.\nexport const fixture = 1;\n",
  );
  fixtureGit(root, ["add", SOURCE_PATH]);
  const head = commitStagedNonAgentFixture(root, "external source maintenance");

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 1, result.output);
  const report = reportOf(result);
  assert.equal(report.commits[0].governed, false);
  assert.equal(report.markerGuard.commits, 1);
  assert.equal(report.markerGuard.errors.length, 1);
  assert.equal(report.markerGuard.errors[0].commit, head);
});

test("a marker grammar that fails its mandatory self-test is STRUCTURAL", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  const grammarPath = "Tools/c16/lib/marker-grammar.mjs";
  const absoluteGrammar = path.join(root, ...grammarPath.split("/"));
  const grammar = readFileSync(absoluteGrammar, "utf8");
  const broken = grammar.replace(
    String.raw`pattern: /\bBatch(?:es)?[ -]\d+/g,`,
    String.raw`pattern: /\bNeverBatch(?:es)?[ -]\d+/g,`,
  );
  assert.notEqual(broken, grammar);
  writeFixture(root, grammarPath, broken);
  writeFixture(
    root,
    SOURCE_PATH,
    "// Batch 999 must not vanish behind a broken grammar.\nexport const fixture = 1;\n",
  );
  const head = commitFixture(root, 101, "break marker grammar mutant");

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 3, result.output);
  const report = reportOf(result);
  assert.equal(report.structural, true);
  assert.match(report.reason, /no longer match their own examples/);
  assert.deepEqual(report.brokenMarkerRules, ["batch-id"]);
});

test("required marker patterns remain global regular expressions", async (t) => {
  const mutants = [
    {
      name: "non-regular-expression",
      id: "batch-id",
      original: String.raw`pattern: /\bBatch(?:es)?[ -]\d+/g,`,
      replacement: 'pattern: "Batch",',
      actual: { isRegExp: false, global: false },
    },
    {
      name: "non-global-regular-expression",
      id: "campaign-row-id",
      original: String.raw`pattern: /\bC(?:\d{1,2}-\d+[A-Za-z]?|\d{1,2}-[A-Z][A-Z0-9-]*[a-z]?)\b/g,`,
      replacement: String.raw`pattern: /\bC(?:\d{1,2}-\d+[A-Za-z]?|\d{1,2}-[A-Z][A-Z0-9-]*[a-z]?)\b/,`,
      actual: { isRegExp: true, global: false },
    },
  ];
  for (const mutant of mutants) {
    await t.test(mutant.name, (subtest) => {
      const { root, base } = createHistoryFixture(subtest, {
        cleanListed: true,
      });
      writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
      const head = commitFixture(root, 101, `${mutant.name} control`);
      mutateFixturePolicy(root, MARKER_GRAMMAR_PATH, (source) =>
        source.replace(mutant.original, mutant.replacement),
      );

      const result = verify(["--range", `${base}..${head}`, "--json"], {
        repoRoot: root,
      });
      assert.equal(result.status, 3, result.output);
      const report = reportOf(result);
      const failure = report.policySemanticFailures.find(
        (entry) =>
          entry.control === `required-marker-pattern-shape:${mutant.id}`,
      );
      assert.deepEqual(failure?.expected, { isRegExp: true, global: true });
      assert.deepEqual(failure?.actual, mutant.actual);
    });
  }
});

test("campaign-row controls accept an equivalent regex source", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "equivalent campaign regex control");
  mutateFixturePolicy(root, MARKER_GRAMMAR_PATH, (source) =>
    source.replace(
      String.raw`pattern: /\bC(?:\d{1,2}-\d+[A-Za-z]?|\d{1,2}-[A-Z][A-Z0-9-]*[a-z]?)\b/g,`,
      String.raw`pattern: /\bC(?:\d{1,2}-[A-Z][A-Z0-9-]*[a-z]?|\d{1,2}-\d+[A-Za-z]?)\b/g,`,
    ),
  );

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 0, result.output);
  const report = reportOf(result);
  assert.equal(report.ok, true);
  assert.equal(report.policyDependencies.stableAtEnd, true);
});

test("campaign-row controls reject narrow and overmatching regexes", async (t) => {
  const mutants = [
    {
      name: "old-narrow-form",
      mutate(source) {
        const narrowed = source.replace(
          String.raw`pattern: /\bC(?:\d{1,2}-\d+[A-Za-z]?|\d{1,2}-[A-Z][A-Z0-9-]*[a-z]?)\b/g,`,
          String.raw`pattern: /\bC\d{1,2}-\d+[A-Za-z]?\b/g,`,
        );
        assert.notEqual(narrowed, source);
        return narrowed.replace(
          'example: "C15-G3b owns this"',
          'example: "C13-10 owns this"',
        );
      },
      control: "required-marker-positive:campaign-row-id:2",
      expected: ["C15-G6"],
      actual: [],
    },
    {
      name: "absurd-wide-form",
      mutate(source) {
        return source.replace(
          String.raw`pattern: /\bC(?:\d{1,2}-\d+[A-Za-z]?|\d{1,2}-[A-Z][A-Z0-9-]*[a-z]?)\b/g,`,
          String.raw`pattern: /\bC\S+/g,`,
        );
      },
      control: "required-marker-negative:campaign-row-id:0",
      expected: [],
      actual: ["CC-BY-SA"],
    },
  ];
  for (const mutant of mutants) {
    await t.test(mutant.name, (subtest) => {
      const { root, base } = createHistoryFixture(subtest, {
        cleanListed: true,
      });
      writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
      const head = commitFixture(root, 101, `${mutant.name} control`);
      mutateFixturePolicy(root, MARKER_GRAMMAR_PATH, mutant.mutate);

      const result = verify(["--range", `${base}..${head}`, "--json"], {
        repoRoot: root,
      });
      assert.equal(result.status, 3, result.output);
      const report = reportOf(result);
      assert.deepEqual(report.brokenMarkerRules, []);
      assert.equal(report.policyDependencies.stableAtEnd, null);
      const failure = report.policySemanticFailures.find(
        (entry) => entry.control === mutant.control,
      );
      assert.deepEqual(failure?.expected, mutant.expected);
      assert.deepEqual(failure?.actual, mutant.actual);

      const textResult = verify(["--range", `${base}..${head}`], {
        repoRoot: root,
      });
      assert.equal(textResult.status, 3, textResult.output);
      assert.equal(
        textResult.output.split(/\r?\n/u)[0],
        "verify-landing: STRUCTURAL — executable policy preflight: executable policy failed its immutable semantic controls",
      );
    });
  }
});

test("new marker controls reject narrowing and widening", async (t) => {
  const mutants = [
    {
      name: "parity-report-row-id narrowing",
      id: "parity-report-row-id",
      pattern: String.raw`/\bQ\d{1,2}-[A-Z][A-Z-]+\b/g`,
      control: "required-marker-positive:parity-report-row-id:1",
      text: "Q1-AA and Q99-Z9-CORE",
      expected: ["Q1-AA", "Q99-Z9-CORE"],
      actual: ["Q1-AA"],
    },
    {
      name: "parity-report-row-id widening",
      id: "parity-report-row-id",
      pattern: String.raw`/\bQ\d{1,3}-[A-Z][A-Z0-9-]+\b/g`,
      control: "required-marker-negative:parity-report-row-id:0",
      text: "Q123-PLAIN",
      expected: [],
      actual: ["Q123-PLAIN"],
    },
    {
      name: "all-caps-fix-label narrowing",
      id: "all-caps-fix-label",
      pattern: String.raw`/(?<![A-Z0-9_-])(?!(?:NEW|BUG|EPIC|FIX)-)(?!(?:CC-BY-SA|YYYY-MM-DD)(?![A-Z0-9_-]))[A-Z][A-Z0-9]+(?:-[A-Z]{2,}){2,}(?![A-Z0-9_-])/g`,
      control: "required-marker-positive:all-caps-fix-label:1",
      text: "PARITY-F16-POSTPROCESS",
      expected: ["PARITY-F16-POSTPROCESS"],
      actual: [],
    },
    {
      name: "all-caps-fix-label widening",
      id: "all-caps-fix-label",
      pattern: String.raw`/(?<![A-Z0-9_-])(?!(?:NEW|BUG|EPIC|FIX)-)(?!(?:CC-BY-SA|YYYY-MM-DD)(?![A-Z0-9_-]))[A-Z0-9][A-Z0-9]+(?:-[A-Z0-9]{2,}){2,}(?![A-Z0-9_-])/g`,
      control: "required-marker-negative:all-caps-fix-label:1",
      text: "2026-05-02",
      expected: [],
      actual: ["2026-05-02"],
    },
    {
      name: "fork-id narrowing",
      id: "fork-id",
      pattern: String.raw`/\bFORK-\d{2}\b/g`,
      control: "required-marker-positive:fork-id:1",
      text: "FORK-99 and FORK-123",
      expected: ["FORK-99", "FORK-123"],
      actual: ["FORK-99"],
    },
    {
      name: "fork-id widening",
      id: "fork-id",
      pattern: String.raw`/FORK-\d+\b/g`,
      control: "required-marker-negative:fork-id:4",
      text: "XFORK-34",
      expected: [],
      actual: ["FORK-34"],
    },
  ];

  for (const mutant of mutants) {
    await t.test(mutant.name, (subtest) => {
      const { root, base } = createHistoryFixture(subtest, {
        cleanListed: true,
      });
      writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
      const head = commitFixture(root, 101, `${mutant.name} control`);
      mutateFixturePolicy(root, MARKER_GRAMMAR_PATH, (source) =>
        replaceMarkerRulePattern(source, mutant.id, mutant.pattern, mutant),
      );

      const result = verify(["--range", `${base}..${head}`, "--json"], {
        repoRoot: root,
      });
      assert.equal(result.status, 3, result.output);
      const report = reportOf(result);
      assert.deepEqual(report.brokenMarkerRules, []);
      assert.equal(report.policyDependencies.stableAtEnd, null);
      const failure = report.policySemanticFailures.find(
        (entry) => entry.control === mutant.control,
      );
      assert.deepEqual(failure?.expected, mutant.expected);
      assert.deepEqual(failure?.actual, mutant.actual);
    });
  }
});

test("a non-array marker-rules export is STRUCTURAL, not a verifier error", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "non-array marker-rules control");
  mutateFixturePolicy(
    root,
    MARKER_GRAMMAR_PATH,
    replaceMarkerRulesWithNonArray,
  );
  const range = `${base}..${head}`;

  const jsonResult = verify(["--range", range, "--json"], { repoRoot: root });
  assert.equal(jsonResult.status, 3, jsonResult.output);
  const report = reportOf(jsonResult);
  assert.equal(report.structural, true);
  assert.match(report.reason, /immutable semantic controls/);
  assert.deepEqual(report.brokenMarkerRules, []);
  assert.deepEqual(report.markerRuleIds, []);
  assert.equal(report.policyDependencies.stableAtLoad, true);
  assert.equal(report.policyDependencies.stableAtEnd, null);
  assert.deepEqual(report.policySemanticFailures, [
    {
      control: "marker-rules-shape",
      expected: "array",
      actual: "object",
    },
  ]);

  const textResult = verify(["--range", range], { repoRoot: root });
  assert.equal(textResult.status, 3, textResult.output);
  assert.match(
    textResult.output,
    /^verify-landing: STRUCTURAL — executable policy preflight: executable policy failed its immutable semantic controls$/mu,
  );
  assert.match(textResult.output, /load=stable; end=not-reached/u);
  assert.doesNotMatch(textResult.output, /end=DRIFT|FAILED TO RUN/u);
});

test("deleting the complete batch-id rule in the selected marker commit is STRUCTURAL", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  mutateFixturePolicy(root, MARKER_GRAMMAR_PATH, (source) =>
    deleteMarkerRule(source, "batch-id"),
  );
  writeFixture(
    root,
    SOURCE_PATH,
    "// Batch 999 must not pass after its entire rule and example disappear.\nexport const fixture = 1;\n",
  );
  const head = commitFixture(root, 101, "delete whole marker rule mutant");
  const requestedRange = `${base}..${head}`;

  const result = verify(["--range", requestedRange, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 3, result.output);
  const report = reportOf(result);
  assert.equal(report.structural, true);
  assert.equal(report.requestedRange, requestedRange);
  assert.match(report.reason, /immutable semantic controls/);
  assert.deepEqual(report.brokenMarkerRules, []);
  assert.ok(
    report.policySemanticFailures.some(
      (failure) => failure.control === "required-marker-rule:batch-id",
    ),
  );
  assert.doesNotMatch(result.output, /verify-landing: PASS/);
});

test("a fixed bad range cannot flip to PASS under a dirty rule deletion", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(
    root,
    SOURCE_PATH,
    "// Batch 999 is immutable bad-range content.\nexport const fixture = 1;\n",
  );
  const head = commitFixture(root, 101, "fixed bad range control");
  const requestedRange = `${base}..${head}`;
  const measured = verify(["--range", requestedRange, "--json"], {
    repoRoot: root,
  });
  assert.equal(measured.status, 1, measured.output);
  assert.equal(reportOf(measured).markerGuard.errors[0].ruleId, "batch-id");

  mutateFixturePolicy(root, MARKER_GRAMMAR_PATH, (source) =>
    deleteMarkerRule(source, "batch-id"),
  );
  const dirtyPolicy = verify(["--range", requestedRange, "--json"], {
    repoRoot: root,
  });
  assert.equal(dirtyPolicy.status, 3, dirtyPolicy.output);
  const report = reportOf(dirtyPolicy);
  assert.equal(report.requestedRange, requestedRange);
  assert.equal(report.structural, true);
  assert.ok(
    report.policySemanticFailures.some(
      (failure) => failure.control === "required-marker-rule:batch-id",
    ),
  );
  assert.doesNotMatch(dirtyPolicy.output, /verify-landing: PASS/);
});

test("coordinated marker-pattern weakening remains STRUCTURAL", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "marker weakening control");
  mutateFixturePolicy(root, MARKER_GRAMMAR_PATH, (source) => {
    const weakened = source.replace(
      String.raw`pattern: /\bBatch(?:es)?[ -]\d+/g,`,
      String.raw`pattern: /\bBatch 731\b/g,`,
    );
    assert.match(weakened, /example: "landed in Batch 731"/u);
    return weakened;
  });

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 3, result.output);
  const report = reportOf(result);
  assert.deepEqual(report.brokenMarkerRules, []);
  assert.ok(
    report.policySemanticFailures.some(
      (failure) => failure.control === "required-marker-positive:batch-id:1",
    ),
  );
});

test("reordering required marker rules is STRUCTURAL", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "marker reorder control");
  mutateFixturePolicy(root, MARKER_GRAMMAR_PATH, (source) => {
    const batch = markerRuleSpan(source, "batch-id");
    const campaign = markerRuleSpan(source, "campaign-row-id");
    assert.equal(batch.end, campaign.start);
    return (
      source.slice(0, batch.start) +
      campaign.text +
      batch.text +
      source.slice(campaign.end)
    );
  });

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 3, result.output);
  const report = reportOf(result);
  assert.deepEqual(report.brokenMarkerRules, []);
  assert.ok(
    report.policySemanticFailures.some(
      (failure) => failure.control === "required-marker-rule-order",
    ),
  );
});

test("an add-only marker rule without a behavioral control fails closed", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "add-only grammar inverse control");

  const baseline = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(baseline.status, 0, baseline.output);
  assert.equal(
    reportOf(baseline).policyDependencies.semanticControls.requiredMarkerRules,
    17,
  );

  mutateFixturePolicy(root, MARKER_GRAMMAR_PATH, addMarkerRule);

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 3, result.output);
  const report = reportOf(result);
  assert.equal(report.structural, true);
  assert.equal(report.policyDependencies.stableAtEnd, null);
  assert.equal(report.markerRuleIds.at(-1), "add-only-control");
  const coverage = report.policySemanticFailures.find(
    (failure) => failure.control === "marker-rule-control-coverage",
  );
  assert.equal(
    coverage?.expected,
    'marker rule "add-only-control" has a behavioral control',
  );
  assert.equal(
    coverage?.actual,
    'marker rule "add-only-control" is uncontrolled; a control must be added for this rule id',
  );
  assert.doesNotMatch(result.output, /verify-landing: PASS/u);
});

test("LF-canonical policy identity is portable across worktree line endings", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "policy line-ending control");
  const requestedRange = `${base}..${head}`;
  const beforeResult = verify(["--range", requestedRange, "--json"], {
    repoRoot: root,
  });
  assert.equal(beforeResult.status, 0, beforeResult.output);
  const before = reportOf(beforeResult).policyDependencies;

  for (const relative of [
    LANDING_RULES_PATH,
    MARKER_GUARD_PATH,
    COMMENT_SCANNER_PATH,
    MARKER_GRAMMAR_PATH,
  ]) {
    mutateFixturePolicy(root, relative, (source) => {
      const lf = source.replace(/\r\n?/g, "\n");
      return source.includes("\r\n") ? lf : lf.replace(/\n/g, "\r\n");
    });
  }
  const afterResult = verify(["--range", requestedRange, "--json"], {
    repoRoot: root,
  });
  assert.equal(afterResult.status, 0, afterResult.output);
  const after = reportOf(afterResult).policyDependencies;
  assert.notEqual(after.closureSha256, before.closureSha256);
  assert.equal(after.canonicalClosureSha256, before.canonicalClosureSha256);
  assert.deepEqual(
    after.dependencies.map(({ path: file, canonicalSha256 }) => ({
      file,
      canonicalSha256,
    })),
    before.dependencies.map(({ path: file, canonicalSha256 }) => ({
      file,
      canonicalSha256,
    })),
  );
});

test("landing, guard, and scanner behavioral drift are each STRUCTURAL", async (t) => {
  const mutants = [
    {
      name: "landing-rules",
      file: LANDING_RULES_PATH,
      mutate(source) {
        return source.replace(
          String.raw`export const BATCH_SUBJECT_PATTERN = /^Batch (\d{1,6}): (\S.*)$/;`,
          String.raw`export const BATCH_SUBJECT_PATTERN = /^Release (\d{1,6}): (\S.*)$/;`,
        );
      },
      control: "landing-rules-positive",
    },
    {
      name: "comment-marker-guard",
      file: MARKER_GUARD_PATH,
      mutate(source) {
        return source.replace(
          "for (const comment of extractComments(source, language)) {",
          "for (const comment of []) {",
        );
      },
      control: "marker-scan-comment-vs-literal",
    },
    {
      name: "comment-scanner",
      file: COMMENT_SCANNER_PATH,
      mutate(source) {
        return source.replace(
          '.filter((segment) => segment.kind === "comment")',
          ".filter(() => false)",
        );
      },
      control: "marker-scan-comment-vs-literal",
    },
  ];
  for (const mutant of mutants) {
    await t.test(mutant.name, (subtest) => {
      const { root, base } = createHistoryFixture(subtest, {
        cleanListed: true,
      });
      writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
      const head = commitFixture(root, 101, `${mutant.name} drift control`);
      mutateFixturePolicy(root, mutant.file, mutant.mutate);

      const result = verify(["--range", `${base}..${head}`, "--json"], {
        repoRoot: root,
      });
      assert.equal(result.status, 3, result.output);
      const report = reportOf(result);
      assert.ok(
        report.policySemanticFailures.some(
          (failure) => failure.control === mutant.control,
        ),
        result.output,
      );
    });
  }
});

test("an unexpected local policy dependency is STRUCTURAL", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "unexpected dependency control");
  mutateFixturePolicy(
    root,
    MARKER_GRAMMAR_PATH,
    (source) => `${source}\nimport "./unexpected-policy.mjs";\n`,
  );

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 3, result.output);
  const report = reportOf(result);
  assert.match(report.reason, /dependency closure/);
  assert.equal(report.policyDependencies.stableAtEnd, null);
  assert.deepEqual(report.policyDependencyGraphFailures[0].actual, [
    {
      kind: "local",
      form: "static",
      specifier: "./unexpected-policy.mjs",
      target: "Tools/c16/lib/unexpected-policy.mjs",
    },
  ]);
});

test("external, transitive, and unknown dynamic policy edges fail closed before execution", async (t) => {
  const cases = [
    {
      name: "absolute external ESM",
      file: MARKER_GRAMMAR_PATH,
      source(moduleUrl) {
        return `\nimport ${JSON.stringify(moduleUrl)};\n`;
      },
      reason: /forbidden external or unbound module edge/,
    },
    {
      name: "bare package",
      file: MARKER_GRAMMAR_PATH,
      source() {
        return '\nimport "fixture-external-policy";\n';
      },
      reason: /forbidden external or unbound module edge/,
    },
    {
      name: "data URL",
      file: MARKER_GRAMMAR_PATH,
      source() {
        return '\nimport "data:text/javascript,export default true";\n';
      },
      reason: /forbidden external or unbound module edge/,
    },
    {
      name: "network URL",
      file: MARKER_GRAMMAR_PATH,
      source() {
        return '\nimport "https://example.invalid/policy.mjs";\n';
      },
      reason: /forbidden external or unbound module edge/,
    },
    {
      name: "transitive external ESM",
      file: COMMENT_SCANNER_PATH,
      source(moduleUrl) {
        return `\nimport ${JSON.stringify(moduleUrl)};\n`;
      },
      reason: /forbidden external or unbound module edge/,
    },
    {
      name: "unknown dynamic expression",
      file: MARKER_GRAMMAR_PATH,
      source(moduleUrl) {
        return `\nconst externalPolicyTarget = ${JSON.stringify(moduleUrl)};\nawait import(externalPolicyTarget);\n`;
      },
      reason: /unknown dynamic module edge/,
    },
  ];

  for (const control of cases) {
    await t.test(control.name, (subtest) => {
      const { root, base } = createHistoryFixture(subtest, {
        cleanListed: true,
      });
      const { moduleUrl, sentinel } = installExternalPolicy(root);
      writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
      const head = commitFixture(root, 101, `${control.name} control`);
      mutateFixturePolicy(
        root,
        control.file,
        (source) => `${source}${control.source(moduleUrl)}`,
      );

      const result = verify(["--range", `${base}..${head}`, "--json"], {
        repoRoot: root,
      });
      assert.equal(result.status, 3, result.output);
      const report = reportOf(result);
      assert.match(report.reason, control.reason);
      assert.throws(() => readFileSync(sentinel), { code: "ENOENT" });
      assert.doesNotMatch(result.output, /verify-landing: PASS/);
    });
  }
});

test("runtime module hooks reject an external ESM edge hidden from static syntax", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  const { moduleUrl, sentinel } = installExternalPolicy(root);
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "runtime external policy control");
  const dynamicSource = `import(${JSON.stringify(moduleUrl)})`;
  mutateFixturePolicy(
    root,
    MARKER_GRAMMAR_PATH,
    (source) => `${source}\nawait eval(${JSON.stringify(dynamicSource)});\n`,
  );

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 3, result.output);
  const report = reportOf(result);
  assert.match(
    report.reason,
    /snapshotted executable policy could not be loaded/,
  );
  assert.match(report.policyLoadError, /undeclared module edge/);
  assert.equal(report.policyDependencies.stableAtEnd, null);
  assert.throws(() => readFileSync(sentinel), { code: "ENOENT" });
});

test("a declared captured literal-dynamic edge joins the exact execution closure", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "declared dynamic policy control");
  mutateFixturePolicy(
    root,
    MARKER_GRAMMAR_PATH,
    (source) => `${source}\nawait import("./comment-scanner.mjs");\n`,
  );
  mutateFixturePolicy(root, "Tools/verify-landing-compliance.mjs", (source) =>
    source.replace(
      /\x20{2}Object\.freeze\(\{\r?\n\x20{4}path: "Tools\/c16\/lib\/marker-grammar\.mjs",\r?\n\x20{4}edges: Object\.freeze\(\[\]\),\r?\n\x20{2}\}\),/u,
      `  Object.freeze({\n    path: "Tools/c16/lib/marker-grammar.mjs",\n    edges: Object.freeze([\n      Object.freeze({\n        kind: "local",\n        form: "dynamic",\n        specifier: "./comment-scanner.mjs",\n        target: "Tools/c16/lib/comment-scanner.mjs",\n      }),\n    ]),\n  }),`,
    ),
  );

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 0, result.output);
  const report = reportOf(result);
  assert.equal(report.policyDependencies.executionClosureEqual, true);
  assert.equal(
    report.policyDependencies.executionClosureSha256,
    report.policyDependencies.capturedExecutionClosureSha256,
  );
  assert.ok(
    report.policyDependencies.executedModuleEdges.some(
      (edge) =>
        edge.parent === MARKER_GRAMMAR_PATH &&
        edge.form === "dynamic" &&
        edge.target === COMMENT_SCANNER_PATH,
    ),
  );
});

test("policy dependency races at start and terminal boundaries are STRUCTURAL", async (t) => {
  for (const phase of ["start", "end"]) {
    await t.test(phase, (subtest) => {
      const { root, base } = createHistoryFixture(subtest, {
        cleanListed: true,
      });
      writeFixture(
        root,
        SOURCE_PATH,
        phase === "end"
          ? "// Batch 999 remains visible when terminal policy drift invalidates the run.\nexport const fixture = 1;\n"
          : "export const fixture = 1;\n",
      );
      const head = commitFixture(root, 101, `${phase} policy race control`);

      const result = verify(["--range", `${base}..${head}`, "--json"], {
        repoRoot: root,
        policyRacePhase: phase,
      });
      assert.equal(result.status, 3, result.output);
      const report = reportOf(result);
      assert.equal(report.structural, true);
      assert.match(report.reason, /changed/);
      assert.equal(
        report.policyDependencies.stableAtEnd,
        phase === "end" ? false : null,
      );
      assert.ok(
        report.policyDependencyDrift.some(
          (entry) => entry.path === LANDING_RULES_PATH,
        ),
      );
      if (phase === "end") {
        assert.equal(report.measuredCommitViolations, 0);
        assert.equal(report.measuredMarkerErrors, 1);
      }
      assert.doesNotMatch(result.output, /verify-landing: PASS/);

      const textResult = verify(["--range", `${base}..${head}`], {
        repoRoot: root,
        policyRacePhase: phase,
      });
      assert.equal(textResult.status, 3, textResult.output);
      if (phase === "end") {
        assert.match(textResult.output, /load=stable; end=DRIFT/u);
        assert.doesNotMatch(textResult.output, /end=not-reached/u);
      } else {
        assert.match(textResult.output, /end=not-reached/u);
        assert.doesNotMatch(textResult.output, /end=DRIFT/u);
      }
    });
  }
});

test("a terminal policy-graph mutation remains genuine DRIFT", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "terminal policy graph control");
  const range = `${base}..${head}`;

  const jsonResult = verify(["--range", range, "--json"], {
    repoRoot: root,
    policyRacePhase: "end-graph",
  });
  assert.equal(jsonResult.status, 3, jsonResult.output);
  const report = reportOf(jsonResult);
  assert.equal(report.structural, true);
  assert.match(
    report.reason,
    /became unavailable or changed shape during verification/u,
  );
  assert.equal(report.policyDependencies.stableAtLoad, true);
  assert.equal(report.policyDependencies.stableAtEnd, false);
  assert.match(
    report.terminalPolicyError,
    /dependency closure no longer matches its required graph/u,
  );
  assert.ok(
    report.policyDependencyGraphFailures.some((failure) =>
      failure.actual.some(
        (edge) =>
          edge.kind === "local" &&
          edge.form === "static" &&
          edge.specifier === "./unexpected-policy.mjs" &&
          edge.target === "Tools/unexpected-policy.mjs",
      ),
    ),
  );

  const textResult = verify(["--range", range], {
    repoRoot: root,
    policyRacePhase: "end-graph",
  });
  assert.equal(textResult.status, 3, textResult.output);
  assert.match(
    textResult.output,
    /^verify-landing: STRUCTURAL — .*: executable policy dependencies became unavailable or changed shape during verification$/mu,
  );
  assert.match(textResult.output, /load=stable; end=DRIFT/u);
  assert.doesNotMatch(textResult.output, /end=not-reached/u);
});

test("policy execution is bound to private captured bytes across a load-time ABA", (t) => {
  const { root } = createHistoryFixture(t, { cleanListed: true });
  const policyPath = path.join(root, ...LANDING_RULES_PATH.split("/"));
  const originalPolicy = readFileSync(policyPath);

  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  commitFixture(root, 500, "establish canonical policy baseline");
  writeFixture(root, SOURCE_PATH, "export const fixture = 2;\n");
  const base = commitFixture(root, 100, "range boundary below baseline");
  writeFixture(root, SOURCE_PATH, "export const fixture = 3;\n");
  const head = commitFixture(root, 101, "load-time policy ABA mutant");

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
    policyRacePhase: "aba",
  });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /^\s*\{/u, result.output);
  assert.deepEqual(readFileSync(policyPath), originalPolicy);
  assert.match(
    readFileSync(path.join(root, ".fixture", "policy-aba-ran"), "utf8"),
    /highestBatchIn weakened/,
  );

  const report = reportOf(result);
  assert.equal(report.highestPushedBatch, 500);
  assert.equal(report.policyDependencies.stableAtLoad, true);
  assert.equal(report.policyDependencies.stableAtEnd, true);
  assert.equal(
    report.policyDependencies.executionMode,
    "private-byte-snapshot+registered-module-hooks",
  );
  assert.equal(
    report.policyDependencies.executionClosureSha256,
    report.policyDependencies.capturedExecutionClosureSha256,
  );
  assert.equal(report.policyDependencies.executionClosureEqual, true);
  assert.ok(
    report.commits[0].verdicts.some(
      (verdict) =>
        verdict.rule === "batch-monotonic" && verdict.status === "fail",
    ),
  );
});

test("Git replacement refs cannot substitute a clean tree for the selected bad commit", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(
    root,
    SOURCE_PATH,
    "// Batch 999 belongs to the original object.\nexport const fixture = 1;\n",
  );
  const bad = commitFixture(root, 101, "replacement-object mutant");

  writeFixture(root, SOURCE_PATH, "export const fixture = 2;\n");
  fixtureGit(root, ["add", SOURCE_PATH]);
  const replacementTree = fixtureGit(root, ["write-tree"]);
  const replacement = fixtureGit(
    root,
    [
      "commit-tree",
      replacementTree,
      "-p",
      base,
      "-m",
      "Batch 101: clean replacement object",
      "-m",
      "Hermetic verifier history fixture.",
      "-m",
      "Co-Authored-By: Fixture Reviewer <reviewer@example.test>",
    ],
    {
      GIT_AUTHOR_DATE: "2026-08-16T00:01:00-04:00",
      GIT_COMMITTER_DATE: "2026-08-16T00:01:00-04:00",
    },
  );
  fixtureGit(root, ["replace", bad, replacement]);

  assert.doesNotMatch(
    fixtureGit(root, ["show", `${bad}:${SOURCE_PATH}`]),
    /Batch 999/,
  );
  assert.match(
    fixtureGit(root, ["show", `${bad}:${SOURCE_PATH}`], {
      GIT_NO_REPLACE_OBJECTS: "1",
    }),
    /Batch 999/,
  );

  const result = verify(["--range", `${base}..${bad}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 1, result.output);
  const report = reportOf(result);
  assert.equal(report.rangeHead, bad);
  assert.equal(report.historySubject.replacementRefsIgnored, 1);
  assert.equal(report.markerGuard.errors.length, 1);
  assert.equal(report.markerGuard.errors[0].commit, bad);
  assert.equal(report.markerGuard.errors[0].ruleId, "batch-id");
});

test("active legacy Git graft state is STRUCTURAL", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "legacy graft mutant");
  writeFixture(root, ".git/info/grafts", `${head} ${base}\n`);

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 3, result.output);
  const report = reportOf(result);
  assert.equal(report.structural, true);
  assert.equal(report.range, `${base}..${head}`);
  assert.equal(report.historySubject.legacyGrafts, 1);
  assert.match(report.reason, /legacy Git graft state/);
});

test("transient source and private shallow/graft state cannot hide the captured baseline", async (t) => {
  const { root } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  commitFixture(root, 500, "establish transient-history baseline");
  writeFixture(root, SOURCE_PATH, "export const fixture = 2;\n");
  const base = commitFixture(root, 100, "range boundary below baseline");
  writeFixture(root, SOURCE_PATH, "export const fixture = 3;\n");
  const head = commitFixture(root, 101, "transient history state mutant");
  const args = ["--range", `${base}..${head}`, "--json"];

  const assertCanonicalRed = (result) => {
    assert.equal(result.status, 1, result.output);
    const report = reportOf(result);
    assert.equal(report.highestPushedBatch, 500);
    assert.equal(
      report.historySubject.mode,
      "private-bare-alternate+content-addressed-dag-snapshot",
    );
    assert.equal(report.historySubject.shallow, false);
    assert.equal(report.historySubject.legacyGrafts, 0);
    assert.equal(report.historySubject.rangeBase, base);
    assert.equal(report.historySubject.rangeHead, head);
    assert.match(report.historySubject.subjectSha256, /^[A-F0-9]{64}$/u);
    assert.match(
      report.historySubject.ancestryClosureSha256,
      /^[A-F0-9]{64}$/u,
    );
    assert.ok(report.historySubject.ancestryCommits >= 3);
    assert.equal(report.historySubject.selectedCommits, 1);
    assert.ok(
      report.commits[0].verdicts.some(
        (verdict) =>
          verdict.rule === "batch-monotonic" && verdict.status === "fail",
      ),
    );
  };

  assertCanonicalRed(verify(args, { repoRoot: root }));
  for (const phase of [
    "shallow",
    "graft",
    "private-shallow",
    "private-graft",
    "private-config",
  ]) {
    await t.test(
      `${phase} is active during both candidate-history reads`,
      () => {
        const result = verify(args, {
          repoRoot: root,
          historyRacePhase: phase,
        });
        assertCanonicalRed(result);
        assert.equal(
          readFileSync(
            path.join(root, ".fixture", `history-race-${phase}`),
            "utf8",
          ).trim(),
          `baseline ${base}\nselected ${phase === "private-config" ? "config-active" : base}`,
        );
        assert.equal(
          fixtureGit(root, ["rev-parse", "--is-shallow-repository"]),
          "false",
        );
        assert.throws(
          () => readFileSync(path.join(root, ".git", "info", "grafts")),
          { code: "ENOENT" },
        );
      },
    );
  }

  const refResult = verify(["--range", `${base}..HEAD`, "--json"], {
    repoRoot: root,
    historyRacePhase: "private-ref",
  });
  assertCanonicalRed(refResult);
  assert.match(
    readFileSync(
      path.join(root, ".fixture", "history-race-private-ref"),
      "utf8",
    ),
    new RegExp(`baseline ${head}\\^\\{commit\\}`),
  );
  assert.equal(fixtureGit(root, ["rev-parse", "HEAD"]), head);
});

test("an ordinary Git tool failure remains ERROR, not STRUCTURAL", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "ordinary Git failure control");
  fixtureGit(root, ["config", "core.repositoryformatversion", "99"]);

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /FAILED TO RUN/);
  assert.doesNotMatch(result.output, /STRUCTURAL/);
});

test("ordinary Git faults remain ERROR at every historical command phase", async (t) => {
  const phases = [
    "select-range",
    "endpoint-resolution",
    "object-existence",
    "parent-read",
    "baseline-log",
    "selected-range-log",
  ];
  for (const phase of phases) {
    await t.test(phase, (subtest) => {
      const { root, base } = createHistoryFixture(subtest, {
        cleanListed: true,
      });
      if (phase === "select-range") {
        configureFixtureUpstream(root, base);
      }
      writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
      const head = commitFixture(root, 101, `${phase} fault control`);
      const args =
        phase === "select-range"
          ? ["--json"]
          : ["--range", `${base}..${head}`, "--json"];

      const result = verify(args, { repoRoot: root, gitFaultPhase: phase });
      assert.equal(result.status, 2, result.output);
      assert.match(result.output, /FAILED TO RUN/);
      assert.match(result.output, new RegExp(phase));
      assert.doesNotMatch(result.output, /STRUCTURAL/);
    });
  }
});

test(
  "Windows-style CLI and repo-root filesystem paths remain supported",
  { skip: process.platform !== "win32" },
  (t) => {
    const { root, base } = createHistoryFixture(t, { cleanListed: true });
    writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
    const head = commitFixture(root, 101, "Windows path control");
    const windowsRoot = `${path.win32.normalize(root)}\\.`;
    assert.ok(path.win32.isAbsolute(windowsRoot));

    const result = verify(["--range", `${base}..${head}`, "--json"], {
      repoRoot: windowsRoot,
    });
    assert.equal(result.status, 0, result.output);
    assert.equal(reportOf(result).rangeHead, head);
  },
);

test("an unrelated root commit is scanned with an empty parent ratchet", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  const tree = fixtureGit(root, ["write-tree"]);
  const messagePath = ".fixture/root-message.txt";
  writeFixture(
    root,
    messagePath,
    [
      "Batch 101: orphan root control",
      "",
      "Hermetic verifier history fixture.",
      "",
      "Co-Authored-By: Fixture Reviewer <reviewer@example.test>",
      "",
    ].join("\n"),
  );
  const orphanRoot = fixtureGit(
    root,
    ["commit-tree", tree, "-F", messagePath],
    {
      GIT_AUTHOR_DATE: "2026-08-16T00:01:00-04:00",
      GIT_COMMITTER_DATE: "2026-08-16T00:01:00-04:00",
    },
  );

  const result = verify(["--range", `${base}..${orphanRoot}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 0, result.output);
  const report = reportOf(result);
  assert.equal(report.commits.length, 1);
  assert.equal(report.commits[0].sha, orphanRoot);
  assert.equal(report.markerGuard.commits, 1);
  assert.equal(report.markerGuard.scanned, 1);
  assert.equal(report.markerGuard.ratchetErrors, 0);
});

test("a governed commit cannot remove its parent ratchet and add a marker", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, CLEAN_LIST_PATH, "# unauthorized weakening\n");
  writeFixture(
    root,
    SOURCE_PATH,
    "// Batch 999 tried to weaken its own gate.\nexport const fixture = 1;\n",
  );
  const weakened = commitFixture(root, 101, "attempt ratchet weakening");

  const result = verify(["--range", `${base}..${weakened}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 1, result.output);
  const report = reportOf(result);
  assert.equal(report.markerGuard.ratchetErrors, 1);
  assert.deepEqual(
    report.markerGuard.errors.map((finding) => finding.ruleId).sort(),
    ["batch-id", "clean-list-ratchet-removal"],
  );
  assert.ok(
    report.markerGuard.errors.every((finding) => finding.commit === weakened),
  );
});

test("a newly added ratchet entry activates in its own commit and descendants", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: false });
  writeFixture(
    root,
    CLEAN_LIST_PATH,
    `# activate in this commit\n${SOURCE_PATH}\n`,
  );
  writeFixture(
    root,
    SOURCE_PATH,
    "// Batch 999 is immediately covered.\nexport const fixture = 1;\n",
  );
  const added = commitFixture(root, 101, "add future ratchet entry");

  const additionResult = verify(["--range", `${base}..${added}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(additionResult.status, 1, additionResult.output);
  const additionReport = reportOf(additionResult);
  assert.equal(additionReport.markerGuard.errors.length, 1);
  assert.equal(additionReport.markerGuard.errors[0].commit, added);
  assert.equal(additionReport.markerGuard.errors[0].ruleId, "batch-id");
  assert.equal(additionReport.markerGuard.warnings.length, 0);

  writeFixture(
    root,
    SOURCE_PATH,
    "// Batch 999 is now parent-enforced.\nexport const fixture = 2;\n",
  );
  const descendant = commitFixture(root, 102, "exercise active ratchet");
  const descendantResult = verify(
    ["--range", `${added}..${descendant}`, "--json"],
    { repoRoot: root },
  );
  assert.equal(descendantResult.status, 1, descendantResult.output);
  const descendantReport = reportOf(descendantResult);
  assert.equal(descendantReport.markerGuard.errors.length, 1);
  assert.equal(descendantReport.markerGuard.errors[0].commit, descendant);
  assert.equal(descendantReport.markerGuard.errors[0].ruleId, "batch-id");
});

test("a marker introduced and removed later remains attributed to its commit", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(
    root,
    SOURCE_PATH,
    "// Batch 999 was transient.\nexport const fixture = 1;\n",
  );
  const introduced = commitFixture(root, 101, "introduce transient marker");
  writeFixture(root, SOURCE_PATH, "export const fixture = 2;\n");
  const removed = commitFixture(root, 102, "remove transient marker");

  const result = verify(["--range", `${base}..${removed}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 1, result.output);
  const report = reportOf(result);
  assert.equal(report.markerGuard.scanned, 2);
  assert.equal(report.markerGuard.errors.length, 1);
  assert.equal(report.markerGuard.errors[0].commit, introduced);
  assert.equal(report.markerGuard.errors[0].file, SOURCE_PATH);
});

test("a marker in a path added and deleted inside the range remains visible", (t) => {
  const { root, base } = createHistoryFixture(t, {
    cleanListed: true,
    source: null,
  });
  writeFixture(
    root,
    SOURCE_PATH,
    "// Batch 999 existed briefly.\nexport const fixture = 1;\n",
  );
  const added = commitFixture(root, 101, "add temporary path");
  unlinkSync(path.join(root, ...SOURCE_PATH.split("/")));
  const deleted = commitFixture(root, 102, "delete temporary path");

  const result = verify(["--range", `${base}..${deleted}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 1, result.output);
  const report = reportOf(result);
  assert.equal(report.markerGuard.pathsConsidered, 2);
  assert.equal(report.markerGuard.scanned, 1);
  assert.equal(report.markerGuard.deleted, 1);
  assert.equal(report.markerGuard.errors.length, 1);
  assert.equal(report.markerGuard.errors[0].commit, added);
});

test("a genuine D-status source deletion is counted without requiring a blob", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  unlinkSync(path.join(root, ...SOURCE_PATH.split("/")));
  const deleted = commitFixture(root, 101, "delete source path control");

  const result = verify(["--range", `${base}..${deleted}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 0, result.output);
  const report = reportOf(result);
  assert.equal(report.markerGuard.pathsConsidered, 1);
  assert.equal(report.markerGuard.scanned, 0);
  assert.equal(report.markerGuard.deleted, 1);
  assert.equal(report.markerGuard.errors.length, 0);
});

test("genuine historical clean-list absence has explicit empty-policy semantics", (t) => {
  const { root, base } = createHistoryFixture(t, {
    cleanListPresent: false,
  });
  writeFixture(
    root,
    SOURCE_PATH,
    "// Batch 999 predates policy creation.\nexport const fixture = 1;\n",
  );
  const head = commitFixture(root, 101, "exercise absent policy control");

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 0, result.output);
  const report = reportOf(result);
  assert.equal(report.markerGuard.policyAbsent, 2);
  assert.equal(report.markerGuard.errors.length, 0);
  assert.equal(report.markerGuard.warnings.length, 1);
  assert.equal(report.markerGuard.warnings[0].cleanListed, false);
});

test("an unavailable selected commit tree is STRUCTURAL, not ERROR", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "missing selected tree mutant");
  const tree = fixtureGit(root, ["show", "-s", "--format=%T", head]);
  removeFixtureObject(root, tree);

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 3, result.output);
  const report = reportOf(result);
  assert.equal(report.structural, true);
  assert.equal(report.unavailableTrees.length, 1);
  assert.equal(report.unavailableTrees[0].revision, head);
  assert.equal(report.unavailableTrees[0].object, tree);
  assert.ok(report.unavailableTrees[0].roles.includes("range-head"));
  assert.ok(report.unavailableTrees[0].roles.includes("selected-commit"));
  assert.match(report.reason, /tree objects are unavailable/);
  assert.doesNotMatch(result.output, /FAILED TO RUN/);
});

test("unavailable intermediate and boundary-parent trees remain STRUCTURAL", async (t) => {
  const cases = [
    {
      name: "intermediate selected tree",
      prepare(root, base) {
        writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
        const target = commitFixture(root, 101, "intermediate tree target");
        writeFixture(root, SOURCE_PATH, "export const fixture = 2;\n");
        const head = commitFixture(root, 102, "advance beyond missing tree");
        return { head, target, expectedRoles: ["selected-commit"] };
      },
    },
    {
      name: "range-base boundary parent tree",
      prepare(root, base) {
        writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
        const head = commitFixture(root, 101, "advance from boundary parent");
        return {
          head,
          target: base,
          expectedRoles: ["range-base", "parent"],
        };
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, (subtest) => {
      const { root, base } = createHistoryFixture(subtest, {
        cleanListed: true,
      });
      const { head, target, expectedRoles } = testCase.prepare(root, base);
      const tree = fixtureGit(root, ["show", "-s", "--format=%T", target]);
      removeFixtureObject(root, tree);

      const result = verify(["--range", `${base}..${head}`, "--json"], {
        repoRoot: root,
      });
      assert.equal(result.status, 3, result.output);
      const report = reportOf(result);
      assert.equal(report.structural, true);
      const unavailable = report.unavailableTrees.find(
        (entry) => entry.revision === target,
      );
      assert.ok(unavailable, result.output);
      assert.equal(unavailable.object, tree);
      for (const role of expectedRoles) {
        assert.ok(unavailable.roles.includes(role), result.output);
      }
      assert.doesNotMatch(result.output, /FAILED TO RUN/);
    });
  }
});

test("an M-status source whose referenced blob is unavailable is STRUCTURAL", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "missing source blob mutant");
  const sourceBlob = fixtureGit(root, ["rev-parse", `${head}:${SOURCE_PATH}`]);
  removeFixtureObject(root, sourceBlob);

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 3, result.output);
  const report = reportOf(result);
  assert.equal(report.structural, true);
  assert.equal(report.object, sourceBlob);
  assert.equal(report.references[0].role, "source");
  assert.deepEqual(report.references[0].statuses, ["M"]);
  assert.match(report.reason, /blob object is unavailable/);
});

test("an unavailable referenced historical clean-list blob is STRUCTURAL", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const head = commitFixture(root, 101, "missing clean-list blob mutant");
  const cleanListBlob = fixtureGit(root, [
    "rev-parse",
    `${head}:${CLEAN_LIST_PATH}`,
  ]);
  removeFixtureObject(root, cleanListBlob);

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 3, result.output);
  const report = reportOf(result);
  assert.equal(report.structural, true);
  assert.equal(report.object, cleanListBlob);
  assert.ok(
    report.references.every((reference) => reference.role === "clean-list"),
  );
  assert.match(report.reason, /blob object is unavailable/);
});

test("a T-status source resolving to a non-blob object is STRUCTURAL", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  fixtureGit(root, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${base},${SOURCE_PATH}`,
  ]);
  const head = commitStagedFixture(root, 101, "non-blob source mutant");

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 3, result.output);
  const report = reportOf(result);
  assert.equal(report.structural, true);
  assert.equal(report.role, "source");
  assert.equal(report.objectType, "commit");
  assert.deepEqual(report.statuses, ["T"]);
  assert.match(report.reason, /non-blob object/);
});

test("a historical clean-list path resolving to a non-blob object is STRUCTURAL", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  fixtureGit(root, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${base},${CLEAN_LIST_PATH}`,
  ]);
  const head = commitStagedFixture(root, 101, "non-blob clean-list mutant");

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 3, result.output);
  const report = reportOf(result);
  assert.equal(report.structural, true);
  assert.equal(report.role, "clean-list");
  assert.equal(report.objectType, "commit");
  assert.match(report.reason, /clean-list path resolves to a non-blob object/);
});

test("a regular-file to symlink type change scans the symlink blob", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  const blobFixture = ".fixture/symlink-target.txt";
  writeFixture(
    root,
    blobFixture,
    "// Batch 999 is retained in the symlink blob.\n",
  );
  const blob = fixtureGit(root, ["hash-object", "-w", blobFixture]);
  fixtureGit(root, [
    "update-index",
    "--add",
    "--cacheinfo",
    `120000,${blob},${SOURCE_PATH}`,
  ]);
  const changed = commitStagedFixture(root, 101, "type-change source path");

  const result = verify(["--range", `${base}..${changed}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 1, result.output);
  const report = reportOf(result);
  assert.equal(report.markerGuard.pathsConsidered, 1);
  assert.equal(report.markerGuard.scanned, 1);
  assert.equal(report.markerGuard.errors.length, 1);
  assert.equal(report.markerGuard.errors[0].commit, changed);
  assert.equal(report.markerGuard.errors[0].file, SOURCE_PATH);
});

test("historical blob framing preserves an odd path with spaces", (t) => {
  const { root, base } = createHistoryFixture(t, {
    cleanListEntries: [ODD_SOURCE_PATH],
    source: null,
  });
  writeFixture(
    root,
    ODD_SOURCE_PATH,
    "// Batch 999 survives an odd path.\nexport const oddFixture = 1;\n",
  );
  const added = commitFixture(root, 101, "add odd source path");

  const result = verify(["--range", `${base}..${added}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 1, result.output);
  const report = reportOf(result);
  assert.equal(report.markerGuard.errors.length, 1);
  assert.equal(report.markerGuard.errors[0].file, ODD_SOURCE_PATH);
  assert.equal(report.markerGuard.errors[0].commit, added);
});

test("slash and literal-backslash Git paths retain distinct blob identities", (t) => {
  const { root, base } = createHistoryFixture(t, {
    cleanListEntries: [COLLISION_BACKSLASH_PATH],
    source: null,
  });
  const cleanBlob = fixtureBlob(root, "export const cleanSibling = true;\n");
  const markerBlob = fixtureBlob(
    root,
    "// Batch 999 belongs only to the backslash path.\nexport const markedSibling = true;\n",
  );
  const cleanListBlob = fixtureBlob(
    root,
    `# exact Git path identity\n${COLLISION_BACKSLASH_PATH}\n`,
  );
  const collisionTree = fixtureTree(root, [
    {
      mode: "100644",
      type: "blob",
      oid: cleanBlob,
      name: "Fixture.js",
    },
  ]);
  const sourceTree = fixtureTree(root, [
    {
      mode: "040000",
      type: "tree",
      oid: collisionTree,
      name: "Collision",
    },
    {
      mode: "100644",
      type: "blob",
      oid: markerBlob,
      name: "Collision\\Fixture.js",
    },
  ]);
  const engineTree = fixtureTree(root, [
    { mode: "040000", type: "tree", oid: sourceTree, name: "Source" },
  ]);
  const packagesTree = fixtureTree(root, [
    { mode: "040000", type: "tree", oid: engineTree, name: "engine" },
  ]);
  const c16Tree = fixtureTree(root, [
    {
      mode: "100644",
      type: "blob",
      oid: cleanListBlob,
      name: "comment-marker-cleanlist.txt",
    },
  ]);
  const toolsTree = fixtureTree(root, [
    { mode: "040000", type: "tree", oid: c16Tree, name: "c16" },
  ]);
  const rootTree = fixtureTree(root, [
    { mode: "040000", type: "tree", oid: toolsTree, name: "Tools" },
    { mode: "040000", type: "tree", oid: packagesTree, name: "packages" },
  ]);
  const head = commitTreeFixture(
    root,
    rootTree,
    base,
    101,
    "preserve colliding Git path identities",
  );

  const treePaths = fixtureGit(root, [
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    head,
  ]).split("\0");
  assert.ok(treePaths.includes(COLLISION_SLASH_PATH));
  assert.ok(treePaths.includes(COLLISION_BACKSLASH_PATH));

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 1, result.output);
  const report = reportOf(result);
  assert.equal(report.markerGuard.pathsConsidered, 2);
  assert.equal(report.markerGuard.scanned, 2);
  assert.equal(report.markerGuard.uniqueFiles, 2);
  assert.equal(report.markerGuard.errors.length, 1);
  assert.equal(report.markerGuard.errors[0].file, COLLISION_BACKSLASH_PATH);
  assert.equal(report.markerGuard.errors[0].commit, head);
});

test("invalid-UTF-8 Git paths retain distinct raw-byte identities and verdicts", (t) => {
  const { root, base } = createHistoryFixture(t, {
    cleanListEntries: ["packages/engine/Source"],
    source: null,
  });
  const cleanBlob = fixtureBlob(root, "export const rawClean = true;\n");
  const markerBlob = fixtureBlob(
    root,
    "// Batch 999 remains bound to its raw path.\nexport const rawMarked = true;\n",
  );
  const cleanListBlob = fixtureBlob(root, "packages/engine/Source\n");
  const cleanName = Buffer.concat([
    Buffer.from("Raw", "ascii"),
    Buffer.from([0x80]),
    Buffer.from(".js", "ascii"),
  ]);
  const markerName = Buffer.concat([
    Buffer.from("Raw", "ascii"),
    Buffer.from([0x81]),
    Buffer.from(".js", "ascii"),
  ]);
  const sourceTree = fixtureTree(root, [
    { mode: "100644", type: "blob", oid: cleanBlob, name: cleanName },
    { mode: "100644", type: "blob", oid: markerBlob, name: markerName },
  ]);
  const engineTree = fixtureTree(root, [
    { mode: "040000", type: "tree", oid: sourceTree, name: "Source" },
  ]);
  const packagesTree = fixtureTree(root, [
    { mode: "040000", type: "tree", oid: engineTree, name: "engine" },
  ]);
  const c16Tree = fixtureTree(root, [
    {
      mode: "100644",
      type: "blob",
      oid: cleanListBlob,
      name: "comment-marker-cleanlist.txt",
    },
  ]);
  const toolsTree = fixtureTree(root, [
    { mode: "040000", type: "tree", oid: c16Tree, name: "c16" },
  ]);
  const rootTree = fixtureTree(root, [
    { mode: "040000", type: "tree", oid: toolsTree, name: "Tools" },
    { mode: "040000", type: "tree", oid: packagesTree, name: "packages" },
  ]);
  const head = commitTreeFixture(
    root,
    rootTree,
    base,
    101,
    "bind invalid UTF-8 Git paths by bytes",
  );

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 1, result.output);
  const report = reportOf(result);
  assert.equal(report.markerGuard.pathsConsidered, 2);
  assert.equal(report.markerGuard.scanned, 2);
  assert.equal(report.markerGuard.uniqueFiles, 2);
  assert.equal(report.markerGuard.errors.length, 1);
  const fullMarkerPath = Buffer.concat([
    Buffer.from("packages/engine/Source/", "ascii"),
    markerName,
  ]);
  assert.equal(report.markerGuard.errors[0].fileEncoding, "base64");
  assert.equal(
    report.markerGuard.errors[0].fileBytesBase64,
    fullMarkerPath.toString("base64"),
  );
  assert.equal(
    report.markerGuard.errors[0].file,
    `git-path-base64:${fullMarkerPath.toString("base64")}`,
  );
  assert.equal(report.markerGuard.errors[0].commit, head);
});

test("working-tree clean-list removal cannot weaken historical severity", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(
    root,
    SOURCE_PATH,
    "// Batch 999 remains historical.\nexport const fixture = 1;\n",
  );
  const head = commitFixture(root, 101, "land marker under strict ratchet");
  writeFixture(root, CLEAN_LIST_PATH, "# uncommitted weaker worktree list\n");

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 1, result.output);
  const report = reportOf(result);
  assert.equal(report.markerGuard.errors.length, 1);
  assert.equal(report.markerGuard.warnings.length, 0);
  assert.equal(report.markerGuard.errors[0].commit, head);
});

test("working-tree clean-list addition cannot strengthen historical severity", (t) => {
  const { root, base } = createHistoryFixture(t, { cleanListed: false });
  writeFixture(
    root,
    SOURCE_PATH,
    "// Batch 999 was not yet ratcheted.\nexport const fixture = 1;\n",
  );
  const head = commitFixture(root, 101, "land pre-ratchet marker");
  writeFixture(
    root,
    CLEAN_LIST_PATH,
    `# uncommitted stronger worktree list\n${SOURCE_PATH}\n`,
  );

  const result = verify(["--range", `${base}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 0, result.output);
  const report = reportOf(result);
  assert.equal(report.markerGuard.errors.length, 0);
  assert.equal(report.markerGuard.warnings.length, 1);
  assert.equal(report.markerGuard.warnings[0].commit, head);
  assert.equal(report.markerGuard.warnings[0].cleanListed, false);
});

test("a merge enforces the union of every parent clean list", (t) => {
  const { root } = createHistoryFixture(t, { cleanListed: false });
  const mainBranch = fixtureGit(root, ["branch", "--show-current"]);

  fixtureGit(root, ["switch", "--quiet", "-c", "ratchet-side"]);
  writeFixture(
    root,
    CLEAN_LIST_PATH,
    `# side-parent ratchet\n${MERGE_SOURCE_PATH}\n`,
  );
  writeFixture(root, MERGE_SOURCE_PATH, "export const mergeFixture = 0;\n");
  const side = commitFixture(root, 102, "add side-parent ratchet");

  fixtureGit(root, ["switch", "--quiet", mainBranch]);
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const main = commitFixture(root, 101, "advance main parent");
  fixtureGit(root, ["merge", "--quiet", "--no-commit", "--no-ff", side]);
  writeFixture(
    root,
    MERGE_SOURCE_PATH,
    "// Batch 999 must be caught from the side parent.\nexport const mergeFixture = 1;\n",
  );
  fixtureGit(root, ["add", MERGE_SOURCE_PATH]);
  const merged = commitStagedFixture(root, 103, "merge parent ratchets");

  const result = verify(["--range", `${main}..${merged}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(result.status, 1, result.output);
  const report = reportOf(result);
  const mergeFinding = report.markerGuard.errors.find(
    (finding) => finding.file === MERGE_SOURCE_PATH,
  );
  assert.ok(mergeFinding, result.output);
  assert.equal(mergeFinding.commit, merged);
  assert.equal(mergeFinding.ruleId, "batch-id");
  assert.equal(report.markerGuard.ratchetErrors, 0);
});

test("an unavailable selected revision is STRUCTURAL even with a trusted baseline", (t) => {
  const { root } = createHistoryFixture(t, { cleanListed: true });
  const missing = "1111111111111111111111111111111111111111";
  const result = verify(
    [
      "--range",
      `${missing}..HEAD`,
      "--trusted-baseline-batch",
      "500",
      "--json",
    ],
    { repoRoot: root },
  );
  assert.equal(result.status, 3, result.output);
  const report = reportOf(result);
  assert.equal(report.structural, true);
  assert.deepEqual(report.unavailableRevisions, [missing]);
  assert.match(report.reason, /selected revision endpoint.*unavailable/);
});

test("an unavailable selected parent object is STRUCTURAL", (t) => {
  const { root } = createHistoryFixture(t, { cleanListed: false });
  const mainBranch = fixtureGit(root, ["branch", "--show-current"]);

  fixtureGit(root, ["switch", "--quiet", "-c", "missing-parent-side"]);
  writeFixture(root, MERGE_SOURCE_PATH, "export const mergeFixture = 1;\n");
  const side = commitFixture(root, 101, "create disposable side parent");

  fixtureGit(root, ["switch", "--quiet", mainBranch]);
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  const main = commitFixture(root, 102, "advance retained parent");
  fixtureGit(root, ["merge", "--quiet", "--no-commit", "--no-ff", side]);
  const merged = commitStagedFixture(root, 103, "merge missing-parent mutant");

  const gitDir = fixtureGit(root, ["rev-parse", "--git-dir"]);
  unlinkSync(
    path.resolve(root, gitDir, "objects", side.slice(0, 2), side.slice(2)),
  );

  const result = verify(
    [
      "--range",
      `${main}..${merged}`,
      "--trusted-baseline-batch",
      "500",
      "--json",
    ],
    { repoRoot: root },
  );
  assert.equal(result.status, 3, result.output);
  const report = reportOf(result);
  assert.equal(report.structural, true);
  assert.match(report.reason, /unavailable/);
});

test(
  "complete-history batch discovery crosses the exact former 5,000-commit cap",
  { timeout: 180_000 },
  (t) => {
    const { root, base } = createHistoryFixture(t, { cleanListed: true });
    const deep = createDeepBaselineFixture(root, base, 5_000);

    writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
    const boundaryHead = commitFixture(
      root,
      1_000,
      "reject hidden high batch beyond old cap",
    );
    const boundaryResult = verify(
      ["--range", `${deep.boundaryBase}..${boundaryHead}`, "--json"],
      { repoRoot: root },
    );
    assert.equal(boundaryResult.status, 1, boundaryResult.output);
    const boundaryReport = reportOf(boundaryResult);
    assert.equal(boundaryReport.baselineSource, "complete-history");
    assert.equal(boundaryReport.highestPushedBatch, 9_000);
    assert.ok(
      boundaryReport.commits[0].verdicts.some(
        (verdict) =>
          verdict.rule === "batch-monotonic" && verdict.status === "fail",
      ),
    );

    fixtureGit(root, ["switch", "--quiet", deep.controlBranch]);
    writeFixture(root, SOURCE_PATH, "export const fixture = 2;\n");
    const controlHead = commitFixture(
      root,
      9_001,
      "find high batch at 4,999-following control",
    );
    const controlResult = verify(
      ["--range", `${deep.controlBase}..${controlHead}`, "--json"],
      { repoRoot: root },
    );
    assert.equal(controlResult.status, 0, controlResult.output);
    const controlReport = reportOf(controlResult);
    assert.equal(controlReport.highestPushedBatch, 9_000);
    assert.equal(controlReport.markerGuard.errors.length, 0);
  },
);

test("shallow ancestry is STRUCTURAL unless a trusted baseline restores monotonicity", (t) => {
  const { root } = createHistoryFixture(t, { cleanListed: true });
  writeFixture(root, SOURCE_PATH, "export const fixture = 1;\n");
  commitFixture(root, 500, "establish hidden high baseline");
  writeFixture(root, SOURCE_PATH, "export const fixture = 2;\n");
  const rangeBase = commitFixture(root, 100, "lower visible shallow baseline");
  writeFixture(root, SOURCE_PATH, "export const fixture = 3;\n");
  const head = commitFixture(root, 101, "monotonicity mutant");

  const fullResult = verify(["--range", `${rangeBase}..${head}`, "--json"], {
    repoRoot: root,
  });
  assert.equal(fullResult.status, 1, fullResult.output);
  const fullReport = reportOf(fullResult);
  assert.equal(fullReport.highestPushedBatch, 500);
  assert.ok(
    fullReport.commits[0].verdicts.some(
      (verdict) =>
        verdict.rule === "batch-monotonic" && verdict.status === "fail",
    ),
  );

  const cloneParent = mkdtempSync(path.join(tmpdir(), "landing-shallow-"));
  t.after(() => rmSync(cloneParent, { recursive: true, force: true }));
  const shallow = path.join(cloneParent, "repo");
  fixtureGit(cloneParent, [
    "clone",
    "--quiet",
    "--no-local",
    "--depth",
    "2",
    root,
    shallow,
  ]);
  assert.equal(
    fixtureGit(shallow, ["rev-parse", "--is-shallow-repository"]),
    "true",
  );

  const shallowResult = verify(["--range", "HEAD~1..HEAD", "--json"], {
    repoRoot: shallow,
  });
  assert.equal(shallowResult.status, 3, shallowResult.output);
  const shallowReport = reportOf(shallowResult);
  assert.equal(shallowReport.structural, true);
  assert.equal(shallowReport.historySubject.shallow, true);
  assert.match(shallowReport.reason, /ancestry is shallow/);
  assert.equal(shallowReport.visibleBaselineBatch, null);

  const overlongLastResult = verify(
    ["--last", "2", "--trusted-baseline-batch", "500", "--json"],
    { repoRoot: shallow },
  );
  assert.equal(overlongLastResult.status, 3, overlongLastResult.output);
  assert.match(
    reportOf(overlongLastResult).reason,
    /last 2 commit\(s\) exceeds the locally available commit history/,
  );

  const contradictoryResult = verify(
    ["--range", "HEAD~1..HEAD", "--trusted-baseline-batch", "99", "--json"],
    { repoRoot: shallow },
  );
  assert.equal(contradictoryResult.status, 3, contradictoryResult.output);
  assert.match(reportOf(contradictoryResult).reason, /contradicts visible/);

  const trustedResult = verify(
    ["--range", "HEAD~1..HEAD", "--trusted-baseline-batch", "500", "--json"],
    { repoRoot: shallow },
  );
  assert.equal(trustedResult.status, 1, trustedResult.output);
  const trustedReport = reportOf(trustedResult);
  assert.equal(trustedReport.historySubject.shallow, true);
  assert.equal(trustedReport.baselineSource, "trusted-contract");
  assert.equal(trustedReport.highestPushedBatch, 500);
  assert.equal(trustedReport.visibleBaselineBatch, 100);
  assert.ok(
    trustedReport.commits[0].verdicts.some(
      (verdict) =>
        verdict.rule === "batch-monotonic" && verdict.status === "fail",
    ),
  );
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
  "KNOWN-GOOD: the compliant range reports no enforceable violations",
  {
    skip: rangeAvailable(KNOWN_GOOD_RANGE) ? false : "range not in this clone",
  },
  () => {
    const result = verify(["--range", KNOWN_GOOD_RANGE]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /verify-landing: PASS/);
    assert.match(result.output, /policy closure: raw [A-F0-9]{64}/u);
    assert.match(result.output, /load=stable; end=stable/u);
    assert.match(result.output, /history subject: [A-F0-9]{64}/u);
    for (const dependency of [
      LANDING_RULES_PATH,
      MARKER_GUARD_PATH,
      COMMENT_SCANNER_PATH,
      MARKER_GRAMMAR_PATH,
    ]) {
      assert.match(
        result.output,
        new RegExp(dependency.replaceAll("/", "\\/")),
      );
    }
    // It must have actually looked at something — a scan of zero files that
    // reports PASS is the failure mode the STRUCTURAL exit exists for.
    assert.match(result.output, /3 commit\(s\), 3 governed/);
    assert.match(
      result.output,
      /marker guard: [1-9]\d* in-scope historical snapshot\(s\)/,
    );
    assert.match(result.output, /0 error\(s\)/);
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
