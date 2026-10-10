// rebase-shared.mjs - landing-time rebase of a probe-kit harvest lane's SHARED-FILE hunks.
// @purpose Rebase a frozen probe-family lane patch's hunks on the shared rig census, RIG_TAGS and shrink-only allowlists onto the current tip as their semantic union, refusing by name anything it cannot reproduce as row operations, so two families landing in sequence stop conflicting textually.
// @status ACTIVE
//
// WHY THIS EXISTS. Every probe-family landing of the DX-108 harvest edits the same few shared files on top of
// an old base, so each landing moves the tip and the next lane's hunks on those files conflict textually although
// the edits compose semantically. The files this tool OWNS:
//   - Tools/visual-regression/rig-registry.spec.mjs   REGISTRY_CENSUS.total and byTag keys (counts)
//   - Tools/visual-regression/lib/rig-registry.mjs    the frozen RIG_TAGS array (append-only tag set)
//   - Tools/visual-regression/lib/*-allowlist.mjs     shrink-only row lists (a row = key line + value lines)
// It does NOT own the two kinds of shared file that only grow at the end: the ledgers' end-of-file appends
// (migration_doc/WEBGPU_DEBUGGING_LOG.md, DEFERRED_WORK.md, FEATURE_INVENTORY.md and the package.json tail), and
// Tools/visual-regression/archive/README.md; the landing script's union resolver handles those, and the manifest
// this tool prints names each of those five files the lane touches (UNOWNED_RE) on its "not owned" line.
//
// WHAT IT DOES. It takes the FROZEN lane patch (md5 verified first), and for each shared-file section decides:
//   * the section applies to <base> as-is  -> kept byte-for-byte;
//   * otherwise -> replaced with a hunk freshly generated against <base> that applies the lane's SEMANTIC
//     change, derived from the lane's own pre- and post-image of the file (so a lane edit the model does
//     not own is REFUSED by name, never guessed). Every other section passes through untouched.
// The tool is read-only on the repo: every apply check runs through a throwaway index whose object writes
// are quarantined in a temp object directory (the repo's object store is an alternate, read-only). Any <out>
// and <out>.md5 left by an earlier run are removed before anything else, so a refused run leaves no stale output.
//
// Usage: node Tools/landing/rebase-shared.mjs --repo <seat> --lane <lane.patch> --lane-md5 <md5> --out <out.patch>
//          [--base <rev>=HEAD] [--lane-repo <clone>]... [--tmp-root <dir>]
// Exit: 0 ok; 2 refusal (one-line reason on stderr, nothing written); 1 usage error.
// Spec: node --test Tools/landing/rebase-shared.spec.mjs   See Tools/landing/README.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

const CENSUS_PATH = "Tools/visual-regression/rig-registry.spec.mjs";
const TAGS_PATH = "Tools/visual-regression/lib/rig-registry.mjs";
const ALLOWLIST_RE = /^Tools\/visual-regression\/lib\/[^/]+-allowlist\.mjs$/;
// End-of-file appends owned by the landing script's union resolver, not by this tool. This feeds only the
// manifest and the whole-patch note on stdout; it never changes the bytes written to <out>.
const UNOWNED_RE =
  /^(migration_doc\/(WEBGPU_DEBUGGING_LOG|DEFERRED_WORK|FEATURE_INVENTORY)\.md|package\.json|Tools\/visual-regression\/archive\/README\.md)$/;

class Refusal extends Error {}
const refuse = (msg) => {
  throw new Refusal(msg);
};
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");

// ---------------------------------------------------------------------------------------------
// git plumbing (read-only on the repo)
// ---------------------------------------------------------------------------------------------
function makeGit(repo, tmpRoot) {
  const objDirs = execFileSync(
    "git",
    [
      "-C",
      repo,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ],
    {
      encoding: "utf8",
    },
  ).trim();
  const quarantine = path.join(tmpRoot, "objects");
  fs.mkdirSync(quarantine, { recursive: true });
  const env = {
    ...process.env,
    GIT_INDEX_FILE: path.join(tmpRoot, "throwaway.index"),
    GIT_OBJECT_DIRECTORY: quarantine,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: objDirs,
  };
  const run = (args, o = {}) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "latin1",
      env: o.env ?? env,
      input: o.input,
      maxBuffer: 1 << 30,
      stdio: ["pipe", "pipe", "pipe"],
    });
  // stdout + stderr together (git apply reports conflicts on stderr even when it exits 0 for some modes)
  const runBoth = (args, o = {}) => {
    const r = spawnSync("git", ["-C", repo, ...args], {
      encoding: "latin1",
      env,
      input: o.input,
      maxBuffer: 1 << 30,
    });
    if (r.error) throw r.error;
    if (r.status !== 0)
      throw Object.assign(new Error("git " + args[0] + " failed"), {
        stderr: r.stderr,
        stdout: r.stdout,
      });
    return r.stdout + r.stderr;
  };
  return {
    run,
    runBoth,
    baseSha: null,
    env,
    quarantine,
    alternates: objDirs,
    showBlob: (rev, p) => run(["show", `${rev}:${p}`], { env: process.env }),
    resolve: (rev) =>
      run(["rev-parse", "--verify", `${rev}^{commit}`], {
        env: process.env,
      }).trim(),
    blobOid: (rev, p) =>
      run(["rev-parse", "--verify", `${rev}:${p}`], {
        env: process.env,
      }).trim(),
  };
}

// ---------------------------------------------------------------------------------------------
// patch parsing
// ---------------------------------------------------------------------------------------------
function splitSections(text) {
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (cur) out.push(cur);
      cur = { header: line, lines: [line] };
    } else if (cur) cur.lines.push(line);
    else {
      cur = { header: "(preamble)", lines: [line] };
    }
  }
  if (cur) out.push(cur);
  return out;
}

function parseSection(section) {
  const m = section.header.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!m) return null;
  const info = { path: m[2], plain: m[1] === m[2], hunks: [], indexOld: null };
  let i = 1;
  const L = section.lines;
  for (; i < L.length && !L[i].startsWith("@@ "); i++) {
    const idx = L[i].match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/);
    if (idx) info.indexOld = idx[1];
    if (
      /^(new file mode|deleted file mode|rename |copy |old mode|new mode|similarity |GIT binary patch|Binary files)/.test(
        L[i],
      )
    )
      info.plain = false;
  }
  while (i < L.length && L[i].startsWith("@@ ")) {
    const h = L[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!h) refuse(`${info.path}: unreadable hunk header`);
    const hunk = {
      oldStart: Number(h[1]),
      oldCount: h[2] === undefined ? 1 : Number(h[2]),
      newCount: h[4] === undefined ? 1 : Number(h[4]),
      lines: [],
    };
    i++;
    let o = 0;
    let n = 0;
    while (
      i < L.length &&
      (o < hunk.oldCount || n < hunk.newCount || L[i].startsWith("\\"))
    ) {
      const l = L[i];
      if (l.startsWith("\\"))
        refuse(
          `${info.path}: "no newline at end of file" edits are not modelled`,
        );
      const c = l[0];
      if (c === " ") {
        o++;
        n++;
      } else if (c === "-") o++;
      else if (c === "+") n++;
      else if (l === "" && i === L.length - 1) break;
      else refuse(`${info.path}: unreadable hunk line`);
      hunk.lines.push(l);
      i++;
    }
    if (o !== hunk.oldCount || n !== hunk.newCount)
      refuse(`${info.path}: hunk line counts disagree with its header`);
    info.hunks.push(hunk);
  }
  return info;
}

// Strict application of a section's hunks onto the exact pre-image the lane was cut from.
function applyHunks(oldText, info) {
  const src = oldText.split("\n");
  const out = [];
  let pos = 0;
  for (const h of info.hunks) {
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    if (start < pos) refuse(`${info.path}: overlapping hunks`);
    out.push(...src.slice(pos, start));
    let at = start;
    for (const l of h.lines) {
      const c = l[0];
      const body = l.slice(1);
      if (c === " " || c === "-") {
        if (src[at] !== body)
          refuse(
            `${info.path}: lane hunk does not match its own pre-image blob`,
          );
        at++;
        if (c === " ") out.push(body);
      } else out.push(body);
    }
    pos = at;
  }
  out.push(...src.slice(pos));
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------
// diff generation against the base
// ---------------------------------------------------------------------------------------------
function makeDiff(git, tmpRoot, relPath, before, after, baseOid) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "diff-"));
  for (const side of ["a", "b"])
    fs.mkdirSync(path.join(dir, side, path.dirname(relPath)), {
      recursive: true,
    });
  fs.writeFileSync(path.join(dir, "a", relPath), Buffer.from(before, "latin1"));
  fs.writeFileSync(path.join(dir, "b", relPath), Buffer.from(after, "latin1"));
  let out = "";
  try {
    execFileSync(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.safecrlf=false",
        "diff",
        "--no-index",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
        "--abbrev=10",
        "--src-prefix=",
        "--dst-prefix=",
        `a/${relPath}`,
        `b/${relPath}`,
      ],
      {
        cwd: dir,
        encoding: "latin1",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 1 << 30,
      },
    );
  } catch (err) {
    if (err.status !== 1)
      refuse(
        `${relPath}: git diff failed (${String(err.message).split("\n")[0]})`,
      );
    out = err.stdout;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  if (out === "") return "";
  const idx = out.match(/^index ([0-9a-f]+)\.\./m);
  if (!idx || !baseOid.startsWith(idx[1]))
    refuse(
      `${relPath}: regenerated hunk was cut from a different blob than ${baseOid.slice(0, 10)} (line-ending filter?)`,
    );
  return out;
}

// ---------------------------------------------------------------------------------------------
// row model for `export const X = Object.freeze({ ... });` / `Object.freeze([ ... ]);` blocks
// ---------------------------------------------------------------------------------------------
const OPEN_RE =
  /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*Object\.freeze\(([{[])\s*$/;
const CLOSE_RE = /^[}\]]\)\s*;?\s*$/;
const OBJ_ROW_RE =
  /^ {2}("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_$][\w$]*)\s*:/;
const isComment = (l) => /^\s*(\/\/|\/\*|\*)/.test(l);

function parseBlocks(lines, where) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(OPEN_RE);
    if (!m) continue;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (CLOSE_RE.test(lines[j])) {
        close = j;
        break;
      }
    }
    if (close < 0) refuse(`${where}: block ${m[1]} never closes`);
    const kind = m[2] === "{" ? "obj" : "arr";
    const body = lines.slice(i + 1, close);
    const rows = [];
    const preamble = [];
    let pending = [];
    const flushToPrev = () => {
      if (!pending.length) return;
      (rows.length ? rows.at(-1).lines : preamble).push(...pending);
      pending = [];
    };
    for (const line of body) {
      let key = null;
      if (kind === "obj") {
        const k = line.match(OBJ_ROW_RE);
        if (k) key = k[1].replace(/^["']|["']$/g, "");
      } else if (/^ {2}\S/.test(line) && !isComment(line)) {
        key = line.trim().replace(/,$/, "");
      }
      if (key !== null) {
        rows.push({ key, lines: [...pending, line] });
        pending = [];
      } else if (isComment(line) && /^\s{2}/.test(line)) pending.push(line);
      else {
        flushToPrev();
        (rows.length ? rows.at(-1).lines : preamble).push(line);
      }
    }
    flushToPrev();
    if (new Set(rows.map((r) => r.key)).size !== rows.length)
      refuse(`${where}: block ${m[1]} has duplicate row keys`);
    const flat = [...preamble, ...rows.flatMap((r) => r.lines)];
    if (flat.join("\n") !== body.join("\n"))
      refuse(`${where}: block ${m[1]} did not parse losslessly`);
    blocks.push({ name: m[1], kind, open: i, close, preamble, rows });
    i = close;
  }
  return blocks;
}

// Work on LF text; remember the file's line ending and put it back (a mixed-ending file is refused).
function lfView(text, where) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  if (crlf !== 0 && crlf !== lf)
    refuse(`${where}: mixed line endings; not guessing`);
  return {
    lf: crlf ? text.replace(/\r\n/g, "\n") : text,
    eol: crlf ? "\r\n" : "\n",
  };
}
const restoreEol = (text, eol) =>
  eol === "\n" ? text : text.replace(/\n/g, eol);

const rowText = (r) => r.lines.join("\n");

// Everything of the file that is not a block's rows, with each block body reduced to its preamble.
function outsideText(lines, blocks) {
  const parts = [];
  let at = 0;
  for (const b of blocks) {
    parts.push(
      lines.slice(at, b.open + 1).join("\n"),
      `<<${b.name}:${b.preamble.join("\n")}>>`,
    );
    at = b.close;
  }
  parts.push(lines.slice(at).join("\n"));
  return parts.join("\n");
}

function rowDiff(oldBlock, newBlock) {
  const oldMap = new Map(oldBlock.rows.map((r) => [r.key, r]));
  const newMap = new Map(newBlock.rows.map((r) => [r.key, r]));
  const removed = oldBlock.rows.filter((r) => !newMap.has(r.key));
  const changed = newBlock.rows
    .filter(
      (r) => oldMap.has(r.key) && rowText(oldMap.get(r.key)) !== rowText(r),
    )
    .map((r) => ({ old: oldMap.get(r.key), row: r }));
  const added = [];
  newBlock.rows.forEach((r, i) => {
    if (!oldMap.has(r.key))
      added.push({ row: r, pred: i === 0 ? null : newBlock.rows[i - 1].key });
  });
  return { removed, added, changed };
}

function hasComma(r) {
  const code = r.lines.filter((l) => !isComment(l) && l.trim() !== "");
  return code.length > 0 && /,\s*$/.test(code.at(-1));
}

// Apply a per-block row diff to `lines` (the base, or a lane's own pre-image for the self-check).
// policy.arr: arrays append and tolerate absent removals; objects insert after the predecessor
// and refuse an absent removal.
function applyRowOps(lines, opsByBlock, where, notes) {
  const blocks = parseBlocks(lines, where);
  const result = lines.slice();
  // Edit blocks bottom-up so earlier indexes stay valid.
  const targets = blocks
    .filter((b) => opsByBlock.has(b.name))
    .sort((a, b) => b.open - a.open);
  for (const name of opsByBlock.keys())
    if (!blocks.some((b) => b.name === name))
      refuse(`${where}: base has no block ${name}`);
  for (const b of targets) {
    const ops = opsByBlock.get(b.name);
    const rows = b.rows.map((r) => ({ key: r.key, lines: r.lines.slice() }));
    const find = (key) => rows.findIndex((r) => r.key === key);
    const isArr = b.kind === "arr";
    for (const r of ops.removed) {
      const i = find(r.key);
      if (i < 0) {
        if (isArr) {
          notes.push(
            `${b.name}: lane removes ${r.key}, absent at base (tolerated)`,
          );
          continue;
        }
        refuse(
          `${where}: lane removes row ${r.key} from ${b.name} but the base no longer has it (family landed twice, or the row moved)`,
        );
      }
      if (rowText(rows[i]) !== rowText(r))
        notes.push(
          `${b.name}: removed row ${r.key} whose text differs from the lane's pre-image`,
        );
      rows.splice(i, 1);
    }
    for (const c of ops.changed) {
      const i = find(c.row.key);
      if (i < 0)
        refuse(
          `${where}: lane edits row ${c.row.key} of ${b.name} but the base no longer has it`,
        );
      if (rowText(rows[i]) === rowText(c.row)) continue;
      if (rowText(rows[i]) !== rowText(c.old))
        refuse(
          `${where}: row ${c.row.key} of ${b.name} drifted at the base; lane edit would be a guess`,
        );
      rows[i] = { key: c.row.key, lines: c.row.lines.slice() };
      notes.push(`${b.name}: changed row ${c.row.key}`);
    }
    for (const a of ops.added) {
      const i = find(a.row.key);
      if (i >= 0) {
        if (rowText(rows[i]) === rowText(a.row)) {
          notes.push(
            `${b.name}: row ${a.row.key} already present (identical, skipped)`,
          );
          continue;
        }
        refuse(
          `${where}: lane adds row ${a.row.key} to ${b.name} but the base has a different one`,
        );
      }
      if (!hasComma(a.row))
        refuse(
          `${where}: lane row ${a.row.key} lacks a trailing comma; not guessing`,
        );
      let at;
      if (isArr) at = rows.length;
      else if (a.pred === null) at = 0;
      else {
        const p = find(a.pred);
        at = p < 0 ? rows.length : p + 1;
      }
      if (at > 0 && !hasComma(rows[at - 1]))
        refuse(
          `${where}: base row ${rows[at - 1].key} of ${b.name} lacks a trailing comma; not guessing`,
        );
      rows.splice(at, 0, { key: a.row.key, lines: a.row.lines.slice() });
    }
    const body = [...b.preamble, ...rows.flatMap((r) => r.lines)];
    result.splice(b.open + 1, b.close - b.open - 1, ...body);
  }
  return result;
}

const canonicalRows = (lines, where) => {
  const blocks = parseBlocks(lines, where);
  return (
    outsideText(lines, blocks) +
    "\n##\n" +
    blocks
      .map(
        (b) =>
          `${b.name}\n${b.rows
            .map((r) => `${r.key}=>${rowText(r)}`)
            .sort()
            .join("\n")}`,
      )
      .join("\n--\n")
  );
};

// kind: "tags" | "allowlist"
function rebaseRowFile(relPath, baseText, oldText0, newText0) {
  const where = relPath;
  const oldText = lfView(oldText0, where).lf;
  const newText = lfView(newText0, where).lf;
  const oldL = oldText.split("\n");
  const newL = newText.split("\n");
  const oldB = parseBlocks(oldL, where);
  const newB = parseBlocks(newL, where);
  if (oldB.map((b) => b.name).join() !== newB.map((b) => b.name).join())
    refuse(`${where}: lane adds or removes a whole block`);
  if (outsideText(oldL, oldB) !== outsideText(newL, newB))
    refuse(`${where}: lane edits the file outside its rows`);
  const ops = new Map();
  const summary = [];
  for (let i = 0; i < oldB.length; i++) {
    const d = rowDiff(oldB[i], newB[i]);
    if (relPath === TAGS_PATH && oldB[i].name !== "RIG_TAGS") {
      if (d.removed.length || d.added.length || d.changed.length)
        refuse(
          `${where}: lane edits block ${oldB[i].name}, only RIG_TAGS is modelled`,
        );
      continue;
    }
    if (relPath === TAGS_PATH && d.changed.length)
      refuse(`${where}: lane rewrites an existing RIG_TAGS entry`);
    if (d.removed.length || d.added.length || d.changed.length) {
      ops.set(oldB[i].name, d);
      summary.push({ block: oldB[i].name, ...d });
    }
  }
  // Self-check: the model, applied to the lane's own pre-image, must reproduce the lane's post-image.
  const selfNotes = [];
  const reproduced = applyRowOps(oldL, ops, where, selfNotes);
  if (canonicalRows(reproduced, where) !== canonicalRows(newL, where))
    refuse(`${where}: lane edit is not reproducible as row operations`);
  const notes = [];
  const { lf, eol } = lfView(baseText, where);
  const after = restoreEol(
    applyRowOps(lf.split("\n"), ops, where, notes).join("\n"),
    eol,
  );
  return { after, summary, notes };
}

// ---------------------------------------------------------------------------------------------
// census spec (REGISTRY_CENSUS.total + byTag)
// ---------------------------------------------------------------------------------------------
const CENSUS_ENTRY_RE = /^\s*("[^"]+"|[\w-]+)\s*:\s*(\d+),\s*$/;

function parseCensus(lines, where) {
  const ti = lines.findIndex((l) => /^\s*total:\s*\d+,\s*$/.test(l));
  if (ti < 0) refuse(`${where}: no census total line`);
  const bi = lines.findIndex((l) => /byTag:\s*\{/.test(l));
  if (bi < 0) refuse(`${where}: no byTag block`);
  let close = -1;
  for (let i = bi + 1; i < lines.length; i++) {
    if (/^\s*\},?\s*$/.test(lines[i])) {
      close = i;
      break;
    }
  }
  if (close < 0) refuse(`${where}: byTag block never closes`);
  const entries = [];
  let pending = [];
  for (let i = bi + 1; i < close; i++) {
    const m = lines[i].match(CENSUS_ENTRY_RE);
    if (m) {
      entries.push({
        key: m[1].replace(/"/g, ""),
        value: Number(m[2]),
        comments: pending,
        line: lines[i],
      });
      pending = [];
    } else if (isComment(lines[i])) pending.push(lines[i]);
    else refuse(`${where}: unreadable byTag line ${i + 1}`);
  }
  if (pending.length) refuse(`${where}: byTag ends in a dangling comment`);
  return { ti, bi, close, total: Number(lines[ti].match(/(\d+)/)[1]), entries };
}

function censusCanonical(lines, where) {
  const c = parseCensus(lines, where);
  const outside = lines
    .slice(0, c.ti)
    .concat(
      ["<total>"],
      lines.slice(c.ti + 1, c.bi + 1),
      ["<byTag>"],
      lines.slice(c.close),
    );
  return JSON.stringify([
    outside,
    c.total,
    c.entries.map((e) => [e.key, e.value, e.comments]).sort(),
  ]);
}

function applyCensusOps(lines, ops, where, notes) {
  const c = parseCensus(lines, where);
  const entries = c.entries.map((e) => ({ ...e }));
  for (const k of ops.removed) {
    const i = entries.findIndex((e) => e.key === k.key);
    if (i < 0)
      refuse(
        `${where}: lane removes byTag key ${k.key} but the base no longer has it`,
      );
    entries.splice(i, 1);
  }
  for (const ch of ops.changed) {
    const e = entries.find((x) => x.key === ch.key);
    if (!e)
      refuse(
        `${where}: lane changes byTag key ${ch.key} but the base no longer has it`,
      );
    e.value += ch.delta;
    if (ch.newComments.join("\n") !== ch.oldComments.join("\n")) {
      if (e.comments.join("\n") === ch.oldComments.join("\n"))
        e.comments = ch.newComments.slice();
      else if (e.comments.join("\n") !== ch.newComments.join("\n"))
        refuse(
          `${where}: comment of byTag key ${ch.key} drifted at the base; not guessing`,
        );
    }
    e.line = e.line.replace(/\d+(,\s*)$/, `${e.value}$1`);
  }
  for (const a of ops.added) {
    if (entries.some((e) => e.key === a.key))
      refuse(
        `${where}: byTag key ${a.key} already exists at the base; the lane's family landed twice?`,
      );
    entries.push({
      key: a.key,
      value: a.value,
      comments: a.comments.slice(),
      line: a.line,
    });
  }
  const body = entries.flatMap((e) => [...e.comments, e.line]);
  const out = lines.slice();
  out.splice(c.bi + 1, c.close - c.bi - 1, ...body);
  out[c.ti] = out[c.ti].replace(/\d+/, String(c.total + ops.totalDelta));
  void notes;
  return out;
}

function rebaseCensus(relPath, baseText, oldText0, newText0) {
  const where = relPath;
  const oldText = lfView(oldText0, where).lf;
  const newText = lfView(newText0, where).lf;
  const oldL = oldText.split("\n");
  const newL = newText.split("\n");
  const o = parseCensus(oldL, where);
  const n = parseCensus(newL, where);
  const ops = {
    totalDelta: n.total - o.total,
    removed: [],
    changed: [],
    added: [],
  };
  const oldMap = new Map(o.entries.map((e) => [e.key, e]));
  const newMap = new Map(n.entries.map((e) => [e.key, e]));
  for (const e of o.entries) if (!newMap.has(e.key)) ops.removed.push(e);
  for (const e of n.entries) {
    const prev = oldMap.get(e.key);
    if (!prev) ops.added.push(e);
    else if (
      prev.value !== e.value ||
      prev.comments.join("\n") !== e.comments.join("\n")
    )
      ops.changed.push({
        key: e.key,
        delta: e.value - prev.value,
        oldComments: prev.comments,
        newComments: e.comments,
      });
  }
  const reproduced = applyCensusOps(oldL, ops, where, []);
  if (censusCanonical(reproduced, where) !== censusCanonical(newL, where))
    refuse(`${where}: lane edits the census spec outside total/byTag`);
  if (
    ops.totalDelta === 0 &&
    !ops.added.length &&
    !ops.removed.length &&
    !ops.changed.length
  )
    refuse(`${where}: lane census hunk carries no semantic change`);
  const { lf, eol } = lfView(baseText, where);
  const baseLn = lf.split("\n");
  const base = parseCensus(baseLn, where);
  const after = restoreEol(
    applyCensusOps(baseLn, ops, where, []).join("\n"),
    eol,
  );
  const bits = [
    `total ${ops.totalDelta >= 0 ? "+" : ""}${ops.totalDelta} (${base.total} -> ${base.total + ops.totalDelta})`,
  ];
  if (ops.added.length)
    bits.push(
      `byTag +${ops.added.map((a) => `${a.key}:${a.value}`).join(",")}`,
    );
  if (ops.changed.length)
    bits.push(
      `byTag ~${ops.changed.map((c) => `${c.key}${c.delta >= 0 ? "+" : ""}${c.delta}`).join(",")}`,
    );
  if (ops.removed.length)
    bits.push(`byTag -${ops.removed.map((r) => r.key).join(",")}`);
  return { after, bits };
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const opt = { laneRepos: [], base: "HEAD" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--repo") opt.repo = argv[++i];
    else if (k === "--lane") opt.lane = argv[++i];
    else if (k === "--lane-md5") opt.laneMd5 = argv[++i];
    else if (k === "--out") opt.out = argv[++i];
    else if (k === "--base") opt.base = argv[++i];
    else if (k === "--lane-repo") opt.laneRepos.push(argv[++i]);
    else if (k === "--tmp-root") opt.tmpRoot = argv[++i];
    else {
      console.error(`usage error: unknown argument ${k}`);
      process.exit(1);
    }
  }
  for (const k of ["repo", "lane", "laneMd5", "out"]) {
    if (!opt[k]) {
      console.error(
        `usage: node Tools/landing/rebase-shared.mjs --repo <seat> --lane <lane.patch> --lane-md5 <md5> --out <out.patch> [--base <rev>=HEAD] [--lane-repo <clone>]...`,
      );
      process.exit(1);
    }
  }
  return opt;
}

// File identity, not path spelling: on a case-insensitive filesystem (NTFS, default APFS) a second spelling, a
// junction or an 8.3 short name reaches the same file, and a string comparison of resolved paths would let the
// delete below destroy the frozen lane patch before it is read.
function sameFile(a, b) {
  try {
    const x = fs.statSync(a, { bigint: true });
    const y = fs.statSync(b, { bigint: true });
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  // A refusal writes nothing, so an <out> left by an earlier run must not survive it for a run-book to pick up.
  // Neither <out> nor <out>.md5 is deleted when it IS the lane patch.
  if (!sameFile(opt.out, opt.lane) && !sameFile(`${opt.out}.md5`, opt.lane)) {
    fs.rmSync(opt.out, { force: true });
    fs.rmSync(`${opt.out}.md5`, { force: true });
  }
  const laneBytes = fs.readFileSync(opt.lane);
  const laneMd5 = md5(laneBytes);
  if (laneMd5 !== opt.laneMd5.toLowerCase())
    refuse(`lane patch md5 ${laneMd5} != frozen ${opt.laneMd5}`);
  const laneText = laneBytes.toString("latin1");

  const root =
    opt.tmpRoot ??
    path.join(os.tmpdir(), "cesium-lane", "landing", "rebase-shared");
  fs.mkdirSync(root, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(root, "run-"));
  try {
    run(opt, laneText, laneMd5, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      fs.rmdirSync(root);
    } catch {
      /* other runs may share the root */
    }
  }
}

function run(opt, laneText, laneMd5, tmp) {
  const git = makeGit(opt.repo, tmp);
  const baseSha = git.resolve(opt.base);
  git.baseSha = baseSha;
  git.run(["read-tree", baseSha]);

  const readOld = (oid, relPath) => {
    for (const r of [opt.repo, ...opt.laneRepos]) {
      try {
        return execFileSync("git", ["-C", r, "cat-file", "blob", oid], {
          encoding: "latin1",
          maxBuffer: 1 << 30,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        /* try the next repository */
      }
    }
    return refuse(
      `${relPath}: lane's pre-image blob ${oid} is not in the repo (pass --lane-repo <clone>)`,
    );
  };

  const sections = splitSections(laneText);
  const manifest = [];
  const unowned = [];
  const outParts = [];
  const chunk = (s) => s.lines.join("\n") + (s === sections.at(-1) ? "" : "\n");
  for (const s of sections) {
    const info = parseSection(s);
    const p = info?.path;
    if (p && UNOWNED_RE.test(p)) unowned.push(p);
    const shared =
      p && (p === CENSUS_PATH || p === TAGS_PATH || ALLOWLIST_RE.test(p));
    if (!shared) {
      outParts.push(chunk(s));
      continue;
    }
    if (!info.plain || !info.hunks.length || !info.indexOld)
      refuse(`${p}: section is not a plain modification of an existing file`);
    const asIs = tryApply(git, chunk(s), false);
    if (asIs.ok) {
      outParts.push(chunk(s));
      manifest.push(`${p}: kept as-is`);
      continue;
    }
    const baseText = (() => {
      try {
        return git.showBlob(baseSha, p);
      } catch {
        return refuse(
          `${p}: base ${baseSha.slice(0, 10)} does not have this file`,
        );
      }
    })();
    const oldText = readOld(info.indexOld, p);
    const newText = applyHunks(oldText, info);
    let afterText;
    let what;
    if (p === CENSUS_PATH) {
      const r = rebaseCensus(p, baseText, oldText, newText);
      afterText = r.after;
      what = r.bits.join("; ");
    } else {
      const r = rebaseRowFile(p, baseText, oldText, newText);
      afterText = r.after;
      const parts = [];
      for (const b of r.summary) {
        const bits = [];
        if (b.removed.length) bits.push(`-${b.removed.length} rows`);
        if (b.added.length)
          bits.push(
            `+${b.added.length} ${p === TAGS_PATH ? "entries" : "ROWS ADDED"} (${b.added.map((a) => a.row.key).join(", ")})`,
          );
        if (b.changed.length) bits.push(`~${b.changed.length} rows changed`);
        parts.push(`${b.block} ${bits.join(" ")}`);
      }
      what =
        parts.join("; ") +
        (r.notes.length ? ` [notes: ${r.notes.join(" | ")}]` : "");
    }
    const diff = makeDiff(
      git,
      tmp,
      p,
      baseText,
      afterText,
      git.blobOid(baseSha, p),
    );
    if (diff === "") {
      manifest.push(
        `${p}: regenerated: no-op (the base already carries this change; section dropped)`,
      );
      continue;
    }
    const chk = tryApply(git, diff, false);
    if (!chk.ok)
      refuse(`${p}: regenerated hunk does not apply to the base (${chk.err})`);
    outParts.push(diff);
    manifest.push(`${p}: regenerated: ${what}`);
  }

  const outText = outParts.join("");
  const outBytes = Buffer.from(outText, "latin1");
  const outMd5 = md5(outBytes);

  // Informational whole-patch check (the shared sections are already proven above).
  const whole = tryApply(git, outText, true);
  let wholeNote = "clean";
  if (!whole.ok) {
    const bad = [];
    const outSections = splitSections(outText);
    for (const s of outSections) {
      const i = parseSection(s);
      if (!i) continue;
      const r = tryApply(
        git,
        s.lines.join("\n") + (s === outSections.at(-1) ? "" : "\n"),
        true,
      );
      if (!r.ok) bad.push(i.path);
    }
    const ownedBad = bad.filter((b) => !UNOWNED_RE.test(b));
    wholeNote = `FAILS in ${bad.length} file(s): ${bad.join(", ")}${ownedBad.length ? `  <-- NOT covered by the union resolver: ${ownedBad.join(", ")}` : "  (all covered by the landing script's union resolver)"}`;
  }

  fs.mkdirSync(path.dirname(path.resolve(opt.out)), { recursive: true });
  fs.writeFileSync(opt.out, outBytes);
  fs.writeFileSync(`${opt.out}.md5`, `${outMd5}\n`);

  const lines = [];
  lines.push(`base: ${opt.base} = ${baseSha}`);
  lines.push(`input: ${opt.lane} md5 ${laneMd5} (frozen, verified)`);
  for (const m of manifest) lines.push(`shared ${m}`);
  if (!manifest.length)
    lines.push("shared: lane touches none of the owned shared files");
  lines.push(
    `not owned (left to the landing script's union resolver): ${unowned.length ? unowned.join(", ") : "none present in this lane"}`,
  );
  lines.push(
    `whole-patch git apply --cached --3way vs base (REAL apply into a throwaway index; --check hides conflicts): ${wholeNote}`,
  );
  lines.push(
    `output: ${opt.out} md5 ${outMd5}${outMd5 === laneMd5 ? " (byte-identical to the input)" : ""}`,
  );
  console.log(lines.join("\n"));
}

// Plain mode is `git apply --cached --check`. The 3-way mode runs the apply FOR REAL against the throwaway index:
// `--3way --check` reports conflicts as success, so it is not an oracle (measured on the lothlorien README hunk).
// The index is a temp file and new objects go to the quarantine directory, so nothing of the repo changes.
function tryApply(git, patchText, threeWay) {
  const args = threeWay
    ? ["apply", "--cached", "--3way"]
    : ["apply", "--cached", "--check"];
  try {
    if (threeWay) git.run(["read-tree", git.baseSha]);
    const out = git.runBoth(args, { input: Buffer.from(patchText, "latin1") });
    if (threeWay && /with conflicts/.test(out))
      return {
        ok: false,
        err: out
          .split("\n")
          .filter((l) => /conflicts/.test(l))
          .slice(0, 2)
          .join(" / "),
      };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      err: String(err.stderr ?? err.message)
        .split("\n")
        .filter(Boolean)
        .slice(0, 2)
        .join(" / "),
    };
  }
}

try {
  main();
} catch (err) {
  if (err instanceof Refusal) {
    console.error(`REFUSED: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
