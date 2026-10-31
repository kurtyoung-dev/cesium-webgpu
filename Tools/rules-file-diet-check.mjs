#!/usr/bin/env node
/**
 * Guard for a diet of the rules file: proves that no rule of an older CLAUDE.md was lost when its
 * text was trimmed, moved into on-demand skills, or pointed at another page.
 * @purpose Re-derive, from an old CLAUDE.md and the current tree, where every normative sentence now lives (core, a skill, or a page the core or a skill links), check the numbered principles and the skill wiring, and measure the core and the skills.
 * @status ACTIVE
 *
 * A normative sentence is one carrying MUST, NEVER, ALWAYS, CRITICAL or HARD, or the words "do not"
 * or "never" in any case; headings and table rows that carry one count too. Each one must appear in
 * the new corpus after inline markdown is normalised away (emphasis, code spans, link targets,
 * list and heading markers, whitespace). The corpus is the new CLAUDE.md, every
 * `.claude/skills/<name>/SKILL.md`, and every repository `.md` file that one of those links. A
 * sentence that was deliberately reworded is accepted only through an equivalence file
 * (`--equiv <json>`: `[{ "old": "<normalised old text>", "new": "<normalised new text>", "why": "" }]`)
 * whose `new` text must itself be found, so a rewording is reviewable rather than silent.
 *
 * Also checked: the numbered principles (`### N. Title`) keep the same numbers and titles in the
 * same order, all under "## Core Principles", with no number repeated; every skill has `name:`
 * equal to its directory and a `description:` of at most 25 words; every skill is named in the core
 * as `/<name>`, listed by path in AGENTS.md, GEMINI.md and .clinerules, and not git-ignored; every
 * relative link in the core, the skills and those pointer files resolves.
 *
 * USAGE
 *   node Tools/rules-file-diet-check.mjs --base <git-rev> [--root <dir>] [--equiv <json>] [--table] [--json]
 *   node Tools/rules-file-diet-check.mjs --old <path-to-old-CLAUDE.md> [...]
 *
 * EXIT CODES: 0 PASS, 1 FAIL (a rule not found, or a structure check failed), 2 usage or I/O error.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const NORMATIVE =
  /MUST|NEVER|ALWAYS|CRITICAL|HARD|\bdo not\b|\bnever\b/i;
const NORMATIVE_UPPER = /MUST|NEVER|ALWAYS|CRITICAL|HARD/;
const NORMATIVE_ANYCASE = /\bdo not\b|\bnever\b/i;
export const POINTER_FILES = ["AGENTS.md", "GEMINI.md", ".clinerules"];
export const MAX_DESCRIPTION_WORDS = 25;

export function isNormative(text) {
  return NORMATIVE_UPPER.test(text) || NORMATIVE_ANYCASE.test(text);
}

function toLf(text) {
  return text.replace(/\r\n?/g, "\n");
}

function stripComments(text) {
  // Keep the newlines a comment spanned so line numbers stay true.
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ""));
}

function stripLineMarkers(line) {
  return line
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");
}

function normaliseInline(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/gm, "$1$2");
}

/**
 * Normalise a document into one whitespace-collapsed string plus, for every character of it, the
 * 1-based source line it came from.
 */
export function normaliseDocument(text) {
  const lines = stripComments(toLf(text)).split("\n");
  let fence = false;
  const kept = lines.map((line) => {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      return "";
    }
    return fence ? line : stripLineMarkers(line);
  });
  const inline = normaliseInline(kept.join("\n"));
  let out = "";
  const lineOf = [];
  let line = 1;
  let pendingSpace = false;
  for (const ch of inline) {
    if (ch === "\n") line += 1;
    if (/\s/.test(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      lineOf.push(line);
      pendingSpace = false;
    }
    out += ch;
    lineOf.push(line);
  }
  return { text: out, lineOf };
}

export function normaliseUnit(text) {
  return normaliseDocument(text).text;
}

const SENTENCE_SPLIT =
  /(?<!\b(?:e\.g|i\.e|vs|etc|cf|No|approx)\.)(?<=[.!?]["')\]*`]*)\s+(?=[A-Z"'(`*[])/;

/**
 * Split a markdown document into normative units: sentences (prose and list items), headings and
 * table rows that carry a normative keyword. Fenced code and HTML comments are skipped.
 */
export function extractNormativeUnits(text) {
  const lines = stripComments(toLf(text)).split("\n");
  const blocks = [];
  let current = null;
  let fence = false;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/^\s*```/.test(line)) {
      fence = !fence;
      current = null;
      return;
    }
    if (fence) return;
    if (line.trim() === "" || /^\s*-{3,}\s*$/.test(line)) {
      current = null;
      return;
    }
    const heading = /^\s*#{1,6}\s/.test(line);
    const tableRow = /^\s*\|/.test(line);
    const listStart = /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
    if (heading || tableRow) {
      blocks.push({ line: n, kind: heading ? "heading" : "table", text: line });
      current = null;
      return;
    }
    if (listStart || current === null) {
      current = { line: n, kind: "prose", text: line };
      blocks.push(current);
      return;
    }
    current.text += `\n${line}`;
  });
  const units = [];
  for (const block of blocks) {
    if (block.kind !== "prose") {
      if (isNormative(block.text)) {
        units.push({
          line: block.line,
          kind: block.kind,
          raw: block.text.trim(),
          norm: normaliseUnit(block.text),
        });
      }
      continue;
    }
    const flat = normaliseUnit(block.text);
    for (const sentence of flat.split(SENTENCE_SPLIT)) {
      if (sentence && isNormative(sentence)) {
        // Trailing punctuation is not part of the rule: a sentence may end a list item in one tree
        // and continue after a semicolon in the other.
        const norm = sentence.replace(/[\s.;:,]+$/, "");
        units.push({ line: block.line, kind: "sentence", raw: sentence, norm });
      }
    }
  }
  return units;
}

function readFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(toLf(text));
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fields, body: toLf(text).slice(m[0].length) };
}

export function listSkills(root) {
  const dir = path.join(root, ".claude", "skills");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() && fs.existsSync(path.join(dir, d.name, "SKILL.md")),
    )
    .map((d) => {
      const file = path.join(dir, d.name, "SKILL.md");
      const text = fs.readFileSync(file, "utf8");
      const fm = readFrontmatter(text);
      return {
        dir: d.name,
        file: path.relative(root, file).replace(/\\/g, "/"),
        text,
        name: fm?.fields.name ?? null,
        description: fm?.fields.description ?? null,
        body: fm?.body ?? toLf(text),
      };
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

function linkedPages(root, file, text) {
  const out = new Set();
  const re = /\]\(([^)\s#]+\.md)(?:#[^)\s]*)?\)/g;
  for (const m of stripComments(text).matchAll(re)) {
    if (/^[a-z]+:/i.test(m[1])) continue;
    const abs = path.resolve(path.dirname(path.join(root, file)), m[1]);
    if (abs.startsWith(path.resolve(root)) && fs.existsSync(abs)) {
      out.add(path.relative(root, abs).replace(/\\/g, "/"));
    }
  }
  return out;
}

/**
 * Every relative markdown link in the core, the skills and the pointer files must resolve. The doc
 * citation guard scans `migration_doc/` only, so without this a link moved into a skill could rot.
 */
export function checkLinks(root, files) {
  const problems = [];
  const re = /\]\(([^)\s]+)\)/g;
  for (const file of files) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) continue;
    let fence = false;
    const text = stripComments(toLf(fs.readFileSync(abs, "utf8")))
      .split("\n")
      .filter((line) => {
        if (/^\s*```/.test(line)) fence = !fence;
        return !fence;
      })
      .join("\n");
    for (const m of text.matchAll(re)) {
      const target = m[1].split("#")[0];
      if (
        !target ||
        /^[a-z][a-z0-9+.-]*:/i.test(target) ||
        target.startsWith("/")
      )
        continue;
      if (!fs.existsSync(path.resolve(path.dirname(abs), decodeURI(target)))) {
        problems.push(`${file}: link target ${m[1]} does not resolve`);
      }
    }
  }
  return problems;
}

/** Build the searchable corpus: the core, every skill, and every page either of them links. */
export function buildCorpus(root, coreName = "CLAUDE.md") {
  const coreText = fs.readFileSync(path.join(root, coreName), "utf8");
  const skills = listSkills(root);
  const entries = [{ file: coreName, text: coreText, role: "core" }];
  for (const s of skills)
    entries.push({ file: s.file, text: s.text, role: "skill" });
  const cited = new Set();
  for (const e of [...entries]) {
    for (const page of linkedPages(root, e.file, e.text)) cited.add(page);
  }
  for (const page of [...cited].sort()) {
    if (entries.some((e) => e.file === page)) continue;
    entries.push({
      file: page,
      text: fs.readFileSync(path.join(root, page), "utf8"),
      role: "cited",
    });
  }
  return entries.map((e) => ({ ...e, doc: normaliseDocument(e.text) }));
}

export function locate(norm, corpus, roles = null) {
  for (const entry of corpus) {
    if (roles && !roles.includes(entry.role)) continue;
    const at = entry.doc.text.indexOf(norm);
    if (at !== -1)
      return { file: entry.file, role: entry.role, line: entry.doc.lineOf[at] };
  }
  return null;
}

// The one rewording a move into a skill is allowed without an equivalence entry: a section that
// became a skill may call itself "this skill". Accepted only when found in a skill file.
export const MOVE_EDITS = [[/\bthis section\b/g, "this skill"]];

/** Map every normative unit of the old text to its new home. */
export function mapRules(oldText, corpus, equivalences = []) {
  return extractNormativeUnits(oldText).map((unit) => {
    let where = locate(unit.norm, corpus);
    let via = where ? "verbatim" : null;
    if (!where) {
      const moved = MOVE_EDITS.reduce(
        (s, [re, to]) => s.replace(re, to),
        unit.norm,
      );
      if (moved !== unit.norm) {
        where = locate(moved, corpus, ["skill"]);
        via = where ? "move-edit" : null;
      }
    }
    if (!where) {
      const eq = equivalences.find((e) =>
        unit.norm.includes(normaliseUnit(e.old)),
      );
      if (eq) {
        where = locate(normaliseUnit(eq.new), corpus);
        via = where ? "equivalent" : null;
      }
    }
    return { ...unit, where, via };
  });
}

export function principleHeadings(text) {
  const out = [];
  let section = null;
  stripComments(toLf(text))
    .split("\n")
    .forEach((line, i) => {
      const top = /^## (.+)$/.exec(line);
      if (top) section = top[1].trim();
      const m = /^### (\d+)\. (.+)$/.exec(line);
      if (m)
        out.push({ n: Number(m[1]), title: m[2].trim(), line: i + 1, section });
    });
  return out;
}

export function checkPrinciples(oldText, newText) {
  const problems = [];
  const before = principleHeadings(oldText);
  const after = principleHeadings(newText);
  const seen = new Set();
  for (const p of after) {
    if (seen.has(p.n))
      problems.push(`principle ${p.n} appears twice (line ${p.line})`);
    seen.add(p.n);
    if (p.section !== "Core Principles") {
      problems.push(
        `principle ${p.n} sits under "${p.section}", not "Core Principles"`,
      );
    }
  }
  const sig = (list) => list.map((p) => `${p.n}. ${p.title}`);
  const a = sig(before);
  const b = sig(after);
  if (a.join("\n") !== b.join("\n")) {
    const missing = a.filter((x) => !b.includes(x));
    const extra = b.filter((x) => !a.includes(x));
    if (missing.length)
      problems.push(`principles changed or lost: ${missing.join(" | ")}`);
    if (extra.length)
      problems.push(`principles added or retitled: ${extra.join(" | ")}`);
    if (!missing.length && !extra.length)
      problems.push("principles are out of order");
  }
  return { before, after, problems };
}

function isIgnored(root, file) {
  try {
    execFileSync(
      "git",
      ["-C", root, "check-ignore", "-q", "--no-index", file],
      { stdio: "ignore" },
    );
    return true;
  } catch (error) {
    // Exit 1 means "not ignored"; anything else (no git, not a work tree) cannot decide, so it is
    // not reported as a problem.
    return false;
  }
}

export function checkSkills(root, coreText) {
  const problems = [];
  const skills = listSkills(root);
  const pointers = Object.fromEntries(
    POINTER_FILES.map((f) => {
      const p = path.join(root, f);
      return [f, fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""];
    }),
  );
  for (const s of skills) {
    if (s.name !== s.dir)
      problems.push(`${s.file}: name "${s.name}" differs from its directory`);
    const words = (s.description ?? "").split(/\s+/).filter(Boolean).length;
    if (!s.description) problems.push(`${s.file}: no description`);
    else if (words > MAX_DESCRIPTION_WORDS) {
      problems.push(
        `${s.file}: description has ${words} words (max ${MAX_DESCRIPTION_WORDS})`,
      );
    }
    if (!coreText.includes(`/${s.dir}`))
      problems.push(`core does not name /${s.dir}`);
    for (const [f, text] of Object.entries(pointers)) {
      if (!text.includes(s.file)) problems.push(`${f} does not list ${s.file}`);
    }
    // A skill that git ignores never reaches a fresh clone, so the rule it holds would be lost.
    if (isIgnored(root, s.file))
      problems.push(
        `${s.file} is git-ignored, so a clone would not receive it`,
      );
  }
  return { skills, problems };
}

const tokens = (bytes) => Math.round(bytes / 4);
const lfBytes = (text) => Buffer.byteLength(toLf(text), "utf8");

export function measure(oldText, root, skills) {
  const core = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  const perSkill = skills.map((s) => {
    const descBytes = Buffer.byteLength(
      `${s.name}: ${s.description ?? ""}`,
      "utf8",
    );
    return {
      name: s.dir,
      fileBytes: lfBytes(s.text),
      bodyBytes: lfBytes(s.body),
      descBytes,
      descTokens: tokens(descBytes),
    };
  });
  const descTotal = perSkill.reduce((n, s) => n + s.descBytes, 0);
  return {
    coreBefore: { bytes: lfBytes(oldText), tokens: tokens(lfBytes(oldText)) },
    coreAfter: { bytes: lfBytes(core), tokens: tokens(lfBytes(core)) },
    skills: perSkill,
    descriptionsPerSession: { bytes: descTotal, tokens: tokens(descTotal) },
  };
}

export function runCheck({ oldText, root, equivalences = [] }) {
  const corpus = buildCorpus(root);
  const coreText = corpus[0].text;
  const rules = mapRules(oldText, corpus, equivalences);
  const lost = rules.filter((r) => !r.where);
  const principles = checkPrinciples(oldText, coreText);
  const skillCheck = checkSkills(root, coreText);
  const metrics = measure(oldText, root, skillCheck.skills);
  const links = checkLinks(root, [
    "CLAUDE.md",
    ...skillCheck.skills.map((s) => s.file),
    ...POINTER_FILES,
  ]);
  const problems = [
    ...lost.map(
      (r) => `rule lost (old line ${r.line}): ${r.raw.slice(0, 160)}`,
    ),
    ...principles.problems,
    ...skillCheck.problems,
    ...links,
  ];
  return {
    pass: problems.length === 0,
    rules,
    lost,
    principles,
    skills: skillCheck.skills,
    metrics,
    problems,
  };
}

export function formatTable(rules) {
  const esc = (s) => s.replace(/\|/g, "\\|");
  const rows = rules.map((r) => {
    const at = r.where
      ? `${r.where.file}:${r.where.line}${r.via === "verbatim" ? "" : ` (${r.via})`}`
      : "LOST";
    return `| ${r.line} | ${esc(r.raw.slice(0, 90))}${r.raw.length > 90 ? "..." : ""} | ${at} |`;
  });
  return [
    "| Old line | Normative text (start) | New location |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function parseArgs(argv) {
  const args = { root: process.cwd(), table: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--old") args.old = argv[++i];
    else if (a === "--root") args.root = argv[++i];
    else if (a === "--equiv") args.equiv = argv[++i];
    else if (a === "--table") args.table = true;
    else if (a === "--json") args.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.base === !args.old)
    throw new Error("give exactly one of --base <rev> or --old <path>");
  return args;
}

function main() {
  let args;
  let oldText;
  let equivalences = [];
  try {
    args = parseArgs(process.argv.slice(2));
    oldText = args.old
      ? fs.readFileSync(args.old, "utf8")
      : execFileSync(
          "git",
          ["-C", args.root, "show", `${args.base}:CLAUDE.md`],
          { encoding: "utf8", maxBuffer: 1 << 26 },
        );
    if (args.equiv)
      equivalences = JSON.parse(fs.readFileSync(args.equiv, "utf8"));
  } catch (error) {
    console.error(`rules-file-diet-check: ${error.message}`);
    process.exit(2);
  }
  const result = runCheck({ oldText, root: args.root, equivalences });
  if (args.json) {
    console.log(
      JSON.stringify(
        result,
        (k, v) => (k === "doc" || k === "text" || k === "body" ? undefined : v),
        2,
      ),
    );
  } else {
    if (args.table) console.log(`${formatTable(result.rules)}\n`);
    const m = result.metrics;
    console.log(
      `core: ${m.coreBefore.bytes} B (~${m.coreBefore.tokens} tokens) -> ${m.coreAfter.bytes} B (~${m.coreAfter.tokens} tokens)`,
    );
    for (const s of m.skills) {
      console.log(
        `skill ${s.name}: body ${s.bodyBytes} B (~${tokens(s.bodyBytes)} tokens), description ${s.descBytes} B (~${s.descTokens} tokens)`,
      );
    }
    console.log(
      `skill descriptions per session: ${m.descriptionsPerSession.bytes} B (~${m.descriptionsPerSession.tokens} tokens)`,
    );
    const placed = (role) =>
      result.rules.filter((r) => r.where?.role === role).length;
    console.log(
      `normative units: ${result.rules.length} (core ${placed("core")}, skills ${placed("skill")}, cited pages ${placed("cited")}, move-edit ${result.rules.filter((r) => r.via === "move-edit").length}, equivalent ${result.rules.filter((r) => r.via === "equivalent").length}, lost ${result.lost.length})`,
    );
    for (const p of result.problems) console.error(`FAIL: ${p}`);
    console.log(
      result.pass
        ? "PASS: rules-file-diet-check"
        : `FAIL: rules-file-diet-check (${result.problems.length} problem(s))`,
    );
  }
  process.exit(result.pass ? 0 : 1);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
