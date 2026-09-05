#!/usr/bin/env node
// upstream-shape-guard.mjs — UPSTREAM-SYNC-1.145-08. The ES6-shape assertion for
// upstream merges: no file that was an ES6 `class` before the merge may come out
// of it prototype-based.
//
// @purpose Fails an upstream merge resolution that silently reverts a fork ES6-class file to upstream's prototype form.
// @status ACTIVE
//
// WHY THIS EXISTS. The 1.145 sync's dominant conflict mechanism was not
// semantics, it was shape: 13 of the 24 conflicted `.js` files conflicted only
// because the fork had converted them from `X.prototype.y = function` to ES6
// `class`, while upstream had not. Git aligns a fork class method against an
// unrelated prototype assignment and emits one conflict region spanning the
// shape boundary, so the two sides of the region are frequently not about the
// same feature at all. CLAUDE.md's sync procedure says to prefer
// `git checkout --theirs` and then re-add WebGPU code; for these files that is
// actively wrong, and "re-add WebGPU code" does not repair the damage, because
// what is lost is the file's whole shape.
//
// THE FAILURE IS SILENT, WHICH IS WHY IT NEEDS AN INSTRUMENT. A reverted file
// still parses, still exports the same symbols, and most specs still pass,
// because the public API is unchanged. Nothing in the fork's gate catches it.
//
// SOURCE SHAPE IS THE RIGHT INSTRUMENT HERE, UNUSUALLY. CLAUDE.md rightly
// distrusts source-text assertions as *behaviour* tests. This invariant genuinely
// is about source structure — "this file is an ES6 class" is not a behaviour —
// so shape is not a proxy for what is being asserted, it is the thing itself.
//
// WHAT IT CHECKS. For every in-scope file that declared at least one top-level
// ES6 class at the pre-merge base:
//
//   1. CLASS_LOST — a class declared at the base has no class declaration now.
//   2. PROTOTYPE_REINTRODUCED — a name that was a class at the base now carries
//      more top-level `Name.prototype.member =` assignments than it did at the
//      base.
//
// Both are counted against the base rather than against zero, so a file that
// legitimately shipped a class *and* a prototype assignment (interop shims do
// this) does not fail merely for keeping what it already had. The guard only
// fires on a regression it can attribute to this merge.
//
// USAGE
//   node Tools/upstream-shape-guard.mjs                 # scope: what the merge changed
//   node Tools/upstream-shape-guard.mjs --files a.js,b.js
//   node Tools/upstream-shape-guard.mjs --all           # every tracked engine/widgets Source .js
//   node Tools/upstream-shape-guard.mjs --base <rev>
//   node Tools/upstream-shape-guard.mjs --json
//
// BASE RESOLUTION, in order: `--base`; else, if a merge is in progress, `HEAD`
// (which during a merge is still the pre-merge fork tip); else, if `HEAD` is a
// two-parent merge commit, `HEAD^1`. Otherwise it exits 2 and asks for `--base`,
// rather than guessing — a guard that guesses its own baseline is worse than none.
//
// Exit 0 clean, 1 on any violation, 2 on a usage/environment error.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Files the guard considers at all. Engine + widgets JS sources only: TS cannot
 * idiomatically regress to a prototype shape, and Specs are not the invariant. */
const IN_SCOPE = /^packages\/(engine|widgets)\/Source\/.*\.js$/;

const CLASS_DECL =
  /^\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z0-9_$]+)/gm;

function prototypeAssignmentPattern(name) {
  // Top-level `Name.prototype.member = ...` only. Indented occurrences inside a
  // function body are not the reversion this guard is about.
  return new RegExp(
    `^${name.replace(/[$]/g, "\\$")}\\.prototype\\.[A-Za-z0-9_$]+\\s*=`,
    "gm",
  );
}

function classNames(source) {
  const names = new Set();
  for (const m of source.matchAll(CLASS_DECL)) {
    names.add(m[1]);
  }
  return names;
}

function countMatches(source, re) {
  let n = 0;
  for (const _ of source.matchAll(re)) {
    n++;
  }
  return n;
}

function git(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    ...opts,
  });
}

function gitQuiet(args) {
  const r = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return r.status === 0 ? r.stdout : undefined;
}

/** Read many blobs from one `git cat-file --batch` process. */
function readBlobs(rev, paths) {
  const out = new Map();
  if (paths.length === 0) {
    return out;
  }
  const input = `${paths.map((p) => `${rev}:${p}`).join("\n")}\n`;
  const r = spawnSync("git", ["cat-file", "--batch"], {
    cwd: REPO_ROOT,
    input,
    maxBuffer: 1 << 30,
  });
  if (r.status !== 0) {
    throw new Error(`git cat-file --batch failed: ${r.stderr}`);
  }
  const buf = r.stdout;
  let off = 0;
  for (const path of paths) {
    const nl = buf.indexOf(0x0a, off);
    if (nl < 0) {
      break;
    }
    const header = buf.slice(off, nl).toString("utf8");
    off = nl + 1;
    if (header.endsWith(" missing")) {
      // Path did not exist at `rev` — a file the merge added. Not in scope.
      continue;
    }
    const size = Number(header.split(" ")[2]);
    out.set(path, buf.slice(off, off + size).toString("utf8"));
    off += size + 1; // trailing LF
  }
  return out;
}

function resolveBase(explicit) {
  if (explicit) {
    return explicit;
  }
  const gitDir = gitQuiet(["rev-parse", "--git-dir"])?.trim();
  if (gitDir && existsSync(resolve(REPO_ROOT, gitDir, "MERGE_HEAD"))) {
    // Mid-merge: HEAD is still the pre-merge fork tip.
    return "HEAD";
  }
  const parents = gitQuiet(["rev-list", "--parents", "-n", "1", "HEAD"])
    ?.trim()
    .split(/\s+/);
  if (parents && parents.length === 3) {
    return "HEAD^1";
  }
  return undefined;
}

function scopePaths(argv, base) {
  const filesArg = argv.find((a) => a.startsWith("--files="));
  if (filesArg) {
    return filesArg
      .slice("--files=".length)
      .split(",")
      .map((s) => s.trim().replace(/\\/g, "/"))
      .filter(Boolean);
  }
  if (argv.includes("--all")) {
    return git(["ls-tree", "-r", "--name-only", base])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Default: whatever this merge is changing, index and worktree together.
  const changed = new Set();
  for (const line of git(["diff", "--name-only", base]).split("\n")) {
    if (line.trim()) {
      changed.add(line.trim());
    }
  }
  for (const line of git(["diff", "--name-only", "--cached", base]).split(
    "\n",
  )) {
    if (line.trim()) {
      changed.add(line.trim());
    }
  }
  return [...changed];
}

/**
 * The pure core, exported so the spec can drive it over fixtures without a repo.
 * @param {{path: string, before: string, after: string}[]} files
 * @returns {{path: string, kind: string, name: string, detail: string}[]}
 */
export function shapeViolations(files) {
  const violations = [];
  for (const { path, before, after } of files) {
    const wasClasses = classNames(before);
    if (wasClasses.size === 0) {
      continue;
    }
    const nowClasses = classNames(after);
    for (const name of wasClasses) {
      if (!nowClasses.has(name)) {
        violations.push({
          path,
          kind: "CLASS_LOST",
          name,
          detail: `\`class ${name}\` was declared before the merge and is not declared now`,
        });
      }
      const re = prototypeAssignmentPattern(name);
      const beforeHits = countMatches(before, re);
      const afterHits = countMatches(after, re);
      if (afterHits > beforeHits) {
        violations.push({
          path,
          kind: "PROTOTYPE_REINTRODUCED",
          name,
          detail: `top-level \`${name}.prototype.*\` assignments went ${beforeHits} -> ${afterHits}`,
        });
      }
    }
  }
  return violations;
}

function main(argv) {
  const baseArg = argv.find((a) => a.startsWith("--base="));
  const base = resolveBase(baseArg?.slice("--base=".length));
  if (!base) {
    process.stderr.write(
      "upstream-shape-guard: cannot determine the pre-merge base. " +
        "Pass --base=<rev> (no merge in progress and HEAD is not a merge commit).\n",
    );
    return 2;
  }

  const paths = scopePaths(argv, base).filter((p) => IN_SCOPE.test(p));
  const before = readBlobs(base, paths);

  const files = [];
  for (const path of paths) {
    const beforeSrc = before.get(path);
    if (beforeSrc === undefined) {
      continue; // added by the merge; there is no prior shape to preserve
    }
    const abs = resolve(REPO_ROOT, path);
    if (!existsSync(abs)) {
      continue; // deleted by the merge; deletion is a separate decision
    }
    files.push({ path, before: beforeSrc, after: readFileSync(abs, "utf8") });
  }

  const violations = shapeViolations(files);

  if (argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({ base, scanned: files.length, violations }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `upstream-shape-guard: base ${base}, ${files.length} in-scope file(s) that were ES6 classes or plain sources\n`,
    );
    for (const v of violations) {
      process.stdout.write(`  ${v.kind}  ${v.path}: ${v.detail}\n`);
    }
    process.stdout.write(
      violations.length === 0
        ? "  OK — no file that was an ES6 class before the merge is prototype-based now.\n"
        : `  ${violations.length} violation(s).\n`,
    );
  }
  return violations.length === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main(process.argv.slice(2)));
}
