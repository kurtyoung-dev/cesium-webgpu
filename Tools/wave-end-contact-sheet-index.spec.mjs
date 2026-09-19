// @purpose Behaviour spec for the DX-106 contact-sheet banking additions on
// Tools/wave-end-gate-receipt.mjs: the byte-unchanged golden comparison, the
// banked-sheet summary section, entry validation, and the md5-recompute
// collector, each proved load-bearing by an in-memory source mutation, plus
// the .prettierignore coverage that keeps a formatter out of the byte-pinned
// fixtures it reads.
// @status ACTIVE

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { getFileInfo } from "prettier";
import {
  buildContactSheetTable,
  buildMarkdownSummary,
  buildReceipt,
  collectContactSheets,
  RIG_ID_PATTERN,
  validateContactSheetEntry,
} from "./wave-end-gate-receipt.mjs";
import {
  RENDERER_IDS,
  SLOT_IDS,
  sheetIndexEntry,
} from "./visual-regression/lib/contact-sheet-page.mjs";
import { loadRigs } from "./visual-regression/lib/rig-registry.mjs";
import { buildFixtureReceiptInput } from "./visual-regression/fixtures/wave-end-contact-sheet/fixture-receipt-input.mjs";

const FIXTURE_ROOT = new URL(
  "./visual-regression/fixtures/wave-end-contact-sheet/",
  import.meta.url,
);
const REPO_ROOT_PATH = fileURLToPath(new URL("../", import.meta.url));

function fixturePath(...segments) {
  return path.join(fileURLToPath(FIXTURE_ROOT), ...segments);
}

// The fixtures here are compared byte-for-byte and hashed, and this repository
// checks out with `core.autocrlf=true`. The sibling `.gitattributes` marks the
// directory `-text` so a checkout leaves the bytes alone, but an attribute is
// only honoured once it is in effect: a patch that creates the fixtures and
// that file in one apply is not covered, and the fixtures land CRLF. Reading
// them through this makes every assertion below depend on the CONTENT rather
// than on whether the attribute was read — the failure the sibling
// `.gitattributes` records, and the reason it is not the only guard this
// directory needs.
function toLf(value) {
  if (typeof value === "string") {
    return value.split("\r\n").join("\n");
  }
  return Buffer.from(
    value.toString("latin1").split("\r\n").join("\n"),
    "latin1",
  );
}

// `readFile` is dependency-injected on `collectContactSheets` and is handed
// two different kinds of path: an absolute one this test constructs itself
// (for `sheet-index.json`) and the repo-relative one an entry's own `path`
// field carries verbatim (per KIT-B-OWNERSHIP.md §3.1, the one field in the
// entry that is NOT relative to the sheet's own directory). Both are resolved
// the same way a real caller would: absolute paths pass through, repo-relative
// ones resolve against the repository root.
async function repoRelativeReadFile(candidatePath) {
  const resolved = path.isAbsolute(candidatePath)
    ? candidatePath
    : path.join(REPO_ROOT_PATH, candidatePath);
  return toLf(await readFile(resolved));
}

function readDirReal(directoryPath) {
  return readdir(directoryPath);
}

function waveDirectoryFor(fixtureSubdir) {
  return fixturePath(fixtureSubdir);
}

/**
 * Loads `wave-end-gate-receipt.mjs` with exactly one textual substitution
 * applied, as a data: URL import — the same technique
 * Tools/wave-end-gate.spec.mjs uses for its production-source mutants. Its
 * only relative import (`./wave-end-gate-binding.mjs`) is rewritten to an
 * absolute file: URL so the substituted source still resolves it.
 *
 * @param {string} target Exact source text to replace; asserted unique.
 * @param {string} replacement Its inert replacement.
 * @param {string} label Used only in the uniqueness assertion's message.
 * @returns {Promise<object>} The mutated module namespace.
 */
async function importMutatedReceiptModule(target, replacement, label) {
  const sourceUrl = new URL("./wave-end-gate-receipt.mjs", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const occurrences = source.split(target).length - 1;
  assert.equal(
    occurrences,
    1,
    `${label} mutation must have exactly one target`,
  );
  const mutatedSource = source
    .replace(target, replacement)
    .replace(
      /(from\s+)(["'])(\.[^"']+)\2/g,
      (_match, prefix, _quote, specifier) =>
        `${prefix}${JSON.stringify(new URL(specifier, sourceUrl).href)}`,
    );
  const url = `data:text/javascript;base64,${Buffer.from(mutatedSource).toString("base64")}`;
  return import(url);
}

// ---------------------------------------------------------------------------
// (a) Golden comparison: a receipt with no sheets is byte-identical to the
// fixture golden captured from the UNMODIFIED function, before this file's
// edits existed. Reproducing it here is what proves "additive" rather than
// merely "the new tests pass".
// ---------------------------------------------------------------------------

test("a receipt with no contact sheets is byte-identical to the pre-DX-106 golden", async () => {
  const golden = toLf(
    await readFile(new URL("golden-receipt.json", FIXTURE_ROOT), "utf8"),
  );
  const goldenSummary = toLf(
    await readFile(new URL("golden-summary.md", FIXTURE_ROOT), "utf8"),
  );

  const receipt = buildReceipt(buildFixtureReceiptInput());
  assert.equal(Object.hasOwn(receipt, "contactSheets"), false);
  assert.equal(`${JSON.stringify(receipt, null, 2)}\n`, golden);

  const summary = buildMarkdownSummary(receipt);
  assert.equal(summary, goldenSummary);
});

test("an empty or absent contactSheets list never adds the key", () => {
  const withUndefined = buildReceipt(buildFixtureReceiptInput());
  const withEmpty = buildReceipt({
    ...buildFixtureReceiptInput(),
    contactSheets: [],
  });
  assert.equal(Object.hasOwn(withUndefined, "contactSheets"), false);
  assert.equal(Object.hasOwn(withEmpty, "contactSheets"), false);
  assert.deepEqual(buildContactSheetTable(undefined), []);
  assert.deepEqual(buildContactSheetTable([]), []);
});

// ---------------------------------------------------------------------------
// (b) A fixture sheet banks with its md5 row present, and the section is
// appended AFTER every existing section.
// ---------------------------------------------------------------------------

test("a banked sheet's md5 appears as a table cell in a section appended last", async () => {
  const waveDirectory = waveDirectoryFor("wave-end");
  const { entries, violations } = await collectContactSheets({
    waveDirectory,
    readDir: readDirReal,
    readFile: repoRelativeReadFile,
  });

  // Only the tampered fixture should ever be a violation here; asserting the
  // valid one's sheetId keeps this from accidentally passing on an empty
  // (silently-skipped) directory.
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sheetId, "kit-wave-b");
  assert.equal(entries[0].md5, "d25dcf1dd58e7eab14f5b5a9c0212fea");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /kit-wave-b-tampered/);
  assert.match(
    violations[0],
    /d25dcf1dd58e7eab14f5b5a9c0212fea|a3c409154418151e19933d353dd46af4/,
  );

  const receipt = buildReceipt({
    ...buildFixtureReceiptInput(),
    contactSheets: entries,
  });
  assert.equal(Object.hasOwn(receipt, "contactSheets"), true);
  assert.deepEqual(receipt.contactSheets, entries);

  const summary = buildMarkdownSummary(receipt);
  const sheetsHeaderIndex = summary.indexOf("## Contact sheets");
  const stepsHeaderIndex = summary.indexOf("## Steps");
  assert.notEqual(sheetsHeaderIndex, -1);
  assert.ok(
    sheetsHeaderIndex > stepsHeaderIndex,
    "Contact sheets section must come after every existing section",
  );
  assert.match(
    summary,
    /\| kit-wave-b \|.*\| d25dcf1dd58e7eab14f5b5a9c0212fea \|/,
  );
});

// ---------------------------------------------------------------------------
// validateContactSheetEntry / buildContactSheetTable — pure, fail-closed.
// ---------------------------------------------------------------------------

test("validateContactSheetEntry fails closed on a malformed entry", () => {
  assert.deepEqual(validateContactSheetEntry(null), [
    "(unnamed sheet): entry must be an object",
  ]);
  assert.deepEqual(validateContactSheetEntry([]), [
    "(unnamed sheet): entry must be an object",
  ]);

  const violations = validateContactSheetEntry({
    schemaVersion: 2,
    kind: "something-else",
    sheetId: "",
    date: "not-a-date",
    path: "C:\\backslash\\path.html",
    md5: "not-hex",
    byteLength: -1,
    rigIds: [],
    renderers: [],
    slots: [],
    cells: { measured: -1, unmeasured: "four" },
    manifest: "",
    generatedAt: "not-a-timestamp",
  });
  assert.ok(
    violations.length >= 12,
    `expected many violations, got ${violations.length}`,
  );
});

test("validateContactSheetEntry accepts the KIT-B-OWNERSHIP.md §3.1 shape", () => {
  const entry = {
    schemaVersion: 1,
    kind: "contact-sheet-index-entry",
    sheetId: "kit-wave-b",
    date: "2026-09-19",
    path: "Tools/visual-regression/output/contact-sheets/2026-09-19/kit-wave-b/index.html",
    md5: "d25dcf1dd58e7eab14f5b5a9c0212fea",
    byteLength: 48213,
    rigIds: ["aurora-orbit-limb", "globe-default"],
    renderers: ["webgl", "webgpu"],
    slots: ["BEFORE", "AFTER"],
    cells: { measured: 4, unmeasured: 4 },
    manifest: "capture-manifest.json",
    generatedAt: "2026-09-19T01:24:10.000Z",
  };
  assert.deepEqual(validateContactSheetEntry(entry), []);
});

test("buildContactSheetTable renders one row per entry with the §3.2 header", () => {
  const table = buildContactSheetTable([
    {
      sheetId: "kit-wave-b",
      date: "2026-09-19",
      rigIds: ["globe-default"],
      cells: { measured: 4, unmeasured: 0 },
      md5: "d25dcf1dd58e7eab14f5b5a9c0212fea",
    },
  ]);
  assert.equal(table[0], "| Sheet | Date | Rigs | Cells | MD5 |");
  assert.match(table[2], /kit-wave-b/);
  assert.match(table[2], /d25dcf1dd58e7eab14f5b5a9c0212fea/);
});

// ---------------------------------------------------------------------------
// collectContactSheets: recompute, never trust; missing directory is empty,
// not an error.
// ---------------------------------------------------------------------------

test("collectContactSheets returns empty when the contact-sheets directory does not exist", async () => {
  const result = await collectContactSheets({
    waveDirectory: fixturePath("no-such-wave-directory"),
    readDir: readDirReal,
    readFile: repoRelativeReadFile,
  });
  assert.deepEqual(result, { entries: [], violations: [] });
});

test("collectContactSheets drops a tampered entry and names both md5 values", async () => {
  const { entries, violations } = await collectContactSheets({
    waveDirectory: waveDirectoryFor("wave-end"),
    readDir: readDirReal,
    readFile: repoRelativeReadFile,
  });
  assert.equal(
    entries.some((entry) => entry.sheetId === "kit-wave-b-tampered"),
    false,
  );
  const tamperedViolation = violations.find((line) =>
    line.startsWith("kit-wave-b-tampered:"),
  );
  assert.ok(
    tamperedViolation,
    "expected a violation naming the tampered sheet",
  );
  assert.match(
    tamperedViolation,
    /recomputed md5 a3c409154418151e19933d353dd46af4/,
  );
  assert.match(tamperedViolation, /banked entry's md5 0{32}/);
});

// ---------------------------------------------------------------------------
// Mutation-fold group: each mutant makes a checked-in guarantee unreachable
// and this proves the checked-in behaviour goes with it, i.e. the guarantee
// is load-bearing rather than incidental.
// ---------------------------------------------------------------------------

test("MUTATION: removing the contact-sheet section append drops the md5 from the summary", async () => {
  const mutated = await importMutatedReceiptModule(
    "if (contactSheetTable.length > 0) {",
    "if (false && contactSheetTable.length > 0) {",
    "contact-sheet section append",
  );

  const { entries } = await mutated.collectContactSheets({
    waveDirectory: waveDirectoryFor("wave-end"),
    readDir: readDirReal,
    readFile: repoRelativeReadFile,
  });
  const receipt = mutated.buildReceipt({
    ...buildFixtureReceiptInput(),
    contactSheets: entries,
  });
  // The mutated buildReceipt still carries the key (that half is untouched);
  // it is the SUMMARY rendering this mutant disables.
  assert.equal(Object.hasOwn(receipt, "contactSheets"), true);
  const mutatedSummary = mutated.buildMarkdownSummary(receipt);
  assert.equal(mutatedSummary.includes("## Contact sheets"), false);
  assert.equal(
    mutatedSummary.includes("d25dcf1dd58e7eab14f5b5a9c0212fea"),
    false,
  );

  // The real module, same input, still writes it — proving the difference is
  // the mutation and not the fixture.
  const liveSummary = buildMarkdownSummary(
    buildReceipt({ ...buildFixtureReceiptInput(), contactSheets: entries }),
  );
  assert.match(liveSummary, /## Contact sheets/);
  assert.match(liveSummary, /d25dcf1dd58e7eab14f5b5a9c0212fea/);
});

test("MUTATION: trusting the entry's md5 instead of recomputing lets a tampered sheet through", async () => {
  const mutated = await importMutatedReceiptModule(
    "const recomputedMd5 = md5(Buffer.from(pageBytes));",
    "const recomputedMd5 = entry.md5;",
    "md5 recompute-not-trust",
  );

  const { entries, violations } = await mutated.collectContactSheets({
    waveDirectory: waveDirectoryFor("wave-end"),
    readDir: readDirReal,
    readFile: repoRelativeReadFile,
  });

  // With the check neutered, the tampered entry is wrongly accepted and no
  // violation names it — this is the exact failure the real code prevents.
  assert.equal(
    entries.some((entry) => entry.sheetId === "kit-wave-b-tampered"),
    true,
  );
  assert.equal(
    violations.some((line) => line.startsWith("kit-wave-b-tampered:")),
    false,
  );

  // The real module, same fixture, still catches it.
  const live = await collectContactSheets({
    waveDirectory: waveDirectoryFor("wave-end"),
    readDir: readDirReal,
    readFile: repoRelativeReadFile,
  });
  assert.equal(
    live.entries.some((entry) => entry.sheetId === "kit-wave-b-tampered"),
    false,
  );
  assert.equal(
    live.violations.some((line) => line.startsWith("kit-wave-b-tampered:")),
    true,
  );
});

// ---------------------------------------------------------------------------
// (c) What a banked entry may NAME and may CARRY. The entry is a file on disk
// that anyone can edit, `collectContactSheets` reads its `path` to recompute
// the md5, and `buildReceipt` publishes what it is handed. A shape check that
// rejects only a backslash leaves both open: the collector reads any file on
// the machine, and a `verdict` key rides into the artefact this whole row
// exists to keep verdicts out of.
// ---------------------------------------------------------------------------

const VALID_ENTRY = Object.freeze({
  schemaVersion: 1,
  kind: "contact-sheet-index-entry",
  sheetId: "kit-wave-b",
  date: "2026-09-19",
  path: "Tools/visual-regression/fixtures/wave-end-contact-sheet/pages/kit-wave-b/index.html",
  md5: "d25dcf1dd58e7eab14f5b5a9c0212fea",
  byteLength: 248,
  rigIds: ["globe-default"],
  renderers: ["webgl", "webgpu"],
  slots: ["BEFORE", "AFTER"],
  cells: { measured: 4, unmeasured: 0 },
  manifest: "capture-manifest.json",
  generatedAt: "2026-09-19T01:24:10.000Z",
});

test("validateContactSheetEntry refuses a path that leaves the repository", () => {
  const cases = [
    ["an absolute POSIX path", "/etc/passwd"],
    ["a Windows drive letter", "C:/Users/Kurt/.ssh/id_rsa"],
    ["a traversing path", "../../../../etc/passwd"],
    ["a traversing path with a real prefix", "Tools/../../secrets/private.key"],
  ];
  for (const [name, badPath] of cases) {
    const violations = validateContactSheetEntry({
      ...VALID_ENTRY,
      path: badPath,
    });
    assert.equal(
      violations.length,
      1,
      `${name} should produce exactly one violation, got ${JSON.stringify(violations)}`,
    );
    assert.match(violations[0], /path must be/);
  }
});

test("collectContactSheets banks nothing for an entry whose path points outside the wave", async () => {
  const outsidePath =
    "Tools/visual-regression/fixtures/wave-end-contact-sheet/../pages/kit-wave-b/index.html";
  const reads = [];
  const { entries, violations } = await collectContactSheets({
    waveDirectory: "/fake/wave",
    readDir: async () => ["escaping-sheet"],
    readFile: async (candidate) => {
      reads.push(candidate);
      if (String(candidate).endsWith("sheet-index.json")) {
        return Buffer.from(
          JSON.stringify({ ...VALID_ENTRY, path: outsidePath }),
          "utf8",
        );
      }
      throw new Error(`the collector must not read ${candidate}`);
    },
  });

  assert.deepEqual(entries, []);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /path must be/);
  assert.deepEqual(
    reads.filter(
      (candidate) => !String(candidate).endsWith("sheet-index.json"),
    ),
    [],
    "the refused path was never opened",
  );
});

test("an unknown key on an entry is a violation, and is projected away if one reaches buildReceipt", () => {
  const smuggled = {
    ...VALID_ENTRY,
    verdict: "PASS",
    gate: { threshold: 5, why: "this must never reach the receipt" },
  };

  const violations = validateContactSheetEntry(smuggled);
  // TWO independent refusals, not one: the key is unrecognised AND the word
  // it spells is verdict vocabulary. The second is what still fires when the
  // same word arrives through a KNOWN field instead (see the §3.2 tests
  // below, where `verdict`/`gate` are not present but `sheetId`/`rigIds`/
  // `renderers`/`slots` carry the same vocabulary through fields that ARE
  // recognised).
  assert.equal(violations.length, 2);
  assert.ok(violations.some((v) => /unknown key\(s\) verdict, gate/.test(v)));
  assert.ok(violations.some((v) => /"PASS" is verdict vocabulary/.test(v)));

  // Defence in depth: buildReceipt takes entries from whoever calls it, so it
  // projects rather than spreads.
  const receipt = buildReceipt({
    ...buildFixtureReceiptInput(),
    contactSheets: [smuggled],
  });
  assert.deepEqual(Object.keys(receipt.contactSheets[0]), [
    "schemaVersion",
    "kind",
    "sheetId",
    "date",
    "path",
    "md5",
    "byteLength",
    "rigIds",
    "renderers",
    "slots",
    "cells",
    "manifest",
    "generatedAt",
  ]);
  assert.equal(Object.hasOwn(receipt.contactSheets[0], "verdict"), false);
  assert.equal(Object.hasOwn(receipt.contactSheets[0], "gate"), false);
  assert.equal(JSON.stringify(receipt).includes('"gate"'), false);

  // And the projection is a copy: mutating the source cannot reach the bank.
  smuggled.rigIds.push("injected-after-the-fact");
  assert.deepEqual(receipt.contactSheets[0].rigIds, ["globe-default"]);
});

test("a receipt WITH sheets is the thirteen existing keys plus contactSheets, last", () => {
  const receipt = buildReceipt({
    ...buildFixtureReceiptInput(),
    contactSheets: [VALID_ENTRY],
  });
  const keys = Object.keys(receipt);
  assert.equal(keys.length, 14);
  assert.equal(keys[keys.length - 1], "contactSheets");
  assert.deepEqual(keys.slice(0, 13), [
    "schemaVersion",
    "wave",
    "startedAt",
    "finishedAt",
    "source",
    "servedSubject",
    "preflight",
    "plan",
    "steps",
    "baselineUpdate",
    "problem",
    "verdict",
    "exitCode",
  ]);
});

test("collectContactSheets resolves an entry's repo-relative path against repositoryRoot, not the working directory", async () => {
  const opened = [];
  const { entries, violations } = await collectContactSheets({
    waveDirectory: "/fake/wave",
    repositoryRoot: "/fake/repo",
    readDir: async () => ["kit-wave-b"],
    readFile: async (candidate) => {
      opened.push(String(candidate));
      if (String(candidate).endsWith("sheet-index.json")) {
        return Buffer.from(JSON.stringify(VALID_ENTRY), "utf8");
      }
      return Buffer.from("page bytes", "utf8");
    },
    md5: () => VALID_ENTRY.md5,
  });

  assert.deepEqual(violations, []);
  assert.equal(entries.length, 1);
  const pageRead = opened.find(
    (candidate) => !candidate.endsWith("sheet-index.json"),
  );
  assert.equal(
    pageRead,
    path.join("/fake/repo", VALID_ENTRY.path),
    "the page was read under the declared repository root",
  );
});

test("MUTATION: dropping the entry-path relativity clause lets the collector read outside the wave", async () => {
  // The hand-rolled relativity clause this mutation originally targeted
  // (`!entry.path.split("/").includes("..")`) was replaced by the shared
  // `relativePosixPathViolation` predicate from `lib/relative-path.mjs` (KIT-B
  // v2, fixing Mosco's §3.4/§3.5 finding that two hand-rolled readers could
  // disagree). The guarantee this mutant proves — that dropping the path
  // check lets a traversing path validate clean — is unchanged; only the
  // exact source line naming it moved, so the mutation target moves with it.
  const mutated = await importMutatedReceiptModule(
    "  const pathViolation = relativePosixPathViolation(entry.path);",
    "  const pathViolation = null;",
    "entry path relativity",
  );
  const violations = mutated.validateContactSheetEntry({
    ...VALID_ENTRY,
    path: "Tools/../../secrets/private.key",
  });
  assert.deepEqual(
    violations,
    [],
    "with the clause inert the traversing path validates clean — which is the defect",
  );
  assert.equal(
    validateContactSheetEntry({
      ...VALID_ENTRY,
      path: "Tools/../../secrets/private.key",
    }).length,
    1,
    "and the shipped function still refuses it",
  );
});

test("MUTATION: spreading an entry instead of projecting it carries a verdict into the receipt", async () => {
  const mutated = await importMutatedReceiptModule(
    "      ? { contactSheets: contactSheets.map(projectContactSheetEntry) }",
    "      ? { contactSheets: contactSheets.map((entry) => ({ ...entry })) }",
    "entry projection",
  );
  const smuggled = { ...VALID_ENTRY, verdict: "PASS" };
  const mutatedReceipt = mutated.buildReceipt({
    ...buildFixtureReceiptInput(),
    contactSheets: [smuggled],
  });
  assert.equal(
    mutatedReceipt.contactSheets[0].verdict,
    "PASS",
    "with the projection inert the verdict lands in the banked receipt",
  );
  const shipped = buildReceipt({
    ...buildFixtureReceiptInput(),
    contactSheets: [smuggled],
  });
  assert.equal(Object.hasOwn(shipped.contactSheets[0], "verdict"), false);
});

// ---------------------------------------------------------------------------
// KIT-B v2 review (Mosco, VERIFY_MOSCO_V2.md §3.2): validateContactSheetEntry
// checked every field for SHAPE only, so verdict vocabulary arriving through
// a KNOWN field (`sheetId`, `rigIds`, `renderers`, `slots`) validated clean,
// was projected verbatim, and reached both receipt.json and the markdown
// summary row. The fixes below make `renderers`/`slots` closed vocabularies,
// `rigIds` a kebab grammar, `path`/`manifest` the shared relative-path
// predicate, and add `scanEntryForVerdicts` as a backstop over everything
// else. These cases assert the OBSERVABLE violations, the banked receipt's
// bytes, and the markdown row — never the implementation shape.
// ---------------------------------------------------------------------------

test("Mosco §3.2: a data-only attack entry through KNOWN fields is refused field-by-field and never reaches the receipt or the summary", async () => {
  const attackEntry = {
    ...VALID_ENTRY,
    sheetId: "FAILED-globe-default",
    rigIds: ["globe-default — REGRESSION vs baseline"],
    renderers: [{ verdict: "PASS", gate: { result: "FAIL", threshold: 5 } }],
    slots: [{ note: "❌ AFTER is worse" }],
  };

  const violations = validateContactSheetEntry(attackEntry);
  const named = (pattern) => violations.some((line) => pattern.test(line));
  assert.equal(
    violations.length,
    8,
    `expected 8 named violations, got ${JSON.stringify(violations, null, 2)}`,
  );
  assert.ok(
    named(/rigIds must be an array of ids matching/),
    "rigIds grammar violation named",
  );
  assert.ok(
    named(/renderers must be a duplicate-free non-empty subset/),
    "renderers closed-vocabulary violation named",
  );
  assert.ok(
    named(/slots must be a duplicate-free non-empty subset/),
    "slots closed-vocabulary violation named",
  );
  assert.ok(
    named(/sheetId: "FAILED" is verdict vocabulary/),
    "sheetId verdict-scan hit named",
  );
  assert.ok(
    named(/rigIds\[0\]: "REGRESSION" is verdict vocabulary/),
    "rigIds[0] verdict-scan hit named",
  );
  assert.ok(
    named(/renderers\[0\]\.verdict: "PASS" is verdict vocabulary/),
    "renderers[0].verdict verdict-scan hit named",
  );
  assert.ok(
    named(/renderers\[0\]\.gate\.result: "FAIL" is verdict vocabulary/),
    "renderers[0].gate.result verdict-scan hit named",
  );
  assert.ok(
    named(/slots\[0\]\.note: "❌" is verdict vocabulary/),
    "slots[0].note verdict-scan hit named",
  );

  // Drive the projection too: the real production path is
  // `collectContactSheets`, which validates BEFORE banking, so the attack
  // entry never reaches `entries` regardless of whether whoever calls
  // `buildReceipt`/`buildMarkdownSummary` next rechecks `violations` first.
  const { entries, violations: collected } = await collectContactSheets({
    waveDirectory: "/fake/wave",
    readDir: async () => ["attack-sheet"],
    readFile: async (candidate) => {
      if (String(candidate).endsWith("sheet-index.json")) {
        return Buffer.from(JSON.stringify(attackEntry), "utf8");
      }
      throw new Error(`the collector must not read ${candidate}`);
    },
  });
  assert.deepEqual(entries, []);
  assert.ok(
    collected.some((line) => /is verdict vocabulary/.test(line)),
    "collectContactSheets surfaces the same verdict-vocabulary violations",
  );

  const receipt = buildReceipt({
    ...buildFixtureReceiptInput(),
    contactSheets: entries,
  });
  // No sheets were banked, so the additive `contactSheets` key is absent
  // entirely (the same rule the golden-comparison test proves) — the
  // strongest possible proof that none of the attack entry's vocabulary
  // rides along, since there is nothing contact-sheet-shaped in the receipt
  // to carry it.
  assert.equal(Object.hasOwn(receipt, "contactSheets"), false);
  const summary = buildMarkdownSummary(receipt);
  assert.equal(summary.includes("## Contact sheets"), false);
  assert.deepEqual(buildContactSheetTable(entries), []);
});

test("validateContactSheetEntry refuses a renderer/slot id outside the closed vocabulary, and a duplicate of either", () => {
  const cases = [
    [
      "renderers",
      ["webgl2"],
      /renderers must be a duplicate-free non-empty subset/,
    ],
    [
      "renderers",
      ["webgl", "webgl"],
      /renderers must be a duplicate-free non-empty subset/,
    ],
    ["slots", ["DURING"], /slots must be a duplicate-free non-empty subset/],
    [
      "slots",
      ["BEFORE", "BEFORE"],
      /slots must be a duplicate-free non-empty subset/,
    ],
  ];
  for (const [field, badValue, expected] of cases) {
    const violations = validateContactSheetEntry({
      ...VALID_ENTRY,
      [field]: badValue,
    });
    assert.equal(
      violations.length,
      1,
      `${field}=${JSON.stringify(badValue)} should produce exactly one violation, got ${JSON.stringify(violations)}`,
    );
    assert.match(violations[0], expected);
  }
  // The messages name the actual closed vocabulary, not just "invalid".
  assert.match(
    validateContactSheetEntry({ ...VALID_ENTRY, renderers: ["webgl2"] })[0],
    new RegExp(RENDERER_IDS.join(", ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(
    validateContactSheetEntry({ ...VALID_ENTRY, slots: ["DURING"] })[0],
    new RegExp(SLOT_IDS.join(", ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("validateContactSheetEntry refuses a rigId that is not kebab-case, and the 39 real registry ids all pass", async () => {
  for (const badRigId of [
    "globe-default — REGRESSION vs baseline",
    "Globe_Default",
    "-leading",
  ]) {
    const violations = validateContactSheetEntry({
      ...VALID_ENTRY,
      rigIds: [badRigId],
    });
    assert.ok(
      violations.some((v) => /rigIds must be an array of ids matching/.test(v)),
      `expected a grammar violation for rigId ${JSON.stringify(badRigId)}, got ${JSON.stringify(violations)}`,
    );
  }

  // The data-pinning half: the grammar is tied to the registry's actual
  // contents, not to an opinion about what "kebab-case" means. A future rig
  // id that diverged from this shape would turn this assertion red.
  const rigs = await loadRigs();
  assert.equal(rigs.length, 39, "expected the measured registry size");
  const nonConforming = rigs
    .map((rig) => rig.id)
    .filter((id) => !RIG_ID_PATTERN.test(id));
  assert.deepEqual(
    nonConforming,
    [],
    `every registry rig id must match ${RIG_ID_PATTERN}`,
  );
});

test("validateContactSheetEntry refuses an escaping entry.path via the shared relative-path predicate, each naming the reason", () => {
  const cases = [
    [
      "a percent-escaped `..`",
      "images/%2e%2e/%2e%2e/secret.html",
      /decodes to `\.`/,
    ],
    ["a Windows drive letter", "C:/ESCAPED/x.html", /scheme:` or drive prefix/],
    ["a url scheme", "https://evil.example/x.html", /scheme:` or drive prefix/],
    ["a backslash", "images\\x.html", /must not contain a backslash/],
  ];
  for (const [name, badPath, expectedReason] of cases) {
    const violations = validateContactSheetEntry({
      ...VALID_ENTRY,
      path: badPath,
    });
    assert.equal(
      violations.length,
      1,
      `${name} should produce exactly one violation, got ${JSON.stringify(violations)}`,
    );
    assert.match(violations[0], /path must be a relative POSIX path/);
    assert.match(
      violations[0],
      expectedReason,
      `${name} should name the predicate's own reason`,
    );
  }
});

test("a valid entry produced by the REAL sheetIndexEntry still validates clean — the control", () => {
  // A hand-built `sheetModel`-shaped object (sheetIndexEntry's own input
  // contract), not a hand-built entry — this is the control that proves none
  // of the tightening above is over-tight: if this test goes red, the row is
  // dead.
  const model = {
    sheetId: "kit-wave-b-control",
    date: "2026-09-19",
    generatedAt: "2026-09-19T01:24:10.000Z",
    captureRoot: "ignored-by-sheetIndexEntry",
    receipt: "ignored-by-sheetIndexEntry",
    renderers: ["webgl", "webgpu"],
    slots: ["BEFORE", "AFTER"],
    rigs: [{ id: "globe-default" }, { id: "aurora-orbit-limb" }],
    counts: { measured: 4, unmeasured: 0 },
    imageCopies: [],
  };
  const entry = sheetIndexEntry(model, {
    html: "<!doctype html><title>control</title>",
    path: "Tools/visual-regression/output/contact-sheets/2026-09-19/kit-wave-b-control/index.html",
    md5: "0".repeat(32),
  });
  assert.deepEqual(validateContactSheetEntry(entry), []);
});

// ---------------------------------------------------------------------------
// (e) Nothing may reformat the fixtures this file reads. Every one of them is
// compared byte-for-byte or hashed above, and the pre-commit hook runs
// `prettier --write` over every staged .md/.html/.mjs (lint-staged.config.js),
// which runs AFTER the gates a lane reports. That is how golden-summary.md
// arrived with padded markdown tables the producer never writes, and how both
// fixture pages arrived with reflowed HTML whose md5 no longer matched the
// banked sheet-index.json.
//
// The question is put to prettier itself rather than to the ignore file's
// text: a regex over .prettierignore would only prove a line exists, not that
// prettier resolves it to these paths — and prettier is what the hook runs.
// ---------------------------------------------------------------------------

const PRETTIER_IGNORE_PATH = path.join(REPO_ROOT_PATH, ".prettierignore");
const FIXTURE_IGNORE_ENTRY =
  "Tools/visual-regression/fixtures/wave-end-contact-sheet/";

// The four fixtures whose extensions .prettierignore un-ignores under Tools/,
// i.e. the ones that entry is what protects. The JSON pair and .gitattributes
// are already out of prettier's reach because the ignore file's leading `*`
// is never undone for those extensions.
const PRETTIER_REACHABLE_FIXTURES = [
  "fixture-receipt-input.mjs",
  "golden-summary.md",
  "pages/kit-wave-b-tampered/index.html",
  "pages/kit-wave-b/index.html",
];

async function listFixtureFilesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listFixtureFilesUnder(full)));
    } else {
      found.push(full);
    }
  }
  return found.sort();
}

function repoRelativePosix(absolutePath) {
  return path.relative(REPO_ROOT_PATH, absolutePath).split(path.sep).join("/");
}

test("every byte-pinned fixture in this directory is ignored by prettier", async () => {
  const files = await listFixtureFilesUnder(fileURLToPath(FIXTURE_ROOT));
  assert.ok(
    files.length >= 8,
    `expected the whole fixture set, walked ${files.length} file(s)`,
  );
  for (const file of files) {
    // lint-staged hands its tools ABSOLUTE paths, so that is the shape asked
    // about here.
    const info = await getFileInfo(file, { ignorePath: PRETTIER_IGNORE_PATH });
    assert.equal(
      info.ignored,
      true,
      `${repoRelativePosix(file)} is not ignored by prettier: the pre-commit hook would rewrite it, and every byte comparison above would then be measuring the formatter's output`,
    );
  }
});

test("MUTATION: dropping the ignore entry puts the goldens back within prettier's reach", async () => {
  const ignoreSource = await readFile(PRETTIER_IGNORE_PATH, "utf8");
  assert.equal(
    ignoreSource.split(FIXTURE_IGNORE_ENTRY).length - 1,
    1,
    "the fixture directory must be named exactly once in .prettierignore",
  );

  // prettier resolves an ignore file's patterns against that file's own
  // directory, so the mutant needs a root of its own. The paths below never
  // have to exist — getFileInfo answers from the name and the ignore file.
  const mutantRoot = await mkdtemp(
    path.join(os.tmpdir(), "wave-end-contact-sheet-ignore-"),
  );
  try {
    const ignorePath = path.join(mutantRoot, ".prettierignore");
    const relativeFixtures = (
      await listFixtureFilesUnder(fileURLToPath(FIXTURE_ROOT))
    ).map(repoRelativePosix);

    // Positive control: the real ignore file, read from a different root,
    // still covers every fixture — so a miss below is the mutation and not
    // the relocation.
    await writeFile(ignorePath, ignoreSource);
    for (const relative of relativeFixtures) {
      const info = await getFileInfo(path.join(mutantRoot, relative), {
        ignorePath,
      });
      assert.equal(info.ignored, true, `control: ${relative}`);
    }

    await writeFile(
      ignorePath,
      ignoreSource.split(FIXTURE_IGNORE_ENTRY).join("nothing-of-the-kind/"),
    );
    const reachable = [];
    for (const relative of relativeFixtures) {
      const info = await getFileInfo(path.join(mutantRoot, relative), {
        ignorePath,
      });
      if (!info.ignored) {
        reachable.push(relative.slice(FIXTURE_IGNORE_ENTRY.length));
      }
    }
    assert.deepEqual(
      reachable.sort(),
      PRETTIER_REACHABLE_FIXTURES,
      "removing the entry must hand exactly the formatter-readable fixtures back to prettier",
    );
  } finally {
    await rm(mutantRoot, { recursive: true, force: true });
  }
});
