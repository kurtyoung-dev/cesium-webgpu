#!/usr/bin/env node
// verify-doc-citations.spec.mjs — the behaviour spec for the doc-citation guard.
// @purpose Pins verify-doc-citations.mjs against fixture trees: clean passes, a mutated link fails and is named, an out-of-bounds anchor fails, a .js→.ts rename fails, the P-14 false-positive shape stays green, and an inertness mutant of the resolution fold makes the core assertion fail.
// @status ACTIVE
//
// WHY THIS EXISTS. The guard's job is to stop a rotted `file:line` from
// manufacturing a false premise. A spec for it has to answer a harder question
// than "did the guard run": it has to show the guard fails on the citations
// that are dead AND stays silent on the ones that only LOOK dead. Those two are
// in tension, and a guard tuned for either one alone is worthless — a resolver
// that reds on correct prose gets a permanent `|| true`, and a resolver that
// greens on everything is a `|| true` that nobody noticed writing.
//
// So the assertions come in matched pairs. The negative control (a good link
// mutated to a nonexistent path) and the P-14 fixture (the shapes the
// 2026-09-04 audit's nine false failures were harvested from — a table cell
// writing its own `archive/…` and `lib/…` prefixes in backticks, next to real
// links that DO carry those prefixes) are the same assertion read from both
// sides. The P-14 case additionally asserts its own NON-VACUITY: the document
// must yield exactly the two citations that are really links, because "no
// findings" is also what a scanner that read nothing would report.
//
// THE MUTANT IS THE LOAD-BEARING TEST. Everything above passes just as happily
// against a guard whose resolution fold has been switched off — the clean cases
// stay clean, and only the failing cases change. So the last test copies the
// guard's own source, rewrites `if (!hit(fromDoc))` to `if (false && …)` so the
// fold is UNREACHABLE rather than absent, and requires the negative control to
// stop failing. It asserts the rewrite applied exactly once (a mutation that
// silently missed is a green test certifying nothing) and that the mutant still
// reports the clean fixture as PASS (so the negative control's change is
// inertness, not a mutant that broke outright).
//
// THE IGNORE ORACLE IS THE OTHER LOAD-BEARING TEST, AND IT IS HERE BECAUSE THE
// SPEC WAS BLIND TO IT. Tests 1-9 inject `isIgnored: () => false`, so not one of
// them reaches `makeIgnoreOracle`, its child-path probe, or `prime` — the one
// place the guard rewrites the question it asks git, and the place the guard's
// own JSDoc records a catastrophic false negative. A reviewer proved the gap
// rather than asserting it, by substituting the documented trap for the child
// probe: the nine tests passed 9/9 while the real run collapsed from 48 dead /
// 250 advisory to 2 dead / 296 — 46 real findings silently reclassified as
// declared build artifacts, still exiting 1, still looking healthy. Tests 10 and
// 11 close that by asserting the two properties the trap breaks: the probe is
// SELECTIVE (an ordinary tracked path is not reported ignored, a genuinely
// ignored one is), and `prime` is a pure speed-up (primed and unprimed oracles
// agree), which is the invariant `verifyDocCitations` states in its own JSDoc
// and which nothing checked.
//
// FIXTURES LIVE UNDER os.tmpdir() AND NOWHERE ELSE. Every fixture root comes
// from `mkdtempSync` under the real temp directory and is asserted to be inside
// it before anything is written and again before anything is removed. Nothing
// here touches the repository under test, and no git command that writes is run
// against it. Tests 10 and 11 need a tree git will answer questions about, so
// they `git init` a throwaway repository inside their own containment-asserted
// fixture root — the only repository this file creates, and the only place any
// writing git command runs.
//
// RUN
//   node --test Tools/verify-doc-citations.spec.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { exitCodeForS5Status } from "./visual-regression/lib/verdict-exit-gate.mjs";
import {
  DISPOSITIONS,
  makeIgnoreOracle,
  selectDocs,
  verifyDocCitations,
} from "./verify-doc-citations.mjs";

const GUARD_PATH = fileURLToPath(
  new URL("./verify-doc-citations.mjs", import.meta.url),
);

const EXIT_GATE_PATH = fileURLToPath(
  new URL("./visual-regression/lib/verdict-exit-gate.mjs", import.meta.url),
);

/** The real temp directory, symlinks resolved, so containment is decidable. */
const TMP_ROOT = realpathSync(os.tmpdir());

/** Every fixture root created by this run, removed in `after`. */
const fixtureRoots = [];

/**
 * Refuse to touch anything that is not inside the temp directory.
 *
 * This is structural, not decorative: the only destructive call in this file is
 * the `rmSync` in `after`, and it runs on whatever these roots hold.
 *
 * @param {string} root Candidate fixture root.
 * @returns {string} The same root.
 */
function assertInsideTmp(root) {
  const resolved = path.resolve(root);
  const relative = path.relative(TMP_ROOT, resolved);
  assert.ok(
    relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative) &&
      resolved !== TMP_ROOT,
    `fixture root ${resolved} is not inside ${TMP_ROOT}`,
  );
  return resolved;
}

/**
 * A source file whose line 2 defines `sampleAndBlend`.
 *
 * @returns {string} File text.
 */
function thingSource() {
  return [
    "// Thing.ts — the fixture's only source file.",
    "export function sampleAndBlend(a, b) {",
    "  return a + b;",
    "}",
    "",
  ].join("\n");
}

/**
 * The clean guide. Every citation in it resolves as written.
 *
 * @param {object} [mutation] One `{ from, to }` string replacement.
 * @returns {string} Document text.
 */
function guideDoc(mutation) {
  const text = [
    "# Guide",
    "",
    "The archived notes are at [archive/OLD_NOTES.md](archive/OLD_NOTES.md)",
    "and the nested one at [the deep doc](sub/DEEP.md).",
    "",
    "The shared module",
    "[lib/probe-lib.mjs](../Tools/visual-regression/lib/probe-lib.mjs)",
    "launches no browser of its own.",
    "",
    "The blend helper",
    "[`sampleAndBlend`](../packages/engine/Source/Renderer/WebGPU/Thing.ts#L2-L4)",
    "is where the imagery layers combine.",
    "",
    "A whole directory: [the renderer directory](../packages/engine/Source/Renderer/WebGPU/).",
    "",
    "```js",
    "// A sample, not a citation.",
    "[not a citation](nowhere/at/all.md)",
    "```",
    "",
  ].join("\n");
  if (mutation === undefined) {
    return text;
  }
  const mutated = text.replace(mutation.from, mutation.to);
  assert.notEqual(mutated, text, `mutation ${mutation.from} did not apply`);
  return mutated;
}

/**
 * The P-14 shape: prose that WRITES path-like strings, beside real links that
 * carry their own directory prefix and archive status.
 *
 * @returns {string} Document text.
 */
function p14Doc() {
  return [
    "# Probe inventory",
    "",
    "| Probe | Purpose |",
    "|---|---|",
    "| `archive/probe-tonemap.mjs` (BROKEN_STALE — archived 2026-08-16, M1) | Tonemap |",
    "| `probe-cmd-pushes.mjs` / `archive/probe-trace-counts.mjs` (BROKEN_STALE) | Counts |",
    "| `archive/probe-globe-timing.mjs` (BROKEN_STALE — archived 2026-08-16, M1) | Timing |",
    "| `lib/weather-probe-pinning.mjs` | Determinism pinning |",
    "| `lib/cloud-probe-harness.mjs` | Cloud harness |",
    "",
    "> Runtime-resident probes don't use `PROBE_BASE` at all —",
    "> `probe-oit-model-reachable.mjs` takes `--port` instead.",
    "",
    "The pinning module",
    "[lib/weather-probe-pinning.mjs](../Tools/visual-regression/lib/weather-probe-pinning.mjs)",
    "is the single enforceable home, and",
    "[`cloud-probe-harness.mjs`](../Tools/visual-regression/lib/cloud-probe-harness.mjs)",
    "configures the rest.",
    "",
  ].join("\n");
}

/**
 * The files every fixture starts from. Keys are the tracked set.
 *
 * @returns {Record<string, string>} Repo-relative path → content.
 */
function baseFiles() {
  return {
    "migration_doc/GUIDE.md": guideDoc(),
    "migration_doc/archive/OLD_NOTES.md": "# Old notes\n",
    "migration_doc/sub/DEEP.md": "# Deep\n",
    "packages/engine/Source/Renderer/WebGPU/Thing.ts": thingSource(),
    "Tools/visual-regression/lib/probe-lib.mjs": "export const a = 1;\n",
    "Tools/visual-regression/lib/weather-probe-pinning.mjs":
      "export const b = 2;\n",
    "Tools/visual-regression/lib/cloud-probe-harness.mjs":
      "export const c = 3;\n",
    "Tools/visual-regression/archive/probe-old.mjs": "export const d = 4;\n",
  };
}

/**
 * Materialise a fixture tree under the temp directory.
 *
 * @param {Record<string, string>} files Repo-relative path → content.
 * @returns {object} `{ root, tracked, verify }`.
 */
function makeFixture(files) {
  const root = assertInsideTmp(
    mkdtempSync(path.join(TMP_ROOT, "verify-doc-citations-")),
  );
  fixtureRoots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  const tracked = new Set(Object.keys(files));
  const verify = (implementation = verifyDocCitations, options = {}) =>
    implementation({
      docs: selectDocs(tracked, false),
      tracked,
      readFile: (relative) => readFileSync(path.join(root, relative), "utf8"),
      onDisk: (relative) => existsSync(path.join(root, relative)),
      isIgnored: () => false,
      ...options,
    });
  return { root, tracked, verify };
}

/**
 * The candidate paths tests 10 and 11 ask the ignore oracle about.
 *
 * Ordered deliberately: two paths that MUST come back ignored (one reachable
 * only through the child probe, one through the plain spelling), three ordinary
 * tracked paths that must not, and one that escapes the repository altogether.
 *
 * @returns {Array<{path: string, ignored: boolean, why: string}>} Expectations.
 */
function ignoreExpectations() {
  return [
    {
      path: "Tools/visual-regression/output",
      ignored: true,
      why: "a directory-only pattern, spelled as a file — the child probe is the only spelling that reaches it, and this path does not exist on disk",
    },
    {
      path: "notes/run.log",
      ignored: true,
      why: "a plain pattern, matched by the candidate's own spelling — the child probe must be an addition, not a substitution",
    },
    {
      path: "migration_doc/GUIDE.md",
      ignored: false,
      why: "an ordinary tracked document",
    },
    {
      path: "packages/engine/Source/Renderer/WebGPU/Thing.ts",
      ignored: false,
      why: "an ordinary tracked source file",
    },
    {
      path: "Tools/visual-regression/lib/probe-lib.mjs",
      ignored: false,
      why: "tracked, and a sibling of the ignored directory rather than a child of it",
    },
    {
      path: "../CLAUDE.md",
      ignored: false,
      why: "escapes the repository, so nothing inside it can ignore the path — and git aborts a whole batch handed one",
    },
  ];
}

/**
 * A throwaway git repository whose `.gitignore` carries both shapes.
 *
 * The ignore file is written with CRLF ON PURPOSE. The trap the guard's JSDoc
 * warns about — `check-ignore --no-index -- "<path>/"` matching a blank line —
 * only reproduces when the ignore file is CRLF, because git drops the `\n` and
 * keeps the `\r`, leaving a one-character pattern that a directory-spelled query
 * matches. An LF fixture would let the trailing-slash mutant pass, which is
 * exactly the blindness these tests exist to remove.
 *
 * None of the ignored paths is created on disk: `check-ignore --no-index`
 * answers about paths that do not exist, and that is the property the guard
 * relies on in a fresh clone.
 *
 * @returns {string} The repository root, inside the temp directory.
 */
function makeGitFixture() {
  const root = assertInsideTmp(
    mkdtempSync(path.join(TMP_ROOT, "verify-doc-citations-git-")),
  );
  fixtureRoots.push(root);
  const runGit = (args) =>
    execFileSync("git", args, { cwd: root, timeout: 60_000, stdio: "ignore" });
  runGit(["init", "-q"]);
  // A developer's global ignore file must not be able to change these answers.
  runGit(["config", "--local", "core.excludesFile", path.join(root, ".none")]);
  writeFileSync(
    path.join(root, ".gitignore"),
    [
      "# fixture ignore file, CRLF on purpose — see makeGitFixture",
      "/Tools/visual-regression/output/",
      "",
      "*.log",
      "",
    ].join("\r\n"),
    "utf8",
  );
  for (const relative of [
    "migration_doc/GUIDE.md",
    "packages/engine/Source/Renderer/WebGPU/Thing.ts",
    "Tools/visual-regression/lib/probe-lib.mjs",
  ]) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, "// fixture\n", "utf8");
  }
  return root;
}

/**
 * The process exit code the CLI would return for a report.
 *
 * @param {object} report A report from `verifyDocCitations`.
 * @returns {number} 0 or 1.
 */
function exitFor(report) {
  return exitCodeForS5Status(report.status);
}

/**
 * The one violation in a report, asserted to be alone.
 *
 * @param {object} report A report.
 * @returns {object} The violation record.
 */
function soleViolation(report) {
  assert.equal(
    report.violations.length,
    1,
    `expected exactly one violation, got ${JSON.stringify(report.violations, null, 2)}`,
  );
  return report.violations[0];
}

/**
 * Run the guard's CLI as a real child process and return its exit code.
 *
 * @param {string[]} args Arguments.
 * @param {string} cwd Working directory.
 * @returns {number} Exit code.
 */
function runCli(args, cwd) {
  try {
    execFileSync(process.execPath, [GUARD_PATH, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      stdio: "pipe",
    });
    return 0;
  } catch (error) {
    return typeof error.status === "number" ? error.status : -1;
  }
}

after(() => {
  for (const root of fixtureRoots) {
    rmSync(assertInsideTmp(root), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. A clean fixture exits 0.
// ---------------------------------------------------------------------------

test("1 · a clean document set passes and exits 0", () => {
  const fixture = makeFixture(baseFiles());
  const report = fixture.verify();

  assert.deepEqual(report.violations, []);
  assert.equal(report.status, "PASS");
  assert.equal(exitFor(report), 0);

  // Non-vacuity: the clean run must actually have resolved citations, an
  // anchor, and the symbol clause. "Zero findings" is also what a scanner that
  // read nothing reports.
  assert.equal(report.totals.citations, 5);
  assert.equal(report.totals.lineAnchors, 1);
  assert.equal(report.totals.symbolAssertions, 1);
  assert.equal(report.totals.byDisposition[DISPOSITIONS.OK], 5);
});

// ---------------------------------------------------------------------------
// 2. Negative control — one link mutated to a path that does not exist.
// ---------------------------------------------------------------------------

test("2 · a link mutated to a nonexistent path exits 1 and is named", () => {
  const files = baseFiles();
  files["migration_doc/GUIDE.md"] = guideDoc({
    from: "(sub/DEEP.md)",
    to: "(sub/DEEP_GONE.md)",
  });
  const report = makeFixture(files).verify();

  assert.equal(report.status, "FAIL");
  assert.equal(exitFor(report), 1);

  const violation = soleViolation(report);
  assert.equal(violation.doc, "migration_doc/GUIDE.md");
  assert.equal(violation.line, 4, "the referrer line must be the link's line");
  assert.equal(violation.target, "sub/DEEP_GONE.md");
  assert.equal(violation.disposition, DISPOSITIONS.MISSING_PATH);
  assert.equal(violation.cause, "missing path");
  assert.match(violation.detail, /migration_doc\/sub\/DEEP_GONE\.md/);
});

// ---------------------------------------------------------------------------
// 3. A #L range past end-of-file.
// ---------------------------------------------------------------------------

test("3 · an anchor past end-of-file exits 1", () => {
  const files = baseFiles();
  files["migration_doc/GUIDE.md"] = guideDoc({
    from: "Thing.ts#L2-L4",
    to: "Thing.ts#L400-L500",
  });
  const report = makeFixture(files).verify();

  assert.equal(report.status, "FAIL");
  assert.equal(exitFor(report), 1);

  const violation = soleViolation(report);
  assert.equal(violation.disposition, DISPOSITIONS.RANGE_OUT_OF_BOUNDS);
  assert.equal(violation.cause, "range out of bounds");
  // The file has four lines plus a trailing newline; the detail must say four,
  // not five — a trailing newline is not a line.
  assert.match(violation.detail, /#L400-L500 but .*Thing\.ts has 4 line\(s\)/);
});

// ---------------------------------------------------------------------------
// 4. An extension-renamed target — the CSM_DESIGN.md:71 shape.
// ---------------------------------------------------------------------------

test("4 · a .js target whose tree tracks only .ts exits 1 and names the .ts", () => {
  const files = baseFiles();
  files["migration_doc/GUIDE.md"] = guideDoc({
    from: "Thing.ts#L2-L4",
    to: "Thing.js#L2-L4",
  });
  const report = makeFixture(files).verify();

  assert.equal(report.status, "FAIL");
  assert.equal(exitFor(report), 1);

  const violation = soleViolation(report);
  assert.equal(violation.disposition, DISPOSITIONS.RENAMED_EXTENSION);
  assert.equal(violation.cause, "renamed extension");
  assert.match(violation.detail, /Thing\.js is gone/);
  assert.match(
    violation.detail,
    /the tree tracks packages\/engine\/Source\/Renderer\/WebGPU\/Thing\.ts/,
    "the detail must name the surviving sibling, which is the whole repair hint",
  );
});

// ---------------------------------------------------------------------------
// 5. The P-14 false-positive set stays green.
// ---------------------------------------------------------------------------

test("5 · the P-14 prose-and-prefix shapes produce no findings", () => {
  const files = baseFiles();
  files["migration_doc/PROBES.md"] = p14Doc();
  const report = makeFixture(files).verify();

  assert.deepEqual(
    report.violations,
    [],
    "path-shaped strings in prose are not citations, and links that write their own directory prefix resolve as written",
  );
  assert.equal(report.status, "PASS");
  assert.equal(exitFor(report), 0);

  // NON-VACUITY, in both directions. The P-14 document contributes exactly the
  // two citations that are real links: five backticked `archive/…` and `lib/…`
  // table entries and a `probe-oit-model-reachable.mjs` in a blockquote must
  // contribute none, and the two real links must contribute one each. Without
  // this, a scanner that had stopped reading the file would pass this test.
  const baseline = makeFixture(baseFiles()).verify();
  assert.equal(
    report.totals.citations - baseline.totals.citations,
    2,
    "the P-14 document must yield its two real links and nothing else",
  );
  assert.equal(report.totals.advisories, 0);
});

// ---------------------------------------------------------------------------
// 6. Inertness mutant — the resolution fold made unreachable.
// ---------------------------------------------------------------------------

test("6 · with the resolution fold made unreachable, the negative control stops failing", async () => {
  const mutantDir = assertInsideTmp(
    mkdtempSync(path.join(TMP_ROOT, "verify-doc-citations-mutant-")),
  );
  fixtureRoots.push(mutantDir);

  const original = readFileSync(GUARD_PATH, "utf8");
  const fold = "if (!hit(fromDoc)) {";
  assert.equal(
    original.split(fold).length - 1,
    1,
    "the resolution fold must appear exactly once for the mutation to be exact",
  );
  const importSpecifier = '"./visual-regression/lib/verdict-exit-gate.mjs"';
  assert.equal(
    original.split(importSpecifier).length - 1,
    1,
    "the exit-gate import must appear exactly once for the rewrite to be exact",
  );

  // The mutant lives in the temp directory, so its one relative import is
  // repointed at the real module by absolute URL. Nothing is written beside the
  // guard itself.
  const mutated = original
    .replace(fold, "if (false && !hit(fromDoc)) {")
    .replace(
      importSpecifier,
      JSON.stringify(pathToFileURL(EXIT_GATE_PATH).href),
    );
  assert.notEqual(mutated, original, "the mutation did not apply");

  const mutantPath = path.join(mutantDir, "mutant-verify-doc-citations.mjs");
  writeFileSync(mutantPath, mutated, "utf8");
  const mutant = await import(pathToFileURL(mutantPath).href);

  // The mutant must still WORK on the clean case. If it broke outright, the
  // negative-control result below would prove nothing about the fold.
  const cleanReport = makeFixture(baseFiles()).verify(
    mutant.verifyDocCitations,
  );
  assert.equal(
    cleanReport.status,
    "PASS",
    "the mutant must still run; a broken mutant proves nothing about inertness",
  );

  const files = baseFiles();
  files["migration_doc/GUIDE.md"] = guideDoc({
    from: "(sub/DEEP.md)",
    to: "(sub/DEEP_GONE.md)",
  });
  const mutantReport = makeFixture(files).verify(mutant.verifyDocCitations);

  assert.equal(
    mutantReport.status,
    "PASS",
    "test 2 must be load-bearing on the resolution fold: with the fold unreachable, the dead link must go unreported",
  );
  assert.deepEqual(mutantReport.violations, []);
  assert.equal(exitFor(mutantReport), 0);
});

// ---------------------------------------------------------------------------
// Beyond the six: the symbol clause, its conservatism, and the CLI's own codes.
// ---------------------------------------------------------------------------

test("7 · an anchored range that no longer holds its named symbol exits 1", () => {
  const files = baseFiles();
  files["migration_doc/GUIDE.md"] = guideDoc({
    from: "Thing.ts#L2-L4",
    to: "Thing.ts#L1-L1",
  });
  const report = makeFixture(files).verify();

  const violation = soleViolation(report);
  assert.equal(violation.disposition, DISPOSITIONS.SYMBOL_ABSENT);
  assert.equal(violation.cause, "symbol absent");
  assert.match(violation.detail, /sampleAndBlend \(now at line 2\)/);
  assert.equal(exitFor(report), 1);
});

test("8 · the symbol clause refuses ambiguous prose", () => {
  const files = baseFiles();
  // A single lowercase word, a SCREAMING_SNAKE abbreviation and the target's own
  // basename are all rejected as symbol candidates, so this anchor — which
  // frames line 1 only — must still pass.
  files["migration_doc/GUIDE.md"] = [
    "# Guide",
    "",
    "See `blend`, `GLOBE_FS` and `Thing.ts` in",
    "[`Thing.ts`](../packages/engine/Source/Renderer/WebGPU/Thing.ts#L1-L1).",
    "",
  ].join("\n");
  const report = makeFixture(files).verify();

  assert.deepEqual(report.violations, []);
  assert.equal(report.totals.citations, 1);
  assert.equal(
    report.totals.symbolAssertions,
    0,
    "none of those tokens is code-shaped enough to assert on",
  );
});

test("9 · the CLI's own exit codes follow the frozen table", () => {
  const outside = makeFixture({ "migration_doc/NOTHING.md": "# Nothing\n" });

  assert.equal(runCli(["--help"], outside.root), 0, "--help is a clean exit");
  assert.equal(
    runCli(["--not-an-argument"], outside.root),
    exitCodeForS5Status("ERROR"),
    "an unreadable argument is an ERROR, not a FAIL",
  );
  assert.equal(
    runCli([], outside.root),
    exitCodeForS5Status("STRUCTURAL"),
    "outside a repository there is no tree to ask, which is STRUCTURAL",
  );
});

// ---------------------------------------------------------------------------
// 10. The ignore oracle's probe is selective.
//
// This is the assertion the trailing-slash trap breaks. Under it every path
// spelled as a directory comes back ignored, so the three tracked paths below
// flip to `true` and the whole corpus is silently reclassified as build
// artifacts. Nine tests survived that mutation; this one does not.
// ---------------------------------------------------------------------------

test("10 · the ignore oracle answers only for genuinely ignored paths", () => {
  const root = makeGitFixture();
  const oracle = makeIgnoreOracle(root);
  const expectations = ignoreExpectations();

  assert.ok(
    !existsSync(path.join(root, "Tools/visual-regression/output")),
    "the ignored directory must NOT exist — the oracle's whole value is answering about a path a fresh clone has never made",
  );

  oracle.prime(expectations.map((expectation) => expectation.path));
  for (const { path: candidate, ignored, why } of expectations) {
    assert.equal(
      oracle.isIgnored(candidate),
      ignored,
      `${candidate} should be ${ignored ? "ignored" : "NOT ignored"}: ${why}`,
    );
  }

  // Non-vacuity: an oracle that answered `false` to everything would satisfy
  // three of the six expectations above, so assert both answers are really in
  // the result set.
  const answers = expectations.map(({ path: candidate }) =>
    oracle.isIgnored(candidate),
  );
  assert.ok(
    answers.includes(true) && answers.includes(false),
    "the oracle must discriminate — a constant answer is not selectivity",
  );
});

// ---------------------------------------------------------------------------
// 11. `prime` is a pure speed-up.
//
// `verifyDocCitations`'s JSDoc calls `primeIgnored` "purely a performance seam:
// `isIgnored` must return the same answers either way". That invariant is what
// makes the batched single-spawn optimisation safe, and nothing asserted it —
// the CLI always primes, so a `prime` that disagreed with the lazy path would
// change every real run while every test stayed green.
// ---------------------------------------------------------------------------

test("11 · a primed oracle and an unprimed one give identical answers", () => {
  const root = makeGitFixture();
  const candidates = ignoreExpectations().map(
    (expectation) => expectation.path,
  );

  // Primed up front and NOT ASKED ANYTHING YET. Every lookup below would fill
  // this oracle's cache lazily, which is exactly what the last assertion has to
  // rule out, so it is held back until after the ignore file is gone.
  const sealed = makeIgnoreOracle(root);
  sealed.prime(candidates);

  const primed = makeIgnoreOracle(root);
  primed.prime(candidates);
  const lazy = makeIgnoreOracle(root);

  for (const candidate of candidates) {
    assert.equal(
      primed.isIgnored(candidate),
      lazy.isIgnored(candidate),
      `${candidate}: the batched prime and the per-path spawn must agree`,
    );
  }

  // Agreement alone cannot tell a working prime from one that silently no-ops
  // and leaves every lookup to the lazy path — which is what happened once, when
  // the escaping `../CLAUDE.md` made git abandon the whole batch and the run
  // stayed at ~100 s with nothing saying why. Both oracles agree in that world,
  // because both are answering lazily.
  //
  // So prove the batch really populated the cache: REMOVE the ignore file, which
  // is the only thing a fresh `git check-ignore` could consult, then ask the
  // oracle that has been primed and never queried. A populated cache is unmoved;
  // a no-op prime now spawns git against a repository that ignores nothing and
  // answers `false`.
  const ignoreFile = path.join(root, ".gitignore");
  assert.ok(
    ignoreFile.startsWith(`${assertInsideTmp(root)}${path.sep}`),
    "the only file this test removes must be inside its own fixture root",
  );
  rmSync(ignoreFile);
  assert.equal(
    sealed.isIgnored("Tools/visual-regression/output"),
    true,
    "prime must have recorded the answer; a prime that silently no-opped would answer false here",
  );
  assert.equal(
    makeIgnoreOracle(root).isIgnored("Tools/visual-regression/output"),
    false,
    "control: with the ignore file gone a cold oracle really does answer false, so the assertion above is not vacuous",
  );
});
