// package-manifest-duplicate-keys.spec.mjs — the manifests this repository
// ships carry no key twice, and the reader that proves it reads JSON as text.
//
// @purpose Refuses a duplicate key in the root or any workspace package.json, and pins the text-reading tokenizer that finds one where JSON.parse cannot.
// @status ACTIVE

//
// Run: node --test Tools/package-manifest-duplicate-keys.spec.mjs
// Homed in `test-build-infra`, which the workflow's `guards` job runs.
//
// WHAT WENT WRONG, AND WHY NOTHING SAW IT. Two lanes in one wave each ADDED a
// `test-s5` key to `scripts`, on different lines. Neither patch removed the
// other's line, so the three-way apply had no textual conflict to report and
// took both additions. `JSON.parse` then kept the LAST one and said nothing,
// which is what the specification tells it to do. From that moment every reader
// in the toolchain — npm, the spec-runner census, the family gate itself —
// agreed that `test-s5` named one spec, and the nine it used to name ran
// nowhere. The spec whose whole job is to catch an unhomed S5 gate was RED in
// the tree and nobody saw it, because the runner it lives in was the shadowed
// key.
//
// So the class is not "a wrong value in a manifest". It is "two correct edits
// compose into a silent loss", and no gate built on a PARSED manifest can see
// it: by the time a gate holds an object, the evidence is gone. The guard has
// to read the bytes.
//
// WHAT THIS SUITE ASSERTS. First the product: the real root manifest and every
// real workspace manifest, as they sit on disk, repeat no key at any depth.
// Then the reader, over the cases that separate a tokenizer from a line regex —
// a key spelled inside a string VALUE, an escaped quote, a unicode-escaped
// spelling of the same key, braces inside a value, the same key in two sibling
// objects (correct JSON, not a finding), array elements, CRLF, a BOM, and an
// unterminated string, which must end the scan rather than spin on it. Every
// case reads the tokenizer's OUTPUT; none greps its source.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findDuplicateKeys } from "./lib/json-duplicate-keys.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");

/**
 * Every package manifest the repository tracks: the root one, and one per
 * workspace directory that has one. Discovered rather than listed, so a new
 * workspace is covered the day it lands instead of the day someone remembers.
 *
 * @returns {string[]} Repository-relative POSIX paths.
 */
function manifestPaths() {
  const found = ["package.json"];
  const packagesDirectory = path.join(repositoryRoot, "packages");
  for (const entry of fs.readdirSync(packagesDirectory).sort()) {
    const relative = `packages/${entry}/package.json`;
    if (fs.existsSync(path.join(repositoryRoot, relative))) {
      found.push(relative);
    }
  }
  return found;
}

/**
 * Renders findings the way a failure message should read: one line each, naming
 * the key, both line numbers, and which of the two `JSON.parse` discards.
 *
 * @param {string} file Repository-relative manifest path.
 * @param {{key: string, firstLine: number, line: number, path: string}[]} duplicates Findings for that file.
 * @returns {string} One line per finding.
 */
function describe(file, duplicates) {
  return duplicates
    .map(
      (duplicate) =>
        `${file}: "${duplicate.path}" is set on line ${duplicate.firstLine} and set again on line ${duplicate.line}; JSON.parse keeps line ${duplicate.line} and discards line ${duplicate.firstLine}`,
    )
    .join("\n");
}

test("no manifest this repository ships repeats a key at any depth", () => {
  const manifests = manifestPaths();
  assert.ok(
    manifests.length >= 4,
    `expected the root manifest and the workspace manifests, found ${manifests.length}`,
  );

  const findings = [];
  for (const file of manifests) {
    const text = fs.readFileSync(path.join(repositoryRoot, file), "utf8");
    // The tokenizer answers a question `JSON.parse` cannot, so it must at least
    // agree with it about what the document is.
    assert.doesNotThrow(() => JSON.parse(text), `${file} is not valid JSON`);

    const duplicates = findDuplicateKeys(text);
    if (duplicates.length > 0) {
      findings.push(describe(file, duplicates));
    }
  }

  assert.deepEqual(findings, []);
});

test("a repeated script key is reported with the shadowed line and the winning line", () => {
  // The shape that shipped: two `test-s5` keys with another key between them,
  // which is what a clean three-way merge of two independent ADDs produces.
  const manifest = [
    "{",
    '  "scripts": {',
    '    "test-s5": "node --test nine-specs.mjs",',
    '    "test-s5-quarantine": "node --test two-slow-specs.mjs",',
    '    "test-s5": "node --test one-spec.mjs"',
    "  }",
    "}",
  ].join("\n");

  // The hazard itself, through the real parser: the first key is simply gone.
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.scripts["test-s5"], "node --test one-spec.mjs");
  assert.equal(Object.keys(parsed.scripts).length, 2);

  assert.deepEqual(findDuplicateKeys(manifest), [
    { key: "test-s5", firstLine: 3, line: 5, path: "scripts.test-s5" },
  ]);
});

test("the real manifest with a second runner key seeded into it is reported", () => {
  // The fixtures around this one are small and quote-poor. This case is the
  // product itself, whose script values are full of quotes, colons, commas and
  // braces — the document a line regex cannot read.
  const file = path.join(repositoryRoot, "package.json");
  const lines = fs.readFileSync(file, "utf8").split("\n");

  const firstIndex = lines.findIndex((line) => /^\s*"test-s5":/u.test(line));
  const quarantineIndex = lines.findIndex((line) =>
    /^\s*"test-s5-quarantine":/u.test(line),
  );
  assert.ok(firstIndex >= 0, "the manifest no longer has a test-s5 runner");
  assert.ok(quarantineIndex > firstIndex, "the quarantine runner moved");

  const carriageReturn = lines[quarantineIndex].endsWith("\r") ? "\r" : "";
  const seeded = [...lines];
  seeded.splice(
    quarantineIndex + 1,
    0,
    `    "test-s5": "node --test Tools/visual-regression/c12-31-aureole-gate.spec.mjs",${carriageReturn}`,
  );
  const seededText = seeded.join("\n");

  // Still valid JSON, and the seeded line is the one that survives parsing —
  // which is exactly why the text has to be read.
  assert.equal(
    JSON.parse(seededText).scripts["test-s5"],
    "node --test Tools/visual-regression/c12-31-aureole-gate.spec.mjs",
  );

  assert.deepEqual(findDuplicateKeys(seededText), [
    {
      key: "test-s5",
      firstLine: firstIndex + 1,
      line: quarantineIndex + 2,
      path: "scripts.test-s5",
    },
  ]);
});

test("the same key in two sibling objects is correct JSON, not a finding", () => {
  const document = [
    "{",
    '  "engine": { "name": "cesium-engine", "private": false },',
    '  "widgets": { "name": "cesium-widgets", "private": false }',
    "}",
  ].join("\n");

  assert.deepEqual(findDuplicateKeys(document), []);
});

test("a key spelled inside a string value is not a key", () => {
  const document = [
    "{",
    '  "test-s5": "node --test a.spec.mjs",',
    '  "note": "the manifest once read \\"test-s5\\": twice, on two lines",',
    '  "help": "pass { \\"test-s5\\": 1 } to the tool",',
    '  "tail": 1',
    "}",
  ].join("\n");

  assert.deepEqual(findDuplicateKeys(document), []);

  // Those braces must not have opened a container either: a real repeat after
  // them is still reported at the ROOT path, not inside a phantom child.
  const withRepeat = document.replace(
    '  "tail": 1',
    '  "tail": 1,\n  "tail": 2',
  );
  assert.deepEqual(findDuplicateKeys(withRepeat), [
    { key: "tail", firstLine: 5, line: 6, path: "tail" },
  ]);
});

test("an escaped quote inside a key does not split the key in two", () => {
  const twoOfOneKey = ["{", '  "a\\"b": 1,', '  "a\\"b": 2', "}"].join("\n");
  assert.equal(Object.keys(JSON.parse(twoOfOneKey)).length, 1);
  assert.deepEqual(findDuplicateKeys(twoOfOneKey), [
    { key: 'a"b', firstLine: 2, line: 3, path: 'a"b' },
  ]);

  const twoDifferentKeys = ["{", '  "a\\"b": 1,', '  "ab": 2', "}"].join("\n");
  assert.deepEqual(findDuplicateKeys(twoDifferentKeys), []);
});

test("a unicode-escaped spelling of a key collides with its plain spelling", () => {
  // `JSON.parse` decodes before it compares, so these two lines are one key and
  // the first value is lost. A comparison over raw spellings would miss it.
  const document = ["{", '  "test-s5": 1,', '  "\\u0074est-s5": 2', "}"].join(
    "\n",
  );

  assert.equal(Object.keys(JSON.parse(document)).length, 1);
  assert.deepEqual(findDuplicateKeys(document), [
    { key: "test-s5", firstLine: 2, line: 3, path: "test-s5" },
  ]);
});

test("array elements are tracked one object at a time", () => {
  const document = [
    "{",
    '  "workspaces": [',
    '    { "name": "engine" },',
    '    { "name": "widgets", "name": "widgets-again" }',
    "  ]",
    "}",
  ].join("\n");

  assert.deepEqual(findDuplicateKeys(document), [
    { key: "name", firstLine: 4, line: 4, path: "workspaces[1].name" },
  ]);
});

test("CRLF input reports the line numbers the editor shows", () => {
  const document = ["{", '  "a": 1,', '  "b": 2,', '  "a": 3', "}"].join(
    "\r\n",
  );

  assert.deepEqual(findDuplicateKeys(document), [
    { key: "a", firstLine: 2, line: 4, path: "a" },
  ]);
});

test("a leading BOM is consumed without shifting the first line", () => {
  const document = `\u{FEFF}${["{", '  "a": 1,', '  "a": 2', "}"].join("\n")}`;

  assert.deepEqual(findDuplicateKeys(document), [
    { key: "a", firstLine: 2, line: 3, path: "a" },
  ]);
});

test("an unterminated string ends the scan instead of spinning on it", () => {
  // A truncated write is how a manifest most often becomes unreadable. The scan
  // must return what it saw before the truncation, and must return promptly.
  const truncated = `{\n  "a": 1,\n  "a": 2,\n  "b": "${"x".repeat(200000)}`;

  const startedAt = Date.now();
  const duplicates = findDuplicateKeys(truncated);
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(duplicates, [
    { key: "a", firstLine: 2, line: 3, path: "a" },
  ]);
  assert.ok(
    elapsed < 5000,
    `the scan took ${elapsed}ms on a truncated document`,
  );
  assert.throws(() => JSON.parse(truncated));
});

test("an already-parsed value is a caller error, not a silent empty answer", () => {
  assert.throws(() => findDuplicateKeys({ scripts: {} }), TypeError);
  assert.throws(() => findDuplicateKeys(undefined), TypeError);
});

test("every repeat is reported, not just the first one found", () => {
  // `describe()` maps over the WHOLE return value, so a reader that stopped at
  // the first repeat would still red the gate and still hide the second key —
  // which is the shape a fix round is meant to clear in one pass, not two.
  const document = [
    "{",
    '  "scripts": {',
    '    "test-s5": 1,',
    '    "test-s5": 2,',
    '    "test-c16": 3,',
    '    "test-c16": 4',
    "  },",
    '  "name": "a",',
    '  "name": "b"',
    "}",
  ].join("\n");

  assert.deepEqual(findDuplicateKeys(document), [
    { key: "test-s5", firstLine: 3, line: 4, path: "scripts.test-s5" },
    { key: "test-c16", firstLine: 5, line: 6, path: "scripts.test-c16" },
    { key: "name", firstLine: 8, line: 9, path: "name" },
  ]);
});
