// rebase-shared-mutants.mjs - inertness mutants for rebase-shared.mjs.
// @purpose Inertness-mutant runner for the landing-time shared-hunk rebaser: makes each transform unreachable in a copy of the tool and requires its spec to go RED.
// @status ACTIVE
// Each mutant makes ONE transform
// unreachable (`false &&`, a skipped statement) in a COPY of the tool, runs the whole spec against the copy
// (REBASE_SHARED_TOOL) and must see it go RED. The original is never edited; its md5 is printed before and after.
// Usage: node Tools/landing/rebase-shared-mutants.mjs [parallel=4]   (REBASE_SHARED_MUTANTS_JSON=<file> also writes the results)
// Exit: 0 only when the control is GREEN, every mutant parses and goes RED (or is a listed known-equivalent survivor) and the tool is unchanged; otherwise 1.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(here, "rebase-shared.mjs");
const SPEC = path.join(here, "rebase-shared.spec.mjs");
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");
const original = fs.readFileSync(TOOL, "utf8");
const before = md5(original);

// Mutants that CANNOT go RED on the git this was measured on, by construction, and the measurement. They are reported
// as "SURVIVED (known equivalent)" and do not fail the exit code; any other survivor does.
const EQUIVALENT = new Map([
  [
    "whole-patch-conflict-detection",
    "git 2.55.0.windows.3 exits non-zero when the real 3-way apply leaves conflicts, so the apply throws and the tool reports the failure before its 'with conflicts' text check is reached; the text check only matters on a git that exits 0 on conflicts (not measured here)",
  ],
]);

const M = [
  [
    "control-unmutated",
    "CONTROL: the unmutated tool must stay green",
    null,
    null,
  ],
  [
    "census-total-delta",
    "census: REGISTRY_CENSUS.total += lane delta",
    "  out[c.ti] = out[c.ti].replace(/\\d+/, String(c.total + ops.totalDelta));",
    "  /* MUTANT */",
  ],
  [
    "census-new-byTag-key",
    "census: new byTag keys inserted",
    "    entries.push({\n      key: a.key,\n      value: a.value,\n      comments: a.comments.slice(),\n      line: a.line,\n    });",
    "    /* MUTANT */",
  ],
  [
    "census-existing-key-delta",
    "census: existing byTag count += lane delta",
    "    e.value += ch.delta;",
    "    e.value += 0;",
  ],
  [
    "census-duplicate-key-refusal",
    "census: refuse a byTag key the base already has",
    "    if (entries.some((e) => e.key === a.key))",
    "    if (false && entries.some((e) => e.key === a.key))",
  ],
  [
    "census-outside-refusal",
    "census: refuse a lane edit outside total/byTag",
    "  if (censusCanonical(reproduced, where) !== censusCanonical(newL, where))",
    "  if (false && censusCanonical(reproduced, where) !== censusCanonical(newL, where))",
  ],
  [
    "tags-append",
    "RIG_TAGS: lane tags appended",
    "      if (isArr) at = rows.length;",
    "      if (isArr) continue;",
  ],
  [
    "allowlist-row-removal",
    "allowlist: lane - rows removed",
    "      rows.splice(i, 1);",
    "      /* MUTANT */",
  ],
  [
    "allowlist-row-insertion",
    "allowlist: lane + rows inserted",
    "      rows.splice(at, 0, { key: a.row.key, lines: a.row.lines.slice() });",
    "      if (isArr) rows.splice(at, 0, { key: a.row.key, lines: a.row.lines.slice() });",
  ],
  [
    "allowlist-predecessor-placement",
    "allowlist: + row goes after its post-image predecessor",
    "        at = p < 0 ? rows.length : p + 1;",
    "        at = rows.length;",
  ],
  [
    "allowlist-row-edit",
    "allowlist: lane row text edit applied",
    "      rows[i] = { key: c.row.key, lines: c.row.lines.slice() };",
    "      /* MUTANT */",
  ],
  [
    "allowlist-absent-removal-refusal",
    "allowlist: refuse a - row the base no longer has",
    "        refuse(\n          `${where}: lane removes row ${r.key} from",
    "        if (true) continue;\n        refuse(\n          `${where}: lane removes row ${r.key} from",
  ],
  [
    "allowlist-drift-refusal",
    "allowlist: refuse an edit of a drifted base row",
    "      if (rowText(rows[i]) !== rowText(c.old))",
    "      if (false && rowText(rows[i]) !== rowText(c.old))",
  ],
  [
    "outside-rows-refusal",
    "row files: refuse a lane edit outside the rows",
    "  if (outsideText(oldL, oldB) !== outsideText(newL, newB))",
    "  if (false && outsideText(oldL, oldB) !== outsideText(newL, newB))",
  ],
  [
    "keep-as-is",
    "a section that already applies is kept byte-for-byte",
    "    if (asIs.ok) {",
    "    if (false && asIs.ok) {",
  ],
  [
    "noop-section-dropped",
    "a change the base already carries drops the section",
    '    if (diff === "") {',
    "    if (false) {",
  ],
  [
    "md5-guard",
    "lane md5 verified first",
    "  if (laneMd5 !== opt.laneMd5.toLowerCase())",
    "  if (false && laneMd5 !== opt.laneMd5.toLowerCase())",
  ],
  [
    "crlf-restore",
    "base line endings preserved",
    'const restoreEol = (text, eol) =>\n  eol === "\\n" ? text : text.replace(/\\n/g, eol);',
    "const restoreEol = (text) => text;",
  ],
  [
    "stale-output-removal",
    "a refused run leaves no stale output",
    "    fs.rmSync(opt.out, { force: true });",
    "    /* MUTANT */",
  ],
  [
    "stale-md5-removal",
    "a refused run leaves no stale output md5",
    "    fs.rmSync(`${opt.out}.md5`, { force: true });",
    "    /* MUTANT */",
  ],
  [
    "self-out-guard",
    "an --out equal to --lane is never deleted",
    "  if (!sameFile(opt.out, opt.lane) && !sameFile(`${opt.out}.md5`, opt.lane)) {",
    "  if (true) {",
  ],
  [
    "self-out-path-resolve",
    "the self-out guard compares file identity, not resolved path strings",
    "  if (!sameFile(opt.out, opt.lane) && !sameFile(`${opt.out}.md5`, opt.lane)) {",
    "  if (path.resolve(opt.out) !== path.resolve(opt.lane)) {",
  ],
  [
    "self-md5-identity",
    "an <out>.md5 that is the lane is never deleted",
    "  if (!sameFile(opt.out, opt.lane) && !sameFile(`${opt.out}.md5`, opt.lane)) {",
    "  if (!sameFile(opt.out, opt.lane)) {",
  ],
  [
    "same-file-identity",
    "sameFile reads dev + ino",
    "    return x.dev === y.dev && x.ino === y.ino;",
    "    return false;",
  ],
  [
    "whole-patch-conflict-detection",
    "the whole-patch real 3-way apply reads 'with conflicts' as a failure",
    "    if (threeWay && /with conflicts/.test(out))",
    "    if (false && threeWay && /with conflicts/.test(out))",
  ],
  [
    "archive-readme-unowned",
    "the manifest names Tools/visual-regression/archive/README.md",
    "|package\\.json|Tools\\/visual-regression\\/archive\\/README\\.md)$/;",
    "|package\\.json)$/;",
  ],
  [
    "object-quarantine",
    "repo object store never written",
    "    GIT_OBJECT_DIRECTORY: quarantine,",
    "    /* MUTANT */",
  ],
];

const parallel = Number(process.argv[2] ?? 4);
fs.mkdirSync(path.join(os.tmpdir(), "cesium-lane", "landing"), {
  recursive: true,
});
const work = fs.mkdtempSync(
  path.join(os.tmpdir(), "cesium-lane", "landing", "mutants-"),
);
const results = [];
function runOne([id, what, anchor, replacement]) {
  const count = anchor === null ? 1 : original.split(anchor).length - 1;
  if (count !== 1)
    return Promise.resolve({
      id,
      what,
      status: `ANCHOR-ERROR (${count} matches)`,
    });
  const copy = path.join(work, `${id}.mjs`);
  fs.writeFileSync(
    copy,
    anchor === null ? original : original.replace(anchor, () => replacement),
  );
  // A RED that comes from a syntax error proves nothing, so every copy must parse before the spec runs on it.
  const syntax = spawnSync(process.execPath, ["--check", copy], {
    encoding: "utf8",
  });
  if (syntax.status !== 0)
    return Promise.resolve({
      id,
      what,
      status: "SYNTAX-ERROR (mutant copy does not parse)",
    });
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--test", SPEC], {
      env: { ...process.env, REBASE_SHARED_TOOL: copy },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      const num = (k) =>
        Number(out.match(new RegExp(`^# ${k} (\\d+)`, "m"))?.[1] ?? NaN);
      const reds = [...out.matchAll(/^\s+not ok \d+ - (.+)$/gm)].map((m) =>
        m[1].slice(0, 70),
      );
      resolve({
        id,
        what,
        status:
          code === 0
            ? anchor === null
              ? "GREEN (control)"
              : EQUIVALENT.has(id)
                ? "SURVIVED (known equivalent)"
                : "SURVIVED (spec stayed green)"
            : "RED",
        pass: num("pass"),
        fail: num("fail"),
        reds,
      });
    });
  });
}
const queue = M.slice();
await Promise.all(
  Array.from({ length: parallel }, async () => {
    while (queue.length) {
      const m = queue.shift();
      const r = await runOne(m);
      results.push(r);
      console.log(
        `${r.status.padEnd(30)} ${r.id}  (${r.pass ?? "?"} pass / ${r.fail ?? "?"} fail)  ${r.reds?.length ? "first red: " + r.reds[0] : ""}`,
      );
    }
  }),
);
fs.rmSync(work, { recursive: true, force: true });
const after = md5(fs.readFileSync(TOOL));
console.log(
  `\ntool md5 before ${before} after ${after} ${before === after ? "(restored / never edited)" : "!!! CHANGED"}`,
);
// Exit 1 unless the control is GREEN, every mutant is RED and the tool is unchanged, so a wrapper can gate on it.
const notOk = results.filter((r) =>
  r.id === "control-unmutated"
    ? r.status !== "GREEN (control)"
    : r.status !== "RED" && r.status !== "SURVIVED (known equivalent)",
);
for (const [id, why] of EQUIVALENT)
  if (
    results.some((r) => r.id === id && r.status.startsWith("SURVIVED (known"))
  )
    console.log(`known equivalent: ${id}: ${why}`);
for (const r of notOk) console.log(`NOT OK: ${r.id}: ${r.status}`);
if (notOk.length || before !== after) process.exitCode = 1;
if (process.env.REBASE_SHARED_MUTANTS_JSON)
  fs.writeFileSync(
    process.env.REBASE_SHARED_MUTANTS_JSON,
    JSON.stringify(
      results.sort((a, b) => a.id.localeCompare(b.id)),
      null,
      1,
    ),
  );
