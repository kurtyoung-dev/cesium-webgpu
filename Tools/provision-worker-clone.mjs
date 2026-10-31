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
 *   1. Governance the seat has edited but not yet committed cannot reach a
 *      clone from git. (CLAUDE.md was gitignored when this script was written;
 *      it has been tracked since Batch 1434, so the copy is now about uncommitted
 *      drift rather than about reachability — corrected 2026-09-13.)
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
 * Context spine. Provisioning also seeds the clone's gitignored context-spine DB
 * and .mcp.json from the source and brings a seeded DB that is behind the
 * clone's HEAD up to it with the clone's own incremental build:
 *   --no-spine-seed      skip the DB and .mcp.json copy
 *   --no-spine-refresh   skip the incremental build (the DB stays as seeded)
 * Run with no clone path to print every flag with a line on what it does.
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
import { isMainModule, runProvisioning } from "./provision/run.mjs";

// The flow (argv, usage, steps, report) lives in Tools/provision/. The helpers
// below stay in this file: they are its exports, and their specs load them from
// this file's source text. Importing this file provisions nothing; only running
// it as the script does.
if (isMainModule(import.meta.url)) {
  process.exit(
    await runProvisioning({
      args: process.argv.slice(2),
      helpers: {
        resolveCodexConfigPath,
        codexTrustAdd,
        codexTrustRemove,
        restoreUnchangedProvisionedFile,
        provisionNodeModulesJunctions,
      },
    }),
  );
}

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

/**
 * Restore checkout formatting when provisioning copies no tracked content change.
 * Every PROVISION destination is tracked. Copying an LF seat file over a CRLF
 * checkout can leave status dirty even when git diff reports identical content
 * (observed for MAINTAINER_RULINGS_2026-08-17.md in four clones on 2026-09-12).
 * git diff --quiet decides whether the copy delivered a change. An identical
 * copy is restored to its checkout form; differing seat content stays modified
 * and is reported to the caller for exclusion from the worker patch.
 */
export function restoreUnchangedProvisionedFile({
  clonePath,
  dest,
  execFileSync: run = execFileSync,
}) {
  try {
    run("git", ["-C", clonePath, "ls-files", "--error-unmatch", "--", dest], {
      stdio: "ignore",
    });
  } catch {
    return {
      restored: false,
      note: `${dest} provisioned (untracked in the clone)`,
    };
  }
  try {
    run("git", ["-C", clonePath, "diff", "--quiet", "--", dest], {
      stdio: "ignore",
    });
  } catch {
    return {
      restored: false,
      note: `NOTE: ${dest} differs from the clone's tracked copy and stays modified — exclude it from this lane's patch`,
    };
  }
  run("git", ["-C", clonePath, "checkout", "--", dest], {
    stdio: "ignore",
  });
  return {
    restored: true,
    note: `${dest} provisioned (identical to the clone's tracked copy; worktree restored)`,
  };
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
