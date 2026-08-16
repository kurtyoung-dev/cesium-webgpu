// generate-tooling-catalog.spec.mjs — self-test for the catalog generator.
// Pure Node: no browser, no network, no GPU.
//
// @purpose Self-test for the catalog generator: marker containment, determinism, drift reporting and the no-header row.
// @status ACTIVE
//
// WHAT IS ACTUALLY AT RISK HERE. The generator rewrites a region of a tracked
// document that also contains a hand-written analyst report and five maintainer
// rulings. Two properties matter more than the table's contents:
//
//   1. CONTAINMENT. Everything outside the markers must survive byte-for-byte.
//      B1 proves it against the real catalog rather than a fixture, because the
//      real file is the one with prose worth losing.
//   2. VISIBLE DRIFT. A file with no header must produce a row, not an absence.
//      A census that silently omits what it cannot classify is precisely the
//      failure the audit measured — 380 probes documented nowhere, four
//      documented files that no longer existed.
//
// The `--check` lane is red by design until `Tools/inject-purpose-headers.mjs`
// has been applied to the tree, so this spec asserts that the checker can SEE
// its subject (markers found, census non-empty, drift described in reviewable
// terms) rather than asserting a colour it cannot honestly have yet.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BEGIN_MARKER,
  END_MARKER,
  classify,
  collectCensus,
  describeDrift,
  listToolingFiles,
  renderCensus,
  splitCatalog,
} from "./generate-tooling-catalog.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CATALOG = path.join(ROOT, "migration_doc", "TOOLING_CATALOG.md");

/** The census is expensive (a git pass + ~1000 file reads); build it once. */
let censusCache = null;
const census = () => (censusCache ??= collectCensus());

// ---------------------------------------------------------------------------
// A. Scope and classification
// ---------------------------------------------------------------------------

test("A1: the census covers the whole tooling library", () => {
  const files = listToolingFiles();
  assert.ok(files.length > 900, `only ${files.length} .mjs files found`);
  assert.ok(files.every((f) => f.endsWith(".mjs")));
  assert.ok(files.includes("Tools/generate-tooling-catalog.mjs"));
  assert.ok(files.some((f) => f.startsWith("scripts/")));
  assert.deepEqual(files, [...files].sort(), "the file list is not sorted");
});

test("A2: class comes from @class when declared and from the path otherwise", () => {
  assert.equal(classify("Tools/visual-regression/probe-x.mjs", null), "probe");
  assert.equal(classify("Tools/visual-regression/x.spec.mjs", null), "spec");
  assert.equal(
    classify("Tools/visual-regression/lib/x-gate.mjs", null),
    "gate-lib",
  );
  assert.equal(classify("Tools/visual-regression/lib/x.mjs", null), "lib");
  assert.equal(
    classify("Tools/moon-albedo-bake/bake-x.mjs", null),
    "bake-tool",
  );
  assert.equal(
    classify("Tools/visual-regression/fixtures/x.mjs", null),
    "fixture",
  );
  assert.equal(
    classify("Tools/visual-regression/output/x.mjs", null),
    "scratch",
  );
  assert.equal(classify("Tools/x.mjs", null), "other");
  // A declared class wins: the path convention is a fallback, not an override.
  assert.equal(classify("Tools/x.mjs", "runner"), "runner");
  assert.equal(
    classify("Tools/visual-regression/probe-x.mjs", "scratch"),
    "scratch",
  );
});

// ---------------------------------------------------------------------------
// B. Containment
// ---------------------------------------------------------------------------

test("B1: regenerating replaces ONLY the marked region of the real catalog", () => {
  const text = readFileSync(CATALOG, "utf8");
  const split = splitCatalog(text);
  assert.ok(split !== null, "the census markers are missing from the catalog");
  assert.ok(split.before.includes("## Pending maintainer rulings"));
  assert.ok(split.before.includes("Analyst report"));

  const rebuilt = `${split.before}${renderCensus(census(), split.eol)}${split.after}`;
  const reSplit = splitCatalog(rebuilt);
  assert.equal(reSplit.before, split.before, "prose above the census changed");
  assert.equal(reSplit.after, split.after, "prose below the census changed");
});

test("B2: the rendered region starts and ends with the markers", () => {
  const rendered = renderCensus(census(), "\n");
  assert.ok(rendered.startsWith(BEGIN_MARKER));
  assert.ok(rendered.endsWith(END_MARKER));
  // A second BEGIN inside the region would make the next split ambiguous.
  assert.equal(rendered.split(BEGIN_MARKER).length, 2);
  assert.equal(rendered.split(END_MARKER).length, 2);
});

test("B3: a catalog without markers is STRUCTURAL, not a silent rewrite", () => {
  assert.equal(splitCatalog("# A doc with no markers\n"), null);
  assert.equal(splitCatalog(`${END_MARKER}\n${BEGIN_MARKER}\n`), null);
});

// ---------------------------------------------------------------------------
// C. Determinism and content
// ---------------------------------------------------------------------------

test("C1: rendering is deterministic", () => {
  const a = renderCensus(census(), "\n");
  const b = renderCensus(census(), "\n");
  assert.equal(a, b);
});

test("C2: the requested EOL is the one that is emitted", () => {
  const crlf = renderCensus(census(), "\r\n");
  assert.ok(
    !/[^\r]\n/.test(crlf),
    "an LF-only line ending leaked into the region",
  );
});

test("C3: every in-scope file gets exactly one row", () => {
  const data = census();
  assert.equal(data.rows.length, listToolingFiles().length);
  const seen = new Set(data.rows.map((r) => r.file));
  assert.equal(seen.size, data.rows.length, "a file was rendered twice");
});

test("C4: a file with no header is NAMED, not omitted", () => {
  const data = census();
  const unregistered = data.rows.filter(
    (r) => r.status === "NO @purpose HEADER",
  );
  assert.ok(unregistered.length > 0, "the fixture for this rule has vanished");
  const rendered = renderCensus(data, "\n");
  assert.ok(rendered.includes("NO @purpose HEADER"));
  assert.ok(
    rendered.includes(`| ${unregistered[0].base} |`),
    "an unregistered file was dropped from the table",
  );
});

test("C5: a self-registered file's own purpose reaches the table", () => {
  const data = census();
  const row = data.rows.find(
    (r) => r.file === "Tools/generate-tooling-catalog.mjs",
  );
  assert.equal(row.status, "ACTIVE");
  assert.match(row.purpose, /Regenerates the TOOLING_CATALOG census/);
  assert.ok(renderCensus(data, "\n").includes(row.purpose));
});

test("C6: table cells cannot break the table", () => {
  const rendered = renderCensus(
    {
      rows: [
        {
          file: "Tools/x.mjs",
          directory: "Tools/",
          base: "x.mjs",
          className: "other",
          status: "ACTIVE",
          touched: "2026-08-16",
          refs: 0,
          purpose: "A purpose with a | pipe\nand a newline.",
          notes: "",
        },
      ],
      byDirectory: new Map([
        [
          "Tools/",
          [
            {
              file: "Tools/x.mjs",
              directory: "Tools/",
              base: "x.mjs",
              className: "other",
              status: "ACTIVE",
              touched: "2026-08-16",
              refs: 0,
              purpose: "A purpose with a | pipe\nand a newline.",
              notes: "",
            },
          ],
        ],
      ]),
    },
    "\n",
  );
  const row = rendered.split("\n").find((l) => l.startsWith("| x.mjs |"));
  assert.ok(row, "the row vanished");
  // Six columns means seven UNESCAPED delimiters; the pipe inside the purpose
  // must survive as `\|` and must not become an eighth.
  assert.equal(
    row.split(/(?<!\\)\|/).length - 1,
    7,
    "the pipe escaped the cell",
  );
  assert.ok(row.includes("\\|"));
  assert.ok(!row.includes("\n"), "a newline escaped the cell");
});

// ---------------------------------------------------------------------------
// D. Drift reporting
// ---------------------------------------------------------------------------

const ROW = (name, date, purpose) =>
  `| ${name} | probe | ACTIVE | ${date} | 1 | ${purpose} |`;

test("D1: drift is described as added / removed / changed", () => {
  const before = [
    ROW("a.mjs", "2026-08-01", "A."),
    ROW("b.mjs", "2026-08-01", "B."),
  ].join("\n");
  const after = [
    ROW("a.mjs", "2026-08-01", "A revised."),
    ROW("c.mjs", "2026-08-02", "C."),
  ].join("\n");
  const lines = describeDrift(before, after);
  assert.match(lines[0], /rows added 1, removed 1, changed 1/);
  assert.ok(lines.some((l) => l.trim() === "+ c.mjs"));
  assert.ok(lines.some((l) => l.trim() === "- b.mjs"));
  assert.ok(lines.some((l) => l.trim() === "~ a.mjs"));
});

test("D2: a date-only change is called a date-only change", () => {
  // Freshness churn and real reclassification must not read the same, or the
  // check becomes noise somebody learns to ignore.
  const before = ROW("a.mjs", "2026-08-01", "A.");
  const after = ROW("a.mjs", "2026-08-16", "A.");
  assert.match(
    describeDrift(before, after)[0],
    /changed 1 \(of which 1 differ only/,
  );
});

test("D3: an identical region reports no drift at all", () => {
  const region = renderCensus(census(), "\n");
  assert.equal(region, renderCensus(census(), "\n"));
  assert.match(
    describeDrift(region, region)[0],
    /added 0, removed 0, changed 0/,
  );
});
