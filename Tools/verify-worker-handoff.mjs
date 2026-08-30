#!/usr/bin/env node
/**
 * Worker handoff validation.
 * @purpose Mechanically validate a worker clone before review: lease compliance, no git writes, no conflict artifacts, header and comment-marker rules, and execution of every spec the worker added.
 * @status ACTIVE
 *
 * WHY THIS EXISTS. Charter §4.6 forbids an author approving its own work, and a
 * handoff report is the author's account of itself. Across five live dispatches
 * the reports were honest but incomplete in ways that mattered: one omitted its
 * final test counts entirely while faithfully reporting an earlier failure, and
 * one never existed because the worker was hard-killed mid-write. A reviewer
 * reading summaries would have banked a broken deliverable.
 *
 * This tool checks the mechanizable half so the reviewer's attention goes to the
 * half that cannot be mechanized: is the control non-vacuous, does the change
 * follow the fork's existing pattern, is the reasoning sound.
 *
 * IT DOES NOT DECIDE. A green run means "ready for review", never "correct".
 *
 * Usage:
 *   node Tools/verify-worker-handoff.mjs <clone> --lease <path> [--lease <path>…]
 *        [--base <rev>] [--json] [--no-specs]
 *
 * Exit: 0 ready for review · 1 violations found · 3 cannot determine
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const JSON_MODE = argv.includes("--json");
const RUN_SPECS = !argv.includes("--no-specs");
const clone = argv.find((a) => !a.startsWith("--"));
const leases = argv.reduce((acc, a, i) => {
  if (a === "--lease" && argv[i + 1]) acc.push(argv[i + 1].replace(/\\/g, "/"));
  return acc;
}, []);
const baseIdx = argv.indexOf("--base");
const base = baseIdx >= 0 ? argv[baseIdx + 1] : "main";

const violations = [];
const notes = [];
const specRuns = [];

const fail = (m) => violations.push(m);

function git(args, opts = {}) {
  return execFileSync("git", ["-C", clone, ...args], {
    encoding: "utf8",
    ...opts,
  }).trim();
}

if (!clone || !fs.existsSync(path.join(clone, ".git"))) {
  process.stderr.write(
    "usage: node Tools/verify-worker-handoff.mjs <clone> --lease <path>…\n",
  );
  process.exit(3);
}
if (leases.length === 0) {
  process.stderr.write("at least one --lease is required\n");
  process.exit(3);
}

// --- 1. no git writes ------------------------------------------------------
// R-2026-08-18-28: workers never commit. The branch tip must still equal its
// base; anything else means the worker took an action reserved to the
// orchestrator, and the handoff is void regardless of how good the code is.
let head;
try {
  head = git(["rev-parse", "HEAD"]);
  const baseSha = git(["rev-parse", base]);
  if (head !== baseSha) {
    fail(
      `worker moved the branch: HEAD ${head.slice(0, 10)} != ${base} ${baseSha.slice(0, 10)} — workers never run git writes`,
    );
  } else {
    notes.push(`branch unmoved at ${head.slice(0, 10)} (no git writes)`);
  }
} catch (error) {
  process.stderr.write(`cannot resolve revisions: ${error?.message}\n`);
  process.exit(3);
}

// --- 2. the worker actually did something ----------------------------------
// NOT via git(): that helper trims its output, which eats the leading space of
// the first " M path" line and shifts every subsequent slice(3) by one
// character. The first modified path in every report silently lost its initial
// letter, which then failed lease matching and made its spec unrunnable.
// -uall for the same reason as the backup tool: plain `--porcelain` collapses a
// new untracked directory to one `dir/` entry, which would pass the lease check
// as a single path and then skip the conflict-marker, header and comment-marker
// scans for every file inside it.
const porcelain = execFileSync(
  "git",
  ["-C", clone, "status", "--porcelain", "-uall"],
  {
    encoding: "utf8",
  },
)
  .split("\n")
  .filter(Boolean);
const changed = porcelain
  .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
  .filter((p) => !p.startsWith("_review/"));

const inLease = (p) =>
  leases.some((l) => p === l || p.startsWith(l.endsWith("/") ? l : `${l}/`));

// Provisioned reference is not the worker's output — see provision-worker-clone.
const PROVISIONED = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "migration_doc/MAINTAINER_RULINGS_2026-08-17.md",
  "migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md",
]);
// Ignore provisioner drift unless the path is explicitly leased. Once leased,
// the same path is worker output and must pass every handoff check below.
const authored = changed.filter((p) => !PROVISIONED.has(p) || inLease(p));

if (authored.length === 0) {
  fail("no authored changes — the worker produced nothing");
}

// --- 3. lease compliance ---------------------------------------------------
for (const p of authored) {
  if (!inLease(p)) {
    fail(`outside the declared lease: ${p}`);
  }
}
if (authored.length > 0 && violations.length === 0) {
  notes.push(`${authored.length} authored path(s), all inside the lease`);
}

// --- 4. conflict artifacts -------------------------------------------------
// A badly-resolved merge or a failed patch leaves these behind, and one sat
// unnoticed in this repo for three days while a status row silently disagreed
// with itself. Cheap to check, expensive to miss.
for (const p of authored) {
  if (/\.(rej|orig)$/.test(p)) {
    fail(`conflict artifact left in tree: ${p}`);
  }
}
for (const p of authored) {
  const full = path.join(clone, p);
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue;
  const text = fs.readFileSync(full, "utf8");
  if (/^<{7} |^={7}$|^>{7} /m.test(text)) {
    fail(`unresolved conflict markers in ${p}`);
  }
}

// --- 5. header + comment-marker rules --------------------------------------
const TRACKER =
  /\b(?:Batch\s+\d{3,4}|C1[0-9]-\d+|R-20\d\d-\d\d-\d\d-\d+|DP-H\d+|FAR-\d+)\b/;
for (const p of authored) {
  const full = path.join(clone, p);
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue;
  const text = fs.readFileSync(full, "utf8");

  // Tools/ files self-register via a purpose header — but match the REAL scope.
  // purpose-header-allowlist.mjs:34 covers probe-*.mjs "(excluding .spec.mjs)"
  // and lib/*-gate.mjs. Applying it to every Tools/ file would be stricter than
  // the fleet contract itself and would red compliant work.
  const needsHeader =
    /^Tools\/visual-regression\/probe-[^/]+\.mjs$/.test(p) ||
    /^Tools\/visual-regression\/lib\/.*-gate\.mjs$/.test(p);
  if (needsHeader) {
    if (!/@purpose\s+\S/.test(text)) fail(`missing @purpose header: ${p}`);
    if (!/@status\s+\S/.test(text)) fail(`missing @status header: ${p}`);
  }

  // Campaign 16: engine source comments must be seamless with upstream — the
  // tracker belongs in the commit message, never in the shipped code.
  //
  // Scan only the worker's ADDED lines, never the whole file. The fleet carries
  // substantial pre-existing C16 debt (Scene.js:456 has cited Batch 219 since
  // long before any of this work), and blaming a worker for debt it merely
  // touched the same file as is a false positive that reds compliant work.
  if (/^packages\/[^/]+\/Source\//.test(p)) {
    // Ask whether the path is tracked; do NOT infer it from `git diff` throwing.
    // `git diff -- <untracked path>` exits 0 with EMPTY output, so an exception
    // never arrives, `added` stays empty, and the scan below silently passes —
    // meaning this control was dead for exactly the case it most needs to cover:
    // a brand-new engine source file, every line of which is the worker's.
    let tracked = true;
    try {
      execFileSync(
        "git",
        ["-C", clone, "ls-files", "--error-unmatch", "--", p],
        {
          stdio: "ignore",
        },
      );
    } catch {
      tracked = false;
    }

    const added = tracked
      ? execFileSync("git", ["-C", clone, "diff", "--", p], {
          encoding: "utf8",
        })
      : // Untracked: every line is new, so the whole text is the added set.
        text
          .split(/\r?\n/)
          .map((l) => `+${l}`)
          .join("\n");
    for (const line of added.split(/\r?\n/)) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      const body = line.slice(1);
      if (/^\s*(\/\/|\*|\/\*)/.test(body) && TRACKER.test(body)) {
        fail(
          `tracker ID in an ADDED engine-source comment (Campaign 16): ${p} — ${body.trim().slice(0, 70)}`,
        );
        break;
      }
    }
  }
}

// --- 6. run the specs the worker added -------------------------------------
if (RUN_SPECS) {
  // `*Spec.mjs` must be in this set. Engine node:test specs deliberately use
  // that extension because `scripts/build.js:622` globs `Specs/**/*Spec.js`
  // into the Karma SpecList, and a `node:` import at a `.js` path breaks the
  // whole engine spec bundle. Omitting the extension here made the verifier
  // report "no spec file among the authored paths" for exactly the specs that
  // follow the rule — silently skipping the ones most likely to be correct.
  const specs = authored.filter(
    (p) =>
      /\.spec\.(mjs|js)$/.test(p) ||
      /Spec\.js$/.test(p) ||
      /Spec\.mjs$/.test(p),
  );
  if (specs.length === 0) {
    notes.push("no spec file among the authored paths — verify by hand");
  }
  for (const spec of specs) {
    if (!/\.mjs$/.test(spec)) {
      // Jasmine-style engine Specs need the Karma harness; out of scope here.
      specRuns.push({ spec, result: "SKIPPED (not a node --test spec)" });
      continue;
    }
    const r = spawnSync("node", ["--test", spec], {
      cwd: clone,
      encoding: "utf8",
      timeout: 600_000,
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const pass = /^# pass (\d+)/m.exec(out)?.[1] ?? "?";
    const failed = /^# fail (\d+)/m.exec(out)?.[1] ?? "?";
    specRuns.push({
      spec,
      result: `${pass} pass / ${failed} fail (exit ${r.status})`,
    });
    if (r.status !== 0) {
      fail(`spec does not pass: ${spec} — ${pass} pass / ${failed} fail`);
    }
  }
}

const result = {
  clone,
  status: violations.length === 0 ? "READY_FOR_REVIEW" : "VIOLATIONS",
  head: head.slice(0, 10),
  authored,
  specRuns,
  notes,
  violations,
};

if (JSON_MODE) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`handoff: ${result.status}\n  ${clone}\n`);
  for (const p of authored) process.stdout.write(`  authored     ${p}\n`);
  for (const s of specRuns)
    process.stdout.write(`  spec         ${s.spec} — ${s.result}\n`);
  for (const n of notes) process.stdout.write(`  note         ${n}\n`);
  for (const v of violations) process.stdout.write(`  VIOLATION    ${v}\n`);
  if (violations.length === 0) {
    process.stdout.write(
      "\n  Mechanical checks pass. This is READY FOR REVIEW, not CORRECT —\n" +
        "  a human or non-author reviewer still owes: is the control non-vacuous,\n" +
        "  does it follow the existing fork pattern, is the reasoning sound.\n",
    );
  }
}

process.exit(violations.length === 0 ? 0 : 1);
