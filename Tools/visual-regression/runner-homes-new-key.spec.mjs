// runner-homes-new-key.spec.mjs — a lane can mint a new runner key with `SCRIPT NEW:` and the census sees every spec homed once.
// @purpose Pins lib/runner-homes.mjs's `SCRIPT NEW: <key>=<value>` line kind over a synthetic package.json: the new key is added, a `SCRIPT:` replacement can shorten the old key it takes specs from, a home line can target the new key, and the census then reads every spec homed exactly once; a NEW line on an existing key, a SCRIPT line on an unknown key, parentheses, an empty value and a malformed line are refused; mutants make the NEW application, the existing-key refusal, the application order and the parser inert and each must turn its case red.
// @status ACTIVE
//
// The runner script `test-visual-regression-node` reached 7,949 of the 8,191
// characters a Windows command line allows. Moving a cohesive group of specs to
// a second key needs the lane to declare the key (package.json is seat-owned)
// and needs the homes census to read the result before the seat lands it. A
// `SCRIPT:` line refuses an unknown key on purpose (a typo must not mint a
// script), so minting is its own line kind. Everything here runs over data: no
// real package.json, no real spec tree.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCensus } from "../spec-runner-census.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { withLaneTmp } from "../lib/lane-tmp.mjs";
import {
  applyScriptLines,
  loadRunnerScripts,
  parseRunnerHomes,
  parseRunnerLines,
} from "./lib/runner-homes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const RUNNER_HOMES = path.join(here, "lib", "runner-homes.mjs");
const LANE = "runner-homes-new-key-spec";

const SPEC_A = "Tools/visual-regression/a.spec.mjs";
const SPEC_B = "Tools/visual-regression/b.spec.mjs";
const SPEC_C = "Tools/visual-regression/c.spec.mjs";
const SPEC_D = "Tools/visual-regression/d.spec.mjs";
const FILES = [SPEC_A, SPEC_B, SPEC_C, SPEC_D];

// `test-a` runs a, b and c today; d has no home yet.
const PACKAGE_SCRIPTS = {
  "test-a": `node --test ${SPEC_A} ${SPEC_B} ${SPEC_C}`,
};
const NEW_LINE = `SCRIPT NEW: test-a-c=node --test ${SPEC_C}`;
const SHORTEN_LINE = `SCRIPT: test-a=node --test ${SPEC_A} ${SPEC_B}`;

// c moves to the new key; the old key shrinks.
const MOVE_RUNNERS = [
  "# a lane's RUNNERS file",
  NEW_LINE,
  SHORTEN_LINE,
  "",
  "RUN: npm run test-a",
].join("\n");
// d is homed on the key the same file mints.
const HOME_RUNNERS = [MOVE_RUNNERS, `test-a-c=${SPEC_D}`].join("\n");

/** Scripts and lines as `load` resolves them over a synthetic root holding `runnersText`. */
function overlay(runnersText, load = loadRunnerScripts) {
  return withLaneTmp(
    "new-key-",
    (root) => {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: PACKAGE_SCRIPTS }),
      );
      fs.writeFileSync(path.join(root, "RUNNERS_X.txt"), runnersText);
      return load({ root, overlayFile: "RUNNERS_X.txt" });
    },
    { laneName: LANE },
  );
}

/** Each synthetic spec with the runner keys the census reads naming it. */
function censusRunners(scripts) {
  return Object.fromEntries(
    runCensus({ packageJson: { scripts }, files: FILES, cwd: ROOT }).specs.map(
      (spec) => [spec.file, spec.runners],
    ),
  );
}

/** The refusals the NEW kind promises, as one check a mutant can be held to. */
function assertRefusals(mod) {
  assert.throws(
    () =>
      mod.applyScriptLines(PACKAGE_SCRIPTS, [
        { script: "test-a", value: "node x", isNew: true },
      ]),
    /SCRIPT NEW line names script "test-a", which already exists/,
  );
  assert.throws(
    () =>
      mod.applyScriptLines(PACKAGE_SCRIPTS, [
        { script: "test-typo", value: "node x" },
      ]),
    /SCRIPT line names script "test-typo", which package.json does not declare/,
  );
  assert.throws(
    () => mod.parseRunnerLines("SCRIPT NEW: test-x=node x (see the plan)"),
    /SCRIPT NEW value carries parentheses.*SCRIPT NEW: test-x=node x \(see the plan\)/,
  );
  assert.throws(
    () => mod.parseRunnerLines("SCRIPT NEW: =node x"),
    /malformed SCRIPT NEW line: SCRIPT NEW: =node x/,
  );
  assert.throws(
    () => mod.parseRunnerLines("SCRIPT NEW: test-x"),
    /malformed SCRIPT NEW line/,
  );
  assert.throws(
    () => mod.parseRunnerLines("SCRIPT NEW: test-x="),
    /empty SCRIPT NEW value/,
  );
  assert.throws(
    () => mod.parseRunnerLines("  SCRIPT NEW: test-x=node x"),
    /unreadable home line/,
  );
  assert.throws(
    () => mod.parseRunnerLines("SCRIPT NEW test-x=node x"),
    /unreadable home line/,
  );
}

/** The behaviours the NEW kind promises over the move and home overlays, as one check. */
function assertMoveBehaviour(mod) {
  const { scripts } = overlay(MOVE_RUNNERS, mod.loadRunnerScripts);
  assert.deepEqual(censusRunners(scripts), {
    [SPEC_A]: ["test-a"],
    [SPEC_B]: ["test-a"],
    [SPEC_C]: ["test-a-c"],
    [SPEC_D]: [],
  });
}

function assertHomeOnNewKey(mod) {
  const { scripts } = overlay(HOME_RUNNERS, mod.loadRunnerScripts);
  assert.equal(scripts["test-a-c"], `node --test ${SPEC_C} ${SPEC_D}`);
  assert.deepEqual(censusRunners(scripts), {
    [SPEC_A]: ["test-a"],
    [SPEC_B]: ["test-a"],
    [SPEC_C]: ["test-a-c"],
    [SPEC_D]: ["test-a-c"],
  });
}

/** A SCRIPT replacement of a key a NEW line of the same text added. */
function replaceNewKey(mod) {
  const text = [NEW_LINE, `SCRIPT: test-a-c=node --test ${SPEC_C} ${SPEC_D}`];
  const { scriptLines } = parseRunnerLines(text.join("\n"));
  return mod.applyScriptLines(PACKAGE_SCRIPTS, scriptLines)["test-a-c"];
}

const REAL = {
  applyScriptLines,
  loadRunnerScripts,
  parseRunnerLines,
};

test("a RUNNERS text parses a NEW line apart from a replacement, and a home never reads either", () => {
  const parsed = parseRunnerLines(HOME_RUNNERS);
  assert.deepEqual(parsed.scriptLines, [
    { script: "test-a-c", value: `node --test ${SPEC_C}`, isNew: true },
    { script: "test-a", value: `node --test ${SPEC_A} ${SPEC_B}` },
  ]);
  assert.deepEqual(parsed.homes, [{ script: "test-a-c", spec: SPEC_D }]);
  assert.deepEqual(parseRunnerHomes(HOME_RUNNERS), parsed.homes);
});

test("a spec moved to a new key is homed once, on the new key, and not on the old one", () => {
  assertMoveBehaviour(REAL);
  const { scripts, scriptLines, homes } = overlay(MOVE_RUNNERS);
  assert.deepEqual(Object.keys(scripts), ["test-a", "test-a-c"]);
  assert.equal(scriptLines.length, 2);
  assert.equal(homes.length, 0);
});

test("a home line may target the key the same file mints, and the census reads every spec homed exactly once", () => {
  assertHomeOnNewKey(REAL);
  const runners = censusRunners(overlay(HOME_RUNNERS).scripts);
  for (const spec of FILES) {
    assert.equal(runners[spec].length, 1, `${spec} must be homed exactly once`);
  }
});

test("a replacement may target a key a NEW line of the same file added, whichever line comes first", () => {
  assert.equal(replaceNewKey(REAL), `node --test ${SPEC_C} ${SPEC_D}`);
  const replaceFirst = [
    `SCRIPT: test-a-c=node --test ${SPEC_C} ${SPEC_D}`,
    NEW_LINE,
    SHORTEN_LINE,
  ].join("\n");
  assert.equal(
    overlay(replaceFirst).scripts["test-a-c"],
    `node --test ${SPEC_C} ${SPEC_D}`,
  );
});

test("the refusals: NEW on an existing key, SCRIPT on an unknown key, parentheses, an empty value and a malformed line", () => {
  assertRefusals(REAL);
  // The same refusals reach the overlay a lane's file goes through.
  assert.throws(
    () => overlay(`SCRIPT NEW: test-a=node --test ${SPEC_A}`),
    /already exists/,
  );
  assert.throws(
    () => overlay(`SCRIPT: test-typo=node --test ${SPEC_A}`),
    /needs a SCRIPT NEW: line/,
  );
  // A home line on a key nobody declared or minted is still a typo.
  assert.throws(
    () => overlay(`test-nope=${SPEC_D}`),
    /names script "test-nope", which package.json does not declare/,
  );
});

test("INERTNESS MUTANT — with the NEW application made inert, the moved spec is homeless", async () => {
  const mutant = await importMutated(RUNNER_HOMES, [
    [
      "for (const { script, value } of scriptLines.filter((line) => line.isNew)) {",
      "for (const { script, value } of scriptLines.filter((line) => false && line.isNew)) {",
    ],
  ]);
  const { scripts } = overlay(MOVE_RUNNERS, mutant.loadRunnerScripts);
  assert.deepEqual(censusRunners(scripts)[SPEC_C], []);
  assert.throws(() => assertMoveBehaviour(mutant), /Expected values/);
});

test("INERTNESS MUTANT — with the existing-key refusal unreachable, a NEW line silently replaces a script", async () => {
  const mutant = await importMutated(RUNNER_HOMES, [
    [
      "if (Object.hasOwn(result, script)) {",
      "if (false && Object.hasOwn(result, script)) {",
    ],
  ]);
  assert.throws(() => assertRefusals(mutant), /Missing expected exception/);
});

test("INERTNESS MUTANT — with the home appends applied before the NEW key, a home on the new key is refused", async () => {
  const mutant = await importMutated(RUNNER_HOMES, [
    [
      "applyRunnerHomes(applyScriptLines(scripts, scriptLines), homes)",
      "applyScriptLines(applyRunnerHomes(scripts, homes), scriptLines)",
    ],
  ]);
  assert.throws(
    () => assertHomeOnNewKey(mutant),
    /names script "test-a-c", which package.json does not declare/,
  );
});

test("INERTNESS MUTANT — with a replacement checked against the original scripts only, it cannot target a NEW key", async () => {
  const mutant = await importMutated(RUNNER_HOMES, [
    [
      "if (!Object.hasOwn(result, script)) {",
      "if (!Object.hasOwn(scripts, script)) {",
    ],
  ]);
  assert.throws(
    () => replaceNewKey(mutant),
    /SCRIPT line names script "test-a-c", which package.json does not declare/,
  );
});

test("INERTNESS MUTANT — with the NEW branch unreachable in the parser, a NEW line is unreadable", async () => {
  const mutant = await importMutated(RUNNER_HOMES, [
    [
      'if (raw.startsWith("SCRIPT NEW:")) {',
      'if (false && raw.startsWith("SCRIPT NEW:")) {',
    ],
  ]);
  assert.throws(() => assertMoveBehaviour(mutant), /unreadable home line/);
});

test("INERTNESS MUTANT — with the parenthesis refusal unreachable, prose is accepted as a NEW value", async () => {
  const mutant = await importMutated(RUNNER_HOMES, [
    ["if (/[()]/.test(value)) {", "if (false && /[()]/.test(value)) {"],
  ]);
  assert.throws(() => assertRefusals(mutant), /Missing expected exception/);
});

test("INERTNESS MUTANT — with the empty-value refusal unreachable, a NEW line without a command is accepted", async () => {
  const mutant = await importMutated(RUNNER_HOMES, [
    ['if (value === "") {', 'if (false && value === "") {'],
  ]);
  assert.throws(() => assertRefusals(mutant), /Missing expected exception/);
});
