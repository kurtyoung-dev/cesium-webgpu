#!/usr/bin/env node
/**
 * Durable local backup for reviewed-but-unlanded worker deliverables.
 * @purpose Export each worker clone's authored work as a self-contained, verified-appliable patch bundle so nothing depends on a clone surviving, while quiet hours forbid committing.
 * @status ACTIVE
 *
 * WHY THIS EXISTS. Quiet hours forbid committing, not just pushing — a commit
 * carries a visible timestamp even when it is pushed later. So reviewed work
 * has to wait somewhere, and "in the clone it was built in" is not a place:
 * a clone is a scratch directory that the next dispatch may reprovision,
 * overwrite, or delete. Losing completed work is the one failure this repo has
 * called out as unacceptable.
 *
 * A patch bundle survives clone deletion, is diffable, and can be replayed onto
 * main in any order. Each bundle is verified by APPLYING it to a throwaway
 * index against the recorded base — an exported patch that does not apply is a
 * backup that only looks like one.
 *
 * Provisioned governance (CLAUDE.md, AGENTS.md, the routed authorities) is
 * excluded: it is orchestrator-supplied reference, not worker output, and
 * re-exporting it would make every bundle collide on the same four files.
 *
 * Usage:
 *   node Tools/backup-worker-deliverables.mjs <clone…> [--out <dir>] [--json]
 *   node Tools/backup-worker-deliverables.mjs --verify <bundle-dir>
 *
 * Exit: 0 all bundles exported and verified · 1 a bundle failed to verify · 3 cannot determine
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const JSON_MODE = argv.includes("--json");
const outIdx = argv.indexOf("--out");
const verifyIdx = argv.indexOf("--verify");
const clones = argv.filter((a, i) => {
  if (a.startsWith("--")) return false;
  if (i > 0 && (argv[i - 1] === "--out" || argv[i - 1] === "--verify"))
    return false;
  return true;
});

// Orchestrator-supplied reference, never worker output — see provision-worker-clone.
const PROVISIONED = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "migration_doc/MAINTAINER_RULINGS_2026-08-17.md",
  "migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md",
]);

function git(cwd, args, opts = {}) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
}

/**
 * Authored paths = porcelain minus provisioned reference minus the worker's own
 * _review scratch. Deliberately NOT via a trimmed helper: trimming eats the
 * leading space of the first " M path" line and silently truncates that path.
 */
function authoredPaths(clone) {
  // -uall is REQUIRED, not cosmetic. Plain `--porcelain` collapses a wholly-new
  // untracked directory to a single `dir/` entry, and the trailing-slash filter
  // below then drops it — so every file the worker created inside a new
  // directory would be silently absent from the bundle, in a tool whose entire
  // job is to lose nothing. Verified: a fresh dir reports as `?? newdir/`.
  return git(clone, ["status", "--porcelain", "-uall"])
    .split("\n")
    .filter(Boolean)
    .map((l) => ({
      status: l.slice(0, 2),
      p: l.slice(3).trim().replace(/^"|"$/g, ""),
    }))
    .filter(({ p }) => !PROVISIONED.has(p) && !p.startsWith("_review/"))
    .filter(({ p }) => !p.endsWith("/"));
}

function exportBundle(clone, outRoot) {
  const name = path.basename(clone);
  const dir = path.join(outRoot, name);
  fs.mkdirSync(dir, { recursive: true });

  const base = git(clone, ["rev-parse", "HEAD"]).trim();
  const entries = authoredPaths(clone);
  if (entries.length === 0) {
    return {
      clone: name,
      base,
      files: 0,
      status: "EMPTY",
      note: "no authored changes",
    };
  }

  const tracked = [];
  const untracked = [];
  for (const { status, p } of entries) {
    if (status === "??") untracked.push(p);
    else tracked.push(p);
  }

  // Tracked modifications: one combined patch, binary-safe.
  let patchFile = null;
  if (tracked.length > 0) {
    const patch = git(clone, ["diff", "--binary", "--", ...tracked]);
    patchFile = path.join(dir, "tracked.patch");
    fs.writeFileSync(patchFile, patch);
  }

  // Untracked files: copied verbatim. A diff against /dev/null would work too,
  // but a real copy is recoverable by hand if git itself is the thing that broke.
  const newRoot = path.join(dir, "untracked");
  for (const p of untracked) {
    const src = path.join(clone, p);
    if (!fs.existsSync(src) || fs.statSync(src).isDirectory()) continue;
    const dest = path.join(newRoot, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  const manifest = {
    clone: name,
    clonePath: path.resolve(clone),
    base,
    exportedAtUtc: new Date().toISOString(),
    tracked,
    untracked,
  };
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  // VERIFY: the patch must apply to the content it was diffed FROM, which is
  // HEAD — mirrored by the index, since a worker stages nothing. Checking it
  // against the working tree instead would always fail: that tree already
  // contains the change, so the patch has nothing left to do. `--cached` is
  // what makes this a real replay test rather than a tautology.
  let verified = "no tracked patch to verify";
  if (patchFile) {
    try {
      execFileSync(
        "git",
        ["-C", clone, "apply", "--check", "--cached", patchFile],
        {
          encoding: "utf8",
          stdio: "pipe",
        },
      );
      verified = "tracked.patch replays onto base";
    } catch (error) {
      return {
        clone: name,
        base,
        files: entries.length,
        status: "VERIFY_FAILED",
        note: String(error?.stderr || error?.message || error).split("\n")[0],
      };
    }
  }

  // Untracked copies must be byte-identical to their source.
  for (const p of untracked) {
    const src = path.join(clone, p);
    const dest = path.join(newRoot, p);
    if (!fs.existsSync(src) || fs.statSync(src).isDirectory()) continue;
    if (
      !fs.existsSync(dest) ||
      !fs.readFileSync(src).equals(fs.readFileSync(dest))
    ) {
      return {
        clone: name,
        base,
        files: entries.length,
        status: "VERIFY_FAILED",
        note: `untracked copy differs from source: ${p}`,
      };
    }
  }

  return {
    clone: name,
    base: base.slice(0, 10),
    files: entries.length,
    tracked: tracked.length,
    untracked: untracked.length,
    status: "OK",
    note: verified,
    dir,
  };
}

if (verifyIdx >= 0) {
  const bundleRoot = argv[verifyIdx + 1];
  if (!bundleRoot || !fs.existsSync(bundleRoot)) {
    process.stderr.write("usage: --verify <bundle-dir>\n");
    process.exit(3);
  }
  const dirs = fs
    .readdirSync(bundleRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(bundleRoot, d.name));
  let bad = 0;
  for (const d of dirs) {
    const mf = path.join(d, "manifest.json");
    if (!fs.existsSync(mf)) {
      process.stdout.write(`  MISSING MANIFEST  ${d}\n`);
      bad++;
      continue;
    }
    const m = JSON.parse(fs.readFileSync(mf, "utf8"));
    let missing = 0;
    for (const p of m.untracked ?? []) {
      if (!fs.existsSync(path.join(d, "untracked", p))) missing++;
    }
    const hasPatch =
      (m.tracked ?? []).length === 0 ||
      fs.existsSync(path.join(d, "tracked.patch"));
    const ok = missing === 0 && hasPatch;
    if (!ok) bad++;
    process.stdout.write(
      `  ${ok ? "OK  " : "BAD "}  ${m.clone}  base ${String(m.base).slice(0, 10)}  ` +
        `${(m.tracked ?? []).length} tracked / ${(m.untracked ?? []).length} untracked` +
        `${missing ? ` — ${missing} MISSING` : ""}${hasPatch ? "" : " — NO PATCH"}\n`,
    );
  }
  process.exit(bad === 0 ? 0 : 1);
}

if (clones.length === 0) {
  process.stderr.write(
    "usage: node Tools/backup-worker-deliverables.mjs <clone…> [--out <dir>]\n",
  );
  process.exit(3);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outRoot =
  outIdx >= 0
    ? argv[outIdx + 1]
    : path.join("f:/Dev/GH/cesium-webgpu-backups", `deliverables-${stamp}`);
fs.mkdirSync(outRoot, { recursive: true });

const results = [];
for (const clone of clones) {
  if (!fs.existsSync(path.join(clone, ".git"))) {
    results.push({ clone: path.basename(clone), status: "NOT_A_CLONE" });
    continue;
  }
  try {
    results.push(exportBundle(clone, outRoot));
  } catch (error) {
    results.push({
      clone: path.basename(clone),
      status: "ERROR",
      note: String(error?.message ?? error).split("\n")[0],
    });
  }
}

// NOT_A_CLONE counts as failure: a mistyped or already-deleted path must not
// exit 0 under a banner saying everything was backed up. EMPTY counts too — the
// caller asked for a clone's work and there was none, which is either the wrong
// path or work that vanished, and both deserve a non-zero exit rather than a
// quiet line in a list nobody re-reads.
const failed = results.filter((r) => r.status !== "OK");

if (JSON_MODE) {
  process.stdout.write(`${JSON.stringify({ outRoot, results }, null, 2)}\n`);
} else {
  process.stdout.write(`backup → ${outRoot}\n`);
  for (const r of results) {
    process.stdout.write(
      `  ${r.status.padEnd(14)} ${String(r.clone).padEnd(26)} ` +
        `${r.files ?? 0} file(s)${r.note ? ` — ${r.note}` : ""}\n`,
    );
  }
  process.stdout.write(
    failed.length === 0
      ? "\n  All bundles exported and verified. Safe to reprovision or delete the clones.\n"
      : `\n  ${failed.length} bundle(s) FAILED — do NOT delete those clones.\n`,
  );
}

process.exit(failed.length === 0 ? 0 : 1);
