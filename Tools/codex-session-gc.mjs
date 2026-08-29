// codex-session-gc.mjs
//
// @purpose Project-scoped garbage collection for codex CLI session rollouts: lists, and on request deletes, only the sessions whose recorded cwd is under this project's worker roots, so other projects' history is never touched.
// @status ACTIVE
//
// The codex CLI keeps every session's rollout forever under ~/.codex/sessions
// and offers no bulk pruning. A wholesale wipe loses other projects' history,
// which is what the first cleanup did. Each rollout's first line is a
// session_meta record carrying the session id, the working directory it ran
// in, and its timestamp, so ownership is decidable per file: a cwd under one
// of this project's roots is ours, anything else is not and is reported only
// as a count. A session is terminal when its stream carries task_complete;
// non-terminal sessions may hold unharvested worker output and are skipped
// unless explicitly included.
//
// Usage:
//   node Tools/codex-session-gc.mjs                       list ours (dry run)
//   node Tools/codex-session-gc.mjs --older-than 48       list ours older than 48 h
//   node Tools/codex-session-gc.mjs --delete-ids a,b,c    delete named sessions (ours only)
//   node Tools/codex-session-gc.mjs --older-than 48 --delete [--include-nonterminal]
//   --root <path>   add a project root (repeatable); defaults cover this fork's clone layout
//   --json          machine-readable report
//
// Deletion goes through `codex delete <id>` so the CLI's own index stays
// consistent, falling back to removing the rollout file when the CLI refuses
// (an already-unindexed session). Exit 0 on success, 1 on any refusal, 2 on
// scan failure.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const roots = [
  "F:/Dev/GH/cesium-webgpu",
  "F:/Dev/GH/cesium-lane-",
  "F:/Dev/GH/cesium-worker-",
  "F:/Dev/GH/cesium-audit-proto",
];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root" && args[i + 1]) roots.push(args[i + 1]);
}
const norm = (p) =>
  String(p ?? "")
    .replace(/\\/g, "/")
    .toLowerCase();
const isOurs = (cwd) => roots.some((r) => norm(cwd).startsWith(norm(r)));

const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
const codexBin =
  process.env.CODEX_BIN ??
  "C:/Users/Kurt/AppData/Local/OpenAI/Codex/bin/cfac6bda2d141e07/codex.exe";

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl"))
      out.push(p);
  }
  return out;
}

let files;
try {
  files = walk(sessionsRoot, []);
} catch (error) {
  console.error(
    `codex-session-gc: cannot scan ${sessionsRoot}: ${error.message}`,
  );
  process.exit(2);
}

const now = Date.now();
const ours = [];
let others = 0;
let unreadable = 0;
for (const file of files) {
  let meta;
  let terminal;
  try {
    const text = fs.readFileSync(file, "utf8");
    const first = text.slice(0, text.indexOf("\n"));
    const j = JSON.parse(first);
    meta = j.payload ?? j;
    terminal = text.includes('"task_complete"');
  } catch {
    unreadable += 1;
    continue;
  }
  if (!isOurs(meta.cwd)) {
    others += 1;
    continue;
  }
  const stamp = Date.parse(meta.timestamp ?? "") || fs.statSync(file).mtimeMs;
  ours.push({
    id: meta.id ?? meta.session_id,
    cwd: meta.cwd,
    file,
    ageHours: Math.round((now - stamp) / 36e5),
    bytes: fs.statSync(file).size,
    terminal,
  });
}

const olderThan = Number(value("--older-than") ?? NaN);
const deleteIds = (value("--delete-ids") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const doDelete = flag("--delete") || deleteIds.length > 0;
const includeNonterminal = flag("--include-nonterminal");

let selected = ours;
if (deleteIds.length > 0)
  selected = ours.filter((s) => deleteIds.includes(s.id));
else if (Number.isFinite(olderThan))
  selected = ours.filter((s) => s.ageHours >= olderThan);
if (!includeNonterminal)
  selected = selected.filter((s) => s.terminal || deleteIds.includes(s.id));

const report = {
  scanned: files.length,
  ours: ours.length,
  otherProjects: others,
  unreadable,
  selected: selected.map((s) => ({
    id: s.id,
    ageHours: s.ageHours,
    bytes: s.bytes,
    terminal: s.terminal,
    cwd: s.cwd,
  })),
  deleted: [],
  refused: [],
};

if (doDelete) {
  for (const s of selected) {
    let viaCli;
    try {
      execFileSync(codexBin, ["delete", s.id], {
        stdio: "pipe",
        timeout: 60_000,
      });
      viaCli = true;
    } catch {
      viaCli = false;
    }
    if (fs.existsSync(s.file)) {
      try {
        fs.rmSync(s.file);
      } catch (error) {
        report.refused.push({ id: s.id, reason: error.message });
        continue;
      }
    }
    report.deleted.push({ id: s.id, bytes: s.bytes, viaCli });
  }
}

if (flag("--json")) {
  console.log(JSON.stringify(report, null, 1));
} else {
  console.log(
    `codex-session-gc: scanned ${report.scanned}, ours ${report.ours}, other projects ${report.otherProjects} (untouched), unreadable ${report.unreadable}`,
  );
  for (const s of report.selected) {
    console.log(
      `  ${doDelete ? (report.deleted.some((d) => d.id === s.id) ? "DELETED " : "REFUSED ") : "select  "}${s.id}  ${s.ageHours}h  ${(s.bytes / 1024).toFixed(0)}KB  ${s.terminal ? "terminal" : "NON-TERMINAL"}  ${s.cwd}`,
    );
  }
  if (!doDelete)
    console.log("(dry run - pass --delete or --delete-ids to remove)");
}
process.exit(report.refused.length > 0 ? 1 : 0);
