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
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const JSON_MODE = args.includes("--json");
const VERIFY_ONLY = args.includes("--verify-only");
const clonePath = args.find((a) => !a.startsWith("--"));
const sourceIdx = args.indexOf("--source");
const sourceRepo = sourceIdx >= 0 ? args[sourceIdx + 1] : process.cwd();

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
    "usage: node Tools/provision-worker-clone.mjs <clone-path> [--source <repo>] [--json] [--verify-only]\n",
  );
  process.exit(2);
}
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

  if (!verifyOnly) {
    provisionTarget({
      source: path.resolve(sourceRepo, "node_modules"),
      clone: path.join(clonePath, "node_modules"),
      workspace: false,
    });
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
