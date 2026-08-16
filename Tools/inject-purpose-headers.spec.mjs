// inject-purpose-headers.spec.mjs — self-test for the `@purpose` header codemod
// and the grammar module it shares with the catalog generator and the fleet
// contract. Pure Node: no browser, no network, no GPU.
//
// @purpose Self-test for the @purpose header codemod: mapping, placement, byte-exactness, idempotence and the dry-run report.
// @status ACTIVE
//
// WHAT IS ACTUALLY AT RISK HERE. A codemod that rewrites ~990 tracked files is
// a single command that can quietly corrupt the fleet. Three failure modes are
// worth a test each and are the reason this file exists:
//
//   1. LINE ENDINGS. The tree checks out with `core.autocrlf=true`. A
//      split/join through "\n" rewrites every CRLF in every file it touches and
//      produces a ~990-file diff in which the intended change is invisible.
//   2. PLACEMENT. Ruling M2 puts the stanza "after the first line" of the
//      header, but 353 of the fleet's 627 `//` headers wrap their opening
//      sentence across two or more lines; a literal reading cuts those
//      sentences in half. The rule implemented instead is "after the opening
//      sentence", which degenerates to "after the first line" whenever the
//      first line is a complete sentence — B3 and B4 pin both halves.
//   3. IDEMPOTENCE. A codemod kept for re-runnability (the `apply-logdepth-*`
//      precedent) that appends a second `@purpose` on the second run is worse
//      than one that was deleted.
//
// The sandbox tests drive the REAL `run()` over a temp tree rather than a
// reimplementation of it, so what is proven is the code path the operator will
// invoke.

import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUDIT_STATUS_TO_HEADER,
  PURPOSE_STATUSES,
  injectPurposeHeader,
  joinLines,
  locateHeaderBlock,
  parsePurposeHeader,
  splitLines,
} from "./lib/purpose-header.mjs";
import { globToRegExp, planRow, run } from "./inject-purpose-headers.mjs";

const FIELDS = {
  purpose: "Reproduces the example artifact and diffs it against WebGL.",
  status: "ACTIVE",
};

/**
 * Create a disposable repository-shaped tree.
 *
 * @param {Record<string, string>} files Repo-relative path -> contents.
 * @returns {string} The sandbox root.
 */
function sandbox(files) {
  const root = mkdtempSync(path.join(tmpdir(), "purpose-headers-"));
  for (const [rel, contents] of Object.entries(files)) {
    const absolute = path.join(root, rel);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

// ---------------------------------------------------------------------------
// A. The audit-status mapping
// ---------------------------------------------------------------------------

test("A1: the mapping is exactly the one that was ruled", () => {
  assert.deepEqual(AUDIT_STATUS_TO_HEADER, {
    ACTIVE: "ACTIVE",
    DELIBERATE_RED_FLAG: "ACTIVE",
    INVESTIGATION_ARTIFACT: "INVESTIGATION",
    LIKELY_SUPERSEDED: "INVESTIGATION",
    BROKEN_STALE: "INVESTIGATION",
    HELD_FOR_D8: null,
    UNKNOWN: null,
  });
});

test("A2: frozen and unclear rows are SKIPPED, never guessed", () => {
  // Charter 4.3: files declared paused in a handoff are not edited by anyone,
  // including a mechanical pass. UNKNOWN is skipped for a different reason —
  // a fabricated purpose in a generated catalog is worse than a visible gap.
  for (const status of ["HELD_FOR_D8", "UNKNOWN"]) {
    const plan = planRow({ f: "Tools/x.mjs", status, purpose: "Something." });
    assert.equal(plan.skip, `audit status ${status}`);
  }
});

test("A3: an unmapped or purpose-less row is skipped with a named reason", () => {
  assert.match(
    planRow({ f: "Tools/x.mjs", status: "INVENTED", purpose: "p" }).skip,
    /unmapped audit status/,
  );
  assert.equal(
    planRow({ f: "Tools/x.mjs", status: "ACTIVE", purpose: "   " }).skip,
    "row has no purpose",
  );
});

test("A4: Windows-style row paths are normalized", () => {
  const plan = planRow({
    f: "Tools\\visual-regression\\probe-x.mjs",
    status: "ACTIVE",
    purpose: "Does the thing.",
  });
  assert.equal(plan.file, "Tools/visual-regression/probe-x.mjs");
  assert.equal(plan.skip, null);
});

// ---------------------------------------------------------------------------
// B. Placement and byte-exactness
// ---------------------------------------------------------------------------

test("B1: splitLines/joinLines round-trip byte-exactly", () => {
  for (const source of [
    "a\r\nb\r\n",
    "a\nb",
    "a\rb\r",
    "",
    "\n",
    "mixed\r\nendings\nhere\r\n",
  ]) {
    assert.equal(joinLines(splitLines(source)), source, JSON.stringify(source));
  }
});

test("B2: a CRLF file stays CRLF, including the inserted lines", () => {
  const source = "// probe-x.mjs — a title.\r\n\r\nconst x = 1;\r\n";
  const { text } = injectPurposeHeader(source, FIELDS);
  assert.ok(!/[^\r]\n/.test(text), "an LF-only line ending was introduced");
  assert.equal((text.match(/\r\n/g) ?? []).length, splitLines(text).length);
});

test("B3: a one-line title takes the stanza directly after line 1", () => {
  const source =
    "// probe-x.mjs — a complete opening sentence.\n// More prose.\nconst x = 1;\n";
  const { text } = injectPurposeHeader(source, FIELDS);
  const lines = text.split("\n");
  assert.equal(lines[0], "// probe-x.mjs — a complete opening sentence.");
  assert.equal(lines[1], `// @purpose ${FIELDS.purpose}`);
  assert.equal(lines[2], "// @status ACTIVE");
  assert.equal(lines[3], "//");
  assert.equal(lines[4], "// More prose.");
});

test("B4: a WRAPPED opening sentence is not cut in half", () => {
  // The literal reading of "after the first line" would put the stanza between
  // "the LOG_DEPTH blocks to the" and "Mat*Lit primitive shaders", which is the
  // shape of 353 of the fleet's 627 line-comment headers.
  const source = [
    "// One-shot transform: add the LOG_DEPTH blocks to the Mat*Lit",
    "// primitive shaders (clipPosition builtin + FragOutput struct family).",
    "// Applied; idempotent.",
    "const x = 1;",
    "",
  ].join("\n");
  const { text } = injectPurposeHeader(source, FIELDS);
  const lines = text.split("\n");
  assert.match(lines[0], /^\/\/ One-shot transform/);
  assert.match(lines[1], /^\/\/ primitive shaders/);
  assert.equal(lines[2], `// @purpose ${FIELDS.purpose}`);
  assert.equal(lines[3], "// @status ACTIVE");
});

test("B5: a JSDoc header keeps JSDoc punctuation", () => {
  const source = [
    "/**",
    " * bake-x.mjs — reproducible bake.",
    " *",
    " * Longer prose.",
    " */",
    "const x = 1;",
    "",
  ].join("\n");
  const { text } = injectPurposeHeader(source, FIELDS);
  const lines = text.split("\n");
  assert.equal(lines[1], " * bake-x.mjs — reproducible bake.");
  assert.equal(lines[2], ` * @purpose ${FIELDS.purpose}`);
  assert.equal(lines[3], " * @status ACTIVE");
  assert.equal(parsePurposeHeader(text).purpose, FIELDS.purpose);
});

test("B6: a headerless file gets a minimal stanza, under any shebang", () => {
  const bare = injectPurposeHeader('import x from "y";\n', FIELDS);
  assert.equal(bare.text.split("\n")[0], `// @purpose ${FIELDS.purpose}`);
  assert.equal(bare.text.split("\n")[1], "// @status ACTIVE");
  assert.equal(bare.text.split("\n")[2], "");
  assert.equal(bare.text.split("\n")[3], 'import x from "y";');

  const shebang = injectPurposeHeader(
    '#!/usr/bin/env node\nimport x from "y";\n',
    FIELDS,
  );
  assert.equal(shebang.text.split("\n")[0], "#!/usr/bin/env node");
  assert.equal(shebang.text.split("\n")[1], `// @purpose ${FIELDS.purpose}`);
});

test("B7: nothing but the stanza changes", () => {
  const source = [
    "#!/usr/bin/env node",
    "// probe-x.mjs — a title.",
    "//",
    "// Prose that must survive verbatim, including  odd   spacing.",
    "",
    'import { chromium } from "playwright";',
    "const WATCHDOG_MS = 420_000;",
    "",
  ].join("\r\n");
  const { text } = injectPurposeHeader(source, FIELDS);
  const original = splitLines(source).map((l) => l.text);
  const produced = splitLines(text).map((l) => l.text);
  const survivors = produced.filter(
    (line) => !/@(purpose|status)\b/.test(line),
  );
  assert.deepEqual(survivors, original, "a non-stanza line was rewritten");
});

test("B8: an unterminated block comment is a PARSE FAILURE, not a guess", () => {
  const result = injectPurposeHeader(
    "/* opened and never closed\nconst x = 1;\n",
    FIELDS,
  );
  assert.equal(result.action, "failed");
  assert.match(result.error, /never closed/);
});

test("B9: a status outside the vocabulary is refused", () => {
  const result = injectPurposeHeader("// t.\n", {
    purpose: "A purpose sentence.",
    status: "SORT-OF-ACTIVE",
  });
  assert.equal(result.action, "failed");
  for (const value of PURPOSE_STATUSES) {
    assert.ok(result.error.includes(value));
  }
});

// ---------------------------------------------------------------------------
// C. Idempotence
// ---------------------------------------------------------------------------

test("C1: a second run with the same fields changes nothing", () => {
  const source = "// probe-x.mjs — a title.\n// Prose.\nconst x = 1;\n";
  const once = injectPurposeHeader(source, FIELDS);
  const twice = injectPurposeHeader(once.text, FIELDS);
  assert.equal(once.action, "inserted");
  assert.equal(twice.action, "unchanged");
  assert.equal(twice.text, once.text);
});

test("C2: a changed purpose is rewritten IN PLACE, never duplicated", () => {
  const source = "// probe-x.mjs — a title.\n// Prose.\nconst x = 1;\n";
  const once = injectPurposeHeader(source, FIELDS);
  const revised = injectPurposeHeader(once.text, {
    purpose: "A revised purpose sentence for the same probe.",
    status: "INVESTIGATION",
  });
  assert.equal(revised.action, "updated");
  assert.equal((revised.text.match(/@purpose/g) ?? []).length, 1);
  assert.equal((revised.text.match(/@status/g) ?? []).length, 1);
  assert.equal(parsePurposeHeader(revised.text).status, "INVESTIGATION");
  assert.equal(splitLines(revised.text).length, splitLines(once.text).length);
});

test("C3: a hand-written header missing @status gains one without duplication", () => {
  const source =
    "// probe-x.mjs — a title.\n// @purpose Hand written already.\n// Prose.\n";
  const { text, action } = injectPurposeHeader(source, FIELDS);
  assert.equal(action, "updated");
  assert.equal((text.match(/@purpose/g) ?? []).length, 1);
  assert.equal(parsePurposeHeader(text).status, "ACTIVE");
});

test("C4: --with-class stamps the audit class and refreshes it in place", () => {
  const source = "// probe-x.mjs — a title.\n// Prose.\n";
  const once = injectPurposeHeader(source, { ...FIELDS, className: "probe" });
  assert.match(once.text, /^\/\/ @class probe$/m);
  const twice = injectPurposeHeader(once.text, {
    ...FIELDS,
    className: "probe",
  });
  assert.equal(twice.action, "unchanged");
  const moved = injectPurposeHeader(once.text, {
    ...FIELDS,
    className: "scratch",
  });
  assert.equal((moved.text.match(/@class/g) ?? []).length, 1);
  assert.match(moved.text, /^\/\/ @class scratch$/m);
});

// ---------------------------------------------------------------------------
// D. The glob filter
// ---------------------------------------------------------------------------

test("D1: --only globs match the shapes an operator types", () => {
  assert.ok(globToRegExp("Tools/c16/**").test("Tools/c16/lib/a.mjs"));
  assert.ok(
    globToRegExp("Tools/**/probe-*.mjs").test(
      "Tools/visual-regression/probe-a.mjs",
    ),
  );
  assert.ok(globToRegExp("Tools/**/probe-*.mjs").test("Tools/probe-a.mjs"));
  assert.ok(!globToRegExp("Tools/*.mjs").test("Tools/visual-regression/a.mjs"));
  assert.ok(globToRegExp("Tools/{a,b}.mjs").test("Tools/b.mjs"));
  assert.ok(!globToRegExp("Tools/{a,b}.mjs").test("Tools/c.mjs"));
  // A literal regex metacharacter in a path must not change the pattern.
  assert.ok(globToRegExp("Tools/a+b.mjs").test("Tools/a+b.mjs"));
  assert.ok(!globToRegExp("Tools/a+b.mjs").test("Tools/aab.mjs"));
});

// ---------------------------------------------------------------------------
// E. The real run(), over a sandbox tree
// ---------------------------------------------------------------------------

test("E1: --dry-run counts everything and writes nothing", () => {
  const root = sandbox({
    "Tools/a.mjs": "// a.mjs — a title.\nconst a = 1;\n",
    "Tools/b.mjs": "const b = 1;\n",
    "Tools/held.mjs": "const h = 1;\n",
  });
  const rows = path.join(root, "rows.json");
  writeFileSync(
    rows,
    JSON.stringify([
      {
        f: "Tools/a.mjs",
        cls: "other",
        status: "ACTIVE",
        purpose: "Purpose for a.",
      },
      {
        f: "Tools/b.mjs",
        cls: "probe",
        status: "BROKEN_STALE",
        purpose: "Purpose for b.",
      },
      {
        f: "Tools/held.mjs",
        cls: "probe",
        status: "HELD_FOR_D8",
        purpose: "Purpose for h.",
      },
      {
        f: "Tools/gone.mjs",
        cls: "probe",
        status: "ACTIVE",
        purpose: "Purpose for gone.",
      },
    ]),
  );
  try {
    const before = readFileSync(path.join(root, "Tools/a.mjs"), "utf8");
    const { counts, failures, skipped } = run({
      rows,
      dryRun: true,
      root,
      only: null,
    });
    assert.equal(counts.rows, 4);
    assert.equal(counts.eligible, 2);
    assert.equal(counts.inserted, 2);
    assert.equal(counts.skipped, 2);
    assert.equal(counts.absent, 1);
    assert.deepEqual(failures, []);
    assert.deepEqual(skipped.get("audit status HELD_FOR_D8"), [
      "Tools/held.mjs",
    ]);
    assert.deepEqual(skipped.get("absent from the working tree"), [
      "Tools/gone.mjs",
    ]);
    assert.equal(readFileSync(path.join(root, "Tools/a.mjs"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E2: a real write is idempotent and maps status correctly", () => {
  const root = sandbox({
    "Tools/a.mjs": "// a.mjs — a title.\r\nconst a = 1;\r\n",
    "Tools/b.mjs": "const b = 1;\n",
  });
  const rows = path.join(root, "rows.json");
  writeFileSync(
    rows,
    JSON.stringify([
      {
        f: "Tools/a.mjs",
        cls: "other",
        status: "ACTIVE",
        purpose: "Purpose for a.",
      },
      {
        f: "Tools/b.mjs",
        cls: "probe",
        status: "INVESTIGATION_ARTIFACT",
        purpose: "Purpose for b.",
      },
    ]),
  );
  try {
    const first = run({ rows, dryRun: false, root, only: null });
    assert.equal(first.counts.inserted, 2);
    const a = readFileSync(path.join(root, "Tools/a.mjs"), "utf8");
    const b = readFileSync(path.join(root, "Tools/b.mjs"), "utf8");
    assert.equal(parsePurposeHeader(a).status, "ACTIVE");
    assert.equal(parsePurposeHeader(b).status, "INVESTIGATION");
    assert.ok(!/[^\r]\n/.test(a), "the CRLF file was rewritten with LF");

    const second = run({ rows, dryRun: false, root, only: null });
    assert.equal(second.counts.unchanged, 2);
    assert.equal(second.counts.inserted, 0);
    assert.equal(readFileSync(path.join(root, "Tools/a.mjs"), "utf8"), a);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E3: --only narrows the run and leaves the rest untouched", () => {
  const root = sandbox({
    "Tools/c16/a.mjs": "// a.mjs — a title.\n",
    "Tools/other.mjs": "// other.mjs — a title.\n",
  });
  const rows = path.join(root, "rows.json");
  writeFileSync(
    rows,
    JSON.stringify([
      {
        f: "Tools/c16/a.mjs",
        cls: "other",
        status: "ACTIVE",
        purpose: "Purpose for a.",
      },
      {
        f: "Tools/other.mjs",
        cls: "other",
        status: "ACTIVE",
        purpose: "Purpose for other.",
      },
    ]),
  );
  try {
    const before = readFileSync(path.join(root, "Tools/other.mjs"), "utf8");
    const { counts } = run({ rows, dryRun: false, root, only: "Tools/c16/**" });
    assert.equal(counts.filteredOut, 1);
    assert.equal(counts.eligible, 1);
    assert.equal(
      readFileSync(path.join(root, "Tools/other.mjs"), "utf8"),
      before,
    );
    assert.match(
      readFileSync(path.join(root, "Tools/c16/a.mjs"), "utf8"),
      /@purpose/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E4: a file the grammar cannot parse is REPORTED, not skipped silently", () => {
  const root = sandbox({ "Tools/bad.mjs": "/* never closed\nconst x = 1;\n" });
  const rows = path.join(root, "rows.json");
  writeFileSync(
    rows,
    JSON.stringify([
      {
        f: "Tools/bad.mjs",
        cls: "other",
        status: "ACTIVE",
        purpose: "Purpose for bad.",
      },
    ]),
  );
  try {
    const { counts, failures } = run({ rows, dryRun: true, root, only: null });
    assert.equal(counts.failed, 1);
    assert.equal(counts.eligible, 1);
    assert.match(failures[0], /^Tools\/bad\.mjs: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E5: the header block scanner stops where the header stops", () => {
  // A guard against the class of bug that made the machine-safety analyzer go
  // blind mid-file: a block detector that runs past its terminator reads code
  // as comment and reports tags that are not declarations.
  const lines = splitLines("// one\n// two\n\n// three\nconst x = 1;\n");
  const block = locateHeaderBlock(lines);
  assert.equal(block.kind, "line");
  assert.equal(block.start, 0);
  assert.equal(block.end, 1);
});
