// @purpose Behaviour coverage for Tools/rules-file-diet-check.mjs — a rule deleted or weakened in a diet of the rules file is reported, a rule moved to a skill or a linked page is found, principle renumbering and unwired skills are refused, and inertness mutants prove each check is live.
// @status ACTIVE
//
// Every fixture is a small fake repository written under the lane temp root (`Tools/lib/lane-tmp.mjs`):
// an old CLAUDE.md held in memory and a new tree on disk. The assertions are on what the checker reports
// for that tree, never on its internals. The mutant group makes the lost-rule, principle and skill checks
// unreachable in a copy of the module and requires the matching scenario to stop failing.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

import { withLaneTmp } from "./lib/lane-tmp.mjs";
import { extractNormativeUnits, runCheck } from "./rules-file-diet-check.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "rules-file-diet-check.mjs");

const OLD = `# Rules

## Core Principles

### 1. Keep Things Working — CRITICAL

- Existing behaviour MUST keep working.
- Never break the WebGL path.

### 2. Measure First

Probes come first. Do not guess at a fix.

## Shader Rules

Registries are add-only. NEVER renumber an entry.

The rule in this section ALWAYS applies.

## Story

### 3. Late Principle — CRITICAL

Never cite a lead as a premise.
`;

function skill(name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
}

const POINTER = (names) =>
  names.map((n) => `- .claude/skills/${n}/SKILL.md`).join("\n") + "\n";

/** A diet that keeps every rule: the shader rules move to a skill, principle 3 moves up. */
function goodTree() {
  return {
    "CLAUDE.md": `# Rules

## Core Principles

### 1. Keep Things Working — CRITICAL

- Existing behaviour MUST keep working.
- Never break the WebGL path.

### 2. Measure First

Probes come first. Do not guess at a fix.

### 3. Late Principle — CRITICAL

Never cite a lead as a premise.

## On-demand Skills

- \`/shader-rules\` — before shader work.
`,
    ".claude/skills/shader-rules/SKILL.md": skill(
      "shader-rules",
      "Shader registry rules. Read before shader work.",
      "Registries are add-only. NEVER renumber an entry.\n\nThe rule in this skill ALWAYS applies.",
    ),
    "AGENTS.md": POINTER(["shader-rules"]),
    "GEMINI.md": POINTER(["shader-rules"]),
    ".clinerules": POINTER(["shader-rules"]),
  };
}

function writeTree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

function check(
  files,
  { oldText = OLD, equivalences = [], mod = { runCheck } } = {},
) {
  return withLaneTmp("rules-diet-spec-", (root) => {
    writeTree(root, files);
    return mod.runCheck({ oldText, root, equivalences });
  });
}

function withEdit(files, rel, from, to) {
  assert.ok(
    files[rel].includes(from),
    `fixture edit marker missing in ${rel}: ${from}`,
  );
  return { ...files, [rel]: files[rel].replace(from, to) };
}

async function importMutant(t, marker, replacement) {
  const source = fs.readFileSync(SCRIPT, "utf8");
  assert.equal(
    source.split(marker).length - 1,
    1,
    `mutation marker must occur exactly once: ${marker}`,
  );
  return withLaneTmp("rules-diet-mutant-", async (dir) => {
    const copy = path.join(dir, "rules-file-diet-check.mjs");
    fs.writeFileSync(copy, source.replace(marker, replacement));
    return import(`${pathToFileURL(copy).href}?mutant=${Date.now()}`);
  });
}

test("normative units are the sentences, headings and rows that carry a rule keyword", () => {
  const units = extractNormativeUnits(OLD).map((u) => u.norm);
  assert.ok(units.includes("Existing behaviour MUST keep working"));
  assert.ok(units.includes("Do not guess at a fix"));
  assert.ok(
    units.includes("Keep Things Working — CRITICAL"),
    "a heading is a unit, its markers normalised away",
  );
  assert.ok(
    !units.some((u) => u.startsWith("Probes come first")),
    "a sentence with no keyword is not a rule",
  );
});

test("a diet that moves rules into a skill and principles up keeps every rule", () => {
  const result = check(goodTree());
  assert.deepEqual(result.problems, []);
  assert.equal(result.pass, true);
  const moved = result.rules.find((r) => r.norm === "NEVER renumber an entry");
  assert.equal(moved.where.file, ".claude/skills/shader-rules/SKILL.md");
  assert.equal(moved.where.role, "skill");
  const renamed = result.rules.find((r) => r.norm.includes("ALWAYS applies"));
  assert.equal(
    renamed.via,
    "move-edit",
    '"this section" may become "this skill" inside a skill',
  );
});

test("a deleted rule is reported lost, with its old line", () => {
  const files = withEdit(
    goodTree(),
    "CLAUDE.md",
    "Never cite a lead as a premise.\n",
    "Leads are useful.\n",
  );
  const result = check(files);
  assert.equal(result.pass, false);
  assert.equal(result.lost.length, 1);
  assert.equal(result.lost[0].line, 24);
  assert.match(
    result.problems.join("\n"),
    /rule lost \(old line 24\): Never cite a lead as a premise/,
  );
});

test("a weakened rule (MUST -> should) is reported lost", () => {
  const files = withEdit(
    goodTree(),
    "CLAUDE.md",
    "Existing behaviour MUST keep working.",
    "Existing behaviour should keep working.",
  );
  const result = check(files);
  assert.equal(result.pass, false);
  assert.ok(
    result.lost.some((r) => r.norm === "Existing behaviour MUST keep working"),
  );
});

test("a rule moved to a page is found only while the core or a skill links that page", () => {
  const base = withEdit(
    goodTree(),
    "CLAUDE.md",
    "Never cite a lead as a premise.\n",
    "See the notes.\n",
  );
  const page = {
    "docs/NOTES.md": "# Notes\n\nNever cite a lead as a premise.\n",
  };
  const unlinked = check({ ...base, ...page });
  assert.equal(
    unlinked.pass,
    false,
    "an unlinked page is not part of the corpus",
  );
  const linked = check({
    ...withEdit(
      base,
      "CLAUDE.md",
      "See the notes.",
      "See [the notes](docs/NOTES.md).",
    ),
    ...page,
  });
  assert.deepEqual(linked.problems, []);
  const found = linked.rules.find(
    (r) => r.norm === "Never cite a lead as a premise",
  );
  assert.deepEqual(
    [found.where.file, found.where.role, found.where.line],
    ["docs/NOTES.md", "cited", 3],
  );
});

test('the "this skill" move-edit is not accepted in the core', () => {
  const files = goodTree();
  delete files[".claude/skills/shader-rules/SKILL.md"];
  const core = files["CLAUDE.md"].replace(
    "## On-demand Skills",
    "## Shader Rules\n\nRegistries are add-only. NEVER renumber an entry.\n\nThe rule in this skill ALWAYS applies.\n\n## On-demand Skills",
  );
  const result = check({ ...files, "CLAUDE.md": core });
  assert.ok(result.lost.some((r) => r.norm.includes("ALWAYS applies")));
});

test("a reworded rule passes only through an equivalence whose new text exists", () => {
  const files = withEdit(
    goodTree(),
    "CLAUDE.md",
    "Do not guess at a fix.",
    "Never guess at a fix.",
  );
  assert.equal(check(files).pass, false);
  const ok = check(files, {
    equivalences: [
      {
        old: "Do not guess at a fix",
        new: "Never guess at a fix",
        why: "same rule",
      },
    ],
  });
  assert.deepEqual(ok.problems, []);
  assert.equal(
    ok.rules.find((r) => r.norm === "Do not guess at a fix").via,
    "equivalent",
  );
  const bad = check(files, {
    equivalences: [
      { old: "Do not guess at a fix", new: "Guess carefully", why: "" },
    ],
  });
  assert.equal(bad.pass, false);
});

test("principles must keep number, title and order, all under Core Principles, with no duplicate", () => {
  const renumbered = withEdit(
    goodTree(),
    "CLAUDE.md",
    "### 3. Late Principle",
    "### 4. Late Principle",
  );
  assert.match(
    check(renumbered).problems.join("\n"),
    /principles changed or lost: 3\. Late Principle/,
  );

  const outside = withEdit(
    goodTree(),
    "CLAUDE.md",
    "### 3. Late Principle — CRITICAL\n\nNever cite a lead as a premise.\n\n",
    "",
  );
  const outsideCore =
    outside["CLAUDE.md"] +
    "\n## Story\n\n### 3. Late Principle — CRITICAL\n\nNever cite a lead as a premise.\n";
  assert.match(
    check({ ...outside, "CLAUDE.md": outsideCore }).problems.join("\n"),
    /principle 3 sits under "Story"/,
  );

  const dup = withEdit(
    goodTree(),
    "CLAUDE.md",
    "### 2. Measure First",
    "### 2. Measure First\n\n### 2. Measure First",
  );
  assert.match(check(dup).problems.join("\n"), /principle 2 appears twice/);

  const swapped = goodTree();
  swapped["CLAUDE.md"] = swapped["CLAUDE.md"]
    .replace("### 1. Keep Things Working — CRITICAL", "@@ONE@@")
    .replace("### 2. Measure First", "### 1. Keep Things Working — CRITICAL")
    .replace("@@ONE@@", "### 2. Measure First");
  assert.match(
    check(swapped).problems.join("\n"),
    /principles are out of order/,
  );
});

test("a skill must be named after its directory, described briefly, named in the core and listed by every pointer file", () => {
  const long = withEdit(
    goodTree(),
    ".claude/skills/shader-rules/SKILL.md",
    "Shader registry rules. Read before shader work.",
    Array(26).fill("word").join(" "),
  );
  assert.match(
    check(long).problems.join("\n"),
    /description has 26 words \(max 25\)/,
  );

  const misnamed = withEdit(
    goodTree(),
    ".claude/skills/shader-rules/SKILL.md",
    "name: shader-rules",
    "name: shaders",
  );
  assert.match(
    check(misnamed).problems.join("\n"),
    /name "shaders" differs from its directory/,
  );

  const unnamed = withEdit(
    goodTree(),
    "CLAUDE.md",
    "`/shader-rules`",
    "`shader rules`",
  );
  assert.match(
    check(unnamed).problems.join("\n"),
    /core does not name \/shader-rules/,
  );

  const unlisted = { ...goodTree(), "GEMINI.md": "nothing\n" };
  assert.match(
    check(unlisted).problems.join("\n"),
    /GEMINI\.md does not list \.claude\/skills\/shader-rules\/SKILL\.md/,
  );
});

test("measurements report the core before and after and the per-session description cost", () => {
  const m = check(goodTree()).metrics;
  assert.equal(m.coreBefore.bytes, Buffer.byteLength(OLD));
  assert.equal(m.skills.length, 1);
  const desc = "shader-rules: Shader registry rules. Read before shader work.";
  assert.equal(m.descriptionsPerSession.bytes, Buffer.byteLength(desc));
  assert.equal(
    m.descriptionsPerSession.tokens,
    Math.round(Buffer.byteLength(desc) / 4),
  );
});

test("the CLI exits 2 on bad arguments and 0/1 with the verdict", () => {
  const bad = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  withLaneTmp("rules-diet-cli-", (root) => {
    writeTree(root, goodTree());
    const oldPath = path.join(root, "old-CLAUDE.md");
    fs.writeFileSync(oldPath, OLD);
    const ok = spawnSync(
      process.execPath,
      [SCRIPT, "--old", oldPath, "--root", root, "--table"],
      { encoding: "utf8" },
    );
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /PASS: rules-file-diet-check/);
    assert.match(
      ok.stdout,
      /\| 7 \| Existing behaviour MUST keep working\. \| CLAUDE\.md:7 \|/,
    );
    fs.writeFileSync(
      path.join(root, "CLAUDE.md"),
      goodTree()["CLAUDE.md"].replace("Never break the WebGL path.", ""),
    );
    const lost = spawnSync(
      process.execPath,
      [SCRIPT, "--old", oldPath, "--root", root],
      { encoding: "utf8" },
    );
    assert.equal(lost.status, 1);
    assert.match(
      lost.stderr,
      /FAIL: rule lost \(old line 8\): Never break the WebGL path/,
    );
  });
});

test("mutant: with the lost-rule check unreachable, a deleted rule stops failing", async (t) => {
  const mod = await importMutant(
    t,
    "const lost = rules.filter((r) => !r.where);",
    "const lost = rules.filter((r) => false && !r.where);",
  );
  const files = withEdit(
    goodTree(),
    "CLAUDE.md",
    "Never cite a lead as a premise.\n",
    "Leads are useful.\n",
  );
  assert.equal(
    check(files, { mod }).pass,
    true,
    "the mutant must be inert; the real checker fails this tree",
  );
  assert.equal(check(files).pass, false);
});

test("mutant: with the principle comparison unreachable, a renumbered principle stops failing", async (t) => {
  const mod = await importMutant(
    t,
    'if (a.join("\\n") !== b.join("\\n")) {',
    'if (false && a.join("\\n") !== b.join("\\n")) {',
  );
  const files = withEdit(
    goodTree(),
    "CLAUDE.md",
    "### 3. Late Principle",
    "### 4. Late Principle",
  );
  assert.equal(check(files, { mod }).pass, true);
  assert.equal(check(files).pass, false);
});

test("mutant: with the pointer-file check unreachable, an unlisted skill stops failing", async (t) => {
  const mod = await importMutant(
    t,
    "if (!text.includes(s.file)) problems.push",
    "if (false && !text.includes(s.file)) problems.push",
  );
  const files = { ...goodTree(), "AGENTS.md": "nothing\n" };
  assert.equal(check(files, { mod }).pass, true);
  assert.equal(check(files).pass, false);
});

test("a link in the core, a skill or a pointer file must resolve", () => {
  const files = {
    ...goodTree(),
    "docs/NOTES.md": "# Notes\n",
    ".claude/skills/shader-rules/SKILL.md":
      goodTree()[".claude/skills/shader-rules/SKILL.md"] +
      "\nSee [notes](../../../docs/NOTES.md#top).\n",
  };
  assert.deepEqual(check(files).problems, []);
  const broken = withEdit(
    files,
    ".claude/skills/shader-rules/SKILL.md",
    "../../../docs/NOTES.md",
    "../docs/NOTES.md",
  );
  assert.match(
    check(broken).problems.join("\n"),
    /SKILL\.md: link target \.\.\/docs\/NOTES\.md#top does not resolve/,
  );
  const inFence = withEdit(
    goodTree(),
    "CLAUDE.md",
    "## On-demand Skills",
    "```md\n[x](missing.md)\n```\n\n## On-demand Skills",
  );
  assert.deepEqual(
    check(inFence).problems,
    [],
    "a link inside a fenced sample is not a citation",
  );
});

test("mutant: with link resolution unreachable, a broken link stops failing", async (t) => {
  const mod = await importMutant(
    t,
    "if (!fs.existsSync(path.resolve(path.dirname(abs), decodeURI(target)))) {",
    "if (false && !fs.existsSync(path.resolve(path.dirname(abs), decodeURI(target)))) {",
  );
  const files = withEdit(
    goodTree(),
    "CLAUDE.md",
    "## On-demand Skills",
    "See [gone](gone.md).\n\n## On-demand Skills",
  );
  assert.equal(check(files, { mod }).pass, true);
  assert.equal(check(files).pass, false);
});
