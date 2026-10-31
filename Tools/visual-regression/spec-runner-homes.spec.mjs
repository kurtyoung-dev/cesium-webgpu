// spec-runner-homes.spec.mjs — every spec under Tools/ has a runner home or a named reason.
// @purpose Pins that every *.spec.mjs under Tools/ is run by some package.json runner script (by the census's reading of node --test commands) or is listed in the shrink-only homeless allowlist with a one-line reason, that the allowlist holds no homed or deleted spec, and that a lane's pending homes and SCRIPT replacements (RUNNER_HOMES_FILE) apply exactly as the seat makes them; mutants make the overlay inert and must turn the homing check red.
// @status ACTIVE
//
// A red nobody can see was the recurring defect of 2026-10: ocean-tide-datum
// and globe-ocean-wave-clock went red for a day under lane patches because no
// runner ran them. The census (`Tools/spec-runner-census.mjs`) already reads
// which spec each runner names; this spec turns its orphan list into a gate.
//
// package.json is seat-owned, so a lane that homes specs declares the homes in
// its RUNNERS_<LANE>.txt and the seat appends the tokens at landing. Until then
// this spec is red on the lane's tree for exactly those specs. To prove it
// green before landing, point RUNNER_HOMES_FILE at the lane's file:
//   RUNNER_HOMES_FILE=_lane-out/RUNNERS_<LANE>.txt node --test Tools/visual-regression/spec-runner-homes.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runCensus } from "../spec-runner-census.mjs";
import { HOMELESS_SPEC_ALLOWLIST } from "./lib/homeless-spec-allowlist.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  mkLaneTmp,
  removeLaneTmp,
  sweepLaneTmp,
  withLaneTmp,
} from "../lib/lane-tmp.mjs";
import {
  applyRunnerHomes,
  applyScriptLines,
  loadRunnerScripts,
  parseRunnerHomes,
  parseRunnerLines,
} from "./lib/runner-homes.mjs";
import { listToolSpecs } from "./lib/shader-reader-scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const RUNNER_HOMES = path.join(here, "lib", "runner-homes.mjs");
const SCAN = path.join(here, "lib", "shader-reader-scan.mjs");

/** Tools specs no runner script names, under `scripts`. */
function homelessToolSpecs(scripts, files) {
  return runCensus({ packageJson: { scripts }, files, cwd: ROOT })
    .specs.filter((spec) => spec.runners.length === 0)
    .map((spec) => spec.file)
    .filter((file) => file.startsWith("Tools/"));
}

function unexplained(homeless, allowlist) {
  return homeless.filter((file) => !Object.hasOwn(allowlist, file));
}

test("every Tools spec has a runner home or a homeless-allowlist row", (t) => {
  const files = listToolSpecs(ROOT);
  assert.ok(
    files.length > 300,
    `expected the Tools spec census, got ${files.length}`,
  );
  const { scripts, homes } = loadRunnerScripts({ root: ROOT });
  if (homes.length > 0) {
    // Recorded so a green run says it was green UNDER a lane's pending homes.
    t.diagnostic(`RUNNER_HOMES_FILE applied ${homes.length} pending homes`);
  }
  const missing = unexplained(
    homelessToolSpecs(scripts, files),
    HOMELESS_SPEC_ALLOWLIST,
  );
  assert.deepEqual(
    missing,
    [],
    `home these specs in a package.json runner (a lane declares them in RUNNERS_<LANE>.txt) or allowlist them with a reason:\n  ${missing.join("\n  ")}`,
  );
});

test("the homeless allowlist is a ratchet: no row names a homed or deleted spec", () => {
  const files = listToolSpecs(ROOT);
  const { scripts } = loadRunnerScripts({ root: ROOT });
  const homeless = new Set(homelessToolSpecs(scripts, files));
  for (const [file, reason] of Object.entries(HOMELESS_SPEC_ALLOWLIST)) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} no longer exists`);
    assert.ok(
      homeless.has(file),
      `${file} now has a runner home: delete its allowlist row`,
    );
    assert.equal(typeof reason, "string");
    assert.ok(reason.trim().length > 0 && !reason.includes("\n"), file);
  }
});

// A synthetic package: one spec homed directly, one homed only by a pending
// lane home, one homed by nothing.
const SYNTHETIC_SCRIPTS = {
  "test-a": "node --test Tools/visual-regression/a.spec.mjs",
  "test-b": "node --test Tools/visual-regression/c.spec.mjs",
};
const SYNTHETIC_FILES = [
  "Tools/visual-regression/a.spec.mjs",
  "Tools/visual-regression/b.spec.mjs",
  "Tools/visual-regression/c.spec.mjs",
  "Tools/visual-regression/d.spec.mjs",
];
const SYNTHETIC_RUNNERS = [
  "# a lane's RUNNERS file",
  "test-a=Tools/visual-regression/b.spec.mjs",
  "",
  "RUN: npm run test-a",
].join("\n");

test("pending lane homes apply exactly as the seat appends them", () => {
  const homes = parseRunnerHomes(SYNTHETIC_RUNNERS);
  assert.deepEqual(homes, [
    { script: "test-a", spec: "Tools/visual-regression/b.spec.mjs" },
  ]);
  assert.deepEqual(homelessToolSpecs(SYNTHETIC_SCRIPTS, SYNTHETIC_FILES), [
    "Tools/visual-regression/b.spec.mjs",
    "Tools/visual-regression/d.spec.mjs",
  ]);
  const applied = applyRunnerHomes(SYNTHETIC_SCRIPTS, homes);
  assert.equal(
    applied["test-a"],
    "node --test Tools/visual-regression/a.spec.mjs Tools/visual-regression/b.spec.mjs",
  );
  assert.deepEqual(homelessToolSpecs(applied, SYNTHETIC_FILES), [
    "Tools/visual-regression/d.spec.mjs",
  ]);
  assert.throws(
    () =>
      applyRunnerHomes(SYNTHETIC_SCRIPTS, [{ script: "test-new", spec: "x" }]),
    /does not declare/,
  );
  assert.throws(() => parseRunnerHomes("not a home line"), /unreadable/);
});

test("INERTNESS MUTANT — with the append made inert, the pending home no longer homes its spec", async () => {
  const mutant = await importMutated(RUNNER_HOMES, [
    [
      "    result[script] = `${result[script]} ${spec}`;",
      "    if (false) result[script] = `${result[script]} ${spec}`;",
    ],
  ]);
  const applied = mutant.applyRunnerHomes(
    SYNTHETIC_SCRIPTS,
    mutant.parseRunnerHomes(SYNTHETIC_RUNNERS),
  );
  assert.ok(
    homelessToolSpecs(applied, SYNTHETIC_FILES).includes(
      "Tools/visual-regression/b.spec.mjs",
    ),
    "the homing check survived an inert overlay",
  );
});

test("INERTNESS MUTANT — an allowlist row that covers a homeless spec is load-bearing", () => {
  const homeless = ["Tools/visual-regression/d.spec.mjs"];
  const allowlist = { "Tools/visual-regression/d.spec.mjs": "red at HEAD" };
  assert.deepEqual(unexplained(homeless, allowlist), []);
  assert.deepEqual(unexplained(homeless, {}), homeless);
});

// The census reads TRACKED specs only. On 2026-10-30 the landing gate failed
// on ten specs in the maintainer's untracked prototype folder, which exists
// only in the seat worktree; an untracked or ignored file must never fail a gate.
const SCRATCH_LANE = "spec-runner-homes-spec";
test.after(() => sweepLaneTmp(SCRATCH_LANE));

function listInScratchRepo(list) {
  const repo = mkLaneTmp("homes-census-", {
    laneName: SCRATCH_LANE,
  });
  // A clean environment, so an outer GIT_DIR / GIT_INDEX_FILE cannot leak in.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  try {
    const git = (...args) =>
      execFileSync("git", args, { cwd: repo, env, windowsHide: true });
    git("init", "-q");
    fs.mkdirSync(path.join(repo, "Tools"), { recursive: true });
    fs.writeFileSync(path.join(repo, "Tools", "tracked.spec.mjs"), "");
    fs.writeFileSync(path.join(repo, "Tools", "untracked.spec.mjs"), "");
    git("add", "Tools/tracked.spec.mjs");
    return list(repo, { env });
  } finally {
    removeLaneTmp(repo);
  }
}

test("the census lists tracked specs only; an untracked spec is ignored", () => {
  assert.deepEqual(listInScratchRepo(listToolSpecs), [
    "Tools/tracked.spec.mjs",
  ]);
});

test("INERTNESS MUTANT — listing untracked files too puts the untracked spec in the census", async () => {
  const mutant = await importMutated(SCAN, [
    ['["ls-files", "--cached",', '["ls-files", "--cached", "--others",'],
  ]);
  assert.ok(
    listInScratchRepo(mutant.listToolSpecs).includes(
      "Tools/untracked.spec.mjs",
    ),
    "the tracked-only check survived a census that lists untracked files",
  );
});

// A lane that changes a package.json script (not only appends a spec) declares
// it as `SCRIPT: <key>=<value>`; before this the parser refused the line and
// the seat stripped it by hand.
const SCRIPT_RUNNERS = [
  "# a lane's RUNNERS file",
  "test-a=Tools/visual-regression/b.spec.mjs",
  "SCRIPT: test-a=node --test Tools/visual-regression/a.spec.mjs Tools/visual-regression/a2.spec.mjs",
  "",
  "RUN: npm run test-a",
].join("\n");

test("a RUNNERS text parses into homes and SCRIPT replacements, and ignores comments and RUN lines", () => {
  const parsed = parseRunnerLines(SCRIPT_RUNNERS);
  assert.deepEqual(parsed.homes, [
    { script: "test-a", spec: "Tools/visual-regression/b.spec.mjs" },
  ]);
  assert.deepEqual(parsed.scriptLines, [
    {
      script: "test-a",
      value:
        "node --test Tools/visual-regression/a.spec.mjs Tools/visual-regression/a2.spec.mjs",
    },
  ]);
  // The homes-only view keeps its contract: a SCRIPT line is not a home.
  assert.deepEqual(parseRunnerHomes(SCRIPT_RUNNERS), parsed.homes);
  assert.deepEqual(parseRunnerLines("# only a comment\nRUN: x"), {
    homes: [],
    scriptLines: [],
  });
});

test("a SCRIPT line replaces the script verbatim and refuses an unknown key", () => {
  const { scriptLines } = parseRunnerLines(SCRIPT_RUNNERS);
  assert.deepEqual(applyScriptLines(SYNTHETIC_SCRIPTS, scriptLines), {
    "test-a":
      "node --test Tools/visual-regression/a.spec.mjs Tools/visual-regression/a2.spec.mjs",
    "test-b": SYNTHETIC_SCRIPTS["test-b"],
  });
  assert.throws(
    () =>
      applyScriptLines(SYNTHETIC_SCRIPTS, [
        { script: "test-new", value: "node x" },
      ]),
    /does not declare/,
  );
  // An inherited property name is not a declared script.
  assert.throws(
    () =>
      applyScriptLines(SYNTHETIC_SCRIPTS, [
        { script: "constructor", value: "node x" },
      ]),
    /does not declare/,
  );
});

test("a SCRIPT value carrying parentheses, a SCRIPT line without a key, and an indented SCRIPT line are refused with the line", () => {
  assert.throws(
    () => parseRunnerLines("SCRIPT: test-a=node x (see the plan)"),
    /parentheses.*SCRIPT: test-a=node x \(see the plan\)/,
  );
  assert.throws(
    () => parseRunnerLines("SCRIPT: =node x"),
    /malformed SCRIPT line: SCRIPT: =node x/,
  );
  assert.throws(
    () => parseRunnerLines("SCRIPT: no-equals-sign"),
    /malformed SCRIPT line/,
  );
  assert.throws(
    () => parseRunnerLines("  SCRIPT: test-a=node x"),
    /unreadable home line/,
  );
});

/** Load a synthetic root (package.json + RUNNERS file) through the overlay, with `load` choosing the module. */
function overlayScripts(
  runnersText,
  { load = loadRunnerScripts, scripts = SYNTHETIC_SCRIPTS } = {},
) {
  return withLaneTmp(
    "homes-overlay-",
    (root) => {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ scripts }),
      );
      fs.writeFileSync(path.join(root, "RUNNERS_X.txt"), runnersText);
      return load({ root, overlayFile: "RUNNERS_X.txt" });
    },
    { laneName: SCRATCH_LANE },
  );
}

const OVERLAY_EXPECTED =
  "node --test Tools/visual-regression/a.spec.mjs Tools/visual-regression/a2.spec.mjs Tools/visual-regression/b.spec.mjs";

test("the overlay applies the SCRIPT replacement and then the home append, as the seat's landing does", () => {
  const { scripts, homes, scriptLines } = overlayScripts(SCRIPT_RUNNERS);
  assert.equal(scripts["test-a"], OVERLAY_EXPECTED);
  assert.equal(scripts["test-b"], SYNTHETIC_SCRIPTS["test-b"]);
  assert.equal(homes.length, 1);
  assert.equal(scriptLines.length, 1);
  // Without an overlay the scripts are package.json as it stands.
  const bare = withLaneTmp(
    "homes-bare-",
    (root) => {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: SYNTHETIC_SCRIPTS }),
      );
      return loadRunnerScripts({ root, overlayFile: "" });
    },
    { laneName: SCRATCH_LANE },
  );
  assert.deepEqual(bare, {
    scripts: SYNTHETIC_SCRIPTS,
    homes: [],
    scriptLines: [],
  });
  assert.throws(
    () => overlayScripts("SCRIPT: test-new=node x"),
    /does not declare/,
  );
});

/** The behaviours the SCRIPT kind promises, as one check a mutant can be held to. */
function assertScriptKindBehaviour(mod) {
  const parsed = mod.parseRunnerLines(SCRIPT_RUNNERS);
  assert.equal(parsed.scriptLines.length, 1);
  assert.throws(
    () =>
      mod.applyScriptLines(SYNTHETIC_SCRIPTS, [
        { script: "test-new", value: "node x" },
      ]),
    /does not declare/,
  );
  assert.throws(
    () => mod.parseRunnerLines("SCRIPT: test-a=node x (prose)"),
    /parentheses/,
  );
  assert.equal(
    overlayScripts(SCRIPT_RUNNERS, { load: mod.loadRunnerScripts }).scripts[
      "test-a"
    ],
    OVERLAY_EXPECTED,
  );
}

test("the SCRIPT-kind check passes on the real module", () => {
  assertScriptKindBehaviour({
    parseRunnerLines,
    applyScriptLines,
    loadRunnerScripts,
  });
});

test("INERTNESS MUTANT — with the SCRIPT branch unreachable, a SCRIPT line is unreadable again", async () => {
  const mutant = await importMutated(RUNNER_HOMES, [
    [
      'if (raw.startsWith("SCRIPT:")) {',
      'if (false && raw.startsWith("SCRIPT:")) {',
    ],
  ]);
  assert.throws(
    () => assertScriptKindBehaviour(mutant),
    /unreadable home line/,
  );
});

test("INERTNESS MUTANT — with the key-existence check unreachable, a SCRIPT line mints a new script", async () => {
  const mutant = await importMutated(RUNNER_HOMES, [
    [
      "if (!Object.hasOwn(result, script)) {",
      "if (false && !Object.hasOwn(result, script)) {",
    ],
  ]);
  assert.throws(() => assertScriptKindBehaviour(mutant), /Missing expected/);
});

test("INERTNESS MUTANT — with the parenthesis refusal unreachable, prose is accepted as a script value", async () => {
  const mutant = await importMutated(RUNNER_HOMES, [
    ["if (/[()]/.test(value)) {", "if (false && /[()]/.test(value)) {"],
  ]);
  assert.throws(() => assertScriptKindBehaviour(mutant), /Missing expected/);
});

test("INERTNESS MUTANT — with the replacement applied after the append, the overlay loses the home token", async () => {
  const mutant = await importMutated(RUNNER_HOMES, [
    [
      "applyRunnerHomes(applyScriptLines(scripts, scriptLines), homes)",
      "applyScriptLines(applyRunnerHomes(scripts, homes), scriptLines)",
    ],
  ]);
  assert.notEqual(
    overlayScripts(SCRIPT_RUNNERS, { load: mutant.loadRunnerScripts }).scripts[
      "test-a"
    ],
    OVERLAY_EXPECTED,
  );
});
