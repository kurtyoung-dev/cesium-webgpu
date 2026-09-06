// verify-readme-index.spec.mjs — contract for the README-index coverage guard.
//
// @purpose Contract for the README-index coverage guard: a tracked doc named nowhere in README must red, a README link to an untracked path must red, the directory-aggregate convention must keep a covered file green, and a fold-disabling mutant must fail the same assertion the live guard passes.
// @status ACTIVE
//
// Run: node --test Tools/verify-readme-index.spec.mjs
//
// WHY THE FIXTURES ARE PLAIN STRINGS/ARRAYS, NOT TEMP GIT REPOS. This guard's
// own tracked-path list comes from `git ls-files` (by design — see the
// guard's SOURCING note), but this campaign's workers do not run git write
// commands, and `git init && git add` in a throwaway directory is still one
// (see `verify-tracked-references.spec.mjs`'s identical rationale for a
// sibling guard). The guard is therefore split into a pure computation core,
// `buildReportFromInputs({readmeText, trackedPaths})`, and a thin I/O shell,
// `buildReport({root})`, that only the CLI uses. Every test below drives the
// pure core directly with in-memory fixtures — no git command runs. Group E
// is the one exception: a read-only `git ls-files` sanity check against this
// real repository (never a write), confirming the split did not change real
// behaviour.
//
// FIXTURE README TEXT IS STILL WRITTEN UNDER os.tmpdir() AND READ BACK, not
// just held as string literals, so the fixtures the guard checks (and the
// mutant module the last group loads) are real files on disk exactly as the
// guard would encounter them, per the lane's evidence rule.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { parsePurposeHeader } from "./lib/purpose-header.mjs";
import {
  buildReportFromInputs,
  extractDirectoryAggregates,
  extractLinkedMigrationDocPaths,
  isCovered,
  linkResolves,
  parseArgs,
} from "./verify-readme-index.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TOOL_PATH = fileURLToPath(
  new URL("./verify-readme-index.mjs", import.meta.url),
);
const SPEC_PATH = fileURLToPath(import.meta.url);

/** One scratch directory per test file run, always under `os.tmpdir()`. */
const SCRATCH_DIR = mkdtempSync(
  path.join(tmpdir(), "verify-readme-index-spec-"),
);
test.after(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

/**
 * Write README fixture text to a real file under the scratch dir and read it
 * back, so every fixture is a real file on disk, not just a string literal.
 *
 * @param {string} name Fixture file basename (unique per test).
 * @param {string} text README text to write.
 * @returns {string} The text, read back from disk.
 */
function writeAndReadFixture(name, text) {
  const fixturePath = path.join(SCRATCH_DIR, name);
  writeFileSync(fixturePath, text, "utf8");
  return readFileSync(fixturePath, "utf8");
}

// ---------------------------------------------------------------------------
// 1 — a clean fixture is green
// ---------------------------------------------------------------------------

test("1 a clean fixture (every tracked doc named, every link resolves) exits 0", () => {
  const readmeText = writeAndReadFixture(
    "clean-README.md",
    [
      "# Index",
      "",
      "| Doc | Role |",
      "|---|---|",
      "| [`ALPHA.md`](ALPHA.md) | Linked doc. |",
      "",
      "BETA.md is mentioned only in backtick prose, no link: `BETA.md`.",
      "",
    ].join("\n"),
  );
  const trackedPaths = [
    "migration_doc/README.md",
    "migration_doc/ALPHA.md",
    "migration_doc/BETA.md",
  ];
  const report = buildReportFromInputs({ readmeText, trackedPaths });
  assert.deepEqual(report.violations, []);
  assert.equal(report.trackedMarkdownCount, 2);
  const exitCode = report.violations.length > 0 ? 1 : 0;
  assert.equal(exitCode, 0);
});

// ---------------------------------------------------------------------------
// 2 — negative control / positive control pair (UNINDEXED)
// ---------------------------------------------------------------------------

/** Shared fixture text for the negative/positive UNINDEXED pair. */
const UNNAMED_DOC_README = [
  "# Index",
  "",
  "| Doc | Role |",
  "|---|---|",
  "| [`ALPHA.md`](ALPHA.md) | The only doc this README names. |",
  "",
].join("\n");

test("2a NEGATIVE — a tracked doc README does not name reds (UNINDEXED) and is named", () => {
  const readmeText = writeAndReadFixture(
    "unnamed-doc-README.md",
    UNNAMED_DOC_README,
  );
  const trackedPaths = [
    "migration_doc/README.md",
    "migration_doc/ALPHA.md",
    "migration_doc/ORPHAN.md",
  ];
  const report = buildReportFromInputs({ readmeText, trackedPaths });
  assert.equal(report.violations.length, 1);
  const [violation] = report.violations;
  assert.equal(violation.type, "UNINDEXED");
  assert.equal(violation.file, "migration_doc/ORPHAN.md");
  const exitCode = report.violations.length > 0 ? 1 : 0;
  assert.equal(exitCode, 1);
});

test("2b POSITIVE — the same fixture with ORPHAN.md named stays green", () => {
  // One bit of difference from 2a: README now names ORPHAN.md too. If this
  // leg ever reds, the guard is not reading README's text at all.
  const readmeText = writeAndReadFixture(
    "named-doc-README.md",
    `${UNNAMED_DOC_README}Also see \`ORPHAN.md\` for the historical record.\n`,
  );
  const trackedPaths = [
    "migration_doc/README.md",
    "migration_doc/ALPHA.md",
    "migration_doc/ORPHAN.md",
  ];
  const report = buildReportFromInputs({ readmeText, trackedPaths });
  assert.deepEqual(report.violations, []);
  const exitCode = report.violations.length > 0 ? 1 : 0;
  assert.equal(exitCode, 0);
});

// ---------------------------------------------------------------------------
// 3 — a README row pointing at a missing file reds (BROKEN-LINK)
// ---------------------------------------------------------------------------

test("3 a README link to an untracked path reds (BROKEN-LINK)", () => {
  const readmeText = writeAndReadFixture(
    "broken-link-README.md",
    [
      "# Index",
      "",
      "| Doc | Role |",
      "|---|---|",
      "| [`ALPHA.md`](ALPHA.md) | Present. |",
      "| [`GHOST.md`](GHOST.md) | Was archived/renamed and never repointed. |",
      "",
    ].join("\n"),
  );
  const trackedPaths = ["migration_doc/README.md", "migration_doc/ALPHA.md"];
  const report = buildReportFromInputs({ readmeText, trackedPaths });
  assert.equal(report.violations.length, 1);
  const [violation] = report.violations;
  assert.equal(violation.type, "BROKEN-LINK");
  assert.equal(violation.file, "migration_doc/GHOST.md");
  const exitCode = report.violations.length > 0 ? 1 : 0;
  assert.equal(exitCode, 1);
});

// ---------------------------------------------------------------------------
// 4 — the directory-aggregate convention keeps a covered file green
// ---------------------------------------------------------------------------

test("4a the directory-aggregate convention keeps an aggregated file green", () => {
  // README names the DIRECTORY, not the file, using the exact backtick-span
  // shape README.md:121-127 documents (a path ending in `/`). The nested file
  // itself is never named.
  const readmeText = writeAndReadFixture(
    "aggregate-README.md",
    [
      "# Index",
      "",
      "Historical snapshots under `archive/batch-plans/` are not indexed",
      "individually; treat the whole directory as covered.",
      "",
    ].join("\n"),
  );
  const trackedPaths = [
    "migration_doc/README.md",
    "migration_doc/archive/batch-plans/OLD_PLAN.md",
  ];
  const report = buildReportFromInputs({ readmeText, trackedPaths });
  assert.deepEqual(report.violations, []);
});

test("4b NEGATIVE twin — a file OUTSIDE the aggregated directory still reds", () => {
  // Same aggregate mention, but the tracked file sits in a sibling directory
  // the aggregate does not cover. Without this leg, 4a would only prove the
  // guard can be made to pass, not that the aggregate mechanism is doing the
  // work rather than some other accidental green.
  const readmeText = writeAndReadFixture(
    "aggregate-negative-README.md",
    [
      "# Index",
      "",
      "Historical snapshots under `archive/batch-plans/` are not indexed",
      "individually; treat the whole directory as covered.",
      "",
    ].join("\n"),
  );
  const trackedPaths = [
    "migration_doc/README.md",
    "migration_doc/archive/other-directory/UNCOVERED.md",
  ];
  const report = buildReportFromInputs({ readmeText, trackedPaths });
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].type, "UNINDEXED");
  assert.equal(
    report.violations[0].file,
    "migration_doc/archive/other-directory/UNCOVERED.md",
  );
});

test("4c the aggregate extractor reads README's OWN convention, not a hard-coded list", () => {
  // Direct check on the extractor the guard's docstring promises: a NEW
  // directory-aggregate mention README adds must be picked up without a
  // matching guard-source edit.
  const aggregates = extractDirectoryAggregates(
    "See `some/brand-new-directory/` for the full set.",
  );
  assert.ok(aggregates.has("some/brand-new-directory"));
});

// ---------------------------------------------------------------------------
// 5 — inertness mutant: disabling the coverage fold must break the negative
// control that group 2 relies on.
// ---------------------------------------------------------------------------

test("5 inertness mutant — an unreachable coverage fold fails the negative-control assertion", async () => {
  const source = readFileSync(TOOL_PATH, "utf8");
  const foldTarget =
    "if (!isCovered(relPath, readmeText, directoryAggregates)) {";
  assert.ok(
    source.includes(foldTarget),
    "the coverage-fold condition text changed — update this mutant's target string",
  );
  const mutatedSource = source.replace(
    foldTarget,
    // `false &&` makes the branch unreachable without deleting it — same
    // shape as the campaign's other inertness mutants (`if (false && ...)`).
    "if (false && !isCovered(relPath, readmeText, directoryAggregates)) {",
  );
  assert.notEqual(
    mutatedSource,
    source,
    "the replacement did not change the source — the mutant is a no-op",
  );

  const mutantPath = path.join(SCRATCH_DIR, "verify-readme-index.MUTANT.mjs");
  writeFileSync(mutantPath, mutatedSource, "utf8");
  const mutant = await import(pathToFileURL(mutantPath).href);

  // The exact fixture group 2a used, replayed here so this is genuinely the
  // "core assertion" group 2 depends on, not a fresh one written to order.
  const readmeText = UNNAMED_DOC_README;
  const trackedPaths = [
    "migration_doc/README.md",
    "migration_doc/ALPHA.md",
    "migration_doc/ORPHAN.md",
  ];

  const assertCatchesTheGap = (buildReportFromInputsFn) => {
    const report = buildReportFromInputsFn({ readmeText, trackedPaths });
    assert.equal(report.violations.length, 1);
    assert.equal(report.violations[0].type, "UNINDEXED");
    assert.equal(report.violations[0].file, "migration_doc/ORPHAN.md");
  };

  // The real module still catches it...
  assertCatchesTheGap(buildReportFromInputs);
  // ...but the mutant, with the coverage fold made unreachable, must not.
  assert.throws(
    () => assertCatchesTheGap(mutant.buildReportFromInputs),
    assert.AssertionError,
    "the mutant should have gone green (0 violations), which should fail this assertion — if it did not throw, the assertion was not exercising the disabled fold",
  );

  // Pin the actual mutant behaviour too, not just "some assertion throws":
  // it must report exactly 0 violations for the gap the real module catches.
  const mutantReport = mutant.buildReportFromInputs({
    readmeText,
    trackedPaths,
  });
  assert.deepEqual(mutantReport.violations, []);
});

// ---------------------------------------------------------------------------
// 6 — building blocks (small direct-unit checks; not a substitute for 1-5)
// ---------------------------------------------------------------------------

test("6a isCovered checks basename mention and ancestor-directory aggregates", () => {
  const aggregates = new Set(["archive/batch-plans"]);
  assert.equal(
    isCovered("FOO.md", "text that mentions FOO.md somewhere", new Set()),
    true,
  );
  assert.equal(
    isCovered(
      "archive/batch-plans/deep/FOO.md",
      "no mention at all",
      aggregates,
    ),
    true,
  );
  assert.equal(
    isCovered("UNMENTIONED.md", "nothing relevant here", new Set()),
    false,
  );
});

test("6b linkResolves accepts an exact tracked path or a tracked path under a directory-shaped link", () => {
  const tracked = new Set([
    "migration_doc/ALPHA.md",
    "migration_doc/archive/nested/FILE.md",
  ]);
  assert.equal(linkResolves("migration_doc/ALPHA.md", tracked), true);
  assert.equal(linkResolves("migration_doc/archive/nested", tracked), true);
  assert.equal(linkResolves("migration_doc/GHOST.md", tracked), false);
});

test("6c extractLinkedMigrationDocPaths skips external links and paths outside migration_doc", () => {
  const readmeText = [
    "[external](https://example.com/x.md)",
    "[outside](../CLAUDE.md)",
    "[inside](ALPHA.md)",
    "[fragment-only](#section)",
  ].join("\n");
  assert.deepEqual(extractLinkedMigrationDocPaths(readmeText), [
    "migration_doc/ALPHA.md",
  ]);
});

test("6d parseArgs accepts --root (both forms) and --json, and rejects unknown flags", () => {
  assert.deepEqual(parseArgs(["--root", "/x"]), { root: "/x", json: false });
  assert.deepEqual(parseArgs(["--root=/y", "--json"]), {
    root: "/y",
    json: true,
  });
  assert.throws(() => parseArgs(["--bogus"]));
  assert.throws(() => parseArgs(["--root"]));
});

// ---------------------------------------------------------------------------
// E — end to end against the real repository (read-only git; no writes)
// ---------------------------------------------------------------------------

test("E1 the real repository is clean under this guard (read-only sanity check)", () => {
  // `git ls-files` is a read, never a write — this is the one place the spec
  // touches the real tree, and only to confirm the split into
  // buildReportFromInputs + buildReport did not change real behaviour.
  const result = spawnSync(
    process.execPath,
    [TOOL_PATH, "--root", REPO_ROOT, "--json"],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.error, undefined, `CLI failed to spawn: ${result.error}`);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.violations,
    [],
    `expected the real repository to be clean, got: ${JSON.stringify(report.violations, null, 2)}`,
  );
  assert.equal(result.status, 0);
});

test("E2 both files carry a parseable purpose header", () => {
  for (const file of [TOOL_PATH, SPEC_PATH]) {
    const header = parsePurposeHeader(readFileSync(file, "utf8"));
    assert.ok(header.purpose, `${path.basename(file)} needs @purpose`);
    assert.equal(header.status, "ACTIVE");
    assert.deepEqual(header.errors, []);
  }
});
