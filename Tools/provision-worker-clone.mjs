#!/usr/bin/env node
/**
 * Worker-clone provisioning and readiness assertion.
 * @purpose Provision a worker clone with the governance git cannot deliver, create the local main ref the handoff diff needs, and REFUSE if any routed authority is unreachable.
 * @status ACTIVE
 *
 * WHY THIS EXISTS. On 2026-08-20 the first Codex worker dispatch stopped before
 * doing any work and reported that three binding authorities were unreachable in
 * its clone. It was right, and every cause was an orchestrator provisioning
 * failure:
 *
 *   1. CLAUDE.md is GITIGNORED (.gitignore:6). It can never reach a clone from
 *      git. This one is permanent and is the reason this script exists.
 *   2. Governance authored but not yet committed is absent from clones made
 *      before it lands. This one cures itself at landing, but silently produces
 *      an under-briefed worker in the meantime.
 *   3. `git clone --branch <b>` leaves no local `main`, so the `main...HEAD`
 *      handoff diff the worker owes cannot resolve.
 *
 * The orchestrator had already OBSERVED cause 1 during setup, remarked on it, and
 * then dispatched anyway. A checklist followed from memory is not a control; this
 * script is the control. It exits non-zero when the clone is not ready, so a
 * worker cannot be dispatched into a tree that cannot brief it.
 *
 * Usage:
 *   node Tools/provision-worker-clone.mjs <clone-path> [--source <repo>] [--json]
 *   node Tools/provision-worker-clone.mjs <clone-path> --verify-only
 *
 * Codex trust (opt-in; R-2026-09-02-23 / DX-25). Codex's config.toml trusts
 * repositories one `[projects.'<path>']` table at a time — narrowing it off
 * the `f:\dev\gh` parent means each worker clone must get its own entry when
 * provisioned and lose it at retirement, or Codex cannot branch/clone inside
 * a lane it no longer trusts. These flags are that entry's write path:
 *   node Tools/provision-worker-clone.mjs <clone-path> --codex-trust [--config <path>]
 *   node Tools/provision-worker-clone.mjs <clone-path> --codex-untrust [--config <path>]
 * Both are line-based edits of the TOML (append/remove exactly one
 * `[projects.'<clone-path>']` / `trust_level = "trusted"` pair) and are
 * idempotent — a repeat --codex-trust adds nothing, a repeat --codex-untrust
 * (or one against a path never trusted) is a no-op. Without --config they
 * target the real `~/.codex/config.toml`; under NODE_ENV=test or --dry-run
 * they refuse to touch any target outside os.tmpdir(), --config included.
 * Retirement ordering: --codex-untrust used ALONE (no --codex-trust) skips
 * the .git-clone check and every provisioning/verification step below it —
 * it is the retirement path, run AFTER a clone directory is gone, and only
 * needs the path string plus the config file (F4/DX-25 fix-round).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const JSON_MODE = args.includes("--json");
const VERIFY_ONLY = args.includes("--verify-only");
const clonePath = args.find((a) => !a.startsWith("--"));
const sourceIdx = args.indexOf("--source");
const sourceRepo = sourceIdx >= 0 ? args[sourceIdx + 1] : process.cwd();
const CODEX_TRUST = args.includes("--codex-trust");
const CODEX_UNTRUST = args.includes("--codex-untrust");

/**
 * Governance a clone cannot obtain from git, and why.
 *
 * `required: true` means a worker MUST NOT be dispatched without it. Anything
 * AGENTS.md routes to as a binding authority belongs here — the router promising
 * a document the clone lacks is precisely the failure this file closes.
 */
const PROVISION = [
  {
    src: "CLAUDE.md",
    dest: "CLAUDE.md",
    required: true,
    why: "gitignored (.gitignore:6) — permanently unreachable from git",
  },
  {
    src: "AGENTS.md",
    dest: "AGENTS.md",
    required: true,
    why: "the router itself; untracked until it lands",
  },
  {
    src: "migration_doc/MAINTAINER_RULINGS_2026-08-17.md",
    dest: "migration_doc/MAINTAINER_RULINGS_2026-08-17.md",
    required: true,
    why: "current ruling series — supersedes every document below it",
  },
  {
    src: "migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md",
    dest: "migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md",
    required: true,
    why: "the worker's own procedure: lease, rebase rules, handoff report",
  },
];

/** Authorities AGENTS.md routes to. A router that promises these must deliver. */
const ROUTED_AUTHORITIES = [
  "CLAUDE.md",
  "AGENTS.md",
  "migration_doc/EXECUTOR_LANE_CHARTER_2026-08-14.md",
  "migration_doc/MAINTAINER_RULINGS_2026-08-14.md",
  "migration_doc/MAINTAINER_RULINGS_2026-08-17.md",
  "migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md",
  "migration_doc/ORCHESTRATION_HANDBOOK.md",
  "migration_doc/CODEX_SOL_OPERATING_BRIEF.md",
];

const problems = [];
const provisioned = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function gitObjectId(file) {
  // git hash-object, i.e. SHA-1 over the blob — an identity stamp for the
  // provisioned copy, not a cryptographic digest. Named for what it is.
  return execFileSync("git", ["hash-object", "--", file], {
    encoding: "utf8",
  }).trim();
}

if (!clonePath) {
  process.stderr.write(
    "usage: node Tools/provision-worker-clone.mjs <clone-path> [--source <repo>] [--json] [--verify-only] [--codex-trust | --codex-untrust] [--config <path>] [--dry-run]\n" +
      "  --codex-untrust alone (no --codex-trust) skips the .git check below and\n" +
      "  exits after the trust write — it is the retirement path and must work on\n" +
      "  a clone directory that has already been removed (F4/DX-25 fix-round).\n",
  );
  process.exit(2);
}
// F4 fix-round (Hirluin): retirement deletes the clone directory before
// revoking trust is ever guaranteed to run, so a bare --codex-untrust must
// not require the .git tree that just stopped existing. --codex-trust still
// needs a real clone (there is nothing sane to trust otherwise), so the
// bypass is scoped to "untrust, and nothing else requested".
const UNTRUST_ONLY = CODEX_UNTRUST && !CODEX_TRUST;
if (!UNTRUST_ONLY) {
  if (!fs.existsSync(path.join(clonePath, ".git"))) {
    process.stderr.write(`not a git clone: ${clonePath}\n`);
    process.exit(2);
  }
  // A linked worktree's .git is a FILE pointing into the orchestrator's .git, which
  // R-2026-08-18-28 disqualified for sandboxed workers: every ref and index write
  // would land under the orchestrator's repository.
  if (!fs.statSync(path.join(clonePath, ".git")).isDirectory()) {
    process.stderr.write(
      `${clonePath}/.git is a file, not a directory — this is a linked worktree, not a clone. See R-2026-08-18-28.\n`,
    );
    process.exit(2);
  }
}

// --- Codex trust (opt-in; R-2026-09-02-23 / DX-25) --------------------------
if (CODEX_TRUST || CODEX_UNTRUST) {
  try {
    // F7 fix-round: resolveCodexConfigPath's own validation (below) now
    // throws for a missing/flag-shaped --config value instead of silently
    // resolving to the real config — moved inside this try so that throw is
    // caught the same way a codexTrustAdd/Remove failure is, not left to
    // crash the process uncaught.
    const codexConfigPath = resolveCodexConfigPath({ args });
    if (CODEX_TRUST) {
      const result = codexTrustAdd({
        configPath: codexConfigPath,
        clonePath,
        args,
      });
      const line = result.changed
        ? `codex trust: added ${result.headerLine}`
        : `codex trust: already present, no change (${result.headerLine})`;
      notes.push(line);
      // F1 fix-round (Hirluin): --json promises a single JSON document on
      // stdout (usage block above). Writing this line unconditionally put a
      // bare string ahead of that document, so JSON.parse(stdout) failed
      // whenever --json was combined with --codex-trust/--codex-untrust. The
      // same string already lives in result.notes → result.notes below, so
      // the human-readable echo is redundant (not just wrong) in JSON mode.
      if (!JSON_MODE) {
        process.stdout.write(`${line}\n`);
      }
    }
    if (CODEX_UNTRUST) {
      const result = codexTrustRemove({
        configPath: codexConfigPath,
        clonePath,
        args,
      });
      const line = result.changed
        ? `codex trust: removed ${result.headerLine}`
        : `codex trust: not present, no change (${result.headerLine})`;
      notes.push(line);
      if (!JSON_MODE) {
        process.stdout.write(`${line}\n`);
      }
    }
  } catch (error) {
    fail(`codex trust update failed: ${error?.message ?? error}`);
  }
}

// F4 fix-round: a bare --codex-untrust already skipped the .git check above
// because the clone directory may be gone. Everything below this point
// (VERIFY_ONLY and the provisioning branch) assumes a real clone tree —
// provisioning in particular would recreate the retired directory via
// mkdirSync/copyFileSync, which is a worse surprise than exiting here. The
// trust write above is the entire job of an untrust-only invocation.
if (UNTRUST_ONLY) {
  const untrustResult = {
    clone: clonePath,
    status: problems.length === 0 ? "READY" : "NOT_READY",
    provisioned: [],
    notes,
    problems,
  };
  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify(untrustResult, null, 2)}\n`);
  } else {
    for (const p of problems) {
      process.stdout.write(`  PROBLEM      ${p}\n`);
    }
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

if (VERIFY_ONLY) {
  const workspaceModules = provisionNodeModulesJunctions({
    sourceRepo,
    clonePath,
    verifyOnly: true,
  });
  notes.push(...workspaceModules.reports);
  for (const relativePath of workspaceModules.missingWorkspaceNodeModules) {
    fail(`workspace package node_modules missing from clone: ${relativePath}`);
  }
}

// --- provision -------------------------------------------------------------
if (!VERIFY_ONLY) {
  for (const entry of PROVISION) {
    const from = path.join(sourceRepo, entry.src);
    const to = path.join(clonePath, entry.dest);
    if (!fs.existsSync(from)) {
      if (entry.required) {
        fail(`source missing, cannot provision: ${entry.src} (${entry.why})`);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    provisioned.push({
      path: entry.dest,
      objectId: gitObjectId(to),
      why: entry.why,
    });
  }

  // `git clone --branch <b>` leaves no local main, so `main...HEAD` — the diff the
  // worker owes in its handoff report — cannot resolve. Create it from the remote.
  try {
    execFileSync("git", ["-C", clonePath, "rev-parse", "--verify", "main"], {
      stdio: "ignore",
    });
    notes.push("local main ref already present");
  } catch {
    try {
      execFileSync("git", ["-C", clonePath, "branch", "main", "origin/main"], {
        stdio: "ignore",
      });
      notes.push("created local main ref from origin/main");
    } catch (error) {
      fail(`could not create a local main ref: ${error?.message ?? error}`);
    }
  }

  // A fresh clone has no `node_modules`, so every npm-script gate a brief might
  // ask for — `build-ts`, `build-docs`, the C16 tools' own deps — fails before
  // it reaches the code under test. A worker then either reports an honest
  // non-PASS (the good outcome, and what happened) or invents a workaround.
  // Junction the source tree's modules in: same filesystem, no copy, and Node's
  // ESM resolver walks it exactly as it would a real directory. Not fatal if it
  // fails — plenty of briefs need no npm script — but the note tells the
  // orchestrator which kind of dispatch this clone can carry.
  const workspaceModules = provisionNodeModulesJunctions({
    sourceRepo,
    clonePath,
  });
  notes.push(...workspaceModules.reports);
  for (const relativePath of workspaceModules.missingWorkspaceNodeModules) {
    fail(`workspace package node_modules missing from clone: ${relativePath}`);
  }

  // The ThirdParty WASM binaries (splats, Draco, zip) are UNTRACKED build
  // inputs that `gulp prepare` copies from node_modules into
  // packages/engine/Source/ThirdParty. A fresh clone plus build without this
  // step produces an artifact whose splat, Draco, and zip paths 404 at
  // runtime — the stall looks like a product readiness defect and costs a
  // diagnosis to attribute. Copy them here so a provisioned clone can never
  // build that trap.
  const thirdPartyDir = path.join(
    clonePath,
    "packages",
    "engine",
    "Source",
    "ThirdParty",
  );
  const wasmSources = [
    ["@cesium/wasm-splats", "wasm_splats_bg.wasm"],
    ["@cesium/wasm-splats", "wasm_splats.js"],
  ];
  let wasmCopied = 0;
  for (const [pkg, file] of wasmSources) {
    const src = path.resolve(sourceRepo, "node_modules", pkg, file);
    const dest = path.join(thirdPartyDir, file);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      try {
        fs.copyFileSync(src, dest);
        wasmCopied += 1;
      } catch {
        notes.push(`could not copy ${file} into ThirdParty`);
      }
    }
  }
  const requiredThirdParty = ["wasm_splats_bg.wasm", "draco_decoder.wasm"];
  const missingThirdParty = requiredThirdParty.filter(
    (f) => !fs.existsSync(path.join(thirdPartyDir, f)),
  );
  if (wasmCopied > 0) {
    notes.push(
      `copied ${wasmCopied} ThirdParty WASM file(s) from node_modules`,
    );
  }
  if (missingThirdParty.length > 0) {
    notes.push(
      `ThirdParty still missing ${missingThirdParty.join(", ")} — run \`npx gulp prepare\` in the clone before any build, or its artifact will 404 splats/Draco at runtime`,
    );
  }

  if (provisioned.length > 0) {
    const manifest = provisioned
      .map((p) => `${p.objectId}  ${p.path}`)
      .join("\n");
    fs.mkdirSync(path.join(clonePath, "_review"), { recursive: true });
    fs.writeFileSync(
      path.join(clonePath, "_review", "PROVISION.objectid"),
      `${manifest}\n`,
    );
  }
}

// --- verify ----------------------------------------------------------------
for (const rel of ROUTED_AUTHORITIES) {
  if (!fs.existsSync(path.join(clonePath, rel))) {
    fail(`routed authority unreachable in clone: ${rel}`);
  }
}

try {
  execFileSync("git", ["-C", clonePath, "rev-parse", "--verify", "main"], {
    stdio: "ignore",
  });
} catch {
  fail(
    "no local main ref — the worker's `git diff main...HEAD` cannot resolve",
  );
}

const result = {
  clone: clonePath,
  status: problems.length === 0 ? "READY" : "NOT_READY",
  provisioned: provisioned.map((p) => p.path),
  notes,
  problems,
};

if (JSON_MODE) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`worker clone: ${result.status}\n  ${clonePath}\n`);
  for (const p of provisioned) {
    process.stdout.write(`  provisioned  ${p.path}\n`);
  }
  for (const n of notes) {
    process.stdout.write(`  note         ${n}\n`);
  }
  for (const p of problems) {
    process.stdout.write(`  PROBLEM      ${p}\n`);
  }
}

// 0 ready, 1 not ready. A worker must not be dispatched on a non-zero exit.
process.exit(problems.length === 0 ? 0 : 1);

// --- Codex trust helpers (R-2026-09-02-23 / DX-25) --------------------------
//
// Codex's config.toml grants per-project trust as one
// `[projects.'<lowercase, backslash path>']` table with a `trust_level =
// "trusted"` line under it — the format the maintainer narrowed the config
// to on 2026-09-02 (explicit named Cesium clones, no `f:\dev\gh` parent). A
// worker clone's entry is written here at provisioning and removed here at
// retirement, so Codex can still branch/clone inside a lane it's dispatched
// into without regaining trust over everything beside it.
//
// The edit is deliberately line-based: this TOML is simple enough (flat
// tables, one key per project) that a full parser would be more surface to
// get wrong than the four regexes below. Every function here is exported and
// pure over its `fs`/`args`/`nodeEnv` parameters so a spec can drive it
// against an in-tmpdir fixture without touching a real config file, matching
// the destructive-test convention this repo already applies elsewhere.

/**
 * Codex's own on-disk key for a project path: absolute, backslash-separated,
 * lower-cased. Matches the existing entries verbatim (e.g.
 * `[projects.'f:\dev\gh\cesium-audit-proto']`) so an add/remove round-trips
 * against a config a human or Codex itself already edited.
 */
export function toCodexTrustKey(clonePath) {
  return path.resolve(clonePath).replace(/\//g, "\\").toLowerCase();
}

/**
 * F3 fix-round: TOML literal strings ('...') admit no escape sequences at
 * all, so a clone path containing an apostrophe (or a raw CR/LF, which a
 * literal string also cannot contain) would write a `[projects.'...']` line
 * that fails to parse — taking down the ENTIRE config, every existing trust
 * entry included, not just the new one. The tool already refuses to guess
 * in two other places (no projects block; an unexpected trust_level line);
 * this is the third: refuse before ever building the line.
 */
function describeCodexTrustEntry(key) {
  if (/['\r\n]/.test(key)) {
    throw new Error(
      `refusing to write an unrepresentable project key (contains ' or a line break) into a TOML literal string: ${JSON.stringify(key)}`,
    );
  }
  return `[projects.'${key}']`;
}

function codexTrustEntryLines(key) {
  return [describeCodexTrustEntry(key), 'trust_level = "trusted"'];
}

function detectEol(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function atomicWriteFile(targetPath, content, fsOps) {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  fsOps.writeFileSync(tmpPath, content, "utf8");
  fsOps.renameSync(tmpPath, targetPath);
}

/**
 * The real Codex config path, unless `--config <path>` names another one.
 * Exported so a spec can assert the default without setting HOME.
 *
 * F7 fix-round: `--config` with no following value, or one that itself looks
 * like a flag (`--dry-run`, `--json`, …) used to fall through to `idx >= 0 &&
 * typeof args[idx + 1] === "string"` being false/true in ways that either
 * silently retargeted the write at the REAL config (missing value) or fed
 * the next flag's own text in as a path (`--config --dry-run` → the literal
 * string `"--dry-run"`). A tool whose entire safety story is "never touch
 * the real file by accident" must not swallow that mistake — it throws now.
 */
export function resolveCodexConfigPath({
  args = [],
  homedir = os.homedir(),
} = {}) {
  const idx = args.indexOf("--config");
  if (idx >= 0) {
    const value = args[idx + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new Error(
        `--config requires a path argument (got ${JSON.stringify(value ?? null)})`,
      );
    }
    return value;
  }
  return path.join(homedir, ".codex", "config.toml");
}

/**
 * Maintainer rule 2026-08-31: a destructive-looking write must structurally
 * assert its target is under os.tmpdir() before touching anything, whenever
 * it's running as a test (NODE_ENV=test) or a caller has flagged --dry-run.
 * Outside that guard (a real, deliberate invocation) the real config path is
 * exactly the point of --codex-trust/--codex-untrust, so it is allowed.
 */
export function assertCodexConfigTargetAllowed({
  configPath,
  nodeEnv = process.env.NODE_ENV,
  args = [],
  tmpdir = os.tmpdir(),
} = {}) {
  const guarded = nodeEnv === "test" || args.includes("--dry-run");
  if (!guarded) {
    return;
  }
  const resolvedTarget = path.resolve(configPath).toLowerCase();
  const resolvedTmp = path.resolve(tmpdir).toLowerCase();
  const withinTmp =
    resolvedTarget === resolvedTmp ||
    resolvedTarget.startsWith(resolvedTmp + path.sep.toLowerCase());
  if (!withinTmp) {
    throw new Error(
      `refusing to touch ${configPath}: outside os.tmpdir() (${tmpdir}) while NODE_ENV=test or --dry-run is set`,
    );
  }
}

/**
 * Idempotent append. Inserts `[projects.'<key>']` / `trust_level = "trusted"`
 * immediately after the LAST existing `[projects.'...']` table's own lines —
 * i.e. before any blank-line separator or subsequent table (`[plugins.]`,
 * `[marketplaces.]`, or anything else) — and touches no other byte. A second
 * call against the result is a no-op: `changed: false`.
 */
export function codexTrustAdd({
  configPath,
  clonePath,
  fs: fsOps = fs,
  nodeEnv = process.env.NODE_ENV,
  args = [],
  tmpdir = os.tmpdir(),
}) {
  assertCodexConfigTargetAllowed({ configPath, nodeEnv, args, tmpdir });
  const key = toCodexTrustKey(clonePath);
  const headerLine = describeCodexTrustEntry(key);
  const content = fsOps.readFileSync(configPath, "utf8");
  const eol = detectEol(content);
  const lines = content.split(eol);
  if (lines.includes(headerLine)) {
    return { changed: false, key, headerLine };
  }

  let lastHeaderIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\[projects\./.test(lines[i])) {
      lastHeaderIdx = i;
    }
  }
  if (lastHeaderIdx === -1) {
    throw new Error(
      `no existing [projects.'...'] table in ${configPath}; refusing to guess an insertion point`,
    );
  }
  // Walk past this last table's own key lines (non-blank, not a new table
  // header) — that boundary is "the end of the projects block" regardless of
  // whether the file separates tables with blank lines or not.
  let insertAt = lastHeaderIdx + 1;
  while (
    insertAt < lines.length &&
    lines[insertAt].trim() !== "" &&
    !/^\[/.test(lines[insertAt])
  ) {
    insertAt++;
  }

  lines.splice(insertAt, 0, ...codexTrustEntryLines(key));
  atomicWriteFile(configPath, lines.join(eol), fsOps);
  return { changed: true, key, headerLine };
}

/**
 * Removes exactly the header line plus its `trust_level = "trusted"` line —
 * nothing else — for `clonePath`. A path with no entry is a no-op:
 * `changed: false`. Refuses (throws) rather than guessing if the line after
 * the header isn't the expected trust_level assignment, so a hand-edited or
 * unexpected config can't lose the wrong line.
 */
export function codexTrustRemove({
  configPath,
  clonePath,
  fs: fsOps = fs,
  nodeEnv = process.env.NODE_ENV,
  args = [],
  tmpdir = os.tmpdir(),
}) {
  assertCodexConfigTargetAllowed({ configPath, nodeEnv, args, tmpdir });
  const key = toCodexTrustKey(clonePath);
  const headerLine = describeCodexTrustEntry(key);
  const content = fsOps.readFileSync(configPath, "utf8");
  const eol = detectEol(content);
  const lines = content.split(eol);
  const headerIdx = lines.indexOf(headerLine);
  if (headerIdx === -1) {
    return { changed: false, key, headerLine };
  }
  const trustLine = lines[headerIdx + 1] ?? "";
  if (!/^trust_level\s*=\s*"trusted"$/.test(trustLine)) {
    throw new Error(
      `refusing to remove ${headerLine}: the following line is not exactly trust_level = "trusted" (got ${JSON.stringify(trustLine)})`,
    );
  }
  lines.splice(headerIdx, 2);
  atomicWriteFile(configPath, lines.join(eol), fsOps);
  return { changed: true, key, headerLine };
}

export function provisionNodeModulesJunctions({
  sourceRepo,
  clonePath,
  verifyOnly = false,
  fs: fsOps = fs,
  execFileSync: run = execFileSync,
  platform = process.platform,
}) {
  const reports = [];
  const missingWorkspaceNodeModules = [];
  const isDirectory = (candidate) => {
    try {
      return fsOps.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  };

  const provisionTarget = (target) => {
    const present = target.workspace
      ? isDirectory(target.clone)
      : fsOps.existsSync(target.clone);
    if (present) {
      reports.push(
        target.workspace
          ? `${target.label} present`
          : "node_modules already present",
      );
      return;
    }

    if (!fsOps.existsSync(target.source)) {
      reports.push(
        "no node_modules in the source repo — this clone cannot run npm-script gates",
      );
      return;
    }

    if (verifyOnly) {
      reports.push(`${target.label} missing`);
      missingWorkspaceNodeModules.push(target.label);
      return;
    }

    try {
      if (target.workspace) {
        fsOps.mkdirSync(path.dirname(target.clone), { recursive: true });
      }
      if (platform === "win32") {
        run("cmd", ["/c", "mklink", "/J", target.clone, target.source], {
          stdio: "ignore",
        });
      } else {
        fsOps.symlinkSync(target.source, target.clone, "dir");
      }
      reports.push(
        target.workspace
          ? `${target.label} provisioned`
          : "linked node_modules from the source repo",
      );
    } catch (error) {
      if (target.workspace) {
        reports.push(
          `${target.label} missing (could not provision: ${error?.message ?? error})`,
        );
        missingWorkspaceNodeModules.push(target.label);
      } else {
        reports.push(
          `could not link node_modules (${error?.message ?? error}) — this clone cannot run npm-script gates`,
        );
      }
    }
  };

  const linkDir = (cloneTarget, sourceTarget) => {
    if (platform === "win32") {
      // One junction per top-level node_modules entry (~750 of them). Create
      // it natively: spawning `cmd /c mklink /J` measured ~126ms apiece
      // (~94s per clone) against ~1.4ms here. A "junction" needs absolute
      // paths and, like `mklink /J`, no elevation.
      fsOps.symlinkSync(
        path.resolve(sourceTarget),
        path.resolve(cloneTarget),
        "junction",
      );
    } else {
      fsOps.symlinkSync(sourceTarget, cloneTarget, "dir");
    }
  };

  // The clone's OWN `packages/<dir>` -> workspace package name, read from the
  // CLONE tree (not the source repo) so a redirected specifier lands on code
  // the clone actually owns.
  const readWorkspacePackageMap = () => {
    const map = new Map();
    const clonePackagesDir = path.join(clonePath, "packages");
    if (!isDirectory(clonePackagesDir)) {
      return map;
    }
    for (const entry of fsOps.readdirSync(clonePackagesDir, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const pkgJsonPath = path.join(
        clonePackagesDir,
        entry.name,
        "package.json",
      );
      if (!fsOps.existsSync(pkgJsonPath)) {
        continue;
      }
      try {
        const pkgJson = JSON.parse(fsOps.readFileSync(pkgJsonPath, "utf8"));
        if (typeof pkgJson.name === "string") {
          map.set(pkgJson.name, entry.name);
        }
      } catch {
        // Malformed package.json for a workspace member: fall through to
        // the scope-wide link below rather than guessing at its identity.
      }
    }
    return map;
  };

  // Root `node_modules`. A straight junction of the WHOLE tree is correct
  // for every third-party dependency but wrong for the npm workspaces
  // (`@cesium/engine`, `@cesium/widgets`, `@cesium/sandcastle`): npm
  // installs those as symlinks INSIDE the source repo's own node_modules,
  // pointing at the SOURCE repo's own `packages/<name>`. Junctioning the
  // whole tree wholesale therefore made every bare `@cesium/*` import
  // resolve back into the seat repo instead of the clone — every
  // clone-local build/tsc/spec run compiled against unmerged seat source
  // (surfaced by lane S's merge failure). Fix: link everything else
  // wholesale (same filesystem, no copy) but redirect the workspace-member
  // entries individually to the clone's own packages/.
  const provisionRootNodeModules = () => {
    const cloneModules = path.join(clonePath, "node_modules");
    if (fsOps.existsSync(cloneModules)) {
      return "node_modules already present";
    }
    const sourceModules = path.resolve(sourceRepo, "node_modules");
    if (!fsOps.existsSync(sourceModules)) {
      return "no node_modules in the source repo — this clone cannot run npm-script gates";
    }
    try {
      const workspaceMap = readWorkspacePackageMap();
      fsOps.mkdirSync(cloneModules, { recursive: true });
      let redirected = 0;
      for (const entry of fsOps.readdirSync(sourceModules, {
        withFileTypes: true,
      })) {
        const name = entry.name;
        if (!isDirectory(path.join(sourceModules, name))) {
          // The only tracked non-directory entry today is
          // `.package-lock.json` — hardlink it (same filesystem, no copy),
          // falling back to a real copy if hardlinking isn't available.
          // `Dirent.isDirectory()` reports false for a junction (npm's own
          // workspace links included), so this checks the real target via
          // `statSync` (the existing `isDirectory` helper) instead of the
          // dirent flag — a future hoisted junction here must not fall into
          // the hardlink/copy branch and abort the whole provision.
          try {
            fsOps.linkSync(
              path.join(sourceModules, name),
              path.join(cloneModules, name),
            );
          } catch {
            fsOps.copyFileSync(
              path.join(sourceModules, name),
              path.join(cloneModules, name),
            );
          }
          continue;
        }

        if (!name.startsWith("@")) {
          linkDir(
            path.join(cloneModules, name),
            path.join(sourceModules, name),
          );
          continue;
        }

        // Scoped directory: only descend into it when at least one member
        // is a workspace package needing redirection — every other scope,
        // and every non-workspace member of this one, links wholesale
        // unchanged.
        const scopeSource = path.join(sourceModules, name);
        const scopedEntries = fsOps.readdirSync(scopeSource, {
          withFileTypes: true,
        });
        const hasWorkspaceMember = scopedEntries.some((scoped) =>
          workspaceMap.has(`${name}/${scoped.name}`),
        );
        if (!hasWorkspaceMember) {
          linkDir(path.join(cloneModules, name), scopeSource);
          continue;
        }

        const scopeClone = path.join(cloneModules, name);
        fsOps.mkdirSync(scopeClone, { recursive: true });
        for (const scoped of scopedEntries) {
          const workspaceDir = workspaceMap.get(`${name}/${scoped.name}`);
          const cloneTarget = path.join(scopeClone, scoped.name);
          if (workspaceDir) {
            linkDir(
              cloneTarget,
              path.join(clonePath, "packages", workspaceDir),
            );
            redirected += 1;
          } else {
            linkDir(cloneTarget, path.join(scopeSource, scoped.name));
          }
        }
      }
      return redirected > 0
        ? `linked node_modules from the source repo (${redirected} workspace package(s) redirected to the clone's own packages/)`
        : "linked node_modules from the source repo";
    } catch (error) {
      return `could not link node_modules (${error?.message ?? error}) — this clone cannot run npm-script gates`;
    }
  };

  if (!verifyOnly) {
    reports.push(provisionRootNodeModules());
  }

  const packagesDir = path.resolve(sourceRepo, "packages");
  if (!fsOps.existsSync(packagesDir)) {
    return { reports, missingWorkspaceNodeModules };
  }

  const packageNames = fsOps
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const packageName of packageNames) {
    const sourceModules = path.join(packagesDir, packageName, "node_modules");
    if (!isDirectory(sourceModules)) {
      continue;
    }
    provisionTarget({
      label: path.posix.join("packages", packageName, "node_modules"),
      source: sourceModules,
      clone: path.join(clonePath, "packages", packageName, "node_modules"),
      workspace: true,
    });
  }

  return { reports, missingWorkspaceNodeModules };
}
