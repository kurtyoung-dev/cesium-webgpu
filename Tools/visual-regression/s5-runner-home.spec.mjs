// @purpose Pins the C12-29 S5 gate specs to their ratified runner home: every s5 spec is reachable from `test-s5`, only the two slow ones shelter in `test-s5-quarantine`, and no runner names a file that is not there.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/s5-runner-home.spec.mjs
//
// `R-2026-09-02-16` ratified `test-s5` as one of seven family names and left
// it unbuilt: at Batch 1515 all ten `c12-29-s5-*.spec.mjs` were orphans, so a
// landing that touched them ran no gate at all (`R-2026-09-13-2`(D) runs the
// runners a batch's files are homed in — an orphan has none). This suite is
// the standing check that they stay homed.
//
// It reads the WORKING TREE: `package.json` as it is on disk and the spec
// files as they are on disk. No `git` call, no HEAD content, no network, no
// build — a spec that shells out to git asserts the index, not the product.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isQuarantineRunner, runCensus } from "../spec-runner-census.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../..");
const VISUAL_REGRESSION = "Tools/visual-regression";

const FAMILY_RUNNER = "test-s5";
const QUARANTINE_RUNNER = "test-s5-quarantine";

// The two S5 gate specs whose Node cost is out of scale with a landing gate.
// Both are GREEN and both terminate — measured here, one at a time, on an
// unbuilt clone: `svs-footprint` 57/57 in 1,500.7 s and `dense-cost` 40/40 in
// 910.3 s, forty minutes between them against ninety-six seconds for the rest
// of the family. Quarantine is therefore a COST decision and is revisitable on
// a number, not a refusal to run them. They keep a home so they are never
// silently orphaned, and a quarantine home so `spec-runner-census` counts them
// as sheltered rather than homed: quarantine is a subset of homed, not a
// synonym for it.
const QUARANTINED_S5_SPECS = Object.freeze([
  `${VISUAL_REGRESSION}/c12-29-s5-dense-cost-gate.spec.mjs`,
  `${VISUAL_REGRESSION}/c12-29-s5-svs-footprint-gate.spec.mjs`,
]);

// C12 close-gate specs that are not S5 and were orphaned beside them. They are
// homed in the general Node family, which is also what `spec-runner-census`
// proposes for this directory.
const CO_HOMED_C12_SPECS = Object.freeze([
  `${VISUAL_REGRESSION}/c12-31-aureole-gate.spec.mjs`,
  `${VISUAL_REGRESSION}/celestial-gate-class-audit.spec.mjs`,
  `${VISUAL_REGRESSION}/eclipse-deckfree-night-law.spec.mjs`,
  `${VISUAL_REGRESSION}/eclipse-globe-shadow-visual.spec.mjs`,
  `${VISUAL_REGRESSION}/finding-ownership-audit.spec.mjs`,
  `${VISUAL_REGRESSION}/visual-evidence-library.spec.mjs`,
]);

const packageJsonText = fs.readFileSync(
  path.join(repositoryRoot, "package.json"),
  "utf8",
);
const scripts = JSON.parse(packageJsonText).scripts ?? {};

function s5SpecFilesOnDisk() {
  return fs
    .readdirSync(path.join(repositoryRoot, VISUAL_REGRESSION))
    .filter((name) => /^c12-29-s5-.+\.spec\.mjs$/u.test(name))
    .map((name) => `${VISUAL_REGRESSION}/${name}`)
    .sort();
}

function censusOver(files) {
  return runCensus({
    packageJson: packageJsonText,
    files,
    cwd: repositoryRoot,
  });
}

function specPathsNamedBy(script) {
  return (script ?? "")
    .split(/\s+/u)
    .filter((token) => token.endsWith(".spec.mjs"));
}

test("the ratified family runner and its quarantine sibling exist", () => {
  assert.equal(typeof scripts[FAMILY_RUNNER], "string");
  assert.match(scripts[FAMILY_RUNNER], /^node --test /u);
  assert.equal(typeof scripts[QUARANTINE_RUNNER], "string");
  assert.match(scripts[QUARANTINE_RUNNER], /^node --test /u);
  assert.equal(isQuarantineRunner(FAMILY_RUNNER), false);
  assert.equal(isQuarantineRunner(QUARANTINE_RUNNER), true);
});

test("every runner names a spec file that is on disk", () => {
  const named = [
    ...specPathsNamedBy(scripts[FAMILY_RUNNER]),
    ...specPathsNamedBy(scripts[QUARANTINE_RUNNER]),
  ];
  assert.ok(named.length > 0);
  const absent = named.filter(
    (file) => !fs.existsSync(path.join(repositoryRoot, file)),
  );
  assert.deepEqual(absent, []);
});

test("the S5 gate roster is ten specs and none of them is an orphan", () => {
  const files = s5SpecFilesOnDisk();
  assert.equal(
    files.length,
    10,
    "the C12-29 S5 gate-spec roster changed size — home the new spec and update this pin deliberately",
  );
  const census = censusOver(files);
  assert.deepEqual(
    census.specs.filter((spec) => spec.runners.length === 0).map((s) => s.file),
    [],
  );
  assert.equal(census.summary.orphaned, 0);
  assert.equal(census.summary.totalSpecs, 10);
});

test("each S5 spec is reachable from the family runner or its quarantine", () => {
  const census = censusOver(s5SpecFilesOnDisk());
  const outsideFamily = census.specs
    .filter(
      (spec) =>
        !spec.runners.includes(FAMILY_RUNNER) &&
        !spec.runners.includes(QUARANTINE_RUNNER),
    )
    .map((spec) => spec.file);
  assert.deepEqual(outsideFamily, []);
});

test("quarantine shelters exactly the two specs it is paid for", () => {
  const census = censusOver(s5SpecFilesOnDisk());
  const quarantined = census.specs
    .filter((spec) => spec.quarantined)
    .map((spec) => spec.file)
    .sort();
  assert.deepEqual(quarantined, [...QUARANTINED_S5_SPECS].sort());
});

test("the co-homed C12 close-gate specs are homed too", () => {
  const census = censusOver([...CO_HOMED_C12_SPECS]);
  assert.equal(census.summary.totalSpecs, CO_HOMED_C12_SPECS.length);
  assert.equal(census.summary.orphaned, 0);
  assert.equal(census.summary.quarantined, 0);
});
