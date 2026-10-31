// provision-worker-clone-flags.spec.mjs - export, flag and spine-flag contracts of Tools/provision-worker-clone.mjs after its decomposition into Tools/provision/.
// @purpose Pin that the entry file still exports everything it exported before the split, that the argv parser and the usage text name exactly the same flags, and that --no-spine-seed / --no-spine-refresh reach the spine seeding when the real CLI runs.
// @status ACTIVE
//
// Run: node --test Tools/provision-worker-clone-flags.spec.mjs
// Everything runs in lane-tmp sandboxes; no real clone or Codex config is touched.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withLaneTmp } from "./lib/lane-tmp.mjs";
import { PROVISION_FLAGS, parseProvisionArgs } from "./provision/args.mjs";

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(TOOLS_DIR, "provision-worker-clone.mjs");
const SPINE_DB_REL = ".cache/context-spine/cesium-context.sqlite";
const GIT_IDENTITY = [
  "-c",
  "user.name=spec",
  "-c",
  "user.email=spec@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

const exportsFixture = JSON.parse(
  fs.readFileSync(
    path.join(
      TOOLS_DIR,
      "provision",
      "fixtures",
      "provision-entry-exports.json",
    ),
    "utf8",
  ),
);

// --- exports ---------------------------------------------------------------

test("importing the entry file provisions nothing and keeps every export it had before the split", async () => {
  const entry = await import(pathToFileURL(ENTRY).href);
  const names = Object.keys(exportsFixture.exports);
  assert.ok(names.length >= 7, `fixture lists ${names.length} exports`);
  for (const name of names) {
    assert.equal(
      typeof entry[name],
      exportsFixture.exports[name],
      `${name} must still be exported from Tools/provision-worker-clone.mjs`,
    );
  }
});

test("the export fixture is what the base commit's entry file exported", (t) => {
  const shown = spawnSync(
    "git",
    [
      "-C",
      TOOLS_DIR,
      "show",
      `${exportsFixture.baseCommit}:Tools/provision-worker-clone.mjs`,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (shown.status !== 0) {
    t.skip(`base commit ${exportsFixture.baseCommit} is not reachable here`);
    return;
  }
  const atBase = [
    ...shown.stdout.matchAll(
      /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gmu,
    ),
  ].map((m) => m[1]);
  assert.deepEqual(
    atBase.sort(),
    Object.keys(exportsFixture.exports).sort(),
    "regenerate the fixture from the base commit, do not hand-edit it",
  );
});

// --- flags -----------------------------------------------------------------

const FLAG_PATTERN = /--[a-z][a-z-]*/gu;
const TABLE_FLAGS = PROVISION_FLAGS.map((f) => f.flag);

test("the usage the real CLI prints lists every flag the parser reads and no other", () => {
  const run = spawnSync(process.execPath, [ENTRY], { encoding: "utf8" });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.equal(run.stdout, "");
  const listed = new Set(run.stderr.match(FLAG_PATTERN));
  assert.deepEqual([...listed].sort(), [...TABLE_FLAGS].sort());
  // Each flag gets its own line saying what it does, not just a mention.
  for (const { flag, help } of PROVISION_FLAGS) {
    assert.ok(
      run.stderr.split("\n").some((l) => l.includes(flag) && l.includes(help)),
      `usage has no help line for ${flag}`,
    );
  }
});

test("each flag in the table changes what the parser returns", () => {
  const base = parseProvisionArgs(["clone"], "/cwd");
  const valueFor = {
    "--source": "/elsewhere",
    "--config": "/c.toml",
    "--capsule": "a.js",
    "--capsule-role": "reviewer",
  };
  for (const { flag, value } of PROVISION_FLAGS) {
    const argv = ["clone", flag, ...(value ? [valueFor[flag]] : [])];
    const parsed = parseProvisionArgs(argv, "/cwd");
    const { args: _baseArgs, ...baseRest } = base;
    const { args: parsedArgs, ...parsedRest } = parsed;
    assert.notDeepEqual(parsedRest, baseRest, `${flag} is read but unused`);
    assert.deepEqual(parsedArgs, argv);
  }
});

test("--no-spine-refresh and --no-spine-seed turn their option off and default to on", () => {
  assert.equal(parseProvisionArgs(["clone"]).refreshSpine, true);
  assert.equal(parseProvisionArgs(["clone"]).seedSpineDb, true);
  const off = parseProvisionArgs([
    "clone",
    "--no-spine-refresh",
    "--no-spine-seed",
  ]);
  assert.equal(off.refreshSpine, false);
  assert.equal(off.seedSpineDb, false);
  assert.equal(
    parseProvisionArgs(["clone", "--no-spine-refresh"]).seedSpineDb,
    true,
  );
  assert.equal(
    parseProvisionArgs(["clone", "--no-spine-seed"]).refreshSpine,
    true,
  );
});

test("a flag literal added to the provisioner without a table row is caught", () => {
  const files = [
    ENTRY,
    ...fs
      .readdirSync(path.join(TOOLS_DIR, "provision"))
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => path.join(TOOLS_DIR, "provision", f)),
  ];
  const literals = new Set();
  for (const file of files) {
    // Only literals read out of argv: the provisioner also passes git its own flags.
    for (const m of fs
      .readFileSync(file, "utf8")
      .matchAll(/(?:includes|indexOf)\(\s*["'`](--[a-z][a-z-]*)["'`]/gu)) {
      literals.add(m[1]);
    }
  }
  assert.deepEqual([...literals].sort(), [...TABLE_FLAGS].sort());
});

// --- the spine flags reach the seeding through the real CLI ----------------

function git(dir, ...args) {
  const run = spawnSync("git", ["-C", dir, ...GIT_IDENTITY, ...args], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
}

// A sandbox clone (with a commit, so its HEAD reads) and a source holding a
// placeholder spine DB: a placeholder has no head_sha, so a refresh is due, and
// the clone has no Tools/query-context.mjs, so a due refresh reports itself
// without running a build.
function runCli(dir, extraFlags) {
  const clone = path.join(dir, "clone");
  const source = path.join(dir, "source");
  fs.mkdirSync(clone, { recursive: true });
  git(clone, "init", "-q", "-b", "main");
  git(clone, "commit", "-q", "--allow-empty", "-m", "base");
  fs.mkdirSync(path.join(source, path.dirname(SPINE_DB_REL)), {
    recursive: true,
  });
  fs.writeFileSync(path.join(source, SPINE_DB_REL), "placeholder");
  const run = spawnSync(
    process.execPath,
    [ENTRY, clone, "--source", source, "--json", ...extraFlags],
    { encoding: "utf8" },
  );
  const report = JSON.parse(run.stdout);
  return {
    notes: report.notes,
    seeded: fs.existsSync(path.join(clone, SPINE_DB_REL)),
  };
}

const SEEDED = /seeded \.cache\/context-spine\/cesium-context\.sqlite/u;
const REFRESH_DUE = /context-spine refresh skipped: the clone has no Tools/u;

test("by default the CLI seeds the DB and finds a refresh due", () =>
  withLaneTmp("provision-flags-default-", (dir) => {
    const { notes, seeded } = runCli(dir, []);
    assert.ok(seeded);
    assert.ok(
      notes.some((n) => SEEDED.test(n)),
      notes.join("\n"),
    );
    assert.ok(
      notes.some((n) => REFRESH_DUE.test(n)),
      notes.join("\n"),
    );
  }));

test("--no-spine-refresh seeds the DB and attempts no refresh", () =>
  withLaneTmp("provision-flags-norefresh-", (dir) => {
    const { notes, seeded } = runCli(dir, ["--no-spine-refresh"]);
    assert.ok(seeded);
    assert.ok(notes.some((n) => SEEDED.test(n)));
    assert.ok(!notes.some((n) => /refresh/u.test(n)), notes.join("\n"));
  }));

test("--no-spine-seed copies no DB, so there is nothing to refresh either", () =>
  withLaneTmp("provision-flags-noseed-", (dir) => {
    const { notes, seeded } = runCli(dir, ["--no-spine-seed"]);
    assert.ok(!seeded);
    assert.ok(!notes.some((n) => /context-spine/u.test(n)), notes.join("\n"));
  }));
